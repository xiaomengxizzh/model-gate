// Codex V2 Code Mode「单元（cell）」让出/收取状态机（A1，MG-R005/R006）。
//
// 背景（docs/evidence/2026-11-13-modelgate-native-live.md §首次父进程等待停滞）：
// V2 父代理在 Code Mode 里调用 `collaboration__wait_agent`，单元（cell）在子代理完成前以“仍在运行”
// 让出控制；父代理必须用顶层 `wait({cell_id})` 收取同一单元，直到该单元进入终态。已经观测到的事实：
//   ① 内层 wait_agent 超时 ≠ 子代理完成（`timed_out` 不是单元终态）；
//   ② 单元让出后若没有配对的顶层 wait，父代理会原地挂起（唯一恢复手段是会话 resume）；
//   ③ 同一个 cell_id 只允许一个终态，重复收取属于重复派单。
//
// 本模块只做协议状态机，零 I/O、零网络、不发请求、不读写进程状态：
//   · 从 input[] 里识别 `exec` 的系统让出（function_call_output 内含 cell_id + status）
//     与顶层 `wait` 调用/结果；cell_id / call_id 是关联 ID，原样保留，绝不重编号；
//   · 每个 cell 最多一次终态转换；终态之后的 wait 一律 `dispatch:false`（由调用方显式拒绝，
//     而不是再发一轮上游请求把父代理挂住）；
//   · 预算/并发槽位以 reservation 表达：只有 cell 进入终态才允许释放；
//   · 让出但尚未被 wait 收取的 cell 记为 orphan（诊断，不伪造完成）。
//
// 稳定代码（wire 可见，测试与日志可依赖）：
//   code_mode_cell_unbound                wait 指向的 cell 未在本轮历史让出
//   code_mode_cell_duplicate_yield        同一 cell_id 由两个不同 exec 调用让出
//   code_mode_cell_duplicate_dispatch     cell 已终态仍再次 wait（重复派单）
//   code_mode_cell_already_terminal       二次终态转换（被拒绝，状态不变）
//   code_mode_wait_identity_conflict      同一 wait call_id 指向两个 cell
//   code_mode_cell_orphaned               让出后没有任何 wait 收取（诊断）
//   code_mode_cell_not_terminal           cell 未终态时释放预算/槽位
//   code_mode_reservation_released        同一 reservation 二次释放
//   code_mode_wait_call_id_missing        wait 调用缺 call_id（无法关联）
//   code_mode_cell_id_missing             让出/收取缺 cell_id

export const CODE_MODE_EXEC_TOOL = 'exec'
export const CODE_MODE_WAIT_TOOL = 'wait'

// 终态：只有这些状态结束一个单元。timed_out / running / yielded 都不是终态。
export const CELL_TERMINAL_STATES = Object.freeze(['completed', 'failed', 'interrupted', 'canceled'])
export const CELL_LIVE_STATES = Object.freeze(['yielded', 'running', 'pending', 'timed_out'])

export const CELL_CODES = Object.freeze({
  unbound: 'code_mode_cell_unbound',
  duplicateYield: 'code_mode_cell_duplicate_yield',
  duplicateDispatch: 'code_mode_cell_duplicate_dispatch',
  alreadyTerminal: 'code_mode_cell_already_terminal',
  identityConflict: 'code_mode_wait_identity_conflict',
  orphaned: 'code_mode_cell_orphaned',
  notTerminal: 'code_mode_cell_not_terminal',
  reservationReleased: 'code_mode_reservation_released',
  waitCallIdMissing: 'code_mode_wait_call_id_missing',
  cellIdMissing: 'code_mode_cell_id_missing',
})

const DEFAULT_MAX_CELLS = 64

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function nonEmpty(v) { return typeof v === 'string' && v.trim() !== '' }

export function isCellTerminalState(state) {
  return typeof state === 'string' && CELL_TERMINAL_STATES.includes(state)
}

