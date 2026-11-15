// UX-02 / UX-03（A2）：连接向导的编排层、诚实性、Key 无回显与 preset HTTP 契约回归。
//
// 全部离线：注入 post/get 断言步骤顺序与部分失败；DOM 用本文件内的零依赖 shim（不装 jsdom）。
// HTTP 契约用 harness.startGateway 启动隔离网关（虚构 Key、临时配置目录、不触达任何真实上游）。
// 真实 Go 推理一律不在这里发生：同步步骤在单测里是注入的假 post，不请求 opencode.ai。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, root } from './harness.mjs'

// ---------- 零依赖 DOM shim（只实现本套件用到的 API） ----------
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
  documentElement: { dataset: {} },
  body: createEl('body'),
  createElement: (tag) => createEl(tag),
  createElementNS: (ns, tag) => createEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  // toasts / dialog-root 故意返回 null：本套件不测 toast/弹窗视觉，避免留下 setTimeout。
  getElementById: (id) => {
    if (id === 'toasts' || id === 'dialog-root') return null
    if (!byId.has(id)) { const el = createEl('div'); el.id = id; byId.set(id, el) }
    return byId.get(id)
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener () {},
  removeEventListener () {},
}
globalThis.window = {
  location: { origin: 'http://127.0.0.1:8787', hash: '#/connections?step=key' },
  addEventListener () {},
  removeEventListener () {},
  matchMedia: () => ({ matches: false, addEventListener () {} }),
  scrollTo () {},
  confirm: () => true,
}
globalThis.location = globalThis.window.location
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }

const connections = await import('../../../src/ui-next/js/views/connections.js')
const aggregation = await import('../../../src/ui-next/js/views/aggregation.js')
const { normalizeProviderInput } = await import('../../../src/aggregation/api.js')

const FAKE_KEY = 'mg-fake-go-key-A2-NOT-REAL-1234'
const EP = aggregation.AGGREGATION_ENDPOINTS

function apiError (status, data, message) {
  const err = new Error(message || ((data && (data.code || data.error)) || 'http_' + status))
  err.status = status
  err.data = data || null
  return err
}

function recorder (handlers) {
  const calls = []
  const post = async (path, body) => {
    calls.push({ path, body })
    const h = handlers[path] || handlers[path.replace(/\/sync$/, '/sync')]
    if (typeof h === 'function') return h(body, calls)
    if (h instanceof Error) throw h
    if (h !== undefined) return h
    if (path === EP.providers) return { ok: true, provider: { id: 'opencodego' } }
    if (path === '/api/keys') return { ok: true }
    if (path.endsWith('/sync')) return { ok: true, completeness: 'complete' }
    throw new Error('unexpected POST ' + path)
  }
  return { post, calls }
}

function renderRoot (ctx) {
  const el = createEl('div')
  connections.render(el, ctx)
  return el
}

function walk (el, fn) {
  if (!el || el.nodeType !== 1) return
  fn(el)
  for (const c of el.children || []) walk(c, fn)
}
function findAll (el, pred) {
  const out = []
  walk(el, (e) => { if (pred(e)) out.push(e) })
  return out
}

function productFixture (extra = {}) {
  return Object.assign({
    contract: 'mg-ui-product-status/1',
    state: 'needs_go_key',
    overall: { level: 'action', label: '需要操作：连接 OpenCode Go', detail: '填入 OpenCode Go API Key 即可自动配置。' },
    primary: { id: 'connect-go', label: '连接 OpenCode Go', kind: 'route', route: '#/connections?step=key', detail: '' },
    secondary: [],
    official: { state: 'detected', level: 'detected', label: '已检测到本机登录', detail: '只读探测，未发起任何请求。' },
    go: { state: 'missing', level: 'detected', label: '待连接', detail: '还没有接入 OpenCode Go。', credentialPresent: false },
    codex: { found: true, detectionLevel: 'detected', restartNeeded: null, label: '已检测到', detail: '检测到原版 Codex。' },
    aggregation: { mode: 'official', label: '官方模式（未聚合）', supported: true },
    checkedAt: Date.now(),
    missingSections: [],
  }, extra)
}

