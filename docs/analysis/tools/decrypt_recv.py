"""HCI ログのメッシュ PDU を復号して読む（C23）。

器具からのデータ応答（PDU タイプ 0x06）は暗号化されているが、
同じリンクで先に飛んでくる `PERIPHERAL_LOGIN`（`01 19` + 16 バイト）に
復号鍵が入っている。これを使って復号する。

    鍵の材料 = アプリ表示の 8 桁 ID（HOMEID 4 桁 + パスワード 4 桁）

    LOGINKEY = [h0,p0,h1,p1,h2,p2,h3,p3] + "LOGINKEY"
    EVENTKEY = [h0,p0,h1,p1,h2,p2,h3,p3] + "EVENTKEY"

    AES_ECB_decrypt(LOGINKEY, ログイン要求 16B)
        → [0..3] HOMEID / [4..7] ★ 器具の XOR 鍵 / [8..15] パディング 08×8

    受信 0x06 の復号:
        data[6..] を XOR 鍵（周期 4）でホワイトニング
        → AES_ECB_decrypt(EVENTKEY, data[6..])
        → 最終バイトがパディング長（0x10 以下でなければ復号失敗）

使い方:

    python tools/decrypt_recv.py artifacts/btsnoop_hci-20260725-154002.log 12345678

`.so`（libnative-lib.so）の `cmd_handle` / `encry_data_handle` の
逆アセンブルから再現した。詳細は docs/02-protocol.md の C21〜C23。
"""

from __future__ import annotations

import os
import struct
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])

import btsnoop as B  # noqa: E402

# ------------------------------------------------------------------ 暗号

PDU_CMD = 0x01
PDU_RESPONSE = 0x02
PDU_DATA_EVENT = 0x03
PDU_ENCRYPTED = 0x06
CMD_PERIPHERAL_LOGIN = 0x19


def make_keys(display_id: str) -> tuple[bytes, bytes, bytes, bytes]:
    """8 桁 ID から (HOMEID, パスワード, LOGINKEY, EVENTKEY) を作る。"""
    homeid = struct.pack("<I", int(display_id[:4]))
    pwd = display_id[4:].encode("ascii")
    inter = bytes(
        [homeid[0], pwd[0], homeid[1], pwd[1], homeid[2], pwd[2], homeid[3], pwd[3]]
    )
    return homeid, pwd, inter + b"LOGINKEY", inter + b"EVENTKEY"


def aes_dec(key: bytes, ct: bytes) -> bytes:
    d = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    return d.update(ct) + d.finalize()


def aes_enc(key: bytes, pt: bytes) -> bytes:
    e = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return e.update(pt) + e.finalize()


def decrypt_pdu(raw: bytes, event_key: bytes, link_key: bytes) -> bytes | None:
    """encry_data_handle の再現。平文 PDU を返す（失敗なら None）。"""
    if len(raw) < 6 + 16 or (len(raw) - 6) % 16 != 0:
        return None
    buf = bytearray(raw)
    for i in range(6, len(buf)):
        buf[i] ^= link_key[(i - 6) % 4]
    body = aes_dec(event_key, bytes(buf[6:]))
    padlen = body[-1]
    if padlen > 0x10:
        return None
    return bytes([PDU_DATA_EVENT]) + raw[1:6] + body[: len(body) - padlen]


# ------------------------------------------------------------------ 解釈

CHANNELS = {
    0x20: "TOLIGHT",
    0x24: "TOLIGHT 応答",
    0x2A: "一斉",
    0xFE: "Ping",
    0xFF: "Ping 応答",
}

MSGIDS = {
    0x02: "get_product_id",
    0x70: "状態要求",
    0x71: "状態応答(main)",
    0x35: "状態応答(FD)",
    0x80: "製品自己申告",
    0xC0: "明るさ(一斉/個別)",
    0xC1: "明るさ(グループ)",
    0xD0: "get_group_id",
    0xD7: "グループ応答",
}


def mac_str(b: bytes) -> str:
    return ":".join(f"{x:02X}" for x in reversed(b))


def describe(pdu: bytes) -> str:
    """平文 PDU の中身を日本語で説明する。"""
    if len(pdu) < 6:
        return "（短すぎる）"
    ch = pdu[5]
    body = pdu[6:]

    if ch == 0xFF:  # Ping 応答: MAC + vAddr + 機種 + ファーム（C23-4）
        if len(body) < 14:
            return f"Ping 応答（{len(body)}B・短い）: {B.hexs(body)}"
        prod = body[10] | (body[11] << 8)
        return (
            f"Ping 応答: MAC {mac_str(body[0:6])}  vAddr {B.hexs(body[6:10])}"
            f"  機種 0x{prod:04X}  ファーム {body[12]}.{body[13]}"
        )

    if len(body) < 5:
        return f"（データ {len(body)}B）: {B.hexs(body)}"
    src, msgid, params = body[0:4], body[4], body[5:]
    name = MSGIDS.get(msgid, f"MSGID 0x{msgid:02X}")
    extra = ""
    if msgid == 0x80 and len(params) >= 7:
        extra = f"  MAC {mac_str(params[0:6])}  製品コード 0x{params[6]:02X}"
    elif msgid == 0xD7 and len(params) >= 8:
        extra = f"  グループ ID {params[7]}"
    elif msgid in (0x71, 0x35) and len(params) >= 2:
        color, bright = params[0], params[1]
        if color == 0x37 and bright == 0x37:
            extra = "  ON"
        elif color == 0x32 and bright == 0x32:
            extra = "  OFF"
        else:
            extra = f"  色温度 {color * 5}%  明るさ {100 - bright * 5}%"
    return f"src vAddr {B.hexs(src)}  {name}{extra}  params {B.hexs(params)}"


