/* dsh-remote · 内置本地 Whisper 语音识别 provider
 *
 * 给 DSH 主机增加第二个可选的转写模型（providerId: whisper-local），手机端语音输入
 * 的 catalog 里会与官方 SenseVoiceSmall 一起出现，中英混说时英文短词（Server Logs、
 * Config 等）识别更稳。
 *
 * 设计约束（与官方 dsh-experimental-speech-to-text-sensevoice 的登记契约保持一致）：
 *  - 只依赖 node: 内置模块，零新增依赖；模型不进 npm 包，首次使用时流式下载并校验。
 *  - 通过 cordis 动态注入登记到 ctx.speechToText：主机没启用官方语音 bundle 时本模块
 *    完全不参与加载，插件不会因为缺少服务而启动失败（见 registerWhisperProvider）。
 *  - preparation 状态机、steps、下载失败诊断的形状对齐官方 SpeechPreparationState /
 *    SpeechProviderInfo / Transcript，手机端 UI 无需为 Whisper 做特判。
 *  - 推理走本机 whisper.cpp 的 whisper-cli，一次一个进程：串行队列、可取消、有超时。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync, constants as fsConstants, createReadStream, createWriteStream, statSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 官方 whisper.cpp 发布的 ggml 模型（q5_0 量化 large-v3-turbo）。 */
const DEFAULT_MODEL = {
  name: 'ggml-large-v3-turbo-q5_0.bin',
  bytes: 574041195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
}
/** huggingface 与镜像使用同一路径（offline deployments 可换成自建镜像）；两者都可用时优先官方源。 */
const MODEL_REMOTE_PREFIX = '/ggerganov/whisper.cpp/resolve/main/'
const DEFAULT_DOWNLOAD_SOURCES = ['https://huggingface.co', 'https://hf-mirror.com']
/** whisper.cpp 接受的语言代码子集（与官方 voice-input 的选项保持接近，避免 UI 列出无效项）。 */
const DEFAULT_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'it']
/** 准备流程的操作顺序：查组件 → 模型 → 校验 → 加载探测。 */
const STEP_KINDS = ['check', 'model', 'verify', 'load']
const TERMINAL_PHASES = new Set(['ready', 'failed', 'cancelled', 'unprepared'])
const MAX_PENDING_JOBS = 2
const INFERENCE_TIMEOUT_MS = 180_000
const PREPARE_TIMEOUT_MS = 3_600_000
const PROBE_TIMEOUT_MS = 20_000
const PROGRESS_INTERVAL_MS = 100
const MAX_LOG_BYTES = 8 * 1024

/** 请求本身不合法（WAV 头/语言），与运行期失败区分开。 */
class SpeechInputError extends Error {}

/** 下载/校验失败，附带可直接给 UI 本地化用的结构化诊断。 */
class SpeechDownloadError extends Error {
  constructor(download, options) {
    super(describeDownloadFailure(download), options)
    this.name = 'SpeechDownloadError'
    this.download = download
  }
}

function describeDownloadFailure({ resource, source, reason, status }) {
  const labels = {
    network: '网络连接失败',
    dns: '域名解析失败',
    timeout: '下载超时',
    certificate: '证书校验失败',
    http: '下载源返回错误',
    integrity: '模型文件校验失败（字节数或 sha256 不符）',
    storage: '本地磁盘写入失败',
    unknown: '下载失败',
  }
  const http = status === undefined ? '' : `（HTTP ${status}）`
  return `Whisper 模型准备失败：${labels[reason] ?? labels.unknown}${http}；来源 ${source}，资源 ${resource}。请检查网络后重试。`
}

function whisperMissingMessage(configured) {
  const found = configured
    ? `已设置 DSH_REMOTE_WHISPER_BIN=${configured}，但该路径不是可执行文件。`
    : '未在 PATH 中找到 whisper-cli。'
  return `本机语音识别组件不可用：${found}请安装 whisper.cpp（macOS: brew install whisper-cpp），或设置环境变量 DSH_REMOTE_WHISPER_BIN 指向 whisper-cli，然后重启 DSH。`
}

