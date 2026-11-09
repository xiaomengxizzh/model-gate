// 模型与路由：真实模型 / 虚拟模型 CRUD 走共享草稿与版本化保存；预演只读；测试显式确认费用。
import { h, clear, icon } from '../dom.js'
import {
  pageHead, card, metric, tag, callout, empty, table, field, dialog, confirmDialog, toast, tabs, kvList, sectionTitle,
} from '../components.js'
import { state, loadAll, loadStatus } from '../store.js'
import { ensureDraft, setDraft } from '../config-draft.js'
import { reviewAndSave, dirtyChip } from '../save-flow.js'
import { api } from '../api.js'
import { fmtInt, fmtMs, fmtAgo, parseKv, kvText } from '../format.js'

const CAPABILITIES = ['chat', 'embedding', 'rerank', 'audio', 'image', 'video']
const CAP_KIND = { chat: 'accent', embedding: 'info', rerank: 'info', audio: 'warn', image: 'warn', video: 'warn' }
const EXPERIMENTAL = new Set(['audio', 'image', 'video'])
const PROTOCOLS = ['openai', 'anthropic', 'gemini', 'cohere', 'responses']
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const NUMERIC_FIELDS = ['maxContext', 'maxTokensMax', 'dailyQuota', 'quota', 'maxConcurrent', 'qps']
const NUMERIC_LABELS = {
  maxContext: 'maxContext',
  maxTokensMax: 'maxTokensMax',
  dailyQuota: 'dailyQuota（日 token）',
  quota: 'quota（总 token）',
  maxConcurrent: 'maxConcurrent',
  qps: 'qps',
}

let activeTab = 'real'
let modelQuery = ''
let modelCap = 'all'
let previewInput = ''
let previewState = null
let previewBusy = false
let seq = 0
const nextId = (prefix = 'md') => prefix + '-' + (++seq)
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)
const asArray = (value) => (Array.isArray(value) ? value : [])

function makeInput(props) {
  const el = h('input', props)
  if (!el.id) el.id = nextId()
  return el
}
function makeSelect(options, value) {
  const el = h('select', null, options.map((o) => h('option', { value: o.value, text: o.label, selected: String(value == null ? '' : value) === String(o.value) })))
  el.id = nextId()
  return el
}
function labeled(label, input, opts = {}) {
  if (!input.id) input.id = nextId()
  return field(label, input, opts)
}
function sectionHeading(text, hint) {
  return sectionTitle(text, hint)
}
function parseList(text) {
  const seen = new Set()
  return String(text || '').split(/[,，\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => { if (seen.has(part)) return false; seen.add(part); return true })
}
function limitText(value) {
  if (value == null || value === '') return '不限'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n > 0 ? fmtInt(n) : '不限'
}
function capTag(value) {
  const cap = CAPABILITIES.includes(String(value)) ? String(value) : 'chat'
  return tag(EXPERIMENTAL.has(cap) ? cap + ' · 实验' : cap, CAP_KIND[cap])
}
function probeShort(probe) {
  if (!probe) return '未探活'
  return (probe.ok ? '通过' : '失败') + ' ' + (probe.code == null ? '—' : probe.code) + ' · ' + fmtMs(probe.ms) + ' · ' + fmtAgo(probe.at)
}
function expiryInputValue(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return ''
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return s
  const d = new Date(n)
  const pad = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
function normalizeExpiry(text) {
  const s = String(text || '').trim()
  if (!s) return ''
  if (/^\d+$/.test(s)) return s
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? String(t) : null
}
function fmtExpiry(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return new Date(n).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function expiryText(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return '永久'
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return fmtExpiry(n)
  return s
}
function expiryIsNumeric(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return false
  return Number.isFinite(Number(s))
}
function expiryExpired(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return false
  const n = Number(s)
  return Number.isFinite(n) && n < Date.now()
}
function virtualRelations(draft) {
  const map = new Map()
  for (const vm of asArray(draft.virtualModels)) {
    for (const e of asArray(vm && vm.directory)) {
      if (!e || !e.model) continue
      if (!map.has(e.model)) map.set(e.model, [])
      const list = map.get(e.model)
      if (!list.includes(vm.name)) list.push(vm.name)
    }
  }
  return map
}

function headerActions(draft, rerender, add) {
  const out = []
  if (draft && draft.isDirty()) {
    out.push(dirtyChip(true))
    out.push(h('button', {
      class: 'btn', type: 'button', text: '放弃更改',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '放弃未保存的配置更改',
          message: '将丢弃当前草稿中的全部上游/模型修改，恢复为远端配置快照。此操作不写入服务端。',
          confirmLabel: '放弃更改', danger: true,
        })
        if (!ok) return
        setDraft(null)
        rerender()
      },
    }))
    out.push(h('button', {
      class: 'btn btn-primary', type: 'button', text: '保存更改',
      onclick: () => reviewAndSave(draft, { onSaved: () => { setDraft(null); rerender() }, onError: () => rerender() }),
    }))
  }
  if (add) {
    out.push(h('button', {
      class: 'btn ' + (draft && draft.isDirty() ? '' : 'btn-primary'),
      type: 'button', disabled: !!add.disabled, title: add.title || '',
      onclick: add.fn,
    }, icon('plus'), add.label))
  }
  return out
}

function configErrorCard(rerender) {
  const retry = h('button', { class: 'btn btn-primary', type: 'button', text: '重新读取配置' })
  retry.addEventListener('click', async () => {
    retry.disabled = true
    try { await loadAll(); rerender() } catch (e) { retry.disabled = false; toast('重新读取失败：' + (e && e.message ? e.message : '未知错误'), 'error') }
  })
  return card('配置投影不可用', 'GET /api/config 未返回可编辑配置',
    h('div', null,
      callout('danger', h('strong', { text: '不会用状态快照反推配置。' }), ' 为避免把运行时统计写回配置文件，页面只在可编辑投影可用时启用写操作，也不会显示模拟数据。'),
      retry))
}

