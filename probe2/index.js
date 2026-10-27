// SkillGate 探针 2：只读。
// 探针 1 的结论是——技能清单不在 system prompt 里（hits 为空）。
// 那它一定是被当成一条对话消息塞进去的。这个探针去 agent/pre-step 看消息本体，
// 顺便看 pre-step 的返回值长什么样（能不能换掉消息）。同样绝不改变行为。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const START = '<available_skills>'
const END = '</available_skills>'
const MAX_TEXT = 600

function clip(text, n = MAX_TEXT) {
  return typeof text === 'string' ? text.slice(0, n) : ''
}

function textOf(message) {
  const content = message && message.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

export function apply(ctx, config = {}) {
  const reportPath = typeof config.reportPath === 'string'
    ? config.reportPath
    : 'D:/Ai_work/skillgate/probe2-report.json'
  const maxSamples = Number.isInteger(config.maxSamples) ? config.maxSamples : 5

  const state = {
    version: 1,
    startedAt: new Date().toISOString(),
    preSteps: 0,
    assemblies: 0,
    skillsApi: null,
    samples: [],
    errors: [],
  }
  let writing = false

  function noteError(where, error) {
    if (state.errors.length >= 10) return
    state.errors.push({ where, message: String((error && error.message) || error) })
  }

  async function flush() {
    if (writing) return
    writing = true
    try {
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      // 报告写不出来不能影响对话
    } finally {
      writing = false
    }
  }

  function describeMessage(message) {
    const text = textOf(message)
    const at = text.indexOf(START)
    const close = at >= 0 ? text.indexOf(END, at) : -1
    const names = []
    if (at >= 0) {
      for (const line of text.slice(at, close > at ? close : undefined).split('\n')) {
        const match = /^- `([^`]+)`/.exec(line)
        if (match) names.push(match[1])
      }
    }
    return {
      role: message && message.role,
      sourceKind: (message && message.source && message.source.kind) || null,
      textLength: text.length,
      hasCatalog: at >= 0,
      entryCount: names.length,
      names: names.slice(0, 30),
      head: clip(text, 300),
    }
  }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        state.preSteps += 1
        if (!state.skillsApi) {
          try {
            const service = ctx.get('skills')
            if (service) {
              const list = await service.list({})
              state.skillsApi = { ok: true, count: list.length, names: list.map((s) => s && s.name) }
            } else {
              state.skillsApi = { ok: false, reason: 'service-missing' }
            }
          } catch (error) {
            state.skillsApi = { ok: false, reason: String((error && error.message) || error) }
          }
        }
        if (state.samples.length < maxSamples) {
          const messages = Array.isArray(payload && payload.messages) ? payload.messages : []
          state.samples.push({
            at: new Date().toISOString(),
            turn: payload && payload.turn,
            step: payload && payload.step,
            messageCount: messages.length,
            decisionKeys: decision && typeof decision === 'object' ? Object.keys(decision) : [],
            decisionKind: decision && typeof decision === 'object'
              ? Object.fromEntries(Object.entries(decision).map(([k, v]) => [k, typeof v]))
              : typeof decision,
            messages: messages.map(describeMessage),
          })
        }
        void flush()
      } catch (error) {
        noteError('pre-step', error)
      }
      return decision
    })
  } catch (error) {
    noteError('register', error)
    void flush()
  }
}
