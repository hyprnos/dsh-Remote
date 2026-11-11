'use strict'
/**
 * 用量统计纯函数：从 public/app.js 切片执行（不依赖 DOM）。
 * 覆盖每轮聚合、缺字段容错、排序与合计。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
const start = source.indexOf('/* >>> 用量统计纯函数区')
const end = source.indexOf('/* <<< 用量统计纯函数区')
assert.ok(start > 0 && end > start, 'usage pure-function markers missing')
const slice = source.slice(start, end)
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(slice.replace(/^\/\* >>> .*$/m, '') + '\nthis.collectTurnUsage = collectTurnUsage; this.usageTotals = usageTotals', sandbox)
const { collectTurnUsage, usageTotals } = sandbox

const msg = (turn, usage) => ({ event: { type: 'assistant/message', data: { turn, usage } } })

test('每轮用量按 turn 聚合，同轮多步相加', () => {
  const rows = collectTurnUsage([
    msg(1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 }),
    msg(1, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 }),
    msg(2, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 }),
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(Array.from(rows, r => r.turn), [1, 2])
  assert.equal(rows[0].input, 150)
  assert.equal(rows[0].output, 30)
  assert.equal(rows[0].cacheRead, 900)
  assert.equal(rows[0].steps, 2)
  assert.equal(rows[1].cacheWrite, 5)
})

test('忽略非 assistant/message、缺 usage、非法 turn', () => {
  const rows = collectTurnUsage([
    { event: { type: 'tool/call', data: { turn: 3 } } },
    msg(0, { inputTokens: 1 }),
    msg(3, null),
    msg(4, { outputTokens: 2 }),
    null,
    {},
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].turn, 4)
  assert.equal(rows[0].output, 2)
})

test('字段缺失按 0 计，合计等于各行之和', () => {
  const rows = collectTurnUsage([msg(1, { inputTokens: 10 }), msg(2, { outputTokens: 5, cacheReadTokens: 7 })])
  const totals = usageTotals(rows)
  assert.equal(totals.input, 10)
  assert.equal(totals.output, 5)
  assert.equal(totals.cacheRead, 7)
  assert.equal(totals.cacheWrite, 0)
  assert.equal(totals.turns, 2)
})

test('空输入返回空结果', () => {
  assert.equal(Array.from(collectTurnUsage(undefined)).length, 0)
  assert.equal(Array.from(collectTurnUsage([])).length, 0)
  assert.equal(usageTotals([]).turns, 0)
})
