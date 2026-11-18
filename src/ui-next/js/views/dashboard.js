// 首页（UX-01）：状态驱动的"下一步"，不渲染开发者仪表盘。
//
// 数据只来自 ProductStatus 投影（docs/contracts/ui-v3-product-status.md §2/§5）：
//   * 正常集成由 A3 的 store.productStatus() 提供；也可由 ctx.product() 注入（测试/组合用）。
//   * 拿不到投影时降级为"正在读取真实状态"，绝不把未知画成已连接/已启用/0 个模型。
//   * 累计请求、错误、Token、P95、趋势、会话与上游分布已迁移到「监控与诊断」，本页只留一行入口。
import { h } from '../dom.js'
import * as store from '../store.js'
import { api } from '../api.js'
import { dirtyDraft } from '../config-draft.js'
import { pageHead, card, callout, tag, metric, empty, table, lineChart, donutChart, statusTag } from '../components.js'
import { fmtInt, fmtCompact, fmtTime, fmtClock, fmtPct } from '../format.js'

// 旧套件（ui-state.test.mjs）依赖的错误率纯函数，保持原语义。
export function errorRateText (g) {
  const requests = g ? Number(g.requests) : NaN
  if (!Number.isFinite(requests) || requests <= 0) return '未知（无请求计数）'
  const errors = Number(g.errors)
  if (!Number.isFinite(errors) || errors < 0) return '未知（错误计数缺失）'
  return '错误率 ' + (errors / requests * 100).toFixed(1) + '%'
}

// 面向用户只出现"DeepSeek V4.1 Flash"，不要求理解公共/上游模型 ID（见 Lead 更正 1）。
export const GO_MODEL_DISPLAY = 'DeepSeek V4.1 Flash'

// 证据等级中文映射（契约 §2）：检测到 ≠ 已配置 ≠ 已实测；只有 runtime-verified 才是绿色。
export const EVIDENCE_TAG_LABELS = Object.freeze({
  detected: '已检测',
  configured: '已配置',
  'runtime-verified': '已实测',
  'not-tested': '未实测',
  unknown: '未知',
})

export const HOME_TECH_METRICS_ROUTE = '#/observability'

const OVERALL_TAGS = Object.freeze({
  ready: ['可正常使用', 'good'],
  action: ['需要操作', 'warn'],
  error: ['需要处理', 'bad'],
  unknown: ['状态未知', 'muted'],
  locked: ['已锁定', 'muted'],
  loading: ['读取中', 'muted'],
})

// 证据徽章只显示"比状态本身多出来的信息"：
//   detected 只说明"探测到了存在性"，不是可用结论，因此不再单独出徽章；
//   任何"待…/需要…/未知"状态都不并排 已检测/已配置/已实测，避免被读成"可以用了"。
const PENDING_LABEL = /^(待|需要|未检测到|未找到|无法|状态未知)/
export function evidenceBadge (level, item) {
  const label = String((item && item.label) || '')
  if (level === 'detected') return null
  if (level === 'unknown') return tag(EVIDENCE_TAG_LABELS.unknown, 'muted')
  if (PENDING_LABEL.test(label)) return null
  if (level === 'configured') return tag(EVIDENCE_TAG_LABELS.configured, 'accent')
  if (level === 'runtime-verified') return tag(EVIDENCE_TAG_LABELS['runtime-verified'], 'good')
  if (level === 'not-tested') return tag(EVIDENCE_TAG_LABELS['not-tested'], 'muted')
  return null
}

function stateKind (key, item) {
  const state = item && item.state
  if (key === 'official') {
    if (state === 'detected') return 'info'
    if (state === 'blocked') return 'warn'
    return 'muted'
  }
  if (key === 'go') {
    if (state === 'verified') return 'good'
    if (state === 'configured') return 'info'
    if (state === 'error') return 'bad'
    if (item && item.credentialPresent) return 'info'
    return 'muted'
  }
  if (key === 'codex') {
    if (!item || item.found !== true) return 'muted'
    if (item.restartNeeded === true) return 'warn'
    return 'info'
  }
  return 'muted'
}

