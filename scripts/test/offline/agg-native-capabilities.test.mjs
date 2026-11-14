// A1｜MG-R011：原生能力清单的机器可读记账，防止读者把 "V1 可用" 误读成 "原生 Agent Team 完成"。
//
// 断言的是"记账诚实"，不是能力存在：
//   · 每个能力都有 status ∈ PASS_MOCK / NOT_ACCEPTED / BLOCKED / NOT_TESTED；
//   · 本分支不存在 PASS_REAL（真实 Luna 调用未授权）；
//   · 任何 NOT_ACCEPTED 必须给出协议级缺失证据（messageTypes / fields / why），不能只写"未实现"；
//   · 任何 BLOCKED 必须写明阻断根因；
//   · 清单引用的离线套件必须真实存在，避免"登记了不存在的证据"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CAPABILITY_STATUSES,
  NATIVE_CAPABILITIES,
  NATIVE_CAPABILITY_HEADLINE,
  nativeCapabilityInventory,
} from '../../../src/codex/native-capabilities.js'

const REQUIRED_IDS = [
  'v1_spawn', 'v1_tool_rounds', 'v1_followup_same_child', 'v1_resume',
  'v2_wait_collect', 'v2_followup_single_process', 'v2_interrupt', 'cross_provider_child',
  'sse_single_terminal', 'unreadable_ciphertext_not_forwarded',
  'real_luna_parent', 'codex_desktop_gui_native',
]

test('capabilities：清单覆盖 V1/V2/中断/跨供应商，且状态取值受控', () => {
  assert.deepEqual(CAPABILITY_STATUSES, ['PASS_MOCK', 'NOT_ACCEPTED', 'BLOCKED', 'NOT_TESTED'])
  const ids = NATIVE_CAPABILITIES.map((c) => c.id)
  for (const id of REQUIRED_IDS) assert.ok(ids.includes(id), '缺少能力项: ' + id)
  assert.equal(new Set(ids).size, ids.length, '能力 ID 不得重复')
  for (const cap of NATIVE_CAPABILITIES) {
    assert.ok(CAPABILITY_STATUSES.includes(cap.status), cap.id + ' 状态越界: ' + cap.status)
    assert.equal(typeof cap.gatewayRole, 'string')
    assert.ok(cap.gatewayRole.length > 0, cap.id + ' 必须说明网关在其中的角色')
    assert.ok(cap.evidence && typeof cap.evidence === 'object', cap.id + ' 必须有证据指针')
  }
})

test('capabilities：本分支没有任何 PASS_REAL，整体结论不宣称 Agent Team 完成', () => {
  assert.equal(NATIVE_CAPABILITIES.some((c) => c.status === 'PASS_REAL'), false)
  const inventory = nativeCapabilityInventory()
  assert.equal(inventory.schema, 'mg.codex.native-capabilities/v1')
  assert.equal(inventory.agentTeamComplete, false)
  assert.match(inventory.headline, /未完成/)
  assert.match(NATIVE_CAPABILITY_HEADLINE, /NOT_ACCEPTED/)
  assert.match(NATIVE_CAPABILITY_HEADLINE, /BLOCKED/)
})

test('capabilities：V1 各项为 PASS_MOCK（不是 PASS_REAL），V2 收支与中断如实记账', () => {
  const byId = new Map(NATIVE_CAPABILITIES.map((c) => [c.id, c]))
  for (const id of ['v1_spawn', 'v1_tool_rounds', 'v1_followup_same_child', 'v1_resume', 'cross_provider_child']) {
    assert.equal(byId.get(id).status, 'PASS_MOCK', id)
  }
  assert.equal(byId.get('v2_wait_collect').status, 'PASS_MOCK')
  assert.equal(byId.get('v2_followup_single_process').status, 'NOT_ACCEPTED')
  assert.equal(byId.get('v2_interrupt').status, 'NOT_ACCEPTED')
  assert.equal(byId.get('real_luna_parent').status, 'BLOCKED')
  assert.equal(byId.get('codex_desktop_gui_native').status, 'BLOCKED')
  // V1 正常退出后的 resume 不等于"V2 单进程追派已闭环"
  assert.notEqual(byId.get('v1_resume').status, byId.get('v2_followup_single_process').status)
})

test('capabilities：NOT_ACCEPTED 必须给出协议级缺失证据，BLOCKED 必须给出根因', () => {
  for (const cap of NATIVE_CAPABILITIES.filter((c) => c.status === 'NOT_ACCEPTED')) {
    assert.ok(cap.missing && typeof cap.missing === 'object', cap.id + ' 缺少 missing 证据')
    assert.ok(Array.isArray(cap.missing.messageTypes), cap.id + ' 必须列出缺失/不可用的消息类型')
    assert.ok(Array.isArray(cap.missing.fields), cap.id + ' 必须列出相关字段')
    assert.equal(typeof cap.missing.why, 'string')
    assert.ok(cap.missing.why.length >= 20, cap.id + ' 的 why 必须写清协议层原因，不能是空话')
  }
  for (const cap of NATIVE_CAPABILITIES.filter((c) => c.status === 'BLOCKED')) {
    assert.equal(typeof cap.blocker, 'string')
    assert.ok(cap.blocker.length >= 10, cap.id + ' 必须写明阻断根因')
  }
  // 中断无法在上游表达：证据必须点名具体的协议面，而不是“没做”
  const interrupt = NATIVE_CAPABILITIES.find((c) => c.id === 'v2_interrupt')
  assert.ok(interrupt.missing.messageTypes.includes('response.cancel'))
  assert.ok(interrupt.missing.messageTypes.includes('response.interrupted'))
  assert.ok(interrupt.missing.fields.some((f) => f.includes('interrupted')))
  assert.match(interrupt.missing.why, /interrupt_agent/)
})

test('capabilities：清单可直接 JSON 落盘（无函数/undefined），且计数与缺口一致', () => {
  const inventory = nativeCapabilityInventory()
  const round = JSON.parse(JSON.stringify(inventory))
  assert.deepEqual(round, inventory, '不得含函数或 undefined')
  const total = Object.values(round.counts).reduce((a, b) => a + b, 0)
  assert.equal(total, NATIVE_CAPABILITIES.length)
  assert.equal(round.gaps.length, round.counts.NOT_ACCEPTED + round.counts.BLOCKED)
  for (const gap of round.gaps) assert.ok(['NOT_ACCEPTED', 'BLOCKED'].includes(gap.code))
})

test('capabilities：清单引用的离线套件真实存在（未登记不存在的证据）', () => {
  const inventory = nativeCapabilityInventory()
  assert.equal(inventory.suites.length, 4)
  for (const rel of inventory.suites) {
    assert.match(rel, /^scripts\/test\/offline\/agg-native-[a-z-]+\.test\.mjs$/)
    assert.equal(existsSync(fileURLToPath(new URL('../../../' + rel, import.meta.url))), true, '套件不存在: ' + rel)
  }
  for (const cap of NATIVE_CAPABILITIES) {
    if (cap.suite) {
      assert.equal(existsSync(fileURLToPath(new URL('../../../' + cap.suite, import.meta.url))), true, cap.id + ' 引用套件不存在')
    }
    if (cap.evidence && cap.evidence.command) {
      assert.match(cap.evidence.command, /^scripts\/test\/codex-e2e\.mjs/)
      assert.equal(existsSync(fileURLToPath(new URL('../../../scripts/test/codex-e2e.mjs', import.meta.url))), true)
    }
  }
})