// ---------- 真实模型 ----------
function modelCell(row) {
  const sub = row.st && row.st.probe
    ? '探针 ' + probeShort(row.st.probe)
    : (row.m.api ? '协议覆盖 ' + row.m.api : '协议继承上游')
  return h('div', null,
    h('div', { class: 'mono cell-main', text: row.name }),
    h('div', { class: 'cell-sub', text: sub }))
}
function providerChainCell(m) {
  if (!m.provider) return tag('缺少主上游', 'bad')
  return h('div', null,
    h('span', { class: 'mono cell-main', text: m.provider }),
    (asArray(m.fallbacks).length)
      ? h('div', { class: 'cell-sub', text: '备用：' + asArray(m.fallbacks).join(' → ') })
      : h('div', { class: 'cell-sub', text: '无备用上游' }))
}
function reasoningCell(m) {
  const parts = []
  if (m.reasoning) parts.push('默认 ' + m.reasoning)
  if (asArray(m.effortOptions).length) parts.push('档位 ' + asArray(m.effortOptions).join(' / '))
  if (m.effortFormat) parts.push('格式 ' + m.effortFormat)
  if (!parts.length) return h('span', { class: 'muted', text: '—' })
  return h('div', { class: 'cell-sub', text: parts.join(' · ') })
}
function relationsCell(vms) {
  if (!vms || !vms.length) return h('span', { class: 'muted', text: '—' })
  return h('div', { class: 'flex flex-wrap' }, vms.map((name) => tag(name, 'info')))
}
function realColumns(draft, rerender) {
  return [
    { label: '模型', render: (r) => modelCell(r) },
    { label: '能力', render: (r) => capTag(r.m.capability) },
    { label: '上游链', render: (r) => providerChainCell(r.m) },
    { label: '别名', render: (r) => (asArray(r.m.alias).length ? asArray(r.m.alias).join(', ') : h('span', { class: 'muted', text: '—' })) },
    { label: 'maxContext', className: 'num', render: (r) => limitText(r.m.maxContext) },
    { label: 'maxTokensMax', className: 'num', render: (r) => limitText(r.m.maxTokensMax) },
    { label: '额度（日 / 总）', className: 'num', render: (r) => h('div', { class: 'cell-sub' }, '日 ' + limitText(r.m.dailyQuota) + ' · 总 ' + limitText(r.m.quota)) },
    { label: '并发 / QPS', className: 'num', render: (r) => h('div', { class: 'cell-sub' }, limitText(r.m.maxConcurrent) + ' / ' + limitText(r.m.qps)) },
    { label: '思考强度', render: (r) => reasoningCell(r.m) },
    { label: '请求 / 错误', className: 'num', render: (r) => h('div', null, h('div', { text: fmtInt(r.st && r.st.requests) }), h('div', { class: 'cell-sub', text: '错误 ' + fmtInt(r.st && r.st.errors) })) },
    { label: '虚拟入口', render: (r) => relationsCell(r.vms) },
    { label: '操作', render: (r) => h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => runModelTest(draft, r.name, r.m, rerender) }, icon('probe'), '测试'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openModelDialog(draft, r.name, rerender) }, icon('edit'), '编辑'),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => deleteModel(draft, r.name, rerender) }, icon('trash'), '删除')) },
  ]
}

function renderReal(draft, status, rerender) {
  const realModels = Object.entries(draft.models || {}).sort(([a], [b]) => a.localeCompare(b))
  const stats = new Map((Array.isArray(status.models) ? status.models : []).map((m) => [m.name, m]))
  const relations = virtualRelations(draft)
  const providerIds = Object.keys(draft.providers || {})
  const search = makeInput({ type: 'search', value: modelQuery, placeholder: '搜索模型名、别名、上游…', autocomplete: 'off' })
  const capSel = makeSelect([{ value: 'all', label: '全部能力' }, ...CAPABILITIES.map((c) => ({ value: c, label: c }))], modelCap)
  const count = h('span', { class: 'page-note' })
  const host = h('div')
  const add = h('button', {
    class: 'btn btn-primary', type: 'button', disabled: !providerIds.length,
    title: providerIds.length ? '' : '请先添加上游',
    onclick: () => openModelDialog(draft, null, rerender),
  }, icon('plus'), '新增真实模型')
  const apply = () => {
    const q = String(modelQuery || '').trim().toLowerCase()
    const filtered = realModels.filter(([name, m]) => {
      const cap = CAPABILITIES.includes(String(m && m.capability)) ? String(m.capability) : 'chat'
      if (modelCap !== 'all' && cap !== modelCap) return false
      if (!q) return true
      const hay = [name, m.provider, m.api, cap, ...asArray(m.alias), ...asArray(m.fallbacks), ...(relations.get(name) || [])].join(' ').toLowerCase()
      return hay.includes(q)
    })
    count.textContent = '显示 ' + filtered.length + ' / ' + realModels.length + ' 个真实模型'
    const rows = filtered.map(([name, m]) => ({ name, m, st: stats.get(name) || null, vms: relations.get(name) || [] }))
    clear(host)
    host.append(table(realColumns(draft, rerender), rows, realModels.length
      ? { emptyTitle: '没有匹配的模型', emptyDesc: '调整搜索词或能力筛选。' }
      : { emptyTitle: '还没有真实模型', emptyDesc: '添加上游后创建第一个真实模型；模型名会成为路由键。', emptyAction: add }))
  }
  search.addEventListener('input', () => { modelQuery = search.value; apply() })
  capSel.addEventListener('change', () => { modelCap = capSel.value; apply() })
  apply()
  return h('div', null,
    h('div', { class: 'toolbar' },
      h('div', { style: { width: 'min(340px, 100%)' } }, search),
      h('div', { style: { width: '150px' } }, capSel),
      h('span', { class: 'spacer' }),
      count),
    host)
}

