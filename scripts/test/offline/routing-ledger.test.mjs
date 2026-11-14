// M3-2 / T-BUDGET-01/02：持久预算账本（整数最小单位 + 单写者 + 可重启恢复）。
// 全部用例跑在真实临时目录上（不 mock fs），这样"重启恢复/原子写/锁争用"才有意义。
// 无网络、无真实睡眠长测；日切用注入时钟（前后 1ms）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEDGER_ERROR,
  LEDGER_STATUS,
  dayKeyAt,
  openLedger,
} from '../../../src/routing/ledger.js'
import {
  MICRO_PER_CURRENCY,
  budgetFromLedger,
  microFromUsd,
  usdFromMicro,
} from '../../../src/routing/facts.js'
import { ACTION, STOP, decide } from '../../../src/routing/decision.js'

const NOW = 1_700_000_000_000
const CAND = { model: 'mg/a/chat', provider: 'p1' }

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-ledger-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const statePath = (dir) => join(dir, 'ledger.json')
const lockPath = (dir) => join(dir, 'ledger.lock')
const stateText = (dir) => readFileSync(statePath(dir), 'utf8')

function quote(amountMicro, extra = {}) {
  return Object.assign({ amountMicro, currency: 'USD', version: 'q1' }, extra)
}

function req(over = {}) {
  return Object.assign({
    requestId: 'req-1',
    requestDigest: 'digest-1',
    taskRef: 'task-1',
    candidate: CAND,
    quote: quote(100),
  }, over)
}

const isCode = (code) => (e) => e && e.code === code

// ============================================================================
// 1. 整数最小单位 + 显式币种：拒绝浮点、拒绝隐式换算
// ============================================================================
test('M3-2：金额只收整数最小单位与显式币种（拒绝浮点/缺币种/跨币种）', async (t) => {
  const dir = tempDir(t)
  const led = openLedger({ dir, caps: { dayMicro: 1000 } })

  await assert.rejects(() => led.reserve(req({ quote: quote(100.5) })), isCode(LEDGER_ERROR.BAD_REQUEST))
  await assert.rejects(() => led.reserve(req({ quote: { amountMicro: 100, version: 'q1' } })), isCode(LEDGER_ERROR.BAD_REQUEST))
  await assert.rejects(() => led.reserve(req({ quote: quote(100, { currency: 'EUR' }) })), isCode(LEDGER_ERROR.CURRENCY_MISMATCH))
  await assert.rejects(() => led.reserve(req({ quote: quote(100, { version: '' }) })), isCode(LEDGER_ERROR.BAD_REQUEST))

  // 上述失败必须零副作用：账本文件根本不该被创建。
  assert.equal(existsSync(statePath(dir)), false)

  const r = await led.reserve(req())
  assert.equal(r.status, LEDGER_STATUS.RESERVED)
  assert.equal(r.currency, 'USD')
  assert.equal(r.unit, 'micro')
  assert.equal(r.quoteMicro, 100)
  assert.equal(r.maxCostMicro, 100)

  // 结算同样必须显式币种，且不允许跨币种。
  await assert.rejects(() => led.settle(r.attemptId, { actualMicro: 100 }), isCode(LEDGER_ERROR.BAD_REQUEST))
  await assert.rejects(() => led.settle(r.attemptId, { actualMicro: 100, currency: 'EUR' }), isCode(LEDGER_ERROR.CURRENCY_MISMATCH))

  // 边界换算助手：入/出口各一次，内部仍是整数。
  assert.equal(usdFromMicro(1234), 0.001234)
  assert.equal(microFromUsd(0.001234), 1234)
  assert.equal(MICRO_PER_CURRENCY, 1_000_000)
  assert.throws(() => microFromUsd(-1))
})

// ============================================================================
// 2. 幂等：同键同摘要不双记；同键不同摘要冲突
// ============================================================================
test('M3-2：幂等 (requestId, digest) —— 同键同摘要返回既有 receipt，不双记', async (t) => {
  const dir = tempDir(t)
  const led = openLedger({ dir, caps: { dayMicro: 1000 } })

  const a = await led.reserve(req())
  const b = await led.reserve(req())
  assert.equal(b.attemptId, a.attemptId)
  assert.equal(b.duplicate, true)
  assert.equal(led.usage().dayMicro, 100, '重复提交不得双记')
  assert.equal(led.summary().counts.total, 1)

  await assert.rejects(() => led.reserve(req({ requestDigest: 'digest-other' })), isCode(LEDGER_ERROR.IDEMPOTENCY_CONFLICT))
  assert.equal(led.usage().dayMicro, 100)

  // 已核销为"未执行"的 attempt 允许用同键重试（旧记录保留为历史，不计费）。
  await led.release(a.attemptId, { verifiedNotExecuted: true })
  const retried = await led.reserve(req())
  assert.notEqual(retried.attemptId, a.attemptId)
  assert.equal(retried.status, LEDGER_STATUS.RESERVED)
  assert.equal(led.usage().dayMicro, 100, '释放的历史记录不再占用额度')
})

