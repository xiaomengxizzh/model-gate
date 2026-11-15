// A5 / UX-06：独立黑箱验收（隔离网关；本地 mock/隔离配置；零真实模型请求）。
//
// 目的：不是复述 A1–A4 的单测，而是从**用户任务**出发，在隔离网关上验证真实 HTTP 行为，
// 并把无法离线证明的部分如实标成 BLOCKED / NOT_TESTED（绝不用 mock 冒充 PASS_REAL）。
//
// 真实边界（本轮）：
//   * 不发起任何真实 Go/GPT 请求；没有付费调用授权 → UI-04/UI-16 的真实推理部分一律 BLOCKED。
//   * A1/A2/A3/A4 尚未集成到本分支（基线 e1beb85）时，相关结构断言走 t.skip() 并写真实证据，
//     不假装通过；集成后同一文件会自动转为真实断言。
//   * 所有 Key 都是虚构值；断言里同时检查响应"不含"这些值。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, root } from './harness.mjs'
import * as product from '../../../src/ui-next/js/product-status.js'
import { state as uiState, setProductPhase, productStatus, invalidateProductStatus } from '../../../src/ui-next/js/store.js'

const ADMIN = 'a5-acceptance-admin-token'
const AUTH = { authorization: 'Bearer ' + ADMIN }
const UI_DIR = join(root, 'src/ui-next')

// 已发布公共 ID = mg-opencodego-deepseek-v4-1-flash（stableModelId）；
// 历史/协议里也出现过 opencodego/deepseek-v4.1-flash 与上游名 deepseek-v4.1-flash。
const TARGET_ID_KEYS = new Set(['mgopencodegodeepseekv41flash', 'opencodegodeepseekv41flash', 'deepseekv41flash'])
function idKey (v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '') }
function isTargetId (v) { return TARGET_ID_KEYS.has(idKey(v)) }

async function isolatedCodexHome (authJson) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-a5-codex-'))
  if (authJson) await writeFile(join(dir, 'auth.json'), JSON.stringify(authJson))
  return dir
}

function b64url (obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url') }

function walkAssets (dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) out.push(...walkAssets(join(dir, entry.name), rel))
    else if (/\.(html|css|js|svg|png|json)$/i.test(entry.name)) out.push('/ui-next/' + rel)
  }
  return out.sort()
}

// —— UI-01 / UI-11：静态资产、CSP、未授权 401、旧实例 404 语义 ——
test('UI-01/UI-11: /ui-next 全资产 200 + CSP + 未授权 401 + 聚合 403/404 语义', { timeout: 40000 }, async (t) => {
  const codexHome = await isolatedCodexHome(null)
  const gw = await startGateway({ name: 'a5-ui0111', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: codexHome } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })

  // 1) 全部真实资产（按磁盘枚举，A1–A4 新增文件自动纳入，不维护第二份清单）
  const assets = walkAssets(UI_DIR)
  assert.ok(assets.length >= 20, 'ui-next 资产数量异常：' + assets.length)
  for (const p of assets) {
    const r = await gw.get(p)
    assert.equal(r.status, 200, p + ' 必须 200')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p + ' 必须 nosniff')
  }
  const page = await gw.get('/ui-next')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') || '', /text\/html/)
  const csp = page.headers.get('content-security-policy') || ''
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /connect-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  const html = await page.text()
  assert.match(html, /ModelGate/)
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/, '不得有内联脚本')
  assert.doesNotMatch(html, /https?:\/\/[^"'\s>]+/i, '不得引用外部资产')

  // 2) 未授权 /api/status：401 且不含任何状态/凭据投影
  const denied = await gw.get('/api/status')
  assert.equal(denied.status, 401)
  const deniedRaw = await denied.text()
  assert.match(deniedRaw, /error/)
  assert.doesNotMatch(deniedRaw, /providers|official|hasKey|lastServing|access_token|refresh_token/)
  assert.equal((await gw.get('/api/status', AUTH)).status, 200, '授权后必须可读')

  // 3) 聚合管理面：无令牌 403（不泄数据），未知路由 404 且是稳定 code
  const noToken = await gw.get('/api/aggregation/health')
  assert.equal(noToken.status, 403)
  const noTokenBody = await noToken.json()
  assert.equal(noTokenBody.code, 'explicit_admin_required')
  assert.doesNotMatch(JSON.stringify(noTokenBody), /detect|mode|providers|official/)

  const unknown = await gw.get('/api/aggregation/__a5_old_instance_probe__', AUTH)
  assert.equal(unknown.status, 404)
  const unknownBody = await unknown.json()
  assert.equal(unknownBody.code, 'aggregation_route_unknown')

  // 4) 404 语义在纯投影里必须收敛为 read_only_unknown（未知≠未启用≠0 个模型）
  assert.equal(product.PRODUCT_STATUS_CONTRACT, 'mg-ui-product-status/1')
  const ps = product.deriveProductStatus({
    authenticatedAdmin: true,
    status: { providers: [], models: [], official: { credential: 'missing', reason: 'auth_file_missing' } },
    aggregation: null,
    aggregationError: { status: 404, data: { code: 'aggregation_route_unknown' } },
  })
  assert.equal(ps.state, 'read_only_unknown')
  assert.equal(ps.aggregation.supported, false)
  assert.notEqual(ps.go.state, 'missing', '实例不支持聚合时不得断言“未连接 Go”')
  assert.notEqual(ps.go.discoveryState, '0')
  assert.equal(ps.primary.label, '查看高级诊断')

  // 5) 404 之后 UI 资产仍可用（旧实例场景的可见部分）
  assert.equal((await gw.get('/ui-next')).status, 200)
  t.diagnostic('真实旧实例二进制不可得：404 形状 + 投影已实测；跨版本实例联调记为 BLOCKED_OLD_INSTANCE')
})

