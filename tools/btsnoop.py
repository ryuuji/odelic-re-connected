"""btsnoop (Android Bluetooth HCI スヌープログ) パーサ。

ODELIC CONNECTED LIGHTING のプロトコル解析用。
Wireshark で目視するより、バイト列の差分を機械的に出すことを主眼にしている。

使い方の例:

    # まず全体像。GATT 接続の有無がここで判る（H1 の検証）
    python tools/btsnoop.py summary artifacts/btsnoop_hci.log

    # 送信したアドバタイズデータ（＝アプリが出したコマンド）
    python tools/btsnoop.py sent artifacts/btsnoop_hci.log

    # 受信したアドバタイズ（＝器具の状態通知）
    python tools/btsnoop.py recv artifacts/btsnoop_hci.log --mfg-only

    # 送信コマンドのバイト差分。どのオフセットが何に対応するか
    python tools/btsnoop.py diff artifacts/btsnoop_hci.log

    # HOMEID 8803 をバイト列から探す（BCD / 16進の両方を試す）
    python tools/btsnoop.py find artifacts/btsnoop_hci.log 8803 2263

仕様: btsnoop のフォーマットは
https://fte.com/webhelp/sodera/Content/Documentation/WhitePapers/BPA600/Appendix/Header_Format/Snoop_File_Format.htm
"""

from __future__ import annotations

import argparse
import re
import struct
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------- btsnoop 本体

BTSNOOP_MAGIC = b"btsnoop\x00"

# btsnoop のタイムスタンプは西暦 0 年 1 月 1 日からのマイクロ秒。
# Unix エポックとの差分（Android bluedroid と同じ定数）。
BTSNOOP_EPOCH_DELTA_US = 0x00DCDDB30F2F8000

DATALINK_HCI_UNENCAPSULATED = 1001
DATALINK_HCI_UART_H4 = 1002
DATALINK_HCI_BSCP = 1003
DATALINK_HCI_SERIAL_H5 = 1004
DATALINK_MONITOR = 2001
"""BlueZ の `btmon -w` が書き出す形式。Android の btsnoop とは違う。

- `flags` = `(コントローラ index << 16) | monitor opcode`
- データ部に H4 の種別バイトが**付かない**
- 送受信の向きは opcode から決まる（`flags & 0x01` では判定できない）
"""

# btmon の monitor opcode（bluez の src/shared/btsnoop.h より）
MON_NEW_INDEX = 0x0000
MON_DELETE_INDEX = 0x0001
MON_COMMAND_PKT = 0x0002
MON_EVENT_PKT = 0x0003
MON_ACL_TX_PKT = 0x0004
MON_ACL_RX_PKT = 0x0005
MON_SCO_TX_PKT = 0x0006
MON_SCO_RX_PKT = 0x0007
MON_OPEN_INDEX = 0x0008
MON_CLOSE_INDEX = 0x0009
MON_INDEX_INFO = 0x000A
MON_VENDOR_DIAG = 0x000B
MON_SYSTEM_NOTE = 0x000C
MON_USER_LOGGING = 0x000D

# monitor opcode → 受信（コントローラ → ホスト）かどうか
MON_RECEIVED_OPCODES = frozenset(
    {MON_EVENT_PKT, MON_ACL_RX_PKT, MON_SCO_RX_PKT, 0x0011, 0x0013}
)

# H4 のパケット種別
H4_CMD = 0x01
H4_ACL = 0x02
H4_SCO = 0x03
H4_EVT = 0x04

H4_NAMES = {H4_CMD: "CMD", H4_ACL: "ACL", H4_SCO: "SCO", H4_EVT: "EVT"}


@dataclass
class Record:
    """btsnoop の 1 レコード。"""

    index: int
    ts_us: int
    """西暦 0 年起点のマイクロ秒（生値）。"""
    orig_len: int
    incl_len: int
    flags: int
    drops: int
    data: bytes
    datalink: int = DATALINK_HCI_UART_H4

    @property
    def mon_opcode(self) -> int:
        """btmon 形式の monitor opcode（それ以外の形式では意味を持たない）。"""
        return self.flags & 0xFFFF

    @property
    def received(self) -> bool:
        """コントローラ → ホスト（受信）なら True。"""
        if self.datalink == DATALINK_MONITOR:
            return self.mon_opcode in MON_RECEIVED_OPCODES
        return bool(self.flags & 0x01)

    @property
    def dt(self) -> datetime:
        us = self.ts_us - BTSNOOP_EPOCH_DELTA_US
        return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=us)

    def rel_ms(self, base_us: int) -> float:
        return (self.ts_us - base_us) / 1000.0


def read_btsnoop(path: str) -> tuple[int, list[Record]]:
    """btsnoop ファイルを読んで (datalink, レコード列) を返す。"""
    with open(path, "rb") as f:
        blob = f.read()

    if not blob.startswith(BTSNOOP_MAGIC):
        raise ValueError(
            f"btsnoop ファイルではありません（先頭が {blob[:8]!r}）。"
            " bugreport の ZIP から取り出したファイルを指定してください。"
        )

    version, datalink = struct.unpack_from(">II", blob, 8)
    if version != 1:
        raise ValueError(f"未対応の btsnoop バージョン: {version}")

    records: list[Record] = []
    off = 16
    idx = 0
    while off + 24 <= len(blob):
        orig_len, incl_len, flags, drops, ts_us = struct.unpack_from(">IIIIq", blob, off)
        off += 24
        if incl_len > len(blob) - off:
            # ログが途中で切れている（bugreport の btsnooz など）
            print(
                f"[警告] レコード #{idx} でファイルが途切れています。ここまでを解析します。",
                file=sys.stderr,
            )
            break
        data = blob[off : off + incl_len]
        off += incl_len
        records.append(
            Record(idx, ts_us, orig_len, incl_len, flags, drops, data, datalink)
        )
        idx += 1

    return datalink, records


def split_h4(rec: Record, datalink: int) -> tuple[int | None, bytes]:
    """レコードから (H4 パケット種別, HCI ペイロード) を取り出す。"""
    if not rec.data:
        return None, b""

    if datalink == DATALINK_HCI_UART_H4:
        return rec.data[0], rec.data[1:]

    if datalink == DATALINK_MONITOR:
        # btmon 形式。種別バイトは付かず、monitor opcode が種別と向きを表す。
        op = rec.mon_opcode
        if op == MON_COMMAND_PKT:
            return H4_CMD, rec.data
        if op == MON_EVENT_PKT:
            return H4_EVT, rec.data
        if op in (MON_ACL_TX_PKT, MON_ACL_RX_PKT):
            return H4_ACL, rec.data
        if op in (MON_SCO_TX_PKT, MON_SCO_RX_PKT):
            return H4_SCO, rec.data
        # New Index / System Note / User Logging などは HCI パケットではない
        return None, b""

    if datalink == DATALINK_HCI_UNENCAPSULATED:
        # 種別バイトが無いので packet_flags から推定する。
        #   bit0: 0=送信 1=受信 / bit1: 0=データ 1=コマンドまたはイベント
        is_cmd_evt = bool(rec.flags & 0x02)
        if is_cmd_evt:
            return (H4_EVT if rec.received else H4_CMD), rec.data
        return H4_ACL, rec.data

    raise ValueError(f"未対応の datalink type: {datalink}")


# ------------------------------------------------------------------ HCI 解釈

# 解析上重要な OpCode（OGF<<10 | OCF）
OPCODES = {
    0x0406: "Disconnect",
    0x2005: "LE Set Random Address",
    0x2006: "LE Set Advertising Parameters",
    0x2008: "LE Set Advertising Data",
    0x2009: "LE Set Scan Response Data",
    0x200A: "LE Set Advertising Enable",
    0x200B: "LE Set Scan Parameters",
    0x200C: "LE Set Scan Enable",
    0x200D: "LE Create Connection",
    0x2036: "LE Set Extended Advertising Parameters",
    0x2037: "LE Set Extended Advertising Data",
    0x2039: "LE Set Extended Advertising Enable",
    0x2041: "LE Set Extended Scan Parameters",
    0x2042: "LE Set Extended Scan Enable",
    0x2043: "LE Extended Create Connection",
}

EVENT_CODES = {
    0x05: "Disconnection Complete",
    0x0E: "Command Complete",
    0x0F: "Command Status",
    0x13: "Number Of Completed Packets",
    0x3E: "LE Meta Event",
}

LE_SUBEVENTS = {
    0x01: "LE Connection Complete",
    0x02: "LE Advertising Report",
    0x03: "LE Connection Update Complete",
    0x04: "LE Read Remote Features Complete",
    0x0A: "LE Enhanced Connection Complete",
    0x0D: "LE Extended Advertising Report",
}

