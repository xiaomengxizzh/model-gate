// G2：/v1/responses 一等入口——转换保真、SSE 事件顺序、call_id、usage、原生直通、治理与错误。
import { startGateway, mockUpstream, check, summary, readSse, sseStart, sseWrite, CLIENT } from './harness.mjs'

let chatMode = 'text'
const chatHits = []
const chat = await mockUpstream((req, res, body) => {
  const j = JSON.parse(body || '{}')
  chatHits.push(j)
  if (chatMode === '429') { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); res.end('{"error":{"message":"Too many requests"}}'); return }
  if (chatMode === 'tool-json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    return
  }
  if (chatMode === 'custom-json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }))
    return
  }
  if (j.stream) {
    sseStart(res)
    sseWrite(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }] })
    sseWrite(res, { choices: [{ index: 0, delta: { content: '，世界' } }] })
    sseWrite(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'shell', arguments: '{"cmd":' } }] } }] })
    sseWrite(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] })
    sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    sseWrite(res, '[DONE]')
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '普通回答' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }))
})

let nativeHits = 0
const native = await mockUpstream((req, res) => {
  nativeHits++
  sseStart(res)
  res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: 'resp_native', status: 'in_progress', output: [] } }) + '\n\n')
  res.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'native-hello' }) + '\n\n')
  res.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', sequence_number: 2, response: { id: 'resp_native', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }) + '\n\n')
  res.end()
})

const gw = await startGateway({
  defaults: { budget: { maxAttempts: 2, maxMs: 4000, maxWaitMs: 500 }, retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 } },
  providers: {
    chat: { baseUrl: chat.url, apiKeyEnv: '', api: 'openai' },
    native: { baseUrl: native.url, apiKeyEnv: '', api: 'responses' },
    mism: { baseUrl: chat.url, apiKeyEnv: '', api: 'openai' },
  },
  models: {
    'm-chat': { provider: 'chat' },
    'm-upstream-id': { provider: 'chat', upstreamModel: 'real-model-9' },
    'm-native': { provider: 'native', responsesWire: 'native' },
    'm-mismatch': { provider: 'mism', responsesWire: 'native' },
  },
})

// 1. 鉴权
const noKey = await fetch(gw.base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm-chat', input: 'x' }) })
check('Responses 无客户端 Key → 401', noKey.status === 401, { status: noKey.status })

// 2. 非流式文本 + instructions + tools 转换
chatMode = 'text'; chatHits.length = 0
const r1 = await gw.responses({ model: 'm-chat', instructions: 'be nice', input: 'hi', max_output_tokens: 32, temperature: 0.2 })
const j1 = await r1.json()
check('Responses 非流式 200 + output_text', r1.status === 200 && j1.object === 'response' && j1.output_text === '普通回答', { status: r1.status, text: j1.output_text })
check('Responses 非流式 usage 映射', j1.usage && j1.usage.input_tokens === 4 && j1.usage.output_tokens === 2 && j1.usage.total_tokens === 6, { usage: j1.usage })
const conv1 = chatHits[0]
check('instructions → system，max_output_tokens → max_tokens', conv1.messages[0].role === 'system' && conv1.messages[0].content === 'be nice' && conv1.max_tokens === 32 && conv1.temperature === 0.2, { messages: conv1.messages, max: conv1.max_tokens })

// 3. 流式文本 + 工具调用：事件顺序 / call_id / usage
chatMode = 'stream'; chatHits.length = 0
const r2 = await gw.responses({ model: 'm-chat', input: 'run', stream: true, tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }] })
const { events } = await readSse(r2)
const types = events.map(e => e.event)
check('Responses 流式 200 且首事件 response.created', r2.status === 200 && types[0] === 'response.created' && types[1] === 'response.in_progress', { first: types.slice(0, 2) })
const iAdded = types.indexOf('response.output_item.added')
const iPart = types.indexOf('response.content_part.added')
const iDelta = types.indexOf('response.output_text.delta')
check('事件顺序：output_item.added → content_part.added → output_text.delta', iAdded >= 0 && iAdded < iPart && iPart < iDelta, { iAdded, iPart, iDelta })
const completed = events.find(e => e.event === 'response.completed')
check('流式 response.completed 输出 message + function_call', !!completed && completed.data.response.output.some(i => i.type === 'message') && completed.data.response.output.some(i => i.type === 'function_call'), { output: completed && completed.data.response.output.map(i => i.type) })
const fc = completed.data.response.output.find(i => i.type === 'function_call')
check('工具 call_id 原样保留 + 参数拼接完整', fc && fc.call_id === 'call_abc' && fc.name === 'shell' && JSON.parse(fc.arguments).cmd === 'ls', { fc })
check('流式 usage 映射（input/output/total）', completed.data.response.usage.input_tokens === 10 && completed.data.response.usage.total_tokens === 15, { usage: completed.data.response.usage })
check('响应 model 回写为客户端请求名', completed.data.response.model === 'm-chat', { model: completed.data.response.model })
check('流式上游收到 stream_options.include_usage', chatHits[0].stream === true && chatHits[0].stream_options && chatHits[0].stream_options.include_usage === true, { so: chatHits[0].stream_options })
check('Responses 流带 x-mg-attempts 响应头', r2.headers.get('x-mg-attempts') != null, { attempts: r2.headers.get('x-mg-attempts') })

