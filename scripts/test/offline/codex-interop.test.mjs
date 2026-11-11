// E4（Codex v2 子代理互操作）离线回归：纯映射 + 隔离网关 + 本地 mock 上游。
// 证据来源：docs/explanation/codex-v2-agents.md（Codex CLI 0.167.0 真实 tools/agent_message 抓包，
// 临时 CODEX_HOME + 本地 mock，无网络、无真实凭据）。
// 覆盖：namespace 可逆展开、托管工具 unsupported 错误码、call_id 配对、v2 加密任务显式拒绝、
//      原生 Responses 透传不回归（v2 agent_message 原样交给上游）、Chat 桥 SSE 回程还原 name+namespace。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import {
  planChatTools, encodeNamespacedToolName, decodeNamespacedToolName, collapseToolCallName,
  normalizeInputToolCall, detectOpaqueV2Task, analyzeToolPairs, flattenAgentMessage,
  UNSUPPORTED_TOOL, V2_ENCRYPTED_TASK_UNSUPPORTED,
} from '../../../src/codex/interop.js'
import { responsesToChat, bridge, chatToResponse, makeSSEWriter, UNSUPPORTED_NATIVE_PARAMETER } from '../../../src/responses.js'

const lossyHas = (list, needle) => (list || []).some((x) => String(x).includes(needle))

