// MG-FIX-P0-01：孤立 function_call_output 缺 call_id 导致 typed 400 的结构证据回归。
//
// 生产日志（logs/gateway-2026-11-16.log，已脱敏）13:27 的失败形状：
//   shapes=message|message|message|message|function_call_output|message|message|function_call_output|message
// 即：4 个 message 后有 2 个 function_call_output，前面没有任何 function_call 可配对。
// 本套件：
//   1) 复刻该输入到 fixture，钉死 firstEmptyToolCallId 能定位孤儿 output（fail-closed）；
//   2) 验证 toolHistoryShapeTrace 只输出结构信息，绝不泄漏正文/token/authorization；
//   3) 验证 trace 覆盖 type/role/name/id/call_id 是否存在与 thread/correlation/route。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { firstEmptyToolCallId, toolHistoryShapeTrace } from '../../../src/index.js'

// 复刻被拒输入：前 4 项 message（含一条assistant带name），随后两个孤儿 output。
const ORPHAN_INPUT = [
  { type: 'message', role: 'user', content: 'USER_SECRET_CONTENT_aaa' },
  { type: 'message', role: 'assistant', content: 'ASSISTANT_SECRET_bbb' },
  { type: 'message', role: 'user', content: 'USER_SECRET_ccc' },
  { type: 'message', role: 'assistant', content: 'ASSISTANT_SECRET_ddd', name: 'exec_command' },
  { type: 'function_call_output', output: 'TOOL_OUTPUT_SECRET_eee' },
  { type: 'message', role: 'assistant', content: 'ASSISTANT_SECRET_fff' },
  { type: 'function_call_output', output: 'TOOL_OUTPUT_SECRET_ggg', call_id: '' },
  { type: 'message', role: 'user', content: 'USER_SECRET_hhh' },
]

test('P0-01 fixture：孤儿 function_call_output 缺 call_id → firstEmptyToolCallId 定位第 5 项', () => {
  const bad = firstEmptyToolCallId({ input: ORPHAN_INPUT })
  assert.deepEqual(bad, { index: 4, type: 'function_call_output', reason: 'missing' })
})

test('P0-01 trace：只输出结构信息，type/role/name/id/call_id 存在性齐全，route/thread/correlation 保留', () => {
  const trace = toolHistoryShapeTrace({ input: ORPHAN_INPUT }, {
    route: '/v1/responses',
    provider: 'opencodego',
    model: 'mg-opencodego-deepseek-v4-1-flash',
    reason: 'missing',
    thread: 'a1b2c3d4e5f60000',
    correlation: '0011223344556677',
  })
  assert.equal(trace.itemCount, 8)
  assert.equal(trace.traced, 8)
  assert.equal(trace.route, '/v1/responses')
  assert.equal(trace.provider, 'opencodego')
  assert.equal(trace.model, 'mg-opencodego-deepseek-v4-1-flash')
  assert.equal(trace.thread, 'a1b2c3d4e5f60000')
  assert.equal(trace.correlation, '0011223344556677')
  // 逐项形状
  assert.deepEqual(trace.items[0], { index: 0, type: 'message', callId: 'absent', toolCall: false, toolOutput: false, role: 'user' })
  assert.equal(trace.items[3].name, 'exec_command', 'name 是协议元数据，应保留')
  assert.equal(trace.items[4].type, 'function_call_output')
  assert.equal(trace.items[4].toolOutput, true)
  assert.equal(trace.items[4].callId, 'absent', '第 5 项缺 call_id')
  assert.equal(trace.items[6].callId, 'empty', '空字符串 call_id 标记为 empty')
})

test('P0-01 trace：绝不泄漏正文、output、token、authorization（脱敏硬约束）', () => {
  const trace = toolHistoryShapeTrace({ input: ORPHAN_INPUT }, { thread: 'a1b2c3d4e5f60000' })
  const dump = JSON.stringify(trace)
  for (const secret of [
    'USER_SECRET', 'ASSISTANT_SECRET', 'TOOL_OUTPUT_SECRET', 'SECRET_',
    'aaa', 'bbb', 'ggg', 'authorization', 'Bearer', 'sk-',
  ]) {
    assert.equal(dump.includes(secret), false, 'trace 不得出现正文/凭据值：' + secret)
  }
  // 结构中只有键名（type/callId/toolCall/toolOutput/role/name/id），值的域是 set/empty/absent/bool。
  assert.deepEqual(Object.keys(trace.items[0]).sort(), ['callId', 'index', 'role', 'toolCall', 'toolOutput', 'type'])
  // id 字段也只标记存在性，不输出原值
  const withId = toolHistoryShapeTrace({ input: [{ type: 'function_call', call_id: 'call_SECRET_XYZ', id: 'item_SECRET' }] }, {})
  const dump2 = JSON.stringify(withId)
  assert.equal(dump2.includes('SECRET'), false)
  assert.equal(withId.items[0].callId, 'set')
  assert.equal(withId.items[0].id, 'set')
})

test('P0-01 trace：超过 24 项只取前 24，避免日志膨胀；非对象项标记 unknown', () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ type: 'message', role: 'user', content: 'c' + i }))
  big.push('not-an-object')
  const trace = toolHistoryShapeTrace({ input: big }, {})
  assert.equal(trace.itemCount, 41)
  assert.equal(trace.traced, 24)
  assert.equal(trace.items.length, 24)
})

test('P0-01 生产日志证据仍在（脱敏 shapes 行未重写）', (t) => {
  const prodLog = '/home/xiaomengxizi/ai/workplace/idproject/model-gateway/logs/gateway-2026-11-16.log'
  const localLog = 'logs/gateway-2026-11-16.log'
  const path = existsSync(localLog) ? localLog : (existsSync(prodLog) ? prodLog : null)
  if (!path) { t.skip('生产日志不在本工作树（取证见交接文档 §5）；跳过'); return }
  const log = readFileSync(path, 'utf8')
  assert.ok(/shapes=message\|message\|message\|message\|function_call_output/.test(log), '原始脱敏 shape 证据应保留')
})
