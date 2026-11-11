// 客户端接入：真实 origin + 真实模型目录；不读取客户端配置，不推测连接状态。
import { h } from '../dom.js'
import { state } from '../store.js'
import { pageHead, card, callout, empty, table, tag, codeBlock, copyButton, kvList, tabs, toast } from '../components.js'
import { fmtTime } from '../format.js'
import {
  IDENTITY_FACTS,
  RISK_NOTES,
  catalogState,
  codexExportPlan,
  codexIdentityTemplate,
  downloadJson,
  downloadText,
  ownerLabel,
  ownershipRows,
  previewOwnedChange,
  probeCodexPolicy,
  writePathState,
} from './codex.js'

const TABS = [
  { id: 'codex-cli', label: 'Codex CLI' },
  { id: 'codex-desktop', label: 'Codex Desktop' },
  { id: 'dsh', label: 'DSH' },
  { id: 'sdk', label: 'OpenAI 兼容 SDK' },
  { id: 'custom', label: '自定义客户端' },
]
const CAPS = ['chat', 'embedding', 'rerank', 'audio', 'image', 'video']

// 客户端导出（M4-2）：只输出客户端所拥有的字段；不含服务端私有/凭据/额度/代理配置。
export const CLIENT_EXPORT_FIELDS = Object.freeze(['schema', 'baseUrl', 'clientKey', 'models', 'virtualModels', 'notes'])
export function buildClientExport(opts = {}) {
  const config = opts.config || state.config || {}
  const status = opts.status || state.status || {}
  const origin = opts.origin || (typeof location !== 'undefined' && location.origin ? location.origin : '')
  const models = Object.entries(config.models || {}).map(([name, m]) => ({
    name,
    capability: (m && m.capability) || 'chat',
    api: (m && m.api) || '',
  }))
  const virtualModels = (Array.isArray(config.virtualModels) ? config.virtualModels : [])
    .filter((v) => v && v.name)
    .map((v) => ({ name: v.name, capability: 'chat' }))
  const keySet = (config.defaults && config.defaults.clientKey === '********') ||
    (status.defaults && status.defaults.clientKey === '********')
  return {
    schema: 'modelgate-client-export/1',
    baseUrl: origin + '/v1',
    clientKey: keySet ? '已设置' : '未设置',
    models,
    virtualModels,
    notes: ['只包含客户端接入所需字段；不含上游凭据、服务端私有字段、额度或代理配置。'],
  }
}
const view = { tab: 'codex-cli', model: '' }
// Codex 聚合卡片：只存用户粘贴的文本与预览结果，不持久化、不发请求。
const CODEX = { pasted: '', preview: null, v2: true }

function config() { return state.config || {} }
function baseUrl() { return location.origin + '/v1' }

function modelEntries(c = config()) {
  const providers = c.providers || {}
  const out = []
  for (const [name, def] of Object.entries(c.models || {})) {
    const m = def || {}
    const provider = m.provider || ''
    const p = providers[provider] || {}
    out.push({
      name,
      provider,
      capability: m.capability || 'chat',
      api: m.api || '',
      effectiveApi: m.api || p.api || 'openai',
      aliases: Array.isArray(m.alias) ? m.alias : [],
      fallbacks: Array.isArray(m.fallbacks) ? m.fallbacks : [],
    })
  }
  return out
}

function virtualEntries(c = config()) {
  const list = Array.isArray(c.virtualModels) ? c.virtualModels : []
  return list.filter((v) => v && v.name).map((v) => ({
    name: v.name,
    directory: Array.isArray(v.directory) ? v.directory : [],
    expiresAt: v.expiresAt || '',
    expiresAtState: v.expiresAtState || 'unknown',
    note: v.note || '',
  }))
}

function chatChoices(c = config()) {
  const real = modelEntries(c)
    .filter((m) => m.capability === 'chat')
    .map((m) => ({ name: m.name, virtual: false, detail: m.provider + ' · chat' }))
  const virtual = virtualEntries(c).map((v) => ({ name: v.name, virtual: true, detail: '虚拟入口 · ' + v.directory.length + ' 个目录模型' }))
  return real.concat(virtual)
}

function pickModel(c = config()) {
  const names = chatChoices(c).map((o) => o.name)
  if (view.model && names.indexOf(view.model) >= 0) return view.model
  const def = c.defaults && c.defaults.model
  if (def && names.indexOf(def) >= 0) return def
  return names.length ? names[0] : ''
}

function modelInfo(name, c = config()) {
  if (!name) return null
  const real = modelEntries(c).find((m) => m.name === name)
  if (real) return Object.assign({ virtual: false }, real)
  const vm = virtualEntries(c).find((v) => v.name === name)
  if (vm) return { name: vm.name, virtual: true, provider: '', capability: 'chat', api: '', effectiveApi: '', directory: vm.directory }
  return null
}

function wireInfo(info) {
  if (!info) {
    return { label: '未选择模型', kind: 'muted', detail: '当前没有 chat 能力模型或虚拟入口；模板中的模型保持占位符。' }
  }
  if (info.virtual) {
    return {
      label: '虚拟入口 → Chat 桥（有损）',
      kind: 'warn',
      detail: '虚拟模型不带上游协议字段：/v1/responses 固定走 Chat 桥，托管工具与 namespace 分组会被丢弃并逐项记 lossy。',
    }
  }
  if (info.effectiveApi === 'responses') {
    return {
      label: '原生 Responses 透传',
      kind: 'good',
      detail: '有效协议为 responses（models.api 或上游 api）：/v1/responses 请求原样发往上游 Responses 路径，托管工具与 namespace 原样交给上游。',
    }
  }
  return {
    label: 'Chat 桥（有损）',
    kind: 'warn',
    detail: '模型与上游都未声明 responses（有效协议 ' + info.effectiveApi + '）：/v1/responses 会转换为 Chat 请求，托管工具/namespace 被丢弃并记 lossy。',
  }
}

