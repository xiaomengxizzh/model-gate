// 持久预算账本（M3-2 / T-BUDGET-01/02）：金额记账的唯一主人。
//
// 为什么需要独立模块：决策器（src/routing/decision.js）是纯函数，只知道"候选多少钱"，
// 不知道"这个请求/这个任务/今天已经花了多少"。M3-1 之前 forward.js 把 spent 恒填 0，
// 等于配置了上限却永远不生效；本模块负责把"已花/在途/未知"落盘记账，并给出可审计的
// 额度判定。
//
// 硬约束（违反即拒绝）：
//   1. 整数最小单位：所有金额是 micro（1e-6 货币单位）整数，禁止浮点累加、禁止隐式换算；
//      币种必须显式且与账本一致，不一致直接拒绝（绝不汇率换算）。
//   2. 单写者持久化：进程内互斥 + 跨进程 O_EXCL 锁文件 + tmp/fsync/rename + 目录 fsync；
//      重启后从落盘状态重建在途预留（不猜、不清零）。
//   3. 幂等：(requestId, requestDigest) 同键同摘要 → 返回既有 receipt，不双记；
//      同键不同摘要 → 冲突拒绝；(requestId/digest/taskRef) 只以哈希落盘，不存原值。
//   4. 未知用量保留：unknown 不填 0、不释放，继续占额度，直到 reconcile 核销。
//   5. 实际超预估：如实记账并标注 overrun，后续 reserve 因 caps 不足被拒（不静默吞掉）。
//   6. 跨日：按固定 IANA 时区日切；在途与已结算一律记**原预留日**（跨日结算不挪到新的一天）。
//   7. 对外只暴露脱敏摘要（计数/币种/整数单位/状态码/哈希），不暴露 key、URL、原始错误体。
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

export const LEDGER_VERSION = 1
/** 金额单位：micro = 1e-6 货币单位。所有持久化金额都是这个单位的整数。 */
export const LEDGER_UNIT = 'micro'
export const LEDGER_UNIT_PER_CURRENCY = 1_000_000

/** 预留/结算状态机：reserved → unknown → settled/released。终态不可回退。 */
export const LEDGER_STATUS = Object.freeze({
  RESERVED: 'reserved',
  UNKNOWN: 'unknown',
  SETTLED: 'settled',
  RELEASED: 'released',
})

/** 稳定错误码（日志/测试/接线只认这些，不要解析 message）。 */
export const LEDGER_ERROR = Object.freeze({
  BAD_REQUEST: 'LEDGER_BAD_REQUEST',
  CURRENCY_MISMATCH: 'LEDGER_CURRENCY_MISMATCH',
  CONFIG_CONFLICT: 'LEDGER_CONFIG_CONFLICT',
  CAP_EXCEEDED: 'LEDGER_CAP_EXCEEDED',
  IDEMPOTENCY_CONFLICT: 'LEDGER_IDEMPOTENCY_CONFLICT',
  STATE_INVALID: 'LEDGER_STATE_INVALID',
  QUOTE_STALE: 'LEDGER_QUOTE_STALE',
  BUSY: 'LEDGER_BUSY',
  CORRUPT: 'LEDGER_CORRUPT',
  IO: 'LEDGER_IO',
})

const SAFE_DETAIL_KEYS = new Set([
  'dimension', 'attemptId', 'requestKey', 'taskKey', 'day', 'dayZone', 'currency',
  'status', 'limitMicro', 'usedMicro', 'maxCostMicro', 'actualMicro', 'quoteVersion',
  'lockTimeoutMs', 'expected', 'code',
])

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const SAFE_LABEL_RE = /(sk-|bearer|api[_-]?key|secret|token|password|passwd|:\/\/|@|\?|=)/i
const CURRENCY_RE = /^[A-Z]{3,8}$/

/** 账本错误：code 稳定，message 由本模块自己拼（不含调用方原文），detail 只允许白名单字段。 */
export class LedgerError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
    this.detail = safeDetail(detail)
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}

function safeDetail(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) {
    if (!SAFE_DETAIL_KEYS.has(k)) continue
    if (v == null) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && SAFE_ID_RE.test(v)) out[k] = v
  }
  return out
}

const toStr = (v) => (v == null ? '' : String(v))
const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex')

/**
 * 标签脱敏：模型/供应商名、quoteVersion、备注等只作展示，一旦像凭据/URL 就替换成 redacted。
 * 说明：这类字段不参与幂等与额度计算，脱敏不会影响账目。
 */
