import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  HARNESS_ADAPTER_CONTRACT, listHarnessAdapters, detectHarnesses,
  previewHarnessConfig, applyHarnessConfig, rollbackHarnessConfig,
} from '../../../src/resources/harness-adapters.js'

const ENDPOINT = 'http://127.0.0.1:8787'
const SECRET = 'sk-harness-canary-do-not-write'

function temporaryRoot (t, label = 'harness') {
  const root = mkdtempSync(join(tmpdir(), 'mg-' + label + '-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write (path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, value, { mode })
}

function sha (value) {
  return createHash('sha256').update(value).digest('hex')
}

function throwsCode (fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code)
    return true
  })
}

function filesUnder (root) {
  const out = []
  function visit (directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) out.push(path)
      else if (stat.isDirectory()) visit(path)
      else out.push(path)
    }
  }
  visit(root)
  return out
}

function assertCanaryAbsent (root, canary = SECRET) {
  for (const path of filesUnder(root)) {
    if (lstatSync(path).isSymbolicLink()) continue
    assert.equal(readFileSync(path).includes(canary), false, 'secret leaked into ' + path)
  }
}

function previewOptions (harnessId, managedRoot, extra = {}) {
  return { harnessId, managedRoot, endpoint: ENDPOINT, apiKeyEnv: 'MODELGATE_API_KEY', ...extra }
}

test('Harness registry：四个独立 adapter，xmxz unsupported，协议只标 fixture/not-real', () => {
  const adapters = listHarnessAdapters()
  assert.deepEqual(adapters.map((item) => item.harnessId), ['claude-code', 'opencode', 'dsh', 'xmxz'])
  assert.equal(HARNESS_ADAPTER_CONTRACT, 'mg-harness-adapters/1')
  for (const adapter of adapters.slice(0, 3)) {
    assert.equal(adapter.status, 'supported')
    assert.equal(adapter.verification.configuration, 'fixture-verified')
    assert.equal(adapter.verification.realClient, 'not-real-tested')
    assert.equal(adapter.verification.realProtocol, 'not-real-tested')
    assert.ok(adapter.protocols.length > 0)
    for (const protocol of adapter.protocols) {
      assert.equal(protocol.configuration, 'fixture-verified')
      assert.equal(protocol.runtime, 'not-real-tested')
    }
  }
  const xmxz = adapters.at(-1)
  assert.equal(xmxz.status, 'unsupported')
  assert.equal(xmxz.config, null)
  assert.deepEqual(xmxz.protocols, [])
  assert.match(xmxz.reason, /ProviderProfile/)
  assert.match(xmxz.reason, /owner config 完整 schema\/加载器缺失/)
  assert.equal(listHarnessAdapters({ includeUnsupported: false }).length, 3)
})

test('默认检测只取 HOME 下配置存在性，不读取或返回正文/凭据', (t) => {
  const home = temporaryRoot(t, 'harness-home')
  write(join(home, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET } }))
  write(join(home, '.config/opencode/opencode.jsonc'), '{"providers":{"private":{"options":{"apiKey":"' + SECRET + '"}}}}')
  write(join(home, '.dsh/profiles/default/cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      private:\n        apiKey: ' + SECRET + '\n')

  const detected = detectHarnesses({ home })
  assert.equal(detected.length, 4)
  assert.equal(detected.find((item) => item.harnessId === 'claude-code').detection.state, 'detected')
  assert.equal(detected.find((item) => item.harnessId === 'opencode').detection.state, 'detected')
  assert.equal(detected.find((item) => item.harnessId === 'dsh').detection.state, 'detected')
  assert.equal(detected.find((item) => item.harnessId === 'xmxz').detection.state, 'unsupported')
  const rendered = JSON.stringify(detected)
  assert.equal(rendered.includes(SECRET), false)
  assert.equal(rendered.includes('ANTHROPIC_AUTH_TOKEN'), false)
  assert.equal(rendered.includes('providers'), false)
  assert.equal(detected.find((item) => item.harnessId === 'claude-code').detection.configPaths[0].file, true)
})

