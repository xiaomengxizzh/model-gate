// 旧集成套件运行器（M0-1c：正向白名单）。
//
// 安全模型（重要）：
//   1. EXECUTABLE_ALLOWLIST 是唯一可执行来源。不在清单里的文件**永远不会**被选中执行，
//      不是“先扫描再决定”，也没有任何字符串猜测能改变这一点。
//   2. 两道显式 opt-in 是 AND 关系：MG_ALLOW_LIVE_TESTS=1 且文件在清单内。
//   3. --only <file> 可临时运行清单外单个文件，但必须同时满足 MG_ALLOW_LIVE_TESTS=1 与
//      MG_LIVE_ALLOW_UNLISTED=1；启动时打印醒目警告，摘要标注 UNLISTED_OVERRIDE。
//   4. 危险特征 denylist 仅作第二道闸：对清单内文件静态扫描，命中即拒绝启动。
//      它**不是安全边界**（字符串拼接/大小写/编码都能绕过），白名单才是。
//   5. --list 输出三栏：allowlisted / present-but-not-allowed / missing-from-disk，并给出原因。
//   6. --scan-only 只做静态检查：清单内文件必须存在且无危险特征，清单外文件逐条列出
//      （reason=not_allowlisted，可选 danger_marker:...），不会启动任何套件。
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')

// 正向白名单：逐项列出「自包含、只连回环、不读真实凭据」的旧套件。
// 新增文件必须先通过评审再手工加入；未加入 ⇒ 永远不会被默认运行。
export const EXECUTABLE_ALLOWLIST = [
  'acl.mjs',
  'affinity.mjs',
  'body-limit.mjs',
  'circuit.mjs',
  'concurrency.mjs',
  'effort-normalize.mjs',
  'empty-model.mjs',
  'failback.mjs',
  'format-conversion.mjs',
  'key-encrypt.mjs',
  'logrotate.mjs',
  'model-reject-failover.mjs',
  'modelstats.mjs',
  'payment-402-failover.mjs',
  'qps.mjs',
  'rate429.mjs',
  'sse-resume.mjs',
  'stream-drop-halfopen.mjs',
  'stream-failover.mjs',
  'stream-started-4xx.mjs',
  'tools.mjs',
  'trend.mjs',
  'upstream-side-4xx.mjs',
  'user-env-fallback.mjs',
  'virtual-models.mjs',
  'z-defaults-merge.mjs',
  'z2-noevent.mjs',
]

// 第二道闸（非安全边界）：只拦字面量写法，用于发现“清单内文件被改出危险行为”。
export const DANGER_FEATURES = [
  { id: 'real_codex_auth', re: /auth\.json/ },
  { id: 'real_codex_home', re: /\.codex\b/ },
  { id: 'real_upstream_chatgpt', re: /chatgpt\.com/ },
  { id: 'real_upstream_opencode', re: /opencode\.ai/ },
  { id: 'real_codex_exec', re: /['"]exec['"]/ },
  { id: 'hardcoded_tmp_mg_e0', re: /\/tmp\/mg-e0/ },
]

export function dangerMarkers (dir, file) {
  try {
    const source = readFileSync(path.join(dir, file), 'utf8')
    return DANGER_FEATURES.filter((feature) => feature.re.test(source)).map((feature) => feature.id)
  } catch { return [] }
}

// 目录分类：allowlisted=清单且存在；missing=清单但缺文件；notAllowed=磁盘上非清单文件（含原因）。
export function classify (dir = __dirname) {
  const present = readdirSync(dir).filter((file) => file.endsWith('.mjs')).sort()
  const listed = EXECUTABLE_ALLOWLIST.filter((file) => present.includes(file)).sort()
  const missing = EXECUTABLE_ALLOWLIST.filter((file) => !present.includes(file)).sort()
  const notAllowed = present
    .filter((file) => !EXECUTABLE_ALLOWLIST.includes(file))
    .map((file) => ({ file, markers: dangerMarkers(dir, file) }))
  const allowlistedDanger = listed
    .map((file) => ({ file, markers: dangerMarkers(dir, file) }))
    .filter((entry) => entry.markers.length > 0)
  return { present, listed, missing, notAllowed, allowlistedDanger }
}

function describeNotAllowed (entry) {
  const reason = 'not_allowlisted'
  return entry.markers.length ? reason + '\tdanger_marker:' + entry.markers.join(',') : reason
}

function printList (state) {
  console.log('== allowlisted (' + state.listed.length + ') ==')
  for (const file of state.listed) console.log(file)
  console.log('\n== present-but-not-allowed (' + state.notAllowed.length + ') ==')
  for (const entry of state.notAllowed) console.log(entry.file + '\t' + describeNotAllowed(entry))
  console.log('\n== missing-from-disk (' + state.missing.length + ') ==')
  for (const file of state.missing) console.log(file + '\tmissing_from_disk')
}

function printScan (state) {
  if (state.allowlistedDanger.length || state.missing.length) {
    console.error('SAFETY_SCAN_FAILED 清单内文件存在危险特征或缺失，拒绝运行：')
    for (const entry of state.allowlistedDanger) console.error('  DANGER ' + entry.file + ' [' + entry.markers.join(', ') + ']')
    for (const file of state.missing) console.error('  MISSING ' + file)
  }
  for (const entry of state.notAllowed) {
    console.log('NOT_ALLOWED ' + entry.file + ' reason=' + describeNotAllowed(entry).replace('\t', ' '))
  }
  const ok = !state.allowlistedDanger.length && !state.missing.length
  console.log((ok ? 'SAFETY_SCAN_OK' : 'SAFETY_SCAN_FAILED') +
    ' allowlisted=' + state.listed.length +
    ' present_not_allowed=' + state.notAllowed.length +
    ' missing=' + state.missing.length +
    ' allowlisted_danger=' + state.allowlistedDanger.length)
  return ok ? 0 : 1
}

function flagValue (argv, flag) {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[index + 1] : null
}

function positional (argv) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only') { i++; continue }
    if (arg.startsWith('-')) continue
    out.push(arg)
  }
  return out.join(' ').trim()
}

