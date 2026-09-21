#include "session.h"
#include "crypto.h"
#include "secure_store.h"

// 鎖舌從通電到縮回的容許時間。超過就判定為 lock_failed ——
// 這正是回饋接點存在的理由：沒有它，裝置分不出「鎖打開了」和
// 「送出訊號但鎖卡住」，而回執只有在能區分時才值得後端相信。
constexpr uint32_t LATCH_CONFIRM_TIMEOUT_MS = 1500;

// ───────────────────────── 為什麼是脈衝而不是持續通電 ─────────────────────────
//
// 早期版本在鎖舌確認縮回後持續通電到投放窗結束。那是錯的，而且錯得不明顯：
// 斜舌要彈出來卡進鎖孔才叫上鎖，但線圈通電期間鎖舌是被拉住縮回的 ——
// 也就是說，持續通電會**主動阻止蓋子上鎖**。使用者 10 秒投完，卻得按著
// 蓋子等到 30 秒斷電才能真正關上。
//
// 改成脈衝之後，鎖舌縮回讓蓋子彈開就斷電，之後任何時候關上蓋子，斜舌
// 都能自動卡上。投放窗的意義也跟著變成「多久沒關上就視為未完成」，
// 不再是通電時間。
//
// ───────────────────────── 怎麼知道蓋子關上了 ─────────────────────────
//
// 不加蓋子感測器，改看鎖舌的**第二次縮回**。
//
// 鎖舌只有在不處於鎖孔裡的狀態下，才會被關門時的斜面壓回去。蓋子從未
// 開過的話，鎖舌一直在孔裡，沒有任何東西能壓它。所以第二次縮回同時
// 證明了兩件事：蓋子曾經開過，而且現在正在關上。
//
// 代價是分不出「蓋子卡住沒開」和「開著但人走了」—— 兩者都是沒有第二次
// 縮回，只能一起逾時處理。兩種都是失敗，後端處理方式相同，可以接受。

enum SessionPhase : uint8_t {
  PHASE_IDLE = 0,
  PHASE_PULSING,       // 通電中，等鎖舌縮回
  PHASE_CLEARING,      // 已縮回，續電一小段讓蓋子彈開
  PHASE_AWAIT_CLOSE,   // 已斷電，等關蓋造成的第二次縮回
  PHASE_RELOCKING,     // 已偵測到第二次縮回，等鎖舌重新伸出
};

static SessionPhase phase = PHASE_IDLE;
static BinState state = STATE_IDLE;
static uint8_t  lastError = CMD_OK;
static uint32_t energisedAt = 0;   // 通電的時刻
static uint32_t windowMs = 0;      // 本次授權的放棄時限
static uint32_t confirmedAt = 0;   // 鎖舌確認縮回的時刻
static uint32_t phaseAt = 0;       // 進入目前階段的時刻
static uint32_t lastRemindAt = 0;

static void finish(const char* reason, uint8_t error) {
  digitalWrite(PIN_LOCK, LOW);
  phase = PHASE_IDLE;
  state = STATE_IDLE;
  lastError = error;
  Serial.printf("[SESSION] 結束：%s\n", reason);
  bleUpdateStatus(state, lastError);
}

// ───────────────────────── 回饋接點的防彈跳與邊緣偵測 ─────────────────────────
//
// 狀態機需要的是「邊緣」（剛剛變成縮回／剛剛變成伸出），不是「現在的位準」。
// 順便記錄每個狀態持續了多久 —— 關蓋壓過斜面那一下有多長是未知數，
// 而它必須大於防彈跳時間才抓得到。實測資料比猜測可靠。

enum LatchEdge : uint8_t { EDGE_NONE = 0, EDGE_TO_RETRACTED, EDGE_TO_EXTENDED };

static bool     latchRetracted = false;
static bool     latchInit = false;
static uint32_t latchChangedAt = 0;

static LatchEdge pollLatch() {
  uint32_t now = millis();
  bool raw = (digitalRead(PIN_FEEDBACK) == LOW);

  if (!latchInit) {
    latchInit = true;
    latchRetracted = raw;
    latchChangedAt = now;
    return EDGE_NONE;
  }

  if (raw == latchRetracted) return EDGE_NONE;
  if ((now - latchChangedAt) < FEEDBACK_DEBOUNCE_MS) return EDGE_NONE;

  uint32_t heldFor = now - latchChangedAt;
  latchRetracted = raw;
  latchChangedAt = now;

  // 這一行是量測用的：印出「上一個狀態持續了多久」。
  // 關蓋那一下的毫秒數要靠它才知道，不能憑感覺設防彈跳。
  Serial.printf("[鎖舌] %s（前一狀態持續 %lu ms）\n",
                raw ? "縮回" : "伸出", (unsigned long)heldFor);

  return raw ? EDGE_TO_RETRACTED : EDGE_TO_EXTENDED;
}

