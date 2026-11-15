// V2 门禁自证：V2 契约、V2 计划 §2.1、V2 状态证据与磁盘矩阵不得互相漂移，
// 且 native compaction 未真实通过时门禁不可能放行；V1 历史矩阵保持逐字节冻结。
//
// 本套件取代 V1 矩阵套件成为**当前发布门禁**。V1 套件（aggregation-acceptance-matrix.test.mjs）
// 继续存在，只守卫历史快照，不再代表 V2 交付状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CASE_EVIDENCE_V2,
  CONTRACT_PATH_V2,
  MATRIX_PATH_V2,
  NATIVE_COMPACTION_CASES,
  PLAN_PATH_V2,
  STATUS_PATH_V2,
  V2_CANCELLED_CASES,
  buildV2Matrix,
  generateV2,
  loadV2Sources,
  parseV2PlanCases,
  readV2MatrixFile,
} from './aggregation-matrix-v2.js'
import { REQUIREMENT_IDS, generate as generateV1, readMatrixFile as readV1MatrixFile } from './aggregation-matrix.js'
import { assertNativeCompactionIsBlocking, gateV2, v2CaseIndex, v2EvidenceFromStatus as v2StatusToRecords } from './aggregation-gate-v2.js'
import { SUITES } from '../run.mjs'

const ROOT = new URL('../../../', import.meta.url)

// V2 契约原文（逐字）。改动这里等于改动验收口径，必须由所有者批准。
const PINNED_WORDING_V2 = {
  'MG-R001': ['GUI 一键开启/关闭聚合模式，原版 Codex 正常重载', '实际 GUI 点击、状态回执、重启、回滚'],
  'MG-R002': ['原有 ChatGPT 登录与套餐能力无损保留', '原版 Codex Desktop 官方模型真实请求、登录状态/额度归属与回滚核验'],
  'MG-R003': ['**只强制支持 OpenCode Go `deepseek-v4.1-flash`**；其他模型非交付项', 'Go 凭据与目标模型真实推理成功；公共模型 ID 与真实模型、服务端出站一致'],
  'MG-R004': ['原版 Codex Desktop GUI 可选 ChatGPT 官方模型和上述 DeepSeek 模型', '在原版 GUI 内逐个选择，模型选择器和请求收据一致'],
  'MG-R005': ['保留 Codex 原生 Harness 的父子 Agent Team，不用 MCP/自建代理替代', '原生父/子线程 + 指定 DeepSeek 子模型 + 原生工具真实回执'],
  'MG-R006': ['保留原生等待、追派、中断、上下文、恢复，**必须能经过 Codex 自身的压缩后继续工作**', '真实触发原生压缩，压缩前后同一子线程、工具和记忆连续，确认中断/恢复与无重复派单'],
  'MG-R007': ['GUI 自动处理客户端检测、配置备份、写入与退出恢复', '新用户和既有配置用户的实际桌面演练，零手工 TOML'],
  'MG-R008': ['不允许静默换 GPT、换 DeepSeek、丢工具或私自总结历史', '错误模型/鉴权/压缩失败/协议不兼容反向测试，无隐式替换或历史丢失'],
  'MG-R009': ['支持其他用户使用时凭据/配置/记录隔离', '双用户/双身份真实或经所有者批准的可复现安装隔离验收'],
  'MG-R010': ['原 Codex 安装、账号、原始配置在启停升级后可恢复', '字节级回滚、崩溃恢复、冲突提示，不破坏现有用户登录'],
  'MG-R011': ['每个阶段保留真实证据和费用/权限记录', '精确 commit、可复现实测、日志脱敏；mock 与 real 分离'],
  'MG-R012': ['**所有原版 Codex 真实 GPT 测试仅允许 GPT-6 Luna**', '出站请求级 `model=gpt-6-luna`；不存在其他 GPT 型号或自动 fallback'],
}

