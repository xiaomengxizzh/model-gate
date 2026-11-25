import { api } from '../api.js'
import { h, button, tag, pageHeader, panel, panelHeader, notice, metric, table, empty, formatNumber, statusStrip, sectionHead, icon } from '../components/index.js'

let days = 7
let busy = false
let metricKind = 'tokens'
let chartStyle = 'bar'
let modelFilter = 'all'

function totals(stats) {
  const result = { tokens: 0, inTokens: 0, outTokens: 0, hit: 0, miss: 0 }
  for (const buckets of Object.values(stats.models || {})) {
    for (const bucket of buckets) {
      result.tokens += Number(bucket.tokens) || 0
      result.inTokens += Number(bucket.inTokens) || 0
      result.outTokens += Number(bucket.outTokens) || 0
      result.hit += Number(bucket.hit) || 0
      result.miss += Number(bucket.miss) || 0
    }
  }
  return result
}

function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}

function exportCsv(stats) {
  const lines = [['日期', '模型', '总 tokens', '输入', '输出', '缓存命中', '未命中'].map(csvCell).join(',')]
  for (const [model, buckets] of Object.entries(stats.models || {})) {
    for (const bucket of buckets) lines.push([bucket.date, model, bucket.tokens, bucket.inTokens, bucket.outTokens, bucket.hit, bucket.miss].map(csvCell).join(','))
  }
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = h('a', { href: url, download: 'modelgate-usage-' + days + 'd.csv' })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function aggregateBuckets(stats, selectedModel) {
  const map = new Map()
  const entries = selectedModel === 'all' ? Object.values(stats.models || {}) : [stats.models?.[selectedModel] || []]
  for (const buckets of entries) for (const bucket of buckets) {
    const key = bucket.date
    const current = map.get(key) || { date: key, tokens: 0, input: 0, output: 0, hit: 0, miss: 0, requests: 0 }
    current.tokens += Number(bucket.tokens) || 0
    current.input += Number(bucket.inTokens) || 0
    current.output += Number(bucket.outTokens) || 0
    current.hit += Number(bucket.hit) || 0
    current.miss += Number(bucket.miss) || 0
    current.requests += Number(bucket.requests) || 0
    map.set(key, current)
  }
  return [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

function svgNode(name, attrs = {}, text = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value))
  if (text) node.textContent = text
  return node
}

function usageChart(buckets, kind, style) {
  const width = 740
  const height = 230
  const left = 54
  const top = 18
  const baseline = 190
  const plotWidth = 660
  const plotHeight = 160
  const values = buckets.map((bucket) => kind === 'cache' ? (bucket.hit + bucket.miss ? 100 * bucket.hit / (bucket.hit + bucket.miss) : 0) : Number(bucket[kind]) || 0)
  const max = Math.max(1, ...values)
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chartsvg', role: 'img', 'aria-label': '真实网关用量趋势' })
  for (let i = 0; i <= 4; i++) {
    const y = baseline - plotHeight * i / 4
    svg.append(svgNode('line', { x1: left, x2: left + plotWidth, y1: y, y2: y, stroke: 'var(--line)' }))
    svg.append(svgNode('text', { x: left - 8, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, kind === 'cache' ? Math.round(max * i / 4) + '%' : formatNumber(Math.round(max * i / 4))))
  }
  const step = plotWidth / Math.max(1, buckets.length)
  const points = []
  buckets.forEach((bucket, index) => {
    const value = values[index]
    const x = left + step * (index + .5)
    const y = baseline - plotHeight * value / max
    points.push(`${x},${y}`)
    if (style === 'bar') svg.append(svgNode('rect', { x: x - step * .28, y, width: step * .56, height: Math.max(1, baseline - y), rx: 2, fill: 'var(--accent)', opacity: .75 }, ''))
    else svg.append(svgNode('circle', { cx: x, cy: y, r: 3.5, fill: 'var(--accent)' }))
    if (index % Math.max(1, Math.ceil(buckets.length / 7)) === 0 || index === buckets.length - 1) svg.append(svgNode('text', { x, y: 212, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)' }, bucket.date))
  })
  if (style === 'line' && points.length) svg.append(svgNode('polyline', { points: points.join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.4 }))
  return svg
}

export function renderUsage(state, actions) {
  const stats = state.stats
  if (!stats) return h('div', { class: 'page' }, pageHeader('用量分析', '网关请求与原生本地用量分开显示。'), state.errors.stats ? notice('网关用量读取失败', state.errors.stats.message, 'error') : empty('暂无网关用量', '当前没有可读取的统计快照。'))
  const sum = totals(stats)
  const models = Object.keys(stats.models || {})
  const byModel = Object.entries(stats.models || {}).map(([name, buckets]) => ({ name, tokens: buckets.reduce((n, bucket) => n + (Number(bucket.tokens) || 0), 0), input: buckets.reduce((n, bucket) => n + (Number(bucket.inTokens) || 0), 0), output: buckets.reduce((n, bucket) => n + (Number(bucket.outTokens) || 0), 0) })).sort((a, b) => b.tokens - a.tokens)
  const max = Math.max(1, ...byModel.map((item) => item.tokens))
  const buckets = aggregateBuckets(stats, modelFilter)
  const logical = state.usage?.gateway?.logicalRequests
  const attempts = state.usage?.gateway?.upstreamAttempts
  return h('div', { class: 'page content-usage' },
    pageHeader('用量分析', '按来源、时间、供应商和模型聚合；未知费用和剩余额度不推算。',
      h('select', { 'aria-label': '用量时间范围', value: days, disabled: busy, onChange: async (event) => {
        const next = Number(event.target.value)
        if (busy || next === days) return
        busy = true; actions.render()
        try { state.stats = await api.modelStats(next); state.usage = await api.usageSummary(next); days = next; actions.toast('用量范围已更新', 'success') }
        catch (error) { actions.toast(error.message, 'error') }
        finally { busy = false; actions.render() }
      } }, [1, 7, 30, 90].map((value) => h('option', { value, selected: value === days ? true : undefined, text: '最近 ' + value + ' 天' }))),
      button('导出 CSV', () => exportCsv(stats), 'ghost', { disabled: !models.length }, icon('download')),
    ),
    h('div', { class: 'toolbar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': '用量指标' }, [['tokens', 'Token'], ['requests', '记账请求'], ['cache', '缓存命中率']].map(([value, label]) => button(label, () => { metricKind = value; actions.render() }, 'ghost', { class: metricKind === value ? 'active' : '', 'aria-pressed': metricKind === value ? 'true' : 'false' }))),
      h('select', { 'aria-label': '用量模型', value: modelFilter, onChange: (event) => { modelFilter = event.target.value; actions.render() } }, h('option', { value: 'all', text: '全部模型' }), ...models.map((name) => h('option', { value: name, text: name }))),
      h('div', { class: 'seg', role: 'group', 'aria-label': '图表样式' }, [['bar', '柱状'], ['line', '折线']].map(([value, label]) => button(label, () => { chartStyle = value; actions.render() }, 'ghost', { class: chartStyle === value ? 'active' : '', 'aria-pressed': chartStyle === value ? 'true' : 'false' }))),
    ),
    statusStrip(
      ['统计范围', modelFilter === 'all' ? '全部模型' : modelFilter, 'good'],
      ['时间桶', String(buckets.length), 'good'],
      ['费用 / 套餐额度', '未知 · 不推算', 'warn'],
    ),
    h('div', { class: 'grid g4' },
      metric('总 Token', formatNumber(sum.tokens), '输入 ' + formatNumber(sum.inTokens) + ' · 输出 ' + formatNumber(sum.outTokens)),
      metric('逻辑请求', logical == null ? '未读取' : formatNumber(logical), '上游尝试 ' + (attempts == null ? '未读取' : formatNumber(attempts))),
      metric('缓存命中率', sum.hit + sum.miss ? (100 * sum.hit / (sum.hit + sum.miss)).toFixed(1) + '%' : '未读取', '命中 ' + formatNumber(sum.hit) + ' / 未命中 ' + formatNumber(sum.miss)),
      metric('统计天数', String(days), '后端真实分桶'),
    ),
    h('div', { class: 'grid g2 mt' },
      panel(null,
        panelHeader('用量趋势', '同一筛选范围下的真实网关时间桶。', tag(metricKind === 'cache' ? '缓存命中率' : metricKind === 'requests' ? '记账请求' : 'Token', 'accent')),
        buckets.length ? usageChart(buckets, metricKind, chartStyle) : empty('暂无时间桶', '空数据不显示为调用成功。'),
        h('div', { class: 'legend' }, h('span', {}, h('i'), '网关代理流量 · 真实记录')),
      ),
      panel('模型分布', byModel.length ? h('div', { class: 'timeline' }, byModel.map((item) => h('div', { class: 'timeline-row' }, h('div', { class: 'small' }, h('div', { style: { overflowWrap: 'anywhere' }, text: item.name }), h('div', { class: 'numeric muted', text: formatNumber(item.tokens) })), h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: (item.tokens / max * 100) + '%' } }))))) : empty('暂无模型用量', '空数据不显示为调用成功。')),
    ),
    sectionHead('模型用量明细'),
    panel(null, byModel.length ? table([{ label: '模型' }, { label: '总 tokens', numeric: true }, { label: '输入', numeric: true }, { label: '输出', numeric: true }], byModel.map((item) => [item.name, formatNumber(item.tokens), formatNumber(item.input), formatNumber(item.output)]), { label: '按模型用量' }) : empty('暂无模型用量', '后端尚未返回模型分桶。')),
    h('div', { class: 'grid g2 mt' },
      panel('Codex 原生本地用量', state.native && !state.native.enabled ? h('p', { class: 'muted', text: state.native.reason || state.native.note || '默认关闭；未读取会话日志。' }) : state.errors.native ? notice('原生用量读取失败', state.errors.native.message, 'error') : state.native ? h('div', {}, h('p', { class: 'numeric', text: formatNumber(state.native.totals.totalTokens) + ' tokens' }), h('p', { class: 'muted small', text: '本地会话采集，不代表经过 ModelGate 的代理流量。' })) : empty('未读取原生用量', '后端未返回原生用量状态。')),
      panel('统计边界', notice('真实口径', '当前后端按真实模型分桶，尚未完整聚合虚拟模型/模型池/应用维度；逻辑请求与上游尝试的统一对账在 A6。', 'warn')),
    ),
  )
}
