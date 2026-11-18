// UX-01 / A1：状态驱动首页、唯一主 CTA、分层导航与旧路由兼容（离线、零依赖）。
// 复用 ui-state.test.mjs 的最小 DOM shim；不启动浏览器、不发任何真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ---------- 最小 DOM shim（只实现本套件用到的 API） ----------
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
const locationState = { hash: '#/overview', reload () { throw new Error('unexpected location.reload in offline test') } }

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
  location: locationState,
  addEventListener () {},
  removeEventListener () {},
  matchMedia: () => ({ matches: false, addEventListener () {} }),
  scrollTo () {},
  confirm: () => true,
}
globalThis.location = locationState
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
globalThis.__MG_UI_TEST__ = true

const productStatus = await import('../../../src/ui-next/js/product-status.js')
const router = await import('../../../src/ui-next/js/router.js')
const dashboard = await import('../../../src/ui-next/js/views/dashboard.js')
const { deriveProductStatus } = productStatus
const { ROUTES, routeFromHash, routeMeta, routesByGroup, navigate } = router

function walk (node, out = []) {
  for (const child of node.children || []) {
    if (child && child.nodeType === 1) { out.push(child); walk(child, out) }
  }
  return out
}
function collect (nodes) {
  const out = []
  for (const node of nodes) {
    if (!node || node.nodeType !== 1) continue
    out.push(node)
    walk(node, out)
  }
  return out.map((n) => n) // no-op
}
function renderHome (product, ctx = {}) {
  const root = createEl('div')
  dashboard.renderHome(root, Object.assign({ product: () => product }, ctx))
  return root
}
function primaryButtons (nodes) {
  return collect(nodes).filter((n) => String(n.className || '').split(/\s+/).includes('btn-primary'))
}
function isPrimaryButton (node) {
  return node && node.nodeType === 1 && String(node.className || '').split(/\s+/).includes('btn-primary')
}
function classesOf (node) { return String(node && node.className || '').split(/\s+/).filter(Boolean) }

// ---------- 真实形状的假快照（全部经 deriveProductStatus 投影） ----------
const OFFICIAL_DETECTED = {
  credential: 'detected',
  reason: 'local_codex_chatgpt',
  authMode: 'chatgpt',
  level: 'detected',
  source: 'local_codex_auth_probe',
}
const BASE_STATUS = {
  configVersion: 3,
  official: OFFICIAL_DETECTED,
  providers: [],
  models: [],
  lastServing: null,
  global: { requests: 0, errors: 0 },
}
// 目标模型同时给旧/新公共 ID 与上游名，兼容 UX-00 的 ID 修正（Lead 更正 1）。
const GO_MODELS = {
  models: [{ publicId: 'opencodego/deepseek-v4.1-flash', upstreamId: 'deepseek-v4.1-flash' }],
}
function aggregation (over = {}) {
  return Object.assign({
    health: {
      mode: 'official',
      detect: {
        desktop: { found: true, version: '1.2.3', versionState: 'configured' },
        bundledCli: { found: false },
        cli: { found: false },
        restart: { needed: false },
      },
      backup: { available: true },
      activation: {},
    },
    providers: { providers: [{ id: 'opencodego', kind: 'go' }] },
    models: GO_MODELS,
    diagnostics: {},
  }, over)
}
function aggWithHealth (health, over = {}) {
  const base = aggregation(over)
  base.health = health
  return base
}
function statusWith (over = {}) {
  return Object.assign({}, BASE_STATUS, over)
}
function derive (input) {
  return deriveProductStatus(input)
}