// ============================================================================
// 3. 未知用量保留
// ============================================================================
test('M3-2：unknown 不填 0、不释放（继续占额度），由 reconcile 收口', async (t) => {
  const dir = tempDir(t)
  const led = openLedger({ dir, caps: { dayMicro: 1000 } })

  const a = await led.reserve(req({ quote: quote(300) }))
  const unknown = await led.markUnknown(a.attemptId)
  assert.equal(unknown.status, LEDGER_STATUS.UNKNOWN)
  assert.equal(led.usage().dayMicro, 300, '未知用量必须继续占额度，不得静默归零')
  assert.equal(led.recover().unknown.length, 1)
  assert.equal(led.recover().unknownMicro, 300)

  const settled = await led.reconcile(a.attemptId, { actualMicro: 500, currency: 'USD' })
  assert.equal(settled.status, LEDGER_STATUS.SETTLED)
  assert.equal(settled.actualMicro, 500)
  assert.equal(led.usage().dayMicro, 500)

  const b = await led.reserve(req({ requestId: 'req-2', requestDigest: 'digest-2', quote: quote(200) }))
  await led.markUnknown(b.attemptId)
  const released = await led.reconcile(b.attemptId, { verifiedNotExecuted: true })
  assert.equal(released.status, LEDGER_STATUS.RELEASED)
  assert.equal(led.usage().dayMicro, 500, '核销为未执行后释放额度')

  // reconcile 必须且只能给一个结论。
  await assert.rejects(() => led.reconcile(b.attemptId, {}), isCode(LEDGER_ERROR.BAD_REQUEST))
  await assert.rejects(
    () => led.reconcile(a.attemptId, { actualMicro: 1, currency: 'USD', verifiedNotExecuted: true }),
    isCode(LEDGER_ERROR.BAD_REQUEST),
  )
})

// ============================================================================
// 4. 实际超预估：如实记账并阻止后续消费
// ============================================================================
test('M3-2：实际超预估如实记账（overrun）并封顶下一笔，不静默吞掉', async (t) => {
  const dir = tempDir(t)
  const led = openLedger({ dir, caps: { dayMicro: 1000 } })

  const a = await led.reserve(req({ quote: quote(600) }))
  const settled = await led.settle(a.attemptId, { actualMicro: 1500, currency: 'USD' })
  assert.equal(settled.overrun, true)
  assert.equal(settled.actualMicro, 1500)
  assert.equal(led.usage().dayMicro, 1500, '超支必须如实记入账本')

  await assert.rejects(
    () => led.reserve(req({ requestId: 'req-2', requestDigest: 'digest-2', quote: quote(1) })),
    (e) => e.code === LEDGER_ERROR.CAP_EXCEEDED && e.detail.dimension === 'day',
  )
  const persisted = JSON.parse(stateText(dir))
  assert.equal(persisted.attempts[a.attemptId].actualMicro, 1500)
  assert.equal(persisted.attempts[a.attemptId].status, LEDGER_STATUS.SETTLED)
})

// ============================================================================
// 5. 跨日边界（固定时区，前后 1ms）
// ============================================================================
test('M3-2：固定时区日切 + 跨日在途/结算记原预留日', async (t) => {
  const dir = tempDir(t)
  let clock = Date.parse('2026-11-11T23:59:59.999+08:00')
  const led = openLedger({ dir, dayZone: 'Asia/Shanghai', caps: { dayMicro: 1000 }, now: () => clock })

  const before = await led.reserve(req({ quote: quote(1000) }))
  assert.equal(before.day, '2026-11-11')

  clock = Date.parse('2026-11-12T00:00:00.000+08:00')
  const after = await led.reserve(req({ requestId: 'req-2', requestDigest: 'digest-2', quote: quote(1000) }))
  assert.equal(after.day, '2026-11-12', '日切后是新的一天，不受前一天占用影响')

  // 跨日结算：仍记原预留日，不挪到结算日。
  clock = Date.parse('2026-11-12T00:00:00.500+08:00')
  await led.settle(before.attemptId, { actualMicro: 300, currency: 'USD' })
  assert.equal(led.usage({ at: Date.parse('2026-11-11T12:00:00+08:00') }).dayMicro, 300)
  assert.equal(led.usage({ at: Date.parse('2026-11-12T12:00:00+08:00') }).dayMicro, 1000)
  assert.equal(dayKeyAt(0, 'Asia/Shanghai'), '1970-01-01')
  assert.equal(dayKeyAt(Date.parse('2026-11-11T23:59:59.999+08:00'), 'Asia/Shanghai'), '2026-11-11')
  assert.equal(dayKeyAt(Date.parse('2026-11-12T00:00:00.000+08:00'), 'Asia/Shanghai'), '2026-11-12')
})