# 切断理由（Core Spec Vol 4 Part E 1.3）。原因ごとに打つ手が違うので必須。
#   0x08 は電波が途切れた（環境・干渉）、0x13 は相手の判断（プロトコル）
HCI_ERRORS = {
    0x08: "Connection Timeout（Supervision Timeout 満了 = 電波が途切れた）",
    0x13: "Remote User Terminated（相手が切った）",
    0x14: "Remote Terminated (Low Resources)",
    0x15: "Remote Terminated (Power Off)",
    0x16: "Terminated By Local Host（自分が切った）",
    0x22: "LMP/LL Response Timeout",
    0x28: "Instant Passed",
    0x3B: "Unacceptable Connection Parameters（要求を拒否された）",
    0x3E: "Connection Failed to be Established",
}

# L2CAP の LE シグナリングチャネル。
# ⭐ Peripheral が接続パラメータを変えてもらう唯一の手段がここを通る。
L2CAP_CID_LE_SIGNALING = 0x0005
L2CAP_SIG_CODES = {
    0x12: "Conn Param Update Request",
    0x13: "Conn Param Update Response",
}
CPUR_RESULTS = {0x0000: "accepted", 0x0001: "rejected"}

ATT_OPCODES = {
    0x01: "Error Response",
    0x02: "Exchange MTU Request",
    0x03: "Exchange MTU Response",
    0x04: "Find Information Request",
    0x05: "Find Information Response",
    0x06: "Find By Type Value Request",
    0x07: "Find By Type Value Response",
    0x08: "Read By Type Request",
    0x09: "Read By Type Response",
    0x0A: "Read Request",
    0x0B: "Read Response",
    0x0C: "Read Blob Request",
    0x0D: "Read Blob Response",
    0x0E: "Read Multiple Request",
    0x0F: "Read Multiple Response",
    0x10: "Read By Group Type Request",
    0x11: "Read By Group Type Response",
    0x12: "Write Request",
    0x13: "Write Response",
    0x16: "Prepare Write Request",
    0x17: "Prepare Write Response",
    0x18: "Execute Write Request",
    0x19: "Execute Write Response",
    0x1B: "Handle Value Notification",
    0x1D: "Handle Value Indication",
    0x1E: "Handle Value Confirmation",
    0x52: "Write Command",
    0xD2: "Signed Write Command",
}

# GATT の探索応答から UUID を取り出すためのオペコード
ATT_DISCOVERY_OPCODES = (0x05, 0x09, 0x11)

# docs/02-protocol.md C17-1 の UUID。ログ中に現れたら注釈を付ける。
KNOWN_UUIDS = {
    "9e5d1e47-5c13-43a0-8635-82adffc0386f": "Pairlink メッシュ サービス（器具側）",
    "9e5d1e47-5c13-43a0-8635-82adffc1386f": "Pairlink 書き込み（器具側）",
    "9e5d1e47-5c13-43a0-8635-82adffc2386f": "Pairlink 通知（器具側）",
    "0000ffd0-0000-1000-8000-00805f9b34fb": "Pairlink メッシュ サービス（スマホ側）",
    "0000ffd1-0000-1000-8000-00805f9b34fb": "Pairlink 書き込み（スマホ側）",
    "0000ffd2-0000-1000-8000-00805f9b34fb": "Pairlink 通知（スマホ側）",
    "00002902-0000-1000-8000-00805f9b34fb": "CCCD",
}


def uuid_from_le(raw: bytes) -> str | None:
    """ATT のリトルエンディアン UUID を標準表記にする。"""
    if len(raw) == 2:
        return f"0000{raw[1]:02x}{raw[0]:02x}-0000-1000-8000-00805f9b34fb"
    if len(raw) == 16:
        b = raw[::-1].hex()
        return f"{b[0:8]}-{b[8:12]}-{b[12:16]}-{b[16:20]}-{b[20:32]}"
    return None


def extract_uuids(opcode: int, params: bytes) -> list[str]:
    """ATT の探索応答から UUID を列挙する。

    - 0x11 Read By Group Type Response : [len][handle(2) end(2) uuid(len-4)]...
    - 0x09 Read By Type Response       : [len][handle(2) value(len-2)]...
      （キャラクタリスティック宣言なら value = プロパティ(1) 値ハンドル(2) UUID）
    - 0x05 Find Information Response   : [format][handle(2) uuid(2 or 16)]...
    """
    out: list[str] = []
    if not params:
        return out

    if opcode in (0x09, 0x11):
        item_len = params[0]
        if item_len <= 0:
            return out
        body = params[1:]
        for off in range(0, len(body) - item_len + 1, item_len):
            item = body[off : off + item_len]
            if opcode == 0x11:
                raw = item[4:]
            else:
                # キャラクタリスティック宣言の形（1 + 2 + UUID）を優先して試す
                raw = item[5:] if len(item) in (7, 21) else item[2:]
            u = uuid_from_le(raw)
            if u:
                out.append(u)
        return out

    if opcode == 0x05:
        fmt = params[0]
        size = 4 if fmt == 0x01 else 18  # handle(2) + UUID(2 or 16)
        body = params[1:]
        for off in range(0, len(body) - size + 1, size):
            u = uuid_from_le(body[off + 2 : off + size])
            if u:
                out.append(u)
    return out

AD_TYPES = {
    0x01: "Flags",
    0x02: "Incomplete 16-bit UUIDs",
    0x03: "Complete 16-bit UUIDs",
    0x06: "Incomplete 128-bit UUIDs",
    0x07: "Complete 128-bit UUIDs",
    0x08: "Shortened Local Name",
    0x09: "Complete Local Name",
    0x0A: "TX Power Level",
    0x16: "Service Data (16-bit UUID)",
    0x19: "Appearance",
    0x21: "Service Data (128-bit UUID)",
    0xFF: "Manufacturer Specific Data",
}

AD_TYPE_MANUFACTURER = 0xFF

# ------------------------------------------------- Pairlink / ODELIC 固有

# 純正アプリは Company ID を 0 で送る（MeshCommon.createAdvertiseData の
# addManufacturerData(0, ...)）。SIG 未割当の値なので他社と衝突しうる。
PAIRLINK_COMPANY_ID = 0x0000

# ペイロード先頭 2 バイトのマジック。flow_control_enable は常に false なので
# 実際に飛ぶのは 0xC0 だけだが、0xC1 も受け付ける。
PAIRLINK_MAGIC0 = (0xC0, 0xC1)
PAIRLINK_MAGIC1 = 0xFF

# MeshService.ADV_* （startIBeaconAdvertise の type 引数）
ADV_TYPE_NAMES = {
    0x01: "ADV_SINGLE",
    0x02: "ADV_BROADCAST",
    0x03: "ADV_NORMAL",
    0x04: "ADV_NORMAL_SETMESH",
    0x05: "ADV_PHONE",
    0x07: "ADV_RESET",
    0x08: "ADV_PHONE_E1",
    0x09: "ADV_DISCOVERABLE",
    0x0A: "ADV_BROADCAST_E1",
    0x0C: "ADV_HOMEID",
    0x0D: "ADV_NORMAL_SETMESH_E1",
    0x21: "ADV_NORMAL_SETMESH_E2",
    0x82: "ADV_CONNECTABLE",
}

# 器具の MAC 上位 3 バイト（OUI）。
#   EC:C5:7F  … 実機で確認（docs/02-protocol.md C19-3）
#   00:95:69 / F0:AC:D7 … API_get_mesh_homeid_from_scan の判定値（C16-4）。
#                         この環境の器具は該当しないので、MAC 判定に依存しないこと。
FIXTURE_OUIS = ("EC:C5:7F", "00:95:69", "F0:AC:D7")


