// Responses 续轮状态（connection-scoped continuation）——WS 桥与 HTTP POST 共用。
//
// 背景（2026-11-16 审计 P0）：Codex 0.167 的 WS/续轮帧带 previous_response_id，只发**增量**
// input（省略它认为服务端已持有的历史项）。订阅后端与第三方便携 Responses 上游都不接受
// previous_response_id；此前网关只剔除该字段、只注入缓存的 function_call，其余被省略的
// 消息/推理项永久丢失 → 多轮会话上下文断裂。
//
// 本模块在网关侧按 response.id 缓存「该轮发给上游的完整 input + 上游真实返回的 output」，
// 续轮时重建完整历史后再剔除 previous_response_id。只缓存真实发生过的 item：
//   · 绝不伪造 item / call_id / 密文；
//   · 绝不 summarize、截断或改写历史（压缩归 Codex 原生，MG-R006）；
//   · 缓存缺失（重启/淘汰/超容量）时 fail-closed，由调用方返回可操作 400，绝不静默丢上下文。
//
// 存储为进程内 Map：有界（条数/单条字节/总字节）、TTL、LRU 淘汰；重启即失效。
// input 存「入口级完整历史」（目标投影/修复之前的规范形态），output 存上游 SSE/JSON 的
// 真实 output items。下一轮重建 = parent.input + parent.output + 新增 delta（按 item.id 去重，
// 容忍客户端偶发重发完整历史）。

const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024

const entries = new Map() // responseId -> { prevId, input, output, model, thread, status, bytes, touchedAt }
let totalBytes = 0
let limits = {
  maxEntries: DEFAULT_MAX_ENTRIES,
  ttlMs: DEFAULT_TTL_MS,
  maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
}

export function configureContinuationLimits (patch = {}) {
  limits = Object.assign({}, limits, patch)
}

export function resetContinuationStore () {
  entries.clear()
  totalBytes = 0
}

export function continuationStoreSize () {
  return { count: entries.size, bytes: totalBytes }
}

function byteLengthOf (value) {
  try { return Buffer.byteLength(JSON.stringify(value)) } catch { return 0 }
}

function cloneItems (items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (const it of items) {
    if (it == null) continue
    try { out.push(structuredClone(it)) } catch { try { out.push(JSON.parse(JSON.stringify(it))) } catch {} }
  }
  return out
}

function evictIfNeeded () {
  const now = Date.now()
  for (const [id, e] of entries) {
    if (now - e.touchedAt > limits.ttlMs) { entries.delete(id); totalBytes -= e.bytes }
  }
  while (entries.size > limits.maxEntries || totalBytes > limits.maxTotalBytes) {
    let oldestKey = null
    let oldest = Infinity
    for (const [id, e] of entries) if (e.touchedAt < oldest) { oldest = e.touchedAt; oldestKey = id }
    if (oldestKey === null) break
    const e = entries.get(oldestKey)
    entries.delete(oldestKey)
    totalBytes -= e.bytes
  }
}

// 记录一轮真实发生的响应。responseId 缺失（上游失败/无 id）时不记录。
// input：入口级完整历史（数组）；output：上游真实 output items。
export function recordContinuation ({ responseId, prevId = null, input, output, model = '', thread = '', status = 'completed' }) {
  if (typeof responseId !== 'string' || responseId === '') return { recorded: false, reason: 'no_response_id' }
  const inputItems = cloneItems(input)
  const outputItems = cloneItems(output)
  const bytes = byteLengthOf(inputItems) + byteLengthOf(outputItems)
  if (bytes > limits.maxEntryBytes) return { recorded: false, reason: 'entry_too_large' }
  const prev = entries.get(responseId)
  if (prev) { entries.delete(responseId); totalBytes -= prev.bytes }
  entries.set(responseId, {
    prevId: typeof prevId === 'string' && prevId ? prevId : null,
    input: inputItems,
    output: outputItems,
    model: String(model || ''),
    thread: String(thread || ''),
    status: String(status || ''),
    bytes,
    touchedAt: Date.now(),
  })
  totalBytes += bytes
  evictIfNeeded()
  return { recorded: true }
}

