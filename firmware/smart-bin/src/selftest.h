#pragma once
// 開機自我測試。
//
// 密碼學的錯誤不會當機，只會安靜地算出錯的值 —— 然後所有簽章驗證
// 通通失敗，或更糟，通通通過。所以要用公開的標準測試向量在開機時
// 驗證一次，確認這台裝置上的實作真的算得對。

#include <Arduino.h>

// 密碼學與儲存層測試。可在 BLE 啟動前執行。
bool runSelfTest();

// 指令驗證測試。必須在 BLE 啟動後執行 —— 需要產生 nonce，
// 而 nonce 的亂數來源要等 RF 啟動才可靠。
bool runCommandSelfTest();