function clientKeyEnabled() {
  const a = state.status && state.status.defaults && state.status.defaults.clientKey
  const b = state.config && state.config.defaults && state.config.defaults.clientKey
  return a === '********' || b === '********'
}

function capCounts(c = config()) {
  const counts = {}
  for (const cap of CAPS) counts[cap] = 0
  for (const m of modelEntries(c)) if (counts[m.capability] != null) counts[m.capability] += 1
  return counts
}

function probeFor(name) {
  const list = state.status && Array.isArray(state.status.models) ? state.status.models : []
  const hit = list.find((m) => m.name === name)
  return hit && hit.probe ? hit.probe : null
}

function probeCell(probe) {
  if (!probe) return h('div', null, tag('未测试', 'muted'), h('div', { class: 'hint', text: '无模型测试记录' }))
  const ok = !!probe.ok
  const parts = []
  if (probe.code != null) parts.push(String(probe.code))
  if (probe.ms != null) parts.push(probe.ms + ' ms')
  if (probe.at) parts.push(fmtTime(probe.at))
  return h('div', null,
    tag(ok ? '探活通过' : '探活失败', ok ? 'good' : 'bad'),
    h('div', { class: 'hint', text: (ok ? '真实上游验证（仅该次测试）' : '该次测试未通过') + (parts.length ? ' · ' + parts.join(' · ') : '') }))
}

function declaredCell(entry, cap) {
  if (entry.capability !== cap) return h('span', { class: 'muted', text: '—' })
  return h('div', null, tag('已声明', 'info'), h('div', { class: 'hint', text: '未验证' }))
}

function responsesCell(entry) {
  if (entry.capability !== 'chat') return h('span', { class: 'muted', text: '—' })
  const native = entry.effectiveApi === 'responses'
  return h('div', null,
    tag(native ? '原生透传' : 'Chat 桥', native ? 'good' : 'warn'),
    h('div', { class: 'hint', text: native ? 'hosted tools 保留' : 'hosted tools 丢弃' }))
}

function codexToml(model, url, keyOn) {
  const lines = [
    '# ~/.codex/config.toml（合并到你现有的 provider 配置，不要整文件覆盖）',
    '# Codex 0.167 起 wire_api="chat" 已不再支持；自定义 provider 必须使用 responses。',
    'model = "' + model + '"',
    'model_provider = "modelgate"',
    '',
    '[model_providers.modelgate]',
    'name = "ModelGate"',
    'base_url = "' + url + '"',
    'wire_api = "responses"',
  ]
  if (keyOn) {
    lines.push('# 网关启用了客户端密钥：只引用环境变量名，不要把 Key 写进本文件')
    lines.push('# env_key = "MODELGATE_API_KEY"')
  } else {
    lines.push('# 网关未启用客户端密钥：不需要 env_key；仍然不要在此粘贴任何真实上游 Key。')
  }
  return lines.join('\n')
}

function desktopFields(model, url, keyOn) {
  return [
    'Base URL:   ' + url,
    'Wire API:   responses',
    'Model:      ' + model,
    'API Key:    ' + (keyOn ? '<CLIENT_KEY 占位符>' : '<占位符>'),
    '',
    '# 桌面端设置界面随版本变化；字段名仅作对照，实际以客户端界面为准。',
    '# 控制台不读取桌面端配置，也不能证明它已连接。',
  ].join('\n')
}

function dshYaml(model, url) {
  return [
    '# ~/.dsh/profiles/<profile>/cordis.patch.yml（部署层；控制台不读取 ~/.dsh）',
    '- id: agent-default-model',
    '  config:',
    '    provider: modelgate',
    '    model: ' + JSON.stringify(model),
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      modelgate:',
    '        displayName: ModelGate',
    '        apiKeyEnv: MODELGATE_API_KEY   # 只填变量名；值放在你的环境变量里',
    '        baseURL: ' + JSON.stringify(url),
    '        api: openai-responses          # 或 openai-completions',
    '        models:',
    '          - id: ' + JSON.stringify(model),
  ].join('\n')
}

function sdkEnvSnippet(url) {
  return [
    '# 占位符：不要粘贴真实上游 Key。',
    'export OPENAI_BASE_URL="' + url + '"',
    'export OPENAI_API_KEY="<CLIENT_KEY_PLACEHOLDER>"',
  ].join('\n')
}

function pythonSnippet(model) {
  return [
    'from openai import OpenAI',
    '',
    'client = OpenAI()  # 读取上面的 OPENAI_BASE_URL / OPENAI_API_KEY',
    'resp = client.chat.completions.create(',
    '    model=' + JSON.stringify(model) + ',',
    '    messages=[{"role": "user", "content": "ping"}],',
    ')',
    'print(resp.choices[0].message.content)',
    '',
    '# Responses 通道（同一 base_url；网关按模型走原生透传或 Chat 桥）：',
    '# client.responses.create(model=' + JSON.stringify(model) + ', input="ping")',
  ].join('\n')
}

