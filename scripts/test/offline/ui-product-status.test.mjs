// UX-00：产品状态投影契约测试（纯函数，无 DOM、无网络）。
// 目的：先固定"用户看到什么状态 + 唯一主操作"，再让视图实现对齐；
// 任何把 unknown 渲染成 false/0/健康、或没有真实推理证据就标 verified 的实现都会在这里失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCT_STATUS_CONTRACT, HOME_STATES, GO_TARGET_MODEL, GO_PUBLIC_MODEL_ID, GO_TARGET_PUBLIC_ID, matchesGoTargetId,
  deriveProductStatus, deriveGo, deriveCodex, deriveOfficial, deriveAggregation,
  classifyAggregationError, nextPrimaryAction, homeStateOf, overallOf,
} from '../../../src/ui-next/js/product-status.js'

const STATUS_BASE = {
  needAuth: false,
  configVersion: 3,
  server: { host: '127.0.0.1', port: 8787, keyEncrypted: true },
  providers: [],
  models: [],
  virtualModels: [],
  global: { requests: 0, errors: 0 },
  official: { credential: 'detected', reason: 'local_codex_chatgpt', source: 'local_codex_auth_probe' },
}

function statusWith (patch) {
  return Object.assign({}, STATUS_BASE, patch || {})
}

function health (patch) {
  return Object.assign({
    ok: true,
    mode: 'official',
    reason: null,
    needsRestart: false,
    detect: {
      cli: { found: true, version: '1.2.3', versionState: 'known' },
      desktop: { found: true, version: '1.2.3', versionState: 'known' },
      bundledCli: { found: true, version: '1.2.3', versionState: 'known' },
      state: { mode: 'official', appliedAt: null, appliedSha: null },
      restart: { needed: false, reason: 'not_aggregated' },
    },
    backup: { available: false },
    activation: { appliedSha: null, lastApply: null, needsRestart: false },
  }, patch || {})
}

function snap (patch) {
  return Object.assign({
    providers: { providers: [] },
    models: { models: [], discovery: { state: 'unknown' } },
    health: health(),
    diagnostics: { diagnostics: [] },
  }, patch || {})
}

test('契约标识与状态机词表固定', () => {
  assert.equal(PRODUCT_STATUS_CONTRACT, 'mg-ui-product-status/1')
  assert.ok(HOME_STATES.includes('needs_go_key'))
  assert.ok(HOME_STATES.includes('needs_codex_restart'))
  assert.ok(HOME_STATES.includes('read_only_unknown'))
  assert.equal(GO_TARGET_MODEL, 'deepseek-v4.1-flash')
  assert.equal(GO_PUBLIC_MODEL_ID, 'mg-opencodego-deepseek-v4-1-flash')
  assert.equal(GO_TARGET_PUBLIC_ID, GO_PUBLIC_MODEL_ID)
  assert.ok(matchesGoTargetId('mg-opencodego-deepseek-v4-1-flash'))
  assert.ok(matchesGoTargetId('opencodego/deepseek-v4.1-flash'))
  assert.ok(matchesGoTargetId('deepseek-v4.1-flash'))
  assert.ok(!matchesGoTargetId('mg-opencodego-gpt-6-luna'))
})

test('锁定与加载：不显示任何成功状态', () => {
  const locked = deriveProductStatus({ authenticatedAdmin: false, status: statusWith(), aggregation: snap() })
  assert.equal(locked.state, 'locked')
  assert.equal(locked.primary.id, 'unlock')
  assert.equal(locked.overall.level, 'locked')

  const loading = deriveProductStatus({ loading: true, status: null, aggregation: null })
  assert.equal(loading.state, 'loading')
  assert.equal(loading.primary.kind, 'wait')
  assert.equal(loading.overall.level, 'loading')
})

test('聚合接口 404：状态未知而不是“未启用/0 个模型”', () => {
  const error = { status: 404, data: { code: 'not_mounted' }, message: '404' }
  assert.equal(classifyAggregationError(error).kind, 'unsupported')
  const ps = deriveProductStatus({ authenticatedAdmin: true, status: statusWith(), aggregation: null, aggregationError: error })
  assert.equal(ps.state, 'read_only_unknown')
  assert.equal(ps.aggregation.supported, false)
  assert.equal(ps.aggregation.mode, 'unknown')
  assert.equal(ps.go.state, 'unknown')
  assert.equal(ps.codex.found, false)
  assert.equal(ps.codex.detectionLevel, 'unknown')
  assert.match(ps.go.detail, /404/)
  // 404 时不能把未知折叠成计数事实（modelCount/null 冒充 0）。
  assert.equal(ps.go.discoveryState, 'unknown')
  assert.equal(ps.go.credentialPresent, false)
  assert.equal(ps.go.targetModelConfigured, false)
  assert.equal(ps.primary.label, '查看高级诊断')
})

