// N04：历史诊断（有界只读）与经确认的最小明文摘要导出（原件不变）离线契约测试。
// 使用合成 JSONL 与临时目录；不读任何真实 Codex 历史/凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './harness.mjs'
import {
  clearHistoryRoots, diagnoseHistory, exportApprovedSummary, planSummaryExport,
  registerHistoryRoot, summaryPlanId,
} from '../../../src/codex/history.js'
import { handleCodexApi } from '../../../src/codex/api.js'

const CLI = join(root, 'bin', 'mg.mjs')
const NL = String.fromCharCode(10)
const sha = (text) => createHash('sha256').update(text).digest('hex')
function cli(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { MG_CONFIG: '', MG_CONFIG_DIR: '', MG_ADMIN_TOKEN: '', MG_CLI_ALLOW_REMOTE: '', ...env }) })
  let json = null; try { json = JSON.parse(res.stdout) } catch { json = null }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json }
}

async function fixture(t) {
  clearHistoryRoots();
  const dir = await mkdtemp(join(tmpdir(), 'mg-n04-hist-'));
  const outDir = await mkdtemp(join(tmpdir(), 'mg-n04-out-'));
  t.after(async () => { clearHistoryRoots(); await rm(dir, { recursive: true, force: true }); await rm(outDir, { recursive: true, force: true }) });
  const s1 = [
    { type: 'session_meta', payload: { id: 's1', model_provider: 'openai' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello NONCE-USER' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'read', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'TOOL-SECRET-OUTPUT' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer NONCE-ASSISTANT' }] } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'ENC-NONCE' } },
  ].map((x) => JSON.stringify(x)).join(NL) + NL;
  const s2 = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CIPHER-PLAIN' }, { type: 'encrypted_content', encrypted_content: 'CIPHER-NONCE' }] } }) + NL;
  await writeFile(join(dir, 'session-1.jsonl'), s1);
  await writeFile(join(dir, 'session-2.jsonl'), s2);
  const reg = registerHistoryRoot({ id: 'hist-test', dir });
  assert.equal(reg.ok !== false, true);
  return { dir, outDir, s1, s2 };
}

test('N04 诊断：有界只读、opaque 计数、原件 hash/mtime/目录不变', async (t) => {
  const f = await fixture(t);
  const before = { s1: sha(f.s1), s2: sha(f.s2) };
  const dirBefore = await readdir(f.dir);
  const diag = await diagnoseHistory({ rootId: 'hist-test', limits: { maxFiles: 10 } });
  assert.equal(diag.enabled, true);
  assert.equal(diag.scanned.files, 2);
  assert.ok(diag.scanned.sessions >= 1);
  assert.ok(Array.isArray(diag.notes));
  const text = JSON.stringify(diag);
  assert.equal(text.includes('NONCE-USER'), false, '诊断不得读取/回显消息正文');
  assert.equal(text.includes('CIPHER-NONCE'), false, '诊断不得回显密文');
  const after = { s1: sha(await readFile(join(f.dir, 'session-1.jsonl'), 'utf8')), s2: sha(await readFile(join(f.dir, 'session-2.jsonl'), 'utf8')) };
  assert.deepEqual(after, before, '诊断前后原件必须逐字节不变');
  assert.deepEqual(await readdir(f.dir), dirBefore, '目录清单不变（不产生备份/临时文件）');
});

