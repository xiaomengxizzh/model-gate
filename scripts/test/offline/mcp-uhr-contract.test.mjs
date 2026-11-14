// M5-2 / T-AGENT-02：本地 MCP ↔ mock UHR 契约验收（真实临时目录，无网络）。
// 这是 **mock 契约验收**，不是真实 UHR 验收（真实集成 = NOT_RUN）。
// 断言重点：只转发有界摘要与不透明引用、预算/截止/只读意图/工具范围、幂等、取消幂等、
// 重启可查、归属或 scoped grant、结果回到原 toolCallId、脱敏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOCK_ERR, MOCK_STATE, openMockUhr, taskRefToken } from '../../../src/mcp/uhr-mock.js'
import { UHR_REJECT, UHR_TOOL, createUhrAdapter } from '../../../src/mcp/uhr-adapter.js'

const NOW = 1_700_000_000_000

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-uhr-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const clock = { now: NOW }
  const uhr = openMockUhr({ dir, now: () => clock.now, currency: 'USD' })
  const adapter = createUhrAdapter({ uhr, now: () => clock.now })
  return { dir, clock, uhr, adapter }
}

const identity = (over = {}) => Object.assign({
  callerRef: 'dsh-session-1',
  scopeRef: 'ws-1',
  authorized: true,
  expiresAt: NOW + 3_600_000,
  currency: 'USD',
  maxBudgetMicro: 1_000_000,
}, over)

const request = (over = {}) => Object.assign({
  readOnlyIntent: 'read_only',
  budgetMicro: 100_000,
  currency: 'USD',
  timeMs: 60_000,
  toolScope: ['read_file'],
  summary: { title: '查一下路由契约', goal: '确认证据信封的边界', tags: ['docs'] },
  refs: [{ kind: 'file', ref: 'src/routing/decision.js' }],
  parentRef: 'task-parent-1',
}, over)

const tasksFile = (dir) => join(dir, 'uhr-tasks.json')

// ============================================================================
// 1. 正常委派
// ============================================================================
test('M5-2：正常委派 —— 返回 taskRef/state 与最小回执，并落盘', (t) => {
  const { dir, uhr, adapter } = setup(t)
  const r = adapter.delegateTask(identity(), request(), { toolCallId: 'call_1' })
  assert.equal(r.ok, true)
  assert.match(r.taskRef, /^task-[a-z0-9]{20}$/)
  assert.equal(r.state, MOCK_STATE.SUBMITTED)
  assert.equal(r.toolCallId, 'call_1')
  assert.equal(r.minimalReceipt.executions, 1)
  assert.equal(r.minimalReceipt.duplicate, false)
  assert.equal(r.minimalReceipt.refs.count, 1)
  assert.deepEqual(r.minimalReceipt.refs.kinds, ['file'])
  assert.equal(r.minimalReceipt.budgetMicro, 100_000)
  assert.equal(r.minimalReceipt.currency, 'USD')
  assert.match(r.minimalReceipt.summaryDigest, /^[a-f0-9]{24}$/)
  assert.ok(existsSync(tasksFile(dir)))
  assert.equal(uhr.snapshot().counts.total, 1)
  assert.deepEqual(uhr.snapshot().counts.submitted, 1)
})

