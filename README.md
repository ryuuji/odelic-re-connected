# odelic-re-connected

ODELIC「CONNECTED LIGHTING for HOME」対応照明器具を、BLE 経由で制御する Android アプリの再開発プロジェクト。

純正アプリ（`jp.co.odelic.smt.remote10`）は Google Play で **★1.2（1つ星 174 件）** という評価で、
接続の不安定さ・起動の遅さ・設定保存の失敗が繰り返し報告されている。
本プロジェクトはその原因を解析で特定し、高速・安定に動作する代替アプリを作る。

## 目的

1. 純正アプリを解析し、BLE 通信プロトコルを解明する
2. 接続が不安定になる原因を技術的に特定する
3. 起動即操作・低レイテンシで動く Android アプリを実装する

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [PLAN.md](PLAN.md) | 全体ゴールとフェーズ |
| [docs/01-findings.md](docs/01-findings.md) | 製品・純正アプリの調査結果（出典付きの事実整理） |
| [docs/02-protocol.md](docs/02-protocol.md) | 通信プロトコル：仮説と確定事項 |
| [docs/03-instability.md](docs/03-instability.md) | 接続不安定の原因仮説と検証方法 |
| [docs/04-analysis-procedure.md](docs/04-analysis-procedure.md) | 解析手順書（環境構築・静的解析・動的解析） |
| [docs/05-app-design.md](docs/05-app-design.md) | 新アプリの設計方針 |
| [docs/06-raspberrypi-setup.md](docs/06-raspberrypi-setup.md) | Raspberry Pi による検証環境（照明のそばに常設） |
| [docs/07-matter.md](docs/07-matter.md) | ⭐ **Matter 対応**（Google Home / Apple Home / Alexa から操作する） |

ドキュメントは**事実（出典あり）／推測（仮説）／検証済み**を明示して書く。
新しい情報が出たら該当ファイルに追記していく。

## ツール

| ファイル | 内容 |
| --- | --- |
| [tools/pi/odelicd.py](tools/pi/odelicd.py) | ⭐ **常駐デーモン本体**（HTTP API で照明を制御） |
| [tools/pi/matter/](tools/pi/matter/) | ⭐ **Matter ブリッジ**（Node.js + matter.js）。照明を Matter デバイスとして公開する。BLE は使わない |
| [tools/pi/odelicd.service](tools/pi/odelicd.service) | systemd ユニット |
| [tools/pi/install.sh](tools/pi/install.sh) | インストーラ（`sudo ./install.sh 12345678 8080`） |
| [tools/pi/mesh_peripheral.py](tools/pi/mesh_peripheral.py) | 検証用の単発実行版（`--send blink` など） |
| [tools/pi/run-p2.sh](tools/pi/run-p2.sh) | 上記を `btmon` 記録付きで実行するラッパー |
| [tools/pi/adv_raw.sh](tools/pi/adv_raw.sh) | raw HCI で `ADV_PHONE` を送る（BlueZ D-Bus の代替） |
| [tools/pi/gattdump.py](tools/pi/gattdump.py) | 接続中の器具の GATT を列挙して読む（→ C27） |
| [tools/pi/capture-scan.sh](tools/pi/capture-scan.sh) | Pi でのスキャンキャプチャ |
| [tools/btsnoop.py](tools/btsnoop.py) | HCI ログのパーサ。Android btsnoop と `btmon` 形式の両対応。⭐ `conn` でリンクと接続パラメータ・切断理由、`latency` で送信レイテンシ分布（C33） |
| [tools/decrypt_recv.py](tools/decrypt_recv.py) | ⭐ **HCI ログのメッシュ PDU を復号して読む**（受信の暗号を解いた・C23） |
| [tools/disasm.py](tools/disasm.py) | `libnative-lib.so` の逆アセンブル（関数名で指定・呼び出し先を名前解決） |
| [tools/fw_analyze.py](tools/fw_analyze.py) | 器具ファームウェア（APK 同梱 OTA イメージ）の解析（→ C25） |
| [tools/collect_logs.ps1](tools/collect_logs.ps1) | Android からのログ回収（`prepare` / `collect`） |
| [tools/synth_btsnoop.py](tools/synth_btsnoop.py) | パーサ検証用の合成ログ生成 |

