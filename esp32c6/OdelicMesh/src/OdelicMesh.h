/*
 * OdelicMesh.h — ESP32(-C6) から ODELIC CONNECTED LIGHTING を制御するライブラリ。
 *
 * ODELIC の公式アプリは「スマホが BLE ペリフェラル（GATT サーバ）」として動き、
 * 器具の方が接続してくる（docs C17-2 / C18-2）。このライブラリも同じく
 * NimBLE でペリフェラルになり ADV_PHONE を広告して待ち受ける。
 *
 *   [ESP32]  GATT サーバ FFD0(FFD1 Write / FFD2 Notify) + ADV_PHONE 広告
 *              ↓
 *   [器具]   ESP32 に接続 → FFD2 を購読 → FFD1 に参加/制御コマンドを Write
 *              ↓
 *   [ESP32]  FFD2 の Notify で応答・制御コマンドを送信
 *
 * 参加シーケンス（docs C23-6 で確定した最終版。★最初のテストスケッチと違い、
 * ステータス取得のためにログインへ正しく暗号応答し、SET_LINK は送らない）:
 *   1. ADV_PHONE を広告
 *   2. PERIPHERAL_LOGIN(01 19) → LOGINKEY で復号して linkKey を取得、正しい応答を返す
 *   3. GET_PASSWORD(01 00)     → 02 00 <HOMEID> <パスワード> を平文で返す
 *   4. GET_VIRTUAL_ADDR(01 0A) → 割り当てられた own_vAddr を保存
 *   5. WELCOME(01 01) / BROADCAST_MESHINFO(01 02) を受信 → 参加完了
 *   6. 以降 DATA_EVENT で制御。状態要求(0x70) の応答は暗号化(0x06) なので復号する
 *
 * 依存: NimBLE-Arduino v2.x（ESP32-C6 は従来の BLEDevice.h が使えないため）。
 */
#pragma once
#include <Arduino.h>

#include "OdelicCrypto.h"
#include "OdelicMatter.h"

namespace odelic {

static const int ODELIC_MAX_DEVICES = 24;   // 追跡する器具の上限
static const int ODELIC_MAX_LINKS = 4;       // 覚えておく linkKey の数（登録コントローラ枠）

// 器具 1 台の状態（状態要求 0x70 の応答 0x71 と、探索応答から更新される）。
struct OdelicDevice {
  uint8_t vaddr[4];      // 仮想アドレス（キー）
  uint8_t mac[6];        // 器具の MAC（表示順）
  bool hasMac;
  int productCode;       // 製品コード（1 バイト。未取得なら -1）
  int versionProduct;    // 機種コード（ping 応答の 16bit。未取得なら -1）
  int groupId;           // グループ ID（未取得なら -1）
  int on;                // 1=点灯 / 0=消灯 / -1=未取得
  int brightPct;         // 明るさ %（0〜100、未取得なら -1）
  int colorPct;          // 色温度 %（0〜100、未取得なら -1）
  int night;             // 常夜灯 器具値 0〜3（0=消灯 / 3=最も明るい、未取得なら -1）
  uint32_t updatedAtMs;  // 最終更新時刻（millis）
};

class OdelicMesh;

// 参加/状態更新のコールバック（任意）。
typedef void (*OdelicJoinedCb)(OdelicMesh& mesh);
typedef void (*OdelicStatusCb)(OdelicMesh& mesh, const OdelicDevice& dev);

class OdelicMesh {
 public:
  // 8 桁の表示 ID（前 4 桁 = HOMEID / 後 4 桁 = パスワード）で初期化して広告を開始。
  // deviceName は BLE のデバイス名（任意）。成功で true。
  bool begin(const char* displayId8, const char* deviceName = "odelic-caliljp");

  // 参加できているか（送信可能な状態か）。
  bool joined() const { return joined_; }
  bool linkUp() const { return linkUp_; }
  const uint8_t* ownVaddr() const { return ownVaddr_; }
  int deviceNum() const { return deviceNum_; }

