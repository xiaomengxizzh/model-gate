#!/usr/bin/env node
// E6 端到端：经真实 /api/codex/* 对临时 config.toml 走 plan → apply → rollback。
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { startGateway } from './offline/harness.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')
const checks = []
const check = (n, ok, d) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' :: ' + d : '')) }
const NL = String.fromCharCode(10)

const original = [
  '# user comment kept verbatim',
  'model = "old-model"',
  'model_provider = "modelgate"',
  'approval_policy = "on-request"',
  '',
  '[features]',
  'multi_agent = true',
  '',
  '[mcp_servers.local]',
  'command = "node"',
  'args = ["server.js"]',
  '',
  '[permissions]',
  'mode = "safe"',
  '',
  '[unknown_section]',
  'foo = "bar"',
  ''
].join(NL)

const dir = await mkdtemp(join(tmpdir(), 'mg-e6-e2e-'))
const cfgPath = join(dir, 'config.toml')
await writeFile(cfgPath, original)
const gw = await startGateway({ name: 'e6-e2e', env: { MG_ADMIN_TOKEN: 'e6-test-token' }, config: { defaults: { model: '', codexCatalogBasePath: '/tmp/mg-e0/catalog-default.json', codexOfficialProvider: 'codex-official' } } })
const auth = { authorization: 'Bearer e6-test-token' }
const post = (p, b, headers = {}) => fetch(gw.base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth, headers), body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))

const desired = {
  topLevel: { model_provider: 'openai', openai_base_url: 'http://127.0.0.1:8787', model: 'gpt-6-astra', model_catalog_json: '/tmp/catalog.json' },
  sections: { features: { multi_agent_v2: true } },
}
try {
  const noAuth = await fetch(gw.base + '/api/codex/policy').then((r) => r.status)
  check('未鉴权 → 401', noAuth === 401, 'status=' + noAuth)

  const forbidden = await post('/api/codex/config/plan', { path: join(dir, 'auth.json'), desired })
  check('auth.json 被路径护栏拒绝（403）', forbidden.status === 403 && forbidden.json.code === 'forbidden_path', JSON.stringify(forbidden.json))

  const beforeSha = sha(Buffer.from(original))
  const plan = await post('/api/codex/config/plan', { path: cfgPath, desired })
  check('plan 200 且返回 confirmToken', plan.status === 200 && typeof plan.json.confirmToken === 'string', 'status=' + plan.status)
  check('plan 后文件未被写入', sha(await readFile(cfgPath)) === beforeSha)
  const changedCount = Array.isArray(plan.json.changed) ? plan.json.changed.length : (plan.json.changed && typeof plan.json.changed === 'object' ? Object.keys(plan.json.changed).length : (plan.json.changed ? 1 : 0));
  check('plan 报告有变更项', changedCount > 0, 'changedCount=' + changedCount)

  const apply = await post('/api/codex/config/apply', { path: cfgPath, desired, expected: plan.json.before, confirmToken: plan.json.confirmToken })
  check('apply 200', apply.status === 200, JSON.stringify(apply.json && apply.json.code || apply.status))
  const after = await readFile(cfgPath, 'utf8')
  check('所有权字段已更新', /model_provider = "openai"/.test(after) && /openai_base_url = "http:\/\/127\.0\.0\.1:8787"/.test(after) && /model = "gpt-6-astra"/.test(after), after.split(NL).slice(0, 5).join(' | '))
  check('MCP/权限/未知段/注释逐字保留', after.includes('[mcp_servers.local]') && after.includes('command = "node"') && after.includes('[permissions]') && after.includes('[unknown_section]') && after.includes('foo = "bar"') && after.includes('# user comment kept verbatim'))
  check('features.multi_agent_v2 写入且 multi_agent 保留', /multi_agent_v2 = true/.test(after) && /multi_agent = true/.test(after))
  const bak = await readFile(apply.json.backupPath, 'utf8')
  check('.bak 保存原始内容', bak === original, 'backup=' + apply.json.backupPath)

  const rb = await post('/api/codex/config/rollback', { path: cfgPath, backupPath: apply.json.rollback.backupPath, expectedSha256: apply.json.rollback.expectedSha256, confirmToken: apply.json.rollback.confirmToken })
  check('rollback 200', rb.status === 200, JSON.stringify(rb.json && rb.json.code || rb.status))
  check('回滚后与原始字节一致', sha(await readFile(cfgPath)) === beforeSha)

  const plan2 = await post('/api/codex/config/plan', { path: cfgPath, desired })
  await writeFile(cfgPath, original + NL + '# external edit' + NL)
  const conflict = await post('/api/codex/config/apply', { path: cfgPath, desired, expected: plan2.json.before, confirmToken: plan2.json.confirmToken })
  check('外部并发修改 → 409 concurrent_modification', conflict.status === 409 && conflict.json.code === 'concurrent_modification', JSON.stringify(conflict.json))
  check('冲突时文件保持外部版本', (await readFile(cfgPath, 'utf8')).includes('# external edit'))
} finally {
  await gw.stop()
  await rm(dir, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log(NL + (checks.length - failed) + '/' + checks.length + ' config-e2e checks passed')
process.exitCode = failed ? 1 : 0
