// A3 / P03 + A2 / UX-03：聚合详情视图——一键启停原版 Codex Desktop 接入、诊断与无损退出。
//
// UX-03（A2）整理：默认页面只保留结论、主操作与重启提示；SHA/备份/版本/原生压缩/
// 供应商/模型/诊断长表统一收进「高级详情」折叠区（深链 #/aggregation 不变），
// 并去掉 V1 的「Console 目录一次全量」旧话术——Go 默认 preset=opencode-go + DeepSeek V4.1 Flash。
//
// 约束（与 views/codex.js 一致）：
//  * 纯前端、零依赖、不 import 后端模块；不读本地文件、不写 cookie/localStorage。
//  * 浏览器没有本地文件权限：所有读写都经同源管理 API（/api/aggregation/*），
//    由服务端 src/codex/desktop-integration.js 执行"预览 → 确认 → 备份 → 原子写 → 验证"。
//  * 只渲染真实响应；发现不完整/失败时明确说"不是 0 个模型"，绝不把部分列表当全量。
//  * 409 冲突只展示三方差异，不覆盖用户改动；接口返回 404 时提示版本/实例原因，不假装成功。
import { h } from '../dom.js'
import {
  pageHead, card, metric, tag, callout, empty, field, dialog, confirmDialog, toast, table, kvList, codeBlock,
} from '../components.js'
import { state, refreshProduct } from '../store.js'
import { request } from '../api.js'
import { fmtTime, fmtInt, safeHost } from '../format.js'

export const AGGREGATION_VIEW_CONTRACT = 'mg-ui-aggregation/1'

// V2 唯一交付目标（来自产品契约）：面向用户只显示模型名，不要求理解公共 ID。
export const GO_TARGET_LABEL = 'DeepSeek V4.1 Flash'
export const GO_PROVIDER_PRESET = 'opencode-go'

// ADR-0003 §5 的冻结 HTTP 面（本视图只使用这些路径）。
export const AGGREGATION_ENDPOINTS = Object.freeze({
  providers: '/api/aggregation/providers',
  provider: (id) => '/api/aggregation/providers/' + encodeURIComponent(String(id || '')),
  sync: (id) => '/api/aggregation/providers/' + encodeURIComponent(String(id || '')) + '/sync',
  models: '/api/aggregation/models',
  health: '/api/aggregation/health',
  diagnostics: '/api/aggregation/diagnostics',
  // 三模式（直连/路由/聚合）契约面。activate/deactivate 保留向后兼容旧 UI 路径。
  modes: '/api/aggregation/modes',
  switch: '/api/aggregation/switch',
  rollback: '/api/aggregation/rollback',
  // 漂移解漂：采纳当前 config 字节作为 state 基线，只更新 state、不改 config.toml 内容。
  reconcile: '/api/aggregation/reconcile',
  activate: '/api/aggregation/activate',
  deactivate: '/api/aggregation/deactivate',
})

// 三模式元数据（对外一律用「接入方式」措辞；不声称已写入契约）。
export const THREE_MODES = Object.freeze([
  { id: 'official', label: '官方直连', description: '不经 ModelGate，使用 Codex 官方默认配置。' },
  { id: 'route', label: '路由', description: '纯 DeepSeek（父=子=mg-opencodego-deepseek-v4-1-flash），零 GPT 调用。' },
  { id: 'aggregated', label: '聚合', description: 'GPT 父（默认 gpt-6-luna）+ DeepSeek 子。' },
])

// 父模型默认与验收标记：只有 luna 是已签收/PASS_REAL，其余一律 UNVERIFIED。
export const DEFAULT_PARENT_MODEL = 'gpt-6-luna'
export const PASS_REAL_PARENT_MODEL = 'gpt-6-luna'

const AGG = {
  fetched: false,
  loading: false,
  // 逐端点记录缺失，不再把一个接口的 404 放大成"聚合接口全挂"。
  routeMissing: false,      // 四个只读接口（health/providers/models/diagnostics）任一缺失
  modesUnavailable: false,  // 仅 modes 缺失：只禁用三模式切换，不影响其它接口
  reconcileUnavailable: false, // reconcile 缺失：只禁用「重新对齐配置」，其它展示不受影响
  missingRoutes: [],        // 实际 404 的端点路径，供 routeNotice 如实列出
  health: null,
  modes: null,
  selectedMode: null,
  selectedParent: DEFAULT_PARENT_MODEL,
  providers: null,
  models: null,
  diagnostics: null,
  loadedAt: 0,
  healthError: null,
  modesError: null,
  providersError: null,
  modelsError: null,
  diagnosticsError: null,
}

// —— 纯函数（可在无 DOM 环境下测试）——
// 三模式标签：直连/路由/聚合 + 未知。drifted（配置漂移）单独降级为 warn，
// 但绝不把 unknown 显示成直连。
export function modeLabel (mode, drifted) {
  const drift = drifted === true
  let base
  switch (mode) {
    case 'official':
      base = { mode: 'official', label: '官方直连（不经 ModelGate）', kind: 'muted' }
      break
    case 'route':
      base = { mode: 'route', label: '路由模式（纯 DeepSeek，无 GPT）', kind: 'info' }
      break
    case 'aggregated':
      base = { mode: 'aggregated', label: '聚合模式（GPT 父 + DeepSeek 子）', kind: 'good' }
      break
    default:
      base = { mode: 'unknown', label: '状态未知', kind: 'warn' }
  }
  if (drift && base.mode !== 'unknown') {
    return Object.assign({}, base, { label: base.label + ' · 配置漂移（需重新检测）', kind: 'warn', drifted: true })
  }
  return Object.assign({}, base, { drifted: false })
}

