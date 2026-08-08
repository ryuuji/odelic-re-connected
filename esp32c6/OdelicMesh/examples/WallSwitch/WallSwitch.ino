/*
 * WallSwitch — 押しボタン2個で ODELIC 照明を操作する壁コントローラ。
 *
 * 既存の壁スイッチは「はめ殺し（常時ON）」にして器具の BLE を生かしたまま、
 * この XIAO ESP32C6 が押しボタンを読んで BLE でメッシュを制御する。
 *
 * ── 配線（弱電・3.3V。100V とは AC-DC モジュールで絶縁）─────────
 *   SW1（主灯）    : D1 ── ボタン ── GND
 *   SW2（ナイト）  : D2 ── ボタン ── GND
 *   （内部プルアップを使うので外部抵抗は不要。各ボタンに直列 1kΩ ＋
 *     D-GND 間 0.1µF を足すとチャタリング/ESD に強い）
 *   電源           : HLK-5M05 等の絶縁 AC-DC(100V→5V) の 5V/GND を XIAO の 5V/GND へ
 *   ⚠️ AC 給電中は USB を挿さない。書き換え時は AC を切って USB で。
 *   ⚠️ 金属ボックスは BLE を遮蔽する。u.FL 外部アンテナを箱の外へ。
 *
 * ── 操作 ──────────────────────────────────────────────────
 *   SW1 短押し : 主灯 ON/OFF トグル
 *   SW1 長押し : 押している間だけ明るさを上げ下げ（押すたびに方向反転）
 *   SW2 短押し : ナイトライト巡回  消灯 → 明 → 中 → 暗 → 消灯 …
 *
 * 必要ライブラリ: NimBLE-Arduino v2.x / ボード: esp32:esp32:XIAO_ESP32C6
 */
#include <OdelicMesh.h>

using namespace odelic;

OdelicMesh light;

// ★ 8桁ID（前4桁=HOMEID / 後4桁=パスワード）を自分の値に
static const char* DISPLAY_ID = "12345678";

// ---- ピン割り当て（D1=GPIO1 / D2=GPIO2。どちらも strapping ピンではない）----
static const int PIN_SW1 = D1;  // 主灯
static const int PIN_SW2 = D2;  // ナイトライト

// ---- 調光/調色の内部状態（このコントローラを状態の基準にする）----
static bool gOn = false;
static int gBright = 60;  // %
static int gColor = 50;   // %
static int gNightIndex = 0;  // 0=消灯 / 1=明(level0) / 2=中(level1) / 3=暗(level2)
static int gRampDir = +1;    // 長押し調光の向き

// ---- 押しボタン（デバウンス＋短押し/長押し検出）----
static const uint32_t DEBOUNCE_MS = 25;
static const uint32_t LONG_MS = 500;      // これ以上で長押し
static const uint32_t RAMP_STEP_MS = 200; // 長押し中の調光間隔

struct Button {
  int pin;
  bool down = false;        // 確定状態（true=押下）
  bool rawLast = false;
  uint32_t changedAt = 0;
  uint32_t pressedAt = 0;
  bool longActive = false;
  uint32_t lastRampAt = 0;

  void begin(int p) {
    pin = p;
    pinMode(p, INPUT_PULLUP);
  }

  // イベント: 0=なし / 1=短押し(離した) / 2=長押し開始 / 3=長押し終了
  int poll(uint32_t now) {
    bool raw = (digitalRead(pin) == LOW);  // 押すと LOW
    if (raw != rawLast) {
      rawLast = raw;
      changedAt = now;
    }
    int ev = 0;
    if ((now - changedAt) >= DEBOUNCE_MS && raw != down) {
      down = raw;
      if (down) {
        pressedAt = now;
        longActive = false;
      } else {
        ev = longActive ? 3 : 1;  // 離した：長押し終了 or 短押し
        longActive = false;
      }
    }
    if (down && !longActive && (now - pressedAt) >= LONG_MS) {
      longActive = true;
      lastRampAt = now;
      ev = 2;  // 長押し開始
    }
    return ev;
  }
};

static Button sw1, sw2;

// ---- 送信ヘルパー ----
void applyMain() {
  if (gOn)
    light.setLight(gBright, gColor);
  else
    light.off();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== OdelicMesh WallSwitch ===");
  sw1.begin(PIN_SW1);
  sw2.begin(PIN_SW2);
  if (!light.begin(DISPLAY_ID)) {
    Serial.println("begin 失敗（ID を確認）");
    while (true) delay(1000);
  }
  Serial.println("広告開始。器具の接続を待っています…");
}

void loop() {
  uint32_t now = millis();

  // ---------------- SW1: 主灯 ----------------
  int e1 = sw1.poll(now);
  if (e1 == 1) {  // 短押し → ON/OFF トグル
    gNightIndex = 0;
    gOn = !gOn;
    Serial.printf("SW1 短押し → 主灯 %s\n", gOn ? "ON" : "OFF");
    applyMain();
  } else if (e1 == 2) {  // 長押し開始 → 調光の向きを決める
    gNightIndex = 0;
    gOn = true;
    if (gBright >= 100) gRampDir = -1;
    else if (gBright <= 5) gRampDir = +1;
    else gRampDir = -gRampDir;  // 押すたびに反転
    Serial.printf("SW1 長押し → 調光 %s\n", gRampDir > 0 ? "明るく" : "暗く");
  }
  // 長押し中は一定間隔で明るさを増減
  if (sw1.longActive && (now - sw1.lastRampAt) >= RAMP_STEP_MS) {
    sw1.lastRampAt = now;
    gBright += gRampDir * 5;
    if (gBright > 100) gBright = 100;
    if (gBright < 5) gBright = 5;
    gOn = true;
    applyMain();
    Serial.printf("  明るさ %d%%\n", gBright);
  }

  // ---------------- SW2: ナイトライト巡回 ----------------
  int e2 = sw2.poll(now);
  if (e2 == 1) {  // 短押し → 消灯 → 明 → 中 → 暗 → 消灯 …
    gNightIndex = (gNightIndex + 1) & 0x03;
    if (gNightIndex == 0) {
      gOn = false;
      light.off();
      Serial.println("SW2 → 消灯");
    } else {
      int level = gNightIndex - 1;  // 1→level0(明) / 2→level1(中) / 3→level2(暗)
      gOn = false;                  // ナイトライトを点けると主灯は消える
      light.night(level);
      const char* name = (level == 0) ? "明" : (level == 1) ? "中" : "暗";
      Serial.printf("SW2 → ナイトライト %s（level %d）\n", name, level);
    }
  }

  delay(5);
}
