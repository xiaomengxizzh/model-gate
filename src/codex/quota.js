// E8：官方额度预警 + 手动应急态（D7-B）。
//
// 契约（docs/explanation/codex-quota-emergency.md）：
//  · 额度来源必须显式注入（readQuota() / quota 对象）；无可靠数据 -> state:'unknown' + 显示 UNKNOWN，
//    绝不猜测余额、绝不把"没有数据"当成 0% 或 100%。
//  · 只预警，不自动行动：不自动切换 provider/模型、不购买 API 额度、不退出/删除官方登录。
//  · 应急态是显式状态机：normal -> emergency 需要 {acknowledged:true, reason, backupPoint}；
//    emergency -> normal 可恢复；不声明"无缝"，必须列出 provider 分组/会话可见性/独立实例的影响。
//  · 输出脱敏：只保留白名单字段；来源对象里的 token/apiKey/error 正文不会进入结果。
//
// 纯函数 + 显式注入：本模块不读进程状态、不发请求、不写文件。

export const QUOTA_STATE_VERSION = 1
export const QUOTA_DISPLAY_UNKNOWN = 'UNKNOWN'

/** 三态：fresh（可信来源 + 在新鲜窗口内）/ stale（可信来源但过期）/ unknown（无来源/不可信/读数错误）。 */
export const QUOTA_FRESHNESS = Object.freeze({ FRESH: 'fresh', STALE: 'stale', UNKNOWN: 'unknown' })

export const DEFAULT_CODEX_QUOTA = Object.freeze({ warnPercent: 80, criticalPercent: 95, source: 'none' })
/** 额度读数的新鲜窗口默认值（5 分钟）；超过即 stale，绝不把旧读数当当下余额。 */
export const DEFAULT_QUOTA_MAX_AGE_MS = 5 * 60 * 1000
const MIN_MAX_AGE_MS = 1000
const MAX_MAX_AGE_MS = 24 * 60 * 60 * 1000

// 应急态的影响声明：进入前必须展示给用户，不允许宣称"无缝"。
export const EMERGENCY_IMPACTS = Object.freeze([
  { code: 'provider_grouping_may_change', message: '同一会话的 provider 归属可能改变；历史会话的可见性取决于 Codex 客户端的 provider 分组。' },
  { code: 'session_visibility_may_change', message: '切换后旧会话可能不出现在当前 provider 列表；不能承诺历史无缝可见。' },
  { code: 'separate_instance_or_restart_required', message: '通常需要独立实例或重启客户端才会按新 provider 生效；网关不重启用户进程。' },
  { code: 'official_credentials_not_reused', message: '官方凭据不发送给第三方；第三方仅使用其自己的、已授权的上游凭据。' },
  { code: 'not_seamless', message: '这是手动应急态，不是自动容灾；恢复需再执行一次显式恢复操作。' },
])

export const QUOTA_PROHIBITED = Object.freeze([
  'auto_switch_provider', 'auto_purchase_api_quota', 'logout_official_account',
  'delete_credentials', 'silent_session_provider_change',
])

const SAFE_LABEL_RE = /^[A-Za-z0-9_.:-]{1,40}$/
const SENSITIVE_RE = /(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key\s*[=:]|password\s*[=:])/i
const SAFE_PLAN_RE = /^[A-Za-z0-9 _.:-]{1,40}$/
const SAFE_ERROR_RE = /^[a-z0-9_.:-]{1,60}$/i
const MAX_TEXT = 200

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function text(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || MAX_TEXT) : '' }
function percentOrNull(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round(n * 10) / 10
}
function safeLabel(v, fallback) { return typeof v === 'string' && SAFE_LABEL_RE.test(v.trim()) ? v.trim() : fallback }
// 审计字段（reason/backupPoint）允许自由文本，但绝不把密钥/令牌形态写进审计。
function scrubText(v) { const s = text(v); return s && SENSITIVE_RE.test(s) ? '[redacted]' : s }
function safeSubject(v) { const s = scrubText(v); return SAFE_LABEL_RE.test(s) ? s : '' }
function safePlan(v) { return typeof v === 'string' && SAFE_PLAN_RE.test(v.trim()) ? v.trim() : null }
function safeError(v) { return typeof v === 'string' && SAFE_ERROR_RE.test(v.trim()) ? v.trim() : 'quota_unavailable' }
function normalizeObservedAt(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim())
    return Number.isFinite(t) ? t : null
  }
  return null
}

