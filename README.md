# skillgate

按档位（日常 / 工作 / 交付）改写模型能看见的技能清单。

一个 DSH 插件：它不删技能、不改宿主代码，只在**轮首**追加一条「以此为准」的清单，
告诉模型此刻能用哪些技能。关掉开关就完全不介入。

```
用户消息 → 词表匹配（命中就换档）→ 写 state.json → 轮首注入新清单
```

## 它做到什么，没做到什么

**做到**：清单真的换了。上游读 `isModelInvocable`，我们的注入覆盖它，模型看不见档位以外的技能。
实测在会话日志里可查（注入条数 2 / 11 / 9）。

**没做到，而且被证伪过一次**：换清单**不能**让模型不说工作味的话。
本地 60 条 A/B 里，「什么都不给」和「给满 11 条工作技能」的回答形态没有差别；
真机两轮的结果相互矛盾。详见 `AB-2026-10-28.md`。

所以它现在的定位是：**控制模型此刻能看见哪些技能**，不是控制语气。

## 安装

```bash
# 在本仓库的上级目录执行
dsh plugin install link:<仓库路径>/plugin
```

或者用 DSH 的 plugin_manager：`install_bundle` → `link:<仓库路径>/plugin`。

装完在会话里敲 `/tier status` 应该回一行档位 + 分档来源。

## 命令

| 命令 | 作用 |
|---|---|
| `/tier daily` / `work` / `deliver` | 手动切档，之后 10 分钟内规则不覆盖 |
| `/tier off` / `on` | 关掉 / 打开改写（关掉后完全不注入） |
| `/tier status` | 当前档位 + 分档来源 + 词表条数 |
| `/tier classify [dry]` | 让模型给技能分档，写 `tiers.json`（dry = 只算不写） |
| `/tier add <桶> <词>` | 往词表加一条（桶：enterWork / enterDeliver / exit / veto / hold，中文也行） |
| `/tier rm [桶] <词>` | 删一条，不给桶就全桶找 |
| `/tier lexicon` | 词表各桶条数 |

工具：`now` / `set_deadline` / `clear_deadline`（时间感知）、`set_tier` / `confirm_tier`（模型换档）。

## 配置

全部在 `~/.dsh/mode/`，插件启动时读，改完下一轮生效（不用重装）：

| 文件 | 内容 | 没有会怎样 |
|---|---|---|
| `lexicon.json` | 五桶词表 | **空词表，什么都不自动切**（不内置任何词，见设计 §11） |
| `tiers.json` | 技能→档位（三个数组，允许重叠；`manual` 里钉死的不被重分类覆盖） | 退回代码里那两张内置表，只认开发机上的技能名 |
| `classifier.json` | 分类端点 `{endpoint, model, apiKey}` | `/tier classify` 报错并提示 |
| `state.json` | 运行时状态：各会话档位、手动锁、截止时间 | 自动建 |
| `skillgate.log` | JSONL 事件：rule / rule-skipped / inject / rollback / classify | 自动建 |
| `versions/` | 版本快照，保留最近 6 版 | 自动建 |

示例见 `examples/`。

## 判定规则

优先级：`veto > exit > enter-deliver > enter-work > hold`。

- 引号、书名号、代码块里的词**不参与匹配**（引用剥离）
- 交付档额外要求**祈使标记**（把 / 帮我 / 生成 / 导出…），光提到「交接文件」不算
- 升档后冻结 3 轮（降档不冻），两轮内没调工具自动退回原档
- 模型换档：降档自主，升档必须先问用户

## 开发

```bash
node tools/selftest.mjs          # 64 个用例，纯假 ctx，不开 DSH
node tools/replay.mjs < msgs.json >  # 真实语料回放
python tools/induce.py           # 从会话日志挖候选词
python tools/induce-review.py    # 让模型筛候选（需 ~/.dsh/mode/inducer.json）
python tools/score.py            # 冻结回放集打分 + 存版本快照
```

改代码必须卸载重装才生效：`plugin_manager` remove_bundle → install_bundle。

## 已知限制

1. **分档依赖 `tiers.json`**，没跑过 `/tier classify` 就退回内置表——那张表只对开发机成立。
2. **词表是字面匹配**，换个说法就漏；召回低（冻结回放集上 0.25），精确率高（0.82）。
3. **误判不会自己回来**，除非它属于「升档后两轮没工具」那一类。
4. 回放集标签是模型标的，不是人工真值，分数只能横向比版本。
5. `grilling` 这类「行为准则型」技能归哪档没有定论，现在归工作档。

## 设计文档

`docs/设计定稿.md` —— 14 节，含假设登记、实施边界、自检记录。
