"""libnative-lib.so の関数を逆アセンブルして呼び出し関係を追う。

ODELIC / Pairlink の暗号処理（processData / bafang_encrypt など）を
解析するための使い捨てツール。シンボルが全部残っているので、
関数名で指定して逆アセンブルし、BL（関数呼び出し）先を名前解決する。

    python tools/disasm.py <関数名>            # 1 関数を逆アセンブル
    python tools/disasm.py --calls <関数名>    # 呼び出している関数だけ一覧
    python tools/disasm.py --list              # エクスポート関数一覧
    python tools/disasm.py --xref <関数名>     # その関数を呼んでいる箇所
"""

from __future__ import annotations

import sys

import capstone
import lief

SO = "artifacts/so/lib/arm64-v8a/libnative-lib.so"

_bin = lief.parse(SO)

# アドレス → 名前 の辞書（エクスポート + シンボル）
_addr2name: dict[int, str] = {}
for f in _bin.exported_functions:
    _addr2name[f.address] = f.name
for s in _bin.symbols:
    if s.value and s.name:
        _addr2name.setdefault(s.value, s.name)


def _resolve_plt() -> None:
    """PLT スタブのアドレスを、GOT の relocation から名前解決して辞書に足す。

    ARM64 の PLT スタブは adrp x16,page; ldr x17,[x16,#off]; ... の形で
    GOT エントリを参照する。GOT は relocation で外部シンボルに結びつく。
    """
    import capstone as _cs

    plt = next((s for s in _bin.sections if s.name == ".plt"), None)
    if plt is None:
        return
    sym_by_got: dict[int, str] = {}
    for r in _bin.relocations:
        try:
            nm = r.symbol.name if r.symbol else ""
        except Exception:
            nm = ""
        if nm:
            sym_by_got[r.address] = nm

    data = bytes(plt.content)
    base = plt.virtual_address
    md = _cs.Cs(_cs.CS_ARCH_ARM64, _cs.CS_MODE_ARM)
    md.detail = True
    for stub in range(base, base + plt.size, 16):
        page = None
        for ins in md.disasm(data[stub - base : stub - base + 16], stub):
            if ins.mnemonic == "adrp":
                page = ins.operands[1].imm
            elif ins.mnemonic == "ldr" and page is not None:
                for op in ins.operands:
                    if op.type == _cs.arm64.ARM64_OP_MEM:
                        got = page + op.mem.disp
                        if got in sym_by_got:
                            # PLT スタブ = その外部シンボルの呼び出し口
                            _addr2name.setdefault(stub, sym_by_got[got])


_resolve_plt()

# 名前 → 実体アドレス。PLT スタブと実体が同名で衝突するので、
# エクスポート関数（実体）を優先する。
_name2addr = {v: k for k, v in _addr2name.items()}
for f in _bin.exported_functions:
    _name2addr[f.name] = f.address  # 実体で上書き


def _func_bytes(addr: int, max_len: int = 0x2000) -> bytes:
    """関数のバイト列を、次に既知のシンボルが現れるまで切り出す。"""
    starts = sorted(_addr2name)
    end = addr + max_len
    for s in starts:
        if s > addr:
            end = min(end, s)
            break
    # ファイルオフセットに変換して読む
    for sec in _bin.sections:
        if sec.virtual_address <= addr < sec.virtual_address + sec.size:
            off = addr - sec.virtual_address
            data = bytes(sec.content)
            return data[off : off + (end - addr)]
    return b""


def _md() -> capstone.Cs:
    md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)
    md.detail = True
    return md


def disasm(name: str, calls_only: bool = False) -> None:
    if name not in _name2addr:
        # アドレス直指定も許す
        try:
            addr = int(name, 16)
        except ValueError:
            print(f"シンボル {name} が見つかりません")
            return
    else:
        addr = _name2addr[name]

    data = _func_bytes(addr)
    md = _md()
    print(f"=== {name} @ {addr:#x}  ({len(data)} バイト) ===")
    calls = []
    for insn in md.disasm(data, addr):
        target_name = ""
        if insn.mnemonic in ("bl", "b", "blr") and insn.op_str.startswith("#"):
            try:
                t = int(insn.op_str[1:], 16)
                if t in _addr2name:
                    target_name = f"  -> {_addr2name[t]}"
                    if insn.mnemonic == "bl":
                        calls.append(_addr2name[t])
            except ValueError:
                pass
        if not calls_only:
            print(f"  {insn.address:#08x}  {insn.mnemonic:8s} {insn.op_str}{target_name}")
    if calls_only:
        print("呼び出している関数:")
        seen = set()
        for c in calls:
            if c not in seen:
                seen.add(c)
                print("  ", c)


