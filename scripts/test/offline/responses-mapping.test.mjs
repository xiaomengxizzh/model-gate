// MG-015 Responses 纯映射层单测（wire 形状）。
// 契约：docs/contracts/responses-v1.md §4 请求映射 / §5 响应映射 / §6 流式事件 / §7 有损清单。
// 纯 node:test，不需要网关、不触真实上游；直接 import src/responses.js。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  responsesToChat, bridge, LEGACY_BRIDGE_COMPAT, chatToResponse, mapUsage, finishToStatus, makeSSEWriter, encodeSSE, canonEffort,
  UNSUPPORTED_NATIVE_PARAMETER, UNSUPPORTED_FIELD, UNSUPPORTED_CONTROL_ITEM,
  UNSUPPORTED_ALLOWED_TOOLS, TOOL_PAIRING_INVALID, OPAQUE_CONTINUATION_UNSUPPORTED,
} from '../../../src/responses.js'

const V2_ENCRYPTED_TASK_UNSUPPORTED = 'v2_encrypted_task_unsupported'

// 把 writer 返回的一串 SSE 帧拆成 [{type,data}]
function frames(s) {
  return String(s).split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    const eventLine = lines.find((l) => l.startsWith('event: '))
    const dataLine = lines.find((l) => l.startsWith('data: '))
    assert.ok(eventLine, '每帧必须有 event: 行')
    assert.ok(dataLine, '每帧必须有 data: 行')
    return { type: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) }
  })
}
function lossyHas(list, needle) { return (list || []).some((x) => String(x).includes(needle)) }

// ============================================================================
// §4 请求映射
// ============================================================================
test('§4 基础映射：input 字符串 / instructions 在前 / 采样 / 预算 / reasoning / stream', () => {
  const r = responsesToChat({
    model: 'demo',
    input: 'hello',
    instructions: 'be nice',
    max_output_tokens: 128,
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
    reasoning: { effort: 'Medium' },
  })
  assert.equal(r.rejected, null)
  assert.equal(r.body.model, 'demo')
  assert.deepEqual(r.body.messages, [
    { role: 'system', content: 'be nice' }, // 契约 §4：instructions → 首条 system
    { role: 'user', content: 'hello' },     // 契约 §4：input 字符串 → user
  ])
  assert.equal(r.body.max_tokens, 128, '契约 §4：max_output_tokens → max_tokens')
  assert.equal(r.body.temperature, 0.2)
  assert.equal(r.body.top_p, 0.9)
  assert.equal(r.body.stream, true)
  assert.equal(r.body.reasoning_effort, 'medium', '契约 §4：reasoning.effort → reasoning_effort（canonEffort 归一）')
  assert.deepEqual(r.lossy, [])
})

test('§4 input[] 角色映射与多段文本拼接；非文本 part 丢弃并记 lossy', () => {
  const r = responsesToChat({
    model: 'demo',
    instructions: 'sys0',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev' }] }, // developer→system
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prev' }] },
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'a' },
        { type: 'input_image', image_url: 'https://example.invalid/x.png' },
        { type: 'input_text', text: 'b' },
      ] },
    ],
  })
  assert.equal(r.rejected, null)
  assert.deepEqual(r.body.messages.map((m) => m.role), ['system', 'system', 'assistant', 'user'],
    '契约 §4：instructions 在前；developer→system；assistant/user 同名保序')
  assert.equal(r.body.messages[1].content, 'dev')
  assert.equal(r.body.messages[2].content, 'prev')
  assert.equal(r.body.messages[3].content, 'ab', '契约 §4：多段 input_text 按顺序拼接')
  assert.ok(lossyHas(r.lossy, 'non_text_part:input_image'), '契约 §7：非文本 part 丢弃必须记录有损')
})