bool latchIsRetracted() { return latchRetracted; }

CommandResult verifyCommand(const uint8_t* data, size_t len) {
  // 先擋長度，再碰任何欄位 —— 長度不符就去讀結構會讀到界外記憶體。
  if (len != sizeof(CommandPayload)) return CMD_BAD_LENGTH;

  CommandPayload cmd;
  memcpy(&cmd, data, sizeof(cmd));

  if (cmd.protocolVersion != PROTOCOL_VERSION) return CMD_BAD_VERSION;
  if (cmd.opcode != OPCODE_UNLOCK)             return CMD_BAD_OPCODE;
  if (cmd.reserved != 0)                       return CMD_BAD_RESERVED;

  // 投放窗超出合理範圍就拒絕。後端理論上不會送出這種值，但裝置不該
  // 因為上游出錯或被竄改就把鎖開著幾小時 —— 這道檢查是裝置自己的底線。
  if (cmd.windowSeconds < WINDOW_MIN_SECONDS ||
      cmd.windowSeconds > WINDOW_MAX_SECONDS) return CMD_BAD_WINDOW;

  // 已有進行中的 session 就拒絕，對應模擬器的 busy 情境。
  if (state != STATE_IDLE) return CMD_BUSY;

  if (!hasDeviceKey()) return CMD_NO_KEY;

  // 計數器不接受倒退也不接受跳號：必須正好等於裝置目前的值。
  if (cmd.counter != currentCounter()) return CMD_COUNTER_MISMATCH;

  // nonce 必須是裝置最近一次產生、且尚未被使用的那一組。
  const uint8_t* expectedNonce = currentNonce();
  if (expectedNonce == nullptr) return CMD_NONCE_MISMATCH;
  if (!constantTimeEquals(cmd.nonce, expectedNonce, NONCE_LEN)) return CMD_NONCE_MISMATCH;

  // MAC 涵蓋「指令欄位 ‖ device_id」。把 device_id 串進去，讓一台機器的
  // 授權不可能在另一台上生效。
  uint8_t signedInput[COMMAND_SIGNED_LEN + 6];
  memcpy(signedInput, &cmd, COMMAND_SIGNED_LEN);
  memcpy(signedInput + COMMAND_SIGNED_LEN, deviceId(), 6);

  uint8_t expectedMac[MAC_LEN];
  if (!hmacTruncated(deviceKey(), KEY_LEN, signedInput, sizeof(signedInput), expectedMac)) {
    // 運算失敗時絕不能當成通過。這種情況幾乎不會發生，但預設拒絕是唯一
    // 安全的失敗方向。
    return CMD_BAD_MAC;
  }
  if (!constantTimeEquals(cmd.mac, expectedMac, MAC_LEN)) return CMD_BAD_MAC;

  return CMD_OK;
}

CommandResult handleCommand(const uint8_t* data, size_t len) {
  CommandResult verdict = verifyCommand(data, len);
  if (verdict != CMD_OK) return verdict;

  // ─── 驗證通過，以下開始有副作用 ───
  CommandPayload cmd;
  memcpy(&cmd, data, sizeof(cmd));

  // 計數器必須在動作之前就寫進 NVS。
  // 若先開鎖再寫入，斷電時機不巧就會讓計數器停在舊值，同一道指令可以
  // 再被重放一次。寧可「寫入成功但沒開鎖」也不要「開了鎖但沒記錄」。
  if (!advanceCounter()) return CMD_COUNTER_EXHAUSTED;

  // nonce 用掉就作廢。下一次必須重新讀 challenge。
  consumeNonce();

  windowMs = (uint32_t)cmd.windowSeconds * 1000UL;
  energisedAt = millis();
  phaseAt = energisedAt;
  confirmedAt = 0;
  lastRemindAt = 0;
  phase = PHASE_PULSING;
  state = STATE_UNLOCKED;
  lastError = CMD_OK;
  digitalWrite(PIN_LOCK, HIGH);

  Serial.printf("[SESSION] 指令通過，脈衝開鎖，放棄時限 %u 秒\n", cmd.windowSeconds);
  bleUpdateStatus(state, lastError);
  return CMD_OK;
}