// —— UI-02：官方登录投影（只读、无 token、不假定已登录） ——
test('UI-02: /api/status.official detected/missing 且不回显任何凭据', { timeout: 40000 }, async (t) => {
  const detectedHome = await isolatedCodexHome({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'fixture-access-a5-must-not-leak', refresh_token: 'fixture-refresh-a5-must-not-leak', account_id: 'fixture-account-a5' },
    last_refresh: '2026-11-15T00:00:00Z',
    email: 'fixture-a5@example.invalid',
  })
  const missingHome = await isolatedCodexHome(null)
  const gw1 = await startGateway({ name: 'a5-ui02-detected', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: detectedHome } })
  const gw2 = await startGateway({ name: 'a5-ui02-missing', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: missingHome } })
  t.after(async () => {
    await gw1.stop(); await gw2.stop()
    await rm(detectedHome, { recursive: true, force: true })
    await rm(missingHome, { recursive: true, force: true })
  })

  const detectedRes = await gw1.get('/api/status', AUTH)
  assert.equal(detectedRes.status, 200)
  const detectedRaw = await detectedRes.text()
  const detected = JSON.parse(detectedRaw)
  assert.equal(detected.official.credential, 'detected')
  assert.equal(detected.official.reason, 'local_codex_chatgpt')
  assert.equal(detected.official.authMode, 'chatgpt')
  assert.equal(detected.official.source, 'local_codex_auth_probe')
  assert.ok(detected.official.checkedAt)
  // 允许字段白名单：官方投影不得夹带账号/凭据；expiry 是只读有效期校验（与转发链同源）
  assert.deepEqual(Object.keys(detected.official).sort(), ['authMode', 'checkedAt', 'credential', 'expiry', 'level', 'reason', 'source'])
  assert.equal(detected.official.expiry, 'valid', '非 JWT 但可转发时应为 expiry=valid')
  for (const secret of ['fixture-access-a5-must-not-leak', 'fixture-refresh-a5-must-not-leak', 'fixture-account-a5', 'fixture-a5@example.invalid']) {
    assert.equal(detectedRaw.includes(secret), false, 'official 投影不得包含 ' + secret)
  }
  assert.notEqual(detected.official.level, 'runtime-verified', '检测到登录 ≠ 官方推理已实测')
  assert.notEqual(detected.official.credential, 'verified')

  const missing = await (await gw2.get('/api/status', AUTH)).json()
  assert.equal(missing.official.credential, 'missing')
  assert.equal(missing.official.reason, 'auth_file_missing')
  assert.equal(missing.official.expiry, 'unknown', '未检测到登录时 expiry 必须是 unknown（不得冒充 valid/expired）')
  assert.equal(missing.official.level, 'unknown', 'missing 不是 detected 级证据')
  const viewMissing = product.deriveOfficial(missing)
  assert.equal(viewMissing.state, 'missing')
  assert.equal(viewMissing.label, '待登录')
  assert.equal(product.deriveOfficial(detected).state, 'detected')
  assert.equal(product.deriveOfficial(detected).level, 'detected')

  // 过期 access_token：只读 expiry 校验必须与转发链同源（F-6），不得显示"已检测到登录"
  const expiredJwt = b64url({ alg: 'none' }) + '.' + b64url({ exp: Math.floor(Date.now() / 1000) - 3600 }) + '.sig'
  const expiredHome = await isolatedCodexHome({ auth_mode: 'chatgpt', tokens: { access_token: expiredJwt, refresh_token: 'r' }, last_refresh: '2026-11-01T00:00:00Z' })
  const gw3 = await startGateway({ name: 'a5-ui02-expired', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: expiredHome } })
  t.after(async () => { await gw3.stop(); await rm(expiredHome, { recursive: true, force: true }) })
  const expiredRes = await gw3.get('/api/status', AUTH)
  const expiredRaw = await expiredRes.text()
  const expired = JSON.parse(expiredRaw)
  assert.equal(expired.official.credential, 'detected', '文件层面仍是 detected（另有 expiry 表达不可用）')
  assert.equal(expired.official.expiry, 'expired', '过期令牌必须 expiry=expired')
  const viewExpired = product.deriveOfficial(expired)
  assert.equal(viewExpired.state, 'blocked')
  assert.equal(viewExpired.label, '登录已过期')
  assert.equal(viewExpired.reason, 'access_token_expired')
  assert.equal(expiredRaw.includes(expiredJwt), false, '过期令牌也不得回显')

  // 目标模型 ID 的容错：集成 Lead 90ac729 后是 mg- 公共 ID；基线是斜杠写法。两者都必须被认作目标。
  assert.equal(product.GO_TARGET_MODEL, 'deepseek-v4.1-flash')
  assert.ok(isTargetId(product.GO_PUBLIC_MODEL_ID), 'GO_PUBLIC_MODEL_ID 必须是目标模型的某种已发布写法：' + product.GO_PUBLIC_MODEL_ID)
  if (typeof product.matchesGoTargetId === 'function') {
    assert.equal(product.matchesGoTargetId('mg-opencodego-deepseek-v4-1-flash'), true)
    assert.equal(product.matchesGoTargetId('opencodego/deepseek-v4.1-flash'), true)
    assert.equal(product.matchesGoTargetId('deepseek-v4.1-flash'), true)
    assert.equal(product.matchesGoTargetId('mg-opencodego-gpt-6-luna'), false)
  }
})