// ============================================================================
// 6. 并发：合计不越上限，失败零副作用
// ============================================================================
test('M3-2：并发 reserve 合计不越上限（失败分支零副作用）', async (t) => {
  const dir = tempDir(t)
  const led = openLedger({ dir, caps: { dayMicro: 1000 } })

  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => led.reserve(req({
    requestId: 'req-' + i,
    requestDigest: 'digest-' + i,
    quote: quote(100),
  }))))
  const ok = results.filter((r) => r.status === 'fulfilled')
  const bad = results.filter((r) => r.status === 'rejected')
  assert.equal(ok.length, 10, '上限 1000 / 每笔 100 ⇒ 恰好 10 笔')
  assert.equal(bad.length, 10)
  assert.ok(bad.every((r) => r.reason.code === LEDGER_ERROR.CAP_EXCEEDED))
  assert.equal(led.usage().dayMicro, 1000)
  assert.equal(led.summary().counts.total, 10, '被拒的预留不得留下 attempt 记录')

  // 第二个实例指向同一目录：共享同一上限与落盘状态。
  const led2 = openLedger({ dir, caps: { dayMicro: 1000 } })
  await assert.rejects(
    () => led2.reserve(req({ requestId: 'req-x', requestDigest: 'digest-x', quote: quote(1) })),
    isCode(LEDGER_ERROR.CAP_EXCEEDED),
  )
})

// ============================================================================
// 6b. 跨进程并发：多个真实进程同时预留，合计仍不越上限（验证 O_EXCL 锁真的生效）
// ============================================================================
test('M3-2：跨进程并发（3 个进程 × 5 笔）合计不越上限', async (t) => {
  const dir = tempDir(t)
  const ledgerUrl = new URL('../../../src/routing/ledger.js', import.meta.url).href
  const worker = [
    'const { openLedger } = await import(process.env.MG_LEDGER_URL)',
    'const led = openLedger({ dir: process.env.MG_LEDGER_DIR, caps: { dayMicro: 1000 }, lockTimeoutMs: 5000 })',
    'let ok = 0; let capped = 0',
    'for (let n = 0; n < 5; n++) {',
    '  try {',
    "    await led.reserve({ requestId: 'w' + process.env.MG_LEDGER_WORKER + '-' + n, requestDigest: 'd' + n, taskRef: 't', candidate: { model: 'mg/x', provider: 'p1' }, quote: { amountMicro: 100, currency: 'USD', version: 'q1' } })",
    '    ok += 1',
    '  } catch (e) {',
    "    if (e && e.code === 'LEDGER_CAP_EXCEEDED') capped += 1; else throw e",
    '  }',
    '}',
    'process.stdout.write(JSON.stringify({ ok, capped }))',
  ].join('\n')
  const runWorker = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
      env: Object.assign({}, process.env, { MG_LEDGER_URL: ledgerUrl, MG_LEDGER_DIR: dir, MG_LEDGER_WORKER: String(id) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error('worker ' + id + ' exit ' + code + ': ' + err))
      try { resolve(JSON.parse(out)) } catch (e) { reject(new Error('worker ' + id + ' 输出无法解析: ' + out + ' / ' + err)) }
    })
  })

  const results = await Promise.all([runWorker(1), runWorker(2), runWorker(3)])
  const totalOk = results.reduce((n, r) => n + r.ok, 0)
  const totalCapped = results.reduce((n, r) => n + r.capped, 0)
  assert.equal(totalOk, 10, '3 进程共 15 笔、上限 1000/每笔 100 ⇒ 恰好 10 笔成功')
  assert.equal(totalCapped, 5)
  assert.equal(openLedger({ dir, caps: { dayMicro: 1000 } }).usage().dayMicro, 1000)
})

