// G3/G4：MCP 委派任务的持久化状态机（本机文件存储，零依赖）。
//
// 设计约束（方案 §3.4）：
//   · 发送前持久化 ADMITTED/DISPATCHED；网络写入开始后无法确认结果 → UNKNOWN，**不得重发**。
//   · taskRef / parentThreadId / providerSessionId / turnId / 幂等键建立明确关联。
//   · wait 超时只代表等待窗口结束，不是任务失败（由调用方处理，不在本模块改状态）。
//   · 同一幂等键 + 同一请求摘要 ⇒ 同一 taskRef/turnId；同键不同摘要 ⇒ 冲突。
//   · 只存必要事实：不存任务正文、不存 token/Key、不存上游正文；正文只留摘要与字节数。

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ERRORS, STATES, isTerminal, idemKeyHash, resultDigestOf, turnRefFor } from './delegation-contract.js'

const TASK_FILE_RE = /^mgtask-[0-9a-f]{16}\.json$/
const SCHEMA_VERSION = 1

// 每个 turn 的合法转移：只允许向前，除 ACKNOWLEDGED 外不回退。
const ALLOWED = Object.freeze({
  [STATES.CREATED]: [STATES.ADMITTED, STATES.CANCELLED, STATES.FAILED],
  [STATES.ADMITTED]: [STATES.DISPATCHED, STATES.CANCELLED, STATES.FAILED],
  [STATES.DISPATCHED]: [STATES.RUNNING, STATES.RESULT_READY, STATES.FAILED, STATES.CANCELLED, STATES.UNKNOWN],
  [STATES.RUNNING]: [STATES.RESULT_READY, STATES.FAILED, STATES.CANCELLED, STATES.UNKNOWN],
  [STATES.RESULT_READY]: [STATES.ACKNOWLEDGED],
  [STATES.ACKNOWLEDGED]: [],
  [STATES.FAILED]: [],
  [STATES.CANCELLED]: [],
  [STATES.UNKNOWN]: [],
})

export class StoreError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'StoreError'
    this.code = code
  }
}

// 统一时钟：调用方传毫秒数（now() 的结果），不接受函数本身，避免 NaN 时间。
function nowIso(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) throw new StoreError(ERRORS.STORE_IO, 'store 时钟无效：' + String(ms))
  return new Date(n).toISOString()
}
function newTurnId() { return turnRefFor(randomBytes(16).toString('hex')) }
function newSessionRef() { return 'mgs-' + randomBytes(16).toString('hex') }

/**
 * createTaskStore({ dir, now?, onCorrupt? })
 * dir = <stateDir>/tasks，配合 <stateDir>/idem.json 做幂等索引。
 */