// —— UI-03：Go 单字段 preset 通道（A2 已集成：只交 preset，URI/ID/env 由服务端预设提供） ——
test('UI-03: {preset:opencode-go} 真实 201、内联 Key 拒绝、重复注册 409 provider_exists', { timeout: 40000 }, async (t) => {
  const codexHome = await isolatedCodexHome(null)
  const gw = await startGateway({ name: 'a5-ui03', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: codexHome } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })

  const before = await (await gw.get('/api/aggregation/providers', AUTH)).json()
  assert.deepEqual(before.providers, [])
  assert.equal((await (await gw.get('/api/status', AUTH)).json()).configVersion, 0)

  // 1) 内联 apiKey 必须先被拒绝（Key 只能走 POST /api/keys；该拒绝先于"已存在"检查）
  const inlineRes = await gw.post('/api/aggregation/providers', {
    preset: 'opencode-go', apiKey: 'sk-inline-a5-must-not-leak',
  }, AUTH)
  assert.equal(inlineRes.status, 400)
  const inlineBody = await inlineRes.json()
  assert.equal(inlineBody.code, 'provider_key_inline_forbidden')
  assert.doesNotMatch(JSON.stringify(inlineBody), /sk-inline-a5-must-not-leak/)
  assert.equal((await (await gw.get('/api/aggregation/providers', AUTH)).json()).providers.length, 0, '失败不得写入 provider')

  // 2) 单字段 preset：用户不提供 id/baseUrl/apiKeyEnv，服务端预设补齐
  const presetRes = await gw.post('/api/aggregation/providers', { preset: 'opencode-go' }, AUTH)
  assert.equal(presetRes.status, 201, 'A2 已集成时 preset 必须 201（失败则读 body.code 定位）')
  const presetBody = await presetRes.json()
  assert.equal(presetBody.ok, true)
  assert.equal(presetBody.provider.id, 'opencodego')
  assert.equal(presetBody.provider.kind, 'opencode-go')
  assert.equal(presetBody.provider.baseUrl, 'https://opencode.ai/inference/go/openai/v1', 'baseUrl 必须来自服务端预设，不是用户输入')
  assert.equal(presetBody.provider.v2Scope, 'go-single-model')
  assert.equal(presetBody.configVersion, 1)
  assert.equal(presetBody.reload && presetBody.reload.applied, true)

  // 3) 未同步的目录状态必须是 unknown/null，不能是 0 个模型
  const list = await (await gw.get('/api/aggregation/providers', AUTH)).json()
  assert.deepEqual(list.providers.map((p) => p.id), ['opencodego'])
  assert.equal(list.providers[0].discoveryState, 'unknown')
  assert.equal(list.providers[0].modelCount, null)

  // 4) 重复注册同一 provider：真实语义是 409 provider_exists（不是覆盖、也不是 version_conflict）。
  //    这是本轮修复 UI-03 断言的真实原因：上一版测试在 preset 201 之后又 POST 了一次同 ID 的显式配置。
  const dupRes = await gw.post('/api/aggregation/providers', {
    id: 'opencodego', kind: 'opencode-go', baseUrl: 'http://127.0.0.1:1/v1',
  }, AUTH)
  assert.equal(dupRes.status, 409)
  const dupBody = await dupRes.json()
  assert.equal(dupBody.code, 'provider_exists')
  assert.notEqual(dupBody.code, 'version_conflict')
  const afterDup = await (await gw.get('/api/aggregation/providers', AUTH)).json()
  assert.equal(afterDup.providers.length, 1, '重复注册不得产生第二条记录')
  assert.equal(afterDup.providers[0].baseUrl, 'https://opencode.ai/inference/go/openai/v1', '重复注册不得覆盖既有 baseUrl')

  // 版本竞争的真实 409 另行区分（带过期 version 才触发 version_conflict）
  const staleRes = await gw.post('/api/aggregation/providers', {
    id: 'opencodego', kind: 'opencode-go', baseUrl: 'http://127.0.0.1:1/v1', version: 0,
  }, AUTH)
  assert.equal(staleRes.status, 409)
  assert.equal((await staleRes.json()).code, 'version_conflict')
  t.diagnostic('真实原因：preset 201 已创建 opencodego，重复注册 → 409 provider_exists（非版本冲突）；带过期 version → 409 version_conflict')
})

