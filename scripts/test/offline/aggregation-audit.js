// A5 反降级审计（辅助模块，不是套件）。
//
// 输入：候选证据记录 + 候选 diff（`git diff` 文本）+ 上一版已签收证据 + 契约哈希。
// 输出：findings（可离线判定的硬阻断）与 manualSteps（必须人工核对的部分）。
//
// 七条规则（与 A5 报告一致）：
//   mock-as-real          PASS_REAL 但回执标记 mock / realTarget 不为 true
//   cli-for-gui           GUI/Desktop 用例用 CLI 结果冒充（契约 §2 明令不得签收）
//   mcp-as-native         原生 Agent Team 用例用 MCP/外部调度器冒充
//   model-count-reduced   聚合目录模型数低于上一版已签收快照，或声称 PASS 但为 0
//   assertions-weakened   同一 diff 里改 src 又只删断言/删测试文件
//   skipped-as-passed     skip 用例被计为 passed，或在测试里新增 skip
//   requirement-reworded  契约/路线图被改动，或契约哈希与钉住值不符
//
// 零依赖、离线；只读传入数据（契约文本可选，缺省从仓库读）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACT_PATH, ROOT, buildMatrix, loadSources } from './aggregation-matrix.js'

export const AUDIT_RULE_IDS = Object.freeze([
  'mock-as-real', 'cli-for-gui', 'mcp-as-native', 'model-count-reduced',
  'assertions-weakened', 'skipped-as-passed', 'requirement-reworded',
])

// 仓库内脚本无法证明的部分：必须由人类复核并在 PR 里附证据。
export const MANUAL_AUDIT_STEPS = Object.freeze([
  '核对 GUI 截图/录屏确实来自原版 ChatGPT Desktop 窗口（窗口标题、进程、非浏览器 mock 页）',
  '用上游服务端日志交叉核对回执 traceId（开发者本机日志可被伪造，单边证据不够）',
  '人工比对原生日志中的 parent/child thread id 与 spawn 事件，确认不是 MCP 或外部调度器',
  '核对所有者书面批准记录（PR 评论/签名），而不是代理自述“已获授权”',
  '核对 GPT-6 Luna 的账户资格与额度归属（账户页面），确认没有其他 GPT 模型被调用',
  '核对第二个测试身份的独立创建记录，确认不是同一账户的第二个 Key',
  '把契约与基线文件与所有者控制的只读快照比对；仓库内脚本不构成真正防篡改',
])

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const GUI_CASE = /^(?:gui-|desktop-)/
const NATIVE_CASE = /^(?:native-|same-child-|interrupt$|resume$|context$|no-duplicate$)/

export function parseUnifiedDiff(text) {
  const files = []
  let cur = null
  for (const line of String(text || '').split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (header) {
      cur = { file: header[2], status: 'modified', added: [], removed: [] }
      files.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) cur.added.push(line.slice(1))
    else if (line.startsWith('-')) cur.removed.push(line.slice(1))
  }
  return files
}

