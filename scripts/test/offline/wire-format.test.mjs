// 协议桥 wire 保真测试（MG-008 / src/format.js）
// 只对适配器导出做纯函数级断言：不启动网关、不连真实上游、不读写配置。
// 有损转换清单及每条证据的映射见 docs/reference/protocol-bridge.md。
import test from 'node:test'
import assert from 'node:assert/strict'
import { adapterFor, makeOA, hasTools, cacheHitMiss } from '../../../src/format.js'

const anthropic = adapterFor('anthropic')
const gemini = adapterFor('gemini')
const clone = (v) => JSON.parse(JSON.stringify(v))

// ── 固定 wire fixture：OpenAI 客户端请求体 + Anthropic/Gemini 上游响应与 SSE 帧 ──
const OPENAI_CHAT_FIXTURE = {
  model: 'wire-model',
  stream: true,
  temperature: 0.3,
  top_p: 0.9,
  max_tokens: 256,
  stop: ['<END>'],
  messages: [
    { role: 'system', content: 'sys-A' },
    { role: 'system', content: [{ type: 'text', text: 'sys-B' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look ' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'now' }
      ]
    },
    {
      role: 'assistant',
      content: 'calling',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'weather', arguments: '{"city":"sz"}' } },
        { id: 'call_b', type: 'function', function: { name: 'clock', arguments: '{"tz":"CST"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'sunny' },
    { role: 'tool', tool_call_id: 'call_b', content: '10:00' }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'weather',
        description: 'get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
      }
    },
    { type: 'function', function: { name: 'clock' } }
  ],
  tool_choice: { type: 'function', function: { name: 'weather' } }
}

// Anthropic Messages API 原始响应（含 thinking 块，用于验证丢弃行为）
const ANTHROPIC_MESSAGE_FIXTURE = {
  id: 'msg_wire_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-wire',
  content: [
    { type: 'thinking', thinking: 'plan the call', signature: 'sig-abc' },
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' world' },
    { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'sz' } },
    { type: 'tool_use', id: 'toolu_2', name: 'clock', input: { tz: 'CST' } }
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }
}

// Gemini generateContent 原始响应（含 safetyRatings 与缓存 token）
const GEMINI_RESPONSE_FIXTURE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Sunny ' }, { text: 'in SZ' }, { functionCall: { name: 'weather', args: { city: 'sz' } } }]
      },
      finishReason: 'MAX_TOKENS',
      safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }]
    }
  ],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 7,
    totalTokenCount: 19,
    cachedContentTokenCount: 4
  },
  model: 'gemini-wire',
  modelVersion: 'gemini-2.5-pro'
}

// Anthropic SSE：事件顺序与 message_delta 里的 stop_reason
const ANTHROPIC_SSE_FIXTURE = [
  { data: '{"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}', content: '', finish: '' },
  { data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', content: '', finish: '' },
  { data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}', content: 'Hel', finish: '' },
  { data: '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}', content: '', finish: '' },
  { data: '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}', content: '', finish: '' },
  { data: '{"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":12}}', content: '', finish: 'length' },
  { data: '{"type":"message_stop"}', content: '', finish: '' },
  { data: 'not-json', content: '', finish: '' }
]

// Gemini SSE：文本可被拆成多个 part；finishReason 可能在独立帧
const GEMINI_SSE_FIXTURE = [
  { data: '{"candidates":[{"content":{"role":"model","parts":[{"text":"Sun"}]}}]}', content: 'Sun', finish: '' },
  { data: '{"candidates":[{"content":{"role":"model","parts":[{"text":"ny "},{"text":"in SZ"}]}}]}', content: 'ny in SZ', finish: '' },
  { data: '{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"weather","args":{"city":"sz"}}}]}}]}', content: '', finish: '' },
  { data: '{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":7}}', content: '', finish: 'length' },
  { data: '{"candidates":[{"content":{"parts":[]},"finishReason":"SAFETY"}]}', content: '', finish: 'content_filter' },
  { data: '{"promptFeedback":{"blockReason":"SAFETY"}}', content: '', finish: 'content_filter' },
  { data: 'not-json', content: '', finish: '' }
]

const toolSummary = (tcs) => (tcs || []).map((tc) => ({ id: tc.id, type: tc.type, name: tc.function.name, args: tc.function.arguments }))

// ───────────────────────── Anthropic：请求体 ─────────────────────────
test('anthropic build：system 归并、多模态文本、tool schema/tool_choice、stop/stream', () => {
  const body = clone(OPENAI_CHAT_FIXTURE)
  const before = JSON.stringify(body)
  const out = anthropic.build(body)
  assert.equal(JSON.stringify(body), before, 'build 不得修改客户端请求体')

  assert.equal(out.path, '/v1/messages')
  const b = out.body
  assert.equal(b.model, 'wire-model')
  assert.equal(b.max_tokens, 256)
  assert.equal(b.system, 'sys-A\nsys-B')
  assert.equal(b.temperature, 0.3)
  assert.equal(b.top_p, 0.9)
  assert.equal(b.stream, true)
  assert.deepEqual(b.stop_sequences, ['<END>'])

  // 图片 part 没有 Anthropic 等价字段 => 丢弃；文本按 parts 顺序拼接，不得凭空插入换行
  assert.deepEqual(b.messages[0], { role: 'user', content: 'look now' })

  // assistant 文本 + tool_use 块保序；arguments 还原为对象；id 原样保留
  assert.deepEqual(b.messages[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'call_a', name: 'weather', input: { city: 'sz' } },
      { type: 'tool_use', id: 'call_b', name: 'clock', input: { tz: 'CST' } }
    ]
  })

  // tools：input_schema 取 parameters，缺省为 object schema；description 缺省为空串
  assert.deepEqual(b.tools[0], {
    name: 'weather',
    description: 'get weather',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  })
  assert.deepEqual(b.tools[1], { name: 'clock', description: '', input_schema: { type: 'object', properties: {} } })

  // tool_choice function -> {type:'tool', name}
  assert.deepEqual(b.tool_choice, { type: 'tool', name: 'weather' })
})

