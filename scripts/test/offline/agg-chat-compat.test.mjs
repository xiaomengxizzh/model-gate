// 聚合模式：Responses ↔ Chat Completions 翻译层离线单测。
// 被测：src/codex/chat-compat.js（纯函数 + 纯异步迭代器，不联网、不读宿主凭据）。
// 夹具：scripts/test/fixtures/agg-chatcompat/（golden request / chat JSON / chat SSE 原文）。
// 覆盖：请求/响应往返、工具调用配对、并行工具不合并、流式顺序与唯一终态、
//       length→incomplete、截断→failed（不得当成功）、usage 含缓存、字段丢弃必须点名、
//       公共 mg-* id 绝不出现在上游请求体、anthropic-only 模型 typed unsupported（无回落）、
//       discovery 可路由性与协议判定一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  responsesToChat, chatToResponse, chatSseToResponsesSse, resolveUpstreamProtocol,
  encodeResponsesEvent, ChatCompatError,
  CHAT_COMPLETIONS, RESPONSES, ANTHROPIC_MESSAGES, GOOGLE_GENERATE_CONTENT, UNSUPPORTED_PROTOCOL,
  UPSTREAM_MODEL_MISSING, TOOL_CALL_PAIRING, INVALID_CHAT_RESPONSE,
} from '../../../src/codex/chat-compat.js'
import { normalizeModelEntry } from '../../../src/aggregation/discovery.js'

const FIXTURES = new URL('../fixtures/agg-chatcompat/', import.meta.url)
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8')
const jsonFixture = (name) => JSON.parse(fixture(name))

const UPSTREAM_MODEL = 'deepseek-v4.1-flash'
const PUBLIC_MODEL = 'mg-opencodego-deepseek-v4-1-flash'

function sseChunks(text, size = 37) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
async function* iterate(list) { for (const item of list) yield item }
async function collect(iterable) { const out = []; for await (const e of iterable) out.push(e); return out }
const TERMINALS = new Set(['response.completed', 'response.incomplete', 'response.failed'])
function terminals(events) { return events.filter((e) => TERMINALS.has(e.type)) }
function assertSingleTerminal(events) {
  const t = terminals(events)
  assert.equal(t.length, 1, '流必须有且只有一个终态，实际: ' + t.map((e) => e.type).join(','))
  assert.equal(events[events.length - 1].type, t[0].type, '终态必须是最后一个事件')
  return t[0]
}

// ============================================================================
// 1) 请求方向：文本往返
// ============================================================================
test('请求：文本 messages + instructions 落到 Chat，模型换上游 id、公共 id 不出现', () => {
  const { body, warnings } = responsesToChat({
    model: PUBLIC_MODEL,
    instructions: 'be brief',
    input: 'hello',
    max_output_tokens: 128,
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
  }, { upstreamModel: UPSTREAM_MODEL })
  assert.equal(body.model, UPSTREAM_MODEL)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
  ])
  assert.equal(body.max_tokens, 128)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.top_p, 0.9)
  assert.equal(body.stream, true)
  assert.deepEqual(warnings, [])
  assert.equal(JSON.stringify(body).includes(PUBLIC_MODEL), false, '公共 mg-* id 绝不能进入上游请求体')
})

test('请求：公共 id 当上游 id 使用时必须 typed error（不许静默泄漏）', () => {
  assert.throws(
    () => responsesToChat({ model: PUBLIC_MODEL, input: 'x' }),
    (e) => e instanceof ChatCompatError && e.code === UPSTREAM_MODEL_MISSING,
  )
})

