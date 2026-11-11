// E8 官方额度预警 + 手动应急态回归（纯函数，无网络/无文件/无真实额度 API）。
// 覆盖：unknown 严格不猜测、normal/80/95/耗尽阈值、确认三元组、恢复、持久化形状、输出无凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateQuota, normalizeQuotaConfig, normalizeQuotaReading,
  createQuotaState, enterEmergency, exitEmergency,
  serializeQuotaState, parseQuotaState, describeEmergencyImpacts,
  QUOTA_DISPLAY_UNKNOWN, QUOTA_STATE_VERSION, DEFAULT_CODEX_QUOTA,
} from '../../../src/codex/quota.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const cfgTrusted = { defaults: { codexQuota: { source: 'trusted' } } }
const cfgNone = { defaults: { codexQuota: {} } }
const q = (usedPercent, extra) => ({ source: 'trusted', ok: true, usedPercent, ...(extra || {}) })

test('E8 unknown：无来源/来源失败/非法值一律 UNKNOWN，绝不虚构百分比', { timeout: 30000 }, async () => {
  const noCfg = await evaluateQuota({})
  assert.equal(noCfg.state, 'unknown')
  assert.equal(noCfg.display, QUOTA_DISPLAY_UNKNOWN)
  assert.equal(noCfg.usedPercent, null)
  assert.equal(noCfg.reason, 'no_source_configured')

  // 配置显式 source:'none' 时，即使注入了读数也不采用（严格）
  const disabled = await evaluateQuota({ cfg: cfgNone, quota: q(42) })
  assert.equal(disabled.state, 'unknown')
  assert.equal(disabled.usedPercent, null)
  assert.equal(disabled.reason, 'no_trusted_source')

  const failed = await evaluateQuota({ cfg: cfgTrusted, quota: { ok: false, usedPercent: 42, error: 'network_down' } })
  assert.equal(failed.state, 'unknown')
  assert.equal(failed.usedPercent, null)
  assert.equal(failed.reason, 'network_down')

  const thrown = await evaluateQuota({ cfg: cfgTrusted, readQuota: async () => { throw new Error('boom') } })
  assert.equal(thrown.state, 'unknown')
  assert.equal(thrown.reason, 'source_error')

  const invalid = await evaluateQuota({ cfg: cfgTrusted, quota: q(150) })
  assert.equal(invalid.state, 'unknown', '越界值不得 clamp 成某个百分比')
  assert.equal(invalid.usedPercent, null)

  for (const r of [noCfg, disabled, failed, thrown, invalid]) {
    assert.equal(r.display, QUOTA_DISPLAY_UNKNOWN)
    assert.ok(r.impacts.some((i) => i.code === 'quota_unknown'))
    assert.equal(r.automation.autoSwitch, false)
    assert.ok(r.actions.some((a) => a.code === 'verify_quota_manually'))
  }
})

test('E8 阈值：normal / 80 warn / 95 critical / 100 耗尽', { timeout: 30000 }, async () => {
  const cases = [
    [0, 'normal', false], [42, 'normal', false], [79.9, 'normal', false],
    [80, 'warn', false], [80.1, 'warn', false], [94.9, 'warn', false],
    [95, 'critical', false], [99.9, 'critical', false], [100, 'critical', true],
  ]
  for (const [pct, state, exhausted] of cases) {
    const r = await evaluateQuota({ cfg: cfgTrusted, quota: q(pct), officialModels: ['gpt-6.1-sol'], now: NOW })
    assert.equal(r.state, state, pct + '% 应判为 ' + state)
    assert.equal(r.exhausted, exhausted, pct + '% exhausted')
    assert.deepEqual(r.thresholds, { warnPercent: 80, criticalPercent: 95 })
    if (state === 'unknown') continue
    assert.equal(r.display, pct + '%')
    assert.equal(r.usedPercent, pct)
    assert.equal(r.resetsAt, null, '没有 resetsAt 就写 null，不臆造重置时间')
  }
  const warn = await evaluateQuota({ cfg: cfgTrusted, quota: q(80), officialModels: ['gpt-6.1-sol'] })
  assert.ok(warn.impacts.some((i) => i.code === 'official_quota_warn'))
  assert.deepEqual(warn.impacts.find((i) => i.code === 'official_quota_warn').models, ['gpt-6.1-sol'])
  const crit = await evaluateQuota({ cfg: cfgTrusted, quota: q(96) })
  assert.ok(crit.impacts.some((i) => i.code === 'official_quota_critical'))
  assert.equal(crit.impacts.some((i) => i.code === 'official_quota_exhausted'), false)
  const out = await evaluateQuota({ cfg: cfgTrusted, quota: q(100) })
  assert.ok(out.impacts.some((i) => i.code === 'official_quota_exhausted'))
  assert.ok(out.impacts.some((i) => i.code === 'client_send_may_be_locked'))

  // 自定义阈值 + 顺序保护
  const custom = { defaults: { codexQuota: { source: 'trusted', warnPercent: 70, criticalPercent: 90 } } }
  assert.equal((await evaluateQuota({ cfg: custom, quota: q(70) })).state, 'warn')
  assert.equal((await evaluateQuota({ cfg: custom, quota: q(89.9) })).state, 'warn')
  assert.equal((await evaluateQuota({ cfg: custom, quota: q(90) })).state, 'critical')
  const inverted = normalizeQuotaConfig({ defaults: { codexQuota: { warnPercent: 90, criticalPercent: 70 } } })
  assert.deepEqual(inverted, { warnPercent: 90, criticalPercent: 90, source: 'none' })
})

