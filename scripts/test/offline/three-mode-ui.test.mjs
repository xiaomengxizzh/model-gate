// P3 三模式 Web 控制台 UI 离线契约测试（直连 official / 路由 route / 聚合 aggregated）。
// 全部为合成占位串；不含任何真实 apikey / token / 凭据形态字符串。
// 本套件由集成阶段统一登记到 scripts/test/run.mjs（本轮不修改 run.mjs）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const AGG_VIEW = join(ROOT, 'src/ui-next/js/views/aggregation.js')
const CONNECTIONS_VIEW = join(ROOT, 'src/ui-next/js/views/connections.js')
const PRODUCT_STATUS = join(ROOT, 'src/ui-next/js/product-status.js')
const DASHBOARD = join(ROOT, 'src/ui-next/js/views/dashboard.js')

const loadAgg = () => import(new URL('../../../src/ui-next/js/views/aggregation.js', import.meta.url))
const loadStatus = () => import(new URL('../../../src/ui-next/js/product-status.js', import.meta.url))

test('modeLabel：三模式 + 未知 + drifted 文案，unknown 绝不显示成直连', async () => {
  const agg = await loadAgg()
  assert.match(agg.modeLabel('official').label, /官方直连（不经 ModelGate）/)
  assert.match(agg.modeLabel('route').label, /路由模式（纯 DeepSeek，无 GPT）/)
  assert.match(agg.modeLabel('aggregated').label, /聚合模式（GPT 父 \+ DeepSeek 子）/)
  const unknown = agg.modeLabel('unknown')
  assert.equal(unknown.label, '状态未知')
  assert.equal(unknown.kind, 'warn')
  assert.match(agg.modeLabel('something-else').label, /状态未知/)
  assert.doesNotMatch(agg.modeLabel('unknown').label, /直连/)

  const drifted = agg.modeLabel('aggregated', true)
  assert.equal(drifted.drifted, true)
  assert.equal(drifted.kind, 'warn')
  assert.match(drifted.label, /配置漂移/)
  assert.match(drifted.label, /需要重新对齐/)
  // unknown 即便带 drifted 也不伪装成直连或已生效
  assert.match(agg.modeLabel('unknown', true).label, /状态未知/)
})

test('父模型选项：来源 selectableParents，只有 luna 标 PASS_REAL，其余 UNVERIFIED', async () => {
  const agg = await loadAgg()
  const modes = {
    current: 'aggregated',
    modes: [
      { id: 'official', label: '官方直连' },
      { id: 'aggregated', label: '聚合', selectableParents: ['gpt-6-luna', 'gpt-5.2', { id: 'gpt-6-luna' }] },
    ],
  }
  const opts = agg.selectableParentModels(modes)
  const ids = opts.map((o) => o.id)
  assert.deepEqual(ids, ['gpt-6-luna', 'gpt-5.2'])
  const luna = opts.find((o) => o.id === 'gpt-6-luna')
  const other = opts.find((o) => o.id === 'gpt-5.2')
  assert.equal(luna.verified, true)
  assert.match(luna.label, /已签收\/PASS_REAL/)
  assert.equal(other.verified, false)
  assert.match(other.label, /未验证（UNVERIFIED）/)
  // 不得让非 luna 选项暗示同等可信
  assert.doesNotMatch(other.label, /PASS_REAL/)
  // 默认兜底项仍是 luna
  assert.equal(agg.selectableParentModels({ modes: [] })[0].id, 'gpt-6-luna')
  assert.equal(agg.DEFAULT_PARENT_MODEL, 'gpt-6-luna')
})

