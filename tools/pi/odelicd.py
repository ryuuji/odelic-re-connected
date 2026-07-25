#!/usr/bin/env python3
"""odelicd — ODELIC CONNECTED LIGHTING を制御する常駐デーモン。

Raspberry Pi 上で常駐し、器具との GATT 接続を維持したまま HTTP API で操作を受ける。
純正アプリの起動 7 秒に対して、**接続済みなので操作から反応まで実質ゼロ遅延**。

プロトコルの根拠は docs/02-protocol.md の C6 / C15 / C16 / C17 / C19。

## 設計方針（docs/03-instability.md の P1〜P5 に対応）

- P1 状態を常時保持   : 接続を維持し、器具からのイベントを蓄積する
- P2 期待状態まで再送 : コマンドを複数回送る（絶対値指定なので冪等）
- P3 冪等             : 照明制御コマンドはすべて絶対値。再送しても壊れない
- P4 嘘をつかない     : 未接続なら 503 を返す。「成功」と言わない
- P5 待たせない       : 操作をキューに入れて即応答し、接続の瞬間に流す

## 使い方

    sudo python3 odelicd.py --id 12345678 --port 8080

    curl -X POST localhost:8080/on
    curl -X POST localhost:8080/off
    curl -X POST 'localhost:8080/level?bright=60&color=50'
    curl localhost:8080/status

⚠️ グループ設定・シーン登録・器具登録の初期化は**実装していない**。
   壊すと壁スイッチからのやり直しになるため、意図的に対応外にしている。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import struct
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import dbus
import dbus.mainloop.glib
import dbus.service
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from gi.repository import GLib

# ------------------------------------------------------------------ 定数

BLUEZ = "org.bluez"
ADAPTER_IFACE = "org.bluez.Adapter1"
GATT_MGR_IFACE = "org.bluez.GattManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
LE_ADV_MGR_IFACE = "org.bluez.LEAdvertisingManager1"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"

# C17-1: スマホ（= この Pi）が Peripheral のときの UUID
UUID_SERVICE = "0000ffd0-0000-1000-8000-00805f9b34fb"
UUID_WRITE = "0000ffd1-0000-1000-8000-00805f9b34fb"
UUID_NOTIFY = "0000ffd2-0000-1000-8000-00805f9b34fb"

# C3 / C17-3: アドバタイズ
PAIRLINK_COMPANY_ID = 0x0000
ADV_MAGIC = bytes([0xC0, 0xFF])
ADV_PHONE = 0x05

# C5: PDU タイプ
PDU_CMD = 0x01
PDU_RESPONSE = 0x02
PDU_DATA_EVENT = 0x03
PDU_ENCRYPTED = 0x06  # 器具からのデータ応答（C23 で復号できるようになった）
PDU_SEGMENT = 0x04  # 分割された PDU。`04 04 <seq> <断片>`（C30）
SEGMENT_SUB = 0x04
SEGMENT_MAX = 4096  # 再組立の上限。純正アプリは 255 固定で溢れる（C30-2）
SEGMENT_TIMEOUT = 3.0  # これ以上間隔が空いたら組み立てを捨てる（C30-2）

# C9: メッシュ制御コマンド
CMD_GET_PASSWORD = 0x00
CMD_WELCOME = 0x01
CMD_BROADCAST_MESHINFO = 0x02
CMD_GET_VIRTUAL_ADDR = 0x0A
CMD_SET_LINK = 0x10
CMD_PERIPHERAL_LOGIN = 0x19

# C8: データチャネル
CH_TOLIGHT = 0x20
CH_TOLIGHT_2A = 0x2A
CH_PING = 0xFE  # API_ping_all が使うチャネル
CH_PING_RESPONSE = 0xFF  # DATA_CHANNEL_PING_RESPONSE

# C7: 照明制御 MSGID
MSGID_BRIGHT_LIGHT = 0xC0
MSGID_BRIGHT_LIGHT_GROUP = 0xC1
MSGID_BRIGHT_LIGHT_NIGHT_GROUP = 0xC5  # ナイトライト（グループ単位）
MSGID_SM_STATUS = 0x70
MSGID_STATUS_MAIN = 0x71
MSGID_STATUS_FD = 0x35

# 器具の探索（MeshService.get_product_id / get_group_id）
MSGID_ID_CENTRAL = 0x02  # 送信 → 器具が 0x80 で応答
MSGID_ID_PERIPHERAL = 0x80  # 応答: MAC + 製品コード
MSGID_GET_GROUP = 0xD0  # 送信（+ パラメータ 0x01）→ 器具が 0xD7 で応答
MSGID_GROUP_RESPONSE = 0xD7  # 応答: グループ ID

# C12: 製品コード（MeshService の PRODUCT_CODE_* 全件）
PRODUCT_CODES = {
    0x01: "LED_LINE",
    0x02: "LED_SQUIRE",
    0x03: "LED_TUBE",
    0x04: "LED_CEILING_MAT_6",
    0x05: "LED_CEILING_MAT_8",
    0x06: "LED_CEILING_MAT_10",
    0x07: "LED_CEILING_MAT_12",
    0x08: "LED_CEILING_MAT_14",
    0x09: "LED_CEILING_MAT_8_450",
    0x0A: "LED_CEILING_MAT_12_450",
    0x0B: "LC611",
    0x0C: "LC612",
    0x0D: "LC613",
    0x0E: "LC614",
    0x0F: "LC615",
    0x10: "CCT",
    0x11: "RGB",
    0x12: "INDIRECT_600",
    0x13: "INDIRECT_1200",
    0x14: "DOWNLIGHT_60",
    0x15: "DOWNLIGHT_100",
    0x1A: "LED_450",
    0x1B: "BRIGHT_SENSOR",
    0x1C: "HUMAN_SENSOR",
    0x1D: "INTERFACE",
    0x27: "RGB_INDIRECT_600",
    0x28: "RGB_INDIRECT_1200",
    0x2B: "CODE_2B",  # ⭐ 手元の器具（PLTCEOC-05）がこれを返す
    0x3F: "RGB_INDIRECT_900",
    0x49: "RGB_BLE_DRIVER",
    0x4A: "DONGLE",
    0x8E: "LC632",
}

# C15-7: ON / OFF は値域外の状態コード
CODE_ON = 0x37
CODE_OFF = 0x32

BROADCAST_VADDR = bytes([0xFF, 0xFF, 0xFF, 0xFF])

START = time.monotonic()
_log_lock = threading.Lock()


def log(msg: str) -> None:
    with _log_lock:
        print(f"[{time.monotonic() - START:9.3f}] {msg}", flush=True)


def hexs(b: bytes) -> str:
    return " ".join(f"{x:02X}" for x in b)


# --------------------------------------------- 値エンコード (C15-9 / C18-4)


def color_to_code(percent: int) -> int:
    """色温度 0〜100% → コード 0〜20。"""
    return min(max(percent // 5, 0), 20)


def bright_to_code(percent: int) -> int:
    """明るさ 0〜100% → コード 0〜19。★ 逆順。0% は特別値 19。"""
    if percent == 0:
        return 19
    return min(max((100 - percent) // 5, 0), 19)


def code_to_color(code: int) -> int:
    return code * 5


def code_to_bright(code: int) -> int:
    return 100 - code * 5


def parse_display_id(display_id: str) -> tuple[bytes, bytes]:
    """アプリ表示の 8 桁 ID を (HOMEID 4 バイト, パスワード 4 バイト) にする（C16-2）。"""
    if len(display_id) != 8 or not display_id.isdigit():
        raise ValueError(f"ID は 8 桁の数字で指定してください: {display_id!r}")
    return struct.pack("<I", int(display_id[:4])), display_id[4:].encode("ascii")


# ------------------------------------------------------------------- 暗号
# C21-2 / C22 / C23。libnative-lib.so の逆アセンブルから完全に再現できた。
#
#   鍵 = HOMEID とパスワードを 1 バイトずつ交互に並べ、後半 8 バイトに固定文字列
#     LOGINKEY … PERIPHERAL_LOGIN の復号とログイン応答の暗号化
#     EVENTKEY … 器具からのデータ応答（PDU タイプ 0x06）の復号
#
# AES は標準の AES-128-ECB（C22-2 で .so を直接呼んで確認済み）。


def make_mesh_keys(homeid: bytes, password: bytes) -> tuple[bytes, bytes]:
    """(LOGINKEY, EVENTKEY) を作る（C21-2）。"""
    inter = bytes(
        [
            homeid[0], password[0], homeid[1], password[1],
            homeid[2], password[2], homeid[3], password[3],
        ]
    )
    return inter + b"LOGINKEY", inter + b"EVENTKEY"


def aes_ecb_encrypt(key: bytes, pt: bytes) -> bytes:
    e = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return e.update(pt) + e.finalize()


def aes_ecb_decrypt(key: bytes, ct: bytes) -> bytes:
    d = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    return d.update(ct) + d.finalize()


def decrypt_mesh_pdu(raw: bytes, event_key: bytes, link_key: bytes) -> bytes | None:
    """器具からの暗号化 PDU（タイプ 0x06）を平文 PDU に戻す（C23-3）。

    `.so` の `encry_data_handle` をそのまま再現している。

      1. ヘッダ 6 バイトはそのまま。data[6..] を link_key で XOR（周期 4）
      2. AES_ECB_decrypt(EVENTKEY, data[6..])
      3. 復号結果の最終バイトがパディング長（0x10 以下でなければ不正）
      4. 平文 PDU = 0x03 + 元ヘッダ[1..5] + 復号本体

    復号できなければ None を返す。
    """
    if len(raw) < 6 + 16 or (len(raw) - 6) % 16 != 0:
        return None
    buf = bytearray(raw)
    for i in range(6, len(buf)):
        buf[i] ^= link_key[(i - 6) % 4]
    body = aes_ecb_decrypt(event_key, bytes(buf[6:]))
    padlen = body[-1]
    if padlen > 0x10:  # AES_ECB_decrypt が 0 を返す条件（＝復号失敗）
        return None
    return bytes([PDU_DATA_EVENT]) + raw[1:6] + body[: len(body) - padlen]


def encrypt_mesh_pdu(pdu: bytes, event_key: bytes, link_key: bytes) -> bytes:
    """平文 PDU を暗号化 PDU（タイプ 0x06）にする（C23-5）。

    `mesh_encrypt` + `sendEncry` の XOR をまとめて再現したもの。復号の逆順。

      1. 本体 = pdu[6..] に PKCS#7 パディング（16 の倍数。既に倍数なら 0x10 を 16 個）
      2. AES_ECB_encrypt(EVENTKEY, 本体)
      3. 結果を link_key（周期 4）で XOR
      4. 0x06 + 元ヘッダ[1..5] + それ

    純正アプリが送っていた暗号化 Ping をバイト単位で再現できることを確認済み。
    """
    body = pdu[6:]
    pad = 16 - (len(body) % 16)  # 0 にはならない（16 の倍数なら 16）
    body += bytes([pad]) * pad
    ct = aes_ecb_encrypt(event_key, body)
    whitened = bytes(ct[i] ^ link_key[i % 4] for i in range(len(ct)))
    return bytes([PDU_ENCRYPTED]) + pdu[1:6] + whitened


def make_login_response(login_key: bytes, homeid: bytes, password: bytes, dev4: bytes) -> bytes:
    """PERIPHERAL_LOGIN への応答 PDU を作る（C23-2）。

    `cmd_handle` が組み立てるものと同一。実機ログとバイト単位で一致することを確認済み。

        02 19 + AES_ECB_encrypt(LOGINKEY, HOMEID + パスワード + dev4 + 04 04 04 04)
    """
    block = homeid + password + dev4 + bytes([0x04] * 4)
    return bytes([PDU_RESPONSE, CMD_PERIPHERAL_LOGIN]) + aes_ecb_encrypt(login_key, block)


# ------------------------------------------------------------ PDU 組み立て


def make_group_light(src: bytes, color_code: int, bright_code: int, group: int) -> bytes:
    """グループ宛の色温度・明るさコマンド（C15-5 / C18-4）。

    実機は dst = FF FF FF FF でもチャネル 0x20 を使っていた。
    """
    params = bytes([color_code, bright_code]) + bytes(6) + bytes([group])
    return (
        bytes([PDU_DATA_EVENT])
        + BROADCAST_VADDR
        + bytes([CH_TOLIGHT])
        + src
        + bytes([MSGID_BRIGHT_LIGHT_GROUP])
        + params
    )


def make_light_all(src: bytes, color_code: int, bright_code: int) -> bytes:
    """全器具を一斉に操作する（C15-3 / C15-4 / C18-4）。

    実機ログの最後の 3 件がこの形。
      dst = FF FF FF FF / チャネル 0x2A / MSGID 0xC0 / params = [sub=0, 色, 明るさ, 0,0,0,0]

    ⚠️ グループ指定（0xC1）は**そのグループの器具にしか届かない**。
    器具が複数グループに分かれている場合、一斉操作にはこちらを使う。
    """
    params = bytes([0x00, color_code, bright_code]) + bytes(4)
    return (
        bytes([PDU_DATA_EVENT])
        + BROADCAST_VADDR
        + bytes([CH_TOLIGHT_2A])
        + src
        + bytes([MSGID_BRIGHT_LIGHT])
        + params
    )


def make_light_dev(
    dst: bytes, src: bytes, color_code: int, bright_code: int
) -> bytes:
    """器具 1 台を個別に操作する（C15-4 のサブコマンド 0）。"""
    params = bytes([0x00, color_code, bright_code]) + bytes(4)
    return (
        bytes([PDU_DATA_EVENT])
        + dst
        + bytes([CH_TOLIGHT])
        + src
        + bytes([MSGID_BRIGHT_LIGHT])
        + params
    )


def make_night_dev(dst: bytes, src: bytes, level: int) -> bytes:
    """ナイトライト（常夜灯）。器具個別または全器具一斉（C15-4 サブコマンド 1 / C24）。

    `ControllerAct.setlight_night(vAddr, level)` と同一。

        msgdata = own(4) + [0xC0, 1, 0, level, 0, 0, 0, 0]
        dst が FF FF FF FF ならチャネル 0x2A、それ以外は 0x20

    ⚠️ レベルは **0 / 1 / 2 の 3 段階**（0 が最も明るい）。純正アプリは
    ボタンを押すたびに 0 → 1 → 2 → 0 と巡回させている。
    """
    params = bytes([0x01, 0x00, level]) + bytes(4)
    channel = CH_TOLIGHT_2A if dst == BROADCAST_VADDR else CH_TOLIGHT
    return (
        bytes([PDU_DATA_EVENT])
        + dst
        + bytes([channel])
        + src
        + bytes([MSGID_BRIGHT_LIGHT])
        + params
    )


def make_night_group(src: bytes, level: int, group: int) -> bytes:
    """ナイトライトをグループ単位で（`sendgroup_night(group, level, 0xC5)`・C24）。

        msgdata = own(4) + [0xC5, 0, level, 0,0,0,0,0,0, group]
    """
    params = bytes([0x00, level]) + bytes(6) + bytes([group])
    return (
        bytes([PDU_DATA_EVENT])
        + BROADCAST_VADDR
        + bytes([CH_TOLIGHT])
        + src
        + bytes([MSGID_BRIGHT_LIGHT_NIGHT_GROUP])
        + params
    )


def make_status_request(src: bytes, dst: bytes = BROADCAST_VADDR) -> bytes:
    """状態要求（C15-6 / C23-8）。パラメータなし。

    ⭐ 実測: dst = FF FF FF FF・チャネル 0x20 なら **1 通で全器具が応答する**。
    チャネル 0x2A（一斉のチャネル）では無応答だったので 0x20 を使う。
    器具個別に聞きたいときは dst にその器具の vAddr を入れる。
    """
    return (
        bytes([PDU_DATA_EVENT])
        + dst
        + bytes([CH_TOLIGHT])
        + src
        + bytes([MSGID_SM_STATUS])
    )


def make_ping_all(src: bytes) -> bytes:
    """メッシュ内の全器具に Ping する（C13 / MeshService.API_ping_all）。

    [0]     0x03
    [1..4]  FF FF FF FF
    [5]     0xFE          ← 専用チャネル。0x20 ではない
    [6..9]  送信元 vAddr

    ⚠️ 実機では**応答が返ってこなかった**。純正アプリもこのチャネルを
    使っていない（`getJoinCheckType() != 0` のときだけ呼ばれる条件付き）。
    器具の探索には make_get_product_id / make_get_group_id を使う。
    """
    return bytes([PDU_DATA_EVENT]) + BROADCAST_VADDR + bytes([CH_PING]) + src


def make_get_product_id(src: bytes, dst: bytes = BROADCAST_VADDR) -> bytes:
    """器具に自己申告させる（MeshService.get_product_id）。

    応答は MSGID 0x80（ID_PERIPHERAL）で、MAC と製品コードが入る。
    これが器具一覧を得る正しい手段。
    """
    return (
        bytes([PDU_DATA_EVENT])
        + dst
        + bytes([CH_TOLIGHT])
        + src
        + bytes([MSGID_ID_CENTRAL])
    )


def make_get_group_id(src: bytes, dst: bytes = BROADCAST_VADDR) -> bytes:
    """器具のグループ ID を問い合わせる（MeshService.get_group_id）。

    応答は MSGID 0xD7（GROUP_RESPONSE）。
    実機ログの `D0 01`（参加直後に 1 回）がこれ。
    """
    return (
        bytes([PDU_DATA_EVENT])
        + dst
        + bytes([CH_TOLIGHT])
        + src
        + bytes([MSGID_GET_GROUP, 0x01])
    )


# ------------------------------------------------------------ アドバタイズ


class RawAdvertiser:
    """ADV_PHONE を raw HCI で送る。

    BlueZ の D-Bus 経路は Pi 3（BT 4.1）+ カーネル 6.x で使えない（C19-5）。
    """

    OGF_LE = "0x08"
    OCF_SET_RANDOM_ADDR = "0x0005"
    OCF_SET_ADV_PARAMS = "0x0006"
    OCF_SET_ADV_DATA = "0x0008"
    OCF_SET_ADV_ENABLE = "0x000a"

    def __init__(self, dev: str, homeid: bytes, addr: bytes, ctrl_id: bytes | None = None):
        self.dev = dev
        self.addr = addr  # HCI 順（リトルエンディアン）
        # ⭐ AD に入れる 6 バイトは「コントローラの識別子」で、
        #   広告アドレスとは別物（C31）。純正アプリは初回にランダム生成した
        #   疑似 MAC を SharedPreferences に永続化して使い続ける。
        #   ctrl_id が None のときだけ従来どおり広告アドレスを流用する
        self.ctrl_id = ctrl_id if ctrl_id is not None else bytes(reversed(addr))
        self.connectable = True
        payload = ADV_MAGIC + bytes([ADV_PHONE]) + homeid + self.ctrl_id
        body = struct.pack("<H", PAIRLINK_COMPANY_ID) + payload
        self.ad = bytes([0x02, 0x01, 0x06, len(body) + 1, 0xFF]) + body
        if len(self.ad) > 31:
            raise ValueError(f"AD が 31 バイトを超えます: {len(self.ad)}")

    @property
    def addr_str(self) -> str:
        return ":".join(f"{b:02X}" for b in reversed(self.addr))

    @property
    def ctrl_id_str(self) -> str:
        return ":".join(f"{b:02X}" for b in self.ctrl_id)

    def _hci(self, ocf: str, params: bytes, quiet: bool = False) -> bool:
        cmd = ["hcitool", "-i", self.dev, "cmd", self.OGF_LE, ocf] + [
            f"{b:02x}" for b in params
        ]
        try:
            # ⚠️ stdin を閉じないと systemd 配下（tty なし）で
            #    btmgmt / hcitool が入力待ちでブロックする
            r = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=5,
            )
        except subprocess.TimeoutExpired:
            log(f"[!] hcitool がタイムアウト ({ocf})")
            return False
        if r.returncode != 0:
            if not quiet:
                log(f"[!] hcitool 失敗 ({ocf}): {r.stderr.strip() or r.stdout.strip()}")
            return False
        return True

    def set_enabled(self, on: bool, quiet: bool = True) -> bool:
        """広告の ON / OFF を打つ。

        ⚠️ ADV_IND は接続確立で自動停止するが、**BlueZ は勝手に再開する**。
        既にその状態なら hcitool は EBUSY で失敗するが無害なので黙る。
        """
        return self._hci(
            self.OCF_SET_ADV_ENABLE, bytes([0x01 if on else 0x00]), quiet
        )

    def _adv_params(self, connectable: bool) -> bytes:
        return (
            struct.pack("<HH", 0x00A0, 0x00A0)  # interval 100 ms
            # ADV_IND(0x00) = 接続可 / ADV_NONCONN_IND(0x03) = 接続不可
            + bytes([0x00 if connectable else 0x03, 0x01, 0x00])
            + bytes(6)
            + bytes([0x07, 0x00])
        )

    def set_connectable(self, on: bool) -> bool:
        """⭐ 広告を「接続可 / 接続不可」に切り替える。

        参加後に器具の追加接続を止めたいが、**広告を消す戦いには勝てない**。
        実測（C33）: `LE Set Advertising Enable = 0` を打っても
        BlueZ が **150〜240 ms 後に必ず再開する**（2 秒ごとに止めても毎回戻された）。

        そこで発想を変えて、広告は出したまま **ADV_NONCONN_IND** にする。
        接続不可の広告なら器具は繋いでこられないので、
        BlueZ が Enable を打ち直しても害がない。
        """
        self.connectable = on
        self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x00]), quiet=True)
        ok = self._hci(self.OCF_SET_ADV_PARAMS, self._adv_params(on))
        self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x01]), quiet=True)
        return ok

    def start(self) -> bool:
        try:
            # mgmt 側の広告インスタンスは Pi 3 では使えない（SupportedInstances = 0）。
            # 念のため落としておくが、応答がないことがあるので短く打ち切る
            subprocess.run(
                ["btmgmt", "advertising", "off"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                timeout=2,
            )
        except subprocess.TimeoutExpired:
            log("[!] btmgmt advertising off がタイムアウト（続行します）")
        self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x00]))
        if not self._hci(self.OCF_SET_RANDOM_ADDR, self.addr):
            return False
        if not self._hci(self.OCF_SET_ADV_PARAMS, self._adv_params(self.connectable)):
            return False
        data = bytes([len(self.ad)]) + self.ad + bytes(31 - len(self.ad))
        if not self._hci(self.OCF_SET_ADV_DATA, data):
            return False
        if not self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x01])):
            return False
        log(f"アドバタイズ開始 {self.addr_str}  AD={hexs(self.ad)}")
        return True

    def keepalive(self) -> None:
        """ADV_IND は接続確立で自動停止するので定期的に再開する。"""
        self.set_enabled(True)

    def stop(self) -> None:
        self.set_enabled(False, quiet=False)


def mac_from_path(path: str) -> str | None:
    """D-Bus のデバイスパスから MAC を取り出す。

    `/org/bluez/hci0/dev_EC_C5_7F_81_DE_CD` → `EC:C5:7F:81:DE:CD`
    """
    marker = "/dev_"
    if marker not in path:
        return None
    mac = path.rsplit(marker, 1)[1].replace("_", ":").upper()
    return mac if len(mac) == 17 else None


def new_random_static_addr() -> bytes:
    """ランダム静的アドレス（上位 2 bit = 11）を作る。HCI 順（LE）で返す。"""
    rnd = bytearray(os.urandom(6))
    rnd[5] = rnd[5] | 0xC0
    return bytes(rnd)


def new_ctrl_id() -> bytes:
    """コントローラ識別子（AD に入れる 6 バイト）を作る（C31）。

    純正アプリは `BleUtil.getBTMac()` でランダムな MAC 形式文字列を作って
    永続化している。BLE のアドレスとは無関係の、ただの識別子。
    """
    return os.urandom(6)


def save_addr(path: str, addr: bytes) -> None:
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "wb") as f:
            f.write(addr)
    except OSError as e:
        log(f"[!] アドレスを保存できません（{e}）")


def load_or_create_addr(path: str) -> bytes:
    """広告に使うランダム静的アドレスを永続化する。

    ⭐ 当初は「器具がアドレスを記憶していて再接続してこない」と考えていたが、
    再検証したところ**それは誤り**だった（C31）。同じアドレスでも、
    古い ACL リンクを切ってから広告すれば約 5 秒で接続してくる。
    それでもアドレスを使い回すのは、器具側に何らかの記録が残る可能性への配慮。
    """
    if os.path.exists(path):
        with open(path, "rb") as f:
            addr = f.read(6)
        if len(addr) == 6:
            return addr
    addr = new_random_static_addr()
    save_addr(path, addr)
    log(f"新しいアドレスを生成して保存しました: {path}")
    return addr


def load_or_create_ctrl_id(path: str) -> bytes:
    """コントローラ識別子を永続化する（純正アプリと同じ方針・C31）。"""
    if os.path.exists(path):
        with open(path, "rb") as f:
            cid = f.read(6)
        if len(cid) == 6:
            return cid
    cid = new_ctrl_id()
    save_addr(path, cid)
    log(f"新しいコントローラ識別子を生成して保存しました: {path}")
    return cid


# ------------------------------------------------------------------ 状態


class Device:
    """Ping で発見した器具 1 台（C13 / MeshCommon.GetPingResponse）。"""

    def __init__(self, mac: bytes, vaddr: bytes, version: str):
        self.mac = mac
        self.vaddr = vaddr
        self.version = version
        self.product_code: int | None = None
        self.group_id: int | None = None
        self.first_seen = time.time()
        self.last_seen = time.time()
        # 器具ごとの状態（C15-9 の状態応答から更新）
        self.on: bool | None = None
        self.bright: int | None = None
        self.color: int | None = None
        self.state_updated_at: float | None = None
        # ⭐ 収束判定用に**コード値のまま**も持つ。
        #    % に戻すと丸めで往復できなくなり、等値比較が壊れる
        self.obs_color_code: int | None = None
        self.obs_bright_code: int | None = None
        # ナイトライト（常夜灯）の状態。器具が返す 0〜3（0=消灯 / 3=最も明るい）
        self.night: int | None = None
        # 状態応答の生バイト（未解読フィールドの調査用）
        self.status_raw: str | None = None

    @property
    def mac_str(self) -> str:
        return ":".join(f"{b:02X}" for b in reversed(self.mac))

    @property
    def key(self) -> str:
        """API で器具を指定するためのキー。vAddr の 16 進。"""
        return self.vaddr.hex().upper()

    @property
    def product_name(self) -> str:
        if self.product_code is None:
            return "不明"
        return PRODUCT_CODES.get(self.product_code, f"0x{self.product_code:02X}")

    def apply_status(
        self, color_code: int, bright_code: int, night_code: int | None = None
    ) -> None:
        self.obs_color_code = color_code
        self.obs_bright_code = bright_code
        if color_code == CODE_OFF and bright_code == CODE_OFF:
            self.on = False
        elif color_code == CODE_ON and bright_code == CODE_ON:
            self.on = True
        else:
            self.color = code_to_color(color_code)
            self.bright = code_to_bright(bright_code)
            self.on = (self.bright or 0) > 0
        if night_code is not None:
            self.night = night_code
        self.state_updated_at = time.time()

    @property
    def night_level(self) -> int | None:
        """ナイトライトの状態をコマンドと同じ尺度（0〜2・0 が最も明るい）で返す。

        器具は 0=消灯 / 1〜3（3 が最も明るい）で返すので反転する（C24-6）。
        消灯なら None。
        """
        if not self.night:
            return None
        return 3 - self.night

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "mac": self.mac_str,
            "vaddr": hexs(self.vaddr),
            "product_code": self.product_code,
            "product": self.product_name,
            "group_id": self.group_id,
            "version": self.version,
            "on": self.on,
            "bright": self.bright,
            "color": self.color,
            # ナイトライト。night = 器具が返す 0〜3、night_level = コマンドの尺度
            "night_on": bool(self.night) if self.night is not None else None,
            "night": self.night,
            "night_level": self.night_level,
            "state_updated_at": self.state_updated_at,
            "status_raw": self.status_raw,
            "last_seen": self.last_seen,
        }


class Intent:
    """1 操作の「期待状態」と収束の追跡（P2 / P4）。

    純正アプリは各コマンドを 1 回送って終わり（C18-5）。ここでは
    **期待どおりの状態応答が返るまで送り直し、返らなければ失敗と言う。**

    ⭐ コマンドと状態応答のエンコーディングが同一なので（C15-9 / C18-4）、
    収束判定はコード値の等値比較でできる。⚠️ ただし ON だけは例外で、
    コマンドは `37 37` なのに応答は器具が記憶していた実値が返るため、
    「消灯（`32 32`）でない」ことで判定する。
    """

    def __init__(
        self,
        target: str,
        pdus: list[bytes],
        kind: str,
        color_code: int | None = None,
        bright_code: int | None = None,
        night_code: int | None = None,
        deadline_ms: float = 3000.0,
        max_attempts: int = 4,
    ) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.target = target
        self.pdus = pdus
        self.kind = kind  # level / on / off / night
        self.color_code = color_code
        self.bright_code = bright_code
        self.night_code = night_code
        self.created = time.monotonic()
        self.created_wall = time.time()  # 観測が操作より後か判定するため
        self.deadline = self.created + deadline_ms / 1000.0
        self.max_attempts = max_attempts
        self.attempts = 0
        self.state = "sending"  # sending / converged / timeout / superseded
        self.timers: list[int] = []
        self.done = threading.Event()  # ?wait=1 のため

    def matches(self, dev: "Device") -> bool:
        """この器具が期待どおりになったか。"""
        c, b = dev.obs_color_code, dev.obs_bright_code
        if c is None or b is None:
            return False
        off = c == CODE_OFF and b == CODE_OFF
        if self.kind == "off":
            return off
        if self.kind == "on":
            return not off  # ⚠️ ON は等値比較できない（上記）
        if self.kind == "night":
            return dev.night == self.night_code
        return c == self.color_code and b == self.bright_code

    def expected(self) -> dict:
        if self.kind == "night":
            return {"kind": self.kind, "night": self.night_code}
        if self.kind in ("on", "off"):
            return {"kind": self.kind}
        return {
            "kind": self.kind,
            "color_code": self.color_code,
            "bright_code": self.bright_code,
            "color": code_to_color(self.color_code or 0),
            "bright": code_to_bright(self.bright_code or 0),
        }

    def to_dict(self) -> dict:
        return {
            "intent": self.id,
            "target": self.target,
            "state": self.state,
            "attempts": self.attempts,
            "age_ms": round((time.monotonic() - self.created) * 1000, 1),
            "expected": self.expected(),
        }


class LightState:
    """メッシュ全体としての状態キャッシュ（P1）。"""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.on: bool | None = None
        self.bright: int | None = None
        self.color: int | None = None
        self.updated_at: float | None = None

    def apply_status(self, color_code: int, bright_code: int) -> None:
        with self.lock:
            if color_code == CODE_OFF and bright_code == CODE_OFF:
                self.on = False
            elif color_code == CODE_ON and bright_code == CODE_ON:
                self.on = True
            else:
                self.color = code_to_color(color_code)
                self.bright = code_to_bright(bright_code)
            self.updated_at = time.time()

    def note_command(self, on: bool | None, bright: int | None, color: int | None) -> None:
        """送ったコマンドを期待状態として反映する（P5 楽観的更新）。"""
        with self.lock:
            if on is not None:
                self.on = on
            if bright is not None:
                self.bright = bright
            if color is not None:
                self.color = color
            self.updated_at = time.time()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "on": self.on,
                "bright": self.bright,
                "color": self.color,
                "updated_at": self.updated_at,
            }


# ------------------------------------------------------------------ 計測
#
# 測っていないものは最適化できない。集めるのは 4 種類。
#
#   RTT      状態要求（0x70）→ 応答（0x71）の往復時間。器具ごと
#   到達率   1 回の要求に対して応答が返った割合（EWMA）
#   収束時間 コマンド送信 → 期待どおりの状態応答が届くまで（体感に一番近い指標）
#   リンク   GATT リンクの確立・切断・寿命・沈黙時間
#
# ⚠️ 状態要求にはシーケンス番号のフィールドが無い（C15-6）。
#    そこで **in-flight を 1 本に制限**して応答を直近の要求に対応づける。
#    実測 RTT は p99 ≒ 450 ms なので、要求間隔を 200 ms 以上に保てば衝突しない。


def pct(values: list[float], q: float) -> float | None:
    """パーセンタイル（最近傍）。空なら None。"""
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


class Ring:
    """固定長の履歴。常駐プロセスなのでメモリ上限を必ず持たせる。"""

    def __init__(self, maxlen: int) -> None:
        self.buf: collections.deque = collections.deque(maxlen=maxlen)

    def add(self, v) -> None:
        self.buf.append(v)

    def values(self) -> list:
        return list(self.buf)

    def stats(self, nd: int = 1) -> dict:
        v = [x for x in self.buf if x is not None]
        if not v:
            return {"n": 0}
        return {
            "n": len(v),
            "p50": round(pct(v, 0.5), nd),
            "p90": round(pct(v, 0.9), nd),
            "p99": round(pct(v, 0.99), nd),
            "min": round(min(v), nd),
            "max": round(max(v), nd),
        }


class Ewma:
    """指数移動平均。到達率のように「直近が効く」値に使う。"""

    def __init__(self, alpha: float = 0.2, initial: float = 1.0) -> None:
        self.alpha = alpha
        self.value = initial
        self.n = 0

    def add(self, ok: bool) -> float:
        self.value = (1.0 - self.alpha) * self.value + self.alpha * (1.0 if ok else 0.0)
        self.n += 1
        return self.value


class StatusProbe:
    """状態要求 1 回分の追跡。応答の対応づけと RTT の計算をここで行う。"""

    def __init__(self, kind: str, expect: set[str], sends: int, window_ms: float) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.kind = kind  # auto / confirm / experiment
        self.sent_at = time.monotonic()
        self.expect = set(expect)  # 応答を期待する器具キー。空なら「来た分だけ数える」
        self.sends = sends
        self.window = window_ms / 1000.0
        self.first: dict[str, float] = {}
        self.dups: collections.Counter = collections.Counter()

    def note(self, key: str) -> float | None:
        """応答を受理。初回なら RTT（ms）を返す。中継による重複なら None。"""
        if key in self.first:
            self.dups[key] += 1
            return None
        rtt = (time.monotonic() - self.sent_at) * 1000.0
        self.first[key] = rtt
        return rtt

    @property
    def complete(self) -> bool:
        return bool(self.expect) and self.expect <= set(self.first)

    @property
    def expired(self) -> bool:
        return time.monotonic() - self.sent_at > self.window

    def missed(self) -> set[str]:
        return self.expect - set(self.first)


class LinkRecord:
    """GATT リンク 1 本の履歴（器具の MAC 単位）。

    ⚠️ 権威は `org.bluez.Device1` の `Connected` プロパティ。
    BlueZ 5.82 は切断時に `StopNotify` をほぼ呼ばないので、
    キャラクタリスティックの `notifying` をリンク状態の判定に使ってはいけない。
    """

    def __init__(self, mac: str) -> None:
        self.mac = mac
        self.up_at: float | None = None
        self.down_at: float | None = None
        self.up_count = 0
        self.down_count = 0
        self.logins = 0
        self.writes = 0
        self.last_rx_at: float | None = None
        self.vaddr: bytes | None = None
        self.last_reason: str | None = None
        self.held = Ring(64)
        self.rtt = Ring(256)

    @property
    def live(self) -> bool:
        return self.up_at is not None

    @property
    def held_sec(self) -> float | None:
        return round(time.monotonic() - self.up_at, 1) if self.up_at else None

    @property
    def silence_sec(self) -> float | None:
        return round(time.monotonic() - self.last_rx_at, 1) if self.last_rx_at else None

    def to_dict(self) -> dict:
        return {
            "mac": self.mac,
            "live": self.live,
            "held_sec": self.held_sec,
            "silence_sec": self.silence_sec,
            "up_count": self.up_count,
            "down_count": self.down_count,
            "logins": self.logins,
            "writes": self.writes,
            "vaddr": hexs(self.vaddr) if self.vaddr else None,
            "last_reason": self.last_reason,
            "held_sec_hist": self.held.stats(),
            "rtt_ms": self.rtt.stats(),
        }


class Metrics:
    """計測値の集約。`GET /metrics` がそのまま返す。"""

    RTT_MAX = 2048
    EVENT_MAX = 512

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.rtt: dict[str, Ring] = {}
        self.delivery: dict[str, Ewma] = {}
        self.miss_streak: collections.Counter = collections.Counter()
        self.absent: set[str] = set()
        self.converge = Ring(512)
        self.attempts: collections.Counter = collections.Counter()
        self.links: dict[str, LinkRecord] = {}
        self.events = Ring(self.EVENT_MAX)
        self.send: collections.Counter = collections.Counter()
        self.recv: collections.Counter = collections.Counter()
        self.probe: collections.Counter = collections.Counter()
        self.started = time.time()

    # -------------------------------------------------- 記録

    def event(self, name: str, **kw) -> None:
        """イベントを記録し、機械可読な 1 行をログに出す。

        `#M <name> k=v …` の形にしておくと journald をそのまま長期ストレージとして
        awk で集計できる（実際にこの形式で過去ログを再集計して方針を決めた）。
        """
        rec = {"ts": time.time(), "t": round(time.monotonic() - START, 3), "event": name}
        rec.update(kw)
        with self.lock:
            self.events.add(rec)
        log(f"#M {name} " + " ".join(f"{k}={v}" for k, v in kw.items()))

    def bump(self, which: str, key: str, n: int = 1) -> None:
        """カウンタを増やす（`send` / `recv` / `probe`）。"""
        with self.lock:
            getattr(self, which)[key] += n

    def link(self, mac: str) -> LinkRecord:
        with self.lock:
            r = self.links.get(mac)
            if r is None:
                r = LinkRecord(mac)
                self.links[mac] = r
            return r

    def note_rtt(self, key: str, ms: float, mac: str | None = None) -> None:
        with self.lock:
            self.rtt.setdefault(key, Ring(self.RTT_MAX)).add(ms)
        if mac:
            self.link(mac).rtt.add(ms)

    def note_delivery(self, key: str, ok: bool) -> None:
        with self.lock:
            self.delivery.setdefault(key, Ewma()).add(ok)
            if ok:
                self.miss_streak[key] = 0
                self.absent.discard(key)
            else:
                self.miss_streak[key] += 1
                if self.miss_streak[key] >= 3:
                    # 電源が落ちている器具で到達率を汚さない
                    self.absent.add(key)

    # -------------------------------------------------- 参照

    def worst_delivery(self) -> float:
        """在席している器具のうち最も悪い到達率。適応再送の判断に使う。"""
        with self.lock:
            vals = [e.value for k, e in self.delivery.items() if k not in self.absent]
        return min(vals) if vals else 1.0

    def rtt_p90(self, default: float = 150.0) -> float:
        """全器具をまとめた RTT の p90（ms）。確認遅延の算出に使う。"""
        with self.lock:
            vals: list[float] = []
            for r in self.rtt.values():
                vals += r.values()
        return pct(vals, 0.9) or default

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "rtt_ms": {k: r.stats() for k, r in self.rtt.items()},
                "delivery": {
                    k: {"ewma": round(e.value, 4), "n": e.n, "absent": k in self.absent}
                    for k, e in self.delivery.items()
                },
                "converge_ms": self.converge.stats(),
                "converge_attempts": dict(self.attempts),
                "links": {m: r.to_dict() for m, r in self.links.items()},
                "send": dict(self.send),
                "recv": dict(self.recv),
                "probe": dict(self.probe),
                "since": self.started,
            }

    def recent_events(self, since: float = 0.0, name: str | None = None) -> list[dict]:
        with self.lock:
            evs = self.events.values()
        return [
            e for e in evs if e["ts"] > since and (name is None or e["event"] == name)
        ]


# ------------------------------------------------------------ GATT サーバ


class Characteristic(dbus.service.Object):
    def __init__(self, bus, path, uuid, flags, service_path, daemon=None):
        self.path = path
        self.uuid = uuid
        self.flags = flags
        self.service_path = service_path
        self.daemon = daemon
        self.notifying = False
        self.value = dbus.Array([], signature="y")
        super().__init__(bus, path)

    def get_properties(self):
        return {
            GATT_CHRC_IFACE: {
                "Service": dbus.ObjectPath(self.service_path),
                "UUID": self.uuid,
                "Flags": self.flags,
                "Value": self.value,
                "Notifying": dbus.Boolean(self.notifying),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise dbus.exceptions.DBusException("org.bluez.Error.InvalidArguments")
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        return self.value

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        if self.daemon:
            self.daemon.on_write(bytes(value), options)

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True
        if self.daemon:
            self.daemon.on_link_up()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False
        if self.daemon:
            self.daemon.on_link_down()

    def notify(self, data: bytes) -> bool:
        if not self.notifying:
            return False
        self.value = dbus.Array(data, signature="y")
        self.PropertiesChanged(GATT_CHRC_IFACE, {"Value": self.value}, [])
        return True


class Service(dbus.service.Object):
    def __init__(self, bus, path, uuid):
        self.path = path
        self.uuid = uuid
        self.characteristics: list[Characteristic] = []
        super().__init__(bus, path)

    def get_properties(self):
        return {
            GATT_SERVICE_IFACE: {
                "UUID": self.uuid,
                "Primary": dbus.Boolean(True),
                "Characteristics": dbus.Array(
                    [dbus.ObjectPath(c.path) for c in self.characteristics],
                    signature="o",
                ),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise dbus.exceptions.DBusException("org.bluez.Error.InvalidArguments")
        return self.get_properties()[GATT_SERVICE_IFACE]


class Application(dbus.service.Object):
    PATH = "/jp/calil/odelicd"

    def __init__(self, bus, daemon):
        self.services: list[Service] = []
        super().__init__(bus, self.PATH)
        svc = Service(bus, self.PATH + "/service0", UUID_SERVICE)
        write = Characteristic(
            bus,
            svc.path + "/char0",
            UUID_WRITE,
            ["read", "write", "write-without-response"],
            svc.path,
            daemon,
        )
        notify = Characteristic(
            bus, svc.path + "/char1", UUID_NOTIFY, ["read", "notify"], svc.path, daemon
        )
        svc.characteristics = [write, notify]
        self.services.append(svc)
        self.notify_chrc = notify

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        out = {}
        for svc in self.services:
            out[dbus.ObjectPath(svc.path)] = svc.get_properties()
            for c in svc.characteristics:
                out[dbus.ObjectPath(c.path)] = c.get_properties()
        return out


# ------------------------------------------------------------------ 本体


class Daemon:
    def __init__(
        self,
        homeid: bytes,
        password: bytes,
        group: int,
        resend: int,
        verbose: bool = False,
        login_reply: bool = True,
        set_link: str = "never",
        link_policy: str = "single",
        confirm_delay: float = 0.0,
        dup_window: float = 0.4,
    ):
        self.homeid = homeid
        self.password = password
        self.group = group
        self.resend = resend
        self.verbose = verbose
        self.login_reply = login_reply
        # SET_LINK (01 10) を送るか。never / auto（2 台目にだけ）/ always（C23-7）
        self.set_link = set_link
        # 最初に WELCOME をくれた器具 = 主リンク
        self.primary_mac: str | None = None

        # ⭐ リンク方針（C33 の実測で single が正しいと判った）
        #
        #   single … 参加したら広告を止め、主リンク 1 本だけ残す（純正アプリと同じ）
        #   multi  … 広告を出し続けて複数リンクを維持しようとする（従来動作）
        #
        # ⚠️ multi は**動かない**。実測すると、新しいリンクが確立するたびに
        #    器具が古いリンクを 0.7〜1.4 秒後に切る（完全な交互パターン）。
        #    メッシュは「コントローラ 1 台につきリンク 1 本」しか許さない。
        #    広告を出しっぱなしにすると、器具が交互に繋いできて延々と切り合う。
        #    実測ではリンク寿命 p50 7〜14 秒・3 分で 22 回の再参加になった。
        self.link_policy = link_policy
        # 確認要求までの待ち（秒）。0 なら実測 RTT の p90 から自動で決める
        self.confirm_delay = confirm_delay
        self.dup_window = dup_window

        # 計測（Phase A）。これが無いと最適化の是非を判定できない
        self.metrics = Metrics()
        # 進行中の状態要求。応答の対応づけのため in-flight は 1 本に限る
        self.probe: StatusProbe | None = None
        # 進行中の操作（キー = target）。新しい操作は同じ target の古いものを破棄する
        self.intents: dict[str, Intent] = {}
        self.max_attempts = 4
        self.deadline_ms = 3000.0
        # 状態要求に「全器具が無応答」だった連続回数。入口の死亡判定に使う
        self.dead_streak = 0
        self.dead_after = 3
        # 受信の重複排除（中継経路が複数あるので同じ PDU が二重に届く）
        self._recent_rx: collections.OrderedDict = collections.OrderedDict()

        # C23: 受信復号に使う鍵
        self.login_key, self.event_key = make_mesh_keys(homeid, password)
        # 器具ごとの XOR ホワイトニング鍵（PERIPHERAL_LOGIN から得る 4 バイト）。
        # キー = 器具の MAC 文字列。`.so` も device エントリを MAC で引いている
        self.link_keys: dict[str, bytes] = {}
        self.decrypt_ok = 0
        self.decrypt_fail = 0
        # C28: 他コントローラのコマンド観測（中継による重複を捨てるため）
        self._last_observed: bytes | None = None
        self._last_observed_at = 0.0
        self._confirm_seq = 0
        # C30: 分割 PDU の再組立（送信元ごと）
        self._segments: dict[str, dict] = {}
        self.segment_ok = 0
        self.segment_drop = 0

        self.own_vaddr: bytes | None = None
        self.device_num: int | None = None
        self.joined = False
        self.link_up_at: float | None = None
        self.join_count = 0
        self.state = LightState()
        # 探索応答から作る器具一覧（キー = vAddr の 16 進）
        self.devices: dict[str, Device] = {}
        # GATT で接続してきた器具（キー = MAC）。これは D-Bus から取れる
        self.peers: dict[str, dict] = {}
        # ⭐ 生きている GATT リンク（キー = MAC）。権威は Device1.Connected。
        #    BlueZ 5.82 は切断時に StopNotify をほぼ呼ばないので、
        #    キャラクタリスティックの notifying をリンク状態に使ってはいけない
        self.live_links: set[str] = set()
        # own_vAddr はリンクごとに違う値が割り当てられる。単一変数で持つと
        # 「最後にログインしたリンクの vAddr」で送ってしまい応答が返らない
        self.link_vaddr: dict[str, bytes] = {}

        self.notify_chrc: Characteristic | None = None
        self.adv: RawAdvertiser | None = None
        # 広告を出したいか。参加したら止める（打ち直しは keepalive が行う）
        self.adv_wanted = True
        # 余剰リンクを切るための関数。main が D-Bus の Disconnect を渡す
        self.disconnect_cb = None
        # 未接続のあいだ操作を溜めておく（P5）
        self.pending: list[bytes] = []
        self.lock = threading.Lock()

    # -------------------------------------------------- リンク状態

    def on_link_up(self) -> None:
        """StartNotify（CCCD 書き込み）。⚠️ 購読の合図でしかない。

        リンク状態の権威は `Device1.Connected`（`on_device_connected`）。
        """
        self.link_up_at = time.monotonic()
        log("★ Notify の購読を受けた")

    def on_link_down(self) -> None:
        """StopNotify。⚠️ BlueZ 5.82 はこれをほぼ呼ばない。

        24 時間で「リンク確立 50 回 / 切断 2 回」という記録が残っていた。
        切断の検知に使ってはいけない。
        """
        log("Notify の購読が解除された")

    def on_device_connected(self, mac: str) -> None:
        """GATT リンクが確立した（`Device1.Connected` = True）。"""
        with self.lock:
            if mac in self.live_links:
                return
            self.live_links.add(mac)
            n = len(self.live_links)
        rec = self.metrics.link(mac)
        rec.up_at = time.monotonic()
        rec.up_count += 1
        self.metrics.event("link_up", mac=mac, links=n)

    def on_device_disconnected(self, mac: str, reason: str = "bluez") -> None:
        """GATT リンクが切れた（`Device1.Connected` = False）。"""
        with self.lock:
            if mac not in self.live_links:
                return
            self.live_links.discard(mac)
            self.link_vaddr.pop(mac, None)
            remaining = len(self.live_links)
            was_primary = self.primary_mac == mac
            if was_primary:
                # 主リンクが落ちたら参加状態を捨てる（C29-4 と同じ）
                self.primary_mac = None
                self.joined = False
                self.own_vaddr = None
        rec = self.metrics.link(mac)
        held = rec.held_sec
        if held is not None:
            rec.held.add(held)
        rec.up_at = None
        rec.down_at = time.monotonic()
        rec.down_count += 1
        rec.last_reason = reason
        self.metrics.event(
            "link_down",
            mac=mac,
            held_sec=held,
            primary=was_primary,
            links=remaining,
            reason=reason,
        )
        # 主リンクが落ちた（or 全部落ちた）なら待ち受けを再開する
        if was_primary or remaining == 0:
            self.want_adv(True, "link_down")

    # -------------------------------------------------- 広告の制御

    def want_adv(self, on: bool, why: str) -> None:
        """新しい器具の接続を受け付けるかを切り替える。

        ⭐ **参加したら受け付けを止めるのが安定性の鍵。**
        実測（C33）: 受け付けたままにすると器具が次々に繋いできて、そのたびに
        メッシュが古いリンクを切る（新リンク確立の 0.7〜1.4 秒後・完全な交互）。
        「コントローラ 1 台につきリンク 1 本」しか許されないため、
        2 本目を迎えようとすると 1 本目を失う。純正アプリが
        `peripheral_stop_adv_after_welcome = true` にしているのはこのため（C29-3）。

        ⚠️ ただし**広告を消すことはできない。** BlueZ が 150〜240 ms 後に必ず
        再開してくる。代わりに ADV_NONCONN_IND（接続不可）へ切り替える。
        """
        if self.adv is None:
            return
        changed = self.adv_wanted != on
        self.adv_wanted = on
        self.adv.set_connectable(on)
        if changed:
            self.metrics.event("adv", state="connectable" if on else "nonconn", why=why)

    def prune_links(self) -> None:
        """主リンク以外を自分から切る（`link_policy = single`）。

        ⚠️ 純正アプリは余剰リンクに `01 15 55`（exit_cmd）を送って追い出すが、
        **BlueZ ではそれができない。** Notify は D-Bus の `PropertiesChanged`
        なので購読中の全リンクにブロードキャストされ、主リンクまで切ってしまう。
        代わりに `Device1.Disconnect()` を使う（相手を指定できる）。
        """
        if self.link_policy != "single":
            return
        with self.lock:
            primary = self.primary_mac
            extras = [m for m in self.live_links if m != primary]
        if not (primary and extras):
            return
        for mac in extras:
            self.metrics.event("prune_link", mac=mac, primary=primary)
            if self.disconnect_cb:
                self.disconnect_cb(mac)

    @property
    def connected(self) -> bool:
        """本当に送れる状態か。⚠️ ここで嘘をつくと P4 違反になる。"""
        return bool(
            self.live_links
            and self.notify_chrc
            and self.notify_chrc.notifying
            and self.joined
            and self.own_vaddr is not None
        )

    # -------------------------------------------------- 受信処理

    def on_write(self, data: bytes, options) -> None:
        if not data:
            return
        # 器具からのデータ応答は暗号化されて返る（C20）が、
        # PERIPHERAL_LOGIN から鍵が取れるので復号できる（C23）。
        # どの器具が繋いできたかは D-Bus のデバイスパスから分かる。
        mac = self._note_peer(options)
        if self.verbose:
            log(f"  << [{len(data):2d}] {hexs(data)}")
        self._dispatch_pdu(data, mac)

    def _dispatch_pdu(self, data: bytes, mac: str | None, from_segment: bool = False) -> None:
        ptype = data[0]
        if ptype == PDU_CMD:
            self._handle_cmd(data, mac)
        elif ptype == PDU_DATA_EVENT:
            self._handle_data_event(data)
        elif ptype == PDU_ENCRYPTED:
            self._handle_encrypted(data, mac)
        elif ptype == PDU_SEGMENT and not from_segment:
            self._handle_segment(data, mac)
        elif self.verbose:
            log(f"     （未処理の PDU タイプ 0x{ptype:02X}）")

    # -------------------------------------------------- セグメント再組立

    def _handle_segment(self, data: bytes, mac: str | None) -> None:
        """分割 PDU を組み立てる（C30）。

        書式: `04 04 <seq バイト> <断片…>`
              seq バイト = (最終 seq << 4) | この seq（どちらも 1〜15）

        ⚠️ 純正アプリの実装（`MeshCommon.processSegmentPDU`）には
        **欠落を検知しても状態をリセットしない**という致命的な欠陥があり、
        1 個落ちると以降のすべての分割転送が壊れる（C30-1）。
        ここでは以下を直している。

          - 送信元（MAC）ごとに独立した組み立て状態を持つ
          - `seq == 1` は常に新しい転送として作り直す（前回の残骸で詰まらない）
          - 欠落を検知したら即座に捨ててログに出す（黙って溜め込まない）
          - タイムアウト（3 秒）とバッファ上限（4096 バイト）
        """
        if len(data) < 4 or data[1] != SEGMENT_SUB:
            log(f"[!] 解釈できないセグメント: {hexs(data)}")
            return
        seq, last = data[2] & 0x0F, (data[2] >> 4) & 0x0F
        chunk = data[3:]
        key = mac or ""
        now = time.monotonic()

        with self.lock:
            st = self._segments.get(key)
            if st and now - st["at"] > SEGMENT_TIMEOUT:
                log(f"[!] セグメントがタイムアウト（{len(st['buf'])} バイトを破棄）: {key}")
                st = None
            if seq == 1 or st is None:
                if seq != 1:
                    # 途中から来た = 先頭を取りこぼしている
                    self.segment_drop += 1
                    log(f"[!] セグメント {seq}/{last} が先頭でないため破棄: {key}")
                    self._segments.pop(key, None)
                    return
                st = {"buf": bytearray(), "next": 1, "last": last, "at": now}
                self._segments[key] = st
            elif seq != st["next"]:
                self.segment_drop += 1
                log(
                    f"[!] セグメントの欠落を検知（期待 {st['next']} / 受信 {seq}）"
                    f" → {len(st['buf'])} バイトを破棄: {key}"
                )
                self._segments.pop(key, None)
                return

            if len(st["buf"]) + len(chunk) > SEGMENT_MAX:
                self.segment_drop += 1
                log(f"[!] セグメントが上限 {SEGMENT_MAX} バイトを超えたため破棄: {key}")
                self._segments.pop(key, None)
                return

            st["buf"] += chunk
            st["next"] = seq + 1
            st["last"] = last
            st["at"] = now
            done = seq == last
            total = len(st["buf"])
            assembled = bytes(st["buf"]) if done else b""
            if done:
                self._segments.pop(key, None)
                self.segment_ok += 1

        if not done:
            if self.verbose:
                log(f"     セグメント {seq}/{last} を受理（累計 {total} バイト）")
            return
        log(f"★ セグメント再組立完了 {last} 個 / {len(assembled)} バイト: {hexs(assembled)}")
        self._dispatch_pdu(assembled, mac, from_segment=True)

    def _handle_encrypted(self, data: bytes, mac: str | None) -> None:
        """暗号化された応答（タイプ 0x06）を復号して通常の経路に流す（C23-3）。"""
        keys: list[tuple[str, bytes]] = []
        with self.lock:
            if mac and mac in self.link_keys:
                keys.append((mac, self.link_keys[mac]))
            # MAC が取れない・鍵が別リンクのものだった場合の保険として全鍵を試す。
            # パディング検査（最終バイト ≤ 0x10）があるので誤復号はほぼ弾ける
            keys += [(m, k) for m, k in self.link_keys.items() if m != mac]

        for src, key in keys:
            pdu = decrypt_mesh_pdu(data, self.event_key, key)
            if pdu is None:
                continue
            with self.lock:
                self.decrypt_ok += 1
            if self.verbose:
                log(f"  ↓復号 [{len(pdu):2d}] {hexs(pdu)}  （鍵 {src}）")
            self._handle_data_event(pdu)
            return

        with self.lock:
            self.decrypt_fail += 1
        if not keys:
            log(f"[!] 暗号化 PDU を受信したが器具鍵がない（PERIPHERAL_LOGIN 未受信）: {hexs(data)}")
        else:
            log(f"[!] 復号に失敗（鍵 {len(keys)} 個を試行）: {hexs(data)}")

    def _handle_cmd(self, data: bytes, mac: str | None = None) -> None:
        if len(data) < 2:
            return
        sub, body = data[1], data[2:]

        if sub == CMD_PERIPHERAL_LOGIN:
            self._handle_login(body, mac)
            return

        if sub == CMD_GET_PASSWORD:
            self._send(bytes([PDU_RESPONSE, CMD_GET_PASSWORD]) + self.homeid + self.password)
            return

        if sub == CMD_GET_VIRTUAL_ADDR and len(body) >= 4:
            # ⚠️ own_vAddr は**リンクごとに違う値**が割り当てられる。
            #    単一変数に上書きすると「最後にログインしたリンクの vAddr」で
            #    送ってしまい、器具が応答を返さない（実測でバースト 1 回丸ごと無応答）
            vaddr = body[:4]
            with self.lock:
                if mac:
                    self.link_vaddr[mac] = vaddr
                    self.metrics.link(mac).vaddr = vaddr
                if self.primary_mac is None or mac is None or mac == self.primary_mac:
                    self.own_vaddr = vaddr
            log(f"own_vAddr = {hexs(vaddr)}（{mac or 'MAC 不明'}）")
            return

        if sub == CMD_WELCOME:
            # ⭐ 純正アプリは WELCOME に対して、
            #    主リンク（最初の器具）→ 何も返さない
            #    2 台目以降（バックアップ）→ SET_LINK (01 10) を返す
            #   （PlMeshPeripheral.onCharacteristicWriteRequest。C23-7）
            with self.lock:
                if self.primary_mac is None and mac:
                    self.primary_mac = mac
                primary = self.primary_mac
            backup = bool(mac and primary and mac != primary)
            if self.set_link == "always" or (self.set_link == "auto" and backup):
                self._send(bytes([PDU_CMD, CMD_SET_LINK]))
                log(f"WELCOME（{'バックアップ' if backup else '主'}リンク）— SET_LINK 送信")
            else:
                log(f"WELCOME（{'バックアップ' if backup else '主'}リンク）")
            return

        if sub == CMD_BROADCAST_MESHINFO:
            if len(body) >= 8:
                self.device_num = body[6] | (body[7] << 8)
            self.joined = True
            self.join_count += 1
            log(f"★ 参加完了（器具 {self.device_num} 台）")
            self.metrics.event(
                "joined", mac=mac or "?", devices=self.device_num, n=self.join_count
            )
            # ⭐ 参加したら広告を止め、余剰リンクを切る（C33 / C29-3）。
            #    出し続けると器具が次々繋いできて、そのたびに古いリンクが切られる。
            #    hcitool / D-Bus の呼び出しでメインループを止めないよう少し後で行う
            if self.link_policy == "single":
                GLib.timeout_add(50, self._after_join)
            self._flush_pending()
            # 参加できたら器具一覧を取り直す（vAddr が分かると個別制御と状態取得ができる）
            GLib.timeout_add(300, self._auto_discover)
            return

    def _handle_login(self, body: bytes, mac: str | None) -> None:
        """PERIPHERAL_LOGIN（`01 19` + 16 バイト）を処理する（C23-1 / C23-2）。

        中身は LOGINKEY で 1 ブロック復号できる。

            [0..3]  HOMEID（照合用）
            [4..7]  ★ この器具の 4 バイト = 受信復号の XOR ホワイトニング鍵
            [8..15] PKCS#7 パディング（08 × 8）

        ⚠️ 以前は「応答してはいけない」としていた（C19-2）が、それは
        **エコーバックという誤答**だったため切断されていただけだった。
        純正アプリと同じ正しい応答は再現できる（C23-2）。
        """
        if len(body) != 16:
            log(f"[!] PERIPHERAL_LOGIN の長さが想定外（{len(body)} バイト）: {hexs(body)}")
            return

        pt = aes_ecb_decrypt(self.login_key, body)
        if pt[:4] != self.homeid:
            log(
                f"[!] ログイン要求の HOMEID が一致しない: {hexs(pt[:4])}"
                f" ≠ {hexs(self.homeid)}（ID の指定を確認）"
            )
            return

        dev4 = pt[4:8]
        with self.lock:
            known = self.link_keys.get(mac or "") == dev4
            if mac:
                self.link_keys[mac] = dev4
            else:
                # MAC が取れないときも復号は試せるようにキーなしで保持する
                self.link_keys.setdefault("", dev4)
        if not known:
            log(f"★ ログイン要求を復号: {mac or '（MAC 不明）'} の鍵 = {hexs(dev4)}")

        if self.login_reply:
            self._send(make_login_response(self.login_key, self.homeid, self.password, dev4))

    def _auto_discover(self) -> bool:
        """参加直後に器具一覧を集める。

        純正アプリと同じ順序で送る（C23-5）。

          1. Ping（チャネル 0xFE）を**暗号化して**送る
             → 器具が MAC + vAddr + 機種 + ファームを返す
          2. MSGID 0x02 → 器具が 0x80 で MAC と製品コードを返す
          3. MSGID 0xD0 01 → 器具が 0xD7 でグループ ID を返す

        平文の 2・3 だけでは応答が来なかった（C20-1）。純正アプリのログでは
        必ず先に暗号化 Ping が飛んでいる。
        """
        if not self.connected:
            return False
        self.ping_all()
        GLib.timeout_add(600, self._auto_discover2)
        return False

    def _auto_discover2(self) -> bool:
        if self.connected:
            self.discover()
            GLib.timeout_add(1500, self._auto_status)
        return False

    def _auto_status(self) -> bool:
        if self.connected:
            self.request_status(kind="auto")
        return False

    def _after_join(self) -> bool:
        """参加直後の後片付け（広告を止め、余剰リンクを切る）。"""
        self.want_adv(False, "joined")
        self.prune_links()
        return False

    def _handle_data_event(self, data: bytes) -> None:
        if len(data) < 6:
            return
        channel = data[5]

        # ⚠️ チャネルごとにレイアウトが違う。Ping 応答は [6] から器具の MAC が入る
        if channel == CH_PING_RESPONSE:
            self._handle_ping_response(data)
            return

        if len(data) < 11:
            return
        src_vaddr, msgid, params = data[6:10], data[10], data[11:]

        # 器具の自己申告（MeshBlePresenter.getProductId）
        #   params[0..5] = MAC / params[6] = 製品コード / params[8] = LC615 モード
        if msgid == MSGID_ID_PERIPHERAL and len(params) >= 7:
            self._register_device(src_vaddr, params[0:6], params[6])
            return

        # グループ ID の応答（MeshBlePresenter の GROUP_RESPONSE）
        #   params[7] = グループ ID
        if msgid == MSGID_GROUP_RESPONSE and len(params) >= 8:
            key = src_vaddr.hex().upper()
            dev = self.devices.get(key)
            gid = params[7]
            if dev is None:
                dev = self._register_device(src_vaddr, None, None)
            dev.group_id = gid
            log(f"     グループ ID: {dev.mac_str or hexs(src_vaddr)} → {gid}")
            return

        if msgid in (MSGID_STATUS_MAIN, MSGID_STATUS_FD) and len(params) >= 2:
            color_code, bright_code = params[0], params[1]
            # params[2] = ナイトライトの状態（0=消灯 / 1〜3、3 が最も明るい）。C24-6
            night_code = params[2] if len(params) >= 3 else None
            key = src_vaddr.hex().upper()

            # 進行中の状態要求に対応づけて RTT を測る（in-flight は 1 本だけ）
            probe, dup = self.probe, False
            if probe is not None and not probe.expired:
                rtt = probe.note(key)
                if rtt is None:
                    # 同じ応答が中継や自分の再送で複数回届いたぶん
                    dup = True
                    self.metrics.bump("recv", "status_dup")
                else:
                    d0 = self.devices.get(key)
                    self.metrics.note_rtt(key, rtt, d0.mac_str if d0 else None)
                    self.metrics.event(
                        "rtt", vaddr=key, ms=round(rtt, 1), kind=probe.kind,
                        sends=probe.sends,
                    )
            else:
                self.metrics.bump("recv", "status_unsolicited")

            self.state.apply_status(color_code, bright_code)
            dev = self.devices.get(key)
            if dup:
                # 状態の反映は冪等なので捨てて構わない。数だけ残す
                if dev:
                    dev.apply_status(color_code, bright_code, night_code)
                    self._check_intents()
                return
            if dev:
                dev.apply_status(color_code, bright_code, night_code)
                dev.status_raw = hexs(params)
                night = (
                    "消灯" if not dev.night else f"レベル {dev.night_level}（器具値 {dev.night}）"
                )
                log(
                    f"状態更新 {dev.mac_str}: on={dev.on} bright={dev.bright}"
                    f" color={dev.color} ナイト={night}  raw=[{dev.status_raw}]"
                )
            else:
                log(f"状態更新（未知の送信元 {hexs(src_vaddr)}）: {self.state.snapshot()}")
            # 実状態が届いたので、進行中の操作が収束したかを判定する（P4）
            self._check_intents()
            return

        # ⭐ 他のコントローラ（純正アプリなど）が送ったコマンドが平文で見える（C28）。
        #    器具は状態変化を自発通知しないが、コマンドは中継されてくるので、
        #    それを読んで状態に反映できる。
        if msgid in (MSGID_BRIGHT_LIGHT, MSGID_BRIGHT_LIGHT_GROUP,
                     MSGID_BRIGHT_LIGHT_NIGHT_GROUP):
            if src_vaddr != (self.own_vaddr or b""):
                self._observe_command(data, src_vaddr, msgid, params)

    # -------------------------------------------------- 他コントローラの観測

    def _observe_command(
        self, data: bytes, src_vaddr: bytes, msgid: int, params: bytes
    ) -> None:
        """他のコントローラが送った照明コマンドを読んで状態に反映する（C28）。

        コマンドの値域は状態応答とまったく同じなので、そのまま流用できる（C18-4）。
        ナイトライトだけはコマンドと器具値が逆順（器具値 = 3 - レベル。C24-5）。

        ⚠️ 同じコマンドが複数の器具から中継されて二重に届くので重複を捨てる。
        """
        now = time.monotonic()
        with self.lock:
            if self._last_observed == data and now - self._last_observed_at < 0.5:
                return  # 中継による重複
            self._last_observed, self._last_observed_at = data, now

        color_code = bright_code = night_code = None
        group: int | None = None

        if msgid == MSGID_BRIGHT_LIGHT and len(params) >= 3:
            # 0xC0: [0]=サブコマンド、サブ 0 なら [1]=色温度 [2]=明るさ、
            #       サブ 1 なら [2]=ナイトライトのレベル
            if params[0] == 0x00:
                color_code, bright_code, night_code = params[1], params[2], 0
            elif params[0] == 0x01:
                # ナイトライトを点けると主灯は消える（実測。C24-5）
                night_code = max(0, 3 - params[2])
                color_code = bright_code = CODE_OFF
        elif msgid == MSGID_BRIGHT_LIGHT_GROUP and len(params) >= 9:
            # 0xC1: [0]=色温度 [1]=明るさ … [8]=グループ番号
            color_code, bright_code, night_code, group = params[0], params[1], 0, params[8]
        elif msgid == MSGID_BRIGHT_LIGHT_NIGHT_GROUP and len(params) >= 9:
            # 0xC5: [1]=ナイトライトのレベル … [8]=グループ番号
            night_code, group = max(0, 3 - params[1]), params[8]
            color_code = bright_code = CODE_OFF  # 主灯は消える
        else:
            return

        targets = [
            d for d in self.devices.values()
            if group is None or d.group_id is None or d.group_id == group
        ]
        what = []
        if color_code is not None and bright_code is not None:
            self.state.apply_status(color_code, bright_code)
            what.append(f"色温度/明るさ {color_code:02X} {bright_code:02X}")
        if night_code is not None:
            what.append(f"ナイト {night_code}")
        for d in targets:
            d.apply_status(color_code, bright_code, night_code)
        log(
            f"👀 他コントローラの操作を観測 src={hexs(src_vaddr)} MSGID=0x{msgid:02X}"
            f"{f' グループ {group}' if group is not None else ''}: {' / '.join(what)}"
            f" → {len(targets)} 台に反映"
        )
        # 観測値は「送られた値」なので、少し待って本当の状態を確認する（P4）
        self._schedule_confirm()

    def _schedule_confirm(self) -> None:
        """操作の直後にまとめて状態を確認する。連続操作では最後の 1 回だけ投げる。

        待ち時間は実測 RTT から決める（`confirm_delay_ms`）。
        """
        with self.lock:
            self._confirm_seq += 1
            seq = self._confirm_seq

        def fire() -> bool:
            with self.lock:
                stale = seq != self._confirm_seq
            if not stale and self.connected:
                self.request_status(kind="confirm")
            return False

        GLib.timeout_add(int(self.confirm_delay_ms()), fire)

    def _note_peer(self, options) -> str | None:
        """書き込んできた器具を D-Bus のパスから記録し、その MAC を返す。

        options["device"] は `/org/bluez/hci0/dev_EC_C5_7F_81_DE_CD` の形。
        受信復号の鍵は**リンク単位**（＝この MAC 単位）なので、
        どの器具から来た書き込みかを必ず押さえておく（C23-3）。
        """
        try:
            path = str(options.get("device", ""))
        except Exception:
            return None
        mac_str = mac_from_path(path)
        if mac_str is None:
            return None
        with self.lock:
            peer = self.peers.get(mac_str)
            new = peer is None
            if new:
                self.peers[mac_str] = {
                    "mac": mac_str,
                    "first_seen": time.time(),
                    "last_seen": time.time(),
                    "writes": 1,
                }
            else:
                peer["last_seen"] = time.time()
                peer["writes"] += 1
            # 書き込みが来た = このリンクは生きている。
            # D-Bus のシグナルを取りこぼしても、ここで補える
            fresh = mac_str not in self.live_links
            self.live_links.add(mac_str)
            n = len(self.live_links)
        rec = self.metrics.link(mac_str)
        rec.writes += 1
        rec.last_rx_at = time.monotonic()
        if rec.up_at is None:
            rec.up_at = time.monotonic()
            rec.up_count += 1
        if fresh:
            self.metrics.event("link_up", mac=mac_str, links=n, via="write")
        if new:
            log(f"★ 接続してきた器具: {mac_str}（計 {len(self.peers)} 台）")
        return mac_str

    def _register_device(
        self, vaddr: bytes, mac: bytes | None, product_code: int | None
    ) -> Device:
        """器具を登録または更新する。"""
        key = vaddr.hex().upper()
        with self.lock:
            dev = self.devices.get(key)
            if dev is None:
                dev = Device(mac or bytes(6), vaddr, "")
                self.devices[key] = dev
                new = True
            else:
                new = False
                if mac:
                    dev.mac = mac
            dev.last_seen = time.time()
            if product_code is not None:
                dev.product_code = product_code
        if new:
            log(
                f"★ 器具を発見: {dev.mac_str}  vAddr={hexs(vaddr)}"
                f"  製品={dev.product_name}  （計 {len(self.devices)} 台）"
            )
        return dev

    def _handle_ping_response(self, data: bytes) -> None:
        """Ping 応答から器具を登録する（C13 / C23-4 / GetPingResponse）。

        [6..11]  器具の MAC（6 バイト）
        [12..15] 器具の vAddr（4 バイト）
        [16..17] 機種コード（`DeviceBean.version_product`。リトルエンディアン 16bit）
        [18][19] ファームウェアの major / minor

        実測（C23-4）: `A6 28 80 7F C5 EC | 01 00 00 00 | C0 52 | 01 07`
        → MAC EC:C5:7F:80:28:A6 / vAddr 1 / 機種 0x52C0 / ファーム 1.7
        """
        if len(data) < 20:
            log(f"[!] Ping 応答が短い（{len(data)} バイト）: {hexs(data)}")
            return
        mac = data[6:12]
        vaddr = data[12:16]
        product_version = data[16] | (data[17] << 8)
        version = f"0x{product_version:04X} fw{data[18]}.{data[19]}"
        key = vaddr.hex().upper()

        with self.lock:
            dev = self.devices.get(key)
            if dev is None:
                dev = Device(mac, vaddr, version)
                self.devices[key] = dev
                log(
                    f"★ 器具を発見: {dev.mac_str}  vAddr={hexs(vaddr)}  ver={version}"
                    f"  （計 {len(self.devices)} 台）"
                )
            else:
                dev.last_seen = time.time()
                dev.version = version

    # -------------------------------------------------- 送信

    def _send(self, pdu: bytes) -> bool:
        # ⚠️ 購読フラグだけを見て True を返すと「送ったのに誰も繋がっていない」
        #    ケースを成功と報告してしまう（P4 違反）
        if self.notify_chrc is None or not self.live_links:
            self.metrics.bump("send", "no_link")
            return False
        ok = self.notify_chrc.notify(pdu)
        if ok:
            self.metrics.bump("send", "pdus")
            self.metrics.bump("send", "bytes", len(pdu))
        else:
            self.metrics.bump("send", "notify_fail")
        if self.verbose:
            log(f"  >> [{len(pdu):2d}] {hexs(pdu)}{'' if ok else '  (未購読で失敗)'}")
        return ok

    def _send_encrypted(self, pdu: bytes) -> bool:
        """PDU を暗号化して送る（C23-5）。

        XOR 鍵は器具ごとに違うので、**知っている鍵ごとに 1 通ずつ**送る。
        自分の鍵で暗号化されていない PDU は、その器具では復号に失敗して捨てられる。
        """
        with self.lock:
            keys = list(self.link_keys.items())
        if not keys:
            return False
        ok = False
        for mac, key in keys:
            if self._send(encrypt_mesh_pdu(pdu, self.event_key, key)):
                ok = True
            elif self.verbose:
                log(f"     （{mac or 'MAC 不明'} 宛の暗号化送信に失敗）")
        return ok

    def _flush_pending(self) -> None:
        """接続できた瞬間に溜まっていた操作を流す（P5）。"""
        with self.lock:
            queued, self.pending = self.pending, []
        for pdu in queued:
            log(f"キューから送信: {hexs(pdu)}")
            self._send_repeated(pdu)

    def _send_repeated(self, pdu: bytes, sends: int | None = None) -> bool:
        """同じコマンドを複数回送る（P2）。絶対値指定なので冪等（P3）。

        ⚠️ 実測では 1 通あたりの到達率が 0.993（142 送信 → 141 応答/器具）で、
        3 連射は上りも下りも 3 倍にしているだけだった。既定は 1 通で足りる。
        """
        n = self.resend if sends is None else sends
        ok = False
        for _ in range(max(1, n)):
            if not self._send(pdu):
                break
            ok = True
        return ok

    def command(self, pdu: bytes, sends: int | None = None) -> tuple[bool, str]:
        """外部（HTTP）からの操作。接続がなければキューに入れる。"""
        if self.connected:
            if self._send_repeated(pdu, sends):
                return True, "sent"
            return False, "notify failed"
        with self.lock:
            self.pending.append(pdu)
        return False, "queued"

    # -------------------------------------------------- 操作 API

    def _build_light_pdus(self, color_code: int, bright_code: int, target: str) -> list[bytes]:
        """target に応じて送る PDU を組み立てる。

        target の書式:
          all         全器具を一斉に（0xC0 + チャネル 0x2A）★ 既定
          group:N     グループ N（0xC1）。**そのグループの器具にしか届かない**
          dev:<KEY>   Ping で発見した器具を個別に（0xC0 + チャネル 0x20）
        """
        src = self.own_vaddr or bytes(4)

        if target == "all":
            return [make_light_all(src, color_code, bright_code)]

        if target.startswith("group:"):
            try:
                g = int(target.split(":", 1)[1])
            except ValueError:
                return []
            return [make_group_light(src, color_code, bright_code, g)]

        if target.startswith("dev:"):
            key = target.split(":", 1)[1].upper()
            dev = self.devices.get(key)
            if dev is None:
                return []
            return [make_light_dev(dev.vaddr, src, color_code, bright_code)]

        if target == "each":
            # 発見済みの器具を 1 台ずつ個別に叩く（一斉が効かない環境向けの保険）
            return [
                make_light_dev(d.vaddr, src, color_code, bright_code)
                for d in self.devices.values()
            ]

        return []

    # -------------------------------------------------- 収束制御（P2 / P4）

    def _intent_targets(self, intent: Intent) -> list[Device]:
        """この操作が効くべき器具。"""
        if intent.target.startswith("dev:"):
            d = self.devices.get(intent.target.split(":", 1)[1].upper())
            return [d] if d else []
        if intent.target.startswith("group:"):
            try:
                g = int(intent.target.split(":", 1)[1])
            except ValueError:
                return []
            return [d for d in self.devices.values() if d.group_id == g]
        return list(self.devices.values())

    def _register_intent(self, intent: Intent) -> None:
        """新しい操作を登録し、古い操作の再送を破棄する。

        ⭐ これが無いと、明るさを連続で動かしたときに古い値が後から届いて
        明るさが跳ね返る。`docs/05-app-design.md` の要件。
        """
        drop: list[Intent] = []
        with self.lock:
            if intent.target == "all":
                # 一斉操作は個別・グループ指定の期待を全部上書きする
                drop = list(self.intents.values())
                self.intents.clear()
            else:
                old = self.intents.get(intent.target)
                if old is not None:
                    drop = [old]
            self.intents[intent.target] = intent
        for old in drop:
            if old.state == "sending":
                old.state = "superseded"
                self._clear_timers(old)
                old.done.set()
                self.metrics.bump("probe", "superseded")

    def _clear_timers(self, intent: Intent) -> None:
        """予約済みのタイマーを解放する（リークと二重発火を防ぐ）。

        ⚠️ 発火済みの ID を `source_remove` に渡すと GLib が警告を出すので、
        存在を確かめてから外す。
        """
        ctx = GLib.main_context_default()
        for tid in intent.timers:
            src = ctx.find_source_by_id(tid)
            if src is not None and not src.is_destroyed():
                GLib.source_remove(tid)
        intent.timers.clear()

    def _find_intent(self, iid: str) -> Intent | None:
        with self.lock:
            for i in self.intents.values():
                if i.id == iid:
                    return i
        return None

    def _send_intent(self, intent: Intent) -> tuple[bool, str]:
        intent.attempts += 1
        ok_all, detail = True, "sent"
        for pdu in intent.pdus:
            ok, d = self.command(pdu)
            if not ok:
                ok_all, detail = False, d
        return ok_all, detail

    def _arm_confirm(self, intent: Intent) -> None:
        """確認の状態要求を仕掛ける。再送ごとに待ちを 1.6 倍に伸ばす。"""
        delay = self.confirm_delay_ms() * (1.6 ** max(0, intent.attempts - 1))
        intent.timers.append(
            GLib.timeout_add(int(min(delay, 1500)), self._intent_confirm, intent.id)
        )

    def _intent_confirm(self, iid: str) -> bool:
        intent = self._find_intent(iid)
        if intent is None or intent.state != "sending":
            return False
        self.request_status(kind="confirm")
        # 応答の窓が閉じたころに判定する（応答が来た瞬間の早期判定もある）
        intent.timers.append(
            GLib.timeout_add(int(self.probe_window_ms()), self._intent_judge, iid)
        )
        return False

    def _intent_judge(self, iid: str) -> bool:
        intent = self._find_intent(iid)
        if intent is None or intent.state != "sending":
            return False
        if self._intent_converged(intent):
            self._finish_intent(intent, "converged")
            return False
        if intent.attempts >= intent.max_attempts or time.monotonic() > intent.deadline:
            # ⭐ 諦めたら「届かなかった」と明示する（P4）。無限再送はしない
            self._finish_intent(intent, "timeout")
            return False
        self._send_intent(intent)
        self._arm_confirm(intent)
        return False

    def _intent_converged(self, intent: Intent) -> bool:
        targets = self._intent_targets(intent)
        if not targets:
            return False  # 器具を知らないなら判定できない
        for d in targets:
            # ⚠️ 操作より前の観測で「収束した」と言ってはいけない（P4）。
            #    偶然すでに期待どおりの状態だった場合も、送った後の応答で確かめる
            if d.state_updated_at is None or d.state_updated_at < intent.created_wall:
                return False
            if not intent.matches(d):
                return False
        return True

    def _finish_intent(self, intent: Intent, state: str) -> None:
        intent.state = state
        self._clear_timers(intent)
        elapsed = (time.monotonic() - intent.created) * 1000.0
        if state == "converged":
            with self.metrics.lock:
                self.metrics.converge.add(elapsed)
                self.metrics.attempts[str(intent.attempts)] += 1
            self.metrics.event(
                "converged", intent=intent.id, ms=round(elapsed, 1),
                attempts=intent.attempts, target=intent.target, kind=intent.kind,
            )
        else:
            self.metrics.bump("probe", "unreachable")
            self.metrics.event(
                "unreachable", intent=intent.id, ms=round(elapsed, 1),
                attempts=intent.attempts, target=intent.target, kind=intent.kind,
            )
        intent.done.set()
        with self.lock:
            if self.intents.get(intent.target) is intent:
                self.intents.pop(intent.target, None)

    def _check_intents(self) -> None:
        """状態が更新されたので収束を判定する（応答が来た瞬間に呼ばれる）。"""
        with self.lock:
            active = [i for i in self.intents.values() if i.state == "sending"]
        for intent in active:
            if self._intent_converged(intent):
                self._finish_intent(intent, "converged")

    def _run_intent(self, intent: Intent, wait_ms: int = 0) -> tuple[bool, str]:
        self._register_intent(intent)
        ok, detail = self._send_intent(intent)
        if not ok:
            # 未接続ならキューに入っている。収束は次の接続後に確かめる
            self._clear_timers(intent)
            with self.lock:
                if self.intents.get(intent.target) is intent:
                    self.intents.pop(intent.target, None)
            return ok, detail
        self._arm_confirm(intent)
        if wait_ms > 0:
            if intent.done.wait(wait_ms / 1000.0):
                return intent.state == "converged", intent.state
            return False, "pending"
        return True, "sent"

    # -------------------------------------------------- 操作 API

    def set_on(self, on: bool, target: str = "all", wait_ms: int = 0) -> tuple[bool, str]:
        code = CODE_ON if on else CODE_OFF
        pdus = self._build_light_pdus(code, code, target)
        if not pdus:
            return False, f"unknown target: {target}"
        self.state.note_command(on=on, bright=None, color=None)
        return self._run_intent(
            Intent(
                target,
                pdus,
                "on" if on else "off",
                deadline_ms=self.deadline_ms,
                max_attempts=self.max_attempts,
            ),
            wait_ms,
        )

    def set_level(
        self, bright: int, color: int, target: str = "all", wait_ms: int = 0
    ) -> tuple[bool, str]:
        cc, bc = color_to_code(color), bright_to_code(bright)
        pdus = self._build_light_pdus(cc, bc, target)
        if not pdus:
            return False, f"unknown target: {target}"
        self.state.note_command(on=bright > 0, bright=bright, color=color)
        return self._run_intent(
            Intent(
                target,
                pdus,
                "level",
                color_code=cc,
                bright_code=bc,
                deadline_ms=self.deadline_ms,
                max_attempts=self.max_attempts,
            ),
            wait_ms,
        )

    def set_night(
        self, level: int, target: str = "all", wait_ms: int = 0
    ) -> tuple[bool, str]:
        """ナイトライト（常夜灯）にする（C24）。

        レベルは 0 / 1 / 2 の 3 段階で 0 が最も明るい。
        ⚠️ 専用ナイトライトは天井灯タイプ（`isCeilingLight`）だけが対応する。
        非対応の器具では純正アプリも「明るさコード 17〜19（15/10/5%）」で代用しており、
        それは `/level?bright=15` などで同じことができる。
        """
        if level not in (0, 1, 2):
            return False, "level は 0 / 1 / 2 のいずれか"
        src = self.own_vaddr or bytes(4)

        if target == "all":
            pdus = [make_night_dev(BROADCAST_VADDR, src, level)]
        elif target.startswith("group:"):
            try:
                g = int(target.split(":", 1)[1])
            except ValueError:
                return False, f"unknown target: {target}"
            pdus = [make_night_group(src, level, g)]
        elif target.startswith("dev:"):
            dev = self.devices.get(target.split(":", 1)[1].upper())
            if dev is None:
                return False, f"unknown device: {target}"
            pdus = [make_night_dev(dev.vaddr, src, level)]
        elif target == "each":
            pdus = [make_night_dev(d.vaddr, src, level) for d in self.devices.values()]
        else:
            return False, f"unknown target: {target}"

        if not pdus:
            return False, "no devices"
        # ナイトライト時は主灯が消える（C24-5）
        self.state.note_command(on=False, bright=None, color=None)
        # 器具が返す値はコマンドと逆順（3 - レベル。C24-6）
        return self._run_intent(
            Intent(
                target,
                pdus,
                "night",
                night_code=max(0, 3 - level),
                deadline_ms=self.deadline_ms,
                max_attempts=self.max_attempts,
            ),
            wait_ms,
        )

    def discover(self) -> tuple[bool, str]:
        """器具を探索する。応答で self.devices が埋まる。

        MSGID 0x02（自己申告要求）と 0xD0 01（グループ ID 要求）を投げる。
        """
        if self.own_vaddr is None:
            return False, "not joined"
        log("器具を探索（MSGID 0x02 / 0xD0）")
        ok1, d1 = self.command(make_get_product_id(self.own_vaddr))
        ok2, _ = self.command(make_get_group_id(self.own_vaddr))
        return (ok1 and ok2), d1

    def ping_all(self) -> tuple[bool, str]:
        """Ping（チャネル 0xFE）を暗号化して送る（C23-5）。

        純正アプリはここを暗号化して送っていた。応答（MAC + vAddr + 機種）も
        暗号化されて返るが、C23 で復号できる。
        """
        if self.own_vaddr is None:
            return False, "not joined"
        pdu = make_ping_all(self.own_vaddr)
        if self.link_keys:
            log("Ping を暗号化して送信（チャネル 0xFE）")
            for _ in range(self.resend):
                if not self._send_encrypted(pdu):
                    return False, "notify failed"
            return True, "sent"
        log("[!] 器具鍵が未取得のため Ping を平文で送信（応答は期待できない）")
        return self.command(pdu)

    # -------------------------------------------------- 状態要求と計測

    def confirm_delay_ms(self) -> float:
        """コマンド → 確認の状態要求までの待ち（ms）。

        ⭐ 実測 RTT の p90 の 2 倍を使う（下限 200 / 上限 800）。
        固定 1500 ms は実測 p90（115〜137 ms）の 11 倍で、無駄に遅かった。
        """
        if self.confirm_delay > 0:
            return self.confirm_delay * 1000.0
        return min(800.0, max(200.0, self.metrics.rtt_p90() * 2))

    def probe_window_ms(self) -> float:
        """1 回の状態要求で応答を待つ窓（ms）。RTT の p90 の 4 倍。"""
        return min(2500.0, max(500.0, self.metrics.rtt_p90() * 4))

    def _open_probe(self, kind: str, expect: set[str], sends: int) -> StatusProbe:
        """状態要求の追跡を始める。

        ⚠️ 状態要求にはシーケンス番号が無いので、**in-flight を 1 本に制限**して
        応答を直近の要求に対応づける。前の要求が残っていればここで締める。
        """
        self._close_probe()
        window = self.probe_window_ms()
        p = StatusProbe(kind, expect, sends, window)
        self.probe = p
        self.metrics.bump("probe", "opened")
        GLib.timeout_add(int(window), self._close_probe_cb, p.id)
        return p

    def _close_probe_cb(self, probe_id: str) -> bool:
        p = self.probe
        if p is not None and p.id == probe_id:
            self._close_probe()
        return False

    def _close_probe(self) -> None:
        """窓が閉じた要求を締め、未応答を miss として到達率に反映する。"""
        p, self.probe = self.probe, None
        if p is None:
            return
        for key in p.expect:
            ok = key in p.first
            self.metrics.note_delivery(key, ok)
            if not ok:
                self.metrics.event("miss", vaddr=key, kind=p.kind, sends=p.sends)
        self.metrics.bump("probe", "closed")
        if p.dups:
            self.metrics.bump("probe", "dups", sum(p.dups.values()))

        # ⭐ 誰も答えないなら入口が死んでいる疑い（GATT リンクは生きていても
        #    メッシュから外れていればコマンドは通らない）
        if not p.expect:
            return
        if p.first:
            self.dead_streak = 0
            return
        self.dead_streak += 1
        self.metrics.event(
            "no_response", kind=p.kind, streak=self.dead_streak, expect=len(p.expect)
        )
        if self.dead_streak >= self.dead_after:
            self._handle_dead_link()

    def _handle_dead_link(self) -> None:
        """状態要求に連続して誰も答えないので、リンクを作り直す。

        BLE のリンク層は無通信でも維持される（実測: 55 分沈黙後も健全だった）。
        だが「メッシュとして機能しているか」は別問題で、
        GATT リンクが生きたままコマンドが通らない状態はありうる。
        切ってしまえば広告の受け付けが再開され、器具が繋ぎ直してくる。
        """
        with self.lock:
            macs = list(self.live_links)
            self.dead_streak = 0
            self.joined = False
            self.own_vaddr = None
            self.primary_mac = None
        self.metrics.event("dead_link", macs=",".join(macs) or "none")
        log(f"[!] 状態要求に {self.dead_after} 回連続で無応答 → リンクを作り直します")
        for mac in macs:
            if self.disconnect_cb:
                self.disconnect_cb(mac)
        self.want_adv(True, "dead_link")

    def _poll_tick(self) -> bool:
        """定期的に状態を要求して、健全性と状態の新鮮さを保つ。

        ⚠️ 実測では 55 分間まったく通信しなくてもリンクは維持された。
        つまり黙っていても切れはしないが、**死んでいることにも気づけない。**
        低頻度（既定 60 秒）で聞いておけば、
        入口の死亡・他コントローラの操作の取りこぼし・RTT の変化を拾える。
        """
        if self.connected and not self.intents:
            self.request_status(kind="poll")
        return True

    def request_status(
        self, target: str | None = None, kind: str = "manual", sends: int | None = None
    ) -> tuple[bool, str]:
        """状態を要求する。器具個別の vAddr 宛に送る必要がある（C15-6）。"""
        if self.own_vaddr is None:
            return False, "not joined"
        if target and target.startswith("dev:"):
            dev = self.devices.get(target.split(":", 1)[1].upper())
            if dev is None:
                return False, f"unknown device: {target}"
            expect, pdu = {dev.key}, make_status_request(self.own_vaddr, dev.vaddr)
        else:
            # ⭐ dst = FF FF FF FF・チャネル 0x20 で送ると **1 通で全器具が応答する**
            #    （実測。チャネル 0x2A では無応答だった。C23-8）
            expect, pdu = set(self.devices), make_status_request(self.own_vaddr)
        n = self.resend if sends is None else sends
        self._open_probe(kind, expect, n)
        return self.command(pdu, sends=n)

    def send_raw(self, pdu: bytes, encrypt: bool = False) -> tuple[bool, str]:
        """任意の PDU をそのまま送る（プロトコル調査用）。

        `POST /raw?pdu=03FFFFFFFF2A...&encrypt=1`
        ⚠️ 解析用の裏口。器具に未知のコマンドを投げられるので通常運用では使わない。
        """
        if not self.connected:
            return False, "not connected"
        if not pdu:
            return False, "empty pdu"
        log(f"[probe] {'暗号化して' if encrypt else '平文で'}送信: {hexs(pdu)}")
        if encrypt:
            return (self._send_encrypted(pdu), "sent") if self.link_keys else (False, "no link key")
        return (self._send(pdu), "sent")

    def set_verbose(self, on: bool) -> tuple[bool, str]:
        """受信 PDU の全ログを実行中に切り替える（調査用）。"""
        self.verbose = on
        log(f"[probe] verbose = {on}")
        return True, f"verbose={on}"

    def info(self) -> dict:
        return {
            "connected": self.connected,
            "joined": self.joined,
            "own_vaddr": hexs(self.own_vaddr) if self.own_vaddr else None,
            "device_num": self.device_num,
            "devices_found": len(self.devices),
            "devices": [d.to_dict() for d in self.devices.values()],
            # 接続してきた器具（GATT のリンク単位）
            "peers_found": len(self.peers),
            "peers": sorted(self.peers.values(), key=lambda p: p["mac"]),
            # C23: 受信復号の状況
            "crypto": {
                "login_reply": self.login_reply,
                "link_keys": {m or "(mac unknown)": hexs(k) for m, k in self.link_keys.items()},
                "decrypted": self.decrypt_ok,
                "decrypt_failed": self.decrypt_fail,
                "segments_assembled": self.segment_ok,
                "segments_dropped": self.segment_drop,
            },
            "join_count": self.join_count,
            # ⭐ リンクの権威は Device1.Connected。継続秒はその記録から取る
            #    （以前は StartNotify のたびに上書きされる値を返していた）
            "live_links": sorted(self.live_links),
            "primary_mac": self.primary_mac,
            "link_held_sec": (
                self.metrics.link(self.primary_mac).held_sec if self.primary_mac else None
            ),
            "adv_addr": self.adv.addr_str if self.adv else None,
            "adv_wanted": self.adv_wanted,
            "link_policy": self.link_policy,
            "tuning": {
                "resend": self.resend,
                "confirm_delay_ms": round(self.confirm_delay_ms(), 1),
                "probe_window_ms": round(self.probe_window_ms(), 1),
                "rtt_p90_ms": round(self.metrics.rtt_p90(), 1),
                "worst_delivery": round(self.metrics.worst_delivery(), 4),
                "dup_window_sec": self.dup_window,
            },
            "queued": len(self.pending),
            # 進行中の操作（期待状態と試行回数）
            "intents": [i.to_dict() for i in list(self.intents.values())],
            "state": self.state.snapshot(),
            "uptime_sec": round(time.monotonic() - START, 1),
        }


# ------------------------------------------------------------------ HTTP


class Handler(BaseHTTPRequestHandler):
    daemon_ref: Daemon = None  # type: ignore[assignment]

    def log_message(self, fmt, *args):  # アクセスログは自前の log に寄せる
        log(f"HTTP {self.address_string()} {fmt % args}")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _result(self, ok: bool, detail: str) -> None:
        d = self.daemon_ref
        # P4: 確認できていないことを「成功」と言わない
        if ok:
            code = 200
        elif detail == "queued":
            code = 503  # 未接続。キューに保持して接続時に流す
        elif detail in ("pending", "timeout"):
            code = 504  # 送ったが期待どおりの状態を確認できなかった
        else:
            code = 500
        self._json(code, {"ok": ok, "detail": detail, **d.info()})

    def do_GET(self):
        d = self.daemon_ref
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/info"):
            self._json(200, d.info())
        elif u.path == "/devices":
            self._json(
                200,
                {
                    "device_num": d.device_num,
                    "peers_found": len(d.peers),
                    "peers": sorted(d.peers.values(), key=lambda p: p["mac"]),
                    "devices_found": len(d.devices),
                    "devices": [x.to_dict() for x in d.devices.values()],
                    "note": (
                        "peers = GATT で接続してきた器具（リンク単位）。"
                        "devices = 探索・状態応答から作る一覧。応答は暗号化されているが"
                        "復号して読んでいる（docs C23）"
                    ),
                },
            )
        elif u.path == "/metrics":
            # 計測値。RTT 分布・到達率・リンク寿命・切断理由をここで見る
            self._json(200, d.metrics.snapshot())
        elif u.path == "/events":
            try:
                since = float(q.get("since", ["0"])[0])
            except ValueError:
                since = 0.0
            self._json(
                200,
                {
                    "events": d.metrics.recent_events(since, q.get("kind", [None])[0]),
                    "now": time.time(),
                },
            )
        elif u.path == "/status":
            # 要求を投げてから現在のキャッシュを返す
            d.request_status(q.get("target", [None])[0])
            self._json(200, d.info())
        elif u.path in ("/on", "/off", "/level", "/night", "/discover", "/ping",
                        "/raw", "/verbose"):
            # ブラウザや curl で GET してしまったときに 404 だと原因が分からない
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "error": "method not allowed",
                        "hint": f"POST を使ってください: curl -X POST '{u.path}?...'",
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
            )
        else:
            self._json(
                404,
                {
                    "error": "not found",
                    "paths": ["/", "/info", "/devices", "/status", "/metrics", "/events"],
                },
            )

    def do_POST(self):
        d = self.daemon_ref
        u = urlparse(self.path)
        q = parse_qs(u.query)

        def qint(name: str, default: int) -> int:
            try:
                return int(q.get(name, [default])[0])
            except (TypeError, ValueError):
                return default

        target = q.get("target", ["all"])[0]

        # ?wait=1 のときだけ収束を待って返す。既定は即応答（5〜8 ms を維持）
        wait_ms = (
            qint("timeout", 1500)
            if q.get("wait", ["0"])[0] in ("1", "true", "yes")
            else 0
        )

        if u.path == "/on":
            self._result(*d.set_on(True, target, wait_ms))
        elif u.path == "/off":
            self._result(*d.set_on(False, target, wait_ms))
        elif u.path == "/level":
            self._result(
                *d.set_level(qint("bright", 60), qint("color", 50), target, wait_ms)
            )
        elif u.path == "/night":
            self._result(*d.set_night(qint("level", 0), target, wait_ms))
        elif u.path == "/raw":
            # 調査用: 任意 PDU を送る。?pdu=<hex>&encrypt=1
            try:
                pdu = bytes.fromhex(q.get("pdu", [""])[0].replace(" ", ""))
            except ValueError:
                self._json(400, {"error": "pdu は 16 進で指定してください"})
                return
            self._result(*d.send_raw(pdu, q.get("encrypt", ["0"])[0] == "1"))
        elif u.path == "/verbose":
            self._result(*d.set_verbose(q.get("on", ["1"])[0] == "1"))
        elif u.path == "/status":
            self._result(*d.request_status(q.get("target", [None])[0]))
        elif u.path == "/discover":
            self._result(*d.discover())
        elif u.path == "/ping":
            self._result(*d.ping_all())
        else:
            self._json(404, {"error": "not found"})


# ------------------------------------------------------------------ main


def find_adapter(bus) -> str:
    om = dbus.Interface(bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
    for path, ifaces in om.GetManagedObjects().items():
        if GATT_MGR_IFACE in ifaces:
            return path
    raise RuntimeError("GattManager1 を持つアダプタがありません")


def disconnect_stale_links(bus) -> int:
    """起動時に残っている LE 接続を切る（C32）。

    ⚠️ **プロセスが終了しても BlueZ は ACL リンクを保持し続ける。**
    器具から見ると「まだ繋がっている」ので再接続してこず、
    新しいプロセスの GATT サーバには誰も購読しに来ない状態で固まる。
    起動時に必ず掃除する。
    """
    om = dbus.Interface(bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
    n = 0
    for path, ifaces in om.GetManagedObjects().items():
        info = ifaces.get("org.bluez.Device1")
        if not info or not info.get("Connected"):
            continue
        addr = str(info.get("Address", "?"))
        try:
            dbus.Interface(bus.get_object(BLUEZ, path), "org.bluez.Device1").Disconnect()
            log(f"起動時に残っていた接続を切断: {addr}")
            n += 1
        except Exception as e:
            log(f"[!] {addr} の切断に失敗: {e}")
    if n:
        time.sleep(1.0)  # 切断が反映されるのを待つ
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description="ODELIC 照明制御デーモン")
    ap.add_argument("--id", required=True, help="アプリ表示の 8 桁 ID（例 12345678）")
    ap.add_argument("--port", type=int, default=8080, help="HTTP ポート（既定 8080）")
    ap.add_argument("--bind", default="0.0.0.0", help="待ち受けアドレス")
    ap.add_argument("--group", type=int, default=0, help="操作対象のグループ番号")
    ap.add_argument(
        "--resend",
        type=int,
        default=1,
        help="1 操作あたりの送信回数（既定 1）。"
        "⭐ 実測の到達率は 1 通で 0.993（142 送信 → 141 応答/器具）なので 1 で足りる。"
        "3 連射は上りも下りも 3 倍にするだけだった",
    )
    ap.add_argument(
        "--link-policy",
        choices=["single", "multi"],
        default="single",
        help="リンクの方針。single=参加したら広告を止めて主リンク 1 本を維持（既定）"
        " / multi=広告を出し続けて複数リンクを狙う。"
        "⚠️ multi は実測で不安定（新リンクが確立するたびに器具が古いリンクを切る）",
    )
    ap.add_argument(
        "--confirm-delay",
        type=float,
        default=0.0,
        help="操作後に状態を確認するまでの秒数。0 なら実測 RTT の p90 × 2 から自動（既定）",
    )
    ap.add_argument(
        "--dup-window",
        type=float,
        default=0.4,
        help="同じ受信 PDU を重複と見なす窓（秒・既定 0.4）",
    )
    ap.add_argument(
        "--poll-interval",
        type=int,
        default=60,
        help="この秒数ごとに状態を要求して健全性を確かめる（0 で無効・既定 60）。"
        "リンクは無通信でも維持されるが、死んでいることに気づけないため",
    )
    ap.add_argument(
        "--dead-after",
        type=int,
        default=3,
        help="状態要求に全器具が連続して無応答だった回数。"
        "この回数に達したらリンクを作り直す（既定 3）",
    )
    ap.add_argument(
        "--addr-file",
        default="/var/lib/odelicd/adv_addr",
        help="広告アドレスの保存先。器具が記憶するので固定して使い回す（C19-7）",
    )
    ap.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="送受信した PDU をすべてログに出す（プロトコル調査用）",
    )
    ap.add_argument(
        "--set-link",
        choices=["never", "auto", "always"],
        default="never",
        help="SET_LINK (01 10) を送る条件。never=送らない（純正アプリの主リンクと同じ・既定）"
        " / auto=2 台目以降の WELCOME にだけ / always=毎回（C19-8 の従来動作）",
    )
    ap.add_argument(
        "--no-login-reply",
        action="store_true",
        help="PERIPHERAL_LOGIN に応答しない（C19-2 の従来動作）。"
        "既定では純正アプリと同じ正しい応答を返す（C23-2）",
    )
    ap.add_argument(
        "--ctrl-id-file",
        default="/var/lib/odelicd/ctrl_id",
        help="AD に入れるコントローラ識別子の保存先。純正アプリも疑似 MAC を"
        "永続化して使い続ける（C31）",
    )
    ap.add_argument(
        "--id-from-addr",
        action="store_true",
        help="AD の識別子に広告アドレスをそのまま使う（従来動作）。"
        "識別子とアドレスを分離せずに比べたいときだけ",
    )
    ap.add_argument(
        "--rotate-what",
        choices=["addr", "id", "both"],
        default="addr",
        help="接続が来ないときに変えるもの（既定 addr）。"
        "器具がどちらを見て「既知のコントローラ」と判断しているかの検証用（C31）",
    )
    ap.add_argument(
        "--rotate-after",
        type=int,
        default=300,
        help="この秒数まったく接続が来なければ広告アドレスを変える（0 で無効・既定 300）。"
        "⭐ 通常は不要。器具はアドレスを記憶していない（C31 の再検証で判明）。"
        "再接続してこない真因は**古い ACL リンクが残っていること**で、"
        "起動時の掃除（C32）で解決する。これは最後の保険",
    )
    args = ap.parse_args()

    try:
        homeid, password = parse_display_id(args.id)
    except ValueError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    log(f"ID {args.id} → HOMEID {hexs(homeid)} / パスワード {hexs(password)}")

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter_path = find_adapter(bus)
    props = dbus.Interface(bus.get_object(BLUEZ, adapter_path), DBUS_PROP_IFACE)
    props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))

    # ⚠️ 前のプロセスの ACL リンクが残っていると器具が再接続してこない（C32）
    disconnect_stale_links(bus)

    daemon = Daemon(
        homeid,
        password,
        args.group,
        args.resend,
        verbose=args.verbose,
        login_reply=not args.no_login_reply,
        set_link=args.set_link,
        link_policy=args.link_policy,
        confirm_delay=args.confirm_delay,
        dup_window=args.dup_window,
    )
    log(
        f"鍵を導出: LOGINKEY {hexs(daemon.login_key)} / EVENTKEY {hexs(daemon.event_key)}"
        f"  ログイン応答={'する' if daemon.login_reply else 'しない'}"
        f"  SET_LINK={daemon.set_link}"
    )
    app = Application(bus, daemon)
    daemon.notify_chrc = app.notify_chrc

    try:
        addr = load_or_create_addr(args.addr_file)
    except OSError as e:
        log(f"[!] アドレスを保存できません（{e}）。一時的なアドレスを使います")
        rnd = bytearray(os.urandom(6))
        rnd[5] |= 0xC0
        addr = bytes(rnd)
    ctrl_id = None
    if not args.id_from_addr:
        try:
            ctrl_id = load_or_create_ctrl_id(args.ctrl_id_file)
        except OSError as e:
            log(f"[!] コントローラ識別子を保存できません（{e}）。一時的な値を使います")
            ctrl_id = new_ctrl_id()
    daemon.adv = RawAdvertiser(
        adapter_path.rsplit("/", 1)[-1], homeid, addr, ctrl_id
    )
    log(
        f"広告アドレス {daemon.adv.addr_str} / "
        f"コントローラ識別子 {daemon.adv.ctrl_id_str}"
        f"{'（アドレスを流用）' if args.id_from_addr else ''}"
    )
    daemon.dead_after = args.dead_after
    log(
        f"リンク方針={daemon.link_policy}  送信回数={daemon.resend}  "
        f"確認待ち={'自動' if daemon.confirm_delay <= 0 else f'{daemon.confirm_delay}s'}  "
        f"定期確認={args.poll_interval}s  無応答許容={args.dead_after} 回"
    )

    # ⭐ リンク状態の権威は `Device1.Connected`。
    #    BlueZ 5.82 は切断時に StopNotify をほぼ呼ばないので、これを購読しないと
    #    切断に気づけない（実測: 24 時間で確立 50 回に対し切断 2 回しか記録されていなかった）
    def on_props_changed(interface, changed, _invalidated, path=None):
        if str(interface) != "org.bluez.Device1" or "Connected" not in changed:
            return
        mac = mac_from_path(str(path))
        if mac is None:
            return
        if bool(changed["Connected"]):
            daemon.on_device_connected(mac)
        else:
            daemon.on_device_disconnected(mac)

    def on_iface_removed(path, interfaces):
        if "org.bluez.Device1" not in [str(i) for i in interfaces]:
            return
        mac = mac_from_path(str(path))
        if mac:
            daemon.on_device_disconnected(mac, "removed")

    bus.add_signal_receiver(
        on_props_changed,
        dbus_interface=DBUS_PROP_IFACE,
        signal_name="PropertiesChanged",
        arg0="org.bluez.Device1",
        path_keyword="path",
    )
    bus.add_signal_receiver(
        on_iface_removed, dbus_interface=DBUS_OM_IFACE, signal_name="InterfacesRemoved"
    )

    def disconnect_device(mac: str) -> None:
        """余剰リンクを切る。`01 15 55` は全リンクに飛ぶので使えない（C33）。"""
        path = f"{adapter_path}/dev_" + mac.replace(":", "_")
        try:
            # ⚠️ 同期呼び出しは実測 2.6 秒ブロックし、その間 GATT の応答が止まって
            #    主リンクまで巻き込んで切れた。必ず非同期で呼ぶ
            dbus.Interface(bus.get_object(BLUEZ, path), "org.bluez.Device1").Disconnect(
                reply_handler=lambda: log(f"余剰リンクを切断: {mac}"),
                error_handler=lambda e: log(f"[!] {mac} の切断に失敗: {e}"),
            )
        except Exception as e:
            log(f"[!] {mac} の切断を要求できません: {e}")

    daemon.disconnect_cb = disconnect_device

    gatt_mgr = dbus.Interface(bus.get_object(BLUEZ, adapter_path), GATT_MGR_IFACE)
    loop = GLib.MainLoop()

    def on_registered():
        log("GATT サーバ登録 OK（FFD0 / FFD1 / FFD2）")
        if not daemon.adv.start():
            log("[エラー] アドバタイズを開始できませんでした")
            loop.quit()

    def on_error(e):
        log(f"[エラー] GATT サーバの登録に失敗: {e}")
        loop.quit()

    gatt_mgr.RegisterApplication(
        app.PATH, {}, reply_handler=on_registered, error_handler=on_error
    )

    # 広告を「望む状態」に保ち続ける。さらに長時間繋がらないときはアドレスを変える。
    state = {"last_link": time.monotonic()}

    def keepalive():
        # ⭐ ADV_IND は接続確立で自動停止するが、**BlueZ は切断のたびに勝手に
        #    再開する**（実測: 切断の 20〜30 ms 後に必ず ADV ON）。
        #    参加後に広告を止めておくには、止めたい側も打ち直す必要がある。
        #    ⚠️ 以前は `notifying` を見て早期 return していたため、
        #       最初の購読以降まったく広告を触らなくなっていた
        #    接続を受け付けたくないときも「広告は出したまま非接続可能にする」ので、
        #    どちらの状態でも Enable を打ち直せばよい（BlueZ と衝突しない）
        daemon.adv.keepalive()

        if daemon.live_links:
            state["last_link"] = time.monotonic()
            return True

        idle = time.monotonic() - state["last_link"]
        if args.rotate_after > 0 and idle > args.rotate_after:
            cur_addr, cur_id = daemon.adv.addr, daemon.adv.ctrl_id
            changed = []
            if args.rotate_what in ("addr", "both"):
                cur_addr = new_random_static_addr()
                save_addr(args.addr_file, cur_addr)
                changed.append("広告アドレス")
            if args.rotate_what in ("id", "both") and not args.id_from_addr:
                cur_id = new_ctrl_id()
                save_addr(args.ctrl_id_file, cur_id)
                changed.append("コントローラ識別子")
            log(
                f"{idle:.0f} 秒間接続がないため{' と '.join(changed)}を変更します"
                f"（器具が既知のコントローラを無視している可能性・C19-7 / C31）"
            )
            daemon.adv = RawAdvertiser(
                adapter_path.rsplit("/", 1)[-1],
                homeid,
                cur_addr,
                None if args.id_from_addr else cur_id,
            )
            daemon.adv_wanted = True
            daemon.adv.start()
            log(
                f"広告アドレス {daemon.adv.addr_str} / "
                f"コントローラ識別子 {daemon.adv.ctrl_id_str}"
            )
            state["last_link"] = time.monotonic()
        return True

    # 2 秒周期。切断から広告再開までの空白を短くするため（旧 5 秒）
    GLib.timeout_add_seconds(2, keepalive)

    # 定期的な状態確認（健全性の監視 + 状態の新鮮さ + RTT の継続計測）
    if args.poll_interval > 0:
        GLib.timeout_add_seconds(args.poll_interval, daemon._poll_tick)

    Handler.daemon_ref = daemon
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"HTTP API を開始: http://{args.bind}:{args.port}/")
    log(
        "  POST /on /off /level?bright=60&color=50 /night?level=0 /ping"
        "   GET /status /devices"
    )
    log("  対象指定: ?target=all（既定） / group:N / dev:<KEY> / each")

    try:
        loop.run()
    except KeyboardInterrupt:
        log("停止します")
    finally:
        server.shutdown()
        daemon.adv.stop()
        try:
            gatt_mgr.UnregisterApplication(app.PATH)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
