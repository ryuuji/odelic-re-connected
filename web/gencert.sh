#!/bin/bash
# odelic-web 用の HTTPS 証明書を作る（ローカル CA + サーバ証明書）。
#
#   sudo ./gencert.sh            # 無ければ作る。あるものは触らない
#   sudo ./gencert.sh --renew    # サーバ証明書だけ作り直す（IP が変わったとき）
#   sudo ./gencert.sh --show     # 現在の証明書の内容を表示
#
# ## ⭐ なぜ「ローカル CA + サーバ証明書」の 2 段にするか
#
# 自己署名のサーバ証明書を直接使うと、**作り直すたびにスマホの信頼設定をやり直す**
# ことになる。CA を挟めば、
#
#   - CA は一度だけ端末に信頼させる（10 年有効・作り直さない）
#   - サーバ証明書は好きなだけ作り直せる（IP 変更・期限切れ）
#
# ⚠️ この Pi は **DHCP** なので LAN IP は変わり得る。だから
#    **主たるアクセス名はホスト名**（odelic-re-connected.local）にする。
#    IP も SAN に入れるが、変わったら --renew すればよい。
#
# ## ⚠️ スマホに信頼させる手順（ここを間違えると警告が消えない）
#
#   1. https://odelic-re-connected.local:8443/ca.crt を開いて CA を取得
#      （このとき 1 回だけ警告が出る。それを承認して進む）
#   2. iOS: 設定 → 一般 → VPN とデバイス管理 → プロファイルをインストール
#      ⚠️ **さらに** 設定 → 一般 → 情報 → 証明書信頼設定 で
#         この CA を **オン**にする。**ここを忘れると入れても警告が出続ける**
#   3. Android: 設定 → セキュリティ → 暗号化と認証情報 → 証明書をインストール
#      → 「CA 証明書」を選ぶ（「VPN とアプリ」ではブラウザが信頼しない場合がある）

set -euo pipefail

DIR=/etc/odelic-web/tls
CA_DAYS=3650      # CA は 10 年（作り直さない）
SRV_DAYS=825      # サーバ証明書は約 2 年（ブラウザの上限に配慮）
SVCUSER=odelic-web
ACTION="${1:-auto}"

if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0 ...）" >&2
    exit 1
fi

show() {
    echo "=== CA ==="
    if [ -f "$DIR/ca.crt" ]; then
        openssl x509 -in "$DIR/ca.crt" -noout -subject -dates | sed 's/^/  /'
    else
        echo "  ありません"
    fi
    echo "=== サーバ証明書 ==="
    if [ -f "$DIR/server.crt" ]; then
        openssl x509 -in "$DIR/server.crt" -noout -subject -issuer -dates | sed 's/^/  /'
        echo "  --- SAN ---"
        openssl x509 -in "$DIR/server.crt" -noout -ext subjectAltName | tail -n +2 | sed 's/^/  /'
    else
        echo "  ありません"
    fi
}

if [ "$ACTION" = "--show" ]; then
    show
    exit 0
fi

install -d -m 0755 "$DIR"

# ------------------------------------------------------------ SAN の組み立て
HOST="$(hostname)"
SANS=("DNS:$HOST" "DNS:$HOST.local" "DNS:localhost" "IP:127.0.0.1" "IP:::1")

# LAN の IPv4（複数あれば全部）
while read -r ip; do
    [ -n "$ip" ] && SANS+=("IP:$ip")
done < <(ip -4 -oneline addr show scope global | awk '{split($4,a,"/"); print a[1]}')

# Tailscale の名前と IP（使っていれば）。⚠️ Tailscale 経由なら
# `tailscale cert` で正規の証明書が取れるが、両方使えるようにしておく
if command -v tailscale >/dev/null 2>&1; then
    TSNAME="$(tailscale status --json 2>/dev/null |
        python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
    [ -n "${TSNAME:-}" ] && SANS+=("DNS:$TSNAME")
    while read -r ip; do
        [ -n "$ip" ] && SANS+=("IP:$ip")
    done < <(tailscale ip 2>/dev/null || true)
