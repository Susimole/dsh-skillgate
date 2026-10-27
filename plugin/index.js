// SkillGate v0.1 —— 档位闸门。
// 机制：档位变化时，追加一条“替换清单”，告诉模型以此为准。
// 不改上游插件、不删技能、不碰磁盘；关掉开关就完全恢复原样。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const START = '<available_skills>'
const END = '</available_skills>'

// v0.1 的默认分档：只验证机制，不追求分得准。
// 后续版本按每个人自己的技能清单分类。
const DEFAULT_WORK = [
  'diagnosing-bugs', 'coding-discipline', 'research', 'prototype', 'skill-creator',
  'domain-modeling', 'diagnose-windows-sandbox-acl', 'cordis-plugin-development',
  'cordis-composition-reference', 'editing-cordis-compositions', 'agent-experience',
]

const DEFAULT_DELIVER = [
  'office', 'office-docx', 'office-xlsx', 'office-pptx', 'office-render',
  'office-export-pdf', 'office-recalculate', 'archify', 'writing-for-agents',
]

const TIER_ALIASES = {
  daily: 'daily', 日常: 'daily',
  work: 'work', 工作: 'work',
  deliver: 'deliver', delivery: 'deliver', 交付: 'deliver',
}

const TIER_LABEL = { daily: '日常', work: '工作', deliver: '交付' }

function defaultState() {
  return { version: 1, enabled: true, default: 'daily', sessions: {} }
}

