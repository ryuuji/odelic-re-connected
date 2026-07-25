"""検証用の合成 btsnoop ログを生成する。

実機ログが手に入る前に `btsnoop.py` の動作を確かめるためのもの。
[docs/02-protocol.md](../docs/02-protocol.md) の仮説 H1（コネクションレス・
アドバタイジング方式）どおりの通信を模擬して出力する。

    python tools/synth_btsnoop.py artifacts/synth.log
    python tools/btsnoop.py summary artifacts/synth.log

⚠️ これは**架空のデータ**であり、実際の ODELIC のプロトコルではない。
パーサの動作確認と、出力の読み方を掴むためだけに使う。
"""

from __future__ import annotations

import struct
import sys

BTSNOOP_MAGIC = b"btsnoop\x00"
BTSNOOP_EPOCH_DELTA_US = 0x00DCDDB30F2F8000
DATALINK_HCI_UART_H4 = 1002

H4_CMD = 0x01
H4_ACL = 0x02
H4_EVT = 0x04

FLAG_SENT_CMD = 0x02  # bit0=0(送信) bit1=1(コマンド)
FLAG_RECV_EVT = 0x03  # bit0=1(受信) bit1=1(イベント)

# 実際の形式に合わせた値（docs/02-protocol.md C3・C16・C17）
COMPANY_ID = 0x0000  # MeshCommon.createAdvertiseData の addManufacturerData(0, ...)
PAIRLINK_MAGIC = bytes([0xC0, 0xFF])  # flow_control_enable が常に false なので C0

# HOMEID 1234（アプリの ID 表示 12345678 の上位 4 桁）をリトルエンディアン 4 バイトに
# ここは合成ログ（パーサ検証用）なので実在しないダミー値でよい
HOMEID = (1234).to_bytes(4, "little")  # D2 04 00 00
PHONE_MAC = bytes([0x1A, 0x2B, 0x3C, 0x4D, 0x5E, 0x6F])

ADV_PHONE = 0x05
ADV_CONNECTABLE = 0x82

# 照明制御 PDU（DATA_EVENT）で使う値
OWN_VADDR = bytes([0x11, 0x22, 0x33, 0x44])
BROADCAST_VADDR = bytes([0xFF, 0xFF, 0xFF, 0xFF])
MSGID_BRIGHT_LIGHT = 0xC0
MSGID_BRIGHT_LIGHT_GROUP = 0xC1
CHANNEL_TOLIGHT = 0x20
CHANNEL_TOLIGHT_2A = 0x2A

AD_FLAGS = bytes([0x02, 0x01, 0x06])


class LogWriter:
    def __init__(self) -> None:
        self.records: list[bytes] = []
        self.t_us = 0  # ログ先頭からの相対時刻

    def advance(self, ms: float) -> None:
        self.t_us += int(ms * 1000)

    def _write(self, h4_type: int, payload: bytes, flags: int) -> None:
        data = bytes([h4_type]) + payload
        ts = BTSNOOP_EPOCH_DELTA_US + 1_753_000_000_000_000 + self.t_us
        self.records.append(
            struct.pack(">IIIIq", len(data), len(data), flags, 0, ts) + data
        )

    def cmd(self, opcode: int, params: bytes = b"") -> None:
        self._write(H4_CMD, struct.pack("<HB", opcode, len(params)) + params, FLAG_SENT_CMD)
        self.advance(1.2)

    def evt(self, code: int, params: bytes) -> None:
        self._write(H4_EVT, bytes([code, len(params)]) + params, FLAG_RECV_EVT)
        self.advance(0.4)

    def dump(self, path: str) -> None:
        with open(path, "wb") as f:
            f.write(BTSNOOP_MAGIC + struct.pack(">II", 1, DATALINK_HCI_UART_H4))
            for r in self.records:
                f.write(r)


def mfg_ad(payload: bytes) -> bytes:
    """Flags + Manufacturer Specific Data の AD 構造を組む。"""
    body = struct.pack("<H", COMPANY_ID) + payload
    return AD_FLAGS + bytes([len(body) + 1, 0xFF]) + body


def pairlink_payload(adv_type: int, extra: bytes = b"") -> bytes:
    """Pairlink 形式のペイロード: [C0][FF][type][HOMEID 4][extra]。"""
    return PAIRLINK_MAGIC + bytes([adv_type]) + HOMEID + extra


