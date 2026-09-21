# 雲端資料庫說明

Smart Pet Life 使用 Supabase（PostgreSQL、Auth、Storage）作為雲端後台。第一版資料庫已部署到新加坡區域的 Supabase 專案。

> 本文件描述已部署現況。獸醫院、正式就醫、獨立病例文件、結構化檢查結果、RLS 與私人 Storage 已完成資料層部署；飼主 App 已串接唯讀醫療中心，院方 Portal 尚未串接，見 [獸醫院協作平台技術設計](./VETERINARY_COLLABORATION_DESIGN.md)。

## 已建立的內容

- `profiles`：飼主資料；`id` 是 `USR-XXXXXXXX`，`auth_user_id` 唯一對應 Supabase Auth UUID。
- `pets`：寵物資料，包含品種、絕育狀態、生日、體重、每日餐數與飲水目標。
- `pets.birthday` 是建立時確認的日曆日期；一般 App 資料庫角色在建立後不可更新，年齡由 App 即時計算而不儲存。
- `care_records`：飲食、喝水、便便、尿尿、用藥、疫苗及目前以 `medical` 表示的驅蟲記錄；它不是正式病例模型。
- `walk_sessions`：完成後的遛狗摘要，保存執行者、時間、路程、平均速度、約略熱量及排泄次數；原始 GPS 點不寫入雲端。
- `medication_plans`：藥物療程、劑量、每日時間及起訖日期。
- `medication_reminders`：每一個實際提醒時間及完成狀態。
- `pet-media`：私有 Storage bucket，供寵物頭像、便便照片與既有生活照護附件使用；正式病例使用獨立 `medical-media`。

`care_records.medical_file_paths[]` 是早期相容欄位，目前沒有文件級醫院來源、版本、雜湊、上傳者或修正鏈；新病例設計不應繼續以路徑陣列擴充。

## 業務 ID 規則

所有 App 業務實體使用固定的 `3 字元前綴-8 位大寫十六進制`：

| 實體 | 格式 |
| --- | --- |
| 使用者 | `USR-XXXXXXXX` |
| 寵物 | `PET-XXXXXXXX` |
| 照護紀錄 | `REC-XXXXXXXX` |
| 用藥計畫 | `MPL-XXXXXXXX` |
| 用藥提醒 | `RMN-XXXXXXXX` |
| 共同照護成員 | `MBR-XXXXXXXX` |
| 共同照護邀請 | `INV-XXXXXXXX` |
| 預防照護排程 | `PVC-XXXXXXXX` |
| 遛狗記錄 | `WLK-XXXXXXXX` |
| 協尋案件 | `PST-XXXXXXXX` |
| 協尋圖片 | `PSM-XXXXXXXX` |
| AI 相似候選 | `MCH-XXXXXXXX` |

資料庫使用一個不循環的全域 sequence，再以 32-bit 可逆排列轉成十六進制。ID 看起來不連號，且在 42.9 億個序列值用完前不會碰撞；primary key 與格式 constraint 會再從資料庫邊界保護唯一性與格式。ID 建立後不可修改。

Supabase Auth UUID 只保留於 `profiles.auth_user_id`，用來將 `auth.uid()` 映射成 `USR` ID。RLS、業務外鍵、RPC 及 App 狀態均使用業務 ID。邀請碼是有期限的加入憑證，與 `INV` 記錄 ID 分開。

舊測試資料會在 migration 中轉成新 ID。既有 Storage 物件名稱可能仍含舊寵物 UUID，因此 `private.legacy_pet_media_ids` 只保留舊路徑與新 `PET` ID 的私有相容對照；新上傳不會再新增舊 UUID 路徑。

## 用藥計畫與服藥事件