test('§4 function_call / function_call_output / role=tool 映射', () => {
  const r = responsesToChat({
    model: 'demo',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      { type: 'function_call', call_id: 'call_2', name: 'other', arguments: '{}' },
      { role: 'tool', call_id: 'call_2', content: [{ type: 'text', text: 'done' }] },
    ],
  })
  assert.equal(r.rejected, null)
  assert.equal(r.body.messages[0].role, 'assistant')
  assert.deepEqual(r.body.messages[0].tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
  ], '契约 §4：call_id→id，name/arguments 原样')
  assert.deepEqual(r.body.messages[1], { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    '契约 §4：function_call_output → role=tool，call_id→tool_call_id')
  assert.equal(r.body.messages[2].role, 'assistant')
  assert.deepEqual(r.body.messages[2].tool_calls, [
    { id: 'call_2', type: 'function', function: { name: 'other', arguments: '{}' } },
  ])
  assert.deepEqual(r.body.messages[3], { role: 'tool', tool_call_id: 'call_2', content: 'done' })
})

test('§4 custom tool：format 有损；custom_tool_call 自由文本编码为 {"input":...}', () => {
  const r = responsesToChat({
    model: 'demo',
    tools: [{ type: 'custom', name: 'py', description: 'run python', format: { type: 'text' } }],
    input: [{ type: 'custom_tool_call', call_id: 'c1', name: 'py', input: 'print(1)' }],
  })
  assert.equal(r.rejected, null)
  const tool = r.body.tools[0]
  assert.equal(tool.type, 'function')
  assert.equal(tool.function.name, 'py', '契约 §4：custom tool 以 function 模拟')
  assert.equal(tool.function.parameters.properties.input.type, 'string', '契约 §4：参数固定为 {input: string}')
  const tc = r.body.messages[0].tool_calls[0]
  assert.equal(tc.id, 'c1')
  assert.equal(tc.function.name, 'py')
  assert.deepEqual(JSON.parse(tc.function.arguments), { input: 'print(1)' },
    '契约 §4：custom_tool_call 的自由文本 input 必须编码为 {"input": "<raw>"}')
  assert.ok(lossyHas(r.lossy, 'custom_tool_format'), '契约 §7：custom format 有损')
  assert.ok(lossyHas(r.lossy, 'custom_tool_call_input'), '契约 §7：free-text→JSON arguments 有损')
})

test('§4 tools/tool_choice 映射：function strict、指定函数、allowed_tools 有损降级', () => {
  const f = responsesToChat({
    model: 'demo', input: 'x',
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true }],
    tool_choice: { type: 'function', name: 'f' },
  })
  assert.equal(f.rejected, null)
  assert.deepEqual(f.body.tools, [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true } }])
  assert.deepEqual(f.body.tool_choice, { type: 'function', function: { name: 'f' } })

  assert.equal(responsesToChat({ model: 'demo', input: 'x', tool_choice: 'auto' }).body.tool_choice, 'auto')
  assert.equal(responsesToChat({ model: 'demo', input: 'x', tool_choice: 'none' }).body.tool_choice, 'none')

  const allowed = responsesToChat({ model: 'demo', input: 'x', tool_choice: { type: 'allowed_tools', mode: 'required' } })
  assert.equal(allowed.body.tool_choice, 'required', '契约 §4：allowed_tools 无法细粒度表达 → 降级')
  assert.ok(lossyHas(allowed.lossy, 'allowed_tools'), '契约 §7：allowed_tools 必须记有损')
})

