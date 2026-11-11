// M0-2 / T-KEY-01 + T-KEY-02：客户端 Key 三态、虚拟 Key 过期时间单一真源。
// 全部离线：本地 mock 上游 + OS 临时目录 + 动态回环端口；不访问 8787、不读取宿主凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startGateway, startMockUpstream } from './harness.mjs'
import {
  CLIENT_KEY_MASK,
  isValidClientKeyValue,
  isVirtualKeyExpired,
  parseVirtualExpiry,
  planClientKeyUpdate,
  planVirtualMetaUpdate,
  virtualExpiryProjection,
} from '../../../src/index.js'

const CHAT = { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }
const VM_CHAT = { model: 'vm-a', messages: [{ role: 'user', content: 'hi' }] }
const bearer = (key) => ({ authorization: 'Bearer ' + key })
const VM = [{ name: 'vm-a', directory: [{ model: 'demo' }] }]

async function boot (opts = {}) {
  const upstream = await startMockUpstream()
  const config = {
    providers: { mock: { baseUrl: upstream.base, apiKeyEnv: '' } },
    models: { demo: { provider: 'mock', api: 'openai' } },
    virtualModels: opts.virtualModels || [],
    defaults: Object.assign({
      retry: { maxAttempts: 1 },
      timeout: { firstByteMs: 2000, idleMs: 2000 },
      proxyMode: 'direct',
    }, opts.defaults || {}),
  }
  const gw = await startGateway({ name: 'key-tristate', env: opts.env || {}, config })
  return {
    gw,
    upstream,
    chat: (key) => gw.post('/v1/chat/completions', CHAT, key ? bearer(key) : {}),
    vmChat: (key) => gw.post('/v1/chat/completions', VM_CHAT, key ? bearer(key) : {}),
    stop: async () => { await gw.stop(); await upstream.stop() },
  }
}

test('T-KEY-01 三态判定：省略/掩码=保留，空串=显式清空，非法=400', () => {
  const sealed = { _keys: { __mg_client: 'sealed-key' }, defaults: { clientKey: '' } }
  const legacyOnly = { _keys: {}, defaults: { clientKey: 'legacy-plain' } }
  const empty = { _keys: {}, defaults: {} }
  assert.equal(planClientKeyUpdate({ defaults: { proxyMode: 'direct' } }, sealed).action, 'KEEP', '省略字段=保留')
  assert.equal(planClientKeyUpdate({}, sealed).action, 'KEEP', '缺 defaults=保留')
  assert.equal(planClientKeyUpdate({ defaults: { clientKey: CLIENT_KEY_MASK } }, sealed).action, 'KEEP', '掩码=保留')
  // F-a2：掩码容忍首尾空白（API 直连可能发 '********  '），绝不能落成真实 Key
  assert.equal(planClientKeyUpdate({ defaults: { clientKey: CLIENT_KEY_MASK + '  ' } }, sealed).action, 'KEEP')
  assert.equal(planClientKeyUpdate({ defaults: { clientKey: '  ' + CLIENT_KEY_MASK } }, sealed).action, 'KEEP')
  assert.equal(planClientKeyUpdate({ defaults: { clientKey: CLIENT_KEY_MASK + '\t' } }, sealed).action, 'KEEP')
  assert.deepEqual(planClientKeyUpdate({ defaults: { clientKey: CLIENT_KEY_MASK } }, legacyOnly), { action: 'MIGRATE_EXISTING_VALUE', value: 'legacy-plain' })
  assert.deepEqual(planClientKeyUpdate({ defaults: { proxyMode: 'direct' } }, legacyOnly), { action: 'MIGRATE_EXISTING_VALUE', value: 'legacy-plain' })
  assert.equal(planClientKeyUpdate({ defaults: { proxyMode: 'direct' } }, empty).action, 'KEEP')
  assert.equal(planClientKeyUpdate({ defaults: { clientKey: '' } }, sealed).action, 'EXPLICIT_CLEAR')
  assert.deepEqual(planClientKeyUpdate({ defaults: { clientKey: 'new-key' } }, sealed), { action: 'REPLACE_WITH_SEALED', value: 'new-key' })

  for (const badValue of [42, true, null, {}, [], ' ', 'a\u0000b', 'x'.repeat(9000)]) {
    const plan = planClientKeyUpdate({ defaults: { clientKey: badValue } }, sealed)
    assert.equal(plan.action, 'INVALID_400', '非法值应 400: ' + String(badValue).slice(0, 16))
    assert.equal(plan.code, 'invalid_client_key')
  }
  assert.equal(isValidClientKeyValue('sk-ok'), true)
  assert.equal(isValidClientKeyValue(''), false)
  assert.equal(isValidClientKeyValue('   '), false)
})