function curlSnippet(model, url, keyOn) {
  const auth = keyOn ? " -H 'authorization: Bearer <CLIENT_KEY>'" : ''
  const chat = '{"model":' + JSON.stringify(model) + ',"messages":[{"role":"user","content":"ping"}]}'
  const resp = '{"model":' + JSON.stringify(model) + ',"input":"ping"}'
  return [
    'curl -sS ' + url + '/models',
    '',
    "curl -sS " + url + "/chat/completions -H 'content-type: application/json'" + auth + " -d '" + chat + "'",
    '',
    "curl -sS " + url + "/responses -H 'content-type: application/json'" + auth + " -d '" + resp + "'",
  ].join('\n')
}

function stepList(steps) {
  return h('div', { class: 'list', style: { marginTop: '10px' } }, steps.map((s, i) => h('div', { class: 'list-row' },
    h('div', { class: 'grow' },
      h('div', { class: 'primary', text: (i + 1) + '. ' + s[0] }),
      h('div', { class: 'secondary', text: s[1] })))))
}

function codexCliTab(model, info, wire, url, keyOn) {
  return [
    h('p', { class: 'hint', text: '模板使用当前 origin 与上面选择的 chat 模型；Key 一律是占位符。' }),
    codeBlock(codexToml(model, url, keyOn), { copy: true }),
    stepList([
      ['写入或合并 ~/.codex/config.toml', '保留你已有的其它 provider；不要整文件覆盖。'],
      ['在客户端选择 model_provider = modelgate', '重新打开会话使配置生效。'],
      ['发一次最小请求，回到「监控与诊断」看 /api/logs 尾部', '日志窗口会显示 data POST /v1/responses 行，可据此判断请求是否到达网关。'],
      ['真实上游验证需要真实 Key 与额度', '控制台不能代替客户端发起这次验证，也不会自动标记成功。'],
    ]),
    h('div', { class: 'toolbar', style: { marginTop: '12px', marginBottom: '6px' } },
      tag(wire.label, wire.kind),
      h('span', { class: 'hint', text: info ? '有效协议 ' + (info.virtual ? '虚拟入口（固定桥接）' : info.effectiveApi) : '未选择模型' })),
    h('p', { class: 'hint', text: wire.detail }),
    callout('info', h('strong', { text: '工具保真：' }), 'Codex CLI 每轮固定发送 namespace 与 web_search 等托管工具；只有原生 Responses 透传能保留它们，Chat 桥会丢弃并记 lossy（见下方工具保真表）。'),
    callout('warn', h('strong', { text: 'Codex Desktop 另算：' }), '桌面端使用自己的设置界面，不能用本模板或 CLI 的验证结果代表桌面端；请单独验证，见「Codex Desktop」标签。'),
    callout('info', h('strong', { text: '要在同一会话切换官方与第三方？' }), '用下方「Codex 聚合（D1-A 内置 openai 身份）」卡片：它经 openai_base_url 改向，绝不生成 [model_providers.openai]（0.167 会因 reserved built-in provider ID 直接启动失败）。'),
  ]
}

function codexDesktopTab(model, info, wire, url, keyOn) {
  return [
    callout('warn', h('strong', { text: '不作为验证结论：' }), 'Codex Desktop 的设置入口与 CLI 不同；控制台既不读取它的配置，也无法探测它是否连接。CLI 的验证结果不覆盖桌面端。'),
    h('p', { class: 'hint', text: '字段对照（仅供在桌面端设置界面填写；字段名随版本变化）' }),
    codeBlock(desktopFields(model, url, keyOn), { copy: true }),
    kvList([
      ['协议', 'Responses（/v1/responses）'],
      ['模型', model],
      ['当前模型走线', wire.label],
      ['验证要求', '需在桌面端单独发起真实请求并回看 /api/logs；控制台不能代证'],
    ]),
    h('p', { class: 'hint', text: wire.detail }),
  ]
}

function dshTab(model, info, wire, url, keyOn) {
  return [
    h('p', { class: 'hint', text: 'DSH 通过 llm-pi-ai 的 provider 路由接入；api 选 openai-responses 或 openai-completions。' }),
    codeBlock(dshYaml(model, url), { copy: true }),
    kvList([
      ['Chat 端点', h('span', { class: 'mono-break', text: url + '/chat/completions' })],
      ['Responses 端点', h('span', { class: 'mono-break', text: url + '/responses' })],
      ['模型目录', h('span', { class: 'mono-break', text: url + '/models' })],
      ['当前模型走线', wire.label],
    ]),
    h('p', { class: 'hint', text: wire.detail }),
    callout('warn', h('strong', { text: '模型白名单：' }), 'DSH 侧可选模型由该 provider 的 models 列表决定，不是自动从网关拉取；手工声明的模型需要同时给出 api。网关侧按 /api/config 的 models、别名与虚拟名解析：未配置的名字在设置了 defaults.provider 时会回落到默认上游，否则请求报错。以 GET /v1/models 与路由试算为准，控制台不保证未配置模型可用。'),
    h('p', { class: 'hint', text: '控制台不读取 ~/.dsh 下的 profile、settings.yaml 或凭据；上面的 apiKeyEnv 只是变量名，真实值由你在环境中提供。' }),
  ]
}