test('Claude Code：preview/apply/rollback 保留其它设置、仅写环境变量引用、0600 且字节回滚', (t) => {
  const root = temporaryRoot(t, 'harness-claude')
  const path = join(root, '.claude/settings.json')
  const original = Buffer.from('{\r\n  "theme": "dark",\r\n  "env": { "KEEP": "yes" }\r\n}\r\n')
  write(path, original)

  const preview = previewHarnessConfig(previewOptions('claude-code', root))
  assert.equal(preview.contract, HARNESS_ADAPTER_CONTRACT)
  assert.equal(preview.beforeHash, sha(original))
  assert.match(preview.afterHash, /^[a-f0-9]{64}$/)
  assert.match(preview.backupId, /^hbk_/)
  assert.match(preview.confirmToken, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(preview.expectedVersion, 1)
  assert.ok(Date.parse(preview.expiresAt) > Date.now())
  assert.equal(preview.diff.redacted, true)
  assert.equal(preview.diff.valueDisclosure, false)
  assert.ok(preview.diff.added.includes('env.ANTHROPIC_BASE_URL'))
  assert.ok(preview.diff.added.includes('env.ANTHROPIC_AUTH_TOKEN'))
  assert.equal(JSON.stringify(preview).includes(SECRET), false)
  assert.deepEqual(readFileSync(path), original)

  const applied = applyHarnessConfig({ ...preview, managedRoot: root })
  assert.equal(applied.ok, true)
  assert.equal(applied.afterHash, preview.afterHash)
  assert.equal(applied.backupId, preview.backupId)
  assert.equal(applied.needsRestart, true)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(settings.theme, 'dark')
  assert.equal(settings.env.KEEP, 'yes')
  assert.equal(settings.env.ANTHROPIC_BASE_URL, ENDPOINT)
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, '{env:MODELGATE_API_KEY}')
  assert.equal(readFileSync(path, 'utf8').includes(SECRET), false)
  throwsCode(() => applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken }), 'confirm_token_used')

  const store = join(root, '.modelgate-harness-adapters')
  assert.equal(statSync(join(store, preview.backupId + '.bin')).mode & 0o777, 0o600)
  assert.equal(statSync(join(store, preview.backupId + '.json')).mode & 0o777, 0o600)
  const rolledBack = rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId })
  assert.equal(rolledBack.restored, true)
  assert.equal(rolledBack.alreadyRestored, false)
  assert.deepEqual(readFileSync(path), original)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId }).alreadyRestored, true)
})

test('OpenCode：openai-compatible 与 anthropic package、baseURL/env/models 独立写入和回滚', (t) => {
  const root = temporaryRoot(t, 'harness-opencode')
  const path = join(root, '.config/opencode/opencode.json')
  const original = Buffer.from('{"theme":"dark","providers":{"keep":{"name":"Keep","models":{"old":{"name":"Old"}}}}}\n')
  write(path, original)
  const common = previewOptions('opencode', root, {
    providerId: 'modelgate',
    models: ['deepseek-v4.1-flash', { id: 'claude-fixture', name: 'Claude Fixture' }],
  })

  const openai = previewHarnessConfig({ ...common, package: 'openai-compatible' })
  applyHarnessConfig({ ...openai, managedRoot: root })
  let config = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(config.theme, 'dark')
  assert.deepEqual(config.providers.keep.models, { old: { name: 'Old' } })
  assert.equal(config.providers.modelgate.package, '@ai-sdk/openai-compatible')
  assert.equal(config.providers.modelgate.options.baseURL, ENDPOINT)
  assert.equal(config.providers.modelgate.options.apiKey, '{env:MODELGATE_API_KEY}')
  assert.deepEqual(config.providers.modelgate.models, {
    'deepseek-v4.1-flash': { name: 'deepseek-v4.1-flash' },
    'claude-fixture': { name: 'Claude Fixture' },
  })
  assert.equal(readFileSync(path, 'utf8').includes(SECRET), false)
  rollbackHarnessConfig({ managedRoot: root, backupId: openai.backupId })
  assert.deepEqual(readFileSync(path), original)

  const anthropic = previewHarnessConfig({ ...common, package: 'anthropic' })
  applyHarnessConfig({ managedRoot: root, preview: anthropic })
  config = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(config.providers.modelgate.package, '@ai-sdk/anthropic')
  assert.equal(config.providers.modelgate.options.apiKey, '{env:MODELGATE_API_KEY}')
  rollbackHarnessConfig({ managedRoot: root, backupId: anthropic.backupId })
  assert.deepEqual(readFileSync(path), original)
})