test('请求：golden 请求的完整形状（system 合并、工具、tool_choice、并行调用分开、reasoning 丢弃）', () => {
  const req = jsonFixture('responses-request.json')
  const { body, warnings } = responsesToChat(req, { upstreamModel: UPSTREAM_MODEL })

  assert.equal(body.model, UPSTREAM_MODEL)
  assert.equal(JSON.stringify(body).includes(PUBLIC_MODEL), false)

  // instructions + developer 合成一条 system，内容不丢。
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are Codex.\n\ndev rules' })
  assert.deepEqual(body.messages[1], { role: 'user', content: 'read a.txt' })

  // 两个 function_call 合进同一条 assistant 消息，但仍是两个独立 tool_calls。
  const assistant = body.messages.filter((m) => m.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0].tool_calls.length, 2)
  assert.deepEqual(assistant[0].tool_calls.map((c) => c.id), ['call_alpha', 'call_beta'])
  assert.equal(assistant[0].tool_calls[0].function.arguments, '{"path":"a.txt"}', 'arguments 原样转发')

  // function_call_output → role:tool + tool_call_id
  assert.deepEqual(body.messages.filter((m) => m.role === 'tool'), [
    { role: 'tool', tool_call_id: 'call_alpha', content: 'hello' },
    { role: 'tool', tool_call_id: 'call_beta', content: 'a.txt' },
  ])

  // function tools 原样结构；托管工具 web_search 丢弃且点名告警。
  assert.deepEqual(body.tools.map((t) => t.function.name), ['read_file', 'list_dir'])
  assert.deepEqual(body.tools[0].function.parameters, req.tools[0].parameters)
  assert.ok(warnings.includes('unsupported_tool:web_search'), '托管工具必须告警: ' + warnings.join(','))

  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'read_file' } })
  assert.equal(body.parallel_tool_calls, true)

  // reasoning item / 顶层服务端状态字段：丢弃且点名，绝不转发。
  assert.ok(warnings.includes('dropped_item:reasoning'))
  for (const field of ['store', 'previous_response_id', 'include', 'prompt_cache_key', 'metadata']) {
    assert.ok(warnings.includes('dropped_field:' + field), '必须点名丢弃字段 ' + field + ': ' + warnings.join(','))
    assert.equal(Object.prototype.hasOwnProperty.call(body, field), false, '字段不得出现在上游请求体: ' + field)
  }
  assert.equal(JSON.stringify(body).includes('resp_prev'), false)
  assert.equal(JSON.stringify(body).includes('thread-1'), false)
})

test('请求：未知字段丢弃但必须点名（不静默、也不透传）', () => {
  const { body, warnings } = responsesToChat({ model: 'm', input: 'x', some_future_field: 1 }, {})
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'some_future_field'), false)
  assert.ok(warnings.includes('dropped_field:some_future_field'))
})

test('请求：developer 角色降级为 system 且告警；图片可表达时保留，file_id 丢弃并告警', () => {
  const { body, warnings } = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://example.invalid/a.png' },
          { type: 'input_image', file_id: 'file-123' },
        ],
      },
    ],
  }, {})
  assert.equal(body.messages[0].role, 'system')
  assert.ok(warnings.includes('developer_role_as_system'))
  const user = body.messages[1]
  assert.ok(Array.isArray(user.content), '带图片时必须用 content 数组')
  assert.deepEqual(user.content[0], { type: 'text', text: 'look' })
  assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } })
  assert.equal(user.content.length, 2, 'file_id 图片必须丢弃，不能伪造 URL')
  assert.ok(warnings.includes('dropped_image_part:file_id'))
})

test('请求：tool_calls 缺 call_id / 工具结果缺 call_id 都是 typed error（不许猜配对）', () => {
  assert.throws(
    () => responsesToChat({ model: 'm', input: [{ type: 'function_call', name: 'f', arguments: '{}' }] }, {}),
    (e) => e instanceof ChatCompatError && e.code === TOOL_CALL_PAIRING,
  )
  assert.throws(
    () => responsesToChat({ model: 'm', input: [{ type: 'function_call_output', output: 'x' }] }, {}),
    (e) => e instanceof ChatCompatError && e.code === TOOL_CALL_PAIRING,
  )
})

// ============================================================================
// 2) 响应方向：JSON
// ============================================================================
test('响应：文本往返形状（object/id/status/model/output/usage）', () => {
  const resp = chatToResponse({
    id: 'chatcmpl-1',
    created: 1763000001,
    model: UPSTREAM_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  }, { model: PUBLIC_MODEL })
  assert.equal(resp.object, 'response')
  assert.match(resp.id, /^resp_/, 'id 必须是网关自己的 resp_*，不是上游 chatcmpl id')
  assert.equal(resp.created_at, 1763000001)
  assert.equal(resp.status, 'completed')
  assert.equal(resp.model, PUBLIC_MODEL, '回给客户端的 model 是公共 id')
  assert.deepEqual(resp.output, [{
    id: resp.output[0].id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hi there', annotations: [] }],
  }])
  assert.equal(resp.output_text, 'hi there')
})

test('响应：tool_calls → function_call item，call_id 原样、arguments 原样、并行调用不合并', () => {
  const chat = jsonFixture('chat-response-tools.json')
  const resp = chatToResponse(chat, { model: PUBLIC_MODEL })
  const calls = resp.output.filter((o) => o.type === 'function_call')
  assert.equal(calls.length, 2, '两个 tool_call 必须是两个 item')
  assert.deepEqual(calls.map((c) => c.call_id), ['call_alpha', 'call_beta'])
  assert.deepEqual(calls.map((c) => c.name), ['read_file', 'list_dir'])
  assert.equal(calls[0].arguments, '{"path":"a.txt"}', 'arguments 必须是上游发送的字符串，不得重新序列化')
  assert.equal(calls[1].arguments, '{"path":"."}')
  assert.ok(resp.output.some((o) => o.type === 'message'))
})