export function createTaskStore(opts = {}) {
  const dir = String(opts.dir || '')
  if (!dir) throw new StoreError(ERRORS.INTERNAL, 'task store 需要目录')
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const onCorrupt = opts.onCorrupt === 'throw' ? 'throw' : 'quarantine'
  const idemPath = join(dir, '..', 'idem.json')
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const tasks = new Map()
  const idem = new Map()      // 'delegate:<key>' | 'followup:<taskRef>:<key>' -> { digest, taskRef, turnId }
  const quarantined = []

  function writeAtomic(path, value) {
    const tmp = path + '.tmp-' + randomBytes(6).toString('hex')
    const text = JSON.stringify(value, null, 2) + '\n'
    writeFileSync(tmp, text, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, path)
  }

  function loadIdem() {
    let raw
    try { raw = readFileSync(idemPath, 'utf8') } catch { return }
    try {
      const parsed = JSON.parse(raw)
      const entries = parsed && typeof parsed.entries === 'object' ? parsed.entries : {}
      for (const [k, v] of Object.entries(entries)) {
        if (v && typeof v === 'object' && typeof v.digest === 'string') idem.set(k, v)
      }
    } catch {
      // 幂等索引损坏不能静默清空（那会导致重复派发）：整体隔离并停用索引写入。
      quarantine(idemPath, 'idem')
      throw new StoreError(ERRORS.STORE_CORRUPT, 'idem.json 损坏：已隔离，拒绝在无幂等保证的情况下继续')
    }
  }

  function quarantine(path, label) {
    const target = path + '.corrupt-' + Date.now()
    try { renameSync(path, target) } catch {}
    quarantined.push({ label, path: target })
  }

  function load() {
    let names = []
    try { names = readdirSync(dir) } catch { names = [] }
    for (const name of names) {
      if (!TASK_FILE_RE.test(name)) continue
      const path = join(dir, name)
      let raw
      try { raw = readFileSync(path, 'utf8') } catch { continue }
      let rec
      try { rec = JSON.parse(raw) } catch { rec = null }
      if (!rec || typeof rec !== 'object' || typeof rec.taskRef !== 'string' || !Array.isArray(rec.turns)) {
        if (onCorrupt === 'throw') throw new StoreError(ERRORS.STORE_CORRUPT, '任务文件损坏：' + name)
        quarantine(path, name)
        continue
      }
      tasks.set(rec.taskRef, rec)
    }
  }

  load()
  loadIdem()

  function persist(rec) {
    rec.updatedAt = nowIso(now())
    writeAtomic(join(dir, rec.taskRef + '.json'), rec)
  }

  function persistIdem() {
    const entries = {}
    for (const [k, v] of idem) entries[k] = v
    writeAtomic(idemPath, { schema: 'modelgate.mcp.idem/1', entries })
  }

  function mustGet(taskRef) {
    const rec = tasks.get(taskRef)
    if (!rec) throw new StoreError(ERRORS.TASK_NOT_FOUND, '任务不存在：' + taskRef)
    return rec
  }

  function turnOf(rec, turnId) {
    if (turnId == null) return rec.turns[rec.turns.length - 1]
    const t = rec.turns.find((x) => x.turnId === turnId)
    if (!t) throw new StoreError(ERRORS.TASK_NOT_FOUND, '回合不存在：' + turnId)
    return t
  }

  const store = {
    dir,
    idemPath,
    get quarantined() { return quarantined.slice() },

    stats() {
      const byState = {}
      for (const rec of tasks.values()) {
        const s = rec.turns.length ? rec.turns[rec.turns.length - 1].state : STATES.CREATED
        byState[s] = (byState[s] || 0) + 1
      }
      return { tasks: tasks.size, byState, quarantined: quarantined.length, contractVersion: SCHEMA_VERSION }
    },

    list() { return [...tasks.values()] },
    get(taskRef) { return tasks.get(taskRef) || null },
    mustGet,

    /** 新建任务（含第 1 个 turn）。幂等由调用方先查 findDelegateIdem。 */
    create(input) {
      const at = nowIso(now())
      const rec = {
        schema: 'modelgate.mcp.task/1',
        contractVersion: SCHEMA_VERSION,
        taskRef: input.taskRef,
        provider: input.provider,
        model: input.model,
        // 归属引用：由配置目录 + OS 用户派生，模型不可控制（契约 §7.1）。
        ownerRef: input.ownerRef || null,
        // 不透明上游会话标识：随机生成、跨重启稳定，绝不由客户端线程 id 直接充当。
        sessionRef: newSessionRef(),
        principalHash: input.principalHash || null,
        parentThreadHash: input.parentThreadHash || null,
        workspaceId: input.workspaceId || null,
        createdAt: at,
        updatedAt: at,
        turns: [],
      }
      const turn = {
        turnId: newTurnId(),
        index: 0,
        kind: 'delegate',
        state: STATES.CREATED,
        createdAt: at,
        updatedAt: at,
        requestDigest: input.requestDigest,
        taskBytes: input.taskBytes,
        budgetMs: input.budgetMs,
        allowResultTruncation: input.allowResultTruncation === true,
        idempotencyKey: input.idempotencyKey,
        admittedAt: null,
        dispatchedAt: null,
        runningAt: null,
        finishedAt: null,
        cancel: null,
        error: null,
        result: null,
        progress: { events: 0, steps: 0, bytes: 0 },
      }
      rec.turns.push(turn)
      tasks.set(rec.taskRef, rec)
      persist(rec)
      return rec
    },

    /** 追派：在同一个 taskRef/session 上追加一个 turn。 */
    appendTurn(taskRef, input) {
      const rec = mustGet(taskRef)
      const last = rec.turns[rec.turns.length - 1]
      if (!isTerminal(last.state)) throw new StoreError(ERRORS.STATE_CONFLICT, '上一回合未到终态（' + last.state + '）：不能追派')
      const at = nowIso(now())
      const turn = {
        turnId: newTurnId(),
        index: rec.turns.length,
        kind: 'followup',
        state: STATES.CREATED,
        createdAt: at,
        updatedAt: at,
        requestDigest: input.requestDigest,
        taskBytes: input.taskBytes,
        budgetMs: input.budgetMs,
        allowResultTruncation: input.allowResultTruncation === true,
        idempotencyKey: input.idempotencyKey,
        admittedAt: null,
        dispatchedAt: null,
        runningAt: null,
        finishedAt: null,
        cancel: null,
        error: null,
        result: null,
        progress: { events: 0, steps: 0, bytes: 0 },
      }
      rec.turns.push(turn)
      persist(rec)
      return { rec, turn }
    },

    /** 合法状态转移 + 打补丁。非法转移抛 STATE_CONFLICT（不静默吞掉）。 */
    transition(taskRef, turnId, toState, patch = {}) {
      const rec = mustGet(taskRef)
      const turn = turnOf(rec, turnId)
      if (turn.state === toState) { Object.assign(turn, patch); persist(rec); return turn }
      const allowed = ALLOWED[turn.state] || []
      if (!allowed.includes(toState)) {
        throw new StoreError(ERRORS.STATE_CONFLICT, '非法状态转移 ' + turn.state + ' → ' + toState + '（' + rec.taskRef + '/' + turn.turnId + '）')
      }
      turn.state = toState
      turn.updatedAt = nowIso(now())
      if (toState === STATES.ADMITTED && !turn.admittedAt) turn.admittedAt = turn.updatedAt
      if (toState === STATES.DISPATCHED && !turn.dispatchedAt) turn.dispatchedAt = turn.updatedAt
      if (toState === STATES.RUNNING && !turn.runningAt) turn.runningAt = turn.updatedAt
      if (isTerminal(toState) && !turn.finishedAt) turn.finishedAt = turn.updatedAt
      Object.assign(turn, patch)
      persist(rec)
      return turn
    },

    /** 进程内进度计数（每秒最多落盘一次由调用方控制）。 */
    touch(taskRef, turnId, patch = {}) {
      const rec = mustGet(taskRef)
      const turn = turnOf(rec, turnId)
      Object.assign(turn.progress, patch)
      turn.updatedAt = nowIso(now())
      persist(rec)
      return turn
    },

    // —— 幂等索引（明文键不落盘：只存 sha256(ownerRef:key) 前 32 hex）——
    findDelegateIdem(ownerRef, key) { return idem.get('delegate:' + idemKeyHash(ownerRef, key)) || null },
    registerDelegateIdem(ownerRef, key, entry) { idem.set('delegate:' + idemKeyHash(ownerRef, key), entry); persistIdem() },
    findFollowupIdem(ownerRef, taskRef, key) { return idem.get('followup:' + idemKeyHash(ownerRef, key) + ':' + taskRef) || null },
    registerFollowupIdem(ownerRef, taskRef, key, entry) { idem.set('followup:' + idemKeyHash(ownerRef, key) + ':' + taskRef, entry); persistIdem() },

    /**
     * 重启对账：DISPATCHED/RUNNING 的 turn 没有活着的 runner → UNKNOWN（不重发、不重试）。
     * 返回被对账的条目，供 doctor/报告使用。
     */
    reconcile() {
      const touched = []
      for (const rec of tasks.values()) {
        const turn = rec.turns[rec.turns.length - 1]
        if (!turn) continue
        if (turn.state === STATES.DISPATCHED || turn.state === STATES.RUNNING) {
          const at = nowIso(now())
          Object.assign(turn, {
            state: STATES.UNKNOWN,
            updatedAt: at,
            finishedAt: at,
            error: { code: ERRORS.UPSTREAM_UNKNOWN, message: '进程重启时回合处于 ' + turn.state + '：上游可能已执行，禁止自动重发，需人工/父端核对' },
          })
          persist(rec)
          touched.push({ taskRef: rec.taskRef, turnId: turn.turnId, from: STATES.DISPATCHED })
        }
      }
      return touched
    },

    /** 显式回填（测试/运维）：把 UNKNOWN 标记为已核对的结果。 */
    resolveUnknown(taskRef, turnId, patch) {
      const rec = mustGet(taskRef)
      const turn = turnOf(rec, turnId)
      if (turn.state !== STATES.UNKNOWN) throw new StoreError(ERRORS.STATE_CONFLICT, '只有 UNKNOWN 可人工核对：当前 ' + turn.state)
      Object.assign(turn, patch, { updatedAt: nowIso(now()) })
      persist(rec)
      return turn
    },

    remove(taskRef) {
      const rec = tasks.get(taskRef)
      if (!rec) return false
      tasks.delete(taskRef)
      try { rmSync(join(dir, taskRef + '.json'), { force: true }) } catch {}
      return true
    },
  }
  return store
}

