#!/bin/bash
# odelic-matter を Raspberry Pi に常駐サービスとしてインストールする。
#
#   使い方: sudo ./install.sh [odelicd の URL]
#   例:     sudo ./install.sh http://127.0.0.1:8080
#
# 前提:
#   - odelicd が動いていること（odelicd/install.sh 済み）
#   - Node.js 20 以降（無ければ導入方法を案内して終了する）
#
# ⭐ BLE は一切使わない。Pi の唯一の BLE アダプタは odelicd が握ったままでよい。
#    Matter への参加はオンネットワーク commissioning（mDNS / IPv6）で行う。

set -euo pipefail

ODELICD_URL="${1:-http://127.0.0.1:8080}"

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/odelic-matter
CONFDIR=/etc/odelic-matter
SVCUSER=odelic-matter

if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0 ...）" >&2
    exit 1
fi

echo "=== Node.js の確認 ==="
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 20 ]; then
    # Debian 13 (trixie) 以降は apt の nodejs が 20.x なのでそれで足りる
    CAND="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/{print $2}')"
    CAND_MAJOR="${CAND%%.*}"
    if [ -n "${CAND_MAJOR:-}" ] && [ "$CAND_MAJOR" -ge 20 ] 2>/dev/null; then
        echo "  apt の nodejs ($CAND) を導入します"
        apt-get update -qq
        apt-get install -y nodejs npm
    else
        cat >&2 <<'EOF'
エラー: Node.js 20 以降がありません。apt の候補も 20 未満でした。

  # NodeSource で入れる場合
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs

EOF
        exit 1
    fi
fi
echo "  node $(node -v) / npm $(npm -v) / $(uname -m)"
if [ "$(node_major)" -lt 20 ]; then
    echo "エラー: Node.js 20 以降が必要です（matter.js の要求）" >&2
    exit 1
fi

echo
echo "=== odelicd の確認 ==="
if curl -sf "$ODELICD_URL/info" >/dev/null 2>&1; then
    echo "  $ODELICD_URL: OK"
else
    echo "  ⚠️ $ODELICD_URL に応答がありません。"
    echo "     ブリッジは起動しますが、器具が見えるまで Matter には何も出ません。"
fi

echo
echo "=== サービス用ユーザー ==="
if id "$SVCUSER" >/dev/null 2>&1; then
    echo "  $SVCUSER: 既にあります"
else
    # ⭐ BLE を使わないので root は不要
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SVCUSER"
    echo "  $SVCUSER を作成しました"
fi

echo
echo "=== 共有パッケージ @odelic/common ==="
# ⭐ ここを先にやる。matter は @odelic/common に依存している
bash "$SRC/../common/install.sh" --skip-test

echo
echo "=== ファイルの配置とビルド ==="
install -d -m 0755 "$DEST"
# ソースと依存定義だけを配ってから Pi 上でビルドする
# （dist は環境に依存しないが、tsc を Pi で通すことで取り違えを防ぐ）
rm -rf "$DEST/src" "$DEST/test" "$DEST/dist"
cp -r "$SRC/src" "$DEST/src"
cp -r "$SRC/test" "$DEST/test"
cp "$SRC/package.json" "$SRC/tsconfig.json" "$DEST/"
cp "$SRC/config.example.json" "$DEST/"
# ロックファイルがあれば持っていく（バージョンを固定して入れるため）
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$DEST/"
echo "  $DEST に配置しました"

cd "$DEST"
echo "  依存を取得します（数分かかることがあります）"
if [ -f "$DEST/package-lock.json" ]; then
    npm ci --no-audit --no-fund
else
    npm install --no-audit --no-fund
fi

# ⚠️⚠️ ここで必ず確かめる。`file:../common` の解決は Pi で一度壊れていた
#    （/opt/odelic-matter/node_modules/@odelic が存在しないまま、分離前の古い dist で
#     動いていた）。import が通ることを実際に確認してから先へ進む
echo "  @odelic/common が解決できるか確認します"
node -e "import('@odelic/common').then(m => {
  if (typeof m.ladder !== 'function') throw new Error('ladder() が無い');
  console.log('    OK: @odelic/common（段 ' + m.ladder(true).length + ' 段）');
}).catch(e => { console.error('    NG: ' + e.message); process.exit(1); })"

