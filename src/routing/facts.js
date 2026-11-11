// 候选事实归一化（M3-1 / T-ROUTE-01）：纯函数、零 IO、零第三方依赖、不取墙钟。
//
// 背景（审计发现的三处缺陷）：
//   1. 能力可伪造 —— 接入层把**需求**复制成候选能力（请求带 function 工具 ⇒ 候选"支持"工具），
//      于是"候选支持某能力"从来没有被证据支持过，只是把请求抄了一遍；
//   2. 事实无时效 —— 价格/健康/授权没有观测时间，过期事实会长期生效，无法判断"现在是否还成立"；
//   3. 来源不可审计 —— 事后无法回答"这条授权/报价是谁在什么时候给的"。
//
// 本模块只做两件事：
//   A. 把候选事实统一成「值 + 来源 + 观测时间」的证据信封（evidence）；
//   B. 判定该证据当前是否可用于决策（proven / missing / expired / malformed）。
// 决策策略（筛选顺序、排序、停机码）仍在 decision.js；本模块不做任何选择、不读配置、不发请求。
//
// 兼容边界：没有 facts 信封的旧候选（src/forward.js 当前形状）一律标记为 legacy（调用方声明），
// 由 decision.js 的兼容层按原语义处理，本模块不擅自把它们判定为"无证据"。

/** 事实类别：决定"这条事实属于哪一类证据"。 */
export const FACT = Object.freeze({
  IDENTITY: 'identity',
  AUTHORIZATION: 'authorization',
  CAPABILITIES: 'capabilities',
  PRICING: 'pricing',
  HEALTH: 'health',
})

/** 事实状态：proven 才可参与决策；其余一律按"未知"处理（宁可不用，不可假装知道）。 */
export const FACT_STATUS = Object.freeze({
  PROVEN: 'proven',
  MISSING: 'missing',
  EXPIRED: 'expired',
  MALFORMED: 'malformed',
  LEGACY: 'legacy', // 旧形状：无信封，由调用方显式声明（兼容层）
})

/**
 * 事实来源的稳定取值。只允许这些名字，避免把 URL/凭据/上游错误体写进来源字段。
 * catalog = 模型目录；probe = 主动探测；config = 用户配置；ledger = 费用账本；
 * provider = 上游响应；caller = 调用方实时计算；legacy_declared = 旧候选字段。
 */
export const FACT_SOURCE = Object.freeze({
  CATALOG: 'catalog',
  PROBE: 'probe',
  CONFIG: 'config',
  LEDGER: 'ledger',
  PROVIDER: 'provider',
  CALLER: 'caller',
  LEGACY_DECLARED: 'legacy_declared',
})

/**
 * 各类事实的默认最大存活时间。超过即按"未知"处理，不看内容有多好看。
 * health 刻意很短：健康是高频变化的运行时信号，10 分钟前的"健康"不算证据。
 */
export const FACT_MAX_AGE_MS = Object.freeze({
  identity: 24 * 60 * 60 * 1000,
  authorization: 5 * 60 * 1000,
  capabilities: 24 * 60 * 60 * 1000,
  pricing: 6 * 60 * 60 * 1000,
  health: 60 * 1000,
})

const toStr = (v) => (v == null ? '' : String(v))

/** 证据信封。支持 evidence(value, { source, observedAt }) 与 evidence(value, source, observedAt)。 */
export function evidence(value, metaOrSource, observedAt) {
  const meta = metaOrSource && typeof metaOrSource === 'object' ? metaOrSource : { source: metaOrSource, observedAt }
  const at = meta.observedAt == null ? null : Number(meta.observedAt)
  return {
    value,
    source: meta.source == null ? null : toStr(meta.source),
    observedAt: Number.isFinite(at) ? at : null,
  }
}

/** 是否是一个证据信封（而不是裸值 / 裸对象）。要求自带 value 键，避免把候选对象误判成证据。 */
export function isEvidence(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && Object.prototype.hasOwnProperty.call(x, 'value')
}

/** 取某类事实的最大存活时间：opts.maxAgeMs 可整体覆盖，也可按类覆盖（对象）。 */
export function maxAgeFor(name, opts = {}) {
  const override = opts.maxAgeMs
  if (typeof override === 'number' && override >= 0) return override
  if (override && typeof override === 'object' && typeof override[name] === 'number' && override[name] >= 0) return override[name]
  return Object.prototype.hasOwnProperty.call(FACT_MAX_AGE_MS, name) ? FACT_MAX_AGE_MS[name] : null
}