test('§4 拒绝矩阵：store/previous_response_id/background/include/truncation/托管工具 → rejected', () => {
  const cases = [
    [{ store: true }, /store/],
    [{ previous_response_id: 'resp_123' }, /previous_response_id/],
    [{ background: true }, /background/],
    [{ include: ['message.input_image.image_url'] }, /include/],
    [{ include: ['reasoning.encrypted_content', 'file_search_call.results'] }, /include/],
    [{ include: 'reasoning.encrypted_content' }, /include 必须是字符串数组/],
    [{ truncation: 'auto' }, /truncation/],
  ]
  for (const [patch, re] of cases) {
    const r = responsesToChat(Object.assign({ model: 'demo', input: 'hi' }, patch))
    assert.equal(r.body, null, JSON.stringify(patch) + ' 必须返回 rejected，不得静默忽略')
    assert.ok(r.rejected, JSON.stringify(patch) + ' 必须带 rejected')
    assert.equal(r.rejected.code, 'unsupported_parameter', '契约 §3.4：拒绝 code=unsupported_parameter')
    assert.match(r.rejected.message, re)
    assert.ok(Array.isArray(r.lossy))
  }
  // 托管工具 / 命名空间分组无法在 Chat 协议表达：丢弃并逐项记 lossy，不得整条拒绝
  // （Codex 0.167 每轮固定发 type:"namespace" 的 multi_agent_v1 与 web_search；Codex 已取消
  //  chat/completions 支持，见 openai/codex discussions#7782，拒绝即等于不支持 Codex）
  {
    const r = responsesToChat({
      model: 'demo',
      input: 'hi',
      tools: [
        { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
        { type: 'namespace', name: 'multi_agent_v1' },
        { type: 'web_search' },
      ],
    })
    assert.equal(r.rejected, null, '托管工具/namespace 不得整条拒绝真实客户端请求')
    assert.equal(r.body.tools.length, 1, '只保留可表达的 function tool')
    assert.equal(r.body.tools[0].function.name, 'exec_command')
    assert.ok(lossyHas(r.lossy, 'tool_dropped:namespace'), '必须记 namespace 丢弃')
    assert.ok(lossyHas(r.lossy, 'tool_dropped:web_search'), '必须记 web_search 丢弃')
    // tool_choice 点名被丢弃的工具 → 降级 auto 并记有损（否则上游 400 无名工具）
    const tc = responsesToChat({ model: 'demo', input: 'hi', tools: [{ type: 'namespace', name: 'ns1' }], tool_choice: { type: 'function', name: 'ns1' } })
    assert.equal(tc.rejected, null)
    assert.equal(tc.body.tool_choice, 'auto')
    assert.ok(lossyHas(tc.lossy, 'tool_choice_dropped:ns1'))
  }

  // M1-2：不透明 item_reference/continuation 在桥方向必须发送前拒绝（稳定 code）。
  const ref = responsesToChat({ model: 'demo', input: [{ type: 'item_reference', id: 'x' }] })
  assert.equal(ref.body, null)
  assert.equal(ref.rejected.code, 'opaque_continuation_unsupported')
  assert.match(ref.rejected.message, /continuation/)

  // 真实客户端（Codex/DSH）固定发的 include 项必须可用，但显式记 lossy
  const inc = responsesToChat({ model: 'demo', input: 'hi', include: ['reasoning.encrypted_content', 'output_text.logprobs'] })
  assert.equal(inc.rejected, null, 'include 里的可丢弃项不得整条拒绝（Codex/DSH 默认请求形态）')
  assert.ok(lossyHas(inc.lossy, 'include_dropped:reasoning.encrypted_content'), '丢弃 include 必须记 lossy')
  // 无操作等价形态不应误伤：store:false / background:false / include:[] / truncation:'disabled'
  for (const patch of [{ store: false }, { background: false }, { include: [] }, { truncation: 'disabled' }]) {
    const r = responsesToChat(Object.assign({ model: 'demo', input: 'hi' }, patch))
    assert.equal(r.rejected, null, JSON.stringify(patch) + ' 是 no-op，不应拒绝')
  }
})

test('§4/§7 元数据与未知字段：丢弃但显式记 lossy', () => {
  const r = responsesToChat({
    model: 'demo', input: 'hi',
    metadata: { trace: 't1' }, user: 'u1', parallel_tool_calls: false,
    text: { format: { type: 'text' } }, vendorExtension: { a: 1 },
  })
  assert.equal(r.rejected, null)
  for (const code of ['metadata', 'user', 'parallel_tool_calls', 'unknown_field:text', 'unknown_field:vendorExtension']) {
    assert.ok(lossyHas(r.lossy, code), '必须标记有损：' + code)
  }
  assert.equal(r.body.metadata, undefined, 'metadata 不向上游透传')
  assert.equal(r.body.user, undefined)
})

// ============================================================================
// §5 响应映射
// ============================================================================
test('§5 mapUsage：三件套 + cached/reasoning 明细；无来源写 0', () => {
  assert.deepEqual(mapUsage({
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 },
  }), {
    input_tokens: 10, output_tokens: 5, total_tokens: 15,
    input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 },
  })
  assert.deepEqual(mapUsage({ prompt_tokens: 3, completion_tokens: 2 }),
    { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } })
  assert.deepEqual(mapUsage(null),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    '契约 §5：无来源写 0，不臆造')
  assert.equal(mapUsage({ prompt_tokens: 3, completion_tokens: 2, prompt_cache_hit_tokens: 1 }).input_tokens_details.cached_tokens, 1,
    'DeepSeek cached 字段回退')
})

