#include "OdelicMesh.h"

#include <NimBLEDevice.h>

#include <string.h>
#include <vector>

namespace odelic {

// -------------------------------------------------------------- 定数（docs 参照）
static const char* UUID_SERVICE = "0000ffd0-0000-1000-8000-00805f9b34fb";
static const char* UUID_WRITE = "0000ffd1-0000-1000-8000-00805f9b34fb";   // 器具→ESP32
static const char* UUID_NOTIFY = "0000ffd2-0000-1000-8000-00805f9b34fb";  // ESP32→器具

static const uint8_t ADV_MAGIC0 = 0xC0;  // flow_control 無効なので常に 0xC0
static const uint8_t ADV_MAGIC1 = 0xFF;
static const uint8_t ADV_PHONE = 0x05;

static const uint8_t PDU_CMD = 0x01;
static const uint8_t PDU_RESPONSE = 0x02;
static const uint8_t PDU_DATA_EVENT = 0x03;
static const uint8_t PDU_ENCRYPTED = 0x06;

static const uint8_t CMD_GET_PASSWORD = 0x00;
static const uint8_t CMD_WELCOME = 0x01;
static const uint8_t CMD_BROADCAST_MESHINFO = 0x02;
static const uint8_t CMD_GET_VIRTUAL_ADDR = 0x0A;
static const uint8_t CMD_PERIPHERAL_LOGIN = 0x19;

static const uint8_t CH_TOLIGHT = 0x20;
static const uint8_t CH_TOLIGHT_2A = 0x2A;
static const uint8_t CH_PING = 0xFE;
static const uint8_t CH_PING_RESPONSE = 0xFF;

static const uint8_t MSGID_BRIGHT = 0xC0;
static const uint8_t MSGID_BRIGHT_GROUP = 0xC1;
static const uint8_t MSGID_NIGHT_GROUP = 0xC5;
static const uint8_t MSGID_STATUS = 0x70;
static const uint8_t MSGID_STATUS_MAIN = 0x71;
static const uint8_t MSGID_STATUS_FD = 0x35;
static const uint8_t MSGID_ID_CENTRAL = 0x02;
static const uint8_t MSGID_ID_PERIPHERAL = 0x80;
static const uint8_t MSGID_GET_GROUP = 0xD0;
static const uint8_t MSGID_GROUP_RESPONSE = 0xD7;

static const uint8_t CODE_ON = 0x37;
static const uint8_t CODE_OFF = 0x32;

static const uint8_t BROADCAST[4] = {0xFF, 0xFF, 0xFF, 0xFF};

// -------------------------------------------------------------- 値エンコード
static uint8_t colorToCode(int pct) {
  int c = pct / 5;
  if (c < 0) c = 0;
  if (c > 20) c = 20;
  return (uint8_t)c;
}
static uint8_t brightToCode(int pct) {
  if (pct == 0) return 19;  // 明るさ 0% は特別値 19（C15-9）
  int c = (100 - pct) / 5;
  if (c < 0) c = 0;
  if (c > 19) c = 19;
  return (uint8_t)c;
}
static int codeToColor(uint8_t code) { return code * 5; }
static int codeToBright(uint8_t code) { return 100 - code * 5; }

static void logHex(const char* tag, const uint8_t* d, size_t n) {
  Serial.print(tag);
  for (size_t i = 0; i < n; i++) {
    if (d[i] < 0x10) Serial.print('0');
    Serial.print(d[i], HEX);
    Serial.print(' ');
  }
  Serial.println();
}

// -------------------------------------------------------------- グローバル
static OdelicMesh* g_self = nullptr;
static NimBLECharacteristic* g_notify = nullptr;

// -------------------------------------------------------------- NimBLE コールバック
class WriteCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    NimBLEAttValue v = c->getValue();
    uint8_t peer[6];
    const uint8_t* pv = info.getAddress().getBase()->val;  // リトルエンディアン
    memcpy(peer, pv, 6);
    if (g_self) g_self->_onWrite(v.data(), v.length(), peer);
  }
};

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    if (!g_self) return;
    // 実測の接続間隔は常に保持（conn コマンド用）。ログは verbose のときだけ（診断用）
    g_self->_setConnInterval(info.getConnInterval() * 1.25f);
    if (g_self->verbose())
      Serial.printf("[BLE] 接続 interval=%.2fms latency=%u timeout=%ums handle=%u\n",
                    info.getConnInterval() * 1.25f, info.getConnLatency(),
                    info.getConnTimeout() * 10, info.getConnHandle());
    g_self->_onConnect();
    // 速い接続間隔を要求（器具が承認すれば Notify 遅延が縮む）
    s->updateConnParams(info.getConnHandle(), g_self->connItvlMin(), g_self->connItvlMax(),
                        g_self->connLatency(), g_self->connTimeout());
    if (g_self->verbose())
      Serial.printf("[BLE] 接続間隔の更新を要求: %.1f〜%.1fms\n",
                    g_self->connItvlMin() * 1.25f, g_self->connItvlMax() * 1.25f);
  }
  // 更新が受理されると呼ばれる（実際に反映された間隔を保持）
  void onConnParamsUpdate(NimBLEConnInfo& info) override {
    if (!g_self) return;
    g_self->_setConnInterval(info.getConnInterval() * 1.25f);
    if (g_self->verbose())
      Serial.printf("[BLE] ★ 接続間隔が更新: %.2fms latency=%u\n",
                    info.getConnInterval() * 1.25f, info.getConnLatency());
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int reason) override {
    if (g_self && g_self->verbose()) Serial.printf("[BLE] 切断 reason=%d\n", reason);
    if (g_self) g_self->_onDisconnect();
  }
};

