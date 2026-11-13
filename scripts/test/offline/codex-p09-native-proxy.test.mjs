// 本套件 2026-11-13 由 P09 正向代理验证改造为「退役 + 静态扫描」断言（G1 认证边界收口）。
//
// 原 P09 验证 gatewaySubscription 读取本机 Codex auth.json 并代理订阅后端；该能力已退役，不得回流。
// 本套件证明：
//   1. 静态边界：src 递归扫描不出现 auth.json/CODEX_HOME/local-subscription/订阅后端路径，
//      src/index.js 不再 import local-subscription.js；
//   2. 残留配置 fail-closed：providers.<id>.gatewaySubscription.enabled=true 在官方原生
//      /v1/responses、第三方原生 /v1/responses、官方 Chat 桥三个入口都返回稳定 403
//      gateway_subscription_retired，零上游、不降级、不读登录态；
//   3. 官方直连（网关自有 key）仍可用，客户端官方头零透传，父 V2 不扁平化；
//   4. 原 P09 的 V2 投影/密文拒绝/脱敏/不重放/SSE 回归仍成立。
// 全部离线：回环 mock、临时 HOME 中的合成 auth.json、合成 token。不读取真实 ~/.codex。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { scanAuthBoundary } from './auth-boundary-scan.mjs'
import { CREDENTIAL_MODES, TARGET_DOMAINS, credentialModeAllowed, officialIngressPolicy } from '../../../src/codex/target-authz.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EXP = Math.floor(Date.now() / 1000) + 3600
function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function makeToken(marker, exp = EXP) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp, marker, sub: 'synthetic' }) + '.signature-not-verified'
}
// 合成登录态：只用于证明“即使存在也不会被读取/转发”。值全部虚构。
async function makeAuthHome(token) {
  const home = await mkdtemp(join(tmpdir(), 'mg-g1-home-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: token, account_id: 'acct-g1-synthetic', refresh_token: 'unused', id_token: 'unused' } }), 'utf8')
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
      official: { baseUrl: String(officialBase).replace('127.0.0.1', 'localhost'), codexIdentity: 'official' },
      go: { baseUrl: goBase, api: 'responses' },
    },
    models: {
      'codex-gpt': { provider: 'official', api: 'responses' },
      'gpt-chat': { provider: 'official' },
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

// —— 退役边界：静态 + 单元 ——

test('退役静态扫描：src 递归不出现 auth.json/CODEX_HOME/local-subscription/订阅后端路径', () => {
  const violations = scanAuthBoundary(ROOT)
  assert.deepEqual(violations, [], '生产代码认证边界违规:\n' + violations.join('\n'))
  assert.equal(existsSync(join(ROOT, 'src/codex/local-subscription.js')), false, 'local-subscription.js 必须删除')
  const indexSrc = readFileSync(join(ROOT, 'src/index.js'), 'utf8')
  assert.equal(/from\s+['"][^'"]*local-subscription/.test(indexSrc), false, 'src/index.js 不得再 import local-subscription.js')
  assert.equal(Object.prototype.hasOwnProperty.call(CREDENTIAL_MODES, 'GATEWAY_SUBSCRIPTION'), false, 'GATEWAY_SUBSCRIPTION 模式必须移除')
  assert.equal(CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION, undefined)
})

test('授权层：gatewaySubscription 旧模式/旧开关一律 typed deny，订阅后端路径永不进白名单', () => {
  const target = { protocol: 'https:', hostname: 'api.openai.com', host: 'api.openai.com', port: '', pathname: '/v1/responses' }
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.OFFICIAL, target, { gatewaySubscription: true }).code, 'gateway_subscription_retired')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.OFFICIAL, target, { credentialMode: 'gateway-subscription' }).code, 'gateway_subscription_retired')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.THIRD_PARTY, target, { gatewaySubscription: true }).code, 'gateway_subscription_retired')
  const backend = { protocol: 'https:', hostname: 'api.openai.com', host: 'api.openai.com', port: '', pathname: '/backend-api/codex/responses' }
  assert.equal(officialIngressPolicy(TARGET_DOMAINS.OFFICIAL, backend, { cfg: {}, officialIngress: true }).code, 'official_path_not_allowlisted')
  assert.equal(officialIngressPolicy(TARGET_DOMAINS.OFFICIAL, target, { cfg: {}, officialIngress: true, credentialMode: 'gateway-subscription' }).code, 'gateway_subscription_retired')
})

// —— 退役边界：三个请求入口 fail-closed（零上游、不降级） ——

