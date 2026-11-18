// 三模式 HTTP 端点接线回归：/api/aggregation/modes|switch|rollback。
//
// 全部在 OS 临时目录 + 隔离网关子进程（动态回环端口）中完成：
//   * 不读真实 ~/.codex、不改生产 config/凭据、不连真实上游、不启停 8787；
//   * 管理令牌是合成占位串，只存在于本进程内存与子进程 env，绝不打印/落盘为明文日志；
//   * 写盘目标由 CODEX_HOME 指向临时目录；网关健康探测指向隔离网关自身的 /healthz。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAggregationApi } from '../../../src/aggregation/api.js'
import { DESKTOP_POLICY } from '../../../src/codex/desktop-integration.js'
import { startGateway } from './harness.mjs'

const TOKEN = 'agg-mode-api-test-admin-token'
const USER_CONFIG = [
  '# agg-mode-api fixture（临时目录）',
  'model = "gpt-5"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  '',
].join('\n')
const PARENT = 'gpt-6-luna'
const ROUTE = 'mg-opencodego-deepseek-v4-1-flash'
const CHILD = 'deepseek-v4.1-flash'

function catalogText () {
  const model = (slug, extra = {}) => Object.assign({
    slug, display_name: slug, visibility: 'list', supported_in_api: true,
  }, extra)
  return JSON.stringify({ models: [model(PARENT), model(ROUTE), model(CHILD)] })
}

async function setup () {
  const dir = await mkdtemp(join(tmpdir(), 'agg-mode-api-cfg-'))
  const codexHome = await mkdtemp(join(tmpdir(), 'agg-mode-api-home-'))
  const configPath = join(codexHome, 'config.toml')
  await writeFile(configPath, USER_CONFIG)
  // 伪造一个已发布目录：activationOptions 用 readCurrent(SCOPE).path 作为 catalogPath，
  // verifyAll 也要求该文件存在且包含目标模型。
  const catDir = join(dir, 'aggregation', 'catalog', 'local')
  await mkdir(join(catDir, 'versions'), { recursive: true })
  const text = catalogText()
  const sha = createHash('sha256').update(text).digest('hex')
  await writeFile(join(catDir, 'current.json'), text)
  await writeFile(join(catDir, 'versions', 'v000001-' + sha.slice(0, 8) + '.json'), text)
  await writeFile(join(catDir, 'state.json'), JSON.stringify({
    schema: 'modelgate.catalog.state/1', currentVersion: 1, highWaterVersion: 1,
    current: {
      version: 1, file: 'versions/v000001-' + sha.slice(0, 8) + '.json',
      sha256: sha, generatedAt: new Date(0).toISOString(), format: 'json',
      counts: { total: 3 }, bindings: {}, aliases: {}, officialSlugs: [PARENT],
    },
    history: [], retiredBindings: {}, lastRollback: null,
  }))
  const gw = await startGateway({
    name: 'agg-mode-api',
    dir,
    env: { MG_ADMIN_TOKEN: TOKEN, CODEX_HOME: codexHome },
    config: { defaults: {}, providers: {}, models: {} },
  })
  const statePath = join(codexHome, '.modelgate-desktop-state.json')
  return {
    gw, dir, codexHome, configPath, statePath,
    readConfig: () => readFile(configPath, 'utf8'),
    readConfigBuffer: () => readFile(configPath),
    readState: async () => JSON.parse(await readFile(statePath, 'utf8')),
    readStateRaw: () => readFile(statePath, 'utf8'),
    cleanup: async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }) },
  }
}