// 工具输出可能是 JSON 字符串（真实 Codex）或对象；数组/标量不算单元载荷。
function payloadOf(value) {
  if (isPlainObject(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : null
  } catch { return null }
}

function statusOf(payload) {
  if (!isPlainObject(payload)) return ''
  if (nonEmpty(payload.status)) return payload.status.trim()
  if (nonEmpty(payload.state)) return payload.state.trim()
  return ''
}

/**
 * exec 的系统让出：`{cell_id, status:'running'}`。
 * 返回 { kind:'yield', callId, cellId, status, terminal } 或 null。
 */
export function readCellYield(item, toolName) {
  if (!isPlainObject(item)) return null
  if (toolName !== CODE_MODE_EXEC_TOOL) return null
  if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') return null
  const callId = nonEmpty(item.call_id) ? item.call_id : ''
  if (!callId) return null
  const payload = payloadOf(item.output)
  if (!payload) return null
  const cellId = nonEmpty(payload.cell_id) ? payload.cell_id.trim() : ''
  if (!cellId) return null
  const status = statusOf(payload) || 'yielded'
  return { kind: 'yield', callId, cellId, status, terminal: isCellTerminalState(status) }
}

/**
 * 顶层收取：`{type:'function_call', name:'wait', arguments:'{"cell_id":"2"}'}`。
 * 命名空间内的 `wait_agent` 不是本协议单元收取，不匹配（name 不同）。
 * 返回 { kind:'wait', callId, cellId, problem? } 或 null。
 */
export function readWaitCall(item) {
  if (!isPlainObject(item)) return null
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return null
  if (item.name !== CODE_MODE_WAIT_TOOL) return null
  if (nonEmpty(item.namespace)) return null
  const callId = nonEmpty(item.call_id) ? item.call_id : ''
  const payload = payloadOf(item.arguments != null ? item.arguments : item.input)
  const cellId = payload && nonEmpty(payload.cell_id) ? payload.cell_id.trim() : ''
  const event = { kind: 'wait', callId, cellId }
  if (!callId) event.problem = CELL_CODES.waitCallIdMissing
  else if (!cellId) event.problem = CELL_CODES.cellIdMissing
  return event
}

/** 单元收取结果：wait 调用的 function_call_output（含终态 status 时结束该 cell）。 */
export function readWaitOutcome(item, toolName) {
  if (!isPlainObject(item)) return null
  if (toolName !== CODE_MODE_WAIT_TOOL) return null
  if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') return null
  const payload = payloadOf(item.output)
  if (!payload) return null
  const status = statusOf(payload)
  if (!status) return null
  const cellId = nonEmpty(payload.cell_id) ? payload.cell_id.trim() : ''
  return {
    kind: 'wait_outcome',
    callId: nonEmpty(item.call_id) ? item.call_id : '',
    cellId,
    status,
    terminal: isCellTerminalState(status),
  }
}

/**
 * 顺序扫描 input[]：先建 call_id → 工具名索引（输出项本身不带 name），再逐项产出事件。
 * 绝不重排：事件 index 即历史位置，重复派单/孤儿判定都以此为准。
 */
export function scanCodeMode(input) {
  const events = []
  const problems = []
  if (!Array.isArray(input)) return { events, problems }
  const names = new Map()
  for (const item of input) {
    if (!isPlainObject(item)) continue
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && nonEmpty(item.call_id)) {
      names.set(item.call_id, nonEmpty(item.name) ? item.name : '')
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isPlainObject(item)) continue
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const wait = readWaitCall(item)
      if (!wait) continue
      if (wait.problem) { problems.push({ code: wait.problem, index, callId: wait.callId, cellId: wait.cellId }); continue }
      events.push(Object.assign({ index }, wait))
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const toolName = names.get(nonEmpty(item.call_id) ? item.call_id : '') || ''
      const yielded = readCellYield(item, toolName)
      if (yielded) { events.push(Object.assign({ index }, yielded)); continue }
      const outcome = readWaitOutcome(item, toolName)
      if (outcome) events.push(Object.assign({ index }, outcome))
    }
  }
  return { events, problems }
}

/**
 * 单元账本：唯一终态、唯一派单、预算/槽位绑定。
 * 纯内存、可重放（同一历史重放得到同一结果），不缓存跨请求工具身份。
 */
