// key 加密落盘（MG-004：夹具显式设置 MG_KEYS_MASTER，故必然启用加密，不再 SKIP；临时 keys.local.json 随实例目录清理）
import fs from 'node:fs'
import { join } from 'node:path'
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const up = await startMockServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) })
const fx = await startGateway({
  name: 'key-encrypt',
  config: { providers: { 'deepseek-official': { baseUrl: up.base, apiKeyEnv: '', api: 'openai', pathPrefix: '', extraHeaders: {} } }, models: {} },
})
try {
  const st0 = await fx.status()
  check('key 加密·实例确实以主密钥启动', st0.server.keyEncrypted === true, { keyEncrypted: st0.server.keyEncrypted })
  const keysPath = join(fx.dir, 'keys.local.json')
  const r1 = await fx.post('/api/keys', { id: 'deepseek-official', key: 'sk-secret-demo' }, fx.admin)
  await new Promise(r => setTimeout(r, 120))
  const raw = fs.existsSync(keysPath) ? fs.readFileSync(keysPath, 'utf8') : ''
  check('key 加密·写入成功且文件为密文', r1.status === 200 && raw.trimStart().startsWith('MG1:'), { enc: raw.trimStart().slice(0, 4) })
  await fx.post('/api/keys', { id: 'deepseek-official', key: '' }, fx.admin)
  await new Promise(r => setTimeout(r, 120))
  const off = ((await fx.status()).providers.find(p => p.id === 'deepseek-official') || {}).hasKey
  check('key 加密·解密读取正常(清除后 hasKey=false)', off === false, { off })
} finally {
  await fx.stop(); await up.stop()
}
finish('key-encrypt')
