// P05: 真实 CLI 的离线 V2 夹具清单 + 纯 mock 生命周期。
// 不执行 Codex、不联网；真实执行归 Q02（OS 级出网隔离，本机 BLOCKED_ENV）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLifecycleMock } from '../fixtures/codex/v2-lifecycle-mock.mjs'

const manifestPath = new URL('../fixtures/codex/v2-lifecycle-manifest.json', import.meta.url)
const rolePath = new URL('../fixtures/codex/roles/0.167.0-negative.toml', import.meta.url)
const mockPath = new URL('../fixtures/codex/v2-lifecycle-mock.mjs', import.meta.url)
const e2ePath = new URL('../codex-e2e.mjs', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const REQUIRED_CASES = [
  'tool_nonce', 'wait_agent', 'followup_task', 'send_message', 'cancel',
  'permission_deny', 'permission_allow', 'resume_cold', 'fork_turns_none',
  'fork_turns_all', 'concurrency_limit', 'parent_child_ids', 'zero_egress',
]

function runE2E(args) {
  return spawnSync(process.execPath, [fileURLToPath(e2ePath), ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: Object.assign({}, process.env, { MGR_E2E_NETWORK_ISOLATED: '' }),
  })
}

function setup(over = {}) {
  const mock = createLifecycleMock(over)
  const root = mock.openRoot({ rootId: 'root-synthetic-1' })
  assert.equal(root.ok, true)
  return mock
}

test('P05 清单锁定 Codex 0.167.0，且 13 个生命周期 case 齐全', () => {
  assert.equal(manifest.schema, 'mg.codex.v2-lifecycle-manifest/v1')
  assert.equal(manifest.codexVersion, '0.167.0')
  const ids = manifest.cases.map((c) => c.id)
  assert.deepEqual(new Set(ids), new Set(REQUIRED_CASES))
  assert.equal(ids.length, REQUIRED_CASES.length)
  for (const c of manifest.cases) {
    assert.equal(c.status, 'FIXTURE_PREPARED')
    assert.match(c.requires, /Q02/)
    assert.equal(typeof c.assert, 'string')
    assert.doesNotMatch(String(c.status), /PASS|VERIFIED|LIVE/i)
  }
})

test('P05 清单不声称真实执行通过；隔离边界写明 BLOCKED_ENV / Q02', () => {
  assert.match(manifest.isolation.current, /^BLOCKED_ENV:/)
  assert.equal(manifest.isolation.executionOwner, 'Q02')
  assert.equal(manifest.isolation.optInEnv, 'MGR_E2E_NETWORK_ISOLATED=1')
  assert.equal(manifest.isolation.v2OptInEnv, 'MG_CODEX_V2=1')
  assert.ok(manifest.notes.some((n) => /does not run Codex and does not claim PASS/.test(n)))
})

test('P05 22/27 第 2 轮 502 candidate-pool 回归已登记', () => {
  const r = manifest.regressions.find((x) => x.id === 'm2-3-round2-502-candidate-pool')
  assert.ok(r)
  assert.equal(r.status, 'REGRESSION_DECLARED')
  assert.match(r.historical, /22\/27/)
  assert.match(r.historical, /502 candidate pool/)
  assert.match(r.assert, /must not return 502/)
  const source = readFileSync(e2ePath, 'utf8')
  assert.match(source, /第2轮：无历史 502 candidate-pool 回归/)
  assert.match(source, /LOCKED_CODEX_VERSION = '0\.167\.0'/)
})

test('P05 角色配置夹具存在，且只表达同 provider model override + 反向 model_provider', () => {
  const roleText = readFileSync(rolePath, 'utf8')
  assert.match(roleText, /\[profiles\.role-switch-attempt\]/)
  assert.match(roleText, /model_provider = "probe-b"/)
  assert.match(manifest.roleExpectation, /role model_provider must not change the provider/)
  assert.match(manifest.roleFixture, /0\.167\.0-negative\.toml/)
})

test('P05 e2e --list 与 manifest 一致；--check-manifest 全 PASS；默认仍 exit 2 拒跑', () => {
  const listed = runE2E(['--list'])
  assert.equal(listed.status, 0, listed.stderr)
  const payload = JSON.parse(listed.stdout)
  assert.equal(payload.codexVersion, '0.167.0')
  assert.deepEqual(payload.cases.map((c) => c.id), manifest.cases.map((c) => c.id))
  assert.deepEqual(payload.regressions.map((r) => r.id), manifest.regressions.map((r) => r.id))

  const checked = runE2E(['--check-manifest'])
  assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  assert.match(checked.stdout, /PASS  manifest schema\/version 锁定/)
  assert.match(checked.stdout, /PASS  22\/27 502 回归已声明/)

  const gated = runE2E([])
  assert.equal(gated.status, 2)
  assert.match(gated.stderr, /NOT_RUN: real codex-cli/)
})

test('P05 生命周期 mock：nonce 从 child 工具回到 parent wait；wait 前不伪造完成', () => {
  const m = setup()
  const spawned = m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/worker', message: 'do the task' })
  assert.equal(spawned.ok, true)
  assert.match(spawned.nonce, /^nonce-/)
  const early = m.wait({ taskName: '/root/worker' })
  assert.equal(early.timed_out, true, 'child 未完成时 wait 必须超时，不得伪造通知')
  const ran = m.runChild({ taskName: '/root/worker', approval: 'allow' })
  assert.equal(ran.nonce, spawned.nonce)
  assert.match(ran.output, new RegExp(spawned.nonce))
  const done = m.wait({ taskName: '/root/worker' })
  assert.equal(done.timed_out, false)
  assert.match(done.notification.text, new RegExp(spawned.nonce))
  assert.equal(done.notification.author, '/root/worker')
  assert.equal(done.notification.recipient, '/root')
})

test('P05 生命周期 mock：followup_task 生成新 nonce 并触发下一轮', () => {
  const m = setup()
  m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/worker', message: 'first' })
  const first = m.runChild({ taskName: '/root/worker', approval: 'allow' })
  const follow = m.followup({ taskName: '/root/worker', message: 'again' })
  assert.equal(follow.ok, true)
  assert.equal(follow.previous_nonce, first.nonce)
  assert.notEqual(follow.nonce, first.nonce)
  assert.equal(follow.turn, 2)
  const done = m.wait({ taskName: '/root/worker' })
  assert.match(done.notification.text, new RegExp(follow.nonce))
})

test('P05 生命周期 mock：send_message 走明文投影；cancel 后不再 followup/wait 成功', () => {
  const m = setup()
  m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/worker', message: 'first' })
  const sent = m.sendMessage({ taskName: '/root/worker', message: 'hello' })
  assert.equal(sent.ok, true)
  assert.deepEqual(sent.projected, { type: 'message', role: 'user' })
  m.cancel({ taskName: '/root/worker' })
  assert.equal(m.followup({ taskName: '/root/worker' }).error, 'agent_canceled')
  assert.equal(m.wait({ taskName: '/root/worker' }).error, 'agent_canceled')
  assert.equal(m.snapshot({ rootId: 'root-synthetic-1', taskName: '/root/worker' }).child.state, 'canceled')
})

test('P05 生命周期 mock：权限拒绝零执行；允许后执行一次', () => {
  const m = setup()
  m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/worker', message: 'task' })
  const denied = m.permission({ taskName: '/root/worker', policy: 'deny' })
  assert.equal(denied.allowed, false)
  const blocked = m.runChild({ taskName: '/root/worker', approval: 'deny' })
  assert.equal(blocked.error, 'permission_denied')
  assert.equal(m.snapshot({ rootId: 'root-synthetic-1', taskName: '/root/worker' }).child.state, 'pending')
  const allowed = m.permission({ taskName: '/root/worker', policy: 'allow' })
  assert.equal(allowed.allowed, true)
  assert.equal(m.runChild({ taskName: '/root/worker', approval: 'allow' }).ok, true)
  assert.equal(m.runChild({ taskName: '/root/worker', approval: 'allow' }).turn, 2, 'allow 后再次调用代表下一轮，mock 不伪造并发')
})

test('P05 生命周期 mock：fork_turns none/all 历史边界', () => {
  const none = setup()
  const n = none.spawn({ rootId: 'root-synthetic-1', taskName: '/root/none', fork_turns: 'none' })
  assert.equal(n.fork_turns, 'none')
  assert.equal(n.historyLength, 0)
  const all = setup()
  const a = all.spawn({ rootId: 'root-synthetic-1', taskName: '/root/all', fork_turns: 'all' })
  assert.equal(a.fork_turns, 'all')
  assert.ok(a.historyLength >= 1)
})

test('P05 生命周期 mock：并发上限与 parent/child identity', () => {
  const m = setup({ maxChildren: 2 })
  const a = m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/a' })
  const b = m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/b' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  const c = m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/c' })
  assert.equal(c.error, 'agent_limit_reached')
  const snap = m.snapshot({ rootId: 'root-synthetic-1' })
  assert.equal(snap.rootId, 'root-synthetic-1')
  assert.deepEqual(snap.childNames, ['/root/a', '/root/b'])
  assert.notEqual(snap.rootId, snap.childNames[0])
})

