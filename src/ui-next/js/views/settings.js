// 设置页：5 个分段标签 + 基础配置三栏卡片。
// 写操作边界：本页基础字段按真实 /api/status、/api/config 投影只读展示；
// 字段未映射到受控写接口时禁用输入，绝不伪装保存成功。安全与运维 tab 保留原有受控配置事务。
import { h, clear } from '../dom.js'
import { state, loadAll } from '../store.js'
import { api } from '../api.js'
import { ensureDraft, setDraft } from '../config-draft.js'
import { reviewAndSave, dirtyChip, sanitizeDiff, sourceSummary, expiryStates } from '../save-flow.js'
import {
  pageHead, card, callout, field, codeBlock, copyButton, kvList, tag, dialog, toast, tabs, table, empty,
} from '../components.js'
import { fmtTime, fmtDuration, fmtInt, pretty, maskHeaderValue, clone } from '../format.js'

const SETTINGS_TABS = Object.freeze([
  { id: 'basic', label: '⚙ 基础配置' },
  { id: 'providers', label: '▤ 供应商 & 模型' },
  { id: 'routing', label: '⇄ 路由策略' },
  { id: 'clients', label: '▣ 客户端接入' },
  { id: 'security', label: '🛡 安全与运维' },
])
const view = { tab: 'basic' }

function numField(draft, obj, key, label, help) {
  const input = h('input', { type: 'number', min: '0', step: '1', value: obj[key] == null ? '' : String(obj[key]) })
  input.addEventListener('change', () => {
    const v = input.value === '' ? 0 : Number(input.value)
    obj[key] = Number.isFinite(v) && v >= 0 ? v : 0
    input.value = String(obj[key])
    draftChanged(draft)
  })
  return field(label, input, { help })
}
function textField(draft, obj, key, label, help, placeholder) {
  const input = h('input', { type: 'text', value: obj[key] == null ? '' : String(obj[key]), placeholder: placeholder || '' })
  input.addEventListener('change', () => { obj[key] = input.value.trim(); draftChanged(draft) })
  return field(label, input, { help })
}
function draftChanged(draft) {
  const chip = document.getElementById('dirty-chip-slot')
  if (chip) { clear(chip); const c = dirtyChip(draft.isDirty()); if (c) chip.append(c) }
  const btn = document.getElementById('save-defaults')
  if (btn) btn.disabled = !draft.isDirty()
}

// 管理面导出：脱敏后的可编辑配置投影；不包含服务端私有/凭据字段（投影本身就不含 _keys）。
export function sanitizeForExport(config) {
  const out = clone(config)
  out.defaults = out.defaults || {}
  if (out.defaults.clientKey) out.defaults.clientKey = '********'
  for (const p of Object.values(out.providers || {})) {
    if (p.extraHeaders) {
      const headers = {}
      for (const [k, v] of Object.entries(p.extraHeaders)) headers[k] = maskHeaderValue(k, v)
      p.extraHeaders = headers
    }
    if (typeof p.proxy === 'string' && p.proxy) {
      try { const u = new URL(p.proxy); if (u.username) u.username = '****'; if (u.password) u.password = '****'; p.proxy = u.toString() } catch {}
    }
  }
  return out
}
function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: filename, style: { display: 'none' } })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  toast('已导出脱敏配置 JSON', 'success')
}

// ---------- 基础配置：只读三栏 ----------
function settingRow (label, control, sub) {
  return h('div', { class: 'setting-row' },
    h('div', { class: 'setting-row-main' },
      h('span', { class: 'setting-label', text: label }),
      sub ? h('span', { class: 'setting-sub', text: sub }) : null),
    control || null)
}
function readonlyText (value, title) {
  return h('span', { class: 'setting-readonly mono', title: title || '只读：按真实配置投影展示', text: value == null || value === '' ? '—' : String(value) })
}
function readonlySwitch (checked, title) {
  return h('label', { class: 'setting-switch', title: title || '只读：该字段尚未映射到受控写接口' },
    h('input', { type: 'checkbox', checked: !!checked, disabled: true, 'aria-label': '只读开关' }),
    h('span', { class: 'setting-switch-track', 'aria-hidden': 'true' }))
}
function readonlySelect (options, selected, label) {
  return h('select', {
    class: 'setting-select',
    disabled: true,
    'aria-label': label,
    title: '只读：该字段尚未映射到受控写接口',
  }, options.map((o) => h('option', { value: o.value, selected: o.value === selected, text: o.label })))
}
function readonlyNumber (value, suffix, label) {
  return h('div', { class: 'setting-number' },
    h('input', {
      type: 'number', min: '0', step: '1', value: value == null ? '' : String(value),
      disabled: true, 'aria-label': label, title: '只读：该字段尚未映射到受控写接口',
    }),
    h('span', { class: 'setting-unit', text: suffix }))
}

