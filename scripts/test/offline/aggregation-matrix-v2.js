// V2 独立验收矩阵生成器（辅助模块，不是套件）。
//
// 与 V1 生成器（aggregation-matrix.js）的关系：
//   - V1 仍是**历史快照**的所有者：它继续逐字节守卫 docs/evidence/aggregation-acceptance-matrix.md，
//     任何对 V1 契约/计划/证据/矩阵的改动都会在 V1 套件里失败。V2 不写 V1 的任何文件。
//   - V2 是本轮**当前门禁**的唯一来源：契约 = docs/product/2026-11-14-owner-scope-v2.md，
//     用例映射 = V2 计划 §2.1（V2-MATRIX-BEGIN/END 之间，P00 冻结），
//     状态 = V2 状态文档 + 历史证据文档（冲突必须显式 `取代 <旧状态> @ <旧文档>`）。
//   - 复用 V1 的合并/冲突/引用校验逻辑（单一实现，不复制第二套口径）。
//
// 诚实性硬约束（生成失败，而不是降级）：
//   - 12 条 MG-R 必须与 V2 契约逐字对应且顺序一致；
//   - 计划 §2.1 必须映射全部 12 条，且 MG-R006 必须包含 native-compaction 三件套；
//   - V2 已取消的 Console 全量用例不得出现在 V2 映射的**阻断**用例里（它们只存在于 V1 历史）；
//   - 本文件永不产生 PASS_REAL。
//
// 用法：
//   node scripts/test/offline/aggregation-matrix-v2.js            # 打印到 stdout
//   node scripts/test/offline/aggregation-matrix-v2.js --write    # 写 docs/evidence/aggregation-acceptance-matrix-v2.md
//   node scripts/test/offline/aggregation-matrix-v2.js --check    # 与磁盘文件逐字节比对，漂移即退出码 1
//
// 零依赖、离线；只读仓库内文件。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  REQUIREMENT_IDS,
  STATUS_ORDER,
  mergeEvidenceStatuses,
  parseContract,
  parseEvidenceStatuses,
  parseTestedTreeSha,
} from './aggregation-matrix.js'

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const CONTRACT_PATH_V2 = 'docs/product/2026-11-14-owner-scope-v2.md'
export const PLAN_PATH_V2 = 'docs/roadmap/2026-11-14-go-deepseek-native-compact-plan.md'
export const STATUS_PATH_V2 = 'docs/evidence/aggregation-v2-status-2026-11-15.md'
export const MATRIX_PATH_V2 = 'docs/evidence/aggregation-acceptance-matrix-v2.md'

// 历史证据仍然参与合并：它们解释每条状态从哪来，且任何冲突都必须显式写「取代」标记。
export const LEGACY_EVIDENCE_PATHS = Object.freeze([
  'docs/evidence/aggregation-native-real-2026-11-14.md',
  'docs/evidence/aggregation-real-luna-2026-11-14.md',
  'docs/evidence/aggregation-integration-2026-11-14.md',
  'docs/evidence/agg-p01-opencode-discovery-2026-11-14.md',
])

export const V2_EVIDENCE_PATHS = Object.freeze([STATUS_PATH_V2, ...LEGACY_EVIDENCE_PATHS])

// V2 明确取消的用例：只允许出现在 V1 历史里，不得成为 V2 阻断项。
export const V2_CANCELLED_CASES = Object.freeze([
  'all-opencode-console-models',
  'all-opencode-go-models',
  'desktop-model-picker-console',
  'refresh-diff',
  'catalog-not-truncated',
  'unsupported-tool-fails-explicitly',
  'no-silent-fallback',
  'same-child-two-tasks',
  'context',
])

// MG-R006 的 V2 不可跳过用例：压缩必须由 Codex 原生执行，压缩后同一子代理继续。
export const NATIVE_COMPACTION_CASES = Object.freeze([
  'native-compaction',
  'post-compact-followup',
  'context-proof',
])

