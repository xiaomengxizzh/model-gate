// MG-017 task-2（responses-mapping）离线契约测试。
// 契约：docs/contracts/codex-multi-agent-v2.md §4.1（冻结模块接口）与 §5（线级规则 / §5.1 marker 矩阵）。
// fixture 依据 Lead 在 0.167.0 本机真实抓线：tools[] 是 type:"namespace", name:"collaboration"，
// 内含 6 个 function；其中 spawn_agent / send_message / followup_task 的 message 是
// {type:"string",description,encrypted:true}；其余三个没有 message 参数。
// 真实历史完成项 {type:"function_call",status:"completed",id,name,namespace:"collaboration",
// arguments,call_id} 没有 encrypted_function_args（自定义 provider 出站清理删掉 marker）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLABORATION_TOOLS,
  validateCodexResponsesEnvelope,
  buildToolPlan,
  projectOrderedHistory,
  restoreToolItem,
  restoreResponseJson,
} from '../../../src/codex-responses.js'

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
      namespace: patch.namespace || 'collaboration',
    },
  }
}

function encryptedMessage(description) {
  return { type: 'string', description, encrypted: true }
}

function fnTool(name, properties, required) {
  return { type: 'function', name, description: name + ' tool', parameters: { type: 'object', properties, required } }
}

// 真实抓线的 6 个 collaboration function（顺序按抓线），仅三个带 message。
function collaborationNamespace() {
  return {
    type: 'namespace',
    name: 'collaboration',
    description: 'native collaboration tools',
    tools: [
      fnTool('followup_task', { target: { type: 'string' }, message: encryptedMessage('Message text') }, ['target', 'message']),
      fnTool('interrupt_agent', { target: { type: 'string' } }, ['target']),
      fnTool('list_agents', {}, []),
      fnTool('send_message', { target: { type: 'string' }, message: encryptedMessage('Message text') }, ['target', 'message']),
      fnTool('spawn_agent', { task_name: { type: 'string' }, message: encryptedMessage('Task text') }, ['task_name', 'message']),
      fnTool('wait_agent', {}, []),
    ],
  }
}