// 切到 aggregated 并建立 state 基线，然后制造一次用户侧注释漂移（config 与 appliedSha 不一致）。
async function setupDrifted (t) {
  const f = await setup()
  t.after(f.cleanup)
  const p = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'aggregated', parentModel: PARENT } })
  assert.equal(p.status, 428, p.text)
  const applied = await api(f, '/api/aggregation/switch', {
    method: 'POST',
    body: { mode: 'aggregated', parentModel: PARENT, consentToken: p.body.preview.consentToken, expectedSha: p.body.preview.expectedSha },
  })
  assert.equal(applied.status, 200, applied.text)
  await writeFile(f.configPath, (await f.readConfig()) + '\n# reconcile local drift\n')
  const state = await f.readState()
  const buf = await f.readConfigBuffer()
  assert.notEqual(state.appliedSha, createHash('sha256').update(buf).digest('hex'), '夹具必须处于 drifted')
  return f
}

function allowedOwnedPaths () {
  const set = new Set(DESKTOP_POLICY.ownedTopLevel)
  for (const [name, keys] of Object.entries(DESKTOP_POLICY.ownedSections)) {
    for (const key of keys) set.add(name + '.' + key)
  }
  return set
}

function auth (extra = {}) {
  return Object.assign({ authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, extra)
}

async function api (f, path, opts = {}) {
  const r = await f.gw.call(path, {
    method: opts.method || 'GET',
    headers: auth(opts.headers || {}),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 也如实返回 */ }
  return { status: r.status, body: json, text }
}

// ---------------------------------------------------------------------------
// 1. GET /modes：三态元数据 + 候选父模型
// ---------------------------------------------------------------------------
test('GET /modes 返回三态元数据、current/previousMode/drifted 与候选父模型', async (t) => {
  const f = await setup()
  t.after(f.cleanup)
  const out = await api(f, '/api/aggregation/modes')
  assert.equal(out.status, 200, out.text)
  const b = out.body
  assert.equal(b.current.mode, 'official')
  assert.equal(typeof b.current.parentModel, 'string')
  assert.equal(b.previousMode, null)
  assert.equal(b.drifted, false)
  assert.deepEqual(b.available.map((m) => m.id), ['official', 'route', 'aggregated'])
  for (const m of b.available) {
    assert.equal(typeof m.label, 'string')
    assert.equal(typeof m.description, 'string')
    assert.ok(Array.isArray(m.selectableParents))
  }
  const agg = b.available.find((m) => m.id === 'aggregated')
  assert.ok(agg.selectableParents.some((p) => p.id === PARENT && p.realTest === 'ALLOWED_FOR_REAL_TEST'))
})

// ---------------------------------------------------------------------------
// 2. POST /switch：428 → 200；切到 route 时 preview 含 remove 行
// ---------------------------------------------------------------------------
test('POST /switch：无 consent 428 + preview，带 consent 200 回执；remove 行可见', async (t) => {
  const f = await setup()
  t.after(f.cleanup)

  const preview = await api(f, '/api/aggregation/switch', {
    method: 'POST', body: { mode: 'aggregated', parentModel: PARENT },
  })
  assert.equal(preview.status, 428, preview.text)
  assert.equal(preview.body.code, 'consent_required')
  const p = preview.body.preview
  assert.ok(Array.isArray(p.rows) && p.rows.length > 0)
  assert.equal(typeof p.consentToken, 'string')
  assert.match(p.expectedSha, /^[a-f0-9]{64}$/)
  assert.equal(typeof p.beforeSha, 'string')
  assert.equal(typeof p.afterSha, 'string')
  assert.deepEqual(p.restartPreview, { needed: true, reason: 'mode_change_requires_restart' })
  assert.equal(await f.readConfig(), USER_CONFIG, '预览阶段零写入')

  const applied = await api(f, '/api/aggregation/switch', {
    method: 'POST',
    body: { mode: 'aggregated', parentModel: PARENT, consentToken: p.consentToken, expectedSha: p.expectedSha },
  })
  assert.equal(applied.status, 200, applied.text)
  assert.equal(applied.body.ok, true)
  assert.equal(applied.body.mode, 'aggregated')
  assert.equal(applied.body.restart.needed, true)
  assert.equal(applied.body.reload.applied, true)
  assert.equal((await f.readState()).previous.mode, 'official')
  assert.match(await f.readConfig(), /^openai_base_url = /m)

  // aggregated → route：删除行必须出现在预览里。
  const pRoute = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'route' } })
  assert.equal(pRoute.status, 428, pRoute.text)
  assert.ok(pRoute.body.preview.rows.some((r) => r.kind === 'remove'), '切到路由必须展示删除行')
  const done = await api(f, '/api/aggregation/switch', {
    method: 'POST',
    body: { mode: 'route', consentToken: pRoute.body.preview.consentToken, expectedSha: pRoute.body.preview.expectedSha },
  })
  assert.equal(done.status, 200, done.text)
  assert.equal(done.body.mode, 'route')
  assert.equal((await f.readState()).previous.mode, 'aggregated')
})

