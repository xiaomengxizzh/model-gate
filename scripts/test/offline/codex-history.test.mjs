// E7 / M4-3a 历史只读诊断回归：
//  · 根必须登记（不允许调用方传任意路径），符号链接/越根/不存在各有拒绝码；
//  · 只读（文件 hash + mtime + 目录清单前后一致）、迁移只能产出导出计划、写入一律 not_authorized；
//  · 限额（文件/字节/行数/行长）只能调低，超限**截断并标注**；
//  · 损坏 JSONL 记坏行数继续扫；输出结构化脱敏（无正文/密文/绝对路径/凭据）。
// 不读取 ~/.codex/sessions、不联网、不写任何历史文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  diagnoseHistory, planSelectiveMigration, applySelectiveMigration, normalizeCatalog,
  registerHistoryRoot, listHistoryRoots, unregisterHistoryRoot, clearHistoryRoots,
  HISTORY_ERROR, HISTORY_HARD_LIMITS, HISTORY_WRITE_NOT_AUTHORIZED, HISTORY_DIAGNOSIS_VERSION,
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

let seq = 0
async function fixtureRoot(t, over = {}) {
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
  if (over.badLine) await writeFile(join(dir, 'rollout-broken.jsonl'), over.badLine)
  let linked = false
  try { await symlink(join(dir, 'rollout-official.jsonl'), join(dir, 'rollout-link.jsonl')); linked = true } catch { /* 平台不支持符号链接则跳过 */ }

  const rootId = 'fixture-' + (++seq)
  const reg = registerHistoryRoot({ id: rootId, dir: root, label: 'fixture' }, { now: NOW })
  assert.equal(reg.ok, true, JSON.stringify(reg))
  t.after(async () => { clearHistoryRoots(); await rm(root, { recursive: true, force: true }) })
  return { root, dir, rootId, official, thirdParty, v2, linked }
}

test('M4-3a 根登记：只接受绝对路径/真实目录，符号链接与不存在都有拒绝码', { timeout: 30000 }, async (t) => {
  clearHistoryRoots()
  const root = await mkdtemp(join(tmpdir(), 'mg-root-reg-'))
  t.after(async () => { clearHistoryRoots(); await rm(root, { recursive: true, force: true }) })
  assert.equal(registerHistoryRoot({ id: 'a', dir: 'relative/path' }).code, HISTORY_ERROR.NO_ROOT)
  assert.equal(registerHistoryRoot({ id: 'bad id!', dir: root }).code, HISTORY_ERROR.NO_ROOT)
  assert.equal(registerHistoryRoot({ id: 'missing', dir: join(root, 'nope') }).code, HISTORY_ERROR.ROOT_MISSING)

  const file = join(root, 'file.txt')
  await writeFile(file, 'x')
  assert.equal(registerHistoryRoot({ id: 'file', dir: file }).code, HISTORY_ERROR.ROOT_NOT_DIR)

  const real = join(root, 'real')
  await mkdir(real)
  const link = join(root, 'link')
  try {
    await symlink(real, link)
    assert.equal(registerHistoryRoot({ id: 'link', dir: link }).code, HISTORY_ERROR.ROOT_SYMLINK)
  } catch { /* 平台不支持符号链接：跳过该断言 */ }

  const ok = registerHistoryRoot({ id: 'good', dir: real, label: 'safe-label' }, { now: NOW })
  assert.equal(ok.ok, true)
  assert.deepEqual(Object.keys(ok.root).sort(), ['id', 'label', 'registeredAt'])
  // 对外清单不含绝对路径
  const listed = listHistoryRoots()
  assert.deepEqual(listed.map((r) => r.id), ['good'])
  assert.ok(!JSON.stringify(listed).includes(root), '根清单不得含绝对路径')
  assert.equal(unregisterHistoryRoot('good'), true)
  assert.equal(unregisterHistoryRoot('good'), false)
})

