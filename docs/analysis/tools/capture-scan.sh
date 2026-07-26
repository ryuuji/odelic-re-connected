#!/bin/bash
# 器具のアドバタイズを btmon でキャプチャする（フェーズ P1）。
#
# Raspberry Pi 上で実行する。btmon は btsnoop 形式（datalink 2001 = Linux Monitor）
# で書き出すので、開発機に持ち帰って tools/btsnoop.py で解析できる。
#
#   使い方: ./capture-scan.sh [秒数]   （既定 30 秒）
#
# 出力: /tmp/pi-scan.btsnoop
#
# スキャンは btmgmt（mgmt API）で駆動する。bluetoothctl の対話モードは
# 非対話実行だと取りこぼすため使わない。

set -u

DURATION="${1:-30}"
OUT=/tmp/pi-scan.btsnoop

echo "=== キャプチャ開始（${DURATION} 秒）==="
sudo rm -f "$OUT"

# btmon を先に起動して全 HCI 通信を記録する
sudo btmon -w "$OUT" >/tmp/btmon.log 2>&1 &
MON_PID=$!
sleep 1

if ! sudo kill -0 "$MON_PID" 2>/dev/null; then
    echo "[エラー] btmon の起動に失敗しました:" >&2
    cat /tmp/btmon.log >&2
    exit 1
fi

# btmgmt find は 1 回のディスカバリで終わるので、時間いっぱい繰り返す。
# 器具のアドバタイズ周期が長い場合に取りこぼさないため。
echo "スキャン中..."
END=$((SECONDS + DURATION))
ROUND=0
while [ $SECONDS -lt $END ]; do
    ROUND=$((ROUND + 1))
    sudo timeout 12 btmgmt find >> /tmp/btmgmt-find.log 2>&1 || true
done
echo "  ディスカバリ ${ROUND} 回実施"

# 後片付け
sleep 1
sudo kill -INT "$MON_PID" 2>/dev/null || true
sleep 1
sudo kill "$MON_PID" 2>/dev/null || true
sudo chmod a+r "$OUT" 2>/dev/null || true

echo
echo "=== 結果 ==="
ls -la "$OUT"
echo
echo "btsnoop ヘッダ（datalink type）:"
sudo head -c 16 "$OUT" | od -An -tx1
echo
echo "=== 検出したユニークなデバイス ==="
grep -ao "dev_found: [0-9A-F:]*" /tmp/btmgmt-find.log 2>/dev/null \
    | sed 's/dev_found: //' | sort -u | head -40
echo
echo "=== Pairlink 系の OUI に一致するもの（00:95:69 / F0:AC:D7）==="
grep -aoE "dev_found: (00:95:69|F0:AC:D7)[0-9A-F:]*" /tmp/btmgmt-find.log 2>/dev/null \
    | sort -u || echo "  (なし)"
