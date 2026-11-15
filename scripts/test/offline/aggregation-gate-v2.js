// V2 发布门禁（辅助模块，不是套件）。
//
// 与 V1 门禁（aggregation-gate.js）的关系：
//   - 复用同一套结构校验与门禁状态机（单一实现，不复制第二套判定口径）；
//   - 输入换成 V2 的 12 条需求 + V2 计划 §2.1 的用例映射 + V2 状态文档；
//   - V1 门禁继续守卫历史矩阵，但**不再**是 V2 发布门禁。
//
// 本轮关键不变式（可被 `--assert-native-compaction-blocking` 自证，CI 会跑）：
//   1. 12 条需求任一缺少经校验的真实回执 ⇒ ready:false；
//   2. `MG-R006` 的 native-compaction 三件套缺一 ⇒ ready:false（不能调大窗口/自建摘要绕过）；
//   3. 旧 V1 的 R006 PASS_REAL（无 native-compaction 用例）不得让 V2 通过；
//   4. 即使全绿，仍必须有 ownerApproval === true 才能 ready:true；
//   5. V2 已取消的 Console 全量用例不参与阻断（"20 个不可路由模型"不再是门禁）。
//
// 用法：
//   node scripts/test/offline/aggregation-gate-v2.js                       # 打印当前 V2 门禁 JSON
//   node scripts/test/offline/aggregation-gate-v2.js --sha <40hex>         # 指定被测树
//   node scripts/test/offline/aggregation-gate-v2.js --assert-native-compaction-blocking
//
// 零依赖、离线；只读仓库内文件。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateGate, evaluateRelease, STATUS_VOCABULARY } from './aggregation-gate.js'
import {
  NATIVE_COMPACTION_CASES,
  ROOT as ROOT_DIR,
  V2_BASELINE_SHA,
  V2_CANCELLED_CASES,
  buildV2Matrix,
  loadV2Sources,
} from './aggregation-matrix-v2.js'

export const V2_REQUIREMENT_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, i) => 'MG-R' + String(i + 1).padStart(3, '0')),
)

// 门禁默认被测树必须是**当前 HEAD**（A5 F2）：状态文档里的基线 SHA 只用于展示矩阵标题，
// 不能当成"当前被测树"，否则旧树证据会被当成当前证据。取不到 HEAD 就 fail-closed。
export function currentHeadSha() {
  const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(out)) throw new Error('cannot resolve current HEAD sha for the V2 gate')
  return out
}

// 历史复算（--replay）永远不等于发布放行：显式标记 replay / releaseEligible:false，
// 且无论证据多完整都不得 ready:true —— 旧树回执只能用于解释历史，不能当当前证据。
function replayNotRelease(result) {
  return Object.assign({}, result, {
    replay: true,
    releaseEligible: false,
    ready: false,
    status: 'BLOCKED',
    canAskOwnerToMerge: false,
    reason: result && result.ready ? 'replay_is_not_release_evidence' : (result && result.reason),
  })
}

export function v2CaseIndex() {
  return buildV2Matrix(loadV2Sources()).caseIndex
}

// 状态文档 → 门禁输入。只搬运状态与阻断原因；不带任何回执，因此不可能被判成 PASS_REAL。
export function v2EvidenceFromStatus(rows) {
  const evidence = {}
  for (const row of rows) {
    if (!STATUS_VOCABULARY.includes(row.status)) throw new Error('invalid V2 status for ' + row.id + ': ' + row.status)
    evidence[row.id] = {
      status: row.status,
      commitSha: null,
      command: null,
      receipt: null,
      realTarget: false,
      source: 'docs/evidence/aggregation-v2-status-2026-11-15.md §2',
      blocker: row.status === 'PASS_REAL' || row.status === 'PASS_MOCK' ? '' : row.basis,
      note: row.basis,
    }
  }
  return evidence
}

export function gateV2({ sha = null, ownerApproval = false, evidence = null, caseIndex = null, allowNonHead = false } = {}) {
  const head = currentHeadSha()
  const target = sha || head
  if (evidence && !allowNonHead && target !== head) {
    return {
      ready: false, status: 'BLOCKED', failedRequirement: null, failedRequirements: [],
      reason: 'non_head_sha_requires_replay_flag', canAskOwnerToMerge: false,
      ownerApproval: ownerApproval === true, headSha: target, requirements: [], unmappedEvidence: [],
    }
  }
  const sources = loadV2Sources()
  const matrix = buildV2Matrix(sources)
  const cases = caseIndex || matrix.caseIndex
  const statusDoc = sources.evidence[0]
  const records = evidence || v2EvidenceFromStatus(statusDoc.rows)
  const result = evaluateGate({
    evidence: records,
    ownerApproval,
    headSha: target,
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex: cases,
  })
  return allowNonHead ? replayNotRelease(result) : result
}

