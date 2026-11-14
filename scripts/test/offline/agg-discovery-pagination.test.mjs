// A2 / P01：发现分页与失败分类（离线，无网络）。
// 覆盖：游标分页、页码分页、maxPages 上限、部分页失败、401/404、ETag 304、陈旧缓存、
// 空目录上游证实、形状不匹配、分页信息不足、公共 ID 字节兼容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_SCHEMA, COMPLETENESS, createDiscoveryEngine, createMemorySnapshotStore, extractModels, extractPagination,
} from '../../../src/aggregation/discovery.js'
import { consoleProvider, goProvider, jsonResponse, readFixture } from '../fixtures/agg-a2/helpers.mjs'

const T = Date.parse('2026-11-14T12:00:00.000Z')
const CRED = 'test-key-not-real-never-log'

function engine(fetchImpl, options = {}) {
  return createDiscoveryEngine({
    fetchImpl,
    cfg: {},
    cacheStore: createMemorySnapshotStore(),
    now: () => T,
    maxPages: options.maxPages || 20,
    maxAgeMs: options.maxAgeMs || 24 * 60 * 60 * 1000,
  })
}

function cursorFetch(calls, options = {}) {
  return async (url, init) => {
    calls.push({ url, headers: init.headers })
    if (url.includes('cursor=cursor-2')) {
      if (options.failPage2) return jsonResponse({ error: 'boom' }, { status: 500 })
      return jsonResponse(readFixture('console-models-page2.json'))
    }
    return jsonResponse(readFixture('console-models-page1.json'), { headers: { etag: '"c1"' } })
  }
}

test('游标分页：穷尽两页、去重、授权状态与公共 ID', async () => {
  const calls = []
  const result = await engine(cursorFetch(calls)).discover(consoleProvider(), { credential: CRED, scope: 's1' })
  assert.equal(result.ok, true)
  assert.equal(result.completeness, COMPLETENESS.COMPLETE)
  assert.equal(result.snapshot.complete, true)
  assert.equal(result.snapshot.models.length, 4)
  assert.deepEqual(
    result.snapshot.models.map((m) => m.upstreamId).sort(),
    ['deepseek-v4.1-flash', 'glm-5', 'gpt-4o', 'qwen3-coder'])
  assert.equal(result.counts.authorized, 3)
  assert.equal(result.counts.unauthorized, 1)
  assert.equal(result.counts.duplicates, 1)
  assert.ok(result.diagnostics.some((d) => d.code === 'duplicate_upstream_id'))
  const deepseek = result.snapshot.models.find((m) => m.upstreamId === 'deepseek-v4.1-flash')
  assert.equal(deepseek.publicId, 'mg-console-deepseek-v4-1-flash')
  const gpt = result.snapshot.models.find((m) => m.upstreamId === 'gpt-4o')
  assert.equal(gpt.authorized, false)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.endsWith('/console/v1/models'))
  assert.ok(calls[1].url.includes('cursor=cursor-2'))
  assert.equal(calls[0].headers.authorization, 'Bearer ' + CRED)
  assert.ok(!JSON.stringify(result.diagnostics).includes(CRED))
})

test('页码分页：next_page/per_page 被跟随，两页穷尽', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('page=2')) return jsonResponse(readFixture('go-models-page2.json'))
    return jsonResponse(readFixture('go-models-page1.json'))
  }
  const result = await engine(fetchImpl).discover(goProvider(), { credential: CRED, scope: 's1' })
  assert.equal(result.completeness, COMPLETENESS.COMPLETE)
  assert.deepEqual(result.snapshot.models.map((m) => m.upstreamId).sort(),
    ['deepseek-v4.1-flash', 'glm-5', 'kimi-k2', 'minimax-m2'])
  assert.ok(calls[1].includes('page=2'))
  assert.ok(calls[1].includes('per_page=2'))
  const deepseek = result.snapshot.models.find((m) => m.upstreamId === 'deepseek-v4.1-flash')
  assert.equal(deepseek.publicId, 'mg-opencodego-deepseek-v4-1-flash')
})

test('maxPages 上限：结果标 partial，绝不冒充 complete', async () => {
  const calls = []
  const result = await engine(cursorFetch(calls), { maxPages: 5 }).discover(consoleProvider(), {
    credential: CRED, scope: 's1', maxPages: 1,
  })
  assert.equal(result.ok, false)
  assert.equal(result.completeness, COMPLETENESS.PARTIAL)
  assert.equal(result.code, 'discovery_max_pages_exceeded')
  assert.equal(result.snapshot.complete, false)
  assert.equal(calls.length, 1)
})

test('部分页失败：保留第 1 页并标 partial', async () => {
  const calls = []
  const result = await engine(cursorFetch(calls, { failPage2: true })).discover(consoleProvider(), { credential: CRED, scope: 's1' })
  assert.equal(result.ok, false)
  assert.equal(result.completeness, COMPLETENESS.PARTIAL)
  assert.equal(result.code, 'discovery_page_failed')
  assert.equal(result.snapshot.models.length, 3)
  assert.deepEqual(result.changed, undefined)
})

test('无效/过期 Key：401 是 typed error，不是空目录', async () => {
  const result = await engine(async () => jsonResponse({ error: 'unauthorized' }, { status: 401 }))
    .discover(consoleProvider(), { credential: CRED, scope: 's1' })
  assert.equal(result.ok, false)
  assert.equal(result.completeness, COMPLETENESS.FAILED)
  assert.equal(result.code, 'discovery_auth_failed')
  assert.equal(result.snapshot, null)
  assert.equal(result.retryable, false)
})