function sdkTab(model, info, wire, url, keyOn) {
  return [
    h('p', { class: 'hint', text: '任何 OpenAI 兼容 SDK 只需改 base_url；下面全是占位符，不要粘贴真实上游 Key。' }),
    codeBlock(sdkEnvSnippet(url), { copy: true }),
    codeBlock(pythonSnippet(model), { copy: true }),
    kvList([
      ['Chat 路径', h('span', { class: 'mono-break', text: url + '/chat/completions' })],
      ['Responses 路径', h('span', { class: 'mono-break', text: url + '/responses' })],
      ['鉴权', keyOn ? '已启用客户端密钥：OPENAI_API_KEY 填客户端密钥占位符' : '未启用客户端密钥：SDK 仍需一个非空占位值，网关不会把它转成上游 Key'],
      ['当前模型走线', wire.label],
    ]),
    h('p', { class: 'hint', text: wire.detail }),
  ]
}

function customTab(model, info, wire, url, keyOn) {
  return [
    h('p', { class: 'hint', text: '自定义客户端只需实现 HTTP 契约；控制台不提供客户端 SDK，也不会自动识别你的客户端。' }),
    codeBlock(curlSnippet(model, url, keyOn), { copy: true }),
    h('p', { class: 'hint', text: wire.detail }),
    callout('info', h('strong', { text: '鉴权：' }), keyOn ? '控制台检测到客户端密钥已启用；所有请求需带 Authorization: Bearer <CLIENT_KEY>（占位符，永不回显）。' : '当前未检测到客户端密钥；请求无需鉴权头。若你把网关暴露到非回环地址，请先启用客户端/管理令牌。'),
  ]
}

// —— Codex 聚合（D1-A）：只导出 + 预览，永不从浏览器写盘 ——
function codexChangeTag (kind) {
  if (kind === 'add') return tag('新增', 'info')
  if (kind === 'replace') return tag('替换', 'warn')
  if (kind === 'same') return tag('不变', 'muted')
  return tag(String(kind), 'muted')
}

function codexPreviewBody (preview) {
  if (!preview) {
    return h('p', { class: 'hint', text: '把当前 ~/.codex/config.toml 全文粘贴到上面，再点「计算预览」：逐字段比对在本标签页内存中完成，不发请求、不写盘、不保存。' })
  }
  if (preview.empty) {
    return empty('还没有粘贴内容', '没有当前配置文本就无法给出真实差异；本页不会编造「当前值」。')
  }
  const nodes = []
  if (preview.blocked.length) nodes.push(callout('danger', h('strong', { text: '先处理阻断项：' }), preview.blocked.join(' ')))
  if (preview.conflicts.length) {
    nodes.push(callout('warn', h('strong', { text: '将覆盖既有值（' + preview.conflicts.length + ' 项）：' }), preview.conflicts.join('；')))
  }
  nodes.push(table([
    { label: '字段', render: (r) => h('span', { class: 'mono', text: r.path }) },
    { label: '变更', render: (r) => codexChangeTag(r.kind) },
    { label: '当前值', render: (r) => h('span', { class: 'mono-break muted', text: r.from == null ? '—（文件中没有）' : r.from }) },
    { label: '写入后', render: (r) => h('span', { class: 'mono-break', text: r.to }) },
    { label: '位置', render: (r) => h('span', { class: 'muted', text: r.line == null ? '追加' : '第 ' + r.line + ' 行' }) },
  ], preview.rows, { emptyTitle: '没有可预览的字段' }))
  nodes.push(h('p', { class: 'hint', text: '只读保留：顶层 ' + (preview.preserved.topLevelKeys.join('、') || '无') + ' · 段 ' + (preview.preserved.sections.join('、') || '无') + (preview.preserved.mcpServers.length ? ' · MCP ' + preview.preserved.mcpServers.join('、') : '') + '。' }))
  nodes.push(h('p', { class: 'hint', text: '预览只看字段级差异；真实写入由服务端按 mg-codex-config/1 执行（sha256 前置校验、.bak 备份、写后校验、可回滚），并拒绝改动未在所有权声明内的行。' }))
  return h('div', null, nodes)
}

