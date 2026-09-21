# Smart Pet Life JSON 資料定義書

| 項目 | 內容 |
| --- | --- |
| 文件版本 | 1.4 |
| 更新日期 | 2026-08-27 |
| 適用範圍 | Mobile App 與 Supabase 間的現行資料交換 |
| 命名規則 | JSON 欄位採 `snake_case` |
| 事實來源 | 已部署 migration、`mobile/src/types/database.ts`、`mobile/src/services/petData.ts` |

## 1. 傳輸方式

App 使用 Supabase JavaScript client，透過 HTTPS 與 Auth、PostgREST、PostgreSQL RPC、Realtime WebSocket 及 Storage API 傳輸資料。資料表與 RPC 的結構化內容以 JSON 表示；圖片及附件以檔案上傳，不以 base64 放入業務 JSON。

登入後請求由 Supabase client 帶入 JWT。App 只可使用 publishable key；`service_role`、資料庫密碼與簽名秘密不得出現在 App、JSON、日誌或 Git。

## 2. 通用型別

| 型別 | JSON 表示 | 規則／範例 |
| --- | --- | --- |
| 業務實體 ID | `string` | 3 字元類型前綴、連字號及 8 位大寫十六進制，例如 `"PET-02BD14E8"` |
| Auth UUID | `string` | 只用於 `profiles.auth_user_id` 等身分驗證對照，不作業務主鍵 |
| 日期 | `string` | ISO 8601 `YYYY-MM-DD`，如 `"2026-08-13"` |
| 時間 | `string` | `HH:mm:ss`，如 `"08:00:00"` |
| 時間戳 | `string` | ISO 8601 且含時區，如 `"2026-08-13T08:00:00+08:00"` |
| 數值 | `number` | 不把單位接在數值字串內 |
| 布林 | `boolean` | `true`／`false` |
| 無值 | `null` | 不以空字串代表未知 |
| JSONB | JSON 值 | 字串、數字、布林、`null`、物件或陣列 |

時間展示使用 IANA timezone，例如 `Asia/Taipei`；伺服器時間戳保存可解析的時區資訊。

## 3. 列舉

| 名稱 | 允許值 |
| --- | --- |
| `care_record_kind` | `meal`, `water`, `medication`, `stool`, `urine`, `vaccine`, `medical` |
| `record_source` | `manual`, `medication_reminder`, `ai_verification`, `walk_tracking` |
| `medication_reminder_status` | `pending`, `overdue`, `completed`, `skipped`, `cancelled` |
| `medication_dose_unit` | `mcg`, `mg`, `g`, `ml`, `tablet`, `capsule`, `packet`, `drop`, `spray`, `iu`, `other` |
| `pet_member_role` | `viewer`, `editor` |
| `pet_invitation_status` | `pending`, `accepted`, `revoked`, `expired` |
| `preventive_care_kind` | `deworming`, `vaccine` |
| `food_type` | `dry`, `wet`, `canned` |
| `stool_texture` | `hard`, `normal`, `soft`, `watery` |
| `stool_color` | `chocolate_brown`, `black_tarry`, `fresh_red`, `yellow_orange`, `gray_white`, `green` |
| `stool_status` | `normal`, `soft_stool`, `diarrhea`, `constipation` |
| `urine_color` | `unknown`, `clear`, `light_yellow`, `dark_yellow`, `brown`, `red` |

## 4. 資料物件

以下是目前資料庫回傳的 Row 形狀。新增與更新只送出操作需要且獲授權的欄位；由資料庫產生或保護的欄位不可任意覆寫。

### 4.1 `profiles`

```json
{
  "id": "USR-7A3F91C2",
  "auth_user_id": "11111111-1111-4111-8111-111111111111",
  "display_name": "小安",
  "created_at": "2026-08-13T08:00:00+08:00",
  "updated_at": "2026-08-13T08:00:00+08:00"
}
```

- `id` 是 App 內部使用者 ID；`auth_user_id` 才對應 Supabase Auth UUID。
- App、外鍵、RPC 與管理查詢使用 `USR-XXXXXXXX`，登入驗證仍由 Auth UUID 完成。
- `display_name` 可為 `null`，首頁稱呼優先使用此值。

### 4.2 `pets`

```json
{
  "id": "PET-02BD14E8",
  "owner_id": "USR-7A3F91C2",
  "name": "豆豆",
  "species": "dog",
  "breed": "柴犬",
  "sex": "male",
  "sterilization_status": "sterilized",
  "birthday": "2022-05-10",
  "weight_kg": 10.5,
  "meals_per_day": 2,
  "water_goal_ml": 600,
  "avatar_icon": "shiba",
  "avatar_path": "USR-7A3F91C2/PET-02BD14E8/avatar.jpg",
  "archived_at": null,
  "created_at": "2026-08-13T08:05:00+08:00",
  "updated_at": "2026-08-13T08:05:00+08:00"
}
```

- 目前 `species` 只接受 `dog`；尚不可傳 `cat`。
- `sex`：`male`、`female`、`unknown`。
- `sterilization_status`：`sterilized`、`not_sterilized`、`unknown`。
- `birthday` 使用 `YYYY-MM-DD` 日曆日期；建立後一般 App 操作不可修改。`age` 不存入 JSON，由生日即時計算。
- `avatar_path` 是私人 Storage 路徑，顯示時另取短效簽名網址。

### 4.3 `care_records`