export function safeLabel(value, max = 64) {
  const s = toStr(value).trim()
  if (!s) return null
  if (s.length > max) return 'redacted'
  if (SAFE_LABEL_RE.test(s)) return 'redacted'
  return s
}

/** 金额校验：必须是非负整数 micro（拒绝浮点、NaN、Infinity、超安全整数）。 */
export function assertMicroAmount(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, name + ' 必须是非负整数最小单位（' + LEDGER_UNIT + '），拒绝浮点/非整数')
  }
  return value
}

/** 币种规范化：ISO 风格 3-8 位大写；不一致由调用方比较，不做任何换算。 */
export function normalizeCurrency(value, name = 'currency') {
  const s = toStr(value).trim().toUpperCase()
  if (!CURRENCY_RE.test(s)) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, name + ' 必须是显式币种代码（如 USD）')
  return s
}

const DAY_FORMATTERS = new Map()

/** 任意时区一天 = [dayKey 00:00, next 00:00)；用 Intl 取该时区的本地日期，不依赖进程 TZ。 */
export function dayKeyAt(ms, timeZone) {
  const n = Number(ms)
  if (!Number.isFinite(n)) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'at 必须是有限毫秒时间戳')
  let fmt = DAY_FORMATTERS.get(timeZone)
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    } catch {
      throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'dayZone 不是合法的 IANA 时区')
    }
    DAY_FORMATTERS.set(timeZone, fmt)
  }
  const parts = fmt.formatToParts(new Date(n))
  const pick = (type) => {
    const hit = parts.find((p) => p.type === type)
    return hit ? hit.value : ''
  }
  return pick('year') + '-' + pick('month') + '-' + pick('day')
}

const statePathOf = (dir) => join(dir, 'ledger.json')
const lockPathOf = (dir) => join(dir, 'ledger.lock')
const delay = (ms) => new Promise((done) => { setTimeout(done, Math.max(1, ms)) })

function fsyncDir(dir) {
  let fd = null
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (e) {
    const code = e && e.code
    // 部分文件系统不支持对目录 fsync（EINVAL/EPERM 等）：尽力而为，但不吞掉真正的 IO 错误。
    if (code && !['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'EBADF', 'EACCES'].includes(code)) {
      throw new LedgerError(LEDGER_ERROR.IO, '账本目录 fsync 失败')
    }
  } finally {
    if (fd != null) { try { closeSync(fd) } catch {} }
  }
}

function atomicWriteState(dir, state) {
  mkdirSync(dir, { recursive: true })
  const target = statePathOf(dir)
  const tmp = join(dir, '.' + basename(target) + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp')
  const text = JSON.stringify(state, null, 2) + '\n'
  let fd = null
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeSync(fd, Buffer.from(text, 'utf8'))
    fsyncSync(fd)
  } catch (e) {
    try { if (fd != null) closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw new LedgerError(LEDGER_ERROR.IO, '写入账本临时文件失败')
  }
  try { closeSync(fd) } catch {}
  try {
    renameSync(tmp, target)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw new LedgerError(LEDGER_ERROR.IO, '原子替换账本失败')
  }
  fsyncDir(dir)
}

function emptyState(config) {
  return {
    version: LEDGER_VERSION,
    unit: LEDGER_UNIT,
    currency: config.currency,
    dayZone: config.dayZone,
    updatedAt: config.nowMs,
    attempts: {},
  }
}

function readState(dir, config) {
  let raw
  try {
    raw = readFileSync(statePathOf(dir), 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw new LedgerError(LEDGER_ERROR.IO, '读取账本失败')
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 绝不静默重置：账本损坏时宁可停机，也不能把已花的钱"忘记"。
    throw new LedgerError(LEDGER_ERROR.CORRUPT, '账本文件不是合法 JSON，拒绝自动重置（请人工核查/恢复备份）')
  }
  validateState(parsed, config)
  return parsed
}

function validateState(state, config) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new LedgerError(LEDGER_ERROR.CORRUPT, '账本结构非法')
  }
  if (state.version !== LEDGER_VERSION) {
    throw new LedgerError(LEDGER_ERROR.CORRUPT, '账本版本不支持：' + toStr(state.version), { expected: LEDGER_VERSION })
  }
  if (state.unit !== LEDGER_UNIT) {
    throw new LedgerError(LEDGER_ERROR.CORRUPT, '账本单位不是 ' + LEDGER_UNIT)
  }
  if (state.currency !== config.currency) {
    throw new LedgerError(LEDGER_ERROR.CURRENCY_MISMATCH, '账本币种与本实例配置不一致：禁止隐式换算', {
      currency: config.currency,
    })
  }
  if (state.dayZone !== config.dayZone) {
    throw new LedgerError(LEDGER_ERROR.CONFIG_CONFLICT, '账本 dayZone 与本实例不一致：日切口径不允许中途改变', {
      dayZone: config.dayZone,
    })
  }
  if (!state.attempts || typeof state.attempts !== 'object' || Array.isArray(state.attempts)) {
    throw new LedgerError(LEDGER_ERROR.CORRUPT, '账本 attempts 段非法')
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

const HELD_LOCKS = new Set()

function lockIsStale(path, staleLockMs) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return true
  }
  let info = null
  try { info = JSON.parse(raw) } catch { info = null }
  if (!info || typeof info !== 'object' || !Number.isSafeInteger(info.pid)) {
    try {
      const st = statSync(path)
      return (Date.now() - Number(st.mtimeMs)) > staleLockMs
    } catch {
      return true
    }
  }
  // 同进程残锁：本进程当前没有持有该 token ⇒ 上一次崩溃留下的，可清理。
  if (info.pid === process.pid) return !HELD_LOCKS.has(toStr(info.token))
  return !pidAlive(info.pid)
}

async function acquireFileLock(dir, lockTimeoutMs, staleLockMs) {
  const path = lockPathOf(dir)
  const deadline = Date.now() + lockTimeoutMs
  for (;;) {
    const token = randomBytes(8).toString('hex')
    let acquired = false
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }))
        fsyncSync(fd)
      } finally {
        try { closeSync(fd) } catch {}
      }
      acquired = true
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw new LedgerError(LEDGER_ERROR.IO, '获取账本锁失败（' + toStr(e && e.code) + '）')
    }
    if (acquired) {
      HELD_LOCKS.add(token)
      return token
    }
    if (lockIsStale(path, staleLockMs)) {
      try { unlinkSync(path) } catch {}
      continue
    }
    if (Date.now() >= deadline) {
      throw new LedgerError(LEDGER_ERROR.BUSY, '账本正被其他写者占用（跨进程锁等待超时）', { lockTimeoutMs })
    }
    await delay(2)
  }
}

