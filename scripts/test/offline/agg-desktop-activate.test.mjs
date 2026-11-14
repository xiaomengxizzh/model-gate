// A3 / P03：Desktop 一键接入的离线契约测试（激活、同意、保留、幂等、损坏、目录超限、探测）。
// 全部使用 OS 临时目录 fixture：不读真实 HOME、不碰 ~/.codex、不写用户配置、不联网、不执行 Desktop。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffConfigText, unmanagedFingerprint } from '../../../src/codex/config.js'
import {
  DESKTOP_CONTRACT,
  DesktopError,
  MAX_CATALOG_BYTES,
  activate,
  detect,
  preview,
  status,
} from '../../../src/codex/desktop-integration.js'

const MODEL = 'mg-opencodego-deepseek-v4-1-flash'
const CATALOG = JSON.stringify({ models: [{ slug: MODEL, display_name: 'DeepSeek V4.1 Flash' }] })
const USER_CONFIG = [
  '# 用户自己的 Codex 配置（临时目录 fixture）',
  'model = "gpt-5"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  '',
  '[features]',
  'multi_agent = true',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  'args = ["mcp-docs.js"]',
  '',
  '[projects."/home/dev/proj"]',
  'trust_level = "trusted"',
  '',
  '[model_providers.myproxy]',
  'name = "My Proxy"',
  'base_url = "https://proxy.example/v1"',
  'wire_format = "responses"',
  '',
].join('\n')

async function fixture (text) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-agg-desktop-act-'))
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

test('Desktop 接入：空白配置首次激活需要一次同意，写后验证通过', async (t) => {
  const f = await fixture(undefined)
  t.after(f.cleanup)

  const p = preview(f.opts)
  assert.equal(p.contract, DESKTOP_CONTRACT)
  assert.equal(p.ok, true)
  assert.equal(p.state, 'ready')
  assert.equal(p.firstRun, true)
  assert.equal(p.consentRequired, true)
  assert.match(p.consentToken, /^[a-f0-9]{64}$/)
  assert.deepEqual(p.rows.map((r) => r.path), ['model_provider', 'openai_base_url', 'model', 'model_catalog_json', 'features.multi_agent_v2'])
  assert.ok(p.rows.every((r) => r.kind === 'add' && r.owner === 'modelgate'))
  assert.equal(p.catalog.ok, true)
  assert.equal(p.catalog.targetPresent, true)

  await assert.rejects(
    () => activate(Object.assign({}, f.opts, { consentToken: '', expectedSha: p.expectedSha })),
    (e) => e instanceof DesktopError && e.code === 'consent_required' && e.status === 428,
  )
  await assert.rejects(() => readFile(f.configPath), /ENOENT/)

  const result = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.mode, 'aggregated')
  assert.equal(result.backupPath, null, '空白配置没有备份文件（接入前不存在）')
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.catalog.modelCount, 1)
  assert.equal(result.sha, result.verification.config.sha256)

  const text = await readFile(f.configPath, 'utf8')
  assert.match(text, /^model_provider = "openai"$/m)
  assert.match(text, /^openai_base_url = "http:\/\/127\.0\.0\.1:18787"$/m)
  assert.match(text, new RegExp('^model = "' + MODEL + '"$', 'm'))
  assert.match(text, /^model_catalog_json = ".+catalog\.json"$/m)
  assert.match(text, /\[features\][\s\S]*multi_agent_v2 = true/)
  assert.equal((await stat(f.configPath)).mode & 0o777, 0o600, '新建配置必须是 0600')

  const s = status({ configPath: f.configPath, baseUrl: 'http://127.0.0.1:18787' })
  assert.equal(s.mode, 'aggregated')
  assert.equal(s.appliedAt > 0, true)
  assert.equal(s.lastApply.ok, true)
})

