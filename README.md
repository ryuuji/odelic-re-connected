# odelic-re-connected

**ODELIC「CONNECTED LIGHTING for HOME」対応照明器具を、Raspberry Pi から操作する。**
Google Home / Apple Home / Alexa から音声で、スマートフォンからブラウザで。

純正アプリも Pairlink SDK もベンダーのバイナリも使わない。**BLE メッシュの通信
プロトコルを解析して自前で実装した。**その解析結果もすべて公開している。

```bash
sudo ./install.sh 12345678      # 純正アプリのメニュー画面に出ている 8 桁 ID
```

---

## できること

| | |
| --- | --- |
| 🎙 **音声で操作** | 「つけて」「15% にして」「電球色にして」— Matter デバイスとして公開するので Google Home / Apple Home / Alexa から使える |
| 📱 **スマホから操作** | ブラウザで開くだけ（アプリ不要）。HTTPS + パスワード |
| ⚡ **待たされない** | 純正アプリは起動から操作可能まで約 7 秒。こちらは**常時接続を維持していて 0 秒**、1 操作 **5〜8 ミリ秒** |
| ✅ **効いたことを確認する** | 器具に状態を問い合わせて、**実際にその状態になるまで再送**する。「送ったから成功」とは言わない |
| 🌙 **常夜灯も操作・状態取得** | ⭐ 純正アプリは常夜灯の状態バイトを読んでいない。こちらは読んで反映する |
| 🤝 **純正アプリと共存する** | 同時に使える。純正アプリでの操作も**観測して状態に反映**する |
| 🔌 **HTTP API** | `curl -X POST http://<pi>:8080/on` だけで動く。自動化に組み込める |

<!-- ⚠️ スクリーンショット未撮影。撮影リストは docs/images/README.md -->

---

## 動かすまで

### 必要なもの

| | |
| --- | --- |
| Raspberry Pi | **Pi 3 以降**（BLE 内蔵）。Pi 3 の RAM 905 MB で 3 プロセスが共存する |
| OS | Raspberry Pi OS（Debian 13 で確認）。Node.js 20 以降が apt から入ること |
| 設置場所 | ⚠️ **照明器具の BLE が届くところ。**メッシュなので 1 台に届けば全体に流れる |
| 8 桁 ID | 純正アプリのメニュー画面に `ID:12345678` と表示されている番号 |
| 器具の登録 | ⭐ **純正アプリで済ませておく。**このプロジェクトは登録済みのメッシュに参加するだけ |

### ⭐ 8 桁 ID の調べ方

**純正アプリ（`jp.co.odelic.smt.remote10`）のメニュー画面に `ID:12345678` と
表示されている 8 桁の番号**がそれ。上位 4 桁が HOMEID、下位 4 桁がメッシュの
パスワードになっている（→ [02 C16](docs/02-protocol.md)）。

⚠️ **入力ミスはすぐ判る。**器具が送ってくるログイン要求を復号して HOMEID が
一致するか確認しているので、間違っていれば参加できない。

### インストール

```bash
git clone https://github.com/caliljp/odelic-re-connected.git
cd odelic-re-connected
sudo ./install.sh 12345678              # ← 自分の 8 桁 ID に置き換える
```

これで 3 つの systemd サービスが入って自動起動する。所要 5〜10 分（`npm` が遅い）。

```bash
sudo ./install.sh 12345678 --skip-matter    # Matter は要らない
sudo ./install.sh 12345678 --skip-web       # 設定ページは要らない
sudo ./install.sh 12345678 --with-backup    # ⭐ 毎日 03:30 に状態をバックアップ
```

⚠️ **`--with-backup` を勧める。**Matter の fabric 鍵とローカル CA の秘密鍵を失うと、
**全端末で登録をやり直す**ことになる。

→ 詳しい手順・Pi のセットアップから: [docs/06-raspberrypi-setup.md](docs/06-raspberrypi-setup.md)

### 動作確認

```bash
curl -X POST http://localhost:8080/on
curl -X POST http://localhost:8080/off
curl -X POST 'http://localhost:8080/level?bright=60&color=50&wait=1'
#   → HTTP 200  0.32s  detail=converged   ★ 器具が実際にその状態になったことを確認済み
curl http://localhost:8080/devices        # 器具ごとの現在状態
curl http://localhost:8080/metrics        # RTT 分布・到達率・リンク寿命
```

⚠️ 器具は広告開始から**約 5 秒**で接続してくる。直後に `503` が返るときは少し待つ。

---

## 3 つの成果物

