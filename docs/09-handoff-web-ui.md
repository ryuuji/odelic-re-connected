# 09. 引き継ぎ — 設定ページ（`odelic-web`）の続き

このドキュメントは**別セッションへの引き継ぎ**用。
設計は [08-web-ui.md](08-web-ui.md)、ここには**現在地・決定事項・次の一手・踏んだ罠**を書く。

最終更新: 2026-07-26（作業セッション終了時点）

---

## H1. 何を作っているのか

ODELIC 照明を**ブラウザから設定・操作**できるようにする（ルーターの設定画面のような
もの + スマートフォン向けの操作 UI）。

前提として次が**既に完成し運用中**。ここは触らない。

| | 状態 |
| --- | --- |
| `odelicd`（BLE 制御・Python） | ✅ 運用中。到達率 1.000 / リンク切断 0 |
| `odelic-matter`（Matter ブリッジ） | ✅ 運用中。Google Home から操作できる |
| `@odelic/common`（共有パッケージ） | ✅ 完成 |
| 状態のバックアップ | ✅ 毎日 03:30 |

→ 全体像は [tools/pi/README.md](../tools/pi/README.md)、
Matter の詳細は [07-matter.md](07-matter.md)。

---

## H2. 現在地

### ✅ 済み

| # | 項目 | 成果物 |
| --- | --- | --- |
| 1 | **共有パッケージの切り出し** | [`tools/pi/common/`](../tools/pi/common/) — 36 テスト |
| 2a | **HTTPS 証明書の生成** | [`tools/pi/web/gencert.sh`](../tools/pi/web/gencert.sh) — 実機で検証済み |

`common` に入れたもの（**二重に持つと必ずずれるもの**だけ）。

- `capability.ts` — 製品コード → 器具の能力（常夜灯・調色の有無・非照明の除外）
- `ladder.ts` — ⭐ **明るさの段の定義**。`ladder(nightLight)` が段を暗い順に返し、
  `rungIndexOfState()` が器具の状態を段に落とす。**UI のスライダーはこの配列の添字を使う**

⚠️ **Matter 固有の量子化（`CurrentLevel` 1〜254 / mired）は共有していない。**
`odelic-web` は `odelicd` を直接呼ぶので Matter の値域を知る必要がない。

証明書は Pi 上に生成済み（`/etc/odelic-web/tls/`）。

- ローカル CA（10 年・**作り直さない**）+ サーバ証明書（825 日・再生成可）
- SAN: `odelic-re-connected` / `.local` / `localhost` / `172.16.0.16` /
  Tailscale の名前と IP
- ⭐ 4 つの名前すべてで**ホスト名照合が通ることを実機で確認**

### 🚧 次にやること（この順で）

| # | 項目 | 備考 |
| --- | --- | --- |
| **2b** | **Web サーバ本体（HTTPS + パスワード + セッション）** | ⭐ **ここから**。UI より先に認証を固める |
| 3 | 照明の操作画面（スマホ向け） | `odelicd` 直接。`ladder()` でスライダー |
| 4 | 状態画面 | `odelicd` の `/metrics` を可視化 |
| 5 | ブリッジの管理 API | → H5 |
| 6 | 設定画面（器具名・各種設定） | 管理 API 経由 |
| 7 | HOMEID の設定 | 特権ヘルパ + sudoers → H6 |
| 8 | Matter の登録画面 | QR / 追加フェアリング |
| 9 | ログ画面 | ⚠️ マスク必須 → H7 |
| 10 | systemd + install.sh + ドキュメント | |

---

## H3. 決まっていること（再検討不要）

ユーザーと合意済み。**問い直さずに進めてよい。**

| 論点 | 決定 |
| --- | --- |
| 配置 | ⭐ **別プロセス**（`odelic-web`）。`odelicd` とブリッジは触らない |
| 公開 | **LAN**・HTTPS（自己署名 + ローカル CA）+ パスワード |
| 照明操作の経路 | ⭐ **`odelicd` 直接**（ブリッジを単一障害点にしない） |
| 器具名・Matter 状態 | ⭐ **ブリッジの管理 API 経由**（所有者を 1 つに保つ） |
| HOMEID | **入力・変更のみ**。⚠️ 新規発行はスコープ外（破壊的） |
| UI の技術 | 素の HTML/CSS/JS（**ビルド不要**）。フレームワークは使わない |
| スマホ UI の範囲 | 照明操作 / 状態可視化 / Matter 登録 / 簡易ログ |

### ⏳ 唯一の未決事項

**初回パスワードの設定方法。**セッション終了時に提案したが返答を得ていない。

