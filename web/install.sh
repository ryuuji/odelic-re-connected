#!/bin/bash
# odelic-web（設定ページとスマホ UI）を Raspberry Pi に常駐サービスとしてインストールする。
#
#   使い方: sudo ./install.sh
#           sudo ./install.sh --show-password   # パスワードを作り直して表示する
#
# ⭐ パスワードの作り直しは **`sudo /opt/odelic-web/reset-password.sh`** でもできる。
#    ログイン画面が案内しているのはそちら（install.sh の置き場所は人によって違うため）。
#
# 前提:
#   - odelicd が動いていること（odelicd/install.sh 済み）
#   - Node.js 20 以降
#
# ## ⭐ 初期パスワードの決め方
#
# ルーターの初期パスワードと同じ方式。**インストール時にランダム生成して 1 回だけ表示する。**
#
# ⚠️ ブラウザから初回設定させる方式は採らない。LAN 内で**先に到達した人**が
#    パスワードを決められてしまうため。
#
# 保存されるのは scrypt のハッシュだけ（/var/lib/odelic-web/auth.json・0600）。
# ⚠️ 平文はここと journald にしか出ない。忘れたら --show-password で作り直す。
# ⚠️⚠️ 作り直すと保存済みのセッション（/var/lib/odelic-web/sessions.json）も消えるので、
#    ログイン中の端末はすべてログアウトする。**それがリセットの意味**。

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/odelic-web
CONFDIR=/etc/odelic-web
STATEDIR=/var/lib/odelic-web
SVCUSER=odelic-web
ACTION="${1:-install}"

if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0 ...）" >&2
    exit 1
fi

# --------------------------------------------------- パスワードの再生成だけ
#
# ⭐ 生成・保存・案内は `reset-password.sh` に置いてある。ここは **source** して
#    同じ関数を使う（実装を 2 か所に持たない）。
#
# ⚠️ なぜ別ファイルなのか: ログイン画面に「分からなくなったらこれ」と**絶対パスで**
#    書きたいが、`install.sh` はリポジトリの中にあって置き場所が人によって違う。
#    → `/opt/odelic-web/reset-password.sh` という固定の入口を作った。
ODELIC_RESET_PASSWORD_LIB=1 . "$SRC/reset-password.sh"

if [ "$ACTION" = "--show-password" ]; then
    [ -d "$STATEDIR" ] || { echo "エラー: まだインストールされていません" >&2; exit 1; }
    # ⭐ 古い配備にも入口を置いてから使う（ログイン画面の案内どおりのパスにする）
    install -m 0755 -o root -g root "$SRC/reset-password.sh" "$DEST/reset-password.sh"
    PW="$(generate_password)"
    announce_password "$PW"
    systemctl restart odelic-web.service
    exit 0
fi

# ------------------------------------------------------------------ Node
echo "=== Node.js の確認 ==="
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 20 ]; then
    CAND="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/{print $2}')"
    CAND_MAJOR="${CAND%%.*}"
    if [ -n "${CAND_MAJOR:-}" ] && [ "$CAND_MAJOR" -ge 20 ] 2>/dev/null; then
        apt-get install -y nodejs npm
    else
        echo "エラー: Node.js 20 以降が必要です" >&2
        exit 1
    fi
fi
echo "  node $(node -v) / npm $(npm -v) / $(uname -m)"

echo
echo "=== odelicd の確認 ==="
if curl -sf "http://127.0.0.1:8080/info" >/dev/null 2>&1; then
    echo "  http://127.0.0.1:8080: OK"
else
    echo "  ⚠️ odelicd に応答がありません。"
    echo "     設定ページは起動しますが、照明の操作はできません（復帰すれば自動で使えます）。"
fi

# ------------------------------------------------------------ ユーザー
echo
echo "=== サービス用ユーザー ==="
if id "$SVCUSER" >/dev/null 2>&1; then
    echo "  $SVCUSER: 既にあります"
else
    # ⭐ BLE も root 権限も要らない（特権が要るのは set-id.sh だけで、それは sudo 経由）
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SVCUSER"
    echo "  $SVCUSER を作成しました"
fi
# ⭐ ログ画面のために journal を読めるようにする
if getent group systemd-journal >/dev/null 2>&1; then
    usermod -aG systemd-journal "$SVCUSER"
    echo "  $SVCUSER を systemd-journal グループに追加しました（ログ画面のため）"
else
    echo "  ⚠️ systemd-journal グループがありません。ログ画面は使えません"
fi

# ------------------------------------------------------- 共有パッケージ
echo
echo "=== 共有パッケージ @odelic/common ==="
"$SRC/../common/install.sh" --skip-test

# ------------------------------------------------------------ 配置とビルド
echo
echo "=== ファイルの配置とビルド ==="
install -d -m 0755 "$DEST"
# ⚠️ 消してから配る。tsc は削除されたソースの出力を消さない（docs/09 H8-1）
rm -rf "$DEST/src" "$DEST/test" "$DEST/dist" "$DEST/public"
cp -r "$SRC/src" "$DEST/src"
cp -r "$SRC/test" "$DEST/test"
cp -r "$SRC/public" "$DEST/public"
cp "$SRC/package.json" "$SRC/tsconfig.json" "$SRC/config.example.json" "$DEST/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$DEST/"
echo "  $DEST に配置しました"

cd "$DEST"
echo "  依存を取得します"
if [ -f "$DEST/package-lock.json" ]; then
    npm ci --no-audit --no-fund
else
    npm install --no-audit --no-fund