// -------------------------------------------------------------- begin
bool OdelicMesh::begin(const char* displayId8, const char* deviceName) {
  if (strlen(displayId8) != 8) return false;
  for (int i = 0; i < 8; i++)
    if (displayId8[i] < '0' || displayId8[i] > '9') return false;

  // HOMEID = 前 4 桁を 10 進として LE 4 バイト。パスワード = 後 4 桁の ASCII（C16-2）。
  char h[5] = {displayId8[0], displayId8[1], displayId8[2], displayId8[3], 0};
  uint32_t hv = (uint32_t)atol(h);
  homeid_[0] = hv & 0xFF;
  homeid_[1] = (hv >> 8) & 0xFF;
  homeid_[2] = (hv >> 16) & 0xFF;
  homeid_[3] = (hv >> 24) & 0xFF;
  for (int i = 0; i < 4; i++) password_[i] = (uint8_t)displayId8[4 + i];

  makeKeys(homeid_, password_, loginKey_, eventKey_);
  g_self = this;

  NimBLEDevice::init(deviceName);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  server->advertiseOnDisconnect(true);

  NimBLEService* svc = server->createService(UUID_SERVICE);
  NimBLECharacteristic* wr = svc->createCharacteristic(
      UUID_WRITE,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::READ);
  wr->setCallbacks(new WriteCB());
  g_notify = svc->createCharacteristic(
      UUID_NOTIFY, NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ);
  svc->start();

  _restartAdvertising();
  return true;
}

void OdelicMesh::_restartAdvertising() {
  // ADV_PHONE のマニュファクチャラデータ（C3 / C17-3）:
  //   [company id LE=00 00][C0][FF][05][HOMEID 4][MAC 6(表示順)]
  NimBLEAddress addr = NimBLEDevice::getAddress();
  const uint8_t* le = addr.getBase()->val;
  std::vector<uint8_t> mfg;
  mfg.push_back(0x00);
  mfg.push_back(0x00);  // Company ID = 0
  mfg.push_back(ADV_MAGIC0);
  mfg.push_back(ADV_MAGIC1);
  mfg.push_back(ADV_PHONE);
  for (int i = 0; i < 4; i++) mfg.push_back(homeid_[i]);
  for (int i = 0; i < 6; i++) mfg.push_back(le[5 - i]);  // 表示順に反転

  NimBLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.setManufacturerData(mfg);

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setAdvertisementData(advData);
  adv->setConnectableMode(BLE_GAP_CONN_MODE_UND);
  adv->setMinInterval(0xA0);
  adv->setMaxInterval(0xA0);
  adv->start();
}

