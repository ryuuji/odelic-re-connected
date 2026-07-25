# 04. 解析手順書

最終更新: 2026-07-25

実際に手を動かす手順。コマンドは Windows（PowerShell）前提。

---

## 現在の環境状況

`R:\odelic-re-connected` の作業マシン（2026-07-25 時点）。

| ツール | 状況 | 用途 |
| --- | --- | --- |
| Java | ✅ **25 (LTS)** | jadx の実行に必要 |
| Python | ✅ 3.13 | パケット解析スクリプト |
| Node.js | ✅ 導入済み | 補助ツール |
| Chocolatey / winget | ✅ 両方あり | ツール導入 |
| **adb（platform-tools）** | ✅ **37.0.1** | APK 取得・ログ採取 |
| **jadx** | ✅ **1.5.6** | APK 逆コンパイル |
| **自作 btsnoop パーサ** | ✅ `tools/btsnoop.py` | HCI ログの差分解析 |
| Wireshark | ⏸ 保留（管理者権限が必要） | HCI ログの目視確認 |
| apktool | ❌ なし | jadx で足りる場合は不要 |
| Android SDK / Studio | ❌ なし | 新アプリのビルド時に導入 |

### 導入済みツールのパス

```
adb   C:\Users\ryuuj\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe
jadx  R:\odelic-re-connected\.tools\jadx\bin\jadx.bat
```

`adb` はユーザー PATH に登録済み（**新しいシェルから** `adb` で呼べる）。
`.tools/` は Git 管理外（各自の環境で導入する）。

---

## フェーズ 0: 環境構築 ✅ 完了

### 0-1. platform-tools（adb）

```powershell
winget install --id Google.PlatformTools -e --accept-source-agreements --accept-package-agreements --disable-interactivity
```

管理者権限なしで入る（ポータブルパッケージ）。PATH は自動で追加されるが、
反映には**シェルの再起動が必要**。

### 0-2. jadx（Java/Dalvik 逆コンパイラ）

`choco install jadx` は管理者権限が必要なので、ZIP 展開方式を採った。

```powershell
$dst = "R:\odelic-re-connected\.tools"
New-Item -ItemType Directory -Force $dst | Out-Null
$zip = Join-Path $env:TEMP "jadx-1.5.6.zip"
Invoke-WebRequest -Uri "https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath "$dst\jadx" -Force
Remove-Item $zip
```

Java 25 で動作確認済み。`jadx-gui` で対話的に読み、`jadx` CLI で全ソースを吐いて grep する、
の両方を使う。

### 0-3. HCI ログ解析ツール

**Wireshark は保留**した。インストールに管理者権限（UAC）が必要で、
かつ**差分解析の用途では GUI より不便**なため。

代わりに **`tools/btsnoop.py`（自作）**を主力にする。→ 後述の「自作解析ツール」節。

Wireshark も目視確認には有用なので、必要になったら入れる。

```powershell
winget install --id WiresharkFoundation.Wireshark -e   # 要 UAC
```

### 0-4. Android Studio（新アプリのビルド用）

解析フェーズには不要。実装フェーズに入る前に導入する。

```powershell
winget install --id Google.AndroidStudio -e
```

### 0-5. 作業ディレクトリ

```powershell
New-Item -ItemType Directory -Force R:\odelic-re-connected\artifacts
```

APK・逆コンパイル結果・HCI ログの置き場。`.gitignore` 済みで Git 管理外。

---

## 物理的な作業環境

### 開発機を照明のそばに移す必要はない

**HCI スヌープログは Android 端末の内部に溜まる**ため、記録時に PC は不要。

```
[照明のそば]  Android 実機だけを持っていってアプリを操作
      ↓        （ログは端末内に蓄積される）
[開発機]      adb bugreport でログを吸い出して解析
```

フェーズ 0・1・2（環境構築・APK 取得・静的解析）は照明が一切要らない。
照明のそばで作業が必要なのは**フェーズ 3 の記録時と、フェーズ 6 の動作確認**だけ。

### リアルタイム観測が必要になったら

事後解析は試行のループが遅い。自作コマンドを試して反応を見る段階（フェーズ 6）では
リアルタイムに電波を見たくなる。その際の選択肢。

