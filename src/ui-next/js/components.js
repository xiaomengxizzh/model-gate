// Reusable, dependency-free UI primitives (V3 design system, UX-05).
// Every dynamic value is inserted as a text node or an attribute; no HTML-string
// insertion sink is used. All exports keep their historical names and signatures.
import { h, svg, clear, mount, icon } from './dom.js'
import { fmtNum, fmtCompact, fmtClock } from './format.js'

// Deterministic, collision-free ids (no Math.random so DOM diffs stay stable).
let uidSeq = 0
function nextId (prefix) { return prefix + '-' + (++uidSeq).toString(36) }

// ---------- evidence/level vocabulary ----------
// "detected" is deliberately neutral: detection is not verification.
const LEVEL_ALIASES = {
  good: 'good', ok: 'good', healthy: 'good', online: 'good', ready: 'good', verified: 'good',
  'runtime-verified': 'good', success: 'good', active: 'good', done: 'good',
  warn: 'warn', warning: 'warn', attention: 'warn', degraded: 'warn', pending: 'warn',
  partial: 'warn', 'needs-restart': 'warn', restart: 'warn', preview: 'warn',
  bad: 'bad', danger: 'bad', error: 'bad', failed: 'bad', blocked: 'bad', invalid: 'bad',
  conflict: 'bad', offline: 'bad', unreachable: 'bad',
  info: 'info', configured: 'info', idle: 'info',
  muted: 'muted', unknown: 'muted', detected: 'muted', missing: 'muted', absent: 'muted',
  untested: 'muted', disabled: 'muted', none: 'muted',
}
export function statusLevel (value) {
  return LEVEL_ALIASES[String(value == null ? '' : value).toLowerCase()] || 'muted'
}

// ---------- page structure ----------
export function pageHead (title, desc, opts = {}) {
  const o = opts || {}
  const left = h('div', { class: 'page-head-main' },
    o.eyebrow ? h('p', { class: 'eyebrow', text: o.eyebrow }) : null,
    h('h1', { text: title }),
    desc ? h('p', { text: desc }) : null)
  const actions = o.actions ? h('div', { class: 'page-actions' }, o.actions) : null
  return h('header', { class: 'page-head' }, left, actions)
}

export function card (title, desc, body, opts = {}) {
  const o = opts || {}
  const titleId = title ? nextId('card-title') : null
  const descId = desc ? nextId('card-desc') : null
  const head = (title || o.actions) ? h('div', { class: 'card-head' },
    h('div', { class: 'card-head-main' },
      title ? h('h2', { id: titleId, text: title }) : null,
      desc ? h('p', { id: descId, text: desc }) : null),
    o.actions || null) : null
  const bodyEl = h('div', { class: 'card-body' + (o.flush ? ' flush' : '') }, body)
  const foot = o.foot ? h('div', { class: 'card-foot' }, o.foot) : null
  const variant = o.variant === 'primary' || o.variant === 'secondary' || o.variant === 'meta'
    ? ' is-' + o.variant
    : ''
  const classes = 'card' + variant + (o.className ? ' ' + o.className : '')
  return h('section', {
    class: classes,
    id: o.id || null,
    'aria-labelledby': titleId,
    'aria-describedby': descId,
  }, head, bodyEl, foot)
}

export function metric (label, value, sub, iconName) {
  return h('div', { class: 'metric' },
    h('div', { class: 'metric-top' }, h('span', { text: label }), iconName ? icon(iconName) : null),
    h('div', { class: 'metric-value', text: value }),
    sub ? h('div', { class: 'metric-sub', text: sub }) : null)
}

// ---------- state display ----------
export function tag (label, kind = 'muted') {
  return h('span', { class: 'tag tag-' + kind }, h('span', { class: 'tag-dot', 'aria-hidden': 'true' }), String(label))
}

export function statusTag (value) {
  const map = {
    ok: ['正常', 'good'], healthy: ['正常', 'good'], up: ['在线', 'good'],
    half: ['半开', 'warn'], degraded: ['降级', 'warn'], warn: ['告警', 'warn'],
    open: ['熔断', 'bad'], error: ['异常', 'bad'], failed: ['失败', 'bad'], down: ['不可达', 'bad'],
    unknown: ['未知', 'muted'], untested: ['未测试', 'muted'],
    // evidence levels (contract §2): detected is never rendered as verified
    detected: ['已检测', 'muted'], configured: ['已配置', 'info'],
    'runtime-verified': ['运行已验证', 'good'], missing: ['未配置', 'muted'],
    blocked: ['受阻', 'bad'],
  }
  const [label, kind] = map[String(value)] || ['未知', 'muted']
  return tag(label, kind)
}

