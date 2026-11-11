// 旧集成套件运行器（MG-004 后：每个文件自建 OS 临时目录 + 动态回环端口 + 本地 mock）。
// 仍需显式 MG_ALLOW_LIVE_TESTS=1（它们是重量级集成测试，不属于 npm test 默认套件）。
// 每个文件独立子进程运行：单文件崩溃/残留不会污染下一个，退出码即该文件的断言结果。
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.MG_ALLOW_LIVE_TESTS !== '1') {
  throw new Error('Legacy suites require MG_ALLOW_LIVE_TESTS=1（不再需要 MG_GW / MG_CONFIG_DIR；套件自建隔离实例，不触达真实上游）')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const filter = (process.argv[2] || '').toLowerCase()
// 说明：以下文件不是回归套件，跑 live.mjs 时必须排除——
//  - ui-fixture.mjs 是常驻夹具服务（不会自行退出）
//  - codex-*.mjs 是需要显式 CODEX_HOME/真实上游的手动取证脚本（由 E9 矩阵单独记录）
//  - ui-browser-check.mjs 需要显式 --port/--token 与已启动的 CDP Chrome，按证据 README 的命令单独运行
const EXCLUDED = new Set(['run.mjs', 'live.mjs', 'utils.mjs', 'isolate.mjs', 'ui-fixture.mjs', 'ui-browser-check.mjs',
  'codex-e2e.mjs', 'codex-live.mjs', 'codex-live-real.mjs', 'codex-v2-live.mjs', 'codex-config-e2e.mjs'])
const files = readdirSync(__dirname).filter((f) => f.endsWith('.mjs') && !EXCLUDED.has(f)).sort()
const list = filter ? files.filter((f) => f.toLowerCase().includes(filter)) : files
if (!list.length) { console.log('无匹配测试: ' + filter + '（可选: ' + files.join(', ') + '）'); process.exit(2) }

console.log('旧集成套件（隔离实例）  筛选: ' + (filter || '全部') + '  文件数: ' + list.length)

const failed = []
for (const f of list) {
  console.log('\n== ' + f + ' ==')
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('scripts/test', f)], {
      cwd: root, stdio: 'inherit', env: {
        ...process.env, MG_ALLOW_LIVE_TESTS: '1', MG_KEYS_MASTER: 'isolated-test-master',
        MG_MAX_BODY: '', MG_CONFIG: '', MG_CONFIG_DIR: '', MG_CLIENT_KEY: '', MG_ADMIN_TOKEN: '',
      },
    })
    child.once('error', reject)
    child.once('exit', (c) => resolve(c))
  })
  if (code !== 0) failed.push(f)
}
console.log('\n=== 结果: ' + (list.length - failed.length) + '/' + list.length + ' 文件通过' +
  (failed.length ? '，失败 [' + failed.join(', ') + ']' : '') + ' ===')
process.exitCode = failed.length ? 1 : 0