function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('语音任务已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

/** 组合调用方取消信号与服务生命周期信号；AbortSignal.any 不可用时手工合并。 */
function mergeSignals(signals) {
  const list = signals.filter(Boolean)
  if (list.length === 0) return new AbortController().signal
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  const abort = () => controller.abort(list.find(signal => signal.aborted)?.reason)
  for (const signal of list) {
    if (signal.aborted) { abort(); break }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

function originOf(value) {
  try { return new URL(value).origin } catch { return undefined }
}

function classifyDownloadFailure(error) {
  const code = error?.code ?? error?.cause?.code
  const name = String(error?.name ?? '')
  if (code === 'ETIMEDOUT' || name === 'TimeoutError') return 'timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EROFS' || code === 'EMFILE' || code === 'ENOTDIR') return 'storage'
  if (typeof code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'certificate'
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENETUNREACH' || code === 'EPIPE') return 'network'
  if (name === 'TypeError' && /fetch failed/i.test(String(error?.message ?? ''))) return 'network'
  return 'unknown'
}

function responseBodyStream(body) {
  // undici/Node 18+ 的 Response.body 是 web ReadableStream；pipeline 需要 Node 流。
  if (typeof body?.getReader === 'function') return Readable.fromWeb(body)
  return body
}

function isExecutableFile(path, platform) {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, fsConstants.X_OK)
    return true
  } catch { return false }
}

/** DSH_REMOTE_WHISPER_BIN 优先，否则在 PATH 里找 whisper-cli。 */
function resolveWhisperBinary({ configured, pathEnv, platform }) {
  if (configured) return isExecutableFile(configured, platform) ? configured : undefined
  const names = platform === 'win32' ? ['whisper-cli.exe', 'whisper-cli'] : ['whisper-cli']
  for (const entry of String(pathEnv ?? '').split(delimiter)) {
    if (!entry) continue
    for (const name of names) {
      const candidate = join(entry, name)
      if (isExecutableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}

/** 语言提示透传服务端校验过的代码；'zh-CN' 这类区域标记按主语言处理。 */
function normalizeLanguage(language) {
  const raw = String(language ?? '').trim().toLowerCase()
  if (!raw || raw === 'auto') return 'auto'
  const base = raw.split(/[-_]/)[0]
  if (DEFAULT_LANGUAGES.includes(base)) return base
  return /^[a-z]{2,3}$/.test(base) ? base : 'auto'
}

/**
 * 校验手机端上传的完整 WAV（16 kHz 单声道 PCM16），返回时长。
 * 只读头与 data 长度，不做转码；上游已校验时这层是最后一道防线。
 */
function readWaveSeconds(audio) {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 44) {
    throw new SpeechInputError('音频必须是 16 kHz 单声道 PCM16 WAV 录音')
  }
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new SpeechInputError('音频必须是 16 kHz 单声道 PCM16 WAV 录音')
  }
  let format
  let dataBytes
  let offset = 12
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      if (body + 16 > data.length) break
      format = {
        encoding: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        sampleRate: data.readUInt32LE(body + 4),
        bits: data.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataBytes = Math.min(size, data.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (!format || dataBytes === undefined) {
    throw new SpeechInputError('音频必须是 16 kHz 单声道 PCM16 WAV 录音')
  }
  if (format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) {
    throw new SpeechInputError('音频必须是 16 kHz 单声道 PCM16 WAV 录音')
  }
  return dataBytes / 32000
}

/** 中日韩字符（含全角标点）：拼段时不在中文边界插入空格。 */
const CJK_EDGE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/

/** whisper-cli 的 -otxt 输出按段分行；丢掉空行/静音占位后拼成一段，方便直接插入输入框。 */
function normalizeTranscript(raw) {
  const lines = String(raw)
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line && !/^\[blank_audio\]$/i.test(line))
  let text = ''
  for (const line of lines) {
    if (!text) { text = line; continue }
    const boundary = CJK_EDGE.test(text.slice(-1)) || CJK_EDGE.test(line.slice(0, 1))
    text += (boundary ? '' : ' ') + line
  }
  return text
}

/**
 * 运行一次 whisper-cli 子进程；取消时 SIGKILL，超时同样杀掉并给出中文原因。
 * @returns stderr 文本（截断），退出码非 0 或取消时 reject。
 */
function runCommand(binary, args, { signal, timeoutMs, timeoutMessage = 'whisper-cli 执行超时' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return }
    let child
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(new Error(`无法启动 whisper-cli：${error.message}`))
      return
    }
    let stderr = ''
    let settled = false
    let timedOut = false
    const kill = () => { try { child.kill('SIGKILL') } catch {} }
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill() }, timeoutMs) : undefined
    timer?.unref?.()
    const onAbort = () => kill()
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_LOG_BYTES) stderr += chunk })
    child.once('error', error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error.code === 'ENOENT' ? new Error(whisperMissingMessage(binary)) : new Error(`无法启动 whisper-cli：${error.message}`))
    })
    child.once('close', (code, closeSignal) => {
      if (settled) return
      settled = true
      cleanup()
      if (signal?.aborted) { reject(abortError(signal)); return }
      if (timedOut) { reject(new Error(timeoutMessage)); return }
      if (code === 0) { resolve(stderr); return }
      const tail = stderr.trim().slice(-500)
      reject(new Error(`whisper-cli 执行失败（退出码 ${code ?? closeSignal}）${tail ? `：${tail}` : ''}`))
    })
  })
}

