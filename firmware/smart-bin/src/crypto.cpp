#include "crypto.h"
#include "mbedtls/md.h"
#include "esp_random.h"

// mbedtls 是 ESP-IDF 內建的密碼學函式庫，不需要額外安裝，
// 而且 SHA256 在 ESP32 上有硬體加速。自己實作密碼學是常見的嚴重錯誤來源。

bool hmacTruncated(const uint8_t* key, size_t keyLen,
                   const uint8_t* data, size_t dataLen,
                   uint8_t* out) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;

  uint8_t full[32];  // SHA256 的完整輸出長度
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);

  // 第三個參數 1 代表「要做 HMAC」而不是單純雜湊。
  bool ok = mbedtls_md_setup(&ctx, info, 1) == 0
         && mbedtls_md_hmac_starts(&ctx, key, keyLen) == 0
         && mbedtls_md_hmac_update(&ctx, data, dataLen) == 0
         && mbedtls_md_hmac_finish(&ctx, full) == 0;

  mbedtls_md_free(&ctx);
  if (!ok) return false;

  memcpy(out, full, MAC_LEN);   // 只取前 128 bit，理由見 config.h
  memset(full, 0, sizeof(full)); // 用完把完整值從堆疊清掉，減少殘留
  return true;
}

bool constantTimeEquals(const uint8_t* a, const uint8_t* b, size_t len) {
  // 把每個位元組的差異用 OR 累積起來，全部相同時 diff 才會是 0。
  // 沒有提前 return，所以執行時間與「哪裡不同」無關。
  uint8_t diff = 0;
  for (size_t i = 0; i < len; i++) {
    diff |= (uint8_t)(a[i] ^ b[i]);
  }
  return diff == 0;
}

// 這個旗標只是防呆，不是安全機制本身 —— 真正的要求是 RF 必須已啟動。
static bool randomSourceReady = false;

void markRandomSourceReady() {
  randomSourceReady = true;
}

void fillRandom(uint8_t* out, size_t len) {
  // 在 BLE 啟動前產生 nonce 是嚴重錯誤，寧可當機也不要產生可預測的亂數。
  assert(randomSourceReady && "fillRandom 必須在 BLE 啟動後才呼叫");
  esp_fill_random(out, len);
}