function normalizeResetAt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t).toISOString() : null
  }
  return null
}

/** 归一化 cfg.defaults.codexQuota；阈值非法回退默认，critical 不得低于 warn。 */
export function normalizeQuotaConfig(cfg) {
  const raw = isPlainObject(cfg && cfg.defaults && cfg.defaults.codexQuota) ? cfg.defaults.codexQuota : {}
  const warn = percentOrNull(raw.warnPercent)
  const critical = percentOrNull(raw.criticalPercent)
  const warnPercent = warn == null ? DEFAULT_CODEX_QUOTA.warnPercent : warn
  const criticalPercent = Math.max(warnPercent, critical == null ? DEFAULT_CODEX_QUOTA.criticalPercent : critical)
  // 新鲜窗口：只接受有限正数并夹在 [1s, 24h]；非法回退默认（不允许"永不过期"）。
  const rawAge = Number(raw.maxAgeMs)
  const maxAgeMs = Number.isFinite(rawAge) && rawAge > 0
    ? Math.max(MIN_MAX_AGE_MS, Math.min(MAX_MAX_AGE_MS, Math.trunc(rawAge)))
    : DEFAULT_QUOTA_MAX_AGE_MS
  return {
    warnPercent,
    criticalPercent,
    source: raw.source === 'trusted' ? 'trusted' : 'none',
    maxAgeMs,
  }
}

/**
 * 归一化注入的读数为白名单字段。任何额外字段（token/apiKey/嵌套对象）都不会被保留。
 * 输入：{source?, ok?, usedPercent?, resetsAt?, plan?, error?}
 * 输出：{ ok, source, usedPercent|null, resetsAt|null, plan|null, error }
 */
export function normalizeQuotaReading(raw, fallbackSource = 'injected') {
  const q = isPlainObject(raw) ? raw : {}
  const usedPercent = percentOrNull(q.usedPercent)
  const observedAt = normalizeObservedAt(q.observedAt != null ? q.observedAt : q.observed_at)
  const ok = q.ok !== false && usedPercent != null
  if (!ok) {
    // 错误只保留"像错误码"的短串；任何自由文本/凭据形态统一收敛为 quota_unavailable。
    const error = q.ok === false
      ? safeError(q.error)
      : (q.usedPercent != null ? 'invalid_quota_value' : safeError(q.error))
    return {
      ok: false,
      source: safeLabel(q.source, fallbackSource),
      usedPercent: null,
      resetsAt: normalizeResetAt(q.resetsAt),
      plan: safePlan(q.plan),
      observedAt,
      error,
    }
  }
  return {
    ok: true,
    source: safeLabel(q.source, fallbackSource),
    usedPercent,
    resetsAt: normalizeResetAt(q.resetsAt),
    plan: safePlan(q.plan),
    observedAt,
    error: '',
  }
}