void sessionTick() {
  // 邊緣偵測每圈都要跑，即使在待機 —— 否則使用者手動壓鎖舌的紀錄會漏掉，
  // 而那正是量測關蓋時長的來源。
  LatchEdge edge = pollLatch();

  if (phase == PHASE_IDLE) return;

  uint32_t now = millis();

  // 通電硬上限優先於任何產品邏輯。改成脈衝之後正常流程根本碰不到它，
  // 但它的意義正是「韌體若出錯，鎖也不會被一直開著」。
  if (digitalRead(PIN_LOCK) == HIGH && (now - energisedAt) >= LOCK_MAX_ENERGISE_MS) {
    finish("達到通電硬上限", 1);
    return;
  }

  switch (phase) {
    case PHASE_PULSING:
      // 等鎖舌縮回。這是 unlock_confirmed —— 裝置確認鎖真的動了，
      // 而不是只確認自己送出了訊號。
      if (edge == EDGE_TO_RETRACTED) {
        confirmedAt = now;
        phase = PHASE_CLEARING;
        phaseAt = now;
        Serial.printf("[事件] unlock_confirmed（鎖舌縮回耗時 %lu ms）\n",
                      (unsigned long)(now - energisedAt));
      } else if ((now - energisedAt) >= LATCH_CONFIRM_TIMEOUT_MS) {
        // 送了電但鎖舌沒動。沒有回饋接點的話，這種情況會被誤判成成功。
        finish("鎖舌未在時限內縮回（lock_failed）", 1);
      }
      return;

    case PHASE_CLEARING:
      // 續電一小段，讓蓋子有時間彈開、鎖舌脫離鎖孔，然後才斷電。
      if ((now - phaseAt) >= PULSE_HOLD_AFTER_RETRACT_MS) {
        digitalWrite(PIN_LOCK, LOW);
        phase = PHASE_AWAIT_CLOSE;
        phaseAt = now;
        lastRemindAt = now;
        state = STATE_AWAIT_CLOSE;
        Serial.println("[SESSION] 已斷電，等使用者關上蓋子");
        bleUpdateStatus(state, lastError);
      }
      return;

    case PHASE_AWAIT_CLOSE: {
      // 斷電後鎖舌會先彈回伸出（不論蓋子開或關）。我們要等的是**之後**
      // 再一次的縮回 —— 那只可能由關蓋時的斜面造成。
      //
      // 這裡不需要額外的「已武裝」旗標：pollLatch 只在狀態真的改變時
      // 回報邊緣，斷電後的彈出會產生 EDGE_TO_EXTENDED，被下面忽略；
      // 唯一會通過的 EDGE_TO_RETRACTED 必然是新的一次縮回。
      if (edge == EDGE_TO_RETRACTED) {
        phase = PHASE_RELOCKING;
        phaseAt = now;
        Serial.println("[事件] hatch_closed（鎖舌被斜面壓回，蓋子正在關上）");
        return;
      }

      // 蓋子還開著，定期提醒。裝置上沒有螢幕，提醒由 App 顯示；
      // 階段四接上 event 通知之後這裡會改成發送 BLE 事件。
      if ((now - lastRemindAt) >= REMIND_INTERVAL_MS) {
        lastRemindAt = now;
        Serial.printf("[提醒] 蓋子尚未關上（已等 %lu 秒）\n",
                      (unsigned long)((now - phaseAt) / 1000));
      }

      // 放棄時限。到了仍未關上就結束 session 且不發積分 ——
      // 分不出是卡住還是人走了，但兩者都不是成功投放。
      if ((now - phaseAt) >= windowMs) {
        finish("逾時仍未關上蓋子（未完成投放）", 2);
      }
      return;
    }

    case PHASE_RELOCKING:
      // 斜面壓過去之後鎖舌應該立刻彈進鎖孔。這是 latch_locked，
      // 也是整條事件鏈的最後一環。
      if (edge == EDGE_TO_EXTENDED) {
        Serial.printf("[事件] latch_locked（壓回到上鎖 %lu ms）\n",
                      (unsigned long)(now - phaseAt));
        Serial.println("[SESSION] 事件鏈完整：unlock_confirmed → hatch_closed → latch_locked");
        finish("投放完成", 0);
      } else if ((now - phaseAt) >= LATCH_RELOCK_TIMEOUT_MS) {
        // 壓回去了卻沒彈出來 —— 鎖舌卡在半途，蓋子等於沒鎖上。
        finish("鎖舌未重新伸出（lock_failed）", 1);
      }
      return;

    default:
      return;
  }
}

BinState sessionState() { return state; }
uint8_t  sessionError() { return lastError; }

const char* commandResultName(CommandResult result) {
  switch (result) {
    case CMD_OK:                 return "通過";
    case CMD_BAD_LENGTH:         return "長度不符";
    case CMD_BAD_VERSION:        return "協定版本不符";
    case CMD_BAD_OPCODE:         return "未知指令";
    case CMD_COUNTER_MISMATCH:   return "計數器不符";
    case CMD_NONCE_MISMATCH:     return "nonce 不符或已用過";
    case CMD_NO_KEY:             return "尚未佈建金鑰";
    case CMD_BUSY:               return "已有進行中的 session";
    case CMD_BAD_MAC:            return "簽章驗證失敗";
    case CMD_BAD_RESERVED:       return "保留欄位非零";
    case CMD_BAD_WINDOW:         return "投放窗超出範圍";
    case CMD_COUNTER_EXHAUSTED:  return "計數器已用盡";
  }
  return "未知";
}