/**
 * 判定证据是否可用。
 * @returns {{status:string, reason:string|null, value:*, source:string|null, observedAt:number|null, ageMs:number|null}}
 * 只有 status === proven 时 value 才有内容；其余状态 value 一律 undefined（fail-closed）。
 */
export function factStatus(ev, opts = {}) {
  const now = Number(opts.now)
  const maxAgeMs = typeof opts.maxAgeMs === 'number' && opts.maxAgeMs >= 0 ? opts.maxAgeMs : null
  const empty = { value: undefined, source: null, observedAt: null, ageMs: null }

  if (!isEvidence(ev)) return Object.assign({ status: FACT_STATUS.MISSING, reason: 'no_evidence_envelope' }, empty)
  const source = ev.source == null ? '' : toStr(ev.source).trim()
  const observedAt = ev.observedAt == null ? NaN : Number(ev.observedAt)
  const meta = {
    value: undefined,
    source: source || null,
    observedAt: Number.isFinite(observedAt) ? observedAt : null,
    ageMs: null,
  }
  if (!source) return Object.assign({ status: FACT_STATUS.MALFORMED, reason: 'no_source' }, meta)
  if (!Number.isFinite(observedAt)) return Object.assign({ status: FACT_STATUS.MALFORMED, reason: 'no_observed_at' }, meta)
  // 没有可信时钟就不能判断新鲜度：不许因为"算不出年龄"就当成新鲜。
  if (!Number.isFinite(now)) return Object.assign({ status: FACT_STATUS.MISSING, reason: 'clock_unavailable' }, meta)
  const ageMs = now - observedAt
  meta.ageMs = ageMs
  if (maxAgeMs != null && ageMs > maxAgeMs) return Object.assign({ status: FACT_STATUS.EXPIRED, reason: 'stale' }, meta)
  return { status: FACT_STATUS.PROVEN, reason: null, value: ev.value, source, observedAt, ageMs }
}

/**
 * 归一化一个候选。有 facts 对象 ⇒ evidence 模式（严格证据）；否则 legacy 模式（旧形状兼容）。
 * 注意：facts: {} 会被视为"显式声明了证据模式但一条事实都没有"，结果必然是全部未证明而不可入选——
 * 这是刻意的：空证据不等于"什么都会"。
 */
export function normalizeCandidate(raw, opts = {}) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const bag = c.facts
  const evidenceMode = !!bag && typeof bag === 'object' && !Array.isArray(bag)
  const now = Number(opts.now)
  return {
    raw: c,
    mode: evidenceMode ? 'evidence' : 'legacy',
    model: toStr(c.model),
    provider: toStr(c.provider),
    facts: evidenceMode ? bag : null,
    now: Number.isFinite(now) ? now : NaN,
  }
}

/**
 * 来源名的安全化：只允许短标识符。来源是"谁给的"的标签，不应承载 URL 或凭据；
 * 一旦看起来像凭据/连接串，就替换成 redacted——审计输出绝不能成为泄漏面。
 */
export function sanitizeSource(source) {
  const s = source == null ? '' : String(source).trim()
  if (!s) return null
  if (s.length > 48) return 'redacted'
  if (!/^[a-zA-Z0-9_.:-]+$/.test(s)) return 'redacted'
  if (/(sk-|bearer|api[_-]?key|secret|token|password)/i.test(s)) return 'redacted'
  return s
}

/** 候选的稳定标识（仅用于排序与日志，不含任何凭据）。 */
export function candidateKey(raw) {
  const c = raw || {}
  return toStr(c.model) + '|' + toStr(c.provider)
}

/** 读取一条事实。evidence 模式返回真实状态；legacy 模式返回 LEGACY（由 decision.js 兼容层处理）。 */
export function readFact(normalized, name, opts = {}) {
  const n = normalized || {}
  if (n.mode !== 'evidence') {
    return { status: FACT_STATUS.LEGACY, reason: 'legacy_declared', value: undefined, source: FACT_SOURCE.LEGACY_DECLARED, observedAt: null, ageMs: null }
  }
  const bag = n.facts || {}
  const now = opts.now == null ? n.now : Number(opts.now)
  const maxAgeMs = maxAgeFor(name, opts)
  return factStatus(bag[name], { now, maxAgeMs })
}

