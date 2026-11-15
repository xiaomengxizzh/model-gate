// V2-01 / A3：退出聚合只撤销 ModelGate 自有键、保留用户后来修改（离线契约）。
// OS 临时目录 fixture：不读真实 HOME、不写 ~/.codex、不联网、不执行 Desktop。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Hex, unmanagedFingerprint } from '../../../src/codex/config.js'
import {
  DesktopError,
  activate,
  buildOwnedRestore,
  deactivate,
  preview,
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
  '[features]',
  'multi_agent = true',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  '',
  '[projects."/home/dev/proj"]',
  'trust_level = "trusted"',
  '',
].join('\n')

async function fixture (text) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-v2-restore-'))
  const configPath = join(dir, 'config.toml')
  const catalogPath = join(dir, 'catalog.json')
  await writeFile(catalogPath, CATALOG)
  if (text !== undefined) await writeFile(configPath, text)
  const opts = {
    configPath,
    baseUrl: 'http://127.0.0.1:18787',
    model: MODEL,
    catalogPath,
    features: { multi_agent_v2: true },
    disableExec: true,
    clientProbe: false,
    verifyGateway: async () => ({ ok: true, status: 200, ms: 1 }),
  }
  return { dir, configPath, catalogPath, opts, cleanup: async () => { await rm(dir, { recursive: true, force: true }) } }
}

async function activateFully (f) {
  const p = preview(f.opts)
  return activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
}

test('退出聚合：接入时新建配置 + 用户后加段 → 不删文件，只撤自有键', async (t) => {
  const f = await fixture(undefined)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  await writeFile(f.configPath, (await readFile(f.configPath, 'utf8')) + '\n[mcp_servers.user]\ncommand = "node"\n')

  const result = await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  assert.equal(result.ok, true)
  assert.equal(result.removed, false, '用户后加的内容不能被一起删掉')
  assert.equal(result.selective, true)
  assert.equal(result.preservedUserEdits, true)

  const text = await readFile(f.configPath, 'utf8')
  assert.equal(text.startsWith('\n'), false, '撤掉自有行后不留前导空行')
  assert.match(text, /^\[mcp_servers\.user\]$/m)
  assert.equal(/model_catalog_json|openai_base_url|model_provider/.test(text), false, '自有字段必须全部撤掉')
  assert.equal(/^model = /m.test(text), false)
  assert.equal(/\[features\]/.test(text), false, '我们新建的空 [features] 段头必须撤掉')
  assert.equal(status({ configPath: f.configPath }).mode, 'official')
  assert.equal(status({ configPath: f.configPath }).lastApply.scope, 'owned-only')
})

test('退出聚合：用户把自有字段改回接入前基线 → 视为已恢复，不冲突不覆盖', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  const reverted = (await readFile(f.configPath, 'utf8')).replace(/^model = .*$/m, 'model = "gpt-5"')
  await writeFile(f.configPath, reverted)

  const result = await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'official')
  const text = await readFile(f.configPath, 'utf8')
  assert.match(text, /^model = "gpt-5"$/m)
  assert.equal(/model_catalog_json/.test(text), false)
  assert.equal(/^\[features\]$/m.test(text), true, '接入前已存在的 [features] 段必须保留')
  assert.match(text, /multi_agent = true/)
})

