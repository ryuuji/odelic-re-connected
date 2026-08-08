# OdelicMesh — ESP32-C6 用ライブラリ

[「CONNECTED LIGHTING for HOME」](https://www.odelic.co.jp/products/connectedlighting/app/)
対応の照明器具を、**Raspberry Pi を使わずマイコン単体から** 操作するための
Arduino ライブラリとサンプルです。

親プロジェクト（[../README.md](../README.md)）の解析結果
（[docs/02-protocol.md](../docs/02-protocol.md)）をそのまま C++ に移植したもので、
メッシュへの参加・AES 暗号処理・状態の復号まで、すべて ESP32 の中で完結します。
クラウドも中継サーバも要りません。

```cpp
#include <OdelicMesh.h>
odelic::OdelicMesh light;

void setup() {
  light.begin("12345678");        // ★ 公式アプリに出ている 8 桁 ID
}

void loop() {
  if (light.joined()) light.setLight(60, 50);   // 明るさ 60% / 色温度 50%
}
```

---

## 目次

- [できること・できないこと](#できることできないこと)
- [必要なもの](#必要なもの)
- [入れ方](#入れ方)
- [最初の書き込み](#最初の書き込み)
- [サンプル](#サンプル)
- [API](#api)
- [しくみ](#しくみ)
- [調整できるところ](#調整できるところ)
- [困ったとき](#困ったとき)
- [ファイル構成](#ファイル構成)

---

## できること・できないこと

| できること | 備考 |
| --- | --- |
| 点灯 / 消灯 | 一斉・グループ単位・器具個別の 3 通り |
| 明るさ（5〜100%・5% 刻み） | 器具は 20 段しか持たないのでその段に丸めます |
| 色温度（0〜100%） | 0% = 電球色 2700K / 100% = 昼光色 6500K（21 段） |
| 常夜灯（3 段） | 主灯とは排他。点けると主灯は消えます |
| 状態の読み取り | 器具からの暗号化応答をマイコン上で復号します |
| 器具の探索 | vAddr・MAC・グループ・製品コードを収集します |
| Matter 相当の値変換 | LevelControl(1〜254) / 色温度 mired ⇄ 器具の内部値 |

| できないこと | 代わりに |
| --- | --- |
| 器具の登録・グループ分けの変更 | 公式アプリで行ってください（読み取りだけします） |
| Matter デバイスとして公開する | Raspberry Pi 版（[`../matter/`](../matter/)）の担当です |
| HTTP API | 同上（[`../odelicd/`](../odelicd/)） |
| Wi-Fi 経由の操作 | このライブラリは BLE だけを使います |

⚠️ **8 桁 ID の下位 4 桁はメッシュのパスワードです。**
サンプルはスケッチに直接書く作りなので、**そのまま公開・共有しないでください。**
知られると、Bluetooth の届く範囲にいる人がその照明を操作できます。

---

## 必要なもの

| 項目 | 条件 |
| --- | --- |
| ボード | ESP32-C6（サンプルは Seeed XIAO ESP32C6 を前提にピンを書いています）。`architectures=esp32` なので他の ESP32 系でもビルドできます |
| Arduino core | ESP32-C6 に対応した [arduino-esp32](https://github.com/espressif/arduino-esp32) 3.x 系 |
| ライブラリ | [NimBLE-Arduino](https://github.com/h2zero/NimBLE-Arduino) **v2.x**（必須） |
| 8 桁 ID | 公式アプリのメニュー画面に出ている `ID:12345678`。→ [親 README](../README.md#8-桁-id-の調べ方) |
| 置き場所 | 器具に BLE が届くところ。⚠️ 金属製のスイッチボックスは電波を遮ります |

ESP32-C6 では従来の `BLEDevice.h` が使えないため、NimBLE を直接使っています。
AES は ESP32 内蔵の mbedtls を呼ぶので、追加の暗号ライブラリは要りません。

---

## 入れ方

### Arduino IDE

1. `esp32c6/OdelicMesh` フォルダごと、スケッチブックの `libraries/` にコピーします
   - Windows: `%USERPROFILE%\Documents\Arduino\libraries\OdelicMesh`
   - macOS / Linux: `~/Documents/Arduino/libraries/OdelicMesh` / `~/Arduino/libraries/OdelicMesh`
2. ライブラリマネージャで **NimBLE-Arduino**（2.x）を入れます
3. ボードマネージャで **esp32 by Espressif Systems** を入れ、ボードに
   「XIAO_ESP32C6」（または使う ESP32-C6 ボード）を選びます
4. Arduino IDE を再起動すると
   「ファイル → スケッチ例 → OdelicMesh」にサンプルが出ます

### arduino-cli

```bash
arduino-cli lib install "NimBLE-Arduino"
cp -r esp32c6/OdelicMesh "$(arduino-cli config get directories.user)/libraries/"

arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C6 \
  esp32c6/OdelicMesh/examples/SerialConsole
arduino-cli upload  --fqbn esp32:esp32:XIAO_ESP32C6 -p COM5 \
  esp32c6/OdelicMesh/examples/SerialConsole
```

---

## 最初の書き込み

**`SerialConsole` から始めるのが確実です。** 配線が要らず、参加できたかどうかが
シリアルモニタですぐ分かります。

1. スケッチの `DISPLAY_ID` を自分の 8 桁 ID に書き換える
2. 書き込む → シリアルモニタを 115200 baud、改行は LF で開く
3. 器具側から接続してくるのを待つ（電源投入直後や、しばらく操作がないと時間がかかります）
4. `★ メッシュ参加完了` が出たら `on` / `off` / `b 30` などを打つ

```
=== OdelicMesh SerialConsole ===
広告開始。器具の接続を待っています…
★ メッシュ参加完了（器具 4 台）。コマンドを入力できます。
> s
状態要求を送信（応答は数百 ms 後に届きます）
[状態] vAddr=01000000 ON b=60% c=50%
```

⚠️ 参加までは **こちらからは何も送れません**。器具が接続してきて初めて通信が始まります
（後述の[しくみ](#しくみ)）。`light.joined()` が `true` になるまで待ってから操作してください。

---

## サンプル

| サンプル | 内容 | 追加の配線 |
| --- | --- | --- |
| [`BasicControl`](OdelicMesh/examples/BasicControl/) | 参加後に 点灯 → 調光 → 調色 → 常夜灯 → 消灯 を 3 秒ごとに繰り返すだけの 50 行。最小の使用例 | なし |
| [`SerialConsole`](OdelicMesh/examples/SerialConsole/) | シリアルから対話操作。`on` `b 30` `c 100` `n 1` `level 128` `k 5000` `s`（状態）`d`（探索）`ls`（一覧）`v`（詳細ログ） | なし |
| [`WallSwitch`](OdelicMesh/examples/WallSwitch/) | 押しボタン 2 個の壁コントローラ。短押しで ON/OFF、長押しで調光（押すたびに方向反転）、もう 1 個で常夜灯の巡回 | SW1=D1 / SW2=D2 → GND |
| [`RoomController`](OdelicMesh/examples/RoomController/) | 押しボタン 4 個で 4 灯を個別に制御。宛先（全体 / グループ / vAddr / MAC）をシリアルから設定して NVS に保存。演出モードつき | SW1〜SW4 = D10 / D9 / D8 / D7 → GND |

### RoomController について

いちばん実用に近いサンプルです。ボタンを押すと
**消灯 → 常夜灯 → 主灯 70% → 主灯 100% →（消灯へ戻る）** と巡回します。
押した瞬間に器具の現在状態を見て、いちばん近い段から次へ進めるので、
公式アプリや他のリモコンで変えられていてもズレません。

- 宛先はシリアルから変更・保存できます
  （`set 1 group 2` / `set 3 vaddr 01000000` / `set 4 mac AA:BB:CC:DD:EE:FF`）
- ボタンに演出を割り当てられます（`set 3 demo`）。
  演出は **位相フェード / 雷 / おばけ / キャンドル / 日の出 / 鼓動 / パトランプ** の 7 種で、
  約 20 秒。実行中でも操作すれば中断します
- `id 12345678` で 8 桁 ID をシリアルから変更・保存できます
  （スケッチに書かずに済むので、こちらのほうが安全です）
- `conn` で実測の BLE 接続間隔（小さいほど低遅延）を確認できます

### 壁スイッチに組み込むときの注意

サンプルのコメントにも書いていますが、重要なので再掲します。

- ⚠️ **100V 側とは絶縁 AC-DC モジュール（例: HLK-5M05）で分離してください。**
  マイコン側は 3.3V / 5V の弱電です
- ⚠️ **AC 給電中に USB を挿さないでください。** 書き換えるときは AC を切ってから
- ⚠️ 金属ボックスは BLE を遮蔽します。u.FL の外部アンテナを箱の外へ出してください
- 既存の壁スイッチは「はめ殺し（常時 ON）」にして、器具の BLE を生かしたままにします
- ボタンは内部プルアップを使うので外部抵抗は不要ですが、直列 1kΩ ＋ 信号-GND 間 0.1µF を
  足すとチャタリングと ESD に強くなります

---

## API

`namespace odelic`。すべて `OdelicMesh` クラスのメソッドです。

### 開始と状態

| メソッド | 説明 |
| --- | --- |
| `bool begin(const char* id8, const char* name = "odelic-caliljp")` | 8 桁 ID で初期化して広告開始。8 桁の数字でなければ `false` |
| `bool joined()` | メッシュに参加できているか（送信可能か） |
| `bool linkUp()` | 器具と BLE 接続中か |
| `const uint8_t* ownVaddr()` | 自分に割り当てられた仮想アドレス（参加のたびに変わります） |
| `int deviceNum()` | 器具が申告してきたメッシュ内の台数 |

### 照明の操作

**すべて絶対値指定**なので、何度送っても結果は同じ（冪等）です。
取りこぼしが心配なら、同じコマンドをもう一度送って構いません。

| 範囲 | メソッド |
| --- | --- |
| 一斉（全器具） | `allOn()` / `allOff()` / `setAll(bright, color)` / `nightAll(level)` |
| グループ | `onGroup(g)` / `offGroup(g)` / `setGroup(g, bright, color)` / `nightGroup(g, level)` |
| 器具個別（vAddr） | `onDevice(v)` / `offDevice(v)` / `setDevice(v, bright, color)` / `nightDevice(v, level)` |
| 既定グループ | `on()` / `off()` / `setLight(bright, color)` / `night(level)` |

- `bright` … 明るさ %（0〜100）。器具は 5% 刻みの 20 段
- `color` … 色温度 %（0 = 電球色 / 100 = 昼光色）
- `level` … 常夜灯（**0 = 最も明るい / 2 = 最も暗い**）。⚠️ 器具側の内部値とは向きが逆です
- 既定グループは `setDefaultGroup(g)` で変えます（初期値 0）

### Matter 相当の値

Matter デバイスとして公開する機能ではなく、**Matter の属性値との相互変換**です。
常夜灯 3 段と主灯 20 段を 1 本の明るさ軸に畳んだ表現で
（→ [docs/07-matter.md](../docs/07-matter.md)）、Pi 版と同じ計算をします。

| メソッド | 説明 |
| --- | --- |
| `matterOnOff(bool)` | OnOff クラスタ相当 |
| `matterSetLevel(int level)` | LevelControl（1〜254）。軸の下端が常夜灯 |
| `matterSetColorKelvin(int k)` / `matterSetColorMireds(int m)` | 色温度 |
| `matterReadState(int& onOff, int& level, int& mireds)` | 現在値を Matter の値で読む（-1 = 未取得） |

### 状態の取得

| メソッド | 説明 |
| --- | --- |
| `requestStatus()` | 状態要求をブロードキャスト。1 通で全器具が応答します。暗号化応答は自動で復号され、テーブルに反映されます |
| `discover()` | 器具の探索（Ping ＋ 製品コード ＋ グループ）。参加後に呼びます |
| `deviceCount()` / `deviceAt(i)` / `deviceByVaddr(v)` | 検出した器具のテーブル（最大 24 台） |
| `cacheOn()` / `cacheBrightPct()` / `cacheColorPct()` | メッシュ全体の直近の観測値（未取得なら -1） |

`OdelicDevice` に入るもの: `vaddr` / `mac` / `productCode` / `versionProduct` /
`groupId` / `on` / `brightPct` / `colorPct` / `night` / `updatedAtMs`。
未取得の項目は -1 です。

### コールバック

```cpp
void onJoined(OdelicMesh& m)                        { m.requestStatus(); }
void onStatus(OdelicMesh& m, const OdelicDevice& d) { /* 1 台ぶんの状態が更新された */ }

light.onJoined(onJoined);
light.onStatus(onStatus);
```

⚠️ コールバックは **BLE のコールバック文脈から呼ばれます。** 中で長く待たない、
重い処理はフラグを立てて `loop()` 側でやる、が安全です。

---

## しくみ

⭐ **ここがこのライブラリのいちばん変わっている点です。**
ODELIC の公式アプリは「スマホが BLE ペリフェラル（GATT サーバ）」として動き、
**器具のほうから接続してきます**（→ [docs/02-protocol.md](../docs/02-protocol.md) の C17-2 / C18-2）。
このライブラリも同じく、ESP32 がペリフェラルになって待ち受けます。

```
[ESP32]  GATT サーバ FFD0（FFD1 Write / FFD2 Notify）＋ ADV_PHONE を広告
           ↓
[器具]   ESP32 に接続 → FFD2 を購読 → FFD1 に参加・制御コマンドを Write
           ↓
[ESP32]  FFD2 の Notify で応答・制御コマンドを送信
```

参加の流れ（`OdelicMesh.h` の冒頭コメントと同じ。docs C23-6）:

1. `ADV_PHONE` を広告する
2. `PERIPHERAL_LOGIN` を LOGINKEY で復号して linkKey を取り出し、正しい暗号応答を返す
3. `GET_PASSWORD` に HOMEID とパスワードを返す
4. `GET_VIRTUAL_ADDR` で自分の仮想アドレスを受け取る
5. `WELCOME` / `BROADCAST_MESHINFO` を受信 → 参加完了
6. 以降は制御コマンドを送信。状態応答は暗号化されているので復号する

鍵は 8 桁 ID から作ります（HOMEID とパスワードを 1 バイトずつ交互に並べ、
後半 8 バイトは固定文字列 → AES-128-ECB）。詳細は
[`OdelicCrypto.h`](OdelicMesh/src/OdelicCrypto.h) と docs C21-2 / C22 / C23 に。

---

## 調整できるところ

| メソッド | 既定値 | 用途 |
| --- | --- | --- |
| `setDefaultGroup(g)` | 0 | `on()` / `setLight()` などが使うグループ |
| `setColorKelvinRange(min, max)` | 2700 / 6500 | 器具のケルビン範囲（Matter 変換に効きます） |
| `setNightBand(percent, enabled)` | 30 / true | Matter の明るさ軸のうち常夜灯に割り当てる下端の割合 |
| `setConnParams(min, max, latency, timeout)` | 12 / 24 / 0 / 400 | BLE 接続間隔の要求値。`interval` は ×1.25ms（既定 15〜30ms）、`timeout` は ×10ms（既定 4 秒）。器具が承認すれば反映されます |
| `connIntervalMs()` | — | 実測の接続間隔（0 = 未取得） |
| `setVerbose(true)` | false | 送受信を 16 進でシリアルに出す |

コンパイル時の上限は [`OdelicMesh.h`](OdelicMesh/src/OdelicMesh.h) にあります
（追跡する器具 `ODELIC_MAX_DEVICES` = 24 台、覚える linkKey `ODELIC_MAX_LINKS` = 4）。

---

## 困ったとき

| 症状 | 見るところ |
| --- | --- |
| いつまでも参加しない | 8 桁 ID を確認してください。間違っていると器具がログインで離れます。`setVerbose(true)` にすると生バイトが見えます |
| 器具が接続してこない | 器具の電源（壁スイッチ）が入っているか、BLE が届く距離か。金属ボックスの中なら外部アンテナを |
| `begin()` が `false` | 8 桁の**数字**以外が入っています（ハイフンや空白も不可） |
| 送っても効かない | `joined()` が `true` か。グループ番号が合っているか（`discover()` → `ls` で確認） |
| 状態が `?` のまま | `requestStatus()` を呼んでください。応答は数百 ms 後に届きます |
| 反応が遅い | `conn`（RoomController）で接続間隔を確認。器具が要求値を承認しないことがあります |
| ビルドが通らない | NimBLE-Arduino が **v2.x** か（1.x とは API が違います）。Arduino core が ESP32-C6 対応版か |

---

## ファイル構成

```
esp32c6/
└── OdelicMesh/
    ├── library.properties          Arduino ライブラリの定義
    ├── keywords.txt                エディタの色分け用
    ├── src/
    │   ├── OdelicMesh.h / .cpp     本体（広告・参加・コマンド送信・状態の反映）
    │   ├── OdelicCrypto.h / .cpp   鍵生成・AES-128-ECB・PDU の暗号化/復号
    │   └── OdelicMatter.h / .cpp   Matter の値との相互変換（純関数）
    └── examples/
        ├── BasicControl/           最小の使用例
        ├── SerialConsole/          対話操作（最初はこれ）
        ├── WallSwitch/             ボタン 2 個の壁コントローラ
        └── RoomController/         ボタン 4 個・4 灯個別・演出つき
```

---

ODELIC / Pairlink とは無関係の非公式プロジェクトです。自己責任でお使いください。
ライセンスは親プロジェクトと同じ [MIT](../LICENSE) です。
