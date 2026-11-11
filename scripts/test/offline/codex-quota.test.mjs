// E8 / M4-3a 官方额度三态与手动应急态回归（纯函数，无网络/无文件/无真实额度 API）。
// 覆盖：fresh/stale/unknown 真区分（含窗口边界）、UNKNOWN 绝不渲染 0%/100%、
//      normal/80/95/耗尽阈值、确认三元组 + subject 审计、恢复、持久化形状、
//      "额度不足且未显式应急 ⇒ 不改变身份路由"硬约束、输出脱敏。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateQuota, normalizeQuotaConfig, normalizeQuotaReading,
  resolveQuotaSnapshot, readFreshTrustedSourceOrReturnUNKNOWN,
  createQuotaState, enterEmergency, exitEmergency,
  serializeQuotaState, parseQuotaState, describeEmergencyImpacts,
  QUOTA_DISPLAY_UNKNOWN, QUOTA_FRESHNESS, QUOTA_STATE_VERSION, DEFAULT_CODEX_QUOTA, DEFAULT_QUOTA_MAX_AGE_MS,
} from '../../../src/codex/quota.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const MAX_AGE = 60_000
const cfgTrusted = { defaults: { codexQuota: { source: 'trusted', maxAgeMs: MAX_AGE } } }
const cfgNone = { defaults: { codexQuota: {} } }
// 默认读数带"当下观测时间"，即 fresh；要造 stale 用 observedAt 往前推。
const q = (usedPercent, extra) => ({ source: 'trusted', ok: true, usedPercent, observedAt: NOW, ...(extra || {}) })

test('E8 unknown：无来源/来源失败/非法值一律 UNKNOWN，绝不虚构百分比', { timeout: 30000 }, async () => {
  const noCfg = await evaluateQuota({})
  assert.equal(noCfg.state, 'unknown')
  assert.equal(noCfg.freshness, QUOTA_FRESHNESS.UNKNOWN)
  assert.equal(noCfg.display, QUOTA_DISPLAY_UNKNOWN)
  assert.equal(noCfg.usedPercent, null)
  assert.equal(noCfg.reason, 'no_source_configured')

  // 配置显式 source:'none' 时，即使注入了读数也不采用（严格）
  const disabled = await evaluateQuota({ cfg: cfgNone, quota: q(42) })
  assert.equal(disabled.state, 'unknown')
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
    assert.equal(r.reason === '' ? true : !/^(0|100)%/.test(r.display), true, 'UNKNOWN 不得渲染成 0%/100%')
    assert.ok(r.impacts.some((i) => i.code === 'quota_unknown'))
    assert.equal(r.automation.autoSwitch, false)
    assert.ok(r.actions.some((a) => a.code === 'verify_quota_manually'))
  }
})

