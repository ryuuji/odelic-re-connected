# 02. 通信プロトコル

最終更新: 2026-07-25（静的解析フェーズ 2 の結果を反映）

このファイルは**プロトコルの正典**。確定した事実は根拠（どのクラス・どのログで確認したか）付きで記録する。

**解析の前提**: 純正アプリ v1.9.36 (versionCode 133) を jadx 1.5.6 で逆コンパイルした結果。
**Pairlink 製 SDK が難読化されずに丸ごと含まれており**、クラス名・メソッド名・定数名が
すべて実名で読める。以下はその読解による。

> ⚠️ **jadx の定数名は信用しすぎないこと。**
> jadx は「値が同じ別の定数名」を誤って当てはめる。
> 例: `MeshCommon.processSegmentPDU` の `b & MeshService.PRODUCT_CODE_LC615` は
> 実際には `b & 0x0F`（PRODUCT_CODE_LC615 の値が 15 なので誤置換された）。
> `exit_cmd = {1, PRODUCT_CODE_DOWNLIGHT_100, 85}` も実際は `{0x01, 0x15, 0x55}`。
> **意味を取るときは必ず数値に戻して考える。**

---

## 確定事項

### C1. Pairlink「Connected Mesh」SDK を使用している

パッケージ `com.pairlink.connectedmesh.lib` が丸ごと含まれる。

| クラス | 行数 | 役割 |
| --- | --- | --- |
| `MeshService` | 2559 | プロトコル定数、API 群、状態管理 |
| `MeshFunc` | 2754 | 機能コマンドの組み立て・解釈 |
| `MeshCommon` | 599 | PDU の送受信、JNI 境界、アドバタイズ |
| `MeshBlePresenter` | 752 | 上位向けの presenter |
| `central/PlMeshCentral` | 507 | **スマホが Central のときの送受信** |
| `peripheral/PlMeshPeripheral` | 601 | **スマホが Peripheral のときの送受信** |
| `central/PlBleService` | 669 | GATT クライアント |
| `util/Util` | 420 | バイト操作、アドレス変換 |
| `MeshJoinMethod` | 207 | メッシュ参加方式の選択 |

ODELIC 独自の層は `jp.co.odelic.smt.remote03.*`（アプリのパッケージ名は `remote10` だが
内部は `remote03` 系列）。`jp.co.odelic.smt.remote03.guide.MeshProfile` が
**ODELIC 固有のコマンド定義**を持つ。

根拠: `artifacts/jadx-out/sources/com/pairlink/connectedmesh/lib/`

### C2. ⚠️ 仮説 H1 は誤り。GATT ベースのメッシュだった

**当初の仮説（アドバタイズパケットにコマンドを載せてブロードキャストする）は誤り。**
実際は **GATT 接続で 1 台の器具と繋がり、そこを入口にしてメッシュ全体へコマンドを流す**方式。

`MeshCommon.sendData()` が送信の分岐点。

```java
if (MeshService.join_mode == 0) {
    PlMeshCentral.getInstance().sendBtData(bArr2);      // スマホが Central
} else if (1 == MeshService.join_mode) {
    PlMeshPeripheral.getInstance().sendBtData(bArr2, device);  // スマホが Peripheral
}
```

`join_mode` は 2 通り。

| join_mode | スマホの役割 | 通信の向き |
| --- | --- | --- |
| 0 | **Central**（GATT クライアント） | スマホが器具に接続する |
| 1 | **Peripheral**（GATT サーバ） | **器具がスマホに接続してくる** |

状態定数も両方を持つ。

```java
PL_JOIN_STATE_IDLE = 0
PL_JOIN_STATE_SCAN = 1
PL_JOIN_STATE_CENTRAL = 2
PL_JOIN_STATE_PERIPHERAL = 3
```

`LOCAL_GATT_SERVER_CONNECTED` / `LOCAL_GATT_SERVER_DISCONNECTED` というブロードキャストも
定義されており、**スマホ側が GATT サーバを立てる**ことが裏付けられる。

#### 「Bluetooth ペリフェラルモード対応機種が必須」の正体

これで公式の但し書きが説明できた。**アドバタイズのためではなく、
スマホが GATT サーバ（Peripheral role）になるため。**
[01-findings.md](analysis/01-findings.md) で立てた仮説の「反証されうる点」に書いた
もう一方の可能性が正解だった。

根拠: `MeshCommon.sendData()` / `MeshService` の `join_mode`・`PL_JOIN_STATE_*`・
`LOCAL_GATT_SERVER_CONNECTED`

### C3. アドバタイズは「呼びかけビーコン」として併用される

コマンド送信の主経路ではないが、アドバタイズも使う。
`MeshCommon.startIBeaconAdvertise(byte[] data, byte type)`。

```java
private AdvertiseSettings createAdvSettings(boolean connectable, int timeout) {
    builder.setAdvertiseMode(2);      // ADVERTISE_MODE_LOW_LATENCY (約 100ms)
    builder.setConnectable(connectable);
    builder.setTimeout(timeout);      // 呼び出しは常に 0 = 無期限
    builder.setTxPowerLevel(3);       // ADVERTISE_TX_POWER_HIGH
}

private AdvertiseData createAdvertiseData(byte[] data, byte type) {
    // [0] = 0xC1 (flow_control 有効時) または 0xC0
    // [1] = 0xFF
    // [2] = type (ADV_* のいずれか)
    // [3..] = data
    builder.addManufacturerData(0, buf);   // ★ Company ID = 0
}
```

**Company ID は 0**（Bluetooth SIG 未割当の値を使っている）。
HCI ログ上では AD Type `0xFF`、Company ID `00 00` で現れる。
先頭バイトが `0xC0` / `0xC1` なのは `DATAEVENT_MSGID_SM_BRIGHT_LIGHT` /
`..._GROUP` の値をマジックナンバーとして流用しているため。

アドバタイズ種別 `ADV_*`（`startIBeaconAdvertise` の `type` 引数）。

| 定数 | 値 | 用途（推測） |
| --- | --- | --- |
| `ADV_SINGLE` | 0x01 | 単体指定 |
| `ADV_BROADCAST` | 0x02 | 一斉 |
| `ADV_NORMAL` | 0x03 | 通常 |
| `ADV_NORMAL_SETMESH` | 0x04 | メッシュ設定 |
| `ADV_PHONE` | 0x05 | **スマホの存在通知**（`peripheralAppConnectionStatus` をリセット） |
| `ADV_RESET` | 0x07 | リセット |
| `ADV_PHONE_E1` | 0x08 | スマホ通知（E1 系） |
| `ADV_DISCOVERABLE` | 0x09 | 発見可能 |
| `ADV_BROADCAST_E1` | 0x0A | 一斉（E1 系） |
| `ADV_HOMEID` | 0x0C | **HOMEID 通知** |
| `ADV_NORMAL_SETMESH_E1` | 0x0D | メッシュ設定（E1 系） |
| `ADV_NORMAL_SETMESH_E2` | 0x21 | メッシュ設定（E2 系） |
| `ADV_CONNECTABLE` | 0x82 | 接続受付 |

根拠: `MeshCommon.createAdvSettings` / `createAdvertiseData` / `startIBeaconAdvertise`、
`MeshService` の `ADV_*` 定数

### C4. 暗号化はネイティブライブラリ内。鍵は HOMEID + パスワード

`MeshCommon` の JNI 宣言。

```java
public native void setHomeidPassword(byte[] homeid, byte[] password);
public native byte[] sendEncry(byte[] addr, byte[] data, int len);
public native byte[] processData(byte[] addr, byte[] data, int len);
public native byte[] genCreateData(byte[] data, int len);
public native void deviceDisconnected(byte[] addr);
public native void meshExited();
public native String helloFromJNI();
static { System.loadLibrary("native-lib"); }
```

- **`setHomeidPassword(homeid, password)`** — HOMEID とパスワードから鍵を導出して保持
- **`sendEncry()`** — 送信時の暗号化
- **`processData()`** — 受信時の復号。**Java 側は復号後の平文 PDU しか見ない**

`libnative-lib.so`（arm64 版 100,328 バイト）に `AES` 文字列が 11 箇所、
`pairlink` が 18 箇所ある。**暗号化は AES と考えられる（要検証）**。

⚠️ **2026-07-25 訂正**: 実機の HCI ログを見た結果、**照明制御の PDU は平文で流れている**
ことが判明した。暗号化されるのは PDU タイプ `0x06` のみ。
**バイト列を組み立てれば暗号化なしで制御できる。** → 詳細は C18-3。

根拠: `MeshCommon` の native 宣言、`lib/arm64-v8a/libnative-lib.so` の文字列

### C5. PDU の階層構造

`processMeshPDU()` が復号後の PDU の先頭バイトで分岐する。

| `pdu[0]` | 定数 | 意味 |
| --- | --- | --- |
| 0x01 | `CMD` | メッシュ制御コマンド |
| 0x02 | `RESPONSE` | コマンドへの応答 |
| 0x03 | `DATA_EVENT` | **データイベント（照明制御はここ）** |
| 0x04 | `MESH_EVENT` | メッシュイベント（`pdu[1]==0x04` でセグメント） |

### C6. DATA_EVENT の PDU フォーマット（確定）

`MeshProfile.createDataEvent()` に完全な組み立てがある。

```
オフセット  長さ  内容
[0]         1    0x03            DATA_EVENT
[1..4]      4    宛先 vAddr      （ブロードキャストは FF FF FF FF）
[5]         1    0x20 または 0x2A  DATAEVENT_TYPE_TOLIGHT / _2A
[6..9]      4    送信元 vAddr    （スマホ自身 = MeshService.own_vAddr）
[10]        1    MSGID           DATAEVENT_MSGID_*
[11..]      0-9  メッセージデータ
```

**メッセージデータは最大 9 バイト**（`createDataEvent` が `length > 9` を明示的に弾く）。
PDU 全長は最大 20 バイト。`MeshCommon.real_mtu = 20` と一致する
（GATT のデフォルト MTU 23 − ATT ヘッダ 3 = 20）。

→ **1 コマンドは必ず 1 パケットに収まる**。逆に言えば
9 バイトを超える設定（グループ構成など）はセグメント分割が必要になる。

vAddr は **4 バイトの仮想アドレス**。MAC アドレス（6 バイト）とは別。

```java
public static final byte[] broadcast_addr      = {-1, -1, -1, -1};        // FF FF FF FF
public static final byte[] broadcast_mac_addr  = {-1,-1,-1,-1,-1,-1};     // FF×6
public static final int    UNIT_MASK_ALL       = -2147418113;             // 0x8000FFFF
```

根拠: `MeshProfile.createDataEvent()`、`MeshCommon.makeDataEventLocalCmd()`、
`MeshService` の `broadcast_addr` 等

### C7. 照明制御コマンドのカタログ（確定）

`jp.co.odelic.smt.remote03.guide.MeshProfile` の定数。
Java の `byte` は符号付きなので、**16 進に直した値**を併記する。

#### 明るさ・色

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `DATAEVENT_MSGID_SM_BRIGHT_LIGHT` | **0xC0** | 明るさ（個別） |
| `DATAEVENT_MSGID_SM_BRIGHT_LIGHT_GROUP` | **0xC1** | 明るさ（グループ） |
| `DATAEVENT_MSGID_SM_BRIGHT_LIGHT_SIDE_GROUP` | 0xC2 | 明るさ・サイド（グループ） |
| `DATAEVENT_MSGID_SM_BRIGHT_LIGHT_NIGH_GROUP` | 0xC5 | 明るさ・常夜灯（グループ） |
| `DATAEVENT_MSGID_SM_CHANGE_COLOR` | **0xE2** | 調色（個別） |
| `DATAEVENT_MSGID_SM_CHANGE_COLOR_GROUP` | **0xE3** | 調色（グループ） |
| `DATAEVENT_MSGID_SM_LOWER_LIMIT` | 0xB6 | 下限設定 |

#### RGB

| 定数 | 値 |
| --- | --- |
| `DATAEVENT_MSGID_SM_RGB_LIGHT_ONOFF` | 0xB2 |
| `DATAEVENT_MSGID_SM_RGB_LIGHT_ONOFF_GROUP` | 0xB3 |
| `DATAEVENT_MSGID_SM_RGB_LIGHT_LOOP` | 0xB4 |
| `DATAEVENT_MSGID_SM_RGB_LIGHT_LOOP_GROUP` | 0xB5 |
| `DATAEVENT_MSGID_SM_RGB_LIGHT2` | 0xC3 |
| `DATAEVENT_MSGID_SM_RGB_LIGHT_GROUP2` | 0xC4 |

#### グループ・シーン

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `DATAEVENT_MSGID_SM_GROUP_IN` | 0x30 | グループへ追加 |
| `DATAEVENT_MSGID_SM_GROUP_OUT` | 0x31 | グループから削除 |
| `DATAEVENT_MSGID_SM_SCENE_IN` | 0x40 | シーンへ登録 |
| `DATAEVENT_MSGID_SM_SCENE_OUT` | 0x41 | シーンから削除 |
| `DATAEVENT_MSGID_SM_SCENE_PLAY` | 0x42 | シーン再生 |

⚠️ **グループ・シーン系が S4〜S6（保存失敗・操作不能・初期化必要）の実行部分**。
解析はフェーズ 5 まで触らない。

#### 状態取得

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `DATAEVENT_MSGID_SM_STATUS` | 0x70 | 状態 |
| `DATAEVENT_MSGID_STATUS_MAIN` | 0x71 | 主状態 |
| `DATAEVENT_MSGID_STATUS_LC615` | 0x73 | LC615 の状態 |
| `DATAEVENT_MSGID_STATUS_RGB2` | 0x77 | RGB2 の状態 |

#### ID・ネットワーク

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `DATAEVENT_MSGID_SM_ID_CENTRAL` | 0x02 | Central 側 ID |
| `DATAEVENT_MSGID_SM_ID_PERIPHERAL` | 0x80 | Peripheral 側 ID |
| `DATAEVENT_MSGID_CNTL_NET` | 0xD5 | ネットワーク制御 |

#### 人感・明るさセンサー（ポーチセンサー）

`REQ` / `ANS` の対で要求と応答になっている。

| 定数 | 値 |
| --- | --- |
| `DATAEVENT_MSGID_PSENSOR_ONOFF_REQ` / `_ANS` | 0x89 / 0x8A |
| `DATAEVENT_MSGID_PSENSOR_LINK_ONOFF_REQ` / `_ANS` | 0x8B / 0x8C |
| `DATAEVENT_MSGID_PSENSOR_LINK_ONOFF_BLINK_ANS` | 0x8D |
| `DATAEVENT_MSGID_PSENSOR_LINK_ONOFF_LIGHT_REQ` / `_ANS` | 0x8E / 0x8F |
| `DATAEVENT_MSGID_SM_PSENSOR_ONOFF_GROUP` | 0x84 |
| `DATAEVENT_MSGID_SM_PSENSOR_LINK_ONOFF_GROUP` | 0x85 |
| `DATAEVENT_MSGID_SM_PSENSOR_LINK_ONOFF_LIGHT_GROUP` | 0x87 |

根拠: `jp/co/odelic/smt/remote03/guide/MeshProfile.java`

✅ **各 MSGID のメッセージデータは解析済み。→ C15 を参照。**

### C8. データチャネル

`DATA_EVENT` の `[5]` バイト、および `process_mesh_data_event` の分岐。

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `DATAEVENT_TYPE_TOLIGHT` / `CHANNEL_0` | **0x20** | **照明宛（主経路）** |
| `DATAEVENT_TYPE_TOLIGHT_2A` | 0x2A | 照明宛（別系統） |
| `CHANNEL_MAC` | 0x14 | MAC 指定 |
| `DATA_CHANNEL_REMOTE_CMD` | 0x11 | リモコンコマンド |
| `DATA_CHANNEL_REMOTE_RESPONSE` | 0x12 | リモコン応答（RSSI・ログ等） |
| `DATA_CHANNEL_PWM` | 0xA2 | PWM |
| `DATA_CHANNEL_PWM_STATUS` | 0xB0 | PWM 状態 |
| `DATA_CHANNEL_UART0` / `UART1` | 0xA0 / 0xA1 | UART パススルー |
| `DATA_CHANNEL_PING_RESPONSE` | 0xFF | **Ping 応答（器具の発見に使う）** |

#### C8-2. ⭐ チャネル番号の正体（ベンダー仕様書で確定 → C26）

チャネルは **ユーザー定義の論理チャネル 0〜31**（5 bit）で、
**電波上のバイト = `0x20 | チャネル番号`**。上位の bit5 が「ユーザーデータ」の印。

| 電波上 | チャネル番号 | ODELIC の用途（実測） |
| --- | --- | --- |
| `0x20` | **0** | 照明への制御（個別・グループ）／状態要求 |
| `0x24` | **4** | 製品自己申告（`0x80`）・グループ応答（`0x D7`）の戻り |
| `0x27` | **7** | **状態応答（`0x71`）の戻り** |
| `0x2A` | **10** | 全器具一斉の制御 |
| `0xFE` / `0xFF` | （範囲外） | Ping / Ping 応答。SDK 内部用でユーザー空間外 |
| `0xFB` | （範囲外） | アプリが登録している内部チャネル |

裏付け: `MeshBlePresenter.registerBle()` が
`for (i = 0; i < 18; i++) API_register_mesh_data_channel((byte)(i + 32))` と
**32〜49（= チャネル 0〜17）**を登録している。`+ 32` = `0x20` を足しているだけだった。

⚠️ これが「状態要求をチャネル `0x2A` で送ると無応答」（C23-8）の理由。
器具のアプリはチャネルごとに待ち受けを分けており、
状態要求はチャネル 0、その応答はチャネル 7 に固定されている。

### C9. メッシュ制御コマンド（`pdu[0] == 0x01`）

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `GET_PASSWORD` | 0x00 | パスワード取得 |
| `WELCOME` | 0x01 | 参加受付 |
| `BROADCAST_MESHINFO` | 0x02 | メッシュ情報通知（器具台数を含む） |
| `SET_MESH` | 0x03 | メッシュ設定 |
| `DISABLE_MESH` | 0x04 | メッシュ無効化 |
| `GET_PWM_STATUS` | 0x05 | PWM 状態取得 |
| `GET_OWN_ADDRESS` | 0x06 | 自アドレス取得 |
| `GET_DEVICE_INFO` | 0x07 | デバイス情報取得 |
| `SET_FRIENDLY_NAME` / `GET_FRIENDLY_NAME` | 0x08 / 0x09 | 表示名 |
| `GET_VIRTUAL_ADDR` | 0x0A | **vAddr 取得** |
| `GET_SLAVE_ROLE_INTERVAL` | 0x0B | スレーブ役の間隔 |
| `SET_MESH_NETNAME` | 0x0C | ネットワーク名設定 |
| `SET_LINK` | 0x10 | リンク設定 |
| `CENTRAL_LOGIN` | 0x16 | **Central としてログイン** |
| `PERIPHERAL_LOGIN` | 0x19 | **Peripheral としてログイン** |
| `CENTRAL_GET_PWD` | 0x20 | Central のパスワード取得 |
| `SEND_SEGMENT` | 0x21 | セグメント送信 |
| `SET_MESH_ENCRY` | 0x22 | **暗号化設定（器具追加時）** |
| `GET_MLIB_VER` | 0x24 | ライブラリバージョン取得 |
| `MESH_COMMAND_LOG_RSSI_GET` / `_SET` | 0x25 / 0x26 | RSSI ログ |
| `MESH_COMMAND_LOG_LEVEL_SET` / `_GET` / `_DATA` | 0x27 / 0x28 / 0x29 | ログレベル |
| `GET_SIGN_STATUS` | 0x30 | 署名状態取得 |

応答コード（`pdu[0] == 0x02`）。

| 定数 | 値 |
| --- | --- |
| `MESH_RESPONSE_SUCCESS` | 0 |
| `MESH_RESPONSE_INVALID_LENGTH` | 1 |
| `MESH_RESPONSE_INVALID_CMD` | 2 |
| `MESH_RESPONSE_INVALID_PARAMETER` | 3 |

`exit_cmd = {0x01, 0x15, 0x55}` — メッシュ退出コマンド。

根拠: `MeshService` の定数群、`MeshCommon.process_mesh_cmd()` / `process_mesh_response()`

### C10. セグメント分割の実装に欠陥がある（I7 の裏付け）

`MeshCommon.processSegmentPDU()`。

```java
byte b = bArr[2];
int seq   = b & 0x0F;          // 下位 4bit = シーケンス番号
int total = (b >> 4) & 0x0F;   // 上位 4bit = 総セグメント数
if (seq == this.current_seq + 1) {
    // 連結して蓄積
    if (total == seq) { /* 完成 */ }
}
return null;   // ★ 番号が飛んだら黙って破棄。再送要求もタイムアウトも無い
```