/** 准备步骤的初始形态：check 正在跑，其余等待；重试/取消后重置，避免残留上一次的失败标记。 */
function initialSteps() {
  return STEP_KINDS.map(kind => (kind === 'check'
    ? { kind, status: 'running', startedAt: Date.now() }
    : { kind, status: 'pending' }))
}

function defaultDataRoot(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'speech-to-text', 'whisper')
}

/**
 * 创建本地 Whisper provider（纯工厂，不注册、不联网、不读盘）。
 * @param options 可覆盖 providerId/dataRoot/model/whisperBin/fetch 等，主要供测试注入。
 */
export function createWhisperProvider(options = {}) {
  return new WhisperProvider(options)
}

class WhisperProvider {
  constructor(options = {}) {
    this.config = {
      providerId: options.providerId || 'whisper-local',
      name: options.name || 'Whisper (local)',
      languages: [...(options.languages || DEFAULT_LANGUAGES)],
      dataRoot: options.dataRoot || defaultDataRoot(),
      model: { ...DEFAULT_MODEL, ...(options.model || {}) },
      downloadSources: [...(options.downloadSources || DEFAULT_DOWNLOAD_SOURCES)],
      binary: options.whisperBin ?? process.env.DSH_REMOTE_WHISPER_BIN ?? '',
      pathEnv: options.pathEnv ?? process.env.PATH ?? '',
      platform: options.platform ?? process.platform,
      fetch: options.fetch ?? globalThis.fetch,
      inferenceTimeoutMs: options.inferenceTimeoutMs ?? INFERENCE_TIMEOUT_MS,
      prepareTimeoutMs: options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS,
      probeTimeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      progressIntervalMs: options.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
      maxPending: options.maxPending ?? MAX_PENDING_JOBS,
      tmpDir: options.tmpDir,
    }
    this.info = Object.freeze({
      id: this.config.providerId,
      name: this.config.name,
      location: 'host-local',
      languages: Object.freeze([...this.config.languages]),
      downloadSources: Object.freeze([...this.config.downloadSources]),
      setupEstimate: Object.freeze({
        recommendedDiskBytes: this.config.model.bytes,
        expectedMemoryBytes: Math.ceil(this.config.model.bytes * 2),
        minimumMinutes: 2,
        maximumMinutes: 20,
      }),
    })
    this.state = {
      phase: 'unprepared',
      steps: STEP_KINDS.map(kind => ({ kind, status: 'pending' })),
    }
    this.listeners = new Set()
    this.lifetime = new AbortController()
    this.tail = Promise.resolve()
    this.pending = 0
    this.preparing = undefined
    this.lastProgressAt = 0
    this.disposed = false
    // 官方 provider 把 worker 直接当 preparation 用；这里显式绑定方法，避免调用方解构后丢 this。
    this.preparation = Object.freeze({
      snapshot: () => this.snapshot(),
      subscribe: listener => this.subscribe(listener),
      prepare: prepareOptions => this.prepare(prepareOptions),
      cancel: () => this.cancel(),
      inspect: () => this.inspect(),
    })
  }

