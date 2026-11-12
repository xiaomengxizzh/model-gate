// N06 可观测收据与事件（版本化、有界历史、显式脱敏关联）。
// 契约：docs/contracts/uhr-inference-v1.md 的「回执」语义在运行时的落点。
//
// 三条边界：
//   1. **收据分三类**：request（谁在什么终态）/ attempt（每个上游尝试的终态）/ usage（用量与费用）。
//      未知用量一律 'unknown'，绝不填 0；只有「确证未发出」才可以写 0。
//   2. **stats 按终态只记一次**：以 (requestId, attemptId, terminal) 去重；重复上报只计 deduped，
//      不改变 stats（断流重连、重试路径重复回调都不会双计）。
//   3. **父子只做显式脱敏关联**：父/子引用必须由调用方显式传入、且只能是 sha256 派生的短 id
//      （hashId()）。原始 request id / 线程 id / 正文 / 密文 / Key 一律不得进入事件。
//
// 纯内存、有界（ring），不写盘、不联网；SSE 只做「短期缓冲 + 快照重放」，不做持久订阅。
import { createHash } from 'node:crypto'

export const OBSERVABILITY_CONTRACT = 'mg-observability-v1'
export const OBSERVABILITY_VERSION = 1
export const DEFAULT_CAPACITY = 200
export const MAX_CAPACITY = 5000
export const USAGE_UNKNOWN = 'unknown'

const KINDS = Object.freeze(['request', 'attempt', 'usage'])
// 明确禁止出现在事件里的字段（正文/凭据/密文/原始标识）。命中即拒绝，不静默丢弃。
const FORBIDDEN_FIELDS = Object.freeze([
  'body', 'messages', 'prompt', 'input', 'content', 'output', 'text',
  'authorization', 'apikey', 'api_key', 'key', 'token', 'secret', 'cookie',
  'encrypted', 'encryptedcontent', 'encryptedtaskid', 'ciphertext', 'parentid', 'threadid', 'sessionid',
])
const HASHED_ID_RE = /^[a-f0-9]{8,64}$/

export function hashId (value, salt = 'mg-obs-v1') {
  const raw = value == null ? '' : String(value)
  if (!raw) return null
  return createHash('sha256').update(salt + '|' + raw).digest('hex').slice(0, 16)
}

export function isHashedId (value) {
  return typeof value === 'string' && HASHED_ID_RE.test(value)
}

function assertClean (payload) {
  for (const key of Object.keys(payload || {})) {
    const lower = key.toLowerCase().replace(/[-_]/g, '')
    if (FORBIDDEN_FIELDS.includes(lower)) {
      const error = new Error('observability event must not carry forbidden field: ' + key)
      error.code = 'observability_forbidden_field'
      throw error
    }
  }
}