// V2 计划 §2.1 冻结的用例分配（逐项）。少一个用例、换一个 ID 都算降级。
const PINNED_CASES_V2 = {
  'MG-R001': ['gui-activate', 'gui-deactivate', 'restart'],
  'MG-R002': ['codex-official-login-unchanged', 'official-gpt-6-luna-real'],
  'MG-R003': ['go-deepseek-auth-real', 'go-deepseek-inference-real', 'model-id-exact'],
  'MG-R004': ['desktop-picker-gpt', 'desktop-picker-deepseek'],
  'MG-R005': ['native-child-thread-not-mcp', 'native-tools'],
  'MG-R006': ['native-tool', 'same-child-followup', 'interrupt', 'native-compaction', 'post-compact-followup', 'context-proof', 'resume', 'no-duplicates'],
  'MG-R007': ['fresh-install-no-manual-edit', 'existing-config-preserve'],
  'MG-R008': ['no-silent-model-fallback', 'no-silent-tool-drop', 'no-silent-compaction-drop', 'typed-error', 'request-identity'],
  'MG-R009': ['two-user-isolation', 'token-rotation', 'redacted-logs'],
  'MG-R010': ['rollback-byte-compatible', 'crash-recovery', 'conflict-409'],
  'MG-R011': ['receipts-pin-sha', 'mock-vs-real-accuracy'],
  'MG-R012': ['codex-gpt-parent-only-luna', 'no-gpt-fallback'],
}

test('V2 契约 12 条措辞逐字固定（不改口径）', () => {
  const { contract } = loadV2Sources()
  assert.deepEqual(contract.map((r) => r.id), REQUIREMENT_IDS)
  for (const row of contract) {
    assert.deepEqual([row.behavior, row.realAcceptance], PINNED_WORDING_V2[row.id], row.id + ' 契约措辞漂移')
  }
})

test('V2 计划 §2.1 冻结 12 行用例映射（含 native compaction 三件套）', () => {
  const plan = readFileSync(new URL(PLAN_PATH_V2, ROOT), 'utf8')
  const rows = parseV2PlanCases(plan)
  assert.deepEqual(rows.map((r) => r.id), REQUIREMENT_IDS)
  for (const row of rows) assert.deepEqual(row.tests, PINNED_CASES_V2[row.id], row.id + ' 用例分配漂移')
  for (const must of NATIVE_COMPACTION_CASES) {
    assert.ok(rows.find((r) => r.id === 'MG-R006').tests.includes(must), 'MG-R006 缺少 ' + must)
  }
})

test('V2 用例证据定义与映射一一对应（不多不少）', () => {
  const { caseIndex } = buildV2Matrix(loadV2Sources())
  const planned = Object.values(caseIndex).flat().sort()
  assert.deepEqual(Object.keys(CASE_EVIDENCE_V2).sort(), planned)
})

test('V2 已取消的 Console 全量用例不再进入 V2 门禁', () => {
  const caseIndex = v2CaseIndex()
  for (const cancelled of V2_CANCELLED_CASES) {
    assert.ok(!Object.values(caseIndex).flat().includes(cancelled), 'V2 仍在阻断已取消用例: ' + cancelled)
  }
  // 历史 V1 矩阵必须仍能证明这些用例曾经存在（保留可追溯性，不得抹除）。
  const v1Matrix = readV1MatrixFile()
  assert.ok(v1Matrix.includes('all-opencode-console-models'), 'V1 历史矩阵被改写了')
  assert.ok(v1Matrix.includes('desktop-model-picker-console'), 'V1 历史矩阵被改写了')
})

test('V1 历史矩阵仍与 V1 生成器逐字节一致（历史不得漂移）', () => {
  assert.equal(generateV1().markdown, readV1MatrixFile(), 'V1 历史矩阵漂移')
})

test('V2 矩阵文件与生成器逐字节一致（禁止手改）', () => {
  assert.equal(generateV2().markdown, readV2MatrixFile(), MATRIX_PATH_V2 + ' 与生成器不一致')
})