test('T-KEY-02 过期解析：毫秒 / 带时区 ISO / 旧 datetime-local / 非法与歧义', () => {
  assert.equal(parseVirtualExpiry(undefined).kind, 'none')
  assert.equal(parseVirtualExpiry('').kind, 'none')
  assert.deepEqual(parseVirtualExpiry('2026-11-12T10:00:00Z'), {
    kind: 'valid', epochMs: Date.UTC(2026, 10, 12, 10, 0, 0, 0), normalized: '2026-11-12T10:00:00.000Z', source: 'iso_zoned',
  })
  assert.equal(parseVirtualExpiry('2026-11-12T18:00:00+08:00').epochMs, Date.UTC(2026, 10, 12, 10, 0, 0, 0))
  assert.equal(parseVirtualExpiry(1794477600000).epochMs, Date.UTC(2026, 10, 12, 10, 0, 0, 0))
  assert.equal(parseVirtualExpiry('1794477600000').epochMs, Date.UTC(2026, 10, 12, 10, 0, 0, 0))

  // 旧 datetime-local 按本机时区解释（与测试进程同一时区口径，见 TZ 固定夹具说明）。
  const local = parseVirtualExpiry('2026-11-12T10:00')
  assert.equal(local.kind, 'valid')
  assert.equal(local.source, 'legacy_local_datetime')
  assert.equal(local.epochMs, new Date(2026, 10, 12, 10, 0, 0, 0).getTime())
  const dateOnly = parseVirtualExpiry('2026-12-31')
  assert.equal(dateOnly.source, 'legacy_local_date')
  assert.equal(dateOnly.epochMs, new Date(2026, 11, 31, 0, 0, 0, 0).getTime())

  for (const bad of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-11-12T10:00:00', '2026-11-12T10:00:00.123', 'tomorrow', 'next tuesday', {}, [], true]) {
    const parsed = parseVirtualExpiry(bad)
    assert.equal(parsed.kind, 'invalid', '应判非法/歧义: ' + String(bad))
    assert.ok(String(parsed.code).startsWith('expiry_'), '应带可诊断 code')
  }
})

test('T-KEY-02 旧格式固定时区夹具：同一 wall-clock 在不同 TZ 解析为不同 instant', () => {
  const moduleUrl = new URL('../../../src/index.js', import.meta.url).href
  const probe = (tz) => {
    const script = 'import { parseVirtualExpiry } from ' + JSON.stringify(moduleUrl) + "\n" +
      "process.stdout.write(String(parseVirtualExpiry('2026-11-12T10:00').epochMs))"
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH || '', TZ: tz },
      encoding: 'utf8',
      timeout: 30000,
    })
    assert.equal(result.status, 0, 'TZ=' + tz + ' probe failed: ' + result.stderr)
    return Number(result.stdout)
  }
  assert.equal(probe('UTC'), Date.UTC(2026, 10, 12, 10, 0, 0, 0), 'UTC 下旧 datetime-local 按 UTC 解释')
  assert.equal(probe('Asia/Shanghai'), Date.UTC(2026, 10, 12, 2, 0, 0, 0), 'Asia/Shanghai 下同一 wall-clock = 02:00Z')
})

