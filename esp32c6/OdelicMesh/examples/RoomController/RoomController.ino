/*
 * RoomController — 押しボタン4個で ODELIC 照明4灯を個別制御する壁コントローラ。
 *
 * ・SW1〜SW4 → ライト1〜4 を個別トグル： 消灯 → ナイトライト → 主灯70% → 主灯100% → …
 * ・各ライトの宛先は「定数」で指定でき、シリアルからも設定・保存できる（NVS に永続化）
 *     - all             全器具（ブロードキャスト）
 *     - group:<n>       グループ番号
 *     - vaddr:<8hex>    器具の仮想アドレス（例 01000000）
 *     - mac:<AA:BB:..>  器具の MAC（探索で vAddr に解決）
 * ・押した瞬間に「現在の状態」を読み、最も近い段から次へ進める（ステータス取得を活用）
 * ・SW1+SW2 を 5 秒以上 同時長押し → ライト1・2 で約20秒の演出をランダム再生
 *     （位相フェード / 雷 / おばけ）
 *
 * ── 配線（弱電・3.3V。100V とは絶縁 AC-DC で分離）──────────────
 *   共通=GND / SW1:D10  SW2:D9  SW3:D8  SW4:D7（内部プルアップ・押下=LOW）
 *   右側ヘッダは GND・(3V3=空き)・D10・D9・D8・D7 の順で連続。3V3 の位置は未接続
 *   電源: 絶縁 AC-DC(100V→5V) の 5V/GND を XIAO の 5V/GND へ
 *
 * ── シリアルコマンド（115200 / LF）────────────────────────
 *   show                    設定と器具一覧を表示
 *   set <1-4> all
 *   set <1-4> group <n>
 *   set <1-4> vaddr <8hex>
 *   set <1-4> mac <AA:BB:CC:DD:EE:FF>
 *   id <8桁>                8桁ID(HOMEID+パスワード)を変更して保存
 *   discover                器具の探索（vAddr/MAC/グループ）
 *   status                  状態要求
 *   save / load             設定の保存 / 再読込
 *   demo                    演出を手動で1回再生
 *
 * 必要ライブラリ: NimBLE-Arduino v2.x / ボード: esp32:esp32:XIAO_ESP32C6
 */
#include <OdelicMesh.h>
#include <Preferences.h>
#include <math.h>

using namespace odelic;

// ==== ログ切替 ====
//  DEBUG 0 = リリース（自動で出る診断ログを止める。起動バナー/BLEログ/タップ数/
//            状態更新/ボタン動作ログ等）。シリアルコマンドとその応答は常に有効。
//  DEBUG 1 = 開発（全ログを出す）。
#define DEBUG 0
#define DBG(...)  do { if (DEBUG) Serial.printf(__VA_ARGS__); } while (0)
#define DBGLN(s)  do { if (DEBUG) Serial.println(s); } while (0)

OdelicMesh light;
Preferences prefs;

// ================= 既定値（NVS に保存が無いとき使う定数）=================
static char gId[9] = "12345678";  // 8桁ID（前4=HOMEID / 後4=パスワード）

// 宛先の種類
enum TargetMode : uint8_t { T_ALL = 0, T_GROUP = 1, T_VADDR = 2, T_MAC = 3 };

struct LightCfg {
  uint8_t mode;      // TargetMode
  uint8_t group;     // T_GROUP のとき
  uint8_t vaddr[4];  // T_VADDR のとき
  uint8_t mac[6];    // T_MAC のとき（表示順 = AA:BB:CC:DD:EE:FF の順）
};

// ★ ここで各ライトの既定の宛先を定数で指定できる（シリアル set で上書き・保存可）。
//   例) mac 指定にしたいときは { T_MAC, 0, {0}, {0xEC,0xC5,0x7F,0x80,0x28,0xA6} }
static LightCfg cfg[4] = {
    {T_GROUP, 0, {0, 0, 0, 0}, {0}},  // ライト1(SW1) → グループ0
    {T_GROUP, 1, {0, 0, 0, 0}, {0}},  // ライト2(SW2) → グループ1
    {T_GROUP, 0, {0, 0, 0, 0}, {0}},  // ライト3(SW3) → グループ0（暫定・set で変更可）
    {T_GROUP, 1, {0, 0, 0, 0}, {0}},  // ライト4(SW4) → グループ1（暫定・set で変更可）
};

// ボタンに割り当てる機能。
enum ButtonAct : uint8_t {
  ACT_LIGHT = 0,        // cfg[i] のライトを 消灯→ナイト→70%→100% でトグル
  ACT_DEMO_RANDOM = 1,  // 演出をランダムに開始
  ACT_DEMO_N = 2,       // 指定した演出を開始（showIdx）
};
struct BtnCfg { uint8_t act; uint8_t showIdx; };

// ★ 各ボタンの既定の機能（set <1-4> demo / light … でシリアル変更・保存可）
static BtnCfg btnAction[4] = {
    {ACT_LIGHT, 0},        // SW1 → ライト1をトグル
    {ACT_LIGHT, 0},        // SW2 → ライト2をトグル
    {ACT_DEMO_RANDOM, 0},  // SW3 → 演出(ランダム)  ★デフォルト
    {ACT_LIGHT, 0},        // SW4 → ライト4をトグル
};