// ============================================================================
// 2. 重复提交（同 key 同摘要 → 同 taskRef，不重复执行）
// ============================================================================
test('M5-2：重复提交幂等 —— 同 idempotencyKey 同摘要复用 taskRef，且不重复执行', (t) => {
  const { uhr, adapter } = setup(t)
  const first = adapter.delegateTask(identity(), request({ idempotencyKey: 'k-1' }), { toolCallId: 'call_1' })
  const second = adapter.delegateTask(identity(), request({ idempotencyKey: 'k-1' }), { toolCallId: 'call_2' })
  assert.equal(second.ok, true)
  assert.equal(second.taskRef, first.taskRef)
  assert.equal(second.minimalReceipt.duplicate, true)
  assert.equal(second.minimalReceipt.executions, 1, '重复提交不得重复执行')
  assert.equal(uhr.executionsOf(first.taskRef), 1)
  assert.equal(uhr.snapshot().counts.total, 1)

  const conflict = adapter.delegateTask(identity(), request({ idempotencyKey: 'k-1', budgetMicro: 200_000 }), { toolCallId: 'call_3' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, UHR_REJECT.CONFLICT, '同键不同摘要必须冲突拒绝')
})

// ============================================================================
// 3. 取消幂等 + 状态机
// ============================================================================
test('M5-2：取消幂等；已终态不可取消；未知 taskRef 明确拒绝', (t) => {
  const { adapter } = setup(t)
  const r = adapter.delegateTask(identity(), request(), { toolCallId: 'call_1' })
  const first = adapter.cancelTask(identity(), { taskRef: r.taskRef }, { toolCallId: 'call_2' })
  assert.equal(first.ok, true)
  assert.equal(first.state, MOCK_STATE.CANCELLED)
  assert.equal(first.duplicate, false)
  const second = adapter.cancelTask(identity(), { taskRef: r.taskRef }, { toolCallId: 'call_3' })
  assert.equal(second.ok, true)
  assert.equal(second.duplicate, true, '取消必须幂等')
  assert.equal(second.state, MOCK_STATE.CANCELLED)
  assert.equal(adapter.getTaskResult(identity(), { taskRef: r.taskRef }, { toolCallId: 'call_4' }).state, MOCK_STATE.CANCELLED)

  const missing = adapter.cancelTask(identity(), { taskRef: 'task-00000000000000000000' }, { toolCallId: 'call_5' })
  assert.equal(missing.code, UHR_REJECT.NOT_FOUND)
  const badRef = adapter.cancelTask(identity(), { taskRef: 'not-a-task' }, { toolCallId: 'call_6' })
  assert.equal(badRef.code, UHR_REJECT.BAD_REQUEST)
})

// ============================================================================
// 4. 重启后 taskRef 仍可查
// ============================================================================
test('M5-2：重启后 taskRef 仍可查（真实目录重建实例）', (t) => {
  const { dir, uhr, adapter } = setup(t)
  const r = adapter.delegateTask(identity(), request(), { toolCallId: 'call_1' })
  uhr.complete(r.taskRef, { text: '已完成：生成 3 条候选' })
  assert.ok(readFileSync(tasksFile(dir), 'utf8').length > 0)

  const reopened = openMockUhr({ dir, now: () => NOW })
  const adapter2 = createUhrAdapter({ uhr: reopened, now: () => NOW })
  const result = adapter2.getTaskResult(identity(), { taskRef: r.taskRef }, { toolCallId: 'call_2' })
  assert.equal(result.ok, true)
  assert.equal(result.state, MOCK_STATE.SUCCEEDED)
  assert.match(result.result.text, /已完成/)
  // 归属仍然强制：换一个身份查不到。
  assert.equal(adapter2.getTaskResult(identity({ scopeRef: 'ws-2' }), { taskRef: r.taskRef }, { toolCallId: 'c3' }).code, UHR_REJECT.NOT_OWNER)
})

// ============================================================================
// 5. 身份/作用域
// ============================================================================
test('M5-2：缺失/过期/未授权的连接身份都必须拒绝', (t) => {
  const { adapter } = setup(t)
  assert.equal(adapter.delegateTask(identity({ scopeRef: '' }), request(), { toolCallId: 'c1' }).code, UHR_REJECT.IDENTITY)
  assert.equal(adapter.delegateTask(identity({ callerRef: '' }), request(), { toolCallId: 'c2' }).code, UHR_REJECT.IDENTITY)
  assert.equal(adapter.delegateTask(identity({ authorized: false }), request(), { toolCallId: 'c3' }).code, UHR_REJECT.SCOPE)
  assert.equal(adapter.delegateTask(identity({ expiresAt: NOW - 1 }), request(), { toolCallId: 'c4' }).code, UHR_REJECT.SCOPE)
  assert.equal(adapter.delegateTask(identity({ expiresAt: undefined }), request(), { toolCallId: 'c5' }).code, UHR_REJECT.SCOPE)
  assert.equal(adapter.delegateTask(identity(), request({ readOnlyIntent: 'write' }), { toolCallId: 'c6' }).code, UHR_REJECT.INTENT)
  assert.equal(adapter.delegateTask(identity(), request({ readOnlyIntent: undefined }), { toolCallId: 'c7' }).code, UHR_REJECT.INTENT)
})

// ============================================================================
// 6. 预算与截止
// ============================================================================
test('M5-2：预算必须 > 0 且不超身份/策略上限；截止不得越过作用域', (t) => {
  const { adapter } = setup(t)
  assert.equal(adapter.delegateTask(identity(), request({ budgetMicro: 0 }), { toolCallId: 'c1' }).code, UHR_REJECT.BUDGET)
  assert.equal(adapter.delegateTask(identity(), request({ budgetMicro: -1 }), { toolCallId: 'c2' }).code, UHR_REJECT.BUDGET)
  assert.equal(adapter.delegateTask(identity(), request({ budgetMicro: 1.5 }), { toolCallId: 'c3' }).code, UHR_REJECT.BUDGET)
  const overIdentity = adapter.delegateTask(identity({ maxBudgetMicro: 50_000 }), request(), { toolCallId: 'c4' })
  assert.equal(overIdentity.code, UHR_REJECT.BUDGET)
  assert.equal(overIdentity.details.limitMicro, 50_000)
  assert.equal(adapter.delegateTask(identity(), request({ currency: 'EUR' }), { toolCallId: 'c5' }).code, UHR_REJECT.BUDGET)
  assert.equal(adapter.delegateTask(identity(), request({ currency: undefined }), { toolCallId: 'c6' }).code, UHR_REJECT.BUDGET)
  assert.equal(adapter.delegateTask(identity(), request({ deadlineAt: NOW - 1 }), { toolCallId: 'c7' }).code, UHR_REJECT.DEADLINE)
  assert.equal(adapter.delegateTask(identity(), request({ deadlineAt: NOW + 3_600_001 }), { toolCallId: 'c8' }).code, UHR_REJECT.DEADLINE)
  assert.equal(adapter.delegateTask(identity(), request({ timeMs: undefined }), { toolCallId: 'c9' }).code, UHR_REJECT.DEADLINE)
})

// ============================================================================
// 7. 只传有界摘要与不透明引用
// ============================================================================
test('M5-2：对话正文/绝对路径/密钥不得进摘要（拒绝）；超长摘要默认拒绝，显式 allow 才裁剪', (t) => {
  const { adapter } = setup(t)
  const conversation = adapter.delegateTask(identity(), request({ messages: [{ role: 'user', content: '完整对话正文' }] }), { toolCallId: 'c1' })
  assert.equal(conversation.code, UHR_REJECT.SHAPE)
  assert.equal(conversation.details.field, 'messages')

  const transcript = adapter.delegateTask(identity(), request({ summary: { title: 't', transcript: '完整对话' } }), { toolCallId: 'c2' })
  assert.equal(transcript.code, UHR_REJECT.SHAPE)
  assert.equal(transcript.details.field, 'transcript')

  const absolute = adapter.delegateTask(identity(), request({ summary: { title: '/home/user/project/secret.txt' } }), { toolCallId: 'c3' })
  assert.equal(absolute.code, UHR_REJECT.SHAPE)
  assert.equal(absolute.details.reason, 'absolute_path')

  const secret = adapter.delegateTask(identity(), request({ summary: { goal: 'key: sk-live-LEAK-1234' } }), { toolCallId: 'c4' })
  assert.equal(secret.code, UHR_REJECT.SHAPE)
  assert.equal(secret.details.reason, 'secret')

  const multiline = adapter.delegateTask(identity(), request({ summary: { goal: '第一行\n第二行' } }), { toolCallId: 'c5' })
  assert.equal(multiline.code, UHR_REJECT.SHAPE)
  assert.equal(multiline.details.reason, 'multiline')

  // M5-2b：超长摘要默认**拒绝**（不静默裁剪）；只有显式 allowSummaryTruncation 才裁剪。
  const long = adapter.delegateTask(identity(), request({ summary: { title: 'x'.repeat(400) } }), { toolCallId: 'c6' })
  assert.equal(long.ok, false, '默认不得静默裁剪超长摘要')
  assert.equal(long.code, UHR_REJECT.SUMMARY_TOO_LARGE)
  const allowed = adapter.delegateTask(identity(), request({ allowSummaryTruncation: true, summary: { title: 'x'.repeat(400) } }), { toolCallId: 'c7' })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.minimalReceipt.summaryTruncated, true)
})