function releaseFileLock(dir, token) {
  HELD_LOCKS.delete(token)
  const path = lockPathOf(dir)
  let raw = null
  try { raw = readFileSync(path, 'utf8') } catch { return }
  let info = null
  try { info = JSON.parse(raw) } catch { info = null }
  // 只删自己持有的锁：避免把别人刚抢到的锁误删。
  if (info && toStr(info.token) === token) {
    try { unlinkSync(path) } catch {}
  }
}

// 进程内互斥：同一个目录的所有写事务串行化（跨进程由锁文件负责）。
const WRITER_QUEUES = new Map()

async function withSingleWriter(dirKey, fn) {
  const prev = WRITER_QUEUES.get(dirKey) || Promise.resolve()
  let release = null
  const mine = new Promise((done) => { release = done })
  const chained = prev.then(() => mine)
  WRITER_QUEUES.set(dirKey, chained)
  await prev
  try {
    return await fn()
  } finally {
    if (release) release()
    if (WRITER_QUEUES.get(dirKey) === chained) WRITER_QUEUES.delete(dirKey)
  }
}

function normalizeCandidateLabel(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {}
  const model = toStr(c.model).trim()
  const provider = toStr(c.provider).trim()
  if (!model || !provider) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'candidate 必须同时给出 model 与 provider（未知成本不得静默归到某个候选上）')
  return {
    model: safeLabel(model) || 'redacted',
    provider: safeLabel(provider) || 'redacted',
  }
}