// ★ 既定値（cfg / btnAction / デフォルト ID）を変えたら +1 する。
//   保存済み設定のバージョンが違えば無視して定数を使う（古い NVS に邪魔されない）。
static const uint32_t CONFIG_VERSION = 3;

// 主灯・ナイトライトの既定値
static const int MAIN_COLOR = 50;   // 主灯の色温度 %
static const int NIGHT_LEVEL = 1;   // ナイトライトの明るさ（0=明 1=中 2=暗）

// 状態インデックス： 0=消灯 / 1=ナイト / 2=70% / 3=100%
static int localIdx[4] = {0, 0, 0, 0};

// シリアルの直接操作(on/off/b/c/...)の対象。既定は「すべて」。use で切り替える
static LightCfg serialTgt = {T_ALL, 0, {0, 0, 0, 0}, {0}};
static int serBright = 60, serColor = 50;  // 直近値（相対操作用）

// ================= ピン =================
// 右側ヘッダに GND・(3V3=空き)・D10・D9・D8・D7 と連続で並ぶ配置。
// 共通は GND（内部プルアップ・押下=LOW）。3V3 の位置は未接続で飛ばす。
//   GND → 各ボタンの共通  /  SW1=D10  SW2=D9  SW3=D8  SW4=D7
static const int PIN_SW[4] = {D10, D9, D8, D7};

// ================= 押しボタン（チャタリング対策）=================
//  機械接点は開閉時に数百µs〜数ms の細かい ON/OFF（チャタ）を出す。応答性重視で殺す:
//   ① ソフト・デバウンス : 生入力が DEBOUNCE_MS(=8ms) 安定したら確定（短くして即応）
//   ② 押した瞬間に発火   : 立ち下がりエッジで即実行（離すのを待たない＝体感ほぼ即時）
//   ③ 受理後ロックアウト : 1回受理したら LOCKOUT_MS(=30ms) は再受理しない（チャタのみ除去）
//        → 30ms と短めにして、連続タップ（多重押し）をちゃんと数えられるようにする
//   ④ ハード併用(推奨)   : 各ボタンに 直列1kΩ ＋ D–GND間0.1µF（RC で平滑）。ESD にも強い
static const uint32_t DEBOUNCE_MS = 8;
static const uint32_t LOCKOUT_MS = 30;
struct Button {
  int pin;
  bool down = false, rawLast = false, suppress = false;
  uint32_t changedAt = 0, lastAccept = 0;
  void begin(int p) { pin = p; pinMode(p, INPUT_PULLUP); }
  // 戻り値: 0=なし / 1=押した瞬間（立ち下がりエッジ）
  int poll(uint32_t now) {
    bool raw = (digitalRead(pin) == LOW);
    if (raw != rawLast) { rawLast = raw; changedAt = now; }  // 生入力が動いた時刻を記録
    int ev = 0;
    // 生入力が DEBOUNCE_MS 安定して初めて確定状態を更新
    if ((now - changedAt) >= DEBOUNCE_MS && raw != down) {
      down = raw;
      if (down) {
        // ★ 押した瞬間に発火。ロックアウト中・コンボ抑制中は受理しない
        if (!suppress && (now - lastAccept) >= LOCKOUT_MS) { ev = 1; lastAccept = now; }
      } else {
        suppress = false;  // 離したら抑制解除
      }
    }
    return ev;
  }
};
static Button btn[4];

// 連続押し（多重押し）の計数。デモボタンで「1回=ランダム / N回=演出選択」に使う。
static const uint32_t MULTIPRESS_WINDOW = 400;  // この時間 新たな押下が無ければ確定
static int tapCount[4] = {0, 0, 0, 0};
static uint32_t lastTap[4] = {0, 0, 0, 0};

// ================= 宛先の解決・適用 =================
static bool matchMac(const uint8_t cfgMac[6], const uint8_t devMac[6]) {
  // cfgMac は表示順、devMac は逆順（LSB 先頭）で保持されている
  for (int i = 0; i < 6; i++)
    if (cfgMac[i] != devMac[5 - i]) return false;
  return true;
}

// cfg から vAddr を解決（T_VADDR は直接 / T_MAC は器具一覧から）。成功で true。
static bool resolveVaddr(const LightCfg& c, uint8_t out[4]) {
  if (c.mode == T_VADDR) { memcpy(out, c.vaddr, 4); return true; }
  if (c.mode == T_MAC) {
    for (int i = 0; i < light.deviceCount(); i++) {
      const OdelicDevice* d = light.deviceAt(i);
      if (d && d->hasMac && matchMac(c.mac, d->mac)) { memcpy(out, d->vaddr, 4); return true; }
    }
  }
  return false;
}

