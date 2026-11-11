import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { startGateway, startScriptedUpstream } from './harness.mjs'

// E3 前置：Codex 0.167 官方 /v1/responses 实测 content-encoding: zstd。
// 网关必须解压请求体、删掉 content-encoding 再转发；未知/损坏编码 fail-closed 415，绝不把压缩字节当 JSON。

async function setup() {
  const bodies = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    bodies.push({ raw: Buffer.concat(chunks), headers: req.headers })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({
    config: {
      providers: { mock: { baseUrl: up.base + '/v1' } },
      models: { m1: { provider: 'mock', api: 'openai' } },
      defaults: { model: '' },
    },
  })
  return { up, gw, bodies }
}

for (const [name, encode] of [
  ['zstd', (b) => zstdCompressSync(b)],
  ['gzip', (b) => gzipSync(b)],
]) {
  test('请求体 content-encoding=' + name + '：解压转发且不携带编码头', async () => {
    const { up, gw, bodies } = await setup()
    try {
      const payload = { model: 'm1', messages: [{ role: 'user', content: 'hello ' + name }] }
      const raw = encode(Buffer.from(JSON.stringify(payload)))
      const r = await fetch(gw.base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': name },
        body: raw,
      })
      assert.equal(r.status, 200)
      assert.equal(bodies.length, 1, 'upstream must be hit exactly once')
      assert.equal(bodies[0].headers['content-encoding'], undefined, 'content-encoding must not be forwarded')
      const seen = JSON.parse(bodies[0].raw.toString('utf8'))
      assert.equal(seen.model, 'm1')
      assert.equal(seen.messages[0].content, 'hello ' + name)
      assert.equal(Number(bodies[0].headers['content-length']), bodies[0].raw.length)
    } finally { await gw.stop(); await up.stop() }
  })
}

test('未知 content-encoding：415 且零上游命中', async () => {
  const { up, gw, bodies } = await setup()
  try {
    const r = await fetch(gw.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'x-unknown' },
      body: Buffer.from('{"model":"m1"}'),
    })
    assert.equal(r.status, 415)
    const j = await r.json()
    assert.match(j.error.message, /unsupported content-encoding/)
    assert.equal(bodies.length, 0)
  } finally { await gw.stop(); await up.stop() }
})

test('损坏的 zstd 请求体：415 且零上游命中', async () => {
  const { up, gw, bodies } = await setup()
  try {
    const r = await fetch(gw.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: Buffer.from('not-a-zstd-frame'),
    })
    assert.equal(r.status, 415)
    assert.equal(bodies.length, 0)
  } finally { await gw.stop(); await up.stop() }
})