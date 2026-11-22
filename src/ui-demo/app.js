// ModelGate 简约演示：零依赖、只读、单页。
// 数据只来自 /api/status、/api/model-stats、/api/aggregation/health、/api/logs。
// 字段缺失时显式降级，绝不把缓存 token 当请求数、也不把未知画成 0。

const state = {
  days: 1,
  status: null,
  stats: null,
  health: null,
  logs: [],
  errors: { status: '', stats: '', health: '', logs: '' },
  loading: false,
  updatedAt: null,
  seq: 0,
}

const MODE_LABELS = { official: '官方直连', route: '纯路由', aggregated: '聚合' }
const DAY_LABELS = { 1: '24 小时', 7: '7 天', 30: '30 天' }

const $ = (sel, root = document) => root.querySelector(sel)
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children) {
    if (child == null) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}
const svgEl = (tag, props = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    node.setAttribute(k, String(v))
  }
  return node
}

const nf = new Intl.NumberFormat('zh-CN')
const cf = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const fmtInt = (v) => (Number.isFinite(v) ? nf.format(v) : '—')
const fmtCompact = (v) => {
  if (!Number.isFinite(v)) return '—'
  return Math.abs(v) < 10000 ? nf.format(v) : cf.format(v)
}
const fmtPct = (v) => (Number.isFinite(v) ? v.toFixed(1) + '%' : '—')
const fmtMs = (v) => (Number.isFinite(v) && v > 0 ? fmtInt(Math.round(v)) + ' ms' : '—')
const fmtClock = (ts) => {
  if (!Number.isFinite(ts)) return '—'
  try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '—' }
}
const fmtDateTime = (ts) => {
  if (!Number.isFinite(ts)) return '—'
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch { return '—' }
}
const fmtDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return d + ' 天 ' + h + ' 小时'
  if (h > 0) return h + ' 小时 ' + m + ' 分'
  return m + ' 分 ' + (total % 60) + ' 秒'
}
const relTime = (ts) => {
  if (!Number.isFinite(ts)) return '—'
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

async function getJson (path, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(path, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = null }
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || (data && data.message) || ('HTTP ' + res.status)
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
      err.status = res.status
      throw err
    }
    if (data === null) throw new Error('响应不是 JSON')
    return data
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（8s）')
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    clearTimeout(timer)
  }
}

function bucketSeries (stats) {
  const models = (stats && stats.models) || {}
  const names = Object.keys(models)
  let length = 0
  for (const n of names) if (Array.isArray(models[n])) length = Math.max(length, models[n].length)
  const rows = []
  for (let i = 0; i < length; i++) {
    const row = { label: '', tokens: 0, inTokens: 0, outTokens: 0, requests: 0, hit: 0, miss: 0, hasRequests: false, unknownRequests: false }
    for (const n of names) {
      const list = Array.isArray(models[n]) ? models[n] : []
      const b = list[i]
      if (!b) continue
      if (!row.label && b.date) row.label = String(b.date)
      row.tokens += num(b.tokens)
      row.inTokens += num(b.inTokens)
      row.outTokens += num(b.outTokens)
      row.hit += num(b.hit)
      row.miss += num(b.miss)
      if (typeof b.requests === 'number') {
        row.requests += b.requests
        row.hasRequests = true
      } else {
        // 升级前的历史桶没有 requests 字段：未知，不是 0。
        row.unknownRequests = true
      }
    }
    rows.push(row)
  }
  return rows
}

function modelRows (stats) {
  const models = (stats && stats.models) || {}
  const out = []
  for (const [name, list] of Object.entries(models)) {
    const agg = { name, tokens: 0, inTokens: 0, outTokens: 0, requests: 0, hit: 0, miss: 0, hasRequests: false, unknownRequests: false }
    for (const b of (Array.isArray(list) ? list : [])) {
      agg.tokens += num(b.tokens)
      agg.inTokens += num(b.inTokens)
      agg.outTokens += num(b.outTokens)
      agg.hit += num(b.hit)
      agg.miss += num(b.miss)
      if (typeof b.requests === 'number') {
        agg.requests += b.requests
        agg.hasRequests = true
      } else {
        agg.unknownRequests = true
      }
    }
    out.push(agg)
  }
  return out.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.name.localeCompare(b.name))
}

