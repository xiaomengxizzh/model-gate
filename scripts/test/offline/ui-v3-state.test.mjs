// UX-04 / A3：全局状态同步与请求可靠性（契约 docs/contracts/ui-v3-product-status.md §5）。
// 用零依赖 DOM shim + fetch stub 断言真实行为：fetch 计数、signal.aborted、state 内容，
// 而不是只断言“函数存在”。真实浏览器/上游验证不在本套件内。
import test from 'node:test'
import assert from 'node:assert/strict'

// ---------- 最小 DOM shim（与 ui-state.test.mjs 同构，补 visibilityState） ----------
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
  visibilityState: 'visible',
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

const store = await import('../../../src/ui-next/js/store.js')
const {
  state, resetData, refreshProduct, productStatus, aggregationState, shouldRefresh,
  invalidateProductStatus, setProductPhase, onProductStatus, FRESHNESS_BUDGET, phaseOf,
} = store
const { api, ApiError, setToken, getToken, clearToken } = await import('../../../src/ui-next/js/api.js')
const { ensureDraft, clearDraft, dirtyDraft } = await import('../../../src/ui-next/js/config-draft.js')
const app = await import('../../../src/ui-next/app.js')

// ---------- fetch stub ----------
const realFetch = globalThis.fetch
let fetchLog = []
function abortError () { const e = new Error('aborted'); e.name = 'AbortError'; return e }
function jsonRes (status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}
function stubFetch (handler) {
  fetchLog = []
  globalThis.fetch = (url, opts = {}) => {
    const entry = { url: String(url), opts, signal: opts.signal, method: opts.method || 'GET' }
    fetchLog.push(entry)
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, value) => { if (!settled) { settled = true; fn(value) } }
      const signal = opts.signal
      if (signal && signal.aborted) return done(reject, abortError())
      if (signal) signal.addEventListener('abort', () => done(reject, abortError()), { once: true })
      Promise.resolve().then(() => handler(entry.url, opts)).then(
        (res) => done(resolve, res),
        (err) => done(reject, err),
      )
    })
  }
}
function statusCount () { return fetchLog.filter((x) => x.url.includes('/api/status')).length }
function statusBody (marker = 'ok', extra = {}) {
  return Object.assign({
    configVersion: 3,
    marker,
    providers: [{ id: 'opencodego', hasKey: true, st: { state: 'ok', requests: 1, errors: 0 } }],
    models: [],
    virtualModels: [],
    global: { requests: 1, errors: 0 },
    official: { credential: 'detected', reason: 'local_codex_chatgpt' },
  }, extra)
}
function aggregationResponse (url) {
  if (url.includes('/api/aggregation/health')) return jsonRes(200, { mode: 'official', detect: { desktop: { found: true, version: '1.0.0' }, restart: { needed: false } } })
  if (url.includes('/api/aggregation/providers')) return jsonRes(200, { providers: [] })
  if (url.includes('/api/aggregation/models')) return jsonRes(200, { models: [] })
  if (url.includes('/api/aggregation/diagnostics')) return jsonRes(200, { discovery: { state: 'complete', discovered: 0 } })
  return jsonRes(404, { code: 'not_mounted', error: 'not mounted' })
}
function standardRoutes (statusImpl) {
  return (url) => (url.includes('/api/status') ? statusImpl(url) : aggregationResponse(url))
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
function resetEnv () {
  globalThis.fetch = realFetch
  clearToken()
  clearDraft()
  resetData()
  state.auth = { needAuth: false, startedAt: 1 }
  state.view = 'overview'
  state.phase = { auth: 'ready', status: 'idle', config: 'idle', logs: 'idle' }
  const dlg = document.getElementById('dialog-root')
  dlg.hidden = true; dlg.children = []; dlg._text = ''
  const root = document.getElementById('view-root')
  root.children = []; root._text = ''
  fetchLog = []
}

// ① epoch：先发慢返、后发先返时，最终状态必须是后者；被超越的请求真的 abort。
test('① 旧响应不覆盖新快照，被超越请求被 AbortController 取消', async () => {
  resetEnv()
  let statusCalls = 0
  let releaseOld
  stubFetch(standardRoutes(() => {
    statusCalls += 1
    if (statusCalls === 1) return new Promise((resolve) => { releaseOld = () => resolve(jsonRes(200, statusBody('old'))) })
    return jsonRes(200, statusBody('new', { configVersion: 4 }))
  }))
  const first = refreshProduct({ force: true, reason: 'first' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(statusCount(), 1)
  const second = refreshProduct({ force: true, reason: 'second' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(state.status && state.status.marker, 'new', '后发请求的快照应立即生效')
  assert.equal(state.status.configVersion, 4)
  assert.equal(fetchLog[0].signal.aborted, true, '被超越的 status 请求必须被 abort')
  releaseOld()
  await Promise.all([first, second])
  assert.equal(state.status.marker, 'new', '迟到的旧响应不得覆盖新快照')
  assert.ok(state.product && typeof state.product.state === 'string', '应产出产品状态投影')
})

// ② 并发合并：未 force 的并发刷新共享同一次在途请求。
test('② 并发 refreshProduct 合并为一次在途请求（fetch 计数）', async () => {
  resetEnv()
  let release
  let statusCalls = 0
  stubFetch(standardRoutes(() => {
    statusCalls += 1
    return new Promise((resolve) => { release = () => resolve(jsonRes(200, statusBody('merged'))) })
  }))
  const p1 = refreshProduct({ force: true })
  const p2 = refreshProduct({ reason: 'concurrent' })
  assert.equal(p1, p2, '并发调用必须复用同一个 Promise')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(statusCalls, 1, '并发刷新只应产生一次 status 请求')
  assert.equal(statusCount(), 1)
  release()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1, r2)
  assert.equal(state.status.marker, 'merged')
})

// ③外部取消不是 401：ApiError.aborted=true，不触发 unauthorized、不清 token。
test('③ 外部 signal 取消标记 aborted，且不当作 401', async () => {
  resetEnv()
  setToken('keep-me')
  let unauthorized = 0
  const off = store.on('unauthorized', () => { unauthorized += 1 })
  stubFetch(() => new Promise(() => {}))
  const controller = new AbortController()
  const pending = api.status({ signal: controller.signal })
  await new Promise((r) => setTimeout(r, 10))
  const internalSignal = fetchLog[0].signal
  controller.abort()
  await assert.rejects(pending, (e) => e instanceof ApiError && e.aborted === true && e.status === 0 && e.status !== 401)
  assert.equal(internalSignal.aborted, true)
  assert.equal(unauthorized, 0, '取消不得触发 unauthorized')
  assert.equal(getToken(), 'keep-me', '取消不得清 token')
  off()
})

// ④ 401：清 token + 清 state.product + emit unauthorized。
test('④ 401 清空 token 与产品快照并 emit unauthorized', async () => {
  resetEnv()
  setToken('session-token')
  stubFetch(standardRoutes(() => jsonRes(200, statusBody('before-401'))))
  await refreshProduct({ force: true })
  assert.ok(state.product, '先建立可用的共享快照')
  let unauthorized = 0
  const off = store.on('unauthorized', () => { unauthorized += 1 })
  stubFetch(() => jsonRes(401, { error: 'unauthorized' }))
  await refreshProduct({ force: true })
  assert.equal(getToken(), '', '401 必须清除管理令牌')
  assert.equal(state.product, null, '401 必须清空 state.product')
  assert.equal(state.status, null, '401 必须清空状态快照')
  assert.equal(state.aggregation, null)
  assert.ok(unauthorized >= 1, '401 必须 emit unauthorized')
  off()
})

// ⑤ 403：只记局部错误，不清 token、不清其它快照。
test('⑤ 403 不清 token，只记录聚合局部错误', async () => {
  resetEnv()
  setToken('keep-token')
  let unauthorized = 0
  const off = store.on('unauthorized', () => { unauthorized += 1 })
  stubFetch((url) => {
    if (url.includes('/api/status')) return jsonRes(200, statusBody('ok'))
    if (url.includes('/api/aggregation/health')) return jsonRes(403, { error: 'write disabled', code: 'write_disabled' })
    return aggregationResponse(url)
  })
  await refreshProduct({ force: true })
  assert.equal(getToken(), 'keep-token', '功能级 403 不得清 token')
  assert.notEqual(state.status, null)
  assert.ok(state.product, '产品投影仍应可用')
  assert.equal(state.aggregation.error && state.aggregation.error.status, 403)
  assert.equal(state.aggregation.unsupported, false)
  assert.equal(state.product.error && state.product.error.kind, 'denied')
  assert.equal(unauthorized, 0, '403 不得触发 unauthorized')
  off()
})

// ⑥ freshness：预算内不 fetch、超预算/force 才刷新；不可见路由不刷新。
test('⑥ freshness 预算内不产生新 fetch，force 才刷新', async () => {
  resetEnv()
  stubFetch(standardRoutes(() => jsonRes(200, statusBody('fresh'))))
  await refreshProduct({ force: true })
  assert.equal(statusCount(), 1)
  assert.equal(shouldRefresh('product'), false, '刚刷新后预算内不应自动刷新')
  const loadedAt = state.productLoadedAt
  assert.equal(shouldRefresh('product', loadedAt + FRESHNESS_BUDGET.product + 1), true, '超过预算必须刷新')
  assert.equal(shouldRefresh('product', loadedAt + 1000), false, '预算内不刷新')
  await refreshProduct()
  assert.equal(statusCount(), 1, '预算内非 force 刷新不得发请求')
  await refreshProduct({ force: true })
  assert.equal(statusCount(), 2, 'force 必须真正刷新')
  state.view = 'providers'
  invalidateProductStatus('test')
  assert.equal(shouldRefresh('product'), false, '不可见路由不得自动刷新')
  state.view = 'overview'
  assert.equal(shouldRefresh('product'), true, 'invalidate 后可见路由需要刷新')
  assert.equal(productStatus(), productStatus(), '同一份快照不重复派生')
})

// ⑦ 部分失败：一个 404 不得让整体 ready；其余结果必须保留。
test('⑦ 聚合四接口部分失败：404 保留其它结果且投影 error.kind=unsupported', async () => {
  resetEnv()
  stubFetch((url) => {
    if (url.includes('/api/status')) return jsonRes(200, statusBody('partial'))
    if (url.includes('/api/aggregation/health')) return jsonRes(404, { code: 'not_mounted', error: 'not mounted' })
    return aggregationResponse(url)
  })
  const returned = await refreshProduct({ force: true })
  assert.equal(state.aggregation.health, null, '失败的 health 保持 null')
  assert.notEqual(state.aggregation.providers, null, '其它成功结果必须保留')
  assert.notEqual(state.aggregation.models, null, '其它成功结果必须保留')
  assert.notEqual(state.aggregation.diagnostics, null, '其它成功结果必须保留')
  assert.equal(state.aggregation.error && state.aggregation.error.status, 404)
  assert.equal(state.aggregation.unsupported, true)
  const product = productStatus()
  assert.equal(product.error && product.error.kind, 'unsupported', '投影错误类型必须为 unsupported')
  assert.notEqual(product.state, 'ready', '部分失败不得整体 ready')
  assert.equal(product.aggregation.supported, false)
  assert.equal(returned, product)
})

// ⑧ 编辑态：弹窗/草稿打开时轮询刷新数据但不重建视图。
test('⑧ 弹窗/草稿打开时不重建视图（轮询仍读取真实状态）', async () => {
  resetEnv()
  stubFetch(standardRoutes(() => jsonRes(200, statusBody('poll'))))
  await refreshProduct({ force: true })
  state.view = 'overview'
  app.renderRoute('overview')
  const root = document.getElementById('view-root')
  const before = root.firstElementChild
  assert.ok(before, '视图应已渲染')
  const dlg = document.getElementById('dialog-root')
  dlg.hidden = false
  dlg.append(createEl('div'))
  const base1 = statusCount()
  await app.pollRefresh({ force: true })
  assert.ok(statusCount() > base1, '轮询必须读取真实状态')
  assert.equal(root.firstElementChild, before, '弹窗打开时不得重建视图')
  assert.equal(dlg.hidden, false, '弹窗不得被关闭')

  dlg.hidden = true; dlg.children = []; dlg._text = ''
  const draft = ensureDraft(sampleConfig())
  draft.data.defaults.proxyMode = 'auto'
  assert.equal(dirtyDraft(), true, '草稿应处于未保存状态')
  const base2 = statusCount()
  await app.pollRefresh({ force: true })
  assert.ok(statusCount() > base2, '草稿存在时轮询仍读取真实状态')
  assert.equal(root.firstElementChild, before, '未保存草稿存在时不得重建视图')

  clearDraft()
  await app.pollRefresh({ force: true })
  assert.notEqual(root.firstElementChild, before, '无编辑态时应重建视图')
})

// 契约补充：订阅通知与阶段设置都只改投影，不产生请求。
test('onProductStatus 新快照/invalidate 通知可取消；setProductPhase 只改投影', async () => {
  resetEnv()
  stubFetch(standardRoutes(() => jsonRes(200, statusBody('sub'))))
  let calls = 0
  const off = onProductStatus(() => { calls += 1 })
  await refreshProduct({ force: true })
  const afterSnapshot = calls
  assert.ok(afterSnapshot >= 1, '新快照必须通知订阅者')
  invalidateProductStatus('manual')
  assert.equal(calls, afterSnapshot + 1, 'invalidate 必须通知订阅者')
  off()
  invalidateProductStatus('after-off')
  assert.equal(calls, afterSnapshot + 1, '取消订阅后不再通知')

  const requestsBefore = fetchLog.length
  setProductPhase('conflict')
  assert.equal(productStatus().state, 'conflict', 'conflict 阶段必须进入投影')
  setProductPhase(null)
  assert.notEqual(productStatus().state, 'conflict')
  assert.equal(fetchLog.length, requestsBefore, '设置阶段不得产生请求')
  assert.equal(aggregationState().freshness.budgetMs, FRESHNESS_BUDGET.aggregation)
  assert.equal(phaseOf('status'), 'ready')
})

// 契约 §8：409 冲突进入 conflict 投影，不覆盖、不伪造 ready。
test('⑨ 409 冲突：投影为 conflict，不进入 ready', async () => {
  resetEnv()
  setToken('keep-token')
  stubFetch((url) => {
    if (url.includes('/api/status')) return jsonRes(200, statusBody('conflict'))
    if (url.includes('/api/aggregation/health')) return jsonRes(409, { error: 'conflict', code: 'version_conflict', currentVersion: 9 })
    return aggregationResponse(url)
  })
  await refreshProduct({ force: true })
  assert.equal(state.aggregation.error && state.aggregation.error.status, 409)
  const product = productStatus()
  assert.equal(product.error && product.error.kind, 'conflict')
  assert.equal(product.state, 'conflict', '409 必须是 conflict，而不是 ready/recoverable')
  assert.equal(getToken(), 'keep-token', '409 不得清 token')
})

// 契约 §8：断网/超时不保留旧成功状态，投影进入 recoverable_error。
test('⑩ 断网：清掉旧成功投影并进入 recoverable_error', async () => {
  resetEnv()
  stubFetch(standardRoutes(() => jsonRes(200, statusBody('was-good'))))
  await refreshProduct({ force: true })
  assert.notEqual(productStatus().state, 'recoverable_error', '先有真实可用快照')
  const networkError = () => { throw new Error('fetch failed') }
  stubFetch((url) => {
    if (url.includes('/api/status')) return networkError()
    return networkError()
  })
  await refreshProduct({ force: true })
  assert.equal(state.status, null, '断网不得保留旧 status 快照')
  const product = productStatus()
  assert.equal(product.state, 'recoverable_error', '断网必须进入 recoverable_error')
  assert.ok(product.error && product.error.kind === 'error')
  assert.equal(state.product, product)
})
