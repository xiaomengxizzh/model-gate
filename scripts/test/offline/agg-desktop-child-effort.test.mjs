// MG-P0-01 真机缺陷回归：原生子代理 reasoning effort 必须是 Go DeepSeek 声明支持的档位。
//
// 真机取证（2026-11-16，真实 gpt-6-luna 父 + 隔离 Desktop 配置，codex-cli 0.167.0）：
//   子代理 spawn 报错：Reasoning effort `medium` is not supported for model
//   `mg-opencodego-deepseek-v4-1-flash`. Supported reasoning efforts: low, high
// 根因：bin/mg-desktop.mjs configure() 调 buildManagedAgentConfig 未传 reasoningEffort，
//       落到全局默认 'medium'，而子模型 effortOptions=['low','high']。
// 修复：configure() 显式传 'high'；不动全局默认（保持既有用户托管配置字节兼容）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildManagedAgentConfig } from '../../../src/codex/config.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

test('原生子代理：显式 high effort 写入子配置文件（Go DeepSeek 支持）', () => {
  const built = buildManagedAgentConfig({ model: 'mg-opencodego-deepseek-v4-1-flash', reasoningEffort: 'high' })
  assert.match(built.child.text, /^model = "mg-opencodego-deepseek-v4-1-flash"$/m)
  assert.match(built.child.text, /^model_reasoning_effort = "high"$/m)
  assert.equal(built.child.reasoningEffort, 'high')
  assert.equal(built.child.text.includes('medium'), false, '不得写不被支持的 medium')
})

test('mg-desktop configure：显式传 reasoningEffort high（静态接线守卫）', () => {
  const src = readFileSync(ROOT + 'bin/mg-desktop.mjs', 'utf8')
  assert.match(src, /buildManagedAgentConfig\(\{\s*model:\s*alias,\s*reasoningEffort:\s*'high'\s*\}\)|, reasoningEffort: 'high' \}/,
    'configure() 必须给子代理传受支持的 high effort')
  // 子模型目录声明的 effortOptions 必须包含所用的 high。
  assert.match(src, /effortOptions:\s*\['low',\s*'high'\]/)
})

test('Go DeepSeek 目录只支持 low/high：默认 medium 不得出现在生成的子配置里', () => {
  // 直接用 configure 相同的显式 effort 构建，确认不含 medium。
  const built = buildManagedAgentConfig({ model: 'mg-opencodego-deepseek-v4-1-flash', reasoningEffort: 'high' })
  const efforts = ['low', 'medium', 'high']
  const used = efforts.filter((e) => built.child.text.includes('"' + e + '"'))
  assert.deepEqual(used, ['high'], '子配置只能出现受支持的 high')
})