| 案 | 構成 | 追加投資 | リアルタイム性 | 開発機の移動 |
| --- | --- | --- | --- | --- |
| **A** | Android 実機 + HCI ログ | 0 円 | 事後解析 | 不要 |
| **B** | ノート PC + nRF52840 Dongle | 約 4,000 円 | ◎ | 必要 |
| **C** | Raspberry Pi を照明のそばに常設 + 開発機から SSH | Pi + Dongle | ◎ | 不要 |

**⚠️ Windows 内蔵 BLE ではスニファリングできない。**
Windows の Bluetooth スタックは生のアドバタイズパケットをアプリに渡さない。
WinRT の `BluetoothLEAdvertisementWatcher` ではパースされた結果しか得られず、
`BluetoothLEAdvertisementPublisher` による**テスト発信は可能**だが受信側が不足する。
生パケットの観測には専用ハードが必須。

**推奨ハード: nRF52840 Dongle**（Nordic、約 4,000 円）
[nRF Sniffer for Bluetooth LE](https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-Bluetooth-LE)
（無償）を焼くと Wireshark の外部キャプチャデバイスとして使え、
複数チャネルを追える。Ubertooth One より安価で新しく、CC2540 より情報が多い。

**案 C が長期的な理想形**。Pi を照明のそばに常設して、
スニファと（BlueZ の `btmgmt` による）テスト発信を Pi 上で動かし、
開発機から SSH で叩く。開発機を動かさずにリアルタイム観測ができる。

**当面は案 A で進める。** 追加投資ゼロで今日始められ、しかも
「純正アプリが実際に何を送っているか」という**最も価値の高い正解データ**が取れる。
スニファが真価を発揮するのは自作コマンドを試す段階から。

---

## フェーズ 1: APK の取得

### 前提

- 純正アプリをインストール済みの Android 実機
- USB デバッグを有効化（設定 → デバイスについて → ビルド番号を 7 回タップ → 開発者オプション → USB デバッグ）

### 手順

```powershell
# 端末が見えるか確認
adb devices

# APK のパスを調べる（split APK の場合は複数行返る）
adb shell pm path jp.co.odelic.smt.remote10

# 取得（パスは上のコマンドの出力に置き換える）
adb pull /data/app/~~xxxx==/jp.co.odelic.smt.remote10-yyyy==/base.apk R:\odelic-re-connected\artifacts\odelic-base.apk
```

複数行返る場合は `split_config.*.apk` もすべて取得する
（ネイティブライブラリが `split_config.arm64_v8a.apk` に分かれていることがあり、
**Pairlink SDK が `.so` で提供されている場合はそこに入っている**）。

### バージョンの記録

```powershell
adb shell dumpsys package jp.co.odelic.smt.remote10 | Select-String -Pattern "versionName|versionCode|targetSdk"
```

解析結果とバージョンの対応が後で分からなくなるので、
取得した APK は `odelic-1.9.36-base.apk` のようにバージョン入りの名前で保存する。

---

## フェーズ 2: 静的解析

### 2-1. 逆コンパイル

```powershell
# GUI で読む
jadx-gui R:\odelic-re-connected\artifacts\odelic-1.9.36-base.apk

# 全ソースを出力して grep 可能にする
jadx -d R:\odelic-re-connected\artifacts\jadx-out R:\odelic-re-connected\artifacts\odelic-1.9.36-base.apk
```

### 2-2. まず Manifest を見る

確認項目。

- `targetSdkVersion` / `minSdkVersion` → I6（権限モデル）の裏付け
- 権限宣言：`BLUETOOTH_ADVERTISE` があるか（**あれば H1 のアドバタイズ方式がほぼ確定**）
- `ACCESS_FINE_LOCATION` の要求と `neverForLocation` フラグの有無
- Service / ForegroundService の宣言 → 常時スキャンの設計かどうか

### 2-3. 検索するキーワード

**最優先（プロトコル方式の判定）**

```
BluetoothLeAdvertiser
startAdvertising
AdvertiseData
AdvertiseSettings
setManufacturerData
addManufacturerData
setServiceData
isMultipleAdvertisementSupported
```

`startAdvertising` が見つかれば H1（アドバタイズ方式）が確定に近づく。
`setManufacturerData` の呼び出し箇所が**コマンド組み立ての本体**。

**次（受信側）**

```
BluetoothLeScanner
startScan
ScanFilter
ScanRecord
getManufacturerSpecificData
onScanResult
```

**GATT 接続を使っているかの確認**

```
BluetoothGatt
connectGatt
writeCharacteristic
discoverServices
UUID.fromString
```

