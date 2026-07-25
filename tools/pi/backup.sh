#!/bin/bash
# ODELIC 照明システムの「失うと復旧が重いもの」だけをバックアップする。
#
#   sudo ./backup.sh              # 1 回取る
#   sudo ./backup.sh --install    # 毎日 03:30 に取る systemd タイマーを仕込む
#   sudo ./backup.sh --list       # 取得済みを一覧
#
# ⚠️⚠️ **出力には秘密情報が入る。**
#   - /etc/default/odelicd    … 8 桁 ID（下位 4 桁はメッシュのパスワード）
#   - /var/lib/odelic-matter  … Matter の fabric 秘密鍵
#   そのため 0600・root 所有で作る。**そのまま他人に渡さないこと。**
#
# ⚠️ **SD カードの故障には、これ単体では効かない。**同じカードに置くので、
#    カードが死ねばバックアップも消える。カード故障に備えるなら開発機へ引き上げる:
#
#      scp odelic-re-connected:/var/backups/odelic/latest.tar.gz .
#      （root 権限が要るので実際は: ssh odelic-re-connected 'sudo cat /var/backups/odelic/latest.tar.gz' > latest.tar.gz）
#
#    これが守るのは「うっかり消した」「アップグレードで壊した」「状態が壊れた」。

set -euo pipefail

DEST=/var/backups/odelic
KEEP=7
ACTION="${1:-once}"

if [ "$(id -u)" != 0 ]; then
    echo "エラー: root で実行してください（sudo $0 ...）" >&2
    exit 1
fi

# 失うと復旧が重いものだけ。ログや再生成できるものは入れない
TARGETS=(
    /var/lib/odelic-matter        # ⭐ Matter の fabric 鍵・uniqueId・器具の名簿
    /var/lib/odelicd             # 広告アドレス・コントローラ識別子（器具が覚えている）
    /etc/default/odelicd         # ⚠️ 8 桁 ID（メッシュのパスワードを含む）
    /etc/odelic-matter           # 器具名・ケルビン設定
)

list_backups() {
    if [ -d "$DEST" ]; then
        ls -lh "$DEST" | tail -n +2
    else
        echo "  まだありません: $DEST"
    fi
}

install_timer() {
    cat > /etc/systemd/system/odelic-backup.service <<EOF
[Unit]
Description=Backup ODELIC lighting state (Matter fabric, roster, config)
Documentation=https://github.com/caliljp/odelic-re-connected

[Service]
Type=oneshot
ExecStart=$(readlink -f "$0")
EOF

    cat > /etc/systemd/system/odelic-backup.timer <<'EOF'
[Unit]
Description=Daily backup of ODELIC lighting state

[Timer]
OnCalendar=*-*-* 03:30:00
# 電源が落ちていて実行できなかった分は起動後に取り返す
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

    systemctl daemon-reload
    systemctl enable --now odelic-backup.timer
    echo "  毎日 03:30 に取得します（次回: $(systemctl show odelic-backup.timer -p NextElapseUSecRealtime --value)）"
}

case "$ACTION" in
    --list)
        echo "=== $DEST ==="
        list_backups
        exit 0
        ;;
    --install)
        install_timer
        ;;
esac

echo "=== バックアップ ==="
install -d -m 0700 "$DEST"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/odelic-$STAMP.tar.gz"

# 存在するものだけを対象にする（片方だけ入っている環境でも失敗させない）
EXISTING=()
for t in "${TARGETS[@]}"; do
    if [ -e "$t" ]; then
        EXISTING+=("$t")
    else
        echo "  スキップ（無い）: $t"
    fi
done
if [ "${#EXISTING[@]}" -eq 0 ]; then
    echo "エラー: バックアップ対象が 1 つもありません" >&2
    exit 1
fi

# ⚠️ 一時ファイルに作ってから rename する。取得中に電源が落ちても
#    半端なファイルが「最新」として残らないようにする
TMP="$OUT.partial"
# ⚠️ stderr を捨てない。捨てると本当のエラーに気づけない。
#    tar は「読み込み中にファイルが変わった」を 1 で返すので、致命的（2 以上）だけ失敗扱いにする
if ! tar czf "$TMP" --absolute-names "${EXISTING[@]}"; then
    rc=$?
    if [ "$rc" -ge 2 ]; then
        echo "エラー: tar が失敗しました (終了コード $rc)" >&2
        rm -f "$TMP"
        exit 1
    fi
    echo "  ⚠️ tar が警告を出しました（読み込み中の変更など）。内容を確認してください"
fi
chmod 0600 "$TMP"
mv "$TMP" "$OUT"
ln -sfn "$(basename "$OUT")" "$DEST/latest.tar.gz"

echo "  作成: $OUT ($(du -h "$OUT" | cut -f1))"
for t in "${EXISTING[@]}"; do echo "    含む: $t"; done

# 古いものを落とす（SD カードの空きが少ないため）
COUNT="$(find "$DEST" -maxdepth 1 -name 'odelic-*.tar.gz' -type f | wc -l)"
if [ "$COUNT" -gt "$KEEP" ]; then
    find "$DEST" -maxdepth 1 -name 'odelic-*.tar.gz' -type f -printf '%T@ %p\n' |
        sort -n | head -n "$((COUNT - KEEP))" | cut -d' ' -f2- |
        while read -r old; do
            echo "  削除（$KEEP 世代を超過）: $(basename "$old")"
            rm -f "$old"
        done
fi

echo
echo "=== 現在の保存状況 ==="
list_backups
echo
echo "空き容量: $(df -h / | awk 'NR==2{print $4}')"

cat <<'EOF'

=== 復元の手順（必要になったとき） ===

⚠️ 復元は Matter のフェアリング情報を差し替えるので、手で慎重に行う。

  sudo systemctl stop odelic-matter odelicd
  sudo tar xzf /var/backups/odelic/latest.tar.gz -C /   # 絶対パスで戻る
  sudo systemctl start odelicd odelic-matter

⚠️ 別の Pi へ移す場合、Matter の fabric 鍵ごと移るので Google Home からは
   「同じデバイス」として見える（再 commissioning は不要）。
   ただし 2 台同時に起動してはいけない（同じ鍵で二重に名乗ることになる）。
EOF