// 父模型选项：来源 GET /api/aggregation/modes 的 selectableParents。
// 只有 luna 标注「已签收/PASS_REAL」，其余一律「未验证（UNVERIFIED）」——不得暗示同等可信。
export function selectableParentModels (modesPayload) {
  const p = modesPayload && typeof modesPayload === 'object' ? modesPayload : {}
  const modes = Array.isArray(p) ? p : (Array.isArray(p.modes) ? p.modes : [])
  const aggregated = modes.find((m) => m && m.id === 'aggregated') || {}
  const raw = Array.isArray(p.selectableParents)
    ? p.selectableParents
    : (Array.isArray(aggregated.selectableParents) ? aggregated.selectableParents : [])
  const seen = new Set()
  const options = []
  for (const item of raw) {
    const id = typeof item === 'string' ? item : (item && (item.id || item.model || item.name))
    const key = id == null ? '' : String(id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const passReal = key === PASS_REAL_PARENT_MODEL
    options.push({
      id: key,
      verified: passReal,
      label: key + (passReal ? '（已签收/PASS_REAL）' : ' — 未验证（UNVERIFIED）'),
      kind: passReal ? 'good' : 'warn',
    })
  }
  // 默认项始终可见（后端未列出时也给出可选项，但标明是否验证）。
  if (!seen.has(DEFAULT_PARENT_MODEL)) {
    options.unshift({
      id: DEFAULT_PARENT_MODEL,
      verified: true,
      label: DEFAULT_PARENT_MODEL + '（已签收/PASS_REAL）',
      kind: 'good',
    })
  }
  return options
}

// 切换请求体：mode + 可选 parentModel + consentToken + expectedSha。
// 预览（未确认）阶段不带 token/expectedSha，由 confirm 阶段补齐。
export function buildSwitchRequest (preview, consent, mode, parentModel) {
  const p = preview || {}
  const body = { mode: mode || 'aggregated' }
  if (parentModel) body.parentModel = String(parentModel)
  body.consentToken = consent ? (p.consentToken || '') : ''
  body.expectedSha = p.expectedSha == null ? '' : String(p.expectedSha)
  return body
}

// 回滚请求体：契约只接受 consentToken + expectedSha；目标模式由服务端取 previousMode。
export function buildRollbackRequest (preview, consent) {
  const p = preview || {}
  return {
    consentToken: consent ? (p.consentToken || '') : '',
    expectedSha: p.expectedSha == null ? '' : String(p.expectedSha),
  }
}

// 重新对齐请求体：与 rollback 同样只带 consentToken + expectedSha，不携带任何目标模式/字段值。
export function buildReconcileRequest (preview, consent) {
  return buildRollbackRequest(preview, consent)
}

// 发现诚实性：failed / partial / complete-empty / complete / unknown 五种状态。
// 返回值里的 countText 只在"完整目录"时才给出总数；其它情况给已获取数并明确"非完整"。
export function summarizeDiscovery (diagnostics, models) {
  const list = Array.isArray(models) ? models : (models && Array.isArray(models.models) ? models.models : [])
  const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : {}
  const discovery = diag.discovery && typeof diag.discovery === 'object' ? diag.discovery : diag
  const rawState = String(discovery.state || discovery.status || 'unknown')
  const discovered = Number.isFinite(Number(discovery.discovered)) ? Number(discovery.discovered) : list.length
  const reason = discovery.reason || discovery.error || (discovery.code ? String(discovery.code) : '')
  if (rawState === 'failed' || rawState === 'error') {
    return {
      state: 'failed',
      kind: 'bad',
      label: '发现失败',
      countText: null,
      count: null,
      detail: '没有拿到任何模型（这不是“0 个模型”）：' + (reason || '上游发现失败，原因未返回') + '。请重试同步或查看诊断码，UI 不会用空列表冒充完整目录。',
    }
  }
  if (rawState === 'partial' || discovery.complete === false || discovery.truncated === true) {
    return {
      state: 'partial',
      kind: 'warn',
      label: '发现未完成',
      countText: '已获取 ' + fmtInt(discovered) + ' 个（非完整）',
      count: discovered,
      detail: '只发现了一部分模型：' + (reason || '目录被截断或分页未完成') + '。当前列表不是完整目录，不能据此判断账号总共可用多少模型。',
    }
  }
  if (rawState === 'complete' && discovery.upstreamConfirmedEmpty === true && list.length === 0) {
    return {
      state: 'empty_confirmed',
      kind: 'muted',
      label: '上游确认无可用模型',
      countText: '0 个（上游明确返回空目录）',
      count: 0,
      detail: '上游明确返回了空授权目录；这不是发现失败，但也意味着当前账号没有任何可调用模型。',
    }
  }
  if (rawState === 'complete') {
    return {
      state: 'complete',
      kind: 'good',
      label: '完整目录',
      countText: fmtInt(list.length) + ' 个模型',
      count: list.length,
      detail: '发现已完成；以下列表是该账号授权范围内的完整目录（未授权模型单独标注，不会发布为可调用模型）。',
    }
  }
  return {
    state: 'unknown',
    kind: 'muted',
    label: '发现状态未知',
    countText: null,
    count: null,
    detail: '后端没有返回发现状态：不能把当前列表当成完整目录，也不能把空列表读成“0 个模型”。请刷新或查看诊断。',
  }
}

export function buildActivateRequest (preview, consent) {
  const p = preview || {}
  return {
    consentToken: consent ? (p.consentToken || '') : '',
    expectedSha: p.expectedSha == null ? '' : String(p.expectedSha),
  }
}

export function describeThreeWay (conflict) {
  // A3 真机发现：调用方传的是 ApiError（body 在 .data），旧实现只读 conflict.detail，
  // 于是 409 弹窗永远显示"服务端未返回三方差异"。这里同时接受 ApiError 与原始 body。
  const body = conflict && conflict.data && typeof conflict.data === 'object' ? conflict.data : conflict
  const tw = body && body.detail && body.detail.threeWay ? body.detail.threeWay : null
  if (!tw) return { available: false, rows: [], summary: '服务端未返回三方差异；未做任何写入。' }
  const rows = Array.isArray(tw.oursVsTheirs) ? tw.oursVsTheirs.filter((r) => r.kind !== 'same') : []
  return {
    available: true,
    rows,
    raw: tw,
    summary: '接入后配置被外部修改：ModelGate 保留你的改动，不覆盖。基准 ' + (tw.base ? tw.base.sha256.slice(0, 8) : '—') +
      ' · 我们写入 ' + (tw.ours ? tw.ours.sha256.slice(0, 8) : '—') + ' · 当前 ' + (tw.theirs ? tw.theirs.sha256.slice(0, 8) : '—'),
    guidance: tw.guidance || '保持现状，先手工合并。',
  }
}

function shaShort (sha) {
  return sha ? String(sha).slice(0, 12) : '—'
}

export function versionLabel (info) {
  if (!info) return { text: '未知', kind: 'muted' }
  if (!info.found) return { text: '未检测到', kind: 'muted' }
  if (info.versionState === 'known' && info.version) return { text: info.version, kind: 'info' }
  if (info.versionState === 'not_probed') return { text: '未探测（不执行该二进制）', kind: 'muted' }
  if (info.versionState === 'unknown') return { text: '版本未知', kind: 'muted' }
  return { text: '未探测', kind: 'muted' }
}

function versionCell (info) {
  const v = versionLabel(info)
  return tag(v.text, v.kind)
}

// 重启提示判定（纯函数，可在无 DOM 环境测试）：
// 服务端用只读的客户端进程启动时间与写入时间比对，重启后提示自动消失。
// 三模式：route / aggregated 切换后都需要重启；切回 official 时若 reason=client_running_after_exit
// 同样需要重启（退出后也要重启）。unknown 不当成"无需重启"。
export function restartNotice (restart, mode) {
  const r = restart && typeof restart === 'object' ? restart : null
  const reason = r ? String(r.reason || '') : ''
  const afterExit = reason === 'client_running_after_exit'
  const changedMode = mode === 'aggregated' || mode === 'route' || (mode === 'official' && afterExit)

  // 未改接入方式（官方直连且没有"切回"信号）：无需重启。绝不显示"立即生效"。
  if (!changedMode) {
    return { needed: false, tone: 'muted', label: '无需重启', detail: '当前是官方直连模式（不经 ModelGate），配置未改向 ModelGate。' }
  }
  if (!r) {
    return { needed: true, tone: 'warn', label: '需要重启 Codex 生效', detail: '服务端未返回重启判定；配置在客户端下次启动后生效，请完全退出并重新打开 Codex Desktop。' }
  }
  if (r.reason === 'client_restarted_after_apply') {
    return { needed: false, tone: 'good', label: '已检测到客户端重启', detail: '原版 Desktop 在写入后启动过，新配置已加载；请在新会话的模型选择器里核对官方模型与模式对应模型。' }
  }
  if (r.reason === 'client_running_after_exit') {
    return { needed: true, tone: 'warn', label: '退出后也要重启 Codex', detail: '已从路由/聚合模式切回官方直连，但 Codex 仍以旧配置运行。请完全退出并重新打开 Codex Desktop（退出后也要重启）才能使用新模式。' }
  }
  if (r.reason === 'client_running_with_old_config') {
    return { needed: true, tone: 'warn', label: '需要重启 Codex 生效', detail: '检测到 Codex 仍是写入前启动的进程，运行中的会话继续使用旧配置。请完全退出 Codex Desktop（不是只关窗口）再重新打开。' }
  }
  if (r.reason === 'client_not_running') {
    return { needed: true, tone: 'warn', label: '需要重新打开 Codex', detail: '当前没有检测到运行中的原版 Desktop；下次启动会自动读取新配置，启动后本页会按客户端启动时间自动消除该提示。' }
  }
  if (r.reason === 'client_restart_unverified') {
    return { needed: true, tone: 'warn', label: '无法确认是否已重启', detail: '未取得客户端进程启动时间（探测不可用，不猜成功）。请完全退出并重新打开 Codex Desktop 后核对。' }
  }
  if (r.reason === 'applied_at_unknown') {
    return { needed: true, tone: 'warn', label: '需要重启 Codex 生效', detail: '接入状态缺少写入时间；请完全退出并重新打开 Codex Desktop。' }
  }
  return {
    needed: r.needed !== false,
    tone: r.needed === false ? 'good' : 'warn',
    label: r.needed === false ? '配置已生效' : '需要重启 Codex 生效',
    detail: r.needed === false ? '服务端判定新配置已生效。' : '请完全退出并重新打开 Codex Desktop。',
  }
}

export function nativeCompactionNotice (nativeCompaction) {
  const n = nativeCompaction && typeof nativeCompaction === 'object' ? nativeCompaction : null
  if (!n) return { tone: 'muted', label: '未知', detail: '服务端未返回原生压缩声明状态。' }
  if (n.mode === 'managed-provider') {
    if (n.declared) {
      return {
        tone: 'info',
        label: 'provider 级声明：remote_compaction = ' + (n.remoteCompaction || '?'),
        detail: '字段 ' + (n.field || 'model_providers.<id>.capabilities.remote_compaction') + '，让 Codex 对 DeepSeek 走它自己的本地自动压缩。配置解析已离线校验；运行时认证复用仍为 ' + (n.runtimeAuth || 'UNVERIFIED') + '。',
      }
    }
    return { tone: 'warn', label: 'provider 段存在但未声明能力', detail: '未发现 remote_compaction 声明；当前不会强制本地压缩路径。' }
  }
  return {
    tone: 'muted',
    label: '内置 openai 身份不可声明 capability',
    detail: (n.detail || 'Codex 拒绝 [model_providers.openai*] 覆盖。') + ' 这不是配置损坏：provider 级压缩能力只能在 ModelGate 自有 provider 段声明。',
  }
}

// —— 数据加载 ——
function looksMissingRoute (err) {
  return !!err && (err.status === 404 || (err.data && err.data.code === 'not_mounted'))
}

async function loadAggregation (ctx = {}) {
  if (AGG.loading) return
  AGG.loading = true
  const [health, modes, providers, models, diagnostics] = await Promise.allSettled([
    request(AGGREGATION_ENDPOINTS.health),
    request(AGGREGATION_ENDPOINTS.modes),
    request(AGGREGATION_ENDPOINTS.providers),
    request(AGGREGATION_ENDPOINTS.models),
    request(AGGREGATION_ENDPOINTS.diagnostics),
  ])
  const results = { health, modes, providers, models, diagnostics }
  const core = ['health', 'providers', 'models', 'diagnostics']
  const missing = []
  for (const key of Object.keys(results)) {
    const r = results[key]
    if (r.status === 'rejected' && looksMissingRoute(r.reason)) missing.push(AGGREGATION_ENDPOINTS[key])
  }
  AGG.missingRoutes = missing
  AGG.routeMissing = core.some((key) => missing.includes(AGGREGATION_ENDPOINTS[key]))
  AGG.modesUnavailable = missing.includes(AGGREGATION_ENDPOINTS.modes)
  AGG.health = health.status === 'fulfilled' ? health.value : null
  AGG.modes = modes.status === 'fulfilled' ? modes.value : null
  AGG.providers = providers.status === 'fulfilled' ? providers.value : null
  AGG.models = models.status === 'fulfilled' ? models.value : null
  AGG.diagnostics = diagnostics.status === 'fulfilled' ? diagnostics.value : null
  AGG.healthError = health.status === 'rejected' ? health.reason : null
  AGG.modesError = modes.status === 'rejected' ? modes.reason : null
  AGG.providersError = providers.status === 'rejected' ? providers.reason : null
  AGG.modelsError = models.status === 'rejected' ? models.reason : null
  AGG.diagnosticsError = diagnostics.status === 'rejected' ? diagnostics.reason : null
  AGG.fetched = true
  AGG.loadedAt = Date.now()
  AGG.loading = false
  if (typeof ctx.rerender === 'function') ctx.rerender()
}

function reload (ctx) {
  AGG.fetched = false
  return loadAggregation(ctx)
}

// —— 卡片 ——
function routeNotice (ctx) {
  const missing = Array.isArray(AGG.missingRoutes) ? AGG.missingRoutes.slice() : []
  const list = missing.length ? missing.join('、') : '（具体端点见下方错误）'
  const onlyModes = missing.length > 0 && missing.every((p) => p === AGGREGATION_ENDPOINTS.modes)
  return callout('warn',
    h('strong', { text: onlyModes ? '三模式切换接口不可用（404）。' : '部分聚合接口返回 404。' }),
    ' 实际失败的端点：' + list + '。' +
    (onlyModes
      ? ' 其它只读接口正常，本页继续展示真实状态；仅「切换接入方式 / 回到上一模式」按钮被禁用，升级到提供 /api/aggregation/modes|switch|rollback 的版本后重新探测即可。'
      : ' 只禁用受影响的展示，不伪造数据；请确认 ModelGate 已升级到提供 /api/aggregation/* 的版本后重新探测。'),
    h('div', { class: 'toolbar', style: { marginTop: '8px' } },
      h('button', { class: 'btn btn-sm', type: 'button', text: '重新探测', onclick: () => reload(ctx) })))
}

function currentModeOf (health) {
  const detect = (health && (health.detect || health.desktop)) || {}
  const raw = (health && health.mode) || (detect.config && detect.config.mode)
  return THREE_MODES.some((m) => m.id === raw) ? raw : 'unknown'
}

// 三模式单选 + 父模型选择器（对外措辞：接入方式）。
// 父选择器仅在选中「聚合」时显示；路由模式固定 DeepSeek 父，不显示父选择。
// 返回 getSelection()，供本视图与 connections.js 向导共用同一套判定。
export function modeChooser (opts = {}) {
  const current = THREE_MODES.some((m) => m.id === opts.current) ? opts.current : 'official'
  const parents = Array.isArray(opts.parents) ? opts.parents : []
  let selected = THREE_MODES.some((m) => m.id === opts.selected) ? opts.selected : current
  let parent = opts.parent || DEFAULT_PARENT_MODEL

  const parentSelect = h('select', null,
    ...(parents.length
      ? parents.map((p) => h('option', { value: p.id, text: p.label, selected: p.id === parent }))
      : [h('option', { value: DEFAULT_PARENT_MODEL, text: DEFAULT_PARENT_MODEL + '（已签收/PASS_REAL）' })]))
  parentSelect.addEventListener('change', () => { parent = parentSelect.value })
  const parentField = field('GPT 父模型（仅聚合模式）', parentSelect, {
    help: '只有 ' + PASS_REAL_PARENT_MODEL + ' 已签收/PASS_REAL；其它订阅内模型均为未验证（UNVERIFIED）。路由模式固定 DeepSeek 父，不显示此项。',
  })

  const radios = THREE_MODES.map((m) => {
    const input = h('input', {
      type: 'radio', name: 'mg-agg-mode', value: m.id, checked: m.id === selected,
      onchange: () => {
        selected = m.id
        parentField.hidden = m.id !== 'aggregated'
        if (typeof opts.onChange === 'function') opts.onChange(selected)
      },
    })
    return h('label', { class: 'mode-choice', style: { display: 'flex', gap: '8px', alignItems: 'flex-start', margin: '4px 0' } },
      input,
      h('span', null,
        h('strong', { text: m.label }),
        h('span', { class: 'hint', text: ' — ' + m.description })))
  })
  parentField.hidden = selected !== 'aggregated'

  const node = h('div', { class: 'mode-chooser' }, h('div', null, radios), parentField)
  return {
    node,
    getSelection: () => ({ mode: selected, parentModel: selected === 'aggregated' ? parent : null }),
  }
}

function overviewCard (ctx) {
  const health = AGG.health || {}
  const detect = health.detect || health.desktop || {}
  const activation = health.activation || {}
  const mode = currentModeOf(health)
  const previous = health.previousMode || null
  const drifted = health.drifted === true
  const m = modeLabel(mode, drifted)
  const restart = health.restart || activation.restart || null
  const rn = restartNotice(restart, mode)
  const backup = health.backup || activation.backup || { available: false }
  // 只有三模式端点（modes/switch/rollback）缺失或配置漂移时才禁用切换；其它只读接口正常时不误伤。
  // 漂移时服务端 /switch 必回 409，因此先禁用按钮，引导用户用「重新对齐配置」解漂。
  const canToggle = !AGG.modesUnavailable && !drifted
  const parents = selectableParentModels(AGG.modes)
  const switchBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '切换接入方式' })
  switchBtn.disabled = !canToggle
  const chooser = modeChooser({
    current: mode, parents, selected: AGG.selectedMode, parent: AGG.selectedParent,
    onChange: (sel) => { switchBtn.disabled = !canToggle || sel === mode },
  })
  switchBtn.disabled = !canToggle || chooser.getSelection().mode === mode
  switchBtn.addEventListener('click', () => {
    const sel = chooser.getSelection()
    AGG.selectedMode = sel.mode
    AGG.selectedParent = sel.parentModel || DEFAULT_PARENT_MODEL
    beginSwitch(ctx, sel.mode, sel.parentModel)
  })
  const canRollback = canToggle && (mode === 'aggregated' || mode === 'route')
  const rollbackBtn = h('button', { class: 'btn', type: 'button', text: '回到上一模式', disabled: !canRollback, onclick: () => beginRollback(ctx) })
  if (previous) rollbackBtn.title = '上一模式：' + modeLabel(previous).label

  const body = h('div', null,
    callout('info',
      h('strong', { text: '接入方式（三选一）：' }),
      ' 官方直连不经 ModelGate；路由模式纯 DeepSeek、零 GPT 调用；聚合模式用 GPT 父 + DeepSeek 子。切换前展示差异并要你确认一次，写入后自动验证。不编辑 TOML、不碰 auth.json。'),
    h('div', { class: 'toolbar', style: { margin: '4px 0 10px' } },
      tag(m.label, m.kind),
      tag(AGG.health ? '网关 ' + (health.gateway && health.gateway.status ? 'HTTP ' + health.gateway.status : (health.gateway && health.gateway.ok ? '健康' : '未返回')) : '健康接口未返回', health.gateway && (health.gateway.ok !== false) ? 'good' : 'warn'),
      tag(rn.label, rn.tone)),
    chooser.node,
    h('div', { class: 'toolbar', style: { margin: '10px 0' } }, switchBtn, rollbackBtn),
    drifted
      ? callout('warn', h('strong', { text: '配置漂移中，切换已暂时禁用：' }), ' 请先用页面上方的「重新对齐配置」解漂（只更新 state，不改 config.toml 内容）；解漂成功后本按钮自动恢复可用。')
      : null,
    h('p', { class: 'hint', text: '接入前备份：' + (backup.available ? ('可用 · ' + (backup.matches ? '与接入前快照一致' : '快照不一致（不可回滚）')) : '无（尚未接入，或接入前文件不存在）') }),
    rn.needed
      ? callout('warn', h('strong', { text: rn.label + '：' }), ' ' + rn.detail)
      : callout('good', h('strong', { text: rn.label + '：' }), ' ' + rn.detail),
    callout('warn', h('strong', { text: '切换后请完全退出并重新打开 Codex 才能使用新模式。' }), ' 运行中的 Codex 仍读取旧配置；本页不会声称"立即生效"。'),
    h('div', { class: 'toolbar', style: { marginTop: '10px' } },
      h('button', { class: 'btn', type: 'button', text: '模型与账号', onclick: () => { location.hash = '#/connections' } }),
      h('button', { class: 'btn btn-sm', type: 'button', text: '重新检测', onclick: () => { AGG.fetched = false; loadAggregation(ctx) } })))

  return card('接入方式', '选择官方直连 / 路由 / 聚合；切换时只回滚 ModelGate 改过的字节。',
    body,
    { foot: '契约 mg-codex-desktop/1 · 写入 = config.js 事务（sha256 + 备份 + 原子写 + 写后校验）· 浏览器不接触本地文件' })
}

