// MG-FIX-P1-03：显式请求的目标模型若不在当前聚合目录中，必须 fail-closed（稳定 422），
// 绝不静默回退到 cfg.defaults.model 或目录首项（可能是官方 GPT），零配置写入、零模型出站。
//
// 黑盒驱动公开 HTTP 面 POST /api/aggregation/activate → activationOptions() → pickModel()。
// 全程离线、隔离 MG_CONFIG_DIR、不联网、不发任何模型请求、不碰真实 ~/.codex。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAggregationApi } from '../../../src/aggregation/api.js'
import { loadConfig } from '../../../src/router.js'

const DEEPSEEK = 'mg-opencodego-deepseek-v4-1-flash'
const OFFICIAL = 'gpt-6-luna'

async function withFixture (fn, { slugs = [OFFICIAL], defaultModel = DEEPSEEK } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-p1-03-'))
  const prevDir = process.env.MG_CONFIG_DIR
  const prevCfg = process.env.MG_CONFIG
  process.env.MG_CONFIG_DIR = dir
  delete process.env.MG_CONFIG
  const configPath = join(dir, 'gateway.json')
  await writeFile(configPath, JSON.stringify({
    defaults: defaultModel ? { model: defaultModel } : {},
    providers: {},
    models: {},
    virtualModels: [],
    configVersion: 7,
  }))
  // 发布一份“当前目录”：只有 slugs，不含 DeepSeek，用于验证不静默换模。
  const catRoot = join(dir, 'aggregation', 'catalog', 'local')
  await mkdir(join(catRoot, 'versions'), { recursive: true })
  const versionFile = 'v000001-abcdef12.json'
  await writeFile(join(catRoot, versionFile), JSON.stringify({ models: slugs.map((s) => ({ slug: s, display_name: s })) }))
  await writeFile(join(catRoot, 'current.json'), JSON.stringify({ models: slugs.map((s) => ({ slug: s, display_name: s })) }))
  await writeFile(join(catRoot, 'state.json'), JSON.stringify({
    schema: 'modelgate.codex-catalog.state/1',
    currentVersion: 1,
    highWaterVersion: 1,
    current: { version: 1, file: versionFile, sha256: 'abcdef12', counts: { total: slugs.length } },
    history: [],
    retiredBindings: {},
    lastRollback: null,
  }))
  try {
    return await fn({ dir, configPath })
  } finally {
    if (prevDir === undefined) delete process.env.MG_CONFIG_DIR
    else process.env.MG_CONFIG_DIR = prevDir
    if (prevCfg === undefined) delete process.env.MG_CONFIG
    else process.env.MG_CONFIG = prevCfg
    await rm(dir, { recursive: true, force: true })
  }
}

function activateCtx (cfg, model) {
  const body = {}
  if (model !== undefined) body.model = model
  return {
    method: 'POST',
    path: '/api/aggregation/activate',
    cfg,
    log: null,
    rawBody: JSON.stringify(body),
    explicitAdmin: true,
    isLocal: true,
  }
}

test('P1-03（核心）：显式请求 DeepSeek 但目录不含它 → 422，不静默选官方 GPT', async () => {
  await withFixture(async ({ configPath }) => {
    const cfg = loadConfig()
    const before = await readFile(configPath, 'utf8')
    const out = await handleAggregationApi(activateCtx(cfg, DEEPSEEK))
    assert.equal(out.status, 422, JSON.stringify(out.body))
    assert.equal(out.body.code, 'requested_model_unavailable')
    assert.equal(out.body.detail && out.body.detail.requested, DEEPSEEK)
    assert.equal((out.body.detail && out.body.detail.available || []).includes(OFFICIAL), true)
    const after = await readFile(configPath, 'utf8')
    assert.equal(after, before, '失败必须零配置写入')
  })
})

test('P1-03：任意未知显式 ID → 稳定 422（不落到目录首项）', async () => {
  await withFixture(async ({ configPath }) => {
    const before = await readFile(configPath, 'utf8')
    const out = await handleAggregationApi(activateCtx(loadConfig(), 'totally-unknown-model'))
    assert.equal(out.status, 422)
    assert.equal(out.body.code, 'requested_model_unavailable')
    assert.equal(await readFile(configPath, 'utf8'), before)
  })
})

test('P1-03：未显式传 model → 保留默认规则（不触发 422，进入同意流程）', async () => {
  await withFixture(async () => {
    const out = await handleAggregationApi(activateCtx(loadConfig(), undefined))
    // 未显式指定：pickModel 回退到目录首项 gpt-6-luna，preview 通过 → 428 consent_required。
    assert.notEqual(out.status, 422, JSON.stringify(out.body))
    assert.equal(out.status, 428)
    assert.equal(out.body.code, 'consent_required')
  })
})

test('P1-03：显式传入目录中存在的模型 → 正常进入同意流程（不误拒）', async () => {
  await withFixture(async () => {
    const out = await handleAggregationApi(activateCtx(loadConfig(), OFFICIAL))
    assert.notEqual(out.status, 422, JSON.stringify(out.body))
    assert.equal(out.status, 428)
    assert.equal(out.body.code, 'consent_required')
  })
})
