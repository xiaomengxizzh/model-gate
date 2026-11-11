// E7 历史只读诊断回归：mkdtemp 合成 Codex sessions（官方 / 第三方 / v2 加密），
// 断言计数精确、输出无正文/密文、目录缺失识别、迁移计划只读且写入被拒。
// 不读取 ~/.codex/sessions、不联网、不写任何历史文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  diagnoseHistory, planSelectiveMigration, applySelectiveMigration, normalizeCatalog,
  HISTORY_WRITE_NOT_AUTHORIZED,
} from '../../../src/codex/history.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
const line = (o) => JSON.stringify(o) + '\n'
const meta = (id, provider) => line({ timestamp: iso(3600000), type: 'session_meta', payload: { session_id: id, model_provider: provider, cwd: '/home/user/project' } })
const turn = (model) => line({ timestamp: iso(3500000), type: 'turn_context', payload: { model, cwd: '/home/user/project', approval_policy: 'never' } })
const item = (payload) => line({ timestamp: iso(3400000), type: 'response_item', payload })
const event = (payload) => line({ timestamp: iso(3400000), type: 'event_msg', payload })

const SECRET_OFFICIAL = 'SECRET_OFFICIAL_MESSAGE_BODY_MUST_NOT_LEAK'
const SECRET_THIRD = 'SECRET_THIRD_PARTY_MESSAGE_BODY_MUST_NOT_LEAK'
const SECRET_V2 = 'SECRET_V2_MESSAGE_BODY_MUST_NOT_LEAK'
const CIPHER = 'CIPHERTEXT_MARKER_MUST_NOT_LEAK'
const TASKID = 'ENCRYPTED_TASK_ID_MARKER_MUST_NOT_LEAK'

function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'mg-codex-history-'))
  const dir = join(root, '2026', '11', '11')
  await mkdir(dir, { recursive: true })

  const official = [
    meta('s-official', 'openai'),
    turn('gpt-6.1-sol'),
    event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: SECRET_OFFICIAL }] }),
    item({ type: 'function_call', call_id: 'call_o1', name: 'exec_command', arguments: '{"cmd":"pwd"}' }),
    item({ type: 'function_call_output', call_id: 'call_o1', output: '/home/user/project' }),
  ].join('')

  const thirdParty = [
    meta('s-third', 'custom'),
    turn('deepseek-v4.1-flash'),
    turn('deepseek-v4.1-flash'),
    event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: SECRET_THIRD }] }),
    // 一个没有输出的调用（unpaired） + 一个有 unsupported 标记的输出（replay marker）
    item({ type: 'function_call', call_id: 'call_t1', name: 'wait_agent', arguments: '{"targets":["x"]}' }),
    item({ type: 'function_call', call_id: 'call_t2', name: 'send_input', arguments: '{"target":"x"}' }),
    item({ type: 'function_call_output', call_id: 'call_t2', output: 'unsupported call: send_input' }),
  ].join('')

  const v2 = [
    meta('s-v2', 'custom'),
    turn('deepseek-v4.1-flash'),
    event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: SECRET_V2 }] }),
    item({ type: 'agent_message', author: '/root', recipient: '/root/task', content: [
      { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
      { type: 'encrypted_content', encrypted_content: CIPHER },
    ] }),
    item({ type: 'function_call', call_id: 'call_v1', name: 'spawn_agent', arguments: '{"task_name":"t","encrypted_task_id":"' + TASKID + '"}' }),
  ].join('')

  await writeFile(join(dir, 'rollout-official.jsonl'), official)
  await writeFile(join(dir, 'rollout-thirdparty.jsonl'), thirdParty)
  await writeFile(join(dir, 'rollout-v2-encrypted.jsonl'), v2)
  await writeFile(join(root, 'notes.txt'), 'not jsonl')
  try { await symlink(join(dir, 'rollout-official.jsonl'), join(dir, 'rollout-link.jsonl')) } catch { /* 平台不支持符号链接则跳过 */ }
  return { root, dir, official, thirdParty, v2 }
}