test('T-KEY-02 到期边界：到期前 1ms / 瞬间 / 后 1ms 与非法值 deny', () => {
  const at = Date.UTC(2026, 10, 12, 10, 0, 0, 0)
  const iso = new Date(at).toISOString()
  assert.equal(isVirtualKeyExpired(iso, at - 1).expired, false, '到期前 1ms 仍有效')
  assert.equal(isVirtualKeyExpired(iso, at).expired, false, '到期瞬间沿用 now > expiresAt 语义（仍有效）')
  assert.equal(isVirtualKeyExpired(iso, at + 1).expired, true, '到期后 1ms 过期')
  assert.equal(isVirtualKeyExpired('', at).state, 'none')

  const invalid = isVirtualKeyExpired('2026-02-30T10:00', at)
  assert.equal(invalid.state, 'invalid')
  assert.equal(invalid.expired, true, '非法过期值必须 deny（不得静默放行）')
  assert.equal(invalid.code, 'expiry_invalid_calendar')

  const projection = virtualExpiryProjection(iso, at + 1)
  assert.equal(projection.expiresAtState, 'expired')
  assert.equal(projection.expiresAtMs, at)
})

test('P0-1 省略字段不清空全局 Key；掩码保留；替换与显式清空生效', { timeout: 40000 }, async (t) => {
  const ctx = await boot()
  t.after(() => ctx.stop())
  const KEY1 = 'sk-client-tristate-001'
  const KEY2 = 'sk-client-tristate-002'

  assert.equal((await ctx.chat()).status, 200, '未配置 Key 时匿名放行')
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: KEY1 } })).status, 200)
  assert.equal((await ctx.chat()).status, 401)
  assert.equal((await ctx.chat(KEY1)).status, 200)

  // 核心回归：补丁省略 clientKey（只改其它 defaults）不得撤销数据面全局 Key。
  const keysPath = join(ctx.gw.dir, 'keys.local.json')
  const keysBefore = await readFile(keysPath, 'utf8')
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { proxyMode: 'direct' } })).status, 200)
  assert.equal(await readFile(keysPath, 'utf8'), keysBefore, 'KEEP 不得写入/删除密钥条目')
  const projected = await (await ctx.gw.get('/api/config')).json()
  assert.equal(projected.defaults.clientKey, CLIENT_KEY_MASK, '省略字段保存后仍回显掩码')
  assert.equal((await ctx.chat()).status, 401, '省略保存后仍要求凭据')
  assert.equal((await ctx.chat(KEY1)).status, 200, '省略保存后原 Key 仍有效')

  // 掩码 = 未改动。
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: CLIENT_KEY_MASK } })).status, 200)
  assert.equal((await ctx.chat(KEY1)).status, 200)
  assert.equal((await ctx.chat()).status, 401)

  // F-a2：掩码 + 尾随空格不得当成真实 Key 写入（否则旧 Key 与新值都 401 → 数据面锁死）
  const keysBeforeSpacedMask = await readFile(keysPath, 'utf8')
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: CLIENT_KEY_MASK + '  ' } })).status, 200)
  assert.equal(await readFile(keysPath, 'utf8'), keysBeforeSpacedMask, '掩码变体不得改写 keys')
  assert.equal((await ctx.chat(KEY1)).status, 200, '掩码变体保存后旧 Key 仍然有效')
  assert.equal((await ctx.chat(CLIENT_KEY_MASK + '  ')).status, 401, '掩码字面量绝不能成为真实 Key')

  // 替换生效（旧 Key 立即失效）。
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: KEY2 } })).status, 200)
  assert.equal((await ctx.chat(KEY1)).status, 401)
  assert.equal((await ctx.chat(KEY2)).status, 200)

  // 只有显式空串才删除。
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: '' } })).status, 200)
  assert.equal((await ctx.chat()).status, 200, '显式清空后匿名放行')
  const cleared = await (await ctx.gw.get('/api/config')).json()
  assert.equal(cleared.defaults.clientKey, '')
})

