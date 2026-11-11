#!/usr/bin/env node
// E8 额度与应急流程演练（离线、纯内存合成）：UNKNOWN → 阈值 → 确认三元组 → 应急 → 恢复 → 持久化。
// 不读取任何真实额度/凭据；所有输入都是合成的。
import {
  evaluateQuota, createQuotaState, enterEmergency, exitEmergency,
  serializeQuotaState, parseQuotaState, DEFAULT_CODEX_QUOTA,
} from '../../src/codex/quota.js'

const checks = []
const check = (n, ok, d) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' :: ' + d : '')) }
const NL = String.fromCharCode(10)
const cfg = (source) => ({ defaults: { codexQuota: Object.assign({}, DEFAULT_CODEX_QUOTA, { source }) } })
const evalWith = (used, source = 'trusted', extra = {}) => evaluateQuota(Object.assign({ cfg: cfg(source), readQuota: async () => ({ ok: true, usedPercent: used, resetsAt: '2026-11-12T00:00:00Z', plan: 'pro' }), now: 1 }, extra))

const unknown = await evaluateQuota({ cfg: cfg('none'), readQuota: async () => ({ ok: true, usedPercent: 91 }), now: 1 })
check('source=none 即使有读数也严格 UNKNOWN', unknown.state === 'unknown' && unknown.display === 'UNKNOWN' && unknown.usedPercent === null, unknown.display)
check('UNKNOWN 时给出人工核对建议且不自动行动', unknown.actions.some((a) => a.code === 'verify_quota_manually') && unknown.automation.autoSwitch === false)

const n79 = await evalWith(79)
const n80 = await evalWith(80)
const n95 = await evalWith(95)
const n100 = await evalWith(100)
check('阈值：79 normal / 80 warn / 95 critical / 100 exhausted', n79.state === 'normal' && n80.state === 'warn' && n95.state === 'critical' && n100.exhausted === true, [n79.state, n80.state, n95.state, n100.exhausted].join('/'))
check('critical 给出需确认的应急建议（不自动执行）', n95.actions.some((a) => a.code === 'prepare_manual_emergency' && a.requiresConfirmation === true))

let s = createQuotaState({ now: 1 })
const noAck = enterEmergency(s, { reason: 'quota', backupPoint: '/tmp/bak' }, { now: 2 })
const noReason = enterEmergency(s, { acknowledged: true, backupPoint: '/tmp/bak' }, { now: 2 })
const noBackup = enterEmergency(s, { acknowledged: true, reason: 'quota' }, { now: 2 })
check('缺确认/原因/备份点分别拒绝且状态不变', noAck.code === 'acknowledgement_required' && noReason.code === 'reason_required' && noBackup.code === 'backup_point_required' && noAck.state.mode === 'normal' && noBackup.state.timeline.length === 0)

const entered = enterEmergency(s, { acknowledged: true, reason: 'quota exhausted, switch to third party manually', backupPoint: '/tmp/codex-config.bak-20261111' }, { now: 3 })
check('带齐三元组才进入应急态', entered.ok === true && entered.state.mode === 'emergency' && entered.state.timeline.length === 1)
const allowedProhibited = Array.isArray(entered.prohibited) ? entered.prohibited : []
const hasProhibited = (c) => allowedProhibited.some((x) => (typeof x === 'string' ? x : (x && x.code)) === c)
check('应急影响声明 ≥5 条且禁止项齐全', entered.impacts.length >= 5 && hasProhibited('auto_switch_provider') && hasProhibited('auto_purchase_api_quota') && hasProhibited('logout_official_account'))

const evalEmergency = await evalWith(99, 'trusted', { emergencyState: entered.state })
check('应急态评估带 emergency_mode_active 且 mode=emergency', evalEmergency.mode === 'emergency' && evalEmergency.impacts.some((i) => i.code === 'emergency_mode_active'))
check('应急态下 automation 全 false（不自动切换/购买/退出）', Object.values(evalEmergency.automation).every((v) => v === false))

const exited = exitEmergency(entered.state, { reason: 'quota reset', now: 4 })
check('恢复后回到 normal 并保留 lastEmergency 审计', exited.ok === true && exited.state.mode === 'normal' && exited.state.lastEmergency && exited.state.lastEmergency.recoveredAt === 4)

const ser = serializeQuotaState(exited.state)
const round = parseQuotaState(ser)
check('状态可序列化/还原且字段一致', JSON.stringify(serializeQuotaState(round)) === JSON.stringify(ser))
const bogus = parseQuotaState('{"version":1,"mode":"weird"}')
check('非法状态解析回退 normal', bogus.mode === 'normal')

const leak = await evaluateQuota({ cfg: cfg('trusted'), readQuota: async () => ({ ok: true, usedPercent: 88, token: 'sk-MUST-NOT-LEAK', apiKey: 'sk-MUST-NOT-LEAK', nested: { accessToken: 'x' } }), now: 1 })
const json = JSON.stringify(leak)
check('评估输出不含注入的凭据字段', !json.includes('sk-MUST-NOT-LEAK') && !json.includes('accessToken'), 'len=' + json.length)

const failed = checks.filter((x) => !x).length
console.log(NL + (checks.length - failed) + '/' + checks.length + ' quota-emergency drill checks passed')
process.exitCode = failed ? 1 : 0
