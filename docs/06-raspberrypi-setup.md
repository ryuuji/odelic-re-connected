# 06. Raspberry Pi による検証環境

最終更新: 2026-07-25

照明のそばに Raspberry Pi を常設し、開発機から SSH で操作して検証を進める。

**構成**: Raspberry Pi 3 / 3B+（BLE 4.2 内蔵）、開発機と同一 LAN。

---

## なぜ Pi を使うのか

最重要の未解明項目は
「`PERIPHERAL_LOGIN` を通さずに `DATA_EVENT` だけで器具が反応するか」
（[02-protocol.md](02-protocol.md) の「実装方針への影響」）。
これは数十バイトを送って反応を見るだけの実験で、Android アプリを書く必要がない。

| | Android | Raspberry Pi |
| --- | --- | --- |
| 1 回の試行 | ビルド → インストール → 操作 → bugreport（数分） | スクリプト編集 → 実行（数秒） |
| HCI トレース | bugreport 経由。スキャン結果がフィルタで欠落 | `btmon` で完全・無フィルタ・リアルタイム |
| 開発者オプション | 手動トグルが必要（adb 不可） | 不要 |
| 物理的距離 | 端末を持ち運ぶ | SSH で常設 |
| 環境構築 | Android Studio + SDK（約 10 GB） | BlueZ（標準搭載） |

### ⚠️ Pi でできないこと

`btmon` は「そのマシン自身の Bluetooth アダプタ」の HCI 通信しか見えない。
スマホ ↔ 器具の通信を Pi から傍受することは **できない**
（それには nRF52840 などの専用スニファが必要）。

Pi でできるのは次の 2 つ。どちらも今回必要なものだ。

1. **器具のアドバタイズを受信する** — ブロードキャストなので誰でも受信できる。
   Android の `btsnooz` がフィルタで落としていた `ADV_CONNECTABLE` が ここで初めて見える
2. Pi 自身が Peripheral になって器具と通信し、それを完全に観測する — 本命

### ⚠️ 想定されるリスク

`PERIPHERAL_LOGIN`（`01 19` + 16 バイト）が暗号チャレンジだった場合、
Pi では `libnative-lib.so` を流用できない（Android の Bionic libc 依存で glibc では動かない）。
その場合は Android + SDK 流用（案 C）に戻ることになる。

ただし観測されたログには認証らしきやり取りが 2 つある。

```
器具 → スマホ:  01 19 F3 37 07 C9 ...（16 バイト・不透明）
器具 → スマホ:  01 00 D2 04 00 00                        ← GET_PASSWORD
スマホ → 器具:  02 19 85 E2 14 14 ...（16 バイト・不透明）
スマホ → 器具:  02 00 D2 04 00 00 35 36 37 38            ← ★ パスワードは平文
```

**[推測]** `0x00`（GET_PASSWORD / 平文パスワード）が実際の認証で、
`0x19` はバージョンや能力交換かもしれない。
そうであれば Pi だけで完結する。**この切り分けが最初の実験の目的。**

---

## フェーズ P0: OS のセットアップ

### P0-1. イメージを書き込む

Raspberry Pi OS Lite (64-bit) を使う。デスクトップ環境は不要。
Pi 3 は ARMv8 なので 64-bit が動く。

