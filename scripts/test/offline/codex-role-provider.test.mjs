// P01: Codex 0.167.0 role/provider boundary — synthetic negative fixture.
// Scope: pure offline checks. No CLI execution, no network, no credential or HOME access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  FIXTURE_VERSION,
  PROVIDER_SOURCE,
  ROLE_PROVIDER_FIELD,
  parseSyntheticRolesConfig,
  resolveChild,
} from '../fixtures/codex/role-provider-0.167.0.mjs'

const fixtureDir = new URL('../fixtures/codex/', import.meta.url)
const matrixPath = new URL('role-provider-matrix.json', fixtureDir)
const tomlPath = new URL('roles/0.167.0-negative.toml', fixtureDir)
const modulePath = fileURLToPath(new URL('role-provider-0.167.0.mjs', fixtureDir))
const adrPath = new URL('../../../../docs/explanation/adr-0003-codex-role-provider-boundary.md', fixtureDir)

function readMatrix() {
  return JSON.parse(readFileSync(matrixPath, 'utf8'))
}

test('P01 fixture version is locked to Codex 0.167.0', () => {
  const matrix = readMatrix()
  assert.equal(FIXTURE_VERSION, '0.167.0-linux-x64')
  assert.equal(matrix.codexVersion, FIXTURE_VERSION)
  assert.equal(matrix.schema, 'mg.codex.role-provider-matrix/v1')
})

test('P01 matrix contains exactly the four required configurations', () => {
  const matrix = readMatrix()
  const ids = matrix.matrix.map((row) => row.id)
  assert.deepEqual(new Set(ids), new Set(['official-direct', 'mock-dual-provider', 'same-provider', 'siwc-preview']))
  assert.equal(ids.length, 4)
})

test('P01 no matrix row lets a role change the provider', () => {
  const matrix = readMatrix()
  for (const row of matrix.matrix) {
    assert.equal(row.expected.provider, row.parent.provider, row.id + ': provider must be inherited')
    assert.equal(row.expected.providerChanged, false, row.id + ': providerChanged must stay false')
  }
})

test('P01 dual-provider row is a real negative fixture', () => {
  const matrix = readMatrix()
  const row = matrix.matrix.find((entry) => entry.id === 'mock-dual-provider')
  assert.ok(row)
  assert.equal(row.parent.provider, 'probe-a')
  assert.equal(row.role.model_provider, 'probe-b')
  assert.notEqual(row.role.model_provider, row.parent.provider)
  assert.equal(row.expected.provider, 'probe-a')
  assert.ok(row.evidence.includes('SYNTHETIC_FIXTURE'))
})

test('P01 evidence stays honest: no live/verified claim, source and execution marked unknown/blocked', () => {
  const matrix = readMatrix()
  assert.match(matrix.provenance.sourceVerification, /^UNKNOWN_PRIMARY_SOURCE:/)
  assert.match(matrix.provenance.localExecution, /^BLOCKED_ENV:/)
  assert.equal(matrix.provenance.network, 'none')
  for (const row of matrix.matrix) {
    for (const evidence of row.evidence) {
      assert.doesNotMatch(evidence, /LIVE|VERIFIED|PASS/, row.id + ': evidence must not claim a live result')
      assert.ok(Object.prototype.hasOwnProperty.call(matrix.evidenceLegend, evidence), 'unknown evidence label: ' + evidence)
    }
    assert.ok(Object.prototype.hasOwnProperty.call(matrix.statusLegend, row.status), 'unknown status label: ' + row.status)
  }
})

test('P01 resolver inherits the parent provider and ignores a role model_provider', () => {
  const result = resolveChild({
    parentProvider: 'probe-a',
    parentModel: 'root-model',
    role: { model_provider: 'probe-b', model: 'child-model' },
  })
  assert.equal(PROVIDER_SOURCE, 'parent_turn')
  assert.equal(result.provider, 'probe-a')
  assert.equal(result.model, 'child-model')
  assert.equal(result.ignored[ROLE_PROVIDER_FIELD], 'probe-b')
  assert.deepEqual(result.applied, { model: 'child-model' })
  assert.ok(result.diagnostics.includes('role_model_provider_not_applied'))
})

