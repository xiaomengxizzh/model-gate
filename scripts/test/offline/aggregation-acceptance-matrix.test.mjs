// A5 矩阵自证：矩阵、契约、计划三者不得互相漂移。
//
// 本套件钉住三样东西（任何人编辑任一侧都会被判定失败）：
//   1. 契约 12 条的完整措辞（逐字）；
//   2. 计划 §I 给 12 条需求分配的 33 个用例 ID（逐项）；
//   3. 磁盘上的矩阵文件必须与生成器输出逐字节一致（禁止手改）。
// 另含“弱化即失败”的反向用例：删需求行、删用例、改契约文字都会被生成器/本套件拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CASE_EVIDENCE, CONTRACT_PATH, MATRIX_PATH, REQUIREMENT_IDS, TESTED_TREE_SHA,
  buildMatrix, generate, loadSources, parseEvidenceStatuses, parseTestedTreeSha, readMatrixFile,
} from './aggregation-matrix.js'
import { SUITES } from '../run.mjs'

const PINNED_CONTRACT_SHA = 'e2068e6edbf76eee47db3c04556eb9ab60548556d6632f955af29269e74edc83'

// 契约原文（逐字）。改动这里等于改动验收口径，必须由所有者批准。
const PINNED_WORDING = {
  'MG-R001': ['GUI 一键进入/退出聚合模式，默认官方套餐保持可用', '全新用户 GUI 流程，自动启停与回滚，重启后状态一致'],
  'MG-R002': ['Codex 已有 ChatGPT 登录、额度和官方模型正常使用，不要求用户再走开发调试 OAuth', '原版 Desktop 登录身份、官方实际模型请求与额度归属；切换/退出后未破坏原登录'],
  'MG-R003': ['添加 OpenCode Console/Go，自动发现本人全部可用模型并同步', '真实目录快照与 GUI/Codex 模型清单逐一对账；无静默遗漏，模型更新可恢复'],
  'MG-R004': ['原版 Codex Desktop GUI 内使用官方与聚合模型，无需手工改文件', '在原版 Desktop 逐一选择官方与两种 OpenCode 模型，实际回执核对正确供应商'],
  'MG-R005': ['继续采用**Codex 原生 Harness** 创建/调度父子代理；网关仅承担授权、模型目录、协议/路由与观测', '原生日志含父子线程、工具、上下文、恢复；不以 MCP/自建 Agent 调度替代'],
  'MG-R006': ['保留原生工具执行、等待、同子追派、中断、上下文与恢复，父子可跨供应商模型', '单一子 ID 两轮不同任务 + 真实工具回执 + 取消/恢复 + 无额外派单，所有事件可复核'],
  'MG-R007': ['零手工配置的普通用户体验：导入/检测/备份/写入/回滚 Codex 用户级配置', '空白安装与已有配置安装各自 GUI 测试；变更原子化、有冲突处理及无损回滚'],
  'MG-R008': ['无静默降级：不得悄悄换模型、换供应商、换协议、关闭工具或丢弃关键功能', '功能失败显示精确原因、原请求归因与阻断；反向测试验证零静默替换'],
  'MG-R009': ['允许面向其他用户分发，认证凭据、目录、额度、统计相互隔离', '两个独立测试身份的跨用户访问、删除、刷新、日志脱敏测试'],
  'MG-R010': ['安装/升级/停止聚合不破坏用户原 Codex 环境', '导入与回滚前后配置一致，原登录文件不被篡改，异常中断恢复'],
  'MG-R011': ['每个项目阶段保留准确真实证据，不得把 mock/静态检查称真实验收通过', '精确 SHA、运行环境、命令、回执、测试类型和失败/跳过状态登记'],
  'MG-R012': ['Codex 的真实 GPT 测试调用**仅可使用 GPT-6 Luna**（模型实际 ID 核验）；OpenCode 子模型可按目标调用', '请求级脱敏收据证明 GPT model 为 Luna；不允许其他 GPT 模型/自动回退；无 Luna 资格则 BLOCKED，不代换'],
}

// 计划 §I 冻结的用例分配（逐项）。少一个用例、换一个 ID 都算降级。
const PINNED_CASES = {
  'MG-R001': ['gui-activate', 'gui-deactivate', 'restart'],
  'MG-R002': ['codex-official-login-unchanged', 'official-gpt-6-luna-real'],
  'MG-R003': ['all-opencode-console-models', 'all-opencode-go-models', 'refresh-diff'],
  'MG-R004': ['desktop-model-picker-official', 'desktop-model-picker-go', 'desktop-model-picker-console'],
  'MG-R005': ['native-child-thread-not-mcp', 'native-tools'],
  'MG-R006': ['same-child-two-tasks', 'interrupt', 'resume', 'context', 'no-duplicate'],
  'MG-R007': ['fresh-install-no-manual-edit', 'existing-config-preserve'],
  'MG-R008': ['no-silent-fallback', 'unsupported-tool-fails-explicitly', 'catalog-not-truncated'],
  'MG-R009': ['two-user-isolation', 'token-rotation', 'redacted-logs'],
  'MG-R010': ['rollback-byte-compatible', 'crash-recovery', 'conflict-409'],
  'MG-R011': ['receipts-pin-sha', 'mock-vs-real-accuracy'],
  'MG-R012': ['codex-gpt-parent-only-luna', 'no-gpt-fallback'],
}

