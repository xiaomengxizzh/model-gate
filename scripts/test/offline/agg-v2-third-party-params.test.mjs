// V2 真机缺陷回归：Codex 0.167.0-alpha.3.2 会发 ChatGPT 专属参数，第三方 Responses 上游 400
// （实测：`reasoning.context: this reasoning option requires a native Responses target`）。
// 只对非官方目标剔除，并把剔除项写进诊断；官方目标保持逐字节透传。
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectThirdPartyResponsesParams, firstEmptyToolCallId } from '../../../src/index.js'

const codexBody = () => ({
  model: 'x',
  input: 'hi',
  reasoning: { effort: 'none', context: 'all_turns' },
  text: { verbosity: 'low' },
  include: ['reasoning.encrypted_content', 'other'],
})

const thirdParty = { baseUrl: 'https://opencode.ai/inference/go' }
const official = { baseUrl: 'https://api.openai.com' }

test('第三方 Responses 目标：剔除 reasoning.context / text.verbosity / include:reasoning.encrypted_content', () => {
  const { body, dropped } = projectThirdPartyResponsesParams(codexBody(), thirdParty)
  assert.deepEqual(body.reasoning, { effort: 'none' })
  assert.equal(body.text, undefined)
  assert.deepEqual(body.include, ['other'])
  assert.deepEqual(dropped, ['reasoning.context', 'text.verbosity', 'include:reasoning.encrypted_content'])
  assert.equal(body.model, 'x', '不得改写 model 等其它字段')
})

test('官方目标：逐字节透传，不做任何剔除', () => {
  const input = codexBody()
  const { body, dropped } = projectThirdPartyResponsesParams(input, official)
  assert.equal(body, input)
  assert.deepEqual(dropped, [])
})

test('缺少这些字段时零改动（不无中生有）', () => {
  const plain = { model: 'x', input: 'hi' }
  const { body, dropped } = projectThirdPartyResponsesParams(plain, thirdParty)
  assert.deepEqual(body, plain)
  assert.deepEqual(dropped, [])
  // reasoning 只有 effort：保留原对象
  const onlyEffort = { model: 'x', reasoning: { effort: 'low' } }
  assert.equal(projectThirdPartyResponsesParams(onlyEffort, thirdParty).body.reasoning.effort, 'low')
})

test('第三方 Responses 目标：剔除 stream_options（OpenCode Go portable 上游 400 实测）', () => {
  const prov = { id: 'opencodego', baseUrl: 'https://opencode.ai/inference/go' }
  const out = projectThirdPartyResponsesParams({
    model: 'deepseek-v4.1-flash',
    input: 'hi',
    stream: true,
    stream_options: { include_usage: true },
  }, prov)
  assert.equal(Object.prototype.hasOwnProperty.call(out.body, 'stream_options'), false)
  assert.ok(out.dropped.includes('stream_options'))
  // 官方目标不改：stream_options 原样保留，避免破坏官方路径的逐字节语义
  const official = projectThirdPartyResponsesParams({ stream_options: { include_usage: true } }, { id: 'chatgptplan', baseUrl: 'https://chatgpt.com', codexIdentity: 'official' })
  assert.deepEqual(official.body.stream_options, { include_usage: true })
  assert.deepEqual(official.dropped, [])
})

test('工具项 call_id 为空/缺失：第三方 Responses 目标提前给出可操作错误（官方不受影响）', () => {
  const withEmpty = { input: [{ role: 'user', content: 'hi' }, { type: 'function_call', call_id: '', name: 'exec_command' }] }
  const bad = firstEmptyToolCallId(withEmpty)
  assert.deepEqual(bad, { index: 1, type: 'function_call', reason: 'empty' })
  const missing = firstEmptyToolCallId({ input: [{ type: 'function_call_output', output: 'ok' }] })
  assert.deepEqual(missing, { index: 0, type: 'function_call_output', reason: 'missing' })
  // 正常历史 / 非工具项 / 官方目标语义都不受影响
  assert.equal(firstEmptyToolCallId({ input: [{ role: 'user', content: 'hi' }, { type: 'function_call', call_id: 'call_1' }, { type: 'function_call_output', call_id: 'call_1' }] }), null)
  assert.equal(firstEmptyToolCallId({ input: [{ type: 'reasoning', summary: [] }, { role: 'assistant', content: 'x' }] }), null)
  assert.equal(firstEmptyToolCallId(null), null)
})