```json
{
  "id": "REC-A6D4309F",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "kind": "water",
  "occurred_at": "2026-08-13T09:15:00+08:00",
  "source": "manual",
  "amount": 240,
  "unit": "ml",
  "food_type": null,
  "medication_name": null,
  "medication_dose": null,
  "stool_texture": null,
  "stool_color": null,
  "stool_status": null,
  "urine_color": null,
  "title": null,
  "note": null,
  "image_path": null,
  "walk_session_id": null,
  "recorded_by": "USR-7A3F91C2",
  "client_request_key": "11111111-1111-4111-8111-111111111111:offline-mec0abc-1234567890abcdef",
  "recorded_timezone": "Asia/Taipei",
  "received_at": "2026-08-13T09:18:30+08:00",
  "capture_mode": "offline",
  "medical_file_paths": [],
  "metadata": {},
  "created_at": "2026-08-13T09:15:05+08:00",
  "updated_at": "2026-08-13T09:15:05+08:00"
}
```

- `occurred_at` 建立後不可修改。
- 線上手動記錄由伺服器指定 `occurred_at`；離線 `meal`、`water`、`stool`、`urine` 可保存裝置事件時間，但必須同時保存 `recorded_timezone` 與伺服器控制的 `received_at`。
- `recorded_by` 由目前登入身分映射的 profile 寫入；`client_request_key` 與 actor 組成唯一冪等鍵。`capture_mode` 只允許 `online` 或 `offline`。
- `meal` 與 `water` 的 `amount` 必須為大於 0 的整數。
- 只讓與 `kind` 對應的欄位有值，其餘使用 `null`。
- `source = ai_verification` 只描述來源，不代表獸醫診斷或專家審核。
- `source = walk_tracking` 時必須帶入同一寵物、同一時間範圍的 `walk_session_id`；其他來源不得連結遛狗記錄。
- 目前 `kind = medical` 在 App 中實際表示驅蟲，不代表正式就醫；`medical_file_paths` 是早期相容欄位，不作新病例契約。

### 4.4 `medication_plans`

```json
{
  "id": "MPL-81C4E207",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "title": "示例藥物",
  "dose": "1 tablet",
  "dose_amount": 1,
  "dose_unit": "tablet",
  "times": ["08:00:00", "20:00:00"],
  "start_date": "2026-08-13",
  "end_date": "2026-08-19",
  "instruction": "飯後 2 小時",
  "timezone": "Asia/Taipei",
  "client_request_key": "55555555-5555-4555-8555-555555555555",
  "note": "依獸醫師指示",
  "is_active": true,
  "created_at": "2026-08-13T10:00:00+08:00",
  "updated_at": "2026-08-13T10:00:00+08:00"
}
```

- `dose_amount` 必須為大於 0 的整數；分析以 `dose_amount`、`dose_unit` 為準，`dose` 只作相容顯示。
- `times` 為每日 1 至 3 個時間，依先後排列且相鄰至少差 5 分鐘。
- `end_date` 不得早於 `start_date`。
- 相同使用者送出相同 `client_request_key` 時，不得重複建立計畫。

### 4.5 `medication_reminders`

```json
{
  "id": "RMN-3F70B26A",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "medication_plan_id": "MPL-81C4E207",
  "scheduled_at": "2026-08-13T20:00:00+08:00",
  "status": "completed",
  "completed_at": "2026-08-13T20:03:10+08:00",
  "administered_at": "2026-08-13T20:02:00+08:00",
  "overdue_at": null,
  "skipped_at": null,
  "resolved_by": "USR-7A3F91C2",
  "care_record_id": "REC-54A98C01",
  "created_at": "2026-08-13T10:00:00+08:00",
  "updated_at": "2026-08-13T20:03:10+08:00"
}
```

`scheduled_at` 是預定時間，`administered_at` 是實際服用時間，`completed_at` 是完成操作時間。漏服證據保存於 `overdue_at`、`skipped_at` 與 `resolved_by`。

### 4.6 `pet_memberships`

```json
{
  "id": "MBR-E51A903C",
  "pet_id": "PET-02BD14E8",
  "owner_id": "USR-7A3F91C2",
  "user_id": "USR-15C8E4B9",
  "member_email": "caregiver@example.test",
  "role": "editor",
  "invited_by": "USR-7A3F91C2",
  "created_at": "2026-08-13T11:00:00+08:00",
  "updated_at": "2026-08-13T11:00:00+08:00"
}
```

### 4.7 `pet_invitations`

```json
{
  "id": "INV-6D28C17F",
  "invite_code": "AB12CD34EF",
  "pet_id": "PET-02BD14E8",
  "owner_id": "USR-7A3F91C2",
  "invited_email": "caregiver@example.test",
  "role": "viewer",
  "status": "pending",
  "invited_by": "USR-7A3F91C2",
  "accepted_by": null,
  "expires_at": "2026-08-20T11:00:00+08:00",
  "accepted_at": null,
  "created_at": "2026-08-13T11:00:00+08:00",
  "updated_at": "2026-08-13T11:00:00+08:00"
}
```

同一寵物不可對既有成員或相同待接受 Email 建立重複有效邀請。QR code 只承載邀請碼或受控深連結，不包含 JWT 或健康資料。

### 4.8 `preventive_care_schedules`