function modeLabel (status, product) {
  const mode = (product && product.aggregation && product.aggregation.mode)
    || (status && status.aggregation && status.aggregation.mode)
    || ''
  if (mode === 'aggregated') return '聚合模式'
  if (mode === 'route') return '路由模式'
  if (mode === 'official') return '官方直连'
  return ''
}

function renderBasic (root, ctx) {
  const s = state.status || {}
  const c = state.config || {}
  const server = s.server || {}
  const defaults = c.defaults || {}
  const timeout = defaults.timeout || {}
  const retry = defaults.retry || {}
  const concurrency = defaults.concurrency || {}
  const listen = 'http://' + (server.host || '127.0.0.1') + ':' + (server.port || 8787)
  let product = null
  try { product = (ctx && typeof ctx.product === 'function') ? ctx.product() : null } catch { product = null }

  root.append(callout('info', h('strong', { text: '只读展示：' }),
    ' 本页字段取自真实 /api/status 与 /api/config 投影；当前未映射到受控写接口，因此输入均禁用。' +
    '不会伪装保存成功；需要修改时请走受控配置事务（见「安全与运维」）。'))

  const serviceCard = card('网关服务', '来自 /api/status 的运行事实', h('div', { class: 'setting-rows' },
    settingRow('服务状态', state.status ? tag('运行中', 'good') : tag('未知', 'muted')),
    settingRow('监听地址', h('span', { class: 'setting-copy' }, readonlyText(listen), copyButton(listen, '📋'))),
    settingRow('开机自启', readonlySwitch(c.server && c.server.autostart, '配置投影未导出该字段，按未启用展示'), '受控写接口未映射'),
    settingRow('请求日志', readonlySwitch(c.server && c.server.requestLog, '配置投影未导出该字段，按未启用展示'), '记录请求与响应（用于调试）')), { className: 'settings-col-card' })

  const providerOptions = [...new Set([
    ...Object.keys(c.providers || {}),
    ...((Array.isArray(s.providers) ? s.providers : []).map((p) => p && p.id).filter(Boolean)),
  ])].map((id) => ({ value: id, label: id }))
  const modelOptions = Object.keys(c.models || {}).map((name) => ({ value: name, label: name }))
  const modeOptions = [
    { value: '', label: '—' },
    { value: 'route', label: '路由模式' },
    { value: 'aggregated', label: '聚合模式' },
    { value: 'official', label: '官方直连' },
  ]
  const proxyCard = card('代理与模式', '当客户端未指定模型时使用以下默认配置', h('div', { class: 'setting-rows' },
    settingRow('默认模式', readonlySelect(modeOptions, (() => {
      const m = modeLabel(s, product)
      return m === '路由模式' ? 'route' : m === '聚合模式' ? 'aggregated' : m === '官方直连' ? 'official' : ''
    })())),
    settingRow('默认 Provider', readonlySelect([{ value: '', label: '—' }, ...providerOptions], c.defaults && (c.defaults.provider || c.defaults.defaultProvider) || '')),
    settingRow('默认模型', readonlySelect([{ value: '', label: '—' }, ...modelOptions], c.defaults && (c.defaults.model || c.defaults.defaultModel) || '')),
    h('p', { class: 'setting-hint', text: 'ⓘ 当客户端未指定模型时使用以上默认配置。' })), { className: 'settings-col-card' })

  const timeoutSec = Number.isFinite(Number(timeout.overallMs)) && Number(timeout.overallMs) > 0
    ? Math.round(Number(timeout.overallMs) / 1000) : ''
  const otherCard = card('其他', '韧性参数与健康检查来自 /api/config', h('div', { class: 'setting-rows' },
    settingRow('请求超时', readonlyNumber(timeoutSec, '秒', '请求超时（秒）')),
    settingRow('重试次数', readonlyNumber(retry.maxAttempts, '次', '重试次数')),
    settingRow('并发上限', readonlyNumber(concurrency.maxPerProvider, '', '并发上限')),
    settingRow('启用健康检查', readonlySwitch(c.healthCheck && c.healthCheck.enabled, '配置投影未导出该字段，按未启用展示'), '定期检测上游可用性')), { className: 'settings-col-card' })

  root.append(h('div', { class: 'settings-columns' }, serviceCard, proxyCard, otherCard))
}

