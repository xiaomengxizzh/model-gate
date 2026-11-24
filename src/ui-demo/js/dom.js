// 极简 DOM 构造器：只创建节点，不拼 innerHTML。
export function el (tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  append(node, children)
  return node
}

export function svgEl (tag, props = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue
    node.setAttribute(key, String(value))
  }
  return node
}

export function append (node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function clear (node) {
  node.replaceChildren()
  return node
}

export function qs (sel, root = document) { return root.querySelector(sel) }
export function qsa (sel, root = document) { return Array.from(root.querySelectorAll(sel)) }

export function callout (tone, ...children) {
  return el('div', { class: 'callout callout-' + tone }, ...children)
}

export function badge (text, tone = 'muted') {
  return el('span', { class: 'badge', 'data-tone': tone, text })
}

export function emptyState (title, detail) {
  return el('div', { class: 'empty-state' }, el('b', { text: title }), detail ? el('p', { text: detail }) : null)
}
