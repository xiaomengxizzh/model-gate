// A5 独立验收矩阵生成器（辅助模块，不是套件）。
//
// 目的：矩阵是“契约 → 人类可读的验收表”的确定性投影，而不是手写的第二份需求。
//   - 需求行：从产品契约 MG-R001..MG-R012 的表格逐字提取（行为 + 必需实测验收）；
//   - 用例列：从执行计划 §I 的 `const matrix = [...]` 解析（P06 冻结映射）；
//   - 状态列：从**证据文档**的状态表解析（整合报告 §8 + P01 §5），不再硬编码；
//     多份证据对同一需求必须给出一致状态，冲突即生成失败（禁止矩阵与报告互相矛盾）；
//   - 被测树 SHA：从证据文档的「被测树 SHA」字段解析，不再硬编码常量；
//   - 证据列：A5 编写的 CASE_EVIDENCE（每个用例需要什么原始证据），缺一即生成失败。
//
// 诚实性硬约束（生成失败，而不是降级）：
//   - 状态只允许契约 §2 的五值；`PASS(...)` / `N/A` 之类词汇一律拒绝；
//   - `PASS_MOCK` 行必须在「依据」里点名至少一个**存在且已登记**的离线套件
//     （`scripts/test/offline/*.test.mjs`），否则视为把未执行的用例写成通过；
//   - 本文件永不产生 `PASS_REAL`：真实目标上的状态只能由真实回执与门禁上调。
//
// 用法：
//   node scripts/test/offline/aggregation-matrix.js            # 打印到 stdout
//   node scripts/test/offline/aggregation-matrix.js --write    # 覆盖 docs/evidence/aggregation-acceptance-matrix.md
//   node scripts/test/offline/aggregation-matrix.js --check    # 与磁盘文件逐字节比对，漂移即退出码 1
//
// 零依赖、离线；只读仓库内文件。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SUITES } from '../run.mjs'

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const CONTRACT_PATH = 'docs/product/2026-11-14-owner-product-contract.md'
export const PLAN_PATH = 'docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md'
export const BASELINE_PATH = 'docs/evidence/aggregation-baseline-2026-11-14.md'
export const MATRIX_PATH = 'docs/evidence/aggregation-acceptance-matrix.md'
export const VERDICT_PATH = 'docs/evidence/aggregation-acceptance-verdict-2026-11-14.md'

// 状态证据来源（顺序即「最新在前」，用于读取被测树 SHA）。
// 只收录**当前状态**文档：基线/结论文档描述的是历史快照，不能拿来覆盖今天的状态。
export const EVIDENCE_STATUS_DOCS = Object.freeze([
  'docs/evidence/aggregation-real-luna-2026-11-14.md',
  'docs/evidence/aggregation-integration-2026-11-14.md',
  'docs/evidence/agg-p01-opencode-discovery-2026-11-14.md',
])

export const STATUS_ORDER = Object.freeze(['NOT_TESTED', 'BLOCKED', 'FAIL', 'PASS_MOCK', 'PASS_REAL'])

export const REQUIREMENT_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, i) => 'MG-R' + String(i + 1).padStart(3, '0')),
)

