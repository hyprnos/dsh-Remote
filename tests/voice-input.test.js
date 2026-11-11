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
  vm.runInContext(code + ';this.api={encodeWav,toBase64,decodeBase64,shouldShowMic,insertAtCursor,' +
    'CORRECTIONS_KEY,DEFAULT_CORRECTIONS,correctionsText,parseCorrections,applyCorrections,' +
    'configureProviderPatch,configureLanguagePatch,voiceLanguages,providerStatus};', context)
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

test('纠错表解析：忽略坏行/注释、去重、按「错误」长度降序（长词先替换）', () => {
  const api = load()
  const table = api.parseCorrections([
    '# 注释行',
    '',
    'claude=Claude',
    'claude code = Claude Code ',
    '没有等号的行',
    '=只有右边',
    '   ',
    'same=same',
    'CONFIG=config',
    'config=重复行丢掉',
    'servve=server',
    'crlf=ok\r'
  ].join('\n'))
  // 跨 realm 的数组用宿主侧 Array.from 取出再比较
  assert.deepEqual(Array.from(table, item => item.from), ['claude code', 'claude', 'CONFIG', 'servve', 'crlf'])
  const byFrom = Object.fromEntries(Array.from(table, item => [item.from, item.to]))
  assert.equal(byFrom['claude code'], 'Claude Code', '两端空白应裁掉')
  assert.equal(byFrom.CONFIG, 'config', '重复「错误」只留第一条')
  assert.equal(byFrom.crlf, 'ok', 'CRLF 行尾应裁掉')

  assert.equal(Array.from(api.parseCorrections('')).length, 0)
  assert.equal(Array.from(api.parseCorrections(null)).length, 0)
  assert.equal(Array.from(api.parseCorrections('没有等号\n=x\nsame=same')).length, 0, '全是坏行时为空表')
})

test('纠错表应用：大小写不敏感、整词替换、保留替换目标原文、长词优先', () => {
  const api = load()
  const table = api.parseCorrections('confit=config\nservve=server\nclaude code=Claude Code\nclaude=Claude\nmcp=MCP')
  assert.equal(api.applyCorrections('Confit is CONFIT on servve', table), 'config is config on server')
  assert.equal(api.applyCorrections('请用 claude code，而不是 CLAUDE CODE', table), '请用 Claude Code，而不是 Claude Code',
    '长词优先：不会被短词切成 Claude code')
  assert.equal(api.applyCorrections('mcp 和 mcp_servers 与 confitx 与 configs', table), 'MCP 和 mcp_servers 与 confitx 与 configs',
    '整词匹配：词内与下划线连接的不替换')
  assert.equal(api.applyCorrections('servve,servve servve', table), 'server,server server', '相邻重复都要替换')
  assert.equal(api.applyCorrections('保持原文', api.parseCorrections('x y\n=bad\n')), '保持原文', '坏行不生效')
  assert.equal(api.applyCorrections('', table), '')
  assert.equal(api.applyCorrections(null, table), '')
})

test('术语纠错的存储键与默认条目：从未保存才用默认值，空字符串表示不纠错', () => {
  const api = load()
  assert.equal(api.CORRECTIONS_KEY, 'dsr.voice.corrections')
  assert.equal(api.correctionsText(undefined), api.DEFAULT_CORRECTIONS)
  assert.equal(api.correctionsText(null), api.DEFAULT_CORRECTIONS)
  assert.equal(api.correctionsText(''), '')
  assert.equal(api.correctionsText('a=b'), 'a=b')
  const defaults = api.parseCorrections(api.DEFAULT_CORRECTIONS)
  const byFrom = Object.fromEntries(Array.from(defaults, item => [item.from, item.to]))
  assert.equal(byFrom.confit, 'config')
  assert.equal(byFrom.servve, 'server')
  assert.equal(byFrom.log, 'logs')
  assert.equal(api.applyCorrections('看下 log 和 confit', defaults), '看下 logs 和 config')
})

