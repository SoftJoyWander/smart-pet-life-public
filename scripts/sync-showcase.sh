#!/usr/bin/env bash
#
# 把兩個私有 repo 裡「可以公開」的檔案同步到這個公開展示 repo。
#
# 為什麼用白名單而不是黑名單：
#   黑名單的問題是「忘記排除」會直接變成洩漏，而且一旦 commit 就永久留在歷史裡。
#   白名單相反，忘記加只會少一個檔案，發現了再補即可。風險方向差很多，所以這裡
#   一律只複製明確列出的路徑。
#
# 三層分類（詳見 docs/WHAT_IS_OMITTED.md）：
#   Tier A 原始碼照搬   — 照護平台、共養權限、離線同步、智慧桶韌體
#   Tier B 介面保留換實作 — AI 模組保留介面與評測，實作換成公開 baseline
#   Tier C 完全不放     — 模型權重、訓練配方、私有資料集、內部聊天記錄、協尋產品層
#
# 用法：bash scripts/sync-showcase.sh

set -euo pipefail

# --- 來源與目的地 -----------------------------------------------------------
# 兩個私有 repo 的位置。放在這裡而不是寫死在各處，換機器只要改這兩行。
readonly APP_REPO="${APP_REPO:-$HOME/Projects/smart-pet-life}"
readonly TOOLS_REPO="${TOOLS_REPO:-$HOME/Projects/Smart-Pet-Life-tools}"
readonly DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for repo in "$APP_REPO" "$TOOLS_REPO"; do
  [ -d "$repo/.git" ] || { echo "找不到來源 repo：$repo" >&2; exit 1; }
done

echo "來源 App  ：$APP_REPO"
echo "來源 Tools：$TOOLS_REPO"
echo "目的地    ：$DEST"
echo

# --- 小工具 -----------------------------------------------------------------
# copy_file <來源 repo> <相對路徑> [目的地相對路徑]
# 只複製單一檔案，來源不存在就直接報錯停止：白名單裡的檔案消失通常代表私有 repo
# 改過結構，靜靜跳過會讓公開 repo 悄悄變得不完整。
copy_file() {
  local src_repo="$1" rel="$2" dest_rel="${3:-$2}"
  local src="$src_repo/$rel" dst="$DEST/$dest_rel"
  [ -f "$src" ] || { echo "來源檔案不存在：$src" >&2; exit 1; }
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

# copy_dir <來源 repo> <相對目錄> [目的地相對目錄]
# 整個目錄複製，但只帶 git 有追蹤的檔案。這一點很關鍵：未追蹤的檔案往往正是
# 模型權重、資料集、.env 這類不該外流的東西，用 git ls-files 過濾等於免費多一道防線。
copy_dir() {
  local src_repo="$1" rel="$2" dest_rel="${3:-$2}"
  local file
  while IFS= read -r file; do
    copy_file "$src_repo" "$file" "${file/#$rel/$dest_rel}"
  done < <(cd "$src_repo" && git ls-files "$rel")
}

# =============================================================================
# Tier A：原始碼照搬
# =============================================================================

echo "[Tier A] 手機 App"
# App 本體與所有共用程式碼。node_modules、dist-*、expo-*.log 不在 git 追蹤或已被
# 下面的排除處理掉，不會跟著進來。
copy_file "$APP_REPO" mobile/App.tsx
copy_file "$APP_REPO" mobile/index.ts
copy_file "$APP_REPO" mobile/package.json
# package-lock.json 一起帶：CI 用 npm ci，而且鎖定版本是可重現建置的前提。
copy_file "$APP_REPO" mobile/package-lock.json
copy_file "$APP_REPO" mobile/tsconfig.json
copy_file "$APP_REPO" mobile/app.json
copy_file "$APP_REPO" mobile/.env.example
copy_dir  "$APP_REPO" mobile/src
copy_dir  "$APP_REPO" mobile/assets

# 協尋產品層不進公開 repo（Tier C）。上面的 copy_dir 會把整個 src 帶進來，
# 這裡再移除協尋相關的畫面與資料層。
rm -rf "$DEST/mobile/src/features/pet-search"
rm -f  "$DEST/mobile/src/services/petSearchData.ts"

# 協尋不只是獨立的檔案，它還織進 App.tsx（分頁、訊息中心、Realtime 訂閱）、
# database.ts（型別與 RPC 定義）與 featureFlags.ts。這些檔案在私有 repo 裡會持續
# 演進，所以不能在公開 repo 手工改一次了事——改動用 patch 表達，每次同步重新套用。
#
# patch 套用失敗代表私有 repo 的這幾個檔案改動到與協尋相鄰的位置，需要重新產生：
#   1. 先把私有 repo 的原始檔複製過來
#   2. 手工移除協尋相關片段，跑 npx tsc --noEmit 確認編譯過
#   3. diff -u 原始檔與修改後的檔案，覆蓋 patches/remove-pet-search.patch
echo "[Tier C] 套用協尋移除 patch"
(cd "$DEST" && git apply --verbose patches/remove-pet-search.patch) || {
  echo "協尋移除 patch 套用失敗，請依上面註解重新產生後再跑一次。" >&2
  exit 1
}

echo "[Tier A] 資料庫 schema 與權限政策"
# 這是整份展示裡最能說明後端設計能力的部分：RLS、共養授權、原子性 RPC。
# 但協尋 AI 專屬的 migration 屬於產品差異化，不放（下面會濾掉）。
while IFS= read -r file; do
  case "$file" in
    *pet_search*) continue ;;   # 協尋 AI 產品層，Tier C
  esac
  copy_file "$APP_REPO" "$file"