// ---------- 1) 编排：只填 Key 时的固定顺序与最小请求体 ----------
test('编排：只填 Key → providers → keys → sync，请求体不含 id/baseUrl/apiKeyEnv', async () => {
  const rec = recorder({})
  const result = await connections.runConnectFlow({ post: rec.post, key: FAKE_KEY, configVersion: 7 })
  assert.deepEqual(rec.calls.map((c) => c.path), [EP.providers, '/api/keys', EP.sync('opencodego')])
  assert.deepEqual(rec.calls[0].body, { preset: 'opencode-go', configVersion: 7 })
  for (const field of ['id', 'baseUrl', 'apiKeyEnv', 'apiKey']) {
    assert.equal(Object.prototype.hasOwnProperty.call(rec.calls[0].body, field), false, 'provider 请求不得包含 ' + field)
  }
  assert.deepEqual(rec.calls[1].body, { id: 'opencodego', key: FAKE_KEY })
  assert.deepEqual(rec.calls[2].body, {})
  assert.equal(result.ok, true)
  assert.equal(result.providerRegistered, true)
  assert.equal(result.keySaved, true)
  assert.equal(result.synced, true)
  assert.deepEqual(result.steps.map((s) => s.status), ['done', 'done', 'done'])
})

test('编排：已存在的供应商按幂等继续（provider_exists 不阻断）', async () => {
  const rec = recorder({ [EP.providers]: () => { throw apiError(409, { code: 'provider_exists', error: '供应商已存在' }) } })
  const result = await connections.runConnectFlow({ post: rec.post, key: FAKE_KEY, configVersion: 1 })
  assert.equal(result.providerExisted, true)
  assert.equal(result.ok, true)
  assert.equal(result.steps[0].status, 'existing')
  assert.deepEqual(rec.calls.map((c) => c.path), [EP.providers, '/api/keys', EP.sync('opencodego')])
})

test('编排：只重试同步时，前面的步骤标记 not-run 而不是谎称已执行', async () => {
  const rec = recorder({})
  const prior = { providerRegistered: true, keySaved: true }
  const result = await connections.runConnectFlow({ post: rec.post, from: 'sync', prior })
  assert.deepEqual(rec.calls.map((c) => c.path), [EP.sync('opencodego')])
  assert.equal(result.steps[0].status, 'not-run')
  assert.equal(result.steps[1].status, 'not-run')
  assert.equal(result.steps[2].status, 'done')
  assert.equal(result.ok, true)
})

// ---------- 2) 部分失败必须如实 ----------
test('部分状态：供应商成功 + Key 失败 → 如实说明，且不继续同步', async () => {
  const rec = recorder({ '/api/keys': () => { throw apiError(400, { error: '未知的 Key 标识：opencodego' }) } })
  const result = await connections.runConnectFlow({ post: rec.post, key: FAKE_KEY })
  assert.deepEqual(rec.calls.map((c) => c.path), [EP.providers, '/api/keys'])
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'key')
  assert.equal(result.keySaved, false)
  assert.equal(result.steps[2].status, 'skipped')
  const msg = connections.partialStateMessage(result)
  assert.equal(msg.partial, true)
  assert.match(msg.text, /已注册 OpenCode Go 供应商，但 Key 保存失败/)
  assert.doesNotMatch(msg.text, /已连接|已启用/)
})

test('部分状态：Key 成功 + 同步失败 → "Key 已保存，连接未完成"', async () => {
  const rec = recorder({ [EP.sync('opencodego')]: () => { throw apiError(502, { code: 'catalog_publish_failed' }) } })
  const result = await connections.runConnectFlow({ post: rec.post, key: FAKE_KEY })
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'sync')
  assert.equal(result.keySaved, true)
  const msg = connections.partialStateMessage(result)
  assert.equal(msg.label, 'Key 已保存，连接未完成')
  assert.match(msg.text, /Key 已保存，连接未完成/)
  assert.match(msg.detail, /不是 0 个模型/)
  assert.equal(msg.partial, true)
  // 只重试同步：带上上次成功的 Key 状态，成功后仍然算完成，不谎称 Key 丢了。
  const retry = recorder({})
  const again = await connections.runConnectFlow({ post: retry.post, from: 'sync', prior: result })
  assert.equal(again.ok, true)
  assert.deepEqual(retry.calls.map((c) => c.path), [EP.sync('opencodego')])
})