見つかった UUID はすべて記録する。
GATT が登録フェーズのみに使われている可能性があるため、
呼び出し元をたどって「いつ使われるか」を確認する。

**識別子・鍵** ✅ 解明済み（[02-protocol.md](02-protocol.md) C16）

```
homeId  HomeId  HOMEID  homeid
setHomeidPassword
Settings.HOMEID  Define.PASSWORD
```

結論だけ再掲する。アプリの ID 表示 8 桁が
**上位 4 桁 = HOMEID（10 進 → LE 4 バイト）／下位 4 桁 = パスワード（ASCII 4 バイト）**。
現在の ID `99833900` → HOMEID `FF 26 00 00` / パスワード `33 39 30 30`。

ID そのものは APK に定数として埋め込まれておらず、SharedPreferences に保存される
（既定値のみ `"1111"` / `"9999"` がコード上にある）。

**暗号化**

```
Cipher
SecretKeySpec
AES
javax.crypto
MessageDigest
CRC
```

暗号化があれば鍵の導出元を追う（HOMEID から作っているかが焦点）。

**ベンダー SDK の痕跡**

```
com.pairlink
pairlink
telink
mesh
```

`com.pairlink.*` が見つかれば、Pairlink の Android SDK を使っていることになり、
SDK のクラス構造からプロトコルを読み取れる。

### 2-4. ネイティブライブラリの確認

```powershell
# APK 内の .so を一覧
python -c "import zipfile,sys;[print(n) for n in zipfile.ZipFile(sys.argv[1]).namelist() if n.endswith('.so')]" R:\odelic-re-connected\artifacts\odelic-1.9.36-base.apk
```

`.so` があれば、パケット組み立てや暗号化がネイティブ側に隠されている可能性がある。
その場合は静的解析の難易度が上がるため、**動的解析（フェーズ 3）を主軸にする**。

APK サイズが 9.8 MB と小さいので、大きな `.so` は無いと予想される。

### 2-5. 難読化の確認

クラス名が `a.b.c` のように潰されている場合は ProGuard/R8 による難読化。
その場合でも Android フレームワーク API の呼び出し
（`startAdvertising` など）は名前が残るので、そこを起点に読む。

---

## フェーズ 3: 動的解析（HCI スヌープログ）

**プロトコル解読の本命。** 電波上に実際に流れたバイト列が直接手に入る。

### 3-0. 事前準備（開発機側で完了済み）

```powershell
# logcat のリングバッファを拡大（既定 256 KiB → 16 MiB）
# 照明のそばで操作している間のログが溢れないようにする。再起動でリセットされる
adb shell logcat -G 16M
```

**2026-07-25 実施済み**（Pixel 9、main/system/crash/kernel を 16 MiB に）。

⚠️ **HCI スヌープログは adb から有効化できない。**
`setprop persist.bluetooth.btsnooplogmode full` は root 権限が必要で失敗する
（`Failed to set property`）。次の 3-1 を**端末の画面で手動操作**する必要がある。

### 3-1. ログを有効化（端末側で手動）

1. 開発者オプションを開く
2. 「**Bluetooth HCI スヌープログを有効にする**」を ON
   （機種により「Bluetooth HCI スヌープ ログを取得」等の表記）
3. **Bluetooth を OFF → ON**（有効化にはトグルが必要）

確認方法（有効化後）。

```powershell
adb shell getprop persist.bluetooth.btsnooplogmode   # "full" が返れば有効
```

### 3-2. 操作を記録する

**1 操作ずつ、間に数秒の間隔を空けて**実施するのが重要。
ログ上でどのパケットがどの操作に対応するかを切り分けられる。

記録するシナリオの順序。

| # | 操作 | 目的 |
| --- | --- | --- |
| 1 | アプリを起動して 10 秒待つ（何も操作しない） | 起動時のスキャン挙動、器具の状態アドバタイズ周期 |
| 2 | 電源 ON | 最小のコマンドパケット |
| 3 | 電源 OFF | ON との差分＝コマンド種別のバイト |
| 4 | 電源 ON をもう一度 | 同一操作でバイト列が変わるか（シーケンス番号・暗号化の判定） |
| 5 | 明るさを 1 段ずつ 5 回上げる | 調光値のバイト位置と単位 |
| 6 | 色温度を 1 段ずつ 5 回変える | 調色値のバイト位置 |
| 7 | 別グループで同じ操作 | グループ ID のバイト位置 |
| 8 | 全体一括操作 | ブロードキャスト用の特別な ID があるか |