// —— UI-05：写虚构 Key 后状态回执 hasKey=true 且响应/配置不回显 Key ——
test('UI-05: POST /api/keys 写虚构 Key 的状态回执与零回显', { timeout: 40000 }, async (t) => {
  const codexHome = await isolatedCodexHome(null)
  const gw = await startGateway({ name: 'a5-ui05', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: codexHome } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })
  const KEY = 'sk-a5-fixture-key-must-not-leak'

  const add = await gw.post('/api/aggregation/providers', { id: 'opencodego', kind: 'opencode-go', baseUrl: 'http://127.0.0.1:1/v1' }, AUTH)
  assert.equal(add.status, 201)

  const keyRes = await gw.post('/api/keys', { id: 'opencodego', key: KEY }, AUTH)
  assert.equal(keyRes.status, 200)
  const keyRaw = await keyRes.text()
  assert.equal(keyRaw.includes(KEY), false, '/api/keys 响应不得回显 Key')

  const statusRes = await gw.get('/api/status', AUTH)
  const statusRaw = await statusRes.text()
  const status = JSON.parse(statusRaw)
  const go = status.providers.find((p) => p.id === 'opencodego')
  assert.ok(go, 'providers 投影必须包含 opencodego')
  assert.equal(go.hasKey, true, '写入后 hasKey 必须为 true')
  assert.ok(go.keySource, 'keySource 必须可追踪')
  assert.equal(statusRaw.includes(KEY), false, '/api/status 不得回显 Key')
  assert.equal(statusRaw.includes('sk-'), false, '/api/status 不得包含任何 sk- 形态的 Key 片段')

  const cfgRes = await gw.get('/api/config', AUTH)
  assert.equal(cfgRes.status, 200)
  const cfgRaw = await cfgRes.text()
  assert.equal(cfgRaw.includes(KEY), false, '/api/config 不得回显 Key')
  const cfg = JSON.parse(cfgRaw)
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, '_keys'), false, '/api/config 不得返回 _keys')

  // 非白名单 Key 标识必须被拒绝（不能留孤儿键）
  const orphan = await gw.post('/api/keys', { id: 'not-a-provider', key: KEY + '2' }, AUTH)
  assert.equal(orphan.status, 400)
})