test('E8 耗尽：只给建议动作与确认步骤，绝不自动切换/购买/退出登录', { timeout: 30000 }, async () => {
  const r = await evaluateQuota({
    cfg: cfgTrusted,
    quota: q(100, { resetsAt: '2026-11-12T00:00:00Z', plan: 'pro' }),
    officialModels: ['gpt-6.1-sol', 'gpt-6-sol'],
    now: NOW,
  })
  assert.equal(r.state, 'critical')
  assert.equal(r.exhausted, true)
  assert.equal(r.resetsAt, '2026-11-12T00:00:00.000Z')
  assert.equal(r.plan, 'pro')
  assert.deepEqual(r.automation, { autoSwitch: false, autoPurchase: false, logout: false, changeSessionProvider: false })
  for (const p of ['auto_switch_provider', 'auto_purchase_api_quota', 'logout_official_account', 'delete_credentials', 'silent_session_provider_change']) {
    assert.ok(r.prohibited.includes(p), '必须显式禁止: ' + p)
  }
  assert.equal(r.actions.some((a) => /^auto_/.test(a.code)), false, '动作里不得出现自动执行项')
  const wait = r.actions.find((a) => a.code === 'wait_for_quota_reset')
  assert.ok(wait)
  assert.equal(wait.resetsAt, '2026-11-12T00:00:00.000Z')
  const emergency = r.actions.find((a) => a.code === 'prepare_manual_emergency')
  assert.ok(emergency)
  assert.equal(emergency.requiresConfirmation, true)
  assert.deepEqual(emergency.requires, { acknowledged: true, reason: '', backupPoint: '' })
})

test('E8 应急态：确认三元组缺一不可、可恢复、影响声明完整', { timeout: 30000 }, async () => {
  const st = createQuotaState({ now: NOW })
  assert.equal(st.version, QUOTA_STATE_VERSION)
  assert.equal(st.mode, 'normal')
  assert.deepEqual(st.timeline, [])
  const snapshot = JSON.parse(JSON.stringify(st))

  const noAck = enterEmergency(st, { reason: 'quota exhausted', backupPoint: '/backups/a' })
  assert.equal(noAck.ok, false)
  assert.equal(noAck.code, 'acknowledgement_required')
  assert.equal(noAck.state.mode, 'normal')
  const noReason = enterEmergency(st, { acknowledged: true, backupPoint: '/backups/a' })
  assert.equal(noReason.code, 'reason_required')
  const noBackup = enterEmergency(st, { acknowledged: true, reason: 'quota exhausted' })
  assert.equal(noBackup.code, 'backup_point_required')

  const entered = enterEmergency(st, { acknowledged: true, reason: 'quota exhausted', backupPoint: '/backups/a' }, { now: NOW + 1000 })
  assert.equal(entered.ok, true)
  assert.equal(entered.code, 'emergency_entered')
  assert.equal(entered.state.mode, 'emergency')
  assert.equal(entered.state.emergency.since, NOW + 1000)
  assert.equal(entered.state.emergency.acknowledged, true)
  assert.equal(entered.state.emergency.reason, 'quota exhausted')
  assert.equal(entered.state.emergency.backupPoint, '/backups/a')
  assert.equal(entered.state.timeline.length, 1)
  const impactCodes = entered.impacts.map((i) => i.code)
  for (const code of ['provider_grouping_may_change', 'session_visibility_may_change', 'separate_instance_or_restart_required', 'not_seamless']) {
    assert.ok(impactCodes.includes(code), '应急态必须声明影响: ' + code)
  }
  assert.ok(entered.prohibited.includes('auto_switch_provider'))
  assert.deepEqual(st, snapshot, '进入应急不得修改传入的旧状态对象')

  const again = enterEmergency(entered.state, { acknowledged: true, reason: 'again', backupPoint: '/backups/b' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'already_emergency')
  assert.equal(again.state.timeline.length, 1, '重复进入不得重复记时间线')

  // evaluateQuota 在应急态下：即使额度 UNKNOWN，也保留应急标记与恢复动作
  const ev = await evaluateQuota({ cfg: cfgNone, emergencyState: entered.state, now: NOW + 1500 })
  assert.equal(ev.state, 'unknown')
  assert.equal(ev.mode, 'emergency')
  assert.equal(ev.emergency.active, true)
  assert.equal(ev.emergency.reason, 'quota exhausted')
  assert.ok(ev.impacts.some((i) => i.code === 'emergency_mode_active'))
  for (const code of impactCodes) assert.ok(ev.impacts.some((i) => i.code === code))
  assert.ok(ev.actions.some((a) => a.code === 'recover_emergency_when_ready' && a.requiresConfirmation === true))

  const recovered = exitEmergency(entered.state, { now: NOW + 2000, reason: 'official quota recovered' })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.code, 'emergency_recovered')
  assert.equal(recovered.state.mode, 'normal')
  assert.equal(recovered.state.emergency, null)
  assert.equal(recovered.state.lastEmergency.backupPoint, '/backups/a')
  assert.equal(recovered.state.lastEmergency.recoveredAt, NOW + 2000)
  assert.equal(recovered.state.timeline.length, 2)
  assert.deepEqual(recovered.state.timeline.map((t) => t.action), ['enter_emergency', 'recover'])
  const againExit = exitEmergency(recovered.state)
  assert.equal(againExit.ok, false)
  assert.equal(againExit.code, 'not_in_emergency')

  assert.ok(describeEmergencyImpacts().length >= 4)
})