**欠落を検知する仕組みが一切ない。**
`seq != current_seq + 1` なら `null` を返して捨てるだけで、
`segment_data_offset` と `current_seq` はリセットされない。
つまり**一度パケットを落とすと、以降そのセッションの再組み立てが永久に失敗する**。

→ [03-instability.md](analysis/03-instability.md) の **I7（書き込み系の非冪等性）を裏付ける実装上の証拠**。
グループ設定の保存失敗（S4）と、保存後に操作不能になる（S5）症状の説明になる。

セグメント数は 4bit なので**最大 15**。1 セグメント 20 バイト弱なので
実質のペイロード上限は 250 バイト強。

根拠: `MeshCommon.processSegmentPDU()`

### C11. 権限は Android 12+ に移行済み。ただし位置情報を要求している

`AndroidManifest.xml`（`minSdkVersion=23` / `targetSdkVersion=35`）。

```
BLUETOOTH, BLUETOOTH_ADMIN                    ← 旧 API 用（残置）
BLUETOOTH_CONNECT, BLUETOOTH_SCAN, BLUETOOTH_ADVERTISE  ← Android 12+ 対応済み
ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION  ← ★ 位置情報を要求
ACCESS_WIFI_STATE, CHANGE_WIFI_STATE, INTERNET
REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, WAKE_LOCK
SCHEDULE_EXACT_ALARM, RECEIVE_BOOT_COMPLETED, FOREGROUND_SERVICE
```

**`BLUETOOTH_ADVERTISE` が宣言されている**ことで、アドバタイズを使う（C3）ことが裏付けられる。

Android 12+ の新権限には移行済みなので、[03-instability.md](analysis/03-instability.md) の
**I6 は「未対応」ではなかった**。ただし `BLUETOOTH_SCAN` に `neverForLocation` が付いておらず
`ACCESS_FINE_LOCATION` を要求しているため、
「権限を全部許可しないと動かない」（S8）は説明できる。**I6 は部分的に成立**。

→ 自作アプリでは `neverForLocation` を付けて位置情報要求を無くせる。

### C12. 対応製品コードの一覧

`MeshService.PRODUCT_CODE_*`。器具の種類を識別する 1 バイト。

| 値 | 定数 | 値（続き） | 定数（続き） |
| --- | --- | --- | --- |
| 0x01 | `LED_LINE` | 0x11 | `RGB` |
| 0x02 | `LED_SQUIRE` | 0x12 | `INDIRECT_600` |
| 0x03 | `LED_TUBE` | 0x13 | `INDIRECT_1200` |
| 0x04 | `LED_CEILING_MAT_6` | 0x14 | `DOWNLIGHT_60` |
| 0x05 | `LED_CEILING_MAT_8` | 0x15 | `DOWNLIGHT_100` |
| 0x06 | `LED_CEILING_MAT_10` | 0x1A | `LED_450` |
| 0x07 | `LED_CEILING_MAT_12` | 0x1B | `BRIGHT_SENSOR` |
| 0x08 | `LED_CEILING_MAT_14` | 0x1C | `HUMAN_SENSOR` |
| 0x09 | `LED_CEILING_MAT_8_450` | 0x1D | `INTERFACE` |
| 0x0A | `LED_CEILING_MAT_12_450` | 0x27 | `RGB_INDIRECT_600` |
| 0x0B〜0x0F | `LC611`〜`LC615` | 0x28 | `RGB_INDIRECT_1200` |
| 0x10 | `CCT` | 0x2B | `2B` |
| 0x3F | `RGB_INDIRECT_900` | 0x49 | `RGB_BLE_DRIVER` |
| 0x4A | `DONGLE` | 0x8E | `LC632` |

デバイス種別（Pairlink のチップ世代）: `DEVICE_TYPE_MOUSELET = 0`、`DEVICE_TYPE_TIGERKIN = 1`。
`GetPingResponse` では `productId` 136 / 29 を特別扱いしている。

### C13. 器具の発見は Ping で行う

`MeshService.API_ping_all()` を投げ、`DATA_CHANNEL_PING_RESPONSE (0xFF)` の
データイベントで応答が返る。`MeshCommon.GetPingResponse()` が解釈する。

```
[6..11]   6  器具の MAC アドレス
[12..15]  4  器具の vAddr
[16..17]  2  バージョン（リトルエンディアン）→ productId の判定にも使う
[18]      1  バージョン
[19]      1  バージョン
```

応答から `DeviceBean` を作り、RTT（`System.currentTimeMillis() - MeshService.startTime`）を
記録してソートしている。

→ **起動時の 7 秒（症状 S1）は、この Ping 応答の収集待ち**と考えられる **[推測]**。
Ping はブロードキャストで投げて各器具の応答を待つ方式なので、
取りこぼせば台数が足りない（S3）。**I2 の仮説は方式が違っただけで、症状の説明としては成立する。**

根拠: `MeshCommon.GetPingResponse()`、`MeshService.API_ping_all()`

### C14. OTA ファームウェアが APK に同梱されている

`assets/ota/*.mp3` の 22 ファイル。**MP3 ではない**（拡張子を偽装しているだけ）。

先頭バイトが全ファイルで共通。

```
10_2_0.mp3 〜 38_2_0.mp3 (19 ファイル)
  A2 1A 00 6C 30 00 00 1B 33 00 00 00 00 00 00 14 ...

20292_4_5.mp3 / 20307_4_11.mp3 / 20308_3_5.mp3 (3 ファイル)
  18 01 00 00 A2 1A 00 6C 30 00 00 1B 33 00 00 00 ...   ← 4 バイトのヘッダが前置
```

命名は `<製品コードまたは型番>_<major>_<minor>.mp3` と読める
（`14_2_0` → 製品コード 0x14 = `DOWNLIGHT_60` の v2.0 など **[推測]**）。
サイズは約 29〜33 KB で、器具のファームウェア本体と考えられる。

→ **器具側のファームウェアが手に入る**ということ。
Java 側から読めない `.so` の暗号処理や、器具側のコマンド解釈を
ファームウェアの逆アセンブルから追える可能性がある **[要検証]**。
ODELIC 側の OTA 実装は `jp/co/odelic/smt/remote03/ota/`。

⚠️ **OTA 機能には絶対に触らない。** 器具を文鎮化させる危険がある。
解析はファイルを読むだけに留める。

### C15. メッセージデータの中身（確定）

`jp.co.odelic.smt.remote03.act.module.ControllerAct` が実際のコマンド組み立て元。
`jp.co.odelic.smt.remote03.entity.CFormat` が値のエンコードを持つ。

#### C15-1. 送信の 2 経路

```java
if (MainController.Tiger_mode) {
    MeshService.getInstance().API_send_user_defined_data(dstVAddr, channel, localCmd);
} else {
    PlMeshPeripheral.getInstance().sendBtData(
        MeshCommon.makeDataEventLocalCmd2(dstVAddr, channel, localCmd));
}
```

`Tiger_mode`（`DEVICE_TYPE_TIGERKIN` = 新しい Pairlink チップ）で分岐するが、
**組み立てるバイト列は同一**。

#### C15-2. ローカルコマンド配列 → 電波上の PDU

アプリ内部では「ローカルコマンド配列」という中間形式で組み立て、
`makeDataEventLocalCmd2()` が前に 6 バイトを付けて PDU にする。

```
ローカルコマンド配列                    電波上の PDU
[0..3] 送信元 vAddr        ────┐        [0]     0x03      DATA_EVENT
[4]    MSGID                   │        [1..4]  宛先 vAddr
[5..]  パラメータ              │        [5]     チャネル (0x20 / 0x2A)
                               └──────→ [6..9]  送信元 vAddr
                                        [10]    MSGID
                                        [11..]  パラメータ
```

**オフセットの対応は `wire = local + 6`。** 以下は**ローカル配列の添字**で示す。

#### C15-3. ⭐ 宛先がブロードキャストのときチャネルが変わる

```java
if (dst[0..3] == FF FF FF FF) channel = 0x2A;  // DATAEVENT_TYPE_TOLIGHT_2A
else                          channel = 0x20;  // DATAEVENT_TYPE_TOLIGHT
```

一斉操作は `0x2A`、個別・グループ指定は `0x20`。
`process_mesh_data_event` の受信側でもこの区別が使われる
（`syncAllState` は `channel == 0x2A` のときだけ動く）。

#### C15-4. 個別制御 `0xC0`（SM_BRIGHT_LIGHT）— サブコマンド方式

**`[5]` のサブコマンドで機能が切り替わる。** これが照明制御の中核。

```
[4] 0xC0
[5] サブコマンド
[6] [7] [8] [9] [10] [11]  ← サブコマンドごとに意味が変わる
```

| `[5]` | 機能 | 使うバイト | 呼び出し元 |
| --- | --- | --- | --- |
| 0 | **色温度 + 明るさ** | `[6]`=色温度, `[7]`=明るさ（逆順） | `setlight()` |
| 1 | **常夜灯** | `[7]`=レベル | `setlight_night()` |
| 2 | **スポット** | `[8]`=レベル | `setlight_spot()` |
| 3 | **サイド RGB** | `[9]`=R, `[10]`=G, `[11]`=B | `setlight_side_rgb()` |

```java
// setlight(vAddr, cct, bright, sub)   ← 第 2 引数が色温度、第 3 引数が明るさ
{own(4), 0xC0, sub, cct, bright, 0, 0, 0, 0}
// setlight_night(vAddr, level)     → {own(4), 0xC0, 1, 0, level, 0,0,0,0}
// setlight_spot(vAddr, level)      → {own(4), 0xC0, 2, 0, 0, level, 0,0,0}
// setlight_side_rgb(vAddr, r,g,b)  → {own(4), 0xC0, 3, 0, 0, 0, r, g, b}
```

⚠️ `ControllerAct.setlight(byte[] addr, int i, int i2, int i3)` の引数名は
jadx が潰しているため、**引数の意味は呼び出し元から逆算する必要がある**。
`ct_switch` の `setlight(vAddr, 55, 55, i)` は両方 55 なので手がかりにならず、
`sendgroup_new(group, color/5, (100-bright)/5)` が唯一の決定的な証拠（C18-4）。

#### C15-5. グループ制御のレイアウト

グループ系はビットマップ + グループ番号という共通形。

```
[4]      MSGID
[5]      パラメータ 1
[6]      パラメータ 2
[7..12]  グループビットマップ（6 バイト = 48 bit）
[13]     グループ番号
```

`[7..12]` は通常ゼロで、`send_groupBit_night()` など一部の関数だけが
`GroupBitBean.getByteList()` の値を入れる。**48 個の器具を bit で選択できる**構造。

| 関数 | MSGID | `[5]` | `[6]` |
| --- | --- | --- | --- |
| `sendgroup(g, cct, bright)` | 0xC1 | **色温度** | **明るさ（逆順）** |
| `group_change_color(i)` | 0xE3 | — （`[5..10]` がビットマップ、`[11]`=i） | — |
| `sendgroup_spot(g, v)` | 0xC2 | `(v & 0x0F) << 4` | 0 |
| `sendgroup_rgb(g, a,b,c,d)` | 0xC2 | `(a<<4)\|b` | `(c<<4)\|d` |
| `sendgroup_night(g, v, msgid)` | 引数で指定 | 0 | v |
| `send_group_rgb_loop(on, g)` | 0xB5 | 0 | on ? 1 : 0 |
| `send_group_rgb(i, i2, g)` | 0xC4 | `i & 0xFF` | `((i>>8)&0xFF) \| (i2&0x1F)` |

⚠️ `group_change_color` だけビットマップの位置が `[5..10]` にずれている（他は `[7..12]`）。
純正アプリの実装が揃っていない。

#### C15-6. その他のコマンド

| 関数 | ローカル配列 | 備考 |
| --- | --- | --- |
| `get_light_status(vAddr)` | `{own(4), 0x70}` | **パラメータなし。状態要求はこれだけ** |
| `send_hu_sensor(vAddr)` | `{own(4), 0x65}` | 人感センサー要求。**0x65 は MeshProfile に定義がない** |
| `send_single_rgb_loop(on, vAddr)` | `{own(4), 0xB4, 0, on?1:0}` | RGB ループ |
| `send_single_rgb(vAddr, i, i2)` | `{own(4), 0xC3, 0, i&0xFF, (i>>8)&0xFF, 6}` | 末尾の `6` は固定 |
| `save_restore_scenes(save, n, vAddr)` | `{own(4), save?0x40:0x42, 0,0,0,0,0,0, n}` | `[11]`=シーン番号 |
| `send_SM_PSENSOR_LINK_ONOFF_LIGHT_GROUP` | `{own(4), 0x87, 1, mac(6), g}` | `[6..11]` に MAC 6 バイト |

#### C15-7. ⭐ 値のエンコード：ON/OFF は特殊コード

**最重要**。明るさ・色温度は素の 0-255 ではなく、**製品タイプごとのルックアップテーブル**から
引いたコード値。そして ON/OFF は値域外の特殊コードで表す。

| 状態 | 明るさ | 色温度 |
| --- | --- | --- |
| **ON** | **55** | **55** |
| **OFF** | **50** | **50** |

```java
// ControllerAct.ct_switch()
if (on)  setlight(vAddr, 55, 55, i);   // または sendgroup(group, 55, 55)
else     setlight(vAddr, 50, 50, i);   // または sendgroup(group, 50, 50)
```

⚠️ `ct_switch` は `CFormat.getSwitchFormatBy(code, z)` を呼んでいるが
**戻り値を捨てて 55/50 をハードコードしている**。純正アプリのバグまたは実装の残骸。

#### C15-8. 値のルックアップテーブル（`CFormat`）

UI からは **0〜100 のパーセント**で受け取り、テーブルの添字に変換する。

```java
linear_progressToIndex(percent, len) = clamp((int)(percent * len / 100.0), 0, len-1)
```

| テーブル | 内容 | 段数 |
| --- | --- | --- |
| `BRIGHT` | `{1, 2, 3, ... 20}` | 20 |
| `COLOR` | `{1, 2, 3, ... 21}` | 21 |
| `WARM` | `{88, 90, 92, ... 106}`（0x58〜0x6A の偶数） | 10 |
| `COOL` | `{108, 110, 112, ... 126}`（0x6C〜0x7E の偶数） | 10 |
| `SIDE` | `{224,224}, {226,226}, ... {244,244}`（0xE0〜0xF4 の偶数ペア） | 11 |
| `ONOFFTYPE` | `{0, 255, 255, ... 255}` | 20 |
| `WARM_COOL_FORMAT` | 5 × 10 の `{warm, cool}` ペア表 | 50 |

`getLinearFormatCodeBy(productCode, brightPct, colorPct)` が製品タイプで分岐する。

| 製品タイプ | 返す値 |
| --- | --- |
| 調光のみ | `{BRIGHT[idx], 0}` |
| ON/OFF のみ | `{ONOFFTYPE[idx], ONOFFTYPE[idx]}` |
| 調光 + 色 | `{BRIGHT[idx], COLOR[idx]}` |
| 調光調色（既定） | `WARM_COOL_FORMAT[brightIdx / 2][colorIdx]` |

**[要検証]** `WARM`/`COOL` のコード（88〜126）と `BRIGHT`/`COLOR` のコード（1〜21）は
まったく違う値域なのに同じバイト位置に入る。器具側が製品タイプごとに解釈を変えている
はずだが、判別方法（製品コードを事前に知っている必要がある）は未確認。

#### C15-9. ⭐ 状態応答のデコード（明るさは逆順）

`MeshBlePresenter.onDataReceived(channel, data, isBroadcast)` が受け取る `data` は
`process_mesh_data_event` が切り出した PDU の 6 バイト目以降。
つまり `data[0..3]` = 送信元 vAddr、`data[4]` = MSGID、`data[5..]` = ペイロード。

| `data[4]` | 定数名（`MeshBlePresenter`） | 処理 |
| --- | --- | --- |
| 0x80 | `ID_PERIPHERAL` | `getProductId()` — `[5..10]`=MAC, `[11]`=製品コード, `[13]`=LC615 モード |
| 0xC0 | `ALL_CONTROL_STATE_RESPONSE` | `syncAllState()` — **チャネル 0x2A のときだけ**。`[6][7]` |
| 0xD7 | `GROUP_RESPONSE` | `[12]` = グループ ID。**MeshProfile に定義がない MSGID** |
| 0x35 / 0x71 | `STATE_RESPONSE_FD` / `STATE_RESPONSE` | `syncState()`。RGB は `[9][10][11]` |
| 0x75 | `LC615_STATE_RESPONSE` | `syncLC615State()` |
| 0x77 | `RGB_STATE_RESPONSE` | `checkRGBResponse([5], [6], [7])` |
| 0x67 | `MOVING_RESPONSE` | 宣言のみ（このハンドラでは未使用） |
| 0x45 | `MOVING_SCENE_RESPONSE` | 宣言のみ |
| 0x62 | `LU_SENSOR_RESPONSE` | 宣言のみ |

**`syncState()` の中身が状態監視の核。**

```java
// data[5] = 色温度コード, data[6] = 明るさコード
if (data[5] == 50 && data[6] == 50)      → OFF
else if (data[5] == 55 && data[6] == 55) → ON
else {
    color  = data[5] * 5;              // 0..100 %
    bright = 100 - (data[6] * 5);      // ★ 逆順
    if (0 <= data[6] && data[6] < 20)  bright_progress = 19 - data[6];
    if (0 <= data[5] && data[5] <= 20) color_progress = data[5];
}
```

⭐ **明るさコードは逆順**。`0` が最も明るく、`19` が最も暗い。
色温度コードは順方向で `0`〜`20`。

✅ **コマンド側とまったく同じ式**（C18-4 で確定）。

```
色温度:  code = color% / 5          ⇔  color% = code * 5
明るさ:  code = (100 - bright%) / 5 ⇔  bright% = 100 - code * 5
         ただし bright% == 0 のときは code = 19
```

送った値と返ってきた値を**バイト単位でそのまま比較できる**ので、
収束判定（[03-instability.md](analysis/03-instability.md) の P2 / P4）が単純な等値比較で済む。

`syncAllState()` は 1 バイトずれて `data[6][7]` を見る（50/50 = 全消灯、55/55 = 全点灯）。

→ **これで「器具の現在状態を読む」実装が完全に判明した。**
状態を常時監視する（[03-instability.md](analysis/03-instability.md) の P1）ために必要な情報は揃っている。

#### C15-10. `CFormat.Header` — 別系統のプロトコル定義

`CFormat` には `ProductorCode`（`LC604`〜`LC609`、`LCD_M06_BI`〜`LCD_M12_RGB`）と
`Header` という enum がある。ODELIC の **LC シリーズ調光コントローラ**向けの定義と思われる。

| Header | 値 | Header | 値 |
| --- | --- | --- | --- |
| `BRIGHT_WRITE` | 0x01 | `TIMER_START` | 0x03 |
| `ID_CENTRAL` | 0x02 | `TIMER_END` | 0x04 |
| `BRIGHT_READ_REQ` | 0xC0 | `MODE_READ_REQ` | 0x90 |
| `BRIGHT_READ_ANS` | 0xC1 | `MODE_READ_ANS` | 0x91 |
| `ID_PERIPHERAL` / `PRODUCT_CODE` | 0x80 | `SCENE_SET` | 0xA0 |
| `BRIGHT_NOTIFY` | 0x81 | `SCENE_READ_REQ` | 0xA1 |
| `TIMER_NOTIFY` | 0x82 | `SCENE_READ_ANS` | 0xA2 |
| `TIMER_NOTIFY_GAP_REQ` | 0xE0 | `SCENE_PLAY` | 0xA3 |
| `TIMER_NOTIFY_GAP_ANS` | 0xE1 | `SCENE_NOTIFY` | 0xA4 |
| `VERSION_PERIPHERAL_REQ` | 0xF0 | `VERSION_PERIPHERAL_ANS` | 0xF1 |

`ID_CENTRAL` = 0x02 と `ID_PERIPHERAL` = 0x80 は
`MeshProfile.DATAEVENT_MSGID_SM_ID_CENTRAL` / `_PERIPHERAL` と**値が一致する**。

**[要検証]** 同じプロトコルの別命名なのか、別系統の製品向けなのか。
一致するものと矛盾するもの（0xC0 が `SM_BRIGHT_LIGHT` か `BRIGHT_READ_REQ` か）が
混在しており、断定できない。**タイマー系（0x82・0xE0・0xE1・0x03・0x04）は
`MeshProfile` に対応物がないので、この enum しか手がかりがない。**

#### C15-11. ⚠️ jadx の定数誤置換の実例

