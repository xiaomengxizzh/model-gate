// A2 / P01：同步语义（离线）。
// 覆盖：新增/删除/更新、部分失败不落盘、无效 Key 保留旧快照、scope 隔离、文件缓存、指纹忽略 observedAt。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import {
  CACHE_SCHEMA, COMPLETENESS, createDiscoveryEngine, createFileSnapshotStore, createMemorySnapshotStore,
  diffSnapshots,
} from '../../../src/aggregation/discovery.js'
import {
  cacheEntry, consoleProvider, jsonResponse, readFixture, snapshotOf, tempDir,
} from '../fixtures/agg-a2/helpers.mjs'

const T = Date.parse('2026-11-14T12:00:00.000Z')
const CRED = 'test-key-not-real-never-log'
const provider = consoleProvider()

function fetchByMode(getMode) {
  return async (url) => {
    const mode = getMode()
    if (mode === 'v1') {
      if (url.includes('cursor=cursor-2')) return jsonResponse(readFixture('console-models-page2.json'))
      return jsonResponse(readFixture('console-models-page1.json'))
    }
    if (mode === 'v2') return jsonResponse(readFixture('console-models-v2.json'))
    if (mode === 'partial') {
      if (url.includes('cursor=cursor-2')) return jsonResponse({ error: 'boom' }, { status: 500 })
      return jsonResponse(readFixture('console-models-page1.json'))
    }
    if (mode === 'auth') return jsonResponse({ error: 'unauthorized' }, { status: 401 })
    throw new Error('unexpected mode')
  }
}

function setup() {
  let mode = 'v1'
  const cacheStore = createMemorySnapshotStore()
  const registry = { getProvider: (id) => (id === provider.id ? provider : null) }
  const engine = createDiscoveryEngine({ fetchImpl: fetchByMode(() => mode), registry, cacheStore, cfg: {}, now: () => T })
  return { engine, cacheStore, setMode: (m) => { mode = m } }
}

test('同步：新增/删除/更新都能定位（不静默）', async () => {
  const { engine, cacheStore, setMode } = setup()
  const first = await engine.sync('console', { credential: CRED, scope: 'local' })
  assert.equal(first.completeness, COMPLETENESS.COMPLETE)
  assert.equal(first.applied, true)
  assert.equal(first.snapshot.models.length, 4)
  assert.equal(cacheStore.get('local', 'console').snapshot.models.length, 4)

  setMode('v2')
  const second = await engine.sync('console', { credential: CRED, scope: 'local' })
  assert.equal(second.completeness, COMPLETENESS.COMPLETE)
  assert.deepEqual(second.changed.added, ['new-model-x'])
  assert.deepEqual(second.changed.removed, ['qwen3-coder'])
  assert.deepEqual(second.changed.updated.sort(), ['deepseek-v4.1-flash', 'gpt-4o'])
  assert.equal(second.snapshot.models.find((m) => m.upstreamId === 'gpt-4o').authorized, true)
  assert.equal(cacheStore.get('local', 'console').snapshot.models.length, 4)
})

test('部分页失败：不覆盖已完成的快照，changed 不谎报删除', async () => {
  const { engine, cacheStore, setMode } = setup()
  await engine.sync('console', { credential: CRED, scope: 'local' })
  setMode('partial')
  const partial = await engine.sync('console', { credential: CRED, scope: 'local' })
  assert.equal(partial.completeness, COMPLETENESS.PARTIAL)
  assert.equal(partial.applied, false)
  assert.equal(partial.retainedPrevious, true)
  assert.deepEqual(partial.changed, { added: [], removed: [], updated: [], partial: true })
  const kept = cacheStore.get('local', 'console')
  assert.equal(kept.snapshot.completeness, COMPLETENESS.COMPLETE)
  assert.equal(kept.snapshot.models.length, 4)
  const attempt = cacheStore.lastAttempt('local', 'console')
  assert.equal(attempt.completeness, COMPLETENESS.PARTIAL)
  assert.equal(attempt.code, 'discovery_page_failed')
})

test('无效 Key：typed error，旧快照保留（目录不会变空）', async () => {
  const { engine, cacheStore, setMode } = setup()
  await engine.sync('console', { credential: CRED, scope: 'local' })
  setMode('auth')
  const result = await engine.sync('console', { credential: CRED, scope: 'local' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'discovery_auth_failed')
  assert.equal(result.snapshot, null)
  assert.equal(result.retainedPrevious, true)
  assert.equal(cacheStore.get('local', 'console').snapshot.models.length, 4)
})

test('scope 隔离：同一 provider 的两个 scope 互不覆盖', async () => {
  let mode = 'v1'
  const cacheStore = createMemorySnapshotStore()
  const engine = createDiscoveryEngine({
    fetchImpl: fetchByMode(() => mode),
    registry: { getProvider: () => provider },
    cacheStore,
    cfg: {},
    now: () => T,
  })
  await engine.sync('console', { credential: CRED, scope: 'tenant-a' })
  mode = 'v2'
  await engine.sync('console', { credential: CRED, scope: 'tenant-b' })
  const a = cacheStore.get('tenant-a', 'console').snapshot
  const b = cacheStore.get('tenant-b', 'console').snapshot
  assert.ok(a.models.some((m) => m.upstreamId === 'qwen3-coder'))
  assert.ok(!a.models.some((m) => m.upstreamId === 'new-model-x'))
  assert.ok(b.models.some((m) => m.upstreamId === 'new-model-x'))
  assert.ok(!b.models.some((m) => m.upstreamId === 'qwen3-coder'))
})

test('未知 provider：typed error，不发生网络请求', async () => {
  let called = 0
  const engine = createDiscoveryEngine({
    fetchImpl: async () => { called += 1; return jsonResponse({ models: [] }) },
    registry: { getProvider: () => null },
    cacheStore: createMemorySnapshotStore(),
    cfg: {},
  })
  const result = await engine.sync('missing', { credential: CRED })
  assert.equal(result.code, 'discovery_provider_unknown')
  assert.equal(result.applied, false)
  assert.equal(called, 0)
})

test('文件快照存储：按 scope/provider 分文件，0600，attempt 分离', () => {
  const dir = tempDir('mg-agg-store-')
  try {
    const store = createFileSnapshotStore({ dir })
    const snapshot = snapshotOf(provider, [{ upstreamId: 'a', publicId: 'mg-console-a' }])
    store.put('s1', 'console', cacheEntry(snapshot, { etag: '"e1"' }))
    const got = store.get('s1', 'console')
    assert.equal(got.schema, CACHE_SCHEMA)
    assert.equal(got.snapshot.models.length, 1)
    assert.equal(store.get('s2', 'console'), null)
    store.putAttempt('s1', 'console', { at: '2026-11-14T00:00:00.000Z', completeness: 'discovery_partial', code: 'x' })
    assert.equal(store.lastAttempt('s1', 'console').code, 'x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('diff 指纹不含 observedAt：仅观测时间变化不算 updated', () => {
  const a = snapshotOf(provider, [{ upstreamId: 'm1', publicId: 'mg-console-m1' }], { observedAt: '2026-11-14T00:00:00.000Z' })
  const b = snapshotOf(provider, [{ upstreamId: 'm1', publicId: 'mg-console-m1' }], { observedAt: '2026-11-15T00:00:00.000Z' })
  assert.deepEqual(diffSnapshots(a, b), { added: [], removed: [], updated: [] })
  const c = snapshotOf(provider, [{ upstreamId: 'm1', publicId: 'mg-console-m1', contextWindow: 256000 }])
  assert.deepEqual(diffSnapshots(a, c).updated, ['m1'])
})
