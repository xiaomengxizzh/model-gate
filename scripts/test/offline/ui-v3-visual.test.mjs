// UX-05 / A4：设计令牌、可访问性与响应式（styles.css 静态规则 + components.js 行为）。
// 零依赖 DOM shim（复刻 ui-state.test.mjs 的最小实现并补 querySelector/contains/focus），
// 真实浏览器渲染仍由 UX-06 / A5 的 E2E 覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS_PATH = fileURLToPath(new URL('../../../src/ui-next/styles.css', import.meta.url))
const COMPONENTS_PATH = fileURLToPath(new URL('../../../src/ui-next/js/components.js', import.meta.url))
const CSS = readFileSync(CSS_PATH, 'utf8')
const COMPONENTS_SRC = readFileSync(COMPONENTS_PATH, 'utf8')

// ---------- CSS 解析辅助（宽松、按结构取值，不写死整行文本） ----------
function rule (css, selector) {
  const esc = selector.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}
function tokens (css) {
  const map = new Map()
  for (const m of css.matchAll(/--([a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g)) map.set(m[1], m[2].trim())
  return map
}
function mediaBlock (css, condition) {
  const esc = condition.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp('@media\\s*' + esc + '\\s*\\{([\\s\\S]*?)\\n\\}'))
  return m ? m[1] : ''
}
function pxValues (value) {
  return [...String(value).matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
}
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const TOKENS = tokens(rule(CSS, ':root'))

// ---------- DOM shim ----------
function walk (node, out = []) {
  if (!node || node.nodeType !== 1) return out
  out.push(node)
  for (const c of node.children || []) walk(c, out)
  return out
}
function matchSimple (el, part) {
  if (!part) return false
  const not = part.match(/:not\(([^)]*)\)/)
  let base = part
  if (not) {
    base = part.replace(not[0], '')
    if (matchSimple(el, not[1])) return false
    if (!base) return true
  }
  if (base.startsWith('[')) {
    const m = base.match(/^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/)
    if (!m) return false
    const actual = el.getAttribute(m[1])
    if (actual == null) return false
    const expected = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]
    return expected == null || expected === '' ? true : actual === expected
  }
  if (base.startsWith('.')) return (' ' + String(el.className || '') + ' ').includes(' ' + base.slice(1) + ' ')
  return String(el.tagName) === base.toUpperCase()
}
function matches (el, selector) {
  return String(selector).split(',').some((part) => matchSimple(el, part.trim()))
}

class El {
  constructor (tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.children = []
    this.attributes = {}
    this.style = {}
    this.dataset = {}
    this._text = ''
    this.className = ''
    this.id = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.checked = false
    this.listeners = {}
    this.parent = null
  }
  get textContent () { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
  set textContent (v) { this._text = ''; this.children = [{ nodeType: 3, textContent: String(v) }] }
  // 真实 DOM 中 id/className 属性与 property 互映；shim 必须同样反射，否则 label for 校验失真。
  get id () { return this.attributes.id || '' }
  set id (v) { this.attributes.id = String(v) }
  get className () { return this.attributes.class || '' }
  set className (v) { this.attributes.class = String(v) }
  append (...nodes) {
    for (const n of nodes) {
      const node = (n && n.nodeType) ? n : { nodeType: 3, textContent: String(n) }
      node.parent = this
      this.children.push(node)
    }
  }
  appendChild (n) { this.append(n) }
  replaceChildren (...nodes) { this.children = []; this._text = ''; this.append(...nodes) }
  removeChild (n) { this.children = this.children.filter((c) => c !== n) }
  remove () { if (this.parent) this.parent.removeChild(this) }
  setAttribute (k, v) {
    this.attributes[k] = String(v)
    if (k === 'id') this.id = String(v)
    if (k === 'class') this.className = String(v)
  }
  getAttribute (k) { return this.attributes[k] == null ? null : this.attributes[k] }
  removeAttribute (k) { delete this.attributes[k] }
  addEventListener (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener (type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn) }
  focus () { document.activeElement = this }
  select () {}
  contains (node) { let cur = node; while (cur) { if (cur === this) return true; cur = cur.parent } return false }
  querySelector (selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll (selector) { return walk(this).filter((el) => el !== this && matches(el, selector)) }
  get firstChild () { return this.children[0] || null }
  get firstElementChild () { return this.children.find((c) => c && c.nodeType === 1) || null }
}

const byId = new Map()
const documentListeners = {}
let activeEl = null
globalThis.document = {
  documentElement: { dataset: {} },
  body: new El('body'),
  get activeElement () { return activeEl },
  set activeElement (v) { activeEl = v },
  createElement: (tag) => new El(tag),
  createElementNS: (ns, tag) => new El(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  getElementById: (id) => {
    if (!byId.has(id)) { const el = new El('div'); el.id = id; byId.set(id, el) }
    return byId.get(id)
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener (type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn) },
  removeEventListener (type, fn) { documentListeners[type] = (documentListeners[type] || []).filter((f) => f !== fn) },
}
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener () {} }),
  addEventListener () {},
  removeEventListener () {},
}
document.activeElement = document.body
document.body.focus()

