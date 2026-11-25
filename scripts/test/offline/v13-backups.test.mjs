import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackup, previewImport, applyImportPlan } from '../../../src/resources/backups.js'

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code)
    return true
  })
}

function emptyDiff() {
  return { added: [], updated: [], removed: [], conflicts: [] }
}

test('备份：版本信封、确定性时间、全量凭据脱敏且不修改输入', () => {
  const cfg = {
    configVersion: 7,
    providers: {
      alpha: {
        baseUrl: 'https://alice:CANARY-url@example.test/v1',
        apiKey: 'CANARY-api-key',
        apiKeyEnv: 'CANARY-env-name',
        proxy: 'socks5://proxy-user:CANARY-proxy@127.0.0.1:1080',
        extraHeaders: {
          Authorization: 'CANARY-authorization',
          'X-Api-Key': 'CANARY-header-key',
          'X-Trace': 'CANARY-header-value',
        },
        note: '保留非秘密',
      },
    },
    defaults: {
      clientKey: 'CANARY-client-key',
      auth: 'CANARY-auth',
      token: 'CANARY-token',
      secret: 'CANARY-secret',
      password: 'CANARY-password',
      credentials: { value: 'CANARY-credential' },
      extraHeaders: { 'X-Default': 'CANARY-default-header' },
      retry: { maxAttempts: 3 },
    },
    models: { demo: { provider: 'alpha', note: '模型备注' } },
    _keys: { alpha: 'CANARY-key-store', __mg_client: 'CANARY-global-key' },
    custom: { nested: { refreshToken: 'CANARY-refresh' }, safe: 42, malformedProxy: 'http://user:CANARY-malformed@' },
    _paths: { config: '/private/config/gateway.json' },
    _disk: { local: 'runtime-fingerprint' },
  }
  const before = structuredClone(cfg)
  const backup = createBackup(cfg, { now: '2026-11-24T12:34:56.000Z' })

  assert.equal(backup.schema, 'modelgate-config-backup')
  assert.equal(backup.version, 1)
  assert.equal(backup.createdAt, '2026-11-24T12:34:56.000Z')
  assert.equal(JSON.stringify(backup).includes('CANARY'), false)
  assert.deepEqual(backup.config.providers.alpha.extraHeaders, {
    Authorization: { masked: true },
    'X-Api-Key': { masked: true },
    'X-Trace': { masked: true },
  })
  assert.deepEqual(backup.config.defaults.extraHeaders, { 'X-Default': { masked: true } })
  assert.deepEqual(backup.config.providers.alpha.apiKey, { masked: true })
  assert.deepEqual(backup.config.providers.alpha.apiKeyEnv, { masked: true })
  assert.deepEqual(backup.config._keys, { masked: true })
  assert.equal(backup.config.providers.alpha.baseUrl, 'https://example.test/v1')
  assert.equal(backup.config.providers.alpha.proxy, 'socks5://127.0.0.1:1080')
  assert.equal(backup.config.custom.malformedProxy, 'http://')
  assert.equal(backup.config.providers.alpha.note, '保留非秘密')
  assert.equal(backup.config.defaults.retry.maxAttempts, 3)
  assert.equal(Object.hasOwn(backup.config, '_paths'), false)
  assert.equal(Object.hasOwn(backup.config, '_disk'), false)
  assert.deepEqual(cfg, before)
})

test('备份/导入 roundtrip：非秘密一致、本地 Key 与 header 保留、版本递增', () => {
  const cfg = {
    configVersion: 4,
    providers: {
      alpha: {
        baseUrl: 'https://example.test/v1',
        apiKey: 'CANARY-roundtrip-key',
        extraHeaders: { Authorization: 'CANARY-roundtrip-header', 'X-Trace': 'safe-value' },
      },
    },
    defaults: { clientKey: 'CANARY-roundtrip-client', retry: { maxAttempts: 2 } },
    models: { demo: { provider: 'alpha', alias: ['d'] } },
    virtualModels: [{ name: 'daily', directory: [{ model: 'demo' }] }],
    custom: { list: [{ note: 'keep', token: 'CANARY-array-token' }], enabled: true },
    _keys: { alpha: 'CANARY-roundtrip-store' },
  }
  const original = structuredClone(cfg)
  const backup = createBackup(cfg, { now: 1 })
  const backupBefore = structuredClone(backup)
  const plan = previewImport(cfg, backup, { expectedVersion: 4 })

  assert.deepEqual(plan.diff, emptyDiff())
  assert.equal(plan.expectedVersion, 4)
  assert.equal(plan.nextVersion, 5)
  assert.equal(JSON.stringify(plan).includes('CANARY'), false)
  assert.equal(Object.hasOwn(plan, 'path'), false)

  const applied = applyImportPlan(cfg, plan)
  assert.deepEqual(applied, { ...cfg, configVersion: 5 })
  assert.notEqual(applied, cfg)
  assert.notEqual(applied.providers, cfg.providers)
  assert.notEqual(applied.custom.list, cfg.custom.list)
  assert.deepEqual(cfg, original)
  assert.deepEqual(backup, backupBefore)

  applied.providers.alpha.extraHeaders['X-Trace'] = 'changed'
  applied.custom.list[0].note = 'changed'
  assert.equal(cfg.providers.alpha.extraHeaders['X-Trace'], 'safe-value')
  assert.equal(cfg.custom.list[0].note, 'keep')
})