// ---------------------------------------------------------------------------
// 3. 非法 mode → 422；consentToken 变化 → 428
// ---------------------------------------------------------------------------
test('POST /switch 非法 mode 返回 422；consentToken 失配返回 428 且零写入', async (t) => {
  const f = await setup()
  t.after(f.cleanup)
  const bad = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'bogus' } })
  assert.equal(bad.status, 422, bad.text)
  assert.equal(bad.body.code, 'invalid_mode')

  const p = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'aggregated', parentModel: PARENT } })
  assert.equal(p.status, 428)
  const wrong = await api(f, '/api/aggregation/switch', {
    method: 'POST',
    body: {
      mode: 'aggregated', parentModel: PARENT,
      consentToken: p.body.preview.consentToken + '-tampered',
      expectedSha: p.body.preview.expectedSha,
    },
  })
  assert.equal(wrong.status, 428, wrong.text)
  assert.equal(wrong.body.code, 'consent_required')
  assert.equal(await f.readConfig(), USER_CONFIG, '令牌失配不得写入')
})

// ---------------------------------------------------------------------------
// 4. drifted → 409
// ---------------------------------------------------------------------------
test('配置漂移（sha  mismatch）时 POST /switch 返回 409 且零写入', async (t) => {
  const f = await setup()
  t.after(f.cleanup)
  const p = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'aggregated', parentModel: PARENT } })
  assert.equal(p.status, 428)
  const applied = await api(f, '/api/aggregation/switch', {
    method: 'POST',
    body: { mode: 'aggregated', parentModel: PARENT, consentToken: p.body.preview.consentToken, expectedSha: p.body.preview.expectedSha },
  })
  assert.equal(applied.status, 200, applied.text)

  await writeFile(f.configPath, (await f.readConfig()) + '\n# local drift\n')
  const drifted = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'route' } })
  assert.equal(drifted.status, 409, drifted.text)
  assert.equal(drifted.body.code, 'config_drifted')
  assert.match(await f.readConfig(), /# local drift$/m, '漂移拒绝后不得覆盖用户改动')
})

// ---------------------------------------------------------------------------
// 5. POST /rollback：无 previous → 409；428 → 200
// ---------------------------------------------------------------------------
test('POST /rollback 无 previous 返回 409；有 previous 时 428 预览 → 200 回到上一模式', async (t) => {
  const fNone = await setup()
  t.after(fNone.cleanup)
  const none = await api(fNone, '/api/aggregation/rollback', { method: 'POST', body: {} })
  assert.equal(none.status, 409, none.text)
  assert.equal(none.body.code, 'no_previous_mode')

  const f = await setup()
  t.after(f.cleanup)
  const p = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'aggregated', parentModel: PARENT } })
  assert.equal(p.status, 428)
  const applied = await api(f, '/api/aggregation/switch', {
    method: 'POST',
    body: { mode: 'aggregated', parentModel: PARENT, consentToken: p.body.preview.consentToken, expectedSha: p.body.preview.expectedSha },
  })
  assert.equal(applied.status, 200, applied.text)

  const preview = await api(f, '/api/aggregation/rollback', { method: 'POST', body: {} })
  assert.equal(preview.status, 428, preview.text)
  assert.equal(preview.body.code, 'consent_required')
  assert.equal(preview.body.preview.previousMode, 'official')
  const rp = preview.body.preview
  assert.equal(typeof rp.consentToken, 'string')
  assert.match(rp.expectedSha, /^[a-f0-9]{64}$/)
  assert.equal(rp.restartPreview.needed, true)

  const rolled = await api(f, '/api/aggregation/rollback', {
    method: 'POST', body: { consentToken: rp.consentToken, expectedSha: rp.expectedSha },
  })
  assert.equal(rolled.status, 200, rolled.text)
  assert.equal(rolled.body.ok, true)
  assert.equal(rolled.body.mode, 'official')
  assert.equal(rolled.body.reload.applied, true)
  const text = await f.readConfig()
  assert.equal(/^openai_base_url = /m.test(text), false)
  assert.equal(/^model_catalog_json = /m.test(text), false)
})