export function apply(ctx, config = {}) {
  const statePath = typeof config.statePath === 'string' && config.statePath
    ? config.statePath
    : join(homedir(), '.dsh', 'mode', 'state.json')
  const logPath = join(dirname(statePath), 'skillgate.log')
  const lexiconPath = join(dirname(statePath), 'lexicon.json')

  const work = new Set(Array.isArray(config.workSkills) ? config.workSkills : DEFAULT_WORK)
  const deliver = new Set(Array.isArray(config.deliverSkills) ? config.deliverSkills : DEFAULT_DELIVER)

  // sessionId|tier -> { at, entries }。清单很少变，缓存 60 秒，免得每步都扫技能目录。
  const snapshots = new Map()
  // sessionId -> 上一次生效的档位，用来决定要不要写日志。
  const lastTier = new Map()

  let cached = null
  let cachedAt = 0

  function bucket(name) {
    if (typeof name !== 'string') return 'daily'
    if (deliver.has(name)) return 'deliver'
    if (work.has(name)) return 'work'
    if (/^office(-|$)/i.test(name)) return 'deliver'
    return 'daily'
  }

  async function loadState() {
    const now = Date.now()
    if (cached && now - cachedAt < 500) return cached
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8'))
      cached = { ...defaultState(), ...parsed, sessions: { ...(parsed && parsed.sessions) } }
    } catch {
      cached = cached || defaultState()
    }
    cachedAt = now
    return cached
  }

  async function saveState(state) {
    cached = state
    cachedAt = Date.now()
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
  }

  async function appendLog(line) {
    try {
      await mkdir(dirname(logPath), { recursive: true })
      await writeFile(logPath, JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n', { flag: 'a' })
    } catch {
      // 日志写不出不影响主流程
    }
  }

  function renderCatalog(tier, skills) {
    const lines = skills.map((skill) => `- \`${skill.name}\`: ${skill.description}`)
    const body = lines.length ? lines.join('\n') : '（本档没有任何技能）'
    return [
      '<system-reminder>',
      `当前档位：${TIER_LABEL[tier] || tier}。以下是本会话此刻可用的技能，它取代本会话中之前出现的所有技能清单：`,
      '',
      START,
      body,
      END,
      '',
      '如果任务需要其他档位的技能，告诉用户要切换档位，不要凭空使用清单外的名字。',
      '</system-reminder>',
    ].join('\n')
  }

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const key of Object.keys(value)) deepFreeze(value[key])
    }
    return value
  }

  // 与上游 createUserMessage 同形：克隆后深冻结、自带 id、用自己的 source.kind。
  // 借用别人的 kind 会被会话层当成既有事件类型处理，这是最初没落盘的原因之一。
  function createTierMessage(tier, entries) {
    const text = renderCatalog(tier, entries)
    return deepFreeze(structuredClone({
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: {
        kind: 'skillgate-tier',
        form: 'snapshot',
        tier,
        sections: [{ name: 'skillgate-tier', text }],
        entries,
      },
    }))
  }

  async function buildCatalog(payload, tier) {
    const skillsService = ctx.get('skills')
    if (!skillsService) return null
    const key = `${payload.agent.id}|${tier}`
    const hit = snapshots.get(key)
    if (hit && Date.now() - hit.at < 60_000) return createTierMessage(tier, hit.entries)
    const workingDirectory = ctx.get('workingDirectory')
    let cwd
    try {
      cwd = workingDirectory ? await workingDirectory.ensure(payload.agent, payload.signal) : undefined
    } catch {
      cwd = undefined
    }
    const snapshot = await skillsService.snapshot({
      cwd,
      scope: payload.agent,
      signal: payload.signal,
    })
    if (!snapshot || snapshot.complete !== true) return null
    const kept = snapshot.skills.filter((skill) => bucket(skill && skill.name) === tier)
    snapshots.set(key, { at: Date.now(), entries: kept })
    return createTierMessage(tier, kept)
  }

  // ---- 显式指令识别（v0.3 第一刀：纯字面匹配，不做归纳） ----
  // 种子来自使用者自己的原话；换一个人装，这里应当是空的（定稿 §11 纪律）。
  const DEFAULT_LEXICON = {
    enterWork: [
      '帮我看', '帮我查', '帮我找', '帮我在', '帮我改', '帮我做',
      '是不是坏了', '用不了', '报错', '继续做', '继续改', '是我做的',
    ],
    exit: ['好了结束', '搞定', '收工', '先这样', '晚安', '只聊天', '别管这个', '先不弄了'],
    veto: ['先别动手', '仅讨论', '只讨论', '几个技能', '先别改'],
  }

  async function loadLexicon() {
    try {
      const parsed = JSON.parse(await readFile(lexiconPath, 'utf8'))
      return {
        enterWork: Array.isArray(parsed.enterWork) ? parsed.enterWork : DEFAULT_LEXICON.enterWork,
        exit: Array.isArray(parsed.exit) ? parsed.exit : DEFAULT_LEXICON.exit,
        veto: Array.isArray(parsed.veto) ? parsed.veto : DEFAULT_LEXICON.veto,
      }
    } catch {
      return DEFAULT_LEXICON
    }
  }

  // 否决 > 退出 > 进入：「先别动手，帮我看看」应当按否决处理。
  function matchTier(text, lexicon) {
    for (const rule of lexicon.veto) if (rule && text.includes(rule)) return { bucket: 'veto', rule, tier: null }
    for (const rule of lexicon.exit) if (rule && text.includes(rule)) return { bucket: 'exit', rule, tier: 'daily' }
    for (const rule of lexicon.enterWork) if (rule && text.includes(rule)) return { bucket: 'enter-work', rule, tier: 'work' }
    return null
  }

  // 只看真正由人写进来的消息：我们自己注入的、运行时上下文、时间戳都要跳过。
  const IGNORED_SOURCES = new Set([
    'skillgate-tier', 'time-context', 'runtime-context', 'skill-catalog', 'skill-invocation',
  ])

  function pickUserText(payload, decision) {
    for (const list of [payload && payload.messages, decision && decision.messages]) {
      if (!Array.isArray(list)) continue
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const message = list[i]
        if (!message || message.role !== 'user') continue
        const kind = message.source && message.source.kind
        if (kind && IGNORED_SOURCES.has(kind)) continue
        const text = (message.content || [])
          .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
          .join('')
          .trim()
        if (text) return text
      }
    }
    return ''
  }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
        const state = await loadState()
        if (!state.enabled) return decision
        const step = Number(payload && payload.step) || 0
        // 只有轮首那份会被持久化，轮中注入既费 token 又不生效。
        if (step !== 1) return decision
        const sessionId = String((payload && payload.agent && payload.agent.id) || '')
        let tier = (state.sessions && state.sessions[sessionId]) || state.default || 'daily'

        // 先看这一轮用户说了什么：显式指令优先于当前档位。
        const text = pickUserText(payload, decision)
        if (text) {
          const hit = matchTier(text, await loadLexicon())
          if (hit) {
            void appendLog({
              event: 'rule',
              sessionId,
              bucket: hit.bucket,
              rule: hit.rule,
              text: text.slice(0, 120),
              from: tier,
              to: hit.tier || tier,
            })
            if (hit.tier && hit.tier !== tier) {
              tier = hit.tier
              state.sessions[sessionId] = tier
              await saveState(state)
            }
          }
        }

        // 档位没变就不再重复注入——上一轮那条还在历史里。
        if (lastTier.get(sessionId) === tier) return decision
        const message = await buildCatalog(payload, tier)
        if (!message) return decision
        lastTier.set(sessionId, tier)
        void appendLog({
          event: 'inject',
          sessionId,
          tier,
          step,
          count: message.source.entries.length,
          names: message.source.entries.map((entry) => entry.name),
        })
        return { ...decision, messages: [...decision.messages, message] }
      } catch {
        return decision
      }
    })
  } catch {
    // 注册失败就什么都不做，绝不拦截对话
  }

  try {
    const commands = ctx.get('commands')
    if (commands) {
      commands.register({
        name: 'tier',
        description: '切换技能档位（daily / work / deliver / off / on / status）',
        input: { hint: 'daily | work | deliver | off | on | status' },
        handler: async (invocation) => {
          const arg = String(invocation.rawInput || '').trim().toLowerCase()
          const state = await loadState()
          const sessionId = String((invocation.agent && invocation.agent.id) || '')
          if (!arg || arg === 'status') {
            const current = (state.sessions && state.sessions[sessionId]) || state.default
            return {
              kind: 'success',
              text: `档位：${TIER_LABEL[current] || current}${state.enabled ? '' : '（已关闭，不生效）'}`,
            }
          }
          if (arg === 'off' || arg === 'on') {
            state.enabled = arg === 'on'
            await saveState(state)
            snapshots.clear()
            return { kind: 'success', text: arg === 'off' ? '已关闭档位改写' : '已开启档位改写' }
          }
          const tier = TIER_ALIASES[arg]
          if (!tier) return { kind: 'error', text: `不认识的档位：${arg}（可用 daily / work / deliver）` }
          state.sessions[sessionId] = tier
          await saveState(state)
          snapshots.clear()
          return { kind: 'success', text: `已切到 ${TIER_LABEL[tier]} 档，下一轮生效` }
        },
      })
    }
  } catch {
    // 命令注册失败不影响改写
  }
}