@dataclass
class PairlinkAdv:
    """Pairlink 独自メッシュのアドバタイズペイロード。

    形式（MeshCommon.createAdvertiseData より）:
        [0]     0xC0 / 0xC1     マジック
        [1]     0xFF
        [2]     ADV_* の type
        [3..6]  HOMEID（10 進数のリトルエンディアン 4 バイト）
        [7..]   type ごとの追加データ（ADV_PHONE ならスマホの BT MAC 6 バイト）
    """

    magic: int
    adv_type: int
    homeid_raw: bytes
    extra: bytes

    @property
    def adv_type_name(self) -> str:
        return ADV_TYPE_NAMES.get(self.adv_type, f"Unknown(0x{self.adv_type:02X})")

    @property
    def homeid(self) -> int | None:
        """HOMEID を 10 進数で返す（アプリの ID 表示の上位 4 桁）。"""
        if len(self.homeid_raw) != 4:
            return None
        return int.from_bytes(self.homeid_raw, "little", signed=False)

    @property
    def extra_as_mac(self) -> str | None:
        """ADV_PHONE の追加データを MAC として表示する。"""
        if self.adv_type in (0x05, 0x08) and len(self.extra) >= 6:
            return ":".join(f"{b:02X}" for b in self.extra[:6])
        return None

    def describe(self) -> str:
        parts = [f"{self.adv_type_name}(0x{self.adv_type:02X})"]
        hid = self.homeid
        if hid is not None:
            parts.append(f"HOMEID={hid}")
        mac = self.extra_as_mac
        if mac:
            parts.append(f"phoneMAC={mac}")
        elif self.extra:
            parts.append(f"extra={' '.join(f'{b:02X}' for b in self.extra)}")
        return "  ".join(parts)


def decode_pairlink(mfg: "AdStructure") -> PairlinkAdv | None:
    """Manufacturer Specific Data が Pairlink 形式なら解釈して返す。

    Company ID = 0 は他社と衝突しうるので、マジックと ADV type の
    両方が既知の値であることを確認してから採用する。
    """
    if mfg.company_id != PAIRLINK_COMPANY_ID:
        return None
    p = mfg.mfg_payload
    if len(p) < 7 or p[0] not in PAIRLINK_MAGIC0 or p[1] != PAIRLINK_MAGIC1:
        return None
    if p[2] not in ADV_TYPE_NAMES:
        return None
    return PairlinkAdv(magic=p[0], adv_type=p[2], homeid_raw=p[3:7], extra=p[7:])


@dataclass
class AdStructure:
    ad_type: int
    data: bytes

    @property
    def type_name(self) -> str:
        return AD_TYPES.get(self.ad_type, f"Unknown(0x{self.ad_type:02X})")

    @property
    def company_id(self) -> int | None:
        """Manufacturer Specific Data の Company Identifier（リトルエンディアン）。"""
        if self.ad_type == AD_TYPE_MANUFACTURER and len(self.data) >= 2:
            return self.data[0] | (self.data[1] << 8)
        return None

    @property
    def mfg_payload(self) -> bytes:
        """Company ID を除いたベンダー独自ペイロード。"""
        if self.ad_type == AD_TYPE_MANUFACTURER and len(self.data) >= 2:
            return self.data[2:]
        return b""


def parse_ad(data: bytes) -> list[AdStructure]:
    """AD 構造（[len][type][data...] の連続）をパースする。"""
    out: list[AdStructure] = []
    i = 0
    while i < len(data):
        length = data[i]
        if length == 0:
            break  # 末尾のゼロパディング
        if i + 1 + length > len(data):
            break  # 途中で切れている
        out.append(AdStructure(data[i + 1], data[i + 2 : i + 1 + length]))
        i += 1 + length
    return out


@dataclass
class AdvPacket:
    """アドバタイズ 1 件（送信・受信の両方をこの形で扱う）。"""

    rec: Record
    direction: str
    """'sent' = 端末が送信 / 'recv' = 端末が受信"""
    ad_data: bytes
    address: str | None = None
    rssi: int | None = None
    source: str = ""
    """由来（どの HCI コマンド/イベントから取れたか）"""

    @property
    def structures(self) -> list[AdStructure]:
        return parse_ad(self.ad_data)

    @property
    def mfg(self) -> AdStructure | None:
        for s in self.structures:
            if s.ad_type == AD_TYPE_MANUFACTURER:
                return s
        return None

    @property
    def pairlink(self) -> PairlinkAdv | None:
        m = self.mfg
        return decode_pairlink(m) if m else None


def bd_addr(raw: bytes) -> str:
    """BD_ADDR（リトルエンディアン 6 バイト）を表示形式にする。"""
    return ":".join(f"{b:02X}" for b in reversed(raw))


@dataclass
class ConnParams:
    """接続パラメータ。notify のレイテンシを決めているのはこれ。"""

    interval_raw: int
    latency: int
    timeout_raw: int

    @property
    def interval_ms(self) -> float:
        return self.interval_raw * 1.25

    @property
    def timeout_ms(self) -> int:
        return self.timeout_raw * 10

    @property
    def eff_ms(self) -> float:
        """notify 1 通が電波に乗るまでの上限 = interval × (1 + slave latency)。"""
        return self.interval_ms * (1 + self.latency)

    def describe(self) -> str:
        s = (
            f"interval={self.interval_ms:6.2f}ms(0x{self.interval_raw:04X})"
            f"  latency={self.latency}  supv={self.timeout_ms}ms"
        )
        if self.latency:
            s += f"  → 実効待ち {self.eff_ms:.1f}ms"
        return s


@dataclass
class ConnEvent:
    """接続・切断・パラメータ更新の 1 イベント。"""

    rec: Record
    kind: str
    handle: int | None = None
    role: str | None = None
    peer: str | None = None
    params: ConnParams | None = None
    reason: int | None = None

    def describe(self) -> str:
        parts = [self.kind]
        if self.handle is not None:
            parts.append(f"h={self.handle}")
        if self.role:
            parts.append(self.role)
        if self.peer:
            parts.append(self.peer)
        if self.params:
            parts.append(self.params.describe())
        if self.reason is not None:
            parts.append(f"reason=0x{self.reason:02X} {HCI_ERRORS.get(self.reason, '?')}")
        return "  ".join(parts)


@dataclass
class L2capSig:
    """CID 0x0005（LE シグナリング）のメッセージ。

    ⭐ Peripheral は HCI `LE Connection Update` を使えない（Central 専用）ので、
    接続パラメータを変えたいときはここで Central にお願いするしかない。
    Linux は Peripheral 役のとき、実 interval が
    `[conn_min_interval, conn_max_interval]` の外なら**自動でこれを送る**。
    """

    rec: Record
    handle: int
    code: int
    min_raw: int | None = None
    max_raw: int | None = None
    latency: int | None = None
    timeout_raw: int | None = None
    result: int | None = None

    def describe(self) -> str:
        name = L2CAP_SIG_CODES.get(self.code, f"code 0x{self.code:02X}")
        if self.code == 0x12 and self.min_raw is not None:
            return (
                f"{name}  min={self.min_raw * 1.25:.2f}ms max={self.max_raw * 1.25:.2f}ms"
                f" latency={self.latency} supv={self.timeout_raw * 10}ms"
            )
        if self.code == 0x13 and self.result is not None:
            return f"{name}  result=0x{self.result:04X} {CPUR_RESULTS.get(self.result, '?')}"
        return name


@dataclass
class Parsed:
    """ログ全体の解析結果。"""

    datalink: int = 0
    records: list[Record] = field(default_factory=list)
    cmd_counts: Counter = field(default_factory=Counter)
    evt_counts: Counter = field(default_factory=Counter)
    le_subevent_counts: Counter = field(default_factory=Counter)
    att_ops: list[tuple[Record, int, bytes]] = field(default_factory=list)
    advs: list[AdvPacket] = field(default_factory=list)
    connections: list[ConnEvent] = field(default_factory=list)
    adv_enable: list[tuple[Record, bool]] = field(default_factory=list)
    scan_enable: list[tuple[Record, bool]] = field(default_factory=list)
    l2cap_sig: list[L2capSig] = field(default_factory=list)
    acl_latency: list[tuple[Record, int, float, int]] = field(default_factory=list)
    """(Number Of Completed Packets のレコード, handle, レイテンシ ms, TX バイト数)"""
    _acl_tx: dict[int, list[tuple[int, int]]] = field(
        default_factory=lambda: defaultdict(list)
    )


def parse_log(path: str) -> Parsed:
    datalink, records = read_btsnoop(path)
    p = Parsed(datalink=datalink, records=records)

    for rec in records:
        ptype, payload = split_h4(rec, datalink)
        if ptype is None or not payload:
            continue

        if ptype == H4_CMD:
            _parse_command(p, rec, payload)
        elif ptype == H4_EVT:
            _parse_event(p, rec, payload)
        elif ptype == H4_ACL:
            _parse_acl(p, rec, payload)

    return p