test('§5 finishToStatus：length/content_filter → incomplete，其余 completed', () => {
  assert.deepEqual(finishToStatus('length'), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
  assert.deepEqual(finishToStatus('content_filter'), { status: 'incomplete', incomplete_details: { reason: 'content_filter' } })
  for (const f of ['stop', 'tool_calls', undefined]) assert.deepEqual(finishToStatus(f), { status: 'completed', incomplete_details: null })
})

test('§5 chatToResponse：响应形状、model 回写、usage、output_text', () => {
  const r = chatToResponse({
    id: 'chatcmpl-x', model: 'vendor-model', created: 1794190000,
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } },
  }, { model: 'demo' })
  assert.match(r.id, /^resp_/, '契约 §5：id 前缀 resp_')
  assert.equal(r.object, 'response')
  assert.equal(r.created_at, 1794190000)
  assert.equal(r.status, 'completed')
  assert.equal(r.model, 'demo', '契约 §5：model 一律回写客户端请求名')
  assert.equal(r.output_text, 'hi')
  assert.equal(r.output.length, 1)
  assert.deepEqual(r.output[0], {
    id: r.output[0].id, type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  })
  assert.deepEqual(r.usage, {
    input_tokens: 10, output_tokens: 5, total_tokens: 15,
    input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 },
  })
  assert.equal(r.incomplete_details, undefined)
})

