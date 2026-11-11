// M0-1 自检：验证 scripts/test/run.mjs 的显式清单、环境白名单、超时与进程树回收。
// 全部在进程内或临时目录完成：不启动真实网关、不访问 8787、不读取宿主凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ROOT,
  SUITES,
  SYNTHETIC_MASTER_KEY,
  buildSuiteEnv,
  runSuite,
  sanitizeNodeOptions,
  suiteFilePath,
} from '../run.mjs'

const RUNNER = suiteFilePath('scripts/test/run.mjs')
const OFFLINE_DIR = join(ROOT, 'scripts/test/offline')
// 45 个基线套件的冻结名单（基线 = 采纳点 64a5c96 上 run.mjs 的 45 个套件）。
// 断言的是「包含关系」而不是总数：新增套件只需登记，但任何基线套件都不允许被静默移除。
const BASELINE_SUITES = Object.freeze([
  'scripts/test/virtual-models.mjs',
  'scripts/test/effort-normalize.mjs',
  'scripts/test/upstream-side-4xx.mjs',
  'scripts/test/offline/admin-contract.test.mjs',
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
  'scripts/test/offline/config-projection.test.mjs',
  'scripts/test/offline/config-schema.test.mjs',
  'scripts/test/offline/deadline.test.mjs',
  'scripts/test/offline/embeddings.test.mjs',
  'scripts/test/offline/hosted-tools.test.mjs',
  'scripts/test/offline/lifecycle.test.mjs',
  'scripts/test/offline/logger-secrets.test.mjs',
  'scripts/test/offline/media.test.mjs',
  'scripts/test/offline/metrics.test.mjs',
  'scripts/test/offline/model-resolution.test.mjs',
  'scripts/test/offline/native-usage.test.mjs',
  'scripts/test/offline/probe.test.mjs',
  'scripts/test/offline/request-encoding.test.mjs',
  'scripts/test/offline/rerank.test.mjs',
  'scripts/test/offline/responses-endpoint.test.mjs',
  'scripts/test/offline/responses-mapping.test.mjs',
  'scripts/test/offline/responses-native.test.mjs',
  'scripts/test/offline/retry-governance.test.mjs',
  'scripts/test/offline/ui-contract.test.mjs',
  'scripts/test/offline/ui-next.test.mjs',
  'scripts/test/offline/user-env.test.mjs',
  'scripts/test/offline/video.test.mjs',
  'scripts/test/offline/wire-format.test.mjs',
])

function pidGone(pid) {
  try { process.kill(pid, 0); return false } catch (err) { return err.code === 'ESRCH' }
}

