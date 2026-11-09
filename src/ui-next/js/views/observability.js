// 监控与诊断：全部指标来自真实 API；派生分类显式标注，不生成占位数据。
import { h, clear } from '../dom.js'
import { state, loadStatus } from '../store.js'
import { api } from '../api.js'
import { pageHead, card, metric, tag, statusTag, callout, empty, table, tabs, lineChart, barChart, copyButton, toast } from '../components.js'
import { fmtInt, fmtCompact, fmtMs, fmtPct, fmtTime, fmtAgo, fmtDuration, safeHost } from '../format.js'

const DAY_OPTIONS = [
  { id: '1', label: '今天' },
  { id: '7', label: '7 天' },
  { id: '30', label: '30 天' },
  { id: '90', label: '90 天' },
]

const view = {
  days: 7,
  chartModel: '',
  lines: 500,
  filter: '',
  stats: { key: '', loading: false, data: null, error: '', at: 0 },
  logs: { key: '', loading: false, lines: [], error: '', at: 0 },
}
let statsSeq = 0
let logsSeq = 0

function daysLabel(days) {
  if (days === 1) return '今天（按小时）'
  return '最近 ' + days + ' 天'
}

function resetStats() {
  statsSeq += 1
  view.stats = { key: '', loading: false, data: null, error: '', at: 0 }
}
function resetLogs() {
  logsSeq += 1
  view.logs = { key: '', loading: false, lines: [], error: '', at: 0 }
}

async function loadStats(ctx) {
  const seq = ++statsSeq
  view.stats.key = String(view.days)
  view.stats.loading = true
  view.stats.error = ''
  try {
    const data = await api.modelStats(view.days)
    if (seq !== statsSeq) return
    view.stats.data = data
    view.stats.at = Date.now()
  } catch (e) {
    if (seq !== statsSeq) return
    view.stats.error = e && e.message ? e.message : '读取失败'
    view.stats.at = Date.now()
  } finally {
    if (seq === statsSeq) {
      view.stats.loading = false
      if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
    }
  }
}

async function loadLogs(ctx) {
  const seq = ++logsSeq
  view.logs.key = String(view.lines)
  view.logs.loading = true
  view.logs.error = ''
  try {
    const data = await api.logs(view.lines)
    if (seq !== logsSeq) return
    const list = data && Array.isArray(data.lines) ? data.lines : []
    view.logs.lines = list.map((l) => String(l))
    view.logs.at = Date.now()
  } catch (e) {
    if (seq !== logsSeq) return
    view.logs.error = e && e.message ? e.message : '读取失败'
    view.logs.at = Date.now()
  } finally {
    if (seq === logsSeq) {
      view.logs.loading = false
      if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
    }
  }
}

function ensureData(ctx) {
  if (!view.stats.loading && view.stats.key !== String(view.days)) loadStats(ctx)
  if (!view.logs.loading && view.logs.key !== String(view.lines)) loadLogs(ctx)
}

function setDays(ctx, days) {
  if (view.days === days) return
  view.days = days
  view.chartModel = ''
  resetStats()
  if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
}

function refreshAll(ctx) {
  return (async () => {
    try {
      await loadStatus()
    } catch (e) {
      toast('状态刷新失败：' + (e && e.message ? e.message : '未知错误'), 'error')
    }
    resetStats()
    resetLogs()
    if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
  })()
}

function retryButton(label, fn) {
  const b = h('button', { class: 'btn', type: 'button', text: label })
  b.addEventListener('click', () => { b.disabled = true; fn() })
  return b
}

function statsMode() {
  const d = view.stats.data
  if (d && d.mode) return String(d.mode)
  return view.days === 1 ? 'hourly' : 'daily'
}

function statsModels() {
  const d = view.stats.data
  if (!d || !d.models || typeof d.models !== 'object') return null
  return d.models
}