echo "  ビルドします"
npm run build
echo "  ⭐ テストを走らせます（BLE を使いません）"
# ⚠️⚠️ **テストの失敗でインストールを止めない。**
#    Pi 3 は遅いので、時間に依存するテストが落ちることがある。そこで中断すると
#    このスクリプトの残り（設定ファイルの作成・サービスの登録）が実行されず、
#    **半端な状態が残ってもっと分かりにくい壊れ方をする**（実際に踏んだ）。
#    ⭐ テストは「気付くため」に走らせる。配備を止める門にはしない。
# ⚠️ 開発機では落ちたら止めたい。ODELIC_STRICT_TEST=1 でその挙動になる。
TEST_FAILED=0
if npm test; then
    echo "  ✅ テスト OK"
else
    TEST_FAILED=1
    echo "  ⚠️⚠️ テストが失敗しました（インストールは続けます）" >&2
    if [ "${ODELIC_STRICT_TEST:-0}" = "1" ]; then
        echo "エラー: ODELIC_STRICT_TEST=1 なので中断します" >&2
        exit 1
    fi
fi
# devDependencies（typescript）はもう不要
npm prune --omit=dev --no-audit --no-fund
chown -R "$SVCUSER:$SVCUSER" "$DEST"

echo
echo "=== 設定 ==="
install -d -m 0755 "$CONFDIR"
if [ -f "$CONFDIR/config.json" ]; then
    echo "  $CONFDIR/config.json は既にあるので残します"
else
    sed "s#\"odelicd\": \"http://127.0.0.1:8080\"#\"odelicd\": \"$ODELICD_URL\"#" \
        "$SRC/config.example.json" > "$CONFDIR/config.json"
    echo "  $CONFDIR/config.json を作成しました（config.example.json から）"
    echo "  ⚠️ 器具の名前と色温度のケルビン値を確認してください"
fi
chown -R "$SVCUSER:$SVCUSER" "$CONFDIR"
chmod 0644 "$CONFDIR/config.json"

install -m 0644 "$SRC/odelic-matter.service" /etc/systemd/system/odelic-matter.service
echo "  /etc/systemd/system/odelic-matter.service"

echo
echo "=== サービスの登録 ==="
systemctl daemon-reload
systemctl enable odelic-matter.service
systemctl restart odelic-matter.service

echo
echo "=== 起動待ち ==="
for _ in $(seq 1 20); do
    if systemctl is-active --quiet odelic-matter.service; then break; fi
    sleep 1
done
systemctl status odelic-matter.service --no-pager -n 20 || true

echo
echo "=== commissioning コード ==="
journalctl -u odelic-matter -n 60 --no-pager | grep -A2 -E "手入力コード|QR ペイロード" || \
    echo "  まだ出ていません。sudo journalctl -u odelic-matter -f で待ってください"


# ⚠️ テストが落ちていたら最後にもう一度言う（途中の出力は流れて見えない）
if [ "$TEST_FAILED" = "1" ]; then
    echo
    echo "⚠️⚠️ テストが失敗しています（インストール自体は完了しました）"
    echo "   動作に問題が出たら、上のテスト出力を添えて報告してください:"
    echo "   https://github.com/ryuuji/odelic-re-connected/issues"
fi

cat <<EOF

=== インストール完了 ===

Google Home への参加:
  1. Google Home Developer Console でプロジェクトを作り、Matter integration を追加。
     ⚠️ VID 0xFFF1 / PID 0x8001 を登録しないと Google Home が commissioning を拒否します
  2. Google Home アプリ →「デバイスを追加」→「Matter デバイス」→ 上の手入力コード
  3. BLE は使いません。Pi と Google スピーカーが同一 LAN で IPv6 / mDNS が通ることが前提

管理:
  sudo systemctl status  odelic-matter
  sudo systemctl restart odelic-matter
  sudo journalctl -u odelic-matter -f

  # 詳細ログ（matter.js の内部まで）
  sudo systemctl edit odelic-matter   # Environment=MATTER_LOG_LEVEL=debug

⚠️ 壁スイッチの変更を追従させるには config.json の statusRefreshSec を 60 などに
   してください。**BLE を消費する**ので、接続ログの採取中は 0 のままにします。

⚠️ 再 commissioning が必要になるのは /var/lib/odelic-matter を消したときです。
EOF