// -------------------------------------------------------------- 送信
void OdelicMesh::sendRaw(const uint8_t* data, size_t len) {
  if (!g_notify) return;
  g_notify->setValue(data, len);
  g_notify->notify();
  if (verbose_) logHex("  >> ", data, len);
}

void OdelicMesh::sendEncryptedAll(const uint8_t* pdu, size_t len) {
  uint8_t out[128];
  for (int i = 0; i < linkCount_; i++) {
    if (!links_[i].valid) continue;
    int n = encryptPdu(pdu, len, eventKey_, links_[i].key, out, sizeof(out));
    if (n > 0) sendRaw(out, (size_t)n);
  }
}

// -------------------------------------------------------------- linkKey テーブル
void OdelicMesh::addLinkKey(const uint8_t peer[6], const uint8_t key[4]) {
  portENTER_CRITICAL(&mux_);
  // 既存の同一 peer を更新
  for (int i = 0; i < linkCount_; i++) {
    if (links_[i].valid && memcmp(links_[i].peer, peer, 6) == 0) {
      memcpy(links_[i].key, key, 4);
      portEXIT_CRITICAL(&mux_);
      return;
    }
  }
  if (linkCount_ < ODELIC_MAX_LINKS) {
    memcpy(links_[linkCount_].peer, peer, 6);
    memcpy(links_[linkCount_].key, key, 4);
    links_[linkCount_].valid = true;
    linkCount_++;
  } else {
    // 枠がいっぱいなら最古（0 番）を置き換える
    memmove(&links_[0], &links_[1], sizeof(LinkKey) * (ODELIC_MAX_LINKS - 1));
    memcpy(links_[ODELIC_MAX_LINKS - 1].peer, peer, 6);
    memcpy(links_[ODELIC_MAX_LINKS - 1].key, key, 4);
    links_[ODELIC_MAX_LINKS - 1].valid = true;
  }
  portEXIT_CRITICAL(&mux_);
}

// -------------------------------------------------------------- 受信
void OdelicMesh::_onConnect() {
  linkUp_ = true;
  if (verbose_) Serial.println("[BLE] 器具が接続");
}

void OdelicMesh::_onDisconnect() {
  linkUp_ = false;
  joined_ = false;
  hasVaddr_ = false;
  if (verbose_) Serial.println("[BLE] 切断 → 広告再開");
  _restartAdvertising();
}

void OdelicMesh::_onWrite(const uint8_t* data, size_t len, const uint8_t peer[6]) {
  if (len < 1) return;
  if (verbose_) logHex("  << ", data, len);
  linkUp_ = true;
  switch (data[0]) {
    case PDU_CMD: handleCmd(data, len, peer); break;
    case PDU_DATA_EVENT: handleDataEvent(data, len); break;
    case PDU_ENCRYPTED: handleEncrypted(data, len, peer); break;
    default: break;
  }
}

void OdelicMesh::handleCmd(const uint8_t* d, size_t n, const uint8_t peer[6]) {
  if (n < 2) return;
  uint8_t sub = d[1];

  if (sub == CMD_PERIPHERAL_LOGIN) {
    // LOGINKEY で復号し HOMEID を照合、linkKey を取り出して正しい応答を返す（C23-1/2）。
    if (n < 2 + 16) return;
    uint8_t linkKey[4];
    if (!parseLogin(loginKey_, homeid_, d + 2, linkKey)) {
      if (verbose_) Serial.println("     LOGIN: HOMEID 不一致（ID を確認）");
      return;
    }
    addLinkKey(peer, linkKey);
    uint8_t resp[18];
    makeLoginResponse(loginKey_, homeid_, password_, linkKey, resp);
    sendRaw(resp, sizeof(resp));
    if (verbose_) logHex("     LOGIN ok linkKey=", linkKey, 4);
    return;
  }

  if (sub == CMD_GET_PASSWORD) {
    uint8_t resp[10];
    resp[0] = PDU_RESPONSE;
    resp[1] = CMD_GET_PASSWORD;
    memcpy(resp + 2, homeid_, 4);
    memcpy(resp + 6, password_, 4);
    sendRaw(resp, sizeof(resp));
    return;
  }

  if (sub == CMD_GET_VIRTUAL_ADDR && n >= 6) {
    memcpy(ownVaddr_, d + 2, 4);
    hasVaddr_ = true;
    if (verbose_) logHex("     own_vAddr=", ownVaddr_, 4);
    return;
  }

  if (sub == CMD_WELCOME) {
    // ★ SET_LINK は送らない（C23-6。バックアップリンク専用で、送ると応答が来なくなる）。
    return;
  }

  if (sub == CMD_BROADCAST_MESHINFO) {
    if (n >= 10) deviceNum_ = d[8] | (d[9] << 8);
    joined_ = true;
    if (verbose_) Serial.printf("     ★ 参加完了（器具 %d 台）\n", deviceNum_);
    if (joinedCb_) joinedCb_(*this);
    return;
  }
}