// 每个计划用例需要的原始证据。这是 A5 的验收判断，不是实现声明。
export const CASE_EVIDENCE = Object.freeze({
  'gui-activate': '原版 GUI 录屏 + `/api/aggregation/activate` 回执（consentToken、configVersion、traceId）+ 写前预览',
  'gui-deactivate': 'GUI 退出录屏 + 回滚回执 + 恢复后字节级 diff 为空',
  restart: '重启进程后 `status()` 仍为 aggregation，目录版本与激活时一致',
  'codex-official-login-unchanged': '前后 `auth.json` 元数据（mtime/size/sha256，不读内容）+ 同一 account 身份',
  'official-gpt-6-luna-real': '脱敏请求收据 `model=gpt-6-luna`、`authDomain=codex-subscription`、上游 200 回执',
  'all-opencode-console-models': '真实目录快照（分页穷尽）↔ GUI/Desktop 清单双向对账，缺一即 FAIL',
  'all-opencode-go-models': 'Go 真实目录快照 ↔ 清单对账；`mg-opencodego-*` 公共 ID 字节兼容',
  'refresh-diff': '`/sync` 回执 added/removed/updated 与上游变更逐项一致',
  'desktop-model-picker-official': '原版 Desktop 选择器截图 + 该模型请求回执 provider=chatgpt-official',
  'desktop-model-picker-go': '原版 Desktop 选择器截图 + 该模型请求回执 provider=opencode-go',
  'desktop-model-picker-console': '原版 Desktop 选择器截图 + 该模型请求回执 provider=opencode-console',
  'native-child-thread-not-mcp': '原生日志含 parent thread id 与 child thread id，且无 MCP/外部调度请求',
  'native-tools': '子代理真实工具调用与结果回执（退出码 + 输出摘要）',
  'same-child-two-tasks': '同一 childId 的两轮任务回执',
  interrupt: '取消请求 → 终态 `cancelled` + 上游取消回执',
  resume: '恢复后沿用同一 childId 并完成任务的回执',
  context: '第二轮输入包含第一轮 tool/agent_message 上下文',
  'no-duplicate': '上游请求计数 = 派单数（无重放、无重复派单）',
  'fresh-install-no-manual-edit': '空白 HOME 全流程录屏；除产品写入外无任何 TOML 手改',
  'existing-config-preserve': '已有手改配置 → 三方 diff + 变更前后逐字节对比',
  'no-silent-fallback': '强制上游失败；响应为 typed error，且模型/供应商/协议三者未变',
  'unsupported-tool-fails-explicitly': '不支持工具返回精确错误码，不静默丢弃或降级',
  'catalog-not-truncated': '`modelCount` == 上游授权模型数；目录超限时本地目录仍完整',
  'two-user-isolation': '两个测试身份跨租户读/写/刷新均 403/404',
  'token-rotation': '轮换后旧 Key 失效、新 Key 生效，无跨用户串用',
  'redacted-logs': '全量日志扫描无 token/cookie/authorization 值',
  'rollback-byte-compatible': '回滚后配置 sha256 与导入前一致',
  'crash-recovery': '写事务中 SIGKILL，重启后自动恢复到一致状态',
  'conflict-409': '并发写触发 409 + `currentVersion`，UI 展示三方 diff',
  'receipts-pin-sha': '每条回执含本次 commit SHA + 可复制命令 + 环境',
  'mock-vs-real-accuracy': '同一用例 mock 与 real 的差异登记（有损字段单列）',
  'codex-gpt-parent-only-luna': '父请求收据 `model=gpt-6-luna`',
  'no-gpt-fallback': '负向收据：无其他 GPT 模型请求，无自动回退',
})

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

// 契约表格：| ID | 目标产品行为 | 必需实测验收 |
export function parseContract(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*(MG-R\d{3})\s*\|(.*)\|(.*)\|\s*$/)
    if (!m) continue
    rows.push({ id: m[1], behavior: m[2].trim(), realAcceptance: m[3].trim() })
  }
  return rows
}

// 执行计划 §I：{id:"MG-R001", tests:["gui-activate", ...]}
export function parsePlanCases(text) {
  const rows = []
  for (const m of text.matchAll(/\{id:"(MG-R\d{3})",\s*tests:\[([^\]]*)\]\}/g)) {
    const tests = m[2].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
    rows.push({ id: m[1], tests })
  }
  return rows
}

