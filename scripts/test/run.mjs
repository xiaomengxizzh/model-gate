// 离线验证入口（M0-1）。
//
// 设计约束（T-ENV-01 / T-ENV-02）：
//  1. 显式清单：SUITES 是字面量白名单，新增文件不会被自动发现或执行（不再 readdirSync 扫描目录）。
//  2. 环境白名单：测试子进程只拿到最小必需变量；宿主 Key/凭据（OPENCODE_API_KEY、CODEX_* 等）一律不透传。
//  3. 每 suite 隔离：独立 mkdtemp 的 HOME 与 TMPDIR，跑完 rm -rf。
//  4. 超时与回收：per-suite 超时（默认 120s，MG_SUITE_TIMEOUT_MS 覆盖）；detached 进程组 + SIGTERM/SIGKILL 兜底。
//  5. 退出语义：失败/超时 => 1；无匹配 => 2；--list => 0。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const SYNTHETIC_MASTER_KEY = 'isolated-test-master'
export const DEFAULT_TIMEOUT_MS = 120_000

// 显式清单：唯一可执行来源。顺序即执行顺序；前 3 个为既有 legacy 套件，其后为 offline/*.test.mjs。
// 新增用例必须手工登记到这里，否则永远不会被执行（runner-selftest 会断言这一点）。
export const SUITES = [
  'scripts/test/virtual-models.mjs',
  'scripts/test/effort-normalize.mjs',
  'scripts/test/upstream-side-4xx.mjs',
  'scripts/test/offline/admin-contract.test.mjs',
  'scripts/test/offline/admin-entry.test.mjs',
  'scripts/test/offline/admin-origin.test.mjs',
  'scripts/test/offline/admin-projection.test.mjs',
  'scripts/test/offline/admin-secrets.test.mjs',
  'scripts/test/offline/boundary.test.mjs',
  'scripts/test/offline/codex-api.test.mjs',
  'scripts/test/offline/codex-catalog-coherence.test.mjs',
  'scripts/test/offline/codex-catalog.test.mjs',
  'scripts/test/offline/codex-config.test.mjs',
  'scripts/test/offline/codex-control-items.test.mjs',
  'scripts/test/offline/codex-fallback-forward.test.mjs',
  'scripts/test/offline/codex-fallback.test.mjs',
  'scripts/test/offline/codex-history.test.mjs',
  'scripts/test/offline/codex-identity.test.mjs',
  'scripts/test/offline/codex-interop.test.mjs',
  'scripts/test/offline/codex-official.test.mjs',
  'scripts/test/offline/codex-opencode-session.test.mjs',
  'scripts/test/offline/codex-quota.test.mjs',
  'scripts/test/offline/codex-routing-catalog.test.mjs',
  'scripts/test/offline/codex-target-authz.test.mjs',
  'scripts/test/offline/config-projection.test.mjs',
  'scripts/test/offline/config-schema.test.mjs',
  'scripts/test/offline/config-transaction.test.mjs',
  'scripts/test/offline/deadline.test.mjs',
  'scripts/test/offline/embeddings.test.mjs',
  'scripts/test/offline/hosted-tools.test.mjs',
  'scripts/test/offline/inference-receipt.test.mjs',
  'scripts/test/offline/key-tristate.test.mjs',
  'scripts/test/offline/lifecycle.test.mjs',
  'scripts/test/offline/logger-secrets.test.mjs',
  'scripts/test/offline/mcp-uhr-contract.test.mjs',
  'scripts/test/offline/media.test.mjs',
  'scripts/test/offline/metrics.test.mjs',
  'scripts/test/offline/model-resolution.test.mjs',
  'scripts/test/offline/native-usage.test.mjs',
  'scripts/test/offline/optional-endpoints.test.mjs',
  'scripts/test/offline/probe.test.mjs',
  'scripts/test/offline/request-encoding.test.mjs',
  'scripts/test/offline/rerank.test.mjs',
  'scripts/test/offline/responses-endpoint.test.mjs',
  'scripts/test/offline/responses-mapping.test.mjs',
  'scripts/test/offline/responses-native.test.mjs',
  'scripts/test/offline/retry-governance.test.mjs',
  'scripts/test/offline/routing-decision.test.mjs',
  'scripts/test/offline/routing-ledger.test.mjs',
  'scripts/test/offline/sse-chunking.test.mjs',
  'scripts/test/offline/ui-contract.test.mjs',
  'scripts/test/offline/ui-next.test.mjs',
  'scripts/test/offline/ui-state.test.mjs',
  'scripts/test/offline/user-env.test.mjs',
  'scripts/test/offline/video.test.mjs',
  'scripts/test/offline/wire-format.test.mjs',
  // M0-1 自检：验证本运行器自身的清单/超时/环境隔离行为。
  'scripts/test/offline/runner-selftest.test.mjs',
]