function normalizeQuote(quote, nowMs, quoteMaxAgeMs) {
  const q = quote && typeof quote === 'object' ? quote : null
  if (!q) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'quote 缺失：未知成本必须显式标注 unknown，不得默认 0')
  if (q.currency == null) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'quote.currency 缺失：金额必须带显式币种')
  const currencyIn = normalizeCurrency(q.currency, 'quote.currency')
  const amountMicro = assertMicroAmount(q.amountMicro, 'quote.amountMicro')
  const worstRaw = q.worstCaseMicro == null ? amountMicro : assertMicroAmount(q.worstCaseMicro, 'quote.worstCaseMicro')
  if (worstRaw < amountMicro) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'quote.worstCaseMicro 不得小于 amountMicro')
  const quoteVersion = q.version == null ? '' : toStr(q.version)
  if (!quoteVersion) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'quote.version 缺失：无法证明预留用的是哪一版报价')
  if (quoteVersion.length > 64) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'quote.version 过长（≤64）')
  if (q.quotedAt != null) {
    const quotedAt = Number(q.quotedAt)
    if (!Number.isFinite(quotedAt)) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'quote.quotedAt 必须是毫秒时间戳')
    if (quoteMaxAgeMs > 0 && nowMs - quotedAt > quoteMaxAgeMs) {
      throw new LedgerError(LEDGER_ERROR.QUOTE_STALE, '报价快照已过期：拒绝用旧报价预留额度', {
        quoteVersion: safeLabel(quoteVersion) || 'redacted',
      })
    }
  } else if (quoteMaxAgeMs > 0) {
    throw new LedgerError(LEDGER_ERROR.QUOTE_STALE, '开启了报价时效校验但 quote.quotedAt 缺失')
  }
  return {
    currency: currencyIn,
    quoteMicro: amountMicro,
    worstCaseMicro: worstRaw,
    maxCostMicro: Math.max(amountMicro, worstRaw),
    quoteVersion: safeLabel(quoteVersion) || 'redacted',
  }
}

function chargeMicroOf(attempt) {
  if (!attempt) return 0
  if (attempt.status === LEDGER_STATUS.RELEASED) return 0
  if (attempt.status === LEDGER_STATUS.SETTLED) {
    return Number.isSafeInteger(attempt.actualMicro) ? attempt.actualMicro : attempt.maxCostMicro
  }
  return attempt.maxCostMicro
}

function dayUsageMicro(state, day) {
  let sum = 0
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.day === day) sum += chargeMicroOf(attempt)
  }
  return sum
}

function taskUsageMicro(state, taskKey) {
  if (!taskKey) return 0
  let sum = 0
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.taskKey === taskKey) sum += chargeMicroOf(attempt)
  }
  return sum
}

function requestUsageMicro(state, requestKey) {
  let sum = 0
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.requestKey === requestKey) sum += chargeMicroOf(attempt)
  }
  return sum
}

function indexState(state) {
  const byKey = new Map()
  const byRequest = new Map()
  for (const attempt of Object.values(state.attempts)) {
    const key = attempt.requestKey + '|' + attempt.digestKey
    const prev = byKey.get(key)
    if (!prev || Number(attempt.createdAt) >= Number(prev.createdAt)) byKey.set(key, attempt)
    const digests = byRequest.get(attempt.requestKey)
    if (digests) digests.add(attempt.digestKey)
    else byRequest.set(attempt.requestKey, new Set([attempt.digestKey]))
  }
  return { byKey, byRequest }
}

/**
 * 打开（或创建）账本。同步读取落盘状态：重启后立即恢复在途预留，不需要先写一次。
 * @param {object} options
 *   dir（必需，账本目录）、currency（默认 USD）、dayZone（默认 Asia/Shanghai）、
 *   caps{requestMicro,taskMicro,dayMicro}（0/缺省 = 不限）、now()=>ms、at 固定时间、
 *   lockTimeoutMs（默认 2000）、staleLockMs（默认 10000）、quoteMaxAgeMs（默认 0 = 不校验）
 */
