#!/bin/bash
# @odelic/common を Raspberry Pi に配置する（matter / web が参照する共有パッケージ）。
#
#   使い方: sudo ./install.sh          # 冪等。matter/install.sh と web/install.sh が呼ぶ
#           sudo ./install.sh --skip-test
#
# ## ⚠️⚠️ なぜこれが要るのか（踏んだ罠）
#
# `matter` と `web` の package.json は `"@odelic/common": "file:../common"` と書いてある。
# これは**リポジトリの中では正しい**（common と matter が兄弟なので）。
#
# ⚠️ しかし Pi では配置先が `/opt/odelic-matter` なので、`file:../common` は
#    **`/opt/common`** を指してしまう。そんなディレクトリは無い。
#    実際、この修正を入れるまで Pi の `/opt/odelic-matter/node_modules/@odelic` は
#    **存在しなかった**（分離前の古い dist が残っていたので動いていただけ）。
#
# → ⭐ 中身は名前で分かる **`/opt/odelic-common`** に置き、
#   **`/opt/common` をそこへのシンボリックリンク**にする。
#
# ⭐ こうすると `package.json` も `package-lock.json` も**書き換えずに済む**。
#    パスを書き換えるとロックが使えなくなり `npm ci` が `npm install` に落ちるので、
#    matter.js のバージョンが勝手に上がりかねない。再現可能なインストールを守るほうを取った。

set -euo pipefail

DEST=/opt/odelic-common
LINK=/opt/common          # ⭐ `file:../common` が /opt/... から解決される先
SRC="$(cd "$(dirname "$0")" && pwd)"
SKIP_TEST=0
[ "${1:-}" = "--skip-test" ] && SKIP_TEST=1

if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0 ...）" >&2
    exit 1
fi

echo "=== @odelic/common を $DEST に配置 ==="
install -d -m 0755 "$DEST"
# ⚠️ 消してから配る。tsc は削除されたソースの出力を消さないので、
#    古い .js が残ると「移動前のコードで動く」という事故になる（docs/09 H8-1）
rm -rf "$DEST/src" "$DEST/test" "$DEST/dist" "$DEST/dist-test"
cp -r "$SRC/src" "$DEST/src"
cp -r "$SRC/test" "$DEST/test"
cp "$SRC/package.json" "$SRC/tsconfig.json" "$SRC/tsconfig.test.json" "$DEST/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$DEST/"

cd "$DEST"
echo "  依存を取得します"
if [ -f "$DEST/package-lock.json" ]; then
    npm ci --no-audit --no-fund
else
    npm install --no-audit --no-fund
fi

echo "  ビルドします"
npm run build

if [ "$SKIP_TEST" = 0 ]; then
    echo "  ⭐ テストを走らせます（BLE も Pi 固有のものも使いません）"
    npm test
fi

# ⚠️ dist が無いと consumer 側が `Cannot find module '@odelic/common'` で止まる。
#    ここで必ず確かめる（このスクリプトの存在意義そのもの）
if [ ! -f "$DEST/dist/src/index.js" ]; then
    echo "エラー: $DEST/dist/src/index.js がありません。ビルドに失敗しています" >&2
    exit 1
fi

# ⚠️ Pi の / は空きが少ない。typescript は consumer 側の install.sh が
#    それぞれ持っているので、ここには残さない
npm prune --omit=dev --no-audit --no-fund
rm -rf "$DEST/dist-test"

# ---------------------------------------------- `file:../common` を成立させる
# ⚠️ 既に同名の**実ディレクトリ**があったら消さない（何が入っているか分からないため）
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    echo "エラー: $LINK が実ディレクトリとして存在します。手で確認してください" >&2
    exit 1
fi
ln -sfn "$DEST" "$LINK"
echo "  $LINK -> $DEST（matter / web の file:../common がこれで解決する）"

echo "  完了: $DEST（$(du -sh "$DEST" | cut -f1)）"
