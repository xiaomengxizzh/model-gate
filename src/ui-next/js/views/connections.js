// 连接与聚合向导（UX-02 / UX-03，owner: A2）。
//
// 目标：普通用户"只填一个 OpenCode Go API Key"就能完成
//   注册供应商 → 保存 Key → 同步目标模型 → 预览并确认启用聚合 → 重启 Codex → 在 Codex 中使用 → 退出恢复。
//
// 硬约束：
//   * 零依赖、纯 DOM（h() 构造），禁止任何 HTML 字符串注入；
//   * Key 只在提交那一刻存在于局部变量：提交前清空输入框，不回显、不写入任何浏览器存储、
//     不进 URL、不进日志、不进入任何返回结果（凭据写入通道只有 POST /api/keys）；
//   * 状态只来自真实快照：A3 提供 store.productStatus()/aggregationState()/refreshProduct()；
//     缺失时如实显示"正在读取真实状态"，绝不显示"已连接/已启用"；
//   * 428 预览 → 一次显式确认 → 带 consentToken + expectedSha 提交；409 只展示三方差异，
//     保留用户输入，绝不强制覆盖；422 如实展示 blocked；
//   * 重启结论只来自 health.detect.restart；没检测到重启不说"已生效"，也没有假"打开 Codex"按钮。
//
// 可测试性：编排与判定拆成可注入 deps 的纯函数（buildProviderRequest/buildKeyRequest/runConnectFlow/
// partialStateMessage/classifyActivation/activationPreviewSummary/describeOverall/statusRows），
// 视图只负责渲染与事件接线。
import { h, clear } from '../dom.js'
import {
  pageHead, card, callout, tag, field, confirmDialog, toast, table, kvList,
} from '../components.js'
import * as store from '../store.js'
import { request } from '../api.js'
import { fmtTime } from '../format.js'
import * as productStatus from '../product-status.js'
import {
  AGGREGATION_ENDPOINTS,
  summarizeDiscovery,
  restartNotice,
  describeThreeWay,
  buildActivateRequest,
  buildSwitchRequest,
  buildRollbackRequest,
  beginReconcile,
  modeLabel,
  modeChooser,
  selectableParentModels,
  DEFAULT_PARENT_MODEL,
  THREE_MODES,
} from './aggregation.js'

export const CONNECTIONS_VIEW_CONTRACT = 'mg-ui-connections/1'

// 单一事实来源：供应商段与目标模型名都来自产品状态契约模块（不在本文件另写一份）。
const GO_PROVIDER = productStatus.GO_PROVIDER_ID || 'opencodego'
const GO_TARGET_UPSTREAM = productStatus.GO_TARGET_MODEL || 'deepseek-v4.1-flash'
// 面向用户只显示模型名（契约 §7：默认不出现 providerId / 公共 ID 等技术字段）。
export const GO_TARGET_LABEL = 'DeepSeek V4.1 Flash'
export const PROVIDER_PRESET_ID = 'opencode-go'

// 默认落地步骤：三模式连接中枢（不是 key 向导第 1 步）。
export const LANDING_STEP = 'connect'

// 线性向导步骤；conflict/codex 是状态机分支，不在线性序列里。
export const CONNECT_STEPS = Object.freeze([
  { id: 'key', label: '连接 OpenCode Go', hint: '只需要一个 API Key' },
  { id: 'model', label: '确认 DeepSeek 模型', hint: '确认 ' + GO_TARGET_LABEL + ' 已发现' },
  { id: 'enable', label: '启用聚合', hint: '预览后一次确认' },
  { id: 'restart', label: '重新打开 Codex', hint: '完全退出再打开' },
  { id: 'use', label: '在 Codex 中使用', hint: '在模型选择器里选择' },
  { id: 'revert', label: '退出并恢复', hint: '撤销 ModelGate 改过的字节' },
])
export const SPECIAL_CONNECT_STEPS = Object.freeze(['conflict', 'codex', LANDING_STEP])
export const CONNECT_ACTION_ORDER = Object.freeze(['provider', 'key', 'sync'])
const CONNECT_ACTION_LABELS = Object.freeze({
  provider: '注册 OpenCode Go 供应商',
  key: '保存 OpenCode Go API Key',
  sync: '同步 DeepSeek 模型目录',
})

// —— 三模式落地页（参考图）——
// segmented 切换条文案：唯一来源，测试与 UI 共用。
export const SEGMENT_SPECS = Object.freeze([
  Object.freeze({ mode: 'official', label: '⚡ 直连' }),
  Object.freeze({ mode: 'route', label: '⇄ 路由' }),
  Object.freeze({ mode: 'aggregated', label: '▤ 聚合' }),
])
// 三张并排卡片的文案：与参考图逐项对应，避免散落在 DOM 构造里。
export const MODE_CARD_SPECS = Object.freeze([
  Object.freeze({
    mode: 'official', tone: 'direct', icon: '⚡', title: '直连模式',
    subtitle: 'Codex 直接连接官方服务', provider: 'ChatGPT 官方', model: 'GPT-6 Luna',
    status: '官方登录正常', cta: '使用直连', footnote: '不经过 ModelGate 转发',
  }),
  Object.freeze({
    mode: 'route', tone: 'route', icon: '🌱', title: '路由模式',
    subtitle: '经由 ModelGate 转发请求', provider: 'OpenCode Go', model: 'deepseek-v4.1-flash',
    status: '网关运行中', cta: '启用路由', footnote: '需要网关持续运行',
  }),
  Object.freeze({
    mode: 'aggregated', tone: 'aggregate', icon: '▤', title: '聚合模式',
    subtitle: '在原版 Codex 中使用多个模型', cta: '启用聚合', footnote: '原版 Codex Harness · 原生压缩',
    rows: ['ChatGPT 官方', 'OpenCode Go / deepseek-v4.1-flash'],
    tagline: '父代理: 官方 GPT | 子代理: DeepSeek',
  }),
])

// 官方侧父模型下拉的友好名：只有 luna 是已签收/PASS_REAL，其余一律 UNVERIFIED。
export function friendlyParentLabel (id) {
  return id === DEFAULT_PARENT_MODEL
    ? 'GPT-6 Luna（已签收/PASS_REAL）'
    : String(id) + '（未验证 UNVERIFIED）'
}

// 卡片主按钮的切换请求体（预览阶段：无 token、无 expectedSha 写入）。
// 复用 aggregation.js 的冻结构造函数，保证与详情页/后端契约同源。
export function buildCardSwitchBody (mode, parentModel) {
  return buildSwitchRequest(null, false, mode, parentModel || null)
}

// —— 纯函数：步骤与路由 ——
export function normalizeStep (value, fallback = 'key') {
  const v = String(value == null ? '' : value).trim()
  if (CONNECT_STEPS.some((s) => s.id === v) || SPECIAL_CONNECT_STEPS.includes(v)) return v
  return fallback
}

export function stepFromHash (hash) {
  const raw = String(hash == null ? '' : hash)
  const q = raw.indexOf('?')
  const query = q >= 0 ? raw.slice(q + 1) : ''
  let step = ''
  try {
    step = new URLSearchParams(query).get('step') || ''
  } catch {
    step = ''
  }
  return normalizeStep(step)
}

export function stepHash (step) {
  return '#/connections?step=' + encodeURIComponent(normalizeStep(step))
}

// 目标模型 ID 匹配：公共 ID 是 mg-opencodego-deepseek-v4-1-flash（catalog.js:stableModelId），
// 上游名是 deepseek-v4.1-flash；旧文档里的 opencodego/deepseek-v4.1-flash 也一并容错。
// 集成后产品状态模块提供 matchesGoTargetId 时优先用它（保持单一判定来源）。
export function isGoTargetModelId (value) {
  if (typeof productStatus.matchesGoTargetId === 'function') return productStatus.matchesGoTargetId(value)
  const v = String(value == null ? '' : value).trim().toLowerCase()
  if (!v) return false
  const upstream = GO_TARGET_UPSTREAM.toLowerCase()
  const slug = 'mg-opencodego-' + upstream.replace(/[^a-z0-9]+/g, '-')
  return v === upstream || v === GO_PROVIDER + '/' + upstream || v === slug
}

// 从 /api/aggregation/models 的返回里挑出目标模型；挑不到返回 null（不是"0 个模型"）。
export function targetModelOf (modelsPayload) {
  const list = Array.isArray(modelsPayload)
    ? modelsPayload
    : (modelsPayload && Array.isArray(modelsPayload.models) ? modelsPayload.models : [])
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    if (isGoTargetModelId(m.publicId) || isGoTargetModelId(m.upstreamId) ||
        isGoTargetModelId(m.id) || isGoTargetModelId(m.name)) return m
  }
  return null
}

// —— 纯函数：写入请求（只提交真实必要字段）——
const PROVIDER_OVERRIDE_FIELDS = Object.freeze(['id', 'kind', 'baseUrl', 'apiKeyEnv'])

// 默认只交 preset + configVersion：供应商 ID/端点/变量名由服务端已登记模板补全，
// 普通表单不要求用户理解它们。overrides 只来自"高级设置"（排障用途）。
export function buildProviderRequest ({ configVersion, overrides } = {}) {
  const body = { preset: PROVIDER_PRESET_ID }
  const v = Number(configVersion)
  if (Number.isFinite(v)) body.configVersion = v
  const o = overrides && typeof overrides === 'object' ? overrides : null
  if (o) {
    for (const key of PROVIDER_OVERRIDE_FIELDS) {
      const value = o[key] == null ? '' : String(o[key]).trim()
      if (value) body[key] = value
    }
  }
  return body
}

// Key 的唯一写入形状：POST /api/keys { id: 'opencodego', key }。
export function buildKeyRequest (key) {
  return { id: GO_PROVIDER, key: String(key == null ? '' : key) }
}