function chart (rows) {
  const wrap = $('#chart-wrap')
  const points = rows.filter((r) => r.tokens > 0)
  if (!rows.length || !points.length) {
    wrap.replaceChildren(el('div', { class: 'chart-empty', text: '该窗口没有用量记录；网关不会用占位数据代替空桶。' }))
    return
  }
  const W = 760
  const H = 248
  const padL = 56
  const padR = 10
  const padT = 16
  const padB = 30
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const max = Math.max(...rows.map((r) => r.tokens), 1)
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '本窗口 Token 用量柱状图，共 ' + rows.length + ' 个时间桶' })

  for (const ratio of [0, 0.5, 1]) {
    const y = padT + plotH * (1 - ratio)
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'axis-line' }))
    const label = svgEl('text', { x: padL - 8, y: y + 3, class: 'axis-text', 'text-anchor': 'end' })
    label.textContent = fmtCompact(Math.round(max * ratio))
    svg.append(label)
  }

  const slot = plotW / rows.length
  const barW = Math.max(3, slot * 0.62)
  rows.forEach((r, i) => {
    const h = r.tokens > 0 ? Math.max(2, (r.tokens / max) * plotH) : 0
    const x = padL + slot * i + (slot - barW) / 2
    const y = padT + plotH - h
    const rect = svgEl('rect', {
      x: x.toFixed(2), y: y.toFixed(2), width: barW.toFixed(2), height: h.toFixed(2),
      class: 'bar', 'data-zero': h === 0 ? 'true' : 'false',
      tabindex: '0', role: 'img',
      'aria-label': r.label + '：' + fmtInt(r.tokens) + ' Token' + (r.hasRequests ? '，' + fmtInt(r.requests) + ' 次请求' : ''),
    })
    const title = svgEl('title')
    title.textContent = r.label + ' · ' + fmtInt(r.tokens) + ' Token' + (r.hasRequests ? ' · ' + fmtInt(r.requests) + ' 请求' : '')
    rect.append(title)
    svg.append(rect)
  })

  const axisY = padT + plotH + 15
  const axisLabel = (x, text, anchor) => {
    const t = svgEl('text', { x, y: axisY, class: 'axis-text', 'text-anchor': anchor })
    t.textContent = text
    return t
  }
  const short = (label) => {
    if (/^\d{2}:00$/.test(label)) return label
    if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return label.slice(5)
    return label
  }
  svg.append(axisLabel(padL, short(rows[0].label), 'start'))
  if (rows.length > 2) svg.append(axisLabel(W / 2, short(rows[Math.floor(rows.length / 2)].label), 'middle'))
  svg.append(axisLabel(W - padR, short(rows[rows.length - 1].label), 'end'))
  wrap.replaceChildren(svg)
}

function toneOfState (s) {
  if (s === 'ok' || s === 'closed') return 'ok'
  if (s === 'open') return 'err'
  if (s === 'half' || s === 'half-open') return 'warn'
  return 'muted'
}
function stateLabel (s) {
  return ({ ok: '正常', closed: '正常', open: '熔断', half: '半开', 'half-open': '半开' })[s] || (s ? String(s) : '未知')
}

function fillProviders () {
  const table = $('#providers-table')
  const panel = $('#providers-panel')
  const head = $('thead', table)
  const body = $('tbody', table)
  head.replaceChildren(el('tr', {},
    el('th', { scope: 'col', text: '上游' }),
    el('th', { scope: 'col', text: '状态' }),
    el('th', { scope: 'col', text: 'Key' }),
    el('th', { scope: 'col', class: 'num', text: '尝试' }),
    el('th', { scope: 'col', class: 'num', text: '错误' }),
    el('th', { scope: 'col', class: 'num', text: 'P95' }),
  ))
  if (state.errors.status) {
    body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: '6', text: '读取 /api/status 失败：' + state.errors.status })))
    panel.setAttribute('aria-busy', 'false')
    return
  }
  const providers = (state.status && Array.isArray(state.status.providers)) ? state.status.providers : []
  if (!providers.length) {
    body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: '6', text: '没有已配置的上游。' })))
  } else {
    body.replaceChildren(...providers.map((p) => {
      const st = p.st || {}
      return el('tr', {},
        el('td', {}, el('span', { class: 'cell-name', text: p.id || '—' }), el('span', { class: 'cell-sub', text: p.baseUrl || '' })),
        el('td', {}, el('span', { class: 'badge', 'data-tone': toneOfState(st.state), text: stateLabel(st.state) })),
        el('td', {}, el('span', { class: 'badge', 'data-tone': p.hasKey ? 'info' : 'warn', text: p.hasKey ? '已配置' : '缺失' })),
        el('td', { class: 'num', text: fmtInt(st.requests) }),
        el('td', { class: 'num', text: fmtInt(st.errors) }),
        el('td', { class: 'num', text: fmtMs(st.p95) }),
      )
    }))
  }
  panel.setAttribute('aria-busy', 'false')
}