  // 既定のグループ番号（group 指定なしの group 系 API が使う）。
  void setDefaultGroup(uint8_t g) { group_ = g; }

  // 色温度換算のケルビン範囲（Matter API 用）。
  void setColorKelvinRange(int minK, int maxK) { colorMinK_ = minK; colorMaxK_ = maxK; }
  // Matter の明るさ軸で常夜灯に割り当てる下端の割合（%）と、常夜灯対応の既定。
  void setNightBand(int percent, bool nightLight) { nightBandPct_ = percent; nightLight_ = nightLight; }

  // ★ BLE 接続間隔の要求値（Notify の送信遅延を縮める）。既定 15〜30ms。
  //    単位: interval は ×1.25ms、timeout は ×10ms。器具（セントラル）が承認すれば反映される。
  void setConnParams(uint16_t minItvl, uint16_t maxItvl, uint16_t latency, uint16_t timeout) {
    connItvlMin_ = minItvl; connItvlMax_ = maxItvl; connLatency_ = latency; connTimeout_ = timeout;
  }
  uint16_t connItvlMin() const { return connItvlMin_; }
  uint16_t connItvlMax() const { return connItvlMax_; }
  uint16_t connLatency() const { return connLatency_; }
  uint16_t connTimeout() const { return connTimeout_; }
  float connIntervalMs() const { return connIntervalMs_; }   // 実測の接続間隔（ms・0=未取得）
  void _setConnInterval(float ms) { connIntervalMs_ = ms; }  // 内部用（コールバックから）

  // ---------------------------------------------------------- 低レベル API
  // すべて「絶対値指定」なので何度送っても結果は同じ（冪等）。

  // 一斉（全器具・チャネル 0x2A）。
  void allOn();
  void allOff();
  void setAll(uint8_t brightPct, uint8_t colorPct);
  void nightAll(uint8_t level);  // level 0〜2（0 が最も明るい）

  // グループ単位（0xC1 / 0xC5）。そのグループの器具にしか届かない。
  void setGroup(uint8_t group, uint8_t brightPct, uint8_t colorPct);
  void onGroup(uint8_t group);
  void offGroup(uint8_t group);
  void nightGroup(uint8_t group, uint8_t level);

  // 器具個別（vAddr 指定・0xC0 サブ 0/1）。
  void setDevice(const uint8_t vaddr[4], uint8_t brightPct, uint8_t colorPct);
  void onDevice(const uint8_t vaddr[4]);   // 器具個別に点灯（ON の特別コード）
  void offDevice(const uint8_t vaddr[4]);  // 器具個別に消灯（OFF の特別コード）
  void nightDevice(const uint8_t vaddr[4], uint8_t level);

  // 既定グループ（setDefaultGroup）向けのショートカット。
  void setLight(uint8_t brightPct, uint8_t colorPct) { setGroup(group_, brightPct, colorPct); }
  void on() { onGroup(group_); }
  void off() { offGroup(group_); }
  void night(uint8_t level) { nightGroup(group_, level); }

  // ---------------------------------------------------------- Matter 風 API
  // 常夜灯 3 段 + 主灯 20 段を 1 本の LevelControl(1〜254) に畳んだ表現（mapping.ts 相当）。
  // target を省略すると既定グループへ。

  void matterOnOff(bool on) { on ? this->on() : this->off(); }
  void matterSetLevel(int level);              // 1〜254
  void matterSetColorMireds(int mireds);       // ColorTemperatureMireds
  void matterSetColorKelvin(int kelvin) { matterSetColorMireds(kelvinToMireds(kelvin)); }

  // Matter の値へ変換して読む（既定グループの代表器具、なければ全体キャッシュ）。
  // 戻り値: onOff(-1=未取得)、level(-1=変えない/未取得)、mireds(-1=未取得)。
  void matterReadState(int& onOff, int& level, int& mireds);