# ------------------------------------------------------------------ 本体


def att_payloads(path: str):
    """(時刻ms, 方向, PDU) を時系列で返す。方向 'recv' = 器具 → コントローラ。"""
    p = B.parse_log(path)
    base = B._base_us(p)
    for rec, op, params in p.att_ops:
        if op in (0x1B, 0x1D, 0x12, 0x52):  # Notify / Write
            if len(params) < 2:
                continue
            val = params[2:]
        elif op in (0x0B, 0x13):
            val = params
        else:
            continue
        if val:
            yield rec.rel_ms(base), ("recv" if rec.received else "sent"), val


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = sys.argv[1]
    # 認証情報をソースに埋めない。引数か環境変数 ODELIC_ID で渡す
    display_id = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("ODELIC_ID", "")
    if not display_id:
        print("第 2 引数に 8 桁 ID を指定してください（または export ODELIC_ID=<8桁ID>）", file=sys.stderr)
        return 1

    homeid, pwd, KL, KE = make_keys(display_id)
    print(f"ID {display_id} → HOMEID {B.hexs(homeid)} / パスワード {B.hexs(pwd)}")
    print(f"LOGINKEY {B.hexs(KL)}")
    print(f"EVENTKEY {B.hexs(KE)}\n")

    link_key: bytes | None = None
    keys: list[bytes] = []
    stats = {"ok": 0, "ng": 0}

    for t, direction, pdu in att_payloads(path):
        ptype = pdu[0]

        # --- 器具 → コントローラ: ログイン要求から鍵を取り出す ---
        if direction == "recv" and ptype == PDU_CMD and len(pdu) == 18 and pdu[1] == CMD_PERIPHERAL_LOGIN:
            pt = aes_dec(KL, pdu[2:])
            ok = pt[:4] == homeid
            link_key = pt[4:8]
            if link_key not in keys:
                keys.append(link_key)
            print(f"{t:11.1f}ms << PERIPHERAL_LOGIN 復号: {B.hexs(pt)}")
            print(
                f"{'':16}HOMEID {B.hexs(pt[:4])} {'✅' if ok else '❌'}"
                f"  ★XOR 鍵 {B.hexs(link_key)}  パディング {B.hexs(pt[8:])}"
            )
            continue

        # --- コントローラ → 器具: ログイン応答を検算する ---
        if direction == "sent" and ptype == PDU_RESPONSE and len(pdu) == 18 and pdu[1] == CMD_PERIPHERAL_LOGIN:
            if link_key is None:
                continue
            expect = aes_enc(KL, homeid + pwd + link_key + bytes([0x04] * 4))
            hit = expect == pdu[2:]
            print(
                f"{t:11.1f}ms >> ログイン応答の検算: "
                f"{'✅ 再現一致' if hit else '❌ 不一致'}  期待 {B.hexs(expect)}"
            )
            continue

        # --- 暗号化された応答を復号する ---
        if ptype == PDU_ENCRYPTED:
            plain = None
            used = None
            for k in ([link_key] if link_key else []) + [k for k in keys if k != link_key]:
                plain = decrypt_pdu(pdu, KE, k)
                if plain is not None:
                    used = k
                    break
            arrow = "<<" if direction == "recv" else ">>"
            if plain is None:
                stats["ng"] += 1
                print(f"{t:11.1f}ms {arrow} ❌ 復号失敗: {B.hexs(pdu)}")
                continue
            stats["ok"] += 1
            ch = CHANNELS.get(plain[5], f"0x{plain[5]:02X}")
            print(f"{t:11.1f}ms {arrow} 復号 [{ch}] {B.hexs(plain)}")
            print(f"{'':16}{describe(plain)}   （鍵 {B.hexs(used)}）")
            continue

        # --- 平文の DATA_EVENT はそのまま読む ---
        if ptype == PDU_DATA_EVENT and len(pdu) >= 11:
            ch = CHANNELS.get(pdu[5], f"0x{pdu[5]:02X}")
            arrow = "<<" if direction == "recv" else ">>"
            print(f"{t:11.1f}ms {arrow} 平文 [{ch}] {B.hexs(pdu)}")
            print(f"{'':16}{describe(pdu)}")

    print(f"\n復号: 成功 {stats['ok']} 件 / 失敗 {stats['ng']} 件  （鍵 {len(keys)} 個）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
