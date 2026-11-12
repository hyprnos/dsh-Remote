'use strict'
/**
 * 更新包哈希：app.js 的 sha256Hex 在缺少 crypto.subtle（http 非安全上下文）时必须
 * 退回到 sha256.js 的纯 JS 实现，并与 Node 的 crypto 结果一致。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
const start = appSource.indexOf('async function sha256Hex(buffer)')
assert.ok(start > 0)
const end = appSource.indexOf('\n}\n', start) + 3
const shaSource = appSource.slice(start, end)
const libSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sha256.js'), 'utf8')

function makeContext(withSubtle) {
  const context = { Uint8Array, Uint32Array, Math, Error, console }
  context.globalThis = context
  if (withSubtle) context.crypto = { subtle: { digest: async (algo, buffer) => crypto.createHash('sha256').update(Buffer.from(buffer)).digest() } }
  vm.createContext(context)
  vm.runInContext(libSource, context)
  vm.runInContext(shaSource + '\nthis.sha256Hex = sha256Hex', context)
  return context
}

test('有 crypto.subtle 时走原生实现', async () => {
  const context = makeContext(true)
  const bytes = crypto.randomBytes(4096)
  const hex = await context.sha256Hex(bytes)
  assert.equal(hex, crypto.createHash('sha256').update(bytes).digest('hex'))
})

test('缺少 crypto.subtle（http 页面）时退回纯 JS 实现且结果一致', async () => {
  const context = makeContext(false)
  for (const size of [0, 1, 63, 64, 65, 1000, 65536]) {
    const bytes = crypto.randomBytes(size)
    const hex = await context.sha256Hex(bytes)
    assert.equal(hex, crypto.createHash('sha256').update(bytes).digest('hex'), 'size ' + size)
  }
})

test('20MB 更新包在纯 JS 路径下也能算出一致哈希', async () => {
  const context = makeContext(false)
  const bytes = crypto.randomBytes(20 * 1024 * 1024)
  const hex = await context.sha256Hex(bytes)
  assert.equal(hex, crypto.createHash('sha256').update(bytes).digest('hex'))
})