test('M5-2：引用只能是不透明 {kind, ref}（拒绝内联正文/绝对路径/穿越/凭据 URL）', (t) => {
  const { adapter } = setup(t)
  const inline = adapter.delegateTask(identity(), request({ refs: [{ kind: 'file', ref: 'a.js', content: '完整文件正文' }] }), { toolCallId: 'c1' })
  assert.equal(inline.code, UHR_REJECT.REFS)
  assert.equal(inline.details.field, 'content')

  const absolute = adapter.delegateTask(identity(), request({ refs: [{ kind: 'file', ref: '/home/user/a.js' }] }), { toolCallId: 'c2' })
  assert.equal(absolute.code, UHR_REJECT.REFS)
  assert.equal(absolute.details.reason, 'absolute_path')

  const traversal = adapter.delegateTask(identity(), request({ refs: [{ kind: 'file', ref: '../../etc/passwd' }] }), { toolCallId: 'c3' })
  assert.equal(traversal.code, UHR_REJECT.REFS)

  const credentialUrl = adapter.delegateTask(identity(), request({ refs: [{ kind: 'doc', ref: 'https://user:sk-live-LEAK-999@example.com/doc' }] }), { toolCallId: 'c4' })
  assert.equal(credentialUrl.code, UHR_REJECT.REFS)

  const unknownKind = adapter.delegateTask(identity(), request({ refs: [{ kind: 'shell', ref: 'ls' }], toolScope: ['read_file'] }), { toolCallId: 'c5' })
  assert.equal(unknownKind.code, UHR_REJECT.REFS)

  const tooMany = adapter.delegateTask(identity(), request({ refs: Array.from({ length: 21 }, (_, i) => ({ kind: 'file', ref: 'f' + i + '.js' })) }), { toolCallId: 'c6' })
  assert.equal(tooMany.code, UHR_REJECT.REFS)
  assert.equal(tooMany.details.count, 21)
})

