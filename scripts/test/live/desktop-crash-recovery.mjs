// 真实进程崩溃下的配置写入/回滚/冲突演练（R010）。只在可丢弃目录上运行，不调模型。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'

const MOD = new URL('../../../src/codex/desktop-integration.js', import.meta.url).href
function arg (name, fallback) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const CONFIG = arg('--config', '')
const CATALOG = arg('--catalog', '')
const HEALTH_PORT = Number(arg('--health-port', '18884'))
if (!CONFIG || !CATALOG) { console.error('用法: node scripts/test/live/desktop-crash-recovery.mjs --config <config.toml> --catalog <catalog.json> [--health-port 18884]'); process.exit(2) }
const OPTS = { configPath: CONFIG, catalogPath: CATALOG, baseUrl: 'http://127.0.0.1:' + HEALTH_PORT + '/v1', model: 'gpt-6-luna', models: ['gpt-6-luna', 'mg-opencodego-deepseek-v4-1-flash'] }
const PFX = OPTS.configPath
const sha = (s) => createHash('sha256').update(s).digest('hex')
const baseline = readFileSync(CONFIG, 'utf8')
const baselineSha = sha(baseline)

function reset () {
  writeFileSync(PFX, baseline)
  for (const p of [PFX + '.mg-lock', PFX + '.mg-journal.json', PFX + '.bak']) { try { rmSync(p, { force: true }) } catch {} }
  try { rmSync(CONFIG.replace(/config\.toml$/, '.modelgate-desktop-state.json'), { force: true }) } catch {}
}

async function one (delayMs) {
  reset()
  const m = await import(MOD)
  const p = m.preview(OPTS)
  if (!p.ok) return { delayMs, error: 'preview_blocked:' + JSON.stringify(p.blocked).slice(0, 120) }
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(MOD)})
    const opts = ${JSON.stringify(OPTS)}
    try { const r = await m.activate({ ...opts, consentToken: ${JSON.stringify(p.consentToken)}, expectedSha: ${JSON.stringify(p.expectedSha)} }); console.log(JSON.stringify({ ok: r.ok, sha: r.sha })) }
    catch (e) { console.log(JSON.stringify({ error: e && (e.code || e.message) })) }
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const exited = new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', r) })
  await new Promise((r) => setTimeout(r, delayMs))
  const alive = child.exitCode === null && child.signalCode === null
  if (alive) child.kill('SIGKILL')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  // 崩溃后不变量：文件必须完整（等于 baseline 或等于激活后内容），不得截断/半写
  const after = readFileSync(PFX, 'utf8')
  const parsedOk = (() => { try { return !after.includes('\u0000') && after.trim().length > 0 && /\[|model/.test(after) } catch { return false } })()
  let recovered = 'n/a'; let finalSha = sha(after)
  try {
    const d = m.detect(OPTS)
    recovered = d.state && d.state.mode ? d.state.mode : 'unknown'
    const de = await m.deactivate({ ...OPTS, expectedSha: d.expectedSha })
    finalSha = sha(readFileSync(PFX, 'utf8'))
    recovered = 'deactivate:' + (de.ok ? 'ok' : 'fail')
  } catch (e) { recovered = 'deactivate_error:' + (e && (e.code || e.message)) }
  return {
    delayMs,
    killed: alive,
    childOut: out.trim().slice(0, 120),
    afterComplete: parsedOk,
    afterEqualsBaselineOrAggregated: finalSha === baselineSha || after.length > baseline.length,
    rollbackByteIdentical: finalSha === baselineSha,
    recovered,
  }
}

// 最小健康端点：activate 写后会探活，失败会触发自动回滚（见 R010 记录）
const health = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
await new Promise((r) => health.listen(HEALTH_PORT, '127.0.0.1', r))

const results = []
for (const d of [0, 2, 5, 8, 12, 20, 35, 60, 120, 250]) results.push(await one(d))
// 对照：不中断的完整 activate → deactivate
const m = await import(MOD)
reset()
const p = m.preview(OPTS)
const act = await m.activate({ ...OPTS, consentToken: p.consentToken, expectedSha: p.expectedSha })
const afterActivate = sha(readFileSync(PFX, 'utf8'))
const de = await m.deactivate(OPTS)
const control = { activated: act.ok, changedBytes: afterActivate !== baselineSha, deactivated: de.ok, restored: sha(readFileSync(PFX, 'utf8')) === baselineSha }
health.close()
console.log(JSON.stringify({ results, control }, null, 2))
