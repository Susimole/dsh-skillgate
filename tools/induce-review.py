#!/usr/bin/env python3
"""归纳器的模型层：让模型给候选短语判「能不能当触发词」。

频次只能告诉你「出现得多」，分不清 `你试试` 和 `顺便`。这一步是让模型看例句、
判断这句话是不是在派活 / 收工 / 拦一下 / 接着干，并给出桶和置信度。

用法：
    python tools/induce-review.py            # 判 tools/induce-candidates.json
    python tools/induce-review.py --dry      # 只看提示词，不花钱

配置在 ~/.dsh/mode/inducer.json（endpoint / model / apiKey），不进仓库。
产物：tools/induce-review.txt、tools/induce-review.json
"""
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CANDIDATES = os.path.join(HERE, 'induce-candidates.json')
OUT_TXT = os.path.join(HERE, 'induce-review.txt')
OUT_JSON = os.path.join(HERE, 'induce-review.json')
CONFIG = os.path.join(os.path.expanduser('~'), '.dsh', 'mode', 'inducer.json')

SYSTEM = """你在帮一个插件筛词表。这个插件盯着用户发来的消息，按里面出现的词判断该把 agent 切到哪一档：

- enterWork：开始干活（排错、写代码、查资料、动手改）
- enterDeliver：要产出成品（表格、图、文档、交接文件、导出）
- exit：回闲聊（收工、晚安、只聊天、要走了）
- veto：别动手（先别改、只讨论、问现状）
- hold：接着干（继续、开始吧）
- null：不该进词表

候选短语是从真实聊天记录里按频次挖出来的，读的是**字面子串匹配**——只要消息里出现这几个字就会触发，
不管上下文。所以你要判断的是：这几个字放进消息里，会不会经常出现在它不该触发的语境。

给出结论时想三件事：
1. 它是不是稳定的信号，还是随口一说的口头禅、填充词、语气词？
2. 它会不会在别的语境里出现（比如「你看看这个猫」里的「你看看」）？
3. 它是不是只在测试/调试场景里出现（比如反复让模型「解释一下什么是光合作用」）？

宁可漏掉，不要误伤。只输出一个 JSON 对象，不要解释、不要代码块：
{"items":[{"token":"短语","bucket":"enterWork|enterDeliver|exit|veto|hold|null","confidence":0.0,"reason":"不超过 20 字"}]}"""


def load_config():
    with open(CONFIG, encoding='utf-8') as f:
        cfg = json.load(f)
    if not cfg.get('endpoint') or not cfg.get('apiKey'):
        raise SystemExit(f'{CONFIG} 里缺 endpoint 或 apiKey')
    return cfg


def ask(cfg, candidates, examples):
    lines = []
    for item in candidates:
        lines.append(f"- {item['token']}（出现 {item['count']} 次 / {item['sessions']} 个会话）例句：{item['example']}")
    body = {
        'model': cfg.get('model') or 'deepseek-flash',
        'messages': [
            {'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': '\n'.join(lines)},
        ],
        'temperature': cfg.get('temperature', 0),
        'max_tokens': 8000,
    }
    request = urllib.request.Request(
        cfg['endpoint'],
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f"Bearer {cfg['apiKey']}"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.loads(response.read().decode('utf-8'))
    return payload['choices'][0]['message']['content']


def parse(text):
    match = re.search(r'\{.*\}', text, re.S)
    if not match:
        raise SystemExit('模型没吐出 JSON：' + text[:200])
    data = json.loads(match.group(0))
    return data.get('items') or []


def main():
    dry = '--dry' in sys.argv
    candidates = json.load(open(CANDIDATES, encoding='utf-8'))
    if not candidates:
        raise SystemExit('没有候选，先跑 tools/induce.py')
    cfg = load_config()
    print(f'候选 {len(candidates)} 条 · 模型 {cfg.get("model")} · {"干跑" if dry else "调接口"}')
    if dry:
        print(SYSTEM)
        for item in candidates[:5]:
            print('-', item['token'], item['example'])
        return

    raw = ask(cfg, candidates, None).strip()
    if not raw:
        raise SystemExit('模型返回空内容（可能 max_tokens 被推理吃光了）')
    open(os.path.join(HERE, 'induce-raw.txt'), 'w', encoding='utf-8').write(raw)
    items = parse(raw)
    by_token = {item.get('token'): item for item in items}

    rows = []
    for candidate in candidates:
        verdict = by_token.get(candidate['token']) or {}
        rows.append({
            'token': candidate['token'],
            'count': candidate['count'],
            'sessions': candidate['sessions'],
            'example': candidate['example'],
            'bucket': verdict.get('bucket'),
            'confidence': verdict.get('confidence', 0),
            'reason': verdict.get('reason', '模型没判'),
        })

    usable = [r for r in rows if r['bucket'] and r['bucket'] != 'null']
    usable.sort(key=lambda r: -(r['confidence'] or 0))

    lines = [f'候选 {len(rows)} 条 · 模型认为能用 {len(usable)} 条', '']
    lines.append(f'{"短语":<14}{"桶":<12}{"把握":>5}   理由')
    for row in rows:
        bucket = row['bucket'] or 'null'
        lines.append(f'{row["token"]:<14}{bucket:<12}{row["confidence"]:>5}   {row["reason"]}')
    text = '\n'.join(lines)
    open(OUT_TXT, 'w', encoding='utf-8').write(text)
    json.dump(rows, open(OUT_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(text)


if __name__ == '__main__':
    main()
