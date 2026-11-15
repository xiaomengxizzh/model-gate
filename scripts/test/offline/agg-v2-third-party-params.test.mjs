// V2 真机缺陷回归：Codex 0.167.0-alpha.3.2 会发 ChatGPT 专属参数，第三方 Responses 上游 400
// （实测：`reasoning.context: this reasoning option requires a native Responses target`）。
// 只对非官方目标剔除，并把剔除项写进诊断；官方目标保持逐字节透传。
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectThirdPartyResponsesParams } from '../../../src/index.js'

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
