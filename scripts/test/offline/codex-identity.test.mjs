// E1 凭据隔离与严格路由（codex 聚合 P0）：官方/第三方头矩阵、extraHeaders 越权、官方 host/path 白名单、
// 302 不跟随、聚合保留 ID 严格不回退。全部离线：本地 mock 上游 + 动态端口 + OS 临时配置目录；
// 不使用真实凭据/上游，不读写 ~/.codex 或用户主配置。断言只比较「头是否存在/长度」，不把值写进日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../../../src/router.js'
import { classifyTarget, isOfficialHost } from '../../../src/codex/identity.js'
import { planTargetHeaders, applyExtraHeaders, targetDeny, CREDENTIAL_HEADERS, OFFICIAL_ONLY_HEADERS, OFFICIAL_ONLY_PREFIXES } from '../../../src/codex/auth.js'
import { buildHeaders } from '../../../src/forward.js'
import { embeddingHeaders } from '../../../src/embeddings.js'
import { rerankHeaders } from '../../../src/rerank.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

// Codex 0.167 官方路径实测头（E0/Lead 证据）。**值全部为虚构哨兵**，只用于断言存在/不存在。
const OFFICIAL_REQUEST_HEADERS = {
  authorization: 'Bearer CLIENT-OFFICIAL-TOKEN',
  'chatgpt-account-id': 'acct-CLIENT-ACCOUNT',
  'openai-beta': 'responses=experimental',
  version: '0.167.0',
  originator: 'codex_cli_rs',
  'session-id': 'sess-CLIENT-SESSION',
  'thread-id': 'thread-CLIENT-THREAD',
  'x-client-request-id': 'req-CLIENT-REQUEST',
  'x-codex-beta-features': 'multi_agent',
  'x-codex-turn-metadata': '{"turn":1}',
  'x-codex-window-id': 'win-CLIENT-WINDOW',
  'x-codex-routing-hint': 'hint',
  'x-openai-internal-codex-responses-lite': '1',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
  'x-ordinary-client-header': 'kept',
}

// 第三方目标必须消失的头（逐头断言）。connection 由 Node 客户端自行生成，单独按 token 断言。
const STRIPPED_FOR_THIRD_PARTY = [
  'chatgpt-account-id', 'openai-beta', 'version', 'originator',
  'session-id', 'thread-id', 'x-client-request-id', 'x-codex-beta-features',
  'x-codex-turn-metadata', 'x-codex-window-id', 'x-codex-routing-hint',
  'x-openai-internal-codex-responses-lite', 'x-openai-internal-codex-responses-lite',
  'sec-websocket-key', 'sec-websocket-version', 'upgrade',
]

const CHAT = { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }

function rawRequest(base, path, body, headers, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(base + path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, payload ? { 'content-length': payload.length } : {}, headers),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function echoUpstream() {
  return startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'mock-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
}

// 隔离实例 + 显式上游 key（走 keys.local.json 明文形态；测试主密钥由 harness 注入）。
async function startIsolated(opts) {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-e1-'))
  if (opts.keys) await writeFile(join(dir, 'keys.local.json'), JSON.stringify(opts.keys))
  const gw = await startGateway({ name: opts.name, dir, config: opts.config, env: opts.env })
  const closeGateway = gw.stop
  const stop = async () => { await closeGateway(); await rm(dir, { recursive: true, force: true }) }
  return Object.assign(gw, { stop })
}

// 日志按天分文件（<base>-YYYY-MM-DD.log），统一读取目录内最新的 .log。
function readLog(gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  assert.ok(names.length > 0, '网关应写出日志文件')
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}

function thirdPartyConfig(upstream, extra) {
  return {
    defaults: Object.assign({ provider: 'third' }, (extra && extra.defaults) || {}),
    providers: Object.assign({ third: { baseUrl: upstream.base, apiKeyEnv: '' } }, (extra && extra.providers) || {}),
    models: { demo: { provider: 'third' } },
  }
}

function assertNotForwarded(seen, name) {
  if (name === 'connection') {
    assert.equal(/upgrade/i.test(String(seen.connection || '')), false, 'connection 不得携带 upgrade')
    return
  }
  assert.equal(seen[name], undefined, '第三方目标不得收到 ' + name)
}

test('复现→修复：第三方目标剥除官方专用头，仅保留网关注入的自有 key', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({ name: 'e1-third-party', keys: { third: 'gw-provider-key' }, config: thirdPartyConfig(upstream) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await rawRequest(gw.base, '/v1/chat/completions', CHAT, OFFICIAL_REQUEST_HEADERS)
  assert.equal(res.status, 200, '剥离头不影响转发')
  assert.equal(upstream.hits.length, 1, '恰好一次上游请求')
  const seen = upstream.hits[0].headers

  for (const name of STRIPPED_FOR_THIRD_PARTY) assertNotForwarded(seen, name)
  assert.equal(seen.authorization, 'Bearer gw-provider-key', '只允许网关注入的自有 key')
  assert.equal(seen['user-agent'], 'model-gateway/0.1')
  assert.equal(seen['x-ordinary-client-header'], 'kept', '非官方头照常转发（不误伤普通客户端）')

  const log = readLog(gw)
  for (const value of ['CLIENT-OFFICIAL-TOKEN', 'acct-CLIENT-ACCOUNT', 'sess-CLIENT-SESSION', 'thread-CLIENT-THREAD']) {
    assert.equal(log.includes(value), false, '日志不得包含头值 ' + value)
  }
  assert.equal(log.includes('x-codex-turn-metadata'), true, '审计只记录被丢弃的头名')
})

test('复现→修复：恶意 extraHeaders 不得覆盖/注入鉴权头（忽略并审计）', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({
    name: 'e1-evil-extra',
    keys: { third: 'gw-provider-key' },
    config: thirdPartyConfig(upstream, {
      providers: {
        third: {
          baseUrl: upstream.base,
          extraHeaders: { authorization: 'Bearer EVIL-TOKEN', 'chatgpt-account-id': 'acct-EVIL', 'x-api-key': 'EVIL-X-API-KEY', 'x-ok': 'kept' },
        },
      },
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  assert.equal((await rawRequest(gw.base, '/v1/chat/completions', CHAT, OFFICIAL_REQUEST_HEADERS)).status, 200)
  const seen = upstream.hits[0].headers
  assert.equal(seen.authorization, 'Bearer gw-provider-key', 'extraHeaders 不得覆盖 authorization')
  assert.equal(seen['chatgpt-account-id'], undefined, 'extraHeaders 不得注入官方账号头')
  assert.equal(seen['x-api-key'], undefined, 'extraHeaders 不得注入别家协议 key')
  assert.equal(seen['x-ok'], 'kept', '非鉴权 extraHeaders 仍生效')
  const log = readLog(gw)
  assert.equal(log.includes('EVIL-TOKEN'), false, '被拦截的头值不得进日志')
  assert.equal(log.includes('extraHeaders 鉴权头/帧层头已拦截'), true, '越权 extraHeaders 必须留审计痕迹')
})

test('第三方目标无自有 key：不得继承客户端 Authorization（宁可 401）', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({ name: 'e1-no-key', config: thirdPartyConfig(upstream) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  await rawRequest(gw.base, '/v1/chat/completions', CHAT, OFFICIAL_REQUEST_HEADERS)
  assert.equal(upstream.hits.length, 1)
  assert.equal(upstream.hits[0].headers.authorization, undefined, '无自有 key 时不得继承客户端官方 token')
  assert.equal(upstream.hits[0].headers['chatgpt-account-id'], undefined)
})

test('官方目标分类矩阵：名字不参与判定，声明与 host 冲突即 fail-closed', () => {
  const cfg = {}
  assert.equal(classifyTarget({ id: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'k' }, cfg).kind, 'official')
  assert.equal(classifyTarget({ id: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'k' }, cfg).kind, 'thirdParty', '叫 openai 但非官方 host → 第三方')
  assert.equal(classifyTarget({ id: 'whatever', baseUrl: 'https://chatgpt.com/backend-api/codex' }, cfg).kind, 'official')
  assert.equal(classifyTarget({ id: 'p', baseUrl: 'http://127.0.0.1:1' }, cfg).kind, 'thirdParty')
  const mismatch = classifyTarget({ id: 'p', baseUrl: 'http://127.0.0.1:1', codexIdentity: 'official' }, cfg)
  assert.equal(mismatch.kind, 'unknown')
  assert.equal(mismatch.reason, 'declared_official_host_mismatch')
  const onOfficial = classifyTarget({ id: 'p', baseUrl: 'https://api.openai.com', codexIdentity: 'thirdParty' }, cfg)
  assert.equal(onOfficial.kind, 'unknown', '显式第三方却指向官方 host → unknown')
  assert.equal(classifyTarget({ id: 'p', baseUrl: 'not a url' }, cfg).kind, 'unknown')
  assert.equal(classifyTarget({ id: 'p', baseUrl: 'https://x.test', codexIdentity: 'bogus' }, cfg).kind, 'unknown')
  // defaults.codexOfficialHosts 显式扩白名单（测试/自建官方代理场景）
  assert.equal(isOfficialHost('127.0.0.1', { defaults: { codexOfficialHosts: ['127.0.0.1'] } }), true)
})

test('官方目标（无自有 key、透传关闭）：403 official_passthrough_disabled，零上游请求', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({
    name: 'e1-official-off',
    config: {
      defaults: { provider: 'official', codexOfficialHosts: ['127.0.0.1'] },
      providers: { official: { baseUrl: upstream.base, codexIdentity: 'official' } },
      models: { demo: { provider: 'official' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await rawRequest(gw.base, '/v1/chat/completions', CHAT, OFFICIAL_REQUEST_HEADERS)
  assert.equal(res.status, 403)
  assert.equal(res.json.error.code, 'official_passthrough_disabled')
  assert.equal(upstream.hits.length, 0, '默认 fail-closed：不得发上游请求')
  const log = readLog(gw)
  assert.equal(log.includes('CLIENT-OFFICIAL-TOKEN'), false)
})

test('官方目标（无自有 key、透传开启）：官方头原样透传，白名单外头丢弃', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({
    name: 'e1-official-on',
    env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1' },
    config: {
      defaults: { provider: 'official', codexOfficialHosts: ['127.0.0.1'] },
      providers: { official: { baseUrl: upstream.base, codexIdentity: 'official' } },
      models: { demo: { provider: 'official' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await rawRequest(gw.base, '/v1/chat/completions', CHAT, OFFICIAL_REQUEST_HEADERS)
  assert.equal(res.status, 200, '透传开启后应放行')
  const seen = upstream.hits[0].headers
  for (const name of ['authorization', 'chatgpt-account-id', 'openai-beta', 'version', 'originator', 'session-id', 'thread-id', 'x-client-request-id', 'x-codex-beta-features', 'x-codex-turn-metadata', 'x-codex-window-id', 'x-codex-routing-hint', 'x-openai-internal-codex-responses-lite']) {
    assert.notEqual(seen[name], undefined, '官方目标应保留 ' + name)
  }
  assert.equal(seen.authorization, 'Bearer CLIENT-OFFICIAL-TOKEN', '透传路径使用客户端官方凭据')
  assert.equal(seen['x-ordinary-client-header'], undefined, '官方白名单外头必须丢弃')
  assert.equal(seen['sec-websocket-key'], undefined, 'WS 帧层头永不转发')
})

test('官方目标（自有 key）：网关注入 key，客户端官方凭据不透传（两条路互斥）', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({
    name: 'e1-official-key',
    keys: { official: 'gw-official-key' },
    config: {
      defaults: { provider: 'official', codexOfficialHosts: ['127.0.0.1'] },
      providers: { official: { baseUrl: upstream.base, codexIdentity: 'official' } },
      models: { demo: { provider: 'official' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await rawRequest(gw.base, '/v1/chat/completions', CHAT, OFFICIAL_REQUEST_HEADERS)
  assert.equal(res.status, 200)
  const seen = upstream.hits[0].headers
  assert.equal(seen.authorization, 'Bearer gw-official-key', '自有 key 优先')
  assert.equal(seen['chatgpt-account-id'], undefined, '自有 key 路径不得混入客户端账号头')
  assert.equal(seen['x-codex-turn-metadata'], '{"turn":1}', '官方白名单内的非凭据头保留')
})

test('官方目标 host/path/scheme 白名单（fail-closed）与 extraHeaders 守卫（单元）', () => {
  const cfg = {}  // 默认官方 host 清单（api.openai.com / chatgpt.com / chat.openai.com）
  const official = (over) => Object.assign({ id: 'o', baseUrl: 'https://api.openai.com', apiKey: 'k', _def: {} }, over)
  const denied = (o, path) => targetDeny({ identity: classifyTarget(o, cfg), provider: o, cfg, path, env: {} })

  assert.equal(denied(official(), '/v1/chat/completions'), null)
  assert.equal(denied(official(), '/v1/models'), null, 'GET /v1/models?client_version 属合法官方路径')
  assert.equal(denied(official(), '/backend-api/codex/responses'), null)
  assert.equal(denied(official(), '/admin/secret').code, 'official_path_not_allowlisted')
  assert.equal(denied(official({ baseUrl: 'http://api.openai.com' }), '/v1/chat/completions').code, 'official_target_insecure_scheme')
  assert.equal(denied({ id: 'u', baseUrl: 'https://evil.test', codexIdentity: 'official' }, '/v1/x').code, 'target_identity_unknown')
  assert.equal(targetDeny({ identity: { kind: 'unknown', reason: 'missing_base_url' }, provider: { id: 'x' }, cfg, path: '/v1/x', env: {} }).code, 'target_identity_unknown')
  assert.equal(targetDeny({ identity: { kind: 'thirdParty' }, provider: { id: 't' }, cfg, path: '/v1/x', env: {} }), null, '第三方不受官方路径限制')

  // extraHeaders：凭据类与帧层头一律拦下，普通头保留。
  const headers = {}
  const r = applyExtraHeaders(headers, { authorization: 'Bearer EVIL', 'x-api-key': 'EVIL', 'chatgpt-account-id': 'a', host: 'evil.test', 'x-custom': 'ok' })
  assert.equal(headers['x-custom'], 'ok')
  for (const h of ['authorization', 'x-api-key', 'chatgpt-account-id', 'host']) assert.equal(headers[h], undefined, h)
  assert.deepEqual(r.blocked.sort(), ['authorization', 'chatgpt-account-id', 'host', 'x-api-key'])
  for (const h of CREDENTIAL_HEADERS) assert.equal(planTargetHeaders({ identity: { kind: 'thirdParty' }, incoming: { [h]: 'v' }, provider: {} }).headers[h], undefined, '凭据不得过第三方: ' + h)
})

test('buildHeaders 直连断言：官方白名单 vs 第三方剥离集逐条核对', () => {
  const req = { headers: Object.assign({}, OFFICIAL_REQUEST_HEADERS) }
  const providerKey = { id: 'o', baseUrl: 'https://api.openai.com', apiKey: 'gw-key', extraHeaders: {}, _def: {} }
  const cfg = {}
  const identity = classifyTarget(providerKey, cfg)
  const official = buildHeaders(req, providerKey, Buffer.from('{}'), cfg, 'openai', {}, { identity })
  assert.equal(official.authorization, 'Bearer gw-key')
  for (const h of OFFICIAL_ONLY_HEADERS.filter((n) => n !== 'authorization' && n !== 'chatgpt-account-id')) assert.notEqual(official[h], undefined, '官方白名单应保留 ' + h)
  for (const p of ['x-codex-', 'x-openai-internal-']) assert.equal(Object.keys(official).some((n) => n.startsWith(p)), true, '官方白名单前缀 ' + p)
  assert.equal(official['x-ordinary-client-header'], undefined)
  assert.equal(official['sec-websocket-key'], undefined)

  const third = { id: 't', baseUrl: 'http://127.0.0.1:9', apiKey: 'gw-key', extraHeaders: {}, _def: {} }
  const tIdentity = classifyTarget(third, cfg)
  const seen = buildHeaders(req, third, Buffer.from('{}'), cfg, 'openai', {}, { identity: tIdentity })
  assert.equal(seen.authorization, 'Bearer gw-key', '第三方只收网关自有 key')
  for (const h of OFFICIAL_ONLY_HEADERS.filter((n) => n !== 'authorization')) assert.equal(seen[h], undefined, '第三方剥离集: ' + h)
  assert.equal(Object.keys(seen).some((n) => OFFICIAL_ONLY_PREFIXES.some((p) => n.startsWith(p))), false, '第三方不得残留官方前缀头')
  assert.equal(seen['x-ordinary-client-header'], 'kept')
  assert.equal(seen['user-agent'], 'model-gateway/0.1')
})

test('embeddings/rerank：extraHeaders 同样不得覆盖或注入鉴权头', () => {
  const cfg = { defaults: { extraHeaders: { authorization: 'Bearer EVIL', 'x-goog-api-key': 'EVIL' } } }
  const provider = { id: 'p', apiKey: 'real-key', extraHeaders: { 'x-api-key': 'EVIL', 'x-ok': 'kept' } }
  const eh = embeddingHeaders(cfg, provider, 'openai', Buffer.from('{}'))
  assert.equal(eh.authorization, 'Bearer real-key')
  assert.equal(eh['x-goog-api-key'], undefined)
  assert.equal(eh['x-api-key'], undefined)
  assert.equal(eh['x-ok'], 'kept')
  const rh = rerankHeaders(cfg, provider, 'openai', Buffer.from('{}'))
  assert.equal(rh.authorization, 'Bearer real-key')
  assert.equal(rh['x-api-key'], undefined)
  assert.equal(rh['x-ok'], 'kept')
})

test('复现→修复：未知聚合保留 ID 硬失败（404，零上游请求）', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({ name: 'e1-agg-fallback', config: thirdPartyConfig(upstream) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  for (const model of ['mg/ghost/model', 'mg-ghost-model']) {
    const hitsBefore = upstream.hits.length
    const res = await rawRequest(gw.base, '/v1/chat/completions', { model, messages: CHAT.messages }, {})
    assert.equal(res.status, 404, '聚合保留 ID 未命中必须 404: ' + model)
    assert.equal(res.json.error.type, 'unknown_model')
    assert.equal(res.json.error.code, 'unknown_model')
    assert.ok(Array.isArray(res.json.error.available), '404 附带可用聚合 ID 列表')
    assert.equal(upstream.hits.length, hitsBefore, '零上游请求: ' + model)
  }
})

test('聚合保留 ID：已配置即正常路由，旧接口兜底兼容不变', { timeout: 30000 }, async (t) => {
  const cfg = { defaults: { provider: 'p' }, providers: { p: {} }, models: { 'mg-vendor-real': { provider: 'p' }, other: { provider: 'p', alias: ['mg-alias'] } } }
  const r = createRouter(cfg)
  assert.equal(r.resolve('mg-vendor-real').canonicalName, 'mg-vendor-real')
  assert.equal(r.resolve('mg-alias').canonicalName, 'other')
  assert.throws(() => r.resolve('mg-vendor-missing'), (e) => e.code === 'unknown_model' && e.status === 404)
  assert.throws(() => r.resolve('MG/upper/case'), (e) => e.code === 'unknown_model', '前缀匹配大小写不敏感')
  const legacy = r.resolve('some-unconfigured-model')
  assert.equal(legacy.known, false)
  assert.deepEqual(legacy.def, { provider: 'p' })
  // defaults.aggregatePrefixes 可覆盖：自定义前缀同样严格
  const r2 = createRouter(Object.assign({}, cfg, { defaults: { provider: 'p', aggregatePrefixes: ['agg:'] } }))
  assert.throws(() => r2.resolve('agg:ghost'), (e) => e.code === 'unknown_model')
  assert.equal(r2.resolve('mg-vendor-missing').known, false, '覆盖前缀后旧前缀恢复兜底语义')

  // 端到端：已配置聚合 ID 可正常转发
  const upstream = await echoUpstream()
  const gw = await startIsolated({
    name: 'e1-agg-ok',
    config: { defaults: { provider: 'third' }, providers: { third: { baseUrl: upstream.base } }, models: { 'mg-vendor-real': { provider: 'third' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const ok = await rawRequest(gw.base, '/v1/chat/completions', { model: 'mg-vendor-real', messages: CHAT.messages }, {})
  assert.equal(ok.status, 200)
  assert.equal(upstream.hits[0].url, '/v1/chat/completions')
})

test('WS upgrade 的 GET /v1/responses 不得被当普通请求转发', { timeout: 30000 }, async (t) => {
  const upstream = await echoUpstream()
  const gw = await startIsolated({ name: 'e1-ws-upgrade', config: thirdPartyConfig(upstream) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  let errored = false
  let status = null
  try {
    const res = await rawRequest(gw.base, '/v1/responses', undefined, {
      upgrade: 'websocket', connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
      authorization: 'Bearer CLIENT-OFFICIAL-TOKEN', 'chatgpt-account-id': 'acct-CLIENT-ACCOUNT',
      'openai-beta': 'responses=experimental',
    }, 'GET')
    status = res.status
  } catch { errored = true }
  // E1 契约：404（Codex 收到 404 会回落 HTTPS）；index.js 收口前 405 也证明未被转发。
  assert.ok(errored || status === 404 || status === 405, '升级请求不得被当普通请求处理（实际 status=' + status + '）')
  assert.equal(upstream.hits.length, 0, '升级请求零上游命中')
})

test('重定向不跟随：302 不把请求/凭据送到 Location', { timeout: 30000 }, async (t) => {
  const target = await echoUpstream()
  const redirector = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(302, { location: target.base + '/v1/chat/completions' })
    res.end()
  })
  const gw = await startIsolated({ name: 'e1-redirect', config: thirdPartyConfig({ base: redirector.base }) })
  t.after(async () => { await gw.stop(); await redirector.stop(); await target.stop() })

  const res = await rawRequest(gw.base, '/v1/chat/completions', CHAT, OFFICIAL_REQUEST_HEADERS)
  assert.ok(res.status >= 400, '302 必须被视为上游错误（实际 ' + res.status + '）')
  assert.equal(target.hits.length, 0, '绝不跟随重定向')
  assert.equal(redirector.hits.length, 1, '只请求原始上游一次')
})