function codexAggCard (model, gatewayUrl, s, ctx) {
  const origin = String(gatewayUrl || '').replace(/\/v1\/?$/, '')
  const catalogPath = (s && s.codex && s.codex.catalog && s.codex.catalog.path) || ''
  const features = CODEX.v2 ? { multi_agent_v2: true } : null
  const opts = { openaiBaseUrl: origin, model, modelCatalogJsonPath: catalogPath, features }
  const tpl = codexIdentityTemplate(opts)
  const plan = codexExportPlan(opts)
  const catalog = catalogState(s)
  const write = writePathState(s)

  // 首次渲染后探测 /api/codex/policy：只重渲染一次，把服务端声明/目录世代带进徽标。
  if (!CODEX.probed) {
    CODEX.probed = true
    probeCodexPolicy().then(() => { if (ctx && typeof ctx.rerender === 'function') ctx.rerender() }).catch(() => {})
  }

  const textarea = h('textarea', { id: 'codex-config-paste', spellcheck: 'false', placeholder: '# 粘贴 ~/.codex/config.toml 全文；仅在本标签页内存中比较，不发送、不保存' })
  textarea.value = CODEX.pasted
  textarea.addEventListener('input', () => { CODEX.pasted = textarea.value })
  const previewHost = h('div', { id: 'codex-preview' }, codexPreviewBody(CODEX.preview))

  const v2Box = h('input', { type: 'checkbox', id: 'codex-v2', checked: CODEX.v2 !== false })
  v2Box.addEventListener('change', () => { CODEX.v2 = !!v2Box.checked; if (ctx && typeof ctx.rerender === 'function') ctx.rerender() })

  const tools = h('div', { class: 'toolbar', style: { marginTop: '10px' } },
    h('button', { class: 'btn btn-primary', type: 'button', text: '计算预览', onclick: () => {
      CODEX.preview = previewOwnedChange(CODEX.pasted, opts)
      previewHost.replaceChildren(codexPreviewBody(CODEX.preview))
    } }),
    h('button', { class: 'btn', type: 'button', text: '导出模板 .toml', onclick: () => { downloadText('modelgate-codex-d1a.toml', tpl); toast('已导出模板片段（不含凭据）', 'success') } }),
    h('button', { class: 'btn', type: 'button', text: '导出计划 .json', onclick: () => { downloadJson('modelgate-codex-d1a-plan.json', plan); toast('已导出计划 JSON（export-only）', 'success') } }),
    h('label', { class: 'hint', for: 'codex-v2', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, v2Box, '[features] multi_agent_v2 = true（D3 v2 优先，0.167 默认 false）'))

  const ownerRows = ownershipRows().map((f) => ({ ...f }))
  const ownership = table([
    { label: '字段/范围', render: (r) => h('span', { class: 'mono-break', text: r.path }) },
    { label: '范围', render: (r) => h('span', { class: 'muted', text: r.scope }) },
    { label: '所有者', render: (r) => { const o = ownerLabel(r.owner); return tag(o.label, o.kind) } },
    { label: '说明', render: (r) => h('span', { class: 'muted', text: r.note }) },
  ], ownerRows)

  return card('Codex 聚合（D1-A 内置 openai 身份）',
    '同一新会话里同时看到官方 GPT 与第三方模型：沿用内置 openai 身份与官方登录，用 openai_base_url 把请求改向 ModelGate。本卡片只导出与预览；不写盘、不重启客户端、不读取凭据。',
    h('div', null,
      callout('warn', h('strong', { text: '身份事实（Codex 0.167 实测）：' }),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, IDENTITY_FACTS.map((t) => h('li', { text: t, style: { marginBottom: '4px' } })))),
      h('div', { class: 'toolbar', style: { margin: '10px 0 6px' } },
        tag('model_provider = "openai"', 'info'),
        tag('openai_base_url → ' + origin, 'info'),
        tag('目录世代 ' + catalog.label, catalog.kind),
        tag(write.label, write.kind)),
      h('p', { class: 'hint', text: catalog.detail }),
      h('p', { class: 'hint', text: write.detail }),
      h('p', { class: 'hint', text: '模板（只含所有权字段与注释；不要写 [model_providers.openai]，也不要写 auth.json）：' }),
      codeBlock(tpl, { copy: true }),
      tools,
      h('div', { class: 'field', style: { marginTop: '14px' } },
        h('label', { for: 'codex-config-paste', text: '当前配置（本地粘贴，仅用于差异预览）' }),
        textarea,
        h('span', { class: 'field-help', text: '不要粘贴含密钥的文件；控制台不会把这段文本发到任何地方，也不会持久化。' })),
      previewHost,
      h('div', { style: { marginTop: '14px' } }, ownership),
      callout('info', h('strong', { text: '风险与边界：' }),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, RISK_NOTES.map((t) => h('li', { text: t, style: { marginBottom: '4px' } }))))),
    { foot: 'export-only：本页不发起写请求；受控写入契约 mg-codex-config/1（字段所有权 + sha256 前置校验 + .bak + 写后校验 + 回滚），由服务端 /api/codex/* 在具备本地写权限时执行。' })
}

function tabContent(tab, model, info, wire, url, keyOn) {
  if (tab === 'codex-desktop') return codexDesktopTab(model, info, wire, url, keyOn)
  if (tab === 'dsh') return dshTab(model, info, wire, url, keyOn)
  if (tab === 'sdk') return sdkTab(model, info, wire, url, keyOn)
  if (tab === 'custom') return customTab(model, info, wire, url, keyOn)
  return codexCliTab(model, info, wire, url, keyOn)
}

function accessCard(url, keyOn, s) {
  const body = h('div', null,
    kvList([
      ['Base URL', h('span', { class: 'mono-break', text: url })],
      ['Chat 端点', h('span', { class: 'mono-break', text: url + '/chat/completions' })],
      ['Responses 端点', h('span', { class: 'mono-break', text: url + '/responses' })],
      ['模型目录', h('span', { class: 'mono-break', text: url + '/models' })],
      ['客户端鉴权', keyOn ? '已启用（/api/status 中 defaults.clientKey 为掩码）；请求头使用 Bearer 占位符' : '未启用（配置与运行期均未检测到客户端密钥）'],
    ]),
    h('div', { class: 'toolbar', style: { marginTop: '10px', marginBottom: '0' } }, copyButton(url, '复制 Base URL')))
  return card('接入坐标', 'Base URL 由浏览器地址栏的 origin 生成；客户端必须能访问该地址（默认只绑回环时，其它机器/容器不可达）。', body, {
    foot: '来源 location.origin 与 /api/status · 配置版本 ' + (s.configVersion == null ? '—' : s.configVersion) + ' · 读取于 ' + (state.loadedAt ? fmtTime(state.loadedAt) : '—'),
  })
}

