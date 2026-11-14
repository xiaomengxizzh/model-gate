// DOM helpers: every dynamic value goes through textContent / setAttribute, never innerHTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = String(v)
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (k === 'style') Object.assign(el.style, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'html') throw new Error('innerHTML is not allowed')
      else if (k === 'value') el.value = v
      else if (k === 'checked') el.checked = !!v
      else if (k === 'disabled') el.disabled = !!v
      else if (k === 'selected') el.selected = !!v
      else el.setAttribute(k, String(v))
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c.nodeType ? c : document.createTextNode(String(c)))
  }
  return el
}
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v))
  for (const c of children.flat(Infinity)) if (c != null) el.append(c)
  return el
}
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node }
export function mount(parent, ...children) { clear(parent); for (const c of children.flat(Infinity)) if (c != null) parent.append(c); return parent }
export function icon(name, cls = '') {
  const paths = {
    refresh: 'M16 10a6 6 0 11-2-4.5M16 3v4h-4',
    plus: 'M10 4v12M4 10h12',
    edit: 'M4 16l1-4 8-8 3 3-8 8-4 1zM11 5l3 3',
    trash: 'M4 6h12M7 6V4h6v2M6 6l1 10h6l1-10',
    key: 'M12 8a3 3 0 10-2.6 3L4 16v2h3l1-1v-2h2v-2h2l.6-.6',
    probe: 'M3 10h4l2-5 3 10 2-5h3',
    check: 'M4 10l4 4 8-8',
    x: 'M5 5l10 10M15 5L5 15',
    warn: 'M10 3l8 14H2zM10 8v4M10 14v1',
    copy: 'M7 7h9v9H7zM4 4h9v2M4 4v9h2',
  }
  const ns = 'http://www.w3.org/2000/svg'
  const e = document.createElementNS(ns, 'svg')
  e.setAttribute('viewBox', '0 0 20 20')
  e.setAttribute('aria-hidden', 'true')
  if (cls) e.setAttribute('class', cls)
  const p = document.createElementNS(ns, 'path')
  p.setAttribute('d', paths[name] || '')
  p.setAttribute('fill', 'none')
  p.setAttribute('stroke', 'currentColor')
  p.setAttribute('stroke-width', '1.7')
  p.setAttribute('stroke-linecap', 'round')
  p.setAttribute('stroke-linejoin', 'round')
  e.append(p)
  return e
}
export function on(target, event, handler, opts) { target.addEventListener(event, handler, opts); return () => target.removeEventListener(event, handler, opts) }