操作の内容と時刻をメモに残す（後でログと突き合わせるため）。

⚠️ **グループ設定の変更・器具登録の初期化は、この段階ではやらない。**
壊すと壁スイッチからのやり直しになる。読み取り系・操作系を理解した後（フェーズ 5）に回す。

### 3-2b. このログで検証できること / できないこと

GATT で流れる PDU は暗号化されており、**純正アプリのログ出力は
リリースビルドで空実装**なので平文 PDU は取れない
（[02-protocol.md](02-protocol.md) C17-3b）。それでも検証できる範囲は広い。

| ✅ 検証できる | ❌ 検証できない |
| --- | --- |
| C2: GATT ベースか（接続イベントの有無） | C15: PDU のペイロード |
| C3 / C16-4 / C17-3: アドバタイズの形式と HOMEID | 状態応答の中身（明るさ・色温度コード） |
| C17-2: Central → Peripheral のフォールバック | |
| I1: 1 操作あたりの ATT 書き込み回数 | |
| I11: 接続の切断・再接続の頻度 | |
| I7: ATT 書き込みサイズ → セグメント分割の有無 | |

**ペイロードを平文で見たい場合は Frida で `processData` / `sendEncry` を
フックする**（C17-3c）。ただし自作アプリでは `LogUtil` を実装すれば
自然に見えるようになるので、実装フェーズまで待つ判断もありうる。

### 3-3. ログを取り出す（スクリプト 1 本で完結）

```powershell
# 照明のそばへ行く前
pwsh tools/collect_logs.ps1 prepare

# 操作を終えて開発機に戻ったら
pwsh tools/collect_logs.ps1 collect
```

`prepare` は logcat バッファ拡大・スヌープログの有効状態チェック・
アプリバージョン記録・logcat クリアを行う。
`collect` は logcat ダンプ → `dumpsys bluetooth_manager` → `bugreport` 取得 →
**ZIP から btsnoop を自動抽出**し、最後に解析コマンドを表示する。

以下は手動でやる場合の内訳。非 root 端末でも `bugreport` 経由で取得できる。

```powershell
adb bugreport R:\odelic-re-connected\artifacts\bugreport.zip
```

ZIP 内の `FS\data\misc\bluetooth\logs\btsnoop_hci.log`
（機種により `btsnooz_hci.log`、パスも異なる）を取り出す。

root 端末なら直接。

```powershell
adb pull /data/misc/bluetooth/logs/btsnoop_hci.log R:\odelic-re-connected\artifacts\
```

補助情報として Bluetooth スタックの状態も残す。

```powershell
adb shell dumpsys bluetooth_manager > R:\odelic-re-connected\artifacts\bluetooth_manager.txt
```

### 3-4. 自作パーサで解析する（主力）

`tools/btsnoop.py` を使う。→ 詳細は後述の「自作解析ツール」節。

```powershell
# ① まず全体像。GATT 接続の有無で H1 が判定される
python tools/btsnoop.py summary artifacts/btsnoop_hci.log

# ② 送信したアドバタイズ（＝アプリが出したコマンド）
python tools/btsnoop.py sent artifacts/btsnoop_hci.log

# ③ バイト差分。どのオフセットが何に対応するか
python tools/btsnoop.py diff artifacts/btsnoop_hci.log

# ④ HOMEID を探す（ID 表示 99833900 → HOMEID 9983 = 0x26FF → LE で FF 26）
python tools/btsnoop.py find artifacts/btsnoop_hci.log FF26 26FF

# ⑤ パスワードの ASCII を探す（"3900" → 33 39 30 30）
python tools/btsnoop.py find artifacts/btsnoop_hci.log 33393030

# ⑤ 操作とパケットの対応づけ
python tools/btsnoop.py timeline artifacts/btsnoop_hci.log
```

`summary` は仮説 H1 の判定を自動で出す。
「アドバタイズ送信があり、GATT 接続が一切ない」なら H1 支持、
接続イベントがあれば GATT 方式かハイブリッド。**ここが解析全体の分岐点**になる。

### 3-5. Wireshark で読む（補助）

パケットを 1 件ずつ目視したい時に使う。`btsnoop_hci.log` をそのまま開ける。

**まず判定すべきこと（H1 の検証）**

