// M4-1a：Codex 管理面授权 / 登记根 / 文件信任域的离线契约测试。
// 直接调用 handleCodexApi(ctx)，不起网关、不占端口、不读 HOME；配置 fixture 全在 OS 临时目录。
// 安全边界：显式管理员 + 不透明 root/backup id + 白名单字段差异 + 脱敏 + CAS/确认令牌绑定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_API_CONTRACT,
  CODEX_API_ROUTES,
  MAX_DIFF_ROWS,
  handleCodexApi,
  isCodexApiPath,
  requiresExplicitAdmin,
  resolveLocality,
  summarizeCodexCatalog,
  validateCodexConfigPath,
} from '../../../src/codex/api.js'
import {
  CONFIRM_TTL_MS,
  registerConfigRoot,
  resetManagementStateForTest,
  sha256Hex,
} from '../../../src/codex/config.js'

// fixture 里故意放两类“只应留在文件里”的哨兵：MCP env 值与认证头。
const USER_CONFIG = [
  '# 用户自己的 Codex 配置（测试 fixture，临时目录）',
  '# 下面这条注释含一个只会出现在文件里的标记：file-only-marker-9f2c',
  'model = "gpt-5"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  'env = { API_KEY = "sk-SENTINEL-MCP" }',
  'headers = { Authorization = "Bearer sk-SENTINEL-AUTH" }',
  '',
].join('\n')

const DESIRED = {
  topLevel: {
    model: 'mg/gpt-5-aggregate',
    model_provider: 'openai',
    openai_base_url: 'http://127.0.0.1:8787',
    model_catalog_json: '/tmp/mg-catalog/codex-catalog.json',
  },
}

let rootSeq = 0
function nextRootId () { rootSeq += 1; return 'root-' + rootSeq }

// 每个 fixture 都在模块级登记根里注册一个不透明 id；浏览器/调用方永远拿不到真实路径。
async function fixture (text = USER_CONFIG, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-api-'))
  const path = join(dir, 'config.toml')
  if (text !== null) await writeFile(path, text, 'utf8')
  const rootId = nextRootId()
  registerConfigRoot({ id: rootId, path, mode: opts.mode || 'managed' })
  return {
    dir,
    path,
    text,
    rootId,
    cleanup: async () => { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }) },
  }
}

// 普通产品默认：显式管理员已通过，但不在 managedRoot（写路径必须 403 disabled）。
function call (ctx = {}) {
  return handleCodexApi(Object.assign({ explicitAdmin: true, adminSubject: 'admin-a', managedRoot: false }, ctx))
}
// 受控自管 fixture：显式管理员 + managedRoot=true（仍要求登记根 mode=managed）。
function callW (ctx = {}) {
  return call(Object.assign({ managedRoot: true }, ctx))
}

function planBody (f, extra = {}) {
  return Object.assign({ root: f.rootId, desired: DESIRED }, extra)
}

function fakeLog () {
  const lines = []
  return { lines, info (s) { lines.push(String(s)) }, warn (s) { lines.push(String(s)) } }
}

function cfgWithCatalog (extra = {}) {
  return Object.assign({
    defaults: { codexCatalogBasePath: '/tmp/mg-catalog/base.json' },
    _codexCatalog: {
      key: '/tmp/mg-catalog/base.json|1000|20|["a"]',
      models: [{ slug: 'gpt-5', base_instructions: 'X'.repeat(5000) }, { slug: 'mg-deepseek', base_instructions: 'Y'.repeat(5000) }],
      bindings: { 'mg-deepseek': { slug: 'mg-deepseek', stableId: 'mg-deepseek', provider: 'ocg', providerName: 'OpenCode Go', model: 'deepseek-v4', capability: 'chat' } },
      officialSlugs: ['gpt-5'],
    },
  }, extra)
}

test('路由清单与显式管理员声明', () => {
  assert.equal(CODEX_API_CONTRACT, 'mg-codex-api/1')
  assert.deepEqual(CODEX_API_ROUTES.map((r) => r.method + ' ' + r.path), [
    'GET /api/codex/policy',
    'POST /api/codex/config/plan',
    'POST /api/codex/config/apply',
    'POST /api/codex/config/rollback',
    'GET /api/codex/config/export',
    'GET /api/codex/catalog/status',
    'GET /api/codex/quota',
    'GET /api/codex/emergency',
    'POST /api/codex/emergency',
    'GET /api/codex/history/diagnose',
    'GET /api/codex/history/export/plan',
    'POST /api/codex/history/export',
  ])
  assert.equal(isCodexApiPath('/api/codex'), true)
  assert.equal(isCodexApiPath('/api/codex/policy'), true)
  assert.equal(isCodexApiPath('/api/codex/policy?x=1'), true)
  assert.equal(isCodexApiPath('/api/codexx'), false)
  assert.equal(isCodexApiPath('/v1/models'), false)
  assert.ok(CODEX_API_ROUTES.every((r) => r.explicitAdmin === true), '每个路由都必须声明 explicitAdmin')
  assert.deepEqual(CODEX_API_ROUTES.filter((r) => r.write).map((r) => r.path), ['/api/codex/config/apply', '/api/codex/config/rollback', '/api/codex/emergency', '/api/codex/history/export'])
  for (const r of CODEX_API_ROUTES) assert.equal(requiresExplicitAdmin(r.name), true, r.name)
  assert.equal(requiresExplicitAdmin('nope'), false)
})

