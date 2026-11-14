// F4 回归：聚合写操作必须在**进程内**立刻生效，而不是等重启或手工 /api/config/reload。
//
// 缺陷：src/aggregation/api.js 构造注册表时只传 {log}，注册表 commit 时的 publish 是空函数，
// 于是「POST /providers 成功」之后内存里的 state.cfg 仍是旧配置，aggregationModeActive(state.cfg)
// 继续为 false（收据闸门不启用），直到重启。修复复用 /api/config/reload 的同一个 reloadConfig
// （由入口注入 ctx.reload），不新建第二条重载路径。
//
// 两个方向都钉住：
//   · 注入 reload ⇒ 写成功后 false → true；删除后 true → false（内存不再残留旧状态）；
//   · 没有注入（或重载失败）⇒ 必须如实返回 reload.applied=false / needsRestart=true，
//     绝不谎称已生效——那正是闸门继续读旧配置的原因。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAggregationApi } from '../../../src/aggregation/api.js'
import { aggregationModeActive } from '../../../src/index.js'
import { loadConfig } from '../../../src/router.js'

async function withIsolatedConfig (fn) {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-agg-reload-'))
  const prevDir = process.env.MG_CONFIG_DIR
  const prevCfg = process.env.MG_CONFIG
  process.env.MG_CONFIG_DIR = dir
  delete process.env.MG_CONFIG
  await writeFile(join(dir, 'gateway.json'), JSON.stringify({
    defaults: {}, providers: {}, models: {}, virtualModels: [], configVersion: 0,
  }))
  const state = { cfg: loadConfig() }
  // 与 src/index.js 的 reloadConfig(state) 同义：重新读盘并替换内存配置。
  const reload = () => { state.cfg = loadConfig() }
  try {
    return await fn({ dir, state, reload })
  } finally {
    if (prevDir === undefined) delete process.env.MG_CONFIG_DIR
    else process.env.MG_CONFIG_DIR = prevDir
    if (prevCfg === undefined) delete process.env.MG_CONFIG
    else process.env.MG_CONFIG = prevCfg
    await rm(dir, { recursive: true, force: true })
  }
}

function addCtx (state, reload) {
  const ctx = {
    method: 'POST',
    path: '/api/aggregation/providers',
    cfg: state.cfg,
    log: null,
    rawBody: JSON.stringify({ provider: { kind: 'console', baseUrl: 'https://opencode.ai', apiKeyEnv: 'MG_TEST_CONSOLE_KEY' } }),
    explicitAdmin: true,
    isLocal: true,
  }
  if (reload) ctx.reload = reload
  return ctx
}

test('注入 reload：新增提供商后聚合状态在同一进程内 false → true', async () => {
  await withIsolatedConfig(async ({ state, reload }) => {
    assert.equal(aggregationModeActive(state.cfg), false, '尚无聚合记录时不得为 true')
    const out = await handleAggregationApi(addCtx(state, reload))
    assert.equal(out.status, 201, JSON.stringify(out.body))
    assert.deepEqual(out.body.reload, { applied: true, needsRestart: false, reason: null })
    assert.equal(aggregationModeActive(state.cfg), true, '写成功后内存配置必须立刻反映新聚合提供商')
    // 描述符没有被复制成第二份：与从磁盘重新加载的结果一致。
    assert.equal(Object.values(state.cfg.providers).some((p) => p && p.aggregation && p.aggregation.schema === 'modelgate.aggregation.provider/1'), true)
    assert.equal(state.cfg.configVersion, 1)
  })
})

test('未注入 reload：不谎称生效，如实返回 needsRestart:true 且内存状态不变', async () => {
  await withIsolatedConfig(async ({ state }) => {
    const out = await handleAggregationApi(addCtx(state, null))
    assert.equal(out.status, 201, JSON.stringify(out.body))
    assert.deepEqual(out.body.reload, { applied: false, needsRestart: true, reason: 'reload_unavailable' })
    // 这是诚实报告的下界：磁盘上已有提供商，但进程内没有加载，闸门仍关闭。
    assert.equal(aggregationModeActive(state.cfg), false)
    state.cfg = loadConfig()
    assert.equal(aggregationModeActive(state.cfg), true, '显式重载后必须为 true')
  })
})

test('reload 抛错：写事务 fail-closed，响应是 typed 失败而不是「已生效」', async () => {
  await withIsolatedConfig(async ({ state }) => {
    const failing = () => { const e = new Error('config_unreadable'); e.code = 'config_unreadable'; throw e }
    const out = await handleAggregationApi(addCtx(state, failing))
    // 配置事务在 commit marker 之后才 publish；重载失败会让本次提交整体失败（fail-closed），
    // 调用方拿到稳定 code，而不是 201 + 谎称聚合模式已生效。
    assert.equal(out.status, 400)
    assert.equal(out.body.ok, false)
    assert.equal(out.body.code, 'config_unreadable')
    assert.equal(aggregationModeActive(state.cfg), false, '失败时内存不得报告聚合模式生效')
  })
})

test('删除提供商后重载：聚合状态在同一进程内 true → false', async () => {
  await withIsolatedConfig(async ({ state, reload }) => {
    const added = await handleAggregationApi(addCtx(state, reload))
    assert.equal(added.status, 201)
    assert.equal(aggregationModeActive(state.cfg), true)
    const out = await handleAggregationApi({
      method: 'DELETE',
      path: '/api/aggregation/providers/console',
      cfg: state.cfg,
      log: null,
      rawBody: '{}',
      explicitAdmin: true,
      isLocal: true,
      reload,
    })
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(out.body.reload.applied, true)
    assert.equal(out.body.reload.needsRestart, false)
    assert.equal(aggregationModeActive(state.cfg), false, '删除后内存不得继续报告聚合模式生效')
  })
})
