// 离线验收运行器：node scripts/test/offline/run.mjs [filter]
// 与 scripts/test/run.mjs（依赖真实网关）严格分离；本目录不访问 8787、不读取生产配置。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetResults, summary } from './harness.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const filter = (process.argv[2] || '').toLowerCase()
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.mjs'))
  .sort()
  .filter(f => !filter || f.toLowerCase().includes(filter))
if (!files.length) { console.log('无匹配离线测试: ' + filter); process.exit(2) }

let pass = 0, fail = 0, errored = []
for (const f of files) {
  console.log('\n=== ' + f + ' ===')
  try {
    resetResults()
    await import('./' + f)
    const s = summary(); pass += s.pass; fail += s.fail
  } catch (e) {
    errored.push(f)
    console.log('ERROR ' + f + ' :: ' + ((e && e.stack) || e))
  }
}
console.log('\n=== 离线结果: ' + pass + ' 通过, ' + fail + ' 失败' + (errored.length ? ', ' + errored.length + ' 文件出错' : '') + ' ===')
process.exit(fail || errored.length ? 1 : 0)
