import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GW, check, jpost, snapshot } from './utils.mjs'
const st0 = await snapshot()
if (!st0.server.keyEncrypted) { check('key 加密存储', true, null, true) }
else {
  const keysPath = fileURLToPath(new URL('../../config/keys.local.json', import.meta.url))
  const r1 = await jpost('/api/keys', { id: 'deepseek-official', key: 'sk-secret-demo' })
  await new Promise(r => setTimeout(r, 120))
  const raw = fs.existsSync(keysPath) ? fs.readFileSync(keysPath, 'utf8') : ''
  check('key 加密·写入成功且文件为密文', r1.s === 200 && raw.trimStart().startsWith('MG1:'), { enc: raw.trimStart().slice(0, 4) })
  await jpost('/api/keys', { id: 'deepseek-official', key: '' })
  await new Promise(r => setTimeout(r, 120))
  const st2 = await (await fetch(GW + '/api/status')).json()
  const off = (st2.providers.find(p => p.id === 'deepseek-official') || {}).hasKey
  check('key 加密·解密读取正常(清除后 hasKey=false)', off === false, { off })
}