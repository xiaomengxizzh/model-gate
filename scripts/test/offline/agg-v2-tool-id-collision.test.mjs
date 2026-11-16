// MG-FIX-P2-07：合成工具 ID 的碰撞与错误配对风险的对抗性回归（静态推导→测试钉死）。
//
// 修复前风险：
//   (1) 输入里本就有 call_mg_1 时，nextSyntheticId 从 call_mg_1 生成，产生重复 ID；
//   (2) output 自带真实 id 时盲取栈顶 call，即使栈顶是另一个真实 call 也回填，
//       造成“两个 call 同一 id / output 绑定到错误 call”。
// 修复后约束：已有 id 唯一不重复；合成 id 避开所有已存在 id；output 与 call 一一精确配对；
//            多工具交错、混合有无 id、孤儿 output 均保持 fail-closed；不伪造调用、不丢历史、不改内容。
import test from 'node:test'
import assert from 'node:assert/strict'
import { repairThirdPartyToolCallIds, firstEmptyToolCallId } from '../../../src/index.js'

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'computer_call'])
function callIdsOf (items) {
  return items.filter((i) => i && CALL_TYPES.has(String(i.type || '')) && typeof i.call_id === 'string').map((i) => i.call_id)
}
function assertUniqueCalls (items) {
  const ids = callIdsOf(items)
  assert.equal(new Set(ids).size, ids.length, '工具调用之间 call_id 不得重复：' + JSON.stringify(ids))
}

test('P2-07：输入已有 call_mg_1 → 合成 id 必须跳过，绝不产生重复', () => {
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'function_call', call_id: 'call_mg_1', name: 'a' }, // 历史里本就存在的同名 id（真实）
    { type: 'function_call', name: 'b' },                       // 缺 id → 不能生成 call_mg_1
    { type: 'function_call_output', output: 'r1' },             // 配到 call_mg_1
    { type: 'function_call_output', output: 'r2' },             // 配到新合成 id
  ] })
  assert.equal(r.body.input.length, 4, '不得增删历史')
  assertUniqueCalls(r.body.input)
  assert.equal(r.body.input[0].call_id, 'call_mg_1', '已有真实 id 不得被改写')
  assert.match(r.body.input[1].call_id, /^call_mg_/, '第二个 call 拿到合成 id')
  assert.notEqual(r.body.input[1].call_id, 'call_mg_1', '合成 id 必须避开已存在的 call_mg_1')
  assert.equal(firstEmptyToolCallId(r.body), null)
})

test('P2-07：已有 call_mg_1 和 call_mg_2 → 新合成 id 从 call_mg_3 起', () => {
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'function_call', call_id: 'call_mg_1' },
    { type: 'function_call', call_id: 'call_mg_2' },
    { type: 'function_call', name: 'third' },
  ] })
  assert.equal(r.body.input[2].call_id, 'call_mg_3')
  assertUniqueCalls(r.body.input)
})

test('P2-07：output 自带真实 id → 精确匹配对应 call，绝不盲取栈顶错绑', () => {
  // 两个都带真实 id 的 call 交错，各自 output 按 id 精确配对；
  // 修复前会把两个 output 都盲配到栈顶 call，造成错绑/重复回填。
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'function_call', call_id: 'call_A', name: 'a' },
    { type: 'function_call', call_id: 'call_B', name: 'b' },
    { type: 'function_call_output', call_id: 'call_A', output: 'ra' },
    { type: 'function_call_output', call_id: 'call_B', output: 'rb' },
  ] })
  assert.deepEqual(r.repaired, [], 'id 已完整且一一对应时应零改动')
  assert.equal(r.body.input[0].call_id, 'call_A')
  assert.equal(r.body.input[1].call_id, 'call_B')
  assertUniqueCalls(r.body.input)
})

test('P2-07：真实 id 不会被合成回填覆盖（栈顶是真实 call 时不得改写它）', () => {
  // 栈顶 call 带真实 id call_B；output 带另一个真实 id call_A，输入里没有对应 call。
  // 这是无法确认关联的孤儿 output：不得改写栈顶真实 call 的 id，也不得伪造 call。
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'function_call', call_id: 'call_B', name: 'b' },
    { type: 'function_call_output', call_id: 'call_A', output: 'orphan' },
  ] })
  assert.equal(r.body.input[0].call_id, 'call_B', '真实 call id 不得被 output 的无关 id 覆盖')
  assert.equal(r.body.input[1].call_id, 'call_A', 'output 自带 id 保留')
  assertUniqueCalls(r.body.input)
})

test('P2-07：混合有/无 id 的多工具交错，id 唯一且内容零改写', () => {
  const r = repairThirdPartyToolCallIds({ input: [
    { role: 'user', content: 'do both' },
    { type: 'function_call', name: 'a', arguments: '{}' },              // 缺 id → 合成
    { type: 'function_call', call_id: 'call_real_B', name: 'b' },       // 真实 id
    { type: 'function_call_output', output: 'ra' },                     // 无 id → 配栈顶 call_real_B
    { type: 'function_call_output', call_id: 'call_mg_1', output: 'rb' },// 显式 id call_mg_1（无对应 call）→ 保留，不伪造
  ] })
  assert.equal(r.body.input.length, 5)
  assert.equal(r.body.input[0].content, 'do both', '消息内容不得改写')
  // 核心不变量：所有 call_id 唯一；既有真实 id 不被改写；不生成重复的合成 id。
  assertUniqueCalls(r.body.input)
  assert.equal(r.body.input[2].call_id, 'call_real_B', '真实 call id 不得被覆盖')
  assert.equal(r.body.input[3].call_id, 'call_real_B', '无 id output 按位置配到栈顶真实 call')
  assert.equal(r.body.input[4].call_id, 'call_mg_1', '显式 id 保留')
  assert.equal(firstEmptyToolCallId(r.body), null)
})

test('P2-07/P0-01：孤儿 output 补稳定关联键；不伪造 function_call、不丢历史、不改内容', () => {
  const item = { type: 'function_call_output', output: 'orphan' }
  const r = repairThirdPartyToolCallIds({ input: [
    { type: 'message', role: 'assistant', content: 'x' },
    item,
  ] })
  assert.equal(r.body.input.length, 2, '不得丢历史')
  assert.equal(r.body.input.some((i) => i && i.type === 'function_call'), false, '不得伪造 function_call')
  assert.equal(r.body.input[1].output, 'orphan', '不得改内容')
  assert.match(r.body.input[1].call_id, /^call_mg_orphan_[a-f0-9]{16}$/, '补稳定关联键')
  assert.ok(r.repaired.some((x) => x.action === 'orphan-adopt'))
  assert.equal(firstEmptyToolCallId(r.body), null, '补齐后 guard 不再拦截')
})