async function readQuotaValue(opts, conf, now) {
  const hasCfg = !!opts.cfg
  // 配置显式关闭（source:'none'）时，即使调用方传了读数也不采用：避免"配置说没有来源但代码悄悄用"。
  if (hasCfg && conf.source !== 'trusted') {
    return { reading: null, reason: conf.source === 'none' ? 'no_trusted_source' : 'source_disabled' }
  }
  let raw
  let live = false
  if (isPlainObject(opts.quota)) raw = opts.quota
  else if (typeof opts.readQuota === 'function') {
    live = true
    try { raw = await opts.readQuota({ now }) } catch { return { reading: null, reason: 'source_error' } }
  } else if (!hasCfg && isPlainObject(opts.data)) raw = opts.data
  else return { reading: null, reason: 'no_source_configured' }
  const reading = normalizeQuotaReading(raw, conf.source === 'trusted' ? 'trusted' : 'injected')
  // 实时读取（函数返回值）就是"此刻观测"：没有时间戳时补 now；注入快照不补（必须自带时间戳才算新鲜）。
  if (live && reading.ok && reading.observedAt == null) reading.observedAt = now
  return { reading, reason: '' }
}

/**
 * 解析额度快照并判定三态（fresh / stale / unknown）。**唯一**决定新鲜度的地方：
 *  · 没有读数 / 读数错误 ⇒ unknown（reason 保留可诊断码）；
 *  · 有读数但没有观测时间 ⇒ unknown（freshness_unproven，不能证明新鲜就不算新鲜）；
 *  · 观测时间超出 maxAgeMs ⇒ stale；正好等于窗口边界 ⇒ fresh；
 *  · 其余 ⇒ fresh。
 * 实时 source（readQuota 函数）的观测时间就是 now，无需调用方补时间戳。
 */
export async function resolveQuotaSnapshot(opts = {}, confIn, nowIn) {
  const now = Number.isFinite(nowIn) ? nowIn : (Number.isFinite(opts.now) ? opts.now : Date.now())
  const conf = confIn || normalizeQuotaConfig(opts.cfg)
  const thresholds = { warnPercent: conf.warnPercent, criticalPercent: conf.criticalPercent }
  const { reading, reason } = await readQuotaValue(opts, conf, now)
  if (!reading || !reading.ok) {
    return {
      reading: reading || null,
      freshness: QUOTA_FRESHNESS.UNKNOWN,
      reason: reason || (reading && reading.error) || 'quota_unavailable',
      observedAt: null,
      ageMs: null,
      maxAgeMs: conf.maxAgeMs,
      thresholds,
    }
  }
  const observedAt = Number.isFinite(reading.observedAt) ? reading.observedAt : null
  if (observedAt == null) {
    return {
      reading,
      freshness: QUOTA_FRESHNESS.UNKNOWN,
      reason: 'freshness_unproven',
      observedAt: null,
      ageMs: null,
      maxAgeMs: conf.maxAgeMs,
      thresholds,
    }
  }
  const ageMs = now - observedAt
  const stale = ageMs > conf.maxAgeMs
  return {
    reading,
    freshness: stale ? QUOTA_FRESHNESS.STALE : QUOTA_FRESHNESS.FRESH,
    reason: stale ? 'stale' : '',
    observedAt,
    ageMs,
    maxAgeMs: conf.maxAgeMs,
    thresholds,
  }
}

/**
 * 契约入口：`quota -> readFreshTrustedSourceOrReturnUNKNOWN()`。
 * 只有 fresh 才返回 ok:true；stale/unknown 一律 ok:false 并给出稳定原因（调用方不得据此渲染 0%/100%）。
 */
export async function readFreshTrustedSourceOrReturnUNKNOWN(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const conf = normalizeQuotaConfig(opts.cfg)
  const snap = await resolveQuotaSnapshot(opts, conf, now)
  if (snap.freshness === QUOTA_FRESHNESS.FRESH) {
    return {
      ok: true,
      freshness: QUOTA_FRESHNESS.FRESH,
      usedPercent: snap.reading.usedPercent,
      observedAt: snap.observedAt,
      ageMs: snap.ageMs,
      maxAgeMs: snap.maxAgeMs,
      resetsAt: snap.reading.resetsAt || null,
      plan: snap.reading.plan || null,
      source: snap.reading.source || conf.source,
      thresholds: snap.thresholds,
    }
  }
  return {
    ok: false,
    freshness: snap.freshness,
    reason: snap.reason || 'quota_unavailable',
    observedAt: snap.observedAt,
    ageMs: snap.ageMs,
    maxAgeMs: snap.maxAgeMs,
    usedPercent: null,
    display: QUOTA_DISPLAY_UNKNOWN,
    thresholds: snap.thresholds,
  }
}