// ---------------------------------------------------------------------------
// 6. 安全降级：管理面无令牌，无凭据也能读/预览；非回环仍 403；模块侧双门禁不变
// ---------------------------------------------------------------------------
test('安全下界：无令牌可读、switch 预览 428；模块侧 explicitAdmin/isLocal 不可绕过', async (t) => {
  const f = await setup()
  t.after(f.cleanup)

  const noToken = await f.gw.get('/api/aggregation/modes')
  assert.equal(noToken.status, 200, '管理面无令牌，回环 GET /modes 直接 200')
  const modesBody = await noToken.json()
  assert.equal(JSON.stringify(modesBody).includes(TOKEN), false, '响应不得回显管理令牌')

  const preview = await f.gw.call('/api/aggregation/switch', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'aggregated' }),
  })
  assert.equal(preview.status, 428, '无令牌（含错误 Bearer）也应进入 428 预览，而非 403')
  const previewBody = await preview.json()
  assert.equal(JSON.stringify(previewBody).includes(TOKEN), false, '响应不得回显管理令牌')

  // 模块侧双门禁：即便绕过入口，也必须显式管理员 + 回环。
  const ctx = { method: 'GET', path: '/api/aggregation/modes', cfg: {}, rawBody: undefined }
  const anon = await handleAggregationApi(Object.assign({}, ctx, { explicitAdmin: false, isLocal: true }))
  assert.equal(anon.status, 403)
  assert.equal(anon.body.code, 'explicit_admin_required')
  const remote = await handleAggregationApi(Object.assign({}, ctx, { explicitAdmin: true, isLocal: false }))
  assert.equal(remote.status, 403)
  assert.equal(remote.body.code, 'aggregation_loopback_required')
})

// ---------------------------------------------------------------------------
// 7. 三端点不再 404：/modes /switch /rollback 对已鉴权请求都有明确定义的状态码
// ---------------------------------------------------------------------------
test('三个端点均已接线：对已鉴权请求不再返回 404', async (t) => {
  const f = await setup()
  t.after(f.cleanup)
  const modes = await api(f, '/api/aggregation/modes')
  assert.equal(modes.status, 200)
  const sw = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'official' } })
  assert.notEqual(sw.status, 404)
  const rb = await api(f, '/api/aggregation/rollback', { method: 'POST', body: {} })
  assert.notEqual(rb.status, 404)
})

