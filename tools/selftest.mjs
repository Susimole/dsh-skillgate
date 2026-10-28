// SkillGate 自检：不开 DSH，用假 ctx 直接驱动 agent/pre-step。
// 只验判定与注入的形状，不验 DSH 是否把消息落盘（那要真会话）。
//
//   node tools/selftest.mjs
//
// 退出码 0 = 全过；1 = 有用例失败。

import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const MODULE = new URL('../plugin/index.js', import.meta.url)

let pass = 0
let fail = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    fail += 1
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${String(error && error.message).replace(/\n/g, '\n       ')}`)
  }
}

// ---- 假环境 ----

function skill(name) {
  return { name, description: `${name} 做什么`, whenToUse: `${name} 何时用` }
}

const SKILLS = [
  'grilling', 'time-estimates',
  'diagnosing-bugs', 'coding-discipline', 'research', 'prototype', 'skill-creator',
  'domain-modeling', 'diagnose-windows-sandbox-acl', 'cordis-plugin-development',
  'cordis-composition-reference', 'editing-cordis-compositions', 'agent-experience',
  'office', 'office-docx', 'office-xlsx', 'office-pptx', 'office-render',
  'office-export-pdf', 'office-recalculate', 'archify', 'writing-for-agents',
].map(skill)

// 插件不再内置词表，用例自己带一份（跟使用机上 ~/.dsh/mode/lexicon.json 同形）。
const LEXICON = {
  enterWork: ['帮我看', '帮我查', '报错', '继续做'],
  exit: ['好了结束', '搞定', '晚安', '收工'],
  veto: ['先别动手', '仅讨论', '几个技能'],
  enterDeliver: ['做成表', '出个图', '交接文件', '导出'],
  hold: ['继续', '接着干'],
}

function userMsg(text, kind = 'user') {
  return { role: 'user', id: `u-${Math.random()}`, content: [{ type: 'text', text }], source: { kind } }
}

async function boot(options = {}) {
  const { apply } = await import(MODULE)
  const dir = options.dir || (await mkdtemp(join(tmpdir(), 'sg-')))
  const statePath = join(dir, 'state.json')
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const snapshot = options.snapshot || (async () => ({ complete: true, skills: SKILLS }))
  const ctx = {
    get(name) {
      if (name === 'skills') return { snapshot }
      if (name === 'workingDirectory') return { ensure: async () => 'D:\\work' }
      if (name === 'tools') return { register: (def) => tools.set(def.name, def) }
      if (name === 'commands') return {
        register: (def) => { commands.set(def.name, def); return () => commands.delete(def.name) },
        find: (_agent, commandName) => (commands.has(commandName) ? commands.get(commandName) : undefined),
      }
      return undefined
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
  }
  if (!options.noLexicon) await writeFile(join(dir, 'lexicon.json'), JSON.stringify(LEXICON), 'utf8')
  apply(ctx, { statePath, ...(options.config || {}) })
  const preStep = handlers.get('agent/pre-step')[0]

  async function step(num, text, extra = {}) {
    const messages = [{ role: 'assistant', id: 'a1', content: [{ type: 'text', text: '…' }] }]
    for (const m of extra.history || []) messages.push(m)
    if (text) messages.push(userMsg(text))
    const decision = { kind: 'continue', messages }
    const out = await preStep({ agent: { id: 's1' }, step: num, messages, ...extra }, async () => decision)
    return { added: out.messages.slice(messages.length), out, before: messages }
  }

  return {
    dir,
    statePath,
    turn: (text) => step(1, text),
    step,
    async read() {
      return JSON.parse(await readFile(statePath, 'utf8'))
    },
    async readOr(fallback) {
      try {
        return JSON.parse(await readFile(statePath, 'utf8'))
      } catch {
        return fallback
      }
    },
    write: (value) => writeFile(statePath, JSON.stringify(value), 'utf8'),
    run: (input) => commands.get('tier').handler({ rawInput: input, agent: { id: 's1' } }),
    tools,
    commands,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

const catalogOf = (added) => added.find((m) => m.source && m.source.kind === 'skillgate-tier')
const timeOf = (added) => added.find((m) => m.source && m.source.kind === 'skillgate-time')
const bodyOf = (message) => message.content.map((b) => b.text || '').join('')
const countIn = (text) => (text.match(/^- `/gm) || []).length

