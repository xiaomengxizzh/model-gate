// E6 受控 Codex 配置写入的离线契约测试。
// 全部使用 OS 临时目录 fixture：不读 HOME、不碰 ~/.codex、不写正式配置、不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConfigError,
  CONFIG_CONTRACT,
  OWNED_TOP_LEVEL,
  OWNED_SECTIONS,
  RESERVED_OVERRIDE_SECTIONS,
  applyConfigChange,
  assertConfigPath,
  buildDesiredCodexConfig,
  describeConfigPolicy,
  diffConfigText,
  mergeOwnedFields,
  parseConfigDocument,
  planConfigApply,
  planRollback,
  readOwnedFields,
  rollbackConfigChange,
  sha256Hex,
  snapshotConfigFile,
  summarizePreserved,
  unmanagedFingerprint,
} from '../../../src/codex/config.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// 一份"像真的"用户 config.toml：含未知顶层字段、MCP、projects trust、自定义 provider、注释。
const USER_CONFIG = [
  '# 用户自己的 Codex 配置（测试 fixture，全部位于临时目录）',
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
  'wire_api = "responses"',
  '',
].join('\n')

async function fixture (text = USER_CONFIG, name = 'config.toml') {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-config-'))
  const path = join(dir, name)
  await writeFile(path, text, 'utf8')
  return { dir, path, text, cleanup: async () => { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }) } }
}

function desiredFor (overrides = {}) {
  return {
    topLevel: {
      model: 'mg/gpt-5-aggregate',
      model_provider: 'openai',
      openai_base_url: 'http://127.0.0.1:18999',
      model_catalog_json: '/tmp/mg-catalog/codex-catalog.json',
      ...overrides,
    },
  }
}

function expectCode (fn, code) {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof ConfigError, 'expected ConfigError, got ' + e)
    assert.equal(e.code, code, 'error code: ' + e.message)
    return e
  }
  assert.fail('expected ConfigError(' + code + ') but nothing was thrown')
}

test('契约与所有权声明：只含 D1-A 可写字段，明确拒绝内置 provider 覆盖', () => {
  assert.equal(CONFIG_CONTRACT, 'mg-codex-config/1')
  assert.deepEqual([...OWNED_TOP_LEVEL].sort(), ['model', 'model_catalog_json', 'model_provider', 'openai_base_url'])
  assert.deepEqual(Object.keys(OWNED_SECTIONS), ['features'])
  assert.deepEqual([...OWNED_SECTIONS.features].sort(), ['multi_agent', 'multi_agent_v2'])
  assert.deepEqual([...RESERVED_OVERRIDE_SECTIONS], ['model_providers.openai'])
  const policy = describeConfigPolicy()
  assert.equal(policy.requiredBasename, 'config.toml')
  assert.ok(policy.forbiddenBasenames.includes('auth.json'))
  assert.ok(policy.guarantees.includes('never-writes-auth-json'))
  assert.ok(policy.guarantees.includes('never-restarts-client'))
  assert.ok(policy.notCovered.some((t) => t.includes('model_providers.openai')))
})

