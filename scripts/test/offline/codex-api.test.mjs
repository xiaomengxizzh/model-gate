// E6 管理面 /api/codex/* 的离线契约测试。
// 直接调用 handleCodexApi(ctx)，不起网关、不占端口、不读 HOME；配置 fixture 全在 OS 临时目录。
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
  resolveLocality,
  summarizeCodexCatalog,
  validateCodexConfigPath,
} from '../../../src/codex/api.js'
import { sha256Hex } from '../../../src/codex/config.js'

const USER_CONFIG = [
  '# 用户自己的 Codex 配置（测试 fixture，临时目录）',
  '# 下面这条注释含一个只会出现在文件里的标记：file-only-marker-9f2c',
  'model = "gpt-5"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
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

async function fixture (text = USER_CONFIG) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-api-'))
  const path = join(dir, 'config.toml')
  await writeFile(path, text, 'utf8')
  return { dir, path, text, cleanup: async () => { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }) } }
}

function fakeLog () {
  const lines = []
  return { lines, info (s) { lines.push(String(s)) }, warn (s) { lines.push(String(s)) } }
}

function call (ctx = {}) {
  return handleCodexApi(Object.assign({ requireAdmin: () => true, isLocal: true }, ctx))
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

test('路由清单与挂载谓词', () => {
  assert.equal(CODEX_API_CONTRACT, 'mg-codex-api/1')
  assert.deepEqual(CODEX_API_ROUTES.map((r) => r.method + ' ' + r.path), [
    'GET /api/codex/policy',
    'POST /api/codex/config/plan',
    'POST /api/codex/config/apply',
    'POST /api/codex/config/rollback',
    'GET /api/codex/catalog/status',
  ])
  assert.equal(isCodexApiPath('/api/codex'), true)
  assert.equal(isCodexApiPath('/api/codex/policy'), true)
  assert.equal(isCodexApiPath('/api/codex/policy?x=1'), true)
  assert.equal(isCodexApiPath('/api/codexx'), false)
  assert.equal(isCodexApiPath('/api/status'), false)
  assert.equal(isCodexApiPath('/v1/models'), false)
  // 只有两个写接口
  assert.deepEqual(CODEX_API_ROUTES.filter((r) => r.write).map((r) => r.path), ['/api/codex/config/apply', '/api/codex/config/rollback'])
})

test('鉴权：未注入 requireAdmin 且无 isAdmin → 401；缺令牌/空返回 → 401', async () => {
  const contexts = [
    { method: 'GET', path: '/api/codex/policy' },
    { method: 'GET', path: '/api/codex/policy', requireAdmin: () => false },
    { method: 'GET', path: '/api/codex/policy', requireAdmin: async () => false },
    { method: 'GET', path: '/api/codex/policy', requireAdmin: () => undefined },
    { method: 'GET', path: '/api/codex/policy', requireAdmin: () => { throw new Error('boom') } },
    { method: 'GET', path: '/api/codex/policy', isAdmin: false },
    { method: 'POST', path: '/api/codex/config/plan', requireAdmin: () => false, body: { path: '/tmp/x/config.toml', desired: DESIRED } },
  ]
  for (const ctx of contexts) {
    const out = await handleCodexApi(ctx)
    assert.equal(out.status, 401, JSON.stringify(ctx))
    assert.equal(out.body.code, 'unauthorized')
    assert.equal(out.body.ok, false)
  }
})

test('鉴权：注入函数已写响应（headersSent）时返回 null，不二次写头', async () => {
  const out = await handleCodexApi({
    method: 'GET',
    path: '/api/codex/policy',
    requireAdmin: () => false,
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
  assert.equal(resolveLocality({}).local, true, 'unknown address → 不阻断（令牌仍强制）')
  assert.equal(resolveLocality({ allowRemote: true, remoteAddress: '10.0.0.9' }).local, true)

  const remote = await handleCodexApi({ method: 'GET', path: '/api/codex/policy', requireAdmin: () => true, isLocal: false })
  assert.equal(remote.status, 403)
  assert.equal(remote.body.code, 'remote_forbidden')
  const remote2 = await handleCodexApi({ method: 'GET', path: '/api/codex/policy', requireAdmin: () => true, remoteAddress: '192.168.1.20' })
  assert.equal(remote2.status, 403)
  const local = await handleCodexApi({ method: 'GET', path: '/api/codex/policy', requireAdmin: () => true, remoteAddress: '127.0.0.1' })
  assert.equal(local.status, 200)
})

test('未知路由 404、方法不匹配 405（鉴权之后才暴露）', async () => {
  const unknown = await call({ method: 'GET', path: '/api/codex/nope' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.code, 'unknown_endpoint')
  const wrongMethod = await call({ method: 'GET', path: '/api/codex/config/plan' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.body.code, 'method_not_allowed')
  // 未鉴权时先 401，不暴露路由是否存在
  const unauth = await handleCodexApi({ method: 'GET', path: '/api/codex/nope' })
  assert.equal(unauth.status, 401)
})

test('GET /api/codex/policy：所有权 + 目录摘要 + 写路由，且不含全量目录正文', async () => {
  const out = await call({ method: 'GET', path: '/api/codex/policy', cfg: cfgWithCatalog() })
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.contract, CODEX_API_CONTRACT)
  const p = out.body.policy
  assert.deepEqual(p.ownedTopLevel, ['model_provider', 'openai_base_url', 'model', 'model_catalog_json'])
  assert.deepEqual(p.reservedOverrideSections, ['model_providers.openai'])
  assert.ok(p.guarantees.includes('never-writes-auth-json'))
  assert.equal(out.body.write.available, true)
  assert.equal(out.body.write.restartsClient, false)
  assert.equal(out.body.auth.adminRequired, true)
  assert.equal(out.body.auth.localOnly, true)
  assert.equal(out.body.paths.requiredBasename, 'config.toml')
  assert.deepEqual(out.body.routes.map((r) => r.path).length, 5)
  assert.equal(out.body.catalog.available, true)
  assert.deepEqual(out.body.catalog.counts, { official: 1, thirdParty: 1, total: 2 })
  // 绝不回 700KB 目录正文
  const text = JSON.stringify(out.body)
  assert.ok(!text.includes('base_instructions'), 'must not leak model metadata blobs')
  assert.ok(text.length < 12000, 'policy payload too large: ' + text.length)
})

test('GET /api/codex/policy：没有 cfg/目录也能稳定返回（不编造）', async () => {
  const out = await call({ method: 'GET', path: '/api/codex/policy' })
  assert.equal(out.status, 200)
  assert.equal(out.body.catalog.available, false)
  assert.equal(out.body.catalog.reason, 'not_configured')
  assert.equal(out.body.catalog.generation, null)
  assert.deepEqual(out.body.catalog.officialSlugs, [])
  const configured = await call({ method: 'GET', path: '/api/codex/policy', cfg: { defaults: { codexCatalogBasePath: '/tmp/missing.json' } } })
  assert.equal(configured.body.catalog.reason, 'catalog_unavailable')
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
  assert.equal(c.officialSlugs.length, 50, 'default limit 50')
  assert.equal(c.officialSlugsTruncated, true)
  assert.equal(c.officialSlugCount, 78)
  assert.deepEqual(c.thirdParty, [
    { slug: 'mg-a', provider: 'p1', model: 'x', capability: 'chat' },
    { slug: 'mg-b', provider: 'p2', model: 'y', capability: 'chat' },
  ])
  const text = JSON.stringify(out.body)
  assert.ok(!text.includes('base_instructions'), 'must not return catalog bodies')
  assert.ok(text.length < 20000)
  // limit 参数（query 对象 / query 字符串 / url 都支持），并夹紧到上限
  const small = await call({ method: 'GET', path: '/api/codex/catalog/status', query: { limit: '3' }, cfg })
  assert.equal(small.body.catalog.officialSlugs.length, 3)
  const fromUrl = await call({ method: 'GET', url: '/api/codex/catalog/status?limit=2', cfg })
  assert.equal(fromUrl.body.catalog.officialSlugs.length, 2)
  const clamped = await call({ method: 'GET', path: '/api/codex/catalog/status', query: 'limit=9999', cfg })
  assert.equal(clamped.body.catalog.officialSlugs.length, 78)
  const bad = await call({ method: 'GET', path: '/api/codex/catalog/status', query: { limit: 'abc' }, cfg })
  assert.equal(bad.body.catalog.officialSlugs.length, 50)
})

test('catalog stale 判定：用 view.key 与当前 stat 对比，不编造', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-cat-'))
  const base = join(dir, 'base.json')
  try {
    await writeFile(base, '{"models":[]}', 'utf8')
    const st = await stat(base)
    const view = {
      key: base + '|' + st.mtimeMs + '|' + st.size + '|[]',
      models: [{ slug: 'gpt-5' }],
      bindings: {},
      officialSlugs: ['gpt-5'],
    }
    const fresh = await call({ method: 'GET', path: '/api/codex/catalog/status', cfg: { defaults: { codexCatalogBasePath: base }, _codexCatalog: view } })
    assert.equal(fresh.body.catalog.stale, false)
    await writeFile(base, '{"models":[],"changed":true}', 'utf8')
    const stale = await call({ method: 'GET', path: '/api/codex/catalog/status', cfg: { defaults: { codexCatalogBasePath: base }, _codexCatalog: view } })
    assert.equal(stale.body.catalog.stale, true)
    // 文件消失 → null（不编造）
    await rm(base)
    const gone = await call({ method: 'GET', path: '/api/codex/catalog/status', cfg: { defaults: { codexCatalogBasePath: base }, _codexCatalog: view } })
    assert.equal(gone.body.catalog.stale, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('路径护栏：绝对路径 + config.toml，拒 auth.json/sessions/非 .toml/..', async () => {
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
  // 接口层同样拒绝（路径护栏在 config.js 之前生效）
  const f = await fixture()
  try {
    const auth = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: join(f.dir, 'auth.json'), desired: DESIRED } })
    assert.equal(auth.status, 403)
    assert.equal(auth.body.code, 'forbidden_path')
    const rel = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: 'config.toml', desired: DESIRED } })
    assert.equal(rel.status, 400)
    assert.equal(rel.body.code, 'invalid_path')
    const sessionsDir = join(f.dir, 'sessions')
    await (await import('node:fs/promises')).mkdir(sessionsDir)
    const sess = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: join(sessionsDir, 'config.toml'), desired: DESIRED } })
    assert.equal(sess.status, 403)
    assert.equal(sess.body.code, 'forbidden_path')
    const link = join(f.dir, 'link.toml')
    await symlink(f.path, join(f.dir, 'config-link.toml'))
    const linked = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: join(f.dir, 'config-link.toml'), desired: DESIRED } })
    assert.equal(linked.status, 400, '非 config.toml 名字先被路径护栏拒绝')
    void link
  } finally { await f.cleanup() }
})

