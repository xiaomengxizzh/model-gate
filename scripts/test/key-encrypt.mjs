import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GW, check, jpost, snapshot } from './utils.mjs'
const st0 = await snapshot()
const pid = Object.keys(st0.providers || {})[0] || ''
if (!st0.server.keyEncrypted || !pid) { check('key 加密存储（无上游或未加密则跳过）', true, null, true) }
else {
  // 隔离实例用 MG_CONFIG_DIR；默认 cwd/config。不要写死仓库 config 路径。
  const cfgDir = process.env.MG_CONFIG_DIR || fileURLToPath(new URL('../../config', import.meta.url))
  const keysPath = cfgDir + '/keys.local.json'
  const r1 = await jpost('/api/keys', { id: pid, key: 'sk-secret-demo' })
  await new Promise(r => setTimeout(r, 120))
  const raw = fs.existsSync(keysPath) ? fs.readFileSync(keysPath, 'utf8') : ''
  check('key 加密·写入成功且文件为密文', r1.s === 200 && raw.trimStart().startsWith('MG1:'), { enc: raw.trimStart().slice(0, 4) })
  await jpost('/api/keys', { id: pid, key: '' })
  await new Promise(r => setTimeout(r, 120))
  const st2 = await (await fetch(GW + '/api/status')).json()
  const off = (st2.providers.find(p => p.id === pid) || {}).hasKey
  check('key 加密·解密读取正常(清除后 hasKey=false)', off === false, { off })
}