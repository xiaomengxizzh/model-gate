import { GW, check, jpost } from './utils.mjs'

// 依赖「运行中的网关 + 实际配置了 deepseek-official 上游 + 管理鉴权」。条件不满足时优雅跳过而非崩溃。
let st
try { st = await (await fetch(GW + '/api/status')).json() } catch (e) { st = { providers: [] } }
const prov = (st.providers || []).find(p => p.id === 'deepseek-official')

if (!prov) {
  check('key 写入(ACL 加固下)仍正常', false, null, true)
  check('key 设置后 hasKey=true', false, null, true)
  check('key 清除后 hasKey=false', false, null, true)
  console.log('  跳过：需要当前网关已配置 deepseek-official 上游（含管理鉴权），未就绪')
} else {
  const r1 = await jpost('/api/keys', { id: 'deepseek-official', key: 'sk-acl-check' })
  await new Promise(r => setTimeout(r, 90))
  const on = (await st()).providers.find(p => p.id === 'deepseek-official').hasKey
  const r2 = await jpost('/api/keys', { id: 'deepseek-official', key: '' })
  await new Promise(r => setTimeout(r, 90))
  const off = (await st()).providers.find(p => p.id === 'deepseek-official').hasKey
  check('key 写入(ACL 加固下)仍正常', r1.s === 200, { status: r1.s })
  check('key 设置后 hasKey=true', on === true, { on })
  check('key 清除后 hasKey=false', off === false, { off })
}