test('模块自身不读 HOME、不触网、不碰 auth.json 内容', () => {
  const src = readFileSync(join(ROOT, 'src/codex/config.js'), 'utf8')
  assert.doesNotMatch(src, /from 'node:os'/, 'must not import node:os (no HOME inference)')
  assert.doesNotMatch(src, /homedir\(/, 'must not call homedir()')
  assert.doesNotMatch(src, /from 'node:https?'/, 'must not import http modules')
  assert.doesNotMatch(src, /process\.env\.HOME/, 'must not read HOME from env')
  assert.doesNotMatch(src, /JWT|refresh_token|access_token|id_token/i, 'must not handle credential material')
})

test('mergeOwnedFields：只改 owned 行，未知字段/MCP/projects/权限/注释逐字节保留', () => {
  const before = USER_CONFIG
  const merged = mergeOwnedFields(before, desiredFor())
  const after = merged.text

  assert.match(after, /^model = "mg\/gpt-5-aggregate"$/m)
  assert.match(after, /^model_provider = "openai"$/m)
  assert.match(after, /^openai_base_url = "http:\/\/127\.0\.0\.1:18999"$/m)
  assert.match(after, /^model_catalog_json = "\/tmp\/mg-catalog\/codex-catalog\.json"$/m)

  // 非所有权内容全部保留
  for (const line of [
    '# 用户自己的 Codex 配置（测试 fixture，全部位于临时目录）',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '[features]',
    'multi_agent = true',
    '[mcp_servers.docs]',
    'command = "node"',
    'args = ["mcp-docs.js"]',
    '[projects."/home/dev/proj"]',
    'trust_level = "trusted"',
    '[model_providers.myproxy]',
    'base_url = "https://proxy.example/v1"',
    'wire_api = "responses"',
  ]) {
    assert.ok(after.includes(line), 'preserved line missing: ' + line)
  }
  // 未管理的行完全一致（指纹自证）
  assert.equal(unmanagedFingerprint(after), unmanagedFingerprint(before))
  // 不生成 reserved built-in provider 覆盖段
  assert.doesNotMatch(after, /\[model_providers\.openai\]/)
  // model_provider 原值相同 → 不算变更
  assert.ok(!merged.changed.some((c) => c.path === 'model_provider'))
  assert.deepEqual(merged.changed.map((c) => c.path).sort(), ['model', 'model_catalog_json', 'openai_base_url'])
  // 幂等：对结果再合并同一 desired 不产生改动
  const again = mergeOwnedFields(after, desiredFor())
  assert.equal(again.text, after)
  assert.equal(again.changed.length, 0)
})

test('mergeOwnedFields：diff 展示原值，保留用户已有的 openai_base_url', () => {
  const before = USER_CONFIG.replace('model_provider = "openai"', 'model_provider = "openai"\nopenai_base_url = "https://old.example"')
  const merged = mergeOwnedFields(before, desiredFor())
  const changed = merged.changed.find((c) => c.path === 'openai_base_url')
  assert.ok(changed, 'openai_base_url should be reported as changed')
  assert.equal(changed.from, '"https://old.example"')
  assert.match(merged.text, /^openai_base_url = "http:\/\/127\.0\.0\.1:18999"$/m)
  assert.equal((merged.text.match(/^openai_base_url/gm) || []).length, 1, 'must not duplicate the key')
})

test('diffConfigText：行级前后差异 + 字段所有者标注', () => {
  const merged = mergeOwnedFields(USER_CONFIG, desiredFor())
  const rows = diffConfigText(USER_CONFIG, merged.text)
  const del = rows.filter((r) => r.kind === 'del')
  const add = rows.filter((r) => r.kind === 'add')
  assert.deepEqual(del.map((r) => r.text), ['model = "gpt-5"'])
  assert.equal(del[0].owner, 'modelgate')
  assert.deepEqual(add.map((r) => r.text).sort(), [
    'model = "mg/gpt-5-aggregate"',
    'model_catalog_json = "/tmp/mg-catalog/codex-catalog.json"',
    'openai_base_url = "http://127.0.0.1:18999"',
  ].sort())
  for (const r of add) assert.equal(r.owner, 'modelgate')
  const externalAdds = rows.filter((r) => r.kind === 'add' && r.owner !== 'modelgate')
  assert.deepEqual(externalAdds, [])
  const sameMcp = rows.find((r) => r.kind === 'same' && r.text === 'command = "node"')
  assert.equal(sameMcp.owner, 'external')
  const sameModelProvider = rows.find((r) => r.kind === 'same' && r.text === 'model_provider = "openai"')
  assert.equal(sameModelProvider.owner, 'modelgate')
})

test('解析器：分段/键定位/多行值识别/summarizePreserved', () => {
  const doc = parseConfigDocument(USER_CONFIG)
  assert.deepEqual(doc.sections.map((s) => s.name), ['features', 'mcp_servers.docs', 'projects."/home/dev/proj"', 'model_providers.myproxy'])
  const top = doc.meta.filter((m) => m.kind === 'entry' && m.sectionName === '')
  assert.deepEqual(top.map((m) => m.key), ['model', 'model_provider', 'approval_policy', 'sandbox_mode'])
  const multi = parseConfigDocument('a = [\n  1,\n]\n')
  assert.equal(multi.meta[0].multiline, true)
  assert.equal(parseConfigDocument('a = [1, 2]').meta[0].multiline, false)
  const preserved = summarizePreserved(USER_CONFIG)
  assert.deepEqual(preserved.topLevelKeys, ['approval_policy', 'sandbox_mode'])
  assert.deepEqual(preserved.mcpServers, ['docs'])
  assert.equal(preserved.hasProjects, true)
  assert.equal(preserved.hasPermissions, false)
  assert.deepEqual(preserved.reservedOverrides, [])
})

test('路径护栏：拒绝相对路径、非 config.toml、auth.json、符号链接', () => {
  expectCode(() => assertConfigPath(''), 'invalid_path')
  expectCode(() => assertConfigPath('./config.toml'), 'invalid_path')
  expectCode(() => assertConfigPath('/tmp/x/auth.json'), 'forbidden_path')
  expectCode(() => assertConfigPath('/tmp/x/gateway.json'), 'invalid_path')
  expectCode(() => snapshotConfigFile('/tmp/x/auth.json'), 'forbidden_path')
  // 放行非标准文件名的开关也不放行 auth.json
  expectCode(() => assertConfigPath('/tmp/x/auth.json', { allowNonStandardName: true }), 'forbidden_path')
  // 非 .toml 扩展名在放行模式下仍被拒绝
  expectCode(() => assertConfigPath('/tmp/x/config.txt', { allowNonStandardName: true }), 'invalid_path')
})

test('路径护栏：符号链接指向的 config.toml 拒绝写入', async () => {
  const f = await fixture()
  const linkDir = await mkdtemp(join(tmpdir(), 'mg-codex-link-'))
  const link = join(linkDir, 'config.toml')
  await symlink(f.path, link)
  try {
    expectCode(() => assertConfigPath(link), 'symlink_refused')
    expectCode(() => planConfigApply({ path: link, desired: desiredFor() }), 'symlink_refused')
  } finally {
    await rm(linkDir, { recursive: true, force: true })
    await f.cleanup()
  }
})

test('拒绝整文件覆盖：非所有权字段、多行值、重复键、未知段', () => {
  expectCode(() => mergeOwnedFields(USER_CONFIG, { topLevel: { approval_policy: 'never' } }), 'not_owned_field')
  expectCode(() => mergeOwnedFields(USER_CONFIG, { topLevel: { sandbox_mode: 'danger-full-access' } }), 'not_owned_field')
  expectCode(() => mergeOwnedFields(USER_CONFIG, { sections: { mcp_servers: { docs: 'x' } } }), 'not_owned_field')
  expectCode(() => mergeOwnedFields(USER_CONFIG, { sections: { features: { model_catalog_in_context: true } } }), 'not_owned_field')
  expectCode(() => mergeOwnedFields('model = [\n  "a",\n]\n', { topLevel: { model: 'b' } }), 'multiline_value')
  expectCode(() => mergeOwnedFields('model = "a"\nmodel = "b"\n', { topLevel: { model: 'c' } }), 'duplicate_key')
  expectCode(() => mergeOwnedFields('[[features]]\nmulti_agent = true\n', { sections: { features: { multi_agent_v2: true } } }), 'unsupported_layout')
  expectCode(() => mergeOwnedFields('[features]\n[features]\n', { sections: { features: { multi_agent: true } } }), 'duplicate_section')
  expectCode(() => mergeOwnedFields(USER_CONFIG, { topLevel: { model: { nested: true } } }), 'unsupported_value')
})

test('features 段：白名单键可写，且不改其它 feature', () => {
  const merged = mergeOwnedFields(USER_CONFIG, { sections: { features: { multi_agent: false, multi_agent_v2: true } } })
  assert.match(merged.text, /^multi_agent = false$/m)
  assert.match(merged.text, /^multi_agent_v2 = true$/m)
  assert.equal(unmanagedFingerprint(merged.text), unmanagedFingerprint(USER_CONFIG))
  assert.deepEqual(merged.changed.map((c) => c.path).sort(), ['features.multi_agent', 'features.multi_agent_v2'])
})

test('planConfigApply：纯预览默认不回传正文，includeTexts 才返回', async () => {
  const f = await fixture()
  try {
    const plan = planConfigApply({ path: f.path, desired: desiredFor() })
    assert.equal(plan.ok, true)
    assert.equal(plan.contract, CONFIG_CONTRACT)
    assert.equal(plan.path, f.path)
    assert.equal(plan.before.exists, true)
    assert.equal(plan.before.sha256, sha256Hex(f.text))
    assert.equal(plan.before.sha256.length, 64)
    assert.equal(Object.prototype.hasOwnProperty.call(plan, 'afterText'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(plan, 'beforeText'), false)
    assert.equal(typeof plan.confirmToken, 'string')
    assert.equal(plan.confirmToken.length, 64)
    assert.equal(plan.requiresConfirmation, true)
    assert.equal(plan.backupPath, f.path + '.bak')
    assert.equal(plan.existing.topLevel.model.raw, '"gpt-5"')
    assert.deepEqual(plan.preserved.mcpServers, ['docs'])
    assert.ok(Array.isArray(plan.diff) && plan.diff.length > 0)
    const full = planConfigApply({ path: f.path, desired: desiredFor(), includeTexts: true })
    assert.equal(full.afterText, mergeOwnedFields(f.text, desiredFor()).text)
  } finally { await f.cleanup() }
})

test('写入门禁：缺快照/缺确认令牌/错令牌一律拒绝，且不改文件', async () => {
  const f = await fixture()
  try {
    const plan = planConfigApply({ path: f.path, desired: desiredFor() })
    const beforeBytes = await readFile(f.path, 'utf8')
    expectCode(() => applyConfigChange({ path: f.path, desired: desiredFor(), confirmToken: plan.confirmToken }), 'snapshot_required')
    expectCode(() => applyConfigChange({ path: f.path, desired: desiredFor(), expected: plan.before }), 'confirmation_required')
    expectCode(() => applyConfigChange({ path: f.path, desired: desiredFor(), expected: plan.before, confirmToken: 'deadbeef' }), 'confirmation_required')
    assert.equal(await readFile(f.path, 'utf8'), beforeBytes)
    assert.deepEqual((await readdir(f.dir)).sort(), ['config.toml'])
  } finally { await f.cleanup() }
})

test('并发冲突：预览后外部修改被拦截（sha256 / size / exists）', async () => {
  const f = await fixture()
  try {
    const plan = planConfigApply({ path: f.path, desired: desiredFor() })
    await writeFile(f.path, f.text + '\n# 外部程序刚写入的一行\n', 'utf8')
    expectCode(() => applyConfigChange({
      path: f.path,
      desired: desiredFor(),
      expected: plan.before,
      confirmToken: plan.confirmToken,
    }), 'concurrent_modification')
    const tampered = await readFile(f.path, 'utf8')
    assert.ok(tampered.includes('外部程序刚写入'), 'external edit must survive (no overwrite)')
    assert.ok(!tampered.includes('mg/gpt-5-aggregate'), 'no partial write on conflict')
    // size 不一致同样拦截
    expectCode(() => applyConfigChange({
      path: f.path,
      desired: desiredFor(),
      expected: { exists: true, size: plan.before.size, sha256: sha256Hex(tampered) },
      confirmToken: plan.confirmToken,
    }), 'concurrent_modification')
    // 文件被删除也拦截
    await rm(f.path)
    expectCode(() => applyConfigChange({
      path: f.path,
      desired: desiredFor(),
      expected: plan.before,
      confirmToken: plan.confirmToken,
    }), 'concurrent_modification')
  } finally { await f.cleanup() }
})

test('写入成功：原子替换、无 tmp 残留、.bak 保留旧内容、模式保留、读回校验', async () => {
  const f = await fixture()
  try {
    await chmod(f.path, 0o640)
    const plan = planConfigApply({ path: f.path, desired: desiredFor() })
    const result = applyConfigChange({ path: f.path, desired: desiredFor(), expected: plan.before, confirmToken: plan.confirmToken })
    assert.equal(result.ok, true)
    assert.equal(result.before.sha256, plan.before.sha256)
    assert.equal(result.after.sha256, plan.after.sha256)
    assert.equal(result.backupPath, f.path + '.bak')

    const entries = (await readdir(f.dir)).sort()
    assert.deepEqual(entries, ['config.toml', 'config.toml.bak'], 'no tmp leftovers: ' + entries.join(','))
    assert.equal(await readFile(f.path + '.bak', 'utf8'), USER_CONFIG)
    const after = await readFile(f.path, 'utf8')
    assert.equal(sha256Hex(after), plan.after.sha256)
    assert.ok(after.includes('mg/gpt-5-aggregate'))
    // 非所有权内容在真实写入后仍然存在
    for (const needle of ['[mcp_servers.docs]', 'trust_level = "trusted"', 'approval_policy = "on-request"', '[model_providers.myproxy]']) {
      assert.ok(after.includes(needle), 'preserved after write: ' + needle)
    }
    assert.equal(unmanagedFingerprint(after), unmanagedFingerprint(USER_CONFIG))
    const st = await readFile(f.path)
    assert.ok(st.length > 0)
    // 模式保留（0640）
    const { stat } = await import('node:fs/promises')
    const mode = (await stat(f.path)).mode & 0o777
    assert.equal(mode, 0o640, 'file mode preserved, got ' + mode.toString(8))
  } finally { await f.cleanup() }
})

test('备份轮转：连续两次写入保留 .bak 与 .bak.prev', async () => {
  const f = await fixture()
  try {
    const p1 = planConfigApply({ path: f.path, desired: desiredFor() })
    applyConfigChange({ path: f.path, desired: desiredFor(), expected: p1.before, confirmToken: p1.confirmToken })
    const firstAfter = await readFile(f.path, 'utf8')

    const p2 = planConfigApply({ path: f.path, desired: desiredFor({ model: 'mg/other' }) })
    applyConfigChange({ path: f.path, desired: desiredFor({ model: 'mg/other' }), expected: p2.before, confirmToken: p2.confirmToken })

    assert.equal(await readFile(f.path + '.bak', 'utf8'), firstAfter)
    assert.equal(await readFile(f.path + '.bak.prev', 'utf8'), USER_CONFIG)
  } finally { await f.cleanup() }
})

test('回滚：恢复完全一致的原文件，并把回滚前状态另存 .bak.pre-rollback', async () => {
  const f = await fixture()
  try {
    const plan = planConfigApply({ path: f.path, desired: desiredFor() })
    const applied = applyConfigChange({ path: f.path, desired: desiredFor(), expected: plan.before, confirmToken: plan.confirmToken })

    const r0 = planRollback({ path: f.path, backupPath: applied.backupPath })
    assert.equal(r0.ok, true)
    assert.equal(r0.restore.sha256, sha256Hex(USER_CONFIG))
    expectCode(() => rollbackConfigChange({ path: f.path, backupPath: applied.backupPath, confirmToken: 'nope' }), 'confirmation_required')
    expectCode(() => rollbackConfigChange({ path: f.path, backupPath: applied.backupPath, expectedSha256: plan.before.sha256, confirmToken: r0.confirmToken }), 'concurrent_modification')

    const restored = rollbackConfigChange({ path: f.path, backupPath: applied.backupPath, expectedSha256: applied.after.sha256, confirmToken: r0.confirmToken })
    assert.equal(restored.ok, true)
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG)
    assert.equal(restored.after.sha256, sha256Hex(USER_CONFIG))
    const pre = await readFile(f.path + '.bak.pre-rollback', 'utf8')
    assert.ok(pre.includes('mg/gpt-5-aggregate'), 'pre-rollback snapshot keeps the applied state')
  } finally { await f.cleanup() }
})

test('回滚：备份不存在时明确报错，不写文件', async () => {
  const f = await fixture()
  try {
    expectCode(() => planRollback({ path: f.path }), 'backup_not_found')
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG)
  } finally { await f.cleanup() }
})