// —— UI-08：activate 无 consentToken 的真实状态码，且绝不写入 ——
test('UI-08: activate 无 consentToken 不写入（真实状态码 422/428 如实记录）', { timeout: 40000 }, async (t) => {
  const codexHome = await isolatedCodexHome(null)
  const gw = await startGateway({ name: 'a5-ui08', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: codexHome } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })
  const configPath = join(codexHome, 'config.toml')

  const res = await gw.post('/api/aggregation/activate', {}, AUTH)
  const body = await res.json()
  assert.ok(res.status === 422 || res.status === 428, 'activate 无 consent 只能是 422 blocked 或 428 consent_required，实际 ' + res.status)
  assert.equal(existsSync(configPath), false, '预览阶段绝不写入 config.toml')

  if (res.status === 428) {
    assert.equal(body.code, 'consent_required')
    assert.ok(body.preview && typeof body.preview === 'object', '428 必须带完整预览')
    assert.equal(typeof body.preview.consentToken, 'string')
    assert.ok(body.preview.consentToken.length > 0)
    assert.equal(typeof body.preview.expectedSha, 'string')
    assert.ok(Array.isArray(body.preview.rows) || Array.isArray(body.preview.changed))
    t.diagnostic('实测 428 + preview（consentToken/expectedSha 存在）；未提交 consentToken，未写入')
  } else {
    assert.equal(body.ok, false)
    assert.equal(typeof body.code, 'string')
    t.diagnostic('BLOCKED_UNTIL_A2: 当前实例实测 ' + res.status + ' ' + body.code + '（无已发布聚合目录，preview 未生成）；未写入 config.toml')
  }

  // 伪造 consentToken 同样不得写入
  const bogus = await gw.post('/api/aggregation/activate', { consentToken: 'bogus-a5-token', expectedSha: '' }, AUTH)
  assert.ok(bogus.status >= 400 && bogus.status < 500, '伪造 consentToken 必须 4xx，实际 ' + bogus.status)
  assert.equal(existsSync(configPath), false, '伪造 consentToken 后仍不得写入 config.toml')
  const leftovers = readdirSync(codexHome)
  assert.deepEqual(leftovers, [], 'CODEX_HOME 必须保持空目录（没有 config/backup 残留）：' + leftovers.join(','))
})

