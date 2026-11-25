import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'

test('统一请求预算：真实 HTTP 全链最多三次发送且工具失败不重放', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream((req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); res.end(JSON.stringify({ error: 'fixture failure' })) })
  const gw = await startGateway({ name: 'v13-request-budget', config: {
    providers: { p1: { baseUrl: upstream.base }, p2: { baseUrl: upstream.base }, p3: { baseUrl: upstream.base } },
    models: { demo: { provider: 'p1', fallbacks: ['p2', 'p3'] } },
    defaults: { requestBudget: { maxTotalAttempts: 3, maxFailovers: 5, maxAttemptsPerCandidate: 2, maxWaitMs: 1000 } },
  } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const failed = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(failed.status, 429)
  assert.equal(upstream.hits.length, 3)

  const tool = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'danger', parameters: { type: 'object' } } }] })
  assert.equal(tool.status, 429)
  assert.equal(upstream.hits.length, 4, '工具/非幂等请求失败后不换候选重放')
})

test('统一请求预算：A/B 失败 C 成功时精确三次上游回执', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream((req, res) => {
    if (upstream.hits.length < 3) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'ok', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({ name: 'v13-request-budget-success', config: {
    providers: { p1: { baseUrl: upstream.base }, p2: { baseUrl: upstream.base }, p3: { baseUrl: upstream.base } },
    models: { demo: { provider: 'p1', fallbacks: ['p2', 'p3'] } },
    defaults: { requestBudget: { maxTotalAttempts: 3, maxFailovers: 5, maxAttemptsPerCandidate: 1, maxWaitMs: 1000 } },
  } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const response = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 200, await response.text())
  assert.equal(upstream.hits.length, 3)
})
