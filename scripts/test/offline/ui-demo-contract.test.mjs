// 交互演示前端的纯函数契约：不启动网关、不依赖真实浏览器。
// 覆盖记账口径（requests 与缓存 token 分离）、三模式请求体/响应分类、设置归一化与 DOM 空值过滤。
import test from 'node:test'
import assert from 'node:assert/strict'

// —— 极简 DOM 桩：只为验证 dom.js 的构造与 null 过滤（不渲染、不执行样式）——
class FakeNode {
  constructor (tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.className = ''; this.listeners = [] }
  append (...kids) { for (const kid of kids) this.children.push(kid) }
  setAttribute (k, v) { this.attrs[k] = v }
  addEventListener (type) { this.listeners.push(type) }
  replaceChildren (...kids) { this.children = kids }
  set textContent (value) { this.children = [{ text: String(value) }] }
  get textContent () {
    return this.children.map((c) => (typeof c === 'string' ? c : c.text != null ? String(c.text) : c.textContent || '')).join('')
  }
}
globalThis.Node = FakeNode
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag),
  createTextNode: (text) => ({ text }),
}

const { el, append } = await import('../../../src/ui-demo/js/dom.js')
const data = await import('../../../src/ui-demo/js/data.js')
const mode = await import('../../../src/ui-demo/js/mode.js')
const settings = await import('../../../src/ui-demo/js/settings.js')
const format = await import('../../../src/ui-demo/js/format.js')

function bucket (date, extra = {}) {
  return Object.assign({ date, tokens: 120, inTokens: 100, outTokens: 20, hit: 60, miss: 40, requests: 1 }, extra)
}

test('demo dom: 空值子节点不会被渲染成 "null" 文本', () => {
  const host = new FakeNode('div')
  append(host, [el('b', { text: 'a' }), null, undefined, false, el('i', { text: 'b' })])
  assert.equal(host.children.length, 2, 'null/undefined/false 必须被丢弃')
  const text = host.children.map((c) => c.textContent).join('')
  assert.equal(text, 'ab')
  assert.ok(!text.includes('null'))

  const node = el('div', {}, null, el('span', { text: 'x' }), null)
  assert.equal(node.textContent, 'x', 'el() 同样过滤空值')
})

test('demo data: 请求数与缓存 token 分属不同量纲', () => {
  const stats = {
    days: 1,
    mode: 'hourly',
    models: {
      a: [bucket('10:00'), bucket('11:00')],
      b: [bucket('10:00', { requests: null, tokens: 0, hit: 0, miss: 0 }), bucket('11:00', { requests: 2 })],
    },
  }
  const rows = data.bucketSeries(stats, ['a', 'b'])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.requests), [1, 3], '数字 requests 求和；null 桶不计入')
  assert.deepEqual(rows.map((r) => r.hit), [60, 120], 'null 桶 hit=0 不污染求和')
  assert.equal(rows[0].hasRequests, true)
  assert.equal(rows[0].unknownRequests, true, '出现 null 桶时标记历史未知')
  assert.equal(rows[0].label, '10:00')

  // 全部为历史桶（只有 tokens/hit/miss）时：请求不可用，不得把 hit+miss 当请求数
  const legacy = data.bucketSeries({ models: { a: [{ date: '2026-11-20', tokens: 10, hit: 6, miss: 4 }] } }, ['a'])
  assert.equal(legacy[0].hasRequests, false)
  assert.equal(legacy[0].requests, 0, '未知不是 0：requests 保持 0 但 hasRequests=false')
  assert.equal(data.metricAvailable(legacy, 'requests'), false)
  assert.equal(data.metricOf(legacy[0], 'hitrate'), 60)
  assert.equal(data.metricOf(legacy[0], 'tokens'), 10)
})

test('demo data: 汇总只统计已知桶并保留未知计数', () => {
  const stats = { models: { a: [bucket('10:00'), bucket('11:00', { requests: null, tokens: 0, hit: 0, miss: 0 })] } }
  const rows = data.bucketSeries(stats, ['a'])
  const { totals, peak } = data.summarize(rows, 'tokens')
  assert.equal(totals.requests, 1, '合计只加已知桶')
  assert.equal(totals.unknownBuckets, 1)
  assert.equal(totals.tokens, 120)
  assert.equal(peak.value, 120)
  assert.equal(data.niceMax(9300), 10000)
  assert.equal(data.niceMax(0), 1)
})

