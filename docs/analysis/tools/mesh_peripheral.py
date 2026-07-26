#!/usr/bin/env python3
"""ODELIC / Pairlink メッシュに Peripheral として参加する（フェーズ P2 / P3）。

Raspberry Pi 上で実行する。公式アプリの `join_mode = 1`（Peripheral）と
同じ構成を再現する。

    [Pi]  GATT サーバ（FFD0 / FFD1 / FFD2 + CCCD）を公開
          + ADV_PHONE ビーコンを送信
            ↓
    [器具] Pi に GATT 接続してくる
            ↓
          FFD1 に Write でメッシュ制御コマンドを送ってくる
            ↓
    [Pi]  FFD2 の Notification で応答・コマンド送信

プロトコルの根拠は docs/02-protocol.md の C6 / C15 / C16 / C17 / C18。

使い方:

    # まず観測だけ（何も送らない）。器具が接続してくるか確認する
    sudo python3 mesh_peripheral.py --id 12345678

    # 参加できたら状態要求を送る（最も安全な最初の一手）
    sudo python3 mesh_peripheral.py --id 12345678 --send status

    # 点灯・消灯
    sudo python3 mesh_peripheral.py --id 12345678 --send on
    sudo python3 mesh_peripheral.py --id 12345678 --send off

    # 明るさ 60% / 色温度 50%
    sudo python3 mesh_peripheral.py --id 12345678 --send level --bright 60 --color 50

★ 認証について（docs/02-protocol.md C19-2 で実機確認）

    PERIPHERAL_LOGIN（`01 19` + 16 バイトのチャレンジ）には**応答しない**のが正解。
    誤った応答を返すと器具が StopNotify して切断する。無応答なら WELCOME が返り、
    メッシュに参加できる。認証は GET_PASSWORD に平文パスワードを返すだけ。
    このスクリプトは既定で応答しない（`--answer-login` で従来の挙動に戻せる）。

⚠️ グループ設定・シーン登録・器具登録の初期化は**送らない**。
   このスクリプトは 0xC0 / 0xC1（明るさ・色温度）と 0x70（状態要求）しか送らない。
"""

from __future__ import annotations

import argparse
import os
import struct
import subprocess
import sys
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

# ------------------------------------------------------------------ 定数

BLUEZ = "org.bluez"
ADAPTER_IFACE = "org.bluez.Adapter1"
LE_ADV_MGR_IFACE = "org.bluez.LEAdvertisingManager1"
LE_ADV_IFACE = "org.bluez.LEAdvertisement1"
GATT_MGR_IFACE = "org.bluez.GattManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"

# docs/02-protocol.md C17-1（スマホが Peripheral のときの UUID）
UUID_SERVICE = "0000ffd0-0000-1000-8000-00805f9b34fb"
UUID_WRITE = "0000ffd1-0000-1000-8000-00805f9b34fb"
UUID_NOTIFY = "0000ffd2-0000-1000-8000-00805f9b34fb"

# C3 / C17-3: アドバタイズのマジックと種別
PAIRLINK_COMPANY_ID = 0x0000
ADV_MAGIC = bytes([0xC0, 0xFF])
ADV_PHONE = 0x05

# C5: PDU タイプ
PDU_CMD = 0x01
PDU_RESPONSE = 0x02
PDU_DATA_EVENT = 0x03
PDU_MESH_EVENT = 0x04
PDU_ENCRYPTED = 0x06  # C18-3 で見つかった未知のタイプ

# C9: メッシュ制御コマンド
CMD_GET_PASSWORD = 0x00
CMD_WELCOME = 0x01
CMD_BROADCAST_MESHINFO = 0x02
CMD_GET_VIRTUAL_ADDR = 0x0A
CMD_SET_LINK = 0x10
CMD_PERIPHERAL_LOGIN = 0x19
CMD_UNKNOWN_18 = 0x18

CMD_NAMES = {
    0x00: "GET_PASSWORD",
    0x01: "WELCOME",
    0x02: "BROADCAST_MESHINFO",
    0x03: "SET_MESH",
    0x0A: "GET_VIRTUAL_ADDR",
    0x10: "SET_LINK",
    0x16: "CENTRAL_LOGIN",
    0x18: "UNKNOWN_18",
    0x19: "PERIPHERAL_LOGIN",
    0x22: "SET_MESH_ENCRY",
}

