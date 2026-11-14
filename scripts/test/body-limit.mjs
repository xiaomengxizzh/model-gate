// 请求体大小上限（MG-004：实例以 maxBodyBytes=1000 启动，不再依赖外部 MG_MAX_BODY 配置，故无 SKIP）
import { startGateway } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const LIMIT = 1000
const fx = await startGateway({ name: 'body-limit', config: { server: { maxBodyBytes: LIMIT } } })
try {
  const LARGE = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'A'.repeat(2000) }] })
  const r = await fx.post('/v1/chat/completions', LARGE)
  const tx = await r.text()
  check('请求体超限→413', r.status === 413 && tx.includes('payload_too_large'), { status: r.status, limit: LIMIT })
} finally {
  await fx.stop()
}
finish('body-limit')