def _parse_command(p: Parsed, rec: Record, payload: bytes) -> None:
    if len(payload) < 3:
        return
    opcode, plen = struct.unpack_from("<HB", payload, 0)
    params = payload[3 : 3 + plen]
    p.cmd_counts[opcode] += 1

    if opcode == 0x2008:  # LE Set Advertising Data
        if params:
            significant = params[0]
            p.advs.append(
                AdvPacket(
                    rec=rec,
                    direction="sent",
                    ad_data=params[1 : 1 + significant],
                    source="LE Set Advertising Data",
                )
            )
    elif opcode == 0x2009:  # LE Set Scan Response Data
        if params:
            significant = params[0]
            p.advs.append(
                AdvPacket(
                    rec=rec,
                    direction="sent",
                    ad_data=params[1 : 1 + significant],
                    source="LE Set Scan Response Data",
                )
            )
    elif opcode == 0x2037:  # LE Set Extended Advertising Data
        if len(params) >= 4:
            data_len = params[3]
            p.advs.append(
                AdvPacket(
                    rec=rec,
                    direction="sent",
                    ad_data=params[4 : 4 + data_len],
                    source="LE Set Extended Advertising Data",
                )
            )
    elif opcode == 0x200A:  # LE Set Advertising Enable
        if params:
            p.adv_enable.append((rec, bool(params[0])))
    elif opcode == 0x2039:  # LE Set Extended Advertising Enable
        if params:
            p.adv_enable.append((rec, bool(params[0])))
    elif opcode in (0x200C, 0x2042):  # LE Set (Extended) Scan Enable
        if params:
            p.scan_enable.append((rec, bool(params[0])))


def _parse_event(p: Parsed, rec: Record, payload: bytes) -> None:
    if len(payload) < 2:
        return
    code, plen = payload[0], payload[1]
    params = payload[2 : 2 + plen]
    p.evt_counts[code] += 1

    if code == 0x05:  # Disconnection Complete: status(1) handle(2) reason(1)
        if len(params) >= 4:
            p.connections.append(
                ConnEvent(
                    rec,
                    "Disconnection Complete",
                    handle=int.from_bytes(params[1:3], "little"),
                    reason=params[3],
                )
            )
        else:
            p.connections.append(ConnEvent(rec, "Disconnection Complete"))
        return

    if code == 0x13:  # Number Of Completed Packets → ACL 送信レイテンシが取れる
        _parse_num_completed(p, rec, params)
        return

    if code != 0x3E or not params:  # LE Meta Event 以外は用がない
        return

    subevent = params[0]
    body = params[1:]
    p.le_subevent_counts[subevent] += 1

    if subevent in (0x01, 0x0A):  # LE (Enhanced) Connection Complete
        _parse_le_conn_complete(p, rec, subevent, body)
    elif subevent == 0x03:  # LE Connection Update Complete
        _parse_le_conn_update(p, rec, body)
    elif subevent == 0x02:  # LE Advertising Report
        _parse_adv_report(p, rec, body)
    elif subevent == 0x0D:  # LE Extended Advertising Report
        _parse_ext_adv_report(p, rec, body)


def _parse_le_conn_complete(p: Parsed, rec: Record, subevent: int, body: bytes) -> None:
    """LE (Enhanced) Connection Complete。⭐ 器具が指定してきた接続パラメータが入る。

    0x01: status(1) handle(2) role(1) peer_type(1) peer(6) interval(2) latency(2)
          timeout(2) cca(1)
    0x0A: peer(6) の直後に local_rpa(6) peer_rpa(6) が挟まる（+12 バイト）
    """
    if len(body) < 18:
        p.connections.append(ConnEvent(rec, LE_SUBEVENTS[subevent]))
        return
    status = body[0]
    handle = int.from_bytes(body[1:3], "little")
    role = "Peripheral" if body[3] == 0x01 else "Central"
    peer = bd_addr(body[5:11])
    off = 11 + (12 if subevent == 0x0A else 0)
    params = None
    if status == 0x00 and len(body) >= off + 6:
        iv, lat, to = struct.unpack_from("<HHH", body, off)
        params = ConnParams(iv, lat, to)
    p.connections.append(
        ConnEvent(rec, LE_SUBEVENTS[subevent], handle, role, peer, params)
    )


def _parse_le_conn_update(p: Parsed, rec: Record, body: bytes) -> None:
    """LE Connection Update Complete: status(1) handle(2) interval(2) latency(2) timeout(2)

    ⚠️ ここで interval が**長くなっている**なら、こちら側が出した
    Connection Parameter Update Request が器具の選択を上書きしている。
    """
    if len(body) < 9:
        p.connections.append(ConnEvent(rec, LE_SUBEVENTS[0x03]))
        return
    handle = int.from_bytes(body[1:3], "little")
    iv, lat, to = struct.unpack_from("<HHH", body, 3)
    p.connections.append(
        ConnEvent(
            rec,
            LE_SUBEVENTS[0x03],
            handle,
            params=(ConnParams(iv, lat, to) if body[0] == 0x00 else None),
        )
    )


def _parse_le_signaling(p: Parsed, rec: Record, handle: int, sig: bytes) -> None:
    """L2CAP CID 0x0005。code(1) ident(1) len(2) [data]

    0x12 CPUR      : min(2) max(2) latency(2) timeout_multiplier(2)
    0x13 CPUR 応答 : result(2)
    """
    if len(sig) < 4:
        return
    ev = L2capSig(rec=rec, handle=handle, code=sig[0])
    data = sig[4:]
    if ev.code == 0x12 and len(data) >= 8:
        ev.min_raw, ev.max_raw, ev.latency, ev.timeout_raw = struct.unpack_from(
            "<HHHH", data, 0
        )
    elif ev.code == 0x13 and len(data) >= 2:
        ev.result = int.from_bytes(data[:2], "little")
    p.l2cap_sig.append(ev)


def _parse_num_completed(p: Parsed, rec: Record, params: bytes) -> None:
    """ACL 送信 → 完了通知までのレイテンシ。

    「notify を呼んでから実際に電波に乗るまで」の実測値になる。
    接続パラメータを変えた効果はここに一番はっきり出る。
    """
    if not params:
        return
    for i in range(params[0]):
        off = 1 + i * 4
        if off + 4 > len(params):
            return
        handle = int.from_bytes(params[off : off + 2], "little") & 0x0FFF
        count = int.from_bytes(params[off + 2 : off + 4], "little")
        q = p._acl_tx[handle]
        for _ in range(min(count, len(q))):
            ts, nbytes = q.pop(0)
            p.acl_latency.append((rec, handle, (rec.ts_us - ts) / 1000.0, nbytes))


def _parse_adv_report(p: Parsed, rec: Record, body: bytes) -> None:
    if not body:
        return
    num = body[0]
    off = 1
    for _ in range(num):
        if off + 9 > len(body):
            return
        # event_type(1) address_type(1) address(6) length_data(1)
        addr = body[off + 2 : off + 8]
        length_data = body[off + 8]
        off += 9
        if off + length_data + 1 > len(body):
            return
        ad_data = body[off : off + length_data]
        rssi = struct.unpack_from("<b", body, off + length_data)[0]
        off += length_data + 1
        p.advs.append(
            AdvPacket(
                rec=rec,
                direction="recv",
                ad_data=ad_data,
                address=bd_addr(addr),
                rssi=rssi,
                source="LE Advertising Report",
            )
        )


def _parse_ext_adv_report(p: Parsed, rec: Record, body: bytes) -> None:
    if not body:
        return
    num = body[0]
    off = 1
    for _ in range(num):
        # event_type(2) addr_type(1) addr(6) pri_phy(1) sec_phy(1) sid(1)
        # tx_power(1) rssi(1) periodic_interval(2) direct_addr_type(1)
        # direct_addr(6) data_length(1)
        if off + 24 > len(body):
            return
        addr = body[off + 3 : off + 9]
        rssi = struct.unpack_from("<b", body, off + 14)[0]
        data_length = body[off + 23]
        off += 24
        if off + data_length > len(body):
            return
        ad_data = body[off : off + data_length]
        off += data_length
        p.advs.append(
            AdvPacket(
                rec=rec,
                direction="recv",
                ad_data=ad_data,
                address=bd_addr(addr),
                rssi=rssi,
                source="LE Extended Advertising Report",
            )
        )