// 技术长表（SHA / 备份 / 版本 / 原生压缩 / 上次结果）只在「高级详情」展开区渲染。
function technicalDetails () {
  const health = AGG.health || {}
  const detect = health.detect || health.desktop || {}
  const activation = health.activation || {}
  const compaction = health.nativeCompaction || detect.nativeCompaction || activation.nativeCompaction || null
  const cn = nativeCompactionNotice(compaction)
  const backup = health.backup || activation.backup || { available: false }
  return card('接入技术详情', 'SHA、备份、版本探测与原生压缩字段只在高级详情里展示。',
    kvList([
      ['配置路径', h('span', { class: 'mono-break', text: detect.configPath || health.configPath || '未返回' })],
      ['Codex CLI', h('div', { class: 'flex flex-wrap' }, versionCell(detect.cli), h('span', { class: 'hint', text: detect.cli && detect.cli.path ? detect.cli.path : '未检测到 codex 可执行文件' }))],
      ['Codex Desktop', h('div', { class: 'flex flex-wrap' }, versionCell(detect.desktop), h('span', { class: 'hint', text: detect.desktop && detect.desktop.path ? detect.desktop.path + (detect.desktop.versionKind === 'package-metadata' ? ' · 包元数据' : '') : '未检测到 Desktop 可执行文件' }))],
      ['Desktop 捆绑 Codex', h('div', { class: 'flex flex-wrap' }, versionCell(detect.bundledCli || (detect.desktop && detect.desktop.bundledCodex)), h('span', { class: 'hint', text: (detect.bundledCli && detect.bundledCli.path) || (detect.desktop && detect.desktop.bundledCodex && detect.desktop.bundledCodex.path) || '未检测到（PATH 里的 CLI 不等于 Desktop 引擎）' }))],
      ['原生压缩（Codex 自有）', h('div', { class: 'flex flex-wrap' }, tag(cn.label, cn.tone), h('span', { class: 'hint', text: cn.detail }))],
      ['配置状态', h('span', { text: (detect.config && detect.config.reason) || health.reason || '未知' })],
      ['接入前备份', backup.available ? h('span', { class: 'mono-break', text: (backup.path || '') + ' · ' + (backup.matches ? '与接入前快照一致' : '快照不一致（不可回滚）') }) : h('span', { class: 'muted', text: '无（尚未接入，或接入前文件不存在）' })],
      ['最近一次结果', activation.lastApply ? h('span', { text: (activation.lastApply.ok ? '成功' : '失败 · ' + (activation.lastApply.code || '未知')) + (activation.lastApply.at ? ' · ' + fmtTime(activation.lastApply.at) : '') }) : h('span', { class: 'muted', text: '尚无记录' })],
    ]),
    { foot: '来源 GET /api/aggregation/health · 原始投影与诊断长表仅在展开后出现' })
}