test('anthropic build：并行 tool_calls 的 tool_result 合并进同一个 user 消息', () => {
  const out = anthropic.build(clone(OPENAI_CHAT_FIXTURE))
  const b = out.body
  // 两条 role=tool 若各起一条 user 消息，会形成连续 user 轮，Anthropic 直接 400
  assert.equal(b.messages.length, 3, 'system 被抽出后应只有 user/assistant/user 三轮')
  assert.deepEqual(b.messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_a', content: 'sunny' },
      { type: 'tool_result', tool_use_id: 'call_b', content: '10:00' }
    ]
  })
})

test('anthropic build：thinking 预算整形（温度剔除、max_tokens 抬高、关闭档）', () => {
  const mk = (extra) => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra
  })

  // reasoning_effort=medium -> budget 8192；temperature/top_p 必须剔除；max_tokens 必须 > budget
  const b1 = anthropic.build(mk({ reasoning_effort: 'medium', temperature: 0.2, top_p: 0.8, max_tokens: 1000 })).body
  assert.deepEqual(b1.thinking, { type: 'enabled', budget_tokens: 8192 })
  assert.equal('temperature' in b1, false)
  assert.equal('top_p' in b1, false)
  assert.equal(b1.max_tokens, 8192 + 1024)

  // 已足够大的 max_tokens 不应被抬高
  const b2 = anthropic.build(mk({ reasoning_effort: 'medium', max_tokens: 20000 })).body
  assert.equal(b2.max_tokens, 20000)

  // 显式 budget_tokens 覆盖档位
  const b3 = anthropic.build(mk({ thinking: { type: 'enabled', budget_tokens: 4096 }, max_tokens: 4000 })).body
  assert.deepEqual(b3.thinking, { type: 'enabled', budget_tokens: 4096 })
  assert.equal(b3.max_tokens, 4096 + 1024)

  // 关闭档：不得生成 thinking，也不得剔除温度
  const b4 = anthropic.build(mk({ reasoning_effort: 'off', temperature: 0.2 })).body
  assert.equal('thinking' in b4, false)
  assert.equal(b4.temperature, 0.2)

  const b5 = anthropic.build(mk({ thinking: { type: 'disabled' }, temperature: 0.2 })).body
  assert.equal('thinking' in b5, false)
  assert.equal(b5.temperature, 0.2)

  // max_tokens 缺省回退 4096
  assert.equal(anthropic.build(mk({})).body.max_tokens, 4096)
})

test('anthropic build：tool_choice 四态映射', () => {
  const choice = (c) => anthropic.build({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: c }).body.tool_choice
  assert.deepEqual(choice('auto'), { type: 'auto' })
  assert.deepEqual(choice('required'), { type: 'any' })
  assert.deepEqual(choice('none'), { type: 'none' })
  assert.deepEqual(choice({ type: 'function', function: { name: 'f' } }), { type: 'tool', name: 'f' })
})