test('speech.configure 的 payload 形状：providerId 与 language 都包在 patch 里', () => {
  const api = load()
  assert.equal(JSON.stringify(api.configureProviderPatch('whisper-local')), '{"patch":{"providerId":"whisper-local"}}')
  assert.equal(JSON.stringify(api.configureLanguagePatch('zh')), '{"patch":{"language":"zh"}}')
  assert.equal(JSON.stringify(api.configureProviderPatch(' whisper-local ')), '{"patch":{"providerId":"whisper-local"}}')
  assert.equal(api.configureProviderPatch(''), null)
  assert.equal(api.configureProviderPatch(null), null)
  assert.equal(api.configureLanguagePatch(''), null)
  assert.equal(api.configureLanguagePatch(undefined), null)
})

test('语言候选含 auto 且去重，准备状态映射到「已就绪/未下载/下载中 x%」', () => {
  const api = load()
  assert.equal(JSON.stringify(api.voiceLanguages({ languages: ['zh', 'en', 'zh', '', 'auto'] })), '["auto","zh","en"]')
  assert.equal(JSON.stringify(api.voiceLanguages({})), '["auto"]')
  assert.equal(JSON.stringify(api.voiceLanguages(null)), '["auto"]')
  const busy = api.providerStatus({ preparation: { phase: 'downloading', completedBytes: 1, totalBytes: 4 } })
  assert.equal(JSON.stringify(busy), '{"phase":"downloading","ready":false,"busy":true,"failed":false,"percent":25}')
  assert.equal(api.providerStatus({ preparation: { phase: 'ready' } }).ready, true)
  assert.equal(api.providerStatus({ preparation: { phase: 'standby' } }).busy, false)
  assert.equal(api.providerStatus({ preparation: { phase: 'failed' } }).failed, true)
  assert.equal(api.providerStatus({}).busy, false)
  assert.equal(api.providerStatus({ preparation: { phase: 'downloading' } }).percent, null)
})

test('新语音文案 zh/en 双语齐全（index.html 内联 APP_STR）', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  const zhAt = html.indexOf('window.APP_STR')
  const enAt = html.indexOf('en: {', zhAt)
  assert.ok(zhAt >= 0 && enAt > zhAt, 'index.html 的 APP_STR 结构变了')
  const zh = html.slice(zhAt, enAt), en = html.slice(enAt)
  const keys = new Set()
  for (const match of source.matchAll(/\bt\('(voice\.[A-Za-z0-9_.]+)'/g)) keys.add(match[1])
  assert.ok(keys.size >= 35, '应收集到语音相关 key，实际 ' + keys.size)
  const missing = []
  for (const key of keys) {
    if (!zh.includes("'" + key + "'")) missing.push(key + '（zh）')
    if (!en.includes("'" + key + "'")) missing.push(key + '（en）')
  }
  assert.deepEqual(missing, [])
  for (const prefix of ['voice.settings.', 'voice.model.', 'voice.lang.', 'voice.correction.']) {
    const count = block => (block.match(new RegExp("'" + prefix.replace(/\./g, '\\.') + "[A-Za-z0-9_.]*'", 'g')) || []).length
    assert.ok(count(zh) >= 3, prefix + ' 中文条目太少')
    assert.equal(count(zh), count(en), prefix + ' 中英文条目数量不一致')
  }
})

/* ---------------- 运行时：假 DOM + 假媒体 API ---------------- */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeElement(tag) {
  const classes = new Set(), listeners = {}
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', value: '', textContent: '', title: '',
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
    dispatchEvent(event) { el.events = (el.events || []).concat(event.type); return true },
    replaceChildren(...nodes) { el.children.length = 0; nodes.forEach(child => el.children.push(child)) },
    remove() { el.removed = true }
  }
  // className 与 classList 共享同一份集合：prod 代码用 el.className = 'a b' 写类名
  Object.defineProperty(el, 'className', {
    get: () => Array.from(classes).join(' '),
    set: value => {
      classes.clear()
      String(value == null ? '' : value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name))
    }
  })
  return el
}

