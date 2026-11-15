// A5 独立黑箱验收（V2）：只从**文件与协议事实**断言，不 import Lead 的生成器/门禁实现。
//
// 设计原则（独立于实现）：
//   1. 契约、计划 §2.1、状态文档、矩阵文档一律按**文本**解析；门禁只按 CLI JSON 观测（黑箱），
//      不读取其导出函数。这样 Lead 重写内部实现不会让本套件失去独立性。
//   2. 不产生任何 PASS_REAL：本套件只验证“门禁是否足够严格”，不代替真实回执。
//   3. 缺失的 V2 产物按**失败**处理并给出明确原因（P00 未落地就是阻断，不是 skip）。
//   4. 允许白名单：协议侧对 compaction 的显式识别（透传/typed error/lossy 记录）不是“自建压缩”；
//      白名单条目必须写明理由，且只能排除**误报**，不能排除真实实现。
//
// 单跑：
//   node --test scripts/test/offline/aggregation-v2-independent-qa.test.mjs
//
// 零依赖、离线；只读仓库内文件（门禁 CLI 只读文件、无网络）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const CONTRACT_V2 = 'docs/product/2026-11-14-owner-scope-v2.md'
const PLAN_V2 = 'docs/roadmap/2026-11-14-go-deepseek-native-compact-plan.md'
const START_V2 = 'docs/roadmap/2026-11-14-go-deepseek-native-compact-start.md'
const STATUS_V2 = 'docs/evidence/aggregation-v2-status-2026-11-15.md'
const MATRIX_V2 = 'docs/evidence/aggregation-acceptance-matrix-v2.md'
const GATE_V2 = 'scripts/test/offline/aggregation-gate-v2.js'
const MATRIX_JS_V2 = 'scripts/test/offline/aggregation-matrix-v2.js'

// V1 历史（必须逐字节保留、不得改写；本套件只读）。
const V1_MATRIX = 'docs/evidence/aggregation-acceptance-matrix.md'
const V1_NATIVE = 'docs/evidence/aggregation-native-real-2026-11-14.md'
// 2026-11-15 冻结时的 V1 字节指纹：任何改写都应让本套件失败（历史不得漂移）。
const V1_PINNED_SHA256 = Object.freeze({
  [V1_MATRIX]: '2de6d149824edeedb74fdba9adb8424e25b3e2cd854d085f5cf2865bd44cf68a',
  [V1_NATIVE]: 'ad9e0cd84a8fd60c9ea9e9d16f7dcfb2bd99569e4065dcd24d66c81676f40bfe',
})

// V1 真实回执绑定的历史树：V2 的 R006 PASS_REAL 不得只绑这些树（旧证据不能自动继承）。
const V1_TESTED_TREES = Object.freeze([
  '67b97354ad28a3924607b35a663801f417f14b8e',
  '4feafe0e51dc02d48c45734df5b34e70d3679bd5',
])

// V2 明确取消的 Console 全量模型用例（只允许存在于 V1 历史）。
const CANCELLED_CASES = Object.freeze([
  'all-opencode-console-models',
  'all-opencode-go-models',
  'desktop-model-picker-console',
])
// V2 MG-R006 不可跳过的原生压缩三件套。
const NATIVE_COMPACTION_CASES = Object.freeze([
  'native-compaction',
  'post-compact-followup',
  'context-proof',
])

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const rel = (p) => join(ROOT, p)
const read = (p, why) => {
  assert.ok(existsSync(rel(p)), '缺少 V2 必需文件：' + p + (why ? '（' + why + '）' : ''))
  return readFileSync(rel(p), 'utf8')
}
const readIfExists = (p) => (existsSync(rel(p)) ? readFileSync(rel(p), 'utf8') : null)

// —— 文本解析（独立实现，不复用生成器） ——

// 契约/矩阵表格行：| MG-Rxxx | 行为 | 验收 |
function parseMgRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*(MG-R\d{3})\s*\|(.*)\|(.*)\|\s*$/)
    if (!m) continue
    rows.push({ id: m[1], behavior: m[2].trim(), acceptance: m[3].trim() })
  }
  return rows
}