// ---- 第一轮 ----

console.log('第一轮：判定、注入、失败处理')

await test('空会话首轮：初始日常，注入 2 条', async () => {
  const g = await boot()
  const { added } = await g.turn('你好')
  const catalog = catalogOf(added)
  assert.ok(catalog, '没有目录注入')
  assert.equal(catalog.source.tier, 'daily')
  assert.equal(countIn(bodyOf(catalog)), 2)
  assert.equal((await g.readOr({ sessions: {} })).sessions.s1, undefined, '没切档不该写 sessions')
  await g.cleanup()
})

await test('「帮我看一下这个报错」→ 工作档，当轮 11 条', async () => {
  const g = await boot()
  const { added } = await g.turn('帮我看一下这个报错')
  const catalog = catalogOf(added)
  assert.equal(catalog.source.tier, 'work')
  assert.equal(countIn(bodyOf(catalog)), 11)
  assert.equal((await g.read()).sessions.s1, 'work')
  await g.cleanup()
})

await test('「晚安」→ 回到日常 2 条', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  const { added } = await g.turn('晚安')
  const catalog = catalogOf(added)
  assert.equal(catalog.source.tier, 'daily')
  assert.equal(countIn(bodyOf(catalog)), 2)
  await g.cleanup()
})

await test('「把这个做成表」→ 交付档 9 条', async () => {
  const g = await boot()
  const { added } = await g.turn('帮我把这个做成表')
  const catalog = catalogOf(added)
  assert.equal(catalog.source.tier, 'deliver')
  assert.equal(countIn(bodyOf(catalog)), 9)
  await g.cleanup()
})

await test('veto 优先于 enter-work：「先别动手，帮我看看」不动档', async () => {
  const g = await boot()
  await g.turn('你好')
  const { added } = await g.turn('先别动手，帮我看看这个')
  assert.equal(catalogOf(added), undefined, '不该换目录')
  assert.equal((await g.readOr({ sessions: {} })).sessions.s1, undefined, '不该切档')
  await g.cleanup()
})

await test('hold 无任务在飞：日常档说「继续」不动', async () => {
  const g = await boot()
  await g.turn('你好')
  const { added } = await g.turn('继续')
  assert.equal(catalogOf(added), undefined)
  await g.cleanup()
})

await test('hold 有任务在飞：日常说「继续」回工作', async () => {
  const g = await boot()
  await g.write({ version: 1, enabled: true, default: 'daily', sessions: { s1: 'daily' }, meta: { s1: { lastWorkAt: Date.now() - 5 * 60000 } }, deadlines: {} })
  await g.turn('你好') // 让模型先看见日常清单
  const { added } = await g.turn('继续')
  assert.equal(catalogOf(added).source.tier, 'work')
  await g.cleanup()
})

await test('hold 超出 30 分钟窗口：不回工作', async () => {
  const g = await boot()
  await g.write({ version: 1, enabled: true, default: 'daily', sessions: { s1: 'daily' }, meta: { s1: { lastWorkAt: Date.now() - 31 * 60000 } }, deadlines: {} })
  await g.turn('你好')
  const { added } = await g.turn('继续')
  assert.equal(catalogOf(added), undefined)
  await g.cleanup()
})

await test('手动锁：/tier daily 后 10 分钟内规则不生效', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  await g.run('daily')
  const { added } = await g.turn('帮我看看现在有多少插件启用')
  assert.equal(catalogOf(added).source.tier, 'daily', '手动锁内不该切档')
  assert.equal((await g.read()).sessions.s1, 'daily')
  await g.cleanup()
})