test('导入预览：added/updated/removed 差异明确且应用删除不覆盖本地凭据', () => {
  const current = {
    configVersion: 10,
    providers: {
      same: { baseUrl: 'https://same.test' },
      updated: { baseUrl: 'https://old.test', apiKey: 'CANARY-current-key' },
      removed: { baseUrl: 'https://removed.test' },
    },
    defaults: { keep: true, removeMe: 1 },
    _keys: { updated: 'CANARY-current-store', other: 'CANARY-other-store' },
  }
  const source = {
    configVersion: 9,
    providers: {
      same: { baseUrl: 'https://same.test' },
      updated: { baseUrl: 'https://new.test', apiKey: 'CANARY-source-key' },
      added: { baseUrl: 'https://added.test' },
    },
    defaults: { keep: true, added: 2 },
    _keys: { updated: 'CANARY-source-store' },
  }
  const plan = previewImport(current, createBackup(source, { now: 2 }), { expectedVersion: 10 })

  assert.deepEqual(plan.diff.added.map((entry) => entry.path), ['/defaults/added', '/providers/added'])
  assert.deepEqual(plan.diff.updated.map((entry) => entry.path), ['/providers/updated/baseUrl'])
  assert.deepEqual(plan.diff.removed.map((entry) => entry.path), ['/defaults/removeMe', '/providers/removed'])
  assert.deepEqual(plan.diff.conflicts, [])
  assert.equal(JSON.stringify(plan).includes('CANARY'), false)

  const applied = applyImportPlan(current, plan)
  assert.equal(applied.configVersion, 11)
  assert.equal(applied.providers.updated.baseUrl, 'https://new.test')
  assert.equal(applied.providers.updated.apiKey, 'CANARY-current-key')
  assert.equal(applied.providers.added.baseUrl, 'https://added.test')
  assert.equal(applied.providers.removed, undefined)
  assert.deepEqual(applied.defaults, { keep: true, added: 2 })
  assert.deepEqual(applied._keys, current._keys)
})

test('导入冲突：备份新增但本地缺失的掩码凭据必须重新授权', () => {
  const current = { configVersion: 1, providers: {} }
  const candidate = createBackup({
    configVersion: 1,
    providers: { incoming: { baseUrl: 'https://incoming.test', apiKey: 'CANARY-incoming' } },
  }, { now: 3 })
  const plan = previewImport(current, candidate)

  assert.deepEqual(plan.diff.conflicts, [{ path: '/providers/incoming/apiKey', reason: 'masked_value_unavailable' }])
  assert.equal(JSON.stringify(plan).includes('CANARY'), false)
  throwsCode(() => applyImportPlan(current, plan), 'import_conflict')
  assert.deepEqual(current, { configVersion: 1, providers: {} })
})

test('导入冲突：删除含凭据的父配置不会静默丢弃本地 Key', () => {
  const current = {
    configVersion: 2,
    providers: { retired: { baseUrl: 'https://retired.test', apiKey: 'CANARY-retired-key' } },
    _keys: { retired: 'CANARY-retired-store' },
  }
  const backup = createBackup({ configVersion: 2, providers: {} }, { now: 3 })
  const plan = previewImport(current, backup)

  assert.deepEqual(plan.diff.removed.map((entry) => entry.path), ['/providers/retired'])
  assert.deepEqual(plan.diff.conflicts, [{
    path: '/providers/retired',
    reason: 'sensitive_removal',
    before: { baseUrl: 'https://retired.test', apiKey: { masked: true } },
  }])
  throwsCode(() => applyImportPlan(current, plan), 'import_conflict')
  assert.equal(current.providers.retired.apiKey, 'CANARY-retired-key')
})

test('expectedVersion：预览与应用均绑定当前配置代际', () => {
  const current = { configVersion: 2, defaults: { note: 'current' } }
  const backup = createBackup({ configVersion: 1, defaults: { note: 'backup' } }, { now: 4 })
  throwsCode(() => previewImport(current, backup, { expectedVersion: 1 }), 'version_conflict')

  const plan = previewImport(current, backup)
  assert.equal(plan.expectedVersion, 2)
  throwsCode(() => applyImportPlan({ ...current, configVersion: 3 }, plan), 'version_conflict')
})

test('非法备份：schema/version/createdAt/配置形状全部拒绝', () => {
  const current = { configVersion: 1 }
  const backup = createBackup({ configVersion: 1 }, { now: 5 })
  throwsCode(() => previewImport(current, { ...backup, schema: 'other' }), 'unsupported_backup_schema')
  throwsCode(() => previewImport(current, { ...backup, version: 2 }), 'unsupported_backup_version')
  throwsCode(() => previewImport(current, { ...backup, createdAt: 'not-a-date' }), 'invalid_created_at')
  throwsCode(() => previewImport(current, { ...backup, config: [] }), 'invalid_config')
  throwsCode(() => previewImport(current, { ...backup, config: { configVersion: 1, providers: [] } }), 'invalid_config')
  const missing = { ...backup }
  delete missing.config
  throwsCode(() => previewImport(current, missing), 'invalid_backup')
})

