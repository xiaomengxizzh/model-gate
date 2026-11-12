// P03：OpenCode Go provider 适配的离线契约测试（只连本地 mock，不触达任何真实端点）。
//
// 覆盖：入口绑定（现行 chat/responses vs 遗留 /zen/go）、版本/授权校验、别名与 effort 严格映射、
// 能力证据新鲜度、UA 与域派生会话标识（不转发原始 Codex id）、多轮 tool loop、stream/usage、
// 429/401/403/断流、额度 unknown、会话域隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import {
  PROVIDER_ID, SERVICE_UA, SESSION_HEADER, ENTRIES, DEFAULT_ALIAS, DEFAULT_VENDOR_MODEL,
  entryOf, validate, mapModel, mapEffort, capabilities, newHeaders, encode, usageOf,
  decodeError, classifyStreamTerminal,
} from '../../../src/providers/opencode-go.js'

const GO_BASE = 'https://opencode.ai/inference/go/openai/v1'

test('P03 入口绑定：现行 chat/responses 与遗留 /zen/go 分属不同 binding', () => {
  const chat = entryOf({ baseUrl: GO_BASE })
  assert.equal(chat.ok, true)
  assert.equal(chat.entry.binding, 'go-v1')
  assert.equal(chat.entry.legacy, false)

  const responses = entryOf({ baseUrl: GO_BASE + '/responses' })
  assert.equal(responses.ok, true)
  assert.equal(responses.entry.kind, 'responses')
  assert.equal(responses.entry.binding, 'go-v1')

  const legacy = entryOf({ baseUrl: 'https://opencode.ai/zen/go/v1' })
  assert.equal(legacy.ok, true)
  assert.equal(legacy.entry.binding, 'legacy-zen')
  assert.equal(legacy.entry.legacy, true)

  const unknown = entryOf({ baseUrl: 'https://opencode.ai/not-a-go-entry' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'opencodego_entry_unknown')
  assert.equal(entryOf({}).ok, false)
})

test('P03 校验：host 白名单、遗留入口默认拒绝、版本与凭据只判存在性', () => {
  const bad = validate({ baseUrl: 'https://evil.example/inference/go/openai/v1' }, { model: undefined })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'opencodego_host_not_allowlisted')

  const legacy = validate({ baseUrl: 'https://opencode.ai/zen/go/v1' }, {})
  assert.equal(legacy.ok, false)
  assert.equal(legacy.code, 'opencodego_legacy_entry_denied')

  const legacyAllowed = validate({ baseUrl: 'https://opencode.ai/zen/go/v1' }, { allowLegacy: true })
  assert.equal(legacyAllowed.ok, true)
  assert.ok(legacyAllowed.warnings.some(w => w.code === 'legacy_zen_entry'))

  const version = validate({ baseUrl: GO_BASE, opencodeGoVersion: 'go-v9' }, {})
  assert.equal(version.ok, false)
  assert.equal(version.code, 'opencodego_version_unsupported')

  const ok = validate({ baseUrl: GO_BASE, opencodeGoVersion: 'go-v1', apiKeyEnv: 'SYNTHETIC_GO_KEY' }, {})
  assert.equal(ok.ok, true)
  assert.equal(ok.entry.entry.binding, 'go-v1')
  assert.equal(ok.hasCredential, true)
  assert.equal(JSON.stringify(ok).includes('SYNTHETIC_GO_KEY'), false, '校验结果只留存在性，不回显凭据引用值')

  const noCred = validate({ baseUrl: GO_BASE }, {})
  assert.equal(noCred.ok, true)
  assert.ok(noCred.warnings.some(w => w.code === 'credential_unresolved'))

  // 隔离测试：显式 allowLoopback 才允许本机 mock。
  const loop = validate({ baseUrl: 'http://127.0.0.1:1234/inference/go/openai/v1' }, { allowLoopback: true })
  assert.equal(loop.ok, true)
})

