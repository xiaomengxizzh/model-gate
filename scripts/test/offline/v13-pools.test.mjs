import test from 'node:test'
import assert from 'node:assert/strict'
import { publicPool, poolImpact, planPool } from '../../../src/resources/pools.js'

function cfg() {
  return {
    configVersion: 7,
    providers: { alpha: { baseUrl: 'https://alpha.example.test/v1' }, beta: { baseUrl: 'https://beta.example.test/v1' } },
    models: {
      m1: { provider: 'alpha', alias: ['one'] },
      m2: { provider: 'beta' },
    },
    defaults: { model: 'auto' },
    virtualModels: [{
      name: 'legacy',
      directory: [{ model: 'm1', mode: 'onFail', providers: ['alpha'], vendorEntry: { keep: true } }],
      quota: 3,
      note: '旧池备注',
      expiresAt: '2099-01-01T00:00:00.000Z',
      vendorExtension: { keep: ['unknown', 'fields'] },
    }],
  }
}

function createBody(overrides = {}) {
  return {
    action: 'pool.create',
    expectedVersion: 7,
    requestId: 'create-pool',
    patch: {
      name: '研发池',
      selection: 'weighted',
      recoveryPolicyRef: 'policy-default',
      members: [
        { modelId: 'm1', providerId: 'alpha', priority: 0, weight: 30, enabled: true, constraints: { maxContext: 32000 } },
        { model: 'm2', priority: 1, weight: 70, enabled: false, constraints: { roles: ['child'] } },
      ],
    },
    ...overrides,
  }
}

function createdConfig(base = cfg()) {
  const result = planPool(base, createBody(), { now: 1000 })
  assert.equal(result.status, 200)
  return { base, result, pool: result.plan.payload.virtualModels.at(-1) }
}

test('V13.1 池：创建预览生成稳定 ID/slug、完整字段与既有 directory 投影', () => {
  const base = cfg()
  const snapshot = structuredClone(base)
  const { result, pool } = createdConfig(base)
  const plan = result.plan

  assert.match(pool.poolId, /^pool_[A-Za-z0-9_-]{16,64}$/)
  assert.equal(pool.slug, 'mg-pool-' + pool.poolId.slice('pool_'.length))
  assert.equal(pool.name, '研发池')
  assert.equal(pool.enabled, true)
  assert.equal(pool.selection, 'weighted')
  assert.equal(pool.recoveryPolicyRef, 'policy-default')
  assert.equal(pool.revision, 1)
  assert.equal(plan.expectedVersion, 7)
  assert.equal(plan.requestId, 'create-pool')
  assert.equal(plan.expiresAt, new Date(301000).toISOString())
  assert.deepEqual(Object.keys(plan.payload).sort(), ['expectedVersion', 'virtualModels'])
  assert.equal(plan.payload.virtualModels.length, 2)
  assert.deepEqual(plan.payload.virtualModels[0], base.virtualModels[0])
  assert.deepEqual(pool.directory, [
    { model: 'm1', mode: 'afterAll', enabled: true, providers: ['alpha'] },
    { model: 'm2', mode: 'afterAll', enabled: false, providers: ['beta'] },
  ])
  assert.deepEqual(pool.members[0], {
    poolId: pool.poolId, modelId: 'm1', model: 'm1', providerId: 'alpha',
    priority: 0, weight: 30, enabled: true, constraints: { maxContext: 32000 },
  })
  assert.deepEqual(pool.members[1], {
    poolId: pool.poolId, modelId: 'm2', model: 'm2', providerId: 'beta',
    priority: 1, weight: 70, enabled: false, constraints: { roles: ['child'] },
  })
  assert.deepEqual(publicPool(pool, base), plan.after)
  assert.deepEqual(base, snapshot, '预览不得修改输入配置')
})

test('V13.1 池：更新保持 poolId/slug、递增 revision 并保留池与 directory 未知字段', () => {
  const { base, pool } = createdConfig()
  pool.vendorExtension = { untouched: true }
  pool.directory[0].vendorEntry = { untouched: true }
  const next = { ...base, configVersion: 8, virtualModels: [base.virtualModels[0], pool] }
  const result = planPool(next, {
    action: 'pool.update', expectedVersion: 8, requestId: 'update-pool', poolId: pool.poolId,
    patch: {
      name: '研发池（新）', selection: 'round_robin',
      members: [
        { modelId: 'm1', providerId: 'alpha', priority: 2, enabled: true },
        { modelId: 'm2', providerId: 'beta', priority: 1, enabled: true },
      ],
    },
  })
  assert.equal(result.status, 200)
  const after = result.plan.payload.virtualModels[1]
  assert.equal(after.poolId, pool.poolId)
  assert.equal(after.slug, pool.slug)
  assert.equal(after.revision, 2)
  assert.equal(after.name, '研发池（新）')
  assert.equal(after.selection, 'round_robin')
  assert.deepEqual(after.vendorExtension, { untouched: true })
  assert.deepEqual(after.directory[0].vendorEntry, { untouched: true })
  assert.deepEqual(after.members.map((member) => member.weight), [0, 0])
  assert.deepEqual(result.plan.payload.virtualModels[0], base.virtualModels[0])
})