- `medication_plans.dose_amount` 保存每次服用的正數數值，最多三位小數；`dose_unit` 使用受控單位代碼，不再把數值與單位混在同一個自由文字欄位中。
- 支援單位包含 `mcg`、`mg`、`g`、`ml`、錠、膠囊、包、滴、噴、IU 與其他。顯示文字由 App 本地化，資料庫保留穩定代碼。
- 每個療程會依日期、每日服藥時間及 `timezone` 產生獨立的 `medication_reminders`；同一療程與排程時間具有唯一約束，重試不會重複建立。
- 每日服藥時間必須按照第一次、第二次、第三次嚴格遞增，相鄰時間至少間隔 5 分鐘；App 與原子建立函式會重複驗證，不會自動改變使用者設定的順序。
- App 透過 `create_medication_plan_with_reminders` 在同一資料庫交易中建立療程與提醒；任何一步失敗都會整筆回滾。`client_request_key` 用於安全重試，避免連點或網路重送建立重複療程。
- 提醒狀態為 `pending`、`overdue`、`completed`、`skipped` 或 `cancelled`。超過排程時間只會進入 `overdue` 待飼主確認，不會由系統直接判定漏服。
- 完成提醒時，資料庫在同一交易內鎖定提醒、使用伺服器時間保存 `completed_at`、保存實際服用時間 `administered_at`、建立 `care_records`，並回寫 `care_record_id`。
- 確認未服用時保存原定 `scheduled_at` 與確認時間 `skipped_at`；`resolved_by` 保存執行確認的照護者。
- App 登入、切換寵物、回到前景及每分鐘會刷新可處理提醒。這是 App 內狀態同步；正式系統推播仍需後續通知服務。

寵物所屬資料都同時保存 `owner_id` 與 `pet_id`。資料庫使用複合外鍵確認寵物確實屬於該飼主，並透過 RLS 保證登入者只能存取自己的資料。

## 寵物刪除策略

`pets` 沒有開放一般使用者直接刪除。App 應更新 `archived_at` 來封存寵物，避免使用者誤刪後重新建立同一隻寵物，造成歷史健康記錄分散。

## 遛狗記錄與共養互斥

- owner 與 editor 可開始遛狗，viewer 只能查看完成記錄。
- `private.active_walk_leases` 以 `pet_id` 主鍵保證同一隻寵物同一時間只有一筆有效租約；App 每 30 秒呼叫心跳，租約 2 分鐘未續租即失效。
- `begin_walk_session`、`heartbeat_walk_session`、`abandon_walk_session` 與 `complete_walk_session` 是唯一可操作私有租約的入口，且每次都重新驗證目前登入者及寵物編輯權限。
- 完成 RPC 在同一交易中建立 `walk_sessions`、途中便便／尿尿的 `care_records`，再釋放租約；`client_request_key` 使完成重試具冪等性。
- 途中排泄的 `care_records.source` 為 `walk_tracking`，並透過 `walk_session_id` 區分是否發生在遛狗途中。
- 雲端只保存完成摘要與排泄事件，不保存原始 GPS 座標或路線幾何；完成畫面仍可在裝置上繪圖、截圖與分享。

## 照護記錄時間規則

- 每次新增 `care_records` 時，`occurred_at` 由 Supabase 資料庫直接寫入伺服器當下時間，App 不會傳入時間。
- 歷史記錄的內容可以修改，也可以整筆刪除。
- `occurred_at` 和 `created_at` 都不能在建立後修改；資料庫 trigger 會拒絕任何改時間的請求。
- 每日統計會依 `occurred_at` 並轉換成使用者時區後計算，不使用手機可自行調整的系統時間作為可信來源。

## App 環境設定

在 `mobile` 目錄複製環境設定範例：

```powershell
Copy-Item .env.example .env
```

接著到 Supabase Dashboard 的 **Project Settings → API Keys**，填入 Project URL 與 Publishable Key：

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

只可使用 Publishable Key。Secret key 或舊版 `service_role` key 絕對不能放進 App、`.env.example` 或 GitHub。

實際 `.env` 已被 Git 忽略。關機會重置的學校電腦需要在每次重新下載專案後重新建立此檔案。

## 程式入口

