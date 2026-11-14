// 用户级环境变量实时读取契约（Windows）：进程环境是启动快照，用户之后新增的变量
// 对已运行进程不可见——网关 resolveKey 应 fallback 实时读注册表 HKCU\Environment，
// 让「系统里配完 key 就能用」，无需重启网关/托盘。
// 测试方式：向注册表写入临时变量（进程环境里绝无此变量）→ 请求验证网关取到 → 清理。
// MG-004：自建隔离实例；非 Windows 平台打印 N/A 且不记为通过（无 SKIP、不静默放行）。
import { spawnSync } from 'node:child_process'
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

if (process.platform !== 'win32') {
  console.log('N/A  user-env-fallback 仅 Windows（注册表用户级环境变量）：本机平台 ' + process.platform + '，未执行，不计通过')
  process.exit(0)
}

const VAR = 'MG_TEST_USER_ENV_KEY'
const VAL = 'test-registry-key-12345'

// —— 准备：写入注册表用户级变量（进程环境快照里必然没有它）——
const wr = spawnSync('reg', ['add', 'HKCU\\Environment', '/v', VAR, '/t', 'REG_SZ', '/d', VAL, '/f'], { encoding: 'utf8' })
// 写不进去就无法验证 → 明确失败，不当作跳过/通过
if (wr.status !== 0) throw new Error('注册表写入失败: ' + String(wr.stderr || '').slice(0, 200))

// mock 上游：校验 Authorization 是否为注册表里的值
let seenAuth = null
const srv = await startMockServer((req, res) => {
  seenAuth = req.headers.authorization || ''
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 't-ue-m1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
try {
  const fx = await startGateway({
    name: 'user-env-fallback',
    config: {
      providers: { 't-ue-p': { baseUrl: srv.base, apiKeyEnv: VAR, pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null } },
      models: { 't-ue-m1': { provider: 't-ue-p', alias: [], fallbacks: [], maxConcurrent: 0 } },
      defaults: { retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 }, failbackProbe: { enabled: false } },
    },
  })
  try {
    // —— 验证：请求应命中注册表里的 key（进程环境 fallback）——
    const r1 = await fx.chat('t-ue-m1')
    check('1·进程环境无此变量，请求仍成功（fallback 注册表生效）', r1.status === 200, { status: r1.status })
    check('2·上游收到的 Authorization = 注册表值', seenAuth === 'Bearer ' + VAL, { auth: seenAuth ? seenAuth.slice(0, 30) + '...' : seenAuth })
  } finally {
    await fx.stop()
  }
} finally {
  await srv.stop()
  spawnSync('reg', ['delete', 'HKCU\\Environment', '/v', VAR, '/f'], { encoding: 'utf8' })
  console.log('注册表临时变量已清理')
}
finish('user-env-fallback')
