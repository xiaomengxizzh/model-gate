// A1｜MG-R005/R006：Codex V2 Code Mode 单元让出 + 顶层 wait(cell_id) 收取。
//
// 覆盖（全部离线、零网络、零真实凭据）：
//   1) 让出/收取的 wire 形状识别：exec 输出里的 cell_id+status、顶层 wait 调用、wait 结果；
//   2) 账本不变量：每个 cell 恰好一个终态；终态后 wait 不再派发；预算/槽位保留到终态；
//   3) 让出后无人收取 → 孤儿诊断（不伪造完成）；内层 timed_out ≠ 单元终态；
//   4) prepareCodexNativeRequest：cell_id / call_id 原样保留；重复派单与未绑定 wait 在发送前拒绝。
//
// 背景与真实停滞记录：docs/evidence/2026-11-13-modelgate-native-live.md §首次父进程等待停滞。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CELL_CODES,
  CELL_TERMINAL_STATES,
  createCellLedger,
  readCellYield,
  readWaitCall,
  readWaitOutcome,
  replayCodeMode,
  scanCodeMode,
} from '../../../src/codex/native-cells.js'
import { prepareCodexNativeRequest } from '../../../src/responses.js'

const CELL = 'cell-2'
const WAIT_ARGS = '{"cell_id":"' + CELL + '"}'
const EXEC_ARGS = '{"code":"const r = await collaboration__wait_agent({timeout_ms:1000}); return r"}'

function makeRoute(patch = {}) {
  return {
    alias: 'codex-deepseek',
    provider: 'deepseek-official',
    upstreamModel: 'deepseek-v4-pro',
    api: 'responses',
    codex: {
      multiAgentVersion: 'v2',
      plaintextTools: patch.plaintextTools !== undefined ? patch.plaintextTools : true,
      history: Object.assign({ agentMessage: 'project', reasoning: 'drop', compaction: 'reject' }, patch.history),
      namespace: 'collaboration',
    },
  }
}

function execCall(callId = 'call_exec_1') {
  return { type: 'function_call', call_id: callId, name: 'exec', arguments: EXEC_ARGS }
}
function execYield(callId = 'call_exec_1', cellId = CELL, status = 'running') {
  return { type: 'function_call_output', call_id: callId, output: JSON.stringify({ cell_id: cellId, status }) }
}
function waitCall(callId, cellId = CELL) {
  return { type: 'function_call', call_id: callId, name: 'wait', arguments: JSON.stringify({ cell_id: cellId }) }
}
function waitOutcome(callId, status, cellId = CELL) {
  return { type: 'function_call_output', call_id: callId, output: JSON.stringify({ cell_id: cellId, status }) }
}
function collaborationNamespace() {
  const fn = (name) => ({ type: 'function', name, description: name, parameters: { type: 'object', properties: { target: { type: 'string' } } } })
  return {
    type: 'namespace',
    name: 'collaboration',
    description: 'native collaboration tools',
    tools: ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'].map(fn),
  }
}
function execTool() {
  return { type: 'function', name: 'exec', description: 'code mode', parameters: { type: 'object', properties: { code: { type: 'string' } } } }
}
function waitTool() {
  return { type: 'function', name: 'wait', description: 'collect a yielded cell', parameters: { type: 'object', properties: { cell_id: { type: 'string' } }, required: ['cell_id'] } }
}

test('wait：终态集合固定，timed_out/running 不是单元终态', () => {
  assert.deepEqual([...CELL_TERMINAL_STATES], ['completed', 'failed', 'interrupted', 'canceled'])
  for (const state of ['timed_out', 'running', 'yielded', 'pending']) assert.equal(CELL_TERMINAL_STATES.includes(state), false)
})

