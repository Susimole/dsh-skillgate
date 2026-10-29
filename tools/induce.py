#!/usr/bin/env python3
"""归纳器的数据层：把会话日志里的「人话」挖出来，找候选短语。

只做统计，不调模型——模型那一层（给候选命名、合并同义词、决定去留）是下一步。

用法：
    python tools/induce.py                # 扫全部会话
    python tools/induce.py --days 30      # 只看最近 30 天
    python tools/induce.py --min-msgs 3   # 候选至少要出现在几个句子里

产物：tools/induce-report.txt（候选表）
"""
import json
import os
import re
import sys
import glob
import datetime
from collections import Counter, defaultdict
from compression import zstd

HOME = os.path.expanduser('~')
SESSIONS = os.path.join(HOME, '.dsh', 'sessions')
HERE = os.path.dirname(os.path.abspath(__file__))
REPORT = os.path.join(HERE, 'induce-report.txt')
CANDIDATES = os.path.join(HERE, 'induce-candidates.json')

MAGIC = b'\x28\xb5\x2f\xfd'

# 这些来源不是人话：插件注入、运行时上下文、时间行、命令回显
IGNORED_KINDS = {'skillgate-tier', 'skillgate-time', 'time-context', 'runtime-context',
                 'skill-catalog', 'skill-invocation', 'tool-jobs', 'model-selection'}


def read_frames(path):
    """session.v4.jsonl.zstd 是多个 zstd 帧首尾相接，逐个解再拼。"""
    raw = open(path, 'rb').read()
    starts = [m.start() for m in re.finditer(re.escape(MAGIC), raw)]
    chunks = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(raw)
        try:
            chunks.append(zstd.decompress(raw[start:end]).decode('utf-8', 'replace'))
        except Exception:
            continue
    return ''.join(chunks)


def human_text(data):
    kind = (data.get('source') or {}).get('kind')
    content = data.get('content') or []
    text = ''.join(c.get('text', '') for c in content if isinstance(c, dict))
    if kind == 'plugin:dsh-onebot':
        # QQ 桥把正文包在 <user_message ...> 里
        if '<user_message' in text:
            text = text.split('>', 1)[-1].split('</user_message>')[0]
        return text.strip()
    if kind == 'user':
        if text.startswith('Current runtime context') or text.startswith('Time sampled while preparing'):
            return ''
        if '<available_skills>' in text:
            return ''
        return text.strip()
    return ''


# 粘贴进来的文档不是「人话」：带标题、带列表、太长的一律丢掉
PASTED = re.compile(r'##|\*\*|⭐|^\s*[-*\d]+[.、)]', re.M)


def collect(since=None):
    messages = []  # (session_id, time, text)
    files = glob.glob(os.path.join(SESSIONS, '*', 'session-*', 'session.v4.jsonl.zstd'))
    for path in files:
        session_id = os.path.basename(os.path.dirname(path))
        try:
            body = read_frames(path)
        except Exception:
            continue
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except Exception:
                continue
            when = event.get('time')
            if since and when and when < since:
                continue
            if event.get('type') != 'user/message':
                continue
            text = human_text(event.get('data') or {})
            if not text or len(text) > 120:
                continue
            if PASTED.search(text):
                continue
            messages.append((session_id, when, text))
    messages.sort(key=lambda m: m[1] or 0)
    return messages


PUNCT = re.compile(r'[\s，。！？、；：「」『』（）()《》<>“”"\'`~…—\-\[\]{}|\\/*+=_]+')
NOISE = re.compile(r'```|^\s*/|https?://|[A-Za-z]:\\|\d{2}:\d{2}')


def segments(text):
    """切成短句：按标点断开，去掉太长的和明显是代码/命令的。"""
    out = []
    for piece in re.split(r'[。！？\n]+', text):
        piece = piece.strip()
        if not piece or len(piece) > 60:
            continue
        if NOISE.search(piece):
            continue
        for sub in re.split(r'[，、；：]', piece):
            sub = sub.strip()
            if 2 <= len(sub) <= 30:
                out.append(sub)
    return list(dict.fromkeys(out))