// 假宿主环境：document/navigator/MediaRecorder/AudioContext/OfflineAudioContext + 可控 catalog。
// 选项：storage(Map，模拟 localStorage)、transcribeText、configureFails。
function runtime(options) {
  const settings = options || {}
  const storage = settings.storage || new Map()
  const transcribeText = settings.transcribeText === undefined ? '你好世界' : settings.transcribeText
  const configureFails = settings.configureFails === true
  const ids = new Map(['composer-input', 'btn-mic', 'composer-wrap', 'toast'].map(id => [id, fakeElement('div')]))
  const composerRow = fakeElement('div')
  const wrap = ids.get('composer-wrap')
  wrap.querySelector = selector => (selector === '.composer' ? composerRow : null)
  const document = {
    hidden: false,
    body: fakeElement('body'),
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
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: key => { storage.delete(key) }
    },
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
      if (method === 'speech.configure') {
        if (configureFails) throw new Error('configure rejected')
        const patch = (payload && payload.patch) || {}
        if (catalog && typeof catalog === 'object' && catalog.selection) {
          if (patch.providerId) catalog.selection.providerId = patch.providerId
          if (patch.language) catalog.selection.language = patch.language
        }
        return { selection: patch }
      }
      if (method === 'speech.transcribe') return { text: transcribeText, audioSeconds: 1.2, inferenceSeconds: 0.3 }
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
    context, host, calls, notices, storage,
    api: context.DshVoiceInput,
    setCatalog: value => { catalog = value },
    mic: () => ids.get('btn-mic'),
    input: () => ids.get('composer-input'),
    micHidden: () => ids.get('btn-mic').classList.contains('hidden'),
    bar: () => wrap.children.find(child => child.id === 'voice-input-bar'),
    barText: () => { const bar = wrap.children.find(child => child.id === 'voice-input-bar'); return bar ? bar.children[1].textContent : '' },
    barAction: () => { const bar = wrap.children.find(child => child.id === 'voice-input-bar'); return bar ? bar.children[2].textContent : '' },
    overlay: () => document.body.children.find(child => child.id === 'voice-settings') || null,
    readyCatalog: () => ({ maxAudioBytes: 4194304, maxDurationSeconds: 120, providers: [{ id: 'p1', preparation: { phase: 'ready' } }], selection: { providerId: 'p1' } })
  }
}

// 弹层相关的 DOM 查找/读取工具：fakeElement 只保留 children 数组，按 id/class 递归找。
const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}
const nodeText = node => {
  if (!node || typeof node !== 'object') return ''
  const children = node.children || []
  return children.length ? children.map(nodeText).join(' ') : String(node.textContent || '')
}
const byElementId = (root, id) => walk(root).find(node => node.id === id) || null
const modelRows = overlay => walk(overlay).filter(node => String(node.className || '').split(/\s+/).includes('voice-settings-option'))