test('P0-1 面板侧：未编辑不发送 clientKey，清空需显式动作（静态契约）', async () => {
  const source = await readFile(new URL('../../../src/admin.html', import.meta.url), 'utf8')
  assert.ok(source.includes('clientKeyPayload(C.defaults)'), '保存必须经三态 payload 构造')
  assert.equal(source.includes('defaults:C.defaults,'), false, '不得直接回送原始 defaults（会隐式发送空串）')
  assert.ok(source.includes("if(_clientKeyClear)out.clientKey=''"), '显式清空=发送空串')
  assert.ok(source.includes('delete out.clientKey'), '未编辑=省略该字段')
  assert.ok(source.includes('id="vmKeyClear"'), '清空必须有明确按钮，不能只靠空输入')
  assert.ok(source.includes('expToLocalInput(v.expiresAt)'), '过期时间仅做展示格式转换')
  assert.equal(source.includes("new Date(v.expiresAt)<new Date()"), false, '前端不得自行比较过期时间')
})

test('T-KEY-01 旧明文迁移：省略字段时把 defaults.clientKey 迁入加密库并清掉明文', { timeout: 30000 }, async (t) => {
  const LEGACY = 'legacy-plain-key-123'
  const ctx = await boot({ defaults: { clientKey: LEGACY } })
  t.after(() => ctx.stop())

  assert.equal((await ctx.chat()).status, 401, '旧明文 Key 已生效')
  assert.equal((await ctx.chat(LEGACY)).status, 200)
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { proxyMode: 'direct' } })).status, 200)
  assert.equal((await ctx.chat(LEGACY)).status, 200, '迁移后旧 Key 仍然可用')
  assert.equal((await ctx.chat()).status, 401)

  const projected = await (await ctx.gw.get('/api/config')).json()
  assert.equal(projected.defaults.clientKey, CLIENT_KEY_MASK)
  const local = JSON.parse(await readFile(join(ctx.gw.dir, 'gateway.local.json'), 'utf8'))
  assert.equal(local.defaults.clientKey, '', '明文不得继续留在 local')
  const keysFile = await readFile(join(ctx.gw.dir, 'keys.local.json'), 'utf8')
  assert.ok(keysFile.trimStart().startsWith('MG1:'), 'keys.local.json 必须加密')
  assert.equal(keysFile.includes(LEGACY), false, '加密库磁盘文件不得含明文')
  const logs = (await (await ctx.gw.get('/api/logs?lines=200')).json()).lines.join('\n')
  assert.ok(logs.includes('clientKeyAction=MIGRATE_EXISTING_VALUE'), '审计记录迁移动作')
})

test('T-KEY-01 env 覆盖优先：MG_CLIENT_KEY > keys 库 > 旧 defaults', { timeout: 30000 }, async (t) => {
  const ctx = await boot({ env: { MG_CLIENT_KEY: 'env-key-wins' } })
  t.after(() => ctx.stop())
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: 'sealed-key-loses' } })).status, 200)
  assert.equal((await ctx.chat('env-key-wins')).status, 200, 'env 覆盖优先')
  assert.equal((await ctx.chat('sealed-key-loses')).status, 401)
  // 省略字段保存也不得改变优先级
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { proxyMode: 'direct' } })).status, 200)
  assert.equal((await ctx.chat('env-key-wins')).status, 200)
})

test('T-KEY-01 无权限/无令牌：401 且不改配置', { timeout: 30000 }, async (t) => {
  const ctx = await boot({ env: { MG_ADMIN_TOKEN: 'admin-token' } })
  t.after(() => ctx.stop())
  const before = await (await ctx.gw.get('/api/status', bearer('admin-token'))).json()
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: 'nope' } })).status, 401)
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: 'nope' } }, bearer('wrong-token'))).status, 401)
  const after = await (await ctx.gw.get('/api/status', bearer('admin-token'))).json()
  assert.equal(after.configVersion, before.configVersion, '未授权保存不得推进版本')
  assert.equal(after.defaults.clientKey, '', '未授权保存不得写入 Key')
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { proxyMode: 'direct' } }, bearer('admin-token'))).status, 200)
})