export function createCellLedger(opts = {}) {
  const maxCells = Number.isInteger(opts.maxCells) && opts.maxCells > 0 ? opts.maxCells : DEFAULT_MAX_CELLS
  const cells = new Map()
  const waitIndex = new Map() // wait call_id -> cellId
  const tokens = new Map() // token id -> { cellId, released }
  let tokenSeq = 0

  function cellOf(cellId) { return cells.get(cellId) || null }

  function ensureCell(cellId, status) {
    const cell = {
      cellId,
      execCallId: '',
      state: status || 'yielded',
      terminal: null,
      settledBy: null,
      waits: [],
      dispatches: 0,
      duplicateDispatches: 0,
      reservations: new Set(),
    }
    cells.set(cellId, cell)
    return cell
  }

  function settleCell(cell, status, by) {
    if (!isCellTerminalState(status)) return { ok: true, terminal: null, ignored: true, cell }
    if (cell.terminal) return { ok: false, code: CELL_CODES.alreadyTerminal, terminal: cell.terminal, cell }
    cell.terminal = status
    cell.state = status
    cell.settledBy = by || ''
    return { ok: true, terminal: status, cell }
  }

  return {
    get size() { return cells.size },

    /** 记录一次 exec 让出。同一 cell 的重复让出不是新 cell（不重复派单）。 */
    yieldCell(event = {}) {
      const cellId = nonEmpty(event.cellId) ? event.cellId : ''
      if (!cellId) return { ok: false, code: CELL_CODES.cellIdMissing }
      const callId = nonEmpty(event.callId) ? event.callId : ''
      const existing = cellOf(cellId)
      if (existing) {
        if (existing.execCallId && callId && existing.execCallId !== callId) {
          return { ok: false, code: CELL_CODES.duplicateYield, cellId, message: '同一 cell 被不同 exec 调用让出: ' + cellId }
        }
        if (!existing.execCallId && callId) existing.execCallId = callId
        if (event.terminal) settleCell(existing, event.status, callId || 'yield')
        return { ok: true, duplicate: true, cell: existing }
      }
      if (cells.size >= maxCells) {
        return { ok: false, code: CELL_CODES.cellIdMissing, cellId, message: '单元数超过上限 ' + maxCells }
      }
      const cell = ensureCell(cellId, event.status)
      cell.execCallId = callId
      if (event.terminal) settleCell(cell, event.status, callId || 'yield')
      return { ok: true, duplicate: false, cell }
    },

    /**
     * 顶层 wait 绑定：终态之前 dispatch=true（可以向上游派发），终态之后 dispatch=false。
     * 调用方必须把 dispatch=false 当成显式错误，绝不能静默丢弃（否则父代理原地挂起）。
     */
    waitOn(event = {}) {
      const cellId = nonEmpty(event.cellId) ? event.cellId : ''
      const callId = nonEmpty(event.callId) ? event.callId : ''
      if (!cellId) return { ok: false, code: CELL_CODES.unbound, cellId: '', message: 'wait 缺少 cell_id，无法与让出单元关联' }
      if (!callId) return { ok: false, code: CELL_CODES.waitCallIdMissing, cellId }
      const bound = waitIndex.get(callId)
      if (bound && bound !== cellId) {
        return { ok: false, code: CELL_CODES.identityConflict, cellId, callId, message: 'wait call_id ' + callId + ' 已绑定到单元 ' + bound }
      }
      const cell = cellOf(cellId)
      if (!cell) {
        return { ok: false, code: CELL_CODES.unbound, cellId, callId, message: 'wait 指向未让出的单元 ' + cellId }
      }
      waitIndex.set(callId, cellId)
      if (cell.terminal) {
        cell.duplicateDispatches += 1
        return { ok: true, dispatch: false, status: 'already_terminal', terminal: cell.terminal, cellId, callId, cell }
      }
      if (cell.waits.includes(callId)) {
        return { ok: true, dispatch: false, duplicate: true, status: 'awaiting', cellId, callId, cell }
      }
      cell.waits.push(callId)
      cell.dispatches += 1
      return { ok: true, dispatch: true, status: 'awaiting', cellId, callId, cell }
    },

    /** wait 结果：只有终态才结束单元；timed_out/running 只表示“本次等待结束”。 */
    settle(event = {}) {
      const cellId = nonEmpty(event.cellId) ? event.cellId : (waitIndex.get(nonEmpty(event.callId) ? event.callId : '') || '')
      const cell = cellId ? cellOf(cellId) : null
      if (!cell) return { ok: true, terminal: null, ignored: true }
      const by = nonEmpty(event.callId) ? event.callId : (nonEmpty(event.cellId) ? 'wait' : '')
      return settleCell(cell, event.status, by)
    },

    /** 显式终态转换（interrupt / cancel / timeout 收尾都走这里）。第二次被拒绝且状态不变。 */
    resolve(cellId, state) {
      if (!isCellTerminalState(state)) throw new TypeError('不是单元终态: ' + String(state))
      const cell = cellOf(nonEmpty(cellId) ? cellId : '')
      if (!cell) return { ok: false, code: CELL_CODES.unbound, cellId }
      const settled = settleCell(cell, state, 'resolve')
      if (!settled.ok) return settled
      return settled
    },

    /** 预算/并发槽位：只有未终态的 cell 才能占用。 */
    reserve(cellId) {
      const cell = cellOf(nonEmpty(cellId) ? cellId : '')
      if (!cell) return { ok: false, code: CELL_CODES.unbound, cellId }
      if (cell.terminal) return { ok: false, code: CELL_CODES.alreadyTerminal, terminal: cell.terminal, cellId }
      tokenSeq += 1
      const id = 'cellres_' + tokenSeq
      tokens.set(id, { cellId: cell.cellId, released: false })
      cell.reservations.add(id)
      return { ok: true, token: { id, cellId: cell.cellId } }
    },

    /** 释放：cell 未终态一律拒绝（预算/槽位必须保留到终态）。 */
    release(token) {
      const id = isPlainObject(token) ? token.id : token
      const entry = tokens.get(String(id))
      if (!entry) return { ok: false, code: CELL_CODES.notTerminal, message: '未知 reservation: ' + String(id) }
      if (entry.released) return { ok: false, code: CELL_CODES.reservationReleased }
      const cell = cellOf(entry.cellId)
      if (!cell) return { ok: false, code: CELL_CODES.unbound, cellId: entry.cellId }
      if (!cell.terminal) return { ok: false, code: CELL_CODES.notTerminal, cellId: cell.cellId, state: cell.state }
      entry.released = true
      cell.reservations.delete(String(id))
      return { ok: true, cellId: cell.cellId, terminal: cell.terminal }
    },

    snapshot() {
      const out = []
      let dispatches = 0
      let duplicateDispatches = 0
      let live = 0
      let terminal = 0
      let heldReservations = 0
      for (const cell of cells.values()) {
        dispatches += cell.dispatches
        duplicateDispatches += cell.duplicateDispatches
        heldReservations += cell.reservations.size
        if (cell.terminal) terminal += 1
        else live += 1
        out.push({
          cellId: cell.cellId,
          execCallId: cell.execCallId,
          state: cell.state,
          terminal: cell.terminal,
          settledBy: cell.settledBy,
          waits: cell.waits.slice(),
          dispatches: cell.dispatches,
          duplicateDispatches: cell.duplicateDispatches,
          heldReservations: cell.reservations.size,
        })
      }
      const orphans = out.filter((c) => c.terminal === null && c.dispatches === 0).map((c) => c.cellId)
      return {
        cells: out,
        live,
        terminal,
        dispatches,
        duplicateDispatches,
        heldReservations,
        orphans,
        waitCount: waitIndex.size,
      }
    },
  }
}