// 既有凭据（系统环境变量 / 网关已存）只报告"来源"，永不回显值。
// product.go.credentialSource 来自 /api/status.providers[].keySource：
//   env          = 进程环境变量
//   env-registry = 用户级环境变量（environment.d / 注册表，实时读取）
//   keys         = 网关已保存的 Key
export function existingCredentialInfo (product) {
  const go = product && product.go ? product.go : null
  if (!go || go.credentialPresent !== true) return { available: false, source: null, envName: null, label: '' }
  const source = String(go.credentialSource || '')
  const envName = go.apiKeyEnv || 'OPENCODE_API_KEY'
  if (source === 'env' || source === 'env-registry') {
    return { available: true, source, envName, label: '系统环境变量 ' + envName }
  }
  if (source === 'keys') return { available: true, source, envName: null, label: '网关已保存的 Key' }
  return { available: false, source: source || null, envName: null, label: '' }
}

export function buildDeactivateRequest (expectedSha) {
  const sha = expectedSha == null ? '' : String(expectedSha)
  return sha ? { expectedSha: sha } : {}
}

// —— 纯函数：编排 ——
function errorInfo (error) {
  const data = error && error.data && typeof error.data === 'object' ? error.data : null
  const status = Number(error && error.status) || 0
  const code = String(
    (data && (data.code || data.error)) ||
    (error && (error.code || error.message)) ||
    'unknown_error',
  )
  return { status, code }
}

function startFlags (prior) {
  const p = prior && typeof prior === 'object' ? prior : null
  return {
    providerRegistered: !!(p && p.providerRegistered === true),
    providerExisted: !!(p && p.providerExisted === true),
    keySaved: !!(p && p.keySaved === true),
    synced: !!(p && p.synced === true),
    syncPartial: !!(p && p.syncPartial === true),
  }
}

function finishConnect (result) {
  result.ok = result.failedStep === null && result.keySaved === true &&
    result.synced === true && result.syncPartial !== true
  return result
}

// 顺序固定：providers → keys → sync（Key 只能在供应商写入之后保存，doSaveKeys 要求 id 已在 cfg.providers）。
// deps: { post(path, body) → Promise<data>, key, configVersion, overrides, prior, from }
//   * from = 'provider' | 'key' | 'sync'：只重试后续步骤（前面步骤标记 not-run，不谎称已执行）；
//   * prior = 上一次结果：重试时沿用已知成功的步骤，但未重跑过的步骤不会被标成 done；
//   * provider 返回 409 provider_exists 时按"已注册"继续（重试幂等），其它 409 如实失败。
export async function runConnectFlow (deps = {}) {
  const post = deps.post
  if (typeof post !== 'function') throw new TypeError('runConnectFlow 需要注入 post(path, body)')
  const key = String(deps.key == null ? '' : deps.key)
  const requestedFrom = String(deps.from == null ? '' : deps.from)
  const from = CONNECT_ACTION_ORDER.includes(requestedFrom) ? requestedFrom : CONNECT_ACTION_ORDER[0]
  const fromIndex = CONNECT_ACTION_ORDER.indexOf(from)
  const steps = CONNECT_ACTION_ORDER.map((id) => ({ id, label: CONNECT_ACTION_LABELS[id], status: 'pending', message: '', code: null }))
  const result = Object.assign({
    ok: false,
    from,
    keyProvided: key.length > 0,
    failedStep: null,
    failedCode: null,
    steps,
  }, startFlags(deps.prior))

  const markNotRun = (index) => {
    steps[index].status = 'not-run'
    steps[index].message = '本次只重试后续步骤，未重复执行'
  }

  // 1) 注册供应商（preset 由服务端补全 ID/端点/名称/v2 作用域）
  if (fromIndex > 0) markNotRun(0)
  else {
    try {
      await post(AGGREGATION_ENDPOINTS.providers, buildProviderRequest({ configVersion: deps.configVersion, overrides: deps.overrides }))
      steps[0].status = 'done'
      steps[0].message = '已注册 OpenCode Go 供应商'
      result.providerRegistered = true
    } catch (error) {
      const info = errorInfo(error)
      // 既有 V1 时代的 providers.opencodego（无聚合元数据）占用固定 id 时，显式接管：
      // 只补聚合元数据，保留原 baseUrl/apiKeyEnv 与既有模型绑定（不新建第二套凭据）。
      if (info.status === 409 && info.code === 'provider_id_in_use') {
        try {
          await post(AGGREGATION_ENDPOINTS.providers, Object.assign(
            buildProviderRequest({ configVersion: deps.configVersion, overrides: deps.overrides }),
            { adopt: true },
          ))
          steps[0].status = 'done'
          steps[0].message = '已接管既有 OpenCode Go 供应商（保留原端点与 Key，仅补聚合元数据）'
          result.providerRegistered = true
          result.providerAdopted = true
        } catch (adoptError) {
          const ainfo = errorInfo(adoptError)
          steps[0].status = 'failed'
          steps[0].code = ainfo.code
          steps[0].message = '接管既有供应商失败：' + ainfo.code
          result.failedStep = 'provider'
          result.failedCode = ainfo.code
          steps[1].status = 'skipped'
          steps[1].message = '未执行：供应商接管失败，没有写入任何 Key'
          steps[2].status = 'skipped'
          steps[2].message = '未执行：供应商接管失败'
          return finishConnect(result)
        }
      } else if (info.status === 409 && info.code === 'provider_exists') {
        steps[0].status = 'existing'
        steps[0].message = '供应商已存在，继续保存 Key（不重复创建）'
        result.providerRegistered = true
        result.providerExisted = true
      } else {
        steps[0].status = 'failed'
        steps[0].code = info.code
        steps[0].message = '供应商注册失败：' + info.code
        result.failedStep = 'provider'
        result.failedCode = info.code
        steps[1].status = 'skipped'
        steps[1].message = '未执行：供应商注册失败，没有写入任何 Key'
        steps[2].status = 'skipped'
        steps[2].message = '未执行：供应商注册失败'
        return finishConnect(result)
      }
    }
  }

  // 2) 凭据：优先复用系统环境变量里的既有凭据（网关 resolveKey 会读 env / 用户级 env），
  //    绝不为了"走一遍流程"把已有 Key 再写进 keys.local.json。
  if (fromIndex > 1) markNotRun(1)
  else if (deps.useExistingCredential === true) {
    steps[1].status = 'existing'
    steps[1].message = '使用系统环境变量中的现有凭据（未写入、未回显任何 Key）'
    result.keySaved = false
    result.credentialSource = 'existing-env'
  } else if (!key) {
    steps[1].status = 'failed'
    steps[1].code = 'key_required'
    steps[1].message = '缺少 OpenCode Go API Key'
    result.failedStep = 'key'
    result.failedCode = 'key_required'
    steps[2].status = 'skipped'
    steps[2].message = '未执行：还没有保存 Key'
    return finishConnect(result)
  } else {
    try {
      const res = await post('/api/keys', buildKeyRequest(key))
      if (res && res.ok === false) {
        throw Object.assign(new Error('key_save_rejected'), { code: res.code || 'key_save_rejected', data: res })
      }
      steps[1].status = 'done'
      steps[1].message = 'Key 已保存（仅存于本机网关，不回显、不写入浏览器）'
      result.keySaved = true
    } catch (error) {
      const info = errorInfo(error)
      steps[1].status = 'failed'
      steps[1].code = info.code
      steps[1].message = 'Key 保存失败：' + info.code
      result.failedStep = 'key'
      result.failedCode = info.code
      steps[2].status = 'skipped'
      steps[2].message = '未执行：Key 未保存'
      return finishConnect(result)
    }
  }

  // 3) 同步目录（只读取模型清单，不发起推理）
  if (fromIndex > 2) markNotRun(2)
  else {
    try {
      const res = await post(AGGREGATION_ENDPOINTS.sync(GO_PROVIDER), {})
      if (res && res.ok === false) {
        throw Object.assign(new Error('sync_failed'), { code: res.code || 'sync_failed', data: res })
      }
      const completeness = res && res.completeness ? String(res.completeness) : ''
      steps[2].completeness = completeness || null
      if (completeness && completeness.indexOf('partial') >= 0) {
        steps[2].status = 'partial'
        steps[2].message = '模型发现未完成（这不是 0 个模型，可重试同步）'
        result.syncPartial = true
      } else {
        steps[2].status = 'done'
        steps[2].message = '模型目录已同步'
        result.synced = true
      }
    } catch (error) {
      const info = errorInfo(error)
      steps[2].status = 'failed'
      steps[2].code = info.code
      steps[2].message = '模型同步失败：' + info.code
      result.failedStep = 'sync'
      result.failedCode = info.code
    }
  }
  return finishConnect(result)
}

// 部分成功必须如实：既有成功步骤就说成功，失败步骤给稳定 code，绝不显示"已连接"。
export function partialStateMessage (result) {
  const r = result && typeof result === 'object' ? result : {}
  const code = r.failedCode ? String(r.failedCode) : ''
  const suffix = code ? '（' + code + '）' : ''
  if (r.failedStep === 'unknown') {
    return {
      tone: 'error',
      label: '连接流程异常',
      text: '连接流程异常' + suffix,
      detail: '可能没有写入、也可能只完成了一部分；请按真实状态重新检测，本页不会自动重试或伪造成功。',
      partial: true,
    }
  }
  if (r.failedStep === 'provider') {
    return {
      tone: 'error',
      label: '供应商注册失败',
      text: '供应商注册失败' + suffix,
      detail: '这次没有保存 Key，也没有发起模型同步。请确认网关版本与本机回环访问后重试；不会伪造成功。',
      partial: false,
    }
  }
  if (r.failedStep === 'key') {
    return {
      tone: 'warn',
      label: 'Key 未保存',
      text: '已注册 OpenCode Go 供应商，但 Key 保存失败' + suffix,
      detail: '供应商已存在，重试时不会重复创建；请重新输入 Key 后再提交。',
      partial: true,
    }
  }
  if (r.failedStep === 'sync') {
    return {
      tone: 'warn',
      label: 'Key 已保存，连接未完成',
      text: 'Key 已保存，连接未完成' + suffix,
      detail: '模型目录同步失败：没有拿到模型清单不是 0 个模型。可以只重试同步。',
      partial: true,
    }
  }
  if (r.syncPartial) {
    return {
      tone: 'warn',
      label: 'Key 已保存，发现未完成',
      text: 'Key 已保存，但模型发现未完成（不是 0 个模型）',
      detail: '当前列表不是完整目录；可重试同步或查看高级诊断。',
      partial: true,
    }
  }
  if (r.ok) {
    return {
      tone: 'good',
      label: '已注册并保存 Key',
      text: '已注册并保存 Key，模型目录同步完成',
      detail: '下一步确认 ' + GO_TARGET_LABEL + ' 是否已出现在模型目录中。',
      partial: false,
    }
  }
  return { tone: 'muted', label: '尚未完成', text: '还没有执行任何写入。', detail: '', partial: false }
}

