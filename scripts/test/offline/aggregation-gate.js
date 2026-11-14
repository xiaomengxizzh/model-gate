// A5 发布门禁（辅助模块，不是套件）。
//
// 依据：产品契约 §2（五值状态）与执行计划 §I 的 review()：
//   任一需求缺少 `passedAllOnRealTarget` ⇒ {ready:false, status:'BLOCKED', failedRequirement:<id>}
//   全部满足后，仍需 ownerApproval === true 才允许 ready:true。
//
// 与计划伪代码的差别（只收紧，不放宽）：
//   1. `passedAllOnRealTarget` 不能自证。只有 status=PASS_REAL + 完整 SHA + 命令 + 回执 +
//      计划内每个用例都 passed 且未 skipped 时，门禁才承认它。
//   2. PASS_MOCK 携带 `passedAllOnRealTarget:true` 是伪装，直接 BLOCKED（mock_cannot_satisfy_real）。
//   3. 证据中含 token 形状或凭据文件绝对路径 ⇒ 证据无效（不得进入门禁）。
//   4. 传入 headSha 时，回执 SHA 必须等于被测树，否则 stale_evidence（旧证据不得复用，契约 §4）。
//
// 用法：
//   node scripts/test/offline/aggregation-gate.js --baseline                 # 基线证据 → 门禁 JSON
//   node scripts/test/offline/aggregation-gate.js --evidence evidence.json [--sha <sha>] [--owner-approval]
//
// 零依赖、离线；只读仓库内文件。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REQUIREMENT_IDS, TESTED_TREE_SHA, buildMatrix, loadSources } from './aggregation-matrix.js'
import { auditCandidate } from './aggregation-audit.js'

export const STATUS_VOCABULARY = Object.freeze(['NOT_TESTED', 'BLOCKED', 'FAIL', 'PASS_MOCK', 'PASS_REAL'])