def _parse_acl(p: Parsed, rec: Record, payload: bytes) -> None:
    """ACL → L2CAP → ATT を最小限だけ解釈する（GATT を使っている場合の確認用）。"""
    if len(payload) < 4:
        return
    handle_flags, _acl_len = struct.unpack_from("<HH", payload, 0)
    handle = handle_flags & 0x0FFF
    pb_flag = (handle_flags >> 12) & 0x03
    if pb_flag == 0x01:
        return  # 継続フラグメントは無視（先頭だけ見る）

    # 送信は完了通知（Number Of Completed Packets）と突き合わせてレイテンシにする
    if not rec.received:
        p._acl_tx[handle].append((rec.ts_us, len(payload) - 4))

    l2cap = payload[4:]
    if len(l2cap) < 4:
        return
    _l2cap_len, cid = struct.unpack_from("<HH", l2cap, 0)

    if cid == L2CAP_CID_LE_SIGNALING:  # 接続パラメータの交渉がここに来る
        _parse_le_signaling(p, rec, handle, l2cap[4:])
        return
    if cid != 0x0004:  # ATT 以外は用がない
        return

    att = l2cap[4:]
    if att:
        p.att_ops.append((rec, att[0], att[1:]))


# -------------------------------------------------------------------- 表示

def hexs(b: bytes, sep: str = " ") -> str:
    return sep.join(f"{x:02X}" for x in b)


def _base_us(p: Parsed) -> int:
    return p.records[0].ts_us if p.records else 0


def _pct(values: list[float], q: float) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


def _summarize_conn_params(p: Parsed) -> None:
    """接続パラメータと切断理由をまとめる。

    ⭐ notify のレイテンシは Connection Interval に律速される。
    さらに、こちら側（Linux）が出す Connection Parameter Update Request が
    **器具の選択を上書きして遅くしてしまう**ことがあるので、必ず突き合わせる。
    """
    inits: dict[tuple[str, tuple], int] = Counter()
    updates: Counter = Counter()
    for ev in p.connections:
        if ev.params is None:
            continue
        key = (ev.params.interval_raw, ev.params.latency, ev.params.timeout_raw)
        if ev.kind.startswith("LE Connection Update"):
            updates[key] += 1
        else:
            inits[(ev.peer or "?", key)] += 1

    reqs: Counter = Counter()
    results: Counter = Counter()
    for sig in p.l2cap_sig:
        if sig.code == 0x12 and sig.min_raw is not None:
            reqs[(sig.min_raw, sig.max_raw, sig.latency, sig.timeout_raw)] += 1
        elif sig.code == 0x13 and sig.result is not None:
            results[sig.result] += 1

    if not (inits or updates or reqs):
        return

    print("\n" + "=" * 72)
    print("接続パラメータ（notify レイテンシの律速要因）")
    print("=" * 72)

    if inits:
        print("--- 相手が指定してきた初期値（LE Connection Complete）---")
        for (peer, key), n in sorted(inits.items(), key=lambda kv: -kv[1]):
            print(f"  {peer}  {ConnParams(*key).describe()}   x{n}")
    if updates:
        print("\n--- 更新後（LE Connection Update Complete）---")
        for key, n in sorted(updates.items(), key=lambda kv: -kv[1]):
            print(f"  {ConnParams(*key).describe()}   x{n}")
    if reqs:
        print("\n--- L2CAP Connection Parameter Update Request（こちらの要求）---")
        for (mn, mx, lat, to), n in sorted(reqs.items(), key=lambda kv: -kv[1]):
            print(
                f"  min={mn * 1.25:6.2f}ms max={mx * 1.25:6.2f}ms"
                f" latency={lat} supv={to * 10}ms   x{n}"
            )
        if results:
            detail = " / ".join(
                f"{CPUR_RESULTS.get(r, hex(r))} {n}" for r, n in results.most_common()
            )
            print(f"  応答: {detail}")

    # 初期値より更新後が長くなっていたら、それは自分で遅くしている
    init_ivs = [k[1][0] for k in inits] if inits else []
    if init_ivs and updates:
        worst_update = max(k[0] for k in updates)
        if worst_update > min(init_ivs):
            print(
                f"\n⚠️ 更新後の interval（{worst_update * 1.25:.2f}ms）が"
                f"初期値（{min(init_ivs) * 1.25:.2f}ms）より長い。"
                "\n   Linux の conn_min_interval / conn_max_interval が"
                "相手の選択を上書きして遅くしている。"
                "\n   → conn_min_interval を下げれば要求そのものが出なくなる"
                "（実 interval が範囲内なら送らない）"
            )

    all_ivs = init_ivs + [k[0] for k in updates]
    if all_ivs:
        print(
            f"\nnotify 1 通の送信待ち上限 = interval × (1 + latency):"
            f"  最良 {min(all_ivs) * 1.25:.2f}ms / 最悪 {max(all_ivs) * 1.25:.2f}ms"
            "\n  → 要求 → 応答の往復はこの 2 倍が下限"
        )

    reasons = Counter(ev.reason for ev in p.connections if ev.reason is not None)
    if reasons:
        print("\n--- 切断理由の内訳 ---")
        for r, n in reasons.most_common():
            print(f"  0x{r:02X}  {n:4d} 件  {HCI_ERRORS.get(r, '?')}")

    if p.acl_latency:
        lats = [ms for _rec, _h, ms, _n in p.acl_latency]
        print(
            f"\n--- ACL 送信 → 完了通知 ---\n"
            f"  n={len(lats)}  min={min(lats):.1f}  p50={_pct(lats, 0.5):.1f}"
            f"  p90={_pct(lats, 0.9):.1f}  p99={_pct(lats, 0.99):.1f}"
            f"  max={max(lats):.1f} ms"
        )