# C8: データチャネル
CH_TOLIGHT = 0x20
CH_TOLIGHT_2A = 0x2A

# C7: 照明制御の MSGID（送るのはこの 3 つだけ）
MSGID_BRIGHT_LIGHT = 0xC0
MSGID_BRIGHT_LIGHT_GROUP = 0xC1
MSGID_SM_STATUS = 0x70

# C15-7: ON / OFF は値域外の状態コード
CODE_ON = 0x37  # 55
CODE_OFF = 0x32  # 50

BROADCAST_VADDR = bytes([0xFF, 0xFF, 0xFF, 0xFF])

START = time.monotonic()


def log(msg: str) -> None:
    print(f"[{time.monotonic() - START:8.3f}] {msg}", flush=True)


def hexs(b: bytes) -> str:
    return " ".join(f"{x:02X}" for x in b)


# ------------------------------------------------------- 値エンコード (C15-9 / C18-4)


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
    """アプリ表示の 8 桁 ID を (HOMEID 4 バイト, パスワード 4 バイト) にする。

    docs/02-protocol.md C16-2:
      HOMEID   = 上位 4 桁を 10 進数として parseInt → リトルエンディアン 4 バイト
      パスワード = 下位 4 桁の ASCII そのまま
    """
    if len(display_id) != 8 or not display_id.isdigit():
        raise ValueError(f"ID は 8 桁の数字で指定してください: {display_id!r}")
    homeid = struct.pack("<I", int(display_id[:4]))
    password = display_id[4:].encode("ascii")
    return homeid, password


# ------------------------------------------------------------------ PDU 組み立て


def make_data_event(
    dst: bytes, src: bytes, msgid: int, params: bytes, channel: int = CH_TOLIGHT
) -> bytes:
    """MeshProfile.createDataEvent 相当（C6）。

    [0]      0x03
    [1..4]   宛先 vAddr
    [5]      チャネル
    [6..9]   送信元 vAddr
    [10]     MSGID
    [11..]   パラメータ（最大 9 バイト）

    ⚠️ チャネルは宛先から推論してはいけない。実機ログ（C18-4）では
    dst = FF FF FF FF でも `sendgroup` 系（0xC1）は 0x20 を使っており、
    0x2A は `setlight` 系（0xC0）をブロードキャストするときだけだった。
    呼び出し側が明示する。
    """
    if len(dst) != 4 or len(src) != 4:
        raise ValueError("vAddr は 4 バイト")
    if len(params) > 9:
        raise ValueError(f"パラメータは最大 9 バイト（{len(params)} バイト指定された）")
    return bytes([PDU_DATA_EVENT]) + dst + bytes([channel]) + src + bytes([msgid]) + params


def make_group_light(src: bytes, color_code: int, bright_code: int, group: int) -> bytes:
    """グループ宛の明るさ・色温度コマンド（C15-5 / C18-4）。

    実機ログでは MSGID 0xC1 でチャネル 0x20、宛先はブロードキャストだった。
    createDataEvent とは違い makeDataEventLocalCmd2 経由なのでチャネルを明示する。
    """
    params = bytes([color_code, bright_code]) + bytes(6) + bytes([group])
    # 実機は dst=FF FF FF FF なのにチャネル 0x20 を使っていた（C18-4）
    return (
        bytes([PDU_DATA_EVENT])
        + BROADCAST_VADDR
        + bytes([CH_TOLIGHT])
        + src
        + bytes([MSGID_BRIGHT_LIGHT_GROUP])
        + params
    )


# ------------------------------------------------------------------ D-Bus 雑務


