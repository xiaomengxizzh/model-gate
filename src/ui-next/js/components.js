// Reusable, dependency-free UI primitives. All data is inserted as text.
import { h, svg, clear, mount, icon } from './dom.js'
import { fmtNum, fmtInt, fmtCompact, fmtMs, fmtPct, fmtAgo, fmtClock, shortValue } from './format.js'

export function pageHead(title, desc, opts = {}) {
  const left = h('div', null,
    opts.eyebrow ? h('p', { class: 'eyebrow', text: opts.eyebrow }) : null,
    h('h1', { text: title }),
    desc ? h('p', { text: desc }) : null)
  const actions = opts.actions ? h('div', { class: 'page-actions' }, opts.actions) : null
  return h('header', { class: 'page-head' }, left, actions)
}

export function card(title, desc, body, opts = {}) {
  const head = (title || opts.actions) ? h('div', { class: 'card-head' },
    h('div', null, title ? h('h2', { text: title }) : null, desc ? h('p', { text: desc }) : null),
    opts.actions || null) : null
  const bodyEl = h('div', { class: 'card-body' + (opts.flush ? ' flush' : '') }, body)
  const foot = opts.foot ? h('div', { class: 'card-foot' }, opts.foot) : null
  return h('section', { class: 'card' + (opts.className ? ' ' + opts.className : '') }, head, bodyEl, foot)
}

export function metric(label, value, sub, iconName) {
  return h('div', { class: 'metric' },
    h('div', { class: 'metric-top' }, h('span', { text: label }), iconName ? icon(iconName) : null),
    h('div', { class: 'metric-value', text: value }),
    sub ? h('div', { class: 'metric-sub', text: sub }) : null)
}

export function tag(label, kind = 'muted') {
  return h('span', { class: 'tag tag-' + kind }, h('span', { class: 'tag-dot' }), String(label))
}

export function statusTag(value) {
  const map = {
    ok: ['正常', 'good'], healthy: ['正常', 'good'], up: ['在线', 'good'],
    half: ['半开', 'warn'], degraded: ['降级', 'warn'], warn: ['告警', 'warn'],
    open: ['熔断', 'bad'], error: ['异常', 'bad'], failed: ['失败', 'bad'], down: ['不可达', 'bad'],
    unknown: ['未知', 'muted'], untested: ['未测试', 'muted'],
  }
  const [label, kind] = map[String(value)] || ['未知', 'muted']
  return tag(label, kind)
}

export function callout(kind, ...children) {
  const icons = { warn: '!', danger: '×', good: '✓', info: 'i' }
  return h('div', { class: 'callout is-' + kind }, h('span', { class: 'callout-icon', 'aria-hidden': 'true', text: icons[kind] || 'i' }), h('div', null, children))
}

export function empty(title, desc, action) {
  return h('div', { class: 'empty' }, h('span', { class: 'empty-icon', 'aria-hidden': 'true', text: '◌' }), h('strong', { text: title }), desc ? h('span', { text: desc }) : null, action || null)
}

export function table(columns, rows, opts = {}) {
  if (!rows || !rows.length) return empty(opts.emptyTitle || '暂无数据', opts.emptyDesc || '当前接口没有返回记录。', opts.emptyAction)
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.className || '', text: c.label }))))
  const tbody = h('tbody', null, rows.map((row, i) => h('tr', null, columns.map((c) => {
    const value = c.render ? c.render(row, i) : row[c.key]
    return h('td', { class: c.className || '' }, value == null ? '—' : (value.nodeType ? value : String(value)))
  }))))
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, thead, tbody))
}

export function field(label, input, opts = {}) {
  const id = opts.id || ('f-' + Math.random().toString(36).slice(2, 8))
  if (input && input.tagName === 'INPUT' && !input.id) input.id = id
  return h('div', { class: 'field' },
    h('label', { for: input && input.id ? input.id : id, text: label }),
    input,
    opts.help ? h('span', { class: 'field-help', text: opts.help }) : null,
    opts.error ? h('span', { class: 'field-error', text: opts.error }) : null)
}

export function codeBlock(text, opts = {}) {
  const pre = h('pre', { class: 'code', text: String(text == null ? '' : text) })
  if (!opts.copy) return pre
  return h('div', { class: 'code-wrap' }, pre, h('span', { class: 'copy' }, copyButton(text, '复制')))
}

export function copyButton(value, label = '复制') {
  const btn = h('button', { class: 'btn btn-sm', type: 'button', text: label })
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(String(value)) }
    catch {
      const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } })
      ta.value = String(value)
      document.body.append(ta); ta.select()
      try { document.execCommand('copy') } catch {}
      ta.remove()
    }
    toast('已复制到剪贴板', 'success')
  })
  return btn
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts')
  if (!host) return
  const el = h('div', { class: 'toast' + (kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''), role: 'status' }, String(message))
  host.append(el)
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 220) }, kind === 'error' ? 6500 : 3600)
}

