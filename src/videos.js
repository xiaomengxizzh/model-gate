// Video 异步任务池（MG-014）：任务记录、上游状态归一、保留/GC 与客户端投影。
// 设计见 docs/explanation/adr-0001-video-task-pool.md；存储为 <config>/videos.json（原子写、单进程）。
import { randomUUID } from 'node:crypto'
import { readJson, writeJsonAtomic } from './router.js'

export const MAX_VIDEO_TASKS = 500
export const VIDEO_RETENTION_MS = 7 * 24 * 3600 * 1000
export const VIDEO_MAX_PENDING_MS = 24 * 3600 * 1000
export const VIDEO_POLL_MIN_MS = 1500

export function defaultVideoPaths(def) {
  const d = def || {}
  return {
    createPath: typeof d.videoCreatePath === 'string' && d.videoCreatePath ? d.videoCreatePath : '/v1/videos',
    statusPath: typeof d.videoStatusPath === 'string' && d.videoStatusPath ? d.videoStatusPath : '/v1/videos/{id}',
    cancelPath: typeof d.videoCancelPath === 'string' && d.videoCancelPath ? d.videoCancelPath : '/v1/videos/{id}/cancel',
  }
}

export function newVideoTask(opts) {
  const now = Date.now()
  return {
    id: 'vid_' + randomUUID(),
    object: 'video',
    model: opts.model,
    provider: opts.provider,
    status: 'queued',
    upstreamId: null,
    createdAt: now,
    updatedAt: now,
    idem: opts.idem || null,
    prompt: typeof opts.prompt === 'string' ? opts.prompt.slice(0, 2000) : '',
    progress: null,
    result: null,
    error: null,
    lastPollAt: 0,
  }
}

// 上游任务 ID：兼容 OpenAI 风格 id 与常见 task_id/request_id。
export function upstreamTaskId(json) {
  if (!json || typeof json !== 'object') return null
  const v = json.id || json.task_id || json.request_id
  return (typeof v === 'string' && v) ? v : null
}

const SUCCEED = /^(succeed|success|completed|complete|done)/
const FAIL = /^(fail|error)/
const CANCEL = /^(cancel)/
const QUEUED = /^(queue|pending)/
const RUNNING = /^(start|run|processing|in_progress)/
const KNOWN = /^(succeed|success|completed|complete|done|fail|error|cancel|queue|pending|start|run|processing|in_progress)/

// 上游状态 → 任务状态；进度与结果/错误提取。无法识别的状态保持当前状态。
export function applyUpstreamStatus(task, json) {
  const j = (json && typeof json === 'object') ? json : {}
  const raw = String(j.status || j.state || '').toLowerCase()
  if (raw && KNOWN.test(raw)) {
    task.status = SUCCEED.test(raw) ? 'succeeded' : FAIL.test(raw) ? 'failed' : CANCEL.test(raw) ? 'canceled' : QUEUED.test(raw) ? 'queued' : 'running'
  }
  const p = Number(j.progress != null ? j.progress : j.percent)
  if (Number.isFinite(p)) task.progress = Math.max(0, Math.min(100, p))
  const result = j.result || j.output || (typeof j.url === 'string' ? { url: j.url } : null) || (j.video && j.video.url ? { url: j.video.url } : null) || (Array.isArray(j.data) && j.data[0] ? j.data[0] : null)
  if (result && task.status === 'succeeded') task.result = result
  if (task.status === 'failed') {
    const e = j.error
    task.error = typeof e === 'string' ? e : (e && e.message ? e.message : (j.message ? String(j.message) : 'upstream failed'))
  }
  task.updatedAt = Date.now()
  return task
}

// 客户端可见投影：不返回 provider/upstreamId/prompt 等内部字段。
export function clientTask(task) {
  const out = {
    id: task.id,
    object: 'video',
    model: task.model,
    status: task.status,
    created_at: Math.floor(task.createdAt / 1000),
  }
  if (task.progress != null) out.progress = task.progress
  if (task.result) out.result = task.result
  if (task.error) out.error = task.error
  return out
}

export function loadVideoTasks(file) {
  const j = readJson(file, {})
  const tasks = {}
  if (j && j.tasks && typeof j.tasks === 'object') for (const [id, t] of Object.entries(j.tasks)) if (t && t.id === id) tasks[id] = t
  return tasks
}

export function saveVideoTasks(file, tasks) {
  writeJsonAtomic(file, { version: 1, tasks })
}