// 宛先(LightCfg)を主灯 bright%/color% にする
static void applyPctCfg(const LightCfg& c, int bright, int color) {
  uint8_t va[4];
  if (c.mode == T_ALL) light.setAll(bright, color);
  else if (c.mode == T_GROUP) light.setGroup(c.group, bright, color);
  else if (resolveVaddr(c, va)) light.setDevice(va, bright, color);
  else Serial.println("[!] 宛先の MAC が未解決（discover を実行）");
}
static void applyOnCfg(const LightCfg& c) {
  uint8_t va[4];
  if (c.mode == T_ALL) light.allOn();
  else if (c.mode == T_GROUP) light.onGroup(c.group);
  else if (resolveVaddr(c, va)) light.onDevice(va);
}
static void applyOffCfg(const LightCfg& c) {
  uint8_t va[4];
  if (c.mode == T_ALL) light.allOff();
  else if (c.mode == T_GROUP) light.offGroup(c.group);
  else if (resolveVaddr(c, va)) light.offDevice(va);
}
static void applyNightCfg(const LightCfg& c, int level) {
  uint8_t va[4];
  if (c.mode == T_ALL) light.nightAll(level);
  else if (c.mode == T_GROUP) light.nightGroup(c.group, level);
  else if (resolveVaddr(c, va)) light.nightDevice(va, level);
}
// 添字版（ボタン・演出用のショートカット）
static void applyPct(int i, int bright, int color) { applyPctCfg(cfg[i], bright, color); }
static void applyOff(int i) { applyOffCfg(cfg[i]); }
static void applyNight(int i, int level) { applyNightCfg(cfg[i], level); }

// 状態インデックスを適用
static void applyState(int i, int state) {
  switch (state) {
    case 0: applyOff(i); break;
    case 1: applyNight(i, NIGHT_LEVEL); break;
    case 2: applyPct(i, 70, MAIN_COLOR); break;
    case 3: applyPct(i, 100, MAIN_COLOR); break;
  }
  localIdx[i] = state;
}

// 現在の状態を器具の応答から推定（近い段を返す）。不明なら -1。
static int currentState(int i) {
  const LightCfg& c = cfg[i];
  uint8_t va[4];
  const OdelicDevice* d = nullptr;
  if (c.mode == T_VADDR || c.mode == T_MAC) {
    if (resolveVaddr(c, va)) d = light.deviceByVaddr(va);
  } else if (c.mode == T_GROUP) {
    for (int k = 0; k < light.deviceCount(); k++) {
      const OdelicDevice* x = light.deviceAt(k);
      if (x && x->groupId == c.group) { d = x; break; }
    }
  }
  if (!d) return -1;
  if (d->night > 0) return 1;
  if (d->on == 0) return 0;
  if (d->on == 1 && d->brightPct >= 0) return (d->brightPct < 85) ? 2 : 3;  // 近い段
  return -1;
}

// ボタン i が押されたときのトグル
static void toggleLight(int i) {
  int cur = currentState(i);
  int base = (cur >= 0) ? cur : localIdx[i];
  int next = (base + 1) & 0x03;
  const char* names[] = {"消灯", "ナイト", "70%", "100%"};
  DBG("SW%d → ライト%d: %s\n", i + 1, i + 1, names[next]);
  applyState(i, next);
}

// ================= 演出（SW1+SW2 長押し） =================
static const uint32_t SHOW_MS = 20000;

// ── 演出の中断/切替 ────────────────────────────────────
//  演出中に「ボタン操作」または「シリアル操作」が来たら中止。demo <n> なら別演出へ切替。
static volatile bool gAbort = false;   // 中止要求
static volatile int gSwitchTo = -1;    // 切替先の演出インデックス（-1=なし）
static bool gInShow = false;           // 演出の実行中か（シリアル入力の扱いを分ける）
static char gPendingLine[80];          // 中止のきっかけになった操作（演出後に実行）
static bool gHasPending = false;

static void pollSerial();            // 前方宣言（showPump が使う）
static void handleLine(char* line);  // 前方宣言（runShow が使う）

// 演出中に操作を拾う。中止/切替が要求されたら true を返す。
static bool showPump() {
  uint32_t now = millis();
  for (int i = 0; i < 4; i++) {
    if (btn[i].poll(now) == 1) {  // ボタン操作 → 中止して、その操作を演出後に実行
      gAbort = true;
      snprintf(gPendingLine, sizeof(gPendingLine), "sw %d", i + 1);
      gHasPending = true;
    }
  }
  pollSerial();  // シリアル操作（gInShow 中は handleDuringShow に回る）
  return gAbort || gSwitchTo >= 0;
}

// 演出中の待ち。中断/切替が来たら早期に true を返す（小刻みに確認して応答性を確保）。
static bool showDelay(uint32_t ms) {
  uint32_t t = millis();
  do {
    if (showPump()) return true;
    delay(8);
  } while (millis() - t < ms);
  return false;
}

// 位相フェード：ライト1・2 を逆位相でゆっくり明滅
static void showPhaseFade() {
  uint32_t t0 = millis();
  while (millis() - t0 < SHOW_MS) {
    float ph = (millis() - t0) / 1000.0f;
    int b1 = 10 + (int)(45.0f * (1.0f + sinf(ph * 1.2f)));  // 10〜100
    int b2 = 10 + (int)(45.0f * (1.0f + sinf(ph * 1.2f + PI)));
    if (b1 < 5) b1 = 5; if (b1 > 100) b1 = 100;
    if (b2 < 5) b2 = 5; if (b2 > 100) b2 = 100;
    applyPct(0, b1, MAIN_COLOR);
    applyPct(1, b2, MAIN_COLOR);
    if (showDelay(180)) return;
  }
}

