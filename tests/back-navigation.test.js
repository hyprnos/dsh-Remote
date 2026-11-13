'use strict'
/**
 * 返回键入口：window.__dshRemoteBack 必须返回布尔值——true 表示页面已处理，
 * false 才会交给系统退出。用假 DOM 跑真实的 bindNativeBack/handleAppBack 代码。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
const start = source.indexOf('/* 返回键统一入口')
const end = source.indexOf('function renderSessionTitle()', start)
assert.ok(start > 0 && end > start)
const code = source.slice(start, end)

function classList(hidden, extra) {
  const set = new Set(hidden ? ['hidden'] : [])
  if (extra) set.add(extra)
  return {
    contains: name => set.has(name),
    add: name => set.add(name),
    remove: name => set.delete(name),
    toggle: (name, on) => (on ? set.add(name) : set.delete(name)),
  }
}

function makeRuntime({ modal = false, session = false } = {}) {
  const nodes = {
    'composer-wrap': { classList: classList(false) },
    'composer-menu': { classList: classList(true) },
    'composer-image-menu': { classList: classList(true) },
    'view-settings': { classList: classList(true) },
    'settings-home': { classList: classList(false) },
    'view-plugins': { classList: classList(true) },
    'view-files': { classList: classList(true) },
    'view-home': { classList: classList(session) },
    'group-drawer': { classList: classList(true) },
  }
  const modalNode = { id: 'modal-notes', classList: classList(!modal) }
  const calls = []
  const document = {
    body: { classList: classList(false, session ? 'in-session' : null) },
    querySelector: sel => (sel === 'dialog[open]' ? null : null),
    querySelectorAll: sel => (sel === '.modal' ? [modalNode] : []),
  }
  const window = {}
  const sandbox = {
    document,
    window,
    console,
    Math,
    Object,
    Array,
    Number,
    String,
    CAP: { isNativePlatform: () => false },
    $: id => nodes[id] || null,
    state: { current: session ? 'session-1' : null, announcementItems: [] },
    customSelectCurrent: null,
    closeSession: () => calls.push('closeSession'),
    showView: view => calls.push('showView:' + view),
    showSettingsHome: () => calls.push('showSettingsHome'),
    fsUp: () => calls.push('fsUp'),
    closeNotesModal: () => { calls.push('closeNotesModal'); modalNode.classList.add('hidden') },
    closeArchiveConfirm() {}, closeRenameSession() {}, closeAppVersionWarning() {},
    closeLiveScan() {}, closeAnnouncement() {}, updateContextRing() {},
    groupDrawerOpen: () => false, closeGroupDrawer() {},
    setComposerFullscreen() {}, hideComposerMenu() {}, clearComposerImages() {},
    renderSessionPending() {}, setSessionRecovery() {}, renderSessions() {}, renderWorkbench() {},
    state_placeholder: null,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code + '\nthis.bindNativeBack = bindNativeBack', sandbox)
  sandbox.bindNativeBack()
  return { sandbox, calls, window }
}

test('暴露 window.__dshRemoteBack 供原生返回键调用', () => {
  const { window } = makeRuntime()
  assert.equal(typeof window.__dshRemoteBack, 'function')
})

test('有弹窗时返回 true 并关闭弹窗', () => {
  const { window, calls } = makeRuntime({ modal: true })
  assert.equal(window.__dshRemoteBack(), true)
  assert.deepEqual(calls, ['closeNotesModal'])
})

test('在会话里返回 true 并退出会话', () => {
  const { window, calls } = makeRuntime({ session: true })
  assert.equal(window.__dshRemoteBack(), true)
  assert.deepEqual(calls, ['closeSession'])
})

test('已在主页且无弹窗返回 false（交由系统退出）', () => {
  const { window } = makeRuntime()
  assert.equal(window.__dshRemoteBack(), false)
})

test('内部异常不会抛给原生，返回 false', () => {
  const { sandbox, window } = makeRuntime()
  sandbox.document.querySelectorAll = () => { throw new Error('boom') }
  assert.equal(window.__dshRemoteBack(), false)
})