```json
{
  "id": "PVC-B9420ADE",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "kind": "deworming",
  "title": "體內外驅蟲",
  "interval_months": 1,
  "last_completed_on": "2026-08-13",
  "next_due_on": "2026-09-13",
  "note": null,
  "created_at": "2026-08-13T12:00:00+08:00",
  "updated_at": "2026-08-13T12:00:00+08:00"
}
```

疫苗目前為 12 個月；驅蟲允許 1、2、3 個月。下次日期依曆月計算，不以固定天數近似。

### 4.9 `walk_sessions`

```json
{
  "id": "WLK-19F27A6C",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "recorded_by": "USR-15C8E4B9",
  "client_request_key": "walk:PET-02BD14E8:1786680000000:a1b2c3d4",
  "started_at": "2026-08-14T08:00:00+08:00",
  "ended_at": "2026-08-14T08:32:10+08:00",
  "duration_seconds": 1810,
  "distance_m": 2140.5,
  "average_speed_mps": 1.183,
  "weight_kg_snapshot": 10.5,
  "energy_kcal_low": 56.2,
  "energy_kcal_high": 73.1,
  "energy_model_version": "walk-met-v1",
  "stool_count": 1,
  "urine_count": 2,
  "created_at": "2026-08-14T08:32:12+08:00"
}
```

- `recorded_by` 是實際持有遛狗租約的 owner 或 editor。
- `average_speed_mps` 由資料庫依路程及有效運動秒數產生。
- 熱量是版本化的系統估算，不代表餵食建議或醫療判斷。
- 雲端不保存原始 GPS 點或路線幾何；它們只在活動期間保留於裝置，供完成畫面繪製及分享。

## 5. RPC 定義

成功回應為對應 Row 物件或陣列；失敗沿用 Supabase／PostgREST 錯誤格式。

### 5.1 接受邀請

`accept_pet_invitation`

```json
{ "invitation_id": "INV-6D28C17F" }
```

`accept_pet_invitation_code`

```json
{ "join_code": "AB12CD34EF" }
```

兩者均回傳單一 `pet_memberships` 物件。

### 5.2 完成預防照護

`complete_preventive_care`

```json
{ "schedule_id": "PVC-B9420ADE" }
```

回傳更新後的排程，並在同一交易建立照護紀錄。

### 5.3 原子建立用藥計畫與提醒

`create_medication_plan_with_reminders`

```json
{
  "plan_owner_id": "USR-7A3F91C2",
  "plan_pet_id": "PET-02BD14E8",
  "plan_title": "示例藥物",
  "plan_dose": "1 tablet",
  "plan_dose_amount": 1,
  "plan_dose_unit": "tablet",
  "plan_times": ["08:00:00", "20:00:00"],
  "plan_start_date": "2026-08-13",
  "plan_end_date": "2026-08-19",
  "plan_instruction": "飯後 2 小時",
  "plan_note": "依獸醫師指示",
  "plan_timezone": "Asia/Taipei",
  "plan_request_key": "55555555-5555-4555-8555-555555555555"
}
```

回傳建立或依 request key 找到的 `medication_plans`。計畫與提醒必須全部成功或全部回滾。

### 5.4 同步及刷新提醒

`sync_medication_plan_reminders`

```json
{ "target_plan_id": "MPL-81C4E207" }
```

回應無內容。

`refresh_medication_reminders`

```json
{ "target_pet_id": "PET-02BD14E8" }
```

回傳 `medication_reminders` 陣列，並依規則更新逾時狀態。

### 5.5 完成與處理漏服

`complete_medication_reminder`

```json
{
  "reminder_id": "RMN-3F70B26A",
  "actual_administered_at": "2026-08-13T20:02:00+08:00"
}
```

`actual_administered_at` 可省略；回傳更新後的提醒。

`resolve_missed_medication_reminder` 補登已服：

```json
{
  "reminder_id": "RMN-3F70B26A",
  "was_administered": true,
  "actual_administered_at": "2026-08-13T20:30:00+08:00"
}
```

確認未服：

```json
{
  "reminder_id": "RMN-3F70B26A",
  "was_administered": false
}
```

前者成為 `completed` 並建立照護紀錄，後者成為 `skipped`。

### 5.6 遛狗租約與完成

`begin_walk_session`

```json
{
  "walk_pet_id": "PET-02BD14E8",
  "walk_client_request_key": "walk:PET-02BD14E8:1786680000000:a1b2c3d4"
}
```

成功時回傳 `acquired`、`lease_token` 與 `expires_at`；若其他共養者正在遛同一隻寵物，回傳 `reason = active_by_other`、照護者名稱及開始時間。`lease_token` 是短期操作憑證，不得寫入日誌或雲端業務資料。

`heartbeat_walk_session`

```json
{
  "walk_pet_id": "PET-02BD14E8",
  "walk_client_request_key": "walk:PET-02BD14E8:1786680000000:a1b2c3d4",
  "walk_lease_token": "11111111-1111-4111-8111-111111111111"
}
```

有效租約回傳 `renewed = true` 與新的 `expires_at`；失去租約時回傳 `reason = lease_lost`。`abandon_walk_session` 使用相同三個參數主動釋放租約。

`complete_walk_session`