test('Desktop 接入：手改配置的其它键逐字节保留，只改 owned 行', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.rows.find((r) => r.path === 'model').kind, 'replace')
  assert.equal(p.consentRequired, true)
  assert.ok(p.conflicts.some((c) => c.path === 'model' && c.reason === 'overwrite'))

  const result = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  assert.equal(result.ok, true)
  const after = await readFile(f.configPath, 'utf8')

  assert.equal(unmanagedFingerprint(USER_CONFIG), unmanagedFingerprint(after), '未管理的行必须逐字节一致')
  for (const line of ['# 用户自己的 Codex 配置（临时目录 fixture）', 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', '[mcp_servers.docs]', 'command = "node"', '[projects."/home/dev/proj"]', 'trust_level = "trusted"', '[model_providers.myproxy]', 'wire_format = "responses"']) {
    assert.ok(after.includes(line), 'preserved: ' + line)
  }
  const changedRows = diffConfigText(USER_CONFIG, after).filter((r) => r.kind !== 'same')
  assert.ok(changedRows.length > 0)
  assert.ok(changedRows.every((r) => r.owner === 'modelgate'), '差异只允许落在 modelgate 拥有的行')
  assert.equal(result.backupPath, f.configPath + '.bak')
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600, '备份必须是 0600')
  assert.equal(await readFile(result.backupPath, 'utf8'), USER_CONFIG, '备份必须是接入前的完整字节')
})

test('Desktop 接入：第二次激活幂等，不重写也不丢回滚基线', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const first = preview(f.opts)
  const activated = await activate(Object.assign({}, f.opts, { consentToken: first.consentToken, expectedSha: first.expectedSha }))
  const bytesAfterFirst = await readFile(f.configPath, 'utf8')

  const second = preview(f.opts)
  assert.equal(second.state, 'already_aggregated')
  assert.equal(second.consentRequired, false)
  assert.equal(second.changed.length, 0)

  const again = await activate(Object.assign({}, f.opts, { expectedSha: second.expectedSha }))
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)
  assert.equal(again.idempotent, true)
  assert.equal(again.sha, activated.sha)
  assert.equal(await readFile(f.configPath, 'utf8'), bytesAfterFirst)
  assert.equal(again.backupPath, activated.backupPath, '幂等激活必须沿用第一次的备份')
  const s = status({ configPath: f.configPath })
  assert.equal(s.backup.available, true)
  assert.equal(s.backup.matches, true)
  assert.equal(s.lastApply.idempotent, true)
})

test('Desktop 接入：覆盖既有 owned 值同样需要同意', async (t) => {
  const f = await fixture('model = "gpt-5"\nmodel_provider = "openai"\n')
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.consentRequired, true)
  assert.ok(p.conflicts.some((c) => c.path === 'model' && c.from === '"gpt-5"'))
  await assert.rejects(() => activate(Object.assign({}, f.opts, { expectedSha: p.expectedSha })), (e) => e.code === 'consent_required')
  const ok = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  assert.equal(ok.ok, true)
})

test('Desktop 接入：损坏配置给出明确路径，不崩溃也不写入', async (t) => {
  const duplicate = '[features]\nmulti_agent = true\n\n[features]\nmulti_agent_v2 = true\n'
  const f = await fixture(duplicate)
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.ok, false)
  assert.equal(p.state, 'corrupted')
  assert.equal(p.consentToken, null)
  assert.equal(p.blocked[0].code, 'duplicate_section')
  assert.match(p.expectedSha, /^[a-f0-9]{64}$/, '损坏时仍返回真实 before sha，避免误报并发冲突')
  await assert.rejects(
    () => activate(Object.assign({}, f.opts, { consentToken: 'x', expectedSha: p.expectedSha })),
    (e) => e instanceof DesktopError && e.code === 'duplicate_section' && e.status === 422,
  )
  assert.equal(await readFile(f.configPath, 'utf8'), duplicate, '拒绝写入后文件必须保持原样')

  const arrayTable = '[[features]]\nmulti_agent = true\n'
  const g = await fixture(arrayTable)
  t.after(g.cleanup)
  const q = preview(g.opts)
  assert.equal(q.ok, false)
  assert.equal(q.blocked[0].code, 'unsupported_layout')
})

