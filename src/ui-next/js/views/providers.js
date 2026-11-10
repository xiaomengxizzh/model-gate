// 上游供应商：真实配置投影 + 共享草稿/版本化保存；Key 独立通道；探活需显式确认。
import { h, clear, icon } from '../dom.js'
import {
  pageHead, card, metric, tag, statusTag, callout, empty, field, dialog, confirmDialog, toast, sectionTitle,
} from '../components.js'
import { state, loadAll, loadStatus } from '../store.js'
import { ensureDraft, setDraft } from '../config-draft.js'
import { reviewAndSave, dirtyChip } from '../save-flow.js'
import { api } from '../api.js'
import { fmtInt, fmtMs, fmtAgo, fmtDuration, safeHost, safeOrigin, maskValue, parseKv, kvText } from '../format.js'

const PROTOCOLS = ['openai', 'anthropic', 'gemini', 'cohere', 'responses']
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
// 只在当前标签页内存中记录“哪些上游的请求头被临时展开”；不保存任何 header 值。
const revealed = new Set()
let seq = 0
const nextId = (prefix = 'pv') => prefix + '-' + (++seq)
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

function statusProvider(status, id) {
  return (Array.isArray(status && status.providers) ? status.providers : []).find((p) => p.id === id) || null
}
function sourceLabel(sp) {
  if (!sp) return '运行时 Key 状态未返回'
  if (!sp.hasKey) return '无可用 Key（可能无需鉴权或变量未解析）'
  const map = { keys: '面板 Key（加密存储）', env: '网关进程环境变量', 'env-registry': '用户级环境变量' }
  return map[String(sp.keySource)] || ('来源 ' + (sp.keySource || '未知'))
}
function proxyLabel(proxy) {
  if (proxy === false || proxy === 'direct') return '强制直连'
  if (proxy == null || proxy === '') return '继承全局/环境变量'
  const shown = safeOrigin(proxy)
  return shown === '地址不可用' ? '代理地址不可用（凭据不展示）' : shown
}
function circuitConfigText(circuit) {
  if (!circuit || typeof circuit !== 'object' || Array.isArray(circuit)) return '使用全局默认'
  const parts = []
  const mf = Number(circuit.maxFailures)
  const od = Number(circuit.openDurationMs)
  if (Number.isFinite(mf) && mf > 0) parts.push(mf + ' 次失败')
  if (Number.isFinite(od) && od > 0) parts.push('冷却 ' + fmtDuration(od))
  return parts.length ? parts.join(' / ') : '使用全局默认'
}
function cooldownText(st) {
  if (!st) return ''
  if (st.state === 'open' && Number(st.openUntilMs) > 0) return '剩余冷却 ' + fmtDuration(st.openUntilMs)
  if (st.state === 'half') return '半开：允许探测请求'
  return ''
}
function probeTag(probe) {
  if (!probe) return tag('未探活', 'muted')
  return tag(probe.ok ? '探活通过' : '探活失败', probe.ok ? 'good' : 'bad')
}
function statBox(label, value) {
  return h('div', null, h('small', { text: label }), h('strong', { text: value }))
}

function headerActions(draft, rerender) {
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
  out.push(h('button', {
    class: 'btn ' + (draft && draft.isDirty() ? '' : 'btn-primary'),
    type: 'button', disabled: !draft,
    onclick: () => { if (draft) openProviderDialog(draft, null, rerender) },
  }, icon('plus'), '新增上游'))
  return out
}