test('响应：finish_reason=length → incomplete + max_output_tokens', () => {
  const resp = chatToResponse({
    choices: [{ message: { role: 'assistant', content: 'cut' }, finish_reason: 'length' }],
  }, { model: PUBLIC_MODEL })
  assert.equal(resp.status, 'incomplete')
  assert.deepEqual(resp.incomplete_details, { reason: 'max_output_tokens' })
})

test('响应：usage 映射含缓存命中，不臆造 reasoning', () => {
  const resp = chatToResponse(jsonFixture('chat-response-tools.json'), { model: PUBLIC_MODEL })
  assert.deepEqual(resp.usage.input_tokens, 120)
  assert.deepEqual(resp.usage.output_tokens, 18)
  assert.deepEqual(resp.usage.total_tokens, 138)
  assert.equal(resp.usage.input_tokens_details.cached_tokens, 64)
})

test('响应：多 choices 只用 choices[0]，并记录 multiple_choices 告警（不伪造额外 output）', () => {
  const warnings = []
  const resp = chatToResponse(jsonFixture('chat-response-multi-choice.json'), { model: PUBLIC_MODEL, warnings })
  assert.equal(resp.output.length, 1)
  assert.equal(resp.output_text, 'first')
  assert.ok(warnings.includes('multiple_choices:2'))
})

test('响应：上游 error 体 / 缺 choices 都是 typed error', () => {
  assert.throws(
    () => chatToResponse(jsonFixture('chat-response-error.json'), {}),
    (e) => e instanceof ChatCompatError && e.code === 'context_length_exceeded',
  )
  assert.throws(
    () => chatToResponse({ id: 'x' }, {}),
    (e) => e instanceof ChatCompatError && e.code === INVALID_CHAT_RESPONSE,
  )
})

// ============================================================================
// 3) 响应方向：SSE
// ============================================================================
test('流式：文本+并行工具的完整顺序，每项恰好一次 item.done，恰好一个终态', async () => {
  const raw = fixture('chat-sse-text-and-tools.sse')
  const events = await collect(chatSseToResponsesSse(iterate(sseChunks(raw)), { model: PUBLIC_MODEL }))

  assert.equal(events[0].type, 'response.created')
  assert.equal(events[0].data.response.model, PUBLIC_MODEL, '流里回给客户端的 model 是公共 id')
  const end = assertSingleTerminal(events)
  assert.equal(end.type, 'response.completed')

  // 文本 item：added 在第一个 delta 之前；两个 delta 内容保持顺序。
  const textAdded = events.findIndex((e) => e.type === 'response.output_item.added' && e.data.item.type === 'message')
  const firstTextDelta = events.findIndex((e) => e.type === 'response.output_text.delta')
  assert.ok(textAdded >= 0 && textAdded < firstTextDelta, 'output_item.added 必须先于该 item 的第一个 delta')
  assert.deepEqual(
    events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.data.delta),
    ['Look', 'ing up.'],
  )

  // 两个工具 item 各自 added 早于自己的 arguments delta，且 done 恰好一次。
  const addedIds = events.filter((e) => e.type === 'response.output_item.added' && e.data.item.type === 'function_call').map((e) => e.data.item.id)
  const doneIds = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.data.item.id)
  const addedAll = events.filter((e) => e.type === 'response.output_item.added').map((e) => e.data.item.id)
  assert.equal(addedIds.length, 2, '两个并行工具各一个 item')
  assert.equal(doneIds.length, addedAll.length, '每个 item 恰好一次 output_item.done')
  assert.deepEqual([...doneIds].sort(), [...addedAll].sort())

  for (const id of addedIds) {
    const a = events.findIndex((e) => e.type === 'response.output_item.added' && e.data.item.id === id)
    const firstDelta = events.findIndex((e) => e.type === 'response.function_call_arguments.delta' && e.data.item_id === id)
    const done = events.findIndex((e) => e.type === 'response.output_item.done' && e.data.item.id === id)
    assert.ok(a < firstDelta, 'added 必须先于 arguments delta')
    assert.ok(firstDelta < done, 'done 必须在 delta 之后')
  }

  // delta 不串线：每个 item 的 arguments 拼接回完整 JSON，且原样是上游分片。
  const byItem = new Map()
  for (const e of events) {
    if (e.type !== 'response.function_call_arguments.delta') continue
    byItem.set(e.data.item_id, (byItem.get(e.data.item_id) || '') + e.data.delta)
  }
  const args = [...byItem.values()]
  assert.deepEqual(args, ['{"path":"a.txt"}', '{"path":"."}'], '分片顺序必须保持，不得重排/合并')

  // 终态 output：文本 item 在前，两个 function_call 后，call_id 保持。
  const output = end.data.response.output
  assert.deepEqual(output.map((o) => o.type), ['message', 'function_call', 'function_call'])
  assert.deepEqual(output.filter((o) => o.type === 'function_call').map((o) => o.call_id), ['call_alpha', 'call_beta'])
  assert.equal(end.data.response.output_text, 'Looking up.')

  // usage 来自末尾 usage-only 帧（choices: []）。
  assert.equal(end.data.response.usage.input_tokens, 120)
  assert.equal(end.data.response.usage.output_tokens, 18)
  assert.equal(end.data.response.usage.input_tokens_details.cached_tokens, 64)
})