export function openLedger(options = {}) {
  const dirRaw = toStr(options.dir).trim()
  if (!dirRaw) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'openLedger 需要 dir')
  const dir = resolve(dirRaw)
  const currency = normalizeCurrency(options.currency == null ? 'USD' : options.currency)
  const dayZone = options.dayZone == null ? 'Asia/Shanghai' : toStr(options.dayZone).trim()
  dayKeyAt(0, dayZone) // 提前校验时区（非法直接抛 BAD_REQUEST）
  const capsIn = options.caps && typeof options.caps === 'object' ? options.caps : {}
  const caps = {
    requestMicro: capsIn.requestMicro == null ? 0 : assertMicroAmount(capsIn.requestMicro, 'caps.requestMicro'),
    taskMicro: capsIn.taskMicro == null ? 0 : assertMicroAmount(capsIn.taskMicro, 'caps.taskMicro'),
    dayMicro: capsIn.dayMicro == null ? 0 : assertMicroAmount(capsIn.dayMicro, 'caps.dayMicro'),
  }
  const lockTimeoutMs = Number.isFinite(Number(options.lockTimeoutMs)) ? Math.max(1, Number(options.lockTimeoutMs)) : 2000
  const staleLockMs = Number.isFinite(Number(options.staleLockMs)) ? Math.max(0, Number(options.staleLockMs)) : 10000
  const quoteMaxAgeMs = Number.isFinite(Number(options.quoteMaxAgeMs)) ? Math.max(0, Number(options.quoteMaxAgeMs)) : 0
  const clock = typeof options.now === 'function' ? options.now : null
  const fixedAt = Number.isFinite(Number(options.at)) ? Number(options.at) : null
  const nowMs = () => (fixedAt != null ? fixedAt : clock ? Number(clock()) : Date.now())
  const config = { currency, dayZone, nowMs: nowMs() }

  mkdirSync(dir, { recursive: true })
  // 打开即校验：损坏/币种不符/时区变更都必须在这里失败，不能等到第一次写入。
  readState(dir, config)

  async function transaction(fn) {
    return withSingleWriter(dir, async () => {
      const token = await acquireFileLock(dir, lockTimeoutMs, staleLockMs)
      try {
        const at = nowMs()
        const state = readState(dir, config) || emptyState({ currency, dayZone, nowMs: at })
        return await fn(state, at)
      } finally {
        releaseFileLock(dir, token)
      }
    })
  }

  function receiptOf(attempt, state, extra = {}) {
    const requestKey = attempt.requestKey
    const taskKey = attempt.taskKey
    return Object.assign({
      attemptId: attempt.attemptId,
      requestKey,
      digestKey: attempt.digestKey,
      taskKey,
      taskLabel: attempt.taskLabel,
      candidate: { model: attempt.candidate.model, provider: attempt.candidate.provider },
      day: attempt.day,
      dayZone,
      currency,
      unit: LEDGER_UNIT,
      status: attempt.status,
      quoteMicro: attempt.quoteMicro,
      worstCaseMicro: attempt.worstCaseMicro,
      maxCostMicro: attempt.maxCostMicro,
      quoteVersion: attempt.quoteVersion,
      actualMicro: Number.isSafeInteger(attempt.actualMicro) ? attempt.actualMicro : null,
      overrun: attempt.status === LEDGER_STATUS.SETTLED && Number.isSafeInteger(attempt.actualMicro) && attempt.actualMicro > attempt.maxCostMicro,
      reservedAt: attempt.reservedAt,
      settledAt: attempt.settledAt == null ? null : attempt.settledAt,
      releasedAt: attempt.releasedAt == null ? null : attempt.releasedAt,
      duplicate: false,
      caps: { requestMicro: caps.requestMicro, taskMicro: caps.taskMicro, dayMicro: caps.dayMicro },
      usage: {
        requestMicro: requestUsageMicro(state, requestKey),
        taskMicro: taskUsageMicro(state, taskKey),
        dayMicro: dayUsageMicro(state, attempt.day),
      },
    }, extra)
  }

  function validateAttemptId(attemptId) {
    if (attemptId == null) return null
    const s = toStr(attemptId)
    if (!SAFE_ID_RE.test(s)) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'attemptId 必须匹配 [A-Za-z0-9_.:-]{1,64}')
    return s
  }

  /**
   * 先预留再发送（reserveThenSend 的第一步）。
   * 调用方契约：只有 receipt.duplicate === false 时才允许发上游（本次尝试是新的）；
   * duplicate === true 表示这个 (requestId, digest) 已经启动过 —— 必须走对账/复用，绝不能重放。
   */
  async function reserve(request = {}) {
    const requestKey = sha256(toStr(request.requestId).trim())
    if (!toStr(request.requestId).trim()) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'requestId 必须是非空字符串')
    const digestRaw = toStr(request.requestDigest).trim()
    if (!digestRaw) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'requestDigest 必须是非空字符串（请求内容摘要）')
    const digestKey = sha256(digestRaw)
    const taskRaw = toStr(request.taskRef).trim()
    const taskKey = taskRaw ? sha256(taskRaw).slice(0, 32) : null
    const taskLabel = safeLabel(taskRaw)
    const candidate = normalizeCandidateLabel(request.candidate)
    const attemptIdIn = validateAttemptId(request.attemptId)
    const at = Number.isFinite(Number(request.at)) ? Number(request.at) : nowMs()
    const quote = normalizeQuote(request.quote, at, quoteMaxAgeMs)
    if (quote.currency !== currency) {
      // 显式拒绝而不是隐式换算：跨币种预留会直接算错额度。
      throw new LedgerError(LEDGER_ERROR.CURRENCY_MISMATCH, '报价币种与账本不一致：拒绝预留（不做汇率换算）', { currency })
    }

    return transaction(async (state, txAt) => {
      const idx = indexState(state)
      const key = requestKey + '|' + digestKey
      const prior = idx.byKey.get(key)
      const digests = idx.byRequest.get(requestKey)
      // 同 requestId 但摘要不同 ⇒ 客户端串号/重放，直接拒绝（绝不换一笔新账）。
      if (digests && !digests.has(digestKey)) {
        throw new LedgerError(LEDGER_ERROR.IDEMPOTENCY_CONFLICT, '同一 requestId 的请求摘要不一致：拒绝记新账', {
          requestKey: requestKey.slice(0, 12),
        })
      }
      if (prior && prior.status !== LEDGER_STATUS.RELEASED) {
        // 同键同摘要且"已经启动"：返回既有 receipt，不双记、不发新调用。
        return { receipt: receiptOf(prior, state, { duplicate: true }) }
      }

      // 预留日以事务时刻为准（与 at 一致：注入时钟下完全确定）。
      const day = dayKeyAt(txAt, dayZone)
      const requestUsed = requestUsageMicro(state, requestKey)
      const taskUsed = taskUsageMicro(state, taskKey)
      const dayUsed = dayUsageMicro(state, day)
      if (caps.requestMicro > 0 && requestUsed + quote.maxCostMicro > caps.requestMicro) {
        throw capError('request', caps.requestMicro, requestUsed, quote.maxCostMicro)
      }
      if (caps.taskMicro > 0 && taskUsed + quote.maxCostMicro > caps.taskMicro) {
        throw capError('task', caps.taskMicro, taskUsed, quote.maxCostMicro)
      }
      if (caps.dayMicro > 0 && dayUsed + quote.maxCostMicro > caps.dayMicro) {
        throw capError('day', caps.dayMicro, dayUsed, quote.maxCostMicro)
      }

      const attemptId = attemptIdIn || ('att-' + randomBytes(8).toString('hex'))
      if (state.attempts[attemptId]) {
        throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'attemptId 已存在', { attemptId })
      }
      const attempt = {
        attemptId,
        requestKey,
        digestKey,
        taskKey,
        taskLabel,
        candidate,
        day,
        reservedAt: txAt,
        quoteMicro: quote.quoteMicro,
        worstCaseMicro: quote.worstCaseMicro,
        maxCostMicro: quote.maxCostMicro,
        quoteVersion: quote.quoteVersion,
        status: LEDGER_STATUS.RESERVED,
        actualMicro: null,
        createdAt: txAt,
        updatedAt: txAt,
        settledAt: null,
        releasedAt: null,
      }
      state.attempts[attemptId] = attempt
      state.updatedAt = txAt
      atomicWriteState(dir, state)
      return { receipt: receiptOf(attempt, state) }
    }).then((r) => r.receipt)
  }

  function capError(dimension, limitMicro, usedMicro, maxCostMicro) {
    return new LedgerError(LEDGER_ERROR.CAP_EXCEEDED, '额度不足（' + dimension + '）：拒绝预留，且不产生任何副作用', {
      dimension, limitMicro, usedMicro, maxCostMicro,
    })
  }

  function attemptFor(state, attemptId) {
    const id = toStr(attemptId).trim()
    if (!id) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'attemptId 必须是非空字符串')
    const attempt = state.attempts[id]
    if (!attempt) throw new LedgerError(LEDGER_ERROR.STATE_INVALID, '账本里没有该 attemptId', { attemptId: id })
    return attempt
  }

  async function settle(attemptId, options = {}) {
    const actualMicro = assertMicroAmount(options.actualMicro, 'actualMicro')
    if (options.currency == null) throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, '结算必须显式给 currency（禁止默认币种）')
    const currencyIn = normalizeCurrency(options.currency)
    if (currencyIn !== currency) {
      throw new LedgerError(LEDGER_ERROR.CURRENCY_MISMATCH, '结算币种与账本不一致：禁止隐式换算', { currency })
    }
    const at = Number.isFinite(Number(options.at)) ? Number(options.at) : nowMs()
    return transaction(async (state, txAt) => {
      const attempt = attemptFor(state, attemptId)
      if (attempt.status === LEDGER_STATUS.SETTLED) {
        if (attempt.actualMicro === actualMicro) return { receipt: receiptOf(attempt, state, { duplicate: true }) }
        throw new LedgerError(LEDGER_ERROR.STATE_INVALID, '该 attempt 已按不同金额结算过：拒绝二次记账', { attemptId: attempt.attemptId })
      }
      if (attempt.status === LEDGER_STATUS.RELEASED) {
        throw new LedgerError(LEDGER_ERROR.STATE_INVALID, '该 attempt 已核销为"未执行"，不能结算', { attemptId: attempt.attemptId })
      }
      attempt.status = LEDGER_STATUS.SETTLED
      attempt.actualMicro = actualMicro
      attempt.settledAt = txAt
      attempt.updatedAt = txAt
      state.updatedAt = txAt
      atomicWriteState(dir, state)
      return { receipt: receiptOf(attempt, state) }
    }).then((r) => r.receipt)
  }

  async function release(attemptId, options = {}) {
    if (options.verifiedNotExecuted !== true) {
      throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'release 必须显式 verifiedNotExecuted: true（未核实不得释放额度）')
    }
    const at = Number.isFinite(Number(options.at)) ? Number(options.at) : nowMs()
    return transaction(async (state, txAt) => {
      const attempt = attemptFor(state, attemptId)
      if (attempt.status === LEDGER_STATUS.RELEASED) return { receipt: receiptOf(attempt, state, { duplicate: true }) }
      if (attempt.status === LEDGER_STATUS.SETTLED) {
        throw new LedgerError(LEDGER_ERROR.STATE_INVALID, '该 attempt 已结算，不能核销为未执行', { attemptId: attempt.attemptId })
      }
      attempt.status = LEDGER_STATUS.RELEASED
      attempt.actualMicro = null
      attempt.releasedAt = txAt
      attempt.updatedAt = txAt
      state.updatedAt = txAt
      atomicWriteState(dir, state)
      return { receipt: receiptOf(attempt, state) }
    }).then((r) => r.receipt)
  }

  async function markUnknown(attemptId, options = {}) {
    const at = Number.isFinite(Number(options.at)) ? Number(options.at) : nowMs()
    return transaction(async (state, txAt) => {
      const attempt = attemptFor(state, attemptId)
      if (attempt.status === LEDGER_STATUS.UNKNOWN) return { receipt: receiptOf(attempt, state, { duplicate: true }) }
      if (attempt.status !== LEDGER_STATUS.RESERVED) {
        throw new LedgerError(LEDGER_ERROR.STATE_INVALID, '只有 reserved 可以标记为 unknown', { attemptId: attempt.attemptId, status: attempt.status })
      }
      attempt.status = LEDGER_STATUS.UNKNOWN
      attempt.updatedAt = txAt
      state.updatedAt = txAt
      atomicWriteState(dir, state)
      return { receipt: receiptOf(attempt, state) }
    }).then((r) => r.receipt)
  }

  /**
   * 人工/半自动对账收口：unknown（或 reserved）必须二选一——
   * 给出实际金额（settle）或声明已验证未执行（release）。未知预留不会自己消失。
   */
  async function reconcile(attemptId, options = {}) {
    const hasActual = options.actualMicro != null
    const verifiedNotExecuted = options.verifiedNotExecuted === true
    if (hasActual === verifiedNotExecuted) {
      throw new LedgerError(LEDGER_ERROR.BAD_REQUEST, 'reconcile 必须且只能给一个结论：actualMicro(+currency) 或 verifiedNotExecuted: true')
    }
    const extra = { reconciled: true }
    if (hasActual) {
      const receipt = await settle(attemptId, { actualMicro: options.actualMicro, currency: options.currency, at: options.at })
      return Object.assign(receipt, extra)
    }
    const receipt = await release(attemptId, { verifiedNotExecuted: true, at: options.at })
    return Object.assign(receipt, extra)
  }

  function getAttempt(attemptId) {
    const at = nowMs()
    const state = readState(dir, config) || emptyState({ currency, dayZone, nowMs: at })
    const attempt = state.attempts[toStr(attemptId).trim()]
    return attempt ? receiptOf(attempt, state, { duplicate: true }) : null
  }

  function getRequestAttempt(requestId, requestDigest) {
    const requestKey = sha256(toStr(requestId).trim())
    const digestKey = sha256(toStr(requestDigest).trim())
    if (!toStr(requestId).trim() || !toStr(requestDigest).trim()) return null
    const at = nowMs()
    const state = readState(dir, config) || emptyState({ currency, dayZone, nowMs: at })
    const idx = indexState(state)
    const attempt = idx.byKey.get(requestKey + '|' + digestKey)
    return attempt ? receiptOf(attempt, state, { duplicate: true }) : null
  }

  /** 额度视图（脱敏）：某个时刻的日/任务/请求口径用量，全部是 micro 整数。 */
  function usage(query = {}) {
    const at = Number.isFinite(Number(query.at)) ? Number(query.at) : nowMs()
    const day = dayKeyAt(at, dayZone)
    const state = readState(dir, config) || emptyState({ currency, dayZone, nowMs: at })
    const requestKey = query.requestId == null ? null : sha256(toStr(query.requestId).trim())
    const taskKey = query.taskRef == null ? null : (toStr(query.taskRef).trim() ? sha256(toStr(query.taskRef).trim()).slice(0, 32) : null)
    return {
      currency,
      unit: LEDGER_UNIT,
      dayZone,
      day,
      requestMicro: requestKey ? requestUsageMicro(state, requestKey) : null,
      taskMicro: taskKey ? taskUsageMicro(state, taskKey) : null,
      dayMicro: dayUsageMicro(state, day),
      requestKey: requestKey ? requestKey.slice(0, 12) : null,
      taskKey: taskKey ? taskKey.slice(0, 12) : null,
      caps: { requestMicro: caps.requestMicro, taskMicro: caps.taskMicro, dayMicro: caps.dayMicro },
    }
  }

  /** 脱敏摘要：只有计数、币种、单位与状态分布，不含模型/请求/任务原文。 */
  function summary() {
    const at = nowMs()
    const state = readState(dir, config) || emptyState({ currency, dayZone, nowMs: at })
    const counts = { total: 0, reserved: 0, unknown: 0, settled: 0, released: 0 }
    const microByStatus = { reserved: 0, unknown: 0, settled: 0, released: 0 }
    const days = {}
    for (const attempt of Object.values(state.attempts)) {
      counts.total += 1
      if (counts[attempt.status] != null) counts[attempt.status] += 1
      const charge = chargeMicroOf(attempt)
      if (microByStatus[attempt.status] != null) microByStatus[attempt.status] += charge
      days[attempt.day] = (days[attempt.day] || 0) + charge
    }
    return {
      currency,
      unit: LEDGER_UNIT,
      dayZone,
      updatedAt: state.updatedAt == null ? null : state.updatedAt,
      counts,
      microByStatus,
      days,
      caps: { requestMicro: caps.requestMicro, taskMicro: caps.taskMicro, dayMicro: caps.dayMicro },
    }
  }

  /** 重启恢复：把落盘的在途/未知预留读回来（供启动自检/对账队列）。 */
  function recover(query = {}) {
    const at = Number.isFinite(Number(query.at)) ? Number(query.at) : nowMs()
    const state = readState(dir, config) || emptyState({ currency, dayZone, nowMs: at })
    const day = dayKeyAt(at, dayZone)
    const inflight = []
    const unknown = []
    let inflightMicro = 0
    let unknownMicro = 0
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.status === LEDGER_STATUS.RESERVED) {
        inflight.push(receiptOf(attempt, state, { duplicate: true }))
        inflightMicro += chargeMicroOf(attempt)
      } else if (attempt.status === LEDGER_STATUS.UNKNOWN) {
        unknown.push(receiptOf(attempt, state, { duplicate: true }))
        unknownMicro += chargeMicroOf(attempt)
      }
    }
    return {
      currency,
      unit: LEDGER_UNIT,
      dayZone,
      day,
      dayMicro: dayUsageMicro(state, day),
      inflight,
      unknown,
      inflightMicro,
      unknownMicro,
      recovered: inflight.length + unknown.length,
      caps: { requestMicro: caps.requestMicro, taskMicro: caps.taskMicro, dayMicro: caps.dayMicro },
    }
  }

  /** 关闭账本：当前实现不持有长期句柄，保留以固定生命周期契约。 */
  function close() {
    return Promise.resolve()
  }

  return {
    dir,
    currency,
    unit: LEDGER_UNIT,
    dayZone,
    caps,
    reserve,
    settle,
    release,
    markUnknown,
    reconcile,
    getAttempt,
    getRequestAttempt,
    usage,
    summary,
    recover,
    close,
  }
}