test('符号链接的 config.toml：路径护栏放行名字、config.js 拒绝写入', async () => {
  const f = await fixture()
  const dir2 = await mkdtemp(join(tmpdir(), 'mg-codex-api-link-'))
  const link = join(dir2, 'config.toml')
  await symlink(f.path, link)
  try {
    const out = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: link, desired: DESIRED } })
    assert.equal(out.status, 403)
    assert.equal(out.body.code, 'symlink_refused')
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG, 'link target untouched')
  } finally {
    await rm(dir2, { recursive: true, force: true })
    await f.cleanup()
  }
})

test('POST /config/plan：只预览不写盘，返回 diff/所有权/confirmToken，不回正文', async () => {
  const f = await fixture()
  try {
    const before = await readFile(f.path)
    const out = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED } })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.wrote, false)
    assert.equal(typeof out.body.confirmToken, 'string')
    assert.equal(out.body.confirmToken.length, 64)
    assert.ok(Array.isArray(out.body.diff) && out.body.diff.length > 0)
    assert.ok(out.body.diff.every((r) => ['same', 'add', 'del'].includes(r.kind) && r.owner))
    assert.ok(out.body.changed.some((c) => c.path === 'openai_base_url'))
    assert.ok(out.body.existing.topLevel.model.raw === '"gpt-5"')
    assert.ok(!Object.prototype.hasOwnProperty.call(out.body, 'beforeText'))
    assert.ok(!Object.prototype.hasOwnProperty.call(out.body, 'afterText'))
    // 真的没写盘：字节与目录都没变
    assert.deepEqual(await readFile(f.path), before)
    assert.deepEqual((await readdir(f.dir)).sort(), ['config.toml'])
  } finally { await f.cleanup() }
})