const { h } = await import('../../../src/ui-next/js/dom.js')
const components = await import('../../../src/ui-next/js/components.js')
const { statusRow, primaryAction, formField, stepper, dialog, confirmDialog, statusLevel } = components

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const findAll = (root, pred) => walk(root).filter(pred)
const find = (root, pred) => walk(root).find(pred)
const byTag = (root, tag) => findAll(root, (el) => el.tagName === tag.toUpperCase())
function dispatch (el, type, event = {}) {
  const list = (el.listeners && el.listeners[type]) || []
  for (const fn of list.slice()) fn({ type, target: el, preventDefault () {}, ...event })
  return list.length
}
function dispatchDocument (type, event = {}) {
  const list = (documentListeners[type] || []).slice()
  for (const fn of list) fn({ type, target: document, preventDefault () {}, ...event })
  return list.length
}
function click (el) { return dispatch(el, 'click') }

// ---------- 1. 设计令牌与明暗主题 ----------
test('visual: :root 设计令牌覆盖颜色/间距/字号/圆角/阴影/焦点/动效，且明暗主题齐备', () => {
  const root = rule(CSS, ':root')
  assert.ok(root.length > 0, ':root token block missing')
  for (const key of ['font-sans', 'text-body', 'space-4', 'radius', 'shadow-sm', 'control-h', 'focus-ring', 'motion-fast', 'canvas', 'paper', 'ink', 'muted', 'accent', 'danger']) {
    assert.ok(TOKENS.has(key), 'missing design token --' + key)
  }
  assert.ok(/color-scheme:\s*light/.test(root), ':root must declare light color-scheme')
  const dark = rule(CSS, ':root[data-theme="dark"]')
  assert.ok(dark.length > 0, 'explicit [data-theme="dark"] block missing (app.applyTheme writes dataset.theme)')
  assert.ok(/color-scheme:\s*dark/.test(dark))
  for (const key of ['canvas', 'paper', 'ink', 'muted', 'accent', 'danger']) {
    const m = dark.match(new RegExp('--' + key + '\\s*:\\s*([^;]+);'))
    assert.ok(m, 'dark theme must override --' + key)
    assert.notEqual(m[1].trim(), TOKENS.get(key), 'dark --' + key + ' must differ from light')
  }
  // 系统深色偏好兜底（JS 未运行前），且显式 light 优先
  const osDark = mediaBlock(CSS, '(prefers-color-scheme:dark)')
  assert.ok(osDark.includes(':root:not([data-theme="light"])'), 'prefers-color-scheme fallback must defer to explicit light')
  assert.ok(/--paper\s*:/.test(osDark), 'prefers-color-scheme fallback must define surfaces')
})

