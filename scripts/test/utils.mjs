// 测试共享工具
export const GW = process.env.MG_GW || 'http://127.0.0.1:8787'
export const results = []
export function check(name, ok, detail, skip) {
  if (skip) { console.log('SKIP  ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); return }
  results.push(!!ok)
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + JSON.stringify(detail) : ''))
}
export const jpost = (path, body) => fetch(GW + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }))
export async function snapshot() {
  const st = await (await fetch(GW + '/api/status')).json()
  const providers = {}; for (const p of st.providers || []) providers[p.id] = { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv || '', pathPrefix: p.pathPrefix || '', extraHeaders: p.extraHeaders || {}, api: p.api || 'openai' }
  const models = {}; for (const m of st.models || []) models[m.name] = { provider: m.provider, alias: m.alias || [], fallbacks: m.fallbacks || [], maxConcurrent: m.maxConcurrent || 0 }
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