test('POST /config/plan：空 desired 的 diff 全 same，且仍不发写入', async () => {
  const f = await fixture()
  try {
    const out = await call({
      method: 'POST',
      path: '/api/codex/config/plan',
      body: { path: f.path, desired: { topLevel: { model: 'gpt-5' } } },
    })
    assert.equal(out.status, 200)
    assert.deepEqual(out.body.changed, [])
    assert.ok(out.body.diff.every((r) => r.kind === 'same'))
  } finally { await f.cleanup() }
})

test('写接口门禁：缺 expected → 400，缺/错 confirmToken → 400，均不写盘', async () => {
  const f = await fixture()
  try {
    const before = await readFile(f.path)
    const plan = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED } })
    const noExpected = await call({ method: 'POST', path: '/api/codex/config/apply', body: { path: f.path, desired: DESIRED, confirmToken: plan.body.confirmToken } })
    assert.equal(noExpected.status, 400)
    assert.equal(noExpected.body.code, 'snapshot_required')
    const noToken = await call({ method: 'POST', path: '/api/codex/config/apply', body: { path: f.path, desired: DESIRED, expected: plan.body.before } })
    assert.equal(noToken.status, 400)
    assert.equal(noToken.body.code, 'confirmation_required')
    const wrongToken = await call({ method: 'POST', path: '/api/codex/config/apply', body: { path: f.path, desired: DESIRED, expected: plan.body.before, confirmToken: 'deadbeef' } })
    assert.equal(wrongToken.status, 400)
    assert.equal(wrongToken.body.code, 'confirmation_required')
    assert.deepEqual(await readFile(f.path), before)
    assert.deepEqual((await readdir(f.dir)).sort(), ['config.toml'], 'no backup/tmp on rejected writes')
  } finally { await f.cleanup() }
})