test('导入安全：拒绝明文凭据、明文 header 值与带 userinfo 的 URL', () => {
  const current = { configVersion: 1, providers: { alpha: { extraHeaders: {} } } }
  const backup = createBackup({
    configVersion: 1,
    providers: { alpha: { baseUrl: 'https://example.test', extraHeaders: { 'X-Test': 'value' } } },
  }, { now: 6 })

  const plainKey = structuredClone(backup)
  plainKey.config.providers.alpha.apiKey = 'CANARY-plain-import'
  throwsCode(() => previewImport(current, plainKey), 'unsafe_backup_secret')

  const plainHeader = structuredClone(backup)
  plainHeader.config.providers.alpha.extraHeaders['X-Test'] = 'CANARY-plain-header'
  throwsCode(() => previewImport(current, plainHeader), 'unsafe_backup_secret')

  const userinfo = structuredClone(backup)
  userinfo.config.providers.alpha.baseUrl = 'https://user:CANARY-userinfo@example.test'
  throwsCode(() => previewImport(current, userinfo), 'unsafe_url_userinfo')
})

test('路径与保留键：拒绝任意文件路径、原型污染键和运行时路径信封', () => {
  throwsCode(() => createBackup({ configVersion: 1, path: '../../etc/passwd' }), 'invalid_path_field')
  throwsCode(() => createBackup({ configVersion: 1, nested: { filePath: '/etc/passwd' } }), 'invalid_path_field')
  throwsCode(() => createBackup({ configVersion: 1, nested: { customPath: '/etc/passwd' } }), 'invalid_path_field')
  throwsCode(() => createBackup(JSON.parse('{"configVersion":1,"__proto__":{"polluted":true}}')), 'invalid_reserved_key')
  throwsCode(() => createBackup({ configVersion: 1, constructor: { polluted: true } }), 'invalid_reserved_key')
  assert.equal({}.polluted, undefined)

  const current = { configVersion: 1 }
  const backup = createBackup({ configVersion: 1 }, { now: 7 })
  throwsCode(() => previewImport(current, { ...backup, outputPath: '/tmp/out.json' }), 'invalid_path_field')
  throwsCode(() => previewImport(current, { ...backup, config: { configVersion: 1, _paths: { config: '/tmp/config.json' } } }), 'invalid_path_field')

  const plan = previewImport(current, backup)
  throwsCode(() => applyImportPlan(current, { ...plan, path: '/tmp/config.json' }), 'invalid_import_plan')
})

test('校验边界：大小、深度、版本、JSON 形状和循环引用', () => {
  throwsCode(() => createBackup({ configVersion: 1, note: 'x'.repeat(200) }, { maxBytes: 80 }), 'invalid_size')
  throwsCode(() => createBackup({ configVersion: 1, nested: { deeper: { value: 1 } } }, { maxDepth: 1 }), 'invalid_depth')
  throwsCode(() => createBackup({ configVersion: -1 }), 'invalid_version')
  throwsCode(() => createBackup({ configVersion: '1' }), 'invalid_version')
  throwsCode(() => createBackup({ configVersion: 1, value: Number.NaN }), 'invalid_json_value')
  throwsCode(() => createBackup({ configVersion: 1, value: new Date() }), 'invalid_json_value')
  throwsCode(() => createBackup({ configVersion: 1, value: undefined }), 'invalid_json_value')
  throwsCode(() => createBackup({ configVersion: 1 }, { maxBytes: 0 }), 'invalid_options')

  const cyclic = { configVersion: 1 }
  cyclic.self = cyclic
  throwsCode(() => createBackup(cyclic), 'invalid_json_value')

  const atLimit = { configVersion: 1, nested: { value: 1 } }
  const boundaryBackup = createBackup(atLimit, { maxDepth: 2, maxBytes: 1000 })
  assert.equal(applyImportPlan(atLimit, previewImport(atLimit, boundaryBackup, { maxDepth: 2, maxBytes: 1000 })).configVersion, 2)
})

test('计划完整性：候选/差异篡改与同版本并发修改均拒绝', () => {
  const current = { configVersion: 8, defaults: { note: 'before' } }
  const backup = createBackup({ configVersion: 8, defaults: { note: 'after' } }, { now: 9 })
  const plan = previewImport(current, backup)

  const changedCandidate = structuredClone(plan)
  changedCandidate.candidate.defaults.note = 'tampered'
  throwsCode(() => applyImportPlan(current, changedCandidate), 'plan_binding_mismatch')

  const changedDiff = structuredClone(plan)
  changedDiff.diff.updated[0].after = 'tampered'
  throwsCode(() => applyImportPlan(current, changedDiff), 'plan_binding_mismatch')

  throwsCode(() => applyImportPlan({ ...current, defaults: { note: 'concurrent' } }, plan), 'preview_conflict')
  assert.equal(applyImportPlan(current, plan).defaults.note, 'after')
})
