// A1｜MG-R008/R011：原生协议适配的不变量（发送前拦截 + 零上游 + 无静默降级）。
//
// 覆盖（全部离线；网关用例使用回环 mock + 临时 HOME，不触真实上游/凭据）：
//   1) 不可读密文任务不得作为空任务转发给第三方原生上游（PASS_MOCK）；
//   2) 业务字段恰好叫 encrypted_content 的普通工具不得误判（零误伤）；
//   3) Chat 桥遇到 Code Mode 单元状态必须显式失败，不得静默降级；
//   4) 未知/托管工具不得被协议适配静默丢弃；
//   5) wait 的 call_id / cell_id 上下游一致；
//   6) 网关真实拒绝路径：HTTP 400 + 上游零命中。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { buildToolPlan, detectOpaqueToolPayload } from '../../../src/codex/interop.js'
import { bridge, prepareCodexNativeRequest } from '../../../src/responses.js'
import { createCodexStreamAdapter } from '../../../src/responses-stream.js'

const CIPHER = 'SYNTHETIC-CIPHER-NOT-A-REAL-TOKEN'
const ROUTE = {
  alias: 'codex-deepseek',
  provider: 'deepseek-official',
  upstreamModel: 'deepseek-v4-pro',
  api: 'responses',
  codex: {
    multiAgentVersion: 'v2',
    plaintextTools: true,
    history: { agentMessage: 'project', reasoning: 'drop', compaction: 'reject' },
    namespace: 'collaboration',
  },
}

function collaborationNamespace() {
  const fn = (name, props) => ({ type: 'function', name, description: name, parameters: { type: 'object', properties: props || {} } })
  return {
    type: 'namespace',
    name: 'collaboration',
    description: 'native collaboration tools',
    tools: [
      fn('spawn_agent', { task_name: { type: 'string' }, message: { type: 'string', encrypted: true } }),
      fn('followup_task', { target: { type: 'string' }, message: { type: 'string', encrypted: true } }),
      fn('send_message', { target: { type: 'string' }, message: { type: 'string', encrypted: true } }),
      fn('wait_agent', {}),
      fn('interrupt_agent', { target: { type: 'string' } }),
      fn('list_agents', {}),
    ],
  }
}

function spawnWithCipher(text) {
  return {
    type: 'function_call',
    call_id: 'call_spawn_1',
    name: 'spawn_agent',
    namespace: 'collaboration',
    arguments: JSON.stringify({ task_name: '/root/w', message: { encrypted_content: text } }),
  }
}

test('invariants：collaboration 任务正文为密文 → 发送前拒绝，且错误不回显密文', () => {
  const body = {
    model: 'codex-deepseek',
    input: [spawnWithCipher(CIPHER), { type: 'function_call_output', call_id: 'call_spawn_1', output: '{"task_name":"/root/w"}' }],
    tools: [collaborationNamespace()],
    stream: true,
  }
  const out = prepareCodexNativeRequest(body, ROUTE)
  assert.equal(out.body, null, '不可读密文不得作为空任务转发给第三方原生上游')
  assert.equal(out.rejected.code, 'opaque_collaboration_task')
  assert.match(out.rejected.message, /spawn_agent/)
  assert.equal(JSON.stringify(out).includes(CIPHER), false, '拒绝结果不得包含密文')
  assert.equal(out.plan, null)
})