function fillModels () {
  const table = $('#models-table')
  const panel = $('#models-panel')
  const body = $('tbody', table)
  const head = $('thead', table)
  head.replaceChildren(el('tr', {},
    el('th', { scope: 'col', text: '模型' }),
    el('th', { scope: 'col', text: '上游' }),
    el('th', { scope: 'col', class: 'num', text: '记账请求' }),
    el('th', { scope: 'col', class: 'num', text: 'Token' }),
    el('th', { scope: 'col', class: 'num', text: '缓存命中' }),
  ))
  if (state.errors.stats) {
    body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: '5', text: '读取 /api/model-stats 失败：' + state.errors.stats })))
    panel.setAttribute('aria-busy', 'false')
    return
  }
  const defs = new Map(((state.status && state.status.models) || []).map((m) => [m.name, m]))
  const rows = modelRows(state.stats).slice(0, 8)
  if (!rows.length) {
    body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: '5', text: '该窗口没有模型用量。' })))
  } else {
    body.replaceChildren(...rows.map((r) => {
      const def = defs.get(r.name) || {}
      const hitRate = r.hit + r.miss > 0 ? (r.hit / (r.hit + r.miss)) * 100 : null
      return el('tr', { class: r.tokens > 0 || r.requests > 0 ? '' : 'is-zero' },
        el('td', {}, el('span', { class: 'cell-name', text: r.name }), el('span', { class: 'cell-sub', text: def.capability || def.effectiveApi || '' })),
        el('td', { class: 'mono', text: def.provider || '—' }),
        el('td', { class: 'num', text: r.hasRequests ? fmtInt(r.requests) : '—', title: r.unknownRequests ? '部分历史桶没有请求计数（升级前数据）' : null }),
        el('td', { class: 'num', text: fmtCompact(r.tokens) }),
        el('td', { class: 'num', text: fmtPct(hitRate) }),
      )
    }))
  }
  panel.setAttribute('aria-busy', 'false')
}

function fillRecent () {
  const panel = $('#recent-panel')
  const last = (state.status && state.status.lastServing) || null
  $('#last-model').textContent = (last && last.model) || '—'
  $('#last-meta').textContent = last
    ? (last.provider || '未知上游') + ' · ' + fmtDateTime(last.at) + '（' + relTime(last.at) + '）'
    : '没有最近一次服务记录。'
  const logEl = $('#log-tail')
  if (state.errors.logs) logEl.textContent = '读取 /api/logs 失败：' + state.errors.logs
  else if (!state.logs.length) logEl.textContent = '日志为空。'
  else logEl.textContent = state.logs.join('\n')
  panel.setAttribute('aria-busy', 'false')
}

function fillTable (buckets) {
  const table = $('#bucket-table')
  const head = $('thead', table)
  const body = $('tbody', table)
  const hasReq = buckets.some((b) => b.hasRequests)
  const cols = ['时间'].concat(hasReq ? ['记账请求'] : [], ['Token', '输出 Token', '缓存命中率'])
  head.replaceChildren(el('tr', {}, ...cols.map((c, i) => el('th', { scope: 'col', class: i > 0 ? 'num' : '', text: c }))))
  if (!buckets.length) {
    body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: String(cols.length), text: '没有时间桶。' })))
    return
  }
  body.replaceChildren(...buckets.map((b) => {
    const hitRate = b.hit + b.miss > 0 ? (b.hit / (b.hit + b.miss)) * 100 : null
    const cells = [el('td', { class: 'mono', text: b.label || '—' })]
    if (hasReq) cells.push(el('td', { class: 'num', text: b.hasRequests ? fmtInt(b.requests) : '—', title: b.unknownRequests ? '该桶早于请求计数字段，未知' : null }))
    cells.push(el('td', { class: 'num', text: fmtInt(b.tokens) }))
    cells.push(el('td', { class: 'num', text: fmtInt(b.outTokens) }))
    cells.push(el('td', { class: 'num', text: fmtPct(hitRate) }))
    return el('tr', {}, ...cells)
  }))
}