function quotaStateOf(usedPercent, conf) {
  if (usedPercent == null) return 'unknown'
  if (usedPercent >= 100) return 'critical'
  if (usedPercent >= conf.criticalPercent) return 'critical'
  if (usedPercent >= conf.warnPercent) return 'warn'
  return 'normal'
}

function impactFor(state, usedPercent, officialModels, conf) {
  const models = Array.isArray(officialModels) ? officialModels.filter((m) => typeof m === 'string' && m && m.length <= 80) : []
  const scope = models.length ? { models } : { scope: 'official_provider_models' }
  if (state === 'unknown') return [{ code: 'quota_unknown', message: '官方额度未知：不推断余额，也不做任何自动切换。', ...scope }]
  if (state === 'normal') return []
  if (state === 'warn') return [{ code: 'official_quota_warn', message: '官方额度接近上限（≥' + conf.warnPercent + '% 预警阈值）：继续消耗可能很快触发客户端限制。', usedPercent, ...scope }]
  if (state === 'critical') {
    const out = [{ code: 'official_quota_critical', message: '官方额度达到临界阈值（≥' + conf.criticalPercent + '%）：官方模型请求可能被拒绝或客户端锁定发送。', usedPercent, ...scope }]
    if (usedPercent >= 100) out.push({ code: 'official_quota_exhausted', message: '官方额度已耗尽：不会自动切换、购买或退出登录，需人工确认后再行动。', usedPercent, ...scope })
    out.push({ code: 'client_send_may_be_locked', message: 'Codex 客户端可能在 UI 层锁定发送按钮，网关 HTTP 层无法单独解除。', ...scope })
    return out
  }
  return []
}

function actionsFor(state, reading) {
  if (state === 'unknown') return [
    { code: 'configure_trusted_quota_source', requiresConfirmation: false, message: '配置可信额度来源（cfg.defaults.codexQuota.source="trusted" + 注入 readQuota），或人工核对官方后台。' },
    { code: 'verify_quota_manually', requiresConfirmation: false, message: '在官方客户端/后台人工确认额度；不要按猜测的余额预先切换。' },
  ]
  if (state === 'normal') return [{ code: 'continue_with_monitoring', requiresConfirmation: false, message: '额度正常，继续使用并保持监控。' }]
  const out = [{ code: 'review_budget_and_usage', requiresConfirmation: false, message: '检查预算与用量，优先减少非必要请求。' }]
  if (reading && reading.resetsAt) out.push({ code: 'wait_for_quota_reset', requiresConfirmation: false, resetsAt: reading.resetsAt, message: '等待额度重置（以官方 resetsAt 为准）。' })
  if (state === 'critical') {
    out.push({ code: 'prepare_manual_emergency', requiresConfirmation: true, requires: { acknowledged: true, reason: '', backupPoint: '' }, message: '如确需使用第三方应急：先准备备份点，再显式确认进入应急态（不会自动执行）。' })
  }
  return out
}

