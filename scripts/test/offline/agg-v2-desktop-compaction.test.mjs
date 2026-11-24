// V2-01 / A3 × A1：Codex provider 级原生压缩能力声明（remote_compaction）离线契约。
//
// 事实来源（本机只读勘察，未修改 ~/.codex）：
//   * 原版 Desktop 捆绑 Codex = 0.167.0-alpha.3.2。
//   * 用隔离 CODEX_HOME 让该二进制解析候选配置，serde 错误给出枚举候选：
//       remote_compaction: expected `unsupported` or `v2`
//     即 [model_providers.<id>.capabilities] remote_compaction = "unsupported"。
//   * 同一版本明确拒绝任何 [model_providers.openai*]（reserved built-in provider ID），
//     因此内置 openai 身份无法声明 provider capability；managed provider 模式默认关闭。
// 本测试不执行真实 Codex、不联网、不写用户配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigError,
  MANAGED_PROVIDER_ID,
  REMOTE_COMPACTION_LITERALS,
  buildDesiredCodexConfig,
  buildManagedProviderSection,
} from '../../../src/codex/config.js'
import {
  DesktopError,
  activate,
  deactivate,
  detect,
  preview,
  readNativeCompactionBinding,
  status,
} from '../../../src/codex/desktop-integration.js'

const MODEL = 'mg-opencodego-deepseek-v4-1-flash'
const CATALOG = JSON.stringify({ models: [{ slug: MODEL }] })
const USER_CONFIG = [
  '# 用户自己的 Codex 配置（fixture）',
  'model = "gpt-5"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  '',
].join('\n')

async function fixture (text = USER_CONFIG) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-v2-compact-'))
  const configPath = join(dir, 'config.toml')
  const catalogPath = join(dir, 'catalog.json')
  await writeFile(catalogPath, CATALOG)
  if (text !== undefined) await writeFile(configPath, text)
  const base = {
    codexHome: dir,
    configPath,
    baseUrl: 'http://127.0.0.1:18787',
    model: MODEL,
    catalogPath,
    disableExec: true,
    clientProbe: false,
    verifyGateway: async () => ({ ok: true, status: 200, ms: 1 }),
  }
  return {
    dir,
    configPath,
    catalogPath,
    opts: Object.assign({}, base, { experimentalManagedProvider: true, managedProvider: {} }),
    baseOpts: base,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

test('provider capability：确切落点字段与枚举字面量（由捆绑 Codex 解析器实证）', () => {
  assert.equal(MANAGED_PROVIDER_ID, 'modelgate')
  assert.deepEqual([...REMOTE_COMPACTION_LITERALS], ['unsupported', 'v2'])
  const section = buildManagedProviderSection({ openaiBaseUrl: 'http://127.0.0.1:18787', providerId: 'modelgate' })
  assert.equal(section.remoteCompaction, 'unsupported')
  assert.deepEqual(section.sections['model_providers.modelgate'], {
    name: 'ModelGate',
    base_url: 'http://127.0.0.1:18787/v1',
    wire_api: 'responses',
    requires_openai_auth: false,
    supports_websockets: false,
  })
  assert.deepEqual(section.sections['model_providers.modelgate.capabilities'], { remote_compaction: 'unsupported' })
})

test('provider capability：保留内置 openai 身份时绝不写 provider 段', () => {
  const built = buildDesiredCodexConfig({ openaiBaseUrl: 'http://127.0.0.1:18787', model: MODEL, modelCatalogJsonPath: '/tmp/catalog.json' })
  assert.equal(built.providerMode, 'builtin-openai')
  assert.equal(built.desired.topLevel.model_provider, 'openai')
  assert.equal(built.desired.topLevel.openai_base_url, 'http://127.0.0.1:18787')
  assert.equal(built.desired.sections, undefined, '默认不写任何 provider/feature 段')
  const managed = buildDesiredCodexConfig({ openaiBaseUrl: 'http://127.0.0.1:18787', model: MODEL, modelCatalogJsonPath: '/tmp/catalog.json', managedProvider: {} })
  assert.equal(managed.providerMode, 'managed-provider')
  assert.equal(managed.providerId, 'modelgate')
  assert.equal(managed.remoteCompaction, 'unsupported')
  assert.equal(managed.desired.topLevel.model_provider, 'modelgate')
  assert.equal('openai_base_url' in managed.desired.topLevel, false, '自定义 provider 用自身 base_url，不再保留内置改向键')
  assert.equal(managed.desired.sections['model_providers.modelgate.capabilities'].remote_compaction, 'unsupported')
})

test('provider capability：拒绝 reserved openai id 与非法枚举字面量', () => {
  assert.throws(() => buildManagedProviderSection({ openaiBaseUrl: 'http://127.0.0.1:18787', providerId: 'openai' }),
    (e) => e instanceof ConfigError && e.code === 'reserved_provider_id')
  assert.throws(() => buildManagedProviderSection({ openaiBaseUrl: 'http://127.0.0.1:18787', providerId: 'modelgate', remoteCompaction: true }),
    (e) => e instanceof ConfigError && e.code === 'invalid_compaction_capability')
  assert.throws(() => buildManagedProviderSection({ openaiBaseUrl: 'http://127.0.0.1:18787', providerId: 'other-id' }),
    (e) => e instanceof ConfigError && e.code === 'unsupported_provider_id')
})

test('provider capability：未显式授权 → 预览 blocked，不写盘', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(Object.assign({}, f.opts, { experimentalManagedProvider: false }))
  assert.equal(p.ok, false)
  assert.equal(p.state, 'blocked')
  assert.equal(p.blocked[0].code, 'managed_provider_unverified')
  assert.equal(p.nativeCompaction.runtimeAuth, 'UNVERIFIED')
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG)
  await assert.rejects(
    () => activate(Object.assign({}, f.opts, { experimentalManagedProvider: false, consentToken: 'x', expectedSha: '' })),
    (e) => e instanceof DesktopError && e.code === 'managed_provider_unverified' && e.status === 422,
  )
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG)
})

