#!/usr/bin/env node
// D2 版本化/回滚端到端（离线）：生成 v1 → 加模型生成 v2 → 回滚 prev，校验内容与哈希。
// 只用临时目录与合成配置；不触真实配置、不联网。
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const NL = String.fromCharCode(10)
const CLI = process.env.MG_CATALOG_CLI || 'scripts/codex-catalog.mjs'
const basePath = process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const checks = []
const check = (n, ok, d) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' :: ' + d : '')) }
const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000 })

const dir = await mkdtemp(join(tmpdir(), 'mg-e2-rollback-'))
const state = join(dir, 'state')
const out = join(dir, 'catalog.json')
try {
  const cfgV1 = join(dir, 'gw-v1.json')
  await writeFile(cfgV1, JSON.stringify({ providers: { third: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai' } }, models: { alpha: { provider: 'third', api: 'openai', maxContext: 128000 } } }))
  run(['--base', basePath, '--models', cfgV1, '--out', out, '--state-dir', state])
  const h1 = sha(await readFile(out))
  const v1 = JSON.parse(await readFile(out, 'utf8')).models.map((m) => m.slug)
  check('v1 生成成功且含 mg-third-alpha', v1.includes('mg-third-alpha'), 'models=' + v1.length)

  const cfgV2 = join(dir, 'gw-v2.json')
  await writeFile(cfgV2, JSON.stringify({ providers: { third: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai' } }, models: { alpha: { provider: 'third', api: 'openai', maxContext: 128000 }, beta: { provider: 'third', api: 'openai', maxContext: 128000 } } }))
  run(['--base', basePath, '--models', cfgV2, '--out', out, '--state-dir', state])
  const h2 = sha(await readFile(out))
  const v2 = JSON.parse(await readFile(out, 'utf8')).models.map((m) => m.slug)
  check('v2 含 mg-third-beta 且与 v1 内容不同', v2.includes('mg-third-beta') && h2 !== h1, 'models=' + v2.length)

  const versions = run(['--list-versions', '--state-dir', state])
  check('版本历史至少 2 条', (versions.match(/v\d{6}/g) || []).length >= 2, versions.split(NL).filter(Boolean).length + ' lines')
  const status2 = run(['--status', '--state-dir', state, '--out', out])
  check('status 报告当前版本与 v2 一致', /v0*2|current/.test(status2), status2.split(NL)[0].slice(0, 120))

  run(['--rollback', 'prev', '--out', out, '--state-dir', state])
  const h3 = sha(await readFile(out))
  const v3 = JSON.parse(await readFile(out, 'utf8')).models.map((m) => m.slug)
  check('回滚后内容与 v1 字节一致', h3 === h1)
  check('回滚后不再含 beta', !v3.includes('mg-third-beta') && v3.includes('mg-third-alpha'))

  if (process.env.CODEX_BIN) {
    const { execFileSync: ex } = await import('node:child_process')
    const home = await mkdtemp(join(tmpdir(), 'mg-e2-rollback-home-'))
    try {
      const r = ex(process.env.CODEX_BIN, ['debug', 'models', '-c', 'model_catalog_json="' + out + '"'], { encoding: 'utf8', env: Object.assign({}, process.env, { CODEX_HOME: home }), timeout: 60000 })
      const parsed = JSON.parse(r)
      check('回滚产物可被 codex debug models 解析', Array.isArray(parsed.models) && parsed.models.length === v3.length, 'models=' + parsed.models.length)
    } finally { await rm(home, { recursive: true, force: true }) }
  } else {
    console.log('SKIP  codex 校验（未设置 CODEX_BIN）')
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log(NL + (checks.length - failed) + '/' + checks.length + ' catalog-rollback checks passed')
process.exitCode = failed ? 1 : 0
