// 空 model 且未设默认上游 → 显式 400（MG-004：自建隔离实例，不再改目标配置）
import { startGateway } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const fx = await startGateway({ name: 'empty-model', config: { defaults: { provider: null }, providers: {}, models: {} } })
try {
  const r = await fx.post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
  const tx = await r.text()
  check('空 model·显式 400(missing_model)', r.status === 400 && tx.includes('missing_model'), { status: r.status })
} finally {
  await fx.stop()
}
finish('empty-model')