function sanitizeEmergency(state) {
  if (!isPlainObject(state)) return { active: false, mode: 'normal', since: null, acknowledged: false, reason: '', backupPoint: '', subject: '', timeline: [] }
  const mode = state.mode === 'emergency' ? 'emergency' : 'normal'
  const em = isPlainObject(state.emergency) ? state.emergency : {}
  return {
    active: mode === 'emergency',
    mode,
    since: typeof em.since === 'number' ? em.since : null,
    acknowledged: mode === 'emergency' ? em.acknowledged === true : false,
    reason: mode === 'emergency' ? scrubText(em.reason) : '',
    backupPoint: mode === 'emergency' ? scrubText(em.backupPoint) : '',
    subject: mode === 'emergency' ? safeSubject(em.subject) : '',
    // 时间线是审计证据：保留 action/subject/reason/timestamp，但同样脱敏、字段受控。
    timeline: Array.isArray(state.timeline) ? state.timeline.slice(-20).map((t) => ({
      at: Number.isFinite(t && t.at) ? t.at : null,
      action: t && (t.action === 'recover' ? 'recover' : 'enter_emergency'),
      mode: t && t.mode === 'emergency' ? 'emergency' : 'normal',
      subject: safeSubject(t && t.subject),
      reason: scrubText(t && t.reason),
    })) : [],
  }
}

/**
 * 评估官方额度（纯计算，不自动行动）。
 * opts: { cfg?, readQuota?, quota?, data?, now?, officialModels?, emergencyState? }
 * 返回 { state:'normal'|'warn'|'critical'|'unknown', display, usedPercent, ... , emergency, mode, impacts, actions, prohibited, automation }
 */
export async function evaluateQuota(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const conf = normalizeQuotaConfig(opts.cfg)
  const snap = await resolveQuotaSnapshot(opts, conf, now)
  const reading = snap.reading
  const freshness = snap.freshness
  const usedPercent = reading && reading.ok ? reading.usedPercent : null
  // observedState 是按读数算出的阈值状态；state 只有"新鲜"时才等于它，stale/unknown 一律 unknown，
  // 避免任何调用方把过期/无法证明的读数当成当下余额。
  const observedState = quotaStateOf(usedPercent, conf)
  const trusted = freshness === QUOTA_FRESHNESS.FRESH
  const state = trusted ? observedState : 'unknown'
  const emergency = sanitizeEmergency(opts.emergencyState)
  const officialModels = Array.isArray(opts.officialModels) ? opts.officialModels : []
  const rounded = usedPercent == null ? null : Math.round(usedPercent * 10) / 10

  const impacts = impactFor(state, usedPercent, officialModels, conf)
  if (!trusted && usedPercent != null) {
    if (freshness === QUOTA_FRESHNESS.STALE) {
      impacts.push({
        code: 'quota_stale',
        message: '额度读数已过期（超出新鲜窗口）：不把旧读数当作当下余额，也不据此自动切换。',
        usedPercent: rounded, observedAt: snap.observedAt, ageMs: snap.ageMs, maxAgeMs: snap.maxAgeMs,
      })
    } else {
      impacts.push({ code: 'quota_freshness_unproven', message: '额度读数没有可信观测时间：无法证明新鲜，按未知处理。' })
    }
  }
  if (emergency.active) {
    impacts.push({ code: 'emergency_mode_active', message: '应急态已启用：provider 分组/会话可见性可能变化，且非无缝。' })
    for (const e of EMERGENCY_IMPACTS) impacts.push(e)
  }
  // stale 时按"读数算出的状态"给建议（仍可用），但动作里必须包含刷新来源；unknown 用未知建议。
  const actions = actionsFor(freshness === QUOTA_FRESHNESS.STALE ? observedState : state, reading)
  if (freshness !== QUOTA_FRESHNESS.FRESH) {
    actions.unshift({
      code: 'refresh_quota_source',
      requiresConfirmation: false,
      message: '重新读取官方额度（或人工核对后台）：过期/无法证明的读数不能用于自动决策。',
    })
  }
  if (emergency.active) {
    actions.push({ code: 'recover_emergency_when_ready', requiresConfirmation: true, message: '额度/条件恢复后，显式执行恢复操作退出应急态。' })
  }
  const quotaInsufficient = observedState === 'critical'
  return {
    version: QUOTA_STATE_VERSION,
    generatedAt: now,
    state,
    observedState,
    freshness,
    trusted,
    display: usedPercent == null
      ? QUOTA_DISPLAY_UNKNOWN
      : (trusted ? rounded + '%' : (freshness === QUOTA_FRESHNESS.STALE ? rounded + '% (stale)' : QUOTA_DISPLAY_UNKNOWN)),
    usedPercent,
    observedAt: snap.observedAt,
    ageMs: snap.ageMs,
    maxAgeMs: snap.maxAgeMs,
    resetsAt: (reading && reading.resetsAt) || null,
    plan: (reading && reading.plan) || null,
    source: (reading && reading.source) || conf.source,
    reason: snap.reason || (reading && reading.error) || '',
    thresholds: { warnPercent: conf.warnPercent, criticalPercent: conf.criticalPercent },
    exhausted: trusted && observedState === 'critical' && usedPercent != null && usedPercent >= 100,
    observedExhausted: observedState === 'critical' && usedPercent != null && usedPercent >= 100,
    impacts,
    actions,
    prohibited: [...QUOTA_PROHIBITED],
    automation: { autoSwitch: false, autoPurchase: false, logout: false, changeSessionProvider: false },
    // 硬约束（D7）：额度不足绝不自动切换身份/provider；只有显式应急态才允许人工切换。
    routing: {
      autoSwitch: false,
      switchAllowed: emergency.active === true,
      requiresExplicitEmergency: true,
      quotaInsufficient,
      freshness,
      status: emergency.active
        ? 'emergency_manual_switch_only'
        : (quotaInsufficient ? 'quota_insufficient_requires_explicit_emergency' : 'no_switch'),
      note: '官方额度不足不会自动切换 provider/身份；切换必须先进应急态并由人工执行。',
    },
    emergency,
    mode: emergency.mode,
    note: trusted
      ? '额度状态仅用于预警；任何 provider 切换都必须人工确认。'
      : (freshness === QUOTA_FRESHNESS.STALE
        ? '额度读数已过期：显示为 stale，不做自动切换；请刷新来源。'
        : '没有可靠且新鲜的官方额度数据：显示 UNKNOWN，网关不猜测、不自动切换。'),
  }
}

