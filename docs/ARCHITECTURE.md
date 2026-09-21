# Smart Pet Life 系統架構

| 項目 | 內容 |
| --- | --- |
| 更新日期 | 2026-08-15 |
| 現行產品 | 寵物生活與共同照護 App |
| 下一階段 | 獸醫院就醫資料協作；資料庫／RLS 與飼主唯讀醫療中心已實作，Portal 尚未實作 |
| 完整設計 | [VETERINARY_COLLABORATION_DESIGN.md](./VETERINARY_COLLABORATION_DESIGN.md) |

## 1. 架構定位

Smart Pet Life 近期以「飼主生活照護 App＋獸醫院 Web Portal＋受控資料平台」為目標。平台連結一隻寵物跨家庭照護與就醫的長期履歷，但不取代獸醫院診療系統，也不要求醫療設備才能運作。

第一階段保留現有生活、共同照護、預防照護、用藥提醒與遛狗功能；院方在飼主授權後手動上傳就醫檔案及檢查數據。居家醫療設備、醫療設備閘道器、院內系統 API、智慧垃圾桶與其他硬體不是近期醫療協作依賴。

## 2. 技術組合

- 飼主 App：Expo / React Native / TypeScript。
- 獸醫院 Portal：規劃為響應式 Web App；技術選型於實作前確認。
- 後端：Supabase Auth、PostgreSQL、Row Level Security、Storage、RPC／Edge Functions。
- API：行動端及 Portal 只使用 publishable key 與使用者 JWT；特權操作由受控後端執行。
- 文件：私人 Storage、短效下載、檔案中繼資料與版本血緣。
- 通知：App 內通知為既有基礎；正式系統推播尚未完成。
- AI／OCR：若未來導入，只能產生待院方確認草稿，不直接形成正式院方結果。

## 3. 現行已部署架構

```text
Expo / React Native App
  ├─ Auth、寵物、多寵物切換
  ├─ 共同照護與邀請
  ├─ 生活紀錄、用藥、預防照護
  ├─ 便便統一入口（拍攝辨識／手動記錄）
  │    └─ 拍攝辨識只上傳框內 `768×768` 私有 ROI，另建 observation；不自動成為訓練資料
  ├─ 遛狗摘要及途中排泄
  ├─ 私人寵物照片
  ├─ 犬隻協尋（人工線索、隱藏特徵、shadow 狀態）
  └─ 底部醫療頁籤：唯讀醫療中心（就醫檔案／檢查數據）
             │ HTTPS / Realtime
             ▼
Supabase
  ├─ PostgreSQL + RLS + RPC
  ├─ Auth
  ├─ private pet-media Storage
  ├─ private medical-media Storage
  ├─ PGMQ + pg_cron + Edge worker（shadow 工作；已部署於測試環境）
```




獸醫院機構、人員、醫院授權、正式就醫、獨立病例文件、結構化檢查結果、醫療版本及私人稽核資料表均已部署。飼主 App 已接上唯讀查詢；獸醫院 Portal、醫療分享設定與受控下載閘道仍不存在。已部署 migration 與 `mobile/src/types/database.ts` 是資料層現況事實來源。

## 4. 醫療服務邊界（資料層及飼主唯讀畫面已串接）

```text
飼主／共同照護 App
  ├─ 私人生活動態與家庭共同照護
  ├─ 就醫履歷、文件、檢查數據
  └─ 醫院／照護者醫療分享授權
                    │
                    ▼
平台 Auth、API、RLS、授權、版本與稽核
  ├─ 生活照護域
  ├─ 醫院機構與人員域
  ├─ 就醫與診斷報告域
  ├─ 文件與通知域
  └─ 同意與資料治理域
          │                    │
          ▼                    ▼
PostgreSQL                 private Storage
          ▲
          │
獸醫院 Web Portal
  ├─ 一次性寵物授權
  ├─ 就醫與文件上傳
  └─ 檢查結果確認及修正

院內系統 ── 未來受控 API／批次匯入 ──> 平台整合層
```

生活、醫療與未來公開社交是不同資料邊界。公開或家庭動態不得自動取得醫療詳細資料；共同照護 `viewer/editor` 也不自動取得病例權限。

## 5. 現行核心資料

| 實體 | 狀態 | 用途 |
| --- | --- | --- |
| `profiles` | 已部署 | 使用者基本資料及 Auth 對照 |
| `pets` | 已部署 | 寵物檔案與原始飼主 |
| `pet_memberships` | 已部署 | 私人共同照護權限 |
| `pet_invitations` | 已部署 | Email、QR／邀請碼加入流程 |
| `care_records` | 已部署 | 飲食、飲水、排泄、用藥、疫苗及目前的驅蟲紀錄 |
| `medication_plans`／`medication_reminders` | 已部署 | 用藥計畫、提醒與完成證據 |
| `preventive_care_schedules` | 已部署 | 疫苗與驅蟲排程 |
| `walk_sessions` | 已部署 | 遛狗完成摘要；不保存原始 GPS 路線 |
| `pet-media` | 已部署 | 私人寵物照片及既有附件路徑 |

