// P09：gatewaySubscription 反向代理 + 原生 V2 投影 + 审计 P0/P1 回归。
// 全部离线：回环 mock、临时 HOME 的合成 auth.json、合成 token。不读取真实 ~/.codex。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const EXP = Math.floor(Date.now() / 1000) + 3600
function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function makeToken(marker, exp = EXP) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp, marker, sub: 'synthetic' }) + '.signature-not-verified'
}
async function makeAuthHome(token) {
  const home = await mkdtemp(join(tmpdir(), 'mg-p09-home-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: token, account_id: 'acct-p09', refresh_token: 'unused', id_token: 'unused' } }), 'utf8')
  return home
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return raw }
}
function respJson(text, usage) {
  return JSON.stringify({ id: 'resp_mock', object: 'response', status: 'completed', model: 'mock', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text, usage: usage || { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
}
function config(officialBase, goBase, over = {}) {
  return Object.assign({
    defaults: {
      codexOfficialHosts: ['localhost'],
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      timeout: { connectMs: 2000, firstByteMs: 2000, idleMs: 2000, overallMs: 5000, loopMs: 5000 },
    },
    providers: {
      official: { baseUrl: String(officialBase).replace('127.0.0.1', 'localhost'), codexIdentity: 'official', gatewaySubscription: { enabled: true } },
      go: { baseUrl: goBase, api: 'responses' },
    },
    models: {
      'codex-gpt': { provider: 'official', api: 'responses' },
      'codex-deepseek': { provider: 'go', api: 'responses', providerModels: { go: 'deepseek-v4.1-flash' }, codex: { plaintextTools: true, history: { agentMessage: 'project', reasoning: 'drop', compaction: 'reject' } } },
    },
  }, over)
}
const PARENT = { model: 'codex-gpt', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }
const CHILD = {
  model: 'codex-deepseek',
  input: [{ type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'input_text', text: 'do work' }] }],
  tools: [{ type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } }] }],
}

test('P09 gatewaySubscription 父官方：只发官方 host，携带本机只读凭据；父不扁平化；token 不出日志/响应', { timeout: 30000 }, async (t) => {
  const token = makeToken('P09_PARENT_CANARY')
  const home = await makeAuthHome(token)
  const officialHits = []
  const official = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    officialHits.push(rec)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(respJson('PARENT_OK'))
  })
  const go = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const gw = await startGateway({ name: 'p09-parent', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: config(official.base, go.base) })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop(); await rm(home, { recursive: true, force: true }) })
  const res = await gw.post('/v1/responses', PARENT)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).output_text, 'PARENT_OK')
  assert.equal(officialHits.length, 1)
  assert.equal(officialHits[0].url, '/backend-api/codex/responses')
  assert.equal(officialHits[0].headers.authorization, 'Bearer ' + token)
  assert.equal(officialHits[0].headers['chatgpt-account-id'], 'acct-p09')
  assert.equal(go.hits.length, 0)
  assert.equal(JSON.stringify(gw.stderr()).includes(token), false)
  assert.equal(JSON.stringify(gw.stderr()).includes('P09_PARENT_CANARY'), false)

  // 父 route 未声明 codex：namespace/agent_message 不扁平化、不投影（官方后端理解密文）。
  const parentV2 = {
    model: 'codex-gpt',
    input: [{ type: 'agent_message', author: '/root', recipient: '/root/w', content: [{ type: 'input_text', text: 'x' }, { type: 'encrypted_content', encrypted_content: 'PARENT_CIPHER' }] }],
    tools: CHILD.tools,
  }
  const res2 = await gw.post('/v1/responses', parentV2)
  assert.equal(res2.status, 200)
  assert.equal(officialHits.length, 2)
  assert.equal(officialHits[1].body.tools[0].type, 'namespace')
  assert.equal(officialHits[1].body.input[0].type, 'agent_message')
  assert.equal(officialHits[1].body.input[0].content[1].encrypted_content, 'PARENT_CIPHER')
})