test('404：入口假设不成立是 typed error，不是空目录', async () => {
  const result = await engine(async () => jsonResponse({ error: 'not found' }, { status: 404 }))
    .discover(consoleProvider(), { credential: CRED })
  assert.equal(result.code, 'discovery_endpoint_missing')
  assert.equal(result.snapshot, null)
})

test('ETag 304：复用缓存快照，observedAt 不变但 validatedAt 更新', async () => {
  const calls = []
  const first = await engine(cursorFetch(calls)).discover(consoleProvider(), { credential: CRED })
  const cache = { schema: CACHE_SCHEMA, storedAt: T, etag: '"c1"', lastModified: null, snapshot: first.snapshot }
  let sawConditional = false
  const fetch304 = async (url, init) => {
    sawConditional = init.headers['if-none-match'] === '"c1"'
    return jsonResponse(null, { status: 304 })
  }
  const result = await engine(fetch304).discover(consoleProvider(), { credential: CRED, cache })
  assert.equal(sawConditional, true)
  assert.equal(result.ok, true)
  assert.equal(result.revalidated, true)
  assert.equal(result.snapshot.freshness, 'revalidated')
  assert.equal(result.snapshot.observedAt, first.snapshot.observedAt)
  assert.ok(result.snapshot.validatedAt)
  assert.ok(result.diagnostics.some((d) => d.code === 'cache_revalidated'))
})

test('陈旧缓存：超过 maxAgeMs 不再发校验器，强制全量', async () => {
  const first = await engine(cursorFetch([])).discover(consoleProvider(), { credential: CRED })
  const cache = { schema: CACHE_SCHEMA, storedAt: T - 5000, etag: '"c1"', lastModified: null, snapshot: first.snapshot }
  let sawConditional = false
  const fetchImpl = async (url, init) => {
    if (init.headers['if-none-match']) sawConditional = true
    if (url.includes('cursor=cursor-2')) return jsonResponse(readFixture('console-models-page2.json'))
    return jsonResponse(readFixture('console-models-page1.json'))
  }
  const result = await engine(fetchImpl, { maxAgeMs: 1000 }).discover(consoleProvider(), { credential: CRED, cache })
  assert.equal(sawConditional, false)
  assert.equal(result.completeness, COMPLETENESS.COMPLETE)
})

test('上游明确空目录：complete + emptyConfirmed，而不是发现失败', async () => {
  const result = await engine(async () => jsonResponse(readFixture('console-models-empty.json')))
    .discover(consoleProvider(), { credential: CRED })
  assert.equal(result.ok, true)
  assert.equal(result.completeness, COMPLETENESS.COMPLETE)
  assert.deepEqual(result.snapshot.models, [])
  assert.equal(result.snapshot.emptyConfirmed, true)
  assert.ok(result.diagnostics.some((d) => d.code === 'empty_entitlement_confirmed'))
})

test('未知形状/分页不足：typed error，不当成“没有更多模型”', async () => {
  const shape = await engine(async () => jsonResponse({ foo: [] })).discover(consoleProvider(), { credential: CRED })
  assert.equal(shape.ok, false)
  assert.equal(shape.code, 'discovery_shape_unrecognized')

  const paging = await engine(async () => jsonResponse({ models: [{ id: 'x', context_window: 1 }], has_more: true }))
    .discover(consoleProvider(), { credential: CRED })
  assert.equal(paging.ok, false)
  assert.equal(paging.completeness, COMPLETENESS.PARTIAL)
  assert.equal(paging.code, 'discovery_pagination_unknown')
})

test('形状/分页解析器：显式登记的支持形状', () => {
  assert.equal(extractModels([]).shape, 'array')
  assert.equal(extractModels({ data: [] }).shape, 'data')
  assert.equal(extractModels({ items: [] }).shape, 'items')
  assert.equal(extractModels({ result: { models: [] } }).shape, 'result.models')
  assert.equal(extractModels({ nope: 1 }).ok, false)
  const done = extractPagination({ has_more: false }, {}, { page: 1 })
  assert.equal(done.ok, true)
  assert.equal(done.hasNext, false)
  const bad = extractPagination({ has_more: true }, {}, { page: 1 })
  assert.equal(bad.ok, false)
})

test('第 2 页非法 JSON：partial 而不是 failed，且保留第 1 页', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('cursor=cursor-2')) return new Response('<html>oops</html>', { status: 200 })
    return jsonResponse(readFixture('console-models-page1.json'))
  }
  const result = await engine(fetchImpl).discover(consoleProvider(), { credential: CRED })
  assert.equal(result.ok, false)
  assert.equal(result.completeness, COMPLETENESS.PARTIAL)
  assert.equal(result.code, 'discovery_page_invalid')
  assert.equal(result.snapshot.models.length, 3)
})

test('别名 ID：折叠到 canonical 并留诊断，不重复发布', async () => {
  const body = {
    models: [
      { id: 'canonical-model', context_window: 1000 },
      { id: 'old-alias', alias_of: 'canonical-model', context_window: 1000 },
    ],
    has_more: false,
  }
  const result = await engine(async () => jsonResponse(body)).discover(consoleProvider(), { credential: CRED })
  assert.equal(result.completeness, COMPLETENESS.COMPLETE)
  assert.equal(result.snapshot.models.length, 1)
  assert.equal(result.snapshot.models[0].upstreamId, 'canonical-model')
  assert.ok(result.diagnostics.some((d) => d.code === 'alias_collapsed'))
})

test('凭据缺失：拒绝把未鉴权当成空账户', async () => {
  const result = await engine(async () => jsonResponse(readFixture('console-models-empty.json')))
    .discover(consoleProvider({ keyRef: 'none', apiKeyEnv: null }), {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'discovery_credential_missing')
})