test('V13.1 池：成员至少一个，空成员返回 422', () => {
  const result = planPool(cfg(), createBody({ patch: { name: '空池', selection: 'priority', members: [] } }))
  assert.equal(result.status, 422)
  assert.equal(result.code, 'pool_members_required')
})

test('V13.1 池：模型存在、provider 匹配、候选不重复', () => {
  const cases = [
    ['缺少模型', [{ priority: 0 }], /modelId 或 model/],
    ['未知模型', [{ modelId: 'missing', priority: 0 }], /模型不存在/],
    ['provider 不匹配', [{ modelId: 'm1', providerId: 'beta', priority: 0 }], /providerId 与模型 provider 不匹配/],
    ['provider 不存在', [{ modelId: 'm1', providerId: 'ghost', priority: 0 }], /providerId 与模型 provider 不匹配/],
    ['模型字段冲突', [{ modelId: 'm1', model: 'm2', priority: 0 }], /不一致/],
    ['重复候选', [{ modelId: 'm1', priority: 0 }, { model: 'm1', priority: 1 }], /成员重复/],
  ]
  for (const [label, members, message] of cases) {
    const result = planPool(cfg(), createBody({ patch: { name: label, selection: 'priority', members } }))
    assert.equal(result.status, 400, label)
    assert.match(result.error, message, label)
  }
})

test('V13.1 池：weighted 权重严格为 1..100，其他选择不允许非零权重', () => {
  for (const weight of [undefined, 0, 101, 1.5, '50']) {
    const member = { modelId: 'm1', priority: 0 }
    if (weight !== undefined) member.weight = weight
    const result = planPool(cfg(), createBody({ patch: { name: '权重', selection: 'weighted', members: [member] } }))
    assert.equal(result.status, 400, 'weighted weight=' + weight)
    assert.match(result.error, /1\.\.100/)
  }
  for (const selection of ['priority', 'round_robin']) {
    const result = planPool(cfg(), createBody({ patch: { name: '非权重', selection, members: [{ modelId: 'm1', priority: 0, weight: 1 }] } }))
    assert.equal(result.status, 400, selection)
    assert.match(result.error, /只有 weighted/)
  }
  const boundary = planPool(cfg(), createBody({ patch: {
    name: '权重边界', selection: 'weighted',
    members: [{ modelId: 'm1', priority: 0, weight: 1 }, { modelId: 'm2', priority: 1, weight: 100 }],
  } }))
  assert.equal(boundary.status, 200)
  assert.deepEqual(boundary.plan.after.members.map((member) => member.weight), [1, 100])
})

test('V13.1 池：priority 非负整数，enabled/constraints 类型严格', () => {
  const cases = [
    [{ modelId: 'm1', priority: -1 }, /priority/],
    [{ modelId: 'm1', priority: 1.5 }, /priority/],
    [{ modelId: 'm1', priority: '0' }, /priority/],
    [{ modelId: 'm1', priority: 0, enabled: 'yes' }, /enabled/],
    [{ modelId: 'm1', priority: 0, constraints: [] }, /constraints/],
  ]
  for (const [member, message] of cases) {
    const result = planPool(cfg(), createBody({ patch: { name: '成员类型', selection: 'priority', members: [member] } }))
    assert.equal(result.status, 400)
    assert.match(result.error, message)
  }
})

test('V13.1 池：版本、requestId、动作与名称冲突校验', () => {
  const stale = planPool(cfg(), createBody({ expectedVersion: 6 }))
  assert.equal(stale.status, 409)
  assert.equal(stale.code, 'version_conflict')
  assert.equal(stale.details.currentVersion, 7)
  assert.equal(planPool(cfg(), createBody({ requestId: ' ' })).status, 400)
  assert.equal(planPool(cfg(), createBody({ action: 'pool.unknown' })).status, 400)
  assert.equal(planPool(cfg(), createBody({ action: 'pool.update', poolId: 'missing', patch: {} })).status, 404)
  assert.equal(planPool(cfg(), createBody({ patch: { ...createBody().patch, unknown: true } })).status, 400)
  for (const name of ['m1', 'one', 'auto', 'legacy', '__proto__']) {
    const result = planPool(cfg(), createBody({ patch: { ...createBody().patch, name } }))
    assert.equal(result.status, 400, name)
  }
})