// ---------------------------------------------------------------------------
// 8. POST /reconcile：漂移时无 consent → 428 + 脱敏 preview，零写入
// ---------------------------------------------------------------------------
test('POST /reconcile：漂移时无 consent 返回 428 + 脱敏 preview，config 字节不变', async (t) => {
  const f = await setupDrifted(t)
  const before = await f.readConfigBuffer()
  const out = await api(f, '/api/aggregation/reconcile', { method: 'POST', body: {} })
  assert.equal(out.status, 428, out.text)
  assert.equal(out.body.code, 'consent_required')
  const p = out.body.preview
  assert.equal(p.stateOnly, true)
  assert.equal(p.configUnchanged, true)
  assert.equal(p.needsReconcile, true)
  assert.ok(p.reasons.includes('applied_sha_mismatch'))
  assert.match(p.consentToken, /^[a-f0-9]{64}$/)
  assert.match(p.beforeSha, /^[a-f0-9]{64}$/)
  assert.match(p.afterSha, /^[a-f0-9]{64}$/)
  assert.equal(p.afterSha, p.expectedSha, 'after/expected sha 必须都指向当前 config 字节')
  assert.notEqual(p.beforeSha, p.afterSha)
  assert.match(out.body.note, /只更新 state|不修改 config\.toml/)
  // 脱敏断言：差异行只能是 ModelGate 自有字段，预览里不得出现任何凭据字样。
  assert.ok(Array.isArray(p.rows) && p.rows.length > 0)
  const allowed = allowedOwnedPaths()
  for (const r of p.rows) assert.ok(allowed.has(r.path), 'preview 出现了非自有字段：' + r.path)
  const dump = JSON.stringify(out.body).toLowerCase()
  for (const needle of ['api_key', 'apikey', 'authorization', 'bearer', 'secret', 'password', 'keys.local', 'admin.token']) {
    assert.equal(dump.includes(needle), false, 'preview 泄漏了凭据字样：' + needle)
  }
  assert.deepEqual(await f.readConfigBuffer(), before, '预览阶段 config.toml 字节不变')
})