test('§5 chatToResponse：tool_calls → function_call items（call_id/name/arguments/status）', () => {
  const lossy = []
  const r = chatToResponse({
    model: 'vendor',
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
          { id: 'call_2', type: 'function', function: { name: 'py', arguments: '{"input":"print(1)"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  }, { model: 'demo', customToolNames: ['py'], lossy })
  assert.equal(r.status, 'completed')
  assert.deepEqual(r.output.map((o) => o.type), ['function_call', 'custom_tool_call'],
    '契约 §5：默认 function_call；能识别 custom 时还原')
  assert.deepEqual(
    { call_id: r.output[0].call_id, name: r.output[0].name, arguments: r.output[0].arguments, status: r.output[0].status },
    { call_id: 'call_1', name: 'search', arguments: '{"q":"x"}', status: 'completed' })
  assert.equal(r.output[1].input, 'print(1)', 'custom_tool_call 还原自由文本 input')
  assert.ok(lossyHas(lossy, 'custom_tool_call_restored'), '契约 §7：类型还原记有损')
})

test('§5 chatToResponse：length/content_filter → incomplete + incomplete_details', () => {
  const base = { model: 'v', choices: [{ message: { role: 'assistant', content: 'cut' } }] }
  const len = chatToResponse(Object.assign({}, base, { choices: [{ message: { role: 'assistant', content: 'cut' }, finish_reason: 'length' }] }), { model: 'demo' })
  assert.equal(len.status, 'incomplete')
  assert.deepEqual(len.incomplete_details, { reason: 'max_output_tokens' })
  const cf = chatToResponse(Object.assign({}, base, { choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'content_filter' }] }), { model: 'demo' })
  assert.equal(cf.status, 'incomplete')
  assert.deepEqual(cf.incomplete_details, { reason: 'content_filter' })
})

// ============================================================================
// §6 流式事件顺序
// ============================================================================
test('§6 文本流：created→added→part.added→delta*→done→part.done→item.done→completed；sequence 单调、无 [DONE]', () => {
  const w = makeSSEWriter({ id: 'resp_test', model: 'demo', createdAt: 1794190000 })
  const out = w.created()
    + w.beginMessage('msg_test')
    + w.textDelta('Hel')
    + w.textDelta('lo')
    + w.endMessage('Hello')
    + w.completed({ id: 'resp_test', object: 'response', status: 'completed', model: 'demo', output: [], output_text: 'Hello', usage: mapUsage() })
  const evs = frames(out)
  assert.deepEqual(evs.map((e) => e.type), [
    'response.created',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ], '契约 §6：文本事件顺序')
  evs.forEach((e, i) => assert.equal(e.data.sequence_number, i + 1, '契约 §6：sequence_number 从 1 单调递增'))
  assert.equal(evs.filter((e) => e.type === 'response.output_text.done').length, 1, '契约 §6：output_text.done 只一次')
  assert.equal(evs.filter((e) => e.type === 'response.completed').length, 1)
  assert.ok(!String(out).includes('[DONE]'), '契约 §6：Responses 协议不使用 [DONE]')
  const deltas = evs.filter((e) => e.type === 'response.output_text.delta').map((e) => e.data.delta).join('')
  assert.equal(deltas, 'Hello')
  assert.equal(evs[1].data.item.id, 'msg_test')
  assert.equal(evs[5].data.text, 'Hello')
  assert.equal(evs[6].data.part.text, 'Hello')
  assert.equal(evs[7].data.item.status, 'completed')
  assert.equal(evs[8].data.response.status, 'completed')
  // 帧格式：event: 与 data: 成对
  assert.equal(encodeSSE(evs[0]).startsWith('event: response.created\ndata: '), true)
})

test('§6 工具流：output_item.added → arguments.delta* → arguments.done → output_item.done → completed', () => {
  const w = makeSSEWriter({ id: 'resp_t', model: 'demo' })
  const out = w.created()
    + w.beginToolCall({ id: 'fc_test', call_id: 'call_1', name: 'read' })
    + w.toolArgsDelta('{"pa')
    + w.toolArgsDelta('th":"a"}')
    + w.endToolCall('{"path":"a"}')
    + w.completed({ id: 'resp_t', object: 'response', status: 'completed', model: 'demo', output: [], usage: mapUsage() })
  const evs = frames(out)
  assert.deepEqual(evs.map((e) => e.type), [
    'response.created',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ], '契约 §6：工具参数事件顺序')
  evs.forEach((e, i) => assert.equal(e.data.sequence_number, i + 1))
  assert.equal(evs[1].data.item.type, 'function_call')
  assert.equal(evs[1].data.item.call_id, 'call_1')
  assert.equal(evs[4].data.arguments, '{"path":"a"}')
  assert.equal(evs[5].data.item.status, 'completed')
})

test('§6 created/in_progress：一旦发出 in_progress 必须紧跟 created；多 item id 唯一、output_index 递增', () => {
  const w = makeSSEWriter({ id: 'resp_o', model: 'demo' })
  const out = w.created() + w.inProgress()
    + w.beginToolCall({ call_id: 'c1', name: 'a' }) + w.endToolCall('{}')
    + w.beginToolCall({ call_id: 'c2', name: 'b' }) + w.endToolCall('{}')
    + w.completed({ id: 'resp_o', status: 'completed', model: 'demo', output: [] })
  const evs = frames(out)
  assert.deepEqual(evs.slice(0, 2).map((e) => e.type), ['response.created', 'response.in_progress'])
  const items = evs.filter((e) => e.type === 'response.output_item.added')
  assert.equal(items.length, 2)
  assert.notEqual(items[0].data.item.id, items[1].data.item.id, '契约 §6：事件/item id 必须唯一')
  assert.deepEqual(items.map((e) => e.data.output_index), [0, 1], 'output_index 递增')
})

test('§6 失败终态：response.failed 带 error.code/message，之后不得再发 completed', () => {
  const w = makeSSEWriter({ id: 'resp_f', model: 'demo' })
  const out = w.created() + w.failed({ code: 'REQUEST_TIMEOUT', message: '请求超时：超出整体预算 300ms' })
  const evs = frames(out)
  assert.deepEqual(evs.map((e) => e.type), ['response.created', 'response.failed'])
  assert.equal(evs[1].data.error.code, 'REQUEST_TIMEOUT', '契约 §6：预算耗尽沿用 MG-002 code=REQUEST_TIMEOUT')
  assert.match(evs[1].data.error.message, /请求超时/)
  assert.equal(evs[1].data.response.status, 'failed')
  assert.equal(evs.filter((e) => e.type === 'response.completed').length, 0)
  evs.forEach((e, i) => assert.equal(e.data.sequence_number, i + 1))
})

// ============================================================================
// 辅助
// ============================================================================
test('canonEffort：off/none/disabled/false 归一为 none，其它小写', () => {
  for (const v of ['off', 'none', 'disabled', 'false', ' OFF ']) assert.equal(canonEffort(v), 'none')
  assert.equal(canonEffort('High'), 'high')
  assert.equal(canonEffort(null), '')
})

// ============================================================================
// M1-2（T-SSE-02 相邻的桥契约）：严格默认、显式有损、作用域、配对、v2、native
// ============================================================================
test('M1-2 bridge() 严格默认：托管工具/控制项/未知字段 typedUnsupported；显式有损才放行', () => {
  const tools = [
    { type: 'web_search' },
    { type: 'function', name: 'ping', parameters: { type: 'object' } },
  ]
  const strict = bridge({ model: 'demo', input: 'hi', tools })
  assert.equal(strict.body, null, '托管工具默认必须拒绝，不得静默丢弃')
  assert.equal(strict.rejected.code, 'unsupported_tool')
  assert.match(strict.rejected.message, /web_search/)

  const compat = responsesToChat({ model: 'demo', input: 'hi', tools })
  assert.equal(compat.rejected, null, '产品便捷入口保持旧客户端兼容（显式 LEGACY_BRIDGE_COMPAT）')
  assert.deepEqual(compat.body.tools.map((t) => t.function.name), ['ping'])
  assert.ok(compat.lossy.includes('tool_dropped:web_search'), '有损丢弃必须记录')
  assert.equal(LEGACY_BRIDGE_COMPAT.allowLossy, true)

  const explicit = bridge({ model: 'demo', input: 'hi', tools }, { onUnsupportedTool: 'drop' })
  assert.equal(explicit.rejected, null, '显式有损模式才允许丢弃')
  assert.deepEqual(explicit.body.tools.map((t) => t.function.name), ['ping'])

  const control = bridge({ model: 'demo', input: [{ type: 'message', role: 'user', content: 'hi' }, { type: 'configuration_update', model: 'x' }] })
  assert.equal(control.rejected.code, UNSUPPORTED_CONTROL_ITEM, '控制项默认必须 typedUnsupported')
  const controlCompat = responsesToChat({ model: 'demo', input: [{ type: 'message', role: 'user', content: 'hi' }, { type: 'configuration_update', model: 'x' }] })
  assert.equal(controlCompat.rejected, null)
  assert.ok(controlCompat.lossy.includes('input_dropped:configuration_update'))

  const unknown = bridge({ model: 'demo', input: 'hi', vendorExtension: { a: 1 } })
  assert.equal(unknown.body, null)
  assert.equal(unknown.rejected.code, UNSUPPORTED_FIELD)
  const unknownCompat = responsesToChat({ model: 'demo', input: 'hi', vendorExtension: { a: 1 } })
  assert.equal(unknownCompat.rejected, null)
  assert.ok(unknownCompat.lossy.includes('unknown_field:vendorExtension'))

  // 文档化的可接受有损项（metadata/user）在严格模式下仍只记 lossy，不阻断。
  const meta = bridge({ model: 'demo', input: 'hi', metadata: { trace: 't' }, user: 'u' })
  assert.equal(meta.rejected, null)
  assert.ok(meta.lossy.includes('metadata'))
  assert.ok(meta.lossy.includes('user'))
})

test('M1-2 allowed_tools 作用域：精确表达保留；子集默认拒绝（不放宽）；有损模式才降级', () => {
  const tools = [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }]
  const exact = bridge({
    model: 'demo', input: 'hi', tools,
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }] },
  })
  assert.equal(exact.rejected, null, '允许列表等于全部工具时可精确表达')
  assert.equal(exact.body.tool_choice, 'required')
  assert.equal(exact.lossy.includes('allowed_tools'), false, '精确表达不应记有损')

  const subset = bridge({
    model: 'demo', input: 'hi', tools,
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'a' }] },
  })
  assert.equal(subset.body, null, '子集不能降级为 auto（会放宽作用域）')
  assert.equal(subset.rejected.code, UNSUPPORTED_ALLOWED_TOOLS)

  const subsetLossy = bridge({
    model: 'demo', input: 'hi', tools,
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'a' }] },
  }, { onUnsupportedTool: 'drop' })
  assert.equal(subsetLossy.rejected, null)
  assert.equal(subsetLossy.body.tool_choice, 'auto')
  assert.ok(subsetLossy.lossy.includes('allowed_tools'), '降级必须显式记有损')
})