function summarizeBuckets(buckets) {
  const list = Array.isArray(buckets) ? buckets : []
  let tokens = 0
  let inTokens = 0
  let outTokens = 0
  let hit = 0
  let miss = 0
  let nonEmpty = 0
  for (const b of list) {
    const t = Number(b && b.tokens) || 0
    tokens += t
    inTokens += Number(b && b.inTokens) || 0
    outTokens += Number(b && b.outTokens) || 0
    hit += Number(b && b.hit) || 0
    miss += Number(b && b.miss) || 0
    if (t > 0) nonEmpty += 1
  }
  return {
    tokens,
    inTokens,
    outTokens,
    hit,
    miss,
    nonEmpty,
    hitRate: hit + miss > 0 ? (hit / (hit + miss)) * 100 : null,
    buckets: list,
  }
}

function bucketPoints(buckets, mode, at) {
  const list = Array.isArray(buckets) ? buckets : []
  const base = Number(at) || Date.now()
  const date = new Date(base)
  const hourAnchor = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime()
  return list.map((b, i) => {
    const label = String((b && b.date) || '')
    const rest = list.length - 1 - i
    let t
    if (mode === 'daily' && /^\d{4}-\d{2}-\d{2}$/.test(label)) {
      const parts = label.split('-').map(Number)
      t = new Date(parts[0], parts[1] - 1, parts[2]).getTime()
    } else if (mode === 'hourly' && /^\d{2}:\d{2}$/.test(label)) {
      t = hourAnchor - rest * 3600 * 1000
    } else {
      t = base - rest * (mode === 'hourly' ? 3600 * 1000 : 86400 * 1000)
    }
    return { t, v: Number(b && b.tokens) || 0, label }
  })
}

function probeCell(probe) {
  if (!probe) return h('div', null, tag('未验证', 'muted'), h('div', { class: 'hint', text: '无探活记录' }))
  const ok = !!probe.ok
  const parts = []
  if (probe.code != null) parts.push('code ' + probe.code)
  if (probe.ms != null) parts.push(probe.ms + ' ms')
  if (probe.at) parts.push(fmtTime(probe.at))
  return h('div', null,
    tag(ok ? 'ok' : '失败', ok ? 'good' : 'bad'),
    h('div', { class: 'hint', text: parts.length ? parts.join(' · ') : '无细节' }))
}

function keyCell(p) {
  const src = p.keySource === 'keys' ? '面板存储' : p.keySource === 'env' ? '环境变量' : p.keySource === 'env-registry' ? '环境·注册表' : ''
  return h('div', null,
    p.hasKey ? tag('已配置', 'good') : tag('缺失', 'warn'),
    h('div', { class: 'hint', text: (p.apiKeyEnv || '未设置变量名') + (src ? ' · ' + src : '') }))
}

function providerCard(providers) {
  const rows = providers.map((p) => {
    const req = Number(p.st && p.st.requests) || 0
    const err = Number(p.st && p.st.errors) || 0
    return {
      raw: p,
      id: p.id,
      api: p.api || 'openai',
      requests: req,
      errors: err,
      retries: Number(p.st && p.st.retries) || 0,
      rate: req > 0 ? (err / req) * 100 : null,
      p95: p.st && p.st.p95,
      state: (p.st && p.st.state) || 'unknown',
      openUntilMs: Number(p.st && p.st.openUntilMs) || 0,
      probe: p.st && p.st.probe ? p.st.probe : null,
    }
  })
  return card('上游健康与请求', '全部来自 /api/status 的真实计数与熔断器状态；本页不发起探活。', table([
    { label: '上游', render: (r) => h('div', null, h('div', { class: 'mono', text: r.id }), h('div', { class: 'hint', text: r.api + ' · ' + safeHost(r.raw.baseUrl) })) },
    { label: '请求', className: 'num', render: (r) => fmtInt(r.requests) },
    { label: '错误', className: 'num', render: (r) => fmtInt(r.errors) },
    { label: '错误率', className: 'num', render: (r) => r.rate == null ? '—' : fmtPct(r.rate) },
    { label: '重试', className: 'num', render: (r) => fmtInt(r.retries) },
    { label: 'P95', className: 'num', render: (r) => fmtMs(r.p95) },
    { label: '熔断状态', render: (r) => h('div', null, statusTag(r.state), r.state === 'open' && r.openUntilMs > 0 ? h('div', { class: 'hint', text: '剩余冷却 ' + fmtDuration(r.openUntilMs) }) : null) },
    { label: '最近探活', render: (r) => probeCell(r.probe) },
    { label: 'Key', render: (r) => keyCell(r.raw) },
  ], rows, { emptyTitle: '尚未配置上游', emptyDesc: '在「上游供应商」添加 Provider 后，这里会出现真实的请求与健康数据。' }), {
    foot: '来源 /api/status · 运行版本 ' + (state.status && state.status.configVersion != null ? state.status.configVersion : '—') + ' · 读取于 ' + (state.loadedAt ? fmtTime(state.loadedAt) : '—'),
  })
}

