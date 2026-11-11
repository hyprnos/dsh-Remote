/* DSH Remote 配置备份 · 零依赖
 * 用途：换机、换签名（卸载重装）前把本机设置导出成一份 JSON，装好后导入还原。
 * 只备份「用户配置」：服务器列表/令牌、界面偏好、主题、语音纠错；
 * 不备份体积大且可重建的缓存（会话历史缓存、图片缓存、草稿）。
 * 隐私：令牌会一起导出，文件请当密钥保管。 */
;(function (root) {
  'use strict'

  /* >>> 纯函数区：tests/config-transfer.test.js 直接切片执行，勿依赖 DOM */
  const KIND = 'dsh-remote-config'
  const SCHEMA = 1
  // 逐项备份的固定键（都是用户可见设置，不含缓存）
  const FIXED_KEYS = [
    'token', 'servers-v2', 'dshRemoteClientIdV2', 'dshNetworkModeV1',
    'showArchivedV1', 'workspaceFilterV1', 'sessionSort', 'fsWorkspaceIdV1', 'lastNewSessionWorkspaceV1',
    'steerSendingEnabled', 'busySendMode', 'mobileEnterAction', 'notify', 'peakRemind', 'showTools',
    'dshPromptPresets', 'seenNotesVersion', 'seenAnnouncementsV1', 'announcementVotesV1', 'dshCollapsedGoalsV1',
  ]
  // 前缀备份：主题、语音纠错等本插件自有设置
  const PREFIXES = ['dsr.']
  // 缓存/易变数据不备份：会话缓存、图片缓存、审批记录、草稿、公告历史正文
  const SKIP = [/cache/i, /history/i, /draft/i, /^dshApprovalRecordsV1:/, /^announcementHistoryV1$/]

  function wanted(key) {
    if (typeof key !== 'string' || !key) return false
    if (SKIP.some(pattern => pattern.test(key))) return false
    if (FIXED_KEYS.includes(key)) return true
    return PREFIXES.some(prefix => key.startsWith(prefix))
  }

  /** 从 Storage 采集可备份配置；返回 { kind, schema, exportedAt, values }。 */
  function collectConfig(storage, options) {
    const values = {}
    const limit = storage && Number.isFinite(storage.length) ? storage.length : 0
    for (let i = 0; i < limit; i++) {
      const key = storage.key(i)
      if (!wanted(key)) continue
      const value = storage.getItem(key)
      if (typeof value === 'string') values[key] = value
    }
    const app = options && options.appVersion ? String(options.appVersion) : ''
    return { kind: KIND, schema: SCHEMA, exportedAt: new Date(options?.now ?? Date.now()).toISOString(), ...(app ? { app } : {}), values }
  }

  /** 校验备份文档；不合法时抛错，错误消息可直接展示。 */
  function parseConfig(text) {
    let payload
    try { payload = JSON.parse(String(text ?? '')) } catch { throw new Error('JSON 解析失败') }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('不是配置文档')
    if (payload.kind !== KIND) throw new Error('不是 DSH Remote 配置文档')
    if (payload.schema !== SCHEMA) throw new Error('配置版本不兼容：' + String(payload.schema))
    const values = payload.values
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('缺少 values')
    const clean = {}
    for (const [key, value] of Object.entries(values)) {
      if (!wanted(key) || typeof value !== 'string') continue
      clean[key] = value
    }
    return { payload, values: clean }
  }

  /** 写入 Storage；返回实际写入的键数量。 */
  function applyConfig(storage, text) {
    const { values } = parseConfig(text)
    let written = 0
    for (const [key, value] of Object.entries(values)) {
      try { storage.setItem(key, value); written += 1 } catch {}
    }
    return { written, keys: Object.keys(values) }
  }

  /** 备份摘要：主机的条数与是否包含令牌，用于界面提示。 */
  function describeConfig(text) {
    const { values } = parseConfig(text)
    let servers = 0
    try { servers = JSON.parse(values['servers-v2'] || '{}').servers?.length || 0 } catch {}
    return { keys: Object.keys(values).length, servers, hasToken: typeof values.token === 'string' && values.token.length > 0 }
  }
  /* <<< 纯函数区 */

  const t = (key, vars) => root.I18N?.t?.(key, vars) || key
  let overlay = null
  let textarea = null

  function storage() { return root.localStorage }

  function ensureUi() {
    if (overlay && overlay.isConnected) return overlay
    overlay = root.document.createElement('div')
    overlay.id = 'config-transfer'
    overlay.className = 'config-transfer hidden'
    overlay.innerHTML = `
      <div class="config-transfer-panel" role="dialog" aria-modal="true">
        <div class="config-transfer-head"><strong data-i18n="config.title"></strong>
          <button type="button" class="mini-btn" data-role="close" data-i18n="config.close"></button></div>
        <p class="config-transfer-hint" data-i18n="config.hint"></p>
        <textarea class="config-transfer-text" spellcheck="false"></textarea>
        <div class="config-transfer-actions">
          <button type="button" class="mini-btn" data-role="dump" data-i18n="config.dump"></button>
          <button type="button" class="mini-btn" data-role="copy" data-i18n="config.copy"></button>
          <button type="button" class="mini-btn" data-role="save" data-i18n="config.save"></button>
          <label class="mini-btn" data-role="pick"><span data-i18n="config.pick"></span>
            <input type="file" accept="application/json,.json" hidden></label>
          <button type="button" class="mini-btn primary" data-role="apply" data-i18n="config.apply"></button>
        </div>
        <div class="config-transfer-status" data-role="status" role="status" aria-live="polite"></div>
      </div>`
    root.document.body.appendChild(overlay)
    textarea = overlay.querySelector('.config-transfer-text')
    const localize = node => { for (const el of node.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n) }
    localize(overlay)
    const status = text => { const node = overlay.querySelector('[data-role="status"]'); if (node) node.textContent = text }
    const dump = () => {
      const doc = collectConfig(storage(), { appVersion: root.__dsrAppVersion || '' })
      textarea.value = JSON.stringify(doc, null, 2)
      try { const d = describeConfig(textarea.value); status(t('config.summary', { keys: d.keys, servers: d.servers, token: d.hasToken ? t('config.yes') : t('config.no') })) } catch { status('') }
    }
    overlay.querySelector('[data-role="close"]').addEventListener('click', () => overlay.classList.add('hidden'))
    overlay.querySelector('[data-role="dump"]').addEventListener('click', dump)
    overlay.querySelector('[data-role="copy"]').addEventListener('click', async () => {
      if (!textarea.value) dump()
      try { await root.navigator.clipboard.writeText(textarea.value); status(t('config.copied')) } catch { textarea.select(); status(t('config.copyManual')) }
    })
    overlay.querySelector('[data-role="save"]').addEventListener('click', () => {
      if (!textarea.value) dump()
      try {
        const blob = new root.Blob([textarea.value], { type: 'application/json' })
        const url = root.URL.createObjectURL(blob)
        const link = root.document.createElement('a')
        link.href = url
        link.download = 'dsh-remote-config-' + new Date().toISOString().slice(0, 10) + '.json'
        root.document.body.appendChild(link); link.click(); link.remove()
        root.setTimeout(() => root.URL.revokeObjectURL(url), 60000)
        status(t('config.saved'))
      } catch (error) { status(t('config.saveFailed', { msg: String(error?.message || error) })) }
    })
    overlay.querySelector('[data-role="pick"] input').addEventListener('change', event => {
      const file = event.target.files && event.target.files[0]
      if (!file) return
      const reader = new root.FileReader()
      reader.onload = () => { textarea.value = String(reader.result || ''); status(t('config.loaded', { name: file.name })) }
      reader.onerror = () => status(t('config.loadFailed'))
      reader.readAsText(file)
      event.target.value = ''
    })
    overlay.querySelector('[data-role="apply"]').addEventListener('click', () => {
      try {
        const result = applyConfig(storage(), textarea.value)
        status(t('config.applied', { keys: result.written }))
        root.setTimeout(() => root.location.reload(), 600)
      } catch (error) { status(t('config.applyFailed', { msg: String(error?.message || error) })) }
    })
    return overlay
  }

  function open() {
    ensureUi().classList.remove('hidden')
    const dump = overlay.querySelector('[data-role="dump"]')
    if (!textarea.value) dump.click()
  }
  function close() { if (overlay) overlay.classList.add('hidden') }

  const api = { KIND, SCHEMA, FIXED_KEYS, wanted, collectConfig, parseConfig, applyConfig, describeConfig, open, close }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshConfigTransfer = api
})(typeof window === 'undefined' ? globalThis : window)
