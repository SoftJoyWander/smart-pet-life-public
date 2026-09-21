// 智能垃圾桶韌體
//
// 目前進度：硬體模擬電路已驗證，密碼學與儲存層（階段一）完成。
// BLE 尚未實作。接線與腳位對照見 docs/SMART_BIN_WIRING.md，
// 協定與安全模型見 docs/SMART_BIN_DESIGN.md。
//
// 硬體模擬：按鈕代替鎖舌回饋接點、LED 代替電磁鎖。
// 對 ESP32 而言兩者本來就是同一件事（腳位被拉到 GND／輸出高電位），
// 所以真鎖到貨後只換實體零件，這份程式不需修改。

#include <Arduino.h>
#include "config.h"
#include "secure_store.h"
#include "selftest.h"
#include "ble_service.h"
#include "session.h"
#include "crypto.h"
#include "secure_store.h"

#ifdef DEV_PROVISIONING
// 開發用的金鑰佈建。讀序列埠，輸入 provision 就產生一把隨機金鑰寫進 NVS，
// 並把它印出來讓後端／測試工具使用。
//
// ⚠️ 這段只在 DEV_PROVISIONING 旗標存在時才會被編譯。正式韌體不該有
// 「把金鑰印到序列埠」這種能力 —— 任何能碰到 USB 的人都會拿到它。
static void handleDevSerial() {
  static String line;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      line.trim();
      if (line == "provision") {
        uint8_t key[KEY_LEN];
        fillRandom(key, KEY_LEN);
        if (provisionDeviceKey(key, KEY_LEN)) {
          Serial.print("[開發] 已寫入金鑰：");
          for (size_t i = 0; i < KEY_LEN; i++) Serial.printf("%02X", key[i]);
          Serial.println();
          Serial.println("[開發] 請重開機讓指令驗證測試跑起來");
        } else {
          Serial.println("[開發] 金鑰寫入失敗");
        }
        memset(key, 0, sizeof(key));
      } else if (line == "nonce") {
        // 印出「目前」的 nonce，不重新產生 —— 這樣才能對應到使用者剛才
        // 從手機讀到的那一組。重新產生會讓兩邊對不上。
        const uint8_t* n = currentNonce();
        if (n == nullptr) {
          Serial.println("[開發] 尚未產生 nonce，請先從手機讀 challenge");
        } else {
          Serial.printf("[開發] 計數器=%lu nonce=", (unsigned long)currentCounter());
          for (size_t i = 0; i < NONCE_LEN; i++) Serial.printf("%02X", n[i]);
          Serial.println();
        }
      } else if (line.length() > 0) {
        Serial.printf("[開發] 未知指令：%s\n", line.c_str());
      }
      line = "";
    } else if (line.length() < 64) {
      line += c;
    }
  }
}
#endif

void setup() {
  // ⚠️ 這兩行必須在最前面。
  // ESP32 重開機時 GPIO 有一小段浮空期，電位不確定。晚設定的話那段空窗
  // MOS 可能被誤觸發，鎖就無故打開。硬體上的 10kΩ 下拉是另一道防線，
  // 兩者都要有。
  pinMode(PIN_LOCK, OUTPUT);
  digitalWrite(PIN_LOCK, LOW);

  Serial.begin(115200);
  delay(300);  // 給 USB 序列埠時間連上，否則開頭幾行會看不到

  // INPUT_PULLUP：晶片內部把腳位拉到 3.3V，接點閉合時被拉到 GND。
  // 邏輯是反的 —— 讀到 LOW 才代表「接通」。
  pinMode(PIN_FEEDBACK, INPUT_PULLUP);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_STATUS, OUTPUT);

  Serial.println();
  Serial.printf("=== 智能垃圾桶韌體｜%s ===\n", BOARD_NAME);

  // 儲存層要先起來，自我測試才能回報金鑰與計數器狀態。
  // 回傳 false 只代表尚未佈建金鑰，開發階段是正常的，不算錯誤。
  secureStoreBegin();
  runSelfTest();

  Serial.printf("開鎖控制 GPIO%u ｜ 鎖舌回饋 GPIO%u ｜ 狀態燈 GPIO%u\n",
                PIN_LOCK, PIN_FEEDBACK, PIN_STATUS);

  // BLE 必須在 secureStoreBegin() 之後啟動 —— 廣播名稱與 device_info
  // 都要用到裝置 ID，而且 status 要回報金鑰是否已佈建。
  bleServiceBegin();

  // 指令驗證測試必須在 BLE 之後 —— 它要產生 nonce，而 nonce 的亂數
  // 來源要等 RF 啟動才可靠。
  runCommandSelfTest();

#ifdef DEV_PROVISIONING
  Serial.println("[開發] 在序列埠輸入 provision 可產生並寫入測試金鑰");
#endif

  // 開機時無條件印出回饋現況。
  // 原本用「預設成相反值讓第一圈自動觸發」的寫法比較省程式碼，但狀態
  // 恰好等於預設值時就什麼都不印 —— 於是「沒印」同時代表兩種情況，
  // 遠端診斷時分不出來。實際踩過，改成無條件印。
  Serial.printf("[開機狀態] %s\n",
                digitalRead(PIN_FEEDBACK) == LOW ? "接點閉合（鎖舌縮回）"
                                                 : "接點開路（鎖舌伸出）");
}

void loop() {
  // 回饋接點的防彈跳與邊緣偵測已經移到 session.cpp ——
  // 狀態機需要邊緣訊號，兩邊各自讀腳位又各自防彈跳會得到不一致的結果。
  //
  // PIN_LOCK 現在只由狀態機驅動。先前模擬階段是「按鈕按下就點亮鎖」，
  // 那在真鎖接上之後必須拿掉：開鎖只能由通過驗證的指令觸發。
  static uint32_t lastBlink = 0;
  static uint32_t lastReport = 0;

  uint32_t now = millis();

  sessionTick();

  // 上板除錯用的現況回報，正式版移除。
  if (now - lastReport >= 2000) {
    lastReport = now;
    Serial.printf("[現況] 鎖舌=%s  狀態=%u  錯誤=%u  IO4=%s  BLE=%s\n",
                  latchIsRetracted() ? "縮回" : "伸出",
                  (unsigned)sessionState(), (unsigned)sessionError(),
                  digitalRead(PIN_LOCK) == HIGH ? "通電" : "斷電",
                  bleIsConnected() ? "已連線" : "廣播中");
  }

  // 心跳燈：證明程式沒有卡死。
  // 用 millis() 比較而不是 delay()，因為 delay() 會停住整個迴圈，
  // 之後要同時處理 BLE 連線與開鎖逾時就做不到。這種寫法叫非阻塞。
  if (now - lastBlink >= 500) {
    lastBlink = now;
    digitalWrite(PIN_STATUS, !digitalRead(PIN_STATUS));
  }
}