test('流式：finish_reason=length → response.incomplete（唯一终态）', async () => {
  const events = await collect(chatSseToResponsesSse(iterate(sseChunks(fixture('chat-sse-length.sse'))), { model: PUBLIC_MODEL }))
  const end = assertSingleTerminal(events)
  assert.equal(end.type, 'response.incomplete')
  assert.equal(end.data.response.status, 'incomplete')
  assert.deepEqual(end.data.response.incomplete_details, { reason: 'max_output_tokens' })
})

test('流式：没有 finish_reason 也没有 [DONE] → response.failed，绝不当成功', async () => {
  const events = await collect(chatSseToResponsesSse(iterate(sseChunks(fixture('chat-sse-truncated.sse'))), { model: PUBLIC_MODEL }))
  const end = assertSingleTerminal(events)
  assert.equal(end.type, 'response.failed')
  assert.equal(end.data.error.code, 'stream_truncated')
  assert.equal(events.some((e) => e.type === 'response.completed'), false)
})

test('流式：非 JSON 帧 → 一次 response.failed（typed），其后不再有事件', async () => {
  const events = await collect(chatSseToResponsesSse(iterate(sseChunks(fixture('chat-sse-malformed.sse'))), { model: PUBLIC_MODEL }))
  const end = assertSingleTerminal(events)
  assert.equal(end.type, 'response.failed')
  assert.equal(end.data.error.code, 'malformed_chunk')
  assert.equal(events[events.length - 1], end, '失败后必须终止，不能再产出事件')
  assert.equal(JSON.stringify(events).includes('never reached'), false, '失败帧之后的 chunk 不得被翻译')
})

test('流式：上游 error 帧 → response.failed 且使用上游 code', async () => {
  const raw = 'data: {"error":{"code":"rate_limit_exceeded","message":"slow down"}}\n\n'
  const events = await collect(chatSseToResponsesSse(iterate([raw]), { model: PUBLIC_MODEL }))
  const end = assertSingleTerminal(events)
  assert.equal(end.type, 'response.failed')
  assert.equal(end.data.error.code, 'rate_limit_exceeded')
})

test('流式：空流（无任何帧）→ response.failed stream_truncated', async () => {
  const events = await collect(chatSseToResponsesSse(iterate([]), { model: PUBLIC_MODEL }))
  const end = assertSingleTerminal(events)
  assert.equal(end.type, 'response.failed')
  assert.equal(end.data.error.code, 'stream_truncated')
})

test('流式：事件可编码成 wire 帧（event: + data:），sequence_number 单调递增', async () => {
  const events = await collect(chatSseToResponsesSse(iterate(sseChunks(fixture('chat-sse-text-and-tools.sse'))), { model: PUBLIC_MODEL }))
  const seqs = events.map((e) => e.data.sequence_number)
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'sequence_number 从 1 单调递增')
  const wire = encodeResponsesEvent(events[0])
  assert.ok(wire.startsWith('event: response.created\ndata: {'))
  assert.ok(wire.endsWith('\n\n'))
})

