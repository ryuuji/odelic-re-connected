# `tools/pi/` — Raspberry Pi 上で動くもの

照明のそばに常設した Raspberry Pi 3（`odelic-re-connected`）で動く 3 つ。

| ディレクトリ | 中身 | 状態 |
| --- | --- | --- |
| （直下の `.py` / `.sh`） | ⭐ **`odelicd`** — BLE で照明を制御する常駐デーモン（Python） | ✅ 運用中 |
| [`common/`](common/) | ⭐ **`@odelic/common`** — matter と web が共有する「プロトコル由来の事実」 | ✅ 完成 |
| [`matter/`](matter/) | ⭐ **`odelic-matter`** — Matter ブリッジ（Google Home 等から操作） | ✅ 運用中 |
| [`web/`](web/) | ⭐ **`odelic-web`** — 設定ページとスマホ UI（HTTPS + パスワード） | ✅ 完成 |

---

## ⚠️ ビルドの順序（ここを間違えると詰まる）

`matter` と `web` は `@odelic/common` を **`file:../common`** で参照する。
npm はこれをシンボリックリンクにするので、**`common` の `dist` が無いとビルドできない。**

```bash
# ⭐ 必ず common を先にビルドする
cd tools/pi/common && npm install && npm run build

cd ../matter && npm install && npm test
cd ../web    && npm install && npm test
```

⚠️ **`common` の `clean` は `dist` を消さない**（`dist-test` だけ）。
`dist` は matter / web が参照する成果物なので、消すと
`Cannot find module '@odelic/common'` でビルドが止まる。
全部消したいときだけ `npm run clean:all`（そのあと `npm run build` が必要）。

### ⚠️⚠️ Pi 上での `file:../common` は `/opt/common` を指す（実際に壊れていた）

配置先は `/opt/odelic-matter` と `/opt/odelic-web` なので、`file:../common` は
**`/opt/common`** を探しに行く。ここを用意しないと
`Cannot find module '@odelic/common'` で起動しない。

**実際に一度壊れていた。**`/opt/odelic-matter/node_modules/@odelic` が存在しないまま、
共有パッケージに切り出す前の古い `dist` が残っていたので動いていただけだった。

→ ⭐ [`common/install.sh`](common/README.md) が
**`/opt/odelic-common` に配置し、`/opt/common` をそこへのシンボリックリンクにする。**
`matter/install.sh` と `web/install.sh` が最初にこれを呼ぶ。

```bash
# 各サービスの install.sh は依存を入れた直後にこれを確かめる
node -e "import('@odelic/common').then(m => console.log(m.ladder(true).length))"
```

⭐ パスを書き換える方式（`file:/opt/odelic-common` に直す）にはしていない。
書き換えると `package-lock.json` が使えなくなり `npm ci` が `npm install` に落ちて、
**matter.js のバージョンが勝手に上がりかねない**ため。

---

## ⚠️ テスト数が嘘になる 2 つの罠（実際に踏んだ）

**テストが通っているのに実は嘘**という状態を 2 回作ったので記録しておく。
テスト数が想定と違うときは、まずこの 2 つを疑う。

### 1. `tsc` は削除されたソースの出力を消さない

`capability.test.ts` を `matter` から `common` へ移したのに、
`matter/dist/test/capability.test.js` が残って**移動前のコードでテストが通っていた**
（114 のまま。実数は 95）。

→ 各パッケージの `test` は**必ず先に出力を消す**ようにしてある。

### 2. `declaration: true` が `*.test.d.ts` を吐き、それがテストとして実行される

中身が空なので通ってしまい、テスト数が水増しされる。
ローカル 38 / Pi 36 という食い違いの正体がこれだった（実数は 36）。

→ `common` は**配布用**（`tsconfig.json`・`src` のみ・`declaration` あり）と
**テスト用**（`tsconfig.test.json`・`declaration` なし・`dist-test` へ出力）に分離した。

---

## テストの実行

```bash
cd tools/pi/common && npm test    # 48 件（器具の能力・明るさの段・MAC・JSONC）
cd tools/pi/matter && npm test    # 114 件（変換・設定・名簿・ブリッジ統合・管理 API）
cd tools/pi/web    && npm test    # 123 件（認証・マスク・ルーティング・TLS 判別）
```

⭐ **どれも BLE も Pi も使わない。**開発機で実行できる。

⚠️ `web` の TLS のテストは `openssl` で一時証明書を作る。無い環境では
その 5 件だけ自動的に飛ばす（鍵をリポジトリに置かないため）。