// 基线证据 §5：仍是门禁 gateForBaseline() 的输入，但**不再**是矩阵状态的来源。
export function parseBaseline(text) {
  const start = text.indexOf('## 5.')
  const end = text.indexOf('## 6.')
  if (start < 0 || end < start) throw new Error('baseline §5 not found')
  const section = text.slice(start, end)
  const commit = (text.match(/基线固定提交（merge commit）：`([0-9a-f]{7,40})`/) || [])[1] || ''
  const rows = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*(MG-R\d{3})[^|]*\|([^|]*)\|([^|]*)\|([^|]*)\|/)
    if (!m) continue
    rows.push({
      id: m[1],
      status: m[2].trim(),
      evidence: m[3].trim(),
      blocker: m[4].trim(),
    })
  }
  return { commit, rows }
}

// 证据文档里的被测树 SHA（必须是完整 40 位）。缺字段即失败：不得回退到任何硬编码值。
export function parseTestedTreeSha(text, docPath = '') {
  const m = text.match(/被测树\s*SHA\**\s*[：:]\s*`([0-9a-f]{40})`/i)
  if (!m) throw new Error('evidence doc ' + docPath + ' lacks a 40-hex 被测树 SHA field')
  return m[1]
}

function cellsOf(line) {
  const parts = line.split('|')
  // 去掉首尾两个空片段（行以 | 开头/结尾）
  return parts.slice(1, parts.length - 1).map((s) => s.trim())
}