await test('手动锁过期后规则恢复', async () => {
  const g = await boot()
  await g.write({ version: 1, enabled: true, default: 'daily', sessions: { s1: 'daily' }, meta: { s1: { manualAt: Date.now() - 11 * 60000 } }, deadlines: {} })
  const { added } = await g.turn('帮我看一下这个报错')
  assert.equal(catalogOf(added).source.tier, 'work')
  await g.cleanup()
})

await test('state.json 损坏：不抛，坏文件留备份', async () => {
  const g = await boot()
  const garbage = '{{{ 不是 json'
  await writeFile(g.statePath, garbage, 'utf8')
  const { added } = await g.turn('帮我看一下这个报错')
  assert.ok(added.length > 0, '损坏后应当照常工作')
  const files = await readdir(g.dir)
  const bad = files.find((f) => f.startsWith('state.json.bad-'))
  assert.ok(bad, '损坏的文件被默默覆盖了，没有任何踪迹')
  assert.equal(await readFile(join(g.dir, bad), 'utf8'), garbage)
  const rawNow = await readFile(g.statePath, 'utf8')
  assert.doesNotThrow(() => JSON.parse(rawNow))
  await g.cleanup()
})

await test('上游 skills 抛错：不抛、不注入', async () => {
  const g = await boot({ snapshot: async () => { throw new Error('挂') } })
  const { added } = await g.turn('帮我看一下这个报错')
  assert.equal(added.length, 0)
  await g.cleanup()
})

await test('skills 快照 incomplete：不注入目录', async () => {
  const g = await boot({ snapshot: async () => ({ complete: false, skills: SKILLS }) })
  const { added } = await g.turn('帮我看一下这个报错')
  assert.equal(catalogOf(added), undefined)
  await g.cleanup()
})

await test('注入消息：深冻结、自有 id、自有 kind', async () => {
  const g = await boot()
  const { added } = await g.turn('帮我看一下这个报错')
  const m = catalogOf(added)
  assert.equal(Object.isFrozen(m), true, '顶层没冻结')
  assert.equal(Object.isFrozen(m.content[0]), true, 'content 没冻结')
  assert.ok(m.id && m.id.length > 10, '缺 id')
  assert.notEqual(m.source.kind, 'skill-catalog')
  await g.cleanup()
})

await test('不改写入参：decision.messages 保持原样', async () => {
  const g = await boot()
  const { before, out } = await g.step(1, '帮我看一下这个报错')
  assert.equal(before.length, 2, '入参数组被改了')
  assert.equal(out.messages.length, 4, '应当是原 2 条 + 目录 + 时间行')
  await g.cleanup()
})

await test('轮中（step 2）不注入', async () => {
  const g = await boot()
  const { added } = await g.step(2, '帮我看一下这个报错')
  assert.equal(added.length, 0)
  await g.cleanup()
})

// ---- 第二轮 ----

console.log('第二轮：时间行、开关、踩过的坑')

await test('时间行：首轮发，10 分钟内不重复发', async () => {
  const g = await boot()
  const first = await g.turn('你好')
  assert.ok(timeOf(first.added), '首轮应发时间行')
  const second = await g.turn('在吗')
  assert.equal(timeOf(second.added), undefined, '10 分钟内不该重发')
  await g.cleanup()
})

await test('时间行：有截止 → 每轮都发，且带剩余', async () => {
  const g = await boot()
  await g.write({
    version: 1, enabled: true, default: 'daily', sessions: {}, meta: {},
    deadlines: { s1: { at: Date.now() + 20 * 60000, note: '收尾', remindedAt: null } },
  })
  await g.turn('好')
  const { added } = await g.turn('嗯')
  const line = timeOf(added)
  assert.ok(line, '有截止应每轮发')
  assert.match(bodyOf(line), /剩 \d+ 分钟/)
  await g.cleanup()
})

