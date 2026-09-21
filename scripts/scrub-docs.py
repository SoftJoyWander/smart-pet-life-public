#!/usr/bin/env python3
"""把設計文件裡「可以照著實作」的協尋規格移除，保留高層次描述。

為什麼要分成兩種處理：
  一段散文說「這個專案有協尋功能、用私有 schema 擋住答案」，別人讀完做不出東西，
  但那是履歷上最有價值的部分，該留。一份列出欄位、RPC 名稱、題數、失效時間與
  重試上限的規格，等於把剛才從程式碼裡移除的東西再交出去一次，該拿掉。

為什麼用標題與關鍵字比對而不是行號：
  私有 repo 的文件會一直長，寫死行號的話下次同步就會砍錯地方。這裡的每個操作
  都會檢查目標真的存在，找不到就直接中斷，讓問題在同步時就浮現。

由 scripts/sync-showcase.sh 在複製完文件後呼叫。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / 'docs'


def fail(message: str) -> None:
    print(f'文件清理失敗：{message}', file=sys.stderr)
    raise SystemExit(1)


def drop_sections(filename: str, titles: list[str], level: str = '## ') -> None:
    """移除指定標題的整個章節，範圍到下一個同層級標題為止。"""
    path = DOCS / filename
    lines = path.read_text(encoding='utf-8').split('\n')
    out, i, removed = [], 0, []
    while i < len(lines):
        if lines[i].startswith(level) and any(t in lines[i] for t in titles):
            removed.append(lines[i].strip())
            i += 1
            while i < len(lines) and not lines[i].startswith(level):
                i += 1
            continue
        out.append(lines[i])
        i += 1
    if len(removed) != len(titles):
        fail(f'{filename} 預期移除 {len(titles)} 個章節，實際 {len(removed)} 個：{titles}')
    path.write_text('\n'.join(out), encoding='utf-8')
    for title in removed:
        print(f'  {filename}：移除章節「{title}」')


def drop_lines(filename: str, pattern: str) -> None:
    """移除符合樣式的行，用在條列式的檔案清單與資料表清單。"""
    path = DOCS / filename
    lines = path.read_text(encoding='utf-8').split('\n')
    keep = [line for line in lines if not re.search(pattern, line)]
    if len(keep) == len(lines):
        fail(f'{filename} 找不到符合 /{pattern}/ 的行，樣式可能已失效')
    path.write_text('\n'.join(keep), encoding='utf-8')
    print(f'  {filename}：移除 {len(lines) - len(keep)} 行條列')


def replace_once(filename: str, old: str, new: str) -> None:
    """精確替換，且要求剛好出現一次。"""
    path = DOCS / filename
    text = path.read_text(encoding='utf-8')
    if text.count(old) != 1:
        fail(f'{filename} 預期 1 處符合，實際 {text.count(old)} 處：{old[:60]}')
    path.write_text(text.replace(old, new), encoding='utf-8')
    print(f'  {filename}：替換 1 處')


def main() -> int:
    print('[文件] 移除欄位級與機制級的協尋規格')

    # JSON_DEFINITION.md 的協尋章節是完整的欄位契約，照著它就能重建資料表。
    drop_sections('JSON_DEFINITION.md', ['犬隻協尋資料契約'])

    # DATABASE.md 這兩節列出函式名稱、門檻閘門與 RLS 判斷，屬於實作規格。
    drop_sections('DATABASE.md', ['已部署的寵物協尋資料', '已部署的防冒領驗證資料'])
    # 條列的 migration 清單與資料表說明也會洩漏 schema 形狀。
    drop_lines('DATABASE.md', r'pet_search|pet_match|pet-search-media|petSearchData')

    # ARCHITECTURE.md：拿掉兩段機制級說明，樹狀圖裡「有這個模組」的一行保留。
    path = DOCS / 'ARCHITECTURE.md'
    text = path.read_text(encoding='utf-8')
    kept = [
        line for line in text.split('\n')
        if not line.startswith(('協尋防冒領驗證採', '協尋人工線索以', '犬隻 Re-ID 採 shadow-only'))
    ]
    text = '\n'.join(kept)
    for fragment in (
        '  ├─ private.pet_search_verification_*（已部署）\n',
        '  └─ private.pet_search_ai_* + pgvector（不對 App 開放）\n',
    ):
        if fragment not in text:
            fail(f'ARCHITECTURE.md 找不到預期片段：{fragment.strip()}')
        text = text.replace(fragment, '')
    path.write_text(text, encoding='utf-8')
    print('  ARCHITECTURE.md：移除機制級說明')

    # PRODUCT_SPEC.md 的 5.10 第 11–15 點把防冒領驗證講到可以照著實作
    #（題數、混淆選項、失效時間、重試上限、線索關聯的交易設計），整段換成一句話。
    replace_once(
        'PRODUCT_SPEC.md',
        '11. 失主可選填 3 題未公開的結構化隱藏特徵；只有從特定走失案件進入、並聲明犬隻目前在身邊的回報者，才會在目擊發布後進入一次性驗證。',
        '11. 案件另有一套防冒領驗證與人工線索機制，用於處理「有人聲稱犬隻在自己身邊」的情況。'
        '其設計細節屬於非公開範圍，未收錄於這份展示用文件。',
    )
    for line_start in (
        '12. 驗證題含「無法判斷」',
        '13. 驗證只顯示粗略一致性',
        '14. 從特定走失案件建立的目擊回報',
        '15. 失主在首頁訊息與「人工線索」分頁',
    ):
        path = DOCS / 'PRODUCT_SPEC.md'
        lines = path.read_text(encoding='utf-8').split('\n')
        keep = [line for line in lines if not line.startswith(line_start)]
        if len(keep) == len(lines):
            fail(f'PRODUCT_SPEC.md 找不到開頭為「{line_start}」的行')
        path.write_text('\n'.join(keep), encoding='utf-8')
    print('  PRODUCT_SPEC.md：5.10 的防冒領細節收斂為一句話')

    # 最後確認沒有留下欄位級或 RPC 級的痕跡。
    leaked = []
    for doc in sorted(DOCS.glob('*.md')):
        for number, line in enumerate(doc.read_text(encoding='utf-8').split('\n'), 1):
            if re.search(r'pet_search_|pet_match_|private\.pet_search', line):
                leaked.append(f'{doc.name}:{number}: {line.strip()[:80]}')
    if leaked:
        fail('文件仍殘留資料表或函式名稱：\n' + '\n'.join(leaked))

    print('[文件] 清理完成，未殘留資料表或函式名稱')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
