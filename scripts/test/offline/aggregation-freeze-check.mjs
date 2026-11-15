// 发布冻结检查（A5 第七轮要求 + P05）：所有 PASS_REAL 必须绑定**冻结 SHA**，且冻结后只能改文档。
//
//   node scripts/test/offline/aggregation-freeze-check.mjs --freeze   # 冻结当前 HEAD（写入 frozen-sha.txt）
//   node scripts/test/offline/aggregation-freeze-check.mjs            # 校验
//
// 规则：
//   1. 冻结 SHA 必须存在、且是当前 HEAD 的祖先；
//   2. frozen..HEAD 之间只允许 docs/** 改动（回执/状态/裁决属文档；任何 src/scripts 改动都要重新冻结）；
//   3. 回执 JSON 里每个 PASS_REAL 的 commitSha 必须等于冻结 SHA；
//   4. 状态文档里每个 PASS_REAL 行的依据必须出现冻结 SHA。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FROZEN_FILE = 'docs/evidence/v2-frozen-sha.txt'
const RECEIPTS = 'docs/evidence/aggregation-v2-receipts-2026-11-15.json'
const STATUS = 'docs/evidence/aggregation-v2-status-2026-11-15.md'
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const head = git(['rev-parse', 'HEAD'])

if (process.argv.includes('--freeze')) {
  writeFileSync(join(ROOT, FROZEN_FILE), head + '\n')
  console.log('frozen: ' + head)
  process.exit(0)
}

if (!existsSync(join(ROOT, FROZEN_FILE))) {
  console.error('release:freeze FAIL — 尚未冻结。先确认代码不再改动，再运行：npm run release:freeze -- --freeze')
  process.exit(1)
}
const frozen = readFileSync(join(ROOT, FROZEN_FILE), 'utf8').trim()
if (!/^[0-9a-f]{40}$/.test(frozen)) {
  console.error('release:freeze FAIL — 冻结文件内容不是完整 SHA')
  process.exit(1)
}
try { git(['merge-base', '--is-ancestor', frozen, 'HEAD']) } catch {
  console.error('release:freeze FAIL — 冻结 SHA ' + frozen.slice(0, 8) + ' 不是当前 HEAD 的祖先')
  process.exit(1)
}

const touched = git(['diff', '--name-only', frozen + '..HEAD']).split('\n').filter(Boolean)
const nonDocs = touched.filter((f) => !f.startsWith('docs/'))
const failures = []
if (nonDocs.length) failures.push('冻结后出现非文档改动（必须重新冻结）：' + nonDocs.slice(0, 8).join(', '))

const receipts = JSON.parse(readFileSync(join(ROOT, RECEIPTS), 'utf8'))
const status = readFileSync(join(ROOT, STATUS), 'utf8')
for (const [id, rec] of Object.entries(receipts)) {
  if (rec && rec.status === 'PASS_REAL' && rec.commitSha !== frozen) {
    failures.push(id + ' 回执绑定 ' + String(rec.commitSha).slice(0, 8) + '，不是冻结树 ' + frozen.slice(0, 8))
  }
}
const rows = status.split('\n').filter((l) => /^\|\s*MG-R\d{3}\s*\|\s*`PASS_REAL`/.test(l))
for (const row of rows) {
  const id = row.match(/MG-R\d{3}/)[0]
  if (!row.includes(frozen)) failures.push(id + ' 状态依据缺少冻结 SHA ' + frozen.slice(0, 8))
}

if (failures.length) {
  console.error('release:freeze FAIL — 冻结树 ' + frozen.slice(0, 8) + '：')
  for (const f of failures) console.error('  - ' + f)
  console.error('按 V2 P05：在冻结 SHA 上重跑核心路径，更新回执与状态依据后再发布。')
  process.exitCode = 1
} else {
  console.log('release:freeze PASS — 冻结树 ' + frozen.slice(0, 8) + '，' + rows.length + ' 项 PASS_REAL 均已绑定；冻结后仅文档改动（' + touched.length + ' 个文件）')
}