function openModelDialog(draft, modelName, rerender) {
  const isEdit = !!modelName
  const providerIds = Object.keys(draft.providers || {}).sort()
  if (!providerIds.length) { toast('请先配置上游再创建模型', 'error'); return }
  const m = isEdit ? (draft.models[modelName] || {}) : {}
  if (isEdit && !has(draft.models, modelName)) { toast('模型不存在，可能已被其他窗口删除', 'error'); return }
  const nameInput = makeInput({ type: 'text', value: modelName || '', disabled: isEdit, autocomplete: 'off', placeholder: '例如 deepseek-chat' })
  const providerOptions = providerIds.map((id) => ({ value: id, label: id }))
  if (m.provider && !providerIds.includes(m.provider)) providerOptions.unshift({ value: m.provider, label: m.provider + '（当前配置中不存在）' })
  else if (!m.provider && isEdit) providerOptions.unshift({ value: '', label: '（未设置）' })
  const providerSel = makeSelect(providerOptions, m.provider || (isEdit ? '' : providerIds[0]))
  const aliasInput = makeInput({ type: 'text', value: asArray(m.alias).join(', '), autocomplete: 'off', placeholder: '逗号分隔，例如 ds, chat' })
  const fbInput = makeInput({ type: 'text', value: asArray(m.fallbacks).join(', '), autocomplete: 'off', placeholder: '逗号分隔的上游 ID；可留空' })
  const capSel = makeSelect(CAPABILITIES.map((c) => ({ value: c, label: c })), CAPABILITIES.includes(String(m.capability)) ? String(m.capability) : 'chat')
  const apiSel = makeSelect([{ value: '', label: '继承上游（默认）' }, ...PROTOCOLS.map((p) => ({ value: p, label: p }))], m.api || '')
  const pmArea = h('textarea', { value: kvText(m.providerModels || {}), placeholder: 'providerId: 上游侧模型名' })
  pmArea.id = nextId()
  const numInputs = {}
  for (const key of NUMERIC_FIELDS) {
    numInputs[key] = makeInput({
      type: 'number', min: '0', step: 'any',
      value: m[key] == null || Number(m[key]) === 0 ? '' : String(m[key]),
      placeholder: '0 = 不限',
    })
  }
  const reasoningInput = makeInput({ type: 'text', value: m.reasoning || '', placeholder: '例如 medium' })
  const effortInput = makeInput({ type: 'text', value: asArray(m.effortOptions).join(', '), placeholder: '逗号分隔，例如 low, medium, high' })
  const effortFmtSel = makeSelect([
    { value: '', label: '不转换（默认）' },
    { value: 'reasoning_effort', label: 'reasoning_effort' },
    { value: 'thinking', label: 'thinking' },
  ], m.effortFormat || '')
  const noStream = h('input', { type: 'checkbox', checked: !!m.forceNoStream })
  noStream.id = nextId()
  const errBox = h('div')

  const content = h('div', null,
    errBox,
    callout('info', h('strong', { text: '写入草稿：' }), '修改先进入本地配置草稿，点击保存后仍需在差异对话框中确认；未知扩展字段在原对象上保留。'),
    sectionHeading('身份与路由', '模型名是配置键；编辑时不可修改。'),
    labeled('模型名', nameInput, { help: isEdit ? '模型名是配置键，编辑时不可修改。' : '保存后作为配置键，也是客户端请求时使用的模型名。' }),
    labeled('主上游', providerSel, { help: '必填；来自当前草稿中的上游列表。' }),
    labeled('别名', aliasInput, { help: '逗号分隔；客户端可以用别名请求该模型。' }),
    labeled('备用上游', fbInput, { help: '逗号分隔的上游 ID，按顺序组成备用链；留空表示无备用。' }),
    sectionHeading('能力与协议', '非 chat 能力走独立入口；audio/image/video 标记为实验能力。'),
    h('div', { class: 'field-row' },
      labeled('能力', capSel, { help: 'chat 走对话/补全；embedding/rerank/媒体能力走各自入口。' }),
      labeled('协议覆盖', apiSel, { help: '留空表示继承上游协议；显式设置会覆盖该上游的协议。' })),
    labeled('providerModels', pmArea, { help: '每行 "上游ID: 该上游侧模型名"；同一模型在不同上游可映射到不同名字。' }),
    sectionHeading('限制与额度', '0 或留空 = 不限；非 chat 模型也可以设置额度与并发限制。'),
    h('div', { class: 'field-row-3' }, NUMERIC_FIELDS.slice(0, 3).map((key) => labeled(NUMERIC_LABELS[key], numInputs[key], { help: '0 = 不限' }))),
    h('div', { class: 'field-row-3' }, NUMERIC_FIELDS.slice(3).map((key) => labeled(NUMERIC_LABELS[key], numInputs[key], { help: '0 = 不限' }))),
    sectionHeading('思考强度', '客户端显式传入优先；这里配置默认档位、允许档位与参数格式。'),
    labeled('默认思考档位', reasoningInput, { help: '例如 low / medium / high；可留空。' }),
    h('div', { class: 'field-row' },
      labeled('允许档位', effortInput, { help: '逗号分隔；客户端传入不在列表中的档位会被本地 400。' }),
      labeled('参数格式', effortFmtSel, { help: 'reasoning_effort 为 OpenAI 风格字符串；thinking 为 MiniMax 风格对象。' })),
    sectionHeading('流式', '仅在该上游不支持流式时开启。'),
    h('div', { class: 'field' },
      h('label', { class: 'check' }, noStream, h('span', { text: '强制非流式（forceNoStream）' })),
      h('span', { class: 'field-help', text: '开启后网关会请求非流式响应；不要用它替代上游能力判断。' })))

  const cancel = h('button', { class: 'btn', type: 'button', text: '取消' })
  const save = h('button', { class: 'btn btn-primary', type: 'button', text: isEdit ? '保存修改' : '添加模型' })
  const d = dialog({
    title: isEdit ? '编辑真实模型 · ' + modelName : '新增真实模型',
    desc: '只提交可编辑配置；运行时统计与探针字段不会写回配置。',
    wide: true,
    content,
    actions: [cancel, save],
  })
  cancel.addEventListener('click', () => d.close())

  save.addEventListener('click', () => {
    const errors = []
    const name = isEdit ? modelName : nameInput.value.trim()
    if (!isEdit) {
      if (!name) errors.push('模型名不能为空')
      else if (has(draft.models, name)) errors.push('模型名「' + name + '」已存在')
      else if (RESERVED.has(name)) errors.push('模型名不能使用保留键名')
      else if (asArray(draft.virtualModels).some((v) => v.name === name)) errors.push('模型名与虚拟模型「' + name + '」冲突')
    }
    const provider = providerSel.value
    if (!has(draft.providers, provider)) errors.push('主上游不存在：' + (provider || '空'))
    const alias = parseList(aliasInput.value).filter((a) => a !== name)
    if (!isEdit) {
      for (const [mn, other] of Object.entries(draft.models || {})) {
        if (other && asArray(other.alias).includes(name)) errors.push('模型名与真实模型「' + mn + '」的别名冲突')
      }
    }
    for (const a of alias) {
      for (const vm of asArray(draft.virtualModels)) if (vm && vm.name === a) errors.push('别名「' + a + '」与虚拟模型同名')
    }
    const fallbacks = parseList(fbInput.value)
    if (fallbacks.includes(provider)) errors.push('备用上游不能与主上游相同')
    for (const fb of fallbacks) if (!has(draft.providers, fb)) errors.push('备用上游不存在：' + fb)
    const capability = CAPABILITIES.includes(capSel.value) ? capSel.value : 'chat'
    const apiValue = PROTOCOLS.includes(apiSel.value) ? apiSel.value : ''
    const providerModels = parseKv(pmArea.value)
    for (const [pid, pm] of Object.entries(providerModels)) {
      if (!has(draft.providers, pid)) errors.push('providerModels 引用了不存在的上游：' + pid)
      if (!String(pm || '').trim()) errors.push('providerModels 的上游「' + pid + '」模型名不能为空')
    }
    const numeric = {}
    for (const key of NUMERIC_FIELDS) {
      const raw = numInputs[key].value.trim()
      if (raw === '') { numeric[key] = 0; continue }
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) errors.push(NUMERIC_LABELS[key] + ' 必须是非负数')
      else numeric[key] = n
    }
    const reasoning = reasoningInput.value.trim()
    const effortOptions = parseList(effortInput.value)
    const effortFormat = ['', 'reasoning_effort', 'thinking'].includes(effortFmtSel.value) ? effortFmtSel.value : ''
    if (errors.length) {
      clear(errBox)
      errBox.append(callout('danger', h('strong', { text: '请先修正以下问题：' }),
        h('ul', { style: { margin: '4px 0 0 18px' } }, errors.map((msg) => h('li', { text: msg })))))
      return
    }
    if (isEdit && !has(draft.models, modelName)) {
      clear(errBox)
      errBox.append(callout('danger', h('strong', { text: '模型已不存在。' }), ' 可能已被其他窗口删除，请关闭对话框后刷新配置。'))
      return
    }

    const applyTo = (target) => {
      target.provider = provider
      target.alias = alias
      target.fallbacks = fallbacks
      target.capability = capability
      target.api = apiValue
      if (Object.keys(providerModels).length) target.providerModels = providerModels
      else if (has(target, 'providerModels')) delete target.providerModels
      for (const key of NUMERIC_FIELDS) target[key] = numeric[key]
      target.reasoning = reasoning
      target.effortOptions = effortOptions
      target.effortFormat = effortFormat
      target.forceNoStream = !!noStream.checked
    }
    if (isEdit) applyTo(draft.models[modelName])
    else {
      const created = {}
      applyTo(created)
      draft.models[name] = created
    }
    d.close()
    reviewAndSave(draft, { onSaved: () => { setDraft(null); rerender() }, onError: () => rerender() })
    rerender()
  })
}