// 计划 §2.1：V2-MATRIX-BEGIN/END 之间的 {id:"MG-Rxxx", tests:[...]}。
function parsePlanMatrix(planText) {
  const begin = planText.indexOf('V2-MATRIX-BEGIN')
  const end = planText.indexOf('V2-MATRIX-END')
  assert.ok(begin >= 0 && end > begin, 'V2 计划缺少 §2.1 的 V2-MATRIX-BEGIN/END 冻结映射块')
  const block = planText.slice(begin, end)
  const rows = []
  for (const m of block.matchAll(/\{id:"(MG-R\d{3})",\s*tests:\[([^\]]*)\]\}/g)) {
    const tests = m[2]
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
    rows.push({ id: m[1], tests })
  }
  return rows
}

// 证据状态表（## N. 需求状态 / ## N. 诚实状态）。
function parseStatusRows(text, docPath) {
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\d+\.\s*(?:MG-R\s*)?(?:诚实状态|需求状态)/.test(lines[i])) {
      start = i
      break
    }
  }
  assert.ok(start >= 0, docPath + ' 缺少「## N. 需求状态」表')
  const rows = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((s) => s.trim())
    if (!cells.length || !/^MG-R\d{3}\b/.test(cells[0])) continue
    const id = cells[0].match(/^MG-R\d{3}/)[0]
    const status = cells[1].replace(/[`*]/g, '').trim().split(/\s+/)[0]
    rows.push({ id, status, basis: cells.slice(2).join(' | ').trim() })
  }
  return rows
}

// 从一段文本里抽取所有 V2 用例 ID（反引号内的用例名）。
function extractCaseIds(text) {
  const known = new Set([
    'gui-activate', 'gui-deactivate', 'restart',
    'codex-official-login-unchanged', 'official-gpt-6-luna-real',
    'go-deepseek-auth-real', 'go-deepseek-inference-real', 'model-id-exact',
    'desktop-picker-gpt', 'desktop-picker-deepseek',
    'native-child-thread-not-mcp', 'native-tools', 'native-tool',
    'same-child-followup', 'interrupt', 'native-compaction', 'post-compact-followup',
    'context-proof', 'resume', 'no-duplicates',
    'fresh-install-no-manual-edit', 'existing-config-preserve',
    'no-silent-model-fallback', 'no-silent-tool-drop', 'no-silent-compaction-drop',
    'typed-error', 'request-identity',
    'two-user-isolation', 'token-rotation', 'redacted-logs',
    'rollback-byte-compatible', 'crash-recovery', 'conflict-409',
    'receipts-pin-sha', 'mock-vs-real-accuracy',
    'codex-gpt-parent-only-luna', 'no-gpt-fallback',
    // V1 历史/取消项
    'all-opencode-console-models', 'all-opencode-go-models', 'desktop-model-picker-console',
    'desktop-model-picker-official', 'desktop-model-picker-go', 'refresh-diff',
    'same-child-two-tasks', 'context', 'no-duplicate', 'catalog-not-truncated',
    'unsupported-tool-fails-explicitly', 'no-silent-fallback',
  ])
  const out = new Set()
  for (const m of text.matchAll(/`([a-z][a-z0-9-]+)`/g)) {
    if (known.has(m[1])) out.add(m[1])
  }
  return out
}

// —— 1. 契约完整性 ——

test('V2 契约：MG-R001..MG-R012 齐全、顺序固定、关键措辞可追踪', () => {
  const text = read(CONTRACT_V2, 'V2 所有者范围是当前唯一验收依据')
  const rows = parseMgRows(text)
  const expected = Array.from({ length: 12 }, (_, i) => 'MG-R' + String(i + 1).padStart(3, '0'))
  assert.deepEqual(rows.map((r) => r.id), expected, 'V2 契约必须恰好 12 条且按 MG-R001..012 顺序')
  for (const row of rows) {
    assert.ok(row.behavior.length > 5, row.id + ' 目标行为为空')
    assert.ok(row.acceptance.length > 5, row.id + ' 必需实测验收为空')
  }
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.match(byId['MG-R003'].behavior, /deepseek-v4\.1-flash/, 'MG-R003 必须锁定 Go 目标模型')
  assert.match(byId['MG-R003'].behavior, /只强制支持/, 'MG-R003 必须写明“只强制支持”')
  assert.match(byId['MG-R006'].behavior, /原生/, 'MG-R006 必须要求 Codex 原生行为')
  assert.match(byId['MG-R006'].behavior, /压缩/, 'MG-R006 必须要求压缩')
  assert.match(byId['MG-R006'].behavior, /压缩后继续工作/, 'MG-R006 必须是“压缩后继续工作”')
  assert.match(byId['MG-R012'].behavior, /仅允许/, 'MG-R012 必须是“仅允许”')
  // 契约行内同时允许 `gpt-6-luna` 与展示写法 `GPT-6 Luna`。
  assert.match(byId['MG-R012'].behavior + ' ' + byId['MG-R012'].acceptance, /gpt-6-luna|GPT-6 Luna/i,
    'MG-R012 必须锁定 GPT-6 Luna')
  // 契约自己必须声明 V1 矩阵只是历史、R006 真实压缩未通过。
  assert.match(text, /V1 历史快照/, '契约必须声明 V1 矩阵是历史快照')
  assert.match(text, /MG-R006[^\n]{0,80}尚未通过/, '契约必须声明 MG-R006 真实压缩尚未通过')
  assert.match(text, /网关不得自建\s*summarize/, '契约必须保留“网关不得自建 summarize”的禁令原文')
})

test('V2 契约：R005 明确禁用 MCP/自建代理，压缩归属 Codex 核心', () => {
  const text = read(CONTRACT_V2)
  assert.match(text, /MG-R005[^\n]{0,200}不用\s*MCP\/自建代理替代/, 'MG-R005 必须保留禁用 MCP/自建代理')
  assert.match(text, /压缩机制归属/, '契约必须单列“压缩机制归属”')
  assert.match(text, /由 Codex 核心选择和执行其原生压缩机制/, '压缩必须由 Codex 核心归属')
  assert.match(text, /不得自建 summarize、LLM 历史压缩 API、摘要缓存、后台截断任务或自行重写历史/,
    '压缩禁令必须逐项列出：summarize / LLM 压缩 API / 摘要缓存 / 后台截断 / 重写历史')
})

// —— 2. 计划 §2.1 冻结映射 ——

test('V2 计划 §2.1：12 行用例映射冻结，R006 含 native compaction 三件套', () => {
  const plan = read(PLAN_V2, 'V2 执行计划是 P00 冻结映射的来源')
  const rows = parsePlanMatrix(plan)
  const expected = Array.from({ length: 12 }, (_, i) => 'MG-R' + String(i + 1).padStart(3, '0'))
  assert.deepEqual(rows.map((r) => r.id), expected, '§2.1 必须按 MG-R001..012 映射全部 12 条')
  const r006 = rows.find((r) => r.id === 'MG-R006')
  for (const must of NATIVE_COMPACTION_CASES) {
    assert.ok(r006.tests.includes(must), 'MG-R006 的 V2 映射必须包含不可跳过用例 ' + must)
  }
  // 三条 native compaction 用例缺一不可；其余 R006 用例也不得被删空。
  assert.ok(r006.tests.length >= 8, 'MG-R006 的 V2 用例数明显少于计划（可能被删减）')
  // 每条都必须有至少一个用例。
  for (const row of rows) assert.ok(row.tests.length > 0, row.id + ' 的 V2 用例映射为空')
})

test('V2 计划 §4/§7：原生压缩验收与 P05 停止条件写死“不能用调大窗口/自建摘要”', () => {
  const plan = read(PLAN_V2)
  // §0 判定边界：旧 R006 PASS_REAL 只是历史状态，V2 必须含压缩实测。
  assert.match(plan, /V1 矩阵标出的 R006 `PASS_REAL` 仅为旧用例历史状态/, '必须声明旧 R006 PASS_REAL 只是历史')
  // §4：压缩验收函数必须断言 Codex 归属、同一子代理、压缩前标记。
  assert.match(plan, /evt\.owner === "codex"/, '§4 必须断言压缩 owner 是 codex')
  assert.match(plan, /COMPACT_BEFORE_OK/, '§4 必须记录压缩前标记并在压缩后回忆')
  assert.match(plan, /child\.id === result\.childId/, '§4 必须断言压缩后仍是同一子代理')
  // §4 禁令。
  assert.match(plan, /禁止.*ModelGate\.summarize\(\)/, '§4 必须明令禁止 ModelGate.summarize()')
  assert.match(plan, /按 token 进行历史裁剪/, '§4 必须明令禁止按 token 裁剪历史')
  assert.match(plan, /默认关闭自动压缩/, '§4 必须禁止“默认关闭自动压缩”')
  // §7 P05 停止条件：R006 必须含 native compaction 实测，R003 只需 DeepSeek。
  assert.match(plan, /MG-R006` 必须包含 native compaction 实测后才允许 PASS_REAL/, '§7 必须写死 R006 放行条件')
  assert.match(plan, /MG-R003` 只需 DeepSeek 而不是 80 个 OpenCode 模型/, '§7 必须写死 R003 只要 DeepSeek')
})

// —— 3. 已取消的 Console 全量用例不再阻断 ——

test('V2 已取消的 Console 全量模型用例不再出现在 V2 阻断清单', () => {
  const plan = read(PLAN_V2)
  const rows = parsePlanMatrix(plan)
  const v2Cases = new Set(rows.flatMap((r) => r.tests))
  for (const cancelled of CANCELLED_CASES) {
    assert.ok(!v2Cases.has(cancelled), 'V2 §2.1 仍在阻断已取消用例：' + cancelled)
  }
  // V2 矩阵文档（若已生成）同样不得把取消项列为阻断。
  const matrixV2 = readIfExists(MATRIX_V2)
  if (matrixV2 !== null) {
    const matrixCases = extractCaseIds(matrixV2)
    for (const cancelled of CANCELLED_CASES) {
      assert.ok(!matrixCases.has(cancelled), 'V2 矩阵文档仍列出已取消用例：' + cancelled)
    }
    assert.ok(matrixCases.has('native-compaction'), 'V2 矩阵文档必须列出 native-compaction 用例')
  }
  // V1 历史矩阵必须仍能证明这些用例曾经存在（不得抹除历史）。
  const v1 = read(V1_MATRIX)
  for (const cancelled of CANCELLED_CASES) {
    assert.ok(v1.includes('`' + cancelled + '`') || v1.includes(cancelled), 'V1 历史矩阵被改写，丢失：' + cancelled)
  }
})

// —— 4. V1 历史冻结 ——

test('V1 历史证据逐字节冻结：R006 旧 PASS_REAL 与 unsupported_input_item 失败记录仍在', () => {
  for (const [p, sha] of Object.entries(V1_PINNED_SHA256)) {
    const text = read(p)
    assert.equal(sha256(text), sha, p + ' 被改写（V1 历史必须逐字节保留）')
  }
  const v1Matrix = read(V1_MATRIX)
  const v1R006Line = v1Matrix.split('\n').find((line) => /^\|\s*MG-R006\s*\|/.test(line)) || ''
  assert.match(v1R006Line, /PASS_REAL/, 'V1 历史矩阵的 R006 PASS_REAL 必须保留')
  const v1Native = read(V1_NATIVE)
  assert.match(v1Native, /unsupported_input_item/, '旧的 compaction 失败记录必须保留')
  assert.match(v1Native, /128k/, '旧的 128k 溢出失败尝试必须保留')
  assert.match(v1Native, /诚实 `FAIL`/, '旧的 FAIL 记录不得被改写为通过')
})

// —— 5. native compaction 是发布必要条件，旧 PASS_REAL 不得继承 ——

test('native compaction 是发布必要条件：R006 PASS_REAL 必须含 native-compaction 实测且不得只绑旧树', () => {
  const status = read(STATUS_V2, 'V2 状态文档是当前门禁输入；缺失即 P00 未完成')
  const rows = parseStatusRows(status, STATUS_V2)
  const expected = Array.from({ length: 12 }, (_, i) => 'MG-R' + String(i + 1).padStart(3, '0'))
  assert.deepEqual(rows.map((r) => r.id), expected, 'V2 状态文档必须 12 条齐全且顺序固定')

  const r006 = rows.find((r) => r.id === 'MG-R006')
  assert.ok(['NOT_TESTED', 'BLOCKED', 'FAIL', 'PASS_MOCK', 'PASS_REAL'].includes(r006.status),
    'MG-R006 状态必须是五值之一，实际：' + r006.status)

  if (r006.status === 'PASS_REAL') {
    // 允许将来真实通过，但必须携带 native compaction 实测子用例，且绑定新树。
    assert.match(r006.basis, /native-compaction|原生压缩/, 'R006 PASS_REAL 必须写明 native compaction 实测')
    assert.match(r006.basis, /post-compact|压缩后/, 'R006 PASS_REAL 必须写明压缩后同一子代理继续')
    const shas = r006.basis.match(/\b[0-9a-f]{40}\b/g) || []
    assert.ok(shas.length > 0, 'R006 PASS_REAL 必须绑定完整 40 位被测树 SHA')
    const fresh = shas.filter((s) => !V1_TESTED_TREES.includes(s))
    assert.ok(fresh.length > 0, 'R006 PASS_REAL 不得只绑 V1 旧树（' + V1_TESTED_TREES.join(',') + '），必须有一次新的压缩实测')
  } else {
    // 当前轮：尚未真实通过，必须是明确的未通过态，且保留失败原因。
    assert.notEqual(r006.status, 'PASS_REAL')
    assert.match(r006.basis, /unsupported_input_item|原生压缩|native compaction/,
      'R006 未通过时必须写明具体阻断（compaction 失败或未实测）')
    assert.match(r006.basis, /取代\s*PASS_REAL\s*@\s*docs\/evidence\/aggregation-native-real-2026-11-14\.md/,
      '必须显式声明旧 V1 R006 PASS_REAL 被取代，不能静默继承')
    assert.doesNotMatch(r006.basis, /已通过|PASS_REAL\s*@\s*`?9db5ed1/, 'R006 未通过时不得声称通过')
  }
})

