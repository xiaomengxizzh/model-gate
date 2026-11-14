// N05：额度三态 + 显式应急（试算/确认/仅配置新 profile/对称恢复/审计）离线契约测试。
// 全程合成数据、临时目录；不读真实 auth.json/历史，不触达官方接口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './harness.mjs'
import {
  USAGE_KINDS, activateEmergency, classifyUsageFact, emergencyPlan, emergencyPlanId,
  evaluateQuota, importCounts, parseQuotaState, readFreshTrustedSourceOrReturnUNKNOWN,
  restoreEmergency, serializeQuotaState, createQuotaState,
} from '../../../src/codex/quota.js'
import { usageEvidence } from '../../../src/native-usage.js'
import { handleCodexApi } from '../../../src/codex/api.js'

const CLI = join(root, 'bin', 'mg.mjs')
const NOW = 1_700_000_000_000
const sha = (text) => createHash('sha256').update(text).digest('hex')
function cli(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { MG_CONFIG: '', MG_CONFIG_DIR: '', MG_ADMIN_TOKEN: '', MG_CLI_ALLOW_REMOTE: '', ...env }) })
  let json = null; try { json = JSON.parse(res.stdout) } catch { json = null }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json }
}

test('N05 用量来源三分：本地统计/导入仅计数，账户额度才参与额度判断', () => {
  const local = classifyUsageFact({ kind: USAGE_KINDS.LOCAL_STATS, totalTokens: 1234, source: 'gateway_stats' });
  assert.equal(local.affectsQuota, false);
  assert.equal(local.tokens, 1234);
  const imported = importCounts({ totalTokens: 99, kind: USAGE_KINDS.ACCOUNT_QUOTA });
  assert.equal(imported.kind, USAGE_KINDS.IMPORTED_COUNTS, '导入必须强制按仅计数处理');
  assert.equal(imported.affectsQuota, false);
  const account = classifyUsageFact({ kind: USAGE_KINDS.ACCOUNT_QUOTA, totalTokens: 500, source: 'official' });
  assert.equal(account.affectsQuota, true);
  const native = usageEvidence({ totalTokens: 42 });
  assert.equal(native.affectsQuota, false);
  assert.equal(native.kind, 'local_stats');
  // 负值/非法计数不猜成 0
  assert.equal(classifyUsageFact({ totalTokens: -1 }).tokens, null);
});

test('N05 额度三态：fresh/stale/unknown 与缺身份→UNKNOWN（不猜余额）', async () => {
  const fresh = await evaluateQuota({ now: NOW, quota: { ok: true, source: 'trusted', usedPercent: 82, observedAt: NOW - 1000 }, cfg: { defaults: { codexQuota: { source: 'trusted', maxAgeMs: 60000 } } } });
  assert.equal(fresh.state, 'warn');
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(fresh.display, '82%');
  const stale = await evaluateQuota({ now: NOW, quota: { ok: true, source: 'trusted', usedPercent: 99, observedAt: NOW - 10 * 60000 }, cfg: { defaults: { codexQuota: { source: 'trusted', maxAgeMs: 60000 } } } });
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.state, 'unknown', '过期读数不得当当下余额');
  const missing = await readFreshTrustedSourceOrReturnUNKNOWN({ now: NOW, cfg: {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.display, 'UNKNOWN');
  assert.equal(missing.usedPercent, null);
  // 没有账户身份/来源：任何自动切换都不允许
  assert.equal(missing.freshness, 'unknown');
});

test('N05 应急试算：必须有新 profile + 第三方范围；声明零身份/历史变更', () => {
  const noProfile = emergencyPlan({ state: createQuotaState({ now: NOW }), thirdPartyProfiles: ['p'] });
  assert.equal(noProfile.ok, false);
  assert.equal(noProfile.code, 'profile_required');
  const noScope = emergencyPlan({ state: createQuotaState({ now: NOW }), profile: 'mg-emergency' });
  assert.equal(noScope.code, 'profile_scope_required');
  const ok = emergencyPlan({ state: createQuotaState({ now: NOW }), profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], officialModels: ['gpt-6.1-sol'] });
  assert.equal(ok.ok, true);
  assert.match(ok.plan.planId, /^ep_[0-9a-f]{24}$/);
  assert.equal(ok.plan.identityMutation, false);
  assert.equal(ok.plan.historyMutation, false);
  assert.equal(ok.plan.officialLogout, false);
  assert.deepEqual(ok.plan.writes, ['emergency-profile:mg-emergency']);
  assert.ok(ok.plan.impacts.length >= 5);
  assert.equal(ok.plan.requiresConfirmation, true);
  assert.equal(ok.plan.planId, emergencyPlanId(ok.plan));
});