test('buildSwitchRequest / buildRollbackRequest：请求体字段符合冻结契约', async () => {
  const agg = await loadAgg()
  const preview = { consentToken: 'SYNTHETIC_CONSENT_TOKEN', expectedSha: 'a'.repeat(64) }
  const sw = agg.buildSwitchRequest(preview, true, 'aggregated', 'gpt-6-luna')
  assert.equal(sw.mode, 'aggregated')
  assert.equal(sw.parentModel, 'gpt-6-luna')
  assert.equal(sw.consentToken, 'SYNTHETIC_CONSENT_TOKEN')
  assert.equal(sw.expectedSha, 'a'.repeat(64))
  const swRoute = agg.buildSwitchRequest(preview, true, 'route', null)
  assert.equal(swRoute.mode, 'route')
  assert.equal('parentModel' in swRoute, false, '路由固定 deepseek 父，不带 parentModel')
  const swPreview = agg.buildSwitchRequest(preview, false, 'official', null)
  assert.equal(swPreview.consentToken, '')
  assert.equal(swPreview.expectedSha, 'a'.repeat(64))

  const rb = agg.buildRollbackRequest(preview, true)
  assert.equal(rb.consentToken, 'SYNTHETIC_CONSENT_TOKEN')
  assert.equal(rb.expectedSha, 'a'.repeat(64))
  assert.equal('mode' in rb, false, '回滚目标由服务端取 previousMode')
})

test('重启提示：route/aggregated 需重启，切回 official（退出后）也要重启；不显示立即生效', async () => {
  const agg = await loadAgg()
  assert.equal(agg.restartNotice(null, 'official').needed, false)
  assert.equal(agg.restartNotice(null, 'route').needed, true)
  assert.equal(agg.restartNotice(null, 'aggregated').needed, true)
  assert.match(agg.restartNotice(null, 'aggregated').detail, /完全退出/)
  const afterExit = agg.restartNotice({ needed: true, reason: 'client_running_after_exit' }, 'official')
  assert.equal(afterExit.needed, true)
  assert.match(afterExit.label, /退出后也要重启/)
  assert.match(afterExit.detail, /退出后也要重启/)

  const src = readFileSync(AGG_VIEW, 'utf8')
  assert.match(src, /请完全退出并重新打开 Codex 才能使用新模式/)
  assert.doesNotMatch(src, /已立即生效/, '切换后不得声称立即生效')

  const conn = readFileSync(CONNECTIONS_VIEW, 'utf8')
  assert.match(conn, /请完全退出并重新打开 Codex 才能使用新模式/)
  assert.doesNotMatch(conn, /已立即生效/, '切换后不得声称立即生效')
})

