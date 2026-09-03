// 模型级拒绝（400 + 模型不可用语义）故障转移契约：
// 上游对「模型不可用」返回 400（opencodego 的 Provider rejected the model request / Model not supported、
// jiyuan 的 MODEL_DISABLED）时，网关应视同 403/404 继续目录链切下一模型，而非把 400 直接抛给客户端。
// 对照：纯参数错误 400（如 invalid messages）不应切换（换模型同样失败），直接返回保留原始错误。
import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'

const hits = { A: 0, B: 0, C: 0 }
// A：模型级拒绝 400——响应体含「Provider rejected the model request」（opencodego 现场实证文案）
const sA = http.createServer((req, res) => {
  hits.A += 1
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Provider rejected the model request', type: 'invalid_request_error' } }))
})
// B：正常上游——完整 JSON 响应
const sB = http.createServer((req, res) => {
  hits.B += 1
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 't-mr-m1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok-B' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
// C：纯参数错误 400——响应体不含模型不可用语义（如 messages 格式非法）
const sC = http.createServer((req, res) => {
  hits.C += 1
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Invalid messages: content must be a string', type: 'invalid_request_error' } }))
})
await new Promise(r => sA.listen(0, () => r()))
await new Promise(r => sB.listen(0, () => r()))
await new Promise(r => sC.listen(0, () => r()))
const portA = sA.address().port; const portB = sB.address().port; const portC = sC.address().port

const base = await snapshot()
const origDefaults = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-mr-a'] = { baseUrl: `http://127.0.0.1:${portA}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.providers['t-mr-b'] = { baseUrl: `http://127.0.0.1:${portB}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.providers['t-mr-c'] = { baseUrl: `http://127.0.0.1:${portC}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
// 场景 1：m1 主上游 A（模型级拒绝 400）→ 应切备用 B
base.models['t-mr-m1'] = { provider: 't-mr-a', alias: [], fallbacks: ['t-mr-b'], maxConcurrent: 0 }
// 场景 2：m2 主上游 C（纯参数错误 400）→ 不应切 B，直接返回 400
base.models['t-mr-m2'] = { provider: 't-mr-c', alias: [], fallbacks: ['t-mr-b'], maxConcurrent: 0 }
base.defaults = {
  ...(base.defaults || {}),
  retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
  failbackProbe: { enabled: false },
}
await save(base.providers, base.models, base.defaults)

// —— 场景 1：模型级拒绝 400 → 切备用上游 ——
const r1 = await chat('t-mr-m1')
const t1 = await r1.text()
check('1·模型级拒绝 400 切备用：m1(A 拒 400) → B 成功', r1.status === 200 && t1.includes('ok-B'), { status: r1.status, body: t1.slice(0, 120) })
check('1b·A 确实被尝试过', hits.A >= 1, { A: hits.A })

// —— 场景 2：纯参数错误 400 → 不切，直接返回 400 ——
const before2 = hits.B
const r2 = await chat('t-mr-m2')
const t2 = await r2.text()
check('2·纯参数错误 400 不切：m2(C 参数错) → 直接 400', r2.status === 400, { status: r2.status })
check('2b·B 未被尝试（参数错误换模型同样失败，不应浪费）', hits.B === before2, { B: hits.B, before: before2 })
check('2c·原始错误 body 保留透传', t2.includes('Invalid messages'), { body: t2.slice(0, 120) })

const after = await snapshot()
delete after.providers['t-mr-a']; delete after.providers['t-mr-b']; delete after.providers['t-mr-c']
delete after.models['t-mr-m1']; delete after.models['t-mr-m2']
after.defaults = origDefaults
await save(after.providers, after.models, after.defaults)
await new Promise(r => sA.close(r))
await new Promise(r => sB.close(r))
await new Promise(r => sC.close(r))