test('写失败可恢复：目录不可写时原文件零改动', async (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root 会绕过目录权限'); return }
  const f = await fixture()
  try {
    const plan = planConfigApply({ path: f.path, desired: desiredFor() })
    await chmod(f.dir, 0o500)
    let code = null
    try {
      applyConfigChange({ path: f.path, desired: desiredFor(), expected: plan.before, confirmToken: plan.confirmToken })
    } catch (e) {
      assert.ok(e instanceof ConfigError)
      code = e.code
    }
    await chmod(f.dir, 0o700)
    assert.ok(code === 'backup_failed' || code === 'write_failed', 'expected backup/write failure, got ' + code)
    assert.equal(await readFile(f.path, 'utf8'), USER_CONFIG, 'original file must be untouched on failure')
    const entries = (await readdir(f.dir)).sort()
    assert.deepEqual(entries, ['config.toml'], 'no partial artifacts: ' + entries.join(','))
  } finally { await f.cleanup() }
})

test('allowCreate：不存在时默认拒绝，显式放行则创建 0600 新文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-new-'))
  const path = join(dir, 'config.toml')
  try {
    expectCode(() => planConfigApply({ path, desired: desiredFor() }), 'config_not_found')
    assert.deepEqual(await readdir(dir), [])
    const plan = planConfigApply({ path, desired: desiredFor(), allowCreate: true })
    assert.equal(plan.before.exists, false)
    assert.equal(plan.before.sha256, '')
    const result = applyConfigChange({ path, desired: desiredFor(), expected: plan.before, confirmToken: plan.confirmToken, allowCreate: true })
    assert.equal(result.ok, true)
    assert.equal(result.backupPath, null, 'no backup when there was no previous file')
    const text = await readFile(path, 'utf8')
    assert.match(text, /^model_provider = "openai"$/m)
    assert.match(text, /^openai_base_url = "http:\/\/127\.0\.0\.1:18999"$/m)
    assert.doesNotMatch(text, /\[model_providers\.openai\]/)
    const { stat } = await import('node:fs/promises')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('既有 [model_providers.openai] 段：告警但不删改（客户端会因此启动失败）', async () => {
  const text = USER_CONFIG + '\n[model_providers.openai]\nbase_url = "https://legacy.example"\n'
  const f = await fixture(text)
  try {
    const plan = planConfigApply({ path: f.path, desired: desiredFor() })
    assert.deepEqual(plan.preserved.reservedOverrides, ['model_providers.openai'])
    assert.ok(plan.warnings.some((w) => w.includes('reserved built-in provider ID')), 'warning: ' + plan.warnings.join(' | '))
    const merged = mergeOwnedFields(text, desiredFor())
    assert.ok(merged.text.includes('[model_providers.openai]'), 'existing override must be preserved verbatim')
    assert.ok(merged.text.includes('base_url = "https://legacy.example"'))
    assert.equal(unmanagedFingerprint(merged.text), unmanagedFingerprint(text))
  } finally { await f.cleanup() }
})

test('CRLF 与无结尾换行：换行风格与文件结构不被破坏', async () => {
  const crlf = USER_CONFIG.replace(/\n/g, '\r\n')
  const f1 = await fixture(crlf)
  try {
    const merged = mergeOwnedFields(crlf, desiredFor())
    assert.ok(merged.text.includes('\r\n'))
    assert.doesNotMatch(merged.text, /(^|[^\r])\n/, 'no lone LF in CRLF file')
    assert.equal((merged.text.match(/\r\n/g) || []).length, merged.text.split('\r\n').length - 1)
    const plan = planConfigApply({ path: f1.path, desired: desiredFor() })
    const result = applyConfigChange({ path: f1.path, desired: desiredFor(), expected: plan.before, confirmToken: plan.confirmToken })
    assert.equal(result.ok, true)
    const after = await readFile(f1.path, 'utf8')
    assert.ok(after.includes('\r\n'), 'CRLF preserved')
    assert.doesNotMatch(after, /[^\r]\n/, 'no lone LF introduced')
  } finally { await f1.cleanup() }

  const noTrailingNewline = 'model = "gpt-5"\nmodel_provider = "openai"'
  const merged = mergeOwnedFields(noTrailingNewline, desiredFor())
  assert.match(merged.text, /^model = "mg\/gpt-5-aggregate"$/m)
  assert.match(merged.text, /^openai_base_url = /m)
  const f2 = await fixture(noTrailingNewline)
  try {
    const plan = planConfigApply({ path: f2.path, desired: desiredFor() })
    applyConfigChange({ path: f2.path, desired: desiredFor(), expected: plan.before, confirmToken: plan.confirmToken })
    const after = await readFile(f2.path, 'utf8')
    assert.equal(parseConfigDocument(after).sections.length, 0, 'no phantom section')
    assert.match(after, /^model_catalog_json = /m)
  } finally { await f2.cleanup() }
})

test('D1-A 目标配置：openai_base_url 指向网关、无 [model_providers.openai]、风险如实说明', () => {
  const built = buildDesiredCodexConfig({
    gatewayBaseUrl: 'http://127.0.0.1:8787/v1',
    model: 'mg/gpt-5-aggregate',
    modelCatalogJsonPath: '/home/u/.model-gateway/codex-catalog.json',
    features: { multi_agent_v2: true },
  })
  assert.equal(built.openaiBaseUrl, 'http://127.0.0.1:8787', '/v1 must be stripped: client appends /v1/...')
  assert.equal(built.desired.topLevel.model_provider, 'openai')
  assert.equal(built.desired.topLevel.openai_base_url, 'http://127.0.0.1:8787')
  assert.equal(built.desired.topLevel.model, 'mg/gpt-5-aggregate')
  assert.equal(built.desired.topLevel.model_catalog_json, '/home/u/.model-gateway/codex-catalog.json')
  assert.deepEqual(built.desired.sections, { features: { multi_agent_v2: true } })
  assert.equal(Object.prototype.hasOwnProperty.call(built.desired, 'modelProviders'), false, 'must not emit [model_providers.openai]')
  const risks = built.risks.join('\n')
  assert.match(risks, /reserved built-in provider ID/)
  assert.match(risks, /openai_base_url/)
  assert.match(risks, /\/v1\/models\?client_version/)
  assert.match(risks, /WebSocket/)
  assert.match(risks, /zstd/)
  assert.match(risks, /chatgpt-account-id/)
  assert.match(risks, /不重启/)
  // 缺 model 时报错，不生成半成品
  expectCode(() => buildDesiredCodexConfig({ gatewayBaseUrl: 'http://127.0.0.1:8787' }), 'invalid_desired')
  expectCode(() => buildDesiredCodexConfig({ gatewayBaseUrl: 'ftp://x', model: 'm' }), 'invalid_desired')
  // 生成的 desired 可直接合并
  const merged = mergeOwnedFields(USER_CONFIG, built.desired)
  assert.equal(unmanagedFingerprint(merged.text), unmanagedFingerprint(USER_CONFIG))
  assert.match(merged.text, /multi_agent_v2 = true/)
})

test('readOwnedFields：报告既有值，供 diff/确认页面展示', async () => {
  const text = 'model = "gpt-5"\nmodel_provider = "custom"\nopenai_base_url = "https://old.example"\n\n[features]\nmulti_agent_v2 = false\n'
  const owned = readOwnedFields(text)
  assert.equal(owned.topLevel.model.raw, '"gpt-5"')
  assert.equal(owned.topLevel.model_provider.raw, '"custom"')
  assert.equal(owned.topLevel.openai_base_url.raw, '"https://old.example"')
  assert.equal(owned.topLevel.model_catalog_json.present, false)
  assert.equal(owned.sections.features.present, true)
  assert.equal(owned.sections.features.keys.multi_agent_v2.raw, 'false')
  assert.equal(owned.sections.features.keys.multi_agent.present, false)
})

test('snapshotConfigFile：不存在时返回 exists=false，不改任何东西', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-codex-snap-'))
  try {
    const snap = snapshotConfigFile(join(dir, 'config.toml'))
    assert.equal(snap.exists, false)
    assert.equal(snap.size, 0)
    assert.equal(snap.sha256, '')
    assert.deepEqual(await readdir(dir), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// —— UI 侧的纯函数（src/ui-next/js/views/codex.js）：不触 DOM、不请求、不读后端 ——
import * as uiCodex from '../../../src/ui-next/js/views/codex.js'

test('UI 模板：D1-A 只写 openai_base_url 系字段，绝不生成 [model_providers.openai]', () => {
  const tpl = uiCodex.codexIdentityTemplate({
    openaiBaseUrl: 'http://127.0.0.1:8787',
    model: 'mg/gpt-5-aggregate',
    modelCatalogJsonPath: '/home/u/.model-gateway/codex-catalog.json',
    features: { multi_agent_v2: true },
  })
  assert.match(tpl, /^model_provider = "openai"$/m)
  assert.match(tpl, /^openai_base_url = "http:\/\/127\.0\.0\.1:8787"$/m)
  assert.match(tpl, /^model = "mg\/gpt-5-aggregate"$/m)
  assert.match(tpl, /^model_catalog_json = "\/home\/u\/\.model-gateway\/codex-catalog\.json"$/m)
  assert.match(tpl, /^\[features\]$/m)
  assert.match(tpl, /^multi_agent_v2 = true$/m)
  assert.doesNotMatch(tpl, /^\s*\[model_providers\.openai\]/m, 'reserved built-in provider ID must not be emitted')
  assert.doesNotMatch(tpl, /api[_-]?key|bearer|sk-/i, 'template must contain no credential material')
  // 模板中非注释行必须全部在所有权声明内
  const owned = new Set(['model_provider', 'openai_base_url', 'model', 'model_catalog_json', 'multi_agent_v2'])
  const kvLines = tpl.split('\n').filter((l) => /^[A-Za-z0-9_-]+\s*=/.test(l.trim()))
  assert.ok(kvLines.length >= 4)
  for (const line of kvLines) assert.ok(owned.has(line.split('=')[0].trim()), 'unexpected owned key in template: ' + line)
})

test('UI 预览：逐字段 add/replace/same + 保留项 + reserved 段阻断，且不生成整份文件', () => {
  const pasted = [
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
  ].join('\n')
  const preview = uiCodex.previewOwnedChange(pasted, {
    openaiBaseUrl: 'http://127.0.0.1:8787',
    model: 'mg/gpt-5-aggregate',
    modelCatalogJsonPath: '/abs/catalog.json',
  })
  assert.equal(preview.ok, true)
  const byPath = Object.fromEntries(preview.rows.map((r) => [r.path, r]))
  assert.equal(byPath.model.kind, 'replace')
  assert.equal(byPath.model.from, '"gpt-5"')
  assert.equal(byPath.model.to, '"mg/gpt-5-aggregate"')
  assert.equal(byPath.model.line, 1)
  assert.equal(byPath.model_provider.kind, 'same')
  assert.equal(byPath.openai_base_url.kind, 'add')
  assert.equal(byPath.openai_base_url.line, null)
  assert.equal(byPath.model_catalog_json.kind, 'add')
  // 只读保留：顶层未知字段、MCP 段
  assert.deepEqual(preview.preserved.topLevelKeys, ['approval_policy'])
  assert.deepEqual(preview.preserved.mcpServers, ['docs'])
  assert.equal(Object.prototype.hasOwnProperty.call(preview, 'afterText'), false, 'UI must not fabricate a merged file')
  assert.deepEqual(preview.blocked, [])
  // 空输入不编造差异
  assert.equal(uiCodex.previewOwnedChange('', {}).empty, true)
})

test('UI 预览：既有 [model_providers.openai] 直接阻断（客户端会启动失败）', () => {
  const pasted = 'model = "gpt-5"\n\n[model_providers.openai]\nbase_url = "https://legacy.example"\n'
  const preview = uiCodex.previewOwnedChange(pasted, { openaiBaseUrl: 'http://127.0.0.1:8787', model: 'mg/x' })
  assert.equal(preview.ok, false)
  assert.equal(preview.blocked.length, 1)
  assert.match(preview.blocked[0], /reserved built-in provider ID/)
  assert.match(preview.blocked[0], /手工移除/)
})

test('UI 扫描：顶层键与段内键分离，行号从 1 开始', () => {
  const scan = uiCodex.scanConfigText('a = "1"\n\n[features]\nb = true\n\n[mcp_servers.x]\nc = "3"\n')
  assert.deepEqual(scan.topLevel.map((e) => e.key), ['a'])
  assert.deepEqual(scan.sections.map((s) => s.name), ['features', 'mcp_servers.x'])
  assert.equal(scan.sectionMap.features.keys[0].key, 'b')
  assert.equal(scan.sectionMap.features.keys[0].line, 4)
  assert.equal(scan.reservedOverride, null)
  assert.equal(scan.lineCount, 7)
})

test('UI 目录世代/写盘能力：只认真实字段，缺失即 UNKNOWN（不编造）', async () => {
  // 先固定探测结果：本测试不联网，探测必然失败 → 写盘能力必须回落 export-only
  uiCodex.resetCodexApiProbe()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('offline test') }
  try {
    await uiCodex.probeCodexPolicy({ force: true })
  } finally {
    globalThis.fetch = realFetch
  }
  const unknown = uiCodex.catalogState({})
  assert.equal(unknown.known, false)
  assert.equal(unknown.label, 'UNKNOWN')
  assert.match(unknown.detail, /不要把它当成/)
  assert.equal(uiCodex.catalogState(null).known, false)
  // 有目录对象但缺 generation → 仍 UNKNOWN
  assert.equal(uiCodex.catalogState({ codex: { catalog: { path: '/x' } } }).known, false)
  const known = uiCodex.catalogState({ codex: { catalog: { generation: 7, modelCount: 12, loadedAt: '2026-11-11T00:00:00Z' } } })
  assert.equal(known.known, true)
  assert.equal(known.label, 'GEN 7')
  assert.equal(known.modelCount, 12)

  const notReady = uiCodex.writePathState({})
  assert.equal(notReady.ready, false)
  assert.match(notReady.label, /仅导出/)
  // 写盘能力的唯一判据是 /api/codex/policy 探测；探测失败时即便 /api/status 声称有路由也不放行
  assert.equal(uiCodex.writePathState({ codex: { configRoutes: { plan: true, apply: true } } }).ready, false)
  uiCodex.resetCodexApiProbe()
})

test('UI 导出计划：export-only 契约，不含任何凭据字段', () => {
  const plan = uiCodex.codexExportPlan({
    openaiBaseUrl: 'http://127.0.0.1:8787',
    model: 'mg/x',
    modelCatalogJsonPath: '/abs/catalog.json',
    features: { multi_agent_v2: true },
  })
  assert.equal(plan.contract, 'mg-codex-ui/1')
  assert.equal(plan.serverContract, 'mg-codex-config/1')
  assert.match(plan.writePolicy, /export-only/)
  assert.equal(plan.desired.topLevel.openai_base_url, 'http://127.0.0.1:8787')
  assert.equal(plan.fileHash, null)
  assert.match(plan.fileHashNote, /浏览器无法读取/)
  assert.ok(plan.notices.some((t) => /reserved built-in provider ID/.test(t)))
  assert.ok(plan.notices.some((t) => /WebSocket/.test(t)))
  assert.ok(plan.notices.some((t) => /zstd/.test(t)))
  assert.ok(plan.notRun.length >= 3)
  const serialized = JSON.stringify(plan)
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]|Bearer [A-Za-z0-9]/, 'plan must not carry credential material')
})

test('UI 字段所有权表覆盖三类所有者，含禁止触碰项', () => {
  const owners = new Set(uiCodex.FIELD_OWNERS.map((f) => f.owner))
  assert.ok(owners.has('modelgate'))
  assert.ok(owners.has('external'))
  assert.ok(owners.has('external-forbidden'))
  assert.ok(uiCodex.FIELD_OWNERS.some((f) => f.path === 'openai_base_url' && f.owner === 'modelgate'))
  assert.ok(uiCodex.FIELD_OWNERS.some((f) => f.path === 'auth.json' && f.owner === 'external-forbidden'))
  assert.ok(uiCodex.FIELD_OWNERS.some((f) => f.path === '[model_providers.openai]' && f.owner === 'external-forbidden'))
  assert.equal(uiCodex.ownerLabel('modelgate').label, '受控可写')
  assert.equal(uiCodex.ownerLabel('external').label, '只读保留')
})