// ---------- 其他 tab：真实投影 + 链接，不伪造可写控件 ----------
function renderProvidersTab (root) {
  const s = state.status || {}
  const providers = Array.isArray(s.providers) ? s.providers : []
  const models = Array.isArray(s.models) ? s.models : []
  root.append(callout('info', h('strong', { text: '只读清单：' }), ' 供应商与模型来自 /api/status；新增/修改请走「连接」页或受控管理 API。'))
  root.append(card('供应商', '当前网关已配置的真实上游',
    providers.length
      ? table([
        { label: 'ID', render: (p) => h('span', { class: 'mono', text: String(p.id || '—') }) },
        { label: '状态', render: (p) => tag(String((p.st && p.st.state) || 'unknown'), 'muted') },
        { label: '请求', className: 'num', render: (p) => fmtInt(p.st && p.st.requests) },
      ], providers, { compact: true })
      : empty('暂无供应商', '/api/status 的 providers 为空。'), { className: 'settings-col-card' }))
  root.append(card('模型', '当前网关可路由的真实模型',
    models.length
      ? table([
        { label: '模型', render: (m) => h('span', { class: 'mono', text: String(m.name || '—') }) },
        { label: '请求', className: 'num', render: (m) => fmtInt(m.requests) },
        { label: 'Token', className: 'num', render: (m) => fmtCompactSafe(m.tokens) },
      ], models, { compact: true })
      : empty('暂无模型', '/api/status 的 models 为空。'), { className: 'settings-col-card' }))
}