test('apply：并发冲突 409（预览后外部改文件），原文件不被覆盖', async () => {
  const f = await fixture()
  try {
    const plan = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED } })
    await writeFile(f.path, USER_CONFIG + '\n# 外部程序写入\n', 'utf8')
    const out = await call({
      method: 'POST',
      path: '/api/codex/config/apply',
      body: { path: f.path, desired: DESIRED, expected: plan.body.before, confirmToken: plan.body.confirmToken },
    })
    assert.equal(out.status, 409)
    assert.equal(out.body.code, 'concurrent_modification')
    const text = await readFile(f.path, 'utf8')
    assert.ok(text.includes('外部程序写入'), 'external edit survives')
    assert.ok(!text.includes('mg/gpt-5-aggregate'), 'no partial write')
  } finally { await f.cleanup() }
})

test('apply → 成功写入 + .bak + 可回滚令牌；rollback → 完全恢复', async () => {
  const f = await fixture()
  try {
    const log = fakeLog()
    const plan = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED }, log })
    const applied = await call({
      method: 'POST',
      path: '/api/codex/config/apply',
      body: { path: f.path, desired: DESIRED, expected: plan.body.before, confirmToken: plan.body.confirmToken },
      log,
    })
    assert.equal(applied.status, 200)
    assert.equal(applied.body.wrote, true)
    assert.equal(applied.body.after.sha256.length, 64)
    assert.equal(applied.body.backupPath, f.path + '.bak')
    assert.equal(await readFile(f.path + '.bak', 'utf8'), USER_CONFIG)
    const written = await readFile(f.path, 'utf8')
    assert.equal(sha256Hex(written), applied.body.after.sha256)
    assert.ok(written.includes('openai_base_url = "http://127.0.0.1:8787"'))
    assert.ok(written.includes('[mcp_servers.docs]'), 'MCP section preserved')
    // 返回的回滚令牌可直接用
    assert.ok(applied.body.rollback && applied.body.rollback.confirmToken)
    assert.equal(applied.body.rollback.backupPath, f.path + '.bak')
    assert.equal(applied.body.rollback.expectedSha256, applied.body.after.sha256)
    const rolled = await call({
      method: 'POST',
      path: '/api/codex/config/rollback',
      body: {
        path: f.path,
        backupPath: applied.body.rollback.backupPath,
        expectedSha256: applied.body.rollback.expectedSha256,
        confirmToken: applied.body.rollback.confirmToken,
      },
      log,
    })
    assert.equal(rolled.status, 200)
    assert.equal(rolled.body.wrote, true)
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG)
    // 审计只记 action/path/字段/结果，不含文件正文
    const auditLines = log.lines.filter((l) => l.startsWith('audit codex'))
    assert.ok(auditLines.some((l) => l.includes('config_apply') && l.includes('result=ok')))
    assert.ok(auditLines.some((l) => l.includes('config_plan')))
    assert.ok(auditLines.some((l) => l.includes('config_rollback')))
    assert.ok(auditLines.some((l) => l.includes('fields=model,openai_base_url,model_catalog_json')), JSON.stringify(auditLines))
    for (const line of log.lines) {
      assert.ok(!line.includes('file-only-marker-9f2c'), 'audit must not contain file content')
      assert.ok(!line.includes(plan.body.confirmToken), 'audit must not contain confirm tokens')
      assert.ok(!line.includes(applied.body.after.sha256), 'audit must not contain file hashes')
    }
  } finally { await f.cleanup() }
})

