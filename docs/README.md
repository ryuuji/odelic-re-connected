# ドキュメント

## 目的から引く

| やりたいこと | 読むもの |
| --- | --- |
| **Raspberry Pi に入れる** | [../README.md](../README.md) のクイックスタート → [06-raspberrypi-setup.md](06-raspberrypi-setup.md) |
| ⭐ **プロトコルを知る・別の環境に移植する** | [02-protocol.md](02-protocol.md) |
| `odelicd` の HTTP API を使う | [06-raspberrypi-setup.md](06-raspberrypi-setup.md) の P5〜P7 |
| Google Home / Apple Home / Alexa から操作する | [07-matter.md](07-matter.md) |
| 設定ページとスマホ UI の中身を知る | [08-web-ui.md](08-web-ui.md) |
| **コードを直す・ビルドする・配備する** | [10-development.md](10-development.md) |
| 解析の経緯・失敗の記録を読む | [analysis/](analysis/) |

---

## 成果物の文書

| ファイル | 内容 |
| --- | --- |
| ⭐ [02-protocol.md](02-protocol.md) | **通信プロトコルの全容**（2900 行）。PDU 形式・照明コマンド・認証・暗号・状態応答・通信戦略の実測。このプロジェクトの中心的な成果 |
| [06-raspberrypi-setup.md](06-raspberrypi-setup.md) | Pi のセットアップと `odelicd` の運用（HTTP API・計測・常用コマンド） |
| [07-matter.md](07-matter.md) | **Matter 対応**。明るさ 1 軸への常夜灯の畳み込み、色温度、commissioning、踏んだ落とし穴 |
| [08-web-ui.md](08-web-ui.md) | 設定ページとスマホ UI（`odelic-web`）の設計。HTTPS・認証・ログのマスク |
| [10-development.md](10-development.md) | ⚠️ **ビルド順序とテストの罠**、実機への配備。最初に読むと詰まらない |

### 図

`images/` にスクリーンショットを置く。→ [images/README.md](images/README.md)

---

## 解析の記録 → [analysis/](analysis/)

| ファイル | 内容 |
| --- | --- |
| ⭐ [analysis/history.md](analysis/history.md) | **何を信じ、どこで間違え、どう覆したか。**5 回の誤りの記録 |
| [analysis/01-findings.md](analysis/01-findings.md) | 製品・公式アプリの調査結果（出典付き） |
| [analysis/03-instability.md](analysis/03-instability.md) | 公式アプリが不安定な原因（I1〜I11） |
| [analysis/04-analysis-procedure.md](analysis/04-analysis-procedure.md) | **解析手順書**（環境構築・静的解析・動的解析）。再現するならここ |
| ⛔ [analysis/05-app-design.md](analysis/05-app-design.md) | 作らなかった Android アプリの設計。⭐ 末尾の「Pi での実証から来る必須事項」は移植する人に有用 |
| [analysis/09-handoff-web-ui.md](analysis/09-handoff-web-ui.md) | 設定ページで踏んだ罠の記録 |
| [analysis/tools/](analysis/tools/) | 解析・検証に使ったスクリプト |

---

## ⚠️ 番号が歯抜けなのは意図的

`01`〜`10` のうち成果物側が `02` `06` `07` `08` `10`、解析側が `01` `03` `04` `05` `09`。
**解析当時の通し番号をそのまま維持している。**本文中に `[02 C33]` `[03 I7]` `[07 M9]`
という形の相互参照が多数あり、番号を振り直すと文章のほうが壊れるため。

---

## 書き方の約束

- **事実（出典あり）／推測（仮説）／検証済み**を明示する。`[事実]` `[推測]` `[要検証]`
- 覆った結論は**消さずに「⚠️ これは誤りだった」と残す**
  （同じ推論に至った人が同じ穴に落ちないため）
- ⚠️ **8 桁 ID の実値は書かない。**文書中の `12345678` はすべてプレースホルダ
