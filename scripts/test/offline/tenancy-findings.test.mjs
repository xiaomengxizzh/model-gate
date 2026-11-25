// Targeted regressions for nested tenant env credentials and bounded private JSONL logs.
// Uses only temporary directories and synthetic credentials; no real host env/registry reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertTenantCredentialRefs, createScopeStore, requireUserScope, TenancyError,
} from '../../../src/tenancy/scope.js'
import {
  __clearUserEnvCache, __setUserEnvReaderForTest, buildProvider, loadConfig, resolveKey,
} from '../../../src/router.js'

const MULTI = { tenancy: { mode: 'multi', scopes: ['alpha'] } }
const ENV_NAME = 'MG_TENANT_REGRESSION_SYNTHETIC_KEY'
const HOST_SECRET = 'synthetic-host-secret-must-not-leak'

function tempDir(t, prefix = 'mg-tenancy-findings-') {
  return mkdtemp(join(tmpdir(), prefix)).then((dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }))
    return dir
  })
}

function scopeOf(store) {
  return store.forScope(requireUserScope({ id: 'fixture', scopeId: 'alpha' }, { config: MULTI }))
}

function denied(fn, code = 'tenant_env_credential_forbidden') {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TenancyError)
    assert.equal(error.code, code)
    assert.equal(error.deny, true)
    assert.equal(JSON.stringify(error).includes(HOST_SECRET), false)
    return true
  })
}

test('recursive tenant guard rejects provider, connection, and future nested env refs without echoing values', () => {
  denied(() => assertTenantCredentialRefs({ providers: { p: { apiKeyEnv: ENV_NAME } } }))
  denied(() => assertTenantCredentialRefs({ providers: { p: { connections: [{ apiKeyEnv: ENV_NAME }] } } }))
  denied(() => assertTenantCredentialRefs({ resources: [{ nested: { credentials: { 'api-key-env': ENV_NAME } } }] }))
  const safe = { providers: { p: { connections: [{ credentialKeyId: 'scope-owned' }] } }, _keys: { p: 'synthetic' } }
  assert.equal(assertTenantCredentialRefs(safe), safe)
})

