#!/bin/bash
# odelicd の HTTP API の公開範囲を切り替える。⭐ **sudoers で許可する 3 本目のスクリプト。**
#
#   set-api.sh --status   今の範囲を表示する
#   set-api.sh local      localhost 限定にする（既定）
#   set-api.sh lan        LAN に公開する（⚠️ 認証なし）
#
# ## ⚠️⚠️ この API には認証が無い
#
# `odelicd` の HTTP API は**誰でも叩ける**。`POST /on` に鍵は要らない。
# LAN に出すということは「**その LAN に居る誰でも照明を操作できる**」という意味。
#
#   ⭐ localhost 限定でも Matter ブリッジと設定ページは動く（両方 127.0.0.1 から叩く）。
#     → **音声操作もスマホ操作も、localhost 限定のままで全部できる。**
#   LAN に出す価値があるのは「別のマシンのスクリプトから直接叩きたい」ときだけ。
#
# ## ⚠️ なぜ set-id.sh と分けるのか
#
# sudoers は**パスだけ**を許可するので、呼び出し側は任意の引数を渡せる。
# → **argv の検証は各スクリプトの責務**。1 本に混ぜると検証が複雑になり、
#   「ID を変える」と「公開範囲を変える」で受け付ける形が違うことを 1 つの
#   case 文で守ることになる。⭐ **狭いスクリプトを並べるほうが守りやすい。**
#
#   /etc/sudoers.d/odelic-web:
#     odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/set-id.sh
#     odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/set-api.sh
#     odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/backup-helper.py
#
# ⚠️ 書き込む先は set-id.sh と同じ `/etc/default/odelicd`（0600 root）。
#    ⭐ `sed -i` を使わず一時ファイル + mv にするのも同じ理由（inode が変わると 0600 が落ちる）。

set -euo pipefail

CONF=/etc/default/odelicd
SERVICE=odelicd
LOCAL_ADDR=127.0.0.1
GLOBAL_ADDR=0.0.0.0

die() {
    echo "$1" >&2
    exit 1
}

# ⚠️⚠️ **引数の検証を最初にやる**（root チェックより前）。
#    ここが最後の砦なので、権限の話とは独立に必ず通るようにしておく。
[ "$#" -eq 1 ] || die "使い方: $0 --status | local | lan"

ACTION="$1"
case "$ACTION" in
    --status | local | lan) ;;
    # ⚠️ 任意のアドレスは受け付けない。**この 2 つだけ**
    #    （`0.0.0.0/0` のような書き方や別ホストへの bind を作らせない）
    *) die "エラー: --status / local / lan のいずれかです（受け取った引数は拒否しました）" ;;
esac

[ "$(id -u)" = 0 ] || die "エラー: root で実行してください（sudo 経由で呼ばれます）"
[ -f "$CONF" ] || die "エラー: $CONF がありません（先に odelicd をインストールしてください）"

current_bind() {
    # ⚠️ 未設定なら localhost 扱い。odelicd.py も空文字を 127.0.0.1 に倒している
    local v
    v="$(sed -n 's/^ODELIC_BIND=\(.*\)$/\1/p' "$CONF" | head -n1)"
    echo "${v:-$LOCAL_ADDR}"
}

scope_of() {
    case "$1" in
        "$LOCAL_ADDR" | ::1 | localhost) echo local ;;
        *) echo lan ;;
    esac
}

if [ "$ACTION" = "--status" ]; then
    BIND="$(current_bind)"
    # ⚠️ これは stdout。呼び出し元（odelic-web）はログイン済みの HTTPS にしか流さない
    echo "scope=$(scope_of "$BIND") bind=$BIND port=$(sed -n 's/^ODELIC_PORT=\(.*\)$/\1/p' "$CONF" | head -n1)"
    exit 0
fi

if [ "$ACTION" = "local" ]; then
    WANT="$LOCAL_ADDR"
else
    WANT="$GLOBAL_ADDR"
fi

if [ "$(current_bind)" = "$WANT" ]; then
    echo "すでに $(scope_of "$WANT") です（$WANT）。何もしませんでした"
    exit 0
fi

# ⚠️ sed -i は inode を変えて権限を落とし得る。一時ファイル + mv で 0600 を維持する
TMP="$(mktemp /etc/default/.odelicd.XXXXXX)"
chmod 0600 "$TMP"
if grep -q '^ODELIC_BIND=' "$CONF"; then
    sed "s#^ODELIC_BIND=.*\$#ODELIC_BIND=$WANT#" "$CONF" > "$TMP"
else
    cat "$CONF" > "$TMP"
    echo "ODELIC_BIND=$WANT" >> "$TMP"
fi
mv "$TMP" "$CONF"
chmod 0600 "$CONF"
chown root:root "$CONF"

# ⭐ 待ち受けアドレスは起動時に決まるので再起動が必要。
#    ⚠️ 再起動すると器具が繋ぎ直してくるまで数秒（実測 約 5 秒）操作できない
systemctl restart "$SERVICE"

if [ "$WANT" = "$GLOBAL_ADDR" ]; then
    echo "API を LAN に公開しました（$WANT）。⚠️ この API に認証はありません"
else
    echo "API を localhost 限定にしました（$WANT）"
fi
echo "$SERVICE を再起動しました"