この解析で踏んだ罠。**値が同じ無関係な定数名に置換される。**

| jadx の出力 | 実際の値 | 何が起きたか |
| --- | --- | --- |
| `MeshProfile.DATAEVENT_MSGID_SM_STATUS` | 112 | `CFormat` の色温度テーブルの数値 112 |
| `MeshProfile.DATAEVENT_MSGID_SM_CHANGE_COLOR` | −30 | `SIDE` テーブルの数値 −30 |
| `MeshService.PRODUCT_CODE_LC615` | 15 | ビットマスク `& 0x0F` の 15 |
| `MeshService.PRODUCT_CODE_DOWNLIGHT_100` | 21 | `exit_cmd` の 0x15 |
| `Opcodes.INSTANCEOF` | 193 | `sendGroup_new2(55, 55, 193)` の MSGID 0xC1 |
| `Opcodes.IF_ICMPNE` | 160 | `Header.SCENE_SET` の 0xA0 |

最も分かりやすい例は `kotlin/io/encoding/Base64Kt.java`。
**Base64 のアルファベット表が MSGID 名の羅列になっている**
（`{DATAEVENT_MSGID_SM_SCENE_OUT, DATAEVENT_MSGID_SM_SCENE_PLAY, 67, 68, ...}`
は実際には `{'A', 'B', 'C', 'D', ...}` = `{65, 66, 67, 68, ...}`）。

→ **定数名は必ず数値に戻して、文脈が合うかを確認する。**

### C16. ⭐ HOMEID とパスワードの正体（確定）

**実装の最大の関門だった `setHomeidPassword()` の引数が完全に判明した。**

#### C16-1. アプリが表示する「ID」は 8 桁 = HOMEID 4 桁 + パスワード 4 桁

```java
// LightLoginIDHandSetAct / LightLoginIDAutoSetAct / LightLoginIDReceiveAct / HandIdSetActivity
FileSpUtils.getInstance(this).commitSp("HOMEID",       id.substring(0, 4));  // 上位 4 桁
FileSpUtils.getInstance(this).commitSp(Define.PASSWORD, id.substring(4, 8)); // 下位 4 桁
```

アプリの設定画面に出る 8 桁の「ID」は、**前半 4 桁が HOMEID、後半 4 桁がパスワード**。
SharedPreferences のキー `"HOMEID"` と `"PASSWORD"` に別々に保存される。

#### C16-2. バイト列への変換

```java
// MainController / WelcomeAct / LightLoginID*Act など（同じコードが 8 箇所に重複）
Settings.HOMEID   = FileSpUtils.getStrRecordFromSP("HOMEID", "1111");
Settings.PASSWORD = FileSpUtils.getStrRecordFromSP(Define.PASSWORD, "9999");

MeshService.homeid = BleUtil.int2byte(Integer.parseInt(Settings.HOMEID));  // ★ 10進 → LE 4バイト
MeshService.pwd    = Settings.PASSWORD.getBytes();                          // ★ ASCII 4バイト
MeshService.getInstance().API_set_mesh_info(MeshService.homeid, MeshService.pwd, (byte) -110);
  → MeshCommon.getInstance().setHomeidPassword(homeid, pwd);
```

**HOMEID とパスワードで変換方法が違う**のが要注意点。

| 項目 | 変換 | 例（ID = `12345678`） |
| --- | --- | --- |
| **HOMEID** | 10 進数として `parseInt` → **リトルエンディアン 4 バイト** | `"1234"` → 1234 = 0x04D2 → `D2 04 00 00` |
| **パスワード** | **ASCII 文字コードそのまま** | `"5678"` → `35 36 37 38` |

```java
// BleUtil.int2byte — リトルエンディアン
return new byte[]{(byte)(i & 255), (byte)((i>>8) & 255), (byte)((i>>16) & 255), (byte)(i>>>24)};
```

HOMEID は 4 桁（最大 9999 = 0x270F）なので、**上位 2 バイトは常に `00 00`**。
実質 2 バイトしか使っていない。

#### C16-3. 現在の値（これが唯一の正）

| ID 表示 | HOMEID 文字列 | HOMEID バイト (LE) | パスワード文字列 | パスワード バイト (ASCII) |
| --- | --- | --- | --- | --- |
| **`12345678`** | **`1234`** (0x04D2) | **`D2 04 00 00`** | **`5678`** | **`35 36 37 38`** |
| （既定値） | `1111` (0x0457) | `57 04 00 00` | `9999` | `39 39 39 39` |

既定値は `getStrRecordFromSP` の第 2 引数から。
`Settings.java` のクラス初期値は `"0000"` / `"0000"` だが、実行時に必ず上書きされる。

⭐ **この分割規則は 2 つの異なる 8 桁 ID で裏付けた**（解析の途中で ID を変更・
再ペアリングしたため）。⚠️ 旧値そのものは書かない — 下位 4 桁はメッシュの
パスワードで、無効化済みでも公開する意味がないため。

→ **HCI ログで HOMEID を探すときは `D2 04` を検索する**（上の表の LE 表現の先頭 2 バイト）。
当初 BCD 表現を想定していたが**誤り**で、実際は 10 進数のリトルエンディアン表現だった。

#### C16-4. アドバタイズから HOMEID を読み取る実装

`MeshService.API_get_mesh_homeid_from_scan(String mac, byte[] advData)` が
他の器具・コントローラのアドバタイズから HOMEID を抽出する。

```java
// MAC の 4〜6 バイト目でベンダーを判定
//   69 95 00  または  D7 AC F0
// アドバタイズデータ内で以下のパターンを探す
//   [0xC0 または 0xC1][0xFF][0x82 または 0x01 または 0x02]
// その直後の 4 バイトを byte2int（リトルエンディアン）して 10 進文字列で返す
return String.valueOf(Util.byte2int(new byte[]{
    advData[i+3], advData[i+4], advData[i+5], advData[i+6]}));
```

- `[0]` の `0xC0`/`0xC1` は `flow_control_enable` による切り替え（C3 と同じ）
- `[2]` の `0x82`/`0x01`/`0x02` は `ADV_CONNECTABLE` / `ADV_SINGLE` / `ADV_BROADCAST`
- **器具の MAC アドレス上位（OUI 相当）が `00:95:69` または `F0:AC:D7`**
  （`hexStringToBytesInv` で反転されるため、判定は逆順のバイトで行われている）

→ **HCI ログで器具を特定するのに使える。** `docs/analysis/tools/btsnoop.py recv --addr` の
絞り込みに、この 2 つの OUI が手がかりになる。

#### C16-5. ⚠️ セキュリティ上の観察

事実として記録しておく。

- パスワードは **4 桁の数字を ASCII にしただけ**（10,000 通り）
- HOMEID も 4 桁（10,000 通り）
- `LightLoginIDReceiveAct`（「ID 受信」機能）が存在し、
  **8 桁の ID をコントローラ間で無線送信できる**
- ODELIC のユーザー登録ではパスワードが自動生成でユーザー変更不可
  （[01-findings.md](analysis/01-findings.md) のサカエン記事）だが、
  これは Web 会員登録の話で、この 4 桁パスワードとは別

これは**自分の器具を操作するための解析**の範囲であり、
他者のネットワークへの干渉は目的でも用途でもない。
記録の目的は、自作アプリで同じ値を渡す必要があるため。

### C17. GATT の UUID と接続シーケンス（確定）

#### C17-1. UUID 一覧

**スマホが Central のとき**（器具が公開するサービスに接続する）— `Util.java`

| 用途 | UUID |
| --- | --- |
| サービス | `9e5d1e47-5c13-43a0-8635-82adffc0386f` |
| 書き込み | `9e5d1e47-5c13-43a0-8635-82adffc1386f` |
| 通知 | `9e5d1e47-5c13-43a0-8635-82adffc2386f` |
| CCCD | `00002902-0000-1000-8000-00805f9b34fb` |

**スマホが Peripheral のとき**（スマホが GATT サーバを立てる）— `PlMeshPeripheral.java`

| 用途 | UUID (16-bit) | プロパティ / パーミッション |
| --- | --- | --- |
| サービス | `0000ffd0-...` (0xFFD0) | PRIMARY |
| 書き込み | `0000ffd1-...` (0xFFD1) | READ \| WRITE / READ \| WRITE |
| 通知 | `0000ffd2-...` (0xFFD2) | READ \| NOTIFY / READ \| WRITE |
| CCCD | `00002902-...` | READ \| WRITE |

128 bit 側の `ffc0` / `ffc1` / `ffc2` が 16 bit 側の `FFD0` / `FFD1` / `FFD2` に対応しており、
**同じ役割の 3 点セット（サービス・書き込み・通知）を両方向で用意している**構造。

→ **HCI ログではこの UUID で GATT 操作を特定できる。**

#### C17-2. ⭐ join_mode は「Central を試して失敗したら Peripheral」

```java
public static int join_mode = 1;   // ★ 既定値は Peripheral
```

| 遷移 | 契機 |
| --- | --- |
| → 0（Central） | `API_central_connect_dev()` / `PlMeshCentral.connectDevice()` |
| → 1（Peripheral） | `API_peripheral_join_mesh()` |
| → 1（Peripheral） | **`runable_central_join_timeout`（Central 参加のタイムアウト）** |

タイムアウト時のフォールバック処理。

```java
if (1 == MeshService.join_state) {          // Central 参加中だった
    API_scan_connectable_dev(false);        // スキャン停止
    MeshService.join_mode = 1;              // Peripheral へ切り替え
    byte[] bArr = new byte[10];
    System.arraycopy(MeshService.homeid, 0, bArr, 0, 4);              // [0..3] HOMEID
    System.arraycopy(BleUtil.strToHexByte(btMac), 1, bArr, 4, 6);     // [4..9] スマホの MAC
    MeshCommon.getInstance().stopAdvertise();
    mCallback.onMeshStatusChanged(11, "");  // MeshStatusPeripheral
    MeshCommon.getInstance().startIBeaconAdvertise(bArr, (byte) 5);   // ADV_PHONE
}
```

**既定値が Peripheral（1）であることが「ペリフェラルモード対応機種が必須」の理由。**
Central で繋がらない環境では必ずこちらに落ちる。

⚠️ **これは I11（GATT 接続が切れると全器具が操作不能）と直結する。**
Central 参加のタイムアウト → Peripheral へ切り替え → 器具からの接続待ち、
という流れの間、コマンドは一切通らない。この待ち時間が
症状 S1（起動が遅い）・S5（操作が効かない）に効いている可能性が高い **[推測]**。

#### C17-3. ⭐ スマホのアドバタイズは平文。HCI ログで直接読める

`ADV_PHONE`（type 5）のアドバタイズは **`startIBeaconAdvertise` に渡す前に暗号化されない**
（`sendEncry` を通らない）。C3 の `createAdvertiseData` と合わせると、
電波上のマニュファクチャラデータは次の形になる。

```
AD Type 0xFF (Manufacturer Specific Data)
  [0..1]  00 00        Company ID = 0
  [2]     C0           ★ flow_control_enable が常に false なので固定
  [3]     FF
  [4]     05           ADV_PHONE
  [5..8]  D2 04 00 00  HOMEID（現在の ID 12345678 → 1234 のリトルエンディアン）
  [9..14] xx xx xx xx xx xx   スマホの BT MAC
```

→ **HCI ログの検索パターンが確定した。**

```powershell
python docs/analysis/tools/btsnoop.py find artifacts/btsnoop_hci.log C0FF05D2040000
```

器具側のアドバタイズは `[C0][FF][82 or 01 or 02]` の直後 4 バイトが HOMEID（C16-4）。

| 3 バイト目 | 意味 |
| --- | --- |
| `05` | `ADV_PHONE` — **スマホが出す** |
| `82` | `ADV_CONNECTABLE` — 器具が接続受付中 |
| `01` | `ADV_SINGLE` |
| `02` | `ADV_BROADCAST` |

⚠️ **GATT で流れる PDU 本体は暗号化されている**ので、
HCI ログから読めるのはアドバタイズと、GATT の操作パターン（どの UUID に何バイト書いたか）まで。
**PDU の中身は読めない。**

#### C17-3b. ⚠️ 訂正：logcat から平文 PDU は読めない

当初「純正アプリが復号後の PDU を logcat に出している」と記述したが、**誤りだった。**

`MeshCommon` は確かに平文 PDU をログに出す**コードを持っている**。

```java
LogUtil.d(TAG, Util.byte2HexStr(bArr) + ", jni send: " + ...);          // 送信
LogUtil.d(TAG, "mesh recv: " + Util.byte2HexStr_haspace(pdu) + ...);   // 受信
```

しかし**リリースビルドでは `LogUtil` と `MeshLog` の全メソッドが空実装**。

```java
public class LogUtil {
    public static void d(String str, String str2) { }   // ← 中身が無い
    public static void e(String str, String str2) { }
    ...
}
```

`MeshLog` も同様で、`init()` すら `bool.booleanValue()` を呼ぶだけ。
ファイル出力の機構（`logWriter` / `getLogFileName()`）は残っているが、
書き込みメソッドが空なので何も出力されない。

**実測での確認（2026-07-25）**: Pixel 9 でアプリを起動し 12 秒間 logcat を採取した結果、
全 345 行のうち関連タグは `MainController` の 1 行のみ。平文 PDU は一切出なかった。

生き残っている `android.util.Log` の直接呼び出しは全体で **38 箇所**だけで、
そのうち 16 進バイト列を出すのは **1 箇所のみ**。

```java
// MeshService.java:502 — メッシュ作成時だけ HOMEID + パスワードの 9 バイトが出る
Log.e("==jk==", "Create mesh -- " + BleUtil.bytesToHexString(bArr));
```

#### C17-3c. では平文 PDU をどう見るか

| 手段 | 内容 | 評価 |
| --- | --- | --- |
| **Frida** | `processData` / `sendEncry` の JNI 呼び出しをフックして引数・戻り値を覗く | ◎ 確実。純正アプリの動作を平文で観測できる |
| **自作アプリ** | SDK を流用する際に `LogUtil` を自前実装に差し替える | ◎ 実装フェーズで自然に解決する |
| `.so` の解析 | 暗号方式を解いて HCI ログを復号 | △ 手間が大きい |

**実装の観点ではブロッカーにならない。** SDK を流用する方針（案 C）なので、
自分のビルドでは `LogUtil` を実装すれば平文が見える。

**HCI ログで検証できる範囲は依然として大きい。**

| 検証できる | 検証できない |
| --- | --- |
| C2（GATT ベースか） | C15（PDU のペイロード） |
| C3・C16-4・C17-3（アドバタイズの形式と HOMEID） | 状態応答の中身 |
| C17-2（Central → Peripheral のフォールバック） | |
| I1（1 操作あたりの書き込み回数） | |
| I11（接続の切断頻度） | |
| ATT 書き込みのサイズ → セグメント分割の有無（I7） | |

#### C17-4. `flow_control_enable` は常に false

```java
public static boolean flow_control_enable = false;   // ← 唯一の代入
```

コード全体で**どこからも `true` にならない**。未使用のフィーチャートグル。
したがって以下は常に固定。

- アドバタイズの先頭バイトは常に `0xC0`（`0xC1` にはならない）
- `MeshCommon.processMeshPDU` の `PlMeshPeripheral.processFlowControl()` 呼び出しは
  `join_mode == 1` の条件だけで動く（フロー制御自体は別系統）

→ 自作アプリでも無視してよい。

### C18. ⭐⭐ 実機 HCI ログによる検証（2026-07-25）

Pixel 9 で採取した btsnoop（`artifacts/btsnoop_hci-20260725-154002.log`、
1,391 レコード / 497.9 秒）を解析した結果。**静的解析の結論がほぼ全面的に裏付けられ、
同時に 2 つの重要な訂正が判明した。**

> ⚠️ 開発者オプションの HCI スヌープログは**無効のまま**だった。
> このログは **bugreport に既定で含まれる `btsnooz`**（直近の HCI リングバッファ）。
> 開発者オプションを有効化しなくても解析できるが、
> **スキャン結果（受信アドバタイズ）はフィルタで除外される**（`recv` が 0 件）。
> 器具のビーコンを見たい場合は開発者オプションの有効化が必要。

#### C18-1. ✅ 実証されたこと

| 項目 | 期待（静的解析） | 実測 |
| --- | --- | --- |
| C2: GATT ベース | 接続あり | ✅ `LE Enhanced Connection Complete` × 2 |
| C17-2: 既定は Peripheral | スマホが GATT サーバ | ✅ **確定**（下記 C18-2） |
| C17-1: UUID | FFD0 / FFD1 / FFD2 / CCCD | ✅ 4 つすべて電波上に出現 |
| C16: HOMEID | `D2 04 00 00` | ✅ **平文で確認** |
| C16: パスワード | `35 36 37 38`（"5678"） | ✅ **平文で確認** |
| C3: ADV_PHONE | `C0 FF 05` + HOMEID | ✅ HOMEID = **1234** をデコード |
| C6: PDU フォーマット | `03 \| dst \| ch \| src \| MSGID \| data` | ✅ **完全一致** |
| C15-3: 一斉操作のチャネル | ブロードキャストは 0x2A | ✅ 一斉操作で 0x2A を確認 |
| C15-4: サブコマンド方式 | `0xC0` の `[11]` がサブ | ✅ `00 32 32 ...` を確認 |
| C15-7: ON/OFF | ON=55 / OFF=50 | ✅ **`37 37` / `32 32` を確認** |
| I1: 再送がない | 1 コマンド 1 回 | ✅ **各コマンドが 1 回だけ**（下記 C18-5） |
| PLTCEOC-05 | 型番（未確認だった） | ✅ **GATT で平文取得**（下記 C18-6） |

#### C18-2. ⭐ スマホは GATT サーバ（Peripheral）で動いていた

ATT 操作の方向がすべてを決めた。

| 方向 | オペコード | 件数 |
| --- | --- | --- |
| **スマホ → 器具** | Handle Value Notification | **38** |
| **器具 → スマホ** | Write Command | **16** |
| 器具 → スマホ | Read By Group Type Request | 8 |
| **スマホ → 器具** | Read By Group Type Response | 8 |
| 器具 → スマホ | Exchange MTU Request | 2 |
| スマホ → 器具 | Exchange MTU Response | 2 |

**器具がスマホに接続してきて、スマホの GATT データベースを探索している。**
`0000ffd0` / `ffd1` / `ffd2` / CCCD は**スマホが公開**していた（探索応答の送信元がスマホ）。

つまり `join_mode = 1`（Peripheral）で動作。**C17-2 の「既定値は Peripheral」が実証された。**

⭐ **コマンドの送信経路は `Handle Value Notification`**（スマホ → 器具、FFD2 経由）。
`PlMeshPeripheral.sendBtData` が `notifyCharacteristicChanged` を使うため。
器具からの応答は `Write Command`（器具 → スマホ、FFD1 経由）。

なお同一接続内でスマホも `Read By Type Request` を送っており（4 件）、
**双方が client / server の両方を務めている。**

#### C18-3. ⭐⭐ 訂正：PDU は平文で流れている

C4 で「暗号化されているので HCI ログから PDU は読めない」と書いたが、**誤りだった。**

PDU タイプ（`pdu[0]`）ごとに暗号化の有無が違う。

| `pdu[0]` | 意味 | 暗号化 | 実測件数 |
| --- | --- | --- | --- |
| `0x01` | CMD | サブタイプ次第 | recv 12 |
| `0x02` | RESPONSE | サブタイプ次第 | sent 4 |
| **`0x03`** | **DATA_EVENT（照明制御）** | **なし＝平文** | **sent 32** |
| `0x06` | **未知（暗号化ラッパー）** | あり | recv 4 / sent 1 |

具体例。

```
# 器具 → スマホ（ログイン要求。0x19 = PERIPHERAL_LOGIN）
01 19 F3 37 07 C9 9D ED 00 16 56 17 8F A2 D7 52 03 8E   ← 16 バイトは暗号化/乱数

# 器具 → スマホ（0x00 = GET_PASSWORD）★ HOMEID が平文
01 00 D2 04 00 00

# スマホ → 器具（応答）★ HOMEID + パスワード "5678" が平文
02 00 D2 04 00 00 35 36 37 38

# 以下 4 つはすべて 器具 → スマホ（参加完了時に器具がまとめて push してくる）
01 01                             # WELCOME
01 18 0C 00                       # CMD 0x18（MeshService に定数がない）
01 0A 09 00 00 00                 # ★ GET_VIRTUAL_ADDR — 器具がスマホに vAddr を割り当てる
01 02 A6 28 80 7F C5 EC 02 00     # BROADCAST_MESHINFO — [8][9] から device_num = 2

# 暗号化されている PDU（type 0x06）
06 FF FF FF FF FE B3 9D C6 D8 FA 66 92 AA 83 0F 96 16 BF E5 68 2B
```

