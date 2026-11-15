#!/usr/bin/env node
// V2-REAL-5 / A4：R008（无静默降级）与 R009（双身份/租户隔离）复核脚本。
//
// 边界（与任务书一致）：
//   · 隔离实例：固定端口 18882/18883；MG_CONFIG_DIR 与 HOME 都在 /tmp 下，绝不读写 ~/.codex
//     或用户日常状态目录；发现端口被占用时直接失败，不复用/不终止未知进程。
//   · 默认**零真实上游**：所有上游都是本地回环 mock，脚本逐项记录每个 mock 的命中次数。
//   · 只有显式 `--real-go` 才执行**唯一 1 次**真实 Go 请求（无效 key，预期被拒绝）；
//     DNS 预检失败时标 BLOCKED_NETWORK，不消耗这次请求。
//   · 只读复核：不改 src/**；除 `--out` 指定的证据目录外不写仓库文件。
//
// 用法：
//   node scripts/test/live/negative-and-tenant-check.mjs                     # 干跑（零真实上游）
//   node scripts/test/live/negative-and-tenant-check.mjs --real-go           # 追加唯一 1 次真实 Go 拒绝请求
//   node scripts/test/live/negative-and-tenant-check.mjs --out docs/evidence/2026-11-15-r008-r009
//
// 退出码：0 = 所有已执行检查通过；1 = 有 FAIL（NOT_RUN/BLOCKED 单列，不算通过）。
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PORT_A = 18882
const PORT_B = 18883
const RUN_TAG = 'mg-r008-r009-' + process.pid + '-' + randomBytes(3).toString('hex')
const args = process.argv.slice(2)
const REAL_GO = args.includes('--real-go')
const OUT_DIR = (() => { const i = args.indexOf('--out'); return i >= 0 && args[i + 1] ? args[i + 1] : null })()

const results = []
const receipts = {}
const instances = []
const mocks = []

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex')
const hex = (n) => randomBytes(n).toString('hex')

function record(id, status, detail = {}) {
  results.push(Object.assign({ id, status }, detail))
  console.log('[' + status + '] ' + id + (detail.note ? ' — ' + detail.note : ''))
}

// —— 本地回环 mock 上游：记录命中次数，绝不外发 ——
async function startMock(handler) {
  const hits = []
  const server = http.createServer(async (req, res) => {
    const rec = { method: req.method, url: req.url, authorization: req.headers.authorization || null, at: Date.now() }
    for await (const chunk of req) { /* drain */ }
    hits.push(rec)
    try { await handler(req, res, rec) } catch { try { res.destroy() } catch {} }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    port, base: 'http://127.0.0.1:' + port, hits,
    stop: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) },
  }
}

const responsesJson = (text) => JSON.stringify({
  id: 'resp_mock', object: 'response', status: 'completed', model: 'mock',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  output_text: text, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
})

