// A5 门禁自证：门禁本身必须是诚实的。
//
// 覆盖题目要求的四个反向场景 + 两个附加陷阱：
//   1. PASS_MOCK 永不 ready:true（哪怕它自称 passedAllOnRealTarget）
//   2. 缺证据 ⇒ BLOCKED 且点名该需求
//   3. 全部 PASS_REAL 但 ownerApproval:false ⇒ 仍 ready:false
//   4. 伪造 PASS_REAL（无 SHA / 无命令 / 无回执）被 validator 拒绝
//   5. skip 用例不能计为通过；证据 SHA 必须等于被测树（旧证据不得复用）
//   6. 基线本身必须判为 BLOCKED，且 MG-R012 的阻塞原因可区分
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateGate, evaluateRelease, gateForBaseline, validateEvidence } from './aggregation-gate.js'
import { REQUIREMENT_IDS, TESTED_TREE_SHA, ROOT, buildMatrix, loadSources } from './aggregation-matrix.js'

const { caseIndex } = buildMatrix(loadSources())
const SHA = TESTED_TREE_SHA
const OTHER_SHA = 'a9f32c976f5415adb898c31605b362b25d2ee6aa'

// 构造一条“形式上完整”的 PASS_REAL：所有计划用例都 passed、非 skipped。
function realRecord(id, over = {}) {
  const cases = {}
  for (const c of caseIndex[id]) {
    cases[c] = { passed: true, skipped: false, client: /^(gui-|desktop-)/.test(c) ? 'desktop-gui' : 'http' }
  }
  return {
    status: 'PASS_REAL',
    commitSha: SHA,
    command: 'node scripts/test/codex-e2e.mjs --native-v2 --model gpt-6-luna',
    receipt: { traceId: 'trace-' + id.toLowerCase(), model: 'gpt-6-luna' },
    realTarget: true,
    passedAllOnRealTarget: true,
    cases,
    ...over,
  }
}

function allReal(overrides = {}) {
  const evidence = {}
  for (const id of REQUIREMENT_IDS) evidence[id] = realRecord(id)
  return Object.assign(evidence, overrides)
}