// —— UI-05/UI-08：428 预览态必须能由状态层进入（Lead 9f7f524 放行 preview_pending 的独立验证） ——
test('UI-05/UI-08: setProductPhase(preview_pending) 经状态层投影为 preview_pending（不得假成功）', (t) => {
  const fixtureStatus = {
    providers: [{ id: 'opencodego', hasKey: true, keySource: 'keys' }],
    models: [{ name: 'mg-opencodego-deepseek-v4-1-flash' }],
    official: { credential: 'detected', expiry: 'valid', reason: 'local_codex_chatgpt' },
  }
  const fixtureAggregation = {
    health: { ok: true, mode: 'official', detect: { desktop: { found: true, version: '1' }, restart: { needed: false } } },
    providers: { providers: [{ id: 'opencodego', kind: 'opencode-go', discoveryState: 'complete' }] },
    models: { models: [{ publicId: 'mg-opencodego-deepseek-v4-1-flash', upstreamId: 'deepseek-v4.1-flash', authorized: true }] },
    diagnostics: { diagnostics: [] },
  }
  const saved = { status: uiState.status, aggregation: uiState.aggregation, auth: uiState.auth }
  t.after(() => {
    uiState.status = saved.status
    uiState.aggregation = saved.aggregation
    uiState.auth = saved.auth
    setProductPhase(null)
    invalidateProductStatus('a5-acceptance-reset')
  })
  uiState.status = fixtureStatus
  uiState.aggregation = fixtureAggregation
  uiState.auth = { needAuth: false, startedAt: 0 }
  invalidateProductStatus('a5-acceptance-preview')
  const before = productStatus()
  assert.notEqual(before.state, 'preview_pending', '未设置相位时不得自行声称等待确认')
  // 合法相位：允许进入 428 预览态，主 CTA 必须是"确认配置变更"
  setProductPhase('preview_pending')
  const ps = productStatus()
  assert.equal(ps.state, 'preview_pending')
  assert.equal(ps.primary.id, 'review-preview')
  assert.equal(ps.primary.label, '确认配置变更')
  assert.notEqual(ps.overall.level, 'ready')
  // 非法相位仍必须拒绝（白名单不是"任意字符串"）
  assert.throws(() => setProductPhase('verified_by_wishful_thinking'), /unknown product phase/)
  setProductPhase(null)
  assert.notEqual(productStatus().state, 'preview_pending', '清除相位后必须退出预览态')
})

// —— UI-10：401/403 不返回敏感数据 ——
test('UI-10: 401/403 响应无敏感数据、错误令牌不泄露状态', { timeout: 40000 }, async (t) => {
  const codexHome = await isolatedCodexHome(null)
  const withToken = await startGateway({ name: 'a5-ui10a', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: codexHome } })
  const noToken = await startGateway({ name: 'a5-ui10b', env: { MG_ADMIN_TOKEN: '', CODEX_HOME: codexHome } })
  t.after(async () => { await withToken.stop(); await noToken.stop(); await rm(codexHome, { recursive: true, force: true }) })

  const bad = await withToken.get('/api/status', { authorization: 'Bearer wrong-a5-token' })
  assert.equal(bad.status, 401)
  const badRaw = await bad.text()
  assert.doesNotMatch(badRaw, /providers|models|official|hasKey|lastServing|configVersion|wrong-a5-token/)

  // 聚合管理面在"未设置管理员令牌"时是 403 explicit_admin_required（没有回环放行）
  const agg = await noToken.get('/api/aggregation/health')
  assert.equal(agg.status, 403)
  const aggBody = await agg.json()
  assert.equal(aggBody.code, 'explicit_admin_required')
  assert.deepEqual(Object.keys(aggBody).sort(), ['code', 'error', 'ok'])
  const aggRaw = JSON.stringify(aggBody)
  assert.doesNotMatch(aggRaw, /detect|mode|providers|official|backup/)

  // 未授权时 UI 资产仍可打开（静态页面不涉及凭据）
  assert.equal((await noToken.get('/ui-next')).status, 200)
})

// —— UI-13：旧入口不丢失 ——
test('UI-13: /ui-next/index.html、/、/admin 仍返回 200', { timeout: 40000 }, async (t) => {
  const codexHome = await isolatedCodexHome(null)
  const gw = await startGateway({ name: 'a5-ui13', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: codexHome } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })

  const deep = await gw.get('/ui-next/index.html')
  assert.equal(deep.status, 200)
  assert.match(await deep.text(), /\/ui-next\/app\.js/)
  for (const p of ['/', '/admin', '/admin.html']) {
    const r = await gw.get(p)
    assert.equal(r.status, 200, p + ' 必须保留 200')
    assert.match(r.headers.get('content-type') || '', /text\/html/)
    assert.ok((await r.text()).length > 0)
  }
  const traversal = await gw.get('/ui-next/../src/index.js')
  assert.equal(traversal.status, 404, '路径穿越必须 404')
})

