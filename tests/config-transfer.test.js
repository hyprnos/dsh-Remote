'use strict'
/** 配置备份纯函数：切片执行 public/config-transfer.js，不依赖 DOM。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-transfer.js'), 'utf8')
const start = source.indexOf('/* >>> 纯函数区')
const end = source.indexOf('/* <<< 纯函数区')
assert.ok(start > 0 && end > start)
const slice = source.slice(start, end).replace(/^\/\* >>> .*$/m, '')
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(slice + '\nthis.collectConfig=collectConfig;this.parseConfig=parseConfig;this.applyConfig=applyConfig;this.describeConfig=describeConfig;this.wanted=wanted', sandbox)
const { collectConfig, parseConfig, applyConfig, describeConfig, wanted } = sandbox

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  return {
    get length() { return map.size },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
    dump: () => Object.fromEntries(map),
  }
}

test('备份包含服务器/令牌/偏好/主题，排除缓存与草稿', () => {
  const storage = fakeStorage({
    token: 'tok-1',
    'servers-v2': JSON.stringify({ servers: [{ id: 'a', url: 'http://h:8787' }] }),
    notify: '1',
    'dsr.theme': 'blue-fish',
    'dsr.voice.corrections': 'confit=config',
    'dsr.history.cache': '{"huge":true}',
    'composerDrafts': '{"x":1}',
    'dshApprovalRecordsV1:s1': '[]',
    unrelatedThirdParty: 'x',
  })
  const doc = collectConfig(storage, { appVersion: '0.8.14', now: 0 })
  assert.equal(doc.kind, 'dsh-remote-config')
  assert.equal(doc.schema, 1)
  assert.equal(doc.app, '0.8.14')
  assert.deepEqual(Object.keys(doc.values).sort(), ['dsr.theme', 'dsr.voice.corrections', 'notify', 'servers-v2', 'token'])
  const summary = describeConfig(JSON.stringify(doc))
  assert.equal(summary.keys, 5)
  assert.equal(summary.servers, 1)
  assert.equal(summary.hasToken, true)
})

test('wanted 过滤规则：前缀放行、缓存与草稿拒绝', () => {
  assert.equal(wanted('dsr.theme'), true)
  assert.equal(wanted('token'), true)
  assert.equal(wanted('imageCacheV1'), false)
  assert.equal(wanted('dsrHistoryCache'), false)
  assert.equal(wanted('dshApprovalRecordsV1:s'), false)
  assert.equal(wanted(''), false)
})

test('导入只接受合法文档并忽略未知/非字符串值', () => {
  const doc = { kind: 'dsh-remote-config', schema: 1, exportedAt: new Date().toISOString(), values: { token: 't2', notify: '0', bogusKey: 'x', 'dsr.theme': 5 } }
  const storage = fakeStorage({})
  const result = applyConfig(storage, JSON.stringify(doc))
  assert.equal(result.written, 2)
  assert.deepEqual(Array.from(result.keys).sort(), ['notify', 'token'])
  assert.deepEqual(storage.dump(), { token: 't2', notify: '0' })
})

test('非法文档给出可读错误', () => {
  assert.throws(() => parseConfig('not json'), /JSON/)
  assert.throws(() => parseConfig('{"kind":"other","schema":1,"values":{}}'), /DSH Remote/)
  assert.throws(() => parseConfig('{"kind":"dsh-remote-config","schema":9,"values":{}}'), /版本不兼容/)
  assert.throws(() => parseConfig('{"kind":"dsh-remote-config","schema":1}'), /values/)
})
