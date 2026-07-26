#!/bin/bash
# odelic-web のパスワードを作り直す。
#
#   sudo /opt/odelic-web/reset-password.sh                新しい値を作って表示し、サービスを再起動する
#   sudo /opt/odelic-web/reset-password.sh --print-only   値だけを標準出力へ（install.sh から呼ぶ用）
#
# ## ⚠️ なぜ install.sh と別のファイルなのか
#
# ログイン画面に「分からなくなったらこれを実行してください」と**絶対パスで**書きたい。
# `install.sh` はリポジトリの中にあり、置き場所が人によって違う
# （Pi では `/home/<user>/odelic-src/web/install.sh`）ので、案内に書けるパスにならない。
#
# ⚠️⚠️ `install.sh` を `/opt/odelic-web` に置いて済ませてはいけない。
#    `install.sh` は `$(dirname $0)` を**ソースツリー**とみなすので、`/opt` から実行すると
#    `cp -r "$SRC/src" "$DEST/src"`（自分自身を自分にコピー）になって壊れる。
#
# ⚠️ **このスクリプトは sudoers に入れない。**人が `sudo` で叩くもので、
#    `odelic-web` のプロセスから呼ぶものではない
#    （sudoers に足してよいのは `set-id.sh` だけ・docs/08 W5）。
#
# ⭐ `install.sh` はこのファイルを **source** して同じ関数を使う。実装を 2 か所に持たない。

set -euo pipefail

DEST=/opt/odelic-web
STATEDIR=/var/lib/odelic-web
SVCUSER=odelic-web
SERVICE=odelic-web.service

# ⭐ 新しいパスワードを作って保存し、**値だけ**を標準出力に出す。
#    ⚠️ ここに標準出力へ書く処理を足さない（呼び出し側が `$(...)` で受け取っている）。
generate_password() {
    if [ ! -f "$DEST/dist/src/auth.js" ]; then
        echo "エラー: $DEST がまだインストールされていません（先に install.sh を実行してください）" >&2
        exit 1
    fi
    install -d -m 0700 -o "$SVCUSER" -g "$SVCUSER" "$STATEDIR"
    # ⭐ 生成もハッシュ化も本体のコード（auth.ts）を使う。ここにアルゴリズムを
    #    書き写すと、変えたときに片方だけ古くなる
    node --input-type=module -e "
      import { generatePassword, hashPassword } from 'file://$DEST/dist/src/auth.js';
      import { writeFileSync, chmodSync } from 'node:fs';
      const pw = generatePassword(16);
      writeFileSync('$STATEDIR/auth.json', JSON.stringify(hashPassword(pw), null, 2) + '\n', { mode: 0o600 });
      chmodSync('$STATEDIR/auth.json', 0o600);
      console.log(pw);
    "
    # ⚠️⚠️ **ここで所有者を移す。**root が 0600 で作ったままサービスを起動すると、
    #    非 root のプロセスが読めず「パスワードが設定されていません」になる
    #    （実際に踏んだ。ログインできない状態でインストールが完了してしまう）
    chown "$SVCUSER:$SVCUSER" "$STATEDIR/auth.json"
    # ⚠️⚠️ **保存済みのセッションも捨てる。**パスワードを作り直したのに、
    #    ログイン中の端末がそのまま入れてしまってはリセットの意味がない。
    #    ⭐ auth.ts 側でも「発行時のパスワードと違うセッションは読み込まない」ので二重に守る
    rm -f "$STATEDIR/sessions.json"
}

announce_password() {
    local pw="$1"
    cat <<EOF

================================================================
  ⭐ パスワード:  $pw
================================================================
  ⚠️ この画面にしか出ません（保存されるのはハッシュだけ）。
     控えるか、ログインしてから設定画面で好きな値に変えてください。
     見失ったら:  sudo journalctl -u odelic-web | grep パスワード
                  sudo $DEST/reset-password.sh
                  （新しい値を作り直します。⚠️ 全端末がログアウトします）

EOF
    # ⭐ journald にも 1 回だけ流す（画面を閉じてしまったとき用）
    logger -t odelic-web "初期パスワード: $pw （設定画面で変更してください）"
}

# ⭐ install.sh から source されたときは、関数だけ提供してここで抜ける。
#    ⚠️ `[ ... ] && return` と書くと set -e に引っかかることがあるので if で書く
if [ "${ODELIC_RESET_PASSWORD_LIB:-}" = "1" ]; then
    return 0
fi

# ------------------------------------------------------------------ 単体実行

if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0）" >&2
    exit 1
fi

case "${1:-}" in
    "")
        PW="$(generate_password)"
        announce_password "$PW"
        systemctl restart "$SERVICE"
        echo "$SERVICE を再起動しました（ログイン中の端末はすべてログアウトしています）"
        ;;
    --print-only)
        generate_password
        ;;
    *)
        echo "使い方: $0 [--print-only]" >&2
        exit 1
        ;;
esac