done < <(cd "$APP_REPO" && git ls-files supabase/migrations)

echo "[Tier A] Edge Functions"
# 只放便便影像分析。另外兩支都屬於協尋：process-pet-search-ai 是比對流程的排程端，
# check-dog-presence 是協尋照片上傳時的前置把關，兩支都讀寫 pet_search_* 資料表。
copy_dir "$APP_REPO" supabase/functions/analyze-stool-image

echo "[Tier A] 智慧桶韌體"
# ESP32 端的 BLE 簽章驗證、安全儲存與自我測試。需要實際硬體才有意義，
# 對外公開的風險低，但很能說明嵌入式與安全設計的能力。
copy_dir "$APP_REPO" firmware/smart-bin

echo "[Tier A] 便便辨識的推論服務契約"
# 只帶服務層與它的契約測試：這部分說明「模型怎麼被包成服務、輸入輸出的契約是什麼」，
# 不含模型本身。train.py、smoke_train.py 與訓練設定檔屬於訓練配方，不放；
# deploy/ 底下有打包好的 .zip，也不放。
copy_dir  "$APP_REPO" ml/service
copy_dir  "$APP_REPO" ml/tests
copy_file "$APP_REPO" ml/service-requirements.txt

echo "[Tier A] 檢查腳本"
# ci.yml 在本 repo 手工維護：私有版有 ml 訓練相關的 job 與不同的路徑假設，
# 直接複製過來會指向不存在的檔案。
copy_file "$APP_REPO" scripts/check-migrations.sh
copy_file "$APP_REPO" scripts/scan-secrets.sh

echo "[Tier A] 設計文件"
# 文件描述「做了什麼、為什麼這樣做」，這對閱讀履歷的人價值最高，
# 而且看得懂不等於做得出來，外流風險遠低於可直接執行的程式碼。
# 每日聊天記錄與內部檢查清單不放（Tier C）。
for doc in \
  ARCHITECTURE.md \
  DATABASE.md \
  PRODUCT_SPEC.md \
  JSON_DEFINITION.md \
  OFFLINE_CARE_SYNC.md \
  SMART_BIN_DESIGN.md \
  SMART_BIN_WIRING.md \
  STOOL_AI_MVP.md \
  VETERINARY_COLLABORATION_DESIGN.md \
  BUILD_ANDROID_APK.md
