// MG-FIX-P0-02 / G4 调查钉子：压缩与同子恢复的协议/能力/记账不变量（纯离线，零额度）。
//
// 本套件不执行 Codex CLI、不联网、不读写真实 ~/.codex 或凭据、不发任何模型请求。
// 它锁定的是「根因调查确认当前正确」的不变量：
//   · provider 能力 remote_compaction 只接受 unsupported | v2，managed provider 默认 unsupported；
//   · codex.nativeCompaction 能力归属投影；compaction 项 preserve/reject/drop 的 typed 闸门；
//   · compaction_trigger 仅 codex-owned-remote 透传；本地压缩提示逐字透传、网关不自建摘要/密文；
//   · cell 账本唯一终态、终态后拒绝重复派单、未让出 cell 的 wait fail-closed；
//   · 能力记账诚实（无 PASS_REAL；压缩与同子恢复如实标注）。
//
// 事实来源：docs/evidence/2026-11-16-v3-compaction-investigation.md
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CODEX_NATIVE_COMPACTION_CAPABILITIES,
  classifyCodexInputItem,
  isOpaqueCompactionItem,
  nativeCompactionCapability,
  projectOrderedHistory,
} from '../../../src/codex/interop.js'
import { replayCodeMode, CELL_CODES } from '../../../src/codex/native-cells.js'
import { REMOTE_COMPACTION_LITERALS, buildManagedProviderSection } from '../../../src/codex/config.js'
import {
  CAPABILITY_STATUSES,
  NATIVE_CAPABILITIES,
  nativeCapabilityInventory,
} from '../../../src/codex/native-capabilities.js'

const CIPHER = 'gAAAAABp-investigation-ciphertext-not-decryptable-by-gateway'