function officialDetail (official) {
  if (official && typeof official.detail === 'string' && official.detail) return official.detail
  return '没有取得登录探测结果；请刷新后重试。'
}

// Go 文案不复用 product.go.detail 中的"不显示为已验证/0 个模型"等否定句，避免歧义。
function goDetail (go) {
  const item = go || {}
  const supported = item.supported !== false
  if (item.state === 'verified') {
    return '已完成一次命中 ' + GO_MODEL_DISPLAY + ' 的真实请求，可用于原版 Codex。'
  }
  if (item.state === 'error') {
    return '已保存 Go 供应商，但最近一次同步失败。请更新 Key 或重试同步；失败不会当作成功。'
  }
  if (item.level === 'configured') {
    return item.targetModelConfigured
      ? 'Key 与目标模型 ' + GO_MODEL_DISPLAY + ' 均已保存；还没有真实推理证据。'
      : 'Key 已保存；目标模型 ' + GO_MODEL_DISPLAY + ' 还没有配置到目录中，请继续完成接入。'
  }
  if (item.state === 'unknown' || !supported) {
    return '当前实例没有聚合管理接口（404），无法判断 Go 连接状态；请确认 ModelGate 版本。'
  }
  if (item.label === '状态未知') {
    return '聚合管理接口拒绝了本次读取（权限/来源），无法确认 Go 连接状态。'
  }
  if (!item.credentialPresent) {
    return '还没有接入 OpenCode Go；填入 API Key 即可自动配置 ' + GO_MODEL_DISPLAY + '。'
  }
  if (item.targetModelConfigured) {
    return '还没有取得 Go 的真实推理证据；请刷新或查看高级诊断。'
  }
  return '还没有配置 ' + GO_MODEL_DISPLAY + '；请继续完成接入。'
}

function codexDetail (codex) {
  const item = codex || {}
  if (!item.found) {
    return item.detail || '没有检测到原版 Codex Desktop；请确认安装路径，或到高级诊断查看探测结果。'
  }
  if (item.restartNeeded === true) {
    return '配置已保存，但客户端仍在用写入前启动的配置。请完全退出 Codex Desktop（不是只关窗口）再重新打开。'
  }
  if (item.restartNeeded === false) {
    return '检测到客户端在写入后启动过，新配置已加载；请在模型选择器里核对官方模型与 ' + GO_MODEL_DISPLAY + '。'
  }
  return '检测到原版 Codex；没有取得重启判定，请按需完全退出并重新打开。'
}

function aggregationDetail (agg) {
  const item = agg || {}
  if (item.supported === false) {
    return '当前实例没有聚合管理接口（404）；这是版本不兼容，不是聚合开关的问题。请确认 ModelGate 版本。'
  }
  if (item.mode === 'aggregated') {
    const backup = item.backupAvailable === true
      ? '已有可恢复备份。'
      : item.backupAvailable === false
        ? '未发现可恢复备份。'
        : '备份状态未知。'
    const restart = item.needsRestart === true ? '需要重新打开 Codex 后才生效。' : ''
    return 'Codex 配置已指向 ModelGate；官方 GPT 与 ' + GO_MODEL_DISPLAY + ' 都通过原版 Codex 使用。' + backup + restart
  }
  if (item.mode === 'route') {
    const restart = item.needsRestart === true ? '请完全退出并重新打开 Codex 才能使用新模式（退出后也要重启）。' : ''
    return 'Codex 配置走纯 DeepSeek 路由，不发起 GPT 调用。' + restart
  }
  if (item.mode === 'official') {
    return '当前是官方直连模式，不经 ModelGate，使用 Codex 官方默认配置。'
  }
  if (item.drifted === true) return '检测到配置漂移，请重新检测；不显示成直连。'
  return '没有取得可识别的接入方式；请刷新重试或查看高级诊断。'
}

function overallTag (overall) {
  const preset = OVERALL_TAGS[overall && overall.level] || OVERALL_TAGS.unknown
  return tag(preset[0], preset[1])
}