void OdelicMesh::handleEncrypted(const uint8_t* d, size_t n, const uint8_t peer[6]) {
  uint8_t out[128];
  // まず書き込んできた器具の鍵、次に他の鍵を試す（パディング検査で誤鍵を弾く）。
  int order[ODELIC_MAX_LINKS];
  int cnt = 0;
  for (int i = 0; i < linkCount_; i++)
    if (links_[i].valid && memcmp(links_[i].peer, peer, 6) == 0) order[cnt++] = i;
  for (int i = 0; i < linkCount_; i++)
    if (links_[i].valid && memcmp(links_[i].peer, peer, 6) != 0) order[cnt++] = i;

  for (int k = 0; k < cnt; k++) {
    int m = decryptPdu(d, n, eventKey_, links_[order[k]].key, out, sizeof(out));
    if (m > 0) {
      if (verbose_) logHex("     ↓復号 ", out, (size_t)m);
      handleDataEvent(out, (size_t)m);
      return;
    }
  }
  if (verbose_) Serial.println("     [!] 復号失敗（鍵不足かも）");
}

void OdelicMesh::handleDataEvent(const uint8_t* d, size_t n) {
  if (n < 6) return;
  uint8_t channel = d[5];

  if (channel == CH_PING_RESPONSE) {  // Ping 応答（C23-4）
    if (n < 20) return;
    uint8_t vaddr[4];
    memcpy(vaddr, d + 12, 4);
    OdelicDevice* dev = getOrAddDevice(vaddr);
    if (dev) {
      memcpy(dev->mac, d + 6, 6);
      dev->hasMac = true;
      dev->versionProduct = d[16] | (d[17] << 8);
      dev->updatedAtMs = millis();
    }
    return;
  }

  if (n < 11) return;
  const uint8_t* src = d + 6;
  uint8_t msgid = d[10];
  const uint8_t* params = d + 11;
  size_t plen = n - 11;

  if (msgid == MSGID_ID_PERIPHERAL && plen >= 7) {  // 自己申告: MAC + 製品コード
    OdelicDevice* dev = getOrAddDevice(src);
    if (dev) {
      memcpy(dev->mac, params, 6);
      dev->hasMac = true;
      dev->productCode = params[6];
      dev->updatedAtMs = millis();
    }
    return;
  }

  if (msgid == MSGID_GROUP_RESPONSE && plen >= 8) {  // グループ ID
    OdelicDevice* dev = getOrAddDevice(src);
    if (dev) {
      dev->groupId = params[7];
      dev->updatedAtMs = millis();
    }
    return;
  }

  if ((msgid == MSGID_STATUS_MAIN || msgid == MSGID_STATUS_FD) && plen >= 2) {
    uint8_t colorCode = params[0], brightCode = params[1];
    int nightCode = (plen >= 3) ? params[2] : -1;  // 常夜灯（0=消灯 / 1〜3、C24-6）
    OdelicDevice* dev = getOrAddDevice(src);
    applyCache(colorCode, brightCode);
    if (dev) {
      applyStatus(dev, colorCode, brightCode, nightCode);
      if (statusCb_) statusCb_(*this, *dev);
    }
    return;
  }

  // 他のコントローラ（公式アプリ等）が送ったコマンドが平文で中継されてくる（C28）。
  if (msgid == MSGID_BRIGHT && plen >= 3) {
    if (memcmp(src, ownVaddr_, 4) != 0) {
      if (params[0] == 0x00) applyCache(params[1], params[2]);
    }
  }
}