def cmd_summary(p: Parsed) -> None:
    print("=" * 72)
    print("btsnoop 解析サマリ")
    print("=" * 72)
    dl_name = {
        DATALINK_HCI_UNENCAPSULATED: "HCI unencapsulated (1001)",
        DATALINK_HCI_UART_H4: "HCI UART H4 (1002) — Android btsnoop",
        DATALINK_HCI_BSCP: "HCI BSCP (1003)",
        DATALINK_HCI_SERIAL_H5: "HCI Serial H5 (1004)",
        DATALINK_MONITOR: "Linux Monitor (2001) — btmon -w",
    }.get(p.datalink, str(p.datalink))
    print(f"datalink      : {dl_name}")
    print(f"レコード数    : {len(p.records)}")
    if p.records:
        span = (p.records[-1].ts_us - p.records[0].ts_us) / 1e6
        print(f"開始時刻      : {p.records[0].dt.astimezone()}")
        print(f"記録時間      : {span:.1f} 秒")
    dropped = sum(r.drops for r in p.records)
    if dropped:
        print(f"[警告] ドロップ累計: {dropped}")

    print("\n--- HCI コマンド ---")
    for opcode, n in p.cmd_counts.most_common():
        name = OPCODES.get(opcode, "")
        mark = "  ★" if opcode in (0x2008, 0x2037, 0x200A, 0x2039) else ""
        print(f"  0x{opcode:04X}  {n:6d}  {name}{mark}")

    print("\n--- HCI イベント ---")
    for code, n in p.evt_counts.most_common():
        print(f"  0x{code:02X}    {n:6d}  {EVENT_CODES.get(code, '')}")

    if p.le_subevent_counts:
        print("\n--- LE Meta サブイベント ---")
        for sub, n in p.le_subevent_counts.most_common():
            print(f"  0x{sub:02X}    {n:6d}  {LE_SUBEVENTS.get(sub, '')}")

    # --- 仮説 H1 の判定 -------------------------------------------------
    print("\n" + "=" * 72)
    print("仮説 H1（コネクションレス・アドバタイジング方式）の判定")
    print("=" * 72)

    sent = [a for a in p.advs if a.direction == "sent"]
    recv = [a for a in p.advs if a.direction == "recv"]
    conns = p.connections

    print(f"送信アドバタイズ設定 : {len(sent)} 件")
    print(f"受信アドバタイズ     : {len(recv)} 件")
    print(f"接続イベント         : {len(conns)} 件")
    print(f"ATT (GATT) 操作      : {len(p.att_ops)} 件")

    if sent and not conns:
        verdict = "★ H1 を支持：アドバタイズ送信があり、GATT 接続が一切ない"
    elif sent and conns:
        verdict = "△ ハイブリッド：アドバタイズ送信と GATT 接続の両方がある"
    elif conns and not sent:
        verdict = "× H1 に反する：GATT 接続方式（アドバタイズ送信なし）"
    else:
        verdict = "? 判定不能：アドバタイズ送信も接続もない（記録範囲が不適切か）"
    print(f"\n判定: {verdict}")

    if conns:
        print("\n接続イベントの内訳:")
        base = _base_us(p)
        for ev in conns[:20]:
            print(f"  +{ev.rec.rel_ms(base):9.1f} ms  #{ev.rec.index:<6d} {ev.describe()}")
        if len(conns) > 20:
            print(f"  ... 他 {len(conns) - 20} 件")
        _summarize_conn_params(p)

    if p.att_ops:
        print("\nATT 操作の内訳（>> = スマホが送信 / << = スマホが受信）:")
        counts = Counter(
            (">>" if not rec.received else "<<", op) for rec, op, _ in p.att_ops
        )
        for (arrow, op), n in sorted(counts.items(), key=lambda kv: -kv[1]):
            print(f"  {arrow} 0x{op:02X}  {n:6d}  {ATT_OPCODES.get(op, '')}")
        print(
            "\n  → 探索応答（0x09/0x11/0x05）を**受信**していれば"
            "スマホは GATT クライアント（Central）、"
            "\n    **送信**していればスマホが GATT サーバ（Peripheral）。"
        )

        # 書き込みのサイズ分布 → セグメント分割の有無（I7）
        write_sizes = Counter()
        for _rec, op, params in p.att_ops:
            if op in (0x12, 0x52) and len(params) >= 2:
                write_sizes[len(params) - 2] += 1
        if write_sizes:
            print("\n  書き込みペイロードのサイズ分布（I7 セグメント分割の判定）:")
            for size, n in sorted(write_sizes.items()):
                note = "  ← 20 バイト = real_mtu 上限" if size == 20 else ""
                print(f"    {size:3d} バイト  {n:4d} 回{note}")

        # 探索応答から UUID を集める → C17-1 の照合。方向が役割を決める。
        uuids: Counter = Counter()
        for rec, op, params in p.att_ops:
            if op in ATT_DISCOVERY_OPCODES:
                owner = "器具が公開" if rec.received else "スマホが公開"
                for u in extract_uuids(op, params):
                    uuids[(owner, u)] += 1
        if uuids:
            print("\n  GATT 探索で現れた UUID（公開元は応答の方向から判定）:")
            for (owner, u), n in uuids.most_common():
                known = KNOWN_UUIDS.get(u)
                mark = f"  ★ {known}" if known else ""
                print(f"    [{owner}] {u}  x{n}{mark}")
            if not any(u in KNOWN_UUIDS for _o, u in uuids):
                print(
                    "\n    [注意] C17-1 の既知 UUID が 1 つも現れていません。"
                    "\n    別のアプリの GATT 通信を見ている可能性があります。"
                )

        # ATT データ内の ASCII 文字列（デバイス名・型番が平文で出ることがある）
        strings: Counter = Counter()
        for _rec, _op, params in p.att_ops:
            for m in re.findall(rb"[ -~]{6,}", params):
                strings[m.decode("ascii", "replace")] += 1
        if strings:
            print("\n  ATT データ内の ASCII 文字列:")
            for s, n in strings.most_common(10):
                print(f"    '{s}'  x{n}")

    # アドバタイズ有効化の推移から送信の継続時間を測る（I1 の検証）
    if p.adv_enable:
        print("\n--- アドバタイズ有効化の推移（送信継続時間 = I1 の検証） ---")
        base = _base_us(p)
        on_at: float | None = None
        durations: list[float] = []
        for rec, on in p.adv_enable:
            t = rec.rel_ms(base)
            if on:
                on_at = t
            elif on_at is not None:
                durations.append(t - on_at)
                on_at = None
        for rec, on in p.adv_enable[:20]:
            print(f"  +{rec.rel_ms(base):9.1f} ms  {'ON ' if on else 'OFF'}")
        if len(p.adv_enable) > 20:
            print(f"  ... 他 {len(p.adv_enable) - 20} 件")
        if durations:
            print(
                f"\n  送信継続時間: 最短 {min(durations):.1f} ms /"
                f" 中央 {sorted(durations)[len(durations) // 2]:.1f} ms /"
                f" 最長 {max(durations):.1f} ms （{len(durations)} 回）"
            )
            print(
                "  → 数百 ms で停止しているなら、取りこぼし前提の再送設計が無い"
                "（I1）ことの裏付けになる。"
            )

    if recv:
        print("\n--- 受信アドバタイズの送信元（上位 15 件） ---")
        by_addr = Counter(a.address for a in recv)
        for addr, n in by_addr.most_common(15):
            print(f"  {addr}  {n:6d} 件")
        print(f"\n  ユニークな送信元: {len(by_addr)} 件")

    companies = Counter()
    for a in p.advs:
        m = a.mfg
        if m and m.company_id is not None:
            companies[(a.direction, m.company_id)] += 1
    if companies:
        print("\n--- Manufacturer Specific Data の Company ID ---")
        for (direction, cid), n in companies.most_common():
            print(f"  {direction:4s}  0x{cid:04X}  {n:6d} 件")
        print("\n  → 送信と受信で同じ Company ID なら、同一プロトコルの往復。")

    _summarize_pairlink(p)


def _summarize_pairlink(p: Parsed) -> None:
    """Pairlink / ODELIC 固有の解析結果。"""
    hits = [(a, pl) for a in p.advs if (pl := a.pairlink) is not None]
    print("\n" + "=" * 72)
    print("Pairlink / ODELIC 固有の解析")
    print("=" * 72)
    if not hits:
        print("Pairlink 形式のアドバタイズは見つかりませんでした。")
        print("  → Company ID=0 かつ先頭が [C0|C1][FF][既知の ADV type] のものを探しています。")
        print("  → アプリを操作した区間がログに含まれているか確認してください。")
        return

    print(f"Pairlink アドバタイズ: {len(hits)} 件")

    by_type: Counter = Counter()
    by_homeid: Counter = Counter()
    phone_macs: Counter = Counter()
    for a, pl in hits:
        by_type[(a.direction, pl.adv_type)] += 1
        if pl.homeid is not None:
            by_homeid[(a.direction, pl.homeid)] += 1
        mac = pl.extra_as_mac
        if mac:
            phone_macs[mac] += 1

    print("\n--- ADV type の内訳 ---")
    for (direction, t), n in by_type.most_common():
        name = ADV_TYPE_NAMES.get(t, "?")
        note = "  ← スマホが送信" if t in (0x05, 0x08) else ""
        print(f"  {direction:4s}  0x{t:02X}  {name:24s} {n:6d} 件{note}")

    print("\n--- 検出された HOMEID ---")
    for (direction, hid), n in by_homeid.most_common():
        print(f"  {direction:4s}  {hid:5d}  （8 桁 ID の上位 4 桁）  {n:6d} 件")
    print("\n  → 自分のネットワークの HOMEID と一致するものが自分の器具・端末。")

    if phone_macs:
        print("\n--- ADV_PHONE に載っていた MAC ---")
        for mac, n in phone_macs.most_common():
            print(f"  {mac}  {n:6d} 件")

    # 器具の OUI 判定（API_get_mesh_homeid_from_scan の条件より）
    fixtures = Counter()
    for a, _pl in hits:
        if a.address:
            oui = a.address[:8].upper()
            if oui in FIXTURE_OUIS:
                fixtures[a.address] += 1
    if fixtures:
        print("\n--- 器具と判定できた送信元（既知の OUI に一致） ---")
        for addr, n in fixtures.most_common():
            print(f"  {addr}  {n:6d} 件")
    else:
        recv_addrs = {a.address for a, _ in hits if a.address}
        if recv_addrs:
            print(
                f"\n  [注意] 既知の OUI ({', '.join(FIXTURE_OUIS)}) に一致する送信元は"
                "ありませんでした。"
            )
            print("  器具の MAC がランダマイズされているか、別世代のモジュールの可能性。")


def _print_advs(p: Parsed, advs: list[AdvPacket], show_ad: bool) -> None:
    base = _base_us(p)
    for a in advs:
        head = f"+{a.rec.rel_ms(base):9.1f} ms  #{a.rec.index:<6d}"
        extra = ""
        if a.address:
            extra += f"  {a.address}"
        if a.rssi is not None:
            extra += f"  {a.rssi:4d} dBm"
        print(f"{head}{extra}  [{len(a.ad_data):2d}] {hexs(a.ad_data)}")
        pl = a.pairlink
        if pl:
            print(f"{'':>24}  ★ Pairlink: {pl.describe()}")
        if show_ad:
            for s in a.structures:
                if s.ad_type == AD_TYPE_MANUFACTURER and s.company_id is not None:
                    print(
                        f"{'':>24}  {s.type_name}: CompanyID=0x{s.company_id:04X}"
                        f" payload=[{len(s.mfg_payload)}] {hexs(s.mfg_payload)}"
                    )
                else:
                    print(f"{'':>24}  {s.type_name}: {hexs(s.data)}")