// ① 总体结论：label + detail + 结论标签。
export function buildOverall (product) {
  if (!product) {
    return [callout('info',
      h('strong', { text: '正在读取真实状态。' }),
      ' 取得只读快照前，本页不给出任何连接成功结论。')]
  }
  const overall = product.overall || {}
  return [h('section', {
    class: 'card overall-card' + (overall.level ? ' is-' + overall.level : ''),
    'data-overall': overall.level || 'unknown',
  },
  h('div', { class: 'card-body' },
    h('div', { class: 'home-overall-top' },
      h('p', { class: 'eyebrow', text: '总体状态' }),
      overallTag(overall)),
    h('h2', { class: 'home-overall-title', text: overall.label || '状态未知' }),
    h('p', { class: 'home-overall-detail', text: overall.detail || '没有取得总体结论。' })))]
}

// 行结构：名称独立一行；状态值、模型名、说明各自成行并允许换行（360px 不出现半截模型名）。
function statusRow ({ key, title, item, detail, level, model }) {
  const badge = evidenceBadge(level || (item && item.level), item)
  return h('div', { class: 'status-row is-' + stateKind(key, item), 'data-status': key, role: 'group' },
    h('div', { class: 'status-row-main' },
      h('span', { class: 'status-row-label', text: title }),
      h('span', { class: 'status-row-value', text: (item && item.label) || '状态未知' }),
      model ? h('span', { class: 'status-row-detail home-status-model', text: model }) : null,
      h('p', { class: 'status-row-detail', text: detail })),
    badge ? h('div', { class: 'home-status-tags' }, badge) : null)
}

// ② 三条连接状态行：ChatGPT 套餐 / OpenCode Go / Codex Desktop，每行都带证据等级。
export function buildStatusRows (product) {
  if (!product) return []
  const official = product.official || {}
  const go = product.go || {}
  const codex = product.codex || {}
  return [
    statusRow({
      key: 'official',
      title: 'ChatGPT 套餐',
      item: official,
      detail: officialDetail(official),
      level: official.level,
    }),
    statusRow({
      key: 'go',
      title: 'OpenCode Go',
      item: go,
      detail: goDetail(go),
      level: go.level,
      model: GO_MODEL_DISPLAY,
    }),
    statusRow({
      key: 'codex',
      title: 'Codex Desktop',
      item: codex,
      detail: codexDetail(codex),
      level: codex.detectionLevel || codex.level,
    }),
  ]
}

export function buildAggregationCard (product) {
  const agg = (product && product.aggregation) || {}
  const modeText = agg.mode === 'aggregated' ? '聚合（GPT 父 + DeepSeek 子）'
    : agg.mode === 'route' ? '路由（纯 DeepSeek，无 GPT）'
      : agg.mode === 'official' ? '官方直连（不经 ModelGate）'
        : '状态未知'
  const modeKind = agg.mode === 'aggregated' ? 'good' : agg.mode === 'route' ? 'info' : agg.mode === 'official' ? 'muted' : 'warn'
  return card('接入方式', '只用用户能理解的方式描述当前接入方式与可恢复性。',
    h('div', { class: 'list' },
      h('div', { class: 'list-row', 'data-status': 'aggregation' },
        h('div', { class: 'grow' },
          h('div', { class: 'primary', text: agg.label || '状态未知' }),
          h('div', { class: 'secondary', text: aggregationDetail(agg) })),
        h('div', { class: 'flex' }, tag(modeText, modeKind)))))
}

function refreshProduct (ctx) {
  if (ctx && typeof ctx.refreshProduct === 'function') {
    Promise.resolve(ctx.refreshProduct()).catch(() => {})
    return
  }
  if (typeof store.refreshProduct === 'function') {
    Promise.resolve(store.refreshProduct({ reason: 'home-primary' })).catch(() => {})
    return
  }
  const button = document.getElementById('refresh')
  if (button && typeof button.click === 'function') { button.click(); return }
  if (typeof location !== 'undefined' && location && typeof location.reload === 'function') location.reload()
}

