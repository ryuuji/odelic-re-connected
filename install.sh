#!/bin/bash
# ODELIC 照明を Raspberry Pi から操作する 3 つのサービスをまとめて入れる。
#
#   sudo ./install.sh <8桁ID>                 # odelicd → matter → web（既定ポート 8080）
#   sudo ./install.sh <8桁ID> 8080
#   sudo ./install.sh <8桁ID> --skip-matter   # Matter は入れない
#   sudo ./install.sh <8桁ID> --skip-web      # 設定ページは入れない
#
# 8 桁 ID は公式アプリのメニュー画面に出ている番号（上位 4 桁 = HOMEID、
# 下位 4 桁 = メッシュのパスワード）。→ README の「8 桁 ID の調べ方」
#
# ## ⚠️ 順序に意味がある
#
# `odelicd` → `matter` → `web`。`web` は起動時に `odelicd` とブリッジの両方を
# 見に行くので、先に立てておく。⭐ ただし**落ちていても web は起動する**
# （照明の操作は `odelicd` さえ生きていればできる）。
#
# ## ⭐ このスクリプトは薄い
#
# 実際の作業は各ディレクトリの `install.sh` が持っている。ここがやるのは
#   1. **時間のかかる処理の前に**引数と権限を検査して落とす（npm は数分かかる）
#   2. 正しい順序で呼ぶ
#   3. ⭐ 最後に接続先と**設定ページの初期パスワードをもう一度**表示する
#      （npm の出力に埋もれて見落とすため）
# だけ。⚠️ 個別の手順をここに書き写さない（二重管理になる）。

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"

ID=""
PORT=8080
SKIP_MATTER=0
SKIP_WEB=0

usage() {
    # ⚠️ 冒頭コメントの「使い方」だけを出す。行数は上のコメントブロックと連動する
    sed -n '2,11p' "$0" | sed 's/^# \?//'
    exit "${1:-1}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-matter) SKIP_MATTER=1 ;;
        --skip-web)    SKIP_WEB=1 ;;
        -h|--help)     usage 0 ;;
        -*)            echo "エラー: 知らないオプション: $1" >&2; usage ;;
        *)
            if [ -z "$ID" ]; then ID="$1"
            else PORT="$1"
            fi
            ;;
    esac
    shift
done

# ------------------------------------------------- 検査（npm を回す前に落とす）

if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0 ...）" >&2
    exit 1
fi
if [ -z "$ID" ]; then
    echo "エラー: 8 桁 ID を指定してください" >&2
    usage
fi
if ! [[ "$ID" =~ ^[0-9]{8}$ ]]; then
    echo "エラー: ID は 8 桁の数字です（上位 4 桁 = HOMEID、下位 4 桁 = パスワード）" >&2
    exit 1
fi
if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "エラー: ポートが不正です: $PORT" >&2
    exit 1
fi

# ⚠️ 途中で「そのファイルがない」で止まると中途半端な状態が残る。先に全部見る
NEEDED=("$SRC/odelicd/install.sh")
[ "$SKIP_MATTER" = 0 ] && NEEDED+=("$SRC/matter/install.sh" "$SRC/common/install.sh")
[ "$SKIP_WEB" = 0 ]    && NEEDED+=("$SRC/web/install.sh" "$SRC/common/install.sh")
for f in "${NEEDED[@]}"; do
    if [ ! -f "$f" ]; then
        echo "エラー: $f がありません（リポジトリのルートから実行してください）" >&2
        exit 1
    fi
done

ODELICD_URL="http://127.0.0.1:$PORT"

echo "================================================================"
echo "  ODELIC 照明 — Raspberry Pi へのインストール"
echo "================================================================"
echo "  ホーム ID     : ${ID:0:4}****        （下位 4 桁はパスワードなので伏せます）"
echo "  odelicd       : $ODELICD_URL"
echo "  Matter ブリッジ: $([ "$SKIP_MATTER" = 0 ] && echo '入れる' || echo '入れない（--skip-matter）')"
echo "  設定ページ     : $([ "$SKIP_WEB" = 0 ] && echo '入れる' || echo '入れない（--skip-web）')"
echo

# ------------------------------------------------------------ ① odelicd

# ⚠️ サブスクリプトは `bash` 経由で呼ぶ。⭐ tarball や zip で配ると
#    実行ビットが落ちることがあり、`Permission denied` で止まる（実際に踏んだ）。
echo "################################################################"
echo "#  1/3  odelicd（BLE で照明を操作する常駐デーモン）"
echo "################################################################"
bash "$SRC/odelicd/install.sh" "$ID" "$PORT"

# ------------------------------------------------------------ ② Matter