// ---------------------------------------------------------------------------
// 9. POST /reconcile：带 consent → 200 解漂；config.toml 字节前后完全不变（关键断言）
// ---------------------------------------------------------------------------
test('POST /reconcile：带 consent 200 解漂，drifted→false，config.toml 字节前后完全不变', async (t) => {
  const f = await setupDrifted(t)
  const before = await f.readConfigBuffer()
  const beforeSha = createHash('sha256').update(before).digest('hex')
  const prev = await api(f, '/api/aggregation/reconcile', { method: 'POST', body: {} })
  assert.equal(prev.status, 428, prev.text)
  const rp = prev.body.preview
  assert.equal(rp.expectedSha, beforeSha)

  const done = await api(f, '/api/aggregation/reconcile', {
    method: 'POST', body: { consentToken: rp.consentToken, expectedSha: rp.expectedSha },
  })
  assert.equal(done.status, 200, done.text)
  assert.equal(done.body.ok, true)
  assert.equal(done.body.drifted, false, '解漂后 drifted 必须为 false')
  assert.equal(done.body.mode, 'aggregated')
  assert.equal(done.body.reload.applied, false, 'config 没变，不应重载')
  assert.equal(done.body.reload.needsRestart, false)

  // ★ 关键断言：reconcile 前后 config.toml 字节完全不变，用户漂移行原样保留。
  const after = await f.readConfigBuffer()
  assert.deepEqual(after, before, 'KEY: reconcile 前后 config.toml 字节完全不变')
  assert.equal(createHash('sha256').update(after).digest('hex'), beforeSha, 'KEY: config sha256 不变')
  assert.match(after.toString('utf8'), /# reconcile local drift\n$/, '用户后加的行必须原样保留')

  // state 基线必须迁移到当前 config 字节，且写前备份存在。
  const state = await f.readState()
  assert.equal(state.appliedSha, beforeSha)
  assert.notEqual(await readFile(f.statePath + '.bak', 'utf8').catch(() => null), null, '成功对账应留下 state 备份')

  // 解漂后三模式切换不再被 409 拒绝（428 → 200）。
  const modes = await api(f, '/api/aggregation/modes')
  assert.equal(modes.status, 200)
  assert.equal(modes.body.drifted, false)
  const sw = await api(f, '/api/aggregation/switch', { method: 'POST', body: { mode: 'route' } })
  assert.equal(sw.status, 428, sw.text)
  const swDone = await api(f, '/api/aggregation/switch', {
    method: 'POST',
    body: { mode: 'route', consentToken: sw.body.preview.consentToken, expectedSha: sw.body.preview.expectedSha },
  })
  assert.equal(swDone.status, 200, swDone.text)
  assert.equal(swDone.body.mode, 'route')
})

// ---------------------------------------------------------------------------
// 10. POST /reconcile：consentToken 篡改 → 428 零写入（含 state 备份也不生成）
// ---------------------------------------------------------------------------
test('POST /reconcile：consentToken 篡改 → 428 且 config/state 零写入', async (t) => {
  const f = await setupDrifted(t)
  const configBefore = await f.readConfigBuffer()
  const stateBefore = await f.readStateRaw()
  const prev = await api(f, '/api/aggregation/reconcile', { method: 'POST', body: {} })
  assert.equal(prev.status, 428)
  const wrong = await api(f, '/api/aggregation/reconcile', {
    method: 'POST',
    body: { consentToken: prev.body.preview.consentToken + '-tampered', expectedSha: prev.body.preview.expectedSha },
  })
  assert.equal(wrong.status, 428, wrong.text)
  assert.equal(wrong.body.code, 'consent_required')
  assert.deepEqual(await f.readConfigBuffer(), configBefore, '令牌失配不得写 config.toml')
  assert.equal(await f.readStateRaw(), stateBefore, '令牌失配不得写 state')
  assert.equal(await readFile(f.statePath + '.bak', 'utf8').catch(() => null), null, '令牌失配不得生成 state 备份')
})

// ---------------------------------------------------------------------------
// 11. POST /reconcile：无令牌进入 428 预览，不回显凭据；漂移消失后幂等 200
// ---------------------------------------------------------------------------
test('POST /reconcile：无凭据 428 不回显；漂移消失后幂等 200', async (t) => {
  const f = await setupDrifted(t)
  const noAuth = await f.gw.call('/api/aggregation/reconcile', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(noAuth.status, 428, '管理面无令牌，回环预览应 428 而非 403')
  const noAuthBody = await noAuth.json()
  assert.equal(JSON.stringify(noAuthBody).includes(TOKEN), false)

  const wrongAuth = await f.gw.call('/api/aggregation/reconcile', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(wrongAuth.status, 428, '错误 Bearer 被忽略，仍进入 428 预览')

  // 模块侧 isLocal=false 仍必须 403（Host/Origin/peer 门禁由入口注入）。
  const ctx = { method: 'POST', path: '/api/aggregation/reconcile', cfg: {}, rawBody: undefined }
  const remote = await handleAggregationApi(Object.assign({}, ctx, { explicitAdmin: true, isLocal: false }))
  assert.equal(remote.status, 403)
  assert.equal(remote.body.code, 'aggregation_loopback_required')

  // 先成功解漂，再用新预览确认一次：changed=false 的幂等 200。
  const p1 = await api(f, '/api/aggregation/reconcile', { method: 'POST', body: {} })
  assert.equal(p1.status, 428)
  const d1 = await api(f, '/api/aggregation/reconcile', {
    method: 'POST', body: { consentToken: p1.body.preview.consentToken, expectedSha: p1.body.preview.expectedSha },
  })
  assert.equal(d1.status, 200, d1.text)
  const configAfter = await f.readConfigBuffer()
  const p2 = await api(f, '/api/aggregation/reconcile', { method: 'POST', body: {} })
  assert.equal(p2.status, 428)
  const d2 = await api(f, '/api/aggregation/reconcile', {
    method: 'POST', body: { consentToken: p2.body.preview.consentToken, expectedSha: p2.body.preview.expectedSha },
  })
  assert.equal(d2.status, 200, d2.text)
  assert.equal(d2.body.changed, false, '漂移已消失时必须幂等')
  assert.equal(d2.body.drifted, false)
  assert.deepEqual(await f.readConfigBuffer(), configAfter, '幂等路径也不得改 config.toml')
})
