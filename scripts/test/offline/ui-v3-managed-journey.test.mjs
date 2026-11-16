// G5（前端半）：普通用户「连接 Go → 启用聚合 → 看真实状态 → 退出恢复」可操作性回归。
// 全部为离线纯函数 + 最小 DOM shim：不发真实请求、不启动浏览器、不调用任何付费模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

class El {
  constructor (tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.children = []
    this.attributes = {}
    this.dataset = {}
    this._text = ''
    this.className = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.listeners = {}
  }
  get textContent () { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
  set textContent (v) { this._text = ''; this.children = [{ nodeType: 3, textContent: String(v) }] }
  append (...nodes) { for (const n of nodes) { const node = (n && n.nodeType) ? n : { nodeType: 3, textContent: String(n) }; this.children.push(node) } }
  setAttribute (k, v) { this.attributes[k] = String(v) }
  getAttribute (k) { return this.attributes[k] == null ? null : this.attributes[k] }
  addEventListener (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener () {}
  focus () {}
  querySelector () { return null }
  querySelectorAll () { return [] }
}
globalThis.document = {
  documentElement: { dataset: {} },
  body: new El('body'),
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById: () => new El('div'),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener () {},
  removeEventListener () {},
}
globalThis.location = { hash: '', reload () { throw new Error('unexpected reload') } }
globalThis.window = { location: globalThis.location, addEventListener () {}, removeEventListener () {}, scrollTo () {}, matchMedia: () => ({ matches: false, addEventListener () {} }) }
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
globalThis.__MG_UI_TEST__ = true

const conn = await import('../../../src/ui-next/js/views/connections.js')
const agg = await import('../../../src/ui-next/js/views/aggregation.js')

function previewBody (overrides = {}) {
  return Object.assign({
    consentToken: 'consent_abc',
    expectedSha: 'a'.repeat(64),
    rows: [
      { path: 'model', kind: 'replace', from: '"gpt-5"', to: '"mg-opencodego-deepseek-v4-1-flash"', owner: 'modelgate' },
      { path: 'features.multi_agent', kind: 'add', from: null, to: 'true', owner: 'modelgate' },
      { path: 'agents.go_deepseek.config_file', kind: 'add', from: null, to: '"go-deepseek.toml"', owner: 'modelgate' },
    ],
    conflicts: [{ path: 'model', reason: 'overwrite' }],
    agentChild: { action: 'create', fileName: 'go-deepseek.toml', before: { exists: false, sha256: '' }, after: { exists: true, sha256: 'b'.repeat(64) }, conflict: null },
    backup: { available: true, path: '/tmp/config.toml.bak' },
    firstRun: false,
    warnings: [],
    catalog: { ok: true, state: 'present', modelCount: 12 },
    blocked: [],
  }, overrides)
}

test('预览：原生子代理托管计划如实展示；确认请求只带 consentToken + expectedSha', () => {
  const outcome = conn.classifyActivation({ status: 428, data: { ok: false, code: 'consent_required', preview: previewBody() } })
  assert.equal(outcome.kind, 'preview')
  assert.equal(outcome.summary.changeCount, 3)
  assert.ok(outcome.summary.changeRows.some((r) => r.path === 'agents.go_deepseek.config_file'))
  assert.equal(outcome.summary.agentChild.action, 'create')
  assert.equal(outcome.summary.agentChild.fileName, 'go-deepseek.toml')
  const payload = agg.buildActivateRequest(outcome.preview, true)
  assert.deepEqual(payload, { consentToken: 'consent_abc', expectedSha: 'a'.repeat(64) })
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'key'), false, '确认请求不得夹带 Key')
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'model'), false, '确认请求不得夹带模型切换')
  // 未确认时绝不写盘：consentToken 必须为空。
  assert.deepEqual(agg.buildActivateRequest(outcome.preview, false), { consentToken: '', expectedSha: 'a'.repeat(64) })
})

test('子代理 409 三方差异：识别为 conflict，展示原因且不产生写入', () => {
  const body = {
    ok: false,
    code: 'agent_child_modified',
    error: 'go-deepseek.toml 不是 ModelGate 写入的规范内容',
    detail: {
      path: '/tmp/go-deepseek.toml',
      threeWay: {
        base: { sha256: 'a'.repeat(64) }, ours: { sha256: 'a'.repeat(64) }, theirs: { sha256: 'c'.repeat(64) },
        oursVsTheirs: [{ kind: 'del', beforeNo: 1, afterNo: null, text: 'model = "user-own"' }],
        baseVsTheirs: [{ kind: 'del', beforeNo: 1, afterNo: null, text: 'model = "user-own"' }],
        guidance: '请手工合并后重试。',
      },
    },
  }
  const outcome = conn.classifyActivation({ status: 409, data: body })
  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.writes, false)
  assert.equal(outcome.code, 'agent_child_modified')
  assert.equal(outcome.threeWay.available, true)
  assert.match(outcome.threeWay.guidance, /手工合并/)
  // 静态断言：源码含子代理冲突文案，且没有"自动覆盖"成功话术。
  const src = readFileSync(fileURLToPath(new URL('../../../src/ui-next/js/views/connections.js', import.meta.url)), 'utf8')
  assert.match(src, /agent_child/)
  assert.doesNotMatch(src, /自动覆盖你的改动|自动合并并覆盖/)
})

test('200 回执：准确投影验证/网关状态与退出恢复所需 sha', () => {
  const receipt = {
    ok: true, changed: true, sha: 'd'.repeat(64), mode: 'aggregated',
    agentChild: { action: 'create', managed: true },
    verification: { ok: true, config: { sha256: 'd'.repeat(64) }, catalog: { state: 'present', modelCount: 12 }, gateway: { status: 200 } },
    reload: { applied: true, needsRestart: false, reason: null },
  }
  const outcome = conn.classifyActivation({ status: 200, data: receipt })
  assert.equal(outcome.kind, 'applied')
  const s = conn.receiptSummary(outcome.receipt)
  assert.equal(s.reloadApplied, true)
  assert.equal(s.needsRestart, false)
  assert.equal(s.catalogCount, 12)
  assert.equal(s.gatewayStatus, 200)
  assert.equal(conn.buildDeactivateRequest(receipt.sha).expectedSha, receipt.sha)
  assert.deepEqual(conn.buildDeactivateRequest(''), {}, '无 sha 时不伪造退出请求')
})

test('接入向导无假成功按钮、无静默付费模型调用（源码约束）', () => {
  const dir = new URL('../../../src/ui-next/js/views/', import.meta.url)
  for (const name of ['connections.js', 'aggregation.js']) {
    const src = readFileSync(fileURLToPath(new URL(name, dir)), 'utf8')
    assert.doesNotMatch(src, /innerHTML/, name + ' 不得使用 innerHTML')
    assert.doesNotMatch(src, /modelTest\([^)]*\)\s*;/, name + ' 不得在渲染/加载时静默调用付费模型测试')
  }
})