def set_adv_data(w: LogWriter, ad: bytes) -> None:
    """LE Set Advertising Data。31 バイトにゼロ埋めする実機の挙動を模す。"""
    padded = ad + bytes(31 - len(ad))
    w.cmd(0x2008, bytes([len(ad)]) + padded)


def adv_enable(w: LogWriter, on: bool) -> None:
    w.cmd(0x200A, bytes([1 if on else 0]))


def adv_report(w: LogWriter, addr: bytes, ad: bytes, rssi: int) -> None:
    """LE Advertising Report（器具からの状態アドバタイズ）。"""
    body = (
        bytes([1])  # num_reports
        + bytes([0x03])  # event_type: ADV_NONCONN_IND
        + bytes([0x01])  # address_type: random
        + addr
        + bytes([len(ad)])
        + ad
        + struct.pack("<b", rssi)
    )
    w.evt(0x3E, bytes([0x02]) + body)


def le_connection_complete(w: LogWriter, handle: int, peer: bytes) -> None:
    """LE Connection Complete（GATT 接続の確立）。"""
    body = (
        bytes([0x00])                    # status = success
        + struct.pack("<H", handle)
        + bytes([0x00])                  # role = central
        + bytes([0x01])                  # peer address type = random
        + peer
        + struct.pack("<HHH", 0x0018, 0x0000, 0x01F4)  # interval / latency / timeout
        + bytes([0x00])                  # clock accuracy
    )
    w.evt(0x3E, bytes([0x01]) + body)


def att_write(w: LogWriter, handle: int, att_handle: int, value: bytes) -> None:
    """ACL → L2CAP → ATT Write Command（コマンド送信の主経路）。

    ⚠️ 実際の value は libnative-lib.so で暗号化済みなので中身は読めない。
    ここではダミーのバイト列を入れている。
    """
    att = bytes([0x52]) + struct.pack("<H", att_handle) + value
    l2cap = struct.pack("<HH", len(att), 0x0004) + att
    acl = struct.pack("<HH", handle | (0x02 << 12), len(l2cap)) + l2cap
    w._write(H4_ACL, acl, 0x00)  # bit0=0 送信 / bit1=0 データ
    w.advance(3.0)


def att_notify(w: LogWriter, handle: int, att_handle: int, value: bytes) -> None:
    """器具からの ATT Handle Value Notification（状態通知の主経路）。"""
    att = bytes([0x1B]) + struct.pack("<H", att_handle) + value
    l2cap = struct.pack("<HH", len(att), 0x0004) + att
    acl = struct.pack("<HH", handle | (0x02 << 12), len(l2cap)) + l2cap
    w._write(H4_ACL, acl, 0x01)  # bit0=1 受信
    w.advance(3.0)


def phone_join_beacon(w: LogWriter) -> None:
    """ADV_PHONE のビーコン（Central 参加がタイムアウトしたときの挙動）。"""
    set_adv_data(w, mfg_ad(pairlink_payload(ADV_PHONE, PHONE_MAC)))
    adv_enable(w, True)
    w.advance(200.0)
    adv_enable(w, False)
    w.advance(80.0)