function buildModelRows(models) {
  const out = []
  for (const [name, buckets] of Object.entries(models)) {
    const list = Array.isArray(buckets) ? buckets : []
    const summary = summarizeBuckets(list)
    let peak = 0
    for (const b of list) peak = Math.max(peak, Number(b && b.tokens) || 0)
    out.push({ name, buckets: list, summary, peak })
  }
  out.sort((a, b) => b.summary.tokens - a.summary.tokens || a.name.localeCompare(b.name))
  return out
}

function chartBlock(rows, mode, ctx) {
  const withData = rows.filter((r) => r.summary.tokens > 0)
  if (!withData.length) return callout('info', '该窗口没有 Token 记录，无法绘制真实趋势；不会用占位点代替。')
  const top = withData.slice(0, 8)
  let chosen = top[0].name
  if (view.chartModel && withData.some((r) => r.name === view.chartModel)) chosen = view.chartModel
  const row = withData.find((r) => r.name === chosen) || top[0]
  const points = bucketPoints(row.buckets, mode, view.stats.at)
  const select = h('select', { id: 'obs-chart-model' }, top.map((r) => h('option', { value: r.name, selected: r.name === row.name, text: r.name + '（' + fmtCompact(r.summary.tokens) + ' token）' })))
  select.addEventListener('change', () => { view.chartModel = select.value; if (ctx && typeof ctx.rerender === 'function') ctx.rerender() })
  const chart = mode === 'hourly'
    ? lineChart(points, { label: '按小时的 Token 趋势', format: fmtCompact, unit: 'Token ' })
    : barChart(points, { label: '按天的 Token 分布', title: (p) => String(p.label || '') + ' · ' + fmtCompact(p.v) + ' token' })
  const first = points.length ? (points[0].label || '—') : '—'
  const last = points.length ? (points[points.length - 1].label || '—') : '—'
  return h('div', null,
    h('div', { class: 'field', style: { maxWidth: '460px' } },
      h('label', { for: 'obs-chart-model', text: '图表模型（按窗口 Token 降序，前 8 个）' }),
      select),
    chart,
    h('p', { class: 'hint', text: (mode === 'hourly' ? '每桶 1 小时，按接口返回顺序对齐到最近 24 小时' : '每桶 1 天') + '（首桶 ' + first + ' → 末桶 ' + last + '）；纵轴为桶内真实 Token 累计。' }))
}