test('新用户：无 Codex → 先解决安装，且只有一个主 CTA', () => {
  const noCodex = health({ detect: { cli: { found: false }, desktop: { found: false }, bundledCli: { found: false }, restart: { needed: false } } })
  const ps = deriveProductStatus({ authenticatedAdmin: true, status: statusWith(), aggregation: snap({ health: noCodex }) })
  assert.equal(ps.state, 'cannot_detect_codex')
  assert.equal(ps.primary.id, 'locate-codex')
  assert.equal(ps.go.state, 'missing')
  assert.equal(ps.official.state, 'detected')
})

test('已登录 ChatGPT + 无 Go Key → 官方保留，主 CTA 是连接 Go', () => {
  const ps = deriveProductStatus({ authenticatedAdmin: true, status: statusWith(), aggregation: snap() })
  assert.equal(ps.state, 'needs_go_key')
  assert.equal(ps.primary.id, 'connect-go')
  assert.equal(ps.primary.label, '连接 OpenCode Go')
  assert.equal(ps.official.state, 'detected')
  assert.equal(ps.official.level, 'detected')
  assert.notEqual(ps.official.level, 'runtime-verified')
})

test('已保存 Key 但目标模型未配置 → 完成 DeepSeek 接入', () => {
  const status = statusWith({ providers: [{ id: 'opencodego', hasKey: true, keySource: 'file', st: { state: 'ok' } }] })
  const ps = deriveProductStatus({
    authenticatedAdmin: true,
    status,
    aggregation: snap({ providers: { providers: [{ id: 'opencodego', kind: 'opencode-go', discoveryState: 'unknown', modelCount: null }] } }),
  })
  assert.equal(ps.go.credentialPresent, true)
  assert.equal(ps.go.targetModelConfigured, false)
  assert.equal(ps.go.state, 'configured')
  assert.match(ps.go.label, /连接未完成/)
  assert.equal(ps.state, 'ready_to_enable')
  assert.equal(ps.primary.id, 'configure-target')
})

test('Key + 目标模型 + 官方模式 → 唯一主操作是启用聚合', () => {
  const status = statusWith({ providers: [{ id: 'opencodego', hasKey: true, keySource: 'file' }] })
  const ps = deriveProductStatus({
    authenticatedAdmin: true,
    status,
    aggregation: snap({
      providers: { providers: [{ id: 'opencodego', kind: 'opencode-go', discoveryState: 'complete', modelCount: 1 }] },
      models: { models: [{ publicId: GO_PUBLIC_MODEL_ID, upstreamId: GO_TARGET_MODEL, authorized: true, evidence: { source: 'published_catalog' } }], discovery: { state: 'complete' } },
    }),
  })
  assert.equal(ps.go.targetModelConfigured, true)
  assert.equal(ps.go.state, 'configured')
  assert.equal(ps.go.level, 'configured')
  assert.equal(ps.state, 'ready_to_enable')
  assert.equal(ps.primary.id, 'enable-aggregation')
  assert.equal(ps.primary.label, '启用聚合模式')
})

test('目标模型匹配同时接受已发布公共 ID 与上游别名，且不把其它模型算作目标', () => {
  const status = statusWith({ providers: [{ id: 'opencodego', hasKey: true }], models: [{ name: GO_TARGET_PUBLIC_ID }] })
  const published = deriveGo(status, snap({ providers: { providers: [{ id: 'opencodego', kind: 'opencode-go' }] } }))
  assert.equal(published.targetModelConfigured, true)

  const aliasStatus = statusWith({ providers: [{ id: 'opencodego', hasKey: true }], models: [] })
  const byUpstream = deriveGo(aliasStatus, snap({
    providers: { providers: [{ id: 'opencodego', kind: 'opencode-go' }] },
    models: { models: [{ publicId: 'opencodego/deepseek-v4.1-flash', upstreamId: GO_TARGET_MODEL, authorized: true }] },
  }))
  assert.equal(byUpstream.targetModelConfigured, true)

  const other = deriveGo(statusWith({ providers: [{ id: 'opencodego', hasKey: true }], models: [] }), snap({
    providers: { providers: [{ id: 'opencodego', kind: 'opencode-go' }] },
    models: { models: [{ publicId: 'mg-opencodego-gpt-6-luna', upstreamId: 'gpt-6-luna', authorized: true }] },
  }))
  assert.equal(other.targetModelConfigured, false)
})