```json
{
  "walk_pet_id": "PET-02BD14E8",
  "walk_client_request_key": "walk:PET-02BD14E8:1786680000000:a1b2c3d4",
  "walk_lease_token": "11111111-1111-4111-8111-111111111111",
  "walk_started_at": "2026-08-14T08:00:00+08:00",
  "walk_ended_at": "2026-08-14T08:32:10+08:00",
  "walk_duration_seconds": 1810,
  "walk_distance_m": 2140.5,
  "walk_weight_kg_snapshot": 10.5,
  "walk_energy_kcal_low": 56.2,
  "walk_energy_kcal_high": 73.1,
  "walk_energy_model_version": "walk-met-v1",
  "walk_stool_times": ["2026-08-14T08:12:00+08:00"],
  "walk_urine_times": ["2026-08-14T08:05:00+08:00", "2026-08-14T08:24:00+08:00"]
}
```

完成 RPC 以 `client_request_key` 保持冪等，在同一交易建立 `walk_sessions`、途中排泄 `care_records` 並釋放租約。事件時間必須落在該次遛狗起訖範圍內。

### 5.7 同步離線生活記錄

`sync_offline_care_record`

```json
{
  "offline_pet_id": "PET-02BD14E8",
  "offline_client_request_key": "11111111-1111-4111-8111-111111111111:offline-mec0abc-1234567890abcdef",
  "offline_occurred_at": "2026-08-20T08:15:00+08:00",
  "offline_timezone": "Asia/Taipei",
  "offline_kind": "water",
  "offline_title": "飲水",
  "offline_note": null,
  "offline_amount": 180,
  "offline_unit": "ml",
  "offline_food_type": null,
  "offline_stool_texture": null,
  "offline_stool_color": null,
  "offline_stool_status": null,
  "offline_urine_color": null,
  "offline_metadata": {
    "structured_form_version": 1
  }
}
```

- 只接受 `meal`、`water`、`stool`、`urine`，且呼叫者必須是該寵物 owner 或 editor。
- 回傳單一 `care_records` 物件。客戶端只有在回傳的 `client_request_key` 與 `recorded_by` 精確符合目前 outbox 後才可刪除本機資料。
- 同一 actor 重送相同請求鍵會回傳同一資料列；同一鍵搭配不同寵物、種類或事件時間會被拒絕。
- 伺服器強制 `source = manual`、`capture_mode = offline`，並自行寫入 `recorded_by`、`received_at` 與 `created_at`。

## 6. 錯誤格式

目前不另包裝自訂錯誤 envelope，App 解析 Supabase／PostgREST 常見格式：

```json
{
  "code": "23505",
  "details": "Key (...) already exists.",
  "hint": null,
  "message": "duplicate key value violates unique constraint"
}
```

- `code` 可能是 SQLSTATE 或平台錯誤碼，不應只比對完整英文 `message`。
- UI 將重複邀請、已是成員、格式錯誤、權限不足、過期與網路錯誤轉成穩定的繁體中文提示。
- 不得把 SQL 細節、JWT、Email 清單或內部路徑直接顯示或送入分析日誌。

## 7. Realtime

共同照護邀請可透過 Realtime 接收變更。以下是代表性 SDK payload，不是另定的新 API：

```json
{
  "schema": "public",
  "table": "pet_invitations",
  "eventType": "INSERT",
  "new": {
    "id": "INV-6D28C17F",
    "invited_email": "caregiver@example.test",
    "status": "pending"
  },
  "old": {}
}
```

Realtime 只加速 UI 更新。App 回前景、開啟訊息或重新連線時仍須重新查詢。

## 8. Storage

- `pet-media` 必須保持私人。
- 現行資料表只保存 `avatar_path`、`image_path` 或相容用的 `medical_file_paths`；規劃中的正式病例改用一檔一列的 `medical_documents.storage_path`。
- App 依權限取得短效簽名網址；簽名網址不回寫資料表。
- 上傳須限制 MIME type、大小與路徑歸屬；訓練用途需另有同意、去識別、EXIF 清理與血緣紀錄。

## 9. 版本與相容

- 新欄位優先採可選或具安全預設值的增量 migration，不改寫既有 migration 歷史。
- 新增列舉值時同步更新資料庫約束、TypeScript 型別、UI、驗證與本文件。
- 破壞性變更須提升契約版本並定義舊 App 的相容或強制更新策略。
- `metadata` 若承載演進資料，應加入 `schema_version` 並保存來源及產生時間。
- 便便存在辨識已有面試 MVP 操作契約，但其分數未校準且不具醫療用途；正式資料集資格、專家真值、模型訓練同意與臨床審核仍須另建受治理契約。

### 9.1 便便存在辨識契約 v0.2（面試 MVP）

`stool_observations` 是 App 可依寵物權限讀取的流程狀態；模型執行、門檻、人工佇列及標註保存在不對一般前端公開的 `private` schema。

```json
{
  "id": "STO-1A2B3C4D",
  "owner_id": "USR-1A2B3C4D",
  "pet_id": "PET-1A2B3C4D",
  "captured_by": "USR-1A2B3C4D",
  "client_request_key": "3e0f2d88-ef6d-4d48-9ba2-3f398f18d1cc",
  "captured_at": "2026-08-21T14:05:00+08:00",
  "captured_timezone": "Asia/Taipei",
  "received_at": "2026-08-21T06:05:02Z",
  "capture_method": "live_camera",
  "media_path": "USR-1A2B3C4D/PET-1A2B3C4D/STO-1A2B3C4D/analysis.jpg",
  "content_type": "image/jpeg",
  "byte_size": 184220,
  "analysis_status": "completed",
  "owner_visible_result": "present",
  "latest_confidence": 0.86,
  "failure_code": null,
  "schema_version": "stool-observation-v1",
  "created_at": "2026-08-21T06:05:02Z",
  "updated_at": "2026-08-21T06:05:05Z"
}
```

