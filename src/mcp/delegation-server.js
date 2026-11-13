// G3/G4：MCP 委派服务端（JSON-RPC 2.0 over stdio 的纯逻辑层，不直接碰 stdin/stdout）。
//
// 传输层见 bin/mg-mcp.mjs：一行一个 JSON-RPC 消息。本模块只负责协议分派、工具语义、
// 任务编排（delegate/get/wait/followup/cancel）与状态机驱动，便于离线确定性测试。
//
// 关键不变量：
//   1. 一个委派 turn 只发生一次网络写入；失败不自动重试、不换上游（宁可 FAILED/UNKNOWN 也不重复执行）。
//   2. DISPATCHED 在**发起请求前**持久化；进程崩溃后 reconcile 把在途 turn 标为 UNKNOWN，不重发。
//   3. wait 超时只结束本次等待窗口，不改变任务状态。
//   4. 读取结果（get/wait/includeResult）才把 RESULT_READY 推进到 ACKNOWLEDGED。
//   5. provider/model 由服务端配置决定；工具参数无法覆盖。

import { randomBytes } from 'node:crypto'
import { buildProvider } from '../router.js'
import {
  ERRORS, LIMITS, MCP_CONTRACT, SERVER_NAME, SERVER_VERSION, STATES, TOOL_NAMES,
  ownerRefFor, parseCancelArgs, parseDelegateArgs, parseFollowupArgs, parseGetArgs, parseWaitArgs,
  resultDigestOf, taskRefFor, toolDefinitions,
} from './delegation-contract.js'
import { createTaskStore, taskView, StoreError } from './delegation-store.js'
import { createGoExecutor } from './delegation-executor.js'
import { fingerprintRefs } from './delegation-tools.js'

const PROTOCOL_VERSION = '2024-11-05'
const POLL_MS = 25

function rpcError(id, code, message, data) {
  const err = { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }
  if (data !== undefined) err.error.data = data
  return err
}
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result } }