// —— 纯函数：启用/退出判定（428 预览 / 422 blocked / 409 三方差异 / 200 回执）——
function outcomeBody (outcome) {
  if (!outcome || typeof outcome !== 'object') return {}
  if (outcome.data && typeof outcome.data === 'object') return outcome.data
  return outcome
}

export function activationPreviewSummary (preview) {
  const p = preview && typeof preview === 'object' ? preview : {}
  const rows = Array.isArray(p.rows) ? p.rows.filter((r) => r && r.kind !== 'same') : []
  const conflicts = Array.isArray(p.conflicts) ? p.conflicts : []
  const backup = p.backup && typeof p.backup === 'object' ? p.backup : {}
  return {
    changeRows: rows,
    changeCount: rows.length,
    conflicts: conflicts.map((c) => (c && c.path) || String(c)),
    backupAvailable: backup.available === true,
    backupPath: backup.path || null,
    firstRun: p.firstRun === true,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    catalog: p.catalog || null,
    // MG-FIX-P1-05：把 Codex 原生子代理配置的托管计划如实展示给用户。
    agentChild: p.agentChild && typeof p.agentChild === 'object' ? {
      action: String(p.agentChild.action || ''),
      fileName: String(p.agentChild.fileName || 'go-deepseek.toml'),
      before: p.agentChild.before || null,
      after: p.agentChild.after || null,
      conflict: p.agentChild.conflict || null,
    } : null,
    expectedSha: p.expectedSha == null ? '' : String(p.expectedSha),
    consentToken: typeof p.consentToken === 'string' ? p.consentToken : '',
    blocked: Array.isArray(p.blocked) ? p.blocked : [],
  }
}

export function classifyActivation (outcome) {
  const status = Number(outcome && outcome.status) || 0
  const body = outcomeBody(outcome)
  const code = String(body.code || '')
  if (status === 428 || code === 'consent_required') {
    const preview = body.preview && typeof body.preview === 'object' ? body.preview : null
    return {
      kind: 'preview',
      status: status || 428,
      code: 'consent_required',
      preview,
      summary: activationPreviewSummary(preview),
      writes: false,
    }
  }
  if (status === 422 || code === 'activation_blocked') {
    return {
      kind: 'blocked',
      status: status || 422,
      code: code || 'activation_blocked',
      blocked: Array.isArray(body.blocked) ? body.blocked : [],
      summary: activationPreviewSummary(body.preview),
      writes: false,
    }
  }
  if (status === 409) {
    return {
      kind: 'conflict',
      status: 409,
      code: code || 'config_conflict',
      threeWay: describeThreeWay(outcome),
      writes: false,
      mayOverwrite: false,
    }
  }
  if (body.ok === true && (status === 0 || status === 200)) {
    return { kind: 'applied', status: 200, receipt: body, writes: true }
  }
  if (status >= 400) {
    return { kind: 'error', status, code, message: String(body.error || body.message || ''), writes: false }
  }
  return { kind: 'unknown', status, code, writes: false }
}

export function receiptSummary (receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {}
  const reload = r.reload && typeof r.reload === 'object' ? r.reload : null
  const verification = r.verification && typeof r.verification === 'object' ? r.verification : null
  const catalog = verification && verification.catalog && typeof verification.catalog === 'object' ? verification.catalog : null
  return {
    sha: r.sha || null,
    preservedUserEdits: r.preservedUserEdits === true,
    reloadApplied: !!(reload && reload.applied === true),
    needsRestart: !!(reload && reload.needsRestart === true),
    reloadReason: (reload && reload.reason) || null,
    catalogCount: catalog && Number.isFinite(Number(catalog.modelCount)) ? Number(catalog.modelCount) : null,
    gatewayStatus: verification && verification.gateway ? verification.gateway.status : null,
  }
}

// —— 纯函数：总体状态与三条状态行 ——
const LEVEL_TONE = Object.freeze({ ready: 'good', action: 'warn', error: 'bad', locked: 'muted', unknown: 'muted', loading: 'muted' })

function toneOfTag (tone) {
  return tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : tone === 'info' ? 'info' : 'muted'
}

export function describeOverall (product) {
  if (!product) {
    return {
      level: 'loading',
      tone: 'muted',
      label: '正在读取真实状态',
      detail: '还没有取得真实状态快照；数据到达前不显示任何成功结论。',
    }
  }
  const overall = product.overall && typeof product.overall === 'object' ? product.overall : {}
  const level = String(overall.level || 'unknown')
  return {
    level,
    tone: LEVEL_TONE[level] || 'muted',
    label: String(overall.label || '状态未知'),
    detail: String(overall.detail || ''),
    state: String(product.state || ''),
  }
}

// 三条必要状态行（官方套餐 / OpenCode Go / Codex Desktop）；聚合模式单独一枚标签。
// product 缺失时三行都是"未知"，绝不写成已连接。
export function statusRows (product) {
  if (!product) {
    return ['official', 'go', 'codex'].map((id) => ({
      id,
      label: id === 'official' ? 'ChatGPT 套餐' : id === 'go' ? 'OpenCode Go' : 'Codex Desktop',
      value: '未知',
      detail: '正在读取真实状态',
      level: 'unknown',
      tone: 'muted',
    }))
  }
  const official = product.official && typeof product.official === 'object' ? product.official : {}
  const go = product.go && typeof product.go === 'object' ? product.go : {}
  const codex = product.codex && typeof product.codex === 'object' ? product.codex : {}
  const officialTone = official.state === 'detected' ? 'good' : official.state === 'missing' ? 'warn' : 'muted'
  const goTone = go.state === 'verified' || go.state === 'configured' ? 'good' : go.state === 'error' ? 'bad' : go.state === 'missing' ? 'warn' : 'muted'
  const codexTone = !codex.found ? 'muted' : codex.restartNeeded === true ? 'warn' : codex.restartNeeded === false ? 'good' : 'info'
  return [
    { id: 'official', label: 'ChatGPT 套餐', value: String(official.label || '未知'), detail: String(official.detail || ''), level: String(official.level || 'unknown'), tone: officialTone },
    { id: 'go', label: 'OpenCode Go', value: String(go.label || '未知'), detail: String(go.detail || ''), level: String(go.level || 'unknown'), tone: goTone },
    { id: 'codex', label: 'Codex Desktop', value: String(codex.label || '未知'), detail: String(codex.detail || ''), level: String(codex.detectionLevel || 'unknown'), tone: codexTone },
  ]
}

function aggregationTag (product) {
  if (!product) return { label: '聚合状态未知', tone: 'muted' }
  const agg = product.aggregation && typeof product.aggregation === 'object' ? product.aggregation : {}
  return {
    label: String(agg.label || '聚合状态未知'),
    tone: agg.mode === 'aggregated' ? 'good' : agg.mode === 'official' ? 'muted' : 'warn',
  }
}

const LEVEL_LABELS = Object.freeze({
  detected: '检测到', configured: '已配置', 'runtime-verified': '运行时已验证',
  'not-tested': '未实测', unknown: '未知',
})

// —— 视图取数（只读；状态层缺失时如实降级）——
function productOf (ctx) {
  if (ctx && typeof ctx.product === 'function') {
    try { return ctx.product() } catch { return null }
  }
  if (ctx && ctx.product && typeof ctx.product === 'object') return ctx.product
  if (typeof store.productStatus === 'function') {
    try { return store.productStatus() } catch { return null }
  }
  return null
}

function aggregationOf (ctx) {
  if (ctx && ctx.aggregation && typeof ctx.aggregation === 'object') return ctx.aggregation
  if (typeof store.aggregationState === 'function') {
    try { return store.aggregationState() } catch { return null }
  }
  return null
}

function currentConfigVersion () {
  const config = store.state && store.state.config ? store.state.config : null
  const status = store.state && store.state.status ? store.state.status : null
  const value = config && config.configVersion != null ? config.configVersion : (status ? status.configVersion : null)
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function viewPost (ctx) {
  const injected = ctx && ctx.deps && typeof ctx.deps.post === 'function' ? ctx.deps.post : null
  if (injected) return injected
  return (path, body) => request(path, { method: 'POST', body, timeoutMs: 60000 })
}

async function refreshAll (ctx) {
  const refresh = ctx && typeof ctx.refreshProduct === 'function'
    ? ctx.refreshProduct
    : (typeof store.refreshProduct === 'function' ? store.refreshProduct : null)
  if (refresh) {
    try { await refresh({ reason: 'connections', force: true }) } catch { /* 状态层自己进入错误态，视图不伪造成功 */ }
  }
  if (ctx && typeof ctx.rerender === 'function') ctx.rerender()
}

function goToStep (step) {
  try { location.hash = stepHash(step) } catch { /* 无 location（测试/非浏览器）时不跳转 */ }
}

// —— 视图：局部组件 ——
function statusLine (row) {
  return h('div', { class: 'list-row' },
    h('div', { class: 'grow' },
      h('div', { class: 'primary', text: row.label }),
      h('div', { class: 'secondary', text: row.detail || row.value })),
    h('div', { class: 'toolbar', style: { margin: '0' } },
      tag(LEVEL_LABELS[row.level] || row.level, toneOfTag(row.tone)),
      tag(row.value, toneOfTag(row.tone))))
}

function overallCard (product) {
  const overall = describeOverall(product)
  const agg = aggregationTag(product)
  const primary = product && product.primary && typeof product.primary === 'object' ? product.primary : null
  const body = h('div', null,
    callout(overall.tone === 'good' ? 'good' : overall.tone === 'bad' ? 'danger' : overall.tone === 'warn' ? 'warn' : 'info',
      h('strong', { text: overall.label + '：' }), ' ' + overall.detail),
    h('div', { class: 'list' }, statusRows(product).map(statusLine)),
    h('div', { class: 'toolbar', style: { marginTop: '10px' } },
      tag(agg.label, agg.tone),
      primary && String(primary.route || '').startsWith('#/connections')
        ? h('button', {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          text: primary.label,
          onclick: () => goToStep(stepFromHash(primary.route)),
        })
        : null,
      product && product.secondary && Array.isArray(product.secondary)
        ? product.secondary
          .filter((x) => x && String(x.route || '').startsWith('#/connections'))
          .map((x) => h('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: x.label,
            onclick: () => goToStep(stepFromHash(x.route)),
          }))
        : null))
  return card('当前状态', '来自只读状态快照（/api/status 与 /api/aggregation/*）；缺失的部分显示为未知。', body,
    { foot: product && product.checkedAt ? '快照时间 ' + fmtTime(product.checkedAt) : '尚未取得真实快照' })
}

