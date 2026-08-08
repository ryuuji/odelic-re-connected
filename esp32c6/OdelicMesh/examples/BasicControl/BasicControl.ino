/*
 * BasicControl — OdelicMesh の基本制御。
 * 参加後に 点灯 → 調光 → 調色 → ナイトライト → 消灯 を順に実行する。
 *
 * 必要ライブラリ: NimBLE-Arduino v2.x
 * ボード: XIAO ESP32C6（esp32:esp32:XIAO_ESP32C6）
 */
#include <OdelicMesh.h>

using namespace odelic;

OdelicMesh light;

// ★ 8桁ID（前4桁=HOMEID / 後4桁=パスワード）を自分の値に
static const char* DISPLAY_ID = "12345678";

void onJoined(OdelicMesh& m) {
  Serial.printf("参加完了（器具 %d 台）。デモを開始します\n", m.deviceNum());
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== OdelicMesh BasicControl ===");
  light.setVerbose(true);
  light.onJoined(onJoined);
  if (!light.begin(DISPLAY_ID)) {
    Serial.println("begin 失敗（ID を確認）");
    while (true) delay(1000);
  }
  Serial.println("広告開始。器具の接続を待ちます…");
}

void loop() {
  static uint32_t last = 0;
  static int step = 0;
  if (!light.joined()) return;

  if (millis() - last > 3000) {
    last = millis();
    switch (step % 6) {
      case 0: Serial.println(">> 点灯");            light.on();               break;
      case 1: Serial.println(">> 明るさ30% 色50%"); light.setLight(30, 50);   break;
      case 2: Serial.println(">> 明るさ100% 色0%"); light.setLight(100, 0);   break;
      case 3: Serial.println(">> 明るさ60% 色100%");light.setLight(60, 100);  break;
      case 4: Serial.println(">> ナイトライト");    light.night(0);           break;
      case 5: Serial.println(">> 消灯");            light.off();              break;
    }
    step++;
  }
}