| 名稱 | 允許值 |
| --- | --- |
| `analysis_status` | `awaiting_upload`, `queued`, `analysing`, `awaiting_human_review`, `completed`, `failed`, `cancelled`, `deletion_requested`, `deleted` |
| `owner_visible_result` | `present`, `absent`, `uncertain`, `not_assessable`, `null` |
| `capture_method` | `live_camera`, `gallery_upload` |

Edge Function `analyze-stool-image` 接受下列 action：

```json
{ "action": "create", "petId": "PET-1A2B3C4D", "clientRequestKey": "uuid", "capturedAt": "2026-08-21T14:05:00+08:00", "capturedTimezone": "Asia/Taipei", "captureMethod": "gallery_upload" }
```

```json
{ "action": "analyze", "observationId": "STO-1A2B3C4D" }
```

```json
{ "action": "reviewer-status" }
```

```json
{ "action": "claim-review" }
```

```json
{ "action": "submit-review", "observationId": "STO-1A2B3C4D", "label": "present", "note": null }
```

- `create` 回傳 `observation` 與固定格式的 `mediaPath`；新版 App 只上傳符合 `stool-roi-768-square-v1` 的 `768×768` ROI JPEG 到私人 `stool-media`，並以 Storage metadata 保存輸入 ROI 與前處理版本；框外照片不會由此流程上傳。
- `analyze` 由 Edge Function 驗證登入與寵物權限後取圖，再以伺服器端秘密呼叫 Cloud Run。模型端點權杖不得出現在 App、業務 JSON、日誌或 Git。
- `reviewer-status` 只回傳目前登入帳號是否具 reviewer 權限；`claim-review` 只允許已登錄 reviewer，並回傳不含模型候選與分數的盲審資料及五分鐘有效的 `signedImageUrl`；`submit-review.label` 只允許 `present`、`absent`、`not_assessable`。
- 重送相同 `captured_by + client_request_key` 不得建立重複 observation；Storage 路徑必須與 observation 的 owner、pet 及 ID 完全相符。

Cloud Run 推論回應契約：

```json
{
  "schema_version": "stool-inference-v1",
  "observation_id": "STO-1A2B3C4D",
  "model_version": "stool-presence-mobilenet-v2-reviewed-20260826-experimental",
  "model_family": "mobilenet_binary_v1",
  "input_roi_version": "stool-roi-768-square-v1",
  "preprocessing_version": "stool-roi-768-to-imagenet-224-v1",
  "stool_probability": 0.86,
  "score_kind": "binary_softmax_probability_uncalibrated",
  "calibrated": false,
  "candidate_code": "present",
  "result_code": "uncertain",
  "review_required": true,
  "threshold_set_version": null,
  "medical_interpretation": null
}
```

- `stool_probability` 是二元模型輸出的未校準 stool 類別 softmax 分數，不可解讀為臨床機率、正式準確率或影像品質分數；`candidate_code` 由兩類 softmax 的較大值產生，必須和人工結果分開保存。
- `stool-roi-768-to-imagenet-224-v1` 只適用於符合 `stool-roi-768-square-v1` 的 `768×768` ROI；分階段更新期間收到的舊版全圖輸入標為 `legacy-full-image-imagenet-resize-224-v1`，評估與資料 release 必須分開。既有 reviewed release 的母圖衍生血緣仍是 `stool-capture-crop-v1`，不得改寫歷史來源版本。
- Cloud Run 未設定正式門檻時仍安全回傳 `result_code=uncertain`、`review_required=true` 與 `threshold_set_version=null`。資料庫另以版本化原型政策 `prototype_present_candidate_to_placeholder_v1` 保存實際產品路由：`candidate_code=present` 時把 observation 設為 `completed/present` 並進成功佔位頁；`absent`／`uncertain` 時設為 `awaiting_human_review/uncertain` 並建立人工審核工作。
- 資料庫路由會附加 `raw_response.database_routing`，保存 `candidate_code`、實際 `review_required`、實際 `result_code` 與 policy；不得用 Cloud Run 原始 `review_required` 覆蓋資料庫實際路由，也不得把成功佔位頁解讀為人工確認。
- 每次推論須保存模型版本、前處理版本、原始回應、門檻版本及 latency；推論失敗保存 `failure_code`，不可偽裝為辨識結果。
- 推論營運用途不等於模型訓練同意；照片不會因上傳或辨識自動成為訓練資料。

## 10. 獸醫院協作資料契約 v0.2（資料層已部署）

本節對應已部署的 Supabase Row、RLS、Storage policy 與 TypeScript 型別。App 與院方 Portal 尚未串接；發布、修正、一次性授權碼兌換及檔案掃描仍須由後端受控流程補上。

### 10.1 已部署 ID 前綴

| 實體 | 規劃格式 |
| --- | --- |
| 獸醫院 | `VOR-XXXXXXXX` |
| 院方人員 | `VST-XXXXXXXX` |
| 寵物醫院授權 | `PCA-XXXXXXXX` |
| 照護者醫療授權 | `MAG-XXXXXXXX` |
| 就醫事件 | `VIS-XXXXXXXX` |
| 醫療文件 | `DOC-XXXXXXXX` |
| 檢查報告 | `DGR-XXXXXXXX` |
| 檢查結果 | `DGS-XXXXXXXX` |
| 醫療版本 | `MRV-XXXXXXXX` |
| 稽核事件 | `AUD-XXXXXXXX` |