async function deleteModel(draft, name, rerender) {
  const defaults = draft.defaults || {}
  const refs = []
  if (defaults.model === name) refs.push('defaults.model 默认虚拟共用名')
  if (asArray(defaults.directory).some((e) => e && e.model === name)) refs.push('默认兜底目录')
  if (asArray(defaults.preheat).some((e) => e && e.model === name)) refs.push('缓存预热')
  for (const vm of asArray(draft.virtualModels)) {
    if (asArray(vm && vm.directory).some((e) => e && e.model === name)) refs.push('虚拟模型「' + vm.name + '」目录')
  }
  const refMsg = refs.length
    ? ' 仍被 ' + refs.length + ' 处引用：' + refs.slice(0, 6).join('；') + (refs.length > 6 ? ' …' : '') + '。若保存前不移除这些引用，配置校验会拒绝保存。'
    : ' 没有默认目录或虚拟模型引用它。'
  const ok = await confirmDialog({
    title: '删除真实模型 · ' + name,
    message: '从配置草稿中删除该模型。' + refMsg + ' 保存后其运行时统计将从路由中消失。',
    confirmLabel: '删除并保存', danger: true,
  })
  if (!ok) return
  delete draft.models[name]
  reviewAndSave(draft, { onSaved: () => { setDraft(null); rerender() }, onError: () => rerender() })
  rerender()
}

async function runModelTest(draft, name, m, rerender) {
  const cap = CAPABILITIES.includes(String(m.capability)) ? String(m.capability) : 'chat'
  if (EXPERIMENTAL.has(cap)) {
    const close = h('button', { class: 'btn btn-primary', type: 'button', text: '关闭' })
    const d = dialog({
      title: '模型测试 · ' + name,
      desc: '能力：' + cap,
      content: h('div', null,
        callout('info', h('strong', { text: '未发起探测。' }), ' audio / image / video 能力按设计不提供在线探测，避免产生计费媒体生成。'),
        h('p', { class: 'muted', text: '网关不会为该能力发送模型测试请求；本操作未产生推理或媒体生成费用。' })),
      actions: [close],
    })
    close.addEventListener('click', () => d.close())
    return
  }
  const kind = cap === 'embedding' ? '/v1/embeddings 探针' : cap === 'rerank' ? '/v1/rerank 探针' : '最小 chat 补全探针'
  const dirtyNote = draft && draft.isDirty() ? ' 当前有未保存草稿；测试使用服务端已保存配置，不包含草稿修改。' : ''
  const ok = await confirmDialog({
    title: '真实调用模型 · ' + name,
    message: '会真实调用上游（' + kind + '）并可能产生费用。结论只代表本次最小探针，不代表完整生成质量、上下文长度或工具调用能力。' + dirtyNote,
    confirmLabel: '确认调用', danger: true,
  })
  if (!ok) return
  let result = null
  let callErr = null
  try {
    const res = await api.modelTest(name)
    if (res && res.result) result = res.result
    else if (res && Array.isArray(res.results)) result = res.results.find((x) => x.id === name) || null
  } catch (e) { callErr = e }
  let refreshErr = null
  try { await loadStatus() } catch (e) { refreshErr = e }
  rerender()

  const body = h('div', null)
  if (callErr) body.append(callout('danger', h('strong', { text: '模型测试请求失败：' }), callErr.message || '未知错误'))
  else if (!result) body.append(callout('warn', h('strong', { text: '接口未返回该模型的测试结果。' }), ' 可能模型已被其他窗口删除。'))
  else {
    body.append(callout(result.ok ? 'good' : 'danger',
      h('strong', { text: result.ok ? '模型测试通过' : '模型测试失败' }),
      ' · HTTP ' + (result.code == null ? '—' : result.code) + ' · ' + fmtMs(result.ms) + (result.err ? ' · ' + result.err : '')))
    body.append(kvList([
      ['模型', result.id || name],
      ['能力', cap],
      ['结果', result.ok ? '通过' : '失败'],
      ['HTTP 状态', result.code == null ? '—' : String(result.code)],
      ['耗时', fmtMs(result.ms)],
      ['错误', result.err || '—'],
    ]))
  }
  body.append(callout('warn', h('strong', { text: '测试边界：' }), '单次探针通过不代表流式、工具调用、长上下文或额度充足；失败也不总是代表模型不可用，请结合上游返回核对。'))
  const close = h('button', { class: 'btn btn-primary', type: 'button', text: '关闭' })
  const d = dialog({ title: '模型测试结果 · ' + name, content: body, actions: [close] })
  close.addEventListener('click', () => d.close())
  if (refreshErr) toast('模型测试已完成，但状态刷新失败：' + (refreshErr.message || '未知错误'), 'error')
}

