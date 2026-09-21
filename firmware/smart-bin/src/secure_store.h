#pragma once
// 裝置金鑰與防重放計數器的持久化儲存。
//
// 兩者都必須在斷電後保留：金鑰遺失裝置就再也無法驗證指令，
// 計數器倒退則等於讓舊指令重新生效，防重放直接失效。

#include <Arduino.h>
#include "config.h"

// 從 NVS 載入金鑰與計數器。必須在使用其他函式前呼叫一次。
// 回傳 false 代表這台裝置還沒被佈建金鑰。
bool secureStoreBegin();

// 這台裝置是否已佈建金鑰。
bool hasDeviceKey();

// 取得金鑰指標。未佈建時回傳 nullptr。
// 金鑰只在裝置內部使用，絕不經由 BLE 或序列埠輸出。
const uint8_t* deviceKey();

// 目前的計數器值。指令必須帶上這個值才會被接受。
uint32_t currentCounter();

// 計數器前進一步並立即寫回 NVS。
//
// 「立即寫回」是刻意的：若先接受指令再延後寫入，斷電時機不巧就會讓
// 計數器倒退，同一道指令可以再被重放一次。寫入耗時遠小於開鎖動作，
// 值得用這點延遲換取不變量。
bool advanceCounter();

// 佈建金鑰。目前僅供開發使用。
//
// ⚠️ 正式的佈建流程尚未決定（見 docs/SMART_BIN_DESIGN.md「尚未決定」）。
// 這個接縫存在的目的是讓協定實作不必等那個決定，但出貨前必須換成
// 真正的一次性佈建工具，並確保金鑰不進入 Git、不從序列埠輸入。
bool provisionDeviceKey(const uint8_t* key, size_t len);

// 取得裝置 ID（6 位元組，取自晶片出廠 MAC）。
// 這不是秘密 —— 它會印在 QR 貼紙上，用來讓後端查出對應的金鑰。
const uint8_t* deviceId();

// 裝置 ID 的十六進位字串，供 device_info 與除錯輸出使用。
const char* deviceIdHex();
