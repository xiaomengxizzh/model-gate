// V2-04（A1）离线协议回归：Codex 原生压缩的协议保真、路由能力闸门与 typed 拒绝。
//
// 纯离线：不执行 CLI、不联网、不读 HOME/auth/真实会话、不发起任何模型请求。
// 被测对象：src/codex/interop.js（压缩项投影）与 src/codex/catalog.js（目录/能力元数据）。
//
// 本机证据（只读侦察，详见 docs/reference/codex-catalog.md / 配置参考）：
//   · codex-cli 0.167.0（CLI）与 0.167.0-alpha.3.2（Desktop 捆绑）二进制包含
//     core/src/compact.rs（本地压缩提示 "CONTEXT CHECKPOINT COMPACTION"）与
//     core/src/compact_remote_v2.rs（远程压缩），app-server v2 schema 定义
//     ResponseItem: compaction{encrypted_content 必填} / context_compaction / compaction_trigger；
//   · 本机真实 rollout 的 replacement_history 里可见 30–61KB 的 compaction 密文项（官方远程路径）；
//   · 官方目录逐模型携带 auto_compact_token_limit（Codex 客户端据此触发**自己的**压缩）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODEX_NATIVE_COMPACTION_CAPABILITIES,
  classifyCodexInputItem,
  isOpaqueCompactionItem,
  nativeCompactionCapability,
  projectOrderedHistory,
  analyzeToolPairs,
} from '../../../src/codex/interop.js'
import { prepareCodexNativeRequest } from '../../../src/responses.js'
import * as C from '../../../src/codex/catalog.js'

const OPAQUE = 'gAAAAABp-native-compaction-ciphertext-not-decryptable-by-gateway'

function makeRoute(patch = {}) {
  const codex = {
    multiAgentVersion: 'v2',
    plaintextTools: true,
    history: Object.assign({ agentMessage: 'project', reasoning: 'drop', compaction: 'reject' }, patch.history),
    namespace: 'collaboration',
  }
  if (patch.nativeCompaction !== undefined) codex.nativeCompaction = patch.nativeCompaction
  return {
    alias: 'codex-deepseek',
    provider: 'opencode-go',
    upstreamModel: 'deepseek-v4.1-flash',
    api: 'responses',
    codex,
  }
}