// ---------- 2. 焦点、reduced-motion、断点 ----------
test('visual: 全局 :focus-visible、skip-link、reduced-motion 与 360/768/1440 断点存在', () => {
  assert.ok(/:focus-visible\s*\{/.test(CSS), 'global :focus-visible rule missing')
  assert.match(rule(CSS, ':focus-visible'), /outline:\s*3px solid var\(--focus-ring-color\)/)
  assert.match(rule(CSS, '.skip-link'), /position:\s*absolute/, 'skip-link must stay off-screen until focused')
  assert.match(CSS, /\.skip-link:focus\{/)
  assert.match(rule(CSS, '.sr-only'), /clip-path|clip:/, 'screen-reader-only utility missing')
  const reduced = mediaBlock(CSS, '(prefers-reduced-motion:reduce)')
  assert.ok(reduced.length > 0, 'prefers-reduced-motion block missing')
  assert.match(reduced, /animation-duration/)
  assert.match(reduced, /transition-duration/)
  assert.match(reduced, /scroll-behavior:\s*auto/)

  const widths = [...CSS.matchAll(/@media\s*\((max|min)-width:\s*(\d+)px\)/g)].map((m) => ({ kind: m[1], px: Number(m[2]) }))
  assert.ok(widths.some((w) => w.kind === 'max' && w.px <= 400), 'phone breakpoint (<=400px) missing')
  assert.ok(widths.some((w) => w.kind === 'max' && w.px >= 700 && w.px <= 900), 'tablet breakpoint (~768px) missing')
  assert.ok(widths.some((w) => w.kind === 'min' && w.px >= 1024), 'desktop breakpoint (>=1024px) missing')
  assert.ok(widths.some((w) => w.kind === 'min' && w.px >= 1440), 'wide desktop breakpoint (>=1440px) missing')

  // 窄屏侧栏折叠是纯 CSS，不改 index.html 结构
  const tablet = mediaBlock(CSS, '(max-width:960px)')
  assert.ok(/\.sidebar\{[^}]*flex-direction:\s*row/.test(tablet), 'sidebar must fold to a top bar on narrow screens')
  assert.ok(/\.nav\{[^}]*flex-wrap:\s*wrap/.test(tablet), 'folded nav must wrap instead of clipping entries')
  const phone = mediaBlock(CSS, '(max-width:400px)')
  assert.ok(/\.dialog\{[^}]*min-height:\s*100vh/.test(phone), 'phone dialog must become a full-height sheet')
  assert.ok(phone.includes('.toast-stack{'), 'toast stack must fit the phone viewport')
})

// ---------- 3. 字号/触控区阈值 ----------
test('visual: 正文 14-16px、次要文字 >=12px、按钮 >=40px、主 CTA 44px', () => {
  const body = TOKENS.get('text-body')
  assert.ok(body, '--text-body token missing')
  const bodyPx = pxValues(body)
  assert.equal(bodyPx.length, 1)
  assert.ok(bodyPx[0] >= 14 && bodyPx[0] <= 16, 'body text must be 14-16px, got ' + bodyPx[0])

  const scale = [...TOKENS.entries()].filter(([k]) => k.startsWith('text-'))
  assert.ok(scale.length >= 5, 'typography scale tokens missing')
  for (const [key, value] of scale) {
    const sizes = pxValues(value)
    assert.ok(sizes.length > 0, '--' + key + ' must be expressed in px')
    assert.ok(Math.min(...sizes) >= 12, '--' + key + ' must be >= 12px, got ' + value)
  }

  assert.match(rule(CSS, 'body'), /font-size:\s*var\(--text-body\)/)

  const declarations = [...CSS.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1].trim())
  assert.ok(declarations.length >= 10, 'expected many font-size declarations')
  for (const value of declarations) {
    for (const px of pxValues(value)) assert.ok(px >= 12, 'font-size below 12px: ' + value)
  }
  assert.ok(!/font-size\s*:\s*(0?\.\d+|\d+)rem/.test(CSS), 'font sizes must not hide below 12px behind rem units')

  const controlH = pxValues(TOKENS.get('control-h'))
  const controlLg = pxValues(TOKENS.get('control-h-lg'))
  assert.ok(controlH[0] >= 40, 'buttons need a >= 40px touch target')
  assert.ok(controlLg[0] >= 44, 'primary CTA needs a >= 44px touch target')
  assert.match(rule(CSS, '.btn'), /min-height:\s*var\(--control-h\)/)
  assert.match(rule(CSS, '.btn-primary'), /min-height:\s*var\(--control-h-lg\)/)
  assert.match(rule(CSS, '.icon-btn'), /height:\s*var\(--control-h\)/)
  // 主 CTA 允许换行，200% 缩放下不截断
  assert.match(rule(CSS, '.primary-action-button'), /white-space:\s*normal/)
})

// ---------- 4. 无外部依赖 ----------
test('visual: 无 @import / @font-face / 外链 url() / !important 堆砌', () => {
  assert.ok(!/@import/.test(CSS_NO_COMMENTS), 'no @import allowed')
  assert.ok(!/@font-face/.test(CSS_NO_COMMENTS), 'no external font loading allowed')
  assert.ok(!/url\(/.test(CSS_NO_COMMENTS), 'styles must not reference any url() asset')
  const importants = (CSS_NO_COMMENTS.match(/!important/g) || []).length
  assert.ok(importants <= 8, '!important used too often: ' + importants)
  for (const selector of ['.btn-primary', '.card', '.page-head']) {
    assert.ok(!/!important/.test(rule(CSS, selector)), selector + ' must not need !important')
  }
})

// ---------- 5. 组件导出契约（既有名称不变） ----------
test('visual: components.js 保留全部既有导出并新增 statusRow/primaryAction/stepper/formField', () => {
  const legacy = ['pageHead', 'card', 'metric', 'tag', 'statusTag', 'callout', 'empty', 'table', 'field',
    'codeBlock', 'copyButton', 'toast', 'dialog', 'confirmDialog', 'kvList', 'lineChart', 'barChart', 'sectionTitle', 'tabs']
  for (const name of legacy) assert.equal(typeof components[name], 'function', 'legacy export missing: ' + name)
  for (const name of ['statusRow', 'primaryAction', 'stepper', 'formField', 'statusLevel', 'closeDialog']) {
    assert.equal(typeof components[name], 'function', 'new export missing: ' + name)
  }
  assert.doesNotMatch(COMPONENTS_SRC, /innerHTML/, 'components must never use innerHTML')
  assert.doesNotMatch(COMPONENTS_SRC, /insertAdjacentHTML/)
  assert.doesNotMatch(COMPONENTS_SRC, /sessionStorage|localStorage/)
  assert.match(COMPONENTS_SRC, /is-' \+ o\.variant/, 'card must expose primary/secondary/meta variants')
  assert.match(COMPONENTS_SRC, /'aria-labelledby': titleId/, 'card must associate its heading')
  assert.match(COMPONENTS_SRC, /scope: 'col'/, 'table headers must carry scope=col')

  // 视图最常用的三个结构仍然可用（签名不变的前提下加 a11y 语义）
  const head = components.pageHead('总览', '只读取真实状态', { eyebrow: '首页', actions: [h('button', { class: 'btn', type: 'button', text: '刷新' })] })
  assert.equal(find(head, (el) => el.tagName === 'H1').textContent, '总览')
  assert.equal(byTag(head, 'button').length, 1)
  const box = components.card('连接状态', '三条事实', h('p', { text: '正文' }), { variant: 'primary', foot: '脚注' })
  assert.match(box.className, /card is-primary/)
  const headingId = box.getAttribute('aria-labelledby')
  assert.ok(headingId && find(box, (el) => el.id === headingId), 'card heading must be referenced')
  assert.match(box.textContent, /脚注/)
  const grid = components.table([{ key: 'a', label: 'A' }, { key: 'b', label: 'B', className: 'num' }], [{ a: 1, b: 2 }], { caption: '数据表标题', label: '数据表' })
  assert.equal(grid.getAttribute('role'), 'region')
  assert.equal(grid.getAttribute('aria-label'), '数据表')
  assert.equal(find(grid, (el) => el.tagName === 'TH').getAttribute('scope'), 'col')
  assert.equal(byTag(grid, 'caption').length, 1)
  const kv = components.kvList([['配置版本', '7']])
  assert.equal(find(kv, (el) => el.tagName === 'DT').textContent, '配置版本')
  assert.equal(find(kv, (el) => el.tagName === 'DD').textContent, '7')
})

// ---------- 6. statusRow：label/value/detail 与 level 映射 ----------
// ---------- 11. 横向溢出回归防线（静态不变量；真实 reflow 数字见提交说明） ----------
test('visual: 关键容器可收缩（min-width:0 / border-box / 无 100vw），且不靠 overflow-x 掩盖', () => {
  assert.match(CSS_NO_COMMENTS, /\*\{box-sizing:border-box\}/, 'border-box reset is required for width+padding containers')
  assert.match(rule(CSS, '.app-shell'), /grid-template-columns:\s*var\(--sidebar-w\)\s+minmax\(0,\s*1fr\)/)
  // flex/grid 子项默认 min-width:auto，会把不可换行的内容顶破父容器（实测 360px 下 advanced 导航曾溢出 +319px）
  for (const sel of ['.workspace', '.main', '.card', '.card-body', '.grid', '.list', '.table-wrap',
    '.page-stack', '.layout-split', '.topbar', '.brand', '.brand-copy', '.nav', '.nav-group', '.home-cta']) {
    assert.match(rule(CSS, sel), /min-width:\s*0/, sel + ' must be allowed to shrink (min-width:0)')
  }
  // 侧栏品牌行：副标题必须可换行，而不是 nowrap 顶出 250px 轨道
  assert.match(rule(CSS, '.brand-copy small'), /white-space:\s*normal/, 'rail subtitle must wrap instead of overflowing')
  assert.match(rule(CSS, '.brand-copy small'), /overflow-wrap:\s*anywhere/)
  // 折叠顶栏里的高级导航分组必须可收缩，否则打开分组时整页被撑宽
  const tablet = mediaBlock(CSS, '(max-width:960px)')
  assert.match(tablet, /\.nav-group\{[^}]*flex:\s*0 1 auto/)
  assert.match(tablet, /\.nav-group\{[^}]*min-width:\s*0/)
  assert.match(tablet, /\.nav-group-items\{[^}]*min-width:\s*0/)
  assert.match(tablet, /\.nav-advanced:not\(\[open\]\)>\.nav-group-items\{display:\s*none\}/)
  // 不能靠隐藏页面横向滚动"修"溢出：内容会变得不可达
  assert.ok(!/width:\s*100vw/.test(CSS_NO_COMMENTS), 'no 100vw sizing (scrollbar double count)')
  for (const sel of ['html', 'body']) {
    assert.ok(!/overflow-x:\s*(hidden|clip)/.test(rule(CSS, sel)), sel + ' must not mask overflow with overflow-x')
  }
  // 长表格仍然在容器内横向滚动（可达、可聚焦），而不是被裁掉
  assert.match(rule(CSS, '.table-wrap'), /overflow-x:\s*auto/)
  // 折叠导航/技术折叠区的可点击高度仍 >= 40px
  assert.match(rule(CSS, '.nav-group-summary'), /min-height:\s*var\(--control-h\)/)
  assert.match(rule(CSS, '.advanced>summary'), /min-height:\s*var\(--control-h\)/)
  // A1/A2 新 class 必须有设计系统样式（否则就是浏览器默认排版）
  for (const sel of ['.overall-card .card-body', '.home-overall-title', '.home-cta', '.home-status-list',
    '.home-status-tags', '.home-status-model', '.home-tech-note', '.advanced']) {
    assert.ok(rule(CSS, sel).length > 0, 'missing design-system rule for ' + sel)
  }
})

// ---------- 6b. statusRow：label/value/detail 与 level 映射 ----------
test('visual: statusRow 渲染 label/value/detail，且证据等级映射不为“已验证”假绿', () => {
  const row = statusRow({ label: 'OpenCode Go', value: '已检测', detail: '只读取本地登录文件，未做推理', level: 'detected' })
  assert.equal(row.getAttribute('role'), 'group')
  assert.match(row.textContent, /OpenCode Go/)
  assert.match(row.textContent, /已检测/)
  assert.match(row.textContent, /只读取本地登录文件/)
  assert.match(row.className, /is-muted/)
  assert.equal(row.dataset.level, 'muted')
  const label = find(row, (el) => el.className === 'status-row-label')
  assert.equal(row.getAttribute('aria-labelledby'), label.id, 'status row must be labelled by its label node')
  const detail = find(row, (el) => el.className === 'status-row-detail')
  assert.equal(row.getAttribute('aria-describedby'), detail.id)

  const map = { good: 'good', ok: 'good', 'runtime-verified': 'good', warn: 'warn', error: 'bad', blocked: 'bad', configured: 'info', detected: 'muted', unknown: 'muted', missing: 'muted' }
  for (const [input, expected] of Object.entries(map)) {
    assert.equal(statusLevel(input), expected, input + ' must map to ' + expected)
    const node = statusRow({ label: 'x', value: 'y', level: input })
    assert.match(node.className, new RegExp('is-' + expected))
    assert.equal(node.dataset.level, expected)
  }
  // 未给 level 时不得默认成绿色
  assert.equal(statusRow({ label: 'x' }).dataset.level, 'muted')
  // action 槽位保留
  const action = h('button', { class: 'btn btn-sm', type: 'button', text: '查看' })
  assert.equal(byTag(statusRow({ label: 'x', detail: 'd', action }), 'button').length, 1)
})

// ---------- 7. primaryAction：disabled/busy 真正不可点击 ----------
test('visual: primaryAction disabled 时无 click 处理器且带 disabled/aria-disabled', () => {
  let clicks = 0
  const blocked = primaryAction({ label: '连接 OpenCode Go', detail: '保存 Key 不会发送推理请求', disabled: true, onclick: () => { clicks++ } })
  const blockedBtn = byTag(blocked, 'button')[0]
  assert.ok(blockedBtn, 'primaryAction must render a button')
  assert.equal(blockedBtn.disabled, true)
  assert.equal(blockedBtn.getAttribute('aria-disabled'), 'true')
  assert.equal(blockedBtn.getAttribute('aria-busy'), null)
  assert.equal(click(blockedBtn), 0, 'disabled action must not register a click listener')
  assert.equal(clicks, 0)
  assert.match(blocked.textContent, /保存 Key 不会发送推理请求/)

  const busy = primaryAction({ label: '正在启用聚合', busy: true, onclick: () => { clicks++ } })
  const busyBtn = byTag(busy, 'button')[0]
  assert.equal(busyBtn.disabled, true, 'busy implies disabled')
  assert.equal(busyBtn.getAttribute('aria-busy'), 'true')
  assert.equal(click(busyBtn), 0)
  const live = findAll(busy, (el) => el.getAttribute('role') === 'status')
  assert.ok(live.length >= 1, 'busy state needs one polite status announcement')

  const ready = primaryAction({ label: '启用聚合', detail: '一次确认后原子写入', onclick: (e) => { clicks++; assert.equal(e.type, 'click') } })
  const readyBtn = byTag(ready, 'button')[0]
  assert.notEqual(readyBtn.disabled, true)
  assert.equal(readyBtn.getAttribute('aria-disabled'), null)
  assert.equal(click(readyBtn), 1)
  assert.equal(clicks, 1)
})

// ---------- 8. formField：label/hint/error 完整关联 ----------
test('visual: formField 关联 label for=input id，错误经 aria-invalid + aria-describedby', () => {
  const input = document.createElement('input')
  input.setAttribute('type', 'password')
  const wrap = formField({
    id: 'go-key',
    label: 'OpenCode Go API Key',
    hint: '只保存在服务端加密键存储，不会回显。',
    error: 'Key 不能为空',
    required: true,
    input,
  })
  assert.equal(input.id, 'go-key')
  assert.equal(input.getAttribute('id'), 'go-key')
  const label = find(wrap, (el) => el.tagName === 'LABEL')
  assert.equal(label.getAttribute('for'), 'go-key')
  assert.match(label.textContent, /OpenCode Go API Key/)

  const hintNode = find(wrap, (el) => el.className === 'form-hint')
  const errorNode = find(wrap, (el) => el.className === 'form-error')
  assert.ok(hintNode && errorNode, 'hint and error nodes must render')
  const described = input.getAttribute('aria-describedby').split(/\s+/)
  assert.ok(described.includes(hintNode.id), 'hint must be referenced by aria-describedby')
  assert.ok(described.includes(errorNode.id), 'error must be referenced by aria-describedby')
  assert.equal(input.getAttribute('aria-invalid'), 'true')
  assert.equal(input.getAttribute('aria-errormessage'), errorNode.id)
  assert.equal(input.getAttribute('aria-required'), 'true')
  assert.equal(errorNode.getAttribute('role'), 'alert')
  assert.match(wrap.className, /is-invalid/)

  // 无错误时不谎报 invalid
  const clean = document.createElement('input')
  const cleanWrap = formField({ id: 'clean', label: '模型', hint: '仅 deepseek-v4.1-flash', input: clean })
  assert.equal(clean.getAttribute('aria-invalid'), null)
  assert.match(cleanWrap.className, /form-field/)
  assert.match(cleanWrap.textContent, /仅 deepseek-v4.1-flash/)

  // 旧 field() 保持签名并同样关联 aria
  const legacyInput = document.createElement('input')
  const legacy = components.field('供应商 ID', legacyInput, { help: '唯一配置键', error: '必填' })
  assert.equal(legacyInput.getAttribute('aria-invalid'), 'true')
  assert.match(legacyInput.getAttribute('aria-describedby') || '', /-help/)
  assert.match(legacyInput.getAttribute('aria-describedby') || '', /-error/)
  assert.equal(find(legacy, (el) => el.tagName === 'LABEL').getAttribute('for'), legacyInput.id)
})

// ---------- 9. stepper：aria-current + 方向键 ----------
test('visual: stepper 当前步 aria-current="step"，方向键移动焦点并回传选择', () => {
  const selected = []
  const track = stepper({
    steps: [{ id: 'key', label: '填写 Key' }, { id: 'model', label: '选择模型', hint: '仅 DeepSeek' }, { id: 'enable', label: '启用聚合' }],
    current: 'model',
    onSelect: (id, index) => selected.push([id, index]),
  })
  const buttons = byTag(track, 'button')
  assert.equal(buttons.length, 3)
  assert.equal(track.getAttribute('aria-label'), '步骤')
  assert.equal(buttons[1].getAttribute('aria-current'), 'step', 'current step must expose aria-current=step')
  assert.equal(buttons[0].getAttribute('aria-current'), null)
  assert.equal(buttons[2].getAttribute('aria-current'), null)
  assert.equal(buttons[1].getAttribute('tabindex'), '0')
  assert.equal(buttons[0].getAttribute('tabindex'), '-1')
  assert.match(track.textContent, /仅 DeepSeek/)

  assert.equal(dispatch(buttons[1], 'keydown', { key: 'ArrowRight' }), 1)
  assert.deepEqual(selected, [['enable', 2]], 'ArrowRight must select the next step')
  assert.equal(document.activeElement, buttons[2], 'ArrowRight must move focus')
  dispatch(buttons[1], 'keydown', { key: 'ArrowLeft' })
  assert.deepEqual(selected, [['enable', 2], ['key', 0]])
  assert.equal(document.activeElement, buttons[0])
  dispatch(buttons[0], 'keydown', { key: 'End' })
  assert.deepEqual(selected[2], ['enable', 2])
  // 其它键不触发选择
  dispatch(buttons[0], 'keydown', { key: 'a' })
  assert.equal(selected.length, 3)
})

// ---------- 10. dialog/confirmDialog：Escape、焦点圈定、焦点归还 ----------
test('visual: dialog 支持 Escape 关闭、焦点圈定与关闭后焦点归还', async () => {
  const root = document.getElementById('dialog-root')
  const trigger = document.createElement('button')
  trigger.setAttribute('class', 'btn')
  document.body.append(trigger)
  trigger.focus()
  assert.equal(document.activeElement, trigger)

  let closed = 0
  const d = dialog({ title: '确认退出聚合', desc: '只回滚 ModelGate 改过的字节', content: h('p', { class: 'muted', text: '原登录状态会恢复。' }), onClose: () => { closed++ } })
  assert.equal(root.hidden, false)
  assert.equal(d.el.getAttribute('role'), 'dialog')
  assert.equal(d.el.getAttribute('aria-modal'), 'true')
  const titleId = d.el.getAttribute('aria-labelledby')
  assert.ok(titleId, 'dialog must be labelled')
  assert.equal(find(d.el, (el) => el.id === titleId).textContent, '确认退出聚合')
  assert.notEqual(d.el.getAttribute('aria-describedby'), null)

  await tick(40)
  assert.ok(d.el.contains(document.activeElement), 'focus must move inside the dialog')

  // 焦点圈定：Tab 从最后一个可聚焦元素回到第一个
  const buttons = byTag(d.el, 'button')
  const last = buttons[buttons.length - 1]
  last.focus()
  assert.equal(dispatchDocument('keydown', { key: 'Tab' }), 1)
  assert.equal(document.activeElement, buttons[0], 'Tab from last must wrap to first')
  // Shift+Tab 从第一个回到最后一个
  buttons[0].focus()
  dispatchDocument('keydown', { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, last)

  // Escape 关闭 + 焦点归还（异步、下一帧）
  dispatchDocument('keydown', { key: 'Escape' })
  assert.equal(root.hidden, true)
  assert.equal(root.children.length, 0, 'dialog content must be cleared')
  assert.equal(closed, 1)
  await tick(10)
  assert.equal(document.activeElement, trigger, 'focus must return to the trigger')
  assert.equal((documentListeners.keydown || []).length, 0, 'Escape listener must be removed')
  trigger.remove()
})

test('visual: confirmDialog 的 Escape/取消路径必须 resolve(false)，确认 resolve(true)', async () => {
  const root = document.getElementById('dialog-root')
  const cancelled = confirmDialog({ title: '退出并恢复？', message: '会恢复原先的 Codex 设置。', danger: true })
  assert.equal(root.hidden, false)
  assert.ok(byTag(root, 'button').some((b) => b.className.includes('btn-danger')), 'danger confirm must use the danger style')
  dispatchDocument('keydown', { key: 'Escape' })
  assert.equal(await cancelled, false, 'Escape must resolve false, never hang')

  // 401 清理会直接清空 #dialog-root；closeDialog 负责同时摘掉键盘监听
  dialog({ title: '将被外部清理', content: h('p', { text: 'x' }) })
  assert.equal(components.closeDialog(), true)
  assert.equal(root.hidden, true)
  assert.equal(root.children.length, 0)
  assert.equal((documentListeners.keydown || []).length, 0)
  assert.equal(components.closeDialog(), false, 'closing twice must be a no-op')

  const confirmed = confirmDialog({ title: '启用聚合？', message: '一次确认后写入。' })
  const ok = byTag(root, 'button').find((b) => b.className.includes('btn-primary'))
  assert.ok(ok, 'confirm button must be the primary CTA')
  click(ok)
  assert.equal(await confirmed, true)
  await tick(5)
  assert.equal(root.hidden, true)
})