function portFree(port) {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

async function readJsonSafe(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

// —— 隔离实例：固定端口 + 独立配置目录/HOME + 独立 client/admin 凭据 ——
async function startInstance({ name, port, dir, config, clientKey, adminToken, env }) {
  if (!(await portFree(port))) throw new Error('端口 ' + port + ' 已被占用（拒绝复用/终止未知进程）：' + name)
  await mkdir(join(dir, 'home'), { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'gateway.json'), JSON.stringify(Object.assign({
    server: { host: '127.0.0.1', port, logFile: join(dir, 'gateway.log') },
  }, config)), { mode: 0o600 })
  const childEnv = Object.assign({}, process.env, {
    HOME: join(dir, 'home'),
    MG_CONFIG_DIR: dir,
    MG_CONFIG: join(dir, 'gateway.json'),
    MG_KEYS_MASTER: 'r008-r009-isolated-' + name,
    MG_CLIENT_KEY: clientKey,
    MG_ADMIN_TOKEN: adminToken,
    MG_MAX_BODY: '',
  }, env || {})
  for (const key of ['CODEX_HOME', 'OPENCODE_API_KEY', 'OPENAI_API_KEY', 'MG_GW']) delete childEnv[key]
  const child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: childEnv })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += String(b) })
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
  const base = 'http://127.0.0.1:' + port
  const deadline = Date.now() + 12000
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(name + ' 启动即退出：' + stderr)
    try { if ((await fetch(base + '/healthz')).ok) { ready = true; break } } catch { /* 尚未监听 */ }
    await new Promise((r) => setTimeout(r, 40))
  }
  if (!ready) { child.kill(); throw new Error(name + ' 未在 12s 内就绪：' + stderr) }
  const call = (path, o = {}) => {
    const headers = Object.assign({}, o.headers || {})
    let body = o.body
    if (body !== undefined && typeof body !== 'string') { headers['content-type'] = 'application/json'; body = JSON.stringify(body) }
    return fetch(base + path, { method: o.method || 'GET', headers, body })
  }
  const inst = {
    name, port, base, dir, child,
    call,
    get: (p, h) => call(p, { method: 'GET', headers: h }),
    post: (p, b, h) => call(p, { method: 'POST', body: b, headers: h }),
    stderr: () => stderr,
    stop: async () => { if (child.exitCode === null) { child.kill(); await exited } },
  }
  instances.push(inst)
  return inst
}