test('E7 历史诊断：provider/model 统计、目录缺失、工具风险、v2 加密 unreadable、符号链接跳过', { timeout: 30000 }, async (t) => {
  const { root, rootId, thirdParty, linked } = await fixtureRoot(t)

  const report = await diagnoseHistory({ rootId, catalog: ['gpt-6.1-sol'], now: NOW })
  assert.equal(report.enabled, true)
  assert.equal(report.readOnly, true)
  assert.equal(report.catalogProvided, true)
  assert.equal(report.rootId, rootId)
  assert.equal(report.errorCode, '')
  assert.equal(report.scanned.files, 3, '只扫 .jsonl 普通文件（symlink 跳过、notes.txt 忽略）')
  assert.equal(report.scanned.sessions, 3)
  assert.equal(report.scanned.parseErrors, 0)
  assert.equal(report.scanned.skippedSymlinks, linked ? 1 : 0)
  assert.deepEqual(report.scanned.truncatedReasons, [])

  const providers = Object.fromEntries(report.summary.byProvider.map((p) => [p.provider, p]))
  assert.equal(providers.openai.sessions, 1)
  assert.equal(providers.openai.turns, 1)
  assert.equal(providers.custom.sessions, 2)
  assert.equal(providers.custom.turns, 3)
  const models = Object.fromEntries(report.summary.byModel.map((m) => [m.model, m]))
  assert.equal(models['gpt-6.1-sol'].turns, 1)
  assert.equal(models['gpt-6.1-sol'].inCatalog, true)
  assert.equal(models['deepseek-v4.1-flash'].turns, 3)
  assert.equal(models['deepseek-v4.1-flash'].inCatalog, false)

  const byId = Object.fromEntries(report.sessions.map((s) => [s.sessionId, s]))
  assert.equal(byId['s-official'].provider, 'openai')
  assert.deepEqual(byId['s-official'].models, [{ model: 'gpt-6.1-sol', turns: 1 }])
  assert.deepEqual(report.summary.missingModels, ['deepseek-v4.1-flash'])
  assert.equal(report.summary.risks.missingModels.sessions, 2)
  assert.ok(byId['s-third'].risks.includes('missing_model:deepseek-v4.1-flash'))

  assert.equal(report.summary.totals.toolCalls, 4)
  assert.equal(report.summary.risks.toolReplay.items, 1)
  assert.equal(report.summary.risks.toolReplay.unpairedCalls, 2)
  assert.equal(byId['s-third'].toolRiskItems, 1)
  assert.ok(byId['s-third'].risks.includes('tool_replay_marker'))
  assert.ok(byId['s-v2'].risks.includes('tool_call_unpaired'))

  assert.deepEqual(report.summary.unreadableEncrypted, { sessions: 1, items: 2 })
  assert.equal(byId['s-v2'].v2.encryptedItems, 2)
  assert.equal(byId['s-v2'].v2.encryptedTaskIds, 1)
  assert.equal(byId['s-v2'].v2.agentMessages, 1)
  assert.equal(byId['s-v2'].v2.unreadable, true)
  assert.equal(byId['s-v2'].v2.recoverable, false)
  assert.equal(byId['s-v2'].v2.reason, 'encrypted_content_opaque')

  // 脱敏：正文/参数/密文/任务 id 一律不出现；也不出现绝对路径。
  const json = JSON.stringify(report)
  for (const secret of [SECRET_OFFICIAL, SECRET_THIRD, SECRET_V2, CIPHER, TASKID, 'exec_command', 'unsupported call']) {
    assert.equal(json.includes(secret), false, '诊断输出不得包含: ' + secret)
  }
  assert.equal(json.includes(root), false, '诊断输出不得包含绝对路径')

  const expected = sha256(await readFile(join(root, '2026/11/11/rollout-thirdparty.jsonl')))
  assert.equal(byId['s-third'].sha256, expected)
  assert.equal(byId['s-third'].relPath, '2026/11/11/rollout-thirdparty.jsonl')
  assert.ok(thirdParty.length > 0)
})

test('M4-3a 根受限：未登记目录拒绝；rootId 缺失拒绝；逃生门仅隔离测试可用', { timeout: 30000 }, async (t) => {
  clearHistoryRoots()
  const root = await mkdtemp(join(tmpdir(), 'mg-root-unreg-'))
  t.after(async () => { clearHistoryRoots(); await rm(root, { recursive: true, force: true }) })
  await mkdir(join(root, 'x'), { recursive: true })

  const noRoot = await diagnoseHistory({})
  assert.equal(noRoot.enabled, false)
  assert.equal(noRoot.errorCode, HISTORY_ERROR.NO_ROOT)
  assert.equal(noRoot.sessions.length, 0)

  const unregistered = await diagnoseHistory({ sessionsDir: root })
  assert.equal(unregistered.enabled, false)
  assert.equal(unregistered.errorCode, HISTORY_ERROR.ROOT_NOT_REGISTERED)

  const unknownId = await diagnoseHistory({ rootId: 'nope' })
  assert.equal(unknownId.errorCode, HISTORY_ERROR.ROOT_NOT_REGISTERED)

  const escape = await diagnoseHistory({ sessionsDir: root, allowUnregisteredRoot: true })
  assert.equal(escape.enabled, true)
  assert.equal(escape.unregistered, true)
  assert.ok(escape.dirLabel.length > 0, '逃生门仍要有非空标签（便于日志区分）')
  assert.equal(escape.rootId, '')
})

