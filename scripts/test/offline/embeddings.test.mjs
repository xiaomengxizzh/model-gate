// MG-011 Embedding：能力声明、/v1/embeddings 入口、OpenAI/Gemini 适配、记账、模型发现、能力隔离、探测与预算。
// 全部离线：本地 mock 上游；不触真实上游/凭据。
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
const EMB_OK = { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'vendor-embed', usage: { prompt_tokens: 4, total_tokens: 4 } }

test('OpenAI embedding：请求透传、model 回写、记账与模型发现', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Object.assign({}, EMB_OK, { data: [EMB_OK.data[0], { object: 'embedding', index: 1, embedding: [0.3] }] })))
  })
  const gw = await startGateway({ name: 'mg011-oa', config: { providers: { mock: { baseUrl: upstream.base } }, models: { emb: { provider: 'mock', capability: 'embedding' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/embeddings', { model: 'emb', input: ['a', 'b'] }, json())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.object, 'list')
  assert.equal(body.data.length, 2)
  assert.equal(body.data[0].embedding[0], 0.1)
  assert.equal(body.model, 'emb', '响应 model 回写客户端请求名')

  const hit = upstream.hits[0]
  assert.equal(hit.url, '/v1/embeddings', 'OpenAI 上游走 embeddings 路径')
  assert.equal(hit.body.model, 'emb')
  assert.deepEqual(hit.body.input, ['a', 'b'])

  const st = await (await gw.get('/api/status')).json()
  const m = st.models.find((x) => x.name === 'emb')
  assert.equal(m.capability, 'embedding', 'status 暴露 capability')
  assert.equal(m.requests, 1, 'embedding 请求计入模型请求数')
  assert.equal(m.tokens, 4, 'usage tokens 计入模型额度账本')
  assert.equal(st.global.tokenCount, 4, '全局 token 计数')
  const list = await (await gw.get('/v1/models')).json()
  assert.equal(list.data.find((x) => x.id === 'emb').capability, 'embedding', '/v1/models 暴露 capability')

  // 保存校验：未知 capability 被拒
  const bad = await gw.post('/api/config/save', { models: { x: { provider: 'mock', capability: 'foo' } } }, json())
  assert.equal(bad.status, 400)
})

test('能力隔离：embedding 模型不能走对话入口，chat 模型不能走 embeddings', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(EMB_OK)) })
  const gw = await startGateway({ name: 'mg011-cap', config: { providers: { mock: { baseUrl: upstream.base } }, models: { emb: { provider: 'mock', capability: 'embedding' }, chat: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const e1 = await gw.post('/v1/chat/completions', { model: 'emb', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(e1.status, 400)
  assert.equal((await e1.json()).error.type, 'unsupported_model')
  const e2 = await gw.post('/v1/embeddings', { model: 'chat', input: 'x' }, json())
  assert.equal(e2.status, 400)
  assert.equal((await e2.json()).error.type, 'unsupported_model')
  assert.equal(upstream.hits.length, 0, '能力隔离拒绝不得触达上游')
})

test('Gemini embedding：batchEmbedContents 路径/请求体/协议头与响应归一', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }))
  })
  const gw = await startGateway({ name: 'mg011-gem', config: { providers: { mock: { baseUrl: upstream.base, api: 'gemini', apiKey: 'gem-key' } }, models: { 'emb-g': { provider: 'mock', capability: 'embedding' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  // 网关的上游 Key 走加密 keys 库（配置里的 apiKey 字段不消费），先写入 key 再验证协议头
  assert.equal((await gw.post('/api/keys', { id: 'mock', key: 'gem-key' }, json())).status, 200)

  const res = await gw.post('/v1/embeddings', { model: 'emb-g', input: ['a', 'b'], dimensions: 2 }, json())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.data[0].embedding, [0.1, 0.2])
  assert.deepEqual(body.data[1].embedding, [0.3, 0.4])
  assert.equal(body.model, 'emb-g')
  assert.equal(body.usage.total_tokens, 0, 'Gemini 不返回 usage 时不臆造')

  const hit = upstream.hits[0]
  assert.match(hit.url, /^\/v1beta\/models\/emb-g:batchEmbedContents$/)
  assert.equal(hit.body.requests[0].content.parts[0].text, 'a')
  assert.equal(hit.body.requests[1].content.parts[0].text, 'b')
  assert.equal(hit.body.requests[0].outputDimensionality, 2)
  assert.equal(hit.headers['x-goog-api-key'], 'gem-key')
})

test('Anthropic 无 embedding 能力：明确失败且不触上游', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  const gw = await startGateway({ name: 'mg011-ant', config: { providers: { mock: { baseUrl: upstream.base, api: 'anthropic' } }, models: { emb: { provider: 'mock', capability: 'embedding' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const res = await gw.post('/v1/embeddings', { model: 'emb', input: 'x' }, json())
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error.type, 'all_providers_failed')
  assert.equal(upstream.hits.length, 0)
})

test('embedding fallback：主上游 500 → 备用成功并记账', { timeout: 30000 }, async (t) => {
  const p1 = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} ; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}') })
  const p2 = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} ; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(EMB_OK)) })
  const gw = await startGateway({
    name: 'mg011-fb',
    config: { providers: { p1: { baseUrl: p1.base }, p2: { baseUrl: p2.base } }, models: { emb: { provider: 'p1', fallbacks: ['p2'], capability: 'embedding' } } },
  })
  t.after(async () => { await gw.stop(); await p1.stop(); await p2.stop() })
  const res = await gw.post('/v1/embeddings', { model: 'emb', input: 'x' }, json())
  assert.equal(res.status, 200)
  assert.equal((await res.json()).data.length, 1)
  assert.equal(p1.hits.length, 1, '主上游被尝试')
  assert.equal(p2.hits.length, 1, '备用上游生效')
})