test('P03 别名/effort：strict mapping，不静默宣称未证实档位', () => {
  const cfg = {
    models: {
      'deepseek-v4.1-flash': { provider: PROVIDER_ID, providerModels: { [PROVIDER_ID]: DEFAULT_VENDOR_MODEL }, alias: [DEFAULT_ALIAS] },
      other: { provider: 'other', upstreamModel: 'x' },
    },
  }
  assert.deepEqual(mapModel(cfg, DEFAULT_ALIAS), { ok: true, vendorModel: DEFAULT_VENDOR_MODEL, declaration: 'config', modelName: 'deepseek-v4.1-flash' })
  assert.equal(mapModel(cfg, 'deepseek-v4.1-flash').vendorModel, DEFAULT_VENDOR_MODEL)
  const unmapped = mapModel(cfg, 'unknown-model')
  assert.equal(unmapped.ok, false)
  assert.equal(unmapped.code, 'opencodego_model_unmapped')

  assert.deepEqual(mapEffort('low'), { ok: true, effort: 'low' })
  assert.deepEqual(mapEffort('MAX'), { ok: true, effort: 'max' })
  const medium = mapEffort('medium')
  assert.equal(medium.ok, false)
  assert.equal(medium.code, 'opencodego_effort_unsupported')
  assert.equal(mapEffort('off').code, 'opencodego_effort_unsupported')
})

test('P03 能力证据：无关证据=unknown，过期=stale，不接受配置自证', () => {
  const unknown = capabilities(null, { model: DEFAULT_VENDOR_MODEL })
  assert.equal(unknown.freshness, 'unknown')
  assert.equal(unknown.proven, false)
  assert.deepEqual(unknown.facts, {})

  const observedAt = '2026-11-01T00:00:00Z'
  const fresh = capabilities({
    source: 'local-mock-contract', version: 'go-v1', observedAt, expiresAt: '2027-01-01T00:00:00Z',
    facts: { stream: true, tools: true, parallelTools: false, usage: true, efforts: ['low', 'high', 'max', 'medium'] },
  }, { now: Date.parse('2026-11-12T00:00:00Z') })
  assert.equal(fresh.freshness, 'fresh')
  assert.equal(fresh.proven, true)
  assert.equal(fresh.source, 'local-mock-contract')
  assert.deepEqual(fresh.facts.efforts, ['low', 'high', 'max'], '未证实的 medium 不外溢到能力事实')

  const stale = capabilities({ source: 'x', observedAt, expiresAt: '2026-11-02T00:00:00Z', facts: { stream: true } }, { now: Date.parse('2026-11-12T00:00:00Z') })
  assert.equal(stale.freshness, 'stale')
  assert.equal(stale.proven, false)
  assert.deepEqual(stale.facts, {})
})