// —— UI-15：静态断点 / focus-visible（A4 未集成前只做静态事实断言） ——
test('UI-15: index.html/styles.css 已有移动断点与 focus-visible（视觉实测 NOT_TESTED_UNTIL_A4）', async (t) => {
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8')
  const css = readFileSync(join(UI_DIR, 'styles.css'), 'utf8')
  assert.match(html, /<meta name="viewport"/, '必须有 viewport meta')
  assert.match(css, /@media\s*\(max-width:\s*\d+px\)/, '必须有移动断点')
  assert.match(css, /@media\s*\(max-width:\s*540px\)/, '必须有 360–540 窄屏断点')
  assert.match(css, /:focus-visible/, '必须有 focus-visible 焦点样式')
  assert.match(css, /prefers-reduced-motion/, '必须有 reduced-motion 保护')
  t.diagnostic('NOT_TESTED_UNTIL_A4: 360/768/1440 主 CTA 不截断、200% 缩放与键盘环需浏览器实测（见 scripts/e2e/ui-v3-browser.mjs）')
})

// —— UI-01：首屏状态驱动（A1 集成后自动生效，否则如实 BLOCKED） ——
test('UI-01: 首屏状态驱动 + 唯一主 CTA + 三条连接状态（A1 静态职责）', async (t) => {
  const dash = readFileSync(join(UI_DIR, 'js/views/dashboard.js'), 'utf8')
  const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8')
  const appSrc = readFileSync(join(UI_DIR, 'app.js'), 'utf8')
  const hasProductStatus = /product-status|deriveProductStatus|productStatus/.test(dash)
  const hasConnectionsRoute = /data-route="connections"/.test(indexHtml)
  if (!hasProductStatus || !hasConnectionsRoute) {
    t.skip('BLOCKED_UNTIL_A1: dashboard.js 尚未接入产品状态投影（product-status=' + hasProductStatus + '），index.html 尚无 connections 分组导航（connections=' + hasConnectionsRoute + '）')
    return
  }
  // 静态职责：导航项全量在 HTML 中；aria-current 是运行时状态，必须由 app.js 写入，
  // 不能要求静态 HTML 预先带 aria-current（也不会在离线假装验证了运行时行为）。
  for (const id of ['overview', 'connections', 'settings', 'providers', 'models', 'clients', 'aggregation', 'observability']) {
    assert.match(indexHtml, new RegExp('data-route="' + id + '"'), 'index.html 必须有导航项 data-route="' + id + '"')
  }
  assert.match(indexHtml, /id="nav-advanced"/, '高级功能必须是可收起分组')
  assert.match(dash, /deriveProductStatus|productStatus/, '首屏必须消费统一投影')
  assert.match(appSrc, /setAttribute\(['"]aria-current['"],\s*['"]page['"]\)/, 'app.js 必须在运行时设置 aria-current="page"')
  assert.match(appSrc, /removeAttribute\(['"]aria-current['"]\)/, 'app.js 必须在切换路由时移除旧 aria-current')
  // 静态默认标记允许存在（A1 为默认路由预置，避免无 JS 时的 a11y 空档），但只允许标默认路由；
  // 路由切换后的真实值由浏览器 UI-01-nav-current 断言（含 #/connections 往返）。
  const staticCurrent = (indexHtml.match(/<button[^>]*>/g) || [])
    .filter((tagHtml) => /aria-current="page"/.test(tagHtml))
    .map((tagHtml) => (tagHtml.match(/data-route="([^"]+)"/) || [])[1])
  assert.deepEqual(staticCurrent, ['overview'], '静态 HTML 只允许把默认路由标为 aria-current="page"：' + JSON.stringify(staticCurrent))
  t.diagnostic('静态只校验"默认项预置 + 运行时更新/移除"职责；真实路由切换由 scripts/e2e/ui-v3-browser.mjs 的 UI-01-nav-current 在 Chrome 中断言（本文件不假装已验运行时）')
})

// —— UI-16 / UI-04 真实推理：本轮无付费授权 → BLOCKED ——
test('UI-16: 真实原版 Desktop + 真实模型推理（无付费授权）', (t) => {
  t.skip('BLOCKED_NO_PAID_MODEL_AUTH: 本轮未获真实模型调用授权；GPT 仅允许 gpt-6-luna、Go 仅 deepseek-v4.1-flash。真实 Desktop 联调与请求归因需所有者另行授权后按 UI-16 单独执行。')
})