function statsCard(ctx) {
  const mode = statsMode()
  const models = statsModels()
  const foot = '来源 /api/model-stats?days=' + view.days + ' · mode=' + mode + ' · 读取于 ' + (view.stats.at ? fmtTime(view.stats.at) : '—')
  let body
  if (view.stats.error) {
    body = h('div', null,
      callout('danger', h('strong', { text: '读取失败：' }), view.stats.error),
      retryButton('重新读取统计', () => { view.stats.key = ''; view.stats.error = ''; loadStats(ctx); if (ctx && typeof ctx.rerender === 'function') ctx.rerender() }))
  } else if (view.stats.loading && !view.stats.data) {
    body = h('p', { class: 'muted', text: '正在读取 /api/model-stats?days=' + view.days + '…' })
  } else if (!models) {
    body = h('p', { class: 'muted', text: '正在读取 /api/model-stats?days=' + view.days + '…' })
  } else {
    const rows = buildModelRows(models)
    if (!rows.length) {
      body = empty('没有模型统计', '后端 /api/model-stats 未返回任何模型桶；请确认模型目录非空。')
    } else {
      const columns = [
        { label: '模型', render: (r) => h('span', { class: 'mono', text: r.name }) },
        { label: 'Token', className: 'num', render: (r) => fmtCompact(r.summary.tokens) },
        { label: '输入', className: 'num', render: (r) => fmtCompact(r.summary.inTokens) },
        { label: '输出', className: 'num', render: (r) => fmtCompact(r.summary.outTokens) },
        { label: '命中率', className: 'num', render: (r) => r.summary.hitRate == null ? '—' : fmtPct(r.summary.hitRate) },
        { label: '分桶', render: (r) => h('div', null, h('div', { text: r.buckets.length + ' × ' + (mode === 'hourly' ? '1 小时' : '1 天') }), h('div', { class: 'hint', text: '非空 ' + r.summary.nonEmpty + ' 桶 · 峰值 ' + fmtCompact(r.peak) })) },
      ]
      body = h('div', null,
        chartBlock(rows, mode, ctx),
        h('div', { style: { marginTop: '14px' } }, table(columns, rows, { emptyTitle: '没有模型统计' })))
    }
  }
  return card('模型用量 · ' + daysLabel(view.days), '按模型聚合 /api/model-stats 的真实桶；没有记录的桶保持为 0，不补点、不推测。', body, { foot })
}

function logLevel(line) {
  const m = /^\[[^\]]*\]\s+\[(info|warn|error)\]/i.exec(line)
  return m ? m[1].toLowerCase() : 'unknown'
}

function levelTags(lines) {
  const counts = { info: 0, warn: 0, error: 0, unknown: 0 }
  for (const l of lines) counts[logLevel(l)] += 1
  return [
    tag('info ' + counts.info, 'info'),
    tag('warn ' + counts.warn, 'warn'),
    tag('error ' + counts.error, 'bad'),
    tag('未分类 ' + counts.unknown, 'muted'),
  ]
}

function filteredLines() {
  const q = view.filter.trim().toLowerCase()
  if (!q) return view.logs.lines
  return view.logs.lines.filter((l) => l.toLowerCase().includes(q))
}

function logsInteractive(ctx) {
  const lineSelect = h('select', { id: 'obs-log-lines', style: { maxWidth: '140px' } }, [250, 500, 1000].map((n) => h('option', { value: String(n), selected: n === view.lines, text: n + ' 行' })))
  lineSelect.addEventListener('change', () => {
    view.lines = Number(lineSelect.value)
    view.logs.key = ''
    view.logs.lines = []
    view.logs.at = 0
    if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
  })
  const filterInput = h('input', { type: 'search', id: 'obs-log-filter', placeholder: '按消息文本筛选（不区分大小写）…', value: view.filter, style: { flex: '1', minWidth: '220px' } })
  const metaHost = h('div', { class: 'toolbar', style: { marginBottom: '6px' } })
  const preHost = h('div')
  const draw = () => {
    const visible = filteredLines()
    clear(metaHost)
    metaHost.append(
      h('span', { class: 'hint', text: '窗口 ' + view.logs.lines.length + ' 行 · 可见 ' + visible.length + ' 行' }),
      ...levelTags(visible),
      copyButton(visible.join('\n'), '复制可见日志'))
    clear(preHost)
    if (!visible.length) {
      preHost.append(empty('筛选没有匹配', '换一个关键词或清空筛选；筛选只作用于已加载窗口。'))
      return
    }
    preHost.append(h('pre', { class: 'code', style: { maxHeight: '420px', whiteSpace: 'pre-wrap' }, text: visible.join('\n') }))
  }
  filterInput.addEventListener('input', () => { view.filter = filterInput.value; draw() })
  draw()
  return h('div', null,
    h('div', { class: 'toolbar' }, lineSelect, h('span', { class: 'spacer' }), h('span', { class: 'hint', text: '日志窗口来自 /api/logs 尾部，非全量检索' })),
    h('div', { class: 'toolbar' }, filterInput),
    metaHost,
    preHost,
    callout('warn', h('strong', { text: '分享前请审阅：' }), '日志可能包含业务元数据（模型名、路径、错误体片段等）；复制或截图前请自行确认不含敏感信息。'))
}