/** 把存储记录投影成对外可返回的视图（脱敏、限长、区分 wait 超时）。 */
export function taskView(rec, opts = {}) {
  const includeResult = opts.includeResult !== false
  const turn = opts.turnId ? rec.turns.find((t) => t.turnId === opts.turnId) : rec.turns[rec.turns.length - 1]
  const acknowledged = turn.state === STATES.ACKNOWLEDGED
  const view = {
    contract: 'modelgate-mcp-delegation-v1',
    taskRef: rec.taskRef,
    turnRef: turn.turnId,
    ownerRef: rec.ownerRef || null,
    state: turn.state,
    acknowledged,
    provider: rec.provider,
    model: rec.model,
    createdAt: rec.createdAt,
    updatedAt: turn.updatedAt,
    elapsedMs: turn.createdAt && turn.finishedAt ? Math.max(0, Date.parse(turn.finishedAt) - Date.parse(turn.createdAt)) : null,
    turns: rec.turns.length,
    turnIndex: turn.index,
    turnId: turn.turnId,
    // 诚实性：这不是 Codex 原生 spawn_agent 子线程。
    delegation: { kind: 'external_delegation', native: false, degraded: true, contract: 'modelgate-mcp-delegation-v1' },
  }
  if (turn.error) view.error = turn.error
  if (turn.cancel) view.cancel = turn.cancel
  if (includeResult && turn.result) view.result = turn.result
  return view
}
