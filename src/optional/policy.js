// M1-4a / T-OPTIONAL-01：可选端点（embedding / rerank / audio / image / video）的
// 唯一策略入口。三个端点模块只声明差异（capability、校验、上游整形），以下全部共用：
//   - 能力可用性注册表（未证实的新端点默认 DISABLED，明确拒绝而不是静默 404）
//   - 身份/授权解析（缺少可识别主体 → 401）
//   - 本地限流（按 subject+capability，429 带 Retry-After 秒）
//   - 取消（一次终态，迟到的上游结果被忽略）
//   - 上游状态归因（429 保留状态与 Retry-After，不折叠成 502；其它 5xx → 502）
// 纯模块实现：不读环境、不触网络；send / resolveTarget / clock / limiter 全部可注入。
import { performance } from 'node:perf_hooks'

export const OPTIONAL_POLICY_IMPLEMENTATION = 'optional-endpoint-policy/1'
// 已证实的可选能力；新增能力必须先完成契约评审再显式加入，否则默认 DISABLED。
export const PROVEN_OPTIONAL_CAPABILITIES = Object.freeze(['embedding', 'rerank', 'audio', 'image', 'video'])
export const CAPABILITY_ENABLED = 'ENABLED'
export const CAPABILITY_DISABLED = 'DISABLED'

function nowDefault () { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now() }

export function createCapabilityRegistry (overrides = {}) {
  const states = new Map()
  for (const capability of PROVEN_OPTIONAL_CAPABILITIES) {
    const override = overrides[capability]
    const enabled = override && typeof override.enabled === 'boolean' ? override.enabled : true
    states.set(capability, {
      capability,
      enabled,
      reason: enabled ? null : ((override && override.reason) || 'capability_disabled'),
    })
  }
  return {
    proven: PROVEN_OPTIONAL_CAPABILITIES.slice(),
    // 未在已证实清单里的 capability 一律 DISABLED（不静默 404）。
    stateOf (capability) {
      const known = states.get(capability)
      if (known) return { ...known }
      return { capability, enabled: false, reason: 'unproven_capability' }
    },
    set (capability, enabled, reason) {
      if (!PROVEN_OPTIONAL_CAPABILITIES.includes(capability)) throw new Error('unproven capability: ' + capability)
      states.set(capability, { capability, enabled: !!enabled, reason: enabled ? null : (reason || 'capability_disabled') })
      return this.stateOf(capability)
    },
  }
}

// Retry-After：秒数或 HTTP-date，统一折算为秒（向上取整、最小 1 秒）；无法解析返回 null。
export function parseRetryAfterSeconds (headers) {
  const raw = headers && (headers['retry-after'] != null ? headers['retry-after'] : headers['Retry-After'])
  if (raw == null || raw === '') return null
  const text = String(raw).trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(1, Math.ceil(Number(text)))
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return null
  return Math.max(1, Math.ceil((at - Date.now()) / 1000))
}

export function canceledResult (message) {
  return { ok: false, status: 499, error: { type: 'canceled', code: 'request_canceled', message: message || '请求已取消' } }
}

// 统一上游归因：429 必须保留状态与 Retry-After；5xx 折叠为 502；4xx 原样透出。
export function defaultClassifyStatus (status, headers) {
  const code = Number(status) || 0
  if (code === 429) {
    return {
      action: 'rate_limited',
      status: 429,
      retryAfterSec: parseRetryAfterSeconds(headers),
      error: { type: 'rate_limited', code: 'upstream_rate_limited', message: '上游限流（429）' },
    }
  }
  if (code >= 500) {
    return { action: 'upstream_error', status: 502, retryAfterSec: null, error: { type: 'upstream_error', code: 'upstream_error_' + code, message: '上游错误（' + code + '）' } }
  }
  if (code >= 400) {
    return { action: 'client_error', status: code, retryAfterSec: null, error: { type: 'invalid_request_error', code: 'upstream_client_error_' + code, message: '上游拒绝请求（' + code + '）' } }
  }
  return { action: 'ok', status: code || 200, retryAfterSec: null }
}

// 身份/授权解析单一实现：主体由入口在鉴权后注入，这里只做“可识别主体”判定。
export function resolveOptionalIdentity (ctx = {}) {
  const subjectId = typeof ctx.subjectId === 'string' ? ctx.subjectId.trim() : (typeof ctx.keyId === 'string' ? ctx.keyId.trim() : '')
  if (!subjectId) {
    return { ok: false, status: 401, error: { type: 'unauthorized', code: 'missing_subject', message: '可选端点需要可识别的调用主体（客户端 Key / 虚拟 Key / 显式身份）' } }
  }
  return { ok: true, subjectId }
}

// 本地限流：按 subject+capability 的固定窗口；超过上限返回 429 + 剩余秒数。
export function createRateLimiter (opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 60
  const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : 60000
  const now = typeof opts.now === 'function' ? opts.now : nowDefault
  const buckets = new Map()
  return {
    limit,
    windowMs,
    check (key) {
      const t = now()
      const bucket = buckets.get(key)
      if (!bucket || t - bucket.start >= windowMs) {
        buckets.set(key, { start: t, count: 1 })
        return { ok: true, remaining: limit - 1 }
      }
      if (bucket.count >= limit) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.start + windowMs - t) / 1000)) }
      }
      bucket.count += 1
      return { ok: true, remaining: limit - bucket.count }
    },
    reset () { buckets.clear() },
  }
}

