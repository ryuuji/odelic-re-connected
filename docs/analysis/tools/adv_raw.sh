#!/bin/bash
# raw HCI で ADV_PHONE ビーコンを直接送る。
#
# BlueZ の D-Bus 経路（LEAdvertisingManager1）は Pi 3 + カーネル 6.18 で
# SupportedInstances = 0 になり使えない（mgmt Add Advertising が Invalid Parameters）。
# そこで HCI コマンドを直接叩く。
#
#   使い方: ./adv_raw.sh on   [HOMEID10進] # 例: ./adv_raw.sh on 1234
#           ./adv_raw.sh off
#           ./adv_raw.sh status
#
# 送るアドバタイズ（docs/02-protocol.md C3 / C17-3）:
#   02 01 06                                Flags
#   10 FF 00 00 C0 FF 05 <HOMEID 4> <MAC 6> Manufacturer Specific Data
#     └ len=16, type=0xFF, CompanyID=0x0000, マジック C0 FF, ADV_PHONE=05

set -u

ACTION="${1:-status}"
# HOMEID をソースに埋めない。第 2 引数か環境変数 ODELIC_HOMEID で渡す
HOMEID_DEC="${2:-${ODELIC_HOMEID:-}}"
if [ -z "$HOMEID_DEC" ]; then
    echo "エラー: HOMEID（10 進）を第 2 引数か ODELIC_HOMEID で指定してください" >&2
    exit 1
fi
DEV=hci0

OGF_LE=0x08
OCF_SET_ADV_PARAMS=0x0006
OCF_SET_ADV_DATA=0x0008
OCF_SET_ADV_ENABLE=0x000a

le16() { # 10進 → リトルエンディアン 2 バイトの16進（"XX XX"）
    printf '%02x %02x' $(( $1 & 0xff )) $(( ($1 >> 8) & 0xff ))
}

adv_off() {
    sudo hcitool -i $DEV cmd $OGF_LE $OCF_SET_ADV_ENABLE 00 >/dev/null
    echo "アドバタイズ停止"
}

adv_on() {
    # HOMEID は 10 進数のリトルエンディアン 4 バイト（C16-2）。4 桁なので上位 2 バイトは 00 00
    HOMEID_HEX=$(printf '%02x %02x 00 00' \
        $(( HOMEID_DEC & 0xff )) $(( (HOMEID_DEC >> 8) & 0xff )))

    # アダプタの MAC を取得してバイト列にする
    MAC=$(hciconfig $DEV | awk '/BD Address/{print $3}')
    MAC_HEX=$(echo "$MAC" | tr ':' ' ' | tr 'A-F' 'a-f')

    echo "HOMEID $HOMEID_DEC → $HOMEID_HEX"
    echo "MAC    $MAC → $MAC_HEX"

    # カーネル側のアドバタイズを止めてスロットを空ける
    sudo btmgmt advertising off >/dev/null 2>&1 || true
    adv_off >/dev/null 2>&1 || true

    # LE Set Advertising Parameters
    #   interval min/max = 0x00A0 (100ms) ← 公式アプリの ADVERTISE_MODE_LOW_LATENCY 相当
    #   adv_type = 0x00 (ADV_IND: 接続可能・無指向) ← 器具から接続してもらう必要がある
    #   own_addr_type = 0x00 (public)
    #   channel map = 0x07 (全 3 チャネル)
    sudo hcitool -i $DEV cmd $OGF_LE $OCF_SET_ADV_PARAMS \
        a0 00 a0 00 00 00 00 00 00 00 00 00 00 07 00 >/dev/null

    # LE Set Advertising Data: significant_length + 31 バイト固定
    AD="02 01 06 10 ff 00 00 c0 ff 05 $HOMEID_HEX $MAC_HEX"
    NBYTES=$(echo $AD | wc -w)
    PAD=""
    for _ in $(seq 1 $((31 - NBYTES))); do PAD="$PAD 00"; done
    LEN=$(printf '%02x' "$NBYTES")

    echo "AD [$NBYTES バイト]: $AD"
    sudo hcitool -i $DEV cmd $OGF_LE $OCF_SET_ADV_DATA $LEN $AD $PAD >/dev/null

    # LE Set Advertising Enable
    sudo hcitool -i $DEV cmd $OGF_LE $OCF_SET_ADV_ENABLE 01 >/dev/null
    echo "アドバタイズ開始"
}

adv_status() {
    echo "=== btmgmt info ==="
    sudo btmgmt info | grep -E "current settings"
    echo
    echo "=== 現在のアドバタイズデータ（LE Read Advertising Channel TX Power と併せて確認）==="
    sudo hcitool -i $DEV cmd 0x08 0x0007 2>&1 | head -4
}

case "$ACTION" in
    on) adv_on ;;
    off) adv_off ;;
    status) adv_status ;;
    *) echo "使い方: $0 {on|off|status} [HOMEID10進]" >&2; exit 1 ;;
esac