async function waitGone(pid, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pidGone(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return pidGone(pid)
}

test('清单：非空、无重复、保留全部 45 个基线套件，且每个条目文件真实存在', () => {
  assert.ok(SUITES.length > 0, 'manifest must not be empty')
  assert.equal(new Set(SUITES).size, SUITES.length, 'manifest must not contain duplicates')
  assert.equal(BASELINE_SUITES.length, 45, 'frozen baseline list must stay at 45 entries')
  for (const file of BASELINE_SUITES) assert.ok(SUITES.includes(file), 'baseline suite removed from manifest: ' + file)
  assert.ok(SUITES.includes('scripts/test/offline/runner-selftest.test.mjs'), 'runner selftest must stay listed')
  for (const file of SUITES) assert.ok(existsSync(suiteFilePath(file)), 'missing manifest entry: ' + file)
  assert.deepEqual(SUITES.slice(0, 3), [
    'scripts/test/virtual-models.mjs',
    'scripts/test/effort-normalize.mjs',
    'scripts/test/upstream-side-4xx.mjs',
  ])
})

test('清单是字面量：run.mjs 不再用 readdirSync 扫描 offline 目录', () => {
  const src = readFileSync(RUNNER, 'utf8')
  assert.equal(/readdirSync\s*\(/.test(src), false, 'runner must not scan directories')
  assert.match(src, /export const SUITES = /)
})

test('清单外的 *.test.mjs 不会被自动执行（哨兵文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-selftest-sentinel-'))
  const marker = join(dir, 'ran')
  const name = '__mg-selftest-sentinel-' + process.pid + '.test.mjs'
  const sentinel = join(OFFLINE_DIR, name)
  writeFileSync(sentinel, [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(' + JSON.stringify(marker) + ", 'ran')",
    'process.exit(1)',
    '',
  ].join('\n'))
  try {
    const filtered = spawnSync(process.execPath, [RUNNER, name.replace(/\.test\.mjs$/, '')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
    })
    assert.equal(filtered.status, 2, 'unlisted suite must not match: stdout=' + filtered.stdout + ' stderr=' + filtered.stderr)
    assert.equal(existsSync(marker), false, 'sentinel must never be executed')

    const listed = spawnSync(process.execPath, [RUNNER, '--list'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 })
    assert.equal(listed.status, 0, '--list must exit 0: ' + listed.stderr)
    const lines = listed.stdout.split('\n').filter((line) => line.startsWith('scripts/'))
    assert.equal(lines.length, SUITES.length)
    assert.equal(lines.some((line) => line.includes('__mg-selftest-sentinel-')), false)
  } finally {
    rmSync(sentinel, { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(existsSync(sentinel), false, 'sentinel must be cleaned up')
})

test('超时：假套件超时后返回非 0，且 leader 与孙进程都被回收', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-selftest-timeout-'))
  const pidsFile = join(dir, 'pids.json')
  const fake = join(dir, 'hang.test.mjs')
  writeFileSync(fake, [
    "import test from 'node:test'",
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "test('hang', async () => {",
    "  const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })",
    '  writeFileSync(' + JSON.stringify(pidsFile) + ', JSON.stringify({ grand: grand.pid }))',
    '  await new Promise(() => {})',
    '})',
    '',
  ].join('\n'))
  try {
    const result = await runSuite(fake, { timeoutMs: 2000, quiet: true })
    assert.equal(result.timedOut, true, 'suite must hit the per-suite timeout')
    assert.equal(result.exitCode, 124, 'timeout must surface as non-zero exit 124')
    assert.notEqual(result.exitCode, 0)
    assert.equal(result.ok, false)
    assert.equal(result.treeReaped, true, 'runner must confirm the pid tree is gone')
    assert.equal(await waitGone(result.pid), true, 'suite leader pid must be reaped')
    const recorded = JSON.parse(readFileSync(pidsFile, 'utf8'))
    assert.equal(await waitGone(recorded.grand), true, 'grandchild pid must be killed with the process group')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('环境白名单：宿主哨兵变量与真实凭据不会透传进子进程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-selftest-env-'))
  const outFile = join(dir, 'env.json')
  const fake = join(dir, 'dump.mjs')
  writeFileSync(fake, [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(process.env.MG_TEST_SELFTEST_ENV_OUT, JSON.stringify(process.env))',
    '',
  ].join('\n'))
  const parentEnv = {
    ...process.env,
    SENTINEL_SECRET: '1',
    OPENCODE_API_KEY: 'host-opencode-key',
    CODEX_HOME: '/host/.codex',
    MG_KEYS_MASTER: 'host-real-master-key',
    MG_CONFIG: '/host/real/gateway.json',
    MG_CONFIG_DIR: '/host/real/config',
    MG_CLIENT_KEY: 'host-client-key',
    MG_ADMIN_TOKEN: 'host-admin-token',
    MG_TEST_SELFTEST_ENV_OUT: outFile,
    NODE_OPTIONS: '--require=/host/evil.js --max-old-space-size=256',
  }
  try {
    const result = await runSuite(fake, { parentEnv, quiet: true, timeoutMs: 20000 })
    assert.equal(result.ok, true, 'dump suite should exit 0, got ' + result.exitCode)
    const env = JSON.parse(readFileSync(outFile, 'utf8'))
    for (const leaked of ['SENTINEL_SECRET', 'OPENCODE_API_KEY', 'CODEX_HOME', 'CODEX_API_KEY', 'MG_E3_CATALOG_BASE']) {
      assert.equal(env[leaked], undefined, 'host variable leaked into suite: ' + leaked)
    }
    assert.equal(env.MG_KEYS_MASTER, SYNTHETIC_MASTER_KEY, 'master key must be synthetic')
    assert.equal(env.MG_CONFIG, '', 'MG_CONFIG must be cleared')
    assert.equal(env.MG_CONFIG_DIR, '', 'MG_CONFIG_DIR must be cleared')
    assert.equal(env.MG_CLIENT_KEY, '', 'MG_CLIENT_KEY must be cleared')
    assert.equal(env.MG_ADMIN_TOKEN, '', 'MG_ADMIN_TOKEN must be cleared')
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=256', 'only allowlisted NODE_OPTIONS survive')
    assert.ok(env.PATH, 'PATH must be present')
    assert.ok(env.HOME && env.HOME !== process.env.HOME, 'HOME must be a per-suite temp dir')
    assert.ok(env.TMPDIR && env.TMPDIR !== process.env.TMPDIR, 'TMPDIR must be a per-suite temp dir')
    assert.ok(env.HOME.startsWith(tmpdir()) && env.TMPDIR.startsWith(tmpdir()), 'suite dirs live under the OS temp root')
    // 跑完即 rm -rf：隔离目录不得残留。
    assert.equal(existsSync(env.HOME), false, 'per-suite HOME must be cleaned up')
    assert.equal(existsSync(env.TMPDIR), false, 'per-suite TMPDIR must be cleaned up')
    assert.equal(env.MG_TEST_SELFTEST_ENV_OUT, outFile, 'MG_TEST_* isolation vars may pass through')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('白名单构造：危险 NODE_OPTIONS 被剔除，配置入口被清空', () => {
  const env = buildSuiteEnv({
    home: '/h',
    tmp: '/t',
    parentEnv: {
      PATH: '/bin',
      LANG: 'C.UTF-8',
      NODE_OPTIONS: '--import evil --max-old-space-size=512 --enable-source-maps',
      CODEX_HOME: '/x',
      MG_KEYS_MASTER: 'real',
      MG_CONFIG_DIR: '/real',
    },
  })
  assert.equal(env.HOME, '/h')
  assert.equal(env.TMPDIR, '/t')
  assert.equal(env.MG_KEYS_MASTER, SYNTHETIC_MASTER_KEY)
  assert.equal(env.MG_CONFIG, '')
  assert.equal(env.MG_CONFIG_DIR, '')
  assert.equal(env.CODEX_HOME, undefined)
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=512 --enable-source-maps')
  assert.equal(sanitizeNodeOptions('--require /x.js --trace-warnings'), '')
  assert.equal(sanitizeNodeOptions(undefined), '')
})