// ---------- 虚拟模型 ----------
function directoryCell(entries) {
  if (!Array.isArray(entries) || !entries.length) return tag('空目录', 'bad')
  return h('div', null, entries.map((e, i) => h('div', { class: 'cell-sub', style: { whiteSpace: 'normal', marginTop: i ? '4px' : '0' } },
    h('span', { class: 'mono', text: (i + 1) + '. ' + (e && e.model ? e.model : '—') }),
    ' ',
    tag(e && e.mode === 'onFail' ? 'onFail' : 'afterAll', e && e.mode === 'onFail' ? 'warn' : 'info'),
    h('span', { text: ' · ' + (e && asArray(e.providers).length ? asArray(e.providers).join(', ') : '按模型主/备上游') }))))
}
function expiryCell(v) {
  const text = expiryText(v.expiresAt)
  const numeric = expiryIsNumeric(v.expiresAt)
  const hasValue = String(v.expiresAt == null ? '' : v.expiresAt).trim() !== ''
  return h('div', null,
    h('div', { class: 'flex flex-wrap' },
      h('span', { text: text }),
      numeric && expiryExpired(v.expiresAt) ? tag('已过期', 'bad') : null,
      hasValue && !numeric ? tag('非数字', 'warn') : null),
    hasValue && !numeric ? h('div', { class: 'cell-sub', style: { whiteSpace: 'normal' }, text: '后端按数字比较有效期；非数字值不会触发过期。' }) : null,
    v.note ? h('div', { class: 'cell-sub', style: { whiteSpace: 'normal' }, text: v.note }) : null)
}
function virtualColumns(draft, rerender) {
  return [
    {
      label: '虚拟入口',
      render: (row) => h('div', null,
        h('div', { class: 'mono cell-main', text: row.v.name }),
        h('div', { class: 'flex flex-wrap mt-2' }, row.st ? (row.st.keySet ? tag('已设 Key', 'good') : tag('未设 Key', 'muted')) : tag('Key 状态未知', 'muted')),
        h('div', { class: 'cell-sub', text: row.st ? '请求 ' + fmtInt(row.st.requests) + ' · 错误 ' + fmtInt(row.st.errors) + ' · 今日 token ' + fmtInt(row.st.today) : '运行时统计不可用' })),
    },
    { label: '目录链（顺序）', render: (row) => directoryCell(row.v.directory) },
    { label: '额度（日 / 总）', className: 'num', render: (row) => h('div', { class: 'cell-sub' }, '日 ' + limitText(row.v.dailyQuota) + ' · 总 ' + limitText(row.v.quota)) },
    { label: 'maxContext', className: 'num', render: (row) => limitText(row.v.maxContext) },
    { label: '并发 / QPS', className: 'num', render: (row) => h('div', { class: 'cell-sub' }, limitText(row.v.maxConcurrent) + ' / ' + limitText(row.v.qps)) },
    { label: '有效期 / 备注', render: (row) => expiryCell(row.v) },
    {
      label: '操作',
      render: (row) => h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { previewInput = row.v.name; activeTab = 'preview'; rerender() } }, icon('probe'), '预演'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openVirtualKeyDialog(draft, row.v, row.st, rerender) }, icon('key'), 'Key'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openVirtualDialog(draft, row.v.name, rerender) }, icon('edit'), '编辑'),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => deleteVirtual(draft, row.v.name, row.st, rerender) }, icon('trash'), '删除')),
    },
  ]
}

function renderVirtual(draft, status, rerender) {
  const vms = asArray(draft.virtualModels).slice()
  const stats = new Map((Array.isArray(status.virtualModels) ? status.virtualModels : []).map((v) => [v.name, v]))
  const modelNames = Object.keys(draft.models || {})
  const add = h('button', {
    class: 'btn btn-primary', type: 'button', disabled: !modelNames.length,
    title: modelNames.length ? '' : '请先创建真实模型',
    onclick: () => openVirtualDialog(draft, null, rerender),
  }, icon('plus'), '新增虚拟入口')
  const body = vms.length
    ? table(virtualColumns(draft, rerender), vms.map((v) => ({ v, st: stats.get(v.name) || null })), {
      emptyTitle: '还没有虚拟模型',
      emptyDesc: '虚拟模型把多个真实模型组织成有序目录链；先准备真实模型。',
      emptyAction: add,
    })
    : empty('还没有虚拟模型', '虚拟模型把多个真实模型组织成有序目录链；先准备真实模型，再创建入口。', add)
  return h('div', null,
    callout('info',
      h('strong', { text: '虚拟入口语义：' }),
      ' 目录按从上到下的顺序路由；独立 Key 与 expiresAt/note 存于服务端加密元数据，页面只显示 keySet 与投影值。expiresAt 为空表示不设置有效期。'),
    h('div', { class: 'toolbar' },
      h('span', { class: 'page-note', text: '虚拟模型不支持 embeddings / rerank / 媒体能力。' })),
    body)
}

function virtualModelOptions(modelNames, selected) {
  const options = modelNames.map((n) => ({ value: n, label: n }))
  if (selected && !modelNames.includes(selected)) options.unshift({ value: selected, label: selected + '（当前配置中不存在）' })
  return options
}