test('空证据：ready:false / BLOCKED / 点名 MG-R001，12 项全部未通过', () => {
  const gate = evaluateGate({ evidence: {}, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.status, 'BLOCKED')
  assert.equal(gate.failedRequirement, 'MG-R001')
  assert.deepEqual(gate.failedRequirements, REQUIREMENT_IDS)
  assert.equal(gate.canAskOwnerToMerge, false)
  for (const row of gate.requirements) {
    assert.equal(row.passed, false)
    assert.equal(row.reason, 'missing_evidence')
  }
})

test('PASS_MOCK 永不 ready:true：即使其余 11 项真实通过', () => {
  const evidence = allReal({
    'MG-R005': realRecord('MG-R005', { status: 'PASS_MOCK', realTarget: false, passedAllOnRealTarget: false, receipt: { traceId: 'mock-only' } }),
  })
  const gate = evaluateGate({ evidence, ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.status, 'BLOCKED')
  assert.equal(gate.failedRequirement, 'MG-R005')
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R005').reason, 'pass_mock_cannot_release')
})

test('PASS_MOCK 自称 passedAllOnRealTarget:true 属于伪装，直接 BLOCKED', () => {
  const record = { status: 'PASS_MOCK', realTarget: false, passedAllOnRealTarget: true }
  const gate = evaluateGate({ evidence: allReal({ 'MG-R003': record }), ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R003')
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R003').reason, 'mock_cannot_satisfy_real')

  const verdict = validateEvidence(record, { requirement: 'MG-R003', cases: caseIndex['MG-R003'] })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.errors.some((e) => e.code === 'mock_claims_real'))
})

test('缺证据的需求被单独点名，其余通过不掩盖缺口', () => {
  const evidence = allReal()
  delete evidence['MG-R007']
  const gate = evaluateGate({ evidence, ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R007')
  assert.deepEqual(gate.failedRequirements, ['MG-R007'])
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R007').reason, 'missing_evidence')
  assert.equal(gate.requirements.filter((r) => r.passed).length, 11)
})

test('全部 PASS_REAL 但 ownerApproval:false ⇒ ready:false，且可请所有者批准', () => {
  const gate = evaluateGate({ evidence: allReal(), ownerApproval: false, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.status, 'BLOCKED')
  assert.equal(gate.reason, 'owner_approval_missing')
  assert.equal(gate.failedRequirement, null)
  assert.deepEqual(gate.failedRequirements, [])
  assert.equal(gate.canAskOwnerToMerge, true)
})

test('全部 PASS_REAL 且所有者批准 ⇒ ready:true（这是唯一放行路径）', () => {
  const gate = evaluateGate({ evidence: allReal(), ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, true)
  assert.equal(gate.status, 'PASS_REAL')
  assert.equal(gate.failedRequirements.length, 0)
})

test('伪造 PASS_REAL：缺 SHA / 缺命令 / 缺回执，逐项被 validator 拒绝', () => {
  const cases = caseIndex['MG-R002']
  const base = realRecord('MG-R002')

  const noSha = { ...base, commitSha: undefined }
  const noCommand = { ...base, command: '   ' }
  const noReceipt = { ...base, receipt: {} }

  for (const [record, code] of [[noSha, 'missing_commit_sha'], [noCommand, 'missing_command'], [noReceipt, 'missing_receipt']]) {
    const verdict = validateEvidence(record, { requirement: 'MG-R002', cases })
    assert.equal(verdict.ok, false)
    assert.ok(verdict.errors.some((e) => e.code === code), 'expected ' + code + ', got ' + verdict.errors.map((e) => e.code).join(','))
  }

  // 短 SHA 也不算：契约要求精确 commit。
  const shortSha = validateEvidence({ ...base, commitSha: '2f641a9' }, { requirement: 'MG-R002', cases })
  assert.equal(shortSha.ok, false)
  assert.ok(shortSha.errors.some((e) => e.code === 'missing_commit_sha'))

  // 门禁不承认伪造记录。
  const gate = evaluateGate({ evidence: allReal({ 'MG-R002': noReceipt }), ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R002')
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R002').reason, 'invalid_evidence')
})

test('skip 用例不能计为通过；PASS_REAL 必须覆盖计划内每个用例', () => {
  const skipped = realRecord('MG-R006')
  skipped.cases = { ...skipped.cases, interrupt: { passed: true, skipped: true, client: 'http' } }
  let gate = evaluateGate({ evidence: allReal({ 'MG-R006': skipped }), ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R006')

  const missingCase = realRecord('MG-R006')
  delete missingCase.cases.resume
  gate = evaluateGate({ evidence: allReal({ 'MG-R006': missingCase }), ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R006')
})

test('证据必须绑定被测树：SHA 不一致即 stale_evidence', () => {
  const gate = evaluateGate({ evidence: allReal(), ownerApproval: true, headSha: OTHER_SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R001')
  assert.equal(gate.requirements[0].reason, 'stale_evidence')
})

test('FAIL 是失败，不是“待通过”', () => {
  const failed = realRecord('MG-R008', { status: 'FAIL', realTarget: false, passedAllOnRealTarget: false })
  const gate = evaluateGate({ evidence: allReal({ 'MG-R008': failed }), ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R008')
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R008').reason, 'failed_on_target')
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R008').status, 'FAIL')
})

test('未知状态按 NOT_TESTED 处理，不能借字符串绕过门禁', () => {
  const weird = realRecord('MG-R004', { status: 'DONE' })
  const gate = evaluateGate({ evidence: allReal({ 'MG-R004': weird }), ownerApproval: true, headSha: SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R004')
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R004').status, 'NOT_TESTED')
})

test('基线门禁输出必须是 ready:false / BLOCKED，且 MG-R012 原因是 BLOCKED 而非未测', () => {
  const gate = gateForBaseline({ sha: SHA, ownerApproval: true })
  assert.equal(gate.ready, false)
  assert.equal(gate.status, 'BLOCKED')
  assert.equal(gate.failedRequirement, 'MG-R001')
  assert.equal(gate.failedRequirements.length, 12)
  const r012 = gate.requirements.find((r) => r.id === 'MG-R012')
  assert.equal(r012.status, 'BLOCKED')
  assert.equal(r012.reason, 'blocked_on_prerequisite')
  const r001 = gate.requirements.find((r) => r.id === 'MG-R001')
  assert.equal(r001.status, 'NOT_TESTED')
  assert.match(r001.detail, /P03/)
})

test('门禁模块不硬编码结论：状态来自输入数据，同一函数可产出 ready:true', () => {
  const src = readFileSync(join(ROOT, 'scripts/test/offline/aggregation-gate.js'), 'utf8')
  // 除返回状态字段外，不得出现把某个 MG-R 写死为通过的布尔常量。
  assert.equal(/MG-R\d{3}\s*[:=]\s*true/.test(src), false)
  const a = evaluateGate({ evidence: {}, headSha: SHA, caseIndex })
  const b = evaluateGate({ evidence: allReal(), ownerApproval: true, headSha: SHA, caseIndex })
  assert.notEqual(a.ready, b.ready)
})

test('空计划不是自动通过：没有用例计划时 PASS_REAL 也不被承认', () => {
  const gate = evaluateGate({ evidence: allReal(), ownerApproval: true, headSha: SHA, caseIndex: {} })
  assert.equal(gate.ready, false)
  assert.equal(gate.failedRequirement, 'MG-R001')
  assert.equal(gate.requirements[0].reason, 'missing_case_plan')
})

test('发布判定叠加反降级审计：证据全绿但 diff 删断言，仍 ready:false', () => {
  const weakDiff = [
    'diff --git a/src/codex/interop.js b/src/codex/interop.js',
    '--- a/src/codex/interop.js',
    '+++ b/src/codex/interop.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/scripts/test/offline/codex-interop.test.mjs b/scripts/test/offline/codex-interop.test.mjs',
    '--- a/scripts/test/offline/codex-interop.test.mjs',
    '+++ b/scripts/test/offline/codex-interop.test.mjs',
    '@@ -1 +1 @@',
    '-  assert.equal(mode, "native")',
    '+  // removed',
  ].join('\n')
  const blocked = evaluateRelease({ evidence: allReal(), ownerApproval: true, headSha: SHA, caseIndex, diff: weakDiff })
  assert.equal(blocked.ready, false)
  assert.equal(blocked.status, 'BLOCKED')
  assert.equal(blocked.reason, 'anti_downgrade_findings')
  assert.ok(blocked.auditFindings.some((f) => f.rule === 'assertions-weakened'))

  const clean = evaluateRelease({ evidence: allReal(), ownerApproval: true, headSha: SHA, caseIndex, diff: '' })
  assert.equal(clean.ready, true)
  assert.deepEqual(clean.auditFindings, [])
})
