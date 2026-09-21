#pragma once
// BLE GATT 伺服器。
//
// UUID 與各特徵值的用途在 docs/SMART_BIN_DESIGN.md 已定案；
// 下面的位元格式是本檔新定義的，需同步寫進文件。
//
// 位元組順序一律為 little-endian，和 ESP32 原生一致，省去轉換與轉錯的機會。
// 所有結構都用 __attribute__((packed))，不讓編譯器插入對齊填充 ——
// 填充位元組會讓兩端對欄位位置的理解不一致，而且會被算進 HMAC。

#include <Arduino.h>
#include "config.h"

// device_info（read）：11 位元組
// 不含任何秘密，任何人都可以讀。用途是讓 App 確認連到的是哪一台、
// 以及對方支援什麼協定版本。
struct __attribute__((packed)) DeviceInfoPayload {
  uint8_t protocolVersion;   // 必須等於 PROTOCOL_VERSION
  uint8_t deviceId[6];       // efuse 出廠 MAC，與 QR 貼紙相同
  uint8_t firmwareMajor;
  uint8_t firmwareMinor;
  uint8_t firmwarePatch;
  uint8_t capabilities;      // 見下方 CAP_ 常數
};

// 能力旗標。App 依此決定要顯示哪些流程，而不是假設所有機台都一樣。
constexpr uint8_t CAP_LATCH_FEEDBACK = 1 << 0;  // 有鎖舌回饋接點
constexpr uint8_t CAP_BAG_DISPENSER  = 1 << 1;  // 有出袋機構
constexpr uint8_t CAP_FULL_SENSOR    = 1 << 2;  // 有滿載偵測

// challenge（read）：21 位元組
// 每次讀取都產生新的 nonce。未被使用的 nonce 可以被新的取代 ——
// 使用者取消操作不會浪費授權，這是刻意的（見 SMART_BIN_DESIGN.md 防重放）。
struct __attribute__((packed)) ChallengePayload {
  uint8_t  protocolVersion;
  uint32_t counter;              // 指令必須帶這個值
  uint8_t  nonce[NONCE_LEN];
};

// status（read, notify）：4 位元組
struct __attribute__((packed)) StatusPayload {
  uint8_t protocolVersion;
  uint8_t state;       // 見 BinState
  uint8_t errorCode;   // 0 代表無錯誤
  uint8_t flags;       // 見下方 STATUS_ 常數
};

enum BinState : uint8_t {
  STATE_IDLE      = 0,  // 待機，可接受指令
  STATE_UNLOCKED  = 1,  // 脈衝中，等鎖舌縮回
  STATE_BUSY      = 2,  // 已有進行中的 session
  STATE_FAULT     = 3,  // 需要維護
  STATE_AWAIT_CLOSE = 4,  // 已斷電，蓋子開著，等使用者關上
};

constexpr uint8_t STATUS_KEY_PROVISIONED = 1 << 0;  // 已佈建金鑰
constexpr uint8_t STATUS_LATCH_CLOSED    = 1 << 1;  // 鎖舌回饋接點閉合

// 啟動 BLE 並開始廣播。必須在 secureStoreBegin() 之後呼叫。
void bleServiceBegin();

// 更新 status 特徵值的內容。狀態改變時呼叫。
void bleUpdateStatus(BinState state, uint8_t errorCode);

// 目前是否有 App 連線。
bool bleIsConnected();

// 目前有效的 nonce。尚未產生過或已被使用時回傳 nullptr。
const uint8_t* currentNonce();

// 產生一組新的 nonce 並回傳。challenge 被讀取時呼叫；
// 開機自我測試也用它來準備測試指令。
const uint8_t* generateNonce();

// 把目前的 nonce 作廢。指令被接受後呼叫 —— 每個 nonce 只能用一次。
void consumeNonce();
