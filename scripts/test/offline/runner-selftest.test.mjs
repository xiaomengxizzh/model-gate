// M0-1 自检：验证 scripts/test/run.mjs 的显式清单、环境白名单、超时与进程树回收。
// 全部在进程内或临时目录完成：不启动真实网关、不访问 8787、不读取宿主凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { EXECUTABLE_ALLOWLIST } from '../live.mjs'

const RUNNER = suiteFilePath('scripts/test/run.mjs')
const LIVE_RUNNER = join(ROOT, 'scripts/test/live.mjs')
const SCRIPT_DIR = join(ROOT, 'scripts/test')
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

test('汇总语义：套件级 skipped 派生、未运行套件单列 notRun、测试级 skip 独立统计', async () => {
  const { summarize } = await import('../run.mjs')
  const summary = summarize([
    { ok: true, counts: { tests: 3, pass: 2, fail: 0, skipped: 1 }, durationMs: 10 },
    { ok: false, counts: null, durationMs: 20, timedOut: true },
    { ok: true, skipped: true, counts: null, durationMs: 5 },
  ], { selected: 4 })
  assert.equal(summary.total, 3)
  assert.equal(summary.selected, 4)
  assert.equal(summary.passed, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.skipped, 1, '套件级 skipped 必须来自结果派生，不得硬编码')
  assert.equal(summary.notRun, 1, '未运行套件单独计数')
  assert.equal(summary.tests.skipped, 1, 'node:test 测试级 skip 单独统计')
})

// ============================================================================
// M0-1b：旧 runner 的授权边界（fail-closed 静态扫描 + 显式排除 + 前置守卫）
// ============================================================================

test('live runner 正向白名单：真实仓库 47 顶层 / 27 允许 / 20 未允许 / 0 缺失', () => {
  const allMjs = readdirSync(SCRIPT_DIR).filter((file) => file.endsWith('.mjs'))
  assert.equal(EXECUTABLE_ALLOWLIST.length, 27, '白名单必须逐项列出 27 个自包含旧套件')
  assert.equal(allMjs.length, 47)
  for (const file of EXECUTABLE_ALLOWLIST) assert.ok(existsSync(join(SCRIPT_DIR, file)), 'missing allowlist entry: ' + file)
  assert.equal(EXECUTABLE_ALLOWLIST.includes('codex-v1-live.mjs'), false, '真实凭据脚本绝不进入白名单')

  const listed = spawnSync(process.execPath, [LIVE_RUNNER, '--list'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 })
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /== allowlisted \(27\) ==/)
  assert.match(listed.stdout, /== present-but-not-allowed \(20\) ==/)
  assert.match(listed.stdout, /== missing-from-disk \(0\) ==/)
  assert.ok(listed.stdout.includes('codex-v1-live.mjs\tnot_allowlisted'), '未允许文件必须给出 not_allowlisted 原因')

  const scan = spawnSync(process.execPath, [LIVE_RUNNER, '--scan-only'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 })
  assert.equal(scan.status, 0, scan.stdout + scan.stderr)
  assert.match(scan.stdout, /SAFETY_SCAN_OK allowlisted=27 present_not_allowed=20 missing=0 allowlisted_danger=0/)

  // 单 opt-in 不足以执行清单外真实文件：位置筛选直接无匹配 exit 2，且零套件启动
  const blocked = spawnSync(process.execPath, [LIVE_RUNNER, 'codex-v1-live.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, MG_ALLOW_LIVE_TESTS: '1' },
  })
  assert.equal(blocked.status, 2, '清单外文件即使被点名也不得执行')
  assert.ok(blocked.stderr.includes('无匹配'), '必须说明清单外文件不会执行')

  const originSrc = readFileSync(join(OFFLINE_DIR, 'admin-origin.test.mjs'), 'utf8')
  assert.equal(originSrc.includes('0.0.0.0'), false, 'admin-origin must not bind 0.0.0.0')
  assert.equal(originSrc.includes('networkInterfaces'), false, 'admin-origin must not touch LAN interfaces')
  const v1Src = readFileSync(join(SCRIPT_DIR, 'codex-v1-live.mjs'), 'utf8')
  assert.ok(v1Src.includes('MG_ALLOW_LIVE_TESTS'), 'codex-v1-live must gate on explicit authorization')
  assert.ok(v1Src.includes('REFUSED'), 'codex-v1-live must fail closed when preconditions are missing')
})