// 雷：ふだん暗く、ランダムに白く強い閃光
static void showLightning() {
  uint32_t t0 = millis();
  while (millis() - t0 < SHOW_MS) {
    applyPct(0, 5, 100); applyPct(1, 5, 100);  // 暗い待機（青白い）
    if (showDelay(300 + (esp_random() % 2200))) return;
    int flashes = 1 + (esp_random() % 3);
    for (int f = 0; f < flashes; f++) {
      int which = esp_random() % 3;  // 0=L1 / 1=L2 / 2=両方
      if (which != 1) applyPct(0, 100, 100);
      if (which != 0) applyPct(1, 100, 100);
      delay(40 + (esp_random() % 60));
      applyPct(0, 5, 100); applyPct(1, 5, 100);
      if (showDelay(40 + (esp_random() % 120))) return;
    }
  }
}

// おばけ：電球色で薄暗く、ゆらぎながらときどきスッと消える
static void showGhost() {
  uint32_t t0 = millis();
  while (millis() - t0 < SHOW_MS) {
    int b = 10 + (esp_random() % 20);          // 10〜30 のゆらぎ
    applyPct(0, b, 0);                         // 電球色（0%）
    applyPct(1, 35 - b + 10, 0);               // 逆向きにゆらぐ
    if (showDelay(120 + (esp_random() % 200))) return;
    if ((esp_random() % 8) == 0) {             // ときどき両方スッと消す
      applyOff(0); applyOff(1);
      if (showDelay(200 + (esp_random() % 400))) return;
    }
  }
}

// キャンドル/焚き火：電球色で 1/f 風にゆらぐ（前値に近い乱数で自然な炎）
static void showCandle() {
  uint32_t t0 = millis();
  int b1 = 30, b2 = 30;
  while (millis() - t0 < SHOW_MS) {
    b1 += (int)(esp_random() % 15) - 7; if (b1 < 12) b1 = 12; if (b1 > 50) b1 = 50;
    b2 += (int)(esp_random() % 15) - 7; if (b2 < 12) b2 = 12; if (b2 > 50) b2 = 50;
    applyPct(0, b1, 0); applyPct(1, b2, 0);  // 電球色（color 0）
    if (showDelay(90 + (esp_random() % 120))) return;
  }
}

// 日の出：20秒かけて 暗い電球色 → 明るい昼白色へゆっくり立ち上げ（目覚まし向き）
static void showSunrise() {
  uint32_t t0 = millis();
  while (millis() - t0 < SHOW_MS) {
    float p = (float)(millis() - t0) / SHOW_MS;  // 0..1
    int b = 5 + (int)(p * 95);
    int c = (int)(p * 70);
    applyPct(0, b, c); applyPct(1, b, c);
    if (showDelay(250)) return;
  }
}

// 鼓動：ドッ・ドッ…という二連パルス（電球色）
static void showHeartbeat() {
  uint32_t t0 = millis();
  while (millis() - t0 < SHOW_MS) {
    applyPct(0, 70, 0); applyPct(1, 70, 0); if (showDelay(120)) return;  // ドッ
    applyPct(0, 15, 0); applyPct(1, 15, 0); if (showDelay(140)) return;
    applyPct(0, 55, 0); applyPct(1, 55, 0); if (showDelay(110)) return;  // ドッ
    applyPct(0, 10, 0); applyPct(1, 10, 0); if (showDelay(650)) return;  // …間
  }
}

// パトランプ：2灯を交互に昼白色でフラッシュ（緊急灯風）
static void showPolice() {
  uint32_t t0 = millis();
  while (millis() - t0 < SHOW_MS) {
    for (int k = 0; k < 2; k++) { applyPct(0, 100, 100); applyOff(1); if (showDelay(110)) return; applyOff(0); delay(80); }
    for (int k = 0; k < 2; k++) { applyPct(1, 100, 100); applyOff(0); if (showDelay(110)) return; applyOff(1); delay(80); }
  }
}

// 演出の一覧（ここに 1 行足すだけで増やせる）
typedef void (*ShowFn)();
struct Show { const char* name; ShowFn fn; };
static Show SHOWS[] = {
    {"位相フェード", showPhaseFade},
    {"雷", showLightning},
    {"おばけ", showGhost},
    {"キャンドル", showCandle},
    {"日の出", showSunrise},
    {"鼓動", showHeartbeat},
    {"パトランプ", showPolice},
};
static const int SHOW_COUNT = sizeof(SHOWS) / sizeof(SHOWS[0]);

// 演出を実行。中止/切替に対応する（gAbort / gSwitchTo を見る）。
static void runShow(int idx) {
  gInShow = true;
  gAbort = false;
  gHasPending = false;
  while (idx >= 0 && idx < SHOW_COUNT) {
    Serial.printf("★ 演出: %s（約20秒 / 操作で中止・demo <n> で切替）\n", SHOWS[idx].name);
    gSwitchTo = -1;
    SHOWS[idx].fn();  // 中止/切替が来ると途中で戻る
    if (gSwitchTo >= 0 && gSwitchTo < SHOW_COUNT) {  // 別演出へ切替して続行
      idx = gSwitchTo;
      gSwitchTo = -1;
      gAbort = false;
      continue;
    }
    break;  // 完走 または 中止
  }
  applyState(0, 0);  // ライト1・2 を消灯して戻す
  applyState(1, 0);
  Serial.println(gAbort ? "★ 演出を中止しました" : "★ 演出おわり");
  gInShow = false;
  gSwitchTo = -1;
  gAbort = false;
  // gHasPending（中止のきっかけ操作）は loop() で実行する。
  // ここで handleLine すると演出→演出の再帰になりうるため。
}
static void playShow(int i) { if (i >= 0 && i < SHOW_COUNT) runShow(i); }
static void playRandomShow() { runShow(esp_random() % SHOW_COUNT); }