function freshState(now) {
  return {
    version: QUOTA_STATE_VERSION,
    mode: 'normal',
    updatedAt: Number.isFinite(now) ? now : Date.now(),
    emergency: null,
    lastEmergency: null,
    timeline: [],
  }
}

function coerceState(raw) {
  if (isPlainObject(raw) && raw.version === QUOTA_STATE_VERSION && (raw.mode === 'normal' || raw.mode === 'emergency')) {
    const s = freshState(Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now())
    s.mode = raw.mode
    s.emergency = isPlainObject(raw.emergency) ? raw.emergency : null
    s.lastEmergency = isPlainObject(raw.lastEmergency) ? raw.lastEmergency : null
    s.timeline = Array.isArray(raw.timeline) ? raw.timeline.filter(isPlainObject) : []
    return s
  }
  return freshState(Date.now())
}

/** 新状态（normal）；state 为普通 JSON 对象，可直接持久化。 */
export function createQuotaState(opts = {}) { return freshState(opts.now) }

/**
 * 进入应急态。必须显式确认：{acknowledged:true, reason, backupPoint}。
 * 缺任一项都拒绝且状态不变；成功时写入时间线并返回影响声明。
 */
export function enterEmergency(state, intent = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const s = coerceState(state)
  if (s.mode === 'emergency') return { ok: false, code: 'already_emergency', message: '已经在应急态；如需重试请先恢复。', state: s }
  if (!isPlainObject(intent) || intent.acknowledged !== true) {
    return { ok: false, code: 'acknowledgement_required', message: '进入应急态必须显式确认（acknowledged:true）。', state: s, required: { acknowledged: true, reason: '', backupPoint: '' } }
  }
  // reason/backupPoint 允许自由文本但要脱敏；subject 是"对谁/哪个官方主体"的审计标签（可选）。
  const reason = scrubText(intent.reason)
  if (!reason) return { ok: false, code: 'reason_required', message: '进入应急态必须说明原因（reason，≤200 字符）。', state: s }
  const backupPoint = scrubText(intent.backupPoint)
  if (!backupPoint) return { ok: false, code: 'backup_point_required', message: '进入应急态必须提供备份点（backupPoint，例如配置备份文件/时间点）。', state: s }
  const subject = safeSubject(intent.subject != null ? intent.subject : opts.subject)
  const next = {
    ...s,
    mode: 'emergency',
    updatedAt: now,
    emergency: { since: now, acknowledged: true, reason, backupPoint, subject },
    timeline: [...s.timeline, { at: now, action: 'enter_emergency', mode: 'emergency', reason, backupPoint, subject }].slice(-50),
  }
  return {
    ok: true,
    code: 'emergency_entered',
    state: next,
    impacts: [...EMERGENCY_IMPACTS],
    prohibited: [...QUOTA_PROHIBITED],
    note: '应急态为手动操作：不自动切换、不购买额度、不退出官方登录；影响见 impacts。',
  }
}