test('只有真实 lastServing 命中才允许 runtime-verified', () => {
  const status = statusWith({
    providers: [{ id: 'opencodego', hasKey: true, keySource: 'file' }],
    lastServing: { model: GO_PUBLIC_MODEL_ID, provider: 'opencodego', at: 1 },
  })
  const go = deriveGo(status, snap({
    providers: { providers: [{ id: 'opencodego', kind: 'opencode-go', discoveryState: 'complete' }] },
    models: { models: [{ publicId: GO_PUBLIC_MODEL_ID, upstreamId: GO_TARGET_MODEL, authorized: true, evidence: { source: 'published_catalog' } }] },
  }))
  assert.equal(go.state, 'verified')
  assert.equal(go.level, 'runtime-verified')

  const noEvidence = deriveGo(statusWith({ providers: [{ id: 'opencodego', hasKey: true }] }), snap({
    providers: { providers: [{ id: 'opencodego', kind: 'opencode-go', discoveryState: 'complete' }] },
    models: { models: [{ publicId: GO_PUBLIC_MODEL_ID, authorized: true, evidence: { source: 'published_catalog' } }] },
  }))
  assert.equal(noEvidence.state, 'configured')
  assert.notEqual(noEvidence.level, 'runtime-verified')
})

test('聚合已启用 + 需重启 → 完成重启；重启后 → 准备就绪', () => {
  const aggregatedHealth = health({
    mode: 'aggregated',
    needsRestart: true,
    detect: { cli: { found: true }, desktop: { found: true, version: '1.2.3', versionState: 'known' }, bundledCli: { found: true }, state: { mode: 'aggregated', appliedSha: 'abc123' }, restart: { needed: true, reason: 'client_running_with_old_config' } },
    backup: { available: true },
    activation: { appliedSha: 'abc123', needsRestart: true },
  })
  const status = statusWith({ providers: [{ id: 'opencodego', hasKey: true }], models: [{ name: GO_PUBLIC_MODEL_ID }] })
  const restartPs = deriveProductStatus({
    authenticatedAdmin: true,
    status,
    aggregation: snap({ health: aggregatedHealth, providers: { providers: [{ id: 'opencodego', kind: 'opencode-go', discoveryState: 'complete' }] }, models: { models: [{ publicId: GO_PUBLIC_MODEL_ID, authorized: true }] } }),
  })
  assert.equal(restartPs.state, 'needs_codex_restart')
  assert.equal(restartPs.primary.id, 'restart-codex')
  assert.equal(restartPs.aggregation.mode, 'aggregated')
  assert.equal(restartPs.aggregation.configSha, 'abc123')
  assert.equal(restartPs.aggregation.backupAvailable, true)
  assert.ok(restartPs.secondary.some((s) => s.id === 'advanced'))
  assert.ok(restartPs.secondary.some((s) => s.id === 'deactivate' && s.danger === true))

  const readyHealth = Object.assign({}, aggregatedHealth, {
    needsRestart: false,
    detect: Object.assign({}, aggregatedHealth.detect, { restart: { needed: false, reason: 'client_restarted_after_apply' } }),
    activation: { appliedSha: 'abc123', needsRestart: false },
  })
  const readyPs = deriveProductStatus({
    authenticatedAdmin: true,
    status,
    aggregation: snap({ health: readyHealth, providers: { providers: [{ id: 'opencodego', kind: 'opencode-go', discoveryState: 'complete' }] }, models: { models: [{ publicId: GO_PUBLIC_MODEL_ID, authorized: true }] } }),
  })
  assert.equal(readyPs.state, 'ready')
  assert.equal(readyPs.primary.id, 'use-codex')
  assert.equal(readyPs.overall.level, 'ready')
})

test('409 冲突：进入冲突态且不声称已写入', () => {
  const conflict = classifyAggregationError({ status: 409, data: { code: 'version_conflict', currentVersion: 9 }, message: 'conflict' })
  assert.equal(conflict.kind, 'conflict')
  const ps = deriveProductStatus({ authenticatedAdmin: true, status: statusWith({ providers: [{ id: 'opencodego', hasKey: true }] }), aggregation: snap(), aggregationError: { status: 409, data: { code: 'version_conflict' } } })
  assert.equal(ps.state, 'conflict')
  assert.equal(ps.primary.id, 'resolve-conflict')
  assert.equal(ps.overall.level, 'error')
})

test('官方登录探测：missing/unknown 不得显示成已登录', () => {
  const detected = deriveOfficial(statusWith())
  assert.equal(detected.state, 'detected')
  const missing = deriveOfficial(statusWith({ official: { credential: 'missing', reason: 'auth_file_missing' } }))
  assert.equal(missing.state, 'missing')
  assert.equal(missing.label, '待登录')
  const unknown = deriveOfficial({})
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.label, '未验证')
  const apiKeyMode = deriveOfficial(statusWith({ official: { credential: 'missing', reason: 'api_key_mode' } }))
  assert.equal(apiKeyMode.state, 'missing')
  assert.match(apiKeyMode.detail, /重新登录/)
})