test('退出聚合：用户删除自有字段 → 基线有则 409、基线无则保留删除结果', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  // model 在接入前存在：删掉它是用户改动，恢复会把它写回 → 必须 409。
  const removedModel = (await readFile(f.configPath, 'utf8')).replace(/^model = .*\n/m, '')
  await writeFile(f.configPath, removedModel)
  let conflict = null
  try { await deactivate({ configPath: f.configPath, expectedSha: activated.sha }) } catch (e) { conflict = e }
  assert.ok(conflict instanceof DesktopError)
  assert.equal(conflict.code, 'concurrent_modification')
  assert.equal(conflict.status, 409)
  assert.ok(conflict.detail.restoreConflicts.some((c) => c.path === 'model' && c.reason === 'owned_key_removed'))
  assert.equal(await readFile(f.configPath, 'utf8'), removedModel, '冲突时不得写入')

  // model_catalog_json 是接入时新增的：用户删掉它等于回到基线，退出应成功且绝不写回。
  const f2 = await fixture(USER_CONFIG)
  t.after(f2.cleanup)
  const a2 = await activateFully(f2)
  const removedCatalog = (await readFile(f2.configPath, 'utf8')).replace(/^model_catalog_json = .*\n/m, '')
  await writeFile(f2.configPath, removedCatalog)
  const ok = await deactivate({ configPath: f2.configPath, expectedSha: a2.sha })
  assert.equal(ok.ok, true)
  assert.equal(/model_catalog_json/.test(await readFile(f2.configPath, 'utf8')), false, '绝不重新写回用户删掉的自有键')
})

test('退出聚合：预检 sha 过期但文件仍是我们写入的字节 → 安全恢复', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  // 页面持有的是旧 sha，但磁盘字节确实等于我们写入的内容：直接逐字节恢复是安全的。
  const result = await deactivate({ configPath: f.configPath, expectedSha: 'f'.repeat(64) })
  assert.equal(result.ok, true)
  assert.equal(result.selective, false)
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG)
  assert.equal(sha256Hex(await readFile(f.configPath, 'utf8')), sha256Hex(USER_CONFIG))
})

test('退出聚合：选择性写入原子且自证未管理行逐字节不变', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const activated = await activateFully(f)
  const edited = (await readFile(f.configPath, 'utf8')).replace('approval_policy = "on-request"', 'approval_policy = "never"')
  await writeFile(f.configPath, edited)
  const fingerprintBefore = unmanagedFingerprint(edited)

  const result = await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  const text = await readFile(f.configPath, 'utf8')
  assert.equal(unmanagedFingerprint(text), fingerprintBefore, '未管理行必须逐字节不变')
  assert.match(text, /^approval_policy = "never"$/m, '用户改动必须保留')
  assert.equal(sha256Hex(Buffer.from(text, 'utf8')), result.sha)
  // 原子写不得留下 .tmp
  const leftovers = (await readdir(f.dir)).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  // 退出前安全快照必须存在且等于被替换掉的内容
  assert.equal(await readFile(result.safetyBackupPath, 'utf8'), edited)
})

test('buildOwnedRestore：纯函数可独立证明冲突判定与 [features] 空段清理', () => {
  const base = 'model = "gpt-5"\nmodel_provider = "openai"\n'
  const desired = { topLevel: { model_provider: 'openai', openai_base_url: 'http://127.0.0.1:18787', model: MODEL, model_catalog_json: '/tmp/c.json' }, sections: { features: { multi_agent_v2: true } } }
  const applied = [
    'model_provider = "openai"',
    'openai_base_url = "http://127.0.0.1:18787"',
    'model = "' + MODEL + '"',
    'model_catalog_json = "/tmp/c.json"',
    '',
    '[features]',
    'multi_agent_v2 = true',
    '',
    '[mcp_servers.user]',
    'command = "node"',
  ].join('\n')

  const okPlan = buildOwnedRestore({ baseText: base, baseExists: true, currentText: applied, desired })
  assert.equal(okPlan.ok, true)
  assert.equal(/model_catalog_json|openai_base_url/.test(okPlan.text), false)
  assert.match(okPlan.text, /^model = "gpt-5"$/m)
  assert.equal(/\[features\]/.test(okPlan.text), false, '空 features 段头必须清理')
  assert.match(okPlan.text, /\[mcp_servers\.user\]/)

  const modified = applied.replace('model = "' + MODEL + '"', 'model = "gpt-4o"')
  const conflict = buildOwnedRestore({ baseText: base, baseExists: true, currentText: modified, desired })
  assert.equal(conflict.ok, false)
  assert.ok(conflict.conflicts.some((c) => c.path === 'model' && c.reason === 'owned_key_modified'))
})