test('E8 状态持久化：形状稳定、可往返、非法输入回退 normal', { timeout: 30000 }, async () => {
  const entered = enterEmergency(createQuotaState({ now: NOW }), { acknowledged: true, reason: 'r', backupPoint: '/b' }, { now: NOW + 10 })
  const persisted = serializeQuotaState(entered.state)
  assert.equal(persisted.version, QUOTA_STATE_VERSION)
  assert.equal(persisted.mode, 'emergency')
  assert.deepEqual(Object.keys(persisted).sort(), ['emergency', 'lastEmergency', 'mode', 'timeline', 'updatedAt', 'version'])
  for (const t of persisted.timeline) {
    for (const k of Object.keys(t)) assert.ok(['at', 'action', 'mode', 'reason', 'backupPoint'].includes(k), '时间线字段受控: ' + k)
  }
  const json = JSON.stringify(persisted)
  const round = parseQuotaState(json)
  assert.equal(round.mode, 'emergency')
  assert.equal(round.emergency.reason, 'r')
  assert.equal(serializeQuotaState(round).timeline.length, 1)

  assert.equal(parseQuotaState('{not json').mode, 'normal')
  assert.equal(parseQuotaState({ version: 99, mode: 'emergency' }).mode, 'normal')
  assert.equal(parseQuotaState(null).mode, 'normal')
})

test('E8 脱敏：来源对象的 token/apiKey/嵌套字段与自由文本错误不得进入输出', { timeout: 30000 }, async () => {
  const SECRET = 'sk-SECRET-MUST-NOT-LEAK'
  const out = await evaluateQuota({
    cfg: cfgTrusted,
    readQuota: async () => ({
      source: 'evil/source with spaces', ok: true, usedPercent: 42, plan: 'pro',
      resetsAt: '2026-11-12T00:00:00Z',
      token: 'Bearer ' + SECRET, apiKey: SECRET, nested: { secret: SECRET },
    }),
    now: NOW,
  })
  const json = JSON.stringify(out)
  assert.equal(json.includes(SECRET), false, '输出不得包含来源凭据')
  assert.equal(json.includes('Bearer'), false)
  assert.equal(json.includes('apiKey'), false)
  assert.equal(out.source, 'trusted', '不安全/不可信的 source 标签回退为 trusted')
  assert.equal(out.plan, 'pro')

  const failed = await evaluateQuota({ cfg: cfgTrusted, readQuota: async () => ({ ok: false, error: SECRET + ' boom' }) })
  assert.equal(JSON.stringify(failed).includes(SECRET), false)
  assert.equal(failed.reason, 'quota_unavailable')

  // normalizeQuotaReading 只保留白名单字段
  const normalized = normalizeQuotaReading({ source: 'trusted', ok: true, usedPercent: '42.34', token: SECRET, resetsAt: '2026-11-12T00:00:00Z', plan: 'pro' })
  assert.deepEqual(Object.keys(normalized).sort(), ['error', 'ok', 'plan', 'resetsAt', 'source', 'usedPercent'])
  assert.equal(normalized.usedPercent, 42.3)
  assert.equal(JSON.stringify(normalized).includes(SECRET), false)
  assert.deepEqual(DEFAULT_CODEX_QUOTA, { warnPercent: 80, criticalPercent: 95, source: 'none' })
})
