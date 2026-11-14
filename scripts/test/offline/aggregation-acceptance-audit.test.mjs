// A5 反降级审计自证：七条规则必须能离线判定，且干净候选不被误报。
//
// 可离线判定的：mock 冒充真实、CLI 冒充 GUI、MCP 冒充原生、模型数缩减、
// 同一 diff 里改源码又只删断言、skip 计为通过、契约被改写。
// 不能离线判定的（证据真伪、GUI 来源、账户资格）列入 MANUAL_AUDIT_STEPS，由人类复核。
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_RULE_IDS, MANUAL_AUDIT_STEPS, auditCandidate, auditSha256, parseUnifiedDiff } from './aggregation-audit.js'
import { REQUIREMENT_IDS, TESTED_TREE_SHA, buildMatrix, loadSources } from './aggregation-matrix.js'

const { caseIndex } = buildMatrix(loadSources())

function realRecord(id, over = {}) {
  const cases = {}
  for (const c of caseIndex[id]) {
    cases[c] = { passed: true, skipped: false, client: /^(gui-|desktop-)/.test(c) ? 'desktop-gui' : 'http', engine: 'codex-native' }
  }
  return {
    status: 'PASS_REAL',
    commitSha: TESTED_TREE_SHA,
    command: 'node scripts/test/codex-e2e.mjs --native-v2 --model gpt-6-luna',
    receipt: { traceId: 'trace-' + id.toLowerCase(), model: 'gpt-6-luna', nativeEngine: 'codex-native' },
    realTarget: true,
    passedAllOnRealTarget: true,
    cases,
    ...over,
  }
}

function allReal() {
  return Object.fromEntries(REQUIREMENT_IDS.map((id) => [id, realRecord(id)]))
}

const SRC_AND_WEAKENED_TEST = [
  'diff --git a/src/codex/interop.js b/src/codex/interop.js',
  '--- a/src/codex/interop.js',
  '+++ b/src/codex/interop.js',
  '@@ -1,2 +1,2 @@',
  '-const mode = "native"',
  '+const mode = "compat"',
  'diff --git a/scripts/test/offline/codex-interop.test.mjs b/scripts/test/offline/codex-interop.test.mjs',
  '--- a/scripts/test/offline/codex-interop.test.mjs',
  '+++ b/scripts/test/offline/codex-interop.test.mjs',
  '@@ -10,3 +10,1 @@',
  '-  assert.equal(mode, "native")',
  '-  assert.equal(tools.length, 3)',
  '+  // 断言已删除',
].join('\n')

test('干净候选：七条规则全部不触发', () => {
  const report = auditCandidate({ evidence: allReal(), diff: '', caseIndex })
  assert.equal(report.ok, true)
  assert.deepEqual(report.findings, [])
  assert.equal(AUDIT_RULE_IDS.length, 7)
})

test('规则 mock-as-real：PASS_REAL 但 realTarget 不为 true，或回执标记 mock', () => {
  const evidence = allReal()
  evidence['MG-R005'] = realRecord('MG-R005', { realTarget: false })
  let report = auditCandidate({ evidence, diff: '', caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'mock-as-real' && f.subject === 'MG-R005'))

  const evidence2 = allReal()
  evidence2['MG-R005'] = realRecord('MG-R005', { receipt: { traceId: 't', mock: true } })
  report = auditCandidate({ evidence: evidence2, diff: '', caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'mock-as-real' && /mock:true/.test(f.detail)))
})

test('规则 cli-for-gui：GUI 用例记录 client=codex-cli 即阻断', () => {
  const evidence = allReal()
  const rec = realRecord('MG-R001')
  rec.cases = { ...rec.cases, 'gui-activate': { passed: true, skipped: false, client: 'codex-cli' } }
  evidence['MG-R001'] = rec
  const report = auditCandidate({ evidence, diff: '', caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'cli-for-gui' && f.subject === 'MG-R001'))
})

test('规则 mcp-as-native：原生用例记录 engine=mcp 或回执 nativeEngine=mcp 即阻断', () => {
  const evidence = allAllRealWithNative()
  const report = auditCandidate({ evidence, diff: '', caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'mcp-as-native' && f.subject === 'MG-R005'))

  const evidence2 = allAllRealWithNative()
  evidence2['MG-R006'] = { ...evidence2['MG-R006'], receipt: { traceId: 't', nativeEngine: 'external-scheduler' } }
  const report2 = auditCandidate({ evidence: evidence2, diff: '', caseIndex })
  assert.ok(report2.findings.some((f) => f.rule === 'mcp-as-native' && f.subject === 'MG-R006'))
})

function allAllRealWithNative() {
  const evidence = allReal()
  const rec = realRecord('MG-R005')
  rec.cases = { ...rec.cases, 'native-child-thread-not-mcp': { passed: true, skipped: false, engine: 'mcp' } }
  evidence['MG-R005'] = rec
  return evidence
}

test('规则 model-count-reduced：模型数低于上一版即阻断，PASS_REAL 且 0 个模型也阻断', () => {
  const evidence = allReal()
  evidence['MG-R003'] = { ...evidence['MG-R003'], catalog: { modelCount: 5 } }
  const previous = { 'MG-R003': { catalog: { modelCount: 9 } } }
  let report = auditCandidate({ evidence, previous, diff: '', caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'model-count-reduced' && /9 to 5/.test(f.detail)))

  evidence['MG-R003'] = { ...evidence['MG-R003'], catalog: { modelCount: 0 } }
  report = auditCandidate({ evidence, diff: '', caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'model-count-reduced' && /modelCount=0/.test(f.detail)))
})