function opaqueCompaction(overrides = {}) {
  return Object.assign({
    type: 'compaction',
    id: 'cmp_01a1d2cc',
    encrypted_content: OPAQUE,
    internal_chat_message_metadata_passthrough: { source: 'official-remote-compaction' },
  }, overrides)
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

function compactionRoute(patch = {}) {
  return makeRoute(Object.assign({ history: { compaction: 'preserve' } }, patch))
}

// ---------------------------------------------------------------------------
// 分类与不透明判定
// ---------------------------------------------------------------------------

test('V2-04 分类：compaction / context_compaction 都显式识别，未知类型仍 fail-closed', () => {
  assert.equal(classifyCodexInputItem({ type: 'compaction' }), 'compaction')
  assert.equal(classifyCodexInputItem({ type: 'context_compaction' }), 'context_compaction')
  assert.equal(classifyCodexInputItem({ type: 'compaction_trigger' }), 'unknown')
  assert.equal(classifyCodexInputItem({ type: 'mystery' }), 'unknown')
})

test('V2-04 不透明判定：compaction 恒为密文；context_compaction 只有带密文才算不透明', () => {
  assert.equal(isOpaqueCompactionItem(opaqueCompaction()), true)
  assert.equal(isOpaqueCompactionItem({ type: 'context_compaction' }), false)
  assert.equal(isOpaqueCompactionItem({ type: 'context_compaction', encrypted_content: null }), false)
  assert.equal(isOpaqueCompactionItem({ type: 'context_compaction', encrypted_content: OPAQUE }), true)
  assert.equal(isOpaqueCompactionItem({ type: 'message', role: 'user' }), false)
  assert.equal(nativeCompactionCapability(makeRoute()), null)
  assert.equal(nativeCompactionCapability(makeRoute({ nativeCompaction: 'codex-owned-remote' })), 'codex-owned-remote')
  assert.equal(nativeCompactionCapability(makeRoute({ nativeCompaction: 'bogus' })), null)
  assert.deepEqual(CODEX_NATIVE_COMPACTION_CAPABILITIES, ['codex-owned-local', 'codex-owned-remote', 'unsupported'])
})

// ---------------------------------------------------------------------------
// 原样透传：不改字面量、不重排、不补造密文
// ---------------------------------------------------------------------------

test('V2-04 preserve + codex-owned-remote：密文 compaction 原样透传，零 lossy', () => {
  const item = deepFreeze(opaqueCompaction())
  const input = deepFreeze([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before compact' }] }, item])
  const result = projectOrderedHistory(input, compactionRoute({ nativeCompaction: 'codex-owned-remote' }), null)
  assert.equal(result.rejected, null)
  assert.deepEqual(result.lossy, [])
  assert.equal(result.input.length, 2)
  assert.deepEqual(result.input[1], item)
  assert.equal(result.input[1].encrypted_content, OPAQUE)
  assert.deepEqual(Object.keys(result.input[1]), Object.keys(item), '不得新增/删除字段')
})

test('V2-04 preserve + codex-owned-remote：context_compaction 标记（无密文）也可原样保留', () => {
  const marker = deepFreeze({ type: 'context_compaction', id: 'ctx_1' })
  const result = projectOrderedHistory([marker], compactionRoute({ nativeCompaction: 'codex-owned-remote' }), null)
  assert.equal(result.rejected, null)
  assert.deepEqual(result.input, [marker])
})

test('V2-04 preserve + codex-owned-local：本地压缩标记允许，但密文项必须 typed 拒绝（路径不一致）', () => {
  const route = compactionRoute({ nativeCompaction: 'codex-owned-local' })
  const marker = projectOrderedHistory([{ type: 'context_compaction' }], route, null)
  assert.equal(marker.rejected, null)
  assert.equal(marker.input.length, 1)

  const opaque = projectOrderedHistory([opaqueCompaction()], route, null)
  assert.equal(opaque.input, null)
  assert.equal(opaque.rejected.code, 'native_compaction_route_mismatch')
})

// ---------------------------------------------------------------------------
// 拒绝路径：未声明能力 / 缺密文 / 默认 reject —— 都是 typed error、零上游请求
// ---------------------------------------------------------------------------

test('V2-04 preserve 但未声明 nativeCompaction：typed native_compaction_route_not_ready，不静默丢弃', () => {
  const result = projectOrderedHistory(deepFreeze([opaqueCompaction()]), compactionRoute(), null)
  assert.equal(result.input, null)
  assert.equal(result.rejected.code, 'native_compaction_route_not_ready')
  assert.match(result.rejected.message, /拒绝静默丢弃/)
  assert.deepEqual(result.lossy, [], '拒绝路径不得同时声称“已丢弃”以伪装成功')
})

test('V2-04 preserve + unsupported 能力：同样 typed 拒绝，不猜测上游行为', () => {
  const result = projectOrderedHistory([opaqueCompaction()], compactionRoute({ nativeCompaction: 'unsupported' }), null)
  assert.equal(result.input, null)
  assert.equal(result.rejected.code, 'native_compaction_route_not_ready')
})

test('V2-04 缺 encrypted_content 的 compaction：拒绝且不补造密文', () => {
  const malformed = deepFreeze({ type: 'compaction', id: 'cmp_bad' })
  const result = projectOrderedHistory([malformed], compactionRoute({ nativeCompaction: 'codex-owned-remote' }), null)
  assert.equal(result.input, null)
  assert.equal(result.rejected.code, 'native_compaction_item_malformed')
  assert.match(result.rejected.message, /不补造密文/)
})

test('V2-04 默认 reject：仍为 unsupported_input_item（既有契约码不漂移）', () => {
  const result = projectOrderedHistory([opaqueCompaction()], makeRoute(), null)
  assert.equal(result.input, null)
  assert.equal(result.rejected.code, 'unsupported_input_item')
})

test('V2-04 显式 drop：只允许有明确 lossy 代码，不得当作“压缩成功”', () => {
  const route = makeRoute({ history: { compaction: 'drop' } })
  const dropped = projectOrderedHistory([opaqueCompaction()], route, null)
  assert.equal(dropped.rejected, null)
  assert.deepEqual(dropped.input, [])
  assert.ok(dropped.lossy.includes('compaction_dropped'))

  const markerRoute = makeRoute({ history: { compaction: 'drop' } })
  const marker = projectOrderedHistory([{ type: 'context_compaction' }], markerRoute, null)
  assert.deepEqual(marker.input, [])
  assert.ok(marker.lossy.includes('context_compaction_marker_dropped'))
})

// ---------------------------------------------------------------------------
// 工具 call_id 配对与“压缩后同一子会话继续”
// ---------------------------------------------------------------------------

test('V2-04 压缩前后工具 call_id 配对完整、顺序不变', () => {
  const input = deepFreeze([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'TASK_A' }] },
    { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"printf A5_CHILD_TOOL_OK"}' },
    { type: 'function_call_output', call_id: 'call_a', output: 'A5_CHILD_TOOL_OK' },
    opaqueCompaction(),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续，并回忆第一次工具标记' }] },
    { type: 'function_call', call_id: 'call_b', name: 'shell', arguments: '{"cmd":"printf B"}' },
    { type: 'function_call_output', call_id: 'call_b', output: 'B' },
  ])
  const result = projectOrderedHistory(input, compactionRoute({ nativeCompaction: 'codex-owned-remote' }), null)
  assert.equal(result.rejected, null)
  assert.deepEqual(result.input.map(i => i.type), input.map(i => i.type), '不得重排/增删')
  assert.deepEqual(result.input.filter(i => i.call_id).map(i => i.call_id), ['call_a', 'call_a', 'call_b', 'call_b'])
  assert.deepEqual(analyzeToolPairs(result.input).problems, [], '压缩项不得打断 call_id 配对')
  assert.equal(result.input[4].content[0].text, '继续，并回忆第一次工具标记')
})

