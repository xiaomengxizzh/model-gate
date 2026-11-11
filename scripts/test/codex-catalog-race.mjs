#!/usr/bin/env node
// D2 并发写探测（离线）：两个目录生成进程共用同一个 --state-dir，观察是否出现状态损坏。
// 目的：把"单写者假设"从推断变成有证据的结论（即便结论是"存在竞争"也要如实记录）。
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NL = String.fromCharCode(10)
const CLI = process.env.MG_CATALOG_CLI || 'scripts/codex-catalog.mjs'
const basePath = process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json'
const ROUNDS = Number(process.env.MG_RACE_ROUNDS || 5)
const learn = []
const runOnce = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
  c.once('exit', (code) => resolve({ code, out, err }))
})

const dir = await mkdtemp(join(tmpdir(), 'mg-e2-race-'))
const state = join(dir, 'state')
const cfgA = join(dir, 'a.json')
const cfgB = join(dir, 'b.json')
await writeFile(cfgA, JSON.stringify({ providers: { third: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai' } }, models: { alpha: { provider: 'third', api: 'openai', maxContext: 128000 } } }))
await writeFile(cfgB, JSON.stringify({ providers: { third: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai' } }, models: { beta: { provider: 'third', api: 'openai', maxContext: 128000 } } }))

let rounds = 0, bothOk = 0, stateCorrupt = 0, outputCorrupt = 0
try {
  for (let i = 0; i < ROUNDS; i++) {
    const outA = join(dir, 'out-a-' + i + '.json')
    const outB = join(dir, 'out-b-' + i + '.json')
    const [a, b] = await Promise.all([
      runOnce(['--base', basePath, '--models', cfgA, '--out', outA, '--state-dir', state]),
      runOnce(['--base', basePath, '--models', cfgB, '--out', outB, '--state-dir', state]),
    ])
    rounds++
    if (a.code === 0 && b.code === 0) bothOk++
    for (const [p, label] of [[outA, 'a'], [outB, 'b']]) {
      try { const j = JSON.parse(await readFile(p, 'utf8')); if (!Array.isArray(j.models) || !j.models.length) outputCorrupt++ } catch { if ((label === 'a' ? a.code : b.code) === 0) outputCorrupt++ }
    }
    // 状态目录：所有 json 必须可解析
    let files = []
    try { files = (await readdir(state, { recursive: true })).filter((f) => String(f).endsWith('.json')) } catch {}
    for (const f of files) {
      try { JSON.parse(await readFile(join(state, f), 'utf8')) } catch { stateCorrupt++ }
    }
  }
  console.log('rounds=' + rounds + ' bothExit0=' + bothOk + ' outputCorrupt=' + outputCorrupt + ' stateJsonCorrupt=' + stateCorrupt)
  const status = await runOnce(['--status', '--state-dir', state])
  console.log('status exit=' + status.code + ' head=' + String(status.out || '').split(NL)[0])
  const checks = [
    ['两个并发进程均成功（说明至少不是硬失败）', bothOk === rounds, bothOk + '/' + rounds],
    ['输出文件未损坏', outputCorrupt === 0, 'corrupt=' + outputCorrupt],
    ['状态目录 JSON 未损坏', stateCorrupt === 0, 'corrupt=' + stateCorrupt],
    ['--status 在并发后仍可用', status.code === 0, 'exit=' + status.code],
  ]
  let failed = 0
  for (const [n, ok, d] of checks) { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + ' :: ' + d) }
  console.log(NL + (checks.length - failed) + '/' + checks.length + ' catalog-race checks passed（单写者假设证据）')
  process.exitCode = failed ? 1 : 0
} finally {
  await rm(dir, { recursive: true, force: true })
}
