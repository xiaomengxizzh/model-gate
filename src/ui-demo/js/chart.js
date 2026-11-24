import { el, svgEl, clear, emptyState } from './dom.js'
import { bucketLabel, metricOf, metricFormat, metricLabel, niceMax } from './data.js'
import { fmtCompact, fmtInt, fmtPct } from './format.js'

function axisFormat (metric, v) {
  if (metric === 'hitrate') return Math.round(v) + '%'
  return fmtCompact(Math.round(v))
}

function tipText (row, metric) {
  return [
    row.label,
    metricLabel(metric) + ' ' + metricFormat(metric, metricOf(row, metric)),
  ]
}

export function renderChart (host, opts) {
  const { rows, metric, type = 'bar', selected = null, onSelect = () => {} } = opts
  clear(host)
  if (!rows.length) {
    host.append(emptyState('没有时间桶', '该窗口没有可绘制的数据。'))
    return
  }
  const values = rows.map((r) => metricOf(r, metric))
  const finite = values.filter((v) => v != null)
  if (!finite.length) {
    host.append(emptyState('该指标没有可用数据', metric === 'requests'
      ? '当前后端未提供逐桶请求数（旧版 model-stats）；请切换 Token 或缓存命中率。'
      : '该窗口没有这类样本。'))
    return
  }
  const maxValue = Math.max(0, ...finite)
  const max = niceMax(maxValue)
  const W = 820
  const H = 300
  const padL = 60
  const padR = 16
  const padT = 22
  const padB = 42
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const slot = plotW / rows.length
  const baseY = padT + plotH

  const svg = svgEl('svg', {
    viewBox: '0 0 ' + W + ' ' + H,
    role: 'img',
    tabindex: '0',
    'aria-label': '用量图：' + metricLabel(metric) + '，' + rows.length + ' 个时间桶；方向键切换选中',
  })

  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const y = padT + plotH * (1 - ratio)
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'axis-line' }))
    const label = svgEl('text', { x: padL - 8, y: y + 3, class: 'axis-text', 'text-anchor': 'end' })
    label.textContent = axisFormat(metric, max * ratio)
    svg.append(label)
  }

  const validSelected = Number.isInteger(selected) && selected >= 0 && selected < rows.length ? selected : null
  if (validSelected != null) {
    const x = padL + slot * validSelected + slot / 2
    svg.append(svgEl('line', { x1: x, x2: x, y1: padT, y2: baseY, class: 'axis-selected' }))
  }

  if (type === 'line') {
    let segment = []
    const flush = () => {
      if (segment.length > 1) {
        const d = segment.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ')
        svg.append(svgEl('path', { d, class: 'chart-line' }))
        const area = d + ' L' + segment[segment.length - 1].x.toFixed(1) + ' ' + baseY + ' L' + segment[0].x.toFixed(1) + ' ' + baseY + ' Z'
        svg.append(svgEl('path', { d: area, class: 'chart-area' }))
      }
      segment = []
    }
    rows.forEach((row, i) => {
      const v = metricOf(row, metric)
      if (v == null) { flush(); return }
      const x = padL + slot * i + slot / 2
      const y = baseY - (v / max) * plotH
      segment.push({ x, y })
      const dot = svgEl('circle', {
        cx: x.toFixed(1), cy: y.toFixed(1), r: i === validSelected ? 5 : 3,
        class: 'chart-dot' + (i === validSelected ? ' is-selected' : ''),
      })
      svg.append(dot)
    })
    flush()
  } else {
    const barW = Math.max(3, slot * 0.58)
    rows.forEach((row, i) => {
      const v = metricOf(row, metric)
      if (v == null || v <= 0) return
      const h = (v / max) * plotH
      const x = padL + slot * i + (slot - barW) / 2
      svg.append(svgEl('rect', {
        x: x.toFixed(2), y: (baseY - h).toFixed(2), width: barW.toFixed(2), height: Math.max(1, h).toFixed(2),
        class: 'chart-bar' + (i === validSelected ? ' is-selected' : ''),
      }))
    })
  }

  const labelIndexes = rows.length <= 2 ? [0, rows.length - 1] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1]
  const seen = new Set()
  for (const i of labelIndexes) {
    if (seen.has(i)) continue
    seen.add(i)
    const anchor = i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'
    const text = svgEl('text', {
      x: i === 0 ? padL : i === rows.length - 1 ? W - padR : padL + slot * i + slot / 2,
      y: H - 12, class: 'axis-text', 'text-anchor': anchor,
    })
    text.textContent = bucketLabel(rows[i].label)
    svg.append(text)
  }

  const tip = el('div', { class: 'chart-tip', hidden: true, role: 'status' })
  const showTip = (event, i) => {
    const row = rows[i]
    clear(tip)
    const [title, value] = tipText(row, metric)
    tip.append(el('b', { text: title }), el('span', { text: value }))
    if (row.hasRequests) tip.append(el('span', { text: '记账请求 ' + fmtInt(row.requests) }))
    else if (row.unknownRequests) tip.append(el('span', { text: '记账请求 —（历史桶未知）' }))
    if (row.hitRate != null) tip.append(el('span', { text: '缓存命中 ' + fmtPct(row.hitRate) }))
    tip.hidden = false
    const rect = host.getBoundingClientRect()
    const left = Math.max(8, Math.min(event.clientX - rect.left + 14, rect.width - 190))
    const top = Math.max(8, event.clientY - rect.top - 54)
    tip.style.left = left + 'px'
    tip.style.top = top + 'px'
  }
  const hideTip = () => { tip.hidden = true }

  rows.forEach((row, i) => {
    const zone = svgEl('rect', {
      x: (padL + slot * i).toFixed(2), y: padT, width: Math.max(1, slot).toFixed(2), height: plotH,
      class: 'chart-zone',
    })
    zone.addEventListener('mousemove', (event) => showTip(event, i))
    zone.addEventListener('mouseleave', hideTip)
    zone.addEventListener('click', () => onSelect(i))
    svg.append(zone)
  })

  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const current = validSelected == null ? (event.key === 'ArrowRight' ? -1 : rows.length) : validSelected
    const next = Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))
    onSelect(next)
  })
  svg.addEventListener('blur', hideTip)

  host.append(svg, tip)
}