def cmd_sent(p: Parsed, args) -> None:
    advs = [a for a in p.advs if a.direction == "sent"]
    if args.mfg_only:
        advs = [a for a in advs if a.mfg]
    print(f"送信アドバタイズ: {len(advs)} 件\n")
    _print_advs(p, advs, show_ad=not args.raw)


def cmd_recv(p: Parsed, args) -> None:
    advs = [a for a in p.advs if a.direction == "recv"]
    if args.mfg_only:
        advs = [a for a in advs if a.mfg]
    if args.addr:
        want = args.addr.upper()
        advs = [a for a in advs if a.address and a.address.upper() == want]
    if args.company is not None:
        advs = [
            a
            for a in advs
            if (m := a.mfg) is not None and m.company_id == args.company
        ]
    print(f"受信アドバタイズ: {len(advs)} 件\n")
    _print_advs(p, advs, show_ad=not args.raw)


def cmd_diff(p: Parsed, args) -> None:
    """同じ長さのペイロードを集めて、オフセットごとに値の揺れを出す。

    どのバイトがコマンド種別・調光値・シーケンス番号なのかを機械的に絞り込む。
    """
    direction = args.direction
    advs = [a for a in p.advs if a.direction == direction]

    # ベンダー独自ペイロード（Company ID を除いた部分）を優先して比較する
    payloads: list[bytes] = []
    label = "Manufacturer ペイロード"
    for a in advs:
        m = a.mfg
        if m and m.mfg_payload:
            payloads.append(m.mfg_payload)
    if not payloads:
        label = "AD データ全体"
        payloads = [a.ad_data for a in advs if a.ad_data]

    if not payloads:
        print(f"比較できる {direction} のペイロードがありません。")
        return

    by_len: dict[int, list[bytes]] = defaultdict(list)
    for pl in payloads:
        by_len[len(pl)].append(pl)

    print(f"差分解析: {direction} / {label} / 全 {len(payloads)} 件")
    print(f"長さの分布: {dict(sorted((k, len(v)) for k, v in by_len.items()))}\n")

    for length in sorted(by_len, key=lambda k: -len(by_len[k])):
        group = by_len[length]
        uniq = list(dict.fromkeys(group))  # 出現順を保った重複排除
        print("=" * 72)
        print(f"長さ {length} バイト: {len(group)} 件（ユニーク {len(uniq)} 種）")
        print("=" * 72)

        if len(uniq) == 1:
            print(f"  全て同一: {hexs(uniq[0])}")
            print("  → 同一操作でバイト列が変わらない＝平文かつ再送カウンタなし。")
            continue

        print("  オフセットごとの値（ユニーク数が少ない順に意味が読み取りやすい）:")
        for off in range(length):
            vals = Counter(pl[off] for pl in group)
            if len(vals) == 1:
                (v, _), = vals.most_common(1)
                print(f"    [{off:2d}] 固定 0x{v:02X}")
            else:
                shown = " ".join(
                    f"0x{v:02X}({n})" for v, n in vals.most_common(8)
                )
                more = "" if len(vals) <= 8 else f" ... 計 {len(vals)} 種"
                print(f"    [{off:2d}] 変動 {len(vals):3d} 種: {shown}{more}")

        print("\n  ユニークなペイロード（先頭 20 件）:")
        for pl in uniq[:20]:
            print(f"    {hexs(pl)}   x{group.count(pl)}")
        if len(uniq) > 20:
            print(f"    ... 他 {len(uniq) - 20} 種")

        print(
            "\n  読み方: 固定バイト＝ヘッダ/HOMEID の候補。"
            "\n          少数の値をとるバイト＝コマンド種別・グループ ID の候補。"
            "\n          多数の値をとるバイト＝調光値・シーケンス番号・暗号化の候補。"
        )


def cmd_find(p: Parsed, args) -> None:
    """バイト列パターンを全パケットから探す（HOMEID の表現を突き止める用）。"""
    patterns: list[tuple[str, bytes]] = []
    for token in args.pattern:
        clean = token.replace(":", "").replace(" ", "").replace("0x", "")
        try:
            raw = bytes.fromhex(clean)
        except ValueError:
            print(f"[警告] 16 進として読めないパターンを飛ばします: {token}")
            continue
        patterns.append((token, raw))
        if len(raw) > 1:
            patterns.append((f"{token} (逆順)", raw[::-1]))

    if not patterns:
        print("有効なパターンがありません。例: 8803 2263")
        return

    base = _base_us(p)
    for token, raw in patterns:
        hits = [
            rec for rec in p.records if raw in rec.data
        ]
        print("=" * 72)
        print(f"パターン {token} → {hexs(raw)} : {len(hits)} 件ヒット")
        print("=" * 72)
        for rec in hits[: args.limit]:
            ptype, _ = split_h4(rec, p.datalink)
            kind = H4_NAMES.get(ptype or -1, "?")
            arrow = "recv" if rec.received else "sent"
            pos = rec.data.find(raw)
            print(
                f"  +{rec.rel_ms(base):9.1f} ms  #{rec.index:<6d} {kind} {arrow}"
                f"  offset={pos:3d}  {hexs(rec.data)}"
            )
        if len(hits) > args.limit:
            print(f"  ... 他 {len(hits) - args.limit} 件")
        print()


def _link_rows(p: Parsed) -> list[dict]:
    """接続イベントを「リンク 1 本 = 1 行」に畳む。"""
    open_links: dict[int, dict] = {}
    rows: list[dict] = []

    for ev in p.connections:
        if ev.kind in ("LE Connection Complete", "LE Enhanced Connection Complete"):
            if ev.handle is None:
                continue
            open_links[ev.handle] = {
                "handle": ev.handle,
                "peer": ev.peer,
                "role": ev.role,
                "start": ev.rec.ts_us,
                "init": ev.params,
                "updates": [],
                "end": None,
                "reason": None,
            }
        elif ev.kind == "LE Connection Update Complete":
            link = open_links.get(ev.handle)
            if link is not None and ev.params is not None:
                link["updates"].append(ev.params)
        elif ev.kind == "Disconnection Complete":
            link = open_links.pop(ev.handle, None)
            if link is not None:
                link["end"] = ev.rec.ts_us
                link["reason"] = ev.reason
                rows.append(link)

    rows.extend(open_links.values())  # ログの最後まで生きていたリンク

    # CPUR をリンクの生存区間で突き合わせる
    for r in rows:
        end = r["end"] or float("inf")
        r["cpur"] = [
            s for s in p.l2cap_sig
            if s.handle == r["handle"] and r["start"] <= s.rec.ts_us <= end
        ]
    return sorted(rows, key=lambda x: x["start"])


def cmd_conn(p: Parsed, args) -> None:
    """リンク 1 本を 1 行にまとめる。接続パラメータの前後比較に使う。"""
    rows = _link_rows(p)
    if not rows:
        print("接続イベントが記録されていません")
        return
    base = _base_us(p)

    print("=" * 110)
    print("GATT リンク一覧（interval は「相手の指定 → 更新後」）")
    print("=" * 110)
    print(
        f"{'h':>4}  {'相手':17}  {'開始 ms':>11}  {'継続 s':>8}  "
        f"{'interval ms':>22}  {'lat':>3}  {'supv':>6}  {'CPUR':9}  切断理由"
    )
    for r in rows:
        init: ConnParams | None = r["init"]
        ups: list[ConnParams] = r["updates"]
        iv = f"{init.interval_ms:.2f}" if init else "?"
        if ups:
            iv += " → " + " → ".join(f"{u.interval_ms:.2f}" for u in ups)
        last = ups[-1] if ups else init
        held = f"{(r['end'] - r['start']) / 1e6:8.1f}" if r["end"] else "     (生)"
        req = [s for s in r["cpur"] if s.code == 0x12]
        res = [s for s in r["cpur"] if s.code == 0x13 and s.result is not None]
        cpur = "-"
        if req:
            cpur = CPUR_RESULTS.get(res[0].result, "?") if res else "無応答"
        reason = (
            f"0x{r['reason']:02X} {HCI_ERRORS.get(r['reason'], '?')}"
            if r["reason"] is not None
            else ""
        )
        print(
            f"{r['handle']:>4}  {r['peer'] or '?':17}  "
            f"{(r['start'] - base) / 1000.0:11.1f}  {held}  {iv:>22}  "
            f"{last.latency if last else '?':>3}  "
            f"{(last.timeout_ms if last else 0):>5}m  {cpur:9}  {reason}"
        )

    held = [(r["end"] - r["start"]) / 1e6 for r in rows if r["end"]]
    if held:
        print(
            f"\nリンク寿命: n={len(held)}  min={min(held):.1f}  "
            f"p50={_pct(held, 0.5):.1f}  p90={_pct(held, 0.9):.1f}  max={max(held):.1f} 秒"
        )
    # 切断 → 次の接続までの空白（広告再開の遅れがここに出る）
    gaps = []
    for prev, nxt in zip(rows, rows[1:]):
        if prev["end"] and nxt["start"] > prev["end"]:
            gaps.append((nxt["start"] - prev["end"]) / 1e6)
    if gaps:
        print(
            f"切断 → 次の接続までの空白: n={len(gaps)}  min={min(gaps):.1f}  "
            f"p50={_pct(gaps, 0.5):.1f}  p90={_pct(gaps, 0.9):.1f}  max={max(gaps):.1f} 秒"
        )
    _summarize_conn_params(p)


