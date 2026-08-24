// 测试索引运行器：node scripts/test/run.mjs [filter]
// filter 按文件名/主题关键词筛选；如 node scripts/test/run.mjs sse / format
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

console.log('网关: ' + GW + '  筛选: ' + (filter || '全部'))
for (const f of list) {
  console.log('\n== ' + f + ' ==')
  await import('./' + f)
}
const c = count()
console.log('\n=== 结果: ' + c.pass + '/' + c.total + ' 通过' + (c.fail ? '，失败 ' + c.fail : '') + ' ===')
setTimeout(() => { try { process.exit(c.fail ? 1 : 0) } catch {} }, 200)