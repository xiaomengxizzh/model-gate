// A3 / P03：无损退出、三方差异、崩溃恢复与失败回滚的离线契约测试。
// 全部在 OS 临时目录：不读真实 HOME、不碰 ~/.codex、不联网、不执行 Desktop。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDesiredCodexConfig, mergeOwnedFields, sha256Hex } from '../../../src/codex/config.js'
import {
  DesktopError,
  activate,
  deactivate,
  preview,
  status,
} from '../../../src/codex/desktop-integration.js'

const MODEL = 'mg-opencodego-deepseek-v4-1-flash'
const CATALOG = JSON.stringify({ models: [{ slug: MODEL }] })
const USER_CONFIG = [
  '# user config（fixture）',
  'model = "gpt-5"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  '',
  '[model_providers.myproxy]',
  'name = "My Proxy"',
  'base_url = "https://proxy.example/v1"',
  '',
].join('\n')

async function fixture (text) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-agg-desktop-rb-'))
  const configPath = join(dir, 'config.toml')
  const catalogPath = join(dir, 'catalog.json')
  await writeFile(catalogPath, CATALOG)
  if (text !== undefined) await writeFile(configPath, text)
  return {
    dir,
    configPath,
    catalogPath,
    opts: {
      configPath,
      baseUrl: 'http://127.0.0.1:18787',
      model: MODEL,
      catalogPath,
      features: { multi_agent_v2: true },
      disableExec: true,
      verifyGateway: async () => ({ ok: true, status: 200, ms: 1 }),
    },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

async function activateFully (f) {
  const p = preview(f.opts)
  return activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
}

test('退出聚合：恢复接入前的原始字节，并把状态切回 official', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  assert.notEqual(await readFile(f.configPath, 'utf8'), USER_CONFIG)

  const beforeDeactivate = status({ configPath: f.configPath })
  assert.equal(beforeDeactivate.mode, 'aggregated')
  assert.equal(beforeDeactivate.backup.available, true)

  const result = await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'official')
  assert.equal(result.sha, sha256Hex(USER_CONFIG))
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG, '必须逐字节恢复')

  const s = status({ configPath: f.configPath })
  assert.equal(s.mode, 'official')
  assert.equal(s.appliedAt, null)
  assert.equal(s.lastApply.action, 'deactivate')
})

test('退出聚合：接入时新建的配置会被删除（恢复到“文件不存在”）', async (t) => {
  const f = await fixture(undefined)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  const result = await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  assert.equal(result.ok, true)
  assert.equal(result.removed, true)
  await assert.rejects(() => readFile(f.configPath), /ENOENT/)
  assert.equal(status({ configPath: f.configPath }).mode, 'official')
})

test('退出聚合：外部修改 → 409 + 三方差异，绝不覆盖', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  const edited = (await readFile(f.configPath, 'utf8')) +
    '\n[model_providers.leak]\nname = "x"\napi_key = "super-secret-value"\n'
  await writeFile(f.configPath, edited)

  let conflict = null
  try {
    await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  } catch (e) { conflict = e }
  assert.ok(conflict instanceof DesktopError)
  assert.equal(conflict.code, 'concurrent_modification')
  assert.equal(conflict.status, 409)
  const tw = conflict.detail.threeWay
  assert.ok(tw && tw.oursVsTheirs && tw.baseVsTheirs)
  assert.match(tw.base.sha256, /^[a-f0-9]{64}$/)
  assert.match(tw.theirs.sha256, /^[a-f0-9]{64}$/)
  assert.ok(tw.oursVsTheirs.some((r) => r.kind !== 'same'), '必须给出行级差异')
  assert.equal(JSON.stringify(tw).includes('super-secret-value'), false, '差异不得回显敏感值')
  assert.ok(tw.oursVsTheirs.some((r) => r.redacted === true), '敏感行必须标记 redacted')
  assert.equal(await readFile(f.configPath, 'utf8'), edited, '冲突时不得写入')
  assert.equal(status({ configPath: f.configPath }).mode, 'aggregated', '状态保持聚合，等待人工处理')
})

test('崩溃恢复：applying 阶段崩溃后，下次 status 自动恢复到接入前字节', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const desired = buildDesiredCodexConfig({
    openaiBaseUrl: f.opts.baseUrl,
    model: MODEL,
    modelCatalogJsonPath: f.catalogPath,
    features: { multi_agent_v2: true },
  }).desired
  const afterText = mergeOwnedFields(USER_CONFIG, desired).text
  await writeFile(f.configPath, afterText)
  await writeFile(f.configPath + '.bak', USER_CONFIG, { mode: 0o600 })
  await writeFile(f.configPath + '.mg-journal.json', JSON.stringify({
    schema: 'mg-codex-desktop-journal/1',
    phase: 'applying',
    at: Date.now(),
    before: { exists: true, sha256: sha256Hex(USER_CONFIG), size: Buffer.byteLength(USER_CONFIG) },
    applied: { sha256: sha256Hex(afterText), size: Buffer.byteLength(afterText) },
    backupPath: f.configPath + '.bak',
    desired,
  }))

  const s = status({ configPath: f.configPath })
  assert.equal(s.recovery.recovered, 'restored_after_crash')
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG)
  assert.equal(s.journal.present, false)
  assert.equal(s.mode, 'official')
  assert.equal(s.lastApply.code, 'interrupted_apply_recovered')
})