function runAction (action, ctx) {
  const kind = action && action.kind
  if (kind === 'retry' || kind === 'reload') { refreshProduct(ctx); return }
  if (kind === 'wait') return
  if (action && action.route) location.hash = action.route
}

// ④ 唯一主 CTA + ⑤ 不抢主操作的次级入口。
export function buildPrimaryAction (product, ctx = {}) {
  const p = product || {}
  const primary = p.primary || { id: 'wait', label: '正在读取状态…', kind: 'wait', detail: '' }
  const button = h('button', {
    class: 'btn btn-primary btn-lg primary-action-button',
    type: 'button',
    'data-primary-cta': primary.id || 'primary',
    text: primary.label,
  })
  if (primary.kind === 'wait') button.disabled = true
  button.addEventListener('click', () => runAction(primary, ctx))
  const secondary = Array.isArray(p.secondary) ? p.secondary : []
  const secondaryButtons = secondary.map((action) => {
    const b = h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      'data-secondary-cta': action.id || '',
      text: action.label,
    })
    b.addEventListener('click', () => runAction(action, ctx))
    return b
  })
  return [h('section', { class: 'home-cta', 'aria-label': '下一步操作' },
    h('div', { class: 'primary-action' },
      button,
      primary.detail ? h('p', { class: 'primary-action-detail', text: primary.detail }) : null),
    secondaryButtons.length ? h('div', { class: 'home-cta-secondary' }, secondaryButtons) : null)]
}

// 技术指标入口：一行指向监控与诊断，不在首页重复渲染长表。
export function buildTechMetricsNote () {
  return h('p', { class: 'home-tech-note' },
    '技术指标已移至「', h('a', { href: HOME_TECH_METRICS_ROUTE, text: '监控与诊断' }), '」。')
}

function resolveProduct (ctx) {
  if (ctx && typeof ctx.product === 'function') {
    try { return ctx.product() || null } catch { return null }
  }
  if (ctx && ctx.product) return ctx.product
  if (store && typeof store.productStatus === 'function') {
    try { return store.productStatus() || null } catch { return null }
  }
  if (store && store.state && store.state.product) return store.state.product
  return null
}

// 旧首页（状态落地页）保留为独立视图函数：状态机/证据等级/CTA 顺序的契约测试仍针对它。
// 导航「用量」现在由下方的 render() 渲染真实图表页。
export function renderHome (root, ctx = {}) {
  const product = resolveProduct(ctx)
  const loading = !product || product.state === 'loading'
  const locked = !!(product && product.state === 'locked')

  root.append(pageHead('一切模型，尽在掌控。', '先确认三项连接状态；本页只保留结论和下一步，技术指标在「监控与诊断」。', {
    eyebrow: 'MODELGATE / 首页',
  }))
  root.append(...buildOverall(product))

  // 只读视图给出准确原因：管理面无令牌，403 只来自来源/Host/Origin 校验。
  if (product && product.state === 'needs_admin_token') {
    const reason = product.readOnlyReason || {}
    root.append(callout('info', h('strong', { text: '当前为只读视图。' }),
      ' 聚合管理接口返回 403' + (reason.code ? '（' + reason.code + '）' : '') +
      '，因此这里既不读取也不写入聚合配置；Codex 侧已经生效的配置不受影响。' +
      '请确认从本机回环访问，且 Host/Origin 通过校验；管理面无令牌。'))
  }

  if (product && !loading && !locked) {
    // 主操作紧跟总体结论：360×800 / 768×900 首屏可见，不靠缩小字号或隐藏状态行。
    root.append(...buildPrimaryAction(product, ctx))
    root.append(card('连接状态', '证据等级来自只读快照：检测到不等于已实测。', h('div', { class: 'home-status-list' }, buildStatusRows(product))))
    root.append(buildAggregationCard(product))
  } else if (product) {
    root.append(...buildPrimaryAction(product, ctx))
  }

  root.append(buildTechMetricsNote())
}

// ============================================================
// 用量页：导航「用量」→ overview → dashboard.render()
// 数字只来自 /api/model-stats（桶）、/api/native-usage（原生汇总）与 /api/status。
// 空窗口出空态；环比只在能由真实桶算出时才显示；没有单请求耗时就不画耗时数字。
// ============================================================