// ============================================================================
// 7. 重启恢复（真实目录，重新构造实例）
// ============================================================================
test('M3-2：重启恢复——从落盘状态重建在途/未知预留并可继续结算', async (t) => {
  const dir = tempDir(t)
  const caps = { dayMicro: 1000, taskMicro: 1000 }
  const led1 = openLedger({ dir, caps })
  const a = await led1.reserve(req({ quote: quote(400) }))
  const b = await led1.reserve(req({ requestId: 'req-2', requestDigest: 'digest-2', quote: quote(300) }))
  await led1.markUnknown(b.attemptId)
  await led1.close()

  const led2 = openLedger({ dir, caps })
  const recovered = led2.recover()
  assert.equal(recovered.recovered, 2)
  assert.equal(recovered.inflight.length, 1)
  assert.equal(recovered.unknown.length, 1)
  assert.equal(recovered.dayMicro, 700)
  assert.equal(led2.usage().dayMicro, 700)

  // 剩余额度 300：要 400 必须被拒，要 300 才允许。
  await assert.rejects(
    () => led2.reserve(req({ requestId: 'req-3', requestDigest: 'digest-3', quote: quote(400) })),
    isCode(LEDGER_ERROR.CAP_EXCEEDED),
  )
  const ok = await led2.reserve(req({ requestId: 'req-3', requestDigest: 'digest-3', quote: quote(300) }))
  assert.equal(ok.status, LEDGER_STATUS.RESERVED)

  // 恢复出来的 attempt 可以直接结算（不因为换了实例而丢失）。
  const settled = await led2.settle(a.attemptId, { actualMicro: 250, currency: 'USD' })
  assert.equal(settled.status, LEDGER_STATUS.SETTLED)
  assert.equal(led2.usage().dayMicro, 850)
})

// ============================================================================
// 8. 跨进程锁争用
// ============================================================================
test('M3-2：锁争用——活进程持锁报 BUSY 且零副作用；死进程残锁可抢占', async (t) => {
  const dir = tempDir(t)
  const led = openLedger({ dir, lockTimeoutMs: 40, staleLockMs: 60000, caps: { dayMicro: 1000 } })

  // 活进程（用测试进程的父进程 pid 模拟真实持锁者）持锁 ⇒ 等待超时，且绝不写账。
  writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, at: Date.now(), token: 'holder' }))
  await assert.rejects(() => led.reserve(req()), isCode(LEDGER_ERROR.BUSY))
  assert.equal(existsSync(statePath(dir)), false, '锁等待失败不得产生任何账本写入')

  // 死进程残锁 ⇒ 可抢占（不要求人工删锁）。
  const dead = spawnSync(process.execPath, ['-e', '0'])
  writeFileSync(lockPath(dir), JSON.stringify({ pid: dead.pid, at: Date.now(), token: 'dead' }))
  const ok = await led.reserve(req())
  assert.equal(ok.status, LEDGER_STATUS.RESERVED)
  assert.equal(existsSync(lockPath(dir)), false, '正常释放后不得留下锁文件')

  // 不可解析的残锁按文件年龄判定：新锁 → BUSY（不猜、不抢）。
  writeFileSync(lockPath(dir), 'not-json')
  await assert.rejects(
    () => led.reserve(req({ requestId: 'req-2', requestDigest: 'digest-2' })),
    isCode(LEDGER_ERROR.BUSY),
  )
})

// ============================================================================
// 9. 损坏/配置冲突：拒绝启动，绝不静默重置
// ============================================================================
test('M3-2：账本损坏或配置冲突时拒绝启动（不自动重置已花的钱）', async (t) => {
  const dir = tempDir(t)
  writeFileSync(statePath(dir), '{not json')
  assert.throws(() => openLedger({ dir }), isCode(LEDGER_ERROR.CORRUPT))
  assert.equal(stateText(dir), '{not json', '损坏文件不得被自动覆盖')

  rmSync(statePath(dir))
  const led = openLedger({ dir })
  await led.reserve(req())
  assert.throws(() => openLedger({ dir, currency: 'EUR' }), isCode(LEDGER_ERROR.CURRENCY_MISMATCH))
  assert.throws(() => openLedger({ dir, dayZone: 'UTC' }), isCode(LEDGER_ERROR.CONFIG_CONFLICT))
  assert.throws(() => openLedger({ dir: '' }), isCode(LEDGER_ERROR.BAD_REQUEST))
})