const flatSpawn = { type: 'function', name: 'spawn_agent', description: 'ordinary spawn', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }
const flatShell = { type: 'function', name: 'shell', description: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

function declByName(plan, name) {
  return (plan.declarations || []).find((d) => d.name === name)
}

test('COLLABORATION_TOOLS 固定为三个原生协作工具', () => {
  assert.deepEqual(COLLABORATION_TOOLS, ['spawn_agent', 'send_message', 'followup_task'])
})

// —— §4.1 validateCodexResponsesEnvelope ——

test('信封校验：合法字符串/数组 input 通过且不误拒 agent_message/reasoning/namespace', () => {
  const withHistory = validateCodexResponsesEnvelope({
    model: 'codex-deepseek',
    input: [
      { type: 'agent_message', author: '/root', recipient: '/root/w', content: [{ type: 'input_text', text: 'x' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'opaque' },
    ],
    tools: [collaborationNamespace()],
    stream: true,
  })
  assert.deepEqual(withHistory, { ok: true, lossy: [], rejected: null })
  assert.deepEqual(validateCodexResponsesEnvelope({ model: 'm', input: 'hi' }), { ok: true, lossy: [], rejected: null })
  assert.deepEqual(validateCodexResponsesEnvelope({ model: 'm', input: [] }), { ok: true, lossy: [], rejected: null })
})

test('信封校验：model 缺失/非字符串、input 非法 → invalid_envelope', () => {
  for (const body of [{ input: 'hi' }, { model: '', input: 'hi' }, { model: 7, input: 'hi' }]) {
    const r = validateCodexResponsesEnvelope(body)
    assert.equal(r.ok, false)
    assert.equal(r.rejected.code, 'invalid_envelope')
    assert.ok(Array.isArray(r.lossy))
  }
  const badInput = validateCodexResponsesEnvelope({ model: 'm', input: 42 })
  assert.equal(badInput.ok, false)
  assert.equal(badInput.rejected.code, 'invalid_envelope')
})

test('信封校验：store/background/previous_response_id/truncation 显式拒绝', () => {
  const cases = [
    { model: 'm', input: 'hi', store: true },
    { model: 'm', input: 'hi', background: true },
    { model: 'm', input: 'hi', previous_response_id: 'resp_1' },
    { model: 'm', input: 'hi', truncation: 'auto' },
  ]
  for (const body of cases) {
    const r = validateCodexResponsesEnvelope(body)
    assert.equal(r.ok, false)
    assert.equal(r.rejected.code, 'unsupported_parameter')
  }
  // store=false / truncation=disabled 合法
  assert.equal(validateCodexResponsesEnvelope({ model: 'm', input: 'hi', store: false, truncation: 'disabled' }).ok, true)
})

test('信封校验：include 仅接受可丢弃项并记 lossy，其它显式拒绝', () => {
  const ok = validateCodexResponsesEnvelope({ model: 'm', input: 'hi', include: ['reasoning.encrypted_content', 'output_text.logprobs'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.lossy, ['include_dropped:reasoning.encrypted_content,output_text.logprobs'])
  const bad = validateCodexResponsesEnvelope({ model: 'm', input: 'hi', include: ['message.output_text'] })
  assert.equal(bad.ok, false)
  assert.equal(bad.rejected.code, 'unsupported_parameter')
})

// —— §4.1 buildToolPlan / §5.1 声明投影 ——

test('声明投影：真 namespace 抓线扁平化，三个工具删 message.encrypted，其余原样', () => {
  const tools = [collaborationNamespace()]
  const snapshot = structuredClone(tools)
  deepFreeze(tools)
  const { plan, lossy, rejected } = buildToolPlan(tools, makeRoute())
  assert.equal(rejected, null)
  assert.deepEqual(lossy, [])
  assert.equal(plan.declarations.length, 6, 'namespace 分组被扁平化为 6 个普通 function')
  assert.ok(plan.declared instanceof Map)
  assert.equal(plan.declared.size, 6)
  assert.equal(plan.lossy, lossy, 'plan.lossy 与外层 lossy 同一清单')

  for (const name of ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent']) {
    const decl = declByName(plan, name)
    assert.ok(decl, 'declaration 存在: ' + name)
    assert.equal(decl.type, 'function')
    assert.equal(decl.namespace, undefined, '扁平声明不带 namespace 字段')
    assert.equal(plan.declared.get(name).kind, 'namespace')
    assert.equal(plan.declared.get(name).namespace, 'collaboration')
    assert.equal(plan.declared.get(name).name, name)
    assert.equal(plan.declared.get(name).restoredName, name)
  }
  for (const name of COLLABORATION_TOOLS) {
    const message = declByName(plan, name).parameters.properties.message
    assert.equal(message.type, 'string', name + ' 的 message 是普通 string')
    assert.equal(Object.prototype.hasOwnProperty.call(message, 'encrypted'), false)
    assert.equal(plan.declared.get(name).messagePlaintext, true)
  }
  for (const name of ['interrupt_agent', 'list_agents', 'wait_agent']) {
    assert.equal(plan.declared.get(name).messagePlaintext, false)
    assert.equal(declByName(plan, name).parameters.properties.message, undefined)
  }
  assert.deepEqual(tools, snapshot, '不修改传入的 tools')
  assert.equal(plan.toolChoice, undefined)
})

test('声明投影：tools 缺省 → declared 空 Map、declarations/toolChoice undefined', () => {
  const { plan, rejected } = buildToolPlan(undefined, makeRoute())
  assert.equal(rejected, null)
  assert.ok(plan.declared instanceof Map)
  assert.equal(plan.declared.size, 0)
  assert.equal(plan.declarations, undefined)
  assert.equal(plan.toolChoice, undefined)
  assert.deepEqual(plan.lossy, [])
})

test('声明投影：tools 为空数组与非数组形状', () => {
  const empty = buildToolPlan([], makeRoute())
  assert.equal(empty.rejected, null)
  assert.deepEqual(empty.plan.declarations, [])
  const bad = buildToolPlan('not-an-array', makeRoute())
  assert.equal(bad.plan, null)
  assert.equal(bad.rejected.code, 'invalid_tools')
})

test('声明投影：plaintextTools=false 时 namespace 原样，不建立明文映射', () => {
  const tools = [collaborationNamespace()]
  const { plan, rejected } = buildToolPlan(tools, makeRoute({ plaintextTools: false }))
  assert.equal(rejected, null)
  assert.deepEqual(plan.declarations, tools)
  assert.equal(plan.declared.size, 0)
})

test('声明投影：同名普通 function 冲突使用 <namespace>__<name> 别名，且确定性可逆', () => {
  const route = makeRoute()
  const a = buildToolPlan([flatSpawn, collaborationNamespace()], route)
  const b = buildToolPlan([collaborationNamespace(), flatSpawn], route)
  assert.equal(a.rejected, null)
  assert.equal(b.rejected, null)
  assert.equal(a.plan.declared.get('spawn_agent').kind, 'function', '普通函数保留原名')
  const aliasEntry = a.plan.declared.get('collaboration__spawn_agent')
  assert.ok(aliasEntry, 'namespace 工具改用别名')
  assert.equal(aliasEntry.kind, 'namespace')
  assert.equal(aliasEntry.name, 'spawn_agent')
  assert.equal(aliasEntry.restoredName, 'spawn_agent')
  assert.equal(declByName(a.plan, 'collaboration__spawn_agent').parameters.properties.message.type, 'string')
  assert.equal(Object.prototype.hasOwnProperty.call(declByName(a.plan, 'collaboration__spawn_agent').parameters.properties.message, 'encrypted'), false)
  // 声明顺序变化不影响映射集合
  assert.deepEqual([...a.plan.declared.entries()].sort(), [...b.plan.declared.entries()].sort())
})

test('声明投影：重复普通工具名/别名再冲突 → tool_identity_conflict', () => {
  const dup = buildToolPlan([flatShell, fnTool('shell', {}, [])], makeRoute())
  assert.equal(dup.plan, null)
  assert.equal(dup.rejected.code, 'tool_identity_conflict')
  const aliasClash = buildToolPlan([
    flatSpawn,
    { type: 'function', name: 'collaboration__spawn_agent', description: 'occupied', parameters: { type: 'object', properties: {} } },
    collaborationNamespace(),
  ], makeRoute())
  assert.equal(aliasClash.plan, null)
  assert.equal(aliasClash.rejected.code, 'tool_identity_conflict')
})

test('tool_choice：字符串透传、function 映射别名、allowed_tools 逐项映射', () => {
  const tools = [flatSpawn, collaborationNamespace()]
  const route = makeRoute()
  const requestLike = buildToolPlan({ tools, tool_choice: { type: 'function', name: 'spawn_agent', namespace: 'collaboration' } }, route)
  assert.equal(requestLike.rejected, null)
  assert.deepEqual(requestLike.plan.toolChoice, { type: 'function', name: 'collaboration__spawn_agent' })
  const thirdArg = buildToolPlan(tools, route, 'required')
  assert.equal(thirdArg.plan.toolChoice, 'required')
  const allowed = buildToolPlan({ tools, tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'spawn_agent', namespace: 'collaboration' }, { type: 'function', name: 'shell' }] } }, route)
  assert.equal(allowed.rejected, null)
  assert.deepEqual(allowed.plan.toolChoice.tools, [
    { type: 'function', name: 'collaboration__spawn_agent' },
    { type: 'function', name: 'shell' },
  ])
  const unmapped = buildToolPlan(tools, route, { type: 'mcp', server: 'x' })
  assert.equal(unmapped.rejected, null)
  assert.deepEqual(unmapped.plan.toolChoice, { type: 'mcp', server: 'x' })
  assert.ok(unmapped.plan.lossy.includes('tool_choice_unmapped'))
})

// —— projectOrderedHistory：agent_message 三态 ——

const REAL_AGENT_MESSAGE = {
  type: 'agent_message',
  id: 'amsg_01',
  author: '/root',
  recipient: '/root/worker',
  content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n做点什么' }],
}

test('agent_message=project：真实抓线形状投影为 user message，保留正文与方向前缀', () => {
  const input = [REAL_AGENT_MESSAGE, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }]
  const snapshot = structuredClone(input)
  deepFreeze(input)
  const r = projectOrderedHistory(input, makeRoute(), null)
  assert.equal(r.rejected, null)
  assert.equal(r.input.length, 2)
  assert.deepEqual(r.input[0], {
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_text',
      text: '[agent_message from=/root to=/root/worker]\nMessage Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n做点什么',
    }],
  })
  assert.deepEqual(r.input[1], input[1])
  assert.ok(r.lossy.includes('agent_message_projected'))
  assert.deepEqual(input, snapshot, '不修改原始 input')
})