```
install.sh          ← 一括インストーラ（下の 3 つを正しい順で入れる）
odelicd/            ← ① ローカル API（Python・BLE を握る唯一のプロセス）
common/             ← 共有パッケージ @odelic/common（プロトコル由来の事実）
matter/             ← ② Matter ブリッジ（Node.js + matter.js）
web/                ← ③ 設定ページとスマホ UI（Node.js・HTTPS）
docs/               ← プロトコル文書と解析の記録
```

| | 中身 | 文書 |
| --- | --- | --- |
| ⭐ [`odelicd/`](odelicd/) | **BLE で照明を操作する常駐デーモン。**GATT サーバとして器具の接続を待ち、メッシュにコマンドを流す。HTTP API を提供する。⚠️ **BLE アダプタを握るのはこのプロセスだけ** | [06](docs/06-raspberrypi-setup.md) |
| ⭐ [`matter/`](matter/) | **Matter ブリッジ。**照明を標準の Matter デバイスとして公開する。⭐ BLE は使わず `odelicd` の HTTP API だけを叩くので、アダプタの競合が起きない | [07](docs/07-matter.md) |
| ⭐ [`web/`](web/) | **設定ページとスマホ UI。**HTTPS（ローカル CA + 自己署名）+ パスワード認証。照明の操作・器具名・Matter の状態・ログ閲覧・ホーム ID の変更 | [08](docs/08-web-ui.md) |
| [`common/`](common/) | matter と web が共有する「プロトコル由来の事実」（明るさの段・器具の能力判定・MAC の正規化・JSONC） | [10](docs/10-development.md) |
| [`backup.sh`](backup.sh) | ⚠️ 失うと復旧が重いもの（Matter の fabric 鍵・器具の名簿・CA の秘密鍵・設定）だけを取る | [07 M10c](docs/07-matter.md) |

⚠️ **順序に意味がある**（`odelicd` → `matter` → `web`）。
`file:../common` の参照も含めて、[docs/10-development.md](docs/10-development.md) に罠がまとまっている。

---

## 実測

`btmon` の HCI トレースと内蔵計測（`GET /metrics`）で測った値。

| | 純正アプリ | **これ** |
| --- | --- | --- |
| 起動〜操作可能 | 約 7 秒 | **0 秒**（常時接続維持） |
| 1 操作の所要時間 | 不明・確認なし | **5〜8 ミリ秒** |
| 効いたことの確認 | しない | **`?wait=1` で 277〜320 ms**（収束を確認して 200 / 未確認なら 504） |
| 取りこぼし対策 | 送信 1 回のみ | **1 通送って状態応答で確認し、届くまで再送**（到達率 0.993〜1.000） |
| リンクの維持 | — | 寿命 p50 **152 秒**（実装改善前は 7〜14 秒で切り合っていた） |
| 状態要求の往復 | — | p50 **50〜78 ms** / p90 60〜92 ms / max 77〜117 ms |
| 未接続のとき | 「接続成功」と表示する | **HTTP 503 + キューに保持**（接続した瞬間に流す） |
| メモリ（Pi 3） | — | `odelicd` 37.8 MB + ブリッジ 125 MB + 設定ページ |

⚠️ **不安定さの主犯は「こちら側の実装」だった。**3 つの前提が実測で覆った。

| 判明したこと | 内容 |
| --- | --- |
| ⭐ **広告を出し続けると自壊する** | 新しいリンクが確立すると器具が古いリンクを 0.7〜1.4 秒後に切る（完全な交互）。メッシュは**コントローラ 1 台につきリンク 1 本**しか許さない。3 分で 22 回も参加し直していた → 参加後は接続の受け付けを止める |
| ⭐ **BlueZ が接続を遅くしていた** | 器具は 15.00 / 28.75 ms を指定してくるのに、Linux が Connection Parameter Update Request を **65 本**送って **45 ms に書き換えていた** → `conn_min_interval` を下げて解決 |
| ⭐ **3 連射は無駄だった** | 送信 1 通あたりの到達率は **0.993〜1.000**。「同じ PDU が二重に届く」現象も**自分の 3 連射が原因**だった |

→ 詳細と測り方: [docs/02-protocol.md](docs/02-protocol.md) の C33

---

## ドキュメント

⭐ **このプロジェクトのもう一つの成果物は
[通信プロトコルの文書](docs/02-protocol.md)（2900 行）。**
PDU 形式・照明コマンドの全バイト・認証・暗号（送受信とも）・状態応答・
通信戦略の実測まで、自前実装できる粒度で書いてある。

