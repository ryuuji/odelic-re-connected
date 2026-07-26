#!/bin/bash
# odelicd を Raspberry Pi に常駐サービスとしてインストールする。
#
#   使い方: sudo ./install.sh <8桁ID> [ポート]
#   例:     sudo ./install.sh 12345678 8080
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
# ⚠️ python3-cryptography を忘れると odelicd が import で落ちる
#    （送受信の AES に使う。素の Raspberry Pi OS には入っていない）
MISSING=""
for pkg in python3-dbus python3-gi python3-cryptography bluez curl; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
        echo "  $pkg: OK"
    else
        echo "  $pkg: 未インストール"
        MISSING="$MISSING $pkg"
    fi
done
if [ -n "$MISSING" ]; then
    # ⚠️ update を先にやる。索引が古いと install が 404 で落ちる
    echo "  導入します:$MISSING"
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y $MISSING
fi

# ⭐ Python から実際に import できるかを見る。パッケージが入っていても
#    別の python を使っていると通らない（venv など）
if ! python3 -c "import dbus, gi, cryptography" 2>/dev/null; then
    echo "エラー: python3 から dbus / gi / cryptography を import できません" >&2
    echo "  sudo apt-get install -y python3-dbus python3-gi python3-cryptography" >&2
    exit 1
fi
echo "  ⭐ python3 から dbus / gi / cryptography を import できました"

# ⚠️ raw HCI で広告を出すのに使う（BlueZ の D-Bus 広告は Pi 3 で使えない・docs C19-5）
command -v hcitool >/dev/null || {
    echo "エラー: hcitool がありません（bluez に含まれます）" >&2
    echo "  sudo apt-get install -y bluez" >&2
    exit 1
}

echo
echo "=== ファイルの配置 ==="
install -d -m 0755 "$DEST"
install -m 0755 "$SRC/odelicd.py" "$DEST/odelicd.py"
echo "  $DEST/odelicd.py"

# ⭐ API の公開範囲は**既に選ばれていればそれを尊重する。**
#    入れ直しただけで LAN に出たり localhost に閉じたりしたら驚く。
BIND="$(sed -n 's/^ODELIC_BIND=\(.*\)$/\1/p' /etc/default/odelicd 2>/dev/null | head -n1)"
if [ -z "$BIND" ]; then
    # ⚠️⚠️ 既定は localhost 限定。この API には**認証が無い**ので、
    #    LAN に出すのは利用者が設定画面で明示的に選んだときだけにする
    BIND=127.0.0.1
fi

# ID にはパスワードが含まれるので root のみ読める設定ファイルに置く
cat > /etc/default/odelicd <<EOF
# odelicd の設定。ODELIC_ID の下位 4 桁はメッシュのパスワードなので取り扱い注意。
ODELIC_ID=$ID
ODELIC_PORT=$PORT
# ⚠️⚠️ この HTTP API には認証が無い。127.0.0.1 = localhost 限定（既定）。
#    0.0.0.0 にすると LAN の誰でも照明を操作できる。設定ページから切り替えられる
ODELIC_BIND=$BIND
ODELIC_GROUP=$GROUP
ODELIC_RESEND=$RESEND
EOF
chmod 600 /etc/default/odelicd
echo "  /etc/default/odelicd (0600)"
if [ "$BIND" = "127.0.0.1" ]; then
    echo "  ⭐ API は localhost 限定（設定ページで LAN 公開に変えられます）"
else
    echo "  ⚠️ API を $BIND で公開しています（認証はありません）"
fi

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