test('M4-3a 三态：fresh / stale / unknown 真区分，窗口边界（正好等于 maxAgeMs）算 fresh', { timeout: 30000 }, async () => {
  const fresh = await evaluateQuota({ cfg: cfgTrusted, quota: q(42, { observedAt: NOW - MAX_AGE }), now: NOW })
  assert.equal(fresh.freshness, QUOTA_FRESHNESS.FRESH)
  assert.equal(fresh.trusted, true)
  assert.equal(fresh.state, 'normal')
  assert.equal(fresh.display, '42%')
  assert.equal(fresh.ageMs, MAX_AGE)

  const stale = await evaluateQuota({ cfg: cfgTrusted, quota: q(42, { observedAt: NOW - MAX_AGE - 1 }), now: NOW })
  assert.equal(stale.freshness, QUOTA_FRESHNESS.STALE)
  assert.equal(stale.trusted, false)
  assert.equal(stale.state, 'unknown', 'stale 不得被当成当下状态')
  assert.equal(stale.observedState, 'normal')
  assert.equal(stale.display, '42% (stale)')
  assert.equal(stale.usedPercent, 42, '过期读数保留原值，但不 trusted')
  assert.ok(stale.impacts.some((i) => i.code === 'quota_stale'))
  assert.ok(stale.actions.some((a) => a.code === 'refresh_quota_source'))
  assert.equal(stale.exhausted, false)

  // 有读数但没有可信观测时间 ⇒ unknown（不能证明新鲜就不算新鲜），显示 UNKNOWN。
  const unproven = await evaluateQuota({ cfg: cfgTrusted, quota: { source: 'trusted', ok: true, usedPercent: 42 }, now: NOW })
  assert.equal(unproven.freshness, QUOTA_FRESHNESS.UNKNOWN)
  assert.equal(unproven.state, 'unknown')
  assert.equal(unproven.reason, 'freshness_unproven')
  assert.equal(unproven.display, QUOTA_DISPLAY_UNKNOWN)
  assert.equal(unproven.usedPercent, 42)
  assert.ok(unproven.impacts.some((i) => i.code === 'quota_freshness_unproven'))

  // 实时来源（readQuota 函数）没有时间戳 = 此刻观测 ⇒ fresh。
  const live = await evaluateQuota({ cfg: cfgTrusted, readQuota: async () => ({ ok: true, usedPercent: 42 }), now: NOW })
  assert.equal(live.freshness, QUOTA_FRESHNESS.FRESH)
  assert.equal(live.observedAt, NOW)
  assert.equal(live.state, 'normal')

  // 快照解析入口与配置窗口夹取
  const snap = await resolveQuotaSnapshot({ cfg: cfgTrusted, quota: q(42), now: NOW })
  assert.equal(snap.freshness, 'fresh')
  assert.equal(snap.maxAgeMs, MAX_AGE)
  assert.equal(normalizeQuotaConfig({ defaults: { codexQuota: { source: 'trusted', maxAgeMs: 0 } } }).maxAgeMs, DEFAULT_QUOTA_MAX_AGE_MS)
  assert.equal(normalizeQuotaConfig({ defaults: { codexQuota: { source: 'trusted', maxAgeMs: 10 } } }).maxAgeMs, 1000)
  assert.equal(normalizeQuotaConfig({ defaults: { codexQuota: { source: 'trusted', maxAgeMs: 10 * 24 * 3600 * 1000 } } }).maxAgeMs, 24 * 3600 * 1000)
})

test('M4-3a 契约入口：只有 fresh 才返回 ok:true；stale/unknown 返回稳定原因', { timeout: 30000 }, async () => {
  const fresh = await readFreshTrustedSourceOrReturnUNKNOWN({ cfg: cfgTrusted, quota: q(42), now: NOW })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.freshness, 'fresh')
  assert.equal(fresh.usedPercent, 42)
  assert.equal(fresh.ageMs, 0)

  const stale = await readFreshTrustedSourceOrReturnUNKNOWN({ cfg: cfgTrusted, quota: q(42, { observedAt: NOW - MAX_AGE - 1 }), now: NOW })
  assert.equal(stale.ok, false)
  assert.equal(stale.freshness, 'stale')
  assert.equal(stale.reason, 'stale')
  assert.equal(stale.usedPercent, null, 'stale 不得把旧百分比当成当前值返回')
  assert.equal(stale.display, QUOTA_DISPLAY_UNKNOWN)

  const unknown = await readFreshTrustedSourceOrReturnUNKNOWN({ cfg: cfgNone, quota: q(42), now: NOW })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.freshness, 'unknown')
  assert.equal(unknown.reason, 'no_trusted_source')
})

