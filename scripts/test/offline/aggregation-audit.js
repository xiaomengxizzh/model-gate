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
  'assertions-weakened', 'skipped-as-passed', 'requirement-reworded', 'gate-weakened',
])

// 门禁定义文件（V2-00 / A5 F1）：改它们等于改门禁，必须显式人工复核，不能靠"改实现时顺手删断言"过关。
const GATE_FILES = /^(?:scripts\/(?:check-product-contract\.mjs|test\/offline\/aggregation-(?:matrix|gate|audit)(?:-v2)?\.js|test\/offline\/aggregation-acceptance-v2\.test\.mjs|test\/offline\/aggregation-v2-independent-qa\.test\.mjs)|docs\/evidence\/aggregation-v2-status-2026-11-15\.md|test\/offline\/gate-approvals\.json)$/

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

  // 5b. 门禁自身被削弱（V2-00 修复自 A5 F1）：不依赖 src/** 是否被改，
  //     只要同一 diff 在门禁文件里净删行/删断言/删文件，就必须人工复核。
  //     这些文件是"门禁的定义"，改它们等于改门禁，不能与"改实现"混为一谈。
  const gateFiles = files.filter((f) => GATE_FILES.test(f.file))
  const gateRemoved = gateFiles.reduce((n, f) => n + f.removed.length, 0)
  const gateAdded = gateFiles.reduce((n, f) => n + f.added.length, 0)
  const gateRemovedAssertions = gateFiles.reduce((n, f) => n + f.removed.filter((l) => ASSERTION.test(l)).length, 0)
  if (gateFiles.length && gateRemoved > gateAdded) {
    add('gate-weakened', 'diff', 'gate file(s) removed more lines than added (' + gateRemoved + ' > ' + gateAdded + '): ' +
      gateFiles.map((f) => f.file).join(','))
  }
  if (gateFiles.length && gateRemovedAssertions > 0) {
    add('gate-weakened', 'diff', 'gate file(s) removed ' + gateRemovedAssertions + ' assertion line(s); gate assertions may only be moved or strengthened')
  }
  if (gateFiles.some((f) => f.status === 'deleted')) {
    add('gate-weakened', 'diff', 'gate file deleted: ' + gateFiles.filter((f) => f.status === 'deleted').map((f) => f.file).join(','))
  }

  // 6b. 测试里新增 skip
  // 只拦真正"把用例钉成跳过"的写法：`test.skip(` / `skip: true`。
  // `{ skip: <条件> }` 是平台/环境门控（例如非 Linux、无真实凭据），不是把通过当通过，不能误报。
  // 只拦**新增的整条跳过用例**：行首就是 `test.skip(`，或对象里写字面量 `skip: true`。
  // 运行期 `t.skip('root ...')` / `{ skip: <条件> }` 是环境门控，属于如实报告不适用，不是把通过当通过。
  // 注释/说明文本里的 `test.skip(`、`skip: true` 不是"新增跳过用例"，必须先排除，
  // 否则门禁自己的注释就会让 CI 变红（A5 在 d41da77 实测到的自注释误报）。
  // 先剥掉字符串字面量与注释再判定：测试标题、fixture 文本、门禁自己的注释里出现
  // `test.skip(` / `skip: true` 都不是"新增跳过用例"（A5 两轮实测的误报来源）。
  const stripText = (line) => line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  const skipAdded = testFiles.flatMap((f) => f.added
    .map(stripText)
    .filter((l) => /^\s*test\.skip\s*\(/.test(l) || /\bskip\s*:\s*true\b/.test(l))
    .map(() => f.file))
  for (const file of skipAdded) add('skipped-as-passed', file, 'diff adds skip to a test; a skipped case cannot be counted passed')

  // 7. 所有者契约/计划被**改写**才算降级：只追加解释/映射不触发，删改需求行才触发。
  //    V2 矩阵与状态证据是生成物/输入物，由矩阵字节校验、gate-weakened 与 V2 套件守卫，
  //    不在这里按"文档被改"一律阻断（否则每次正常状态更新都会变红）。
  const REQUIREMENT_TOUCH = /MG-R\d{3}|native-compaction|post-compact-followup|context-proof|gpt-6-luna|deepseek-v4\.1-flash/
  const protectedDiff = files.filter((f) => f.file.startsWith('docs/product/') ||
    /^docs\/roadmap\/2026-11-14-(aggregation|go-deepseek-native-compact)/.test(f.file))
  for (const f of protectedDiff) {
    const removedTouching = f.removed.filter((line) => REQUIREMENT_TOUCH.test(line))
    if (!removedTouching.length) continue
    add('requirement-reworded', f.file,
      'owner contract/plan removed or rewrote ' + removedTouching.length + ' requirement line(s); only the owner may approve')
  }

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
