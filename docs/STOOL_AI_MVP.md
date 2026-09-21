# 便便存在辨識 MVP

## 目前範圍

第一版只回答「影像中是否有便便」，不判斷軟硬、顏色、形狀、病因或疾病。App 支援即時拍攝，測試階段可由 feature flag 開啟相簿入口；兩者都會套用 `stool-roi-768-square-v1`，只保留正方形 ROI 並輸出為 `768×768` JPEG，降低無關背景及 EXIF 等非必要資訊殘留的風險，再分別保存 `live_camera` 或 `gallery_upload` 來源。即時相機會把畫面上的引導框反算回原始照片像素；相簿入口使用中央正方形裁切，且其 `captured_at` 是使用者選取時間，不宣稱為原始拍攝時間。

1. App 建立帶有寵物、拍攝者、拍攝時間與時區的 observation。
2. App 將符合 `stool-roi-768-square-v1` 的 ROI 影像上傳到私有 `stool-media`；框外原始照片不會由此流程上傳。
3. Edge Function 驗證登入者與寵物編輯權限，再從私有 bucket 讀圖。
4. Edge Function 呼叫獨立 ONNX 推論服務，保存模型版本、前處理版本、分數與延遲。
5. 二分類模型輸出 `present`、`absent` 或防禦性 `uncertain` 候選；`present` 暫時完成辨識並進入 App 成功佔位頁，`absent`／`uncertain` 才進入人工複核。
6. softmax 相對分數尚未校準，不代表準確率、疾病機率或人工確認；目前路由政策記錄為 `prototype_present_candidate_to_placeholder_v1`。
7. 只有已佈建 reviewer 可領取人工複核工作；影像網址只有五分鐘有效。人工答案另存為 `human_review` provenance，不能覆寫模型原始輸出。

照片只獲准用於本次服務與必要人工複核，不能因為上傳就自動成為訓練資料。若要回流訓練，需另做明確且可撤回的同意、保存期限與刪除流程。

## 看見訓練過程

本機 dependency-light 管線冒煙測試：

```powershell
& 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -B ml\smoke_train.py --epochs 8
```

終端機每個 epoch 都會印出 loss、precision、recall、F1；`ml/runs/smoke-*/training_report.html` 會保存曲線與設定。這是合成資料，只證明訓練與報告管線可工作，不能當作真實模型準確率。

正式 GPU 訓練在 Colab 開啟 `notebooks/stool_presence_colab.ipynb`，可看到：

- 每個 epoch 的 train/validation loss、precision、recall、F1；
- TensorBoard 即時曲線；
- test confusion matrix、threshold candidates 與資料 manifest；
- checkpoint、ONNX artifact、完整 JSON/CSV 與 HTML 報告。

資料設定固定在 `ml/configs/stool_presence_v1.json`。目前 MobileNet 二分類模型只供原型試用；正式決策門檻仍必須用 App 拍攝域、含困難負例且按寵物／家庭／事件分組的保留測試集校準與驗證，避免近重複影像洩漏。

## 本機推論服務

```powershell
py -m venv ml\.venv
ml\.venv\Scripts\python.exe -m pip install -r ml\requirements.txt
$env:STOOL_MODEL_PATH='D:\path\to\model.onnx'
$env:STOOL_MODEL_VERSION='stool-presence-v1'
$env:STOOL_SERVICE_TOKEN='replace-with-a-long-random-secret'
ml\.venv\Scripts\python.exe -m uvicorn ml.service.app:app --host 127.0.0.1 --port 8000
```

目前部署未設定 presence threshold。推論服務保留安全的 `result_code=uncertain`，並在原始回應提供二分類 `candidate_code`；資料庫依原型政策讓 `present` 進成功佔位頁，`absent`／`uncertain` 進人工審核。正式版應在完成校準後改用有版本的門檻政策。

## Google Cloud Run 部署

- 服務：`smart-pet-life-stool-inference`
- Region：`asia-east1`
- 模型：`stool-presence-mobilenet-v2-reviewed-20260826-experimental`
- 模型類型：`mobilenet_binary_v1`
- 共用輸入 ROI：`stool-roi-768-square-v1`，`768×768`
- 模型前處理：`stool-roi-768-to-imagenet-224-v1`
- 路由：`prototype_present_candidate_to_placeholder_v1`

Cloud Run 以 Google Secret Manager 的 `stool-inference-token` 注入 `STOOL_SERVICE_TOKEN`。推論端點雖可由網際網路到達，但未帶正確 `X-Service-Token` 時必須回傳 HTTP `401`。

新版 App 的 `768×768` 輸入會記錄為 `stool-roi-768-to-imagenet-224-v1`，與 reviewed training release 的模型可見 ROI 相同；該 release 的母圖衍生血緣仍保留為 `stool-capture-crop-v1`，不可混淆。為避免 App 分階段更新時讓舊工作直接失敗，非 `768×768` 舊版輸入暫時仍可推論，但會明確記錄為 `legacy-full-image-imagenet-resize-224-v1`，不可混入新版模型評估或訓練資料。

## Supabase 部署

部署前先啟動 Docker 並驗證 migration：

```powershell
npx.cmd supabase start
npx.cmd supabase db lint --local --level warning
npx.cmd supabase db reset --local
```

確認後才連結 staging 專案、套用資料庫、設定 secrets 與部署 Function：

```powershell
npx.cmd supabase link --project-ref YOUR_TEST_PROJECT_REF
npx.cmd supabase db push
npx.cmd supabase secrets set STOOL_INFERENCE_URL=https://YOUR_SERVICE STOOL_INFERENCE_TOKEN=YOUR_SECRET
npx.cmd supabase functions deploy analyze-stool-image
```

正式環境的 secrets 也可在 Supabase Dashboard → Edge Functions → Secrets 設定。`STOOL_INFERENCE_TOKEN` 必須與 Google Secret Manager 的 `stool-inference-token` 相同；真正值不得寫入文件、Git、Expo 公開環境變數或 App bundle。

部署後先驗證無權限寵物不可建立工作、bucket 不可公開讀取、一般使用者不能讀 private schema、`present` 候選不建立人工工作並顯示成功佔位頁，以及 `absent`／`uncertain` 候選進人工佇列。未完成校準前不得把原始分數描述為機率或正式門檻。

## 面試展示順序

1. 開訓練終端機與 HTML/TensorBoard，說明 synthetic smoke 與 real-data evaluation 的差異。
2. 用 App 即時拍攝，展示上傳、分析、`present` 成功佔位頁，以及 `absent`／`uncertain` 等待人工的真實狀態。
3. 展示 model output 與 human annotation 分離，以及目前 candidate 路由仍屬未校準原型政策。
4. 說明下一階段才會做便便外觀狀態，而且不會被描述成獸醫診斷。
