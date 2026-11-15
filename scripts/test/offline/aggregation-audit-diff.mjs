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

const diff = git(['diff', '--no-color', '--unified=3', mergeBase + '...HEAD'])
const result = auditCandidate({ diff })

console.log('audit-diff: base=' + base + ' merge-base=' + mergeBase.slice(0, 8) + ' head=' + head + ' files-touched=' + result.stats.files)
if (result.ok) {
  console.log('audit-diff: PASS (no anti-downgrade findings)')
} else {
  for (const f of result.findings) console.log('audit-diff: FINDING ' + f.rule + ' @ ' + (f.file || f.where || 'diff') + ' — ' + f.detail)
  console.error('audit-diff: FAIL (' + result.findings.length + ' findings; owner review required)')
  process.exitCode = 1
}
