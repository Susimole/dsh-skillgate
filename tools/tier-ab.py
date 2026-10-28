#!/usr/bin/env python3
"""档位 A/B 实验：同一批问题，四种清单条件，看回答形态有没有差别。

条件：none（不给清单）/ daily / work / deliver。
问题 15 条，四个条件交叉，每题的条件顺序固定打乱（种子固定，可复现）。
每条回复量：字数、小标题、列表项、编号项、表格、粗体、《综合形态分》。

输出：tools/ab-raw.jsonl（逐条原始回复）、tools/ab-report.txt（汇总）

用法：python tools/tier-ab.py [模型地址]
"""
import json, random, re, sys, time, urllib.request

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8087/v1/chat/completions")
MODEL = "qwen3.8-27b"
RAW = "tools/ab-raw.jsonl"
REPORT = "tools/ab-report.txt"

CATALOGS = {
    "none": None,
    "daily": ("日常", [
        ("grilling", "把用户的想法往死里拷问"),
        ("time-estimates", "把含糊的时长说法换成可数的单位"),
    ]),
    "work": ("工作", [
        ("diagnosing-bugs", "定位并修复 bug 的诊断循环"),
        ("coding-discipline", "写代码的行为准则"),
        ("research", "查证问题并落成文档"),
        ("prototype", "做一次性原型验证想法"),
        ("skill-creator", "创建和优化技能"),
        ("domain-modeling", "建领域模型与术语表"),
        ("diagnose-windows-sandbox-acl", "排查 Windows 沙箱权限"),
        ("cordis-plugin-development", "开发 DSH 插件"),
        ("cordis-composition-reference", "查 Cordis 配置语法"),
        ("editing-cordis-compositions", "编辑 agent 预设"),
        ("agent-experience", "设计模型可见的工具与技能"),
    ]),
    "deliver": ("交付", [
        ("archify", "画架构图并导出图片"),
        ("office", "创建和转换 Office 文档"),
        ("office-docx", "读写 Word 文档"),
        ("office-xlsx", "读写 Excel 表格"),
        ("office-pptx", "读写 PPT 演示文稿"),
        ("office-render", "把文档渲染成图片"),
        ("office-export-pdf", "把文档转成 PDF"),
        ("office-recalculate", "刷新表格公式缓存"),
        ("writing-for-agents", "写面向 agent 的文档"),
    ]),
}

QUESTIONS = [
    "解释一下什么是潮汐锁定。",
    "为什么天空是蓝色的？",
    "介绍一下木星。",
    "什么是通货膨胀？",
    "解释一下免疫系统是怎么工作的。",
    "为什么猫喜欢纸箱？",
    "介绍一下丝绸之路。",
    "什么是相对论？",
    "解释一下咖啡因的作用机理。",
    "为什么会有四季？",
    "介绍一下敦煌莫高窟。",
    "什么是区块链？",
    "解释一下为什么老房子会响。",
    "介绍一下大熊猫。",
    "什么是光合作用？",
]

CONDITIONS = ["none", "daily", "work", "deliver"]


def catalog_text(key):
    if CATALOGS[key] is None:
        return None
    tier, skills = CATALOGS[key]
    body = "\n".join(f"- `{n}`: {d}" for n, d in skills)
    return (
        "<system-reminder>\n"
        f"当前档位：{tier}。以下是本会话此刻可用的技能，它取代本会话中之前出现的所有技能清单：\n\n"
        "<available_skills>\n" + body + "\n</available_skills>\n\n"
        "如果任务需要其他档位的技能，告诉用户要切换档位，不要凭空使用清单外的名字。\n"
        "</system-reminder>"
    )


def call(messages, retries=2):
    body = json.dumps({"model": MODEL, "messages": messages, "temperature": 0.0, "max_tokens": 900}, ensure_ascii=False).encode()
    last = None
    for _ in range(retries):
        try:
            request = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.loads(response.read().decode("utf-8"))["choices"][0]["message"]["content"]
        except Exception as error:  # noqa: BLE001 - 本地服务偶发超时，重试一次
            last = error
            time.sleep(1)
    raise last


def metrics(text):
    heading = len(re.findall(r"^#{1,6} ", text, re.M))
    bullet = len(re.findall(r"^[-*] ", text, re.M))
    numbered = len(re.findall(r"^\d+\. ", text, re.M))
    table = text.count("|---")
    bold = len(re.findall(r"\*\*", text)) // 2
    paras = len([p for p in re.split(r"\n\s*\n", text) if p.strip()])
    return {
        "chars": len(text),
        "heading": heading,
        "bullet": bullet,
        "numbered": numbered,
        "table": table,
        "bold": bold,
        "paras": paras,
        "shape": heading + bullet + numbered + table,
    }


def main():
    random.seed(20261028)
    orders = []
    for _ in QUESTIONS:
        order = CONDITIONS[:]
        random.shuffle(order)
        orders.append(order)

    total = len(QUESTIONS) * len(CONDITIONS)
    done = 0
    started = time.time()
    with open(RAW, "w", encoding="utf-8") as out:
        for index, question in enumerate(QUESTIONS):
            for condition in orders[index]:
                messages = []
                block = catalog_text(condition)
                if block:
                    messages.append({"role": "user", "content": block})
                messages.append({"role": "user", "content": question})
                try:
                    reply = call(messages)
                except Exception as error:  # noqa: BLE001
                    reply = f"__ERROR__ {error}"
                record = {
                    "question": question,
                    "condition": condition,
                    "reply": reply,
                    "metrics": metrics(reply) if not reply.startswith("__ERROR__") else None,
                }
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                out.flush()
                done += 1
                print(f"[{done}/{total}] {condition:8} {question[:14]} -> {len(reply)}", flush=True)
    print(f"耗时 {time.time() - started:.0f}s", flush=True)
    summarize()


def summarize():
    rows = [json.loads(line) for line in open(RAW, encoding="utf-8")]
    ok = [r for r in rows if r["metrics"]]
    errors = len(rows) - len(ok)
    lines = [f"有效 {len(ok)} 条，失败 {errors} 条", ""]
    keys = ["chars", "heading", "bullet", "numbered", "table", "bold", "paras", "shape"]
    header = f"{'条件':8}" + "".join(f"{k:>9}" for k in keys)
    lines.append(header)
    per = {}
    for condition in CONDITIONS:
        group = [r["metrics"] for r in ok if r["condition"] == condition]
        per[condition] = group
        if not group:
            lines.append(f"{condition:8}(无数据)")
            continue
        cells = []
        for key in keys:
            values = sorted(item[key] for item in group)
            cells.append(f"{values[len(values) // 2]:>9}")
        lines.append(f"{condition:8}" + "".join(cells))
    lines.append("")
    lines.append("（每格是中位数）")

    # 配对比较：同一道题，daily 与 work 的形态分谁高
    pairs = []
    for question in QUESTIONS:
        by_condition = {r["condition"]: r for r in ok if r["question"] == question}
        if "daily" in by_condition and "work" in by_condition:
            pairs.append(by_condition["daily"]["metrics"]["shape"] - by_condition["work"]["metrics"]["shape"])
    if pairs:
        plus = sum(1 for d in pairs if d > 0)
        minus = sum(1 for d in pairs if d < 0)
        equal = sum(1 for d in pairs if d == 0)
        lines.append("")
        lines.append(f"配对（同题 daily−work 形态分）：work 更高 {minus} 题，daily 更高 {plus} 题，持平 {equal} 题")

    text = "\n".join(lines)
    open(REPORT, "w", encoding="utf-8").write(text)
    print(text)


if __name__ == "__main__":
    main()