  /** 模型落盘位置（诊断与测试用）。 */
  modelPath() {
    return join(this.config.dataRoot, 'models', this.config.model.name)
  }

  snapshot() {
    return this.state
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 发布准备状态；steps 按官方状态机推进，下载进度按进度间隔合并通知。 */
  publish(next) {
    if (this.preparing && TERMINAL_PHASES.has(next.phase)) this.preparing.completed = true
    const previous = this.state
    const steps = next.steps ?? previous.steps.map(item => {
      if (next.phase === 'ready') return { ...item, status: 'complete' }
      if (next.step === 'check' && item.kind !== 'check') return { kind: item.kind, status: 'pending' }
      if (next.step === item.kind) {
        return item.status === 'running' ? item : { kind: item.kind, status: 'running', startedAt: Date.now() }
      }
      if (item.status !== 'running') return item
      if (next.phase === 'failed') return { ...item, status: 'failed' }
      if (next.phase === 'cancelled') return { ...item, status: 'cancelled' }
      return next.step === undefined ? item : { ...item, status: 'complete' }
    })
    this.state = { ...next, steps }
    const now = Date.now()
    if (next.phase === 'downloading' && previous.phase === 'downloading'
      && next.resource === previous.resource && next.completedBytes !== next.totalBytes
      && now - this.lastProgressAt < this.config.progressIntervalMs) return
    this.lastProgressAt = now
    for (const listener of [...this.listeners]) {
      try { listener() } catch {}
    }
  }

  /** 启动时只查盘：组件在不在、模型在不在；不下载、不跑推理。 */
  inspect() {
    if (this.disposed) return Promise.resolve()
    if (this.preparing) return this.preparing.settled
    return this.runPreparation(async (signal) => {
      this.publish({ phase: 'checking', step: 'check', startedAt: Date.now(), steps: initialSteps() })
      const binary = this.resolveBinary()
      if (!binary) throw new Error(whisperMissingMessage(this.config.binary))
      throwIfAborted(signal)
      if (await this.modelMatches(signal)) {
        this.publish({ phase: 'ready' })
        return
      }
      this.publish({
        phase: 'unprepared',
        steps: STEP_KINDS.map(kind => ({ kind, status: kind === 'check' ? 'complete' : 'pending' })),
      })
    })
  }

  /**
   * 开始或加入当前准备任务；完成后 phase=ready。已下载且校验通过的模型不会重复下载。
   * @param prepareOptions { downloadSource?: string } 指定源时只用该源、不降级。
   */
  prepare(prepareOptions = {}) {
    const source = prepareOptions?.downloadSource
    if (source !== undefined && !this.config.downloadSources.includes(source)) {
      throw new Error(`语音下载源不可用：${source}`)
    }
    if (this.preparing) {
      if (this.preparing.downloadSource !== source) throw new Error('请先取消当前语音准备任务，再更换下载源')
      return this.preparing.settled
    }
    if (this.disposed) return Promise.resolve()
    return this.runPreparation(async (signal) => {
      const model = this.config.model
      this.publish({ phase: 'checking', step: 'check', startedAt: Date.now(), steps: initialSteps() })
      const binary = this.resolveBinary()
      if (!binary) throw new Error(whisperMissingMessage(this.config.binary))
      throwIfAborted(signal)
      const destination = this.modelPath()
      this.publish({ phase: 'checking', step: 'model', startedAt: Date.now() })
      if (!(await this.hasModelSize(signal))) await this.download(destination, source, signal)
      // 已存在同字节数文件也要走校验步骤，损坏时删除重下一次。
      this.publish({ phase: 'checking', step: 'verify', startedAt: Date.now() })
      if (!(await this.modelMatches(signal))) {
        await rm(destination, { force: true })
        await this.download(destination, source, signal)
        this.publish({ phase: 'checking', step: 'verify', startedAt: Date.now() })
        if (!(await this.modelMatches(signal))) {
          await rm(destination, { force: true })
          throw new SpeechDownloadError({
            resource: model.name,
            source: source ?? this.config.downloadSources[0],
            reason: 'integrity',
          })
        }
      }
      this.publish({ phase: 'loading', step: 'load', startedAt: Date.now() })
      await this.probe(binary, signal)
      throwIfAborted(signal)
      this.publish({ phase: 'ready' })
    }, source)
  }

  /** 取消未完成的准备；已完成（ready）不撤销。@returns 任务结算后返回。 */
  async cancel() {
    const task = this.preparing
    if (!task) return
    if (!task.completed) {
      this.publish({ phase: 'cancelling', startedAt: Date.now() })
      task.abort.abort(new Error('语音准备已取消'))
    }
    await task.settled
  }

  /** 一次完整的转写：入队（最多 1 个执行 + 2 个排队）→ 落盘 wav → whisper-cli → 读 txt。 */
  async transcribe(input, signal) {
    return await this.enqueue(async combined => await this.execute(input, combined), signal)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.lifetime.abort(new Error('Whisper provider 已卸载'))
    const task = this.preparing
    if (task) {
      task.abort.abort(this.lifetime.signal.reason)
      await task.settled
    }
    await this.tail
  }

  resolveBinary() {
    return resolveWhisperBinary({
      configured: this.config.binary,
      pathEnv: this.config.pathEnv,
      platform: this.config.platform,
    })
  }

  async hasModelSize(signal) {
    throwIfAborted(signal)
    try {
      const info = await stat(this.modelPath())
      return info.isFile() && info.size === this.config.model.bytes
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  async modelMatches(signal) {
    throwIfAborted(signal)
    const path = this.modelPath()
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size !== this.config.model.bytes) return false
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
      throwIfAborted(signal)
      return digest.digest('hex') === this.config.model.sha256
    } catch (error) {
      if (error.code === 'ENOENT') return false
      if (signal?.aborted) throw abortError(signal)
      throw error
    }
  }

  /** 流式下载到临时文件，边下边算 sha256；成功后原子 rename。支持多源顺序降级。 */
  async download(destination, requestedSource, signal) {
    const model = this.config.model
    const origins = requestedSource ? [requestedSource] : [...this.config.downloadSources]
    const failures = []
    for (const origin of origins) {
      throwIfAborted(signal)
      const url = `${origin}${MODEL_REMOTE_PREFIX}${model.name}`
      let source = origin
      let partial
      try {
        await mkdir(dirname(destination), { recursive: true })
        const response = await this.config.fetch(url, { signal })
        source = originOf(response?.url) ?? origin
        if (!response?.ok || !response.body) {
          try { await response?.body?.cancel?.() } catch {}
          throw new SpeechDownloadError({
            resource: model.name,
            source,
            reason: 'http',
            status: response?.status,
          })
        }
        partial = `${destination}.${randomUUID()}.part`
        const digest = createHash('sha256')
        let completedBytes = 0
        const report = () => this.publish({
          phase: 'downloading',
          resource: model.name,
          completedBytes,
          totalBytes: model.bytes,
          step: 'model',
        })
        const progress = new Transform({
          transform: (chunk, _encoding, callback) => {
            completedBytes += chunk.length
            if (completedBytes > model.bytes) {
              callback(new SpeechDownloadError({ resource: model.name, source, reason: 'integrity' }))
              return
            }
            digest.update(chunk)
            report()
            callback(null, chunk)
          },
        })
        report()
        await pipeline(responseBodyStream(response.body), progress, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
        throwIfAborted(signal)
        if (completedBytes !== model.bytes || digest.digest('hex') !== model.sha256) {
          throw new SpeechDownloadError({ resource: model.name, source, reason: 'integrity' })
        }
        await rename(partial, destination)
        partial = undefined
        return source
      } catch (error) {
        if (signal?.aborted) throw abortError(signal)
        failures.push(error instanceof SpeechDownloadError
          ? error
          : new SpeechDownloadError({ resource: model.name, source, reason: classifyDownloadFailure(error) }, { cause: error }))
      } finally {
        if (partial) await rm(partial, { force: true }).catch(() => {})
      }
    }
    const integrity = failures.find(item => item.download?.reason === 'integrity')
    throw integrity ?? failures[failures.length - 1]
      ?? new SpeechDownloadError({ resource: model.name, source: origins[0] ?? 'unknown', reason: 'unknown' })
  }

  /** 加载探测：确认 whisper-cli 真能运行（brew 装坏、架构不匹配等在这里暴露）。 */
  async probe(binary, signal) {
    await runCommand(binary, ['--help'], {
      signal,
      timeoutMs: this.config.probeTimeoutMs,
      timeoutMessage: 'whisper-cli --help 超时',
    })
  }

  enqueue(run, signal) {
    const combined = mergeSignals([signal, this.lifetime.signal])
    throwIfAborted(combined)
    if (this.pending >= this.config.maxPending) {
      throw new Error(`语音识别队列已满（最多排队 ${this.config.maxPending} 个），请稍后重试`)
    }
    this.pending += 1
    const job = this.tail.then(async () => {
      throwIfAborted(combined)
      return await run(combined)
    })
    this.tail = job.then(() => undefined, () => undefined).finally(() => { this.pending -= 1 })
    return job
  }

  async execute(input, signal) {
    if (this.state.phase !== 'ready') {
      throw new Error('Prepare the local speech provider before recording（Whisper 本地模型未就绪，请先点「下载并准备」）')
    }
    const audioSeconds = readWaveSeconds(input?.audio)
    const binary = this.resolveBinary()
    if (!binary) throw new Error(whisperMissingMessage(this.config.binary))
    const workDir = await mkdtemp(join(this.config.tmpDir || tmpdir(), 'dsh-whisper-'))
    const wavPath = join(workDir, 'input.wav')
    const prefix = join(workDir, 'transcript')
    const startedAt = Date.now()
    try {
      await writeFile(wavPath, input.audio, { mode: 0o600 })
      throwIfAborted(signal)
      await runCommand(binary, [
        '-m', this.modelPath(),
        '-f', wavPath,
        '-l', normalizeLanguage(input.language),
        '-nt', '-np', '-otxt',
        '-of', prefix,
      ], {
        signal,
        timeoutMs: this.config.inferenceTimeoutMs,
        timeoutMessage: `Whisper 推理超时（${Math.round(this.config.inferenceTimeoutMs / 1000)} 秒）`,
      })
      throwIfAborted(signal)
      let raw = ''
      try {
        raw = await readFile(`${prefix}.txt`, 'utf8')
      } catch (error) {
        // whisper-cli 对完全静音可能不产出文件；按空文本处理，不算失败。
        if (error.code !== 'ENOENT') throw error
      }
      return {
        text: normalizeTranscript(raw),
        audioSeconds,
        inferenceSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 串行执行一个准备任务；取消/失败都落成可读状态，不把异常抛给调用方。
   * @returns 任务结算（永远 resolve）。
   */
  runPreparation(run, downloadSource) {
    if (this.preparing) return this.preparing.settled
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const task = { abort, settled: Promise.resolve(), completed: false, downloadSource }
    this.preparing = task
    const timer = setTimeout(
      () => abort.abort(new Error(`语音模型准备超时（${Math.round(this.config.prepareTimeoutMs / 60000)} 分钟）`)),
      this.config.prepareTimeoutMs,
    )
    timer.unref?.()
    task.settled = (async () => {
      try {
        await run(abort.signal)
      } catch (error) {
        if (this.disposed || this.lifetime.signal.aborted) return
        this.publish(abort.signal.aborted
          ? { phase: 'cancelled' }
          : {
            phase: 'failed',
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof SpeechDownloadError ? { download: error.download } : {}),
          })
      } finally {
        clearTimeout(timer)
        if (this.preparing === task) this.preparing = undefined
      }
    })()
    return task.settled
  }
}

/**
 * 在 DSH 主机里登记本地 Whisper provider。
 * 用 cordis 动态注入而不是静态 inject：主机没启用官方语音 bundle（无 speechToText 服务）
 * 时回调永不执行，插件其余功能照常启动。返回 cordis fiber。
 */
export function registerWhisperProvider(ctx, options = {}) {
  if (typeof ctx?.inject !== 'function') return undefined
  return ctx.inject(['speechToText'], scoped => {
    const provider = createWhisperProvider(options)
    scoped.effect(() => {
      const unregister = scoped.speechToText.register(provider)
      void provider.preparation.inspect()
      return async () => {
        try {
          await unregister()
        } finally {
          await provider.dispose()
        }
      }
    }, 'dsh-remote: whisper speech provider')
  })
}