function renderUsage () {
  const panel = $('#usage-panel')
  const side = {
    tokens: $('#usage-tokens'),
    requests: $('#usage-requests'),
    hitrate: $('#usage-hitrate'),
    out: $('#usage-out'),
    note: $('#usage-note'),
  }
  if (state.errors.stats) {
    panel.setAttribute('aria-busy', 'false')
    $('#chart-wrap').replaceChildren(el('div', { class: 'chart-empty', text: '读取用量失败：' + state.errors.stats }))
    for (const key of ['tokens', 'requests', 'hitrate', 'out']) side[key].textContent = '—'
    side.note.hidden = false
    side.note.textContent = '不会用旧数据或占位数字顶替失败窗口。'
    return
  }
  if (!state.stats) {
    panel.setAttribute('aria-busy', 'true')
    $('#chart-wrap').replaceChildren(el('div', { class: 'chart-empty', text: '读取中…' }))
    return
  }
  const buckets = bucketSeries(state.stats)
  const hasReq = buckets.some((b) => b.hasRequests)
  const totals = buckets.reduce((acc, b) => {
    acc.tokens += b.tokens
    acc.out += b.outTokens
    acc.hit += b.hit
    acc.miss += b.miss
    if (b.hasRequests) acc.requests += b.requests
    if (b.unknownRequests) acc.unknown += 1
    return acc
  }, { tokens: 0, out: 0, hit: 0, miss: 0, requests: 0, unknown: 0 })
  chart(buckets)
  fillTable(buckets)
  side.tokens.textContent = fmtInt(totals.tokens)
  side.requests.textContent = hasReq ? fmtInt(totals.requests) : '—'
  side.hitrate.textContent = totals.hit + totals.miss > 0 ? fmtPct((totals.hit / (totals.hit + totals.miss)) * 100) : '—'
  side.out.textContent = fmtInt(totals.out)
  if (!hasReq) {
    side.note.hidden = false
    side.note.textContent = '当前后端未提供逐桶请求数（旧版 model-stats）；这里只展示真实 Token，不用缓存 token 冒充请求数。'
  } else if (totals.unknown > 0) {
    side.note.hidden = false
    side.note.textContent = '部分历史桶含升级前数据（无请求计数字段），合计只统计已知桶。'
  } else {
    side.note.hidden = true
  }
  panel.setAttribute('aria-busy', 'false')
}

function renderStats () {
  const s = state.status
  const stats = state.stats
  const buckets = stats ? bucketSeries(stats) : []
  const hit = buckets.reduce((n, b) => n + b.hit, 0)
  const miss = buckets.reduce((n, b) => n + b.miss, 0)
  const set = (key, value, sub, tone) => {
    const card = document.querySelector('.stat[data-k="' + key + '"]')
    if (!card) return
    $('[data-v="' + key + '"]', card).textContent = value
    $('[data-s="' + key + '"]', card).textContent = sub
    if (tone) card.setAttribute('data-tone', tone)
    else card.removeAttribute('data-tone')
  }
  if (!s) {
    for (const key of ['started', 'persisted', 'today', 'hitrate', 'p95', 'errors']) set(key, '—', state.loading ? '读取中' : '读取失败')
    $('#stats').setAttribute('aria-busy', 'false')
    return
  }
  const c = s.counters || {}
  const g = s.global || {}
  set('started', fmtInt(num(c.requests)), '本进程 · 含重试尝试')
  set('persisted', fmtInt(num(g.requests)), '跨重启 · 含重试尝试')
  set('today', fmtCompact(num(g.todayTokens)), '本地日界')
  set('hitrate', hit + miss > 0 ? fmtPct((hit / (hit + miss)) * 100) : '—', '本窗口缓存样本')
  set('p95', fmtMs(num(g.p95)), '持久化样本')
  set('errors', fmtInt(num(c.errors)), '启动以来', num(c.errors) > 0 ? 'err' : '')
  $('#stats').setAttribute('aria-busy', 'false')
}

