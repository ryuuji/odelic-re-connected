/*
 * SerialConsole — OdelicMesh を使った対話型シリアルコントローラ。
 *
 * シリアルモニタ（115200 baud, 改行 = LF または CR/LF）からメニューで
 * ODELIC 照明を制御する。器具が接続してくると自動でメッシュに参加し、
 * 状態応答（暗号化）も自動で復号して表示する。
 *
 * 必要ライブラリ: NimBLE-Arduino v2.x
 * ボード: XIAO ESP32C6（esp32:esp32:XIAO_ESP32C6）
 *
 * ── コマンド一覧 ──────────────────────────────────────────
 *   on / off              点灯 / 消灯（既定グループ）
 *   b <0-100>             明るさ %（色温度は現状維持）
 *   c <0-100>             色温度 %（0=電球色 / 100=昼光色）
 *   l <bright> <color>    明るさと色温度をまとめて
 *   n <0-2>               ナイトライト（0=明るい / 2=暗い）
 *   allon / alloff        全器具を一斉に
 *   g <group>             既定グループ番号を変更
 *   level <1-254>         Matter LevelControl（常夜灯+主灯を1軸に）
 *   k <kelvin>            Matter 色温度（例 2700 / 5000 / 6500）
 *   s                     状態要求 → 器具一覧を表示
 *   d                     器具の探索（製品コード・グループ）
 *   ls                    既知の器具一覧を表示
 *   v                     詳細ログの ON/OFF
 *   ? / h                 このヘルプ
 * ─────────────────────────────────────────────────────────
 */
#include <OdelicMesh.h>

using namespace odelic;

OdelicMesh light;

// ★ 8桁ID（前4桁=HOMEID / 後4桁=パスワード）を自分の値に
static const char* DISPLAY_ID = "12345678";

static bool g_verbose = false;

// ---------------------------------------------------------------- 表示
void printHelp() {
  Serial.println(F(
      "\n── OdelicMesh コマンド ──────────────────────────\n"
      "  on / off            点灯 / 消灯（既定グループ）\n"
      "  b <0-100>           明るさ %\n"
      "  c <0-100>           色温度 %（0=電球色 100=昼光色）\n"
      "  l <bright> <color>  明るさ+色温度\n"
      "  n <0-2>             ナイトライト（0=明るい 2=暗い）\n"
      "  allon / alloff      全器具を一斉に\n"
      "  g <group>           既定グループ番号を変更\n"
      "  level <1-254>       Matter LevelControl\n"
      "  k <kelvin>          Matter 色温度（2700/5000/6500…）\n"
      "  s                   状態要求 → 器具一覧\n"
      "  d                   器具の探索\n"
      "  ls                  既知の器具一覧\n"
      "  v                   詳細ログ ON/OFF\n"
      "  ? / h               ヘルプ\n"
      "──────────────────────────────────────────────"));
}

void printDevices() {
  int n = light.deviceCount();
  if (n == 0) {
    Serial.println("（まだ器具を検出していません。s か d を実行）");
    return;
  }
  Serial.printf("器具 %d 台:\n", n);
  for (int i = 0; i < n; i++) {
    const OdelicDevice* d = light.deviceAt(i);
    if (!d) continue;
    Serial.printf("  [%d] vAddr=%02X%02X%02X%02X", i,
                  d->vaddr[0], d->vaddr[1], d->vaddr[2], d->vaddr[3]);
    if (d->hasMac)
      Serial.printf(" MAC=%02X:%02X:%02X:%02X:%02X:%02X",
                    d->mac[5], d->mac[4], d->mac[3], d->mac[2], d->mac[1], d->mac[0]);
    if (d->groupId >= 0) Serial.printf(" grp=%d", d->groupId);
    if (d->productCode >= 0) Serial.printf(" prod=0x%02X", d->productCode);
    Serial.print(" state=");
    if (d->on < 0) Serial.print("?");
    else if (d->night > 0) Serial.printf("常夜灯%d", d->night);
    else if (d->on == 0) Serial.print("OFF");
    else Serial.printf("ON b=%d%% c=%d%%", d->brightPct, d->colorPct);
    Serial.println();
  }
}

// ---------------------------------------------------------------- コールバック
void onJoined(OdelicMesh& m) {
  Serial.printf("\n★ メッシュ参加完了（器具 %d 台）。コマンドを入力できます。\n> ",
                m.deviceNum());
  m.requestStatus();  // 参加できたら一度状態を取りに行く
}

