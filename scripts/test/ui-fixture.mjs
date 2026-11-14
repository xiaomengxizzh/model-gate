// Reproducible browser/UI fixture: isolated temp config, local mock upstream,
// deterministic chat/stream/embedding/rerank/responses traffic. Never touches 8787,
// user config, or real upstream keys. Run manually:
//   node scripts/test/ui-fixture.mjs --port 8788
// Prints the URL and admin token, then stays alive until SIGINT/SIGTERM.
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : dflt }
const PORT = Number(arg('port', 8788))
const TOKEN = arg('token', 'fixture-admin-token')
const keep = process.argv.includes('--keep')

function json (res, status, obj, headers = {}) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers))
  res.end(JSON.stringify(obj))
}
async function readBody (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function startMock () {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock')
    const bodyBuf = await readBody(req)
    let body = {}
    try { body = JSON.parse(bodyBuf.toString('utf8') || '{}') } catch {}
    if (req.method === 'GET' && url.pathname.endsWith('/models')) return json(res, 200, { object: 'list', data: [{ id: 'deepseek-fixture', object: 'model' }, { id: 'mock-upstream-model', object: 'model' }] })
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      if (String(body.model || '').includes('ratelimit')) return json(res, 429, { error: { message: 'Mock rate limit: too many requests', type: 'rate_limit_error' } }, { 'retry-after': '1' })
      if (String(body.model || '').includes('fail500')) return json(res, 500, { error: { message: 'Mock upstream failure', type: 'server_error' } })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const chunks = ['ModelGate ', 'fixture ', 'stream']
        for (const text of chunks) {
          res.write('data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n')
          await new Promise((r) => setTimeout(r, 20))
        }
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) + '\n\n')
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      return json(res, 200, { id: 'chatcmpl-fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ModelGate fixture response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } })
    }
    if (req.method === 'POST' && url.pathname.endsWith('/embeddings')) return json(res, 200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }], model: body.model, usage: { prompt_tokens: 3, total_tokens: 3 } })
    if (req.method === 'POST' && url.pathname.endsWith('/rerank')) return json(res, 200, { results: [{ index: 0, relevance_score: 0.9, document: { text: 'a' } }], usage: { total_tokens: 4 } })
    if (req.method === 'POST' && url.pathname.endsWith('/responses')) {
      const text = 'native responses fixture'
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
        emit('response.created', { type: 'response.created', response: { id: 'resp-fixture', object: 'response', status: 'in_progress', model: body.model, output: [] } })
        emit('response.in_progress', { type: 'response.in_progress', response: { id: 'resp-fixture', object: 'response', status: 'in_progress', model: body.model, output: [] } })
        emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_fixture', type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
        emit('response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: text })
        emit('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_fixture', output_index: 0, content_index: 0, text })
        emit('response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } })
        emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } })
        emit('response.completed', { type: 'response.completed', response: { id: 'resp-fixture', object: 'response', status: 'completed', model: body.model, output: [{ id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } })
        return res.end()
      }
      return json(res, 200, { id: 'resp-fixture', object: 'response', status: 'completed', model: body.model, output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } })
    }
    json(res, 404, { error: 'mock route not found: ' + url.pathname })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: server.address().port }
}