/** 健康事实的最小形状：state ∈ closed/open/half_open，附带 errorRate 与冷却截止。 */
export function normalizeHealthValue(v) {
  const h = v && typeof v === 'object' ? v : {}
  const rawState = h.state != null ? h.state : (h.healthy === false ? 'open' : h.healthy === true ? 'closed' : '')
  let state = toStr(rawState).toLowerCase()
  if (state !== 'open' && state !== 'half_open') state = 'closed'
  const cooldownRaw = h.cooldownUntilMs != null ? h.cooldownUntilMs : h.cooldownUntil
  const cooldown = Number(cooldownRaw)
  const errorRate = Number(h.errorRate)
  return {
    state,
    errorRate: Number.isFinite(errorRate) ? Math.min(1, Math.max(0, errorRate)) : 0,
    cooldownUntilMs: Number.isFinite(cooldown) ? cooldown : 0,
  }
}

const looksLikeHealth = (x) => !!x && typeof x === 'object' &&
  (Object.prototype.hasOwnProperty.call(x, 'state') ||
    Object.prototype.hasOwnProperty.call(x, 'healthy') ||
    Object.prototype.hasOwnProperty.call(x, 'errorRate') ||
    Object.prototype.hasOwnProperty.call(x, 'cooldownUntilMs') ||
    Object.prototype.hasOwnProperty.call(x, 'cooldownUntil'))

// 调用方在"当下"计算出来的快照没有观测时间：按当下观测处理，但来源必须标明是实时探活，
// 不能冒充缓存事实（缓存事实必须自带 observedAt，否则视为未知）。
function liveHealth(entry, now) {
  if (entry == null) return null
  if (isEvidence(entry)) return factStatus(entry, { now })
  if (typeof entry !== 'object') return null
  return {
    status: FACT_STATUS.PROVEN,
    reason: null,
    value: normalizeHealthValue(entry),
    source: FACT_SOURCE.CALLER,
    observedAt: Number.isFinite(Number(now)) ? Number(now) : null,
    ageMs: 0,
    live: true,
  }
}

function entryHealth(entry, opts) {
  if (entry == null) return null
  if (isEvidence(entry)) return factStatus(entry, { now: opts.now, maxAgeMs: maxAgeFor('health', opts) })
  return liveHealth(entry, opts.now)
}

/**
 * 解析注入的健康事实（decision 的 health 参数 / healthOf 钩子）。
 * 优先级固定：函数 > 'model|provider' 键 > provider 键 > byTarget > byProvider > default > 单快照。
 * 返回 { status, value, source, observedAt, ageMs, reason } 或 null（没有该候选的健康信息）。
 */
export function resolveHealth(input, candidate, opts = {}) {
  const now = Number(opts.now)
  const c = candidate || {}
  if (typeof input === 'function') {
    try {
      const v = input(c)
      return liveHealth(v, now)
    } catch {
      // 探活器自己崩了：不能把"探活失败"当成"健康"。
      return { status: FACT_STATUS.MISSING, reason: 'health_probe_failed', value: undefined, source: null, observedAt: null, ageMs: null }
    }
  }
  if (!input || typeof input !== 'object') return null
  if (isEvidence(input)) return factStatus(input, { now, maxAgeMs: maxAgeFor('health', opts) })

  const keys = [toStr(c.model) + '|' + toStr(c.provider), toStr(c.provider)]
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(input, k)) {
      const hit = entryHealth(input[k], { now, maxAgeMs: opts.maxAgeMs })
      if (hit) return hit
    }
  }
  for (const mapKey of ['byTarget', 'byProvider']) {
    const map = input[mapKey]
    if (!map || typeof map !== 'object') continue
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        const hit = entryHealth(map[k], { now, maxAgeMs: opts.maxAgeMs })
        if (hit) return hit
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'default')) {
    const hit = entryHealth(input.default, { now, maxAgeMs: opts.maxAgeMs })
    if (hit) return hit
  }
  if (looksLikeHealth(input)) return liveHealth(input, now)
  return null
}

/**
 * 便捷构造：把一组已观测事实打包成候选（供接入层与测试使用）。
 * 只做形状组装，不做任何"补全"——缺哪条就不给哪条。
 */
export function candidate({ model, provider, facts = {}, scope, tieBreak } = {}) {
  const out = { model, provider, facts: Object.assign({}, facts) }
  if (scope != null) out.scope = scope
  if (tieBreak != null) out.tieBreak = tieBreak
  return out
}
