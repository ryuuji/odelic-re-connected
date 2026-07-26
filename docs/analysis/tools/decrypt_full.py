"""⚠️ 【廃止】このスクリプトの前提は誤りでした。→ docs/analysis/tools/decrypt_recv.py を使ってください。

XOR ホワイトニング鍵を「vaddr[0] + MAC の一部」と推定して総当たりしていますが、
実際の鍵は **PERIPHERAL_LOGIN（`01 19` + 16 バイト）を LOGINKEY で復号した
bytes 4..7**（接続ごとにランダムな 4 バイト）でした。総当たりでは当たりません。
経緯は docs/02-protocol.md の C22-5（失敗の記録）→ C23（解決）を参照。

以下は当時の記述のまま残しています。

encry_data_handle の完全再現（XOR ホワイトニング + EVENTKEY AES 復号）。

.so の静的解析（docs/02-protocol.md C21）で判明した手順:

  通常モード（setHomeidPassword、[0xfc8] フラグ = 0）:
    1. data[6..len-1] を XOR ホワイトニング
       鍵 = [vaddr[0], mac[3], mac[4], mac[5]] の周期 4
       （device エントリ 10 バイト = MAC(6) + vaddr(4)、
        XOR 鍵バイト = entry[6], entry[3], entry[4], entry[5] の繰り返し）
    2. AES_ECB_decrypt(EVENTKEY, data[6..len-1])   ← len-6 は 16 の倍数

  EVENTKEY = [h0,p0,h1,p1,h2,p2,h3,p3] + "EVENTKEY"

device の vaddr[0] が不明な場合は 0..255 を総当たりする。
"""

from __future__ import annotations

import os
import struct
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def aes_dec(key: bytes, ct: bytes) -> bytes:
    d = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    return d.update(ct) + d.finalize()


def event_key(display_id: str) -> bytes:
    homeid = struct.pack("<I", int(display_id[:4]))
    pwd = display_id[4:].encode("ascii")
    inter = bytes(
        [homeid[0], pwd[0], homeid[1], pwd[1], homeid[2], pwd[2], homeid[3], pwd[3]]
    )
    return inter + b"EVENTKEY"


def xor_whiten(data: bytearray, mac: bytes, vaddr0: int) -> None:
    """data[6..] を XOR ホワイトニング（in-place）。C21-6。

    鍵周期 4 = [vaddr[0], mac[3], mac[4], mac[5]]
    """
    key = [vaddr0, mac[3], mac[4], mac[5]]
    for i in range(len(data) - 6):
        data[6 + i] ^= key[i % 4]


def pr(b: bytes) -> str:
    return "".join(chr(x) if 32 <= x < 127 else "." for x in b)


def decrypt_pdu(raw: bytes, key: bytes, mac: bytes, vaddr0: int) -> bytes | None:
    """type 0x06 PDU を復号する。復号後の平文（data[6..] 部分）を返す。"""
    if len(raw) < 7 or (len(raw) - 6) % 16 != 0:
        return None
    buf = bytearray(raw)
    xor_whiten(buf, mac, vaddr0)
    body = bytes(buf[6:])
    return aes_dec(key, body)


def looks_plausible(pt: bytes) -> bool:
    """復号結果が意味を持つか簡易判定。

    平文 PDU の先頭は type(0x01/0x02/0x03) や既知 MSGID。
    末尾に PKCS 風パディングや 0 が並ぶ傾向。
    """
    if not pt:
        return False
    # 先頭が既知の PDU type / データイベント構造
    if pt[0] in (0x01, 0x02, 0x03, 0x04):
        return True
    # 末尾ゼロが多い（パディング）
    if pt[-4:] == b"\x00\x00\x00\x00":
        return True
    return False


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    # ⚠️ 認証情報をソースに埋めない。引数か環境変数 ODELIC_ID で渡す
    display_id = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ODELIC_ID", "")
    if not display_id:
        print("使い方: decrypt_full.py <8桁ID>   （または export ODELIC_ID=<8桁ID>）", file=sys.stderr)
        return 1
    KE = event_key(display_id)
    print(f"ID {display_id} → EVENTKEY {KE.hex()}")

    # 実機ログの recv type 0x06。送信元器具は EC:C5:7F:81:DE:CD（実機で確認）
    mac = bytes.fromhex("ECC57F81DECD")
    recv = [
        "060900000 0FFE3FA4FEF4BB4F7688670D733E7567BCE".replace(" ", ""),
        "0609000000247AC029A8A2F6AFC85E4986CDA73D14CE",
        "060900000024947228 7B0FF96ADEE1A2B1BC8EE37BA4".replace(" ", ""),
    ]

    print(f"\n仮定する器具 MAC: {mac.hex()}  (mac[3:6] = {mac[3:].hex()})")
    print("vaddr[0] を 0..255 で総当たりし、平文らしい結果を探す\n")

    for hexs in recv:
        raw = bytes.fromhex(hexs)
        print(f"=== PDU: {raw.hex()} ({len(raw)}B) ===")
        hits = []
        for v0 in range(256):
            pt = decrypt_pdu(raw, KE, mac, v0)
            if pt and looks_plausible(pt):
                hits.append((v0, pt))
        if hits:
            for v0, pt in hits:
                print(f"  ★ vaddr0=0x{v0:02X}: {pt.hex()}  |{pr(pt)}|")
        else:
            # ヒットなしでも vaddr0=0 の結果を参考表示
            pt = decrypt_pdu(raw, KE, mac, 0)
            print(f"  （平文候補なし）vaddr0=0x00: {pt.hex() if pt else 'N/A'}  |{pr(pt) if pt else ''}|")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