// 证据文档的状态表：标题形如「## 8. MG-R 诚实状态（整合后）」「## 5. 需求状态」。
// 返回 [{ id, status, basis, suites, docPath }]；词汇不在五值内直接失败（F5 的口径）。
export function parseEvidenceStatuses(text, docPath = '') {
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\d+\.\s*(?:MG-R\s*)?(?:诚实状态|需求状态)/.test(lines[i])) { start = i; break }
  }
  if (start < 0) throw new Error('evidence doc ' + docPath + ' has no status section (## N. 诚实状态 / ## N. 需求状态)')
  const rows = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break
    if (!line.startsWith('|')) continue
    const cells = cellsOf(line)
    if (!cells.length || !/^MG-R\d{3}\b/.test(cells[0])) continue
    if (cells.length < 3) throw new Error('evidence row in ' + docPath + ' has < 3 columns: ' + line)
    const id = cells[0].match(/^MG-R\d{3}/)[0]
    const rawStatus = cells[1].replace(/[`*]/g, '').trim()
    const token = (rawStatus.match(/^[A-Z_]+/) || [''])[0]
    if (!STATUS_ORDER.includes(token)) {
      throw new Error('evidence doc ' + docPath + ' uses invalid status `' + rawStatus + '` for ' + id + '（只允许 ' + STATUS_ORDER.join('/') + '）')
    }
    const basis = cells.slice(2).join(' | ').trim()
    rows.push({ id, status: token, basis, suites: citedSuites(basis), docPath })
  }
  if (!rows.length) throw new Error('evidence doc ' + docPath + ' status section has no MG-R rows')
  return rows
}

// 「依据」里点名的离线套件：`xxx.test.mjs` 形式（不带目录的裸文件名）。
function citedSuites(basis) {
  return [...String(basis).matchAll(/`([a-z0-9][a-z0-9-]*\.test\.mjs)`/g)].map((m) => m[1])
}

function suitePath(name) { return 'scripts/test/offline/' + name }

function assertCitedSuites(row) {
  for (const name of row.suites) {
    const rel = suitePath(name)
    if (!existsSync(join(ROOT, rel))) {
      throw new Error(row.id + ' cites a suite that does not exist: ' + rel + '（' + row.docPath + '）')
    }
    if (!SUITES.includes(rel)) {
      throw new Error(row.id + ' cites a suite that is not registered in scripts/test/run.mjs: ' + rel)
    }
  }
}

// 较新文档是否显式声明取代了旧状态：`取代 <旧状态> @ <旧文档相对路径>`（路径逐字匹配）。
export function supersedes(basis, oldStatus, oldDocPath) {
  const escaped = String(oldDocPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('取代\\s*' + oldStatus + '\\s*@\\s*' + escaped).test(String(basis))
}

function mergeEvidenceStatuses(docs) {
  const byId = new Map()
  for (const doc of docs) {
    for (const row of doc.rows) {
      if (!REQUIREMENT_IDS.includes(row.id)) throw new Error('evidence doc ' + doc.docPath + ' has unknown requirement ' + row.id)
      assertCitedSuites(row)
      if (row.status === 'PASS_MOCK' || row.status === 'PASS_REAL') {
        if (!row.suites.length) {
          throw new Error(row.id + ' is ' + row.status + ' but cites no offline suite（' + row.docPath + '）：PASS_MOCK 只能用于离线套件真正执行过的行为')
        }
      }
      // PASS_REAL 必须把结论钉到具体被测树：依据里出现完整 40 位 SHA，否则视为未绑定版本的声明。
      if (row.status === 'PASS_REAL' && !/[0-9a-f]{40}/.test(row.basis)) {
        throw new Error(row.id + ' is PASS_REAL but its basis does not pin a full 40-hex commit SHA（' + row.docPath + '）')
      }
      const prev = byId.get(row.id)
      if (!prev) { byId.set(row.id, row); continue }
      if (prev.status !== row.status) {
        // 旧文档是某一轮的快照，可能被最新证据取代；但取代必须显式写在**较新**文档的依据里，
        // 否则仍按"矩阵与报告各说一套"失败（禁止静默改口径）。
        // 标记格式：`取代 <旧状态> @ <旧文档相对路径>`，路径逐字比对。
        if (!supersedes(prev.basis, row.status, row.docPath)) {
          throw new Error('证据文档互相矛盾：' + row.id + ' = ' + prev.status + ' @ ' + prev.docPath + ' vs ' + row.status + ' @ ' + row.docPath +
            '（若确为最新证据取代旧快照，请在较新文档的依据里写明「取代 ' + row.status + ' @ ' + row.docPath + '」）')
        }
        // 显式取代：保留最新（prev），并把被取代的事实留在依据文本里供人工复核。
        prev.superseded = [...(prev.superseded || []), { status: row.status, docPath: row.docPath }]
        continue
      }
      // 同一状态：合并套件引用，保留首份依据（最新文档在前）。
      prev.suites = [...new Set([...prev.suites, ...row.suites])]
    }
  }
  for (const id of REQUIREMENT_IDS) {
    if (!byId.has(id)) throw new Error('no evidence status for ' + id + ' in ' + docs.map((d) => d.docPath).join(', '))
  }
  return byId
}

export function loadSources() {
  const contractText = read(CONTRACT_PATH)
  const planText = read(PLAN_PATH)
  const baselineText = read(BASELINE_PATH)
  const contract = parseContract(contractText)
  const planCases = parsePlanCases(planText)
  const baseline = parseBaseline(baselineText)
  const evidence = EVIDENCE_STATUS_DOCS.map((docPath) => {
    const text = read(docPath)
    return { docPath, text, sha: safeSha(text, docPath), rows: parseEvidenceStatuses(text, docPath) }
  })
  return { contractText, planText, baselineText, contract, planCases, baseline, evidence }
}

function safeSha(text, docPath) {
  try { return parseTestedTreeSha(text, docPath) } catch { return null }
}

// 被测树 SHA：来自证据文档，而不是常量。缺失即失败（宁可生成失败，也不复用旧 SHA）。
export const TESTED_TREE_SHA = parseTestedTreeSha(read(EVIDENCE_STATUS_DOCS[0]), EVIDENCE_STATUS_DOCS[0])

// 生成结构化矩阵。任何缺失/多余都在这里 fail-fast，避免“少一行就少一个需求”。
export function buildMatrix({ contract, planCases, baseline, evidence }) {
  const contractIds = contract.map((r) => r.id)
  if (JSON.stringify(contractIds) !== JSON.stringify(REQUIREMENT_IDS)) {
    throw new Error('contract rows must be exactly MG-R001..MG-R012 in order, got ' + contractIds.join(','))
  }
  const planIds = planCases.map((r) => r.id)
  if (JSON.stringify(planIds) !== JSON.stringify(REQUIREMENT_IDS)) {
    throw new Error('plan §I must map MG-R001..MG-R012 in order, got ' + planIds.join(','))
  }
  if (!Array.isArray(evidence) || !evidence.length) throw new Error('matrix statuses must be derived from evidence documents (none supplied)')
  const statusById = mergeEvidenceStatuses(evidence)

  const caseIndex = {}
  const rows = contract.map((c) => {
    const planned = planCases.find((p) => p.id === c.id).tests
    caseIndex[c.id] = planned
    const status = statusById.get(c.id)
    const missing = planned.filter((t) => !CASE_EVIDENCE[t])
    if (missing.length) throw new Error(c.id + ' case(s) without evidence definition: ' + missing.join(','))
    return {
      id: c.id,
      behavior: c.behavior,
      realAcceptance: c.realAcceptance,
      tests: planned,
      evidence: planned.map((t) => ({ case: t, requires: CASE_EVIDENCE[t] })),
      status: status.status,
      statusBasis: status.basis,
      statusSource: status.docPath,
      statusSuites: status.suites,
    }
  })

  const allCases = Object.values(caseIndex).flat()
  const extra = Object.keys(CASE_EVIDENCE).filter((k) => !allCases.includes(k))
  if (extra.length) throw new Error('CASE_EVIDENCE has entries the plan does not assign: ' + extra.join(','))

  return {
    rows,
    caseIndex,
    baselineCommit: baseline && baseline.commit ? baseline.commit : '',
    contractSha256: sha256(JSON.stringify(contract)),
    testedTreeSha: TESTED_TREE_SHA,
    evidenceDocs: evidence.map((e) => ({ docPath: e.docPath, sha: e.sha, rowCount: e.rows.length })),
  }
}

function countStatuses(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]))
  for (const row of rows) {
    if (!(row.status in counts)) throw new Error('unknown status: ' + row.status)
    counts[row.status]++
  }
  return counts
}

export function renderMarkdown({ contractText, planText, baselineText, matrix }) {
  const counts = countStatuses(matrix.rows)
  const caseCount = Object.values(matrix.caseIndex).flat().length
  const statusLine = STATUS_ORDER.map((s) => '`' + s + '` ' + counts[s]).join('、')
  const short = TESTED_TREE_SHA.slice(0, 8)

  const lines = []
  lines.push('# ModelGate 聚合模式独立验收矩阵（MG-R001..MG-R012）')
  lines.push('')
  lines.push('> 本文件由 `node scripts/test/offline/aggregation-matrix.js --write` 从产品契约、执行计划 §I 与**证据文档的状态表**生成，**禁止手工编辑**。')
  lines.push('> `scripts/test/offline/aggregation-acceptance-matrix.test.mjs` 在每次 `npm test` 中重新生成并逐字节比对；手工改动契约、计划、证据状态或本文件任一方向都会失败。')
  lines.push('')
  lines.push('- 被测树 SHA：`' + TESTED_TREE_SHA + '`（来自 ' + EVIDENCE_STATUS_DOCS[0] + ' 的「被测树 SHA」字段，生成器不再保存常量）')
  lines.push('- 契约来源：`' + CONTRACT_PATH + '`（sha256 `' + sha256(contractText) + '`）')
  lines.push('- 用例映射来源：`' + PLAN_PATH + '` §I（sha256 `' + sha256(planText) + '`）')
  lines.push('- 状态来源：' + matrix.evidenceDocs.map((d) => '`' + d.docPath + '`（' + d.rowCount + ' 行）').join('、') +
    '；多份证据对同一需求必须一致。旧轮次快照被新证据取代时，较新文档的依据必须显式写出 `取代 <旧状态> @ <旧文档路径>`，否则生成失败（禁止静默改口径）。')
  lines.push('- 状态口径：契约 §2 的五值（`NOT_TESTED` / `BLOCKED` / `FAIL` / `PASS_MOCK` / `PASS_REAL`）；`PASS_MOCK` 只用于**离线套件真正执行过**的行为，且每行都在「状态依据」里点名已登记的套件。')
  lines.push('- 历史基线：`' + BASELINE_PATH + '` §5（采集于 `' + matrix.baselineCommit + '`，sha256 `' + sha256(baselineText) + '`）只说明当时的起点，不是本表当前状态的来源。')
  lines.push('- 当前门禁：`ready:false`（12 项中 1 项 `PASS_REAL`）。逐项原因见 `' + VERDICT_PATH + '`（该文件是当前结论，不是本矩阵的输入）。')
  lines.push('')
  lines.push('## 1. 矩阵')
  lines.push('')
  lines.push('| 需求 | 目标产品行为（契约原文） | 必需实测验收（契约原文） | 计划用例 ID | 每条用例所需证据 | 当前状态 @ `' + short + '` | 状态依据（证据原文） |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of matrix.rows) {
    const tests = row.tests.map((t) => '`' + t + '`').join('<br>')
    const evidence = row.evidence.map((e) => '**`' + e.case + '`**：' + e.requires).join('<br>')
    lines.push('| ' + [row.id, row.behavior, row.realAcceptance, tests, evidence, row.status + ' @ `' + short + '`', row.statusBasis].join(' | ') + ' |')
  }
  lines.push('')
  lines.push('## 2. 汇总')
  lines.push('')
  lines.push('- 需求：' + matrix.rows.length + '；计划用例：' + caseCount)
  lines.push('- 状态分布：' + statusLine)
  lines.push('- 结论：发布门禁 `ready:false`。一项需求缺少真实目标上的 `PASS_REAL`，其所在行都不能视为完成；`NOT_TESTED` 不是通过，`PASS_MOCK` 不是通过，`BLOCKED` 必须在授权后重测。')
  lines.push('')
  lines.push('## 3. 不可判定即不可发布')
  lines.push('')
  lines.push('- 本表只记录事实：状态列全部来自证据文档的状态表，本文件不产生任何 `PASS_REAL`。')
  lines.push('- 每条结论必须绑定 commit SHA + 可复制命令 + 脱敏回执（契约 §4）；代码或测试变化后旧证据不得复用。')
  lines.push('- 任何“已通过”声明若在本表无对应 `PASS_REAL` 行与回执，按未通过处理。')
  lines.push('')
  return lines.join('\n')
}

export function generate() {
  const sources = loadSources()
  const matrix = buildMatrix(sources)
  return { ...sources, matrix, markdown: renderMarkdown({ ...sources, matrix }) }
}

export function writeMatrix() {
  const { markdown } = generate()
  writeFileSync(join(ROOT, MATRIX_PATH), markdown, 'utf8')
  return markdown
}

export function readMatrixFile() {
  return readFileSync(join(ROOT, MATRIX_PATH), 'utf8')
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  const argv = process.argv.slice(2)
  try {
    if (argv.includes('--write')) {
      writeMatrix()
      console.log('wrote ' + MATRIX_PATH)
    } else if (argv.includes('--check')) {
      const fresh = generate().markdown
      const disk = readMatrixFile()
      if (fresh === disk) {
        console.log('matrix: PASS (byte-identical to generated)')
      } else {
        console.error('matrix: FAIL (docs/evidence/aggregation-acceptance-matrix.md drifted from generator)')
        process.exitCode = 1
      }
    } else {
      process.stdout.write(generate().markdown)
    }
  } catch (err) {
    console.error('matrix: ERROR ' + err.message)
    process.exitCode = 1
  }
}
