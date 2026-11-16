// 2026-11-16 审计修复回归：接入基线不可重置 / 托管子文件可升级 / 目录回滚别名保真 /
// provider 删除引用守卫 / 健康完成态。全部离线隔离临时目录，不碰真实 ~/.codex、零付费。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManagedAgentConfig, sha256Hex } from '../../../src/codex/config.js'
import { activate, deactivate, preview, status } from '../../../src/codex/desktop-integration.js'
import { createAggregatedCatalog } from '../../../src/aggregation/catalog.js'
import { createMemorySnapshotStore } from '../../../src/aggregation/discovery.js'
import { createRegistry, RegistryError } from '../../../src/aggregation/registry.js'
import { cacheEntry, consoleProvider, makeRegistryStore, readFixture, snapshotOf, tempDir } from '../fixtures/agg-a2/helpers.mjs'

const MODEL = 'mg-opencodego-deepseek-v4-1-flash'
const MODEL2 = 'mg-opencodego-deepseek-v4-1-flash-alt'
const USER_CONFIG = '# 用户基线\nmodel = "gpt-5"\nmodel_provider = "openai"\napproval_policy = "on-request"\n'

async function fixture (configText, childText) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-lifecycle-'))
  const configPath = join(dir, 'config.toml')
  const childPath = join(dir, 'go-deepseek.toml')
  const catalogPath = join(dir, 'catalog.json')
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: MODEL }, { slug: MODEL2 }] }))
  if (configText !== undefined) await writeFile(configPath, configText)
  if (childText !== undefined) await writeFile(childPath, childText)
  return {
    dir, configPath, childPath, catalogPath,
    opts: {
      codexHome: dir, configPath, managedAgentPath: childPath,
      baseUrl: 'http://127.0.0.1:18787', model: MODEL, catalogPath,
      disableExec: true, verifyGateway: async () => ({ ok: true, status: 200, ms: 1 }),
    },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

async function activateFully (f, extra) {
  const p = preview(Object.assign({}, f.opts, extra))
  assert.equal(p.ok, true, 'preview 必须可用')
  return activate(Object.assign({}, f.opts, extra, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
}

function readState (f) {
  return JSON.parse(readFileSync(join(f.dir, '.modelgate-desktop-state.json'), 'utf8'))
}

test('再次激活（换模型）不重置回滚基线：退出仍恢复首次接入前字节', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  await activateFully(f)
  // 第二次激活换模型（changed 分支）——旧实现会把 before 重置为聚合后的文件。
  await activateFully(f, { model: MODEL2 })
  const st = readState(f)
  assert.equal(st.mode, 'aggregated')
  assert.equal(st.before.sha256, sha256Hex(Buffer.from(USER_CONFIG, 'utf8')), '基线必须是首次接入前的原始字节')
  assert.ok(st.backupPath && st.backupPath.endsWith('.bak.baseline'), '原始备份应稳定化到 .bak.baseline')
  assert.equal(await readFile(st.backupPath, 'utf8'), USER_CONFIG)
  // 第三次激活再换回来，基线仍不漂移
  await activateFully(f, { model: MODEL })
  const st2 = readState(f)
  assert.equal(st2.before.sha256, sha256Hex(Buffer.from(USER_CONFIG, 'utf8')))
  assert.equal(await readFile(st2.backupPath, 'utf8'), USER_CONFIG)
  const currentSha = status(f.opts).config.sha256
  const out = await deactivate(Object.assign({}, f.opts, { expectedSha: currentSha }))
  assert.equal(out.ok, true)
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG, '退出必须恢复原始用户配置')
})

test('托管子文件换模型/effort 可升级，不再永久 409', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  await activateFully(f)
  const child1 = await readFile(f.childPath, 'utf8')
  assert.match(child1, /model_reasoning_effort = "high"/, '默认 effort 必须是 Go 支持的 high')
  // 换模型：子文件是我们上次写的规范字节 → 升级而非冲突。
  const p = preview(Object.assign({}, f.opts, { model: MODEL2 }))
  assert.equal(p.ok, true)
  assert.equal(p.agentChild.action, 'upgrade')
  await activateFully(f, { model: MODEL2 })
  const child2 = await readFile(f.childPath, 'utf8')
  assert.match(child2, new RegExp('model = "' + MODEL2 + '"'))
  assert.notEqual(child2, child1)
})