const LIVE_COPY_FAKES = {
  'bypass-concat.mjs': [
    '// 反例 1：字符串拼接（denylist 无法命中字面量）',
    "import { writeFileSync } from 'node:fs'",
    "const home = '.cod' + 'ex'",
    "const auth = ['auth', 'json'].join('.')",
    "const upstream = 'chat' + 'gpt' + '.' + 'com'",
    "writeFileSync(process.env.FAKE_MARKER, 'ran:' + home + ':' + auth + ':' + upstream)",
    'process.exit(7)',
  ].join('\n'),
  'bypass-case.mjs': [
    '// 反例 2：大小写变体（正则大小写敏感时会漏）',
    "const upstream = 'https://ChatGPT.com/v1'",
    'if (!upstream) process.exit(0)',
  ].join('\n'),
  'bypass-b64.mjs': [
    '// 反例 3：base64 解码后才出现危险串',
    "const decoded = Buffer.from('YXV0aC5qc29u', 'base64').toString('utf8')",
    'if (!decoded) process.exit(0)',
  ].join('\n'),
}

function makeLiveCopy () {
  const base = mkdtempSync(join(tmpdir(), 'mg-live-copy-'))
  const testDir = join(base, 'scripts', 'test')
  mkdirSync(testDir, { recursive: true })
  copyFileSync(LIVE_RUNNER, join(testDir, 'live.mjs'))
  for (const file of EXECUTABLE_ALLOWLIST) writeFileSync(join(testDir, file), '// allowlisted placeholder\n')
  return { base, testDir, runner: join(testDir, 'live.mjs') }
}

test('live runner 正向白名单：拼接/大小写/base64 反例都不在清单，命名也不执行', () => {
  const copy = makeLiveCopy()
  const marker = join(copy.base, 'fake-ran')
  try {
    for (const [name, source] of Object.entries(LIVE_COPY_FAKES)) writeFileSync(join(copy.testDir, name), source)
    const scan = spawnSync(process.execPath, [copy.runner, '--scan-only'], { cwd: copy.base, encoding: 'utf8', timeout: 30000 })
    assert.equal(scan.status, 0, scan.stdout + scan.stderr)
    for (const name of Object.keys(LIVE_COPY_FAKES)) {
      const line = scan.stdout.split('\n').find((entry) => entry.startsWith('NOT_ALLOWED ' + name + ' '))
      assert.ok(line, 'scan 必须列出清单外文件 ' + name)
      assert.ok(line.includes('reason=not_allowlisted'), '清单外文件原因必须是 not_allowlisted: ' + line)
      // 位置筛选点名清单外文件：exit 2，零套件启动，标记文件不得出现
      const direct = spawnSync(process.execPath, [copy.runner, name], {
        cwd: copy.base, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, MG_ALLOW_LIVE_TESTS: '1', FAKE_MARKER: marker },
      })
      assert.equal(direct.status, 2, '清单外文件不得执行: ' + name + ' ' + direct.stdout + direct.stderr)
    }
    assert.equal(existsSync(marker), false, '清单外文件绝不能被执行')

    // 只有 MG_ALLOW_LIVE_TESTS=1：不足以 --only 清单外文件
    const oneGate = spawnSync(process.execPath, [copy.runner, '--only', 'bypass-concat.mjs'], {
      cwd: copy.base, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, MG_ALLOW_LIVE_TESTS: '1', FAKE_MARKER: marker },
    })
    assert.equal(oneGate.status, 2, oneGate.stdout + oneGate.stderr)
    assert.ok(oneGate.stderr.includes('MG_LIVE_ALLOW_UNLISTED'), '必须说明缺少第二个 opt-in')
    assert.equal(existsSync(marker), false)

    // 只有 MG_LIVE_ALLOW_UNLISTED=1：同样不够
    const otherGate = spawnSync(process.execPath, [copy.runner, '--only', 'bypass-concat.mjs'], {
      cwd: copy.base, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, MG_LIVE_ALLOW_UNLISTED: '1', FAKE_MARKER: marker },
    })
    assert.equal(otherGate.status, 2)
    assert.equal(existsSync(marker), false)

    // 两个 opt-in 同时存在：允许执行，但必须醒目警告 + 摘要标注（fake 自身 exit 7 → runner 1）
    const override = spawnSync(process.execPath, [copy.runner, '--only', 'bypass-concat.mjs'], {
      cwd: copy.base, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, MG_ALLOW_LIVE_TESTS: '1', MG_LIVE_ALLOW_UNLISTED: '1', FAKE_MARKER: marker },
    })
    assert.equal(override.status, 1, 'fake exit 7 必须体现为 runner 失败: ' + override.stdout)
    assert.ok(existsSync(marker), '双 opt-in 时 --only 才允许执行')
    assert.match(override.stderr, /UNLISTED_OVERRIDE/)
    assert.match(override.stdout, /UNLISTED_OVERRIDE/)
  } finally {
    rmSync(copy.base, { recursive: true, force: true })
  }
})