// —— Codex CLI 0.167.0 实测 tools 形状（裁剪自真实抓包，正文/描述已最小化）——
const V1_NAMESPACE = {
  type: 'namespace', name: 'multi_agent_v1', description: 'Tools for spawning and managing sub-agents.',
  tools: ['close_agent', 'resume_agent', 'send_input', 'spawn_agent', 'wait_agent'].map((name) => ({
    type: 'function', name, description: name, strict: false,
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
  })),
}
const V2_NAMESPACE = {
  type: 'namespace', name: 'collaboration', description: 'Tools for spawning and managing sub-agents.',
  tools: ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'].map((name) => ({
    type: 'function', name, description: name, strict: false,
    parameters: { type: 'object', properties: { target: { type: 'string' }, message: { type: 'string', encrypted: true } } },
  })),
}
const REAL_V1_TOOLS = [
  { type: 'function', name: 'exec_command', description: 'Runs a command in a PTY.', strict: false, parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  V1_NAMESPACE,
  { type: 'web_search', external_web_access: true },
]
const FAKE_CIPHER = 'OBFUSCATED-PAYLOAD-NOT-A-REAL-CREDENTIAL'
const ENCRYPTED_AGENT_MESSAGE = {
  type: 'agent_message',
  id: 'amsg_01a1c8f8-c24c-77e3-9dc6-294bbe18c19f',
  author: '/root',
  recipient: '/root/probe_task',
  content: [
    { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/probe_task\nSender: /root\nPayload:\n' },
    { type: 'encrypted_content', encrypted_content: FAKE_CIPHER },
  ],
}
const PLAIN_AGENT_MESSAGE = {
  type: 'agent_message', id: 'amsg_plain', author: '/root', recipient: '/root/probe_task',
  content: [{ type: 'input_text', text: 'read the workspace and report file count' }],
}

// ============================================================================
// 纯函数：工具展开 / 回程还原
// ============================================================================
test('interop：Codex 0.167 真实 tools 形状 -> Chat function 可逆展开', () => {
  const plan = planChatTools(REAL_V1_TOOLS)
  assert.equal(plan.rejected, null)
  assert.equal(plan.chatTools.length, 6, '1 个普通 function + namespace 内 5 个')
  assert.equal(plan.chatTools.some((t) => t.type !== 'function'), false, 'Chat 只保留 function')
  assert.deepEqual(plan.aliases.map((a) => a.name).sort(), ['close_agent', 'resume_agent', 'send_input', 'spawn_agent', 'wait_agent'])
  for (const a of plan.aliases) {
    assert.equal(a.wireName, 'mg_ns__multi_agent_v1__' + a.name)
    assert.ok(a.wireName.length <= 64)
    assert.deepEqual(decodeNamespacedToolName(a.wireName), { namespace: 'multi_agent_v1', name: a.name }, '展开名必须可逆')
    assert.match(a.wireName, /^[A-Za-z0-9_-]+$/, 'Chat function 名允许字符')
  }
  const search = plan.chatTools.find((t) => t.function.name === 'exec_command')
  assert.ok(search, '普通 function 原样保留')
  const nsTool = plan.chatTools.find((t) => t.function.name === 'mg_ns__multi_agent_v1__spawn_agent')
  assert.match(nsTool.function.description, /\[namespace multi_agent_v1\]/, 'namespace 上下文进入描述')
  // 托管工具：不再静默丢弃 —— 有稳定 unsupported 错误码 + 兼容 lossy
  assert.equal(plan.unsupported.length, 1)
  assert.equal(plan.unsupported[0].code, UNSUPPORTED_TOOL)
  assert.equal(plan.unsupported[0].toolType, 'web_search')
  assert.ok(lossyHas(plan.lossy, 'tool_dropped:web_search'))
})

test('interop：v2 namespace=collaboration 展开 + 未知/嵌套不可表达工具显式标记', () => {
  const v2 = planChatTools([V2_NAMESPACE])
  assert.equal(v2.chatTools.length, 6)
  assert.ok(v2.aliases.every((a) => a.namespace === 'collaboration'))
  assert.ok(v2.chatTools.every((t) => t.function.name.length <= 64))
  assert.equal(decodeNamespacedToolName('mg_ns__collaboration__followup_task').name, 'followup_task')

  const mixed = planChatTools([{ type: 'namespace', name: 'ns1', tools: [
    { type: 'function', name: 'ok', parameters: { type: 'object' } },
    { type: 'mcp', name: 'nested_mcp' },
  ] }])
  assert.equal(mixed.chatTools.length, 1)
  assert.equal(mixed.unsupported[0].toolType, 'mcp')
  assert.equal(mixed.unsupported[0].namespace, 'ns1')

  // 空 namespace：保留既有 lossy 口径，同时给出 unsupported 错误码
  const empty = planChatTools([{ type: 'namespace', name: 'ns_empty' }])
  assert.equal(empty.chatTools, undefined)
  assert.ok(lossyHas(empty.lossy, 'tool_dropped:namespace'))
  assert.equal(empty.unsupported[0].toolType, 'namespace')
})

test('interop：onUnsupported=reject 让不可表达工具显式失败（默认 drop 保持真实 Codex 可用）', () => {
  const strict = planChatTools([V2_NAMESPACE, { type: 'web_search' }], { onUnsupported: 'reject' })
  assert.equal(strict.rejected.code, UNSUPPORTED_TOOL)
  assert.match(strict.rejected.message, /web_search/)
  assert.equal(strict.chatTools.length, 6, '可表达部分仍被展开，便于诊断')

  const r = responsesToChat({ model: 'demo', input: 'hi', tools: [{ type: 'web_search' }] }, { onUnsupportedTool: 'reject' })
  assert.equal(r.body, null)
  assert.equal(r.rejected.code, UNSUPPORTED_TOOL)
  assert.equal(r.unsupported[0].toolType, 'web_search')
})

test('interop：call_id 配对诊断覆盖并行调用 / 缺失 / 孤儿结果', () => {
  const ok = analyzeToolPairs([
    { type: 'function_call', call_id: 'c1', name: 'a' },
    { type: 'function_call', call_id: 'c2', name: 'b' },
    { type: 'function_call_output', call_id: 'c1', output: '1' },
    { type: 'function_call_output', call_id: 'c2', output: '2' },
  ])
  assert.equal(ok.ok, true)
  assert.equal(ok.calls.length, 2)
  assert.equal(ok.outputs.length, 2)

  const bad = analyzeToolPairs([
    { type: 'function_call', call_id: 'c1', name: 'a' },
    { type: 'function_call' },
    { type: 'function_call_output', call_id: 'nope', output: 'x' },
  ])
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((p) => p.code === 'tool_call_missing_call_id'))
  assert.ok(bad.problems.some((p) => p.code === 'tool_output_without_call'))
  assert.ok(bad.problems.some((p) => p.code === 'tool_call_without_output'))
})

test('interop：v2 加密任务判定只给信号，不返回/不记录密文', () => {
  const enc = detectOpaqueV2Task({ input: [ENCRYPTED_AGENT_MESSAGE] })
  assert.equal(enc.opaque, true)
  assert.equal(enc.readable, false)
  assert.ok(enc.signals.some((s) => s.kind === 'agent_message' && s.encrypted === true))
  assert.equal(JSON.stringify(enc.signals).includes(FAKE_CIPHER), false, '信号不得包含密文')

  const argsEnc = detectOpaqueV2Task({ input: [{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{"encrypted_task_id":"OPAQUE"}' }] })
  assert.equal(argsEnc.opaque, true)
  assert.equal(argsEnc.signals[0].kind, 'tool_arguments')
  assert.equal(JSON.stringify(argsEnc.signals).includes('OPAQUE'), false)

  const plain = detectOpaqueV2Task({ input: [PLAIN_AGENT_MESSAGE] })
  assert.equal(plain.opaque, false)
  assert.equal(plain.readable, true)

  // 普通工具的业务字段同名（encrypted_content）不得误判为 v2 密文任务
  const benign = detectOpaqueV2Task({ input: [{ type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{"path":"/tmp/x","encrypted_content":"business field"}' }] })
  assert.equal(benign.opaque, false, '只有 v2 子代理工具或 encrypted_task_id 才按不可读任务处理')
})

// ============================================================================
// responsesToChat：请求方向
// ============================================================================
test('§4 命名空间 function_call 展开成与 tools 一致的扁平名，call_id 保序配对', () => {
  const r = responsesToChat({
    model: 'demo',
    tools: [V2_NAMESPACE],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'call_1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"task_name":"t","message":"m"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"task_name":"/root/t"}' },
    ],
  })
  assert.equal(r.rejected, null)
  assert.equal(r.mode, 'bridge')
  assert.deepEqual(r.aliases.find((a) => a.name === 'spawn_agent').wireName, 'mg_ns__collaboration__spawn_agent')
  const assistant = r.body.messages.find((m) => m.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.name, 'mg_ns__collaboration__spawn_agent', '必须与展开后的工具名一致')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  const toolMsg = r.body.messages.find((m) => m.role === 'tool')
  assert.equal(toolMsg.tool_call_id, 'call_1', '结果回填必须用同一 call_id')
  assert.ok(lossyHas(r.lossy, 'namespace_tool_input:collaboration'))
  assert.equal(r.pairing.ok, true)

  // 只带 name 的普通 function_call 不应被改写
  const plain = responsesToChat({ model: 'demo', input: [{ type: 'function_call', call_id: 'c9', name: 'exec_command', arguments: '{}' }, { type: 'function_call_output', call_id: 'c9', output: 'ok' }] })
  assert.equal(plain.body.messages[0].tool_calls[0].function.name, 'exec_command')
})

test('§4 并行 tool_call：多条调用合并进同一条 assistant 消息，结果按 call_id 回填', () => {
  const r = responsesToChat({
    model: 'demo',
    tools: [V1_NAMESPACE],
    input: [
      { type: 'function_call', call_id: 'c1', name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: '{"a":1}' },
      { type: 'function_call', call_id: 'c2', name: 'wait_agent', namespace: 'multi_agent_v1', arguments: '{"b":2}' },
      { type: 'function_call_output', call_id: 'c1', output: 'one' },
      { type: 'function_call_output', call_id: 'c2', output: 'two' },
    ],
  })
  assert.equal(r.rejected, null)
  const assistants = r.body.messages.filter((m) => m.role === 'assistant')
  assert.equal(assistants.length, 1, '并行调用合并为一条 assistant.tool_calls')
  assert.deepEqual(assistants[0].tool_calls.map((c) => c.id), ['c1', 'c2'])
  const tools = r.body.messages.filter((m) => m.role === 'tool')
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['c1', 'c2'])
  assert.equal(r.pairing.ok, true)
})

test('§4 缺 call_id：映射不伪造配对，显式记 lossy 并报告配对问题', () => {
  const r = responsesToChat({ model: 'demo', input: [{ type: 'function_call', name: 'exec_command', arguments: '{}' }] })
  assert.equal(r.rejected, null)
  assert.ok(lossyHas(r.lossy, 'tool_call_missing_call_id'))
  assert.ok(r.pairing.problems.some((p) => p.code === 'tool_call_missing_call_id'))
})

test('§4 v2 加密 agent_message：桥方向显式 400 code=v2_encrypted_task_unsupported，不解析/不删除/不伪造', () => {
  const r = responsesToChat({ model: 'demo', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }, ENCRYPTED_AGENT_MESSAGE] })
  assert.equal(r.body, null)
  assert.equal(r.rejected.code, V2_ENCRYPTED_TASK_UNSUPPORTED)
  assert.equal(r.rejected.message.includes(FAKE_CIPHER), false, '错误信息不得回显密文')
  assert.match(r.rejected.message, /不解析|不删除|不伪造/)
  assert.ok(r.signals.some((s) => s.kind === 'agent_message'))
})

test('§4 可读 agent_message（纯文本）：降级为 user 消息并显式记 lossy', () => {
  const r = responsesToChat({ model: 'demo', input: [PLAIN_AGENT_MESSAGE] })
  assert.equal(r.rejected, null)
  assert.equal(r.body.messages[0].role, 'user')
  assert.match(r.body.messages[0].content, /author=\/root/)
  assert.match(r.body.messages[0].content, /read the workspace/)
  assert.ok(lossyHas(r.lossy, 'agent_message_text_flattened'))
})

// ============================================================================
// responsesToChat：native 模式（宿主 Responses 透传前置校验）
// ============================================================================
test('§4 native 模式不受 Chat 桥限制污染：v2 agent_message / 托管工具 / namespace 原样放行', () => {
  const body = {
    model: 'native', input: [ENCRYPTED_AGENT_MESSAGE], tools: [V1_NAMESPACE, { type: 'web_search' }], include: ['reasoning.encrypted_content'],
  }
  const n = responsesToChat(body, { mode: 'native' })
  assert.equal(n.rejected, null, '原生透传不得因 v2 密文/托管工具被拒')
  assert.equal(n.body, null, 'native 模式不产出 Chat body')
  assert.equal(n.mode, 'native')
  // 桥方向默认仍是显式错误（避免静默丢弃密文）
  assert.equal(responsesToChat(body).rejected.code, V2_ENCRYPTED_TASK_UNSUPPORTED)
})

test('§4 native legacy 拒绝矩阵（无 nativeContract）：明确 unsupported_native_parameter', () => {
  for (const patch of [{ store: true }, { previous_response_id: 'resp_1' }, { background: true }, { truncation: 'auto' }]) {
    const r = responsesToChat(Object.assign({ model: 'native', input: 'hi' }, patch), { mode: 'native' })
    assert.ok(r.rejected, JSON.stringify(patch) + ' native 模式仍须拒绝')
    assert.equal(r.rejected.code, UNSUPPORTED_NATIVE_PARAMETER, '不得再用泛化 unsupported_parameter')
    assert.match(String(r.rejected.message), /nativeContract/)
  }
})

test('§4 native nativeContract 显式驱动：声明支持的字段放行、未声明仍拒绝', () => {
  const full = { store: true, previous_response_id: 'resp_1', background: true, truncation: 'auto' }
  const contract = { store: true, previous_response_id: true, background: true, truncation: true }
  const allowed = bridge(Object.assign({ model: 'native', input: 'hi' }, full), { mode: 'native', nativeContract: contract })
  assert.equal(allowed.rejected, null, '契约声明支持时必须放行')
  assert.equal(allowed.body, null)

  const partial = bridge({ model: 'native', input: 'hi', store: true }, { mode: 'native', nativeContract: { supported: ['previous_response_id'] } })
  assert.equal(partial.rejected.code, UNSUPPORTED_NATIVE_PARAMETER, '白名单未声明的字段仍拒绝')

  const unsupportedList = bridge({ model: 'native', input: 'hi', store: true }, { mode: 'native', nativeContract: { unsupported: ['store'] } })
  assert.equal(unsupportedList.rejected.code, UNSUPPORTED_NATIVE_PARAMETER)
  const notListed = bridge({ model: 'native', input: 'hi', previous_response_id: 'r' }, { mode: 'native', nativeContract: { unsupported: ['store'] } })
  assert.equal(notListed.rejected, null, '黑名单未列出的字段按支持处理')
})

// ============================================================================
// 回程：JSON 与 SSE 事件都要还原 name+namespace
// ============================================================================
test('§5 chatToResponse：扁平展开名还原 name+namespace；普通/custom 工具不受影响', () => {
  const resp = chatToResponse({
    id: 'chatcmpl-x', model: 'vendor-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'mg_ns__collaboration__send_message', arguments: '{"target":"/root/t","message":"hi"}' } },
      { id: 'call_2', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } },
    ] }, finish_reason: 'tool_calls' }],
  }, { model: 'demo' })
  const nsCall = resp.output.find((o) => o.call_id === 'call_1')
  assert.equal(nsCall.name, 'send_message')
  assert.equal(nsCall.namespace, 'collaboration')
  assert.equal(nsCall.arguments, '{"target":"/root/t","message":"hi"}')
  const plain = resp.output.find((o) => o.call_id === 'call_2')
  assert.equal(plain.name, 'exec_command')
  assert.equal(plain.namespace, undefined)
})