const ASSERTION = /\bassert(?:\.\w+)?\s*\(|\bok\s*\(|\bexpect\s*\(/

function defaultCaseIndex() {
  try { return buildMatrix(loadSources()).caseIndex } catch { return {} }
}

function defaultContractText() {
  try { return readFileSync(join(ROOT, CONTRACT_PATH), 'utf8') } catch { return null }
}

export function auditCandidate({
  evidence = {},
  previous = null,
  diff = '',
  caseIndex = null,
  contractText = null,
  pinned = {},
} = {}) {
  const index = caseIndex || defaultCaseIndex()
  const findings = []
  const add = (rule, subject, detail) => findings.push({ rule, severity: 'block', subject, detail })

  for (const [id, entry] of Object.entries(evidence)) {
    if (!entry || typeof entry !== 'object') continue
    const planned = index[id] || []
    const cases = entry.cases && typeof entry.cases === 'object' ? entry.cases : {}

    // 1. mock 冒充真实
    if (entry.status === 'PASS_REAL') {
      const receipt = entry.receipt
      if (entry.realTarget !== true) add('mock-as-real', id, 'PASS_REAL without realTarget:true')
      if (receipt && typeof receipt === 'object' && receipt.mock === true) add('mock-as-real', id, 'PASS_REAL receipt marked mock:true')
      if (typeof entry.command === 'string' && /\bmock\b/i.test(entry.command) && entry.realTarget !== true) {
        add('mock-as-real', id, 'command targets a mock but evidence claims PASS_REAL')
      }
    }

    // 2. CLI 冒充 GUI / Desktop
    if (entry.status === 'PASS_REAL') {
      for (const c of planned.filter((n) => GUI_CASE.test(n))) {
        const rec = cases[c]
        if (rec && typeof rec.client === 'string' && rec.client !== 'desktop-gui') {
          add('cli-for-gui', id, c + ' recorded client=' + rec.client + ', GUI requires desktop-gui')
        }
      }
      if (entry.client === 'codex-cli' && planned.some((n) => GUI_CASE.test(n))) {
        add('cli-for-gui', id, 'requirement has GUI cases but evidence client=codex-cli')
      }
    }

    // 3. MCP / 外部调度器冒充原生
    if (entry.status === 'PASS_REAL') {
      if (entry.receipt && typeof entry.receipt === 'object' && /^(?:mcp|external-scheduler)$/i.test(String(entry.receipt.nativeEngine || ''))) {
        add('mcp-as-native', id, 'receipt nativeEngine=' + entry.receipt.nativeEngine)
      }
      for (const c of planned.filter((n) => NATIVE_CASE.test(n))) {
        const rec = cases[c]
        if (rec && typeof rec.engine === 'string' && rec.engine !== 'codex-native') {
          add('mcp-as-native', id, c + ' recorded engine=' + rec.engine + ', native requires codex-native')
        }
      }
    }

    // 4. 模型数量缩减
    const count = entry.catalog && Number.isFinite(entry.catalog.modelCount) ? entry.catalog.modelCount : null
    if (count !== null && entry.status === 'PASS_REAL' && count === 0) {
      add('model-count-reduced', id, 'PASS_REAL with modelCount=0')
    }
    const before = previous && previous[id] && previous[id].catalog ? previous[id].catalog.modelCount : null
    if (count !== null && Number.isFinite(before) && count < before) {
      add('model-count-reduced', id, 'modelCount dropped from ' + before + ' to ' + count)
    }

    // 6. skip 计为 passed
    for (const [c, rec] of Object.entries(cases)) {
      if (rec && rec.passed === true && rec.skipped === true) add('skipped-as-passed', id, c + ' is skipped but counted passed')
    }
  }

  const files = parseUnifiedDiff(diff)
  const srcTouched = files.some((f) => f.file.startsWith('src/') && f.status !== 'deleted')
  const testFiles = files.filter((f) => f.file.startsWith('scripts/test/'))
  const removedAssertions = testFiles.reduce((n, f) => n + f.removed.filter((l) => ASSERTION.test(l)).length, 0)
  const addedAssertions = testFiles.reduce((n, f) => n + f.added.filter((l) => ASSERTION.test(l)).length, 0)

  // 5. 同一 diff 改源码 + 只删断言 / 删测试文件
  if (srcTouched && removedAssertions > 0 && addedAssertions === 0) {
    add('assertions-weakened', 'diff', 'src/** changed while ' + removedAssertions + ' assertion line(s) were removed and none added')
  }
  if (srcTouched && testFiles.some((f) => f.status === 'deleted')) {
    add('assertions-weakened', 'diff', 'src/** changed while a test file was deleted: ' + testFiles.filter((f) => f.status === 'deleted').map((f) => f.file).join(','))
  }

  // 6b. 测试里新增 skip
  const skipAdded = testFiles.flatMap((f) => f.added.filter((l) => /\.skip\s*\(|skip\s*:\s*true|\{\s*skip\s*:/.test(l)).map((l) => f.file))
  for (const file of skipAdded) add('skipped-as-passed', file, 'diff adds skip to a test; a skipped case cannot be counted passed')

  // 7. 契约/路线图被改
  const protectedDiff = files.filter((f) => f.file.startsWith('docs/product/') || /^docs\/roadmap\/2026-11-14-aggregation/.test(f.file))
  for (const f of protectedDiff) add('requirement-reworded', f.file, 'contract/roadmap file modified; only the owner may approve requirement changes')

  if (pinned.contractSha256) {
    const text = typeof contractText === 'string' ? contractText : defaultContractText()
    if (text === null) add('requirement-reworded', CONTRACT_PATH, 'contract file is missing; cannot verify pinned hash')
    else if (sha256(text) !== pinned.contractSha256) {
      add('requirement-reworded', CONTRACT_PATH, 'contract sha256 differs from pinned ' + pinned.contractSha256)
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    manualSteps: MANUAL_AUDIT_STEPS,
    stats: { files: files.length, srcTouched, removedAssertions, addedAssertions, skipAdded: skipAdded.length },
  }
}

export { sha256 as auditSha256 }