test('V2 状态：R006 未真实通过时，V2 门禁必须 ready:false 且首个阻断为 MG-R006', () => {
  const status = read(STATUS_V2, 'V2 状态文档是当前门禁输入；缺失即 P00 未完成')
  const rows = parseStatusRows(status, STATUS_V2)
  const r006 = rows.find((r) => r.id === 'MG-R006')
  const matrixV2 = readIfExists(MATRIX_V2)
  assert.ok(matrixV2 !== null, '缺少 V2 矩阵文档 ' + MATRIX_V2 + '（P00 未完成，不能用 V1 矩阵代替）')

  if (r006.status !== 'PASS_REAL') {
    assert.match(matrixV2, /当前门禁[：:]\s*`ready:false`/, 'V2 矩阵必须声明当前门禁 ready:false')
    assert.match(matrixV2, /首个产品级阻断是\s*`MG-R006`/, 'V2 矩阵必须点名 MG-R006 是首个阻断')
    // 黑箱观测：直接运行 Lead 的门禁 CLI，只读其 JSON 输出，不 import 内部实现。
    assert.ok(existsSync(rel(GATE_V2)), '缺少 V2 门禁脚本 ' + GATE_V2 + '（P00 未完成）')
    const run = spawnSync(process.execPath, [GATE_V2], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', NODE_ENV: 'test' },
    })
    assert.equal(run.status, 0, 'V2 门禁 CLI 运行失败：' + (run.stderr || '').slice(0, 500))
    let gate
    try {
      gate = JSON.parse(run.stdout)
    } catch (e) {
      assert.fail('V2 门禁 CLI 输出不是 JSON：' + run.stdout.slice(0, 500))
    }
    assert.equal(gate.ready, false, 'R006 未真实通过时门禁不得 ready:true')
    assert.equal(gate.status, 'BLOCKED', 'R006 未真实通过时门禁状态必须 BLOCKED')
    assert.ok(Array.isArray(gate.failedRequirements) && gate.failedRequirements.includes('MG-R006'),
      '门禁 failedRequirements 必须包含 MG-R006，实际：' + JSON.stringify(gate.failedRequirements))
  }
})

