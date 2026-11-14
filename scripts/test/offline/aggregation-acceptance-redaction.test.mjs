// A5 证据脱敏自证：证据里出现令牌形状或凭据文件绝对路径，门禁必须拒收。
//
// 说明：本套件里的令牌全部是合成串（不指向任何真实账户），只用于验证拒绝逻辑；
// 断言同时检查错误信息不回显命中值，避免“校验器自己把密钥写进日志”。
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGate, findSensitive, validateEvidence } from './aggregation-gate.js'
import { REQUIREMENT_IDS, TESTED_TREE_SHA, buildMatrix, loadSources } from './aggregation-matrix.js'

const { caseIndex } = buildMatrix(loadSources())

const SYNTHETIC = {
  jwt: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.signature-not-real',
  openai: 'sk-synthetic0000000000000000',
  github: 'ghp_synthetic0000000000000000000000000000',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  slack: 'xoxb-synthetic-0000000000',
  bearer: 'Bearer synthetic-0000000000000000000000',
}

test('令牌形状：JWT / OpenAI / GitHub / AWS / Slack / Bearer 全部命中', () => {
  for (const [kind, value] of Object.entries(SYNTHETIC)) {
    const hits = findSensitive({ note: value })
    assert.ok(hits.length > 0, 'expected ' + kind + ' to be detected')
    assert.equal(hits[0].path, '$.note')
    assert.notEqual(hits[0].kind, 'credential-path')
  }
})

test('凭据文件绝对路径：auth.json / .ssh / .aws / .netrc 的绝对路径全部命中', () => {
  const paths = [
    '/home/synthetic/.codex/auth.json',
    '~/.codex/auth.json',
    '$HOME/.codex/auth.json',
    '/root/.ssh/id_rsa',
    '/home/synthetic/.aws/credentials',
    '/home/synthetic/.netrc',
    'C:\\Users\\synthetic\\.codex\\auth.json',
  ]
  for (const p of paths) {
    const hits = findSensitive({ where: 'read ' + p })
    assert.ok(hits.some((h) => h.kind === 'credential-path'), 'expected credential path to be rejected: ' + p)
  }
})

test('正常证据不被误伤：仓库相对路径、SHA、模型 ID、普通说明都通过', () => {
  const clean = {
    commitSha: TESTED_TREE_SHA,
    command: 'node scripts/test/offline/aggregation-acceptance-gate.test.mjs',
    receipt: { traceId: 'trace-mg-r001-0001', model: 'gpt-6-luna', upstreamModelId: 'deepseek-v4.1-flash' },
    paths: ['docs/evidence/aggregation-acceptance-verdict-2026-11-14.md', 'scripts/test/offline/harness.mjs'],
    note: '前后 auth.json 只比较 mtime/size/sha256，不读取内容',
    catalog: { modelCount: 42, digest: 'e2068e6edbf76eee47db3c04556eb9ab60548556d6632f955af29269e74edc83' },
  }
  assert.deepEqual(findSensitive(clean), [])
})

test('validateEvidence 拒收含令牌的证据，且错误信息不回显命中值', () => {
  const record = {
    status: 'PASS_REAL',
    commitSha: TESTED_TREE_SHA,
    command: 'node scripts/test/codex-e2e.mjs',
    receipt: { traceId: 'trace-1', echoed: SYNTHETIC.jwt },
    realTarget: true,
    passedAllOnRealTarget: true,
    cases: Object.fromEntries(caseIndex['MG-R001'].map((c) => [c, { passed: true, skipped: false }])),
  }
  const verdict = validateEvidence(record, { requirement: 'MG-R001', cases: caseIndex['MG-R001'] })
  assert.equal(verdict.ok, false)
  const sensitive = verdict.errors.filter((e) => e.code === 'sensitive_value')
  assert.ok(sensitive.length > 0)
  const text = JSON.stringify(verdict)
  assert.equal(text.includes(SYNTHETIC.jwt), false, 'validator must not echo the secret')
  assert.ok(sensitive.some((e) => e.message.includes('$.receipt.echoed')))
})

test('含凭据绝对路径的回执同样拒收', () => {
  const record = {
    status: 'PASS_REAL',
    commitSha: TESTED_TREE_SHA,
    command: 'cat /home/synthetic/.codex/auth.json',
    receipt: { traceId: 'trace-2' },
    realTarget: true,
    passedAllOnRealTarget: true,
    cases: Object.fromEntries(caseIndex['MG-R002'].map((c) => [c, { passed: true, skipped: false }])),
  }
  const verdict = validateEvidence(record, { requirement: 'MG-R002', cases: caseIndex['MG-R002'] })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.errors.some((e) => e.code === 'sensitive_value' && e.message.includes('credential-path')))
})

test('门禁层面：含密钥的 PASS_REAL 只能是 invalid_evidence，不能放行', () => {
  const evidence = {}
  for (const id of REQUIREMENT_IDS) {
    evidence[id] = {
      status: 'PASS_REAL',
      commitSha: TESTED_TREE_SHA,
      command: 'node scripts/test/codex-e2e.mjs',
      receipt: { traceId: 'trace-' + id, leaked: id === 'MG-R009' ? SYNTHETIC.bearer : undefined },
      realTarget: true,
      passedAllOnRealTarget: true,
      cases: Object.fromEntries(caseIndex[id].map((c) => [c, { passed: true, skipped: false }])),
    }
  }
  const gate = evaluateGate({ evidence, ownerApproval: true, headSha: TESTED_TREE_SHA, caseIndex })
  assert.equal(gate.ready, false)
  assert.equal(gate.status, 'BLOCKED')
  assert.equal(gate.failedRequirement, 'MG-R009')
  assert.equal(gate.requirements.find((r) => r.id === 'MG-R009').reason, 'invalid_evidence')
  assert.equal(JSON.stringify(gate).includes(SYNTHETIC.bearer), false, 'gate output must not echo the secret')
})

test('脱敏检查覆盖嵌套结构与数组，不只顶层字符串', () => {
  const nested = { a: [{ b: [{ c: 'prefix ' + SYNTHETIC.openai }] }] }
  const hits = findSensitive(nested)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, '$.a[0].b[0].c')
})