test('live runner 白名单不变量：缺文件/清单内危险特征 → --scan-only fail-closed', () => {
  const copy = makeLiveCopy()
  try {
    rmSync(join(copy.testDir, 'acl.mjs'))
    const listed = spawnSync(process.execPath, [copy.runner, '--list'], { cwd: copy.base, encoding: 'utf8', timeout: 30000 })
    assert.equal(listed.status, 0)
    assert.match(listed.stdout, /== missing-from-disk \(1\) ==/)
    assert.ok(listed.stdout.includes('acl.mjs\tmissing_from_disk'))
    const missingScan = spawnSync(process.execPath, [copy.runner, '--scan-only'], { cwd: copy.base, encoding: 'utf8', timeout: 30000 })
    assert.equal(missingScan.status, 1)
    assert.ok((missingScan.stdout + missingScan.stderr).includes('MISSING acl.mjs'))

    writeFileSync(join(copy.testDir, 'acl.mjs'), "const leak = process.env.HOME + '/.codex/auth.json'")
    const dangerScan = spawnSync(process.execPath, [copy.runner, '--scan-only'], { cwd: copy.base, encoding: 'utf8', timeout: 30000 })
    assert.equal(dangerScan.status, 1)
    assert.ok((dangerScan.stdout + dangerScan.stderr).includes('DANGER acl.mjs'), '清单内文件命中 denylist 必须拒绝启动')
  } finally {
    rmSync(copy.base, { recursive: true, force: true })
  }
})

test('codex-v1-live fail-closed：缺显式授权/真实凭据时立即非 0 退出，不复制任何凭据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-selftest-v1-'))
  const v1 = join(SCRIPT_DIR, 'codex-v1-live.mjs')
  const baseEnv = { PATH: process.env.PATH || '', HOME: dir }
  try {
    const noGate = spawnSync(process.execPath, [v1], { cwd: ROOT, encoding: 'utf8', timeout: 20000, env: baseEnv })
    assert.equal(noGate.status, 2, 'missing MG_ALLOW_LIVE_TESTS must exit 2: ' + noGate.stderr)
    assert.ok(noGate.stderr.includes('REFUSED'), 'must print REFUSED reason')

    const gateOnly = spawnSync(process.execPath, [v1], {
      cwd: ROOT, encoding: 'utf8', timeout: 20000, env: { ...baseEnv, MG_ALLOW_LIVE_TESTS: '1' },
    })
    assert.equal(gateOnly.status, 2, 'missing real auth.json must exit 2: ' + gateOnly.stderr)
    assert.ok(gateOnly.stderr.includes('auth.json'), 'must explain the missing auth file')
    assert.equal(readdirSync(dir).length, 0, 'guard must not copy credentials or create files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