// 每个 V2 用例需要的原始证据。这是 A5 的验收判断，不是实现声明。
export const CASE_EVIDENCE_V2 = Object.freeze({
  'gui-activate': '原版 GUI 操作 + `/api/aggregation/activate` 回执（consentToken、configVersion、traceId）+ 写前预览',
  'gui-deactivate': 'GUI 退出操作 + 回滚回执 + 恢复后字节级 diff 为空',
  restart: '重启进程后 `status()` 仍为 aggregation，目录版本与激活时一致',
  'codex-official-login-unchanged': '前后 `auth.json` 元数据（mtime/size/sha256，不读内容）+ 同一 account 身份',
  'official-gpt-6-luna-real': '脱敏请求收据 `model=gpt-6-luna`、`authDomain=codex-subscription`、上游 200 回执',
  'go-deepseek-auth-real': 'Go 凭据授权成功回执（凭据不进日志），失败时为 typed error 且不换供应商',
  'go-deepseek-inference-real': '真实 Go 上游推理 200 回执，`model=deepseek-v4.1-flash`，客户端与出站一致',
  'model-id-exact': '目录公共 ID ↔ 真实模型名 ↔ 出站 model 三者一致；无别名漂移',
  'desktop-picker-gpt': '原版 Desktop 选择器截图 + 该模型请求回执 provider=chatgpt-official',
  'desktop-picker-deepseek': '原版 Desktop 选择器截图 + `deepseek-v4.1-flash` 请求回执 provider=opencode-go',
  'native-child-thread-not-mcp': '原生日志含 parent thread id 与 child thread id，且无 MCP/外部调度请求',
  'native-tools': '子代理真实工具调用与结果回执（退出码 + 输出摘要）',
  'native-tool': 'DeepSeek 子代理真实工具调用与结果回执（退出码 + 输出摘要）',
  'same-child-followup': '同一 childId 的两轮任务回执（追派而非新建子代理）',
  interrupt: '取消请求 → 单一终态 `interrupted/cancelled` + 上游取消回执，无重复终态',
  'native-compaction': '真实发生 Codex 原生压缩的事件回执：`owner=codex`、终态成功、历史未丢；网关无 summarize/裁剪路径',
  'post-compact-followup': '压缩后同一 childId 继续任务并复述压缩前工具标记',
  'context-proof': '压缩后入参仍包含压缩前的关键上下文（工具标记/任务约束），无静默历史丢失',
  resume: '恢复后沿用同一 childId 并完成任务的回执',
  'no-duplicates': '上游请求计数 = 派单数（无重放、无重复派单）',
  'fresh-install-no-manual-edit': '空白 HOME 全流程录屏；除产品写入外无任何 TOML 手改',
  'existing-config-preserve': '已有手改配置 → 三方 diff + 变更前后逐字节对比',
  'no-silent-model-fallback': '强制上游失败；响应为 typed error，且模型/供应商/协议三者未变',
  'no-silent-tool-drop': '不支持的工具返回精确错误码，不静默丢弃或降级',
  'no-silent-compaction-drop': '压缩项不被支持时必须显式失败（typed error），不得 drop 后假成功',
  'typed-error': '错误带稳定 code + 目标供应商/模型/请求 id，可归因',
  'request-identity': '请求收据含 host/path/model/authDomain，跨域不串用',
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

// V2 计划 §2.1：V2-MATRIX-BEGIN/END 之间的 {id:"MG-Rxxx", tests:[...]}。
export function parseV2PlanCases(text) {
  const begin = text.indexOf('V2-MATRIX-BEGIN')
  const end = text.indexOf('V2-MATRIX-END')
  if (begin < 0 || end < begin) throw new Error('V2 plan has no V2-MATRIX-BEGIN/END frozen case map')
  const block = text.slice(begin, end)
  const rows = []
  for (const m of block.matchAll(/\{id:"(MG-R\d{3})",\s*tests:\[([^\]]*)\]\}/g)) {
    const tests = m[2].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
    rows.push({ id: m[1], tests })
  }
  return rows
}

export function loadV2Sources() {
  const contractText = read(CONTRACT_PATH_V2)
  const planText = read(PLAN_PATH_V2)
  const contract = parseContract(contractText)
  const planCases = parseV2PlanCases(planText)
  const evidence = V2_EVIDENCE_PATHS.map((docPath) => {
    const text = read(docPath)
    return {
      docPath,
      text,
      sha: safeSha(text, docPath),
      rows: parseEvidenceStatuses(text, docPath),
    }
  })
  return { contractText, planText, contract, planCases, evidence }
}

function safeSha(text, docPath) {
  try { return parseTestedTreeSha(text, docPath) } catch { return null }
}

// V2 门禁基线树：来自 V2 状态文档的「被测树 SHA」。缺失即失败，绝不复用旧常量。
export const V2_BASELINE_SHA = parseTestedTreeSha(read(STATUS_PATH_V2), STATUS_PATH_V2)

export function buildV2Matrix({ contract, planCases, evidence }) {
  const contractIds = contract.map((r) => r.id)
  if (JSON.stringify(contractIds) !== JSON.stringify(REQUIREMENT_IDS)) {
    throw new Error('V2 contract rows must be exactly MG-R001..MG-R012 in order, got ' + contractIds.join(','))
  }
  const planIds = planCases.map((r) => r.id)
  if (JSON.stringify(planIds) !== JSON.stringify(REQUIREMENT_IDS)) {
    throw new Error('V2 plan §2.1 must map MG-R001..MG-R012 in order, got ' + planIds.join(','))
  }
  if (!Array.isArray(evidence) || evidence.length < 2) throw new Error('V2 statuses must merge the V2 status doc with historical evidence')

  // V2 已取消的用例不得出现在任何 V2 映射里（只用来说明"它们不再是阻断"）。
  for (const row of planCases) {
    const cancelled = row.tests.filter((t) => V2_CANCELLED_CASES.includes(t))
    if (cancelled.length) {
      throw new Error(row.id + ' still maps V2-cancelled case(s): ' + cancelled.join(',') + '（V2 只保留 Go 单模型与原生压缩）')
    }
  }
  const r006 = planCases.find((p) => p.id === 'MG-R006')
  for (const must of NATIVE_COMPACTION_CASES) {
    if (!r006 || !r006.tests.includes(must)) {
      throw new Error('V2 MG-R006 must include native compaction case ' + must + '（不得用调大窗口/自建摘要绕过）')
    }
  }

  const statusById = mergeEvidenceStatuses(evidence)
  const caseIndex = {}
  const rows = contract.map((c) => {
    const planned = planCases.find((p) => p.id === c.id).tests
    const missing = planned.filter((t) => !CASE_EVIDENCE_V2[t])
    if (missing.length) throw new Error(c.id + ' V2 case(s) without evidence definition: ' + missing.join(','))
    caseIndex[c.id] = planned
    const status = statusById.get(c.id)
    return {
      id: c.id,
      behavior: c.behavior,
      realAcceptance: c.realAcceptance,
      tests: planned,
      evidence: planned.map((t) => ({ case: t, requires: CASE_EVIDENCE_V2[t] })),
      status: status.status,
      statusBasis: status.basis,
      statusSource: status.docPath,
      statusSuites: status.suites,
      superseded: status.superseded || [],
    }
  })

  const allCases = Object.values(caseIndex).flat()
  const extra = Object.keys(CASE_EVIDENCE_V2).filter((k) => !allCases.includes(k))
  if (extra.length) throw new Error('V2 CASE_EVIDENCE has entries the plan does not assign: ' + extra.join(','))

  return {
    rows,
    caseIndex,
    contractSha256: sha256(JSON.stringify(contract)),
    testedTreeSha: V2_BASELINE_SHA,
    evidenceDocs: evidence.map((e) => ({ docPath: e.docPath, sha: e.sha, rowCount: e.rows.length })),
  }
}

function countStatuses(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]))
  for (const row of rows) {
    if (!(row.status in counts)) throw new Error('unknown V2 status: ' + row.status)
    counts[row.status]++
  }
  return counts
}