function modelPickerCard(c, selected, info, wire, ctx) {
  const choices = chatChoices(c)
  let body
  if (!choices.length) {
    body = h('div', null,
      empty('没有可用的 chat 模型', '模板将使用 <model> 占位符。请先在「模型与路由」添加 capability=chat 的真实模型或虚拟入口。',
        h('button', { class: 'btn btn-primary', type: 'button', text: '去配置模型', onclick: () => { location.hash = '#/models' } })),
      h('p', { class: 'hint', text: '模板里的地址仍然真实可用；模型名需要你手动替换。' }))
  } else {
    const select = h('select', { id: 'client-model-select' }, choices.map((o) => h('option', { value: o.name, selected: o.name === selected, text: o.name + (o.virtual ? '（虚拟入口）' : '（' + o.detail + '）') })))
    select.addEventListener('change', () => { view.model = select.value; if (ctx && typeof ctx.rerender === 'function') ctx.rerender() })
    body = h('div', null,
      h('div', { class: 'field' },
        h('label', { for: 'client-model-select', text: '模板使用的模型' }),
        select,
        h('span', { class: 'field-help', text: '来自 /api/config：chat 能力模型与虚拟入口；切换后所有模板同步更新。' })),
      h('div', { class: 'toolbar', style: { marginBottom: '6px' } },
        tag(wire.label, wire.kind),
        info ? tag('capability=' + info.capability, 'muted') : null,
        info && !info.virtual && info.provider ? tag('上游 ' + info.provider, 'muted') : null),
      h('p', { class: 'hint', text: wire.detail }))
  }
  return card('模板模型', '控制台只使用真实配置里的模型名；没有就是没有，不会编造模型。', body, { foot: '来源 /api/config · 读取于 ' + (state.loadedAt ? fmtTime(state.loadedAt) : '—') })
}

function endpointCard(models, virtuals, counts) {
  const rows = [
    { entry: 'GET /v1/models', note: '列出真实模型与虚拟入口；静态目录，不触上游', cap: '', count: null },
    { entry: 'POST /v1/chat/completions', note: 'OpenAI Chat 兼容入口', cap: 'chat', count: counts.chat },
    { entry: 'POST /v1/responses', note: 'Responses 入口；按模型走原生透传或 Chat 桥', cap: 'chat', count: counts.chat },
    { entry: 'POST /v1/embeddings', note: '仅 capability=embedding 的真实模型', cap: 'embedding', count: counts.embedding },
    { entry: 'POST /v1/rerank', note: '仅 capability=rerank 的真实模型', cap: 'rerank', count: counts.rerank },
    { entry: 'POST /v1/audio/speech · /v1/audio/transcriptions', note: 'speech 返回二进制；transcriptions 为 multipart', cap: 'audio', count: counts.audio },
    { entry: 'POST /v1/images/generations · /v1/images/edits', note: 'edits 为 multipart', cap: 'image', count: counts.image },
    { entry: 'POST /v1/videos · GET /v1/videos/:id · POST /v1/videos/:id/cancel', note: '异步任务（创建返回 202）', cap: 'video', count: counts.video },
  ]
  return card('数据面端点', '路径都相对于当前 origin；能力列决定调用是否会被网关接受。', table([
    { label: '方法路径', render: (r) => h('span', { class: 'mono-break', text: r.entry }) },
    { label: '说明', render: (r) => h('span', { class: 'muted', text: r.note }) },
    { label: '所需能力', render: (r) => r.cap ? h('span', { class: 'mono', text: r.cap }) : h('span', { class: 'muted', text: '—' }) },
    { label: '当前配置', render: (r) => {
      if (!r.cap) return h('div', null, tag('已提供', 'good'), h('div', { class: 'hint', text: models.length + ' 个真实模型 / ' + virtuals.length + ' 个虚拟入口' }))
      if (r.count > 0) return h('div', null, tag('已声明 ' + r.count + ' 个', 'info'), h('div', { class: 'hint', text: '未验证' }))
      return h('div', null, tag('未配置该能力模型', 'muted'))
    } },
  ], rows, { emptyTitle: '没有端点数据' }), { foot: '来源 /api/config 与网关路由实现 · Base URL ' + baseUrl() })
}

function templateCard(model, info, wire, url, keyOn, ctx) {
  const tabBar = tabs(TABS, view.tab, (id) => { view.tab = id; if (ctx && typeof ctx.rerender === 'function') ctx.rerender() })
  return card('接入模板', '每个模板只含占位符；地址来自当前 origin，模型来自上面的选择。', h('div', null, tabBar, tabContent(view.tab, model, info, wire, url, keyOn)))
}

function legendCard() {
  const rows = [
    { state: '已配置', kind: 'info', meaning: '/api/config 中存在该上游、模型或路由条目；不代表 Key 可用或上游可达。', console: '能自动判定（配置事实）' },
    { state: 'Mock 验证', kind: 'muted', meaning: '仓库离线套件用本地 mock 验证协议与桥接逻辑；不触真实上游，不验证账号、额度或厂商差异。', console: '不能判定（本页不运行测试）' },
    { state: '真实客户端验证', kind: 'warn', meaning: 'Codex、DSH 或 SDK 实际发起并完成过请求；需要客户端侧证据。', console: '不能自动判定：不读取客户端配置/认证文件，也不探测连接' },
    { state: '真实上游验证', kind: 'good', meaning: '上游真实返回 2xx；只有真实请求或手动模型测试才产生。', console: '部分：只显示手动触发的模型测试探活结果，不能代替客户端验证' },
    { state: '降级或不支持', kind: 'bad', meaning: '能力未声明、Chat 桥有损、熔断/缺 Key、入口未提供或参数被显式拒绝。', console: '能推导（配置 + /api/status）' },
  ]
  return card('验证口径', '状态标签只有下列五种含义；控制台不会把「配置存在」写成「已连通」。', table([
    { label: '状态', render: (r) => tag(r.state, r.kind) },
    { label: '含义', render: (r) => h('span', { text: r.meaning }) },
    { label: '控制台能否判定', render: (r) => h('span', { class: 'muted', text: r.console }) },
  ], rows), { foot: '本页不产生新的验证证据；历史验证记录属于项目文档，不等于你当前实例的状态。' })
}