function providerRowActions (provider, ctx) {
  const id = provider && (provider.id || provider.providerId)
  return h('div', { class: 'flex flex-wrap' },
    h('button', { class: 'btn btn-sm', type: 'button', text: '同步', onclick: () => syncProvider(id, ctx) }),
    h('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '移除', onclick: () => removeProvider(id, ctx) }))
}

function providersCard (ctx) {
  const payload = AGG.providers || {}
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.providers) ? payload.providers : [])
  const rows = list.map((p) => ({
    id: p.id || p.providerId || '—',
    kind: p.kind || p.type || '—',
    base: safeHost(p.baseUrl || ''),
    models: Number.isFinite(Number(p.modelCount)) ? fmtInt(p.modelCount) : (p.modelCount == null ? '未知' : String(p.modelCount)),
    authorized: Number.isFinite(Number(p.authorizedCount)) ? fmtInt(p.authorizedCount) : '未知',
    state: p.discoveryState || p.state || 'unknown',
    actions: providerRowActions(p, ctx),
  }))
  const add = h('button', { class: 'btn btn-primary', type: 'button', text: '手工注册供应商（高级）', onclick: () => openProviderDialog(ctx) })
  const body = rows.length
    ? h('div', null,
      table([
        { label: '供应商', render: (r) => h('span', { class: 'mono', text: r.id }) },
        { label: '类型', render: (r) => tag(r.kind, 'muted') },
        { label: '主机', render: (r) => h('span', { class: 'mono-break', text: r.base || '—' }) },
        { label: '模型', render: (r) => h('span', { text: r.models }) },
        { label: '已授权', render: (r) => h('span', { text: r.authorized }) },
        { label: '发现状态', render: (r) => tag(r.state === 'complete' ? '完整' : r.state === 'failed' ? '失败' : r.state, r.state === 'complete' ? 'good' : r.state === 'failed' ? 'bad' : 'warn') },
        { label: '操作', render: (r) => r.actions },
      ], rows),
      h('div', { class: 'toolbar', style: { marginTop: '10px' } }, add))
    : h('div', null,
      empty('还没有注册聚合供应商', '在「模型与账号」只填一个 OpenCode Go API Key 即可自动注册并同步目标模型 ' + GO_TARGET_LABEL + '；这里是高级手工入口。',
        h('button', { class: 'btn btn-primary', type: 'button', text: '去连接 OpenCode Go', onclick: () => { location.hash = '#/connections' } }),
        h('button', { class: 'btn', type: 'button', text: '手工注册供应商（高级）', onclick: () => openProviderDialog(ctx) })))
  return card('聚合供应商', '每个供应商独立授权域；同步只读取目录，不发起推理。目标模型固定为 ' + GO_TARGET_LABEL + '。',
    AGG.providersError ? callout('danger', h('strong', { text: '供应商列表读取失败：' }), AGG.providersError.message || '未知错误') : body,
    { foot: '来源 GET /api/aggregation/providers · ' + (AGG.loadedAt ? '读取于 ' + fmtTime(AGG.loadedAt) : '尚未读取') })
}