test('P0-2：无显式管理员 ⇒ 每个路由 403（含实例未设置 adminToken 的旧语义）', async () => {
  const legacyContexts = [
    { method: 'GET', path: '/api/codex/policy' },
    { method: 'GET', path: '/api/codex/policy', requireAdmin: () => true, isAdmin: true },
    { method: 'GET', path: '/api/codex/policy', requireAdmin: () => false },
    { method: 'GET', path: '/api/codex/policy', requireAdmin: async () => true },
    { method: 'GET', path: '/api/codex/catalog/status' },
    { method: 'GET', path: '/api/codex/config/export', query: { root: 'x' } },
    { method: 'POST', path: '/api/codex/config/plan', body: { root: 'x', desired: DESIRED } },
    { method: 'POST', path: '/api/codex/config/apply', body: { root: 'x', desired: DESIRED } },
    { method: 'POST', path: '/api/codex/config/rollback', body: { root: 'x' } },
  ]
  for (const ctx of legacyContexts) {
    const out = await handleCodexApi(ctx)
    assert.equal(out.status, 403, JSON.stringify(ctx))
    assert.equal(out.body.code, 'explicit_admin_required')
    assert.equal(out.body.ok, false)
  }
  // requireExplicitAdmin 显式返回 true 才放行（M4-1b 入口的接线点）
  const viaFn = await handleCodexApi({ method: 'GET', path: '/api/codex/policy', requireExplicitAdmin: () => true, adminSubject: 'admin-x', isLocal: true })
  assert.equal(viaFn.status, 200)
})

test('鉴权：注入函数已写响应（headersSent）时返回 null，不二次写头', async () => {
  const out = await handleCodexApi({
    method: 'GET',
    path: '/api/codex/policy',
    res: { headersSent: true },
  })
  assert.equal(out, null)
})

test('来源：非本机拒绝 403，本机放行；allowRemote 显式放宽', async () => {
  assert.deepEqual(resolveLocality({ isLocal: true }), { local: true, source: 'ctx.isLocal' })
  assert.deepEqual(resolveLocality({ isLocal: false }), { local: false, source: 'ctx.isLocal' })
  assert.equal(resolveLocality({ remoteAddress: '127.0.0.1' }).local, true)
  assert.equal(resolveLocality({ remoteAddress: '::1' }).local, true)
  assert.equal(resolveLocality({ remoteAddress: '::ffff:127.0.0.1' }).local, true)
  assert.equal(resolveLocality({ remoteAddress: '10.1.2.3' }).local, false)
  assert.equal(resolveLocality({ remoteAddress: '127.0.0.1:5555' }).local, false)
  assert.equal(resolveLocality({}).local, true, 'unknown address → 不阻断（显式管理员仍强制）')
  assert.equal(resolveLocality({ allowRemote: true, remoteAddress: '10.0.0.9' }).local, true)

  const remote = await call({ method: 'GET', path: '/api/codex/policy', isLocal: false })
  assert.equal(remote.status, 403)
  assert.equal(remote.body.code, 'remote_forbidden')
  const remote2 = await call({ method: 'GET', path: '/api/codex/policy', remoteAddress: '192.168.1.20' })
  assert.equal(remote2.status, 403)
  const local = await call({ method: 'GET', path: '/api/codex/policy', remoteAddress: '127.0.0.1' })
  assert.equal(local.status, 200)
})