def find_adapter(bus) -> str:
    om = dbus.Interface(bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
    for path, ifaces in om.GetManagedObjects().items():
        if LE_ADV_MGR_IFACE in ifaces and GATT_MGR_IFACE in ifaces:
            return path
    raise RuntimeError(
        "アドバタイズと GATT サーバの両方に対応するアダプタが見つかりません。"
        " `sudo btmgmt info` の supported settings に le と advertising があるか確認してください。"
    )


class RawAdvertiser:
    """ADV_PHONE ビーコンを raw HCI で送る（C3 / C17-3）。

    ⚠️ BlueZ の D-Bus 経路（LEAdvertisingManager1）は使えない。
    Raspberry Pi 3（BT 4.1）+ カーネル 6.18 では `SupportedInstances = 0` になり、
    mgmt の Add Advertising が `Invalid Parameters (0x0d)` で必ず失敗する。
    そのため HCI コマンドを直接叩く。
    """

    OGF_LE = "0x08"
    OCF_SET_RANDOM_ADDR = "0x0005"
    OCF_SET_ADV_PARAMS = "0x0006"
    OCF_SET_ADV_DATA = "0x0008"
    OCF_SET_ADV_ENABLE = "0x000a"

    def __init__(self, dev: str, homeid: bytes, mac: bytes, random_addr: bool = True):
        self.dev = dev
        self.random_addr = random_addr

        if random_addr:
            # 公式アプリは LE Set Random Address を使っている（C18-7）。
            # ランダム静的アドレス（上位 2 bit が 11）を毎回作る。
            # 器具が「一度扱ったコントローラ」を記憶している場合、
            # 新しいアドレスなら新規として扱われる可能性がある。
            rnd = bytearray(os.urandom(6))
            rnd[5] = (rnd[5] | 0xC0) & 0xFF  # MSB を 11 にしてランダム静的にする
            self.addr = bytes(rnd)  # HCI 用のリトルエンディアン順
            disp = ":".join(f"{b:02X}" for b in reversed(self.addr))
            log(f"ランダム静的アドレスを使用: {disp}")
        else:
            self.addr = bytes(reversed(mac))  # 表示順 → HCI 順
            log("公開アドレスを使用")

        # ADV_PHONE のペイロードには広告に使うアドレスを載せる
        payload = ADV_MAGIC + bytes([ADV_PHONE]) + homeid + bytes(reversed(self.addr))
        body = struct.pack("<H", PAIRLINK_COMPANY_ID) + payload
        self.ad = bytes([0x02, 0x01, 0x06, len(body) + 1, 0xFF]) + body
        if len(self.ad) > 31:
            raise ValueError(f"AD が 31 バイトを超えます: {len(self.ad)}")
        log(f"ADV ペイロード: {hexs(payload)}  （AD 全体 {len(self.ad)} バイト）")
        log(f"ADV AD: {hexs(self.ad)}")

    def _hci(self, ocf: str, params: bytes) -> bool:
        cmd = ["hcitool", "-i", self.dev, "cmd", self.OGF_LE, ocf] + [
            f"{b:02x}" for b in params
        ]
        # ⚠️ stdin を閉じないと tty のない環境で入力待ちにブロックする
        r = subprocess.run(
            cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=5
        )
        if r.returncode != 0:
            log(f"  [!] hcitool 失敗 ({ocf}): {r.stderr.strip() or r.stdout.strip()}")
            return False
        return True

    def start(self) -> bool:
        # カーネル側のアドバタイズを止めてから自前で設定する
        subprocess.run(
            ["btmgmt", "advertising", "off"],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=5,
        )
        self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x00]))

        # LE Set Random Address（広告を止めている間にしか設定できない）
        if self.random_addr and not self._hci(self.OCF_SET_RANDOM_ADDR, self.addr):
            return False

        # LE Set Advertising Parameters
        #   interval 0x00A0 = 100ms（公式アプリの ADVERTISE_MODE_LOW_LATENCY 相当）
        #   adv_type 0x00 = ADV_IND（接続可能・無指向）← 器具から接続してもらう
        #   own_addr_type 0x01 = random / 0x00 = public
        own_type = 0x01 if self.random_addr else 0x00
        params = (
            struct.pack("<HH", 0x00A0, 0x00A0)
            + bytes([0x00, own_type, 0x00])
            + bytes(6)
            + bytes([0x07, 0x00])
        )
        if not self._hci(self.OCF_SET_ADV_PARAMS, params):
            return False

        # LE Set Advertising Data: significant_length + 31 バイト固定長
        data = bytes([len(self.ad)]) + self.ad + bytes(31 - len(self.ad))
        if not self._hci(self.OCF_SET_ADV_DATA, data):
            return False

        if not self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x01])):
            return False
        log("アドバタイズ開始（raw HCI）— 器具からの接続を待ちます")
        return True

    def keepalive(self) -> None:
        """ADV_IND は接続が確立すると自動停止するので、定期的に再開する。"""
        self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x01]))

    def stop(self) -> None:
        self._hci(self.OCF_SET_ADV_ENABLE, bytes([0x00]))
        log("アドバタイズ停止")