test('Desktop 接入：已有 [model_providers.openai] 阻断并给出人工修复路径', async (t) => {
  const reserved = '[model_providers.openai]\nname = "override"\nbase_url = "https://example.invalid/v1"\n'
  const f = await fixture(reserved)
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.ok, false)
  assert.equal(p.state, 'blocked')
  assert.ok(p.blocked.some((b) => b.code === 'reserved_provider_override'))
  assert.match(p.blocked.find((b) => b.code === 'reserved_provider_override').message, /reserved built-in provider ID/)
  await assert.rejects(
    () => activate(Object.assign({}, f.opts, { consentToken: p.consentToken || 'x', expectedSha: p.expectedSha })),
    (e) => e.code === 'reserved_provider_override' && e.status === 422,
  )
  assert.equal(await readFile(f.configPath, 'utf8'), reserved)
})

test('Desktop 接入：目录超限 → typed error 且自动回滚到原始字节', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const huge = Buffer.alloc(MAX_CATALOG_BYTES + 1024, 0x20)
  await writeFile(f.catalogPath, huge)
  const p = preview(f.opts)
  assert.equal(p.catalog.state, 'overflow')
  assert.equal(p.ok, true, '预览仍可展示差异；真正阻断在写后验证')
  await assert.rejects(
    () => activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha })),
    (e) => e instanceof DesktopError && e.code === 'catalog_overflow' && e.status === 413 && e.detail.restored === true,
  )
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG, '验证失败必须回滚到接入前字节')
  const s = status({ configPath: f.configPath })
  assert.equal(s.mode, 'official')
  assert.equal(s.lastApply.ok, false)
  assert.equal(s.lastApply.code, 'catalog_overflow')
})

test('Desktop 接入：网关不可达时写盘不算成功，自动回滚', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const p = preview(f.opts)
  await assert.rejects(
    () => activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha, verifyGateway: async () => ({ ok: false, status: 0 }) })),
    (e) => e.code === 'gateway_unreachable' && e.detail.restored === true,
  )
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG)
})

test('Desktop 接入：多版本探测——CLI 版本来自 --version，Desktop 版本来自版本文件，不拉起 GUI', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const cliPath = join(f.dir, 'fake-codex')
  await writeFile(cliPath, '#!/bin/sh\necho "codex-cli 0.167.0"\n', { mode: 0o755 })
  const desktopDir = join(f.dir, 'desktop-bin')
  await mkdir(desktopDir)
  const desktopPath = join(desktopDir, 'ChatGPT')
  await writeFile(desktopPath, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  await writeFile(join(desktopDir, 'version'), '2026.11.0\n')

  const found = detect({ configPath: f.configPath, cliPath, desktopPath })
  assert.equal(found.cli.found, true)
  assert.equal(found.cli.version, '0.167.0')
  assert.equal(found.cli.versionState, 'known')
  assert.equal(found.desktop.found, true)
  assert.equal(found.desktop.version, '2026.11.0')
  assert.equal(found.desktop.versionState, 'known')
  assert.equal(found.desktop.source, 'version', '版本必须从文件读取，不能执行 Desktop（否则会拉起 GUI）')
})

test('Desktop 接入：detect 不执行 Desktop 二进制，版本未知时明确标注', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const before = detect({ configPath: f.configPath, disableExec: true })
  assert.equal(before.contract, DESKTOP_CONTRACT)
  assert.equal(before.config.mode, 'official')
  assert.equal(before.config.exists, true)
  assert.equal(before.configPath, f.configPath)
  assert.equal(['known', 'unknown', 'not_found'].includes(before.cli.versionState), true)
  assert.equal(['known', 'unknown', 'not_found'].includes(before.desktop.versionState), true)
  assert.equal(before.desktop.versionState === 'not_found' ? true : before.desktop.version === null, true, '不执行 Desktop 时不得伪造版本')

  const p = preview(f.opts)
  const activated = await activate(Object.assign({}, f.opts, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
  const after = detect({ configPath: f.configPath, disableExec: true, baseUrl: f.opts.baseUrl })
  assert.equal(after.config.mode, 'aggregated')
  assert.equal(after.backup.available, true)
  assert.equal(after.backup.matches, true)
  assert.equal(after.state.appliedSha, activated.sha)
  assert.equal(after.needsRestart, true)
})