function logsCard(ctx) {
  let body
  if (view.logs.error) {
    body = h('div', null,
      callout('danger', h('strong', { text: '读取日志失败：' }), view.logs.error),
      retryButton('重新读取日志', () => { view.logs.key = ''; view.logs.error = ''; loadLogs(ctx); if (ctx && typeof ctx.rerender === 'function') ctx.rerender() }))
  } else if (view.logs.loading && !view.logs.lines.length) {
    body = h('p', { class: 'muted', text: '正在读取 /api/logs?lines=' + view.lines + '…' })
  } else if (!view.logs.lines.length) {
    body = empty('日志窗口为空', '/api/logs 返回 0 行；日志文件可能尚未生成或为空。')
  } else {
    body = logsInteractive(ctx)
  }
  return card('日志窗口', '来自 /api/logs 的尾部 N 行，不是全量检索；筛选只作用于已加载窗口。', body, {
    foot: '来源 /api/logs?lines=' + view.lines + ' · 读取于 ' + (view.logs.at ? fmtTime(view.logs.at) : '—'),
  })
}

function failureCounts(lines) {
  const count = (re) => {
    let n = 0
    for (const l of lines) if (re.test(l)) n += 1
    return n
  }
  return {
    r429: count(/\b429\b/),
    timeout: count(/ETIMEDOUT|timeout|timed out|\b504\b/i),
    server5xx: count(/\b5\d{2}\b/),
    circuit: count(/熔断|circuit|half-open/i),
  }
}

function failureCard() {
  const lines = view.logs.lines
  const foot = '基于 /api/logs 已加载窗口 · 读取于 ' + (view.logs.at ? fmtTime(view.logs.at) : '—')
  if (view.logs.error) {
    return card('失败分类（派生）', '从当前日志窗口派生，不是持久化分类指标；后端暂无按状态码持久化的统计 API。', callout('danger', h('strong', { text: '无法派生：' }), view.logs.error), { foot })
  }
  if (!lines.length) {
    const body = view.logs.loading
      ? h('p', { class: 'muted', text: '正在读取日志窗口…' })
      : empty('暂无日志窗口', '需要先成功读取 /api/logs 才能派生分类计数。')
    return card('失败分类（派生）', '从当前日志窗口派生，不是持久化分类指标；后端暂无按状态码持久化的统计 API。', body, { foot })
  }
  const c = failureCounts(lines)
  const rows = [
    { label: '429', rule: '行内出现独立数字 429', count: c.r429, kind: 'warn' },
    { label: '超时', rule: 'ETIMEDOUT / timeout / timed out / 504', count: c.timeout, kind: 'warn' },
    { label: '5xx', rule: '行内出现独立的 500–599 数字', count: c.server5xx, kind: 'bad' },
    { label: '熔断', rule: '熔断 / circuit / half-open', count: c.circuit, kind: 'bad' },
  ]
  return card('失败分类（派生）', '从当前日志窗口派生，不是持久化分类指标；后端暂无按状态码持久化的统计 API。', h('div', null,
    table([
      { label: '分类', render: (r) => tag(r.label, r.kind) },
      { label: '判定', render: (r) => h('span', { class: 'muted', text: r.rule }) },
      { label: '行数', className: 'num', render: (r) => fmtInt(r.count) },
    ], rows),
    callout('warn', h('strong', { text: '口径：' }), '窗口 ' + lines.length + ' 行，未应用上方筛选；分类是文本匹配启发式（不是结构化状态码解析），可能误记正文中的数字；同一行可能命中多个类别（例如 504 同时计入超时与 5xx），计数不互斥，不可相加当作总失败数。')), { foot })
}