test('未知路由 404、方法不匹配 405（鉴权之后才暴露）', async () => {
  const unknown = await call({ method: 'GET', path: '/api/codex/nope' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.code, 'unknown_endpoint')
  const wrongMethod = await call({ method: 'GET', path: '/api/codex/config/plan' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.body.code, 'method_not_allowed')
  const unauth = await handleCodexApi({ method: 'GET', path: '/api/codex/nope' })
  assert.equal(unauth.status, 403)
})

test('GET /api/codex/policy：所有权 + 目录摘要 + 写能力（普通模式关闭）', async () => {
  const out = await call({ method: 'GET', path: '/api/codex/policy', cfg: cfgWithCatalog() })
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.contract, CODEX_API_CONTRACT)
  const p = out.body.policy
  assert.deepEqual(p.ownedTopLevel, ['model_provider', 'openai_base_url', 'model', 'model_catalog_json'])
  assert.deepEqual(p.reservedOverrideSections, ['model_providers.openai'])
  assert.ok(p.guarantees.includes('never-writes-auth-json'))
  assert.equal(out.body.write.available, false, '普通产品模式默认不允许 apply/rollback')
  assert.equal(out.body.write.applyEnabled, false)
  assert.equal(out.body.write.requiresExplicitAdmin, true)
  assert.equal(out.body.write.requiresManagedRoot, true)
  assert.equal(out.body.auth.explicitAdminRequired, true)
  assert.equal(out.body.auth.adminSubjectBound, true)
  assert.equal(out.body.auth.localOnly, true)
  assert.equal(out.body.paths.rootIdRequired, true)
  assert.equal(out.body.paths.opaqueRootIdsOnly, true)
  assert.equal(out.body.paths.requiredBasenameAtRegistration, 'config.toml')
  assert.equal(out.body.routes.length, 12, 'N05/N04 新增 quota、emergency(2)、history(3) 路由')
  assert.equal(out.body.routes.find((r) => r.path === '/api/codex/config/export').explicitAdmin, true)
  assert.equal(out.body.catalog.available, true)
  assert.deepEqual(out.body.catalog.counts, { official: 1, thirdParty: 1, total: 2 })
  const text = JSON.stringify(out.body)
  assert.ok(!text.includes('base_instructions'), 'must not leak model metadata blobs')
  assert.ok(text.length < 12000, 'policy payload too large: ' + text.length)
  // 受控 fixture 打开写能力（仍由登记根 mode 决定）
  const managed = await callW({ method: 'GET', path: '/api/codex/policy' })
  assert.equal(managed.body.write.available, true)
})

test('GET /api/codex/catalog/status：计数 + 世代 + 截断 slugs，不回全量', async () => {
  const cfg = {
    defaults: { codexCatalogBasePath: '/tmp/mg-catalog/base.json' },
    _codexCatalog: {
      key: '/tmp/mg-catalog/base.json|1|2|[]',
      models: new Array(80).fill(0).map((_, i) => ({ slug: 'm' + i, base_instructions: 'Z'.repeat(2000) })),
      bindings: { 'mg-a': { slug: 'mg-a', provider: 'p1', model: 'x', capability: 'chat' }, 'mg-b': { slug: 'mg-b', provider: 'p2', model: 'y', capability: 'chat' } },
      officialSlugs: new Array(78).fill(0).map((_, i) => 'gpt-' + i),
    },
  }
  const out = await call({ method: 'GET', path: '/api/codex/catalog/status', cfg })
  assert.equal(out.status, 200)
  assert.equal(out.body.readOnly, true)
  assert.equal(out.body.fullCatalogReturned, false)
  const c = out.body.catalog
  assert.equal(c.available, true)
  assert.deepEqual(c.counts, { official: 78, thirdParty: 2, total: 80 })
  assert.match(c.generation, /^[0-9a-f]{12}$/)
  assert.equal(c.officialSlugs.length, 50)
  assert.equal(c.officialSlugsTruncated, true)
  const text = JSON.stringify(out.body)
  assert.ok(!text.includes('base_instructions'))
  assert.ok(text.length < 20000)
})

test('路径护栏（登记时）：绝对路径 + config.toml，拒 auth.json/sessions/非 .toml/..', () => {
  assert.equal(validateCodexConfigPath('/home/u/.codex/config.toml').ok, true)
  for (const [input, code] of [
    ['', 'invalid_path'],
    ['config.toml', 'invalid_path'],
    ['./config.toml', 'invalid_path'],
    ['/tmp/x/auth.json', 'forbidden_path'],
    ['/tmp/x/gateway.json', 'invalid_path'],
    ['/home/u/.codex/sessions/config.toml', 'forbidden_path'],
    ['/home/u/.codex/../config.toml', 'invalid_path'],
    ['/tmp/x/config.toml\u0000', 'invalid_path'],
  ]) {
    const r = validateCodexConfigPath(input)
    assert.equal(r.ok, false, String(input))
    assert.equal(r.code, code, String(input) + ' → ' + JSON.stringify(r))
  }
})

test('登记根：符号链接 / 相对路径 / 非法 id 在登记时拒绝', async () => {
  const f = await fixture()
  const dir2 = await mkdtemp(join(tmpdir(), 'mg-codex-api-link-'))
  const link = join(dir2, 'config.toml')
  await symlink(f.path, link)
  try {
    assert.throws(() => registerConfigRoot({ id: 'link-root', path: link, mode: 'managed' }), (e) => e.code === 'symlink_refused')
    assert.throws(() => registerConfigRoot({ id: 'rel-root', path: 'config.toml' }), (e) => e.code === 'invalid_path')
    assert.throws(() => registerConfigRoot({ id: '../x', path: f.path }), (e) => e.code === 'invalid_root_id')
    assert.throws(() => registerConfigRoot({ id: 'bad-mode', path: f.path, mode: 'root' }), (e) => e.code === 'invalid_root_mode')
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG)
  } finally {
    await rm(dir2, { recursive: true, force: true })
    await f.cleanup()
  }
})

