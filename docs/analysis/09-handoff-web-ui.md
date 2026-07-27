# 09. 設定ページ（`odelic-web`）— 完成の記録と踏んだ罠

設計は [08-web-ui.md](../08-web-ui.md)、ここには **何が動いているか・決めたこと・
踏んだ罠** を書く。元は別セッションへの引き継ぎ用だったが、
✅ 2026-07-26 に #2b〜#10 をすべて実装したので記録に切り替えた。

---

## H1. 何を作ったのか

ODELIC 照明を **ブラウザから設定・操作** できるようにした（ルーターの設定画面の
ようなもの + スマートフォン向けの操作 UI）。

| | 状態 |
| --- | --- |
| `odelicd`（BLE 制御・Python） | ✅ 運用中。到達率 1.000 / リンク切断 0 |
| `odelic-matter`（Matter ブリッジ） | ✅ 運用中 + ⭐ 管理 API を追加 |
| `@odelic/common`（共有パッケージ） | ✅ + ⭐ MAC ユーティリティと JSONC パーサを追加 |
| `odelic-web`（設定ページ） | ✅ 完成 |
| 状態のバックアップ | ✅ 毎日 03:30（⭐ CA の鍵とパスワードも対象に追加） |

→ 全体像は [docs/10-development.md](../10-development.md)、
Matter の詳細は [07-matter.md](../07-matter.md)。

---

## H2. 完成したもの

| # | 項目 | 成果物 |
| --- | --- | --- |
| 1 | 共有パッケージ | [`common/`](../../common) — 48 テスト |
| 2a | HTTPS 証明書 | [`web/gencert.sh`](../../web/gencert.sh) |
| 2b | ⭐ Web サーバ本体（HTTPS + パスワード + セッション） | `web/src/{server,auth,routes}.ts` |
| 3 | 照明の操作画面 | `web/public/js/lights.js` |
| 4 | 状態画面 | `web/public/js/status.js` |
| 5 | ブリッジの管理 API | `matter/src/admin.ts` — 23 テスト |
| 6 | 設定画面 | `web/public/js/settings.js` |
| 7 | ⭐ メッシュ ID の設定（特権ヘルパ） | `web/set-id.sh` + sudoers |
| 8 | Matter の登録画面 | `web/public/js/matter.js` |
| 9 | ⚠️ ログ画面（マスク付き） | `web/src/mask.ts` — 20 テスト |
| 10 | systemd + install.sh | `web/odelic-web.service` / `web/install.sh` |

**テスト合計 287 件**（common 48 / matter 114 / web 125）。⭐ どれも BLE も Pi も使わない。

---

## H2b. ⭐ 実機で確認したこと（2026-07-26）

`https://odelic-re-connected.local:8443/` で稼働中。

| # | 確認 | 結果 |
| --- | --- | --- |
| 1 | 認証なしで `/api/state` | ✅ 401（器具の情報も操作も漏れない） |
| 2 | `/ca.crt` | ✅ 200 / `application/x-x509-ca-cert`（認証の外） |
| 3 | 平文 HTTP を 8443 に | ✅ 301 → `https://…:8443/settings`（同じポートで判別できた） |
| 4 | ホスト名照合 | ✅ `.local` / `localhost` / IP の 3 つとも通った |
| 5 | ⭐ 照明の閉ループ | ✅ 点灯 → 主灯 50% → 常夜灯（中）→ 消灯。すべて器具の応答で確認 |
| 6 | 常夜灯の段 | ✅ 段 1 → `night=2`（＝ 中）。`ladder()` の並びと器具の値が一致 |
| 7 | ⭐⭐ ログのマスク | ✅ 実機の journal で 秘密が 1 つも通らない（下記） |
| 8 | ホーム ID | ✅ 8 桁をそのまま表示（→ [08 W10-4](../08-web-ui.md)）。不正な引数は 4 種すべて 400 で拒否 |
| 9 | sudoers | ✅ `set-id.sh` 1 本だけ。`--help` も `; reboot` も拒否 |
| 10 | 器具名の変更 | ✅ 再起動なしで反映し、名簿に残った |
| 11 | Matter | ✅ commissioned / fabric 1 個（Google 0x6006）/ エンドポイント番号は不変 |
| 12 | `odelic-web` の再起動 | ✅ 2.2 秒で復帰。⭐ セッションは維持される（`sessions.json`・→ H5） |

### ⭐ マスクの実測（実機の journal をそのまま通した）

