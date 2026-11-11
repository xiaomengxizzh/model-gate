import test from 'node:test'
import assert from 'node:assert/strict'
import { bridge, responsesToChat } from '../../../src/responses.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const json = () => ({ 'content-type': 'application/json' })
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}
const RESP = { id: 'resp_hosted', object: 'response', status: 'completed', model: 'vendor-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], output_text: 'ok', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
const CHAT = { id: 'chat_hosted', object: 'chat.completion', model: 'vendor-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }

test('hosted tools: bridge() 默认严格 typedUnsupported；显式有损/兼容预设才丢弃（不得静默）', () => {
  const tools = [
    { type: 'web_search' },
    { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn', description: 'spawn', parameters: { type: 'object' } }] },
    { type: 'function', name: 'ping', description: 'ping', parameters: { type: 'object' } },
  ]
  const strict = bridge({ model: 'bridge', input: 'hi', tools })
  assert.equal(strict.body, null, 'bridge() 默认不得丢弃无法表达的工具')
  assert.equal(strict.rejected.code, 'unsupported_tool')
  assert.match(strict.rejected.message, /web_search/)

  const compat = responsesToChat({ model: 'bridge', input: 'hi', tools })
  assert.equal(compat.rejected, null, '产品便捷入口保留旧客户端兼容（显式 LEGACY_BRIDGE_COMPAT）')
  const names = compat.body.tools.map((t) => t.function.name)
  assert.ok(names.includes('ping'), '可表达 function tool 保留')
  assert.ok(names.includes('mg_ns__multi_agent_v1__spawn'), 'namespace 可逆展开')
  assert.equal(names.some((n) => n.includes('web_search')), false)
  assert.ok(compat.lossy.includes('tool_dropped:web_search'), '丢弃必须显式记 lossy')

  const explicit = bridge({ model: 'bridge', input: 'hi', tools }, { onUnsupportedTool: 'drop' })
  assert.equal(explicit.rejected, null, '显式有损模式才允许丢弃')
})

test('hosted tools: native Responses preserves web_search/namespace; Chat bridge drops them explicitly', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url.endsWith('/responses') ? RESP : CHAT))
  })
  const gw = await startGateway({
    name: 'hosted-tools',
    config: {
      providers: { mock: { baseUrl: upstream.base, api: 'openai' } },
      models: {
        native: { provider: 'mock', api: 'responses', providerModels: { mock: 'vendor-model' } },
        bridge: { provider: 'mock' },
      },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const tools = [
    { type: 'web_search' },
    { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn', description: 'spawn', parameters: { type: 'object' } }] },
    { type: 'function', name: 'ping', description: 'ping', parameters: { type: 'object' } },
  ]

  const nativeRes = await gw.post('/v1/responses', { model: 'native', input: 'hi', tools, tool_choice: 'auto' }, json())
  assert.equal(nativeRes.status, 200)
  const nativeHit = upstream.hits.find((h) => h.url.endsWith('/responses'))
  assert.ok(nativeHit, 'native model must use /v1/responses')
  assert.equal(nativeHit.body.tools.length, 3, 'native path keeps all hosted tools')
  assert.ok(nativeHit.body.tools.some((x) => x.type === 'web_search'))
  assert.ok(nativeHit.body.tools.some((x) => x.type === 'namespace'))

  const bridgeRes = await gw.post('/v1/responses', { model: 'bridge', input: 'hi', tools, tool_choice: 'auto' }, json())
  assert.equal(bridgeRes.status, 200)
  const bridgeHit = upstream.hits.find((h) => h.url.endsWith('/chat/completions'))
  assert.ok(bridgeHit, 'bridge model must use /v1/chat/completions')
  const chatTools = Array.isArray(bridgeHit.body.tools) ? bridgeHit.body.tools : []
  assert.equal(chatTools.some((x) => x.type === 'web_search'), false, 'web_search cannot be represented in Chat')
  assert.equal(chatTools.some((x) => x.type === 'namespace'), false, 'namespace cannot be represented in Chat')
  assert.ok(chatTools.some((x) => x.type === 'function' && x.function && x.function.name === 'ping'), 'function tools survive')

  const st = await (await gw.get('/api/status')).json()
  assert.equal(st.models.find((m) => m.name === 'native').hostedTools, 'native')
  assert.equal(st.models.find((m) => m.name === 'bridge').hostedTools, 'chat-bridge-lossy')
})