function modelRows () {
  const payload = AGG.models || {}
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.models) ? payload.models : [])
  return list.map((m) => ({
    publicId: m.publicId || m.id || m.name || '—',
    providerId: m.providerId || '—',
    upstreamId: m.upstreamId || '—',
    displayName: m.displayName || m.display_name || '',
    authorized: m.authorized === true,
    evidence: m.evidence && m.evidence.source ? (m.evidence.source + (m.evidence.observedAt ? ' · ' + m.evidence.observedAt : '')) : '无证据',
    context: Number.isFinite(Number(m.contextWindow)) ? fmtInt(m.contextWindow) : '未知',
  }))
}

function modelsCard () {
  const summary = summarizeDiscovery(AGG.diagnostics, AGG.models)
  const rows = modelRows()
  const body = h('div', null,
    callout(summary.kind === 'bad' ? 'danger' : summary.kind === 'warn' ? 'warn' : 'info',
      h('strong', { text: summary.label + '：' }), ' ' + summary.detail),
    h('div', { class: 'toolbar', style: { margin: '2px 0 10px' } },
      tag(summary.countText || '数量未知（不按 0 显示）', summary.kind),
      tag('状态 ' + summary.state, 'muted')),
    AGG.modelsError
      ? callout('danger', h('strong', { text: '模型目录读取失败：' }), AGG.modelsError.message || '未知错误', h('p', { class: 'hint', text: '失败不等于“0 个模型”；请根据诊断重试。' }))
      : (rows.length
          ? table([
            { label: '公共 ID', render: (r) => h('span', { class: 'mono-break', text: r.publicId }) },
            { label: '供应商', render: (r) => h('span', { class: 'mono', text: r.providerId }) },
            { label: '上游 ID', render: (r) => h('span', { class: 'mono-break muted', text: r.upstreamId }) },
            { label: '授权', render: (r) => tag(r.authorized ? '可用' : '无权使用（不发布）', r.authorized ? 'good' : 'bad') },
            { label: '上下文', render: (r) => h('span', { text: r.context }) },
            { label: '证据', render: (r) => h('span', { class: 'hint', text: r.evidence }) },
          ], rows)
          : (summary.state === 'complete' || summary.state === 'empty_confirmed'
              ? empty('没有可调用模型', summary.state === 'empty_confirmed' ? '上游明确返回空授权目录。' : '发现已完成，但目录为空。')
              : empty('模型清单不可用', '发现尚未完成或未知；这里不显示“0 个模型”。')))
  )
  return card('模型授权与目录', '只发布账号有权使用且带证据的模型；未授权条目仅用于诊断。',
    body,
    { foot: '来源 GET /api/aggregation/models + /diagnostics · 数量口径以发现状态为准，部分发现不显示为全量' })
}

function diagnosticsCard () {
  const payload = AGG.diagnostics || {}
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.diagnostics) ? payload.diagnostics : [])
  const rows = list.map((d, i) => ({
    level: d.level || d.severity || 'info',
    code: d.code || '—',
    message: d.message || d.detail || '',
    at: d.at ? fmtTime(d.at) : '—',
    key: i,
  }))
  return card('诊断', '只显示稳定诊断码与主机/路径；不含 token、cookie 或 auth.json 内容。',
    AGG.diagnosticsError
      ? callout('danger', h('strong', { text: '诊断读取失败：' }), AGG.diagnosticsError.message || '未知错误')
      : (rows.length
          ? table([
            { label: '级别', render: (r) => tag(r.level, r.level === 'error' ? 'bad' : r.level === 'warn' ? 'warn' : 'muted') },
            { label: '代码', render: (r) => h('span', { class: 'mono', text: r.code }) },
            { label: '说明', render: (r) => h('span', { class: 'muted', text: r.message }) },
            { label: '时间', render: (r) => h('span', { class: 'muted', text: r.at }) },
          ], rows)
          : empty('暂无诊断', '当前没有诊断记录；这不代表已经验证过真实 Desktop。')),
    { foot: '来源 GET /api/aggregation/diagnostics' })
}

// —— 交互 ——
// 高级手工入口：默认 Go preset（普通用户请走「模型与账号」的单 Key 向导）。
function openProviderDialog (ctx) {
  const kindSelect = h('select', null,
    h('option', { value: 'opencode-go', text: 'OpenCode Go（默认，' + GO_TARGET_LABEL + '）' }),
    h('option', { value: 'opencode-console', text: 'OpenCode Console（历史授权域）' }))
  const idInput = h('input', { type: 'text', autocomplete: 'off', placeholder: '留空由 preset 生成' })
  const baseInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://…（供应商端点，不含 Key）' })
  const envInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '例如 OPENCODE_API_KEY（只填变量名）' })
  const err = h('p', { class: 'field-error', role: 'alert' })
  const save = h('button', { class: 'btn btn-primary', type: 'button', text: '注册并同步' })
  const idField = field('供应商 ID', idInput, { help: 'Go preset 会生成固定段；自定义 ID 必须与类型匹配。' })
  const baseField = field('端点', baseInput, { help: '必须是 http(s) 且属于 OpenCode 白名单；不要把 Key 写进 URL。' })
  const envField = field('apiKeyEnv', envInput, { help: '环境变量名，不是 Key 值。' })
  const syncFields = () => {
    const isGo = kindSelect.value === 'opencode-go'
    idField.hidden = isGo
    baseField.hidden = isGo
  }
  kindSelect.addEventListener('change', syncFields)
  syncFields()
  const content = h('div', null,
    callout('info', h('strong', { text: '这是高级手工入口：' }), ' 普通接入请到「模型与账号」只填一个 OpenCode Go API Key。这里只登记供应商与凭据变量名，不会代你登录，也不会回显 Key。'),
    callout('warn', h('strong', { text: '默认 Go 位形：' }), ' 选择 OpenCode Go 时使用已登记 preset（端点 / 名称 / 单模型作用域由服务端补全），不需要手填 URL。目标模型固定为 ' + GO_TARGET_LABEL + '。'),
    field('类型', kindSelect, { help: 'Go 与 Console 使用不同的授权域，不能互相替代。' }),
    idField,
    baseField,
    envField,
    err)
  const d = dialog({ title: '手工注册聚合供应商（高级）', desc: '保存会推进 configVersion；冲突返回 409，不会覆盖其它窗口的修改。', content, actions: [
    h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => d.close() }), save,
  ] })
  save.addEventListener('click', async () => {
    err.textContent = ''
    const isGo = kindSelect.value === 'opencode-go'
    const body = { configVersion: Number(state.config && state.config.configVersion) || 0 }
    if (isGo) {
      body.preset = GO_PROVIDER_PRESET
      if (idInput.value.trim()) body.id = idInput.value.trim()
      if (baseInput.value.trim()) body.baseUrl = baseInput.value.trim()
    } else {
      const id = idInput.value.trim()
      const baseUrl = baseInput.value.trim()
      const problems = []
      if (!id) problems.push('供应商 ID 不能为空')
      if (!/^https?:\/\//i.test(baseUrl)) problems.push('端点必须以 http:// 或 https:// 开头')
      if (problems.length) { err.textContent = problems.join('；'); return }
      body.id = id
      body.kind = 'opencode-console'
      body.baseUrl = baseUrl
    }
    if (envInput.value.trim()) body.apiKeyEnv = envInput.value.trim()
    save.disabled = true
    save.textContent = '注册中…'
    try {
      await request(AGGREGATION_ENDPOINTS.providers, { method: 'POST', body })
      d.close()
      toast('供应商已注册；可以同步模型目录了', 'success')
      await reload(ctx)
    } catch (e) {
      save.disabled = false
      save.textContent = '注册并同步'
      if (e && e.status === 409) err.textContent = '配置版本冲突或供应商已存在（服务端版本 ' + (e.currentVersion == null ? '未知' : e.currentVersion) + '）：请刷新后重试，本页不会覆盖。'
      else if (e && e.status === 428) err.textContent = '注册供应商需要一次显式确认；请刷新后重试。'
      else err.textContent = '注册失败：' + (e && e.message ? e.message : '未知错误')
    }
  })
}