function stepNav (active, ctx) {
  return h('div', { class: 'toolbar', role: 'tablist', 'aria-label': '接入步骤' },
    CONNECT_STEPS.map((s) => h('button', {
      class: 'btn btn-sm' + (s.id === active ? ' btn-primary' : ''),
      type: 'button',
      role: 'tab',
      'aria-selected': s.id === active ? 'true' : 'false',
      'aria-current': s.id === active ? 'step' : null,
      title: s.hint,
      text: (CONNECT_STEPS.indexOf(s) + 1) + '. ' + s.label,
      onclick: () => goToStep(s.id),
    })),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-sm', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) }))
}

const STEP_STATUS_TEXT = Object.freeze({
  pending: '等待', done: '已完成', existing: '已存在', partial: '未完成',
  failed: '失败', skipped: '未执行', 'not-run': '未执行',
})
const STEP_STATUS_TONE = Object.freeze({
  pending: 'muted', done: 'good', existing: 'info', partial: 'warn',
  failed: 'bad', skipped: 'muted', 'not-run': 'muted',
})

function renderFlowResult (host, result) {
  const summary = partialStateMessage(result)
  const kind = summary.tone === 'good' ? 'good' : summary.tone === 'error' ? 'danger' : summary.tone === 'muted' ? 'info' : 'warn'
  clear(host)
  host.append(
    callout(kind,
      h('strong', { text: summary.label + '：' }), ' ' + summary.text,
      summary.detail ? h('p', { class: 'hint', text: summary.detail }) : null),
    h('div', { class: 'list' }, (result.steps || []).map((s) => h('div', { class: 'list-row' },
      h('div', { class: 'grow' },
        h('div', { class: 'primary', text: s.label }),
        h('div', { class: 'secondary', text: s.message || '' })),
      tag(STEP_STATUS_TEXT[s.status] || s.status, STEP_STATUS_TONE[s.status] || 'muted')))))
}

// —— 步骤 1：只填 Key ——
function keyPanel (ctx, product) {
  const input = h('input', {
    type: 'password',
    autocomplete: 'new-password',
    spellcheck: 'false',
    'aria-required': 'true',
    placeholder: '粘贴 OpenCode Go API Key',
  })
  const error = h('p', { class: 'field-error', role: 'alert' })
  const live = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' })
  const resultHost = h('div')
  const submit = h('button', { class: 'btn btn-primary', type: 'button', text: '连接 OpenCode Go' })

  const idInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '默认 opencodego' })
  const baseInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '留空使用已登记端点' })
  const envInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '只填变量名，例如 OPENCODE_API_KEY' })
  const advanced = h('details', { class: 'advanced' },
    h('summary', { text: '高级设置（仅排障时使用）' }),
    callout('warn',
      h('strong', { text: '风险：' }),
      ' 手写供应商 ID / 端点 / 变量名会绕过默认模板；写错会注册失败或指向错误端点。普通接入请不要展开本区域。'),
    field('供应商 ID（高级）', idInput, { help: '默认由服务端按 preset 生成；自定义 ID 必须与类型匹配。' }),
    field('端点 Base URL（高级）', baseInput, { help: '必须是 https 且属于 OpenCode 白名单；不要把 Key 写进 URL。' }),
    field('apiKeyEnv（高级）', envInput, { help: '只填环境变量名，不要粘贴 Key。' }))

  const keyField = field('OpenCode Go API Key', input, {
    help: '只会提交给本机 ModelGate（POST /api/keys）。不会回显、不写入浏览器存储、不进入页面地址或日志。',
  })
  keyField.append(error)

  const next = h('div', { class: 'toolbar', style: { marginTop: '10px' } },
    h('button', { class: 'btn btn-sm', type: 'button', text: '查看模型发现结果', onclick: () => goToStep('model') }))

  // 已有系统环境变量凭据时：默认"直接使用"，不再要求粘贴；粘贴只是可选后备。
  const existing = existingCredentialInfo(product)
  if (existing.available) {
    const useExisting = h('button', { class: 'btn btn-primary', type: 'button', text: '使用现有凭据并连接' })
    const manualBox = h('details', { class: 'advanced' },
      h('summary', { text: '改用其他 API Key' }),
      keyField,
      h('div', { class: 'toolbar' }, submit))
    useExisting.addEventListener('click', async () => {
      error.textContent = ''
      live.textContent = '正在注册供应商并使用系统环境变量中的凭据…'
      useExisting.disabled = true
      let result = null
      try {
        result = await runConnectFlow({
          post: viewPost(ctx),
          useExistingCredential: true,
          configVersion: currentConfigVersion(),
          overrides: { id: idInput.value.trim(), baseUrl: baseInput.value.trim(), apiKeyEnv: envInput.value.trim() },
        })
      } catch (e) {
        result = { ok: false, failedStep: 'unknown', failedCode: (e && e.message) ? String(e.message) : 'connect_flow_failed', steps: [] }
      } finally {
        useExisting.disabled = false
        useExisting.removeAttribute('aria-busy')
      }
      renderFlowResult(resultHost, result)
      if (result && result.ok) { try { toast('连接已就绪', 'success') } catch { /* 无 toast 环境 */ } }
    })
    return card('连接 OpenCode Go',
      '系统中已存在可用的 OpenCode Go 凭据；ModelGate 直接从环境变量读取，不会写入或显示 Key 值。',
      h('div', { class: 'page-stack' },
        callout('good',
          h('strong', { text: '已检测到：' }), existing.label,
          ' —— 无需粘贴 Key。网关在每次请求时从环境变量读取，Key 不进入配置、不进入日志、不回显。'),
        h('div', { class: 'toolbar' }, useExisting),
        manualBox,
        advanced,
        next,
        resultHost))
  }

  submit.addEventListener('click', async () => {
    error.textContent = ''
    live.textContent = ''
    const raw = String(input.value == null ? '' : input.value)
    if (!raw.trim()) {
      error.textContent = '请输入 OpenCode Go API Key'
      try { input.focus() } catch { /* 无 DOM 焦点 API 时忽略 */ }
      return
    }
    // 提交瞬间清空输入框：Key 不再留在 DOM 里（不回显、不持久化、不进 URL/日志）。
    input.value = ''
    submit.disabled = true
    submit.setAttribute('aria-busy', 'true')
    submit.textContent = '连接中…'
    live.textContent = '正在注册供应商并保存 Key…'
    let result = null
    try {
      result = await runConnectFlow({
        post: viewPost(ctx),
        key: raw.trim(),
        configVersion: currentConfigVersion(),
        overrides: {
          id: idInput.value.trim(),
          baseUrl: baseInput.value.trim(),
          apiKeyEnv: envInput.value.trim(),
        },
      })
    } catch (e) {
      result = {
        ok: false,
        failedStep: 'unknown',
        failedCode: (e && e.message) ? String(e.message) : 'connect_flow_failed',
        steps: [],
      }
    } finally {
      submit.disabled = false
      submit.removeAttribute('aria-busy')
      submit.textContent = '连接 OpenCode Go'
    }
    renderFlowResult(resultHost, result)
    const summary = partialStateMessage(result)
    live.textContent = summary.label + '：' + summary.text
    if (result.ok) {
      toast('OpenCode Go 已接入，模型目录已同步', 'success')
      await refreshAll(ctx)
      goToStep('model')
      return
    }
    if (result.failedStep === 'sync') {
      const retry = h('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '只重试同步',
        onclick: async () => {
          retry.disabled = true
          retry.textContent = '同步中…'
          const again = await runConnectFlow({ post: viewPost(ctx), from: 'sync', prior: result })
          retry.remove()
          renderFlowResult(resultHost, again)
          live.textContent = partialStateMessage(again).text
          if (again.ok) {
            toast('模型目录已同步', 'success')
            await refreshAll(ctx)
            goToStep('model')
          } else {
            retry.disabled = false
            retry.textContent = '只重试同步'
            resultHost.append(retry)
          }
        },
      })
      resultHost.append(retry)
    } else if (result.failedStep === 'key') {
      resultHost.append(h('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '重新输入 Key 后保存',
        onclick: () => { try { input.focus() } catch {} },
      }))
    }
  })

  const stateCallout = !product
    ? callout('info',
      h('strong', { text: '正在读取真实状态。' }),
      ' 表单可以填写，但页面不会在取得真实快照前显示任何成功结论。')
    : (product.go && product.go.credentialPresent
        ? callout('info',
          h('strong', { text: '已检测到 OpenCode Go Key。' }),
          ' 重新填写会覆盖本机已保存的 Key；不填写也不会丢。')
        : null)

  return card('连接 OpenCode Go', '普通接入只需要一个 OpenCode Go API Key；供应商、端点与 ' + GO_TARGET_LABEL + ' 由 ModelGate 自动配置。',
    h('div', null,
      stateCallout,
      keyField,
      h('div', { class: 'toolbar', style: { marginTop: '4px' } }, submit),
      live,
      h('p', { class: 'hint', text: '不会发起任何模型推理请求；同步只读取模型清单。' }),
      resultHost,
      next,
      advanced))
}

