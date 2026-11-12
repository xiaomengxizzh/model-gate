// P02: Codex 原生 V2 请求分类 / 有序历史 / 工具身份恢复（定向移植 7afb4dc）。
// 纯离线：不执行 CLI、不联网、不读 HOME/auth/真实会话。适配说明见 src/codex/interop.js 与
// src/responses.js 的 prepareCodexNativeRequest；控制项分类沿用 A1 codex-control-items 的口径。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLABORATION_TOOLS,
  CODEX_MAX_INPUT_ITEMS,
  classifyCodexInputItem,
  validateCodexResponsesEnvelope,
  buildToolPlan,
  projectOrderedHistory,
  restoreToolItem,
  restoreResponseJson,
} from '../../../src/codex/interop.js'
import { prepareCodexNativeRequest } from '../../../src/responses.js'

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

const REAL_AGENT_MESSAGE = {
  type: 'agent_message',
  id: 'amsg_01',
  author: '/root',
  recipient: '/root/worker',
  content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n做点什么' }],
}

test('P02 COLLABORATION_TOOLS 固定为三个原生协作工具', () => {
  assert.deepEqual(COLLABORATION_TOOLS, ['spawn_agent', 'send_message', 'followup_task'])
})

test('P02 信封：合法 input 通过，不误拒 agent_message/reasoning/namespace', () => {
  const ok = validateCodexResponsesEnvelope({
    model: 'codex-deepseek',
    input: [
      { type: 'agent_message', author: '/root', recipient: '/root/w', content: [{ type: 'input_text', text: 'x' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'opaque' },
    ],
    tools: [collaborationNamespace()],
    stream: true,
  })
  assert.deepEqual(ok, { ok: true, lossy: [], rejected: null })
  assert.equal(validateCodexResponsesEnvelope({ model: 'm', input: 'hi' }).ok, true)
  assert.equal(validateCodexResponsesEnvelope({ model: 'm', input: [] }).ok, true)
})

test('P02 信封：model/input 非法 → invalid_envelope', () => {
  for (const body of [{ input: 'hi' }, { model: '', input: 'hi' }, { model: 7, input: 'hi' }, { model: 'm', input: 42 }]) {
    const r = validateCodexResponsesEnvelope(body)
    assert.equal(r.ok, false)
    assert.equal(r.rejected.code, 'invalid_envelope')
    assert.ok(Array.isArray(r.lossy))
  }
})

test('P02 信封：store/background/previous_response_id/truncation 显式拒绝', () => {
  for (const body of [
    { model: 'm', input: 'hi', store: true },
    { model: 'm', input: 'hi', background: true },
    { model: 'm', input: 'hi', previous_response_id: 'resp_1' },
    { model: 'm', input: 'hi', truncation: 'auto' },
  ]) {
    const r = validateCodexResponsesEnvelope(body)
    assert.equal(r.ok, false)
    assert.equal(r.rejected.code, 'unsupported_parameter')
  }
  assert.equal(validateCodexResponsesEnvelope({ model: 'm', input: 'hi', store: false, truncation: 'disabled' }).ok, true)
})

test('P02 信封：include 仅接受可丢弃项并记 lossy，其它拒绝', () => {
  const ok = validateCodexResponsesEnvelope({ model: 'm', input: 'hi', include: ['reasoning.encrypted_content', 'output_text.logprobs'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.lossy, ['include_dropped:reasoning.encrypted_content,output_text.logprobs'])
  const bad = validateCodexResponsesEnvelope({ model: 'm', input: 'hi', include: ['message.output_text'] })
  assert.equal(bad.ok, false)
  assert.equal(bad.rejected.code, 'unsupported_parameter')
})

test('P02 声明投影：真实 namespace 扁平化，三消息工具去 encrypted，其余原样', () => {
  const tools = [collaborationNamespace()]
  const snapshot = structuredClone(tools)
  deepFreeze(tools)
  const { plan, lossy, rejected } = buildToolPlan(tools, makeRoute())
  assert.equal(rejected, null)
  assert.deepEqual(lossy, [])
  assert.equal(plan.declarations.length, 6)
  assert.ok(plan.declared instanceof Map)
  assert.equal(plan.declared.size, 6)
  assert.equal(plan.lossy, lossy)
  for (const name of ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent']) {
    const decl = declByName(plan, name)
    assert.ok(decl, 'declaration 存在: ' + name)
    assert.equal(decl.type, 'function')
    assert.equal(decl.namespace, undefined)
    assert.equal(plan.declared.get(name).kind, 'namespace')
    assert.equal(plan.declared.get(name).namespace, 'collaboration')
    assert.equal(plan.declared.get(name).restoredName, name)
  }
  for (const name of COLLABORATION_TOOLS) {
    const message = declByName(plan, name).parameters.properties.message
    assert.equal(message.type, 'string')
    assert.equal(Object.prototype.hasOwnProperty.call(message, 'encrypted'), false)
    assert.equal(plan.declared.get(name).messagePlaintext, true)
  }
  for (const name of ['interrupt_agent', 'list_agents', 'wait_agent']) {
    assert.equal(plan.declared.get(name).messagePlaintext, false)
    assert.equal(declByName(plan, name).parameters.properties.message, undefined)
  }
  assert.deepEqual(tools, snapshot, '不修改传入 tools')
  assert.equal(plan.toolChoice, undefined)
})

test('P02 声明投影：tools 缺省/空数组/非数组', () => {
  const missing = buildToolPlan(undefined, makeRoute())
  assert.equal(missing.rejected, null)
  assert.equal(missing.plan.declared.size, 0)
  assert.equal(missing.plan.declarations, undefined)
  const empty = buildToolPlan([], makeRoute())
  assert.equal(empty.rejected, null)
  assert.deepEqual(empty.plan.declarations, [])
  const bad = buildToolPlan('not-an-array', makeRoute())
  assert.equal(bad.plan, null)
  assert.equal(bad.rejected.code, 'invalid_tools')
})

test('P02 声明投影：plaintextTools=false 时 namespace 原样，不建立明文映射', () => {
  const tools = [collaborationNamespace()]
  const { plan, rejected } = buildToolPlan(tools, makeRoute({ plaintextTools: false }))
  assert.equal(rejected, null)
  assert.deepEqual(plan.declarations, tools)
  assert.equal(plan.declared.size, 0)
})

test('P02 声明投影：同名冲突使用确定性别名，声明顺序不影响映射', () => {
  const route = makeRoute()
  const a = buildToolPlan([flatSpawn, collaborationNamespace()], route)
  const b = buildToolPlan([collaborationNamespace(), flatSpawn], route)
  assert.equal(a.rejected, null)
  assert.equal(b.rejected, null)
  assert.equal(a.plan.declared.get('spawn_agent').kind, 'function')
  const aliasEntry = a.plan.declared.get('collaboration__spawn_agent')
  assert.ok(aliasEntry)
  assert.equal(aliasEntry.kind, 'namespace')
  assert.equal(aliasEntry.name, 'spawn_agent')
  assert.equal(declByName(a.plan, 'collaboration__spawn_agent').parameters.properties.message.type, 'string')
  assert.deepEqual([...a.plan.declared.entries()].sort(), [...b.plan.declared.entries()].sort())
})

test('P02 声明投影：重复名/别名再冲突 → tool_identity_conflict', () => {
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

test('P02 tool_choice：字符串/function/allowed_tools 映射，未知形状记 lossy', () => {
  const tools = [flatSpawn, collaborationNamespace()]
  const route = makeRoute()
  const requestLike = buildToolPlan({ tools, tool_choice: { type: 'function', name: 'spawn_agent', namespace: 'collaboration' } }, route)
  assert.equal(requestLike.rejected, null)
  assert.deepEqual(requestLike.plan.toolChoice, { type: 'function', name: 'collaboration__spawn_agent' })
  assert.equal(buildToolPlan(tools, route, 'required').plan.toolChoice, 'required')
  const allowed = buildToolPlan({ tools, tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'spawn_agent', namespace: 'collaboration' }, { type: 'function', name: 'shell' }] } }, route)
  assert.deepEqual(allowed.plan.toolChoice.tools, [{ type: 'function', name: 'collaboration__spawn_agent' }, { type: 'function', name: 'shell' }])
  const unmapped = buildToolPlan(tools, route, { type: 'mcp', server: 'x' })
  assert.deepEqual(unmapped.plan.toolChoice, { type: 'mcp', server: 'x' })
  assert.ok(unmapped.plan.lossy.includes('tool_choice_unmapped'))
})

test('P02 agent_message=project：真实抓线形状投影为 user message，保留方向前缀', () => {
  const input = [REAL_AGENT_MESSAGE, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }]
  const snapshot = structuredClone(input)
  const { input: out, lossy, rejected } = projectOrderedHistory(input, makeRoute(), buildToolPlan(undefined, makeRoute()).plan)
  assert.equal(rejected, null)
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'message')
  assert.equal(out[0].role, 'user')
  assert.equal(out[0].content[0].type, 'input_text')
  assert.match(out[0].content[0].text, /^\[agent_message from=\/root to=\/root\/worker\]\n/)
  assert.match(out[0].content[0].text, /做点什么/)
  assert.ok(lossy.includes('agent_message_projected'))
  assert.deepEqual(input, snapshot, '不修改入参')
})

test('P02 agent_message=project：unicode 多 part 拼接、空正文、方向字段缺失', () => {
  const plan = buildToolPlan(undefined, makeRoute()).plan
  const multi = projectOrderedHistory([{ type: 'agent_message', author: '/a', recipient: '/b', content: [{ type: 'input_text', text: '你' }, { type: 'text', text: '好🙂' }] }], makeRoute(), plan)
  assert.equal(multi.rejected, null)
  assert.equal(multi.input[0].content[0].text, '[agent_message from=/a to=/b]\n你好🙂')
  const empty = projectOrderedHistory([{ type: 'agent_message', content: [] }], makeRoute(), plan)
  assert.equal(empty.input[0].content[0].text, '')
  const noDirection = projectOrderedHistory([{ type: 'agent_message', content: [{ type: 'input_text', text: 'x' }] }], makeRoute(), plan)
  assert.equal(noDirection.input[0].content[0].text, 'x')
})

test('P02 agent_message：reject/密文/未知字段/非字符串正文 → 发送前拒绝', () => {
  const plan = buildToolPlan(undefined, makeRoute()).plan
  const reject = projectOrderedHistory([REAL_AGENT_MESSAGE], makeRoute({ history: { agentMessage: 'reject' } }), plan)
  assert.equal(reject.rejected.code, 'agent_message_unsupported')
  for (const bad of [
    { type: 'agent_message', content: [{ type: 'input_text', text: 'x' }], encrypted_content: 'CIPHER' },
    { type: 'agent_message', content: [{ type: 'input_text', text: 'x' }], unexpected: true },
    { type: 'agent_message', content: [{ type: 'input_text', text: 7 }] },
    { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'CIPHER' }] },
    { type: 'agent_message', content: 7 },
  ]) {
    const r = projectOrderedHistory([bad], makeRoute(), plan)
    assert.equal(r.rejected.code, 'opaque_agent_message')
    assert.equal(JSON.stringify(r).includes('CIPHER'), false, '拒绝结果不得回显密文')
  }
})