[Raspberry Pi Imager](https://www.raspberrypi.com/software/) を使い、
書き込み前に **歯車アイコン（OS カスタマイズ）** で以下を設定する。
これをやっておけばモニタ・キーボードなしで起動できる。

| 項目 | 設定値 |
| --- | --- |
| ホスト名 | `odelic-pi`（→ `odelic-pi.local` で引ける） |
| ユーザー名 / パスワード | 任意（例 `pi`） |
| Wi-Fi SSID / パスワード | 照明のそばで届くもの |
| Wi-Fi の国 | `JP` |
| SSH を有効化 | ✅ 公開鍵認証を推奨 |
| ロケール / タイムゾーン | `Asia/Tokyo` |

公開鍵は開発機の `%USERPROFILE%\.ssh\id_ed25519.pub` を貼る。
無ければ開発機で生成する。

```powershell
ssh-keygen -t ed25519 -C "odelic-pi"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

### P0-2. 起動と接続

microSD を挿して電源投入。Wi-Fi に繋がるまで 1〜2 分待つ。

```powershell
# mDNS で引く（Windows 10 以降は標準対応）
ssh pi@odelic-pi.local

# 引けない場合は IP を探す
ping odelic-pi.local
arp -a | Select-String "b8-27-eb|dc-a6-32|e4-5f-01"   # Raspberry Pi の OUI
```

接続できたら、開発機の SSH 設定に登録しておくと以後楽になる。
`%USERPROFILE%\.ssh\config` に追記。

```
Host odelic-pi
    HostName odelic-pi.local
    User pi
    IdentityFile ~/.ssh/id_ed25519
```

以後 `ssh odelic-pi` で入れる。

### P0-3. BlueZ の確認

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y bluez bluez-tools python3-dbus python3-gi git

bluetoothctl --version          # BlueZ のバージョン
hciconfig -a                    # アダプタの存在確認
sudo btmgmt info                # 対応機能（le, advertising, privacy など）
```

**確認したいこと**

- `bluetoothctl --version` が 5.60 以上
- `btmgmt info` の `supported settings` に `le` と `advertising` が含まれる
  → Peripheral（GATT サーバ）として動作できる

`btmon` を root なしで使えるようにしておく（任意）。

```bash
sudo setcap 'cap_net_raw,cap_net_admin+eip' $(which btmon)
```

---

## フェーズ P1: 器具のアドバタイズを観測する（コード不要）

**最初の実験。** Android では見えなかった器具のビーコンを確認する。

`btmon` は **btsnoop 形式で書き出せる** ので、
既存の `docs/analysis/tools/btsnoop.py` がそのまま使える（Pairlink デコード込み）。

Pi で 2 つのセッションを開く。

```bash
# セッション 1: キャプチャ開始
sudo btmon -w /tmp/scan.btsnoop

# セッション 2: スキャン開始（30 秒ほど流す）
sudo btmgmt find
#   または
bluetoothctl scan on
```

`Ctrl-C` で停止し、開発機に持ってくる。

```powershell
scp odelic-pi:/tmp/scan.btsnoop R:\odelic-re-connected\artifacts\pi-scan.btsnoop
python docs/analysis/tools/btsnoop.py summary artifacts\pi-scan.btsnoop
python docs/analysis/tools/btsnoop.py recv    artifacts\pi-scan.btsnoop --mfg-only
```

### 期待する結果

| 確認項目 | 期待 |
| --- | --- |
| 器具のビーコン | `ADV_CONNECTABLE`(0x82) が受信できる |
| HOMEID | 1234 がデコードされる |
| 送信元 MAC | OUI が `00:95:69` または `F0:AC:D7` |
| 台数 | 2 台（`device_num = 2` と一致するか） |
| RSSI | 器具ごとの電波強度 → 接続先の選定材料 |

これが取れれば、Pi の BLE が期待通り動いていることの証明になる。
同時に [02-protocol.md](02-protocol.md) の C16-4（器具側アドバタイズの形式）が検証できる。

---

## フェーズ P2: Pi を Peripheral にして器具の接続を待つ

ここからスクリプトを書く。実機の構成（C18-2）を再現する。

```
[Pi]  GATT サーバ（FFD0 / FFD1 / FFD2 + CCCD）を公開
      + ADV_PHONE ビーコンを送信
        ↓
[器具] Pi に GATT 接続してくる
        ↓
      FFD1 に Write Command でログイン要求
        ↓
[Pi]  FFD2 の Notification で応答
```

### 必要な要素

| 要素 | 実装方法 |
| --- | --- |
| アドバタイズ | BlueZ の `LEAdvertisingManager1` D-Bus API（`ManufacturerData` に Company ID 0） |
| GATT サーバ | BlueZ の `GattManager1` D-Bus API |
| 生バイトの完全制御 | 上記で足りなければ raw HCI ソケット（`AF_BLUETOOTH` / `BTPROTO_HCI`） |
| 観測 | `sudo btmon -w` で全部記録 |

**[要検証]** BlueZ が `ManufacturerData` の Company ID `0x0000` を受け付けるか。
拒否される場合は raw HCI で `LE Set Extended Advertising Data` を直接送る。

### 送るアドバタイズ（C3 / C17-3）

```
AD Type 0xFF (Manufacturer Specific Data)
  00 00              Company ID = 0
  C0                 マジック（flow_control_enable は常に false）
  FF
  05                 ADV_PHONE
  D2 04 00 00        HOMEID 1234（リトルエンディアン）
  xx xx xx xx xx xx  Pi の BT MAC
```

### ログイン応答（C18-3）

器具から来る要求に応答する。

| 器具 → Pi | Pi → 器具 |
| --- | --- |
| `01 19 <16 バイト>` | `02 19 <16 バイト>` ← 中身が不明。ここが関門 |
| `01 00 D2 04 00 00` | `02 00 D2 04 00 00 35 36 37 38` ← パスワード平文 |
| `01 0A ...`（GET_VIRTUAL_ADDR） | `01 0A <own_vAddr 4 バイト>` |

まず `0x19` を無視して `0x00` にだけ応答してみる。
それで器具が接続を維持するなら、`0x19` は認証ではない。

---

## フェーズ P3: DATA_EVENT を送って照明を制御する

ここが本番。案 D（完全自前実装）の成否が決まる。

送るバイト列は完全に判明している（C6 / C15 / C18-4）。

```python
# 一斉に点灯（ON = 0x37）
# 03 | FF FF FF FF | 20 | <own_vAddr> | C1 | 37 37 00×6 00
pdu = bytes([0x03]) + b"\xff\xff\xff\xff" + bytes([0x20]) \
    + own_vaddr + bytes([0xC1, 0x37, 0x37]) + bytes(6) + bytes([group])
```

### 実験の順序

⚠️ 破壊的な操作（グループ設定・登録の初期化）は絶対に送らない。
使うのは `0xC0` / `0xC1`（明るさ・色温度）と `0x70`（状態要求）だけ。

| # | 送るもの | 見たいこと |
| --- | --- | --- |
| 1 | `0x70`（状態要求・パラメータなし） | `0x71` の応答が返るか。最も安全な最初の一手 |
| 2 | `0xC1` + `37 37`（ON） | 照明が点灯するか |
| 3 | `0xC1` + `32 32`（OFF） | 消灯するか |
| 4 | `0xC1` + `<色温度> <明るさ>` | 連続値が効くか |
| 5 | ログインを飛ばして 2 を送る | `0x19` が必須かどうかの決定的な判定 |

**実験 1 が通れば通信が成立している証拠** になり、実験 2 で制御が確認できる。

### 換算式（C15-9 / C18-4）

```python
def color_to_code(percent): return min(max(percent // 5, 0), 20)
def bright_to_code(percent): return 19 if percent == 0 else min(max((100 - percent) // 5, 0), 19)

CODE_ON, CODE_OFF = 0x37, 0x32   # 55 / 50。値域外の状態コード
```

---

## フェーズ P4: 結果に応じた分岐

| P3 の結果 | 次の方針 |
| --- | --- |
| ログインなしで制御できた | 案 D（完全自前実装）が成立。 Android 実装も `.so` 不要。再配布可能 |
| `0x00`（平文パスワード）応答で制御できた | 案 D 成立。ログイン処理を実装するだけ |
| `0x19` の応答が必須だった | `.so` の解析が必要 → Android + SDK 流用（案 C）に戻る |

いずれの結果でも、**Pi は以後デバッグ用の常設機として価値が残る**
（`btmon` による観測、器具の状態監視、nRF ドングルを足せばスニファ）。

---

## 実施結果（2026-07-25）

### 環境

| 項目 | 値 |
| --- | --- |
| ホスト | `odelic-re-connected`（Tailscale 経由・`100.87.38.85`） |
| OS | Debian 13 (trixie) / aarch64 / カーネル 6.18.34-rpi-v8 |
| BlueZ | 5.82 |
| アダプタ | `B8:27:EB:FF:16:47` / HCI version 7（Bluetooth 4.1） |
| Python | 3.13.5（`python3-dbus` / `python3-gi` 導入済み） |

### P1: 受動スキャン → ❌ 器具は見つからない（想定外だが有益）

43 秒スキャンして LE デバイス 19 台・アドバタイズ 103 件を受信したが、
**Pairlink 形式は 0 件**（Company ID は 0x055A / 0x0006 / 0x004C など無関係）。

→ 器具は普段アドバタイズしていない。「スキャンする側」だった。
受動スキャンで器具を発見することは原理的にできない。
→ [02-protocol.md](02-protocol.md) C19-4

`btmon -w` は btsnoop の datalink 2001（Linux Monitor 形式） で書き出す。
Android の btsnoop（1002）とは別形式なので、`docs/analysis/tools/btsnoop.py` に対応を実装した。

### P2: Peripheral として参加 → ✅ 成功

⚠️ BlueZ の D-Bus アドバタイズは使えなかった。
`LEAdvertisingManager1.RegisterAdvertisement` が
`Invalid Parameters (0x0d)` で必ず失敗する（`SupportedInstances = 0`）。
プロパティを 8 通り試して全滅したので Company ID `0x0000` は原因ではない。
→ **raw HCI（`hcitool`）で直接叩いて解決**。詳細は
[02-protocol.md](02-protocol.md) C19-5 と `docs/analysis/tools/adv_raw.sh`。

GATT サーバの D-Bus 登録（`GattManager1`）は問題なく動く。

**参加に成功した。**

```
器具 EC:C5:7F:81:DE:CD / EC:C5:7F:80:28:A6 が Pi に GATT 接続
  → 01 19 <16 バイト>          PERIPHERAL_LOGIN（★ 応答しない）
  → 01 00 D2 04 00 00          GET_PASSWORD
  ← 02 00 D2 04 00 00 35 36 37 38
  → 01 01                       WELCOME（認証成功）
  → 01 0A 15 00 00 00           own_vAddr 割り当て
  → 01 02 ... 02 00             device_num = 2
```

⭐ 最大の発見: `PERIPHERAL_LOGIN` に応答してはいけない。
エコーバックすると 12 回すべて切断されたが、無応答なら参加できた。
→ `.so` の暗号解析は不要。案 D（完全自前実装）が成立。

### P3: 照明の制御 → ✅ 成功

`--send blink`（ON → OFF → ON を各 3 回）で
**照明が実際に消えて点灯した**（利用者の目視確認）。

```
点灯: 03 FF FF FF FF 20 25 00 00 00 C1 37 37 00 00 00 00 00 00 00
消灯: 03 FF FF FF FF 20 25 00 00 00 C1 32 32 00 00 00 00 00 00 00
```

公式アプリの実機ログと **src の vAddr 以外は完全に同一**。
→ [02-protocol.md](02-protocol.md) C19-6

#### ⭐ 途中で詰まった原因：器具はコントローラのアドレスを記憶している

参加に成功した後、**同じアドレスでは器具が接続してこなくなった**
（50 / 150 / 300 秒すべて 0 回）。
ランダムアドレスに変えた途端 1.9 秒で接続が復活した。

公式アプリも `LE Set Random Address` を使っている（C18-7）ので、
自作アプリでもランダムアドレスにすべき。
ただし「登録済みコントローラ 4 台まで」の枠を消費する恐れがあるため、
実運用ではアドレスを固定して使い回す。→ C19-7

#### 接続時間は短い

参加完了から数秒で切断される。実測では `WELCOME` から約 7 秒後まで通った。
**参加を検知したら即座に送る** 設計が必要（`--send-delay` 既定 0.4 秒）。→ C19-8

---

## 進行状況

- [x] P0: OS セットアップ
  - [x] イメージ書き込み・SSH 接続
  - [x] BlueZ 5.82 / `le` + `advertising` 対応確認
- [x] P1: 器具のアドバタイズ観測 → **器具はアドバタイズしないと判明**
- [x] P2: Peripheral として器具の接続を受ける → **参加成功**
  - [x] raw HCI によるアドバタイズ（BlueZ D-Bus 経路は使用不可）
  - [x] ~~`PERIPHERAL_LOGIN` は無応答が正解と判明~~
        → 訂正: 正しい応答を返すのが正解（P6 / C23-2）
- [x] P3: `DATA_EVENT` で照明を制御 → ✅ 点灯・消灯に成功
  - [x] ランダムアドレスの必要性を発見（器具がアドレスを記憶している）
  - [x] 参加直後に即送信する必要があることを確認
- [x] P4: 案 D / 案 C の判断 → 案 D（完全自前実装）で確定・実証済み
- [x] P5: 常駐サービス化 → ✅ 完了
  - [x] ~~`SET_LINK` で接続維持（数秒 → 90 秒以上）~~
        → 訂正: 切断の真因はログイン無応答。`SET_LINK` は不要（P6 / C23-6）
  - [x] systemd 登録・自動起動（`enabled` / `active`）
  - [x] HTTP API で 5〜8 ミリ秒 の応答
  - [x] 広告アドレスの永続化（コントローラ枠の消費を避ける）
- [x] P6: 状態取得 → ✅ 完了
  - [x] `PERIPHERAL_LOGIN` から受信復号鍵を取得（C23-1）
  - [x] ログイン応答を公式アプリと同一に再現（C23-2）
  - [x] `SET_LINK` の誤送信をやめて応答が返るようになった（C23-6）
  - [x] 器具 2 台の MAC / vAddr / グループ / ファーム / 現在状態 を取得
  - [x] 指示値と読み戻し値の一致を確認（閉ループ）

---

## フェーズ P5: 常駐サービス化（実用化）✅ 完了

`odelicd/odelicd.py` を systemd サービスとして常駐させ、HTTP API で操作できるようにした。

### インストール

```bash
# 開発機から転送
scp odelicd/odelicd.py odelicd/odelicd.service odelicd/install.sh odelic-re-connected:~/odelicd-install/

# Pi 上で
cd ~/odelicd-install && sudo ./install.sh 12345678 8080
```

`install.sh` がやること。

| 配置先 | 内容 |
| --- | --- |
| `/opt/odelicd/odelicd.py` | 本体 |
| `/etc/default/odelicd` | ID などの設定（0600。下位 4 桁はパスワードなので） |
| `/etc/systemd/system/odelicd.service` | ユニット |
| `/var/lib/odelicd/adv_addr` | 広告アドレス（`StateDirectory` で自動作成） |

### 実測レイテンシ

| | 公式アプリ | odelicd |
| --- | --- | --- |
| 起動〜操作可能 | 約 7 秒 | 0 秒（常時接続維持） |
| 1 操作の所要時間 | 不明・確認なし | 5〜8 ミリ秒 |
| 取りこぼし対策 | 送信 1 回のみ | 3 回送信（冪等なので安全） |
| 未接続時の挙動 | 「接続成功」と表示する | HTTP 503 + キューに保持 |

**約 1000 倍の改善。** 公式アプリの起動 7 秒が体感の大半だったので、
常駐化がそのまま効いた。

### 〜P5 時点: 状態取得は実装できなかった（当時の記録）

`GET /status` と `/devices` は用意したが、器具の現在状態は読めなかった。
送った探索・状態要求はすべて無応答だった。

```
>> 03 FF FF FF FF FE 25 00 00 00        Ping                → 無応答
>> 03 FF FF FF FF 20 25 00 00 00 02     get_product_id      → 無応答
>> 03 FF FF FF FF 20 25 00 00 00 D0 01  get_group_id        → 無応答
>> 03 FF FF FF FF 20 25 00 00 00 70     状態要求            → 無応答
```

暗号化が原因だと考えていたが、**真因は別だった** → P6。

---

## フェーズ P6: 状態取得を実現 ✅ 完了（2026-07-25）

器具の一覧・vAddr・グループ・ファーム・現在状態がすべて取れるようになった。
プロトコル側の詳細は [02-protocol.md](02-protocol.md) の C23。

### 効いた 2 つの修正

| # | 修正 | 効果 |
| --- | --- | --- |
| 1 | `PERIPHERAL_LOGIN` に正しい応答を返す（C23-2） | 器具が切断しなくなった。鍵も入手 |
| 2 | `SET_LINK` (`01 10`) を送るのをやめた（C23-6） | ⭐ 器具が応答を返すようになった |

⚠️ どちらも従来の結論（C19-2「応答してはいけない」／
C19-8「SET_LINK を送らないと切れる」）の **訂正** にあたる。

- ログイン応答は「エコーバックという誤答」が切断されていただけだった
- `SET_LINK` は公式アプリでは **2 台目以降のバックアップリンクにしか送らない**。
  全器具に送っていたため「主リンクではない」と見なされ、応答が来なかった

### 受信復号の流れ（実装）

```
器具が接続 → 01 19 + 16B（ログイン要求）
           → LOGINKEY で復号 → [0..3] HOMEID 照合 / [4..7] ★このリンクの XOR 鍵
           → 02 19 + AES(LOGINKEY, HOMEID + パスワード + 鍵 + 04040404) を返す
以降 type 0x06 の受信 → XOR(鍵) → AES_ECB_decrypt(EVENTKEY) → PKCS#7 を外す
                     → 平文 DATA_EVENT として通常の経路で解釈
```

鍵は **接続ごとにランダム** で、GATT リンク単位。`/info` の `crypto` で確認できる。

### 実測ログ

```
[67.857] ★ ログイン要求を復号: EC:C5:7F:81:DE:CD の鍵 = 29 AD 2F 1A
[67.992] WELCOME（主リンク）
[68.022] ★ 参加完了（器具 2 台）
[68.323] Ping を暗号化して送信（チャネル 0xFE）
[68.367] ★ 器具を発見: EC:C5:7F:81:DE:CD  vAddr=05 00 00 00  ver=0x52C0 fw1.7
[68.425] ★ 器具を発見: EC:C5:7F:80:28:A6  vAddr=01 00 00 00  ver=0x52C0 fw1.7
[69.058]    グループ ID: EC:C5:7F:81:DE:CD → 0
[69.066]    グループ ID: EC:C5:7F:80:28:A6 → 1
[70.495]   ↓復号 03 35 00 00 00 27 05 00 00 00 71 32 32 03 00 00 00 00 00
[70.495] 状態更新 EC:C5:7F:81:DE:CD: on=False
```

### 閉ループの検証

```bash
curl -X POST 'localhost:8080/level?bright=60&color=50'
curl 'localhost:8080/status'      # 状態要求を投げる
curl localhost:8080/devices       # 器具が返した状態を読む
```

| 指示 | 器具が返した状態 |
| --- | --- |
| `bright=60&color=50` | `on=true bright=60 color=50` ✅ |
| `off` | `on=false` ✅ |

P4「確認できるまで成功と言わない」がこれで実装可能になった。
リモコンや壁スイッチで変えられた場合も、状態要求で追従できる。

### `/devices` の出力例

```json
{"device_num": 2, "devices_found": 2, "devices": [
  {"key": "05000000", "mac": "EC:C5:7F:81:DE:CD", "vaddr": "05 00 00 00",
   "product_code": 43, "product": "CODE_2B", "group_id": 0,
   "version": "0x52C0 fw1.7", "on": false, "bright": 60, "color": 50},
  {"key": "01000000", "mac": "EC:C5:7F:80:28:A6", "vaddr": "01 00 00 00",
   "product_code": 43, "product": "CODE_2B", "group_id": 1,
   "version": "0x52C0 fw1.7", "on": false, "bright": 60, "color": 50}]}
```

⭐ 器具の vAddr が判ったので `?target=dev:05000000` の個別制御も使えるようになった。

### ナイトライト（常夜灯）も状態まで取れる

```bash
curl -X POST 'localhost:8080/night?level=0'   # 0 / 1 / 2（0 が最も明るい）
curl -X POST localhost:8080/status
curl localhost:8080/devices
#   → night_on=true night=3 night_level=0
```

状態応答 `0x71` の **`data[7]`** が常夜灯の明るさ（`0`=消灯 / `1`〜`3`、`3` が最も明るい）。
コマンドのレベルとは逆順なので `night_level = 3 - night` で戻している（C24-5）。

| 指示 | 読み戻し |
| --- | --- |
| `/night?level=0` | `night=3 night_level=0` ✅ |
| `/night?level=1` | `night=2 night_level=1` ✅ |
| `/off` | `night=0 night_on=false` ✅ |

⚠️ **公式アプリはこのバイトを読んでいない**（ローカルで 0→1→2 を巡回させるだけ）。
自前実装のほうが状態を正確に追える。

### 状態要求は 1 通で済むようになった

実測で宛先・チャネルを総当たりした結果（C23-8）、
`dst = FF FF FF FF` / チャネル `0x20` なら 1 通で全器具が応答する。
以前は器具ごとに送っていたのを 1 通に変更した。
（チャネル `0x2A` では無応答なので注意）

### 新しいオプション

| オプション | 既定 | 意味 |
| --- | --- | --- |
| `--set-link` | `never` | `never` = 送らない（公式アプリの主リンクと同じ） / `auto` = 2 台目以降だけ / `always` = 旧動作 |
| `--no-login-reply` | （応答する） | `PERIPHERAL_LOGIN` に応答しない旧動作に戻す |

### 調査用の裏口（プロトコル探索に使う）

| API | 用途 |
| --- | --- |
| `POST /raw?pdu=<hex>&encrypt=0\|1` | 任意の PDU を送る。未知の MSGID を試すため |
| `POST /verbose?on=1` | 受信 PDU の全ログを実行中に切り替える（再起動不要） |

```bash
# 例: 全器具に状態要求を投げて、復号結果をログで見る
curl -X POST 'localhost:8080/verbose?on=1'
curl -X POST 'localhost:8080/raw?pdu=03FFFFFFFF203500000070'
sudo journalctl -u odelicd -n 20 --no-pager
```

⚠️ `/raw` は器具に未知のコマンドを投げられる。常用しないこと。

### ⚠️ 踏んだ罠: 再接続まで最大 3 分待つ

器具は一度扱ったコントローラのアドレスを覚えていて再接続してこない（C19-7）。
`odelicd` は 180 秒接続がないと広告アドレスを変える実装で、
実測では **アドレスを変えた 1.6 秒後** に接続が来た。
再起動して試すときは `--rotate-after 60` を付けると待ち時間が短くなる。

### ⚠️ 踏んだ罠: `pkill -f` が ssh セッション自身を殺す

`ssh pi 'pkill -f "odelicd.py --port 8081"'` は、**その ssh の
`bash -c` のコマンドラインにも同じ文字列が含まれる** ため自分を殺し、
`exit 255` で切れる。`pgrep -f "port 808[1]"` のように
正規表現にして自己一致を避ける。

### 複数デバイスへの対応

| 対象 | 指定 | 実装 |
| --- | --- | --- |
| 全器具を一斉に | `?target=all`（既定） | `MSGID 0xC0` + チャネル `0x2A` |
| グループ単位 | `?target=group:N` | `MSGID 0xC1` + グループ番号 |
| 器具を個別に | `?target=dev:<KEY>` | `MSGID 0xC0` + 器具の vAddr |
| 発見済みを 1 台ずつ | `?target=each` | 上記を全器具に |

⚠️ `group:N` は「そのグループの器具」にしか届かない。
実機では 2 台の器具が **別グループ（0 と 1）** に入っていたため、
グループ 0 だけに送ると 1 台しか反応しなかった。
既定を `all`（0xC0 + 0x2A）にしてこれを解決した。

⚠️ `dev:` と `each` は器具の vAddr が必要なので、
状態取得と同じ理由（C20）で **現状は使えない**。

### HTTP API

```bash
# 全器具を一斉に（既定）
curl -X POST http://odelic-re-connected:8080/on
curl -X POST http://odelic-re-connected:8080/off
curl -X POST 'http://odelic-re-connected:8080/level?bright=60&color=50'

# グループ指定（そのグループの器具にしか届かない）
curl -X POST 'http://odelic-re-connected:8080/on?target=group:1'

# 情報
curl http://odelic-re-connected:8080/         # 全体の状態
curl http://odelic-re-connected:8080/devices  # 接続してきた器具
```

レスポンスは常に現在の内部状態を含む JSON。

```json
{"ok": true, "detail": "sent", "connected": true, "joined": true,
 "own_vaddr": "25 00 00 00", "device_num": 2, "link_held_sec": 34.0,
 "adv_addr": "C5:BB:31:85:C8:C7", "queued": 0,
 "state": {"on": true, "bright": 60, "color": 50, "updated_at": 1785...}}
```

**P4（嘘をつかない）の実装**: 未接続なら `503` と `detail: "queued"` を返す。
操作はキューに残り、接続できた瞬間に流れる（P5）。

### 管理

```bash
sudo systemctl status  odelicd
sudo systemctl restart odelicd
sudo journalctl -u odelicd -f
```

### ⚠️ 途中で踏んだ罠：systemd 配下で `btmgmt` がブロックする

tty がないと `btmgmt` / `hcitool` が **標準入力を待って止まる**。
対話 SSH では動くのに systemd 配下では起動しない、という症状になる。
→ `subprocess.run(..., stdin=subprocess.DEVNULL, timeout=5)` で解決。

---

## 常用コマンド

```powershell
# 観測のみ（器具が接続してくるか確認）
ssh odelic-re-connected '/tmp/run.sh 60'

# 点灯 / 消灯
ssh odelic-re-connected '/tmp/run.sh 60 --send on'
ssh odelic-re-connected '/tmp/run.sh 60 --send off'

# 目視確認（ON → OFF → ON を各 3 回）
ssh odelic-re-connected '/tmp/run.sh 60 --send blink --repeat'

# 明るさ 60% / 色温度 50%
ssh odelic-re-connected '/tmp/run.sh 60 --send level --bright 60 --color 50'

# HCI ログを回収して解析
scp odelic-re-connected:/tmp/p2.btsnoop artifacts\pi.btsnoop
python docs/analysis/tools/btsnoop.py timeline artifacts\pi.btsnoop
```

⚠️ 送るのは `0xC0` / `0xC1`（明るさ・色温度）と `0x70`（状態要求）だけ。
グループ設定・シーン登録・器具登録の初期化は実装していない
（壊すと壁スイッチからのやり直しになるため）。

---

## P7. 通信戦略の最適化（2026-07-25）→ [02 C33](02-protocol.md)

実測で「安定性」と「レスポンス」を詰めた。**設定変更 1 つと実装修正で
リンク寿命が 7〜14 秒 → 6.8 分以上、RTT の max が 449 → 77 ms になった。**

### ⭐ 必須の OS 設定（これをしないと BlueZ が接続を遅くする）

器具は Connection Interval **15.00 / 28.75 ms** を指定してくるのに、
Linux は「短すぎる」と判断して `Connection Parameter Update Request` を送り、
**45 ms に書き換えてしまう**（実測 65/65 本・器具は全部受理）。

```bash
# 即時（新しい接続に適用。再起動で戻る）
echo 6 | sudo tee /sys/kernel/debug/bluetooth/hci0/conn_min_interval

# 恒久化 — /etc/bluetooth/main.conf の [LE] セクション
#   MinConnectionInterval=6        ← 7.5 ms。器具の選択が範囲内に入るので CPUR が出なくなる
sudo sed -i 's/^#MinConnectionInterval=$/MinConnectionInterval=6/' /etc/bluetooth/main.conf
```

効果の確認:

```powershell
python docs/analysis/tools/btsnoop.py conn artifacts\trace.btsnoop
#   CPUR 列が「-」になり、interval が「28.75 → 45.00」ではなく「28.75」のままになる
python docs/analysis/tools/btsnoop.py latency artifacts\trace.btsnoop
#   interval 別の ACL 送信レイテンシ（15.00 ms リンクは 28.75 ms の半分以下）
```

### 新しいオプション

| オプション | 既定 | 意味 |
| --- | --- | --- |
| `--resend` | 1（旧 3） | 到達率が 1 通で 0.993〜1.000 なので 1 で足りる。連射は帯域を 3 倍にするだけ |
| `--link-policy` | single | 参加したら接続受け付けを止めて主リンク 1 本を維持。`multi` は器具が交互に切り合うので使わない |
| `--confirm-delay` | 0（自動） | 操作後に状態を確認するまでの秒数。0 なら実測 RTT の p90 × 2（200〜800 ms） |
| `--dup-window` | 0.4 | 同じ受信 PDU を重複と見なす窓（秒） |
| `--poll-interval` | 60 | この秒数ごとに状態を要求して健全性を確かめる。リンクは無通信でも維持されるが、死んでいることには気づけない（0 で無効） |
| `--dead-after` | 3 | 状態要求に全器具が連続で無応答だった回数。達したらリンクを作り直す |

### 新しい API

```bash
# ⭐ 収束を確認して返す（器具が実際にその状態になったか確かめる）
curl -X POST 'localhost:8080/level?bright=70&color=50&wait=1'
#   HTTP 200 detail=converged  … 確認できた（実測 277〜320 ms）
#   HTTP 504 detail=pending    … 送ったが確認できていない（P4: 成功と言わない）
#   HTTP 503 detail=queued     … 未接続。キューに保持して接続時に流す

# 計測値（RTT 分布・到達率・リンク寿命・切断理由・収束時間）
curl -s localhost:8080/metrics | python3 -m json.tool
curl -s 'localhost:8080/events?kind=link_down'

# 機械可読ログ（journald が長期ストレージになる）
sudo journalctl -u odelicd | grep '#M' | tail -20
#   #M link_up mac=EC:C5:7F:81:DE:CD links=1
#   #M joined mac=EC:C5:7F:81:DE:CD devices=2 n=1
#   #M adv state=nonconn why=joined
#   #M rtt vaddr=05000000 ms=62.3 kind=confirm sends=1
#   #M converged intent=9e8fd877 ms=312.1 attempts=1 target=all kind=level
```

### HCI トレースの取り方（btmon）

```bash
# ⚠️ /tmp は tmpfs（RAM 453 MB）。ルートの空きも 1.2 GB しかないので /var/log/odelic に置く
sudo systemd-run --unit=odelic-btmon --collect btmon -w /var/log/odelic/trace.btsnoop
#   … 観測 …
sudo systemctl stop odelic-btmon
sudo chmod a+r /var/log/odelic/trace.btsnoop
```

- btsnoop（バイナリ）は約 **131 KB/h**。テキスト出力（stdout）はその 4.3 倍なので捨てる
- **btmon は 1 プロセスだけにする**（モニタチャネルの読み出しが遅れると取りこぼす）
- `odelicd` と併走させても hci0 には干渉しない（`HCI_CHANNEL_MONITOR` を開くだけ）
- ⚠️ `btmgmt conn-info` は 使わないこと。実行と同時に
  `Frame reassembly failed (-84)` / `command 0x1405 tx timeout` が出て HCI ストリームが壊れた
- ⚠️ `hcitool rssi` は LE リンクでは必ず `ENOENT`（ツール側が `ACL_LINK` 固定で問い合わせるため）。
  RSSI を読むなら `hcitool cmd 0x05 0x05 <handle_lo> <handle_hi>` を使う（頻繁なポーリングは避ける）

### ⚠️ 踏んだ罠: `run-p2.sh` の `rm -f` が動作中の btmon の出力を消す

`sudo rm -f "$OUT"` は、先行して走っている `btmon -w` の出力ファイルを unlink する。
btmon は **削除済み inode に書き続ける** ので、ログは失われたように見えて実は生きている。

```bash
# 救出（fd から直接コピーする）
PID=$(pgrep -f 'btmon -w')
sudo ls -l /proc/$PID/fd | grep deleted        # → 7 -> /tmp/p2.btsnoop (deleted)
sudo cp /proc/$PID/fd/7 /var/log/odelic/rescue.btsnoop
```

実際にこれで 5 時間・接続 62 本ぶんのトレースを救出し、C33 の解析に使った。