test('P0-2：任意路径 / 未登记 id / 原始 TOML 一律拒绝', async () => {
  const f = await fixture()
  try {
    const pathBody = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED } })
    assert.equal(pathBody.status, 400)
    assert.equal(pathBody.body.code, 'path_not_allowed')
    const raw = await call({ method: 'POST', path: '/api/codex/config/plan', body: { root: f.rootId, toml: 'model = "x"', desired: DESIRED } })
    assert.equal(raw.status, 400)
    assert.equal(raw.body.code, 'raw_content_not_allowed')
    const content = await call({ method: 'POST', path: '/api/codex/config/plan', body: { root: f.rootId, content: 'model = "x"', desired: DESIRED } })
    assert.equal(content.status, 400)
    assert.equal(content.body.code, 'raw_content_not_allowed')
    const traversal = await call({ method: 'POST', path: '/api/codex/config/plan', body: { root: '../etc/config.toml', desired: DESIRED } })
    assert.equal(traversal.status, 400)
    assert.equal(traversal.body.code, 'invalid_root_id')
    const absolute = await call({ method: 'POST', path: '/api/codex/config/plan', body: { root: '/etc/passwd', desired: DESIRED } })
    assert.equal(absolute.status, 400)
    const unknown = await call({ method: 'POST', path: '/api/codex/config/plan', body: { root: 'not-registered', desired: DESIRED } })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.code, 'unknown_config_root')
  } finally { await f.cleanup() }
})

test('POST /config/plan：只读、白名单字段差异、无原文/无哨兵、confirmToken 绑定', async () => {
  const f = await fixture()
  try {
    const before = await readFile(f.path)
    const out = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.wrote, false)
    assert.equal(out.body.root, f.rootId)
    assert.match(String(out.body.generation), /^[0-9a-f]{64}$|^absent$/)
    assert.match(String(out.body.confirmToken), /^cf_[a-f0-9]{48}$/)
    assert.equal(typeof out.body.expiresAt, 'number')
    assert.ok(Array.isArray(out.body.changed) && out.body.changed.length > 0)
    const change = out.body.changed.find((c) => c.field === 'model')
    assert.equal(change.from, 'gpt-5', '归一化字段值（不带 TOML 引号/整行）')
    assert.equal(change.to, 'mg/gpt-5-aggregate')
    assert.equal(change.owner, 'modelgate')
    assert.equal(out.body.existing.topLevel.model.value, 'gpt-5')
    assert.equal(out.body.existing.topLevel.model.present, true)
    assert.ok(!Object.prototype.hasOwnProperty.call(out.body, 'beforeText'))
    assert.ok(!Object.prototype.hasOwnProperty.call(out.body, 'afterText'))
    assert.ok(!Object.prototype.hasOwnProperty.call(out.body, 'diff'), '不再回带原文的行级 diff')
    assert.ok(!Object.prototype.hasOwnProperty.call(out.body, 'backupPath'))
    // 关键：MCP env / Authorization / 文件注释里的哨兵绝不能出现在 plan 响应里
    const text = JSON.stringify(out.body)
    for (const sentinel of ['sk-SENTINEL-MCP', 'sk-SENTINEL-AUTH', 'file-only-marker-9f2c', 'approval_policy', 'mcp_servers']) {
      assert.equal(text.includes(sentinel), false, 'plan must not leak: ' + sentinel)
    }
    // 真的没写盘
    assert.deepEqual(await readFile(f.path), before)
    assert.deepEqual((await readdir(f.dir)).sort(), ['config.toml'])
  } finally { await f.cleanup() }
})

test('plan：空 desired 的 changed 为空；plan 仍不回正文', async () => {
  const f = await fixture()
  try {
    const out = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f, { desired: { topLevel: { model: 'gpt-5' } } }) })
    assert.equal(out.status, 200)
    assert.deepEqual(out.body.changed, [])
  } finally { await f.cleanup() }
})

test('P0-2：普通产品模式 apply/rollback 一律 403 disabled；readonly 登记根也拒绝', async () => {
  const f = await fixture()
  const ro = await fixture(USER_CONFIG, { mode: 'readonly' })
  try {
    const plan = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f) })
    const disabled = await call({ method: 'POST', path: '/api/codex/config/apply', body: planBody(f, { expected: plan.body.before, confirmToken: plan.body.confirmToken }) })
    assert.equal(disabled.status, 403)
    assert.equal(disabled.body.code, 'write_disabled')
    const disabledRb = await call({ method: 'POST', path: '/api/codex/config/rollback', body: { root: f.rootId, backupId: 'bk_' + 'a'.repeat(32), expectedSha256: 'x', confirmToken: 'x' } })
    assert.equal(disabledRb.status, 403)
    assert.equal(disabledRb.body.code, 'write_disabled')

    const roPlan = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(ro) })
    assert.equal(roPlan.status, 200)
    const roApply = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(ro, { expected: roPlan.body.before, confirmToken: roPlan.body.confirmToken }) })
    assert.equal(roApply.status, 403)
    assert.equal(roApply.body.code, 'write_disabled')
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG, 'both files untouched')
  } finally { await f.cleanup(); await ro.cleanup() }
})