const STATES = [
  {
    name: 'locked',
    input: { authenticatedAdmin: false, loading: false, status: null },
    state: 'locked',
    label: '重试读取状态',
  },
  {
    name: 'loading',
    input: { authenticatedAdmin: true, loading: true, status: null },
    state: 'loading',
    label: '正在读取状态…',
  },
  {
    name: 'read_only_unknown',
    input: {
      authenticatedAdmin: true,
      loading: false,
      status: statusWith({ official: { credential: 'missing', reason: 'auth_file_missing', level: 'detected' } }),
      aggregation: null,
      aggregationError: { status: 404, code: 'aggregation_route_unknown', message: 'not mounted' },
    },
    state: 'read_only_unknown',
    label: '查看高级诊断',
  },
  {
    name: 'cannot_detect_codex',
    input: {
      authenticatedAdmin: true,
      loading: false,
      status: statusWith(),
      aggregation: aggWithHealth({
        mode: 'official',
        detect: { desktop: { found: false }, bundledCli: { found: false }, cli: { found: false }, restart: { needed: null } },
      }),
    },
    state: 'cannot_detect_codex',
    label: '查看如何安装/定位 Codex',
  },
  {
    name: 'needs_go_key',
    input: { authenticatedAdmin: true, loading: false, status: statusWith(), aggregation: aggregation() },
    state: 'needs_go_key',
    label: '连接 OpenCode Go',
  },
  {
    name: 'ready_to_enable',
    input: {
      authenticatedAdmin: true,
      loading: false,
      status: statusWith({ providers: [{ id: 'opencodego', hasKey: true }] }),
      aggregation: aggWithHealth({
        mode: 'official',
        detect: { desktop: { found: true, version: '1.2.3' }, bundledCli: { found: false }, cli: { found: false }, restart: { needed: false } },
      }),
    },
    state: 'ready_to_enable',
    label: '启用聚合模式',
  },
  {
    name: 'needs_codex_restart',
    input: {
      authenticatedAdmin: true,
      loading: false,
      status: statusWith({ providers: [{ id: 'opencodego', hasKey: true }] }),
      aggregation: aggWithHealth({
        mode: 'aggregated',
        detect: { desktop: { found: true, version: '1.2.3' }, bundledCli: { found: false }, cli: { found: false }, restart: { needed: true } },
      }),
    },
    state: 'needs_codex_restart',
    label: '完成 Codex 重启',
  },
  {
    name: 'ready',
    input: {
      authenticatedAdmin: true,
      loading: false,
      status: statusWith({ providers: [{ id: 'opencodego', hasKey: true }] }),
      aggregation: aggWithHealth({
        mode: 'aggregated',
        detect: { desktop: { found: true, version: '1.2.3' }, bundledCli: { found: false }, cli: { found: false }, restart: { needed: false } },
      }),
    },
    state: 'ready',
    label: '在 Codex 中使用',
  },
  {
    name: 'conflict',
    input: { authenticatedAdmin: true, loading: false, phase: 'conflict', status: statusWith(), aggregation: aggregation() },
    state: 'conflict',
    label: '查看并处理配置冲突',
  },
  {
    name: 'recoverable_error',
    input: {
      authenticatedAdmin: true,
      loading: false,
      status: statusWith(),
      aggregation: aggregation(),
      aggregationError: { status: 500, code: 'aggregation_unavailable', message: 'boom' },
    },
    state: 'recoverable_error',
    label: '重试连接',
  },
]

test('首页状态机：10 个状态各自只渲染一个主 CTA，文案与投影一致', () => {
  for (const item of STATES) {
    const product = derive(item.input)
    assert.equal(product.state, item.state, item.name + ' 的状态必须命中契约 §2.1')
    assert.equal(product.primary.label, item.label, item.name + ' 的主 CTA 文案必须按契约')

    const built = dashboard.buildPrimaryAction(product)
    const builtPrimary = primaryButtons(built)
    assert.equal(builtPrimary.length, 1, item.name + ' 的 buildPrimaryAction 只能有一个主 CTA')
    assert.equal(builtPrimary[0].textContent, item.label)

    const root = renderHome(product)
    const renderedPrimary = walk(root, [root]).filter(isPrimaryButton)
    assert.equal(renderedPrimary.length, 1, item.name + ' 的首页只能渲染一个主 CTA（实际 ' + renderedPrimary.length + '）')
    assert.equal(renderedPrimary[0].textContent, item.label)
  }
})