// ============================================================================
// 8. v2 不透明密文：跨域前明确拒绝
// ============================================================================
test('M5-2：v2 不透明密文在任何字段里都拒绝跨域转发（绝不解密）', (t) => {
  const { adapter } = setup(t)
  const inRefs = adapter.delegateTask(identity(), request({ refs: [{ kind: 'file', ref: 'a.js', encrypted_content: 'gAAA' }] }), { toolCallId: 'c1' })
  assert.equal(inRefs.code, UHR_REJECT.V2_OPAQUE)
  const inSummary = adapter.delegateTask(identity(), request({ summary: { title: 't', encrypted_task_id: 'task_x' } }), { toolCallId: 'c2' })
  assert.equal(inSummary.code, UHR_REJECT.V2_OPAQUE)
  const topLevel = adapter.delegateTask(identity(), request({ opaque_v2: true }), { toolCallId: 'c3' })
  assert.equal(topLevel.code, UHR_REJECT.V2_OPAQUE)
})

// ============================================================================
// 9. 工具范围
// ============================================================================
test('M5-2：工具范围只允许授权的只读子集', (t) => {
  const { adapter } = setup(t)
  assert.equal(adapter.delegateTask(identity(), request({ toolScope: ['shell'] }), { toolCallId: 'c1' }).code, UHR_REJECT.TOOL_SCOPE)
  assert.equal(adapter.delegateTask(identity(), request({ toolScope: ['read_file', 'write_file'] }), { toolCallId: 'c2' }).code, UHR_REJECT.TOOL_SCOPE)
  assert.equal(adapter.delegateTask(identity({ allowedToolScope: ['read_file'] }), request({ toolScope: ['search'] }), { toolCallId: 'c3' }).code, UHR_REJECT.TOOL_SCOPE)
  assert.equal(adapter.delegateTask(identity(), request({ toolScope: ['read_file', 'search'] }), { toolCallId: 'c4' }).ok, true)
})

