// MG-016 管理面契约回归：鉴权矩阵、错误信封、版本冲突、参数夹取与本地初始化。
// 契约正文见 docs/contracts/management-api-v1.md；本文件只断言其中列出的形状。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startMockUpstream } from './harness.mjs'

const ADMIN = { authorization: 'Bearer test-admin' }

test('管理 API：无令牌本地初始化，设置令牌后全表加锁', { timeout: 25000 }, async (t) => {
  const gw = await startGateway({ name: 'contract-boot' })
  t.after(() => gw.stop())

  const auth = await gw.get('/api/auth')
  assert.equal(auth.status, 200)
  const authBody = await auth.json()
  assert.equal(authBody.needAuth, false)
  assert.equal(typeof authBody.startedAt, 'number')

  // 未配置令牌=本地初始化窗口：管理读接口开放，写接口也开放（MG-001 待收紧）
  assert.equal((await gw.get('/api/status')).status, 200)

  const set = await gw.post('/api/admin-token', { token: ' local-token ' })
  assert.equal(set.status, 200)
  assert.deepEqual(await set.json(), { ok: true, needAuth: true })
  assert.equal((await (await gw.get('/api/auth')).json()).needAuth, true)

  assert.equal((await gw.get('/api/status')).status, 401)
  assert.equal((await gw.get('/api/status', { authorization: 'Bearer local-token' })).status, 200)
  assert.equal((await gw.get('/api/status', { 'x-mg-admin': 'local-token' })).status, 200)
  assert.equal((await gw.get('/api/status', { authorization: 'Bearer  local-token  ' })).status, 200)
  assert.equal((await gw.get('/api/status', { authorization: 'Bearer nope' })).status, 401)

  const denied = await (await gw.get('/api/status')).json()
  assert.equal(typeof denied.error, 'string', '管理面 401 错误信封为 {error: string}')

  // 轮换令牌必须出示当前令牌
  assert.equal((await gw.post('/api/admin-token', { token: 'next' })).status, 401)
  assert.equal((await gw.post('/api/admin-token', { token: 'next' }, { authorization: 'Bearer local-token' })).status, 200)
  assert.equal((await gw.get('/api/status', { authorization: 'Bearer next' })).status, 200)

  // 空串=关闭保护（环境变量未设置时）
  assert.equal((await gw.post('/api/admin-token', { token: '' }, { authorization: 'Bearer next' })).status, 200)
  assert.equal((await gw.get('/api/status')).status, 200)
})