test('V2-04 压缩后同子会话继续：压缩项之后的历史原样保留（fixture 级连续）', () => {
  const history = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'NEW_TASK#1' }] },
    { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"echo one"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'one' },
    opaqueCompaction({ id: 'cmp_child' }),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'NEW_TASK#2' }] },
    { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: '{"cmd":"echo two"}' },
    { type: 'function_call_output', call_id: 'c2', output: 'two' },
  ]
  const result = projectOrderedHistory(history, compactionRoute({ nativeCompaction: 'codex-owned-remote' }), null)
  assert.equal(result.rejected, null)
  assert.equal(result.lossy.length, 0)
  assert.deepEqual(result.input, history, '同一子会话的压缩后历史必须逐字节等价')
  assert.equal(result.input[3].id, 'cmp_child')
})

test('V2-04 prepareCodexNativeRequest：透传路由成功、未就绪路由 body=null 且 rejected', () => {
  const body = deepFreeze({
    model: 'mg-opencodego-deepseek-v4-1-flash',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, opaqueCompaction()],
  })
  const ok = prepareCodexNativeRequest(body, compactionRoute({ nativeCompaction: 'codex-owned-remote' }))
  assert.equal(ok.rejected, null)
  assert.equal(ok.body.input.length, 2)
  assert.deepEqual(ok.body.input[1], body.input[1])
  assert.ok(!ok.lossy.includes('compaction_dropped'))

  const blocked = prepareCodexNativeRequest(body, compactionRoute())
  assert.equal(blocked.body, null, '拒绝时必须零上游请求（body=null）')
  assert.equal(blocked.rejected.code, 'native_compaction_route_not_ready')
})

// ---------------------------------------------------------------------------
// 目录/能力元数据：auto_compact_token_limit 与 nativeCompaction
// ---------------------------------------------------------------------------

function level(effort) {
  return { effort, description: effort + ' reasoning' }
}

function officialModel(overrides = {}) {
  return Object.assign({
    slug: 'gpt-test-sol',
    display_name: 'GPT Test Sol',
    description: 'Official fixture model',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [level('low'), level('medium')],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    context_window: 200000,
    max_context_window: 400000,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    base_instructions: 'You are Codex, a fixture agent.',
  }, overrides)
}

function thirdPartyConfig(codex, extra = {}) {
  return {
    providers: { 'opencode-go': { name: 'OpenCode Go' } },
    models: {
      'deepseek-v4.1-flash': Object.assign({
        provider: 'opencode-go',
        capability: 'chat',
        maxContext: 1000000,
        codex,
      }, extra),
    },
  }
}

