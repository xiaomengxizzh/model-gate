// 测试共享工具
export const GW = process.env.MG_GW || 'http://127.0.0.1:8787'
export const results = []
export function check(name, ok, detail, skip) {
  if (skip) { console.log('SKIP  ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); return }
  results.push(!!ok)
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + JSON.stringify(detail) : ''))
}
export const jpost = (path, body) => fetch(GW + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }))
// 运行时统计字段（非配置）：回写时必须剔除，其余字段一律**原样带回**。
// 教训（2026-09-17 事故）：snapshot 此前把 model 压成 { provider, alias, fallbacks, maxConcurrent } 四个字段，
// 而 saveConfig 对 `body.models` 是**整体替换**（index.js: `body.models !== undefined ? body.models : cur.models`）
// ——于是任何走「读-改-写」的测试每跑一次就把 live 配置洗一遍：reasoning / effortFormat / effortOptions /
// api / providerModels / maxTokensMax / qps / quota / dailyQuota / maxContext / probe 全被清空（实测 6 个模型全中，
// union-alpha 的 providerModels 被洗掉后上游直接 404 No endpoints found）。加字段时别再加白名单，用黑名单。
const RUNTIME_MODEL_FIELDS = new Set(['name', 'requests', 'errors', 'tokens', 'today', 'hitRate', 'affinity', 'avgMs'])
const RUNTIME_PROVIDER_FIELDS = new Set(['id', 'hasKey', 'keySource', 'st'])
export async function snapshot() {
  const st = await (await fetch(GW + '/api/status')).json()
  // 逐字段回写（黑名单剔除运行时字段）：漏字段 = 洗 live 配置，别手写字段清单
  const providers = {}
  for (const p of st.providers || []) { const o = {}; for (const [k, v] of Object.entries(p)) if (!RUNTIME_PROVIDER_FIELDS.has(k)) o[k] = v; providers[p.id] = o }
  const models = {}
  for (const m of st.models || []) { const o = {}; for (const [k, v] of Object.entries(m)) if (!RUNTIME_MODEL_FIELDS.has(k)) o[k] = v; models[m.name] = o }
  return { providers, models, defaults: st.defaults || {}, server: st.server || {} }
}
export async function save(p, m, d) { return jpost('/api/config/save', { providers: p, models: m, defaults: d }) }
export const chat = (model, stream, extra) => fetch(GW + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: !!stream, messages: [{ role: 'user', content: 'x' }], ...(extra || {}) }) })
export const count = () => { const pass = results.filter(Boolean).length; const fail = results.filter((x) => !x).length; return { pass, fail, total: pass + fail } }
export function streamDeltaText(text) {
  let o = ''
  for (const m of text.matchAll(/data:\s*([^\n]+)/g)) { const r = m[1].trim(); if (r === '[DONE]') continue; try { const j = JSON.parse(r); const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (typeof c === 'string') o += c } catch {} }
  return o
}