```bash
# 実運用（常駐サービス）
curl -X POST http://odelic-re-connected:8080/on
curl -X POST http://odelic-re-connected:8080/off
curl -X POST 'http://odelic-re-connected:8080/level?bright=60&color=50'
curl -X POST 'http://odelic-re-connected:8080/night?level=0'   # ナイトライト（0/1/2）
curl http://odelic-re-connected:8080/status                     # 状態を要求
curl http://odelic-re-connected:8080/devices                    # 器具ごとの現在状態

# 検証用（単発実行 + HCI 記録）
ssh odelic-re-connected '/tmp/run.sh 60 --send blink --repeat'
```

```powershell
# 照明のそばへ行く前 → 操作 → 戻ってきたら
pwsh tools/collect_logs.ps1 prepare
pwsh tools/collect_logs.ps1 collect

# 解析
python tools/btsnoop.py summary  artifacts/btsnoop_hci-<stamp>.log
python tools/btsnoop.py timeline artifacts/btsnoop_hci-<stamp>.log

# 暗号化された PDU まで復号して読む（第 2 引数はアプリ表示の 8 桁 ID）
python tools/decrypt_recv.py artifacts/btsnoop_hci-<stamp>.log 12345678

# ⭐ リンク 1 本 1 行の表（接続パラメータ・CPUR・切断理由・寿命分布）
python tools/btsnoop.py conn    artifacts/pi-conn-<stamp>.btsnoop
# ⭐ ACL 送信 → 完了通知のレイテンシ（Connection Interval 別）
python tools/btsnoop.py latency artifacts/pi-conn-<stamp>.btsnoop
```

`summary` は ADV 種別・**HOMEID を 10 進数で**・器具の MAC を自動判定して表示します。

## 現在の状況

**⭐⭐⭐ Raspberry Pi 版が実用化完了（2026-07-25）。**

純正アプリも `libnative-lib.so` も Pairlink SDK も使わず、
プロトコル解析だけで照明を制御できるようになった。

```bash
curl -X POST http://odelic-re-connected:8080/off   # HTTP 200  5.2ms
curl -X POST http://odelic-re-connected:8080/on    # HTTP 200  5.5ms
```

**⭐⭐⭐ さらに状態取得も実現（同日）。**
受信の暗号を解き、器具の MAC・vAddr・グループ・ファーム・**現在状態**が読める。

```bash
curl -X POST 'http://odelic-re-connected:8080/level?bright=60&color=50'
curl http://odelic-re-connected:8080/devices
#   → on=true bright=60 color=50   ★ 指示値と一致（閉ループ）
```

鍵は器具が接続直後に平文で渡してきていた（`PERIPHERAL_LOGIN` の中身）。
→ [C23](docs/02-protocol.md)

**⭐⭐⭐ 通信戦略を実測で最適化（同日）→ [C33](docs/02-protocol.md)**

`btmon` の HCI トレースと内蔵計測（`GET /metrics`）で測ったら、
**不安定さの主犯はこちら側の実装だった**ことが判った。3 つの前提が覆った。

| 判明したこと | 内容 |
| --- | --- |
| ⭐ **広告を出し続けると自壊する** | 新しいリンクが確立すると器具が古いリンクを 0.7〜1.4 秒後に切る（完全な交互）。メッシュは**コントローラ 1 台につきリンク 1 本**しか許さない。3 分で 22 回も参加し直していた → 参加後は接続受け付けを止める |
| ⭐ **BlueZ が接続を遅くしていた** | 器具は 15.00 / 28.75 ms を指定してくるのに、Linux が Connection Parameter Update Request を **65/65 本**送って **45 ms に書き換えていた** → `conn_min_interval` を下げて解決 |
| ⭐ **3 連射は無駄だった** | 送信 1 通あたりの到達率は **0.993〜1.000**。「同じ PDU が二重に届く」現象も**自分の 3 連射が原因**だった |

```bash
curl -X POST 'http://odelic-re-connected:8080/level?bright=70&color=50&wait=1'
#   → HTTP 200  0.32s  detail=converged   ★ 器具が実際にその状態になったことを確認済み
curl http://odelic-re-connected:8080/metrics     # RTT 分布・到達率・リンク寿命・収束時間
```