test('404 / 未知：不出现"已连接/已启用/0 个模型"这类伪成功事实', () => {
  const readOnly = derive(STATES.find((s) => s.name === 'read_only_unknown').input)
  const readOnlyText = renderHome(readOnly).textContent
  const unknownAgg = derive({
    authenticatedAdmin: true,
    loading: false,
    status: statusWith(),
    aggregation: aggWithHealth({
      mode: 'unknown',
      detect: { desktop: { found: true }, bundledCli: { found: false }, cli: { found: false }, restart: { needed: null } },
    }),
  })
  const unknownText = renderHome(unknownAgg).textContent
  for (const text of [readOnlyText, unknownText]) {
    assert.equal(text.includes('已连接'), false, '不得出现"已连接"：' + text.slice(0, 160))
    assert.equal(text.includes('已启用'), false, '不得出现"已启用"：' + text.slice(0, 160))
    assert.equal(text.includes('0 个模型'), false, '不得把未知/404 读成"0 个模型"：' + text.slice(0, 160))
  }
  assert.equal(readOnlyText.includes('404'), true, '404 必须给出可理解的版本不兼容提示')
  assert.equal(readOnly.aggregation.supported, false)
})

test('证据等级：go.level=configured 不出现"已验证"，并显示 DeepSeek V4.1 Flash', () => {
  const product = derive(STATES.find((s) => s.name === 'ready_to_enable').input)
  assert.equal(product.go.level, 'configured')
  assert.equal(product.go.targetModelConfigured, true)
  const root = renderHome(product)
  const text = root.textContent
  assert.equal(text.includes('已验证'), false, 'configured 只能是"已配置"，不得显示"已验证"')
  const evidenceTags = walk(root, [root]).filter((n) => classesOf(n).includes('tag')).map((n) => n.textContent)
  assert.equal(evidenceTags.includes('已实测'), false, '没有 runtime-verified 证据时不得出现"已实测"证据标签')
  assert.equal(evidenceTags.includes('已配置'), true, 'configured 必须显示"已配置"证据标签')
  assert.equal(text.includes(dashboard.GO_MODEL_DISPLAY), true, '面向用户必须显示 DeepSeek V4.1 Flash')
  assert.equal(dashboard.GO_MODEL_DISPLAY, 'DeepSeek V4.1 Flash')
})

function elementsWithClass (node, cls) {
  return walk(node, [node]).filter((n) => classesOf(n).includes(cls))
}