test('agent_message=project：unicode/emoji/组合字符、多 part、空正文、方向字段缺失', () => {
  const multi = {
    type: 'agent_message', author: '/root', recipient: '/root/worker',
    content: [{ type: 'input_text', text: '你好，世界' }, { type: 'text', text: '🌏' }, { type: 'input_text', text: 'e\u0301' }],
  }
  const r = projectOrderedHistory([multi], makeRoute(), null)
  assert.equal(r.rejected, null)
  assert.equal(r.input[0].content[0].text, '[agent_message from=/root to=/root/worker]\n你好，世界🌏e\u0301')

  const empty = projectOrderedHistory([{ type: 'agent_message', author: '/root', recipient: '/root/w', content: [] }], makeRoute(), null)
  assert.equal(empty.rejected, null)
  assert.equal(empty.input[0].content[0].text, '[agent_message from=/root to=/root/w]\n')

  const noAuthor = projectOrderedHistory([{ type: 'agent_message', recipient: '/root/w', content: [{ type: 'input_text', text: 'body' }] }], makeRoute(), null)
  assert.equal(noAuthor.rejected, null)
  assert.equal(noAuthor.input[0].content[0].text, 'body', 'author 缺失时省略整个方向前缀')
  const noRecipient = projectOrderedHistory([{ type: 'agent_message', author: '/root', content: [{ type: 'input_text', text: 'body' }] }], makeRoute(), null)
  assert.equal(noRecipient.input[0].content[0].text, 'body')
})

