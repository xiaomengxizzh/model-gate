// ModelGate product contract consistency guard: read-only, offline, no dependencies.
// WARNING: protection against a write-capable adversary requires externally controlled
// owner-signed requirements, protected branches, required checks and CODEOWNERS.
// This script detects accidental drift; it does NOT independently enforce owner authority.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')
const failures = []
const ok = (condition, message) => { if (!condition) failures.push(message) }

const contract = read('docs/product/2026-11-14-owner-product-contract.md')
const plan = read('docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md')
const prompt = read('docs/roadmap/2026-11-14-aggregation-agentteam-start.md')
const agents = read('AGENTS.md')
const workflow = read('.github/workflows/check.yml')
const pkg = JSON.parse(read('package.json'))

const ids = Array.from({ length: 12 }, (_, i) => 'MG-R' + String(i + 1).padStart(3, '0'))
const actual = [...contract.matchAll(/^\|\s*(MG-R\d{3})\s*\|/gm)].map(x => x[1])
ok(JSON.stringify(actual) === JSON.stringify(ids), 'product contract must contain all MG-R001..MG-R012 in order exactly once')
for (const id of ids) {
  ok(plan.includes(id), 'implementation plan missing ' + id)
  ok(contract.includes(id), 'contract missing ' + id)
}
for (const phrase of [
  '聚合模式', 'ChatGPT 套餐', 'OpenCode', '原版 Codex Desktop',
  '原生', '全部可用', '禁止私自降级', 'GPT-6 Luna',
]) ok(contract.includes(phrase), 'product contract core concept missing: ' + phrase)

for (const phase of ['P00', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06']) {
  ok(plan.includes(phase), 'implementation plan missing stage ' + phase)
}
for (const role of ['主代理', 'A1', 'A2', 'A3', 'A4', 'A5']) {
  ok(prompt.includes('【' + role) || (role === '主代理' && prompt.includes('主代理角色激活')), 'launch prompt missing role ' + role)
}
ok(prompt.includes('最多 5 个并发子代理'), 'launch prompt must cap subagent concurrency at five')
ok(prompt.includes('GPT-6 Luna') && prompt.includes('gpt-6-luna'), 'launch prompt must pin GPT parent to Luna')
ok(plan.includes('gpt-6-luna'), 'plan must pin GPT parent to Luna')
ok(agents.includes('2026-11-14-owner-product-contract.md'), 'AGENTS.md must link owner contract')
ok(pkg.scripts && pkg.scripts['contract:check'] === 'node scripts/check-product-contract.mjs',
  'package.json must expose contract:check')
ok(workflow.includes('npm run contract:check'), 'GitHub CI must run product contract consistency guard')
ok(contract.includes('仅所有者') && contract.includes('外部验收'),
  'contract must require owner approval and independent acceptance')
ok(prompt.includes('不得擅自合并 main'), 'prompt must prohibit unauthorized main merge')

// V2 owner-approved scope guard: V1 contract and historical matrix remain unmodified.
// This is a text consistency check, NOT the new acceptance gate; migration is task V2-00.
const v2Scope = read('docs/product/2026-11-14-owner-scope-v2.md')
const v2Plan = read('docs/roadmap/2026-11-14-go-deepseek-native-compact-plan.md')
const v2Prompt = read('docs/roadmap/2026-11-14-go-deepseek-native-compact-start.md')
const v2Rows = [...v2Scope.matchAll(/^\\|\\s*(MG-R\\d{3})\\s*\\|/gm)].map(x => x[1])
ok(JSON.stringify(v2Rows) === JSON.stringify(ids),
  'active V2 scope must list MG-R001..MG-R012 exactly once')
for (const id of ids) {
  ok(v2Plan.includes(id) || id !== 'MG-R006', 'active V2 plan omits compaction requirement ' + id)
}
for (const word of ['deepseek-v4.1-flash','Codex','原生压缩','不得自建压缩']) {
  ok(v2Scope.includes(word), 'active V2 scope missing ' + word)
}
for (const word of ['native compaction','compaction','gpt-6-luna','OPTIONAL_STOP']) {
  ok(v2Plan.toLowerCase().includes(word.toLowerCase()), 'active V2 plan missing ' + word)
}
for (const role of ['A1','A2','A3','A4','A5']) {
  ok(v2Prompt.includes('【' + role + ' 子代理角色激活'), 'active V2 prompt missing ' + role)
}
ok(v2Prompt.includes('最多 5 个子代理') && v2Prompt.includes('gpt-6-luna'),
  'active V2 prompt must cap team at 5 and pin Luna')
ok(agents.includes('2026-11-14-owner-scope-v2.md'), 'AGENTS.md must prioritize active V2 scope')

for (const failure of failures) console.error('FAIL product-contract: ' + failure)
if (!failures.length) console.log('Product contract consistency PASS: ' + ids.length + ' requirements, 7 stages, 5 subagent roles')
else { console.error('Product contract consistency FAILED: ' + failures.length); process.exitCode = 1 }
