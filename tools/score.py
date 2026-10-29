#!/usr/bin/env python3
"""回归打分 + 版本快照。

1. 拿冻结回放集跑一遍当前词表（调 tools/replay.mjs --json）
2. 让模型给每条消息标「本该触发哪个桶」，和词表的实际判断比对
3. 把分数连同这一版词表/分档存进 ~/.dsh/mode/versions/，保留最近 6 版

用法：
    python tools/score.py            # 打分 + 存快照
    python tools/score.py --no-save  # 只打分，不存快照
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
HOLDOUT = os.path.join(HERE, 'holdout.jsonl')
LABELS = os.path.join(HERE, 'holdout-labels.json')
REPORT = os.path.join(HERE, 'score-report.txt')
MODE_DIR = os.path.join(os.path.expanduser('~'), '.dsh', 'mode')
VERSIONS = os.path.join(MODE_DIR, 'versions')
CONFIG = os.path.join(MODE_DIR, 'inducer.json')

BUCKETS = ['enterWork', 'enterDeliver', 'exit', 'veto', 'hold']
RULE_BUCKET = {  # 词表桶 -> 日志里记的桶名
    'enter-work': 'enterWork',
    'enter-deliver': 'enterDeliver',
    'exit': 'exit',
    'veto': 'veto',
    'hold': 'hold',
}

SYSTEM = """你会看到一批用户的真实消息。一个插件根据消息里的字面词决定是否给 agent 换档，档位有三档：日常 / 工作 / 交付。

请给每条消息标一个「本该触发的桶」，没有就标 null：
- enterWork：这条在让 agent 开始干活（排错、写代码、查资料、动手改）
- enterDeliver：这条在要成品（表格、图、文档、交接文件、导出）
- exit：这条在收工、回闲聊、或者人要走开
- veto：这条在说别动手、只讨论、先别改
- hold：这条在说接着干、继续
- null：普通闲聊、提问、讨论、举例、粘贴内容——不需要换档