test('rollback 门禁：缺令牌 400、备份路径越界 400、备份不存在 404', async () => {
  const f = await fixture()
  try {
    const noToken = await call({ method: 'POST', path: '/api/codex/config/rollback', body: { path: f.path, backupPath: f.path + '.bak', expectedSha256: sha256Hex(USER_CONFIG) } })
    assert.equal(noToken.status, 400)
    assert.equal(noToken.body.code, 'confirmation_required')
    const outside = await call({ method: 'POST', path: '/api/codex/config/rollback', body: { path: f.path, backupPath: '/etc/passwd', confirmToken: 'x' } })
    assert.equal(outside.status, 400)
    assert.equal(outside.body.code, 'invalid_path')
    const missing = await call({ method: 'POST', path: '/api/codex/config/rollback', body: { path: f.path, backupPath: f.path + '.bak', expectedSha256: sha256Hex(USER_CONFIG), confirmToken: 'x' } })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'backup_not_found')
  } finally { await f.cleanup() }
})

test('desired 所有权：非声明字段 400，非对象 400，多行值 400', async () => {
  const f = await fixture()
  try {
    const nonOwned = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: { topLevel: { approval_policy: 'never' } } } })
    assert.equal(nonOwned.status, 400)
    assert.equal(nonOwned.body.code, 'not_owned_field')
    const notObject = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: ['x'] } })
    assert.equal(notObject.status, 400)
    assert.equal(notObject.body.code, 'invalid_body')
    const section = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: { sections: { features: { multi_agent_v2: true } } } } })
    assert.equal(section.status, 200)
    assert.ok(section.body.changed.some((c) => c.path === 'features.multi_agent_v2'))
    const multi = await fixture('model = [\n  "a",\n]\n')
    try {
      const bad = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: multi.path, desired: { topLevel: { model: 'b' } } } })
      assert.equal(bad.status, 400)
      assert.equal(bad.body.code, 'multiline_value')
    } finally { await multi.cleanup() }
  } finally { await f.cleanup() }
})

