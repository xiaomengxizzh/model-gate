import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'

test('统一用量与结构化日志：真实 HTTP 逻辑请求/尝试/Token 同账', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream((req, res) => {
    if (upstream.hits.length === 1) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'ok', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
  })
  const gw = await startGateway({ name: 'v13-observability', config: { providers: { p1: { baseUrl: upstream.base }, p2: { baseUrl: upstream.base } }, models: { demo: { provider: 'p1', fallbacks: ['p2'] } }, defaults: { requestBudget: { maxTotalAttempts: 2, maxAttemptsPerCandidate: 1 } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const response = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 200, await response.text())
  const usage = await (await gw.get('/api/usage/summary?days=1')).json()
  assert.equal(usage.gateway.logicalRequests, 1)
  assert.equal(usage.gateway.upstreamAttempts, 2)
  assert.equal(usage.gateway.completedRequests, 1)
  assert.equal(usage.gateway.tokens, 5)
  assert.equal(usage.gateway.cost, null)
  assert.equal(usage.models.find((item) => item.name === 'demo').tokens, 5)

  const logs = await (await gw.get('/api/logs/structured?limit=100')).json()
  assert.equal(logs.contract, 'mg-logs/1')
  assert.ok(logs.items.length > 0)
  assert.ok(logs.items.every((item) => typeof item.message === 'string'))
  const filtered = await (await gw.get('/api/logs/structured?level=error&limit=10')).json()
  assert.ok(filtered.items.every((item) => item.level === 'error'))
})
