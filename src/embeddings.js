// Embedding 能力（MG-011）：请求校验、上游整形、鉴权头与响应归一。
// 保持 Node 内置模块、零第三方依赖；承载入口在 src/index.js（/v1/embeddings）。
import { embeddingAdapterFor, supportsEmbeddings } from './format.js'
import { applyExtraHeaders } from './codex/auth.js'
import { createOptionalEndpointPolicy } from './optional/policy.js'

// M1-4a：可选端点策略入口。本模块只声明 embedding 的差异（校验 + 上游整形）；
// 身份、取消、限流、429 归因与能力开关全部走 src/optional/policy.js 的同一实现。
export const OPTIONAL_ENDPOINT = Object.freeze({ capability: 'embedding', mode: 'json', policy: 'optional-endpoint-policy/1' })
export function createEmbeddingPolicy(opts = {}) {
  return createOptionalEndpointPolicy(Object.assign({ capability: 'embedding', validate: validateEmbeddingRequest }, opts))
}

export const MAX_EMBEDDING_INPUTS = 2048

// 返回 null 表示通过；否则 { error }（由入口按 400 返回）
export function validateEmbeddingRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体必须为 JSON 对象' }
  if (typeof body.model !== 'string' || body.model.trim() === '') return { error: '缺少 model' }
  const input = body.input
  if (typeof input === 'string') {
    if (input === '') return { error: 'input 不能为空字符串' }
  } else if (Array.isArray(input)) {
    if (input.length === 0) return { error: 'input 不能为空数组' }
    if (input.length > MAX_EMBEDDING_INPUTS) return { error: 'input 批量上限 ' + MAX_EMBEDDING_INPUTS + ' 条' }
    // OpenAI 允许 token-id 数组；当前网关只支持文本输入（跨协议一致，避免半支持）。
    if (input.some((x) => typeof x !== 'string')) return { error: '仅支持字符串或字符串数组 input（暂不支持 token id 数组）' }
    if (input.some((x) => x === '')) return { error: 'input 数组包含空字符串' }
  } else return { error: 'input 必须为字符串或字符串数组' }
  if (body.dimensions != null) {
    const d = Number(body.dimensions)
    if (!Number.isInteger(d) || d <= 0) return { error: 'dimensions 必须为正整数' }
  }
  if (body.encoding_format != null && !['float', 'base64'].includes(String(body.encoding_format))) return { error: 'encoding_format 仅支持 float/base64' }
  return null
}

// 按上游协议生成 { path, body }
export function buildEmbeddingRequest(api, body) {
  const adapter = embeddingAdapterFor(api)
  if (adapter) return adapter.build(body)
  return { path: '/v1/embeddings', body }
}

// 上游鉴权/协议头（与转发层规则一致：extraHeaders 合并，Anthropic/Gemini 协议头）。
export function embeddingHeaders(cfg, provider, api, payload) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json', 'accept-encoding': 'identity' }
  const extra = Object.assign({}, (cfg && cfg.defaults && cfg.defaults.extraHeaders) || {}, (provider && provider.extraHeaders) || {})
  // E1：extraHeaders 不得覆盖/注入鉴权头（与 forward.js buildHeaders 同一守卫）。
  applyExtraHeaders(headers, extra)
  if (provider && provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
  if (api === 'gemini' && provider && provider.apiKey && !headers['x-goog-api-key']) headers['x-goog-api-key'] = provider.apiKey
  if (api === 'anthropic') {
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
    if (provider && provider.apiKey && !headers['x-api-key']) headers['x-api-key'] = provider.apiKey
  }
  if (payload && payload.length) headers['content-length'] = payload.length
  return headers
}

// 上游响应 → OpenAI embeddings 形状；model 回写为客户端请求名。
export function normalizeEmbeddingResponse(api, json, model) {
  const adapter = embeddingAdapterFor(api)
  if (!adapter) return Object.assign({}, json || {}, { model: model || (json && json.model) || '' })
  const out = adapter.fromUpstream(json || {})
  out.model = model || out.model || ''
  return out
}

export { supportsEmbeddings }