const sources = loadSources()
const built = buildMatrix(sources)

test('契约 12 条：ID、顺序、措辞与钉住版本逐字一致', () => {
  assert.deepEqual(sources.contract.map((r) => r.id), REQUIREMENT_IDS)
  for (const row of sources.contract) {
    assert.deepEqual([row.behavior, row.realAcceptance], PINNED_WORDING[row.id], 'contract wording changed for ' + row.id)
  }
})

test('契约文件哈希与钉住值一致（第三方改写会在这里暴露）', () => {
  const digest = createHash('sha256').update(sources.contractText, 'utf8').digest('hex')
  assert.equal(digest, PINNED_CONTRACT_SHA)
})

test('计划 §I 的 12×33 用例分配与钉住映射完全一致', () => {
  assert.deepEqual(built.caseIndex, PINNED_CASES)
  const all = Object.values(built.caseIndex).flat()
  assert.equal(all.length, 33)
  assert.equal(new Set(all).size, 33, 'case ids must be unique')
  assert.deepEqual(Object.keys(CASE_EVIDENCE).sort(), [...all].sort(), 'every planned case must define required evidence')
})

test('磁盘矩阵文件与生成器输出逐字节一致（禁止手改矩阵）', () => {
  assert.equal(readMatrixFile(), generate().markdown)
})

