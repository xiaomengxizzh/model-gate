// A2 / P01：真实清单形状的合成生成器（离线）。
//
// 2026-11-14 的 live 探针记录了真实形状；这里按**形状**合成条目，不复制任何真实响应正文、
// 账户标识或 60 KB 原始载荷。字段与真实载荷一致：
//   id, object, created, owned_by, name, canonical_id, type, description, family, open_weights,
//   knowledge, release_date, last_updated, modalities, capabilities{tools{supported},reasoning{...},
//   structured_output, temperature, effort_updates}, limit{context,input,output}, cost, api{...}
//
// 两个用途：
//   1. `listing(count, …)` 生成 count 条同形状条目，用于“计数级”对账（50 console / 30 go）。
//   2. 手写小样本（real-console-models.json / real-go-models.json）覆盖每个协议分支，用于形状断言。

const CHAT_BASE = { console: 'https://opencode.ai/inference/openai/v1', go: 'https://opencode.ai/inference/go/openai/v1' }
const ANTHROPIC_BASE = { console: 'https://opencode.ai/inference/anthropic/v1', go: 'https://opencode.ai/inference/go/anthropic/v1' }
const GOOGLE_BASE = { console: 'https://opencode.ai/inference/google/v1beta', go: 'https://opencode.ai/inference/go/google/v1beta' }

const CONTEXT_VALUES = [128000, 200000, 262144, 400000, 524288, 1000000, 1048576, 1050000]

// protocol: 'openai' | 'responses' | 'anthropic' | 'google'
function apiFor(scope, protocol) {
  if (protocol === 'openai') return { 'chat-completions': { base_url: CHAT_BASE[scope], sdk: { aisdk: '@ai-sdk/openai-compatible' } } }
  if (protocol === 'responses') return { responses: { base_url: CHAT_BASE[scope] } }
  if (protocol === 'anthropic') return { messages: { base_url: ANTHROPIC_BASE[scope] } }
  return { 'generate-content': { base_url: GOOGLE_BASE[scope] } }
}

export function realModelEntry(options = {}) {
  const {
    id, scope = 'console', protocol = 'openai', canonicalId, name, context = 200000,
    tools = true, reasoning = true, structuredOutput = true, effortUpdates = false,
  } = options
  const entry = {
    id,
    object: 'model',
    created: 1794659087,
    owned_by: 'opencode',
    name: name || id,
    type: 'chat',
    description: 'Synthetic fixture entry shaped like the 2026-11-14 live listing',
    family: String(id).split('-')[0],
    open_weights: false,
    knowledge: '2025-01',
    release_date: '2025-10-17',
    last_updated: '2025-10-17',
    modalities: { input: ['text'], output: ['text'] },
    capabilities: {
      tools: { supported: tools },
      reasoning: { supported: reasoning },
      structured_output: structuredOutput,
      temperature: true,
      system_updates: false,
      effort_updates: { supported: effortUpdates },
    },
    limit: { context, input: Math.min(context, Math.floor(context * 0.8)), output: 32000 },
    cost: { input: 1, output: 2 },
    api: apiFor(scope, protocol),
  }
  if (canonicalId) entry.canonical_id = canonicalId
  return entry
}

// 按真实比例合成：console 50 条中 14 条非 openai 协议（9 messages + 5 generate-content）；
// go 30 条中 6 条（5 messages + 1 generate-content）。其余在 openai/responses 间分布。
export function listing(count, options = {}) {
  const { scope = 'console', prefix = 'fixture', nonRoutable = 0, anthropic = 0 } = options
  const out = []
  for (let i = 0; i < count; i++) {
    const idx = i + 1
    let protocol = 'openai'
    if (i < nonRoutable) protocol = i < anthropic ? 'anthropic' : 'google'
    else if (i % 3 === 2) protocol = 'responses'
    out.push(realModelEntry({
      id: prefix + '-' + String(idx).padStart(3, '0'),
      scope,
      protocol,
      canonicalId: 'vendor/' + prefix + '-' + String(idx).padStart(3, '0') + '-1017',
      name: 'Fixture Model ' + idx,
      context: CONTEXT_VALUES[i % CONTEXT_VALUES.length],
      effortUpdates: i % 7 === 0,
    }))
  }
  return { object: 'list', data: out }
}