// ボタン i を押したときの動作（機能割り当てに従う）。
static void doButtonAction(int i) {
  switch (btnAction[i].act) {
    case ACT_DEMO_RANDOM:
      DBG("SW%d → 演出(ランダム)\n", i + 1);
      playRandomShow();
      break;
    case ACT_DEMO_N:
      DBG("SW%d → 演出 %d\n", i + 1, btnAction[i].showIdx + 1);
      playShow(btnAction[i].showIdx);
      break;
    default:  // ACT_LIGHT
      toggleLight(i);
      break;
  }
}

// ================= 設定の保存・読込（NVS）=================
static void saveConfig() {
  prefs.begin("odelic", false);
  prefs.putUInt("ver", CONFIG_VERSION);
  prefs.putBytes("cfg", cfg, sizeof(cfg));
  prefs.putBytes("act", btnAction, sizeof(btnAction));
  prefs.putString("id", gId);
  prefs.end();
  Serial.println("設定を保存しました");
}
static void loadConfig() {
  prefs.begin("odelic", true);
  uint32_t ver = prefs.getUInt("ver", 0);
  bool ok = (ver == CONFIG_VERSION);  // バージョンが違えば定数の既定値を使う
  if (ok && prefs.isKey("cfg")) prefs.getBytes("cfg", cfg, sizeof(cfg));
  if (ok && prefs.isKey("act")) prefs.getBytes("act", btnAction, sizeof(btnAction));
  if (ok && prefs.isKey("id")) { String s = prefs.getString("id"); if (s.length() == 8) strcpy(gId, s.c_str()); }
  prefs.end();
  if (!ok) DBGLN("（保存設定なし/版違い → 定数の既定値を使用）");
}

static void printCfg(const LightCfg& c) {
  if (c.mode == T_ALL) Serial.println("すべて");
  else if (c.mode == T_GROUP) Serial.printf("グループ%d\n", c.group);
  else if (c.mode == T_VADDR)
    Serial.printf("vAddr %02X%02X%02X%02X\n", c.vaddr[0], c.vaddr[1], c.vaddr[2], c.vaddr[3]);
  else
    Serial.printf("MAC %02X:%02X:%02X:%02X:%02X:%02X\n", c.mac[0], c.mac[1], c.mac[2],
                  c.mac[3], c.mac[4], c.mac[5]);
}
static void printTarget(int i) {
  Serial.printf("  ライト%d → ", i + 1);
  printCfg(cfg[i]);
}
static void printButton(int i) {
  Serial.printf("  SW%d → ", i + 1);
  if (btnAction[i].act == ACT_DEMO_RANDOM) { Serial.println("演出(ランダム)"); return; }
  if (btnAction[i].act == ACT_DEMO_N) {
    int k = btnAction[i].showIdx;
    Serial.printf("演出 %d: %s\n", k + 1, (k >= 0 && k < SHOW_COUNT) ? SHOWS[k].name : "?");
    return;
  }
  Serial.print("ライト ");
  printCfg(cfg[i]);
}

static void printHelp() {
  Serial.println(F(
      "\n── RoomController コマンド ─────────────────────\n"
      "[設定]\n"
      "  show / ls           設定と検出器具の一覧\n"
      "  set <1-4> all|group <n>|vaddr <8hex>|mac <AA:..>   ボタン=ライト操作+宛先\n"
      "  set <1-4> demo [k]  ボタン=演出（k省略でランダム）\n"
      "  id <8桁>            IDを変更して保存\n"
      "  discover / status   器具の探索 / 状態要求\n"
      "  conn                BLE 接続間隔（低遅延ほど小さい）\n"
      "  save / load         設定の保存 / 再読込\n"
      "[直接操作] 対象は use で選ぶ（既定=すべて）\n"
      "  use all|group <n>|vaddr <hex>|mac <..>|light <1-4>\n"
      "  on / off            点灯 / 消灯\n"
      "  b <0-100>           明るさ%\n"
      "  c <0-100>           色温度%（0=電球色 100=昼光色）\n"
      "  l <bright> <color>  明るさ+色温度\n"
      "  n <0-2>             ナイトライト（0=明 2=暗）\n"
      "  level <1-254>       Matter LevelControl\n"
      "  k <kelvin>          Matter 色温度（2700/5000/6500…）\n"
      "  allon / alloff      全点灯 / 全消灯\n"
      "  sw <1-4>            ボタン相当の動作（割当機能を実行）\n"
      "[演出]\n"
      "  demos               演出一覧＋押し回数の対応\n"
      "  demo [n]            再生（n省略でランダム）\n"
      "   （デモボタンは 1回=ランダム / N回=演出N-1 の連続押し選択）\n"
      "   （演出中: 操作で中止 / demo <n> で切替 / stop で停止）\n"
      "  v                   詳細ログ ON/OFF\n"
      "  ? / help            このヘルプ\n"
      "────────────────────────────────────"));
}