test('P02 reasoning：preserve/drop/reject 三态，密文永远不转文本', () => {
  const reasoning = { type: 'reasoning', summary: [], encrypted_content: 'CIPHER' }
  const plan = buildToolPlan(undefined, makeRoute()).plan
  const preserve = projectOrderedHistory([reasoning], makeRoute({ history: { reasoning: 'preserve' } }), plan)
  assert.equal(preserve.rejected, null)
  assert.deepEqual(preserve.input, [reasoning])
  const drop = projectOrderedHistory([reasoning], makeRoute({ history: { reasoning: 'drop' } }), plan)
  assert.deepEqual(drop.input, [])
  assert.ok(drop.lossy.includes('reasoning_dropped'))
  const reject = projectOrderedHistory([reasoning], makeRoute({ history: { reasoning: 'reject' } }), plan)
  assert.equal(reject.rejected.code, 'reasoning_unsupported')
})

test('P02 compaction：默认 reject → unsupported_input_item；drop → 省略并记 lossy', () => {
  const compaction = { type: 'compaction', summary: 'x' }
  const plan = buildToolPlan(undefined, makeRoute()).plan
  const reject = projectOrderedHistory([compaction], makeRoute(), plan)
  assert.equal(reject.rejected.code, 'unsupported_input_item')
  const drop = projectOrderedHistory([compaction], makeRoute({ history: { compaction: 'drop' } }), plan)
  assert.deepEqual(drop.input, [])
  assert.ok(drop.lossy.includes('compaction_dropped'))
})