export const USAGE_RANGES = Object.freeze([
  { id: '24h', days: 1, label: '最近 24 小时' },
  { id: '7d', days: 7, label: '最近 7 天' },
  { id: '30d', days: 30, label: '最近 30 天' },
])

const usage = {
  range: '24h',
  days: 1,
  provider: '',
  model: '',
  stats: null,
  native: null,
  loadedDays: 0,
  loadingDays: 0,
  error: '',
}

// 仅测试/诊断用：当前筛选窗口的只读副本。
export function usageState () { return Object.assign({}, usage) }

function injected (ctx, key) {
  if (!ctx || ctx[key] === undefined) return undefined
  return typeof ctx[key] === 'function' ? ctx[key](usage.days) : ctx[key]
}

function ensureUsage (ctx) {
  const s = injected(ctx, 'modelStats')
  const n = injected(ctx, 'nativeUsage')
  if (s !== undefined) usage.stats = s
  if (n !== undefined) usage.native = n
  if (s !== undefined && n !== undefined) { usage.loadedDays = usage.days; return }
  if (usage.loadedDays !== usage.days && usage.loadingDays !== usage.days) loadUsage(ctx)
}

// 用量数据到达后的重绘必须尊重编辑态：弹窗/草稿打开时绝不重建视图。
function safeRerender (ctx) {
  if (!ctx || typeof ctx.rerender !== 'function') return
  try {
    const dialogRoot = document.getElementById('dialog-root')
    if (dialogRoot && !dialogRoot.hidden && (dialogRoot.firstElementChild || dialogRoot.firstChild)) return
    if (document.getElementById('dirty-top')) return
    if (dirtyDraft()) return
  } catch {}
  ctx.rerender()
}

async function loadUsage (ctx) {
  const days = usage.days
  // 测试注入的数据不需要、也不应发任何管理 API 请求。
  if (injected(ctx, 'modelStats') !== undefined && injected(ctx, 'nativeUsage') !== undefined) return
  usage.loadingDays = days
  usage.error = ''
  try {
    const [stats, native] = await Promise.all([api.modelStats(days), api.nativeUsage(days)])
    if (usage.days !== days) return // 旧窗口响应丢弃，不回写当前视图
    usage.stats = stats
    usage.native = native
  } catch (e) {
    if (usage.days !== days) return
    usage.error = e && e.message ? e.message : '读取用量失败'
  } finally {
    if (usage.loadingDays === days) usage.loadingDays = 0
    // 标记本窗口已尝试，失败也只重绘一次，不再循环拉取。
    usage.loadedDays = days
    if (usage.days === days && ctx) safeRerender(ctx)
  }
}

function setUsageRange (ctx, id) {
  const range = USAGE_RANGES.find((r) => r.id === id)
  if (!range || usage.days === range.days) return
  usage.range = range.id
  usage.days = range.days
  usage.provider = ''
  usage.model = ''
  usage.loadedDays = 0
  usage.error = ''
  if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
  ensureUsage(ctx)
}

function providerLabel (provider) {
  const id = String((provider && (provider.id || provider.name)) || '')
  if (/official|chatgpt|openai/i.test(id)) return 'ChatGPT 官方'
  if (/opencodego|opencode-go|go/i.test(id)) return 'OpenCode Go'
  return id || '其他'
}

function bucketTime (date, index) {
  const d = String(date || '')
  if (/^\d{2}:00$/.test(d)) {
    const t = Date.parse('2000-01-01T' + d + ':00')
    if (Number.isFinite(t)) return t
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const t = Date.parse(d + 'T00:00:00')
    if (Number.isFinite(t)) return t
  }
  return index // 日期缺失时按桶序号排，绝不编造时间文案
}

