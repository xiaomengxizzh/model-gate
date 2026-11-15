// 发布冻结检查（A5 第七轮要求）：所有 PASS_REAL 必须绑定**当前冻结 SHA**，否则不得发布。
//
//   node scripts/test/offline/aggregation-freeze-check.mjs
//
// 检查两处：
//   1. docs/evidence/aggregation-v2-receipts-2026-11-15.json 里每个 PASS_REAL 的 commitSha 必须等于 HEAD；
//   2. 状态文档里每个 PASS_REAL 行的依据必须出现完整的 HEAD SHA。
// 任一条不满足 → exit 1 并列出需要重跑的项。中间树回执只用于推进，不作为发布证据。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RECEIPTS = 'docs/evidence/aggregation-v2-receipts-2026-11-15.json'
const STATUS = 'docs/evidence/aggregation-v2-status-2026-11-15.md'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const receipts = JSON.parse(readFileSync(join(ROOT, RECEIPTS), 'utf8'))
const status = readFileSync(join(ROOT, STATUS), 'utf8')

const stale = []
for (const [id, rec] of Object.entries(receipts)) {
  if (rec && rec.status === 'PASS_REAL' && rec.commitSha !== head) {
    stale.push(id + ' receipt bound to ' + String(rec.commitSha).slice(0, 8))
  }
}
const rows = status.split('\n').filter((l) => /^\|\s*MG-R\d{3}\s*\|\s*`PASS_REAL`/.test(l))
for (const row of rows) {
  const id = row.match(/MG-R\d{3}/)[0]
  if (!row.includes(head)) stale.push(id + ' status basis lacks frozen SHA ' + head.slice(0, 8))
}

if (stale.length) {
  console.error('release:freeze FAIL — 以下 PASS_REAL 未在冻结树 ' + head.slice(0, 8) + ' 上重跑：')
  for (const s of stale) console.error('  - ' + s)
  console.error('按 V2 P05：冻结 SHA 后重新执行核心路径，再更新回执与状态依据。')
  process.exitCode = 1
} else {
  console.log('release:freeze PASS — 所有 PASS_REAL 均绑定 ' + head.slice(0, 8) + '（' + rows.length + ' 项）')
}