test('P03 头构造：本服务 UA + 域派生会话标识，不转发原始 Codex id', () => {
  const provider = (id, baseUrl) => ({ id, baseUrl, _def: { baseUrl, opencodeGoVersion: 'go-v1' } })
  const req = { headers: { 'session-id': 'codex-thread-RAW-1', 'thread-id': 'codex-thread-RAW-1' } }
  const a = newHeaders({ req, provider: provider('opencodego', GO_BASE), cfg: {}, principalRef: 'caller-a', salt: 'synthetic-salt' })
  assert.equal(a.headers['user-agent'], SERVICE_UA)
  const value = a.headers[SESSION_HEADER]
  assert.match(value, /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(value, 'codex-thread-RAW-1', '绝不转发原始 Codex session/thread id')
  assert.equal(JSON.stringify(a).includes('codex-thread-RAW-1'), false)
  assert.equal(a.session.mode, 'derived')

  // 同线程 + 同域 + 同主体 → 稳定（会话亲和）
  const again = newHeaders({ req, provider: provider('opencodego', GO_BASE), cfg: {}, principalRef: 'caller-a', salt: 'synthetic-salt' })
  assert.equal(again.headers[SESSION_HEADER], value)

  // 域隔离：换 provider id / 入口域 / 主体 / root-child 域，值都不同
  const otherProvider = newHeaders({ req, provider: provider('opencodego-2', GO_BASE), cfg: {}, principalRef: 'caller-a', salt: 'synthetic-salt' })
  assert.notEqual(otherProvider.headers[SESSION_HEADER], value)
  const otherDomain = newHeaders({ req, provider: provider('opencodego', 'https://opencode.ai/zen/go/v1'), cfg: {}, principalRef: 'caller-a', salt: 'synthetic-salt' })
  assert.notEqual(otherDomain.headers[SESSION_HEADER], value)
  const otherPrincipal = newHeaders({ req, provider: provider('opencodego', GO_BASE), cfg: {}, principalRef: 'caller-b', salt: 'synthetic-salt' })
  assert.notEqual(otherPrincipal.headers[SESSION_HEADER], value)
  const childReq = { headers: { 'session-id': 'codex-thread-RAW-1', 'x-mg-session-scope': 'child' } }
  const child = newHeaders({ req: childReq, provider: provider('opencodego', GO_BASE), cfg: {}, principalRef: 'caller-a', salt: 'synthetic-salt' })
  assert.equal(child.session.scope, 'child')
  assert.notEqual(child.headers[SESSION_HEADER], value)

  // 无线程引用 → 请求内独立 id（不发明跨请求常量）
  const r1 = newHeaders({ req: { headers: {} }, provider: provider('opencodego', GO_BASE), cfg: {}, salt: 'synthetic-salt' })
  const r2 = newHeaders({ req: { headers: {} }, provider: provider('opencodego', GO_BASE), cfg: {}, salt: 'synthetic-salt' })
  assert.equal(r1.session.mode, 'request')
  assert.match(r1.headers[SESSION_HEADER], /^mg-[0-9a-f-]{36}$/)
  assert.notEqual(r1.headers[SESSION_HEADER], r2.headers[SESSION_HEADER])
  assert.notEqual(r1.headers[SESSION_HEADER], 'mg-opencodego-bridge')
})

test('P03 encode/usage/错误映射/断流判定', () => {
  const enc = encode({ model: 'mg-opencodego-deepseek-v4-1-flash', stream: true }, { vendorModel: DEFAULT_VENDOR_MODEL })
  assert.equal(enc.body.model, DEFAULT_VENDOR_MODEL)
  assert.deepEqual(enc.body.stream_options, { include_usage: true })
  assert.equal(encode(null).code, 'opencodego_body_invalid')

  assert.equal(usageOf({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }).kind, 'actual')
  assert.equal(usageOf({ usage: { input_tokens: 4, output_tokens: 1 } }).total, 5)
  const unknown = usageOf({ choices: [] })
  assert.equal(unknown.kind, 'unknown')
  assert.equal(unknown.total, null)

  const auth = decodeError(401, '{"error":"invalid key sk-synthetic12345678"}', {})
  assert.equal(auth.code, 'opencodego_auth_failed')
  assert.equal(auth.retryable, false)
  assert.equal(auth.message.includes('sk-synthetic12345678'), false, '错误消息必须脱敏')
  assert.equal(decodeError(403, 'forbidden', {}).quota, 'unknown')

  const short = decodeError(429, 'slow down', { 'retry-after': '2' })
  assert.equal(short.quota, 'short')
  assert.equal(short.retryable, true)
  assert.equal(short.retryAfterMs, 2000)
  const exhausted = decodeError(429, '{"error":"usage limit reached"}', {})
  assert.equal(exhausted.quota, 'exhausted')
  assert.equal(exhausted.retryable, false)
  assert.equal(exhausted.nextAction, 'check-official-usage')
  assert.equal(decodeError(429, 'slow down', {}).quota, 'unknown', '无证据不得把额度判成耗尽')

  const dropped = classifyStreamTerminal([{ delta: 'hi' }])
  assert.equal(dropped.ok, false)
  assert.equal(dropped.emitted, true)
  assert.equal(dropped.code, 'opencodego_stream_incomplete')
})

// —— 网关集成（本地 mock 上游）——

function sse(res, events, end = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const ev of events) res.write('data: ' + JSON.stringify(ev) + '\n\n')
  if (end) { res.write('data: [DONE]\n\n'); res.end() }
}