⭐ **own_vAddr は器具から割り当てられる。** スマホが決めるのではない。
`MeshCommon.process_mesh_cmd` の `case 10` が
`System.arraycopy(bArr, 2, MeshService.own_vAddr, 0, 4)` で受け取っている。
→ 自作実装でも「参加してから vAddr をもらう」順序になる。

⭐ **パスワードが平文で流れる。** `02 00 <HOMEID 4 バイト> <パスワード ASCII 4 バイト>`。
C16 の結論（HOMEID = `D2 04 00 00` / パスワード = `35 36 37 38`）が電波上で完全に一致した。

**これは実装方針を大きく変える。** → 「実装方針への影響」節を参照。

#### C18-4. ⭐ 照明制御コマンドの実測ダンプ

利用者が実施した操作がそのまま読める。フォーマットは C6 / C15 の通り。

```
+141.1s >> dst=FF FF FF FF ch=0x20 src=09 00 00 00 MSGID=0xC1 data=37 37 00×6 00
+145.6s >> dst=FF FF FF FF ch=0x20 src=09 00 00 00 MSGID=0xC1 data=32 32 00×6 00
+149.4s >> dst=FF FF FF FF ch=0x20 src=09 00 00 00 MSGID=0xC1 data=37 37 00×6 00
```

- `0x37` = 55 = **ON**、`0x32` = 50 = **OFF** → **C15-7 が完全に一致**
- `[19]`（末尾）= グループ番号。前半は `00`、172 秒以降は `01` → **2 グループを操作**
- `src = 09 00 00 00` は `GET_VIRTUAL_ADDR` で得た own_vAddr と一致

連続変更の操作（5 段ずつ）。

```
+155.5s〜158.5s  data = 00 12 → 00 11 → 00 10 → 00 0F → 00 0E → 00 0D   （第 2 バイトが 18→13）
+161.6s〜164.7s  data = 01 0D → 02 0D → 03 0D → 04 0D → 05 0D           （第 1 バイトが 1→5）
```

✅ **確定（利用者が「明るさを先に変えた」と証言。UI の呼び出し元と一致）**

```java
// LinearControllerFragment2.java:1285 / MapControllerFragment2.java:793 など
ControllerAct.sendgroup_new(group_id, color / 5, bright != 0 ? (100 - bright) / 5 : 19);
//                                    └─ data[0]  └─ data[1]
```

| バイト | 意味 | コマンドの式 | 逆算 |
| --- | --- | --- | --- |
| `data[0]` | **色温度** | `color / 5` | `color% = data[0] * 5` |
| `data[1]` | **明るさ（逆順）** | `bright != 0 ? (100 - bright) / 5 : 19` | `bright% = 100 - data[1] * 5` |

⭐ **コマンドと状態応答でエンコーディングが完全に同一**。
C15-9 の応答デコード（`color = data[5] * 5` / `bright = 100 - data[6] * 5`）と
同じ式が使われている。**送った値をそのまま照合できる**ので、
収束判定（P2 / P4）の実装が単純になる。

実測値を意味に戻すとこうなる。

| 実測 | 意味 |
| --- | --- |
| `00 12` → `00 0D` | 色温度 0% 固定、**明るさ 10% → 35%**（5 段上げた） |
| `01 0D` → `05 0D` | 明るさ 35% 固定、**色温度 5% → 25%**（5 段上げた） |

- `data[1] = 0` → 明るさ 100%、`data[1] = 19` → **消灯（`bright == 0` の特別値）**
- `data[0]` の範囲は 0〜20（`COLOR = {1..21}` に対応）
- ON/OFF の `55` / `50` はこの 0〜20 の範囲外。**値域外を状態コードに使っている**

UI は 2 次元パッド（`BluetoothControlView.getReal_x()` / `getReal_y()`）で、
**X 軸が色温度、Y 軸が明るさ**。`sendgroup_new(group, real_x, real_y)` として渡る。

一斉操作（最後の 3 件）。

```
+186.5s >> dst=FF FF FF FF ch=0x2A src=09 00 00 00 MSGID=0xC0 data=00 32 32 00 00 00 00
```

**チャネルが `0x2A`** に切り替わり、MSGID が個別用の `0xC0`、
`data[0] = 0` がサブコマンド（明るさ + 色温度）。
→ **C15-3（ブロードキャストは 0x2A）と C15-4（サブコマンド方式）が同時に実証。**

#### C18-5. ✅ I1 の実証：再送していない

上のダンプの通り、**各コマンドは 1 回しか送られていない**
（141.1s / 145.6s / 149.4s と、操作ごとに 1 発）。
到達確認も再送もない。**[03-instability.md](analysis/03-instability.md) の I1 が実測で裏付けられた。**

一方、**I1 の当初の予測「アドバタイズを数百 ms で止めている」は外れ**。
実測のアドバタイズ継続時間は **21〜95 秒（中央 36.8 秒）** で、出しっぱなしだった。
`createAdvSettings` が `setTimeout(0)`（無期限）を指定していることと整合する。
アドバタイズはコマンド送信ではなく参加ビーコンなので、
I1 の検証対象は ATT の書き込み回数が正しかった。

#### C18-6. ✅ PLTCEOC-05 の正体

PLAN.md に記載されていた `PLTCEOC-05` が、**GATT の characteristic 値として平文で読めた。**

```
#496 ACL recv  ... 09 15 12 00 50 4C 54 43 45 4F 43 2D 30 35 00 00 ...
                  │  │  └─ handle 0x0012
                  │  └─ item length 21
                  └─ ATT Read By Type Response
                     value = "PLTCEOC-05" + ゼロ埋め（19 バイト）
```

スマホが**受信**しているので、**器具（の Pairlink モジュール）が公開している型番**。
伊藤電機のページに現在掲載がない旧品番だが、実機で使われていることが確認できた。
→ 問い合わせ（052-935-5633）の必要はなくなった。

#### C18-7. その他の観察

- **拡張アドバタイズを使用**。`LE Set Extended Advertising Data`(0x2037) /
  `Enable`(0x2039) であり、レガシー（0x2008 / 0x200A）ではない
- **スマホの MAC はランダマイズされている**（`19:7D:AB:00:EE:05`、
  `LE Set Random Address` が 1 件）。器具側から見た識別子は毎回変わる
- **`0xFD57` のベンダー固有コマンドが 294 件** — チップベンダーのスキャンオフロード。
  解析対象外
- MTU 交換が行われている。`Handle Value Notification` は最大 **22 バイト**
  （PDU 20 バイト + α）まで観測された
- **未知の識別子**
  - `pdu[0] = 0x06` — 暗号化ラッパー（`MeshService` に定数がない）
  - `pdu[1] = 0x18`（CMD 24）— `MeshService` に定数がない
  - `MSGID = 0xD0` — `MeshProfile` に定義がない（`data = 01`、接続直後に 1 回）
- **受信アドバタイズが 0 件**。`btsnooz` はフィルタ有効
  （`INIT_gd_hal_snoop_logger_filtering = true`）でスキャン結果を除外する。
  器具のビーコンや `ADV_CONNECTABLE` を見るには
  開発者オプションのスヌープログを有効にして再採取する必要がある

### C19. ⭐⭐⭐ Raspberry Pi でメッシュ参加に成功（2026-07-25）

**純正アプリも `.so` も使わず、Raspberry Pi 3 から自前実装でメッシュに参加できた。**
実装は `docs/analysis/tools/mesh_peripheral.py`。

#### C19-1. 成功した参加シーケンス（実測）

```
[Pi]  GATT サーバ（FFD0 / FFD1 / FFD2）を公開 + ADV_PHONE ビーコン送信
        ↓
[器具] Pi に GATT 接続 → FFD2 を購読（StartNotify）
        ↓
器具 → Pi:  01 19 34 AE E3 B5 A9 8C F2 E6 58 82 8D FF 61 62 A9 89
            PERIPHERAL_LOGIN（16 バイト・毎回変わる）
            ★ ここで応答してはいけない（下記 C19-2）
        ↓
器具 → Pi:  01 00 D2 04 00 00                       GET_PASSWORD（HOMEID を提示）
Pi → 器具:  02 00 D2 04 00 00 35 36 37 38           ★ 平文パスワードで応答
        ↓
器具 → Pi:  01 01                                    ★ WELCOME（認証成功）
器具 → Pi:  01 0A 15 00 00 00                        ★ own_vAddr = 15 00 00 00 を割り当て
器具 → Pi:  01 02 A6 28 80 7F C5 EC 02 00            device_num = 2
```

**認証は「`GET_PASSWORD` に平文パスワードを返すだけ」。** 暗号処理は一切不要。

#### C19-2. ⭐⭐ `PERIPHERAL_LOGIN` には応答してはいけない

**これが最大の発見。**

| `0x19` への対応 | 結果 |
| --- | --- |
| チャレンジをエコーバック（`02 19 <同じ 16 バイト>`） | ❌ **`StopNotify` → 切断**（12 回すべて失敗） |
| **応答しない** | ✅ **`WELCOME` → 参加成功** |

チャレンジは接続ごとに異なる乱数で、純正アプリは `.so` で応答を計算している
（C18-3 の実機ログでは応答値がチャレンジと無相関）。
しかし**誤った応答を返すと拒否される一方、無応答なら通る。**

→ **`.so` の暗号解析は不要。案 D（完全自前実装）が成立する。**

**[推測]** `0x19` は必須ではない拡張（バージョン交換や高速再接続用のトークン）で、
未対応のコントローラは無応答でよい設計になっているのだろう。
逆に応答を返すなら正しくなければならない。

#### C19-3. 器具の実測情報

| 項目 | 値 |
| --- | --- |
| 器具の MAC | `EC:C5:7F:81:DE:CD` / `EC:C5:7F:80:28:A6` |
| OUI | **`EC:C5:7F`** |
| 台数 | 2（`device_num = 2` と一致） |
| Pi に割り当てられた vAddr | `15 00 00 00`（実行ごとに変わる。スマホのときは `09 00 00 00`） |
| `BROADCAST_MESHINFO` の body | `A6 28 80 7F C5 EC 02 00` |