test('部分状态：同步只返回 partial → 明说未完成（不是 0 个模型），不算 ok', async () => {
  const rec = recorder({ [EP.sync('opencodego')]: () => ({ ok: true, completeness: 'discovery_partial' }) })
  const result = await connections.runConnectFlow({ post: rec.post, key: FAKE_KEY })
  assert.equal(result.syncPartial, true)
  assert.equal(result.ok, false)
  const msg = connections.partialStateMessage(result)
  assert.match(msg.text, /不是 0 个模型/)
})

test('编排：缺少 post 注入立即抛 TypeError（避免静默空转）', async () => {
  await assert.rejects(() => connections.runConnectFlow({ key: FAKE_KEY }), TypeError)
})

// ---------- 3) 428 预览：不写入，带 consentToken + expectedSha ----------
test('428：不写入、展示预览（diff/冲突/备份/首次设置），确认体带 consentToken + expectedSha', () => {
  const preview = {
    expectedSha: 'a'.repeat(64),
    consentToken: 'consent_1',
    rows: [
      { path: 'model', kind: 'replace', from: 'gpt-5', to: 'mg-opencodego-deepseek-v4-1-flash' },
      { path: 'same.line', kind: 'same', from: 'x', to: 'x' },
    ],
    conflicts: [{ path: 'model' }],
    backup: { available: true, path: '/tmp/mg-backup.toml' },
    firstRun: true,
    warnings: ['note'],
    catalog: { ok: true, modelCount: 2 },
  }
  const outcome = connections.classifyActivation(apiError(428, { ok: false, code: 'consent_required', preview }))
  assert.equal(outcome.kind, 'preview')
  assert.equal(outcome.writes, false)
  assert.equal(outcome.summary.changeCount, 1, 'same 行不计入变更')
  assert.deepEqual(outcome.summary.conflicts, ['model'])
  assert.equal(outcome.summary.backupAvailable, true)
  assert.equal(outcome.summary.firstRun, true)
  assert.equal(outcome.summary.expectedSha, 'a'.repeat(64))
  const payload = aggregation.buildActivateRequest(outcome.preview, true)
  assert.deepEqual(payload, { consentToken: 'consent_1', expectedSha: 'a'.repeat(64) })
  // 未确认时的请求体不得带 consentToken（只预览）。
  assert.deepEqual(aggregation.buildActivateRequest(outcome.preview, false), { consentToken: '', expectedSha: 'a'.repeat(64) })
})

test('422 blocked：如实展示 blocked 列表且不写入', () => {
  const outcome = connections.classifyActivation(apiError(422, { ok: false, code: 'activation_blocked', blocked: [{ code: 'catalog_missing', message: '目录不可用' }] }))
  assert.equal(outcome.kind, 'blocked')
  assert.equal(outcome.writes, false)
  assert.equal(outcome.blocked.length, 1)
  assert.equal(outcome.blocked[0].code, 'catalog_missing')
})

// ---------- 4) 409：三方差异可用且绝不覆盖 ----------
test('409：三方差异可用、只保留非 same 行，且没有强制覆盖路径', () => {
  const conflict = {
    status: 409,
    data: {
      ok: false,
      code: 'config_conflict',
      detail: {
        threeWay: {
          base: { sha256: 'a'.repeat(64) },
          ours: { sha256: 'b'.repeat(64) },
          theirs: { sha256: 'c'.repeat(64) },
          oursVsTheirs: [{ kind: 'same', text: 'x' }, { kind: 'add', text: 'model = "y"' }],
          guidance: '先手工合并。',
        },
      },
    },
  }
  const outcome = connections.classifyActivation(conflict)
  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.writes, false)
  assert.equal(outcome.mayOverwrite, false)
  assert.equal(outcome.threeWay.available, true)
  assert.equal(outcome.threeWay.rows.length, 1)
  assert.match(outcome.threeWay.summary, /基准 aaaaaaaa/)
  assert.equal('force' in outcome, false)
  assert.doesNotMatch(JSON.stringify(outcome), /forceOverwrite|force_write/i)
})