test('DSH：cordis patch 数组合并 apiKeyEnv/api/baseURL/models，保留其它条目并精确回滚 CRLF', (t) => {
  const root = temporaryRoot(t, 'harness-dsh')
  const path = join(root, '.dsh/profiles/default/cordis.patch.yml')
  const original = Buffer.from([
    '# existing fixture',
    '- id: agent-default-model',
    '  config:',
    '    provider: keep',
    '    model: keep-model',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      keep:',
    '        apiKeyEnv: KEEP_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://keep.example/v1',
    '        models:',
    '          - id: keep-model',
    '',
  ].join('\r\n'))
  write(path, original)

  const preview = previewHarnessConfig(previewOptions('dsh', root, {
    api: 'openai-responses',
    models: [{ id: 'deepseek-v4.1-flash' }, { id: 'fixture-anthropic', name: 'Fixture Anthropic' }],
  }))
  assert.equal(preview.beforeHash, sha(original))
  assert.ok(preview.diff.added.some((entry) => entry.includes('baseURL')))
  assert.equal(JSON.stringify(preview).includes(SECRET), false)
  applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken })
  const rendered = readFileSync(path, 'utf8')
  assert.match(rendered, /- id: "agent-default-model"/)
  assert.match(rendered, /provider: "keep"/)
  assert.match(rendered, /keep:\r?\n/)
  assert.match(rendered, /apiKeyEnv: "KEEP_API_KEY"/)
  assert.match(rendered, /apiKeyEnv: "MODELGATE_API_KEY"/)
  assert.match(rendered, /api: "openai-responses"/)
  assert.match(rendered, /baseURL: "http:\/\/127\.0\.0\.1:8787"/)
  assert.match(rendered, /- id: "deepseek-v4\.1-flash"/)
  assert.match(rendered, /- id: "fixture-anthropic"/)
  assert.equal(rendered.includes(SECRET), false)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId })
  assert.deepEqual(readFileSync(path), original)
})

test('原本不存在配置：apply 创建 0600 文件，rollback 恢复为不存在', (t) => {
  const root = temporaryRoot(t, 'harness-absent')
  const path = join(root, 'opencode.json')
  const preview = previewHarnessConfig(previewOptions('opencode', root, {
    path: 'opencode.json', package: '@ai-sdk/openai-compatible', models: ['fixture-model'],
  }))
  assert.equal(preview.before.exists, false)
  assert.equal(preview.beforeHash, null)
  assert.equal(preview.expectedVersion, 0)
  assert.ok(preview.diff.added.includes('providers.modelgate.options.baseURL'))
  applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken })
  assert.equal(existsSync(path), true)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId })
  assert.equal(existsSync(path), false)
})

test('写入门禁：preview/apply/rollback 均要求显式 managedRoot', (t) => {
  const root = temporaryRoot(t, 'harness-disabled')
  throwsCode(() => previewHarnessConfig({ harnessId: 'claude-code', endpoint: ENDPOINT }), 'write_disabled')
  throwsCode(() => applyHarnessConfig({ confirmToken: 'x'.repeat(43) }), 'write_disabled')
  throwsCode(() => rollbackHarnessConfig({ backupId: 'hbk_' + 'x'.repeat(22) }), 'write_disabled')
  throwsCode(() => previewHarnessConfig(previewOptions('claude-code', '.', { path: '.claude/settings.json' })), 'invalid_managed_root')
  assert.deepEqual(readdirSync(root), [])
})

test('路径护栏：拒绝越界、符号链接、错误文件名与备份目录', (t) => {
  const root = temporaryRoot(t, 'harness-paths')
  const outside = temporaryRoot(t, 'harness-outside')
  const outsideFile = join(outside, 'settings.json')
  write(outsideFile, '{"safe":true}\n')
  const common = previewOptions('claude-code', root)
  throwsCode(() => previewHarnessConfig({ ...common, path: '../outside/settings.json' }), 'path_traversal')
  throwsCode(() => previewHarnessConfig({ ...common, path: outsideFile }), 'path_traversal')
  throwsCode(() => previewHarnessConfig({ ...common, path: 'settings.local.json' }), 'invalid_path')
  throwsCode(() => previewHarnessConfig({ ...common, path: '.modelgate-harness-adapters/hbk_fixture/settings.json' }), 'forbidden_path')

  mkdirSync(join(root, '.claude'), { recursive: true })
  symlinkSync(outsideFile, join(root, '.claude/settings.json'))
  throwsCode(() => previewHarnessConfig(common), 'symlink_refused')
  unlinkSync(join(root, '.claude/settings.json'))
  symlinkSync(outside, join(root, 'linked'))
  throwsCode(() => previewHarnessConfig({ ...common, path: 'linked/settings.json' }), 'symlink_refused')
  assert.equal(readFileSync(outsideFile, 'utf8'), '{"safe":true}\n')
})