test('E8 阈值：normal / 80 warn / 95 critical / 100 耗尽（只认 fresh 读数）', { timeout: 30000 }, async () => {
  const cases = [
    [0, 'normal', false], [42, 'normal', false], [79.9, 'normal', false],
    [80, 'warn', false], [80.1, 'warn', false], [94.9, 'warn', false],
    [95, 'critical', false], [99.9, 'critical', false], [100, 'critical', true],
  ]
  for (const [pct, state, exhausted] of cases) {
    const r = await evaluateQuota({ cfg: cfgTrusted, quota: q(pct), officialModels: ['gpt-6.1-sol'], now: NOW })
    assert.equal(r.state, state, pct + '% 应判为 ' + state)
    assert.equal(r.freshness, 'fresh')
    assert.equal(r.exhausted, exhausted, pct + '% exhausted')
    assert.deepEqual(r.thresholds, { warnPercent: 80, criticalPercent: 95 })
    assert.equal(r.display, pct + '%')
    assert.equal(r.usedPercent, pct)
    assert.equal(r.resetsAt, null, '没有 resetsAt 就写 null，不臆造重置时间')
  }
  const warn = await evaluateQuota({ cfg: cfgTrusted, quota: q(80), officialModels: ['gpt-6.1-sol'], now: NOW })
  assert.ok(warn.impacts.some((i) => i.code === 'official_quota_warn'))
  assert.deepEqual(warn.impacts.find((i) => i.code === 'official_quota_warn').models, ['gpt-6.1-sol'])
  const crit = await evaluateQuota({ cfg: cfgTrusted, quota: q(96), now: NOW })
  assert.ok(crit.impacts.some((i) => i.code === 'official_quota_critical'))
  assert.equal(crit.impacts.some((i) => i.code === 'official_quota_exhausted'), false)
  const out = await evaluateQuota({ cfg: cfgTrusted, quota: q(100), now: NOW })
  assert.ok(out.impacts.some((i) => i.code === 'official_quota_exhausted'))
  assert.ok(out.impacts.some((i) => i.code === 'client_send_may_be_locked'))

  const custom = { defaults: { codexQuota: { source: 'trusted', warnPercent: 70, criticalPercent: 90, maxAgeMs: MAX_AGE } } }
  assert.equal((await evaluateQuota({ cfg: custom, quota: q(70), now: NOW })).state, 'warn')
  assert.equal((await evaluateQuota({ cfg: custom, quota: q(89.9), now: NOW })).state, 'warn')
  assert.equal((await evaluateQuota({ cfg: custom, quota: q(90), now: NOW })).state, 'critical')
  const inverted = normalizeQuotaConfig({ defaults: { codexQuota: { warnPercent: 90, criticalPercent: 70 } } })
  assert.equal(inverted.warnPercent, 90)
  assert.equal(inverted.criticalPercent, 90)
  assert.equal(inverted.source, 'none')
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

test('M4-3a 硬约束：额度不足且未显式应急 ⇒ 不改变身份路由', { timeout: 30000 }, async () => {
  for (const pct of [95, 100]) {
    const r = await evaluateQuota({ cfg: cfgTrusted, quota: q(pct), now: NOW })
    assert.equal(r.routing.autoSwitch, false, '任何情况下都不自动切换')
    assert.equal(r.routing.switchAllowed, false, pct + '% 未确认应急时不允许切身份')
    assert.equal(r.routing.requiresExplicitEmergency, true)
    assert.equal(r.routing.quotaInsufficient, true)
    assert.equal(r.routing.status, 'quota_insufficient_requires_explicit_emergency')
    assert.equal(r.automation.changeSessionProvider, false)
    assert.equal(r.actions.some((a) => /switch|failover/i.test(a.code) && a.requiresConfirmation !== true), false)
  }
  // 额度未知时同样不允许自动切换
  const unknown = await evaluateQuota({ cfg: cfgNone, quota: q(100), now: NOW })
  assert.equal(unknown.routing.switchAllowed, false)
  assert.equal(unknown.routing.quotaInsufficient, false)

  // 只有显式应急态才把"允许人工切换"打开（但依然 autoSwitch=false）
  const entered = enterEmergency(createQuotaState({ now: NOW }), { acknowledged: true, reason: 'quota exhausted', backupPoint: '/backups/a' }, { now: NOW + 1 })
  const withEmergency = await evaluateQuota({ cfg: cfgTrusted, quota: q(100), emergencyState: entered.state, now: NOW })
  assert.equal(withEmergency.routing.switchAllowed, true)
  assert.equal(withEmergency.routing.autoSwitch, false)
  assert.equal(withEmergency.routing.status, 'emergency_manual_switch_only')
})

test('E8 应急态：确认三元组缺一不可、可恢复、影响声明完整、subject 进审计', { timeout: 30000 }, async () => {
  const st = createQuotaState({ now: NOW })
  assert.equal(st.version, QUOTA_STATE_VERSION)
  assert.equal(st.mode, 'normal')
  assert.deepEqual(st.timeline, [])
  const snapshot = JSON.parse(JSON.stringify(st))

  const noAck = enterEmergency(st, { reason: 'quota exhausted', backupPoint: '/backups/a' })
  assert.equal(noAck.ok, false)
  assert.equal(noAck.code, 'acknowledgement_required')
  const noReason = enterEmergency(st, { acknowledged: true, backupPoint: '/backups/a' })
  assert.equal(noReason.code, 'reason_required')
  const noBackup = enterEmergency(st, { acknowledged: true, reason: 'quota exhausted' })
  assert.equal(noBackup.code, 'backup_point_required')

  const entered = enterEmergency(st, {
    acknowledged: true, reason: 'quota exhausted', backupPoint: '/backups/a', subject: 'official-openai',
  }, { now: NOW + 1000 })
  assert.equal(entered.ok, true)
  assert.equal(entered.code, 'emergency_entered')
  assert.equal(entered.state.mode, 'emergency')
  assert.equal(entered.state.emergency.subject, 'official-openai')
  assert.equal(entered.state.emergency.since, NOW + 1000)
  assert.deepEqual(entered.state.timeline[0].action, 'enter_emergency')
  assert.equal(entered.state.timeline[0].subject, 'official-openai')
  const impactCodes = entered.impacts.map((i) => i.code)
  for (const code of ['provider_grouping_may_change', 'session_visibility_may_change', 'separate_instance_or_restart_required', 'not_seamless']) {
    assert.ok(impactCodes.includes(code), '应急态必须声明影响: ' + code)
  }
  assert.deepEqual(st, snapshot, '进入应急不得修改传入的旧状态对象')

  const again = enterEmergency(entered.state, { acknowledged: true, reason: 'again', backupPoint: '/backups/b' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'already_emergency')
  assert.equal(again.state.timeline.length, 1, '重复进入不得重复记时间线')

  const ev = await evaluateQuota({ cfg: cfgNone, emergencyState: entered.state, now: NOW + 1500 })
  assert.equal(ev.state, 'unknown')
  assert.equal(ev.mode, 'emergency')
  assert.equal(ev.emergency.active, true)
  assert.equal(ev.emergency.subject, 'official-openai')
  assert.ok(ev.impacts.some((i) => i.code === 'emergency_mode_active'))
  assert.ok(ev.actions.some((a) => a.code === 'recover_emergency_when_ready' && a.requiresConfirmation === true))

  const recovered = exitEmergency(entered.state, { now: NOW + 2000, reason: 'official quota recovered', subject: 'official-openai' })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.state.mode, 'normal')
  assert.equal(recovered.state.emergency, null)
  assert.equal(recovered.state.lastEmergency.subject, 'official-openai')
  assert.deepEqual(recovered.state.timeline.map((t) => t.action), ['enter_emergency', 'recover'])
  assert.equal(exitEmergency(recovered.state).code, 'not_in_emergency')

  // 审计字段脱敏：reason/subject 里的密钥形态不得落进状态
  const SECRET = 'sk-live-AUDIT-1234567890'
  const dirty = enterEmergency(createQuotaState({ now: NOW }), {
    acknowledged: true, reason: 'leaked ' + SECRET + ' in log', backupPoint: '/b', subject: SECRET,
  }, { now: NOW })
  assert.equal(dirty.state.emergency.reason, '[redacted]')
  assert.equal(dirty.state.emergency.subject, '')
  assert.equal(JSON.stringify(serializeQuotaState(dirty.state)).includes('sk-live'), false)

  assert.ok(describeEmergencyImpacts().length >= 4)
})

test('E8 状态持久化：形状稳定、可往返、非法输入回退 normal', { timeout: 30000 }, async () => {
  const entered = enterEmergency(createQuotaState({ now: NOW }), { acknowledged: true, reason: 'r', backupPoint: '/b', subject: 'official' }, { now: NOW + 10 })
  const persisted = serializeQuotaState(entered.state)
  assert.equal(persisted.version, QUOTA_STATE_VERSION)
  assert.equal(persisted.mode, 'emergency')
  assert.deepEqual(Object.keys(persisted).sort(), ['emergency', 'lastEmergency', 'mode', 'timeline', 'updatedAt', 'version'])
  for (const t of persisted.timeline) {
    for (const k of Object.keys(t)) assert.ok(['at', 'action', 'mode', 'reason', 'backupPoint', 'subject'].includes(k), '时间线字段受控: ' + k)
  }
  const round = parseQuotaState(JSON.stringify(persisted))
  assert.equal(round.mode, 'emergency')
  assert.equal(round.emergency.reason, 'r')
  assert.equal(round.emergency.subject, 'official')
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

  const normalized = normalizeQuotaReading({ source: 'trusted', ok: true, usedPercent: '42.34', token: SECRET, resetsAt: '2026-11-12T00:00:00Z', plan: 'pro', observedAt: NOW })
  assert.deepEqual(Object.keys(normalized).sort(), ['error', 'observedAt', 'ok', 'plan', 'resetsAt', 'source', 'usedPercent'])
  assert.equal(normalized.usedPercent, 42.3)
  assert.equal(normalized.observedAt, NOW)
  assert.equal(JSON.stringify(normalized).includes(SECRET), false)
  assert.deepEqual(DEFAULT_CODEX_QUOTA, { warnPercent: 80, criticalPercent: 95, source: 'none' })
})
