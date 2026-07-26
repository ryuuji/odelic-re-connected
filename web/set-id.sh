#!/bin/bash
# メッシュの 8 桁 ID を設定する。⭐ **sudoers で許可する唯一のスクリプト。**
#
#   set-id.sh <8桁の数字>   ID を設定して odelicd を再起動する
#   set-id.sh --rollback    直前の ID に戻す
#   set-id.sh --status      今の 8 桁を表示する
#
# ## ⚠️⚠️ なぜ「専用ヘルパ 1 本だけ」なのか
#
# `odelic-web` は非 root で動く。しかし ID の保存先 `/etc/default/odelicd`（0600 root）への
# 書き込みと `odelicd` の再起動には root が要る。
#
#   /etc/sudoers.d/odelic-web:
#     odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/set-id.sh
#
# ⚠️ sudoers は**パスだけ**を許可するので、呼び出し側は**任意の引数**を渡せる。
#    したがって **argv の検証はこのスクリプトの責務**。ここが緩いと
#    Web の脆弱性がそのまま root 権限になる。
#
# ⚠️⚠️ `install.sh` のような汎用スクリプトを sudoers に入れてはいけない。
#
# ## ホーム ID の表示について
#
# `--status` は**今の 8 桁をそのまま**返す。同じ番号が純正アプリのメニュー画面にも
# 出ているので、この画面だけ伏せても守れるものが無く、設定し直すときに読めなくて困る。
#
# ⚠️ ただし **journald には出さない**（ログは第三者に見せることがある）。
#    `--status` の出力は odelic-web が HTTPS + ログインの内側でだけ返す。
#
# ⭐ 巻き戻しは**ここの退避ファイル**で行うので、Web が旧値を覚える必要はない。

set -euo pipefail

CONF=/etc/default/odelicd
PREV=/etc/default/odelicd.prev
SERVICE=odelicd

die() {
    echo "$1" >&2
    exit 1
}

# ⚠️⚠️ **引数の検証を最初にやる**（root チェックより前）。
#    ここが最後の砦なので、権限の話とは独立に必ず通るようにしておく。
#    ⭐ root でなくても検証だけは動くので、動作確認もしやすい。

# 引数はちょうど 1 つ。多くても少なくても拒否する
[ "$#" -eq 1 ] || die "使い方: $0 <8桁の数字> | --rollback | --status"

ACTION="$1"

case "$ACTION" in
    --status | --rollback) ;;
    # ⚠️ 8 桁の数字**以外**は何があっても受け付けない
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "エラー: ID は 8 桁の数字です（受け取った引数は拒否しました）" ;;
esac

[ "$(id -u)" = 0 ] || die "エラー: root で実行してください（sudo 経由で呼ばれます）"

# 現在の ID を読む（無ければ空）
current_id() {
    [ -f "$CONF" ] || return 0
    sed -n 's/^ODELIC_ID=\([0-9]\{8\}\).*$/\1/p' "$CONF" | head -n1
}

case "$ACTION" in
    --status)
        ID="$(current_id)"
        # ⚠️ これは stdout。呼び出し元（odelic-web）はログイン済みの HTTPS にしか流さない
        echo "id=${ID:-none} rollback=$([ -f "$PREV" ] && echo yes || echo no)"
        exit 0
        ;;

    --rollback)
        [ -f "$PREV" ] || die "エラー: 戻せる ID がありません"
        # ⚠️ 今の値を退避と入れ替える（もう一度 --rollback すれば元に戻れる）
        TMP="$(mktemp /etc/default/.odelicd.XXXXXX)"
        chmod 0600 "$TMP"
        cat "$CONF" > "$TMP" 2>/dev/null || true
        cat "$PREV" > "$CONF"
        chmod 0600 "$CONF"
        cat "$TMP" > "$PREV"
        chmod 0600 "$PREV"
        rm -f "$TMP"
        echo "直前の ID に戻しました"
        ;;

    *)
        # ここに来るのは 8 桁の数字だけ（上で検証済み）
        [ -f "$CONF" ] || die "エラー: $CONF がありません（先に odelicd をインストールしてください）"

        # ⭐ 巻き戻せるように今の値を退避する。⚠️ 0600 を保つ
        cp -p "$CONF" "$PREV"
        chmod 0600 "$PREV"

        # ⚠️ sed -i は inode を変えて権限を落とし得る。一時ファイル + mv で 0600 を維持する
        TMP="$(mktemp /etc/default/.odelicd.XXXXXX)"
        chmod 0600 "$TMP"
        if grep -q '^ODELIC_ID=' "$CONF"; then
            sed "s/^ODELIC_ID=.*$/ODELIC_ID=$ACTION/" "$CONF" > "$TMP"
        else
            cat "$CONF" > "$TMP"
            echo "ODELIC_ID=$ACTION" >> "$TMP"
        fi
        mv "$TMP" "$CONF"
        chmod 0600 "$CONF"
        chown root:root "$CONF"
        # ⚠️ ID そのものはここに出さない。install.sh から実行すると journald に残る
        echo "ID を更新しました（上位 4 桁 ${ACTION:0:4}）"
        ;;
esac

# ⭐ odelicd を再起動して新しい ID で参加させる。
#    ⚠️ 正しい ID かどうかは器具の応答で分かる（PERIPHERAL_LOGIN の HOMEID 照合・C23-1）。
#       ここでは判定しない。Web が GET /info の joined を見て判断する
systemctl restart "$SERVICE"
echo "$SERVICE を再起動しました"