| | |
| --- | --- |
| [docs/README.md](docs/README.md) | ⭐ **索引。**目的から引く |
| [docs/02-protocol.md](docs/02-protocol.md) | 通信プロトコルの全容 |
| [docs/06-raspberrypi-setup.md](docs/06-raspberrypi-setup.md) | Pi のセットアップと `odelicd` の運用 |
| [docs/07-matter.md](docs/07-matter.md) | Matter 対応 |
| [docs/08-web-ui.md](docs/08-web-ui.md) | 設定ページとスマホ UI |
| [docs/10-development.md](docs/10-development.md) | ⚠️ ビルド順序・テストの罠・配備 |
| [docs/analysis/](docs/analysis/) | 解析の記録（手順・失敗・打ち切った検討） |

⭐ [docs/analysis/history.md](docs/analysis/history.md) には
**5 回自信を持って間違えた記録**がある。同じ製品を解析する人には
確定事項よりこちらが役に立つかもしれない。

### テスト

```bash
(cd common && npm install && npm run build && npm test)   #  48 件
(cd matter && npm install && npm test)                    # 114 件
(cd web    && npm install && npm test)                    # 132 件
```

⭐ **BLE も Pi も要らない。**開発機で完結する（偽 `odelicd` を立てて検証する）。
⚠️ `common` を**先にビルドする**必要がある。→ [docs/10-development.md](docs/10-development.md)

---

## ⚠️ 意図的に対応しないこと

**壊すと壁スイッチからのやり直しになる操作は、解析できていても実装しない。**
純正アプリに任せる。

| 機能 | 理由 |
| --- | --- |
| **器具の登録・プロビジョニング**（ECDH / `SET_MESH_ENCRY`） | 破壊的。純正アプリに任せる |
| **グループ設定の変更**（`0x30` / `0x31`） | 同上。**読み取りのみ**行う |
| **HOMEID の発行・変更** | 破壊的（器具のローカルデータ削除 + メッシュ退出を伴う） |
| タイマー / スケジュール | 中心機能に絞るため |
| シーン（`0x40`〜`0x42`）/ センサー連携 | 同上 |

⚠️ **これらの送信コマンドは実装に入れていない**（誤送信の余地を残さない）。
プロトコル上の手がかりは [02 C7 / C15-5 / C15-10](docs/02-protocol.md) に残してある。

⭐ 一方で **読み取りは全部できる。**器具一覧・vAddr・**グループ所属**・機種・
ファームウェア・現在状態は、参加すれば自動で判る。
引き継げないのは**器具の表示名と配置だけ**（純正アプリのローカル DB にしかない）。

---

## ⚠️ 秘密情報の扱い

**8 桁 ID の下位 4 桁はメッシュのパスワード。**知られると
**近隣の誰でもその照明を操作できる。**

- リポジトリに出てくる `12345678`（HOMEID `1234` / パスワード `5678`）は
  **すべてプレースホルダ。**実値は 1 箇所も書かれていない
- 実値は `install.sh` の引数で渡し、**`/etc/default/odelicd`（0600 root）**に保存される
- 解析ツールに渡すときは環境変数で:
  ```bash
  export ODELIC_ID=<実際の 8 桁 ID>       # docs/analysis/tools/decrypt_recv.py など
  export ODELIC_HOMEID=<HOMEID の 10 進>  # adv_raw.sh
  ```
- ⚠️ **`backup.sh` の出力にはメッシュのパスワード・Matter の秘密鍵・
  ローカル CA の秘密鍵が入る**（0600 root）。**そのまま他人に渡さない**
- ⭐ **設定ページのログ画面は、パスワード・LOGINKEY / EVENTKEY・
  Matter の登録コードを表示前に伏せる**（`web/src/mask.ts`。⚠️ 行ごと捨てず値だけ潰す）
- ⚠️ HCI ログ（`*.btsnoop` / `*.log`）と APK・逆コンパイル成果物は
  **リポジトリに含めない**（`.gitignore` 済み。置き場は Git 管理外の `artifacts/`）

---

## ライセンスと法的な位置づけ

[MIT License](LICENSE)。

自身が所有する照明器具を相互運用（interoperability）するための解析であり、
**プロトコル知識をもとにした独自実装**。純正アプリのコードやアセットは
一切含まず、再配布もしない。

⚠️ ODELIC / Pairlink とは無関係の非公式プロジェクト。**自己責任で使うこと。**
器具の登録情報を壊しうる操作は意図的に実装していないが、
無保証であることは MIT の条文どおり。