if [ "$SKIP_MATTER" = 0 ]; then
    echo
    echo "################################################################"
    echo "#  2/3  odelic-matter（Google Home / Apple Home / Alexa 向け）"
    echo "################################################################"
    bash "$SRC/matter/install.sh" "$ODELICD_URL"
fi

# ------------------------------------------------------------ ③ 設定ページ

WEB_PASSWORD=""
if [ "$SKIP_WEB" = 0 ]; then
    echo
    echo "################################################################"
    echo "#  3/3  odelic-web（設定ページとスマホ UI）"
    echo "################################################################"
    [ "$SKIP_MATTER" = 1 ] && \
        echo "  ⚠️ Matter ブリッジを入れていないので、器具名は既定名で表示されます"

    # ⭐ 初期パスワードは 1 回しか表示されない（保存されるのはハッシュだけ）。
    #    npm の出力に埋もれるので、拾って最後にもう一度出す。
    # ⚠️ 平文が一時ファイルに落ちるので 0600 で作り、**読み終わったら即消す**。
    #    /tmp は Pi では tmpfs（RAM）なので SD カードにも残らない。
    WEB_LOG="$(umask 077 && mktemp)"
    trap 'rm -f "$WEB_LOG"' EXIT
    bash "$SRC/web/install.sh" 2>&1 | tee "$WEB_LOG"
    WEB_PASSWORD="$(sed -n 's/^[[:space:]]*⭐ パスワード:[[:space:]]*//p' "$WEB_LOG" | head -1)"
    rm -f "$WEB_LOG"
    trap - EXIT
fi

# ------------------------------------------------------------ まとめ

HOST="$(hostname)"
echo
echo "================================================================"
echo "  ✅ インストール完了"
echo "================================================================"
echo
echo "照明を操作する（すぐ試せる）:"
echo "  curl -X POST $ODELICD_URL/on"
echo "  curl -X POST $ODELICD_URL/off"
echo "  curl -X POST '$ODELICD_URL/level?bright=60&color=50&wait=1'"
echo "  curl $ODELICD_URL/devices"
echo
echo "⚠️ 器具は広告開始から約 5 秒で接続してきます。すぐ 503 が返るときは少し待ってください。"

if [ "$SKIP_WEB" = 0 ]; then
    echo
    echo "設定ページ（スマートフォンから）:"
    echo "  https://$HOST.local:8443/"
    if [ -n "$WEB_PASSWORD" ]; then
        echo
        echo "  ⭐⭐ 初期パスワード:  $WEB_PASSWORD"
        echo "  ⚠️ これが表示される最後の機会です（保存されているのはハッシュだけ）。"
        echo "     見失ったら:  sudo /opt/odelic-web/reset-password.sh"
    else
        echo "  パスワードは既に設定済みです（作り直すなら sudo /opt/odelic-web/reset-password.sh）"
    fi
    echo
    echo "  ⚠️ 最初に 1 回だけ CA 証明書を入れてください（警告を消すため）:"
    echo "     https://$HOST.local:8443/ca.crt"
    echo "     iOS は取得後に「設定 → 一般 → 情報 → 証明書信頼設定」でオンにする必要があります"
fi

if [ "$SKIP_MATTER" = 0 ]; then
    echo
    echo "Matter（Google Home / Apple Home / Alexa）:"
    if [ "$SKIP_WEB" = 0 ]; then
        # ⭐ 設定ページを入れているなら、そちらを案内する（スマホで見たまま入力できる）
        echo "  設定ページ →「Matter」タブ に手入力コードが出ています"
    else
        echo "  手入力コードは上の出力か次のコマンドで確認できます:"
        echo "    sudo journalctl -u odelic-matter | grep -A2 手入力コード"
    fi
    echo "  ⚠️ Google Home は先に Developer Console でのテスト VID 登録が必要です"
    echo "     （0xFFF1 / 0x8001。→ README の「Google Home に追加する」）"
    echo "  ⚠️⚠️ commissioning の直後にブリッジを再起動しないでください"
    echo "     （Nest ハブが配下の器具を失う既知バグ。→ docs/07-matter.md M9）"
fi

echo
echo "状態の確認:"
echo "  sudo systemctl status odelicd odelic-matter odelic-web"
echo "  curl $ODELICD_URL/metrics    # 到達率・RTT 分布・リンク寿命"
if [ "$SKIP_WEB" = 0 ]; then
    echo
    echo "⭐⭐ 最初にバックアップを取ってください。"
    echo "   設定ページ →「設定」タブ →「バックアップと復元」→ ダウンロード"
    echo "   Matter の fabric 鍵とローカル CA の鍵を失うと、全端末で登録をやり直します"
    echo "   ⚠️ 落ちた ZIP には秘密情報が入ります。他人に渡さないでください"
fi
echo
