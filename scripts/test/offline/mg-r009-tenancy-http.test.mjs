// MG-R009：真实 HTTP 进程内 fixture（两个身份、一个共享 server、两个隔离运行时）。
// 只使用回环 mock 与合成 Key；不读生产配置、不触 8787、不调用真实上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../../../src/index.js'
import { keysEncrypt } from '../../../src/router.js'

const ALPHA_KEY = 'sk-alpha-fixture-secret-0001'
const BETA_KEY = 'sk-beta-fixture-secret-0002'

async function reservePort() {
  const server = http.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
}

async function startUpstream() {
  const hits = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const alpha = String(req.url).startsWith('/alpha/')
    hits.push({ url: req.url, headers: req.headers, authorization: req.headers.authorization, model: body.model })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: alpha ? 'chat-alpha' : 'chat-beta', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: alpha ? 'alpha-ok' : 'beta-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: alpha ? 2 : 4, total_tokens: alpha ? 5 : 7 },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: 'http://127.0.0.1:' + server.address().port, hits, stop: async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) } }
}

function actorResolver(req) {
  const auth = String((req.headers && req.headers.authorization) || '')
  if (auth === 'Bearer actor-alpha') return { id: 'alice', scopeId: 'alpha', role: 'user' }
  if (auth === 'Bearer actor-beta') return { id: 'bob', scopeId: 'beta', role: 'user' }
  if (auth === 'Bearer actor-beta-admin') return { id: 'bob-admin', scopeId: 'beta', role: 'admin' }
  if (auth === 'Bearer actor-admin') return { id: 'root-fixture', scopeId: 'alpha', role: 'admin' }
  if (auth === 'Bearer actor-unknown') return { id: 'mallory', scopeId: 'gamma', role: 'user' }
  return null
}

async function call(gateway, path, { actor = 'actor-alpha', scope, method = 'GET', body } = {}) {
  const headers = { connection: 'close' }
  if (actor) headers.authorization = 'Bearer ' + actor
  if (scope) headers['x-scope'] = scope
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try { response = await fetch(gateway.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }) } catch (error) {
    error.message = path + ': ' + error.message
    throw error
  }
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, text, json }
}

