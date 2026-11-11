'use strict'
// public/voice-input.js 的契约测试。
// 一、纯函数（WAV 头、规范 base64、入口可见性、光标插入）：切片源码在新 vm context 里执行。
// 二、mount() 运行时链路：假 DOM/媒体 API 下跑 录音→16k WAV→speech.transcribe→插入光标处。
// 范式同 tests/composer-steer.test.js，不加载真实 DOM、不联网。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../public/voice-input.js'), 'utf8')
const start = source.indexOf('/* >>> 纯函数区')
const end = source.indexOf('/* <<< 纯函数区')
assert.ok(start >= 0 && end > start, 'voice-input.js 缺少纯函数区标记')
const code = source.slice(start, end)

function load() {
  const context = vm.createContext({
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary')
  })
  vm.runInContext(code + ';this.api={encodeWav,toBase64,decodeBase64,shouldShowMic,insertAtCursor};', context)
  return context.api
}
const bytesOf = view => Buffer.from(Array.from(view))

test('WAV 头满足宿主强校验：RIFF/WAVE/fmt /data、16kHz、单声道、PCM16、长度自洽', () => {
  const api = load()
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const wav = api.encodeWav(samples, 16000)
  const buf = bytesOf(wav)
  assert.equal(wav.length, 44 + samples.length * 2)
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF')
  assert.equal(buf.readUInt32LE(4), wav.length - 8)
  assert.equal(buf.toString('latin1', 8, 12), 'WAVE')
  assert.equal(buf.toString('latin1', 12, 16), 'fmt ')
  assert.equal(buf.readUInt32LE(16), 16)
  assert.equal(buf.readUInt16LE(20), 1)
  assert.equal(buf.readUInt16LE(22), 1)
  assert.equal(buf.readUInt32LE(24), 16000)
  assert.equal(buf.readUInt32LE(28), 32000)
  assert.equal(buf.readUInt16LE(32), 2)
  assert.equal(buf.readUInt16LE(34), 16)
  assert.equal(buf.toString('latin1', 36, 40), 'data')
  assert.equal(buf.readUInt32LE(40), wav.length - 44)
  assert.equal(buf.readUInt32LE(40) % 2, 0)
  assert.ok(wav.length >= 46)
  assert.equal(buf.readInt16LE(44), 0)
  assert.equal(buf.readInt16LE(46), 16384)
  assert.equal(buf.readInt16LE(48), -16384)
  assert.equal(buf.readInt16LE(50), 32767)
  assert.equal(buf.readInt16LE(52), -32768)
})

test('WAV 采样率默认 16kHz，超范围采样被削波而不是溢出', () => {
  const api = load()
  const buf = bytesOf(api.encodeWav(new Float32Array([2, -2, Number.NaN])))
  assert.equal(buf.readUInt32LE(24), 16000)
  assert.equal(buf.readUInt32LE(28), 32000)
  assert.equal(buf.readInt16LE(44), 32767)
  assert.equal(buf.readInt16LE(46), -32768)
  assert.equal(buf.readInt16LE(48), 0)
  assert.equal(buf.readUInt32LE(40), 6)
  assert.equal(buf.readUInt32LE(4), 6 + 36)
})