前綴仍須在 migration 前確認不與其他業務實體衝突；ID 只供識別，不是權限或授權憑證。

### 10.2 已部署列舉

| 名稱 | 允許值 |
| --- | --- |
| `medical_source_type` | `owner_reported`, `caregiver_reported`, `owner_uploaded_unverified`, `clinic_submitted`, `veterinarian_reviewed`, `system_derived`, `device_measured` |
| `organization_verification_status` | `pending`, `verified`, `suspended`, `rejected`, `archived` |
| `veterinary_staff_role` | `clinic_admin`, `clinic_staff`, `veterinarian` |
| `veterinary_staff_status` | `invited`, `active`, `suspended`, `revoked` |
| `authorization_status` | `active`, `expired`, `revoked` |
| `medical_visit_status` | `draft`, `published`, `corrected`, `cancelled` |
| `medical_document_status` | `uploading`, `processing`, `draft`, `published`, `rejected`, `superseded` |
| `diagnostic_report_status` | `draft`, `confirmed`, `corrected`, `cancelled` |
| `diagnostic_flag` | `low`, `high`, `critical_low`, `critical_high`, `abnormal`, `normal`, `indeterminate`, `not_provided` |

`device_measured` 只保留相容方向，第一階段不得由 UI 或 API 建立。`veterinarian_reviewed` 必須同時具有有效獸醫師、所屬機構、覆核時間及被覆核版本。

### 10.3 `veterinary_organizations`

```json
{
  "id": "VOR-7B14C20A",
  "name": "示例動物醫院",
  "region": "TW",
  "verification_status": "verified",
  "verified_at": "2026-08-15T09:00:00+08:00",
  "archived_at": null,
  "created_at": "2026-08-14T10:00:00+08:00",
  "updated_at": "2026-08-15T09:00:00+08:00"
}
```

`verification_status` 只能由受控後端或平台管理流程變更。實際驗證證據不放入行動端可讀 JSON；證據種類、保存與核准責任目前為 `TBD`。

### 10.4 `veterinary_staff`

```json
{
  "id": "VST-16C9A804",
  "organization_id": "VOR-7B14C20A",
  "profile_id": "USR-15C8E4B9",
  "role": "clinic_staff",
  "status": "active",
  "activated_at": "2026-08-15T09:30:00+08:00",
  "revoked_at": null,
  "created_at": "2026-08-15T09:15:00+08:00",
  "updated_at": "2026-08-15T09:30:00+08:00"
}
```

資格參考與驗證 metadata 存於 `private.veterinary_staff_credentials`，不包含在 App 可讀的 `veterinary_staff` Row。`role = veterinarian` 不代表每一份資料均已覆核。

### 10.5 `pet_clinic_authorizations`

```json
{
  "id": "PCA-43D0198E",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "organization_id": "VOR-7B14C20A",
  "scope": ["create_visit", "upload_document", "write_diagnostic_result"],
  "status": "active",
  "policy_version": "clinic-share-tw-0.1",
  "locale": "zh-TW",
  "granted_at": "2026-08-15T10:00:00+08:00",
  "expires_at": "2026-08-15T18:00:00+08:00",
  "revoked_at": null,
  "created_at": "2026-08-15T10:00:00+08:00"
}
```

- 只有寵物飼主可建立或撤銷。
- 一次性授權碼與本 Row 分開保存；API 不回傳可重放的原始秘密。
- `scope` 使用伺服器允許清單，不接受任意字串擴權。
- 撤銷阻止未來操作，不宣稱院方先前合法下載的副本會被遠端刪除。

### 10.6 `medical_access_grants`

```json
{
  "id": "MAG-D80241B6",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "grantee_profile_id": "USR-15C8E4B9",
  "scope": ["view_visit", "view_document", "view_diagnostic_result"],
  "status": "active",
  "granted_at": "2026-08-15T10:05:00+08:00",
  "expires_at": null,
  "revoked_at": null,
  "created_at": "2026-08-15T10:05:00+08:00"
}
```

生活共同照護 `viewer/editor` 不自動產生此 Row。授權對象必須已可合法識別，不以 Email 字串直接作永久外鍵。

### 10.7 `medical_visits`

```json
{
  "id": "VIS-09AC51F4",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "organization_id": "VOR-7B14C20A",
  "occurred_at": "2026-08-15T10:30:00+08:00",
  "recorded_at": "2026-08-15T11:20:00+08:00",
  "received_at": "2026-08-15T11:20:02+08:00",
  "timezone": "Asia/Taipei",
  "source_type": "clinic_submitted",
  "status": "published",
  "title": "門診紀錄",
  "summary": "院方提供的就醫摘要",
  "created_by_profile_id": null,
  "created_by_staff_id": "VST-16C9A804",
  "reviewed_by_staff_id": null,
  "reviewed_at": null,
  "schema_version": 1,
  "supersedes_id": null,
  "published_at": "2026-08-15T11:30:00+08:00",
  "created_at": "2026-08-15T11:20:02+08:00",
  "updated_at": "2026-08-15T11:30:00+08:00"
}
```