function renderMeta () {
  const s = state.status
  $('#meta-version').textContent = s ? ('v' + (s.configVersion ?? '—')) : '—'
  $('#meta-uptime').textContent = s ? fmtDuration(num(s.uptimeMs)) : '—'
  $('#meta-updated').textContent = state.updatedAt ? fmtClock(state.updatedAt) : '—'
  const chip = $('#live-chip')
  const text = $('#live-text')
  if (state.errors.status) {
    chip.setAttribute('data-state', 'bad')
    text.textContent = '离线'
  } else if (s) {
    chip.setAttribute('data-state', 'ok')
    text.textContent = '在线'
  } else {
    chip.setAttribute('data-state', 'loading')
    text.textContent = '连接中'
  }
  const modeChip = $('#mode-chip')
  const mode = state.health && state.health.ok !== false ? state.health.mode : null
  if (mode && MODE_LABELS[mode]) {
    modeChip.hidden = false
    modeChip.textContent = '接入 · ' + MODE_LABELS[mode]
  } else {
    modeChip.hidden = true
  }
}

function renderErrors () {
  const banner = $('#error-banner')
  const parts = []
  if (state.errors.status) parts.push('/api/status：' + state.errors.status)
  if (state.errors.stats) parts.push('/api/model-stats：' + state.errors.stats)
  if (state.errors.logs) parts.push('/api/logs：' + state.errors.logs)
  if (!parts.length) {
    banner.hidden = true
    banner.replaceChildren()
    return
  }
  banner.hidden = false
  banner.replaceChildren(
    el('strong', { text: '读取失败：' }),
    document.createTextNode(parts.join('；')),
    el('button', { class: 'btn', type: 'button', onclick: () => loadAll(true) }, '重试'),
  )
}

function renderAll () {
  renderMeta()
  renderStats()
  renderUsage()
  fillProviders()
  fillModels()
  fillRecent()
  renderErrors()
  document.querySelectorAll('.seg').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(num(btn.dataset.days) === state.days))
  })
}

async function loadAll (manual = false) {
  const seq = ++state.seq
  const days = state.days
  const refresh = $('#refresh')
  refresh.disabled = true
  refresh.setAttribute('aria-busy', 'true')
  for (const key of Object.keys(state.errors)) state.errors[key] = ''
  const [status, stats, health, logs] = await Promise.allSettled([
    getJson('/api/status'),
    getJson('/api/model-stats?days=' + days),
    getJson('/api/aggregation/health'),
    getJson('/api/logs?lines=40'),
  ])
  // 旧请求晚到不得覆盖新窗口/新一次刷新。
  if (seq !== state.seq) return
  if (status.status === 'fulfilled') state.status = status.value
  else state.errors.status = status.reason.message
  if (stats.status === 'fulfilled') {
    state.stats = stats.value
  } else {
    state.stats = null
    state.errors.stats = stats.reason.message
  }
  if (health.status === 'fulfilled') {
    state.health = health.value
  } else {
    state.health = null
    // 聚合接口在旧实例上可能不存在；作为可选字段处理，不打断整页。
    if (health.reason && health.reason.status !== 404) state.errors.health = health.reason.message
  }
  if (logs.status === 'fulfilled') state.logs = Array.isArray(logs.value.lines) ? logs.value.lines : []
  else state.errors.logs = logs.reason.message
  state.updatedAt = Date.now()
  refresh.disabled = false
  refresh.removeAttribute('aria-busy')
  renderAll()
  if (manual) {
    const chip = $('#live-text')
    chip.textContent = state.errors.status ? '离线' : '已刷新'
    setTimeout(() => { chip.textContent = state.errors.status ? '离线' : '在线' }, 1200)
  }
}

function setDays (days) {
  if (state.days === days) return
  state.days = days
  state.stats = null
  state.errors.stats = ''
  $('#usage-panel').setAttribute('aria-busy', 'true')
  renderUsage()
  loadAll(false)
}

function initTheme () {
  // ?mode=dark|light 只用于截图/设计验收，不改变正常主题持久化。
  const forced = new URLSearchParams(location.search).get('mode')
  if (forced === 'dark' || forced === 'light') { applyTheme(forced); return }
  let saved = ''
  try { saved = localStorage.getItem('mg-demo-theme') || '' } catch {}
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme(saved === 'dark' || (!saved && prefersDark) ? 'dark' : 'light')
}
function applyTheme (mode) {
  document.documentElement.dataset.mode = mode
  try { localStorage.setItem('mg-demo-theme', mode) } catch {}
  const btn = $('#theme')
  const next = mode === 'dark' ? '浅色' : '深色'
  btn.setAttribute('aria-label', '切换到' + next + '主题')
  btn.title = '切换到' + next + '主题'
}

function init () {
  initTheme()
  $('#theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark')
  })
  $('#refresh').addEventListener('click', () => loadAll(true))
  document.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => setDays(num(btn.dataset.days)))
  })
  loadAll(false)
}

init()