// 429 归因 / Retry-After 预算 / 非幂等不重放判定（G1 治理，零第三方依赖）。
// 契约见 docs/contracts/request-lifecycle-v1.md「429 / Retry-After / 非幂等不重放」。
// 本模块只做纯函数判定，不依赖其他 src 模块、不做 IO，便于离线单元测试：
//   - classify429：把上游 429 的语义分成 平台额度 / 模型容量 / 速率限流 / 未知，供错误信封与运维归因；
//   - parseRetryAfterMs / retryWaitCap / retryWaitFits：把 Retry-After 与请求剩余预算对齐，
//     保证「等得下才等，等不下就停」，绝不空等越过 deadline；
//   - isToolBearingBody：识别带工具语义（tools / tool_calls / tool 结果）的请求，
//     这类请求非幂等（可能触发生成 shell_command/apply_patch），默认不自动重放。

/** 429 归因取值（错误信封的 code 由 attributionCode 派生）。 */
export const ATTRIBUTION = {
  PLATFORM_QUOTA: 'platform_quota',
  MODEL_CAPACITY: 'model_capacity',
  RATE_LIMIT: 'rate_limit',
  UNKNOWN: 'unknown',
}

/** 读取上游错误体用于归因的上限：只读 8KB，读完立即销毁连接。 */
export const MAX_ERR_BODY_BYTES = 8 * 1024

/** 单次 Retry-After 等待的硬上限（毫秒）：上游给 1h 也不能把请求挂死。 */
export const MAX_RETRY_AFTER_MS = 30000

/** 等待余量：等待必须给收尾（写响应/释放连接）留出时间，不能卡在 deadline 边界上。 */
export const RETRY_WAIT_MARGIN_MS = 50

// 只做保守的文本匹配：命中即归因，匹配不到一律 unknown，绝不臆造。
const QUOTA_RE = /(insufficient|quota|billing|balance|credit|payment|欠费|余额|额度|配额|exceeded your current quota)/i
const CAPACITY_RE = /(capacity|overload|overloaded|busy|concurren|at capacity|server is busy|系统繁忙|并发)/i
const RATE_RE = /(rate.?limit|too many requests|requests per (minute|second)|\brpm\b|\btpm\b|throttl|频率|速率)/i

/** 大小写不敏感地取一个响应头（Node 上游头多为小写，测试/代理可能给原生大小写）。 */
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null
  const want = String(name).toLowerCase()
  const direct = headers[want]
  if (direct !== undefined && direct !== null) return direct
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want && v !== undefined && v !== null) return v
  }
  return null
}

/**
 * 解析 429 语义。
 * @param {string} bodyText 错误体文本片段（调用方限长，<= MAX_ERR_BODY_BYTES）
 * @param {object} headers  上游响应头
 * @returns {{attribution: 'platform_quota'|'model_capacity'|'rate_limit'|'unknown', hasRetryAfter: boolean}}
 */
export function classify429(bodyText, headers) {
  const text = String(bodyText == null ? '' : bodyText)
  const hasRetryAfter = headerValue(headers, 'retry-after') != null
  let attribution = ATTRIBUTION.UNKNOWN
  if (QUOTA_RE.test(text)) attribution = ATTRIBUTION.PLATFORM_QUOTA
  else if (CAPACITY_RE.test(text)) attribution = ATTRIBUTION.MODEL_CAPACITY
  else if (RATE_RE.test(text)) attribution = ATTRIBUTION.RATE_LIMIT
  else if (hasRetryAfter) attribution = ATTRIBUTION.RATE_LIMIT // 无文本但有 Retry-After：按速率限流处理
  return { attribution, hasRetryAfter }
}

/** 解析 Retry-After：纯秒数或 HTTP-date；无法解析返回 null（= 上游没给可用信号）。 */
export function parseRetryAfterMs(headers) {
  const raw = headerValue(headers, 'retry-after')
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const n = parseInt(s, 10)
  if (/^\d+$/.test(s) && !isNaN(n)) return n * 1000
  const dt = Date.parse(s)
  if (!isNaN(dt)) return Math.max(0, dt - Date.now())
  return null
}

/**
 * 本次请求最多可接受的 Retry-After 等待量（毫秒）。
 * @param {number} remainingMs 请求剩余预算；Infinity = 无整体预算
 * @param {number} maxWaitMs   单次等待上限（默认 MAX_RETRY_AFTER_MS）
 */
export function retryWaitCap(remainingMs, maxWaitMs = MAX_RETRY_AFTER_MS) {
  const hard = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : MAX_RETRY_AFTER_MS
  if (!Number.isFinite(remainingMs)) return hard
  return Math.max(0, Math.min(hard, remainingMs - RETRY_WAIT_MARGIN_MS))
}

/** Retry-After 是否还在本次请求可承受范围内（false = 不许等，立即收尾/换上游）。 */
export function retryWaitFits(retryAfterMs, remainingMs, maxWaitMs = MAX_RETRY_AFTER_MS) {
  if (retryAfterMs == null) return true
  const ms = Number(retryAfterMs)
  if (!Number.isFinite(ms) || ms <= 0) return true
  return ms <= retryWaitCap(remainingMs, maxWaitMs)
}

/** 429 的 Retry-After 响应头值（秒，整数）。null = 上游没给，不臆造。 */
export function retryAfterHeader(ms) {
  if (ms == null) return null
  const n = Number(ms)
  if (!Number.isFinite(n)) return null
  return String(n <= 0 ? 0 : Math.ceil(n / 1000))
}

/** 429 错误信封里的稳定业务码：MG_429_<ATTRIBUTION>。 */
export function attributionCode(attribution) {
  const a = String(attribution || ATTRIBUTION.UNKNOWN).toUpperCase()
  return 'MG_429_' + a
}

/**
 * 请求是否携带工具语义（非幂等）：工具定义、Responses 的 input 工具项、或消息里已有
 * tool_calls / role=tool 的工具结果。这类请求自动重放可能重复触发客户端已执行的工具。
 */
export function isToolBearingBody(body) {
  if (!body || typeof body !== 'object') return false
  if (Array.isArray(body.tools) && body.tools.length) return true
  if (Array.isArray(body.input) && body.input.some((it) => it && typeof it === 'object' && /tool_call|function_call/.test(String(it.type || '')))) return true
  if (Array.isArray(body.messages) && body.messages.some((m) => m && (m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length)))) return true
  return false
}