// One honest status fact: label + value + optional detail + optional action.
export function statusRow (opts = {}) {
  const o = opts || {}
  const level = statusLevel(o.level)
  const labelId = nextId('status-label')
  const detailId = o.detail ? nextId('status-detail') : null
  return h('div', {
    class: 'status-row is-' + level,
    dataset: { level },
    role: 'group',
    'aria-labelledby': labelId,
    'aria-describedby': detailId,
  },
  h('span', { class: 'status-row-dot', 'aria-hidden': 'true' }),
  h('div', { class: 'status-row-main' },
    h('span', { class: 'status-row-label', id: labelId, text: String(o.label == null ? '' : o.label) }),
    o.value == null ? null : h('span', { class: 'status-row-value', text: String(o.value) }),
    o.detail ? h('p', { class: 'status-row-detail', id: detailId, text: String(o.detail) }) : null),
  o.action || null)
}

// The one next action of a page. Disabled means disabled: no click handler at all.
export function primaryAction (opts = {}) {
  const o = opts || {}
  const busy = !!o.busy
  const disabled = !!o.disabled || busy
  const btn = h('button', {
    class: 'btn btn-primary btn-lg primary-action-button',
    type: 'button',
    disabled: disabled,
    'aria-disabled': disabled ? 'true' : null,
    'aria-busy': busy ? 'true' : null,
  })
  btn.append(h('span', { class: 'primary-action-label', text: String(o.label || '继续') }))
  if (busy) btn.append(h('span', { class: 'primary-action-spinner', 'aria-hidden': 'true' }))
  if (!disabled && typeof o.onclick === 'function') btn.addEventListener('click', o.onclick)
  const detail = typeof o.detail === 'function' ? o.detail() : o.detail
  const children = [btn]
  if (detail != null && detail !== '') children.push(h('p', { class: 'primary-action-detail', text: String(detail) }))
  if (busy) children.push(h('p', { class: 'sr-only', role: 'status', text: '正在处理，请稍候' }))
  return h('div', { class: 'primary-action' }, children)
}

// Ordered steps: aria-current="step" plus roving tabindex and arrow keys.
export function stepper (opts = {}) {
  const o = opts || {}
  const raw = Array.isArray(o.steps) ? o.steps : []
  const steps = raw.map((s, i) => (typeof s === 'string'
    ? { id: 'step-' + (i + 1), label: s }
    : { id: s.id || ('step-' + (i + 1)), label: String(s.label == null ? '' : s.label), hint: s.hint }))
  const currentIndex = typeof o.current === 'number'
    ? o.current
    : steps.findIndex((s) => s.id === o.current)
  const buttons = []
  const track = h('ol', { class: 'stepper', 'aria-label': String(o.label || '步骤') })
  const focusStep = (index) => {
    const btn = buttons[index]
    if (btn && btn.focus) btn.focus()
  }
  steps.forEach((step, i) => {
    const isCurrent = i === currentIndex
    const isDone = currentIndex >= 0 && i < currentIndex
    const btn = h('button', {
      class: 'step-button',
      type: 'button',
      id: step.id,
      tabindex: isCurrent || (currentIndex < 0 && i === 0) ? '0' : '-1',
      'aria-current': isCurrent ? 'step' : null,
      onclick: () => { if (typeof o.onSelect === 'function') o.onSelect(step.id, i) },
    },
    h('span', { class: 'step-index', 'aria-hidden': 'true', text: isDone ? '✓' : String(i + 1) }),
    h('span', { class: 'step-body' },
      h('span', { class: 'step-label', text: step.label }),
      step.hint ? h('span', { class: 'step-hint', text: String(step.hint) }) : null,
      isDone ? h('span', { class: 'sr-only', text: '已完成' }) : null,
      isCurrent ? h('span', { class: 'sr-only', text: '当前步骤' }) : null))
    btn.addEventListener('keydown', (e) => {
      const key = e && e.key
      let target = null
      if (key === 'ArrowRight' || key === 'ArrowDown') target = i + 1
      else if (key === 'ArrowLeft' || key === 'ArrowUp') target = i - 1
      else if (key === 'Home') target = 0
      else if (key === 'End') target = steps.length - 1
      if (target == null) return
      if (e.preventDefault) e.preventDefault()
      const next = Math.min(Math.max(target, 0), steps.length - 1)
      focusStep(next)
      if (typeof o.onSelect === 'function' && next !== i) o.onSelect(steps[next].id, next)
    })
    buttons.push(btn)
    track.append(h('li', { class: 'step' + (isCurrent ? ' is-current' : '') + (isDone ? ' is-done' : '') }, btn))
  })
  return track
}