class Characteristic(dbus.service.Object):
    def __init__(self, bus, path, uuid, flags, service_path):
        self.path = path
        self.uuid = uuid
        self.flags = flags
        self.service_path = service_path
        self.notifying = False
        self.value = dbus.Array([], signature="y")
        self.notify_started_at: float | None = None
        self.durations: list[float] = []
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
        log(f"  [GATT] ReadValue {self.uuid[4:8]} → {hexs(bytes(self.value))}")
        return self.value

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        data = bytes(value)
        self.on_write(data, options)

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True
        self.notify_started_at = time.monotonic()
        log(f"  [GATT] StartNotify {self.uuid[4:8]}  ← 器具が通知を購読した")

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False
        if self.notify_started_at is not None:
            dur = time.monotonic() - self.notify_started_at
            self.durations.append(dur)
            log(f"  [GATT] StopNotify {self.uuid[4:8]}  ← 接続の生存時間 {dur:.2f} 秒")
            self.notify_started_at = None
        else:
            log(f"  [GATT] StopNotify {self.uuid[4:8]}")

    def on_write(self, data: bytes, options) -> None:
        log(f"  [GATT] Write {self.uuid[4:8]} [{len(data)}] {hexs(data)}")

    def notify(self, data: bytes) -> bool:
        """FFD2 経由で器具へ送る（実機と同じ経路 = C18-2）。"""
        if not self.notifying:
            log(f"  [!] 未購読なので送れません: {hexs(data)}")
            return False
        self.value = dbus.Array(data, signature="y")
        self.PropertiesChanged(GATT_CHRC_IFACE, {"Value": self.value}, [])
        log(f"  >> Notify [{len(data)}] {hexs(data)}")
        return True


