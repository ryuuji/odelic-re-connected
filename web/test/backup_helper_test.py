#!/usr/bin/env python3
"""backup-helper.py の export → restore の往復と、パス検証を検証する。

root も Pi も要らない。TARGETS を一時ディレクトリに差し替え、
`systemctl` と `chown` を潰して動かす。

    python testhelper.py <backup-helper.py のパス>
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import pathlib
import sys
import shutil
import tempfile
import zipfile

HELPER = sys.argv[1]

# ⚠️ `pwd` / `grp` は Unix 専用。開発機（Windows）でも読み込めるようスタブを入れる。
#    ⭐ ヘルパ側を書き換えるのではなく、テスト側で用意する（本番は本物を使う）
import types

if "pwd" not in sys.modules:
    _pwd = types.ModuleType("pwd")
    _pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name="root")
    _pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=0) if name == "root" else (_ for _ in ()).throw(KeyError(name))
    sys.modules["pwd"] = _pwd
if "grp" not in sys.modules:
    _grp = types.ModuleType("grp")
    _grp.getgrgid = lambda gid: types.SimpleNamespace(gr_name="root")
    _grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=0) if name == "root" else (_ for _ in ()).throw(KeyError(name))
    sys.modules["grp"] = _grp

spec = importlib.util.spec_from_file_location("helper", HELPER)
h = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(h)

fails: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond:
        fails.append(msg)


# ---------------------------------------------------- パス検証（ここが本題）

# ⚠️ ヘルパは **POSIX の絶対パス**を前提にしている（Pi 上ではつねにそう）。
#    ⭐ POSIX なら普通の一時ディレクトリでよい（`/tmp/...` は既に POSIX 絶対パス）。
#    ⚠️ Windows では `/x` が「カレントドライブの直下」に解決されるのを利用する
#      （`C:\...` のままだと posixpath の検証が通らない）。
if os.name == "posix":
    root = tempfile.mkdtemp(prefix="odelic-bk-")
else:
    root = "/odelic-bk-test"
shutil.rmtree(root, ignore_errors=True)
h.TARGETS = [root + "/etc/odelic-web", root + "/var/odelicd.conf"]

print("=== safe_target の検証（root で展開するので、ここが最後の砦） ===")
allowed = h.TARGETS[0].lstrip("/") + "/tls/ca.key"
try:
    got = h.safe_target(h.PREFIX + allowed)
    check(got == "/" + allowed, f"許可された配下は通る（{got}）")
except ValueError as e:
    check(False, f"許可された配下が通らない: {e}")

for bad in [
    "files/etc/passwd",                       # 対象外のディレクトリ
    "files/../etc/passwd",                    # 親ディレクトリ
    "files//etc/shadow",                      # 先頭が / に見える形
    "etc/odelic-web/x",                       # prefix が無い
    "files/" + allowed.replace("/", "\\"),    # Windows の区切り
    "manifest.json",                          # manifest は別扱い（ここでは拒否が正しい）
    "files/",                                 # 空
]:
    try:
        h.safe_target(bad)
        check(False, f"弾けていない: {bad!r}")
    except ValueError:
        check(True, f"弾いた: {bad!r}")

# 対象の名前で始まるが別ディレクトリ（prefix 一致の罠）
sneaky = h.PREFIX + h.TARGETS[0].lstrip("/") + "-evil/x"
try:
    h.safe_target(sneaky)
    check(False, "「対象名 + 接尾辞」の別ディレクトリを弾けていない")
except ValueError:
    check(True, "「対象名 + 接尾辞」の別ディレクトリを弾いた")

# ---------------------------------------------------------- export → restore

print()
print("=== export → restore の往復 ===")
conf = pathlib.Path(h.TARGETS[1])
conf.parent.mkdir(parents=True, exist_ok=True)
conf.write_text("ODELIC_ID=12345678\nODELIC_PORT=8080\n", encoding="utf-8")
os.chmod(conf, 0o600)

tls = pathlib.Path(h.TARGETS[0]) / "tls"
tls.mkdir(parents=True, exist_ok=True)
(tls / "ca.key").write_text("-----BEGIN PRIVATE KEY-----\nfake\n", encoding="utf-8")
os.chmod(tls / "ca.key", 0o600)
(pathlib.Path(h.TARGETS[0]) / "config.json").write_text('{"port":8443}\n', encoding="utf-8")

info = h.walk_targets()
check(any(p.endswith("ca.key") for p, _, d in info if not d), "ca.key が列挙される")
check(any(d for _, _, d in info), "ディレクトリも列挙される")

# ⚠️ シンボリックリンクは入らないこと
link = pathlib.Path(h.TARGETS[0]) / "link-to-shadow"
try:
    os.symlink("/etc/shadow", link)
    info2 = h.walk_targets()
    check(not any("link-to-shadow" in p for p, _, _ in info2), "シンボリックリンクは入らない")
    link.unlink()
except OSError:
    print("  --  シンボリックリンクを作れない環境なので飛ばす")

# export（stdout を差し替えて拾う）
buf = io.BytesIO()


class FakeStdout:
    buffer = buf


real_stdout, sys.stdout = sys.stdout, FakeStdout()
try:
    rc = h.cmd_export()
finally:
    sys.stdout = real_stdout
check(rc == 0, "cmd_export が成功する")

data = buf.getvalue()
check(len(data) > 0, f"ZIP が出力された（{len(data)} バイト）")
z = zipfile.ZipFile(io.BytesIO(data))
names = z.namelist()
check(h.MANIFEST in names, "manifest.json が入っている")
man = json.loads(z.read(h.MANIFEST))
check(man["formatVersion"] == h.FORMAT_VERSION, "formatVersion が入っている")
check(all(n == h.MANIFEST or n.startswith(h.PREFIX) for n in names), "全エントリが files/ 配下")
modes = {e["path"]: e["mode"] for e in man["entries"]}
conf_key = h.TARGETS[1]
check(isinstance(modes.get(conf_key), int), f"パーミッションが manifest に入る（{oct(modes.get(conf_key, -1)) if isinstance(modes.get(conf_key), int) else 'なし'}）"
      + "  ⚠️ Windows では 0600 を再現できないので値は見ない")

# 中身を壊してから restore で戻ることを確認
conf.write_text("ODELIC_ID=99999999\n", encoding="utf-8")
(tls / "ca.key").unlink()

h.subprocess.run = lambda *a, **k: None          # systemctl を潰す
h.os.chown = lambda *a, **k: None                # 非 root でも動かす
sys.stdin = type("S", (), {"buffer": io.BytesIO(data)})()
real_stdout, sys.stdout = sys.stdout, io.StringIO()
try:
    rc = h.cmd_restore()
    out = sys.stdout.getvalue()
finally:
    sys.stdout = real_stdout
check(rc == 0, "cmd_restore が成功する")
check(conf.read_text(encoding="utf-8").startswith("ODELIC_ID=12345678"), "壊した設定が戻った")
check((tls / "ca.key").exists(), "消した CA の鍵が戻った")
check(json.loads(out)["restored"] >= 3, f"復元件数が報告される（{out.strip()}）")

# ⚠️ 細工した ZIP を拒否すること
print()
print("=== 細工した ZIP の拒否 ===")
evil = io.BytesIO()
with zipfile.ZipFile(evil, "w") as ez:
    ez.writestr(h.MANIFEST, json.dumps({"formatVersion": h.FORMAT_VERSION, "entries": []}))
    ez.writestr("files/../../etc/passwd", "root::0:0:")
sys.stdin = type("S", (), {"buffer": io.BytesIO(evil.getvalue())})()
try:
    real_stdout, sys.stdout = sys.stdout, io.StringIO()
    try:
        h.cmd_restore()
    finally:
        sys.stdout = real_stdout
    check(False, "パストラバーサルを拒否していない")
except SystemExit as e:
    check(e.code == 1, "パストラバーサルの ZIP を拒否した")

print()
print("✅ すべて通った" if not fails else f"❌ {len(fails)} 件失敗")

shutil.rmtree(root, ignore_errors=True)
raise SystemExit(1 if fails else 0)