// 唯一策略入口。三个可选端点模块都调用它，仅通过参数声明差异。
export function createOptionalEndpointPolicy (opts = {}) {
  const capability = opts.capability
  if (!capability) throw new TypeError('createOptionalEndpointPolicy requires capability')
  const registry = opts.registry || createCapabilityRegistry()
  const limiter = opts.rateLimiter || createRateLimiter({ limit: opts.rateLimit, windowMs: opts.rateWindowMs, now: opts.now })
  const classifyStatus = typeof opts.classifyStatus === 'function' ? opts.classifyStatus : defaultClassifyStatus
  const now = typeof opts.now === 'function' ? opts.now : nowDefault
  const policy = {
    capability,
    implementation: OPTIONAL_POLICY_IMPLEMENTATION,
    availability () { return registry.stateOf(capability) },
    async execute (ctx = {}) {
      // 1) 能力可用性：未证实/未启用的新增端点默认 DISABLED，返回明确 501。
      const availability = registry.stateOf(capability)
      if (!availability.enabled) {
        return {
          ok: false,
          status: 501,
          error: {
            type: 'capability_disabled',
            code: 'optional_endpoint_disabled',
            capability,
            reason: availability.reason,
            message: '可选端点「' + capability + '」未启用（未证实的可选能力默认关闭）',
          },
        }
      }
      // 2) 身份/授权
      const identity = resolveOptionalIdentity(ctx)
      if (!identity.ok) return { ok: false, status: identity.status, error: identity.error }
      // 3) 请求校验（端点差异）
      if (typeof opts.validate === 'function') {
        const invalid = opts.validate(ctx.body, ctx)
        if (invalid && invalid.error) {
          return { ok: false, status: 400, error: { type: 'invalid_request_error', code: 'invalid_request', message: invalid.error } }
        }
      }
      // 4) 本地限流（同一实现）
      const limited = limiter.check(identity.subjectId + ':' + capability)
      if (!limited.ok) {
        return { ok: false, status: 429, retryAfterSec: limited.retryAfterSec, error: { type: 'rate_limited', code: 'local_rate_limited', message: '本地限流：请按 Retry-After 重试' } }
      }
      // 5) 取消：进入上游前已取消 → 一次终态。
      if (ctx.signal && ctx.signal.aborted) return canceledResult()
      let target
      try {
        target = typeof opts.resolveTarget === 'function' ? await opts.resolveTarget(ctx) : (ctx.target || null)
      } catch (err) {
        return { ok: false, status: (err && err.status) || 502, error: { type: 'upstream_error', code: 'target_resolution_failed', message: (err && err.message) || '无法解析上游目标' } }
      }
      if (!target || target.error) {
        return { ok: false, status: (target && target.status) || 400, error: (target && target.error) || { type: 'invalid_request_error', code: 'missing_target', message: '缺少上游目标' } }
      }
      // 6) 上游调用 + 归因；取消是唯一终态，迟到的结果被忽略。
      const send = typeof opts.send === 'function' ? opts.send : ctx.send
      if (typeof send !== 'function') {
        return { ok: false, status: 500, error: { type: 'internal_error', code: 'missing_sender', message: '缺少上游发送器' } }
      }
      // 取消必须立即终结，不能等上游返回：用 abort 竞速 send 的 Promise。
      let abortResolve = null
      const abortPromise = new Promise((resolve) => { abortResolve = () => resolve({ kind: 'abort' }) })
      const onAbort = () => abortResolve()
      const signal = ctx.signal
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
      const sendPromise = Promise.resolve()
        .then(() => send(target, ctx))
        .then((result) => ({ kind: 'result', result }), (error) => ({ kind: 'error', error }))
      const outcome = await Promise.race([sendPromise, (signal && signal.aborted) ? Promise.resolve({ kind: 'abort' }) : abortPromise])
      try { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort) } catch {}
      if (outcome.kind === 'abort') return canceledResult()
      if (outcome.kind === 'error') {
        const err = outcome.error || {}
        return { ok: false, status: (err && err.status) || 502, error: { type: 'upstream_error', code: (err && err.code) || 'upstream_call_failed', message: (err && err.message) || '上游调用失败' } }
      }
      const result = outcome.result
      if (!result || typeof result !== 'object') {
        return { ok: false, status: 502, error: { type: 'upstream_error', code: 'empty_upstream_result', message: '上游未返回结果' } }
      }
      const verdict = classifyStatus(result.status, result.headers)
      if (verdict.action === 'rate_limited') {
        return { ok: false, status: 429, retryAfterSec: verdict.retryAfterSec, error: verdict.error, upstreamStatus: 429 }
      }
      if (verdict.action === 'upstream_error') {
        return { ok: false, status: verdict.status, retryAfterSec: verdict.retryAfterSec, error: verdict.error, upstreamStatus: result.status }
      }
      if (verdict.action === 'client_error') {
        return { ok: false, status: verdict.status, error: verdict.error, upstreamStatus: result.status, body: result.body }
      }
      return { ok: true, status: verdict.status, body: result.body, headers: result.headers, subjectId: identity.subjectId, target, at: now() }
    },
  }
  return policy
}
