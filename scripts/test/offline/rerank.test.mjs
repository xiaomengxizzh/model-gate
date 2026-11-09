// MG-012 Rerank：capability=rerank、/v1/rerank 入口、OpenAI/Cohere 上游、排序与 top_n、记账、能力隔离、fallback、探测、预算。
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
const RERANK_OK = {
  results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }],
  usage: { total_tokens: 6 },
}

test('OpenAI 兼容 rerank：透传、稳定排序、top_n、model 回写与记账', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(RERANK_OK))
  })
  const gw = await startGateway({ name: 'mg012-oa', config: { providers: { mock: { baseUrl: upstream.base } }, models: { rr: { provider: 'mock', capability: 'rerank' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/rerank', { model: 'rr', query: 'q', documents: ['a', 'b'], top_n: 2 }, json())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.model, 'rr')
  assert.equal(body.results.length, 2)
  assert.equal(body.results[0].index, 1, '按 relevance_score 降序')
  assert.equal(body.results[0].relevance_score, 0.9)
  assert.equal(body.results[1].index, 0)
  const hit = upstream.hits[0]
  assert.equal(hit.url, '/v1/rerank')
  assert.equal(hit.body.model, 'rr')
  assert.equal(hit.body.query, 'q')
  assert.deepEqual(hit.body.documents, ['a', 'b'])
  assert.equal(hit.body.top_n, 2)

  const st = await (await gw.get('/api/status')).json()
  const m = st.models.find((x) => x.name === 'rr')
  assert.equal(m.capability, 'rerank')
  assert.equal(m.requests, 1)
  assert.equal(m.tokens, 6, 'usage token 计入账本')
})

test('Cohere rerank：/v2/rerank 路径与请求体，响应保留 meta', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r1', results: [{ index: 0, relevance_score: 0.5, document: { text: 'a' } }], meta: { billed_units: { search_units: 1 } } }))
  })
  const gw = await startGateway({ name: 'mg012-co', config: { providers: { mock: { baseUrl: upstream.base, api: 'cohere' } }, models: { rr: { provider: 'mock', capability: 'rerank' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/rerank', { model: 'rr', query: 'q', documents: ['a'], return_documents: true }, json())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.results[0].document.text, 'a')
  assert.equal(body.meta.billed_units.search_units, 1, 'Cohere meta 原样保留')
  assert.equal(upstream.hits[0].url, '/v2/rerank', 'Cohere 上游走 v2/rerank')
})

test('rerank 能力隔离：rerank 模型不能 chat/embeddings，chat 模型不能 rerank', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(RERANK_OK)) })
  const gw = await startGateway({ name: 'mg012-cap', config: { providers: { mock: { baseUrl: upstream.base } }, models: { rr: { provider: 'mock', capability: 'rerank' }, chat: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const a = await gw.post('/v1/chat/completions', { model: 'rr', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(a.status, 400); assert.equal((await a.json()).error.type, 'unsupported_model')
  const b = await gw.post('/v1/embeddings', { model: 'rr', input: 'x' }, json())
  assert.equal(b.status, 400); assert.equal((await b.json()).error.type, 'unsupported_model')
  const c = await gw.post('/v1/rerank', { model: 'chat', query: 'q', documents: ['a'] }, json())
  assert.equal(c.status, 400); assert.equal((await c.json()).error.type, 'unsupported_model')
  assert.equal(upstream.hits.length, 0)
})

test('rerank fallback：主上游 500 → 备用成功', { timeout: 30000 }, async (t) => {
  const p1 = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} ; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}') })
  const p2 = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} ; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(RERANK_OK)) })
  const gw = await startGateway({ name: 'mg012-fb', config: { providers: { p1: { baseUrl: p1.base }, p2: { baseUrl: p2.base } }, models: { rr: { provider: 'p1', fallbacks: ['p2'], capability: 'rerank' } } } })
  t.after(async () => { await gw.stop(); await p1.stop(); await p2.stop() })
  const res = await gw.post('/v1/rerank', { model: 'rr', query: 'q', documents: ['a'] }, json())
  assert.equal(res.status, 200)
  assert.equal(p1.hits.length, 1); assert.equal(p2.hits.length, 1)
})

test('rerank 校验：documents 空/含非字符串、top_n 非法 → 400 且不触上游', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  const gw = await startGateway({ name: 'mg012-val', config: { providers: { mock: { baseUrl: upstream.base } }, models: { rr: { provider: 'mock', capability: 'rerank' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  for (const body of [
    { model: 'rr', query: 'q', documents: [] },
    { model: 'rr', query: 'q', documents: ['a', 1] },
    { model: 'rr', query: '', documents: ['a'] },
    { model: 'rr', query: 'q', documents: ['a'], top_n: 0 },
  ]) {
    assert.equal((await gw.post('/v1/rerank', body, json())).status, 400, JSON.stringify(body))
  }
  assert.equal(upstream.hits.length, 0)
})

test('rerank 探测与预算：/api/model-test 走 rerank 端点；慢上游受 overallMs 约束', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    if (rec.index === 0) {
      rec.body = await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(RERANK_OK)); return
    }
    await new Promise((resolve) => { res.on('close', resolve); setTimeout(resolve, 4000).unref?.() })
    if (!res.writableEnded && !res.destroyed) { try { res.destroy() } catch {} }
  })
  const gw = await startGateway({
    name: 'mg012-probe',
    config: { defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000, overallMs: 300 } }, providers: { mock: { baseUrl: upstream.base } }, models: { rr: { provider: 'mock', capability: 'rerank' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const pr = await gw.post('/api/model-test', { id: 'rr' }, json())
  assert.equal(pr.status, 200)
  assert.equal((await pr.json()).result.ok, true)
  assert.equal(upstream.hits[0].url, '/v1/rerank', '探测按 capability 走 rerank')
  const t0 = Date.now()
  const slow = await gw.post('/v1/rerank', { model: 'rr', query: 'q', documents: ['a'] }, json())
  assert.equal(slow.status, 504)
  assert.equal((await slow.json()).error.type, 'request_timeout')
  assert.ok(Date.now() - t0 < 2500)
})