class MeshSession:
    """メッシュ参加の状態機械。公式アプリの process_mesh_cmd 相当（C5 / C18-3）。"""

    def __init__(
        self,
        homeid: bytes,
        password: bytes,
        answer_login: bool,
        send_set_link: bool = True,
    ):
        self.homeid = homeid
        self.password = password
        self.answer_login = answer_login
        self.send_set_link = send_set_link
        self.own_vaddr: bytes | None = None
        self.device_num: int | None = None
        self.joined = False
        self.join_count = 0
        self.notify_chrc: Characteristic | None = None
        self.seen_login_challenge: bytes | None = None
        # 接続の生存時間を測る（レイテンシ設計の根拠にする）
        self.notify_started_at: float | None = None
        self.link_durations: list[float] = []

    def handle(self, data: bytes) -> None:
        if not data:
            return
        ptype = data[0]

        if ptype == PDU_CMD:
            self._handle_cmd(data)
        elif ptype == PDU_RESPONSE:
            log(f"     RESPONSE sub=0x{data[1]:02X}" if len(data) > 1 else "     RESPONSE")
        elif ptype == PDU_DATA_EVENT:
            self._handle_data_event(data)
        elif ptype == PDU_ENCRYPTED:
            log(f"     type 0x06（暗号化ラッパー）: {hexs(data[1:])}")
        else:
            log(f"     未知の PDU タイプ 0x{ptype:02X}")

    def _handle_cmd(self, data: bytes) -> None:
        if len(data) < 2:
            return
        sub = data[1]
        body = data[2:]
        name = CMD_NAMES.get(sub, f"0x{sub:02X}")
        log(f"     CMD {name}  body={hexs(body)}")

        if sub == CMD_GET_PASSWORD:
            # C18-3: 器具が HOMEID を提示 → 平文パスワードを返す
            resp = bytes([PDU_RESPONSE, CMD_GET_PASSWORD]) + self.homeid + self.password
            log(f"     → GET_PASSWORD に応答（パスワードは平文）")
            self.send(resp)

        elif sub == CMD_PERIPHERAL_LOGIN:
            self.seen_login_challenge = body
            if not self.answer_login:
                # ★ 実機検証の結論（docs/02-protocol.md C19-2）:
                #   誤った応答を返すと器具が StopNotify して切断する。
                #   無応答なら次の GET_PASSWORD へ進み、参加できる。
                log("     → 応答しない（正解。誤答すると切断される）")
                return
            log("     → エコーバックを試行（--answer-login。器具に拒否される見込み）")
            self.send(bytes([PDU_RESPONSE, CMD_PERIPHERAL_LOGIN]) + body)

        elif sub == CMD_GET_VIRTUAL_ADDR:
            # C18-3: 器具がこちらの vAddr を割り当ててくる
            if len(body) >= 4:
                self.own_vaddr = body[:4]
                log(f"     ★ own_vAddr が割り当てられた: {hexs(self.own_vaddr)}")

        elif sub == CMD_BROADCAST_MESHINFO:
            if len(body) >= 8:
                self.device_num = body[6] | (body[7] << 8)
                log(f"     ★ device_num = {self.device_num}（メッシュ内の器具台数）")
            self.joined = True
            self.join_count += 1
            # 公式アプリは参加完了の直後に SET_LINK を送っている（実機ログ +129526.7ms）。
            # これが接続維持に効いている可能性があるので同じことをする。
            if self.send_set_link:
                log("     → SET_LINK (01 10) を送信（公式アプリと同じ挙動）")
                self.send(bytes([PDU_CMD, CMD_SET_LINK]))

        elif sub == CMD_WELCOME:
            log("     ★ WELCOME を受信")
            self.joined = True

    def _handle_data_event(self, data: bytes) -> None:
        if len(data) < 11:
            log(f"     DATA_EVENT が短い: {hexs(data)}")
            return
        dst, ch, src, msgid, params = data[1:5], data[5], data[6:10], data[10], data[11:]
        log(
            f"     DATA_EVENT dst={hexs(dst)} ch=0x{ch:02X} src={hexs(src)} "
            f"MSGID=0x{msgid:02X} params={hexs(params)}"
        )
        # C15-9: 状態応答
        if msgid in (0x71, 0x35) and len(params) >= 2:
            color, bright = params[0], params[1]
            if color == CODE_OFF and bright == CODE_OFF:
                log("     ★ 状態: 消灯")
            elif color == CODE_ON and bright == CODE_ON:
                log("     ★ 状態: 点灯")
            else:
                log(
                    f"     ★ 状態: 色温度 {code_to_color(color)}% / "
                    f"明るさ {code_to_bright(bright)}%"
                )

    def send(self, data: bytes) -> bool:
        if self.notify_chrc is None:
            log(f"  [!] Notify キャラクタリスティック未登録: {hexs(data)}")
            return False
        return self.notify_chrc.notify(data)


class WriteChrc(Characteristic):
    """FFD1。器具がここに書き込んでくる（C18-2）。"""

    def __init__(self, bus, path, service_path, session: MeshSession):
        super().__init__(
            bus,
            path,
            UUID_WRITE,
            ["read", "write", "write-without-response"],
            service_path,
        )
        self.session = session

    def on_write(self, data: bytes, options) -> None:
        dev = options.get("device", "?")
        log(f"  << Write FFD1 from {dev} [{len(data)}] {hexs(data)}")
        self.session.handle(data)


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
    PATH = "/jp/calil/odelic"

    def __init__(self, bus, session: MeshSession):
        self.services: list[Service] = []
        super().__init__(bus, self.PATH)

        svc = Service(bus, self.PATH + "/service0", UUID_SERVICE)
        write = WriteChrc(bus, svc.path + "/char0", svc.path, session)
        notify = Characteristic(
            bus, svc.path + "/char1", UUID_NOTIFY, ["read", "notify"], svc.path
        )
        svc.characteristics = [write, notify]
        self.services.append(svc)
        session.notify_chrc = notify

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        out = {}
        for svc in self.services:
            out[dbus.ObjectPath(svc.path)] = svc.get_properties()
            for c in svc.characteristics:
                out[dbus.ObjectPath(c.path)] = c.get_properties()
        return out


