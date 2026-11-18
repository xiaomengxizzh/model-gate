// 管理令牌删除后的前端回归（2026-11-18 所有者授权安全降级）。
// 不启动浏览器、不发真实请求；fetch 被 stub，DOM 为最小 shim。
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

const apiMod = await import('../../../src/ui-next/js/api.js?no-admin-token-test')
const { api } = apiMod
const { deriveProductStatus } = await import('../../../src/ui-next/js/product-status.js')

test('前端 API 客户端不再导出任何令牌函数', () => {
  for (const name of ['setToken', 'getToken', 'clearToken', 'hasToken', 'setAdminToken', 'adminUnlock']) {
    assert.equal(name in apiMod, false, name + ' 必须已从前端移除')
  }
  assert.equal('auth' in api, true, '/api/auth 兼容入口保留')
})

test('管理请求不携带 Authorization；/api/auth 返回 needAuth:false', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} })
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ needAuth: false, startedAt: 1 }) }
  }
  try {
    const auth = await api.auth()
    assert.equal(auth.needAuth, false)
    await api.aggregationModes()
    assert.equal(calls.every((c) => !c.headers.authorization), true, '请求不得带令牌头')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('来源被拒时 403 投影为 needs_admin_token 兼容状态，但不再有解锁/设置令牌 CTA', () => {
  const ps = deriveProductStatus({
    authenticatedAdmin: true,
    status: { providers: [], models: [], official: {}, go: {}, codex: {} },
    aggregation: null,
    aggregationError: { status: 403, data: { code: 'remote_forbidden' }, message: '403' },
  })
  assert.equal(ps.state, 'needs_admin_token')
  assert.equal(ps.primary.id, 'recheck-admin')
  assert.equal(ps.primary.kind, 'reload')
  assert.equal(ps.secondary.some((a) => a.id === 'set-admin-token'), false)
})

test('首页 CTA 不再有 unlock / local-admin-unlock 语义', () => {
  const locked = deriveProductStatus({ authenticatedAdmin: false, loading: false, status: null })
  assert.equal(locked.primary.kind, 'reload')
  assert.equal(/解锁|令牌/.test(locked.primary.label), false)
  const denied = deriveProductStatus({
    authenticatedAdmin: true,
    status: { providers: [], models: [], official: {}, go: {}, codex: {} },
    aggregation: null,
    aggregationError: { status: 403, data: { code: 'remote_forbidden' }, message: '403' },
  })
  assert.equal(/解锁|令牌/.test(denied.primary.label), false)
})