test('P01 same-provider model override works without moving the provider', () => {
  const result = resolveChild({
    parentProvider: 'probe-a',
    parentModel: 'root-model',
    role: { model_provider: 'probe-a', model: 'child-model' },
  })
  assert.equal(result.provider, 'probe-a')
  assert.equal(result.model, 'child-model')
  assert.ok(result.diagnostics.includes('role_model_provider_not_applied'))
})

test('P01 unknown role fields are reported, not applied, and inputs are not mutated', () => {
  const role = { model_provider: 'probe-b', model: 'child-model', approval_policy: 'never' }
  const snapshot = JSON.stringify(role)
  const result = resolveChild({ parentProvider: 'probe-a', parentModel: 'root-model', role })
  assert.equal(result.provider, 'probe-a')
  assert.equal(result.applied.approval_policy, undefined)
  assert.equal(result.ignored.approval_policy, 'never')
  assert.ok(result.diagnostics.includes('role_field_unknown:approval_policy'))
  assert.equal(JSON.stringify(role), snapshot, 'resolver must not mutate the role')
})

test('P01 missing parent provider fails closed instead of inventing one', () => {
  const result = resolveChild({ parentProvider: '', role: { model_provider: 'probe-b' } })
  assert.equal(result.provider, null)
  assert.deepEqual(result.diagnostics, ['parent_provider_missing'])
})

test('P01 isolated config parser reads the negative role fixture', () => {
  const parsed = parseSyntheticRolesConfig(readFileSync(tomlPath, 'utf8'))
  assert.equal(parsed.topLevel.model_provider, 'probe-a')
  assert.equal(parsed.topLevel.model, 'root-model')
  const role = parsed.sections['profiles.role-switch-attempt']
  assert.equal(role.model_provider, 'probe-b')
  const resolved = resolveChild({
    parentProvider: parsed.topLevel.model_provider,
    parentModel: parsed.topLevel.model,
    role,
  })
  assert.equal(resolved.provider, 'probe-a')
  assert.equal(resolved.model, 'child-model')
  assert.ok(resolved.diagnostics.includes('role_model_provider_not_applied'))
})

test('P01 restricted parser refuses syntax it does not model', () => {
  assert.throws(() => parseSyntheticRolesConfig('model_provider = probe-b'), /unsupported value/)
  assert.throws(() => parseSyntheticRolesConfig('<>'), /unsupported config line/)
})

test('P01 fixture module has no IO, network, environment, or credential access', () => {
  const source = readFileSync(modulePath, 'utf8')
  assert.doesNotMatch(source, /from\s+['"]node:(fs|os|http|https|net|tls|dns|child_process|crypto)['"]/)
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/)
  assert.doesNotMatch(source, /process\.env|os\.homedir|auth\.json/)
})

test('P01 fixtures contain no host-absolute path or secret-like token', () => {
  for (const path of [matrixPath, tomlPath, new URL('role-provider-0.167.0.mjs', fixtureDir)]) {
    const text = readFileSync(path, 'utf8')
    assert.doesNotMatch(text, /\/home\/|\/Users\/|[A-Za-z]:\\/, 'host-absolute path in ' + path.pathname)
    assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{8,}/, 'secret-like token in ' + path.pathname)
  }
})

test('P01 stop conditions forbid decryption, ciphertext deletion, and v1 downgrade', () => {
  const matrix = readMatrix()
  const text = matrix.stopConditions.join('\n')
  assert.match(text, /reject before any upstream request/)
  assert.match(text, /decrypting/i)
  assert.match(text, /silently downgrading to v1/)
})

test('P01 ADR records the boundary, four-row matrix, and UNKNOWN/BLOCKED evidence levels', () => {
  const adr = readFileSync(adrPath, 'utf8')
  assert.match(adr, /0\.167\.0/)
  assert.match(adr, /model_provider/)
  assert.match(adr, /UNKNOWN_PRIMARY_SOURCE/)
  assert.match(adr, /BLOCKED_ENV/)
  for (const id of ['official-direct', 'mock-dual-provider', 'same-provider', 'siwc-preview']) {
    assert.match(adr, new RegExp(id))
  }
})