test('demo mode: 快照投影与可用父模型', () => {
  const snap = mode.snapshotOf({
    current: { mode: 'aggregated', parentModel: 'gpt-6.2-sol', childModel: 'mg-opencodego-deepseek-v4-1-flash' },
    previousMode: 'route',
    drifted: false,
    selectableParents: [{ id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', realTest: 'UNVERIFIED' }],
  }, { mode: 'aggregated', needsRestart: true })
  assert.equal(snap.mode, 'aggregated')
  assert.equal(snap.known, true)
  assert.equal(snap.previousMode, 'route')
  assert.equal(snap.needsRestart, true)
  assert.deepEqual(snap.parents.map((p) => p.id), ['gpt-6.2-sol'])
  assert.equal(snap.supported, true)

  const unknown = mode.snapshotOf(null, null)
  assert.equal(unknown.supported, false)
  assert.equal(unknown.known, false, '未知模式不得被当成 official')
})

test('demo mode: 切换/回滚请求体只在确认时携带令牌', () => {
  const preview = { consentToken: 'tok-1', expectedSha: 'sha-1' }
  assert.deepEqual(mode.buildSwitchPreviewBody('route', null), { mode: 'route', consentToken: '', expectedSha: '' })
  assert.deepEqual(mode.buildSwitchConfirmBody(preview, 'aggregated', 'gpt-6.2-sol'), {
    mode: 'aggregated', parentModel: 'gpt-6.2-sol', consentToken: 'tok-1', expectedSha: 'sha-1',
  })
  assert.deepEqual(mode.buildRollbackPreviewBody(), { consentToken: '', expectedSha: '' })
  assert.deepEqual(mode.buildRollbackConfirmBody(preview), { consentToken: 'tok-1', expectedSha: 'sha-1' })
  assert.deepEqual(mode.buildRollbackConfirmBody(null), { consentToken: '', expectedSha: '' })
})

test('demo mode: 响应分类覆盖 428/422/409/404/200', () => {
  assert.equal(mode.classifyModeResponse(428, { code: 'consent_required', preview: { consentToken: 't' } }).kind, 'preview')
  const blocked = mode.classifyModeResponse(422, { code: 'activation_blocked', blocked: [{ code: 'catalog_missing' }] })
  assert.equal(blocked.kind, 'blocked')
  assert.equal(blocked.blocked.length, 1)
  assert.equal(mode.classifyModeResponse(409, { code: 'config_drifted', error: '漂移' }).kind, 'conflict')
  assert.equal(mode.classifyModeResponse(404, { error: 'not found' }).kind, 'unsupported')
  assert.equal(mode.classifyModeResponse(200, { ok: true, mode: 'route' }).kind, 'applied')
  const failed = mode.classifyModeResponse(500, { error: 'boom' })
  assert.equal(failed.kind, 'error')
  assert.equal(failed.message, 'boom')
})

test('demo mode: 预览摘要同时统计逐行差异与字段差异', () => {
  const summary = mode.previewSummary({
    consentToken: 't', expectedSha: 'sha',
    rows: [
      { path: 'model', kind: 'replace', from: '"gpt-6.2-sol"', to: '"mg-opencodego-deepseek-v4-1-flash"' },
      { path: 'service_tier', kind: 'same', from: '"default"', to: '"default"' },
    ],
    changed: [
      { kind: 'del', beforeNo: 1, text: 'model = "gpt-6.2-sol"' },
      { kind: 'add', afterNo: 1, text: 'model = "mg-opencodego-deepseek-v4-1-flash"' },
      { kind: 'same', beforeNo: 2, afterNo: 2, text: 'service_tier = "default"' },
    ],
    conflicts: [{ path: 'model_provider' }],
    beforeSha: 'before', afterSha: 'after',
    blocked: [],
  })
  assert.equal(summary.lineChanges.length, 2)
  assert.equal(summary.addedLines, 1)
  assert.equal(summary.removedLines, 1)
  assert.equal(summary.changeCount, 2, '有逐行差异时以它为准')
  assert.equal(summary.rows.length, 1, '字段级只保留非 same')
  assert.deepEqual(summary.conflicts, ['model_provider'])
  assert.equal(summary.beforeSha, 'before')

  // 字段全 same 但字节有变化（实测 /switch 官方直连）：不能显示成"0 个变更"
  const onlyLines = mode.previewSummary({
    consentToken: 't', rows: [{ path: 'model', kind: 'same' }],
    changed: [{ kind: 'del', beforeNo: 1, text: 'x' }, { kind: 'add', afterNo: 1, text: 'y' }],
  })
  assert.equal(onlyLines.changeCount, 2)
  assert.equal(onlyLines.rows.length, 0)
})

test('demo settings: 非法值回落默认，未知名被忽略，二次确认不可关闭', () => {
  const normalized = settings.normalizeSettings({
    theme: 'neon', density: 'dense', border: 9, radius: 'x', autoRefresh: 7,
    defaultRange: 30, showZeroModels: false, confirmBeforeSwitch: false, injected: 'drop',
  })
  assert.equal(normalized.theme, settings.DEFAULTS.theme)
  assert.equal(normalized.density, settings.DEFAULTS.density)
  assert.equal(normalized.border, settings.DEFAULTS.border)
  assert.equal(normalized.radius, settings.DEFAULTS.radius)
  assert.equal(normalized.autoRefresh, settings.DEFAULTS.autoRefresh)
  assert.equal(normalized.defaultRange, 30, '合法值保留')
  assert.equal(normalized.showZeroModels, false)
  assert.equal(normalized.confirmBeforeSwitch, true, '二次确认固定开启')
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'injected'), false)
})

test('demo settings: applySettings 只写 data-* 属性', () => {
  const root = { dataset: {} }
  settings.applySettings({ theme: 'dark', density: 'compact', border: 3, radius: 8, shadow: 'none' }, root)
  assert.deepEqual(root.dataset, {
    mode: 'dark', density: 'compact', motion: 'auto', border: '3', radius: '8', shadow: 'none',
  })
  const store = new Map()
  const fakeStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
  settings.saveSettings({ theme: 'light' }, fakeStorage)
  assert.equal(settings.loadSettings(fakeStorage).theme, 'light')
  assert.equal(settings.loadSettings({ getItem: () => 'not-json' }).theme, settings.DEFAULTS.theme)
})

test('demo format: 数字与时长格式', () => {
  assert.equal(format.fmtInt(1234567), '1,234,567')
  assert.equal(format.fmtPct(60), '60.0%')
  assert.equal(format.fmtMs(0), '—')
  assert.equal(format.fmtDuration(90061000), '1 天 1 小时')
  assert.equal(format.shortSha('abcdef1234567890zz', true), 'abcdef1234567890…')
})