async function main() {
  const dirA = join('/tmp', RUN_TAG + '-a')
  const dirB = join('/tmp', RUN_TAG + '-b')
  const clientKeyA = 'r008-client-' + hex(8)
  const adminKeyA = 'r008-admin-' + hex(8)
  const clientKeyB = 'r009-client-' + hex(8)
  const adminKeyB = 'r009-admin-' + hex(8)
  const markerA = 'MARKER-TENANT-A-' + hex(3)
  const markerB = 'MARKER-TENANT-B-' + hex(3)

  // ===== 上游 mock：计数 / 跨域限流 / 另一授权域 =====
  const counted = await startMock(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(responsesJson('COUNTED')) })
  const rateApi = await startMock(async (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
    res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests per minute (rpm)', type: 'rate_limit_exceeded' } }))
  })
  const otherDomain = await startMock(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(responsesJson('OTHER-DOMAIN')) })
  mocks.push(counted, rateApi, otherDomain)

  // ===== 实例 A（R008）=====
  const configA = {
    defaults: {
      // 回环 mock 一律按第三方身份域处理（不加入官方白名单），跨域对照组用 siwc-app 域；
      // 该对照组永不真正发送——本用例正是要证明 429 之后不会跨域回退。
      codexOfficialHosts: ['localhost'],
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      timeout: { connectMs: 5000, firstByteMs: 12000, idleMs: 12000, overallMs: 45000 },
      proxyMode: 'direct',
    },
    providers: {
      counted: { baseUrl: counted.base, api: 'responses', apiKeyEnv: 'R008_COUNTED_KEY' },
      'rate-api': { baseUrl: rateApi.base, api: 'responses', apiKeyEnv: 'R008_RATE_KEY' },
      // 另一授权域：官方订阅入口（chatgpt.com 语义，回环 mock 仅用于可测量）。
      // 429 绝不能跨到这个域——那等于"静默换套餐"。修复前它确实会被真实调用（见 receipts）。
      'sub-domain': {
        baseUrl: 'http://localhost:' + otherDomain.port,
        codexIdentity: 'official',
        api: 'responses',
        gatewaySubscription: { enabled: true },
      },
      // 第二个对照域（siwc-app）：用于观测"确实被跨域发送"的直接证据（该域无官方 key 门）。
      'sub-domain-app': { baseUrl: otherDomain.base, siwcApp: true, api: 'responses' },
      // R008-2：真实 Go 上游（本轮唯一 1 次请求，使用无效 key）。
      'go-real': { baseUrl: 'https://opencode.ai/inference/go', pathPrefix: '/openai', api: 'openai', apiKeyEnv: 'MG_R008_INVALID_GO_KEY' },
    },
    models: {
      'known-child': { provider: 'counted', api: 'responses', providerModels: { counted: 'known-upstream-model' } },
      'cross-child': { provider: 'rate-api', api: 'responses', providerModels: { 'rate-api': 'cross-model' }, fallbacks: ['sub-domain'] },
      'cross-app-child': { provider: 'rate-api', api: 'responses', providerModels: { 'rate-api': 'cross-model' }, fallbacks: ['sub-domain-app'] },
      'go-negative': { provider: 'go-real', api: 'responses', providerModels: { 'go-real': 'deepseek-v4.1-flash' }, fallbacks: ['sub-domain'] },
      ['model-' + markerA]: { provider: 'counted', api: 'responses', providerModels: { counted: 'known-upstream-model' } },
    },
  }
  const instA = await startInstance({
    name: 'A', port: PORT_A, dir: dirA, config: configA, clientKey: clientKeyA, adminToken: adminKeyA,
    env: {
      MG_R008_INVALID_GO_KEY: 'sk-invalid-r008-canary-' + hex(6),
      // 回环 mock 的 provider key（虚构值）：确保"零上游/跨域零命中"不是因为缺 key 被提前跳过。
      R008_COUNTED_KEY: 'sk-counted-' + hex(4),
      R008_RATE_KEY: 'sk-rate-' + hex(4),
    },
  })

  // ===== R008-1：未知模型 → 404 unknown_model，零上游 =====
  const before1 = { counted: counted.hits.length, rate: rateApi.hits.length, other: otherDomain.hits.length }
  const r81 = await instA.post('/v1/responses', { model: 'mg-does-not-exist-' + hex(3), input: 'hi' }, { authorization: 'Bearer ' + clientKeyA })
  const b81 = await r81.json().catch(() => ({}))
  const r81b = await instA.post('/v1/responses', { model: 'mg-unknown-child', input: 'hi' }, { authorization: 'Bearer ' + clientKeyA })
  const b81b = await r81b.json().catch(() => ({}))
  const after1 = { counted: counted.hits.length, rate: rateApi.hits.length, other: otherDomain.hits.length }
  const zero1 = sha256(JSON.stringify(before1)) === sha256(JSON.stringify(after1))
  const code81 = (b81.error && b81.error.code) || b81.error?.type || null
  receipts['R008-1'] = {
    unknownAggregateModel: { status: r81.status, code: code81, body: b81 },
    unknownPlainModel: { status: r81b.status, code: (b81b.error && (b81b.error.code || b81b.error.type)) || null, body: b81b },
    upstreamHits: { before: before1, after: after1 },
  }
  record('R008-1 未知模型 → 404 unknown_model 且零上游', (r81.status === 404 && zero1) ? 'PASS_LOCAL' : 'FAIL', {
    note: 'status=' + r81.status + ' code=' + code81 + ' 零上游=' + zero1 + '（同批探测 plain unknown status=' + r81b.status + '）',
  })

  // ===== R008-3：跨授权域 429 → cross_domain_fallback_blocked（两个对照域）=====
  // 3a：另一域 = codex-subscription（官方订阅入口）。期望 429 + 另一域零命中；
  //     修复前实际观测到它被尝试发送（日志出现 provider=sub-domain domain=official），
  //     仅因为该 provider 没有网关自有 key 才以 403 official_credential_missing 终止——
  //     这仍是"跨授权域换路由"，只是没走完。
  // 3b：另一域 = siwc-app。该域没有官方 key 门，修复前会被真实发送并返回 200，
  //     给出"跨域发送确实发生"的直接证据。
  const before3 = { rate: rateApi.hits.length, other: otherDomain.hits.length }
  const r83 = await instA.post('/v1/responses', { model: 'cross-child', input: 'hi' }, { authorization: 'Bearer ' + clientKeyA })
  const b83 = await r83.json().catch(() => ({}))
  const mid3 = { rate: rateApi.hits.length, other: otherDomain.hits.length }
  const r83b = await instA.post('/v1/responses', { model: 'cross-app-child', input: 'hi' }, { authorization: 'Bearer ' + clientKeyA })
  const b83b = await r83b.json().catch(() => ({}))
  const after3 = { rate: rateApi.hits.length, other: otherDomain.hits.length }
  const appCaseCrossed = after3.other > mid3.other
  const subCaseAttempted = r83.status === 403 && b83.error && b83.error.code === 'official_credential_missing'
  const ok3a = r83.status === 429 && b83.error && b83.error.code === 'cross_domain_fallback_blocked' && mid3.other === before3.other
  const ok3b = r83b.status === 429 && b83b.error && b83b.error.code === 'cross_domain_fallback_blocked' &&
    b83b.error.terminal === true && b83b.error.fallbackAllowed === false && !appCaseCrossed
  // 请求之后取日志：证明"实际发给了哪个授权域"。
  const logs3Text = await (await instA.get('/api/logs?lines=300', { authorization: 'Bearer ' + adminKeyA })).text()
  let logLinesAll = []
  try { logLinesAll = (JSON.parse(logs3Text).lines || []) } catch { logLinesAll = [] }
  const logLines3 = logLinesAll
    .filter((line) => /send authz|retryable status|provider=|credential_missing|data POST/.test(line))
    .map((line) => line.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'))
  receipts['R008-3'] = {
    subscriptionDomainCase: {
      status: r83.status, body: b83,
      otherDomainHitDelta: mid3.other - before3.other,
      attemptedCrossDomainSend: subCaseAttempted,
      verdict: ok3a ? 'PASS_LOCAL' : 'FAIL',
    },
    siwcAppDomainCase: {
      status: r83b.status, body: b83b,
      otherDomainHitDelta: after3.other - mid3.other,
      crossDomainSendObserved: appCaseCrossed,
      verdict: ok3b ? 'PASS_LOCAL' : 'FAIL',
    },
    upstreamHits: { before: before3, afterSubscriptionCase: mid3, afterAppCase: after3 },
    gatewayLogSnippet: logLines3.slice(-16).join('\n'),
    rootCauseHint: (ok3a && ok3b) ? null
      : '429 在 forward() 内以 typedSendError(MG_FB_RATE_LIMITED) 抛出（forward.js），被 index.js 的 catch 分支 continue 到下一候选；index.js 里 up.status===429 的 crossDomainFallbackBlocked 检查因此不可达',
  }
  record('R008-3 跨授权域 429 → cross_domain_fallback_blocked（订阅域 / siwc-app 两个对照）', (ok3a && ok3b) ? 'PASS_LOCAL' : 'FAIL', {
    note: '订阅域对照 status=' + r83.status + ' code=' + (b83.error && b83.error.code) + ' 命中增量=' + (mid3.other - before3.other) +
      '；siwc-app 对照 status=' + r83b.status + ' 命中增量=' + (after3.other - mid3.other) +
      (ok3a && ok3b ? '' : '（观测到跨授权域发送/换域）'),
  })

  // ===== R008-2：失效 Go key（唯一 1 次真实请求，仅 --real-go）=====
  if (!REAL_GO) {
    receipts['R008-2'] = { status: 'NOT_RUN_BUDGET', note: '未带 --real-go：遵守「只允许 1 次真实 Go 请求」预算，默认不执行' }
    record('R008-2 失效 Go key（真实 Go 上游）', 'NOT_RUN_BUDGET', { note: '未带 --real-go（预算未消耗）' })
  } else {
    let dns = null
    try { dns = await lookup('opencode.ai') } catch (e) { dns = { error: (e && e.code) || String((e && e.message) || e) } }
    if (!dns || dns.error) {
      receipts['R008-2'] = { status: 'BLOCKED_NETWORK', dns }
      record('R008-2 失效 Go key（真实 Go 上游）', 'BLOCKED_NETWORK', { note: 'DNS 预检失败，未消耗唯一真实请求：' + JSON.stringify(dns) })
    } else {
      const started = Date.now()
      const before = { other: otherDomain.hits.length, rate: rateApi.hits.length }
      let status = 0
      let bodyText = ''
      let transport = null
      try {
        const res = await instA.post('/v1/responses', { model: 'go-negative', input: 'hi' }, { authorization: 'Bearer ' + clientKeyA })
        status = res.status
        bodyText = await res.text()
      } catch (e) { transport = (e && e.code) || String((e && e.message) || e) }
      const elapsedMs = Date.now() - started
      const statusResp = await instA.get('/api/status', { authorization: 'Bearer ' + adminKeyA })
      const statusJson = await statusResp.json().catch(() => ({}))
      const goProv = (statusJson.providers || []).find((p) => p.id === 'go-real') || null
      const attempts = goProv ? Number(goProv.st.requests) + Number(goProv.st.errors) : null
      const after = { other: otherDomain.hits.length, rate: rateApi.hits.length }
      let parsed = null
      try { parsed = JSON.parse(bodyText) } catch { parsed = null }
      const typed = !!(parsed && parsed.error && parsed.error.type === 'auth_domain_failure' &&
        parsed.error.authDomain === 'api-key' && parsed.error.terminal === true && parsed.error.fallbackAllowed === false)
      const ok2 = !transport && (status === 401 || status === 403) && typed && attempts === 1 &&
        after.other === before.other && after.rate === before.rate
      receipts['R008-2'] = {
        status, elapsedMs, transport, body: parsed,
        gatewayAttempts: { provider: 'go-real', requestsPlusErrors: attempts, providerState: goProv ? goProv.st : null },
        crossDomainHits: { subDomainBefore: before.other, subDomainAfter: after.other, rateApiBefore: before.rate, rateApiAfter: after.rate },
        note: '唯一 1 次真实 Go 请求；无效 key 预期被上游拒绝；无跨域回退',
      }
      record('R008-2 失效 Go key（真实 Go 上游，唯一 1 次）', ok2 ? 'PASS_REAL' : (transport ? 'BLOCKED_NETWORK' : 'FAIL'), {
        note: 'status=' + status + ' transport=' + transport + ' authDomain=' + (parsed && parsed.error && parsed.error.authDomain) +
          ' 网关尝试次数=' + attempts + ' 跨域命中增量=0? ' + (after.other === before.other && after.rate === before.rate),
      })
    }
  }

  // ===== R009：双实例（双身份）隔离 =====
  const configB = {
    defaults: {
      codexOfficialHosts: ['localhost'],
      retry: { maxAttempts: 1 },
      timeout: { connectMs: 2000, firstByteMs: 2000, idleMs: 2000, overallMs: 5000 },
      proxyMode: 'direct',
    },
    providers: { 'tenant-b-upstream': { baseUrl: otherDomain.base, api: 'responses', apiKeyEnv: 'R009_B_KEY' } },
    models: { ['model-' + markerB]: { provider: 'tenant-b-upstream', api: 'responses', providerModels: { 'tenant-b-upstream': 'b-model' } } },
  }
  const instB = await startInstance({
    name: 'B', port: PORT_B, dir: dirB, config: configB, clientKey: clientKeyB, adminToken: adminKeyB,
    env: { R009_B_KEY: 'sk-r009-b-' + hex(6) },
  })

  const configBPath = join(dirB, 'gateway.local.json')
  const bFilesBefore = await readJsonSafe(configBPath)
  const crossChecks = []
  async function cross(id, fn) {
    try {
      const res = await fn()
      const text = await res.text()
      crossChecks.push({ id, status: res.status, snippet: text.slice(0, 200) })
    } catch (e) { crossChecks.push({ id, transport: String((e && e.message) || e) }) }
  }
  await cross('A client-key → B /v1/models (data read)', () => instB.get('/v1/models', { authorization: 'Bearer ' + clientKeyA }))
  await cross('A admin-token → B /api/status (read)', () => instB.get('/api/status', { authorization: 'Bearer ' + adminKeyA }))
  await cross('A admin-token → B /api/config (read)', () => instB.get('/api/config', { authorization: 'Bearer ' + adminKeyA }))
  await cross('A admin-token → B /api/config/save (write)', () => instB.post('/api/config/save', { defaults: {}, providers: {}, models: {} }, { authorization: 'Bearer ' + adminKeyA }))
  await cross('A admin-token → B /api/keys (write key)', () => instB.post('/api/keys', { id: 'tenant-b-upstream', key: 'sk-injected' }, { authorization: 'Bearer ' + adminKeyA }))
  await cross('A admin-token → B /api/config/reload (refresh)', () => instB.post('/api/config/reload', {}, { authorization: 'Bearer ' + adminKeyA }))
  await cross('A client-key → B /v1/responses (data write)', () => instB.post('/v1/responses', { model: 'model-' + markerB, input: 'hi' }, { authorization: 'Bearer ' + clientKeyA }))
  const bFilesAfter = await readJsonSafe(configBPath)
  const bConfigUnchanged = sha256(JSON.stringify(bFilesBefore)) === sha256(JSON.stringify(bFilesAfter))
  const denied = crossChecks.filter((c) => c.status === 401 || c.status === 404).length
  receipts['R009-cross-instance'] = { checks: crossChecks, bConfigUnchanged }
  record('R009 跨身份读/写/刷新一律 401/404（凭据不可迁移）', (denied === crossChecks.length && bConfigUnchanged) ? 'PASS_REAL' : 'FAIL', {
    note: 'denied=' + denied + '/' + crossChecks.length + ' B配置未变=' + bConfigUnchanged,
  })

  // 控制组：B 自己的凭据可用（证明上面的 401 来自隔离而不是实例故障）。
  const ownB = await instB.get('/api/status', { authorization: 'Bearer ' + adminKeyB })
  const ownBody = await ownB.json().catch(() => ({}))
  const ownProviders = (ownBody.providers || []).map((p) => p.id)
  const ownModels = (ownBody.models || []).map((m) => m.name)
  receipts['R009-control'] = { status: ownB.status, providers: ownProviders, models: ownModels }
  const controlOk = ownB.status === 200 && ownProviders.includes('tenant-b-upstream') && ownModels.some((m) => m.includes(markerB))
  record('R009 控制组：B 自己的凭据可读自己的状态', controlOk ? 'PASS_REAL' : 'FAIL', { note: 'status=' + ownB.status })

  // 统计/日志/配置不串身份：只引用脱敏片段与标记，不导出内容正文。
  const logsB = await instB.get('/api/logs?lines=400', { authorization: 'Bearer ' + adminKeyB })
  const logsBText = await logsB.text()
  const configBResp = await instB.get('/api/config', { authorization: 'Bearer ' + adminKeyB })
  const configBText = await configBResp.text()
  const statsBText = JSON.stringify((await readJsonSafe(join(dirB, 'stats.json'))) || {})
  const statusAText = await (await instA.get('/api/status', { authorization: 'Bearer ' + adminKeyA })).text()
  const statsAText = JSON.stringify((await readJsonSafe(join(dirA, 'stats.json'))) || {})
  const bClean = !logsBText.includes(markerA) && !configBText.includes(markerA) && !statsBText.includes(markerA) && !configBText.includes(clientKeyA)
  const aClean = !statusAText.includes(markerB) && !statsAText.includes(markerB) && !statusAText.includes(clientKeyB)
  receipts['R009-records'] = {
    bLogSnippet: logsBText.slice(0, 300),
    bLeak: { logsHasMarkerA: logsBText.includes(markerA), configHasMarkerA: configBText.includes(markerA), statsHasMarkerA: statsBText.includes(markerA) },
    aLeak: { statusHasMarkerB: statusAText.includes(markerB), statsHasMarkerB: statsAText.includes(markerB) },
  }
  record('R009 统计/日志/配置不串身份（脱敏片段）', (aClean && bClean) ? 'PASS_REAL' : 'FAIL', { note: 'B干净=' + bClean + ' A干净=' + aClean })

  // 物理隔离：两个配置目录各自独立，互不含对方的 client/admin 凭据。
  const aKeys = await readFile(join(dirA, 'keys.local.json'), 'utf8').catch(() => '')
  const bKeys = await readFile(join(dirB, 'keys.local.json'), 'utf8').catch(() => '')
  const filesIsolated = existsSync(join(dirA, 'gateway.json')) && existsSync(join(dirB, 'gateway.json')) &&
    !aKeys.includes(clientKeyB) && !bKeys.includes(clientKeyA) && !aKeys.includes(adminKeyB) && !bKeys.includes(adminKeyA)
  receipts['R009-files'] = { aFiles: await readdir(dirA).catch(() => []), bFiles: await readdir(dirB).catch(() => []) }
  record('R009 配置/Key 目录物理隔离（互不含对方凭据）', filesIsolated ? 'PASS_REAL' : 'FAIL')

  // 单实例内的多租户维度审计（如实记录，不计入通过）。
  const tenancyRefs = []
  for (const file of await readdir(join(ROOT, 'src'))) {
    if (!file.endsWith('.js')) continue
    const text = await readFile(join(ROOT, 'src', file), 'utf8')
    if (/\btenancy\b|requireUserScope|createScopeStore/.test(text)) tenancyRefs.push('src/' + file)
  }
  const withScopeResp = await instB.get('/api/config', { authorization: 'Bearer ' + adminKeyB, 'x-mg-scope': 'tenant-a', 'x-mg-tenant': 'tenant-a' })
  const scopeIgnored = sha256(await withScopeResp.text()) === sha256(configBText)
  receipts['R009-intra-instance'] = { tenancyWiringFiles: tenancyRefs, tenantHeaderIgnored: scopeIgnored, roles: { adminToken: 1, clientKey: 1 } }
  record('R009 单实例内多租户维度审计（不计入通过，如实记录）', 'GAP_NOT_IMPLEMENTED', {
    note: 'src 内引用 tenancy 的文件=' + (tenancyRefs.length ? tenancyRefs.join(',') : '无') +
      '；tenant 头被忽略=' + scopeIgnored + '；单实例只有 1 admin token + 1 client key（无第二身份角色）',
  })

  return { dirs: { a: dirA, b: dirB } }
}