⚠️ **OUI は `API_get_mesh_homeid_from_scan` の判定値（`00:95:69` / `F0:AC:D7`）と一致しない。**
あの関数はスキャンで器具を探す経路のもので、この器具は該当しない。
→ [C16-4](#c16-4-アドバタイズから-homeid-を読み取る実装) の OUI は
**この環境の器具には当てはまらない**ので、MAC での判定に依存しないこと。

`BROADCAST_MESHINFO` の body 先頭 6 バイト `A6 28 80 7F C5 EC` を逆順にすると
`EC:C5:7F:80:28:A6` — **もう 1 台の器具の MAC**。
つまりこのフィールドは「メッシュの代表器具の MAC」+ 台数と読める **[推測]**。

#### C19-4. ⭐ 器具は普段アドバタイズしていない

Pi で 43 秒スキャンして LE デバイス 19 台・アドバタイズ 103 件を受信したが、
**Pairlink 形式は 0 件**だった（Company ID は 0x055A / 0x0006 / 0x004C など無関係）。

**器具は「スキャンする側」で、コントローラが `ADV_PHONE` を出すのを待っている。**
したがって受動スキャンで器具を発見することはできない。
自作アプリも「まずアドバタイズして待つ」設計にする必要がある。

⚠️ **接続は間欠的。** 実測では 90 秒間に 12 回接続してきた時間帯と、
150 秒間まったく接続してこない時間帯があった。
器具側にスキャンのデューティ比とバックオフがあると考えられる **[要検証]**。

#### C19-6. ⭐⭐⭐ 照明の制御に成功（2026-07-25）

**自前実装から照明を点灯・消灯させることに成功した。**
利用者による目視確認: 「いちど消えて点灯しました」。

送信したバイト列（`ON → OFF → ON` を各 3 回）。

```
点灯: 03 FF FF FF FF 20 25 00 00 00 C1 37 37 00 00 00 00 00 00 00
消灯: 03 FF FF FF FF 20 25 00 00 00 C1 32 32 00 00 00 00 00 00 00
      │  └─ dst      │  └─ src     │  └─ 0x37=55=ON / 0x32=50=OFF
      └─ DATA_EVENT  └─ ch 0x20    └─ MSGID 0xC1 (BRIGHT_LIGHT_GROUP)
```

純正アプリの実機ログ（C18-4）と**src の vAddr 以外は完全に同一**。

```
純正: 03 FF FF FF FF 20 09 00 00 00 C1 37 37 00 00 00 00 00 00 00
自作: 03 FF FF FF FF 20 25 00 00 00 C1 37 37 00 00 00 00 00 00 00
```

**これで案 D（完全自前実装）が完全に実証された。**
`libnative-lib.so`・Pairlink SDK・純正アプリのコードは一切不要。

#### C19-7. ⭐ 器具はコントローラのアドレスを記憶している

参加に成功した後、**同じアドレスでは器具が接続してこなくなった**。

| 実行 | 広告アドレス | 器具の接続 |
| --- | --- | --- |
| 1〜2 回目 | 公開 `B8:27:EB:FF:16:47` | ✅ 12 回 / 2 回（参加成功） |
| 3〜5 回目 | 公開（同じ） | ❌ **0 回**（50 / 150 / 300 秒） |
| 6 回目 | ランダム `C7:69:D4:E9:28:5D` | ✅ **1.9 秒で接続** |
| 7 回目 | ランダム `CF:22:DB:B2:2E:90` | ✅ **2.1 秒で接続** |

**アドレスを変えた途端に接続が復活した。**
器具は一度扱ったコントローラのアドレスを記憶し、
一定期間は再接続を試みない設計と考えられる **[推測]**。

純正アプリも `LE Set Random Address` でランダムアドレスを使っている（C18-7）ので、
**自作アプリでもランダムアドレスにすべき**。

⚠️ **ただしこれは「登録済みコントローラ 4 台まで」という仕様
（[01-findings.md](analysis/01-findings.md)）を消費している可能性がある。**
毎回新しいアドレスで参加し続けると枠を食い潰す恐れがあるので、
**実運用ではアドレスを固定して使い回す**設計にすべき **[要検証]**。

#### C19-8. ⭐⭐ `SET_LINK` (`01 10`) が接続維持の鍵

当初、参加完了から数秒で切断されていた。
純正アプリの実機ログと比べると**唯一の差分**が見つかった。

```
+129523.8ms << 01 02 A6 28 80 7F C5 EC 02 00   参加完了（BROADCAST_MESHINFO）
+129526.7ms >> 01 10                            ★ SET_LINK — 自作実装は送っていなかった
   （以降 +190 秒まで接続が継続）
```

**参加完了の直後に `01 10` を送るようにしたら、接続が維持されるようになった。**

| SET_LINK | 接続の生存時間 |
| --- | --- |
| 送らない | 数秒で切断 |
| **送る** | ✅ **87.9 秒継続（実行時間いっぱい）** |

→ **これでレイテンシ問題が解決する。**
接続を維持できれば、コマンド送信は GATT の Notify 1 回分（実測 1 ms）で済む。
常駐させれば**操作から反応まで実質ゼロ遅延**になり、
純正アプリの起動 7 秒とは比較にならない。

**自作実装の必須シーケンス（確定版）**

```
1. ランダムアドレスを設定して ADV_PHONE を広告
2. 器具の接続を待つ
3. PERIPHERAL_LOGIN (01 19) → 応答しない
4. GET_PASSWORD (01 00) → 02 00 <HOMEID> <パスワード> で応答
5. WELCOME (01 01) / GET_VIRTUAL_ADDR (01 0A) / BROADCAST_MESHINFO (01 02) を受信
6. ★ SET_LINK (01 10) を送る          ← これを忘れると切断される
7. 以降 DATA_EVENT でコマンドを送る（接続は維持される）
```

#### C19-5. ⚠️ BlueZ の D-Bus アドバタイズは使えない（Pi 3）

Raspberry Pi 3（BT 4.1）+ カーネル 6.18 + BlueZ 5.82 の組み合わせでは、
**`LEAdvertisingManager1.RegisterAdvertisement` が必ず失敗する。**

```
src/advertising.c:add_client_complete() Failed to add advertisement: Invalid Parameters (0x0d)
```

原因は `SupportedInstances = 0`。mgmt の `Add Advertising` が
インスタンス番号を検証して弾いている。
プロパティを 8 通り試したが（Manufacturer Data なし・Company ID 変更・
`broadcast` 型・データ長短縮など）**すべて失敗**したので、
Company ID `0x0000` は原因ではない。

**回避策: raw HCI で直接叩く。**

```bash
btmgmt advertising off                                  # カーネル側の広告を止める
hcitool -i hci0 cmd 0x08 0x0006 a0 00 a0 00 00 00 00 00 00 00 00 00 00 07 00
hcitool -i hci0 cmd 0x08 0x0008 14 02 01 06 10 ff 00 00 c0 ff 05 d2 04 00 00 <MAC 6 バイト> 00...
hcitool -i hci0 cmd 0x08 0x000a 01
```

- `0x2006` LE Set Advertising Parameters（interval 0x00A0 = 100ms、`ADV_IND`）
- `0x2008` LE Set Advertising Data（significant_length + 31 バイト固定）
- `0x200A` LE Set Advertising Enable

**GATT サーバの D-Bus 登録（`GattManager1`）は問題なく動く。**
アドバタイズだけ raw HCI にすればよい。
`ADV_IND` は接続確立で自動停止するので、**定期的に `Enable 01` を再送する**必要がある。

### C20. ⚠️⚠️ 器具からのデータ応答は暗号化される（状態取得の壁）

> ✅ **この壁は C23 で完全に突破した。** 復号鍵は器具が接続直後に平文で渡してくる。
> 応答が来なかったのは暗号のせいではなく `SET_LINK` の誤送信のせいだった（C23-6）。
> 以下は当時の記録として残す。

**送信は平文で通るが、器具からのデータ応答は暗号化されて返る。** この非対称性が
状態取得を阻んでいる。

#### C20-1. 実測

自作実装（Pi）で探索コマンドを送っても**応答が一切来ない**。

```
>> 03 FF FF FF FF FE 25 00 00 00        Ping（API_ping_all と同一）        → 無応答
>> 03 FF FF FF FF 20 25 00 00 00 02     get_product_id（MSGID 0x02）      → 無応答
>> 03 FF FF FF FF 20 25 00 00 00 D0 01  get_group_id（MSGID 0xD0）        → 無応答
>> 03 FF FF FF FF 20 25 00 00 00 70     状態要求（MSGID 0x70）            → 無応答
```

受信できた PDU は**参加時の `type 0x01` だけ**（5 件）。
`type 0x03`（DATA_EVENT）も `type 0x06` も 1 件も来ない。

#### C20-2. 純正アプリのログを見ると答えが書いてあった

受信 PDU をタイプ別に数えると、**器具からのデータ応答はすべて `type 0x06`**。

| 方向 | タイプ | 件数 |
| --- | --- | --- |
| 器具 → スマホ | `0x01`（CMD・**平文**） | 12 |
| 器具 → スマホ | **`0x06`（暗号化）** | **4** |
| スマホ → 器具 | `0x03`（DATA_EVENT・**平文**） | 32 |
| スマホ → 器具 | `0x06`（暗号化） | 1 |

**`recv type=0x03` は 1 件もない。** 器具は平文の DATA_EVENT を返さない。

対応関係も追える。

```
+129372.3ms >> 06 FF FF FF FF FE B3 9D C6 ...   暗号化された Ping
+129409.9ms << 06 09 00 00 00 FF E3 FA 4F ...   ★ 応答（暗号化）
+129454.9ms << 06 09 00 00 00 FF D3 96 9E ...   ★ 応答（暗号化）

+135467.0ms >> 03 FF FF FF FF 20 09 00 00 00 D0 01   get_group_id（平文）
+135500.4ms << 06 09 00 00 00 24 7A C0 29 ...   ★ 応答（暗号化）
+135530.6ms << 06 09 00 00 00 24 94 72 28 ...   ★ 応答（暗号化）
```

**平文で送った `D0 01` にも、応答は暗号化されて返っている。**

`MeshCommon.processMeshPDU` は受信を必ず `processData()`（JNI）に通してから
`bArrProcessData[0]` で分岐する。つまり
**電波上は `0x06`、復号後に `0x01` / `0x02` / `0x03` になる**構造。

#### C20-3. できること / できないこと

| 項目 | 状況 |
| --- | --- |
| 照明の制御（点灯・消灯・調光・調色） | ✅ **平文で送れる。実証済み** |
| メッシュへの参加・認証 | ✅ 平文（`type 0x01`） |
| 接続してきた器具の MAC | ✅ **D-Bus のデバイスパスから取得できる** |
| メッシュ内の器具台数 | ✅ `BROADCAST_MESHINFO` から取得（平文） |
| **器具の現在状態（明るさ・色温度・ON/OFF）** | ❌ **暗号化されていて読めない** |
| 器具ごとの vAddr / 製品コード / グループ ID | ❌ 同上 |

→ 状態は**送ったコマンドからの楽観的更新**に留まる。
リモコンや壁スイッチでの変更は検知できない。

#### C20-4. 状態取得を実現する選択肢

| 案 | 内容 | 難易度 |
| --- | --- | --- |
| **F** | **Frida で Android の `processData` をフック**し、暗号文と平文のペアを収集してアルゴリズムを特定 | 中 |
| G | `libnative-lib.so`（arm64 / 100 KB）を逆アセンブルして復号を自前実装 | 高 |
| H | Android 端末に復号ヘルパーを常駐させ、Pi から委譲する | 中（構成が複雑） |
| I | 楽観的状態のみで運用（現状） | 済 |

**推奨は案 F。** `setHomeidPassword` で鍵が設定され、`processData(mac, data, len)` が
復号するので、この 2 つをフックすれば鍵とアルゴリズムの手がかりが直接得られる。
`.so` の静的解析（案 G）より確実で速い。

⚠️ ただし**照明を制御する目的は既に達成している**（C19-6）。
状態取得は「リモコンで変えられたときに追従する」ための機能なので、
優先度は用途次第。

### C21. ⭐ `libnative-lib.so` の静的解析（2026-07-25）

`artifacts/so/lib/arm64-v8a/libnative-lib.so`（arm64 / 100 KB）を
`capstone` + `lief`（`docs/analysis/tools/disasm.py`）で解析した。**シンボルは全て残っている。**

#### C21-1. 暗号関数のマップ

| 関数 | 役割 |
| --- | --- |
| `setHomeidPassword` | 鍵導出。GOT に AES コンテキストを 2 つ作る |
| `mesh_encrypt` | 送信データの暗号化（`type 03 → 06`） |
| `encry_data_handle` | 受信データの復号（`type 06`） |
| `aes_set_key` / `AES_ECB_encrypt` / `AES_ECB_decrypt` | AES 本体 |
| `AES_CMAC` / `mesh_k1` | メッシュ層の鍵導出・認証（SIG mesh に似た構造） |
| `uECC_*` | ECDH（P-256 等）。プロビジョニング（登録）時の鍵交換 |
| `bafang_encrypt` / `bafang_decrypt` | ODELIC 独自ラッパー（PKCS パディング + ECB） |
| `cmd_login_with_pwd_encry` / `response_getpwd` | ログイン応答の計算 |

#### C21-2. ⭐⭐ 鍵導出アルゴリズム（完全解明）

`setHomeidPassword(homeid[4], password[4])` の逆アセンブルから、
**2 つの AES-128 鍵**が作られることが判明した。

```
鍵 = [ homeid[0], pwd[0], homeid[1], pwd[1],
       homeid[2], pwd[2], homeid[3], pwd[3] ] + サフィックス(8 バイト)

鍵1（コマンド用）: サフィックス = "LOGINKEY" (4C 4F 47 49 4E 4B 45 59)
鍵2（イベント用）: サフィックス = "EVENTKEY" (45 56 45 4E 54 4B 45 59)
```

HOMEID とパスワードを**1 バイトずつ交互に**並べ、後半 8 バイトに固定文字列を付ける。
現在の ID `12345678` なら:

```
鍵1 = D2 35 04 36 00 37 00 38  4C 4F 47 49 4E 4B 45 59   ("...LOGINKEY")
鍵2 = D2 35 04 36 00 37 00 38  45 56 45 4E 54 4B 45 59   ("...EVENTKEY")
     └ homeid/pwd インターリーブ ┘ └ 固定サフィックス ┘
```

- 鍵1 は GOT `0xf88` に `aes_set_key` される → `cmd_login_with_pwd_encry` / `sendEncry`
- 鍵2 は GOT `0xff0` に `aes_set_key` される → `mesh_encrypt` / `encry_data_handle`

`aes_set_key(ctx, key, 0x80)` の `0x80` = **128 bit**。

#### C21-3. 送受信の構造

`mesh_encrypt`（送信）:

```
out[0..5] = pdu[0..5] だが out[0] を 0x06 に書き換え（03→06 が暗号化マーカー）
payload = pdu[6..]（長さ len-6）を 16 の倍数にパディング（PKCS 風）
out[6..] = AES_ECB_encrypt(鍵2, payload)
```

`encry_data_handle`（受信）:

```
先頭で XOR ホワイトニング（テーブル引き）
AES_ECB_decrypt(鍵, data+0x0A, out, len-10)
その後 AES_CMAC / mesh_k1 でメッシュ層の検証
```

#### C21-4. ⚠️ AES が標準実装ではない

**送信した Ping は平文が既知**（`03 FF FF FF FF FE 09 00 00 00`）で、
その暗号文（`B3 9D C6 D8 ...`）も実機ログにある。
標準 AES-128-ECB で鍵1・鍵2・各種パディングを総当たりしたが、**再現しなかった。**

→ `aes_set_key` / `AES_ECB_encrypt` は独自実装
（S-box かラウンド処理が標準と違う可能性）。
`aes_set_key` の鍵スケジュールは Rcon テーブルを使う標準的な形に見えたが、
S-box までは未検証。加えて `mesh_encrypt` は GOT `0xfc8` のフラグで
鍵と出力レイアウトが分岐しており、実機がどちらを通ったかも要確認。

#### C21-5. 状態取得を完成させる最短ルート

暗号アルゴリズムをバイト単位で再現するのは手間が大きい。
**`.so` はエクスポート関数が揃っているので、直接呼ぶのが速い。**

| 案 | 内容 | 見込み |
| --- | --- | --- |
| **J** | **Pi（aarch64）で `.so` を `ctypes` で dlopen し、`AES_ECB_decrypt` 等を直接呼ぶ** | ◎ ABI 互換。`liblog.so` のスタブだけ用意すればよい |
| F | Frida で Android の `processData` の in/out を採取 | ◎ 確実 |
| K | `AES_ECB_encrypt` / `aes_set_key` の S-box を精読して自前実装 | △ 手間大 |

**推奨は案 J。** `.so` は arm64、Pi も aarch64 なので命令セットは同じ。
依存は `liblog.so`（`__android_log_print`）だけが Android 固有なので、
その 1 関数をスタブした共有ライブラリを `LD_PRELOAD` すれば dlopen できる可能性が高い。
これなら独自 AES でも正しい結果が得られる。

⚠️ ただし**照明の制御は既に達成済み**（C19）。状態取得は
「リモコンで変えられたときに追従する」ための機能なので、優先度は用途次第。

---

### C22. ⭐⭐ 暗号アルゴリズムの解明（2026-07-25、粘着解析）

`.so` を capstone で精読し、Pi で dlopen して検証した結果、暗号処理を大きく解明した。

#### C22-1. ✅ 送信暗号化を完全再現（実機ログと一致）

`.so` の `mesh_encrypt` を Pi で直接呼び、送信 Ping を再現したところ
**実機ログの送信データとバイト単位で一致**した。

```
入力（平文 PDU）: 03 FF FF FF FF FE 09 00 00 00
mesh_encrypt 出力: 06 FF FF FF FF FE B3 9D C6 D8 FA 66 92 AA 83 0F 96 16 BF E5 68 2B
実機ログ sent     : 06 FF FF FF FF FE B3 9D C6 D8 FA 66 92 AA 83 0F 96 16 BF E5 68 2B  ✅
```

**送信手順（Python で再現可能）**:

```
1. out[0..5] = pdu[0..5]、ただし out[0] = 0x06（0x03→0x06 が暗号化マーカー）
2. payload = pdu[6..] を 16 の倍数に「ゼロパディング」
   （.so の cipher を復号したら 09 00 00 00 00×12 だった＝ゼロ埋め）
3. out[6..] = AES_128_ECB_encrypt(EVENTKEY, payload)
```

⚠️ **重要な落とし穴**: `ctypes` で鍵やデータを渡すとき `c_char_p` は使えない。
鍵（`FF 33 26 39 00 ...`）もデータも `0x00` を含み、NUL 終端で切られる。
`c_void_p` + `create_string_buffer` を使う。これが検証成功の鍵だった。

#### C22-2. ✅ AES は標準 AES-128

`.so` の `AES_ECB_decrypt` を dlopen して呼んだ結果、
Python の `cryptography`（標準 AES-128-ECB）と一致。独自 S-box ではなかった。

#### C22-3. XOR ホワイトニング構造（受信）

`encry_data_handle`（受信復号）の XOR ループを 1 命令ずつ解析。
`w9 = (w8-6) % 4`、鍵バイト = `device_entry[6 + (i%4)]`。
device エントリは MAC(6) + vaddr(4) なので、
**XOR 鍵 = 送信元器具の vaddr（4 バイト）の繰り返し**。

#### C22-4. ⚠️ 受信復号の鍵は「動的な鍵階層」

受信復号の鍵は 3 経路ある（`[0xfc8]` = `g_variable_password_len` フラグで分岐）。

| フラグ | 鍵 | 対象 |
| --- | --- | --- |
| 0（`setHomeidPassword`） | EVENTKEY | data+6, len-6 |
| ≠0（`setHomeidVariablePassword`） | **event_key_list[送信元 vaddr] の個別鍵** | data+10 |
| ≠0 かつ未登録 | 固定鍵 `g_fixed_event_key` | data+10 |

`setHomeidVariablePassword` は `mesh_k1`（SIG mesh の k1 導出）で
**homeid/pwd から器具ごとの event key を導出**して `event_key_list` に登録する。

#### C22-5. ⚠️ 純静的再現の壁：ランタイム鍵状態

受信状態の復号には、以下の**動的に構築される値**が必要:

- 各器具の **vaddr**（XOR 鍵 + event_key_list のインデックス）
- **event_key_list の個別鍵**（`mesh_k1` で導出され、参加時に構築）

これらは `.data` の固定値ではなく、**メッシュ参加シーケンス中に導出・構築される**。
特に器具の vaddr は暗号化された応答の中にあり、
「復号するのに vaddr が要る／vaddr を知るには復号が要る」という循環になる。
純正アプリはプロビジョニング（ECDH、初回登録）で vaddr と鍵を確立し、
ローカル DB（ORMLite）に永続化している。

**器具 MAC を既知平文とした攻撃も試みたが、[v0,0,0,0]・[v0,v1,0,0] の
総当たりでは復号結果に器具 MAC が現れず、vaddr は単純な形式ではなかった。**

#### C22-6. 受信状態取得を完成させる残る手段

| 案 | 内容 | 評価 |
| --- | --- | --- |
| **M** | 純正アプリのローカル DB（`/data/data/.../databases`）から器具 vaddr と鍵を読む | 器具の vaddr が一発で判る。root か run-as が要る |
| N | 参加シーケンスを `.so` 上で完全再現（`processData` を JNIEnv 偽装で呼び、内部状態を構築してから `encry_data_handle`） | 大。JNIEnv エミュレーションが必要 |
| F | Frida で純正アプリの `processData` の in/out やランタイム鍵をダンプ | 確実。実機必要 |
| O | プロビジョニング（ECDH 登録）を自前実装 | 最大。器具の初期化（壁スイッチ）も要る |

**純静的解析での受信復号の完全再現は、鍵階層が動的に構築されるため、
プロビジョニング全体の再現（案 O）まで踏み込む必要がある。**
一方、**送信は完全に解明・再現できた**（C22-1）。

⚠️ **この結論は C23 で覆った。** 鍵は動的だが、**器具が接続直後に平文で渡してくる**。
案 M〜O のどれも不要だった。

### C23. ⭐⭐⭐ 受信復号を完全に解明（2026-07-25）

C22 では「XOR ホワイトニング鍵（器具の 4 バイト）が判らない」ことが壁だった。
**答えは `cmd_handle` の `PERIPHERAL_LOGIN` 処理にあった。**
器具は接続直後に、その鍵を自分から送ってきていた。

検証ツール: `python docs/analysis/tools/decrypt_recv.py <btsnoop ログ> <8 桁 ID>`

#### C23-1. ⭐⭐ 鍵は `PERIPHERAL_LOGIN` の中に入っていた

`cmd_handle`（0x40bc）の逆アセンブル。

```
msgid == 0x19 && len == 0x10:
    aes_decrypt_block(ctx@0xf88 = LOGINKEY, out = sp+0x34, in = data)
    if out[0..3] != [0xf60]（HOMEID） → 認証失敗（戻り値 4）
    device エントリを登録:
        entry[0..5] = 送信元 MAC
        entry[6..9] = out[4..7]        ★ これが XOR ホワイトニング鍵
```

`encry_data_handle` は device エントリを MAC で `memcmp` 検索し、
`entry[6 + (i-6)%4]` を XOR 鍵に使う（C22-3 の 4 バイトの正体）。
つまり **XOR 鍵 = ログイン要求を LOGINKEY で復号した bytes 4..7**。

実機ログ（`01 19` + 16 バイト）を復号した結果。

```
<< 01 19 F3 37 07 C9 9D ED 00 16 56 17 8F A2 D7 52 03 8E
   復号 → D2 04 00 00 | F6 C2 B4 8D | 08 08 08 08 08 08 08 08
          └ HOMEID ┘   └ ★XOR 鍵 ┘   └ PKCS#7 パディング ┘
```

- `[0..3]` が HOMEID と一致する → **これが認証そのもの**（ID が違えば弾かれる）
- `[4..7]` は毎接続ランダム。**vAddr ではなかった**
  → C22-5 で「vAddr を総当たり」しても当たらなかったのはこのため
- 鍵は **GATT リンク単位**（接続してきた器具ごと）。メッシュ全体で共通ではない

#### C23-2. ⭐ ログイン応答も再現できた（C19-2 の訂正）

同じ `cmd_handle` が応答を組み立てている。

```
02 19 + AES_ECB_encrypt(LOGINKEY, HOMEID(4) + パスワード(4) + 鍵(4) + 04 04 04 04)
```

実機ログの応答 2 件と**バイト単位で一致**した。

```
>> 02 19 85 E2 14 14 AE 30 30 14 20 4A CC A6 22 21 D6 9C   ← 再現一致 ✅
>> 02 19 7C 04 C5 AC F5 6B 65 7A A0 2D 21 7B 2D 5D E3 3E   ← 再現一致 ✅
```

⚠️ **C19-2 の「`0x19` には応答してはいけない」は誤りだった。**
切断されていたのは**エコーバックという誤答**をしていたためで、
正しい応答なら器具は受理する。Pi で実測して確認した。

```
[187.716] << 01 19 84 4C 12 02 CD A3 BC A6 FD 91 E2 69 50 C9 F7 AD
[187.734] ★ ログイン要求を復号: EC:C5:7F:81:DE:CD の鍵 = 55 25 D5 46
[187.736] >> 02 19 0D 40 76 C3 D3 53 D2 0A 33 49 B0 B6 94 6C 19 98
[187.859] << 01 01                        ← WELCOME。切断されない ✅
[187.863] ★ 参加完了（器具 2 台）
```

#### C23-3. 受信復号の手順（確定）

`encry_data_handle`（0x4510）の再現。

```
1. ヘッダ 6 バイト（type + dst 4 + チャネル）はそのまま
2. for i in 6..len-1:  data[i] ^= link_key[(i-6) % 4]
3. AES_ECB_decrypt(EVENTKEY, data[6..])      ※ len-6 は 16 の倍数
4. 復号結果の最終バイト = パディング長。0x10 を超えていたら復号失敗
   （`AES_ECB_decrypt` は 0x10 超で 0 を返す。⭐ 誤鍵の判定に使える）
5. 平文 PDU = 0x03 + 元ヘッダ[1..5] + 本体（パディングを除く）
```

実機ログの暗号化 PDU **4 件すべてが復号できた**。

#### C23-4. 復号できた中身 — 器具の MAC・vAddr・グループが読めた

```
<< 03 09 00 00 00 FF | A6 28 80 7F C5 EC | 01 00 00 00 | C0 52 | 01 07
   Ping 応答: MAC EC:C5:7F:80:28:A6  vAddr 1  機種 0x52C0  ファーム 1.7
<< 03 09 00 00 00 FF | CD DE 81 7F C5 EC | 05 00 00 00 | C0 52 | 01 07
   Ping 応答: MAC EC:C5:7F:81:DE:CD  vAddr 5  機種 0x52C0  ファーム 1.7

<< 03 09 00 00 00 24 | 01 00 00 00 | D7 | 11 00 00 00 00 00 00 01 00
   グループ応答: src vAddr 1  → グループ ID 1
<< 03 09 00 00 00 24 | 05 00 00 00 | D7 | 11 00 00 00 00 00 00 00 00
   グループ応答: src vAddr 5  → グループ ID 0
```

- **器具の vAddr が判明**（1 と 5）→ 個別制御（`dev:` 指定）と状態要求が可能になる
- グループが 0 と 1 に分かれている実測と一致（PLAN.md の「複数デバイス対応」の裏付け）
- Ping 応答のレイアウトは `MeshCommon.GetPingResponse` と一致。
  `[16..17]` は**バージョンではなく機種コード**（`DeviceBean.version_product`）で、
  ファームは `[18].[19]`

#### C23-5. ⚠️ 送信暗号化の訂正（C22-1 の手順記述は誤っていた）

C22-1 は `.so` の `mesh_encrypt` を直接呼んで一致させたため、
**手順の記述が 2 か所ずれていた**。実際は次のとおり（実機ログの Ping で検算済み）。

| C22-1 の記述 | 正しい内容 |
| --- | --- |
| ゼロパディング | **PKCS#7**（パディング長の値を詰める。16 の倍数なら 0x10 を 16 個） |
| XOR なし | **AES の後に XOR ホワイトニング**（`sendEncry` が `mesh_encrypt` の外でやっている） |

```
送信: 本体 = pdu[6..] + PKCS#7 → AES_ECB_encrypt(EVENTKEY) → XOR(link_key)
      → 0x06 + 元ヘッダ[1..5] + それ
受信: その逆順
```

検算（実機ログの送信 Ping）:

```
平文 03 FF FF FF FF FE 09 00 00 00
  → 本体 09 00 00 00 + 0C×12（PKCS#7）
  → AES(EVENTKEY) → XOR(F6 C2 B4 8D)
再現 06 FF FF FF FF FE B3 9D C6 D8 FA 66 92 AA 83 0F 96 16 BF E5 68 2B
実機 06 FF FF FF FF FE B3 9D C6 D8 FA 66 92 AA 83 0F 96 16 BF E5 68 2B  ✅
```

`mesh_encrypt` 自体は XOR をしない。XOR は `sendEncry` が
**宛先 MAC で device エントリを引いて**適用する。
つまり暗号化 PDU は**その器具しか復号できない**（鍵が器具ごとなので）。

#### C23-6. ⭐⭐⭐ 器具が応答を返さなかった真因は `SET_LINK` だった

暗号を解いても、当初は**器具がそもそも応答を返さなかった**。
純正アプリのコードを読み比べて原因が判明した。

`PlMeshPeripheral.onCharacteristicWriteRequest` の分岐。

```java
if (!"".equals(meshDevAddrStr) && !meshDevAddrStr.equals(dev.getAddress())
        && isInBackupDevList(dev)) {
    // 2 台目以降 = バックアップリンク
    if (b == 1 && bArr[1] == 1) {                  // WELCOME
        byte[] bArr3 = {1, 16};                    // ★ 01 10 = SET_LINK
        sendPacket(bArr3, dev, 0);
        return;                                     // processMeshPDU に流さない
    }
}
processMeshPDU(bArr, dev);   // 主リンクはこちら。SET_LINK は送らない
```

⚠️ **`SET_LINK` は「2 台目以降のバックアップリンク」にだけ返すもの**だった。
`odelicd` は参加のたびに全器具へ送っていたため、
**器具から見て「主リンクではない予備の接続」に見えていた** → 応答が来ない。

`SET_LINK` を送るのをやめたら、その場で応答が返るようになった。

| 送ったもの | 応答 |
| --- | --- |
| 暗号化 Ping（チャネル 0xFE） | ✅ 器具 2 台の MAC + vAddr + 機種 + ファーム |
| 平文 `0xD0 01`（グループ要求） | ✅ チャネル 0x24 で `0xD7` 応答 |
| 平文 `0x70`（状態要求） | ✅ **チャネル 0x27 で `0x71` 応答** |

また **C19-8 の「SET_LINK を送らないと数秒で切断される」も誤りだった。**
切断の真因は `PERIPHERAL_LOGIN` に応答していなかったこと（C23-2）。
正しいログイン応答を返すようにしたら、`SET_LINK` なしでリンクは安定して続く。

#### C23-7. 状態応答（`0x71`）を実機で確認

```
>> 03 05 00 00 00 20 35 00 00 00 70                       状態要求（器具 vAddr 5 宛）
<< 06 35 00 00 00 27 FE BC C9 3D AF 5B 33 45 44 77 26 ...
   ↓復号 03 35 00 00 00 27 | 05 00 00 00 | 71 | 32 32 03 00 00 00 00 00
                             └ src vAddr ┘  └ ┘  └ 色温度・明るさ ┘
```

- 応答チャネルは **0x27**（要求 0x20 → 応答 0x27）
- `32 32` = ON/OFF の特別値（`0x32` = OFF）→ 消灯中と判定
- 点灯中は素直にコードが入る。**指示値と一致することを確認した**

| 指示 | 器具が返した状態 |
| --- | --- |
| `bright=60&color=50` | `on=true bright=60 color=50` ✅ |
| `off` | `on=false` ✅ |

C15-9 の換算式（色温度 = コード × 5、明るさ = 100 − コード × 5）が
**実機の状態応答で裏付けられた**。コマンドと状態応答でエンコーディングは同一。

#### C23-8. 状態要求の送り方（実測で総当たり）

`0x70` の宛先とチャネルを変えて応答を比べた。

| 宛先 / チャネル | 結果 |
| --- | --- |
| 器具の vAddr / `0x20` | ✅ その器具が応答 |
| **`FF FF FF FF` / `0x20`** | ⭐ **1 通で全器具が応答する**（最も効率が良い） |
| `FF FF FF FF` / `0x2A` | ❌ **無応答**（一斉制御のチャネルでは状態を返さない） |
| `FF FF FF FF` / `0xFE`（暗号化） | ❌ 無応答 |
| 暗号化した `0x70`（器具宛） | ✅ 応答（平文と同じ） |

- `0x70` にパラメータ（`70 01`）を付けても応答は変わらない
- `0x73`（`STATUS_LC615`）・`0x77`（`STATUS_RGB2`）を要求として投げても**無応答**。
  この 2 つは `MeshProfile` に定義があるだけで、**純正アプリも送っていない**
- 純正アプリが送る状態要求は **`0x70` の 1 種類だけ**（`ControllerAct.get_light_status`）

→ `odelicd` は `FF FF FF FF` / `0x20` の 1 通に変更した（従来は器具ごとに送っていた）。

→ 実施記録は [06-raspberrypi-setup.md](06-raspberrypi-setup.md) の P6

### C24. ナイトライト（常夜灯）の仕様（2026-07-25）

`ControllerAct` と `MainController.onNightCallback` から確定した。

#### C24-1. レベルは 0 / 1 / 2 の 3 段階

```java
int i = lightItem.night_status;
if (lightItem.night_status == 2) lightItem.night_status = 0;
else                             lightItem.night_status++;
```

純正アプリはボタンを押すたびに **0 → 1 → 2 → 0** と巡回させている。
**ON / OFF ではなく 3 段階の明るさ**で、`0` が最も明るい。

#### C24-2. 器具の型で 2 つの経路に分かれる

| 器具 | 判定 | 送るもの |
| --- | --- | --- |
| **天井灯タイプ** | `UtilDeviceFW.isCeilingLight()` = true | **専用ナイトライト**（下記） |
| それ以外 | false | `setlight(vAddr, 0, level + 17, 0)` = **明るさコード 17/18/19 で代用** |

`isCeilingLight()` が true になる製品コード（⚠️ **2026-07-26 に訂正・追記**）:

```
0x04〜0x0A, 0x25, 0x26, 0x2B, 0x40〜0x43, 0x4B〜0x53,
0x60, 0x63〜0x66, 0x6B, 0x6D, 0x6E, 0x71, 0x75, 0x76, 0x78〜0x7D, 0x80
```

⚠️ **以前ここに書いていた一覧は不完全だった。**単独比較（`b == ...`）だけを拾っていて、
`switch` の 4 グループ（`0x40`〜`0x43` / `0x4B`〜`0x53` / `0x63`〜`0x66` / `0x78`〜`0x7D`）が
漏れていた。上が逆コンパイル結果の全体。
→ 実装は [`common/src/capability.ts`](../common/src/capability.ts)、
テストは [`test/capability.test.ts`](../common/test/capability.test.ts)。

⭐ **手元の器具は `0x2B` なので専用ナイトライトに対応している**（C23-4 で判明）。

### ⭐ 器具の能力を判定する述語（`UtilDeviceFW`）

ナイトライト以外にも、Matter 化などで「この器具は何ができるのか」を知る必要がある。
`UtilDeviceFW` に述語が揃っていた（値は逆コンパイル結果から転記）。

| 述語 | true になる製品コード | 意味 |
| --- | --- | --- |
| `isOnlyLightness` | `0x8A`, `0x91` **の 2 つだけ** | 調光のみ（色温度を持たない） |
| `isInterface` | `0x1D`, `0x88` | 照明ではない |
| `isRGB` / `isCeilingSideRGB` | `0x18`, `0x19`, `0x56`, `0x57` | サイド RGB を持つ |
| `isCeilingSideSpot` | `0x16`, `0x17`, `0x54`, `0x55` | スポットを持つ |

⭐ **`isOnlyLightness` が 2 コードしかない** = 実質すべての器具が調光調色。
「未知の製品コードは調光調色として扱う」という既定が妥当だと分かる。

⚠️ **C15-8 の `CFormat.getLinearFormatCodeBy` の 4 系統（調光のみ / ON-OFF のみ /
調光+色 / 調光調色）はメッシュ照明には使われていない。**あれは `ProductorCode` enum
（C15-10 の LC シリーズ）で分岐する別系統。メッシュ照明の明るさ・色温度は
`color/5` と `(100-bright)/5` の直接計算（C18-4）。

代用経路の明るさコード 17 / 18 / 19 は C15-9 の換算で **15% / 10% / 5%**。
つまり非対応機では「一番暗い 3 段階」で常夜灯を演じているだけ。

#### C24-3. PDU のレイアウト

```java
// setlight_night(vAddr, level)  — 個別 / 一斉
msgdata = own(4) + {0xC0, 1, 0, level, 0, 0, 0, 0}
   dst = 器具の vAddr → チャネル 0x20
   dst = FF FF FF FF   → チャネル 0x2A       ★ 一斉はこちら

// sendgroup_night(group, level, 0xC5)  — グループ単位
msgdata = own(4) + {0xC5, 0, level, 0,0,0,0,0,0, group}
   dst = FF FF FF FF / チャネル 0x20
```

`0xC0` のサブコマンド 1（C15-4）で、レベルは**明るさと同じ位置 `[7]`** に入る。
グループ版 `0xC5` は C15-5 の共通レイアウト（`[6]` = レベル、`[13]` = グループ番号）。

`send_groupBit_night(groupBitBean, level, 0xC5)` を使うと
`[7..12]` のビットマップで**複数グループを一度に**指定できる。

#### C24-4. `odelicd` の対応 ✅ 実機で点灯を確認

```bash
curl -X POST 'http://odelic-pi:8080/night?level=0'              # 一番明るい常夜灯
curl -X POST 'http://odelic-pi:8080/night?level=2'              # 一番暗い
curl -X POST 'http://odelic-pi:8080/night?level=1&target=group:0'
curl -X POST 'http://odelic-pi:8080/night?level=1&target=dev:05000000'
```

`?target=all`（`0xC0` サブコマンド 1・チャネル 0x2A）で
**実機の常夜灯に切り替わることを目視確認した**（2026-07-25）。

#### C24-5. ⭐⭐ 常夜灯の状態は `0x71` 応答の `data[7]` に入っている

当初「読み戻せない」と判断したが、**それは比較の基準を間違えていた**。
基準にした「消灯時」のデータが、実は**常夜灯が点いたままの状態**だった。

状態を 1 つずつ切り替えながら計測し直したところ、`data[7]` が動いた。

| 状態 | 送ったコマンド | 状態応答 `71 <色> <明> <[7]>` |
| --- | --- | --- |
| 完全消灯 | `C0 00 32 32` | `71 32 32` **`00`** |
| 常夜灯 level 2（最も暗い） | `C0 01 00 02` | `71 32 32` **`01`** |
| 常夜灯 level 1 | `C0 01 00 01` | `71 32 32` **`02`** |
| 常夜灯 level 0（最も明るい） | `C0 01 00 00` | `71 32 32` **`03`** |
| 通常点灯 60% / 50% | `C0 00 0A 08` | `71 0A 08` **`00`** |

- **`data[7]` = 常夜灯の明るさ。`0` = 消灯、`1`〜`3`（`3` が最も明るい）**
- **コマンドのレベルとは逆順**（明るさコードと同じ流儀）→ `[7] = 3 - level`
- 主灯が点いていれば `[7] = 0`（常夜灯は消える）。両方同時には点かない
- `level = 3` を送ると**最も明るい段に飽和**した（`3 - (level mod 3)` と整合）。
  常夜灯を消すのは通常の消灯コマンド（`C0 00 32 32`）

⚠️ **純正アプリはこのバイトを読んでいない。**
`MeshBlePresenter.syncState()` は `data[5]`（色温度）と `data[6]`（明るさ）だけを見て、
`data[7]` 以降は読み捨てる。常夜灯は `LightItem.night_status` という
ローカルのカウンタを 0 → 1 → 2 と巡回させるだけ。
**つまり自前実装は純正アプリより正確に状態を追える。**

#### C24-6. 自発イベントは飛んでこない

状態を切り替えた直後の受信を観測したが、器具からの**自発的な状態通知はなかった**。
状態は `0x70` で要求して初めて返る（ポーリングが必要）。

`odelicd` は `night`（器具が返す 0〜3）と `night_level`（コマンドの尺度）の
両方を `/devices` に出す。

### C25. 器具ファームウェア（APK 同梱 OTA）の解析可能性（2026-07-25）

`assets/ota/*.mp3` は音声ではなく器具のファームウェア。
**器具側から解析できないか**を評価した。→ ツール: `docs/analysis/tools/fw_analyze.py`

#### C25-1. 同梱されているもの

20 ファイル・各 29〜33 KB。名前は **`<version_product>_<major>_<minor>.mp3`**
（`OtaBean` / `OtaUtil` の照合ロジックより。`version_product` は
Ping 応答の `[16..17]` = C23-4 の「機種コード」と同じ値）。

```
4_2_0  5_2_0  6_2_0  7_2_0  8_2_0  9_2_0  10_2_0  11_2_0  12_2_0  13_2_0
14_2_0  18_2_0  19_2_0  20_2_0  21_2_0  37_2_0  38_2_0
20292_4_5  20307_4_11  20308_3_5
```

⚠️ **手元の器具は `21184`（0x52C0）fw 1.7 なので該当ファイルがない。**
この APK で更新できる器具ではなかった。

#### C25-2. 暗号化はされていない（が、そのままでは逆アセンブルできない）

| 観点 | 結果 |
| --- | --- |
| 暗号化 | ❌ されていない。**文字列が平文で読める** |
| 内容 | BLE スタック入り（`Enc info: LTK` / `master id` / `pairing method, Both Input` / `adv data` / `sensor in` / **`Mouselet`**） |
| エントロピー | 6.96 bit/byte（8.0 ではない = 暗号化ではない） |
| Thumb コードか | ❌ **違う。** 2 バイト境界の `push {..,lr}` が 0.14%、`BL` が 0.42% しかない（本物なら数 %） |
| 標準の圧縮か | ❌ zlib / gzip / lzma / LZ4 いずれも展開できない |

⭐ `Mouselet` は `MeshCommon.GetPingResponse` が
`setDeviceName("Mouselet")` としているのと一致する。**中身は確かにこの器具のもの**。

→ **独自コンテナ（LZ 系の圧縮か差分パッチ）**。文字列だけが平文で残るのは
リテラル区間をそのまま持つ LZ 系の特徴。

`OtaUpgrader_pairlink` は**ファイルを 20 バイトずつそのまま書き込むだけ**で
（`sendCommand(1, サイズ)` → データ → CRC32）、**アプリ側に展開処理がない**。
つまり展開するのは器具のブートローダで、その仕様はアプリからは判らない。

#### C25-3. 評価：優先度は低い

| 項目 | 評価 |
| --- | --- |
| 得られるもの | 残る未解読（CMD `0x18`、`0x71` の `data[8..12]`、MSGID `0x65`）の確定 |
| 前提コスト | **独自コンテナの解析が先に必要**（ゼロからのリバース） |
| 手元の器具との一致 | ❌ 該当バージョンのファイルがない |
| 代替手段 | ⭐ **電波での総当たり**（C23-8 / C24-5）。同じ答えが数分で出ている |

**残っている未解読は「純正アプリも使っていないフィールド」だけ**なので、
ファームウェア解析に踏み込む動機は現時点では小さい。
必要になったら「独自コンテナの解析」から始める（`docs/analysis/tools/fw_analyze.py` が入口）。

### C26. ⭐⭐ ベンダー公式仕様書との突き合わせ（2026-07-25）

伊藤電機（Pairlink モジュールの国内代理店）が仕様書を公開していた。
→ <https://ito-elec.jp/ble/>

| 資料 | 内容 |
| --- | --- |
| `PLTBEITO_独自メッシュ_UARTコマンド仕様書_V1.2.pdf` | ⭐ **「Multilink UART Protocol」**（Suzhou Pairlink Network Technology Ltd.） |
| `PLTBEITO_モジュール_データシート_V1.7.pdf` | モジュールの電気的仕様・搭載チップ |
| `PLTBEITO_SIGmesh_UARTコマンド仕様書` / `シングルモード…` | 別モード（今回は無関係） |

「独自メッシュ」= **Multi-link protocol** が今回のプロトコル。
器具が GATT で名乗る `PLTCEOC-05` も同じ Pairlink モジュール系。

⚠️ この仕様書は **MCU ↔ モジュール間の UART API** であって、
電波上のフォーマットそのものではない。それでも
**モジュールが外に見せる概念が完全に一致**しており、解析結果の裏付けになった。

#### C26-1. ⭐ PDU の構造がそのまま書かれていた

```
Send User Data[0x05]      MCU → モジュール（メッシュへ送信）
    Virtual Address (4)  … 宛先。0xFFFFFFFF = ブロードキャスト
    Channel         (1)  … 0〜31
    Data            (n)  … ユーザーデータ

User Data[0x05]（イベント） モジュール → MCU（メッシュから受信）
    Channel         (1)
    Virtual address (4)  … ★ 送信元
    Data            (n)
```

これは私たちが解析した PDU と**完全に一致**する。

```
03 <宛先 vAddr 4> <チャネル 1> | <送信元 vAddr 4> <MSGID> <パラメータ…>
   └────── Send User Data ─────┘ └──── 受信イベントの中身と同じ並び ────┘
```

⭐ **復号後の本体が「送信元 vAddr → データ」で始まる理由がこれで確定した**（C23-3 / C23-4）。

#### C26-2. チャネルは 0〜31。電波上は `0x20 | ch`

仕様書は「Channel: 0〜31」と明記し、`Register Data Channel[0x04]` は
**32 bit のビットマスク**で受信したいチャネルを選ぶ。
仕様書のフローチャート例:

```
77 01 05 04 01 01 01 01 77   ← マスク 0x01010101 = bit 0/8/16/24 を登録
77 04 0a 05 08 03 00 00 00 11 22 33 44 33
                └ ch 8  └ 送信元 vAddr 3  └ データ 11 22 33 44
```

→ 電波上のチャネルバイトは `0x20 + ch`（C8-2）。
アプリの `i + 32` 登録ループと辻褄が合う。

#### C26-3. その他の一致・新情報

| 仕様書の項目 | 解析結果との対応 |
| --- | --- |
| `Mesh Status[0x03]` イベント（`Device Number in mesh`） | `BROADCAST_MESHINFO`（`01 02` + MAC + 台数）と同じ情報 |
| `Enable Discoverable mode[0x01]`（1〜255 秒） | 器具の登録モード。C19-7 の「アドバタイズ 21〜95 秒」と整合 |
| `Set IDs[0x03]` = **companyID / productID** | Ping 応答の機種コード（`0x52C0`）の出どころ候補 |
| ⭐ `Check Data Route[0x07]` → `Data Route[0x07]` イベント | **中継経路（vAddr の並び）が取れる。** メッシュのトポロジ診断に使える未活用の機能 |
| `Bypass User Data[0x06]` | 登録モード中の素通しデータ |
| エラーコード `ERR_NONE`/`LENGTH`/`INVALID`/`UNKNOWN_CMD`/`OFFLINE` | `MESH_RESPONSE_*`（C9 の応答コード）と同じ並び |

#### C26-4. ⚠️ 仕様書に**書かれていない**もの

- **HOMEID / パスワード**（`Set IDs` は companyID/productID で別物）
- **暗号化**（LOGINKEY / EVENTKEY / XOR ホワイトニング）
- **照明制御のコマンド**（`0xC0` 系。これは ODELIC の「ユーザーデータ」の中身）
- GATT のサービス構成・`PERIPHERAL_LOGIN` の中身

→ これらは MCU から見えない層（モジュール内部）か、逆に上位のアプリ層。
**C16〜C24 の解析結果が唯一の資料**である状態は変わらない。

#### C26-5. データシートから判った搭載チップ

| 項目 | 内容 |
| --- | --- |
| コア | **ARM Cortex-M4** |
| Bluetooth | **5**（Cypress 独自の 2 Mbps データレートにも対応） |
| Flash | **外付け 8 Mbit SPI フラッシュ**（サイズは選択可） |
| クリスタル | 24 MHz |
| インタフェース | **PUART** + **HCI UART** + SPI + I2C など |
| 対応プロトコル | SIG Mesh と **Multi-link**（= 独自メッシュ） |

「Cypress 独自 2 Mbps」「PUART / HCI UART」という言い回しは
**Cypress（現 Infineon）CYW207xx 系**の特徴。**Cortex-M4 なので Thumb-2**。

→ C25 の「OTA イメージは Thumb コードとして読めない」という測定と合わせると、
**やはり圧縮または差分**である。ただし `BRCM` / `WICED` / `CYW` の署名も
レコード長のチェーン構造も見つからず、素の WICED OTA イメージでもなかった。

### C27. ⭐⭐ 器具側の GATT データベース（2026-07-25）

Pi は Peripheral だが、**同じリンク上で GATT クライアントにもなれる**。
BlueZ が器具側のサービスを解決済みだったので、D-Bus から全部読めた（読み取りのみ・非破壊）。
→ ツール: `docs/analysis/tools/gattdump.py`

器具 2 台（`EC:C5:7F:80:28:A6` / `EC:C5:7F:81:DE:CD`）で内容は同一。アドレス種別は **public**。

| サービス | キャラクタリスティック | 内容 |
| --- | --- | --- |
| `1800` Generic Access | `2A00` [read] | **`PLTCEOC-05`** ← C18-6 を直接確認 |
| `1801` Generic Attribute | — | — |
| **`9e5d1e47-5c13-43a0-8635-82adffc0386f`** | `…ffc1386f` [write] / `…ffc2386f` [read,notify] | ⭐ **Pairlink メッシュサービス（器具側）**。SDK の `Util.UUID_SERVICE` / `UUID_WRITE` / `UUID_NOTIFY` と完全一致 → **Central モードでスマホが繋ぐ先**（C17-2） |
| **`ae5d1e47-5c13-43a0-8635-82ad38a1381f`** | `a3dd50bf-…661b` [write,notify,indicate] | OTA 制御ポイント |
| | `a2e86c7a-…fe26` [write-without-response,write] | OTA データ |
| | **`a47f7608-…de4b` [read]** | ⭐⭐ **`C0 52 01 07`** = 機種 `0x52C0` + ファーム `1.7` |
| `88121427-11e2-52a2-4615-ff00dec16800` | `…16801` [write-without-response,write,notify] | ⚠️ **不明。APK 内に一切登場しない** |
| `88121427-11e2-52a2-4615-ff00dec16900` | `…16901` / `…16902` 同上 | ⚠️ 同上 |

#### C27-1. ⭐ 機種とファームはメッシュに参加せずに読める

`a47f7608-…de4b` を read するだけで **`C0 52 01 07`** が返る。
これは Ping 応答の `[16..19]`（C23-4）と**同一の 4 バイト**。

→ 器具の識別に**メッシュ参加も HOMEID も不要**。GATT で接続して 1 回読むだけ。
（ただし器具は普段アドバタイズしないので、接続してきた相手に対して使う）

#### C27-2. 純正アプリの OTA UUID は「1 世代違い」だった

`OtaUpgrader_pairlink` が持つ定数と、器具が実際に公開している UUID を比べると
**先頭バイトと末尾の 1 桁だけが違う**。

| 用途 | 純正アプリの定数 | 器具の実物 |
| --- | --- | --- |
| OTA サービス | `9e5d1e47-…-82ad38a1386f` | `ae5d1e47-…-82ad38a1381f` |
| 制御ポイント | `e3dd50bf-…-570a086c666b` | `a3dd50bf-…-570a086c661b` |
| データ | `92e86c7a-…-2409e72efe36` | `a2e86c7a-…-2409e72efe26` |
| FW 情報（`UUID_MOUSELET_FW_INFO`） | `347f7608-…-75d4edc4de3b` | `a47f7608-…-75d4edc4de4b` |

→ **この APK の OTA 機能は手元の器具には使えない**。
C25 で「機種 21184 向けのイメージが同梱されていない」ことと符合する。

#### C27-3. ⭐ OTA は Cypress WICED の手順そのもの

`OtaUpgrader_pairlink` の送信手順は WICED の OTA コマンドと一致する。

| アプリの動作 | WICED OTA の定義 |
| --- | --- |
| `sendCommand(1, サイズ)` | `PREPARE_DOWNLOAD` |
| `sendCommand(2, サイズ)` | `DOWNLOAD`（この後データを 20 バイトずつ） |
| 最後に CRC32 | `VERIFY` |

データシートの「Cypress 独自 2 Mbps」「PUART / HCI UART」「Cortex-M4」（C26-5）と合わせて、
**プラットフォームは Cypress（現 Infineon）WICED / CYW207xx 系で確定**。

→ C25 の「独自コンテナ」は、**WICED のアップグレードイメージ形式**である可能性が高い。
ゼロからのリバースではなく「公開されている形式の解析」に格下げできる。

#### C27-4. ⚠️ 未使用の未知サービスがある

`88121427-11e2-52a2-4615-ff00dec16800` / `…16900` は
**純正アプリのどこからも参照されていない**（`grep` で APK 全体を確認）。
write + notify を持つので何らかの機能があるが、**書き込みは器具の状態を壊しうる**。
調べるとしても read 可能な属性がないため、当面は触らない方針とする。

### C28. ⭐⭐⭐ 他コントローラの操作は平文で観測できる（2026-07-25 実験 B）

**器具は状態変化を自発通知しない**（C24-6）。では他の人がアプリで操作したら
追従できないのか——を実機で確かめた。

実験: Pi をメッシュに参加させたまま、**純正アプリ（Android）で操作**して
Pi が何を受信するか記録した。

#### C28-1. 結果: コマンドがそのまま中継されてくる

```
1896.993 << 03 FF FF FF FF 20 25 00 00 00 C1 37 37 00 00 00 00 00 00 01   点灯（グループ1）
1896.994 << （同じ PDU が重複）                                             ★ 中継による二重配送
1898.5〜1900.8 << C1 00 12 → C1 00 03 まで 16 連射（2.3 秒）                明るさスライダー
1903.517 << 03 FF FF FF FF 20 25 00 00 00 C1 32 32 ... 01                  消灯
1906.622 << 03 FF FF FF FF 20 25 00 00 00 C5 00 01 ... 01                  ナイトライト level 1
```

- **PDU タイプ `0x03`（平文）**。暗号化されていない
- `src vAddr = 25 00 00 00`（スマホの vAddr）→ **自分の vAddr と比べれば他人の操作と判る**
- 純正アプリは**グループ宛（`0xC1` / `0xC5`、末尾にグループ番号）**を使っていた
- ⚠️ **同じ PDU が二重に届く**（中継経路が複数あるため）→ 重複排除が必要
- ⚠️ **明るさスライダーは中間値を 16 通も連射**していた（約 143 ms 間隔・絞り込みなし）

#### C28-2. 観測結果と実際の状態が一致した

観測直後に状態要求を投げて突き合わせた。

| 純正アプリが送った PDU | 器具の実際の状態 |
| --- | --- |
| `C5 00 01 … 01`（グループ 1・level 1） | グループ 1 の器具が **`night=2` = level 1** ✅ |
| （グループ 0 には何も送っていない） | グループ 0 の器具は **`night=3` のまま** ✅ |

⭐ **C24（ナイトライト）と C15-5（グループレイアウト）が、
純正アプリの実トラフィックで独立に裏付けられた。**

#### C28-3. 共存も確認できた（実験 C 相当）

純正アプリが参加・操作している間も **Pi のリンクは切れなかった**
（`link_held_sec` = 1768 秒継続 / `join_count` = 1 / 復号失敗 0）。
**コントローラ 2 台の同時利用は問題ない。**

#### C28-4. 実装への反映

`odelicd` は他コントローラのコマンドを読んで状態に反映する。

```
MSGID 0xC0（サブ 0/1）/ 0xC1 / 0xC5 を受信し、src vAddr が自分でなければ
  → 値をデコードして対象の器具（グループ絞り込み）に反映
  → 1.5 秒後にまとめて状態要求を投げ、器具の応答で裏を取る（P4）
```

- コマンドの値域は状態応答と**同一**なのでそのまま流用できる（C18-4）
- ナイトライトだけ**コマンドと器具値が逆**（器具値 = 3 − レベル。C24-5）
- ⭐ **ナイトライトを点けると主灯は消える**（実測 `32 32 03`）ので、
  ナイト系コマンドを観測したら主灯を OFF にする
- 重複排除: 同一バイト列が 0.5 秒以内に再度来たら捨てる
- 連続操作では確認の状態要求は**最後の 1 回だけ**投げる（デバウンス）

→ **純正アプリより状態追従が正確になる。**
純正アプリは他コントローラの操作を `syncAllState`（`0xC0` / チャネル 0x2A）でしか
拾わないが、実際に飛んでいるのは `0xC1` / `0xC5`（グループ宛）なので**取りこぼす**。

### C29. ⭐⭐ 主リンク／バックアップリンクのライフサイクル（2026-07-25）

`PlMeshPeripheral` を読み切って、純正アプリの接続管理を完全に把握した。
C23-6 で判った「`SET_LINK` はバックアップ専用」の全体像がこれで繋がる。

#### C29-1. 接続してきた器具は**全部いったんバックアップ**になる

`onConnectionStateChange(newState = CONNECTED)`:

```java
// ⭐ OUI ホワイトリスト（scan_mac_check が有効なときだけ）
boolean skip = scan_mac_check
    && !addr.startsWith("F0:AC:D7") && !addr.startsWith("EC:C5:7F");
if (join_mode != 1 || skip) return;

if (!isInBackupDevList(dev)) {
    MeshBackupDevList.add(new MeshDevice(dev, device_type = 0));
    return;                       // ★ 新規接続は必ずバックアップとして登録
}
```

- `F0:AC:D7` はベンダー仕様書のフローチャートに出てくる Pairlink の OUI、
  `EC:C5:7F` は手元の器具の OUI（C29 の実測と一致）
- 既定では `scan_mac_check = false`（フィルタ無効）

#### C29-2. 昇格は WELCOME で起きる

| 状態 | 受信した書き込みの扱い |
| --- | --- |
| `meshDevAddrStr` が空（主リンク未定） | `processMeshPDU` に流す → **WELCOME で `handleWelcome`** → `meshDevAddrStr = MAC`、`remote_device` を設定、**`removeBackupDev()` で主リンクに昇格** |
| 既に主リンクがいて、別の器具から | **`SET_LINK` (`01 10`) を返してバックアップのまま**（C23-6）。`processMeshPDU` には流さない |

つまり `SET_LINK` は「お前はバックアップだ」という宣告。
**主リンクには絶対に送らない。**

#### C29-3. ⭐ 純正アプリは主リンク 1 本だけを残し、他を追い出す

`peripheral_stop_adv_after_welcome` は **Peripheral 参加時に必ず `true`**
（`MeshJoinMethod.runableJoinStart` / `API_auto_join_mesh`）。その結果:

```java
handleWelcome():
    if (peripheral_stop_adv_after_welcome) stopAdvertise();   // ★ 参加したら広告を止める

checkBackup（800 ms 周期）:
    if (MeshBackupDevList.isEmpty()) { postDelayed(startScan, 500); return; }
    for (dev in MeshBackupDevList)
        sendBtData(exit_cmd, dev);       // ★ exit_cmd = 01 15 55 で追い出す
    postDelayed(checkBackup, 800);
```

→ **参加後は広告を止め、余分に繋いできた器具は `01 15 55` で切る。**
アプリは常に「器具 1 台とだけ繋ぐ」設計。

⚠️ **`odelicd` は広告を出しっぱなしなので器具 2 台が繋がる。**
実測では問題なく動いており、片方が切れても残る冗長性がある。
ただし **同じ PDU が二重に届く**（C28-1）ので重複排除が必須（実装済み）。

#### C29-4. 切断時の後始末

主リンクが切れたときだけ全リセットが走る。

```java
if (meshDevAddrStr.equals(dev.getAddress())) {
    remote_device = null;  meshDevAddrStr = "";  connection_st = false;
    API_get_list().clear();          // 器具一覧を捨てる
    meshExited();                    // ネイティブ側の状態も破棄
    real_mtu = 20;                   // MTU も初期値へ
    clearQueue();
    for (dev in MeshBackupDevList) sendBtData(exit_cmd, dev);  // バックアップも全部切る
    API_scan_dev(false);
}
```

バックアップが切れた場合はリストから外すだけ（他は何もしない）。

#### C29-5. MTU は 217

実機ログの Exchange MTU: **器具が 217 を要求 → アプリが 517 で応答 → 217 で確定**。
`onMtuChanged` で `real_mtu = mtu - 3 = 214`。切断時は 20 に戻す。

→ **214 バイトまでは分割不要**。それを超えるものだけ C30 の分割になる。

### C30. ⚠️⚠️ 分割 PDU の実装が壊れている（不安定さの核心・C10 の詳細）

[03-instability.md](analysis/03-instability.md) の I7 / C10 で指摘した欠陥を、
コードレベルで完全に特定した。

#### C30-1. 書式と純正アプリの実装

```
04 04 <seq バイト> <断片…>
        └ 上位 4bit = 最終 seq / 下位 4bit = この seq（どちらも 1〜15）
```

⭐ **分割は復号より下の層**にある（`processMeshPDU` が `processData` の
**手前**で組み立てる）。つまり長い暗号化 PDU も分割されて届く。

```java
public byte[] processSegmentPDU(byte[] bArr) {
    int i  = bArr[2] & 15;          // この seq
    int i2 = (bArr[2] >> 4) & 15;   // 最終 seq
    if (i == this.current_seq + 1) {          // ★ 期待どおりのときだけ処理
        System.arraycopy(bArr, 3, this.segment_data, this.segment_data_offset, bArr.length - 3);
        this.segment_data_offset += bArr.length - 3;
        this.current_seq = i;
        if (i2 == i) {                        // 最終セグメント
            ...
            this.current_seq = 0;             // ← 成功時だけリセット
            this.segment_data_offset = 0;
            return 組み立て結果;
        }
    }
    return null;                              // ★ それ以外は黙って捨てる
}
```

#### C30-2. 欠陥は 5 つ

| # | 欠陥 | 帰結 |
| --- | --- | --- |
| **1** | ⭐⭐ **欠落しても状態をリセットしない。** `current_seq` は成功時のみ 0 に戻る | **1 個落ちると `current_seq` が途中の値で固まり、以降の分割転送が二度と完成しない**（次の転送の seq 1 は `current_seq+1` と一致しないので捨てられる）→ **永続的なデッドロック** |
| **2** | ⚠️ ただし `current_seq == 1` で固まった場合は、**次の転送の seq 2 が「期待どおり」として受理される** | 前の転送の残骸に別の転送の途中が連結され、**気付かれずに壊れたデータが上位層へ渡る** |
| **3** | バッファ長を検査していない（`segment_data` は **255 バイト固定**） | MTU 217（= 1 通 214 バイト）なので **2 セグメントで 428 バイト → `ArrayIndexOutOfBoundsException`**。BLE コールバックスレッドで例外 |
| **4** | タイムアウトがない | 途中で止まった転送が永久に居座る（欠陥 1 と合わさって復旧不能） |
| **5** | 送信元を区別していない（`MeshCommon` はシングルトン） | 器具が 2 台以上あると**別々の転送が同じバッファに混ざる** |

**欠陥 1 が「グループ設定が保存できず、その後は初期化しないと直らない」の正体**
（[03-instability.md](analysis/03-instability.md) I7）。アプリを再起動するか
`meshExited()` が走るまで、分割を伴う操作はすべて失敗し続ける。

#### C30-3. `odelicd` の実装（全部直した）

| 純正アプリ | `odelicd` |
| --- | --- |
| 欠落を黙って捨て、状態を残す | **欠落を検知したらログに出して即破棄** |
| `seq == 1` でも前回の残骸を使う | **`seq == 1` は常に新しい転送として作り直す** |
| 255 バイト固定・検査なし | **上限 4096 バイト。超えたら破棄** |
| タイムアウトなし | **3 秒** |
| 送信元を区別しない | **MAC ごとに独立した状態** |

検証（`odelicd` に実 PDU を流して確認）:

```
正常系 3 分割                     → ✅ 組立成功 → 通常の受信経路へ
1→(2 欠落)→3                      → ✅ 破棄。★直後の正常な転送は成功する
2 から始まる（先頭欠落）           → ✅ 破棄。★直後の正常な転送は成功する
上限超え（15 分割 × 400 バイト）   → ✅ 破棄。★直後の正常な転送は成功する
器具 2 台の転送が混在              → ✅ 独立して組み立て
```

⚠️ **手元の器具はまだ分割 PDU を送ってきていない**（214 バイトを超える応答がない）。
グループ設定や器具登録（フェーズ 7）で初めて出てくる可能性が高いので、
先に受信側を用意しておく。

### C31. ⭐⭐⭐ 器具が見ているのは「広告アドレス」だった（2026-07-25 実験）

C19-7 の「器具はコントローラのアドレスを記憶していて、同じアドレスでは
再接続してこない」を、**Android で広告アドレスを制御できない問題**と
突き合わせるために切り分けた。

#### C31-1. 純正アプリの AD の 6 バイトは端末の MAC ではない

`BleUtil.getBTMac(context)`:

```java
SharedPreferences sp = context.getSharedPreferences("ID", 0);
String s = sp.getString("mac", "");
if (!s.equals("")) return s;                 // ★ 保存済みならそれを使い続ける
// なければランダムな 17 文字の MAC 形式文字列を生成
while (i < 17) { i++; sb.append(i % 3 == 0 ? ":" : Integer.toHexString(rnd.nextInt(16))); }
sp.edit().putString("mac", sb.toString()).apply();   // ★ 永続化
```

**アプリが初回にランダム生成して永続化する「疑似 MAC」**だった。
実機ログでも AD の 6 バイト（`19 7D AB 00 EE 05`）は
実際の広告アドレス（`5A:4C:CF:54:34:CE`）と**一致しない**。

つまり AD には**アプリ層の安定した識別子**が入り、
BLE のアドレスは**別物として勝手に変わる**構造。

⚠️ `odelicd` は AD にも広告アドレスをそのまま入れていた（両者が連動していた）。
→ **独立させた**（`--ctrl-id-file` に永続化。純正アプリと同じ方針）。

#### C31-2. ⭐⭐ 切り分け実験 → **C19-7 の解釈が誤りだった**

回転を無効（`--rotate-after 0`）にして 3 条件を比べた。

| # | 広告アドレス | AD 識別子 | 古い ACL リンク | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 既知 | **新規** | **残っていた** | ❌ **330 秒待っても再接続なし** |
| 2 | **新規** | 既知 | 残っていた | ✅ 広告開始の **4.9 秒**後に接続 |
| 3 | **既知** | 新規 | **切断済み** | ✅ 広告開始の **5.2 秒**後に接続 |

#1 と #2 だけを見て「器具はアドレスで判定している」と結論しかけたが、
**#3 で覆った**。#1 と #3 の違いは古い ACL リンクの有無だけ。

⭐ **器具はアドレスも AD 識別子も記憶していない。**
再接続してこなかった真因は **BlueZ が残していた古い ACL リンク**だった（→ C32）。

→ C19-7 の「器具はコントローラのアドレスを記憶している」は**誤り**。
アドレスを変えると繋がったのは、器具から見て**別のデバイスとして新規接続できた**ためで、
本質は「既存のリンクが生きている間は再接続しない」という当然の挙動だった。

#### C31-3. Android のアドバタイズ設定（実機 HCI ログ）

純正アプリの広告は**拡張アドバタイズのセット #2**として出ていた。

```
拡張ADV set#2 パラメータ: props=0x0013（接続可・スキャン可・legacy）間隔 100.0〜131.2 ms
拡張ADV set#2 のランダムアドレス設定: 5A:4C:CF:54:34:CE      ← セット専用の RPA
拡張ADV set#2 データ(20B): 02 01 02 10 FF 00 00 C0 FF 05 D2 04 00 00 19 7D AB 00 EE 05
拡張ADV Enable=ON sets=[2]
```

コード（`MeshCommon.createAdvSettings` / `createAdvertiseData`）と一致する。

| 項目 | 値 |
| --- | --- |
| `setAdvertiseMode` | `2` = LOW_LATENCY → **実測 100〜131 ms** |
| `setConnectable` | `true` → props に接続可ビット |
| `setTimeout` | `0`（無期限） |
| `setTxPowerLevel` | `3` = HIGH |
| AD の magic | `C0 FF`。**MSGID 定数の流用**（`flow_control_enable` なら `C1 FF` になる） |
| Flags | **`0x02`**（`odelicd` は `0x06`。どちらでも器具は接続してくる） |

#### C31-4. ✅ Android のランダムアドレス問題は**存在しなかった**

| 懸念 | 結論 |
| --- | --- |
| Android は広告アドレスを固定できない | **固定する必要がない。** 器具はアドレスを見ていない（C31-2） |
| Android は広告アドレスを任意に変えられない | **変える必要がない** |
| RPA が約 15 分で自動更新される | 無害。器具は毎回ふつうに接続してくる |
| アプリ層の identity | AD の疑似 MAC を永続化すれば保たれる（C31-1）。Android でも当然できる |

⭐ Android 実装で本当に必要なのは
**「切断を検知したら確実にアドバタイズを再開する」**ことだけ。

参考: 同じログ内の Google 自身の広告セット（#0 / #1）は
`Enable=OFF → パラメータ設定 → 新しいランダムアドレス設定 → Enable=ON` を繰り返しており、
**広告セットを停止・再開するたびにアドレスが作り直される**。
純正アプリも参加のたびに `stopAdvertise(); sleep(100); startIBeaconAdvertise(...)` を
実行しているが、**その狙いはアドレス変更ではなく単なる広告の張り直し**だったと考えられる。

#### C31-5. `odelicd` への反映

- AD の識別子を `/var/lib/odelicd/ctrl_id` に永続化し、**広告アドレスと分離**
  （以前は回転のたびに識別子まで変わっていた）
- `--rotate-what {addr,id,both}` で何を変えるか選べる（既定 `addr`）
- **アドレス回転は本質的な対策ではなくなった**ので既定を 300 秒（最後の保険）に。
  本命は起動時の古いリンクの掃除（C32）
- `--id-from-addr` で従来動作（識別子にアドレスを流用）にも戻せる

### C32. ⭐⭐⭐ 再接続を阻んでいた真因は「古い ACL リンク」だった

**BlueZ はプロセスが終了しても LE の ACL リンクを保持し続ける。**
器具から見ると「まだ繋がっている」ので再接続してこず、
新しく起動したプロセスの GATT サーバには誰も購読に来ない。

実測（`hcitool con`）: デーモンを止めた後も
`LE EC:C5:7F:80:28:A6 handle 64 state 1 lm PERIPHERAL` が残っていた。

#### C32-1. 対策: 起動時に残っている接続を切る

```python
for path, ifaces in ObjectManager.GetManagedObjects().items():
    if ifaces.get("org.bluez.Device1", {}).get("Connected"):
        Device1(path).Disconnect()
```

#### C32-2. 効果

| | 修正前 | 修正後 |
| --- | --- | --- |
| 再起動から操作可能まで | **約 190 秒**（アドレス回転を待っていた） | **約 10 秒** |
| 必要な回避策 | 広告アドレスの回転 | 不要 |

⚠️ **このセッション中ずっと「再起動後 3 分待ち」だったのはこれが原因。**
C19-7 の「器具がアドレスを記憶している」という解釈も、これに引っ張られた誤りだった。

### C33. ⭐⭐⭐ 通信戦略の実測と最適化（2026-07-25）

「安定性とレスポンス」を実測で詰めた記録。**3 つの前提が覆り、
不安定さの真因がこちら側の実装にあったことが判った。**

計測は 2 系統。
`btmon -w` の HCI トレース（`python docs/analysis/tools/btsnoop.py conn` / `latency` で解析）と、
`odelicd` に組み込んだ内蔵計測（`GET /metrics`・`#M` 形式の journald ログ）。

#### C33-1. 接続パラメータの実測（初めて測った）

`LE Connection Complete` の中身。**器具ごとに違う値を指定してくる。**

| 器具 | interval | slave latency | supervision timeout |
| --- | --- | --- | --- |
| `EC:C5:7F:80:28:A6` | **15.00 ms**（0x000C） | 0 | 4000 ms |
| `EC:C5:7F:81:DE:CD` | **28.75 ms**（0x0017） | 0 | 4000 ms |

notify 1 通が電波に乗るまでの上限が `interval × (1 + latency)` なので、
**要求 → 応答の往復はこの 2 倍が下限**になる。

実測した ACL 送信 → `Number Of Completed Packets` のレイテンシは interval にほぼ比例した。

| リンクの interval | n | p50 | p90 |
| --- | --- | --- | --- |
| 15.00 ms | 765 | **39.9 ms** | 113.5 ms |
| 28.75 ms | 1223 | **86.0 ms** | 229.9 ms |
| 45.00 ms | 207 | 63.2 ms | **273.5 ms** |

#### C33-2. ⭐⭐ BlueZ が器具の選択を上書きして遅くしていた

```
< ACL Data TX: LE L2CAP: Connection Parameter Update Request (0x12)
        Min interval: 24    ← 30.00 ms
        Max interval: 40    ← 50.00 ms
> LE L2CAP: Connection Parameter Update Response: accepted (0x0000)
> HCI Event: LE Connection Update Complete: interval 45.00 msec (0x0024)
```

- CPUR 送信 **65 / 65 本**、器具は **65 / 65 で受理**、更新完了 **19 本 → すべて 45.00 ms**
- 送っているのは Linux カーネル（`l2cap_le_conn_ready()`）。条件は
  「Peripheral 役 かつ 実 interval が `[conn_min_interval, conn_max_interval]` の外」
- Pi の既定は `conn_min_interval = 24`（30 ms）／`conn_max_interval = 40`（50 ms）。
  器具の 15.00 / 28.75 ms はどちらも下限割れなので**必ず発火していた**

⭐ **対策は `conn_min_interval` を下げるだけ。**

```bash
echo 6 | sudo tee /sys/kernel/debug/bluetooth/hci0/conn_min_interval   # 7.5 ms
# 恒久化するなら /etc/bluetooth/main.conf の [LE] MinConnectionInterval=6
```

実測 interval が範囲内に入るので **CPUR そのものが出なくなり**、
器具の選んだ 15.00 / 28.75 ms が維持される。効果は `btsnoop.py conn` の
`CPUR` 列が空になることで確認できる。

| | 修正前 | 修正後 |
| --- | --- | --- |
| CPUR | 65 本すべて送信 | **0 本** |
| interval | 15/28.75 → **45.00 に劣化** | **劣化なし** |
| ACL p90 | 203.5 ms | 173.8 ms |
| ACL p99 | 316.8 ms | 264.5 ms |

#### C33-3. ⭐⭐⭐ 不安定さの真因は「広告を出し続けること」だった

`odelicd` は広告を出しっぱなしにして複数リンクを維持しようとしていた（C29-3 の
「純正アプリは参加後に広告を止める」を採用していなかった）。実測すると:

```
42923 ms  h=65 (28:A6) が接続
43648 ms  h=64 (DE:CD) が切断     ← 725 ms 後
44976 ms  h=64 (DE:CD) が再接続
46383 ms  h=65 (28:A6) が切断     ← 1407 ms 後
88759 ms  h=65 が接続 → 89532 ms  h=64 が切断（773 ms 後）
94714 ms  h=64 が接続 → 96029 ms  h=65 が切断（1315 ms 後）
```

⭐ **新しいリンクが確立すると、古いリンクが必ず 0.7〜1.4 秒後に切られる。完全な交互。**
切断理由は `0x13 Remote User Terminated`（器具側の意思）。

→ **メッシュは「コントローラ 1 台につきリンク 1 本」しか許さない。**
2 本目を迎えようとすると 1 本目を失う。広告を出し続けると
これが延々と繰り返され、**3 分間で 22 回の再参加**という状態になっていた。

| | 広告を出し続ける（旧） | 参加後に受け付けを止める（新） |
| --- | --- | --- |
| リンク寿命 p50 | **7〜14 秒** | **152 秒**（区切りは自分の再起動のみ） |
| 3 分間の再参加 | **22 回** | **0 回** |
| 切断理由 | 0x13 器具 36 / 0x08 電波断 24 / 0x16 自分 5 | **0x16 自分だけ**（器具は切っていない） |
| 同時リンク | 2 本（交互に切り合う） | 1 本 |

⚠️ **リンク 1 本でも器具 2 台とも制御・監視できる**（メッシュが中継する）。
実測で、接続していない器具の状態応答も RTT 78 ms で返ってきている。
冗長性のために 2 本維持する意味はなく、むしろ有害だった。

#### C33-4. ⭐⭐ 広告は「消せない」。接続不可に変えるしかない

参加後に広告を止めようとしたが、**BlueZ が勝手に再開してくる。**

```
 9197.5 ms  ADV OFF   ← こちらが止めた
 9207.1 ms  ADV ON    ← 9.6 ms 後に再開された
11060.9 ms  ADV OFF   ← 2 秒ごとに止め直しても
11223.0 ms  ADV ON    ← 162 ms 後に必ず戻される
13061.5 ms  ADV OFF
13239.0 ms  ADV ON    ← 177 ms 後
```

`hcitool cmd 0x08 0x000a 00`（`LE Set Advertising Enable = 0`）を
2 秒周期で打っても毎回 **150〜240 ms 後に再開**された。
`btmgmt advertising off` はタイムアウトして効かない（Pi 3 は `SupportedInstances = 0`）。

⭐ **発想を変えて、広告は出したまま `ADV_NONCONN_IND`（接続不可）にする。**

```python
# LE Set Advertising Parameters の adv_type を 0x00（ADV_IND）→ 0x03（ADV_NONCONN_IND）
params = struct.pack("<HH", 0x00A0, 0x00A0) + bytes([0x03, 0x01, 0x00]) + bytes(6) + bytes([0x07, 0x00])
```

接続不可の広告なら器具は繋いでこられないので、BlueZ が `Enable` を
打ち直しても害がない。**BlueZ と戦わずに目的を達成できる。**

#### C33-5. ⭐⭐ 到達率は 1 通で 0.993〜1.0。3 連射は無駄だった

過去の journald ログ全件を再集計した（`#M` 形式を導入する前の verbose ログ）。

```
状態要求 142 回 → 応答 141 回/器具   ratio = 0.993（両器具）
```

「1 送信 → 1 応答/器具」がほぼ厳密に成立している。`--resend 3` は
上りも下りも 3 倍にしていただけだった。修正後の実測は **13/13 = 1.000**。

⚠️ **C28-1 の「同じ PDU が二重に届く」を訂正する。**
2 台構成の `0x71` 応答では**中継による重複は発生していなかった**。
観測された重複はすべて**自分の 3 連射に対する応答**だった。
`resend = 1` にしたら受信重複は **0 件**になった。

#### C33-6. RTT の改善（アプリから見た往復）

状態要求（`0x70`）→ 応答（`0x71`）の実測。

| | before（3 連射・45 ms 混在） | after（1 通・15/28.75 ms） |
| --- | --- | --- |
| `28:A6` p50 / p90 / max | 67 / 137 / **449** ms | 78 / 92 / **117** ms |
| `DE:CD` p50 / p90 / max | 70 / 115 / **445** ms | 50 / 60 / **77** ms |

⭐ **max（テールレイテンシ）が 449 → 77〜117 ms（-75 〜 -83 %）。**
体感の「時々反応しない」はここが効いている。

#### C33-7. 収束制御の実測（P2 / P4 の実装）

期待状態を保持し、状態応答で収束を判定して未収束なら再送する仕組みを入れた。
確認までの待ちは固定 1500 ms をやめ、**実測 RTT の p90 × 2**（下限 200 / 上限 800 ms）
から自動で決める。

| 指標 | 実測 |
| --- | --- |
| HTTP 即応答（既定） | **5.3〜5.9 ms**（変わらず） |
| `?wait=1` の収束確認 | **277〜320 ms**（p50 312 ms） |
| 収束に要した試行回数 | **全件 1 回目**（再送ゼロ） |
| スライダー模擬（143 ms 間隔 × 16 通） | 最終値に**両器具が収束**・取り違え 0・**古い操作 15 件を破棄** |

⭐ 収束判定は操作の種類ごとに違う。

| 操作 | 判定 |
| --- | --- |
| 明るさ・色温度 | `params[0] == 色温度コード` かつ `params[1] == 明るさコード`（等値） |
| OFF | `params[0] == 0x32` かつ `params[1] == 0x32` |
| **ON** | ⚠️ **等値比較できない。** コマンドは `37 37` だが応答は器具が記憶していた実値 → 「`32 32` でない」で判定 |
| ナイトライト | `params[2] == 3 - レベル`（コマンドと器具値が逆順・C24-5） |

⚠️ さらに「操作より前の観測で収束と言わない」ため、
`state_updated_at > 操作時刻` を条件に加えている（偶然すでに期待どおりだった場合も
送信後の応答で確かめる）。

#### C33-8. ⚠️ BlueZ は `StopNotify` を呼ばない

`odelicd` は `Characteristic.StopNotify` で切断を検知していたが、
**BlueZ 5.82 はほぼ呼んでくれない。**

```
24 時間で「リンク確立 50 回」に対し「リンク切断 2 回」しか記録されていなかった
```

その結果 `notifying` フラグが True でラッチされ、

- 切断に気づかない → 広告を再開しない → 繋ぎ直しに来られない
- `_send()` が購読者ゼロでも成功を返す（**P4 違反の嘘**）
- `hcitool con` が 1 本しか示していないのに `/info` は `connected: true, peers 2` と答えていた

⭐ **リンク状態の権威は `org.bluez.Device1` の `Connected` プロパティ。**
`PropertiesChanged` と `InterfacesRemoved` を購読して `live_links` を持つのが正しい。
`StartNotify` / `StopNotify` はヒントとして扱う。

#### C33-9. 切断理由の内訳（`Disconnection Complete` の reason）

`btsnoop.py` が理由コードを捨てていたので拾うようにした。

| reason | before の件数 | 意味と対策 |
| --- | --- | --- |
| `0x13` | 36 | Remote User Terminated。**器具の意思**（C33-3 の交互切断） |
| `0x08` | 24 | Supervision Timeout。**電波が途切れた**（環境・干渉） |
| `0x16` | 5 | 自分が切った（起動時の掃除・余剰リンクの整理） |

修正後は **`0x16` のみ**（自分の再起動）になった。

#### C33-10. ⚠️ `Device1.Disconnect()` の同期呼び出しは主リンクを巻き込む

余剰リンクを切るために D-Bus の `Disconnect()` を同期で呼んだら、
**2.6 秒ブロックして主リンクまで落ちた**（その間 GATT に応答できない）。

```
32.685  余剰リンクを切ると決めた
35.298  切断完了               ← 2.6 秒後
35.299  主リンクも切れた       ← 巻き込まれた
```

→ **必ず非同期（`reply_handler` / `error_handler`）で呼ぶ。**

なお純正アプリが使う `01 15 55`（exit_cmd）は **BlueZ では使えない**。
Notify は D-Bus の `PropertiesChanged` なので購読中の全リンクに配信され、
主リンクまで追い出してしまう（器具ごとの送り分けができない）。

#### C33-11. ⭐ リンクは無通信でも維持される（が、死は検知できない）

最適化後に放置して観測した結果。

| 項目 | 実測 |
| --- | --- |
| リンク継続 | **3344 秒（55.7 分）** 連続・`join_count = 1`・切断 **0 回** |
| その間の通信 | **ゼロ**（沈黙 3325 秒）。定期ポーリングを入れていなかった |
| 55 分沈黙後の状態要求 | **両器具が応答**（RTT 59.7 / 61.3 ms）。リンクは完全に健全だった |
| 復号失敗 / セグメント破棄 | 0 / 0 |
| RSS | 37.5 MB（増加なし） |

BLE のリンク層は接続イベントごとに空パケットを交換するので、
**アプリが黙っていても Supervision Timeout は発動しない。**

⚠️ ただし「GATT リンクは生きているが**メッシュから外れている**」状態は
これでは検知できない（コマンドが通らないのに接続中と見える）。
そこで **60 秒ごとに状態を要求する定期ポーリング**を入れた。

- 健全性の監視（全器具が 3 回連続で無応答ならリンクを作り直す）
- 状態の新鮮さ（他コントローラの操作を取りこぼしても次のポーリングで追いつく）
- **RTT を継続的に測れる**ので `T_confirm` の自動調整が効き続ける

コストは 60 秒に 1 通（+ 応答 2 通）。実測で 2.5 分間の総送信は 8 通だった。

#### C33-12. 実測に使ったコマンド

```bash
# HCI トレース（btmon を systemd の transient unit で回す）
sudo systemd-run --unit=odelic-btmon --collect btmon -w /var/log/odelic/trace.btsnoop
sudo systemctl stop odelic-btmon

# リンク 1 本 1 行の表・接続パラメータ・切断理由
python docs/analysis/tools/btsnoop.py conn    artifacts/trace.btsnoop
# ACL 送信 → 完了通知のレイテンシ（interval 別）
python docs/analysis/tools/btsnoop.py latency artifacts/trace.btsnoop

# 内蔵計測
curl -s localhost:8080/metrics          # RTT 分布・到達率・リンク寿命・収束時間
curl -s 'localhost:8080/events?kind=link_down'
sudo journalctl -u odelicd | grep '#M'  # 機械可読な 1 行ログ（awk で集計できる）
```

⚠️ `/tmp` は **tmpfs（RAM 453 MB）**。Pi の空きは 1.2 GB しかないので、
トレースは `/var/log/odelic/` に置く。btsnoop は約 **131 KB/h**（テキスト出力は 4.3 倍）。

---

## 実装方針への影響（重要）

**✅ 案 D（完全自前実装）が成立することを実機で確認した（C19）。**

当初は「暗号化が `.so` にあるので SDK を流用するしかない」（案 C）と判断していたが、
C18-3 で PDU が平文だと判明し、C19 で **Raspberry Pi から自前実装でメッシュ参加に成功**した。

| 案 | 内容 | 状況 | 再配布 |
| --- | --- | --- | --- |
| **D** | **完全自前実装**（`.so` も SDK も使わない） | ✅ **参加成功（C19）** | ✅ 可能 |
| C | Pairlink SDK の Java 層を流用 | 不要になった | ❌ 不可 |
| A | `.so` だけ JNI で呼ぶ | 不要になった | ❌ 不可 |
| B | `.so` を逆アセンブルして暗号を自前実装 | 不要になった | ✅ 可能 |

### 案 D に必要なものはすべて揃った

| 必要な処理 | 状況 |
| --- | --- |
| GATT サーバを立てる（FFD0 / FFD1 / FFD2 / CCCD） | ✅ 実装・動作確認済み（C19-1） |
| `ADV_PHONE` ビーコンを出す | ✅ 実装・電波確認済み（C19-1 / C19-5） |
| `PERIPHERAL_LOGIN`（`0x19`）| ✅ **応答しないのが正解**（C19-2） |
| `GET_PASSWORD` に HOMEID + パスワードで応答 | ✅ これだけで認証が通る（C19-1） |
| `GET_VIRTUAL_ADDR` | ✅ 器具から割り当てられる。受け取るだけ |
| 照明制御コマンドを組み立てて Notify | ✅ フォーマット判明（C6 / C15 / C18-4） |
| 状態応答を解釈 | ✅ 判明（C15-9 / C18-4） |

✅ **照明の点灯・消灯まで実証済み（C19-6）。**
自前実装で送った `DATA_EVENT` に器具が反応し、目視で確認できた。
**プロトコル解析はここで完了。**

### どちらの案でも共通する改善

不安定さの原因は**プロトコルではなく上位層の設計**にある
（[03-instability.md](analysis/03-instability.md)）。以下は案の選択と無関係に実装できる。

- 状態を常時監視してキャッシュ（P1）→ Ping 応答と状態イベントを自前で蓄積
- 期待状態まで送り続ける（P2）→ **純正アプリは 1 回しか送らない**（C18-5 で実証）
- 冪等な操作（P3）→ 絶対値指定なので**そのまま冪等**
- 確認できるまで成功と言わない（P4）→ 状態イベントで照合
- 待たせない UI（P5）→ 完全に自作範囲
- 位置情報権限の除去（C11）

⚠️ **ライセンス**: 案 A・C は純正アプリのバイナリ／コードを利用するため
**自分の器具を操作する範囲に限り、再配布しない**。
案 D・B なら独自実装なので公開の余地がある。

---

## 残る要検証

解決済み（→ C15）。

- [x] **各 MSGID のメッセージデータの中身** → サブコマンド方式・グループレイアウトを確定
- [x] 明るさ・調色の値域と単位 → 0〜100% をテーブルでコードに変換。**ON=55 / OFF=50**
- [x] 状態応答のフォーマット → `syncState()` を解読。**明るさコードは逆順**
- [x] 一斉操作と個別操作の区別 → チャネル 0x2A / 0x20
- [x] GATT のサービス／キャラクタリスティック UUID（→ C17-1）
- [x] `join_mode` の決定ロジック → **Central を試して失敗したら Peripheral**（→ C17-2）
- [x] `flow_control_enable` → **常に false。未使用のトグル**（→ C17-4）

- [x] **実機 HCI ログとの突き合わせ** → **C18 で実施。ほぼ全面的に裏付けられた**
- [x] `PLTCEOC-05` の正体 → **器具が GATT で公開する型番**（C18-6）

C23 / C24 で解決したもの。

- [x] ⭐ **`PERIPHERAL_LOGIN`（`0x01 0x19` + 16 バイト）の中身**
      → **LOGINKEY で復号すると HOMEID + 受信復号鍵 + PKCS#7**（C23-1）。
      暗号チャレンジではなく**鍵の受け渡し**だった
- [x] ⭐ ログインを通さず `DATA_EVENT` だけで器具が反応するか
      → **反応する**（照明制御は平文で通る・C19-6）。ただし
      **応答を返させるにはログイン応答が必要**（C23-2）
- [x] `pdu[0] = 0x06` の意味 → **暗号化ラッパー**（C23-3 / C23-5）
- [x] `.so` の暗号方式 → **AES-128-ECB + PKCS#7 + XOR ホワイトニング**（C22 / C23）
- [x] `0xD7`（グループ応答）・`0x71`（状態応答）の実データ → C23-4 / C23-7 で実測
- [x] `0x35` は `STATE_RESPONSE_FD`。`syncState()` が `0x71` と同じ処理をする（C15-9）
- [x] ナイトライトの仕様 → **3 段階（0/1/2）。状態は読み戻せない**（C24）

残っているもの。優先度の高い順。

- [ ] `01 18 xx 00`（CMD 0x18 = 24）の意味。**純正アプリも「Unknow CMD」として捨てている**
      → 実測値は 0x0C / 0x14 / 0x17。参加時に器具が送ってくる
- [ ] `0x71` 応答の `data[7]`（実測 `0x03` 固定）以降の意味。
      `syncState()` は読み捨てているので手がかりがない
- [ ] 開発者オプションのスヌープログを有効にして再採取
      → 器具のビーコン（`ADV_CONNECTABLE`）とスキャン挙動を見る
- [ ] `WARM`/`COOL` コード（88〜126）と `BRIGHT`/`COLOR` コード（1〜21）の
      使い分けを器具側がどう判別しているか（C15-8）
- [ ] `CFormat.Header` が同一プロトコルの別命名か別系統か（C15-10）。
      **タイマー系のコマンドはこの enum しか手がかりがない**
- [ ] `.so` の暗号方式（AES のモード、鍵導出、ナンス）
      — 照明制御は平文なので、ログイン（`0x19`）と `0x06` タイプにしか関係しない
- [ ] `pdu[0] = 0x06` の意味（暗号化ラッパー？）
- [ ] MSGID `0x65`（人感センサー要求）の正式な定義
      （`MeshProfile` に無く、使用箇所からの推定のみ）
- [ ] `assets/ota/*` のフォーマットと、ファイル名の数値の意味
- [ ] グループビットマップ `[7..12]`（48 bit）の対応付け規則