test('agent_message=preserve：原样保留（含 encrypted_content），reasoning=preserve 原样', () => {
  const input = [
    { type: 'agent_message', author: '/root', recipient: '/root/w', content: [{ type: 'input_text', text: 'x' }], internal_chat_message_metadata_passthrough: { a: 1 } },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'cipher' },
  ]
  const r = projectOrderedHistory(input, makeRoute({ history: { agentMessage: 'preserve', reasoning: 'preserve' } }), null)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.input, input)
  assert.deepEqual(r.lossy, [])
})

test('agent_message=reject → agent_message_unsupported', () => {
  const r = projectOrderedHistory([REAL_AGENT_MESSAGE], makeRoute({ history: { agentMessage: 'reject' } }), null)
  assert.equal(r.input, null)
  assert.equal(r.rejected.code, 'agent_message_unsupported')
})

test('agent_message 非明文证据：encrypted_content/未知字段/非字符串正文 → opaque_agent_message', () => {
  const cases = [
    { ...REAL_AGENT_MESSAGE, encrypted_content: 'ciphertext' },
    { ...REAL_AGENT_MESSAGE, signature: 'opaque' },
    { ...REAL_AGENT_MESSAGE, content: [{ type: 'input_text', text: 42 }] },
    { ...REAL_AGENT_MESSAGE, content: [{ type: 'input_image', image_url: 'x' }] },
    { ...REAL_AGENT_MESSAGE, author: { id: '/root' } },
  ]
  for (const item of cases) {
    const r = projectOrderedHistory([item], makeRoute(), null)
    assert.equal(r.input, null)
    assert.equal(r.rejected.code, 'opaque_agent_message')
    assert.equal(r.lossy.includes('agent_message_projected'), false)
  }
  // 空 encrypted_content 不算密文，但该字段会被丢弃
  const emptyCipher = projectOrderedHistory([{ ...REAL_AGENT_MESSAGE, encrypted_content: '' }], makeRoute(), null)
  assert.equal(emptyCipher.rejected, null)
  assert.equal(emptyCipher.input[0].type, 'message')
})

// —— reasoning / compaction / 未知 item ——

test('reasoning=drop：省略并记 reasoning_dropped；reasoning=reject：reasoning_unsupported', () => {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }], encrypted_content: 'cipher' },
  ]
  const dropped = projectOrderedHistory(input, makeRoute({ history: { reasoning: 'drop' } }), null)
  assert.equal(dropped.rejected, null)
  assert.deepEqual(dropped.input, [input[0]])
  assert.deepEqual(dropped.lossy, ['reasoning_dropped'])
  const rejected = projectOrderedHistory(input, makeRoute({ history: { reasoning: 'reject' } }), null)
  assert.equal(rejected.input, null)
  assert.equal(rejected.rejected.code, 'reasoning_unsupported')
})

test('compaction：默认 reject → unsupported_input_item；drop → 省略并记 compaction_dropped', () => {
  const input = [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'x' }]
  const rejected = projectOrderedHistory(input, makeRoute(), null)
  assert.equal(rejected.input, null)
  assert.equal(rejected.rejected.code, 'unsupported_input_item')
  const dropped = projectOrderedHistory(input, makeRoute({ history: { compaction: 'drop' } }), null)
  assert.equal(dropped.rejected, null)
  assert.deepEqual(dropped.input, [])
  assert.deepEqual(dropped.lossy, ['compaction_dropped'])
})

test('未知 item 类型 → unsupported_input_item；message 外层 role（含 developer）原样保留', () => {
  const unknown = projectOrderedHistory([{ type: 'web_search_call', id: 'ws_1' }], makeRoute(), null)
  assert.equal(unknown.input, null)
  assert.equal(unknown.rejected.code, 'unsupported_input_item')
  const messages = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    { type: 'message', role: 'user', content: 'plain' },
  ]
  const r = projectOrderedHistory(messages, makeRoute(), null)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.input, messages)
})

// —— 工具配对 / 历史名字投影 ——