// 把 model-stats 的模型桶按同一索引合并成时间序列；onlyNames 用于模型筛选。
export function usageBuckets (stats, onlyNames) {
  const models = (stats && stats.models) || {}
  const names = Array.isArray(onlyNames) ? onlyNames : Object.keys(models)
  if (!names.length) return []
  const length = Math.max(...names.map((n) => (Array.isArray(models[n]) ? models[n].length : 0)))
  const out = []
  for (let i = 0; i < length; i++) {
    const row = { date: '', t: 0, tokens: 0, inTokens: 0, outTokens: 0, hit: 0, miss: 0, requests: 0 }
    for (const name of names) {
      const list = Array.isArray(models[name]) ? models[name] : []
      const b = list[i] || {}
      if (!row.date && b.date) row.date = String(b.date)
      row.tokens += Number(b.tokens) || 0
      row.inTokens += Number(b.inTokens) || 0
      row.outTokens += Number(b.outTokens) || 0
      row.hit += Number(b.hit) || 0
      row.miss += Number(b.miss) || 0
    }
    row.requests = row.hit + row.miss
    row.t = bucketTime(row.date, i)
    out.push(row)
  }
  return out
}

// 环比：同一窗口前后半段的真实桶求和对比；算不出（缺段/前段为 0）时返回 null，不显示箭头。
export function usageDelta (current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null
  const pct = (current - previous) / previous * 100
  if (!Number.isFinite(pct)) return null
  return (pct >= 0 ? '↑ +' : '↓ ') + pct.toFixed(1) + '%'
}

function halfDelta (buckets, key) {
  if (!Array.isArray(buckets) || buckets.length < 2) return null
  const mid = Math.floor(buckets.length / 2)
  let first = 0, second = 0
  buckets.forEach((b, i) => { const v = Number(b && b[key]) || 0; if (i < mid) first += v; else second += v })
  return usageDelta(second, first)
}

export function usageMetrics (status, buckets) {
  const list = Array.isArray(buckets) ? buckets : []
  const sum = (key) => list.reduce((n, b) => n + (Number(b && b[key]) || 0), 0)
  const g = (status && status.global) || {}
  const requests = Number(g.requests)
  const errors = Number(g.errors)
  const success = Number.isFinite(requests) && requests > 0 && Number.isFinite(errors) && errors >= 0
    ? Math.max(0, (requests - errors) / requests * 100)
    : null
  return {
    requests: sum('requests'),
    inTokens: sum('inTokens'),
    outTokens: sum('outTokens'),
    success,
    globalRequests: Number.isFinite(requests) ? requests : 0,
    globalErrors: Number.isFinite(errors) ? errors : 0,
  }
}

// Provider 分布优先用 status.providers[].st.requests；没有时退回 native-usage.byModel 的 token（并标注单位）。
export function usageProviderSegments (status, native) {
  const out = []
  for (const p of (Array.isArray(status && status.providers) ? status.providers : [])) {
    const v = Number(p && p.st && p.st.requests)
    if (Number.isFinite(v) && v > 0) out.push({ id: String(p.id || p.name || ''), label: providerLabel(p), value: v, unit: 'request' })
  }
  if (!out.length) {
    const totals = new Map()
    for (const row of (Array.isArray(native && native.byModel) ? native.byModel : [])) {
      const id = String((row && row.provider) || 'unknown')
      totals.set(id, (totals.get(id) || 0) + (Number(row && row.totalTokens) || 0))
    }
    for (const [id, v] of totals) if (v > 0) out.push({ id, label: providerLabel({ id }), value: v, unit: 'token' })
  }
  return out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
}

function filteredNames (stats, native, provider, model) {
  const models = (stats && stats.models) || {}
  let names = Object.keys(models)
  if (model) names = names.filter((n) => n === model)
  if (provider) {
    const mapping = new Map()
    for (const row of (Array.isArray(native && native.byModel) ? native.byModel : [])) {
      if (row && row.model && row.provider) mapping.set(String(row.model), String(row.provider))
    }
    if (mapping.size) names = names.filter((n) => mapping.get(n) === provider || providerLabel({ id: mapping.get(n) }) === providerLabel({ id: provider }))
  }
  return names
}