export function releaseV2({ sha = null, ownerApproval = false, evidence = null, diff = '', allowNonHead = false } = {}) {
  const head = currentHeadSha()
  const target = sha || head
  if (evidence && !allowNonHead && target !== head) {
    return {
      ready: false, status: 'BLOCKED', failedRequirement: null, failedRequirements: [],
      reason: 'non_head_sha_requires_replay_flag', canAskOwnerToMerge: false,
      ownerApproval: ownerApproval === true, headSha: target, requirements: [], unmappedEvidence: [],
      audit: null, auditFindings: [],
    }
  }
  const sources = loadV2Sources()
  const matrix = buildV2Matrix(sources)
  const statusDoc = sources.evidence[0]
  const records = evidence || v2EvidenceFromStatus(statusDoc.rows)
  const result = evaluateRelease({
    evidence: records,
    ownerApproval,
    headSha: target,
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex: matrix.caseIndex,
    diff,
  })
  return allowNonHead ? replayNotRelease(result) : result
}

const SYNTHETIC_SHA = 'a'.repeat(40)

function realRecord(caseList, { omitCase = null, skipCase = null, commitSha = SYNTHETIC_SHA } = {}) {
  const cases = {}
  for (const c of caseList) {
    cases[c] = { passed: true, receipt: 'case-receipt:' + c }
    if (omitCase && c === omitCase) delete cases[c]
    if (skipCase && c === skipCase) cases[c] = { passed: true, skipped: true, receipt: 'case-receipt:' + c }
  }
  return {
    status: 'PASS_REAL',
    commitSha,
    command: 'node scripts/test/offline/aggregation-gate-v2.js',
    receipt: { traceId: 't-' + Math.random().toString(16).slice(2) },
    realTarget: true,
    passedAllOnRealTarget: true,
    cases,
  }
}

function allGreen(caseIndex, opts = {}) {
  const evidence = {}
  const commitSha = opts.commitSha || SYNTHETIC_SHA
  for (const id of V2_REQUIREMENT_IDS) {
    const extra = id === 'MG-R006' ? Object.assign({ commitSha }, opts.r006 || {}) : { commitSha }
    evidence[id] = realRecord(caseIndex[id] || [], extra)
  }
  return evidence
}

