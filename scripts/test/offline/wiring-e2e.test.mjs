// M1-3b（T-LIFE-04 / T-ROUTE-02）：index 注入 catalogRecord / ledgerOptions / 显式兼容模式
// 后的端到端验收。全部离线：合成目录 + 回环 mock + 真实临时账本目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startMockUpstream, startScriptedUpstream } from './harness.mjs'
import { authorizeSendTarget } from '../../../src/forward.js'
import { assertSendTarget } from '../../../src/codex/target-authz.js'

const json = () => ({ 'content-type': 'application/json' })
const CHAT_OK = (content) => JSON.stringify({
  id: 'mock', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: content || 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})
function officialModel(overrides = {}) {
  return {
    slug: 'gpt-test-sol',
    display_name: 'GPT Test Sol',
    description: 'Official fixture model',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_image_detail_original: true,
    context_window: 200000,
    max_context_window: 400000,
    comp_hash: '1000',
    effective_context_window_percent: 95,
    experimental_supported_tools: ['clock'],
    input_modalities: ['text', 'image'],
    supports_search_tool: true,
    supports_experimental_context: false,
    use_responses_lite: true,
    supports_reasoning_effort_updates: true,
    node_repl_auto_review_required: true,
    node_repl_disabled: false,
    tool_mode: 'code_mode_only',
    multi_agent_version: 'v2',
    multi_agent_reasoning_effort: 'high',
    base_instructions: 'You are Codex, a fixture agent.',
    model_messages: { instructions_template: 'You are Codex, a fixture agent.' },
    ...overrides,
  }
}
async function gwLog(gw) {
  const files = (await readdir(gw.dir)).filter((f) => f.endsWith('.log'))
  const parts = await Promise.all(files.map((f) => readFile(join(gw.dir, f), 'utf8')))
  return parts.join('\n')
}

test('M1-3b catalog slug：注入 catalogRecord 后 200；上游 model = 裁决 target；发送前已有账本预留', { timeout: 60000 }, async (t) => {
  const catalogDir = mkdtempSync(join(tmpdir(), 'mg-wire-cat-'))
  const ledgerDir = await mkdtemp(join(tmpdir(), 'mg-wire-cat-ledger-'))
  t.after(() => { rmSync(catalogDir, { recursive: true, force: true }); return rm(ledgerDir, { recursive: true, force: true }) })
  const basePath = join(catalogDir, 'catalog-base.json')
  writeFileSync(basePath, JSON.stringify({ models: [officialModel()] }))

  let reservedBeforeRespond = false
  const bodies = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    try {
      const state = JSON.parse(await readFile(join(ledgerDir, 'ledger.json'), 'utf8'))
      reservedBeforeRespond = Object.values(state.attempts || {}).some((a) => a.status === 'reserved')
    } catch { reservedBeforeRespond = false }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(CHAT_OK('catalog-ok'))
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'm13b-catalog',
    env: { MG_ADMIN_TOKEN: '' },
    config: {
      defaults: {
        model: '', codexOfficialProvider: '',
        retry: { maxAttempts: 1 }, timeout: { firstByteMs: 3000, idleMs: 3000, loopMs: 3000 },
        codexCatalogBasePath: basePath,
        codexFallbackLimits: { maxSameProviderAttempts: 0, maxFailovers: 1, maxTotalAttempts: 2 },
      },
      providers: { third: { baseUrl: upstream.base + '/v1', api: 'openai', costEstimateUsd: 0.001 } },
      models: { alpha: { provider: 'third', api: 'openai', maxContext: 128000, costEstimateUsd: 0.001 } },
      routing: { ledger: { dir: ledgerDir, currency: 'USD' } },
    },
  })
  t.after(() => gw.stop())

  const res = await gw.post('/v1/responses', { model: 'mg-third-alpha', input: 'hi', stream: false }, json())
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, 'alpha', '上游必须收到目录绑定的原模型名')
  assert.equal(reservedBeforeRespond, true, '上游被命中前账本必须已有 reserved attempt')
  const log = await gwLog(gw)
  assert.match(log, /send authz|codex fallback decision/, '应有授权/决策审计')
  assert.equal(log.includes('sk-'), false)
})

