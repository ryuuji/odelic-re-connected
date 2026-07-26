"""器具のファームウェア（APK 同梱の OTA イメージ）を解析する。

`assets/ota/*.mp3` は音声ではなく **ARM Cortex-M（Thumb-2）の生イメージ**。
暗号化も圧縮もされていない（`OtaUpgrader_pairlink` はファイルを 20 バイトずつ
そのまま書き込むだけ。CRC32 を添えるのみ）。

ファイル名は `<version_product>_<major>_<minor>.mp3`。
`version_product` は Ping 応答の `[16..17]`（リトルエンディアン 16bit）と同じ値。
⚠️ 手元の器具は 21184（0x52C0）なので、この APK には該当ファイルがない。
同じ Pairlink SDK 系のため、コマンド解釈のロジックは共通と考えられる。

使い方:

    python docs/analysis/tools/fw_analyze.py info    <fw>            # 全体像・文字列・基底アドレス推定
    python docs/analysis/tools/fw_analyze.py find    <fw> C0 70 71   # cmp #imm を探す（MSGID の分岐）
    python docs/analysis/tools/fw_analyze.py disasm  <fw> <offset> [n]
    python docs/analysis/tools/fw_analyze.py strings <fw> [最小長]

`offset` はファイル先頭からのバイト位置（16 進なら 0x 付き）。
"""

from __future__ import annotations

import collections
import math
import re
import sys

import capstone

# 新しいイメージだけ先頭に 4 バイトの前置きがある（実測 18 01 00 00 = 0x118）。
# 共通の本体はこのバイト列から始まる
BODY_MAGIC = bytes.fromhex("A21A006C")


def load(path: str) -> tuple[bytes, int]:
    """(データ, 本体オフセット) を返す。"""
    d = open(path, "rb").read()
    off = d.find(BODY_MAGIC)
    return d, (off if 0 <= off <= 16 else 0)


def entropy(d: bytes) -> float:
    c = collections.Counter(d)
    return -sum(n / len(d) * math.log2(n / len(d)) for n in c.values())


def md() -> capstone.Cs:
    m = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
    m.detail = True
    return m


def cmd_info(path: str) -> None:
    d, body = load(path)
    print(f"=== {path} ===")
    print(f"サイズ {len(d)} バイト / 本体オフセット {body}")
    if body:
        print(f"前置き {body} バイト: {d[:body].hex(' ').upper()}"
              f"  (LE u32 = 0x{int.from_bytes(d[:4], 'little'):08X})")
    print(f"エントロピー {entropy(d):.2f} bit/byte（8.0 に近いと暗号化・圧縮の疑い）")
    print(f"ゼロ率 {d.count(0) / len(d) * 100:.1f}%")

    h = collections.Counter(d)
    top = "".join(f" {b:02X}×{n}" for b, n in h.most_common(8))
    print(f"頻出バイト:{top}")
    print("  → 46(MOV) / F0 F6 F8(Thumb-2 32bit プレフィクス) / 70 47(BX LR) が多ければ Thumb コード")
    print(f"  BX LR (70 47) の出現数: {d.count(bytes([0x70, 0x47]))}")

    # 32bit ワードのうち「小さな値」に集まる範囲を見て基底アドレスを推定する
    words = collections.Counter()
    for i in range(body, len(d) - 3, 2):
        w = int.from_bytes(d[i : i + 4], "little")
        if 0 < w < 0x10000000:
            words[w >> 12] += 1  # 4KB 単位でヒストグラム
    print("\n32bit ワードの分布（4KB 単位・上位 8 件）:")
    for page, n in words.most_common(8):
        print(f"  0x{page << 12:08X} 〜  {n} 件")
    print("  → コードを指すポインタが集まる範囲が基底アドレスの候補")

    s = strings_of(d, 6)
    print(f"\n文字列 {len(s)} 件のうち意味の読めるもの:")
    for x in s:
        if re.match(r"^[A-Za-z][A-Za-z0-9 _:,.()/+-]{5,}$", x):
            print(f"  {x!r}")


def strings_of(d: bytes, minlen: int = 5) -> list[str]:
    return [m.group().decode("ascii") for m in re.finditer(rb"[ -~]{%d,}" % minlen, d)]


def cmd_strings(path: str, minlen: int = 6) -> None:
    d, _ = load(path)
    for s in strings_of(d, minlen):
        print(s)


def cmd_disasm(path: str, offset: int, count: int = 40) -> None:
    d, body = load(path)
    m = md()
    print(f"=== {path} +0x{offset:X} ===")
    for i, ins in enumerate(m.disasm(d[offset : offset + count * 4], offset)):
        if i >= count:
            break
        print(f"  +0x{ins.address:05X}  {ins.mnemonic:<8} {ins.op_str}")


def cmd_find(path: str, imms: list[int]) -> None:
    """`cmp rX, #imm` を全部探す。MSGID やサブコマンドの分岐を見つけるため。"""
    d, body = load(path)
    m = md()
    want = set(imms)
    hits: dict[int, list[int]] = {v: [] for v in want}

    # Thumb は 2 バイト境界。オフセットをずらしながら線形に走査する
    for start in (body, body + 1):
        for ins in m.disasm(d[start:], start):
            if ins.mnemonic in ("cmp", "cmn", "subs") and len(ins.operands) >= 2:
                op = ins.operands[-1]
                if op.type == capstone.arm.ARM_OP_IMM and op.imm in want:
                    hits[op.imm].append(ins.address)

    for v in imms:
        addrs = sorted(set(hits[v]))
        print(f"\n=== cmp #0x{v:02X} ({v}) — {len(addrs)} 箇所 ===")
        for a in addrs[:12]:
            print(f"  +0x{a:05X}")
        if len(addrs) > 12:
            print(f"  … 他 {len(addrs) - 12} 箇所")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    sub, path = sys.argv[1], sys.argv[2]
    rest = sys.argv[3:]

    def num(x: str) -> int:
        return int(x, 16) if x.lower().startswith("0x") else int(x, 16 if sub == "find" else 10)

    if sub == "info":
        cmd_info(path)
    elif sub == "strings":
        cmd_strings(path, int(rest[0]) if rest else 6)
    elif sub == "disasm":
        cmd_disasm(path, num(rest[0]), int(rest[1]) if len(rest) > 1 else 40)
    elif sub == "find":
        cmd_find(path, [num(x) for x in rest] or [0xC0, 0x70, 0x71])
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