function openVirtualDialog(draft, virtualName, rerender) {
  const isEdit = !!virtualName
  const modelNames = Object.keys(draft.models || {}).sort()
  if (!modelNames.length) { toast('请先创建真实模型', 'error'); return }
  const orig = isEdit ? asArray(draft.virtualModels).find((v) => v.name === virtualName) : null
  if (isEdit && !orig) { toast('虚拟模型不存在，可能已被其他窗口删除', 'error'); return }
  const rows = (orig && Array.isArray(orig.directory) ? orig.directory : []).map((e) => ({
    model: e && e.model ? e.model : modelNames[0],
    mode: e && e.mode === 'onFail' ? 'onFail' : 'afterAll',
    providers: e && asArray(e.providers).length ? asArray(e.providers).join(', ') : '',
  }))
  if (!rows.length) rows.push({ model: modelNames[0], mode: 'afterAll', providers: '' })

  const nameInput = makeInput({ type: 'text', value: virtualName || '', disabled: isEdit, autocomplete: 'off', placeholder: '例如 gatemodel' })
  const quotaInputs = {}
  for (const key of ['quota', 'dailyQuota', 'maxContext', 'maxConcurrent', 'qps']) {
    quotaInputs[key] = makeInput({
      type: 'number', min: '0', step: 'any',
      value: orig && orig[key] != null && Number(orig[key]) !== 0 ? String(orig[key]) : '',
      placeholder: '0 = 不限',
    })
  }
  const expiresInput = makeInput({
    type: 'text', value: expiryInputValue(orig && orig.expiresAt),
    autocomplete: 'off', placeholder: '例如 2026-12-31T23:59（或毫秒时间戳）',
  })
  const noteInput = makeInput({ type: 'text', value: (orig && orig.note) || '', autocomplete: 'off', placeholder: '可选备注' })
  const errBox = h('div')
  const rowsHost = h('div')

  const paintRows = () => {
    clear(rowsHost)
    if (!rows.length) {
      rowsHost.append(empty('目录为空', '至少保留一条目录项。'))
      return
    }
    rows.forEach((row, i) => {
      const modelSel = makeSelect(virtualModelOptions(modelNames, row.model), row.model)
      modelSel.addEventListener('change', () => { row.model = modelSel.value })
      const modeSel = makeSelect([
        { value: 'afterAll', label: 'afterAll（顺序尝试）' },
        { value: 'onFail', label: 'onFail（失败后切换）' },
      ], row.mode)
      modeSel.addEventListener('change', () => { row.mode = modeSel.value })
      const provInput = makeInput({ type: 'text', value: row.providers, autocomplete: 'off', placeholder: 'provider-a, provider-b（留空=模型主/备）' })
      provInput.addEventListener('input', () => { row.providers = provInput.value })
      const up = h('button', { class: 'btn btn-sm', type: 'button', text: '↑ 上移', disabled: i === 0 })
      up.addEventListener('click', () => {
        if (i === 0) return
        const moved = rows.splice(i, 1)[0]
        rows.splice(i - 1, 0, moved)
        paintRows()
      })
      const down = h('button', { class: 'btn btn-sm', type: 'button', text: '↓ 下移', disabled: i === rows.length - 1 })
      down.addEventListener('click', () => {
        if (i === rows.length - 1) return
        const moved = rows.splice(i, 1)[0]
        rows.splice(i + 1, 0, moved)
        paintRows()
      })
      const remove = h('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '移除' })
      remove.addEventListener('click', () => { rows.splice(i, 1); paintRows() })
      rowsHost.append(h('div', { style: { border: '1px solid var(--line)', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' } },
        h('div', { class: 'flex flex-wrap', style: { justifyContent: 'space-between', marginBottom: '6px' } },
          h('strong', { text: '目录项 ' + (i + 1) }),
          h('div', { class: 'row-actions' }, up, down, remove)),
        h('div', { class: 'field-row-3' },
          labeled('模型', modelSel, { help: '必须来自当前真实模型。' }),
          labeled('模式', modeSel, { help: 'afterAll=顺序尝试；onFail=当前失败后才切换。' }),
          labeled('上游（逗号分隔）', provInput, { help: '留空表示使用该模型自己的主/备上游。' }))))
    })
  }
  paintRows()
  const addRow = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { rows.push({ model: modelNames[0], mode: 'afterAll', providers: '' }); paintRows() } }, icon('plus'), '添加目录项')

  const content = h('div', null,
    errBox,
    callout('info', h('strong', { text: '写入草稿：' }), '虚拟模型编辑同样进入共享草稿，保存时以 configVersion 做冲突保护；服务端会重建固定字段并清理被删除入口的 Key/元数据。'),
    sectionHeading('入口标识', '名称是配置键；编辑时不可修改。'),
    labeled('名称', nameInput, { help: isEdit ? '名称是配置键，编辑时不可修改。' : '客户端请求该名字时按目录链路由；不能与真实模型或其别名冲突。' }),
    sectionHeading('目录链（按顺序）', '每一行是一次候选路由；可用上移/下移调整顺序。'),
    addRow,
    h('div', { class: 'mt-3' }, rowsHost),
    sectionHeading('额度与限制', '0 或留空 = 不限。'),
    h('div', { class: 'field-row-3' },
      labeled('quota（总 token）', quotaInputs.quota, { help: '0 = 不限' }),
      labeled('dailyQuota（日 token）', quotaInputs.dailyQuota, { help: '0 = 不限' }),
      labeled('maxContext', quotaInputs.maxContext, { help: '0 = 不限' })),
    h('div', { class: 'field-row' },
      labeled('maxConcurrent', quotaInputs.maxConcurrent, { help: '0 = 不限' }),
      labeled('qps', quotaInputs.qps, { help: '0 = 不限' })),
    sectionHeading('有效期与备注', '存于 keys 元数据；expiresAt 为空表示不设置。'),
    labeled('expiresAt', expiresInput, { help: '为空=不设置；输入日期时间会转换为毫秒时间戳（后端按数字比较有效期）。' }),
    labeled('备注', noteInput, { help: '可选；会随虚拟模型元数据保存并在投影中回显。' }))

  const cancel = h('button', { class: 'btn', type: 'button', text: '取消' })
  const save = h('button', { class: 'btn btn-primary', type: 'button', text: isEdit ? '保存修改' : '添加虚拟入口' })
  const d = dialog({
    title: isEdit ? '编辑虚拟入口 · ' + virtualName : '新增虚拟入口',
    desc: '目录顺序即路由顺序；保存只会写入可编辑配置与虚拟模型元数据。',
    wide: true,
    content,
    actions: [cancel, save],
  })
  cancel.addEventListener('click', () => d.close())

  save.addEventListener('click', () => {
    const errors = []
    const name = isEdit ? virtualName : nameInput.value.trim()
    if (!isEdit) {
      if (!name) errors.push('虚拟模型名称不能为空')
      else if (has(draft.models, name)) errors.push('名称与真实模型「' + name + '」冲突')
      else if (asArray(draft.virtualModels).some((v) => v.name === name)) errors.push('同名虚拟模型已存在')
      else if (draft.defaults && draft.defaults.model === name) errors.push('名称与默认虚拟共用名冲突')
      else if (RESERVED.has(name)) errors.push('名称不能使用保留键名')
      else {
        for (const [mn, m] of Object.entries(draft.models || {})) {
          if (m && asArray(m.alias).includes(name)) errors.push('名称与真实模型「' + mn + '」的别名冲突')
        }
      }
    }
    if (!rows.length) errors.push('目录至少需要一行')
    const directory = []
    rows.forEach((row, i) => {
      if (!row.model) errors.push('目录项 ' + (i + 1) + ' 缺少模型')
      else if (!has(draft.models, row.model)) errors.push('目录项 ' + (i + 1) + ' 引用了不存在的模型「' + row.model + '」')
      const mode = row.mode === 'onFail' ? 'onFail' : 'afterAll'
      const providers = parseList(row.providers)
      for (const pid of providers) if (!has(draft.providers, pid)) errors.push('目录项 ' + (i + 1) + ' 引用了不存在的上游「' + pid + '」')
      directory.push({ model: row.model, mode, providers })
    })
    const readQuota = (input, label) => {
      const raw = input.value.trim()
      if (raw === '') return 0
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) { errors.push(label + ' 必须是非负数'); return 0 }
      return n
    }
    const quota = readQuota(quotaInputs.quota, 'quota')
    const dailyQuota = readQuota(quotaInputs.dailyQuota, 'dailyQuota')
    const maxContext = readQuota(quotaInputs.maxContext, 'maxContext')
    const maxConcurrent = readQuota(quotaInputs.maxConcurrent, 'maxConcurrent')
    const qps = readQuota(quotaInputs.qps, 'qps')
    const expiresAt = normalizeExpiry(expiresInput.value)
    if (expiresAt == null) errors.push('expiresAt 需为日期时间或毫秒时间戳，或留空')
    const note = noteInput.value.trim()
    if (errors.length) {
      clear(errBox)
      errBox.append(callout('danger', h('strong', { text: '请先修正以下问题：' }),
        h('ul', { style: { margin: '4px 0 0 18px' } }, errors.map((msg) => h('li', { text: msg })))))
      return
    }

    const next = { name, directory, quota, dailyQuota, maxContext, maxConcurrent, qps, expiresAt: expiresAt || '', note }
    if (isEdit) {
      const idx = asArray(draft.virtualModels).findIndex((v) => v.name === virtualName)
      if (idx < 0) { toast('虚拟模型已不存在，未写入修改', 'error'); return }
      Object.assign(draft.virtualModels[idx], next)
    } else {
      draft.virtualModels.push(next)
    }
    d.close()
    reviewAndSave(draft, { onSaved: () => { setDraft(null); rerender() }, onError: () => rerender() })
    rerender()
  })
}