// -------------------------------------------------------------- device テーブル
OdelicDevice* OdelicMesh::getOrAddDevice(const uint8_t vaddr[4]) {
  portENTER_CRITICAL(&mux_);
  for (int i = 0; i < deviceCount_; i++) {
    if (memcmp(devices_[i].vaddr, vaddr, 4) == 0) {
      portEXIT_CRITICAL(&mux_);
      return &devices_[i];
    }
  }
  if (deviceCount_ >= ODELIC_MAX_DEVICES) {
    portEXIT_CRITICAL(&mux_);
    return nullptr;
  }
  OdelicDevice& dev = devices_[deviceCount_++];
  memset(&dev, 0, sizeof(dev));
  memcpy(dev.vaddr, vaddr, 4);
  dev.productCode = -1;
  dev.versionProduct = -1;
  dev.groupId = -1;
  dev.on = -1;
  dev.brightPct = -1;
  dev.colorPct = -1;
  dev.night = -1;
  portEXIT_CRITICAL(&mux_);
  return &dev;
}

void OdelicMesh::applyStatus(OdelicDevice* dev, uint8_t colorCode, uint8_t brightCode,
                             int nightCode) {
  if (colorCode == CODE_OFF && brightCode == CODE_OFF) {
    dev->on = 0;  // 主灯は消灯（常夜灯は night バイトで別途判定）
  } else if (colorCode == CODE_ON && brightCode == CODE_ON) {
    dev->on = 1;  // ON の実値は器具依存。bright/color は前回値のまま
  } else {
    dev->colorPct = codeToColor(colorCode);
    dev->brightPct = codeToBright(brightCode);
    dev->on = dev->brightPct > 0 ? 1 : 0;
  }
  if (nightCode >= 0) dev->night = nightCode;
  dev->updatedAtMs = millis();
}

void OdelicMesh::applyCache(uint8_t colorCode, uint8_t brightCode) {
  if (colorCode == CODE_OFF && brightCode == CODE_OFF) {
    cacheOn_ = 0;
  } else if (colorCode == CODE_ON && brightCode == CODE_ON) {
    cacheOn_ = 1;
  } else {
    cacheColor_ = codeToColor(colorCode);
    cacheBright_ = codeToBright(brightCode);
    cacheOn_ = cacheBright_ > 0 ? 1 : 0;
  }
}

const OdelicDevice* OdelicMesh::deviceAt(int i) const {
  if (i < 0 || i >= deviceCount_) return nullptr;
  return &devices_[i];
}

const OdelicDevice* OdelicMesh::deviceByVaddr(const uint8_t vaddr[4]) const {
  for (int i = 0; i < deviceCount_; i++)
    if (memcmp(devices_[i].vaddr, vaddr, 4) == 0) return &devices_[i];
  return nullptr;
}

