#pragma once
// 指令驗證與開鎖狀態機。
//
// 這裡是整個安全模型的執行點：App 不能自行把任務改成完成，靠的就是
// 下面這段驗證 —— App 拿不到金鑰，因此無法產生會被接受的 MAC。
//
// 驗證邏輯刻意寫成不碰 BLE 的純函式，這樣開機自我測試可以直接餵它
// 各種偽造指令，不必真的透過藍牙來一輪。

#include <Arduino.h>
#include "config.h"
#include "ble_service.h"

// command（write）：42 位元組
//
// MAC 涵蓋 version 到 reserved 的 26 位元組，再串上 6 位元組的 device_id。
// 把 device_id 算進去，是為了讓一台機器的授權不可能在另一台上生效 ——
// 即使兩台的計數器與 nonce 碰巧相同。
struct __attribute__((packed)) CommandPayload {
  uint8_t  protocolVersion;
  uint8_t  opcode;
  uint32_t counter;
  uint8_t  nonce[NONCE_LEN];
  uint16_t windowSeconds;
  uint16_t reserved;            // 必須為 0，保留給日後擴充
  uint8_t  mac[MAC_LEN];
};

constexpr uint8_t OPCODE_UNLOCK = 1;

// MAC 涵蓋的長度：結構扣掉最後的 mac 欄位。
// 用 offsetof 而不是寫死數字，改欄位時不會忘記同步。
constexpr size_t COMMAND_SIGNED_LEN = offsetof(CommandPayload, mac);

// 拒絕原因。同時作為 status 特徵值的 errorCode 回報給 App。
enum CommandResult : uint8_t {
  CMD_OK              = 0,
  CMD_BAD_LENGTH      = 1,
  CMD_BAD_VERSION     = 2,
  CMD_BAD_OPCODE      = 3,
  CMD_COUNTER_MISMATCH= 4,
  CMD_NONCE_MISMATCH  = 5,
  CMD_NO_KEY          = 6,
  CMD_BUSY            = 7,
  CMD_BAD_MAC         = 8,
  CMD_BAD_RESERVED    = 9,
  CMD_BAD_WINDOW      = 10,
  CMD_COUNTER_EXHAUSTED = 11,
};

// 投放窗的合理範圍。超出範圍一律拒絕 —— 後端理論上不會送出這種值，
// 但裝置不該因為上游出錯就把鎖開著幾小時。
constexpr uint16_t WINDOW_MIN_SECONDS = 5;
constexpr uint16_t WINDOW_MAX_SECONDS = 120;

// 只驗證，不產生任何副作用。回傳 CMD_OK 代表這道指令是合法的。
//
// 和 handleCommand 分開，是為了讓開機自我測試能餵各種偽造指令進來
// 檢查是否被正確拒絕 —— 如果驗證和執行綁在一起，測一次「合法指令」
// 就會真的開一次鎖並讓計數器前進，測試本身就變成了副作用。
CommandResult verifyCommand(const uint8_t* data, size_t len);

// 驗證並執行。回傳 CMD_OK 代表已接受並開始解鎖。
CommandResult handleCommand(const uint8_t* data, size_t len);

// 狀態機推進，在 loop() 裡每圈呼叫。
void sessionTick();

// 鎖舌目前是否縮回（已防彈跳）。供序列埠與 status 特徵值使用，
// 避免各處各自讀腳位又各自防彈跳。
bool latchIsRetracted();

// 目前狀態，供序列埠與 status 特徵值使用。
BinState sessionState();
uint8_t  sessionError();

// 人類可讀的拒絕原因，只用於序列埠除錯。
const char* commandResultName(CommandResult result);