fi

SAN_LINE="$(IFS=,; echo "${SANS[*]}")"

# ------------------------------------------------------------------- CA
if [ -f "$DIR/ca.key" ] && [ -f "$DIR/ca.crt" ]; then
    echo "=== CA は既にあります（作り直しません） ==="
    echo "  ⭐ 作り直すとスマホの信頼設定をやり直すことになるため、意図的に触りません"
else
    echo "=== ローカル CA を作成 ==="
    openssl req -x509 -newkey rsa:2048 -sha256 -days "$CA_DAYS" -nodes \
        -keyout "$DIR/ca.key" -out "$DIR/ca.crt" \
        -subj "/CN=ODELIC Lighting Local CA ($HOST)/O=odelic-re-connected" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    chmod 0600 "$DIR/ca.key"   # ⚠️ CA の秘密鍵。漏れると偽サイトを作られる
    chmod 0644 "$DIR/ca.crt"   # 端末に配るので読めてよい
    echo "  作成: $DIR/ca.crt（10 年）"
fi

# --------------------------------------------------------- サーバ証明書
if [ -f "$DIR/server.crt" ] && [ "$ACTION" != "--renew" ]; then
    # SAN が今の構成と食い違っていたら教える（IP が変わったときに気づけるように）
    CUR="$(openssl x509 -in "$DIR/server.crt" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')"
    MISSING=""
    for s in "${SANS[@]}"; do
        case "$CUR" in *"$s"*) ;; *) MISSING="$MISSING $s" ;; esac
    done
    echo "=== サーバ証明書は既にあります ==="
    if [ -n "$MISSING" ]; then
        echo "  ⚠️ 今の構成に含まれていない名前があります:$MISSING"
        echo "     IP が変わった可能性があります。作り直すには: sudo $0 --renew"
    else
        echo "  現在の構成をすべて含んでいます"
    fi
else
    echo "=== サーバ証明書を作成 ==="
    echo "  SAN: $SAN_LINE"
    openssl req -newkey rsa:2048 -sha256 -nodes \
        -keyout "$DIR/server.key" -out "$DIR/server.csr" \
        -subj "/CN=$HOST.local" 2>/dev/null
    openssl x509 -req -in "$DIR/server.csr" -sha256 -days "$SRV_DAYS" \
        -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
        -out "$DIR/server.crt" \
        -extfile <(printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$SAN_LINE") 2>/dev/null
    rm -f "$DIR/server.csr"
    echo "  作成: $DIR/server.crt（${SRV_DAYS} 日）"
fi

# ---------------------------------------------------- 権限（非 root で読む）
if id "$SVCUSER" >/dev/null 2>&1; then
    chgrp "$SVCUSER" "$DIR/server.key"
    chmod 0640 "$DIR/server.key"   # ⚠️ サーバの秘密鍵。サービスだけが読める
    echo "  $DIR/server.key を $SVCUSER が読めるようにしました"
else
    chmod 0600 "$DIR/server.key"
    echo "  ⚠️ ユーザー $SVCUSER がまだ無いので server.key は root のみ（install.sh 後に再実行してください）"
fi

echo
show

cat <<EOF

=== スマホに CA を信頼させる ===

  1. https://$HOST.local:8443/ca.crt を開く（このとき 1 回だけ警告が出る）
  2. iOS   : プロファイルをインストール後、⚠️ **設定 → 一般 → 情報 →
             証明書信頼設定** でこの CA を必ずオンにする（忘れると警告が消えない）
     Android: 「CA 証明書」としてインストールする

⚠️ この Pi は DHCP です。LAN IP が変わったら:  sudo $0 --renew
   ⭐ CA は変わらないので、**スマホの信頼設定はやり直し不要**です。
EOF
