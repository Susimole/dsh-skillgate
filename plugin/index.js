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
  return { version: 1, enabled: true, default: 'daily', sessions: {}, meta: {}, deadlines: {} }
}

export function apply(ctx, config = {}) {
  const statePath = typeof config.statePath === 'string' && config.statePath
    ? config.statePath
    : join(homedir(), '.dsh', 'mode', 'state.json')
  const logPath = join(dirname(statePath), 'skillgate.log')
  const lexiconPath = join(dirname(statePath), 'lexicon.json')

  const work = new Set(Array.isArray(config.workSkills) ? config.workSkills : DEFAULT_WORK)
  const deliver = new Set(Array.isArray(config.deliverSkills) ? config.deliverSkills : DEFAULT_DELIVER)

  // 手动切档后的静默期：这段时间内规则不覆盖用户的选择。
  const manualHoldMs = Number.isFinite(config.manualHoldMs) ? config.manualHoldMs : 10 * 60_000
  // 时间行不是每轮都值得发，闲得久了才发一条。
  const timeGapMs = Number.isFinite(config.timeGapMs) ? config.timeGapMs : 10 * 60_000
  // 「继续」多久之内算还在干同一件事。
  const holdWindowMs = Number.isFinite(config.holdWindowMs) ? config.holdWindowMs : 30 * 60_000

  // sessionId|tier -> { at, entries }。清单很少变，缓存 60 秒，免得每步都扫技能目录。
  const snapshots = new Map()
  // sessionId -> 上一次生效的档位，用来决定要不要写日志。
  const lastTier = new Map()

  let cached = null
  let cachedAt = 0
  // state.json 存在但解析不了时，先把原文件留个备份，别让默认值把它盖掉。
  let corruptBackup = null

  // 分档结果（§2.4 的产物）。有它就以它为准；没有才退回上面那两张内置表。
  // 内置表只认我这台机器上的技能名，别人装上去工作档会是空的——所以才需要这个文件。
  const tiersPath = join(dirname(statePath), 'tiers.json')
  let tiers = null
  let tiersAt = 0

  async function refreshTiers(now) {
    if (now - tiersAt < 5_000) return tiers
    tiersAt = now
    try {
      const parsed = JSON.parse(await readFile(tiersPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return tiers
      const list = (key) => (Array.isArray(parsed[key]) ? parsed[key].filter((n) => typeof n === 'string') : [])
      const next = { work: new Set(list('work')), deliver: new Set(list('deliver')), daily: new Set(list('daily')) }
      // 三个桶都空的文件等于没分类，别拿它把档位清空。
      tiers = next.work.size || next.deliver.size || next.daily.size ? next : null
    } catch {
      tiers = null // 文件不在或坏了：保持上一份结果，没有就退回内置表
    }
    return tiers
  }

  // 一个技能可以同时属于多个档（比如既能闲聊也能干活的那种），所以这里问的是
  // 「在不在这一档」，不是「它属于哪一档」。没被任何档收进去的技能落日常。
  function inTier(name, tier) {
    if (typeof name !== 'string') return tier === 'daily'
    if (!tiers) return bucket(name) === tier
    if (tiers[tier].has(name)) return true
    if (tier !== 'daily') return false
    return !tiers.work.has(name) && !tiers.deliver.has(name)
  }

  function bucket(name) {
    if (typeof name !== 'string') return 'daily'
    if (tiers) {
      if (tiers.deliver.has(name)) return 'deliver'
      if (tiers.work.has(name)) return 'work'
      return 'daily'
    }
    if (deliver.has(name)) return 'deliver'
    if (work.has(name)) return 'work'
    if (/^office(-|$)/i.test(name)) return 'deliver'
    return 'daily'
  }

  async function loadState() {
    const now = Date.now()
    if (cached && now - cachedAt < 500) return cached
    let raw = null
    try {
      raw = await readFile(statePath, 'utf8')
    } catch {
      raw = null // 文件还不存在：正常，用默认值
    }
    let parsed = null
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        // 文件在、但读不成 JSON：留备份，然后用默认可用的那套继续跑（fail-open）。
        if (corruptBackup === null) corruptBackup = raw
      }
    }
    if (parsed && typeof parsed === 'object') {
      cached = {
        ...defaultState(),
        ...parsed,
        sessions: { ...(parsed.sessions) },
        meta: { ...(parsed.meta) },
        deadlines: { ...(parsed.deadlines) },
      }
    } else if (!cached) {
      cached = defaultState()
    }
    cachedAt = now
    return cached
  }

  async function saveState(state) {
    cached = state
    cachedAt = Date.now()
    await mkdir(dirname(statePath), { recursive: true })
    if (corruptBackup !== null) {
      const backup = corruptBackup
      corruptBackup = null
      try {
        await writeFile(`${statePath}.bad-${Date.now()}`, backup, 'utf8')
      } catch {
        // 备份失败也照常往下写，不能因为留备份把主流程挡住
      }
    }
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

  function renderCatalog(tier, skills, hint) {
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
      ...(hint ? ['', hint] : []),
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
  function createTierMessage(tier, entries, hint) {
    const text = renderCatalog(tier, entries, hint)
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

  async function buildCatalog(payload, tier, hint) {
    const skillsService = ctx.get('skills')
    if (!skillsService) return null
    const key = `${payload.agent.id}|${tier}`
    const hit = snapshots.get(key)
    if (hit && Date.now() - hit.at < 60_000) return createTierMessage(tier, hit.entries, hint)
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
    await refreshTiers(Date.now())
    const kept = snapshot.skills.filter((skill) => inTier(skill && skill.name, tier))
    // 分档文件在、但某个技能没被划进任何桶：它会被塞进日常。这在别人机器上很常见，
    // 所以要留痕，别让它悄悄消失。
    if (tiers && tier === 'daily') {
      const unknown = kept
        .map((skill) => skill && skill.name)
        .filter((name) => typeof name === 'string' && !tiers.daily.has(name))
      if (unknown.length) void appendLog({ event: 'unclassified', names: unknown })
    }
    snapshots.set(key, { at: Date.now(), entries: kept })
    return createTierMessage(tier, kept, hint)
  }

  // ---- 显式指令识别（v0.3 第一刀：纯字面匹配，不做归纳） ----
  // 词表**不内置**（定稿 §11 纪律）：没有 lexicon.json 就是空词表，什么都不自动切。
  // 原来这里写死的是我自己那 39 条原话，换个人装上去等于把口音也一起装过去。
  const EMPTY_LEXICON = { enterWork: [], enterDeliver: [], exit: [], veto: [], hold: [] }

  async function loadLexicon() {
    try {
      const parsed = JSON.parse(await readFile(lexiconPath, 'utf8'))
      const pick = (key) => (Array.isArray(parsed[key]) ? parsed[key].filter((rule) => typeof rule === 'string' && rule) : [])
      return {
        enterWork: pick('enterWork'),
        enterDeliver: pick('enterDeliver'),
        exit: pick('exit'),
        veto: pick('veto'),
        hold: pick('hold'),
      }
    } catch {
      return EMPTY_LEXICON
    }
  }

  // ---- 词表的手工入口 ----
  // 词表不内置（§11），所以得有个能改它的办法。增长主要靠四问校准那条对话路径写的文件，
  // 这里只负责三件事：加一条、删一条、看一眼。
  const BUCKET_ALIASES = {
    enterwork: 'enterWork', work: 'enterWork', 工作: 'enterWork', 进工作: 'enterWork',
    enterdeliver: 'enterDeliver', deliver: 'enterDeliver', 交付: 'enterDeliver',
    exit: 'exit', 退出: 'exit', 收工: 'exit',
    veto: 'veto', 否决: 'veto',
    hold: 'hold', 续行: 'hold',
  }
  const BUCKET_ORDER = ['enterWork', 'enterDeliver', 'exit', 'veto', 'hold']
  const MAX_RULES = 60

  async function readLexiconFile() {
    const base = { ...EMPTY_LEXICON }
    try {
      const parsed = JSON.parse(await readFile(lexiconPath, 'utf8'))
      for (const key of BUCKET_ORDER) {
        if (Array.isArray(parsed[key])) {
          base[key] = parsed[key].filter((rule) => typeof rule === 'string' && rule)
        }
      }
    } catch {
      // 文件不在就从空的开始
    }
    return base
  }

  async function writeLexiconFile(lexicon) {
    const next = { schema: 1, updatedAt: new Date().toISOString().slice(0, 10) }
    for (const key of BUCKET_ORDER) next[key] = lexicon[key]
    await mkdir(dirname(lexiconPath), { recursive: true })
    await writeFile(lexiconPath, JSON.stringify(next, null, 1), 'utf8')
  }

  function totalRules(lexicon) {
    return BUCKET_ORDER.reduce((sum, key) => sum + lexicon[key].length, 0)
  }

  // 引用剥离：引号、书名号、代码块里出现的词不算数。
  // 实测误杀都长这样——「这是我们的聊天日志和交接文件」，或者讨论时引用一句「把我做成表」。
  function stripQuoted(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/"[^"\n]*"/g, ' ')
      .replace(/[“”][^“”]{0,200}?[“”]/g, ' ')
      .replace(/「[^」\n]*」/g, ' ')
      .replace(/『[^』\n]*』/g, ' ')
      .replace(/《[^》\n]*》/g, ' ')
      .replace(/'[^'\n]*'/g, ' ')
  }

  // 交付档这四个字最容易误伤：「这是我们的交接文件」也会命中。
  // 定稿 §3.1 本来就要求升交付得是「祈使 + 明确对象」，所以这里补上祈使标记这一半。
  const IMPERATIVE = /把|帮我|给我|做成|做份|做个|生成|导出|出个|出张|出份|整理成|写一份/

  // 否决 > 退出 > 交付 > 进入 > 续行。
  // 「先别动手，帮我看看」按否决处理；「继续」只在已经干着活时才算数（见 hold 分支）。
  function matchTier(text, lexicon) {
    const bare = stripQuoted(text)
    for (const rule of lexicon.veto) if (rule && bare.includes(rule)) return { bucket: 'veto', rule, tier: null }
    for (const rule of lexicon.exit) if (rule && bare.includes(rule)) return { bucket: 'exit', rule, tier: 'daily' }
    for (const rule of lexicon.enterDeliver) {
      if (rule && bare.includes(rule) && IMPERATIVE.test(bare)) return { bucket: 'enter-deliver', rule, tier: 'deliver' }
    }
    for (const rule of lexicon.enterWork) if (rule && bare.includes(rule)) return { bucket: 'enter-work', rule, tier: 'work' }
    for (const rule of lexicon.hold) if (rule && bare.includes(rule)) return { bucket: 'hold', rule, tier: null }
    return null
  }

  // 只看真正由人写进来的消息：我们自己注入的、运行时上下文、时间戳都要跳过。
  const IGNORED_SOURCES = new Set([
    'skillgate-tier', 'skillgate-time', 'time-context', 'runtime-context', 'skill-catalog', 'skill-invocation',
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

  // ---- 升档后的观察窗口（v0.4） ----
  const TIER_RANK = { daily: 0, work: 1, deliver: 2 }
  const tierRank = (name) => (name in TIER_RANK ? TIER_RANK[name] : 0)
  const turnNo = new Map()      // sessionId -> 第几轮
  const freezeUntil = new Map() // sessionId -> 冻结到第几轮
  const promoted = new Map()    // sessionId -> { from, at, index }

  function countToolUse(messages) {
    let count = 0
    for (const message of messages || []) {
      if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block && (block.type === 'tool_use' || block.type === 'tool_call')) count += 1
      }
    }
    return count
  }

  // ---- 时间感知（v0.2） ----
  // 受同一条运行时限制：只有轮首注入会落盘，所以时间行在轮首给，
  // 轮中要精确时刻就让模型自己调 now()。
  const sessionStart = new Map()
  const lastTimeInjected = new Map()

  function formatClock(ms) {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 60000))
    if (total < 1) return '不到 1 分钟'
    if (total < 60) return `${total} 分钟`
    const hours = Math.floor(total / 60)
    const minutes = total % 60
    return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
  }

  function describeDeadline(deadline, now) {
    if (!deadline) return '没有截止时间'
    const left = deadline.at - now
    return left >= 0
      ? `截止 ${formatClock(deadline.at)}（剩 ${formatDuration(left)}）`
      : `已超 ${formatDuration(-left)}`
  }

  // 会话起始时刻落盘：插件重装/重启后内存表是空的，
  // 只靠内存会把「本会话 3 小时」说成「不到 1 分钟」——时间行存在的意义就是不猜时间。
  async function sessionStarted(state, sessionId, now) {
    const known = sessionStart.get(sessionId)
    if (known) return known
    const meta = (state.meta && state.meta[sessionId]) || {}
    if (Number(meta.startedAt) > 0) {
      sessionStart.set(sessionId, Number(meta.startedAt))
      return Number(meta.startedAt)
    }
    sessionStart.set(sessionId, now)
    state.meta[sessionId] = { ...meta, startedAt: now }
    await saveState(state)
    return now
  }

  async function buildTimeMessage(state, sessionId, now) {
    const started = await sessionStarted(state, sessionId, now)
    const deadline = state.deadlines && state.deadlines[sessionId]
    const lastAt = lastTimeInjected.get(sessionId) || 0
    const overdue = Boolean(deadline) && deadline.at <= now && !deadline.remindedAt
    // 没有截止、也没闲够久，就不发，省 token。
    if (!deadline && now - lastAt < timeGapMs) return null
    lastTimeInjected.set(sessionId, now)
    if (overdue) {
      // 必须落盘：cached 每 500ms 会从磁盘重读，不写回的话提醒会每轮重复。
      deadline.remindedAt = now
      await saveState(state)
    }
    const lines = [
      '<system-reminder>',
      `⏱ ${formatClock(now)} · 本会话 ${formatDuration(now - started)} · ${describeDeadline(deadline, now)}`,
    ]
    if (overdue) {
      lines.push(deadline.note
        ? `截止已到（${deadline.note}）：把手上这一步做完就停，然后汇报进度与剩余项。`
        : '截止已到：把手上这一步做完就停，然后汇报进度与剩余项。')
    }
    lines.push('</system-reminder>')
    const text = lines.join('\n')
    return deepFreeze(structuredClone({
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'skillgate-time', form: 'snapshot', sections: [{ name: 'skillgate-time', text }] },
    }))
  }

  // ---- 模型换档（v0.5） ----
  // 降档是保守方向，模型自己就能做；升档必须先问用户，用户点头后再 confirm。
  // 每个会话的第一次 set_tier 是「定起始档」，不算升档。
  const pendingUpgrade = new Map() // sessionId -> { tier, turn, reason }

  async function applyModelTier(sessionId, target, reason) {
    const state = await loadState()
    const from = (state.sessions && state.sessions[sessionId]) || state.default || 'daily'
    if (from === target) return { from, changed: false }
    state.sessions[sessionId] = target
    const nextMeta = { ...(state.meta[sessionId] || {}) }
    if (target === 'work' || target === 'deliver') nextMeta.lastWorkAt = Date.now()
    state.meta[sessionId] = nextMeta
    await saveState(state)
    lastTier.delete(sessionId)
    snapshots.clear()
    void appendLog({ event: 'model-tier', sessionId, from, to: target, reason: String(reason || '').slice(0, 80) })
    return { from, changed: true }
  }

  function makeTool(name, description, parameters, run) {
    return {
      name,
      description,
      parameters,
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      execute: async (args, exec) => ({ text: String(await run(args || {}, exec)) }),
    }
  }

  // DSH 重启后 tools 服务未必已经就绪，静默失败会让 now / set_tier 全部消失（29 日实测）。
  // 所以：立刻试一次 → 不行就等它出现 → 每轮再兜一次底。
  function registerSkillgateTools(tools) {
    if (!tools) return false
    try {
      tools.register(makeTool(
        'now',
        '读取当前时间：本机时刻、本会话已进行的时长、以及有没有截止时间。想确认过了多久时调用它，不要凭感觉估。',
        { type: 'object', properties: {}, additionalProperties: false },
        async (_args, exec) => {
          const sessionId = String((exec && exec.agent && exec.agent.id) || '')
          const state = await loadState()
          const now = Date.now()
          const started = await sessionStarted(state, sessionId, now)
          return `⏱ ${formatClock(now)} · 本会话 ${formatDuration(now - started)} · ${describeDeadline(state.deadlines && state.deadlines[sessionId], now)}`
        },
      ))
      tools.register(makeTool(
        'set_deadline',
        '给自己设一个截止时间。只收相对分钟数，绝对时刻由系统换算——不要自己算时间点。',
        {
          type: 'object',
          properties: {
            afterMinutes: { type: 'number', description: '多少分钟后截止' },
            note: { type: 'string', description: '这次截止要做完什么，用于到点提醒' },
          },
          required: ['afterMinutes'],
        },
        async (args, exec) => {
          const sessionId = String((exec && exec.agent && exec.agent.id) || '')
          const minutes = Number(args.afterMinutes)
          if (!Number.isFinite(minutes) || minutes <= 0) return '参数不对：afterMinutes 必须是正数分钟。'
          const state = await loadState()
          const at = Date.now() + minutes * 60000
          state.deadlines[sessionId] = { at, note: typeof args.note === 'string' ? args.note : '', remindedAt: null }
          await saveState(state)
          return `已设截止 ${formatClock(at)}（${formatDuration(minutes * 60000)} 后）${args.note ? '：' + args.note : ''}。到点我会在下一轮开头提醒收尾。`
        },
      ))
      tools.register(makeTool(
        'set_tier',
        '给你自己换档。降档（交付→工作→日常）可以直接用；升档前必须先问用户一句，用户同意后再调 confirm_tier。每个会话第一次调用是定起始档，直接生效。',
        {
          type: 'object',
          properties: {
            tier: { type: 'string', description: 'daily / work / deliver' },
            reason: { type: 'string', description: '一句话理由，会写进日志' },
          },
          required: ['tier'],
        },
        async (args, exec) => {
          const sessionId = String((exec && exec.agent && exec.agent.id) || '')
          const target = String((args && args.tier) || '').toLowerCase()
          if (!(target in TIER_RANK)) return '档位只能是 daily / work / deliver。'
          const state = await loadState()
          const current = (state.sessions && state.sessions[sessionId]) || state.default || 'daily'
          const meta = (state.meta && state.meta[sessionId]) || {}

          if (!meta.judgedAt) {
            // 冷启动：这一档就是起始档，直接生效，并记住「已经判过一次」。
            await applyModelTier(sessionId, target, args.reason)
            const next = await loadState()
            next.meta[sessionId] = { ...(next.meta[sessionId] || {}), judgedAt: Date.now() }
            await saveState(next)
            return `起始档位定为 ${TIER_LABEL[target]}，之后不会再自动重判。`
          }
          if (tierRank(target) <= tierRank(current)) {
            await applyModelTier(sessionId, target, args.reason)
            return `已切到 ${TIER_LABEL[target]}（降档不用问）。`
          }
          pendingUpgrade.set(sessionId, { tier: target, turn: turnNo.get(sessionId) || 0, reason: args.reason })
          return `升档要先问用户：用你自己的话问一句「要不要切到 ${TIER_LABEL[target]}」；用户同意后调 confirm_tier。`
        },
      ))
      tools.register(makeTool(
        'confirm_tier',
        '用户同意升档后调用。把 set_tier 记下的那次升档真正生效；超过 3 轮就作废。',
        { type: 'object', properties: {}, additionalProperties: false },
        async (_args, exec) => {
          const sessionId = String((exec && exec.agent && exec.agent.id) || '')
          const pending = pendingUpgrade.get(sessionId)
          if (!pending) return '没有待确认的升档。'
          const turn = turnNo.get(sessionId) || 0
          pendingUpgrade.delete(sessionId)
          if (turn - pending.turn > 3) return '那次升档已经过期了（超过 3 轮），要升就重新走一遍。'
          await applyModelTier(sessionId, pending.tier, pending.reason)
          return `已升到 ${TIER_LABEL[pending.tier]}。`
        },
      ))
      tools.register(makeTool(
        'clear_deadline',
        '清掉当前会话的截止时间。收尾完成后调用。',
        { type: 'object', properties: {}, additionalProperties: false },
        async (_args, exec) => {
          const sessionId = String((exec && exec.agent && exec.agent.id) || '')
          const state = await loadState()
          if (!state.deadlines[sessionId]) return '当前没有截止时间。'
          delete state.deadlines[sessionId]
          await saveState(state)
          return '已清除截止时间。'
        },
      ))
      void appendLog({ event: 'tools', status: 'ok' })
      return true
    } catch (error) {
      void appendLog({ event: 'tools', status: 'failed', error: String((error && error.message) || error) })
      return false
    }
  }

  const toolsNow = ctx.get('tools')
  if (toolsNow) {
    registerSkillgateTools(toolsNow)
  } else {
    void appendLog({ event: 'tools', status: 'not-ready' })
    try {
      ctx.inject?.(['tools'], (scope) => {
        const late = scope && typeof scope.get === 'function' ? scope.get('tools') : null
        if (late) registerSkillgateTools(late)
      })
    } catch (error) {
      void appendLog({ event: 'tools', action: 'inject', status: 'failed', error: String((error && error.message) || error) })
    }
  }

  let toolsHealAt = 0
  function healTools() {
    const now = Date.now()
    if (now - toolsHealAt < 60_000) return
    const tools = ctx.get('tools')
    if (!tools || typeof tools.get !== 'function') return
    toolsHealAt = now
    try {
      if (tools.get('now')) return
    } catch {
      return
    }
    if (registerSkillgateTools(tools)) void appendLog({ event: 'tools', action: 'heal', status: 'reregistered' })
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
        healTierCommand(payload.agent)
        healTools()
        const sessionId = String((payload && payload.agent && payload.agent.id) || '')
        let tier = (state.sessions && state.sessions[sessionId]) || state.default || 'daily'
        const turn = (turnNo.get(sessionId) || 0) + 1
        turnNo.set(sessionId, turn)

        // 升档后两轮观察：一次工具都没调，说明这趟并不需要那些技能，退回原档。
        const watch = promoted.get(sessionId)
        if (watch && turn >= watch.at + 2) {
          promoted.delete(sessionId)
          const used = countToolUse((payload.messages || []).slice(watch.index))
          if (!used && tierRank(tier) > tierRank(watch.from)) {
            tier = watch.from
            state.sessions[sessionId] = tier
            await saveState(state)
            freezeUntil.delete(sessionId)
            void appendLog({ event: 'rollback', sessionId, from: watch.from, reason: 'no-tool' })
          }
        }

        // 先看这一轮用户说了什么：显式指令优先于当前档位。
        const now = Date.now()
        const meta = (state.meta && state.meta[sessionId]) || {}
        const text = pickUserText(payload, decision)
        if (text) {
          const manualLocked = Number(meta.manualAt || 0) > 0 && now - Number(meta.manualAt) < manualHoldMs
          if (manualLocked) {
            void appendLog({ event: 'rule-skipped', reason: 'manual-hold', sessionId, text: text.slice(0, 120) })
          } else {
            const hit = matchTier(text, await loadLexicon())
            if (hit) {
              let nextTier = hit.tier
              // 「继续」只有在最近干过活时才算回到工作，否则只是聊天里的接话。
              if (hit.bucket === 'hold') {
                const lastWorkAt = Number(meta.lastWorkAt || 0)
                nextTier = tier === 'daily' && lastWorkAt > 0 && now - lastWorkAt < holdWindowMs ? 'work' : null
              }
              const upgrading = nextTier && tierRank(nextTier) > tierRank(tier)
              if (upgrading && (freezeUntil.get(sessionId) || 0) > turn) {
                // 刚升过档，还在冻结期：这次升档不生效，但降档永远放行（升档保守、降档灵敏）。
                void appendLog({
                  event: 'rule-skipped',
                  reason: 'freeze',
                  sessionId,
                  bucket: hit.bucket,
                  rule: hit.rule,
                  text: text.slice(0, 120),
                })
                nextTier = null
              }
              void appendLog({
                event: 'rule',
                sessionId,
                bucket: hit.bucket,
                rule: hit.rule,
                text: text.slice(0, 120),
                from: tier,
                to: nextTier || tier,
              })
              if (nextTier && nextTier !== tier) {
                const from = tier
                tier = nextTier
                if (tierRank(tier) > tierRank(from)) {
                  freezeUntil.set(sessionId, turn + 3)
                  promoted.set(sessionId, { from, at: turn, index: decision.messages.length })
                }
                state.sessions[sessionId] = tier
                const nextMeta = { ...(state.meta[sessionId] || {}) }
                if (tier === 'work' || tier === 'deliver') nextMeta.lastWorkAt = now
                state.meta[sessionId] = nextMeta
                await saveState(state)
              }
            }
          }
        }

        // 档位没变就不再重复注入——上一轮那条还在历史里；
        // 但时间行是独立判断的，不能因为档位没变就一起跳过。
        const out = [...decision.messages]
        if (lastTier.get(sessionId) !== tier) {
          const metaNow = (state.meta && state.meta[sessionId]) || {}
          const hint = metaNow.judgedAt
            ? ''
            : '本会话还没定过档。读完用户这句话后，用 set_tier 选一个起始档（只做一次）；拿不准就留在日常。'
          const message = await buildCatalog(payload, tier, hint)
          if (message) {
            lastTier.set(sessionId, tier)
            out.push(message)
            void appendLog({
              event: 'inject',
              sessionId,
              tier,
              step,
              count: message.source.entries.length,
              names: message.source.entries.map((entry) => entry.name),
            })
          }
        }
        const timeMessage = await buildTimeMessage(state, sessionId, now)
        if (timeMessage) out.push(timeMessage)
        if (out.length === decision.messages.length) return decision
        return { ...decision, messages: out }
      } catch {
        return decision
      }
    })
  } catch {
    // 注册失败就什么都不做，绝不拦截对话
  }

  // ---- 安装时分类（§2.4） ----
  // 分档不再靠我手写的那两张表，而是把每个技能的摘要交给一个模型归类，结果落 tiers.json。
  // 端点单独放在 classifier.json：换台机器、换个模型都不用改代码。
  const classifierPath = join(dirname(statePath), 'classifier.json')

  async function loadClassifier() {
    const parsed = JSON.parse(await readFile(classifierPath, 'utf8'))
    if (!parsed || typeof parsed.endpoint !== 'string' || !parsed.endpoint) {
      throw new Error('classifier.json 里没有 endpoint')
    }
    return {
      endpoint: parsed.endpoint,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      temperature: Number.isFinite(parsed.temperature) ? parsed.temperature : 0,
    }
  }

  const CLASSIFY_PROMPT = [
    '你是技能分类器。输入是一台机器上的技能清单（name / description / whenToUse）。',
    '把每个技能归入且只归入一档：',
    '- daily：闲聊、陪伴、角色扮演、人设、语气、生活琐事，不产出工作成果。',
    '- work：诊断、调试、修 bug、写代码、读仓库、研究、审查、规划、分析。',
    '- deliver：产出具体成品文件——表格、文档、幻灯片、图、PDF、渲染、导出。',
    '- drop：明说依赖不存在 / 加载不了 / 内容为空，或根本读不懂在干什么。',
    '规则：每条给一句理由（不超过 20 字）；拿不准的把 uncertain 设 true；',
    '角色扮演、陪伴、人设类算 daily。只输出一个 JSON 对象，不要解释、不要代码块：',
    '{"items":[{"name":"","tier":"daily|work|deliver|drop","reason":"","uncertain":false}]}',
  ].join('\n')

  function parseClassification(text, entries) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('模型没吐出 JSON')
    const data = JSON.parse(text.slice(start, end + 1))
    const raw = Array.isArray(data.items) ? data.items : []
    const byName = new Map(raw.map((item) => [item && item.name, item]))
    const tiers = new Set(['daily', 'work', 'deliver', 'drop'])
    const out = []
    entries.forEach((entry, index) => {
      // 先按名字对，对不上再按位置兜底——小模型经常改名字。
      const item = byName.get(entry.name) || raw[index]
      if (!item || !tiers.has(item.tier)) return
      out.push({
        name: entry.name,
        tier: item.tier,
        reason: String(item.reason || '').slice(0, 80),
        uncertain: Boolean(item.uncertain),
      })
    })
    return out
  }

  async function classifyWithModel(entries, config) {
    const headers = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(config.model ? { model: config.model } : {}),
        messages: [
          { role: 'system', content: CLASSIFY_PROMPT },
          { role: 'user', content: JSON.stringify({ skills: entries }) },
        ],
        temperature: config.temperature,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!response.ok) throw new Error(`分类接口回了 ${response.status}`)
    const payload = await response.json()
    const text = payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? String(payload.choices[0].message.content || '')
      : ''
    return parseClassification(text, entries)
  }

  const tierDefinition = {
        name: 'tier',
        description: '技能档位：切换、分类、改词表（daily/work/deliver/off/on/status/classify/add/rm/lexicon）',
        input: { hint: 'daily | work | deliver | off | on | status | classify [dry] | add <桶> <词> | rm [桶] <词> | lexicon' },
        handler: async (invocation) => {
          const rawInput = String(invocation.rawInput || '').trim()
          const arg = rawInput.toLowerCase()
          const state = await loadState()
          const sessionId = String((invocation.agent && invocation.agent.id) || '')
          if (!arg || arg === 'status') {
            // 直接读一次，别依赖 buildCatalog 留下的缓存——命令可能比第一轮注入先跑。
            tiersAt = 0
            await refreshTiers(Date.now())
            const current = (state.sessions && state.sessions[sessionId]) || state.default
            const source = tiers
              ? `tiers.json（工作 ${tiers.work.size} / 交付 ${tiers.deliver.size} / 日常 ${tiers.daily.size}）`
              : '内置表（没有 tiers.json，或文件读不出来）'
            const lexicon = await loadLexicon()
            const rules = Object.values(lexicon).reduce((sum, list) => sum + list.length, 0)
            // 命令回显会把换行压成空格，所以这里单行写完。
            return {
              kind: 'success',
              text: `档位：${TIER_LABEL[current] || current}${state.enabled ? '' : '（已关闭，不生效）'} · 分档来源：${source} · 词表 ${rules} 条${rules ? '' : '（还没校准，不会自动切档）'}`,
            }
          }
          if (arg === 'classify' || arg === 'classify dry' || arg === 'classify --dry') {
            const dry = arg !== 'classify'
            const skillsService = ctx.get('skills')
            if (!skillsService) return { kind: 'error', text: '拿不到 skills 服务，分类不了' }
            let config
            try {
              config = await loadClassifier()
            } catch (error) {
              return {
                kind: 'error',
                text: `没配分类端点：${String(error.message || error)}。写 ${classifierPath}，形如 {"endpoint":"http://127.0.0.1:8087/v1/chat/completions","model":"qwen3.8-27b"}`,
              }
            }
            const snapshot = await skillsService.snapshot({ scope: invocation.agent })
            if (!snapshot || snapshot.complete !== true) {
              return { kind: 'error', text: '技能快照不完整，等一会再试' }
            }
            const entries = snapshot.skills
              .filter((item) => item && typeof item.name === 'string')
              .map((item) => ({
                name: item.name,
                description: String(item.description || '').slice(0, 180),
                whenToUse: String(item.whenToUse || '').slice(0, 120),
              }))
            let items
            try {
              items = await classifyWithModel(entries, config)
            } catch (error) {
              return { kind: 'error', text: `分类失败：${String(error.message || error)}` }
            }
            if (!items.length) return { kind: 'error', text: '模型一条都没分出来，没写文件' }

            const before = new Map(entries.map((entry) => [entry.name, bucket(entry.name)]))
            const changed = items
              .filter((item) => before.get(item.name) && before.get(item.name) !== item.tier)
              .map((item) => `${item.name}:${before.get(item.name)}→${item.tier}`)
            const count = (tier) => items.filter((item) => item.tier === tier).length
            const uncertain = items.filter((item) => item.uncertain).length
            const missing = entries.length - items.length

            if (!dry) {
              // 模型一次只给一个主档；`manual` 是人工钉死的归属，重跑分类不许覆盖它。
              let previous = null
              try {
                previous = JSON.parse(await readFile(tiersPath, 'utf8'))
              } catch {
                previous = null
              }
              const manual = previous && previous.manual && typeof previous.manual === 'object' ? previous.manual : {}
              const lists = { work: new Set(), deliver: new Set(), daily: new Set() }
              for (const item of items) if (lists[item.tier]) lists[item.tier].add(item.name)
              for (const [name, wanted] of Object.entries(manual)) {
                const tierList = Array.isArray(wanted) ? wanted : [wanted]
                for (const key of ['work', 'deliver', 'daily']) {
                  if (tierList.includes(key)) lists[key].add(name)
                  else lists[key].delete(name)
                }
              }
              const next = {
                schema: 1,
                generatedAt: new Date().toISOString().slice(0, 10),
                source: `model:${config.model || 'default'} @ ${config.endpoint}`,
                work: [...lists.work],
                deliver: [...lists.deliver],
                daily: [...lists.daily],
                ...(Object.keys(manual).length ? { manual } : {}),
                items,
              }
              await writeFile(tiersPath, JSON.stringify(next, null, 1), 'utf8')
              tiersAt = 0
              await refreshTiers(Date.now())
              snapshots.clear()
              lastTier.delete(sessionId) // 下一轮重发清单，用新的分档
              void appendLog({ event: 'classify', counts: { work: count('work'), deliver: count('deliver'), daily: count('daily'), drop: count('drop') }, changed: changed.length })
            }
            const head = `分类${dry ? '（干跑，没写文件）' : '完成'}：工作 ${count('work')} · 交付 ${count('deliver')} · 日常 ${count('daily')} · 丢弃 ${count('drop')}`
            const tail = [
              uncertain ? `${uncertain} 条拿不准` : '',
              missing > 0 ? `${missing} 条没分出来` : '',
              changed.length ? `变了 ${changed.length} 条：${changed.slice(0, 6).join('、')}` : '跟现在一样',
            ].filter(Boolean).join(' · ')
            return { kind: 'success', text: `${head}（${tail}）` }
          }
          if (arg === 'lexicon' || arg.startsWith('add ') || arg.startsWith('rm ')) {
            const lexicon = await readLexiconFile()
            if (arg === 'lexicon') {
              const parts = BUCKET_ORDER.map((key) => `${key} ${lexicon[key].length}`)
              return {
                kind: 'success',
                text: `词表共 ${totalRules(lexicon)} 条：${parts.join(' · ')}${totalRules(lexicon) ? '' : '（空，不会自动切档）'}`,
              }
            }
            const verb = arg.startsWith('add ') ? 'add' : 'rm'
            const [, token = '', ...rest] = rawInput.split(/\s+/)
            const phrase = rest.join(' ').trim()
            const bucket = BUCKET_ALIASES[token.toLowerCase()]

            if (verb === 'rm' && !bucket) {
              // 不给桶就全桶找，删掉第一处出现的那个。
              const target = token.trim()
              if (!target) return { kind: 'error', text: '用法：/tier rm <词> 或 /tier rm <桶> <词>' }
              const key = BUCKET_ORDER.find((name) => lexicon[name].includes(target))
              if (!key) return { kind: 'error', text: `词表里没有「${target}」` }
              lexicon[key] = lexicon[key].filter((rule) => rule !== target)
              await writeLexiconFile(lexicon)
              return { kind: 'success', text: `已从 ${key} 删掉「${target}」 · 还剩 ${totalRules(lexicon)} 条` }
            }
            if (!bucket) {
              const names = BUCKET_ORDER.join(' / ')
              return { kind: 'error', text: `不认识的桶：${token || '（空）'}（可用 ${names}）` }
            }
            const text = (verb === 'add' ? phrase : rest.join(' ').trim()) || (verb === 'rm' ? token.trim() : '')
            if (!text) return { kind: 'error', text: `用法：/tier ${verb} ${token} <词>` }
            if (text.length > 24) return { kind: 'error', text: '太长：一条规则最多 24 个字' }
            if (verb === 'add') {
              if (lexicon[bucket].includes(text)) {
                return { kind: 'success', text: `${bucket} 里已经有「${text}」，没重复加` }
              }
              if (lexicon[bucket].length >= MAX_RULES) {
                return { kind: 'error', text: `${bucket} 已经 ${MAX_RULES} 条，先删几条再加` }
              }
              lexicon[bucket].push(text)
            } else {
              if (!lexicon[bucket].includes(text)) return { kind: 'error', text: `${bucket} 里没有「${text}」` }
              lexicon[bucket] = lexicon[bucket].filter((rule) => rule !== text)
            }
            await writeLexiconFile(lexicon)
            void appendLog({ event: 'lexicon', action: verb, bucket, rule: text, total: totalRules(lexicon) })
            return {
              kind: 'success',
              text: `${verb === 'add' ? '已加进' : '已从'} ${bucket} ${verb === 'add' ? '：' : '删掉：'}「${text}」 · 共 ${totalRules(lexicon)} 条`,
            }
          }
          if (arg === 'off' || arg === 'on') {
            state.enabled = arg === 'on'
            await saveState(state)
            snapshots.clear()
            // 关掉时模型手里还留着上一条档位清单；再打开必须重发一次，
            // 否则它会一直按旧档位用技能，直到下一次换档才纠正。
            lastTier.delete(sessionId)
            return { kind: 'success', text: arg === 'off' ? '已关闭档位改写' : '已开启档位改写' }
          }
          const tier = TIER_ALIASES[arg]
          if (!tier) return { kind: 'error', text: `不认识的档位：${arg}（可用 daily / work / deliver）` }
          state.sessions[sessionId] = tier
          // 手动切档后设一段静默期：规则不许立刻把它顶回去。
          const now = Date.now()
          state.meta[sessionId] = {
            ...(state.meta[sessionId] || {}),
            manualAt: now,
            ...(tier === 'work' || tier === 'deliver' ? { lastWorkAt: now } : {}),
          }
          await saveState(state)
          snapshots.clear()
          lastTier.delete(sessionId)
          return {
            kind: 'success',
            text: `已切到 ${TIER_LABEL[tier]} 档，下一轮生效（${Math.round(manualHoldMs / 60000)} 分钟内规则不覆盖）`,
          }
        },
  }

  // 命令是唯一的手动兜底，所以注册失败必须留痕：
  // DSH 重载插件时 commands 服务不一定已经就绪，静默失败会让 /tier 变成普通聊天，
  // 而它一坏，用户就没有任何别的办法把档位切回来了。
  function registerTierCommand(commands) {
    try {
      commands.register(tierDefinition)
      void appendLog({ event: 'command', action: 'register', status: 'ok' })
      return true
    } catch (error) {
      void appendLog({
        event: 'command',
        action: 'register',
        status: 'failed',
        error: String((error && error.message) || error),
      })
      return false
    }
  }

  // 命令是唯一的手动退路：重装插件后它静默消失过一次（14:11 实测）。
  // 所以每轮顺手看一眼，不在就补注册。60 秒最多试一次，免得 find 不可靠时重复注册。
  let commandHealAt = 0
  function healTierCommand(agent) {
    const now = Date.now()
    if (now - commandHealAt < 60_000) return
    const commands = ctx.get('commands')
    if (!commands || typeof commands.find !== 'function') return
    commandHealAt = now
    try {
      if (commands.find(agent, 'tier')) return
    } catch {
      return
    }
    if (registerTierCommand(commands)) {
      void appendLog({ event: 'command', action: 'heal', status: 'reregistered' })
    }
  }

  const commandsNow = ctx.get('commands')
  if (commandsNow) {
    registerTierCommand(commandsNow)
  } else {    void appendLog({ event: 'command', action: 'register', status: 'not-ready' })
    try {
      ctx.inject?.(['commands'], (scope) => {
        const late = scope && typeof scope.get === 'function' ? scope.get('commands') : null
        if (late) registerTierCommand(late)
      })
    } catch (error) {
      void appendLog({
        event: 'command',
        action: 'inject',
        status: 'failed',
        error: String((error && error.message) || error),
      })
    }
  }
}
