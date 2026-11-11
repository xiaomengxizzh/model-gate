// 进程内 mock UHR（M5-2 / T-AGENT-02）：契约验收用，**不是**真实 UHR 实现。
//
// 覆盖最小 API 面：submit（幂等） / getResult（归属校验） / cancel（幂等）。
// 落盘到真实目录（原子写 + fsync + rename），因此"重启后 taskRef 仍可查"是可验证的。
// 真实 UHR 集成 = NOT_RUN：需要现行授权接口与明确写集，另开分支。
//
// 安全口径：本 mock 只存哈希与有界标签（ownerRef/taskRef/digest/refs 摘要），
// 不存对话正文、绝对路径、密钥；结果文本也会被裁剪（adapter 再脱敏一层）。
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

export const MOCK_VERSION = 1
export const MOCK_CONTRACT = 'uhr-mock-v1'

export const MOCK_STATE = Object.freeze({
  SUBMITTED: 'submitted',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const MOCK_ERR = Object.freeze({
  BAD_REQUEST: 'UHR_MOCK_BAD_REQUEST',
  CONFLICT: 'UHR_MOCK_IDEMPOTENCY_CONFLICT',
  NOT_FOUND: 'UHR_MOCK_NOT_FOUND',
  OWNER: 'UHR_MOCK_NOT_OWNER',
  TERMINAL: 'UHR_MOCK_TASK_TERMINAL',
  CORRUPT: 'UHR_MOCK_CORRUPT',
  IO: 'UHR_MOCK_IO',
})

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const TERMINAL_STATES = new Set([MOCK_STATE.SUCCEEDED, MOCK_STATE.FAILED, MOCK_STATE.CANCELLED])
const MAX_RESULT_BYTES = 16 * 1024

export class MockUhrError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'MockUhrError'
    this.code = code
    this.detail = detail && typeof detail === 'object' ? Object.assign({}, detail) : {}
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}

const toStr = (v) => (v == null ? '' : String(v))
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

/** 任务引用的对外 token（用于 scoped grant）：与适配器共享同一派生规则。 */
export function taskRefToken(taskRef) {
  return 'task_' + sha256Hex('task:' + toStr(taskRef)).slice(0, 24)
}

function atomicWriteJson(path, value) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + basename(path) + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp')
  const text = JSON.stringify(value, null, 2) + '\n'
  let fd = null
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeSync(fd, Buffer.from(text, 'utf8'))
    fsyncSync(fd)
  } catch {
    try { if (fd != null) closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw new MockUhrError(MOCK_ERR.IO, 'mock UHR 任务表写入失败')
  }
  try { closeSync(fd) } catch {}
  try {
    renameSync(tmp, path)
  } catch {
    try { unlinkSync(tmp) } catch {}
    throw new MockUhrError(MOCK_ERR.IO, 'mock UHR 任务表原子替换失败')
  }
  let dfd = null
  try {
    dfd = openSync(dir, 'r')
    fsyncSync(dfd)
  } catch { /* 目录 fsync 尽力而为 */ } finally {
    if (dfd != null) { try { closeSync(dfd) } catch {} }
  }
}

/**
 * 打开 mock UHR。
 * @param {object} options { dir（必需）, now()=>ms, at 固定时间, currency='USD' }
 */
