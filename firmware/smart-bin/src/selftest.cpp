#include "selftest.h"
#include "crypto.h"
#include "secure_store.h"
#include "session.h"
#include "ble_service.h"

// RFC 4231 的 HMAC-SHA256 測試案例 1。
// 用國際標準文件的公開向量，而不是自己跑一次記下來的結果 ——
// 後者只能證明「這次和上次一樣」，證明不了「算得對」。
static const uint8_t RFC4231_KEY[20] = {
  0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,
  0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b,0x0b
};
static const char RFC4231_DATA[] = "Hi There";
// 完整結果的前 16 位元組（我們截斷到 128 bit）：
// b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
static const uint8_t RFC4231_MAC16[16] = {
  0xb0,0x34,0x4c,0x61,0xd8,0xdb,0x38,0x53,
  0x5c,0xa8,0xaf,0xce,0xaf,0x0b,0xf1,0x2b
};

static bool report(const char* name, bool passed) {
  Serial.printf("  %-28s %s\n", name, passed ? "通過" : "！失敗！");
  return passed;
}

bool runSelfTest() {
  Serial.println("=== 開機自我測試 ===");
  bool allPassed = true;

  // 一、HMAC 是否符合標準測試向量
  uint8_t mac[MAC_LEN];
  bool ok = hmacTruncated(RFC4231_KEY, sizeof(RFC4231_KEY),
                          (const uint8_t*)RFC4231_DATA, strlen(RFC4231_DATA),
                          mac);
  allPassed &= report("HMAC-SHA256 標準向量",
                      ok && memcmp(mac, RFC4231_MAC16, MAC_LEN) == 0);

  // 二、常數時間比較的正確性。
  // 只驗證「答案對不對」；它的時間特性無法在裝置上自我驗證，
  // 那要靠程式碼審查（沒有提前 return）來保證。
  uint8_t a[4] = {1, 2, 3, 4};
  uint8_t b[4] = {1, 2, 3, 4};
  uint8_t c[4] = {1, 2, 3, 5};
  allPassed &= report("常數時間比較 相同",   constantTimeEquals(a, b, 4));
  allPassed &= report("常數時間比較 相異", !constantTimeEquals(a, c, 4));

  // 三、儲存層現況。這兩項不是「通過／失敗」，是狀態回報。
  Serial.printf("  %-28s %s\n", "裝置 ID", deviceIdHex());
  Serial.printf("  %-28s %s\n", "金鑰",
                hasDeviceKey() ? "已佈建" : "尚未佈建（開發階段正常）");
  Serial.printf("  %-28s %lu\n", "計數器", (unsigned long)currentCounter());

  Serial.println(allPassed ? "=== 自我測試全部通過 ==="
                           : "=== 自我測試有項目失敗，不可繼續 ===");
  return allPassed;
}


// ───────────────────────── 指令驗證測試 ─────────────────────────

// 依裝置目前的金鑰、計數器與 nonce 組出一道合法指令。
// 這是後端在正式流程裡做的事，這裡在裝置上重做一次來驗證兩邊算法一致。
static bool buildValidCommand(CommandPayload& cmd, uint16_t windowSeconds) {
  memset(&cmd, 0, sizeof(cmd));
  cmd.protocolVersion = PROTOCOL_VERSION;
  cmd.opcode = OPCODE_UNLOCK;
  cmd.counter = currentCounter();
  cmd.windowSeconds = windowSeconds;
  cmd.reserved = 0;

  const uint8_t* nonce = generateNonce();
  memcpy(cmd.nonce, nonce, NONCE_LEN);

  uint8_t signedInput[COMMAND_SIGNED_LEN + 6];
  memcpy(signedInput, &cmd, COMMAND_SIGNED_LEN);
  memcpy(signedInput + COMMAND_SIGNED_LEN, deviceId(), 6);
  return hmacTruncated(deviceKey(), KEY_LEN, signedInput, sizeof(signedInput), cmd.mac);
}

// 檢查一道（通常是被竄改過的）指令是否得到預期的判定。
static bool expectVerdict(const char* name, CommandPayload cmd,
                          size_t len, CommandResult expected) {
  CommandResult actual = verifyCommand((const uint8_t*)&cmd, len);
  bool passed = (actual == expected);
  Serial.printf("  %-28s %s", name, passed ? "通過" : "！失敗！");
  if (!passed) Serial.printf("（預期 %s，實際 %s）",
                             commandResultName(expected), commandResultName(actual));
  Serial.println();
  return passed;
}

bool runCommandSelfTest() {
  Serial.println("=== 指令驗證測試 ===");

  if (!hasDeviceKey()) {
    Serial.println("  尚未佈建金鑰，跳過（開發階段正常）");
    return true;
  }

  CommandPayload valid;
  if (!buildValidCommand(valid, 30)) {
    Serial.println("  ！無法產生測試指令，HMAC 運算失敗！");
    return false;
  }

  bool allPassed = true;

  // 合法指令必須通過。這一項失敗代表裝置與後端的算法對不起來，
  // 整個流程會完全無法使用。
  allPassed &= expectVerdict("合法指令", valid, sizeof(valid), CMD_OK);

  // 以下每一項都只改一個地方，確認防線各自獨立有效。
  // 只測「整體會不會被拒絕」不夠 —— 那樣某一道檢查失效也看不出來。

  CommandPayload t = valid;
  t.mac[0] ^= 0x01;                       // 竄改簽章一個位元
  allPassed &= expectVerdict("竄改簽章", t, sizeof(t), CMD_BAD_MAC);

  t = valid; t.counter += 1;              // 計數器跳號
  allPassed &= expectVerdict("計數器不符", t, sizeof(t), CMD_COUNTER_MISMATCH);

  t = valid; t.nonce[3] ^= 0x80;          // 換掉 nonce
  allPassed &= expectVerdict("nonce 不符", t, sizeof(t), CMD_NONCE_MISMATCH);

  t = valid; t.protocolVersion = 99;      // 未來版本
  allPassed &= expectVerdict("協定版本不符", t, sizeof(t), CMD_BAD_VERSION);

  t = valid; t.opcode = 0x7F;             // 未知指令
  allPassed &= expectVerdict("未知指令", t, sizeof(t), CMD_BAD_OPCODE);

  t = valid; t.reserved = 1;              // 保留欄位被用
  allPassed &= expectVerdict("保留欄位非零", t, sizeof(t), CMD_BAD_RESERVED);

  t = valid; t.windowSeconds = 3600;      // 想把鎖開一小時
  allPassed &= expectVerdict("投放窗過長", t, sizeof(t), CMD_BAD_WINDOW);

  // 長度不符要在讀取任何欄位之前就被擋下，否則會讀到界外記憶體。
  allPassed &= expectVerdict("長度不符", valid, sizeof(valid) - 1, CMD_BAD_LENGTH);

  Serial.println(allPassed ? "=== 指令驗證測試全部通過 ==="
                           : "=== 指令驗證測試有項目失敗，不可繼續 ===");
  return allPassed;
}
