# Smart Pet Life — 節選公開版

> 這是個人專案 Smart Pet Life 的**節選公開版**，供履歷與技術評估之用。
> 完整專案為非公開，模型權重、訓練配方與部分產品機制不在此 repo 內。
> 省略範圍完整列於 [docs/WHAT_IS_OMITTED.md](./docs/WHAT_IS_OMITTED.md)。

Smart Pet Life 是一個寵物健康生活紀錄平台，往外延伸到智慧撿便垃圾桶、便便影像辨識與犬隻協尋。
一個人從資料庫 schema、手機 App、Edge Function、ESP32 韌體到模型評測全部自己做。

技術組合：Expo / React Native / TypeScript · Supabase（PostgreSQL + RLS + RPC + Storage + Edge Functions）· ESP32 / PlatformIO · PyTorch / ONNX / Cloud Run

---

## 這個 repo 想讓你看什麼

與其看一個能跑的 demo，不如看四個「做對了才不會出事」的決定。以下每一項都可以在這個 repo 裡讀到實際程式碼。

### 1. 權限寫在資料庫，不是寫在 App

`supabase/migrations/` 的 39 個 migration 是整份展示的重點。

App 只持有 publishable key 與使用者 JWT，**不能直接寫入任何敏感資料表**，只能呼叫會重新驗證登入者與擁有者身分的 RPC。共同照護的 viewer / editor 權限、寵物資料的擁有者邊界、醫療記錄的來源可信度分級，全部由 Row Level Security 強制，前端繞不過去。

值得看的幾支：

| 檔案 | 解決什麼 |
| --- | --- |
| `20260812021018_multi_pet_collaboration.sql` | 一隻寵物跨家庭共養的權限模型 |
| `20260812091649_harden_invitation_acceptance_rls.sql` | 邀請接受流程的越權路徑收斂 |
| `20260813073836_create_atomic_medication_plan.sql` | 用藥療程與提醒在單一交易內建立，避免半套狀態 |
| `20260814081609_create_walk_sessions_with_single_pet_lease.sql` | 用租約模型確保兩個共養者不能同時遛同一隻狗 |
| `20260815064959_pet_medical_platform_rls_core.sql` | 醫療資料的機構、人員、授權與稽核邊界 |

### 2. 離線記錄的正確性，比離線本身難

`mobile/src/services/offlineCareQueue.native.ts` 與 `20260820095550_add_offline_care_record_sync.sql`。

飼主在沒有訊號的地方餵食、遛狗都要能記錄。難的不是暫存，是**避免重複寫入與時間錯亂**：

- 本機 outbox 只有在伺服器精確確認寫入後才刪除，斷線重送不會產生兩筆記錄。
- 線上記錄由伺服器寫入發生時間；離線記錄另外保存裝置事件時間、時區與伺服器接收時間三個欄位，事後才分得清「什麼時候發生」與「什麼時候同步」。
- 發生時間一旦建立就不可修改，由資料庫層強制。

### 3. 韌體不信任 App

`firmware/smart-bin/src/`。

智慧垃圾桶透過 BLE 收開鎖指令。設計前提是**手機 App 可能被反編譯、BLE 封包可能被側錄**，所以：

- App 不持有裝置私鑰，也不能自行把任務標記為完成。
- 開鎖指令必須帶後端簽章，由韌體端 (`crypto.cpp`) 驗證後才動作。
- 鎖採脈衝開啟而非持續通電，避免長時間佔用電流。
- `selftest.cpp` 在開機時自我檢查，狀態異常時不進入可開鎖狀態。

### 4. 模型分數不是機率，不能直接給使用者看

`ai/pet-reid/src/pet_reid_tool/metrics.py`。

犬隻 Re-ID 回傳的是 cosine similarity。這個數字**沒有校準**，把它當成「有九成把握是同一隻狗」顯示給正在焦急找狗的失主，會造成實際的人身安全風險。所以整條推論路徑的回應都標記 `score_kind: cosine_similarity`、`identity_confirmed: false`，確認身分永遠是人的職責。

評測面同樣不只看命中率：`metrics.py` 同時計算 Rank-1／Rank-5、mAP，以及**開集（open-set）誤接受率**與 EER 門檻。只看命中率會讓「把所有柴犬都排前面」的模型看起來很好，但對失主是災難——每一條線索都要實際跑一趟。

---

## 目錄結構

```text
mobile/          Expo / React Native App
  src/services/    資料存取層（含離線 outbox）
  src/features/    各功能畫面
supabase/
  migrations/      39 個 migration：schema、RLS、受控 RPC
  functions/       Edge Function（便便影像分析）
firmware/
  smart-bin/       ESP32 韌體：BLE 簽章驗證、安全儲存、開機自檢
ai/pet-reid/       Re-ID 評測指標、公開資料集處理、推論服務介面
docs/              架構、資料庫、產品規格與硬體設計文件
scripts/           本 repo 的同步與檢查腳本
```

---

## 執行

### 手機 App

```bash
cd mobile && npm install && npm run typecheck
```

App 需要自己的 Supabase 專案才能實際登入。`supabase/migrations/` 可直接 `supabase db push` 建出完整 schema，再把專案 URL 與 publishable key 填進 `.env`（格式見 `.env.example`）。

### Re-ID 模組

```bash
cd ai/pet-reid && python -m pip install -e . && python -m pytest
```

實際跑推論服務需要額外安裝 PyTorch：`python -m pip install -e ".[torch]"`。

**注意**：公開版的 `inference.py` 使用 ImageNet 預訓練權重取特徵，不是正式版的自訓模型。介面完全相同，但檢索準確度會明顯較差——ImageNet 特徵能分辨「狗和貓」，不太能分辨「這隻柴犬和那隻柴犬」。那正是自訓模型要解的問題。

---

## 授權

**All Rights Reserved.** 本 repo 僅供履歷與技術評估閱讀，未經書面同意不得複製、修改或用於任何產品。詳見 [LICENSE](./LICENSE)。