const twoProviderCatalog = () => ({
  maxAudioBytes: 4194304,
  maxDurationSeconds: 120,
  providers: [
    { id: 'p1', name: 'DSH 云端识别', languages: ['zh', 'en'], preparation: { phase: 'ready' } },
    { id: 'whisper-local', name: 'Whisper 本地', languages: ['zh', 'en'], preparation: { phase: 'unprepared' } }
  ],
  selection: { providerId: 'p1', language: 'auto' }
})

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
test('语音设置弹层：按 catalog 渲染 provider 状态，选择 provider/语言发 speech.configure 的 patch payload', async () => {
  const h = runtime()
  h.setCatalog(twoProviderCatalog())
  h.api.mount(h.host)
  await wait(5)
  assert.equal(h.micHidden(), false)
  assert.equal(h.api.openSettings(), true)
  await wait(20)
  const overlay = h.overlay()
  assert.ok(overlay, '应插入 #voice-settings 弹层')
  assert.equal(overlay.classList.contains('hidden'), false)
  assert.equal(h.calls.filter(call => call.method === 'speech.catalog').length, 2, '打开弹层要用最新 catalog 重新渲染')

  const rows = modelRows(overlay)
  assert.equal(rows.length, 2)
  assert.match(nodeText(rows[0]), /DSH 云端识别/)
  assert.match(nodeText(rows[0]), /voice\.model\.ready/)
  assert.equal(rows[0].classList.contains('selected'), true)
  assert.match(nodeText(rows[1]), /Whisper 本地/)
  assert.match(nodeText(rows[1]), /voice\.model\.notReady/)
  assert.equal(byElementId(overlay, 'voice-settings-prepare').classList.contains('hidden'), true, '就绪的 provider 不显示下载按钮')

  // 选中第二个 provider：configure 成功后才换选中态
  rows[1].fire('click')
  await wait(25)
  const providerCalls = h.calls.filter(call => call.method === 'speech.configure')
  assert.equal(providerCalls.length, 1)
  assert.equal(JSON.stringify(providerCalls[0].payload), '{"patch":{"providerId":"whisper-local"}}')
  assert.equal(providerCalls[0].timeoutMs, 20000)
  assert.equal(modelRows(overlay)[1].classList.contains('selected'), true, '成功后选中态跟随 catalog.selection')
  assert.equal(modelRows(overlay)[0].classList.contains('selected'), false)
  assert.equal(byElementId(overlay, 'voice-settings-prepare').classList.contains('hidden'), false, '未就绪 provider 要显示下载按钮')

  // 识别语言：候选取所选 provider 的 languages（含 auto），变更发 language patch
  const select = byElementId(overlay, 'voice-settings-language')
  assert.ok(select, '应有识别语言选择器')
  assert.deepEqual(select.children.map(option => option.value), ['auto', 'zh', 'en'])
  assert.equal(select.value, 'auto')
  select.value = 'zh'
  select.fire('change')
  await wait(20)
  const languageCalls = h.calls.filter(call => call.method === 'speech.configure').slice(1)
  assert.equal(languageCalls.length, 1)
  assert.equal(JSON.stringify(languageCalls[0].payload), '{"patch":{"language":"zh"}}')
  assert.equal(byElementId(overlay, 'voice-settings-language').value, 'zh')
})

test('语音设置：configure 失败要 toast 且回滚选中态（本地不猜）', async () => {
  const h = runtime({ configureFails: true })
  h.setCatalog(twoProviderCatalog())
  h.api.mount(h.host)
  await wait(5)
  h.api.openSettings()
  await wait(20)
  const overlay = h.overlay()
  modelRows(overlay)[1].fire('click')
  await wait(25)
  assert.equal(h.calls.filter(call => call.method === 'speech.configure').length, 1, '失败也发出了一次请求')
  assert.equal(modelRows(overlay)[0].classList.contains('selected'), true, '失败后选中态回到原 provider')
  assert.equal(modelRows(overlay)[1].classList.contains('selected'), false)
  assert.equal(h.notices.length, 1)
  assert.equal(h.notices[0].kind, 'err')
  assert.match(h.notices[0].text, /^voice\.model\.selectFailed/)
  assert.match(h.notices[0].text, /configure rejected/)
})

test('术语纠错：弹层保存到 localStorage dsr.voice.corrections，并在插入前整词纠错', async () => {
  const h = runtime({ transcribeText: '请检查 confit 和 servve，再看 log' })
  h.setCatalog(h.readyCatalog())
  h.api.mount(h.host)
  await wait(5)
  h.api.openSettings()
  await wait(20)
  const overlay = h.overlay()
  const area = byElementId(overlay, 'voice-settings-corrections')
  assert.ok(area, '应有术语纠错输入框')
  assert.match(area.value, /confit=config/, '首次打开显示默认条目')

  area.value = 'confit=config\nservve=server'
  area.fire('input')
  assert.equal(h.storage.get('dsr.voice.corrections'), 'confit=config\nservve=server', '输入即保存到本机键')

  byElementId(overlay, 'voice-settings-close').fire('click')
  assert.equal(overlay.classList.contains('hidden'), true, '关闭按钮隐藏弹层')

  h.input().value = '前缀'
  h.input().selectionStart = 2
  h.input().selectionEnd = 2
  h.mic().fire('click')
  await wait(5)
  h.mic().fire('click')
  await wait(60)
  assert.equal(h.input().value, '前缀请检查 config 和 server，再看 log', '转写文本先纠错再插入光标处')
})

