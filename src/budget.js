// 请求生命周期预算（MG-002）：单一 deadline + AbortSignal 贯穿排队、代理 CONNECT、
// 读 body、上游建连/等头、非流式读体、SSE 中继与断流续传。
// 契约见 docs/contracts/request-lifecycle-v1.md；本模块不依赖其他 src 模块，便于独立测试。
export const ABORT_TIMEOUT = 'request_timeout'
export const ABORT_CLIENT = 'client_closed'

const noop = () => {}

/**
 * createBudget({ overallMs, signal?, now? })
 *  - overallMs > 0：从创建时刻起算的墙钟硬上限；0/缺省 = 无全局上限（保持旧语义）
 *  - signal：外部取消源（一般是客户端断开）；中止时 reason=client_closed
 * 返回 { signal, startedAt, deadlineAt, reason, expired(), remaining(), abort(why), dispose() }
 */
export function createBudget(opts = {}) {
  const overallMs = Number(opts.overallMs) > 0 ? Number(opts.overallMs) : 0
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const startedAt = now()
  const deadlineAt = overallMs > 0 ? startedAt + overallMs : null
  const ac = new AbortController()
  const parent = opts.signal || null
  let reason = null
  let timer = null
  let parentListener = null

  const detach = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (parent && parentListener) { try { parent.removeEventListener('abort', parentListener) } catch {} parentListener = null }
  }
  let disposed = false
  const abort = (why) => {
    if (reason || disposed) return
    reason = why === ABORT_CLIENT ? ABORT_CLIENT : ABORT_TIMEOUT
    detach()
    try { ac.abort() } catch {}
  }

  if (deadlineAt != null) {
    timer = setTimeout(() => abort(ABORT_TIMEOUT), Math.max(0, deadlineAt - now()))
    if (timer.unref) timer.unref()
  }
  if (parent) {
    if (parent.aborted) abort(ABORT_CLIENT)
    else {
      parentListener = () => abort(ABORT_CLIENT)
      try { parent.addEventListener('abort', parentListener, { once: true }) } catch { parentListener = null }
    }
  }

  return {
    signal: ac.signal,
    startedAt,
    deadlineAt,
    get reason() { return reason },
    // expired() 表示「已中止（任一原因）」；超时与客户端断开必须分别用 timedOut()/cancelled() 判断，
    // 否则 client_closed 会被误记为 "超出整体预算"（SSE 收尾/日志/记账全部错位）。
    expired() { return reason !== null || (deadlineAt != null && now() >= deadlineAt) },
    timedOut() { return reason === ABORT_TIMEOUT || (reason === null && deadlineAt != null && now() >= deadlineAt) },
    cancelled() { return reason === ABORT_CLIENT },
    remaining() { return deadlineAt == null ? Infinity : Math.max(0, deadlineAt - now()) },
    abort,
    dispose() { detach(); disposed = true; try { ac.abort() } catch {} },
  }
}

/**
 * 取消/超时错误。status=504 供数据面信封；aborted=true 让上层跳过熔断/重试并直接收尾。
 * reason=client_closed 时不应写任何响应。
 */
export function abortedError(reason, detail) {
  const client = reason === ABORT_CLIENT
  const e = new Error(client ? 'request canceled (client closed)' : (detail || 'request timeout'))
  e.code = client ? 'ECANCELED' : 'ETIMEDOUT'
  e.status = 504
  e.aborted = true
  e.reason = client ? ABORT_CLIENT : ABORT_TIMEOUT
  return e
}

/** 可取消 sleep：signal 中止时立即 reject(abortedError)，并清理定时器。 */
export function sleepWith(ms, signal) {
  if (!signal) return new Promise((r) => setTimeout(r, Math.max(0, ms)))
  if (signal.aborted) return Promise.reject(abortedError(ABORT_CLIENT))
  return new Promise((resolve, reject) => {
    let timer = null
    const onAbort = () => { if (timer) clearTimeout(timer); cleanup(); reject(abortedError(ABORT_CLIENT)) }
    const cleanup = () => { try { signal.removeEventListener('abort', onAbort) } catch {} }
    timer = setTimeout(() => { cleanup(); resolve() }, Math.max(0, ms))
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { cleanup() }
  })
}