| | 純正アプリ | **odelicd** |
| --- | --- | --- |
| 起動〜操作可能 | 約 7 秒 | **0 秒**（常時接続維持） |
| 1 操作の所要時間 | 不明・確認なし | **5〜8 ミリ秒** |
| 取りこぼし対策 | 送信 1 回のみ・確認なし | **1 通送って状態応答で確認し、届くまで再送** |
| 効いたことの確認 | しない | **`?wait=1` で 277〜320 ms**（収束を確認して 200 / 未確認なら 504） |
| リンクの維持 | — | 寿命 p50 **152 秒**（旧実装は 7〜14 秒で切り合っていた） |
| 状態要求の往復 | — | p50 **50〜78 ms** / p90 60〜92 ms / max 77〜117 ms |
| 未接続時 | 「接続成功」と表示する | **HTTP 503 + キューに保持** |

systemd で常駐（自動起動有効）。→ [docs/06-raspberrypi-setup.md](docs/06-raspberrypi-setup.md)

**⭐⭐ Matter ブリッジを実装（2026-07-26）→ [docs/07-matter.md](docs/07-matter.md)**

照明を標準の Matter デバイスとして公開し、Google Home / Apple Home / Alexa から
操作できるようにした。Pi に常駐して稼働中。

```
＋ Matter に追加: ダイニングの照明 (EC:C5:7F:81:DE:CD) colorTemperature / 常夜灯あり
＋ Matter に追加: リビングの照明 (EC:C5:7F:80:28:A6) colorTemperature / 常夜灯あり
```

| | |
| --- | --- |
| ⭐ **BLE アダプタの競合** | **起きない。**matter.js は BLE が任意で、参加はオンネットワーク commissioning（mDNS / IPv6）。Pi の唯一の BLE アダプタは `odelicd` が握ったまま |
| ⭐ **`odelicd` への変更** | **なし。**既存の HTTP API だけを使う別プロセス |
| ⭐ **常夜灯の表現** | **明るさ 1 軸の下端に載せた。**Matter に常夜灯クラスタは無いが、常夜灯は主灯より暗く両者は排他（C24-5）なので、1 本のスライダーに畳める。純正アプリも天井灯でない器具には明るさコード 17〜19 で代用しており、考え方が一致する |
| 退行 | **なし。**到達率 1.000 / リンク寿命 5311 秒・切断 0 / RTT p50 57 ms |
| メモリ | `odelicd` 37.8 MB + ブリッジ 125 MB（Pi 3 の RAM 905 MB で共存） |

✅ **色温度を確定**（2026-07-26）。製品スペックの調色範囲は **電球色 2700K 〜 昼光色 6500K**、
実機の目視で `color=0%` = 電球色。`target=all` の 1 通で **347 ms で収束確認**
（`?wait=1` が HTTP 200）。**設定に仮定は残っていない。**

✅ **Google Home から操作できるようになった**（2026-07-26）。
Developer Console にテスト VID/PID を登録し、オンネットワーク commissioning で参加。
「つけて」「15% にして」「電球色にして」が実機で動作。

⚠️ **commissioning 直後にブリッジを再起動してはいけない**（Nest ハブが配下の器具を失う
既知バグを踏む）。一度これで失敗し、ストレージを消して再登録した。→ [07 M9](docs/07-matter.md)