test('崩溃恢复：崩溃后文件被第三方改过 → 报告冲突且不覆盖', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const desired = buildDesiredCodexConfig({ openaiBaseUrl: f.opts.baseUrl, model: MODEL, modelCatalogJsonPath: f.catalogPath }).desired
  const afterText = mergeOwnedFields(USER_CONFIG, desired).text
  const theirs = afterText + '\n# third party edit\n'
  await writeFile(f.configPath, theirs)
  await writeFile(f.configPath + '.bak', USER_CONFIG, { mode: 0o600 })
  await writeFile(f.configPath + '.mg-journal.json', JSON.stringify({
    schema: 'mg-codex-desktop-journal/1',
    phase: 'applying',
    before: { exists: true, sha256: sha256Hex(USER_CONFIG), size: Buffer.byteLength(USER_CONFIG) },
    applied: { sha256: sha256Hex(afterText), size: Buffer.byteLength(afterText) },
    backupPath: f.configPath + '.bak',
    desired,
  }))

  const s = status({ configPath: f.configPath })
  assert.equal(s.recovery.recovered, 'conflict')
  assert.equal(s.recovery.reason, 'external_modification_since_crash')
  assert.equal(await readFile(f.configPath, 'utf8'), theirs, '不得覆盖第三方改动')
  assert.equal(s.journal.present, true, '未决冲突必须保留日志供人工处理')
})

test('崩溃恢复：已验证但没落状态 → 补齐聚合状态，不回滚成功写入', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const desired = buildDesiredCodexConfig({ openaiBaseUrl: f.opts.baseUrl, model: MODEL, modelCatalogJsonPath: f.catalogPath }).desired
  const afterText = mergeOwnedFields(USER_CONFIG, desired).text
  await writeFile(f.configPath, afterText)
  await writeFile(f.configPath + '.bak', USER_CONFIG, { mode: 0o600 })
  await writeFile(f.configPath + '.mg-journal.json', JSON.stringify({
    schema: 'mg-codex-desktop-journal/1',
    phase: 'verified',
    at: Date.now(),
    before: { exists: true, sha256: sha256Hex(USER_CONFIG), size: Buffer.byteLength(USER_CONFIG) },
    applied: { sha256: sha256Hex(afterText), size: Buffer.byteLength(afterText) },
    backupPath: f.configPath + '.bak',
    desired,
    lastApply: { ok: true, recoveredAfterCrash: true },
  }))

  const s = status({ configPath: f.configPath })
  assert.equal(s.recovery.recovered, 'finalized_verified')
  assert.equal(await readFile(f.configPath, 'utf8'), afterText)
  assert.equal(s.mode, 'aggregated')
  assert.equal(s.journal.present, false)
  assert.equal(s.backup.available, true)
})

test('失败回滚只回滚“仍然是我们的”字节：写后第三方改动会保留', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const p = preview(f.opts)
  let error = null
  try {
    await activate(Object.assign({}, f.opts, {
      consentToken: p.consentToken,
      expectedSha: p.expectedSha,
      hooks: {
        afterWrite: async ({ configPath }) => {
          const current = await readFile(configPath, 'utf8')
          await writeFile(configPath, current + '\n# third party edit\n')
        },
      },
    }))
  } catch (e) { error = e }
  assert.ok(error instanceof DesktopError)
  assert.equal(error.code, 'config_verify_failed')
  assert.equal(error.detail.restored, false, '第三方改动后不得回滚覆盖')
  assert.match(await readFile(f.configPath, 'utf8'), /# third party edit/)
})

test('流程锁：持锁时拒绝并发接入；过期锁可恢复', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const lockPath = f.configPath + '.mg-lock'
  await writeFile(lockPath, JSON.stringify({ schema: 'mg-codex-desktop-contract/lock', nonce: 'n1', pid: 1, at: Date.now(), staleMs: 120000 }))
  const p = preview(f.opts)
  await assert.rejects(
    () => activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha })),
    (e) => e.code === 'lock_held' && e.status === 409,
  )
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG)

  const old = new Date(Date.now() - 10 * 60 * 1000)
  await utimes(lockPath, old, old)
  const ok = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  assert.equal(ok.ok, true, '过期锁应被回收，不阻塞恢复')
})

test('退出聚合：备份缺失时拒绝写入并给出 typed error', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  await unlink(f.configPath + '.bak')
  const before = await readFile(f.configPath, 'utf8')
  await assert.rejects(
    () => deactivate({ configPath: f.configPath, expectedSha: activated.sha }),
    (e) => e.code === 'backup_missing' && e.status === 409,
  )
  assert.equal(await readFile(f.configPath, 'utf8'), before)
})
