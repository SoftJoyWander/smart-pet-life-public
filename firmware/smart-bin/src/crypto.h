#pragma once
// HMAC-SHA256 與常數時間比較。
// 這一層刻意只做密碼學原語，不碰協定欄位 —— 把「怎麼算」和「算什麼」
// 分開，日後改位元格式時不必動到這裡，也比較好單獨測試。

#include <Arduino.h>
#include "config.h"

// 對 data 計算 HMAC-SHA256(key, data)，結果截斷為前 MAC_LEN 位元組寫入 out。
// 回傳 false 表示底層運算失敗（記憶體不足等），此時 out 內容未定義，
// 呼叫端必須當作驗證失敗處理，不可忽略回傳值。
bool hmacTruncated(const uint8_t* key, size_t keyLen,
                   const uint8_t* data, size_t dataLen,
                   uint8_t* out);

// 常數時間比較兩段等長資料。
//
// 為什麼不用 memcmp：memcmp 找到第一個不同的位元組就回傳，
// 所以「前幾個位元組猜對了」會讓它跑得久一點點。攻擊者反覆送出
// 偽造的 MAC 並測量回應時間，就能一個位元組一個位元組地試出正確值。
// 這叫時序攻擊。下面的寫法不論哪裡不同都跑完全長，時間固定。
bool constantTimeEquals(const uint8_t* a, const uint8_t* b, size_t len);

// 產生密碼學等級的亂數。
//
// ⚠️ 只能在 BLE 啟動之後呼叫。ESP32 的硬體亂數產生器要靠 RF 電路的
// 熱雜訊當熵源，Wi-Fi 或藍牙沒開時 esp_random() 退化成品質較低的來源。
// nonce 可被預測等於防重放失效，所以這裡用 assert 擋住誤用。
void fillRandom(uint8_t* out, size_t len);

// 標記 RF 已啟動，讓 fillRandom 開始接受呼叫。由 BLE 初始化完成後呼叫。
void markRandomSourceReady();