test('V2 状态证据：12 条齐全，MG-R006 的状态必须与证据一致（不得无据升级）', () => {
  const { evidence } = loadV2Sources()
  const statusDoc = evidence.find((e) => e.docPath === STATUS_PATH_V2)
  assert.ok(statusDoc, '缺少 V2 状态文档')
  assert.deepEqual(statusDoc.rows.map((r) => r.id), REQUIREMENT_IDS)
  const r006 = statusDoc.rows.find((r) => r.id === 'MG-R006')
  assert.match(r006.basis, /native-compaction|原生压缩/)
  if (r006.status !== 'PASS_REAL') {
    // 未通过时必须保留历史失败与显式取代，不能静默继承旧 PASS_REAL。
    assert.match(r006.basis, /unsupported_input_item|FAIL|未通过/)
    assert.match(r006.basis, /取代\s*PASS_REAL\s*@\s*docs\/evidence\/aggregation-native-real-2026-11-14\.md/)
    return
  }
  // 升级为 PASS_REAL 时：必须覆盖全部 V2 用例、绑定完整 40 位新树、声明压缩后继续。
  const expected = ['native-tool', 'same-child-followup', 'interrupt', 'native-compaction', 'post-compact-followup', 'context-proof', 'resume', 'no-duplicates']
  for (const c of expected) assert.ok(r006.basis.includes(c), 'PASS_REAL 的 MG-R006 缺少用例 ' + c)
  assert.match(r006.basis, /压缩后|post-compact/)
  const shas = r006.basis.match(/\b[0-9a-f]{40}\b/g) || []
  assert.ok(shas.length > 0, 'PASS_REAL 必须绑定完整 40 位被测树 SHA')
  const V1 = ['67b97354ad28a3924607b35a663801f417f14b8e', '4feafe0e51dc02d48c45734df5b34e70d3679bd5']
  assert.ok(shas.some((x) => !V1.includes(x)), '不得只绑 V1 旧树')
  // 即使升级通过，也必须显式取代旧树 PASS_REAL（不能静默覆盖历史）。
  assert.match(r006.basis, /取代\s*PASS_REAL\s*@\s*docs\/evidence\/aggregation-native-real-2026-11-14\.md/)
})

test('V2 门禁：当前状态 ready:false，且不因所有者批准而放行', () => {
  const gate = gateV2({ ownerApproval: true })
  assert.equal(gate.ready, false)
  assert.equal(gate.status, 'BLOCKED')
  assert.ok(gate.failedRequirements.length > 0)
  assert.ok(gate.failedRequirements.includes('MG-R006'))
  assert.equal(gate.ownerApproval, true)
})

test('V2 状态文档里写 PASS_REAL 不足以放行（必须给真实回执）', () => {
  const { evidence } = loadV2Sources()
  const statusDoc = evidence.find((e) => e.docPath === STATUS_PATH_V2)
  // 伪造：状态文档每行都写 PASS_REAL，但没有任何 commitSha/command/receipt/realTarget。
  const forged = statusDoc.rows.map((r) => Object.assign({}, r, { status: 'PASS_REAL' }))
  const gate = gateV2({ ownerApproval: true, evidence: v2StatusToRecords(forged) })
  assert.equal(gate.ready, false)
  assert.ok(gate.requirements.every((r) => r.reason === 'invalid_evidence'), '状态声明不得自证')
})

test('V2 门禁：native compaction 不可被绕过（缺记录/skipped/旧证据/换树）', () => {
  const result = assertNativeCompactionIsBlocking()
  for (const f of result.findings) assert.ok(f.ok, f.name + ' — ' + f.detail)
  assert.equal(result.ok, true)
})

test('V2 门禁引用套件必须已登记在 scripts/test/run.mjs', () => {
  const { evidence } = loadV2Sources()
  for (const doc of evidence) {
    for (const row of doc.rows) {
      for (const suite of row.suites) {
        const rel = 'scripts/test/offline/' + suite
        assert.ok(existsSync(new URL(rel, ROOT)), row.id + ' 引用不存在的套件 ' + rel)
        assert.ok(SUITES.includes(rel), row.id + ' 引用未登记套件 ' + rel)
      }
    }
  }
})

test('网关侧不得出现自建压缩/摘要实现（压缩归 Codex）', () => {
  const banned = /summarizeHistory|compactHistory|truncateHistory|trimHistory|summarize_conversation|compact_input|buildCompactionSummary/
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'ui-next' ? [] : walk(join(dir, e.name))
    return e.name.endsWith('.js') ? [join(dir, e.name)] : []
  })
  const files = walk(fileURLToPath(new URL('src/', ROOT)))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!banned.test(text), '网关出现疑似自建压缩实现: ' + file)
  }
  // 协议侧必须对 compaction 有显式判定（透传或 typed error），不得静默吞掉。
  const interop = readFileSync(new URL('src/codex/interop.js', ROOT), 'utf8')
  assert.match(interop, /'compaction'/, 'interop 必须显式识别 compaction item')
  assert.match(interop, /compaction_dropped/, '丢弃 compaction 必须记 lossy，不得静默')
})