test('残留 gatewaySubscription：官方 /v1/responses → 403 retired、零上游、合成登录态不出现', { timeout: 30000 }, async (t) => {
  const token = makeToken('G1_OFFICIAL_CANARY')
  const home = await makeAuthHome(token)
  const officialHits = []
  const official = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req); officialHits.push(rec)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(respJson('MUST_NOT_HIT'))
  })
  const go = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(respJson('MUST_NOT_HIT')) })
  const cfg = config(official.base, go.base)
  cfg.providers.official.gatewaySubscription = { enabled: true }
  const gw = await startGateway({ name: 'g1-retired-official', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop(); await rm(home, { recursive: true, force: true }) })

  const res = await gw.post('/v1/responses', PARENT)
  assert.equal(res.status, 403)
  const err = (await res.json()).error
  assert.equal(err.code, 'gateway_subscription_retired')
  assert.match(err.message, /已.*退役/, '拒绝消息必须说明能力已退役')
  assert.equal(official.hits.length, 0, '官方订阅上游零命中')
  assert.equal(go.hits.length, 0, '不得降级到第三方候选')
  const logs = JSON.stringify(gw.stderr())
  assert.equal(logs.includes(token), false, '合成登录态不得出现在日志')
  assert.equal(logs.includes('G1_OFFICIAL_CANARY'), false)

  const st = await (await gw.get('/api/status')).json()
  const p = st.providers.find((x) => x.id === 'official')
  assert.equal(p.gatewaySubscription, false, '能力不存在，状态不得再显示为启用')
  assert.equal(p.gatewaySubscriptionRetired, true, '残留旧配置只作为退役标识暴露')
})

test('残留 gatewaySubscription：第三方 /v1/responses → 403 retired、零上游', { timeout: 30000 }, async (t) => {
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(200); res.end(respJson('MUST_NOT_HIT')) })
  const go = await startScriptedUpstream(async (req, res) => { res.writeHead(200); res.end(respJson('MUST_NOT_HIT')) })
  const cfg = config(official.base, go.base)
  cfg.providers.go.gatewaySubscription = { enabled: true }
  const gw = await startGateway({ name: 'g1-retired-third', config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })

  const res = await gw.post('/v1/responses', { model: 'codex-deepseek', input: 'hi' })
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'gateway_subscription_retired')
  assert.equal(official.hits.length, 0)
  assert.equal(go.hits.length, 0)
})

test('残留 gatewaySubscription：官方 Chat 桥 → 403 retired、零上游', { timeout: 30000 }, async (t) => {
  const officialHits = []
  const official = await startScriptedUpstream(async (req, res) => { officialHits.push(1); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'MUST_NOT_HIT' }, finish_reason: 'stop' }] })) })
  const go = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const cfg = config(official.base, go.base)
  cfg.providers.official.gatewaySubscription = { enabled: true }
  const gw = await startGateway({ name: 'g1-retired-chat', config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })

  const res = await gw.post('/v1/chat/completions', { model: 'gpt-chat', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'gateway_subscription_retired')
  assert.equal(officialHits.length, 0, 'Chat 桥也必须零上游')
})

test('gatewaySubscription 关闭且无自有 key：保持 F01 official_no_gateway_key fail-closed', { timeout: 30000 }, async (t) => {
  const officialHits = []
  const official = await startScriptedUpstream(async (req, res) => { officialHits.push(1); res.writeHead(200); res.end(respJson('MUST_NOT_HIT')) })
  const go = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const cfg = config(official.base, go.base)
  cfg.providers.official.gatewaySubscription = { enabled: false }
  const gw = await startGateway({ name: 'g1-no-key', config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })

  const res = await gw.post('/v1/responses', PARENT)
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'official_no_gateway_key')
  assert.equal(officialHits.length, 0)
})

// —— 保留能力：官方自有 key 直连（唯一的官方凭据路径） ——

test('官方直连自有 key：只发 /v1/responses、客户端官方头零透传、父 V2 不扁平化', { timeout: 30000 }, async (t) => {
  const officialHits = []
  const official = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req); officialHits.push(rec)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(respJson('PARENT_OK'))
  })
  const go = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const cfg = config(official.base, go.base)
  cfg.providers.official.apiKeyEnv = 'MG_TEST_OFFICIAL_KEY'
  const gw = await startGateway({ name: 'g1-official-key', env: { MG_TEST_OFFICIAL_KEY: 'gw-official-synthetic-key' }, config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })

  const res = await gw.post('/v1/responses', PARENT)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).output_text, 'PARENT_OK')
  assert.equal(officialHits.length, 1)
  assert.equal(officialHits[0].url, '/v1/responses')
  assert.equal(officialHits[0].headers.authorization, 'Bearer gw-official-synthetic-key')
  assert.equal(officialHits[0].headers['chatgpt-account-id'], undefined)
  assert.equal(go.hits.length, 0)

  // 父 route 未声明 codex：namespace/agent_message 不扁平化、不投影。
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

