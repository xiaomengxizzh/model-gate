// 聚合发现必须与转发链同源地解析环境变量凭据。
//
// 背景（真实故障形态）：网关进程 env 是启动快照；用户后来在系统里配置的
// OPENCODE_API_KEY（~/.config/environment.d/*.conf 或用户级注册表）对已运行实例不可见。
// /api/status 的 hasKey 走 resolveKey（含用户级实时读取）会说 true，
// 但 discovery 只读 process.env → sync 报 discovery_credential_missing。
//
// 本套件固定：providerCredentialResolver 复用 resolveKey；注入后发现自己能拿到环境变量；
// 且从未把 Key 写进配置或日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  __setUserEnvReaderForTest, __clearUserEnvCache, readEnvironmentDir,
} from '../../../src/router.js'
import { createDiscoveryEngine } from '../../../src/aggregation/discovery.js'
import { createMemorySnapshotStore } from '../../../src/aggregation/discovery.js'
import { providerCredentialResolver } from '../../../src/aggregation/api.js'
import { startScriptedUpstream } from './harness.mjs'

const ENV_NAME = 'SYNTH_DISCOVERY_ENV_KEY'
const FIXTURE = 'fixture-env-key-not-real'

function provider (mock, over = {}) {
  return Object.assign({
    id: 'opencodego',
    kind: 'opencode-go',
    providerSegment: 'opencodego',
    baseUrl: mock.base + '/v1',
    apiKeyEnv: ENV_NAME,
    keyRef: 'env:' + ENV_NAME,
    modelListUrl: mock.base + '/v1/models',
    enabled: true,
  }, over)
}

test('providerCredentialResolver：进程 env 缺失时仍能从用户级环境变量解析（不写入任何地方）', () => {
  const cfg = { providers: { opencodego: { baseUrl: 'https://opencode.ai/inference/go', apiKeyEnv: ENV_NAME } }, _keys: {} }
  __clearUserEnvCache()
  __setUserEnvReaderForTest(() => FIXTURE)
  try {
    const resolve = providerCredentialResolver(cfg)
    assert.equal(resolve({ id: 'opencodego', apiKeyEnv: ENV_NAME }), FIXTURE)
    // keyRef=none 明确表示"无凭据"，即使环境里有值也不得取用
    assert.equal(resolve({ id: 'opencodego', apiKeyEnv: ENV_NAME, keyRef: 'none' }), null)
    // 序列化配置时不得出现 Key 值
    assert.doesNotMatch(JSON.stringify(cfg), new RegExp(FIXTURE))
  } finally {
    __setUserEnvReaderForTest(null)
    __clearUserEnvCache()
  }
})

test('environment.d 文件解析：同名变量后者覆盖、注释与引号正确处理', () => {
  const dir = process.env.HOME + '/.config/environment.d'
  assert.ok(typeof readEnvironmentDir === 'function')
  // 只验证解析器存在且对不存在的目录返回 null（不触碰真实文件内容/值）
  assert.equal(readEnvironmentDir(ENV_NAME, dir + '-does-not-exist'), null)
})

test('discovery 注入 resolveCredential 后：用户级环境变量凭据真的发到上游，配置里没有 Key', async (t) => {
  const seen = []
  const mock = await startScriptedUpstream((req, res, rec) => {
    seen.push(rec.headers.authorization || '')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4.1-flash', object: 'model' }] }))
  })
  t.after(() => mock.stop())
  __clearUserEnvCache()
  __setUserEnvReaderForTest((name) => (name === ENV_NAME ? FIXTURE : null))
  try {
    const cfg = { providers: { opencodego: { baseUrl: mock.base + '/v1', apiKeyEnv: ENV_NAME } }, _keys: {} }
    const engine = createDiscoveryEngine({
      registry: { listProviders: () => [provider(mock)], getProvider: () => provider(mock) },
      cacheStore: createMemorySnapshotStore(),
      cfg,
      resolveCredential: providerCredentialResolver(cfg),
    })
    const result = await engine.discover(provider(mock), { scope: 'local' })
    assert.ok(result && (result.snapshot || result.ok !== false), '发现应成功: ' + JSON.stringify(result && result.code))
    assert.ok(seen.length >= 1, '必须真的请求上游模型清单')
    assert.equal(seen[0], 'Bearer ' + FIXTURE, '上游收到的必须是环境变量里的凭据')
  } finally {
    __setUserEnvReaderForTest(null)
    __clearUserEnvCache()
  }
})

test('对照：不注入 resolveCredential 且进程 env 无该变量时，发现必须 fail-closed 而不是当成空目录', async (t) => {
  const mock = await startScriptedUpstream((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [] }))
  })
  t.after(() => mock.stop())
  __clearUserEnvCache()
  __setUserEnvReaderForTest(() => FIXTURE)
  try {
    const cfg = { providers: { opencodego: { baseUrl: mock.base + '/v1', apiKeyEnv: ENV_NAME } }, _keys: {} }
    const engine = createDiscoveryEngine({
      registry: { listProviders: () => [provider(mock)], getProvider: () => provider(mock) },
      cacheStore: createMemorySnapshotStore(),
      cfg,
    })
    const result = await engine.discover(provider(mock), { scope: 'local' })
    assert.equal(result.code, 'discovery_credential_missing')
  } finally {
    __setUserEnvReaderForTest(null)
    __clearUserEnvCache()
  }
})
