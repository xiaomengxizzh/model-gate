// UX-00 / 产品状态投影：把现有只读 API 组合成"用户可以理解"的连接状态。
//
// 契约：docs/contracts/ui-v3-product-status.md（mg-ui-product-status/1）。
// 本文件是**纯函数**（不 import api/store、不读 DOM、不发请求），因此可离线单测，
// 也保证首页（A1）、连接向导（A2）、聚合详情（A2）与状态层（A3）使用同一套判定，
// 不会各自解释 /api/status 而出现"首页说已连接、聚合页说未启用"的不同步。
//
// 诚实性硬规则（不可通过改 UI 绕过）：
//   * 只有真实运行时证据（/api/status.lastServing 命中目标模型）才可标 verified；
//     "检测到登录文件 / 配置里写了模型 / 控制台返回 200" 一律不得升级为 verified。
//   * unknown / missing 不得被渲染成 false / 0 / 健康。
//   * 聚合管理接口 404（旧实例）时状态是 unknown，不是"未启用"。
export const PRODUCT_STATUS_CONTRACT = 'mg-ui-product-status/1'

// 状态等级：来源越靠后，声明的强度越高。UI 必须显示等级，不能只给一个绿点。
export const EVIDENCE_LEVELS = Object.freeze(['detected', 'configured', 'runtime-verified', 'not-tested', 'unknown'])

export const GO_TARGET_MODEL = 'deepseek-v4.1-flash'
export const GO_PROVIDER_ID = 'opencodego'
// 已发布公共 ID 由 stableModelId() 生成：'mg-' + provider 段 + '-' + 模型段（见 src/codex/catalog.js）。
// 这里同时接受历史/协议里出现过的等价写法，避免把"已配置"误判成"未配置"。
export const GO_TARGET_PUBLIC_ID = 'mg-opencodego-deepseek-v4-1-flash'
export const GO_PUBLIC_MODEL_IDS = Object.freeze([GO_TARGET_PUBLIC_ID, 'opencodego/' + GO_TARGET_MODEL, GO_TARGET_MODEL])
export const GO_PUBLIC_MODEL_ID = GO_TARGET_PUBLIC_ID

// 公共 ID 比较必须容错（mg- 前缀、斜杠/点号/大小写），否则真实目录会被读成"目标模型未配置"。
function idKey (value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '')
}
const TARGET_ID_KEYS = new Set(GO_PUBLIC_MODEL_IDS.map(idKey))

export function matchesGoTargetId (value) {
  const key = idKey(value)
  if (!key) return false
  if (TARGET_ID_KEYS.has(key)) return true
  // 'mg-opencodego-<model>' 之外的 provider 段也接受：只要模型段是目标模型。
  return key === 'mgopencodegodeepseekv41flash' || key === 'deepseekv41flash'
}

// 首页状态机（执行计划 §2.1 的 HomeState）。
export const HOME_STATES = Object.freeze([
  'locked', 'loading', 'cannot_detect_codex', 'needs_go_key', 'go_key_invalid',
  'ready_to_enable', 'preview_pending', 'write_in_progress', 'needs_codex_restart',
  'ready', 'conflict', 'recoverable_error', 'read_only_unknown',
  // 聚合管理接口要求显式管理员令牌（403 explicit_admin_required）：这不是"读取失败"，
  // 也不是版本不支持，而是需要先设置令牌才能管理聚合。
  'needs_admin_token',
  // 配置漂移：所有聚合端点都读取成功（200），只是 state 基线落后于 config.toml。
  // 这是"需要重新对齐"，不是"读取失败"，必须与 recoverable_error 分开。
  'needs_realign',
])

const AGGREGATION_PATHS = Object.freeze(['providers', 'models', 'health', 'diagnostics'])

function str (v) {
  return v == null ? '' : String(v).trim()
}