def xref(name: str) -> None:
    """name を BL で呼んでいる関数を探す。"""
    if name not in _name2addr:
        print(f"シンボル {name} が見つかりません")
        return
    target = _name2addr[name]
    md = _md()
    print(f"=== {name} @ {target:#x} を呼んでいる箇所 ===")
    for caller, caddr in sorted(_name2addr.items(), key=lambda kv: kv[1]):
        if not isinstance(caddr, int):
            continue
        data = _func_bytes(caddr)
        for insn in md.disasm(data, caddr):
            if insn.mnemonic == "bl" and insn.op_str.startswith("#"):
                try:
                    if int(insn.op_str[1:], 16) == target:
                        print(f"  {caller} @ {insn.address:#x}")
                        break
                except ValueError:
                    pass


def got_xref(page_off_hex: str) -> None:
    """指定した GOT/データ変数（adrp #0x27000 + #offset）への参照を全関数から探す。

    ARM64 は `adrp x, #page; ldr/str x, [x, #off]` で変数にアクセスする。
    全エクスポート関数を舐めて adrp レジスタを追い、page+off が目標と一致する
    ldr（読み込み）/ str（書き込み）を記録する。書き込み箇所が「鍵を設定する場所」。
    """
    import capstone as _cs

    target = int(page_off_hex, 16)
    md = _md()
    print(f"=== GOT/データ変数 {target:#x} への参照 ===")
    hits_r, hits_w = [], []
    for fname, faddr in sorted(_name2addr.items(), key=lambda kv: kv[1]):
        if not isinstance(faddr, int):
            continue
        data = _func_bytes(faddr)
        regpage: dict[str, int] = {}
        for insn in md.disasm(data, faddr):
            m = insn.mnemonic
            if m == "adrp":
                ops = insn.operands
                if len(ops) == 2:
                    regpage[insn.reg_name(ops[0].reg)] = ops[1].imm
            elif m in ("ldr", "str", "ldrb", "strb", "add"):
                ops = insn.operands
                # add x, x, #imm も page 合成に使われる
                if m == "add" and len(ops) == 3 and ops[2].type == _cs.arm64.ARM64_OP_IMM:
                    base = insn.reg_name(ops[1].reg)
                    if base in regpage:
                        addr = regpage[base] + ops[2].imm
                        if addr == target:
                            hits_r.append((fname, insn.address, "add(addr計算)"))
                    continue
                for op in ops:
                    if op.type == _cs.arm64.ARM64_OP_MEM:
                        base = insn.reg_name(op.mem.base)
                        if base in regpage:
                            addr = regpage[base] + op.mem.disp
                            if addr == target:
                                if m.startswith("str"):
                                    hits_w.append((fname, insn.address, m))
                                else:
                                    hits_r.append((fname, insn.address, m))
    print("--- 書き込み（str）= 設定箇所 ---")
    for f, a, m in hits_w:
        print(f"  {f} @ {a:#x}  ({m})")
    if not hits_w:
        print("  （直接の str なし。ポインタ経由で書かれている可能性）")
    print("--- 読み込み（ldr）= 使用箇所 ---")
    for f, a, m in hits_r:
        print(f"  {f} @ {a:#x}  ({m})")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if not args or args[0] == "--list":
        for f in sorted(_bin.exported_functions, key=lambda x: x.address):
            print(f"  {f.address:#010x}  {f.name}")
        return 0
    if args[0] == "--calls":
        disasm(args[1], calls_only=True)
    elif args[0] == "--xref":
        xref(args[1])
    elif args[0] == "--gotxref":
        got_xref(args[1])
    else:
        disasm(args[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