// —— 步骤 2：模型发现结果 ——
function modelPanel (ctx) {
  const snapshot = aggregationOf(ctx)
  const health = snapshot && snapshot.health ? snapshot.health : null
  const body = h('div')
  const live = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' })
  const models = snapshot && snapshot.models ? snapshot.models : null
  const diagnostics = snapshot && snapshot.diagnostics ? snapshot.diagnostics : null

  if (!snapshot) {
    body.append(
      callout('info',
        h('strong', { text: '正在读取真实的模型发现结果。' }),
        ' 状态层还没有返回聚合快照；这里不会显示"0 个模型"，也不会显示成功。'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
    return card('确认 ' + GO_TARGET_LABEL, '发现结果只来自真实同步快照。', h('div', null, body, live))
  }

  const summary = summarizeDiscovery(diagnostics, models)
  const target = targetModelOf(models)
  const mode = health && health.mode ? String(health.mode) : 'unknown'

  body.append(
    callout(summary.kind === 'bad' ? 'danger' : summary.kind === 'warn' ? 'warn' : 'info',
      h('strong', { text: summary.label + '：' }), ' ' + summary.detail),
    h('div', { class: 'toolbar', style: { margin: '2px 0 10px' } },
      tag(summary.countText || '数量未知（不按 0 显示）', summary.kind),
      tag('状态 ' + summary.state, 'muted')),
    target
      ? callout('good',
        h('strong', { text: '已发现目标模型：' }), GO_TARGET_LABEL,
        h('p', { class: 'hint', text: '模型身份由 ModelGate 统一发布；具体公共 ID 只在高级详情里展示。' }))
      : callout('warn',
        h('strong', { text: '没有找到目标模型：' }), GO_TARGET_LABEL,
        ' 这不等于模型数量为 0：请先确认同步是否完成，或检查 Key 是否有效。'),
    h('div', { class: 'toolbar' },
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '重新同步模型目录',
        onclick: async () => {
          live.textContent = '正在同步模型目录…'
          const result = await runConnectFlow({ post: viewPost(ctx), from: 'sync' })
          live.textContent = partialStateMessage(result).text
          if (result.ok) { toast('模型目录已同步', 'success'); await refreshAll(ctx) }
          else toast(partialStateMessage(result).text, 'error')
        },
      }),
      h('button', { class: 'btn btn-sm', type: 'button', text: '查看高级诊断', onclick: () => { try { location.hash = '#/aggregation' } catch {} } })),
    live)

  if (mode === 'aggregated') body.append(callout('info', h('strong', { text: '聚合模式已启用。' }), ' 目标模型已写入 Codex 配置；如需确认重启状态请进入「重新打开 Codex」。'))

  return card('确认 ' + GO_TARGET_LABEL,
    '目标模型固定为 ' + GO_TARGET_LABEL + '（上游模型 ' + GO_TARGET_UPSTREAM + '）；不要求你理解或手写模型 ID。',
    body)
}

// —— 步骤 3：预览 + 一次确认 ——
function diffKind (kind) {
  if (kind === 'remove' || kind === 'delete' || kind === 'del') return { text: '删除', tone: 'bad' }
  if (kind === 'add') return { text: '新增', tone: 'info' }
  if (kind === 'replace') return { text: '覆盖', tone: 'warn' }
  return { text: '不变', tone: 'muted' }
}

function diffTable (rows) {
  return table([
    { label: '字段', render: (r) => h('span', { class: 'mono', text: r.path }) },
    { label: '变更', render: (r) => { const k = diffKind(r.kind); return tag(k.text, k.tone) } },
    { label: '当前值', render: (r) => h('span', { class: 'mono-break muted', text: r.from == null ? '—（文件中没有）' : r.from }) },
    { label: '写入后', render: (r) => h('span', { class: 'mono-break', text: r.to == null ? '—（删除该字段）' : r.to }) },
  ], rows)
}