test('不存在 / allowCreate：默认 404，显式放行才创建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-api-new-'))
  const path = join(dir, 'config.toml')
  try {
    const missing = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path, desired: DESIRED } })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'config_not_found')
    assert.deepEqual(await readdir(dir), [])
    const plan = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path, desired: DESIRED, allowCreate: true } })
    assert.equal(plan.status, 200)
    assert.equal(plan.body.before.exists, false)
    const applied = await call({ method: 'POST', path: '/api/codex/config/apply', body: { path, desired: DESIRED, expected: plan.body.before, confirmToken: plan.body.confirmToken, allowCreate: true } })
    assert.equal(applied.status, 200)
    assert.equal(applied.body.backupPath, null)
    assert.match(await readFile(path, 'utf8'), /^model_provider = "openai"$/m)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('请求体解析：支持 ctx.body / JSON 字符串 / rawBody Buffer；坏 JSON 400', async () => {
  const f = await fixture()
  try {
    const a = await call({ method: 'POST', path: '/api/codex/config/plan', body: JSON.stringify({ path: f.path, desired: DESIRED }) })
    assert.equal(a.status, 200)
    const b = await call({ method: 'POST', path: '/api/codex/config/plan', rawBody: Buffer.from(JSON.stringify({ path: f.path, desired: DESIRED }), 'utf8') })
    assert.equal(b.status, 200)
    const bad = await call({ method: 'POST', path: '/api/codex/config/plan', rawBody: Buffer.from('{oops', 'utf8') })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'invalid_body')
    const none = await call({ method: 'POST', path: '/api/codex/config/plan' })
    assert.equal(none.status, 400)
    assert.equal(none.body.code, 'invalid_body')
    const arr = await call({ method: 'POST', path: '/api/codex/config/plan', body: '[1,2]' })
    assert.equal(arr.status, 400)
  } finally { await f.cleanup() }
})

test('大 diff 截断：超过 MAX_DIFF_ROWS 时标记 truncated 且不超限', async () => {
  const lines = new Array(1200).fill(0).map((_, i) => '# filler line ' + i)
  const big = ['model = "gpt-5"', 'model_provider = "openai"', ...lines, ''].join('\n')
  const f = await fixture(big)
  try {
    const out = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED } })
    assert.equal(out.status, 200)
    assert.equal(out.body.diff.length, MAX_DIFF_ROWS)
    assert.equal(out.body.diffTruncated, true)
    assert.ok(out.body.diffTotal >= 1200)
  } finally { await f.cleanup() }
})

test('日志函数缺失时不影响响应（不依赖 ctx.log）', async () => {
  const f = await fixture()
  try {
    const out = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED }, log: undefined })
    assert.equal(out.status, 200)
    const throwing = { info () { throw new Error('log down') } }
    const out2 = await call({ method: 'POST', path: '/api/codex/config/plan', body: { path: f.path, desired: DESIRED }, log: throwing })
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

    // TTL 内命中缓存，不重复请求
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
      // 服务端不可用时退回本地常量（不是空表）
      assert.ok(uiCodex.ownershipRows().length >= 5)
    } finally {
      restore()
      uiCodex.resetCodexApiProbe()
    }
  }
  // 完全不联网：网络错误也不抛
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
