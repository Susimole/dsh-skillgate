// SkillGate 回放：把真实会话里的人话，逐条喂给判定器，看它会切几次档。
// 这是「误判面有多宽」的量化，不是正确性测试。
//
//   node tools/replay.mjs <messages.json>
//
// messages.json: [{ "text": "...", "at": "2026-10-28 00:44" }, ...]

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODULE = new URL('../plugin/index.js', import.meta.url)
const file = process.argv[2]
if (!file) {
  console.error('用法：node tools/replay.mjs <messages.json>')
  process.exit(2)
}

const messages = JSON.parse(await readFile(file, 'utf8'))

// 真实时间要喂进去：否则几十条消息在同一秒内跑完，hold 的 30 分钟窗口全乱。
const year = new Date().getFullYear()
const stampOf = (at) => {
  const m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at || '')
  if (!m) return Date.now()
  return new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4])).getTime()
}
const realNow = Date.now
Date.now = () => stampOf(currentAt)
let currentAt = ''
const { apply } = await import(MODULE)

const SKILLS = [
  'grilling', 'time-estimates', 'diagnosing-bugs', 'coding-discipline', 'research',
  'prototype', 'skill-creator', 'domain-modeling', 'diagnose-windows-sandbox-acl',
  'cordis-plugin-development', 'cordis-composition-reference', 'editing-cordis-compositions',
  'agent-experience', 'office', 'office-docx', 'office-xlsx', 'office-pptx', 'office-render',
  'office-export-pdf', 'office-recalculate', 'archify', 'writing-for-agents',
].map((name) => ({ name, description: `${name} 做什么` }))

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), 'sg-rp-'))
  const statePath = join(dir, 'state.json')
  let handler
  const ctx = {
    get(name) {
      if (name === 'skills') return { snapshot: async () => ({ complete: true, skills: SKILLS }) }
      if (name === 'workingDirectory') return { ensure: async () => 'D:\\work' }
      if (name === 'tools') return { register: () => {} }
      if (name === 'commands') return { register: () => {} }
      return undefined
    },
    on(name, fn) {
      if (name === 'agent/pre-step') handler = fn
      return () => {}
    },
  }
  // 插件不再内置词表，回放得自带一份（跟使用机上那份同形）。
  await writeFile(join(dir, 'lexicon.json'), JSON.stringify({
    enterWork: ['帮我看', '帮我查', '帮我找', '帮我在', '帮我改', '帮我做', '是不是坏了', '用不了', '报错', '继续做', '继续改', '是我做的'],
    exit: ['好了结束', '搞定', '收工', '先这样', '晚安', '只聊天', '别管这个', '先不弄了'],
    veto: ['先别动手', '仅讨论', '只讨论', '几个技能', '先别改'],
    enterDeliver: ['做成表', '出个图', '出张图', '生成表格', '做个表', '导出', '交接文件', '生成报告', '做个图', '出个表'],
    hold: ['继续', '接着干', '接着做', '继续吧'],
  }), 'utf8')
  apply(ctx, { statePath })
  const turn = async (text) => {
    const messagesIn = [
      { role: 'assistant', id: 'a', content: [{ type: 'text', text: '…' }] },
      { role: 'user', id: 'u', content: [{ type: 'text', text }], source: { kind: 'user' } },
    ]
    const decision = { kind: 'continue', messages: messagesIn }
    const out = await handler({ agent: { id: 's1' }, step: 1, messages: messagesIn }, async () => decision)
    return out
  }
  const tier = async () => {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      return state.sessions.s1 || state.default
    } catch {
      return 'daily'
    }
  }
  return { turn, tier, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// 连续模式：同一个会话，按时间顺序来。
const box = await fresh()
let tier = 'daily'
const rows = []
for (const [index, message] of messages.entries()) {
  currentAt = message.at
  await box.turn(message.text)
  const after = await box.tier()
  if (after !== tier) {
    rows.push({ index, at: message.at, from: tier, to: after, text: message.text.replace(/\s+/g, ' ').slice(0, 60) })
    tier = after
  }
}
await box.cleanup()

console.log(`共 ${messages.length} 条人话，连续模式下切档 ${rows.length} 次\n`)
for (const row of rows) {
  console.log(`${String(row.index).padStart(3)} ${row.at || ''}  ${row.from} → ${row.to}   «${row.text}»`)
}

// 独立模式：每条都是新会话的第一句，量「单句触发率」。
let hits = 0
for (const message of messages) {
  currentAt = message.at
  const solo = await fresh()
  await solo.turn(message.text)
  if ((await solo.tier()) !== 'daily') hits += 1
  await solo.cleanup()
}
console.log(`\n独立模式（每条都当新会话第一句）：${hits}/${messages.length} 条会当场切档`)
