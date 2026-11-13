'use strict'
/**
 * 侧滑返回的「接线」测试：用最小假 DOM 跑真实的 bindSwipeBack/requestBack 代码，
 * 模拟 touchstart → touchmove → touchend，确认确实调用到返回导航。
 * 之前几版的问题都出在这层接线，而不是判定函数本身。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
function slice(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, 'slice ' + from)
  return source.slice(start, end)
}

const pureRegion = slice('/* >>> 侧滑返回判定', '/* <<< 侧滑返回判定 */')
const backRegion = slice('// 统一的「返回请求」入口', 'function renderSessionTitle()')

function makeRuntime({ inComposer = false } = {}) {
  const listeners = new Map()
  const bodyChildren = []
  const document = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    getElementById: () => null,
    createElement: () => ({
      classList: { add() {}, remove() {} },
      setAttribute() {},
      textContent: '',
    }),
    body: { appendChild: node => bodyChildren.push(node) },
  }
  const hits = []
  const sandbox = {
    document,
    window: { innerWidth: 390 },
    console,
    Math,
    Number,
    Object,
    Array,
    Date,
    setTimeout: () => 0,
    clearTimeout: () => {},
    state: { current: 'session-1' },
    closeSession: () => hits.push('closeSession'),
    handleAppBack: () => hits.push('handleAppBack'),
    toast: () => {},
    t: key => key,
    $: () => null,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(pureRegion + backRegion + '\nthis.bindSwipeBack = bindSwipeBack', sandbox)
  sandbox.bindSwipeBack()
  return { sandbox, listeners, hits }
}

function touch(x, y) { return { clientX: x, clientY: y } }
function emit(listeners, type, { x, y, target } = {}) {
  const handler = listeners.get(type)
  assert.ok(handler, 'listener ' + type)
  if (type === 'touchstart' || type === 'touchmove') handler({ touches: x === undefined ? [] : [touch(x, y)], target })
  else handler({ changedTouches: x === undefined ? [] : [touch(x, y)] })
}

test('屏幕中间向右长滑会触发返回（不依赖系统边缘手势）', () => {
  const { listeners, hits } = makeRuntime()
  emit(listeners, 'touchstart', { x: 300, y: 600 })
  emit(listeners, 'touchmove', { x: 150, y: 605 })
  assert.deepEqual(hits, ['handleAppBack'])
})

test('滑动距离不足不触发', () => {
  const { listeners, hits } = makeRuntime()
  emit(listeners, 'touchstart', { x: 300, y: 600 })
  emit(listeners, 'touchend', { x: 250, y: 600 })
  assert.deepEqual(hits, [])
})

test('竖直滚动不会误触发', () => {
  const { listeners, hits } = makeRuntime()
  emit(listeners, 'touchstart', { x: 300, y: 200 })
  emit(listeners, 'touchmove', { x: 340, y: 500 })
  assert.deepEqual(hits, [])
})

test('输入框内的滑动不参与返回手势', () => {
  const { listeners, hits } = makeRuntime()
  const composer = { closest: sel => (sel === '#composer-wrap' ? {} : null) }
  emit(listeners, 'touchstart', { x: 300, y: 900, target: composer })
  emit(listeners, 'touchmove', { x: 120, y: 905, target: composer })
  assert.deepEqual(hits, [])
})

test('右边缘向左滑也能返回', () => {
  const { listeners, hits } = makeRuntime()
  emit(listeners, 'touchstart', { x: 380, y: 500 })
  emit(listeners, 'touchmove', { x: 250, y: 505 })
  assert.deepEqual(hits, ['handleAppBack'])
})

test('同一次手势的原生+JS 双上报只导航一次', () => {
  const { sandbox, listeners, hits } = makeRuntime()
  emit(listeners, 'touchstart', { x: 300, y: 600 })
  emit(listeners, 'touchmove', { x: 150, y: 600 })
  sandbox.requestBack()   // 模拟系统 backButton 紧接着上报
  assert.deepEqual(hits, ['handleAppBack'])
})