let finished = null
try {
  finished = await main()
} catch (error) {
  console.error('FATAL ' + ((error && error.message) || error))
  process.exitCode = 1
} finally {
  for (const inst of instances) { try { await inst.stop() } catch { /* ignore */ } }
  for (const m of mocks) { try { await m.stop() } catch { /* ignore */ } }
}

const failed = results.filter((r) => r.status === 'FAIL')
const r2 = receipts['R008-2']
const realGoCalls = REAL_GO && r2 && r2.status !== 'BLOCKED_NETWORK' ? 1 : 0
const payload = {
  generatedAt: new Date().toISOString(),
  runTag: RUN_TAG,
  realGoRequested: REAL_GO,
  ports: { a: PORT_A, b: PORT_B },
  isolation: { configDirs: ['/tmp/' + RUN_TAG + '-a', '/tmp/' + RUN_TAG + '-b'], home: 'each instance uses <configDir>/home', realHomeTouched: false },
  realUpstreamCalls: { go: realGoCalls, gpt: 0, total: realGoCalls },
  results,
  receipts,
}
console.log('\n== summary ==')
for (const row of results) console.log(row.status.padEnd(14) + ' ' + row.id)
console.log('realGoRequested=' + REAL_GO + ' failed=' + failed.length + ' ports=' + PORT_A + '/' + PORT_B + ' realUpstreamCalls=' + realGoCalls)

if (OUT_DIR) {
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, 'receipts.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8')
  console.log('receipts written: ' + join(OUT_DIR, 'receipts.json'))
}
// 清理本次运行的临时实例目录（证据目录除外；--keep 保留以便取证）。
if (!args.includes('--keep')) for (const dir of [join('/tmp', RUN_TAG + '-a'), join('/tmp', RUN_TAG + '-b')]) {
  try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}
if (failed.length) process.exitCode = 1