// —— 保留回归：V2 子任务投影 / 密文拒绝 / 脱敏 / 不重放 / SSE ——

test('子 Go：plaintextTools 扁平化/删 encrypted，agent_message 明文投影，零官方凭据', { timeout: 30000 }, async (t) => {
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const goHits = []
  const go = await startScriptedUpstream(async (req, res, rec) => { rec.body = await readBody(req); goHits.push(rec); res.writeHead(200, { 'content-type': 'application/json' }); res.end(respJson('CHILD_OK')) })
  const gw = await startGateway({ name: 'g1-child', config: config(official.base, go.base) })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })
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

test('子 Go：加密 agent_message 只保留可读文本，密文片段不转发', { timeout: 30000 }, async (t) => {
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const goHits = []
  const go = await startScriptedUpstream(async (req, res, rec) => { rec.body = await readBody(req); goHits.push(rec); res.writeHead(200, { 'content-type': 'application/json' }); res.end(respJson('PARTIAL_OK')) })
  const gw = await startGateway({ name: 'g1-partial', config: config(official.base, go.base) })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })
  const body = {
    model: 'codex-deepseek',
    input: [{ type: 'agent_message', author: '/root', recipient: '/root/w', content: [{ type: 'input_text', text: 'do work' }, { type: 'encrypted_content', encrypted_content: 'CIPHER' }] }],
    tools: CHILD.tools,
  }
  const res = await gw.post('/v1/responses', body)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).output_text, 'PARTIAL_OK')
  const sent = goHits[0].body
  assert.match(JSON.stringify(sent.input), /do work/)
  assert.equal(JSON.stringify(sent).includes('CIPHER'), false)
  assert.equal(JSON.stringify(sent).includes('encrypted_content'), false)
})

test('第三方密文/加密工具 schema：发送前 400 零上游（item 级、字符串值、tool schema）', { timeout: 30000 }, async (t) => {
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(200); res.end(respJson('MUST_NOT_HIT')) })
  const goHits = []
  const go = await startScriptedUpstream(async (req, res) => { goHits.push(1); res.writeHead(200); res.end(respJson('MUST_NOT_HIT')) })
  const cfg = config(official.base, go.base)
  cfg.models.opaque = { provider: 'go', api: 'responses', providerModels: { go: 'deepseek-v4.1-flash' } }
  const gw = await startGateway({ name: 'g1-opaque', config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })

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

test('上游 4xx 体回客户端前脱敏：Bearer/sk- 不出现在响应', { timeout: 30000 }, async (t) => {
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const go = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad Bearer sk-LEAKED-SECRET-12345678' } })) })
  const cfg = config(official.base, go.base)
  cfg.models.scrub = { provider: 'go', api: 'responses', providerModels: { go: 'deepseek-v4.1-flash' } }
  const gw = await startGateway({ name: 'g1-scrub', config: cfg })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })
  const res = await gw.post('/v1/responses', { model: 'scrub', input: 'hi' })
  const text = await res.text()
  assert.equal(text.includes('sk-LEAKED-SECRET'), false, 'upstream 4xx body must be scrubbed')
  assert.match(text, /\*\*\*\*/)
})

test('带工具历史：首个候选失败后不得跨候选重发', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => { for await (const _ of req) {} res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"primary down"}') })
  const backupHits = []
  const backup = await startScriptedUpstream(async (req, res) => { backupHits.push(1); res.writeHead(200); res.end(respJson('backup')) })
  const cfg = {
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, overallMs: 5000, loopMs: 5000 } },
    providers: { p1: { baseUrl: primary.base, api: 'responses' }, p2: { baseUrl: backup.base, api: 'responses' } },
    models: { tool: { provider: 'p1', fallbacks: ['p2'], api: 'responses' } },
  }
  const gw = await startGateway({ name: 'g1-noreplay', config: cfg })
  t.after(async () => { await gw.stop(); await primary.stop(); await backup.stop() })
  const res = await gw.post('/v1/responses', { model: 'tool', input: 'hi', tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }] })
  assert.ok(res.status >= 500)
  assert.equal(primary.hits.length, 1)
  assert.equal(backupHits.length, 0, 'tool-bearing request must not replay on another candidate')
})

test('子原生 SSE：adapter 恢复 namespace/marker、单终态、usage once；EOF 合成 failed', { timeout: 30000 }, async (t) => {
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
  const gw = await startGateway({ name: 'g1-stream', config: config(official.base, go.base) })
  t.after(async () => { await gw.stop(); await official.stop(); await go.stop() })
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
  assert.match(text2, /event: response\.failed/)
  assert.match(text2, /STREAM_INTERRUPTED/)
  assert.doesNotMatch(text2, /event: response\.completed/)
})
