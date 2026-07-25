#!/bin/bash
# odelicd を Raspberry Pi に常駐サービスとしてインストールする。
#
#   使い方: sudo ./install.sh <8桁ID> [ポート]
#   例:     sudo ./install.sh 99833900 8080
#
# 前提: odelicd.py と odelicd.service が同じディレクトリにあること。

set -euo pipefail

ID="${1:-}"
PORT="${2:-8080}"
GROUP="${3:-0}"
RESEND="${4:-3}"

if [ -z "$ID" ]; then
    echo "使い方: sudo $0 <8桁ID> [ポート] [グループ] [送信回数]" >&2
    exit 1
fi
if ! [[ "$ID" =~ ^[0-9]{8}$ ]]; then
    echo "エラー: ID は 8 桁の数字です（上位 4 桁 = HOMEID、下位 4 桁 = パスワード）" >&2
    exit 1
fi
if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0 ...）" >&2
    exit 1
fi

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/odelicd

echo "=== 依存の確認 ==="
for pkg in python3-dbus python3-gi bluez; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        echo "  $pkg が未インストールです。導入します"
        apt-get install -y "$pkg"
    else
        echo "  $pkg: OK"
    fi
done
command -v hcitool >/dev/null || { echo "エラー: hcitool がありません" >&2; exit 1; }

echo
echo "=== ファイルの配置 ==="
install -d -m 0755 "$DEST"
install -m 0755 "$SRC/odelicd.py" "$DEST/odelicd.py"
echo "  $DEST/odelicd.py"

# ID にはパスワードが含まれるので root のみ読める設定ファイルに置く
cat > /etc/default/odelicd <<EOF
# odelicd の設定。ODELIC_ID の下位 4 桁はメッシュのパスワードなので取り扱い注意。
ODELIC_ID=$ID
ODELIC_PORT=$PORT
ODELIC_GROUP=$GROUP
ODELIC_RESEND=$RESEND
EOF
chmod 600 /etc/default/odelicd
echo "  /etc/default/odelicd (0600)"

install -m 0644 "$SRC/odelicd.service" /etc/systemd/system/odelicd.service
echo "  /etc/systemd/system/odelicd.service"

echo
echo "=== サービスの登録 ==="
# 検証用に作った一時ユニットが残っていたら止める
for u in odelicd2 odelicd3; do
    systemctl stop "$u.service" 2>/dev/null || true
done
pkill -f mesh_peripheral 2>/dev/null || true

systemctl daemon-reload
systemctl enable odelicd.service
systemctl restart odelicd.service

echo
echo "=== 起動待ち ==="
for _ in $(seq 1 20); do
    if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then break; fi
    sleep 1
done

echo
systemctl status odelicd.service --no-pager -n 15 || true

echo
echo "=== 動作確認 ==="
curl -s "http://localhost:$PORT/" | python3 -m json.tool || echo "  API に応答がありません"

cat <<EOF

=== インストール完了 ===

操作:
  curl -X POST http://localhost:$PORT/on
  curl -X POST http://localhost:$PORT/off
  curl -X POST 'http://localhost:$PORT/level?bright=60&color=50'
  curl http://localhost:$PORT/status

管理:
  sudo systemctl status  odelicd
  sudo systemctl restart odelicd
  sudo journalctl -u odelicd -f

⚠️ グループ設定・シーン登録・器具登録の初期化は実装していない
   （壊すと壁スイッチからのやり直しになるため意図的に対応外）
EOF
