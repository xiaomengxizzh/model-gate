// MG-NATIVE-DELEGATION：聚合目录必须把“被选作父代理的官方模型”投影成原生派单声明。
//
// 真机取证（2026-11-16）：聚合目录里 luna 用官方 baseline 原值
//   tool_mode="code_mode_only" + use_responses_lite=true + multi_agent_version="v2"
//   → Codex 下发 tools:None → 无 spawn_agent → luna 回报“当前没有可用的子代理调用入口”；
//   而 configure() 的覆盖 direct/v1/responses_lite=false 能正常父子派单。
// 本套件钉死：发布时只投影父模型、不动第三方 DeepSeek、不改内容/身份，且纯函数不改入参。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  asNativeDelegationParent, projectNativeDelegationBase, NATIVE_DELEGATION_PARENT_FIELDS,
} from '../../../src/codex/catalog.js'

test('asNativeDelegationParent：code_mode_only luna → 原生派单声明（与 configure 一致）', () => {
  const luna = {
    slug: 'gpt-6-luna', tool_mode: 'code_mode_only', use_responses_lite: true,
    multi_agent_version: 'v2', supports_search_tool: true, context_window: 272000,
    model_messages: { instructions_template: 'You are Codex.' },
  }
  const out = asNativeDelegationParent(luna)
  assert.equal(out.tool_mode, 'direct')
  assert.equal(out.use_responses_lite, false)
  assert.equal(out.multi_agent_version, 'v1')
  assert.equal(out.supports_search_tool, false)
  assert.equal(out.base_instructions, 'You are Codex.')
  assert.equal('model_messages' in out, false)
  assert.equal(out.context_window, 272000, '不改能力无关字段')
  assert.equal(out.slug, 'gpt-6-luna', '不改身份')
  // 纯函数：不改入参
  assert.equal(luna.tool_mode, 'code_mode_only')
  assert.ok(luna.model_messages)
})

test('projectNativeDelegationBase：只投影指定父 slug，第三方 DeepSeek 原样不动', () => {
  const base = {
    models: [
      { slug: 'gpt-6-luna', tool_mode: 'code_mode_only', use_responses_lite: true, multi_agent_version: 'v2' },
      { slug: 'gpt-5.6-luna', tool_mode: 'code_mode_only', use_responses_lite: true, multi_agent_version: 'v2' },
      { slug: 'mg-opencodego-deepseek-v4-1-flash', shell_type: 'disabled', tool_mode: 'code_mode_only' },
    ],
  }
  const out = projectNativeDelegationBase(base, ['gpt-6-luna'])
  assert.equal(out.models[0].tool_mode, 'direct', '父 luna 被投影')
  assert.equal(out.models[0].use_responses_lite, false)
  assert.equal(out.models[0].multi_agent_version, 'v1')
  assert.equal(out.models[1].tool_mode, 'code_mode_only', '未指定的父候选不动')
  assert.equal(out.models[2].tool_mode, 'code_mode_only', '第三方条目绝不动')
  assert.equal(out.models[2].shell_type, 'disabled')
  assert.equal(base.models[0].tool_mode, 'code_mode_only', '入参未被修改')
})

test('projectNativeDelegationBase：未指定 slugs 时投影所有带 multi_agent_version 的官方模型，跳过 mg- 第三方', () => {
  const out = projectNativeDelegationBase({ models: [
    { slug: 'gpt-6-luna', multi_agent_version: 'v2', tool_mode: 'code_mode_only' },
    { slug: 'mg-opencodego-x', multi_agent_version: 'v2', tool_mode: 'code_mode_only' },
    { slug: 'plain-model', tool_mode: 'code_mode_only' },
  ] }, null)
  assert.equal(out.models[0].tool_mode, 'direct')
  assert.equal(out.models[1].tool_mode, 'code_mode_only', 'mg- 前缀第三方跳过')
  assert.equal(out.models[2].tool_mode, 'code_mode_only', '无 multi_agent_version 的跳过')
})

test('投影字段值固定且可审计（防止静默漂移）', () => {
  assert.deepEqual({ ...NATIVE_DELEGATION_PARENT_FIELDS }, {
    tool_mode: 'direct',
    use_responses_lite: false,
    multi_agent_version: 'v1',
    supports_search_tool: false,
  })
})
