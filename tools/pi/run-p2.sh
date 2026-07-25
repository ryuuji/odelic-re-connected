#!/bin/bash
# フェーズ P2 / P3 の実行ラッパー。
# btmon で全 HCI 通信を記録しながら mesh_peripheral.py を走らせる。
#
#   使い方: ./run-p2.sh [秒数] [mesh_peripheral.py への追加引数...]
#
#   例:
#     ./run-p2.sh 70                                  # 観測のみ
#     ./run-p2.sh 70 --send status                    # 状態要求
#     ./run-p2.sh 70 --send on                        # 点灯
#     ./run-p2.sh 70 --send on --no-login             # ログイン応答なしで点灯
#
# 出力: /tmp/p2.btsnoop（btmon）と標準出力（スクリプトのログ）

set -u

DURATION="${1:-70}"
shift || true

SCRIPT=/tmp/mesh_peripheral.py
OUT=/tmp/p2.btsnoop
ID="${ODELIC_ID:-99833900}"

if [ ! -f "$SCRIPT" ]; then
    echo "[エラー] $SCRIPT がありません。scp してください。" >&2
    exit 1
fi

echo "=== 依存の確認 ==="
python3 -c 'import dbus, gi; print("  dbus / gi: OK")' || {
    echo "[エラー] python3-dbus / python3-gi が必要です:" >&2
    echo "  sudo apt install -y python3-dbus python3-gi" >&2
    exit 1
}

echo
echo "=== btmon 開始 ==="
sudo rm -f "$OUT"
sudo btmon -w "$OUT" >/tmp/btmon-p2.log 2>&1 &
MON_PID=$!
sleep 1
if ! sudo kill -0 "$MON_PID" 2>/dev/null; then
    echo "[エラー] btmon の起動に失敗:" >&2
    cat /tmp/btmon-p2.log >&2
    exit 1
fi
echo "  PID $MON_PID"

echo
echo "=== mesh_peripheral.py 開始 ==="
sudo timeout $((DURATION + 10)) python3 "$SCRIPT" --id "$ID" --duration "$DURATION" "$@"
RC=$?

echo
echo "=== btmon 停止 ==="
sleep 1
sudo kill -INT "$MON_PID" 2>/dev/null || true
sleep 1
sudo kill "$MON_PID" 2>/dev/null || true
sudo chmod a+r "$OUT" 2>/dev/null || true
ls -la "$OUT"

exit $RC