fi

# ⚠️ 一度ここで壊れたことがある（Pi では file:../common が /opt/common を指す）。
#    import が通ることを実際に確認してから先へ進む
echo "  @odelic/common が解決できるか確認します"
node -e "import('@odelic/common').then(m => {
  if (typeof m.ladder !== 'function') throw new Error('ladder() が無い');
  console.log('    OK: @odelic/common（段 ' + m.ladder(true).length + ' 段）');
}).catch(e => { console.error('    NG: ' + e.message); process.exit(1); })"

echo "  ビルドします"
npm run build
echo "  ⭐ テストを走らせます（BLE も odelicd も使いません）"
npm test
npm prune --omit=dev --no-audit --no-fund
chown -R "$SVCUSER:$SVCUSER" "$DEST"

# ------------------------------------------------------------------ 設定
echo
echo "=== 設定 ==="
install -d -m 0755 "$CONFDIR"
if [ -f "$CONFDIR/config.json" ]; then
    echo "  $CONFDIR/config.json は既にあるので残します"
else
    cp "$SRC/config.example.json" "$CONFDIR/config.json"
    echo "  $CONFDIR/config.json を作成しました"
fi
chmod 0644 "$CONFDIR/config.json"

# ------------------------------------------------------------ 証明書
echo
echo "=== HTTPS 証明書 ==="
# ⭐ ユーザーを作った**後**に実行する（server.key を 0640 で odelic-web グループにするため）
"$SRC/gencert.sh"

# --------------------------------------------------- 特権ヘルパと sudoers
echo
echo "=== メッシュ ID の特権ヘルパ ==="
install -m 0755 -o root -g root "$SRC/set-id.sh" "$DEST/set-id.sh"
echo "  $DEST/set-id.sh (0755 root)"

# ⭐ パスワードを見失ったときの入口。ログイン画面がこの絶対パスを案内している。
#    ⚠️ こちらは sudoers に入れない（人が sudo で叩くもの）
install -m 0755 -o root -g root "$SRC/reset-password.sh" "$DEST/reset-password.sh"
echo "  $DEST/reset-password.sh (0755 root・⚠️ sudoers には入れない)"

SUDOERS=/etc/sudoers.d/odelic-web
TMP_SUDOERS="$(mktemp)"
cat > "$TMP_SUDOERS" <<EOF
# odelic-web がメッシュの 8 桁 ID を設定するための唯一の許可。
# ⚠️⚠️ ここに汎用スクリプト（install.sh など）を足してはいけない。
#    引数で任意のことができると Web の脆弱性がそのまま root になる。
$SVCUSER ALL=(root) NOPASSWD: $DEST/set-id.sh
EOF
# ⚠️ 壊れた sudoers を置くと**誰も sudo できなくなる**。必ず検証してから設置する
if visudo -cf "$TMP_SUDOERS" >/dev/null; then
    install -m 0440 -o root -g root "$TMP_SUDOERS" "$SUDOERS"
    echo "  $SUDOERS (0440)"
else
    rm -f "$TMP_SUDOERS"
    echo "エラー: sudoers の検証に失敗しました。設置しません" >&2
    exit 1
fi
rm -f "$TMP_SUDOERS"

# ------------------------------------------------------------ パスワード
echo
echo "=== パスワード ==="
install -d -m 0700 -o "$SVCUSER" -g "$SVCUSER" "$STATEDIR"
if [ -f "$STATEDIR/auth.json" ]; then
    echo "  既に設定されています（変えたいときは設定画面か sudo $0 --show-password）"
    NEW_PASSWORD=""
else
    NEW_PASSWORD="$(generate_password)"
fi

# ------------------------------------------------------------ サービス
echo
echo "=== サービスの登録 ==="
install -m 0644 "$SRC/odelic-web.service" /etc/systemd/system/odelic-web.service
systemctl daemon-reload
systemctl enable odelic-web.service
systemctl restart odelic-web.service

echo
echo "=== 起動待ち ==="
# ⭐ ポートは設定ファイルから読む（既定を install.sh に書き写さない）
PORT="$(node --input-type=module -e "
  import { loadConfig } from 'file://$DEST/dist/src/config.js';
  console.log(loadConfig('$CONFDIR/config.json', () => {}).port);
")"
for _ in $(seq 1 20); do
    if curl -skf "https://127.0.0.1:$PORT/ca.crt" >/dev/null 2>&1; then break; fi
    sleep 1
done
systemctl status odelic-web.service --no-pager -n 20 || true

[ -n "$NEW_PASSWORD" ] && announce_password "$NEW_PASSWORD"

HOST="$(hostname)"
cat <<EOF

=== インストール完了 ===

  https://$HOST.local:$PORT/

⭐ スマートフォンで警告を出さないための手順（1 回だけ）:

  1. https://$HOST.local:$PORT/ca.crt を開いて CA 証明書を取得する
     （このとき 1 回だけ警告が出る。承認して進む）
  2. iOS   : プロファイルをインストール後、⚠️ **設定 → 一般 → 情報 →
             証明書信頼設定** でこの CA を必ずオンにする（忘れると警告が消えない）
     Android: 「CA 証明書」としてインストールする

管理:
  sudo systemctl status  odelic-web
  sudo systemctl restart odelic-web
  sudo journalctl -u odelic-web -f

⚠️ この Pi は DHCP です。LAN IP が変わったら:  sudo $SRC/gencert.sh --renew
   ⭐ CA は変わらないのでスマホの信頼設定はやり直し不要です。
EOF