function route(patch = {}) {
  const codex = {
    multiAgentVersion: 'v2',
    plaintextTools: true,
    namespace: 'collaboration',
    history: Object.assign({ agentMessage: 'project', reasoning: 'drop', compaction: 'reject' }, patch.history),
  }
  if (patch.nativeCompaction !== undefined) codex.nativeCompaction = patch.nativeCompaction
  return { alias: 'mg-opencodego-deepseek-v4-1-flash', provider: 'opencodego', upstreamModel: 'deepseek-v4.1-flash', api: 'responses', codex }
}
function userTurn(text) { return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
function cipherCompaction(overrides = {}) {
  return Object.assign({ type: 'compaction', id: 'cmp_inv_01', encrypted_content: CIPHER }, overrides)
}
function localMarker(overrides = {}) {
  return Object.assign({ type: 'context_compaction', id: 'ctx_inv_01' }, overrides) // 无密文 = 本地压缩标记
}

// —— 1. provider 级 remote_compaction 能力声明 ——

test('remote_compaction 枚举只接受 unsupported | v2（0.167.x serde 实证）', () => {
  assert.deepEqual([...REMOTE_COMPACTION_LITERALS], ['unsupported', 'v2'])
})

test('managed provider 默认声明 remote_compaction=unsupported 并写到正确 TOML 路径', () => {
  const sec = buildManagedProviderSection({ openaiBaseUrl: 'http://127.0.0.1:8787/v1' })
  assert.equal(sec.remoteCompaction, 'unsupported')
  assert.equal(sec.sections['model_providers.modelgate.capabilities'].remote_compaction, 'unsupported')
  assert.equal(sec.sections['model_providers.modelgate'].wire_api, 'responses')
  assert.equal(sec.sections['model_providers.modelgate'].base_url, 'http://127.0.0.1:8787/v1')
  assert.equal(sec.sections['model_providers.modelgate'].requires_openai_auth, false)
  assert.equal(sec.sections['model_providers.modelgate'].supports_websockets, false)
  assert.equal('env_key' in sec.sections['model_providers.modelgate'], false)
})

test('managed provider 拒绝未授权的 remote_compaction 字面量', () => {
  assert.throws(
    () => buildManagedProviderSection({ openaiBaseUrl: 'http://127.0.0.1:8787/v1', remoteCompaction: 'auto' }),
    (err) => err && err.code === 'invalid_compaction_capability',
  )
})

// —— 2. codex.nativeCompaction 能力归属投影 ——

test('CODEX_NATIVE_COMPACTION_CAPABILITIES 取值受控', () => {
  assert.deepEqual([...CODEX_NATIVE_COMPACTION_CAPABILITIES], ['codex-owned-local', 'codex-owned-remote', 'unsupported'])
})

test('nativeCompactionCapability：声明原样返回，未声明返回 null', () => {
  assert.equal(nativeCompactionCapability(route({ nativeCompaction: 'codex-owned-local' })), 'codex-owned-local')
  assert.equal(nativeCompactionCapability(route({ nativeCompaction: 'codex-owned-remote' })), 'codex-owned-remote')
  assert.equal(nativeCompactionCapability(route({ nativeCompaction: 'unsupported' })), 'unsupported')
  assert.equal(nativeCompactionCapability(route()), null)
})

// —— 3. 密文项判别 ——

test('isOpaqueCompactionItem：compaction 恒为密文；context_compaction 仅在有密文时升级', () => {
  assert.equal(isOpaqueCompactionItem(cipherCompaction()), true)
  assert.equal(isOpaqueCompactionItem(localMarker()), false)
  assert.equal(isOpaqueCompactionItem(localMarker({ encrypted_content: '' })), false)
  assert.equal(isOpaqueCompactionItem(localMarker({ encrypted_content: CIPHER })), true)
  assert.equal(isOpaqueCompactionItem(userTurn('x')), false)
  assert.equal(isOpaqueCompactionItem(null), false)
})

// —— 4. 压缩项 preserve / reject / drop typed 闸门 ——

test('preserve + 本地 context_compaction 标记：原样透传，不依赖远端能力声明', () => {
  for (const cap of ['codex-owned-local', 'unsupported', undefined]) {
    const r = projectOrderedHistory([localMarker()], route({ nativeCompaction: cap, history: { compaction: 'preserve' } }), null)
    assert.equal(r.rejected, null, String(cap))
    assert.deepEqual(r.input[0], localMarker(), String(cap))
  }
})

test('preserve + 密文 compaction：仅 codex-owned-remote 透传，其余 typed 拒绝且不补造密文', () => {
  const remote = projectOrderedHistory([cipherCompaction()], route({ nativeCompaction: 'codex-owned-remote', history: { compaction: 'preserve' } }), null)
  assert.equal(remote.rejected, null)
  assert.equal(remote.input[0].encrypted_content, CIPHER)

  const local = projectOrderedHistory([cipherCompaction()], route({ nativeCompaction: 'codex-owned-local', history: { compaction: 'preserve' } }), null)
  assert.equal(local.rejected && local.rejected.code, 'native_compaction_route_mismatch')

  const undeclared = projectOrderedHistory([cipherCompaction()], route({ history: { compaction: 'preserve' } }), null)
  assert.equal(undeclared.rejected && undeclared.rejected.code, 'native_compaction_route_not_ready')

  const unsupported = projectOrderedHistory([cipherCompaction()], route({ nativeCompaction: 'unsupported', history: { compaction: 'preserve' } }), null)
  assert.equal(unsupported.rejected && unsupported.rejected.code, 'native_compaction_route_not_ready')
})

test('preserve + 缺非空 encrypted_content 的 compaction：typed 拒绝，网关不补造密文', () => {
  const bad = cipherCompaction({ encrypted_content: '' })
  const r = projectOrderedHistory([bad], route({ nativeCompaction: 'codex-owned-remote', history: { compaction: 'preserve' } }), null)
  assert.equal(r.rejected && r.rejected.code, 'native_compaction_item_malformed')
})

test('drop 显式丢弃压缩项并记 lossy；reject（默认）typed 拒绝，均不伪造成功', () => {
  const dropped = projectOrderedHistory([cipherCompaction()], route({ history: { compaction: 'drop' } }), null)
  assert.equal(dropped.rejected, null)
  assert.equal(dropped.input.length, 0)
  assert.ok(dropped.lossy.includes('compaction_dropped'))

  const markerDropped = projectOrderedHistory([localMarker()], route({ history: { compaction: 'drop' } }), null)
  assert.ok(markerDropped.lossy.includes('context_compaction_marker_dropped'))

  const rejected = projectOrderedHistory([cipherCompaction()], route(), null)
  assert.equal(rejected.rejected && rejected.rejected.code, 'unsupported_input_item')
})

// —— 5. 触发标记闸门 ——

test('compaction_trigger 分类正确，且仅 codex-owned-remote 透传', () => {
  const trigger = { type: 'compaction_trigger' }
  assert.equal(classifyCodexInputItem(trigger), 'compaction_trigger')
  const ok = projectOrderedHistory([trigger], route({ nativeCompaction: 'codex-owned-remote' }), null)
  assert.equal(ok.rejected, null)
  assert.deepEqual(ok.input[ok.input.length - 1], trigger)
  for (const cap of ['codex-owned-local', 'unsupported', undefined]) {
    const blocked = projectOrderedHistory([trigger], route({ nativeCompaction: cap }), null)
    assert.equal(blocked.rejected && blocked.rejected.code, 'native_compaction_route_not_ready', String(cap))
  }
})

// —— 6. 无网关侧总结 / 伪造压缩产物 ——

const COMPACT_PROMPT = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.'

test('本地压缩提示逐字透传（网关不总结、不改写）', () => {
  const r = projectOrderedHistory([userTurn(COMPACT_PROMPT)], route({ nativeCompaction: 'codex-owned-local', history: { compaction: 'preserve' } }), null)
  assert.equal(r.rejected, null)
  assert.equal(r.input[0].content[0].text, COMPACT_PROMPT)
})

test('静态源码检查：interop 不构造加密压缩产物', () => {
  const src = readFileSync(new URL('../../../src/codex/interop.js', import.meta.url), 'utf8')
  assert.ok(!/encrypted_content\s*:\s*['"`]/.test(src), 'interop 不得生成 encrypted_content 字面量')
  assert.ok(!/compaction\s*:\s*\{\s*type/.test(src), 'interop 不得构造 compaction 响应对象')
})

// —— 7. cell 账本：同子/中断的网关不变量（与 childId 复用正交，不可越界自造线程） ——

function fnCall(callId, name, args) { return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } }
function fnOut(callId, payload) { return { type: 'function_call_output', call_id: callId, output: JSON.stringify(payload) } }
function normalCellHistory() {
  return [
    fnCall('exec-1', 'exec', {}),
    fnOut('exec-1', { cell_id: 'cell-1', status: 'running' }),
    fnCall('wait-1', 'wait', { cell_id: 'cell-1' }),
    fnOut('wait-1', { cell_id: 'cell-1', status: 'completed' }),
  ]
}

test('cell 账本：yield→wait→终态 恰好一个终态，无孤儿、无重复派单', () => {
  const r = replayCodeMode(normalCellHistory())
  assert.equal(r.ok, true)
  assert.equal(r.rejected, null)
  assert.equal(r.snapshot.terminal, 1)
  assert.equal(r.snapshot.live, 0)
  assert.equal(r.snapshot.duplicateDispatches, 0)
  assert.deepEqual(r.snapshot.orphans, [])
})

test('cell 账本：终态后重复 wait → duplicate_dispatch（拒绝重复派单，不静默丢弃）', () => {
  const r = replayCodeMode(normalCellHistory().concat([fnCall('wait-2', 'wait', { cell_id: 'cell-1' })]))
  assert.equal(r.ok, false)
  assert.equal(r.rejected && r.rejected.code, CELL_CODES.duplicateDispatch)
})

test('cell 账本：wait 指向未让出的 cell → fail-closed（unbound）', () => {
  const r = replayCodeMode([fnCall('wait-x', 'wait', { cell_id: 'ghost' })])
  assert.equal(r.ok, false)
  assert.equal(r.rejected && r.rejected.code, CELL_CODES.unbound)
})

// —— 8. 诚实能力记账（压缩/同子恢复如实标注，无 PASS_REAL） ——

test('能力清单：无 PASS_REAL，整体不宣称 Agent Team 完成', () => {
  assert.deepEqual([...CAPABILITY_STATUSES], ['PASS_MOCK', 'NOT_ACCEPTED', 'BLOCKED', 'NOT_TESTED'])
  assert.equal(NATIVE_CAPABILITIES.some((c) => c.status === 'PASS_REAL'), false)
  const inv = nativeCapabilityInventory()
  assert.equal(inv.agentTeamComplete, false)
  assert.ok(inv.gaps.length > 0)
})

test('能力清单：压缩与同子恢复两项如实标注（BLOCKED / NOT_ACCEPTED）', () => {
  const byId = new Map(NATIVE_CAPABILITIES.map((c) => [c.id, c]))
  const compaction = byId.get('native_compaction_codex_owned')
  const resume = byId.get('same_child_resume_after_interrupt')
  assert.ok(compaction, '缺少 native_compaction_codex_owned 记账项')
  assert.ok(resume, '缺少 same_child_resume_after_interrupt 记账项')
  assert.equal(compaction.status, 'BLOCKED')
  assert.equal(typeof compaction.blocker, 'string')
  assert.ok(compaction.blocker.length >= 10)
  assert.equal(resume.status, 'NOT_ACCEPTED')
  assert.ok(resume.missing && Array.isArray(resume.missing.messageTypes))
  assert.ok(Array.isArray(resume.missing.fields))
  assert.ok(typeof resume.missing.why === 'string' && resume.missing.why.length >= 20)
})
