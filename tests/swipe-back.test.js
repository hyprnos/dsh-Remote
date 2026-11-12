'use strict'
/** 侧滑返回判定：从 app.js 切片执行 swipeBackIntent。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
const start = source.indexOf('/* >>> 侧滑返回判定')
const end = source.indexOf('/* <<< 侧滑返回判定')
assert.ok(start > 0 && end > start)
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(source.slice(start, end).replace(/^\/\* >>> .*$/m, '') + '\nthis.swipeBackIntent = swipeBackIntent; this.doubleSwipeDecision = doubleSwipeDecision', sandbox)
const { swipeBackIntent, doubleSwipeDecision } = sandbox

test('左边缘向右滑足够远算返回', () => {
  assert.equal(swipeBackIntent({ startX: 4, startY: 400, endX: 120, endY: 406, elapsedMs: 260 }), true)
  assert.equal(swipeBackIntent({ startX: 32, startY: 400, endX: 100, endY: 400, elapsedMs: 200 }), true)
})

test('起手不在左边缘、距离太短或向左滑都不算', () => {
  assert.equal(swipeBackIntent({ startX: 200, startY: 400, endX: 320, endY: 400, elapsedMs: 200 }), false)
  assert.equal(swipeBackIntent({ startX: 10, startY: 400, endX: 40, endY: 400, elapsedMs: 200 }), false)
  assert.equal(swipeBackIntent({ startX: 10, startY: 400, endX: 2, endY: 400, elapsedMs: 200 }), false)
})

test('竖直位移过大（在滚动列表里横着划）或太慢不算返回', () => {
  assert.equal(swipeBackIntent({ startX: 8, startY: 200, endX: 140, endY: 420, elapsedMs: 200 }), false)
  assert.equal(swipeBackIntent({ startX: 8, startY: 200, endX: 140, endY: 200, elapsedMs: 1500 }), false)
})

test('右边缘向内左滑同样算返回', () => {
  const width = 390
  assert.equal(swipeBackIntent({ startX: width - 6, startY: 500, endX: width - 140, endY: 505, elapsedMs: 240, width }), true)
  // 右边缘但向右滑（反方向）不算
  assert.equal(swipeBackIntent({ startX: width - 6, startY: 500, endX: width + 60, endY: 500, elapsedMs: 200, width }), false)
  // 中间起手仍不算
  assert.equal(swipeBackIntent({ startX: 180, startY: 500, endX: 60, endY: 500, elapsedMs: 200, width }), false)
  // 右边缘竖直滚动不算
  assert.equal(swipeBackIntent({ startX: width - 6, startY: 200, endX: width - 140, endY: 380, elapsedMs: 300, width }), false)
})

test('防误触：第一次滑动只登记，窗口内第二次才返回', () => {
  const decide = (lastAt, now) => doubleSwipeDecision(lastAt, now, 1200)
  assert.equal(decide(0, 1000), 'pending')
  assert.equal(decide(1000, 1500), 'navigate')
  assert.equal(decide(1000, 2200), 'navigate')   // 恰好窗口内
  assert.equal(decide(1000, 2300), 'pending')    // 超过窗口重新计数
  assert.equal(decide(3000, 3100), 'navigate')
})

test('缺字段不抛错且视为非返回', () => {
  assert.equal(swipeBackIntent(), false)
  assert.equal(swipeBackIntent({}), false)
})