STOP = set('''什么 一下 一个 我们 你们 他们 自己 现在 然后 如果 因为 所以 但是 而且
已经 一直 只是 还是 或者 不过 其实 可以 开始 看看 还是 作用 好了 告诉 问题
怎么 是我 你的 不用 需要 我的 给你 做完 上下 说的 什么 现在 我的 你的 没有
不是 这个 那个 这一 下一 一步 每次 几条 开头 只有 一条 一条条'''.split())


def prefixes(text, low=2, high=10):
    """只从句子开头取前缀：触发语几乎都长在句首（「帮我看…」「晚安」）。"""
    clean = PUNCT.sub('', text)
    found = set()
    for n in range(low, min(high, len(clean)) + 1):
        token = clean[:n]
        if token not in STOP:
            found.add(token)
    return found


def whole(text):
    """整句都短的话，整句本身也是候选（「晚安」「搞定」「继续」）。"""
    clean = PUNCT.sub('', text)
    return {clean} if 2 <= len(clean) <= 20 else set()


def is_useful(token, lexicon_flat):
    if token in lexicon_flat:
        return False
    if not re.search(r'[\u4e00-\u9fff]', token):  # 只要中文
        return False
    if PUNCT.search(token):
        return False
    # 数字串、单个虚词打头都不值得
    if re.search(r'\d{3,}', token):
        return False
    if token[0] in '的了是我你他她它，':
        return True  # 先留着，后面按频次和示例人工看
    return True


def main():
    days = None
    min_msgs = 4
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == '--days' and i + 1 < len(args):
            days = int(args[i + 1])
        if arg == '--min-msgs' and i + 1 < len(args):
            min_msgs = int(args[i + 1])

    since = None
    if days:
        since = (datetime.datetime.now() - datetime.timedelta(days=days)).timestamp() * 1000

    messages = collect(since)
    sessions = {m[0] for m in messages}
    print(f'人话 {len(messages)} 条，来自 {len(sessions)} 个会话')

    counted = Counter()          # token -> 出现在多少个句子里
    sessions_of = defaultdict(set)
    sample = {}
    for session_id, _when, text in messages:
        for seg in segments(text):
            for token in prefixes(seg) | whole(seg):
                counted[token] += 1
                sessions_of[token].add(session_id)
                if token not in sample:
                    sample[token] = seg[:40]

    lexicon_path = os.path.join(HOME, '.dsh', 'mode', 'lexicon.json')
    lexicon_flat = set()
    try:
        data = json.load(open(lexicon_path, encoding='utf-8'))
        for key, rules in data.items():
            if isinstance(rules, list):
                lexicon_flat.update(rules)
    except Exception:
        pass

    candidates = []
    for token, count in counted.items():
        if count < min_msgs or len(sessions_of[token]) < 3:
            continue
        if not is_useful(token, lexicon_flat):
            continue
        candidates.append((token, count, len(sessions_of[token]), sample.get(token, '')))

    # 短的总会被长的包含：同计数时只留长的
    candidates.sort(key=lambda c: (-c[1], -len(c[0])))
    kept = []
    for token, count, sess, example in candidates:
        if any(token != other and token in other and count <= count_other for other, count_other, _, _ in kept):
            continue
        kept.append((token, count, sess, example))

    lines = [
        f'人话 {len(messages)} 条 / {len(sessions)} 个会话 · 已有词表 {len(lexicon_flat)} 条',
        f'候选（出现 ≥{min_msgs} 次、跨 ≥3 个会话）：{len(kept)} 条',
        '',
        f'{"短语":<12}{"次数":>5}{"会话":>5}   例句',
    ]
    for token, count, sess, example in kept[:60]:
        lines.append(f'{token:<12}{count:>5}{sess:>5}   {example}')

    text = '\n'.join(lines)
    open(REPORT, 'w', encoding='utf-8').write(text)
    json.dump(
        [{'token': t, 'count': c, 'sessions': n, 'example': e} for t, c, n, e in kept[:80]],
        open(CANDIDATES, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'写了 {REPORT}（{len(kept)} 条候选）')


if __name__ == '__main__':
    main()