test('Codex 未找到时不提供假“打开”按钮；重启判定来自真实 detect', () => {
  const notFound = deriveCodex(snap({ health: health({ detect: { cli: { found: false }, desktop: { found: false }, bundledCli: { found: false } } }) }))
  assert.equal(notFound.found, false)
  const ps = deriveProductStatus({ authenticatedAdmin: true, status: statusWith(), aggregation: snap({ health: health({ detect: { cli: { found: false }, desktop: { found: false }, bundledCli: { found: false } } }) }) })
  assert.ok(!/打开 Codex/.test(ps.primary.label))
  assert.equal(ps.primary.kind, 'route')

  const unverified = deriveCodex(snap({ health: health({ mode: 'aggregated', needsRestart: true, detect: { desktop: { found: true }, restart: { needed: true, reason: 'client_restart_unverified' } } }) }))
  assert.equal(unverified.restartNeeded, true)
  assert.equal(unverified.label, '需要重新打开')
})

test('聚合模式未知不写成未启用', () => {
  const unknown = deriveAggregation({ health: { ok: true, mode: 'unrecognized' } })
  assert.equal(unknown.mode, 'unrecognized')
  assert.equal(unknown.label, '状态未知')
  const missing = deriveAggregation(snap())
  assert.equal(missing.mode, 'official')
})

test('每个状态都有一个可展示的主操作与总体结论', () => {
  const cases = [
    { authenticatedAdmin: false },
    { authenticatedAdmin: true, loading: true },
    { authenticatedAdmin: true, aggregationError: { status: 404 } },
    { authenticatedAdmin: true, status: statusWith(), aggregation: snap() },
    { authenticatedAdmin: true, status: statusWith(), aggregation: snap({ health: health({ detect: { desktop: { found: false }, bundledCli: { found: false }, cli: { found: false }, restart: { needed: false } } }) }) },
  ]
  for (const c of cases) {
    const ps = deriveProductStatus(c)
    assert.ok(HOME_STATES.includes(ps.state), ps.state + ' 必须是已定义状态')
    assert.equal(typeof ps.primary.label, 'string')
    assert.ok(ps.primary.label.length > 0)
    assert.equal(ps.primary.id, nextPrimaryAction(ps).id)
    assert.ok(ps.overall && ps.overall.label)
    assert.equal(ps.state, homeStateOf(ps))
    assert.deepEqual(overallOf(ps), ps.overall)
  }
})

// —— /api/status.official：只读登录探测的 HTTP 契约（隔离实例，不触达真实上游） ——
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'

async function codexHomeWith (auth) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-ux00-codex-'))
  if (auth) await writeFile(join(dir, 'auth.json'), JSON.stringify(auth))
  return dir
}

test('GET /api/status.official：检测到 ChatGPT 登录但不回显任何凭据', { timeout: 30000 }, async (t) => {
  const codexHome = await codexHomeWith({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-token-must-not-leak', refresh_token: 'fixture-refresh-must-not-leak' }, last_refresh: '2026-11-15T00:00:00Z' })
  const gw = await startGateway({ name: 'ux00-official-detected', env: { CODEX_HOME: codexHome, MG_ADMIN_TOKEN: 'ux00-token' } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })
  const res = await gw.get('/api/status', { authorization: 'Bearer ux00-token' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.official, '/api/status 必须返回 official 投影')
  assert.equal(body.official.credential, 'detected')
  assert.equal(body.official.reason, 'local_codex_chatgpt')
  assert.equal(body.official.authMode, 'chatgpt')
  assert.equal(body.official.level, 'detected')
  assert.equal(body.official.source, 'local_codex_auth_probe')
  assert.ok(body.official.checkedAt)
  const raw = JSON.stringify(body)
  assert.doesNotMatch(raw, /fixture-token-must-not-leak/, '状态投影不得含 access_token')
  assert.doesNotMatch(raw, /fixture-refresh-must-not-leak/, '状态投影不得含 refresh_token')
  // 该投影只是 detected：UI 不得因此显示"官方推理已验证"。
  assert.notEqual(body.official.level, 'runtime-verified')
})

test('GET /api/status.official：没有登录文件时是 missing，不是 detected/verified', { timeout: 30000 }, async (t) => {
  const codexHome = await codexHomeWith(null)
  const gw = await startGateway({ name: 'ux00-official-missing', env: { CODEX_HOME: codexHome, MG_ADMIN_TOKEN: 'ux00-token' } })
  t.after(async () => { await gw.stop(); await rm(codexHome, { recursive: true, force: true }) })
  const body = await (await gw.get('/api/status', { authorization: 'Bearer ux00-token' })).json()
  assert.equal(body.official.credential, 'missing')
  assert.equal(body.official.reason, 'auth_file_missing')
  const derived = deriveOfficial(body)
  assert.equal(derived.state, 'missing')
  assert.equal(derived.label, '待登录')
})