注意：消息里可能「提到」某些词但并不是在派活（比如举例、复述、讨论规则）。这类标 null。
按输入顺序，给每条消息一个桶。输出一个数组，长度必须和输入条数完全一致，只输出 JSON：
{"buckets":["enterWork","null","exit"]}"""


def replay():
    payload = [{'text': row['text'], 'at': '10-30 12:00'}
               for row in (json.loads(line) for line in open(HOLDOUT, encoding='utf-8') if line.strip())]
    tmp = os.path.join(HERE, 'holdout-in.json')
    json.dump(payload, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False)
    out = subprocess.run(
        ['node', 'tools/replay.mjs', tmp, '--json'],
        cwd=REPO, capture_output=True, text=True, encoding='utf-8',
    )
    if out.returncode != 0:
        raise SystemExit('回放失败：' + (out.stderr or '')[:400])
    data = json.loads(out.stdout)
    # 日志是异步写的，按「这条之后新增的日志行」归属会串位；改成按原文前缀对齐。
    rules = data.get('rules') or []
    per_message = []
    for message in data.get('perMessage') or []:
        text = ''.join(message['text'].split())
        hit = None
        for row in rules:
            fragment = ''.join(str(row['text']).split())
            if fragment and (text.startswith(fragment[:40]) or fragment.startswith(text[:40])):
                hit = row
                break
        per_message.append({'text': message['text'], 'bucket': hit['bucket'] if hit else None,
                            'rule': hit['rule'] if hit else None})
    return per_message


def ask_chunk(cfg, chunk, offset):
    lines = [f'{offset + i}. {m["text"]}' for i, m in enumerate(chunk)]
    body = {
        'model': cfg.get('model') or 'deepseek-flash',
        'messages': [
            {'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': chr(10).join(lines)},
        ],
        'temperature': 0,
        'max_tokens': 8000,
    }
    request = urllib.request.Request(
        cfg['endpoint'],
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f"Bearer {cfg['apiKey']}"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode('utf-8'))['choices'][0]['message']['content']


def label(messages):
    """标签冻结在 holdout-labels.json 里：标一次，之后所有版本都拿它比。"""
    if os.path.exists(LABELS):
        raw = json.load(open(LABELS, encoding='utf-8'))
        return {int(k): v for k, v in raw.items()}
    cfg = json.load(open(CONFIG, encoding='utf-8'))
    labels = {}
    bad = 0
    step = 10
    for offset in range(0, len(messages), step):
        chunk = messages[offset:offset + step]
        text = ''
        for _attempt in range(4):
            text = ask_chunk(cfg, chunk, offset)
            start, end = text.find('{'), text.rfind('}')
            try:
                data = json.loads(text[start:end + 1])
                break
            except Exception:
                data = None
        if not data:
            bad += len(chunk)
            continue
        buckets = data.get('buckets')
        if not isinstance(buckets, list) or len(buckets) != len(chunk):
            bad += len(chunk)
            continue
        for i, bucket in enumerate(buckets):
            labels[offset + i] = None if bucket in (None, 'null') else bucket
    if bad:
        print(f'标签校验：{bad} 条没回来（这次先空着，不影响已冻结的部分）')
    json.dump({str(k): v for k, v in labels.items()}, open(LABELS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'标签已冻结：{LABELS}（{len(labels)} 条）')
    return labels


def archive(score, mismatches, counts):
    os.makedirs(VERSIONS, exist_ok=True)
    files = sorted(os.listdir(VERSIONS))
    previous = None
    if files:
        try:
            previous = json.load(open(os.path.join(VERSIONS, files[-1]), encoding='utf-8'))
        except Exception:
            previous = None

    lexicon = json.load(open(os.path.join(MODE_DIR, 'lexicon.json'), encoding='utf-8'))
    tiers = json.load(open(os.path.join(MODE_DIR, 'tiers.json'), encoding='utf-8'))
    diff = {'added': [], 'removed': []}
    if previous:
        for key in BUCKETS:
            old = set((previous.get('lexicon') or {}).get(key) or [])
            new = set(lexicon.get(key) or [])
            diff['added'] += [f'{key}:{w}' for w in sorted(new - old)]
            diff['removed'] += [f'{key}:{w}' for w in sorted(old - new)]

    stamp = time.strftime('%Y%m%d-%H%M%S')
    snapshot = {
        'savedAt': time.strftime('%Y-%m-%d %H:%M'),
        'score': score,
        'counts': counts,
        'holdoutSize': counts.get('holdout'),
        'mismatches': mismatches[:20],
        'diff': diff if previous else None,
        'lexicon': {k: lexicon.get(k) or [] for k in BUCKETS},
        'tiers': {k: tiers.get(k) or [] for k in ('work', 'deliver', 'daily')},
    }
    path = os.path.join(VERSIONS, f'{stamp}.json')
    json.dump(snapshot, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    files = sorted(os.listdir(VERSIONS))
    for stale in files[:-6]:
        os.remove(os.path.join(VERSIONS, stale))
    return path, diff


def main():
    messages = replay()
    truth = label(messages)

    tally = {'hit_right': 0, 'hit_wrong': 0, 'missed': 0, 'quiet_right': 0}
    mismatches = []
    for index, message in enumerate(messages):
        actual = RULE_BUCKET.get(message.get('bucket') or '', None)
        if index not in truth:
            continue
        expected = truth.get(index)
        if actual and expected:
            if actual == expected:
                tally['hit_right'] += 1
            else:
                tally['hit_wrong'] += 1
                mismatches.append({'type': 'wrong', 'text': message['text'][:50], 'rule': message.get('rule'), 'got': actual, 'want': expected})
        elif actual and not expected:
            tally['hit_wrong'] += 1
            mismatches.append({'type': 'false-positive', 'text': message['text'][:50], 'rule': message.get('rule'), 'got': actual, 'want': None})
        elif not actual and expected:
            tally['missed'] += 1
            mismatches.append({'type': 'miss', 'text': message['text'][:50], 'got': None, 'want': expected})
        else:
            tally['quiet_right'] += 1

    total = len(messages)
    right = tally['hit_right'] + tally['quiet_right']
    score = round(right / total, 3) if total else 0
    # 精确率看「开口的时候对不对」，召回看「该开口的时候开没开」——单看一致率会冤枉一个偏保守的词表
    precision = round(tally['hit_right'] / (tally['hit_right'] + tally['hit_wrong']), 3)         if (tally['hit_right'] + tally['hit_wrong']) else None
    recall = round(tally['hit_right'] / (tally['hit_right'] + tally['missed']), 3)         if (tally['hit_right'] + tally['missed']) else None
    counts = {'holdout': total, **tally, 'accuracy': score, 'precision': precision, 'recall': recall}

    lines = [f'回放集 {total} 条 · 一致率 {score} · 精确率 {precision} · 召回 {recall}', '', '口径：', '  该切且切对 = hit_right；不该切且没切 = quiet_right',
             '  不该切却切了 = false-positive；该切没切 = miss', '', f'{tally}', '']
    if mismatches:
        lines.append('不一致：')
        for item in mismatches:
            lines.append(f"  {item['type']:<15}{item['text']}  got={item['got']} want={item['want']}")
    text = '\n'.join(lines)
    open(REPORT, 'w', encoding='utf-8').write(text)
    print(text)

    if '--no-save' not in sys.argv:
        path, diff = archive(score, mismatches, counts)
        print(f'\n快照：{path}')
        if diff and (diff['added'] or diff['removed']):
            print('与上一版相比：', ', '.join(diff['added'] + diff['removed']) or '无变化')


if __name__ == '__main__':
    main()