// ============================================================================
// 10. 结果回到原 call ID（MCP 入口）
// ============================================================================
test('M5-2：MCP 结果必须原样回填 toolCallId（成功与失败都一样）', (t) => {
  const { adapter } = setup(t)
  const id = 'call_9f3:abc/123'
  const ok = adapter.handleToolCall({ name: UHR_TOOL.DELEGATE, toolCallId: id, connectionIdentity: identity(), arguments: request() })
  assert.equal(ok.isError, false)
  assert.equal(ok.toolCallId, id)
  assert.equal(ok.structuredContent.toolCallId, id)
  assert.equal(ok.content[0].type, 'text')

  const result = adapter.handleToolCall({ name: UHR_TOOL.GET_RESULT, toolCallId: id, connectionIdentity: identity(), arguments: { taskRef: ok.structuredContent.taskRef } })
  assert.equal(result.toolCallId, id)

  const failed = adapter.handleToolCall({ name: UHR_TOOL.DELEGATE, toolCallId: id, connectionIdentity: identity(), arguments: request({ readOnlyIntent: 'write' }) })
  assert.equal(failed.isError, true)
  assert.equal(failed.toolCallId, id)
  assert.equal(failed.structuredContent.code, UHR_REJECT.INTENT)

  const unknown = adapter.handleToolCall({ name: 'uhr_delete_everything', toolCallId: id, connectionIdentity: identity(), arguments: {} })
  assert.equal(unknown.isError, true)
  assert.equal(unknown.toolCallId, id)
  assert.equal(unknown.structuredContent.code, UHR_REJECT.BAD_REQUEST)
})

// ============================================================================
// 11. 归属与 scoped grant
// ============================================================================
test('M5-2：只有拥有 taskRef 或有 scoped grant 才能读取/取消', (t) => {
  const { adapter } = setup(t)
  const r = adapter.delegateTask(identity(), request(), { toolCallId: 'c1' })
  const other = identity({ callerRef: 'other', scopeRef: 'ws-2' })
  assert.equal(adapter.getTaskResult(other, { taskRef: r.taskRef }, { toolCallId: 'c2' }).code, UHR_REJECT.NOT_OWNER)
  assert.equal(adapter.cancelTask(other, { taskRef: r.taskRef }, { toolCallId: 'c3' }).code, UHR_REJECT.NOT_OWNER)
  const granted = identity({ callerRef: 'other', scopeRef: 'ws-2', grants: [taskRefToken(r.taskRef)] })
  assert.equal(adapter.getTaskResult(granted, { taskRef: r.taskRef }, { toolCallId: 'c4' }).ok, true)
  assert.equal(adapter.cancelTask(granted, { taskRef: r.taskRef }, { toolCallId: 'c5' }).ok, true)
})

// ============================================================================
// 12. 脱敏：拒绝的敏感内容不落盘，结果文本脱敏后再返回
// ============================================================================
test('M5-2：被拒的密钥/路径不落盘；上游结果里的密钥在返回前脱敏', (t) => {
  const { dir, uhr, adapter } = setup(t)
  const REJECTED = 'sk-live-REJECTED-1111'
  const denials = [
    adapter.delegateTask(identity(), request({ summary: { title: REJECTED } }), { toolCallId: 'c1' }),
    adapter.delegateTask(identity(), request({ refs: [{ kind: 'file', ref: '/home/user/' + REJECTED }] }), { toolCallId: 'c2' }),
    adapter.delegateTask(identity(), request({ idempotencyKey: REJECTED, budgetMicro: 0 }), { toolCallId: 'c3' }),
  ]
  assert.ok(denials.every((d) => d.ok === false))
  assert.ok(!JSON.stringify(denials).includes(REJECTED), '拒绝理由不得回显密钥')
  assert.equal(existsSync(tasksFile(dir)), false, '被拒请求不得产生任何落盘副作用')

  const r = adapter.delegateTask(identity(), request({ idempotencyKey: 'k-clean' }), { toolCallId: 'c4' })
  const RESULT_SECRET = 'sk-live-RESULT-2222'
  uhr.complete(r.taskRef, { text: '结果: ' + RESULT_SECRET + ' end' })
  const read = adapter.getTaskResult(identity(), { taskRef: r.taskRef }, { toolCallId: 'c5' })
  assert.equal(read.ok, true)
  assert.ok(!JSON.stringify(read).includes('RESULT-2222'), '返回前必须脱敏：' + JSON.stringify(read))
  assert.equal(read.result.redacted, true)
  assert.match(read.result.text, /\[redacted\]/)

  // 回执/快照同样脱敏（不含任务内容）。
  const snapshot = JSON.stringify(uhr.snapshot())
  assert.ok(!snapshot.includes('RESULT-2222'))
})