test('写接口门禁：缺 expected / 缺/错 confirmToken / 缺 adminSubject 一律拒绝且不写盘', async () => {
  const f = await fixture()
  try {
    const before = await readFile(f.path)
    const plan = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f) })
    const noExpected = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(f, { confirmToken: plan.body.confirmToken }) })
    assert.equal(noExpected.status, 400)
    assert.equal(noExpected.body.code, 'snapshot_required')
    const noToken = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(f, { expected: plan.body.before }) })
    assert.equal(noToken.status, 400)
    assert.equal(noToken.body.code, 'confirmation_required')
    const wrongToken = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(f, { expected: plan.body.before, confirmToken: 'deadbeef' }) })
    assert.equal(wrongToken.status, 400)
    assert.equal(wrongToken.body.code, 'confirmation_required')
    const noSubject = await callW({ method: 'POST', path: '/api/codex/config/apply', adminSubject: '', body: planBody(f, { expected: plan.body.before, confirmToken: plan.body.confirmToken }) })
    assert.equal(noSubject.status, 403)
    assert.equal(noSubject.body.code, 'admin_subject_required')
    assert.deepEqual(await readFile(f.path), before)
    assert.deepEqual((await readdir(f.dir)).sort(), ['config.toml'], 'no backup/tmp on rejected writes')
  } finally { await f.cleanup() }
})

test('apply：预览后外部修改 ⇒ 409 且不写（hash/size/mtime 二次快照）', async () => {
  const f = await fixture()
  try {
    const plan = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f) })
    await writeFile(f.path, USER_CONFIG + '\n# 外部程序写入\n', 'utf8')
    const out = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(f, { expected: plan.body.before, confirmToken: plan.body.confirmToken }) })
    assert.equal(out.status, 409)
    assert.equal(out.body.code, 'concurrent_modification')
    const text = await readFile(f.path, 'utf8')
    assert.ok(text.includes('外部程序写入'), 'external edit survives')
    assert.ok(!text.includes('mg/gpt-5-aggregate'), 'no partial write')
  } finally { await f.cleanup() }
})

test('apply → 成功写入 + 不透明 backupId + 可回滚令牌；rollback 完全恢复', async () => {
  const f = await fixture()
  try {
    const log = fakeLog()
    const plan = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f), log })
    const applied = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(f, { expected: plan.body.before, confirmToken: plan.body.confirmToken }), log })
    assert.equal(applied.status, 200)
    assert.equal(applied.body.wrote, true)
    assert.match(String(applied.body.backupId), /^bk_[a-f0-9]{32}$/)
    assert.equal(JSON.stringify(applied.body).includes('backupPath'), false, 'must not return filesystem paths')
    assert.equal(JSON.stringify(applied.body).includes(f.path), false)
    assert.equal(await readFile(f.path + '.bak', 'utf8'), USER_CONFIG)
    const written = await readFile(f.path, 'utf8')
    assert.equal(sha256Hex(written), applied.body.after.sha256)
    assert.ok(written.includes('openai_base_url = "http://127.0.0.1:8787"'))
    assert.ok(written.includes('[mcp_servers.docs]'), 'MCP section preserved')
    assert.ok(applied.body.rollback && applied.body.rollback.confirmToken)
    assert.equal(applied.body.rollback.backupId, applied.body.backupId)
    assert.equal(applied.body.rollback.expectedSha256, applied.body.after.sha256)
    const rolled = await callW({
      method: 'POST',
      path: '/api/codex/config/rollback',
      body: {
        root: f.rootId,
        backupId: applied.body.rollback.backupId,
        expectedSha256: applied.body.rollback.expectedSha256,
        confirmToken: applied.body.rollback.confirmToken,
      },
      log,
    })
    assert.equal(rolled.status, 200)
    assert.equal(rolled.body.wrote, true)
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG)
    assert.match(String(rolled.body.safetyBackupId), /^bk_[a-f0-9]{32}$/)
    // 审计只记 action/root/字段/结果；不含内容、路径、令牌、hash
    const auditLines = log.lines.filter((l) => l.startsWith('audit codex'))
    assert.ok(auditLines.some((l) => l.includes('config_apply') && l.includes('result=ok') && l.includes('root=' + f.rootId)))
    assert.ok(auditLines.some((l) => l.includes('config_plan')))
    assert.ok(auditLines.some((l) => l.includes('config_rollback')))
    for (const line of log.lines) {
      assert.equal(line.includes('file-only-marker-9f2c'), false, 'audit must not contain file content')
      assert.equal(line.includes('sk-SENTINEL'), false, 'audit must not contain secrets')
      assert.equal(line.includes(plan.body.confirmToken), false, 'audit must not contain confirm tokens')
      assert.equal(line.includes(applied.body.after.sha256), false, 'audit must not contain file hashes')
      assert.equal(line.includes(f.path), false, 'audit must not contain filesystem paths')
    }
  } finally { await f.cleanup() }
})