| 案 | |
| --- | --- |
| (a) 初回アクセス時にブラウザで設定 | ⚠️ 先に到達した人が設定できてしまう |
| (b) インストール時に SSH で設定 | 安全だが手間 |
| ⭐ (c) インストール時にランダム生成して journald に出す | ルーターの初期パスワード方式。**推奨として提案済み** |

→ **返答が無ければ (c) で進める**と伝えてある。

---

## H4. Web サーバ本体（次の一手・#2b）

### 満たすこと

| | |
| --- | --- |
| HTTPS | `/etc/odelic-web/tls/server.{crt,key}` を読む。⚠️ 鍵は 0640 で `odelic-web` グループ |
| HTTP で来たら | HTTPS へリダイレクト（パスワードを平文で流さない） |
| パスワード | `scrypt` でハッシュ化して保存。**平文で置かない** |
| セッション | HttpOnly + Secure + SameSite クッキー。ランダム 32 バイト・期限あり |
| 総当たり対策 | 失敗回数で遅延（IP ごと） |
| `/ca.crt` | ⭐ **認証なしで配る**（CA を取得できないと信頼させられない） |

⚠️ **`/ca.crt` だけは認証の外に置く。**ここを認証の内側にすると、
「信頼するには CA が必要／CA を取るにはログインが必要／ログインするには
警告を踏む」という循環になる。

### 実装の目安

- ランタイムは Node の `node:https` + `node:http`。⭐ **フレームワークを入れない**
  （Pi 3 で軽く、依存が増えない。ルーティングは数十行で足りる）
- 静的ファイルは `web/public/` から配る
- ⚠️ `odelic-matter` と同じく **`@odelic/common` を `file:../common` で参照**する。
  ビルド順序は [tools/pi/README.md](../tools/pi/README.md) を見ること

### テスト

⭐ `odelic-matter` と同じやり方が効く。**偽 `odelicd` を localhost に立てて統合テスト**
（`matter/test/bridge.test.ts` が手本）。認証は「ログインなしで API を叩けないこと」を
必ず固定する。

---

## H5. ブリッジに追加する管理 API（#5）

⚠️ **`127.0.0.1:8081` に限定**する。認証は `odelic-web` 側で済ませる。

| メソッド | パス | 内容 |
| --- | --- | --- |
| `GET` | `/admin/state` | 器具（名前・能力・段の状態）+ Matter の状態 |
| `GET` | `/admin/commissioning` | QR / 手入力コード / commissioned |
| `POST` | `/admin/commissioning/open` | 追加フェアリング（multi-admin）の窓を開く |
| `POST` | `/admin/fixtures/<mac>/name` | 器具名の変更（`config.json` を更新） |
| `DELETE` | `/admin/fixtures/<mac>` | 名簿から外す（器具を本当に撤去したとき） |

実装場所は `matter/src/bridge.ts`（`Bridge` クラスが名簿・設定・Matter 状態を持っている）。

⚠️ **器具名の変更は Google Home 側の名前を上書きしない。**Google Home は登録時に
自分側で名前を保存する。UI にその旨を明記すること（→ [07 M6](07-matter.md)）。

⚠️ 反映にブリッジの再起動が必要かは実装で詰める。必要なら UI にそう出す
（再起動は commissioning 直後でなければ安全）。

---

## H6. HOMEID の設定（#7）

⚠️ `odelic-web` は**非 root** で動かす。しかし `/etc/default/odelicd`（0600 root）への
書き込みと `odelicd` の再起動には root が必要。

→ ⭐ **専用ヘルパ 1 本だけ**を sudoers で許可する。

```
# /etc/sudoers.d/odelic-web
odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/set-id.sh
```

`set-id.sh` がやること（それ以外は何もしない）。

1. 引数が **8 桁の数字**であることを検証（違えば拒否）
2. `/etc/default/odelicd` の `ODELIC_ID` を書き換え（0600 を維持）
3. `systemctl restart odelicd`

⚠️⚠️ **汎用スクリプト（`install.sh` など）を sudoers に入れてはいけない。**
引数で任意のことができると、Web の脆弱性がそのまま root 権限になる。

### 入力ミスの検出

⭐ **誤った ID は器具の応答で即座に分かる**（→ [02 C23-1](02-protocol.md)）。
`PERIPHERAL_LOGIN` を LOGINKEY で復号し、先頭 4 バイトが HOMEID と一致するかを見ている。

→ 保存後に `GET /info` を数十秒監視し、`joined` にならなければ
「ID が違う可能性があります」と出して**元の ID に戻せる**ようにする。

---

## H7. ⚠️ ログ画面のマスク（#9）

`journalctl` の出力には**秘密情報が出る**。表示前に必ずマスクする。