// ============================================================================
// 10. 脱敏：对外摘要与落盘内容都不含 key/URL/错误体
// ============================================================================
test('M3-2：对外摘要与落盘内容脱敏（sk- 哨兵不外泄）', async (t) => {
  const SENTINEL = 'sk-live-SENTINEL-98765'
  const dir = tempDir(t)
  const led = openLedger({ dir, caps: { dayMicro: 1_000_000 } })

  const r = await led.reserve(req({
    requestId: 'req-' + SENTINEL,
    taskRef: 'task-' + SENTINEL,
    candidate: {
      model: 'mg/a/chat',
      provider: 'p1',
      apiKey: SENTINEL,
      headers: { authorization: 'Bearer ' + SENTINEL },
      baseURL: 'https://user:' + SENTINEL + '@up.example/v1',
    },
    quote: { amountMicro: 100, currency: 'USD', version: 'q1', source: 'https://up.example/q?key=' + SENTINEL },
  }))
  await led.markUnknown(r.attemptId)
  await led.reconcile(r.attemptId, { actualMicro: 120, currency: 'USD', note: SENTINEL })

  const exposed = JSON.stringify([
    r,
    led.getAttempt(r.attemptId),
    led.getRequestAttempt('req-' + SENTINEL, 'digest-1'),
    led.usage({ requestId: 'req-' + SENTINEL, taskRef: 'task-' + SENTINEL }),
    led.summary(),
    led.recover(),
  ])
  assert.ok(!exposed.includes('SENTINEL'), '对外摘要不得含凭据/URL：' + exposed)
  assert.ok(!stateText(dir).includes('SENTINEL'), '落盘内容不得含凭据/URL/请求原文')
  // 账本仍能按哈希正确关联同一次尝试。
  assert.equal(typeof r.requestKey, 'string')
  assert.equal(r.requestKey.length, 64)
  assert.equal(r.taskLabel, 'redacted')
})

// ============================================================================
// 11. 释放幂等与状态机
// ============================================================================
test('M3-2：release 幂等，已结算不得再释放/再标记未知', async (t) => {
  const dir = tempDir(t)
  const led = openLedger({ dir, caps: { dayMicro: 1000 } })

  const a = await led.reserve(req())
  await assert.rejects(() => led.release(a.attemptId, {}), isCode(LEDGER_ERROR.BAD_REQUEST), '未核实不得释放额度')
  const r1 = await led.release(a.attemptId, { verifiedNotExecuted: true })
  assert.equal(r1.status, LEDGER_STATUS.RELEASED)
  const r2 = await led.release(a.attemptId, { verifiedNotExecuted: true })
  assert.equal(r2.duplicate, true)
  assert.equal(r2.status, LEDGER_STATUS.RELEASED)
  assert.equal(led.usage().dayMicro, 0)
  await assert.rejects(() => led.settle(a.attemptId, { actualMicro: 1, currency: 'USD' }), isCode(LEDGER_ERROR.STATE_INVALID))

  const b = await led.reserve(req({ requestId: 'req-2', requestDigest: 'digest-2' }))
  await led.settle(b.attemptId, { actualMicro: 10, currency: 'USD' })
  await assert.rejects(() => led.release(b.attemptId, { verifiedNotExecuted: true }), isCode(LEDGER_ERROR.STATE_INVALID))
  await assert.rejects(() => led.markUnknown(b.attemptId), isCode(LEDGER_ERROR.STATE_INVALID))
  // 二次结算同样金额是幂等；不同金额拒绝（避免二次记账）。
  const again = await led.settle(b.attemptId, { actualMicro: 10, currency: 'USD' })
  assert.equal(again.duplicate, true)
  await assert.rejects(() => led.settle(b.attemptId, { actualMicro: 11, currency: 'USD' }), isCode(LEDGER_ERROR.STATE_INVALID))
})