- `mobile/src/lib/supabase.ts`：建立 Supabase client。為符合目前「不保存到本地」的決定，登入 session 暫時不寫入本機。
- `mobile/src/types/database.ts`：資料表的 TypeScript 型別。
- `mobile/src/services/petData.ts`：寵物、照護記錄與用藥療程的基本讀寫函式。
- `supabase/migrations/202608110001_initial_schema.sql`：資料庫第一版 migration。
- `supabase/migrations/20260813090024_prefixed_hex_entity_ids.sql`：將既有 UUID 業務主鍵轉換成固定前綴的 8 位十六進制 ID。
- `supabase/migrations/20260815064959_pet_medical_platform_rls_core.sql`：建立獸醫院、人員、醫療授權、就醫、文件、檢查、版本、私有稽核、RLS 與 `medical-media`。
- `supabase/migrations/20260815065024_*.sql` 至 `20260815065309_*.sql`：遠端長 SQL 分批部署的歷史對齊標記；完整可重播 SQL 保留在 core migration。
- `supabase/migrations/20260815065533_index_pet_medical_foreign_keys.sql`：補齊醫療資料所有外鍵的 leading-column 索引。

## 目前限制

- Supabase Auth 仍使用平台 UUID，這是身分驗證系統的必要對照，不會顯示為 App 業務 ID。
- 新 ID 是方便內部管理與辨識的主鍵，不是安全憑證；資料隔離仍依賴 RLS、RPC 驗證與 Storage policy。

## 已部署的獸醫院協作資料（飼主 App 已唯讀串接）

下列資料表、RLS 與 Storage policy 已部署至遠端 Supabase：

| 資料表 | 用途 |
| --- | --- |
| `veterinary_organizations` | 獸醫院機構、地區及驗證狀態 |
| `veterinary_staff` | 院方人員、角色、所屬機構、資格參考及停權 |
| `pet_clinic_authorizations` | 飼主授予醫院的寵物與資料範圍 |
| `medical_access_grants` | 飼主另授予共同照護者的醫療查看權 |
| `medical_visits` | 就醫事件、來源、狀態、實際時間與時區 |
| `medical_documents` | 一個檔案一列，保存私人路徑、MIME、大小、雜湊、版本與修正鏈 |
| `diagnostic_reports` | 檢查報告、採檢／報告時間及院方確認狀態 |
| `diagnostic_results` | 檢查項目、數值／文字、單位、院方參考區間與原始旗標 |
| `medical_record_versions` | 已發布醫療內容的追加式版本與修正理由 |
| `audit_events` | 敏感查看、下載、發布、授權與管理操作 |

### 相容與 migration 原則

- 保留既有 migration 歷史，只新增可回滾、可驗證的 migration。
- 先確認所有既有 `care_record_kind = medical` 是否均為驅蟲，再決定新增 `deworming` 列舉值及回填方式；不得直接把舊資料重新解釋成就醫。
- 正式就醫使用 `medical_visits`，不把病例狀態與版本生命週期塞入 `care_records`。
- 新檔案使用 `medical_documents` 一檔一列；既有 `medical_file_paths[]` 只保留相容，不作新功能寫入目標。
- 飼主／照護者回報、飼主上傳、院方提交、獸醫覆核及系統整理保存不同來源值。
- 每筆醫療事件保留發生、記錄、平台接收時間、時區、建立者、契約版本及修正關聯。

### 已部署存取規則

- 飼主可查看自己寵物的醫療資料及管理授權。
- 既有 `viewer/editor` 不自動得到醫療權限，必須有有效 `medical_access_grants`。
- 院方人員需要有效醫院、人員身分、角色及 `pet_clinic_authorizations` 才能操作。
- 醫院預設只能查看該院提交的資料；其他歷史需飼主明確分享。
- 行動端與 Portal 不得直接寫入稽核、獸醫資格或 `veterinarian_reviewed` 狀態。
- 匿名與無關登入者不能存取資料或猜測 Storage 路徑。

### Storage 現況

病例使用獨立且私人的 `medical-media` bucket。RLS 以 `medical_documents.storage_path` 對照明確的飼主、醫療查看授權或有效院方授權；匿名角色沒有資料表權限。單檔上限為 25 MiB，允許 PDF、JPEG、PNG、WebP、HEIC 與 HEIF。飼主 App 目前在開啟檔案時建立五分鐘短效網址；惡意檔案掃描、EXIF 清理、發布工作流程，以及不可繞過的下載閘道與伺服器端下載稽核仍須由後端服務完成。

目前不設定固定保存期限。病例、檢查、稽核、備份及使用者刪除的期限與例外須由產品、合作醫院、資安及合格法律顧問核准後再寫入政策與 migration。