test('invariants：detectOpaqueToolPayload 只认协作工具与 encrypted_task_id，普通工具不误伤', () => {
  const opaque = detectOpaqueToolPayload([spawnWithCipher(CIPHER)])
  assert.equal(opaque.opaque, true)
  assert.deepEqual(opaque.signals.map((s) => [s.kind, s.toolName]), [['tool_arguments', 'spawn_agent']])
  assert.equal(JSON.stringify(opaque.signals).includes(CIPHER), false, '信号只含字段名，不含密文')

  const benign = detectOpaqueToolPayload([
    { type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{"path":"/tmp/x","encrypted_content":"business field"}' },
  ])
  assert.equal(benign.opaque, false, '普通工具里恰好同名的业务字段不是 v2 密文任务')

  const nested = detectOpaqueToolPayload([
    { type: 'function_call', call_id: 'c2', name: 'send_message', arguments: '{"target":"/root/w","message":{"nested":{"encrypted_task_id":"X"}}}' },
  ])
  assert.equal(nested.opaque, true)
  assert.deepEqual(nested.signals[0].fields.sort(), ['encrypted_task_id'])

  const viaOutput = detectOpaqueToolPayload([
    { type: 'function_call', call_id: 'c3', name: 'spawn_agent', arguments: '{"task_name":"/root/w"}' },
    { type: 'function_call_output', call_id: 'c3', output: '{"task":{"encrypted_content":"X"}}' },
  ])
  assert.equal(viaOutput.opaque, true)
  assert.equal(viaOutput.signals[0].kind, 'tool_output')
})

test('invariants：Chat 桥遇到 Code Mode 单元状态 → 显式失败，不静默降级成 Chat', () => {
  const body = {
    model: 'codex-deepseek',
    input: [
      { type: 'function_call', call_id: 'call_exec_1', name: 'exec', arguments: '{"code":"return 1"}' },
      { type: 'function_call_output', call_id: 'call_exec_1', output: '{"cell_id":"cell-2","status":"running"}' },
      { type: 'function_call', call_id: 'call_wait_1', name: 'wait', arguments: '{"cell_id":"cell-2"}' },
    ],
  }
  const out = bridge(body)
  assert.equal(out.body, null)
  assert.equal(out.rejected.code, 'code_mode_bridge_unsupported')
  assert.match(out.rejected.message, /cell/i)
  // 显式选择也不能“降级成功”：桥没有单元状态，无法保真
  const loose = bridge(body, { allowLossy: true })
  assert.equal(loose.body, null)
  assert.equal(loose.rejected.code, 'code_mode_bridge_unsupported')
  // 没有 cell 状态的普通 code-mode 历史不受影响
  const plain = bridge({ model: 'm', input: 'hi' })
  assert.equal(plain.rejected, null)
})

test('invariants：未知/托管工具不被协议适配静默丢弃', () => {
  const tools = [
    { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
    { type: 'web_search', external_web_access: true },
    { type: 'programmatic_tool_calling' },
    collaborationNamespace(),
  ]
  const { plan, rejected } = buildToolPlan(tools, ROUTE)
  assert.equal(rejected, null)
  const names = (plan.declarations || []).map((d) => d.name || d.type)
  for (const expected of ['exec_command', 'web_search', 'programmatic_tool_calling', 'spawn_agent', 'interrupt_agent']) {
    assert.ok(names.includes(expected), '声明必须保留: ' + expected)
  }
})

test('invariants：wait 的 call_id 与 cell_id 在 SSE 回程逐字保留', async () => {
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.writableLength = 0
  res.frames = []
  res.writeHead = () => { res.headersSent = true }
  res.write = (t) => { res.frames.push(String(t)); return true }
  res.end = () => { res.writableEnded = true }
  res.destroy = () => { res.destroyed = true; res.emit('close') }
  const adapter = createCodexStreamAdapter(res, {
    plan: buildToolPlan([collaborationNamespace()], ROUTE).plan,
    route: ROUTE,
    model: 'codex-gpt',
    id: 'resp_wait',
  })
  const item = {
    id: 'fc_wait', type: 'function_call', status: 'completed',
    call_id: 'call_wait_1', name: 'wait', arguments: '{"cell_id":"cell-2"}',
  }
  await adapter.push('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item }) + '\n\n')
  const out = adapter.events[0].data.item
  assert.equal(out.call_id, 'call_wait_1')
  assert.equal(out.arguments, '{"cell_id":"cell-2"}')
  assert.equal(out.namespace, undefined, '顶层 wait 不属于 collaboration namespace')
  assert.equal(out.encrypted_function_args, undefined)
})

test('invariants：网关对密文协作任务返回 400 且上游零命中（真实接线路径）', { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'a1-inv-home-'))
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    hits.push({ url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r', object: 'response', status: 'completed', model: 'deepseek-v4-pro', output: [] }))
  })
  const gw = await startGateway({
    name: 'a1-invariants',
    env: { HOME: home, CODEX_HOME: join(home, '.codex') },
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, overallMs: 5000, loopMs: 5000 } },
      providers: { go: { baseUrl: upstream.base, api: 'responses' } },
      models: {
        'codex-deepseek': {
          provider: 'go',
          api: 'responses',
          codex: { plaintextTools: true, history: { agentMessage: 'project', reasoning: 'drop', compaction: 'reject' } },
        },
      },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop(); await rm(home, { recursive: true, force: true }) })

  const rejected = await gw.post('/v1/responses', {
    model: 'codex-deepseek',
    stream: true,
    input: [spawnWithCipher(CIPHER), { type: 'function_call_output', call_id: 'call_spawn_1', output: '{"task_name":"/root/w"}' }],
    tools: [collaborationNamespace()],
  })
  const text = await rejected.text()
  assert.equal(rejected.status, 400, text)
  assert.match(text, /opaque_collaboration_task/)
  assert.equal(text.includes(CIPHER), false, '响应不得回显密文')
  assert.equal(hits.length, 0, '拒绝必须在发送前完成：上游零命中')

  // 同类请求但无密文：正常到达上游，证明上面的 400 不是把整条路径封死
  const accepted = await gw.post('/v1/responses', {
    model: 'codex-deepseek',
    stream: false,
    input: [{
      type: 'function_call', call_id: 'call_spawn_2', name: 'spawn_agent', namespace: 'collaboration',
      arguments: '{"task_name":"/root/w","message":"read the workspace"}',
    }, { type: 'function_call_output', call_id: 'call_spawn_2', output: '{"task_name":"/root/w"}' }],
    tools: [collaborationNamespace()],
  })
  await accepted.text()
  assert.equal(accepted.status, 200)
  assert.equal(hits.length, 1)
})