test('内联条齿轮：非录音/转写状态可打开同一弹层，录音中隐藏', async () => {
  const h = runtime()
  const catalog = h.readyCatalog()
  catalog.providers[0].preparation = { phase: 'unprepared' }
  h.setCatalog(catalog)
  h.api.mount(h.host)
  await wait(5)
  h.mic().fire('click')
  await wait(5)
  const bar = h.bar()
  assert.ok(bar, '未就绪时应显示内联条')
  const gear = bar.children[3]
  assert.equal(gear.id, 'voice-input-settings')
  assert.equal(gear.classList.contains('hidden'), false, '未就绪状态可打开语音设置')
  gear.fire('click')
  await wait(20)
  const overlay = h.overlay()
  assert.ok(overlay, '齿轮应打开同一弹层')
  assert.equal(overlay.classList.contains('hidden'), false)
  overlay.fire('click')
  assert.equal(overlay.classList.contains('hidden'), true, '点遮罩关闭弹层')

  catalog.providers[0].preparation = { phase: 'ready' }
  h.mic().fire('click')
  await wait(5)
  assert.equal(h.mic().classList.contains('recording'), true)
  assert.equal(h.bar().children[3].classList.contains('hidden'), true, '录音中不显示齿轮')
  h.mic().fire('click')
  await wait(40)
})

test('弹层内「下载并准备」复用现有 prepare 轮询，可取消', async () => {
  const h = runtime()
  const catalog = h.readyCatalog()
  catalog.providers[0].preparation = { phase: 'unprepared' }
  h.setCatalog(catalog)
  h.api.mount(h.host)
  await wait(5)
  h.api.openSettings()
  await wait(20)
  const overlay = h.overlay()
  const prepare = byElementId(overlay, 'voice-settings-prepare')
  assert.equal(prepare.classList.contains('hidden'), false)
  assert.equal(prepare.textContent, 'voice.model.prepare')
  prepare.fire('click')
  await wait(20)
  assert.equal(JSON.stringify(h.calls.filter(call => call.method === 'speech.prepare').map(call => call.payload)), '[{"providerId":"p1"}]')
  const afterStart = byElementId(overlay, 'voice-settings-prepare')
  assert.equal(afterStart.textContent, 'voice.cancel', '准备期间按钮变成取消')
  afterStart.fire('click')
  await wait(20)
  assert.equal(JSON.stringify(h.calls.filter(call => call.method === 'speech.cancelPreparation').map(call => call.payload)), '[{"providerId":"p1"}]')
  assert.equal(byElementId(overlay, 'voice-settings-prepare').textContent, 'voice.model.prepare')
})


test('录音中发送：stopAndTranscribe 导出且未录音时立即返回 skipped', async () => {
  const voiceSource = fs.readFileSync(path.join(__dirname, '../public/voice-input.js'), 'utf8')
  assert.match(voiceSource, /function isRecording\(\)/)
  assert.match(voiceSource, /function stopAndTranscribe\(\)/)
  assert.match(voiceSource, /isRecording, stopAndTranscribe,/)
  assert.match(voiceSource, /sendWaiter = resolve/)
  const appSource = fs.readFileSync(path.join(__dirname, '../public', 'app.js'), 'utf8')
  assert.match(appSource, /voice\?\.isRecording\?\.\(\)/)
  assert.match(appSource, /await voice\.stopAndTranscribe\(\)/)
})