test('confirmToken 绑定：跨文件 / 跨操作 / 过期 / 重复使用一律拒绝', async () => {
  const a = await fixture()
  const b = await fixture()
  try {
    // 跨文件：a 的 plan 令牌拿去 apply b（用 b 自己的 expected，确保先过快照校验）
    const planA = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(a) })
    const planB = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(b) })
    const crossFile = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(b, { expected: planB.body.before, confirmToken: planA.body.confirmToken }) })
    assert.equal(crossFile.status, 409)
    assert.equal(crossFile.body.code, 'confirmation_binding_mismatch')

    // 跨操作：apply 的令牌拿去 rollback
    const applied = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(a, { expected: planA.body.before, confirmToken: planA.body.confirmToken }) })
    assert.equal(applied.status, 200)
    // 新签一个 apply 作用域的令牌，拿去做 rollback：令牌仍有效，但操作类型不匹配。
    const planCrossOp = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(a) })
    const crossOp = await callW({ method: 'POST', path: '/api/codex/config/rollback', body: { root: a.rootId, backupId: applied.body.backupId, expectedSha256: applied.body.after.sha256, confirmToken: planCrossOp.body.confirmToken } })
    assert.equal(crossOp.status, 409)
    assert.equal(crossOp.body.code, 'confirmation_binding_mismatch')

    // 过期：注入时钟，plan 之后超过 TTL
    const now = 1000
    const planExp = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(b), now })
    const expired = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(b, { expected: planExp.body.before, confirmToken: planExp.body.confirmToken }), now: now + CONFIRM_TTL_MS + 1 })
    assert.equal(expired.status, 400)
    assert.equal(expired.body.code, 'confirmation_expired')

    // 重复使用：成功 apply 后同一令牌再用于新的 plan/expected
    const plan2 = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(b) })
    const applied2 = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(b, { expected: plan2.body.before, confirmToken: plan2.body.confirmToken }) })
    assert.equal(applied2.status, 200)
    const reusePlan = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(b) })
    const reuse = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(b, { expected: reusePlan.body.before, confirmToken: plan2.body.confirmToken }) })
    assert.equal(reuse.status, 400)
    assert.equal(reuse.body.code, 'confirmation_required')
  } finally { await a.cleanup(); await b.cleanup() }
})

test('rollback 门禁：路径/绝对 backupId/未知 id/跨根 backup 一律拒绝', async () => {
  const a = await fixture()
  const b = await fixture()
  try {
    const planA = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(a) })
    const applied = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(a, { expected: planA.body.before, confirmToken: planA.body.confirmToken }) })
    const token = applied.body.rollback.confirmToken
    const pathBody = await callW({ method: 'POST', path: '/api/codex/config/rollback', body: { root: a.rootId, backupPath: '/etc/passwd', confirmToken: token } })
    assert.equal(pathBody.status, 400)
    assert.equal(pathBody.body.code, 'path_not_allowed')
    const absId = await callW({ method: 'POST', path: '/api/codex/config/rollback', body: { root: a.rootId, backupId: '/etc/passwd', expectedSha256: applied.body.after.sha256, confirmToken: token } })
    assert.equal(absId.status, 400)
    assert.equal(absId.body.code, 'invalid_backup_id')
    const unknown = await callW({ method: 'POST', path: '/api/codex/config/rollback', body: { root: a.rootId, backupId: 'bk_' + 'f'.repeat(32), expectedSha256: applied.body.after.sha256, confirmToken: token } })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.code, 'backup_not_found')
    // 跨根：用 a 的 backupId 在 b 上回滚（b 也有一个 backup，避免落成 backup_not_found）
    const planB = await callW({ method: 'POST', path: '/api/codex/config/plan', body: planBody(b) })
    const appliedB = await callW({ method: 'POST', path: '/api/codex/config/apply', body: planBody(b, { expected: planB.body.before, confirmToken: planB.body.confirmToken }) })
    const crossRoot = await callW({ method: 'POST', path: '/api/codex/config/rollback', body: { root: b.rootId, backupId: applied.body.backupId, expectedSha256: appliedB.body.after.sha256, confirmToken: appliedB.body.rollback.confirmToken } })
    assert.equal(crossRoot.status, 403)
    assert.equal(crossRoot.body.code, 'backup_scope_mismatch')
  } finally { await a.cleanup(); await b.cleanup() }
})

test('GET /config/export：只回所拥有字段的归一化投影（无保留行/无凭据/无原文）', async () => {
  const f = await fixture()
  try {
    const out = await call({ method: 'GET', path: '/api/codex/config/export', query: { root: f.rootId } })
    assert.equal(out.status, 200)
    assert.equal(out.body.readOnly, true)
    assert.equal(out.body.fullFileReturned, false)
    assert.equal(out.body.retainedLinesReturned, false)
    assert.equal(out.body.owned.topLevel.model.value, 'gpt-5')
    assert.equal(out.body.owned.topLevel.openai_base_url.present, false)
    assert.equal(out.body.owned.sections.features.present, false)
    const text = JSON.stringify(out.body)
    for (const sentinel of ['sk-SENTINEL-MCP', 'sk-SENTINEL-AUTH', 'model_provider =', 'model = "gpt-5"', 'file-only-marker-9f2c']) {
      assert.equal(text.includes(sentinel), false, 'export must not leak: ' + sentinel)
    }
    assert.equal(out.body.generation, sha256Hex(USER_CONFIG))
    const bad = await call({ method: 'GET', path: '/api/codex/config/export', query: { root: '../x' } })
    assert.equal(bad.status, 400)
  } finally { await f.cleanup() }
})