test('N04 摘要导出试算：planId 绑定、只导出 user/assistant 明文、排除工具/密文', async (t) => {
  const f = await fixture(t);
  const diag = await diagnoseHistory({ rootId: 'hist-test' });
  const plan = planSummaryExport(diag, { selection: { relPaths: ['session-1.jsonl'] }, now: 1_700_000_000_000 });
  assert.match(plan.planId, /^hs_[0-9a-f]{24}$/);
  assert.equal(plan.planId, summaryPlanId(diag, { relPaths: ['session-1.jsonl'] }));
  assert.equal(plan.originalsMutated, false);
  assert.equal(plan.historyWriteSupported, false);
  assert.ok(plan.exclude.includes('encrypted_content'));
  assert.ok(plan.include.includes('user_plaintext'));

  const outFile = join(f.outDir, 'summary.json');
  const denied = await exportApprovedSummary({ rootId: 'hist-test', planId: plan.planId, selection: { relPaths: ['session-1.jsonl'] }, outFile });
  assert.equal(denied.code, 'acknowledgement_required');
  const noPurpose = await exportApprovedSummary({ rootId: 'hist-test', planId: plan.planId, selection: { relPaths: ['session-1.jsonl'] }, outFile, acknowledged: true });
  assert.equal(noPurpose.code, 'purpose_required');
  const wrongPlan = await exportApprovedSummary({ rootId: 'hist-test', planId: 'hs_' + '0'.repeat(24), selection: { relPaths: ['session-1.jsonl'] }, outFile, acknowledged: true, purpose: 'new session handoff' });
  assert.equal(wrongPlan.code, 'plan_id_mismatch');
  const insideRoot = await exportApprovedSummary({ rootId: 'hist-test', planId: plan.planId, selection: { relPaths: ['session-1.jsonl'] }, outFile: join(f.dir, 'x.json'), acknowledged: true, purpose: 'p' });
  assert.equal(insideRoot.code, 'forbidden_out_file');
  const authJson = await exportApprovedSummary({ rootId: 'hist-test', planId: plan.planId, selection: { relPaths: ['session-1.jsonl'] }, outFile: join(f.outDir, 'auth.json'), acknowledged: true, purpose: 'p' });
  assert.equal(authJson.code, 'forbidden_out_file');

  const before = { s1: sha(f.s1), s2: sha(f.s2) };
  const ok = await exportApprovedSummary({ rootId: 'hist-test', planId: plan.planId, selection: { relPaths: ['session-1.jsonl'] }, outFile, acknowledged: true, purpose: 'new session handoff' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.wrote, true);
  assert.equal(ok.originalsUnchanged, true);
  const exported = await readFile(outFile, 'utf8');
  assert.match(exported, /NONCE-USER/);
  assert.match(exported, /NONCE-ASSISTANT/);
  assert.equal(exported.includes('TOOL-SECRET-OUTPUT'), false, '工具输出绝不导出');
  assert.equal(exported.includes('ENC-NONCE'), false, '密文绝不导出');
  assert.equal(JSON.parse(exported).note.includes('原件未改动'), true);
  const after = { s1: sha(await readFile(join(f.dir, 'session-1.jsonl'), 'utf8')), s2: sha(await readFile(join(f.dir, 'session-2.jsonl'), 'utf8')) };
  assert.deepEqual(after, before, '导出前后原件逐字节不变');
  const rewrite = await exportApprovedSummary({ rootId: 'hist-test', planId: plan.planId, selection: { relPaths: ['session-1.jsonl'] }, outFile, acknowledged: true, purpose: 'p' });
  assert.equal(rewrite.code, 'out_file_exists', '默认拒绝覆盖');
});

test('N04 越界与未登记：未登记根/符号链接/缺配置一律拒绝（零读取）', async (t) => {
  clearHistoryRoots();
  const diag = await diagnoseHistory({ rootId: 'nope' });
  assert.equal(diag.enabled, false);
  assert.equal(diag.errorCode, 'history_root_not_registered');
  const sess = await diagnoseHistory({});
  assert.equal(sess.errorCode, 'history_root_required');
  const plan = planSummaryExport(diag, {});
  assert.ok(plan.errorCode);
});

test('N04 管理面：诊断/试算只读、导出需显式管理员 + planId，拒绝 409', async (t) => {
  const f = await fixture(t);
  const denied = await handleCodexApi({ method: 'GET', path: '/api/codex/history/diagnose?root=hist-test', isLocal: true });
  assert.equal(denied.status, 403);
  const diag = await handleCodexApi({ method: 'GET', path: '/api/codex/history/diagnose?root=hist-test', explicitAdmin: true, isLocal: true });
  assert.equal(diag.status, 200);
  assert.equal(diag.body.wrote, false);
  assert.equal(JSON.stringify(diag.body).includes('NONCE-USER'), false);
  const plan = await handleCodexApi({ method: 'GET', path: '/api/codex/history/export/plan?root=hist-test&relPaths=session-1.jsonl', explicitAdmin: true, isLocal: true });
  assert.equal(plan.status, 200);
  const planId = plan.body.plan.planId;
  assert.match(planId, /^hs_/);
  const outFile = join(f.outDir, 'via-api.json');
  const mismatch = await handleCodexApi({ method: 'POST', path: '/api/codex/history/export', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, body: { root: 'hist-test', planId: 'hs_' + '0'.repeat(24), relPaths: ['session-1.jsonl'], outFile, acknowledged: true, purpose: 'p' } });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'plan_id_mismatch');
  const ok = await handleCodexApi({ method: 'POST', path: '/api/codex/history/export', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, body: { root: 'hist-test', planId, relPaths: ['session-1.jsonl'], outFile, acknowledged: true, purpose: 'handoff' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.wrote, true);
  assert.equal(ok.body.originalsUnchanged, true);
  assert.equal(ok.body.historyWriteSupported, false);
});

test('N04 CLI：history 命令只走 loopback + 管理令牌，拒绝非本机目标', () => {
  const remote = cli(['history', 'diagnose', '--base-url', 'http://192.0.2.1:9', '--root', 'x', '--json']);
  assert.equal(remote.status, 1);
  assert.equal(remote.json.code, 'remote_target_forbidden');
  const noToken = cli(['history', 'diagnose', '--base-url', 'http://127.0.0.1:9', '--root', 'x', '--json']);
  assert.equal(noToken.status, 2);
  assert.equal(noToken.json.code, 'admin_token_missing');
  const noPlan = cli(['history', 'export', '--base-url', 'http://127.0.0.1:9', '--root', 'x', '--out', '/tmp/x.json', '--purpose', 'p', '--acknowledge', '--yes', '--json'], { MG_ADMIN_TOKEN: 'synthetic' });
  assert.equal(noPlan.status, 1);
  assert.equal(noPlan.json.code, 'plan_required');
});
