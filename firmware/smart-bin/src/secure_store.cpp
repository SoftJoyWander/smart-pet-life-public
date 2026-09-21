#include "secure_store.h"
#include <Preferences.h>
#include "esp_mac.h"
#include "esp_system.h"

// Preferences 是 Arduino 對 ESP32 NVS（非揮發性儲存）的包裝。
// NVS 有磨損平均，比直接寫 flash 安全。

static Preferences prefs;
static uint8_t  keyBuffer[KEY_LEN];
static bool     keyLoaded = false;
static uint32_t counter = 0;
static uint8_t  idBytes[6];
static char     idHex[13];   // 6 位元組 × 2 個字元 + 結尾的 '\0'

static const char* NAMESPACE   = "bin";
static const char* KEY_BLOB    = "k";
static const char* KEY_COUNTER = "ctr";

bool secureStoreBegin() {
  // 第二個參數 false 代表「可讀寫」。
  if (!prefs.begin(NAMESPACE, false)) return false;

  // 出廠 MAC 當作裝置 ID：每顆晶片唯一、不可改、不需要另外佈建。
  //
  // 用 efuse 裡的原始出廠值，而不是 ESP_MAC_BT。ESP32 的藍牙 MAC 是由
  // 出廠值推導出來的（會差幾個數），而 esptool、燒錄工具與 QR 貼紙看到的
  // 都是出廠值 —— 三者必須一致，否則佈建紀錄會對不起來。
  esp_efuse_mac_get_default(idBytes);
  snprintf(idHex, sizeof(idHex), "%02X%02X%02X%02X%02X%02X",
           idBytes[0], idBytes[1], idBytes[2], idBytes[3], idBytes[4], idBytes[5]);

  counter = prefs.getUInt(KEY_COUNTER, 0);

  // 先問存不存在再讀。直接讀取不存在的鍵，Preferences 會用 ERROR 等級
  // 記一筆 log —— 但「尚未佈建」在開發階段是正常狀態，不是錯誤。
  // 讓預期中的情況印出紅字，會讓真正的錯誤被淹沒。
  //
  // getBytes 回傳實際讀到的長度；長度不符就當作沒有金鑰，
  // 不要拿半截的資料去做 HMAC。
  size_t read = prefs.isKey(KEY_BLOB)
              ? prefs.getBytes(KEY_BLOB, keyBuffer, sizeof(keyBuffer))
              : 0;
  keyLoaded = (read == KEY_LEN);
  if (!keyLoaded) memset(keyBuffer, 0, sizeof(keyBuffer));

  return keyLoaded;
}

bool hasDeviceKey() { return keyLoaded; }

const uint8_t* deviceKey() { return keyLoaded ? keyBuffer : nullptr; }

uint32_t currentCounter() { return counter; }

bool advanceCounter() {
  uint32_t next = counter + 1;

  // 32 位元在這個用量下不會用盡（每天 100 次要用一億年），
  // 但溢位會讓計數器回到 0，等於允許重放。寧可停止服務也不要靜默繞回。
  // 對應 docs/SMART_BIN_DESIGN.md「尚未決定」的計數器溢位項目。
  if (next < counter) return false;

  if (!prefs.putUInt(KEY_COUNTER, next)) return false;
  counter = next;
  return true;
}

bool provisionDeviceKey(const uint8_t* key, size_t len) {
  if (len != KEY_LEN) return false;
  if (prefs.putBytes(KEY_BLOB, key, len) != len) return false;
  memcpy(keyBuffer, key, len);
  keyLoaded = true;
  return true;
}

const uint8_t* deviceId() { return idBytes; }
const char* deviceIdHex() { return idHex; }
