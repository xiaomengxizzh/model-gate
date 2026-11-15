// 发布冻结检查（A5 第八轮后重写）：回执必须保留**真实采集树**，并显式批准"代码等价冻结"。
//
//   node scripts/test/offline/aggregation-freeze-check.mjs --freeze
//   node scripts/test/offline/aggregation-freeze-check.mjs
//
// 规则（全部 fail-closed）：
//   1. 冻结 SHA 存在、是 HEAD 祖先，且 frozen..HEAD 只允许 docs/** 改动；
//   2. 每条 PASS_REAL 回执：commitSha = 真实采集树（frozen 的祖先），且 collectionSha..frozen 之间
//      **不得有 src/** 改动**；回执另带 codeEquivalentFreeze = frozen；
//   3. 必须有 approvals 覆盖：`freeze-equivalence`（该采集范围）、每条 partialCases、
//      以及任何 conditionalOn 需求；缺一项即失败；
//   4. 状态表 PASS_REAL 行必须出现 frozen SHA（只是展示，不作为放行依据）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FROZEN_FILE = 'docs/evidence/v2-frozen-sha.txt'
const RECEIPTS = 'docs/evidence/aggregation-v2-receipts-2026-11-15.json'
const STATUS = 'docs/evidence/aggregation-v2-status-2026-11-15.md'
const APPROVALS = 'docs/evidence/v2-release-approvals.json'
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const head = git(['rev-parse', 'HEAD'])

if (process.argv.includes('--freeze')) {
  writeFileSync(join(ROOT, FROZEN_FILE), head + '\n')
  console.log('frozen: ' + head)
  process.exit(0)
}
if (!existsSync(join(ROOT, FROZEN_FILE))) {
  console.error('release:freeze FAIL — 尚未冻结（npm run release:freeze -- --freeze）')
  process.exit(1)
}
const frozen = readFileSync(join(ROOT, FROZEN_FILE), 'utf8').trim()
if (!/^[0-9a-f]{40}$/.test(frozen)) { console.error('release:freeze FAIL — 冻结文件不是完整 SHA'); process.exit(1) }
try { git(['merge-base', '--is-ancestor', frozen, 'HEAD']) } catch { console.error('release:freeze FAIL — 冻结 SHA 不是 HEAD 祖先'); process.exit(1) }

const failures = []
const touched = git(['diff', '--name-only', frozen + '..HEAD']).split('\n').filter(Boolean)
const nonDocs = touched.filter((f) => !f.startsWith('docs/'))
if (nonDocs.length) failures.push('冻结后出现非文档改动（必须重新冻结）：' + nonDocs.slice(0, 8).join(', '))

const receipts = JSON.parse(readFileSync(join(ROOT, RECEIPTS), 'utf8'))
const approvals = (JSON.parse(readFileSync(join(ROOT, APPROVALS), 'utf8')).approvals) || []
const has = (kind, id) => approvals.some((a) => a && a.kind === kind && (id == null || a.id === id))

const ranges = new Map()
for (const [id, rec] of Object.entries(receipts)) {
  if (!rec || rec.status !== 'PASS_REAL') continue
  const collection = String(rec.commitSha || '')
  if (!/^[0-9a-f]{40}$/.test(collection)) { failures.push(id + ' 回执缺少真实采集 SHA'); continue }
  try { git(['merge-base', '--is-ancestor', collection, frozen]) } catch { failures.push(id + ' 采集树 ' + collection.slice(0, 8) + ' 不是冻结树祖先'); continue }
  if (rec.codeEquivalentFreeze !== frozen) failures.push(id + ' 缺少 codeEquivalentFreeze=' + frozen.slice(0, 8))
  if (collection !== frozen) {
    const changed = git(['diff', '--name-only', collection + '..' + frozen]).split('\n').filter(Boolean)
    const srcChanged = changed.filter((f) => f.startsWith('src/'))
    if (srcChanged.length) failures.push(id + ' 采集树到冻结树之间有 src/** 改动：' + srcChanged.slice(0, 5).join(', '))
    ranges.set(collection, (ranges.get(collection) || []).concat(id))
  }
  for (const c of (rec.partialCases || [])) {
    if (!has('partial-case', id + ':' + c)) failures.push(id + ' 的用例 ' + c + ' 在冻结树未复现，缺少所有者/A5 批准（partial-case）')
  }
  if (rec.conditionalOn && !has('requirement-form', id)) failures.push(id + ' 为条件通过（' + rec.conditionalOn + '），缺少批准（requirement-form）')
}
for (const [collection, ids] of ranges) {
  if (!has('freeze-equivalence', collection)) failures.push('缺少代码等价冻结批准：' + collection.slice(0, 8) + ' → ' + frozen.slice(0, 8) + '（覆盖 ' + ids.join(',') + '）')
}

const status = readFileSync(join(ROOT, STATUS), 'utf8')
const rows = status.split('\n').filter((l) => /^\|\s*MG-R\d{3}\s*\|\s*`PASS_REAL`/.test(l))
for (const row of rows) {
  const id = row.match(/MG-R\d{3}/)[0]
  if (!row.includes(frozen)) failures.push(id + ' 状态依据缺少冻结 SHA ' + frozen.slice(0, 8))
}
const missing = ['MG-R001','MG-R002','MG-R003','MG-R004','MG-R005','MG-R006','MG-R007','MG-R008','MG-R009','MG-R010','MG-R011','MG-R012'].filter((id) => !receipts[id])
if (missing.length) failures.push('缺少回执：' + missing.join(','))

if (failures.length) {
  console.error('release:freeze FAIL — 冻结树 ' + frozen.slice(0, 8) + '：')
  for (const f of failures) console.error('  - ' + f)
  console.error('规则：回执保留真实采集树；代码等价冻结与 partial/条件通过必须由所有者/A5 显式批准；不要用改 SHA 代替重跑。')
  process.exitCode = 1
} else {
  console.log('release:freeze PASS — 冻结树 ' + frozen.slice(0, 8) + '，' + rows.length + ' 项 PASS_REAL 均已绑定真实采集树并获批准；冻结后仅文档改动（' + touched.length + ' 个文件）')
}