async function main () {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-ui-fixture-'))
  const mock = await startMock()
  const config = {
    server: { host: '127.0.0.1', port: PORT, logFile: join(dir, 'gateway.log') },
    defaults: {
      retry: { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 200 },
      timeout: { connectMs: 3000, firstByteMs: 5000, idleMs: 5000, overallMs: 15000, loopMs: 8000 },
      concurrency: { maxPerProvider: 8 },
      proxyMode: 'direct',
      clientKey: '',
    },
    providers: {
      'mock-openai': { baseUrl: 'http://127.0.0.1:' + mock.port, api: 'openai', pathPrefix: '', extraHeaders: { 'x-session-id': 'fixture-session' }, proxy: 'direct', circuit: { maxFailures: 3, openDurationMs: 5000 } },
      'mock-backup': { baseUrl: 'http://127.0.0.1:' + mock.port, api: 'openai', pathPrefix: '', proxy: 'direct' },
    },
    models: {
      'deepseek-fixture': { provider: 'mock-openai', alias: ['ds-fixture'], fallbacks: ['mock-backup'], capability: 'chat', maxContext: 128000, maxTokensMax: 8192, dailyQuota: 1000000, quota: 0, maxConcurrent: 8, qps: 10, reasoning: 'medium', effortOptions: ['low', 'medium', 'high'], effortFormat: 'reasoning_effort' },
      'embed-fixture': { provider: 'mock-openai', capability: 'embedding' },
      'rerank-fixture': { provider: 'mock-openai', capability: 'rerank' },
      'image-fixture': { provider: 'mock-openai', capability: 'image' },
      'native-responses-fixture': { provider: 'mock-openai', api: 'responses', capability: 'chat', maxContext: 64000 },
      'ratelimit-fixture': { provider: 'mock-openai', capability: 'chat' },
      'fail-fixture': { provider: 'mock-openai', capability: 'chat' },
    },
    virtualModels: [{
      name: 'gatemodel',
      directory: [{ model: 'deepseek-fixture', mode: 'afterAll', providers: ['mock-openai', 'mock-backup'] }],
      quota: 0, dailyQuota: 0, maxContext: 128000, maxConcurrent: 8, qps: 10,
      expiresAt: '2026-12-31', note: 'ui-fixture',
    }],
  }
  // Synthetic Codex session log for the read-only native usage card (fixture only).
  const nativeDir = join(dir, 'codex-sessions')
  await mkdir(nativeDir, { recursive: true })
  const t = new Date().toISOString()
  await writeFile(join(nativeDir, 'rollout-fixture-native.jsonl'), [
    { timestamp: t, type: 'session_meta', payload: { session_id: 'fixture-native', model_provider: 'openai' } },
    { timestamp: t, type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    { timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1500 } } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  config.defaults.nativeUsageDir = nativeDir
  await writeFile(join(dir, 'gateway.json'), JSON.stringify(config, null, 2))
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: Object.assign({}, process.env, { MG_CONFIG_DIR: dir, MG_CONFIG: join(dir, 'gateway.json'), MG_KEYS_MASTER: 'ui-fixture-master', MG_ADMIN_TOKEN: TOKEN, MG_MAX_BODY: '', MG_CLIENT_KEY: '' }),
  })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += String(b) })
  const base = 'http://127.0.0.1:' + PORT
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/healthz')).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  const auth = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }
  const call = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: auth, body: JSON.stringify(body) }); return r }
  // Seed panel-managed keys so provider cards show a configured credential source
  // (the mock upstream ignores Authorization). Each key save advances configVersion.
  for (const id of ['mock-openai', 'mock-backup']) {
    const c = await (await fetch(base + '/api/config', { headers: auth })).json()
    await call('/api/keys', { id, key: 'fixture-key-' + id, version: c.configVersion })
  }
  // Seed deterministic, zero-cost fixture traffic (local mock upstream only).
  for (let i = 0; i < 14; i++) {
    await call('/v1/chat/completions', { model: i % 3 === 0 ? 'gatemodel' : 'deepseek-fixture', messages: [{ role: 'user', content: 'fixture message ' + i }], stream: i % 2 === 0 })
  }
  await call('/v1/embeddings', { model: 'embed-fixture', input: 'hello fixture' })
  await call('/v1/rerank', { model: 'rerank-fixture', query: 'q', documents: ['a', 'b'] })
  await call('/v1/responses', { model: 'native-responses-fixture', input: 'hello responses' })
  await call('/v1/chat/completions', { model: 'fail-fixture', messages: [{ role: 'user', content: 'trigger failure' }] })
  await call('/v1/chat/completions', { model: 'ratelimit-fixture', messages: [{ role: 'user', content: 'trigger rate limit' }] })
  console.log(JSON.stringify({ url: base + '/ui-next', base, token: TOKEN, configDir: dir, mockUpstream: 'http://127.0.0.1:' + mock.port }))
  console.log('UI fixture ready. Admin token: ' + TOKEN)
  const stop = async () => {
    child.kill(); mock.server.close(); if (!keep) await rm(dir, { recursive: true, force: true }); process.exit(0)
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  child.on('exit', (code) => { if (code && code !== 0) console.error('gateway exited', code, stderr) })
}
main().catch((e) => { console.error(e); process.exit(1) })