do
  copy_file "$APP_REPO" "docs/$doc"
done
# PET_SEARCH_MVP.md 與 PET_SEARCH_LOCATION_DESIGN.md 是協尋的完整設計文件，
# 含防冒領機制與地點策略，整份不放。

# 上面複製進來的文件裡仍夾帶協尋的欄位契約與機制細節，這一步把它們清掉。
python3 "$DEST/scripts/scrub-docs.py"

# =============================================================================
# Tier B：介面保留、實作換成公開 baseline
# =============================================================================

echo "[Tier B] 犬隻 Re-ID 模組"
# 公開版的範圍刻意縮到「公開資料集處理 + 檢索評測指標 + 推論服務介面」。
# 這三塊足以說明會評估一個檢索模型、會把資料集凍結成可稽核的 release，
# 但沒有任何一項是自己的競爭力來源——換成別人的資料也一樣能跑。
#
# mpdd.py 在這裡的角色是 read_json / sha256_file 等共用工具，以及公開的 MPDD
# 資料集清單稽核；oxford.py 與 segmentation.py 處理的是公開的 Oxford-IIIT Pet。
copy_file "$TOOLS_REPO" pet-search-ai/src/pet_reid_tool/__init__.py     ai/pet-reid/src/pet_reid_tool/__init__.py
copy_file "$TOOLS_REPO" pet-search-ai/src/pet_reid_tool/metrics.py      ai/pet-reid/src/pet_reid_tool/metrics.py
copy_file "$TOOLS_REPO" pet-search-ai/src/pet_reid_tool/mpdd.py         ai/pet-reid/src/pet_reid_tool/mpdd.py
copy_file "$TOOLS_REPO" pet-search-ai/src/pet_reid_tool/oxford.py       ai/pet-reid/src/pet_reid_tool/oxford.py
copy_file "$TOOLS_REPO" pet-search-ai/src/pet_reid_tool/segmentation.py ai/pet-reid/src/pet_reid_tool/segmentation.py
copy_file "$TOOLS_REPO" pet-search-ai/src/pet_reid_tool/preprocess.py   ai/pet-reid/src/pet_reid_tool/preprocess.py
copy_file "$TOOLS_REPO" pet-search-ai/tests/test_pet_reid_metrics.py    ai/pet-reid/tests/test_pet_reid_metrics.py
copy_file "$TOOLS_REPO" pet-search-ai/tests/test_preprocess.py          ai/pet-reid/tests/test_preprocess.py
copy_file "$TOOLS_REPO" pet-search-ai/tests/test_oxford_segmentation.py ai/pet-reid/tests/test_oxford_segmentation.py

# 只帶公開資料集的設定檔。mpdd_reid_baseline_v1.json 含 Re-ID 的訓練超參數，
# 屬於訓練配方的一部分，不放。
copy_file "$TOOLS_REPO" pet-search-ai/configs/oxford_pet_segmentation_v1.json \
                        ai/pet-reid/configs/oxford_pet_segmentation_v1.json

# 以下四個檔案在本 repo 手工維護，不從私有 repo 複製，因為公開版與私有版內容不同：
#   inference.py — 公開版直接用 ImageNet 預訓練權重取特徵；私有版載入自訓
#                  checkpoint 並驗證 model card 與 SHA-256。對外介面完全相同。
#   server.py    — 公開版只保留 Re-ID 端點，拿掉犬隻在場判斷（模型未公開）。
#   cli.py       — 公開版只保留 Oxford 分割相關子指令。
#   pyproject.toml
#
# 完全不放：train.py（Re-ID 訓練配方）、field_eval.py（台灣實地評測流程）、
#           dog_presence.py、colab/（訓練 notebook）、outputs/（模型權重）。

echo
echo "同步完成。接著請確認："
echo "  1. bash scripts/scan-secrets.sh    # 敏感字串掃描"
echo "  2. git status                       # 確認沒有非預期的新檔案"