- `occurred_at` 是實際就醫時間；`recorded_at` 是院方輸入時間；`received_at` 是平台接收時間。
- `reviewed_by` 只有在來源升為 `veterinarian_reviewed` 時必填，且必須是有效獸醫師人員 ID。
- 已發布資料不直接覆寫；更正建立新版本並填入 `supersedes_id`。

### 10.8 `medical_documents`

```json
{
  "id": "DOC-284EB970",
  "visit_id": "VIS-09AC51F4",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "document_type": "laboratory_report",
  "storage_path": "USR-7A3F91C2/PET-02BD14E8/VIS-09AC51F4/DOC-284EB970/report.pdf",
  "original_filename": "report.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 245760,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "source_type": "clinic_submitted",
  "status": "published",
  "version": 1,
  "supersedes_id": null,
  "uploaded_by_profile_id": null,
  "uploaded_by_staff_id": "VST-16C9A804",
  "recorded_at": "2026-08-15T11:21:00+08:00",
  "received_at": "2026-08-15T11:21:03+08:00",
  "published_at": "2026-08-15T11:30:00+08:00",
  "created_at": "2026-08-15T11:21:03+08:00"
}
```

- `storage_path` 是私人路徑，不是下載 URL；短效簽名網址不回寫 Row。
- MIME、大小、路徑歸屬、內容類型及惡意檔案檢查由伺服器確認。
- 一個檔案一個 Row，禁止以未治理的路徑陣列表示正式病例。
- 飼主上傳時 `source_type` 固定為 `owner_uploaded_unverified`。

### 10.9 `diagnostic_reports` 與 `diagnostic_results`

```json
{
  "id": "DGR-71F02C8D",
  "visit_id": "VIS-09AC51F4",
  "document_id": "DOC-284EB970",
  "owner_id": "USR-7A3F91C2",
  "pet_id": "PET-02BD14E8",
  "report_type": "hematology",
  "collected_at": "2026-08-15T10:45:00+08:00",
  "reported_at": "2026-08-15T11:15:00+08:00",
  "recorded_at": "2026-08-15T11:25:00+08:00",
  "timezone": "Asia/Taipei",
  "source_type": "clinic_submitted",
  "status": "confirmed",
  "created_by_profile_id": null,
  "created_by_staff_id": "VST-16C9A804",
  "confirmed_by_staff_id": "VST-16C9A804",
  "confirmed_at": "2026-08-15T11:29:00+08:00",
  "schema_version": 1,
  "created_at": "2026-08-15T11:25:00+08:00",
  "updated_at": "2026-08-15T11:29:00+08:00"
}
```

```json
{
  "id": "DGS-5C140E92",
  "report_id": "DGR-71F02C8D",
  "item_code": null,
  "item_name": "示例檢查項目",
  "value_numeric": 7.2,
  "value_text": null,
  "original_unit": "g/dL",
  "canonical_value": null,
  "canonical_unit": null,
  "reference_low": 5.5,
  "reference_high": 7.5,
  "reference_text": "5.5–7.5",
  "flag": "normal",
  "method": null,
  "specimen": "blood",
  "display_order": 1,
  "created_at": "2026-08-15T11:25:10+08:00"
}
```

- `value_numeric` 與 `value_text` 至少一個有值，但不能用空字串代表未知。
- 原始值、單位、院方參考區間與旗標必須保存；只有具明確換算規則時才填 canonical 欄位。
- 不得自行借用其他醫院、其他物種或其他方法的參考區間。
- `flag` 忠實保存院方旗標，不直接轉換為疾病名稱或治療建議。

### 10.10 授權碼兌換與發布 RPC 草案

`redeem_pet_clinic_authorization`

```json
{
  "authorization_code": "一次性短效秘密"
}
```

成功只回傳最小授權摘要；失敗統一回應無效／過期，不透露寵物或飼主是否存在。原始授權碼不得寫入一般日誌、分析事件或業務資料。

`publish_medical_visit`

```json
{
  "visit_id": "VIS-09AC51F4",
  "client_request_key": "77777777-7777-4777-8777-777777777777"
}
```

發布必須在同一受控交易中確認醫院、人員、角色、寵物授權、文件處理狀態與資料欄位；重試相同 `client_request_key` 不得重複發布或通知。

`correct_medical_record`

```json
{
  "target_type": "medical_visit",
  "target_id": "VIS-09AC51F4",
  "replacement_id": "VIS-4A0837DE",
  "reason": "院方更正資料"
}
```

修正建立追加式版本與稽核事件，不刪除或覆寫原始已發布內容。允許的 `target_type` 使用伺服器列舉，不接受任意表名。

### 10.11 不對前端公開的資料

- 醫院及獸醫師驗證證據原件。
- 稽核事件的內部風險 metadata。
- 檔案掃描器內部結果及基礎設施路徑。
- 授權碼雜湊、簽名秘密、`service_role`、資料庫憑證。
- 其他使用者、其他醫院或未分享寵物的存在性資料。
- AI 資料集資格、專家真值或模型管理資料。

醫療文件預設只供營運服務，不可因上傳或院方提交自動取得模型訓練資格。訓練同意、資料血緣與權利確認需另建受治理契約。

## 12. 智能垃圾桶 BLE 位元契約 v1（韌體已實作，後端未實作）

協定、UUID 與安全模型見 [SMART_BIN_DESIGN.md](./SMART_BIN_DESIGN.md)。該文件定義了每個特徵值的用途，但沒有定位元組排列；本節補上，**後端必須照此組出指令，否則裝置一律拒絕**。