test('不存在 / allowCreate：默认 404，显式放行才创建（受控 managed 根）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-api-new-'))
  const path = join(dir, 'config.toml')
  try {
    const rootId = nextRootId()
    registerConfigRoot({ id: rootId, path, mode: 'managed' })
    const missing = await callW({ method: 'POST', path: '/api/codex/config/plan', body: { root: rootId, desired: DESIRED } })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'config_not_found')
    assert.deepEqual(await readdir(dir), [])
    const plan = await callW({ method: 'POST', path: '/api/codex/config/plan', body: { root: rootId, desired: DESIRED, allowCreate: true } })
    assert.equal(plan.status, 200)
    assert.equal(plan.body.before.exists, false)
    const applied = await callW({ method: 'POST', path: '/api/codex/config/apply', body: { root: rootId, desired: DESIRED, expected: plan.body.before, confirmToken: plan.body.confirmToken, allowCreate: true } })
    assert.equal(applied.status, 200)
    assert.equal(applied.body.backupId, null)
    assert.match(await readFile(path, 'utf8'), /^model_provider = "openai"$/m)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('请求体解析：支持 ctx.body / JSON 字符串 / rawBody Buffer；坏 JSON 400', async () => {
  const f = await fixture()
  try {
    const a = await call({ method: 'POST', path: '/api/codex/config/plan', body: JSON.stringify(planBody(f)) })
    assert.equal(a.status, 200)
    const b = await call({ method: 'POST', path: '/api/codex/config/plan', rawBody: Buffer.from(JSON.stringify(planBody(f)), 'utf8') })
    assert.equal(b.status, 200)
    const bad = await call({ method: 'POST', path: '/api/codex/config/plan', rawBody: Buffer.from('{oops', 'utf8') })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'invalid_body')
    const none = await call({ method: 'POST', path: '/api/codex/config/plan' })
    assert.equal(none.status, 400)
    const arr = await call({ method: 'POST', path: '/api/codex/config/plan', body: '[1,2]' })
    assert.equal(arr.status, 400)
  } finally { await f.cleanup() }
})

test('desired 所有权：非声明字段 400，非对象 400，多行值 400', async () => {
  const f = await fixture()
  const multi = await fixture('model = [\n  "a",\n]\n')
  try {
    const nonOwned = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f, { desired: { topLevel: { approval_policy: 'never' } } }) })
    assert.equal(nonOwned.status, 400)
    assert.equal(nonOwned.body.code, 'not_owned_field')
    const notObject = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f, { desired: ['x'] }) })
    assert.equal(notObject.status, 400)
    assert.equal(notObject.body.code, 'invalid_body')
    const section = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f, { desired: { sections: { features: { multi_agent_v2: true } } } }) })
    assert.equal(section.status, 200)
    assert.ok(section.body.changed.some((c) => c.field === 'features.multi_agent_v2'))
    const bad = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(multi, { desired: { topLevel: { model: 'b' } } }) })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'multiline_value')
  } finally { await f.cleanup(); await multi.cleanup() }
})

test('日志函数缺失时不影响响应（不依赖 ctx.log）', async () => {
  const f = await fixture()
  try {
    const out = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f), log: undefined })
    assert.equal(out.status, 200)
    const throwing = { info () { throw new Error('log down') } }
    const out2 = await call({ method: 'POST', path: '/api/codex/config/plan', body: planBody(f), log: throwing })
    assert.equal(out2.status, 200)
  } finally { await f.cleanup() }
})

test('summarizeCodexCatalog：limit 夹紧与缺字段容错', () => {
  const s = summarizeCodexCatalog({ _codexCatalog: { models: [], bindings: {}, officialSlugs: ['a'] } }, { limit: 0 })
  assert.equal(s.limit, 50)
  assert.equal(summarizeCodexCatalog({ _codexCatalog: { models: [], bindings: {}, officialSlugs: ['a'] } }, { limit: 5000 }).limit, 200)
  const broken = summarizeCodexCatalog({ defaults: { codexCatalogBasePath: '/x/base.json' }, _codexCatalog: { key: '', models: null, bindings: null, officialSlugs: null } })
  assert.equal(broken.available, true)
  assert.deepEqual(broken.counts, { official: 0, thirdParty: 0, total: 0 })
  assert.equal(broken.generation.length, 12)
  assert.equal(broken.stale, null)
  assert.equal(MAX_DIFF_ROWS > 0, true)
})

// —— UI 侧探测（src/ui-next/js/views/codex.js）：用 stub fetch，不联网 ——
import * as uiCodex from '../../../src/ui-next/js/views/codex.js'

function stubFetch (impl) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  return () => { globalThis.fetch = real }
}