function fmtCompactSafe (v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

function renderRoutingTab (root, ctx) {
  let product = null
  try { product = (ctx && typeof ctx.product === 'function') ? ctx.product() : null } catch { product = null }
  const mode = modeLabel(state.status || {}, product) || '状态未知'
  root.append(card('当前路由模式', '来自真实状态投影；切换模式属于受控写操作，请在连接页完成。',
    h('div', null,
      h('p', { class: 'setting-mode-current', text: mode }),
      h('a', { class: 'usage-more', href: '#/connections', text: '前往连接页切换 ›' })), { className: 'settings-col-card' }))
  root.append(callout('info', '路由策略的详细参数由网关配置文件与受控管理 API 维护；本页不提供未映射的写入控件。'))
}

function renderClientsTab (root) {
  root.append(card('客户端接入', '把本机 Codex / 客户端指向 ModelGate 的受控流程在客户端接入页。',
    h('div', null,
      callout('info', '本 tab 不新增令牌或密钥输入框；客户端凭据只经受控 API 写入，且不会在前端明文展示。'),
      h('a', { class: 'usage-more', href: '#/clients', text: '前往客户端接入 ›' })), { className: 'settings-col-card' }))
}

// ---------- 安全与运维：保留原有受控配置事务 ----------
function renderSecurityTab (root, ctx) {
  const s = state.status || {}
  const c = state.config || {}
  if (!state.config) {
    root.append(callout('warn', h('strong', { text: '未知：' }), 'GET /api/config 尚未返回；无法展示可编辑配置、草稿差异或导出。'))
    return
  }
  const d = ensureDraft(c)
  const rerender = ctx.rerender || (() => { location.hash = '#/settings' })

  root.append(h('div', { class: 'grid grid-main' },
    card('实例信息', '来自 /api/status 与 /api/config', kvList([
      ['访问地址', location.origin],
      ['绑定主机', s.server?.host || '—'],
      ['端口', String(s.server?.port || '—')],
      ['进程启动', fmtTime(s.startedAt)],
      ['运行时长', fmtDuration(s.uptimeMs)],
      ['配置版本', String(c.configVersion ?? s.configVersion ?? '—')],
      ['管理面保护', '仅回环 + Host/Origin，无令牌'],
      ['密钥文件加密', s.server?.keyEncrypted ? '已启用' : '未确认'],
    ])),
    card('管理面保护', '所有者授权的安全降级：管理面无令牌，仅回环绑定 + Host/Origin 来源校验',
      callout('info', h('strong', { text: '安全下界：' }), ' 管理 API 仅接受本机回环来源（除非显式 allowRemote），并校验 Host 与 Origin 防止 DNS 重绑定与跨源请求；不再签发或校验任何管理令牌。'),
      { foot: h('span', { text: '当前：无令牌 · 仅回环 + Host/Origin 保护' }) })))

  const retry = (d.data.defaults.retry = d.data.defaults.retry || {})
  const timeout = (d.data.defaults.timeout = d.data.defaults.timeout || {})
  const concurrency = (d.data.defaults.concurrency = d.data.defaults.concurrency || {})
  const proxySel = h('select', null, ['auto', 'direct', 'global'].map((v) => h('option', { value: v, selected: (d.data.defaults.proxyMode || 'auto') === v, text: v })))
  proxySel.addEventListener('change', () => { d.data.defaults.proxyMode = proxySel.value; draftChanged(d) })
  const saveBtn = h('button', { class: 'btn btn-primary', id: 'save-defaults', type: 'button', text: '查看变更并保存', disabled: !d.isDirty() })
  saveBtn.addEventListener('click', () => reviewAndSave(d, { onSaved: () => { setDraft(null); rerender() }, onError: () => draftChanged(d) }))
  const paramsBody = h('div', null,
    h('div', { class: 'grid grid-3' },
      numField(d, retry, 'maxAttempts', '单上游最大尝试次数', 'retry.maxAttempts；0 或 1 表示不重试'),
      numField(d, retry, 'initialDelayMs', '初始退避（ms）', 'retry.initialDelayMs'),
      numField(d, retry, 'maxDelayMs', '最大退避（ms）', 'retry.maxDelayMs')),
    h('div', { class: 'grid grid-3' },
      numField(d, timeout, 'connectMs', '建连超时（ms）', 'timeout.connectMs'),
      numField(d, timeout, 'firstByteMs', '首字节超时（ms）', 'timeout.firstByteMs'),
      numField(d, timeout, 'idleMs', '空闲超时（ms）', 'timeout.idleMs')),
    h('div', { class: 'grid grid-3' },
      numField(d, timeout, 'overallMs', '整体预算（ms，0=不限）', 'timeout.overallMs'),
      numField(d, timeout, 'loopMs', '目录链兜底循环（ms）', 'timeout.loopMs'),
      numField(d, concurrency, 'maxPerProvider', '每上游并发', 'concurrency.maxPerProvider')),
    h('div', { class: 'grid grid-2' },
      field('代理模式', proxySel, { help: 'auto=按上游配置；direct=全部直连；global=非回环上游走全局代理' }),
      textField(d, d.data.defaults, 'proxy', '全局代理地址', '留空=继承环境变量；支持 http(s)://user:pass@host:port')),
    h('div', { class: 'flex flex-wrap mt-3', style: { justifyContent: 'space-between' } },
      h('div', { class: 'flex', id: 'dirty-chip-slot' }, dirtyChip(d.isDirty())),
      h('div', { class: 'flex' },
        h('button', { class: 'btn', type: 'button', text: '放弃更改', onclick: () => { d.reset(); rerender() } }),
        saveBtn)))
  root.append(card('请求韧性参数', '修改后不会立即生效，需保存配置并重新加载路由', paramsBody,
    { foot: '保存会推进 configVersion；并发修改返回 409，不会静默覆盖。' }))

  const nativeSave = h('button', { class: 'btn btn-primary', type: 'button', text: '保存采集路径' })
  nativeSave.addEventListener('click', () => reviewAndSave(d, { onSaved: () => { setDraft(null); rerender() }, onError: () => draftChanged(d) }))
  const nu = s.nativeUsage || {}
  root.append(card('原生 / 直连用量采集（只读）', '只汇总 Codex 本地会话日志的 token 计数；不读取消息内容，也不代理原生流量',
    h('div', null,
      callout('info', h('strong', { text: '为什么需要它：' }), ' 原生 ChatGPT/直连流量不经过网关，网关无法统计。开启后从 Codex sessions 日志只读汇总。'),
      textField(d, d.data.defaults, 'nativeUsageDir', 'Codex sessions 目录', '例如 ~/.codex/sessions；留空或 off 关闭。只读取 token_count，不读取消息正文。', '~/.codex/sessions'),
      h('div', { class: 'flex flex-wrap mt-2' }, nativeSave),
      h('p', { class: 'hint', text: '当前生效：' + (nu.enabled ? '已启用 · ' + (nu.dirLabel || '—') : '未启用') + '。' })),
    { foot: '该目录由网关进程用户读取；不要指向包含凭据的目录。' }))

  const draftDiff = d.isDirty() ? sanitizeDiff(d.diff()) : []
  const expiries = expiryStates(c)
  root.append(card('生效配置 vs 草稿', '保存前核对；敏感值只显示状态不显示值。',
    h('div', null,
      callout('info', h('strong', { text: '来源：' }), ' ' + sourceSummary(d)),
      draftDiff.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'diff-table' },
          h('thead', null, h('tr', null, h('th', { text: '字段' }), h('th', { text: '生效值' }), h('th', { text: '草稿值' }))),
          h('tbody', null, draftDiff.slice(0, 200).map((row) => h('tr', null,
            h('td', { class: 'path', text: row.path }),
            h('td', { class: 'old', text: row.before }),
            h('td', { class: 'new', text: row.after }))))))
        : callout('good', '草稿与生效配置一致，没有待保存差异。'),
      expiries.length
        ? h('p', { class: 'hint', text: '虚拟模型有效期（后端 expiresAtState）：' + expiries.map((e) => e.name + '=' + e.state).join(' · ') })
        : null)))

  const exportButtons = h('div', { class: 'flex flex-wrap' },
    copyButton(JSON.stringify({ configVersion: c.configVersion, providers: Object.keys(c.providers || {}).length, models: Object.keys(c.models || {}).length }), '复制版本摘要'),
    h('button', { class: 'btn', type: 'button', text: '导出管理配置投影（脱敏）', onclick: () => downloadJson('modelgate-config-' + (c.configVersion ?? 0) + '.json', sanitizeForExport(c)) }),
    h('button', { class: 'btn', type: 'button', text: '查看原始配置', onclick: () => dialog({ title: '只读配置投影', desc: '敏感 header 与代理凭据已由后端脱敏；请勿截图分享。', wide: true, content: codeBlock(pretty(c)) }) }))
  root.append(card('配置事务与导出', '当前可编辑配置投影，不含明文 Key',
    h('div', null,
      callout('info', 'GET /api/config 只返回可编辑字段与 configVersion；运行时统计与凭据不在其中。保存时先请求持久预览，再经自定义确认对话框应用；服务端按 expectedVersion 执行 CAS。'),
      exportButtons),
    { foot: '差异先在本标签页脱敏核对；预览请求只包含可编辑字段，服务端仅持久化哈希与动作摘要，确认后再应用。' }))

  root.append(card('备份与恢复', '当前后端没有备份/恢复管理 API',
    h('div', null,
      callout('info', h('strong', { text: '旧面板仍可用：' }), ' /admin（旧 UI）作为回退入口保留。退役条件：核心操作与本页等价、双跑通过、真实浏览器 E2E 有证据。'),
      callout('warn', h('strong', { text: '恢复功能未实现，页面不会伪装成功。' }), ' 网关配置以原子写落盘；需要回滚时请使用文件系统备份（git 不跟踪 gateway.local.json 与 keys.local.json）。'))))
}

export function render (root, ctx = {}) {
  root.append(pageHead('设置', '基础配置、供应商与模型、路由策略、客户端接入与安全运维；写操作只走受控 API。', { eyebrow: 'GOVERNANCE / SETTINGS' }))
  const bar = tabs(SETTINGS_TABS.map((t) => ({ ...t, controls: 'settings-panel-' + t.id })), view.tab, (id) => {
    if (!SETTINGS_TABS.some((t) => t.id === id)) return
    view.tab = id
    if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
  })
  root.append(bar)
  const panel = h('div', {
    class: 'settings-panel',
    id: 'settings-panel-' + view.tab,
    role: 'tabpanel',
    'aria-labelledby': 'tab-' + view.tab,
  })
  root.append(panel)
  if (view.tab === 'basic') renderBasic(panel, ctx)
  else if (view.tab === 'providers') renderProvidersTab(panel)
  else if (view.tab === 'routing') renderRoutingTab(panel, ctx)
  else if (view.tab === 'clients') renderClientsTab(panel)
  else renderSecurityTab(panel, ctx)
}