⚠️ 下はプレースホルダに置き換えた見た目（実値はリポジトリに書かない）。
実機では確かにこの形で伏せられていることを確認した。

```
[ 0.011] ID 1234•••• → HOMEID D2 04 00 00 / パスワード •• •• •• ••
[ 3.300] 鍵を導出: LOGINKEY •• •• •• •• …… / EVENTKEY •• •• •• ••
[ 7.345] ★ ログイン要求を復号: EC:C5:7F:81:DE:CD の鍵 = •• •• •• ••
[ 5.503] アドバタイズ開始 …  AD=02 01 06 10 FF …   ← ⭐ 意図的に残している
```

### メモリとディスク（実測）

| | RSS | |
| --- | --- | --- |
| `odelicd` | 37 MB | |
| `odelic-matter` | 133 MB | `MemoryMax=320M` |
| ⭐ `odelic-web` | 77 MB | `MemoryMax=192M` — 余裕あり。下げる必要なし |
| 合計 | 247 MB | RAM 905 MB 中 空き 423 MB |

ディスクは `/` が 92% 使用・**空き 572 MB**（配備前より減っていない。
⭐ `odelic-web` は実行時依存がゼロで、ビルド後に `npm prune` しているため）。

⚠️ 送信 PDU は **1 操作あたり 2 通**（コマンド 1 + 収束確認の状態要求 1）。
`?wait=1` を使っているためで、設計どおり。スライダーの連射は起きていない。

---

## H3. 決めたこと

| 論点 | 決定 |
| --- | --- |
| 配置 | ⭐ 別プロセス（`odelic-web`）。`odelicd` は 1 行も触っていない |
| 公開 | LAN・HTTPS（自己署名 + ローカル CA）+ パスワード |
| 照明操作の経路 | ⭐ `odelicd` 直接。⭐ ブリッジが落ちていても照明は操作できる |
| 器具名・Matter 状態 | ⭐ ブリッジの管理 API 経由（所有者を 1 つに保つ） |
| HOMEID | 入力・変更のみ。新規発行はスコープ外（破壊的） |
| UI の技術 | 素の HTML/CSS/JS。⭐ 実行時依存ゼロ（`@odelic/common` だけ） |
| ⭐ 初回パスワード | インストール時にランダム 16 文字を生成し、1 回だけ表示（ルーター方式） |

⚠️ ブラウザから初回設定させる方式は **採らなかった**。LAN 内で
**先に到達した人** がパスワードを決められてしまうため。