| 出所 | 例 |
| --- | --- |
| `odelicd` の起動時 | `ID 12345678 → HOMEID D2 04 00 00 / パスワード 35 36 37 38` |
| 同 | `鍵を導出: LOGINKEY ... / EVENTKEY ...` |
| `odelic-matter` | commissioning の passcode / 手入力コード |

⚠️ **`grep -v` で行を捨てるのではなく、値をマスクする**（行ごと消すと
「なぜ動かないか」を追えなくなる）。

---

## H8. この作業で踏んだ罠（同じ穴を避けるため）

### ビルド・テスト

1. ⚠️ **`tsc` は削除されたソースの出力を消さない。**ファイルを移動したのに
   古い `dist` が残り、**移動前のコードでテストが通っていた**
2. ⚠️ **`declaration: true` が `*.test.d.ts` を吐き、Node がそれをテストとして実行する。**
   中身が空なので通り、テスト数が水増しされる
3. ⚠️ **`common` の `clean` が `dist` を消すと matter のビルドが壊れる。**
   `dist` は他パッケージが参照する成果物

→ 詳細と対処は [tools/pi/README.md](../tools/pi/README.md)。

### シェル

4. ⚠️ **`sudo` の前にシェルがグロブを展開する。**`sudo rm -rf /path/*` は
   呼び出し側の非 root シェルが 0700 のディレクトリを読めず、
   **何もせず成功したように見える**。`sudo sh -c 'rm -f /path/*'` とする
5. ⚠️ **`sh`（dash）は brace 展開に非対応。**`{a,b}` は使えない

### 非同期

6. ⚠️ **競合は速いマシンで隠れる。**Pi 3 で初めて出たバグが 2 件あった。
   重要な変更のあとは実機でもテストを走らせる
7. ⚠️ **「たまに落ちるテスト」を放置しない。**8 回に 1 回落ちるテストを追ったら、
   実運用の同期バグ（設定した値が古い情報で巻き戻る）が出てきた。
   アサーションに実測値を入れる → 内部値の診断ログを出す、の 2 段で特定できた

### Matter / Google Home

8. ⚠️ **commissioning 直後にブリッジを再起動してはいけない**（Nest ハブが器具を失う）
9. ⚠️ **エンドポイントは `server.start()` の前に揃える**
   （空の Aggregator でオンラインになると毎回「デバイスが追加されました」通知が出る）
10. ⚠️ **`avahi-resolve -n` は既定で A レコードしか返さない**（AAAA は `-6`）。
    運用時アドバタイズの service type は **`_matter._tcp`**（`_matterc._udp` は commissioning 用）

---

## H9. 環境

| | |
| --- | --- |
| Pi | `odelic-re-connected`（Tailscale / SSH 可）。aarch64 / Debian 13 / Node 20.19.2 |
| LAN IP | `172.16.0.16/16`（⚠️ **DHCP**。変わったら `gencert.sh --renew`） |
| ホスト名 | `odelic-re-connected.local`（avahi 稼働）← ⭐ 主たるアクセス名 |
| Tailscale | `odelic-re-connected.turtle-eagle.ts.net`（⭐ `tailscale cert` で正規証明書が取れる） |
| メモリ | RAM 905 MB。`odelicd` 31 MB + ブリッジ 142 MB。⚠️ **Web の分を測ること** |
| ディスク | `/` が **90% 使用・空き 700 MB**。⚠️ `node_modules` が増えるので実測 |
| 器具 | 2 台（`EC:C5:7F:81:DE:CD` / `EC:C5:7F:80:28:A6`）。どちらも `0x2B`（調光調色 + 常夜灯） |

⚠️ **開発機からの `curl http://odelic-re-connected:8080/...` は現在使える**
（`odelicd` が無認証で `0.0.0.0:8080`）。これを localhost に絞る話は**保留中**で、
ユーザーの判断待ち。絞ると SSH 経由に変わる。

---

## H10. 最初にやること（引き継ぎ先へ）

```bash
# 1. ビルドが通ることを確認（⚠️ common を先に）
cd tools/pi/common && npm install && npm run build && npm test   # 36 件
cd ../matter && npm install && npm test                          # 95 件

# 2. Pi の状態を確認
ssh odelic-re-connected "systemctl is-active odelicd odelic-matter"
ssh odelic-re-connected "sudo bash /tmp/gencert.sh --show"   # 証明書（未配備なら web/gencert.sh を送る）

# 3. 設計を読む
#    docs/08-web-ui.md … 設計
#    docs/09（このファイル）… 現在地・決定事項・罠
#    tools/pi/README.md … ビルド順序とテストの罠
```

そのうえで **H4（Web サーバ本体）から着手**する。
⭐ UI より先に認証を固める。UI を先に作ると認証が後付けになり漏れが出る。