test('V13.1 池：Codex 与应用 roleTargets 引用阻止删除并返回 422', () => {
  const { base, pool } = createdConfig()
  const referenced = {
    ...base,
    virtualModels: [base.virtualModels[0], pool],
    _codexCatalog: { bindings: { [pool.slug]: { slug: pool.slug, poolId: pool.poolId } } },
    harnessBindings: {
      desktop: { harnessId: 'codex', instanceId: 'main', roleTargets: { child: { kind: 'pool', id: pool.poolId } } },
    },
  }
  const impact = poolImpact(referenced, pool.poolId)
  assert.deepEqual(impact.codexBindings, [pool.slug])
  assert.deepEqual(impact.harnessBindings, ['codex:main'])
  assert.equal(impact.inFlight.state, 'unknown')
  assert.match(impact.inFlight.note, /在途请求数量未知/)
  const result = planPool(referenced, { action: 'pool.delete', expectedVersion: 7, requestId: 'delete-referenced', poolId: pool.poolId })
  assert.equal(result.status, 422)
  assert.equal(result.code, 'pool_referenced')
  assert.deepEqual(result.details, impact)
})

test('V13.1 池：数组形态应用引用同样阻止删除', () => {
  const { base, pool } = createdConfig()
  const referenced = {
    ...base,
    virtualModels: [base.virtualModels[0], pool],
    harnessBindings: [{ harnessId: 'other', instanceId: 'one', roleTargets: { route: { kind: 'pool', id: pool.slug } } }],
  }
  const result = planPool(referenced, { action: 'pool.delete', expectedVersion: 7, requestId: 'delete-array-ref', poolId: pool.poolId })
  assert.equal(result.status, 422)
  assert.deepEqual(result.details.harnessBindings, ['other:one'])
})

test('V13.1 池：无引用删除只移除目标池并明确在途状态未知', () => {
  const { base, pool } = createdConfig()
  const next = { ...base, virtualModels: [base.virtualModels[0], pool] }
  const result = planPool(next, { action: 'pool.delete', expectedVersion: 7, requestId: 'delete-pool', poolId: pool.poolId })
  assert.equal(result.status, 200)
  assert.equal(result.plan.after, null)
  assert.deepEqual(result.plan.payload, { expectedVersion: 7, virtualModels: [base.virtualModels[0]] })
  assert.equal(result.plan.impact.inFlight.state, 'unknown')
  assert.match(result.plan.impact.inFlight.note, /不取消已启动请求/)
})

test('V13.1 池：旧 virtualModels 只读投影兼容，首次更新迁移稳定标识且不丢未知字段', () => {
  const base = cfg()
  const legacy = base.virtualModels[0]
  const projected = publicPool(legacy, base)
  assert.deepEqual(projected, {
    poolId: null,
    slug: 'legacy',
    name: 'legacy',
    enabled: true,
    selection: 'priority',
    recoveryPolicyRef: '',
    revision: 0,
    members: [{ poolId: null, modelId: 'm1', model: 'm1', providerId: 'alpha', priority: 0, weight: 0, enabled: true, constraints: {} }],
  })
  const result = planPool(base, { action: 'pool.update', expectedVersion: 7, requestId: 'migrate-legacy', poolId: 'legacy', patch: { enabled: false } })
  assert.equal(result.status, 200)
  const after = result.plan.payload.virtualModels[0]
  assert.match(after.poolId, /^pool_/)
  assert.equal(after.slug, 'mg-pool-' + after.poolId.slice('pool_'.length))
  assert.equal(after.revision, 1)
  assert.equal(after.enabled, false)
  assert.deepEqual(after.directory, legacy.directory)
  assert.deepEqual(after.vendorExtension, legacy.vendorExtension)
  assert.equal(after.note, legacy.note)
  assert.equal(after.expiresAt, legacy.expiresAt)
  assert.equal(after.quota, 3)
})

test('V13.1 池：legacy directory 可作为成员输入，未知目录字段保留', () => {
  const result = planPool(cfg(), createBody({ patch: {
    name: '目录兼容', selection: 'priority',
    directory: [{ model: 'm1', mode: 'onFail', providers: ['alpha'], priority: 4, vendorEntry: { keep: true } }],
  } }))
  assert.equal(result.status, 200)
  const pool = result.plan.payload.virtualModels.at(-1)
  assert.equal(pool.members[0].priority, 4)
  assert.deepEqual(pool.directory[0], { model: 'm1', mode: 'onFail', providers: ['alpha'], priority: 4, vendorEntry: { keep: true }, enabled: true })
})