function routingCard(s, dialogues) {
  const last = s.lastServing
  const body = h('div', null,
    last
      ? callout('good', h('strong', { text: last.model || '—' }), ' → ', h('span', { class: 'mono', text: last.provider || '—' }), ' · ', h('span', { class: 'muted', text: fmtAgo(last.at) + '（' + fmtTime(last.at) + '）' }))
      : callout('info', '还没有完成过模型请求。发起第一个请求后，这里才会出现真实路由结果。'),
    dialogues.length
      ? table([
        { label: '会话', render: (d) => h('span', { class: 'mono', text: d.named || d.id || '匿名' }) },
        { label: '请求', className: 'num', render: (d) => fmtInt(d.requests) },
        { label: 'Token', className: 'num', render: (d) => fmtCompact(d.tokens) },
        { label: '命中率', className: 'num', render: (d) => d.hitRate == null ? '—' : fmtPct(d.hitRate) },
        { label: '最近', render: (d) => h('span', { class: 'muted', text: fmtAgo(d.lastAt) }) },
      ], dialogues.slice(0, 10), { emptyTitle: '暂无会话记录' })
      : empty('暂无会话记录', '/api/status 的 dialogues 为空。'))
  return card('最近路由与会话', '最后一次真实完成的模型路由；会话指标来自 /api/status', body, {
    foot: '来源 /api/status · lastServing 与 dialogues · 读取于 ' + (state.loadedAt ? fmtTime(state.loadedAt) : '—'),
  })
}

export function render(root, ctx = {}) {
  const s = state.status || {}
  const g = s.global || {}
  const providers = Array.isArray(s.providers) ? s.providers : []
  const dialogues = Array.isArray(s.dialogues) ? s.dialogues : []

  const range = tabs(DAY_OPTIONS, String(view.days), (id) => setDays(ctx, Number(id)))
  range.style.marginBottom = '0'
  const refreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新' })
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.disabled) return
    refreshBtn.disabled = true
    refreshBtn.textContent = '刷新中…'
    try {
      await refreshAll(ctx)
    } finally {
      refreshBtn.disabled = false
      refreshBtn.textContent = '刷新'
    }
  })

  root.append(pageHead('监控与诊断', '真实运行指标、模型用量与日志窗口。所有数字来自网关 API；派生分类会标注口径，缺失数据保持空状态。', {
    eyebrow: 'OBSERVABILITY',
    actions: [range, refreshBtn],
  }))

  root.append(h('p', { class: 'page-note', text: '状态快照 ' + (state.loadedAt ? fmtTime(state.loadedAt) : '—') + ' · 统计窗口 ' + (view.stats.at ? fmtTime(view.stats.at) : '未读取') + ' · 日志窗口 ' + (view.logs.at ? fmtTime(view.logs.at) : '未读取') }))

  root.append(h('div', { class: 'grid grid-3' },
    metric('累计请求', fmtInt(g.requests), '来源 /api/status · 进程启动以来', 'probe'),
    metric('错误请求', fmtInt(g.errors), '来源 /api/status · 非 2xx 或上游失败', 'warn'),
    metric('重试次数', fmtInt(g.retries), '来源 /api/status · 上游重试计数', 'refresh'),
    metric('中断请求', fmtInt(g.interrupts), '来源 /api/status · 客户端中断/断流', 'x'),
    metric('累计 Token', fmtCompact(g.tokenCount), '来自上游 usage 的真实累计', 'plus'),
    metric('今日 Token', fmtCompact(g.todayTokens), '今日 0 点起，按模型日桶求和', 'plus'),
    metric('平均延迟', fmtMs(g.avgMs), '已确认完成请求样本', 'probe'),
    metric('P50 延迟', fmtMs(g.p50), '已确认完成请求样本', 'probe'),
    metric('P95 延迟', fmtMs(g.p95), '已确认完成请求样本', 'probe')))

  root.append(providerCard(providers))
  root.append(statsCard(ctx))
  root.append(h('div', { class: 'grid grid-main' }, failureCard(), routingCard(s, dialogues)))
  root.append(logsCard(ctx))

  root.append(h('p', { class: 'page-note', text: '数据来源：/api/status、/api/model-stats、/api/logs。本页不触发模型测试或探活；缺失数据会显示空状态，而不是占位数字。' }))

  ensureData(ctx)
}
