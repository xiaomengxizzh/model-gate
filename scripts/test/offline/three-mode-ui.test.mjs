// P3 三模式 Web 控制台 UI 离线契约测试（直连 official / 路由 route / 聚合 aggregated）。
// 全部为合成占位串；不含任何真实 apikey / token / 凭据形态字符串。
// 本套件由集成阶段统一登记到 scripts/test/run.mjs（本轮不修改 run.mjs）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const AGG_VIEW = join(ROOT, 'src/ui-next/js/views/aggregation.js')
const CONNECTIONS_VIEW = join(ROOT, 'src/ui-next/js/views/connections.js')
const PRODUCT_STATUS = join(ROOT, 'src/ui-next/js/product-status.js')
const DASHBOARD = join(ROOT, 'src/ui-next/js/views/dashboard.js')

const loadAgg = () => import(new URL('../../../src/ui-next/js/views/aggregation.js', import.meta.url))
const loadStatus = () => import(new URL('../../../src/ui-next/js/product-status.js', import.meta.url))

test('modeLabel：三模式 + 未知 + drifted 文案，unknown 绝不显示成直连', async () => {
  const agg = await loadAgg()
  assert.match(agg.modeLabel('official').label, /官方直连（不经 ModelGate）/)
  assert.match(agg.modeLabel('route').label, /路由模式（纯 DeepSeek，无 GPT）/)
  assert.match(agg.modeLabel('aggregated').label, /聚合模式（GPT 父 \+ DeepSeek 子）/)
  const unknown = agg.modeLabel('unknown')
  assert.equal(unknown.label, '状态未知')
  assert.equal(unknown.kind, 'warn')
  assert.match(agg.modeLabel('something-else').label, /状态未知/)
  assert.doesNotMatch(agg.modeLabel('unknown').label, /直连/)

  const drifted = agg.modeLabel('aggregated', true)
  assert.equal(drifted.drifted, true)
  assert.equal(drifted.kind, 'warn')
  assert.match(drifted.label, /配置漂移/)
  // unknown 即便带 drifted 也不伪装成直连或已生效
  assert.match(agg.modeLabel('unknown', true).label, /状态未知/)
})

test('父模型选项：来源 selectableParents，只有 luna 标 PASS_REAL，其余 UNVERIFIED', async () => {
  const agg = await loadAgg()
  const modes = {
    current: 'aggregated',
    modes: [
      { id: 'official', label: '官方直连' },
      { id: 'aggregated', label: '聚合', selectableParents: ['gpt-6-luna', 'gpt-5.2', { id: 'gpt-6-luna' }] },
    ],
  }
  const opts = agg.selectableParentModels(modes)
  const ids = opts.map((o) => o.id)
  assert.deepEqual(ids, ['gpt-6-luna', 'gpt-5.2'])
  const luna = opts.find((o) => o.id === 'gpt-6-luna')
  const other = opts.find((o) => o.id === 'gpt-5.2')
  assert.equal(luna.verified, true)
  assert.match(luna.label, /已签收\/PASS_REAL/)
  assert.equal(other.verified, false)
  assert.match(other.label, /未验证（UNVERIFIED）/)
  // 不得让非 luna 选项暗示同等可信
  assert.doesNotMatch(other.label, /PASS_REAL/)
  // 默认兜底项仍是 luna
  assert.equal(agg.selectableParentModels({ modes: [] })[0].id, 'gpt-6-luna')
  assert.equal(agg.DEFAULT_PARENT_MODEL, 'gpt-6-luna')
})

test('buildSwitchRequest / buildRollbackRequest：请求体字段符合冻结契约', async () => {
  const agg = await loadAgg()
  const preview = { consentToken: 'SYNTHETIC_CONSENT_TOKEN', expectedSha: 'a'.repeat(64) }
  const sw = agg.buildSwitchRequest(preview, true, 'aggregated', 'gpt-6-luna')
  assert.equal(sw.mode, 'aggregated')
  assert.equal(sw.parentModel, 'gpt-6-luna')
  assert.equal(sw.consentToken, 'SYNTHETIC_CONSENT_TOKEN')
  assert.equal(sw.expectedSha, 'a'.repeat(64))
  const swRoute = agg.buildSwitchRequest(preview, true, 'route', null)
  assert.equal(swRoute.mode, 'route')
  assert.equal('parentModel' in swRoute, false, '路由固定 deepseek 父，不带 parentModel')
  const swPreview = agg.buildSwitchRequest(preview, false, 'official', null)
  assert.equal(swPreview.consentToken, '')
  assert.equal(swPreview.expectedSha, 'a'.repeat(64))

  const rb = agg.buildRollbackRequest(preview, true)
  assert.equal(rb.consentToken, 'SYNTHETIC_CONSENT_TOKEN')
  assert.equal(rb.expectedSha, 'a'.repeat(64))
  assert.equal('mode' in rb, false, '回滚目标由服务端取 previousMode')
})

