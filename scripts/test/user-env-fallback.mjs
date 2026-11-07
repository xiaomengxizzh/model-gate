// 用户级环境变量实时读取契约（Windows）：进程环境是启动快照，用户之后新增的变量
// 对已运行进程不可见——网关 resolveKey 应 fallback 实时读注册表 HKCU\Environment，
// 让「系统里配完 key 就能用」，无需重启网关/托盘。
// 测试方式：向注册表写入临时变量（进程环境里绝无此变量）→ 请求验证网关取到 → 清理。
// 非 Windows 平台 skip。注意：**不得 process.exit**——runner 在单进程内依次 import 测试，
// exit 会把后续测试全部掐断（2026-11-07 隔离 8788 实测：virtual-models/z-* 被跳过）。
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'

if (process.platform !== 'win32') {
  check('user-env fallback（仅 Windows）', true, null, true)
} else {
  async function main() {
  const VAR = 'MG_TEST_USER_ENV_KEY'
  const VAL = 'test-registry-key-12345'

  // —— 准备：写入注册表用户级变量（进程环境快照里必然没有它）——
  const wr = spawnSync('reg', ['add', 'HKCU\\Environment', '/v', VAR, '/t', 'REG_SZ', '/d', VAL, '/f'], { encoding: 'utf8' })
  if (wr.status !== 0) { console.log('SKIP  注册表写入失败: ' + (wr.stderr || '').slice(0, 120)); return }
  console.log('已写入注册表 ' + VAR + '（进程环境无此变量）')

  // mock 上游：校验 Authorization 是否为注册表里的值
  let seenAuth = null
  const srv = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 't-ue-m1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  await new Promise(r => srv.listen(0, () => r()))
  const port = srv.address().port

  const base = await snapshot()
  const origDefaults = JSON.parse(JSON.stringify(base.defaults))
  base.providers['t-ue-p'] = { baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: VAR, pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
  base.models['t-ue-m1'] = { provider: 't-ue-p', alias: [], fallbacks: [], maxConcurrent: 0 }
  base.defaults = { ...(base.defaults || {}), retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 }, failbackProbe: { enabled: false } }
  await save(base.providers, base.models, base.defaults)

  // —— 验证：请求应命中注册表里的 key（进程环境 fallback）——
  const r1 = await chat('t-ue-m1')
  check('1·进程环境无此变量，请求仍成功（fallback 注册表生效）', r1.status === 200, { status: r1.status })
  check('2·上游收到的 Authorization = 注册表值', seenAuth === 'Bearer ' + VAL, { auth: seenAuth ? seenAuth.slice(0, 30) + '...' : seenAuth })

  // —— 清理 ——
  const after = await snapshot()
  delete after.providers['t-ue-p']; delete after.models['t-ue-m1']
  after.defaults = origDefaults
  await save(after.providers, after.models, after.defaults)
  await new Promise(r => srv.close(r))
  spawnSync('reg', ['delete', 'HKCU\\Environment', '/v', VAR, '/f'], { encoding: 'utf8' })
  console.log('注册表临时变量已清理')

  }
  await main()
}