# ------------------------------------------------------------------ main


def do_blink(session: MeshSession, args) -> bool:
    """ON → OFF → ON を続けて送る。照明が反応したか目視で判定するため。

    I1 の対策（同じコマンドを複数回送る）も兼ねて、各段を 3 回ずつ送る。
    コマンドは絶対値指定なので何度送っても結果は同じ（C15-7 / P3）。
    """
    if session.own_vaddr is None:
        log("[!] own_vAddr が未割り当て")
        return False
    src = session.own_vaddr
    steps = [("点灯", CODE_ON), ("消灯", CODE_OFF), ("点灯", CODE_ON)]

    def step(i: int) -> bool:
        if i >= len(steps):
            log("=== blink 完了 ===")
            return False
        label, code = steps[i]
        pdu = make_group_light(src, code, code, args.group)
        log(f"=== {label}（{i + 1}/{len(steps)}）: {hexs(pdu)} ===")
        for _ in range(3):  # 取りこぼし対策で 3 回送る
            if not session.send(pdu):
                break
        GLib.timeout_add(int(args.blink_interval * 1000), lambda: step(i + 1))
        return False

    GLib.timeout_add(int(args.send_delay * 1000), lambda: step(0))
    return True


def build_command(session: MeshSession, args) -> bytes | None:
    """--send で指定されたコマンドを組み立てる。"""
    if session.own_vaddr is None:
        log("[!] own_vAddr が未割り当てなのでコマンドを組み立てられません")
        return None
    src = session.own_vaddr

    if args.send == "status":
        # 実機は get_light_status(vAddr) で個別の器具宛に送っていた（C15-6）。
        # 器具の vAddr が未知なのでブロードキャストで試す。チャネルは 0x20。
        return make_data_event(
            BROADCAST_VADDR, src, MSGID_SM_STATUS, b"", channel=CH_TOLIGHT
        )
    if args.send == "on":
        return make_group_light(src, CODE_ON, CODE_ON, args.group)
    if args.send == "off":
        return make_group_light(src, CODE_OFF, CODE_OFF, args.group)
    if args.send == "level":
        return make_group_light(
            src, color_to_code(args.color), bright_to_code(args.bright), args.group
        )
    return None