test('P02 控制项：显式分类，默认 drop + lossy，可 preserve/reject', () => {
  assert.equal(classifyCodexInputItem({ type: 'configuration_update', model: 'm' }), 'control')
  assert.equal(classifyCodexInputItem({ type: 'additional_tools', tools: [] }), 'control')
  assert.equal(classifyCodexInputItem({ type: 'message', role: 'user' }), 'message')
  assert.equal(classifyCodexInputItem({ type: 'agent_message' }), 'agent_message')
  assert.equal(classifyCodexInputItem({ type: 'reasoning' }), 'reasoning')
  assert.equal(classifyCodexInputItem({ type: 'compaction' }), 'compaction')
  assert.equal(classifyCodexInputItem({ type: 'function_call' }), 'tool_call')
  assert.equal(classifyCodexInputItem({ type: 'function_call_output' }), 'tool_output')
  assert.equal(classifyCodexInputItem({ type: 'item_reference' }), 'opaque_continuation')
  assert.equal(classifyCodexInputItem({ type: 'mystery' }), 'unknown')
  const plan = buildToolPlan(undefined, makeRoute()).plan
  const input = [{ type: 'message', role: 'user', content: 'hi' }, { type: 'configuration_update', model: 'm' }, { type: 'additional_tools', tools: [] }]
  const drop = projectOrderedHistory(input, makeRoute(), plan)
  assert.equal(drop.rejected, null)
  assert.equal(drop.input.length, 1)
  assert.ok(drop.lossy.includes('control_item_dropped:configuration_update'))
  assert.ok(drop.lossy.includes('control_item_dropped:additional_tools'))
  const preserve = projectOrderedHistory(input, makeRoute({ history: { controls: 'preserve' } }), plan)
  assert.equal(preserve.input.length, 3)
  const reject = projectOrderedHistory(input, makeRoute({ history: { controls: 'reject' } }), plan)
  assert.equal(reject.rejected.code, 'unsupported_control_item')
})