test('V2 门禁实现必须具备反绕过检查（文本层，不 import）', () => {
  const gate = read(GATE_V2, 'V2 门禁脚本缺失即 P00 未完成')
  // 必须把 native compaction 三件套作为阻断条件，而不是注释。
  assert.match(gate, /NATIVE_COMPACTION_CASES/, '门禁必须引用 native compaction 三件套常量')
  assert.match(gate, /native-compaction/, '门禁必须点名 native-compaction')
  assert.match(gate, /skipped/, '门禁必须处理 skipped（skip 不得计为通过）')
  assert.match(gate, /stale_evidence|headSha/, '门禁必须做换树失效（stale_evidence）检查')
  assert.match(gate, /ownerApproval/, '门禁必须要求所有者批准')
  // 不得出现“无条件放行”。
  assert.doesNotMatch(gate, /ready:\s*true\s*[,}]/, '门禁脚本不得硬编码 ready:true')
  // 必须校验 V2 取消项不回到阻断映射。
  const matrixJs = read(MATRIX_JS_V2, 'V2 矩阵生成器缺失即 P00 未完成')
  assert.match(matrixJs, /V2_CANCELLED_CASES/, '矩阵生成器必须维护 V2 取消项集合')
  assert.match(matrixJs, /NATIVE_COMPACTION_CASES/, '矩阵生成器必须强制 native compaction 三件套')
})

