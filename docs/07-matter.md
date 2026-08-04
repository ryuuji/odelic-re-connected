# 07. Matter 対応（Google Home / Apple Home / Alexa から操作する）

`odelicd` を HTTP で叩く **Matter ブリッジ** を別プロセスで動かし、
照明を標準の Matter デバイスとして公開する。実装は
[`matter/`](../matter)。

| | |
| --- | --- |
| 実装 | Node.js + [matter.js](https://github.com/matter-js/matter.js)（`@matter/main`） |
| Matter の構成 | ノード 1 個（ブリッジ）+ 器具ごとに Bridged エンドポイント |
| BLE | ⭐ 使わない。Pi の唯一の BLE アダプタは `odelicd` が握ったまま |
| `odelicd` への変更 | ⭐ なし。既存の HTTP API だけを使う |

---

## M1. ⭐ BLE アダプタの競合は起きない

Pi 3 の BLE アダプタは 1 個しかなく、`odelicd` が raw HCI で広告を出し続けている
（BlueZ の D-Bus 広告は `SupportedInstances = 0` で使えない。→ C19-5）。
Matter の commissioning に BLE を使う設計だと詰んでいた。

**[事実]** matter.js は BLE が任意（`@matter/nodejs-ble` を追加したときだけ使う）。
**[事実]** Matter の commissionable discovery には BLE 以外に DNS-SD（mDNS） があり、
すでにネットワークに居る機器はそれで発見される。
[事実] Matterbridge は BLE 非対応で Google Home に実運用されている。

→ オンネットワーク commissioning（mDNS / IPv6）を使えば BLE を一切触らずに済む。
実際に Pi 上で `_matterc._udp` の公開まで動作確認済み（→ M10b）。

---

## M2. 現在の操作が Matter で表現できるか

| `odelicd` の操作 | Matter 表現 | 可否 |
| --- | --- | --- |
| `POST /on` `/off` | OnOff クラスタ（0x0006） | ✅ 完全 |
| `POST /level?bright=`（5〜100% の 20 段） | LevelControl（0x0008）`CurrentLevel` | ✅ 量子化のみ |
| `POST /night?level=`（常夜灯 3 段） | 同じ LevelControl の下端（→ M3） | ✅ 1 軸に統合 |
| `POST /level?color=`（0〜100% の 21 段） | ColorControl（0x0300）`ColorTemperatureMireds` | ✅ 完全（2700〜6500K で確定・→ M4） |
| `GET /devices` の状態 | 属性 + Subscribe | ✅ |
| HTTP 503（未接続） | `BridgedDeviceBasicInformation.Reachable = false` | ✅ |
| HTTP 504（収束未確認） | 属性を実状態へ引き戻す（→ M7） | ◐ invoke は失敗させられない |
| `target=dev:<vAddr>` | Bridged エンドポイント 1 個／器具 | ✅ |
| `target=all` / `group:N` | Matter には出さない。送信の合成に使う（→ M6） | — |
| スポット（`0xC0` sub 2）/ サイド RGB（sub 3） | — | ❌ `odelicd` 未実装 |
| シーン / グループ設定変更 / タイマー | — | ❌ スコープ外（破壊的操作。→ README の「意図的に対応しないこと」） |

**表現できないものは無い。** 唯一の非自明点だった常夜灯は 1 軸に載せて解決した。

---

## M3. ⭐ 明るさ 1 軸マッピング（常夜灯を含む）

**物理的な明るさは 1 本の連続軸である**、という事実をそのまま Matter に写す。
常夜灯は主灯の最小値（5%）より暗いので、軸の下端を素直に延長したものになる。

```
Matter CurrentLevel      実体                      odelicd 呼び出し
────────────────────────────────────────────────────────────────────
      (OnOff = Off)      消灯                      POST /off
  1 ‥ 25                 常夜灯 最暗 (器具値 1)    POST /night?level=2
 26 ‥ 50                 常夜灯 中   (器具値 2)    POST /night?level=1
 51 ‥ 76                 常夜灯 最明 (器具値 3)    POST /night?level=0
────────────────── 境界 76/77 = 30% ──────────────────
 77                      主灯   5%                 POST /level?bright=5
 86                      主灯  10%                 POST /level?bright=10
  ⋮ (5% 刻み・20 段)                                    ⋮
254                      主灯 100%                 POST /level?bright=100
```

- 下端 30%（`nightBandPercent`）を常夜灯 3 段に、残りを主灯 20 段に割り当てる
- 状態を Matter に返すときの代表値は **13 / 38 / 63**（各帯の中央）
- 実装は [`src/mapping.ts`](../matter/src/mapping.ts)。
  往復は [`test/mapping.test.ts`](../matter/test/mapping.test.ts) で固定

### なぜ 1 軸が正しいのか

⭐ **排他関係が消える。** 常夜灯を点けると主灯は消え（C24-5）、主灯を点けると常夜灯が消える。
別エンドポイントに分けるとこの排他を Matter 上で辻褄合わせする必要があるが、
1 軸なら「スライダーの位置は 1 つ」という自明な性質になる。

副産物として、Google Home のライト一覧が器具数どおりになり、
「照明を 10% にして」で常夜灯、「70% にして」で主灯、と音声が自然に通る。

### ⭐ 公式アプリが同じ考え方をしていた

**[事実]** 天井灯でない器具（`isCeilingLight() == false`）に対して、公式アプリは
`setlight(vAddr, 0, level + 17, 0)` = 明るさコード 17/18/19（= 15% / 10% / 5%）を
常夜灯の代用として送る（C24）。

→ つまり公式アプリも「常夜灯は明るさ軸の下端」と扱っている。
本実装で常夜灯非対応の器具の下端 30% を主灯 5〜15% に割り当てるのは、これと一致する。

### 決めごと

- ⚠️ `nightBandPercent` ちょうどの値（既定なら「30%」）は境界に当たる。
  Matter level への丸め方はコントローラ依存なのでどちら側に落ちるかは断定できない。
  「30% にして」を確実に主灯にしたいなら 25 に下げる
- ⚠️⚠️ OnOff の `On` は消灯前の位置で送り分ける。
  Matter の `On` は「消灯前の `CurrentLevel` に戻す」意味だが、
  protocol の `ON`（`37 37`）は主灯の記憶値しか戻さない。

  | 消灯前の位置 | 送るもの | 理由 |
  | --- | --- | --- |
  | 主灯の帯 | `POST /on` | ⭐ 器具が記憶している実値に戻る。Matter の意味と一致 |
  | 常夜灯の帯 | `POST /night?level=<段>` | `/on` を送ると常夜灯だったのに主灯が点いてしまう |

  ⭐ 消灯中も `CurrentLevel` を触らない設計（`deviceStateToMatter` が
  消灯時に `level: null` を返す）ので、消灯前の段がそのまま残っており復元できる。

  主灯の場合、戻った実値は直後の `0x71` 応答で分かるので `CurrentLevel` に反映する。

---

## M4. 色温度

Matter は mired（= 1,000,000 / K）で指定する。プロトコル側は 0〜100% の抽象値なので、
ケルビンへの対応づけが必要になる。

| 設定 | 値 | 備考 |
| --- | --- | --- |
| `colorTempMinKelvin` | 2700 | `color = 0%` 側（電球色）。✅ 製品スペックで確認済み |
| `colorTempMaxKelvin` | 6500 | `color = 100%` 側（昼光色）。✅ 製品スペックで確認済み |
| `colorTempInverted` | false | ✅ 実機の目視で確認済み（下記） |

- `ColorTempPhysicalMinMireds = 154`（6500K）/ `ColorTempPhysicalMaxMireds = 370`（2700K）
- `ColorMode` / `EnhancedColorMode` = 2（ColorTemperatureMireds）
- ⚠️ **常夜灯中に色温度コマンドが来たら送らない。** 常夜灯に色温度は無いし、
  色を変えたいだけで主灯が点いてしまうのは望ましくない。次に主灯を点けたときに反映する

### ✅ ケルビンを確定（2026-07-26）— 仮定は残っていない

**[事実]** 製品スペックの調色範囲は 電球色 2700K 〜 昼光色 6500K。

**[事実]** `POST /level?bright=80&color=0&target=all` を送ったら
電球色（暖色）になった（目視）。ブリッジは `370 mired` として Matter に出していた。

→ ⭐ 両端の絶対値も向きも確定した。`colorTempMinKelvin = 2700` /
`colorTempMaxKelvin = 6500` / `colorTempInverted = false` が正しい値。
この節に仮定は残っていない。

```
color   0% ─ 電球色 2700K ─ 370 mired ← ColorTempPhysicalMaxMireds
color  50% ─       3800K ─ 262 mired
color 100% ─ 昼光色 6500K ─ 154 mired ← ColorTempPhysicalMinMireds
```

⚠️ 中間値は mired 上で線形に割り付けている（21 段）。器具側が K で線形なのか
mired で線形なのかは未確認だが、両端が合っているので実用上の影響は小さい。

---

## M5. ⚠️ 明るさと色温度は必ず 1 通に合成する

**プロトコルは明るさと色温度を 1 コマンドで運ぶ**（`0xC0` sub 0 / `0xC1`）が、
Matter は `MoveToLevel` と `MoveToColorTemperature` を **別々に** 送ってくる。

- 属性変化を 120 ms デバウンスしてから `POST /level?bright=&color=` を 1 回 送る
- ⭐ C33-5「1 操作 = 1 通で足りる」（到達率 0.993〜1.000）と、
  C28 で観測した公式アプリの「143 ms 間隔で 16 連射」という反面教師に沿う
- ⭐ コマンドではなく属性変化に反応する。`MoveToLevel` / `Move` / `Step` /
  `MoveToLevelWithOnOff` を個別に実装せず、`currentLevel$Changed` などを購読すれば
  全部同じ経路で拾える。遷移の途中値もデバウンスが吸収して最終値だけが送られる

---

## M6. 複数器具

| | |
| --- | --- |
| 同一性 | ⭐ 器具の MAC。⚠️ vAddr は変わる（実機で `01` → `05` に変わった）ので使わない。**同じ MAC が 2 つの vAddr で同時に来ることもある**（→ M6-4 末尾 / C34） |
| エンドポイントの増減 | `GET /info` の差分で動的に追加・撤去。再 commissioning は不要 |
| 撤去の猶予 | すぐ消さず `Reachable = false`。`missingGraceSec`（既定 600 秒）超で撤去 |
| 通電が切れた器具 | ⭐ `Reachable = false` にする。Matter からは消さない（→ M6-4） |
| 表示名 | 設定ファイルの MAC → 名前。無ければ `ODELIC <MAC 下 6 桁>` |

### M6-1. ⭐ 能力は `UtilDeviceFW` の述語で決まる

⚠️ **`CFormat.getLinearFormatCodeBy` の「調光のみ / ON-OFF のみ / 調光+色 / 調光調色」の
4 系統は使えない。あれは `ProductorCode` enum で分岐する LC シリーズ用の別系統**
（→ C15-10）で、メッシュ照明の明るさ・色温度は `color/5` と `(100-bright)/5` の
直接計算（→ C18-4）。メッシュ照明の能力判定は `UtilDeviceFW` にある。

**[事実]** 逆コンパイル結果から転記した述語（実装は
[`src/capability.ts`](../common/src/capability.ts)）。

| 述語 | 製品コード | Matter |
| --- | --- | --- |
| `isInterface` + センサー・ドングル | `0x1B` `0x1C` `0x1D` `0x4A` `0x88` | ⭐ エンドポイントを作らない |
| `isOnlyLightness` | `0x8A` `0x91` の 2 つだけ | Dimmable Light `0x0101` |
| それ以外（既定） | — | Color Temperature Light `0x010C` |
| `isCeilingLight` | 下記 | 専用ナイトライトに対応 |

⭐ `isOnlyLightness` が 2 コードしかない = ほぼ全ての器具が調光調色。
未知の製品コードを Color Temperature Light として出す既定は妥当。

⭐ **センサーの除外は必須。** 除外しないと Google Home に「ライト」として出て、
「全部消して」でセンサーに照明コマンドを投げてしまう。

### M6-2. ⚠️ `isCeilingLight` の一覧を訂正

**C24 に載せた一覧は不完全だった。** 逆アセンブルの `switch` を読み切った全体は次のとおり。

```
0x04〜0x0A, 0x25, 0x26, 0x2B, 0x40〜0x43, 0x4B〜0x53,
0x60, 0x63〜0x66, 0x6B, 0x6D, 0x6E, 0x71, 0x75, 0x76, 0x78〜0x7D, 0x80
```

C24 では `0x40`〜`0x43` / `0x4B`〜`0x53` / `0x63`〜`0x66` / `0x78`〜`0x7D` が漏れていた。
手元の器具 `0x2B`（`PLTCEOC-05`）が含まれる点は変わらない。

### M6-5. ⭐⭐ 器具の名簿を永続化する（再起動で消さない）

**[事実]** `odelicd` は器具一覧をメモリにしか持っていない
（永続化しているのは広告アドレスと コントローラ識別子だけ）。再起動すると空になり、
器具が接続してきて `_auto_discover` が走るまで復元されない。

⚠️⚠️ そして壁スイッチで消えている器具は接続してこないので、永久に再発見されない。

名簿が無いと次の事故が起きる（実装当初はこうなっていた）。

1. 夜に壁スイッチで片方を消す
2. 朝までに Pi か `odelicd` が再起動する
3. その器具は `GET /info` に現れない
4. `missingGraceSec`（当時 600 秒）超で `endpoint.delete()` が走る
5. ⚠️ `delete()` は **永続データを消す** ので `uniqueId` が失われる
6. 通電すると 別の新しいデバイス として Google Home に出る
   → 部屋割り・名前・自動化の設定が失われる

#### 対処

| | |
| --- | --- |
| 名簿 | `<storagePath>/fixtures.json`（既定 `/var/lib/odelic-matter/fixtures.json`） |
| 内容 | MAC / 製品名 / 製品コード / ファーム / 最終確認時刻 |
| 起動時 | ⭐ `server.start()` の前に名簿からエンドポイントを復元し、`Reachable = false` で出す（→ M6-6） |
| 保存 | 一時ファイル + `rename`。⚠️ 書き込み中の電断で名簿が壊れないようにする |
| 撤去 | ⭐ 既定でしない（`missingGraceSec: 0`）。「見えない」は撤去の理由にならない |
| 器具を本当に外すとき | `fixtures.json` から該当行を消して再起動する |

⭐ `missingGraceSec` の既定を 600 → 0 に変えた。壁スイッチで消えている器具が
`odelicd` から見えないのは **通常状態** なので、それを撤去の根拠にしてはいけない。

#### ⚠️⚠️ M6-6. エンドポイントは「オンラインになる前」に揃えること

**[事実]** エンドポイントを `server.start()` の後に追加していたとき、
再起動するたびに Google Home が「デバイスが追加されました」と通知していた。

ログの順序が原因だった。

```
06:40:41.411  going online            ← 器具 0 台の空の Aggregator でオンライン
06:40:42.621  Publishing operational  ← mDNS 公開
06:40:43.756  endpoint#3 ready        ← ⚠️ 器具はここで初めて追加（2.3 秒後）
06:40:44.290  endpoint#2 ready
```

Google Home はオンライン直後に Aggregator の `PartsList` を読むので、
0 台 → 2 台の変化を「新しいデバイスが追加された」と解釈する。

→ ⭐ `server.start()` の前にエンドポイントを足す（matter.js 公式のブリッジ例も同じ順序）。

```
06:48:06.416  endpoint#3 ready        ← 器具を先に揃える
06:48:07.057  endpoint#2 ready
06:48:07.072  going online            ← ⭐ 最初から 2 台でオンライン
```

**[事実]** この修正後、再起動しても Google Home に追加通知は来なくなった（実機で確認）。

⚠️ `server.start()` の前は `endpoint.set()` が使えない。そのため
`Reachable` の初期値はコンストラクタ引数（`initialReachable`）で渡す。

⚠️ エンドポイント番号は元から安定していた（`#2` = 81:DE:CD / `#3` = 80:28:A6）。
matter.js が MAC 由来のエンドポイント id で番号を永続化しているため、
名簿の並び順（MAC 昇順）で作り直しても番号は変わらない。
つまり原因は番号でも `uniqueId` でもなく、空の状態で公開してしまう窓 だけだった。

⭐ なお 器具を本当に増やしたときは通知が出る（オンライン後に `PartsList` へ
追加されるため）。これは正しい挙動なのでそのままにしている。

#### 再起動でどうなるか

| 再起動の種類 | 器具 |
| --- | --- |
| ブリッジ（`odelic-matter`） | ✅ 残る（matter.js が属性を永続化 + 名簿から復元） |
| `odelicd` / Pi 本体 | ✅ 残る（名簿から復元。見えるまで `Reachable = false`） |
| ⚠️ `/var/lib/odelic-matter` を消す | ❌ 名簿も `uniqueId` も失われ、再 commissioning が必要 |

### M6-4. ⭐ 片方の通電が切れたときの挙動

**[事実]** `odelicd` は一度見つけた器具を `devices` から削除しない。
つまり `GET /info` に居ることは、その器具が生きている証拠にならない。

これを踏まないと、**通電が切れた器具が「最後に分かっていた状態」のまま
Google Home 上でオンライン表示され続ける**（実際に一度そうなっていた）。

**[事実]** `odelicd` は不在を判定している。`GET /metrics` の
`delivery[<vAddr>].absent` が、状態要求に 3 回連続で応答がない 器具に立つ
（実装のコメントに「電源が落ちている器具で到達率を汚さない」とある）。

→ ブリッジはこれを見て `Reachable = false` にする。

| 通電が切れたとき | どうなるか |
| --- | --- |
| Matter から消えるか | ❌ 消さない。一時的な停電で Google Home からライトが消えると困る |
| オフライン表示になるか | ✅ なる（`Reachable = false`） |
| もう片方の器具 | 影響を受けない（器具ごとに独立） |
| 復帰したとき | 応答が返り次第 `Reachable = true` に戻る |

#### ⭐ 検知を数分から数十秒に縮める（追い打ちの状態要求）

⚠️ `absent` は **3 回連続** の取りこぼしで立つ。定期要求だけに任せると
`statusRefreshSec × 3` かかる（当初は 60 秒 × 3 ＝ **約 3 分** だった）。

そこで 1 回目の取りこぼしを見つけた時点で、こちらから追い打ちをかける。

1. `GET /events?since=<前回>&kind=miss` を毎ポーリング（1 秒）で読む。
   ⭐ これは BLE を使わない（odelicd のイベントリングを読むだけ）
2. `miss` を見つけたら、その器具に `POST /status?target=dev:<vAddr>` を
   900 ms 間隔で 2 回 打って streak を完成させる
3. 直後に `/metrics` を引いて `absent` を確定させる

| | 所要 |
| --- | --- |
| 定期要求で 1 回目の取りこぼしを見つけるまで | 最大 `statusRefreshSec`（既定 30 秒） |
| 追い打ちで `absent` が立つまで | 約 2 秒 |
| 合計（最悪） | 約 32 秒（従来 約 180 秒） |

⚠️ **間隔 900 ms は odelicd の `probe_window_ms`（RTT p90 × 4・下限 500 ms）より
長くする必要がある。** 短いと前の要求の窓が閉じておらず、取りこぼしとして記録されない。

⚠️ 既に `absent` と分かっている器具には追い打ちしない（無駄な BLE を使わない）。
同じ器具への追い打ちは 20 秒に 1 回までに制限している。

⚠️ `statusRefreshSec = 0` にすると定期要求が止まるので、
通電切れは操作したときしか分からなくなる。

⚠️ `missingGraceSec` による エンドポイントの撤去は発火しない
（MAC が `/info` から消えることがないため）。器具を本当に外したときは
`odelicd` を再起動すると一覧から消える。

#### ⚠️⚠️ `absent` をそのまま信じてはいけない（同じ MAC が 2 行来る・C34）

**[事実]** `GET /info` に **同じ MAC が 2 つの vAddr で並ぶ**ことがある
（2026-08-03 実機。正体は **自分の vAddr** だった → C34-4）。片方は一度も応答しないので
`absent` が立ち、畳まずに回すと後から来た幽霊が上書きして
**100% 応答している照明が `Reachable = false` になる。**

→ `foldDevicesByMac()`（`@odelic/common`）で MAC ごとに 1 台へ畳んでから使う。
残すのは **`absent` でない方**（＝実際に応答している方）。
`odelicd` 側でも束ねているが（`vaddr_alias`）、受け取る側でも畳んで二重に守る。

⭐ さらに `odelicd` は **一度も状態要求に答えない登録を一覧から外す**（C34-5）。
畳めるのは MAC が一致する幽霊だけなので、**MAC が違う幽霊が
「存在しない照明」として Matter に増えるのを防ぐ**のはこちらの仕組み。
⚠️ 通電が切れた器具（一度は答えている）は外れない。M6-4 の扱いは変わらない。

⚠️ 畳んだ vAddr には追い打ちの状態要求を打たない（BLE の無駄）。

### M6-3. 一斉操作は 1 通に合成する

器具ごとのエンドポイントにすると Google Home の「全部消して」が **N 通** になる。

- デバウンス窓の中で **既知の全器具が同じ状態を指示された** なら、
  `target=all` を 1 通 送る（`0xC0` + チャネル `0x2A`）
- ⭐ `target=all` は最も実績のある経路。合成でそこに戻せる

---

## M7. ⚠️ Matter の invoke には失敗を返せない

属性変化に反応する設計（M5）なので、**matter.js はこちらが `odelicd` を叩く前に
invoke へ Success を返している**。「送ったが収束しなかった（HTTP 504）」を
invoke の失敗として返す方法がない。

代わりに次の 2 つで正直さを保つ（→ [03-instability.md](analysis/03-instability.md) の P4）。

1. 失敗したら属性を **器具の実状態へ引き戻す**（Google Home の表示が元に戻る）
2. 状態が分からない器具は `Reachable = false` にする

invoke を失敗させるにはクラスタのコマンドハンドラを個別に上書きし、
`Move` / `Step` の意味論まで自前で持つ必要がある。まずは上の 2 つで運用する。

なお `?wait=1&timeout=1500` は使っているので、成功した場合は
「器具が実際にその状態になった」ことを確認済みという意味になる（収束は実測 277〜320 ms）。

---

## M8. 状態の取り込みと BLE の消費

⭐ **状態の読み取りでは BLE を増やさない。** 定期的に使うのは
壁スイッチ追従の `POST /status`（既定 60 秒に 1 通）だけ。

| 呼ぶもの | BLE | いつ |
| --- | --- | --- |
| `GET /info` | 使わない（キャッシュを読むだけ） | 1 秒ごと |
| `POST /on` `/off` `/level` `/night` | 1 通 | 操作したとき |
| `POST /status` | 1 通 | `statusRefreshSec` ごと（既定 60 秒） |
| `POST /ping` `/discover` | 各 1 通 | MAC / 製品コードが欠けているときだけ |

- `odelicd` は自分のコマンド後と、**他コントローラの操作を観測したとき** に自動で
  状態を確認する（`_schedule_confirm`）。公式アプリからの操作も 1 秒以内に Matter へ届く（C28）
- ⚠️ 壁スイッチでの変更だけは観測できない（メッシュにコマンドが流れない）。
  これを拾う `statusRefreshSec`（既定 60 秒）が唯一の定期 BLE 消費。
  HCI ログを採取して通信を測るときは 0 にする

---

## M9. 実装で踏んだ落とし穴

統合テスト（[`test/bridge.test.ts`](../matter/test/bridge.test.ts)。偽 `odelicd` を
localhost に立て、実際に ServerNode を起動する）が **型検査では出ない実バグを 4 つ** 掘り出した。
どれも実機で確実に起きるものだった。

| # | 症状 | 原因と対処 |
| --- | --- | --- |
| 1 | エンドポイントの初期化が失敗する | `colorControl.colorMode` / `enhancedColorMode` は必須属性。設定しないと Conformance `M` で落ちる |
| 2 | 本物のコントローラ操作が無視される | エコー抑止の基準値を「パッチを当てたときだけ」更新していたので古くなっていた。→ 常に更新する |
| 3 | 送信が二重になる・順序が入れ替わる | `setInterval(() => void poll())` で await していなかったためポーリングが重なる。→ 自己再スケジュール型にして 1 周ずつ直列に回す |
| 4 | ⭐⭐ 古い値がコマンドとして送られる | ポーリングの書き戻しが、まだ送信していないユーザー指示を上書きしていた（Google Home で 80% にした 50 ms 後にポーリングが 30% へ引き戻し、その 30% が送られる） |
| 5 | ⭐ Pi 実機でだけ古い値が送られる | ユーザー操作より前に始まった書き戻しが遅れて着弾し、それが新しいユーザー操作として再解釈されていた。→ 世代番号（`intentSeq`）で、計算中に操作が入った書き戻しを捨てる |
| 6 | ⭐⭐ 色温度だけ 1 つ前の値が送られる | `applyFromDevice` の先頭で `colorPercent` をpin の判定より前に無条件で器具の現在値に上書きしていた。他のフィールドは守ったのにこの 1 行だけ漏れていた。→ `!isPinned("mireds")` を条件に加える |

⚠️ #6 は Google Home で実際に動かしたログから見つかった。テストも実機も通ったあとの発見。

```
05:45:49 moveToColorTemperature mireds: 294  → 送信: 色温度 65%
```

`294 mired` は 35% が正解（`(370-294)/216`）。65% は 1 つ前の値。
色温度スライダーを素早く動かすと最後の指示が失われていた。
→ 回帰テストで同症状（`actual '65' / expected '35'`）を再現させてから修正した。

⭐ **教訓: 同じ「pin 漏れ」を 2 度踏んだ。** 書き戻し（`applyFromDevice`）で
Matter 側の望み値に触る箇所は、すべて `isPinned()` を通す必要がある。

⚠️ #5 は開発機（速いマシン）では一度も再現せず、Pi 3 で初めて出た。
非同期の競合は速いマシンでは隠れる。実機でテストを走らせることに意味がある。

`install.sh` が Pi 上で `npm test` を実行するようにしてあるのはこのため。

### #4 の対処（設計変更）

2 つ入れた。

1. **送信待ち・送信中のフィールドは器具の状態で上書きしない**（`touched` / `inFlight` で pin）
2. ⭐ `endpoint.state` を後から読まない。`$Changed` で届いた値を意図の正とする

2 が本質。`endpoint.set()` は非同期なので、飛行中にコントローラの書き込みが来ると
**後着の書き戻しが上書きする**。属性を後から読む設計そのものが競合を含んでいた。
イベントで届いた値こそユーザーの意図なので、それを保持して使う。

### ⚠️ systemd の締め付けで mDNS が死ぬ

**[事実]** `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` にすると
起動時に落ちる。

```
[!] 起動に失敗: Error: MdnsService unavailable due to initialization error
```

⭐ **`AF_NETLINK` が必須。** Node の `os.networkInterfaces()`（= `getifaddrs`）は
Linux では netlink ソケットを使うので、落とすとインターフェースを列挙できず
mDNS が初期化に失敗する。手動起動では再現しないので原因が分かりにくい。

[事実] `avahi-daemon` が 5353 を握っていても matter.js は共存できた
（両方 `SO_REUSEADDR` で bind する）。5353 の衝突は原因ではなかった。

### ⚠️⚠️ commissioning 直後にブリッジを再起動してはいけない

**[事実]** 2026-07-26 の commissioning は成功した（`Commissioned fabric: 5BC926ABB9043DA3`）が、
その直後にログレベルを変えるためサービスを 2 回再起動したところ、
**Google Home 上で配下の器具が「無効」表示** になり、ハブからの CASE セッション・
属性読み取り・購読が一切来なくなった。

[事実] ブリッジ側は健全だった（運用時広告 `_matter._tcp` に A と AAAA 両方、
エンドポイント 3 個が ready、`uniqueId` / `reachable` あり）。

[事実] これは Google 側の既知バグ。「Matter ブリッジが再起動すると Nest ハブが
配下の器具を失う。ブリッジ本体はオンラインなのに器具だけオフラインのまま残り、
やがて一覧から消える」という報告がある
（[Nest Community](https://www.googlenestcommunity.com/t5/Smart-Home-Developer-Forum/Google-Nest-loses-Matter-bridged-devices-after-Matter-bridge-reboot/m-p/666607) /
[issuetracker 393395943](https://issuetracker.google.com/issues/393395943)）。

対処（報告されている順）

1. Google スピーカー（Nest ハブ）を再起動する — これで解消した報告がある
2. 駄目なら Google Home からブリッジを削除して再登録し、その後は再起動しない

⭐ 運用ルール: 設定変更やデプロイはまとめて行い、commissioning の直後は触らない。

### ⚠️ 切り分けで踏んだ罠（診断の教訓）

原因の切り分けで 2 回誤った。同じ穴を踏まないための記録。

| 誤った見立て | 実際 |
| --- | --- |
| 「`uniqueId` が欠けているから無効」 | ❌ matter.js が未指定なら自動生成する（`if (uniqueId === void 0)`）。最初から在った。しかも `"FN"` 品質で永続化され、こちらの明示指定より生成値が優先される |
| 「AAAA レコードが無いから届かない」 | ❌ 在った。⚠️ `avahi-resolve -n` は既定で A しか返す。AAAA を見るには `-6` が必要 |

もう 1 つ: 運用時アドバタイズの service type は `_matter._tcp`（`_matter._udp` ではない）。
commissionable は `_matterc._udp`。ここを間違えて「広告が出ていない」と誤読した。

```bash
# 正しい確認コマンド
avahi-browse -tpr _matterc._udp   # commissioning 受付中（完了後は消える）
avahi-browse -tpr _matter._tcp    # 運用時（commissioning 後はこちら）
avahi-resolve -n  <host>.local    # A のみ
avahi-resolve -6 -n <host>.local  # ⭐ AAAA を見るにはこれ
```

### ⚠️⚠️ 設定した値が直後に書き換えられる（同期のずれ）

**[事実]** Google Home でスライダーを動かすと、設定した値が直後に別の値へ動いていた。
実機ログで確認できる。

```
Invoke « moveToLevelWithOnOff level: 92   ← Google Home が指示
  Matter へ反映 OnOff=on level=96          ← ⚠️ 96 に書き換えている
Invoke « moveToColorTemperature 227 mired
  Matter へ反映 ... / 230 mired             ← ⚠️ 230 に書き換えている
```

原因は 2 つ重なっていた。

#### 原因 1: 量子化の代表値に書き換えていた

器具は主灯 20 段・色温度 21 段しか持たないので、level `92` と `96` は
**どちらも「主灯 15%」**。段の代表値（`96`）を書き戻していたため、
物理状態としては正しいのに **スライダーが動いた**。

→ ⭐ 同じ段なら書き換えない（`sameTarget()` / 量子化後の `color%` で比較）。
`92` も `96` も同じ状態を表すので、ユーザーの値を保っても嘘にならない。

⚠️ 比較対象は `endpoint.state` ではなく `wanted`（`$Changed` が同期的に更新する
「意図」）にする。`endpoint.state` は読む時点に依存するので判定がぶれる。

#### 原因 2: 古い `/info` を適用していた

`GET /info` の取得を始めた時点では最新でも、**その後にコマンドを送れば古い情報になる。**
それを適用すると `wanted` が巻き戻り、次の書き戻しで代表値に書き換えられてしまう。

診断ログで確定させた。

```
Matter 側で level = 92 に変わった              ← ユーザーが設定
→ 明るさ 15% / 色温度 35%                      ← 送信
Matter へ反映 OnOff=on level=217（主灯 80%）    ← ⚠️ 古い情報を適用
[診断] mireds 書き換え wanted=262 want=230 pinned=[]
```

→ ⭐ **2 つのガードで古い情報を捨てる。**

| ガード | 捨てる条件 |
| --- | --- |
| `lastSettleAt` | コマンドの反映より前に取得した情報 |
| `cmdEpoch` | 取得中にコマンドを送った場合 |

⚠️ ピン（`touched` / `inFlight`）だけでは足りない。コマンドが完了すると
`endSend()` がピンを外すので、その後に着弾した古い情報を止められない。

⭐ この不具合は テストが 8 回に 1 回落ちる 形で現れ、
アサーションに実測値を入れる → 内部値の診断ログを出す、の 2 段で特定できた。
「たまに落ちる」を放置しなかったのが効いた。

### エコー抑止

器具の状態を属性に書き戻すと `$Changed` が飛ぶので、素朴に実装すると無限ループになる。
「器具の状態としてこちらが書いた値」と一致するなら送らないという値比較だけで止める。

⚠️ 「書き戻し中フラグ」方式にしてはいけない。書き戻しの `await` 中に本物の
コントローラ操作が来ると取りこぼす（#2 と同じ穴）。値比較なら非同期のタイミングに依存しない。

---

## M10. 手順

### インストール

```bash
# 開発機からソースを送る
cd matter
tar czf - src test package.json package-lock.json tsconfig.json \
    config.example.json install.sh odelic-matter.service |
  ssh odelic-re-connected "mkdir -p /tmp/odelic-matter-src && tar xzf - -C /tmp/odelic-matter-src"

# Pi 上でインストール（Node は apt から入る。Debian 13 の nodejs は 20.19）
ssh odelic-re-connected "cd /tmp/odelic-matter-src && sudo ./install.sh http://127.0.0.1:8080"
```

`install.sh` は依存の取得・ビルド・**テストの実行** まで行う（テストは BLE を使わない）。

### commissioning（Google Home への参加）

1. Google Home Developer Console でプロジェクトを作り、**Matter integration** を追加。
   テスト VID `0xFFF1` + PID `0x8001` を登録する。
   ⭐ これが無いとテスト VID の機器は Google Home が commissioning を拒否する
2. `sudo journalctl -u odelic-matter -n 60` で手入力コード（11 桁）を取る
3. Google Home アプリ →「デバイスを追加」→「Matter デバイス」→ コードを入力
4. ⚠️ 失敗時
   - `Something Went Wrong` → **Android の Google Home アプリが country code を
     送らない既知のバグ**。iPhone の Google Home アプリで実施すると通る
   - 回避経路: `chip-tool` / Apple Home / Home Assistant で先に commissioning し、
     multi-admin で Google Home に共有する
   - mDNS が届かない → Pi と Google スピーカーが同一 L2 か、AP アイソレーション、
     IPv6（`ip -6 addr`）、`avahi-daemon` と 5353 の衝突を確認

### 管理

```bash
sudo systemctl status  odelic-matter
sudo journalctl -u odelic-matter -f
sudo systemctl edit    odelic-matter    # Environment=MATTER_LOG_LEVEL=debug で詳細ログ
```

⚠️ `/var/lib/odelic-matter` を消すと **再 commissioning が必要** になる。

---

## M10b. ⭐ 実機で確認できたこと（2026-07-26）

Raspberry Pi 3（aarch64 / Debian 13 / Node 20.19.2）に配備して常駐させた。

### 動いたこと

```
＋ Matter に追加: ダイニングの照明 (EC:C5:7F:81:DE:CD) colorTemperature / 常夜灯あり
   — 調光調色として扱う（isOnlyLightness = false）。天井灯タイプなので常夜灯に対応
＋ Matter に追加: リビングの照明 (EC:C5:7F:80:28:A6) colorTemperature / 常夜灯あり
Matter ノード 1 個 / 器具 2 台
```

| 項目 | 結果 |
| --- | --- |
| mDNS の公開 | ✅ `_matterc._udp` を publish（BLE 不使用） |
| 手入力コード | ✅ 出力される（`journalctl -u odelic-matter`） |
| 能力判定 | ✅ 実機の `product_code = 43`（`0x2B`）から調光調色 + 常夜灯を正しく判定 |
| 器具の同一性 | ✅ MAC で安定。⚠️ vAddr は実際に `01` → `05` に変わっていた（MAC を使う判断が正しかった） |
| 状態の永続化 | ✅ 再起動しても Matter 属性が保たれ、器具と一致していれば書き戻しが起きない |

### ⭐ 1 軸マッピングを実機の値で確認

起動時、2 台が **別々の常夜灯レベル**（器具値 3 と 2）で点いていた。
そこで 1 台を常夜灯レベル 1 に変えて往復させた。

| 指示 | 器具が返した値 | Matter に反映された値 |
| --- | --- | --- |
| `POST /night?level=1`（50 ms で HTTP 200） | `night=2` | `level=38`（= 常夜灯 レベル 1） ✅ |
| `POST /night?level=0` | `night=3` | `level=63`（= 常夜灯 レベル 0） ✅ |

⭐ 常夜灯 3 段が Matter の明るさ軸の別々の位置に正しく載った。
変化のあった 1 台だけが更新され、もう 1 台は触られていない。

### 退行なし（C33 のベースラインと比較）

| 指標 | C33 のベースライン | Matter 導入後 |
| --- | --- | --- |
| 到達率（EWMA） | 0.993〜1.000 | 1.000（91 サンプル・2 台とも） |
| リンク寿命 | p50 152 秒 | 5311 秒・切断 0 回（`up_count 1 / down_count 0`） |
| 状態要求 RTT | p50 50〜78 ms | p50 57.3 / p90 109.3 / p99 129.4 ms |

| プロセス | RSS |
| --- | --- |
| `odelicd`（Python） | 37.8 MB |
| `odelic-matter`（Node） | 125.0 MB（`MemoryMax=320M` 内） |

RAM 905 MB のうち使用 419 MB。⭐ **Pi 3 で共存できる。**

### ✅ 色温度も確定（同日）

`color=0` を送ったら電球色になった。`target=all` の 1 通で **347 ms で収束確認**
（`?wait=1` が HTTP 200）。ブリッジは `level=217`（= 主灯 80%）/ `370 mired` として反映した。
製品スペックの調色範囲も **2700〜6500K** と確認できたので、設定に仮定は残っていない。
→ 詳細は M4。

### ✅ Google Home から操作できるようになった（2026-07-26）

**[事実]** Google Home Developer Console にテスト VID/PID（`0xFFF1` / `0x8001`）の
Matter integration を登録したのち、オンネットワーク commissioning で参加に成功。
実際に操作したログ（`MATTER_LOG_LEVEL=info`）で往復が確認できた。

| Google Home が送ったもの | ブリッジが odelicd へ |
| --- | --- |
| `onOff.on` | 点灯（記憶値） |
| `onOff.off` | 消灯 |
| `levelControl.moveToLevelWithOnOff level: 92` | 主灯 15% |
| `colorControl.moveToColorTemperature 154 mired` | 色温度 100%（昼光色） |
| `colorControl.moveToColorTemperature 227 mired` | 色温度 65% |

⭐ `setRegulatoryConfig ... countryCode: JP` も正常に通り、
Android の country code バグは踏まなかった。

#### ⭐⭐ 一斉合成が実運用で効いた（M6-3 の実測）

Google Home の「全部消して / つけて」は **エンドポイントごとに別々の invoke** で来る。
それをブリッジが 1 通に合成しているのがログで確認できた。

```
Invoke « 2.onOff.off        ← Google Home からダイニングへ
Invoke « 3.onOff.off        ← Google Home からリビングへ
→ 全 2 台を 1 通で: 消灯     ← ⭐ odelicd へは target=all で 1 通だけ
Invoke « 2.onOff.on
Invoke « 3.onOff.on
→ 全 2 台を 1 通で: 点灯（記憶値）
```

到達率は **1.000** を維持（`delivery: {01000000: 1.0, 05000000: 1.0}`）。

#### ⭐ 2 回目以降のブリッジ再起動では器具を失わなかった

色温度バグ（#6）の修正を配備するため再起動したところ、
約 50 秒後に Google Home が自分から接続し直して操作を再開した。
つまり「commissioning 直後」の再起動が危険で、
安定してから（フェアリングが十分に確立してから）の再起動は問題なかった。

⚠️ **一度目の commissioning は失敗した。** 成功した直後にログレベル変更のため
サービスを再起動したのが原因（→ 下の「commissioning 直後に再起動してはいけない」）。
そのときは Google Home 側の削除通知もブリッジに届かなくなるので、
`/var/lib/odelic-matter` を消して未 commissioning に戻してから再登録した。

### ⚠️ まだできていないこと

- 中間色温度が K 線形か mired 線形か（両端は確定済み）

---

## M10c. ⭐ Pi の再起動と状態のバックアップ（2026-07-26）

### 再起動（電源断からの復帰）を実機で検証

`sudo systemctl reboot` を実行し、復帰を確認した。

| 検証項目 | 結果 |
| --- | --- |
| サービスの自動起動 | ✅ `odelicd` / `odelic-matter` 両方 active |
| Matter のフェアリング | ✅ 保持（`既に commissioning 済み`） |
| 名簿からの復元 | ✅ 2 台とも復元 |
| ⭐ Google Home の再接続 | ✅ 起動 0.4 秒後に自分から `Resumed session`。追加通知なし |
| BLE リンク | ✅ 切断 0・到達率 1.000 |
| 器具の状態 | ✅ 再起動前と一致 |

```
07:51:31.173  Publishing kind: operational ...
07:51:31.551  CaseServer  Pairing request « udp://[fe80::f272:...]:5540
07:51:31.831  CaseServer  Resumed session ... fabric: 5bc926abb9043da3 (#1)
```

⭐ セッション再開（Resumed session）が使われるので、再 commissioning も
`PartsList` の再読み込みも起きない。M6-6 の「起動前にエンドポイントを揃える」が効いている。

### 状態のバックアップ

⭐ **設定ページの「バックアップと復元」から ZIP で落とす**（→ [08 W13](08-web-ui.md)）。

| 対象 | 失うと何が起きるか |
| --- | --- |
| `/var/lib/odelic-matter` | ⭐ Matter の fabric 鍵・`uniqueId`・器具の名簿 → 再 commissioning + Google Home の設定やり直し |
| `/var/lib/odelicd` | 広告アドレス・コントローラ識別子（器具が覚えている） |
| `/etc/default/odelicd` | ⚠️ 8 桁 ID（メッシュのパスワードを含む） |
| `/etc/odelic-matter` | 器具名・ケルビン設定 |
| `/etc/odelic-web` | ⭐ ローカル CA の鍵（失うと全端末で信頼をやり直し） |
| `/var/lib/odelic-web` | 設定ページのパスワード（scrypt ハッシュ） |

⚠️⚠️ ZIP には秘密情報が入る（メッシュのパスワード・Matter の fabric 秘密鍵・
ローカル CA の秘密鍵）。**そのまま他人に渡さないこと。**

⭐ 手元の PC に落ちるのが要点。 Pi の SD カードが死んでも残る。

⚠️ 以前は `backup.sh` が systemd タイマーで毎日 `/var/backups/odelic` に
tar.gz を置いていたが、同じカードに置くのでカード故障には効かない うえ、
対象リストが 2 か所に分かれて食い違う危険があった。→ 設定ページに一本化した。

#### 復元

設定ページで ZIP を選んで「復元する」。⚠️ 3 つのサービスが再起動し、
**設定ページのパスワードもバックアップ時点に戻る** のでログインし直しになる。

⚠️ 別の Pi へ移すと fabric 鍵ごと移るので Google Home からは「同じデバイス」に見える
（再 commissioning 不要）。ただし **2 台同時に起動してはいけない**。

⚠️ タイマーを入れていた Pi では、更新後に片付けが要る（ユニットが残っていると
5 分ごとに「スクリプトが無い」で失敗し続ける）。

```bash
sudo systemctl disable --now odelic-backup.timer
sudo rm -f /etc/systemd/system/odelic-backup.{service,timer}
sudo systemctl daemon-reload
```

---

## M11. 検証

### A. BLE を使わない検証

```bash
# 変換ロジック・能力判定・設定・ブリッジ統合（偽 odelicd を立てる）
cd matter && npm test

# GET /devices が BLE を使わないことの確認（送信カウンタが増えないこと）
curl -s http://odelic-re-connected:8080/metrics > /tmp/before.json
for i in $(seq 20); do curl -s http://odelic-re-connected:8080/devices > /dev/null; done
curl -s http://odelic-re-connected:8080/metrics > /tmp/after.json
diff <(python -m json.tool /tmp/before.json) <(python -m json.tool /tmp/after.json)
```

### B. Google Home から

| 操作 | 期待 | 確認方法 |
| --- | --- | --- |
| 「照明をつけて」 | 記憶値で点灯 | 目視 + `GET /devices` の `on=true` |
| 「70% にして」 | 主灯 70% | `bright=70` |
| 「10% にして」 | 常夜灯 最暗 | `night=1` / `night_level=2` / 主灯 OFF |
| 「電球色にして」 | 2700K 側 | 目視。ここで `colorTempInverted` を確定させる |
| 「消して」 | 消灯 | `on=false` |
| 公式アプリで操作 | Google Home が 1〜2 秒で追従 | C28 の観測経路が Matter まで通る |
| 器具ごとに別の値 | 指示した器具だけ変わる | `GET /devices` で 2 台の状態が別々 |
| 「全部消して」 | 全消灯 + PDU は 1 通 | `GET /metrics` の `send.pdus` 増分が 1 |
| 器具を 1 台追加 | 再 commissioning なしで増える | Google Home のライト一覧に増える |
| 器具の電源を落とす | オフライン表示 | `Reachable = false`（600 秒は消えない） |

### C. ✅ ケルビンの向き（実施済み・2026-07-26）

```bash
curl -X POST 'http://odelic-re-connected:8080/level?bright=80&color=0&wait=1'    # → 電球色だった
curl -X POST 'http://odelic-re-connected:8080/level?bright=80&color=100&wait=1'  # 昼光色（未実施）
```

`color=0` が電球色と確認できたので `colorTempInverted: false` で確定。→ M4。

⚠️ 検証で主灯を点けたら **常夜灯は消える**（C24-5）。元に戻すには
`POST /night?level=<0|1|2>&target=dev:<vAddr>` を器具ごとに送る。

### D. 退行がないこと

```bash
curl -s http://odelic-re-connected:8080/metrics | python3 -m json.tool
#   リンク寿命 p50 152 秒 / worst_delivery 0.993 以上 / 状態要求 RTT p50 50〜78 ms
```

---

## M12. ⭐ 管理 API（設定ページ向け・2026-07-26 追加）

設定ページ [`odelic-web`](08-web-ui.md) が器具名と Matter の状態を読み書きする口。
実装は [`matter/src/admin.ts`](../matter/src/admin.ts)。

### ⚠️⚠️ localhost 限定・無認証

認証は `odelic-web` 側で済ませてある。**`127.0.0.1` 以外に bind しようとすると
起動時にエラーで止まる**（黙って直さない。LAN に開くと誰でも器具名を変えられ、
フェアリングも破棄できてしまう）。二重の安全策として、リクエストの送信元が
loopback でなければハンドラでも 403 を返す。

| メソッド | パス | 内容 |
| --- | --- | --- |
| `GET` | `/admin/state` | 器具（名前・能力・到達状態）+ Matter の状態 |
| `GET` / `POST` | `/admin/config` | 設定の読み書き。⭐ 再起動が要る項目名を応答で返す |
| `GET` | `/admin/commissioning` | commissioned / 手入力コード / QR / fabric 一覧 |
| `POST` | `/admin/commissioning/open` | 追加フェアリング（multi-admin）の窓を開く |
| `POST` | `/admin/fixtures/<mac>/name` | 器具名の変更 |
| `DELETE` | `/admin/fixtures/<mac>` | 名簿から外す（⚠️ 破壊的） |
| `POST` | `/admin/restart` | ⭐ 自分できれいに終わる（systemd が上げ直す） |
| `POST` | `/admin/factory-reset` | ⚠️⚠️ フェアリングの破棄（合言葉「破棄する」が要る） |

### ⭐ M12-1. 器具名の変更に再起動は要らない

`bridgedDeviceBasicInformation.nodeLabel` を書き換えれば Matter 側に即座に伝わる。

⚠️ ただし **Google Home 側の表示名は変わらない**（M6 のとおり、向こうは登録時に
自分で名前を保存している）。UI にその旨を必ず出している。

### ⭐ M12-2. 名前と設定の保存先を `config.json` から外した

`config.json` は **コメント付きで配っている**（`config.example.json` が雛形）ので、
プログラムから書き戻すと **コメントが全部消える**。

| 何 | どこ | 優先順位 |
| --- | --- | --- |
| 器具の表示名 | `<storagePath>/fixtures.json` の `displayName` | ⭐ これ > `config.json` の `name` > 既定名 |
| ケルビン範囲など | `<storagePath>/settings.json` | ⭐ 起動時に `config.json` に重なる |

⚠️ 一度設定ページで名前を付けると `config.json` の `name` は効かなくなる。
起動時のログにどちらを使ったかを出している。
⭐ どちらも `/var/lib/odelic-matter` なのでバックアップ済み。

### ⚠️⚠️ M12-3. commissioning 直後の再起動は 409 で断る

`POST /admin/restart` は、**commissioning から 10 分以内なら拒否** する。
M6-6 の「Nest ハブが配下の器具を失う」を踏まないため。
UI には「あと約 N 分お待ちください」と理由つきで出る。

### M12-4. QR は matter.js のものをそのまま返す

`@matter/types` の `QrCode.get(qrPairingCode)` が **文字ブロックの QR** を返すので、
それを `qrText` として返し、Web は `<pre>` に流すだけ。
⭐ QR エンコーダのライブラリを足していない。

---

## M13. 残る要検証

- [ ] Google Home が実際に commissioning を受けるか（テスト VID の登録込み）
- [x] ケルビンの **向きと絶対値** → ✅ 確定（製品スペック 2700〜6500K + 実機の目視。M4）
- [ ] 中間値が K で線形か mired で線形か（両端は合っているので影響は小さい）
- [ ] 「30% にして」が境界のどちら側に落ちるか（コントローラ依存）
- [ ] 手元の 2 台以外の製品タイプ。`GET /devices` の `product_code` を記録して M6-1 の表を埋める
- [ ] Pi 3（RAM 1 GB）で Node と `odelicd` が共存し続けるか（`MemoryMax=320M` で運用）
- [ ] `avahi-daemon` と matter.js の mDNS が長時間共存できるか
- [ ] 台数が増えたときの Google Home 側の挙動（大規模ブリッジは改善中との情報）
