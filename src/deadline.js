// 单调截止时间与并发/限流租约（M1-1）：单次请求执行的唯一时间来源，无 IO。
// 契约见 docs/contracts/request-lifecycle-v1.md（M1 扩展：同一 deadline 覆盖排队等待、
// 连接、写请求体、读响应头、流读取与重试等待；等待可被取消唤醒；令牌必须在 finally 归还）。
//
// 设计约束：
//  - 单调时钟（performance.now）为唯一时间源，可注入 now/timers 做确定性测试；
//  - 不用 Date.now 做预算判定，避免系统墙钟跳变造成超时误判；
//  - 等待返回 { ok, reason, waitedMs } 而不是 reject，便于执行器显式判定取消/超时；
//  - deadline.remaining() 是剩余预算，deadline.wait() 自动按剩余预算钳制，绝不越过截止时间；
//  - 租约池（并发 + 速率）的等待也消耗同一 deadline，取消时 waiter 被移除且不占用令牌。

import { performance } from 'node:perf_hooks'

export const DEADLINE_TIMEOUT = 'request_timeout'
export const DEADLINE_CANCELLED = 'client_closed'

const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/** 单调时钟（毫秒，无墙钟语义）。测试可注入同形状函数。 */
export function monotonicNow() { return performance.now() }

function normalizeTimers(timers) {
  if (!timers || typeof timers.setTimeout !== 'function') return DEFAULT_TIMERS
  return timers
}

/** 取消/超时错误：与 budget.abortedError 同一信封语义（status=504、aborted=true、reason）。 */
export function deadlineError(reason, detail) {
  const client = reason === DEADLINE_CANCELLED
  const e = new Error(client ? 'request canceled (client closed)' : (detail || 'request timeout'))
  e.code = client ? 'ECANCELED' : 'ETIMEDOUT'
  e.status = 504
  e.aborted = true
  e.reason = client ? DEADLINE_CANCELLED : DEADLINE_TIMEOUT
  return e
}

/**
 * createDeadline({ overallMs, signal?, now?, timers? })
 *  - overallMs > 0：从创建时刻起算的单调硬上限；0/缺省 = 无整体上限（Infinity）
 *  - signal：外部取消源（客户端断开）；中止后 reason=client_closed
 *  - now/timers：注入时钟与定时器（默认 performance.now 与全局 setTimeout）
 * 返回 { signal, startedAt, deadlineAt, now, timers, reason, remaining(), elapsed(),
 *        expired(), timedOut(), cancelled(), abort(why), wait(ms), dispose() }
 */
