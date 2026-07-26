#!/usr/bin/python3
"""状態のバックアップと復元。⭐ **sudoers で許可する 3 本のうちの 1 本。**

    backup-helper.py --targets    対象のパスを 1 行 1 個で出す（root 不要）
    backup-helper.py --info       何がどれだけ入るかを JSON で出す
    backup-helper.py --export     ZIP を **標準出力**へ書く
    backup-helper.py --restore    ZIP を **標準入力**から読んで復元し、サービスを再起動する

## ⚠️⚠️ なぜ「専用ヘルパ 1 本だけ」なのか

`odelic-web` は非 root で動く。しかしバックアップ対象は
`/etc/default/odelicd`（0600 root）や Matter の fabric 鍵なので root が要る。

    /etc/sudoers.d/odelic-web:
      odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/set-id.sh
      odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/set-api.sh
      odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/backup-helper.py

⚠️ sudoers は**パスだけ**を許可するので、呼び出し側は任意の引数を渡せる。
   したがって **argv の検証はこのスクリプトの責務**。`set-id.sh` と同じ規律で、
   引数はちょうど 1 つ・既知の 4 つだけを受け付ける。

## ⚠️ なぜシェルではなく Python なのか

`--restore` は **他人が作った ZIP を root で展開する**。ここは
「エントリ名の検証」「シンボリックリンクの拒否」「所有者の復元」を
取りこぼしなくやる必要があり、シェルでは書き切れない。
⭐ `python3` は `odelicd` が必須にしているので、依存は増えていない。

## ⚠️⚠️ 中身は全部秘密情報

    /etc/default/odelicd    … 8 桁 ID（下位 4 桁はメッシュのパスワード）
    /var/lib/odelic-matter  … Matter の fabric 秘密鍵
    /etc/odelic-web/tls     … ⭐ ローカル CA の秘密鍵（漏れると偽サイトを作られる）
    /var/lib/odelic-web     … 設定ページのパスワードのハッシュ

⭐ この ZIP は **Pi ごと持ち出せる鍵束**。⚠️ 一時ファイルに落とさず
標準入出力で流す（`odelic-web` が読める場所に平文で置かない）。

## ⭐ 所有者は manifest で運ぶ

ZIP は所有者を保持しない。⚠️ 復元後に `root:root 0600` のまま起動すると、
非 root のサービスが読めず「パスワードが設定されていません」になる
（`reset-password.sh` に同じ罠の記録がある）。

→ `manifest.json` に **ユーザー名・グループ名・パーミッション**を書いて運び、
復元時に名前から解決して付け直す。⚠️ uid ではなく**名前**で持つ
（入れ直した Pi では uid が変わる）。
"""

from __future__ import annotations

import grp
import io
import json
import os
import platform
import posixpath
import pwd
import stat
import subprocess
import sys
import tempfile
import time
import zipfile

# ⭐ **対象の一覧はここが唯一の正。**`--targets` で外から読める
#    （`web/test/backup.test.ts` が絶対パスであることなどを検査している）。
# ⚠️ 足すときは「失うと復旧が重いもの」だけにする。ログや再生成できるものは入れない。
TARGETS = [
    "/var/lib/odelic-matter",  # ⭐ Matter の fabric 鍵・uniqueId・器具の名簿・設定
    "/var/lib/odelicd",        # 広告アドレス・コントローラ識別子（器具が覚えている）
    "/etc/default/odelicd",    # ⚠️ 8 桁 ID（メッシュのパスワードを含む）
    "/etc/odelic-matter",      # 器具名・ケルビン設定
    "/etc/odelic-web",         # ⭐ ローカル CA の鍵（失うと全端末で信頼をやり直し）
    "/var/lib/odelic-web",     # 設定ページのパスワード（scrypt ハッシュ）
]

SERVICES = ["odelicd", "odelic-matter", "odelic-web"]

MANIFEST = "manifest.json"
PREFIX = "files/"
FORMAT_VERSION = 1

