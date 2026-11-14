// M4-2 / T-UI-01：状态完备、401/403 清理、409 保草稿、保存去抖/重试、脱敏差异、客户端导出。
// 用零依赖 DOM shim 在 node:test 内验证导出函数与界面清理路径；真实浏览器 E2E 由 E 在 R00 执行。
import test from 'node:test'
import assert from 'node:assert/strict'

// ---------- 最小 DOM shim（只实现本套件与 app.js 用到的 API） ----------
class El {
  constructor (tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.children = []
    this.attributes = {}
    this.style = {}
    this.dataset = {}
    this._text = ''
    this.className = ''
    this.id = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.checked = false
    this.listeners = {}
    this.parent = null
  }
  get textContent () { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
  set textContent (v) {
    // 与真实 DOM 一致：textContent 赋值 = 替换为单个文本节点（这样 clear() 能真正清掉）。
    this._text = ''
    this.children = [{ nodeType: 3, textContent: String(v) }]
  }
  append (...nodes) {
    for (const n of nodes) {
      const node = (n && n.nodeType) ? n : { nodeType: 3, textContent: String(n) }
      node.parent = this
      this.children.push(node)
    }
  }
  appendChild (n) { this.append(n) }
  replaceChildren (...nodes) { this.children = []; this._text = ''; this.append(...nodes) }
  removeChild (n) { this.children = this.children.filter((c) => c !== n) }
  remove () { if (this.parent) this.parent.removeChild(this) }
  setAttribute (k, v) { this.attributes[k] = String(v) }
  getAttribute (k) { return this.attributes[k] == null ? null : this.attributes[k] }
  removeAttribute (k) { delete this.attributes[k] }
  addEventListener (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener () {}
  focus () {}
  select () {}
  querySelector () { return null }
  querySelectorAll () { return [] }
  closest () { return null }
  get firstChild () { return this.children[0] || null }
  get firstElementChild () { return this.children.find((c) => c && c.nodeType === 1) || null }
}
const byId = new Map()
function createEl (tag) { return new El(tag) }
globalThis.document = {
  documentElement: { dataset: {} },
  body: createEl('body'),
  createElement: (tag) => createEl(tag),
  createElementNS: (ns, tag) => createEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  getElementById: (id) => {
    if (!byId.has(id)) { const el = createEl('div'); el.id = id; byId.set(id, el) }
    return byId.get(id)
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener () {},
  removeEventListener () {},
}
globalThis.window = {
  location: { origin: 'http://127.0.0.1:8787', hash: '' },
  addEventListener () {},
  removeEventListener () {},
  matchMedia: () => ({ matches: false, addEventListener () {} }),
  scrollTo () {},
  confirm: () => true,
}
globalThis.location = globalThis.window.location
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
globalThis.__MG_UI_TEST__ = true

const { state, phaseOf, loadAll, loadStatus, resetData, handleUnauthorized, setPhase, unknownIfMissing } = await import('../../../src/ui-next/js/store.js')
const { api, ApiError, setToken, clearToken, getToken } = await import('../../../src/ui-next/js/api.js')
const { ConfigDraft, buildSavePayload, ConflictError } = await import('../../../src/ui-next/js/config-draft.js')
const { saveDraft, sanitizeDiff, sourceSummary, expiryStates } = await import('../../../src/ui-next/js/save-flow.js')
const { buildClientExport, CLIENT_EXPORT_FIELDS } = await import('../../../src/ui-next/js/views/clients.js')
const { virtualExpiryLabel } = await import('../../../src/ui-next/js/views/models.js')
const { errorRateText } = await import('../../../src/ui-next/js/views/dashboard.js')
const app = await import('../../../src/ui-next/app.js')

const realFetch = globalThis.fetch
function stubFetch (handler) { globalThis.fetch = async (url, opts) => handler(String(url), opts || {}) }
function jsonRes (status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}
function resetAppState () {
  globalThis.fetch = realFetch
  clearToken()
  resetData()
  state.phase = { auth: 'idle', status: 'idle', config: 'idle', logs: 'idle' }
}
function sampleConfig (extra = {}) {
  return Object.assign({
    configVersion: 3,
    providers: { p: { baseUrl: 'http://127.0.0.1:1', api: 'openai' } },
    models: { m: { provider: 'p', capability: 'chat' } },
    defaults: { clientKey: '********', proxyMode: 'direct' },
    virtualModels: [],
  }, extra)
}

test('状态完备：loading / ready / error 可由 phaseOf 区分，error 不保留伪造数据', async () => {
  resetAppState()
  let releaseStatus
  stubFetch((url) => {
    if (url.includes('/api/status')) return new Promise((resolve) => { releaseStatus = () => resolve(jsonRes(200, { configVersion: 9 })) })
    return Promise.reject(new Error('unexpected ' + url))
  })
  const pending = loadStatus()
  await Promise.resolve()
  assert.equal(phaseOf('status'), 'loading', '请求未返回前必须是 loading')
  assert.equal(state.status, null, 'loading 时不得展示旧/伪造数据')
  releaseStatus()
  await pending
  assert.equal(phaseOf('status'), 'ready')

  resetAppState()
  stubFetch(() => jsonRes(500, { error: 'boom' }))
  await assert.rejects(loadAll())
  assert.equal(phaseOf('status'), 'error')
  assert.equal(phaseOf('config'), 'error')
  assert.equal(state.status, null)
  assert.equal(state.config, null)

  resetAppState()
  stubFetch((url) => jsonRes(200, url.includes('/api/status') ? null : null))
  const empty = await loadAll()
  assert.equal(phaseOf('status'), 'empty', '返回 null 必须归为 empty，而不是 ready/0')
  assert.equal(empty.status, null)
})

test('401 会话失效：清空状态与已渲染敏感投影并锁屏；功能级 403 只做局部错误', async () => {
  resetAppState()
  setToken('stale-token')
  state.status = { configVersion: 7, providers: [{ id: 'SENSITIVE-PROVIDER' }], global: { requests: 42 } }
  state.config = sampleConfig({ defaults: { clientKey: '********' } })
  const root = document.getElementById('view-root')
  root.textContent = 'SENSITIVE-QUOTA-42'
  const overlay = document.getElementById('auth-overlay')
  overlay.hidden = true

  app.handleUnauthorizedUi({ status: 401 })
  assert.equal(state.status, null, '401 后状态必须清空')
  assert.equal(state.config, null)
  assert.equal(phaseOf('status'), 'idle')
  assert.equal(root.textContent.includes('SENSITIVE-QUOTA-42'), false, '旧 DOM 文本必须被清除')
  assert.equal(root.textContent.includes('控制面已锁定'), true, '应跳转登录/锁定页')
  assert.equal(overlay.hidden, false, '登录层应显示')
  assert.equal(getToken(), '', '令牌必须清除')

  // api 层：401 必须走会话失效（清空 + 清 token）
  resetAppState()
  setToken('token-401')
  state.config = sampleConfig()
  stubFetch(() => jsonRes(401, { error: 'unauthorized' }))
  await assert.rejects(api.config(), (e) => e instanceof ApiError && e.status === 401)
  assert.equal(state.config, null, '401 后必须清空已渲染投影')
  assert.equal(getToken(), '', '401 清除令牌')

  // api 层：功能级 403 绝不能当会话失效（不清 token / 不清数据 / 不锁屏）
  resetAppState()
  setToken('token-keep')
  state.status = { configVersion: 8, providers: [{ id: 'KEEP-VIEW-DATA' }] }
  state.config = sampleConfig()
  const root2 = document.getElementById('view-root')
  root2.textContent = 'KEEP-VIEW-DATA'
  const overlay2 = document.getElementById('auth-overlay')
  overlay2.hidden = true
  stubFetch(() => jsonRes(403, { error: 'write disabled', code: 'write_disabled' }))
  await assert.rejects(api.config(), (e) => e instanceof ApiError && e.status === 403 && e.data && e.data.code === 'write_disabled')
  assert.equal(getToken(), 'token-keep', '功能级 403 不得清除令牌')
  assert.notEqual(state.config, null, '功能级 403 不得清空其它视图数据')
  assert.notEqual(state.status, null)
  assert.equal(root2.textContent.includes('KEEP-VIEW-DATA'), true, 'DOM 不得被清空')
  assert.equal(overlay2.hidden, true, '功能级 403 不得锁屏')
})

test('409 冲突：保留用户草稿逐字段不变，不覆盖用户输入', async () => {
  resetAppState()
  const draft = new ConfigDraft(sampleConfig())
  draft.data.defaults.proxyMode = 'auto'
  draft.data.models.m.quota = 123
  const snapshot = JSON.parse(JSON.stringify(draft.data))
  const originalSave = api.saveConfig
  api.saveConfig = async () => { throw new ApiError('conflict', 409, { currentVersion: 9 }) }
  try {
    await assert.rejects(draft.save(), (e) => e instanceof ConflictError && e.currentVersion === 9)
    assert.deepEqual(draft.data, snapshot, '冲突后草稿必须逐字段保持用户输入')
    assert.equal(draft.baseVersion, 3, '冲突不得改变草稿基准版本')
  } finally { api.saveConfig = originalSave }
})

test('空白掩码/未编辑字段：save payload 中完全不出现 clientKey', () => {
  const draft = new ConfigDraft(sampleConfig())
  assert.equal(Object.prototype.hasOwnProperty.call(buildSavePayload(draft).defaults, 'clientKey'), false, '未编辑 ⇒ 字段不出现')
  draft.data.defaults.clientKey = 'sk-SENTINEL-NEW'
  assert.equal(buildSavePayload(draft).defaults.clientKey, 'sk-SENTINEL-NEW', '编辑新值才上送')
  draft.data.defaults.clientKey = '********  '
  assert.equal(Object.prototype.hasOwnProperty.call(buildSavePayload(draft).defaults, 'clientKey'), false, '空白掩码视为未改动')
  draft.data.defaults.clientKey = ''
  assert.equal(buildSavePayload(draft).defaults.clientKey, '', '显式清空才发送空串')
})

test('保存去抖与重试：并发共享一次提交，失败后可重试成功', async () => {
  let calls = 0
  const fake = { save: async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { version: calls } } }
  const [a, b] = await Promise.all([saveDraft(fake), saveDraft(fake)])
  assert.equal(calls, 1, '同一草稿并发保存只能提交一次')
  assert.equal(a.version, 1)
  assert.equal(b.version, 1)
  await saveDraft(fake)
  assert.equal(calls, 2, '完成后可以再次保存')

  let attempts = 0
  const flaky = { save: async () => { attempts += 1; if (attempts === 1) throw new Error('network down'); return { version: 7 } } }
  await assert.rejects(saveDraft(flaky), /network down/)
  const retried = await saveDraft(flaky)
  assert.equal(attempts, 2, '失败后重试必须重新提交一次')
  assert.equal(retried.version, 7)
})

test('差异脱敏：secret 只显示已设置/已修改，不泄露值、不泄露代理凭据', () => {
  const rows = sanitizeDiff([
    { path: 'defaults.clientKey', before: '********', after: 'sk-SENTINEL-X' },
    { path: 'providers.p.extraHeaders.authorization', before: 'Bearer sk-SENTINEL-A', after: 'Bearer sk-SENTINEL-B' },
    { path: 'providers.p.proxy', before: 'http://user:pass@127.0.0.1:7890', after: 'http://127.0.0.1:7890' },
    { path: 'models.m.quota', before: 0, after: 10 },
  ])
  const text = JSON.stringify(rows)
  assert.equal(text.includes('sk-SENTINEL'), false, '差异展示不得包含凭据值')
  assert.equal(text.includes('user:pass'), false, '代理凭据必须脱敏')
  assert.match(rows[0].after, /已修改/)
  assert.match(rows[1].after, /已修改/)
  assert.equal(rows[3].after, '10', '非敏感字段保持原值展示')
})

test('来源/代际与有效期状态：只展示后端 expiresAtState，未知不当作正常', () => {
  resetAppState()
  state.config = sampleConfig({ configVersion: 5 })
  state.status = { configVersion: 7, codex: { catalog: { path: '/tmp/catalog-default.json', generatedAt: '2026-11-11' } } }
  const draft = new ConfigDraft(sampleConfig({ configVersion: 5 }))
  const summary = sourceSummary(draft)
  assert.match(summary, /草稿基于版本 5/)
  assert.match(summary, /可编辑投影版本 5/)
  assert.match(summary, /运行版本 7/)
  assert.match(summary, /目录来源 .*catalog-default\.json/)

  assert.deepEqual(expiryStates({ virtualModels: [{ name: 'a', expiresAtState: 'expired' }, { name: 'b' }] }), [
    { name: 'a', state: 'expired', expiresAt: '' },
    { name: 'b', state: 'unknown', expiresAt: '' },
  ])
  assert.equal(virtualExpiryLabel({ expiresAtState: 'invalid', expiresAtDiagnostic: 'expiry_invalid_calendar' }).label, '有效期无效（拒绝放行）')
  assert.equal(virtualExpiryLabel({ expiresAtState: 'expired' }).kind, 'bad')
  assert.equal(virtualExpiryLabel({}).label, '未知（后端未返回状态）')
  assert.equal(errorRateText({ requests: null, errors: 0 }), '未知（无请求计数）')
  assert.equal(errorRateText({ requests: 0, errors: 0 }), '未知（无请求计数）')
  assert.equal(errorRateText({ requests: 10, errors: 2 }), '错误率 20.0%')
  assert.equal(unknownIfMissing(undefined, (v) => v), '未知')
})

test('客户端导出：只含客户端字段，零凭据零服务端私有字段', () => {
  const exported = buildClientExport({
    origin: 'http://127.0.0.1:8787',
    config: sampleConfig({
      providers: { p: { baseUrl: 'http://upstream:1', apiKeyEnv: 'SK_ENV', extraHeaders: { authorization: 'Bearer sk-SENTINEL' }, proxy: 'http://u:p@h:1' } },
      models: { m: { provider: 'p', capability: 'chat', api: 'responses', quota: 5, fallbacks: ['p'] } },
      virtualModels: [{ name: 'vm', expiresAtState: 'valid', quota: 9 }],
    }),
    status: { defaults: { clientKey: '********' } },
  })
  assert.deepEqual(Object.keys(exported).sort(), [...CLIENT_EXPORT_FIELDS].sort(), '导出顶层字段必须受所有权白名单约束')
  assert.equal(JSON.stringify(exported).includes('sk-'), false, '导出 JSON 不得命中 sk- 哨兵')
  assert.equal(JSON.stringify(exported).includes('Bearer'), false)
  assert.deepEqual(Object.keys(exported.models[0]).sort(), ['api', 'capability', 'name'], '模型只导出客户端字段')
  assert.equal(exported.models[0].provider, undefined, 'provider 属于服务端私有字段')
  assert.equal(exported.models[0].quota, undefined, '额度不导出')
  assert.equal(exported.clientKey, '已设置', 'Key 只给状态不给值')
  assert.equal(exported.baseUrl, 'http://127.0.0.1:8787/v1')
})

test('loading 骨架：首屏/刷新/切路由在数据到达前可达，旧数据不得顶替', async () => {
  resetAppState()
  // 切路由：phase=loading 且内存里仍有旧数据 → 必须显示骨架，不得渲染旧数据
  state.status = { configVersion: 1, providers: [{ id: 'STALE-SENTINEL' }], global: {} }
  state.config = sampleConfig()
  setPhase('status', 'loading')
  const root = document.getElementById('view-root')
  app.renderRoute('providers')
  assert.equal(root.textContent.includes('STALE-SENTINEL'), false, 'loading 时不得用旧数据顶替')
  assert.ok(root.textContent.includes('正在读取控制面'), '切路由时必须出现 loading 骨架')

  // 首屏 bootstrap：延迟 status/config，响应到达前必须是骨架，到达后才是真实视图
  resetAppState()
  let releaseStatus
  let releaseConfig
  stubFetch((url) => {
    if (url.includes('/api/auth')) return Promise.resolve(jsonRes(200, { needAuth: false, startedAt: 1 }))
    if (url.includes('/api/status')) return new Promise((resolve) => { releaseStatus = () => resolve(jsonRes(200, { configVersion: 3, providers: [], models: [], virtualModels: [], global: {} })) })
    if (url.includes('/api/config')) return new Promise((resolve) => { releaseConfig = () => resolve(jsonRes(200, sampleConfig())) })
    return Promise.resolve(jsonRes(404, {}))
  })
  const booting = app.bootstrap(true)
  await new Promise((r) => setTimeout(r, 15))
  assert.ok(root.textContent.includes('正在读取控制面'), '首屏在 API 返回前必须显示 loading 骨架（' + root.textContent.slice(0, 80) + '）')
  releaseStatus()
  releaseConfig()
  await booting
  assert.ok(root.textContent.includes('一切模型，尽在掌控。'), '数据到达后应切换为真实视图')
})

test('clients：功能级 403 只做局部提示，页面正常渲染、会话与其它数据保留', async () => {
  resetAppState()
  setToken('token-keep')
  state.status = { configVersion: 2, defaults: {}, providers: [], models: [], virtualModels: [], codex: {}, global: {} }
  state.config = sampleConfig({ providers: {}, models: {}, virtualModels: [] })
  stubFetch((url) => {
    if (url.includes('/api/codex/policy')) return Promise.resolve(jsonRes(403, { ok: false, code: 'write_disabled', error: 'write disabled' }))
    return Promise.resolve(jsonRes(404, {}))
  })
  const root = document.getElementById('view-root')
  const clients = await import('../../../src/ui-next/js/views/clients.js')
  const rerender = () => { root.textContent = ''; clients.render(root, { rerender }) }
  clients.render(root, { rerender })
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(root.textContent.includes('客户端接入'), '页面必须正常渲染，不得白屏')
  assert.ok(root.textContent.includes('受控写入未启用'), '必须出现功能级 403 的局部提示（' + root.textContent.slice(0, 140) + '）')
  assert.equal(root.textContent.includes('控制面已锁定'), false, '功能级 403 不得锁屏')
  assert.equal(getToken(), 'token-keep', '功能级 403 不得清 token')
  assert.notEqual(state.status, null, '功能级 403 不得清空其它视图数据')
})