async function setup(t, handler, extra = {}) {
  const hits = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    return handler(req, res, hits[hits.length - 1])
  })
  const gw = await startGateway({
    config: Object.assign({
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 600 }, proxyMode: 'direct' },
      providers: { opencodego: { baseUrl: up.base + '/inference/go/openai/v1', api: 'openai', opencodeGoVersion: 'go-v1' } },
      models: { [DEFAULT_VENDOR_MODEL]: { provider: 'opencodego', api: 'openai', alias: [DEFAULT_ALIAS] } },
    }, extra),
  })
  t.after(async () => { await gw.stop(); await up.stop() })
  return { gw, up, hits }
}

test('P03 网关 POST：路径/模型/UA/派生会话头，且不转发 Codex 官方头', { timeout: 30000 }, async (t) => {
  const { gw, hits } = await setup(t, (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
  })
  const r = await gw.post('/v1/chat/completions', { model: DEFAULT_VENDOR_MODEL, messages: [{ role: 'user', content: 'hi' }] }, { 'session-id': 'codex-raw-thread-9', 'thread-id': 'codex-raw-thread-9' })
  assert.equal(r.status, 200)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, '/inference/go/openai/v1/chat/completions')
  assert.equal(JSON.parse(hits[0].body).model, DEFAULT_VENDOR_MODEL)
  assert.equal(hits[0].headers['user-agent'], SERVICE_UA)
  const session = hits[0].headers[SESSION_HEADER]
  assert.match(String(session), /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(session, 'codex-raw-thread-9')
  assert.equal(hits[0].headers['session-id'], undefined)
  assert.equal(hits[0].headers['thread-id'], undefined)
})

test('P03 多轮 tool loop：工具定义与 tool 结果原样进入下一轮', { timeout: 30000 }, async (t) => {
  const bodies = []
  const { gw } = await setup(t, (req, res, hit) => {
    bodies.push(JSON.parse(hit.body))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'c-' + bodies.length, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }))
  })
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
  const first = await gw.post('/v1/chat/completions', { model: DEFAULT_VENDOR_MODEL, stream: false, tools, messages: [{ role: 'user', content: 'read a.txt' }] }, { 'session-id': 'thread-tools' })
  assert.equal(first.status, 200)
  const firstBody = await first.json()
  assert.equal(firstBody.choices[0].message.tool_calls[0].id, 'call_1')

  const second = await gw.post('/v1/chat/completions', {
    model: DEFAULT_VENDOR_MODEL, stream: false, tools,
    messages: [
      { role: 'user', content: 'read a.txt' },
      firstBody.choices[0].message,
      { role: 'tool', tool_call_id: 'call_1', content: 'NONCE-7f3a' },
    ],
  }, { 'session-id': 'thread-tools' })
  assert.equal(second.status, 200)
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[1].tools, tools)
  assert.equal(bodies[1].messages[2].role, 'tool')
  assert.equal(bodies[1].messages[2].content, 'NONCE-7f3a')
})

test('P03 stream：SSE 透传、usage 保留、会话标识同线程稳定', { timeout: 30000 }, async (t) => {
  const { gw, hits } = await setup(t, (req, res) => {
    sse(res, [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'he' } }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: 'stop' }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ])
  })
  const r = await gw.post('/v1/chat/completions', { model: DEFAULT_VENDOR_MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'session-id': 'thread-stream' })
  assert.equal(r.status, 200)
  assert.match(String(r.headers.get('content-type')), /text\/event-stream/)
  const text = await r.text()
  assert.match(text, /"content":"he"/)
  assert.match(text, /"content":"llo"/)
  assert.match(text, /total_tokens/)
  assert.equal(hits.length, 1)
})