const NODE_OPTIONS_ALLOWLIST = [
  /^--max-old-space-size=\d+$/,
  /^--max-semi-space-size=\d+$/,
  /^--enable-source-maps$/,
  /^--no-warnings$/,
]

// 只保留已知安全、无副作用（不加载模块/不执行代码）的 NODE_OPTIONS 取值。
export function sanitizeNodeOptions(raw) {
  if (!raw) return ''
  return String(raw)
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => NODE_OPTIONS_ALLOWLIST.some((re) => re.test(tok)))
    .join(' ')
}

// 子进程环境白名单：HOME/TMPDIR 指向每 suite 独立临时目录；MG_* 配置入口显式清空。
// 绝不透传 ...process.env，宿主凭据不会进入测试子进程。
export function buildSuiteEnv({ home, tmp, parentEnv = process.env, extraEnv = {} } = {}) {
  if (!home || !tmp) throw new TypeError('buildSuiteEnv requires home and tmp')
  const env = {
    PATH: parentEnv.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: parentEnv.LANG || 'C.UTF-8',
    HOME: home,
    TMPDIR: tmp,
    // 合成测试主密钥 + 清空可能指向真实配置/凭据的入口
    MG_KEYS_MASTER: SYNTHETIC_MASTER_KEY,
    MG_CONFIG: '',
    MG_CONFIG_DIR: '',
    MG_CLIENT_KEY: '',
    MG_ADMIN_TOKEN: '',
    MG_MAX_BODY: '',
  }
  const nodeOptions = sanitizeNodeOptions(parentEnv.NODE_OPTIONS)
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions
  // 仅透传套件自己声明的 MG_TEST_* 合成隔离变量；MG_KEYS_MASTER/MG_CONFIG 等宿主值不透传。
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value === 'string' && /^MG_TEST_[A-Za-z0-9_]+$/.test(key)) env[key] = value
  }
  return { ...env, ...extraEnv }
}