async function syncProvider (id, ctx) {
  if (!id || id === '—') return
  const ok = await confirmDialog({
    title: '同步供应商 · ' + id,
    message: '将向该供应商读取授权模型目录（GET /v1/models），不发推理请求。若上游受限或分页未完成，界面会明确标注“发现未完成”。',
    confirmLabel: '开始同步',
  })
  if (!ok) return
  try {
    const res = await request(AGGREGATION_ENDPOINTS.sync(id), { method: 'POST', body: {}, timeoutMs: 60000 })
    const changed = res && res.changed ? res.changed : null
    toast(changed ? '同步完成：新增 ' + (changed.added || 0) + ' / 移除 ' + (changed.removed || 0) + ' / 更新 ' + (changed.updated || 0) : '同步完成', 'success')
    await reload(ctx)
  } catch (e) {
    toast('同步失败：' + (e && e.message ? e.message : '未知错误') + '（失败不等于 0 个模型）', 'error')
    await loadAggregation(ctx)
  }
}

async function removeProvider (id, ctx) {
  if (!id || id === '—') return
  const ok = await confirmDialog({
    title: '移除供应商 · ' + id,
    message: '只从聚合注册表移除该供应商；不会删除你已有的 Codex 登录，也不会改动其它供应商。若正在聚合模式中使用它，请先退出聚合或换模型。',
    confirmLabel: '移除',
    danger: true,
  })
  if (!ok) return
  try {
    await request(AGGREGATION_ENDPOINTS.provider(id), { method: 'DELETE' })
    toast('已移除供应商', 'success')
    await reload(ctx)
  } catch (e) {
    toast('移除失败：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

function showRestartPrompt (extra, targetMode) {
  const heading = '请完全退出并重新打开 Codex 才能使用新模式'
  const d = dialog({
    title: '接入方式已切换，需要重启 Codex',
    desc: heading + '；运行中的 Codex 仍读取旧配置，本页不会声称"立即生效"。',
    content: h('div', null,
      callout('warn', h('strong', { text: heading + '。' }), ' 这是切换生效的必要条件，不是可选项。'),
      extra ? callout('good', h('strong', { text: '验证结果：' }), extra) : null,
      targetMode ? h('p', { class: 'hint', text: '新模式：' + modeLabel(targetMode).label + '。' }) : null,
      h('ol', { style: { margin: '6px 0 0 18px', padding: 0 } },
        h('li', { text: '完全退出 Codex Desktop（不是只关窗口）。' }),
        h('li', { text: '重新打开 Codex Desktop，进入一个新会话。' }),
        h('li', { text: '在模型选择器里核对新模式对应的模型（官方 / 路由 DeepSeek / 聚合 GPT 父 + DeepSeek 子）。' }),
        h('li', { text: '各发一条最小消息，回到「监控与诊断」核对请求落到正确供应商。' })),
      h('p', { class: 'hint', text: '重启完成后本页会自动比对客户端启动时间并撤掉重启提示；如果一直提示，说明检测到的仍是旧进程。' })),
    actions: [h('button', { class: 'btn btn-primary', type: 'button', text: '我知道了', onclick: () => d.close() })],
  })
}

// 切换/回滚成功后的统一回执：刷新快照并弹出重启提示（含"退出后也要重启"措辞）。
function afterModeChange (ctx, res, targetMode) {
  toast('接入方式已切换并通过验证', 'success')
  const reloadPromise = reload(ctx)
  showRestartPrompt(res && res.verification
    ? ('配置 ' + shaShort(res.sha) + ' · 网关 ' + (res.verification.gateway ? res.verification.gateway.status : '已校验'))
    : null, targetMode)
  return reloadPromise
}

// 预览表必须能显示删除行（如切到路由时删除 openai_base_url）。
function diffRowKind (kind) {
  if (kind === 'remove' || kind === 'delete' || kind === 'del') return { text: '删除', tone: 'bad' }
  if (kind === 'add') return { text: '新增', tone: 'info' }
  if (kind === 'replace') return { text: '覆盖', tone: 'warn' }
  return { text: '不变', tone: 'muted' }
}

function diffRowsTable (rows) {
  return table([
    { label: '字段', render: (r) => h('span', { class: 'mono', text: r.path }) },
    { label: '变更', render: (r) => { const k = diffRowKind(r.kind); return tag(k.text, k.tone) } },
    { label: '当前值', render: (r) => h('span', { class: 'mono-break muted', text: r.from == null ? '—（文件中没有）' : r.from }) },
    { label: '写入后', render: (r) => h('span', { class: 'mono-break', text: r.to == null ? '—（删除该字段）' : r.to }) },
  ], rows)
}

function showConsent (preview, ctx, meta) {
  const m = meta || {}
  const isSwitch = m.kind === 'switch'
  const isRollback = m.kind === 'rollback'
  const rows = (preview && Array.isArray(preview.rows)) ? preview.rows : []
  const conflicts = (preview && Array.isArray(preview.conflicts)) ? preview.conflicts : []
  const preserved = preview && preview.preserved ? preview.preserved : {}
  const changeCount = rows.filter((r) => r.kind !== 'same').length
  const removeCount = rows.filter((r) => r.kind === 'remove' || r.kind === 'delete' || r.kind === 'del').length
  const confirm = h('button', { class: 'btn btn-primary', type: 'button', text: '确认并写入 ' + changeCount + ' 项' })
  const title = isRollback ? '确认回到上一模式' : isSwitch ? '确认切换接入方式' : '确认进入聚合模式'
  const body = h('div', null,
    isSwitch && m.mode ? h('p', { class: 'hint', text: '目标接入方式：' + modeLabel(m.mode).label + (m.parentModel ? ' · 父模型 ' + m.parentModel : '') }) : null,
    isRollback ? callout('warn', h('strong', { text: '回到上一模式：' }), ' 将撤销 ModelGate 最近一次写入的字节；若期间配置被改，会返回 409 + 三方差异，不会覆盖。') : null,
    callout('info', h('strong', { text: '只写 ModelGate 拥有的字段：' }), ' 其它行（MCP / projects / 权限 / 注释 / 你自己的 [model_providers.*]）逐字节保留。写入前会再次校验 sha256；期间若文件被改，会中止而不是覆盖。'),
    preview && preview.firstRun ? callout('warn', h('strong', { text: '首次设置：' }), ' 将在 Codex 用户级配置中新增下面这些字段。') : null,
    conflicts.length ? callout('warn', h('strong', { text: '将覆盖 ' + conflicts.length + ' 个已有值：' }), conflicts.map((c) => c.path).join('、')) : null,
    removeCount ? callout('warn', h('strong', { text: '将删除 ' + removeCount + ' 个字段：' }), ' 例如切换到路由模式时删除 openai_base_url；删除行已在下方差异表标为「删除」。') : null,
    diffRowsTable(rows),
    h('p', { class: 'hint', text: '只读保留：顶层 ' + ((preserved.topLevelKeys || []).join('、') || '无') + ' · 段 ' + ((preserved.sections || []).join('、') || '无') + (preserved.mcpServers && preserved.mcpServers.length ? ' · MCP ' + preserved.mcpServers.join('、') : '') }),
    (preview && preview.warnings && preview.warnings.length) ? callout('warn', h('strong', { text: '注意：' }), preview.warnings.join(' ')) : null,
    preview && preview.catalog ? h('p', { class: 'hint', text: '目录：' + (preview.catalog.ok ? preview.catalog.modelCount + ' 个模型（含目标模型）' : '当前不可用（' + preview.catalog.state + '）：' + (preview.catalog.reason || '')) }) : null,
    h('p', { class: 'hint', text: '写入后会自动验证：配置解析 + 目录含目标模型 + 网关 /healthz；任何一项失败会自动回滚到写入前字节。' }))
  const d = dialog({ title, desc: '这是一次性确认；切换后请完全退出并重新打开 Codex 才能使用新模式。', wide: true, content: body, actions: [
    h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => d.close() }), confirm,
  ] })
  confirm.addEventListener('click', async () => {
    confirm.disabled = true
    confirm.textContent = '写入并验证中…'
    try {
      let endpoint = AGGREGATION_ENDPOINTS.activate
      let requestBody = buildActivateRequest(preview, true)
      if (isSwitch) {
        endpoint = AGGREGATION_ENDPOINTS.switch
        requestBody = buildSwitchRequest(preview, true, m.mode, m.parentModel)
      } else if (isRollback) {
        endpoint = AGGREGATION_ENDPOINTS.rollback
        requestBody = buildRollbackRequest(preview, true)
      }
      const res = await request(endpoint, { method: 'POST', body: requestBody, timeoutMs: 60000 })
      d.close()
      if (isSwitch || isRollback) {
        await afterModeChange(ctx, res, isRollback ? null : m.mode)
        return
      }
      toast('聚合模式已启用并通过验证', 'success')
      await reload(ctx)
      showRestartPrompt(res && res.verification ? ('配置 ' + shaShort(res.sha) + ' · 目录 ' + (res.verification.catalog ? res.verification.catalog.modelCount + ' 个模型' : '已校验') + ' · 网关 ' + (res.verification.gateway ? res.verification.gateway.status : '已校验')) : null)
    } catch (e) {
      d.close()
      if (e && e.status === 409) {
        toast('预览后配置已被修改，已中止；请重新预览', 'error')
        await loadAggregation(ctx)
        return
      }
      if (e && e.status === 422) {
        toast('切换被前置条件阻止（422），未写入', 'error')
        await loadAggregation(ctx)
        return
      }
      toast((isSwitch || isRollback ? '切换失败：' : '接入失败：') + (e && e.message ? e.message : '未知错误'), 'error')
      await loadAggregation(ctx)
    }
  })
}

async function beginActivate (ctx) {
  try {
    const res = await request(AGGREGATION_ENDPOINTS.activate, { method: 'POST', body: {} })
    // 后端也可能直接返回 {ok:false,code:'consent_required',preview}（200 或 428）。
    if (res && res.code === 'consent_required' && res.preview) { showConsent(res.preview, ctx); return }
    if (res && res.ok) { await reload(ctx); showRestartPrompt(null); return }
    toast('服务端未返回可用的预览', 'error')
  } catch (e) {
    const data = e && e.data ? e.data : null
    if ((e && e.status === 428) || (data && data.code === 'consent_required')) {
      if (data && data.preview) { showConsent(data.preview, ctx); return }
      toast('需要确认，但服务端未返回预览内容', 'error')
      return
    }
    if (e && e.status === 409) { toast('另一个操作正在进行或配置已被修改，请稍后重试', 'error'); await loadAggregation(ctx); return }
    if (e && e.status === 404) { AGG.routeMissing = true; AGG.missingRoutes = [AGGREGATION_ENDPOINTS.activate]; ctx.rerender && ctx.rerender(); return }
    toast('无法开始接入：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

// 三模式切换：无 token → 428 + preview → 确认后带 consentToken + expectedSha 提交。
async function beginSwitch (ctx, mode, parentModel) {
  const target = THREE_MODES.some((m) => m.id === mode) ? mode : 'official'
  try {
    const res = await request(AGGREGATION_ENDPOINTS.switch, { method: 'POST', body: buildSwitchRequest(null, false, target, parentModel) })
    if (res && res.preview) { showConsent(res.preview, ctx, { kind: 'switch', mode: target, parentModel }); return }
    if (res && res.ok !== false && res && res.mode) { await afterModeChange(ctx, res, res.mode || target); return }
    toast('服务端未返回可用的预览', 'error')
  } catch (e) {
    const data = e && e.data ? e.data : null
    if ((e && e.status === 428) || (data && (data.code === 'consent_required' || data.preview))) {
      if (data && data.preview) { showConsent(data.preview, ctx, { kind: 'switch', mode: target, parentModel }); return }
      toast('需要确认，但服务端未返回预览内容', 'error'); return
    }
    if (e && e.status === 409) { toast('配置已被修改或另一操作在进行，未写入；请重新检测', 'error'); await loadAggregation(ctx); return }
    if (e && e.status === 422) { toast('切换被前置条件阻止（422），未写入', 'error'); await loadAggregation(ctx); return }
    if (e && e.status === 404) { AGG.modesUnavailable = true; AGG.missingRoutes = [AGGREGATION_ENDPOINTS.switch]; ctx.rerender && ctx.rerender(); return }
    toast('无法切换：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

// 回到上一模式（rollback 到 previousMode）：同样的 428 预览 → 确认流程。
async function beginRollback (ctx) {
  try {
    const res = await request(AGGREGATION_ENDPOINTS.rollback, { method: 'POST', body: buildRollbackRequest(null, false) })
    if (res && res.preview) { showConsent(res.preview, ctx, { kind: 'rollback' }); return }
    if (res && res.ok !== false && res && res.mode) { await afterModeChange(ctx, res, res.mode); return }
    toast('服务端未返回可用的预览', 'error')
  } catch (e) {
    const data = e && e.data ? e.data : null
    if ((e && e.status === 428) || (data && (data.code === 'consent_required' || data.preview))) {
      if (data && data.preview) { showConsent(data.preview, ctx, { kind: 'rollback' }); return }
      toast('需要确认，但服务端未返回预览内容', 'error'); return
    }
    if (e && e.status === 409) { toast('配置已被修改，未回滚；请重新检测', 'error'); await loadAggregation(ctx); return }
    if (e && e.status === 422) { toast('回滚被前置条件阻止（422），未写入', 'error'); await loadAggregation(ctx); return }
    if (e && e.status === 404) { AGG.modesUnavailable = true; AGG.missingRoutes = [AGGREGATION_ENDPOINTS.rollback]; ctx.rerender && ctx.rerender(); return }
    toast('无法回滚：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

// —— 漂移解漂：428 preview → 一次性确认 → 带 consentToken/expectedSha 提交 ——
// 只更新本机 state 基线；config.toml 字节前后不变，不改 model/provider、不切模式。
function showReconcileConsent (preview, ctx) {
  const p = preview || {}
  const rows = Array.isArray(p.rows) ? p.rows : []
  const confirm = h('button', { class: 'btn btn-primary', type: 'button', text: '确认重新对齐（只写 state）' })
  const body = h('div', null,
    callout('warn', h('strong', { text: '只更新本机对齐基线：' }),
      ' 采纳当前 config.toml 的字节作为新基线（state.appliedSha）；不会修改 config.toml 内容，不会切换接入方式，不会改 model/provider，也不会读取 auth.json。'),
    callout('info', h('strong', { text: '基线 sha：' }),
      ' 旧 ' + shaShort(p.beforeSha) + ' → 新 ' + shaShort(p.afterSha || p.expectedSha) + '。下方是「当前配置自有字段 vs 历史期望」的差异，只列字段名与值，不含任何凭据。'),
    diffRowsTable(rows),
    h('p', { class: 'hint', text: '对齐后配置字节保持不变；如确实要切换接入方式，再点「切换接入方式」走正常的预览 → 确认流程。' }))
  const d = dialog({
    title: '重新对齐配置基线（不改配置内容）',
    desc: '这是一次性确认；只写 state，不写 config.toml。',
    wide: true, content: body,
    actions: [h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => d.close() }), confirm],
  })
  confirm.addEventListener('click', async () => {
    confirm.disabled = true
    confirm.textContent = '对齐中…'
    try {
      const res = await request(AGGREGATION_ENDPOINTS.reconcile, {
        method: 'POST', body: buildReconcileRequest(p, true), timeoutMs: 60000,
      })
      d.close()
      await afterReconcile(ctx, res)
    } catch (e) {
      d.close()
      if (e && e.status === 409) toast('对齐期间配置又变化了，已中止；请重新对齐', 'error')
      else if (e && (e.status === 428 || e.data)) toast('需要重新确认，请再试一次', 'error')
      else toast('对齐失败：' + (e && e.message ? e.message : '未知错误'), 'error')
      await loadAggregation(ctx)
    }
  })
}

// 成功回执：重拉 health 清掉 drifted 标识、恢复切换按钮，并刷新共享快照（首页/连接页同样受益）。
async function afterReconcile (ctx, res) {
  toast(res && res.changed === false
    ? '配置已对齐，无需重复写入'
    : '配置基线已重新对齐：只更新 state，config.toml 未改动', 'success')
  AGG.fetched = false
  await Promise.all([
    loadAggregation(ctx),
    refreshProduct({ force: true, reason: 'reconcile' }).catch(() => null),
  ])
  if (typeof ctx.rerender === 'function') ctx.rerender()
}

// 入口：无 token → 428 preview；带 token 由 showReconcileConsent 完成。导出给 connections.js 复用。
export async function beginReconcile (ctx = {}) {
  if (AGG.reconcileUnavailable) { toast('当前网关未提供重新对齐接口，请升级后重试', 'error'); return }
  try {
    const res = await request(AGGREGATION_ENDPOINTS.reconcile, {
      method: 'POST', body: buildReconcileRequest(null, false), timeoutMs: 60000,
    })
    if (res && res.preview) { showReconcileConsent(res.preview, ctx); return }
    if (res && res.ok) { await afterReconcile(ctx, res); return }
    toast('服务端未返回可用的对齐预览', 'error')
  } catch (e) {
    const data = e && e.data ? e.data : null
    if ((e && e.status === 428) || (data && data.code === 'consent_required')) {
      if (data && data.preview) { showReconcileConsent(data.preview, ctx); return }
      toast('需要确认，但服务端未返回预览内容', 'error'); return
    }
    if (e && e.status === 404) {
      AGG.reconcileUnavailable = true
      AGG.missingRoutes = [AGGREGATION_ENDPOINTS.reconcile]
      if (typeof ctx.rerender === 'function') ctx.rerender()
      toast('当前网关未提供重新对齐接口（404）', 'error')
      return
    }
    if (e && e.status === 409) { toast('对齐期间配置又变化了，请重新检测', 'error'); await loadAggregation(ctx); return }
    toast('无法重新对齐：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

// drifted 提示（routeNotice 附近）：给处于漂移状态的用户一个 GUI 解漂入口。
function driftNotice (ctx) {
  return callout('warn',
    h('strong', { text: '检测到配置漂移：' }),
    ' state 基线（appliedSha）与当前 config.toml 字节不一致，服务端会拒绝切换接入方式（409）。' +
    ' 可以先「重新对齐配置」：采纳当前配置作为新基线，只更新 state、不改 config.toml 内容、不切模式。',
    h('div', { class: 'toolbar', style: { marginTop: '8px' } },
      h('button', {
        class: 'btn btn-primary', type: 'button', text: '重新对齐配置',
        disabled: AGG.reconcileUnavailable === true,
        onclick: () => beginReconcile(ctx),
      })))
}

function showThreeWay (conflict, ctx) {
  const tw = describeThreeWay(conflict)
  const body = h('div', null,
    callout('warn', h('strong', { text: '拒绝覆盖：' }), ' 接入后配置文件被用户或其他程序修改过。ModelGate 不会为了退出聚合而覆盖这些改动。'),
    h('p', { class: 'hint', text: tw.summary }),
    tw.available && tw.rows.length
      ? table([
        { label: '行', render: (r) => h('span', { class: 'mono', text: String(r.afterNo == null ? r.beforeNo : r.afterNo) }) },
        { label: '差异', render: (r) => tag(r.kind === 'add' ? '新增' : r.kind === 'del' ? '删除' : '修改', r.kind === 'del' ? 'bad' : r.kind === 'add' ? 'info' : 'warn') },
        { label: '当前内容', render: (r) => h('span', { class: 'mono-break', text: r.text || '' }) },
      ], tw.rows)
      : empty('没有可展示的行级差异', tw.summary),
    h('details', { class: 'advanced' },
      h('summary', { text: '三方差异原始投影（技术）' }),
      codeBlock(JSON.stringify(tw.raw || {}, null, 2))),
    h('p', { class: 'hint', text: tw.guidance }))
  const d = dialog({ title: '配置冲突（409）· 未写入', desc: '先手工合并，再重新检测；本对话框没有“强制覆盖”。', wide: true, content: body, actions: [
    h('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => d.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: async () => { d.close(); await loadAggregation(ctx) } }),
  ] })
}

async function beginDeactivate (ctx) {
  const health = AGG.health || {}
  const activation = health.activation || {}
  const expectedSha = activation.appliedSha || (health.config && health.config.sha256) || ''
  const ok = await confirmDialog({
    title: '退出聚合模式',
    message: '将把 config.toml 恢复到接入前的字节（仅限 ModelGate 改过的部分）。若期间你手工改过配置，会返回 409 + 三方差异，不会覆盖。',
    confirmLabel: '退出聚合',
    danger: true,
  })
  if (!ok) return
  try {
    const res = await request(AGGREGATION_ENDPOINTS.deactivate, { method: 'POST', body: { expectedSha }, timeoutMs: 60000 })
    toast(res && res.preservedUserEdits
      ? '已退出聚合模式：只撤销了 ModelGate 自有键，接入后你新增/修改的其它配置已保留'
      : '已退出聚合模式，配置已恢复到接入前', 'success')
    await reload(ctx)
  } catch (e) {
    if (e && e.status === 409 && e.data && e.data.detail && e.data.detail.threeWay) { showThreeWay(e, ctx); return }
    if (e && e.status === 409) { toast('无法退出：' + (e.message || '配置已被修改'), 'error'); await loadAggregation(ctx); return }
    toast('退出失败：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

function advancedSection (ctx) {
  return h('details', { class: 'advanced' },
    h('summary', { text: '高级详情（技术长表与诊断）' }),
    h('p', { class: 'hint', text: '默认页面只给结论与下一步；SHA、备份路径、版本探测、原生压缩字段、供应商/模型/诊断长表都在这里展开。' }),
    technicalDetails(),
    providersCard(ctx),
    modelsCard(),
    diagnosticsCard())
}

export function render (root, ctx = {}) {
  if (!AGG.fetched && !AGG.loading) loadAggregation(ctx)
  const loading = !AGG.fetched && AGG.loading
  root.append(pageHead('聚合详情', '高级诊断与一键启停。日常接入请到「模型与账号」只填一个 OpenCode Go API Key；本页保留完整技术证据与无损退出。', {
    eyebrow: 'AGGREGATION / ADVANCED',
    actions: [
      h('button', { class: 'btn', type: 'button', text: '重新检测', onclick: () => { AGG.fetched = false; loadAggregation(ctx) } }),
      h('button', { class: 'btn btn-primary', type: 'button', text: '模型与账号', onclick: () => { location.hash = '#/connections' } }),
    ],
  }))
  if (loading) {
    root.append(callout('info', h('strong', { text: '正在读取聚合状态与 Desktop 探测结果…' }), ' 在响应返回前不显示 0、不显示“已连接”。'))
    return
  }
  const mode = currentModeOf(AGG.health)
  const drifted = !!(AGG.health && AGG.health.drifted === true)
  if (AGG.routeMissing || AGG.modesUnavailable) root.append(routeNotice(ctx))
  if (drifted) root.append(driftNotice(ctx))
  if (AGG.healthError && !AGG.routeMissing) {
    root.append(callout('danger', h('strong', { text: '聚合健康接口读取失败：' }), AGG.healthError.message || '未知错误',
      h('div', { class: 'toolbar', style: { marginTop: '8px' } }, h('button', { class: 'btn btn-sm', type: 'button', text: '重试', onclick: () => { AGG.fetched = false; loadAggregation(ctx) } }))))
  }
  const modeMetric = modeLabel(mode, drifted)
  root.append(h('div', { class: 'grid grid-4' },
    metric('接入方式', modeMetric.label, '来自服务端 health.mode' + (drifted ? ' · 已漂移' : ''), 'check'),
    metric('供应商', AGG.providers ? fmtInt((Array.isArray(AGG.providers) ? AGG.providers : (AGG.providers.providers || [])).length) : '未知', '来自聚合注册表', 'plus'),
    metric('模型（口径见下）', summarizeDiscovery(AGG.diagnostics, AGG.models).countText || '未知', '部分/失败时不显示为全量', 'probe'),
    metric('备份', AGG.health && AGG.health.backup && AGG.health.backup.available ? '可用' : '无', '接入前字节快照', 'key')))
  root.append(overviewCard(ctx))
  root.append(callout('warn',
    h('strong', { text: '本页不冒充真实验收：' }),
    ' UI 只能证明接口返回与配置事务成功；原版 Desktop 模型选择器是否出现全部模型、每个模型是否落到正确供应商，必须在真实 GUI 中按交付报告的手动脚本核对（PASS_MOCK ≠ PASS_REAL）。'))
  root.append(advancedSection(ctx))
  root.append(h('p', { class: 'page-note', text: '数据来源：' + AGGREGATION_ENDPOINTS.health + ' / modes / providers / models / diagnostics；切换走 switch / rollback（activate / deactivate 仅兼容旧路径）；漂移解漂走 reconcile。读取于 ' + (AGG.loadedAt ? fmtTime(AGG.loadedAt) : '—') + '。' }))
}