let activeDialog = null
export function dialog(opts) {
  const root = document.getElementById('dialog-root')
  if (!root) return null
  if (activeDialog) activeDialog.close()
  const previous = document.activeElement
  const close = () => {
    root.hidden = true
    clear(root)
    if (activeDialog && activeDialog.el === root.firstElementChild) activeDialog = null
    document.removeEventListener('keydown', onKey)
    if (previous && previous.focus) previous.focus()
  }
  const body = h('div', { class: 'dialog-body' }, opts.content)
  const actions = opts.actions ? h('div', { class: 'dialog-foot' }, opts.actions) : null
  const closeBtn = h('button', { class: 'icon-close', type: 'button', 'aria-label': '关闭', text: '×', onclick: close })
  const panel = h('div', { class: 'dialog' + (opts.wide ? ' is-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title' },
    h('div', { class: 'dialog-head' }, h('div', null, h('h2', { id: 'dlg-title', text: opts.title || '' }), opts.desc ? h('p', { text: opts.desc }) : null), closeBtn),
    body, actions)
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key !== 'Tab') return
    const focusables = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    if (!focusables.length) return
    const first = focusables[0], last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
  root.hidden = false
  mount(root, panel)
  root.onclick = (e) => { if (e.target === root) close() }
  document.addEventListener('keydown', onKey)
  const firstInput = panel.querySelector('input, select, textarea, button.btn-primary') || closeBtn
  setTimeout(() => firstInput && firstInput.focus(), 20)
  activeDialog = { el: panel, close }
  return activeDialog
}

export function confirmDialog(opts) {
  return new Promise((resolve) => {
    const cancel = h('button', { class: 'btn', type: 'button', text: opts.cancelLabel || '取消', onclick: () => { d.close(); resolve(false) } })
    const ok = h('button', { class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), type: 'button', text: opts.confirmLabel || '确认', onclick: () => { d.close(); resolve(true) } })
    const d = dialog({ title: opts.title || '请确认', desc: opts.desc, content: h('p', { class: 'muted', text: opts.message || '' }), actions: [cancel, ok] })
  })
}

export function kvList(entries) {
  return h('div', null, entries.map(([k, v]) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v == null ? '—' : (v.nodeType ? v : String(v))))))
}

export function lineChart(points, opts = {}) {
  const data = (Array.isArray(points) ? points : [])
    .map((p) => ({ t: Number(p.t), v: Number(p.v) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t)
  if (data.length < 2 || !data.some((p) => p.v > 0)) {
    return empty('暂无趋势数据', opts.emptyDesc || '网关尚未累积足够的真实样本。')
  }
  const W = 620, H = 190, padL = 8, padR = 8, top = 10, bottom = 160
  const max = Math.max(...data.map((p) => p.v)) * 1.15 || 1
  const min = 0
  const x = (i) => padL + i * (W - padL - padR) / (data.length - 1)
  const y = (v) => bottom - ((v - min) / (max - min)) * (bottom - top)
  const line = data.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ')
  const area = line + ' L' + x(data.length - 1).toFixed(1) + ' ' + bottom + ' L' + x(0).toFixed(1) + ' ' + bottom + ' Z'
  const s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': opts.label || '趋势图' })
  for (const gy of [top, (top + bottom) / 2, bottom]) {
    s.append(svg('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, class: 'chart-grid' }))
  }
  s.append(svg('path', { d: area, fill: 'color-mix(in srgb, var(--accent) 12%, transparent)', stroke: 'none' }))
  s.append(svg('path', { d: line, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  const last = data[data.length - 1]
  s.append(svg('circle', { cx: x(data.length - 1), cy: y(last.v), r: 3.2, fill: 'var(--accent)' }))
  const axis = h('div', { class: 'chart-axis' },
    h('span', { text: fmtClock(data[0].t) }),
    h('span', { text: (opts.unit || '') + '峰值 ' + (opts.format ? opts.format(Math.max(...data.map((p) => p.v))) : fmtNum(Math.max(...data.map((p) => p.v)))) }),
    h('span', { text: fmtClock(last.t) }))
  return h('div', null, s, axis)
}

export function barChart(points, opts = {}) {
  const data = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)))
  if (!data.length || !data.some((p) => Number(p.v) > 0)) return empty('暂无数据', '当前窗口没有真实样本。')
  const max = Math.max(...data.map((p) => Number(p.v))) || 1
  const bars = data.map((p) => h('div', { class: 'bar', style: { height: Math.max(2, (Number(p.v) / max) * 100) + '%' }, title: (opts.title ? opts.title(p) : '') , 'aria-label': (opts.title ? opts.title(p) : '') }))
  return h('div', null, h('div', { class: 'bar-chart', role: 'img', 'aria-label': opts.label || '柱状图' }, bars),
    h('div', { class: 'bar-labels' }, h('span', { text: fmtClock(data[0].t) }), h('span', { text: fmtClock(data[data.length - 1].t) })))
}

export function sectionTitle(title, desc, actions) {
  return h('div', { class: 'section-title' }, h('div', null, h('h2', { text: title }), desc ? h('p', { text: desc }) : null), actions || null)
}

export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((it) => h('button', {
    class: 'tab' + (it.id === active ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': it.id === active ? 'true' : 'false', text: it.label,
    onclick: () => onChange(it.id),
  })))
}