test('T-KEY-01 非法值 400 且不落盘、不改内存', { timeout: 30000 }, async (t) => {
  const ctx = await boot()
  t.after(() => ctx.stop())
  const KEY = 'sk-keep-me-001'
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: KEY } })).status, 200)
  const localPath = join(ctx.gw.dir, 'gateway.local.json')
  const before = { version: (await (await ctx.gw.get('/api/status')).json()).configVersion, local: await readFile(localPath, 'utf8') }

  const bad = await ctx.gw.post('/api/config/save', { defaults: { clientKey: 12345 } })
  assert.equal(bad.status, 400)
  assert.equal(typeof (await bad.json()).error, 'string')
  const after = { version: (await (await ctx.gw.get('/api/status')).json()).configVersion, local: await readFile(localPath, 'utf8') }
  assert.equal(after.version, before.version, '非法值不得推进版本')
  assert.equal(after.local, before.local, '非法值不得写盘')
  assert.equal((await ctx.chat(KEY)).status, 200, '原有 Key 不受影响')
})

test('T-KEY-01 审计与秘密边界：只记动作+代际，日志/响应不含 Key', { timeout: 30000 }, async (t) => {
  const ctx = await boot()
  t.after(() => ctx.stop())
  const SENTINEL = 'sk-SENTINEL-tristate-999'
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { clientKey: SENTINEL } })).status, 200)

  const status = await (await ctx.gw.get('/api/status')).text()
  const config = await (await ctx.gw.get('/api/config')).text()
  const logs = await (await ctx.gw.get('/api/logs?lines=300')).text()
  const logFile = await readFile(join(ctx.gw.dir, 'test.log'), 'utf8').catch(() => '')
  for (const [label, text] of [['status', status], ['config', config], ['logs', logs], ['logfile', logFile]]) {
    assert.equal(text.includes(SENTINEL), false, label + ' 不得回显 Key 值')
  }
  assert.ok(logs.includes('clientKeyAction=REPLACE_WITH_SEALED'), '审计记录动作')
  assert.ok(/审计：配置保存 version=\d+/.test(logs), '审计记录配置代际')
})

test('T-KEY-02 虚拟 Key 过期：保存校验、规范化落盘、鉴权拒绝', { timeout: 60000 }, async (t) => {
  const ctx = await boot({ virtualModels: VM })
  t.after(() => ctx.stop())
  const VKEY = 'sk-vm-tristate-777'
  assert.equal((await ctx.gw.post('/api/keys', { id: '__mg_vm_vm-a', key: VKEY })).status, 200)
  assert.equal((await ctx.vmChat(VKEY)).status, 200)

  const saveVmExpiry = (expiresAt) => ctx.gw.post('/api/config/save', { virtualModels: [{ name: 'vm-a', directory: [{ model: 'demo' }], expiresAt }] })

  // 未来：放行
  assert.equal((await saveVmExpiry('2099-01-01T10:00:00Z')).status, 200)
  assert.equal((await ctx.vmChat(VKEY)).status, 200)

  // 过去：拒绝（修复前 Number('2000-01-01T10:00:00Z')=NaN 会永久有效）
  assert.equal((await saveVmExpiry('2000-01-01T10:00:00Z')).status, 200)
  assert.equal((await ctx.vmChat(VKEY)).status, 401, '过期虚拟 Key 必须拒绝')
  const past = await (await ctx.gw.get('/api/config')).json()
  assert.equal(past.virtualModels[0].expiresAtState, 'expired')

  // 旧 datetime-local：保存后写显式时区 ISO，展示状态由后端给出
  const legacy = parseVirtualExpiry('2099-01-01T10:00')
  assert.equal((await saveVmExpiry('2099-01-01T10:00')).status, 200)
  const normalized = await (await ctx.gw.get('/api/config')).json()
  assert.equal(normalized.virtualModels[0].expiresAt, legacy.normalized, '旧 datetime-local 规范化落盘')
  assert.equal(normalized.virtualModels[0].expiresAtState, 'valid')
  assert.equal((await ctx.vmChat(VKEY)).status, 200)

  // 非法/歧义值：400 且不落盘
  const versionBefore = normalized.configVersion
  for (const badExpiry of ['2099-02-30T10:00', '2099-01-01T10:00:00', 'tomorrow']) {
    const response = await saveVmExpiry(badExpiry)
    assert.equal(response.status, 400, '非法过期值必须 400: ' + badExpiry)
    assert.match((await response.json()).error, /expiry_/, '错误信息带可诊断 code')
  }
  const afterBad = await (await ctx.gw.get('/api/config')).json()
  assert.equal(afterBad.configVersion, versionBefore, '非法值不得推进版本')
  assert.equal(afterBad.virtualModels[0].expiresAt, legacy.normalized, '非法值不得改写已存值')
  assert.equal((await ctx.vmChat(VKEY)).status, 200)
})

