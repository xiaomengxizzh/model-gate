import { el, clear, callout, emptyState, badge } from './dom.js'
import { fmtInt, fmtCompact, fmtPct } from './format.js'
import { bucketSeries, modelNames, metricAvailable, metricFormat, metricLabel, providerMap, summarize } from './data.js'
import { renderChart } from './chart.js'

const RANGES = [ { value: 1, label: '24 小时' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' } ]
const METRICS = [ { value: 'tokens', label: 'Token' }, { value: 'requests', label: '记账请求' }, { value: 'hitrate', label: '缓存命中率' } ]
const TYPES = [ { value: 'bar', label: '柱状' }, { value: 'line', label: '折线' } ]

function segmented (options, value, onChange, { label, disabledValues = [] } = {}) {
  return el('div', { class: 'segmented', role: 'group', 'aria-label': label || '' },
    options.map((o) => el('button', {
      class: 'seg', type: 'button', 'aria-pressed': String(o.value === value),
      disabled: disabledValues.includes(o.value),
      title: disabledValues.includes(o.value) ? '当前后端没有该字段' : '',
      onclick: () => { if (!disabledValues.includes(o.value)) onChange(o.value) },
    }, o.label)))
}

function selectControl (label, value, options, onChange) {
  const select = el('select', { class: 'select', 'aria-label': label },
    options.map((o) => el('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)))
  select.addEventListener('change', () => onChange(select.value))
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), select)
}

function statCard (label, value, sub) {
  return el('article', { class: 'stat stat-small' },
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: 'stat-value', text: value }),
    el('p', { class: 'stat-sub', text: sub || '' }))
}

function bucketTable (rows, selected, onSelect) {
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col', text: '时间' }),
      el('th', { scope: 'col', class: 'num', text: 'Token' }),
      el('th', { scope: 'col', class: 'num', text: '输出 Token' }),
      el('th', { scope: 'col', class: 'num', text: '记账请求' }),
      el('th', { scope: 'col', class: 'num', text: '缓存命中率' }),
    )),
    el('tbody', {}, ...rows.map((row) => el('tr', {
      class: row.index === selected ? 'is-selected' : '',
      tabindex: '0',
      onclick: () => onSelect(row.index),
      onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.index) } },
    },
    el('td', { class: 'mono', text: row.label || '—' }),
    el('td', { class: 'num', text: fmtInt(row.tokens) }),
    el('td', { class: 'num', text: fmtInt(row.outTokens) }),
    el('td', { class: 'num', text: row.hasRequests ? fmtInt(row.requests) : '—', title: row.unknownRequests ? '历史桶没有请求计数字段' : '' }),
    el('td', { class: 'num', text: fmtPct(row.hitRate) }),
    ))),
  )
  return el('div', { class: 'table-scroll table-tall' }, table)
}

function rowHasMetric (row, metric) {
  if (metric === 'requests') return row.hasRequests ? row.requests : null
  if (metric === 'hitrate') return row.hitRate
  return row.tokens
}