test('base64 规范：无换行、无 data: 前缀、长度 %4==0、往返一致、大文件分块', () => {
  const api = load()
  const small = api.encodeWav(new Float32Array([0.1, -0.2, 0.3]), 16000)
  const text = api.toBase64(small)
  assert.match(text, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.equal(text.length % 4, 0)
  assert.equal(text.includes('\n'), false)
  assert.equal(text.includes('\r'), false)
  assert.equal(text.startsWith('data:'), false)
  assert.deepEqual(bytesOf(api.decodeBase64(text)), bytesOf(small))

  // 360k 样本 ≈ 720 KB：远超单次 String.fromCharCode 参数上限，验证分块不爆栈。
  const big = api.encodeWav(new Float32Array(360000), 16000)
  assert.ok(big.length > 700000)
  const bigText = api.toBase64(big)
  assert.equal(bigText.length % 4, 0)
  assert.equal(bigText.includes('\n'), false)
  assert.equal(api.decodeBase64(bigText).length, big.length)
})

test('麦克风可见性：安全上下文、录音能力、catalog 三项全真才显示', () => {
  const api = load()
  const combos = []
  for (const secure of [true, false]) {
    for (const hasMediaDevices of [true, false]) {
      for (const catalogOk of [true, false]) combos.push({ secure, hasMediaDevices, catalogOk })
    }
  }
  assert.equal(combos.length, 8)
  for (const flags of combos) {
    assert.equal(api.shouldShowMic(flags), flags.secure && flags.hasMediaDevices && flags.catalogOk, JSON.stringify(flags))
  }
  assert.equal(api.shouldShowMic(), false)
  assert.equal(api.shouldShowMic({ secure: 'true', hasMediaDevices: true, catalogOk: true }), false)
})

test('光标插入：保留原有内容、只在光标处插入并返回新光标位置', () => {
  const api = load()
  const input = { value: 'abcXYZ', selectionStart: 3, selectionEnd: 3, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
  assert.equal(api.insertAtCursor(input, '中文'), 5)
  assert.equal(input.value, 'abc中文XYZ')
  assert.equal(input.selectionStart, 5)
  assert.equal(input.selectionEnd, 5)

  const selected = { value: 'hello world', selectionStart: 6, selectionEnd: 11, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
  api.insertAtCursor(selected, 'there')
  assert.equal(selected.value, 'hello there')

  const plain = { value: '草稿' }
  assert.equal(api.insertAtCursor(plain, '加一句'), 5)
  assert.equal(plain.value, '草稿加一句')

  const empty = { value: '', selectionStart: 0, selectionEnd: 0 }
  assert.equal(api.insertAtCursor(empty, '语音'), 2)
  assert.equal(empty.value, '语音')

  assert.equal(api.insertAtCursor(null, 'x'), 0)
})

/* ---------------- 运行时：假 DOM + 假媒体 API ---------------- */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeElement(tag) {
  const classes = new Set(), listeners = {}
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', className: '', value: '', textContent: '', title: '',
    disabled: false, type: '', children: [], selectionStart: 0, selectionEnd: 0, focused: false,
    scrollHeight: 20, scrollTop: 0, isConnected: true,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, on) {
        if (on === undefined) { if (classes.has(name)) classes.delete(name); else classes.add(name) }
        else if (on) classes.add(name); else classes.delete(name)
      }
    },
    addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn) },
    fire(name, event) { (listeners[name] || []).forEach(fn => fn(event || { target: el })) },
    setAttribute(key, value) { el['attr:' + key] = String(value) },
    getAttribute(key) { return el['attr:' + key] },
    appendChild(child) { el.children.push(child); return child },
    insertBefore(child) { el.children.push(child); return child },
    querySelector() { return null },
    focus() { el.focused = true },
    setSelectionRange(from, to) { el.selectionStart = from; el.selectionEnd = to },
    dispatchEvent(event) { el.events = (el.events || []).concat(event.type); return true }
  }
  return el
}

// 假宿主环境：document/navigator/MediaRecorder/AudioContext/OfflineAudioContext + 可控 catalog。
function runtime() {
  const ids = new Map(['composer-input', 'btn-mic', 'composer-wrap', 'toast'].map(id => [id, fakeElement('div')]))
  const composerRow = fakeElement('div')
  const wrap = ids.get('composer-wrap')
  wrap.querySelector = selector => (selector === '.composer' ? composerRow : null)
  const document = {
    hidden: false,
    getElementById: id => ids.get(id) || null,
    createElement: tag => fakeElement(tag),
    addEventListener() {}
  }
  const recorded = new Uint8Array([26, 69, 223, 163, 75, 76, 77, 78])
  const tracks = []
  class FakeRecorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; this.listeners = {} }
    addEventListener(name, fn) { this.listeners[name] = fn }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      setTimeout(() => {
        if (this.listeners.dataavailable) this.listeners.dataavailable({ data: new Blob([recorded], { type: 'audio/webm' }) })
        if (this.listeners.stop) this.listeners.stop()
      }, 0)
    }
  }
  class FakeAudioContext {
    decodeAudioData(buffer, ok) { ok({ duration: 1.2, sampleRate: 48000, length: 57600 }) }
    close() { return Promise.resolve() }
  }
  class FakeOfflineAudioContext {
    constructor(channels, length, rate) { this.length = length; this.sampleRate = rate; this.destination = {} }
    createBufferSource() { return { buffer: null, connect() {}, start() {} } }
    startRendering() {
      const pcm = new Float32Array(this.length)
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 10) * 0.2
      return Promise.resolve({ getChannelData: () => pcm })
    }
  }
  const context = vm.createContext({
    document, phrase: '',
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } },
    MediaRecorder: FakeRecorder, AudioContext: FakeAudioContext, OfflineAudioContext: FakeOfflineAudioContext,
    isSecureContext: true, btoa, atob, Blob, Event, setTimeout, clearTimeout, setInterval, clearInterval
  })
  vm.runInContext(source, context)

  const calls = [], notices = []
  let catalog = null
  const host = {
    rpc: async (method, payload, timeoutMs) => {
      calls.push({ method, payload, timeoutMs })
      if (method === 'speech.catalog') {
        if (catalog === 'unavailable') throw Object.assign(new Error('speech unavailable'), { code: 'speech/unavailable' })
        return catalog
      }
      if (method === 'speech.transcribe') return { text: '你好世界', audioSeconds: 1.2, inferenceSeconds: 0.3 }
      return null
    },
    token: () => 'token', server: () => 'http://gateway',
    t: (key, vars) => key + (vars ? JSON.stringify(vars) : ''),
    toast: (text, kind) => notices.push({ text, kind }),
    authFailure: () => notices.push({ text: 'AUTH' }),
    $: id => ids.get(id) || null,
    autosize() {}
  }
  return {
    context, host, calls, notices,
    api: context.DshVoiceInput,
    setCatalog: value => { catalog = value },
    mic: () => ids.get('btn-mic'),
    input: () => ids.get('composer-input'),
    micHidden: () => ids.get('btn-mic').classList.contains('hidden'),
    bar: () => wrap.children.find(child => child.id === 'voice-input-bar'),
    barText: () => { const bar = wrap.children.find(child => child.id === 'voice-input-bar'); return bar ? bar.children[1].textContent : '' },
    barAction: () => { const bar = wrap.children.find(child => child.id === 'voice-input-bar'); return bar ? bar.children[2].textContent : '' },
    readyCatalog: () => ({ maxAudioBytes: 4194304, maxDurationSeconds: 120, providers: [{ id: 'p1', preparation: { phase: 'ready' } }], selection: { providerId: 'p1' } })
  }
}

