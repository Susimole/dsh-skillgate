#!/usr/bin/env python3
"""冻结回放集：从真实语料里按哈希抽一批，冻结下来当回归基准。

抽出来就不再变——否则每次改词表都能「顺手」把样本换掉，回放分数就没意义了。

用法：
    python tools/holdout.py            # 没有就建，有就什么都不做
    python tools/holdout.py --force    # 重建（会丢掉旧基准，慎用）

产物：tools/holdout.jsonl（只读基准，别手改）
"""
import json
import os
import sys
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'holdout.jsonl')
SEED = 'skillgate-2026-10-30'
TAKE_EVERY = 4  # 大约 25%

sys.path.insert(0, HERE)
import induce  # noqa: E402  复用抽人话那套逻辑


def keep(text):
    digest = hashlib.sha256((SEED + text).encode('utf-8')).hexdigest()
    return int(digest[:8], 16) % TAKE_EVERY == 0


def main():
    force = '--force' in sys.argv
    if os.path.exists(OUT) and not force:
        count = sum(1 for _ in open(OUT, encoding='utf-8'))
        print(f'回放集已存在（{count} 条），不重建。要重建加 --force。')
        return

    messages = induce.collect()
    picked = []
    seen = set()
    for session_id, _when, text in messages:
        if not keep(text):
            continue
        if text in seen:  # 同一句话只留一条，避免重复计分
            continue
        seen.add(text)
        picked.append({'text': text, 'session': session_id})

    with open(OUT, 'w', encoding='utf-8') as f:
        for item in picked:
            f.write(json.dumps(item, ensure_ascii=False) + '\n')
    print(f'冻结 {len(picked)} 条（源 {len(messages)} 条人话）→ {OUT}')


if __name__ == '__main__':
    main()