function usageControls (ctx, status) {
  const rangeButtons = USAGE_RANGES.map((r) => h('button', {
    class: 'usage-seg' + (r.id === usage.range ? ' is-active' : ''),
    type: 'button',
    'aria-pressed': r.id === usage.range ? 'true' : 'false',
    text: r.label,
    onclick: () => setUsageRange(ctx, r.id),
  }))

  const providerIds = new Set()
  const segments = usageProviderSegments(status, usage.native)
  for (const seg of segments) providerIds.add(seg.id)
  for (const p of (Array.isArray(status.providers) ? status.providers : [])) if (p && p.id) providerIds.add(String(p.id))
  const providerSelect = h('select', { id: 'usage-provider', class: 'usage-select', 'aria-label': '筛选 Provider' }, [
    h('option', { value: '', selected: !usage.provider, text: '全部 Provider' }),
    ...[...providerIds].map((id) => h('option', { value: id, selected: usage.provider === id, text: providerLabel({ id }) })),
  ])
  providerSelect.addEventListener('change', () => { usage.provider = providerSelect.value; if (ctx && typeof ctx.rerender === 'function') ctx.rerender() })

  const modelNames = Object.keys((usage.stats && usage.stats.models) || {})
  const modelSelect = h('select', { id: 'usage-model', class: 'usage-select', 'aria-label': '筛选模型' }, [
    h('option', { value: '', selected: !usage.model, text: '全部模型' }),
    ...modelNames.map((name) => h('option', { value: name, selected: usage.model === name, text: name })),
  ])
  modelSelect.addEventListener('change', () => { usage.model = modelSelect.value; if (ctx && typeof ctx.rerender === 'function') ctx.rerender() })

  return h('div', { class: 'usage-controls' },
    h('div', { class: 'usage-segmented', role: 'group', 'aria-label': '时间范围' }, rangeButtons),
    h('div', { class: 'usage-filters' }, providerSelect, modelSelect))
}

function metricGlyph (index) { return ['💬', '▤', '▤', '◷'][index] || '●' }

function usageMetricRow (status, buckets) {
  const m = usageMetrics(status, buckets)
  const items = [
    { label: '请求数', value: m.requests > 0 ? fmtInt(m.requests) : '—', delta: halfDelta(buckets, 'requests'), sub: '选定窗口真实桶' },
    { label: '输入 Token', value: m.inTokens > 0 ? fmtCompact(m.inTokens) : '—', delta: halfDelta(buckets, 'inTokens'), sub: '选定窗口真实桶' },
    { label: '输出 Token', value: m.outTokens > 0 ? fmtCompact(m.outTokens) : '—', delta: halfDelta(buckets, 'outTokens'), sub: '选定窗口真实桶' },
    { label: '成功率', value: m.success == null ? '—' : m.success.toFixed(1) + '%', delta: null, sub: '全局累计（网关启动以来）' },
  ]
  return h('div', { class: 'usage-metrics' }, items.map((it, i) => h('div', { class: 'usage-metric', 'data-metric': it.label },
    h('div', { class: 'usage-metric-top' },
      h('span', { class: 'usage-metric-label', text: it.label }),
      h('span', { class: 'usage-metric-icon', 'aria-hidden': 'true', text: metricGlyph(i) })),
    h('div', { class: 'usage-metric-value', text: it.value }),
    h('div', { class: 'usage-metric-sub' },
      it.delta ? h('span', { class: 'usage-delta ' + (it.delta.startsWith('↑') ? 'is-up' : 'is-down'), text: it.delta }) : null,
      h('span', { text: it.sub })))))
}