export function openMockUhr(options = {}) {
  const dirRaw = toStr(options.dir).trim()
  if (!dirRaw) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'openMockUhr 需要 dir')
  const dir = resolve(dirRaw)
  const currencyDefault = toStr(options.currency || 'USD').toUpperCase()
  const clock = typeof options.now === 'function' ? options.now : null
  const fixedAt = Number.isFinite(Number(options.at)) ? Number(options.at) : null
  const nowMs = () => (fixedAt != null ? fixedAt : clock ? Number(clock()) : Date.now())
  const tablePath = join(dir, 'uhr-tasks.json')

  mkdirSync(dir, { recursive: true })

  function readTable() {
    let raw
    try {
      raw = readFileSync(tablePath, 'utf8')
    } catch (e) {
      if (e && e.code === 'ENOENT') return { version: MOCK_VERSION, updatedAt: nowMs(), tasks: {} }
      throw new MockUhrError(MOCK_ERR.IO, '读取 mock UHR 任务表失败')
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new MockUhrError(MOCK_ERR.CORRUPT, 'mock UHR 任务表损坏，拒绝自动重置')
    }
    if (!isPlain(parsed) || parsed.version !== MOCK_VERSION || !isPlain(parsed.tasks)) {
      throw new MockUhrError(MOCK_ERR.CORRUPT, 'mock UHR 任务表结构非法')
    }
    return parsed
  }

  function writeTable(table) {
    table.updatedAt = nowMs()
    atomicWriteJson(tablePath, table)
  }

  function byKey(table) {
    const index = new Map()
    for (const task of Object.values(table.tasks)) index.set(task.keyHash, task)
    return index
  }

  function viewOf(task) {
    const now = nowMs()
    const expired = !TERMINAL_STATES.has(task.state) && Number(task.deadlineAt) < now
    return {
      taskRef: task.taskRef,
      state: task.state,
      expired,
      budgetMicro: task.budgetMicro,
      currency: task.currency,
      deadlineAt: task.deadlineAt,
      toolScope: task.toolScope.slice(),
      refsCount: task.refs.length,
      refKinds: Array.from(new Set(task.refs.map((r) => r.kind))).sort(),
      executions: task.executions,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      result: task.result ? { text: task.result.text, truncated: task.result.truncated === true } : null,
    }
  }

  function ownedBy(task, ownerRef, grants) {
    if (ownerRef && task.ownerRef === ownerRef) return true
    const list = Array.isArray(grants) ? grants : []
    return list.includes(taskRefToken(task.taskRef))
  }

  function requireTask(table, taskRef) {
    const id = toStr(taskRef).trim()
    if (!id) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'taskRef 缺失')
    const task = table.tasks[id]
    if (!task) throw new MockUhrError(MOCK_ERR.NOT_FOUND, 'mock UHR 没有该 taskRef', { taskRef: id })
    return task
  }

  function submit(payload = {}) {
    const key = toStr(payload.idempotencyKey).trim()
    if (!key || key.length > 512) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'idempotencyKey 必须是非空字符串（≤512）')
    const digest = toStr(payload.digest).trim()
    if (!/^[a-f0-9]{16,128}$/.test(digest)) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'digest 必须是十六进制摘要')
    const ownerRef = toStr(payload.ownerRef).trim()
    if (!SAFE_ID_RE.test(ownerRef)) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'ownerRef 必须匹配安全 id 形状')
    const budgetMicro = payload.budgetMicro
    if (typeof budgetMicro !== 'number' || !Number.isSafeInteger(budgetMicro) || budgetMicro <= 0) {
      throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'budgetMicro 必须是正整数最小单位')
    }
    const currency = toStr(payload.currency || currencyDefault).toUpperCase()
    if (!/^[A-Z]{3,8}$/.test(currency)) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'currency 必须是显式币种')
    const deadlineAt = Number(payload.deadlineAt)
    if (!Number.isFinite(deadlineAt)) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'deadlineAt 必须是毫秒时间戳')
    if (deadlineAt <= nowMs()) throw new MockUhrError(MOCK_ERR.BAD_REQUEST, 'deadlineAt 必须晚于当前时间')
    const refs = Array.isArray(payload.refs) ? payload.refs : []
    const toolScope = Array.isArray(payload.toolScope) ? payload.toolScope.map((t) => toStr(t)).filter(Boolean) : []
    const summary = isPlain(payload.summary) ? payload.summary : {}
    const keyHash = sha256Hex(key)

    const table = readTable()
    const index = byKey(table)
    const prior = index.get(keyHash)
    if (prior) {
      if (prior.digest !== digest) {
        throw new MockUhrError(MOCK_ERR.CONFLICT, '同一 idempotencyKey 的摘要不同：拒绝重复提交', { taskRef: prior.taskRef })
      }
      // 同键同摘要：返回既有任务，不重复执行（executions 不增）。
      return { taskRef: prior.taskRef, state: prior.state, duplicate: true, executions: prior.executions }
    }

    const now = nowMs()
    const taskRef = 'task-' + sha256Hex(keyHash + '|' + digest).slice(0, 20)
    if (table.tasks[taskRef]) throw new MockUhrError(MOCK_ERR.CONFLICT, 'taskRef 冲突', { taskRef })
    table.tasks[taskRef] = {
      taskRef,
      keyHash,
      digest,
      ownerRef,
      parentRef: payload.parentRef == null ? null : toStr(payload.parentRef),
      refs: refs.map((r) => ({ kind: toStr(r.kind), ref: toStr(r.ref) })),
      budgetMicro,
      currency,
      deadlineAt,
      toolScope,
      summary,
      state: MOCK_STATE.SUBMITTED,
      executions: 1,
      createdAt: now,
      updatedAt: now,
      result: null,
    }
    writeTable(table)
    return { taskRef, state: MOCK_STATE.SUBMITTED, duplicate: false, executions: 1 }
  }

  /** mock 专用钩子：模拟 UHR 侧任务完成（真实 UHR 由它自己的执行器推进状态）。 */
  function complete(taskRef, result) {
    const table = readTable()
    const task = requireTask(table, taskRef)
    if (TERMINAL_STATES.has(task.state)) {
      throw new MockUhrError(MOCK_ERR.TERMINAL, '任务已终态，不能再次完成', { taskRef: task.taskRef, state: task.state })
    }
    const text = toStr(result && result.text != null ? result.text : (result ? JSON.stringify(result) : ''))
    task.state = MOCK_STATE.SUCCEEDED
    task.result = { text: text.slice(0, MAX_RESULT_BYTES), truncated: text.length > MAX_RESULT_BYTES }
    task.updatedAt = nowMs()
    writeTable(table)
    return { taskRef: task.taskRef, state: task.state }
  }

  function getResult(payload = {}) {
    const table = readTable()
    const task = requireTask(table, payload.taskRef)
    if (!ownedBy(task, toStr(payload.ownerRef).trim(), payload.grants)) {
      throw new MockUhrError(MOCK_ERR.OWNER, '调用者既不是任务拥有者，也没有 scoped grant', { taskRef: task.taskRef })
    }
    return { ok: true, task: viewOf(task) }
  }

  function cancel(payload = {}) {
    const table = readTable()
    const task = requireTask(table, payload.taskRef)
    if (!ownedBy(task, toStr(payload.ownerRef).trim(), payload.grants)) {
      throw new MockUhrError(MOCK_ERR.OWNER, '调用者既不是任务拥有者，也没有 scoped grant', { taskRef: task.taskRef })
    }
    if (task.state === MOCK_STATE.CANCELLED) {
      // 取消幂等：再次取消返回同一状态，不报错、不改时间线。
      return { taskRef: task.taskRef, state: task.state, duplicate: true }
    }
    if (TERMINAL_STATES.has(task.state)) {
      throw new MockUhrError(MOCK_ERR.TERMINAL, '任务已终态，无法取消', { taskRef: task.taskRef, state: task.state })
    }
    task.state = MOCK_STATE.CANCELLED
    task.updatedAt = nowMs()
    writeTable(table)
    return { taskRef: task.taskRef, state: task.state, duplicate: false }
  }

  function executionsOf(taskRef) {
    const table = readTable()
    const task = requireTask(table, taskRef)
    return task.executions
  }

  /** 脱敏快照：只有计数与状态分布，不含任务内容。 */
  function snapshot() {
    const table = readTable()
    const counts = { total: 0, submitted: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }
    for (const task of Object.values(table.tasks)) {
      counts.total += 1
      if (counts[task.state] != null) counts[task.state] += 1
    }
    return {
      contract: MOCK_CONTRACT,
      version: MOCK_VERSION,
      currency: currencyDefault,
      updatedAt: table.updatedAt,
      counts,
    }
  }

  // 打开即校验：任务表损坏必须立刻失败，不能等到第一次写/submit 才暴露（也绝不自动重置）。
  readTable()

  return {
    dir,
    contract: MOCK_CONTRACT,
    version: MOCK_VERSION,
    submit,
    complete,
    getResult,
    cancel,
    executionsOf,
    snapshot,
    close() { return Promise.resolve() },
  }
}