test('端点常量与源码：switch/rollback/modes 已接线，预览表支持删除行，无 token 输入框', async () => {
  const agg = await loadAgg()
  const ep = agg.AGGREGATION_ENDPOINTS
  assert.equal(ep.modes, '/api/aggregation/modes')
  assert.equal(ep.switch, '/api/aggregation/switch')
  assert.equal(ep.rollback, '/api/aggregation/rollback')
  const src = readFileSync(AGG_VIEW, 'utf8')
  assert.match(src, /kind === 'remove'/)
  assert.match(src, /删除该字段/)
  assert.match(src, /AGGREGATION_ENDPOINTS\.switch/)
  assert.match(src, /AGGREGATION_ENDPOINTS\.rollback/)
  assert.match(src, /AGGREGATION_ENDPOINTS\.modes/)
  const conn = readFileSync(CONNECTIONS_VIEW, 'utf8')
  assert.match(conn, /AGGREGATION_ENDPOINTS\.switch/)
  assert.match(conn, /AGGREGATION_ENDPOINTS\.rollback/)
  assert.match(conn, /modeChooser/)
  // 不得出现 consentToken 输入框或字面量 Key（既有 Go API Key 输入框是正常接入所需，不在此列）
  assert.doesNotMatch(src, /field\(['"]consentToken['"]/)
  assert.doesNotMatch(conn, /field\(['"]consentToken['"]/)
  assert.doesNotMatch(src + conn, /placeholder:[^}]*consentToken/i)
})

test('product-status：deriveAggregation 三模式 + 漂移 + unknown，homeStateOf 区分 official/route', async () => {
  const ps = await loadStatus()
  assert.match(ps.deriveAggregation({ health: { mode: 'official' } }).label, /官方直连/)
  assert.match(ps.deriveAggregation({ health: { mode: 'route' } }).label, /路由模式/)
  assert.match(ps.deriveAggregation({ health: { mode: 'aggregated' } }).label, /聚合模式/)
  const unknown = ps.deriveAggregation({ health: { mode: 'weird' } })
  assert.equal(unknown.label, '状态未知')
  assert.equal(unknown.modeKnown, false)
  const drifted = ps.deriveAggregation({ health: { mode: 'official', drifted: true } })
  assert.equal(drifted.drifted, true)
  assert.match(drifted.label, /配置漂移/)
  assert.match(drifted.label, /需要重新对齐/)
  assert.match(drifted.detail, /不显示成直连/)
  assert.doesNotMatch(drifted.detail, /读取失败/, 'drifted 不得投影成一次读取失败')

  const base = {
    loading: false, authenticatedAdmin: true,
    official: {}, go: { credentialPresent: true, targetModelConfigured: true }, codex: { found: true },
  }
  const mk = (mode, extra = {}) => ({
    ...base,
    aggregation: { supported: true, modeKnown: true, mode, ...extra },
  })
  assert.equal(ps.homeStateOf(mk('official')), 'ready_to_enable')
  assert.equal(ps.homeStateOf(mk('route')), 'ready')
  // 漂移是"读取成功但需要重新对齐"，必须有独立状态，不得再混入 recoverable_error→"读取失败"。
  assert.equal(ps.homeStateOf(mk('route', { drifted: true })), 'needs_realign')
  assert.equal(ps.homeStateOf(mk('unknown', { modeKnown: false })), 'recoverable_error')
  const realign = ps.overallOf({ state: 'needs_realign' })
  assert.match(realign.label, /配置需要重新对齐/)
  assert.doesNotMatch(realign.label, /读取失败/)
  assert.equal(ps.nextPrimaryAction({ state: 'needs_realign' }).label, '重新对齐配置')
})

test('dashboard：modeText 三模式文案同步，unknown 不显示为直连', () => {
  const src = readFileSync(DASHBOARD, 'utf8')
  assert.match(src, /官方直连（不经 ModelGate）/)
  assert.match(src, /路由（纯 DeepSeek，无 GPT）/)
  assert.match(src, /聚合（GPT 父 \+ DeepSeek 子）/)
  assert.match(src, /状态未知/)
  assert.match(src, /请完全退出并重新打开 Codex 才能使用新模式（退出后也要重启）/)
})

test('脱敏：套件仅含合成占位串，无真实密钥形态字符串', () => {
  const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.match(testSrc, /SYNTHETIC_CONSENT_TOKEN/, '使用合成占位串')
  assert.doesNotMatch(testSrc, /sk-[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(testSrc, /eyJ[A-Za-z0-9_-]{20,}/)
  assert.doesNotMatch(testSrc, /ghp_[A-Za-z0-9]{16,}/)
})

// ============ 参考图三模式落地页（前端离线渲染，无真实网关/凭据）============
// 零依赖 DOM shim：只实现本套件渲染 landing 所需 API；toast/dialog 宿主返回 null 以避免定时器。
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
    this.value = ''
    this.checked = false
    this.disabled = false
    this.hidden = false
    this.listeners = {}
    this.parent = null
  }
  get textContent () { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
  set textContent (v) { this._text = ''; this.children = [{ nodeType: 3, textContent: String(v) }] }
  append (...nodes) { for (const n of nodes) { const node = (n && n.nodeType) ? n : { nodeType: 3, textContent: String(n) }; node.parent = this; this.children.push(node) } }
  appendChild (n) { this.append(n) }
  removeChild (n) { this.children = this.children.filter((c) => c !== n) }
  remove () { if (this.parent) this.parent.removeChild(this) }
  setAttribute (k, v) { this.attributes[k] = String(v) }
  getAttribute (k) { return this.attributes[k] == null ? null : this.attributes[k] }
  removeAttribute (k) { delete this.attributes[k] }
  addEventListener (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener () {}
  focus () {}
  querySelector () { return null }
  querySelectorAll () { return [] }
}
globalThis.document = {
  documentElement: { dataset: {} },
  body: new El('body'),
  createElement: (tag) => new El(tag),
  createElementNS: (ns, tag) => new El(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  getElementById: (id) => (id === 'toasts' || id === 'dialog-root' ? null : new El('div')),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener () {},
  removeEventListener () {},
}
globalThis.window = { addEventListener () {}, removeEventListener () {}, matchMedia: () => ({ matches: false, addEventListener () {} }) }
globalThis.location = { hash: '#/connections' }

const connections = await import(new URL('../../../src/ui-next/js/views/connections.js', import.meta.url))
const findAll = (el, fn) => {
  const out = []
  const walk = (node) => {
    if (!node || node.nodeType !== 1) return
    if (fn(node)) out.push(node)
    for (const c of node.children || []) walk(c)
  }
  walk(el)
  return out
}
const sampleProduct = () => ({
  official: { state: 'detected', label: '已检测到本机登录', detail: '' },
  go: { state: 'configured' }, codex: { found: true },
  aggregation: { mode: 'official', label: '官方直连（不经 ModelGate）' },
  overall: { level: 'ready', label: '准备就绪', detail: '' }, state: 'ready',
})
const sampleAggregation = (drifted = false) => ({
  health: { mode: 'official', drifted },
  modes: { modes: [{ id: 'aggregated', selectableParents: ['gpt-6-luna', 'gpt-5.2'] }] },
  drifted,
})
const renderLanding = (ctx = {}) => {
  const root = new El('div')
  connections.render(root, Object.assign({ step: 'connect', product: sampleProduct(), aggregation: sampleAggregation() }, ctx))
  return root
}

test('参考图落地页：默认落地是三模式中枢，segmented 三模式 + 三卡片文案逐项对应', () => {
  assert.deepEqual(connections.SEGMENT_SPECS.map((s) => s.label), ['⚡ 直连', '⇄ 路由', '▤ 聚合'])
  const byMode = Object.fromEntries(connections.MODE_CARD_SPECS.map((s) => [s.mode, s]))
  assert.equal(byMode.official.title, '直连模式')
  assert.equal(byMode.official.subtitle, 'Codex 直接连接官方服务')
  assert.equal(byMode.official.cta, '使用直连')
  assert.equal(byMode.official.footnote, '不经过 ModelGate 转发')
  assert.equal(byMode.route.title, '路由模式')
  assert.equal(byMode.route.subtitle, '经由 ModelGate 转发请求')
  assert.equal(byMode.route.cta, '启用路由')
  assert.equal(byMode.route.footnote, '需要网关持续运行')
  assert.equal(byMode.aggregated.title, '聚合模式')
  assert.equal(byMode.aggregated.subtitle, '在原版 Codex 中使用多个模型')
  assert.equal(byMode.aggregated.cta, '启用聚合')
  assert.equal(byMode.aggregated.footnote, '原版 Codex Harness · 原生压缩')

  // 显式无 step 的 hash 也必须落到 landing（不是 key 向导第 1 步）
  const root = new El('div')
  location.hash = '#/connections'
  connections.render(root, { product: sampleProduct(), aggregation: sampleAggregation() })
  const text = root.textContent
  for (const s of connections.MODE_CARD_SPECS) {
    assert.ok(text.includes(s.title), '缺少卡片标题 ' + s.title)
    assert.ok(text.includes(s.cta), '缺少按钮 ' + s.cta)
    assert.ok(text.includes(s.footnote), '缺少脚注 ' + s.footnote)
  }
  assert.match(text, /ChatGPT 官方/)
  assert.match(text, /GPT-6 Luna/)
  assert.match(text, /官方登录正常/)
  assert.match(text, /OpenCode Go/)
  assert.match(text, /deepseek-v4\.1-flash/)
  assert.match(text, /网关运行中/)
  assert.match(text, /测试连接/)
  assert.match(text, /高级路由设置 ›/)
  assert.match(text, /待启用/)
  assert.match(text, /已保留/)
  assert.match(text, /父代理: 官方 GPT \| 子代理: DeepSeek/)
  assert.match(text, /完全退出并重新打开 Codex/)
  assert.equal(findAll(root, (e) => e.tagName === 'ARTICLE').length, 3)
})

test('segmented 点击只切换高亮卡片，不触发任何写入', () => {
  const root = renderLanding()
  const segs = findAll(root, (e) => e.tagName === 'BUTTON' && e.getAttribute('data-mode'))
  assert.equal(segs.length, 3)
  assert.ok(segs[0].className.includes('is-active'), '默认直连高亮')
  segs[2].listeners.click[0]({})
  assert.ok(segs[2].className.includes('is-active'))
  assert.ok(!segs[0].className.includes('is-active'))
  const cards = findAll(root, (e) => e.tagName === 'ARTICLE')
  assert.ok(cards[2].className.includes('is-selected'))
  assert.ok(!cards[0].className.includes('is-selected'))
})

test('三卡片主按钮请求体：official / route / aggregated(parentModel)，确认后带 consentToken', async () => {
  const preview = {
    consentToken: 'SYNTHETIC_CONSENT_TOKEN', expectedSha: 'a'.repeat(64), rows: [],
    preserved: { topLevelKeys: [], sections: [] },
  }
  for (const [cta, expected] of [
    ['使用直连', { mode: 'official', parentModel: null }],
    ['启用路由', { mode: 'route', parentModel: null }],
    ['启用聚合', { mode: 'aggregated', parentModel: 'gpt-6-luna' }],
  ]) {
    const calls = []
    const post = async (path, body) => {
      calls.push({ path, body })
      if (calls.length === 1) {
        throw Object.assign(new Error('preview'), { status: 428, data: { code: 'consent_required', preview } })
      }
      return { ok: false, code: 'synthetic-stop' }
    }
    const root = renderLanding({ deps: { post } })
    const btn = findAll(root, (e) => e.tagName === 'BUTTON' && e.textContent === cta)[0]
    assert.ok(btn, '缺少按钮 ' + cta)
    await btn.listeners.click[0]({})
    assert.equal(calls.length, 1, cta + ' 应先预览不写入')
    assert.equal(calls[0].path, '/api/aggregation/switch')
    assert.equal(calls[0].body.mode, expected.mode)
    assert.equal(calls[0].body.consentToken, '')
    if (expected.parentModel) assert.equal(calls[0].body.parentModel, expected.parentModel)
    else assert.equal('parentModel' in calls[0].body, false, expected.mode + ' 不带 parentModel')

    const confirm = findAll(root, (e) => e.tagName === 'BUTTON' && e.textContent === '确认写入并验证')[0]
    assert.ok(confirm, cta + ' 缺少确认按钮')
    await confirm.listeners.click[0]({})
    assert.equal(calls.length, 2)
    assert.equal(calls[1].body.consentToken, 'SYNTHETIC_CONSENT_TOKEN')
    assert.equal(calls[1].body.expectedSha, 'a'.repeat(64))
    assert.equal(calls[1].body.mode, expected.mode)
  }
})

test('drifted：落地页显示"需要重新对齐"而非"读取失败"，卡片切换按钮禁用', () => {
  const root = renderLanding({ aggregation: sampleAggregation(true) })
  const text = root.textContent
  assert.match(text, /配置需要重新对齐/)
  assert.match(text, /重新对齐配置/)
  assert.doesNotMatch(text, /读取失败/)
  const ctas = findAll(root, (e) => e.tagName === 'BUTTON' && ['使用直连', '启用路由', '启用聚合'].includes(e.textContent))
  assert.equal(ctas.length, 3)
  for (const btn of ctas) assert.equal(btn.disabled, true, '漂移时切换按钮禁用')
})

// ============ 顶栏参考图（紫 M logo + V2 + 副标题 + 真实快照状态下拉）============
test('顶栏静态结构：紫 M 图形 + ModelGate + V2 + 副标题 + 状态下拉 + 分隔线 + 设置按钮', () => {
  const html = readFileSync(join(ROOT, 'src/ui-next/index.html'), 'utf8')
  assert.match(html, /class="topbar-logo"[^>]*>M<[^>]*>/, '缺少紫 M 图形')
  assert.match(html, /<strong>ModelGate<\/strong>/, '缺少粗体 ModelGate 文字')
  assert.match(html, /class="topbar-v2">V2</, '缺少 V2 标签')
  assert.match(html, /AI 模型网关 · 连接 \/ 路由 \/ 聚合/, '缺少副标题')
  assert.match(html, /id="conn-chip"/, '缺少状态胶囊')
  assert.match(html, /id="conn-text">未连接</, '无快照时默认文案是未连接')
  assert.match(html, /class="status-caret"/, '缺少下拉箭头')
  assert.match(html, /id="status-menu-panel"/, '缺少真实快照下拉明细')
  assert.match(html, /class="topbar-divider"/, '缺少分隔线')
  assert.match(html, /id="topbar-settings"/, '缺少设置按钮')
  assert.match(html, /<\/svg>设置\s*<\/button>/, '设置按钮缺少文案')

  const css = readFileSync(join(ROOT, 'src/ui-next/styles.css'), 'utf8')
  assert.match(css, /--purple:\s*#6d5efc/, '主色必须是 #6d5efc')
  assert.match(css, /\.topbar-logo\{[^}]*var\(--purple\)/, 'logo 用紫色主色')
  assert.match(css, /\.topbar-v2\{[^}]*var\(--purple\)/, 'V2 标签用紫色主色')
  assert.match(css, /\.status-menu-panel\{/, '下拉面板需有样式')
  assert.match(css, /\.topbar-divider\{/, '分隔线需有样式')
})

test('顶栏状态来自快照非写死：未连接 / 已连接 / 需重新对齐 三态', async () => {
  const { topbarStatusOf } = await loadStatus()
  // 取不到任何后端快照才「未连接」
  assert.equal(topbarStatusOf(null, null).label, '未连接')
  assert.equal(topbarStatusOf(null, {}).label, '未连接')
  // 已取到 status → 已连接；模式来自 health/modes 快照
  const route = { health: { mode: 'route' }, modes: { current: 'route' } }
  const connected = topbarStatusOf({ configVersion: 7 }, route)
  assert.equal(connected.label, '已连接')
  assert.equal(connected.mode, 'route')
  assert.match(connected.detail, /路由模式/)
  // 没有 status、但有聚合 health/modes 快照也算取到状态
  assert.equal(topbarStatusOf(null, route).label, '已连接')
  // drifted → 需重新对齐（复用 HOME_STATES 的 needs_realign，不是"读取失败"）
  const drifted = topbarStatusOf({ configVersion: 7 }, { health: { mode: 'aggregated', drifted: true }, drifted: true })
  assert.equal(drifted.label, '需重新对齐')
  assert.equal(drifted.state, 'needs_realign')
  assert.doesNotMatch(drifted.detail, /读取失败/)
  // unknown 不伪装成具体模式
  const unknown = topbarStatusOf(null, { health: { mode: 'weird' } })
  assert.equal(unknown.label, '已连接')
  assert.equal(unknown.mode, 'unknown')
  // 不同快照得出不同文案 —— 证明文案是推导出来的，不是写死
  assert.notEqual(topbarStatusOf(null, null).label, connected.label)
  assert.notEqual(drifted.label, connected.label)
})

test('顶栏下拉绑定共享快照：app.js 调用 topbarStatusOf(status, aggregationState())', () => {
  const app = readFileSync(join(ROOT, 'src/ui-next/app.js'), 'utf8')
  assert.match(app, /import \{ topbarStatusOf \}/)
  assert.match(app, /topbarStatusOf\(s, aggregationState\(\)\)/, '顶栏必须消费 health/modes 快照')
  assert.match(app, /getElementById\('status-menu-gateway'\)/)
  assert.match(app, /getElementById\('status-menu-mode'\)/)
  assert.match(app, /getElementById\('topbar-settings'\)/)
})

test('apikey 审计：改动前端源文件无明文密钥、无新增 token 输入框、无上传', () => {
  const files = [
    'src/ui-next/index.html',
    'src/ui-next/app.js',
    'src/ui-next/js/router.js',
    'src/ui-next/js/product-status.js',
    'src/ui-next/js/views/connections.js',
    'src/ui-next/js/views/aggregation.js',
    'src/ui-next/styles.css',
  ]
  let src = ''
  for (const f of files) src += readFileSync(new URL('../../../' + f, import.meta.url), 'utf8')
  assert.doesNotMatch(src, /sk-[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}/)
  assert.doesNotMatch(src, /ghp_[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(src, /field\(['"]consentToken['"]/)
  assert.doesNotMatch(src, /type:\s*['"]password['"][\s\S]{0,120}consent/i)
  assert.doesNotMatch(src, /fetch\(['"]https?:\/\//i, '前端不得向第三方上传')
})