test('P02 有序历史：工具按 call_id 配对、顺序保持、namespace 映射为扁平名并剥离目标不认识的字段', () => {
  const tools = [collaborationNamespace()]
  const plan = buildToolPlan(tools, makeRoute()).plan
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"task_name":"/root/worker","message":"x"}', encrypted_function_args: [] },
    { type: 'function_call_output', call_id: 'call_1', output: '{"task_name":"/root/worker"}' },
    { type: 'function_call', id: 'fc2', call_id: 'call_2', name: 'wait_agent', namespace: 'collaboration', arguments: '{"targets":["x"]}' },
    { type: 'function_call_output', call_id: 'call_2', output: '{"message":"Wait completed."}' },
  ]
  const { input: out, rejected } = projectOrderedHistory(input, makeRoute(), plan)
  assert.equal(rejected, null)
  assert.deepEqual(out.map((i) => i.type), ['message', 'function_call', 'function_call_output', 'function_call', 'function_call_output'])
  assert.equal(out[1].name, 'spawn_agent')
  assert.equal(out[1].namespace, undefined)
  assert.equal(out[1].encrypted_function_args, undefined)
  assert.equal(out[1].call_id, 'call_1')
  assert.equal(out[3].name, 'wait_agent')
  assert.equal(out[3].namespace, undefined)
})

