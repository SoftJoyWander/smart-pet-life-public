#pragma once
// 智能垃圾桶韌體的集中設定。
// 把「會被調整的數字」和「程式邏輯」分開，避免日後要改一個秒數卻得翻遍整份程式。

#include <Arduino.h>

// ───────────────────────── 協定 ─────────────────────────

// 協定版本。裝置只接受版本相符的指令；日後改變位元格式時遞增，
// 舊版 App 會被明確拒絕，而不是把欄位解讀錯。
constexpr uint8_t PROTOCOL_VERSION = 1;

// BLE GATT UUID。這些在 docs/SMART_BIN_DESIGN.md 已定案，實作不得更動。
#define BIN_SERVICE_UUID      "e8ae10a8-8d17-435e-a740-126febf4f705"
#define CHAR_DEVICE_INFO_UUID "00011000-8d17-435e-a740-126febf4f705"
#define CHAR_STATUS_UUID      "00021000-8d17-435e-a740-126febf4f705"
#define CHAR_CHALLENGE_UUID   "00031000-8d17-435e-a740-126febf4f705"
#define CHAR_COMMAND_UUID     "00041000-8d17-435e-a740-126febf4f705"
#define CHAR_EVENT_UUID       "00051000-8d17-435e-a740-126febf4f705"
#define CHAR_RECEIPT_UUID     "00061000-8d17-435e-a740-126febf4f705"

// ───────────────────────── 密碼學參數 ─────────────────────────

constexpr size_t KEY_LEN   = 32;  // 裝置金鑰 K，HMAC-SHA256 的區塊大小
constexpr size_t NONCE_LEN = 16;  // 一次性亂數
constexpr size_t MAC_LEN   = 16;  // HMAC 截斷後長度（128 bit）

// 為什麼截斷到 128 bit 而不是用完整的 256 bit：
// BLE 單次寫入的有效酬載很小（預設 MTU 23 位元組，扣掉標頭只剩 20），
// 多出來的 16 位元組要多一次分段傳輸。128 bit 對「偽造單一指令」這個
// 威脅模型已經遠遠足夠 —— 攻擊者沒有離線暴力破解的機會，每次嘗試都要
// 經過裝置，而裝置每個 nonce 只接受一次。

// ───────────────────────── 硬體腳位 ─────────────────────────
// 腳位的挑選理由與實測對照表見 docs/SMART_BIN_WIRING.md

#ifdef PIN_PROFILE_C3
constexpr uint8_t PIN_LOCK     = 4;
constexpr uint8_t PIN_FEEDBACK = 5;
constexpr uint8_t PIN_BUTTON   = 6;
constexpr uint8_t PIN_STATUS   = 7;
constexpr const char* BOARD_NAME = "ESP32-C3";
#endif

#ifdef PIN_PROFILE_WROOM
constexpr uint8_t PIN_LOCK     = 26;
constexpr uint8_t PIN_FEEDBACK = 27;
constexpr uint8_t PIN_BUTTON   = 33;
constexpr uint8_t PIN_STATUS   = 25;
constexpr const char* BOARD_NAME = "ESP32-WROOM-32";
#endif

#if !defined(PIN_PROFILE_C3) && !defined(PIN_PROFILE_WROOM)
#error "未指定腳位設定：請用 -D PIN_PROFILE_C3 或 -D PIN_PROFILE_WROOM 編譯"
#endif

// ───────────────────────── 可調參數 ─────────────────────────

// 回饋接點的防彈跳時間。狀態改變後這段期間內忽略後續變化。
// 實測（2026-09-14）接線良好時幾乎量不到彈跳，但機械接點本來就會彈，
// 留這道濾波是保險；真正的接觸不良要修接線，不是把這個數字調大。
constexpr uint32_t FEEDBACK_DEBOUNCE_MS = 30;

// 鎖舌確認縮回之後，還要繼續通電多久才斷電。
//
// 不能一確認就斷電：鎖舌縮回的那一瞬間蓋子還沒移動，立刻斷電鎖舌會
// 在蓋子讓開之前就彈回鎖孔，等於沒開。這段時間是留給蓋子彈起來、
// 讓鎖舌脫離鎖孔用的。
//
// ⚠️ 實際值要等蓋子機構做好才能定。彈簧弱、鉸鏈緊都會需要更久。
constexpr uint32_t PULSE_HOLD_AFTER_RETRACT_MS = 400;

// 偵測到第二次縮回（關蓋壓過斜面）之後，鎖舌必須在這段時間內重新伸出。
// 沒伸出代表卡在半途，對應模擬器的 lock_failed。
constexpr uint32_t LATCH_RELOCK_TIMEOUT_MS = 2000;

// 蓋子還開著時，每隔多久提醒一次。
// 裝置上沒有螢幕，提醒是透過 BLE 通知 App 顯示。
constexpr uint32_t REMIND_INTERVAL_MS = 10000;

// 電磁鎖通電的硬上限。
//
// 這個數字的用途變了，值得說明：原本假設這顆鎖是短時工作制（≤10 秒），
// 所以上限是熱保護。2026-09-18 實測推翻了這個假設 —— 商品頁標示可連續
// 通電 24 小時，實際通電 60 秒後鎖體幾乎無感（12V × 0.4A = 4.8W）。
//
// 所以現在它不是熱限制，而是**防止韌體出錯把鎖一直開著**的保險。
// 設在投放窗上限（120 秒）之上留一點餘裕即可。
//
// ⚠️ 若日後換成短時工作制的鎖，這個數字必須改回該鎖的規格，
// 否則會燒線圈。換鎖時要回頭看這一行。
constexpr uint32_t LOCK_MAX_ENERGISE_MS = 180000;