/** 退出应急态（恢复 normal），保留 lastEmergency 作为审计证据。 */
export function exitEmergency(state, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const s = coerceState(state)
  if (s.mode !== 'emergency') return { ok: false, code: 'not_in_emergency', message: '当前不在应急态，无需恢复。', state: s }
  const reason = scrubText(opts.reason)
  const subject = safeSubject(opts.subject)
  const lastEmergency = Object.assign({}, s.emergency || {}, { recoveredAt: now, recoverReason: reason })
  const next = {
    ...s,
    mode: 'normal',
    updatedAt: now,
    emergency: null,
    lastEmergency,
    timeline: [...s.timeline, { at: now, action: 'recover', mode: 'normal', reason, subject }].slice(-50),
  }
  return { ok: true, code: 'emergency_recovered', state: next }
}

/** 可持久化形状（只含公开字段；reason/backupPoint 为人工输入，不含凭据）。 */
export function serializeQuotaState(state) {
  const s = coerceState(state)
  return {
    version: QUOTA_STATE_VERSION,
    mode: s.mode,
    updatedAt: s.updatedAt,
    emergency: s.emergency ? { since: s.emergency.since, acknowledged: s.emergency.acknowledged === true, reason: scrubText(s.emergency.reason), backupPoint: scrubText(s.emergency.backupPoint), subject: safeSubject(s.emergency.subject) } : null,
    lastEmergency: s.lastEmergency ? {
      since: Number.isFinite(s.lastEmergency.since) ? s.lastEmergency.since : null,
      recoveredAt: Number.isFinite(s.lastEmergency.recoveredAt) ? s.lastEmergency.recoveredAt : null,
      reason: scrubText(s.lastEmergency.reason),
      backupPoint: scrubText(s.lastEmergency.backupPoint),
      subject: safeSubject(s.lastEmergency.subject),
      recoverReason: scrubText(s.lastEmergency.recoverReason),
    } : null,
    timeline: s.timeline.map((t) => ({
      at: t.at, action: t.action, mode: t.mode,
      ...(t.subject ? { subject: safeSubject(t.subject) } : {}),
      ...(t.reason ? { reason: scrubText(t.reason) } : {}),
      ...(t.backupPoint ? { backupPoint: scrubText(t.backupPoint) } : {}),
    })),
  }
}

/** 解析持久化状态；非法/旧版本回退到 fresh normal（诊断可通过返回值自己判断）。 */
export function parseQuotaState(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return freshState(Date.now()) }
  }
  return coerceState(value)
}

/** 应急态影响声明（供 UI/文档直接展示）。 */
export function describeEmergencyImpacts() {
  return EMERGENCY_IMPACTS.map((e) => Object.assign({}, e))
}
