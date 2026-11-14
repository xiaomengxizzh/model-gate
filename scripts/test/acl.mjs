// key 写入/清除在管理鉴权下仍正常（MG-004：自建隔离实例 + 显式 dummy provider，不再依赖目标网关已配置 deepseek-official），无 SKIP。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const up = await startMockServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) })
const fx = await startGateway({
  name: 'acl',
  config: { providers: { 'deepseek-official': { baseUrl: up.base, apiKeyEnv: '', api: 'openai', pathPrefix: '', extraHeaders: {} } }, models: {} },
})
try {
  const r1 = await fx.post('/api/keys', { id: 'deepseek-official', key: 'sk-acl-check' }, fx.admin)
  await new Promise(r => setTimeout(r, 90))
  const on = ((await fx.status()).providers || []).find(p => p.id === 'deepseek-official')?.hasKey
  const r2 = await fx.post('/api/keys', { id: 'deepseek-official', key: '' }, fx.admin)
  await new Promise(r => setTimeout(r, 90))
  const off = ((await fx.status()).providers || []).find(p => p.id === 'deepseek-official')?.hasKey
  check('key 写入(ACL 加固下)仍正常', r1.status === 200, { status: r1.status })
  check('key 设置后 hasKey=true', on === true, { on })
  check('key 清除后 hasKey=false', off === false, { off })
} finally {
  await fx.stop(); await up.stop()
}
finish('acl')
