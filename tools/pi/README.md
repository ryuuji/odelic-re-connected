# `tools/pi/` — Raspberry Pi 上で動くもの

照明のそばに常設した Raspberry Pi 3（`odelic-re-connected`）で動く 3 つ。

| ディレクトリ | 中身 | 状態 |
| --- | --- | --- |
| （直下の `.py` / `.sh`） | ⭐ **`odelicd`** — BLE で照明を制御する常駐デーモン（Python） | ✅ 運用中 |
| [`common/`](common/) | ⭐ **`@odelic/common`** — matter と web が共有する「プロトコル由来の事実」 | ✅ 完成 |
| [`matter/`](matter/) | ⭐ **`odelic-matter`** — Matter ブリッジ（Google Home 等から操作） | ✅ 運用中 |
| [`web/`](web/) | **`odelic-web`** — 設定ページとスマホ UI | 🚧 **作りかけ**（→ [docs/09](../../docs/09-handoff-web-ui.md)） |

---

## ⚠️ ビルドの順序（ここを間違えると詰まる）

`matter` と `web` は `@odelic/common` を **`file:../common`** で参照する。
npm はこれをシンボリックリンクにするので、**`common` の `dist` が無いとビルドできない。**

```bash
# ⭐ 必ず common を先にビルドする
cd tools/pi/common && npm install && npm run build

cd ../matter && npm install && npm test
```

⚠️ **`common` の `clean` は `dist` を消さない**（`dist-test` だけ）。
`dist` は matter / web が参照する成果物なので、消すと
`Cannot find module '@odelic/common'` でビルドが止まる。
全部消したいときだけ `npm run clean:all`（そのあと `npm run build` が必要）。

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
cd tools/pi/common && npm test    # 36 件（器具の能力・明るさの段）
cd tools/pi/matter && npm test    # 95 件（変換・設定・名簿・偽 odelicd を立てた統合）
```

⭐ **どちらも BLE も Pi も使わない。**開発機で実行できる。

⚠️ ただし**非同期の競合は速いマシンでは隠れる**。Pi 3 で初めて出たバグが 2 件あるので、
重要な変更のあとは実機でも走らせる（`matter/install.sh` は Pi 上で `npm test` を実行する）。

---

## 実機への配備

| 対象 | 手順 |
| --- | --- |
| `odelicd` | `sudo ./install.sh <8桁ID> 8080` |
| `odelic-matter` | `sudo ./matter/install.sh http://127.0.0.1:8080` |
| バックアップ | `sudo ./backup.sh --install`（毎日 03:30） |

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
- ⚠️ **バックアップの tar にはメッシュのパスワードと Matter の秘密鍵が入る**（0600 root）