function usageTrendCard (buckets, stats) {
  const points = buckets.map((b) => ({ t: b.t, v: b.requests, date: b.date }))
  const daily = !!(stats && stats.mode === 'daily')
  const axisLabel = daily
    ? (t) => { const d = new Date(t); return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
    : undefined
  const body = (points.length && points.some((p) => p.v > 0))
    ? lineChart(points, { color: '#6d5efc', label: '请求趋势（真实桶）', format: fmtInt, unit: '请求 · ', axisLabel })
    : empty('暂无趋势数据', '该窗口没有真实请求桶；不会用占位点代替。')
  return card('请求趋势', '每个点是一段真实请求数（命中 + 未命中），按选定时间范围聚合。', body, {
    className: 'usage-trend-card',
    foot: '紫色折线为请求数；纵轴刻度随真实峰值自适应。',
  })
}

function usageProviderCard (segments) {
  let list = segments
  if (usage.provider) list = list.filter((x) => x.id === usage.provider || providerLabel({ id: x.id }) === usage.provider)
  const colored = list.map((x, i) => Object.assign({}, x, { color: ['#6d5efc', '#3b82f6', '#94a3b8'][Math.min(i, 2)] }))
  const total = colored.reduce((n, x) => n + x.value, 0)
  const tokenUnit = colored.some((x) => x.unit === 'token')
  const body = donutChart(colored, {
    label: '按 Provider 用量分布',
    centerValue: total > 0 ? fmtCompact(total) : '—',
    centerLabel: tokenUnit ? 'token' : '次请求',
    emptyTitle: '暂无 Provider 用量',
    emptyDesc: '网关未记录上游请求，原生用量采集也未启用。',
  })
  return card('按 Provider 用量', '上游请求数来自 /api/status；无请求时退回原生会话 token 汇总，并标注单位。', body, {
    className: 'usage-donut-card',
  })
}

function usageRecentCard (status) {
  const dialogues = Array.isArray(status && status.dialogues) ? status.dialogues : []
  const rows = dialogues.slice(0, 5).map((d) => ({
    time: fmtTime(d && d.lastAt),
    model: (d && (d.named || d.id)) || '—',
    hitRate: d && d.hitRate,
  }))
  const tableEl = rows.length
    ? table([
      { label: '时间', render: (r) => h('span', { class: 'mono', text: r.time }) },
      { label: '模型', render: (r) => h('span', { text: r.model }) },
      { label: '状态', render: () => tag('✓ 完成', 'good') },
      { label: '耗时', render: () => h('span', { class: 'muted', text: '—' }) },
    ], rows, { compact: true, emptyTitle: '暂无请求记录' })
    : empty('暂无请求记录', '/api/status 的 dialogues 为空；发起真实请求后这里会出现记录。')
  const more = h('a', { class: 'usage-more', href: '#/observability', text: '查看全部 ›' })
  return card('最近请求', '来自 /api/status 的会话记录；网关未导出单请求耗时，故耗时列显示 —。',
    h('div', null, tableEl, more), { className: 'usage-recent-card', actions: more })
}

// 用量页主入口。ctx.modelStats / ctx.nativeUsage / ctx.status 可被测试注入，避免发真实请求。
export function render (root, ctx = {}) {
  const status = injected(ctx, 'status') || (store.state && store.state.status) || {}
  ensureUsage(ctx)
  const stats = usage.stats
  const names = filteredNames(stats, usage.native, usage.provider, usage.model)
  const buckets = usageBuckets(stats, names)
  const segments = usageProviderSegments(status, usage.native)

  root.append(pageHead('用量', '网关真实用量：时间范围、Provider 与模型均可筛选；没有数据的窗口显示空态。', { eyebrow: 'MODELGATE / 用量' }))
  root.append(usageControls(ctx, status))
  if (usage.error) root.append(callout('danger', h('strong', { text: '用量读取失败：' }), usage.error))
  if (!stats || !usage.native) {
    root.append(callout('info', h('strong', { text: '正在读取用量：' }), ' /api/model-stats 与 /api/native-usage 尚未返回；在响应到达前不显示任何数字。'))
  }
  root.append(usageMetricRow(status, buckets))
  root.append(h('div', { class: 'usage-panels' },
    usageTrendCard(buckets, stats),
    usageProviderCard(segments),
    usageRecentCard(status)))
  root.append(h('p', { class: 'page-note', text: '来源：/api/model-stats?days=' + usage.days + ' · /api/native-usage?days=' + usage.days + ' · /api/status。环比取同一窗口前后半段真实桶；单请求耗时未由网关导出，故不显示。' }))
}