test('规则 assertions-weakened：同一 diff 改 src 且只删断言 / 删测试文件', () => {
  const report = auditCandidate({ evidence: allReal(), diff: SRC_AND_WEAKENED_TEST, caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'assertions-weakened'))
  assert.equal(report.stats.srcTouched, true)
  assert.equal(report.stats.removedAssertions, 2)
  assert.equal(report.stats.addedAssertions, 0)

  const deleted = [
    'diff --git a/src/codex/interop.js b/src/codex/interop.js',
    '--- a/src/codex/interop.js',
    '+++ b/src/codex/interop.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/scripts/test/offline/codex-interop.test.mjs b/scripts/test/offline/codex-interop.test.mjs',
    'deleted file mode 100644',
    '--- a/scripts/test/offline/codex-interop.test.mjs',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-test("x", () => {})',
  ].join('\n')
  assert.ok(auditCandidate({ evidence: allReal(), diff: deleted, caseIndex }).findings.some((f) => f.rule === 'assertions-weakened'))
})

test('只改测试、不碰源码时，断言调整不算降级（避免误报）', () => {
  const onlyTest = [
    'diff --git a/scripts/test/offline/codex-interop.test.mjs b/scripts/test/offline/codex-interop.test.mjs',
    '--- a/scripts/test/offline/codex-interop.test.mjs',
    '+++ b/scripts/test/offline/codex-interop.test.mjs',
    '@@ -1 +1 @@',
    '-  assert.equal(a, 1)',
    '+  assert.equal(a, 2)',
  ].join('\n')
  const report = auditCandidate({ evidence: allReal(), diff: onlyTest, caseIndex })
  assert.equal(report.ok, true)
})

test('规则 skipped-as-passed：skip 计为 passed，或在测试里新增 skip', () => {
  const evidence = allReal()
  const rec = realRecord('MG-R006')
  rec.cases = { ...rec.cases, resume: { passed: true, skipped: true } }
  evidence['MG-R006'] = rec
  assert.ok(auditCandidate({ evidence, diff: '', caseIndex }).findings.some((f) => f.rule === 'skipped-as-passed'))

  const skipDiff = [
    'diff --git a/scripts/test/offline/codex-v2-lifecycle.test.mjs b/scripts/test/offline/codex-v2-lifecycle.test.mjs',
    '--- a/scripts/test/offline/codex-v2-lifecycle.test.mjs',
    '+++ b/scripts/test/offline/codex-v2-lifecycle.test.mjs',
    '@@ -1,2 +1,3 @@',
    ' test("a", () => {})',
    '+test.skip("b", () => {})',
  ].join('\n')
  const report = auditCandidate({ evidence: allReal(), diff: skipDiff, caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'skipped-as-passed' && f.subject.includes('codex-v2-lifecycle')))
})

test('规则 requirement-reworded：契约哈希不符或受保护文件被改即阻断', () => {
  const contractDiff = [
    'diff --git a/docs/product/2026-11-14-owner-product-contract.md b/docs/product/2026-11-14-owner-product-contract.md',
    '--- a/docs/product/2026-11-14-owner-product-contract.md',
    '+++ b/docs/product/2026-11-14-owner-product-contract.md',
    '@@ -17 +17 @@',
    '-| MG-R001 | GUI 一键进入/退出聚合模式，默认官方套餐保持可用 | ... |',
    '+| MG-R001 | GUI 可切换聚合模式 | ... |',
  ].join('\n')
  let report = auditCandidate({ evidence: allReal(), diff: contractDiff, caseIndex })
  assert.ok(report.findings.some((f) => f.rule === 'requirement-reworded'))

  report = auditCandidate({ evidence: allReal(), diff: '', caseIndex, contractText: 'rewritten', pinned: { contractSha256: 'deadbeef' } })
  assert.ok(report.findings.some((f) => f.rule === 'requirement-reworded' && /sha256 differs/.test(f.detail)))

  const live = loadSources()
  report = auditCandidate({ evidence: allReal(), diff: '', caseIndex, contractText: live.contractText, pinned: { contractSha256: 'deadbeef' } })
  assert.ok(report.findings.length > 0, 'mismatched pin must be caught against the live contract too')
  // 正例：钉住值等于当前契约时不应误报。
  const exact = auditCandidate({ evidence: allReal(), diff: '', caseIndex, contractText: live.contractText, pinned: { contractSha256: auditSha256(live.contractText) } })
  assert.equal(exact.ok, true)
})

test('diff 解析：区分 added/modified/deleted，忽略 +++/--- 头部', () => {
  const files = parseUnifiedDiff(SRC_AND_WEAKENED_TEST)
  assert.equal(files.length, 2)
  assert.equal(files[0].file, 'src/codex/interop.js')
  assert.deepEqual(files[1].removed.length, 2)
  assert.deepEqual(files[1].added.length, 1)
  assert.equal(files[1].added[0].includes('+++'), false)
})

test('人工审计步骤存在且覆盖离线不可判定的项', () => {
  assert.ok(MANUAL_AUDIT_STEPS.length >= 7)
  const text = MANUAL_AUDIT_STEPS.join('\n')
  for (const phrase of ['原版 ChatGPT Desktop', '上游服务端日志', 'GPT-6 Luna', '所有者书面批准', '只读快照']) {
    assert.ok(text.includes(phrase), 'manual audit steps missing: ' + phrase)
  }
})