test('管理 API：鉴权矩阵、错误码、版本冲突与参数夹取', { timeout: 40000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'contract-admin',
    env: { MG_ADMIN_TOKEN: 'test-admin' },
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai' } },
      virtualModels: [{ name: 'private', directory: [{ model: 'demo' }] }],
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // ① 鉴权矩阵：未携带令牌时全部管理路径 401，/api/auth 公开例外
  const protectedRoutes = [
    ['GET', '/api/status'], ['GET', '/api/model-stats'], ['GET', '/api/logs'],
    ['POST', '/api/config/reload'], ['POST', '/api/config/save'], ['POST', '/api/keys'],
    ['POST', '/api/route-preview'], ['POST', '/api/probe'], ['POST', '/api/model-test'],
  ]
  for (const [method, path] of protectedRoutes) {
    const r = await gw.call(path, { method, body: method === 'POST' ? {} : undefined })
    assert.equal(r.status, 401, method + ' ' + path + ' 无令牌应 401')
    assert.equal(typeof (await r.json()).error, 'string')
  }
  assert.equal((await gw.get('/api/auth')).status, 200)
  const hitsBefore = upstream.hits.length

  // ② 请求体错误
  const badJson = await gw.post('/api/config/save', '{bad', Object.assign({ 'content-type': 'application/json' }, ADMIN))
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).error, '请求体必须为 JSON 对象')

  // ③ 引用校验：模型指向不存在的上游 → 400
  const badProvider = await gw.post('/api/config/save', { models: { demo: { provider: 'ghost' } } }, ADMIN)
  assert.equal(badProvider.status, 400)
  assert.match((await badProvider.json()).error, /不存在的上游/)

  // ④ 版本冲突：过期 version → 409 且带回 currentVersion
  const status0 = await (await gw.get('/api/status', ADMIN)).json()
  const stale = await gw.post('/api/config/save', { version: status0.configVersion + 99 }, ADMIN)
  assert.equal(stale.status, 409)
  const staleBody = await stale.json()
  assert.equal(staleBody.currentVersion, status0.configVersion)
  assert.equal(typeof staleBody.error, 'string')

  // ⑤ 正常保存：version 前进一位，缺 version 的旧客户端仍被宽容接受
  const ok = await gw.post('/api/config/save', { version: status0.configVersion, defaults: { proxyMode: 'direct' } }, ADMIN)
  assert.equal(ok.status, 200)
  const okBody = await ok.json()
  assert.equal(okBody.ok, true)
  assert.equal(okBody.status.configVersion, status0.configVersion + 1)
  assert.equal((await gw.post('/api/config/save', { defaults: { proxyMode: 'direct' } }, ADMIN)).status, 200)

  // ⑥ keys：缺 id → 400；过期 version → 409；正常写入 → 200
  assert.equal((await gw.post('/api/keys', {}, ADMIN)).status, 400)
  const keysStale = await gw.post('/api/keys', { id: 'mock', key: 'k', version: 9999 }, ADMIN)
  assert.equal(keysStale.status, 409)
  assert.equal(typeof (await keysStale.json()).currentVersion, 'number')
  assert.equal((await gw.post('/api/keys', { id: 'mock', key: 'mock-key' }, ADMIN)).status, 200)

  // ⑦ route-preview：缺 model → 400；虚拟/真实/未知三种命中；不调用上游
  assert.equal((await gw.post('/api/route-preview', {}, ADMIN)).status, 400)
  const vmHit = await (await gw.post('/api/route-preview', { model: 'private' }, ADMIN)).json()
  assert.equal(vmHit.ok, true)
  assert.equal(vmHit.hit.type, 'virtual')
  assert.equal(vmHit.hit.name, 'private')
  assert.deepEqual(vmHit.hit.directory.map((e) => e.model), ['demo'])
  const modelHit = await (await gw.post('/api/route-preview', { model: 'demo' }, ADMIN)).json()
  assert.equal(modelHit.hit.type, 'model')
  assert.equal(modelHit.hit.provider, 'mock')
  const unknownHit = await (await gw.post('/api/route-preview', { model: 'ghost' }, ADMIN)).json()
  assert.equal(unknownHit.hit.type, 'unknown')

  // ⑧ model-stats：days 夹取到 1–90，1 天为小时桶，其余为日期桶
  const d0 = await (await gw.get('/api/model-stats?days=0', ADMIN)).json()
  assert.equal(d0.days, 7)
  assert.equal(d0.mode, 'daily')
  assert.equal(d0.models.demo.length, 7)
  const d1 = await (await gw.get('/api/model-stats?days=1', ADMIN)).json()
  assert.equal(d1.mode, 'hourly')
  assert.equal(d1.models.demo.length, 24)
  const dBig = await (await gw.get('/api/model-stats?days=1000', ADMIN)).json()
  assert.equal(dBig.days, 90)

  // ⑨ logs：lines 为字符串数组
  const logs = await (await gw.get('/api/logs?lines=50', ADMIN)).json()
  assert.ok(Array.isArray(logs.lines))
  assert.ok(logs.lines.every((l) => typeof l === 'string'))

  // ⑩ probe / model-test 会触达上游（本地 mock）；未知模型为 400
  const probe = await (await gw.post('/api/probe', { id: 'mock' }, ADMIN)).json()
  assert.equal(probe.ok, true)
  assert.equal(probe.results[0].id, 'mock')
  assert.equal(typeof probe.results[0].ok, 'boolean')
  const testRes = await (await gw.post('/api/model-test', { id: 'demo' }, ADMIN)).json()
  assert.equal(testRes.ok, true)
  assert.equal(testRes.result.id, 'demo')
  assert.equal((await gw.post('/api/model-test', { id: 'ghost' }, ADMIN)).status, 400)
  assert.ok(upstream.hits.length > hitsBefore, '探测/测试确实发往上游 mock')

  // ⑪ 管理面 body 上限 → 413 payload_too_large
  const tooBig = await gw.post('/api/config/save', 'x'.repeat(70 * 1024), Object.assign({ 'content-type': 'application/json' }, ADMIN))
  assert.equal(tooBig.status, 413)
  assert.equal((await tooBig.json()).error.type, 'payload_too_large')

  // ⑫ 未知 /api 路径走 404 纯文本（不落入数据面）
  const unknown = await gw.get('/api/nope', ADMIN)
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.text()).trim(), 'not found')
})