// ───────────────────────── Anthropic：响应体 ─────────────────────────
test('anthropic fromUpstream：content block 拼接、tool_calls、finish_reason、usage', () => {
  const out = anthropic.fromUpstream(clone(ANTHROPIC_MESSAGE_FIXTURE))
  assert.equal(out.object, 'chat.completion')
  assert.ok(out.id.startsWith('chatcmpl-'))
  assert.equal(typeof out.created, 'number')
  assert.equal(out.model, 'claude-wire')
  assert.equal(out.choices.length, 1)
  assert.equal(out.choices[0].index, 0)
  assert.equal(out.choices[0].message.role, 'assistant')
  assert.equal(out.choices[0].message.content, 'Hello world', 'thinking 块丢弃，文本块按序拼接')
  assert.equal(out.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(toolSummary(out.choices[0].message.tool_calls), [
    { id: 'toolu_1', type: 'function', name: 'weather', args: '{"city":"sz"}' },
    { id: 'toolu_2', type: 'function', name: 'clock', args: '{"tz":"CST"}' }
  ])
  // 原生 usage 字段保留（网关计费/缓存读取），同时补 OpenAI 三件套
  assert.deepEqual(out.usage, {
    input_tokens: 11,
    output_tokens: 7,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18
  })
})

test('anthropic fromUpstream：stop_reason 映射表与未知值收敛', () => {
  const finishOf = (stop_reason) => anthropic.fromUpstream({ content: [], stop_reason }).choices[0].finish_reason
  const expected = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    stop_sequence: 'stop',
    pause_turn: 'stop',
    refusal: 'stop',
    model_context_window_exceeded: 'length'
  }
  for (const [sr, expectedFinish] of Object.entries(expected)) assert.equal(finishOf(sr), expectedFinish, 'stop_reason=' + sr)
  assert.equal(finishOf('some_future_reason'), 'stop', '未知值收敛为 stop')
  assert.equal(finishOf(undefined), 'stop')

  // 纯文本响应不得带 tool_calls 字段
  const textOnly = anthropic.fromUpstream({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
  assert.equal('tool_calls' in textOnly.choices[0].message, false)
  assert.equal(textOnly.choices[0].finish_reason, 'stop')

  // 无内容/无 usage 时给 0 而不是虚报
  const empty = anthropic.fromUpstream({})
  assert.equal(empty.choices[0].message.content, '')
  assert.deepEqual(empty.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
})

test('anthropic SSE：extractStreamContent / extractStreamFinish 抽取契约', () => {
  for (const ev of ANTHROPIC_SSE_FIXTURE) {
    assert.equal(anthropic.extractStreamContent(ev.data), ev.content, 'content: ' + ev.data)
    assert.equal(anthropic.extractStreamFinish(ev.data), ev.finish, 'finish: ' + ev.data)
  }
  // message_delta 的 tool_use 也要转成 OpenAI 的 tool_calls
  assert.equal(anthropic.extractStreamFinish('{"type":"message_delta","delta":{"stop_reason":"tool_use"}}'), 'tool_calls')
  // [DONE] 与空串都不得抛异常
  assert.equal(anthropic.extractStreamContent('[DONE]'), '')
  assert.equal(anthropic.extractStreamFinish(''), '')
})

// ───────────────────────── Gemini：请求体 ─────────────────────────
test('gemini build：contents/systemInstruction/generationConfig/path', () => {
  const body = clone(OPENAI_CHAT_FIXTURE)
  delete body.messages[3].tool_calls
  delete body.messages[3].content
  body.messages = body.messages.slice(0, 3).concat([{ role: 'assistant', content: 'hi' }])
  delete body.tools
  delete body.tool_choice
  const before = JSON.stringify(body)
  const out = gemini.build(body)
  assert.equal(JSON.stringify(body), before, 'build 不得修改客户端请求体')

  assert.equal(out.path, '/v1beta/models/wire-model:streamGenerateContent?alt=sse')
  const b = out.body
  assert.deepEqual(b.systemInstruction, { parts: [{ text: 'sys-A\nsys-B' }] })
  // 图片丢弃、文本按 parts 顺序拼接（不得插入换行）
  assert.deepEqual(b.contents[0], { role: 'user', parts: [{ text: 'look now' }] })
  assert.deepEqual(b.contents[1], { role: 'model', parts: [{ text: 'hi' }] })
  assert.deepEqual(b.generationConfig, { temperature: 0.3, topP: 0.9, maxOutputTokens: 256 })
  assert.equal('tools' in b, false)
})

test('gemini build：无 stream -> generateContent；model 名做 URL 编码', () => {
  const out = gemini.build({ model: 'gem/x', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.path, '/v1beta/models/gem%2Fx:generateContent')
})

test('gemini build：tools 场景 path、functionDeclarations、tool_choice 映射', () => {
  const out = gemini.build(clone(OPENAI_CHAT_FIXTURE))
  // 工具 + 流式：路径固定为非流式端点；forward.js 会再把 body.stream 置 false 并降级为单帧 SSE
  assert.equal(out.path, '/v1beta/models/wire-model:generateContent')
  const b = out.body
  assert.deepEqual(b.tools[0].functionDeclarations[0], {
    name: 'weather',
    description: 'get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  })
  assert.deepEqual(b.tools[0].functionDeclarations[1], {
    name: 'clock',
    description: '',
    parameters: { type: 'object', properties: {} }
  })
  // tool_choice function -> toolConfig.functionCallingConfig（ANY + 允许名单）
  assert.deepEqual(b.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['weather'] } })

  // 其余三态
  const cfg = (c) => gemini.build({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: c }).body.toolConfig
  assert.deepEqual(cfg('auto'), { functionCallingConfig: { mode: 'AUTO' } })
  assert.deepEqual(cfg('required'), { functionCallingConfig: { mode: 'ANY' } })
  assert.deepEqual(cfg('none'), { functionCallingConfig: { mode: 'NONE' } })
})

test('gemini build：并行 tool_calls 的 functionResponse 合并进同一个 user turn', () => {
  const out = gemini.build(clone(OPENAI_CHAT_FIXTURE))
  const b = out.body
  // system 抽出后：user -> model -> user(functionResponse x2)
  assert.equal(b.contents.length, 3)
  assert.deepEqual(b.contents[2], {
    role: 'user',
    parts: [
      { functionResponse: { name: 'weather', response: { result: 'sunny' } } },
      { functionResponse: { name: 'clock', response: { result: '10:00' } } }
    ]
  })
})

test('gemini build：tool 消息缺 tool_call_id 时回退为 fn（有损，不做断言扩展）', () => {
  const out = gemini.build({ model: 'm', messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'r' }] })
  assert.equal(out.body.contents[1].parts[0].functionResponse.name, 'fn')
})

// ───────────────────────── Gemini：响应体 ─────────────────────────
test('gemini fromUpstream：文本/多 part 拼接、tool_calls、finish_reason、usage', () => {
  const out = gemini.fromUpstream(clone(GEMINI_RESPONSE_FIXTURE))
  assert.equal(out.model, 'gemini-wire')
  assert.equal(out.choices[0].message.content, 'Sunny in SZ')
  assert.equal(out.choices[0].finish_reason, 'tool_calls', '有 functionCall 时优先 tool_calls')
  const tcs = out.choices[0].message.tool_calls
  assert.equal(tcs.length, 1)
  assert.equal(tcs[0].type, 'function')
  assert.ok(tcs[0].id.startsWith('call_'), 'Gemini 无 call id，回填网关生成的 call_ id')
  assert.equal(tcs[0].function.name, 'weather')
  assert.equal(tcs[0].function.arguments, '{"city":"sz"}')
  // usageMetadata -> OpenAI usage；cachedContentTokenCount 保留为 prompt_tokens_details.cached_tokens
  assert.deepEqual(out.usage, {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 4 }
  })
  // safetyRatings 不映射（有损，见文档）
  assert.equal('safetyRatings' in out, false)
})

test('gemini fromUpstream：finishReason 映射与 promptFeedback 安全阻塞', () => {
  const finishOf = (fr) => gemini.fromUpstream({ candidates: [{ content: { parts: [] }, finishReason: fr }] }).choices[0].finish_reason
  const expected = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    BLOCKLIST: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    SPII: 'content_filter',
    RECITATION: 'content_filter',
    IMAGE_SAFETY: 'content_filter',
    LANGUAGE: 'content_filter',
    MALFORMED_FUNCTION_CALL: 'stop',
    OTHER: 'stop'
  }
  for (const [fr, expectedFinish] of Object.entries(expected)) assert.equal(finishOf(fr), expectedFinish, 'finishReason=' + fr)
  assert.equal(finishOf(undefined), 'stop')

  // 提示词被安全策略拦截：没有 candidates，也要给 content_filter 而不是 stop
  const blocked = gemini.fromUpstream({ promptFeedback: { blockReason: 'SAFETY' } })
  assert.equal(blocked.choices[0].message.content, '')
  assert.equal(blocked.choices[0].finish_reason, 'content_filter')
})

