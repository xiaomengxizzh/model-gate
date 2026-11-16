// MG-FIX-P2-08 / A4：发现完成态不得在「部分 Provider 无可信快照」时谎报 complete。
//
// 缺陷定位（MAIN 负责修，文件 src/aggregation/api.js，本测试禁止修改产品代码）：
//   discoverySummary() 只把「存在的快照」放进 snaps，若 snaps 全部 complete:true，
//   即使 snaps.length < providers.length（某个 provider 从未同步/无可信快照），仍返回
//   { state:'complete', complete:true }，只在 extra.providersComplete 里带 false。
//   普通 UI 读的是 state/complete —— 于是显示假的「已准备就绪」。
//
// 本文件通过公开 HTTP 面 GET /api/aggregation/models → body.discovery 驱动真实
// discoverySummary（离线、隔离 MG_CONFIG_DIR、不联网、不碰真实配置/凭据）。
//
// 契约（修复后应成立）：
//   · 任一 provider 缺可信快照 → complete:false 且 state != 'complete'（partial/unknown）；
//   · 全部 provider 都有 complete 快照 → 才允许 complete:true；
//  · 已存在但 complete:false 的快照 → partial。
//
// 注意：第一个用例在当前（未修）源码上【预期失败】——这是刻意保留的诚实红灯，
// MAIN 应用修复后它才应转绿。不要删除或放宽它。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAggregationApi } from '../../../src/aggregation/api.js'
import { loadConfig } from '../../../src/router.js'

const CACHE_SCHEMA = 'modelgate.aggregation.discovery-cache/1'
const SNAPSHOT_SCHEMA = 'modelgate.aggregation.snapshot/1'
const REGISTRY_SCHEMA = 'modelgate.aggregation.provider/1'

function aggProvider (id, kind) {
  return {
    baseUrl: 'https://opencode.ai',
    api: 'openai',
    aggregation: { schema: REGISTRY_SCHEMA, id, kind, enabled: true },
  }
}

function cacheEntryFor (providerId, { complete = true, models = 1 } = {}) {
  return {
    schema: CACHE_SCHEMA,
    storedAt: Date.parse('2026-11-16T00:00:00.000Z'),
    etag: null,
    lastModified: null,
    snapshot: {
      schema: SNAPSHOT_SCHEMA,
      providerId,
      complete,
      models: Array.from({ length: models }, (_, i) => ({
        publicId: 'mg-test-' + providerId + '-' + i,
        upstreamId: 'model-' + i,
        displayName: 'Model ' + i,
        contextWindow: 128000,
        capabilities: { tools: false, supportsSearchTool: false, supportsWebsockets: false },
        authorized: true,
        evidence: { source: 'test_fixture', observedAt: '2026-11-16' },
      })),
    },
  }
}

async function withEnv (fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-agg-disc-state-'))
  const prevDir = process.env.MG_CONFIG_DIR
  const prevCfg = process.env.MG_CONFIG
  process.env.MG_CONFIG_DIR = dir
  delete process.env.MG_CONFIG
  try {
    return await fn({ dir })
  } finally {
    if (prevDir === undefined) delete process.env.MG_CONFIG_DIR
    else process.env.MG_CONFIG_DIR = prevDir
    if (prevCfg === undefined) delete process.env.MG_CONFIG
    else process.env.MG_CONFIG = prevCfg
    await rm(dir, { recursive: true, force: true })
  }
}

async function setup (dir, { providers, snapshots = {} }) {
  const providerMap = {}
  for (const [id, kind] of providers) providerMap[id] = aggProvider(id, kind)
  const cfg = { defaults: {}, providers: providerMap, models: {}, virtualModels: [], configVersion: 1 }
  await writeFile(join(dir, 'gateway.json'), JSON.stringify(cfg))
  const snapDir = join(dir, 'aggregation', 'snapshots', 'local')
  await mkdir(snapDir, { recursive: true })
  for (const [id, entry] of Object.entries(snapshots)) {
    await writeFile(join(snapDir, id + '.json'), JSON.stringify(entry))
  }
  return { cfg }
}

async function discoveryOf (cfg) {
  const out = await handleAggregationApi({
    method: 'GET',
    path: '/api/aggregation/models',
    cfg,
    log: null,
    rawBody: '',
    explicitAdmin: true,
    isLocal: true,
  })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  return out.body.discovery
}

test('P2-08（红灯）：某 provider 无快照但其余快照 complete → 不得报告 complete/ready', async () => {
  await withEnv(async ({ dir }) => {
    await setup(dir, {
      providers: [['console', 'opencode-console'], ['opencodego', 'opencode-go']],
      // 只给 console 一份“完整”快照；opencodego 从未同步 → 无快照。
      snapshots: { console: cacheEntryFor('console', { complete: true, models: 2 }) },
    })
    const loaded = loadConfig()
    assert.equal(Object.keys(loaded.providers).length, 2, '前置：注册表应看到 2 个 provider')
    const discovery = await discoveryOf(loaded)
    // 修复前：{state:'complete', complete:true, providersComplete:false} —— 假就绪，下面两断言会失败。
    assert.notEqual(discovery.state, 'complete', '任一 provider 缺快照时 state 不得是 complete（UI 据此显示就绪）')
    assert.equal(discovery.complete, false, '任一 provider 缺快照时 complete 必须为 false，不得显示假「已准备就绪」')
  })
})

test('P2-08（绿灯）：全部 provider 都有 complete 快照 → 才允许 complete', async () => {
  await withEnv(async ({ dir }) => {
    await setup(dir, {
      providers: [['console', 'opencode-console'], ['opencodego', 'opencode-go']],
      snapshots: {
        console: cacheEntryFor('console', { complete: true, models: 2 }),
        opencodego: cacheEntryFor('opencodego', { complete: true, models: 1 }),
      },
    })
    const discovery = await discoveryOf(loadConfig())
    assert.equal(discovery.state, 'complete')
    assert.equal(discovery.complete, true)
    assert.equal(discovery.providersComplete, true)
  })
})

test('P2-08（绿灯）：已存在快照 complete:false → partial，不谎报 complete', async () => {
  await withEnv(async ({ dir }) => {
    await setup(dir, {
      providers: [['console', 'opencode-console']],
      snapshots: { console: cacheEntryFor('console', { complete: false, models: 1 }) },
    })
    const discovery = await discoveryOf(loadConfig())
    assert.equal(discovery.state, 'partial')
    assert.equal(discovery.complete, false)
  })
})