void onStatus(OdelicMesh& m, const OdelicDevice& d) {
  Serial.printf("[状態] vAddr=%02X%02X%02X%02X ", d.vaddr[0], d.vaddr[1], d.vaddr[2], d.vaddr[3]);
  if (d.night > 0) Serial.printf("常夜灯%d\n", d.night);
  else if (d.on == 0) Serial.println("OFF");
  else Serial.printf("ON b=%d%% c=%d%%\n", d.brightPct, d.colorPct);
}

// ---------------------------------------------------------------- コマンド処理
void handleLine(char* line) {
  // 先頭トークン
  char* cmd = strtok(line, " \t");
  if (!cmd) return;
  char* a1 = strtok(nullptr, " \t");
  char* a2 = strtok(nullptr, " \t");
  int v1 = a1 ? atoi(a1) : 0;
  int v2 = a2 ? atoi(a2) : 0;

  bool needJoin = true;  // 参加が要るコマンドか
  if (!strcmp(cmd, "?") || !strcmp(cmd, "h") || !strcmp(cmd, "ls") ||
      !strcmp(cmd, "v") || !strcmp(cmd, "g"))
    needJoin = false;

  if (needJoin && !light.joined()) {
    Serial.println("（まだ参加していません。器具の接続を待ってください）");
    return;
  }

  if (!strcmp(cmd, "on")) {
    light.on();
    Serial.println("点灯");
  } else if (!strcmp(cmd, "off")) {
    light.off();
    Serial.println("消灯");
  } else if (!strcmp(cmd, "b")) {
    int color = light.cacheColorPct() >= 0 ? light.cacheColorPct() : 50;
    light.setLight(v1, color);
    Serial.printf("明るさ %d%%（色温度 %d%%）\n", v1, color);
  } else if (!strcmp(cmd, "c")) {
    int bright = light.cacheBrightPct() >= 0 ? light.cacheBrightPct() : 60;
    light.setLight(bright, v1);
    Serial.printf("色温度 %d%%（明るさ %d%%）\n", v1, bright);
  } else if (!strcmp(cmd, "l")) {
    light.setLight(v1, v2);
    Serial.printf("明るさ %d%% / 色温度 %d%%\n", v1, v2);
  } else if (!strcmp(cmd, "n")) {
    light.night(v1);
    Serial.printf("ナイトライト level %d\n", v1);
  } else if (!strcmp(cmd, "allon")) {
    light.allOn();
    Serial.println("全点灯");
  } else if (!strcmp(cmd, "alloff")) {
    light.allOff();
    Serial.println("全消灯");
  } else if (!strcmp(cmd, "g")) {
    light.setDefaultGroup((uint8_t)v1);
    Serial.printf("既定グループ = %d\n", v1);
  } else if (!strcmp(cmd, "level")) {
    light.matterSetLevel(v1);
    Serial.printf("Matter level %d を送信\n", v1);
  } else if (!strcmp(cmd, "k")) {
    light.matterSetColorKelvin(v1);
    Serial.printf("Matter 色温度 %dK を送信\n", v1);
  } else if (!strcmp(cmd, "s")) {
    light.requestStatus();
    Serial.println("状態要求を送信（応答は数百 ms 後に届きます）");
  } else if (!strcmp(cmd, "d")) {
    light.discover();
    Serial.println("探索を送信（製品コード・グループを問い合わせ）");
  } else if (!strcmp(cmd, "ls")) {
    printDevices();
  } else if (!strcmp(cmd, "v")) {
    g_verbose = !g_verbose;
    light.setVerbose(g_verbose);
    Serial.printf("詳細ログ = %s\n", g_verbose ? "ON" : "OFF");
  } else if (!strcmp(cmd, "?") || !strcmp(cmd, "h")) {
    printHelp();
  } else {
    Serial.printf("不明なコマンド: %s（? でヘルプ）\n", cmd);
  }
}

// ---------------------------------------------------------------- 行読み取り
static char g_buf[64];
static size_t g_len = 0;

void pollSerial() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      g_buf[g_len] = 0;
      if (g_len > 0) handleLine(g_buf);
      g_len = 0;
      Serial.print("> ");
    } else if (g_len < sizeof(g_buf) - 1) {
      g_buf[g_len++] = ch;
    }
  }
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== OdelicMesh SerialConsole ===");
  light.onJoined(onJoined);
  light.onStatus(onStatus);
  if (!light.begin(DISPLAY_ID)) {
    Serial.println("begin 失敗（ID を確認）");
    while (true) delay(1000);
  }
  Serial.println("広告開始。器具の接続を待っています…");
  printHelp();
  Serial.print("> ");
}

void loop() {
  pollSerial();
  delay(10);
}