function providerCard(draft, status, id, rerender) {
  const p = draft.providers[id] || {}
  const sp = statusProvider(status, id)
  const st = sp && sp.st
  const headers = (p.extraHeaders && typeof p.extraHeaders === 'object' && !Array.isArray(p.extraHeaders)) ? p.extraHeaders : {}
  const headerEntries = Object.entries(headers)
  let shown = revealed.has(id)
  const headerHost = h('div', { class: 'mt-2' })
  const toggle = h('button', { class: 'btn btn-sm', type: 'button', text: shown ? '隐藏值' : '显示值', 'aria-pressed': shown ? 'true' : 'false' })
  const paintHeaders = () => {
    clear(headerHost)
    if (!headerEntries.length) {
      headerHost.append(h('span', { class: 'muted', style: { fontSize: '10.5px' }, text: '无自定义请求头' }))
      return
    }
    headerHost.append(h('div', { class: 'hint', text: shown ? '已临时展开；这些值可能包含敏感凭据，请勿截图分享。' : '值默认掩码；展开只在当前标签页内存生效。' }))
    headerHost.append(h('div', { class: 'mono-break mt-2' }, headerEntries.map(([k, v]) => h('div', { text: k + ': ' + (shown ? String(v) : maskValue(String(v))) }))))
  }
  toggle.addEventListener('click', () => {
    shown = !shown
    if (shown) revealed.add(id)
    else revealed.delete(id)
    toggle.textContent = shown ? '隐藏值' : '显示值'
    toggle.setAttribute('aria-pressed', shown ? 'true' : 'false')
    paintHeaders()
  })
  paintHeaders()

  const keyTag = sp ? (sp.hasKey ? tag('已配 Key', 'good') : tag('无 Key', 'muted')) : tag('Key 状态未知', 'muted')
  const envName = sp ? sp.apiKeyEnv : (p.apiKeyEnv || null)
  const probe = st && st.probe ? st.probe : null
  const cooldown = cooldownText(st)

  return h('article', { class: 'provider-card' },
    h('div', { class: 'provider-top' },
      h('span', { class: 'provider-avatar', 'aria-hidden': 'true', text: (String(id)[0] || '?').toUpperCase() }),
      h('div', { class: 'grow' },
        h('div', { class: 'provider-id', text: id }),
        h('div', { class: 'provider-sub', text: '协议 ' + (p.api || 'openai') + (p.pathPrefix ? ' · 前缀 ' + p.pathPrefix : ' · 无路径前缀') })),
      h('div', { class: 'flex flex-wrap' }, keyTag, statusTag(st ? st.state : 'untested'))),
    h('div', { class: 'provider-url', title: safeHost(p.baseUrl), text: safeHost(p.baseUrl) + (p.pathPrefix || '') }),
    h('div', { class: 'hint' }, sourceLabel(sp), envName ? h('span', { text: ' · apiKeyEnv ' + envName }) : null),
    h('div', { class: 'provider-stats' },
      statBox('请求', fmtInt(st && st.requests)),
      statBox('错误', fmtInt(st && st.errors)),
      statBox('P95', fmtMs(st && st.p95))),
    h('div', { class: 'flex flex-wrap', style: { justifyContent: 'space-between', gap: '6px' } },
      h('div', { class: 'flex flex-wrap' },
        cooldown
          ? h('span', { class: 'muted', style: { fontSize: '10.5px' }, text: cooldown })
          : h('span', { class: 'muted', style: { fontSize: '10.5px' }, text: st ? '当前无冷却' : '尚无运行时状态' })),
      h('span', { class: 'muted', style: { fontSize: '10.5px' }, text: '熔断阈值：' + circuitConfigText(p.circuit) })),
    h('div', { class: 'flex flex-wrap' },
      probeTag(probe),
      h('span', { class: 'muted', style: { fontSize: '10.5px' }, text: probe ? ((probe.code == null ? '—' : probe.code) + ' · ' + fmtMs(probe.ms) + ' · ' + fmtAgo(probe.at) + (probe.err ? ' · ' + probe.err : '')) : '尚未探活；探活只发送 GET /v1/models' })),
    h('div', { class: 'hint', text: '代理：' + proxyLabel(p.proxy) }),
    h('div', { class: 'flex flex-wrap', style: { justifyContent: 'space-between' } },
      h('span', { class: 'muted', style: { fontSize: '10.5px' }, text: '自定义请求头 ' + headerEntries.length + ' 项' }),
      headerEntries.length ? toggle : null),
    headerHost,
    h('div', { class: 'provider-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openProviderDialog(draft, id, rerender) }, icon('edit'), '编辑'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openKeyDialog(draft, id, sp, rerender) }, icon('key'), 'Key'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => probeProvider(draft, id, rerender) }, icon('probe'), '探活'),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => deleteProvider(draft, id, rerender) }, icon('trash'), '删除')))
}

function openProviderDialog(draft, providerId, rerender) {
  const isEdit = !!providerId
  const p = isEdit ? (draft.providers[providerId] || {}) : {}
  const idInput = makeInput({ type: 'text', value: providerId || '', disabled: isEdit, autocomplete: 'off', placeholder: '例如 openai-main' })
  const baseInput = makeInput({ type: 'text', value: p.baseUrl || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://api.example.com' })
  const apiSelect = makeSelect(PROTOCOLS.map((v) => ({ value: v, label: v })), p.api || 'openai')
  const pathInput = makeInput({ type: 'text', value: p.pathPrefix || '', autocomplete: 'off', placeholder: '可选，如 /v1' })
  const envInput = makeInput({ type: 'text', value: p.apiKeyEnv || '', autocomplete: 'off', spellcheck: 'false', placeholder: '例如 OPENAI_API_KEY' })
  const proxyInput = makeInput({
    type: 'text',
    value: typeof p.proxy === 'string' ? p.proxy : (p.proxy === false ? 'direct' : ''),
    autocomplete: 'off', spellcheck: 'false', placeholder: '留空=继承全局；direct=直连；或 http(s)://…',
  })
  const maxFailInput = makeInput({ type: 'number', min: '0', step: '1', value: p.circuit && p.circuit.maxFailures != null ? String(p.circuit.maxFailures) : '', placeholder: '默认' })
  const openInput = makeInput({ type: 'number', min: '0', step: '1', value: p.circuit && p.circuit.openDurationMs != null ? String(p.circuit.openDurationMs) : '', placeholder: '默认' })
  const extraHeaders = (p.extraHeaders && typeof p.extraHeaders === 'object' && !Array.isArray(p.extraHeaders)) ? p.extraHeaders : {}
  const headersArea = h('textarea', { value: kvText(extraHeaders), placeholder: 'x-custom: value\n另一个头: 另一个值' })
  headersArea.id = nextId()
  const errBox = h('div')

  const content = h('div', null,
    errBox,
    callout('info', h('strong', { text: '写入草稿：' }), '修改先进入本地配置草稿，点击保存后仍需在差异对话框中确认；保存会推进 configVersion。'),
    sectionHeading('身份与端点', '上游 ID 是配置键；Base URL 不能包含真实凭据。'),
    labeled('上游 ID', idInput, { help: isEdit ? 'ID 是配置键，编辑时不可修改。' : '唯一标识，保存后作为配置键；建议使用小写字母、数字、点、下划线或短横线。' }),
    labeled('Base URL', baseInput, { help: '必须是 http:// 或 https:// 地址；不要在 URL 中写 Key。' }),
    h('div', { class: 'field-row' },
      labeled('协议', apiSelect, { help: 'openai/anthropic/gemini/cohere/responses；决定转发时的协议适配。' }),
      labeled('路径前缀', pathInput, { help: '可选；转发时拼接在 Base URL 后。' })),
    h('div', { class: 'field-row' },
      labeled('apiKeyEnv', envInput, { help: '环境变量名，不是 Key 值。面板 Key 优先于环境变量。' }),
      labeled('代理', proxyInput, { help: '留空=继承全局；direct=强制直连；或 http(s):// 代理地址。凭据不会在卡片中展示。' })),
    sectionHeading('熔断参数', '留空使用全局默认；失败达到阈值后进入 open，冷却结束转 half。'),
    h('div', { class: 'field-row' },
      labeled('失败阈值', maxFailInput, { help: '非负整数；达到后熔断。' }),
      labeled('冷却时长（ms）', openInput, { help: '非负整数；open 状态持续时长。' })),
    sectionHeading('自定义请求头', '每行 "名称: 值"。这些值会随配置保存；展示时默认掩码。'),
    labeled('额外请求头', headersArea, { help: '例如 x-custom-header: value。不要存放长期凭据。' }))

  const cancel = h('button', { class: 'btn', type: 'button', text: '取消' })
  const save = h('button', { class: 'btn btn-primary', type: 'button', text: isEdit ? '保存修改' : '添加上游' })
  const d = dialog({
    title: isEdit ? '编辑上游 · ' + providerId : '新增上游',
    desc: '只提交可编辑配置；未知扩展字段在草稿中原地保留。',
    wide: true,
    content,
    actions: [cancel, save],
  })
  cancel.addEventListener('click', () => d.close())

  save.addEventListener('click', () => {
    const errors = []
    const id = isEdit ? providerId : idInput.value.trim()
    if (!isEdit) {
      if (!id) errors.push('上游 ID 不能为空')
      else if (has(draft.providers, id)) errors.push('上游 ID「' + id + '」已存在')
      else if (RESERVED.has(id)) errors.push('上游 ID 不能使用保留键名')
      else if (/\s/.test(id)) errors.push('上游 ID 不能包含空白字符')
    }
    const baseUrl = baseInput.value.trim()
    if (!/^https?:\/\//i.test(baseUrl)) errors.push('Base URL 必须以 http:// 或 https:// 开头')
    else {
      try {
        const u = new URL(baseUrl)
        if (!u.hostname) throw new Error('no host')
      } catch { errors.push('Base URL 不是合法的 http(s) 地址') }
    }
    const proxy = proxyInput.value.trim()
    if (proxy && proxy !== 'direct') {
      if (!/^https?:\/\//i.test(proxy)) errors.push('代理必须是 direct 或 http(s):// 地址')
      else {
        try {
          const u = new URL(proxy)
          if (!u.hostname) throw new Error('no host')
        } catch { errors.push('代理地址不是合法的 http(s) URL') }
      }
    }
    const readInt = (input, label) => {
      const raw = input.value.trim()
      if (raw === '') return null
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) { errors.push(label + ' 必须是非负整数'); return null }
      return n
    }
    const maxFailures = readInt(maxFailInput, '失败阈值')
    const openDurationMs = readInt(openInput, '冷却时长')
    const headerLines = headersArea.value.split(/\r?\n/).filter((line) => line.trim())
    headerLines.forEach((line, i) => {
      if (line.indexOf(':') <= 0) errors.push('额外请求头第 ' + (i + 1) + ' 行缺少 "名称: 值" 格式')
    })
    if (errors.length) {
      clear(errBox)
      errBox.append(callout('danger', h('strong', { text: '请先修正以下问题：' }),
        h('ul', { style: { margin: '4px 0 0 18px' } }, errors.map((msg) => h('li', { text: msg })))))
      return
    }
    if (isEdit && !draft.providers[providerId]) {
      clear(errBox)
      errBox.append(callout('danger', h('strong', { text: '上游已不存在。' }), ' 可能已被其他窗口删除，请关闭对话框后刷新配置。'))
      return
    }

    let target
    if (isEdit) target = draft.providers[providerId]
    else {
      target = {}
      draft.providers[id] = target
    }
    target.baseUrl = baseUrl
    target.api = apiSelect.value
    const pathPrefix = pathInput.value.trim()
    if (pathPrefix) target.pathPrefix = pathPrefix
    else if (has(target, 'pathPrefix')) delete target.pathPrefix
    const apiKeyEnv = envInput.value.trim()
    if (apiKeyEnv) target.apiKeyEnv = apiKeyEnv
    else if (has(target, 'apiKeyEnv')) target.apiKeyEnv = ''
    if (proxy) target.proxy = proxy
    else if (has(target, 'proxy')) target.proxy = ''
    if (maxFailures == null && openDurationMs == null) {
      if (has(target, 'circuit')) delete target.circuit
    } else {
      const circuit = (target.circuit && typeof target.circuit === 'object' && !Array.isArray(target.circuit)) ? target.circuit : (target.circuit = {})
      if (maxFailures == null) delete circuit.maxFailures
      else circuit.maxFailures = maxFailures
      if (openDurationMs == null) delete circuit.openDurationMs
      else circuit.openDurationMs = openDurationMs
    }
    const headers = parseKv(headersArea.value)
    if (Object.keys(headers).length) target.extraHeaders = headers
    else if (has(target, 'extraHeaders')) target.extraHeaders = {}

    d.close()
    reviewAndSave(draft, { onSaved: () => { setDraft(null); rerender() }, onError: () => rerender() })
    rerender()
  })
}

function openKeyDialog(draft, id, sp, rerender) {
  const dirty = draft.isDirty()
  const input = makeInput({
    type: 'password', autocomplete: 'off', spellcheck: 'false', disabled: dirty,
    placeholder: dirty ? '请先保存或放弃未保存更改' : '输入新 Key（提交后不再回显）',
  })
  const err = h('p', { class: 'field-error', role: 'alert' })
  const save = h('button', { class: 'btn btn-primary', type: 'button', text: '保存 Key', disabled: dirty })
  const clearBtn = sp && sp.hasKey ? h('button', { class: 'btn btn-danger', type: 'button', text: '清除面板 Key', disabled: dirty }) : null

  const content = h('div', null,
    callout('info', h('strong', { text: 'Key 走独立通道。' }), ' 只提交到 POST /api/keys，不经 /api/config/save，页面与状态接口都不会回显 Key 值。'),
    dirty ? callout('warn', h('strong', { text: '当前有未保存的配置更改。' }), ' Key 保存会推进 configVersion，使草稿基于的版本过期；请先在页面上保存或放弃草稿。') : null,
    h('div', { class: 'mb-3' }, h('span', { class: 'hint', text: '当前状态（来自 /api/status）' })),
    h('div', { class: 'mb-3' },
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '是否已配 Key' }), h('span', { class: 'v' }, sp && sp.hasKey ? '是' : '否')),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '解析来源' }), h('span', { class: 'v', text: sourceLabel(sp) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'apiKeyEnv' }), h('span', { class: 'v', text: sp && sp.apiKeyEnv ? sp.apiKeyEnv : '—' }))),
    labeled('新 Key', input, { help: '只保存在服务端加密 keys 库；提交后页面立即清空输入。' }),
    err,
    clearBtn ? h('p', { class: 'hint', text: '清除面板 Key 不会移除环境变量来源；若环境变量仍解析得到 Key，请求可能仍然成功。' }) : null)

  const d = dialog({
    title: '设置上游 Key · ' + id,
    desc: '凭据写入与配置保存是两条通道；本对话框不会展示任何 Key 值。',
    content,
    actions: [h('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => d.close() }), clearBtn, save].filter(Boolean),
  })

  async function submit(keyValue) {
    err.textContent = ''
    save.disabled = true
    if (clearBtn) clearBtn.disabled = true
    try {
      await api.saveKey({ id, key: keyValue, version: draft.baseVersion })
      input.value = ''
      setDraft(null)
      let reloadErr = null
      try { await loadAll() } catch (e) { reloadErr = e }
      toast(keyValue ? '上游 Key 已保存；配置版本已推进' : '面板 Key 已清除；配置版本已推进', 'success')
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
    if (!value) { err.textContent = '请输入 Key 值；如需清除已存 Key，请使用“清除面板 Key”。'; return }
    submit(value)
  })
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '清除面板 Key',
        message: '将删除 keys 库中该上游的条目。若 apiKeyEnv 指向的环境变量仍能解析到 Key，实际请求可能仍然可用。',
        confirmLabel: '清除', danger: true,
      })
      if (!ok) return
      submit('')
    })
  }
}

