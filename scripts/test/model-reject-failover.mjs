// 模型级拒绝（400 + 模型不可用语义）故障转移契约：
// 上游对「模型不可用」返回 400（opencodego 的 Provider rejected the model request / Model not supported、
// jiyuan 的 MODEL_DISABLED）时，网关应视同 403/404 继续目录链切下一模型，而非把 400 直接抛给客户端。
// 对照：纯参数错误 400（如 invalid messages）不应切换（换模型同样失败），直接返回保留原始错误。
// MG-004：自建隔离实例，不再读写目标网关配置。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const hits = { A: 0, B: 0, C: 0 }
// A：模型级拒绝 400——响应体含「Provider rejected the model request」（opencodego 现场实证文案）
const sA = await startMockServer((req, res) => {
  hits.A += 1
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Provider rejected the model request', type: 'invalid_request_error' } }))
})
// B：正常上游——完整 JSON 响应
const sB = await startMockServer((req, res) => {
  hits.B += 1
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 't-mr-m1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok-B' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
// C：纯参数错误 400——响应体不含模型不可用语义（如 messages 格式非法）
const sC = await startMockServer((req, res) => {
  hits.C += 1
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Invalid messages: content must be a string', type: 'invalid_request_error' } }))
})

const fx = await startGateway({
  name: 'model-reject',
  config: {
    providers: {
      't-mr-a': { baseUrl: sA.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
      't-mr-b': { baseUrl: sB.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
      't-mr-c': { baseUrl: sC.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
    },
    models: {
      't-mr-m1': { provider: 't-mr-a', alias: [], fallbacks: ['t-mr-b'], maxConcurrent: 0 },
      't-mr-m2': { provider: 't-mr-c', alias: [], fallbacks: ['t-mr-b'], maxConcurrent: 0 },
    },
    defaults: {
      retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
      directory: [],
      failbackProbe: { enabled: false },
    },
  },
})
try {
  const r1 = await fx.chat('t-mr-m1')
  const t1 = await r1.text()
  check('1·模型级拒绝 400 切备用：m1(A 拒 400) → B 成功', r1.status === 200 && t1.includes('ok-B'), { status: r1.status, body: t1.slice(0, 120) })
  check('1b·A 确实被尝试过', hits.A >= 1, { A: hits.A })

  const before2 = hits.B
  const r2 = await fx.chat('t-mr-m2')
  const t2 = await r2.text()
  check('2·纯参数错误 400 不切：m2(C 参数错) → 直接 400', r2.status === 400, { status: r2.status })
  check('2b·B 未被尝试（参数错误换模型同样失败，不应浪费）', hits.B === before2, { B: hits.B, before: before2 })
  check('2c·原始错误 body 保留透传', t2.includes('Invalid messages'), { body: t2.slice(0, 120) })
} finally {
  await fx.stop(); await sA.stop(); await sB.stop(); await sC.stop()
}
finish('model-reject-failover')