### ⚠️ matter のテストは 2 つの理由で並列に走らせない

`bridge.test.ts` と `admin.test.ts` はどちらも**本物の `ServerNode`** を起動する。
`node --test` は既定でファイルごとに別プロセスで並列に走らせるので、2 つ動く。

**1. ストレージのロックを取り合って永久に止まる。**`ServerNode` の id は
`odelic-bridge` 固定なので同じ場所を使う（4 分でタイムアウトした）。

→ `test/helpers/storage.ts` を **`@matter` より前に import** して
ファイルごとに `MATTER_STORAGE_PATH` を分ける。
⚠️ `before()` で環境変数を設定しても遅い（matter.js は **import 時**に読む）。

**2. ⭐ 時間に依存するテストが落ちる。**ServerNode 2 つ + mDNS + 偽 odelicd 2 つが
同時に動くとタイマーが遅れ、「取りこぼしの追い打ち」（`FAST_PROBE_GAP_MS = 900`）の
検証が窓に入らない。単独では 3 回中 3 回通るのに、並列だと落ちた。

→ `--test-concurrency=1` で**直列**にした。⚠️ Pi 3 はもっと遅いので、
`install.sh` が Pi 上で走らせることを考えると直列が正しい。

⚠️ ただし**非同期の競合は速いマシンでは隠れる**。Pi 3 で初めて出たバグが 2 件あるので、
重要な変更のあとは実機でも走らせる（`matter/install.sh` は Pi 上で `npm test` を実行する）。

---

## 実機への配備

| 対象 | 手順 |
| --- | --- |
| `odelicd` | `sudo ./install.sh <8桁ID> 8080` |
| `@odelic/common` | `sudo ./common/install.sh`（⭐ 下の 2 つが自動で呼ぶ） |
| `odelic-matter` | `sudo ./matter/install.sh http://127.0.0.1:8080` |
| `odelic-web` | `sudo ./web/install.sh` → ⭐ **初期パスワードが 1 回だけ表示される** |
| パスワードの作り直し | `sudo /opt/odelic-web/reset-password.sh`（⚠️ 全端末ログアウト） |
| バックアップ | `sudo ./backup.sh --install`（毎日 03:30） |

⚠️ 順序は **`odelicd` → `matter` → `web`**。`web` は起動時に両方を見に行くが、
落ちていても起動はする（照明の操作は `odelicd` さえ生きていればできる）。

⚠️ **`odelic-matter` は commissioning の直後に再起動してはいけない**
（Nest ハブが配下の器具を失う既知バグを踏む。→ [docs/07 M6-6](../../docs/07-matter.md)）。
落ち着いてからの再起動は問題なく復帰する。

### 反復開発のとき

`install.sh` は `npm prune --omit=dev` で `typescript` を消すので、Pi 上で再ビルドできない。
開発機でビルドして `dist` ごと送るのが速い。

```bash
cd tools/pi/matter && npm run build
tar czf - src dist | ssh odelic-re-connected \
  "sudo tar xzf - -C /opt/odelic-matter && sudo chown -R odelic-matter:odelic-matter /opt/odelic-matter && sudo systemctl restart odelic-matter"
```

---

## ⚠️ 秘密情報の扱い

- リポジトリの 8 桁 ID は**プレースホルダ**（`12345678`）。実値は書かない
- 実値は環境変数で渡す: `ODELIC_ID` / `ODELIC_HOMEID`
- `odelicd` の実値は `/etc/default/odelicd`（0600 root）にある
- ⚠️ **バックアップの tar にはメッシュのパスワード・Matter の秘密鍵・
  ローカル CA の秘密鍵が入る**（0600 root）
- ホーム ID（8 桁）は設定ページに**そのまま表示する**。同じ番号が公式アプリの
  メニュー画面にも出ているので伏せても守れるものが無い（→ [docs/08 W10-4](../../docs/08-web-ui.md)）。
  ⭐ 変更と巻き戻しは `set-id.sh`（sudoers で許可した唯一のスクリプト）に任せる
- ⚠️ ただし**ログでは伏せたまま**（`web/src/mask.ts`）。ログは第三者に見せることがある
- ⭐ **ログ画面はメッシュのパスワード・LOGINKEY / EVENTKEY・Matter の登録コードを
  表示前に伏せる**（`web/src/mask.ts`。⚠️ 行ごと捨てずに値だけ潰す）