/**
 * 用同一份请求历史重放单元状态机（prepareCodexNativeRequest 的发送前判定）：
 *   · wait 指向未让出的 cell → 拒绝（否则父代理挂起）；
 *   · cell 已终态仍 wait → 拒绝（重复派单，且必须显式而不是静默丢弃）；
 *   · 让出后未收取 → 只记诊断（下一轮才 wait 是正常形态）。
 * 返回 { ok, rejected?, ledger, scan, snapshot, diagnostics }；rejected 只含关联 ID，绝不含任务正文。
 */
export function replayCodeMode(input) {
  const scan = scanCodeMode(input)
  const ledger = createCellLedger()
  const diagnostics = []
  for (const problem of scan.problems) {
    if (problem.code === CELL_CODES.cellIdMissing) {
      return {
        ok: false,
        rejected: { code: CELL_CODES.cellIdMissing, message: '顶层 wait 缺少 cell_id，无法与让出单元关联；拒绝转发以免父代理挂起' },
        ledger,
        scan,
        snapshot: ledger.snapshot(),
        diagnostics,
      }
    }
    if (problem.code === CELL_CODES.waitCallIdMissing) {
      diagnostics.push({ code: problem.code, index: problem.index })
    }
  }
  for (const event of scan.events) {
    if (event.kind === 'yield') {
      const r = ledger.yieldCell(event)
      if (!r.ok) {
        return {
          ok: false,
          rejected: { code: r.code, message: r.message || '同一单元被重复让出', cellId: event.cellId },
          ledger, scan, snapshot: ledger.snapshot(), diagnostics,
        }
      }
      continue
    }
    if (event.kind === 'wait') {
      const r = ledger.waitOn(event)
      if (!r.ok) {
        return {
          ok: false,
          rejected: { code: r.code, message: r.message || '等待单元无法关联', cellId: event.cellId, callId: event.callId },
          ledger, scan, snapshot: ledger.snapshot(), diagnostics,
        }
      }
      if (r.dispatch === false && r.status === 'already_terminal') {
        return {
          ok: false,
          rejected: {
            code: CELL_CODES.duplicateDispatch,
            message: '单元 ' + event.cellId + ' 已终态（' + r.terminal + '），拒绝再次派发 wait ' + event.callId + '；请使用已记录的终态，不得重复派单',
            cellId: event.cellId,
            callId: event.callId,
            terminal: r.terminal,
          },
          ledger, scan, snapshot: ledger.snapshot(), diagnostics,
        }
      }
      continue
    }
    if (event.kind === 'wait_outcome') {
      ledger.settle(event)
    }
  }
  const snapshot = ledger.snapshot()
  for (const cellId of snapshot.orphans) diagnostics.push({ code: CELL_CODES.orphaned, cellId })
  return { ok: true, rejected: null, ledger, scan, snapshot, diagnostics }
}
