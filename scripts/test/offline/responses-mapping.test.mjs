// MG-015 Responses 纯映射层单测（wire 形状）。
// 契约：docs/contracts/responses-v1.md §4 请求映射 / §5 响应映射 / §6 流式事件 / §7 有损清单。
// 纯 node:test，不需要网关、不触真实上游；直接 import src/responses.js。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  responsesToChat, chatToResponse, mapUsage, finishToStatus, makeSSEWriter, encodeSSE, canonEffort,
} from '../../../src/responses.js'

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
  assert.deepEqual(r.body.messages[2], { role: 'tool', tool_call_id: 'call_2', content: 'done' })
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
    [{ input: [{ type: 'item_reference', id: 'x' }] }, /input item/],
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