| 確認 | フィルタ | 判定 |
| --- | --- | --- |
| GATT 接続が発生しているか | `bthci_evt.code == 0x3e`（LE Meta Event） | 接続完了イベントが無ければ**コネクションレス確定** |
| アドバタイズ設定コマンド | `bthci_cmd.opcode == 0x2008`（LE Set Advertising Data） | **これが操作ごとに飛べば H1 が確定** |
| アドバタイズ有効化 | `bthci_cmd.opcode == 0x200a`（LE Set Advertise Enable） | 送信の開始・停止タイミングと継続時間 |
| 器具からの受信 | `bthci_evt.code == 0x3e` の Advertising Report | 器具の状態アドバタイズ |
| GATT 書き込み | `btatt.opcode` | GATT を使っている場合の書き込み内容 |

**便利なフィルタ**

```
# ベンダー独自データを含むアドバタイズのみ
btcommon.eir_ad.entry.type == 0xff

# 送信したアドバタイズデータの設定
bthci_cmd.opcode == 0x2008

# HOMEID の探索（ID 表示 99833900 → HOMEID 9983 = 0x26FF → リトルエンディアン）
frame contains ff:26

# パスワードの ASCII（"3900"）
frame contains 33:39:30:30

# 器具の MAC（Pairlink 系の OUI）
bthci_evt.bd_addr[0:3] == 00:95:69 || bthci_evt.bd_addr[0:3] == f0:ac:d7
```

HOMEID のエンコーディングは静的解析で確定済み
（[02-protocol.md](02-protocol.md) C16）。10 進数の**リトルエンディアン 4 バイト**で、
上位 2 バイトは常に `00 00`。
器具の MAC OUI は `API_get_mesh_homeid_from_scan` の判定条件から判明した 2 種類。

### 3-6. 判明したことを記録する

[02-protocol.md](02-protocol.md) の「確定事項」に、
根拠となるパケットの位置（レコード番号）とともに記録する。

---

## 自作解析ツール

### `tools/btsnoop.py` — btsnoop パーサ

Android の HCI スヌープログを解析する。Wireshark の代わりではなく、
**Wireshark では手作業になる差分解析を機械的にやる**ためのもの。

| サブコマンド | 用途 |
| --- | --- |
| `summary` | 全体像。コマンド/イベント統計、**仮説 H1 の自動判定**、アドバタイズ送信継続時間、受信元一覧、Company ID |
| `sent` | 送信したアドバタイズデータ（アプリが出したコマンド）を一覧 |
| `recv` | 受信したアドバタイズ（器具の状態通知）を一覧。`--addr` `--company` で絞れる |
| `diff` | ペイロードをオフセットごとに集計し、固定バイトと変動バイトを分離する |
| `find` | バイト列パターンを全パケットから検索。逆順も自動で試す |
| `timeline` | 送受信・**GATT 操作**・アドバタイズ有効化・接続を時系列に並べる |

**Pairlink / ODELIC 固有のデコード**（[02-protocol.md](02-protocol.md) C3・C16・C17 を実装）

- Company ID `0x0000` + `[C0\|C1][FF][既知の ADV type]` を Pairlink 形式として認識
- `ADV_*` の種別名を表示（`ADV_PHONE` はスマホ送信、`ADV_CONNECTABLE` は器具）
- **HOMEID を 10 進数で表示**（アプリの ID 表示の上位 4 桁と直接照合できる）
- `ADV_PHONE` に載るスマホの BT MAC を抽出
- 既知の OUI（`00:95:69` / `F0:AC:D7`）で**器具を自動判定**
- ATT 操作をハンドル付きで時系列表示（ペイロードは暗号化されているので中身は不可読）

**`summary` が自動判定すること**

- GATT 接続の有無と ATT 操作の内訳 → C2（GATT ベース）の確認
  - 静的解析の結論どおりなら「**△ ハイブリッド**」判定になるのが正しい
- アドバタイズ送信の継続時間（最短/中央/最長）→ I1（再送設計の欠如）の裏付け
- 受信元のユニーク数と件数の偏り → I2・S3（器具の取りこぼし）の定量化
- 検出された HOMEID の一覧 → 自分のネットワーク（9983）かどうかの切り分け
- `ADV_PHONE` の出現 → C17-2（Peripheral へのフォールバック）が起きたかどうか

**`diff` の読み方**