test('M1-2 配对阻断：孤儿 tool_output / 缺 id 的结果 / 重复 call_id 不发送；待执行调用不阻断', () => {
  const orphan = bridge({
    model: 'demo',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
      { type: 'function_call_output', call_id: 'ghost', output: 'x' },
    ],
  })
  assert.equal(orphan.body, null)
  assert.equal(orphan.rejected.code, TOOL_PAIRING_INVALID)
  assert.ok(orphan.pairing.problems.some((p) => p.code === 'tool_output_without_call'))

  const missingId = bridge({ model: 'demo', input: [{ type: 'function_call_output', output: 'x' }] })
  assert.equal(missingId.rejected.code, TOOL_PAIRING_INVALID)
  assert.ok(missingId.pairing.problems.some((p) => p.code === 'tool_output_missing_call_id'))

  const duplicate = bridge({
    model: 'demo',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
      { type: 'function_call', call_id: 'c1', name: 'b', arguments: '{}' },
    ],
  })
  assert.equal(duplicate.rejected.code, TOOL_PAIRING_INVALID)
  assert.ok(duplicate.pairing.problems.some((p) => p.code === 'duplicate_call_id'))

  const pending = bridge({ model: 'demo', input: [{ type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' }] })
  assert.equal(pending.rejected, null, '只有调用没有结果可能是待执行调用，不阻断发送')
  assert.ok(pending.pairing.problems.some((p) => p.code === 'tool_call_without_output'))
})

test('M1-2 v2 密文顶层与嵌套扫描；opaque agent 任务/continuation 发送前拒绝', () => {
  const top = bridge({ model: 'demo', input: 'hi', encrypted_content: 'CIPHER-VALUE' })
  assert.equal(top.body, null)
  assert.equal(top.rejected.code, V2_ENCRYPTED_TASK_UNSUPPORTED)
  assert.equal(top.rejected.message.includes('CIPHER-VALUE'), false, '错误不得回显密文')
  assert.ok(top.signals || top.rejected, '保留信号/拒绝结构')

  const nested = bridge({ model: 'demo', input: 'hi', metadata: { nested: { encrypted_task_id: 'CIPHER-VALUE' } } })
  assert.equal(nested.rejected.code, V2_ENCRYPTED_TASK_UNSUPPORTED)

  const readable = bridge({ model: 'demo', input: [{ type: 'agent_message', id: 'a1', author: '/root', recipient: '/root/t', content: [{ type: 'input_text', text: 'hello' }] }] })
  assert.equal(readable.rejected, null, '纯文本 agent_message 可降级')
  assert.ok(readable.lossy.includes('agent_message_text_flattened'))

  const opaque = bridge({ model: 'demo', input: [{ type: 'agent_message', id: 'a1', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'https://example.invalid/x.png' }] }] })
  assert.equal(opaque.body, null)
  assert.equal(opaque.rejected.code, OPAQUE_CONTINUATION_UNSUPPORTED)
})