  // ---------------------------------------------------------- ステータス取得
  // 状態要求をブロードキャスト（0x70・チャネル 0x20）。1 通で全器具が応答する（C23-8）。
  // 応答（暗号化 0x06）は自動で復号され device テーブルに反映される。
  void requestStatus();
  // 器具の探索（暗号化 Ping + 製品コード要求 + グループ要求）。参加後に呼ぶ。
  void discover();

  // device テーブルの参照（コールバック内やループから）。
  int deviceCount() const { return deviceCount_; }
  const OdelicDevice* deviceAt(int i) const;
  const OdelicDevice* deviceByVaddr(const uint8_t vaddr[4]) const;

  // メッシュ全体の状態キャッシュ（最後に観測した色温度/明るさ）。
  int cacheOn() const { return cacheOn_; }
  int cacheBrightPct() const { return cacheBright_; }
  int cacheColorPct() const { return cacheColor_; }

  // コールバック登録（任意）。
  void onJoined(OdelicJoinedCb cb) { joinedCb_ = cb; }
  void onStatus(OdelicStatusCb cb) { statusCb_ = cb; }

  // 詳細ログをシリアルに出す。
  void setVerbose(bool v) { verbose_ = v; }
  bool verbose() const { return verbose_; }

  // --- 内部（NimBLE コールバックから呼ばれる。ユーザーは触らない）---
  void _onWrite(const uint8_t* data, size_t len, const uint8_t peer[6]);
  void _onConnect();
  void _onDisconnect();
  void _restartAdvertising();

 private:
  // 送信（FFD2 Notify）。参加していなくても handshake 応答のため送れるようにする。
  void sendRaw(const uint8_t* data, size_t len);
  void sendEncryptedAll(const uint8_t* pdu, size_t len);

  void handleCmd(const uint8_t* d, size_t n, const uint8_t peer[6]);
  void handleDataEvent(const uint8_t* d, size_t n);
  void handleEncrypted(const uint8_t* d, size_t n, const uint8_t peer[6]);

  OdelicDevice* getOrAddDevice(const uint8_t vaddr[4]);
  void applyStatus(OdelicDevice* dev, uint8_t colorCode, uint8_t brightCode, int nightCode);
  void applyCache(uint8_t colorCode, uint8_t brightCode);

  // linkKey（XOR ホワイトニング鍵）テーブル。
  void addLinkKey(const uint8_t peer[6], const uint8_t key[4]);

  // 鍵・ID
  uint8_t homeid_[4];
  uint8_t password_[4];
  uint8_t loginKey_[16];
  uint8_t eventKey_[16];

  // 参加状態
  uint8_t ownVaddr_[4] = {0, 0, 0, 0};
  bool hasVaddr_ = false;
  bool joined_ = false;
  bool linkUp_ = false;
  int deviceNum_ = -1;

  // linkKey テーブル
  struct LinkKey { uint8_t peer[6]; uint8_t key[4]; bool valid; };
  LinkKey links_[ODELIC_MAX_LINKS];
  int linkCount_ = 0;

  // device テーブル
  OdelicDevice devices_[ODELIC_MAX_DEVICES];
  int deviceCount_ = 0;

  // 全体キャッシュ
  int cacheOn_ = -1;
  int cacheBright_ = -1;
  int cacheColor_ = -1;

  // 設定
  uint8_t group_ = 0;
  int colorMinK_ = 2700;
  int colorMaxK_ = 6500;
  int nightBandPct_ = 30;
  bool nightLight_ = true;
  bool verbose_ = false;

  // BLE 接続間隔の要求値（既定 15〜30ms / latency 0 / timeout 4s）と実測値。
  uint16_t connItvlMin_ = 12;
  uint16_t connItvlMax_ = 24;
  uint16_t connLatency_ = 0;
  uint16_t connTimeout_ = 400;
  float connIntervalMs_ = 0;

  OdelicJoinedCb joinedCb_ = nullptr;
  OdelicStatusCb statusCb_ = nullptr;

  portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
};

}  // namespace odelic
