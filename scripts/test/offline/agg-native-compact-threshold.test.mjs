// MG-NATIVE-COMPACT：聚合目录必须把 deepseek 子模型的原生压缩阈值写进
// auto_compact_token_limit（此前漏配，Codex 用默认阈值）。
// 官方真机值：OpenCode 目录 deepseek-v4.1-flash = 943718（=1048576×0.9）。
// 可通过 gateway 配置 models.<id>.codex.capabilities.autoCompactTokenLimit 覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NATIVE_COMPACT_TOKENS, createAggregatedCatalog,
} from '../../../src/aggregation/catalog.js'
import { createRegistry } from '../../../src/aggregation/registry.js'
import { createMemorySnapshotStore } from '../../../src/aggregation/discovery.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFixture } from '../fixtures/agg-a2/helpers.mjs'
const BASE = readFixture('base-catalog.json')
function snap(models) {
  return { schema: 'modelgate.aggregation.snapshot/1', providerId: 'opencodego', complete: true,
    completeness: 'discovery_complete', models }
}
const goModel = (overrides = {}) => ({
  upstreamId: 'deepseek-v4.1-flash', publicId: 'mg-opencodego-deepseek-v4-1-flash',
  displayName: 'DeepSeek V4.1 Flash 1017', contextWindow: 1000000, authorized: true,
  routable: true, protocol: 'openai', capabilities: { tools: true }, evidence: { source: 'test' }, ...overrides,
})

function setup(cfgModels) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-compact-thr-'))
  const cacheStore = createMemorySnapshotStore()
  const provider = { id: 'opencodego', name: 'OpenCode Go', aggregation: { schema: 'modelgate.aggregation.provider/1', id: 'opencodego', kind: 'opencode-go', enabled: true }, providerSegment: 'opencodego' }
  const registry = { listProviders: () => [provider] }
  const cfg = { models: cfgModels || {} }
  return { catalog: createAggregatedCatalog({ registry, cacheStore, dir, readConfig: () => cfg }), cacheStore, cfg }
}

test('默认压缩阈值 = 官方 943718（1M×90%），写入 deepseek 模型', async () => {
  const { catalog, cacheStore, cfg } = setup()
  cacheStore.put('local', 'opencodego', { schema: 'modelgate.aggregation.discovery-cache/1', storedAt: 1, etag: null,
    snapshot: snap([goModel()]) })
  assert.equal(DEFAULT_NATIVE_COMPACT_TOKENS, 943718)
  await catalog.publish("local", { cfg, base: BASE })
  const m = catalog.readCurrent('local').catalog.models.find((x) => x.slug === 'mg-opencodego-deepseek-v4-1-flash')
  assert.equal(m.auto_compact_token_limit, 943718)
})

test('配置覆盖 autoCompactTokenLimit 生效，且不超过 contextWindow', async () => {
  const { catalog, cacheStore, cfg } = setup({
    'deepseek-v4.1-flash': { codex: { capabilities: { autoCompactTokenLimit: 500000 } } },
  })
  cacheStore.put('local', 'opencodego', { schema: 'modelgate.aggregation.discovery-cache/1', storedAt: 1, etag: null,
    snapshot: snap([goModel()]) })
  await catalog.publish("local", { cfg, base: BASE })
  const m = catalog.readCurrent('local').catalog.models.find((x) => x.slug === 'mg-opencodego-deepseek-v4-1-flash')
  assert.equal(m.auto_compact_token_limit, 500000)
})

test('覆盖值超过 contextWindow 时被夹到 contextWindow（压缩仍可触发）', async () => {
  const { catalog, cacheStore, cfg } = setup({
    'deepseek-v4.1-flash': { codex: { capabilities: { autoCompactTokenLimit: 2000000 } } },
  })
  cacheStore.put('local', 'opencodego', { schema: 'modelgate.aggregation.discovery-cache/1', storedAt: 1, etag: null,
    snapshot: snap([goModel()]) })
  await catalog.publish("local", { cfg, base: BASE })
  const m = catalog.readCurrent('local').catalog.models.find((x) => x.slug === 'mg-opencodego-deepseek-v4-1-flash')
  assert.equal(m.auto_compact_token_limit, 1000000)
})