test('P02 工具配对：缺 call_id/孤立 output/重复 call/kind 不匹配/同名歧义 → 拒绝', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const cases = [
    [{ type: 'function_call', name: 'spawn_agent', arguments: '{}' }],
    [{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}' }, { type: 'function_call_output', call_id: 'c2', output: 'x' }],
    [{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}' }, { type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}' }],
    [{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}' }, { type: 'custom_tool_call_output', call_id: 'c1', output: 'x' }],
    [{ type: 'function_call', call_id: 'c1', name: 'wait_agent', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'x' }],
  ]
  for (const input of cases.slice(0, 4)) {
    const r = projectOrderedHistory(input, makeRoute(), plan)
    assert.equal(r.rejected.code, 'tool_call_pairing')
  }
  // 第 5 例按当前 plan 合法（wait_agent 是已声明 namespace 工具），验证不会误拒。
  assert.equal(projectOrderedHistory(cases[4], makeRoute(), plan).rejected, null)
  // 同名歧义：普通函数与 namespace 工具同名且历史未带 namespace。
  const ambiguousPlan = buildToolPlan([flatSpawn, collaborationNamespace()], makeRoute()).plan
  const ambiguous = projectOrderedHistory([{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}' }], makeRoute(), ambiguousPlan)
  assert.equal(ambiguous.rejected.code, 'tool_call_pairing')
})

test('P02 历史工具：非空 encrypted_function_args → opaque_function_args，绝不猜测', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  for (const marker of [['CIPHER'], 'CIPHER', 7]) {
    const r = projectOrderedHistory([{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: marker }], makeRoute(), plan)
    assert.equal(r.rejected.code, 'opaque_function_args')
    assert.equal(JSON.stringify(r).includes('CIPHER'), false)
  }
})

test('P02 marker 矩阵：缺失/null/[]/未声明/非协作 namespace/普通函数', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const restore = (item) => restoreToolItem(item, makeRoute(), plan)
  // 1) 缺失 marker 的普通函数：原样，不补 namespace/marker
  const ordinary = restore({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' })
  assert.equal(ordinary.rejected, null)
  assert.equal(ordinary.item.namespace, undefined)
  assert.equal(ordinary.item.encrypted_function_args, undefined)
  // 2) null：原样，不补
  const nullMarker = restore({ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: null })
  assert.equal(nullMarker.rejected, null)
  assert.equal(nullMarker.item.namespace, undefined)
  assert.equal(nullMarker.item.encrypted_function_args, null)
  // 3) [] + 本轮明文声明：恢复 namespace/name，marker 幂等
  const emptyMarker = restore({ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: [] })
  assert.equal(emptyMarker.item.namespace, 'collaboration')
  assert.equal(emptyMarker.item.name, 'spawn_agent')
  assert.deepEqual(emptyMarker.item.encrypted_function_args, [])
  // 4) [] 但工具未声明：不补，身份不变
  const undeclared = restore({ type: 'function_call', call_id: 'c1', name: 'not_declared', arguments: '{}', encrypted_function_args: [] })
  assert.equal(undeclared.item.namespace, undefined)
  assert.equal(undeclared.item.name, 'not_declared')
  // 5) 非空数组：显式失败
  assert.equal(restore({ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: ['x'] }).rejected.code, 'opaque_function_args')
  // 6) 非 collaboration namespace：不参与明文判定，原样
  const otherNs = restore({ type: 'function_call', call_id: 'c1', name: 'spawn_agent', namespace: 'other', arguments: '{}' })
  assert.deepEqual(otherNs.item, { type: 'function_call', call_id: 'c1', name: 'spawn_agent', namespace: 'other', arguments: '{}' })
  // 7) 普通函数（无协作身份）不参与恢复
  const plain = restore({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}', encrypted_function_args: [] })
  assert.equal(plain.item.namespace, undefined)
  assert.deepEqual(plain.item.encrypted_function_args, [])
})

test('P02 完成项恢复：6 个 namespace 工具恢复 namespace/原名，仅三消息工具补 marker', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  for (const name of ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent']) {
    const { item, rejected } = restoreToolItem({ type: 'function_call', status: 'completed', id: 'fc_' + name, call_id: 'call_' + name, name, arguments: '{}' }, makeRoute(), plan)
    assert.equal(rejected, null)
    assert.equal(item.namespace, 'collaboration')
    assert.equal(item.name, name)
    assert.equal(item.call_id, 'call_' + name)
    if (COLLABORATION_TOOLS.includes(name)) assert.deepEqual(item.encrypted_function_args, [])
    else assert.equal(Object.prototype.hasOwnProperty.call(item, 'encrypted_function_args'), false)
  }
})

test('P02 完成项恢复：普通函数绝不添加 namespace；added/in_progress 只恢复身份', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const ordinary = restoreToolItem({ type: 'function_call', status: 'completed', call_id: 'c1', name: 'shell', arguments: '{}' }, makeRoute(), plan)
  assert.equal(ordinary.item.namespace, undefined)
  const added = restoreToolItem({ type: 'function_call', status: 'in_progress', call_id: 'c1', name: 'spawn_agent', arguments: '' }, makeRoute(), plan)
  assert.equal(added.item.namespace, 'collaboration')
  assert.equal(Object.prototype.hasOwnProperty.call(added.item, 'encrypted_function_args'), false)
})

test('P02 恢复：幂等、未知字段/非法参数拒绝、custom_tool_call 原样', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const first = restoreToolItem({ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: [] }, makeRoute(), plan)
  const second = restoreToolItem(first.item, makeRoute(), plan)
  assert.deepEqual(second.item, first.item)
  assert.equal(restoreToolItem({ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', unknown: 1 }, makeRoute(), plan).rejected.code, 'opaque_function_args')
  assert.equal(restoreToolItem({ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: 'not-json' }, makeRoute(), plan).rejected.code, 'opaque_function_args')
  const custom = restoreToolItem({ type: 'custom_tool_call', call_id: 'c1', name: 'spawn_agent', input: 'x' }, makeRoute(), plan)
  assert.equal(custom.rejected, null)
  assert.deepEqual(custom.item, { type: 'custom_tool_call', call_id: 'c1', name: 'spawn_agent', input: 'x' })
  // 同名但不同 kind（custom vs function）不得借用身份；真正的 namespace custom 仍按声明恢复。
  const customPlan = buildToolPlan([{ type: 'namespace', name: 'collaboration', tools: [{ type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'text' } }] }], makeRoute()).plan
  const customNs = restoreToolItem({ type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: 'x' }, makeRoute(), customPlan)
  assert.equal(customNs.rejected, null)
  assert.equal(customNs.item.namespace, 'collaboration')
  assert.equal(customNs.item.name, 'apply_patch')
})

test('P02 restoreResponseJson：output[] 逐项恢复，model/其它字段不回写、不改入参', () => {
  const plan = buildToolPlan([collaborationNamespace()], makeRoute()).plan
  const json = {
    id: 'resp_1',
    model: 'codex-deepseek',
    status: 'completed',
    output: [
      { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'hi' }] },
      { type: 'function_call', status: 'completed', id: 'fc1', call_id: 'c1', name: 'spawn_agent', arguments: '{"task_name":"x"}' },
    ],
    usage: { input_tokens: 1 },
  }
  const snapshot = structuredClone(json)
  const { json: out, rejected } = restoreResponseJson(json, makeRoute(), plan)
  assert.equal(rejected, null)
  assert.equal(out.model, 'codex-deepseek')
  assert.equal(out.output[1].namespace, 'collaboration')
  assert.deepEqual(out.output[1].encrypted_function_args, [])
  assert.deepEqual(json, snapshot)
})

