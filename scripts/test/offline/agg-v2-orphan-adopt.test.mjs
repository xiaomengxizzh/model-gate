// MG-FIX-P0-01 无损修复回归：孤儿 function_call_output 补稳定关联键（orphan-adopt）。
//
// 真实取证（2026-11-16，已获所有者授权的真实 Go DeepSeek 调用，隔离网关/临时配置）：
//   · 修复前：生产形状 message×4|function_call_output|... → 400 third_party_tool_call_id_missing（零计费）；
//   · 修复后：同一形状 → HTTP 200 / status=completed，模型看到工具结果内容（real billing），
//             两次相同请求（模拟 Codex 重连）均 200 且 call_id 稳定。
// 本离线套件钉住“无损 + 确定性 + 不伪造”的不变量，CI 可跑，不依赖付费上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import { repairThirdPartyToolCallIds, firstEmptyToolCallId } from '../../../src/index.js'

test('P0-01：孤儿 output 补 call_mg_orphan_<hash>，不伪造 call、不丢历史、不改内容', () => {
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say OK' }] },
    { type: 'function_call_output', output: 'PROBE_ORPHAN_RESULT' },
  ] })
  assert.equal(r.body.input.length, 2, '不得增删历史')
  assert.equal(r.body.input[0].content[0].text, 'say OK', '消息内容零改写')
  assert.equal(r.body.input[1].output, 'PROBE_ORPHAN_RESULT', '工具结果内容零改写')
  assert.equal(r.body.input.some((i) => i && i.type === 'function_call'), false, '绝不伪造 function_call')
  assert.match(r.body.input[1].call_id, /^call_mg_orphan_[a-f0-9]{16}$/)
  assert.deepEqual(r.repaired.map((x) => x.action), ['orphan-adopt'], '诊断必须透明')
  assert.equal(firstEmptyToolCallId(r.body), null, 'guard 不再拦截 → 不再反复重连')
})

test('P0-01：确定性——同一形状多次调用得到相同 call_id（重连稳定，不漂移）', () => {
  const mk = () => ({ input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say OK' }] },
    { type: 'function_call_output', output: 'PROBE_ORPHAN_RESULT' },
  ] })
  const a = repairThirdPartyToolCallIds(mk())
  const b = repairThirdPartyToolCallIds(mk())
  const c = repairThirdPartyToolCallIds(mk())
  assert.equal(a.body.input[1].call_id, b.body.input[1].call_id)
  assert.equal(b.body.input[1].call_id, c.body.input[1].call_id)
})

test('P0-01：多个不同孤儿 output 得到不同 call_id（不碰撞）', () => {
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'function_call_output', output: 'RESULT_A' },
    { type: 'message', role: 'assistant', content: 'x' },
    { type: 'function_call_output', output: 'RESULT_B' },
  ] })
  const idA = r.body.input[0].call_id
  const idB = r.body.input[2].call_id
  assert.match(idA, /^call_mg_orphan_/)
  assert.match(idB, /^call_mg_orphan_/)
  assert.notEqual(idA, idB, '两个孤儿结果关联键必须不同')
  assert.equal(r.repaired.filter((x) => x.action === 'orphan-adopt').length, 2)
  assert.equal(firstEmptyToolCallId(r.body), null)
})

test('P0-01：有可配对 call 的 output 仍走 pair，不被误判为孤儿', () => {
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'function_call', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', output: 'real result' },
  ] })
  assert.deepEqual(r.repaired.map((x) => x.action), ['assign', 'pair'])
  assert.equal(r.body.input[0].call_id, r.body.input[1].call_id)
  assert.deepEqual(firstEmptyToolCallId(r.body), null)
})

test('P0-01：孤儿合成 id 避开输入中已存在的同名 id', () => {
  // 先放一个带目标 id 的 output（自带 id，不参与配对），再放孤儿；孤儿不能复用该 id。
  const collide = 'call_mg_orphan_9dc418e36d0580b3'
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'function_call_output', call_id: collide, output: 'SELF_ID' },
    { type: 'function_call_output', output: 'PROBE_ORPHAN_RESULT' },
  ] })
  const ids = r.body.input.filter((i) => typeof i.call_id === 'string').map((i) => i.call_id)
  assert.equal(new Set(ids).size, ids.length, '所有 id 必须唯一：' + JSON.stringify(ids))
  assert.equal(r.body.input[0].call_id, collide, '原有 id 保留')
  assert.notEqual(r.body.input[1].call_id, collide, '孤儿合成 id 必须避开已存在 id')
})
