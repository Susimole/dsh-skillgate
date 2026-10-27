// 读 skillgate.log，统计规则命中与误判面。
// 用法：node tools/lexicon-stats.mjs [--days 7] [--log <path>]

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const days = Number(argOf('--days', '7'))
const logPath = argOf('--log', join(homedir(), '.dsh', 'mode', 'skillgate.log'))
const since = Date.now() - days * 24 * 3600_000

let lines = []
try {
  const raw = await readFile(logPath, 'utf8')
  lines = raw.split('\n').filter(Boolean)
} catch {
  console.log(`没有日志：${logPath}`)
  process.exit(0)
}

const events = []
for (const line of lines) {
  try {
    const event = JSON.parse(line)
    if (Date.parse(event.at) >= since) events.push(event)
  } catch {
    // 坏行跳过
  }
}

const count = (items, key) => {
  const map = new Map()
  for (const item of items) {
    const k = key(item)
    if (k == null) continue
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

const rules = events.filter((e) => e.event === 'rule')
const skipped = events.filter((e) => e.event === 'rule-skipped')
const injects = events.filter((e) => e.event === 'inject')

console.log(`窗口：最近 ${days} 天 · 事件 ${events.length} 条（rule ${rules.length} / skipped ${skipped.length} / inject ${injects.length}）\n`)

console.log('命中按桶：')
for (const [bucket, n] of count(rules, (e) => e.bucket)) console.log(`  ${bucket.padEnd(14)} ${n}`)
console.log('\n命中按规则：')
for (const [rule, n] of count(rules, (e) => e.rule)) console.log(`  ${rule.padEnd(14)} ${n}`)

const switches = rules.filter((e) => e.from && e.to && e.from !== e.to)
console.log(`\n实际切档：${switches.length} 次`)
for (const [move, n] of count(switches, (e) => `${e.from} → ${e.to}`)) console.log(`  ${move.padEnd(18)} ${n}`)

if (skipped.length) {
  console.log('\n被手动锁挡下的规则（看看有没有该生效的）：')
  for (const e of skipped.slice(-5)) console.log(`  ${e.text ?? ''}`)
}

const recent = switches.slice(-8)
if (recent.length) {
  console.log('\n最近几次切换：')
  for (const e of recent) {
    console.log(`  ${e.at.slice(5, 16)}  ${e.from}→${e.to}  [${e.bucket}] ${e.rule} 「${e.text ?? ''}」`)
  }
}
