import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getProviderTemplate, listProviderTemplates, templateStats, TEMPLATE_STATUSES } from '../../../src/resources/templates.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SOURCE = join(ROOT, 'src/resources/templates.js')
const FIXTURE = join(ROOT, 'docs/evidence/v13.1-r2/input/01-原型与目录/modelgate-v12-provider-catalog.json')
const SECRET_SENTINEL = 'mg-template-test-secret-3f95c2'

function allItems(opts = {}) {
  const pages = []
  let cursor
  do {
    const page = listProviderTemplates({ ...opts, limit: 7, cursor })
    pages.push(...page.items)
    cursor = page.nextCursor
    assert.ok(pages.length <= page.total)
  } while (cursor)
  return pages
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes(SECRET_SENTINEL), false)
  const visit = (entry) => {
    if (Array.isArray(entry)) return entry.forEach(visit)
    if (!entry || typeof entry !== 'object') return
    for (const [key, child] of Object.entries(entry)) {
      assert.doesNotMatch(key, /^(?:apiKey|accessToken|refreshToken|clientSecret|authorization|password|secret|credential|credentialRef)$/i)
      visit(child)
    }
  }
  visit(value)
}

async function rejectsFixture(label, mutate, pattern) {
  const root = mkdtempSync(join(tmpdir(), 'mg-v13-templates-'))
  try {
    const modulePath = join(root, 'src/resources/templates.js')
    const fixturePath = join(root, 'docs/evidence/v13.1-r2/input/01-原型与目录/modelgate-v12-provider-catalog.json')
    mkdirSync(dirname(modulePath), { recursive: true })
    mkdirSync(dirname(fixturePath), { recursive: true })
    copyFileSync(SOURCE, modulePath)
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    mutate(fixture)
    writeFileSync(fixturePath, JSON.stringify(fixture))
    await assert.rejects(import(pathToFileURL(modulePath).href), pattern, label)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('模板资源：固定快照校验 63 个模板、87 个模型示例与版本化字段', () => {
  const stats = templateStats()
  assert.equal(stats.totalTemplates, 63)
  assert.equal(stats.totalModelExamples, 87)
  assert.equal(stats.catalogVersion, '2026-11-24')
  assert.equal(stats.catalogSha256, '1a2a160dd39142488f340f3dcb147616314ffad89a03abc9f7472bd0a2eb08ba')
  assert.equal(stats.validated, true)
  assert.equal(stats.productionEnabled, 0)
  assert.deepEqual(stats.byStatus, {
    'official-native-boundary': 1,
    'existing-adapter-unverified': 1,
    'planned-unverified': 61,
  })
  assert.equal(Object.values(stats.byCategory).reduce((a, b) => a + b, 0), 63)
  assert.equal(Object.values(stats.byRegion).reduce((a, b) => a + b, 0), 63)

  const items = listProviderTemplates({ limit: 100 }).items
  assert.equal(items.length, 63)
  assert.equal(new Set(items.map((item) => item.templateId)).size, 63)
  assert.equal(items.reduce((total, item) => total + item.modelsExample.length, 0), 87)
  for (const item of items) {
    assert.match(item.templateId, /^tpl_[a-z][a-z0-9-]{0,63}$/)
    assert.equal(item.version, 1)
    for (const field of ['category', 'region', 'authKind', 'protocol', 'discovery', 'docs', 'evidence']) assert.ok(item[field])
    assert.equal(typeof item.baseUrl, 'string')
    assert.ok(Array.isArray(item.modelsExample))
    assert.equal(item.enabled, false)
    assert.ok(TEMPLATE_STATUSES.includes(item.status))
    assert.equal(item.evidence.permissions, 'not-asserted')
    assert.equal(item.evidence.adapter.verified, false)
    assert.match(item.evidence.modelsExamplePolicy, /illustrative-only/)
    assert.match(item.evidence.sourceWarning, /not a production configuration/)
    assert.match(item.evidence.regionPolicy, /not an account region or availability permission/)
  }
})

test('模板资源：category/region/auth/status/query 过滤与组合', () => {
  const cn = listProviderTemplates({ category: '国内模型', region: 'cn', limit: 100 })
  assert.equal(cn.total, 14)
  assert.ok(cn.items.every((item) => item.category === '国内模型' && item.region === 'cn'))
  assert.deepEqual(listProviderTemplates({ region: 'local', limit: 100 }).items.map((item) => item.templateId), [
    'tpl_ollama', 'tpl_lmstudio', 'tpl_vllm', 'tpl_llamacpp', 'tpl_sglang', 'tpl_litellm', 'tpl_newapi', 'tpl_sub2api', 'tpl_compatible',
  ])
  assert.equal(getProviderTemplate('tpl_zai').region, 'global')
  assert.equal(getProviderTemplate('tpl_byteplus').region, 'global')
  assert.equal(listProviderTemplates({ auth: 'api-key', limit: 100 }).total, 40)
  assert.equal(listProviderTemplates({ authKind: 'subscription-api-key' }).total, 1)
  assert.deepEqual(listProviderTemplates({ status: 'official-native-boundary' }).items.map((item) => item.templateId), ['tpl_chatgptplan'])
  assert.deepEqual(listProviderTemplates({ query: 'deepseek-v4.1-flash' }).items.map((item) => item.templateId), ['tpl_opencodego'])
  assert.deepEqual(listProviderTemplates({ query: 'DEEPSEEK', category: '国内模型', limit: 100 }).items.map((item) => item.templateId), ['tpl_deepseek'])
  assert.equal(listProviderTemplates({ category: '国内模型', region: 'global', auth: 'api-key', status: 'planned-unverified', query: 'international-nomatch' }).total, 0)
})

test('模板资源：游标分页稳定、无重复，并绑定过滤条件', () => {
  const expected = listProviderTemplates({ limit: 100 }).items.map((item) => item.templateId)
  assert.deepEqual(allItems().map((item) => item.templateId), expected)
  const first = listProviderTemplates({ limit: 5 })
  assert.equal(first.items.length, 5)
  assert.ok(first.nextCursor)
  const second = listProviderTemplates({ limit: 5, cursor: first.nextCursor })
  assert.equal(second.items[0].templateId, expected[5])
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.templateId)).size, 10)
  const last = listProviderTemplates({ limit: 100, cursor: listProviderTemplates({ limit: 62 }).nextCursor })
  assert.deepEqual(last, { contract: 'mg-provider-templates/1', catalogVersion: '2026-11-24', items: [getProviderTemplate('tpl_compatible')], total: 63, limit: 100, nextCursor: null })
  assert.throws(() => listProviderTemplates({ category: '官方 API', cursor: first.nextCursor }), /does not match/)
  assert.throws(() => listProviderTemplates({ cursor: 'v1.not-a-cursor' }), /valid provider-template cursor/)
  for (const limit of [0, 101, 1.5, '5']) assert.throws(() => listProviderTemplates({ limit }), RangeError)
})