目前 `care_record_kind = medical` 在 UI 中實際代表驅蟲，不能視為正式病例模型；`care_records.medical_file_paths[]` 也沒有文件級來源、版本、雜湊及院方血緣。

## 6. 已部署的獸醫協作資料

| 實體 | 狀態 | 用途 |
| --- | --- | --- |
| `veterinary_organizations` | 已部署 | 已驗證獸醫院機構 |
| `veterinary_staff` | 已部署 | 院方人員、角色、資格參考及停權 |
| `pet_clinic_authorizations` | 已部署 | 飼主對醫院的寵物與範圍授權 |
| `medical_access_grants` | 已部署 | 飼主另授權照護者查看醫療資料 |
| `medical_visits` | 已部署 | 一次就醫事件、來源、狀態及時間 |
| `medical_documents` | 已部署 | 一檔一列、私人路徑、雜湊、版本及修正鏈 |
| `diagnostic_reports` | 已部署 | 一次檢查報告及確認狀態 |
| `diagnostic_results` | 已部署 | 項目、數值／文字、單位、參考區間及院方旗標 |
| `medical_record_versions` | 已部署 | 已發布內容的追加式修正證據 |
| `audit_events` | 已部署／私人 | 敏感查看、下載、授權、發布及管理操作的後端寫入目標 |

醫療資料以增量 migration 建立，不改寫既有 migration 歷史。既有 `care_record_kind = medical` 仍解釋為驅蟲；正式病例只使用獨立醫療資料表。

## 7. 來源與可信度

平台必須分開保存：

- `owner_reported`：飼主自行輸入。
- `caregiver_reported`：共同照護者輸入。
- `owner_uploaded_unverified`：飼主自行上傳文件。
- `clinic_submitted`：已驗證醫院帳號提交。
- `veterinarian_reviewed`：具獸醫師身分、所屬機構、覆核時間及版本證據。
- `system_derived`：平台整理、換算或趨勢。
- `device_measured`：未來保留；第一階段停用。

院方提交不等於獸醫師覆核；OCR 草稿、系統換算及飼主上傳也不能自動升級來源。

每個就醫或檢查事件分開保存 `occurred_at`、`recorded_at`、`received_at`、`timezone`、建立者、來源、`schema_version` 及修正關聯，不能以 `created_at` 取代臨床事件時間。

## 8. 權限與隱私

- 飼主是分享權限控制者；共同照護生活權限不等於醫療權限。
- 院方人員必須同時具備有效機構、人員身分、角色及寵物授權。
- 醫院預設只能處理該院建立的資料；跨院歷史需飼主另行分享。
- 醫療文件使用私人 Storage 與短效網址，不建立永久公開 URL。
- 目前 App 直接依 Storage RLS 建立五分鐘短效網址；正式上線前仍須以受控下載閘道補齊不可繞過的伺服器端下載稽核。
- 版本修正採追加方式，保留舊版、原因、操作者與時間。
- 行動端與 Portal 不得直接寫入獸醫資格、稽核或專家覆核狀態。
- 社群服務只能接收使用者明確選擇的生活內容，不得自動投影病例或檢查結果。

## 9. 醫療顯示安全

- 顯示原始數值、原始／標準化單位、院方參考區間及院方旗標。
- 沒有院方參考區間時保持未知，不借用其他實驗室範圍。
- 趨勢只描述變化，不根據單一結果產生疾病名稱或處方建議。
- `veterinarian_reviewed` 必須有可驗證覆核證據；否則顯示「醫院提供」或「等待專業複核」。
- AI／OCR 只處理資料草稿；醫療內容發布仍由有效院方人員確認。

## 10. 區域與資料治理

現有 Supabase 位於新加坡，這只是部署事實。台灣、中國大陸或其他地區推出醫療文件服務前，必須確認資料控制者、醫院與平台責任、告知與授權、服務區域、跨境接收者、保存／刪除、事件通報及資料權利流程；法律結論由合格顧問確認。

營運服務、醫院分享、公開社交、行銷與可選 AI 訓練使用不同目的與同意。醫療文件預設不進入模型訓練；保留期限在責任人及依據核准前維持 `TBD`。

## 11. 實作順序

1. 核准首發地區、犬／貓範圍、醫院與獸醫師驗證責任、授權範圍及保留政策。
2. 建立飼主 App 醫療分享設定與受控下載閘道，補齊敏感下載稽核。
3. 建立醫院 Portal 的登入、授權、上傳、確認、發布與修正流程。
4. 以少量合作醫院手動上傳試點，再評估 OCR、院內系統 API 或其他硬體整合。