# ⚠️ Pi 3 のメモリを守る。状態は実測で数百 KB なので 64 MB あれば十分すぎる
MAX_UPLOAD = 64 * 1024 * 1024


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def owner_names(st: os.stat_result) -> tuple[str, str]:
    """uid/gid を名前に直す。⚠️ 名前が引けなければ数値の文字列で持つ。"""
    try:
        user = pwd.getpwuid(st.st_uid).pw_name
    except KeyError:
        user = str(st.st_uid)
    try:
        group = grp.getgrgid(st.st_gid).gr_name
    except KeyError:
        group = str(st.st_gid)
    return user, group


def walk_targets() -> list[tuple[str, os.stat_result, bool]]:
    """対象を (絶対パス, stat, ディレクトリか) で列挙する。

    ⚠️ **シンボリックリンクは辿らず、入れない。**バックアップに入れても
    復元先で意味が変わるだけで、危険しかない。
    """
    out: list[tuple[str, os.stat_result, bool]] = []
    for target in TARGETS:
        if not os.path.lexists(target):
            continue
        st = os.lstat(target)
        if stat.S_ISLNK(st.st_mode):
            print(f"  スキップ（シンボリックリンク）: {target}", file=sys.stderr)
            continue
        if stat.S_ISDIR(st.st_mode):
            out.append((target, st, True))
            for root, dirs, files in os.walk(target, followlinks=False):
                for name in sorted(dirs):
                    p = os.path.join(root, name)
                    s = os.lstat(p)
                    if stat.S_ISLNK(s.st_mode):
                        continue
                    out.append((p, s, True))
                for name in sorted(files):
                    p = os.path.join(root, name)
                    s = os.lstat(p)
                    if not stat.S_ISREG(s.st_mode):
                        # ⚠️ シンボリックリンク・ソケット・デバイスは入れない
                        print(f"  スキップ（通常ファイルでない）: {p}", file=sys.stderr)
                        continue
                    out.append((p, s, False))
        elif stat.S_ISREG(st.st_mode):
            out.append((target, st, False))
    return out


# ---------------------------------------------------------------- --targets


def cmd_targets() -> int:
    for t in TARGETS:
        print(t)
    return 0


# ------------------------------------------------------------------- --info


def cmd_info() -> int:
    entries = walk_targets()
    per_target: list[dict] = []
    for target in TARGETS:
        files = [e for e in entries if e[0] == target or e[0].startswith(target.rstrip("/") + "/")]
        per_target.append({
            "path": target,
            "present": os.path.lexists(target),
            "files": sum(1 for e in files if not e[2]),
            "bytes": sum(e[1].st_size for e in files if not e[2]),
        })
    newest = max((e[1].st_mtime for e in entries), default=0.0)
    print(json.dumps({
        "formatVersion": FORMAT_VERSION,
        "targets": per_target,
        "files": sum(1 for e in entries if not e[2]),
        "bytes": sum(e[1].st_size for e in entries if not e[2]),
        "newestMtime": int(newest),
        "services": SERVICES,
    }, ensure_ascii=False))
    return 0


# ----------------------------------------------------------------- --export