// —— 6. 禁止自建压缩 ——

// 只允许的“误报”白名单：协议保真（显式识别/拒绝 compaction），不是自建压缩。
// 每条必须写明理由；不得用于排除真实实现。
const COMPACTION_SCAN_WHITELIST = Object.freeze([
  {
    file: 'src/codex/interop.js',
    because: '协议保真：显式识别 compaction item 并在路由不接受时返回 typed unsupported_input_item；丢弃时记 lossy=compaction_dropped，不生成摘要',
  },
])

// 真实“自建压缩/摘要/截断”实现的特征标识（命中即失败）。
const BANNED_COMPACTION_IMPL = Object.freeze([
  /\bsummarizeHistory\b/,
  /\bcompactHistory\b/,
  /\btruncateHistory\b/,
  /\btrimHistory\b/,
  /\bsummarize_conversation\b/,
  /\bcompact_input\b/,
  /\bbuildCompactionSummary\b/,
  /\bsummaryCache\b/,
  /\bcompactionCache\b/,
  /\bsummarizer\b/i,
  /\bllmSummarize\b/i,
  /\bcompressHistory\b/,
  /\bprunedHistory\b/,
  /\bhistoryTruncation\b/,
])

function walkJs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJs(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('禁止自建压缩：src 无 summarize/摘要缓存/历史截断实现，compaction 必须显式处理不得静默吞', () => {
  const files = walkJs(rel('src'))
  assert.ok(files.length > 20, 'src 文件扫描异常：只发现 ' + files.length + ' 个 .js 文件')
  const hits = []
  for (const file of files) {
    const relPath = file.slice(ROOT.length + 1).replaceAll('\\', '/')
    if (COMPACTION_SCAN_WHITELIST.some((w) => w.file === relPath)) continue
    const text = readFileSync(file, 'utf8')
    for (const re of BANNED_COMPACTION_IMPL) {
      if (re.test(text)) hits.push(relPath + ' ← ' + re)
    }
  }
  assert.deepEqual(hits, [], '发现疑似网关自建压缩/摘要实现（压缩必须归 Codex 原生）：\n' + hits.join('\n'))

  // 协议侧必须显式识别 compaction，且丢弃必须记 lossy（不能静默吞）。
  const interop = read('src/codex/interop.js')
  assert.match(interop, /'compaction'/, 'interop 必须显式识别 compaction item')
  assert.match(interop, /compaction_dropped/, '丢弃 compaction 必须记 lossy，不得静默')
  assert.match(interop, /unsupported_input_item/, '不接受 compaction 的路由必须返回 typed error')
  // 不得在网关里伪造 encrypted_content。
  assert.doesNotMatch(interop, /encrypted_content\s*[:=]\s*['"]/, '不得生成虚假 encrypted_content')

  // 不得把 compaction 配成 drop：drop 会绕过 native compaction 验收（伪装通过），
  // 正确姿态是 reject（typed error）或原生透传。
  const indexJs = read('src/index.js')
  assert.doesNotMatch(indexJs, /compaction\s*:\s*['"]drop['"]/, 'V2 路线不得配置 compaction:drop（会绕过原生压缩验收）')
  assert.match(indexJs, /compaction\s*:\s*['"]reject['"]/, 'V2 默认路线必须以 typed error 拒绝不接受的 compaction')
})

test('网关侧摘要导出路径：必须移除或登记所有者豁免（当前契约禁令为绝对条款）', () => {
  // 已知 N04 遗留能力：src/codex/history.js 的“最小明文摘要导出” + /api/codex/history/export（写入）。
  // 它不是 LLM 压缩、也不改写原件；但契约原文“网关不得自建 summarize”是绝对条款，没有 V2 豁免记录。
  const summarySignals = [
    ['src/codex/history.js', /SUMMARY_EXPORT_FORMAT/],
    ['src/codex/history.js', /\bexportApprovedSummary\b/],
    ['src/codex/history.js', /\bplanSummaryExport\b/],
    ['src/codex/api.js', /\/api\/codex\/history\/export\b/],
  ]
  const found = summarySignals
    .filter(([file, re]) => re.test(read(file, file + ' 缺失，无法核对摘要导出路径')))
    .map(([file]) => file)
  const unique = [...new Set(found)]
  if (unique.length === 0) return // 已移除：满足绝对条款。

  // 存在时：必须能证明它“非 LLM、非压缩、原件不变”，并且 V2 状态/契约有所有者豁免记录。
  const history = read('src/codex/history.js')
  assert.match(history, /originalsUnchanged/, '摘要导出必须证明原件未改动')
  // 只拒绝真正的“调用 LLM 生成摘要”（HTTP 出站或 SDK create）；不误伤结构体字段 `model:`。
  assert.doesNotMatch(history, /\bfetch\s*\(\s*['"`]https?:|\bchat\/completions\b|\.responses\.create\s*\(|\bnew\s+OpenAI\s*\(/,
    '摘要导出不得调用 LLM（否则就是自建 summarize）')

  const status = read(STATUS_V2, '缺少 V2 状态文档，无法核对摘要导出是否登记豁免')
  const contract = read(CONTRACT_V2)
  const carveOut = [status, contract].some((text) =>
    /摘要导出|history\/export/.test(text) &&
    /所有者|owner/.test(text) &&
    /豁免|批准|carve|例外/.test(text),
  )
  assert.ok(carveOut,
    '发现网关侧摘要导出路径（' + unique.join(', ') + '），但 V2 状态/契约未登记所有者豁免。' +
    '按契约“网关不得自建 summarize”应移除该可达路径，或由所有者书面豁免并写入 V2 状态文档。')
})

// —— 7. 真实 GPT 只允许 gpt-6-luna ——

test('真实 GPT 只允许 gpt-6-luna：证据与配置中无其他 GPT 型号作为父模型回退', () => {
  // 证据集：V2 状态 + 全部 aggregation 证据 + 2026-11-13..15 的原生证据。
  const evidenceDir = rel('docs/evidence')
  const evidenceFiles = readdirSync(evidenceDir)
    .filter((name) => /^aggregation-.*\.md$/.test(name) || /^2026-11-1[3-5].*\.md$/.test(name))
    .map((name) => 'docs/evidence/' + name)
  const violations = []
  for (const file of evidenceFiles) {
    const text = readFileSync(rel(file), 'utf8')
      // 用例 ID official-gpt-6-luna-real 是派生标签，不是第二个模型。
      .replaceAll('official-gpt-6-luna-real', 'CASE_OFFICIAL_LUNA')
    for (const m of text.matchAll(/\bgpt-[0-9][A-Za-z0-9._-]*/g)) {
      // `gpt-6-luna` 及其复合标识（如 official-gpt-6-luna-in-original-desktop）都是 Luna，不是第二个模型。
      if (!m[0].startsWith('gpt-6-luna')) violations.push(file + ' → ' + m[0])
    }
  }
  assert.deepEqual(violations, [], '证据文档出现非 gpt-6-luna 的 GPT 型号：\n' + violations.join('\n'))

  // 契约与计划：仅允许 gpt-6-luna（含以它为前缀的复合标识，如 official-gpt-6-luna-in-original-desktop）。
  for (const file of [CONTRACT_V2, PLAN_V2, START_V2]) {
    const text = read(file).replaceAll('official-gpt-6-luna-real', 'CASE_OFFICIAL_LUNA')
    for (const m of text.matchAll(/\bgpt-[0-9][A-Za-z0-9._-]*/g)) {
      assert.ok(m[0].startsWith('gpt-6-luna'), file + ' 出现非 gpt-6-luna 的 GPT 型号：' + m[0])
    }
  }

  // 源码/配置不得把其他 GPT 型号作为父模型回退（同一行出现 fallback/default/parent 即失败）。
  const srcFiles = walkJs(rel('src'))
  const fallbackHits = []
  for (const file of srcFiles) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      const ids = line.match(/\bgpt-[0-9][A-Za-z0-9._-]*/g)
      if (!ids) continue
      for (const id of ids) {
        if (id.startsWith('gpt-6-luna')) continue
        if (/\bfallback|default|parent\b/i.test(line)) {
          fallbackHits.push(file.slice(ROOT.length + 1) + ' → ' + id + ' :: ' + line.trim().slice(0, 120))
        }
      }
    }
  }
  assert.deepEqual(fallbackHits, [], '源码出现非 Luna 的 GPT 父模型回退：\n' + fallbackHits.join('\n'))
})