設計から変えた 6 点は [08 W10](../08-web-ui.md#w10-設計から変えたところ) に理由つきで書いた。

---

## H4. ⚠️⚠️ 今回いちばん重要だった発見

### Pi のブリッジは `@odelic/common` 分離前のビルドで動いていた

作業開始時に実機を見たら、

- `/opt/odelic-matter/dist/src/capability.js` が **残っていた**（分離前のビルド）
- `/opt/odelic-matter/node_modules/@odelic` が **存在しなかった**
- `package.json` の `file:../common` は Pi では `/opt/common` を指すが、
  実際に staged されていたのは `/opt/odelic-common`

→ **管理 API を載せた新しいブリッジを配備した瞬間に
`Cannot find module '@odelic/common'` で落ちるところだった。**

対処（[docs/10-development.md](../10-development.md) にも書いた）。

1. ⭐ `common/install.sh` が `/opt/odelic-common` に配置し、
   `/opt/common` をそこへのシンボリックリンクにする
2. ⭐ 各 install.sh が依存を入れた直後に
   `import('@odelic/common')` が通ることを実際に確かめる

⭐ パスを書き換える方式（`file:/opt/odelic-common` に直す）は避けた。
書き換えると `package-lock.json` が使えなくなり `npm ci` が `npm install` に落ちて、
matter.js のバージョンが勝手に上がりかねない。

---

## H5. 認証まわりで決めたこと

| | |
| --- | --- |
| 保存 | `scrypt`（N=16384）のハッシュのみ。`/var/lib/odelic-web/auth.json`（0600） |
| 比較 | ⭐ `timingSafeEqual`（`===` だと合っている桁数が応答時間に出る） |
| セッション | 32 バイト乱数。⭐ `SHA-256` だけを永続化（`sessions.json`・0600） |
| クッキー | `HttpOnly; Secure; SameSite=Lax` |
| 総当たり | IP ごとに `250ms × 2^(n-1)`（上限 30 秒）だけ遅らせる |
| CSRF | `Origin` の一致 + 独自ヘッダ `X-Odelic-Request` |
| ⭐ `/ca.crt` | 認証の外（ここを内側にすると信頼の循環になる） |

⚠️ **締め出しはしない。** 締め出すと、外から失敗させ続けるだけで家族が
ログインできなくなる（可用性への攻撃になる）。

### ⭐ セッションの永続化（当初のメモリ内のみから変えた）

`systemctl restart odelic-web` のたびに家族全員がログアウトするのは実用に耐えなかったので、
`/var/lib/odelic-web/sessions.json`（0600）に置くことにした。

⚠️⚠️ ただし生のトークンは書かない。書いたらそのファイルは Cookie そのものになる。
⭐ 保存するのは **`SHA-256(token)`** だけで、照合は「受け取ったトークンを SHA-256 して引く」。
ファイルが漏れてもトークンは復元できない。

⚠️ パスワードと違って **遅いハッシュは要らない**。トークンは 32 バイトの乱数なので
総当たりの余地がなく、scrypt にすると毎リクエスト 100 ms 遅くなるだけ。

⚠️⚠️ 各セッションは発行時のパスワードの `updatedAt` を持つ。
`reset-password.sh`（= `install.sh --show-password`）は `auth.json` を プロセスを通さずに差し替える ので、
これが無いと「パスワードを忘れたのでリセットした」あとも古いセッションで入れてしまう。
→ 読み込み時に今のパスワードと突き合わせて、違うものは捨てる（`install.sh` 側でも `rm` する）。

⚠️ 書けなくても ログインは通す。永続化は利便性の機能であって、
認証の可否をディスクの状態に握らせない（書けない理由は journald に 1 回だけ出す）。

---

## H6. ホーム ID の設定（特権操作）

```
/etc/sudoers.d/odelic-web:
  odelic-web ALL=(root) NOPASSWD: /opt/odelic-web/set-id.sh
```

⚠️ sudoers はパスだけを許可するので、呼び出し側は任意の引数を渡せる。
`set-id.sh` は argv を 8 桁の数字 / `--rollback` / `--status` の 3 つに絞っている
（⭐ 検証を root チェックより前に置いたので、非 root でも動作確認できる）。

| 引数 | 動作 |
| --- | --- |
| `<8 桁の数字>` | 現行値を `/etc/default/odelicd.prev`（0600 root）へ退避 → 書換 → `odelicd` 再起動 |
| `--rollback` | 退避と現行値を入れ替えて再起動（もう一度押せば戻る） |
| `--status` | 今の 8 桁をそのまま（`id=12345678 rollback=yes`） |

⭐ **8 桁はそのまま画面に出す。** 同じ番号が公式アプリのメニュー画面にも表示されており、
ここだけ伏せても守れるものが無い（設定し直すときに読めないほうが困る）。

⚠️ ただし **ログには出さない**。`src/mask.ts` は journald 側で伏せたままにしてある
（ログは人に見せることがあるが、この画面はログイン済みの本人しか見ない）。

⭐ 巻き戻しはヘルパ側の退避ファイルで行うので、`odelic-web` が旧値を覚える必要はない。

### 入力ミスの検出

⭐ **誤った ID は器具の応答で分かる**（→ [02 C23-1](../02-protocol.md)）。
`odelicd` は `PERIPHERAL_LOGIN` を復号して先頭 4 バイトが HOMEID と一致するかを見ている。

→ 保存後、ブラウザが 3 秒ごとに `GET /api/homeid` を 60 秒見張る。
`joined` が立たなければ「ID が違う可能性」を出して巻き戻しを提案する。

⚠️ **サーバ側でブロックして待たない。**`odelicd` の再起動から参加までは
数十秒かかることがあり、その間 HTTP を掴んだままだと「固まった」ようにしか見えない。

---

## H7. ⚠️ ログのマスク

実機の journal から採った **実際の形** を `test/mask.test.ts` に固定してある
（値はリポジトリのプレースホルダに置き換え）。

| 出所 | マスクするもの |
| --- | --- |
| `odelicd` 起動時 | `ID 12345678` → `ID 1234••••`（⭐ 下位 4 桁がパスワード） |
| 同 | `パスワード 35 36 37 38` |
| 同 | ⚠️⚠️ `LOGINKEY` / `EVENTKEY`（パスワードを 1 バイトおきに含む・C21） |
| 同 | `の鍵 = BD E1 AC C3`（リンクごとの XOR ホワイトニング鍵） |
| `odelic-matter` | 手入力コード / `MT:` の QR ペイロード / passcode |

⚠️ **行を捨てず、値だけを `••` にする**（`grep -v` で消すと原因を追えなくなる）。

### ⭐ 意図的に潰していないもの

- `アドバタイズ開始 … AD=…`（HOMEID を含むが、**電波に平文で乗っている** ので隠す意味がない）
- `discriminator` / VID / PID（公開情報）
- 器具の MAC（LAN 内の機器名と同程度。診断に要る）

---

## H8. 踏んだ罠

### ビルド・テスト

1. ⚠️ **`tsc` は削除されたソースの出力を消さない。** ファイルを移動したのに
   古い `dist` が残り、**移動前のコードでテストが通っていた**
2. ⚠️ **`declaration: true` が `*.test.d.ts` を吐き、Node がそれをテストとして実行する。**
   中身が空なので通り、テスト数が水増しされる
3. ⚠️ `common` の `clean` が `dist` を消すと matter のビルドが壊れる
4. ⭐⭐ NEW: `node --test` の並列実行で matter.js のストレージロックが競合した。
   `ServerNode` の id は `odelic-bridge` 固定なので、2 つのテストファイルが
   `ServerNode` を作ると 同じストレージを取り合って永久に止まる（4 分でタイムアウト）。
   ⚠️ `before()` で `MATTER_STORAGE_PATH` を設定しても遅い（matter.js は import 時に読む）。
   → `test/helpers/storage.ts` を `@matter` より前に import して分ける
5. ⭐ NEW: `file:../common` の解決先は配置場所で変わる。開発機では正しくても
   Pi では別の場所を指す。import が通ることを install.sh で実際に確かめる（→ H4）

### シェル

6. ⚠️ **`sudo` の前にシェルがグロブを展開する。**`sudo rm -rf /path/*` は
   呼び出し側の非 root シェルが 0700 を読めず、**何もせず成功したように見える**
7. ⚠️ `sh`（dash）は brace 展開に非対応
8. ⭐ NEW: Git Bash は `-subj "/CN=..."` の先頭 `/` を Windows パスに変換する。
   `openssl` が黙って失敗し、`&&` の連鎖が途中で切れる。`//CN=...` と書くか、
   `execFile`（シェルを経由しない）で渡す。⚠️ Pi 上では起きない

### 非同期

9. ⚠️ **競合は速いマシンで隠れる。** Pi 3 で初めて出たバグが 2 件あった
10. ⚠️ **「たまに落ちるテスト」を放置しない**
10b. ⚠️⚠️ NEW: `event.currentTarget` は `await` を跨ぐと `null` になる。
    DOM は dispatch が終わると `currentTarget` を戻すので、

    ```js
    onclick: async event => {
        event.currentTarget.disabled = true;   // ← ここは動く
        await api(...);
        event.currentTarget.disabled = false;  // ⚠️ TypeError（currentTarget は null）
    }
    ```

    処理は成功しているのにエラーだけ出る という一番たちの悪い壊れ方をする。
    `app.js` の `unhandledrejection` が拾って赤いトーストを出すので、
    「器具名を変えるとエラーが出る。でも名前は変わっている」に見えた。
    → ⭐ `await` より前にローカル変数へ掴む。`settings.js` の 4 か所で踏んだ。
    ⚠️ `event.target` は残るが、押した要素とは限らないので代用にしない

### Matter / Google Home

11. ⚠️⚠️ commissioning 直後にブリッジを再起動してはいけない（Nest ハブが器具を失う）
    → ⭐ **管理 API が 10 分間は再起動を 409 で断る** ようにした
12. ⚠️ エンドポイントは `server.start()` の前に揃える
13. ⚠️ `avahi-resolve -n` は既定で A レコードしか返さない（AAAA は `-6`）

### 設定ファイル

14. ⭐ NEW: コメント付き `config.json` をプログラムから書き戻すとコメントが消える。
    設定の意味を説明したコメントは一次情報なので失いたくない。
    → 設定ページからの変更は `/var/lib/odelic-matter/{fixtures,settings}.json` に置く

### 配備（実機で踏んだ）

15. ⭐⭐ NEW: root が 0600 で作ったファイルは、非 root のサービスから読めない。
    `install.sh` が `auth.json` を root 所有のまま置いてサービスを起動したので、
    プロセスからは「パスワード未設定」に見えて **インストールは成功したのに
    誰もログインできない** 状態になった。原因が分からない壊れ方。
    → 対処を 2 つ入れた。
    - `generate_password` が **書いた直後に `chown`** する（サービス起動より前）
    - ⭐ `Auth` が **「ファイルが無い」と「あるのに読めない」を言い分ける**
      （読めないときは理由を journald に出す）
16. ⚠️ **NEW: `application/octet-stream` で配った `/ca.crt` はスマホが証明書として
    扱わない。** ただのダウンロードになり、信頼させる導線に入れない。
    → `application/x-x509-ca-cert` にした（テストで固定）
17. ⚠️ NEW: `/opt` のサービスユーザーにはホームが無いので `npx` が使えない
    （`EACCES: mkdir '/home/odelic-web'`）。手で再ビルドせず `install.sh` を通す
18. ⚠️⚠️ **NEW: `sudo` は名前空間を抜けられない。**
    `odelic-web.service` の `ProtectSystem=strict` は、**sudo で root になった
    特権ヘルパーにも効く。** 設定ページから公開範囲を切り替えると

        mktemp: failed to create file via template
        '/etc/default/.odelicd.XXXXXX': Read-only file system

    ⚠️ **root なのに `EROFS`** なので原因が分かりにくい。ファイルシステム自体は
    正常で、`sudo touch` は SSH からなら通る。名前空間の中だけで読み取り専用。
    → `ReadWritePaths=` に書き込み先を列挙した。
    ⭐ **守っているのは名前空間ではなく DAC のほう**（`/etc/default` は
    root:root 0755、`/var/lib/*` は 0700 なので `odelic-web` からは書けない）。
    実機で `nsenter` + `setpriv` で両方を確かめた。
    - ⚠️ **同じ原因で 3 つ壊れていた。** 公開範囲の切り替え・ホーム ID の変更・
      **バックアップの復元**（バックアップの取得は読むだけなので動いていた）
    - ⚠️ 復元が書く `/etc/odelic-web`（ローカル CA の鍵）は `ReadOnlyPaths` に
      入れていたので外した

---

## H9. 環境

| | |
| --- | --- |
| Pi | `odelic-re-connected`（Tailscale / SSH 可）。aarch64 / Debian 13 / Node 20.19.2 |
| LAN IP | `172.16.0.16/16`（⚠️ DHCP。変わったら `gencert.sh --renew`） |
| ホスト名 | `odelic-re-connected.local`（avahi 稼働）← ⭐ 主たるアクセス名 |
| URL | ⭐ `https://odelic-re-connected.local:8443/` |
| Tailscale | `odelic-re-connected.turtle-eagle.ts.net`（`tailscale cert` で正規証明書も取れる） |
| メモリ | RAM 905 MB。実測 `odelicd` 37 + ブリッジ 133 + ⭐ Web 77 = 247 MB（空き 423 MB） |
| ディスク | `/` が 92% 使用・空き 572 MB。⭐ Web は実行時依存ゼロなので増えていない |
| 器具 | 2 台（`EC:C5:7F:81:DE:CD` / `EC:C5:7F:80:28:A6`）。どちらも `0x2B` |

⚠️ `odelicd` を localhost に絞る話は **保留中**（ユーザーの判断待ち）。
今は `0.0.0.0:8080` で無認証。⭐ **設定ページはこれと独立に認証を持っている** ので、
絞っても設定ページは動く。

---

## H10. 残っている宿題

- [ ] ⭐ **スマホでの CA 信頼の手順を実際に通す**（⚠️ iOS の「証明書信頼設定」を忘れやすい）。
      ここだけは人の端末が要るので未検証
- [ ] ⭐ Google Home から操作して退行がないことを確認する
      （エンドポイント番号と `uniqueId` は不変なので理屈上は問題ないが、目視していない）
- [ ] `odelicd` を `127.0.0.1` に絞るか（絞ると開発機からの `curl` が SSH 経由になる）。
      ⭐ 設定ページは独立に認証を持つので、絞っても動く
- [x] `MemoryMax=192M` が妥当か → ✅ 実測 77 MB。余裕あり
- [ ] 中間色温度が K 線形か mired 線形か（→ [07 M10b](../07-matter.md)。今回も触っていない）
- [ ] `Matter` 画面の「追加フェアリング」を実際に使う（Apple Home / Alexa を足すとき）
