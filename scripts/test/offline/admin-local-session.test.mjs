// MG-FIX-P1-04 服务端半：本机管理会话解锁的真实 HTTP 回归。
//
// 生产现象：needAuth=false 时 /api/aggregation/* 一律 403，GUI 无法退出聚合。
// 修复：回环 + 同源/Host 通过后 POST /api/admin/unlock 签发短时、纯内存、重启即失效的
// local-admin 令牌；该令牌作为 Bearer 通过 explicitAdminOf，使聚合/Codex 管理面可用。
// 绝不把回环当永久管理员、不放宽远程/跨源、不落盘/不写日志。
//
// 用真实隔离网关（startGateway，回环、临时目录、无真实凭据）驱动，全程零付费、零外网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './harness.mjs'

async function withGateway (opts, fn) {
  const gw = await startGateway(opts)
  try { return await fn(gw) } finally { await gw.stop() }
}

test('无全局令牌：聚合面 403 → 本机解锁 200 → 会话令牌放行聚合管理面', async () => {
  await withGateway({ name: 'mg-unlock' }, async (gw) => {
    // 前题：未设置全局管理令牌。
    const auth = await (await gw.get('/api/auth')).json()
    assert.equal(auth.needAuth, false)

    // 未解锁：聚合管理面 403 explicit_admin_required。
    const before = await gw.get('/api/aggregation/health')
    assert.equal(before.status, 403)
    const beforeBody = await before.json()
    assert.equal(beforeBody.code, 'explicit_admin_required')

    // 本机解锁：200 + local-admin 令牌。
    const res = await gw.post('/api/admin/unlock', {})
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.scope, 'local-admin')
    assert.match(body.token, /^[a-f0-9]{64}$/, '令牌是不透明 32 字节 hex')
    assert.ok(body.expiresAt > Date.now(), 'expiresAt 是未来时间戳')

    // 用令牌访问聚合管理面：不再 403。
    const after = await gw.get('/api/aggregation/health', { authorization: 'Bearer ' + body.token })
    assert.equal(after.status, 200, JSON.stringify(await after.json()))
  })
})

test('会话令牌不写日志/不回显；重启后失效（纯内存）', async () => {
  let token
  let dir
  await withGateway({ name: 'mg-unlock-restart' }, async (gw) => {
    dir = gw.dir
    const res = await gw.post('/api/admin/unlock', {})
    token = (await res.json()).token
    const after = await gw.get('/api/aggregation/health', { authorization: 'Bearer ' + token })
    assert.equal(after.status, 200)
  })
  // 令牌不得出现在隔离网关的日志里。
  const { readFileSync, existsSync } = await import('node:fs')
  const logPath = dir + '/test.log'
  if (existsSync(logPath)) {
    assert.equal(readFileSync(logPath, 'utf8').includes(token), false, '会话令牌不得写入日志')
  }
  // 新进程（模拟重启）：旧令牌无效 —— 新网关用自己的临时目录，但令牌仓库是全新 Map。
  await withGateway({ name: 'mg-unlock-restart2' }, async (gw2) => {
    const revived = await gw2.get('/api/aggregation/health', { authorization: 'Bearer ' + token })
    assert.equal(revived.status, 403, '重启/新进程的会话令牌必须失效')
  })
})

test('已设置全局管理令牌时：无令牌解锁被拒（不能仅凭本机连接提权）', async () => {
  await withGateway({ name: 'mg-unlock-token', env: { MG_ADMIN_TOKEN: 'global-admin-secret' } }, async (gw) => {
    const res = await gw.post('/api/admin/unlock', {})
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, 'admin_unlock_denied')

    // 携带正确全局令牌：解锁成功。
    const ok = await gw.post('/api/admin/unlock', {}, { authorization: 'Bearer global-admin-secret' })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).ok, true)
  })
})

test('解锁端点拒绝非 JSON 跨源预检之外的正常同源流程不锁屏（404 语义由前端降级）', async () => {
  await withGateway({ name: 'mg-unlock-cors' }, async (gw) => {
    // 跨源 Origin 被全局策略拒绝（同源面板天然通过）。
    const cross = await gw.post('/api/admin/unlock', {}, { origin: 'https://evil.example' })
    assert.ok(cross.status === 403, '跨源解锁必须被拒：' + cross.status)
  })
})