// ============================================================================
// M0-2b：虚拟模型元数据「省略 ≠ 删除」
// ============================================================================

test('T-KEY-03 vm meta 三态判定：整个数组/单字段省略=保留，显式空值=清空', () => {
  const current = { expiresAt: '2026-01-01T00:00:00.000Z', note: 'keep-me' }
  assert.equal(planVirtualMetaUpdate(null, 'omitted', current).action, 'KEEP_CURRENT_META')
  assert.deepEqual(planVirtualMetaUpdate(null, 'omitted', current).meta, current)
  assert.equal(planVirtualMetaUpdate({}, 'present', null).action, 'KEEP_CURRENT_META')
  assert.equal(planVirtualMetaUpdate({ name: 'vm-a' }, 'present', current).action, 'KEEP_CURRENT_META')
  // 只改 note：expiresAt 必须从当前 meta 继承
  assert.deepEqual(planVirtualMetaUpdate({ note: 'new-note' }, 'present', current), {
    action: 'UPDATE', meta: { expiresAt: current.expiresAt, note: 'new-note' },
  })
  // 只清 expiresAt：note 继承
  assert.deepEqual(planVirtualMetaUpdate({ expiresAt: '' }, 'present', current), {
    action: 'UPDATE', meta: { expiresAt: '', note: 'keep-me' },
  })
  // 显式全空 → 清空
  assert.deepEqual(planVirtualMetaUpdate({ expiresAt: '', note: '' }, 'present', current), { action: 'EXPLICIT_CLEAR', meta: null })
  // 非法值 → 400
  assert.equal(planVirtualMetaUpdate({ expiresAt: 'not-a-date' }, 'present', current).action, 'INVALID_400')
  // legacy datetime-local 规范化
  const local = planVirtualMetaUpdate({ expiresAt: '2099-01-01T10:00' }, 'present', {})
  assert.equal(local.action, 'UPDATE')
  assert.equal(local.meta.expiresAt, parseVirtualExpiry('2099-01-01T10:00').normalized)
})