test('三条状态行：ChatGPT 套餐 / OpenCode Go / Codex Desktop 都渲染，名称与模型名分行', () => {
  const product = derive(STATES.find((s) => s.name === 'ready').input)
  const rows = dashboard.buildStatusRows(product)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.getAttribute('data-status')), ['official', 'go', 'codex'])
  assert.match(rows[0].textContent, /ChatGPT 套餐/)
  assert.match(rows[1].textContent, /OpenCode Go/)
  assert.match(rows[1].textContent, /DeepSeek V4\.1 Flash/)
  assert.match(rows[2].textContent, /Codex Desktop/)
  assert.match(rows[0].textContent, /已检测到/, 'detected 的事实仍要出现在状态值里（只是不再重复出徽章）')

  // 缺陷 2：名称/模型名必须是独立元素，且模型名不能使用带 nowrap/ellipsis 的 secondary 类。
  const label = elementsWithClass(rows[1], 'status-row-label')[0]
  assert.ok(label, '每行必须有独立的名称元素')
  assert.equal(label.textContent, 'OpenCode Go', '名称必须独立成行，不能与模型名拼成一段')
  const modelNodes = elementsWithClass(rows[1], 'home-status-model')
  assert.equal(modelNodes.length, 1, '模型名必须单独一行')
  assert.equal(modelNodes[0].textContent, 'DeepSeek V4.1 Flash')
  assert.equal(classesOf(modelNodes[0]).includes('primary'), false, '模型名不得套用 .primary（nowrap/ellipsis）')
  assert.equal(classesOf(modelNodes[0]).includes('secondary'), false, '模型名不得套用 .secondary（nowrap/ellipsis）')
  assert.equal(classesOf(modelNodes[0]).includes('status-row-detail'), true, '模型名使用可换行的 muted 小字样式')
  assert.equal(elementsWithClass(rows[1], 'status-row-value')[0].textContent.includes('DeepSeek V4.1 Flash'), false, '模型名不得塞进状态值')

  // 证据徽章：configured 显示"已配置"；detected 不再重复出徽章。
  assert.deepEqual(elementsWithClass(rows[1], 'tag').map((n) => n.textContent), ['已配置'])
  assert.deepEqual(elementsWithClass(rows[0], 'tag').map((n) => n.textContent), [])

  const root = renderHome(product)
  const rendered = walk(root, [root]).filter((n) => ['official', 'go', 'codex'].includes(n.getAttribute('data-status')))
  assert.equal(rendered.length, 3, '首页必须渲染三条状态行')
})

test('缺陷修复 1：待登录/待连接行不得同时出现"已检测/已配置/已实测"徽章', () => {
  const product = derive({
    authenticatedAdmin: true,
    loading: false,
    status: statusWith({
      official: { credential: 'missing', reason: 'auth_file_missing', level: 'detected' },
      providers: [],
    }),
    aggregation: aggregation(),
  })
  assert.equal(product.state, 'needs_go_key')
  const rows = dashboard.buildStatusRows(product)
  const officialBadges = elementsWithClass(rows[0], 'tag').map((n) => n.textContent)
  const goBadges = elementsWithClass(rows[1], 'tag').map((n) => n.textContent)
  assert.match(rows[0].textContent, /待登录/)
  assert.match(rows[1].textContent, /待连接/)
  assert.deepEqual(officialBadges, [], '待登录行不得出现"已检测"徽章')
  assert.deepEqual(goBadges, [], '待连接行不得出现"已检测"徽章')
  for (const text of [...officialBadges, ...goBadges]) {
    assert.equal(['已检测', '已配置', '已实测'].includes(text), false, '待处理状态行不得并排成功徽章：' + text)
  }

  // unknown 只能显示"未知"，不得显示成任何成功词。
  const unknown = derive({
    authenticatedAdmin: true,
    loading: false,
    status: statusWith(),
    aggregation: null,
    aggregationError: { status: 404, code: 'aggregation_route_unknown', message: 'not mounted' },
  })
  const unknownRows = dashboard.buildStatusRows(unknown)
  const unknownBadges = unknownRows.flatMap((row) => elementsWithClass(row, 'tag').map((n) => n.textContent))
  for (const text of unknownBadges) {
    assert.equal(['已检测', '已配置', '已实测', '已验证'].includes(text), false, 'unknown 不得显示成成功词：' + text)
  }
  assert.equal(unknownBadges.includes('未知'), true, 'unknown 必须显示"未知"')
})

test('缺陷修复 3：主 CTA 位于总体状态之后、连接状态/聚合之前（360×800 首屏）', () => {
  const product = derive(STATES.find((s) => s.name === 'needs_go_key').input)
  const root = renderHome(product)
  const nodes = walk(root, [root])
  const ctaIndex = nodes.findIndex((n) => classesOf(n).includes('btn-primary'))
  const firstStatusIndex = nodes.findIndex((n) => n.getAttribute('data-status') === 'official')
  const aggregationIndex = nodes.findIndex((n) => n.getAttribute('data-status') === 'aggregation')
  assert.ok(ctaIndex > 0, '首页必须有主 CTA')
  assert.ok(firstStatusIndex > 0, '首页必须有连接状态行')
  assert.ok(ctaIndex < firstStatusIndex, '主 CTA 必须排在连接状态之前，避免窄屏首屏看不到')
  assert.ok(firstStatusIndex < aggregationIndex, '连接状态在聚合摘要之前')
  assert.ok(root.textContent.indexOf(product.primary.label) < root.textContent.indexOf('ChatGPT 套餐'), 'DOM 文本顺序同样是 CTA 先于状态行')
})

