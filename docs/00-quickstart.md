# 00. クイックスタート — Pi の箱を開けてから照明が点くまで

最終更新: 2026-07-26

Raspberry Pi を触ったことがなくても、このページの順に進めれば動きます。
すでに Pi が動いていて SSH で入れる状態なら、[ステップ 4](#ステップ-4-1-行貼る) まで飛ばしてください。

| ステップ | 所要 |
| --- | --- |
| [1. 8 桁 ID を控える](#ステップ-1-8-桁-id-を控える) | 2 分 |
| [2. microSD に OS を焼く](#ステップ-2-microsd-に-os-を焼く) | 10 分（ほぼ書き込み待ち） |
| [3. 電源を入れて SSH で入る](#ステップ-3-電源を入れて-ssh-で入る) | 5 分 |
| [4. 1 行貼る](#ステップ-4-1-行貼る) | 5〜10 分 |
| [5. スマートフォンから開く](#ステップ-5-スマートフォンから開く) | 5 分 |
| [6. 音声で操作する（任意）](#ステップ-6-音声で操作する任意) | 10 分 |

---

## 用意するもの

| もの | 補足 |
| --- | --- |
| Raspberry Pi 3 以降 | Bluetooth 内蔵のもの。Pi 4 / 5 でも Pi Zero 2 W でも動きます |
| microSD カード | 8 GB 以上（16 GB あると余裕があります） |
| 電源アダプタ | Pi 4 / 5 は USB-C、Pi 3 は micro USB |
| PC | microSD を焼いて、SSH で入るために使います |
| ODELIC の照明器具 | 公式アプリでの登録を先に済ませてください |

⚠️ **Pi の置き場所** は、照明器具に Bluetooth が届くところにしてください。
1 台に届けば、残りはメッシュが中継します。

---

## ステップ 1. 8 桁 ID を控える

これが無いと先に進めません。書き込みを待っている間でもできますが、
先に済ませておくと途中で止まりません。

公式アプリ（`jp.co.odelic.smt.remote10`）を開き、メニュー画面の
`ID:12345678` という 8 桁の数字を控えてください。

⚠️ この 8 桁の **下位 4 桁はメッシュのパスワード** です。他人に見せないでください。
→ [README「8 桁 ID の調べ方」](../README.md#8-桁-id-の調べ方)

---

## ステップ 2. microSD に OS を焼く

[Raspberry Pi Imager](https://www.raspberrypi.com/software/) を PC に入れて起動します。

| 選ぶもの | 値 |
| --- | --- |
| デバイス | 手元の Pi のモデル |
| OS | 「Raspberry Pi OS (other)」→ **Raspberry Pi OS Lite (64-bit)** |
| ストレージ | 挿した microSD |

デスクトップ環境は要りません。Lite で十分です。

### ⭐ 書き込む前に「設定を編集する」を押す

ここで設定しておくと、**モニタもキーボードも要りません。**

| 項目 | 値 |
| --- | --- |
| ホスト名 | `odelic-pi` ⭐ 以降このページはこの名前で説明します |
| ユーザー名 / パスワード | 任意（例 `pi`） |
| Wi-Fi の SSID / パスワード | Pi を置く場所で届くもの |
| Wi-Fi の国 | `JP` |
| ロケール / タイムゾーン | `Asia/Tokyo` |
| SSH を有効化 | ✅ 「パスワード認証を使う」で構いません |

⚠️ ホスト名を変えた場合は、以降の `odelic-pi.local` を読み替えてください。

公開鍵で入りたい場合は、PC で鍵を作って「公開鍵認証のみを許可する」に貼り付けます。

```powershell
ssh-keygen -t ed25519 -C "odelic-pi"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

---

## ステップ 3. 電源を入れて SSH で入る

microSD を Pi に挿して電源を入れます。Wi-Fi につながるまで 1〜2 分かかります。

```powershell
ssh pi@odelic-pi.local
```

初回は `Are you sure you want to continue connecting?` と聞かれます。`yes` で進んでください。

### `odelic-pi.local` が引けないとき

| 試すこと | やり方 |
| --- | --- |
| もう少し待つ | 初回起動はファイルシステムの拡張で 2 分ほどかかります |
| 名前が引けているか見る | `ping odelic-pi.local` |
| IP を直接探す | `arp -a \| Select-String "b8-27-eb\|dc-a6-32\|e4-5f-01"`（Raspberry Pi の OUI） |
| Wi-Fi 設定を疑う | SSID・パスワード・国の指定を確かめて、microSD を焼き直すのが早いです |

mDNS（`.local`）は Windows 10 以降と macOS では標準で引けます。

### 2 回目から楽にする（任意）

PC の `%USERPROFILE%\.ssh\config` に追記しておくと `ssh odelic-pi` だけで入れます。

```
Host odelic-pi
    HostName odelic-pi.local
    User pi
    IdentityFile ~/.ssh/id_ed25519
```

---

## ステップ 4. 1 行貼る

Pi にログインした状態で、次の 1 行を貼ります。
`12345678` は **ステップ 1 で控えた自分の 8 桁 ID** に置き換えてください。

```bash
curl -fsSL https://raw.githubusercontent.com/ryuuji/odelic-re-connected/main/bootstrap.sh | sudo sh -s -- 12345678
```

5〜10 分かかります。終わると設定ページの URL と初期パスワードが表示されます。

⚠️⚠️ **初期パスワードはここでしか表示されません。** 必ず控えてください。

→ 表示される内容と、うまくいかないときの対処: [README「インストール」](../README.md#インストール)

---

## ステップ 5. スマートフォンから開く

PC ではなく、**スマートフォンのブラウザ**で開いてください。

```
https://odelic-pi.local:8443/
```

ステップ 4 で表示されたパスワードでログインします。

最初は証明書の警告が出ます。1 回だけ CA 証明書を入れれば消えます
（iOS は入れたあとに「証明書信頼設定」でオンにする手順まで必要です）。

→ 手順: [README「スマートフォンから操作する」](../README.md#スマートフォンから操作する)

### ⭐ ここでバックアップを取る

設定ページ →「設定」タブ →「バックアップと復元」→「バックアップをダウンロード」。

**入れた直後にやってください。** あとの手順で作られる Matter の登録情報を失うと、
すべての端末で登録をやり直すことになります。
→ [README「バックアップを取る」](../README.md#バックアップを取る)

---

## ステップ 6. 音声で操作する（任意）

Matter デバイスとして公開しているので、Google Home / Apple Home / Alexa から使えます。

| 追加先 | 事前準備 |
| --- | --- |
| Apple Home / Alexa | 要りません。設定ページ →「Matter」タブのコードを入れるだけです |
| Google Home | ⚠️ Google Home Developer Console でのテスト VID 登録が先に要ります（5 分） |

→ 手順: [README「Google Home に追加する」](../README.md#google-home-に追加する)

⚠️⚠️ 追加した直後にブリッジを再起動しないでください
（Google のハブが配下の照明を見失う既知の不具合を踏みます）。

---

## OS の設定を 1 か所だけ変えます

インストーラは `/etc/bluetooth/main.conf` の `MinConnectionInterval` を `6`（7.5 ms）にします。
これをしないと、器具が指定してくる接続間隔（15.00 / 28.75 ms）を Linux が
「短すぎる」と判断して **45 ms に書き換えてしまい**、反応が鈍くなります。

⚠️ 既に自分で別の値を入れている場合は**変更しません**。インストール中に警告が出るので、
必要なら表示されたコマンドで手を入れてください。

→ 実測と理屈: [06-raspberrypi-setup.md](06-raspberrypi-setup.md) の「P7. 通信戦略の最適化」

---

## つまずいたら

| 症状 | 見るところ |
| --- | --- |
| 照明が反応しない・一部だけ反応しない | [README「困ったとき」](../README.md#困ったとき) |
| パスワードを忘れた | `sudo /opt/odelic-web/reset-password.sh` |
| 8 桁 ID を間違えた | 設定ページ →「設定」→「ホーム ID」で入れ直せます |
| Google Home に追加できない | [README「追加に失敗するとき」](../README.md#追加に失敗するとき) |
| サービスが動いているか確かめたい | `sudo systemctl status odelicd odelic-matter odelic-web` |

---

## この先

| 読みもの | 内容 |
| --- | --- |
| [../README.md](../README.md) | できること・できないこと・HTTP API |
| [06-raspberrypi-setup.md](06-raspberrypi-setup.md) | Pi 上での運用、常用コマンド、手動での配置 |
| [07-matter.md](07-matter.md) | Matter 対応の詳細 |
| [02-protocol.md](02-protocol.md) | 通信プロトコルの全容 |