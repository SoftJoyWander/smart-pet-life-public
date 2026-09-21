# 離線生活記錄同步

## 支援範圍

第一版只支援以下一般生活記錄離線新增：

- 飲食（`meal`）
- 喝水（`water`）
- 便便（`stool`）
- 尿尿（`urine`）

疫苗、驅蟲、用藥完成、照片、寵物／權限變更及遛狗開始不進入離線佇列。這些操作仍需連線，避免排程、醫療來源、媒體與多人協作資料發生衝突。

## 使用者流程

1. App 第一次啟用時會說明離線資料用途，讓使用者選擇自動或手動同步。
2. 生活記錄先寫入裝置內的 SQLite outbox，並立即顯示「等待同步」。
3. 同步方式可在生活紀錄頁改為「自動」、「僅 Wi-Fi」或「手動」。
4. App 開啟、回到前景或網路恢復時，依設定嘗試同步。
5. Supabase 回傳相同 `client_request_key` 與 `recorded_by` 後，才刪除該筆本機 outbox 資料。
6. 發生網路、登入、權限或資料驗證錯誤時，本機資料不刪除，畫面會顯示失敗並允許重試。

## 時間與來源

- `occurred_at`：裝置建立記錄的事件時間。
- `recorded_timezone`：裝置建立記錄時的 IANA 時區。
- `received_at`：Supabase 實際收到資料的伺服器時間。
- `recorded_by`：由資料庫根據目前登入帳號寫入，客戶端不能自行指定。
- `capture_mode`：離線同步記錄為 `offline`；一般即時新增為 `online`。

離線時間屬於飼主或照護者回報，不等同醫療機構或裝置量測時間。發生時間一旦上傳便不可修改。

## 重複提交與權限

- SQLite 每筆 outbox 都有唯一 `client_request_key`。
- Supabase 以 `(recorded_by, client_request_key)` 唯一索引防止重複建立。
- RPC 每次同步都重新確認登入狀態及 `private.can_edit_pet`；viewer 不可同步。
- 重複呼叫同一請求鍵會回傳同一筆記錄；若同一請求鍵搭配不同寵物、種類或時間，伺服器會拒絕。
- 本機資料以 Supabase Auth user ID 與 profile ID 雙重分區，切換帳號不會讀取或同步其他帳號的 outbox。

## 本機資料與建置注意事項

Android／iOS 使用 Expo SQLite 與 App sandbox 保存 outbox、同步偏好及離線冷啟動所需的寵物基本資料；Web 預覽使用 AsyncStorage 相容層。Supabase session 使用 AsyncStorage 保存，讓 App 重啟後可以在原帳號下續傳。

APK 卸載或清除 App 資料會一併刪除尚未同步的記錄。正式處理更高敏感度醫療資料前，應改用 SQLCipher；Expo 的 SQLCipher 需要 Development Build，Expo Go 不支援。

## 驗證清單

- 關閉網路後新增四種支援記錄，重新開啟 App 仍可看到待同步狀態。
- 使用自動、僅 Wi-Fi、手動三種模式驗證觸發條件。
- 同一請求重試兩次只產生一筆 Supabase 記錄。
- viewer、已被移除的 editor、登出或過期 session 均不能同步。
- 同步錯誤時 outbox 不刪除；收到精確 acknowledgement 後才刪除。
- 疫苗、驅蟲、用藥與遛狗不會進入離線 outbox。