test('状态记录丢失但子文件为托管规范形状：仍可按升级处理（漂移收编）', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  await activateFully(f)
  // 模拟状态漂移：删除桌面状态记录（生产现场 agentChild=null 的等价情形）。
  const statePath = join(f.dir, '.modelgate-desktop-state.json')
  await unlink(statePath)
  const p = preview(Object.assign({}, f.opts, { model: MODEL2 }))
  assert.equal(p.ok, true)
  assert.equal(p.agentChild.action, 'upgrade', '规范形状 + mg- 别名应被识别为可升级托管文件')
})

test('用户自有模型的同形状子文件仍判冲突（保守不覆盖）', async (t) => {
  const injected = 'model = "user-own"\nmodel_reasoning_effort = "high"\n'
  const f = await fixture(USER_CONFIG, injected)
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.ok, false)
  assert.equal(p.agentChild.action, 'conflict')
  assert.equal(await readFile(f.childPath, 'utf8'), injected)
})

const BASE = readFixture('base-catalog.json')
const CONSOLE_MODELS = [
  { upstreamId: 'deepseek-v4.1-flash', publicId: 'mg-console-deepseek-v4-1-flash', contextWindow: 128000 },
  { upstreamId: 'glm-5', publicId: 'mg-console-glm-5', contextWindow: 200000 },
]

test('目录回滚保留别名与官方清单（不再丢 aliases）', async () => {
  const dir = tempDir('mg-alias-rollback-')
  const cacheStore = createMemorySnapshotStore()
  cacheStore.put('local', 'console', cacheEntry(snapshotOf(consoleProvider(), CONSOLE_MODELS)))
  const publisher = createAggregatedCatalog({
    registry: { listProviders: () => [consoleProvider()] },
    cacheStore, dir,
    readConfig: () => ({ defaults: {}, server: {}, models: { 'deepseek-v4.1-flash': { alias: ['ds-flash'] } } }),
  })
  try {
    await publisher.publish('local', { base: BASE })
    const st1 = publisher.status('local').state
    assert.ok(st1.current.aliases && st1.current.aliases['ds-flash'], '发布世代必须持久化别名')
    cacheStore.put('local', 'console', cacheEntry(snapshotOf(consoleProvider(), CONSOLE_MODELS.slice(0, 1))))
    await publisher.publish('local', { base: BASE })
    const rolled = publisher.rollback('local', 'prev')
    assert.ok(rolled.version >= 3)
    const st3 = publisher.status('local').state
    assert.ok(st3.current.aliases && st3.current.aliases['ds-flash'], '回滚后别名必须保留')
    assert.deepEqual(st3.current.officialSlugs, st1.current.officialSlugs, '官方清单随回滚恢复')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('removeProvider：仍被模型引用时拒绝（force 可显式越过）', async () => {
  const store = makeRegistryStore()
  try {
    const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
    registry.addProvider({ kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1', apiKeyEnv: 'TEST_AGG_KEY' })
    // 写入一个引用该 provider 的模型定义。
    const local = store.readLocal()
    local.models = { 'some-model': { provider: 'console', api: 'responses' } }
    writeFileSync(store.localPath, JSON.stringify(local))
    const reg2 = createRegistry({ paths: store.paths, readConfig: store.readConfig })
    assert.throws(() => reg2.removeProvider('console'), (e) => e instanceof RegistryError && e.code === 'provider_in_use')
    const forced = reg2.removeProvider('console', { force: true })
    assert.equal(forced.removed, true)
  } finally { rmSync(store.dir, { recursive: true, force: true }) }
})