// -------------------------------------------------------------- PDU 組み立て + 送信
// グループ宛（0xC1 / 0xC5）
void OdelicMesh::setGroup(uint8_t group, uint8_t brightPct, uint8_t colorPct) {
  uint8_t pdu[20];
  pdu[0] = PDU_DATA_EVENT;
  memset(pdu + 1, 0xFF, 4);
  pdu[5] = CH_TOLIGHT;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT_GROUP;
  pdu[11] = colorToCode(colorPct);
  pdu[12] = brightToCode(brightPct);
  memset(pdu + 13, 0, 6);
  pdu[19] = group;
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::onGroup(uint8_t group) {
  uint8_t pdu[20] = {PDU_DATA_EVENT, 0xFF, 0xFF, 0xFF, 0xFF, CH_TOLIGHT};
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT_GROUP;
  pdu[11] = CODE_ON;
  pdu[12] = CODE_ON;
  memset(pdu + 13, 0, 6);
  pdu[19] = group;
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::offGroup(uint8_t group) {
  uint8_t pdu[20] = {PDU_DATA_EVENT, 0xFF, 0xFF, 0xFF, 0xFF, CH_TOLIGHT};
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT_GROUP;
  pdu[11] = CODE_OFF;
  pdu[12] = CODE_OFF;
  memset(pdu + 13, 0, 6);
  pdu[19] = group;
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::nightGroup(uint8_t group, uint8_t level) {
  uint8_t pdu[20];
  pdu[0] = PDU_DATA_EVENT;
  memset(pdu + 1, 0xFF, 4);
  pdu[5] = CH_TOLIGHT;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_NIGHT_GROUP;
  pdu[11] = 0x00;
  pdu[12] = level;  // [1] = レベル
  memset(pdu + 13, 0, 6);
  pdu[19] = group;
  sendRaw(pdu, sizeof(pdu));
}

// 一斉（0xC0 / チャネル 0x2A）
void OdelicMesh::setAll(uint8_t brightPct, uint8_t colorPct) {
  uint8_t pdu[18];
  pdu[0] = PDU_DATA_EVENT;
  memset(pdu + 1, 0xFF, 4);
  pdu[5] = CH_TOLIGHT_2A;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x00;  // サブコマンド 0（色温度 + 明るさ）
  pdu[12] = colorToCode(colorPct);
  pdu[13] = brightToCode(brightPct);
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::allOn() {
  uint8_t pdu[18] = {PDU_DATA_EVENT, 0xFF, 0xFF, 0xFF, 0xFF, CH_TOLIGHT_2A};
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x00;
  pdu[12] = CODE_ON;
  pdu[13] = CODE_ON;
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::allOff() {
  uint8_t pdu[18] = {PDU_DATA_EVENT, 0xFF, 0xFF, 0xFF, 0xFF, CH_TOLIGHT_2A};
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x00;
  pdu[12] = CODE_OFF;
  pdu[13] = CODE_OFF;
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::nightAll(uint8_t level) {
  // dst = FF FF FF FF → チャネル 0x2A、0xC0 サブコマンド 1（C24-3）
  uint8_t pdu[18];
  pdu[0] = PDU_DATA_EVENT;
  memset(pdu + 1, 0xFF, 4);
  pdu[5] = CH_TOLIGHT_2A;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x01;  // サブコマンド 1（ナイトライト）
  pdu[12] = 0x00;
  pdu[13] = level;  // [7] = レベル
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}

// 器具個別（0xC0 / チャネル 0x20）
void OdelicMesh::setDevice(const uint8_t vaddr[4], uint8_t brightPct, uint8_t colorPct) {
  uint8_t pdu[18];
  pdu[0] = PDU_DATA_EVENT;
  memcpy(pdu + 1, vaddr, 4);
  pdu[5] = CH_TOLIGHT;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x00;
  pdu[12] = colorToCode(colorPct);
  pdu[13] = brightToCode(brightPct);
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::onDevice(const uint8_t vaddr[4]) {
  uint8_t pdu[18];
  pdu[0] = PDU_DATA_EVENT;
  memcpy(pdu + 1, vaddr, 4);
  pdu[5] = CH_TOLIGHT;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x00;
  pdu[12] = CODE_ON;
  pdu[13] = CODE_ON;
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::offDevice(const uint8_t vaddr[4]) {
  uint8_t pdu[18];
  pdu[0] = PDU_DATA_EVENT;
  memcpy(pdu + 1, vaddr, 4);
  pdu[5] = CH_TOLIGHT;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x00;
  pdu[12] = CODE_OFF;
  pdu[13] = CODE_OFF;
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}
void OdelicMesh::nightDevice(const uint8_t vaddr[4], uint8_t level) {
  uint8_t pdu[18];
  pdu[0] = PDU_DATA_EVENT;
  memcpy(pdu + 1, vaddr, 4);
  pdu[5] = CH_TOLIGHT;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_BRIGHT;
  pdu[11] = 0x01;
  pdu[12] = 0x00;
  pdu[13] = level;
  memset(pdu + 14, 0, 4);
  sendRaw(pdu, sizeof(pdu));
}

// -------------------------------------------------------------- ステータス取得
void OdelicMesh::requestStatus() {
  // dst = FF FF FF FF・チャネル 0x20 なら 1 通で全器具が応答する（C23-8）。
  uint8_t pdu[11];
  pdu[0] = PDU_DATA_EVENT;
  memset(pdu + 1, 0xFF, 4);
  pdu[5] = CH_TOLIGHT;
  memcpy(pdu + 6, ownVaddr_, 4);
  pdu[10] = MSGID_STATUS;
  sendRaw(pdu, sizeof(pdu));
}

void OdelicMesh::discover() {
  // 1. 暗号化 Ping（チャネル 0xFE）→ 器具が MAC + vAddr + 機種 + ファームを返す
  uint8_t ping[10];
  ping[0] = PDU_DATA_EVENT;
  memset(ping + 1, 0xFF, 4);
  ping[5] = CH_PING;
  memcpy(ping + 6, ownVaddr_, 4);
  sendEncryptedAll(ping, sizeof(ping));

  // 2. 製品コード要求（MSGID 0x02）→ 器具が 0x80 で応答
  uint8_t prod[11];
  prod[0] = PDU_DATA_EVENT;
  memset(prod + 1, 0xFF, 4);
  prod[5] = CH_TOLIGHT;
  memcpy(prod + 6, ownVaddr_, 4);
  prod[10] = MSGID_ID_CENTRAL;
  sendRaw(prod, sizeof(prod));

  // 3. グループ ID 要求（MSGID 0xD0 01）→ 器具が 0xD7 で応答
  uint8_t grp[12];
  grp[0] = PDU_DATA_EVENT;
  memset(grp + 1, 0xFF, 4);
  grp[5] = CH_TOLIGHT;
  memcpy(grp + 6, ownVaddr_, 4);
  grp[10] = MSGID_GET_GROUP;
  grp[11] = 0x01;
  sendRaw(grp, sizeof(grp));
}

// -------------------------------------------------------------- Matter 風 API
void OdelicMesh::matterSetLevel(int level) {
  LightTarget t = matterLevelToTarget(level, nightBandPct_, nightLight_);
  if (t.night) {
    night(t.nightLevel);
  } else {
    // 色温度は現在のキャッシュ値を維持（未取得なら 50%）
    int color = cacheColor_ >= 0 ? cacheColor_ : 50;
    setLight(t.bright, color);
  }
}

void OdelicMesh::matterSetColorMireds(int mireds) {
  int color = miredsToColorPercent(mireds, colorMinK_, colorMaxK_);
  int bright = cacheBright_ >= 0 ? cacheBright_ : 60;
  setLight(bright, color);
}

void OdelicMesh::matterReadState(int& onOff, int& level, int& mireds) {
  // 既定グループの代表器具を探す。なければ全体キャッシュ。
  const OdelicDevice* rep = nullptr;
  for (int i = 0; i < deviceCount_; i++) {
    if (devices_[i].groupId < 0 || devices_[i].groupId == group_) {
      rep = &devices_[i];
      break;
    }
  }
  int on = -1, color = -1, night = -1, bright = -1;
  if (rep) {
    on = rep->on;
    color = rep->colorPct;
    night = rep->night;
    bright = rep->brightPct;
  } else {
    on = cacheOn_;
    color = cacheColor_;
    bright = cacheBright_;
  }

  mireds = (color < 0) ? -1 : colorPercentToMireds(color, colorMinK_, colorMaxK_);

  // deviceStateToMatter 相当（mapping.ts）
  if (night > 0) {
    LightTarget t{true, nightDeviceToLevel(night), 0};
    onOff = 1;
    level = targetToMatterLevel(t, nightBandPct_, nightLight_);
    return;
  }
  if (on == 1) {
    if (bright <= 0) {
      onOff = 1;
      level = -1;  // ON だが明るさ未取得。level は動かさない
    } else {
      LightTarget t{false, 0, (uint8_t)bright};
      onOff = 1;
      level = targetToMatterLevel(t, nightBandPct_, nightLight_);
    }
    return;
  }
  if (on == 0) {
    onOff = 0;
    level = -1;  // 消灯中は CurrentLevel を触らない
    return;
  }
  onOff = -1;
  level = -1;
}

}  // namespace odelic