test('内联凭据与任意键：在任何预览/应用写入前拒绝，秘密不落盘', (t) => {
  const root = temporaryRoot(t, 'harness-secrets')
  throwsCode(() => previewHarnessConfig({ ...previewOptions('claude-code', root), apiKey: SECRET }), 'inline_credential_forbidden')
  throwsCode(() => previewHarnessConfig({ ...previewOptions('opencode', root, { models: [{ id: 'fixture', apiKey: SECRET }] }) }), 'inline_credential_forbidden')
  throwsCode(() => previewHarnessConfig({ ...previewOptions('dsh', root, { models: ['fixture'] }), arbitrary: 'value' }), 'invalid_options')
  throwsCode(() => previewHarnessConfig({ ...previewOptions('claude-code', root), endpoint: 'https://user:' + SECRET + '@example.test' }), 'inline_credential_forbidden')
  throwsCode(() => previewHarnessConfig({ ...previewOptions('claude-code', root), endpoint: 'https://example.test/?token=' + SECRET }), 'invalid_endpoint')
  throwsCode(() => previewHarnessConfig({ ...previewOptions('claude-code', root), apiKeyEnv: 'BAD-NAME' }), 'invalid_api_key_env')
  throwsCode(() => previewHarnessConfig({ ...previewOptions('opencode', root, { models: ['fixture'] }), providerId: '__proto__' }), 'invalid_provider_id')

  const preview = previewHarnessConfig(previewOptions('claude-code', root))
  throwsCode(() => applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken, apiKey: SECRET }), 'inline_credential_forbidden')
  assertCanaryAbsent(root)
  assert.deepEqual(readdirSync(root), [])
})

test('apiKeyEnv 只保存变量名：即使进程环境有值，也不读取、不回传、不落盘', (t) => {
  const root = temporaryRoot(t, 'harness-env-ref')
  const previous = process.env.MODELGATE_API_KEY
  process.env.MODELGATE_API_KEY = SECRET
  try {
    const preview = previewHarnessConfig(previewOptions('claude-code', root))
    assert.equal(JSON.stringify(preview).includes(SECRET), false)
    applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken })
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'))
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, '{env:MODELGATE_API_KEY}')
    assertCanaryAbsent(root)
  } finally {
    if (previous === undefined) delete process.env.MODELGATE_API_KEY
    else process.env.MODELGATE_API_KEY = previous
  }
})

test('confirmToken：绑定 before/after hash、版本、root 与 expiry，且一次性消费', (t) => {
  const root = temporaryRoot(t, 'harness-binding')
  const otherRoot = temporaryRoot(t, 'harness-binding-other')
  const options = previewOptions('claude-code', root)
  const preview = previewHarnessConfig(options)
  throwsCode(() => applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken, afterHash: '0'.repeat(64) }), 'preview_binding_mismatch')
  throwsCode(() => applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken, expectedVersion: preview.expectedVersion + 1 }), 'preview_binding_mismatch')
  throwsCode(() => applyHarnessConfig({ managedRoot: otherRoot, confirmToken: preview.confirmToken }), 'preview_binding_mismatch')
  throwsCode(() => applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken, now: Date.parse(preview.expiresAt) + 1 }), 'preview_expired')

  const current = previewHarnessConfig(options)
  write(join(root, '.claude/settings.json'), '{"thirdParty":true}\n')
  throwsCode(() => applyHarnessConfig({ managedRoot: root, confirmToken: current.confirmToken }), 'config_conflict')
  assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf8'), '{"thirdParty":true}\n')

  const fresh = previewHarnessConfig(options)
  const receipt = { ...fresh, afterHash: 'f'.repeat(64) }
  throwsCode(() => applyHarnessConfig({ managedRoot: root, preview: receipt }), 'preview_binding_mismatch')
  applyHarnessConfig({ managedRoot: root, confirmToken: fresh.confirmToken })
  throwsCode(() => applyHarnessConfig({ managedRoot: root, confirmToken: fresh.confirmToken }), 'confirm_token_used')
})