test('重启提示：route/aggregated 需重启，切回 official（退出后）也要重启；不显示立即生效', async () => {
  const agg = await loadAgg()
  assert.equal(agg.restartNotice(null, 'official').needed, false)
  assert.equal(agg.restartNotice(null, 'route').needed, true)
  assert.equal(agg.restartNotice(null, 'aggregated').needed, true)
  assert.match(agg.restartNotice(null, 'aggregated').detail, /完全退出/)
  const afterExit = agg.restartNotice({ needed: true, reason: 'client_running_after_exit' }, 'official')
  assert.equal(afterExit.needed, true)
  assert.match(afterExit.label, /退出后也要重启/)
  assert.match(afterExit.detail, /退出后也要重启/)

  const src = readFileSync(AGG_VIEW, 'utf8')
  assert.match(src, /请完全退出并重新打开 Codex 才能使用新模式/)
  assert.doesNotMatch(src, /已立即生效/, '切换后不得声称立即生效')

  const conn = readFileSync(CONNECTIONS_VIEW, 'utf8')
  assert.match(conn, /请完全退出并重新打开 Codex 才能使用新模式/)
  assert.doesNotMatch(conn, /已立即生效/, '切换后不得声称立即生效')
})

test('端点常量与源码：switch/rollback/modes 已接线，预览表支持删除行，无 token 输入框', async () => {
  const agg = await loadAgg()
  const ep = agg.AGGREGATION_ENDPOINTS
  assert.equal(ep.modes, '/api/aggregation/modes')
  assert.equal(ep.switch, '/api/aggregation/switch')
  assert.equal(ep.rollback, '/api/aggregation/rollback')
  const src = readFileSync(AGG_VIEW, 'utf8')
  assert.match(src, /kind === 'remove'/)
  assert.match(src, /删除该字段/)
  assert.match(src, /AGGREGATION_ENDPOINTS\.switch/)
  assert.match(src, /AGGREGATION_ENDPOINTS\.rollback/)
  assert.match(src, /AGGREGATION_ENDPOINTS\.modes/)
  const conn = readFileSync(CONNECTIONS_VIEW, 'utf8')
  assert.match(conn, /AGGREGATION_ENDPOINTS\.switch/)
  assert.match(conn, /AGGREGATION_ENDPOINTS\.rollback/)
  assert.match(conn, /modeChooser/)
  // 不得出现 consentToken 输入框或字面量 Key（既有 Go API Key 输入框是正常接入所需，不在此列）
  assert.doesNotMatch(src, /field\(['"]consentToken['"]/)
  assert.doesNotMatch(conn, /field\(['"]consentToken['"]/)
  assert.doesNotMatch(src + conn, /placeholder:[^}]*consentToken/i)
})

test('product-status：deriveAggregation 三模式 + 漂移 + unknown，homeStateOf 区分 official/route', async () => {
  const ps = await loadStatus()
  assert.match(ps.deriveAggregation({ health: { mode: 'official' } }).label, /官方直连/)
  assert.match(ps.deriveAggregation({ health: { mode: 'route' } }).label, /路由模式/)
  assert.match(ps.deriveAggregation({ health: { mode: 'aggregated' } }).label, /聚合模式/)
  const unknown = ps.deriveAggregation({ health: { mode: 'weird' } })
  assert.equal(unknown.label, '状态未知')
  assert.equal(unknown.modeKnown, false)
  const drifted = ps.deriveAggregation({ health: { mode: 'official', drifted: true } })
  assert.equal(drifted.drifted, true)
  assert.match(drifted.label, /配置漂移/)
  assert.match(drifted.detail, /不显示成直连/)

  const base = {
    loading: false, authenticatedAdmin: true,
    official: {}, go: { credentialPresent: true, targetModelConfigured: true }, codex: { found: true },
  }
  const mk = (mode, extra = {}) => ({
    ...base,
    aggregation: { supported: true, modeKnown: true, mode, ...extra },
  })
  assert.equal(ps.homeStateOf(mk('official')), 'ready_to_enable')
  assert.equal(ps.homeStateOf(mk('route')), 'ready')
  assert.equal(ps.homeStateOf(mk('route', { drifted: true })), 'recoverable_error')
  assert.equal(ps.homeStateOf(mk('unknown', { modeKnown: false })), 'recoverable_error')
})

test('dashboard：modeText 三模式文案同步，unknown 不显示为直连', () => {
  const src = readFileSync(DASHBOARD, 'utf8')
  assert.match(src, /官方直连（不经 ModelGate）/)
  assert.match(src, /路由（纯 DeepSeek，无 GPT）/)
  assert.match(src, /聚合（GPT 父 \+ DeepSeek 子）/)
  assert.match(src, /状态未知/)
  assert.match(src, /请完全退出并重新打开 Codex 才能使用新模式（退出后也要重启）/)
})

test('脱敏：套件仅含合成占位串，无真实密钥形态字符串', () => {
  const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.match(testSrc, /SYNTHETIC_CONSENT_TOKEN/, '使用合成占位串')
  assert.doesNotMatch(testSrc, /sk-[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(testSrc, /eyJ[A-Za-z0-9_-]{20,}/)
  assert.doesNotMatch(testSrc, /ghp_[A-Za-z0-9]{16,}/)
})