// ---------- feedback ----------
export function callout (kind, ...children) {
  const icons = { warn: '!', danger: '×', good: '✓', info: 'i' }
  // persistent notes are not live regions; only real errors interrupt the reader
  const role = kind === 'danger' ? 'alert' : 'note'
  return h('div', { class: 'callout is-' + kind, role },
    h('span', { class: 'callout-icon', 'aria-hidden': 'true', text: icons[kind] || 'i' }),
    h('div', { class: 'callout-body' }, children))
}

export function empty (title, desc, action) {
  return h('div', { class: 'empty' },
    h('span', { class: 'empty-icon', 'aria-hidden': 'true', text: '◌' }),
    h('strong', { text: title }),
    desc ? h('span', { text: desc }) : null,
    action || null)
}

// ---------- data display ----------
export function table (columns, rows, opts = {}) {
  const o = opts || {}
  if (!rows || !rows.length) return empty(o.emptyTitle || '暂无数据', o.emptyDesc || '当前接口没有返回记录。', o.emptyAction)
  const caption = o.caption ? h('caption', { text: o.caption }) : null
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', {
    class: c.className || '', scope: 'col', text: c.label,
  }))))
  const tbody = h('tbody', null, rows.map((row, i) => h('tr', null, columns.map((c) => {
    const value = c.render ? c.render(row, i) : row[c.key]
    return h('td', { class: c.className || '' }, value == null ? '—' : (value.nodeType ? value : String(value)))
  }))))
  const wrapper = h('div', {
    class: 'table-wrap',
    tabindex: '0',
    role: 'region',
    'aria-label': o.label || o.caption || '数据表',
  }, h('table', { class: 'data' + (o.compact ? ' is-compact' : '') }, caption, thead, tbody))
  return wrapper
}

// Legacy field: label + input + help/error, with full aria wiring.
export function field (label, input, opts = {}) {
  const o = opts || {}
  const target = input
  const id = (target && target.id) || o.id || nextId('field')
  if (target && !target.id) target.id = id
  const helpId = o.help ? id + '-help' : null
  const errorId = o.error ? id + '-error' : null
  if (target && target.setAttribute) {
    const described = [helpId, errorId].filter(Boolean).join(' ')
    if (described) target.setAttribute('aria-describedby', described)
    if (errorId) {
      target.setAttribute('aria-invalid', 'true')
      target.setAttribute('aria-errormessage', errorId)
    }
  }
  return h('div', { class: 'field' + (o.error ? ' is-invalid' : '') },
    h('label', { for: id, text: label }),
    target,
    helpId ? h('span', { class: 'field-help', id: helpId, text: o.help }) : null,
    errorId ? h('span', { class: 'field-error', id: errorId, role: 'alert', text: o.error }) : null)
}

// New form primitive: explicit id, always-associated hint and error text.
export function formField (opts = {}) {
  const o = opts || {}
  const input = o.input
  const id = o.id || (input && input.id) || nextId('form-field')
  if (input && !input.id) input.id = id
  const hintId = o.hint ? id + '-hint' : null
  const errorId = o.error ? id + '-error' : null
  if (input && input.setAttribute) {
    const existing = input.getAttribute ? input.getAttribute('aria-describedby') : null
    const described = [existing, hintId, errorId].filter(Boolean).join(' ')
    if (described) input.setAttribute('aria-describedby', described)
    if (errorId) {
      input.setAttribute('aria-invalid', 'true')
      input.setAttribute('aria-errormessage', errorId)
    }
    if (o.required) input.setAttribute('aria-required', 'true')
  }
  return h('div', { class: 'form-field' + (o.error ? ' is-invalid' : '') },
    h('label', { class: 'form-label', for: id, text: String(o.label == null ? '' : o.label) }),
    input || null,
    hintId ? h('p', { class: 'form-hint', id: hintId, text: String(o.hint) }) : null,
    errorId ? h('p', { class: 'form-error', id: errorId, role: 'alert', text: String(o.error) }) : null)
}

export function codeBlock (text, opts = {}) {
  const body = String(text == null ? '' : text)
  const pre = h('pre', { class: 'code', tabindex: '0', 'aria-label': (opts && opts.label) || '配置内容' }, body)
  if (!opts || !opts.copy) return pre
  return h('div', { class: 'code-wrap' }, pre, h('span', { class: 'copy' }, copyButton(body, '复制')))
}