function clampInt (value, min, max, dflt) {
  const n = Number(value)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

// 用量规范化：只有明确「确证未发出」才允许 0；其余未知写 'unknown'。
export function normalizeUsage (usage, terminal) {
  const u = (usage && typeof usage === 'object') ? usage : {}
  const known = u.known === true
  const unsent = terminal === 'CANCELLED_UNSENT'
  const tokens = Number(u.tokens)
  const costMicro = Number(u.costMicro)
  const tokensOut = (known && Number.isFinite(tokens) && tokens >= 0) ? Math.trunc(tokens) : (unsent ? 0 : USAGE_UNKNOWN)
  const costOut = (known && Number.isFinite(costMicro) && costMicro >= 0) ? Math.trunc(costMicro) : (unsent ? 0 : USAGE_UNKNOWN)
  return {
    tokens: tokensOut,
    costMicro: costOut,
    costKnown: costOut !== USAGE_UNKNOWN,
    usageKnown: tokensOut !== USAGE_UNKNOWN,
  }
}

export function createObservability (opts = {}) {
  const capacity = clampInt(opts.capacity, 1, MAX_CAPACITY, DEFAULT_CAPACITY)
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const ring = []
  const subscribers = new Set()
  let seq = 0
  let dropped = 0
  const terminals = new Set()
  const stats = {
    requests: 0,
    terminals: 0,
    deduped: 0,
    unknownUsage: 0,
    attempts: 0,
    forbidden: 0,
  }

  function trimTerminals () {
    // 去重集合有界：超过 4 倍容量时按插入序淘汰最旧的一半（事件本身仍保留在 ring 里）。
    const maxSeen = capacity * 4
    if (terminals.size <= maxSeen) return
    const drop = terminals.size - Math.floor(maxSeen / 2)
    let i = 0
    for (const key of terminals) {
      terminals.delete(key)
      if (++i >= drop) break
    }
  }

  function push (event) {
    seq += 1
    const ev = Object.freeze(Object.assign({}, event, {
      version: OBSERVABILITY_VERSION,
      contract: OBSERVABILITY_CONTRACT,
      seq,
      at: now(),
    }))
    ring.push(ev)
    while (ring.length > capacity) { ring.shift(); dropped += 1 }
    for (const fn of subscribers) { try { fn(ev) } catch { /* 订阅者异常不影响主路径 */ } }
    return ev
  }

  function emit (payload) {
    assertClean(payload)
    const kind = payload && payload.kind
    if (!KINDS.includes(kind)) {
      const error = new Error('observability event kind must be one of ' + KINDS.join('/'))
      error.code = 'observability_kind_invalid'
      throw error
    }
    if (payload.requestId != null && !isHashedId(payload.requestId)) {
      const error = new Error('observability requestId must be a sha256-derived id')
      error.code = 'observability_plaintext_id'
      throw error
    }
    if (payload.parentRequestId != null && !isHashedId(payload.parentRequestId)) {
      const error = new Error('observability parent link must be an explicit hashed id')
      error.code = 'observability_plaintext_parent'
      throw error
    }
    const ev = push(payload)
    if (kind === 'request') stats.requests += 1
    if (kind === 'attempt') stats.attempts += 1
    return ev
  }

  // 终态收据：stats 只记一次（同 requestId+attemptId+terminal 重复上报 → deduped）。
  function recordTerminal (payload = {}) {
    const terminal = String(payload.terminal || '').toUpperCase()
    if (!terminal) {
      const error = new Error('recordTerminal requires terminal')
      error.code = 'observability_terminal_missing'
      throw error
    }
    const key = [payload.requestId || '-', payload.attemptId || '-', terminal].join('|')
    if (terminals.has(key)) {
      stats.deduped += 1
      return { recorded: false, deduped: true }
    }
    terminals.add(key)
    trimTerminals()
    stats.terminals += 1
    const usage = normalizeUsage(payload.usage, terminal)
    if (usage.tokens === USAGE_UNKNOWN) stats.unknownUsage += 1
    emit({
      kind: 'request',
      requestId: payload.requestId || null,
      parentRequestId: payload.parentRequestId || null,
      terminal,
      model: payload.model || null,
      provider: payload.provider || null,
      status: Number.isFinite(Number(payload.status)) ? Number(payload.status) : null,
      usage,
    })
    return { recorded: true, deduped: false, usage }
  }

  function recordAttempt (payload = {}) {
    // 调用方契约：attempt 收据同样不得携带正文/凭据/密文/原始 id（显式拒绝而不是悄悄丢）。
    assertClean(payload)
    return emit({
      kind: 'attempt',
      requestId: payload.requestId || null,
      attemptId: payload.attemptId || null,
      parentRequestId: payload.parentRequestId || null,
      provider: payload.provider || null,
      model: payload.model || null,
      phase: payload.phase || null,
      terminal: payload.terminal ? String(payload.terminal).toUpperCase() : null,
      status: Number.isFinite(Number(payload.status)) ? Number(payload.status) : null,
    })
  }

  function page (query = {}) {
    const limit = clampInt(query.limit, 1, 100, 50)
    let cursor = null
    if (query.cursor != null && query.cursor !== '') {
      const n = Number(query.cursor)
      if (!Number.isFinite(n) || n < 0) {
        const error = new Error('cursor 必须是 >=0 的整数（seq）')
        error.code = 'observability_cursor_invalid'
        throw error
      }
      cursor = Math.trunc(n)
    }
    const from = cursor == null ? 0 : cursor
    const items = ring.filter((ev) => ev.seq > from).slice(0, limit)
    const lastSeq = items.length ? items[items.length - 1].seq : from
    const hasMore = ring.length ? ring[ring.length - 1].seq > lastSeq : false
    return {
      contract: OBSERVABILITY_CONTRACT,
      version: OBSERVABILITY_VERSION,
      items,
      nextCursor: lastSeq,
      hasMore,
      retained: { from: ring.length ? ring[0].seq : 0, to: ring.length ? ring[ring.length - 1].seq : 0, count: ring.length, capacity, dropped },
      stats: Object.assign({}, stats),
    }
  }

  function subscribe (fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe requires a function')
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  return {
    contract: OBSERVABILITY_CONTRACT,
    version: OBSERVABILITY_VERSION,
    capacity,
    emit,
    recordTerminal,
    recordAttempt,
    page,
    subscribe,
    stats: () => Object.assign({}, stats),
    size: () => ring.length,
    dropped: () => dropped,
  }
}