test('T-KEY-03 省略 virtualModels 不得清空 meta：已过期 Key 保存后仍然 401', { timeout: 60000 }, async (t) => {
  const ctx = await boot({ virtualModels: VM })
  t.after(() => ctx.stop())
  const VKEY = 'sk-vm-meta-tri-777'
  const keysPath = join(ctx.gw.dir, 'keys.local.json')
  const vmBody = (extra) => ({ virtualModels: [Object.assign({ name: 'vm-a', directory: [{ model: 'demo' }] }, extra)] })

  assert.equal((await ctx.gw.post('/api/keys', { id: '__mg_vm_vm-a', key: VKEY })).status, 200)
  // 已过期
  assert.equal((await ctx.gw.post('/api/config/save', vmBody({ expiresAt: '2000-01-01T00:00:00Z', note: '过期备注' }))).status, 200)
  assert.equal((await ctx.vmChat(VKEY)).status, 401, '过期 Key 必须拒绝')
  const keysBefore = await readFile(keysPath, 'utf8')

  // ① 整个 virtualModels 省略（只改 defaults）→ meta 字节不变，过期 Key 仍 401
  assert.equal((await ctx.gw.post('/api/config/save', { defaults: { proxyMode: 'direct' } })).status, 200)
  assert.equal(await readFile(keysPath, 'utf8'), keysBefore, '省略 virtualModels 不得改写 keys.local.json')
  assert.equal((await ctx.vmChat(VKEY)).status, 401, '省略保存后已过期 Key 不得复活')

  // ①b（QA F-a1 原场景）：带 providers/models、省略 virtualModels → meta 不变，过期 Key 仍 401
  const providerPatch = {
    providers: { mock: { baseUrl: ctx.upstream.base, apiKeyEnv: '' } },
    models: { demo: { provider: 'mock', api: 'openai' } },
  }
  assert.equal((await ctx.gw.post('/api/config/save', providerPatch)).status, 200)
  assert.equal(await readFile(keysPath, 'utf8'), keysBefore, 'providers/models 省略式保存不得改写 keys')
  assert.equal((await ctx.vmChat(VKEY)).status, 401, 'QA F-a1：省略 virtualModels 后已过期 Key 仍必须 401')

  // ② 数组里的 vm 对象省略 expiresAt/note → 两项都保留
  assert.equal((await ctx.gw.post('/api/config/save', vmBody({}))).status, 200)
  assert.equal(await readFile(keysPath, 'utf8'), keysBefore, '省略字段不得改写 meta')
  assert.equal((await ctx.vmChat(VKEY)).status, 401)

  // ③ 只改 note → expiresAt 必须继承，Key 仍然过期
  assert.equal((await ctx.gw.post('/api/config/save', vmBody({ note: '更新备注' }))).status, 200)
  assert.equal((await ctx.vmChat(VKEY)).status, 401, '只改 note 不得顺带清掉过期时间')
  const afterNote = await (await ctx.gw.get('/api/config')).json()
  assert.equal(afterNote.virtualModels[0].note, '更新备注')
  assert.equal(afterNote.virtualModels[0].expiresAtState, 'expired')

  // ④ 显式清空 expiresAt → 过期限制解除（保留 note），Key 恢复可用
  assert.equal((await ctx.gw.post('/api/config/save', vmBody({ expiresAt: '' }))).status, 200)
  assert.equal((await ctx.vmChat(VKEY)).status, 200, '显式清空过期时间后 Key 恢复可用')
  const afterClearExpiry = await (await ctx.gw.get('/api/config')).json()
  assert.equal(afterClearExpiry.virtualModels[0].expiresAtState, 'none')
  assert.equal(afterClearExpiry.virtualModels[0].note, '更新备注', '清 expiresAt 不得误删 note')

  // ⑤ 显式清空两项 → meta 删除
  assert.equal((await ctx.gw.post('/api/config/save', vmBody({ expiresAt: '', note: '' }))).status, 200)
  const keysAfterClear = JSON.parse(JSON.stringify(await (await ctx.gw.get('/api/config')).json()))
  assert.equal(keysAfterClear.virtualModels[0].expiresAt, '')
  assert.equal(keysAfterClear.virtualModels[0].note, '')

  // ⑥ 删除虚拟模型仍然清理独立 Key 与 meta（该行为不能修坏）
  assert.equal((await ctx.gw.post('/api/config/save', { virtualModels: [] })).status, 200)
  assert.equal((await ctx.gw.post('/api/config/save', vmBody({}))).status, 200)
  const readded = await (await ctx.gw.get('/api/status')).json()
  assert.equal(readded.virtualModels[0].keySet, false, '删除虚拟模型必须清理其独立 Key（同名重建不得继承旧 Key）')
})