await test('截止到期只提醒一次（remindedAt 落盘）', async () => {
  const g = await boot()
  await g.write({
    version: 1, enabled: true, default: 'daily', sessions: {}, meta: {},
    deadlines: { s1: { at: Date.now() - 1000, note: '收尾', remindedAt: null } },
  })
  const first = await g.turn('好')
  assert.match(first.added.map(bodyOf).join('\n'), /截止已到/)
  await new Promise((r) => setTimeout(r, 600)) // 跨过 500ms 状态缓存
  const second = await g.turn('嗯')
  assert.equal(/截止已到/.test(second.added.map(bodyOf).join('\n')), false, '提醒重复了')
  await g.cleanup()
})

await test('/tier off 后不再注入', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  await g.run('off')
  const { added } = await g.turn('帮我看一下这个报错')
  assert.equal(added.length, 0)
  await g.cleanup()
})

await test('/tier on 之后重新注入当前档位清单', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  await g.run('off')
  await g.turn('嗯')
  await g.run('on')
  const { added } = await g.turn('嗯')
  assert.ok(catalogOf(added), '开关切回来没重发清单，模型会一直看着旧档位')
  await g.cleanup()
})

await test('历史里的时间行不会被当成用户原话（备注里的「帮我看」不该切工作）', async () => {
  const g = await boot()
  const timeLine = {
    role: 'user', id: 't1', source: { kind: 'skillgate-time' },
    content: [{ type: 'text', text: '<system-reminder>\n⏱ 01:00 · 本会话 5 分钟 · 截止已到（帮我看完这个报错就好）\n</system-reminder>' }],
  }
  const { added } = await g.step(1, '', { history: [timeLine] })
  const catalog = catalogOf(added)
  assert.equal(catalog && catalog.source.tier, 'daily', '把时间行当成了用户原话，切了档')
  assert.equal((await g.readOr({ sessions: {} })).sessions.s1, undefined)
  await g.cleanup()
})

await test('插件重装后「本会话时长」不归零（起始时刻落盘）', async () => {
  const a = await boot()
  await a.turn('你好')
  const saved = await a.read()
  assert.ok(saved.meta.s1.startedAt > 0, '会话起始时刻没落盘')

  // 模拟重装：新实例吃同一个 state.json
  const b = await boot({ dir: a.dir })
  const state = await b.read()
  state.meta.s1.startedAt = Date.now() - 45 * 60000
  await b.write(state)
  const { added } = await b.turn('嗯')
  assert.match(bodyOf(timeOf(added)), /45 分钟/, '重装后把会话时长从零算起了')
  await b.cleanup()
})

await test('未知技能默认落日常（v0.1 脚手架行为，先钉住）', async () => {
  const g = await boot({ snapshot: async () => ({ complete: true, skills: [...SKILLS, skill('brand-new-skill')] }) })
  const { added } = await g.turn('你好')
  assert.match(bodyOf(catalogOf(added)), /brand-new-skill/, '新技能应出现在日常档（可能并不该）')
  await g.cleanup()
})

console.log('第三轮：分类结果（tiers.json）')

await test('tiers.json 存在：按它分档，内置表让位', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'tiers.json'), JSON.stringify({
    work: ['grilling'],
    deliver: ['office', 'archify'],
    daily: ['time-estimates'],
  }), 'utf8')
  const { added } = await g.turn('你好')
  const catalog = catalogOf(added)
  assert.equal(catalog.source.tier, 'daily')
  assert.match(bodyOf(catalog), /time-estimates/)
  assert.equal(/grilling/.test(bodyOf(catalog)), false, 'grilling 已被划进工作档，不该出现在日常')
  await g.cleanup()
})

await test('tiers.json 全空：当成没有，退回内置表', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'tiers.json'), JSON.stringify({ work: [], deliver: [], daily: [] }), 'utf8')
  const { added } = await g.turn('你好')
  assert.equal(countIn(bodyOf(catalogOf(added))), 2, '应退回内置表（日常 2 条）')
  await g.cleanup()
})

await test('tiers.json 损坏：不崩，退回内置表', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'tiers.json'), '{{{', 'utf8')
  const { added } = await g.turn('你好')
  assert.equal(countIn(bodyOf(catalogOf(added))), 2)
  await g.cleanup()
})