def main() -> int:
    ap = argparse.ArgumentParser(
        description="ODELIC / Pairlink メッシュに Peripheral として参加する",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--id", required=True, help="アプリ表示の 8 桁 ID（例 12345678）")
    ap.add_argument(
        "--send",
        choices=("none", "status", "on", "off", "level", "blink"),
        default="none",
        help="参加後に送るコマンド（既定 none = 観測のみ）。"
        "blink = ON→OFF→ON を各 3 回。目視確認用",
    )
    ap.add_argument(
        "--blink-interval",
        type=float,
        default=2.0,
        help="blink の各段の間隔秒（既定 2.0）",
    )
    ap.add_argument("--bright", type=int, default=60, help="明るさ 0-100%%（level 用）")
    ap.add_argument("--color", type=int, default=50, help="色温度 0-100%%（level 用）")
    ap.add_argument("--group", type=int, default=0, help="グループ番号（既定 0）")
    ap.add_argument(
        "--answer-login",
        action="store_true",
        help="PERIPHERAL_LOGIN にエコーバックで応答する。"
        "★ 既定は応答しない（応答すると器具に拒否される。docs C19-2）",
    )
    ap.add_argument("--duration", type=int, default=120, help="実行秒数（既定 120）")
    ap.add_argument(
        "--send-delay",
        type=float,
        default=0.4,
        help="参加検出からコマンド送信までの待ち秒数（既定 0.4）。"
        "器具の接続は短時間で切れるので短くする",
    )
    ap.add_argument(
        "--public-addr",
        action="store_true",
        help="公開アドレスで広告する。既定はランダム静的アドレス"
        "（公式アプリの挙動に合わせる）",
    )
    ap.add_argument(
        "--repeat",
        action="store_true",
        help="参加のたびにコマンドを送る（既定は最初の 1 回だけ）",
    )
    ap.add_argument(
        "--no-set-link",
        action="store_true",
        help="参加後の SET_LINK (01 10) を送らない。"
        "既定は送る（公式アプリと同じ。接続維持に効く可能性）",
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

    try:
        adapter_path = find_adapter(bus)
    except RuntimeError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    log(f"アダプタ: {adapter_path}")

    adapter_props = dbus.Interface(
        bus.get_object(BLUEZ, adapter_path), DBUS_PROP_IFACE
    )
    adapter_props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))
    mac_str = str(adapter_props.Get(ADAPTER_IFACE, "Address"))
    mac = bytes(int(x, 16) for x in mac_str.split(":"))
    log(f"MAC: {mac_str}")

    session = MeshSession(
        homeid,
        password,
        answer_login=args.answer_login,
        send_set_link=not args.no_set_link,
    )
    app = Application(bus, session)
    adv = RawAdvertiser(
        adapter_path.rsplit("/", 1)[-1], homeid, mac, random_addr=not args.public_addr
    )

    gatt_mgr = dbus.Interface(bus.get_object(BLUEZ, adapter_path), GATT_MGR_IFACE)

    loop = GLib.MainLoop()
    state = {"sent": False}

    def on_registered():
        log("GATT サーバ登録 OK（FFD0 / FFD1 / FFD2）")
        # GATT を登録してから広告を出す。逆順だと BlueZ が広告を上書きすることがある
        if not adv.start():
            log("[エラー] アドバタイズを開始できませんでした")
            loop.quit()

    def on_error(e):
        log(f"[エラー] GATT サーバの登録に失敗: {e}")
        loop.quit()

    gatt_mgr.RegisterApplication(
        app.PATH, {}, reply_handler=on_registered, error_handler=on_error
    )

    # ADV_IND は接続確立で自動停止するので定期的に再開する
    GLib.timeout_add_seconds(5, lambda: (adv.keepalive(), True)[1])

    def tick():
        if args.send == "none" or not session.joined:
            return True
        if state["sent"] and not args.repeat:
            return True
        # --repeat のときは参加フラグを消して次の参加を待つ
        state["sent"] = True
        if args.repeat:
            session.joined = False

        if args.send == "blink":
            do_blink(session, args)
            return True

        def do_send():
            pdu = build_command(session, args)
            if pdu:
                log(f"=== コマンド送信: {args.send} ===")
                for _ in range(3):  # 取りこぼし対策（絶対値指定なので冪等）
                    if not session.send(pdu):
                        break
            return False

        GLib.timeout_add(int(args.send_delay * 1000), do_send)
        return True

    GLib.timeout_add(500, tick)
    GLib.timeout_add_seconds(args.duration, lambda: (loop.quit(), False)[1])

    log(f"=== 実行開始（{args.duration} 秒）===")
    try:
        loop.run()
    except KeyboardInterrupt:
        log("中断されました")

    log("=== 終了 ===")
    log(f"参加回数: {session.join_count} / own_vAddr: "
        f"{hexs(session.own_vaddr) if session.own_vaddr else '未割り当て'} / "
        f"device_num: {session.device_num}")
    durs = session.notify_chrc.durations if session.notify_chrc else []
    if durs:
        log(
            f"接続の生存時間: 最短 {min(durs):.2f} 秒 / "
            f"中央 {sorted(durs)[len(durs) // 2]:.2f} 秒 / "
            f"最長 {max(durs):.2f} 秒（{len(durs)} 回）"
        )
        log("  → 公式アプリは 60 秒以上維持していた。短ければ維持できていない")
    elif session.notify_chrc and session.notify_chrc.notifying:
        held = time.monotonic() - (session.notify_chrc.notify_started_at or 0)
        log(f"★ 終了時点でまだ接続が生きている（{held:.1f} 秒継続中）")
    if session.seen_login_challenge:
        log(f"PERIPHERAL_LOGIN のチャレンジ: {hexs(session.seen_login_challenge)}")

    adv.stop()
    try:
        gatt_mgr.UnregisterApplication(app.PATH)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
