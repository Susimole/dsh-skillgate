# SkillGate 交接（2026-10-28 01:00）

给压缩后的自己看的。读完这一页就能接着干，不用翻对话。

## 一句话

`dsh-skillgate` 已经能按档位（日常 / 工作 / 交付）改写模型看到的技能清单，手动和自动都通，实测有效。剩下 v0.4 / v0.5 / v1.0 三步没做。

## 仓库与运行态

- 代码：`D:\Ai_work\skillgate`（独立 git 仓库）
- 设计：`D:\Ai_work\技能档位插件-设计定稿.md`（12 节，含 §13 实施边界）
- 已安装：`@local/dsh-skillgate`（link 到 `skillgate/plugin`），另有 probe1–4 四个探针仍装着
- 运行时数据：`~/.dsh/mode/`
  - `state.json`：`sessions`（档位）、`meta`（manualAt / lastWorkAt）、`deadlines`
  - `lexicon.json`：五桶词表，可手改
  - `skillgate.log`：JSONL 事件（rule / rule-skipped / inject）
- 提交：`8663f6b` v0.1 → `7afaa20` 修复 → `7961f04` v0.3 → `2d2f02d` v0.2+v0.3 收尾 → `9d167d0` 提醒落盘

## 两条铁律（踩过坑，别忘）

1. **只有轮首（`step === 1`）注入的消息会落盘、会被模型看到**。轮中注入既不生效也不报错。
2. 注入消息必须 **`deepFreeze(structuredClone(...))` + 自带 `id` + 自己的 `source.kind`**（`skillgate-tier` / `skillgate-time`）。借用 `skill-catalog` 会被会话层当重复目录消化掉——**静默消失，不报错**。

## 现在的行为

- 每轮开头：读本轮用户消息 → 五桶匹配（veto > exit > deliver > work > hold）→ 命中即改档 → 档位变了就注入新清单
- 手动 `/tier [daily|work|deliver|off|on|status]`，之后 10 分钟内规则不覆盖（`manualAt`）
- `hold`（「继续」）只在 30 分钟内有干活记录时才算回到工作
- 时间行：有截止或距上次超过 10 分钟时注入一行；工具 `now` / `set_deadline` / `clear_deadline`
- 关闭开关 `/tier off` 后完全不注入

## 验证状态

已验证：切档双向、当轮生效、工具往返、fail-open（state.json 损坏不崩）、统计脚本。
**未验证**（都需真人发消息）：交付档端到端、hold 正反例、手动锁过期、跨会话默认日常。

## 已知问题

1. **并发写竞态**：QQ 与桌面两个会话同时读改写 `state.json`，后写覆盖前写。要加串行写队列。
2. **时间行偏密**：长会话会堆，建议改成「有截止才发 / 或 >30 分钟」。
3. **误判面宽**：任何「帮我…」都切工作。
4. **注入会累积**：每次换档在历史里留一条。

## 下一步

- v0.4 判定精细化（漏桶衰减、3 轮冻结、2 轮无工具回退）
- v0.5 模型判定（冷启动一次、升档要模型自己开口问）
- v1.0 归纳器（离线、冻结回放集、月度、版本 diff）——**需要至少两周真实使用数据**

## 怎么调试

- 看最近判定：`tail -5 ~/.dsh/mode/skillgate.log`
- 统计误判：`node tools/lexicon-stats.mjs --days 7`
- 装/改插件：`plugin_manager` remove_bundle → install_bundle（**改代码必须卸载重装才生效**）
- 探针 4 可看真实请求体里有没有注入消息

## 已定但反直觉的决定

- **不做自定义 footer**：客户端读档位要改 service 骨架，性价比低；用 `/tier` 的命令回显代替。
- **时间行按轮不按步**：轮中注入无效，这是机制限制。
- **词表是字面匹配**：不写正则、不做置信度，那些留给 v1.0。