await test('没被分类的技能进日常时会留痕', async () => {
  const g = await boot({ snapshot: async () => ({ complete: true, skills: [...SKILLS, skill('brand-new-skill')] }) })
  await writeFile(join(g.dir, 'tiers.json'), JSON.stringify({ work: ['research'], deliver: ['office'], daily: ['grilling'] }), 'utf8')
  await g.turn('你好')
  const lines = (await readFile(join(g.dir, 'skillgate.log'), 'utf8')).trim().split(/\r?\n/).map((l) => JSON.parse(l))
  const unclassified = lines.find((l) => l.event === 'unclassified')
  assert.ok(unclassified, '没有记录未分类技能')
  assert.ok(unclassified.names.includes('brand-new-skill'))
  await g.cleanup()
})

console.log('第四轮：安装时分类')

await test('classify：模型返回带代码块的 JSON 也能解析并写文件', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'classifier.json'), JSON.stringify({ endpoint: 'http://x/v1/chat/completions', model: 'm' }), 'utf8')
  const items = SKILLS.map((item) => ({
    name: item.name,
    tier: item.name === 'office' ? 'deliver' : item.name === 'research' ? 'work' : 'daily',
    reason: '测试',
    uncertain: false,
  }))
  const reply = '```json\n' + JSON.stringify({ items }) + '\n```'
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) })
  try {
    const out = await g.run('classify')
    assert.equal(out.kind, 'success')
    const written = JSON.parse(await readFile(join(g.dir, 'tiers.json'), 'utf8'))
    assert.equal(written.work.length, 1)
    assert.equal(written.deliver.length, 1)
    assert.equal(written.daily.length, SKILLS.length - 2)
  } finally {
    globalThis.fetch = realFetch
  }
  await g.cleanup()
})

await test('classify dry：不写文件', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'classifier.json'), JSON.stringify({ endpoint: 'http://x' }), 'utf8')
  const items = [{ name: 'grilling', tier: 'work', reason: 'x', uncertain: false }]
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }] }) })
  try {
    const out = await g.run('classify dry')
    assert.equal(out.kind, 'success')
    await assert.rejects(() => readFile(join(g.dir, 'tiers.json'), 'utf8'))
  } finally {
    globalThis.fetch = realFetch
  }
  await g.cleanup()
})

await test('classify：接口报错时不写文件、回错误', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'classifier.json'), JSON.stringify({ endpoint: 'http://x' }), 'utf8')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500 })
  try {
    const out = await g.run('classify')
    assert.equal(out.kind, 'error')
    await assert.rejects(() => readFile(join(g.dir, 'tiers.json'), 'utf8'))
  } finally {
    globalThis.fetch = realFetch
  }
  await g.cleanup()
})

await test('classify：没配端点时明确报错', async () => {
  const g = await boot()
  const out = await g.run('classify')
  assert.equal(out.kind, 'error')
  assert.match(out.text, /classifier\.json/)
  await g.cleanup()
})

console.log('第五轮：一个技能可以属于多档')

await test('同一技能同时在工作档和日常档：两边清单里都有它', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'tiers.json'), JSON.stringify({
    work: ['grilling', 'research'],
    deliver: [],
    daily: ['grilling'],
  }), 'utf8')
  const daily = await g.turn('你好')
  assert.match(bodyOf(catalogOf(daily.added)), /grilling/, '日常档没有 grilling')
  await g.run('work')
  const work = await g.turn('在吗')
  assert.match(bodyOf(catalogOf(work.added)), /grilling/, '工作档没有 grilling')
  await g.cleanup()
})