test('模板资源：未知 ID 返回 null，返回值防外部修改', () => {
  assert.equal(getProviderTemplate('missing'), null)
  assert.equal(getProviderTemplate('opencodego'), null)
  assert.equal(getProviderTemplate('__proto__'), null)
  assert.equal(getProviderTemplate(null), null)
  const first = getProviderTemplate('tpl_opencodego')
  first.modelsExample.push('injected')
  first.evidence.adapter.sources.push('injected')
  first.evidence.raw.id = 'injected'
  const second = getProviderTemplate('tpl_opencodego')
  assert.equal(second.modelsExample.includes('injected'), false)
  assert.equal(second.evidence.adapter.sources.includes('injected'), false)
  assert.equal(second.evidence.raw.id, 'opencodego')
  const listed = listProviderTemplates({ query: 'opencodego' })
  listed.items[0].evidence.adapter.sources.length = 0
  assert.ok(getProviderTemplate('tpl_opencodego').evidence.adapter.sources.length > 0)
})

test('模板资源：列表、详情、统计与错误均不暴露秘密', () => {
  const previous = process.env.MG_TEMPLATE_SECRET_SENTINEL
  process.env.MG_TEMPLATE_SECRET_SENTINEL = SECRET_SENTINEL
  try {
    assertNoSecrets(templateStats())
    assertNoSecrets(listProviderTemplates({ limit: 100 }))
    assertNoSecrets(getProviderTemplate('tpl_opencodego'))
    assertNoSecrets(getProviderTemplate('tpl_chatgptplan'))
    assert.throws(() => listProviderTemplates({ cursor: SECRET_SENTINEL }), (error) => {
      assertNoSecrets(error)
      return true
    })
  } finally {
    if (previous === undefined) delete process.env.MG_TEMPLATE_SECRET_SENTINEL
    else process.env.MG_TEMPLATE_SECRET_SENTINEL = previous
  }
})

