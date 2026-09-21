#!/usr/bin/env bash
# 這份腳本與 Smart-Pet-Life-tools/scripts/scan-secrets.sh 是同一份的副本。
# 兩個 repository 刻意互不相依，因此以複製維護；修改其中一份時請同步另一份。
# Heuristic credential scan over git-tracked files only.
#
# This is a cheap, auditable backstop, not a replacement for proper secret
# management. It matches common credential shapes; it cannot prove a repository
# is clean. Untracked and ignored files (mobile/.env, supabase/.temp) are not
# scanned, because CI never sees them.

set -uo pipefail

hits=0

report() {
  printf '\n=== %s ===\n' "$1"
  shift
  local pattern="$1"
  local found
  found=$(git ls-files -z \
    | grep -zZv -E '^(mobile/(node_modules|dist-[a-z-]+)/|.*\.lock$|.*package-lock\.json$)' \
    | xargs -0 grep -nIE -e "$pattern" 2>/dev/null \
    | grep -vE '(YOUR_|EXAMPLE|example|placeholder|<[A-Za-z_]+>)' || true)
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    hits=$((hits + $(printf '%s\n' "$found" | wc -l | tr -d ' ')))
  else
    echo "無"
  fi
}

report "私鑰區塊"            '-----BEGIN [A-Z ]*PRIVATE KEY-----'
report "JWT（Supabase 金鑰形狀）" 'eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}'
report "OpenAI 樣式金鑰"      'sk-[A-Za-z0-9]{20,}'
report "GitHub token"        'gh[pousr]_[A-Za-z0-9]{30,}'
report "AWS access key"      'AKIA[0-9A-Z]{16}'
report "Google API key"      'AIza[0-9A-Za-z_-]{35}'
report "Supabase secret key" 'sb_secret_[A-Za-z0-9_-]{20,}'
report "帶值的敏感變數"       '(SERVICE_ROLE_KEY|INFERENCE_TOKEN|WORKER_TOKEN|DB_PASSWORD|PASSWORD)[[:space:]]*[=:][[:space:]]*["'\'']?[A-Za-z0-9/+_-]{16,}'

printf '\n命中 %s 處\n' "$hits"
if [ "$hits" -gt 0 ]; then
  echo "請人工確認上列命中是否為真實憑證。誤判請調整 scripts/scan-secrets.sh 的排除規則，不要直接關閉檢查。"
  exit 1
fi
echo "秘密掃描通過"