test('N05 激活/恢复：planId 绑定、三元组、profile 审计、对称恢复', () => {
  const base = createQuotaState({ now: NOW });
  const planRes = emergencyPlan({ state: base, profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW });
  const plan = planRes.plan;
  const wrongPlan = activateEmergency(base, { planId: 'ep_' + '0'.repeat(24), acknowledged: true, reason: 'r', backupPoint: 'b' }, { profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW });
  assert.equal(wrongPlan.ok, false);
  assert.equal(wrongPlan.code, 'plan_id_mismatch');
  assert.equal(wrongPlan.state.mode, 'normal', '拒绝时状态不变');
  const noAck = activateEmergency(base, { planId: plan.planId, reason: 'r', backupPoint: 'b' }, { profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW });
  assert.equal(noAck.code, 'acknowledgement_required');
  const noBackup = activateEmergency(base, { planId: plan.planId, acknowledged: true, reason: 'r' }, { profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW });
  assert.equal(noBackup.code, 'backup_point_required');
  const entered = activateEmergency(base, { planId: plan.planId, acknowledged: true, reason: 'quota exhausted', backupPoint: 'bak-1' }, { profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW });
  assert.equal(entered.ok, true);
  const serialized = serializeQuotaState(entered.state);
  assert.equal(serialized.mode, 'emergency');
  assert.equal(serialized.emergency.profile, 'mg-emergency');
  assert.equal(serialized.emergency.acknowledged, true);
  assert.equal(serialized.timeline.length, 1);
  // 已应急不得重复进入/重复激活
  const again = emergencyPlan({ state: entered.state, profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW });
  assert.equal(again.code, 'already_emergency');
  const restored = restoreEmergency(entered.state, { reason: 'quota reset', now: NOW + 1 });
  assert.equal(restored.ok, true);
  const r = serializeQuotaState(restored.state);
  assert.equal(r.mode, 'normal');
  assert.equal(r.emergency, null);
  assert.equal(r.lastEmergency.profile, 'mg-emergency');
  assert.equal(r.lastEmergency.recoverReason, 'quota reset');
  assert.equal(r.timeline.length, 2, '进入与恢复都留审计');
  assert.equal(r.timeline[1].action, 'recover');
  // 往返可持久化
  assert.equal(parseQuotaState(JSON.stringify(r)).mode, 'normal');
});

test('N05 原身份/历史不变：应急状态机不碰任何 auth/历史文件（合成分隔证明）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-n05-id-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, 'auth.json');
  const histPath = join(dir, 'session.jsonl');
  await writeFile(authPath, '{"synthetic":"auth-fixture"}\n');
  await writeFile(histPath, '{"type":"session_meta"}\n');
  const beforeAuth = sha(await readFile(authPath, 'utf8'));
  const beforeHist = sha(await readFile(histPath, 'utf8'));
  const state = createQuotaState({ now: NOW });
  const plan = emergencyPlan({ state, profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW }).plan;
  const entered = activateEmergency(state, { planId: plan.planId, acknowledged: true, reason: 'drill', backupPoint: 'bak' }, { profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], now: NOW });
  const restored = restoreEmergency(entered.state, { reason: 'done', now: NOW + 1 });
  assert.equal(restored.ok, true);
  assert.equal(sha(await readFile(authPath, 'utf8')), beforeAuth, 'auth.json 必须逐字节不变');
  assert.equal(sha(await readFile(histPath, 'utf8')), beforeHist, '历史文件必须逐字节不变');
});