def cmd_latency(p: Parsed, args) -> None:
    """ACL 送信 → 完了通知のレイテンシ分布。接続パラメータの効果はここに出る。"""
    if not p.acl_latency:
        print("ACL 送信の完了通知が記録されていません（-w のバイナリログが必要）")
        return

    # handle ごとに「いつ interval が何になったか」を並べ、サンプル時刻で引く
    timeline: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for ev in p.connections:
        if ev.handle is not None and ev.params is not None:
            timeline[ev.handle].append((ev.rec.ts_us, ev.params.interval_ms))
    for h in timeline:
        timeline[h].sort()

    def interval_at(handle: int, ts: int) -> float | None:
        cur = None
        for t, iv in timeline.get(handle, []):
            if t <= ts:
                cur = iv
            else:
                break
        return cur

    samples = [
        (ms, handle, interval_at(handle, rec.ts_us), nbytes)
        for rec, handle, ms, nbytes in p.acl_latency
        if args.handle is None or handle == args.handle
    ]
    if not samples:
        print("該当するサンプルがありません")
        return

    lats = [s[0] for s in samples]
    print("=" * 72)
    print("ACL 送信 → Number Of Completed Packets（電波に乗るまで）")
    print("=" * 72)
    print(
        f"全体   : n={len(lats)}  min={min(lats):.1f}  p50={_pct(lats, 0.5):.1f}"
        f"  p90={_pct(lats, 0.9):.1f}  p99={_pct(lats, 0.99):.1f}  max={max(lats):.1f} ms"
    )

    by_iv: dict[float | None, list[float]] = defaultdict(list)
    for ms, _h, iv, _n in samples:
        by_iv[iv].append(ms)
    if len(by_iv) > 1 or None not in by_iv:
        print("\ninterval 別:")
        for iv in sorted(by_iv, key=lambda x: (x is None, x)):
            v = by_iv[iv]
            label = f"{iv:6.2f}ms" if iv else "  不明  "
            print(
                f"  {label} リンク: n={len(v):5d}  p50={_pct(v, 0.5):7.1f}"
                f"  p90={_pct(v, 0.9):7.1f}  max={max(v):7.1f}"
            )

    if args.top:
        print(f"\n遅い順 {args.top} 件:")
        for ms, handle, iv, nbytes in sorted(samples, key=lambda s: -s[0])[: args.top]:
            print(
                f"  {ms:8.1f} ms  h={handle}  interval={iv or '?'}  {nbytes} バイト"
            )


def cmd_timeline(p: Parsed, args) -> None:
    """送信・受信・接続を時系列に並べる。操作とパケットの対応づけに使う。"""
    base = _base_us(p)
    events: list[tuple[int, str]] = []

    for rec, on in p.adv_enable:
        events.append((rec.ts_us, f"ADV {'ON' if on else 'OFF'}"))
    for rec, on in p.scan_enable:
        events.append((rec.ts_us, f"SCAN {'ON' if on else 'OFF'}"))
    for ev in p.connections:
        events.append((ev.rec.ts_us, f"** {ev.describe()} **"))
    for sig in p.l2cap_sig:
        arrow = "<<" if sig.rec.received else ">>"
        events.append((sig.rec.ts_us, f"{arrow} L2CAP {sig.describe()}"))

    # GATT 操作。コマンド送信の主経路なので、操作との対応づけに必須。
    # ⚠️ ペイロードは暗号化されているので中身は読めない（docs C17-3）。
    for rec, op, params in p.att_ops:
        name = ATT_OPCODES.get(op, f"ATT 0x{op:02X}")
        handle = ""
        value = params
        if op in (0x0A, 0x12, 0x52, 0x1B, 0x1D) and len(params) >= 2:
            handle = f" h=0x{params[0] | (params[1] << 8):04X}"
            value = params[2:]
        arrow = "<<" if rec.received else ">>"
        events.append(
            (rec.ts_us, f"{arrow} {name}{handle}  [{len(value):2d}] {hexs(value)}")
        )

    for a in p.advs:
        if a.direction == "sent":
            pl = a.pairlink
            note = f"  ({pl.describe()})" if pl else ""
            events.append((a.rec.ts_us, f"TX  {hexs(a.ad_data)}{note}"))
        elif not args.tx_only:
            src = a.address or "?"
            pl = a.pairlink
            note = f"  ({pl.describe()})" if pl else ""
            events.append((a.rec.ts_us, f"RX  {src}  {hexs(a.ad_data)}{note}"))

    events.sort(key=lambda e: e[0])
    print(f"タイムライン: {len(events)} イベント\n")
    prev: int | None = None
    for ts, text in events:
        gap = "" if prev is None else f"(+{(ts - prev) / 1000:7.1f} ms)"
        print(f"+{(ts - base) / 1000:10.1f} ms {gap:>16s}  {text}")
        prev = ts


def _force_utf8_stdout() -> None:
    """Windows のコンソールコードページ (cp932) で文字化けするのを防ぐ。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdout()
    ap = argparse.ArgumentParser(
        description="btsnoop (Android HCI スヌープログ) パーサ",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
        sp.add_argument("logfile", help="btsnoop_hci.log のパス")
        return sp

    add_common(sub.add_parser("summary", help="全体像と仮説 H1 の判定"))

    sp = add_common(sub.add_parser("sent", help="送信したアドバタイズを一覧"))
    sp.add_argument("--mfg-only", action="store_true", help="Manufacturer データを含むものだけ")
    sp.add_argument("--raw", action="store_true", help="AD 構造の内訳を出さない")

    sp = add_common(sub.add_parser("recv", help="受信したアドバタイズを一覧"))
    sp.add_argument("--mfg-only", action="store_true", help="Manufacturer データを含むものだけ")
    sp.add_argument("--raw", action="store_true", help="AD 構造の内訳を出さない")
    sp.add_argument("--addr", help="送信元 BD_ADDR で絞る (例 AA:BB:CC:DD:EE:FF)")
    sp.add_argument(
        "--company", type=lambda s: int(s, 0), help="Company ID で絞る (例 0x004C)"
    )

    sp = add_common(sub.add_parser("diff", help="ペイロードのバイト差分を解析"))
    sp.add_argument(
        "--direction", choices=("sent", "recv"), default="sent", help="既定: sent"
    )

    sp = add_common(sub.add_parser("find", help="バイト列パターンを検索"))
    sp.add_argument("pattern", nargs="+", help="16 進パターン (例 8803 2263)")
    sp.add_argument("--limit", type=int, default=30, help="1 パターンあたりの表示件数")

    sp = add_common(sub.add_parser("timeline", help="送受信を時系列に並べる"))
    sp.add_argument("--tx-only", action="store_true", help="送信のみ表示")

    sp = add_common(
        sub.add_parser("conn", help="GATT リンクと接続パラメータを一覧（1 本 1 行）")
    )

    sp = add_common(
        sub.add_parser("latency", help="ACL 送信 → 完了通知のレイテンシ分布")
    )
    sp.add_argument("--handle", type=int, help="この handle だけ")
    sp.add_argument("--top", type=int, default=0, help="遅い順に N 件表示")

    args = ap.parse_args(argv)

    try:
        p = parse_log(args.logfile)
    except (OSError, ValueError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1

    if args.cmd == "summary":
        cmd_summary(p)
    elif args.cmd == "sent":
        cmd_sent(p, args)
    elif args.cmd == "recv":
        cmd_recv(p, args)
    elif args.cmd == "diff":
        cmd_diff(p, args)
    elif args.cmd == "find":
        cmd_find(p, args)
    elif args.cmd == "timeline":
        cmd_timeline(p, args)
    elif args.cmd == "conn":
        cmd_conn(p, args)
    elif args.cmd == "latency":
        cmd_latency(p, args)

    return 0


if __name__ == "__main__":
    sys.exit(main())