// ============================================================================
// 13. mock 边界：终态、损坏、无正文的摘要
// ============================================================================
test('M5-2：mock 边界 —— 已终态不可重复完成；任务表损坏拒绝启动', (t) => {
  const { dir, uhr, adapter } = setup(t)
  const r = adapter.delegateTask(identity(), request(), { toolCallId: 'c1' })
  uhr.complete(r.taskRef, { text: 'ok' })
  assert.throws(() => uhr.complete(r.taskRef, { text: 'again' }), (e) => e.code === MOCK_ERR.TERMINAL)
  assert.equal(adapter.cancelTask(identity(), { taskRef: r.taskRef }, { toolCallId: 'c2' }).code, UHR_REJECT.STATE)

  const corrupted = mkdtempSync(join(tmpdir(), 'mg-uhr-bad-'))
  t.after(() => rmSync(corrupted, { recursive: true, force: true }))
  writeFileSync(join(corrupted, 'uhr-tasks.json'), '{not json')
  assert.throws(() => openMockUhr({ dir: corrupted }), (e) => e.code === MOCK_ERR.CORRUPT)
  assert.equal(readFileSync(join(corrupted, 'uhr-tasks.json'), 'utf8'), '{not json', '损坏任务表不得被自动覆盖')
  // 任务表里不存摘要正文/引用原文之外的敏感内容——它只存有界标签与 hashes。
  const table = JSON.parse(readFileSync(tasksFile(dir), 'utf8'))
  const stored = JSON.stringify(table)
  // 注意 'task-...' 含子串 'sk-'，必须用带边界的密钥形状判定。
  assert.ok(!/(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/.test(stored), '任务表不得含密钥')
  assert.ok(!stored.includes('idempotencyKey'), '任务表不得存原始幂等键（只存哈希）')
})

// ============================================================================
// 14. 工具描述契约
// ============================================================================
test('M5-2：工具描述只暴露契约字段（无实现细节），且禁止未声明的写工具', (t) => {
  const { adapter } = setup(t)
  const defs = adapter.toolDefinitions()
  assert.deepEqual(defs.map((d) => d.name), [UHR_TOOL.DELEGATE, UHR_TOOL.GET_RESULT, UHR_TOOL.CANCEL])
  const delegate = defs[0]
  assert.deepEqual(delegate.inputSchema.required.slice().sort(), ['budgetMicro', 'currency', 'readOnlyIntent', 'summary'])
  assert.deepEqual(delegate.inputSchema.properties.readOnlyIntent.enum, ['read_only'])
  assert.equal(delegate.inputSchema.properties.toolScope.type, 'array')
  assert.ok(!JSON.stringify(defs).includes('forward.js'), '工具描述不得泄漏实现路径')
  assert.ok(Object.isFrozen(defs) && Object.isFrozen(defs[0]))
})
// ============================================================================
// 15. M5-2b / F-c1：摘要硬上限默认拒绝（不裁剪），显式 opt-in 才裁剪并留痕
// ============================================================================
test('M5-2b：5000 字符单行摘要默认拒绝且零提交；显式 allowSummaryTruncation 才裁剪', (t) => {
  const { uhr, adapter } = setup(t)
  const longLine = 'x'.repeat(5000)

  // 1) 默认：超总字节上限 ⇒ 拒绝，不裁剪、零提交。
  const rejected = adapter.delegateTask(identity(), request({ summary: { goal: longLine } }), { toolCallId: 'c1' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, UHR_REJECT.SUMMARY_TOO_LARGE)
  assert.equal(rejected.details.reason, 'total_bytes')
  assert.equal(rejected.details.limit, 1024)
  assert.equal(rejected.details.actual, Buffer.byteLength(JSON.stringify({ goal: longLine })))
  assert.equal(uhr.snapshot().counts.total, 0, '被拒摘要必须零提交')

  // 2) 默认：字段级超限（单行、总字节未超）同样拒绝，不裁剪。
  const fieldTooLong = adapter.delegateTask(identity(), request({ summary: { title: 'y'.repeat(300) } }), { toolCallId: 'c2' })
  assert.equal(fieldTooLong.ok, false)
  assert.equal(fieldTooLong.code, UHR_REJECT.SUMMARY_TOO_LARGE)
  assert.equal(fieldTooLong.details.reason, 'field_length')
  assert.equal(uhr.snapshot().counts.total, 0)

  // 3) 显式 allowSummaryTruncation ⇒ 裁剪，并保留原始/实际字节数与标记。
  const truncated = adapter.delegateTask(identity(), request({
    allowSummaryTruncation: true,
    summary: { goal: longLine },
  }), { toolCallId: 'c3' })
  assert.equal(truncated.ok, true)
  assert.equal(truncated.minimalReceipt.summaryTruncated, true)
  assert.equal(truncated.minimalReceipt.summaryOriginalBytes, Buffer.byteLength(JSON.stringify({ goal: longLine })))
  assert.ok(truncated.minimalReceipt.summaryBytes < truncated.minimalReceipt.summaryOriginalBytes)
  assert.ok(truncated.minimalReceipt.summaryBytes <= 1024 + 64, '裁剪后应落在硬上限附近')
  assert.equal(uhr.executionsOf(truncated.taskRef), 1)

  // 4) 小摘要不标记裁剪；非布尔 allowSummaryTruncation 拒绝。
  const small = adapter.delegateTask(identity(), request({ idempotencyKey: 'k-small' }), { toolCallId: 'c4' })
  assert.equal(small.ok, true)
  assert.equal(small.minimalReceipt.summaryTruncated, false)
  const badFlag = adapter.delegateTask(identity(), request({ idempotencyKey: 'k-flag', allowSummaryTruncation: 'yes' }), { toolCallId: 'c5' })
  assert.equal(badFlag.code, UHR_REJECT.BAD_REQUEST)
})

// ============================================================================
// 16. M5-2b / F-c2：空/缺失 toolCallId ⇒ BAD_REQUEST 且零提交
// ============================================================================
test('M5-2b：空或缺失 toolCallId 一律拒绝（零提交，不得返回 isError:false）', (t) => {
  const { uhr, adapter } = setup(t)

  const empty = adapter.handleToolCall({ name: UHR_TOOL.DELEGATE, toolCallId: '', connectionIdentity: identity(), arguments: request() })
  assert.equal(empty.isError, true, '空 callId 不得被当成成功')
  assert.equal(empty.structuredContent.code, UHR_REJECT.BAD_REQUEST)
  assert.equal(empty.toolCallId, '', '回填仍是原值（空串），但不冒充成功')

  const missing = adapter.handleToolCall({ name: UHR_TOOL.DELEGATE, connectionIdentity: identity(), arguments: request() })
  assert.equal(missing.isError, true)
  assert.equal(missing.structuredContent.code, UHR_REJECT.BAD_REQUEST)

  const blank = adapter.delegateTask(identity(), request(), { toolCallId: '   ' })
  assert.equal(blank.ok, false)
  assert.equal(blank.code, UHR_REJECT.BAD_REQUEST)

  const noMeta = adapter.delegateTask(identity(), request())
  assert.equal(noMeta.ok, false)
  assert.equal(noMeta.code, UHR_REJECT.BAD_REQUEST)

  // 查询/取消同样要求非空 callId，否则"结果回到原 call ID"无从谈起。
  const getEmpty = adapter.getTaskResult(identity(), { taskRef: 'task-00000000000000000000' }, { toolCallId: '' })
  assert.equal(getEmpty.code, UHR_REJECT.BAD_REQUEST)
  assert.equal(uhr.snapshot().counts.total, 0, '空 callId 不得提交任务')
})

// ============================================================================
// 17. M5-2b / F-c3：v2 检测是键级契约 —— 键名拒绝，字符串值不识别（钉住边界）
// ============================================================================
test('M5-2b：v2 检测只看键名 —— 键级拒绝、值级不拒绝（设计边界，不是 bug）', (t) => {
  const { adapter } = setup(t)

  const keyLevel = adapter.delegateTask(identity(), request({
    refs: [{ kind: 'file', ref: 'a.js', encrypted_content: 'gAAAAABmnoP' }],
  }), { toolCallId: 'c1' })
  assert.equal(keyLevel.ok, false)
  assert.equal(keyLevel.code, UHR_REJECT.V2_OPAQUE, '键级命中必须拒绝')

  const valueLevel = adapter.delegateTask(identity(), request({
    summary: { title: 'gAAAAABmnoPqrstuv' },
  }), { toolCallId: 'c2' })
  assert.equal(valueLevel.ok, true, '值里的 base64 不会按 v2 识别（不做语义猜测）')

  const valueInRef = adapter.delegateTask(identity(), request({
    refs: [{ kind: 'file', ref: 'gAAAAABmnoP-labelled.b64' }],
  }), { toolCallId: 'c3' })
  assert.equal(valueInRef.ok, true)
})