test('V2-04 目录：显式声明 + 证据的 autoCompactTokenLimit 写入 Codex 字段，nativeCompaction 只留在运行时', () => {
  const config = thirdPartyConfig({
    nativeCompaction: 'codex-owned-local',
    capabilities: { autoCompactTokenLimit: 900000 },
    evidence: { autoCompactTokenLimit: { source: 'local:codex-official-catalog', observedAt: '2026-11-15' } },
  })
  const built = C.buildCatalog({ base: { models: [officialModel()] }, config })
  const model = built.catalog.models.find(m => m.slug.startsWith('mg-opencode-go-deepseek-v4-1-flash'))
  assert.ok(model, '第三方模型必须出现在目录里')
  assert.equal(model.auto_compact_token_limit, 900000)
  assert.equal(model.context_window, 1000000)
  assert.equal(Object.prototype.hasOwnProperty.call(model, 'nativeCompaction'), false, '运行时能力不得写进 ModelInfo')
  assert.equal(Object.prototype.hasOwnProperty.call(model, 'remote_compaction'), false,
    'ModelInfo 没有 remote_compaction 字段：不得编造模型级能力（provider 级声明走 meta）')
  const meta = built.meta.models.find(m => m.model === 'deepseek-v4.1-flash')
  assert.ok(meta.sources.capabilities.fields.includes('auto_compact_token_limit'))
  assert.equal(meta.sources.capabilities.evidence.autoCompactTokenLimit.source, 'local:codex-official-catalog')
  // 原生压缩声明：Codex 所有 + provider 级 remote_compaction 关闭 + 模型级阈值
  assert.equal(meta.nativeCompaction.owner, 'codex')
  assert.equal(meta.nativeCompaction.path, 'local')
  assert.equal(meta.nativeCompaction.providerCapability.tomlPath, 'model_providers.<provider>.capabilities.remote_compaction')
  assert.equal(meta.nativeCompaction.providerCapability.remoteCompactionAllowed, false)
  assert.equal(meta.nativeCompaction.providerCapability.encoding, 'UNVERIFIED_LOCAL_STATE')
  assert.deepEqual(meta.nativeCompaction.modelFields, { auto_compact_token_limit: 900000 })
})

test('V2-04 目录：未声明 nativeCompaction 时给出可观察 warning（不静默假设本地压缩）', () => {
  const built = C.buildCatalog({ base: { models: [officialModel()] }, config: thirdPartyConfig(undefined) })
  assert.ok(built.meta.warnings.some(w => w.code === 'native_compaction_undeclared'))
  const meta = built.meta.models.find(m => m.model === 'deepseek-v4.1-flash')
  assert.equal(meta.nativeCompaction, null)
})

test('V2-04 目录：无证据的阈值声明必须失败（不编造压缩触发点）', () => {
  const config = thirdPartyConfig({ capabilities: { autoCompactTokenLimit: 900000 } })
  assert.throws(() => C.buildCatalog({ base: { models: [officialModel()] }, config }),
    err => err.code === 'capability_evidence_missing')
})

test('V2-04 目录：阈值超过上下文窗口必须拒绝（否则压缩永不触发）', () => {
  const config = thirdPartyConfig({
    capabilities: { autoCompactTokenLimit: 1200000 },
    evidence: { autoCompactTokenLimit: { source: 'local:test', observedAt: '2026-11-15' } },
  })
  assert.throws(() => C.buildCatalog({ base: { models: [officialModel()] }, config }),
    err => err.code === 'auto_compact_token_limit_exceeds_context')
})

test('V2-04 目录：非法 nativeCompaction 值必须失败，不静默退化为未声明', () => {
  const config = thirdPartyConfig({ nativeCompaction: 'remote' })
  assert.throws(() => C.buildCatalog({ base: { models: [officialModel()] }, config }),
    err => err.code === 'invalid_override')
})

test('V2-04 目录：validateCatalog 对越界 auto_compact_token_limit 给出稳定错误码', () => {
  const broken = { models: [officialModel({ auto_compact_token_limit: 300000 })] }
  const result = C.validateCatalog(broken)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(e => e.code === 'auto_compact_token_limit_exceeds_context'))
})
