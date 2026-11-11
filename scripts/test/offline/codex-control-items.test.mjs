import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'

// E3 回归：Codex resume 会带非对话型控制项 configuration_update / additional_tools。
// Chat 桥必须显式丢弃（lossy）而不是 400——否则同一线程切模型会被卡死（实测 turn2 失败原因）。

async function setup(t) {
  const hits = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({ config: { providers: { third: { baseUrl: up.base + '/v1' } }, models: { m1: { provider: 'third', api: 'openai' } } } })
  t.after(async () => { await gw.stop(); await up.stop() })
  return { gw, hits }
}

test('Chat 桥：configuration_update / additional_tools 被显式丢弃而非 400', async (t) => {
  const { gw, hits } = await setup(t)
  const body = {
    model: 'm1',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'configuration_update', model: 'm1', reasoning_effort: 'low' },
      { type: 'additional_tools', role: 'developer', tools: [] },
    ],
    stream: false,
  }
  const r = await gw.call('/v1/responses', { method: 'POST', body })
  assert.equal(r.status, 200)
  assert.equal(hits.length, 1)
  const sent = JSON.parse(hits[0].body)
  const contents = JSON.stringify(sent.messages)
  assert.doesNotMatch(contents, /configuration_update|additional_tools/)
})
