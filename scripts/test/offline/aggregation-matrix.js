// A5 独立验收矩阵生成器（辅助模块，不是套件）。
//
// 目的：矩阵是“契约 → 人类可读的验收表”的确定性投影，而不是手写的第二份需求。
//   - 需求行：从产品契约 MG-R001..MG-R012 的表格逐字提取（行为 + 必需实测验收）；
//   - 用例列：从执行计划 §I 的 `const matrix = [...]` 解析（P06 冻结映射）；
//   - 状态列：从基线证据 §5 解析（只搬运，不升级；本文不得产生任何 PASS）；
//   - 证据列：A5 编写的 CASE_EVIDENCE（每个用例需要什么原始证据），缺一即生成失败。
//
// 用法：
//   node scripts/test/offline/aggregation-matrix.js            # 打印到 stdout
//   node scripts/test/offline/aggregation-matrix.js --write    # 覆盖 docs/evidence/aggregation-acceptance-matrix.md
//   node scripts/test/offline/aggregation-matrix.js --check    # 与磁盘文件逐字节比对，漂移即退出码 1
//
// 零依赖、离线；只读仓库内文件。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const CONTRACT_PATH = 'docs/product/2026-11-14-owner-product-contract.md'
export const PLAN_PATH = 'docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md'
export const BASELINE_PATH = 'docs/evidence/aggregation-baseline-2026-11-14.md'
export const MATRIX_PATH = 'docs/evidence/aggregation-acceptance-matrix.md'
export const VERDICT_PATH = 'docs/evidence/aggregation-acceptance-verdict-2026-11-14.md'

// 被测树（A5 本轮实际检出的提交）。换 SHA 必须显式改这里并重新生成——旧证据不得复用。
export const TESTED_TREE_SHA = '2f641a975a6345f086aca0d547ab5f0e2523a28c'

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

export function loadSources() {
  const contractText = read(CONTRACT_PATH)
  const planText = read(PLAN_PATH)
  const baselineText = read(BASELINE_PATH)
  const contract = parseContract(contractText)
  const planCases = parsePlanCases(planText)
  const baseline = parseBaseline(baselineText)
  return { contractText, planText, baselineText, contract, planCases, baseline }
}

// 生成结构化矩阵。任何缺失/多余都在这里 fail-fast，避免“少一行就少一个需求”。
export function buildMatrix({ contract, planCases, baseline }) {
  const contractIds = contract.map((r) => r.id)
  if (JSON.stringify(contractIds) !== JSON.stringify(REQUIREMENT_IDS)) {
    throw new Error('contract rows must be exactly MG-R001..MG-R012 in order, got ' + contractIds.join(','))
  }
  const planIds = planCases.map((r) => r.id)
  if (JSON.stringify(planIds) !== JSON.stringify(REQUIREMENT_IDS)) {
    throw new Error('plan §I must map MG-R001..MG-R012 in order, got ' + planIds.join(','))
  }
  const statusById = new Map(baseline.rows.map((r) => [r.id, r]))
  if (statusById.size !== 12) throw new Error('baseline §5 must list 12 requirements, got ' + statusById.size)

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
      baselineEvidence: status.evidence,
      blocker: status.blocker,
    }
  })

  const allCases = Object.values(caseIndex).flat()
  const extra = Object.keys(CASE_EVIDENCE).filter((k) => !allCases.includes(k))
  if (extra.length) throw new Error('CASE_EVIDENCE has entries the plan does not assign: ' + extra.join(','))

  return { rows, caseIndex, baselineCommit: baseline.commit, contractSha256: sha256(JSON.stringify(contract)) }
}

const STATUS_ORDER = ['NOT_TESTED', 'BLOCKED', 'FAIL', 'PASS_MOCK', 'PASS_REAL']

function countStatuses(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]))
  for (const row of rows) {
    if (!(row.status in counts)) throw new Error('unknown status in baseline: ' + row.status)
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
  lines.push('> 本文件由 `node scripts/test/offline/aggregation-matrix.js --write` 从产品契约、执行计划 §I 与基线证据生成，**禁止手工编辑**。')
  lines.push('> `scripts/test/offline/aggregation-acceptance-matrix.test.mjs` 在每次 `npm test` 中重新生成并逐字节比对；手工改动契约、计划或本文件任一方向都会失败。')
  lines.push('')
  lines.push('- 被测树 SHA：`' + TESTED_TREE_SHA + '`')
  lines.push('- 契约来源：`' + CONTRACT_PATH + '`（sha256 `' + sha256(contractText) + '`）')
  lines.push('- 用例映射来源：`' + PLAN_PATH + '` §I（sha256 `' + sha256(planText) + '`）')
  lines.push('- 状态来源：`' + BASELINE_PATH + '` §5，采集于 `' + matrix.baselineCommit + '`（sha256 `' + sha256(baselineText) + '`）；采集点之后到被测树的提交未改动 `src/**`，状态转移成立。')
  lines.push('- 判定口径：契约 §2 的五值状态（`NOT_TESTED` / `BLOCKED` / `FAIL` / `PASS_MOCK` / `PASS_REAL`）；`PASS_MOCK` 永不等于 `PASS_REAL`；真实 Codex GPT 调用只能使用 `gpt-6-luna`。')
  lines.push('- 当前门禁：`ready:false`。逐项原因见 `' + VERDICT_PATH + '`（该文件是本矩阵的证据结论，不是本矩阵的输入）。')
  lines.push('')
  lines.push('## 1. 矩阵')
  lines.push('')
  lines.push('| 需求 | 目标产品行为（契约原文） | 必需实测验收（契约原文） | 计划用例 ID | 每条用例所需证据 | 当前状态 @ `' + short + '` | 阻塞前置 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of matrix.rows) {
    const tests = row.tests.map((t) => '`' + t + '`').join('<br>')
    const evidence = row.evidence.map((e) => '**`' + e.case + '`**：' + e.requires).join('<br>')
    lines.push('| ' + [row.id, row.behavior, row.realAcceptance, tests, evidence, row.status + ' @ `' + short + '`', row.blocker].join(' | ') + ' |')
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
  lines.push('- 本表只记录事实：状态列全部来自基线证据，本文件不产生任何 `PASS_REAL`。')
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