test('provider capability：显式授权后写入自有段并在 status/detect 中可审计', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.ok, true)
  assert.equal(p.nativeCompaction.declarable, true)
  assert.equal(p.nativeCompaction.declared, false)
  assert.ok(p.rows.some((r) => r.path === 'model_providers.modelgate.capabilities.remote_compaction'))

  const activated = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  assert.equal(activated.ok, true)
  const text = await readFile(f.configPath, 'utf8')
  assert.match(text, /^model_provider = "modelgate"$/m)
  assert.match(text, /^\[model_providers\.modelgate\]$/m)
  assert.match(text, /^base_url = "http:\/\/127\.0\.0\.1:18787\/v1"$/m)
  assert.match(text, /^requires_openai_auth = false$/m)
  assert.match(text, /^supports_websockets = false$/m)
  assert.equal(/^env_key\s*=|^experimental_bearer_token\s*=/m.test(text), false, '绝不写任何客户端 Key/token 字段')
  assert.match(text, /^wire_api = "responses"$/m)
  assert.match(text, /^\[model_providers\.modelgate\.capabilities\]$/m)
  assert.match(text, /^remote_compaction = "unsupported"$/m)
  assert.equal(/^openai_base_url = /m.test(text), false)

  const binding = readNativeCompactionBinding(text)
  assert.equal(binding.providerDeclared, true)
  assert.equal(binding.remoteCompaction, 'unsupported')
  assert.equal(binding.requiresOpenAiAuth, false)

  const s = status({ configPath: f.configPath, clientProbe: false })
  assert.equal(s.nativeCompaction.mode, 'managed-provider')
  assert.equal(s.nativeCompaction.declared, true)
  assert.equal(s.nativeCompaction.remoteCompaction, 'unsupported')
  assert.equal(s.nativeCompaction.runtimeAuth, 'UNVERIFIED')
  const d = detect({ configPath: f.configPath, disableExec: true, clientProbe: false })
  assert.equal(d.nativeCompaction.declared, true)
})

test('provider capability：退出聚合完整撤销自有 provider 段与能力声明', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(f.opts)
  const activated = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  const out = await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  assert.equal(out.ok, true)
  assert.equal(out.selective, false)
  const text = await readFile(f.configPath, 'utf8')
  assert.equal(text, USER_CONFIG, '逐字节恢复接入前配置')
  assert.equal(/model_providers\.modelgate|remote_compaction|requires_openai_auth/.test(text), false)
  const s = status({ configPath: f.configPath, clientProbe: false })
  assert.equal(s.nativeCompaction.mode, 'builtin-openai')
})

test('provider capability：用户改无关配置时只撤销自有 provider 段并保留用户修改', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(f.opts)
  const activated = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  await writeFile(f.configPath, (await readFile(f.configPath, 'utf8')) + '\n[projects."/home/dev/proj"]\ntrust_level = "trusted"\n')

  const out = await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  assert.equal(out.ok, true)
  assert.equal(out.selective, true)
  const text = await readFile(f.configPath, 'utf8')
  assert.equal(/model_providers\.modelgate|remote_compaction/.test(text), false)
  assert.match(text, /^model_provider = "openai"$/m)
  assert.match(text, /\[projects\."\/home\/dev\/proj"\]/, '用户修改必须保留')
})

test('provider capability：用户改动能力声明本身 → 409 三方差异，不覆盖', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(f.opts)
  const activated = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  const edited = (await readFile(f.configPath, 'utf8')).replace('remote_compaction = "unsupported"', 'remote_compaction = "v2"')
  await writeFile(f.configPath, edited)
  let conflict = null
  try { await deactivate({ configPath: f.configPath, expectedSha: activated.sha }) } catch (e) { conflict = e }
  assert.ok(conflict instanceof DesktopError)
  assert.equal(conflict.status, 409)
  assert.ok(conflict.detail.restoreConflicts.some((c) => c.path === 'model_providers.modelgate.capabilities.remote_compaction'))
  assert.equal(await readFile(f.configPath, 'utf8'), edited, '冲突时不得写入')
})

test('provider capability：默认内置 openai 身份明确报告不可声明（不伪造能力）', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const s = status({ configPath: f.configPath, clientProbe: false })
  assert.equal(s.nativeCompaction.mode, 'builtin-openai')
  assert.equal(s.nativeCompaction.declarable, false)
  assert.equal(s.nativeCompaction.reason, 'reserved_builtin_provider')
  const p = preview(f.baseOpts)
  assert.equal(p.ok, true)
  assert.equal(p.nativeCompaction.mode, 'builtin-openai')
  assert.equal(p.nativeCompaction.declared, false)
})
