// A1｜MG-R005/R006：中断 / 取消 / 恢复的离线覆盖。
//
// 覆盖（全部离线）：
//   1) interrupt_agent 的声明与回程身份（不得被塞入 encrypted_function_args，不得改 call_id）；
//   2) 下游客户端中断时，SSE 仍只记录唯一终态（CLIENT_CANCELED），且之后不再产出工具项；
//   3) spawn → 工具回执 → 中断 → 单一中断终态 → 无额外派单 → resume 仍是同一个子身份；
//   4) 上游协议表达不了 interrupt 的部分：显式 NOT_ACCEPTED + 能力清单记账（不删场景、不假装通过）。
//
// 真实上游中断语义未获授权（MG-R012 BLOCKED），本套件只证明网关侧不变量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildToolPlan, restoreToolItem, restoreResponseJson } from '../../../src/codex/interop.js'
import { createCodexStreamAdapter } from '../../../src/responses-stream.js'
import { createLifecycleMock } from '../fixtures/codex/v2-lifecycle-mock.mjs'
import { NATIVE_CAPABILITIES, nativeCapabilityInventory } from '../../../src/codex/native-capabilities.js'

const ROUTE = {
  alias: 'codex-gpt',
  provider: 'openai-official',
  upstreamModel: 'gpt-6-luna',
  api: 'responses',
  codex: {
    multiAgentVersion: 'v2',
    plaintextTools: true,
    history: { agentMessage: 'preserve', reasoning: 'preserve', compaction: 'reject' },
    namespace: 'collaboration',
  },
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

function makeRes() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.writableLength = 0
  res.frames = []
  res.writeHead = () => { res.headersSent = true }
  res.write = (text) => { if (res.destroyed || res.writableEnded) throw new Error('write after end'); res.frames.push(String(text)); return true }
  res.end = () => { res.writableEnded = true }
  res.destroy = () => { if (res.destroyed) return; res.destroyed = true; res.emit('close') }
  return res
}

function frame(type, data) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n'
}

function makeAdapter() {
  const res = makeRes()
  const usages = []
  const adapter = createCodexStreamAdapter(res, {
    plan: buildToolPlan([collaborationNamespace()], ROUTE).plan,
    route: ROUTE,
    model: 'gpt-6-luna',
    id: 'resp_interrupt',
    createdAt: 1760000000,
    onUsage: (u) => usages.push(u),
  })
  return { res, adapter, usages }
}

function toolItem(name, callId, itemId, over) {
  return Object.assign({
    id: itemId, type: 'function_call', status: 'completed', call_id: callId, name, arguments: '{}',
  }, over || {})
}

function terminalEvents(adapter) {
  return adapter.events.filter((e) => ['response.completed', 'response.failed', 'response.incomplete', 'response.canceled'].includes(e.type))
}

test('interrupt：interrupt_agent 声明扁平化，回程恢复 namespace 且不带加密 marker', () => {
  const { plan, rejected } = buildToolPlan([collaborationNamespace()], ROUTE)
  assert.equal(rejected, null)
  const decl = plan.declarations.find((d) => d.name === 'interrupt_agent')
  assert.ok(decl)
  assert.equal(decl.namespace, undefined, '目标端不认识 namespace 字段')
  assert.equal(plan.declared.get('interrupt_agent').namespace, 'collaboration')
  assert.equal(plan.declared.get('interrupt_agent').messagePlaintext, false)

  const restored = restoreToolItem(toolItem('interrupt_agent', 'call_int_1', 'fc_int_1', { arguments: '{"target":"/root/worker"}' }), ROUTE, plan)
  assert.equal(restored.rejected, null)
  assert.equal(restored.item.namespace, 'collaboration')
  assert.equal(restored.item.name, 'interrupt_agent')
  assert.equal(restored.item.call_id, 'call_int_1', '取消关联 ID 必须保真')
  assert.equal(Object.prototype.hasOwnProperty.call(restored.item, 'encrypted_function_args'), false, 'interrupt 不得被补明文 marker')

  const json = {
    id: 'resp_up', object: 'response', status: 'completed', model: 'gpt-6-luna',
    output: [toolItem('interrupt_agent', 'call_int_1', 'fc_int_1', { arguments: '{"target":"/root/worker"}' })],
  }
  const restoredJson = restoreResponseJson(json, ROUTE, plan)
  assert.equal(restoredJson.rejected, null)
  assert.equal(restoredJson.json.output[0].namespace, 'collaboration')
  assert.equal(restoredJson.json.output[0].call_id, 'call_int_1')
})