function openVirtualKeyDialog(draft, vm, st, rerender) {
  const dirty = draft.isDirty()
  const keyId = '__mg_vm_' + vm.name
  const input = makeInput({
    type: 'password', autocomplete: 'off', spellcheck: 'false', disabled: dirty,
    placeholder: dirty ? '请先保存或放弃未保存更改' : '输入新 Key（提交后不再回显）',
  })
  const err = h('p', { class: 'field-error', role: 'alert' })
  const save = h('button', { class: 'btn btn-primary', type: 'button', text: '保存 Key', disabled: dirty })
  const hasKey = !!(st && st.keySet)
  const clearBtn = hasKey ? h('button', { class: 'btn btn-danger', type: 'button', text: '清除虚拟 Key', disabled: dirty }) : null

  const content = h('div', null,
    callout('info', h('strong', { text: 'Key 走独立通道。' }), ' 只提交到 POST /api/keys，id 为 ' + keyId + '；页面与状态接口都不会回显 Key 值。'),
    dirty ? callout('warn', h('strong', { text: '当前有未保存的配置更改。' }), ' Key 保存会推进 configVersion，使草稿版本过期；请先保存或放弃草稿。') : null,
    kvList([
      ['虚拟入口', vm.name],
      ['是否已设 Key', st ? (st.keySet ? '是' : '否') : '运行时状态未返回'],
      ['Key 标识', keyId],
      ['有效期', expiryText(vm.expiresAt)],
    ]),
    labeled('新 Key', input, { help: '只保存在服务端加密 keys 库；提交后页面立即清空输入。' }),
    err,
    clearBtn ? h('p', { class: 'hint', text: '清除虚拟 Key 后，该入口在启用客户端 Key 门禁时将无法鉴权。' }) : null)

  const d = dialog({
    title: '虚拟入口 Key · ' + vm.name,
    desc: '凭据写入与配置保存是两条通道；本对话框不会展示任何 Key 值。',
    content,
    actions: [h('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => d.close() }), clearBtn, save].filter(Boolean),
  })

  async function submit(keyValue) {
    err.textContent = ''
    save.disabled = true
    if (clearBtn) clearBtn.disabled = true
    try {
      await api.saveKey({ id: keyId, key: keyValue, version: draft.baseVersion })
      input.value = ''
      setDraft(null)
      let reloadErr = null
      try { await loadAll() } catch (e) { reloadErr = e }
      toast(keyValue ? '虚拟模型 Key 已保存；配置版本已推进' : '虚拟模型 Key 已清除；配置版本已推进', 'success')
      if (reloadErr) toast('Key 已保存，但刷新配置失败：' + reloadErr.message, 'error')
      d.close()
      rerender()
    } catch (e) {
      save.disabled = dirty
      if (clearBtn) clearBtn.disabled = dirty
      if (e && e.status === 409) err.textContent = '配置版本已过期（服务端版本 ' + (e.currentVersion == null ? '未知' : e.currentVersion) + '）。请关闭后重新加载配置再试。'
      else err.textContent = 'Key 保存失败：' + (e && e.message ? e.message : '未知错误')
    }
  }

  save.addEventListener('click', () => {
    const value = input.value.trim()
    if (!value) { err.textContent = '请输入 Key 值；如需清除已存 Key，请使用“清除虚拟 Key”。'; return }
    submit(value)
  })
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '清除虚拟模型 Key',
        message: '将删除该虚拟入口在 keys 库中的独立 Key。若全局客户端 Key 仍启用，入口鉴权规则以服务端为准。',
        confirmLabel: '清除', danger: true,
      })
      if (!ok) return
      submit('')
    })
  }
}

async function deleteVirtual(draft, name, st, rerender) {
  const keyHint = st
    ? (st.keySet ? '该入口当前已设置独立 Key，删除时会一并清理。' : '该入口当前未设置独立 Key。')
    : '运行时 Key 状态未返回；删除时服务端仍会清理该入口的 Key 与元数据。'
  const ok = await confirmDialog({
    title: '删除虚拟入口 · ' + name,
    message: '从配置草稿中删除该虚拟模型。' + keyHint + ' 服务端在保存时会同时删除 __mg_vm_<name> Key 与 expiresAt/note 元数据。',
    confirmLabel: '删除并保存', danger: true,
  })
  if (!ok) return
  const idx = asArray(draft.virtualModels).findIndex((v) => v.name === name)
  if (idx < 0) { toast('虚拟模型已不存在', 'error'); return }
  draft.virtualModels.splice(idx, 1)
  reviewAndSave(draft, { onSaved: () => { setDraft(null); rerender() }, onError: () => rerender() })
  rerender()
}

// ---------- 路由预览 ----------
function previewTypeTag(type) {
  const map = {
    virtual: ['虚拟模型', 'info'],
    defaults: ['默认共用名', 'accent'],
    model: ['真实模型', 'good'],
    unknown: ['未命中', 'bad'],
  }
  const entry = map[type] || ['未知类型', 'muted']
  return tag(entry[0], entry[1])
}
function previewDirectory(entries) {
  if (!Array.isArray(entries) || !entries.length) return empty('目录为空', '服务端返回的目录链没有条目。')
  return h('div', { class: 'list' }, entries.map((e, i) => h('div', { class: 'list-row' },
    h('span', { class: 'provider-avatar', 'aria-hidden': 'true', text: String(i + 1) }),
    h('div', { class: 'grow' },
      h('div', { class: 'flex flex-wrap' },
        h('span', { class: 'mono primary', text: e && e.model ? e.model : '—' }),
        tag(e && e.mode === 'onFail' ? 'onFail' : 'afterAll', e && e.mode === 'onFail' ? 'warn' : 'info')),
      h('div', { class: 'secondary', style: { whiteSpace: 'normal' }, text: '上游：' + (e && asArray(e.providers).length ? asArray(e.providers).join(' → ') : '按模型主/备上游') }),
      e && e.limit ? h('div', { class: 'secondary', text: '限制：' + e.limit }) : null))))
}
function renderPreviewResult(state) {
  if (!state) return empty('尚未预演', '输入真实模型名或虚拟模型名后点击“预演路由”；只读取路由表，不调用上游。')
  if (state.error) return callout('danger', h('strong', { text: '预演失败：' }), state.error)
  const hit = state.hit || {}
  const type = String(hit.type || 'unknown')
  const name = hit.name || hit.model || state.model
  const top = h('div', { class: 'flex flex-wrap mb-3' },
    previewTypeTag(type),
    h('strong', { class: 'mono', text: name }),
    h('span', { class: 'muted', text: ' · 预演于 ' + fmtAgo(state.at) }))

  if (type === 'virtual') {
    return h('div', null, top,
      h('div', { class: 'grid grid-3 mb-3' },
        metric('总额度', limitText(hit.quota), '0 = 不限', 'plus'),
        metric('今日额度', limitText(hit.dailyQuota), '0 = 不限', 'warn'),
        metric('已用 Token', fmtInt(hit.used), '来自真实累计', 'probe')),
      h('div', { class: 'flex flex-wrap mb-3' },
        hit.quotaState ? tag(hit.quotaState, 'bad') : tag('额度检查通过', 'good'),
        h('span', { class: 'muted', text: '虚拟入口按目录顺序路由。' })),
      previewDirectory(hit.directory),
      callout('info', h('strong', { text: '只读预演：' }), ' 本次操作没有调用任何上游，也没有产生推理费用。'))
  }
  if (type === 'defaults') {
    return h('div', null, top,
      callout('info', h('strong', { text: '命中默认虚拟共用名。' }), ' 实际请求会沿默认目录首项把真实模型名发给上游，响应中的 model 会回写为客户端请求名。'),
      previewDirectory(hit.directory),
      callout('info', h('strong', { text: '只读预演：' }), ' 本次操作没有调用任何上游，也没有产生推理费用。'))
  }
  if (type === 'model') {
    return h('div', null, top,
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '主上游' }), h('span', { class: 'v mono', text: hit.provider || '—' })),
      hit.note ? callout('info', hit.note) : callout('good', h('strong', { text: '已解析到主上游。' }), ' 这是本地路由解析结果，不是上游调用结果。'),
      callout('info', h('strong', { text: '只读预演：' }), ' 本次操作没有调用任何上游，备用链与熔断状态请以真实模型表/运行状态为准。'))
  }
  return h('div', null, top,
    callout('warn', h('strong', { text: '未命中已知路由。' }), hit.note ? ' ' + hit.note : ' 服务端未返回更多说明。'),
    hit.provider ? h('div', { class: 'kv' }, h('span', { class: 'k', text: '上游' }), h('span', { class: 'v mono', text: hit.provider })) : null,
    callout('info', h('strong', { text: '只读预演：' }), ' 本次操作没有调用任何上游，也没有产生推理费用。'))
}

