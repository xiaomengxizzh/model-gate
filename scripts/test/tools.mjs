// Anthropic / Gemini tools 协议转换（MG-004：自建隔离实例，不再读写目标网关配置）。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

// Anthropic tools：请求转换(tools/input_schema) + 响应 tool_calls + 流式降级为一次性 SSE
{
  let reqBody = null
  const up = await startMockServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { reqBody = JSON.parse(b); if (reqBody.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"sz\\"}"}}\n\n'); res.write('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'); res.end() } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'sz' } }], stop_reason: 'tool_use' })) } }) })
  const fx = await startGateway({
    name: 'tools-anthropic',
    config: {
      providers: { 't-to': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'anthropic' } },
      models: { 't-to-m': { provider: 't-to', alias: [], fallbacks: [], maxConcurrent: 0 } },
    },
  })
  try {
    const body = { model: 't-to-m', messages: [{ role: 'user', content: '天气?' }], tools: [{ type: 'function', function: { name: 'get_weather', description: '天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }], tool_choice: 'auto' }
    const j1 = await (await fx.chat('t-to-m', false, body)).json()
    const tc = j1.choices && j1.choices[0].message && j1.choices[0].message.tool_calls
    check('tools·请求转换(tools+tool_choice)', reqBody.tools && reqBody.tools[0].input_schema && reqBody.tool_choice.type === 'auto', { tools: !!(reqBody.tools && reqBody.tools.length) })
    check('tools·非流式响应还原 tool_calls', tc && tc.length && tc[0].function.name === 'get_weather' && j1.choices[0].finish_reason === 'tool_calls', { name: tc && tc[0] && tc[0].function.name })
    const stext = await (await fx.chat('t-to-m', true, body)).text()
    const jsonSt = [...stext.matchAll(/data:\s*([^\n]+)/g)].map(m => m[1])
    check('tools·流式降级为一次性 SSE(含 tool_calls)', jsonSt.some(s => s.includes('tool_calls') && !s.includes('[DONE]')), { n: jsonSt.length })
  } finally {
    await fx.stop(); await up.stop()
  }
}

// Gemini tools（非流式）
{
  let reqBody = null
  const up = await startMockServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { reqBody = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'calc', args: { a: 1 } } }] } }] })) }) })
  const fx = await startGateway({
    name: 'tools-gemini',
    config: {
      providers: { 't-tg': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'gemini' } },
      models: { 't-tg-m': { provider: 't-tg', alias: [], fallbacks: [], maxConcurrent: 0 } },
    },
  })
  try {
    const body = { model: 't-tg-m', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'calc', parameters: { type: 'object', properties: { a: { type: 'number' } } } } }] }
    const j1 = await (await fx.chat('t-tg-m', false, body)).json()
    const tc = j1.choices && j1.choices[0].message && j1.choices[0].message.tool_calls
    check('Gemini tools·functionDeclarations + tool_calls', reqBody.tools && reqBody.tools[0].functionDeclarations && tc && tc[0].function.name === 'calc', { ok: !!(reqBody.tools && tc && tc[0]) })
  } finally {
    await fx.stop(); await up.stop()
  }
}
finish('tools')
