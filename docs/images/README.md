# 図とスクリーンショット

ドキュメントに貼る画像の置き場。**ここに何が必要かを書いておき、撮ったら置く。**

⚠️ 器具の MAC・8 桁 ID・Matter の手入力コードが写り込んでいないことを
置く前に必ず確認する。設定ページのログ画面は表示前にマスクされるが、
**設定画面の「ホーム ID」は伏せずに表示する仕様**（→ [08 W10-4](../08-web-ui.md)）なので、
そこは画像編集で潰すか、下のデモサーバ（プレースホルダの `12345678` が出る）で撮る。

---

## ⭐ 設定ページは開発機で撮れる

Pi も BLE も要らない。**本物のハンドラと本物の `public/` を、偽の `odelicd` /
ブリッジに繋いだデモサーバ** がある。

```bash
cd web
npm install && npm run build
npm run demo                    # → http://localhost:8080/（パスワードは起動時に表示）
PORT=18080 npm run demo         # ポートを変えるとき
```

⚠️⚠️ 必ず `localhost` で開く。セッション Cookie に `Secure` が付いているので、
LAN の IP やホスト名では **ログインが通らない**（ブラウザは `localhost` だけを
secure context として扱う）。

デモの中身は撮影に足りるよう作ってある。

- 器具 2 台（`PLTCEOC-05`・別グループ・一方は点灯 60% / 電球色寄り、一方は消灯）
- 器具名あり（「ダイニングの照明」「リビングの照明」）
- Matter は commissioning 済み・fabric 1
- ログは **マスク対象を含む**（ID の下位 4 桁・LOGINKEY / EVENTKEY・鍵・手入力コード・QR）
- 操作すると状態が変わる（スライダーを動かした結果が反映される）

→ 実装: [`../../web/demo/serve.mjs`](../../web/demo/serve.mjs)

---

## 撮影リスト

### 設定ページ（デモサーバで撮れる）

| ファイル名 | 内容 | 撮り方 |
| --- | --- | --- |
| `web-lights.png` | ⭐ 照明タブ。明るさ・色温度のスライダーと器具一覧。README の看板になる画像 | `npm run demo` → 「照明」 |
| `web-lights-phone.png` | 同じ画面をスマートフォンの幅で（ブラウザの開発者ツールで 390×844 など） | 同上 |
| `web-status.png` | 状態タブ。到達率・RTT 分布・リンク寿命 | 「状態」 |
| `web-settings.png` | 設定タブ。器具名・ケルビン・ホーム ID | 「設定」 |
| `web-matter.png` | Matter タブ。commissioning の状態と手入力コード | 「Matter」 |
| `web-logs.png` | ⭐ ログタブ。マスクが効いていることが見える（`•• •• •• ••`） | 「ログ」 |
| `web-login.png` | ログイン画面 | ログアウトするか別のブラウザで開く |

### 実機でしか撮れないもの（要作業）

| ファイル名 | 内容 | 撮り方 |
| --- | --- | --- |
| `google-home-card.png` | ⭐ Google Home の照明カード（明るさと色温度のスライダー） | スマートフォンで Google Home アプリのスクリーンショット |
| `google-home-list.png` | Google Home のデバイス一覧に 2 台出ているところ | 同上 |
| `install-console.png` | `sudo ./install.sh` の完了画面（URL と初期パスワード） | ⚠️ 初期パスワードを消してから置く |
| `metrics.png` | `curl /metrics` の出力 | ターミナルのスクリーンショット。⭐ テキストのままでも十分 |

⚠️ Google Home の画像には **家の名前や部屋名** が写ることがある。確認する。

---

## 置いたあと

貼る先。

| 画像 | 貼る場所 |
| --- | --- |
| `web-lights.png` / `google-home-card.png` | [`../../README.md`](../../README.md) の「できること」 |
| `web-*.png` | [`../08-web-ui.md`](../08-web-ui.md) の W4「画面」 |
| `google-home-*.png` | [`../07-matter.md`](../07-matter.md) の M10b |
| `install-console.png` | [`../../README.md`](../../README.md) の「インストール」 |

⚠️ **`.gitattributes` で `*.png` は `binary` 扱い** にしてある（改行を変換させない）。

⚠️ 幅は **1200px 以下** に落としてから置く。リポジトリを重くしない。
スマートフォンのスクリーンショットはそのままだと 3〜4 倍の解像度がある。
