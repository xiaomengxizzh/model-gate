#!/usr/bin/env node
// E7 迁移流程演练（隔离副本）：诊断 → 只读预演 → 受控模拟迁移（备份/临时文件+rename）→ 回滚校验。
// 只在 mkdtemp 合成会话上操作，绝不触碰真实 ~/.codex/sessions；产品写入接口仍抛 not_authorized。
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { diagnoseHistory, planSelectiveMigration, applySelectiveMigration } from '../../src/codex/history.js'

const NL = String.fromCharCode(10)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const checks = []
const check = (n, ok, d) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' :: ' + d : '')) }

const root = await mkdtemp(join(tmpdir(), 'mg-e7-drill-'))
const dir = join(root, '2026', '11', '11')
await mkdir(dir, { recursive: true })
const meta = (id, provider) => JSON.stringify({ timestamp: '2026-11-11T11:00:00Z', type: 'session_meta', payload: { session_id: id, model_provider: provider, cwd: '/tmp/p' } }) + NL
const turn = (model) => JSON.stringify({ timestamp: '2026-11-11T11:00:01Z', type: 'turn_context', payload: { model } }) + NL
const files = {
  'a-official.jsonl': meta('s-a', 'openai') + turn('gpt-6.1-sol'),
  'b-third.jsonl': meta('s-b', 'custom') + turn('deepseek-v4.1-flash') + turn('deepseek-v4.1-flash'),
  'c-v2.jsonl': meta('s-c', 'custom') + turn('deepseek-v4.1-flash') + JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'CIPHER' }] } }) + NL,
}
for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body)
const original = {}
for (const name of Object.keys(files)) original[name] = sha(await readFile(join(dir, name)))

try {
  const diag = await diagnoseHistory({ sessionsDir: root })
  const parseErrors = (diag.summary && diag.summary.parseErrors != null) ? diag.summary.parseErrors : (diag.parseErrors != null ? diag.parseErrors : 0)
  check('诊断到 3 个会话且无解析错误', diag.enabled === true && diag.summary.sessions === 3 && parseErrors === 0, JSON.stringify({ s: diag.summary.sessions, e: parseErrors }))

  const plan = await planSelectiveMigration({ sessions: ['s-b'], targetProvider: 'openai', targetModel: 'gpt-6-astra' }, { sessionsDir: root })
  check('预演为只读（dryRun/authorized=false/writeSupported=false）', plan.dryRun === true && plan.authorized === false && plan.writeSupported === false)
  check('只选中 1 个会话（c-v2 加密会话不在内）', plan.changes.length === 1 && plan.changes[0].relPath.includes('b-third'), 'changes=' + plan.changes.length)
  const plannedSha = plan.changes[0].sha256
  check('预演记录的 sha256 与实际文件一致', plannedSha === original['b-third.jsonl'], plannedSha.slice(0, 8))
  check('预演给出备份路径与 tmp+rename 写模式', !!plan.changes[0].backupSuggested && plan.changes[0].writeMode === 'tmp+rename', plan.changes[0].backupSuggested)

  let denied = false
  try { await applySelectiveMigration({}) } catch (e) { denied = e && e.code === 'not_authorized' }
  check('产品写入接口仍拒绝（not_authorized）', denied)

  // —— 受控模拟迁移（脚本侧，非产品代码）：备份 → 临时文件 → rename ——
  const target = join(dir, 'b-third.jsonl')
  const bak = target + '.bak-20261111T120000Z'
  await copyFile(target, bak)
  const raw = await readFile(target, 'utf8')
  const migrated = raw.split(NL).filter(Boolean).map((line) => {
    const o = JSON.parse(line)
    if (o.type === 'session_meta') o.payload.model_provider = 'openai'
    if (o.type === 'turn_context') o.payload.model = 'gpt-6-astra'
    return JSON.stringify(o)
  }).join(NL) + NL
  const tmp = target + '.tmp'
  await writeFile(tmp, migrated)
  await rename(tmp, target)

  check('备份文件与原始字节一致', sha(await readFile(bak)) === original['b-third.jsonl'])
  check('只有被选中的会话被修改', sha(await readFile(target)) !== original['b-third.jsonl'])
  check('未选中的两个会话字节未变', sha(await readFile(join(dir, 'a-official.jsonl'))) === original['a-official.jsonl'] && sha(await readFile(join(dir, 'c-v2.jsonl'))) === original['c-v2.jsonl'])
  const after = await diagnoseHistory({ sessionsDir: root })
  const bRow = (after.sessions || []).find((r) => String(r.relPath || '').includes('b-third'))
  check('迁移后诊断显示新 provider/model', !!bRow && bRow.provider === 'openai' && (bRow.models || []).some((m) => m.model === 'gpt-6-astra'), JSON.stringify(bRow && { p: bRow.provider, m: (bRow.models || []).map((x) => x.model) }))

  // —— 回滚 ——
  await copyFile(bak, target)
  const restored = {}
  for (const n of Object.keys(original)) restored[n] = sha(await readFile(join(dir, n)))
  check('回滚后三个会话与原始快照完全一致', Object.keys(original).every((n) => restored[n] === original[n]))
} finally {
  await rm(root, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log(NL + (checks.length - failed) + '/' + checks.length + ' migration-drill checks passed')
process.exitCode = failed ? 1 : 0