export function copyButton (value, label = '复制') {
  const btn = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': label + '到剪贴板', text: label })
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

export function kvList (entries) {
  const list = h('dl', { class: 'kv-list' })
  for (const [k, v] of entries) {
    list.append(h('div', { class: 'kv' },
      h('dt', { class: 'k', text: k }),
      h('dd', { class: 'v' }, v == null ? '—' : (v.nodeType ? v : String(v)))))
  }
  return list
}

export function toast (message, kind = 'info') {
  const host = document.getElementById('toasts')
  if (!host) return
  const cls = kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''
  const el = h('div', { class: 'toast' + cls, role: kind === 'error' ? 'alert' : 'status', 'aria-atomic': 'true' }, String(message))
  host.append(el)
  const life = kind === 'error' ? 6500 : 3600
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 200ms'; setTimeout(() => el.remove(), 220) }, life)
}

// ---------- overlays ----------
// Dialog: modal semantics, Escape, focus trap, focus restore, onClose hook.
let activeDialog = null
export function dialog (opts = {}) {
  const o = opts || {}
  const root = document.getElementById('dialog-root')
  if (!root) return null
  if (activeDialog) activeDialog.close()
  const previous = typeof document !== 'undefined' ? document.activeElement : null
  const titleId = nextId('dialog-title')
  const descId = o.desc ? nextId('dialog-desc') : null
  let closed = false
  let onKey = null
  let panel = null

  const close = () => {
    if (closed) return
    closed = true
    if (onKey) document.removeEventListener('keydown', onKey)
    root.hidden = true
    clear(root)
    root.onclick = null
    if (activeDialog && activeDialog.el === panel) activeDialog = null
    if (typeof o.onClose === 'function') { try { o.onClose() } catch {} }
    const target = previous && previous.focus && previous.isConnected !== false ? previous : null
    setTimeout(() => {
      if (target) { try { target.focus() } catch {} } else {
        const view = document.getElementById('view-root')
        if (view && view.focus) view.focus()
      }
    }, 0)
  }

  const body = h('div', { class: 'dialog-body' }, o.content)
  const actions = o.actions ? h('div', { class: 'dialog-foot' }, o.actions) : null
  const closeBtn = h('button', { class: 'icon-close', type: 'button', 'aria-label': '关闭对话框', text: '×', onclick: close })
  panel = h('div', {
    class: 'dialog' + (o.wide ? ' is-wide' : ''),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': descId,
  },
  h('div', { class: 'dialog-head' },
    h('div', null, h('h2', { id: titleId, text: o.title || '' }), descId ? h('p', { id: descId, text: o.desc }) : null),
    closeBtn),
  body, actions)

  const focusables = () => Array.from(panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true' && el.getAttribute('tabindex') !== '-1')

  onKey = (e) => {
    if (!e) return
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key !== 'Tab') return
    const list = focusables()
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    const current = document.activeElement
    const inside = panel.contains ? panel.contains(current) : true
    if (e.shiftKey) {
      if (!inside || current === first) { e.preventDefault(); last.focus() }
    } else if (!inside || current === last) { e.preventDefault(); first.focus() }
  }

  root.hidden = false
  mount(root, panel)
  root.onclick = (e) => { if (e.target === root) close() }
  document.addEventListener('keydown', onKey)
  const initial = panel.querySelector('[autofocus]') || panel.querySelector('input, select, textarea') ||
    panel.querySelector('.btn-primary') || closeBtn
  setTimeout(() => { if (!closed && initial && initial.focus) initial.focus() }, 20)
  activeDialog = { el: panel, close, root }
  return activeDialog
}

// For callers that clear #dialog-root themselves (401 cleanup): close with cleanup.
export function closeDialog () {
  if (!activeDialog) return false
  activeDialog.close()
  return true
}

export function confirmDialog (opts = {}) {
  const o = opts || {}
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (settled) return; settled = true; resolve(value) }
    const cancel = h('button', { class: 'btn', type: 'button', text: o.cancelLabel || '取消', onclick: () => { finish(false); d.close() } })
    const ok = h('button', { class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), type: 'button', text: o.confirmLabel || '确认', onclick: () => { finish(true); d.close() } })
    const d = dialog({
      title: o.title || '请确认',
      desc: o.desc,
      content: h('p', { class: 'muted', text: o.message || '' }),
      actions: [cancel, ok],
      onClose: () => finish(false),
    })
    if (!d) finish(false)
  })
}