export function resolveTimeoutMs(parentEnv = process.env) {
  const raw = Number(parentEnv.MG_SUITE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

export function suiteFilePath(file) {
  return isAbsolute(file) ? file : join(ROOT, file)
}

export function suiteArgs(file) {
  const abs = suiteFilePath(file)
  if (!file.endsWith('.test.mjs')) return [abs]
  // Node >= 20 才能稳定指定 reporter；旧版本退回默认输出（解析逻辑同时兼容 tap/spec）。
  const major = Number(process.versions.node.split('.')[0])
  return major >= 20 ? ['--test', '--test-reporter=spec', abs] : ['--test', abs]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TIMEOUT = Symbol('timeout')

// Race，但必须清除定时器：否则未触发的 setTimeout 会拖住事件循环（全量运行时会挂到超时）。
async function raceWithTimeout(promise, ms) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

async function waitFor(fn, ms, step = 25) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(step)
  }
  return fn()
}

// 回收整个进程组：先 SIGTERM，宽限期后 SIGKILL 兜底，并等到 PID 真正消失（被父进程 reaped）。
export async function terminateTree(pid, exited, { graceMs = 2000, killWaitMs = 3000 } = {}) {
  if (!pid) return true
  if (groupAlive(pid)) { try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ } }
  await raceWithTimeout(exited, graceMs)
  if (groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  await raceWithTimeout(exited, 2000)
  return waitFor(() => !pidAlive(pid) && !groupAlive(pid), killWaitMs)
}

// 解析 node:test 汇总行：spec 用 "ℹ pass 12"，tap 用 "# pass 12"。
export function parseCounts(text) {
  const grab = (name) => {
    const re = new RegExp('^[ \\t]*[\u2139#][ \\t]*' + name + '[ \\t]+(\\d+)[ \\t]*$', 'm')
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  const tests = grab('tests')
  const pass = grab('pass')
  const fail = grab('fail')
  const skipped = grab('skipped')
  if (tests === null && pass === null) return null
  return { tests, pass, fail, skipped }
}

let activePid = null

export async function runSuite(file, opts = {}) {
  const parentEnv = opts.parentEnv || process.env
  const timeoutMs = opts.timeoutMs || resolveTimeoutMs(parentEnv)
  const startedAt = Date.now()
  const dir = mkdtempSync(join(opts.tmpRoot || tmpdir(), 'mg-suite-'))
  const home = join(dir, 'home')
  const tmp = join(dir, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  const env = buildSuiteEnv({ home, tmp, parentEnv, extraEnv: opts.extraEnv })

  let child = null
  let output = ''
  try {
    child = spawn(process.execPath, suiteArgs(file), {
      cwd: opts.cwd || ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    activePid = child.pid
    const forward = (chunk) => {
      const text = String(chunk)
      output = (output + text).slice(-128 * 1024)
      if (!opts.quiet) process.stdout.write(text)
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)

    const exited = new Promise((res) => {
      child.once('exit', (code, signal) => res({ code, signal }))
    })
    const spawnError = new Promise((res) => {
      child.once('error', (err) => res({ err }))
    })

    const settled = Promise.race([
      exited.then((v) => ({ kind: 'exit', ...v })),
      spawnError.then((v) => ({ kind: 'spawn-error', ...v })),
    ])
    let outcome = await raceWithTimeout(settled, timeoutMs)
    if (outcome === TIMEOUT) outcome = { kind: 'timeout' }

    const timedOut = outcome.kind === 'timeout'
    const treeReaped = await terminateTree(child.pid, exited)
    const counts = parseCounts(output)
    // 超时用 124 表示（与 GNU timeout 对齐），便于调用方统一按非 0 处理。
    const exitCode = timedOut ? 124 : (outcome.kind === 'exit' ? outcome.code : null)
    const ok = !timedOut && outcome.kind !== 'spawn-error' && exitCode === 0 && treeReaped
    return {
      file,
      pid: child.pid,
      ok,
      timedOut,
      treeReaped,
      exitCode,
      signal: outcome.kind === 'exit' ? outcome.signal : null,
      durationMs: Date.now() - startedAt,
      counts,
      spawnError: outcome.kind === 'spawn-error' ? String(outcome.err?.message || outcome.err) : null,
      home,
      tmp,
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    activePid = null
    rmSync(dir, { recursive: true, force: true })
  }
}

export function displayName(file) {
  return file.replace(/^scripts\/test\//, '')
}

// 汇总语义：套件级 skipped 必须是派生值（当前运行器没有“跳过套件”机制，恒 0，但不得硬编码掩盖未来变化）；
// 未运行的套件（selected - results）单列 notRun，与 node:test 的测试级 skip 分开统计。
export function summarize(results, options = {}) {
  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped === true)
  const selected = Number.isFinite(options.selected) ? options.selected : results.length
  const aggregate = { pass: 0, fail: 0, skipped: 0, reported: 0 }
  for (const r of results) {
    if (!r.counts) continue
    aggregate.pass += r.counts.pass || 0
    aggregate.fail += r.counts.fail || 0
    aggregate.skipped += r.counts.skipped || 0
    aggregate.reported++
  }
  return {
    total: results.length,
    selected,
    notRun: Math.max(0, selected - results.length),
    passed: results.length - failed.length,
    failed: failed.length,
    skipped: skipped.length,
    timedOut: results.filter((r) => r.timedOut).length,
    tests: aggregate,
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
  }
}

export async function main(argv = process.argv.slice(2), parentEnv = process.env) {
  if (argv.includes('--list')) {
    const quiet = argv.includes('--quiet')
    for (const file of SUITES) console.log(file)
    if (!quiet) console.log('\n' + SUITES.length + ' suites (explicit manifest)')
    return 0
  }

  const filter = argv.filter((arg) => !arg.startsWith('-')).join(' ').trim()
  const needle = filter.toLowerCase()
  const selected = needle ? SUITES.filter((file) => file.toLowerCase().includes(needle)) : [...SUITES]
  if (!selected.length) {
    console.error('No matching isolated test: ' + filter)
    return 2
  }

  const timeoutMs = resolveTimeoutMs(parentEnv)
  const results = []
  for (const file of selected) {
    console.log('\n== ' + displayName(file) + ' ==')
    const result = await runSuite(file, { parentEnv, timeoutMs })
    results.push(result)
    if (result.ok) {
      console.log('-- ok ' + result.durationMs + 'ms (pid tree reaped: ' + result.treeReaped + ')')
    } else if (result.timedOut) {
      console.log('-- TIMEOUT after ' + timeoutMs + 'ms (pid tree reaped: ' + result.treeReaped + ')')
    } else {
      console.log('-- FAIL exit=' + result.exitCode + ' signal=' + result.signal + ' (pid tree reaped: ' + result.treeReaped + ')')
    }
  }

  const summary = summarize(results, { selected: selected.length })
  const seconds = (summary.durationMs / 1000).toFixed(1)
  console.log('\n== summary ==')
  console.log('suites: ' + summary.passed + ' passed, ' + summary.failed + ' failed, ' + summary.skipped + ' skipped, ' + summary.timedOut + ' timed out, ' + summary.notRun + ' not run (manifest ' + summary.total + '/selected ' + selected.length + ')')
  console.log('tests:  ' + summary.tests.pass + ' passed, ' + summary.tests.fail + ' failed, ' + summary.tests.skipped + ' skipped (' + summary.tests.reported + '/' + summary.total + ' suites reported node:test counts)')
  console.log('total time: ' + seconds + 's')
  return summary.failed ? 1 : 0
}

export function installSignalHandlers() {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      if (activePid) { try { process.kill(-activePid, 'SIGTERM') } catch { /* already gone */ } }
      process.exit(code)
    })
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && entry === fileURLToPath(import.meta.url)) {
  installSignalHandlers()
  main().then((code) => { process.exitCode = code }).catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
