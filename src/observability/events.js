// N06 / G15 可观测收据与事件（版本化、有界历史、显式脱敏关联）。
// 契约：docs/contracts/uhr-inference-v1.md 的「回执」语义在运行时的落点。
//
// 三条边界：
//   1. **收据分三类**：request（谁在什么终态）/ attempt（每个上游尝试的终态）/ usage（用量与费用）。
//      未知用量一律 'unknown'，绝不填 0；只有「确证未发出」才可以写 0。
//   2. **stats 按终态只记一次**：以 (requestId, attemptId, terminal) 去重；重复上报只计 deduped，
//      不改变 stats（断流重连、重试路径重复回调都不会双计）。
//   3. **父子只做显式脱敏关联**：父/子引用必须由调用方显式传入、且只能是 sha256 派生的短 id
//      （hashId()）。原始 request id / attempt id / 线程 id / 正文 / 密文 / Key 一律不得进入事件。
//
// 内存 ring 只服务实时 SSE；可选 persistFile 提供按 scope 隔离的有界 JSONL 历史。
// 单次 O_APPEND 写 + fsync，轮转/压缩使用临时文件 + rename + 目录 fsync。损坏记录跳过并计数，
// 绝不把损坏行当事件返回；写盘失败只降级历史持久化，不改变请求路径或实时 ring。
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

export const OBSERVABILITY_CONTRACT = 'mg-observability-v1'
export const OBSERVABILITY_VERSION = 1
export const DEFAULT_CAPACITY = 200
export const MAX_CAPACITY = 5000
export const DEFAULT_MAX_BYTES = 1024 * 1024
export const DEFAULT_MAX_RECORDS = 5000
export const MAX_STORE_BYTES = 64 * 1024 * 1024
export const MAX_STORE_RECORDS = 100000
export const USAGE_UNKNOWN = 'unknown'

const KINDS = Object.freeze(['request', 'attempt', 'usage'])
// 明确禁止出现在事件里的字段（正文/凭据/密文/原始标识）。命中即拒绝，不静默丢弃。
const FORBIDDEN_FIELDS = Object.freeze([
  'body', 'messages', 'prompt', 'input', 'content', 'output', 'text',
  'authorization', 'apikey', 'api_key', 'key', 'token', 'secret', 'cookie',
  'encrypted', 'encryptedcontent', 'encryptedtaskid', 'ciphertext', 'parentid', 'threadid', 'sessionid',
])
const HASHED_ID_RE = /^[a-f0-9]{8,64}$/
const MAX_DATE_MS = 8.64e15
const NOFOLLOW = constants.O_NOFOLLOW || 0

export function hashId (value, salt = 'mg-obs-v1') {
  const raw = value == null ? '' : String(value)
  if (!raw) return null
  return createHash('sha256').update(salt + '|' + raw).digest('hex').slice(0, 16)
}

export function isHashedId (value) {
  return typeof value === 'string' && HASHED_ID_RE.test(value)
}

function assertClean (payload, seen = new WeakSet(), depth = 0) {
  if (payload == null || typeof payload !== 'object') return
  if (depth > 16 || seen.has(payload)) {
    const error = new Error('observability event must be a bounded acyclic object')
    error.code = 'observability_event_invalid'
    throw error
  }
  seen.add(payload)
  if (Array.isArray(payload)) {
    for (const value of payload) assertClean(value, seen, depth + 1)
  } else {
    for (const [key, value] of Object.entries(payload)) {
      const lower = key.toLowerCase().replace(/[-_]/g, '')
      if (FORBIDDEN_FIELDS.includes(lower)) {
        const error = new Error('observability event must not carry forbidden field: ' + key)
        error.code = 'observability_forbidden_field'
        throw error
      }
      if (['requestid', 'parentrequestid', 'attemptid', 'traceid'].includes(lower) && value != null && !isHashedId(value)) {
        const error = new Error('observability ' + key + ' must be ' + (lower === 'parentrequestid' ? 'an explicit hashed id' : 'a sha256-derived id'))
        error.code = lower === 'parentrequestid' ? 'observability_plaintext_parent' : 'observability_plaintext_id'
        throw error
      }
      assertClean(value, seen, depth + 1)
    }
  }
  seen.delete(payload)
}