test('M4-3a 限额：只能调低、超限截断并标注原因（文件/字节/行数）', { timeout: 30000 }, async (t) => {
  const { rootId } = await fixtureRoot(t)

  const fewFiles = await diagnoseHistory({ rootId, limits: { maxFiles: 1 }, now: NOW })
  assert.equal(fewFiles.scanned.files, 1)
  assert.equal(fewFiles.scanned.truncated, true)
  assert.deepEqual(fewFiles.scanned.truncatedReasons, ['files'])
  assert.ok(fewFiles.notes.some((n) => /上限/.test(n)), '截断必须写进 notes，不能静默')

  const fewLines = await diagnoseHistory({ rootId, limits: { maxLinesPerFile: 1 }, now: NOW })
  assert.equal(fewLines.scanned.truncated, true)
  assert.ok(fewLines.scanned.truncatedReasons.includes('lines'))
  assert.ok(fewLines.sessions.every((s) => s.turns <= 0), '每个文件只读一行（session_meta），后续行不再解析')

  const fewBytes = await diagnoseHistory({ rootId, limits: { maxTotalBytes: 1 }, now: NOW })
  assert.equal(fewBytes.scanned.truncated, true)
  assert.ok(fewBytes.scanned.truncatedReasons.includes('bytes'))
  assert.equal(fewBytes.scanned.files, 0)

  // 只能调低：传超出硬上限的值会被夹回硬上限，传 0/负数回落默认。
  const clamped = await diagnoseHistory({ rootId, limits: { maxFiles: 10_000_000, maxTotalBytes: 0 }, now: NOW })
  assert.equal(clamped.limits.maxFiles, HISTORY_HARD_LIMITS.maxFiles)
  assert.equal(clamped.limits.maxTotalBytes, HISTORY_HARD_LIMITS.maxTotalBytes)
})

test('M4-3a 损坏 JSONL：记坏行数而不是整体崩，其余会话照常诊断', { timeout: 30000 }, async (t) => {
  const { rootId } = await fixtureRoot(t, { badLine: '{"type":"session_meta","payload":{broken\n' + 'not json at all\n' })
  const report = await diagnoseHistory({ rootId, now: NOW })
  assert.equal(report.enabled, true)
  assert.equal(report.scanned.parseErrors, 1, '带关键字但 JSON 解析失败的行计入坏行')
  assert.equal(report.scanned.files, 4, '损坏文件仍被扫描（不是整体失败）')
  assert.equal(report.scanned.sessions, 4)
  assert.ok(report.sessions.some((s) => s.relPath.endsWith('rollout-broken.jsonl')))
})

test('M4-3a 只读承诺：诊断与计划前后文件 hash/mtime/目录清单完全不变', { timeout: 30000 }, async (t) => {
  const { root, rootId } = await fixtureRoot(t)
  const dir = join(root, '2026/11/11')
  const beforeNames = (await readdir(dir)).sort()
  const before = new Map()
  for (const name of beforeNames) {
    const p = join(dir, name)
    const st = await stat(p)
    before.set(name, { sha: sha256(await readFile(p)), mtime: st.mtimeMs, size: st.size })
  }

  const report = await diagnoseHistory({ rootId, now: NOW })
  await planSelectiveMigration({ all: true, target: { provider: 'openai', model: 'gpt-6.1-sol' } }, { diagnosis: report, now: NOW })

  const afterNames = (await readdir(dir)).sort()
  assert.deepEqual(afterNames, beforeNames, '不得新增/删除文件（含 .bak）')
  for (const name of afterNames) {
    const p = join(dir, name)
    const st = await stat(p)
    assert.equal(sha256(await readFile(p)), before.get(name).sha, '文件内容不得改变: ' + name)
    assert.equal(st.mtimeMs, before.get(name).mtime, 'mtime 不得改变: ' + name)
    assert.equal(st.size, before.get(name).size)
  }
})