test('interrupt：客户端中断后 SSE 恰好一个终态（CLIENT_CANCELED），之后不再产出工具项', async () => {
  const { res, adapter, usages } = makeAdapter()
  const added = frame('response.output_item.added', {
    sequence_number: 2, output_index: 0, item: { id: 'fc_int', type: 'function_call', status: 'in_progress', call_id: 'call_int_1', name: 'interrupt_agent', arguments: '' },
  })
  await adapter.push(frame('response.created', { sequence_number: 1, response: { id: 'resp_up', object: 'response', status: 'in_progress', model: 'gpt-6-luna', output: [] } }) + added)
  assert.equal(adapter.terminal, null)

  res.destroy() // 客户端中断（等价于父代理取消/关闭连接）
  await new Promise((r) => setImmediate(r))

  assert.equal(adapter.terminal, 'response.canceled', '中断也必须落到唯一终态，而不是无终态')
  assert.equal(adapter.terminalCode, 'CLIENT_CANCELED')
  assert.equal(terminalEvents(adapter)[0].delivered, false, '客户端已断开时不写帧，但终态必须记录')
  assert.equal(terminalEvents(adapter).length, 1)
  assert.equal(usages.length, 1, 'usage 只回调一次')
  assert.deepEqual(usages[0], { input_tokens: 0, output_tokens: 0, total_tokens: 0 })

  // 中断之后到达的帧（例如子代理的额外工具调用）不得再产出事件/帧
  const framesBefore = res.frames.length
  await adapter.push(frame('response.output_item.done', {
    sequence_number: 3, output_index: 1, item: toolItem('send_message', 'call_after_int', 'fc_after_int'),
  }))
  assert.equal(res.frames.length, framesBefore)
  assert.equal(adapter.events.filter((e) => e.type === 'response.output_item.done').length, 0, '中断后不得再有工具派单')

  await adapter.end()
  assert.equal(terminalEvents(adapter).length, 1, 'end() 不得追加第二个终态')
})

test('interrupt：显式 fail 与客户端中断互斥，终态仍唯一', async () => {
  const { res, adapter } = makeAdapter()
  await adapter.push(frame('response.created', { sequence_number: 1, response: { id: 'resp_up', object: 'response', status: 'in_progress', model: 'gpt-6-luna', output: [] } }))
  res.destroy()
  await new Promise((r) => setImmediate(r))
  await adapter.fail('late upstream error', {})
  assert.equal(terminalEvents(adapter).length, 1)
  assert.equal(adapter.terminal, 'response.canceled')
  assert.equal(adapter.terminalCode, 'CLIENT_CANCELED')
})

test('interrupt + resume：同一子身份进入单一 canceled 终态，无额外派单，resume 不新建子代理', () => {
  const mock = createLifecycleMock()
  assert.equal(mock.openRoot({ rootId: 'root-synthetic-1' }).ok, true)
  const spawned = mock.spawn({ rootId: 'root-synthetic-1', taskName: '/root/worker', message: 'task A' })
  assert.equal(spawned.ok, true)

  // 工具回执：子代理先完成一次工具调用
  const ran = mock.runChild({ taskName: '/root/worker', approval: 'allow' })
  assert.match(ran.output, new RegExp(spawned.nonce))

  // 中断：只允许一次终态转移
  const canceled = mock.cancel({ taskName: '/root/worker' })
  assert.equal(canceled.state, 'canceled')
  assert.equal(mock.snapshot({ rootId: 'root-synthetic-1', taskName: '/root/worker' }).child.state, 'canceled')

  // 无额外派单：中断后的追派/等待/工具执行都必须失败，而不是又跑一轮
  assert.equal(mock.followup({ taskName: '/root/worker' }).error, 'agent_canceled')
  assert.equal(mock.wait({ taskName: '/root/worker' }).error, 'agent_canceled')
  assert.equal(mock.runChild({ taskName: '/root/worker', approval: 'allow' }).error, 'agent_canceled')

  // resume：仍是同一个子身份（同一个 task_name / nonce），不是新建子代理
  const resumed = mock.resume({ rootId: 'root-synthetic-1' })
  assert.equal(resumed.ok, true)
  assert.deepEqual(resumed.children, ['/root/worker'], 'resume 不得产生第二个子线程')
  const child = mock.snapshot({ rootId: 'root-synthetic-1', taskName: '/root/worker' }).child
  assert.equal(child.name, spawned.task_name)
  assert.equal(child.nonce, spawned.nonce, 'resume 后子身份（nonce）不变')
  assert.equal(child.state, 'canceled')
})

test('interrupt：上游协议缺少 cancel/interrupt 帧与 interrupted 终态 → NOT_ACCEPTED', { skip: 'NOT_ACCEPTED: upstream Responses has no response.cancel / response.interrupted message type; collaboration.interrupt_agent is a local Codex harness tool, so a gateway cannot prove a single interrupted child terminal state' }, () => {
  // 保留场景：真实 Codex 在任务进行中中断子代理、子代理进入唯一 interrupted 终态、无额外工具派单、
  // 随后 resume 继续同一子身份。需要可表达中断的上游协议或取得授权的真实运行，二者当前都不具备。
  assert.fail('must not run')
})

test('interrupt：能力清单把该项登记为 NOT_ACCEPTED，且不冒充 PASS_REAL', () => {
  const interrupt = NATIVE_CAPABILITIES.find((c) => c.id === 'v2_interrupt')
  assert.ok(interrupt)
  assert.equal(interrupt.status, 'NOT_ACCEPTED')
  assert.ok(Array.isArray(interrupt.missing.messageTypes) && interrupt.missing.messageTypes.length > 0)
  assert.ok(interrupt.missing.fields.includes('cell_id'))
  assert.match(interrupt.missing.why, /function_call/)
  const inventory = nativeCapabilityInventory()
  assert.equal(inventory.capabilities.some((c) => c.status === 'PASS_REAL'), false)
  assert.equal(inventory.agentTeamComplete, false)
})