// ============================================================================
// 12. 报价快照校验 + 最坏情况上界
// ============================================================================
test('M3-2：报价快照时效与 worstCase 上界（按时效拒绝旧报价）', async (t) => {
  const dir = tempDir(t)
  const now = Date.parse('2026-11-11T10:00:00Z')
  const led = openLedger({ dir, now: () => now, quoteMaxAgeMs: 60_000, caps: { dayMicro: 10_000 } })

  await assert.rejects(() => led.reserve(req({ quote: quote(100, { quotedAt: now - 120_000 }) })), isCode(LEDGER_ERROR.QUOTE_STALE))
  await assert.rejects(() => led.reserve(req({ quote: quote(100) })), isCode(LEDGER_ERROR.QUOTE_STALE))

  const r = await led.reserve(req({ quote: quote(100, { quotedAt: now - 1000, worstCaseMicro: 400 }) }))
  assert.equal(r.quoteMicro, 100)
  assert.equal(r.maxCostMicro, 400)
  assert.equal(led.usage().dayMicro, 400, '预留必须按最坏情况占额度')

  await assert.rejects(
    () => led.reserve(req({ requestId: 'req-2', requestDigest: 'digest-2', quote: quote(100, { quotedAt: now, worstCaseMicro: 50 }) })),
    isCode(LEDGER_ERROR.BAD_REQUEST),
  )
})

// ============================================================================
// 13. 适配器：账本整数视图 → 决策器 budget（单位/币种/来源）
// ============================================================================
test('M3-2：budgetFromLedger 把账本整数视图喂给决策器，且 micro 单位只换算一次', async (t) => {
  const dir = tempDir(t)
  const limitsMicro = { requestMicro: 10_000_000, taskMicro: 8_000_000, dayMicro: 1_000_000 }
  const led = openLedger({ dir, caps: { dayMicro: 1_000_000, taskMicro: 8_000_000, requestMicro: 10_000_000 } })
  const a = await led.reserve(req({ quote: quote(300_000) }))

  const usage = led.usage({ requestId: 'req-1', taskRef: 'task-1' })
  const budget = budgetFromLedger(usage, { limitsMicro, currency: 'USD' })
  assert.equal(budget.spendKnown.taskUsd, true)
  assert.equal(budget.spendSource.dailyUsd, 'ledger')
  assert.equal(budget.spent.taskUsd, 0.3, '300000 micro = 0.3 USD，边界只除一次 1e6')
  assert.equal(budget.spent.dailyUsd, 0.3)

  const cand = {
    model: 'mg/a/chat',
    provider: 'p1',
    authorized: true,
    capability: 'chat',
    modalities: ['text'],
    tools: { types: ['function'], hosted: [] },
    estimatedCostUsd: 0.001,
    health: { state: 'closed' },
  }
  const request = { now: NOW, capability: 'chat', modalities: ['text'], tools: ['function'] }
  const allowed = decide(request, [cand], null, null, budget)
  assert.equal(allowed.action, ACTION.CONTINUE)
  assert.equal(allowed.audit.costGate.spendSource.taskUsd, 'ledger')
  assert.equal(allowed.audit.costGate.unit, 'usd')

  // 账本花到上限后：决策器按"预算耗尽"停机，而不是悄悄换更便宜的候选。
  await led.settle(a.attemptId, { actualMicro: 1_000_000, currency: 'USD' })
  const budget2 = budgetFromLedger(led.usage({ requestId: 'req-1', taskRef: 'task-1' }), { limitsMicro, currency: 'USD' })
  const stopped = decide(request, [cand], null, null, budget2)
  assert.equal(stopped.action, ACTION.STOP)
  assert.equal(stopped.code, STOP.BUDGET)
  // 口径命名：账本用 request/task/day，决策器输出用 request/task/daily（adapter 负责映射）。
  assert.equal(stopped.budget.exceededBy, 'daily')

  // micro 形式的 budget 直接给决策器：边界只换算一次，不得被当成美元。
  const cheap = Object.assign({}, cand, { estimatedCostUsd: 0.2 })
  const microBudget = {
    unit: 'micro',
    limits: { requestUsd: 500_000 },
    spent: { requestUsd: 200_000 },
  }
  const fits = decide({ now: NOW }, [cheap], null, null, microBudget)
  assert.equal(fits.action, ACTION.CONTINUE)
  assert.equal(fits.audit.costGate.unit, 'micro')
  const capped = decide({ now: NOW }, [cheap], null, null, Object.assign({}, microBudget, { spent: { requestUsd: 400_000 } }))
  assert.equal(capped.excluded[0].reasons[0], 'budget_exceeded')
  assert.equal(capped.action, ACTION.STOP)

  // 适配器拒绝跨币种与错误单位（绝不隐式换算）。
  assert.throws(() => budgetFromLedger(usage, { currency: 'EUR' }), (e) => e.code === 'FACT_BUDGET_CURRENCY_MISMATCH')
  assert.throws(() => budgetFromLedger(Object.assign({}, usage, { unit: 'usd' })), (e) => e.code === 'FACT_BUDGET_UNIT_MISMATCH')
})