test('历史工具：按 call_id 配对、保持顺序、namespace 工具映射为扁平名并去掉目标不认识的字段', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    { type: 'function_call', status: 'completed', id: 'fc_1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"task_name":"worker","message":"do it"}', call_id: 'call_spawn_1' },
    { type: 'function_call_output', call_id: 'call_spawn_1', output: 'done' },
    { type: 'custom_tool_call', status: 'completed', id: 'ctc_1', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call_patch_1' },
    { type: 'custom_tool_call_output', call_id: 'call_patch_1', output: 'ok' },
  ]
  const snapshot = structuredClone(input)
  deepFreeze(input)
  const r = projectOrderedHistory(input, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.equal(r.input.length, 5, '顺序与数量不变')
  assert.deepEqual(r.input[1], {
    type: 'function_call', status: 'completed', id: 'fc_1', name: 'spawn_agent',
    arguments: '{"task_name":"worker","message":"do it"}', call_id: 'call_spawn_1',
  }, '缺失 marker 的真实历史项按普通历史处理：不补 marker')
  assert.equal(Object.prototype.hasOwnProperty.call(r.input[1], 'namespace'), false)
  assert.deepEqual(r.input[2], { type: 'function_call_output', call_id: 'call_spawn_1', output: 'done' })
  assert.deepEqual(r.input[3], input[3])
  assert.deepEqual(r.input[4], input[4])
  assert.deepEqual(input, snapshot, '不修改原始 input')
})

test('历史工具：别名反查（namespace 工具 → <namespace>__<name>）', () => {
  const plan = buildToolPlan([flatSpawn, collaborationNamespace()], makeRoute()).plan
  const input = [
    { type: 'function_call', status: 'completed', name: 'spawn_agent', namespace: 'collaboration', arguments: '{}', call_id: 'c1' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ]
  const r = projectOrderedHistory(input, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.equal(r.input[0].name, 'collaboration__spawn_agent')
  assert.equal(Object.prototype.hasOwnProperty.call(r.input[0], 'namespace'), false)
})

test('工具配对：缺失 call_id、孤立 output、重复 call、kind 不匹配 → tool_call_pairing', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const cases = [
    [{ type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: '{}' }],
    [{ type: 'function_call_output', call_id: 'missing', output: 'x' }],
    [
      { type: 'function_call', call_id: 'dup', name: 'spawn_agent', namespace: 'collaboration', arguments: '{}' },
      { type: 'function_call', call_id: 'dup', name: 'send_message', namespace: 'collaboration', arguments: '{}' },
    ],
    [
      { type: 'function_call', call_id: 'k1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{}' },
      { type: 'custom_tool_call_output', call_id: 'k1', output: 'x' },
    ],
  ]
  for (const input of cases) {
    const r = projectOrderedHistory(input, makeRoute(), plan)
    assert.equal(r.input, null)
    assert.equal(r.rejected.code, 'tool_call_pairing')
  }
})

test('历史工具：同名歧义（无 namespace 且普通函数与 namespace 工具同名）→ tool_call_pairing', () => {
  const plan = buildToolPlan([flatSpawn, collaborationNamespace()], makeRoute()).plan
  const r = projectOrderedHistory([
    { type: 'function_call', status: 'completed', name: 'spawn_agent', arguments: '{}', call_id: 'c1' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ], makeRoute(), plan)
  assert.equal(r.input, null)
  assert.equal(r.rejected.code, 'tool_call_pairing')
})

test('历史工具：非空 encrypted_function_args → opaque_function_args，绝不猜测', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const r = projectOrderedHistory([
    { type: 'function_call', status: 'completed', name: 'spawn_agent', namespace: 'collaboration', arguments: '{}', call_id: 'c1', encrypted_function_args: ['cipher'] },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ], makeRoute(), plan)
  assert.equal(r.input, null)
  assert.equal(r.rejected.code, 'opaque_function_args')
})

// —— §5.1 marker 七态矩阵（restoreToolItem） ——

test('marker 矩阵 1：缺失 marker 的普通函数调用原样，不补 namespace/marker', () => {
  const plan = buildToolPlan([flatShell], makeRoute()).plan
  const item = { type: 'function_call', status: 'completed', id: 'fc_1', call_id: 'c1', name: 'shell', arguments: '{}' }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, item)
})

test('marker 矩阵 2：null → 原样，不补（未声明语义）', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const item = { type: 'function_call', status: 'completed', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: null }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, item)
  assert.equal(r.item.namespace, undefined)
})

