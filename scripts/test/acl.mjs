import { GW, check, jpost } from './utils.mjs'
const st = () => fetch(GW + '/api/status').then(r => r.json())
const r1 = await jpost('/api/keys', { id: 'deepseek-official', key: 'sk-acl-check' })
await new Promise(r => setTimeout(r, 90))
const on = (await st()).providers.find(p => p.id === 'deepseek-official').hasKey
const r2 = await jpost('/api/keys', { id: 'deepseek-official', key: '' })
await new Promise(r => setTimeout(r, 90))
const off = (await st()).providers.find(p => p.id === 'deepseek-official').hasKey
check('key 写入(ACL 加固下)仍正常', r1.s === 200, { status: r1.s })
check('key 设置后 hasKey=true', on === true, { on })
check('key 清除后 hasKey=false', off === false, { off })