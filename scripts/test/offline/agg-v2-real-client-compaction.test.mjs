// V2 真实客户端压缩回放：把 0.167.0-alpha.3.2 实测捕获的请求形状编码成 fixture，
// 钉住「Codex 自己压缩 → 网关只透传 → 压缩后追派不被拒」这条产品路径的协议前提。
//
// 事实来源（只读实测，未花额度）：docs/evidence/aggregation-v2-native-compaction-real-client-2026-11-15.md
//   · remote_compaction="unsupported" 时，Codex 第 2 轮发来一条新的 user message，
//     正文以 "You are performing a CONTEXT CHECKPOINT COMPACTION. ..." 开头（客户端本地压缩提示）；
//   · 网关必须原样转发该提示（说明不是网关在总结），且不得因为历史里含 compaction/context_compaction
//     而把整条请求判成 unsupported_input_item；
//   · remote_compaction="v2" 时 Codex 发 input item {type:"compaction_trigger"}，
//     网关只在声明 codex-owned-remote 的路由上原样透传。
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCodexInputItem, projectOrderedHistory } from '../../../src/codex/interop.js'

const COMPACT_PROMPT = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
  '',
  'Include:',
  '- Current progress and key decisions made',
  '- Important context, constraints, or user preferences',
  '- What remains to be done (clear next steps)',
  '- Any critical data, examples, or references needed to continue',
  '',
  'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.',
].join('\n')

function route(patch = {}) {
  const codex = {
    multiAgentVersion: 'v2',
    plaintextTools: true,
    namespace: 'collaboration',
    history: { agentMessage: 'project', reasoning: 'drop', compaction: 'preserve' },
  }
  if (patch.nativeCompaction !== undefined) codex.nativeCompaction = patch.nativeCompaction
  return { alias: 'mg-opencodego-deepseek-v4-1-flash', provider: 'opencodego', api: 'responses', codex }
}

function userTurn(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}

function assistantTurn(text) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
}

test('真实客户端本地压缩：压缩提示原样透传，网关不改写/不总结', () => {
  const input = [userTurn('first turn'), assistantTurn('OK'), userTurn(COMPACT_PROMPT)]
  const projected = projectOrderedHistory(input, route({ nativeCompaction: 'codex-owned-local' }), null)
  assert.equal(projected.rejected, null)
  const last = projected.input[projected.input.length - 1]
  const text = last.content[0].text
  assert.equal(text, COMPACT_PROMPT, '压缩提示必须逐字透传（网关不得自建摘要）')
})

test('真实客户端压缩后追派：同一会话下一轮请求不被历史项拒绝', () => {
  // 压缩后 Codex 用压缩结果替换历史，再追加新一轮 user message（实测第 3 个请求）。
  const input = [
    userTurn('first turn'),
    assistantTurn('OK'),
    userTurn(COMPACT_PROMPT),
    assistantTurn('handoff summary'),
    userTurn('second turn'),
  ]
  const projected = projectOrderedHistory(input, route({ nativeCompaction: 'codex-owned-local' }), null)
  assert.equal(projected.rejected, null)
  assert.equal(projected.input.length, input.length)
  assert.equal(projected.input[projected.input.length - 1].content[0].text, 'second turn')
})

test('真实客户端远程压缩触发标记：只在声明 codex-owned-remote 的路由透传', () => {
  const input = [userTurn('first turn'), { type: 'compaction_trigger' }]
  assert.equal(classifyCodexInputItem({ type: 'compaction_trigger' }), 'compaction_trigger')

  const remote = projectOrderedHistory(input, route({ nativeCompaction: 'codex-owned-remote' }), null)
  assert.equal(remote.rejected, null)
  assert.deepEqual(remote.input[remote.input.length - 1], { type: 'compaction_trigger' })

  for (const patch of [{ nativeCompaction: 'codex-owned-local' }, { nativeCompaction: 'unsupported' }, {}]) {
    const blocked = projectOrderedHistory(input, route(patch), null)
    assert.equal(blocked.rejected && blocked.rejected.code, 'native_compaction_route_not_ready', JSON.stringify(patch))
  }
})

test('本地压缩路径不得伪造 compaction 响应项（网关不产出密文）', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../../src/codex/interop.js', import.meta.url), 'utf8'))
  assert.ok(!/encrypted_content\s*:\s*['"`]/.test(source), 'interop 不得生成 encrypted_content 字面量')
  assert.ok(!/compaction\s*:\s*\{\s*type/.test(source), 'interop 不得构造 compaction 响应对象')
})
