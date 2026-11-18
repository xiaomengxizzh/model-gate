// 用量页 / 设置页 / donutChart 的离线 UI 契约测试（零依赖 DOM shim，不发真实请求）。
import test from 'node:test'
import assert from 'node:assert/strict'

// ---------- 最小 DOM shim ----------
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
  set textContent (v) { this._text = ''; this.children = [{ nodeType: 3, textContent: String(v) }] }
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
  setAttribute (k, v) {
    this.attributes[k] = String(v)
    if (k === 'class') this.className = String(v)
    if (k === 'id') this.id = String(v)
  }
  getAttribute (k) { return this.attributes[k] == null ? null : this.attributes[k] }
  removeAttribute (k) { delete this.attributes[k] }
  addEventListener (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener () {}
  focus () {}
  select () {}
  querySelector () { return null }
  querySelectorAll () { return [] }
  get firstChild () { return this.children[0] || null }
  get firstElementChild () { return this.children.find((c) => c && c.nodeType === 1) || null }
}
const byId = new Map()
globalThis.document = {
  documentElement: { dataset: {} },
  body: new El('body'),
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById: (id) => {
    if (!byId.has(id)) { const el = new El('div'); el.id = id; byId.set(id, el) }
    return byId.get(id)
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener () {},
  removeEventListener () {},
}
globalThis.location = { hash: '#/overview', origin: 'http://127.0.0.1:8787', reload () { throw new Error('no reload') } }
globalThis.window = { location: globalThis.location, addEventListener () {}, removeEventListener () {}, scrollTo () {} }
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
globalThis.__MG_UI_TEST__ = true

const components = await import('../../../src/ui-next/js/components.js')
const dashboard = await import('../../../src/ui-next/js/views/dashboard.js')
const settings = await import('../../../src/ui-next/js/views/settings.js')
const store = await import('../../../src/ui-next/js/store.js')

function walk (node, out = []) {
  for (const child of node.children || []) if (child && child.nodeType === 1) { out.push(child); walk(child, out) }
  return out
}
function all (root) { return [root, ...walk(root)] }
function withClass (root, cls) { return all(root).filter((n) => String(n.className || '').split(/\s+/).includes(cls)) }
function fire (el, type = 'click') { for (const fn of (el.listeners[type] || [])) fn() }

// 真实接口形状的合成样本（无密钥、无 token 字面量）
function stats (mode) {
  const date = (i) => mode === 'hourly' ? String(i).padStart(2, '0') + ':00' : '2026-11-' + String(i + 1).padStart(2, '0')
  const count = mode === 'hourly' ? 24 : 7
  const rows = (scale) => Array.from({ length: count }, (_, i) => ({
    date: date(i), tokens: (i + 1) * scale, inTokens: (i + 1) * scale, outTokens: (i + 1) * scale,
    hit: i + 1, miss: 0, hitRate: 100,
  }))
  return { days: mode === 'hourly' ? 1 : 7, mode, models: { 'gpt-6-luna': rows(1000), 'deepseek-v4': rows(500) } }
}
const native = { enabled: true, byDay: [], byModel: [{ provider: 'official', model: 'gpt-6-luna', totalTokens: 3200 }] }
const status = {
  server: { host: '0.0.0.0', port: 8787 },
  global: { requests: 2846, errors: 11, todayTokens: 18000000 },
  providers: [{ id: 'official', st: { requests: 1700, state: 'ok' } }, { id: 'opencodego', st: { requests: 1146, state: 'ok' } }],
  models: [{ name: 'gpt-6-luna', requests: 1500, tokens: 12000000 }],
  dialogues: [
    { id: 'c1', named: '会话 A', lastAt: Date.now(), hitRate: 100 },
    { id: 'c2', named: '会话 B', lastAt: Date.now(), hitRate: 98 },
    { id: 'c3', named: '会话 C', lastAt: Date.now(), hitRate: 99 },
  ],
}
store.state.status = status
store.state.config = {
  configVersion: 3,
  defaults: { timeout: { overallMs: 120000 }, retry: { maxAttempts: 2 }, concurrency: { maxPerProvider: 32 } },
  providers: { official: {}, opencodego: {} },
  models: { 'gpt-6-luna': {}, 'deepseek-v4': {} },
}

test('donutChart：纯 SVG 环形图含扇区/图例/百分比，空数据出空态', () => {
  const el = components.donutChart([
    { label: 'ChatGPT 官方', value: 568, color: '#6d5efc' },
    { label: 'OpenCode Go', value: 386, color: '#3b82f6' },
    { label: '其他', value: 46, color: '#94a3b8' },
  ], { centerValue: '2,846', centerLabel: '次请求' })
  assert.equal(withClass(el, 'donut-chart').length, 1)
  assert.equal(withClass(el, 'donut-legend').length, 1)
  const circles = walk(el).filter((n) => n.tagName === 'CIRCLE')
  assert.equal(circles.length, 4, '底环 + 3 个真实扇区')
  assert.equal(circles[1].getAttribute('stroke'), '#6d5efc')
  assert.equal(circles[2].getAttribute('stroke'), '#3b82f6')
  assert.match(withClass(el, 'donut-legend-pct').map((n) => n.textContent).join(' '), /56\.8%.*38\.6%.*4\.6%/)
  assert.match(el.textContent, /2,846/)
  assert.equal(withClass(components.donutChart([]), 'empty').length, 1)
})

test('usageBuckets / usageDelta：真实桶聚合与诚实环比', () => {
  const hourly = dashboard.usageBuckets(stats('hourly'))
  assert.equal(hourly.length, 24)
  assert.equal(hourly[0].tokens, 1500)
  assert.equal(hourly[0].requests, 2)
  assert.match(hourly[0].date, /^00:00$/)
  const daily = dashboard.usageBuckets(stats('daily'), ['gpt-6-luna'])
  assert.equal(daily.length, 7)
  assert.equal(daily[0].tokens, 1000)
  assert.match(dashboard.usageDelta(120, 100), /↑ \+20\.0%/)
  assert.match(dashboard.usageDelta(80, 100), /↓ -20\.0%/)
  assert.equal(dashboard.usageDelta(10, 0), null)
  assert.equal(dashboard.usageDelta(NaN, 10), null)
})

test('用量页：四卡 + 三图 + 三个月切换改变 days 参数', () => {
  const ctx = { modelStats: () => stats('hourly'), nativeUsage: () => native, status: () => status }
  const root = new El('div')
  dashboard.render(root, ctx)
  assert.equal(withClass(root, 'usage-metric').length, 4)
  for (const label of ['请求数', '输入 Token', '输出 Token', '成功率']) {
    assert.match(root.textContent, new RegExp(label))
  }
  assert.equal(withClass(root, 'usage-trend-card').length, 1)
  assert.equal(withClass(root, 'usage-donut-card').length, 1)
  assert.equal(withClass(root, 'usage-recent-card').length, 1)
  assert.equal(withClass(root, 'usage-seg').length, 3)
  assert.equal(withClass(root, 'usage-select').length, 2)
  const purple = walk(root).filter((n) => n.tagName === 'PATH' && n.getAttribute('stroke') === '#6d5efc')
  assert.ok(purple.length >= 1, '请求趋势折线必须是紫色 #6d5efc')
  assert.equal(withClass(root, 'donut-chart').length, 1)
  assert.match(root.textContent, /查看全部/)
  const rows = withClass(root, 'data')[0] ? walk(withClass(root, 'data')[0]).filter((n) => n.tagName === 'TR') : []
  assert.ok(rows.length >= 4, '最近请求表含表头 + 3 行真实会话')

  const sevenDay = withClass(root, 'usage-seg').find((b) => b.textContent.includes('最近 7 天'))
  assert.ok(sevenDay)
  fire(sevenDay)
  assert.equal(dashboard.usageState().days, 7, '切换 7 天必须改变 days 参数')
  const dailyRoot = new El('div')
  dashboard.render(dailyRoot, { ...ctx, modelStats: () => stats('daily') })
  assert.match(dailyRoot.textContent, /11-0/, '日桶 X 轴应显示真实日期 MM-DD')
})

test('设置页：5 个可点 tab + 基础配置三栏只读字段，无令牌输入', () => {
  const ctx = { product: () => ({ aggregation: { mode: 'aggregated' } }) }
  const root = new El('div')
  settings.render(root, ctx)
  const tabs = withClass(root, 'tab')
  assert.equal(tabs.length, 5)
  assert.deepEqual(tabs.map((t) => t.textContent), ['⚙ 基础配置', '▤ 供应商 & 模型', '⇄ 路由策略', '▣ 客户端接入', '🛡 安全与运维'])
  assert.equal(withClass(root, 'settings-col-card').length, 3)
  for (const label of ['网关服务', '代理与模式', '其他', '服务状态', '监听地址', '开机自启', '请求日志', '默认模式', '默认 Provider', '默认模型', '请求超时', '重试次数', '并发上限', '启用健康检查']) {
    assert.match(root.textContent, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(root.textContent, /0\.0\.0\.0:8787/)
  const inputs = all(root).filter((n) => n.tagName === 'INPUT')
  assert.ok(inputs.length > 0)
  for (const input of inputs) assert.equal(input.disabled, true, '基础配置控件必须禁用写入（只读诚实）')
  assert.equal(all(root).some((n) => n.tagName === 'INPUT' && String(n.type).toLowerCase() === 'password'), false, '不得出现任何密钥/令牌输入框')

  for (const [i, id] of ['basic', 'providers', 'routing', 'clients', 'security'].entries()) {
    fire(tabs[i])
    const next = new El('div')
    settings.render(next, ctx)
    assert.equal(withClass(next, 'settings-panel')[0].id, 'settings-panel-' + id)
    assert.ok(withClass(next, 'settings-panel')[0].children.length > 0, id + ' tab 必须有内容')
  }
})

test('apikey 审计：新增前端源码无明文密钥/令牌字面量与 token 输入框', async () => {
  const { readFileSync } = await import('node:fs')
  const files = [
    'src/ui-next/js/components.js', 'src/ui-next/js/views/dashboard.js', 'src/ui-next/js/views/settings.js',
  ]
  for (const f of files) {
    const src = readFileSync(new URL('../../../' + f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /sk-[A-Za-z0-9]{16,}/, f)
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}/, f)
    assert.doesNotMatch(src, /type\s*[:=]\s*["']password["']/, f)
  }
})