test('P09 子 Go：plaintextTools 扁平化/删 encrypted，agent_message 明文投影，零官方凭据', { timeout: 30000 }, async (t) => {
  const token = makeToken('P09_CHILD_CANARY')
  const home = await makeAuthHome(token)
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const goHits = []
  const go = await startScriptedUpstream(async (req, res, rec) => { rec.body = await readBody(req); goHits.push(rec); res.writeHead(200, { 'content-type': 'application/json' }); res.end(respJson('CHILD_OK')) })
  const gw = await startGateway({ name: 'p09-child', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: config(official.base, go.base) })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop(); await rm(home, { recursive: true, force: true }) })
  const res = await gw.post('/v1/responses', CHILD)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).output_text, 'CHILD_OK')
  assert.equal(official.hits.length, 0)
  const sent = goHits[0].body
  assert.equal(goHits[0].headers.authorization, undefined)
  assert.equal(goHits[0].headers['chatgpt-account-id'], undefined)
  assert.equal(sent.model, 'deepseek-v4.1-flash')
  assert.equal(sent.tools[0].type, 'function')
  assert.equal(Object.prototype.hasOwnProperty.call(sent.tools[0].parameters.properties.message, 'encrypted'), false)
  assert.equal(sent.input[0].type, 'message')
  assert.equal(sent.input[0].role, 'user')
  assert.match(JSON.stringify(sent.input), /do work/)
})

test('P09 第三方密文/加密工具 schema：发送前 400 零上游（item 级、字符串值、tool schema）', { timeout: 30000 }, async (t) => {
  const home = await makeAuthHome(makeToken('P09_OPAQUE_CANARY'))
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(200); res.end(respJson('must not hit')) })
  const goHits = []
  const go = await startScriptedUpstream(async (req, res) => { goHits.push(1); res.writeHead(200); res.end(respJson('must not hit')) })
  const cfg = config(official.base, go.base)
  cfg.models.opaque = { provider: 'go', api: 'responses', providerModels: { go: 'deepseek-v4.1-flash' } }
  const gw = await startGateway({ name: 'p09-opaque', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop(); await rm(home, { recursive: true, force: true }) })

  const cases = [
    [{ model: 'opaque', input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'x' }, { type: 'encrypted_content', encrypted_content: 'CIPHER' }] }] }, 'opaque_agent_message'],
    [{ model: 'opaque', input: [{ type: 'message', role: 'user', content: 'hi', encrypted_content: 'CIPHER' }] }, 'v2_encrypted_task_unsupported'],
    [{ model: 'opaque', input: [{ type: 'function_call', call_id: 'c1', name: 'spawn_agent', arguments: '{"encrypted_task_id":"OPAQUE"}' }] }, 'v2_encrypted_task_unsupported'],
    [{ model: 'opaque', input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'text mentions encrypted_content in a string' }] }] }, 'opaque_agent_message'],
    [{ model: 'opaque', input: 'hi', tools: [{ type: 'function', name: 'x', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } }] }, 'encrypted_tool_schema'],
  ]
  for (const [body, code] of cases) {
    const res = await gw.post('/v1/responses', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    const err = (await res.json()).error
    assert.equal(err.code, code, JSON.stringify(err))
    assert.equal(JSON.stringify(err).includes('CIPHER'), false)
  }
  assert.equal(goHits.length, 0)
})

test('P09 上游 4xx 体回客户端前脱敏：Bearer/sk- 不出现在响应', { timeout: 30000 }, async (t) => {
  const home = await makeAuthHome(makeToken('P09_SCRUB_CANARY'))
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const go = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad Bearer sk-LEAKED-SECRET-12345678' } })) })
  const cfg = config(official.base, go.base)
  cfg.models.scrub = { provider: 'go', api: 'responses', providerModels: { go: 'deepseek-v4.1-flash' } }
  const gw = await startGateway({ name: 'p09-scrub', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop(); await rm(home, { recursive: true, force: true }) })
  const res = await gw.post('/v1/responses', { model: 'scrub', input: 'hi' })
  const text = await res.text()
  assert.equal(text.includes('sk-LEAKED-SECRET'), false, 'upstream 4xx body must be scrubbed')
  assert.match(text, /\*\*\*\*/)
})

test('P09 带工具历史：首个候选失败后不得跨候选重发', { timeout: 30000 }, async (t) => {
  const home = await makeAuthHome(makeToken('P09_NOREPLAY_CANARY'))
  const primary = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"primary down"}') })
  const backup = await startScriptedUpstream(async (req, res) => { backupHits.push(1); res.writeHead(200); res.end(respJson('backup')) })
  const backupHits = []
  const cfg = {
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, overallMs: 5000, loopMs: 5000 } },
    providers: { p1: { baseUrl: primary.base, api: 'responses' }, p2: { baseUrl: backup.base, api: 'responses' } },
    models: { tool: { provider: 'p1', fallbacks: ['p2'], api: 'responses' } },
  }
  const gw = await startGateway({ name: 'p09-noreplay', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: cfg })
  t.after(async () => { await gw.stop(); await primary.stop(); await backup.stop(); await rm(home, { recursive: true, force: true }) })
  const res = await gw.post('/v1/responses', { model: 'tool', input: 'hi', tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }] })
  assert.ok(res.status >= 500)
  assert.equal(primary.hits.length, 1)
  assert.equal(backupHits.length, 0, 'tool-bearing request must not replay on another candidate')
})

