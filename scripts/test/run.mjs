// 测试索引运行器：node scripts/test/run.mjs [filter]
// filter 按文件名/主题关键词筛选；如 node scripts/test/run.mjs sse / format
// 说明：本套件为「依赖真实运行网关 + 上游配置 + 管理鉴权」的集成测试。
// 运行器对每个文件做错误隔离，单个文件崩溃不会中断整次运行；网关/鉴权未就绪时给出预检提示。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GW, count } from './utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const filter = (process.argv[2] || '').toLowerCase()
const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.mjs') && !['run.mjs', 'utils.mjs'].includes(f))
  .sort()
const list = filter ? files.filter((f) => f.toLowerCase().includes(filter)) : files
if (!list.length) { console.log('无匹配测试: ' + filter + '（可选: ' + files.join(', ') + '）'); process.exit(2) }

// 预检：依赖真实运行网关；不可达或需鉴权时先给明确提示，再逐文件做错误隔离
let preflight = ''
try {
  const r = await fetch(GW + '/api/status')
  if (!r.ok) preflight = ' HTTP(' + r.status + ')（可能未配置管理鉴权）'
  else { const j = await r.json().catch(() => null); if (j && j.needAuth) preflight = '，需管理鉴权(MG_ADMIN_TOKEN)' }
} catch { preflight = '，网关不可达' }

console.log('网关: ' + GW + '  筛选: ' + (filter || '全部') + (preflight ? '  预检' + preflight : ''))

const errored = []
for (const f of list) {
  console.log('\n== ' + f + ' ==')
  try { await import('./' + f) }
  catch (e) { errored.push(f); console.log('ERROR  ' + f + ' :: ' + ((e && e.message) || String(e))) }
}
const c = count()
const bad = c.fail + errored.length
const errNote = errored.length ? '，出错 ' + errored.length + ' [' + errored.join(', ') + ']' : ''
console.log('\n=== 结果: ' + c.pass + '/' + c.total + ' 通过' + (c.fail ? '，失败 ' + c.fail : '') + errNote + ' ===')
setTimeout(() => { try { process.exit(bad ? 1 : 0) } catch {} }, 200)