function fidelityCard() {
  const rows = [
    { item: '托管工具（web_search / file_search / code_interpreter / mcp / computer_* / image_generation / local_shell）', native: '原样透传给上游', bridge: '丢弃，日志记 tool_dropped:<type>' },
    { item: 'namespace 分组（Codex 的 multi_agent_v1 等）', native: '原样透传', bridge: '丢弃，记 tool_dropped:namespace' },
    { item: 'tool_choice 点名被丢弃的工具', native: '原样透传', bridge: '降级为 auto，记 tool_choice_dropped:<name>' },
    { item: 'store=true / previous_response_id / background / truncation≠disabled', native: '400 显式拒绝', bridge: '400 显式拒绝' },
    { item: 'include（仅 reasoning.encrypted_content / output_text.logprobs）', native: '交给上游处理', bridge: '接受但丢弃，记 include_dropped:<项>' },
    { item: '图片 / 文件 / 音频输入', native: '透传上游', bridge: '非文本 part 被丢弃' },
    { item: 'SSE sequence_number', native: '上游原值', bridge: '网关生成，与上游不可比' },
  ]
  return card('工具保真：原生 Responses vs Chat 桥', '同一个 /v1/responses 入口，按模型有效协议走两条路径。', table([
    { label: '项目', render: (r) => h('span', { text: r.item }) },
    { label: '原生 Responses', render: (r) => h('span', { class: 'muted', text: r.native }) },
    { label: 'Chat 桥', render: (r) => h('span', { class: 'muted', text: r.bridge }) },
  ], rows), { foot: '有损项会写进日志（lossy）；可在「监控与诊断」的日志窗口查看。' })
}

function capabilityCard(models) {
  if (!models.length) {
    return card('能力矩阵', '没有真实模型可展示。', empty('模型目录为空', '在「模型与路由」添加真实模型后，这里会按 capability 与有效协议列出各入口的声明状态。'), { foot: '来源 /api/config' })
  }
  const columns = [
    { label: '模型', render: (m) => h('span', { class: 'mono-break', text: m.name }) },
    { label: '上游', render: (m) => h('span', { class: 'muted', text: m.provider || '—' }) },
    { label: '能力声明', render: (m) => tag(m.capability, 'muted') },
    { label: '有效协议', render: (m) => h('span', { class: 'mono', text: m.effectiveApi }) },
    { label: 'chat', render: (m) => declaredCell(m, 'chat') },
    { label: 'responses', render: (m) => responsesCell(m) },
    { label: 'embedding', render: (m) => declaredCell(m, 'embedding') },
    { label: 'rerank', render: (m) => declaredCell(m, 'rerank') },
    { label: 'audio', render: (m) => declaredCell(m, 'audio') },
    { label: 'image', render: (m) => declaredCell(m, 'image') },
    { label: 'video', render: (m) => declaredCell(m, 'video') },
    { label: '最近模型测试', render: (m) => probeCell(probeFor(m.name)) },
  ]
  return card('能力矩阵', '「已声明」不等于可用：控制台不会为验证兼容性发起真实请求。有效协议 = models.api 优先，留空继承上游 api。', table(columns, models, { emptyTitle: '模型目录为空' }), { foot: '来源 /api/config（声明）与 /api/status（模型测试探活）· 读取于 ' + (state.loadedAt ? fmtTime(state.loadedAt) : '—') })
}

function virtualCard(virtuals) {
  const stateLabel = { none: ['不限制', 'muted'], valid: ['限期', 'info'], expired: ['已过期', 'bad'], invalid: ['有效期无效（拒绝放行）', 'bad'], unknown: ['未知', 'muted'] }
  const rows = virtuals.map((v) => {
    const [label, kind] = stateLabel[v.expiresAtState] || stateLabel.unknown
    return {
      name: v.name,
      count: v.directory.length,
      models: v.directory.slice(0, 4).map((e) => e && e.model ? e.model : '?').join('、') + (v.directory.length > 4 ? ' …' : ''),
      expiry: tag(label, kind),
    }
  })
  return card('虚拟模型入口', '虚拟入口可用于 chat/Responses，但 /v1/responses 固定走 Chat 桥；媒体与向量入口要求真实模型。有效期状态由后端 expiresAtState 判定，不从 0 或本地时钟推断。', table([
    { label: '入口', render: (r) => h('span', { class: 'mono', text: r.name }) },
    { label: '目录模型数', render: (r) => String(r.count) },
    { label: '目录（前 4 个）', render: (r) => h('span', { class: 'mono-break', text: r.models || '—' }) },
    { label: '有效期（后端判定）', render: (r) => r.expiry },
  ], rows), { foot: '来源 /api/config · virtualModels（expiresAtState/expiresAtMs 为后端投影）' })
}