test('scoped loadConfig validates merged base+local config and resolveKey never reads host env/registry', async (t) => {
  const dir = await tempDir(t)
  const prior = process.env[ENV_NAME]
  process.env[ENV_NAME] = HOST_SECRET
  t.after(() => {
    __setUserEnvReaderForTest(null)
    __clearUserEnvCache()
    if (prior === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior
  })
  let registryReads = 0
  __clearUserEnvCache()
  __setUserEnvReaderForTest(() => { registryReads++; return HOST_SECRET })

  const configFile = join(dir, 'gateway.json')
  const localFile = join(dir, 'gateway.local.json')
  const paths = { dir, local: localFile, keys: join(dir, 'keys.local.json'), stats: join(dir, 'stats.json'), videos: join(dir, 'videos.json') }
  await writeFile(configFile, JSON.stringify({ providers: { p: { baseUrl: 'https://fixture.invalid', connections: [{ id: 'safe' }] } } }))
  await writeFile(localFile, JSON.stringify({ providers: { p: { connections: [{ id: 'nested', apiKeyEnv: ENV_NAME }] } } }))
  denied(() => loadConfig({ configFile, paths, scopeId: 'alpha' }))

  const cfg = { _tenancyScope: 'alpha', _keys: {}, providers: { p: { baseUrl: 'https://fixture.invalid' } } }
  const connection = { id: 'nested', apiKeyEnv: ENV_NAME }
  denied(() => resolveKey(cfg, connection, 'nested'))
  denied(() => buildProvider(cfg, 'p', connection))
  assert.equal(registryReads, 0, 'tenant resolution must not query the user registry/environment')
  assert.deepEqual(resolveKey(cfg, { api: 'openai' }, 'p'), { key: '', source: null })

  // Single-user behavior remains unchanged.
  assert.equal(resolveKey({ _keys: {} }, { apiKeyEnv: ENV_NAME }, 'p').key, HOST_SECRET)
})

test('tenant logs rotate by records and bytes, retain only current+.1, and survive restart', async (t) => {
  const dir = await tempDir(t)
  const options = { config: MULTI, logMaxRecords: 3, logMaxBytes: 4096 }
  const store = createScopeStore(dir, options)
  const scope = scopeOf(store)
  for (let i = 0; i < 8; i++) await scope.logLine({ event: 'record_rotation', i, detail: 'x'.repeat(40) })
  const logsDir = join(dir, 'alpha', 'logs')
  const current = join(logsDir, 'events.jsonl')
  const archive = current + '.1'
  assert.deepEqual((await readdir(logsDir)).sort(), ['events.jsonl', 'events.jsonl.1'])
  assert.deepEqual((await scope.readLogs()).map((entry) => entry.i), [3, 4, 5, 6, 7])
  for (const path of [current, archive]) {
    assert.ok((await stat(path)).size <= options.logMaxBytes)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  assert.equal((await readFile(archive, 'utf8')).trim().split('\n').length <= 3, true)
  for (const path of [dir, join(dir, 'alpha'), logsDir]) assert.equal((await stat(path)).mode & 0o777, 0o700)

  const restarted = scopeOf(createScopeStore(dir, options))
  assert.deepEqual((await restarted.readLogs()).map((entry) => entry.i), [3, 4, 5, 6, 7])
  await restarted.logLine({ event: 'after_restart', i: 8 })
  assert.deepEqual((await restarted.readLogs()).map((entry) => entry.i).slice(-2), [7, 8])
  assert.equal((await restarted.readLogs()).some((entry) => entry.i === 0), false)
})

test('tenant logs also rotate at the byte ceiling and keep both segments bounded', async (t) => {
  const dir = await tempDir(t)
  const options = { config: MULTI, logMaxRecords: 100, logMaxBytes: 700 }
  const scope = scopeOf(createScopeStore(dir, options))
  for (let i = 0; i < 12; i++) await scope.logLine({ event: 'byte_rotation', i, detail: 'x'.repeat(40) })
  const current = join(dir, 'alpha', 'logs', 'events.jsonl')
  const archive = current + '.1'
  assert.ok((await stat(archive)).size > 0, 'byte ceiling must produce .1')
  assert.ok((await stat(current)).size <= options.logMaxBytes)
  assert.ok((await stat(archive)).size <= options.logMaxBytes)
  const entries = await scope.readLogs()
  assert.equal(entries.at(-1).i, 11)
  assert.ok(entries.length < 12, 'old records must be replaced, not accumulated in extra archives')
})

test('tenant log writes serialize and oversized records fail without unbounded growth', async (t) => {
  const dir = await tempDir(t)
  const store = createScopeStore(dir, { config: MULTI, logMaxRecords: 5, logMaxBytes: 4096 })
  const scope = scopeOf(store)
  await Promise.all(Array.from({ length: 20 }, (_, i) => scope.logLine({ event: 'concurrent', i })))
  const entries = await scope.readLogs()
  assert.equal(new Set(entries.map((entry) => entry.i)).size, entries.length)
  assert.deepEqual(entries.map((entry) => entry.i), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  const oversized = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['detail' + i, 'x'.repeat(512)]))
  await assert.rejects(() => scope.logLine({ event: 'oversized', ...oversized }), (error) => error.code === 'log_record_too_large')
  assert.deepEqual(await scope.readLogs(), entries)
})

test('tenant log file, archive, directory, and root symlinks fail closed without touching outside targets', async (t) => {
  const dir = await tempDir(t)
  const outside = await tempDir(t, 'mg-tenancy-outside-')
  const sentinel = join(outside, 'sentinel')
  await writeFile(sentinel, 'outside-must-stay-unchanged')

  for (const kind of ['file', 'archive', 'directory', 'root']) {
    const root = kind === 'root' ? join(dir, 'root-link-' + kind) : join(dir, kind)
    const scopeRoot = kind === 'root' ? root : join(root, 'alpha')
    const logsDir = join(scopeRoot, 'logs')
    if (kind !== 'root') await mkdir(scopeRoot, { recursive: true })
    if (kind === 'directory') await symlink(outside, logsDir)
    else {
      if (kind !== 'root') await mkdir(logsDir, { recursive: true })
      if (kind === 'file') await symlink(sentinel, join(logsDir, 'events.jsonl'))
      if (kind === 'archive') await symlink(sentinel, join(logsDir, 'events.jsonl.1'))
      if (kind === 'root') await symlink(outside, root)
    }
    const scope = scopeOf(createScopeStore(root, { config: MULTI, logMaxRecords: 1 }))
    await assert.rejects(() => scope.logLine({ event: 'must_not_write' }), (error) => error.code === 'scope_log_unsafe_path')
    await assert.rejects(() => scope.readLogs(), (error) => error.code === 'scope_log_unsafe_path')
    assert.equal(await readFile(sentinel, 'utf8'), 'outside-must-stay-unchanged')
  }
})
