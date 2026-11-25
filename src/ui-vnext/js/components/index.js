export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'html') throw new Error('ui-vnext forbids innerHTML')
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const ICON_PATHS = Object.freeze({
  harness: 'M3 3h7v7H3zM14 14h7v7h-7zM10 6h7v8M6 10v7h8',
  services: 'M3 3h18v7H3zM3 14h18v7H3zM7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5',
  pools: 'm12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
  usage: 'M3 3v18h18M7 16v-5m5 5V7m5 9V4',
  reliability: 'M12 3 3 7v5c0 5 4 8 9 10 5-2 9-5 9-10V7zM8 12l3 3 5-6',
  settings: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  check: 'm5 12 4 4L19 6',
  warning: 'M12 3 2 21h20L12 3zM12 9v5m0 3h.01',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  download: 'M12 3v12m-5-5 5 5 5-5M4 21h16',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM16 16l4.5 4.5',
})

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('ui14-icon')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.harness)
  svg.append(path)
  return svg
}

export function button(label, onClick, kind = 'secondary', attrs = {}, ...children) {
  return h('button', { type: 'button', class: 'button ' + kind, onClick, ...attrs }, label, ...children)
}

export function tag(label, tone = '') {
  return h('span', { class: 'tag ' + tone }, label)
}

export function pageHeader(title, description, ...actions) {
  return h('header', { class: 'heading page-header' },
    h('div', {}, h('h1', { text: title }), h('p', { text: description })),
    h('div', { class: 'actions' }, ...actions),
  )
}

export function panelHeader(title, description = '', ...actions) {
  return h('div', { class: 'ph panel-head' },
    h('div', {}, h('h2', { text: title }), description ? h('p', { text: description }) : null),
    actions.length ? h('div', { class: 'row' }, ...actions) : null,
  )
}

export function panel(title, ...content) {
  return h('section', { class: 'panel' }, title ? panelHeader(title) : null, ...content)
}

export function notice(title, text, tone = '') {
  return h('div', { class: 'notice ' + tone, role: tone === 'error' ? 'alert' : 'note' },
    h('strong', { text: title }), h('span', { text }),
  )
}

export function empty(title, detail = '', action = null) {
  return h('div', { class: 'empty' }, h('div', {}, h('h2', { text: title }), h('p', { text: detail }), action))
}

export function errorState(error, retry) {
  const message = error && error.message ? error.message : '未知错误'
  return h('div', { class: 'error-state', role: 'alert' },
    h('div', {}, h('h2', { text: '暂时无法读取' }), h('p', { text: message }), retry ? button('重试', retry, 'primary') : null),
  )
}

export function loading(label = '正在读取…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { text: label }))
}

export function metric(label, value, detail = '') {
  return h('section', { class: 'panel metric' },
    h('span', { class: 'kicker metric-label', text: label }),
    h('strong', { class: 'metric-value numeric', text: value }),
    detail ? h('small', { class: 'muted', text: detail }) : null,
  )
}

export function statusStrip(...items) {
  return h('div', { class: 'statusstrip' }, ...items.map(([label, value, tone]) => h('div', {}, h('small', { text: label }), h('b', { class: tone || '' }, value))))
}

export function sectionHead(title, ...actions) {
  return h('div', { class: 'sectionhead' }, h('h2', { text: title }), h('div', { class: 'row' }, ...actions))
}

export function appMark(label) {
  return h('div', { class: 'appmark', 'aria-hidden': 'true', text: label })
}

export function table(headers, rows, options = {}) {
  return h('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': options.label || '数据表格' },
    h('table', {},
      h('thead', {}, h('tr', {}, headers.map((head) => h('th', { scope: 'col', class: head.numeric ? 'numeric' : '', text: head.label || head })))),
      h('tbody', {}, rows.length ? rows.map((row) => h('tr', {}, row.map((cell, index) => h('td', { class: headers[index] && headers[index].numeric ? 'numeric' : '' }, cell)))) : h('tr', {}, h('td', { colspan: headers.length, class: 'empty', text: options.empty || '暂无数据' }))),
    ),
  )
}

export function kv(items) {
  return h('dl', { class: 'kv' }, items.flatMap(([key, value]) => [h('dt', {}, h('span', { text: key })), h('dd', {}, value)]))
}

export function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—'
}

export function modeLabel(mode) {
  return ({ official: '官方直连', route: '纯路由', aggregated: '聚合模式', unknown: '无法确认' })[mode] || '无法确认'
}