function securityCard(keyOn) {
  const items = [
    '不要把真实上游 Key 粘贴到客户端模板、截图或聊天记录；模板里只有占位符。',
    '控制台不读取 ~/.codex/auth.json、~/.codex/config.toml、~/.dsh、.env 或任何凭据文件，也不会写这些文件。',
    '模型测试/探活只在你于其它页面手动触发时发生；本页不发起模型请求，不产生费用。',
    keyOn ? '已经检测到客户端密钥（/api/status 中为掩码）；所有数据面请求都要带 Authorization: Bearer <CLIENT_KEY>。' : '未检测到客户端密钥；若把网关暴露到非回环地址，请先启用客户端/管理令牌并置于 HTTPS 反向代理之后。',
  ]
  return card('安全边界', '模板与控制台都不会读取或保存客户端凭据。', h('ul', { style: { margin: '0', paddingLeft: '18px' } }, items.map((t) => h('li', { text: t, style: { marginBottom: '6px' } }))))
}

function unsupportedCard() {
  const rows = [
    { item: 'POST /v1/completions（legacy Completions）', status: '未提供', kind: 'muted', note: '网关没有该入口；OpenAI 客户端若使用 legacy completions 会 404。' },
    { item: 'POST /v1/messages（Anthropic 原生入口）', status: '未提供', kind: 'muted', note: 'Anthropic 上游只经 Chat 桥适配；客户端仍需走 /v1/chat/completions。' },
    { item: 'OpenAI 模型管理写接口', status: '未提供', kind: 'muted', note: '模型目录只读（GET /v1/models），管理走 /api/config。' },
    { item: 'Responses 的 store=true / previous_response_id / background / truncation≠disabled', status: '显式拒绝', kind: 'bad', note: '原生与 Chat 桥两条路径都返回 400 unsupported_parameter，不静默降级。' },
    { item: 'include 非 reasoning.encrypted_content / output_text.logprobs', status: '显式拒绝', kind: 'bad', note: '图片、托管产物与未知项返回 400；白名单项接受但记 lossy。' },
    { item: '虚拟入口用于 embedding / rerank / audio / image / video', status: '拒绝', kind: 'bad', note: '这些入口要求真实模型且 capability 匹配；虚拟/默认共用名不支持媒体能力。' },
  ]
  return card('未提供或明确拒绝', '这些不是「未验证」，而是当前实现不提供或不接受；不要按 OpenAI 全量 API 预期。', table([
    { label: '入口/字段', render: (r) => h('span', { text: r.item }) },
    { label: '现状', render: (r) => tag(r.status, r.kind) },
    { label: '说明', render: (r) => h('span', { class: 'muted', text: r.note }) },
  ], rows), { foot: '依据网关路由实现与 Responses 契约；控制台只做说明，不发送请求验证。' })
}

export function render(root, ctx = {}) {
  const c = config()
  const s = state.status || {}
  const models = modelEntries(c)
  const virtuals = virtualEntries(c)
  const counts = capCounts(c)
  const selected = pickModel(c)
  view.model = selected
  const info = modelInfo(selected, c)
  const wire = wireInfo(info)
  const model = selected || '<model>'
  const url = baseUrl()
  const keyOn = clientKeyEnabled()

  root.append(pageHead('客户端接入', '把真实模型接入 Codex、DSH 与 OpenAI 兼容 SDK。模板按当前 origin 与模型目录生成；控制台不读取客户端配置，也不会自动判定「已连接」。', {
    eyebrow: 'CLIENTS / INTEGRATION',
    actions: [
      copyButton(url, '复制 Base URL'),
      h('button', { class: 'btn', type: 'button', text: '模型与路由', onclick: () => { location.hash = '#/models' } }),
      h('button', { class: 'btn', type: 'button', text: '导出客户端接入 JSON', onclick: () => { downloadJson('modelgate-client-export.json', buildClientExport()); toast('已导出客户端接入清单（仅客户端字段，无凭据）', 'success') } }),
      h('button', { class: 'btn', type: 'button', text: '监控与诊断', onclick: () => { location.hash = '#/observability' } }),
    ],
  }))

  root.append(callout('warn',
    h('strong', { text: '边界：' }),
    '控制台读不到 ~/.codex/config.toml、~/.codex/auth.json、~/.dsh/* 或你的环境变量，也不会自动探测客户端连接。本页只根据 /api/config 与 /api/status 推导「应如何配置」，不显示「已连接」；未验证的能力会明确标出。'))
  // 旧入口保留：/admin 不删除，退役条件（核心操作等价 + 双跑通过 + E2E 证据）满足前必须可用。
  root.append(callout('info',
    h('strong', { text: '旧面板仍可用：' }),
    ' /admin（旧 UI）保留为回退入口。退役条件：本页覆盖的核心操作与旧面板等价、两套入口双跑通过、真实浏览器 E2E 有证据；在此之前不得删除旧面板。'))

  root.append(h('div', { class: 'grid grid-main' },
    accessCard(url, keyOn, s),
    modelPickerCard(c, selected, info, wire, ctx)))

  root.append(endpointCard(models, virtuals, counts))
  root.append(templateCard(model, info, wire, url, keyOn, ctx))
  root.append(codexAggCard(model, url, s, ctx))
  root.append(h('div', { class: 'grid grid-main' }, legendCard(), fidelityCard()))
  root.append(capabilityCard(models))
  if (virtuals.length) root.append(virtualCard(virtuals))
  root.append(securityCard(keyOn))
  root.append(unsupportedCard())

  root.append(h('p', { class: 'page-note', text: '数据来源：/api/config（模型、能力、协议声明）与 /api/status（运行状态、模型测试记录）；模板在浏览器内按当前 origin 生成。读取于 ' + (state.loadedAt ? fmtTime(state.loadedAt) : '—') + '。本页没有发起任何真实模型请求。' }))
}