// ---------- 5) Key 不回显 / 不持久化 / 不进结果 ----------
test('Key 安全：请求体只在 /api/keys 出现；结果与 DOM 文本都不回显 Key', async () => {
  const rec = recorder({})
  const result = await connections.runConnectFlow({ post: rec.post, key: FAKE_KEY, configVersion: 0 })
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false, '编排结果不得包含 Key')
  assert.equal(JSON.stringify(rec.calls[0].body).includes(FAKE_KEY), false)
  assert.equal(JSON.stringify(rec.calls[2].body).includes(FAKE_KEY), false)
  assert.equal(JSON.stringify(rec.calls[1].body).includes(FAKE_KEY), true, '只有 /api/keys 提交 Key')

  const uiCalls = []
  const uiPost = async (path, body) => {
    uiCalls.push({ path, body })
    if (path === EP.providers) return { ok: true }
    if (path === '/api/keys') return { ok: true }
    return { ok: true, completeness: 'complete' }
  }
  const el = renderRoot({ step: 'key', product: () => productFixture(), deps: { post: uiPost } })
  const passwordInputs = findAll(el, (e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'password')
  assert.equal(passwordInputs.length, 1, '默认只应有一个 Key 密码输入框')
  const input = passwordInputs[0]
  assert.equal(input.getAttribute('autocomplete'), 'new-password')
  input.value = FAKE_KEY
  const submitButtons = findAll(el, (e) => e.tagName === 'BUTTON' && e.textContent === '连接 OpenCode Go')
  const submit = submitButtons[submitButtons.length - 1]
  assert.ok(submit, '缺少连接按钮')
  await submit.listeners.click[0]({})
  assert.equal(input.value, '', '提交后必须立即清空输入框')
  assert.equal(el.textContent.includes(FAKE_KEY), false, 'DOM 文本不得回显 Key')
  const nonKeyCalls = uiCalls.filter((c) => c.path !== '/api/keys')
  assert.equal(JSON.stringify(nonKeyCalls).includes(FAKE_KEY), false, '除 /api/keys 外不得出现 Key')
  assert.equal(JSON.stringify(uiCalls.filter((c) => c.path === '/api/keys')).includes(FAKE_KEY), true, 'Key 只能出现在 /api/keys 请求体')
  assert.match(el.textContent, /已注册并保存 Key/)
})

// ---------- 6) 目标模型固定 ----------
test('目标模型固定很深：容错接受公共 ID / 上游名 / 旧写法，且不把其它模型当目标', () => {
  assert.equal(connections.GO_TARGET_LABEL, 'DeepSeek V4.1 Flash', '面向用户只显示模型名')
  const byPublic = connections.targetModelOf({ models: [{ publicId: 'mg-opencodego-deepseek-v4-1-flash', upstreamId: 'deepseek-v4.1-flash' }] })
  assert.ok(byPublic)
  assert.ok(connections.targetModelOf([{ publicId: 'opencodego/deepseek-v4.1-flash' }]))
  assert.ok(connections.targetModelOf([{ publicId: 'deepseek-v4.1-flash' }]))
  assert.equal(connections.targetModelOf([{ publicId: 'mg-opencodego-gpt-6-luna', upstreamId: 'gpt-6-luna' }]), null)
  assert.equal(connections.targetModelOf(null), null)
  // 请求不携带模型字段：目标模型由服务端 preset/V2 profile 固定。
  const req = connections.buildProviderRequest({ configVersion: 0 })
  assert.equal('model' in req, false)
  assert.equal('models' in req, false)
})

// ---------- 7) product 缺失时绝不出现成功状态 ----------
test('product=null：只显示"正在读取真实状态"，不出现"已连接/已启用"', () => {
  const overall = connections.describeOverall(null)
  assert.equal(overall.label, '正在读取真实状态')
  assert.doesNotMatch(JSON.stringify(overall), /已连接|已启用/)
  const rows = connections.statusRows(null)
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.equal(row.value, '未知')
    assert.equal(row.level, 'unknown')
  }
  const el = renderRoot({ step: 'key' })
  const text = el.textContent
  assert.match(text, /正在读取真实状态/)
  assert.doesNotMatch(text, /已连接|已启用/)
})