export function renderCharts (host, ctx) {
  const { state, chartState, settings } = ctx
  clear(host)
  const meta = providerMap(state.status)
  const names = modelNames(state.stats, { provider: chartState.provider, model: chartState.model, meta })
  const rows = bucketSeries(state.stats, names)
  const available = {
    tokens: metricAvailable(rows, 'tokens'),
    requests: metricAvailable(rows, 'requests'),
    hitrate: metricAvailable(rows, 'hitrate'),
  }
  const summary = summarize(rows, chartState.metric)
  const selectedRow = Number.isInteger(chartState.selected) ? rows[chartState.selected] : null
  const activeMetric = chartState.metric === 'requests' && !available.requests ? 'tokens' : chartState.metric

  host.append(el('section', { class: 'page-head' },
    el('div', {},
      el('p', { class: 'eyebrow', text: 'CHARTS / 用量' }),
      el('h1', { text: '图表' }),
      el('p', { class: 'lede', text: '选择范围、指标、图表类型和上游/模型；悬停看时间桶，点击或方向键固定选中。' })),
    el('div', { class: 'head-actions' },
      el('span', { class: 'meta-pill', text: '来源 /api/model-stats' }),
      el('button', { class: 'btn', type: 'button', onclick: () => ctx.reloadStats(), text: '刷新数据' }))))

  const filterBar = el('div', { class: 'filter-bar' },
    el('div', { class: 'filter-group' },
      el('span', { class: 'field-label', text: '范围' }),
      segmented(RANGES, chartState.range, (v) => ctx.setChart({ range: v, selected: null }), { label: '时间范围' })),
    el('div', { class: 'filter-group' },
      el('span', { class: 'field-label', text: '指标' }),
      segmented(METRICS, activeMetric, (v) => ctx.setChart({ metric: v, selected: null }), {
        label: '指标',
        disabledValues: available.requests ? [] : ['requests'],
      })),
    el('div', { class: 'filter-group' },
      el('span', { class: 'field-label', text: '类型' }),
      segmented(TYPES, chartState.type, (v) => ctx.setChart({ type: v }), { label: '图表类型' })),
    selectControl('Provider', chartState.provider, [
      { value: '', label: '全部 Provider' },
      ...(Array.isArray(state.status && state.status.providers) ? state.status.providers.map((p) => ({ value: p.id, label: p.id })) : []),
    ], (v) => ctx.setChart({ provider: v, selected: null })),
    selectControl('模型', chartState.model, [
      { value: '', label: '全部模型' },
      ...Object.keys((state.stats && state.stats.models) || {}).map((n) => ({ value: n, label: n })),
    ], (v) => ctx.setChart({ model: v, selected: null })),
    (chartState.provider || chartState.model)
      ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ctx.setChart({ provider: '', model: '', selected: null }), text: '清空筛选' })
      : null,
  )

  const panel = el('section', { class: 'panel chart-panel', 'aria-busy': state.errors.stats ? 'false' : 'true' })
  const chartHead = el('div', { class: 'panel-head' },
    el('div', {},
      el('h2', { text: metricLabel(activeMetric) + ' 用量' }),
      el('p', { class: 'panel-sub', text: '窗口：' + (RANGES.find((r) => r.value === chartState.range) || {}).label + ' · ' + (chartState.type === 'bar' ? '柱状' : '折线') + ' · 真实时间桶' })),
    el('div', { class: 'chart-key' },
      badge(metricLabel(activeMetric), 'accent'),
      el('span', { class: 'muted', text: rows.length + ' 个桶' })))

  const chartWrap = el('div', { class: 'chart-wrap' })
  panel.append(chartHead, chartWrap)

  if (state.errors.stats) {
    chartWrap.append(emptyState('读取用量失败', state.errors.stats))
    panel.append(callout('danger', el('strong', { text: '数据不可用：' }), ' 不会用旧数据或占位数字顶替。'))
  } else if (!state.stats) {
    chartWrap.append(emptyState('读取中…', '等待 /api/model-stats 返回。'))
  } else if (!rows.length) {
    chartWrap.append(emptyState('当前筛选没有数据', '换一个时间范围或清空 Provider/模型筛选。'))
  } else {
    renderChart(chartWrap, {
      rows, metric: activeMetric, type: chartState.type, selected: chartState.selected,
      onSelect: (index) => ctx.setChart({ selected: chartState.selected === index ? null : index }),
    })
  }

  if (!available.requests && state.stats) {
    panel.append(callout('warn', el('strong', { text: '当前后端没有逐桶请求数：' }), ' 记账请求指标已禁用；Token 与缓存命中率仍来自真实桶。'))
  } else if (summary.totals.unknownBuckets > 0) {
    panel.append(callout('warn', el('strong', { text: '部分历史桶没有请求计数：' }), ' 表格显示 —，合计只统计已知桶。'))
  }

  const selectedCard = el('div', { class: 'selected-bucket' },
    el('p', { class: 'side-label', text: '选中的时间桶' }),
    selectedRow
      ? el('div', { class: 'selected-grid' },
        el('div', {}, el('span', { text: '时间' }), el('b', { text: selectedRow.label || '—' })),
        el('div', {}, el('span', { text: metricLabel(activeMetric) }), el('b', { text: metricFormat(activeMetric, rowHasMetric(selectedRow, activeMetric)) })),
        el('div', {}, el('span', { text: 'Token' }), el('b', { text: fmtInt(selectedRow.tokens) })),
        el('div', {}, el('span', { text: '输出' }), el('b', { text: fmtInt(selectedRow.outTokens) })),
        el('div', {}, el('span', { text: '记账请求' }), el('b', { text: selectedRow.hasRequests ? fmtInt(selectedRow.requests) : '—' })),
        el('div', {}, el('span', { text: '缓存命中' }), el('b', { text: fmtPct(selectedRow.hitRate) })),
      )
      : el('p', { class: 'muted', text: '点击柱子/折线点，或用方向键切换；再看这个时间桶的明细。' }))

  const summaryRow = el('div', { class: 'stats stats-4' },
    statCard('本窗口 Token', fmtCompact(summary.totals.tokens), '输入 ' + fmtCompact(summary.totals.inTokens)),
    statCard('记账请求', summary.totals.hasRequests ? fmtInt(summary.totals.requests) : '—', summary.totals.hasRequests ? '已知桶合计' : '后端未提供'),
    statCard('缓存命中', fmtPct(summary.totals.hitRate), '命中 / (命中+未命中)'),
    statCard('峰值桶', summary.peak ? metricFormat(activeMetric, summary.peak.value) : '—', summary.peak ? summary.peak.label : '无样本'))

  const tablePanel = el('section', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('div', {}, el('h2', { text: '时间桶明细' }), el('p', { class: 'panel-sub', text: '点击行可同步选中图上的桶；表格是图表的文本备份。' }))),
    rows.length ? bucketTable(rows, chartState.selected, (index) => ctx.setChart({ selected: chartState.selected === index ? null : index })) : emptyState('没有时间桶', '该窗口没有数据。'))

  host.append(filterBar, panel, summaryRow, selectedCard, tablePanel)
}