function renderConflict (host, outcome, ctx) {
  const tw = outcome.threeWay || describeThreeWay(outcome)
  const child = String(outcome.code || '').indexOf('agent_child') !== -1
  clear(host)
  host.append(
    callout('warn',
      h('strong', { text: '拒绝覆盖：' }),
      ' ' + (child
        ? '原生子代理文件 go-deepseek.toml 不是 ModelGate 写入的规范内容（或接入后被你改过）。ModelGate 保留你的改动，不会覆盖；请手工合并或移走该文件后重试。'
        : 'Codex 配置在预览后被其他程序修改过。ModelGate 保留你的改动，不会为了启用聚合而覆盖。')),
    h('p', { class: 'hint', text: tw.summary }),
    tw.available && tw.rows.length
      ? table([
        { label: '行', render: (r) => h('span', { class: 'mono', text: String(r.afterNo == null ? r.beforeNo : r.afterNo) }) },
        { label: '差异', render: (r) => tag(r.kind === 'add' ? '新增' : r.kind === 'del' ? '删除' : '修改', r.kind === 'del' ? 'bad' : r.kind === 'add' ? 'info' : 'warn') },
        { label: '当前内容', render: (r) => h('span', { class: 'mono-break', text: r.text || '' }) },
      ], tw.rows)
      : h('p', { class: 'muted', text: tw.summary }),
    h('p', { class: 'hint', text: tw.guidance || '先手工合并，再重新检测。' }),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
}

function renderPreview (host, outcome, ctx, live, meta) {
  const s = outcome.summary
  const m = meta || {}
  const removeCount = s.changeRows.filter((r) => r.kind === 'remove' || r.kind === 'delete' || r.kind === 'del').length
  const confirm = h('button', { class: 'btn btn-primary', type: 'button', text: '确认写入并验证' })
  if (!s.consentToken) confirm.disabled = true
  const body = h('div', null,
    callout('info',
      h('strong', { text: '即将更新 Codex 接入设置，请先确认：' }),
      ' 只写 ModelGate 拥有的字段；其它行（MCP / projects / 权限 / 注释 / 你自己的 [model_providers.*]）逐字节保留。这次预览没有写入任何内容。'),
    s.firstRun ? callout('warn', h('strong', { text: '首次设置：' }), ' 会在 Codex 用户级配置中新增下面这些字段。') : null,
    s.blocked.length
      ? callout('danger', h('strong', { text: '前置条件未满足：' }), s.blocked.map((b) => ((b && b.message) || (b && b.code) || 'blocked')).join(' '))
      : null,
    s.agentChild && s.agentChild.action !== 'none'
      ? callout('info', h('strong', { text: '原生子代理配置：' }),
        (s.agentChild.action === 'create' ? '将新建 ' + s.agentChild.fileName :
          s.agentChild.action === 'same' ? s.agentChild.fileName + ' 已存在且内容规范（保持不动）' :
            s.agentChild.action === 'conflict' ? s.agentChild.fileName + ' 与托管内容不一致，需先人工处理' :
              '将更新 ' + s.agentChild.fileName) +
        '。这是 Codex 原生父子代理配置，退出聚合时按托管语义自动恢复；不启用任何自造调度。')
      : null,
    s.conflicts.length ? callout('warn', h('strong', { text: '将覆盖 ' + s.conflicts.length + ' 个已有值：' }), s.conflicts.join('、')) : null,
    removeCount ? callout('warn', h('strong', { text: '将删除 ' + removeCount + ' 个字段：' }), ' 例如切到路由模式删除 openai_base_url；删除行已在差异表标为「删除」。') : null,
    s.consentToken ? null : callout('warn', h('strong', { text: '缺少确认令牌：' }), ' 服务端没有返回 consentToken，无法安全写入；请重新检测后再预览。'),
    diffTable(s.changeRows),
    h('p', { class: 'hint', text: '备份：' + (s.backupAvailable ? '写入前快照可用（失败可自动回滚）' : '无（当前文件不存在或尚未接入，失败将保持原样）') }),
    s.warnings.length ? callout('warn', h('strong', { text: '注意：' }), s.warnings.join(' ')) : null,
    s.catalog ? h('p', { class: 'hint', text: '目录：' + (s.catalog.ok ? (s.catalog.modelCount + ' 个模型（含目标模型）') : ('当前不可用（' + (s.catalog.state || '未知') + '）：' + (s.catalog.reason || ''))) }) : null,
    h('p', { class: 'hint', text: '写入后自动验证：配置解析 + 目录含目标模型 + 网关 /healthz；任一项失败会自动回滚到写入前字节。' }),
    h('div', { class: 'toolbar' }, confirm,
      h('button', { class: 'btn', type: 'button', text: '取消（不写入）', onclick: () => { clear(host); host.append(callout('info', h('strong', { text: '已取消：' }), ' 没有写入任何配置。')) } })))
  clear(host)
  host.append(body)

  confirm.addEventListener('click', async () => {
    if (!s.consentToken) return
    confirm.disabled = true
    confirm.textContent = '写入并验证中…'
    live.textContent = '正在写入并验证 Codex 配置…'
    try {
      let endpoint = AGGREGATION_ENDPOINTS.activate
      let payload = buildActivateRequest(outcome.preview, true)
      if (m.kind === 'switch') {
        endpoint = AGGREGATION_ENDPOINTS.switch
        payload = buildSwitchRequest(outcome.preview, true, m.selection && m.selection.mode, m.selection && m.selection.parentModel)
      } else if (m.kind === 'rollback') {
        endpoint = AGGREGATION_ENDPOINTS.rollback
        payload = buildRollbackRequest(outcome.preview, true)
      }
      const res = await viewPost(ctx)(endpoint, payload)
      showActivationOutcome(host, classifyActivation(res), ctx, live, m)
    } catch (error) {
      showActivationOutcome(host, classifyActivation(error), ctx, live, m)
    }
  })
}

function showActivationOutcome (host, outcome, ctx, live, meta) {
  const m = meta || {}
  if (outcome.kind === 'preview') {
    renderPreview(host, outcome, ctx, live, m)
    return
  }
  if (outcome.kind === 'conflict') {
    live.textContent = '配置已被其他程序修改：没有写入，也不会覆盖。'
    renderConflict(host, outcome, ctx)
    return
  }
  if (outcome.kind === 'blocked') {
    const rows = outcome.blocked.map((b) => h('div', { class: 'list-row' },
      h('div', { class: 'grow' }, h('div', { class: 'primary', text: (b && b.code) || 'blocked' }), h('div', { class: 'secondary', text: (b && (b.message || b.detail)) || '' }))))
    clear(host)
    live.textContent = '接入被前置条件阻止：没有写入。'
    host.append(
      callout('danger', h('strong', { text: '接入被阻止（未写入）：' }), ' 先满足下列前置条件再重试；ModelGate 不会跳过检查。'),
      rows.length ? h('div', { class: 'list' }, rows) : null,
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
    return
  }
  if (outcome.kind === 'applied') {
    const r = receiptSummary(outcome.receipt)
    const isModeChange = m.kind === 'switch' || m.kind === 'rollback'
    const title = isModeChange ? '接入方式已切换并通过验证。' : '聚合模式已启用并通过验证。'
    clear(host)
    live.textContent = title
    host.append(
      callout('good',
        h('strong', { text: title }),
        r.catalogCount == null ? '' : ' 目录 ' + r.catalogCount + ' 个模型（含目标模型）。',
        r.gatewayStatus == null ? '' : ' 网关 HTTP ' + r.gatewayStatus + '。'),
      callout('warn', h('strong', { text: '请完全退出并重新打开 Codex 才能使用新模式。' }), ' 运行中的 Codex 仍读取旧配置；不会"立即生效"。'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '下一步：重新打开 Codex', onclick: () => goToStep('restart') })))
    toast(title, 'success')
    refreshAll(ctx)
    return
  }
  clear(host)
  live.textContent = '启用失败：' + (outcome.code || '未知错误')
  host.append(
    callout('danger',
      h('strong', { text: '启用失败（未写入或已回滚）：' }),
      ' ' + (outcome.message || outcome.code || '未知错误'),
      h('p', { class: 'hint', text: '失败不会被显示成成功；可重新预览后重试。' })),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
}

// 三模式切换（直连/路由/聚合）：无 token → 428 预览 → 一次确认 → 带 token 提交。
async function runModeChange (ctx, kind, selection, host, live) {
  const endpoint = kind === 'switch' ? AGGREGATION_ENDPOINTS.switch : AGGREGATION_ENDPOINTS.rollback
  const body = kind === 'switch'
    ? buildSwitchRequest(null, false, selection && selection.mode, selection && selection.parentModel)
    : buildRollbackRequest(null, false)
  live.textContent = '正在生成接入方式变更预览（不写入）…'
  try {
    const res = await viewPost(ctx)(endpoint, body)
    showActivationOutcome(host, classifyActivation(res), ctx, live, { kind, selection })
  } catch (error) {
    showActivationOutcome(host, classifyActivation(error), ctx, live, { kind, selection })
  }
}

// —— 落地页：直连 / 路由 / 聚合三模式连接中枢（参考图）——
// 纯 DOM 构造，不触碰凭据：Provider/Model 下拉只有展示名与父模型 id，不含任何 Key 输入框。
function landingPanel (ctx, product) {
  const snapshot = aggregationOf(ctx)
  const health = snapshot && snapshot.health ? snapshot.health : null
  const rawMode = health && health.mode ? String(health.mode) : 'unknown'
  const currentMode = THREE_MODES.some((m) => m.id === rawMode) ? rawMode : 'official'
  const drifted = !!(health && health.drifted === true) || !!(snapshot && snapshot.drifted === true)
  const parents = selectableParentModels(snapshot && snapshot.modes)
  const live = h('p', { class: 'mode-live hint', role: 'status', 'aria-live': 'polite' })
  const cards = {}
  const segEls = {}
  const wrap = h('div', { class: 'mode-landing' })

  // 顶部 segmented：点某段高亮对应卡片（不触发写入，写入只由卡片主按钮完成）。
  const bar = h('div', { class: 'mode-segmented', role: 'tablist', 'aria-label': '连接模式' })
  for (const seg of SEGMENT_SPECS) {
    const base = 'mode-seg mode-seg-' + seg.mode
    const btn = h('button', {
      class: base, type: 'button', role: 'tab', 'aria-selected': 'false',
      'data-mode': seg.mode, text: seg.label,
    })
    segEls[seg.mode] = btn
    bar.append(btn, h('span', { class: 'mode-seg-divider', 'aria-hidden': 'true' }))
  }
  // 去掉最后一条分隔线（三选二）。
  const dividers = Array.from(bar.children).filter((c) => c && c.className === 'mode-seg-divider')
  if (dividers.length) dividers[dividers.length - 1].remove()
  wrap.append(bar)

  // 漂移：端点全部 200，单独提示"需要重新对齐"，不显示"读取失败"。
  if (drifted) {
    wrap.append(callout('warn',
      h('strong', { text: '配置需要重新对齐：' }),
      ' 聚合状态已正常读取，当前 config.toml 与对齐基线不一致。请点「重新对齐配置」只更新 state，不改配置内容；对齐后卡片按钮自动恢复可用。',
      h('div', { class: 'toolbar', style: { marginTop: '8px' } },
        h('button', {
          class: 'btn btn-primary', type: 'button', text: '重新对齐配置',
          onclick: () => beginReconcile(ctx),
        }))))
  }

  const grid = h('div', { class: 'mode-cards' })

  const cardFrame = (spec) => {
    const head = h('div', { class: 'mode-card-head' },
      h('span', { class: 'mode-icon mode-icon-' + spec.tone, text: spec.icon, 'aria-hidden': 'true' }),
      h('div', { class: 'mode-card-heading' },
        h('h3', { class: 'mode-card-title', text: spec.title }),
        h('p', { class: 'mode-card-sub', text: spec.subtitle })))
    const body = h('div', { class: 'mode-card-body' })
    const foot = h('div', { class: 'mode-card-foot' })
    const host = h('div', { class: 'mode-card-result' })
    const card = h('article', {
      class: 'mode-card mode-card-' + spec.tone, 'data-mode': spec.mode,
    }, head, body, foot, host)
    cards[spec.mode] = card
    return { card, head, body, foot, host }
  }
  const ctaButton = (spec, host, selection) => {
    const btn = h('button', {
      class: 'btn mode-cta mode-cta-' + spec.tone, type: 'button', text: spec.cta,
      disabled: drifted,
    })
    if (drifted) btn.title = '请先重新对齐配置后再切换接入方式'
    btn.addEventListener('click', () => runModeChange(ctx, 'switch', selection, host, live))
    return btn
  }

  // 1) 直连：Provider ChatGPT 官方 / Model GPT-6 Luna；状态来自 official 只读探测。
  const direct = cardFrame(MODE_CARD_SPECS[0])
  const officialState = product && product.official ? String(product.official.state || '') : ''
  const officialLabel = officialState === 'detected' ? '官方登录正常'
    : officialState === 'missing' ? '待登录'
      : officialState === 'blocked' ? '登录状态待确认'
        : '官方登录状态未知'
  const providerSelect = h('select', { 'aria-label': 'Provider' },
    h('option', { value: 'chatgpt-official', text: 'ChatGPT 官方', selected: true }))
  const parentSelect = h('select', { 'aria-label': 'Model' },
    ...parents.map((p) => h('option', {
      value: p.id, text: friendlyParentLabel(p.id), selected: p.id === DEFAULT_PARENT_MODEL,
    })))
  direct.body.append(
    field('Provider', providerSelect),
    field('Model', parentSelect),
    h('div', { class: 'mode-status' },
      h('span', { class: 'mode-status-dot' + (officialState === 'detected' ? ' is-good' : ''), text: '● ' }),
      h('span', { class: 'mode-status-text', text: officialLabel })))
  direct.foot.append(ctaButton(MODE_CARD_SPECS[0], direct.host, { mode: 'official', parentModel: null }),
    h('p', { class: 'mode-footnote', text: MODE_CARD_SPECS[0].footnote }))
  grid.append(direct.card)

  // 2) 路由：固定 OpenCode Go / deepseek-v4.1-flash；测试连接走网关 /healthz（纯只读）。
  const route = cardFrame(MODE_CARD_SPECS[1])
  const routeProvider = h('select', { 'aria-label': 'Provider' },
    h('option', { value: 'opencode-go', text: 'OpenCode Go', selected: true }))
  const routeModel = h('select', { 'aria-label': 'Model' },
    h('option', { value: 'deepseek-v4.1-flash', text: 'deepseek-v4.1-flash', selected: true }))
  const statusDot = h('span', { class: 'mode-status-dot' + (health ? ' is-good' : ''), text: '● ' })
  const statusText = h('span', { class: 'mode-status-text', text: health ? '网关运行中' : '网关状态未知' })
  const testBtn = h('button', {
    class: 'btn btn-sm mode-test', type: 'button', text: '测试连接',
    onclick: async () => {
      testBtn.disabled = true
      testBtn.textContent = '测试中…'
      try {
        await request('/healthz', { timeoutMs: 5000 })
        statusDot.className = 'mode-status-dot is-good'
        statusText.textContent = '网关运行中'
        try { toast('网关运行中：/healthz 返回正常', 'success') } catch { /* 无 toast 环境 */ }
      } catch (e) {
        statusDot.className = 'mode-status-dot is-bad'
        statusText.textContent = '网关不可用'
        try { toast('网关不可用：' + (e && e.message ? e.message : '未知错误'), 'error') } catch { /* 无 toast 环境 */ }
      } finally {
        testBtn.disabled = false
        testBtn.textContent = '测试连接'
      }
    },
  })
  route.body.append(
    field('Provider', routeProvider),
    field('Model', routeModel),
    h('div', { class: 'mode-status' }, statusDot, statusText, testBtn))
  route.foot.append(
    ctaButton(MODE_CARD_SPECS[1], route.host, { mode: 'route', parentModel: null }),
    h('a', { class: 'mode-link', href: '#/aggregation', text: '高级路由设置 ›' }),
    h('p', { class: 'mode-footnote', text: MODE_CARD_SPECS[1].footnote }))
  grid.append(route.card)

  // 3) 聚合：ChatGPT 官方（已保留）+ OpenCode Go 子代理；父模型可改但标 UNVERIFIED。
  const aggregate = cardFrame(MODE_CARD_SPECS[2])
  const aggState = h('span', { class: 'mode-agg-state', text: '● 待启用' })
  if (drifted) aggState.textContent = '● 需要重新对齐'
  else if (currentMode === 'aggregated') aggState.textContent = '● 已启用'
  else if (!snapshot) aggState.textContent = '● 状态未知'
  aggregate.head.append(h('div', { class: 'mode-card-actions' }, aggState))
  const aggregateSelection = { mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL }
  const aggParent = h('select', { 'aria-label': 'GPT 父模型' },
    ...parents.map((p) => h('option', {
      value: p.id, text: friendlyParentLabel(p.id), selected: p.id === DEFAULT_PARENT_MODEL,
    })))
  // 对象引用在点击时读取，保证"改父模型后启用"提交的是当前选项。
  aggParent.addEventListener('change', () => { aggregateSelection.parentModel = aggParent.value })
  aggregate.body.append(
    h('div', { class: 'mode-kv' },
      h('span', { text: MODE_CARD_SPECS[2].rows[0] }),
      h('span', { class: 'mode-badge', text: '已保留' })),
    h('div', { class: 'mode-kv' }, h('span', { text: MODE_CARD_SPECS[2].rows[1] })),
    field('GPT 父模型', aggParent, {
      help: '只有 gpt-6-luna 已签收/PASS_REAL；其它订阅内 GPT 父模型为未验证（UNVERIFIED）。',
    }),
    h('span', { class: 'mode-tagline', text: MODE_CARD_SPECS[2].tagline }))
  aggregate.foot.append(
    ctaButton(MODE_CARD_SPECS[2], aggregate.host, aggregateSelection),
    h('p', { class: 'mode-footnote', text: MODE_CARD_SPECS[2].footnote }))
  grid.append(aggregate.card)
  wrap.append(grid)

  // segment → 卡片高亮/滚动（不写入）；聚合卡片的主按钮在点击时才读取当前父模型。
  const activate = (target) => {
    for (const seg of SEGMENT_SPECS) {
      const btn = segEls[seg.mode]
      const on = seg.mode === target
      btn.className = 'mode-seg mode-seg-' + seg.mode + (on ? ' is-active' : '')
      btn.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    for (const spec of MODE_CARD_SPECS) {
      const card = cards[spec.mode]
      card.className = 'mode-card mode-card-' + spec.tone + (spec.mode === target ? ' is-selected' : '')
    }
    const card = cards[target]
    if (card && typeof card.scrollIntoView === 'function') {
      try { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch { /* 非浏览器 */ }
    }
  }
  for (const seg of SEGMENT_SPECS) segEls[seg.mode].addEventListener('click', () => activate(seg.mode))
  activate(currentMode)

  wrap.append(live,
    h('div', { class: 'mode-landing-foot' },
      h('span', { class: 'hint', text: '切换后请完全退出并重新打开 Codex 才生效。' }),
      h('button', {
        class: 'btn btn-sm', type: 'button', text: '需要填 Key？进入接入向导 ›',
        onclick: () => goToStep('key'),
      })))
  return { node: wrap, select: activate, cards }
}

function enablePanel (ctx) {
  const snapshot = aggregationOf(ctx)
  const health = snapshot && snapshot.health ? snapshot.health : null
  const mode = health && health.mode ? String(health.mode) : 'unknown'
  const known = THREE_MODES.some((mm) => mm.id === mode)
  const drifted = !!(health && health.drifted === true)
  const m = modeLabel(known ? mode : 'unknown', drifted)
  const parents = selectableParentModels(snapshot && snapshot.modes)
  // 仅当 modes/switch 端点缺失时禁用三模式切换；其它只读接口失败不影响这里的可点性。
  const modeSwitchUnavailable = !!(snapshot && snapshot.modesUnavailable === true)
  const host = h('div')
  const live = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' })

  const switchBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '切换接入方式' })
  switchBtn.disabled = !snapshot || modeSwitchUnavailable || drifted
  const chooser = modeChooser({
    current: known ? mode : 'official', parents,
    onChange: (sel) => { switchBtn.disabled = !snapshot || modeSwitchUnavailable || drifted || sel === mode },
  })
  switchBtn.disabled = !snapshot || modeSwitchUnavailable || drifted || chooser.getSelection().mode === mode
  switchBtn.addEventListener('click', () => runModeChange(ctx, 'switch', chooser.getSelection(), host, live))

  const canRollback = !!(snapshot && !modeSwitchUnavailable && (mode === 'aggregated' || mode === 'route'))
  const rollbackBtn = h('button', { class: 'btn', type: 'button', text: '回到上一模式', disabled: !canRollback, onclick: () => runModeChange(ctx, 'rollback', null, host, live) })

  host.append(
    snapshot
      ? (known
        ? callout('info', h('strong', { text: '当前接入方式：' + m.label + '。' }), ' 选择目标方式后点「切换接入方式」；预览不写任何字节，确认后才写入。')
        : callout('warn', h('strong', { text: '接入方式未知。' }), ' 服务端没有返回可识别模式；预览会重新检测，不会盲目写入。'))
      : callout('info', h('strong', { text: '正在读取真实聚合状态。' }), ' 快照到达前不会推测是否已启用，也不会写入任何配置。'))
  // 漂移阻断的 GUI 解法：服务端 /switch 会 409，先在界面里给出「重新对齐配置」入口。
  if (drifted) {
    host.append(callout('warn',
      h('strong', { text: '检测到配置漂移：' }),
      ' 服务端会拒绝切换（409）。请先「重新对齐配置」：采纳当前配置作为新基线，只更新 state、不改 config.toml 内容、不切模式；成功后切换按钮自动恢复可用。',
      h('div', { class: 'toolbar', style: { marginTop: '8px' } },
        h('button', { class: 'btn btn-primary', type: 'button', text: '重新对齐配置', onclick: () => beginReconcile(ctx) }))))
  }

  return card('选择接入方式', '官方直连 / 路由（纯 DeepSeek）/ 聚合（GPT 父 + DeepSeek 子）；切换前预览，确认后一次写入。',
    h('div', null,
      callout('info',
        h('strong', { text: '一次性确认：' }),
        ' 只改 ModelGate 拥有的键；不编辑 TOML、不碰 auth.json。切换成功后请完全退出并重新打开 Codex 才能使用新模式，不会"立即生效"。'),
      chooser.node,
      h('div', { class: 'toolbar', style: { margin: '10px 0' } }, switchBtn, rollbackBtn),
      live,
      host))
}

// —— 步骤 4：重启 ——
function restartPanel (ctx) {
  const snapshot = aggregationOf(ctx)
  const health = snapshot && snapshot.health ? snapshot.health : null
  const mode = health && health.mode ? String(health.mode) : 'unknown'
  const restart = health
    ? (health.restart || (health.activation && health.activation.restart) || (health.detect && health.detect.restart) || null)
    : null
  const body = h('div')
  if (!health) {
    body.append(
      callout('info',
        h('strong', { text: '正在读取 Codex 探测结果。' }),
        ' 未取得 health.detect.restart 前，不判断是否已重启，也不说"已生效"。'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
    return card('重新打开 Codex', '重启结论只来自真实进程探测。', body)
  }
  if (!THREE_MODES.some((mm) => mm.id === mode)) {
    body.append(
      callout('warn',
        h('strong', { text: '无法确认是否需要重启：' }),
        ' 服务端没有返回可识别的接入方式；不把它当成"无需重启"。'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
    return card('重新打开 Codex', '重启结论只来自真实进程探测。', body)
  }
  const notice = restartNotice(restart, mode)
  const needs = notice.needed === true
  const modelHint = mode === 'aggregated'
    ? '核对官方 GPT 与 ' + GO_TARGET_LABEL + ' 都能被选中。'
    : mode === 'route'
      ? '核对路由模型 ' + GO_TARGET_LABEL + ' 被选中（纯 DeepSeek，无 GPT 调用）。'
      : '核对官方 GPT 模型可用（已切回官方直连）。'
  body.append(
    callout(needs ? 'warn' : 'good', h('strong', { text: notice.label + '：' }), ' ' + notice.detail),
    callout('warn', h('strong', { text: '请完全退出并重新打开 Codex 才能使用新模式。' }), ' 运行中的 Codex 仍读取旧配置；退出后也要重启。'),
    h('ol', { style: { margin: '6px 0 0 18px', padding: '0' } },
      h('li', { text: '完全退出 Codex Desktop（不是只关窗口）。' }),
      h('li', { text: '重新打开 Codex Desktop，进入一个新会话。' }),
      h('li', { text: '在模型选择器里' + modelHint })),
    h('p', { class: 'hint', text: '检测到客户端在写入后启动过时，本页提示会自动消失；如果一直提示，说明检测到的仍是旧进程。' }),
    h('p', { class: 'hint', text: 'ModelGate 不会也不能替你启动或重启 Codex Desktop（没有受支持的启动能力，也不提供假按钮）。' }),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn btn-sm', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) }),
      h('button', { class: 'btn btn-sm', type: 'button', text: '下一步：在 Codex 中使用', onclick: () => goToStep('use') })))
  return card('重新打开 Codex', '配置写入后，运行中的 Codex 仍在使用旧配置。',
    body,
    { foot: needs ? '未检测到重启：不会显示"已生效"' : '已检测到重启：新配置已加载' })
}

// —— 步骤 5：使用 ——
function usePanel (ctx, product) {
  const codex = product && product.codex ? product.codex : null
  const snapshot = aggregationOf(ctx)
  const health = snapshot && snapshot.health ? snapshot.health : null
  const mode = health && health.mode ? String(health.mode) : 'unknown'
  const modelLine = mode === 'route'
    ? ' 路由模式只使用 ' + GO_TARGET_LABEL + '（纯 DeepSeek，无 GPT 调用）。'
    : mode === 'official'
      ? ' 官方直连模式使用 Codex 官方模型（不经 ModelGate）。'
      : ' 官方 GPT 模型与 ' + GO_TARGET_LABEL + '。两者都在同一个模型选择器里，不需要改配置文件。'
  return card('在 Codex 中使用', 'ModelGate 已经完成配置；接下来由你在原版 Codex Desktop 里操作。',
    h('div', null,
      callout('info',
        h('strong', { text: '请在原版 Codex Desktop 的模型选择器里选择：' }),
        modelLine),
      h('ol', { style: { margin: '6px 0 0 18px', padding: '0' } },
        h('li', { text: '完全退出并重新打开 Codex Desktop（如果上一步还没做）。' }),
        h('li', { text: '新建会话，打开模型选择器，确认当前接入方式对应的模型存在。' }),
        h('li', { text: '各发一条最小消息；需要核对请求归因时到「查看高级诊断」。' })),
      codex && codex.found
        ? callout('info', h('strong', { text: 'Codex 检测结果：' }), ' ' + (codex.label || '已检测到') + '。' + (codex.detail || ''))
        : callout('warn', h('strong', { text: '未检测到 Codex Desktop。' }), ' 请先安装/打开原版 Codex Desktop；本页不会假装已启动。'),
      h('p', { class: 'hint', text: '本页不声称已自动启动 Codex，也没有"打开 Codex"按钮。' })))
}

// —— 步骤 6：退出并恢复 ——
function revertPanel (ctx) {
  const snapshot = aggregationOf(ctx)
  const health = snapshot && snapshot.health ? snapshot.health : null
  const mode = health && health.mode ? String(health.mode) : 'unknown'
  const activation = health && health.activation ? health.activation : {}
  const expectedSha = activation.appliedSha || (health && health.config && health.config.sha256) || ''
  const host = h('div')
  const live = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' })

  if (!snapshot) {
    host.append(callout('info', h('strong', { text: '正在读取真实聚合状态。' }), ' 快照到达前不会推测是否已启用，也不会写入。'))
  } else if (mode !== 'aggregated') {
    host.append(callout('info', h('strong', { text: '当前不是聚合模式。' }), ' 没有需要撤销的 ModelGate 改动；如果确实需要修复，请到高级诊断核对。'))
  } else {
    const btn = h('button', { class: 'btn btn-danger', type: 'button', text: '退出并恢复' })
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '退出聚合模式并恢复配置',
        message: '将把 ModelGate 改过的字节恢复到接入前的快照。期间如果你手工改过配置，会返回 409 + 三方差异，不会覆盖。',
        confirmLabel: '退出并恢复',
        danger: true,
      })
      if (!ok) return
      btn.disabled = true
      btn.textContent = '正在恢复…'
      live.textContent = '正在退出聚合并验证恢复…'
      try {
        const res = await viewPost(ctx)(AGGREGATION_ENDPOINTS.deactivate, buildDeactivateRequest(expectedSha))
        const r = receiptSummary(res)
        clear(host)
        live.textContent = '已退出聚合模式。'
        host.append(
          callout('good',
            h('strong', { text: '已退出聚合模式。' }),
            r.preservedUserEdits
              ? ' 只撤销了 ModelGate 自有键；接入后你新增/修改的其它配置已保留。'
              : ' 配置已恢复到接入前。'),
          r.reloadApplied
            ? callout('info', h('strong', { text: '网关进程已重载。' }), ' 如需完全回到官方模式，请完全退出并重新打开 Codex Desktop。')
            : callout('warn', h('strong', { text: '配置已恢复，但网关进程没有重载：' }), ' 需要重启网关后才会按恢复后的配置工作。'),
          h('div', { class: 'toolbar' },
            h('button', { class: 'btn btn-sm', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
        toast('已退出聚合模式', 'success')
        refreshAll(ctx)
      } catch (error) {
        const out = classifyActivation(error)
        if (out.kind === 'conflict') {
          clear(host)
          live.textContent = '退出被拒绝：配置已被修改，未覆盖。'
          renderConflict(host, out, ctx)
          return
        }
        clear(host)
        live.textContent = '退出失败：' + (out.code || '未知错误')
        host.append(
          callout('danger',
            h('strong', { text: '退出失败（未覆盖任何内容）：' }),
            ' ' + (out.message || out.code || '未知错误')),
          h('div', { class: 'toolbar' },
            h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) })))
      } finally {
        btn.disabled = false
        btn.textContent = '退出并恢复'
      }
    })
    host.append(
      callout('info',
        h('strong', { text: '无损退出：' }),
        ' 只回滚 ModelGate 改过的字节，不碰 auth.json、不删你的登录、不改其它配置。'),
      h('div', { class: 'toolbar' }, btn))
  }
  return card('退出并恢复', '把 Codex 配置恢复到接入前；冲突时只展示三方差异，不强制覆盖。', h('div', null, host, live))
}

// —— 分支步骤：冲突 / 未检测到 Codex ——
function conflictPanel (ctx) {
  return card('配置冲突', 'ModelGate 不会覆盖被其他程序修改的配置。',
    h('div', null,
      callout('warn',
        h('strong', { text: '先手工合并，再重新检测。' }),
        ' 启用/退出时如果返回 409，会展示三方差异（基准 / 我们写入 / 当前），并保留你的全部改动。'),
      h('p', { class: 'hint', text: '这里没有"强制覆盖"按钮：覆盖会丢掉你在 Codex 配置里的改动。' }),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => refreshAll(ctx) }),
        h('button', { class: 'btn', type: 'button', text: '查看高级诊断', onclick: () => { try { location.hash = '#/aggregation' } catch {} } }))))
}