// 自证：V2 门禁在 native compaction 未真实通过时不可能放行（也不可被旧证据/宽窗口/自建摘要绕过）。
export function assertNativeCompactionIsBlocking() {
  const caseIndex = v2CaseIndex()
  const findings = []
  const check = (name, ok, detail = '') => {
    findings.push({ name, ok: Boolean(ok), detail })
    return Boolean(ok)
  }

  // 0. 映射必须真的包含 native compaction 三件套，且不含 V2 已取消的用例。
  const r006 = caseIndex['MG-R006'] || []
  check('MG-R006 映射包含 native compaction 三件套', NATIVE_COMPACTION_CASES.every((c) => r006.includes(c)), r006.join(','))
  const cancelledInPlan = Object.values(caseIndex).flat().filter((c) => V2_CANCELLED_CASES.includes(c))
  check('V2 映射不含已取消的 Console 全量用例', cancelledInPlan.length === 0, cancelledInPlan.join(','))

  // 1. 全绿 + 无所有者批准 ⇒ 仍不 ready。
  const green = allGreen(caseIndex)
  const noApproval = evaluateGate({
    evidence: green,
    ownerApproval: false,
    headSha: SYNTHETIC_SHA,
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex,
  })
  check('全绿但无所有者批准 ⇒ ready:false', noApproval.ready === false, noApproval.reason)

  // 2. 全绿 + 所有者批准 ⇒ ready:true（证明放行路径存在，不是永久红灯）。
  const approved = evaluateGate({
    evidence: green,
    ownerApproval: true,
    headSha: SYNTHETIC_SHA,
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex,
  })
  check('全绿且所有者批准 ⇒ ready:true', approved.ready === true, approved.reason)

  // 3. 缺 native-compaction 用例记录 ⇒ 阻断在 MG-R006。
  const missing = evaluateGate({
    evidence: allGreen(caseIndex, { r006: { omitCase: 'native-compaction' } }),
    ownerApproval: true,
    headSha: SYNTHETIC_SHA,
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex,
  })
  check('缺 native-compaction 记录 ⇒ ready:false 且阻断 MG-R006',
    missing.ready === false && missing.failedRequirement === 'MG-R006', missing.failedRequirement + '/' + missing.reason)

  // 4. native-compaction 被 skipped ⇒ 不得计为通过。
  const skipped = evaluateGate({
    evidence: allGreen(caseIndex, { r006: { skipCase: 'native-compaction' } }),
    ownerApproval: true,
    headSha: SYNTHETIC_SHA,
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex,
  })
  check('native-compaction 标 skipped ⇒ ready:false',
    skipped.ready === false && skipped.failedRequirement === 'MG-R006', skipped.failedRequirement + '/' + skipped.reason)

  // 5. 旧 V1 R006 证据（只有旧用例、无 native-compaction）不得让 V2 通过。
  const legacyR006 = {
    status: 'PASS_REAL',
    commitSha: '67b97354ad28a3924607b35a663801f417f14b8e',
    command: 'codex exec (historical)',
    receipt: { traceId: 'legacy-r006' },
    realTarget: true,
    passedAllOnRealTarget: true,
    cases: Object.fromEntries(['same-child-two-tasks', 'context', 'no-duplicate'].map((c) => [c, { passed: true }])),
  }
  const legacy = allGreen(caseIndex, { commitSha: '67b97354ad28a3924607b35a663801f417f14b8e' })
  legacy['MG-R006'] = legacyR006
  const legacyGate = evaluateGate({
    evidence: legacy,
    ownerApproval: true,
    headSha: '67b97354ad28a3924607b35a663801f417f14b8e',
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex,
  })
  check('旧 V1 R006 PASS_REAL 不得满足 V2', legacyGate.ready === false && legacyGate.failedRequirement === 'MG-R006',
    legacyGate.failedRequirement + '/' + legacyGate.reason)

  // 6. 证据绑在别的树 ⇒ stale_evidence。
  const stale = evaluateGate({
    evidence: green,
    ownerApproval: true,
    headSha: 'b'.repeat(40),
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex,
  })
  check('回执 SHA 与当前树不一致 ⇒ stale_evidence', stale.ready === false && stale.requirements.every((r) => r.reason === 'stale_evidence'))

  // 7. V2 已取消的 Console 用例不影响放行（回归：V2 不得重新把全量模型变成阻断）。
  const onlyGo = allGreen(caseIndex)
  const onlyGoGate = evaluateGate({
    evidence: onlyGo,
    ownerApproval: true,
    headSha: SYNTHETIC_SHA,
    requirementIds: V2_REQUIREMENT_IDS,
    caseIndex,
  })
  check('只有 Go 单模型的绿集即可放行（Console 全量不再是阻断）', onlyGoGate.ready === true, onlyGoGate.reason)

  return { ok: findings.every((f) => f.ok), findings }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  const argv = process.argv.slice(2)
  const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
  try {
    if (argv.includes('--assert-native-compaction-blocking')) {
      const result = assertNativeCompactionIsBlocking()
      for (const f of result.findings) {
        console.log((f.ok ? 'PASS ' : 'FAIL ') + f.name + (f.detail ? '（' + f.detail + '）' : ''))
      }
      if (!result.ok) process.exitCode = 1
    } else {
      const sha = argOf('--sha') || currentHeadSha()
      const ownerApproval = argv.includes('--owner-approval')
      const allowNonHead = argv.includes('--replay')
      const evidencePath = argOf('--evidence')
      const diffPath = argOf('--diff')
      const diff = diffPath ? readFileSync(resolve(diffPath), 'utf8') : ''
      let gate
      if (evidencePath) {
        const raw = JSON.parse(readFileSync(resolve(evidencePath), 'utf8'))
        gate = diff
          ? releaseV2({ sha, ownerApproval, evidence: raw, diff, allowNonHead })
          : gateV2({ sha, ownerApproval, evidence: raw, allowNonHead })
      } else {
        gate = gateV2({ sha, ownerApproval })
      }
      process.stdout.write(JSON.stringify(gate, null, 2) + '\n')
    }
  } catch (err) {
    console.error('gate-v2: ERROR ' + err.message)
    process.exitCode = 1
  }
}