// ============================================================================
// 4) 协议选择
// ============================================================================
test('协议：chat-completions 有适配器；responses 明确 adapter=null；缺省按 chat 但标注 assumed', () => {
  const chat = resolveUpstreamProtocol({ publicId: PUBLIC_MODEL, upstreamId: UPSTREAM_MODEL, protocol: 'openai' })
  assert.equal(chat.ok, true)
  assert.equal(chat.protocol, CHAT_COMPLETIONS)
  assert.equal(chat.upstreamModel, UPSTREAM_MODEL)
  assert.equal(typeof chat.adapter.toUpstream, 'function')
  assert.equal(typeof chat.adapter.fromUpstream, 'function')
  assert.equal(typeof chat.adapter.fromStream, 'function')

  const native = resolveUpstreamProtocol({ upstreamId: UPSTREAM_MODEL, protocol: 'responses' })
  assert.equal(native.ok, true)
  assert.equal(native.protocol, RESPONSES)
  assert.equal(native.adapter, null, 'responses 是原生透传，不应有翻译适配器')

  const bare = resolveUpstreamProtocol({ upstreamId: UPSTREAM_MODEL })
  assert.equal(bare.ok, true)
  assert.equal(bare.protocol, CHAT_COMPLETIONS)
  assert.equal(bare.assumed, true)
  assert.deepEqual(bare.warnings, ['protocol_unspecified'])
})

test('协议：anthropic-only / google-only 模型返回 unsupported_protocol，绝不回落 chat', () => {
  for (const [protocol, expected] of [
    ['anthropic-messages', ANTHROPIC_MESSAGES],
    ['google-generate-content', GOOGLE_GENERATE_CONTENT],
    ['messages', ANTHROPIC_MESSAGES],
    ['generate-content', GOOGLE_GENERATE_CONTENT],
  ]) {
    const r = resolveUpstreamProtocol({ publicId: 'mg-console-x', upstreamId: 'x', protocol })
    assert.equal(r.ok, false, protocol + ' 必须被拒绝')
    assert.equal(r.code, UNSUPPORTED_PROTOCOL)
    assert.equal(r.adapter, undefined, '不得返回一个只做 chat 的 adapter')
    assert.equal(r.protocol, expected)
    assert.ok(r.message.includes('mg-console-x') || r.message.includes('x'), '错误必须带上模型身份')
  }
  // 真正未知的协议名同样拒绝，不能猜成 chat。
  const unknown = resolveUpstreamProtocol({ upstreamId: 'y', protocol: 'grpc-magic' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, UNSUPPORTED_PROTOCOL)
})

// ============================================================================
// 5) Discovery 对齐：可路由性只由已实现协议决定
// ============================================================================
const DISCOVERY_CTX = { providerId: 'opencodego', providerSegment: 'opencodego', source: 'fixture', observedAt: '2026-11-14T00:00:00Z' }
function entryOf(api) {
  const r = normalizeModelEntry({ id: 'model-' + Object.keys(api)[0], api }, DISCOVERY_CTX)
  assert.equal(r.ok, true)
  return r.model
}

test('discovery：chat-completions / api.openai 可路由；anthropic / google 仍不可路由', () => {
  const chat = entryOf({ 'chat-completions': { base_url: 'https://opencode.ai/inference/go/v1' } })
  assert.equal(chat.protocol, 'openai')
  assert.equal(chat.routable, true, 'chat-completions 现在必须可路由')

  const chatShaped = entryOf({ openai: { base_url: 'https://opencode.ai/inference/openai/v1' } })
  assert.equal(chatShaped.protocol, 'openai', 'api.openai 是 chat-shaped base，按 chat-completions 处理')
  assert.equal(chatShaped.routable, true)

  const responses = entryOf({ responses: { base_url: 'https://opencode.ai/inference/go/v1' } })
  assert.equal(responses.protocol, 'responses')
  assert.equal(responses.routable, true)

  const anthropic = entryOf({ messages: { base_url: 'https://opencode.ai/inference/anthropic/v1' } })
  assert.equal(anthropic.protocol, 'anthropic-messages')
  assert.equal(anthropic.routable, false, '没有 Messages 适配器前，不得放宽可路由')

  const google = entryOf({ 'generate-content': { base_url: 'https://opencode.ai/inference/google/v1beta' } })
  assert.equal(google.protocol, 'google-generate-content')
  assert.equal(google.routable, false, '没有 generateContent 适配器前，不得放宽可路由')
})

test('discovery 与协议选择一致：可路由的 chat 模型拿得到适配器，不可路由的模型拿不到', () => {
  const chat = entryOf({ 'chat-completions': { base_url: 'https://opencode.ai/inference/go/v1' } })
  const resolved = resolveUpstreamProtocol(chat)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.protocol, CHAT_COMPLETIONS)
  assert.equal(resolved.upstreamModel, chat.upstreamId, '上游 id 取 upstreamId，不是公共 id')

  const anthropic = entryOf({ messages: { base_url: 'https://opencode.ai/inference/anthropic/v1' } })
  const rejected = resolveUpstreamProtocol(anthropic)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, UNSUPPORTED_PROTOCOL)
})