// 4. previous_response_id 明确 422，且不请求上游
chatHits.length = 0
const r3 = await gw.responses({ model: 'm-chat', input: 'x', previous_response_id: 'resp_prev' })
const j3 = await r3.json()
check('previous_response_id → 422 且不转发', r3.status === 422 && j3.error.code === 'unsupported_previous_response' && chatHits.length === 0, { status: r3.status, code: j3.error && j3.error.code })

// 5. input_file 不静默丢弃 → 422
const r4 = await gw.responses({ model: 'm-chat', input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'f1' }] }] })
const j4 = await r4.json()
check('input_file → 422（不静默丢字段）', r4.status === 422 && /input_file/.test(j4.error.message), { status: r4.status })

// 6. custom tool：Chat 侧映射为 input 参数，回写还原为 custom_tool_call
chatMode = 'custom-json'; chatHits.length = 0
const r5 = await gw.responses({ model: 'm-chat', input: 'patch it', tools: [{ type: 'custom', name: 'apply_patch', description: 'apply a patch' }] })
const j5 = await r5.json()
const custom = (j5.output || []).find(i => i.type === 'custom_tool_call')
check('custom tool 入站映射为 function(input) 参数', chatHits[0].tools[0].function.name === 'apply_patch' && chatHits[0].tools[0].function.parameters.required.includes('input'), { tools: chatHits[0].tools })
check('custom tool 出站还原 custom_tool_call + call_id', !!custom && custom.call_id === 'call_patch' && custom.input === '*** Begin Patch', { custom })

// 7. 上游 model id 分离
chatMode = 'text'; chatHits.length = 0
const r6 = await gw.responses({ model: 'm-upstream-id', input: 'x' })
const j6 = await r6.json()
check('models.upstreamModel 生效（上游收到真实 id）', chatHits[0].model === 'real-model-9' && j6.model === 'm-upstream-id', { upstream: chatHits[0].model, client: j6.model })

// 8. 原生 Responses 直通：事件不改写
const r7 = await gw.responses({ model: 'm-native', input: 'x', stream: true })
const s7 = await r7.text()
check('native responses 直通 SSE（保留 response.completed）', r7.status === 200 && /response\.completed/.test(s7) && /native-hello/.test(s7), { nativeHits })

// 9. wire 声明不一致 → 422（不静默降级到 Chat）
const r8 = await gw.responses({ model: 'm-mismatch', input: 'x' })
const j8 = await r8.json()
check('wire_mismatch → 422', r8.status === 422 && j8.error.code === 'wire_mismatch', { status: r8.status, code: j8.error && j8.error.code })

// 10. 429 透传：保留 Retry-After + 归因
chatMode = '429'
const r9 = await gw.responses({ model: 'm-chat', input: 'x' })
const j9 = await r9.json()
check('Responses 429 → HTTP 429 + retry-after + 归因', r9.status === 429 && r9.headers.get('retry-after') != null && j9.error.attribution === 'rate_limit' && !!j9.error.trace_id, { status: r9.status, ra: r9.headers.get('retry-after'), attribution: j9.error && j9.error.attribution })

// 11. 上传体的工具定义在响应式请求中不被重放（非幂等）
chatMode = '429'; chatHits.length = 0
const r10 = await gw.responses({ model: 'm-chat', input: 'run', tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }] })
check('Responses + tools 429 不重放（上游仅 1 次）', r10.status === 429 && chatHits.length === 1, { status: r10.status, hits: chatHits.length })

await gw.close()
await chat.close()
await native.close()
export { summary }