export async function main (argv = process.argv.slice(2), env = process.env) {
  const state = classify(__dirname)

  if (argv.includes('--list')) { printList(state); return 0 }
  if (argv.includes('--scan-only')) return printScan(state)

  // 第二道闸先于一切执行：清单内文件命中危险特征即拒绝启动。
  if (state.allowlistedDanger.length) {
    console.error('SAFETY_SCAN_FAILED 清单内文件命中危险特征（denylist 第二道闸）：')
    for (const entry of state.allowlistedDanger) console.error('  DANGER ' + entry.file + ' [' + entry.markers.join(', ') + ']')
    return 1
  }

  if (env.MG_ALLOW_LIVE_TESTS !== '1') {
    console.error('Legacy suites require MG_ALLOW_LIVE_TESTS=1（白名单内的自包含套件；清单外文件永不执行）')
    return 2
  }

  const onlyFile = flagValue(argv, '--only')
  const override = !!onlyFile
  let list
  let fileMode
  if (onlyFile) {
    if (onlyFile.includes('/') || onlyFile.includes('\\') || !/^[A-Za-z0-9._-]+\.mjs$/.test(onlyFile)) {
      console.error('--only 只接受 scripts/test 下的单个 .mjs 文件名：' + onlyFile)
      return 2
    }
    if (onlyFile === 'live.mjs') {
      console.error('--only 拒绝指向 live.mjs 自身（避免递归启动运行器）')
      return 2
    }
    if (!existsSync(path.join(__dirname, onlyFile))) {
      console.error('--only 文件不存在：' + onlyFile)
      return 2
    }
    const listed = EXECUTABLE_ALLOWLIST.includes(onlyFile)
    if (!listed && env.MG_LIVE_ALLOW_UNLISTED !== '1') {
      console.error('拒绝执行清单外文件 ' + onlyFile + '：必须同时设置 MG_ALLOW_LIVE_TESTS=1 与 MG_LIVE_ALLOW_UNLISTED=1')
      return 2
    }
    if (!listed) {
      const markers = dangerMarkers(__dirname, onlyFile)
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
      console.warn('[UNLISTED_OVERRIDE] 正在执行白名单外文件：' + onlyFile)
      console.warn('  已显式设置 MG_LIVE_ALLOW_UNLISTED=1；该文件未经默认安全评审。')
      if (markers.length) console.warn('  危险特征（仅提示，override 模式不拦截）：' + markers.join(','))
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
    }
    list = [onlyFile]
    fileMode = listed ? 'allowlisted' : 'unlisted-override'
  } else {
    const filter = positional(argv).toLowerCase()
    list = state.listed.slice()
    if (filter) list = list.filter((file) => file.toLowerCase().includes(filter))
    if (!list.length) {
      console.error('无匹配测试: ' + filter + '（白名单内可执行文件见 --list；清单外文件不会执行）')
      return 2
    }
    fileMode = 'allowlisted'
  }

  console.log('旧集成套件（正向白名单）  筛选: ' + (onlyFile || positional(argv) || '全部') + '  文件数: ' + list.length)
  if (override && fileMode === 'unlisted-override') console.log('[UNLISTED_OVERRIDE] ' + onlyFile)

  const failed = []
  for (const file of list) {
    console.log('\n== ' + file + ' ==')
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join('scripts/test', file)], {
        cwd: root, stdio: 'inherit', env: { ...env, MG_ALLOW_LIVE_TESTS: '1' },
      })
      child.once('error', reject)
      child.once('exit', (exitCode) => resolve(exitCode))
    })
    if (code !== 0) failed.push(file)
  }
  console.log('\n=== 结果: ' + (list.length - failed.length) + '/' + list.length + ' 文件通过' +
    (failed.length ? '，失败 [' + failed.join(', ') + ']' : '') +
    (override && fileMode === 'unlisted-override' ? ' [UNLISTED_OVERRIDE ' + onlyFile + ']' : '') + ' ===')
  return failed.length ? 1 : 0
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entry && entry === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
