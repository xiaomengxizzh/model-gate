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

// G2 第二轮治本（受 server.continuationRootFix 控制：默认 ON，仅显式 false 回落旧语义）：
//  · 终态快照在 completedOutput 空/缺失时保留 output_item.done 已捕获的真实项（含 function_call）；
//  · recordContinuation 拒绝用空 output 幂等覆盖同 key 已有的非空 output。
// 与上一轮治本共用同一开关；显式 false 时两处都恢复 cc6a797/6026e87 的旧语义，保证可回滚。
let rootFixOn = true
export function configureContinuationRootFix (v) { rootFixOn = v !== false }

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

// 终态快照合并：completedOutput 仍为权威来源，但补入「只在 output_item.done 出现」的真实项
// （按 item.id 去重，id 冲突时保留 completedOutput 版本）。订阅后端把 function_call 只放在
// output_item.done、而 response.completed.output 为空时，避免终态快照丢掉已捕获的 function_call。
function mergeCapturedOutput (completed, captured) {
  const out = cloneItems(completed)
  const seen = new Set()
  for (const it of out) if (it && typeof it === 'object' && typeof it.id === 'string' && it.id) seen.add(it.id)
  for (const it of captured) {
    if (it && typeof it === 'object' && typeof it.id === 'string' && it.id) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
    }
    out.push(it)
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
  const prev = entries.get(responseId)
  // G2 第二轮治本：同一 key 已有非空 output 时，禁止用空 output 的终态快照幂等覆盖
  // （保留更完整的版本）。空快照多来自「completedOutput 缺失/为空但 function_call 只在
  // output_item.done」的后端；覆盖会冲掉已捕获的 function_call → 下轮 function_call_output
  // 成孤儿 → 上游 400。显式关闭开关时恢复旧的无条件覆盖语义。
  if (rootFixOn && prev && Array.isArray(prev.output) && prev.output.length > 0 && outputItems.length === 0) {
    return { recorded: false, reason: 'keep_richer_output' }
  }
  const bytes = byteLengthOf(inputItems) + byteLengthOf(outputItems)
  if (bytes > limits.maxEntryBytes) return { recorded: false, reason: 'entry_too_large' }
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
  let terminal = false
  let pendingRecord = false
  const eventTypes = []

  const considerItem = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    if (typeof item.id === 'string' && item.id) outputById.set(item.id, item)
    else outputNoId.push(item)
  }
  const applyEvent = (obj) => {
    if (!obj || typeof obj !== 'object') return
    sawAny = true
    const type = String(obj.type || '')
    if (type && eventTypes.length < 24 && !eventTypes.includes(type)) eventTypes.push(type)
    if (obj.response && typeof obj.response === 'object') {
      if (typeof obj.response.id === 'string' && obj.response.id) responseId = obj.response.id
      if (typeof obj.response.status === 'string') status = obj.response.status
    }
    // 兼容 id 在事件顶层的形状（不同后端信封差异；只取协议元数据）。
    if (!responseId && typeof obj.id === 'string' && obj.id && type.startsWith('response.')) responseId = obj.id
    if (type === 'response.output_item.done' && obj.item) { considerItem(obj.item); if (responseId) pendingRecord = true }
    if (type === 'response.created' && responseId) pendingRecord = true // 预登记：终态形状未知时续轮也有状态
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
      if (obj.response && Array.isArray(obj.response.output)) completedOutput = obj.response.output
      // 真实订阅后端在 completed 后**不关闭 SSE 流**；Codex 收到终态即发下一轮。
      // 终态到达即视为可登记（2026-11-16 父代理续轮 400 根因），不得等流结束。
      terminal = true
      if (responseId) pendingRecord = true
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
  const snapshot = () => {
    const captured = cloneItems(Array.from(outputById.values()).concat(outputNoId))
    // G2 第二轮治本：终态快照保留 output_item.done 已捕获的真实项（含 function_call）。
    // completedOutput 空/缺失时不得回退成空；非空时以其为权威并补入仅增量出现的项。
    // 显式关闭 server.continuationRootFix 时恢复旧语义（空 completedOutput 优先 → 可返回空）。
    const output = rootFixOn
      ? mergeCapturedOutput(completedOutput, captured)
      : (completedOutput ? cloneItems(completedOutput) : captured)
    return { responseId, status: status || (sawAny ? 'completed' : null), output, sawAny, eventTypes: eventTypes.slice() }
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
      terminal = true
    },
    // 终态已到达（流可能仍开着）：调用方据此立即登记，不等流结束。
    terminalSnapshot () {
      return terminal ? snapshot() : null
    },
    // 增量登记窗口：created 预登记 / output_item.done 更新 / 终态定稿。
    // 每次返回后清除标记——调用方逐 chunk 取走并登记（同 id 幂等覆盖）。
    takeRecordable () {
      if (!pendingRecord || !responseId) return null
      pendingRecord = false
      return snapshot()
    },
    finish () {
      // 尾部可能残留最后一个未以 \n\n 结束的事件块。
      if (buf.trim()) { try { feedSse('\n\n') } catch {} }
      return snapshot()
    },
  }
}