test('历史迁移导出不得进入模型请求路径（非压缩/摘要路径，A5 N04 裁决）', () => {
  // 结论：/api/codex/history/export* 是用户显式触发、写独立文件的迁移导出，
  // 不是压缩器/摘要器，也绝不能把摘录喂回模型历史。用户请求路径文件不得引用它。
  for (const rel of ['src/responses.js', 'src/codex/interop.js', 'src/router.js']) {
    const text = readFileSync(new URL(rel, ROOT), 'utf8')
    assert.ok(!/from\s+['"][^'"]*codex\/history\.js['"]/.test(text), rel + ' 不得引用 history 导出模块（防止摘要进入请求组装）')
  }
  const api = readFileSync(new URL('src/codex/api.js', ROOT), 'utf8')
  assert.match(api, /history_export(?:_plan)?'/)
  assert.match(api, /非压缩\/摘要路径/, '导出路由说明必须明确它不是压缩/摘要路径')
})

// A5 N1 / N5-R：门禁自证的期望语义与状态表都可能被**等行数改写**（不触发 gate-weakened）。
// 这里分别钉住「整个门禁模块」与「状态表逐行内容」的 sha256：
// 任何语义改动都必须同时改这两个哈希，形成两次可见的修改，而不是悄悄换一个 true/false。
const PINNED_GATE_MODULE_SHA = 'c6fe1ef39596a8c68b6d492f4b4fdf2038a018fb6a5d9c352b5ed63f46d4b31a'
const PINNED_STATUS_TABLE_SHA = 'e572d41c2afd04db812e2a6a2d44003499e911c93c39c97993a5bda773305a2e'

test('门禁模块整体钉死 sha256（等行数语义削弱必须显式二次确认）', () => {
  const src = readFileSync(new URL('scripts/test/offline/aggregation-gate-v2.js', ROOT), 'utf8')
  const digest = createHash('sha256').update(src, 'utf8').digest('hex')
  assert.equal(digest, PINNED_GATE_MODULE_SHA,
    'V2 门禁模块被改动：若是有意加强/重构，请更新 PINNED_GATE_MODULE_SHA 并在提交说明里写清为什么；若是削弱，禁止合并')
})

test('V2 状态表逐行钉死 sha256（状态值等行数改写必须显式二次确认）', () => {
  const doc = readFileSync(new URL(STATUS_PATH_V2, ROOT), 'utf8')
  const a = doc.indexOf('## 2. 需求状态')
  const b = doc.indexOf('## 3.')
  assert.ok(a >= 0 && b > a, '状态表位置变化')
  const table = doc.slice(a, b).split('\n').filter((l) => l.trim().startsWith('|') || l.startsWith('## ')).join('\n')
  const digest = createHash('sha256').update(table, 'utf8').digest('hex')
  assert.equal(digest, PINNED_STATUS_TABLE_SHA,
    'V2 状态表内容被改动：状态升级/降级必须同时更新 PINNED_STATUS_TABLE_SHA 并在证据里写明来源')
})

test('历史复算不得伪装发布：replay 结果必须 ready:false 且标记 releaseEligible:false', () => {
  const caseIndex = v2CaseIndex()
  const forged = {}
  for (const id of REQUIREMENT_IDS) {
    forged[id] = {
      status: 'PASS_REAL', commitSha: 'b'.repeat(40), command: 'x', receipt: { traceId: 't' },
      realTarget: true, passedAllOnRealTarget: true,
      cases: Object.fromEntries((caseIndex[id] || []).map((c) => [c, { passed: true }])),
    }
  }
  const replay = gateV2({ sha: 'b'.repeat(40), ownerApproval: true, evidence: forged, allowNonHead: true })
  assert.equal(replay.ready, false, 'replay 不得 ready:true')
  assert.equal(replay.status, 'BLOCKED')
  assert.equal(replay.replay, true)
  assert.equal(replay.releaseEligible, false)
  assert.equal(replay.reason, 'replay_is_not_release_evidence')
  assert.equal(replay.canAskOwnerToMerge, false)

  // 非 replay 且 SHA 与 HEAD 不一致：直接拒绝（non_head_sha_requires_replay_flag）。
  const nonHead = gateV2({ sha: 'b'.repeat(40), ownerApproval: true, evidence: forged })
  assert.equal(nonHead.ready, false)
  assert.equal(nonHead.reason, 'non_head_sha_requires_replay_flag')
})