test('router：旧 7 个 id 全部保留，connections 为新增 primary，查询串不参与匹配', () => {
  const legacy = ['overview', 'providers', 'models', 'clients', 'aggregation', 'observability', 'settings']
  for (const id of legacy) {
    assert.ok(routeMeta(id), '旧路由必须继续存在：' + id)
    assert.equal(routeFromHash('#/' + id), id)
  }
  assert.ok(routeMeta('connections'), '必须新增 connections 路由')
  assert.equal(routeMeta('connections').group, 'primary')
  assert.equal(routeMeta('connections').navLabel, '连接')
  assert.equal(ROUTES.length, 8)

  locationState.hash = '#/connections?step=key'
  assert.equal(routeFromHash(), 'connections', '查询串不得参与路由匹配')
  assert.equal(routeFromHash('#/providers?step=model&x=1'), 'providers')
  assert.equal(routeFromHash('#/unknown-route'), 'overview', '未知 hash 回落首页')
  assert.equal(routeFromHash(''), 'overview')
  assert.equal(routeFromHash('#/overview/'), 'overview')

  locationState.hash = '#/overview'
  assert.equal(navigate('connections', { step: 'key' }), '#/connections?step=key')
  assert.equal(locationState.hash, '#/connections?step=key')
  assert.equal(navigate('nope'), null, '未知 id 不得改写 location')
  assert.equal(locationState.hash, '#/connections?step=key')
})

test('router：routesByGroup 按 order 排序，主分区 3 项 + 高级 5 项', () => {
  const groups = routesByGroup()
  assert.deepEqual(groups.primary.map((r) => r.id), ['overview', 'connections', 'settings'])
  assert.deepEqual(groups.advanced.map((r) => r.id), ['providers', 'models', 'clients', 'aggregation', 'observability'])
  for (const route of [...groups.primary, ...groups.advanced]) {
    assert.ok(['primary', 'advanced'].includes(route.group))
    assert.equal(typeof route.navLabel, 'string')
    assert.equal(typeof route.title, 'string')
    assert.equal(typeof route.icon, 'string')
    assert.ok(Number.isFinite(route.order))
  }
  const orders = [...groups.primary, ...groups.advanced].map((r) => r.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), '分组结果必须按 order 排序')
  // 返回副本：改调用方结果不得污染唯一路由表
  groups.primary[0].navLabel = 'MUTATED'
  assert.equal(routeMeta('overview').navLabel, '用量')
})

test('router：深链进入高级路由时展开高级分组，首页不自动展开', () => {
  const details = { open: false }
  const handlers = {}
  const originalQuery = globalThis.document.querySelector
  const originalAdd = globalThis.window.addEventListener
  globalThis.document.querySelector = (sel) => (sel === '#nav-advanced' ? details : null)
  globalThis.window.addEventListener = (type, fn) => { handlers[type] = fn }
  try {
    locationState.hash = '#/overview'
    let seen = ''
    router.startRouter((route) => { seen = route })
    assert.equal(seen, 'overview')
    assert.equal(details.open, false, '默认/首页不得自动展开高级分组')
    locationState.hash = '#/aggregation'
    handlers.hashchange()
    assert.equal(seen, 'aggregation')
    assert.equal(details.open, true, '深链进入高级路由必须展开分组，否则当前项不可见')
    locationState.hash = '#/overview'
    handlers.hashchange()
    assert.equal(seen, 'overview')
    assert.equal(details.open, true, '不自动收起用户或深链已展开的分组')
  } finally {
    globalThis.document.querySelector = originalQuery
    globalThis.window.addEventListener = originalAdd
    locationState.hash = '#/overview'
  }
})