test('marker 矩阵 3：[] + 本轮明文声明 → 恢复 namespace/name 并补 [] 幂等', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const item = { type: 'function_call', status: 'completed', id: 'fc_1', call_id: 'call_1', name: 'send_message', arguments: '{"target":"/root","message":"hi"}', encrypted_function_args: [] }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, {
    type: 'function_call', status: 'completed', id: 'fc_1', call_id: 'call_1', name: 'send_message',
    namespace: 'collaboration', arguments: '{"target":"/root","message":"hi"}', encrypted_function_args: [],
  })
  assert.equal(r.item.call_id, item.call_id)
  assert.equal(r.item.arguments, item.arguments)
})

test('marker 矩阵 4：[] 但工具未声明 → 伪造 marker，不补、身份不变', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const undeclared = { type: 'function_call', status: 'completed', call_id: 'c1', name: 'shell', arguments: '{}', encrypted_function_args: [] }
  assert.deepEqual(restoreToolItem(undeclared, makeRoute(), plan).item, undeclared)
  // 声明为普通 function（不是三工具）同样不补
  const ordinaryPlan = buildToolPlan([flatSpawn], makeRoute()).plan
  const ordinary = { type: 'function_call', status: 'completed', call_id: 'c2', name: 'spawn_agent', arguments: '{}', encrypted_function_args: [] }
  assert.deepEqual(restoreToolItem(ordinary, makeRoute(), ordinaryPlan).item, ordinary)
})

test('marker 矩阵 5：非空数组 → opaque_function_args', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const item = { type: 'function_call', status: 'completed', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: ['cipher'] }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.item, null)
  assert.equal(r.rejected.code, 'opaque_function_args')
  // 非数组同样不可判定
  const weird = restoreToolItem({ ...item, encrypted_function_args: 'cipher' }, makeRoute(), plan)
  assert.equal(weird.rejected.code, 'opaque_function_args')
  // 6 个 namespace 工具同规则：wait_agent 的非空 marker 也显式失败
  const nonMessage = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c2', name: 'wait_agent', arguments: '{}', encrypted_function_args: ['cipher'] }, makeRoute(), plan)
  assert.equal(nonMessage.item, null)
  assert.equal(nonMessage.rejected.code, 'opaque_function_args')
})

test('marker 矩阵 6：非 collaboration namespace 不参与明文判定，原样返回', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const item = { type: 'function_call', status: 'completed', call_id: 'c1', name: 'spawn_agent', namespace: 'legacy_ns', arguments: '{}', encrypted_function_args: [] }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, item)
})

test('marker 矩阵 7：普通函数（无协作身份）不参与恢复', () => {
  const plan = buildToolPlan([flatShell], makeRoute()).plan
  const item = { type: 'function_call', status: 'completed', id: 'fc_9', call_id: 'c9', name: 'shell', arguments: '{"cmd":"ls"}' }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, item)
})

test('完成项恢复：本轮明文声明的三工具在缺失 marker 时补 []，call_id/arguments 原样', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const item = { type: 'function_call', status: 'completed', id: 'fc_up', call_id: 'call_up', name: 'spawn_agent', arguments: '{"task_name":"w","message":"m"}' }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, {
    type: 'function_call', status: 'completed', id: 'fc_up', call_id: 'call_up', name: 'spawn_agent',
    namespace: 'collaboration', arguments: '{"task_name":"w","message":"m"}', encrypted_function_args: [],
  })
})

test('added/in_progress：只恢复身份/namespace，不补 encrypted_function_args', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const item = { type: 'function_call', status: 'in_progress', id: 'fc_up', call_id: 'call_up', name: 'send_message', arguments: '{"target":"/root","message":"hi"}' }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.equal(r.item.namespace, 'collaboration')
  assert.equal(r.item.name, 'send_message')
  assert.equal(Object.prototype.hasOwnProperty.call(r.item, 'encrypted_function_args'), false)
})

test('6 个 namespace 工具完成项全部恢复 namespace；仅三个消息工具补 encrypted_function_args: []', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  assert.equal(plan.declared.size, 6, 'plan.declared 必须覆盖全部 6 个 namespace 工具')
  // 反例→正例：exec_command 不带 namespace；wait_agent 等必须带
  for (const [name, args] of [
    ['spawn_agent', '{"task_name":"w","message":"m"}'],
    ['send_message', '{"target":"/root","message":"hi"}'],
    ['followup_task', '{"target":"/root","message":"hi"}'],
  ]) {
    const r = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c_' + name, name, arguments: args }, makeRoute(), plan)
    assert.equal(r.rejected, null)
    assert.equal(r.item.namespace, 'collaboration', name + ' 恢复 namespace')
    assert.equal(r.item.name, name)
    assert.deepEqual(r.item.encrypted_function_args, [], name + ' 是明文消息工具，补 []')
    assert.equal(r.item.arguments, args)
  }
  for (const name of ['wait_agent', 'list_agents', 'interrupt_agent']) {
    const args = name === 'interrupt_agent' ? '{"target":"/root/w"}' : '{}'
    const r = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c_' + name, name, arguments: args }, makeRoute(), plan)
    assert.equal(r.rejected, null)
    assert.equal(r.item.namespace, 'collaboration', name + ' 必须恢复 namespace（否则 Codex unsupported call）')
    assert.equal(r.item.name, name)
    assert.equal(Object.prototype.hasOwnProperty.call(r.item, 'encrypted_function_args'), false, name + ' 不得携带 marker')
    // 上游即使给出 [] 也必须删除该字段
    const forged = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c2_' + name, name, arguments: args, encrypted_function_args: [] }, makeRoute(), plan)
    assert.equal(forged.rejected, null)
    assert.equal(forged.item.namespace, 'collaboration')
    assert.equal(Object.prototype.hasOwnProperty.call(forged.item, 'encrypted_function_args'), false)
  }
})