static void printAll() {
  Serial.printf("ID=%s  参加=%s\n", gId, light.joined() ? "済" : "未");
  for (int i = 0; i < 4; i++) printButton(i);
  int n = light.deviceCount();
  Serial.printf("検出器具 %d 台:\n", n);
  for (int i = 0; i < n; i++) {
    const OdelicDevice* d = light.deviceAt(i);
    if (!d) continue;
    Serial.printf("  vAddr=%02X%02X%02X%02X", d->vaddr[0], d->vaddr[1], d->vaddr[2], d->vaddr[3]);
    if (d->hasMac)
      Serial.printf(" MAC=%02X:%02X:%02X:%02X:%02X:%02X", d->mac[5], d->mac[4], d->mac[3],
                    d->mac[2], d->mac[1], d->mac[0]);
    if (d->groupId >= 0) Serial.printf(" grp=%d", d->groupId);
    Serial.println();
  }
}

// "AA:BB:CC:DD:EE:FF" → 6 バイト（表示順）
static bool parseMac(const char* s, uint8_t out[6]) {
  int v[6];
  if (sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) return false;
  for (int i = 0; i < 6; i++) out[i] = (uint8_t)v[i];
  return true;
}
// "01000000" → 4 バイト
static bool parseVaddr(const char* s, uint8_t out[4]) {
  if (strlen(s) != 8) return false;
  for (int i = 0; i < 4; i++) {
    int hi, lo;
    hi = s[i * 2]; lo = s[i * 2 + 1];
    auto nib = [](int c) { return (c >= '0' && c <= '9') ? c - '0'
                                  : (c >= 'a' && c <= 'f') ? c - 'a' + 10
                                  : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1; };
    int h = nib(hi), l = nib(lo);
    if (h < 0 || l < 0) return false;
    out[i] = (uint8_t)((h << 4) | l);
  }
  return true;
}

