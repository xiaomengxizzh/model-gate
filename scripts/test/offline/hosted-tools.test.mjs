import test from 'node:test'
import assert from 'node:assert/strict'
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