function obj (v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function list (v) {
  return Array.isArray(v) ? v : []
}

// 聚合四接口的错误分类：404/not_mounted = 实例不支持；403 = 权限/来源；其余为可重试错误。
export function classifyAggregationError (error) {
  const e = error || null
  if (!e) return { kind: 'none', status: 0, code: '', message: '' }
  const status = Number(e.status) || 0
  const data = obj(e.data) ? e.data : {}
  const code = str(data.code || e.code)
  const message = str(e.message || data.error || data.message)
  if (status === 404 || code === 'not_mounted' || code === 'aggregation_route_unknown') {
    return { kind: 'unsupported', status, code: code || 'aggregation_route_unknown', message }
  }
  if (status === 401 || status === 403) return { kind: 'denied', status, code, message }
  if (status === 429) {
    // 限流既不是"连不上"也不是"配置错误"：单独分类，保留 Retry-After 供 UI 如实提示。
    const retryAfter = Number(data.retryAfter ?? data.retry_after ?? e.retryAfter)
    return { kind: 'throttled', status, code: code || 'rate_limited', message, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null }
  }
  if (status === 409 || code === 'version_conflict' || code === 'config_conflict') {
    return { kind: 'conflict', status, code, message }
  }
  return { kind: 'error', status, code, message }
}

// ChatGPT 套餐（官方登录）状态：只读探测，绝不含 token。
// 来源 /api/status.official（服务端 probeLocalCodexAuth，只读，不返回凭据）。
export function deriveOfficial (status) {
  const s = obj(status)
  const official = s ? obj(s.official) : null
  if (!official) {
    return {
      state: 'unknown',
      level: 'unknown',
      reason: 'status_official_missing',
      label: '未验证',
      detail: '当前实例的状态接口没有返回本机登录探测结果；不能据此判断 ChatGPT 套餐是否可用。',
      source: '/api/status.official（缺失）',
    }
  }
  const credential = str(official.credential)
  const reason = str(official.reason)
  if (credential === 'detected' && str(official.expiry) === 'expired') {
    return {
      state: 'blocked',
      level: 'detected',
      reason: 'access_token_expired',
      label: '登录已过期',
      detail: '本机登录文件存在，但访问令牌已过期（只读解析 exp，未刷新、未发请求）。请在原版 Codex 中重新登录。',
      source: '/api/status.official → probeLocalCodexAuth + readSubscriptionCredential（只读）',
    }
  }
  if (credential === 'detected') {
    return {
      state: 'detected',
      level: 'detected',
      reason: reason || 'local_codex_chatgpt',
      label: '已检测到本机登录',
      detail: '本机 Codex 登录文件显示 ChatGPT 账号模式（只读探测，未发起任何请求）。这只是"检测到"，不是官方推理已实测。',
      source: '/api/status.official → probeLocalCodexAuth（只读）',
    }
  }
  if (credential === 'missing') {
    const missing = reason === 'auth_file_missing' || reason === 'codex_home_unresolved'
    return {
      state: 'missing',
      level: 'detected',
      reason: reason || 'auth_file_missing',
      label: missing ? '待登录' : '未检测到可用登录',
      detail: missing
        ? '没有找到本机 Codex 登录文件。请先在原版 Codex 中登录 ChatGPT 账号；ModelGate 不会代替你登录。'
        : '本机登录存在但不可用（' + (reason || '原因未知') + '）。请在原版 Codex 中重新登录后刷新。',
      source: '/api/status.official → probeLocalCodexAuth（只读）',
    }
  }
  if (credential === 'blocked') {
    return {
      state: 'blocked',
      level: 'unknown',
      reason: reason || 'official_blocked',
      label: '无法确认',
      detail: '登录探测被阻断：' + (reason || '原因未返回') + '。',
      source: '/api/status.official',
    }
  }
  return {
    state: 'unknown',
    level: 'unknown',
    reason: reason || 'official_probe_unknown',
    label: '未验证',
    detail: '没有取得可判定的登录探测结果（' + (reason || '原因未知') + '）；不把未知显示成"已登录"。',
    source: '/api/status.official',
  }
}

function findGoProvider (aggregation, status) {
  const agg = obj(aggregation) || {}
  const rows = list(agg.providers && agg.providers.providers ? agg.providers.providers : agg.providers)
  for (const p of rows) {
    const kind = str(p && p.kind)
    const id = str(p && p.id)
    if (kind === 'opencode-go' || kind === 'go' || id === GO_PROVIDER_ID || id === 'opencode-go') return p
  }
  // 聚合供应商列表不可用时，回落到 /api/status.providers（同一份配置投影）。
  const sp = list(obj(status) && status.providers).find((p) => str(p && p.id) === GO_PROVIDER_ID)
  return sp || null
}

function hasTargetModel (aggregation, status) {
  const agg = obj(aggregation) || {}
  const rows = list(agg.models && agg.models.models ? agg.models.models : agg.models)
  for (const m of rows) {
    const publicId = str(m && (m.publicId || m.slug || m.id))
    const upstream = str(m && (m.upstreamId || m.model))
    if (matchesGoTargetId(publicId) || matchesGoTargetId(upstream)) return m
  }
  // status.models 是网关真实配置的模型表（name 为公共 ID，alias 为该模型的别名数组）。
  const configured = list(obj(status) && status.models).find((m) => {
    if (matchesGoTargetId(m && m.name)) return true
    const alias = list(m && m.alias)
    return alias.some((a) => matchesGoTargetId(a))
  })
  return configured || null
}

// Go 目标模型是否已有**运行时**证据：只有真实经过网关并命中 Go 供应商的完成请求才算。
function runtimeServingForGo (status, providerId) {
  const s = obj(status)
  const last = s ? obj(s.lastServing) : null
  if (!last) return null
  const provider = str(last.provider)
  const model = str(last.model)
  if (!provider || provider !== providerId) return null
  if (!matchesGoTargetId(model)) return null
  return { at: Number(last.at) || null, provider, model }
}

export function deriveGo (status, aggregation) {
  const unsupported = isAggregationUnsupported(aggregation)
  const provider = findGoProvider(aggregation, status)
  const target = hasTargetModel(aggregation, status)
  const statusProvider = list(obj(status) && status.providers).find((p) => str(p && p.id) === GO_PROVIDER_ID) || null
  const credentialPresent = !!(statusProvider && statusProvider.hasKey)
  const providerId = str(provider && provider.id) || (statusProvider ? GO_PROVIDER_ID : '')
  const discoveryState = str(provider && provider.discoveryState) || ''
  const base = {
    model: GO_TARGET_MODEL,
    publicModelId: GO_PUBLIC_MODEL_ID,
    providerId: providerId || null,
    credentialPresent,
    credentialSource: statusProvider ? str(statusProvider.keySource) || null : null,
    // 凭据变量名只用于告诉用户"正在用哪个环境变量"，绝不读取/回显其值。
    apiKeyEnv: statusProvider ? str(statusProvider.apiKeyEnv) || null : null,
    targetModelConfigured: !!target,
    discoveryState: discoveryState || 'unknown',
    supported: !unsupported,
    level: 'unknown',
    label: '状态未知',
    detail: '',
    source: 'GET /api/aggregation/providers + GET /api/status（hasKey）',
  }
  if (unsupported) {
    return Object.assign(base, {
      state: 'unknown',
      label: '状态未知',
      detail: '当前实例没有聚合管理接口（404），无法判断 Go 连接状态；不显示成"未连接"或"0 个模型"。',
    })
  }
  if (!provider && !statusProvider) {
    const aggDenied = aggregation && aggregation.error && classifyAggregationError(aggregation.error).kind === 'denied'
    return Object.assign(base, {
      state: 'missing',
      level: 'detected',
      label: aggDenied ? '状态未知' : '待连接',
      detail: aggDenied
        ? '聚合管理接口拒绝了本次读取（权限/来源），无法确认 Go 连接状态。'
        : '还没有接入 OpenCode Go。只需要填入 OpenCode Go API Key，ModelGate 会自动配置 ' + GO_TARGET_MODEL + '。',
    })
  }
  if (discoveryState === 'failed') {
    return Object.assign(base, {
      state: 'error',
      level: 'detected',
      label: '连接需要处理',
      detail: '已保存 Go 供应商，但最近一次同步失败。请更新 Key 或重试同步；失败不会被显示成"已连接"。',
    })
  }
  const serving = runtimeServingForGo(status, providerId)
  if (credentialPresent && target && serving) {
    return Object.assign(base, {
      state: 'verified',
      level: 'runtime-verified',
      label: '可用（已实测推理）',
      detail: '网关已完成一次命中 ' + GO_TARGET_MODEL + ' 的真实请求，可用于原版 Codex。',
    })
  }
  if (credentialPresent && target) {
    return Object.assign(base, {
      state: 'configured',
      level: 'configured',
      label: '已配置，尚未实测',
      detail: 'Key 与目标模型 ' + GO_TARGET_MODEL + ' 都已配置。尚未有一次真实推理证据，因此不显示为"已验证"。',
    })
  }
  if (credentialPresent) {
    return Object.assign(base, {
      state: 'configured',
      level: 'detected',
      label: '已保存 Key，连接未完成',
      detail: 'Key 已保存，但目标模型 ' + GO_TARGET_MODEL + ' 还没有配置到目录中。请完成 DeepSeek 接入（不会自动发起付费请求）。',
    })
  }
  return Object.assign(base, {
    state: 'missing',
    level: 'detected',
    label: '待连接',
    detail: '发现了 Go 供应商记录，但没有可用的 API Key。请填入 OpenCode Go API Key。',
  })
}

export function deriveCodex (aggregation) {
  const agg = obj(aggregation) || {}
  const health = obj(agg.health)
  const base = {
    found: false,
    version: null,
    versionState: 'unknown',
    detectionLevel: 'unknown',
    restartNeeded: null,
    running: null,
    mode: 'unknown',
    label: '状态未知',
    detail: '',
    source: 'GET /api/aggregation/health → detect（desktop/bundledCodex/restart）',
  }
  if (isAggregationUnsupported(aggregation)) {
    return Object.assign(base, {
      detail: '当前实例没有聚合管理接口（404），无法探测 Codex Desktop；不显示成"未安装"。',
    })
  }
  if (!health) {
    return Object.assign(base, {
      detail: '还没有取得 Codex 探测结果（请求未完成或失败）；不推测安装状态。',
    })
  }
  const detect = obj(health.detect) || obj(health.desktop) || {}
  // 只有部分探测对象时不能断言"未安装"：缺 detect 就是 unknown（未知不等于未安装）。
  if (!obj(detect.desktop) && !obj(detect.bundledCli) && !obj(detect.bundledCodex) && !obj(detect.cli)) {
    return Object.assign(base, {
      mode: str(health.mode) || 'unknown',
      detail: '服务端没有返回 Codex 探测明细（detect）；这是"未知"，不是"未安装"。请重新检测或查看高级诊断。',
    })
  }
  const desktop = obj(detect.desktop) || {}
  const bundled = obj(detect.bundledCli) || obj(detect.bundledCodex) || {}
  const cli = obj(detect.cli) || {}
  const restart = obj(detect.restart) || obj(health.activation && health.activation.restart) || null
  const mode = str(health.mode) || str(obj(detect.state) && detect.state.mode) || 'unknown'
  const found = desktop.found === true || bundled.found === true || cli.found === true
  if (!found) {
    return Object.assign(base, {
      found: false,
      mode,
      detectionLevel: 'detected',
      restartNeeded: restart ? restart.needed !== false : null,
      label: '未检测到 Codex',
      detail: '没有找到原版 Codex Desktop/CLI。请确认已安装，或通过高级诊断查看探测到的路径与版本证据；不会提供假的"打开"按钮。',
    })
  }
  const version = str(desktop.version || bundled.version || cli.version) || null
  const versionState = str(desktop.versionState || bundled.versionState || cli.versionState) || 'unknown'
  const restartNeeded = restart ? restart.needed !== false : (health.needsRestart === true ? true : null)
  const label = restartNeeded === true ? '需要重新打开' : restartNeeded === false ? '已就绪' : '已检测到'
  const detail = restartNeeded === true
    ? '配置已写入，但客户端仍在用写入前启动的配置。请完全退出 Codex Desktop（不是只关窗口）再重新打开。'
    : restartNeeded === false
      ? '检测到客户端在写入后启动过，新配置已加载；请在模型选择器里核对官方模型与 ' + GO_TARGET_MODEL + '。'
      : '检测到原版 Codex；没有取得重启判定，请按需完全退出并重新打开。'
  return Object.assign(base, {
    found: true,
    version,
    versionState,
    detectionLevel: 'detected',
    restartNeeded,
    running: obj(detect.clientRuntime) ? detect.clientRuntime.running : null,
    mode,
    label,
    detail,
  })
}

export function deriveAggregation (aggregation) {
  const agg = obj(aggregation) || {}
  const health = obj(agg.health)
  const base = {
    mode: 'unknown',
    supported: !isAggregationUnsupported(aggregation),
    configSha: null,
    backupAvailable: null,
    needsRestart: null,
    blocker: null,
    label: '状态未知',
    detail: '',
    source: 'GET /api/aggregation/health（mode/detect/backup/activation）',
  }
  if (!base.supported) {
    return Object.assign(base, {
      detail: '当前实例没有聚合管理接口（404）。这是版本不兼容，不是"未启用"；不自动写入任何配置。',
    })
  }
  if (!health) {
    return Object.assign(base, {
      detail: '没有取得聚合状态（请求未完成或失败）；不推测是否已启用。',
    })
  }
  const mode = str(health.mode) || 'unknown'
  const detect = obj(health.detect) || {}
  const state = obj(detect.state) || {}
  const backup = obj(health.backup) || obj(detect.backup) || {}
  const activation = obj(health.activation) || {}
  const nativeCompaction = obj(health.nativeCompaction) || obj(detect.nativeCompaction) || null
  const compactionBlocked = !!(nativeCompaction && nativeCompaction.blocked === true)
  const modeKnown = mode === 'aggregated' || mode === 'route' || mode === 'official'
  const drifted = health.drifted === true
  const modeText = mode === 'aggregated'
    ? '聚合模式（GPT 父 + DeepSeek 子）'
    : mode === 'route'
      ? '路由模式（纯 DeepSeek，无 GPT）'
      : mode === 'official'
        ? '官方直连（不经 ModelGate）'
        : '状态未知'
  const modeDetail = mode === 'aggregated'
    ? 'Codex 配置已指向 ModelGate；官方 GPT 与 ' + GO_TARGET_MODEL + ' 都通过原版 Codex 使用。'
      + (compactionBlocked ? ' 原生压缩状态：尚未验证/存在阻断（不声称已通过，详见高级诊断）。' : '')
    : mode === 'route'
      ? 'Codex 配置走纯 DeepSeek 路由（父=子=' + GO_TARGET_PUBLIC_ID + '），不发起 GPT 调用。'
      : mode === 'official'
        ? '当前是官方直连模式，不经 ModelGate，使用 Codex 官方默认配置。'
        : '后端没有返回可识别模式；不把它当成"已启用"或"未启用"。'
  return Object.assign(base, {
    mode: mode || 'unknown',
    modeKnown,
    previousMode: str(health.previousMode) || null,
    drifted,
    configSha: str(activation.appliedSha || state.appliedSha) || null,
    backupAvailable: backup.available === true,
    needsRestart: health.needsRestart === true || activation.needsRestart === true,
    nativeCompaction: compactionBlocked ? { blocked: true, detail: str(nativeCompaction.detail) || null } : null,
    label: drifted && modeKnown ? modeText + ' · 配置漂移（需要重新对齐）' : modeText,
    detail: modeDetail + (drifted && modeKnown ? ' 检测到配置漂移，请重新对齐配置；不显示成直连，也不是一次读取错误。' : ''),
  })
}

function isAggregationUnsupported (aggregation) {
  const agg = obj(aggregation)
  if (!agg) return false
  if (agg.unsupported === true) return true
  const err = obj(agg.error)
  return !!err && classifyAggregationError(err).kind === 'unsupported'
}

// 首页与连接页共用的唯一主 CTA。每个状态**最多一个**主操作；次级操作另列。
export function nextPrimaryAction (ps) {
  const p = obj(ps) || {}
  const state = str(p.state)
  const go = obj(p.go) || {}
  const aggregation = obj(p.aggregation) || {}
  const codex = obj(p.codex) || {}
  switch (state) {
    case 'locked':
      return { id: 'unlock', label: '解锁控制台', kind: 'unlock', route: null, detail: '输入管理员令牌后读取真实状态。' }
    case 'loading':
      return { id: 'wait', label: '正在读取状态…', kind: 'wait', route: null, detail: '还没有取得真实数据，不显示任何成功状态。' }
    case 'read_only_unknown':
      return { id: 'check-version', label: '查看高级诊断', kind: 'route', route: '#/aggregation', detail: '当前实例不支持聚合管理，请确认版本后重试。' }
    case 'needs_admin_token':
      // P1-04：主操作是“本机解锁管理会话”（POST /api/admin/unlock），不是跳设置页的死循环。
      return { id: 'unlock-admin', label: '解锁聚合管理', kind: 'local-admin-unlock', route: null,
        detail: '聚合管理被拒绝（403 ' + (str((obj(p.error) && p.error.code) || (obj(p.aggregation) && obj(p.aggregation.error) && obj(p.aggregation.error).code)) || 'aggregation_admin_required') + '）。' +
          'Codex 侧已生效的配置不受影响；可在本机开启临时管理会话，解锁前不会发起任何写入。' }
    case 'cannot_detect_codex':
      return { id: 'locate-codex', label: '查看如何安装/定位 Codex', kind: 'route', route: '#/connections?step=codex', detail: '需要先有原版 Codex Desktop。' }
    case 'needs_go_key':
      return { id: 'connect-go', label: '连接 OpenCode Go', kind: 'route', route: '#/connections?step=key', detail: '只需填入 OpenCode Go API Key。' }
    case 'go_key_invalid':
      return { id: 'update-go-key', label: '更新 OpenCode Go Key', kind: 'route', route: '#/connections?step=key', detail: '上次的 Key 验证失败或被限流。' }
    case 'conflict':
      return { id: 'resolve-conflict', label: '查看并处理配置冲突', kind: 'route', route: '#/connections?step=conflict', detail: 'Codex 配置被其它程序修改，ModelGate 不会覆盖。' }
    case 'needs_codex_restart':
      return { id: 'restart-codex', label: '完成 Codex 重启', kind: 'route', route: '#/connections?step=restart', detail: '完全退出并重新打开 Codex Desktop。' }
    case 'ready_to_enable':
      if (!go.targetModelConfigured) {
        return { id: 'configure-target', label: '完成 DeepSeek 接入', kind: 'route', route: '#/connections?step=model', detail: '把 ' + GO_TARGET_MODEL + ' 配置为唯一目标模型。' }
      }
      return { id: 'enable-aggregation', label: '启用聚合模式', kind: 'route', route: '#/connections?step=enable', detail: '预览变更、确认后写入 Codex 配置。' }
    case 'preview_pending':
      return { id: 'review-preview', label: '确认配置变更', kind: 'route', route: '#/connections?step=enable', detail: '还没有写入任何配置。' }
    case 'write_in_progress':
      return { id: 'wait-write', label: '正在写入配置…', kind: 'wait', route: null, detail: '不要关闭页面；失败会回滚。' }
    case 'ready':
      return { id: 'use-codex', label: '在 Codex 中使用', kind: 'route', route: '#/connections?step=use', detail: '打开原版 Codex Desktop 的模型选择器。' }
    // 漂移是"读取成功但需要重新对齐"：主操作是走 reconcile（428 预览 → 确认 → 200，只写 state），
    // 不能显示成"重试连接"（那会冒充成一次读取失败）。
    case 'needs_realign':
      return { id: 'realign', label: '重新对齐配置', kind: 'route', route: '#/connections',
        detail: '聚合端点读取正常；当前配置与对齐基线不一致，请到连接页点「重新对齐配置」只更新 state。' }
    case 'recoverable_error': {
      const err = obj(p.error)
      const throttled = !!(err && err.kind === 'throttled')
      return {
        id: throttled ? 'retry-later' : 'retry',
        label: throttled ? '稍后重试' : '重试连接',
        kind: 'retry',
        route: null,
        detail: throttled
          ? '管理接口当前限流；' + (err.retryAfter ? '约 ' + err.retryAfter + ' 秒后' : '稍后') + '再试，不会自动改写配置。'
          : '上一次读取失败；不显示旧的成功状态。',
      }
    }
    default:
      return aggregation.mode === 'aggregated' || aggregation.mode === 'route' || codex.restartNeeded === false
        ? { id: 'use-codex', label: '在 Codex 中使用', kind: 'route', route: '#/connections?step=use', detail: '' }
        : { id: 'connect-go', label: '连接 OpenCode Go', kind: 'route', route: '#/connections?step=key', detail: '' }
  }
}

export function homeStateOf (ps) {
  const p = obj(ps) || {}
  if (p.loading === true) return 'loading'
  if (p.authenticatedAdmin === false) return 'locked'
  if (p.phase === 'conflict') return 'conflict'
  if (p.phase === 'write_in_progress') return 'write_in_progress'
  if (p.aggregation && p.aggregation.supported === false) return 'read_only_unknown'
  if (!p.official || !p.go || !p.codex || !p.aggregation) return 'recoverable_error'
  // 403 explicit_admin_required 排在通用错误之前：它不是"读取失败"，而是缺少管理令牌。
  if (p.error && p.error.kind === 'denied') return 'needs_admin_token'
  if (p.error && p.error.kind && p.error.kind !== 'none') {
    if (p.error.kind === 'conflict') return 'conflict'
    return 'recoverable_error'
  }
  if (p.phase === 'preview_pending') return 'preview_pending'
  if (!p.codex.found) {
    // 探测不可用（缺 detect / 没有快照）时不能要求用户"去安装 Codex"。
    if (p.codex.detectionLevel === 'unknown') return 'recoverable_error'
    return 'cannot_detect_codex'
  }
  if (p.go.state === 'error') return 'go_key_invalid'
  if (!p.go.credentialPresent) return 'needs_go_key'
  if (!p.go.targetModelConfigured) return 'ready_to_enable'
  // 聚合模式未知时不得提示"启用聚合"：那可能在不确定的情况下二次写入。
  // unknown 不当成直连，仍是可恢复错误；但 drifted 是端点全部读取成功后的"基线落后"，
  // 必须单独成态，不能投影成 recoverable_error（那会被 overallOf 渲染成"读取失败"误报）。
  if (p.aggregation.modeKnown === false || p.aggregation.mode === 'unknown') return 'recoverable_error'
  if (p.aggregation.drifted === true) return 'needs_realign'
  // 只有官方直连还需要"启用"；路由/聚合都已完成接入，直接进入重启判定。
  if (p.aggregation.mode === 'official') return 'ready_to_enable'
  if (p.codex.restartNeeded === true) return 'needs_codex_restart'
  return 'ready'
}

export function overallOf (ps) {
  const p = obj(ps) || {}
  if (p.error && p.error.kind === 'throttled') {
    const wait = p.error.retryAfter ? '（Retry-After ' + p.error.retryAfter + ' 秒）' : ''
    return { level: 'error', label: '当前受限，请稍后重试', detail: '管理接口返回 429' + wait + '；没有显示任何旧的成功状态。' }
  }
  switch (str(p.state)) {
    case 'ready':
      return { level: 'ready', label: '准备就绪', detail: '官方套餐与 ' + GO_TARGET_MODEL + ' 都可在原版 Codex 中使用。' }
    case 'needs_codex_restart':
      return { level: 'action', label: '需要操作：重启 Codex', detail: '配置已保存，需要完全退出并重新打开 Codex。' }
    case 'ready_to_enable':
      return { level: 'action', label: '需要操作：继续完成接入', detail: '还差一步就能在 Codex 中使用 ' + GO_TARGET_MODEL + '。' }
    case 'needs_go_key':
      return { level: 'action', label: '需要操作：连接 OpenCode Go', detail: '填入 OpenCode Go API Key 即可自动配置。' }
    case 'go_key_invalid':
      return { level: 'error', label: 'OpenCode Go 需要处理', detail: 'Key 验证失败或被限流；官方套餐不受影响。' }
    case 'cannot_detect_codex':
      return { level: 'action', label: '需要操作：找到 Codex Desktop', detail: '没有检测到原版 Codex Desktop。' }
    case 'conflict':
      return { level: 'error', label: '配置冲突，未做覆盖', detail: 'Codex 配置被其它程序修改，需要你确认。' }
    case 'read_only_unknown':
      return { level: 'unknown', label: '状态未知（实例版本不支持）', detail: '当前实例没有聚合管理接口。' }
    case 'needs_admin_token':
      return { level: 'action', label: '只读：聚合管理未解锁', detail: '聚合接口返回 403（要求显式管理员身份，当前实例没有全局管理令牌）。状态为只读，Codex 侧已生效的配置不受影响；点击“解锁聚合管理”可在本机开启临时管理会话，或在设置里写入 MG_ADMIN_TOKEN。解锁前不会发起任何写入。' }
    // 漂移：聚合端点全部 200，状态已取到；只是对齐基线落后，不是"读取失败"。
    case 'needs_realign':
      return { level: 'action', label: '配置需要重新对齐', detail: '聚合状态已正常读取；config.toml 与对齐基线不一致，重新对齐只更新 state、不改配置内容。' }
    case 'recoverable_error':
      return { level: 'error', label: '出现问题：读取失败', detail: '控制台没有取得真实状态，可安全重试。' }
    case 'locked':
      return { level: 'locked', label: '控制面已锁定', detail: '输入管理员令牌后查看真实状态。' }
    case 'writing':
    case 'write_in_progress':
      return { level: 'action', label: '正在写入配置', detail: '不要关闭页面；失败会回滚。' }
    case 'preview_pending':
      return { level: 'action', label: '等待确认变更', detail: '还没有写入任何配置。' }
    case 'loading':
    default:
      return { level: 'loading', label: '正在读取状态', detail: '真实数据到达前不显示任何成功状态。' }
  }
}

// 错误来源合并：聚合错误优先（它决定 supported），否则状态请求错误（整页可恢复错误）。
function effectiveErrorOf ({ aggError, statusError, aggUnsupported }) {
  if (aggUnsupported) {
    return { kind: 'unsupported', source: 'aggregation', status: aggError.status, code: aggError.code, message: aggError.message }
  }
  if (aggError && aggError.kind !== 'none') return Object.assign({ source: 'aggregation' }, aggError)
  if (statusError && statusError.kind !== 'none') return Object.assign({ source: 'status' }, statusError)
  return null
}

// 主入口：把一次只读快照投影成产品状态。
// input = { authenticatedAdmin, loading, status, config, aggregation, aggregationError, phase, now }
export function deriveProductStatus (input) {
  const inp = obj(input) || {}
  const aggregation = obj(inp.aggregation) || null
  const status = obj(inp.status)
  const aggUnsupported = isAggregationUnsupported(aggregation)
  const aggError = inp.aggregationError ? classifyAggregationError(inp.aggregationError) : classifyAggregationError(
    obj(aggregation) && obj(aggregation).error ? obj(aggregation).error : null,
  )
  // 状态请求（/api/status）失败与聚合请求失败必须区分来源：前者整页进可恢复错误，
  // 后者只影响聚合支持性判断。两者都不能被投影成"未连接"。
  const statusError = inp.statusError ? classifyAggregationError(inp.statusError) : null
  const official = deriveOfficial(status)
  const go = deriveGo(status, aggregation ? Object.assign({}, aggregation, { error: inp.aggregationError || (aggregation && aggregation.error) || null }) : (inp.aggregationError ? { error: inp.aggregationError } : null))
  const codex = deriveCodex(aggregation ? Object.assign({}, aggregation, { error: inp.aggregationError || (aggregation && aggregation.error) || null }) : (inp.aggregationError ? { error: inp.aggregationError } : null))
  const aggregationView = deriveAggregation(aggregation ? Object.assign({}, aggregation, { error: inp.aggregationError || (aggregation && aggregation.error) || null }) : (inp.aggregationError ? { error: inp.aggregationError } : null))
  const missingSections = AGGREGATION_PATHS.filter((k) => !aggregation || !obj(aggregation)[k])
  const ps = {
    contract: PRODUCT_STATUS_CONTRACT,
    authenticatedAdmin: inp.authenticatedAdmin !== false,
    loading: inp.loading === true,
    phase: str(inp.phase) || null,
    error: effectiveErrorOf({ aggError, statusError, aggUnsupported }),
    official,
    go,
    codex,
    aggregation: aggregationView,
    statusLoadedAt: Number(inp.statusLoadedAt) || 0,
    checkedAt: Number(inp.now) || Date.now(),
    missingSections,
    readOnly: true,
    // P1-04：403 时给出准确只读原因（what/why/how），不是"读取失败"。
    readOnlyReason: aggError && aggError.kind === 'denied'
      ? { code: aggError.code || 'aggregation_admin_required', status: aggError.status || 403, message: aggError.message || '' }
      : null,
  }
  ps.state = homeStateOf(ps)
  ps.overall = overallOf(ps)
  ps.primary = nextPrimaryAction(ps)
  ps.secondary = []
  if (ps.aggregation.supported && ps.aggregation.mode === 'aggregated') {
    ps.secondary.push({ id: 'deactivate', label: '退出并恢复', kind: 'route', route: '#/connections?step=revert', detail: '恢复写入前的 Codex 配置。', danger: true })
  }
  if (ps.aggregation.supported) {
    ps.secondary.push({ id: 'advanced', label: '查看高级诊断', kind: 'route', route: '#/aggregation' })
  }
  if (ps.state === 'needs_admin_token') {
    ps.secondary.push({ id: 'set-admin-token', label: '改用管理令牌', kind: 'route', route: '#/settings?section=admin-token', detail: '需要远程/多设备管理时，可在设置里写入 MG_ADMIN_TOKEN。' })
  }
  if (ps.state !== 'ready' && ps.state !== 'loading' && ps.aggregation.mode === 'aggregated') {
    ps.secondary.push({ id: 'refresh', label: '重新检测', kind: 'reload', route: null })
  }
  return ps
}

// 顶栏状态胶囊：真实消费 store 的 health/modes 快照（参考图「● 未连接 ⌄」）。
// 本函数保持纯函数，便于离线断言"文案来自快照、不是写死"：
//   * status = /api/status 投影（网关在线证据）；
//   * aggregation = aggregationState()，其 health/modes/drifted 来自共享只读快照。
// 诚实性：只有确实没有任何快照时才显示「未连接」；drifted 显示「需重新对齐」
// （复用 HOME_STATES 里的 needs_realign 语义，不新增状态名）；取到快照才显示「已连接」
// 并把当前模式带入下拉明细。unknown 不伪装成某个具体模式。
export function topbarStatusOf (status, aggregation) {
  const s = obj(status)
  const a = obj(aggregation)
  const health = a ? obj(a.health) : null
  const modes = a ? obj(a.modes) : null
  const drifted = !!(a && a.drifted === true) || !!(health && health.drifted === true)
  const mode = str(health && health.mode) || str(modes && modes.current) || 'unknown'
  const modeKnown = mode === 'aggregated' || mode === 'route' || mode === 'official'
  const gateway = !!s
  const modeDetail = mode === 'aggregated'
    ? '聚合模式（GPT 父 + DeepSeek 子）'
    : mode === 'route'
      ? '路由模式（纯 DeepSeek，无 GPT）'
      : mode === 'official'
        ? '官方直连（不经 ModelGate）'
        : '当前模式未知'
  // 取不到任何后端快照 —— 唯一允许显示「未连接」的情形。
  if (!gateway && !health && !modes) {
    return { state: 'offline', label: '未连接', level: 'bad', mode: 'unknown', gateway: false, detail: '尚未从网关取得状态快照。' }
  }
  // 配置漂移：端点读取成功，只是对齐基线落后；不显示成"读取失败"。
  if (drifted) {
    return {
      state: 'needs_realign', label: '需重新对齐', level: 'warn', mode, gateway,
      detail: (modeKnown ? modeDetail + '；' : '') + '配置与对齐基线不一致，需要重新对齐。',
    }
  }
  if (modeKnown) {
    return { state: 'connected', label: '已连接', level: 'good', mode, gateway, detail: modeDetail }
  }
  return { state: 'connected', label: '已连接', level: 'good', mode: 'unknown', gateway, detail: '网关已响应；当前模式未知。' }
}