// 保留/GC：非终态超 24h 标记 failed(expired)；终态超 7 天删除；总量超上限按最旧终态优先淘汰。
// 返回是否有变更（调用方据此决定是否落盘）。
export function gcVideoTasks(tasks, now = Date.now()) {
  let changed = false
  for (const [id, t] of Object.entries(tasks)) {
    const terminal = t.status === 'succeeded' || t.status === 'failed' || t.status === 'canceled'
    if (!terminal && now - t.createdAt > VIDEO_MAX_PENDING_MS) {
      t.status = 'failed'; t.error = 'task expired（超过 24h 未完成）'; t.updatedAt = now; changed = true
    } else if (terminal && now - t.updatedAt > VIDEO_RETENTION_MS) {
      delete tasks[id]; changed = true
    }
  }
  const ids = Object.keys(tasks)
  if (ids.length > MAX_VIDEO_TASKS) {
    const terminalOldest = ids.filter((id) => ['succeeded', 'failed', 'canceled'].includes(tasks[id].status)).sort((a, b) => tasks[a].updatedAt - tasks[b].updatedAt)
    for (const id of terminalOldest.slice(0, ids.length - MAX_VIDEO_TASKS)) { delete tasks[id]; changed = true }
    // 终态不足时仍超限：按最旧任务淘汰（保护上限硬约束）
    const left = Object.keys(tasks)
    if (left.length > MAX_VIDEO_TASKS) {
      left.sort((a, b) => tasks[a].createdAt - tasks[b].createdAt)
      for (const id of left.slice(0, left.length - MAX_VIDEO_TASKS)) { delete tasks[id]; changed = true }
    }
  }
  return changed
}

export function validateVideoCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体必须为 JSON 对象' }
  if (typeof body.model !== 'string' || body.model.trim() === '') return { error: '缺少 model' }
  if (typeof body.prompt !== 'string' || body.prompt === '') return { error: 'prompt 必须为非空字符串' }
  if (body.duration != null && (!Number.isFinite(Number(body.duration)) || Number(body.duration) <= 0)) return { error: 'duration 必须为正数（秒）' }
  return null
}

export function findTaskByIdem(tasks, idem) {
  if (!idem) return null
  for (const t of Object.values(tasks)) if (t.idem === idem) return t
  return null
}

// ============================================================================
// M1-4a：视频创建幂等（PENDING_SEND 先落盘，再调上游）
// ============================================================================
// 关键顺序：本地任务记录（PENDING_SEND + 主体 + 目标 + 幂等键 + 输入指纹）必须先
// 原子落盘，之后才调用上游 create。并发/失联/重启时只复用本地记录，绝不重复计费。
// 任务表是单进程单写者：不做跨进程锁（与 config-transaction 的语义无关）。
import { createHash } from 'node:crypto'

export const VIDEO_PENDING_SEND = 'pending_send'
export const VIDEO_UNKNOWN = 'unknown'
export const VIDEO_TERMINAL = Object.freeze(['succeeded', 'failed', 'canceled'])

// 规范化 JSON（递归排序键）：相同的逻辑输入 ⇒ 相同指纹，与键顺序无关。
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}
export function videoInputHash(input) {
  return createHash('sha256').update(stableStringify(input == null ? {} : input)).digest('hex')
}

// 同一主体 + 同一幂等键：只有同输入才能复用；不同主体永远互不可见。
export function findSubjectTask(tasks, subject, idem) {
  if (!subject || !idem) return null
  for (const t of Object.values(tasks || {})) if (t && t.subject === subject && t.idem === idem) return t
  return null
}

// 重启恢复：进程在 PENDING_SEND 期间死亡 ⇒ 上游结果未知，只允许查状态/人工核对，禁止再次 create。
export function recoverInterruptedVideoTasks(tasks, now = Date.now) {
  let changed = false
  for (const t of Object.values(tasks || {})) {
    if (!t) continue
    if (t.status === VIDEO_PENDING_SEND) {
      t.status = VIDEO_UNKNOWN
      t.error = 'process interrupted before upstream result was known'
      t.updatedAt = now()
      changed = true
    }
  }
  return changed
}