function codexGuidePanel (product) {
  return card('找到 Codex Desktop', '需要先有原版 Codex Desktop 才能使用聚合模式。',
    h('div', null,
      callout('info',
        h('strong', { text: 'ModelGate 不会安装或启动 Codex。' }),
        ' 请先在本机安装并打开原版 Codex Desktop，登录 ChatGPT 套餐后再回到本页重新检测。'),
      product && product.codex && product.codex.detail
        ? callout('warn', h('strong', { text: '当前探测结果：' }), ' ' + product.codex.detail)
        : callout('info', h('strong', { text: '尚未取得探测结果。' }), ' 状态层没有返回 Codex 探测；不推断已安装或未安装。'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: () => { goToStep('key') } }))))
}

// —— 高级详情（技术字段只在展开后出现）——
function advancedDetails (ctx, product) {
  const snapshot = aggregationOf(ctx)
  const health = snapshot && snapshot.health ? snapshot.health : null
  const aggView = product && product.aggregation ? product.aggregation : {}
  const activation = health && health.activation ? health.activation : {}
  const backup = health && health.backup ? health.backup : {}
  const publicId = productStatus.GO_PUBLIC_MODEL_ID || ('mg-opencodego-' + GO_TARGET_UPSTREAM.replace(/[^a-z0-9]+/g, '-'))
  const rows = [
    ['供应商 ID', GO_PROVIDER],
    ['preset', PROVIDER_PRESET_ID],
    ['目标公开模型 ID', publicId],
    ['目标上游模型', GO_TARGET_UPSTREAM],
    ['配置版本', String(currentConfigVersion() == null ? '未知' : currentConfigVersion())],
    ['聚合模式', String((health && health.mode) || aggView.mode || '未知')],
    ['接入 SHA', activation.appliedSha ? String(activation.appliedSha).slice(0, 12) : '无记录'],
    ['接入前备份', backup.available ? (backup.path || '可用') + (backup.matches === false ? '（与当前不一致，不可回滚）' : '') : '无'],
    ['最近一次写入', activation.lastApply && activation.lastApply.at ? fmtTime(activation.lastApply.at) + (activation.lastApply.ok ? ' · 成功' : ' · 失败') : '无记录'],
  ]
  return h('details', { class: 'advanced' },
    h('summary', { text: '高级详情（技术字段与诊断）' }),
    h('p', { class: 'hint', text: '默认页面不展示这些字段；排障或核对证据时再展开。' }),
    kvList(rows.map(([k, v]) => [k, h('span', { class: 'mono-break', text: String(v) })])),
    h('p', { class: 'hint', text: '完整诊断长表在' }),
    h('button', {
      class: 'btn btn-sm',
      type: 'button',
      text: '打开聚合详情（高级）',
      onclick: () => { try { location.hash = '#/aggregation' } catch {} },
    }))
}