// ================= シリアルコマンド =================
static void handleLine(char* line) {
  char* cmd = strtok(line, " \t");
  if (!cmd) return;

  if (!strcmp(cmd, "show")) { printAll(); return; }
  if (!strcmp(cmd, "discover")) { light.discover(); Serial.println("探索を送信"); return; }
  if (!strcmp(cmd, "status")) { light.requestStatus(); Serial.println("状態要求を送信"); return; }
  if (!strcmp(cmd, "conn")) { Serial.printf("BLE 接続間隔 = %.2f ms（小さいほど低遅延）\n", light.connIntervalMs()); return; }
  if (!strcmp(cmd, "save")) { saveConfig(); return; }
  if (!strcmp(cmd, "load")) { loadConfig(); printAll(); return; }
  if (!strcmp(cmd, "demos")) {
    Serial.println("演出（デモボタンの押し回数 → 演出）:");
    Serial.println("  1回: ランダム");
    for (int i = 0; i < SHOW_COUNT; i++) Serial.printf("  %d回: %s\n", i + 2, SHOWS[i].name);
    Serial.println("  ※ demo <n> で番号指定の直接再生も可");
    return;
  }
  if (!strcmp(cmd, "demo")) {
    char* a = strtok(nullptr, " \t");
    if (a) playShow(atoi(a) - 1);  // 1始まり
    else playRandomShow();
    return;
  }
  if (!strcmp(cmd, "stop")) { Serial.println("（演出は実行していません）"); return; }

  if (!strcmp(cmd, "id")) {
    char* a = strtok(nullptr, " \t");
    if (a && strlen(a) == 8) { strcpy(gId, a); saveConfig(); Serial.println("ID を保存（再起動で反映）"); }
    else Serial.println("使い方: id <8桁>");
    return;
  }

  if (!strcmp(cmd, "set")) {
    char* ns = strtok(nullptr, " \t");
    char* what = strtok(nullptr, " \t");
    char* arg = strtok(nullptr, " \t");
    int n = ns ? atoi(ns) : 0;
    if (n < 1 || n > 4 || !what) {
      Serial.println("使い方: set <1-4> all|group <n>|vaddr <8hex>|mac <..>|demo [k]|light");
      return;
    }
    // 演出の割り当て
    if (!strcmp(what, "demo")) {
      if (arg) {
        int k = atoi(arg) - 1;
        if (k < 0 || k >= SHOW_COUNT) { Serial.println("演出番号が範囲外（demos で一覧）"); return; }
        btnAction[n - 1].act = ACT_DEMO_N;
        btnAction[n - 1].showIdx = (uint8_t)k;
      } else {
        btnAction[n - 1].act = ACT_DEMO_RANDOM;
      }
      saveConfig();
      printButton(n - 1);
      return;
    }
    // ライト操作の割り当て（宛先も設定）
    LightCfg& c = cfg[n - 1];
    if (!strcmp(what, "light")) { /* 宛先はそのまま、機能だけライトに */ }
    else if (!strcmp(what, "all")) { c.mode = T_ALL; }
    else if (!strcmp(what, "group") && arg) { c.mode = T_GROUP; c.group = (uint8_t)atoi(arg); }
    else if (!strcmp(what, "vaddr") && arg && parseVaddr(arg, c.vaddr)) { c.mode = T_VADDR; }
    else if (!strcmp(what, "mac") && arg && parseMac(arg, c.mac)) { c.mode = T_MAC; }
    else { Serial.println("引数エラー"); return; }
    btnAction[n - 1].act = ACT_LIGHT;
    saveConfig();
    printButton(n - 1);
    return;
  }

  // ---- 直接操作の対象を選ぶ ----
  if (!strcmp(cmd, "use")) {
    char* what = strtok(nullptr, " \t");
    char* arg = strtok(nullptr, " \t");
    if (!what) { Serial.println("使い方: use all|group <n>|vaddr <8hex>|mac <..>|light <1-4>"); return; }
    if (!strcmp(what, "all")) serialTgt.mode = T_ALL;
    else if (!strcmp(what, "group") && arg) { serialTgt.mode = T_GROUP; serialTgt.group = (uint8_t)atoi(arg); }
    else if (!strcmp(what, "vaddr") && arg && parseVaddr(arg, serialTgt.vaddr)) serialTgt.mode = T_VADDR;
    else if (!strcmp(what, "mac") && arg && parseMac(arg, serialTgt.mac)) serialTgt.mode = T_MAC;
    else if (!strcmp(what, "light") && arg) { int n = atoi(arg); if (n >= 1 && n <= 4) serialTgt = cfg[n - 1]; else { Serial.println("1-4"); return; } }
    else { Serial.println("引数エラー"); return; }
    Serial.print("直接操作の対象 → ");
    printCfg(serialTgt);
    return;
  }

  // ---- 直接操作（対象 = serialTgt）----
  if (!strcmp(cmd, "on")) { applyOnCfg(serialTgt); Serial.println("点灯"); return; }
  if (!strcmp(cmd, "off")) { applyOffCfg(serialTgt); Serial.println("消灯"); return; }
  if (!strcmp(cmd, "b")) {
    char* a = strtok(nullptr, " \t");
    if (a) { serBright = atoi(a); applyPctCfg(serialTgt, serBright, serColor); Serial.printf("明るさ %d%%\n", serBright); }
    return;
  }
  if (!strcmp(cmd, "c")) {
    char* a = strtok(nullptr, " \t");
    if (a) { serColor = atoi(a); applyPctCfg(serialTgt, serBright, serColor); Serial.printf("色温度 %d%%\n", serColor); }
    return;
  }
  if (!strcmp(cmd, "l")) {
    char* a = strtok(nullptr, " \t"); char* b = strtok(nullptr, " \t");
    if (a && b) { serBright = atoi(a); serColor = atoi(b); applyPctCfg(serialTgt, serBright, serColor); Serial.printf("明%d%% 色%d%%\n", serBright, serColor); }
    return;
  }
  if (!strcmp(cmd, "n")) {
    char* a = strtok(nullptr, " \t");
    int lv = a ? atoi(a) : NIGHT_LEVEL;
    applyNightCfg(serialTgt, lv);
    Serial.printf("ナイトライト level %d\n", lv);
    return;
  }
  if (!strcmp(cmd, "level")) {
    char* a = strtok(nullptr, " \t");
    if (a) {
      int lv = atoi(a);
      LightTarget t = matterLevelToTarget(lv, 30, true);
      if (t.night) { applyNightCfg(serialTgt, t.nightLevel); Serial.printf("level %d → ナイト %d\n", lv, t.nightLevel); }
      else { applyPctCfg(serialTgt, t.bright, serColor); Serial.printf("level %d → 主灯 %d%%\n", lv, t.bright); }
    }
    return;
  }
  if (!strcmp(cmd, "k")) {
    char* a = strtok(nullptr, " \t");
    if (a) { int kv = atoi(a); serColor = miredsToColorPercent(kelvinToMireds(kv), 2700, 6500); applyPctCfg(serialTgt, serBright, serColor); Serial.printf("%dK → 色温度 %d%%\n", kv, serColor); }
    return;
  }
  if (!strcmp(cmd, "allon")) { light.allOn(); Serial.println("全点灯"); return; }
  if (!strcmp(cmd, "alloff")) { light.allOff(); Serial.println("全消灯"); return; }
  if (!strcmp(cmd, "sw")) {
    char* a = strtok(nullptr, " \t");
    int n = a ? atoi(a) : 0;
    if (n >= 1 && n <= 4) doButtonAction(n - 1);  // 割り当てられた機能を実行
    else Serial.println("使い方: sw <1-4>");
    return;
  }
  if (!strcmp(cmd, "v")) {
    static bool vb = false;
    vb = !vb;
    light.setVerbose(vb);
    Serial.printf("詳細ログ = %s\n", vb ? "ON" : "OFF");
    return;
  }
  if (!strcmp(cmd, "ls")) { printAll(); return; }
  if (!strcmp(cmd, "?") || !strcmp(cmd, "help") || !strcmp(cmd, "h")) { printHelp(); return; }

  Serial.printf("不明なコマンド: %s（help でヘルプ）\n", cmd);
}