test('M1-3b official Chat（非目录参与）200，不要求 catalogRecord', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(CHAT_OK('official-ok'))
  })
  t.after(() => upstream.stop())
  // F01：官方目标只认网关自有 key（客户端官方凭据透传已移除）。
  const gw = await startGateway({
    name: 'm13b-official-chat',
    env: { MG_TEST_OFFICIAL_KEY: 'gw-official-wiring-key' },
    config: {
      defaults: { provider: 'official', codexOfficialHosts: ['127.0.0.1'] },
      providers: { official: { baseUrl: upstream.base, codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: { demo: { provider: 'official' } },
    },
  })
  t.after(() => gw.stop())
  const res = await fetch(gw.base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer CLIENT-OFFICIAL-TOKEN', 'chatgpt-account-id': 'acct-1' },
    body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(upstream.hits.length, 1)
  // 客户端带来的官方凭据不得到达官方上游；只允许网关自有 key。
  assert.equal(upstream.hits[0].headers.authorization, 'Bearer gw-official-wiring-key')
  assert.equal(upstream.hits[0].headers['chatgpt-account-id'], undefined)
})

test('M1-3b catalogScoped 但 record 缺失 → 403 catalog_generation_missing（单元）', () => {
  const cfg = { defaults: {}, providers: { third: { baseUrl: 'http://127.0.0.1:9' } } }
  const provider = { id: 'third', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', pathPrefix: '', _def: {} }
  const base = { cfg, provider, pid: 'third', path: '/v1/chat/completions', req: { headers: {} }, log: null, catalogScoped: true }
  assert.throws(() => authorizeSendTarget(Object.assign({}, base, { opts: {} })), (e) => e.code === 'catalog_generation_missing' && e.status === 403)

  const record = { generation: 7, key: 'k7', verified: { official: true, thirdParty: true } }
  const authz = authorizeSendTarget(Object.assign({}, base, { opts: { catalogRecord: record, catalogGeneration: 7 } }))
  assert.equal(authz.generation, 7)
  assert.equal(assertSendTarget(authz, 'http://127.0.0.1:9/v1/chat/completions'), authz, '授权对象必须等于实际发送对象')

  const noRecordForPlain = authorizeSendTarget({ cfg, provider, pid: 'third', path: '/v1/chat/completions', req: { headers: {} }, log: null, catalogScoped: false, opts: {} })
  assert.equal(noRecordForPlain.generation, 'config-declared', '非目录参与的普通请求走可审计的 config-declared 世代')
})

test('M1-3c 非规范目标形状：发送前 403、零命中、零账本残留', { timeout: 60000 }, async (t) => {
  const cases = [
    { name: 'a', base: (u) => u + '/v1', prefix: '/v1', code: 'target_path_duplicated' },
    { name: 'b', base: (u) => u + '/v1?x=1', prefix: '', code: 'target_query_not_allowed' },
    { name: 'c', base: (u) => u, prefix: '?q=1', code: 'target_query_not_allowed' },
    { name: 'd', base: (u) => u, prefix: '/../v2', code: 'target_path_traversal' },
    { name: 'e', base: (u) => u, prefix: '//evil', code: 'target_path_not_allowed' },
  ]
  for (const c of cases) {
    const upstream = await startScriptedUpstream(async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(CHAT_OK())
    })
    const ledgerDir = await mkdtemp(join(tmpdir(), 'm13c-ledger-'))
    t.after(async () => { await upstream.stop(); await rm(ledgerDir, { recursive: true, force: true }) })
    const gw = await startGateway({
      name: 'm13c-' + c.name,
      config: {
        defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
        providers: { p1: { baseUrl: c.base(upstream.base), pathPrefix: c.prefix } },
        models: { 'wire-shape': { provider: 'p1', costEstimateUsd: 0.001 } },
        routing: { ledger: { dir: ledgerDir, currency: 'USD' } },
      },
    })
    t.after(() => gw.stop())
    const res = await gw.post('/v1/chat/completions', { model: 'wire-shape', messages: [{ role: 'user', content: 'hi' }] }, json())
    const body = await res.json()
    assert.equal(res.status, 403, c.name + ' 必须发送前拒绝：' + JSON.stringify(body))
    assert.equal(body.error.code, c.code, c.name + ' 的稳定拒绝码')
    assert.equal(upstream.hits.length, 0, c.name + ' 上游零命中')
    let attempts = {}
    try { attempts = JSON.parse(await readFile(join(ledgerDir, 'ledger.json'), 'utf8')).attempts || {} } catch { attempts = {} }
    assert.equal(Object.keys(attempts).length, 0, c.name + ' 不得留下账本 attempt')
    await gw.stop()
  }
})

test('M1-3c 正向：既有 /v1 去重与合法 pathPrefix 不被过度收紧', { timeout: 45000 }, async (t) => {
  const seen = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(CHAT_OK())
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'm13c-positive',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base + '/v1' } },
      models: { 'wire-v1': { provider: 'p1' } },
    },
  })
  t.after(() => gw.stop())
  const a = await gw.post('/v1/chat/completions', { model: 'wire-v1', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(a.status, 200)
  assert.equal(seen[0], '/v1/chat/completions', 'baseUrl 尾 /v1 的既有去重必须保留')

  const gw2 = await startGateway({
    name: 'm13c-prefix',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base, pathPrefix: '/api/v2' } },
      models: { 'wire-prefix': { provider: 'p1' } },
    },
  })
  t.after(() => gw2.stop())
  const b = await gw2.post('/v1/chat/completions', { model: 'wire-prefix', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(b.status, 200)
  assert.equal(seen[1], '/api/v2/v1/chat/completions', '合法 pathPrefix 必须原样拼接')
})

