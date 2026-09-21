#include "ble_service.h"
#include "crypto.h"
#include "secure_store.h"
#include "session.h"
#include <NimBLEDevice.h>

// 韌體版本。改動協定或行為時要遞增，App 端才能判斷相容性。
constexpr uint8_t FW_MAJOR = 0;
constexpr uint8_t FW_MINOR = 2;   // 階段二
constexpr uint8_t FW_PATCH = 0;

static NimBLECharacteristic* statusChar    = nullptr;
static NimBLECharacteristic* challengeChar = nullptr;
static bool     connected = false;
static bool     nonceValid = false;
static uint8_t  nonceBuffer[NONCE_LEN];
static StatusPayload statusValue{};

// ───────────────────────── 連線回呼 ─────────────────────────

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server) override {
    connected = true;
    Serial.println("[BLE] App 已連線");
  }

  void onDisconnect(NimBLEServer* server) override {
    connected = false;
    Serial.println("[BLE] App 已斷線");

    // 斷線後必須重新開始廣播，否則這台裝置就再也不會被任何人看到。
    // NimBLE 不會自動重啟廣播 —— 這是很常見的「用一次就失效」的原因。
    NimBLEDevice::startAdvertising();
  }
};

// ───────────────────────── challenge 讀取回呼 ─────────────────────────

class ChallengeCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic* characteristic) override {
    // 每次讀取都產生新的 nonce。舊的未使用 nonce 直接被取代 ——
    // 使用者按了解鎖又取消，不該把授權機會用掉。
    generateNonce();

    ChallengePayload payload{};
    payload.protocolVersion = PROTOCOL_VERSION;
    payload.counter = currentCounter();
    memcpy(payload.nonce, nonceBuffer, NONCE_LEN);

    characteristic->setValue((uint8_t*)&payload, sizeof(payload));
    Serial.printf("[BLE] 產生新 challenge，計數器=%lu\n",
                  (unsigned long)payload.counter);

#ifdef DEV_PROVISIONING
    // nonce 本來就是公開的（App 讀得到），印出來不構成洩漏。
    // 這裡印它只是為了開發時方便從序列埠取值組指令，正式版不需要這行噪音。
    Serial.print("[開發] nonce=");
    for (size_t i = 0; i < NONCE_LEN; i++) Serial.printf("%02X", nonceBuffer[i]);
    Serial.println();
#endif
  }
};

// ───────────────────────── command 寫入回呼 ─────────────────────────

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic) override {
    std::string value = characteristic->getValue();
    CommandResult result =
        handleCommand((const uint8_t*)value.data(), value.size());

    // 拒絕原因寫進 status 讓 App 能顯示具體錯誤，而不是只說「失敗」。
    // 這些欄位都不是秘密：nonce 與計數器本來就可以讀。
    if (result != CMD_OK) {
      Serial.printf("[SESSION] 指令被拒：%s（%u 位元組）\n",
                    commandResultName(result), (unsigned)value.size());
      bleUpdateStatus(sessionState(), (uint8_t)result);
    }
  }
};

// ───────────────────────── 啟動 ─────────────────────────

void bleServiceBegin() {
  // 廣播名稱帶裝置 ID 末四碼，讓現場有多台機器時分得出來。
  // 完整 ID 在 device_info 裡，名稱只是給人看的。
  char name[20];
  const uint8_t* id = deviceId();
  snprintf(name, sizeof(name), "SPL-BIN-%02X%02X", id[4], id[5]);

  NimBLEDevice::init(name);

  // 這一行必須在 NimBLEDevice::init 之後。ESP32 的硬體亂數產生器要靠
  // RF 電路的熱雜訊當熵源，藍牙沒啟動時 esp_random() 會退化成品質較低的
  // 來源。nonce 可被預測等於防重放失效。
  markRandomSourceReady();

  // 不使用 BLE 配對或綁定。公共設備會被大量帳號連線，bonding 是為個人
  // 配對設計的，會累積綁定紀錄並在使用者換手機時失效。安全性來自應用層
  // 的 HMAC 與 nonce，不是 BLE 鏈路加密。
  NimBLEDevice::setSecurityAuth(false, false, false);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* service = server->createService(BIN_SERVICE_UUID);

  // device_info：內容固定，開機時填一次即可，不需要回呼。
  DeviceInfoPayload info{};
  info.protocolVersion = PROTOCOL_VERSION;
  memcpy(info.deviceId, id, 6);
  info.firmwareMajor = FW_MAJOR;
  info.firmwareMinor = FW_MINOR;
  info.firmwarePatch = FW_PATCH;
  // 目前硬體只有鎖舌回饋；出袋與滿載偵測是後續階段的機構。
  info.capabilities = CAP_LATCH_FEEDBACK;

  NimBLECharacteristic* infoChar =
      service->createCharacteristic(CHAR_DEVICE_INFO_UUID, NIMBLE_PROPERTY::READ);
  infoChar->setValue((uint8_t*)&info, sizeof(info));

  statusChar = service->createCharacteristic(
      CHAR_STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  bleUpdateStatus(STATE_IDLE, 0);

  challengeChar = service->createCharacteristic(CHAR_CHALLENGE_UUID, NIMBLE_PROPERTY::READ);
  challengeChar->setCallbacks(new ChallengeCallbacks());

  NimBLECharacteristic* commandChar =
      service->createCharacteristic(CHAR_COMMAND_UUID, NIMBLE_PROPERTY::WRITE);
  commandChar->setCallbacks(new CommandCallbacks());

  service->start();

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(BIN_SERVICE_UUID);
  // 廣播封包裡帶服務 UUID，App 才能只掃出這一類裝置而不是整個房間。
  advertising->setScanResponse(true);
  advertising->start();

  Serial.printf("[BLE] 已啟動並開始廣播：%s\n", name);
  Serial.printf("[BLE] 服務 UUID：%s\n", BIN_SERVICE_UUID);
}

void bleUpdateStatus(BinState state, uint8_t errorCode) {
  statusValue.protocolVersion = PROTOCOL_VERSION;
  statusValue.state = state;
  statusValue.errorCode = errorCode;

  statusValue.flags = 0;
  if (hasDeviceKey()) statusValue.flags |= STATUS_KEY_PROVISIONED;
  if (digitalRead(PIN_FEEDBACK) == LOW) statusValue.flags |= STATUS_LATCH_CLOSED;

  if (statusChar != nullptr) {
    statusChar->setValue((uint8_t*)&statusValue, sizeof(statusValue));
    // 只在有人連線時才 notify。沒有訂閱者時呼叫 notify 是浪費，
    // 而且部分堆疊會記錄錯誤。
    if (connected) statusChar->notify();
  }
}

bool bleIsConnected() { return connected; }

const uint8_t* currentNonce() { return nonceValid ? nonceBuffer : nullptr; }

const uint8_t* generateNonce() {
  fillRandom(nonceBuffer, NONCE_LEN);
  nonceValid = true;
  return nonceBuffer;
}

void consumeNonce() { nonceValid = false; }