test('§6 SSE writer：begin/end/completed 三处都还原 namespace（Codex 按 item 事件路由）', () => {
  const w = makeSSEWriter({ model: 'demo' })
  const wire = 'mg_ns__multi_agent_v1__wait_agent'
  const added = w.beginToolCall({ call_id: 'call_1', name: wire, type: 'function_call' })
  assert.ok(added.includes('"namespace":"multi_agent_v1"'))
  assert.ok(added.includes('"name":"wait_agent"'))
  const done = w.endToolCall('{"targets":["x"]}')
  assert.ok(done.includes('"namespace":"multi_agent_v1"'))
  assert.ok(done.includes('"name":"wait_agent"'))
  assert.equal(done.includes(wire), false, '事件里不得残留展开名')

  const completed = w.completed({ id: 'resp_1', object: 'response', status: 'completed', model: 'demo', output: [
    { type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_1', name: wire, arguments: '{}' },
  ] })
  assert.ok(completed.includes('"namespace":"multi_agent_v1"'))
  assert.equal(completed.includes(wire), false, '终态 output 也必须还原')
  assert.deepEqual(collapseToolCallName(wire), { name: 'wait_agent', namespace: 'multi_agent_v1' })
})

// ============================================================================
// 隔离网关：原生透传不回归 + 桥方向显式失败 + 工具往返
// ============================================================================
const json = () => ({ 'content-type': 'application/json' })
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}
function parseSSE(text) {
  return String(text).split('\n\n').filter((b) => b.trim()).map((block) => {
    const ev = { event: '', data: '' }
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim()
      if (line.startsWith('data:')) ev.data = (ev.data ? ev.data + '\n' : '') + line.slice(5).trim()
    }
    return ev
  })
}

