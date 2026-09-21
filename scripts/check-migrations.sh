#!/usr/bin/env bash
# Offline migration hygiene checks. Runs in CI and locally with no database
# access and no credentials.
#
# This cannot detect drift between the local directory and the remote migration
# history table. That check needs a Supabase access token, which is account
# scoped, so it is deliberately kept out of CI. Run `supabase migration list`
# and `supabase db push --dry-run` before every deployment instead.

set -uo pipefail

DIR="supabase/migrations"
fail=0
warn=0

say_fail() { printf 'FAIL  %s\n' "$1"; fail=$((fail + 1)); }
say_warn() { printf 'WARN  %s\n' "$1"; warn=$((warn + 1)); }

if [ ! -d "$DIR" ]; then
  say_fail "找不到 $DIR"
  exit 1
fi

count=$(find "$DIR" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')
printf 'migration 檔案: %s\n\n' "$count"
[ "$count" -eq 0 ] && say_fail "$DIR 裡沒有任何 .sql"

# 1. 檔名格式。版本號 12 或 14 位數字，名稱只用小寫、數字與底線。
for path in "$DIR"/*.sql; do
  name=$(basename "$path")
  if ! printf '%s' "$name" | grep -qE '^[0-9]{12,14}_[a-z0-9_]+\.sql$'; then
    say_fail "檔名格式不符: $name"
  fi
  [ -s "$path" ] || say_fail "檔案是空的: $name"
done

# 2. 版本號不可重複。同版本號會讓遠端帳本無法對應。
dupes=$(basename -a "$DIR"/*.sql | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -d)
if [ -n "$dupes" ]; then
  while IFS= read -r v; do say_fail "版本號重複: $v"; done <<< "$dupes"
fi

# 3. 破壞性語句。專案要求可加可逆的 schema 演進，不得刪除健康歷史。
#    drop trigger/constraint/policy/index 是常見且合理的用法，不在此列。
#    private schema 的 delete 多為佇列、租約等營運狀態清理，也不在此列；
#    只針對會影響使用者資料的 public schema 刪除與整表破壞發出警告。
for path in "$DIR"/*.sql; do
  hits=$(grep -inE '^[[:space:]]*(drop[[:space:]]+(table|schema|type)|truncate|delete[[:space:]]+from[[:space:]]+public\.)' "$path" || true)
  if [ -n "$hits" ]; then
    while IFS= read -r line; do
      say_warn "破壞性語句 $(basename "$path"):${line%%:*}  ${line#*:}"
    done <<< "$hits"
  fi
done

# 4. 事後編輯。已套用的 migration 被改寫是帳本與 schema 失聯的主因之一。
if git rev-parse --git-dir >/dev/null 2>&1; then
  for path in "$DIR"/*.sql; do
    commits=$(git log --format=%H -- "$path" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$commits" -gt 1 ]; then
      say_warn "被修改過 $commits 次: $(basename "$path")  migration 應視為僅可新增"
    fi
  done
else
  say_warn "不在 git 工作區，略過事後編輯檢查"
fi

printf '\n錯誤 %s 項，警告 %s 項\n' "$fail" "$warn"
[ "$fail" -eq 0 ] || exit 1
echo "migration 檢查通過"
