# SkillGate 交接（2026-10-28 01:15）

给压缩后的自己看的。读完这一页就能接着干，不用翻对话。

## 一句话

`dsh-skillgate` 已经能按档位（日常 / 工作 / 交付）改写模型看到的技能清单，手动和自动都通，实测有效。剩 v0.4 / v0.5 / v1.0 三步没做。

## 仓库与运行态

- 代码：`D:\Ai_work\skillgate`（独立 git 仓库）
- 设计：`D:\Ai_work\技能档位插件-设计定稿.md`（14 节，§13 实施边界、§14 自检记录）
- 已安装：`@local/dsh-skillgate`（`link:D:/Ai_work/skillgate/plugin`），另有 probe1–4 四个探针仍装着
- 运行时数据：`~/.dsh/mode/`
  - `state.json`：`sessions`（档位）、`meta`（manualAt / lastWorkAt）、`deadlines`
  - `lexicon.json`：五桶词表，可手改
  - `skillgate.log`：JSONL 事件（rule / rule-skipped / inject）
- 提交：`8663f6b` v0.1 → `7afaa20` 修复 → `7961f04` v0.3 → `2d2f02d` v0.2+v0.3 收尾 → `9d167d0` 提醒落盘 → `268e569` 交接 → 本轮自检与回放

## 两条铁律（踩过坑，别忘）

1. **只有轮首（`step === 1`）注入的消息会落盘、会被模型看到**。轮中注入既不生效也不报错。
2. 注入消息必须 **`deepFreeze(structuredClone(...))` + 自带 `id` + 自己的 `source.kind`**（`skillgate-tier` / `skillgate-time`）。借用 `skill-catalog` 会被会话层当重复目录消化掉——**静默消失，不报错**。
3. 推论：`IGNORED_SOURCES` 必须包含所有自己注入的 kind，否则模型会把自己的时间行当用户原话。

## 现在的行为

- 每轮开头：读本轮用户消息 → 五桶匹配（veto > exit > deliver > work > hold）→ 命中即改档 → 档位变了才注入新清单
- 手动 `/tier [daily|work|deliver|off|on|status]`，之后 10 分钟内规则不覆盖（`manualAt`）
- `hold`（「继续」）只在 30 分钟内有干活记录时才算回到工作
- 时间行：有截止或距上次超过 10 分钟时注入一行；工具 `now` / `set_deadline` / `clear_deadline`
- `/tier off` 后完全不注入
- 分档是**硬编码**的：工作 11 条、交付 9 条、其余全进日常（含未知技能）。换台机器必须改 `DEFAULT_WORK` / `DEFAULT_DELIVER`，或等 v1.0 的动态分类

## 验证状态

已验证：切档双向、当轮生效、工具往返、fail-open（state.json 损坏不崩且留 `.bad-` 备份）、统计脚本、**23 个单元用例**、**47 条真实语料回放**。

**未验证**（都需真人发消息）：
1. `把这个做成表` → 交付档 9 条
2. `好，继续`（隔了几小时）→ 应当不动（反例）
3. `今天有点累` → 什么都不该变
4. 手动锁过期：`/tier daily` 后等 10 分钟再说 `帮我看下日志` → 应当切工作

## 已知问题

1. **并发写竞态**：QQ 与桌面两个会话同时在线时都读改写 `state.json`，后写覆盖前写。要加串行写队列。
2. **时间行偏密**：长会话会堆，建议改成「有截止才发 / 或 >30 分钟」。
3. **引用即触发**：把「交接文件」「做成表」写进句子里讨论也会切档。回放里 7 次切档有 2 次是这个原因，其中一次是实测（01:05）。解法是 v0.4 的引用剥离。
4. **注入会累积**：每次换档在历史里留一条。
5. **`veto` 词不齐**：「几个技能」有，「几个插件」没有，00:51 那句就是这么被 `enter-work` 吃下的。

## 下一步

- v0.4 判定精细化（引用剥离、漏桶衰减、3 轮冻结、2 轮无工具回退、补 veto 同义词）
- v0.5 模型判定（冷启动一次、升档要模型自己开口问）
- v1.0 归纳器（离线、冻结回放集、月度、版本 diff）——**需要至少两周真实使用数据**

## 怎么调试

```bash
node tools/selftest.mjs                 # 23 个用例，突变检验过，应当全绿
node tools/replay.mjs <messages.json>   # 真实语料回放，看会切几次档
node tools/lexicon-stats.mjs --days 7   # 看真实日志的命中与误判
tail -5 ~/.dsh/mode/skillgate.log       # 最近判定
```

改插件：`plugin_manager` remove_bundle → install_bundle（**改代码必须卸载重装才生效**）。probe1–3 可以卸，probe4 留着当自检；卸载要重启 DSH。

## 已定但反直觉的决定

- **不做自定义 footer**：客户端读档位要改 service 骨架，性价比低；用 `/tier` 的命令回显代替。footer 的 slot 确实存在（`conversation.chat.turnTail`），缺的是客户端→host 的读状态通道（只有 `ctx.remote.commands.execute()`，那是执行命令不是读状态）。
- **时间行按轮不按步**：轮中注入无效，这是机制限制。
- **词表是字面匹配**：不写正则、不做置信度，那些留给 v1.0。
- **技能清单不在 system prompt 里**：它是 `dsh-tool-skill` 在 pre-step 追加的 user 消息，所以没有「替换那一段」这回事。

## 悬着的一件事

我问过、还没答：**误判要不要自动纠**——日常里说「帮我看看这段感情」被切到工作档，要不要几轮后自己退回日常，还是老实地待着等手动改。v0.4 开工前需要你拍板。

另一个只记着没做：你早先说过「收工时先给一张简易图表，再问要不要详细版」，这条属于 `preferences.json`，任何一个版本都还没实现。
