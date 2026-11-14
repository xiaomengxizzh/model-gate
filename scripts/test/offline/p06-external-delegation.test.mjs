// P06：显式外部委派补充（UHR/MCP）离线契约测试。
// 只测 mock UHR 契约 + 回执登记：不注册生产 MCP、不冒充原生 child thread、无网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMockUhr } from '../../../src/mcp/uhr-mock.js'
import { createUhrAdapter } from '../../../src/mcp/uhr-adapter.js'
import {
  EXTERNAL_DELEGATION_KIND, EXTERNAL_REJECT, isNativeDelegationClaim, registerExternalDelegation,
} from '../../../src/routing/inference-receipt.js'

const NOW = 1_700_000_000_000
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-p06-uhr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uhr = openMockUhr({ dir, now: () => NOW, currency: 'USD' });
  const adapter = createUhrAdapter({ uhr, now: () => NOW });
  return { dir, uhr, adapter };
}
const identity = { callerRef: 'dsh-session-p06', scopeRef: 'ws-p06', authorized: true, expiresAt: NOW + 3_600_000, currency: 'USD', maxBudgetMicro: 1_000_000 };
const request = { readOnlyIntent: 'read_only', budgetMicro: 100_000, currency: 'USD', timeMs: 60_000, toolScope: ['read_file'], summary: { title: '外部委派摘要', goal: '只读核对', tags: ['p06'] }, refs: [{ kind: 'file', ref: 'src/router.js' }], idempotencyKey: 'idem-p06', toolCallId: 'call_p06' };

test('P06 委派结果显式标为外部降级（native=false/degraded=true），查询/取消同样标注', (t) => {
  const { adapter } = setup(t);
  const r = adapter.delegateTask(identity, request, { toolCallId: 'call_p06' });
  assert.equal(r.ok, true);
  assert.equal(r.delegation.kind, 'external_delegation');
  assert.equal(r.delegation.native, false);
  assert.equal(r.delegation.degraded, true);
  assert.equal(r.delegation.proof, 'uhr-mcp-v1');
  assert.equal(r.minimalReceipt.delegation.degraded, true);
  assert.equal(isNativeDelegationClaim(r), false);
  const got = adapter.getTaskResult(identity, { taskRef: r.taskRef }, { toolCallId: 'call_get' });
  assert.equal(got.ok, true);
  assert.equal(got.delegation.native, false);
  assert.equal(got.delegation.degraded, true);
  const cancelled = adapter.cancelTask(identity, { taskRef: r.taskRef }, { toolCallId: 'call_cancel' });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.delegation.native, false);
});

test('P06 回执登记：必须显式用户批准、作用域/幂等键齐全、摘要限长；同输入同回执', (t) => {
  const { adapter } = setup(t);
  const r = adapter.delegateTask(identity, request, { toolCallId: 'call_p06' });
  const base = { contract: 'uhr-mcp-v1', taskRef: r.taskRef, state: r.state, toolCallId: 'call_p06', callerRef: identity.callerRef, scopeRef: identity.scopeRef, idempotencyKey: 'idem-p06', summaryBytes: r.minimalReceipt.summaryBytes, userApproved: true };
  const ok = registerExternalDelegation(base);
  assert.equal(ok.ok, undefined);
  assert.equal(ok.kind, EXTERNAL_DELEGATION_KIND);
  assert.equal(ok.native, false);
  assert.equal(ok.degraded, true);
  assert.equal(ok.proof.contract, 'uhr-mcp-v1');
  assert.match(ok.callerRef, /^caller_[0-9a-f]{24}$/);
  assert.match(ok.scopeRef, /^scope_[0-9a-f]{24}$/);
  assert.match(ok.idempotencyHash, /^[0-9a-f]{24}$/);
  assert.match(ok.receiptHash, /^[0-9a-f]{32}$/);
  assert.equal(Object.isFrozen(ok), true);
  assert.equal(registerExternalDelegation(base).receiptHash, ok.receiptHash, '同输入必须可复算');
  assert.equal(JSON.stringify(ok).includes('idem-p06'), false, '幂等键只留哈希');
  assert.equal(JSON.stringify(ok).includes('ws-p06'), false, '作用域只留哈希');
});

test('P06 回执登记拒绝：native 宣称/未批准/缺作用域/超长摘要/错误契约', (t) => {
  const { adapter } = setup(t);
  const r = adapter.delegateTask(identity, request, { toolCallId: 'call_p06' });
  const base = { contract: 'uhr-mcp-v1', taskRef: r.taskRef, state: r.state, toolCallId: 'call_p06', callerRef: identity.callerRef, scopeRef: identity.scopeRef, idempotencyKey: 'idem-p06', summaryBytes: 100, userApproved: true };
  assert.equal(registerExternalDelegation(Object.assign({}, base, { native: true })).code, EXTERNAL_REJECT.NOT_EXTERNAL);
  assert.equal(registerExternalDelegation(Object.assign({}, base, { userApproved: false })).code, EXTERNAL_REJECT.NOT_APPROVED);
  assert.equal(registerExternalDelegation(Object.assign({}, base, { scopeRef: '' })).code, EXTERNAL_REJECT.SCOPE);
  assert.equal(registerExternalDelegation(Object.assign({}, base, { summaryBytes: 999999 })).code, EXTERNAL_REJECT.SUMMARY);
  assert.equal(registerExternalDelegation(Object.assign({}, base, { contract: 'other-v1' })).code, EXTERNAL_REJECT.CONTRACT);
  assert.equal(registerExternalDelegation(Object.assign({}, base, { taskRef: '../etc/passwd' })).code, EXTERNAL_REJECT.BAD_REQUEST);
  assert.equal(registerExternalDelegation(Object.assign({}, base, { idempotencyKey: '' })).code, EXTERNAL_REJECT.BAD_REQUEST);
});

test('P06 无工具扩权：mock 只暴露已声明的只读工具，未声明写工具不存在', (t) => {
  const { adapter } = setup(t);
  const defs = adapter.toolDefinitions();
  const names = defs.map((d) => d.name);
  assert.deepEqual(names.slice().sort(), ['uhr_cancel_task', 'uhr_delegate_task', 'uhr_get_task_result']);
  assert.equal(defs.some((d) => /write|edit|delete|exec/i.test(d.name)), false);
  // 未授权工具范围：在提交前拒绝，零执行
  const bad = adapter.delegateTask(identity, Object.assign({}, request, { toolScope: ['write_file'] }), { toolCallId: 'call_bad' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UHR_REJECT_TOOL_SCOPE');
});
