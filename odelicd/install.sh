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
# ⚠️ 既定は 1。3 連射は上りも下りも 3 倍にするだけで到達率を上げない
#    （実測 1 通で 0.993〜1.000・docs/02-protocol.md C33-5）。
#    ⭐ さらに悪いことに、混雑を自分で作って応答を遅らせ、
#    「反応なし」の誤判定を招いていた（C35-3）。odelicd.py の既定も 1
RESEND="${4:-1}"

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

# ------------------------------------------------- BLE の接続パラメータ（P7）
#
# ⚠️⚠️ **これを入れないと BlueZ が器具の接続を遅くする。**
#    器具は Connection Interval 15.00 / 28.75 ms を指定してくるのに、Linux は
#    「短すぎる」と判断して Connection Parameter Update Request を送り、
#    **45 ms に書き換えてしまう**（実測 65/65 本・器具は全部受理してしまう）。
#    → 下限を 7.5 ms（= 6 × 1.25 ms）まで下げておけば CPUR そのものが出ない。
#    リンク寿命 7〜14 秒 → 6.8 分以上、RTT の max 449 → 77 ms。→ docs/06 P7・docs/02 C33
#
# ⭐ 恒久化（main.conf）と即時反映（debugfs）の両方をやる。
# ⚠️ main.conf の反映には bluetoothd の再起動が要るが、**ここでは再起動しない。**
#    odelicd は `Requires=bluetooth.service` なので道連れで落ちる。
#    ⭐ 代わりに debugfs へ直接書いて、今動いているアダプタに効かせる
#    （新しい接続から適用される。この直後に odelicd を再起動するので間に合う）。

echo
echo "=== BLE の接続パラメータ ==="
BT_CONF=/etc/bluetooth/main.conf
WANT_MIN_INTERVAL=6          # 6 × 1.25 ms = 7.5 ms

if [ ! -f "$BT_CONF" ]; then
    echo "  ⚠️ $BT_CONF がありません。恒久化を飛ばします（bluez の版が違う？）"
else
    # 有効行（コメントでない）に既に値があるか
    CUR="$(sed -n 's/^[[:space:]]*MinConnectionInterval[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$BT_CONF" | head -n1)"
    if [ -n "$CUR" ] && [ "$CUR" -le "$WANT_MIN_INTERVAL" ]; then
        echo "  MinConnectionInterval=$CUR（設定済み。触りません）"
    elif [ -n "$CUR" ]; then
        # ⚠️ 意図して別の値を入れている可能性がある。⭐ 黙って上書きしない
        echo "  ⚠️ MinConnectionInterval=$CUR です（$WANT_MIN_INTERVAL 以下を推奨）。"
        echo "     手で設定した値と判断して**変更しません**。速さが要るなら:"
        echo "       sudo sed -i 's/^MinConnectionInterval=.*/MinConnectionInterval=$WANT_MIN_INTERVAL/' $BT_CONF"
    else
        # ⚠️ 素の Raspberry Pi OS は `#MinConnectionInterval=`（値なしのコメント行）。
        #    ⭐ 行ごと無い版もありうるので、その場合は [LE] セクションを作って足す
        if grep -q '^[[:space:]]*#[[:space:]]*MinConnectionInterval[[:space:]]*=' "$BT_CONF"; then
            sed -i "0,/^[[:space:]]*#[[:space:]]*MinConnectionInterval[[:space:]]*=.*/s//MinConnectionInterval=$WANT_MIN_INTERVAL/" "$BT_CONF"
        elif grep -q '^\[LE\]' "$BT_CONF"; then
            sed -i "0,/^\[LE\]/s//[LE]\nMinConnectionInterval=$WANT_MIN_INTERVAL/" "$BT_CONF"
        else
            printf '\n[LE]\nMinConnectionInterval=%s\n' "$WANT_MIN_INTERVAL" >> "$BT_CONF"
        fi
        # ⚠️ sed が空振りしても終了ステータスは 0。⭐ 書けたことを必ず確かめる
        if grep -q "^MinConnectionInterval=$WANT_MIN_INTERVAL" "$BT_CONF"; then
            echo "  $BT_CONF に MinConnectionInterval=$WANT_MIN_INTERVAL を設定しました"
        else
            echo "  ⚠️ $BT_CONF を書き換えられませんでした。手で [LE] に足してください:"
            echo "       MinConnectionInterval=$WANT_MIN_INTERVAL"
        fi
    fi
fi

# ⭐ 即時反映。⚠️ debugfs が無い／読めない環境（未マウント・LXC など）では黙って諦める。
#    アダプタは odelicd が D-Bus で見つける（hci0 とは限らない）ので全部に書く
applied=0
for f in /sys/kernel/debug/bluetooth/hci*/conn_min_interval; do
    [ -w "$f" ] || continue
    if echo "$WANT_MIN_INTERVAL" > "$f" 2>/dev/null; then
        echo "  即時反映: $f = $WANT_MIN_INTERVAL"
        applied=1
    fi
done
if [ "$applied" = 0 ]; then
    echo "  ⭐ 即時反映は飛ばしました（debugfs が使えません）。次回の再起動で効きます"
fi

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
