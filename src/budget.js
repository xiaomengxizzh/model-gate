// 单请求尝试预算 + 429 归因（G1）
// 目的：把「client retry × request.js retry × forward.js fallback × while 循环」收敛为一个
// 有界预算（总尝试次数 + 墙钟上限），并把 429 按语义分层，保留上游原始 status / Retry-After。
// 纯函数、零依赖，便于离线测试。

const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_MAX_MS = 120000
const DEFAULT_MAX_WAIT_MS = 30000   // 单次按 Retry-After 等待的上限（防止上游给 1h 把请求挂死）

// 上游 429 语义分层：平台额度 / 单模型容量 / 请求速率 / 未知。
// 只做保守的文本匹配，匹配不到归 unknown，绝不臆造。
const QUOTA_RE = /(insufficient|quota|billing|balance|credit|payment|欠费|余额|额度|配额|exceeded your current quota)/i
const CAPACITY_RE = /(capacity|overload|overloaded|busy|concurren|at capacity|server is busy|系统繁忙|并发)/i
const RATE_RE = /(rate.?limit|too many requests|requests per (minute|second)|rpm|tpm|throttl|频率|速率)/i

export function classify429(bodyText, headers) {
  const text = String(bodyText || '')
  const hasRetryAfter = !!(headers && (headers['retry-after'] != null))
  let attribution = 'unknown'
  if (QUOTA_RE.test(text)) attribution = 'platform_quota'
  else if (CAPACITY_RE.test(text)) attribution = 'model_capacity'
  else if (RATE_RE.test(text)) attribution = 'rate_limit'
  else if (hasRetryAfter) attribution = 'rate_limit'   // 有 Retry-After 但无文本：按速率限流处理
  return { attribution, hasRetryAfter }
}

export function parseRetryAfterMs(headers) {
  const ra = headers && headers['retry-after']
  if (ra == null) return null
  const n = parseInt(String(ra), 10)
  if (!isNaN(n) && n >= 0) return n * 1000
  const dt = Date.parse(String(ra))
  if (!isNaN(dt)) return Math.max(0, dt - Date.now())
  return null
}

/**
 * 创建单请求预算。cfg 为 defaults（含 retry/timeout/budget）。
 * opts.noReplay：tool / tool-result 请求（非幂等）→ 只允许一次上游尝试，杜绝自动重放。
 * opts.traceId：仅用于诊断关联。
 */
export function createBudget(cfg = {}, opts = {}) {
  const b = (cfg && cfg.budget) || {}
  const retry = (cfg && cfg.retry) || {}
  const timeout = (cfg && cfg.timeout) || {}
  const configured = Number(b.maxAttempts) > 0 ? Number(b.maxAttempts) : 0
  // 预算是「整请求总尝试数」，不能被 retry.maxAttempts（单上游重试数）压低：
  // 否则 retry.maxAttempts=1 时第一个上游就耗尽预算，目录 fallback 一个都走不到。
  const maxAttempts = opts.noReplay ? 1 : (configured || DEFAULT_MAX_ATTEMPTS)
  const maxMs = Number(b.maxMs) > 0 ? Number(b.maxMs) : (Number(timeout.loopMs) > 0 ? Number(timeout.loopMs) : DEFAULT_MAX_MS)
  return {
    traceId: opts.traceId || '',
    noReplay: !!opts.noReplay,
    maxAttempts,
    maxMs,
    maxWaitMs: Number(b.maxWaitMs) > 0 ? Number(b.maxWaitMs) : DEFAULT_MAX_WAIT_MS,
    startedAt: Date.now(),
    attempts: 0,
    waits: 0,
    exhausted: null,   // null | 'attempts' | 'time'
    failures: [],      // [{pid, status, attribution, at}]
    remainingMs() { return Math.max(0, this.maxMs - (Date.now() - this.startedAt)) },
    // 取一次尝试额度。拒绝时置 exhausted，调用方据此收尾（不再重试）。
    consume() {
      if (this.exhausted) return false
      if (this.attempts >= this.maxAttempts) { this.exhausted = 'attempts'; return false }
      if (Date.now() - this.startedAt >= this.maxMs) { this.exhausted = 'time'; return false }
      this.attempts += 1
      return true
    },
    // 是否值得为 Retry-After 等待：等待后仍需留出至少 1ms 预算
    canWait(ms) {
      if (!(ms > 0)) return true
      return (Date.now() + ms) < (this.startedAt + this.maxMs)
    },
    lastFailure: null,
    noteFailure(pid, status, attribution) {
      this.lastFailure = { pid: pid || null, status: status || null, attribution: attribution || null, at: Date.now() }
      this.failures.push(this.lastFailure)
      if (this.failures.length > 20) this.failures.shift()
    },
    snapshot() {
      return { trace_id: this.traceId, attempts: this.attempts, max_attempts: this.maxAttempts, elapsed_ms: Date.now() - this.startedAt, exhausted: this.exhausted, no_replay: this.noReplay }
    },
  }
}

// 请求是否携带工具语义（工具定义 / 工具结果 / 上一轮 tool_call）：这类请求不自动重放，
// 避免重复生成已被客户端执行的工具调用（尤其是 shell_command / apply_patch）。
export function isToolBearingBody(body) {
  if (!body || typeof body !== 'object') return false
  if (Array.isArray(body.tools) && body.tools.length) return true
  if (Array.isArray(body.input) && body.input.some(it => it && typeof it === 'object' && /tool_call|function_call/.test(String(it.type || '')))) return true
  if (Array.isArray(body.messages) && body.messages.some(m => m && (m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length)))) return true
  return false
}

// 预算耗尽时的统一错误：保留最后一次上游状态与 429 归因，供 forwardChain 映射为 HTTP 响应。
export function budgetError(budget, last = {}) {
  // 用最近一次真实上游失败的状态收尾（402/400 等），只有完全没有上游失败时才退化为 429/408
  const lf = budget && budget.lastFailure ? budget.lastFailure : {}
  const src = (last && last.status) ? last : lf
  const e = new Error('request attempt budget exhausted')
  e.code = 'MG_BUDGET_EXHAUSTED'
  e.status = src.status || (budget.exhausted === 'time' ? 408 : 500)
  e.retries = Math.max(0, budget.attempts - 1)
  e.providerFail = true
  e.budget = budget.snapshot()
  e.retryAfter = (src && src.retryAfter != null) ? src.retryAfter : null
  e.attribution = (src && src.attribution) || null
  return e
}