function toolError(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  }
}
function toolOk(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

/**
 * createDelegationServer({ cfg, store, providerId, model, workspaceTools, workspaceRoot,
 *   maxConcurrent?, maxSteps?, reasoningEffort?, now?, log?, executor?, providerFactory?, principal? })
 */
export function createDelegationServer(opts = {}) {
  const cfg = opts.cfg || {}
  const providerId = String(opts.providerId || 'opencodego')
  const model = String(opts.model || 'deepseek-v4.1-flash')
  const workspaceRoot = opts.workspaceRoot || null
  const workspaceTools = opts.workspaceTools || null
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const log = opts.log && typeof opts.log === 'object' ? opts.log : null
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || 2)
  const principal = String(opts.principal || 'local-mcp')
  const principalHash = 'prin-' + Buffer.from(principal).toString('hex').slice(0, 16)
  // ownerRef 由服务端派生（配置目录 + OS 用户），模型永远无法通过工具参数影响它。
  const ownerRef = String(opts.ownerRef || ownerRefFor({
    configDir: (cfg._paths && cfg._paths.dir) || '',
    user: opts.user || process.env.USER || process.env.USERNAME || '',
  }))
  const providerFactory = typeof opts.providerFactory === 'function'
    ? opts.providerFactory
    : (id) => buildProvider(cfg, id)
  const executor = opts.executor || createGoExecutor({
    cfg,
    providerId,
    model,
    workspaceRoot,
    workspaceTools,
    maxSteps: opts.maxSteps,
    reasoningEffort: opts.reasoningEffort,
    log,
    now,
  })
  const store = opts.store || createTaskStore({ dir: opts.storeDir, now })

  // 运行槽位：排队期保持 ADMITTED（尚未写网络），拿到槽位才 DISPATCHED。
  let running = 0
  const slotWaiters = []
  function acquireSlot() {
    if (running < maxConcurrent) { running += 1; return Promise.resolve() }
    return new Promise((resolve) => slotWaiters.push(resolve))
  }
  function releaseSlot() {
    const next = slotWaiters.shift()
    if (next) { next(); return }
    running = Math.max(0, running - 1)
  }

  const runners = new Map()   // taskRef -> { controller, done: Promise }
  const waiters = new Map()   // taskRef -> Set<fn>

  function notify(taskRef) {
    const set = waiters.get(taskRef)
    if (!set) return
    for (const fn of set) { try { fn() } catch {} }
  }

  function waitFor(taskRef, timeoutMs) {
    const rec = store.get(taskRef)
    if (!rec) return Promise.reject(new StoreError(ERRORS.TASK_NOT_FOUND, '任务不存在：' + taskRef))
    const turn = rec.turns[rec.turns.length - 1]
    if (turn.state === STATES.RESULT_READY || turn.state === STATES.ACKNOWLEDGED || turn.state === STATES.FAILED || turn.state === STATES.CANCELLED || turn.state === STATES.UNKNOWN) {
      return Promise.resolve({ timedOut: false })
    }
    if (!timeoutMs || timeoutMs <= 0) return Promise.resolve({ timedOut: true })
    return new Promise((resolve) => {
      let settled = false
      const finish = (timedOut) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const set = waiters.get(taskRef)
        if (set) { set.delete(check); if (!set.size) waiters.delete(taskRef) }
        resolve({ timedOut })
      }
      const check = () => {
        const r = store.get(taskRef)
        const t = r && r.turns[r.turns.length - 1]
        if (t && [STATES.RESULT_READY, STATES.ACKNOWLEDGED, STATES.FAILED, STATES.CANCELLED, STATES.UNKNOWN].includes(t.state)) finish(false)
      }
      const timer = setTimeout(() => finish(true), Math.min(timeoutMs, LIMITS.waitMaxMs))
      if (typeof timer.unref === 'function') timer.unref()
      const set = waiters.get(taskRef) || new Set()
      set.add(check)
      waiters.set(taskRef, set)
    })
  }

  /** 归属校验：只允许操作本 owner 的 taskRef（猜测/枚举一律 NOT_OWNER，与不存在区分开但都不泄露内容）。 */
  function ownedOrError(taskRef) {
    const rec = store.get(taskRef)
    if (!rec) return { error: { code: ERRORS.TASK_NOT_FOUND, message: '任务不存在：' + taskRef } }
    if (rec.ownerRef && ownerRef && rec.ownerRef !== ownerRef) {
      return { error: { code: ERRORS.NOT_OWNER, message: 'taskRef 不属于当前 owner', reason: 'owner_mismatch' } }
    }
    return { rec }
  }

  function view(taskRef, opts2 = {}) {
    const rec = store.mustGet(taskRef)
    const turnId = opts2.turnId
    const v = taskView(rec, { includeResult: opts2.includeResult !== false, turnId })
    if (opts2.timedOut !== undefined) v.waitTimedOut = opts2.timedOut
    return v
  }

  /** RESULT_READY → ACKNOWLEDGED（父端确认读取后才推进）。 */
  function acknowledge(taskRef, turnId) {
    const rec = store.get(taskRef)
    if (!rec) return
    const turn = rec.turns.find((t) => t.turnId === turnId)
    if (turn && turn.state === STATES.RESULT_READY) {
      try { store.transition(taskRef, turnId, STATES.ACKNOWLEDGED) } catch {}
    }
  }

  function startTurn(taskRef, turnId, runOpts) {
    const controller = new AbortController()
    const done = (async () => {
      try {
        await acquireSlot()
      } catch (err) {
        try { store.transition(taskRef, turnId, STATES.FAILED, { error: { code: ERRORS.INTERNAL, message: String(err && err.message) } }) } catch {}
        notify(taskRef)
        return
      }
      try {
        const rec = store.mustGet(taskRef)
        const turn = rec.turns.find((t) => t.turnId === turnId)
        if (!turn || turn.state === STATES.CANCELLED) return
        // 发送前持久化 DISPATCHED：崩溃后能识别「可能已写入」，绝不重发。
        store.transition(taskRef, turnId, STATES.DISPATCHED)
        const provider = providerFactory(providerId)
        const before = workspaceTools ? fingerprintRefs(workspaceTools, runOpts.workspaceRefs) : []
        const result = await executor.runTurn({
          task: runOpts.task,
          constraints: runOpts.constraints,
          budgetMs: turn.budgetMs,
          sessionRef: rec.sessionRef,
          workspaceRefs: runOpts.workspaceRefs,
          refsBefore: before,
          allowResultTruncation: turn.allowResultTruncation,
          principalRef: principalHash,
          reasoningEffort: runOpts.reasoningEffort || null,
          provider,
          signal: controller.signal,
          transport: runOpts.transport,
          onState: (s) => {
            try { if (s === STATES.RUNNING) store.transition(taskRef, turnId, STATES.RUNNING) } catch {}
            notify(taskRef)
          },
          onProgress: (p) => {
            try { store.touch(taskRef, turnId, p) } catch {}
          },
        })
        const digest = resultDigestOf({
          artifacts: result.artifacts,
          model,
          provider: providerId,
          resultText: result.resultText,
          taskRef,
          turnRef: turnId,
        })
        store.transition(taskRef, turnId, STATES.RESULT_READY, {
          result: {
            text: result.resultText,
            truncated: result.truncated,
            bytes: result.resultBytes,
            digest,
            usage: result.usage,
            toolCallCount: result.toolCallCount,
            failedToolCalls: result.failedToolCalls,
            toolCalls: result.toolCalls.slice(0, 64),
            steps: result.steps,
            artifacts: result.artifacts,
            lossy: result.lossy,
            upstream: result.upstream,
          },
        })
        if (log && typeof log.info === 'function') log.info('mcp task result ready', 'task=' + taskRef, 'turn=' + turnId, 'steps=' + result.steps, 'bytes=' + result.resultBytes)
      } catch (err) {
        const cancelled = controller.signal.aborted || (err && err.name === 'AbortError')
        const info = cancelled
          ? { code: ERRORS.STORE_IO, message: '任务被取消' }
          : { code: (err && err.code && String(err.code).startsWith('MCP_')) ? err.code : ERRORS.INTERNAL, message: String((err && err.message) || 'task failed') }
        const rec2 = store.get(taskRef)
        const turn2 = rec2 && rec2.turns.find((t) => t.turnId === turnId)
        const target = cancelled ? STATES.CANCELLED : STATES.FAILED
        if (turn2 && (turn2.state === STATES.DISPATCHED || turn2.state === STATES.RUNNING || turn2.state === STATES.ADMITTED)) {
          try {
            store.transition(taskRef, turnId, target, cancelled
              ? { cancel: { delivered: true, mode: 'local_abort', upstreamStopUnknown: true, at: new Date(now()).toISOString() } }
              : { error: info })
          } catch (e) {
            try { store.transition(taskRef, turnId, STATES.UNKNOWN, { error: { code: ERRORS.UPSTREAM_UNKNOWN, message: '收尾失败：' + String(e && e.message) } }) } catch {}
          }
        }
        if (log && typeof log.warn === 'function') log.warn('mcp task failed', 'task=' + taskRef, 'turn=' + turnId, 'code=' + info.code)
      } finally {
        releaseSlot()
        runners.delete(taskRef)
        notify(taskRef)
      }
    })()
    runners.set(taskRef, { controller, done })
    return done
  }

  // —— 工具实现 ——

  function delegate(args) {
    const parsed = parseDelegateArgs(args)
    if (!parsed.ok) return toolError({ error: parsed.error })
    const v = parsed.value
    const existing = store.findDelegateIdem(ownerRef, v.idempotencyKey)
    if (existing) {
      if (existing.digest !== v.requestDigest) {
        return toolError({ error: { code: ERRORS.IDEM_CONFLICT, message: '同一幂等键已用于不同任务正文：拒绝创建第二个派发', reason: 'digest_mismatch' } })
      }
      return toolOk({ replayed: true, ...view(existing.taskRef, { includeResult: true }) })
    }
    const refs = v.workspaceRefs || []
    for (const r of refs) {
      // 引用路径在创建时就要能落到工作区，否则提前拒绝（避免任务跑完才发现引用非法）。
      if (workspaceTools) {
        try { workspaceTools.stat(r.path) } catch (err) {
          return toolError({ error: { code: (err && err.code) || ERRORS.WORKSPACE_DENIED, message: String((err && err.message) || '引用非法') } })
        }
      }
    }
    const taskRef = taskRefFor([v.idempotencyKey, v.requestDigest, randomBytes(8).toString('hex')].join('|'))
    const rec = store.create({
      taskRef,
      ownerRef,
      provider: providerId,
      model,
      requestDigest: v.requestDigest,
      taskBytes: Buffer.byteLength(v.task, 'utf8'),
      budgetMs: v.budgetMs,
      allowResultTruncation: v.allowResultTruncation,
      idempotencyKey: v.idempotencyKey,
      principalHash,
      workspaceId: workspaceTools && workspaceTools.root ? workspaceTools.root : null,
      parentThreadHash: v.parentThreadId ? hashShort(v.parentThreadId) : null,
    })
    store.registerDelegateIdem(ownerRef, v.idempotencyKey, { digest: v.requestDigest, taskRef, turnId: rec.turns[0].turnId })
    store.transition(taskRef, rec.turns[0].turnId, STATES.ADMITTED)
    startTurn(taskRef, rec.turns[0].turnId, { task: v.task, constraints: v.constraints, workspaceRefs: v.workspaceRefs, reasoningEffort: v.reasoningEffort })
    return toolOk(view(taskRef, { includeResult: true }))
  }

  function get(args) {
    const parsed = parseGetArgs(args)
    if (!parsed.ok) return toolError({ error: parsed.error })
    const owned = ownedOrError(parsed.value.taskRef)
    if (owned.error) return toolError({ error: owned.error })
    const rec = owned.rec
    const turn = rec.turns[rec.turns.length - 1]
    const out = view(parsed.value.taskRef, { includeResult: parsed.value.includeResult })
    if (parsed.value.includeResult && turn.state === STATES.RESULT_READY) acknowledge(parsed.value.taskRef, turn.turnId)
    return toolOk(out)
  }

  async function wait(args) {
    const parsed = parseWaitArgs(args)
    if (!parsed.ok) return toolError({ error: parsed.error })
    const taskRef = parsed.value.taskRef
    const owned = ownedOrError(taskRef)
    if (owned.error) return toolError({ error: owned.error })
    const res = await waitFor(taskRef, parsed.value.timeoutMs)
    const rec = store.mustGet(taskRef)
    const turn = rec.turns[rec.turns.length - 1]
    const out = view(taskRef, { includeResult: parsed.value.includeResult, timedOut: res.timedOut })
    if (parsed.value.includeResult && turn.state === STATES.RESULT_READY) acknowledge(taskRef, turn.turnId)
    return toolOk(out)
  }

  function followup(args) {
    const parsed = parseFollowupArgs(args)
    if (!parsed.ok) return toolError({ error: parsed.error })
    const v = parsed.value
    const owned = ownedOrError(v.taskRef)
    if (owned.error) return toolError({ error: owned.error })
    const rec = owned.rec
    const last = rec.turns[rec.turns.length - 1]
    if (last.state === STATES.UNKNOWN) {
      return toolError({ error: { code: ERRORS.UPSTREAM_UNKNOWN, message: '上一回合状态 UNKNOWN：发送结果未确认，必须先对账（不可重发/追派）', reason: 'unreconciled' } })
    }
    if (last.state === STATES.CREATED || last.state === STATES.ADMITTED || last.state === STATES.DISPATCHED || last.state === STATES.RUNNING) {
      return toolError({ error: { code: ERRORS.STATE_CONFLICT, message: '上一回合未到终态（' + last.state + '）：先 wait 或 cancel，再追派' } })
    }
    const existing = store.findFollowupIdem(ownerRef, v.taskRef, v.idempotencyKey)
    if (existing) {
      if (existing.digest !== v.requestDigest) {
        return toolError({ error: { code: ERRORS.IDEM_CONFLICT, message: '同一幂等键已用于不同追派正文：拒绝重复派发', reason: 'digest_mismatch' } })
      }
      return toolOk({ replayed: true, ...view(v.taskRef, { turnId: existing.turnId, includeResult: true }) })
    }
    const { turn } = store.appendTurn(v.taskRef, {
      requestDigest: v.requestDigest,
      taskBytes: Buffer.byteLength(v.task, 'utf8'),
      budgetMs: v.budgetMs,
      allowResultTruncation: v.allowResultTruncation,
      idempotencyKey: v.idempotencyKey,
    })
    store.registerFollowupIdem(ownerRef, v.taskRef, v.idempotencyKey, { digest: v.requestDigest, taskRef: v.taskRef, turnId: turn.turnId })
    store.transition(v.taskRef, turn.turnId, STATES.ADMITTED)
    startTurn(v.taskRef, turn.turnId, { task: v.task, constraints: v.constraints, workspaceRefs: [], reasoningEffort: null })
    return toolOk(view(v.taskRef, { turnId: turn.turnId, includeResult: true }))
  }

  function cancel(args) {
    const parsed = parseCancelArgs(args)
    if (!parsed.ok) return toolError({ error: parsed.error })
    const taskRef = parsed.value.taskRef
    const owned = ownedOrError(taskRef)
    if (owned.error) return toolError({ error: owned.error })
    const rec = owned.rec
    const turn = rec.turns[rec.turns.length - 1]
    const at = new Date(now()).toISOString()
    if (turn.state === STATES.UNKNOWN) {
      return toolError({ error: { code: ERRORS.UPSTREAM_UNKNOWN, message: '任务状态 UNKNOWN：发送结果未确认，不得假装取消成功，请先对账', reason: 'unreconciled' } })
    }
    if (turn.state === STATES.RESULT_READY || turn.state === STATES.ACKNOWLEDGED) {
      return toolOk({ noop: true, cancel: { delivered: false, reason: 'already_finished' }, ...view(taskRef, { includeResult: true }) })
    }
    if (turn.state === STATES.FAILED || turn.state === STATES.CANCELLED || turn.state === STATES.UNKNOWN) {
      return toolOk({ noop: true, cancel: { delivered: false, reason: 'terminal_' + turn.state.toLowerCase() }, ...view(taskRef, { includeResult: true }) })
    }
    if (turn.state === STATES.CREATED || turn.state === STATES.ADMITTED) {
      store.transition(taskRef, turn.turnId, STATES.CANCELLED, { cancel: { delivered: false, reason: parsed.value.reason || 'client_cancel', mode: 'not_sent', at } })
      notify(taskRef)
      return toolOk({ ...view(taskRef, { includeResult: true }) })
    }
    // DISPATCHED/RUNNING：本地中止。诚实记录「上游是否已停止」未知。
    const runner = runners.get(taskRef)
    if (runner) { try { runner.controller.abort() } catch {} }
    store.transition(taskRef, turn.turnId, STATES.CANCELLED, {
      cancel: { delivered: true, reason: parsed.value.reason || 'client_cancel', mode: 'local_abort', upstreamStopUnknown: true, abortRequestedAt: at },
    })
    notify(taskRef)
    return toolOk({ ...view(taskRef, { includeResult: true }) })
  }

  const handlers = {
    [TOOL_NAMES.DELEGATE]: delegate,
    [TOOL_NAMES.GET]: get,
    [TOOL_NAMES.WAIT]: wait,
    [TOOL_NAMES.FOLLOWUP]: followup,
    [TOOL_NAMES.CANCEL]: cancel,
  }

  let inFlight = 0
  async function callTool(name, args) {
    const handler = handlers[name]
    // 通道 A：未知工具名是协议错误，不是工具结果错误（契约 §2.3 / §9.1）。
    if (!handler) return { channelA: { rpcCode: -32602, message: '未知工具：' + name, modelgateCode: ERRORS.UNKNOWN_TOOL } }
    if (inFlight >= LIMITS.busyInFlight) {
      return toolError({ error: { code: ERRORS.BUSY, message: '并发 tools/call 已达到上限 ' + LIMITS.busyInFlight, retryable: true, limit: LIMITS.busyInFlight } })
    }
    inFlight += 1
    try {
      return await handler(args || {})
    } catch (err) {
      const code = (err && err.code && String(err.code).startsWith('MCP_')) ? err.code : ERRORS.INTERNAL
      return toolError({ error: { code, message: String((err && err.message) || 'tool failed') } })
    } finally {
      inFlight -= 1
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Invalid Request')
    }
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null
    if (method === 'initialize') {
      if (isNotification) return null
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, contract: MCP_CONTRACT },
      })
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null
    if (method === 'ping') return isNotification ? null : rpcResult(id, {})
    if (method === 'tools/list') {
      return rpcResult(id, { tools: toolDefinitions() })
    }
    if (method === 'tools/call') {
      const name = params && params.name
      const args = params && params.arguments ? params.arguments : {}
      if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'tools/call 需要 name', { modelgateCode: ERRORS.INVALID_REQUEST })
      const out = await callTool(name, args)
      if (out && out.channelA) return rpcError(id, out.channelA.rpcCode, out.channelA.message, { modelgateCode: out.channelA.modelgateCode })
      return rpcResult(id, out)
    }
    if (method === 'resources/list') return rpcResult(id, { resources: [] })
    if (method === 'prompts/list') return rpcResult(id, { prompts: [] })
    return rpcError(id, -32601, '未知方法：' + method, { modelgateCode: ERRORS.METHOD_NOT_FOUND })
  }

  return {
    handle,
    callTool,
    store,
    executor,
    stats() { return store.stats() },
    reconcile() { return store.reconcile() },
    runningCount() { return running },
    async shutdown() {
      for (const { controller } of runners.values()) { try { controller.abort() } catch {} }
      await Promise.allSettled([...runners.values()].map((r) => r.done))
    },
    config: { providerId, model, workspaceRoot, maxConcurrent, principalHash },
  }
}

function hashShort(v) {
  // 父会话标识只留不可逆短摘要：可去重、不可还原。
  let h = 0
  const s = String(v)
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0 }
  return 'thr-' + h.toString(16).padStart(8, '0')
}