狀態：韌體端已實作並於實體 ESP32-C3 上驗證（2026-09-15）。後端與 App 尚未實作。

### 共同規則

- 所有多位元組整數為 **little-endian**，與 ESP32 原生一致。
- 結構為 **packed**，不含對齊填充。填充位元組會讓兩端對欄位位置的理解不一致，而且會被算進 MAC。
- `protocol_version` 目前為 `1`。裝置只接受版本相符的指令，不做向下相容的欄位推測。

### device_info（read，11 位元組）

| 位移 | 長度 | 欄位 | 說明 |
| --- | --- | --- | --- |
| 0 | 1 | `protocol_version` | |
| 1 | 6 | `device_id` | efuse 出廠 MAC，與 QR 貼紙相同 |
| 7 | 3 | `firmware_version` | major, minor, patch |
| 10 | 1 | `capabilities` | bit0 鎖舌回饋、bit1 出袋機構、bit2 滿載偵測 |

不含秘密，任何人可讀。`capabilities` 讓 App 依實際機型顯示流程，而不是假設所有機台一樣。

### challenge（read，21 位元組）

| 位移 | 長度 | 欄位 |
| --- | --- | --- |
| 0 | 1 | `protocol_version` |
| 1 | 4 | `counter` |
| 5 | 16 | `nonce` |

**每次讀取都產生新的 nonce**，舊的未使用 nonce 直接被取代 —— 使用者取消操作不會浪費授權。

### status（read / notify，4 位元組）

| 位移 | 長度 | 欄位 |
| --- | --- | --- |
| 0 | 1 | `protocol_version` |
| 1 | 1 | `state`：0 待機、1 脈衝中、2 忙碌、3 故障、4 等待關蓋 |
| 2 | 1 | `error_code`：見下方拒絕原因 |
| 3 | 1 | `flags`：bit0 已佈建金鑰、bit1 鎖舌回饋閉合 |

### command（write，42 位元組）

| 位移 | 長度 | 欄位 | 檢查 |
| --- | --- | --- | --- |
| 0 | 1 | `protocol_version` | 必須等於 1 |
| 1 | 1 | `opcode` | 1 = unlock |
| 2 | 4 | `counter` | 必須正好等於裝置目前值 |
| 6 | 16 | `nonce` | 必須等於裝置最近產生且未使用的 nonce |
| 22 | 2 | `window_seconds` | 5–120，超出範圍拒絕。**語意為「多久沒關上蓋子就視為未完成」，不是通電時間** |
| 24 | 2 | `reserved` | 必須為 0 |
| 26 | 16 | `mac` | 見下 |

```text
mac = HMAC-SHA256(K, command[0..25] ‖ device_id)[0..15]
```

簽章輸入是**指令的前 26 位元組串上 6 位元組的 device_id**，共 32 位元組，結果截斷為前 128 bit。

把 `device_id` 算進簽章，是為了讓一台機器的授權不可能在另一台上生效，即使兩台的計數器與 nonce 碰巧相同。

截斷到 128 bit 而非完整 256 bit，是因為 BLE 預設 MTU 只有 23 位元組，多 16 位元組要多一次分段傳輸；而攻擊者沒有離線暴力破解的機會 —— 每次嘗試都要經過裝置，且每個 nonce 只接受一次。

### 拒絕原因（`status.error_code`）

| 值 | 意義 |
| --- | --- |
| 0 | 通過 |
| 1 | 長度不符 |
| 2 | 協定版本不符 |
| 3 | 未知指令 |
| 4 | 計數器不符 |
| 5 | nonce 不符或已用過 |
| 6 | 尚未佈建金鑰 |
| 7 | 已有進行中的 session |
| 8 | 簽章驗證失敗 |
| 9 | 保留欄位非零 |
| 10 | 投放窗超出範圍 |
| 11 | 計數器已用盡 |

錯誤碼會回報給 App 顯示具體原因。這些欄位都不是秘密：nonce 與計數器本來就可公開讀取。

### 指令被接受後的順序

```text
驗證通過 → 計數器前進並寫入 NVS → nonce 作廢 → 通電開鎖 → 開始計時
```

**計數器必須在開鎖之前就寫入。** 若先開鎖再寫入，斷電時機不巧會讓計數器停在舊值，同一道指令可以再被重放一次。寧可「寫入成功但沒開鎖」也不要「開了鎖但沒記錄」。

### 事件鏈（2026-09-18 定案為三段）

```text
unlock_confirmed → hatch_closed → latch_locked
```

不需要蓋子感測器。斜舌只有在不處於鎖孔裡時才會被關門的斜面壓回，所以「鎖舌的第二次縮回」同時證明蓋子開過又關上了；`hatch_opened` 由 `hatch_closed` 邏輯上隱含。理由與代價見 [SMART_BIN_DESIGN.md](./SMART_BIN_DESIGN.md)。

開鎖為**脈衝**：通電、等鎖舌縮回、續電一小段讓蓋子彈開、斷電。持續通電會讓鎖舌被拉住，反而阻止蓋子上鎖。

### event 與 receipt

尚未實作（階段四）。`receipt` 的位元格式待實作時定義，需涵蓋 device_id、計數器、授權該次的 nonce、三段事件的完成情形與耗時，並以裝置金鑰簽章 —— 後端只信任這一份。