test('E7 迁移预演：只读导出计划（sha256/字段/备份建议），写入一律 not_authorized', { timeout: 30000 }, async (t) => {
  const { root, rootId } = await fixtureRoot(t)
  const report = await diagnoseHistory({ rootId, catalog: ['gpt-6.1-sol'], now: NOW })
  const target = { provider: 'openai', model: 'gpt-6.1-sol' }

  const plan = await planSelectiveMigration({ sessions: ['s-third'], target }, { diagnosis: report, now: NOW })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.authorized, false)
  assert.equal(plan.writeSupported, false)
  assert.equal(plan.apply.supported, false)
  assert.equal(plan.apply.code, HISTORY_WRITE_NOT_AUTHORIZED)
  assert.equal(plan.export.format, 'codex-sessions-export-plan-v1')
  assert.equal(plan.export.files.length, 1)
  assert.equal(plan.changes.length, 1)
  const change = plan.changes[0]
  assert.equal(change.relPath, '2026/11/11/rollout-thirdparty.jsonl')
  assert.match(change.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(change.fields.map((f) => f.field), ['session_meta.payload.model_provider', 'turn_context.payload.model'])
  assert.equal(change.fields[0].from, 'custom')
  assert.equal(change.fields[0].to, 'openai')
  assert.match(change.backupSuggested, /\.bak-/)
  assert.equal(plan.totals.files, 1)

  // 计划本身也不得含绝对路径/正文
  const planJson = JSON.stringify(plan)
  assert.equal(planJson.includes(root), false, '计划不得含绝对路径')
  for (const secret of [SECRET_THIRD, CIPHER, TASKID]) assert.equal(planJson.includes(secret), false)

  // 用 rootId 直接出计划（不传 diagnosis）也必须只读可用
  const viaRootId = await planSelectiveMigration({ sessions: ['s-third'], target }, { rootId, now: NOW })
  assert.equal(viaRootId.changes.length, 1)

  // 选择里的绝对路径/敏感值被脱敏，不回显
  const dirty = await planSelectiveMigration({ sessions: ['/home/user/secret-session', 'sk-live-ABC123456789'] }, { diagnosis: report, now: NOW })
  assert.deepEqual(dirty.selection.requested, ['redacted', 'redacted'])
  assert.equal(dirty.selection.unmatched.length, 2)
  assert.ok(dirty.selection.unmatched.every((v) => v === 'redacted'))

  // 目标 provider/model 的敏感/路径形态被清空（不允许通过迁移计划注入）
  const badTarget = await planSelectiveMigration({ sessions: ['s-third'], target: { provider: '/etc/passwd', model: 'sk-live-ABC123456789' } }, { diagnosis: report, now: NOW })
  assert.equal(badTarget.target.provider, '')
  assert.equal(badTarget.target.model, '')

  // 未匹配显式列出
  const none = await planSelectiveMigration({ sessions: ['no-such-session'], target }, { diagnosis: report, now: NOW })
  assert.equal(none.changes.length, 0)
  assert.deepEqual(none.selection.unmatched, ['no-such-session'])
  assert.ok(none.warnings.length > 0)

  await assert.rejects(applySelectiveMigration(), (e) => e.code === HISTORY_WRITE_NOT_AUTHORIZED)
  await assert.rejects(planSelectiveMigration({ sessions: ['s-third'], target, apply: true }, { diagnosis: report, now: NOW }), (e) => e.code === HISTORY_WRITE_NOT_AUTHORIZED)

  // 没有可用诊断/根时，计划显式报错而不是假装成功
  const noDiag = await planSelectiveMigration({ all: true }, {})
  assert.ok(noDiag.errorCode)
  assert.equal(noDiag.changes.length, 0)
})

test('M4-3a 根被替换成符号链接：诊断拒绝（防越根）', { timeout: 30000 }, async (t) => {
  const { root, rootId } = await fixtureRoot(t)
  const other = await mkdtemp(join(tmpdir(), 'mg-root-swap-'))
  t.after(async () => { await rm(other, { recursive: true, force: true }) })
  // 把已登记的根换成一个符号链接到别处
  await rm(root, { recursive: true, force: true })
  try {
    await symlink(other, root)
  } catch {
    return // 平台不支持符号链接：本用例跳过（其余用例已覆盖）
  }
  const report = await diagnoseHistory({ rootId, now: NOW })
  assert.equal(report.enabled, false)
  assert.equal(report.errorCode, HISTORY_ERROR.ROOT_SYMLINK)
})

test('E7 输入边界：catalog 形态归一（root 与 path 的边界见上）', async () => {
  assert.equal(HISTORY_DIAGNOSIS_VERSION, 1)
  assert.deepEqual([...normalizeCatalog(['a', 'b', 'a'])].sort(), ['a', 'b'])
  assert.deepEqual([...normalizeCatalog({ data: [{ id: 'x' }, { slug: 'y' }] })].sort(), ['x', 'y'])
  assert.deepEqual([...normalizeCatalog({ models: [{ slug: 'm1' }, 'm2'] })].sort(), ['m1', 'm2'])
  assert.equal(normalizeCatalog(undefined).size, 0)
})