オフセットごとに「固定」か「変動 N 種」を出す。

- **固定バイト** → ヘッダ / HOMEID / 端末 ID の候補
- **少数の値をとるバイト** → コマンド種別 / グループ ID の候補
- **多数の値をとるバイト** → 調光値 / シーケンス番号 / 暗号化の候補

ユニークなペイロードが 1 種類しかない場合は
「同一操作でバイト列が変わらない＝平文かつ再送カウンタなし」と判定できる。

### `tools/collect_logs.ps1` — ログ回収スクリプト

`prepare` / `collect` の 2 モード。→ 3-3 を参照。

### `tools/synth_btsnoop.py` — 検証用の合成ログ生成

実機ログが無い状態でパーサの動作を確かめるためのもの。
**静的解析で判明した実際の形式**を模擬して出力する。

- 器具の `ADV_CONNECTABLE` ビーコン（既知の OUI・HOMEID 9983）
- Central 参加タイムアウト → `ADV_PHONE` へのフォールバック（C17-2）
- `LE Connection Complete`（GATT 接続の確立）
- ATT Write Command / Notification（ペイロードは暗号化を模擬）

```powershell
python tools/synth_btsnoop.py artifacts/synth.log
python tools/btsnoop.py summary artifacts/synth.log
python tools/btsnoop.py diff artifacts/synth.log
```

⚠️ **これは架空のデータで、実際の ODELIC のプロトコルではない。**
パーサの動作確認と、出力の読み方を掴むためだけに使う。

**検証結果（2026-07-25）**: 合成データに埋め込んだ構造
（HOMEID 2 バイト固定・端末 ID 2 バイト固定・グループ ID 4 種・
コマンド種別 4 種・値 10 種・シーケンス番号 16 種）を
`diff` が正しく分離できることを確認済み。

---

## フェーズ 4: プロトコルの文書化

フェーズ 2・3 で得た情報を [02-protocol.md](02-protocol.md) に統合する。

- パケットフォーマット（バイトオフセットごとの意味）
- コマンド一覧と引数の範囲
- 状態アドバタイズのフォーマットと周期
- 暗号化の仕様（ある場合）
- 登録シーケンス

**独立した実装ができる粒度**まで書く。ここが完成すればアプリ実装は素直な作業になる。

---

## フェーズ 5: 破壊的操作の解析

⚠️ このフェーズは器具の登録を壊すリスクがある。
**フェーズ 4 完了後、復旧手順（壁スイッチ操作からの再登録）を確立してから実施する。**

- グループ設定の書き込みシーケンス
- 器具登録（ペアリング）シーケンス
- 「ID 変更」による初期化の実体
- タイマー設定

---

## フェーズ 6: 新アプリの実装

[05-app-design.md](05-app-design.md) を参照。

---

## 進行状況

- [x] **フェーズ 0: 環境構築**（2026-07-25 完了）
  - [x] platform-tools（adb 37.0.1）
  - [x] jadx 1.5.6
  - [x] btsnoop パーサ自作 + 合成ログで検証
  - [ ] Wireshark（保留：要 UAC、必要になったら）
  - [ ] nRF52840 Dongle（フェーズ 6 で必要になったら手配）
- [x] **フェーズ 1: APK 取得**（2026-07-25 完了）
  - Pixel 9 / Android 17 から `adb pull`。`artifacts/odelic-1.9.36-vc133-base.apk`
- [x] **フェーズ 2: 静的解析**（2026-07-25 完了）
  - [x] jadx で逆コンパイル（5,236 クラス）
  - [x] Manifest・権限・targetSdk の確認
  - [x] Pairlink SDK の発見（難読化なし）
  - [x] 通信方式の判明（GATT ベース。仮説 H1 を訂正）
  - [x] PDU フォーマットとコマンドカタログの抽出
  - [x] 暗号化の所在の特定（ネイティブ側）
  - [x] OTA ファームウェア同梱の発見
  - [x] 各 MSGID のペイロード（`ControllerAct` / `CFormat` / `MeshBlePresenter`）
  - [x] 値のエンコード（テーブル方式・ON=55 / OFF=50）
  - [x] 状態応答のデコード（明るさコードは逆順）
- [ ] フェーズ 3: 動的解析
- [ ] フェーズ 4: プロトコル文書化
- [ ] フェーズ 5: 破壊的操作の解析
- [ ] フェーズ 6: 新アプリ実装