test('wait：识别 exec 系统让出、顶层 wait 调用与 wait 结果；namespace wait_agent 不算单元收取', () => {
  const yielded = readCellYield(execYield(), 'exec')
  assert.deepEqual(yielded, { kind: 'yield', callId: 'call_exec_1', cellId: CELL, status: 'running', terminal: false })
  assert.equal(readCellYield(execYield('c', CELL, 'completed'), 'exec').terminal, true)
  // 非 exec 工具的输出里有 cell_id 也不当作单元让出（业务字段不误判）
  assert.equal(readCellYield(execYield(), 'write_file'), null)
  // 非 JSON / 缺 cell_id
  assert.equal(readCellYield({ type: 'function_call_output', call_id: 'c1', output: 'not json' }, 'exec'), null)
  assert.equal(readCellYield({ type: 'function_call_output', call_id: 'c1', output: '{"status":"running"}' }, 'exec'), null)

  assert.deepEqual(readWaitCall(waitCall('call_wait_1')), { kind: 'wait', callId: 'call_wait_1', cellId: CELL })
  // collaboration.wait_agent 是子代理等待工具，不是 Codex 顶层单元收取
  assert.equal(readWaitCall({ type: 'function_call', call_id: 'c2', name: 'wait_agent', namespace: 'collaboration', arguments: '{"timeout_ms":1}' }), null)
  // 顶层 wait 缺 cell_id：显式问题码，不漏过
  assert.equal(readWaitCall({ type: 'function_call', call_id: 'c3', name: 'wait', arguments: '{}' }).problem, CELL_CODES.cellIdMissing)
  assert.equal(readWaitCall({ type: 'function_call', name: 'wait', arguments: WAIT_ARGS }).problem, CELL_CODES.waitCallIdMissing)

  assert.deepEqual(readWaitOutcome(waitOutcome('call_wait_1', 'completed'), 'wait'), {
    kind: 'wait_outcome', callId: 'call_wait_1', cellId: CELL, status: 'completed', terminal: true,
  })
  assert.equal(readWaitOutcome(waitOutcome('call_wait_1', 'timed_out'), 'wait').terminal, false)
})

test('wait：scanCodeMode 保持历史顺序，先建 call_id → 工具名索引', () => {
  const input = [execCall(), execYield(), waitCall('call_wait_1'), waitOutcome('call_wait_1', 'completed')]
  const scan = scanCodeMode(input)
  assert.deepEqual(scan.problems, [])
  assert.deepEqual(scan.events.map((e) => [e.index, e.kind]), [[1, 'yield'], [2, 'wait'], [3, 'wait_outcome']])
})

test('wait：账本对同一 cell 只允许一个终态；终态后的 wait 不派发', () => {
  const ledger = createCellLedger()
  assert.equal(ledger.yieldCell({ cellId: CELL, callId: 'call_exec_1', status: 'running' }).ok, true)
  const first = ledger.waitOn({ cellId: CELL, callId: 'call_wait_1' })
  assert.equal(first.dispatch, true)
  assert.equal(ledger.settle({ callId: 'call_wait_1', cellId: CELL, status: 'completed' }).terminal, 'completed')
  const second = ledger.waitOn({ cellId: CELL, callId: 'call_wait_2' })
  assert.equal(second.ok, true)
  assert.equal(second.dispatch, false, '终态后不得再派发')
  assert.equal(second.status, 'already_terminal')
  assert.equal(second.terminal, 'completed')
  const snap = ledger.snapshot()
  assert.equal(snap.dispatches, 1)
  assert.equal(snap.duplicateDispatches, 1)
  assert.equal(snap.terminal, 1)
  assert.equal(snap.live, 0)
})

test('wait：二次终态转换被拒绝且状态不变', () => {
  const ledger = createCellLedger()
  ledger.yieldCell({ cellId: CELL, callId: 'call_exec_1' })
  assert.equal(ledger.resolve(CELL, 'interrupted').terminal, 'interrupted')
  const again = ledger.resolve(CELL, 'completed')
  assert.equal(again.ok, false)
  assert.equal(again.code, CELL_CODES.alreadyTerminal)
  assert.equal(again.terminal, 'interrupted')
  assert.equal(ledger.snapshot().cells[0].terminal, 'interrupted')
})