test('矩阵每行包含契约原文，状态与证据文档一致，门禁不是 ready', () => {
  const doc = readMatrixFile()
  assert.match(doc, /^# ModelGate 聚合模式独立验收矩阵/m)
  assert.ok(doc.includes('`' + TESTED_TREE_SHA + '`'), 'matrix must pin the tested tree SHA')
  assert.ok(doc.includes('`ready:false`'), 'matrix must state the current gate verdict as ready:false')
  for (const id of REQUIREMENT_IDS) {
    const [behavior, acceptance] = PINNED_WORDING[id]
    assert.ok(doc.includes('| ' + id + ' | ' + behavior + ' | ' + acceptance + ' |'), 'matrix row drifted from contract: ' + id)
  }
  // 12 行数据 + 1 行表头 + 1 行分隔
  const rows = doc.split('\n').filter((l) => /^\| MG-R\d{3} \|/.test(l))
  assert.equal(rows.length, 12)
  // 状态不是手写常量，而是逐行搬运证据文档：9 PASS_MOCK + 2 NOT_TESTED + 1 BLOCKED，0 个 PASS_REAL。
  for (const row of built.rows) {
    assert.ok(doc.includes('| ' + row.id + ' |'), 'missing matrix row ' + row.id)
    assert.ok(rows.some((l) => l.startsWith('| ' + row.id + ' |') && l.includes('| ' + row.status + ' @ `')), 'status drifted for ' + row.id)
    assert.ok(rows.some((l) => l.startsWith('| ' + row.id + ' |') && l.includes(row.statusBasis)), 'evidence basis missing for ' + row.id)
  }
  assert.deepEqual(countByStatus(doc), { NOT_TESTED: 2, BLOCKED: 1, FAIL: 0, PASS_MOCK: 9, PASS_REAL: 0 })
  assert.equal(doc.includes('PASS_REAL @ `'), false)
})

function countByStatus (doc) {
  const counts = { NOT_TESTED: 0, BLOCKED: 0, FAIL: 0, PASS_MOCK: 0, PASS_REAL: 0 }
  for (const line of doc.split('\n')) {
    if (!/^\| MG-R\d{3} \|/.test(line)) continue
    for (const status of Object.keys(counts)) {
      if (line.includes('| ' + status + ' @ `')) counts[status]++
    }
  }
  return counts
}

test('状态来自证据文档（不是基线、不是常量），且多份证据互相一致', () => {
  // 基线仍是 11 NOT_TESTED + 1 BLOCKED（历史起点）；矩阵必须反映整合后的证据状态，而不是照抄基线。
  const baselineStatus = new Map(sources.baseline.rows.map((r) => [r.id, r.status]))
  assert.equal(baselineStatus.get('MG-R001'), 'NOT_TESTED')
  assert.equal(built.rows.find((r) => r.id === 'MG-R001').status, 'PASS_MOCK')

  const docs = sources.evidence.map((e) => ({ docPath: e.docPath, byId: new Map(e.rows.map((r) => [r.id, r.status])) }))
  assert.equal(docs.length >= 2, true, 'statuses must come from at least two evidence documents')
  for (const row of built.rows) {
    assert.ok(docs.some((d) => d.byId.get(row.id) === row.status), 'status for ' + row.id + ' is not present in any evidence doc')
    const seen = docs.filter((d) => d.byId.has(row.id)).map((d) => d.byId.get(row.id))
    assert.equal(new Set(seen).size, 1, 'evidence docs disagree on ' + row.id + ': ' + seen.join(','))
  }
  // PASS_MOCK 必须点名真实存在且已登记的离线套件（离线套件确实执行过该行为）。
  for (const row of built.rows.filter((r) => r.status === 'PASS_MOCK')) {
    assert.ok(row.statusSuites.length > 0, row.id + ' is PASS_MOCK without a cited offline suite')
    for (const name of row.statusSuites) {
      assert.ok(SUITES.includes('scripts/test/offline/' + name), row.id + ' cites unregistered suite ' + name)
    }
  }
  for (const row of built.rows.filter((r) => r.status !== 'PASS_MOCK')) {
    assert.deepEqual(row.statusSuites, [], row.id + ' is ' + row.status + ' but cites suites')
  }
})

test('被测树 SHA 从证据文档解析：改常量无效，字段缺失/非法即失败', () => {
  const integration = sources.evidence[0].text
  assert.equal(parseTestedTreeSha(integration, 'integration'), TESTED_TREE_SHA)
  assert.match(TESTED_TREE_SHA, /^[0-9a-f]{40}$/)
  assert.equal(readMatrixFile().includes(TESTED_TREE_SHA), true)
  assert.throws(() => parseTestedTreeSha(integration.replace(/被测树\s*SHA[^\n]*\n/, ''), 'integration'), /lacks a 40-hex 被测树 SHA/)
  assert.throws(() => parseTestedTreeSha('**被测树 SHA**：`abc123`', 'x'), /40-hex/)
})

test('F5 口径：证据状态只允许五值；PASS(...)/N/A/未标注都会被生成器拒绝', () => {
  const base = [
    '## 5. 需求状态',
    '',
    '| 需求 | 状态 | 依据 |',
    '| --- | --- | --- |',
  ]
  for (const bad of ['PASS（本文件）', 'N/A', 'passed', 'MOCK']) {
    const text = base.concat(['| MG-R011 真实证据 | ' + bad + ' | 无 |']).join('\n')
    assert.throws(() => parseEvidenceStatuses(text, 'x'), /invalid status/, 'must reject ' + bad)
  }
  const good = base.concat(['| MG-R011 真实证据 | **PASS_MOCK** | `aggregation-acceptance-audit.test.mjs` |']).join('\n')
  assert.deepEqual(parseEvidenceStatuses(good, 'x').map((r) => r.status), ['PASS_MOCK'])
})

test('证据文档互相矛盾即生成失败（禁止矩阵与报告各说一套）', () => {
  const docA = { docPath: 'a.md', rows: [{ id: 'MG-R001', status: 'NOT_TESTED', basis: 'x', suites: [], docPath: 'a.md' }] }
  const docB = { docPath: 'b.md', rows: [{ id: 'MG-R001', status: 'PASS_MOCK', basis: 'y（`agg-desktop-ui.test.mjs`）', suites: ['agg-desktop-ui.test.mjs'], docPath: 'b.md' }] }
  assert.throws(
    () => buildMatrix({ ...sources, evidence: [docA, docB] }),
    /证据文档互相矛盾：MG-R001/,
  )
  // 没有证据来源时也不得生成矩阵（不能回落到硬编码状态）。
  assert.throws(() => buildMatrix({ ...sources, evidence: [] }), /derived from evidence documents/)
})

test('降级即失败：删需求行 / 删计划用例 / 契约少一条都不能生成矩阵', () => {
  assert.throws(
    () => buildMatrix({ ...sources, contract: sources.contract.slice(0, 11) }),
    /MG-R001\.\.MG-R012/,
  )
  const weakenedPlan = sources.planCases.map((p) => p.id === 'MG-R006' ? { ...p, tests: p.tests.filter((t) => t !== 'interrupt') } : p)
  assert.throws(() => buildMatrix({ ...sources, planCases: weakenedPlan }), /interrupt/)
  const reordered = [...sources.contract]
  reordered[0] = { ...reordered[0], id: 'MG-R013' }
  assert.throws(() => buildMatrix({ ...sources, contract: reordered }), /MG-R001\.\.MG-R012/)
})

test('矩阵文件本身不被当成证据：它不产生 PASS_REAL，且明确指向结论文档', () => {
  const doc = readMatrixFile()
  assert.ok(doc.includes('scripts/test/offline/aggregation-matrix.js'))
  assert.ok(doc.includes('本文件不产生任何 `PASS_REAL`'))
  assert.ok(doc.includes('aggregation-acceptance-verdict-2026-11-14.md'))
  assert.ok(doc.includes(CONTRACT_PATH))
})
