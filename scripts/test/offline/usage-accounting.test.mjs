// UI 演示契约 §2.1 / MG-006 记账口径：请求数（requests）与 prompt 缓存 token（hit/miss）解耦。
// 3 次成功的 /v1/chat/completions（回环 mock 上游，零真实上游、零付费）后：
//   · /api/model-stats?days=1 同一模型小时桶 requests 合计 = 3；
//   · hit/miss 仍是缓存命中/未命中的 prompt token，与请求数不同量纲；
//   · 新字段 cacheHitTokens/cacheMissTokens 与兼容别名 hit/miss 同值；
//   · /api/status.counters.requests = 3，models[] 的 requests/todayRequests = 3。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ADMIN = { authorization: 'Bearer test-admin' }
// 每次请求：prompt 100（其中命中缓存 60、未命中 40），completion 20，合计 120。
const USAGE = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 60 },
}

test('usage accounting: requests 与缓存 token（hit/miss）分离', { timeout: 30000 }, async (t) => {
  let calls = 0
  const up = await startScriptedUpstream(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: 'vendor-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: USAGE,
    }))
  })
  // 升级前的历史日桶没有 requests 字段：必须投影为 null（未知），不能伪造成 0。
  const dir = await mkdtemp(join(tmpdir(), 'mg-usage-legacy-'))
  const y = new Date(); y.setDate(y.getDate() - 1)
  const yKey = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0')
  await writeFile(join(dir, 'stats.json'), JSON.stringify({
    daily: { demo: { [yKey]: { tokens: 10, hit: 6, miss: 4 } } },
    hourly: {}, byModel: {}, dialogue: {}, global: {}, byProvider: {}, lastServing: null,
  }))
  const gw = await startGateway({
    name: 'usage-accounting',
    dir,
    config: {
      providers: {
        mock: { baseUrl: up.base, api: 'openai', apiKeyEnv: '', pathPrefix: '', extraHeaders: {} },
      },
      models: {
        demo: { provider: 'mock', capability: 'chat', alias: [], fallbacks: [] },
      },
    },
  })
  t.after(async () => { await gw.stop(); await up.stop(); await rm(dir, { recursive: true, force: true }) })

  for (let i = 0; i < 3; i++) {
    const r = await gw.post('/v1/chat/completions', {
      model: 'demo',
      messages: [{ role: 'user', content: 'ping' }],
    }, ADMIN)
    assert.equal(r.status, 200, '第 ' + (i + 1) + ' 次 chat completion 应成功')
    const j = await r.json()
    assert.equal(j.choices[0].message.content, 'pong')
  }
  assert.equal(calls, 3, '3 次客户端请求 = 3 次上游调用')

  // ── /api/model-stats?days=1：小时桶 requests 求和 = 客户端请求数 ──
  const stats = await (await gw.get('/api/model-stats?days=1', ADMIN)).json()
  assert.equal(stats.days, 1)
  assert.equal(stats.mode, 'hourly')
  const buckets = stats.models.demo
  assert.equal(Array.isArray(buckets), true)
  assert.equal(buckets.length, 24, 'days=1 为 24 个小时桶')
  const sum = (field) => buckets.reduce((a, b) => a + (b[field] || 0), 0)
  assert.equal(sum('requests'), 3, '同一模型小时桶 requests 合计 = 3')
  assert.equal(sum('tokens'), 360, '3 × total_tokens 120')
  assert.equal(sum('inTokens'), 300, '3 × prompt_tokens 100')
  assert.equal(sum('outTokens'), 60, '3 × completion_tokens 20')
  assert.equal(sum('hit'), 180, 'hit 是缓存命中的 prompt token（60 × 3），不是请求数')
  assert.equal(sum('miss'), 120, 'miss 是未命中的 prompt token（40 × 3），不是请求数')
  assert.notEqual(sum('hit'), sum('requests'), 'hit 不得等于请求数')
  assert.notEqual(sum('miss'), sum('requests'), 'miss 不得等于请求数')
  assert.equal(sum('cacheHitTokens'), sum('hit'), 'cacheHitTokens 与兼容别名 hit 同值')
  assert.equal(sum('cacheMissTokens'), sum('miss'), 'cacheMissTokens 与兼容别名 miss 同值')

  // 有数据的桶：新字段与兼容别名逐桶同值；每个请求贡献固定 token 量（跨整点也不脆）
  const active = buckets.filter((b) => (b.requests || 0) > 0)
  assert.ok(active.length >= 1 && active.length <= 3, '3 次请求最多落在 3 个小时桶')
  for (const b of active) {
    assert.equal(b.cacheHitTokens, b.hit)
    assert.equal(b.cacheMissTokens, b.miss)
    assert.equal(b.tokens, 120 * b.requests)
    assert.equal(b.hit, 60 * b.requests)
    assert.equal(b.miss, 40 * b.requests)
    assert.equal(b.hitRate, 60)
  }

  // ── /api/model-stats?days=7：日桶与小时桶同源，跨整点/跨日也不脆（用求和断言） ──
  const daily = await (await gw.get('/api/model-stats?days=7', ADMIN)).json()
  assert.equal(daily.mode, 'daily')
  const dayBuckets = daily.models.demo
  assert.equal(dayBuckets.length, 7)
  const daySum = (field) => dayBuckets.reduce((a, b) => a + (b[field] || 0), 0)
  assert.equal(daySum('requests'), 3, '日桶 requests 合计同样 = 3')
  assert.equal(daySum('hit'), 186, '3×60 + 历史桶 6（历史桶没有 requests，但 token 保留）')
  assert.equal(daySum('miss'), 124, '3×40 + 历史桶 4')
  for (const b of dayBuckets.filter((x) => (x.requests || 0) > 0)) {
    assert.equal(b.cacheHitTokens, b.hit)
    assert.equal(b.cacheMissTokens, b.miss)
  }
  const legacy = dayBuckets.find((b) => b.date === yKey)
  assert.ok(legacy, '7 天窗口包含昨天的历史桶')
  assert.equal(legacy.requests, null, '历史桶没有 requests 字段 → null，不是 0')
  assert.equal(legacy.tokens, 10, '历史桶 token 原样保留')
  assert.equal(legacy.hit, 6)
  assert.equal(legacy.miss, 4)

  // ── /api/status：进程计数与模型投影同源 ──
  const status = await (await gw.get('/api/status', ADMIN)).json()
  assert.equal(status.counters.requests, 3, '启动以来 counters.requests = 3（不按 token 计）')
  const model = status.models.find((m) => m.name === 'demo')
  assert.ok(model, '/api/status.models[] 含 demo')
  assert.equal(model.requests, 3, 'models[].requests = 3')
  assert.equal(model.todayRequests, 3, 'models[].todayRequests = 今日日桶 requests')
  assert.equal(model.today, 360, 'models[].today 仍是今日 token')
})