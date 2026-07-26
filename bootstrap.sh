#!/bin/sh
# ODELIC 照明を Raspberry Pi から操作する一式を入れる（1 行インストーラ）。
#
#   curl -fsSL https://raw.githubusercontent.com/ryuuji/odelic-re-connected/main/bootstrap.sh | sudo sh -s -- 12345678
#
#   ⭐ 1 行にしてある。行継続（\）を挟むと、端末やチャットに貼ったときに
#      改行が落ちて `sh` が引数を受け取り損ねることがある。
#
# ⚠️ `sh -s --` が要る。`curl | sudo sh 12345678` では引数が sh 自身に渡ってしまう。
#
# ## ⚠️ なぜ install.sh を直接 curl できないのか
#
# `install.sh` は**リポジトリ全体**（`odelicd/` `common/` `matter/` `web/`）を配る。
# 1 本のスクリプトだけ落としても中身が無い。
# → ⭐ **このスクリプトがソースを取ってきて `install.sh` を呼ぶ。**
#
# ## ⭐ 何をするか
#
#   1. tar と curl があるか見る（無ければ apt で入れる）
#   2. GitHub からソースの tarball を取る（既定は最新のタグ、無ければ main）
#   3. 展開して `install.sh` を実行する
#
# ⚠️ **git は要求しない。**Pi OS Lite に入っていないことがあるため tarball にする。
#
# ## ⚠️ 8 桁 ID の扱い
#
# 引数に渡すので **`ps` に一瞬見える**（下位 4 桁はメッシュのパスワード）。
# 気になる場合は tarball を自分で展開して `sudo ./install.sh` を対話的に叩くこと。
# ⭐ 保存先は `/etc/default/odelicd`（0600 root）で、そこから先は漏れない。

set -eu

REPO="${ODELIC_REPO:-ryuuji/odelic-re-connected}"
# ⭐ 空なら最新のタグを調べる。タグが無ければ main に落ちる
REF="${ODELIC_REF:-}"
WORKDIR="${ODELIC_WORKDIR:-/usr/local/src}"

say() { echo "$@"; }
die() { echo "$@" >&2; exit 1; }

# ------------------------------------------------------------------ 引数

ID=""
EXTRA=""
for a in "$@"; do
    case "$a" in
        --*) EXTRA="$EXTRA $a" ;;
        *) if [ -z "$ID" ]; then ID="$a"; else EXTRA="$EXTRA $a"; fi ;;
    esac
done

if [ "$(id -u)" != 0 ]; then
    die "エラー: root で実行してください:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/bootstrap.sh | sudo sh -s -- <8桁ID>"
fi
if [ -z "$ID" ]; then
    die "エラー: 公式アプリのメニュー画面に出ている 8 桁 ID を渡してください:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/bootstrap.sh | sudo sh -s -- 12345678"
fi
# ⚠️ ここでも形を見る（install.sh でも再検証する）
case "$ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "エラー: ID は 8 桁の数字です（上位 4 桁 = HOMEID、下位 4 桁 = パスワード）" ;;
esac

say "================================================================"
say "  ODELIC Re-Connected — インストール"
say "================================================================"
say "  リポジトリ: $REPO"
say "  ホーム ID : $(echo "$ID" | cut -c1-4)****   （下位 4 桁は伏せます）"
say ""

# -------------------------------------------------------------- 前提の道具

need_apt=""
for cmd in curl tar; do
    command -v "$cmd" >/dev/null 2>&1 || need_apt="$need_apt $cmd"
done
if [ -n "$need_apt" ]; then
    say "=== 必要な道具を入れます:$need_apt ==="
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y $need_apt
fi

# ------------------------------------------------------------ ソースの取得

if [ -z "$REF" ]; then
    say "=== 最新のリリースを調べます ==="
    # ⭐ API を 1 回叩くだけ。⚠️ 失敗しても止めない（main に落ちる）
    REF="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1 || true)"
    if [ -z "$REF" ]; then
        say "  リリースが見つからないので main を使います"
        REF=main
    else
        say "  $REF"
    fi
fi

TARBALL="https://codeload.github.com/$REPO/tar.gz/$REF"
DEST="$WORKDIR/odelic-re-connected"

say ""
say "=== ソースを取得します ==="
say "  $TARBALL"
mkdir -p "$WORKDIR"
TMP="$(mktemp -d)"
# ⚠️ 途中で失敗しても一時ディレクトリを残さない
trap 'rm -rf "$TMP"' EXIT INT TERM

if ! curl -fsSL "$TARBALL" | tar xz -C "$TMP"; then
    die "エラー: ソースを取得できませんでした。
  リポジトリが公開されているか、$REF が存在するかを確認してください:
    https://github.com/$REPO"
fi

# tarball は `<repo>-<ref>/` という 1 階層に入っている
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[ -n "$SRC" ] || die "エラー: 展開した中身が見つかりません"
[ -f "$SRC/install.sh" ] || die "エラー: $SRC に install.sh がありません"

# ⭐ 前回のソースは残しておく（設定は /etc 側なので消えないが、差分を見たいことがある）
if [ -d "$DEST" ]; then
    say "  既存のソースを $DEST.prev に退避します"
    rm -rf "$DEST.prev"
    mv "$DEST" "$DEST.prev"
fi
mv "$SRC" "$DEST"
say "  $DEST に展開しました"

# ⚠️⚠️ tarball の実行ビットは当てにできない（git 側が 100644 だと落ちる）。
#    ⭐ ここで全部立て直す。落ちていると `Permission denied` で止まる
find "$DEST" -name "*.sh" -exec chmod +x {} + 2>/dev/null || true
chmod +x "$DEST/web/backup-helper.py" 2>/dev/null || true

# ---------------------------------------------------------------- 本体へ

say ""
say "=== インストーラを実行します ==="
say ""
cd "$DEST"
# shellcheck disable=SC2086
exec ./install.sh "$ID" $EXTRA