test('mount 运行时：入口可见性、录音→16k WAV→speech.transcribe→光标插入、取消、模型准备', async () => {
  /* 主机未启用语音 bundle：隐藏入口且不弹错误 */
  {
    const h = runtime()
    h.setCatalog('unavailable')
    assert.equal(h.api.mount(h.host), true)
    await wait(5)
    assert.equal(h.micHidden(), true)
    assert.equal(h.notices.length, 0)
  }
  /* 非安全上下文（手机浏览器直连 http://局域网IP）：catalog 成功也隐藏 */
  {
    const h = runtime()
    h.setCatalog(h.readyCatalog())
    h.context.isSecureContext = false
    h.api.mount(h.host)
    await wait(5)
    assert.equal(h.micHidden(), true)
  }
  /* 正常链路 */
  const h = runtime()
  h.setCatalog(h.readyCatalog())
  h.api.mount(h.host)
  await wait(5)
  assert.equal(h.micHidden(), false, '安全上下文 + catalog 成功应显示麦克风')

  h.input().value = '前缀-后缀'
  h.input().selectionStart = 3
  h.input().selectionEnd = 3
  h.mic().fire('click')
  await wait(5)
  assert.equal(h.mic().classList.contains('recording'), true, '点击后进入录音态')
  assert.match(h.barText(), /^voice\.recording/, '应显示录音计时')
  h.mic().fire('click')
  await wait(40)

  const transcribe = h.calls.find(call => call.method === 'speech.transcribe')
  assert.ok(transcribe, '停止后应调用 speech.transcribe')
  assert.equal(transcribe.timeoutMs, 180000, '转写超时应为 180s')
  assert.equal(transcribe.payload.request.providerId, 'p1')
  const base64 = transcribe.payload.request.audioBase64
  assert.match(base64, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.equal(base64.length % 4, 0)
  const wav = Buffer.from(base64, 'base64')
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 16000, '上传的 WAV 必须是 16kHz')
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.length, 44 + Math.floor(1.2 * 16000) * 2)
  assert.equal(h.input().value, '前缀-你好世界后缀', '文本插入光标处并保留原内容')
  assert.deepEqual(h.input().events, ['input'], '应派发 input 事件')
  assert.equal(h.input().focused, true, '应保持/恢复焦点')
  assert.equal(h.mic().classList.contains('recording'), false)
  assert.equal(h.notices.length, 0)

  /* 取消：停止但不转写 */
  const before = h.calls.filter(call => call.method === 'speech.transcribe').length
  h.mic().fire('click')
  await wait(5)
  h.bar().children[2].fire('click')
  await wait(40)
  assert.equal(h.calls.filter(call => call.method === 'speech.transcribe').length, before, '取消不应转写')
  assert.equal(h.input().value, '前缀-你好世界后缀')

  /* 模型未就绪：内联提示 + 下载并准备 + 轮询百分比 + 就绪后可继续录音 */
  const slow = runtime()
  const catalog = slow.readyCatalog()
  catalog.providers[0].preparation = { phase: 'unprepared' }
  slow.setCatalog(catalog)
  slow.api.mount(slow.host)
  await wait(5)
  slow.mic().fire('click')
  await wait(5)
  assert.match(slow.barText(), /^voice\.notReady/, '未就绪时应显示内联提示')
  assert.match(slow.barAction(), /^voice\.prepare/, '应出现「下载并准备」')
  slow.bar().children[2].fire('click')
  await wait(10)
  // payload 对象建在 vm 的 realm 里，跨 realm 深比较用 JSON 形态
  assert.equal(JSON.stringify(slow.calls.filter(call => call.method === 'speech.prepare').map(call => call.payload)), '[{"providerId":"p1"}]')
  assert.equal(slow.barAction(), 'voice.cancel', '准备期间可取消')
  catalog.providers[0].preparation = { phase: 'downloading', completedBytes: 40, totalBytes: 100 }
  await wait(2100)
  assert.match(slow.barText(), /^voice\.prepareProgress\{"percent":40\}/, '应显示下载百分比')
  catalog.providers[0].preparation = { phase: 'ready' }
  await wait(2100)
  assert.match(slow.barText(), /^voice\.prepareReady/, '就绪后提示成功')
  slow.mic().fire('click')
  await wait(5)
  assert.equal(slow.mic().classList.contains('recording'), true, '就绪后可以直接录音')
  slow.mic().fire('click')
  await wait(40)
})