test('wait：未让出的 cell 不能 wait；同一 cell 被不同 exec 让出被拒绝', () => {
  const ledger = createCellLedger()
  const unbound = ledger.waitOn({ cellId: CELL, callId: 'call_wait_1' })
  assert.equal(unbound.ok, false)
  assert.equal(unbound.code, CELL_CODES.unbound)
  ledger.yieldCell({ cellId: CELL, callId: 'call_exec_1' })
  const dup = ledger.yieldCell({ cellId: CELL, callId: 'call_exec_2' })
  assert.equal(dup.ok, false)
  assert.equal(dup.code, CELL_CODES.duplicateYield)
  // 同一 exec 的重复让出（重放）是幂等，不是新 cell
  const replay = ledger.yieldCell({ cellId: CELL, callId: 'call_exec_1' })
  assert.equal(replay.ok, true)
  assert.equal(replay.duplicate, true)
  assert.equal(ledger.size, 1)
})

test('wait：同一个 wait call_id 不能指向两个 cell', () => {
  const ledger = createCellLedger()
  ledger.yieldCell({ cellId: CELL, callId: 'call_exec_1' })
  ledger.yieldCell({ cellId: 'cell-3', callId: 'call_exec_2' })
  assert.equal(ledger.waitOn({ cellId: CELL, callId: 'call_wait_1' }).ok, true)
  const conflict = ledger.waitOn({ cellId: 'cell-3', callId: 'call_wait_1' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, CELL_CODES.identityConflict)
})

test('wait：预算/并发槽位只在单元终态后释放，且不能重复释放', () => {
  const ledger = createCellLedger()
  ledger.yieldCell({ cellId: CELL, callId: 'call_exec_1' })
  const reserved = ledger.reserve(CELL)
  assert.equal(reserved.ok, true)
  assert.equal(ledger.snapshot().heldReservations, 1)
  const early = ledger.release(reserved.token)
  assert.equal(early.ok, false)
  assert.equal(early.code, CELL_CODES.notTerminal)
  assert.equal(ledger.snapshot().heldReservations, 1, '未终态不得释放')

  ledger.waitOn({ cellId: CELL, callId: 'call_wait_1' })
  ledger.settle({ cellId: CELL, callId: 'call_wait_1', status: 'timed_out' })
  assert.equal(ledger.release(reserved.token).ok, false, '内层超时不释放槽位')
  assert.equal(ledger.snapshot().heldReservations, 1)

  ledger.settle({ cellId: CELL, callId: 'call_wait_2', status: 'completed' })
  const released = ledger.release(reserved.token)
  assert.equal(released.ok, true)
  assert.equal(released.terminal, 'completed')
  assert.equal(ledger.snapshot().heldReservations, 0)
  assert.equal(ledger.release(reserved.token).code, CELL_CODES.reservationReleased)
  assert.equal(ledger.reserve(CELL).code, CELL_CODES.alreadyTerminal, '终态单元不能再占用槽位')
})

test('wait：replay 正常路径恰好一次派发、一个终态、无孤儿', () => {
  const r = replayCodeMode([execCall(), execYield(), waitCall('call_wait_1'), waitOutcome('call_wait_1', 'completed')])
  assert.equal(r.ok, true)
  assert.equal(r.rejected, null)
  assert.equal(r.snapshot.dispatches, 1)
  assert.equal(r.snapshot.duplicateDispatches, 0)
  assert.equal(r.snapshot.terminal, 1)
  assert.deepEqual(r.snapshot.orphans, [])
  assert.deepEqual(r.diagnostics, [])
  assert.equal(r.snapshot.cells[0].terminal, 'completed')
  assert.equal(r.snapshot.cells[0].settledBy, 'call_wait_1')
})

test('wait：replay 终态后再次 wait → 显式重复派单拒绝，且不含任务正文', () => {
  const r = replayCodeMode([
    execCall(), execYield(), waitCall('call_wait_1'), waitOutcome('call_wait_1', 'completed'), waitCall('call_wait_2'),
  ])
  assert.equal(r.ok, false)
  assert.equal(r.rejected.code, CELL_CODES.duplicateDispatch)
  assert.equal(r.rejected.cellId, CELL)
  assert.equal(r.rejected.callId, 'call_wait_2')
  assert.equal(r.rejected.terminal, 'completed')
  assert.match(r.rejected.message, /重复派单/)
  assert.equal(r.snapshot.dispatches, 1, '重复 wait 不增加派发')
})

test('wait：内层超时只结束本次等待，下一轮 wait 仍可派发', () => {
  const r = replayCodeMode([
    execCall(), execYield(), waitCall('call_wait_1'), waitOutcome('call_wait_1', 'timed_out'), waitCall('call_wait_2'),
  ])
  assert.equal(r.ok, true)
  assert.equal(r.snapshot.dispatches, 2)
  assert.equal(r.snapshot.terminal, 0)
  assert.equal(r.snapshot.live, 1)
})

test('wait：让出后无人收取 → 孤儿诊断，不伪造完成', () => {
  const r = replayCodeMode([execCall(), execYield()])
  assert.equal(r.ok, true)
  assert.deepEqual(r.snapshot.orphans, [CELL])
  assert.equal(r.snapshot.terminal, 0)
  assert.deepEqual(r.diagnostics, [{ code: CELL_CODES.orphaned, cellId: CELL }])
})

test('wait：prepareCodexNativeRequest 保留 cell_id / call_id，并暴露 nativeCells 快照', () => {
  const body = {
    model: 'codex-deepseek',
    input: [execCall(), execYield(), waitCall('call_wait_1')],
    tools: [execTool(), waitTool(), collaborationNamespace()],
    stream: true,
  }
  const snapshot = structuredClone(body)
  const out = prepareCodexNativeRequest(body, makeRoute())
  assert.equal(out.rejected, null, JSON.stringify(out.rejected))
  assert.ok(out.body)
  const projected = out.body.input
  assert.equal(projected[0].call_id, 'call_exec_1')
  assert.equal(projected[0].arguments, EXEC_ARGS, 'exec 代码原样转发，网关不改写')
  assert.equal(projected[2].name, 'wait')
  assert.equal(projected[2].call_id, 'call_wait_1', 'wait 关联 ID 保真')
  assert.equal(projected[2].arguments, WAIT_ARGS, 'cell_id 保真')
  assert.equal(out.nativeCells.cells[0].cellId, CELL)
  assert.equal(out.nativeCells.dispatches, 1)
  assert.equal(out.nativeCells.live, 1)
  assert.deepEqual(body, snapshot, '不得修改入参')
})

test('wait：prepareCodexNativeRequest 对终态后的重复 wait 返回 400 码且不产出 body', () => {
  const out = prepareCodexNativeRequest({
    model: 'codex-deepseek',
    input: [execCall(), execYield(), waitCall('call_wait_1'), waitOutcome('call_wait_1', 'completed'), waitCall('call_wait_2')],
    tools: [execTool(), waitTool(), collaborationNamespace()],
  }, makeRoute())
  assert.equal(out.body, null, '重复派单必须在发送前拦下（零上游）')
  assert.equal(out.rejected.code, CELL_CODES.duplicateDispatch)
  assert.equal(out.plan, null)
})

test('wait：prepareCodexNativeRequest 对未绑定的 wait 返回 400 码（否则父代理挂起）', () => {
  const out = prepareCodexNativeRequest({
    model: 'codex-deepseek',
    input: [execCall(), waitCall('call_wait_1', 'cell-never-yielded')],
    tools: [execTool(), waitTool(), collaborationNamespace()],
  }, makeRoute())
  assert.equal(out.body, null)
  assert.equal(out.rejected.code, CELL_CODES.unbound)
  assert.match(out.rejected.message, /cell-never-yielded/)
})