// ---------- charts ----------
export function lineChart (points, opts = {}) {
  const o = opts || {}
  const data = (Array.isArray(points) ? points : [])
    .map((p) => ({ t: Number(p.t), v: Number(p.v) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t)
  if (data.length < 2 || !data.some((p) => p.v > 0)) {
    return empty('暂无趋势数据', o.emptyDesc || '网关尚未累积足够的真实样本。')
  }
  const W = 620, H = 190, padL = 8, padR = 8, top = 10, bottom = 160
  const max = Math.max(...data.map((p) => p.v)) * 1.15 || 1
  const min = 0
  const x = (i) => padL + i * (W - padL - padR) / (data.length - 1)
  const y = (v) => bottom - ((v - min) / (max - min)) * (bottom - top)
  const line = data.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ')
  const area = line + ' L' + x(data.length - 1).toFixed(1) + ' ' + bottom + ' L' + x(0).toFixed(1) + ' ' + bottom + ' Z'
  const peak = Math.max(...data.map((p) => p.v))
  const s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': o.label || ('趋势图，峰值 ' + fmtNum(peak)) })
  for (const gy of [top, (top + bottom) / 2, bottom]) {
    s.append(svg('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, class: 'chart-grid' }))
  }
  s.append(svg('path', { d: area, fill: 'color-mix(in srgb, var(--accent) 12%, transparent)', stroke: 'none' }))
  s.append(svg('path', { d: line, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  const last = data[data.length - 1]
  s.append(svg('circle', { cx: x(data.length - 1), cy: y(last.v), r: 3.2, fill: 'var(--accent)' }))
  const axis = h('div', { class: 'chart-axis' },
    h('span', { text: fmtClock(data[0].t) }),
    h('span', { text: (o.unit || '') + '峰值 ' + (o.format ? o.format(peak) : fmtNum(peak)) }),
    h('span', { text: fmtClock(last.t) }))
  return h('div', null, s, axis)
}

export function barChart (points, opts = {}) {
  const o = opts || {}
  const data = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)))
  if (!data.length || !data.some((p) => Number(p.v) > 0)) return empty('暂无数据', '当前窗口没有真实样本。')
  const max = Math.max(...data.map((p) => Number(p.v))) || 1
  const bars = data.map((p) => h('div', {
    class: 'bar',
    style: { height: Math.max(2, (Number(p.v) / max) * 100) + '%' },
    title: (o.title ? o.title(p) : ''),
    'aria-label': (o.title ? o.title(p) : ''),
  }))
  return h('div', null,
    h('div', { class: 'bar-chart', role: 'img', 'aria-label': o.label || '柱状图' }, bars),
    h('div', { class: 'bar-labels' }, h('span', { text: fmtClock(data[0].t) }), h('span', { text: fmtClock(data[data.length - 1].t) })))
}

export function sectionTitle (title, desc, actions) {
  return h('div', { class: 'section-title' },
    h('div', null, h('h2', { text: title }), desc ? h('p', { text: desc }) : null),
    actions || null)
}

// Tabs: roving tabindex + arrow-key navigation, aria-selected is the source of truth.
export function tabs (items, active, onChange) {
  const list = Array.isArray(items) ? items : []
  const buttons = []
  const select = (id) => { if (typeof onChange === 'function') onChange(id) }
  const focusAt = (index) => {
    const btn = buttons[index]
    if (btn && btn.focus) btn.focus()
  }
  const bar = h('div', { class: 'tabs', role: 'tablist' }, list.map((it, i) => {
    const selected = it.id === active
    const btn = h('button', {
      class: 'tab' + (selected ? ' is-active' : ''),
      type: 'button',
      role: 'tab',
      id: 'tab-' + String(it.id),
      tabindex: selected || (!active && i === 0) ? '0' : '-1',
      'aria-selected': selected ? 'true' : 'false',
      'aria-controls': it.controls || null,
      text: it.label,
      onclick: () => select(it.id),
    })
    btn.addEventListener('keydown', (e) => {
      const key = e && e.key
      let target = null
      if (key === 'ArrowRight') target = i + 1
      else if (key === 'ArrowLeft') target = i - 1
      else if (key === 'Home') target = 0
      else if (key === 'End') target = list.length - 1
      if (target == null) return
      if (e.preventDefault) e.preventDefault()
      const next = (target + list.length) % list.length
      focusAt(next)
      select(list[next].id)
    })
    buttons.push(btn)
    return btn
  }))
  return bar
}
