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

  async function buildCatalog(payload, tier) {
    const skillsService = ctx.get('skills')
    if (!skillsService) return null
    const key = `${payload.agent.id}|${tier}`
    const hit = snapshots.get(key)
    if (hit && Date.now() - hit.at < 60_000) {
      return { role: 'user', id: randomUUID(), content: [{ type: 'text', text: renderCatalog(tier, hit.entries) }], source: { kind: 'skill-catalog', form: 'catalog', update: true, tier, entries: hit.entries } }
    }
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
    return {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: renderCatalog(tier, kept) }],
      source: { kind: 'skill-catalog', form: 'catalog', update: true, tier, entries: kept },
    }
  }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
        const state = await loadState()
        if (!state.enabled) return decision
        const sessionId = String((payload && payload.agent && payload.agent.id) || '')
        const tier = (state.sessions && state.sessions[sessionId]) || state.default || 'daily'
        const message = await buildCatalog(payload, tier)
        if (!message) return decision
        const step = Number(payload && payload.step) || 0
        const changed = lastTier.get(sessionId) !== tier
        lastTier.set(sessionId, tier)
        if (changed || step === 1) {
          void appendLog({
            event: 'inject',
            sessionId,
            tier,
            step,
            count: message.source.entries.length,
            names: message.source.entries.map((entry) => entry.name),
          })
        }
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