async function probeProvider(draft, id, rerender) {
  const dirtyNote = draft && draft.isDirty() ? ' 当前有未保存草稿；探活使用服务端已保存配置，不包含草稿修改。' : ''
  const ok = await confirmDialog({
    title: '探活上游 · ' + id,
    message: '将向该上游发送真实网络请求 GET /v1/models，用于验证可达性与鉴权。不会发起推理，通常不产生推理费用；但仍会占用上游网络与配额策略。' + dirtyNote,
    confirmLabel: '发送探活',
  })
  if (!ok) return
  let result = null
  let callErr = null
  try {
    const res = await api.probe(id)
    result = (Array.isArray(res && res.results) ? res.results : []).find((r) => r.id === id) || null
  } catch (e) { callErr = e }
  let refreshErr = null
  try { await loadStatus() } catch (e) { refreshErr = e }
  rerender()

  const body = h('div', null)
  if (callErr) body.append(callout('danger', h('strong', { text: '探活请求失败：' }), callErr.message || '未知错误'))
  else if (!result) body.append(callout('warn', h('strong', { text: '接口未返回该上游的探活结果。' }), ' 可能该上游已从配置中移除，或结果未包含此 ID。'))
  else {
    body.append(callout(result.ok ? 'good' : 'danger',
      h('strong', { text: result.ok ? '探活通过' : '探活失败' }),
      ' · HTTP ' + (result.code == null ? '—' : result.code) + ' · ' + fmtMs(result.ms) + (result.err ? ' · ' + result.err : '')))
    body.append(h('div', null,
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '上游' }), h('span', { class: 'v', text: result.id || id })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '结果' }), h('span', { class: 'v', text: result.ok ? '通过' : '失败' })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'HTTP 状态' }), h('span', { class: 'v', text: result.code == null ? '—' : String(result.code) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '耗时' }), h('span', { class: 'v', text: fmtMs(result.ms) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '错误' }), h('span', { class: 'v', text: result.err || '—' }))))
  }
  body.append(callout('warn', h('strong', { text: '探活边界：' }), '成功只证明 GET /v1/models 可达且鉴权通过，不代表 chat、tool calling 或流式生成可用。'))
  const close = h('button', { class: 'btn btn-primary', type: 'button', text: '关闭' })
  const rd = dialog({ title: '探活结果 · ' + id, content: body, actions: [close] })
  close.addEventListener('click', () => rd.close())
  if (refreshErr) toast('探活已完成，但状态刷新失败：' + (refreshErr.message || '未知错误'), 'error')
}

