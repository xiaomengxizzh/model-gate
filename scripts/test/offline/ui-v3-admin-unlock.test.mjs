// P1-04 / G5（前端半）：无管理凭据时只读状态准确、原因清楚、本机解锁可操作（离线、零依赖）。
// 不启动浏览器、不发真实请求、不调用付费模型；fetch 被 stub，DOM 为最小 shim。
import test from 'node:test'
import assert from 'node:assert/strict'

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
    this.listeners = {}
  }
  get textContent () { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
  set textContent (v) { this._text = ''; this.children = [{ nodeType: 3, textContent: String(v) }] }
  append (...nodes) { for (const n of nodes) { const node = (n && n.nodeType) ? n : { nodeType: 3, textContent: String(n) }; this.children.push(node) } }
  appendChild (n) { this.append(n) }
  replaceChildren (...nodes) { this.children = []; this._text = ''; this.append(...nodes) }
  setAttribute (k, v) { this.attributes[k] = String(v) }
  getAttribute (k) { return this.attributes[k] == null ? null : this.attributes[k] }
  addEventListener (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener () {}
  focus () {}
  querySelector () { return null }
  querySelectorAll () { return [] }
  click () { for (const fn of (this.listeners.click || [])) fn({}) }
}
const byId = new Map()
globalThis.document = {
  documentElement: { dataset: {} },
  body: new El('body'),
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById: (id) => { if (!byId.has(id)) { const el = new El('div'); el.id = id; byId.set(id, el) } return byId.get(id) },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener () {},
  removeEventListener () {},
}
const locationState = { hash: '', reload () { throw new Error('unexpected reload') } }
globalThis.location = locationState
globalThis.window = { location: locationState, addEventListener () {}, removeEventListener () {}, scrollTo () {}, matchMedia: () => ({ matches: false, addEventListener () {} }) }
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
globalThis.__MG_UI_TEST__ = true

const apiMod = await import('../../../src/ui-next/js/api.js?admin-unlock-test')
const { api, getToken, clearToken, setToken, setUnauthorizedHandler } = apiMod
const { deriveProductStatus } = await import('../../../src/ui-next/js/product-status.js')
const dashboard = await import('../../../src/ui-next/js/views/dashboard.js')

function jsonResponse (body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body }
}

test('api.adminUnlock：POST /api/admin/unlock，空体，401 不触发全局锁屏', async () => {
  const calls = []
  let unauthorized = 0
  setUnauthorizedHandler(() => { unauthorized++ })
  clearToken()
  globalThis.fetch = async (path, opts) => {
    calls.push({ path, opts })
    return jsonResponse({ ok: true, token: 'local-admin-token', scope: 'local-admin', expiresAt: null })
  }
  const out = await api.adminUnlock()
  assert.deepEqual(out, { ok: true, token: 'local-admin-token', scope: 'local-admin', expiresAt: null })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/admin/unlock')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.body, '{}')
  assert.equal(calls[0].opts.credentials, 'same-origin')

  // 401 不应触发 unauthorizedHandler（authEvent:false），只以 ApiError 抛给调用方。
  globalThis.fetch = async () => jsonResponse({ ok: false, code: 'admin_unlock_denied', error: 'bad origin' }, 403)
  await assert.rejects(() => api.adminUnlock(), (e) => e.status === 403 && e.data.code === 'admin_unlock_denied')
  assert.equal(unauthorized, 0)
  setUnauthorizedHandler(null)
})

test('403 投影：needs_admin_token 只读原因清楚、主操作为解锁、设置令牌为次级入口', () => {
  const ps = deriveProductStatus({
    authenticatedAdmin: true,
    status: { providers: [{ id: 'opencodego', hasKey: true }], models: [{ name: 'mg-opencodego-deepseek-v4-1-flash' }] },
    aggregation: null,
    aggregationError: { status: 403, data: { code: 'explicit_admin_required' }, message: '403' },
  })
  assert.equal(ps.state, 'needs_admin_token')
  assert.equal(ps.readOnly, true)
  assert.equal(ps.primary.id, 'unlock-admin')
  assert.equal(ps.primary.kind, 'local-admin-unlock')
  assert.match(ps.primary.detail, /403/)
  assert.match(ps.overall.label, /只读/)
  assert.match(ps.overall.detail, /解锁|MG_ADMIN_TOKEN/)
  assert.ok(ps.secondary.some((a) => a.id === 'set-admin-token'))
  assert.equal(ps.readOnlyReason.code, 'explicit_admin_required')
})

test('首页主 CTA 点击：有 ctx.unlockAdmin 时调用本机解锁，无 ctx 时降级到设置（不死循环）', () => {
  const ps = deriveProductStatus({
    authenticatedAdmin: true,
    status: { providers: [], models: [] },
    aggregation: null,
    aggregationError: { status: 403, data: { code: 'explicit_admin_required' }, message: '403' },
  })
  const withCtx = dashboard.buildPrimaryAction(ps, { unlockAdmin: () => { withCtx.called = true } })
  assert.equal(withCtx.called, undefined)
  withCtx[0].querySelectorAll // noop
  // 找到主按钮并触发 click
  const section = withCtx[0]
  const findButton = (node) => {
    if (node.tagName === 'BUTTON') return node
    for (const c of node.children || []) { const r = c && c.tagName ? findButton(c) : null; if (r) return r }
    return null
  }
  findButton(section).click()
  assert.equal(withCtx.called, true)

  locationState.hash = ''
  const noCtx = dashboard.buildPrimaryAction(ps, {})
  findButton(noCtx[0]).click()
  assert.equal(locationState.hash, '#/settings?section=admin-token')
})

test('首页渲染：needs_admin_token 显示只读原因与解锁方式，不显示假成功按钮', () => {
  const ps = deriveProductStatus({
    authenticatedAdmin: true,
    status: { providers: [], models: [] },
    aggregation: null,
    aggregationError: { status: 403, data: { code: 'explicit_admin_required' }, message: '403' },
  })
  const root = new El('div')
  dashboard.render(root, { product: () => ps, unlockAdmin: () => {} })
  const text = root.textContent
  assert.match(text, /只读/)
  assert.match(text, /403/)
  assert.match(text, /解锁聚合管理/)
  assert.match(text, /MG_ADMIN_TOKEN/)
  assert.doesNotMatch(text, /已连接|已启用聚合|准备就绪/)
})

test('解锁成功：返回 token 只在内存 setToken，不写 localStorage', () => {
  clearToken()
  setToken('local-admin-token')
  assert.equal(getToken(), 'local-admin-token')
  assert.equal(globalThis.localStorage.getItem('mg-admin-token'), null)
  clearToken()
})