// 只匹配“看起来像密钥”的形状；命中只报告种类与字段路径，绝不回显命中值。
const TOKEN_PATTERNS = Object.freeze([
  ['jwt', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
  ['openai-api-key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
])

const CREDENTIAL_FILE = /(?:^|[\\/])(?:auth\.json|credentials?(?:\.json)?|id_rsa|id_ed25519|\.netrc|tokens?\.json)$/i
const CREDENTIAL_DIR = /[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|[\\/]\.docker[\\/]config\.json/i

// 绝对路径（POSIX / ~ / $HOME / Windows 盘符）。相对仓库路径不在此列。
const ABS_PATH = /(?:^|[\s"'`(=,:])((?:~[\\/]|\$HOME[\\/]|\$\{HOME\}[\\/]|\/(?!\/)|[A-Za-z]:[\\/])[^\s"'`()]*)/g

const FULL_SHA = /^[0-9a-f]{40}$/

function walkStrings(value, path, visit) {
  if (typeof value === 'string') { visit(value, path); return }
  if (Array.isArray(value)) { value.forEach((v, i) => walkStrings(v, path + '[' + i + ']', visit)); return }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path + '.' + k, visit)
  }
}

// 返回 [{path, kind}]，不含命中值本身。
export function findSensitive(value, rootPath = '$') {
  const found = []
  walkStrings(value, rootPath, (text, path) => {
    for (const [kind, re] of TOKEN_PATTERNS) {
      if (re.test(text)) found.push({ path, kind })
    }
    for (const m of text.matchAll(ABS_PATH)) {
      const token = m[1]
      if (CREDENTIAL_FILE.test(token) || CREDENTIAL_DIR.test(token)) found.push({ path, kind: 'credential-path' })
    }
  })
  return found
}

// 结构校验：PASS_REAL 必须自带 SHA/命令/回执/真实目标，且计划内每个用例都真实通过。
export function validateEvidence(entry, { requirement = null, cases = [] } = {}) {
  const errors = []
  const push = (code, message) => errors.push({ code, message })

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    push('not_object', 'evidence record must be an object')
    return { ok: false, errors }
  }
  const status = entry.status
  if (!STATUS_VOCABULARY.includes(status)) push('unknown_status', 'status must be one of ' + STATUS_VOCABULARY.join('/'))

  for (const hit of findSensitive(entry)) {
    push('sensitive_value', 'evidence contains ' + hit.kind + ' at ' + hit.path)
  }

  if (status === 'PASS_MOCK' && (entry.realTarget === true || entry.passedAllOnRealTarget === true)) {
    push('mock_claims_real', 'PASS_MOCK cannot claim a real target or a full real pass')
  }

  if (status === 'PASS_REAL') {
    if (!FULL_SHA.test(String(entry.commitSha || ''))) push('missing_commit_sha', 'PASS_REAL requires a full 40-hex commitSha')
    if (typeof entry.command !== 'string' || !entry.command.trim()) push('missing_command', 'PASS_REAL requires a copyable command')
    const r = entry.receipt
    const receiptOk = (typeof r === 'string' && r.trim().length > 0) ||
      (r && typeof r === 'object' && typeof r.traceId === 'string' && r.traceId.trim().length > 0)
    if (!receiptOk) push('missing_receipt', 'PASS_REAL requires a receipt with a traceId')
    if (entry.realTarget !== true) push('missing_real_target', 'PASS_REAL requires realTarget:true')
    if (r && typeof r === 'object' && r.mock === true) push('mock_receipt', 'PASS_REAL receipt is marked mock:true')
    for (const c of cases) {
      const rec = entry.cases && entry.cases[c]
      if (!rec) push('case_missing', 'PASS_REAL must record planned case ' + c)
      else if (rec.passed !== true) push('case_not_passed', 'planned case did not pass: ' + c)
      else if (rec.skipped === true) push('case_skipped', 'skipped case cannot count as passed: ' + c)
    }
  }

  return { ok: errors.length === 0, errors }
}

const STATUS_REASON = Object.freeze({
  NOT_TESTED: 'not_tested',
  BLOCKED: 'blocked_on_prerequisite',
  FAIL: 'failed_on_target',
  PASS_MOCK: 'pass_mock_cannot_release',
})

// 门禁主函数。requirementIds / caseIndex 可注入，便于对逻辑本身做离线验证。
export function evaluateGate({
  evidence = {},
  ownerApproval = false,
  headSha = null,
  requirementIds = REQUIREMENT_IDS,
  caseIndex = {},
} = {}) {
  const rows = []
  for (const id of requirementIds) {
    const entry = evidence[id]
    const planned = caseIndex[id] || []
    const row = { id, status: 'NOT_TESTED', passed: false, reason: 'missing_evidence', detail: '' }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { rows.push(row); continue }

    const status = STATUS_VOCABULARY.includes(entry.status) ? entry.status : 'NOT_TESTED'
    row.status = status

    // 伪装优先判定：状态不是 PASS_REAL 却宣称真实全通过。
    if (entry.passedAllOnRealTarget === true && status !== 'PASS_REAL') {
      row.reason = status === 'PASS_MOCK' ? 'mock_cannot_satisfy_real' : 'status_does_not_support_real_pass'
      row.detail = 'status=' + status + ' but passedAllOnRealTarget:true'
      rows.push(row)
      continue
    }

    if (status !== 'PASS_REAL') {
      row.reason = STATUS_REASON[status] || 'not_tested'
      row.detail = typeof entry.blocker === 'string' ? entry.blocker : ''
      rows.push(row)
      continue
    }

    const verdict = validateEvidence(entry, { requirement: id, cases: planned })
    if (verdict.ok && planned.length === 0) {
      // 计划里没有用例就无法逐项核对；不允许“空计划 = 自动通过”。
      row.reason = 'missing_case_plan'
      row.detail = 'no planned cases for ' + id + '; cannot validate a real pass'
    } else if (!verdict.ok) {
      row.reason = 'invalid_evidence'
      row.detail = verdict.errors.map((e) => e.code).join(',')
    } else if (entry.passedAllOnRealTarget !== true) {
      row.reason = 'real_status_but_not_all_cases_passed'
      row.detail = 'status=PASS_REAL without passedAllOnRealTarget:true'
    } else if (headSha && entry.commitSha !== headSha) {
      row.reason = 'stale_evidence'
      row.detail = 'receipt commitSha ' + entry.commitSha + ' != tested tree ' + headSha
    } else {
      row.passed = true
      row.reason = 'proven_on_real_target'
    }
    rows.push(row)
  }

  const failedRequirements = rows.filter((r) => !r.passed).map((r) => r.id)
  const unmappedEvidence = Object.keys(evidence).filter((id) => !requirementIds.includes(id))

  if (failedRequirements.length) {
    return {
      ready: false,
      status: 'BLOCKED',
      failedRequirement: failedRequirements[0],
      failedRequirements,
      reason: rows.find((r) => !r.passed).reason,
      canAskOwnerToMerge: false,
      ownerApproval: ownerApproval === true,
      headSha,
      requirements: rows,
      unmappedEvidence,
    }
  }
  if (ownerApproval !== true) {
    return {
      ready: false,
      status: 'BLOCKED',
      failedRequirement: null,
      failedRequirements: [],
      reason: 'owner_approval_missing',
      canAskOwnerToMerge: true,
      ownerApproval: false,
      headSha,
      requirements: rows,
      unmappedEvidence,
    }
  }
  return {
    ready: true,
    status: 'PASS_REAL',
    failedRequirement: null,
    failedRequirements: [],
    reason: 'owner_approved',
    canAskOwnerToMerge: true,
    ownerApproval: true,
    headSha,
    requirements: rows,
    unmappedEvidence,
  }
}

// 发布判定 = 门禁 + 反降级审计。审计发现任一硬阻断，release 一律 ready:false。
// 这样“证据看起来全绿、但同一提交在删断言/换 GUI 为 CLI”的候选也过不去。
export function evaluateRelease({
  evidence = {},
  ownerApproval = false,
  headSha = null,
  requirementIds = REQUIREMENT_IDS,
  caseIndex = {},
  diff = '',
  previous = null,
  pinned = {},
} = {}) {
  const gate = evaluateGate({ evidence, ownerApproval, headSha, requirementIds, caseIndex })
  const audit = auditCandidate({ evidence, previous, diff, caseIndex, pinned })
  const blockedByAudit = !audit.ok
  return {
    ...gate,
    ready: gate.ready && !blockedByAudit,
    status: blockedByAudit ? 'BLOCKED' : gate.status,
    reason: blockedByAudit && gate.ready ? 'anti_downgrade_findings' : gate.reason,
    audit,
    auditFindings: audit.findings,
  }
}

// 基线状态 → 证据记录。只搬运事实；不含任何回执，因此不可能被判为 PASS_REAL。
export function evidenceFromBaseline(baselineRows) {
  const evidence = {}
  for (const row of baselineRows) {
    evidence[row.id] = {
      status: row.status,
      commitSha: null,
      command: null,
      receipt: null,
      realTarget: false,
      source: 'docs/evidence/aggregation-baseline-2026-11-14.md §5',
      blocker: row.blocker,
      note: row.evidence,
    }
  }
  return evidence
}

export function gateForBaseline({ sha = TESTED_TREE_SHA, ownerApproval = false } = {}) {
  const sources = loadSources()
  const { caseIndex } = buildMatrix(sources)
  return evaluateGate({
    evidence: evidenceFromBaseline(sources.baseline.rows),
    ownerApproval,
    headSha: sha,
    caseIndex,
  })
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  const argv = process.argv.slice(2)
  const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
  try {
    const sha = argOf('--sha') || TESTED_TREE_SHA
    const ownerApproval = argv.includes('--owner-approval')
    const diffPath = argOf('--diff')
    const diff = diffPath ? readFileSync(resolve(diffPath), 'utf8') : ''
    let gate
    if (argOf('--evidence')) {
      const raw = JSON.parse(readFileSync(resolve(argOf('--evidence')), 'utf8'))
      const { caseIndex } = buildMatrix(loadSources())
      gate = diff
        ? evaluateRelease({ evidence: raw, ownerApproval, headSha: sha, caseIndex, diff })
        : evaluateGate({ evidence: raw, ownerApproval, headSha: sha, caseIndex })
    } else {
      gate = gateForBaseline({ sha, ownerApproval })
    }
    process.stdout.write(JSON.stringify(gate, null, 2) + '\n')
  } catch (err) {
    console.error('gate: ERROR ' + err.message)
    process.exitCode = 1
  }
}
