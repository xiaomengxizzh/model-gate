// 延迟历史趋势：状态直读 /api/status 的 global.latTrend（面板 sparkline 数据源）
// MG-004：自建隔离实例（mock 上游 + 动态端口），不再依赖外部运行中的网关。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const up = await startMockServer((req, res) => {
  req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
})
const fx = await startGateway({
  name: 'trend',
  config: { providers: { 't-tr': { baseUrl: up.base, apiKeyEnv: '', api: 'openai', pathPrefix: '', extraHeaders: {} } }, models: { 't-tr-m': { provider: 't-tr', alias: [], fallbacks: [], maxConcurrent: 0 } } },
})
try {
  const r = await fx.chat('t-tr-m')
  check('延迟趋势·采样前请求可成功', r.status === 200, { status: r.status })
  const st = await fx.status()
  const trend = st.global && st.global.latTrend
  check('延迟趋势·latTrend 时间序列存在', Array.isArray(trend), { len: trend ? trend.length : 0 })
} finally {
  await fx.stop(); await up.stop()
}
finish('trend')