// 预热帧（generate:false）本地应答也登记：Codex 若以其 id 续轮，重建结果就是 delta 本身。
export function recordWarmupContinuation ({ responseId, model = '' }) {
  return recordContinuation({ responseId, prevId: null, input: [], output: [], model, status: 'completed' })
}

function dedupeAppend (history, items) {
  const seen = new Set()
  for (const it of history) if (it && typeof it === 'object' && typeof it.id === 'string' && it.id) seen.add(it.id)
  const out = history.slice()
  for (const it of items) {
    if (it && typeof it === 'object' && typeof it.id === 'string' && it.id && seen.has(it.id)) continue
    if (it && typeof it === 'object' && typeof it.id === 'string' && it.id) seen.add(it.id)
    out.push(it)
  }
  return out
}

// 续轮重建：parent.input + parent.output + delta。缺失/过期 → fail-closed。
export function reconstructContinuation (prevId, deltaInput) {
  if (typeof prevId !== 'string' || prevId === '') return { ok: false, reason: 'no_previous_response_id' }
  evictIfNeeded()
  const parent = entries.get(prevId)
  if (!parent) return { ok: false, reason: 'continuation_state_missing' }
  parent.touchedAt = Date.now()
  const delta = Array.isArray(deltaInput)
    ? cloneItems(deltaInput)
    : (typeof deltaInput === 'string' && deltaInput !== ''
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: deltaInput }] }]
      : [])
  const base = parent.input.concat(parent.output)
  const input = dedupeAppend(base, delta)
  return { ok: true, input, restoredItems: base.length, deltaItems: delta.length }
}

// —— 上游响应捕获 sink：增量解析 SSE（或一次性 JSON），收集真实 response.id 与 output items ——
// 用法：每个上游响应创建一个 sink；流式逐 chunk write()，结束后 finish() 取结果；
// 非流式直接 captureJsonResponse(obj)。只读事件结构，不改写/不拦截转发字节。
export function createCaptureSink () {
  let buf = ''
  let responseId = null
  let status = null
  const outputById = new Map() // item.id -> item（output_item.done 携带完整 item）
  const outputNoId = []
  let completedOutput = null
  let sawAny = false

  const considerItem = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    if (typeof item.id === 'string' && item.id) outputById.set(item.id, item)
    else outputNoId.push(item)
  }
  const applyEvent = (obj) => {
    if (!obj || typeof obj !== 'object') return
    sawAny = true
    const type = String(obj.type || '')
    if (obj.response && typeof obj.response === 'object') {
      if (typeof obj.response.id === 'string' && obj.response.id) responseId = obj.response.id
      if (typeof obj.response.status === 'string') status = obj.response.status
    }
    if (type === 'response.output_item.done' && obj.item) considerItem(obj.item)
    if ((type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') &&
        obj.response && Array.isArray(obj.response.output)) {
      completedOutput = obj.response.output
    }
  }
  const feedSse = (text) => {
    buf += text.replace(/\r\n/g, '\n')
    let at
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, at)
      buf = buf.slice(at + 2)
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '')
      }
      if (!data) continue
      let obj = null
      try { obj = JSON.parse(data) } catch { continue }
      applyEvent(obj)
    }
  }
  return {
    write (chunk) {
      try { feedSse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)) } catch {}
    },
    // 非流式 JSON 响应整体捕获。
    captureJson (obj) {
      if (!obj || typeof obj !== 'object') return
      sawAny = true
      if (typeof obj.id === 'string' && obj.id) responseId = obj.id
      if (typeof obj.status === 'string') status = obj.status
      if (Array.isArray(obj.output)) completedOutput = obj.output
    },
    finish () {
      // 尾部可能残留最后一个未以 \n\n 结束的事件块。
      if (buf.trim()) { try { feedSse('\n\n') } catch {} }
      const output = completedOutput
        ? cloneItems(completedOutput)
        : cloneItems(Array.from(outputById.values()).concat(outputNoId))
      return { responseId, status: status || (sawAny ? 'completed' : null), output, sawAny }
    },
  }
}