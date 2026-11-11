'use strict'
/* 本地 Whisper provider 的单测：不联网、不下载 547MB 模型。
 * 用 process.execPath 生成假 whisper-cli 验证 spawn 参数/文本解析/取消，
 * 用假 fetch 验证流式下载的取消与临时文件清理。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const moduleTask = import('../packages/plugin/speech-whisper.mjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-whisper-test-'))
}

function wavBytes(payloadLength) {
  const data = Buffer.alloc(44 + payloadLength)
  data.write('RIFF', 0, 'ascii')
  data.writeUInt32LE(36 + payloadLength, 4)
  data.write('WAVE', 8, 'ascii')
  data.write('fmt ', 12, 'ascii')
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20) // PCM
  data.writeUInt16LE(1, 22) // mono
  data.writeUInt32LE(16000, 24)
  data.writeUInt32LE(32000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36, 'ascii')
  data.writeUInt32LE(payloadLength, 40)
  return data
}

/** 写一个可执行的假 whisper-cli：--help 直接退出 0，其余按 mode 行为并记录 argv。 */
function fakeWhisper(dir, mode, extra = {}) {
  const script = path.join(dir, `fake-whisper-${mode}.cjs`)
  const argsFile = path.join(dir, `args-${mode}.jsonl`)
  fs.writeFileSync(script, `
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (argv.includes('--help')) process.exit(0)
const value = flag => argv[argv.indexOf(flag) + 1]
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(argv) + '\\n')
require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, `wav-${mode}-`))} + process.pid + '.wav', fs.readFileSync(value('-f')))
const mode = ${JSON.stringify(mode)}
if (mode === 'hang') {
  fs.writeFileSync(${JSON.stringify(path.join(dir, `pid-${mode}-`))} + process.pid + '.pid', String(process.pid))
  setInterval(() => {}, 1000)
} else if (mode === 'silent') {
  process.exit(0)
} else if (mode === 'fail') {
  process.stderr.write('boom: model load failed')
  process.exit(2)
} else {
  fs.writeFileSync(value('-of') + '.txt', ${JSON.stringify(extra.text ?? 'Server Logs 和 Config 都在这里。\n')})
}
`, 'utf8')
  const wrapper = path.join(dir, `whisper-cli-${mode}`)
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, 'utf8')
  fs.chmodSync(wrapper, 0o755)
  return { wrapper, argsFile, script }
}

function writeModel(dir, data, name = 'model.bin') {
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true })
  const file = path.join(dir, 'models', name)
  fs.writeFileSync(file, data)
  return { name, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
}

