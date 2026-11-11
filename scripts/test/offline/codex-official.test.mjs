import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startGateway, startScriptedUpstream } from './harness.mjs'

// E3 / D1-A 离线验收：Codex 内置 openai 身份（openai_base_url 指到网关）与第三方同网关共存。
// 只验证网关侧路由与头隔离；真实 Codex CLI 由 scripts/test/codex-e2e.mjs + 证据文档覆盖。
// 注意：官方 host 白名单只放行 localhost（= 官方 mock），第三方走 127.0.0.1，避免测试夹具互相污染。

const OFFICIAL_HEADERS = {
  authorization: 'Bearer official-test-token',
  'chatgpt-account-id': 'acct-test-123',
  'session-id': 'sess-test-456',
  'thread-id': 'thread-test-789',
  'x-codex-turn-metadata': '{"turn":"test"}',
  'x-codex-window-id': 'win-test',
  'openai-beta': 'responses=experimental',
  version: '0.167.0',
  originator: 'codex_cli_rs',
  'content-type': 'application/json',
}

function officialSse(res, text, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (e, d) => res.write('event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n')
  emit('response.created', { type: 'response.created', response: { id: 'r1', object: 'response', status: 'in_progress', model, output: [] } })
  emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: text })
  emit('response.completed', { type: 'response.completed', response: { id: 'r1', object: 'response', status: 'completed', model, output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })
  res.end()
}

async function startOfficialMock(hits) {
  return startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ url: req.url, headers: req.headers, bodyLen: Buffer.concat(chunks).length })
    officialSse(res, 'official ok', 'gpt-6-astra')
  })
}

function officialBase(up) { return 'http://localhost:' + up.port }

async function setup(t, opts = {}) {
  const officialHits = []
  const thirdHits = []
  const official = await startOfficialMock(officialHits)
  const third = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    thirdHits.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'third ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({
    env: { MG_CODEX_OFFICIAL_PASSTHROUGH: opts.passthrough === false ? '0' : '1' },
    config: {
      defaults: { model: '', codexOfficialHosts: ['localhost'] },
      providers: {
        'codex-official': { baseUrl: officialBase(official), codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' },
        third: { baseUrl: third.base + '/v1' },
      },
      models: {
        'gpt-6-astra': { provider: 'codex-official', api: 'responses' },
        'mg-third-model': { provider: 'third', api: 'openai' },
      },
    },
  })
  t.after(async () => { await gw.stop(); await official.stop(); await third.stop() })
  return { gw, officialHits, thirdHits }
}

test('官方透传：客户端官方头到达官方上游，SSE 原样回传', async (t) => {
  const { gw, officialHits, thirdHits } = await setup(t)
  const r = await gw.call('/v1/responses', { method: 'POST', headers: OFFICIAL_HEADERS, body: { model: 'gpt-6-astra', input: 'hi', stream: true } })
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.match(text, /official ok/)
  assert.equal(officialHits.length, 1)
  const h = officialHits[0].headers
  assert.equal(h.authorization, 'Bearer official-test-token')
  assert.equal(h['chatgpt-account-id'], 'acct-test-123')
  assert.equal(h['x-codex-turn-metadata'], '{"turn":"test"}')
  assert.equal(h['session-id'], 'sess-test-456')
  assert.equal(h['content-encoding'], undefined)
  assert.equal(thirdHits.length, 0)
})

test('官方透传关闭：403 official_passthrough_disabled 且零上游命中', async (t) => {
  const { gw, officialHits } = await setup(t, { passthrough: false })
  const r = await gw.call('/v1/responses', { method: 'POST', headers: OFFICIAL_HEADERS, body: { model: 'gpt-6-astra', input: 'hi', stream: true } })
  assert.equal(r.status, 403)
  const j = await r.json()
  assert.equal(j.error.code, 'official_passthrough_disabled')
  assert.equal(officialHits.length, 0)
})

test('第三方模型：官方专用头一个都不到第三方上游', async (t) => {
  const { gw, thirdHits } = await setup(t)
  const r = await gw.call('/v1/chat/completions', { method: 'POST', headers: OFFICIAL_HEADERS, body: { model: 'mg-third-model', messages: [{ role: 'user', content: 'hi' }] } })
  assert.equal(r.status, 200)
  assert.equal(thirdHits.length, 1)
  const h = thirdHits[0].headers
  for (const name of ['authorization', 'chatgpt-account-id', 'session-id', 'thread-id', 'x-codex-turn-metadata', 'x-codex-window-id', 'openai-beta', 'version', 'originator']) {
    assert.equal(h[name], undefined, '第三方上游不得收到 ' + name)
  }
})

function rawRequest(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('WS upgrade：网关回 404 让客户端回落，且零上游命中', async (t) => {
  const { gw, officialHits } = await setup(t)
  const r = await rawRequest(gw.base + '/v1/responses', { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', authorization: 'Bearer official-test-token', 'chatgpt-account-id': 'acct-test-123' })
  assert.equal(r.status, 404)
  assert.equal(officialHits.length, 0)
})