test('M1-3b 未配置 ledger + 配置费用上限 → typed 拒绝，零上游', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK()) })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'm13b-limit',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base } },
      models: { 'wire-limit': { provider: 'p1', costEstimateUsd: 0.01 } },
      routing: { budget: { requestUsd: 0.1 } },
    },
  })
  t.after(() => gw.stop())
  const res = await gw.post('/v1/chat/completions', { model: 'wire-limit', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.error.code, 'ledger_required_for_cost_limits')
  assert.equal(upstream.hits.length, 0)
})


// ============================================================================
// F03：统一发送授权与取消（下游头白名单 / Responses 旁路封口 / 一次终态）
// ============================================================================

test('F03 下游响应头白名单（R1 2c4f2a9 反向断言）：上游 429 夹带 set-cookie/x-*/location 一律不到客户端', { timeout: 45000 }, async (t) => {
  const SENTINEL = 'SENTINEL-UPSTREAM-HEADER-F03'
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '3',
      'set-cookie': 'sid=leak; HttpOnly',
      'x-upstream-secret': SENTINEL,
      location: 'http://evil.test/steal',
    })
    res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }))
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'f03-downstream-headers',
    config: {
      // loopMs 只留 300ms：429 的 Retry-After(3s) 等不下即有界收口，避免默认 120s 循环兜底把测试拖超时。
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 300 } },
      providers: { third: { baseUrl: upstream.base + '/v1' } },
      models: { demo: { provider: 'third', api: 'openai' } },
    },
  })
  t.after(() => gw.stop())

  const res = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(res.status, 429, '429 语义必须保留')
  assert.equal(res.headers.get('retry-after'), '3', '白名单内的 retry-after 必须下发')
  for (const name of ['set-cookie', 'x-upstream-secret', 'location']) {
    assert.equal(res.headers.get(name), null, '上游头不得透传到客户端：' + name)
  }
  const text = await res.text()
  assert.equal(text.includes(SENTINEL), false, '响应体也不得夹带上游头值')
})

test('F03 Responses 旁路封口：官方 responses 目标含 userinfo → 403 typed、零上游命中', { timeout: 45000 }, async (t) => {
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    hits.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r1', object: 'response', status: 'completed', model: 'gpt-official-test', output: [] }))
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'f03-responses-drift',
    env: { MG_TEST_OFFICIAL_KEY: 'gw-official-f03-key' },
    config: {
      defaults: { codexOfficialHosts: ['localhost'] },
      // userinfo 注入：授权对象与实际发送对象必须逐字段一致，这里必须先被拒绝
      providers: { official: { baseUrl: 'http://user:pass@localhost:' + upstream.port, codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: { 'gpt-official-test': { provider: 'official', api: 'responses' } },
    },
  })
  t.after(() => gw.stop())

  const res = await gw.post('/v1/responses', { model: 'gpt-official-test', input: 'hi' }, json())
  assert.equal(res.status, 403, '未通过发送授权必须 403')
  const body = await res.json()
  assert.equal(body.error.code, 'target_userinfo_forbidden')
  assert.equal(hits.length, 0, '授权失败零上游命中')
})

