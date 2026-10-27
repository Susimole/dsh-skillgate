// SkillGate 探针 3：只读。
// 探针 1：清单不在 system prompt 里。
// 探针 2：pre-step 的 messages 在工具步里是空的，但它能返回 { kind, messages }。
// 现在看最后一道口子——喂给模型的完整请求配置（agent/request），
// 清单如果在那里，就能在请求前重写。仍然不改任何东西。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const START = '<available_skills>'
const END = '</available_skills>'

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

export function apply(ctx, config = {}) {
  const reportPath = typeof config.reportPath === 'string'
    ? config.reportPath
    : 'D:/Ai_work/skillgate/probe3-report.json'
  const maxSamples = Number.isInteger(config.maxSamples) ? config.maxSamples : 4

  const state = {
    version: 1,
    startedAt: new Date().toISOString(),
    requests: 0,
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
      // 不影响对话
    } finally {
      writing = false
    }
  }

  function describe(content, index) {
    const text = textOfContent(content)
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
      index,
      kind: typeof content === 'string' ? 'string' : 'blocks',
      length: text.length,
      hasCatalog: at >= 0,
      entryCount: names.length,
      blockStart: at,
      blockEnd: close,
      names: names.slice(0, 30),
    }
  }

  try {
    ctx.on('agent/request', async (payload, next) => {
      const configResult = await next()
      try {
        state.requests += 1
        if (!state.skillsApi) {
          try {
            const service = ctx.get('skills')
            const list = service ? await service.list({}) : null
            state.skillsApi = service
              ? { ok: true, count: list.length, names: list.map((s) => s && s.name) }
              : { ok: false, reason: 'service-missing' }
          } catch (error) {
            state.skillsApi = { ok: false, reason: String((error && error.message) || error) }
          }
        }
        if (state.samples.length < maxSamples) {
          const keys = configResult && typeof configResult === 'object' ? Object.keys(configResult) : []
          const shapes = {}
          for (const key of keys) {
            const value = configResult[key]
            shapes[key] = Array.isArray(value) ? `array(${value.length})` : typeof value
          }
          const messages = Array.isArray(configResult?.messages) ? configResult.messages : []
          const sample = {
            at: new Date().toISOString(),
            turn: payload && payload.turn,
            step: payload && payload.step,
            configKeys: keys,
            configShapes: shapes,
            messageCount: messages.length,
            catalogMessages: [],
            systemHasCatalog: typeof configResult?.system === 'string' && configResult.system.indexOf(START) >= 0,
            messageRoles: messages.slice(0, 60).map((m) => (m && m.role) || null),
          }
          messages.forEach((message, index) => {
            const info = describe(message && message.content, index)
            if (info.hasCatalog) sample.catalogMessages.push(info)
          })
          state.samples.push(sample)
        }
        void flush()
      } catch (error) {
        noteError('request', error)
      }
      return configResult
    })
  } catch (error) {
    noteError('register', error)
    void flush()
  }
}