def fixture_beacon(w: LogWriter, unit: int, rssi: int) -> None:
    """器具の ADV_CONNECTABLE ビーコン。MAC は既知の OUI を使う。"""
    # 表示は 00:95:69:... になるので、生バイトは逆順で置く
    addr = bytes([0x10 + unit, 0x00, 0x00, 0x69, 0x95, 0x00])
    set_extra = bytes([0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    adv_report(w, addr, mfg_ad(pairlink_payload(ADV_CONNECTABLE, set_extra)), rssi)


def data_event(dst: bytes, channel: int, msgid: int, params: bytes) -> bytes:
    """MeshProfile.createDataEvent 相当の平文 PDU（暗号化前）。"""
    return bytes([0x03]) + dst + bytes([channel]) + OWN_VADDR + bytes([msgid]) + params


def build() -> LogWriter:
    """仮説どおりの通信を模擬する。

    実際の流れ（docs/02-protocol.md C2・C17-2）:
      スキャン → 器具のビーコン受信 → GATT 接続 → ATT で暗号化 PDU を送受信
      Central 参加が失敗した場合は ADV_PHONE を出して器具からの接続を待つ
    """
    w = LogWriter()
    handle = 0x0040
    att_write_handle = 0x0012
    att_notify_handle = 0x0015
    fixture_mac = bytes([0x11, 0x00, 0x00, 0x69, 0x95, 0x00])

    # --- 1. アプリ起動。HOMEID を持つ器具を探す ---------------------------
    w.cmd(0x200B, bytes([0x01]) + struct.pack("<HH", 0x0010, 0x0010) + bytes([0x01]))
    w.cmd(0x200C, bytes([0x01, 0x00]))  # LE Set Scan Enable ON

    # 3 台の器具がビーコンを流す。1 台は電波が弱く取りこぼす（S3 の再現）
    for round_i in range(4):
        fixture_beacon(w, 1, rssi=-58)
        w.advance(150.0)
        fixture_beacon(w, 2, rssi=-71)
        w.advance(160.0)
        if round_i % 3 == 0:
            fixture_beacon(w, 3, rssi=-88)
        w.advance(800.0)

    # --- 2. Central 参加がタイムアウト → Peripheral へフォールバック -------
    # （C17-2 の runable_central_join_timeout の挙動）
    phone_join_beacon(w)
    w.advance(1200.0)
    phone_join_beacon(w)
    w.advance(800.0)

    # --- 3. GATT 接続が確立 -----------------------------------------------
    le_connection_complete(w, handle, fixture_mac)
    w.advance(300.0)

    # --- 4. 照明制御。ATT で暗号化済み PDU を書き込む ----------------------
    # 平文の PDU は docs C15 の形。暗号化されるので電波上は読めない。
    scenarios = [
        ("電源 ON",        data_event(BROADCAST_VADDR, CHANNEL_TOLIGHT_2A,
                                     MSGID_BRIGHT_LIGHT, bytes([0, 55, 55, 0, 0, 0, 0]))),
        ("電源 OFF",       data_event(BROADCAST_VADDR, CHANNEL_TOLIGHT_2A,
                                     MSGID_BRIGHT_LIGHT, bytes([0, 50, 50, 0, 0, 0, 0]))),
        ("明るさ 段 1",    data_event(OWN_VADDR, CHANNEL_TOLIGHT,
                                     MSGID_BRIGHT_LIGHT, bytes([0, 5, 10, 0, 0, 0, 0]))),
        ("明るさ 段 2",    data_event(OWN_VADDR, CHANNEL_TOLIGHT,
                                     MSGID_BRIGHT_LIGHT, bytes([0, 4, 10, 0, 0, 0, 0]))),
        ("状態要求",       data_event(OWN_VADDR, CHANNEL_TOLIGHT, 0x70, b"")),
    ]
    for i, (_label, plain) in enumerate(scenarios):
        # 暗号化を模擬（実際は sendEncry。ここでは単純な XOR で不可読性だけ再現）
        cipher = bytes(b ^ 0x5A for b in plain)
        att_write(w, handle, att_write_handle, cipher)
        w.advance(120.0)
        # 状態通知が返ってくる（最後の状態要求のみ）
        if i == len(scenarios) - 1:
            status = data_event(OWN_VADDR, CHANNEL_TOLIGHT, 0x71, bytes([10, 5]))
            att_notify(w, handle, att_notify_handle,
                       bytes(b ^ 0x5A for b in status))
        w.advance(900.0)

    w.cmd(0x200C, bytes([0x00, 0x00]))  # LE Set Scan Enable OFF
    return w


def main(argv: list[str]) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    out = argv[1] if len(argv) > 1 else "artifacts/synth.log"
    w = build()
    w.dump(out)
    print(f"合成ログを書き出しました: {out}")
    print(f"  レコード数: {len(w.records)}")
    print(f"  記録時間  : {w.t_us / 1e6:.1f} 秒")
    print()
    print("次のコマンドで確認できます:")
    print(f"  python tools/btsnoop.py summary {out}")
    print(f"  python tools/btsnoop.py recv {out} --mfg-only")
    print(f"  python tools/btsnoop.py timeline {out}")
    print(f"  python tools/btsnoop.py find {out} C0FF05 D2040000")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