// ---------- 8) 启用/退出回执与重启判定 ----------
test('回执：reload 未生效时必须如实说需要重启网关，不得谎称已生效', () => {
  const notReloaded = connections.classifyActivation({ ok: true, sha: 'd'.repeat(64), reload: { applied: false, needsRestart: true, reason: 'reload_unavailable' } })
  assert.equal(notReloaded.kind, 'applied')
  const summary = connections.receiptSummary(notReloaded.receipt)
  assert.equal(summary.reloadApplied, false)
  assert.equal(summary.needsRestart, true)
  assert.equal(summary.reloadReason, 'reload_unavailable')

  const aggregated = aggregation.restartNotice({ needed: true, reason: 'client_running_with_old_config' }, 'aggregated')
  assert.equal(aggregated.needed, true)
  assert.match(aggregated.detail, /完全退出/)
  assert.equal(aggregation.restartNotice(null, 'official').needed, false)
})

// ---------- 9) 静态约束：无注入 sink、无持久化、无 Key 日志 ----------
test('源码约束：connections 无 innerHTML/持久化/Key 日志，控件可访问且无假"打开 Codex"按钮', () => {
  const src = readFileSync(join(root, 'src/ui-next/js/views/connections.js'), 'utf8')
  assert.doesNotMatch(src, /innerHTML\s*=/)
  assert.doesNotMatch(src, /insertAdjacentHTML/)
  assert.doesNotMatch(src, /sessionStorage|indexedDB/)
  assert.doesNotMatch(src, /localStorage/)
  assert.doesNotMatch(src, /console\.(log|info|warn|error|debug)\(/)
  assert.match(src, /type: 'password'/)
  assert.match(src, /autocomplete: 'new-password'/)
  assert.match(src, /role: 'alert'/)
  assert.match(src, /'aria-live': 'polite'/)
  assert.match(src, /field\('OpenCode Go API Key'/, 'label 必须与输入框关联')
  assert.match(src, /confirmDialog\(/, '退出恢复必须二次确认（dialog 自带 Escape + 焦点归还）')
  assert.match(src, /高级设置/)
  assert.doesNotMatch(src, /text: '打开 Codex'/, '不得提供假的"打开 Codex"按钮')
  assert.match(src, /完全退出 Codex Desktop（不是只关窗口）/, '重启文案必须明确完全退出')
  assert.match(src, /#\/connections\?step=/, '深链步骤必须保留')
})

test('源码约束：aggregation 去掉 V1 Console 全量话术、Go 默认 preset、技术长表收进高级详情', () => {
  const src = readFileSync(join(root, 'src/ui-next/js/views/aggregation.js'), 'utf8')
  assert.doesNotMatch(src, /Console 全量|自动发现[^。]*全部模型|添加并发现|添加第一个供应商|添加 OpenCode 供应商/)
  assert.match(src, /GO_PROVIDER_PRESET = 'opencode-go'/)
  assert.match(src, /GO_TARGET_LABEL = 'DeepSeek V4.1 Flash'/)
  assert.match(src, /body\.preset = GO_PROVIDER_PRESET/, 'Go 默认走 preset，不要求手填 URL/ID')
  const goIdx = src.indexOf("h('option', { value: 'opencode-go'")
  const consoleIdx = src.indexOf("h('option', { value: 'opencode-console'")
  assert.ok(goIdx > 0 && consoleIdx > goIdx, 'Go 必须是默认（第一个）选项')
  assert.match(src, /advancedSection/)
  assert.match(src, /h\('details', { class: 'advanced' }/)
  const detailsIdx = src.indexOf("h('details', { class: 'advanced' }")
  const technicalIdx = src.indexOf('technicalDetails(),')
  const providersIdx = src.indexOf('providersCard(ctx),')
  const modelsIdx = src.indexOf('modelsCard(),')
  const diagIdx = src.indexOf('diagnosticsCard())')
  assert.ok(detailsIdx >= 0 && technicalIdx > detailsIdx, '高级详情必须包含技术详情')
  assert.ok(providersIdx > technicalIdx && modelsIdx > providersIdx && diagIdx > modelsIdx, '技术长表必须在高级详情内')
  for (const name of ['modeLabel', 'summarizeDiscovery', 'buildActivateRequest', 'describeThreeWay', 'versionLabel', 'restartNotice', 'nativeCompactionNotice', 'AGGREGATION_VIEW_CONTRACT', 'AGGREGATION_ENDPOINTS']) {
    assert.match(src, new RegExp('export (function|const) ' + name), '导出的既有契约不得删除：' + name)
  }
})

// ---------- 10) 后端最小改动：normalizeProviderInput 透传 preset ----------
test('normalizeProviderInput：preset 透传且不塞空字段；内联 apiKey 仍原样交给注册表拒绝', () => {
  assert.deepEqual(normalizeProviderInput({ preset: 'opencode-go', configVersion: 3 }), { preset: 'opencode-go', version: 3 })
  const withPreset = normalizeProviderInput({ preset: 'opencode-go' })
  assert.deepEqual(Object.keys(withPreset), ['preset'], '显式 undefined 会覆盖 preset 模板字段，不能写进请求')
  assert.deepEqual(normalizeProviderInput({
    provider: { kind: 'go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKeyEnv: 'MG_TEST_GO_KEY' },
  }), {
    id: 'opencodego', kind: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKeyEnv: 'MG_TEST_GO_KEY',
  })
  const inline = normalizeProviderInput({ preset: 'opencode-go', apiKey: 'sk-inline-not-allowed' })
  assert.equal(inline.apiKey, 'sk-inline-not-allowed', '内联 Key 交给注册表抛出 provider_key_inline_forbidden')
  assert.equal(normalizeProviderInput(null), null)
  assert.equal(normalizeProviderInput([1, 2]), null)
})

// ---------- 11) HTTP 契约回归（隔离网关 + 虚构 Key，不触碰真实上游） ----------
test('HTTP 契约：preset 注册返回 201/opencodego/非空 baseUrl，响应不含明文 Key；内联 apiKey 仍被拒', { timeout: 45000 }, async (t) => {
  const token = 'ux-v3-conn-test-admin'
  const gw = await startGateway({ name: 'ux-v3-conn', env: { MG_ADMIN_TOKEN: token } })
  t.after(() => gw.stop())
  const auth = { authorization: 'Bearer ' + token }

  const created = await gw.post('/api/aggregation/providers', { preset: 'opencode-go', configVersion: 0 }, auth)
  const createdText = await created.text()
  assert.equal(created.status, 201, createdText)
  const createdBody = JSON.parse(createdText)
  assert.equal(createdBody.ok, true)
  assert.equal(createdBody.provider.id, 'opencodego')
  assert.equal(createdBody.provider.kind, 'opencode-go')
  assert.ok(createdBody.provider.baseUrl && createdBody.provider.baseUrl.length > 0, 'preset 必须补全 baseUrl')
  assert.match(createdBody.provider.baseUrl, /opencode\.ai/)
  assert.equal(Object.prototype.hasOwnProperty.call(createdBody.provider, 'apiKey'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(createdBody.provider, 'key'), false)
  assert.doesNotMatch(createdText, /sk-|apiKey"/)

  const keyRes = await gw.post('/api/keys', { id: 'opencodego', key: FAKE_KEY }, auth)
  const keyText = await keyRes.text()
  assert.equal(keyRes.status, 200, keyText)
  assert.equal(keyText.includes(FAKE_KEY), false, 'Key 不得出现在响应里')

  const statusRes = await gw.get('/api/status', auth)
  const statusText = await statusRes.text()
  assert.equal(statusRes.status, 200)
  assert.equal(statusText.includes(FAKE_KEY), false, '状态接口不得回显 Key')
  const status = JSON.parse(statusText)
  const goRow = (Array.isArray(status.providers) ? status.providers : []).find((p) => p && p.id === 'opencodego')
  assert.ok(goRow, '状态接口必须列出 opencodego 供应商')
  assert.equal(goRow.hasKey, true, 'Key 写入后状态只暴露 hasKey 存在性')

  const inline = await gw.post('/api/aggregation/providers', { preset: 'opencode-go', apiKey: 'sk-inline-not-allowed' }, auth)
  const inlineBody = JSON.parse(await inline.text())
  assert.equal(inline.status, 400, JSON.stringify(inlineBody))
  assert.equal(inlineBody.code, 'provider_key_inline_forbidden', '内联 Key 必须被注册表拒绝')
});