def cmd_export() -> int:
    entries = walk_targets()
    if not any(not e[2] for e in entries):
        die("エラー: バックアップできるファイルが 1 つもありません")

    manifest = {
        "formatVersion": FORMAT_VERSION,
        "createdAt": int(time.time()),
        # ⚠️ `os.uname()` は Unix 専用。開発機（Windows）でも往復テストを
        #    動かしたいので、移植性のある `platform.node()` を使う
        "host": platform.node(),
        "entries": [],
    }
    for path, st, is_dir in entries:
        user, group = owner_names(st)
        manifest["entries"].append({
            "path": path,
            "type": "dir" if is_dir else "file",
            "mode": stat.S_IMODE(st.st_mode),
            "user": user,
            "group": group,
            "size": 0 if is_dir else st.st_size,
        })

    # ⚠️ `sys.stdout.buffer` に直接書く。⭐ 一時ファイルを作らないのが要点
    #    （秘密情報を `odelic-web` が読める場所に落とさない）。
    # ⚠️ zipfile は seek を要求しないが、ストリームに書くときは
    #    `allowZip64=True` のままにしておく（サイズ不定でも壊れない）。
    with zipfile.ZipFile(sys.stdout.buffer, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        z.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        for path, st, is_dir in entries:
            if is_dir:
                continue
            # ⚠️ 先頭の "/" を落として `files/` の下に入れる。
            #    これで復元側は「`files/` で始まること」だけ見れば済む
            zi = zipfile.ZipInfo(PREFIX + path.lstrip("/"), time.localtime(st.st_mtime)[:6])
            # ⭐ 種別ビット（`S_IFREG`）まで入れる。`writestr` の既定は
            #    `0o600 << 16`（種別ビットなし）で、`unzip` から見て型が不明になる
            zi.external_attr = (stat.S_IFREG | stat.S_IMODE(st.st_mode)) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(path, "rb") as fh:
                z.writestr(zi, fh.read())
    return 0


# ---------------------------------------------------------------- --restore


def safe_target(name: str) -> str:
    """ZIP のエントリ名を復元先の絶対パスに直す。⚠️ ここが最後の砦。

    受け付ける形は `files/<TARGETS のどれか>/...` だけ。
    それ以外は例外にする（`..` / 絶対パス / 別のディレクトリを弾く）。
    """
    if not name.startswith(PREFIX):
        raise ValueError(f"想定外のエントリ: {name}")
    rel = name[len(PREFIX):]
    if rel == "" or rel.endswith("/"):
        raise ValueError(f"ファイル名が空です: {name}")
    # ⚠️ Windows 由来の ZIP は "\" を混ぜてくる。区切りとして扱って弾く
    if "\\" in rel or rel.startswith("/"):
        raise ValueError(f"不正な区切りです: {name}")
    # ⚠️ **`posixpath` を明示する。**ZIP のエントリ名は仕様上つねに "/" 区切りで、
    #    復元先も POSIX の絶対パス。`os.path` にすると走らせる OS で挙動が変わり、
    #    開発機（Windows）でこの検証をテストできなくなる
    abspath = posixpath.normpath("/" + rel)
    if ".." in abspath.split("/"):
        raise ValueError(f"親ディレクトリを含みます: {name}")
    for target in TARGETS:
        t = target.rstrip("/")
        if abspath == t or abspath.startswith(t + "/"):
            return abspath
    raise ValueError(f"復元対象の外を指しています: {abspath}")


def apply_owner(path: str, spec: dict) -> None:
    """manifest のユーザー名・グループ名・パーミッションを付け直す。

    ⚠️⚠️ ここを飛ばすと `root:root` のまま残り、非 root のサービスが
    自分の状態ファイルを読めなくなる（起動はするのに動かない、が起きる）。
    """
    mode = spec.get("mode")
    if isinstance(mode, int):
        os.chmod(path, mode & 0o7777)
    user, group = spec.get("user"), spec.get("group")
    uid = gid = -1
    if isinstance(user, str):
        try:
            uid = pwd.getpwnam(user).pw_uid
        except KeyError:
            # ⚠️ 黙って root のままにしない。何が起きたか必ず出す
            print(f"  ⚠️ ユーザー {user} がいません（{path} の所有者は変えません）", file=sys.stderr)
    if isinstance(group, str):
        try:
            gid = grp.getgrnam(group).gr_gid
        except KeyError:
            print(f"  ⚠️ グループ {group} がいません（{path}）", file=sys.stderr)
    if uid != -1 or gid != -1:
        os.chown(path, uid, gid)


def cmd_restore() -> int:
    blob = sys.stdin.buffer.read(MAX_UPLOAD + 1)
    if len(blob) > MAX_UPLOAD:
        die(f"エラー: ZIP が大きすぎます（上限 {MAX_UPLOAD // 1024 // 1024} MB）")
    if not blob:
        die("エラー: 標準入力が空です")

    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as e:
        die(f"エラー: ZIP として読めません（{e}）")

    bad = z.testzip()
    if bad is not None:
        die(f"エラー: ZIP が壊れています（{bad}）")

    try:
        manifest = json.loads(z.read(MANIFEST).decode("utf-8"))
    except (KeyError, ValueError) as e:
        die(f"エラー: {MANIFEST} が読めません。このプロジェクトのバックアップですか？（{e}）")
    if manifest.get("formatVersion") != FORMAT_VERSION:
        die(f"エラー: 形式のバージョンが違います（このヘルパは {FORMAT_VERSION}）")

    by_path = {e["path"]: e for e in manifest.get("entries", []) if isinstance(e, dict) and "path" in e}

    # ⚠️ **展開の前に全エントリを検証する。**1 個でも怪しければ何もせず終わる
    #    （半分だけ復元された状態がいちばん困る）
    plan: list[tuple[str, str]] = []   # (ZIP のエントリ名, 復元先)
    for zi in z.infolist():
        if zi.filename == MANIFEST:
            continue
        if zi.is_dir():
            continue
        # ⚠️ ZIP は unix のモードを external_attr の上位 16 bit に入れている。
        #    シンボリックリンクやデバイスを root で作らせない。
        # ⚠️⚠️ **ファイル種別ビットが「無い」場合を通すこと。**`zipfile.writestr` は
        #    `0o600 << 16`（種別ビットなし）を書くので、`S_ISREG` で判定すると
        #    **自分で作ったバックアップまで拒否してしまう**（実際に踏んだ）。
        #    種別ビットが立っていて、かつ通常ファイルでないものだけを弾く。
        ftype = stat.S_IFMT(zi.external_attr >> 16)
        if ftype not in (0, stat.S_IFREG):
            die(f"エラー: 通常ファイルでないエントリがあります: {zi.filename}")
        try:
            dest = safe_target(zi.filename)
        except ValueError as e:
            die(f"エラー: {e}")
        plan.append((zi.filename, dest))

    if not plan:
        die("エラー: 復元できるファイルが 1 つもありません")

    print(f"=== 復元 ===", file=sys.stderr)
    print(f"  {len(plan)} ファイル / 作成日時 {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(manifest.get('createdAt', 0)))}", file=sys.stderr)

    # ⭐ サービスを止めてから入れ替える。動いているまま状態を差し替えると
    #    メモリ上の古い状態で上書きし直される
    for svc in SERVICES:
        subprocess.run(["systemctl", "stop", svc], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    restored = 0
    try:
        for name, dest in plan:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # ⚠️ 同じディレクトリに一時ファイルを作って rename する。
            #    途中で電源が落ちても半端な中身のファイルが残らない
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".restore-")
            try:
                with os.fdopen(fd, "wb") as out:
                    out.write(z.read(name))
                # ⚠️ rename の前に権限を付ける（一瞬でも 0644 で置かない）
                spec = by_path.get(dest)
                if spec is None:
                    # manifest に無いファイルは控えめな既定にする
                    os.chmod(tmp, 0o600)
                else:
                    apply_owner(tmp, spec)
                os.replace(tmp, dest)
                restored += 1
            except BaseException:
                os.unlink(tmp)
                raise

        # ⭐ ディレクトリの所有者とモードも戻す（**深い順**に当てる）
        for spec in sorted(
            (e for e in manifest.get("entries", []) if e.get("type") == "dir"),
            key=lambda e: len(str(e.get("path", ""))), reverse=True,
        ):
            p = spec.get("path")
            if isinstance(p, str) and os.path.isdir(p):
                try:
                    safe_target(PREFIX + p.lstrip("/"))
                except ValueError:
                    continue
                apply_owner(p, spec)
    finally:
        # ⚠️ 失敗しても必ず起動し直す。止まったままにしない
        for svc in SERVICES:
            subprocess.run(["systemctl", "start", svc], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print(json.dumps({"restored": restored, "services": SERVICES}, ensure_ascii=False))
    return 0


# -------------------------------------------------------------------- main


def main(argv: list[str]) -> int:
    # ⚠️⚠️ **引数の検証を最初にやる**（root チェックより前）。
    #    ここが最後の砦なので、権限の話とは独立に必ず通るようにしておく
    if len(argv) != 1:
        die("使い方: backup-helper.py --targets | --info | --export | --restore", 2)
    action = argv[0]
    if action == "--targets":
        return cmd_targets()

    if os.geteuid() != 0:
        die("エラー: root で実行してください（sudo 経由で呼ばれます）")

    if action == "--info":
        return cmd_info()
    if action == "--export":
        return cmd_export()
    if action == "--restore":
        return cmd_restore()
    die("使い方: backup-helper.py --targets | --info | --export | --restore", 2)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