test('Go 特殊证据：既有 adapter 机制可溯源但不声称模板或模型已验收', () => {
  const go = getProviderTemplate('tpl_opencodego')
  assert.equal(go.status, 'existing-adapter-unverified')
  assert.equal(go.evidence.level, 'existing-adapter-unverified')
  assert.equal(go.evidence.catalogStatus, '已有接入基础')
  assert.equal(go.evidence.adapter.status, 'existing-adapter-unverified')
  assert.equal(go.evidence.adapter.verified, false)
  assert.equal(go.baseUrl, 'https://opencode.ai/inference/go/openai/v1')
  assert.deepEqual(go.evidence.adapter.sources, [
    'src/providers/opencode-go.js',
    'src/aggregation/registry.js',
    'src/aggregation/discovery.js',
  ])
  assert.deepEqual(go.evidence.adapter.reusableMechanisms, [
    'opencode-go-entry-binding',
    'host-allowlist',
    'declared-model-alias-mapping',
    'derived-session-header',
    'reasoning-effort-evidence-gate',
  ])
  assert.match(go.evidence.adapter.boundary, /does not verify the endpoint, account, models, quota, or live adapter behavior/)
  assert.equal(go.evidence.raw.protocol, 'Chat')
  assert.equal(go.protocol, 'openai-chat')
  assert.equal(go.enabled, false)

  const official = getProviderTemplate('tpl_chatgptplan')
  assert.equal(official.status, 'official-native-boundary')
  assert.equal(official.baseUrl, '')
  assert.equal(official.discovery, 'native-official-catalog')
  assert.equal(official.evidence.adapter.verified, false)
  assert.match(official.evidence.adapter.boundary, /not a generic API Key provider/)
  assert.equal(getProviderTemplate('tpl_openai').status, 'planned-unverified')
  assert.deepEqual(getProviderTemplate('tpl_openai').evidence.adapter.reusableMechanisms, [])
})

test('模板资源：拒绝重复 ID、未知协议、带凭据/不安全 URL 与错误总数', async () => {
  await rejectsFixture('duplicate ID', (fixture) => { fixture.providers[1].id = fixture.providers[0].id }, /duplicate_id/)
  await rejectsFixture('unknown protocol', (fixture) => { fixture.providers[0].api = 'Magic' }, /unsupported_protocol/)
  await rejectsFixture('URL credentials', (fixture) => { fixture.providers[1].url = 'https://user:password@opencode.ai/v1' }, /url_credentials_or_query/)
  await rejectsFixture('remote insecure URL', (fixture) => { fixture.providers[1].url = 'http://opencode.ai/v1' }, /insecure_url/)
  await rejectsFixture('template total', (fixture) => { fixture.providers.pop() }, /template_count/)
  await rejectsFixture('model example total', (fixture) => { fixture.providers[1].models.pop() }, /model_example_count/)
})