const html = readFileSync(fileURLToPath(new URL('../../../src/ui-next/index.html', import.meta.url)), 'utf8')

test('index.html：分层导航、关键 id、无内联脚本/外部 URL/CSP 风险', () => {
  // 主导航：主分区 3 项 + 默认收起的高级分组 5 项
  const detailsTag = (html.match(/<details\b[^>]*>/) || [''])[0]
  assert.match(detailsTag, /nav-advanced/, '高级功能必须用 details 分组')
  assert.doesNotMatch(detailsTag, /\bopen\b/, '高级分组必须默认收起')
  assert.match(html, /<summary[^>]*>[\s\S]*?高级功能[\s\S]*?<\/summary>/, '高级分组必须有可键盘展开的 summary')

  const detailsStart = html.indexOf('<details')
  const detailsEnd = html.indexOf('</details>')
  assert.ok(detailsStart > 0 && detailsEnd > detailsStart)
  const advancedHtml = html.slice(detailsStart, detailsEnd)
  const beforeDetails = html.slice(0, detailsStart)
  const routesIn = (source) => [...source.matchAll(/data-route="([^"]+)"/g)].map((m) => m[1])
  const primaryRoutes = routesIn(beforeDetails)
  const advancedRoutes = routesIn(advancedHtml)
  assert.deepEqual(primaryRoutes, ['overview', 'connections', 'settings'], '主分区必须是 3 项')
  assert.deepEqual(advancedRoutes, ['providers', 'models', 'clients', 'aggregation', 'observability'], '高级分组必须是 5 项')
  assert.deepEqual([...primaryRoutes, ...advancedRoutes].sort(), ROUTES.map((r) => r.id).sort(), 'data-route 必须覆盖唯一路由表且不重复')
  for (const route of [...primaryRoutes, ...advancedRoutes]) {
    const id = routeMeta(route)
    assert.ok(id, '未知 data-route：' + route)
    assert.match(html, new RegExp('data-route="' + route + '"[^>]*>'), '导航项必须保留 data-route')
  }
  assert.match(html, /class="nav-link"/, '导航按钮必须保留 class="nav-link"（app.js 依赖）')
  assert.match(html, /data-route="overview" aria-current="page"/, '默认首页导航项必须带 aria-current="page"（A5 静态验收）')
  assert.equal((html.match(/class="nav-link"/g) || []).length, ROUTES.length)

  // app.js / app shell 依赖的 id 必须齐全
  const ids = ['view-root', 'current-view', 'conn-chip', 'conn-text', 'side-pulse', 'side-status', 'side-detail', 'side-version',
    'foot-time', 'foot-note', 'refresh', 'theme-toggle',
    'toasts', 'dialog-root', 'app-shell']
  for (const id of ids) assert.match(html, new RegExp('id="' + id + '"'), '缺少关键 id：' + id)
  assert.match(html, /class="top-actions"/)
  assert.match(html, /<main\b[^>]*id="view-root"[^>]*tabindex="-1"[^>]*aria-live="polite"/)
  assert.match(html, /<a class="skip-link" href="#view-root">/)

  // 静态安全底线：无内联脚本、无外部 URL、无浏览器持久化、默认文案不含内部字段名
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/, '不得有内联 script')
  assert.doesNotMatch(html, /https?:\/\/[^"'\s>]+/i, '不得有外部 URL')
  assert.doesNotMatch(html, /localStorage\.(setItem|getItem)|sessionStorage/, '不得使用 localStorage/sessionStorage')
  assert.doesNotMatch(html, /providerId|configVersion|model_catalog_json|TOML|SSE/, '默认可见文案不得出现内部字段名')
})