function clampInt (value, min, max, dflt) {
  const n = Number(value)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function assertEvent (event) {
  assertClean(event)
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('observability event must be an object')
  if (event.contract !== OBSERVABILITY_CONTRACT || event.version !== OBSERVABILITY_VERSION) throw new Error('observability event contract/version invalid')
  if (!KINDS.includes(event.kind)) throw new Error('observability event kind invalid')
  if (!Number.isSafeInteger(event.seq) || event.seq < 1 || !Number.isFinite(event.at) || Math.abs(event.at) > MAX_DATE_MS) throw new Error('observability event seq/at invalid')
  for (const field of ['requestId', 'parentRequestId', 'attemptId']) {
    if (event[field] != null && !isHashedId(event[field])) throw new Error('observability event reference must be hashed')
  }
  return Object.freeze(event)
}

function eventLine (event) {
  return JSON.stringify(event) + '\n'
}

function fsyncDir (path) {
  let fd = null
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0))
    fsyncSync(fd)
  } catch { /* 文件 fsync 已做；目录 fsync 在平台不支持时不阻断 */ } finally {
    if (fd != null) try { closeSync(fd) } catch {}
  }
}

function assertRegularFile (path) {
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink()) {
    const error = new Error('observability store path must be a regular file')
    error.code = 'observability_store_unsafe_path'
    throw error
  }
  chmodSync(path, 0o600)
  return st
}

