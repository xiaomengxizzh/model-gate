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