// 演出中のシリアル入力の処理。demo=切替 / stop=中止 / その他=中止して演出後に実行。
static void handleDuringShow(char* line) {
  char tmp[80];
  strncpy(tmp, line, sizeof(tmp)); tmp[sizeof(tmp) - 1] = 0;
  char* c = strtok(tmp, " \t");
  if (!c) return;
  if (!strcmp(c, "demo")) {
    char* a = strtok(nullptr, " \t");
    int idx = a ? atoi(a) - 1 : (int)(esp_random() % SHOW_COUNT);
    if (idx >= 0 && idx < SHOW_COUNT) { gSwitchTo = idx; Serial.printf("→ %s に切替\n", SHOWS[idx].name); }
    else Serial.println("番号が範囲外");
    return;
  }
  if (!strcmp(c, "demos")) {
    for (int i = 0; i < SHOW_COUNT; i++) Serial.printf("  %d: %s\n", i + 1, SHOWS[i].name);
    return;
  }
  if (!strcmp(c, "stop")) { gAbort = true; return; }
  // それ以外の操作 → 演出を中止し、そのコマンドを演出後に実行する
  gAbort = true;
  strncpy(gPendingLine, line, sizeof(gPendingLine)); gPendingLine[sizeof(gPendingLine) - 1] = 0;
  gHasPending = true;
}

static char g_buf[80];
static size_t g_len = 0;
static void pollSerial() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      g_buf[g_len] = 0;
      if (g_len) { if (gInShow) handleDuringShow(g_buf); else handleLine(g_buf); }
      g_len = 0;
      if (!gInShow) Serial.print("> ");
    } else if (g_len < sizeof(g_buf) - 1) {
      g_buf[g_len++] = ch;
    }
  }
}

// ================= 参加時 =================
void onJoined(OdelicMesh& m) {
  DBG("\n★ 参加完了（器具 %d 台）\n", m.deviceNum());
  m.discover();       // vAddr/MAC/グループを集める
  m.requestStatus();  // 現在状態を取得
  DBG("> ");
}

// ================= setup / loop =================
void setup() {
  Serial.begin(115200);
  delay(300);
  DBGLN("\n=== OdelicMesh RoomController ===");
  loadConfig();
  for (int i = 0; i < 4; i++) btn[i].begin(PIN_SW[i]);
  randomSeed(esp_random());

  light.onJoined(onJoined);
  if (!light.begin(gId)) {
    Serial.println("begin 失敗（ID を確認）");  // エラーはリリースでも出す
    while (true) delay(1000);
  }
  if (DEBUG) { printAll(); printHelp(); }  // 起動時の自動ダンプは診断時のみ
  DBGLN("広告開始。器具の接続を待っています…");
  DBG("> ");
}

void loop() {
  uint32_t now = millis();
  pollSerial();

  // 演出中の操作で保留になったコマンドを、演出終了後（loop 側）で実行する
  if (gHasPending && !gInShow) {
    gHasPending = false;
    char tmp[80];
    strncpy(tmp, gPendingLine, sizeof(tmp));
    tmp[sizeof(tmp) - 1] = 0;
    handleLine(tmp);
  }

  // --- SW1+SW2 同時長押し（5秒）で演出 ---
  static uint32_t comboStart = 0;
  static bool comboFired = false;
  if (btn[0].down && btn[1].down) {
    if (comboStart == 0) comboStart = now;
    if (!comboFired && (now - comboStart) >= 5000) {
      comboFired = true;
      btn[0].suppress = true;  // 離したときのトグルを抑制
      btn[1].suppress = true;
      playRandomShow();
    }
  } else {
    comboStart = 0;
    comboFired = false;
  }

  // --- 各ボタンの押下で割り当て機能を実行（押した瞬間に発火）---
  for (int i = 0; i < 4; i++) {
    int ev = btn[i].poll(now);
    if (ev != 1) continue;
    // SW1+SW2 の同時押し（演出起動）のときは、相方が押されている側の単体動作を出さない
    if ((i == 0 && btn[1].down) || (i == 1 && btn[0].down)) continue;

    if (btnAction[i].act == ACT_DEMO_RANDOM) {
      // 連続押しの回数で演出を選ぶ。確定は下のリゾルバで（1回=ランダム）
      tapCount[i]++;
      lastTap[i] = now;
      DBG("SW%d: %d 回\n", i + 1, tapCount[i]);
    } else if (btnAction[i].act == ACT_DEMO_N) {
      doButtonAction(i);  // 固定演出は即開始
    } else {              // ACT_LIGHT
      if (!light.joined()) { DBGLN("（未参加。器具の接続を待ってください）"); continue; }
      toggleLight(i);
    }
  }

  // --- 連続押しの確定：一定時間 新たな押下が無ければ、回数に応じた演出を開始 ---
  for (int i = 0; i < 4; i++) {
    if (tapCount[i] > 0 && (now - lastTap[i]) >= MULTIPRESS_WINDOW) {
      int c = tapCount[i];
      tapCount[i] = 0;
      if (c == 1) {
        DBG("SW%d → 演出(ランダム)\n", i + 1);
        playRandomShow();
      } else {
        int k = c - 2;  // 2回=演出1 / 3回=演出2 / …
        if (k < 0) k = 0;
        if (k >= SHOW_COUNT) k = SHOW_COUNT - 1;
        DBG("SW%d → %d回 = 演出%d %s\n", i + 1, c, k + 1, SHOWS[k].name);
        playShow(k);
      }
    }
  }

  delay(2);  // ポーリングを細かく（応答性のため）
}