export class VideoTaskStore {
  constructor (opts = {}) {
    if (!opts.file) throw new TypeError('VideoTaskStore requires opts.file（真实视频任务表路径）')
    this.file = opts.file
    this.now = typeof opts.now === 'function' ? opts.now : Date.now
    this.idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : () => 'vid_' + randomUUID()
    this.tasks = loadVideoTasks(opts.file)
    if (recoverInterruptedVideoTasks(this.tasks, this.now)) this.persist()
  }
  persist () { saveVideoTasks(this.file, this.tasks) }
  list () { return Object.values(this.tasks).sort((a, b) => b.createdAt - a.createdAt) }
  get (id) { return this.tasks[id] || null }
  find (subject, idem) { return findSubjectTask(this.tasks, subject, idem) }
  // create：返回 { ok, reused?, conflict?, unknown?, task, status?, error? }
  //   send(task) 必须是注入的上游创建调用（index.js 接线时传真实 HTTP）。
  async create (opts = {}) {
    const subject = typeof opts.subject === 'string' ? opts.subject.trim() : ''
    if (!subject) return { ok: false, status: 401, error: { type: 'unauthorized', code: 'missing_subject', message: '视频创建需要可识别的调用主体' } }
    const idem = opts.idem == null ? null : String(opts.idem).trim() || null
    const input = opts.input == null ? {} : opts.input
    const inputHash = videoInputHash(input)
    if (idem) {
      const existing = findSubjectTask(this.tasks, subject, idem)
      if (existing) {
        if (existing.inputHash !== inputHash) {
          return { ok: false, status: 409, conflict: true, task: clientTask(existing), error: { type: 'idempotency_conflict', code: 'idempotency_key_reused', message: '幂等键已用于不同输入，拒绝创建' } }
        }
        // 同键同输入：复用（包括 pending_send / unknown），绝不再次调用上游。
        return { ok: true, reused: true, task: clientTask(existing), internal: existing }
      }
    }
    const now = this.now()
    const task = {
      id: this.idFactory(),
      object: 'video',
      subject,
      idem,
      inputHash,
      target: opts.target ? { provider: opts.target.provider || null, path: opts.target.path || null, model: opts.target.model || null } : null,
      model: (opts.target && opts.target.model) || opts.model || '',
      provider: (opts.target && opts.target.provider) || opts.provider || '',
      status: VIDEO_PENDING_SEND,
      upstreamId: null,
      createdAt: now,
      updatedAt: now,
      prompt: typeof (input.prompt) === 'string' ? input.prompt.slice(0, 2000) : '',
      progress: null,
      result: null,
      error: null,
      lastPollAt: 0,
    }
    this.tasks[task.id] = task
    this.persist() // ← 必须先落盘，再发起上游调用
    const send = opts.send
    if (typeof send !== 'function') {
      task.status = VIDEO_UNKNOWN
      task.error = 'no upstream sender injected'
      task.updatedAt = this.now()
      this.persist()
      return { ok: false, status: 500, unknown: true, task: clientTask(task), internal: task, error: { type: 'internal_error', code: 'missing_sender', message: task.error } }
    }
    let upstream
    try {
      upstream = await send(task)
    } catch (err) {
      const aborted = !!(err && (err.aborted || err.code === 'client_closed' || (opts.signal && opts.signal.aborted)))
      task.status = aborted ? 'canceled' : VIDEO_UNKNOWN
      task.error = aborted ? 'client canceled before upstream result' : ('upstream create failed: ' + ((err && err.message) || 'unknown'))
      task.updatedAt = this.now()
      this.persist()
      return { ok: false, status: aborted ? 499 : 504, unknown: !aborted, canceled: aborted, task: clientTask(task), internal: task, error: { type: aborted ? 'canceled' : 'upstream_unknown', code: aborted ? 'request_canceled' : 'video_upstream_unknown', message: task.error } }
    }
    const json = (upstream && upstream.json) || upstream || null
    const upstreamId = upstreamTaskId(json)
    if (upstreamId) task.upstreamId = upstreamId
    applyUpstreamStatus(task, json || {})
    if (task.status === VIDEO_PENDING_SEND) task.status = 'queued'
    if (!task.upstreamId && task.status === 'queued') task.error = 'upstream 未返回任务 id，无法轮询'
    task.updatedAt = this.now()
    this.persist()
    return { ok: true, created: true, task: clientTask(task), internal: task, upstreamId: task.upstreamId }
  }
  // 终态只允许一次：取消只对非终态任务生效。
  cancel (id, reason = 'canceled') {
    const task = this.tasks[id]
    if (!task) return null
    if (VIDEO_TERMINAL.includes(task.status)) return task
    task.status = 'canceled'
    task.error = reason
    task.updatedAt = this.now()
    this.persist()
    return task
  }
}