test('E7 历史诊断：provider/model 统计、目录缺失、工具风险、v2 加密 unreadable', { timeout: 30000 }, async (t) => {
  const { root, thirdParty } = await fixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await diagnoseHistory({ sessionsDir: root, catalog: ['gpt-6.1-sol'], now: NOW })
  assert.equal(report.enabled, true)
  assert.equal(report.readOnly, true)
  assert.equal(report.catalogProvided, true)
  assert.equal(report.scanned.files, 3, '只扫 .jsonl 普通文件（symlink 跳过、notes.txt 忽略）')
  assert.equal(report.scanned.sessions, 3)
  assert.equal(report.scanned.parseErrors, 0)

  // 1) provider / model
  const providers = Object.fromEntries(report.summary.byProvider.map((p) => [p.provider, p]))
  assert.equal(providers.openai.sessions, 1)
  assert.equal(providers.openai.turns, 1)
  assert.equal(providers.custom.sessions, 2)
  assert.equal(providers.custom.turns, 3)
  const models = Object.fromEntries(report.summary.byModel.map((m) => [m.model, m]))
  assert.equal(models['gpt-6.1-sol'].turns, 1)
  assert.equal(models['gpt-6.1-sol'].sessions, 1)
  assert.equal(models['gpt-6.1-sol'].inCatalog, true)
  assert.equal(models['deepseek-v4.1-flash'].turns, 3)
  assert.equal(models['deepseek-v4.1-flash'].sessions, 2)
  assert.equal(models['deepseek-v4.1-flash'].inCatalog, false)

  const byId = Object.fromEntries(report.sessions.map((s) => [s.sessionId, s]))
  assert.equal(byId['s-official'].provider, 'openai')
  assert.deepEqual(byId['s-official'].models, [{ model: 'gpt-6.1-sol', turns: 1 }])
  assert.deepEqual(byId['s-third'].models, [{ model: 'deepseek-v4.1-flash', turns: 2 }])

  // 2) 目录缺失模型
  assert.deepEqual(report.summary.missingModels, ['deepseek-v4.1-flash'])
  assert.equal(report.summary.risks.missingModels.sessions, 2)
  assert.ok(byId['s-third'].risks.includes('missing_model:deepseek-v4.1-flash'))

  // 3) 工具回放风险（只计数，不含参数正文）
  assert.equal(report.summary.totals.toolCalls, 4)
  assert.equal(report.summary.risks.toolReplay.items, 1, '只有带 unsupported 标记的工具项计入 markers')
  assert.equal(report.summary.risks.toolReplay.sessions, 2, 's-third 有 marker，s-v2 有未配对调用')
  assert.equal(report.summary.risks.toolReplay.unpairedCalls, 2)
  assert.equal(byId['s-third'].toolRiskItems, 1)
  assert.equal(byId['s-third'].unpairedToolCalls, 1)
  assert.ok(byId['s-third'].risks.includes('tool_replay_marker'))
  assert.equal(byId['s-v2'].unpairedToolCalls, 1)
  assert.ok(byId['s-v2'].risks.includes('tool_call_unpaired'))

  // 4) v2 加密历史：unreadable，绝不尝试解密
  assert.deepEqual(report.summary.unreadableEncrypted, { sessions: 1, items: 2 })
  assert.deepEqual(report.summary.risks.encryptedUnreadable, { sessions: 1, items: 2 })
  assert.equal(byId['s-v2'].v2.encryptedItems, 2)
  assert.equal(byId['s-v2'].v2.encryptedTaskIds, 1)
  assert.equal(byId['s-v2'].v2.agentMessages, 1)
  assert.equal(byId['s-v2'].v2.unreadable, true)
  assert.equal(byId['s-v2'].v2.recoverable, false)
  assert.equal(byId['s-v2'].v2.reason, 'encrypted_content_opaque')
  assert.ok(byId['s-v2'].risks.includes('v2_encrypted_unreadable'))
  assert.equal(byId['s-official'].v2.unreadable, false)

  // 脱敏：不得出现消息正文 / 参数 / 密文 / 任务 id
  const json = JSON.stringify(report)
  for (const secret of [SECRET_OFFICIAL, SECRET_THIRD, SECRET_V2, CIPHER, TASKID, 'exec_command', 'unsupported call']) {
    assert.equal(json.includes(secret), false, '诊断输出不得包含: ' + secret)
  }

  // sha256 与文件实际哈希一致（迁移预演依赖它防并发篡改）
  const expected = sha256(await readFile(join(root, '2026/11/11/rollout-thirdparty.jsonl')))
  assert.equal(byId['s-third'].sha256, expected)
  assert.equal(byId['s-third'].relPath, '2026/11/11/rollout-thirdparty.jsonl')
  assert.ok(thirdParty.length > 0)
})