async function deleteProvider(draft, id, rerender) {
  const refs = []
  for (const [name, m] of Object.entries(draft.models || {})) {
    if (!m || typeof m !== 'object') continue
    if (m.provider === id) refs.push('模型「' + name + '」主上游')
    if (asArray(m.fallbacks).includes(id)) refs.push('模型「' + name + '」备用上游')
    if (m.providerModels && has(m.providerModels, id)) refs.push('模型「' + name + '」providerModels')
  }
  for (const vm of draft.virtualModels || []) {
    for (const e of asArray(vm && vm.directory)) if (e && asArray(e.providers).includes(id)) refs.push('虚拟模型「' + vm.name + '」目录')
  }
  const defaults = draft.defaults || {}
  if (defaults.provider === id) refs.push('defaults.provider 默认上游')
  for (const e of asArray(defaults.directory)) if (e && asArray(e.providers).includes(id)) refs.push('默认兜底目录')
  const refMsg = refs.length
    ? ' 仍有 ' + refs.length + ' 处引用：' + refs.slice(0, 6).join('；') + (refs.length > 6 ? ' …' : '') + '。若保存前不移除这些引用，配置校验会拒绝保存。'
    : ' 没有模型或虚拟模型引用它。'
  const ok = await confirmDialog({
    title: '删除上游 · ' + id,
    message: '从配置草稿中删除该上游。' + refMsg + ' 保存后该上游的运行时统计消失；Key 不会被自动删除。',
    confirmLabel: '删除并保存', danger: true,
  })
  if (!ok) return
  delete draft.providers[id]
  revealed.delete(id)
  reviewAndSave(draft, { onSaved: () => { setDraft(null); rerender() }, onError: () => rerender() })
  rerender()
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

export function render(root, ctx = {}) {
  const rerender = ctx.rerender || (() => {})
  const status = state.status || {}
  const draft = ensureDraft(state.config)
  const ids = draft ? Object.keys(draft.providers || {}).sort() : []
  const sps = ids.map((id) => statusProvider(status, id))
  const keyed = sps.filter((p) => p && p.hasKey).length
  const open = sps.filter((p) => p && p.st && p.st.state === 'open').length
  const half = sps.filter((p) => p && p.st && p.st.state === 'half').length

  const desc = draft
    ? ids.length + ' 个上游 · ' + keyed + ' 个已配 Key · ' + open + ' 个熔断中 · 配置版本 ' + (state.config && state.config.configVersion != null ? state.config.configVersion : '—')
    : '读取配置投影后管理上游；当前无法读取可编辑配置。'
  root.append(pageHead('上游供应商', desc, { eyebrow: 'UPSTREAM / PROVIDERS', actions: headerActions(draft, rerender) }))

  if (!state.config || !draft) {
    root.append(configErrorCard(rerender))
    return
  }

  root.append(h('div', { class: 'grid grid-4' },
    metric('上游总数', fmtInt(ids.length), '来自 GET /api/config 配置键', 'plus'),
    metric('已配 Key', fmtInt(keyed), '来自 /api/status hasKey', 'key'),
    metric('未配 Key', fmtInt(ids.length - keyed), '本地上游可能无需鉴权', 'warn'),
    metric('熔断 / 半开', fmtInt(open), '半开 ' + fmtInt(half) + ' 个 · 状态来自真实请求', 'probe')))

  root.append(callout('warn',
    h('strong', { text: '探活边界：' }),
    '探活只发送 GET /v1/models 验证可达与鉴权；成功不代表 chat、tool calling 或流式生成可用。探活结果来自真实请求，不用于伪造健康评分。'))

  if (!ids.length) {
    const add = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => openProviderDialog(draft, null, rerender),
    }, icon('plus'), '新增上游')
    root.append(card('上游列表', '添加第一个上游后，才能在模型页配置路由',
      empty('还没有配置上游', '新增上游并保存后，这里会显示真实的 Key 来源、运行统计与熔断状态。', add)))
    return
  }

  const grid = h('div', { class: 'grid grid-2' })
  for (const id of ids) grid.append(providerCard(draft, status, id, rerender))
  root.append(grid)
}