test('gemini fromUpstream：无 usageMetadata 时 usage 为 0（不虚报）', () => {
  const out = gemini.fromUpstream({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
  assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
})

test('gemini SSE：extractStreamContent 拼接全部 text part / extractStreamFinish 抽取', () => {
  for (const ev of GEMINI_SSE_FIXTURE) {
    assert.equal(gemini.extractStreamContent(ev.data), ev.content, 'content: ' + ev.data)
    assert.equal(typeof gemini.extractStreamFinish, 'function', 'Gemini 流式必须能抽取 finish_reason')
    assert.equal(gemini.extractStreamFinish(ev.data), ev.finish, 'finish: ' + ev.data)
  }
  assert.equal(gemini.extractStreamContent('[DONE]'), '')
  assert.equal(gemini.extractStreamFinish(''), '')
})

test('gemini fromUpstream：thought part 不混入 content，model 缺失时回退 modelVersion', () => {
  const out = gemini.fromUpstream({
    modelVersion: 'gemini-2.5-pro-001',
    candidates: [
      {
        content: { parts: [{ text: 'internal plan', thought: true }, { text: 'final answer' }] },
        finishReason: 'STOP'
      }
    ]
  })
  assert.equal(out.choices[0].message.content, 'final answer', 'thought 摘要不是回答正文')
  assert.equal(out.model, 'gemini-2.5-pro-001', 'Gemini 通常只回 modelVersion，不能把 model 留空')
  assert.equal(out.choices[0].finish_reason, 'stop')
})

test('gemini SSE：thought part 不混入 content', () => {
  assert.equal(
    gemini.extractStreamContent('{"candidates":[{"content":{"parts":[{"text":"plan","thought":true},{"text":"answer"}]}}]}'),
    'answer'
  )
})

// ───────────────────────── 公共导出 ─────────────────────────
test('adapterFor：仅 anthropic/gemini 有适配器，OpenAI 走透传', () => {
  assert.equal(adapterFor('anthropic'), anthropic)
  assert.equal(adapterFor('gemini'), gemini)
  assert.equal(adapterFor('openai'), null)
  assert.equal(adapterFor(undefined), null)
  assert.equal(adapterFor('unknown'), null)
})

test('hasTools：空 tools 数组不算带工具', () => {
  assert.equal(hasTools({}), false)
  assert.equal(hasTools({ tools: [] }), false)
  assert.equal(hasTools({ tools: [{ type: 'function', function: { name: 'f' } }] }), true)
  assert.equal(hasTools({ tool_choice: 'auto' }), true)
})

test('makeOA：OpenAI chat.completion 形状与 usage 缺省', () => {
  const out = makeOA('m', 'text', undefined, { toolCalls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] })
  assert.equal(out.object, 'chat.completion')
  assert.equal(out.model, 'm')
  assert.equal(out.choices[0].index, 0)
  assert.equal(out.choices[0].message.content, 'text')
  assert.equal(out.choices[0].finish_reason, 'stop')
  assert.equal(out.choices[0].message.tool_calls.length, 1)
  assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })

  const noTools = makeOA('', '', '', {})
  assert.equal('tool_calls' in noTools.choices[0].message, false)
  assert.equal(noTools.choices[0].finish_reason, 'stop')
})

test('cacheHitMiss：四桶口径按协议取数', () => {
  assert.deepEqual(cacheHitMiss('anthropic', { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }), { hit: 7, miss: 8 })
  assert.deepEqual(cacheHitMiss('gemini', { usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4 } }), { hit: 4, miss: 6 })
  assert.deepEqual(cacheHitMiss('openai', { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 } }), { hit: 4, miss: 6 })
  assert.deepEqual(cacheHitMiss('openai', { prompt_tokens: 10, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 8 }), { hit: 2, miss: 8 })
  assert.deepEqual(cacheHitMiss('openai', { prompt_tokens: 10, prompt_tokens_details: { cache_write_tokens: 3 } }), { hit: 0, miss: 10 })
  assert.deepEqual(cacheHitMiss('openai', { prompt_tokens: 10 }), { hit: 0, miss: 10 })
  assert.deepEqual(cacheHitMiss('openai', { prompt_tokens: 0 }), { hit: 0, miss: 0 })
  assert.deepEqual(cacheHitMiss('openai', null), { hit: 0, miss: 0 })
  assert.deepEqual(cacheHitMiss('anthropic', { input_tokens: 'x', cache_read_input_tokens: -1 }), { hit: 0, miss: 0 })
})