function renderPreview(draft, rerender) {
  const suggestions = []
  const seen = new Set()
  const push = (value) => { const s = String(value || '').trim(); if (s && !seen.has(s)) { seen.add(s); suggestions.push(s) } }
  for (const name of Object.keys(draft.models || {})) {
    push(name)
    for (const alias of asArray(draft.models[name] && draft.models[name].alias)) push(alias)
  }
  for (const vm of asArray(draft.virtualModels)) if (vm) push(vm.name)
  if (draft.defaults && draft.defaults.model) push(draft.defaults.model)
  const listId = nextId('route-list')
  const datalist = h('datalist', { id: listId }, suggestions.map((s) => h('option', { value: s })))
  const input = makeInput({ type: 'search', value: previewInput, placeholder: '输入真实模型名或虚拟模型名', autocomplete: 'off', list: listId })
  const button = h('button', { class: 'btn btn-primary', type: 'button', disabled: previewBusy, text: previewBusy ? '预演中…' : '预演路由' })
  const run = () => { previewInput = input.value; runPreview(input.value, rerender) }
  button.addEventListener('click', run)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run() } })
  input.addEventListener('input', () => { previewInput = input.value })
  const currentVersion = state.config ? state.config.configVersion : null
  const stale = !!(previewState && previewState.version != null && currentVersion != null && Number(previewState.version) !== Number(currentVersion))
  return h('div', null,
    callout('info', h('strong', { text: '只读预演：' }), ' 调用 /api/route-preview 解析本地路由表，不触达上游、不计费。'),
    draft.isDirty() ? callout('warn', h('strong', { text: '预演基于服务端当前已保存配置。' }), ' 当前草稿中有未保存更改，本次预演不会包含它们。') : null,
    card('路由预演', '选择或输入模型名，查看服务端实际解析结果',
      h('div', null,
        h('div', { class: 'toolbar' },
          h('div', { class: 'grow', style: { maxWidth: '420px' } }, input, datalist),
          button),
        h('div', { class: 'mt-3' },
          stale ? callout('warn', h('strong', { text: '预演结果可能已过期。' }), ' 该结果基于配置版本 ' + previewState.version + '；当前版本 ' + currentVersion + '。请重新预演。') : null,
          renderPreviewResult(previewState)))))
}

async function runPreview(value, rerender) {
  if (previewBusy) return
  const model = String(value || '').trim()
  if (!model) { toast('请输入真实模型名或虚拟模型名', 'error'); return }
  const version = state.config ? state.config.configVersion : null
  previewBusy = true
  previewState = null
  rerender()
  try {
    const res = await api.routePreview(model)
    previewState = { model, hit: res && res.hit ? res.hit : null, at: Date.now(), error: null, version }
  } catch (e) {
    previewState = { model, hit: null, at: Date.now(), error: e && e.message ? e.message : '路由预演失败', version }
  } finally {
    previewBusy = false
    rerender()
  }
}

// ---------- 页面 ----------
export function render(root, ctx = {}) {
  const rerender = ctx.rerender || (() => {})
  const status = state.status || {}
  const draft = ensureDraft(state.config)
  const modelCount = draft ? Object.keys(draft.models || {}).length : 0
  const vmCount = draft ? asArray(draft.virtualModels).length : 0
  const providerCount = draft ? Object.keys(draft.providers || {}).length : 0

  const desc = draft
    ? '真实模型 ' + modelCount + ' 个 · 虚拟入口 ' + vmCount + ' 个 · 上游 ' + providerCount + ' 个 · 配置版本 ' + (state.config && state.config.configVersion != null ? state.config.configVersion : '—')
    : '读取配置投影后管理模型与路由；当前无法读取可编辑配置。'

  let add = null
  if (draft && activeTab === 'real') add = { label: '新增真实模型', fn: () => openModelDialog(draft, null, rerender), disabled: !providerCount, title: providerCount ? '' : '请先添加上游' }
  else if (draft && activeTab === 'virtual') add = { label: '新增虚拟入口', fn: () => openVirtualDialog(draft, null, rerender), disabled: !modelCount, title: modelCount ? '' : '请先创建真实模型' }

  root.append(pageHead('模型与路由', desc, { eyebrow: 'ROUTING / CATALOG', actions: headerActions(draft, rerender, add) }))

  if (!state.config || !draft) {
    root.append(configErrorCard(rerender))
    return
  }

  root.append(tabs([
    { id: 'real', label: '真实模型' },
    { id: 'virtual', label: '虚拟模型' },
    { id: 'preview', label: '路由预览' },
  ], activeTab, (id) => { activeTab = id; rerender() }))

  if (!providerCount) {
    root.append(callout('warn',
      h('strong', { text: '还没有上游。' }),
      ' 真实模型必须引用已存在的上游；请先到「上游供应商」添加并保存上游。',
      h('button', { class: 'btn btn-sm', type: 'button', text: '前往上游供应商', onclick: () => { location.hash = '#/providers' } })))
  }

  if (activeTab === 'virtual') root.append(renderVirtual(draft, status, rerender))
  else if (activeTab === 'preview') root.append(renderPreview(draft, rerender))
  else root.append(renderReal(draft, status, rerender))
}