test('embedding 探测：/api/model-test 走 embeddings 端点', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(EMB_OK))
  })
  const gw = await startGateway({ name: 'mg011-probe', config: { providers: { mock: { baseUrl: upstream.base } }, models: { emb: { provider: 'mock', capability: 'embedding' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const r = await gw.post('/api/model-test', { id: 'emb' }, json())
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.result.ok, true)
  assert.equal(upstream.hits[0].url, '/v1/embeddings', '探测按 capability 选择 embedding 端点')
  assert.deepEqual(upstream.hits[0].body.input, ['ping'])
})

test('embedding 预算：慢上游受 overallMs 约束 → 504 request_timeout', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await new Promise((resolve) => { res.on('close', resolve); setTimeout(resolve, 4000).unref?.() })
    if (!res.writableEnded && !res.destroyed) { try { res.destroy() } catch {} }
  })
  const gw = await startGateway({
    name: 'mg011-budget',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000, overallMs: 300 } },
      providers: { mock: { baseUrl: upstream.base } },
      models: { emb: { provider: 'mock', capability: 'embedding' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const t0 = Date.now()
  const res = await gw.post('/v1/embeddings', { model: 'emb', input: 'x' }, json())
  assert.equal(res.status, 504)
  assert.equal((await res.json()).error.type, 'request_timeout')
  assert.ok(Date.now() - t0 < 2500)
})


// ============================================================================
// F04 接线：可选端点能力门（config → 501，且零上游调用）+ 配置只接受已证实能力
// ============================================================================

test('F04 可选端点关闭：defaults.optionalEndpoints.embedding=false → 501 且零上游调用', { timeout: 30000 }, async (t) => {
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    hits.push({ url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(EMB_OK))
  })
  const gw = await startGateway({
    name: 'f04-optional-off',
    config: {
      defaults: { optionalEndpoints: { embedding: false } },
      providers: { mock: { baseUrl: upstream.base } },
      models: { emb: { provider: 'mock', capability: 'embedding' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/embeddings', { model: 'emb', input: 'hi' }, json())
  assert.equal(res.status, 501, '关闭的可选端点必须显式 501（不是 404/静默放行）')
  const body = await res.json()
  assert.equal(body.error.code, 'optional_endpoint_disabled')
  assert.equal(body.error.capability, 'embedding')
  assert.equal(body.error.reason, 'disabled_by_config')
  assert.equal(hits.length, 0, '禁用态零上游调用')
})

test('F04 可选端点配置：只接受已证实能力，未知能力名/非法形状 → 400 且不落盘', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(EMB_OK))
  })
  const gw = await startGateway({ name: 'f04-optional-config', config: { providers: { mock: { baseUrl: upstream.base } }, models: { emb: { provider: 'mock', capability: 'embedding' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const unknown = await gw.post('/api/config/save', { defaults: { optionalEndpoints: { brand_new_modal: false } } })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /未证实/)

  const badShape = await gw.post('/api/config/save', { defaults: { optionalEndpoints: { embedding: 'off' } } })
  assert.equal(badShape.status, 400)

  // 合法形状可保存并在下一请求生效
  assert.equal((await gw.post('/api/config/save', { defaults: { optionalEndpoints: { embedding: false, rerank: { enabled: false, reason: 'contract_not_signed_off' } } } })).status, 200)
  const disabled = await gw.post('/v1/embeddings', { model: 'emb', input: 'hi' }, json())
  assert.equal(disabled.status, 501)
  assert.equal((await disabled.json()).error.reason, 'disabled_by_config')
  const rerank = await gw.post('/v1/rerank', { model: 'emb', query: 'q', documents: ['a'] }, json())
  assert.equal(rerank.status, 501, 'rerank 关闭同样 501')
  assert.equal((await rerank.json()).error.reason, 'contract_not_signed_off')
})
