import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { buildHeaders } from '../../../src/forward.js'
import { entryOf, isGoBinding, newHeaders, SESSION_HEADER } from '../../../src/providers/opencode-go.js'

// OpenCode Go 强制 x-opencode-session（缺失 → 400 MissingSessionID）。Codex 0.167 只发 session-id/thread-id，
// 且这些官方头在第三方目标上会被剥掉，因此网关必须**派生**该头。
// P03 起派生值是 HMAC（主体+provider+root/child 域+目标入口+线程），绝不原样转发客户端线程 ID；
// 没有线程引用时给请求内独立 id。

async function setup(t) {
  const hits = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({ config: { providers: { opencodego: { baseUrl: up.base + '/inference/go/openai/v1', api: 'openai' } }, models: { m1: { provider: 'opencodego', api: 'openai' } } } })
  t.after(async () => { await gw.stop(); await up.stop() })
  return { gw, hits }
}

test('opencodego：从 Codex session-id 派生 x-opencode-session（不转发原值）', async (t) => {
  const { gw, hits } = await setup(t)
  const r = await gw.call('/v1/chat/completions', { method: 'POST', headers: { 'session-id': 'codex-sess-1' }, body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } })
  assert.equal(r.status, 200)
  assert.match(String(hits[0].headers['x-opencode-session'] || ''), /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(hits[0].headers['x-opencode-session'], 'codex-sess-1', '不得转发原始 Codex session-id')
  assert.equal(hits[0].headers['session-id'], undefined, '官方头仍不得原样转发')
})

test('opencodego：同线程派生值稳定（会话亲和），跨进程/跨请求无引用时给独立 id', async (t) => {
  const { gw, hits } = await setup(t)
  const call = (headers) => gw.call('/v1/chat/completions', { method: 'POST', headers, body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } })
  const r1 = await call({ 'session-id': 'codex-sess-stable' })
  const r2 = await call({ 'session-id': 'codex-sess-stable' })
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  assert.equal(hits[0].headers['x-opencode-session'], hits[1].headers['x-opencode-session'], '同线程应稳定，便于上游会话亲和')

  const r3 = await call({})
  assert.equal(r3.status, 200)
  assert.match(String(hits[2].headers['x-opencode-session'] || ''), /^mg-[0-9a-f-]{36}$/, '无线索时给请求内独立 id')
})

// 头构造层回归：Desktop 现行位形是 baseUrl=/inference/go + pathPrefix=/openai（bin/mg-desktop.mjs），
// 不含 /v1。该形状此前只有「provider 恰好命名为 opencodego」才算 Go 绑定；换名字后 chat 入口
// 不再带 x-opencode-session（真实上游 400 MissingSessionID），responses 入口因走同一派生仍然正常。
test('opencodego：/inference/go + pathPrefix=/openai 的 chat 与 responses 头一致（不按 provider id 猜）', () => {
  const provider = { id: 'go-work', baseUrl: 'https://opencode.ai/inference/go', pathPrefix: '/openai', api: 'openai' }
  assert.equal(entryOf(provider).ok, true, 'Desktop 位形必须被记为现行 Go 入口')
  assert.equal(isGoBinding(provider), true, 'Go 绑定按 URL 形状识别，不依赖 provider id')

  const req = { headers: { 'session-id': 'codex-thread-1' } }
  const chat = buildHeaders(req, provider, Buffer.from('{}'), {}, 'openai', { model: 'x' }, {})
  const native = buildHeaders(req, provider, Buffer.from('{}'), {}, 'responses', { model: 'x' }, {})
  assert.match(String(chat[SESSION_HEADER] || ''), /^[A-Za-z0-9_-]{32}$/, 'chat 入口必须带派生会话头')
  assert.equal(chat[SESSION_HEADER], native[SESSION_HEADER], '两条入口必须复用同一派生，不得各生成一个值')
  assert.equal(chat[SESSION_HEADER], newHeaders({ req, provider, cfg: {} }).session.value, '复用既有 newHeaders 派生，不另造值')
  assert.equal(chat['session-id'], undefined, '官方 session-id 仍不得原样外流')
})