// 状态单元格：PASS_REAL 必须显示它**实际绑定的树**（A5 F4：旧树回执不得显示成当前树）。
function statusCell(row, short) {
  if (row.status !== 'PASS_REAL') return row.status + ' @ `' + short + '`'
  const pinned = (String(row.statusBasis).match(/\b[0-9a-f]{40}\b/) || [])[0]
  if (!pinned) return row.status + ' @ `' + short + '`（未绑定树）'
  const label = pinned.slice(0, 8)
  return pinned.slice(0, 8) === short
    ? row.status + ' @ `' + label + '`'
    : row.status + ' @ `' + label + '`（旧树回执，当前树未复测）'
}

export function renderV2Markdown({ contractText, planText, matrix }) {
  const counts = countStatuses(matrix.rows)
  const caseCount = Object.values(matrix.caseIndex).flat().length
  const statusLine = STATUS_ORDER.map((s) => '`' + s + '` ' + counts[s]).join('、')
  const short = matrix.testedTreeSha.slice(0, 8)
  const lines = []
  lines.push('# ModelGate V2 验收矩阵（Go DeepSeek 单模型 + Codex 原生压缩）')
  lines.push('')
  lines.push('> 本文件由 `node scripts/test/offline/aggregation-matrix-v2.js --write` 从 V2 产品契约、V2 计划 §2.1（冻结用例映射）与**证据文档状态表**生成，**禁止手工编辑**。')
  lines.push('> `scripts/test/offline/aggregation-acceptance-v2.test.mjs` 在每次 `npm test` 中重新生成并逐字节比对。V1 历史矩阵 `docs/evidence/aggregation-acceptance-matrix.md` 保持逐字节冻结，仅作溯源。')
  lines.push('')
  lines.push('- V2 门禁基线树：`' + matrix.testedTreeSha + '`（来自 `' + STATUS_PATH_V2 + '` 的「被测树 SHA」字段；**不是**任何 PASS_REAL 的绑定树）')
  lines.push('- 契约来源：`' + CONTRACT_PATH_V2 + '`（sha256 `' + sha256(contractText) + '`）')
  lines.push('- 用例映射来源：`' + PLAN_PATH_V2 + '` §2.1（sha256 `' + sha256(planText) + '`）')
  lines.push('- 状态来源：' + matrix.evidenceDocs.map((d) => '`' + d.docPath + '`（' + d.rowCount + ' 行）').join('、') + '；冲突必须显式 `取代 <旧状态> @ <旧文档>`。')
  lines.push('- 状态口径：`NOT_TESTED` / `BLOCKED` / `FAIL` / `PASS_MOCK` / `PASS_REAL`；`PASS_REAL` 必须绑定完整 40 位 SHA，换树即失效。')
  const realRows = matrix.rows.filter((r) => r.status === 'PASS_REAL')
  const realDetail = realRows.length
    ? realRows.map((r) => {
      const pinned = (String(r.statusBasis).match(/\b[0-9a-f]{40}\b/) || [])[0]
      const V1_TREES = ['67b97354', '4feafe0e']
      const tag = !pinned ? '（未绑树）'
        : pinned.slice(0, 8) === short ? '（当前基线树）'
          : V1_TREES.includes(pinned.slice(0, 8)) ? '（V1 旧树回执，当前树未复测）'
            : '（绑定树 ' + pinned.slice(0, 8) + '，非本表基线）'
      return r.id + (pinned ? '@' + pinned.slice(0, 8) : '') + tag
    }).join('、')
    : '无'
  const failRows = matrix.rows.filter((r) => r.status === 'FAIL')
  const firstBlocked = matrix.rows.find((r) => r.status === 'BLOCKED')
  const blocker = failRows.length
    ? '`' + failRows[0].id + '`（状态 FAIL，依据见该行）；同批 FAIL：' + failRows.map((r) => '`' + r.id + '`').join('、')
    : (firstBlocked ? '`' + firstBlocked.id + '`（BLOCKED）' : '无 FAIL/BLOCKED 行，但仍需逐项 PASS_REAL 与所有者批准')
  lines.push('- 当前门禁：`ready:false`（12 项中 ' + counts.PASS_REAL + ' 项 `PASS_REAL`：' + realDetail + '）。首个产品级阻断是 ' + blocker + '。')
  lines.push('')
  lines.push('## 1. 矩阵')
  lines.push('')
  lines.push('| 需求 | 目标产品行为（V2 契约原文） | 必需实测验收（V2 契约原文） | V2 用例 ID | 每条用例所需证据 | 当前状态 @ `' + short + '` | 状态依据（证据原文） |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of matrix.rows) {
    const tests = row.tests.map((t) => '`' + t + '`').join('<br>')
    const evidence = row.evidence.map((e) => '**`' + e.case + '`**：' + e.requires).join('<br>')
    lines.push('| ' + [row.id, row.behavior, row.realAcceptance, tests, evidence, statusCell(row, short), row.statusBasis].join(' | ') + ' |')
  }
  lines.push('')
  lines.push('## 2. 汇总')
  lines.push('')
  lines.push('- 需求：' + matrix.rows.length + '；V2 用例：' + caseCount)
  lines.push('- 状态分布：' + statusLine)
  lines.push('- 结论：V2 发布门禁 `ready:false`。`MG-R006` 的 `native-compaction` / `post-compact-followup` / `context-proof` 未真实通过前，任何“聚合已完成”的声明都不成立。')
  lines.push('')
  lines.push('## 3. V2 相对 V1 的范围差异（只看差异，不改要求强度）')
  lines.push('')
  lines.push('- 取消：OpenCode Console 全量发现/对账、Anthropic/Google 全量协议转换、20 条不可路由模型适配（这些用例不再出现在 V2 映射里）。')
  lines.push('- 新增必达：Codex **原生**压缩真实发生、压缩后同子代理继续并记得压缩前标记；网关不得自建摘要/裁剪。')
  lines.push('- 不变：GUI 一键聚合、ChatGPT 套餐保留、原生 Agent Team、隔离/回滚、证据纪律、GPT 仅 `gpt-6-luna`。')
  lines.push('')
  return lines.join('\n')
}

export function generateV2() {
  const sources = loadV2Sources()
  const matrix = buildV2Matrix(sources)
  return { ...sources, matrix, markdown: renderV2Markdown({ ...sources, matrix }) }
}

export function writeV2Matrix() {
  const { markdown } = generateV2()
  writeFileSync(join(ROOT, MATRIX_PATH_V2), markdown, 'utf8')
  return markdown
}

export function readV2MatrixFile() {
  return readFileSync(join(ROOT, MATRIX_PATH_V2), 'utf8')
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  const argv = process.argv.slice(2)
  try {
    if (argv.includes('--write')) {
      writeV2Matrix()
      console.log('wrote ' + MATRIX_PATH_V2)
    } else if (argv.includes('--check')) {
      const fresh = generateV2().markdown
      const disk = readV2MatrixFile()
      if (fresh === disk) console.log('matrix-v2: PASS (byte-identical to generated)')
      else {
        console.error('matrix-v2: FAIL (' + MATRIX_PATH_V2 + ' drifted from generator)')
        process.exitCode = 1
      }
    } else {
      process.stdout.write(generateV2().markdown)
    }
  } catch (err) {
    console.error('matrix-v2: ERROR ' + err.message)
    process.exitCode = 1
  }
}