test('E7 迁移预演：只读计划（sha256/字段/备份建议），写入一律 not_authorized', { timeout: 30000 }, async (t) => {
  const { root } = await fixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await diagnoseHistory({ sessionsDir: root, catalog: ['gpt-6.1-sol'], now: NOW })
  const target = { provider: 'openai', model: 'gpt-6.1-sol' }

  const plan = await planSelectiveMigration({ sessions: ['s-third'], target }, { diagnosis: report, now: NOW })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.authorized, false)
  assert.equal(plan.writeSupported, false)
  assert.equal(plan.changes.length, 1)
  const change = plan.changes[0]
  assert.equal(change.relPath, '2026/11/11/rollout-thirdparty.jsonl')
  assert.equal(change.sessionId, 's-third')
  assert.match(change.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(change.fields.map((f) => f.field), ['session_meta.payload.model_provider', 'turn_context.payload.model'])
  assert.equal(change.fields[0].from, 'custom')
  assert.equal(change.fields[0].to, 'openai')
  assert.equal(change.fields[1].to, 'gpt-6.1-sol')
  assert.ok(change.fields[1].from.includes('deepseek-v4.1-flash'))
  assert.match(change.backupSuggested, /\.bak-/)
  assert.equal(plan.backup.suggested, true)
  assert.equal(plan.backup.files.length, 1)
  assert.equal(plan.totals.files, 1)
  assert.equal(plan.selection.matched.length, 1)

  // 只读：计划前后文件内容与 mtime 不变
  const p = join(root, change.relPath)
  const before = await readFile(p)
  const beforeStat = await stat(p)
  const plan2 = await planSelectiveMigration({ all: true, target }, { diagnosis: report, now: NOW })
  assert.equal(plan2.changes.length, 3, 'all:true 选中全部会话')
  const after = await readFile(p)
  assert.deepEqual(after, before, '预演不得修改历史文件')
  assert.equal((await stat(p)).mtimeMs, beforeStat.mtimeMs)

  // 未匹配的选择显式列出，不猜
  const none = await planSelectiveMigration({ sessions: ['no-such-session'], target }, { diagnosis: report, now: NOW })
  assert.equal(none.changes.length, 0)
  assert.deepEqual(none.selection.unmatched, ['no-such-session'])
  assert.ok(none.warnings.length > 0)

  // 写入接口：明确 not_authorized，绝不落盘
  await assert.rejects(applySelectiveMigration(), (e) => e.code === HISTORY_WRITE_NOT_AUTHORIZED)
  await assert.rejects(planSelectiveMigration({ sessions: ['s-third'], target, apply: true }, { diagnosis: report, now: NOW }), (e) => e.code === HISTORY_WRITE_NOT_AUTHORIZED)
  assert.deepEqual(await readFile(p), before, '被拒之后历史文件仍保持原样')
})

test('E7 输入边界：必须显式 sessions 目录；catalog 形态归一', async () => {
  const noDir = await diagnoseHistory({})
  assert.equal(noDir.enabled, false)
  assert.match(noDir.error, /显式/)
  assert.equal(noDir.sessions.length, 0)

  const missing = await diagnoseHistory({ sessionsDir: '/nonexistent/mg-codex-history-test' })
  assert.equal(missing.enabled, false)
  assert.match(missing.error, /目录不存在/)

  assert.deepEqual([...normalizeCatalog(['a', 'b', 'a'])].sort(), ['a', 'b'])
  assert.deepEqual([...normalizeCatalog({ data: [{ id: 'x' }, { slug: 'y' }] })].sort(), ['x', 'y'])
  assert.deepEqual([...normalizeCatalog({ models: [{ slug: 'm1' }, 'm2'] })].sort(), ['m1', 'm2'])
  assert.equal(normalizeCatalog(undefined).size, 0)
})
