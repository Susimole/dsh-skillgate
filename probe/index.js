// SkillGate 探针：只读。
// 目标只有一个——搞清楚技能清单究竟注入在哪一段（section 还是 context）、
// 长什么样、换一轮会不会变，好判定"重写目录"这条路能不能走。
// 任何异常都不允许影响对话：观察逻辑全部包在 try/catch 里，写文件失败就放弃。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const START = '<available_skills>'
const END = '</available_skills>'
const MAX_TEXT = 400

export function apply(ctx, config = {}) {
  const reportPath = typeof config.reportPath === 'string'
    ? config.reportPath
    : 'D:/Ai_work/skillgate/probe-report.json'
  const maxSamples = Number.isInteger(config.maxSamples) ? config.maxSamples : 6

  const state = {
    version: 1,
    startedAt: new Date().toISOString(),
    assemblies: 0,
    skillsApi: null,
    samples: [],
    errors: [],
  }
  let lastSignature = ''
  let writing = false

  function noteError(where, error) {
    if (state.errors.length >= 10) return
    state.errors.push({ where, at: new Date().toISOString(), message: String(error && error.message || error) })
  }

  function clip(text, from, to) {
    return typeof text === 'string' ? text.slice(Math.max(0, from), Math.max(from, to)).slice(0, MAX_TEXT) : ''
  }

  function scan(assembly) {
    const hits = []
    for (const kind of ['sections', 'contexts']) {
      const items = Array.isArray(assembly?.[kind]) ? assembly[kind] : []
      for (const item of items) {
        const text = typeof item?.text === 'string' ? item.text : ''
        const at = text.indexOf(START)
        if (at < 0) continue
        const close = text.indexOf(END, at)
        const block = close > at ? text.slice(at, close + END.length) : text.slice(at)
        const names = []
        for (const line of block.split('\n')) {
          const match = /^- `([^`]+)`/.exec(line)
          if (match) names.push(match[1])
        }
        hits.push({
          where: kind,
          name: typeof item?.name === 'string' ? item.name : null,
          order: typeof item?.order === 'number' ? item.order : null,
          complete: item?.complete === true,
          textLength: text.length,
          blockStart: at,
          blockEnd: close,
          entryCount: names.length,
          names,
          beforeBlock: clip(text, at - 160, at),
          afterBlock: close > at ? clip(text, close + END.length, close + END.length + 160) : '',
          blockHead: block.slice(0, MAX_TEXT),
          blockTail: block.slice(-MAX_TEXT),
        })
      }
    }
    return hits
  }

  function snapshot(assembly, context) {
    const keys = Object.keys(assembly || {})
    return {
      at: new Date().toISOString(),
      keys,
      sectionNames: (assembly?.sections || []).map((s) => ({
        name: s?.name ?? null,
        length: typeof s?.text === 'string' ? s.text.length : 0,
      })),
      contextNames: (assembly?.contexts || []).map((c) => ({
        name: c?.name ?? null,
        length: typeof c?.text === 'string' ? c.text.length : 0,
      })),
      hasScope: Boolean(context && context.scope),
      hits: scan(assembly),
    }
  }

  async function probeSkillsApi() {
    if (state.skillsApi) return
    try {
      const service = ctx.get('skills')
      if (!service) {
        state.skillsApi = { ok: false, reason: 'service-missing' }
        return
      }
      const list = await service.list({})
      state.skillsApi = {
        ok: true,
        count: Array.isArray(list) ? list.length : null,
        names: Array.isArray(list) ? list.map((s) => s?.name).filter(Boolean) : [],
      }
    } catch (error) {
      state.skillsApi = { ok: false, reason: String(error && error.message || error) }
    }
  }

  async function flush() {
    if (writing) return
    writing = true
    try {
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      // 探针写不出报告不算故障，绝不能因此打断对话
    } finally {
      writing = false
    }
  }

  try {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next()
      try {
        state.assemblies += 1
        void probeSkillsApi()
        const sample = snapshot(result, context)
        // 只在与上一轮结构不同时留样，避免刷屏
        const signature = JSON.stringify(sample.sectionNames) + '|' + JSON.stringify(sample.contextNames)
          + '|' + JSON.stringify(sample.hits.map((h) => [h.where, h.name, h.entryCount]))
        if (signature !== lastSignature) {
          lastSignature = signature
          state.samples.push(sample)
          if (state.samples.length > maxSamples) state.samples.splice(0, state.samples.length - maxSamples)
        }
        void flush()
      } catch (error) {
        noteError('observe', error)
      }
      return result
    })
  } catch (error) {
    noteError('register', error)
    void flush()
  }
}
