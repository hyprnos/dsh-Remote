'use strict'
/**
 * 上传分块：真实执行 app.js 里的 uploadChunk，确保
 *  1) 发送的是传入的 ArrayBuffer（不再引用未定义的 blob）；
 *  2) 0 字节失败时能用 ArrayBuffer 重试一次；
 *  3) 错误信息带上 HTTP 状态。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
const start = source.indexOf('  const uploadChunk = (params, body, retried) =>')
assert.ok(start > 0)
const end = source.indexOf('\n  })\n', start) + '\n  })\n'.length
const chunkSource = source.slice(start, end)

function makeRuntime({ failFirst = false } = {}) {
  const sent = []
  let attempts = 0
  class FakeXHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = '' }
    open() {}
    setRequestHeader() {}
    send(body) {
      attempts += 1
      sent.push(body)
      queueMicrotask(() => {
        if (failFirst && attempts === 1) { this.status = 0; this.upload.onerror(); return }
        this.status = 201
        this.responseText = JSON.stringify({ ok: true, size: 3 })
        this.onload && this.onload()
      })
    }
  }
  const up = { offset: 0, size: 3, xhr: null, cancelled: false, active: true }
  const sandbox = {
    XMLHttpRequest: FakeXHR,
    Promise, queueMicrotask, Date, JSON, Number, Math, Uint8Array, ArrayBuffer, Blob, Object, Error, String,
    fsApiUrl: () => 'http://host/fs/upload',
    state: { token: 'tok' },
    CAP: { isNativePlatform: () => false },
    CLIENT_ID: 'cid',
    t: key => key,
    window: { DshNetwork: { profile: () => ({ weak: false }) } },
    showFsProgress: () => {},
    up: undefined,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext('const up = { offset: 0, size: 3, xhr: null, cancelled: false };\n' + chunkSource + '\nthis.uploadChunk = uploadChunk', sandbox)
  return { uploadChunk: sandbox.uploadChunk, sent, up: sandbox.up }
}

test('发送的是传入的 ArrayBuffer，不再引用未定义的 blob', async () => {
  const { uploadChunk, sent } = makeRuntime()
  const buffer = new ArrayBuffer(3)
  const result = await uploadChunk({ offset: '0', size: '3' }, buffer, false)
  assert.equal(result.status, 201)
  assert.equal(sent.length, 1)
  assert.equal(sent[0], buffer)
})

test('未重试时 0 字节失败会用 ArrayBuffer 重试（Blob 输入）', async () => {
  const { uploadChunk, sent } = makeRuntime({ failFirst: true })
  const blob = new Blob([new Uint8Array([1, 2, 3])])
  const result = await uploadChunk({ offset: '0', size: '3' }, blob, false)
  assert.equal(result.status, 201)
  assert.equal(sent.length, 2)
  assert.equal(Object.prototype.toString.call(sent[1]), '[object ArrayBuffer]', 'retry must send ArrayBuffer')
})

test('已重试过则直接失败并带上状态', async () => {
  const { uploadChunk } = makeRuntime({ failFirst: true })
  await assert.rejects(() => uploadChunk({ offset: '0', size: '3' }, new ArrayBuffer(3), true), /fs\.networkInterrupt/)
})