test('P05 生命周期 mock：resume 返回同一 root/child/history；未知会话显式失败', () => {
  const m = setup()
  m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/worker' })
  m.runChild({ taskName: '/root/worker', approval: 'allow' })
  const r = m.resume({ rootId: 'root-synthetic-1' })
  assert.equal(r.ok, true)
  assert.equal(r.rootId, 'root-synthetic-1')
  assert.deepEqual(r.children, ['/root/worker'])
  assert.ok(r.historyLength >= 2)
  assert.equal(m.resume({ rootId: 'missing' }).error, 'session_not_found')
})

test('P05 生命周期 mock：role 的 model_provider 不改变 provider（P01 边界）', () => {
  const m = setup()
  const s = m.spawn({ rootId: 'root-synthetic-1', taskName: '/root/worker', role: { model_provider: 'other', model: 'child-model' } })
  assert.equal(s.provider, 'mg')
  assert.ok(s.roleDiagnostics.includes('role_model_provider_not_applied'))
  const snap = m.snapshot({ rootId: 'root-synthetic-1', taskName: '/root/worker' })
  assert.equal(snap.child.provider, 'mg')
  assert.equal(snap.child.model, 'child-model')
})

test('P05 fixture 静态边界：无网络/CLI/真实端点', () => {
  const sources = [readFileSync(mockPath, 'utf8'), readFileSync(manifestPath, 'utf8')]
  for (const source of sources) {
    assert.doesNotMatch(source, /from\s+['"]node:(http|https|net|tls|dns|child_process)['"]/)
    assert.doesNotMatch(source, /api\.openai\.com|chatgpt\.com/)
  }
  assert.doesNotMatch(readFileSync(mockPath, 'utf8'), /\bfetch\s*\(|createServer\s*\(|listen\s*\(/)
})
