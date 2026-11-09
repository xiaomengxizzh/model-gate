// Rerank 能力（MG-012）：请求校验、上游整形（OpenAI 兼容 / Cohere v2）与响应归一。
// 入口在 src/index.js（POST /v1/rerank）；能力声明 capability=rerank。
export const MAX_RERANK_DOCUMENTS = 2048

export function rerankPathFor(api) {
  return api === 'cohere' ? '/v2/rerank' : '/v1/rerank'
}

// 上游协议是否提供 rerank：OpenAI 兼容（Jina/SiliconFlow 等）与 Cohere v2；Anthropic/Gemini 无此能力。
export function supportsRerank(api) { return api === 'openai' || api === 'cohere' }

export function validateRerankRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体必须为 JSON 对象' }
  if (typeof body.model !== 'string' || body.model.trim() === '') return { error: '缺少 model' }
  if (typeof body.query !== 'string' || body.query === '') return { error: 'query 必须为非空字符串' }
  const docs = body.documents
  if (!Array.isArray(docs) || docs.length === 0) return { error: 'documents 必须为非空字符串数组' }
  if (docs.length > MAX_RERANK_DOCUMENTS) return { error: 'documents 批量上限 ' + MAX_RERANK_DOCUMENTS + ' 条' }
  if (docs.some((d) => typeof d !== 'string' || d === '')) return { error: 'documents 每项必须为非空字符串' }
  if (body.top_n != null && (!Number.isInteger(Number(body.top_n)) || Number(body.top_n) <= 0)) return { error: 'top_n 必须为正整数' }
  if (body.return_documents != null && typeof body.return_documents !== 'boolean') return { error: 'return_documents 必须为布尔值' }
  return null
}

// 按上游协议生成 { path, body }（Cohere 用 v2/rerank，其余按 OpenAI 兼容 /v1/rerank）
export function buildRerankRequest(api, body) {
  const out = { model: body.model, query: body.query, documents: body.documents }
  if (body.top_n != null) out.top_n = Number(body.top_n)
  if (body.return_documents != null) out.return_documents = body.return_documents
  if (api === 'cohere') return { path: '/v2/rerank', body: out }
  return { path: '/v1/rerank', body: out }
}

// 响应归一：results[] 保留 index/relevance_score/document；按分数降序、同分按 index 升序（稳定排序）；
// top_n 再次裁剪（防御上游忽略）；model 回写客户端请求名。Cohere/Jina 的 meta/usage 原样保留（不臆造）。
export function normalizeRerankResponse(api, json, model, opts = {}) {
  const j = json && typeof json === 'object' ? json : {}
  const src = Array.isArray(j.results) ? j.results.slice() : []
  const results = src.map((r, i) => {
    const idx = Number.isInteger(r && r.index) ? r.index : i
    const score = Number(r && r.relevance_score)
    const item = { index: idx, relevance_score: Number.isFinite(score) ? score : 0 }
    if (r && r.document != null) item.document = r.document
    return item
  })
  results.sort((a, b) => (b.relevance_score - a.relevance_score) || (a.index - b.index))
  const topN = Number(opts.topN)
  const out = Object.assign({}, j, { model: model || j.model || '', results: Number.isInteger(topN) && topN > 0 ? results.slice(0, topN) : results })
  if (!out.id) out.id = 'rerank-' + Math.random().toString(36).slice(2, 10)
  return out
}

export function rerankHeaders(cfg, provider, api, payload) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json', 'accept-encoding': 'identity' }
  const extra = Object.assign({}, (cfg && cfg.defaults && cfg.defaults.extraHeaders) || {}, (provider && provider.extraHeaders) || {})
  for (const [k, v] of Object.entries(extra)) headers[String(k).toLowerCase()] = v
  if (provider && provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
  if (payload && payload.length) headers['content-length'] = payload.length
  return headers
}