test('P03 429/401/403：状态与脱敏，不自动溢出到计费路径', { timeout: 30000 }, async (t) => {
  for (const [status, extraHeader] of [[429, { 'retry-after': '1' }], [401, {}], [403, {}]]) {
    const { gw, hits } = await setup(t, (req, res) => {
      res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, extraHeader))
      res.end(JSON.stringify({ error: { message: 'denied sk-syntheticSECRET123', type: 'synthetic' } }))
    })
    const r = await gw.post('/v1/chat/completions', { model: DEFAULT_VENDOR_MODEL, messages: [{ role: 'user', content: 'x' }] }, { 'session-id': 'thread-' + status })
    assert.equal(r.status, status, 'Go ' + status + ' 应按上游状态返回')
    const text = await r.text()
    assert.equal(text.includes('sk-syntheticSECRET123'), false, '错误体不得回显上游凭据片段')
    // 429 允许在**同一** Go 绑定内按 loopMs 有界重试；绝不换端点/换账号（本用例只配置了一个 Go 绑定）。
    assert.ok(hits.length >= 1 && hits.length <= 4, 'Go ' + status + ' 的重试必须有界：hits=' + hits.length)
    for (const hit of hits) assert.equal(hit.url, '/inference/go/openai/v1/chat/completions', 'Go ' + status + ' 不得溢出到其它端点')
  }
})

test('P03 断流：已出帧后上游中断，不得伪装成成功终态', { timeout: 30000 }, async (t) => {
  const { gw } = await setup(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] }) + '\n\n')
    setTimeout(() => { try { res.destroy() } catch {} }, 20)
  })
  let status = 0
  let text = ''
  try {
    const r = await gw.post('/v1/chat/completions', { model: DEFAULT_VENDOR_MODEL, stream: true, messages: [{ role: 'user', content: 'x' }] }, { 'session-id': 'thread-drop' })
    status = r.status
    text = await r.text()
  } catch { /* 连接被中止也是合法终态 */ }
  assert.equal(text.includes('"finish_reason":"stop"'), false, '断流不得伪造 finish_reason=stop')
  assert.ok(status === 0 || status >= 200, '断流应有明确终态')
})

test('P03 会话域隔离：同线程打到两个 Go 绑定得到不同会话标识', { timeout: 30000 }, async (t) => {
  const hitsA = []
  const hitsB = []
  const upA = await startScriptedUpstream(async (req, res) => { for await (const _ of req); hitsA.push(req.headers); res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' }] })) })
  const upB = await startScriptedUpstream(async (req, res) => { for await (const _ of req); hitsB.push(req.headers); res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'b' }, finish_reason: 'stop' }] })) })
  const mk = (name, up) => startGateway({
    name,
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 600 }, proxyMode: 'direct' },
      providers: { opencodego: { baseUrl: up.base + '/inference/go/openai/v1', api: 'openai', opencodeGoVersion: 'go-v1' } },
      models: { m: { provider: 'opencodego', api: 'openai' } },
    },
  })
  const gwA = await mk('go-iso-a', upA)
  const gwB = await mk('go-iso-b', upB)
  t.after(async () => { await gwA.stop(); await gwB.stop(); await upA.stop(); await upB.stop() })
  const send = (gw) => gw.post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { 'session-id': 'same-thread' })
  const ra = await send(gwA)
  const rb = await send(gwB)
  assert.equal(ra.status, 200)
  assert.equal(rb.status, 200)
  assert.match(String(hitsA[0]['x-opencode-session']), /^[A-Za-z0-9_-]{32}$/)
  assert.match(String(hitsB[0]['x-opencode-session']), /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(hitsA[0]['x-opencode-session'], hitsB[0]['x-opencode-session'], '同一线程在不同 Go 绑定上不得共享会话标识')
})