await test('classify 不覆盖 manual 里钉死的归属', async () => {
  const g = await boot()
  await writeFile(join(g.dir, 'classifier.json'), JSON.stringify({ endpoint: 'http://x' }), 'utf8')
  await writeFile(join(g.dir, 'tiers.json'), JSON.stringify({
    work: [], deliver: [], daily: [],
    manual: { grilling: ['daily'] },
  }), 'utf8')
  const items = [{ name: 'grilling', tier: 'work', reason: 'x', uncertain: false }]
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }] }) })
  try {
    await g.run('classify')
    const written = JSON.parse(await readFile(join(g.dir, 'tiers.json'), 'utf8'))
    assert.equal(written.daily.includes('grilling'), true, 'manual 钉的日常被分类覆盖了')
    assert.equal(written.work.includes('grilling'), false)
    assert.deepEqual(written.manual, { grilling: ['daily'] })
  } finally {
    globalThis.fetch = realFetch
  }
  await g.cleanup()
})

console.log('第六轮：词表不内置')

await test('没有 lexicon.json：空词表，任何规则都不触发', async () => {
  const g = await boot({ noLexicon: true })
  const { added } = await g.turn('帮我看一下这个报错')
  const catalog = catalogOf(added)
  assert.equal(catalog.source.tier, 'daily', '没有词表还自动切档了')
  await g.cleanup()
})

await test('lexicon.json 存在：规则照常', async () => {
  const g = await boot()
  const { added } = await g.turn('帮我看一下这个报错')
  assert.equal(catalogOf(added).source.tier, 'work')
  await g.cleanup()
})

console.log('第七轮：引用与祈使')

await test('引用里的触发词不算数：「把我做成表」写在引号里', async () => {
  const g = await boot()
  await g.turn('你好')
  const { added } = await g.turn('讨论时引用一句「把我做成表」当例子')
  assert.equal(catalogOf(added), undefined, '引号里的词触发了切档')
  await g.cleanup()
})

await test('引用里的触发词不算数：代码块里提到的词', async () => {
  const g = await boot()
  await g.turn('你好')
  const { added } = await g.turn('先把这个词记下来：`做成表`')
  assert.equal(catalogOf(added), undefined, '代码块里的词触发了切档')
  await g.cleanup()
})

await test('弯引号里的触发词也不算数', async () => {
  const g = await boot()
  await g.turn('你好')
  const { added } = await g.turn('他说了一句“交接文件”，我记住了')
  assert.equal(catalogOf(added), undefined, '弯引号里的词触发了切档')
  await g.cleanup()
})

await test('真需求照旧：引号外还有「帮我」', async () => {
  const g = await boot()
  const { added } = await g.turn('帮我看看这个"报错"是怎么回事')
  assert.equal(catalogOf(added).source.tier, 'work')
  await g.cleanup()
})

await test('光提到「交接文件」不切交付：没有祈使', async () => {
  const g = await boot()
  await g.turn('你好')
  const { added } = await g.turn('这是我们的聊天日志和交接文件，确认没丢东西')
  assert.equal(catalogOf(added), undefined, '陈述句里的名词触发了交付档')
  await g.cleanup()
})

await test('真让人做表：有祈使，切交付', async () => {
  const g = await boot()
  const { added } = await g.turn('帮我把这个做成表')
  assert.equal(catalogOf(added).source.tier, 'deliver')
  await g.cleanup()
})

await test('「生成一个交接文件」：带祈使，切交付', async () => {
  const g = await boot()
  const { added } = await g.turn('生成一个交接文件')
  assert.equal(catalogOf(added).source.tier, 'deliver')
  await g.cleanup()
})

console.log('第八轮：词表的增删')

await test('add：加进去立刻生效，下一轮就能匹配到', async () => {
  const g = await boot({ noLexicon: true })
  const out = await g.run('add enterWork 崩了')
  assert.equal(out.kind, 'success')
  const { added } = await g.turn('又崩了，帮我看看')
  assert.equal(catalogOf(added).source.tier, 'work')
  await g.cleanup()
})

await test('add：中文桶名也认', async () => {
  const g = await boot({ noLexicon: true })
  const out = await g.run('add 交付 出份报告')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /enterDeliver/)
  await g.cleanup()
})

await test('add：重复的不重复加', async () => {
  const g = await boot()
  const out = await g.run('add enterWork 报错')
  assert.match(out.text, /已经有/)
  await g.cleanup()
})

