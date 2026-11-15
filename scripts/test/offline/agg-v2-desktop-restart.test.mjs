// V2-01 / A3：重启提示状态机（离线契约）。
// 写入后必须提示"完全退出并重开原版 Codex Desktop"；客户端在写入后启动过则自动消除提示。
// 本测试注入 clientProbe，不读取/影响真实运行中的 Codex 进程。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activate,
  computeRestartState,
  detect,
  preview,
  status,
} from '../../../src/codex/desktop-integration.js'

const MODEL = 'mg-opencodego-deepseek-v4-1-flash'
const CATALOG = JSON.stringify({ models: [{ slug: MODEL }] })
const USER_CONFIG = 'model = "gpt-5"\nmodel_provider = "openai"\n'

async function fixture () {
  const dir = await mkdtemp(join(tmpdir(), 'mg-v2-restart-'))
  const configPath = join(dir, 'config.toml')
  const catalogPath = join(dir, 'catalog.json')
  await writeFile(configPath, USER_CONFIG)
  await writeFile(catalogPath, CATALOG)
  const opts = {
    configPath,
    baseUrl: 'http://127.0.0.1:18787',
    model: MODEL,
    catalogPath,
    disableExec: true,
    clientProbe: false,
    verifyGateway: async () => ({ ok: true, status: 200, ms: 1 }),
  }
  return { dir, configPath, catalogPath, opts, cleanup: async () => { await rm(dir, { recursive: true, force: true }) } }
}

function withProbe (f, probe) {
  return Object.assign({}, f.opts, { clientProbe: probe })
}

test('重启状态机：只有聚合模式才可能要求重启，未验证/未运行/旧进程分别给出可归因原因', () => {
  const now = 1_700_000_000_000
  assert.equal(computeRestartState({ mode: 'official', now }).needed, false)
  assert.equal(computeRestartState({ mode: 'official', now }).reason, 'not_aggregated')

  const unknown = computeRestartState({ mode: 'aggregated', appliedAt: now, client: { running: null, source: 'proc_unavailable' }, now })
  assert.equal(unknown.needed, true)
  assert.equal(unknown.reason, 'client_restart_unverified')

  const closed = computeRestartState({ mode: 'aggregated', appliedAt: now, client: { running: false, source: 'proc' }, now })
  assert.equal(closed.needed, true)
  assert.equal(closed.reason, 'client_not_running')

  const old = computeRestartState({ mode: 'aggregated', appliedAt: now, client: { running: true, startedAt: now - 60_000, source: 'proc' }, now })
  assert.equal(old.needed, true)
  assert.equal(old.reason, 'client_running_with_old_config')

  const restarted = computeRestartState({ mode: 'aggregated', appliedAt: now, client: { running: true, startedAt: now + 1_000, source: 'proc' }, now })
  assert.equal(restarted.needed, false)
  assert.equal(restarted.reason, 'client_restarted_after_apply')
  assert.equal(restarted.appliedAt, now)
  assert.equal(restarted.client.startedAt, now + 1_000)

  assert.equal(computeRestartState({ mode: 'aggregated', appliedAt: null, client: { running: true, startedAt: now } }).reason, 'applied_at_unknown')
})

test('重启提示：激活后客户端仍在跑旧进程 → 明确要求重启一次；重启后自动消除', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(f.opts)
  // 激活时注入"客户端尚未重启"（进程启动早于写入）。
  const activated = await activate(Object.assign({}, withProbe(f, () => ({ running: true, startedAt: Date.now() - 600_000, source: 'injected' })), {
    consentToken: p.consentToken,
    expectedSha: p.expectedSha,
  }))
  assert.equal(activated.needsRestart, true)
  assert.equal(activated.restart.reason, 'client_running_with_old_config')
  const appliedAt = status({ configPath: f.configPath, clientProbe: false }).appliedAt
  assert.ok(appliedAt > 0)

  const running = status({ configPath: f.configPath, clientProbe: () => ({ running: true, startedAt: appliedAt - 1, source: 'injected' }) })
  assert.equal(running.mode, 'aggregated')
  assert.equal(running.needsRestart, true)
  assert.equal(running.restart.reason, 'client_running_with_old_config')

  // 用户在写入之后重启了 Desktop：进程启动时间晚于写入时间 → 提示自动消失。
  const restarted = status({ configPath: f.configPath, clientProbe: () => ({ running: true, startedAt: appliedAt + 5_000, source: 'injected' }) })
  assert.equal(restarted.needsRestart, false)
  assert.equal(restarted.restart.reason, 'client_restarted_after_apply')

  const detected = detect({ configPath: f.configPath, disableExec: true, clientProbe: () => ({ running: true, startedAt: appliedAt + 5_000, source: 'injected' }) })
  assert.equal(detected.needsRestart, false)
  assert.equal(detected.restart.reason, 'client_restarted_after_apply')
  assert.equal(detected.clientRuntime.startedAt, appliedAt + 5_000)
})

test('重启提示：客户端未运行时要求重开；探测失败时标未验证，不谎称已生效', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(f.opts)
  await activate(Object.assign({}, withProbe(f, () => ({ running: false, startedAt: null, source: 'injected' })), {
    consentToken: p.consentToken,
    expectedSha: p.expectedSha,
  }))
  const closed = status({ configPath: f.configPath, clientProbe: () => ({ running: false, startedAt: null, source: 'injected' }) })
  assert.equal(closed.needsRestart, true)
  assert.equal(closed.restart.reason, 'client_not_running')

  const unverified = status({ configPath: f.configPath, clientProbe: () => { throw new Error('proc unavailable') } })
  assert.equal(unverified.needsRestart, true)
  assert.equal(unverified.restart.reason, 'client_restart_unverified')
  assert.equal(unverified.clientRuntime.source, 'probe_failed')
})

test('重启提示：退出聚合后不再要求重启', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const p = preview(f.opts)
  const activated = await activate(Object.assign({}, withProbe(f, () => ({ running: false, source: 'injected' })), {
    consentToken: p.consentToken,
    expectedSha: p.expectedSha,
  }))
  const { deactivate } = await import('../../../src/codex/desktop-integration.js')
  await deactivate({ configPath: f.configPath, expectedSha: activated.sha })
  const s = status({ configPath: f.configPath, clientProbe: () => ({ running: true, startedAt: Date.now(), source: 'injected' }) })
  assert.equal(s.mode, 'official')
  assert.equal(s.needsRestart, false)
  assert.equal(s.restart.reason, 'not_aggregated')
})