function jsonResponse (body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('UI 探测：/api/codex/policy 成功 → 写入/世代/所有权改用服务端声明', async () => {
  uiCodex.resetCodexApiProbe()
  let calls = 0
  const restore = stubFetch(async (url, opts) => {
    calls++
    assert.match(String(url), /\/api\/codex\/policy$/)
    assert.ok(opts && opts.headers, 'request must go through the shared api client (accept header)')
    return jsonResponse({
      ok: true,
      contract: 'mg-codex-api/1',
      routes: [
        { method: 'GET', path: '/api/codex/policy' },
        { method: 'POST', path: '/api/codex/config/plan' },
        { method: 'POST', path: '/api/codex/config/apply' },
        { method: 'POST', path: '/api/codex/config/rollback' },
      ],
      catalog: { available: true, generation: 'abc123def456', counts: { official: 2, thirdParty: 1, total: 3 }, stale: false, officialSlugs: ['gpt-5'] },
      policy: { ownedTopLevel: ['model_provider', 'openai_base_url', 'model', 'model_catalog_json'], ownedSections: { features: ['multi_agent', 'multi_agent_v2'] }, reservedOverrideSections: ['model_providers.openai'] },
    })
  })
  try {
    const probe = await uiCodex.probeCodexPolicy({ force: true })
    assert.equal(calls, 1)
    assert.equal(probe.available, true)
    assert.equal(probe.apply, true)
    assert.equal(probe.plan, true)
    assert.equal(probe.rollback, true)
    assert.equal(probe.contract, 'mg-codex-api/1')

    const write = uiCodex.writePathState({})
    assert.equal(write.ready, true)
    assert.match(write.label, /服务端受控写入就绪/)
    assert.equal(write.kind, 'good')

    const cat = uiCodex.catalogState({})
    assert.equal(cat.known, true)
    assert.equal(cat.label, 'GEN abc123def456')
    assert.deepEqual(cat.counts, { official: 2, thirdParty: 1, total: 3 })
    assert.equal(cat.stale, false)

    const rows = uiCodex.ownershipRows()
    assert.ok(rows.some((r) => r.path === 'openai_base_url' && r.owner === 'modelgate'))
    assert.ok(rows.some((r) => r.path === 'features.multi_agent_v2' && r.owner === 'modelgate'))
    assert.ok(rows.some((r) => r.path === '[model_providers.openai]' && r.owner === 'external-forbidden'))
    assert.ok(rows.some((r) => r.path === 'auth.json' && r.owner === 'external-forbidden'))

    await uiCodex.probeCodexPolicy()
    assert.equal(calls, 1, 'cached probe must not refetch within TTL')
    await uiCodex.probeCodexPolicy({ force: true })
    assert.equal(calls, 2)
  } finally {
    restore()
    uiCodex.resetCodexApiProbe()
  }
})

test('UI 探测失败：401/403/404/网络错误 → 回落 export-only，不抛错不编造', async () => {
  for (const [status, reason] of [[401, 'unauthorized'], [403, 'remote_forbidden'], [404, 'not_mounted']]) {
    uiCodex.resetCodexApiProbe()
    const restore = stubFetch(async () => jsonResponse({ error: 'x' }, status))
    try {
      const probe = await uiCodex.probeCodexPolicy({ force: true })
      assert.equal(probe.available, false)
      assert.equal(probe.reason, reason)
      const write = uiCodex.writePathState({})
      assert.equal(write.ready, false)
      assert.match(write.label, /仅导出/)
      const cat = uiCodex.catalogState({})
      assert.equal(cat.known, false)
      assert.equal(cat.label, 'UNKNOWN')
      assert.ok(uiCodex.ownershipRows().length >= 5)
    } finally {
      restore()
      uiCodex.resetCodexApiProbe()
    }
  }
  uiCodex.resetCodexApiProbe()
  const restore = stubFetch(async () => { throw new TypeError('fetch failed') })
  try {
    const probe = await uiCodex.probeCodexPolicy({ force: true })
    assert.equal(probe.available, false)
    assert.equal(probe.reason, 'unreachable')
    assert.match(probe.detail, /只导出/)
  } finally {
    restore()
    uiCodex.resetCodexApiProbe()
  }
})

test('UI 探测：服务端只给部分路由时仍标记仅导出', async () => {
  uiCodex.resetCodexApiProbe()
  const restore = stubFetch(async () => jsonResponse({ ok: true, contract: 'mg-codex-api/1', routes: [{ path: '/api/codex/policy' }, { path: '/api/codex/config/plan' }], catalog: { available: false, reason: 'not_configured' } }))
  try {
    const probe = await uiCodex.probeCodexPolicy({ force: true })
    assert.equal(probe.available, true)
    assert.equal(probe.apply, false)
    const write = uiCodex.writePathState({})
    assert.equal(write.ready, false)
    assert.match(write.label, /部分就绪/)
    const cat = uiCodex.catalogState({})
    assert.equal(cat.known, false)
    assert.match(cat.detail, /codexCatalogBasePath/)
  } finally {
    restore()
    uiCodex.resetCodexApiProbe()
  }
})
