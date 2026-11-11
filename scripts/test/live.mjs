// 旧集成套件运行器（MG-004 后：每个文件自建 OS 临时目录 + 动态回环端口 + 本地 mock）。
// 仍需显式 MG_ALLOW_LIVE_TESTS=1（它们是重量级集成测试，不属于 npm test 默认套件）。
// 每个文件独立子进程运行：单文件崩溃/残留不会污染下一个，退出码即该文件的断言结果。
//
// M0-1b 安全不变量（fail-closed）：启动前枚举 scripts/test 下所有顶层 .mjs 并静态读取源码。
// 若某个文件命中"真实凭据 / 真实上游"危险特征、却既不在 EXCLUDED、也不在显式 SAFETY_ALLOWLIST，
// 运行器直接拒绝启动并列出文件名 —— 新增同类脚本不可能再被默认选中，也不再依赖人工清单是否记得更新。
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')

// 说明：以下文件不是回归套件，跑 live.mjs 时必须排除——
//  - ui-fixture.mjs 是常驻夹具服务（不会自行退出）
//  - codex-*.mjs 是需要显式 CODEX_HOME/真实上游的手动取证脚本（由 E9 矩阵单独记录）
//    其中 codex-v1-live.mjs 会复制真实 ~/.codex/auth.json、访问 chatgpt.com/opencode.ai 并真跑 codex exec
//  - ui-browser-check.mjs 需要显式 --port/--token 与已启动的 CDP Chrome，按证据 README 的命令单独运行
const EXCLUDED = new Set(['run.mjs', 'live.mjs', 'utils.mjs', 'isolate.mjs', 'ui-fixture.mjs', 'ui-browser-check.mjs',
  'codex-e2e.mjs', 'codex-live.mjs', 'codex-live-real.mjs', 'codex-v1-live.mjs', 'codex-v2-live.mjs', 'codex-config-e2e.mjs', 'codex-client-config.mjs', 'codex-config-driven.mjs', 'codex-desktop-binary.mjs', 'history-migration-drill.mjs', 'codex-catalog-rollback.mjs', 'codex-remote-catalog.mjs', 'codex-catalog-race.mjs', 'quota-emergency-drill.mjs'])

// 显式允许名单：默认空。只有经过评审、确认"不会在默认运行中泄漏真实凭据/访问真实上游"的文件才可加入；
// 加入即视为对危险特征扫描的显式豁免，必须在代码审查里写理由。
const SAFETY_ALLOWLIST = new Set([])

// 危险特征：命中任一即要求该文件被显式排除或显式豁免。
const DANGER_FEATURES = [
  { id: 'real_codex_auth', re: /auth\.json/ },
  { id: 'real_codex_home', re: /\.codex\b/ },
  { id: 'real_upstream_chatgpt', re: /chatgpt\.com/ },
  { id: 'real_upstream_opencode', re: /opencode\.ai/ },
  { id: 'real_codex_exec', re: /['"]exec['"]/ },
  { id: 'hardcoded_tmp_mg_e0', re: /\/tmp\/mg-e0/ },
]

function scanDangerous(files) {
  const violations = []
  for (const file of files) {
    if (EXCLUDED.has(file) || SAFETY_ALLOWLIST.has(file)) continue
    const src = readFileSync(path.join(__dirname, file), 'utf8')
    const hits = DANGER_FEATURES.filter((feature) => feature.re.test(src)).map((feature) => feature.id)
    if (hits.length) violations.push({ file, hits })
  }
  return violations
}

const allFiles = readdirSync(__dirname).filter((file) => file.endsWith('.mjs')).sort()
const executableFiles = allFiles.filter((file) => !EXCLUDED.has(file))
const violations = scanDangerous(allFiles)

if (violations.length) {
  console.error('SAFETY_SCAN_FAILED 拒绝启动：以下文件命中危险特征，却未被显式排除（fail-closed，不静默跳过）：')
  for (const violation of violations) {
    console.error('  DANGER ' + violation.file + ' [' + violation.hits.join(', ') + ']')
  }
  console.error('处理：把该文件加入 EXCLUDED；确需默认运行则经评审加入 SAFETY_ALLOWLIST（默认空）。')
  process.exit(1)
}

// --scan-only：只做纯静态安全扫描，不启动任何套件（供 runner-selftest 与人工审计使用）。
if (process.argv.includes('--scan-only')) {
  console.log('SAFETY_SCAN_OK total=' + allFiles.length + ' excluded=' + (allFiles.length - executableFiles.length) +
    ' executable=' + executableFiles.length + ' violations=0')
  process.exit(0)
}

if (process.env.MG_ALLOW_LIVE_TESTS !== '1') {
  console.error('Legacy suites require MG_ALLOW_LIVE_TESTS=1（不再需要 MG_GW / MG_CONFIG_DIR；套件自建隔离实例，不触达真实上游）')
  process.exit(1)
}

const filter = (process.argv[2] || '').toLowerCase()
const list = filter ? executableFiles.filter((file) => file.toLowerCase().includes(filter)) : executableFiles
if (!list.length) { console.log('无匹配测试: ' + filter + '（可选: ' + executableFiles.join(', ') + '）'); process.exit(2) }

console.log('旧集成套件（隔离实例）  筛选: ' + (filter || '全部') + '  文件数: ' + list.length)

const failed = []
for (const file of list) {
  console.log('\n== ' + file + ' ==')
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('scripts/test', file)], {
      cwd: root, stdio: 'inherit', env: {
        ...process.env, MG_ALLOW_LIVE_TESTS: '1', MG_KEYS_MASTER: 'isolated-test-master',
        MG_MAX_BODY: '', MG_CONFIG: '', MG_CONFIG_DIR: '', MG_CLIENT_KEY: '', MG_ADMIN_TOKEN: '',
      },
    })
    child.once('error', reject)
    child.once('exit', (c) => resolve(c))
  })
  if (code !== 0) failed.push(file)
}
console.log('\n=== 结果: ' + (list.length - failed.length) + '/' + list.length + ' 文件通过' +
  (failed.length ? '，失败 [' + failed.join(', ') + ']' : '') + ' ===')
process.exitCode = failed.length ? 1 : 0