test('E4 集成：原生 Responses 透传 v2 密文不回归；Chat 桥显式 400', { timeout: 30000 }, async (t) => {
  const RESP = { id: 'resp_native', object: 'response', status: 'completed', model: 'vendor-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], output_text: 'ok' }
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url.endsWith('/responses') ? RESP : { id: 'chat', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({
    name: 'codex-interop-native',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { nativeResp: { provider: 'mock', api: 'responses', providerModels: { mock: 'vendor-model' } }, bridge: { provider: 'mock' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const body = {
    model: 'nativeResp',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }, ENCRYPTED_AGENT_MESSAGE],
    tools: [V2_NAMESPACE, { type: 'web_search' }],
    include: ['reasoning.encrypted_content'],
  }
  const native = await gw.post('/v1/responses', body, json())
  assert.equal(native.status, 200, '原生透传不得因 v2 agent_message/密文 400')
  const nativeHit = upstream.hits.find((h) => h.url.endsWith('/responses'))
  assert.ok(nativeHit, '原生模型必须走 /v1/responses')
  assert.equal(nativeHit.body.input[1].type, 'agent_message', 'agent_message 原样交给官方上游')
  assert.equal(nativeHit.body.input[1].content[1].encrypted_content, FAKE_CIPHER, '密文必须原样转发，网关不解析/不改写')
  assert.ok(nativeHit.body.tools.some((x) => x.type === 'namespace'), 'namespace 工具原样透传')
  assert.ok(nativeHit.body.tools.some((x) => x.type === 'web_search'))

  const hitsBefore = upstream.hits.length
  const bridge = await gw.post('/v1/responses', Object.assign({}, body, { model: 'bridge' }), json())
  assert.equal(bridge.status, 400)
  const bridgeErr = (await bridge.json()).error
  assert.equal(bridgeErr.type, V2_ENCRYPTED_TASK_UNSUPPORTED)
  assert.equal(String(bridgeErr.message).includes(FAKE_CIPHER), false, '错误不得回显密文')
  assert.equal(upstream.hits.length, hitsBefore, '桥方向显式失败不得触达上游')
})

test('E4 集成：Chat 桥工具往返（namespace 展开 -> 上游 -> 回程还原 name+namespace）', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    const stream = rec.body && rec.body.stream
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'chat', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'mg_ns__collaboration__spawn_agent', arguments: '{"task_name":"t","message":"m"}' } },
      ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'mg_ns__collaboration__spawn_agent', arguments: '{"task_name":"t"' } }] } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ',"message":"m"}' } }] } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const gw = await startGateway({
    name: 'codex-interop-bridge',
    config: { providers: { mock: { baseUrl: upstream.base } }, models: { bridge: { provider: 'mock' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const tools = [V2_NAMESPACE, { type: 'web_search' }]

  // 非流式：上游只应收到 function 工具（namespace 展开 + web_search 显式 unsupported，不静默丢弃）
  const nonStream = await gw.post('/v1/responses', { model: 'bridge', input: 'go', tools, stream: false }, json())
  assert.equal(nonStream.status, 200)
  const sentTools = upstream.hits[0].body.tools
  assert.equal(sentTools.some((x) => x.type === 'namespace' || x.type === 'web_search'), false)
  const spawn = sentTools.find((x) => x.function.name === 'mg_ns__collaboration__spawn_agent')
  assert.ok(spawn, 'namespace 内建工具必须展开后才下发')
  const out = await nonStream.json()
  const fc = out.output.find((o) => o.type === 'function_call')
  assert.equal(fc.name, 'spawn_agent')
  assert.equal(fc.namespace, 'collaboration')
  assert.equal(fc.call_id, 'call_1')
  assert.equal(out.output.some((o) => o.name === 'mg_ns__collaboration__spawn_agent'), false, '不得把展开名回给 Codex')

  // 流式：item 事件（Codex 实际路由依据）也必须带 namespace
  const streamRes = await gw.post('/v1/responses', { model: 'bridge', input: 'go', tools, stream: true }, json())
  assert.equal(streamRes.status, 200)
  const text = await streamRes.text()
  const events = parseSSE(text)
  const addedItems = events.filter((e) => e.event === 'response.output_item.added').map((e) => JSON.parse(e.data).item)
  const addedItem = addedItems.find((it) => it.type === 'function_call')
  assert.ok(addedItem, '必须有 function_call 的 output_item.added 事件')
  assert.equal(addedItem.name, 'spawn_agent')
  assert.equal(addedItem.namespace, 'collaboration')
  const completed = JSON.parse(events.find((e) => e.event === 'response.completed').data)
  const completedCall = completed.response.output.find((o) => o.type === 'function_call')
  assert.equal(completedCall.namespace, 'collaboration')
  assert.equal(text.includes('mg_ns__collaboration__spawn_agent'), false, 'SSE 事件与终态都不得残留展开名')
})
