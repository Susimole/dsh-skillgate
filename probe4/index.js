// SkillGate 探针 4：只看不做。
// 前面三个探针确认了清单由 agent/pre-step 注入；这个探针看 llm/stream 的真实请求体，
// 确认注入的消息确实进了发给模型的消息列表。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MARK = '当前档位：'

export function apply(ctx, config = {}) {
  const reportPath = typeof config.reportPath === 'string' && config.reportPath
    ? config.reportPath
    : 'D:/Ai_work/skillgate/probe4-report.json'
  const state = { version: 1, calls: 0, samples: [], errors: [] }
  let writing = false

  async function flush() {
    if (writing) return
    writing = true
    try {
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, JSON.stringify(state, null, 2), 'utf8')
    } catch {
      // 不影响对话
    } finally {
      writing = false
    }
  }

  try {
    ctx.on('llm/stream', (options, next) => {
      try {
        state.calls += 1
        if (state.samples.length < 6) {
          const messages = Array.isArray(options && options.messages) ? options.messages : []
          let hits = 0
          let lastHit = null
          const hitList = []
          messages.forEach((message, index) => {
            const text = Array.isArray(message && message.content)
              ? message.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
              : ''
            if (text.indexOf(MARK) >= 0) {
              hits += 1
              const info = {
                index,
                role: message.role,
                sourceKind: (message.source && message.source.kind) || null,
                tier: (message.source && message.source.tier) || null,
                length: text.length,
                head: text.slice(0, 100),
              }
              if (hitList.length < 12) hitList.push(info)
              lastHit = info
            }
          })
          state.samples.push({
            at: new Date().toISOString(),
            messageCount: messages.length,
            hits,
            hitList,
            lastHit,
            optionKeys: options && typeof options === 'object' ? Object.keys(options) : [],
          })
        }
        void flush()
      } catch (error) {
        if (state.errors.length < 5) state.errors.push(String((error && error.message) || error))
      }
      return next()
    })
  } catch (error) {
    if (state.errors.length < 5) state.errors.push(String((error && error.message) || error))
    void flush()
  }
}
