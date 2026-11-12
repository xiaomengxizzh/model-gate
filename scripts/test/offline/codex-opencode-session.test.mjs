import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'

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
