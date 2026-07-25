#!/usr/bin/env python3
"""libnative-lib.so を dlopen して AES 復号関数を直接呼ぶ（案 J の検証）。

.so は arm64、Pi も aarch64 なので ABI 互換。独自 S-box でも
.so 自身に計算させれば正しい結果が得られる。

まず「送信 Ping の平文が再現できるか」で鍵と関数の正しさを答え合わせし、
次に受信 type 0x06 を復号する。

    sudo python3 decrypt_probe.py

⚠️ Android bionic と glibc で TLS レイアウト（スタックカナリア）が違うため、
__stack_chk_fail を使う関数は落ちる可能性がある。その場合はログに出る。
"""

from __future__ import annotations

import ctypes
import struct
import sys

SO = "/tmp/libnative-lib.so"


def hx(b: bytes) -> str:
    return " ".join(f"{x:02X}" for x in b)


def build_key(homeid_le: bytes, pwd: bytes, suffix: bytes) -> bytes:
    """setHomeidPassword の鍵導出（C21-2）。"""
    inter = bytes(
        [
            homeid_le[0], pwd[0], homeid_le[1], pwd[1],
            homeid_le[2], pwd[2], homeid_le[3], pwd[3],
        ]
    )
    return inter + suffix


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    try:
        lib = ctypes.CDLL(SO, mode=ctypes.RTLD_GLOBAL)
    except OSError as e:
        print(f"[dlopen 失敗] {e}")
        print("→ liblog.so スタブの LD_PRELOAD が必要。run-decrypt.sh 経由で実行してください。")
        return 1
    print(f"[dlopen OK] {SO}")

    # 関数シグネチャ（C21-3 / 逆アセンブルより）
    #   int aes_set_key(void* ctx, const u8* key, int bits)
    #   int AES_ECB_encrypt(void* ctx, u8* out, const u8* in, int len)
    #   int AES_ECB_decrypt(void* ctx, const u8* in, u8* out, int len)
    for name in ("aes_set_key", "AES_ECB_encrypt", "AES_ECB_decrypt",
                 "AES_ECB_decrypt_nopadding"):
        if not hasattr(lib, name):
            print(f"[!] シンボル {name} が見つかりません")
    aes_set_key = lib.aes_set_key
    aes_set_key.restype = ctypes.c_int
    aes_set_key.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    enc = lib.AES_ECB_encrypt
    enc.restype = ctypes.c_int
    enc.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    dec = lib.AES_ECB_decrypt
    dec.restype = ctypes.c_int
    dec.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]

    CTX = 0x140  # 余裕をもって確保（実際は 0x120 程度）

    def set_key(key: bytes):
        ctx = ctypes.create_string_buffer(CTX)
        r = aes_set_key(ctx, key, 128)
        return ctx, r

    def ecb_enc(key: bytes, pt: bytes) -> bytes:
        ctx, r = set_key(key)
        out = ctypes.create_string_buffer(len(pt))
        rc = enc(ctx, out, pt, len(pt))
        return out.raw[: len(pt)], rc

    def ecb_dec(key: bytes, ct: bytes) -> bytes:
        ctx, r = set_key(key)
        out = ctypes.create_string_buffer(len(ct))
        rc = dec(ctx, ct, out, len(ct))
        return out.raw[: len(ct)], rc

    # --- 鍵（現在の ID 99833900）---
    homeid = struct.pack("<I", 9983)  # FF 26 00 00
    pwd = b"3900"
    KL = build_key(homeid, pwd, b"LOGINKEY")
    KE = build_key(homeid, pwd, b"EVENTKEY")
    print(f"鍵1(LOGIN): {hx(KL)}")
    print(f"鍵2(EVENT): {hx(KE)}")

    # --- 答え合わせ 1: 送信 Ping の平文 → 暗号文を再現 ---
    # 平文 payload = own_vaddr 09 00 00 00 を 16 にパディング
    # 暗号文ブロック（実機ログ sent）
    ping_block = bytes.fromhex("b39dc6d8fa6692aa830f9616bfe5682b")
    print("\n=== 答え合わせ: 送信 Ping ===")
    print(f"期待する暗号文ブロック: {hx(ping_block)}")
    payload = bytes([0x09, 0x00, 0x00, 0x00])
    hit = False
    for kn, key in (("EVENT", KE), ("LOGIN", KL)):
        for padval in range(256):
            pt = payload + bytes([padval]) * 12
            out, rc = ecb_enc(key, pt)
            if out == ping_block:
                print(f"  ★一致! key={kn} pad=0x{padval:02X} rc={rc}")
                print(f"    → .so の AES で送信暗号化を再現できた")
                hit = True
                break
        if hit:
            break
    if not hit:
        # enc がだめでも dec の可能性（ECB は enc/dec 非対称）
        for kn, key in (("EVENT", KE), ("LOGIN", KL)):
            out, rc = ecb_dec(key, ping_block)
            print(f"  dec[{kn}] rc={rc}: {hx(out)}  |{ascii_of(out)}|")

    # --- 受信 type 0x06 を復号 ---
    print("\n=== 受信 type 0x06 の復号 ===")
    recv_blocks = [
        "e3fa4fef4bb4f7688670d733e7567bce",
        "7ac029a8a2f6afc85e4986cda73d14ce",
    ]
    for hexs in recv_blocks:
        ct = bytes.fromhex(hexs)
        print(f"\n  暗号文: {hx(ct)}")
        for kn, key in (("EVENT", KE), ("LOGIN", KL)):
            out, rc = ecb_dec(key, ct)
            print(f"    dec[{kn}] rc={rc}: {hx(out)}  |{ascii_of(out)}|")
    return 0


def ascii_of(b: bytes) -> str:
    return "".join(chr(x) if 32 <= x < 127 else "." for x in b)


if __name__ == "__main__":
    sys.exit(main())