test('N05 管理面：quota 未接线→UNKNOWN；emergency 无 store→只读试算/写路径 503；有 store 时 planId 绑定', async () => {
  const quota = await handleCodexApi({ method: 'GET', path: '/api/codex/quota', explicitAdmin: true, isLocal: true });
  assert.equal(quota.status, 200);
  assert.equal(quota.body.available, false);
  assert.equal(quota.body.state, 'unknown');
  assert.equal(quota.body.display, 'UNKNOWN');
  const wired = await handleCodexApi({ method: 'GET', path: '/api/codex/quota', explicitAdmin: true, isLocal: true, quotaEvaluator: async () => ({ state: 'unknown', display: 'UNKNOWN', freshness: 'unknown', usedPercent: null }) });
  assert.equal(wired.body.available, true);
  assert.equal(wired.body.accountQuota, null, '非 fresh 不得暴露账户额度数值');

  const noStorePlan = await handleCodexApi({ method: 'GET', path: '/api/codex/emergency?profile=mg-emergency&thirdPartyProfiles=opencodego', explicitAdmin: true, isLocal: true });
  assert.equal(noStorePlan.body.available, false);
  assert.equal(noStorePlan.body.reason, 'emergency_store_not_wired');
  const noStoreWrite = await handleCodexApi({ method: 'POST', path: '/api/codex/emergency', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, body: { action: 'activate' } });
  assert.equal(noStoreWrite.status, 503);

  let persisted = null;
  const store = { read: () => persisted, write: (s) => { persisted = JSON.parse(JSON.stringify(s)) } };
  const planOut = await handleCodexApi({ method: 'GET', path: '/api/codex/emergency?profile=mg-emergency&thirdPartyProfiles=opencodego', explicitAdmin: true, isLocal: true, emergencyStore: store, now: NOW });
  assert.equal(planOut.body.available, true);
  assert.match(planOut.body.plan.planId, /^ep_/);
  const mismatch = await handleCodexApi({ method: 'POST', path: '/api/codex/emergency', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, emergencyStore: store, now: NOW, body: { action: 'activate', planId: 'ep_' + '0'.repeat(24), profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], acknowledged: true, reason: 'r', backupPoint: 'b' } });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'plan_id_mismatch');
  const activated = await handleCodexApi({ method: 'POST', path: '/api/codex/emergency', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, emergencyStore: store, now: NOW, body: { action: 'activate', planId: planOut.body.plan.planId, profile: 'mg-emergency', thirdPartyProfiles: ['opencodego'], acknowledged: true, reason: 'quota drill', backupPoint: 'bak-9' } });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.identityMutation, false);
  assert.equal(activated.body.historyMutation, false);
  assert.equal(activated.body.officialLogout, false);
  assert.equal(persisted.mode, 'emergency');
  assert.equal(persisted.emergency.profile, 'mg-emergency');
  const restored = await handleCodexApi({ method: 'POST', path: '/api/codex/emergency', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, emergencyStore: store, now: NOW + 1, body: { action: 'restore', reason: 'done' } });
  assert.equal(restored.status, 200);
  assert.equal(persisted.mode, 'normal');
});

test('N05 CLI：quota 未接线→UNKNOWN；应急 plan/activate/restore 只写隔离 state-file，拒绝 auth/历史路径', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-n05-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'emergency.json');
  const q = cli(['quota', 'status', '--json']);
  assert.equal(q.status, 0, q.stderr);
  assert.equal(q.json.display, 'UNKNOWN');
  assert.equal(q.json.available, false);

  const plan = cli(['emergency', 'plan', '--profile', 'mg-emergency', '--third-party', 'opencodego', '--state-file', statePath, '--json']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.json.plan.planId, /^ep_/);
  assert.equal(plan.json.readOnly, true);
  assert.equal(plan.json.plan.identityMutation, false);

  const blocked = cli(['emergency', 'activate', '--state-file', '/tmp/auth.json', '--plan', plan.json.plan.planId, '--profile', 'mg-emergency', '--third-party', 'opencodego', '--acknowledge', '--reason', 'r', '--backup-point', 'b', '--yes', '--json']);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.json.code, 'forbidden_state_path');

  const noYes = cli(['emergency', 'activate', '--state-file', statePath, '--plan', plan.json.plan.planId, '--profile', 'mg-emergency', '--third-party', 'opencodego', '--acknowledge', '--reason', 'quota drill', '--backup-point', 'bak-1', '--json']);
  assert.equal(noYes.status, 1);
  assert.equal(noYes.json.code, 'confirmation_required');

  const activated = cli(['emergency', 'activate', '--state-file', statePath, '--plan', plan.json.plan.planId, '--profile', 'mg-emergency', '--third-party', 'opencodego', '--acknowledge', '--reason', 'quota drill', '--backup-point', 'bak-1', '--yes', '--json']);
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(activated.json.mode, 'emergency');
  assert.equal(activated.json.profile, 'mg-emergency');
  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(persisted.mode, 'emergency');
  assert.equal(persisted.timeline.length, 1);

  const restored = cli(['emergency', 'restore', '--state-file', statePath, '--reason', 'done', '--yes', '--json']);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.json.mode, 'normal');
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.timeline.length, 2);
  assert.equal(after.emergency, null);
});