// —— 渲染入口 ——
export function render (root, ctx = {}) {
  const product = productOf(ctx)
  // 默认落地页是三模式连接中枢；只有显式 ?step=xxx 才进入原接入向导。
  const hash = typeof location !== 'undefined' && location.hash ? String(location.hash) : ''
  const explicit = ctx.step != null && String(ctx.step).trim() ? String(ctx.step).trim() : ''
  const rawStep = explicit || (/[?&]step=/.test(hash) ? stepFromHash(hash) : LANDING_STEP)
  const step = normalizeStep(rawStep, LANDING_STEP)
  const isLanding = step === LANDING_STEP
  root.append(pageHead('连接', isLanding
    ? 'AI 模型网关 · 连接 / 路由 / 聚合。选择直连、路由或聚合，切换后完全退出并重新打开 Codex 才生效。'
    : '连接 OpenCode Go、启用聚合、必要时重新打开 Codex；日常只需要填一个 Key。', {
    eyebrow: 'CONNECTIONS',
    actions: [
      h('button', { class: 'btn', type: 'button', text: '查看高级诊断', onclick: () => { try { location.hash = '#/aggregation' } catch {} } }),
    ],
  }))
  if (isLanding) {
    root.append(landingPanel(ctx, product).node)
  } else {
    root.append(overallCard(product))
    root.append(stepNav(step, ctx))
    const panel = h('div')
    switch (step) {
      case 'model': panel.append(modelPanel(ctx)); break
      case 'enable': panel.append(enablePanel(ctx)); break
      case 'restart': panel.append(restartPanel(ctx)); break
      case 'use': panel.append(usePanel(ctx, product)); break
      case 'revert': panel.append(revertPanel(ctx)); break
      case 'conflict': panel.append(conflictPanel(ctx)); break
      case 'codex': panel.append(codexGuidePanel(product)); break
      case 'key':
      default: panel.append(keyPanel(ctx, product)); break
    }
    root.append(panel)
  }
  root.append(advancedDetails(ctx, product))
  root.append(h('p', { class: 'page-note', text: '本页只使用真实状态快照与同源管理 API；428/409/422 一律如实展示，不伪造成功。契约 ' + CONNECTIONS_VIEW_CONTRACT + '。' }))
}