test('M1-2 nativeContract：未提供 → 明确 typedUnsupported；提供后按契约放行/拒绝；原生不受桥限制', () => {
  for (const patch of [{ store: true }, { previous_response_id: 'resp_1' }, { background: true }, { truncation: 'auto' }]) {
    const legacy = responsesToChat(Object.assign({ model: 'native', input: 'hi' }, patch), { mode: 'native' })
    assert.equal(legacy.body, null)
    assert.equal(legacy.rejected.code, UNSUPPORTED_NATIVE_PARAMETER, 'legacy 拒绝矩阵保留，但使用明确 code')
    assert.match(legacy.rejected.message, /nativeContract/)

    const allowed = bridge(Object.assign({ model: 'native', input: 'hi' }, patch), {
      mode: 'native',
      nativeContract: { store: true, previous_response_id: true, background: true, truncation: true },
    })
    assert.equal(allowed.rejected, null, JSON.stringify(patch) + ' 契约声明支持时必须放行')
    assert.equal(allowed.body, null, 'native 模式不产出 Chat body')
  }

  const partial = bridge({ model: 'native', input: 'hi', store: true }, { mode: 'native', nativeContract: { supported: ['previous_response_id'] } })
  assert.equal(partial.rejected.code, UNSUPPORTED_NATIVE_PARAMETER, '白名单未声明的字段仍拒绝')

  // 原生分支不受 Chat 桥的 v2/托管工具限制污染。
  const nativeOpaque = bridge({
    model: 'native', input: [{ type: 'agent_message', id: 'a1', content: [{ type: 'encrypted_content', encrypted_content: 'CIPHER' }] }],
    tools: [{ type: 'web_search' }],
  }, { mode: 'native', nativeContract: { store: true } })
  assert.equal(nativeOpaque.rejected, null)
})

