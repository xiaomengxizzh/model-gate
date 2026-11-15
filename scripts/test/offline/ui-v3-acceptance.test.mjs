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
  // 允许字段白名单：官方投影不得夹带账号/凭据
  assert.deepEqual(Object.keys(detected.official).sort(), ['authMode', 'checkedAt', 'credential', 'level', 'reason', 'source'])
  for (const secret of ['fixture-access-a5-must-not-leak', 'fixture-refresh-a5-must-not-leak', 'fixture-account-a5', 'fixture-a5@example.invalid']) {
    assert.equal(detectedRaw.includes(secret), false, 'official 投影不得包含 ' + secret)
  }
  assert.notEqual(detected.official.level, 'runtime-verified', '检测到登录 ≠ 官方推理已实测')
  assert.notEqual(detected.official.credential, 'verified')

  const missing = await (await gw2.get('/api/status', AUTH)).json()
  assert.equal(missing.official.credential, 'missing')
  assert.equal(missing.official.reason, 'auth_file_missing')
  const viewMissing = product.deriveOfficial(missing)
  assert.equal(viewMissing.state, 'missing')
  assert.equal(viewMissing.label, '待登录')
  assert.equal(product.deriveOfficial(detected).state, 'detected')
  assert.equal(product.deriveOfficial(detected).level, 'detected')

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

// —— UI-03：Go 单字段 preset 通道（A2 未集成 → 断言真实拒绝，记 BLOCKED_UNTIL_A2） ——
test('UI-03: POST /api/aggregation/providers 的 preset 通道与内联 Key 拒绝（真实响应）', { timeout: 40000 }, async (t) => {
  const codexHome = await isolatedCodexHome(null)
  const gw = await startGateway({ name: 'a5-ui03', env: { MG_ADMIN_TOKEN: ADMIN, CODEX_HOME: codexHome } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })

  const before = await (await gw.get('/api/aggregation/providers', AUTH)).json()
  assert.deepEqual(before.providers, [])
  const baselineVersion = (await (await gw.get('/api/status', AUTH)).json()).configVersion

  // 单字段向导依赖 {preset:'opencode-go'}；A2 未把 preset 透传到 registry 时应显式失败。
  const presetRes = await gw.post('/api/aggregation/providers', { preset: 'opencode-go' }, AUTH)
  const presetBody = await presetRes.json()
  if (presetRes.status === 201) {
    assert.equal(presetBody.ok, true)
    assert.equal(presetBody.provider.id, 'opencodego')
    t.diagnostic('A2 preset 通道已集成：201 ' + presetBody.provider.baseUrl)
  } else {
    assert.equal(presetRes.status, 400, 'preset 未集成时必须是可解释的 4xx，实际 ' + presetRes.status)
    assert.equal(presetBody.code, 'provider_kind_unknown')
    assert.equal((await (await gw.get('/api/aggregation/providers', AUTH)).json()).providers.length, 0, '失败不得写入 provider')
    assert.equal((await (await gw.get('/api/status', AUTH)).json()).configVersion, baselineVersion, '失败不得推进 configVersion')
    t.diagnostic('BLOCKED_UNTIL_A2: preset 透传未集成，当前真实响应 400 provider_kind_unknown（未写入）')
  }

  // 内联 apiKey 必须被拒绝（Key 只能走 POST /api/keys）
  const inlineRes = await gw.post('/api/aggregation/providers', {
    id: 'opencodego', kind: 'opencode-go', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-inline-a5-must-not-leak',
  }, AUTH)
  assert.equal(inlineRes.status, 400)
  const inlineBody = await inlineRes.json()
  assert.equal(inlineBody.code, 'provider_key_inline_forbidden')
  assert.doesNotMatch(JSON.stringify(inlineBody), /sk-inline-a5-must-not-leak/)

  // 显式两步注册（当前真实可用路径）——证明后端通道存在，不冒充单字段向导
  const addRes = await gw.post('/api/aggregation/providers', {
    id: 'opencodego', kind: 'opencode-go', baseUrl: 'http://127.0.0.1:1/v1',
  }, AUTH)
  assert.equal(addRes.status, 201)
  const added = await addRes.json()
  assert.equal(added.provider.id, 'opencodego')
  assert.equal(added.provider.kind, 'opencode-go')
  const list = await (await gw.get('/api/aggregation/providers', AUTH)).json()
  assert.deepEqual(list.providers.map((p) => p.id), ['opencodego'])
  assert.equal(list.providers[0].discoveryState, 'unknown', '未同步必须 unknown，不能是 0 个模型')
  assert.equal(list.providers[0].modelCount, null)
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
test('UI-01: 首屏状态驱动 + 唯一主 CTA + 三条连接状态（A1）', async (t) => {
  const dash = readFileSync(join(UI_DIR, 'js/views/dashboard.js'), 'utf8')
  const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8')
  const hasProductStatus = /product-status|deriveProductStatus|primaryAction/.test(dash)
  const hasConnectionsRoute = /data-route="connections"/.test(indexHtml)
  if (!hasProductStatus || !hasConnectionsRoute) {
    t.skip('BLOCKED_UNTIL_A1: dashboard.js 尚未接入产品状态投影（product-status=' + hasProductStatus + '），index.html 尚无 connections 分组导航（connections=' + hasConnectionsRoute + '）')
    return
  }
  assert.match(dash, /deriveProductStatus|productStatus/, '首屏必须消费统一投影')
  assert.match(indexHtml, /data-route="connections"/)
  assert.match(indexHtml, /aria-current/, '导航必须可表达当前页')
})

// —— UI-16 / UI-04 真实推理：本轮无付费授权 → BLOCKED ——
test('UI-16: 真实原版 Desktop + 真实模型推理（无付费授权）', (t) => {
  t.skip('BLOCKED_NO_PAID_MODEL_AUTH: 本轮未获真实模型调用授权；GPT 仅允许 gpt-6-luna、Go 仅 deepseek-v4.1-flash。真实 Desktop 联调与请求归因需所有者另行授权后按 UI-16 单独执行。')
})
