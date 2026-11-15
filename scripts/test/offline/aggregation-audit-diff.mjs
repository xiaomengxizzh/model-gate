// 反降级审计的 CI 入口（A5 复核结论：规则存在但没接到 diff 上）。
//
//   node scripts/test/offline/aggregation-audit-diff.mjs --base main
//
// 取 `git diff <merge-base(base, HEAD)>...HEAD` 跑 auditCandidate()：
//   · 删断言 / 删测试文件 / 净删门禁代码 → gate-weakened
//   · 改契约、V2 计划、V2 矩阵、V2 状态证据 → requirement-reworded
//   · 新增 skip、mock 冒充真实等 → 对应规则
// 取不到 base（浅克隆、ref 不存在）一律 fail-closed（exit 1）：无法核对就不放行。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditCandidate } from './aggregation-audit.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

function resolveBase(requested) {
  const candidates = [requested]
  if (!requested.includes('/')) candidates.push('origin/' + requested)
  for (const ref of candidates) {
    try {
      git(['rev-parse', '--verify', ref])
      return ref
    } catch { /* 继续尝试下一个 */ }
  }
  return null
}

const requested = argOf('--base') || process.env.GITHUB_BASE_REF || 'main'
const base = resolveBase(requested)
if (!base) {
  console.error('audit-diff: FAIL (cannot resolve base ref `' + requested + '`; fetch the base branch or pass --base). Fail-closed: an unverifiable diff cannot be approved.')
  process.exit(1)
}

let head = 'HEAD'
try { head = git(['rev-parse', '--short', 'HEAD']).trim() } catch { /* keep HEAD */ }

let mergeBase = ''
try {
  mergeBase = git(['merge-base', base, 'HEAD']).trim()
} catch (error) {
  console.error('audit-diff: FAIL (no merge-base between ' + base + ' and HEAD: ' + String(error && error.message).slice(0, 200) + ')')
  process.exit(1)
}

const headCommit = git(['rev-parse', 'HEAD']).trim()
if (mergeBase === headCommit) {
  console.error('audit-diff: FAIL (base resolves to HEAD: the change set is empty, so this PASS would be meaningless; pass the real base branch)')
  process.exit(1)
}

const allCommits = process.argv.includes('--all-commits')

// 逐提交审计（A5 P1）：只对 base...HEAD 的总 diff 审计时，**同一 PR 内新增**的门禁/测试文件
// 后续被弱化是看不见的（净 diff 全是新增）。--all-commits 把范围内每个提交的自身 diff 都过一遍。
function commitDiffs(from, to) {
  const shas = git(['rev-list', '--reverse', from + '..' + to]).split('\n').filter(Boolean)
  return shas.map((sha) => {
    let diff = ''
    try { diff = git(['diff', '--no-color', '--unified=3', sha + '^', sha]) } catch { diff = '' }
    return { sha, diff }
  })
}

const slices = allCommits
  ? commitDiffs(mergeBase, 'HEAD')
  : [{ sha: 'HEAD', diff: git(['diff', '--no-color', '--unified=3', mergeBase + '...HEAD']) }]

// 显式批准清单：门禁文件的历史改动必须有人书面批准，写在仓库里（可见、可审计），
// 而不是让规则失效或让人工绕过 CI。清单本身也属于受保护门禁文件。
const APPROVALS_PATH = new URL('./gate-approvals.json', import.meta.url)
let approvals = []
try {
  approvals = JSON.parse(readFileSync(APPROVALS_PATH, 'utf8'))
  if (!Array.isArray(approvals)) throw new Error('approvals must be an array')
} catch (error) {
  console.error('audit-diff: FAIL (cannot read gate-approvals.json: ' + String(error && error.message).slice(0, 200) + ')')
  process.exit(1)
}
const approvedFor = (sha, rule) => approvals.find((a) => a && a.rule === rule && String(a.sha).toLowerCase() === String(sha).toLowerCase().slice(0, String(a.sha).length))

const findings = []
const approvedFindings = []
let filesTouched = 0
for (const slice of slices) {
  const result = auditCandidate({ diff: slice.diff })
  filesTouched += result.stats.files
  for (const f of result.findings) {
    const hit = approvedFor(slice.sha, f.rule)
    if (hit) approvedFindings.push({ sha: slice.sha, rule: f.rule, approver: hit.approver, reason: hit.reason })
    else findings.push({ sha: slice.sha, ...f })
  }
}

console.log('audit-diff: base=' + base + ' merge-base=' + mergeBase.slice(0, 8) + ' head=' + head +
  ' mode=' + (allCommits ? 'all-commits(' + slices.length + ')' : 'range') + ' files-touched=' + filesTouched)
for (const a of approvedFindings) {
  console.log('audit-diff: APPROVED ' + a.rule + ' [' + String(a.sha).slice(0, 8) + '] by ' + a.approver + ' — ' + a.reason)
}
if (!findings.length) {
  console.log('audit-diff: PASS (no unapproved anti-downgrade findings)')
} else {
  for (const f of findings) {
    console.log('audit-diff: FINDING ' + f.rule + ' @ ' + (f.subject || f.file || 'diff') + ' [' + String(f.sha).slice(0, 8) + '] — ' + f.detail)
  }
  console.error('audit-diff: FAIL (' + findings.length + ' findings; owner review required)')
  process.exitCode = 1
}
