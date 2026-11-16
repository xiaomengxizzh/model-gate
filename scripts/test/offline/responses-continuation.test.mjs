// Responses 续轮状态（responses-continuation）离线单元回归。
// 锁定 2026-11-16 审计 P0 修复的核心不变量：
//   · 重建 = parent.input + parent.output + delta，绝不丢消息/推理项；
//   · 只回放真实捕获的 item，不伪造；delta 与历史按 item.id 去重（容忍客户端重发完整历史）；
//   · 缺失/过期/超容量 → fail-closed，绝不静默丢上下文；
//   · 捕获 sink 从 SSE/JSON 收集真实 response.id 与 output（completed.output 权威）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resetContinuationStore, configureContinuationLimits, continuationStoreSize,
  recordContinuation, recordWarmupContinuation, reconstructContinuation, createCaptureSink,
} from '../../../src/responses-continuation.js'

const msg = (id, role, text) => ({ type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
const call = (id, callId, name) => ({ type: 'function_call', id, call_id: callId, name, arguments: '{}' })
const output = (callId, text) => ({ type: 'function_call_output', call_id: callId, output: text })

test('重建保留完整历史：parent.input + parent.output + delta，工具调用排在结果前', () => {
  resetContinuationStore()
  const turn1Input = [msg('m1', 'user', '第一轮用户消息')]
  const turn1Output = [call('fc1', 'call_wait_1', 'wait_agent'), msg('m2', 'assistant', '第一轮助手消息')]
  recordContinuation({ responseId: 'resp_1', prevId: null, input: turn1Input, output: turn1Output, model: 'mock' })
  const rec = reconstructContinuation('resp_1', [output('call_wait_1', 'CHILD_DONE'), msg('m3', 'user', '第二轮用户消息')])
  assert.equal(rec.ok, true)
  assert.deepEqual(rec.input.map((i) => i.id || i.call_id), ['m1', 'fc1', 'm2', 'call_wait_1', 'm3'])
  assert.equal(rec.input[3].output, 'CHILD_DONE', '工具结果内容逐字保留')
  const callAt = rec.input.findIndex((i) => i.call_id === 'call_wait_1' && i.type === 'function_call')
  const outAt = rec.input.findIndex((i) => i.call_id === 'call_wait_1' && i.type === 'function_call_output')
  assert.ok(callAt >= 0 && callAt < outAt, '真实 call 必须排在孤儿 output 前')
  assert.equal(rec.restoredItems, 3)
  assert.equal(rec.deltaItems, 2)
})

test('多轮链式重建：第三轮拿到前两轮全部历史', () => {
  resetContinuationStore()
  recordContinuation({ responseId: 'r1', input: [msg('a', 'user', 't1')], output: [msg('b', 'assistant', 'o1')] })
  const rec2 = reconstructContinuation('r1', [msg('c', 'user', 't2')])
  recordContinuation({ responseId: 'r2', prevId: 'r1', input: rec2.input, output: [msg('d', 'assistant', 'o2')] })
  const rec3 = reconstructContinuation('r2', [msg('e', 'user', 't3')])
  assert.deepEqual(rec3.input.map((i) => i.id), ['a', 'b', 'c', 'd', 'e'])
})

test('delta 重发完整历史时按 item.id 去重，不产生重复项', () => {
  resetContinuationStore()
  recordContinuation({ responseId: 'r1', input: [msg('a', 'user', 't1')], output: [msg('b', 'assistant', 'o1')] })
  const rec = reconstructContinuation('r1', [msg('a', 'user', 't1'), msg('b', 'assistant', 'o1'), msg('c', 'user', 't2')])
  assert.deepEqual(rec.input.map((i) => i.id), ['a', 'b', 'c'])
})

test('缓存缺失 fail-closed：未知 id / 空 id 都拒绝，绝不返回半截历史', () => {
  resetContinuationStore()
  assert.deepEqual(reconstructContinuation('resp_unknown', []), { ok: false, reason: 'continuation_state_missing' })
  assert.equal(reconstructContinuation('', []).ok, false)
  assert.equal(reconstructContinuation(null, []).ok, false)
})

test('TTL 过期与 LRU 淘汰后 fail-closed', async () => {
  resetContinuationStore()
  configureContinuationLimits({ ttlMs: 5, maxEntries: 2, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 })
  recordContinuation({ responseId: 'old', input: [msg('a', 'user', 'x')], output: [] })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(reconstructContinuation('old', []).ok, false, '过期条目不得用于重建')
  recordContinuation({ responseId: 'e1', input: [], output: [] })
  recordContinuation({ responseId: 'e2', input: [], output: [] })
  recordContinuation({ responseId: 'e3', input: [], output: [] })
  assert.equal(continuationStoreSize().count <= 2, true, '超出条数上限按最近使用淘汰')
  configureContinuationLimits({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: 256 })
  resetContinuationStore()
})

test('单条超容量不入库（fail-closed 而非截断历史）', () => {
  resetContinuationStore()
  configureContinuationLimits({ maxEntryBytes: 64 })
  const big = msg('a', 'user', 'x'.repeat(200))
  const res = recordContinuation({ responseId: 'big', input: [big], output: [] })
  assert.equal(res.recorded, false)
  assert.equal(res.reason, 'entry_too_large')
  assert.equal(reconstructContinuation('big', []).ok, false)
  configureContinuationLimits({ maxEntryBytes: 16 * 1024 * 1024 })
})

test('预热响应登记为空历史：以其 id 续轮时 delta 原样成为完整 input', () => {
  resetContinuationStore()
  recordWarmupContinuation({ responseId: 'resp_mgws_warm', model: 'mock' })
  const rec = reconstructContinuation('resp_mgws_warm', [msg('u', 'user', 'real turn')])
  assert.equal(rec.ok, true)
  assert.deepEqual(rec.input.map((i) => i.id), ['u'])
})

test('字符串 delta 包装为 user message，不丢内容', () => {
  resetContinuationStore()
  recordContinuation({ responseId: 'r1', input: [], output: [] })
  const rec = reconstructContinuation('r1', '纯字符串输入')
  assert.equal(rec.input.length, 1)
  assert.equal(rec.input[0].role, 'user')
  assert.equal(rec.input[0].content[0].text, '纯字符串输入')
})

test('捕获 sink：SSE 逐事件收集 id 与 output，completed.output 为权威', () => {
  const sink = createCaptureSink()
  const events = [
    { type: 'response.created', response: { id: 'resp_cap', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', item: call('fc1', 'call_1', 'wait_agent') },
    { type: 'response.output_item.done', item: msg('m1', 'assistant', 'partial') },
    { type: 'response.completed', response: { id: 'resp_cap', status: 'completed', output: [call('fc1', 'call_1', 'wait_agent'), msg('m1', 'assistant', 'final')] } },
  ]
  for (const e of events) sink.write(Buffer.from('data: ' + JSON.stringify(e) + '\n\n'))
  const cap = sink.finish()
  assert.equal(cap.responseId, 'resp_cap')
  assert.equal(cap.status, 'completed')
  assert.equal(cap.output.length, 2)
  assert.equal(cap.output[1].content[0].text, 'final', 'completed.output 覆盖增量累积')
})

test('捕获 sink：无 completed 时按 output_item.done 累积；JSON 整体捕获', () => {
  const sink = createCaptureSink()
  sink.write(Buffer.from('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_i', status: 'in_progress' } }) + '\n\n'))
  sink.write(Buffer.from('data: ' + JSON.stringify({ type: 'response.output_item.done', item: msg('m1', 'assistant', 'hi') }) + '\n\n'))
  const cap = sink.finish()
  assert.equal(cap.responseId, 'resp_i')
  assert.equal(cap.output.length, 1)

  const sink2 = createCaptureSink()
  sink2.captureJson({ id: 'resp_j', status: 'completed', output: [msg('mj', 'assistant', 'json')] })
  const cap2 = sink2.finish()
  assert.equal(cap2.responseId, 'resp_j')
  assert.equal(cap2.output[0].id, 'mj')
})

test('捕获 sink：SSE 注释/keepalive 与跨 chunk 分块不干扰解析', () => {
  const sink = createCaptureSink()
  const full = ': mg-keepalive\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_k', status: 'completed', output: [msg('mk', 'assistant', 'k')] } }) + '\n\n'
  const buf = Buffer.from(full)
  sink.write(buf.subarray(0, 10))
  sink.write(buf.subarray(10, 40))
  sink.write(buf.subarray(40))
  const cap = sink.finish()
  assert.equal(cap.responseId, 'resp_k')
  assert.equal(cap.output.length, 1)
})