test('MG-R009 单实例双身份：配置/Key/目录/统计/日志/额度隔离，重启持久化', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mg-r009-http-'))
  const upstream = await startUpstream()
  let gateway = null
  const priorMaster = process.env.MG_KEYS_MASTER
  const priorMaxBody = process.env.MG_MAX_BODY
  process.env.MG_KEYS_MASTER = 'isolated-tenancy-fixture-master'
  process.env.MG_MAX_BODY = ''
  t.after(async () => {
    if (gateway) await gateway.close()
    if (priorMaster === undefined) delete process.env.MG_KEYS_MASTER; else process.env.MG_KEYS_MASTER = priorMaster
    if (priorMaxBody === undefined) delete process.env.MG_MAX_BODY; else process.env.MG_MAX_BODY = priorMaxBody
    await upstream.stop()
    await rm(root, { recursive: true, force: true })
  })

  const port = await reservePort()
  const rootFile = join(root, 'gateway.json')
  const rootPaths = { dir: root, local: join(root, 'gateway.local.json'), keys: join(root, 'keys.local.json'), stats: join(root, 'stats.json'), videos: join(root, 'videos.json') }
  await writeJson(rootFile, {
    server: { host: '127.0.0.1', port, maxBodyBytes: 64 * 1024, logFile: join(root, 'control.log') },
    tenancy: { mode: 'multi', scopes: ['alpha', 'beta'], root: 'tenants' },
  })
  const tenantConfig = (scope, providerId, modelId, quota) => ({
    providers: { [providerId]: { baseUrl: upstream.base + '/' + scope, api: 'openai', allowPrivateNetwork: true } },
    models: { [modelId]: { provider: providerId, quota } },
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000 }, proxyMode: 'direct' },
    virtualModels: [],
  })
  await writeJson(join(root, 'tenants/alpha/config/gateway.json'), tenantConfig('alpha', 'alpha-provider', 'alpha-only', 5))
  await writeJson(join(root, 'tenants/beta/config/gateway.json'), tenantConfig('beta', 'beta-provider', 'beta-only', 100))
  await writeFile(join(root, 'tenants/alpha/config/keys.local.json'), keysEncrypt({ 'alpha-provider': ALPHA_KEY }), { mode: 0o600 })
  await writeFile(join(root, 'tenants/beta/config/keys.local.json'), keysEncrypt({ 'beta-provider': BETA_KEY }), { mode: 0o600 })

  gateway = await start({ paths: rootPaths, configFile: rootFile, resolveActor: actorResolver, silent: true, rejectBindFailure: true })
  const base = 'http://127.0.0.1:' + gateway.server.address().port
  gateway.base = base

  // 启动不创建任何租户日志/统计；只有已认证请求才懒初始化对应 scope。
  assert.equal(await exists(join(root, 'tenants/alpha/logs/events.jsonl')), false)
  assert.equal(await exists(join(root, 'tenants/beta/logs/events.jsonl')), false)
  assert.equal(await exists(join(root, 'tenants/alpha/usage/stats.json')), false)
  assert.equal(await exists(join(root, 'tenants/beta/usage/stats.json')), false)

  assert.equal((await call(gateway, '/healthz', { actor: null })).status, 401)
  assert.equal((await call(gateway, '/healthz', { actor: 'actor-unknown' })).status, 403)
  assert.equal((await call(gateway, '/api/status', { actor: null, scope: 'alpha' })).status, 401, 'x-scope 不能替代身份')
  assert.equal((await call(gateway, '/api/tenancy/scopes', { actor: 'actor-alpha' })).status, 403, '普通身份不能列根 scopes')
  const adminScopes = await call(gateway, '/api/tenancy/scopes', { actor: 'actor-admin' })
  assert.equal(adminScopes.status, 200)
  assert.deepEqual(adminScopes.json.scopes, ['alpha', 'beta'])
  assert.equal(JSON.stringify(adminScopes.json).includes(ALPHA_KEY), false)

  const alphaStatus = await call(gateway, '/api/status', { actor: 'actor-alpha', scope: 'beta' })
  assert.equal(alphaStatus.status, 200, '任意 x-scope 必须被忽略')
  assert.equal(alphaStatus.json.tenancy.scopeId, 'alpha')
  assert.deepEqual(alphaStatus.json.models.map((m) => m.name), ['alpha-only'])
  assert.deepEqual(alphaStatus.json.providers.map((p) => p.id), ['alpha-provider'])
  const betaStatus = await call(gateway, '/api/status', { actor: 'actor-beta', scope: 'alpha' })
  assert.equal(betaStatus.json.tenancy.scopeId, 'beta')
  assert.deepEqual(betaStatus.json.models.map((m) => m.name), ['beta-only'])

  assert.equal((await call(gateway, '/api/config', { actor: 'actor-alpha' })).status, 403)
  assert.equal((await call(gateway, '/api/config/backups', { actor: 'actor-beta' })).status, 403)
  assert.equal((await call(gateway, '/api/keys', { actor: 'actor-alpha', method: 'POST', body: { id: 'alpha-provider', key: 'forbidden' } })).status, 403)
  assert.equal((await call(gateway, '/api/config', { actor: 'actor-admin' })).status, 200)

  assert.equal((await call(gateway, '/api/services/beta-provider', { actor: 'actor-alpha' })).status, 404)
  assert.equal((await call(gateway, '/api/services/alpha-provider', { actor: 'actor-beta' })).status, 404)
  assert.equal((await call(gateway, '/v1/models', { actor: 'actor-alpha' })).json.data.some((m) => m.id === 'beta-only'), false)
  assert.equal((await call(gateway, '/v1/models', { actor: 'actor-beta' })).json.data.some((m) => m.id === 'alpha-only'), false)

  const chat = (actor, model) => call(gateway, '/v1/chat/completions', { actor, method: 'POST', body: { model, messages: [{ role: 'user', content: 'fixture' }] } })
  const alphaChat = await chat('actor-alpha', 'alpha-only')
  assert.equal(alphaChat.status, 200)
  assert.equal(alphaChat.json.choices[0].message.content, 'alpha-ok')
  const betaChat = await chat('actor-beta', 'beta-only')
  assert.equal(betaChat.status, 200)
  assert.equal(betaChat.json.choices[0].message.content, 'beta-ok')
  assert.equal((await chat('actor-alpha', 'beta-only')).status, 404)
  assert.equal((await chat('actor-beta', 'alpha-only')).status, 404)
  assert.equal(upstream.hits.length, 2, '跨 scope 未知模型零上游')
  assert.equal(upstream.hits[0].authorization, 'Bearer ' + ALPHA_KEY)
  assert.equal(upstream.hits[1].authorization, 'Bearer ' + BETA_KEY)
  assert.equal(upstream.hits.some((hit) => String(hit.authorization).includes('actor-')), false, '身份令牌不外发')
  assert.equal(upstream.hits.some((hit) => hit.headers['x-scope'] !== undefined || hit.headers['x-mg-test-actor'] !== undefined), false)

  // alpha quota=5，首个 5 token 后第二个请求必须 429；beta 的 100 token 额度不受影响。
  assert.equal((await call(gateway, '/api/status', { actor: 'actor-alpha' })).json.models.find((m) => m.name === 'alpha-only').tokens, 5)
  const alphaQuotaRetry = await chat('actor-alpha', 'alpha-only')
  assert.equal(alphaQuotaRetry.status, 429)
  assert.equal((await chat('actor-beta', 'beta-only')).status, 200)
  assert.equal(upstream.hits.length, 3)

  const alphaAfter = await call(gateway, '/api/status', { actor: 'actor-alpha' })
  const betaAfter = await call(gateway, '/api/status', { actor: 'actor-beta' })
  assert.equal(alphaAfter.json.models.find((m) => m.name === 'alpha-only').tokens, 5)
  assert.equal(betaAfter.json.models.find((m) => m.name === 'beta-only').tokens, 14)
  assert.notEqual(alphaAfter.json.global.tokenCount, betaAfter.json.global.tokenCount)
  assert.ok(alphaAfter.json.global.tokenCount > 0)
  assert.ok(betaAfter.json.global.tokenCount > 0)

  const alphaLogs = await call(gateway, '/api/logs', { actor: 'actor-admin' })
  const betaLogs = await call(gateway, '/api/logs', { actor: 'actor-beta-admin' })
  assert.equal(alphaLogs.status, 200)
  assert.equal(alphaLogs.json.lines.some((line) => line.includes('alpha-only')), true)
  assert.equal(alphaLogs.json.lines.some((line) => line.includes('beta-only')), false)
  assert.equal(betaLogs.json.lines.some((line) => line.includes('beta-only')), true)
  assert.equal(betaLogs.json.lines.some((line) => line.includes('alpha-only')), false)
  assert.equal(JSON.stringify(alphaLogs.json).includes(ALPHA_KEY), false)
  assert.equal(JSON.stringify(betaLogs.json).includes(BETA_KEY), false)
  const alphaEvents = await call(gateway, '/api/observability/events', { actor: 'actor-admin' })
  const betaEvents = await call(gateway, '/api/observability/events', { actor: 'actor-beta-admin' })
  assert.equal(alphaEvents.json.items.some((event) => event.model === 'beta-only'), false)
  assert.equal(betaEvents.json.items.some((event) => event.model === 'alpha-only'), false)
  const alphaStorePath = join(root, 'tenants/alpha/config/observability/events.jsonl')
  const betaStorePath = join(root, 'tenants/beta/config/observability/events.jsonl')
  assert.equal(await exists(alphaStorePath), true)
  assert.equal(await exists(betaStorePath), true)
  assert.equal(await exists(join(root, 'observability/events.jsonl')), false, '根宿主不得存放租户事件')
  const alphaStoreText = await readFile(alphaStorePath, 'utf8')
  const betaStoreText = await readFile(betaStorePath, 'utf8')
  assert.equal(alphaStoreText.includes(ALPHA_KEY), false)
  assert.equal(betaStoreText.includes(BETA_KEY), false)
  assert.notEqual(alphaStoreText, betaStoreText)

  const alphaUsage = await call(gateway, '/api/tenancy', { actor: 'actor-alpha' })
  assert.equal(alphaUsage.json.scopeId, 'alpha')
  assert.equal(alphaUsage.json.usage.requests, 3, '两次 alpha 推理请求加一次跨 scope 404 均计入逻辑请求')
  assert.equal(alphaUsage.json.usage.tokens, 5)
  assert.equal(alphaUsage.json.usage.errors, 2, '额度拒绝与跨 scope 404 均为失败请求')

  // 宿主级管理路径 fail-closed，绝不使用共享 Codex/Harness 根。
  assert.equal((await call(gateway, '/api/codex/policy', { actor: 'actor-alpha' })).status, 403)
  assert.equal((await call(gateway, '/api/aggregation/health', { actor: 'actor-alpha' })).status, 403)
  assert.equal((await call(gateway, '/api/harnesses', { actor: 'actor-alpha' })).status, 403)

  await gateway.close()
  gateway = await start({ paths: rootPaths, configFile: rootFile, resolveActor: actorResolver, silent: true, rejectBindFailure: true })
  gateway.base = 'http://127.0.0.1:' + gateway.server.address().port
  const restartedAlpha = await call(gateway, '/api/status', { actor: 'actor-alpha' })
  const restartedBeta = await call(gateway, '/api/status', { actor: 'actor-beta' })
  assert.equal(restartedAlpha.json.models.find((m) => m.name === 'alpha-only').tokens, 5)
  assert.equal(restartedBeta.json.models.find((m) => m.name === 'beta-only').tokens, 14)
  assert.equal(restartedAlpha.json.providers.find((p) => p.id === 'alpha-provider').hasKey, true)
  assert.equal(restartedBeta.json.providers.find((p) => p.id === 'beta-provider').hasKey, true)
  assert.equal((await call(gateway, '/api/logs', { actor: 'actor-admin' })).json.lines.some((line) => line.includes('alpha-only')), true)
  assert.equal((await call(gateway, '/api/logs', { actor: 'actor-beta-admin' })).json.lines.some((line) => line.includes('alpha-only')), false)

  const rootText = await readFile(rootFile, 'utf8')
  assert.equal(rootText.includes(ALPHA_KEY), false)
  assert.equal(rootText.includes(BETA_KEY), false)
  const alphaKeysText = await readFile(join(root, 'tenants/alpha/config/keys.local.json'), 'utf8')
  const betaKeysText = await readFile(join(root, 'tenants/beta/config/keys.local.json'), 'utf8')
  assert.equal(alphaKeysText.includes(ALPHA_KEY), false)
  assert.equal(betaKeysText.includes(BETA_KEY), false)
  assert.notEqual(alphaKeysText, betaKeysText)
})