await test('rm：给桶删；不给桶就全桶找', async () => {
  const g = await boot()
  const a = await g.run('rm veto 几个技能')
  assert.equal(a.kind, 'success')
  const b = await g.run('rm 晚安')
  assert.equal(b.kind, 'success')
  assert.match(b.text, /exit/)
  const c = await g.run('rm 不存在的话')
  assert.equal(c.kind, 'error')
  await g.cleanup()
})

await test('lexicon：报条数', async () => {
  const g = await boot()
  const out = await g.run('lexicon')
  assert.match(out.text, /enterWork 4/)
  await g.cleanup()
})

await test('删光了就是空词表，不自动切档', async () => {
  const g = await boot()
  for (const rule of ['帮我看', '帮我查', '报错', '继续做']) await g.run(`rm enterWork ${rule}`)
  const { added } = await g.turn('帮我看一下这个报错')
  assert.equal(catalogOf(added).source.tier, 'daily', '词表空了还在切档')
  await g.cleanup()
})

console.log('第九轮：模糊句不猜')

await test('「救救我」不切档：没有宾语、没有动作，规则不该猜', async () => {
  const g = await boot()
  await g.turn('你好')
  const { added } = await g.turn('救救我')
  assert.equal(catalogOf(added), undefined, '模糊感叹句被当成了干活信号')
  await g.cleanup()
})

await test('同样的词进了真请求就该切：「救命，这个报错查不出来」', async () => {
  const g = await boot()
  const { added } = await g.turn('救命，这个报错查不出来')
  assert.equal(catalogOf(added).source.tier, 'work')
  await g.cleanup()
})

console.log('第十轮：命令自愈')

await test('命令被弄丢了：下一轮自己补回来', async () => {
  const g = await boot()
  assert.ok(g.commands.has('tier'), '一开始就没注册上')
  g.commands.delete('tier') // 模拟重装插件后注册丢失
  await g.turn('你好')
  assert.ok(g.commands.has('tier'), '没有自愈')
  await g.cleanup()
})

await test('命令还在：不重复注册', async () => {
  const g = await boot()
  const first = g.commands.get('tier')
  await g.turn('你好')
  assert.equal(g.commands.get('tier'), first, '把命令换成了新的定义')
  await g.cleanup()
})

console.log('第十一轮：v0.4 冻结与回退')

await test('冻结：刚升到工作档，3 轮内的第二次升档不生效', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  const blocked = await g.turn('帮我把这个做成表')
  assert.equal(catalogOf(blocked.added), undefined, '冻结期内不该再升档')
  assert.equal((await g.read()).sessions.s1, 'work')
  await g.cleanup()
})

await test('冻结不影响降档：升完档马上说晚安，照样回日常', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  const out = await g.turn('晚安')
  assert.equal(catalogOf(out.added).source.tier, 'daily')
  await g.cleanup()
})

await test('回退：升档后两轮一次工具都没调，退回原档', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  await g.turn('嗯')
  const third = await g.turn('嗯')
  assert.equal(catalogOf(third.added).source.tier, 'daily', '没有回退')
  assert.equal((await g.read()).sessions.s1, 'daily')
  await g.cleanup()
})

await test('回退不误伤：这两轮里调过工具就留着', async () => {
  const g = await boot()
  await g.turn('帮我看一下这个报错')
  await g.turn('嗯')
  const third = await g.step(1, '嗯', {
    history: [
      { role: 'assistant', id: 't0', content: [{ type: 'text', text: '…' }] },
      { role: 'assistant', id: 't1', content: [{ type: 'tool_use', name: 'now' }] },
    ],
  })
  assert.equal(catalogOf(third.added), undefined, '调过工具还被回退了')
  assert.equal((await g.read()).sessions.s1, 'work')
  await g.cleanup()
})

console.log('')

if (fail) {
  console.log(`${pass} 过 / ${fail} 失败`)
  for (const { name, error } of failures) console.log(`\n✗ ${name}\n${error && error.stack}`)
  process.exitCode = 1
} else {
  console.log(`${pass} 全过`)
}