test('P02 generation 边界：空 plan/旧 plan 不恢复身份', () => {
  const item = { type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: [] }
  const empty = restoreToolItem(item, makeRoute(), buildToolPlan(undefined, makeRoute()).plan)
  assert.equal(empty.item.namespace, undefined)
  const oldPlan = buildToolPlan([flatShell], makeRoute()).plan
  const old = restoreToolItem(item, makeRoute(), oldPlan)
  assert.equal(old.item.namespace, undefined)
})

test('P02 大小上限：项数与序列化字节数在发送前拒绝', () => {
  assert.equal(CODEX_MAX_INPUT_ITEMS, 10000)
  const many = new Array(CODEX_MAX_INPUT_ITEMS + 1).fill({ type: 'message', role: 'user', content: 'x' })
  const tooMany = projectOrderedHistory(many, makeRoute(), buildToolPlan(undefined, makeRoute()).plan)
  assert.equal(tooMany.rejected.code, 'input_too_large')
  const huge = [{ type: 'message', role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }]
  const tooBig = projectOrderedHistory(huge, makeRoute(), buildToolPlan(undefined, makeRoute()).plan)
  assert.equal(tooBig.rejected.code, 'input_too_large')
})

test('P02 prepareCodexNativeRequest：投影 body/plan/lossy，且不改原 body', () => {
  const body = {
    model: 'codex-deepseek',
    input: [REAL_AGENT_MESSAGE, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
    tools: [collaborationNamespace()],
    tool_choice: 'auto',
    include: ['reasoning.encrypted_content'],
    stream: true,
  }
  const snapshot = structuredClone(body)
  const out = prepareCodexNativeRequest(body, makeRoute())
  assert.equal(out.rejected, null)
  assert.ok(out.plan)
  assert.equal(out.body.input[0].type, 'message')
  assert.equal(out.body.input[0].role, 'user')
  assert.equal(out.body.tools.length, 6)
  assert.equal(out.body.tools.every((t) => t.type === 'function'), true)
  assert.equal(out.body.tool_choice, 'auto')
  assert.ok(out.lossy.includes('agent_message_projected'))
  assert.ok(out.lossy.includes('include_dropped:reasoning.encrypted_content'))
  assert.deepEqual(body, snapshot)
})

test('P02 prepareCodexNativeRequest：不可读密文/未支持项在发送前拒绝（零 body）', () => {
  const encrypted = prepareCodexNativeRequest({
    model: 'codex-deepseek',
    input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'x' }, { type: 'encrypted_content', encrypted_content: 'CIPHER' }] }],
  }, makeRoute())
  assert.equal(encrypted.body, null)
  assert.equal(encrypted.rejected.code, 'opaque_agent_message')
  assert.equal(JSON.stringify(encrypted).includes('CIPHER'), false)
  const store = prepareCodexNativeRequest({ model: 'codex-deepseek', input: 'hi', store: true }, makeRoute())
  assert.equal(store.body, null)
  assert.equal(store.rejected.code, 'unsupported_parameter')
  const encryptedArgs = prepareCodexNativeRequest({
    model: 'codex-deepseek',
    input: [{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{}', encrypted_function_args: ['CIPHER'] }],
    tools: [collaborationNamespace()],
  }, makeRoute())
  assert.equal(encryptedArgs.body, null)
  assert.equal(encryptedArgs.rejected.code, 'opaque_function_args')
})