| 項目 | 状況 |
| --- | --- |
| 解析ツール | ✅ adb 37.0.1 / jadx 1.5.6 / 自作 btsnoop パーサ |
| 対象照明器具 | ✅ 実物あり |
| Android 実機 | ✅ Pixel 9 / Android 17 |
| 解析対象 APK | ✅ v1.9.36 (vc133) 取得・逆コンパイル済み |
| プロトコル | ✅ **解明済み**（Pairlink SDK が難読化なしで同梱されていた） |
| 実機 HCI ログ | ✅ 採取・検証済み（→ [C18](docs/02-protocol.md)） |
| Raspberry Pi 3 | ✅ 常設・**自前実装で照明制御に成功**（→ [C19](docs/02-protocol.md)） |
| 受信の暗号 | ✅ **完全に解明**（AES-128-ECB + PKCS#7 + XOR・→ [C23](docs/02-protocol.md)） |
| 器具の状態取得 | ✅ **実現**（vAddr / グループ / ファーム / ON・明るさ・色温度） |
| ナイトライト | ✅ 3 段階で切替 + **状態の読み戻しも可**（→ [C24](docs/02-protocol.md)） |
| 他コントローラの追従 | ✅ 純正アプリの操作を平文で観測して反映（→ [C28](docs/02-protocol.md)） |
| アドバタイズ / アドレス | ✅ 器具は**広告アドレス**で判定。Android でも問題なし（→ [C31](docs/02-protocol.md)） |
| 器具ファームウェア | ◐ 暗号化なしだが独自コンテナで圧縮（→ [C25](docs/02-protocol.md)） |
| **Matter ブリッジ** | ✅ **実装・Pi で稼働中・Google Home から操作可**（→ [07](docs/07-matter.md)） |
| Android アプリ | ⏳ 未着手・**設計とスコープは確定**（→ [05](docs/05-app-design.md)） |
| BLE スニファ | ⏸ 未手配（必要になったら nRF52840 Dongle を Pi に接続） |

### 解明したこと

1. **方式は GATT ベースのメッシュ**。**スマホが Peripheral（GATT サーバ）**になり、
   器具が接続してきて、コマンドは `Handle Value Notification` で送る
2. **照明制御コマンドを完全に解読**（明るさ・調色・グループ・シーン・センサー）
   - `0xC0` はサブコマンド方式（色温度+明るさ / 常夜灯 / スポット / サイド RGB）
   - **ON = 55 / OFF = 50** の特殊コード。それ以外はテーブル引き
   - **状態応答も解読**（`0x70` 要求 → `0x71` 応答）。明るさコードは**逆順**
   - コマンドはすべて絶対値指定 → **再送しても壊れない**
3. **PDU フォーマット確定**（メッセージデータは最大 9 バイト）。しかも**平文**
4. **認証は平文パスワードだけ**
   - ⭐ **アプリの ID 表示 8 桁 = HOMEID 4 桁 + パスワード 4 桁**
   - HOMEID は 10 進数の LE 4 バイト、パスワードは ASCII 4 バイト（変換方法が違う）
   - ⭐ **`PERIPHERAL_LOGIN` には応答してはいけない**（応答すると器具に切断される）
5. **不安定さの原因を確定** — セグメント再組み立てが欠落を検知せず、状態もリセットせず、
   タイムアウトも持たない。さらに**各コマンドを 1 回しか送らない**（実機ログで実証）
6. **器具のファームウェアが APK に同梱**（`assets/ota/*.mp3` は音声ではない）
7. **器具は普段アドバタイズしない。**「スキャンする側」なので受動スキャンでは発見不可

### 検証環境

| 環境 | 用途 |
| --- | --- |
| 開発機（Windows） | 静的解析・ドキュメント・ツール |
| Android 実機（Pixel 9） | 純正アプリの HCI ログ採取。**照明から離れた場所** |
| **Raspberry Pi 3**（`odelic-re-connected`） | **照明のそばに常設。自前実装の実行と `btmon` 観測** |

Pi は Tailscale 経由で SSH でき、`btmon` で完全な HCI トレースが取れる。
Android の bugreport 経由（`btsnooz`）はスキャン結果がフィルタで欠落するが、
Pi ならその制約がない。

詳細は [docs/04-analysis-procedure.md](docs/04-analysis-procedure.md) と
[docs/06-raspberrypi-setup.md](docs/06-raspberrypi-setup.md) を参照。

## リポジトリ運用

- 解析対象の APK・逆コンパイル成果物・HCI ログは **リポジトリに含めない**（`.gitignore` 済み）
  - 配布不可のバイナリであり、ログには端末固有情報が含まれるため
  - 作業用の置き場は `artifacts/`（Git 管理外）
- 解析から得た**知見**はドキュメントに、**コード**は実装ディレクトリに残す

## 法的な位置づけ

自身が所有する照明器具を相互運用（interoperability）するための解析。
プロトコル知識をもとに独自実装を行うもので、純正アプリのコードやアセットを再配布しない。