test('M1-2 writer：多 callId 交错 delta 不串线，item id 贯穿 add/delta/done/completed', () => {
  const w = makeSSEWriter({ id: 'resp_multi', model: 'demo', createdAt: 1700000000 })
  const out = w.created()
    + w.beginMessage('msg_multi')
    + w.textDelta('Hel', { itemId: 'msg_multi' })
    + w.textDelta('lo', { itemId: 'msg_multi' })
    + w.endMessage('Hello', { itemId: 'msg_multi' })
    + w.beginToolCall({ id: 'fc_a', call_id: 'call_a', name: 'fa' })
    + w.beginToolCall({ id: 'fc_b', call_id: 'call_b', name: 'fb' })
    + w.toolArgsDelta('{"a":', { callId: 'call_a' })
    + w.toolArgsDelta('{"b":', { callId: 'call_b' })
    + w.toolArgsDelta('1}', { callId: 'call_a' })
    + w.toolArgsDelta('2}', { callId: 'call_b' })
    + w.endToolCall('{"a":1}', { callId: 'call_a' })
    + w.endToolCall('{"b":2}', { callId: 'call_b' })
    + w.completed({
      id: 'resp_multi', object: 'response', status: 'completed', model: 'demo',
      output: [
        { id: 'msg_multi', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] },
        { id: 'fc_a', type: 'function_call', status: 'completed', call_id: 'call_a', name: 'fa', arguments: '{"a":1}' },
        { id: 'fc_b', type: 'function_call', status: 'completed', call_id: 'call_b', name: 'fb', arguments: '{"b":2}' },
      ],
    })
  const evs = frames(out)
  const adds = evs.filter((e) => e.type === 'response.output_item.added')
  assert.deepEqual(adds.map((e) => e.data.item.id), ['msg_multi', 'fc_a', 'fc_b'])
  assert.equal(adds[0].data.item.id, 'msg_multi')
  const textDeltas = evs.filter((e) => e.type === 'response.output_text.delta')
  assert.deepEqual(textDeltas.map((e) => e.data.item_id), ['msg_multi', 'msg_multi'])
  const argDeltas = evs.filter((e) => e.type === 'response.function_call_arguments.delta')
  assert.deepEqual(argDeltas.map((e) => e.data.item_id), ['fc_a', 'fc_b', 'fc_a', 'fc_b'], '交错 delta 必须回到各自 item')
  assert.deepEqual(argDeltas.map((e) => e.data.delta), ['{"a":', '{"b":', '1}', '2}'])
  const argDone = evs.filter((e) => e.type === 'response.function_call_arguments.done')
  assert.deepEqual(argDone.map((e) => [e.data.item_id, e.data.arguments]), [['fc_a', '{"a":1}'], ['fc_b', '{"b":2}']])
  const completed = evs.find((e) => e.type === 'response.completed')
  assert.deepEqual(completed.data.response.output.map((o) => o.id), ['msg_multi', 'fc_a', 'fc_b'], 'completed.output 必须与 item 事件同 id')
  assert.equal(evs.filter((e) => e.type === 'response.completed').length, 1)
})