async function waitFor(check, timeout = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

test('info 形状对齐官方 SpeechProviderInfo，初始 preparation 为 unprepared', async () => {
  const { createWhisperProvider } = await moduleTask
  const provider = createWhisperProvider({ dataRoot: path.join(os.tmpdir(), 'unused-dsh-whisper') })
  try {
    assert.equal(provider.info.id, 'whisper-local')
    assert.equal(provider.info.name, 'Whisper (local)')
    assert.equal(provider.info.location, 'host-local')
    assert.ok(provider.info.languages.includes('auto'))
    assert.ok(provider.info.languages.includes('zh'))
    assert.ok(provider.info.languages.includes('en'))
    assert.deepEqual([...provider.info.downloadSources], ['https://huggingface.co', 'https://hf-mirror.com'])
    assert.equal(typeof provider.info.setupEstimate.recommendedDiskBytes, 'number')
    assert.ok(provider.info.setupEstimate.recommendedDiskBytes > 500 * 1024 * 1024)
    assert.equal(typeof provider.info.setupEstimate.expectedMemoryBytes, 'number')
    assert.ok(provider.info.setupEstimate.maximumMinutes > provider.info.setupEstimate.minimumMinutes)
    const state = provider.preparation.snapshot()
    assert.equal(state.phase, 'unprepared')
    assert.deepEqual(state.steps.map(step => step.kind), ['check', 'model', 'verify', 'load'])
    assert.ok(state.steps.every(step => step.status === 'pending'))
    assert.equal(typeof provider.preparation.subscribe(() => {}), 'function')
    assert.equal(typeof provider.transcribe, 'function')
  } finally {
    await provider.dispose()
  }
})

test('缺 whisper-cli 时 provider 仍可枚举，准备进入 failed 并给中文安装提示', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const provider = createWhisperProvider({
    dataRoot: dir,
    whisperBin: path.join(dir, 'missing-whisper-cli'),
    model: { name: 'x.bin', bytes: 3, sha256: 'a'.repeat(64) },
  })
  let notifications = 0
  const dispose = provider.preparation.subscribe(() => { notifications += 1 })
  try {
    await provider.preparation.inspect()
    const state = provider.preparation.snapshot()
    assert.equal(state.phase, 'failed')
    assert.match(state.message, /brew install whisper-cpp/)
    assert.match(state.message, /DSH_REMOTE_WHISPER_BIN/)
    assert.match(state.message, /missing-whisper-cli/)
    assert.equal(state.steps.find(step => step.kind === 'check').status, 'failed')
    assert.ok(notifications > 0, '准备状态变化会通知订阅者')
    assert.equal(provider.info.id, 'whisper-local', '缺组件也要出现在 catalog 里')
    // prepare() 走同一诊断路径，且不会把异常抛给调用方。
    await provider.prepare()
    assert.equal(provider.preparation.snapshot().phase, 'failed')
  } finally {
    dispose()
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('transcribe 使用约定参数调用 whisper-cli 并原样解析 txt', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const fake = fakeWhisper(dir, 'ok', { text: 'Server Logs 和 Config 都在这里。\n第二行\n' })
  const model = writeModel(dir, Buffer.from('fake model bytes'))
  const provider = createWhisperProvider({ dataRoot: dir, whisperBin: fake.wrapper, model, tmpDir: dir })
  try {
    await provider.prepare()
    assert.equal(provider.preparation.snapshot().phase, 'ready')
    assert.ok(provider.preparation.snapshot().steps.every(step => step.status === 'complete'), '准备完成后 steps 全部完成')

    const audio = wavBytes(32000) // 1 秒
    const transcript = await provider.transcribe({ audio, language: 'zh' }, new AbortController().signal)
    assert.equal(transcript.text, 'Server Logs 和 Config 都在这里。第二行')
    assert.equal(transcript.audioSeconds, 1)
    assert.equal(typeof transcript.inferenceSeconds, 'number')
    assert.ok(transcript.inferenceSeconds >= 0)

    const [first] = fs.readFileSync(fake.argsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const value = flag => first[first.indexOf(flag) + 1]
    assert.equal(value('-m'), provider.modelPath())
    assert.match(path.basename(value('-f')), /^input\.wav$/)
    assert.equal(value('-l'), 'zh')
    assert.equal(value('-of'), path.join(path.dirname(value('-f')), 'transcript'))
    for (const flag of ['-nt', '-np', '-otxt']) assert.ok(first.includes(flag), `缺少参数 ${flag}`)
    const copied = fs.readdirSync(dir).filter(name => name.startsWith('wav-ok-'))
    assert.equal(copied.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(dir, copied[0])), audio, 'whisper-cli 收到完整 wav 字节')
    assert.equal(fs.existsSync(path.dirname(value('-f'))), false, '临时 wav 目录已清理')

    // 语言映射：auto 透传，区域标记取主语言。
    await provider.transcribe({ audio, language: 'AUTO' }, new AbortController().signal)
    await provider.transcribe({ audio, language: 'zh-CN' }, new AbortController().signal)
    const languages = fs.readFileSync(fake.argsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .map(argv => argv[argv.indexOf('-l') + 1])
    assert.deepEqual(languages, ['zh', 'auto', 'zh'])
  } finally {
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('非 16k 单声道 PCM16 WAV 在启动子进程前被拒绝', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const fake = fakeWhisper(dir, 'ok')
  const model = writeModel(dir, Buffer.from('fake model bytes'))
  const provider = createWhisperProvider({ dataRoot: dir, whisperBin: fake.wrapper, model, tmpDir: dir })
  try {
    await provider.prepare()
    const stereo = wavBytes(3200)
    stereo.writeUInt16LE(2, 22)
    await assert.rejects(provider.transcribe({ audio: stereo, language: 'auto' }, new AbortController().signal), /16 kHz 单声道 PCM16 WAV/)
    await assert.rejects(provider.transcribe({ audio: Buffer.alloc(8), language: 'auto' }, new AbortController().signal), /16 kHz 单声道 PCM16 WAV/)
    assert.equal(fs.existsSync(fake.argsFile), false, '头部不合法时不启动 whisper-cli')
  } finally {
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('未就绪时拒绝转写，whisper-cli 退出码非 0 时报错', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const model = writeModel(dir, Buffer.from('fake model bytes'))
  const failing = fakeWhisper(dir, 'fail')
  const provider = createWhisperProvider({ dataRoot: dir, whisperBin: failing.wrapper, model, tmpDir: dir })
  try {
    const signal = new AbortController().signal
    await assert.rejects(provider.transcribe({ audio: wavBytes(3200), language: 'auto' }, signal), /Prepare the local speech provider/)
    await provider.prepare()
    await assert.rejects(provider.transcribe({ audio: wavBytes(3200), language: 'auto' }, signal), /whisper-cli 执行失败（退出码 2）/s)
  } finally {
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('空 txt 输出按空文本处理，静音占位行被丢弃', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const silent = fakeWhisper(dir, 'silent')
  const model = writeModel(dir, Buffer.from('fake model bytes'))
  const provider = createWhisperProvider({ dataRoot: dir, whisperBin: silent.wrapper, model, tmpDir: dir })
  try {
    await provider.prepare()
    const transcript = await provider.transcribe({ audio: wavBytes(3200), language: 'auto' }, new AbortController().signal)
    assert.deepEqual(transcript.text, '')
    assert.equal(transcript.audioSeconds, 0.1)
  } finally {
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AbortSignal 触发时 kill whisper-cli 并 reject，进程不残留', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const hang = fakeWhisper(dir, 'hang')
  const model = writeModel(dir, Buffer.from('fake model bytes'))
  const provider = createWhisperProvider({ dataRoot: dir, whisperBin: hang.wrapper, model, tmpDir: dir })
  try {
    await provider.prepare()
    const controller = new AbortController()
    const started = Date.now()
    const pending = provider.transcribe({ audio: wavBytes(32000), language: 'auto' }, controller.signal)
    await waitFor(() => fs.readdirSync(dir).some(name => name.startsWith('pid-hang-')))
    const pidFile = fs.readdirSync(dir).find(name => name.startsWith('pid-hang-'))
    const pid = Number(fs.readFileSync(path.join(dir, pidFile), 'utf8'))
    controller.abort(new Error('用户取消'))
    await assert.rejects(pending, /用户取消/)
    assert.ok(Date.now() - started < 5000, '取消应尽快结算')
    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    }, 3000)
  } finally {
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('下载中 cancel() 可中断，状态进入 cancelled 且不留临时文件', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const fake = fakeWhisper(dir, 'ok')
  const totalBytes = 8 * 1024 * 1024
  const fetchCalls = []
  const fakeFetch = async (url, { signal }) => {
    fetchCalls.push(url)
    const body = new ReadableStream({
      start(controller) {
        let sent = 0
        const chunk = new Uint8Array(1024 * 1024)
        let timer
        const push = () => {
          if (signal.aborted) { try { controller.error(signal.reason) } catch {} ; return }
          if (sent >= totalBytes) { try { controller.close() } catch {} ; return }
          controller.enqueue(chunk)
          sent += chunk.length
          timer = setTimeout(push, 5)
        }
        timer = setTimeout(push, 5)
        signal.addEventListener('abort', () => { clearTimeout(timer); try { controller.error(signal.reason) } catch {} }, { once: true })
      },
    })
    return { ok: true, status: 200, url, body }
  }
  const provider = createWhisperProvider({
    dataRoot: dir,
    whisperBin: fake.wrapper,
    model: { name: 'cancel-model.bin', bytes: totalBytes, sha256: 'b'.repeat(64) },
    fetch: fakeFetch,
  })
  try {
    const preparing = provider.prepare()
    await waitFor(() => provider.preparation.snapshot().phase === 'downloading')
    const downloading = provider.preparation.snapshot()
    assert.equal(downloading.resource, 'cancel-model.bin')
    assert.equal(downloading.totalBytes, totalBytes)
    assert.ok(downloading.completedBytes >= 0)
    await provider.preparation.cancel()
    await preparing
    const state = provider.preparation.snapshot()
    assert.equal(state.phase, 'cancelled')
    assert.equal(state.steps.find(step => step.kind === 'model').status, 'cancelled')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'models')), [], '取消后清理 .part 临时文件')
    assert.deepEqual(fetchCalls, ['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/cancel-model.bin'])
  } finally {
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('下载失败带结构化 download 诊断，并按顺序尝试镜像源', async () => {
  const { createWhisperProvider } = await moduleTask
  const dir = tempDir()
  const fake = fakeWhisper(dir, 'ok')
  const urls = []
  const provider = createWhisperProvider({
    dataRoot: dir,
    whisperBin: fake.wrapper,
    model: { name: 'fail-model.bin', bytes: 4, sha256: crypto.createHash('sha256').update('abcd').digest('hex') },
    fetch: async url => {
      urls.push(url)
      if (url.includes('huggingface.co')) return { ok: false, status: 503, url, body: null }
      return { ok: true, status: 200, url, body: new Response(Buffer.from('abcd')).body }
    },
  })
  try {
    await provider.prepare()
    assert.equal(provider.preparation.snapshot().phase, 'ready', '首个源 503 后降级到镜像源')
    assert.equal(urls.length, 2)
    assert.match(urls[1], /^https:\/\/hf-mirror\.com\//)

    // 指定源时不降级，失败进入 failed 且带 download:{resource,source,reason,status}
    fs.rmSync(path.join(dir, 'models', 'fail-model.bin'))
    const failing = createWhisperProvider({
      dataRoot: dir,
      whisperBin: fake.wrapper,
      model: { name: 'fail-model.bin', bytes: 4, sha256: 'c'.repeat(64) },
      fetch: async url => { urls.push(url); return { ok: false, status: 500, url, body: null } },
    })
    await failing.prepare({ downloadSource: 'https://hf-mirror.com' })
    const state = failing.preparation.snapshot()
    assert.equal(state.phase, 'failed')
    assert.equal(state.download.reason, 'http')
    assert.equal(state.download.status, 500)
    assert.equal(state.download.source, 'https://hf-mirror.com')
    assert.match(state.message, /HTTP 500/)
    assert.equal(urls.at(-1).startsWith('https://hf-mirror.com/'), true)
    await failing.dispose()
  } finally {
    await provider.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('registerWhisperProvider 走 cordis 动态注入，卸载时反注册并 dispose', async () => {
  const { registerWhisperProvider } = await moduleTask
  const dir = tempDir()
  const fake = fakeWhisper(dir, 'ok')
  const model = writeModel(dir, Buffer.from('fake model bytes'))
  const injected = []
  const registered = []
  const disposers = []
  let unregistered = 0
  const ctx = { inject: (names, callback) => { injected.push({ names, callback }); return 'fiber' } }
  assert.equal(registerWhisperProvider(ctx, { dataRoot: dir, whisperBin: fake.wrapper, model }), 'fiber')
  assert.equal(registerWhisperProvider({}), undefined, '没有 ctx.inject 时安全跳过')
  assert.deepEqual(injected[0].names, ['speechToText'])
  assert.equal(injected[0].callback.length, 1)

  const scoped = {
    effect: fn => { const dispose = fn(); disposers.push(dispose); return 'effect' },
    speechToText: {
      register: provider => {
        registered.push(provider)
        return async () => { unregistered += 1 }
      },
    },
  }
  injected[0].callback(scoped)
  try {
    assert.equal(registered.length, 1)
    assert.equal(registered[0].info.id, 'whisper-local')
    await waitFor(() => registered[0].preparation.snapshot().phase === 'ready')
    assert.equal(disposers.length, 1)
    await disposers[0]()
    assert.equal(unregistered, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})