test('普通 function 完成项绝不添加 namespace：exec_command / read_file 保持纯净', () => {
  const execTool = { type: 'function', name: 'exec_command', description: 'exec', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }
  const readTool = { type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  const plan = buildToolPlan([execTool, readTool, collaborationNamespace()], makeRoute()).plan
  const items = [
    { type: 'function_call', status: 'completed', id: 'fc_exec', call_id: 'call_exec', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    { type: 'function_call', status: 'completed', id: 'fc_read', call_id: 'call_read', name: 'read_file', arguments: '{"path":"README.md"}' },
  ]
  for (const item of items) {
    const r = restoreToolItem(item, makeRoute(), plan)
    assert.equal(r.rejected, null)
    assert.deepEqual(r.item, item)
    assert.equal(Object.prototype.hasOwnProperty.call(r.item, 'namespace'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(r.item, 'encrypted_function_args'), false)
  }
})

test('恢复：同名冲突下普通函数调用不被误认成 namespace 工具', () => {
  const plan = buildToolPlan([flatSpawn, collaborationNamespace()], makeRoute()).plan
  const ordinary = { type: 'function_call', status: 'completed', call_id: 'c_ordinary', name: 'spawn_agent', arguments: '{"prompt":"p"}' }
  const r = restoreToolItem(ordinary, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, ordinary, '普通调用不带 namespace / marker')
  const namespaced = { type: 'function_call', status: 'completed', call_id: 'c_namespaced', name: 'collaboration__spawn_agent', arguments: '{"task_name":"w","message":"m"}' }
  const restored = restoreToolItem(namespaced, makeRoute(), plan)
  assert.equal(restored.rejected, null)
  assert.equal(restored.item.name, 'spawn_agent')
  assert.equal(restored.item.namespace, 'collaboration')
  assert.deepEqual(restored.item.encrypted_function_args, [])
})

test('已恢复项幂等；别名回原名；未知字段/非字符串参数/非法 JSON → opaque_function_args', () => {
  const plan = buildToolPlan([flatSpawn, collaborationNamespace()], makeRoute()).plan
  const restored = { type: 'function_call', status: 'completed', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"task_name":"w","message":"m"}', encrypted_function_args: [] }
  const r = restoreToolItem(restored, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, restored)

  const aliasItem = { type: 'function_call', status: 'completed', call_id: 'c2', name: 'collaboration__spawn_agent', arguments: '{}' }
  const aliased = restoreToolItem(aliasItem, makeRoute(), plan)
  assert.equal(aliased.rejected, null)
  assert.equal(aliased.item.name, 'spawn_agent')
  assert.equal(aliased.item.namespace, 'collaboration')

  // 未与普通函数同名的干净 plan：非命名空间项才确定被认领为协作工具
  const cleanPlan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const unknownField = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c3', name: 'spawn_agent', arguments: '{}', signature: 'x' }, makeRoute(), cleanPlan)
  assert.equal(unknownField.item, null)
  assert.equal(unknownField.rejected.code, 'opaque_function_args')
  const nonStringArgs = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c4', name: 'spawn_agent', arguments: { task_name: 'w' } }, makeRoute(), cleanPlan)
  assert.equal(nonStringArgs.rejected.code, 'opaque_function_args')
  const badJson = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c5', name: 'spawn_agent', arguments: 'not-json' }, makeRoute(), cleanPlan)
  assert.equal(badJson.rejected.code, 'opaque_function_args')
})

test('spawn_agent 真实参数（task_name/message/model/reasoning_effort/fork_turns）原样往返，不注入 agent_type', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const args = JSON.stringify({ task_name: 'worker', message: '做点什么', model: 'codex-deepseek', reasoning_effort: 'high', fork_turns: 'none' })
  const responseItem = { type: 'function_call', status: 'completed', id: 'fc_spawn', call_id: 'call_spawn', name: 'spawn_agent', arguments: args }
  const restored = restoreToolItem(responseItem, makeRoute(), plan)
  assert.equal(restored.rejected, null)
  assert.equal(restored.item.arguments, args)
  assert.equal(restored.item.call_id, 'call_spawn')
  assert.deepEqual(JSON.parse(restored.item.arguments), {
    task_name: 'worker', message: '做点什么', model: 'codex-deepseek', reasoning_effort: 'high', fork_turns: 'none',
  })
  assert.equal('agent_type' in JSON.parse(restored.item.arguments), false)
  const history = [
    { type: 'function_call', status: 'completed', name: 'spawn_agent', namespace: 'collaboration', arguments: args, call_id: 'call_spawn' },
    { type: 'function_call_output', call_id: 'call_spawn', output: 'ok' },
  ]
  const projected = projectOrderedHistory(history, makeRoute(), plan)
  assert.equal(projected.rejected, null)
  assert.equal(projected.item, undefined)
  assert.equal(projected.input[0].arguments, args)
  assert.equal(projected.input[0].call_id, 'call_spawn')
})

test('历史回放幂等：带 namespace、无 marker 的协作项保留正文/参数，不补 marker、不报错', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const history = [
    { type: 'function_call', status: 'completed', id: 'fc_1', name: 'send_message', namespace: 'collaboration', arguments: '{"target":"/root","message":"hi"}', call_id: 'c1' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ]
  const once = projectOrderedHistory(history, makeRoute(), plan)
  assert.equal(once.rejected, null)
  assert.equal(Object.prototype.hasOwnProperty.call(once.input[0], 'encrypted_function_args'), false)
  assert.equal(once.input[0].arguments, history[0].arguments)
  const twice = projectOrderedHistory(once.input, makeRoute(), plan)
  assert.equal(twice.rejected, null)
  assert.deepEqual(twice.input, once.input)
})

test('历史回放：6 个 namespace 工具统一映射为扁平名并剥离 marker/namespace', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const history = [
    { type: 'function_call', status: 'completed', name: 'wait_agent', namespace: 'collaboration', arguments: '{}', call_id: 'c_wait', encrypted_function_args: [] },
    { type: 'function_call_output', call_id: 'c_wait', output: 'ok' },
  ]
  const r = projectOrderedHistory(history, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.input[0], { type: 'function_call', status: 'completed', name: 'wait_agent', arguments: '{}', call_id: 'c_wait' })
})

test('restore：custom_tool_call 原样返回（custom 工具不参与 namespace/marker 恢复）', () => {
  const plan = buildToolPlan([{ type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'text' } }, collaborationNamespace()], makeRoute()).plan
  const item = { type: 'custom_tool_call', status: 'completed', id: 'ctc_1', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' }
  const r = restoreToolItem(item, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.deepEqual(r.item, item)
  assert.equal(r.item.namespace, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(r.item, 'encrypted_function_args'), false)
})

// —— restoreResponseJson ——

test('restoreResponseJson：output[] 逐项恢复、model 不回写、其它字段保留、不修改入参', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const json = {
    id: 'resp_up', object: 'response', created_at: 1700000000, status: 'completed', model: 'deepseek-v4-pro',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'function_call', id: 'fc_up', status: 'completed', call_id: 'call_up', name: 'send_message', arguments: '{"target":"/root","message":"hi"}' },
      { type: 'function_call', id: 'fc_shell', status: 'completed', call_id: 'call_shell', name: 'shell', arguments: '{"cmd":"ls"}' },
    ],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  }
  const snapshot = structuredClone(json)
  deepFreeze(json)
  const r = restoreResponseJson(json, makeRoute(), plan)
  assert.equal(r.rejected, null)
  assert.equal(r.json.model, 'deepseek-v4-pro', 'model 由调用方处理，不回写')
  assert.deepEqual(r.json.usage, json.usage)
  assert.equal(r.json.output[1].namespace, 'collaboration')
  assert.deepEqual(r.json.output[1].encrypted_function_args, [])
  assert.deepEqual(r.json.output[2], json.output[2])
  assert.deepEqual(json, snapshot, '不修改原始响应')
})

test('restoreResponseJson：任一 item 被拒 → json=null 且错误上抛', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const json = {
    id: 'resp_up', model: 'm', output: [
      { type: 'function_call', status: 'completed', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: ['cipher'] },
    ],
  }
  const r = restoreResponseJson(json, makeRoute(), plan)
  assert.equal(r.json, null)
  assert.equal(r.rejected.code, 'opaque_function_args')
})