test('P09 订阅非官方 host/关闭开关/凭据缺失/过期：403/401 零上游', { timeout: 30000 }, async (t) => {
  const token = makeToken('P09_NEG_CANARY')
  const home = await makeAuthHome(token)
  const dead = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const cfgBad = config(dead.base, dead.base)
  cfgBad.providers.bad = { baseUrl: dead.base, codexIdentity: 'thirdParty', gatewaySubscription: { enabled: true }, api: 'responses' }
  cfgBad.models.bad = { provider: 'bad', api: 'responses' }
  const gwBad = await startGateway({ name: 'p09-neg-bad', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: cfgBad })
  t.after(async () => { await gwBad.stop(); await dead.stop(); await rm(home, { recursive: true, force: true }) })
  const bad = await gwBad.post('/v1/responses', { model: 'bad', input: 'hi' })
  assert.equal(bad.status, 403)
  assert.equal((await bad.json()).error.code, 'gateway_subscription_target_not_allowed')
  assert.equal(dead.hits.length, 0)

  const cfgOff = config(dead.base, dead.base)
  cfgOff.providers.official.gatewaySubscription = { enabled: false }
  const gwOff = await startGateway({ name: 'p09-neg-off', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: cfgOff })
  t.after(async () => { await gwOff.stop() })
  const off = await gwOff.post('/v1/responses', PARENT)
  assert.equal(off.status, 403)
  assert.equal((await off.json()).error.code, 'official_no_gateway_key')
  assert.equal(dead.hits.length, 0)

  const emptyHome = await mkdtemp(join(tmpdir(), 'mg-p09-empty-'))
  const gwMissing = await startGateway({ name: 'p09-neg-missing', env: { HOME: emptyHome, CODEX_HOME: join(emptyHome, '.codex') }, config: config(dead.base, dead.base) })
  t.after(async () => { await gwMissing.stop(); await rm(emptyHome, { recursive: true, force: true }) })
  const missing = await gwMissing.post('/v1/responses', PARENT)
  assert.equal(missing.status, 401)
  assert.equal((await missing.json()).error.code, 'subscription_credential_unavailable')
  assert.equal(dead.hits.length, 0)

  const expiredHome = await makeAuthHome(makeToken('P09_EXPIRED', Math.floor(Date.now() / 1000) - 3600))
  const gwExpired = await startGateway({ name: 'p09-neg-expired', env: { HOME: expiredHome, CODEX_HOME: join(expiredHome, '.codex') }, config: config(dead.base, dead.base) })
  t.after(async () => { await gwExpired.stop(); await rm(expiredHome, { recursive: true, force: true }) })
  const expired = await gwExpired.post('/v1/responses', PARENT)
  assert.equal(expired.status, 401)
  assert.equal((await expired.json()).error.code, 'subscription_credential_unavailable')
  assert.equal(dead.hits.length, 0)
})

test('P09 子原生 SSE：adapter 恢复 namespace/marker、单终态、usage once；EOF 合成 failed', { timeout: 30000 }, async (t) => {
  const home = await makeAuthHome(makeToken('P09_STREAM_CANARY'))
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  let mode = 'ok'
  const go = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'r1', object: 'response', status: 'in_progress' } }) + '\n\n')
    if (mode === 'ok') {
      res.write('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', status: 'completed', id: 'fc1', call_id: 'call_1', name: 'spawn_agent', arguments: '{}' } }) + '\n\n')
      res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'r1', object: 'response', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } }) + '\n\n')
    } else res.end()
  })
  const gw = await startGateway({ name: 'p09-stream', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: config(official.base, go.base) })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop(); await rm(home, { recursive: true, force: true }) })
  const res = await gw.post('/v1/responses', Object.assign({}, CHILD, { stream: true }))
  const text = await res.text()
  assert.match(text, /"namespace":"collaboration"/)
  assert.match(text, /"encrypted_function_args":\[\]/)
  assert.equal((text.match(/event: response\.completed/g) || []).length, 1)
  const st = await (await gw.get('/api/status')).json()
  const m = st.models.find((x) => x.name === 'codex-deepseek')
  assert.equal(m.tokens, 5)

  mode = 'eof'
  const res2 = await gw.post('/v1/responses', Object.assign({}, CHILD, { stream: true }))
  const text2 = await res2.text()
  assert.match(text2, /event: response.failed/)
  assert.match(text2, /STREAM_INTERRUPTED/)
  assert.doesNotMatch(text2, /event: response\.completed/)
})