function atomicWrite (path, text) {
  const tmp = path + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp'
  let fd = null
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
    chmodSync(path, 0o600)
    fsyncDir(dirname(path))
  } catch (error) {
    if (fd != null) try { closeSync(fd) } catch {}
    try { rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

// 持久层只接收已经通过 assertEvent 的事件。maxBytes/maxRecords 是当前文件 + .1 轮转文件的总上限。
function createEventStore (persistFile, opts = {}) {
  const maxBytes = clampInt(opts.maxBytes, 256, MAX_STORE_BYTES, DEFAULT_MAX_BYTES)
  const maxRecords = clampInt(opts.maxRecords, 1, MAX_STORE_RECORDS, DEFAULT_MAX_RECORDS)
  const meta = { enabled: false, records: 0, bytes: 0, corrupt: 0, dropped: 0, rejected: 0, rotations: 0, errors: 0, truncated: 0, error: null }
  let items = []
  let archiveBytes = 0
  let activeBytes = 0
  let archiveCount = 0
  let activeCount = 0
  if (typeof persistFile !== 'string' || !persistFile.trim()) {
    return { maxBytes, maxRecords, snapshot: () => ({ ...meta }), load: () => [], append: () => false }
  }

  const file = resolve(persistFile)
  const archive = file + '.1'

  function fail (code) {
    meta.enabled = false
    meta.error = code
    meta.errors += 1
    items = []
    return []
  }

  function ensureOwnedDir () {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const st = lstatSync(dirname(file))
    if (!st.isDirectory() || st.isSymbolicLink()) {
      const error = new Error('observability store directory must be a real directory')
      error.code = 'observability_store_unsafe_path'
      throw error
    }
    chmodSync(dirname(file), 0o700)
  }

  function readSegment (path) {
    try {
      const st = assertRegularFile(path)
      let text = ''
      let repaired = false
      if (st.size > maxBytes) {
        // 外部异常扩文件只读尾部；首行可能被截断，丢弃并计数，避免把半个 JSON 当事件。
        const start = st.size - maxBytes
        const fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
        try {
          const buf = Buffer.alloc(maxBytes)
          const read = readSync(fd, buf, 0, maxBytes, start)
          text = buf.subarray(0, read).toString('utf8')
        } finally { closeSync(fd) }
        const newline = text.indexOf('\n')
        text = newline >= 0 ? text.slice(newline + 1) : ''
        meta.truncated += 1
        repaired = true
      } else {
        text = readFileSync(path, 'utf8')
      }
      if (text && !text.endsWith('\n')) {
        const cut = text.lastIndexOf('\n')
        const tail = text.slice(cut + 1)
        try {
          assertEvent(JSON.parse(tail))
          text += '\n'
        } catch {
          text = cut >= 0 ? text.slice(0, cut + 1) : ''
          meta.corrupt += 1
        }
        repaired = true
      }
      const events = []
      for (const line of text.split('\n')) {
        if (line === '') continue
        try { events.push(assertEvent(JSON.parse(line))) } catch { meta.corrupt += 1; repaired = true }
      }
      return { text, events, bytes: st.size, repaired }
    } catch (error) {
      if (error && error.code === 'ENOENT') return { text: '', events: [], bytes: 0, repaired: false }
      const code = error && error.code === 'observability_store_unsafe_path' ? error.code : 'observability_store_unreadable'
      throw Object.assign(new Error(code), { code })
    }
  }

  function load () {
    if (meta.error) return []
    try {
      ensureOwnedDir()
      const old = readSegment(archive)
      const current = readSegment(file)
      const bySeq = new Map()
      let previousSeq = 0
      for (const event of old.events) {
        if (event.seq <= previousSeq) { meta.corrupt += 1; continue }
        bySeq.set(event.seq, event)
        previousSeq = event.seq
      }
      let currentPrevious = 0
      for (const event of current.events) {
        if (event.seq <= currentPrevious) { meta.corrupt += 1; continue }
        currentPrevious = event.seq
        if (bySeq.has(event.seq)) {
          // 启动收敛可能已写完整 current、尚未删除旧 archive；同 seq 内容一致则安全合并。
          if (JSON.stringify(bySeq.get(event.seq)) !== JSON.stringify(event)) meta.corrupt += 1
        } else if (event.seq < previousSeq) {
          meta.corrupt += 1
        } else {
          bySeq.set(event.seq, event)
        }
        previousSeq = Math.max(previousSeq, event.seq)
      }
      const valid = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
      let retainedBytes = valid.reduce((sum, event) => sum + Buffer.byteLength(eventLine(event)), 0)
      while (valid.length > maxRecords || retainedBytes > maxBytes) {
        retainedBytes -= Buffer.byteLength(eventLine(valid.shift()))
        meta.dropped += 1
      }
      const normalized = valid.map(eventLine).join('')
      const normalizedBytes = Buffer.byteLength(normalized)
      // 损坏行、截断尾行、旧格式超限或非紧凑 JSON 都在启动时收敛为干净的有界 store。
      // 坏行内容从不返回/记录；只在 meta.corrupt 暴露数量。
      if (old.repaired || current.repaired || old.bytes + current.bytes !== normalizedBytes) {
        atomicWrite(file, normalized)
        rmSync(archive, { force: true })
        fsyncDir(dirname(file))
        archiveBytes = 0
        activeBytes = normalizedBytes
        archiveCount = 0
        activeCount = valid.length
      } else {
        archiveBytes = old.bytes
        activeBytes = current.bytes
        archiveCount = old.events.length
        activeCount = current.events.length
      }
      items = valid
      meta.enabled = true
      meta.records = items.length
      meta.bytes = archiveBytes + activeBytes
      return items
    } catch (error) {
      return fail(error && error.code || 'observability_store_unreadable')
    }
  }

  function compactFor (lineBytes) {
    while (items.length && (items.length >= maxRecords || archiveBytes + activeBytes + lineBytes > maxBytes)) {
      const removed = items.shift()
      const removedBytes = Buffer.byteLength(eventLine(removed))
      meta.dropped += 1
      if (archiveCount > 0) { archiveCount -= 1; archiveBytes -= removedBytes }
      else if (activeCount > 0) { activeCount -= 1; activeBytes -= removedBytes }
    }
    atomicWrite(archive, items.map(eventLine).join(''))
    rmSync(file, { force: true })
    archiveBytes = items.reduce((sum, event) => sum + Buffer.byteLength(eventLine(event)), 0)
    activeBytes = 0
    archiveCount = items.length
    activeCount = 0
  }

  function append (event) {
    if (!meta.enabled) return false
    try {
      const line = eventLine(event)
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > maxBytes) {
        // 单条事件超过总预算时不能为了它破坏有界性；实时 ring 仍保留，历史跳过并计数。
        meta.rejected += 1
        return false
      }
      ensureOwnedDir()
      for (const path of [file, archive]) {
        try { assertRegularFile(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      if (items.length + 1 > maxRecords || archiveBytes + activeBytes + lineBytes > maxBytes) {
        // 已有 archive 时直接按总预算裁剪并重写，避免用较短的 active 覆盖较新的 archive。
        if (activeBytes > 0 && archiveCount === 0) {
          renameSync(file, archive)
          chmodSync(archive, 0o600)
          const archiveFd = openSync(archive, constants.O_RDONLY | NOFOLLOW)
          try { fsyncSync(archiveFd) } finally { closeSync(archiveFd) }
          fsyncDir(dirname(file))
          archiveBytes = activeBytes
          archiveCount = activeCount
          activeBytes = 0
          activeCount = 0
          meta.rotations += 1
        }
        compactFor(lineBytes)
      }
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600)
      try {
        fchmodSync(fd, 0o600)
        const before = fstatSync(fd).size
        const written = writeSync(fd, line, null, 'utf8')
        if (written !== lineBytes) throw new Error('short observability append')
        fsyncSync(fd)
        activeBytes = before + lineBytes
      } catch (error) {
        try { ftruncateSync(fd, before); fsyncSync(fd) } catch {}
        throw error
      } finally { closeSync(fd) }
      items.push(event)
      activeCount += 1
      meta.records = items.length
      meta.bytes = archiveBytes + activeBytes
      return true
    } catch (error) {
      meta.enabled = false
      meta.error = 'observability_store_write_failed'
      meta.errors += 1
      return false
    }
  }

  return { maxBytes, maxRecords, snapshot: () => ({ ...meta }), load, append }
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
  const store = createEventStore(opts.persistFile, opts)
  const retained = store.load()
  let seq = retained.reduce((max, event) => Math.max(max, event.seq), 0)
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
    const at = Number(now())
    const ev = Object.freeze(Object.assign({}, event, {
      version: OBSERVABILITY_VERSION,
      contract: OBSERVABILITY_CONTRACT,
      seq,
      at: Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS ? at : Date.now(),
    }))
    ring.push(ev)
    while (ring.length > capacity) { ring.shift(); dropped += 1 }
    store.append(ev)
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
    for (const field of ['requestId', 'parentRequestId', 'attemptId']) {
      if (payload[field] != null && !isHashedId(payload[field])) {
        const error = new Error('observability ' + field + ' must be ' + (field === 'parentRequestId' ? 'an explicit hashed id' : 'a sha256-derived id'))
        error.code = field === 'parentRequestId' ? 'observability_plaintext_parent' : 'observability_plaintext_id'
        throw error
      }
    }
    const ev = push(payload)
    if (kind === 'request') stats.requests += 1
    if (kind === 'attempt') stats.attempts += 1
    return ev
  }

  // 终态收据：stats 只记一次（同 requestId+attemptId+terminal 重复上报 → deduped）。
  function recordTerminal (payload = {}) {
    assertClean(payload)
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

  function pageOf (source, query, retainedInfo) {
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
    const items = source.filter((ev) => ev.seq > from).slice(0, limit)
    const lastSeq = items.length ? items[items.length - 1].seq : from
    const hasMore = source.length ? source[source.length - 1].seq > lastSeq : false
    return {
      contract: OBSERVABILITY_CONTRACT,
      version: OBSERVABILITY_VERSION,
      items,
      nextCursor: lastSeq,
      hasMore,
      retained: retainedInfo,
      stats: Object.assign({}, stats),
    }
  }

  function ringRetained () {
    return { from: ring.length ? ring[0].seq : 0, to: ring.length ? ring[ring.length - 1].seq : 0, count: ring.length, capacity, dropped }
  }

  function durableRetained () {
    const snapshot = store.snapshot()
    return {
      from: retained.length ? retained[0].seq : 0,
      to: retained.length ? retained[retained.length - 1].seq : 0,
      count: retained.length,
      maxBytes: store.maxBytes,
      maxRecords: store.maxRecords,
      dropped: snapshot.dropped,
      corrupt: snapshot.corrupt,
      rejected: snapshot.rejected,
      rotations: snapshot.rotations,
      truncated: snapshot.truncated,
      errors: snapshot.errors,
      bytes: snapshot.bytes,
      enabled: snapshot.enabled,
      error: snapshot.error,
    }
  }

  // 默认 page 保持 ring 语义，SSE 快照不会因持久历史变长。durable:true 供历史分页。
  function page (query = {}) {
    const snapshot = store.snapshot()
    if (query.durable === true && (snapshot.enabled || retained.length)) {
      return Object.assign(pageOf(retained, query, durableRetained()), { durable: snapshot })
    }
    return pageOf(ring, query, ringRetained())
  }

  // 结构化日志需要完整的有界快照，再按文本 cursor 合并分页；禁用持久化时兼容旧 ring。
  function history () {
    const snapshot = store.snapshot()
    if (!retained.length) return { contract: OBSERVABILITY_CONTRACT, version: OBSERVABILITY_VERSION, items: ring, retained: ringRetained(), stats: Object.assign({}, stats), durable: snapshot }
    // 正常追加时 ring 是 retained 的子集；写盘失败/单条超限时补回未持久化的实时事件。
    const bySeq = new Map(retained.map((event) => [event.seq, event]))
    for (const event of ring) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event)
    const items = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    return { contract: OBSERVABILITY_CONTRACT, version: OBSERVABILITY_VERSION, items, retained: durableRetained(), stats: Object.assign({}, stats), durable: snapshot }
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
    history,
    subscribe,
    stats: () => Object.assign({}, stats),
    size: () => ring.length,
    dropped: () => dropped,
    durability: () => store.snapshot(),
  }
}