test('预览脱敏：旧配置正文与旧内联 token 不进入回执/diff，apply 不保留旧 token', (t) => {
  const root = temporaryRoot(t, 'harness-redaction')
  const path = join(root, '.claude/settings.json')
  write(path, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET, KEEP: 'yes' }, privateBody: 'do-not-return' }))
  const preview = previewHarnessConfig(previewOptions('claude-code', root))
  const rendered = JSON.stringify(preview)
  assert.equal(rendered.includes(SECRET), false)
  assert.equal(rendered.includes('do-not-return'), false)
  assert.equal(rendered.includes('ANTHROPIC_AUTH_TOKEN'), true)
  applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken })
  const after = readFileSync(path, 'utf8')
  assert.equal(after.includes(SECRET), false)
  assert.equal(after.includes('do-not-return'), true)
  assert.equal(JSON.parse(after).env.ANTHROPIC_AUTH_TOKEN, '{env:MODELGATE_API_KEY}')
})

test('rollback 防覆盖：第三方修改返回 409；恢复 applied hash 后可回滚', (t) => {
  const root = temporaryRoot(t, 'harness-rollback-conflict')
  const path = join(root, '.config/opencode/opencode.json')
  const original = Buffer.from('{"keep":true}\n')
  write(path, original)
  const preview = previewHarnessConfig(previewOptions('opencode', root, { models: ['fixture'] }))
  applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken })
  const applied = readFileSync(path)
  write(path, '{"thirdParty":true}\n')
  throwsCode(() => rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId }), 'rollback_conflict')
  assert.equal(readFileSync(path, 'utf8'), '{"thirdParty":true}\n')
  write(path, applied)
  rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId })
  assert.deepEqual(readFileSync(path), original)
})

test('backup 防篡改：备份字节被替换或符号链接化时拒绝回滚', (t) => {
  const root = temporaryRoot(t, 'harness-backup-guard')
  const path = join(root, '.claude/settings.json')
  write(path, '{"keep":true}\n')
  const preview = previewHarnessConfig(previewOptions('claude-code', root))
  applyHarnessConfig({ managedRoot: root, confirmToken: preview.confirmToken })
  const backup = join(root, '.modelgate-harness-adapters', preview.backupId + '.bin')
  const outside = join(root, 'outside-backup')
  write(outside, 'tampered')
  unlinkSync(backup)
  symlinkSync(outside, backup)
  throwsCode(() => rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId }), 'symlink_refused')
  unlinkSync(backup)
  writeFileSync(backup, 'tampered', { mode: 0o600 })
  throwsCode(() => rollbackHarnessConfig({ managedRoot: root, backupId: preview.backupId }), 'invalid_backup')
})

test('DSH 不猜语法：锚点/多行 YAML 与现有内联凭据 fail closed', (t) => {
  const root = temporaryRoot(t, 'harness-dsh-guard')
  const path = join(root, '.dsh/profiles/default/cordis.patch.yml')
  write(path, 'defaults: &defaults\n  api: openai-completions\n')
  throwsCode(() => previewHarnessConfig(previewOptions('dsh', root, { models: ['fixture'] })), 'unsupported_yaml')
  write(path, '- id: llm-pi-ai\n  config:\n    providers:\n      modelgate:\n        apiKey: ' + SECRET + '\n')
  throwsCode(() => previewHarnessConfig(previewOptions('dsh', root, { models: ['fixture'] })), 'inline_credential_forbidden')
  assertCanaryAbsent(root, 'tampered')
})

test('xmxz：列表/检测保持 unsupported，配置预览明确 422', (t) => {
  const root = temporaryRoot(t, 'harness-xmxz')
  assert.equal(listHarnessAdapters().find((item) => item.harnessId === 'xmxz').status, 'unsupported')
  assert.equal(detectHarnesses({ home: root }).find((item) => item.harnessId === 'xmxz').detection.state, 'unsupported')
  throwsCode(() => previewHarnessConfig({ harnessId: 'xmxz', managedRoot: root, endpoint: ENDPOINT }), 'unsupported_harness')
  assert.deepEqual(readdirSync(root), [])
})
