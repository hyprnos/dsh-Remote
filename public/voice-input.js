/* DSH Remote 手机端语音输入 · 零依赖
 * 链路：getUserMedia + MediaRecorder 录音 → decodeAudioData → OfflineAudioContext(1ch, 16kHz)
 *      重采样 → PCM16 → 44 字节标准 WAV → 规范 base64 → speech.transcribe RPC
 *      → 文本插入 #composer-input 光标处（不自动发送，派发 input 让发送按钮状态刷新）。
 * DSH 宿主对音频强校验：16 kHz / 单声道 / PCM16 / 标准 WAV 头 / 无换行规范 base64，
 * 浏览器给的录音容器（webm/opus 等）必须前端自行重采样后重新编码，服务端不做转换。
 * 入口可见性：安全上下文 + 具备录音能力 + speech.catalog 成功。
 * 手机浏览器直连 http://局域网IP:8787 不是安全上下文（navigator.mediaDevices 通常不存在），
 * 此时隐藏麦克风，避免点了没反应；安卓 App 内页面是 http://localhost，属可信来源。 */
;(function (root) {
  'use strict'

  /* >>> 纯函数区：tests/voice-input.test.js 用 vm 切片直接执行，勿依赖 window/document */
  const SAMPLE_RATE = 16000
  const BYTES_PER_SECOND = SAMPLE_RATE * 2

  // 44 字节标准 WAV 头（PCM）: RIFF/WAVE/fmt /data，16 kHz、单声道、16 bit。
  // 宿主 validateWave 要求 RIFF size == len-8、data size == len-44 且 data size 为偶数。
  function encodeWav(samples, sampleRate) {
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : SAMPLE_RATE
    const total = samples && samples.length ? samples.length : 0
    const dataSize = total * 2
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)
    const writeTag = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    writeTag(0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeTag(8, 'WAVE')
    writeTag(12, 'fmt ')
    view.setUint32(16, 16, true)             // fmt chunk size
    view.setUint16(20, 1, true)              // audioFormat = PCM
    view.setUint16(22, 1, true)              // channels = 1
    view.setUint32(24, rate, true)           // sampleRate
    view.setUint32(28, rate * 2, true)       // byteRate
    view.setUint16(32, 2, true)              // blockAlign
    view.setUint16(34, 16, true)             // bitsPerSample
    writeTag(36, 'data')
    view.setUint32(40, dataSize, true)
    for (let i = 0; i < total; i++) {
      const value = Math.max(-1, Math.min(1, Number(samples[i]) || 0))
      view.setInt16(44 + i * 2, value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), true)
    }
    return new Uint8Array(buffer)
  }

  // 规范 base64：无换行、无 data: 前缀、非 URL-safe。分块避免超大数组 apply 爆栈。
  function toBase64(bytes) {
    const source = bytes || new Uint8Array(0)
    const chunk = 8192
    let binary = ''
    for (let offset = 0; offset < source.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, source.subarray(offset, offset + chunk))
    }
    return btoa(binary)
  }

  // 仅测试/自检用：把规范 base64 还原成字节。
  function decodeBase64(text) {
    const binary = atob(String(text == null ? '' : text))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  // 入口可见性判定：安全上下文、录音能力、speech.catalog 三项全真才显示。
  // hasMediaDevices 传入的是「能否录音」的综合能力（mediaDevices + MediaRecorder + 离线渲染）。
  function shouldShowMic(flags) {
    const value = flags || {}
    return value.secure === true && value.hasMediaDevices === true && value.catalogOk === true
  }

  // 在光标处插入文本并保留原有内容，返回插入后的光标位置。
  function insertAtCursor(el, text) {
    if (!el) return 0
    const value = String(el.value == null ? '' : el.value)
    const start = Number.isInteger(el.selectionStart) && el.selectionStart >= 0 ? Math.min(el.selectionStart, value.length) : value.length
    const end = Number.isInteger(el.selectionEnd) && el.selectionEnd >= start ? Math.min(el.selectionEnd, value.length) : start
    const inserted = String(text == null ? '' : text)
    const before = value.slice(0, start)
    const caret = before.length + inserted.length
    el.value = before + inserted + value.slice(end)
    if (typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(caret, caret) } catch (_) {}
    }
    return caret
  }
  /* <<< 纯函数区 */

  const DEFAULT_MAX_DURATION_SECONDS = 120
  const DEFAULT_MAX_AUDIO_BYTES = 4 * 1024 * 1024
  const PREPARE_POLL_MS = 2000
  const PREPARE_BACKOFF_MS = 5000
  const PREPARE_MAX_MS = 30 * 60 * 1000
  const PREPARE_RETRY_DELAYS = [5000, 20000, 60000]
  const USABLE_PHASES = ['ready', 'standby', 'waking']

  let host = null
  let catalog = null
  let catalogState = 'idle'   // idle | loading | ok | error | unavailable
  let probeStamp = 0
  let probeTimer = null
  let probeFailures = 0
  let mode = 'idle'           // idle | recording | transcribing | preparing
  let session = null
  let barEls = null
  let barAction = null
  let prepareProviderId = ''
  let pollTimer = null
  let pollStartedAt = 0
  let hideBarTimer = null
  const ABORTED = { voiceAbort: true }

  function t(key, vars) {
    if (host && typeof host.t === 'function') return host.t(key, vars)
    return key
  }
  function toast(text, kind) {
    if (host && typeof host.toast === 'function') host.toast(text, kind || '')
  }
  function el(id) {
    if (host && typeof host.$ === 'function') {
      const node = host.$(id)
      if (node) return node
    }
    return typeof document === 'undefined' ? null : document.getElementById(id)
  }
  const messageOf = error => (error && error.message ? String(error.message) : '')
  const reasonOf = error => (error && error.details && error.details.reason ? String(error.details.reason) : messageOf(error))

  /* ---------------- catalog / 能力探测 ---------------- */
  function normalizeCatalog(value) {
    const raw = value && typeof value === 'object' ? value : {}
    const providers = Array.isArray(raw.providers) ? raw.providers.filter(item => item && typeof item.id === 'string' && item.id) : []
    const selection = raw.selection && typeof raw.selection === 'object' ? raw.selection : {}
    const providerId = typeof selection.providerId === 'string' && selection.providerId ? selection.providerId : (providers[0] ? providers[0].id : '')
    const maxDurationSeconds = Number(raw.maxDurationSeconds)
    const maxAudioBytes = Number(raw.maxAudioBytes)
    return {
      providers,
      providerId,
      language: typeof selection.language === 'string' ? selection.language : '',
      maxDurationSeconds: Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0 ? maxDurationSeconds : DEFAULT_MAX_DURATION_SECONDS,
      maxAudioBytes: Number.isFinite(maxAudioBytes) && maxAudioBytes > 64 ? maxAudioBytes : DEFAULT_MAX_AUDIO_BYTES
    }
  }
  function providerById(id) {
    if (!catalog || !id) return null
    return catalog.providers.find(item => item.id === id) || null
  }
  function selectedProvider() {
    if (!catalog) return null
    return providerById(catalog.providerId) || catalog.providers[0] || null
  }
  function phaseUsable(phase) { return USABLE_PHASES.indexOf(String(phase || '')) >= 0 }
  function canCaptureAudio() {
    const navigatorRef = root.navigator || {}
    const media = !!(navigatorRef.mediaDevices && typeof navigatorRef.mediaDevices.getUserMedia === 'function')
    const recorder = typeof root.MediaRecorder === 'function'
    const offline = typeof root.OfflineAudioContext === 'function' || typeof root.webkitOfflineAudioContext === 'function'
    return media && recorder && offline
  }
  function effectiveLimitSeconds() {
    const byTime = catalog ? catalog.maxDurationSeconds : DEFAULT_MAX_DURATION_SECONDS
    const byBytes = catalog && catalog.maxAudioBytes > 44 ? Math.floor((catalog.maxAudioBytes - 44) / BYTES_PER_SECOND) : byTime
    return Math.max(1, Math.min(byTime, byBytes))
  }

  function scheduleProbeRetry() {
    if (probeFailures >= PREPARE_RETRY_DELAYS.length) return
    const delay = PREPARE_RETRY_DELAYS[probeFailures]
    probeFailures++
    root.clearTimeout(probeTimer)
    probeTimer = root.setTimeout(() => { probeTimer = null; void probeCatalog() }, delay)
  }

  // 能力探测失败一律静默：catalog 不存在（老网关/未启用语音 bundle）就隐藏入口，不刷错误。
  async function probeCatalog() {
    if (!host || typeof host.rpc !== 'function') return null
    if (catalogState === 'unavailable') return null
    if (host.token && !host.token()) { catalogState = 'idle'; renderMic(); return null }
    const stamp = ++probeStamp
    catalogState = 'loading'
    try {
      const value = await host.rpc('speech.catalog', {}, 15000)
      if (stamp !== probeStamp) return catalog
      catalog = normalizeCatalog(value)
      catalogState = 'ok'
      probeFailures = 0
      renderMic()
      return catalog
    } catch (error) {
      if (stamp !== probeStamp) return catalog
      catalog = null
      const message = messageOf(error)
      if (message === 'AUTH') { catalogState = 'idle'; renderMic(); return null }
      if ((error && error.code === 'speech/unavailable') || /HTTP 404/.test(message)) {
        catalogState = 'unavailable'
        renderMic()
        return null
      }
      catalogState = 'error'
      renderMic()
      scheduleProbeRetry()
      return null
    }
  }

  function markUnavailable() {
    probeStamp++
    catalogState = 'unavailable'
    catalog = null
    mode = 'idle'
    stopPreparationPolling()
    hideBar()
    renderMic()
  }

  /* ---------------- 麦克风按钮 ---------------- */
  function renderMic() {
    const button = el('btn-mic')
    if (!button) return
    const visible = shouldShowMic({
      secure: root.isSecureContext === true,
      hasMediaDevices: canCaptureAudio(),
      catalogOk: catalogState === 'ok' && !!catalog
    })
    button.classList.toggle('hidden', !visible)
    button.classList.toggle('recording', mode === 'recording')
    button.disabled = mode === 'starting' || mode === 'transcribing' || mode === 'preparing'
    button.setAttribute('aria-pressed', mode === 'recording' ? 'true' : 'false')
    const label = t(mode === 'recording' ? 'voice.stop' : 'voice.start')
    button.title = label
    button.setAttribute('aria-label', label)
  }

  /* ---------------- 内联提示行（录音/转写/模型准备） ---------------- */
  function ensureBar() {
    if (barEls && barEls.bar.isConnected) return barEls
    const wrap = el('composer-wrap')
    const composer = wrap && wrap.querySelector ? wrap.querySelector('.composer') : null
    if (!wrap || !composer || typeof document === 'undefined') return null
    const bar = document.createElement('div')
    bar.id = 'voice-input-bar'
    bar.className = 'voice-input-bar hidden'
    bar.setAttribute('role', 'status')
    bar.setAttribute('aria-live', 'polite')
    const dot = document.createElement('span')
    dot.className = 'voice-input-dot'
    dot.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.className = 'voice-input-text'
    const action = document.createElement('button')
    action.id = 'voice-input-action'
    action.className = 'voice-input-action hidden'
    action.type = 'button'
    action.addEventListener('click', () => { if (typeof barAction === 'function') void barAction() })
    bar.appendChild(dot)
    bar.appendChild(text)
    bar.appendChild(action)
    wrap.insertBefore(bar, composer)
    barEls = { bar, dot, text, action }
    return barEls
  }

  function setBar(text, options) {
    const ui = ensureBar()
    if (!ui) return
    const settings = options || {}
    root.clearTimeout(hideBarTimer)
    hideBarTimer = null
    ui.text.textContent = text
    ui.bar.classList.toggle('recording', settings.recording === true)
    ui.bar.classList.toggle('error', settings.error === true)
    barAction = typeof settings.action === 'function' ? settings.action : null
    if (barAction) {
      ui.action.textContent = settings.actionLabel || ''
      ui.action.classList.remove('hidden')
    } else {
      ui.action.textContent = ''
      ui.action.classList.add('hidden')
    }
    ui.bar.classList.remove('hidden')
  }

  function hideBar() {
    root.clearTimeout(hideBarTimer)
    hideBarTimer = null
    barAction = null
    if (barEls && barEls.bar) {
      barEls.bar.classList.add('hidden')
      barEls.bar.classList.remove('recording', 'error')
      barEls.text.textContent = ''
      barEls.action.classList.add('hidden')
    }
  }

  function hideBarLater(delay) {
    root.clearTimeout(hideBarTimer)
    hideBarTimer = root.setTimeout(() => { hideBarTimer = null; hideBar() }, delay)
  }

  /* ---------------- 录音 ---------------- */
  function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0))
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
  }

  async function toggleRecording() {
    if (mode === 'recording') { stopRecording(false); return }
    if (mode !== 'idle') return
    await startRecording()
  }

  async function startRecording() {
    if (mode !== 'idle') return
    if (!catalog) {
      const next = await probeCatalog()
      if (!next) return
    }
    const provider = selectedProvider()
    if (!provider || !phaseUsable(provider.preparation && provider.preparation.phase)) {
      showPreparation(provider)
      return
    }
    if (!canCaptureAudio()) { toast(t('voice.notSupported'), 'err'); return }
    // starting 期间按钮禁用：授权弹窗前连点两次会拿到两条流
    mode = 'starting'
    renderMic()
    let stream = null
    try {
      stream = await root.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
    } catch (error) {
      mode = 'idle'
      renderMic()
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      toast(denied ? t('voice.permissionDenied') : t('voice.failed', { msg: messageOf(error) }), 'err')
      return
    }
    // 授权期间换了连接（reset()）：放弃这条流
    if (mode !== 'starting') { releaseStream(stream); return }
    let recorder = null
    try {
      recorder = new root.MediaRecorder(stream)
    } catch (error) {
      mode = 'idle'
      renderMic()
      releaseStream(stream)
      toast(t('voice.failed', { msg: messageOf(error) }), 'err')
      return
    }
    session = { recorder, stream, chunks: [], startedAt: root.Date.now(), discard: false, timer: null }
    recorder.addEventListener('dataavailable', event => {
      if (session && event.data && event.data.size) session.chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => { void finishRecording() })
    recorder.addEventListener('error', event => {
      const error = (event && event.error) || new Error('MediaRecorder')
      if (session) session.failed = error
      void finishRecording()
    })
    try {
      recorder.start()
    } catch (error) {
      mode = 'idle'
      renderMic()
      releaseStream(stream)
      session = null
      toast(t('voice.failed', { msg: messageOf(error) }), 'err')
      return
    }
    mode = 'recording'
    renderMic()
    paintRecording()
    session.timer = root.setInterval(tickRecording, 250)
  }

  function paintRecording() {
    if (!session) return
    const elapsed = (root.Date.now() - session.startedAt) / 1000
    setBar(t('voice.recording', { time: formatClock(elapsed), limit: formatClock(effectiveLimitSeconds()) }), {
      recording: true,
      action: () => stopRecording(true),
      actionLabel: t('voice.cancel')
    })
  }

  function tickRecording() {
    if (!session || mode !== 'recording') return
    if ((root.Date.now() - session.startedAt) / 1000 >= effectiveLimitSeconds()) { stopRecording(false); return }
    paintRecording()
  }

  function stopRecording(discard) {
    if (!session || mode !== 'recording') return
    session.discard = discard === true
    mode = 'transcribing'
    if (session.timer) { root.clearInterval(session.timer); session.timer = null }
    renderMic()
    if (session.discard) hideBar()
    else setBar(t('voice.transcribing'), {})
    try {
      if (session.recorder.state !== 'inactive') session.recorder.stop()
      else void finishRecording()
    } catch (_) {
      void finishRecording()
    }
  }

  function releaseStream(stream) {
    try {
      const tracks = stream && stream.getTracks ? stream.getTracks() : []
      tracks.forEach(track => { try { track.stop() } catch (_) {} })
    } catch (_) {}
  }

  function abortRecording() {
    if (!session) return
    const current = session
    session = null
    if (current.timer) root.clearInterval(current.timer)
    current.discard = true
    try { if (current.recorder.state !== 'inactive') current.recorder.stop() } catch (_) {}
    releaseStream(current.stream)
  }

  async function finishRecording() {
    const current = session
    if (!current) return
    session = null
    releaseStream(current.stream)
    mode = current.discard ? 'idle' : 'transcribing'
    renderMic()
    if (current.discard) { hideBar(); return }
    if (current.failed) {
      mode = 'idle'
      renderMic()
      hideBar()
      toast(t('voice.failed', { msg: messageOf(current.failed) }), 'err')
      return
    }
    const blob = current.chunks.length ? new Blob(current.chunks, { type: (current.recorder && current.recorder.mimeType) || '' }) : null
    if (!blob || !blob.size) {
      mode = 'idle'
      renderMic()
      hideBar()
      toast(t('voice.empty'), 'err')
      return
    }
    const connectionAtStart = connectionId()
    try {
      await transcribe(blob)
    } catch (error) {
      hideBar()
      mode = 'idle'
      renderMic()
      // 换过服务器/令牌时旧请求的结果与错误都不再适用
      if (error !== ABORTED && connectionId() === connectionAtStart) handleTranscribeError(error)
      return
    }
    hideBar()
    mode = 'idle'
    renderMic()
  }

  function connectionId() {
    return host && typeof host.server === 'function' ? String(host.server() || '') : ''
  }

  /* ---------------- 重采样 + 编码 + 转写 ---------------- */
  function decodeAudioData(AudioCtx, arrayBuffer) {
    const context = new AudioCtx()
    return new Promise((resolve, reject) => {
      let settled = false
      const done = value => {
        if (settled) return
        settled = true
        try { if (context.close) void context.close() } catch (_) {}
        resolve(value)
      }
      const fail = error => {
        if (settled) return
        settled = true
        try { if (context.close) void context.close() } catch (_) {}
        reject(error instanceof Error ? error : new Error(messageOf(error) || 'decodeAudioData'))
      }
      let pending = null
      try {
        pending = context.decodeAudioData(arrayBuffer, done, fail)
      } catch (error) {
        fail(error)
        return
      }
      if (pending && typeof pending.then === 'function') pending.then(done, fail)
    })
  }

  async function renderWav(blob) {
    const AudioCtx = root.AudioContext || root.webkitAudioContext
    const Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext
    if (!AudioCtx || !Offline) throw new Error(t('voice.notSupported'))
    const decoded = await decodeAudioData(AudioCtx, await blob.arrayBuffer())
    const duration = Math.min(Number(decoded && decoded.duration) || 0, effectiveLimitSeconds())
    if (!(duration > 0)) throw new Error(t('voice.empty'))
    const frames = Math.max(1, Math.floor(duration * SAMPLE_RATE))
    const offline = new Offline(1, frames, SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0)
    const rendered = await offline.startRendering()
    return encodeWav(rendered.getChannelData(0), SAMPLE_RATE)
  }

  function canonicalBase64(value) {
    const text = String(value == null ? '' : value)
    if (!text || text.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/]+={0,2}$/.test(text)
  }

  async function transcribe(blob) {
    const connectionAtStart = connectionId()
    const wav = await renderWav(blob)
    const maxBytes = catalog ? catalog.maxAudioBytes : 0
    if (maxBytes > 0 && wav.length > maxBytes) { toast(t('voice.tooLarge'), 'err'); throw ABORTED }
    const audioBase64 = toBase64(wav)
    if (!canonicalBase64(audioBase64)) { toast(t('voice.encodingFailed'), 'err'); throw ABORTED }
    const providerId = catalog ? catalog.providerId : ''
    const result = await host.rpc('speech.transcribe', {
      request: { audioBase64, ...(providerId ? { providerId } : {}) }
    }, 180000)
    const text = String(result && result.text != null ? result.text : '').trim()
    if (!text) { toast(t('voice.empty'), 'err'); throw ABORTED }
    // 转写期间切换了服务器：文本不属于当前草稿，丢弃而不是插入
    if (connectionId() !== connectionAtStart) throw ABORTED
    insertTranscript(text)
  }

  // 只插入文本，不自动发送：保留原有内容与焦点，派发 input 让发送按钮状态刷新。
  function insertTranscript(text) {
    const input = el('composer-input')
    if (!input) return
    const caret = insertAtCursor(input, text)
    try { input.focus() } catch (_) {}
    if (typeof input.setSelectionRange === 'function') {
      try { input.setSelectionRange(caret, caret) } catch (_) {}
    }
    try { if (typeof root.Event === 'function') input.dispatchEvent(new root.Event('input', { bubbles: true })) } catch (_) {}
    if (host && typeof host.autosize === 'function') { try { host.autosize(input) } catch (_) {} }
    try { input.scrollTop = input.scrollHeight } catch (_) {}
  }

  function handleTranscribeError(error) {
    const message = messageOf(error)
    const reason = reasonOf(error)
    if (message === 'AUTH') { if (host && host.authFailure) host.authFailure(); return }
    if (error && error.code === 'speech/unavailable') { markUnavailable(); return }
    // 主机模型未准备：刷新一次 catalog 后直接进入准备流程，而不是只报错。
    if (/Prepare the local speech provider/i.test(reason)) {
      void probeCatalog().then(() => showPreparation(selectedProvider()))
      return
    }
    toast(t('voice.failed', { msg: reason || t('err.dshError') }), 'err')
  }

  /* ---------------- 模型准备（下载/加载） ---------------- */
  function showPreparation(provider) {
    prepareProviderId = provider && provider.id ? provider.id : (catalog ? catalog.providerId : '')
    if (!prepareProviderId) {
      setBar(t('voice.notReady'), {})
      return
    }
    const preparation = (provider && provider.preparation) || {}
    const phase = String(preparation.phase || '')
    if (phase === 'failed') { paintPreparation(provider); return }
    if (phase && !phaseUsable(phase) && phase !== 'unprepared' && phase !== 'cancelled') {
      startPreparationPolling()
      paintPreparation(provider)
      return
    }
    setBar(t('voice.notReady'), { action: beginPreparation, actionLabel: t('voice.prepare') })
  }

  async function beginPreparation() {
    if (mode === 'preparing') return
    const providerId = prepareProviderId || (catalog ? catalog.providerId : '')
    if (!providerId) { toast(t('voice.unavailable'), 'err'); return }
    prepareProviderId = providerId
    mode = 'preparing'
    renderMic()
    setBar(t('voice.preparing'), {})
    try {
      await host.rpc('speech.prepare', { providerId }, 30000)
    } catch (error) {
      mode = 'idle'
      renderMic()
      handlePrepareError(error)
      return
    }
    startPreparationPolling()
    // 缓存里的 preparation 可能还是旧的 unprepared，先显示准备中，等第一次轮询出百分比
    setBar(t('voice.preparing'), { action: cancelPreparation, actionLabel: t('voice.cancel') })
  }

  function startPreparationPolling() {
    if (pollTimer) return
    mode = 'preparing'
    pollStartedAt = root.Date.now()
    renderMic()
    schedulePreparationPoll(PREPARE_POLL_MS)
  }

  function stopPreparationPolling() {
    root.clearTimeout(pollTimer)
    pollTimer = null
  }

  function schedulePreparationPoll(delay) {
    root.clearTimeout(pollTimer)
    pollTimer = root.setTimeout(() => { pollTimer = null; void pollPreparation() }, delay)
  }

  // 轮询 catalog 拿准备进度：正常 2s，失败退避 5s，最长 30 分钟；用户可取消。
  async function pollPreparation() {
    if (mode !== 'preparing') return
    if (root.Date.now() - pollStartedAt > PREPARE_MAX_MS) {
      mode = 'idle'
      renderMic()
      setBar(t('voice.prepareTimeout'), { error: true, action: prepareProviderId ? beginPreparation : null, actionLabel: t('voice.retry') })
      return
    }
    let next = null
    try {
      next = await host.rpc('speech.catalog', {}, 20000)
    } catch (error) {
      if (messageOf(error) === 'AUTH') { mode = 'idle'; renderMic(); hideBar(); if (host.authFailure) host.authFailure(); return }
      if (error && error.code === 'speech/unavailable') { markUnavailable(); return }
      schedulePreparationPoll(PREPARE_BACKOFF_MS)
      return
    }
    catalog = normalizeCatalog(next)
    const provider = providerById(prepareProviderId) || selectedProvider()
    const status = paintPreparation(provider)
    if (status === 'ready') { mode = 'idle'; renderMic(); hideBarLater(2600); return }
    if (status === 'failed' || status === 'cancelled') { mode = 'idle'; renderMic(); return }
    schedulePreparationPoll(PREPARE_POLL_MS)
  }

  function paintPreparation(provider) {
    const preparation = (provider && provider.preparation) || {}
    const phase = String(preparation.phase || '')
    if (phaseUsable(phase)) { setBar(t('voice.prepareReady'), {}); return 'ready' }
    if (phase === 'failed') {
      const reason = preparation.message || (preparation.download && preparation.download.reason) || ''
      setBar(t('voice.prepareFailed', { msg: reason || t('err.dshError') }), {
        error: true, action: beginPreparation, actionLabel: t('voice.retry')
      })
      return 'failed'
    }
    if (!phase || phase === 'unprepared' || phase === 'cancelled') {
      setBar(t('voice.notReady'), { action: beginPreparation, actionLabel: t('voice.prepare') })
      return phase ? 'cancelled' : 'waiting'
    }
    const total = Number(preparation.totalBytes)
    const completed = Number(preparation.completedBytes)
    const percent = Number.isFinite(total) && total > 0 && Number.isFinite(completed)
      ? Math.max(0, Math.min(100, Math.floor(completed / total * 100))) : null
    setBar(percent == null ? t('voice.preparing') : t('voice.prepareProgress', { percent }), {
      action: cancelPreparation, actionLabel: t('voice.cancel')
    })
    return 'progress'
  }

  function handlePrepareError(error) {
    const message = messageOf(error)
    if (message === 'AUTH') { if (host.authFailure) host.authFailure(); return }
    if (error && error.code === 'speech/unavailable') { markUnavailable(); return }
    setBar(t('voice.prepareFailed', { msg: reasonOf(error) || t('err.dshError') }), {
      error: true, action: beginPreparation, actionLabel: t('voice.retry')
    })
  }

  async function cancelPreparation() {
    const providerId = prepareProviderId
    stopPreparationPolling()
    mode = 'idle'
    renderMic()
    setBar(t('voice.notReady'), providerId ? { action: beginPreparation, actionLabel: t('voice.prepare') } : {})
    if (!providerId) return
    try {
      await host.rpc('speech.cancelPreparation', { providerId }, 30000)
    } catch (error) {
      if (messageOf(error) === 'AUTH' && host.authFailure) host.authFailure()
    }
  }

  /* ---------------- 挂载 / 连接切换 ---------------- */
  function mount(api) {
    if (!api || typeof api.rpc !== 'function') return false
    host = api
    mode = 'idle'
    const button = el('btn-mic')
    if (button) {
      button.classList.add('hidden')
      button.addEventListener('click', () => { void toggleRecording() })
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && mode === 'recording') stopRecording(false)
      })
    }
    renderMic()
    if (host.token && !host.token()) return true
    void probeCatalog()
    return true
  }

  // 连接身份（地址/令牌）变化：清缓存、停轮询、放弃录音，然后按新连接重新探测。
  function reset() {
    probeStamp++
    catalog = null
    catalogState = 'idle'
    probeFailures = 0
    root.clearTimeout(probeTimer)
    probeTimer = null
    stopPreparationPolling()
    abortRecording()
    mode = 'idle'
    hideBar()
    renderMic()
    if (!host || (host.token && !host.token())) return
    void probeCatalog()
  }

  const api = { encodeWav, toBase64, decodeBase64, shouldShowMic, insertAtCursor, mount, reset }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshVoiceInput = api
})(typeof window === 'undefined' ? globalThis : window)