export function createDeadline(opts = {}) {
  const overallMs = Number(opts.overallMs) > 0 ? Number(opts.overallMs) : 0
  const now = typeof opts.now === 'function' ? opts.now : monotonicNow
  const timers = normalizeTimers(opts.timers)
  const startedAt = now()
  const deadlineAt = overallMs > 0 ? startedAt + overallMs : null
  const ac = new AbortController()
  const parent = opts.signal || null
  let reason = null
  let disposed = false
  let timer = null
  let parentListener = null

  const detach = () => {
    if (timer) { try { timers.clearTimeout(timer) } catch {} ; timer = null }
    if (parent && parentListener) { try { parent.removeEventListener('abort', parentListener) } catch {} ; parentListener = null }
  }
  const abort = (why) => {
    if (reason || disposed) return false
    reason = why === DEADLINE_CANCELLED ? DEADLINE_CANCELLED : DEADLINE_TIMEOUT
    detach()
    try { ac.abort() } catch {}
    return true
  }
  const settledReason = () => {
    if (reason) return reason
    if (deadlineAt != null && now() >= deadlineAt) return DEADLINE_TIMEOUT
    return null
  }

  if (deadlineAt != null) {
    timer = timers.setTimeout(() => abort(DEADLINE_TIMEOUT), Math.max(0, deadlineAt - now()))
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  if (parent) {
    if (parent.aborted) abort(DEADLINE_CANCELLED)
    else {
      parentListener = () => abort(DEADLINE_CANCELLED)
      try { parent.addEventListener('abort', parentListener, { once: true }) } catch { parentListener = null }
    }
  }

  return {
    signal: ac.signal,
    startedAt,
    deadlineAt,
    now,
    timers,
    get reason() { return reason },
    remaining() { return deadlineAt == null ? Infinity : Math.max(0, deadlineAt - now()) },
    elapsed() { return Math.max(0, now() - startedAt) },
    expired() { return settledReason() !== null },
    timedOut() { return reason === DEADLINE_TIMEOUT || (reason === null && deadlineAt != null && now() >= deadlineAt) },
    cancelled() { return reason === DEADLINE_CANCELLED },
    abort,
    /**
     * 可取消等待：等待时长被剩余预算钳制；deadline 到期或取消时立即 settle（不再等）。
     * 返回 { ok:false, reason, waitedMs } 表示未完成等待（预算/取消），{ ok:true } 表示等满。
     */
    wait(ms, waitOpts = {}) {
      const jitterMs = Math.max(0, Number(waitOpts.jitterMs) || 0)
      const requested = Math.max(0, Number(ms) || 0) + jitterMs
      const settled = settledReason()
      if (settled) return Promise.resolve({ ok: false, reason: settled, waitedMs: 0 })
      const remainingNow = deadlineAt == null ? Infinity : Math.max(0, deadlineAt - now())
      const effective = Number.isFinite(remainingNow) ? Math.min(requested, remainingNow) : requested
      if (requested === 0) return Promise.resolve({ ok: true, reason: null, waitedMs: 0 })
      return new Promise((resolve) => {
        const waitStartedAt = now()
        let done = false
        let waitTimer = null
        const finish = (ok, why) => {
          if (done) return
          done = true
          if (waitTimer) { try { timers.clearTimeout(waitTimer) } catch {} ; waitTimer = null }
          try { ac.signal.removeEventListener('abort', onAbort) } catch {}
          resolve({ ok, reason: why || null, waitedMs: Math.max(0, Math.min(effective, now() - waitStartedAt)) })
        }
        const onAbort = () => finish(false, reason || DEADLINE_CANCELLED)
        if (ac.signal.aborted) { finish(false, reason || DEADLINE_CANCELLED); return }
        try { ac.signal.addEventListener('abort', onAbort, { once: true }) } catch {}
        waitTimer = timers.setTimeout(() => {
          const why = settledReason()
          finish(why === null, why)
        }, effective)
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      detach()
      try { ac.abort() } catch {}
    },
  }
}

/**
 * 并发 + 速率租约池（纯内存）：等待消耗调用方 deadline，可被取消唤醒。
 *  acquire(deadline) -> Promise<{ release(), released }>
 *  - 释放幂等；取消/超时的 waiter 从队列移除，不占用令牌；
 *  - 并发已满或速率闸未开时按 FIFO 排队；
 *  - rate 间隔用注入 timers 调度，取消后不会在旧定时器上补发审批。
 */
export function createLeasePool(opts = {}) {
  const limitRaw = Number(opts.concurrency)
  const concurrency = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : Infinity
  const intervalMs = Math.max(0, Number(opts.intervalMs) || 0)
  const now = typeof opts.now === 'function' ? opts.now : monotonicNow
  const timers = normalizeTimers(opts.timers)
  let active = 0
  let nextGrantAt = 0
  let pumpTimer = null
  const waiters = new Set()

  const makeLease = (waiter) => {
    let released = false
    return {
      get released() { return released },
      release() {
        if (released) return false
        released = true
        active = Math.max(0, active - 1)
        waiter.cleanup()
        pump()
        return true
      },
    }
  }
  const grant = (waiter) => {
    waiter.settled = true
    waiters.delete(waiter)
    active += 1
    if (intervalMs > 0) nextGrantAt = now() + intervalMs
    waiter.cleanup()
    waiter.resolve(makeLease(waiter))
  }
  const pump = () => {
    if (pumpTimer) { try { timers.clearTimeout(pumpTimer) } catch {} ; pumpTimer = null }
    const at = now()
    for (const waiter of [...waiters]) {
      if (waiter.settled) { waiters.delete(waiter); continue }
      if (active >= concurrency) break
      if (at < nextGrantAt) break
      // deadline 在排队期间到期/取消：移除并拒绝（不占用令牌）
      if (waiter.deadline && waiter.deadline.expired()) {
        waiters.delete(waiter)
        waiter.settled = true
        waiter.cleanup()
        waiter.reject(deadlineError(waiter.deadline.reason || DEADLINE_TIMEOUT, 'lease wait deadline exceeded'))
        continue
      }
      grant(waiter)
    }
    if (waiters.size && active < concurrency && now() < nextGrantAt) {
      const delay = Math.max(1, nextGrantAt - now())
      pumpTimer = timers.setTimeout(() => { pumpTimer = null; pump() }, delay)
    }
  }

  const acquire = (deadline) => new Promise((resolve, reject) => {
    if (deadline && deadline.expired()) {
      reject(deadlineError(deadline.reason || DEADLINE_TIMEOUT, 'lease wait deadline exceeded'))
      return
    }
    const waiter = { resolve, reject, settled: false, deadline: deadline || null, cleanup: () => {} }
    waiter.cleanup = () => {
      if (!waiter.deadline || !waiter.deadline.signal) return
      try { waiter.deadline.signal.removeEventListener('abort', waiter.onAbort) } catch {}
    }
    waiter.onAbort = () => {
      if (waiter.settled) return
      waiter.settled = true
      waiters.delete(waiter)
      waiter.cleanup()
      reject(deadlineError(waiter.deadline.reason || DEADLINE_CANCELLED, 'lease wait aborted'))
    }
    if (deadline && deadline.signal) {
      try { deadline.signal.addEventListener('abort', waiter.onAbort, { once: true }) } catch {}
    }
    waiters.add(waiter)
    pump()
  })

  return {
    concurrency,
    intervalMs,
    active() { return active },
    waiting() { return waiters.size },
    pump,
    acquire,
  }
}

/** 并发租约（QPS/在途上限）：createLeasePool 的便捷封装。 */
export function createConcurrencyLease(limit, opts = {}) {
  return createLeasePool({ concurrency: limit, intervalMs: 0, ...opts })
}

/** 速率租约：相邻授权至少间隔 intervalMs。 */
export function createRateLease(intervalMs, opts = {}) {
  return createLeasePool({ concurrency: Number.isFinite(Number(opts.concurrency)) ? opts.concurrency : Infinity, intervalMs, ...opts })
}

/** 可被 abort 唤醒的 promise：signal 中止时 resolve(true)；无 signal 时永不 settle。 */
export function abortPromise(signal) {
  if (!signal) return new Promise(() => {})
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    try { signal.addEventListener('abort', () => resolve(true), { once: true }) } catch { resolve(false) }
  })
}