test('F03 原生 Responses 一次终态：上游 3xx → 502 upstream_redirect_rejected，Location 零命中、只发一次', { timeout: 45000 }, async (t) => {
  const sinkHits = []
  const sink = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    sinkHits.push({ url: req.url })
    res.writeHead(200, { 'content-type': 'application/json', 'x-sink': 'hit' })
    res.end('{"ok":true}')
  })
  t.after(() => sink.stop())
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    hits.push({ url: req.url })
    res.writeHead(302, { location: sink.base + '/v1/responses' })
    res.end()
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'f03-native-redirect',
    config: {
      providers: { third: { baseUrl: upstream.base + '/v1' } },
      models: { native: { provider: 'third', api: 'responses' } },
    },
  })
  t.after(() => gw.stop())

  const res = await gw.post('/v1/responses', { model: 'native', input: 'hi' }, json())
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error.code, 'upstream_redirect_rejected')
  assert.equal(hits.length, 1, '只命中原始上游一次（noRetry，不重放）')
  assert.equal(sinkHits.length, 0, '拒绝跟随 Location')
})

test('F03 错误状态表与下游头白名单（单元）：码→状态唯一真源，白名单只放行 retry-after', async () => {
  const { sanitizeDownstreamHeaders } = await import('../../../src/index.js')
  const { ERROR_STATUS_TABLE, statusForErrorCode } = await import('../../../src/attempt-state.js')
  assert.equal(ERROR_STATUS_TABLE.send_target_drift, 403)
  assert.equal(ERROR_STATUS_TABLE.official_no_gateway_key, 403)
  assert.equal(ERROR_STATUS_TABLE.upstream_redirect_rejected, 502)
  assert.equal(ERROR_STATUS_TABLE.request_timeout, 504)
  assert.equal(statusForErrorCode('not_registered_code'), 502, '未登记码按上游失败收口')
  const clean = sanitizeDownstreamHeaders({
    'retry-after': '3',
    'set-cookie': 'a=b',
    location: 'http://evil.test/',
    'x-upstream-secret': 's',
    'transfer-encoding': 'chunked',
    'content-length': '9',
  })
  assert.deepEqual(clean, { 'retry-after': '3' }, '只允许白名单头，其余（含帧层/安全头）一律丢弃')
  assert.deepEqual(sanitizeDownstreamHeaders({ 'retry-after': '1\r\nX-Injected: 1' }), {}, '控制字符值必须丢弃')
  assert.deepEqual(sanitizeDownstreamHeaders(undefined), {})
})


// ============================================================================
// N06：有限历史 / 重启对账 / 短期 SSE 快照
// ============================================================================

test('N06 有限历史与重启：ring 有界并计数 dropped；重启后事件从头开始且契约稳定', { timeout: 60000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'mg-n06-ring-'))
  const config = {
    defaults: { observability: { capacity: 2 } },
    providers: { mock: { baseUrl: upstream.base } },
    models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
  }
  const gw1 = await startGateway({ name: 'n06-ring', dir, config })
  t.after(async () => { await upstream.stop(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 3; i++) {
    await gw1.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'ring-' + i }] }, json())
  }
  const page = await (await gw1.get('/api/observability/events?limit=10')).json()
  assert.equal(page.version, 1)
  assert.equal(page.retained.capacity, 2, '容量来自配置')
  assert.equal(page.retained.count, 2, '只保留最近 capacity 条')
  assert.ok(page.retained.dropped >= 1, '被淘汰条数必须如实计数')
  const text = JSON.stringify(page)
  assert.equal(text.includes('ring-0'), false, '事件不保留正文（历史也一样）')
  await gw1.stop()

  const gw2 = await startGateway({ name: 'n06-ring', dir, config })
  t.after(() => gw2.stop())
  const fresh = await (await gw2.get('/api/observability/events')).json()
  assert.equal(fresh.version, 1)
  assert.equal(fresh.contract, 'mg-observability-v1')
  assert.equal(fresh.items.length, 0, '事件是短期内存缓冲：重启后不伪造历史')
  assert.equal(fresh.retained.dropped, 0)
})

test('N06 短期 SSE：连接即收到有界快照，且事件体不含正文', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'n06-sse',
    config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'SSE-CANARY-N06' }] }, json())

  const ctl = new AbortController()
  const res = await fetch(gw.base + '/api/observability/stream', { headers: { accept: 'text/event-stream' }, signal: ctl.signal })
  assert.equal(res.status, 200)
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/)
  const reader = res.body.getReader()
  let buf = ''
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !/event: request/.test(buf)) {
    const { value, done } = await reader.read()
    if (done) break
    buf += Buffer.from(value).toString('utf8')
  }
  try { ctl.abort() } catch {}
  assert.match(buf, /event: request/, 'SSE 应重放有界快照里的 request 事件')
  assert.equal(buf.includes('SSE-CANARY-N06'), false, 'SSE 事件体不得包含正文')
})
