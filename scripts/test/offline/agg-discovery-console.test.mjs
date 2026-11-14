// A2 / P01：OpenCode Console 适配器离线契约。
// 只测纯函数：入口形状（假设）、host 白名单、别名 fail-closed、effort、错误码、会话头、能力新鲜度。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_ID, ENTRIES, entryOf, resolveListUrl, validate, mapModel, mapEffort,
  capabilities, newHeaders, decodeError, encode,
} from '../../../src/providers/opencode-console.js'

const CONSOLE = 'https://opencode.ai/console/v1'
const ZEN = 'https://opencode.ai/zen/v1'

test('console 入口：登记的形状被识别，未知形状 fail-closed', () => {
  const dir = entryOf({ baseUrl: CONSOLE })
  assert.equal(dir.ok, true)
  assert.equal(dir.entry.binding, 'console-v1')
  assert.equal(dir.ambiguous, true)
  assert.equal(dir.entry.assumed, true)

  const responses = entryOf({ baseUrl: CONSOLE + '/responses' })
  assert.equal(responses.ok, true)
  assert.equal(responses.entry.kind, 'responses')

  const zen = entryOf({ baseUrl: ZEN })
  assert.equal(zen.ok, true)
  assert.equal(zen.entry.binding, 'zen-v1')

  const unknown = entryOf({ baseUrl: 'https://opencode.ai/not-a-console-endpoint' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'opencodeconsole_entry_unknown')
  assert.equal(entryOf({}).code, 'opencodeconsole_base_url_missing')
})

test('console 模型清单 URL 始终标记为假设', () => {
  const resolved = resolveListUrl({ baseUrl: CONSOLE })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.url, CONSOLE + '/models')
  assert.equal(resolved.assumed, true)
  assert.equal(resolved.basis, 'console_entry_assumption')

  const zen = resolveListUrl({ baseUrl: ZEN })
  assert.equal(zen.url, ZEN + '/models')

  const explicit = resolveListUrl({ baseUrl: CONSOLE, modelListUrl: 'https://opencode.ai/console/v1/models' })
  assert.equal(explicit.basis, 'explicit_modelListUrl')

  const evil = resolveListUrl({ baseUrl: CONSOLE, modelListUrl: 'https://evil.example/models' })
  assert.equal(evil.ok, false)
  assert.equal(evil.code, 'opencodeconsole_list_host_not_allowlisted')
})

test('console validate：host 白名单 + 入口假设警告 + 版本', () => {
  const ok = validate({ baseUrl: CONSOLE, api: 'openai' }, { grant: { hasCredential: true } })
  assert.equal(ok.ok, true)
  assert.ok(ok.warnings.some((w) => w.code === 'console_entry_assumed'))
  assert.ok(ok.warnings.some((w) => w.code === 'entry_version_unversioned'))

  const evil = validate({ baseUrl: 'https://evil.example/console/v1' }, {})
  assert.equal(evil.ok, false)
  assert.equal(evil.code, 'opencodeconsole_host_not_allowlisted')

  const version = validate({ baseUrl: CONSOLE, consoleApiVersion: 'console-v2' }, {})
  assert.equal(version.ok, false)
  assert.equal(version.code, 'opencodeconsole_version_unsupported')

  const loopback = validate({ baseUrl: 'http://127.0.0.1:8080/console/v1' }, { allowLoopback: true })
  assert.equal(loopback.ok, true)
})

test('console 别名严格映射：未声明/无快照一律拒绝', () => {
  const cfg = {
    models: {
      'deepseek-v4.1-flash': {
        provider: 'console',
        providerModels: { console: 'deepseek-v4.1-flash' },
        alias: ['my-deepseek'],
      },
    },
  }
  assert.equal(mapModel(cfg, 'my-deepseek').ok, true)
  assert.equal(mapModel(cfg, 'my-deepseek').vendorModel, 'deepseek-v4.1-flash')
  assert.equal(mapModel(cfg, 'deepseek-v4.1-flash').vendorModel, 'deepseek-v4.1-flash')

  const unknown = mapModel(cfg, 'not-configured')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'opencodeconsole_model_unmapped')

  const discovered = mapModel(cfg, 'fresh-model', { upstreamIds: ['fresh-model'] })
  assert.equal(discovered.ok, true)
  assert.equal(discovered.declaration, 'discovered')

  const wrongProvider = mapModel({ models: { x: { provider: 'opencodego' } } }, 'x')
  assert.equal(wrongProvider.ok, false)
  assert.equal(wrongProvider.code, 'opencodeconsole_model_provider_mismatch')
  assert.equal(mapModel({}, '').code, 'opencodeconsole_model_missing')
})

test('console effort：只接受已声明档位', () => {
  assert.equal(mapEffort('high').ok, true)
  const bad = mapEffort('ultra')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'opencodeconsole_effort_unsupported')
  assert.equal(mapEffort('').code, 'opencodeconsole_effort_missing')
  assert.equal(mapEffort('LOW', { allowed: ['low'] }).effort, 'low')
})

test('console 错误映射：401/404/429/5xx typed code，正文脱敏', () => {
  assert.equal(decodeError(401, 'unauthorized').code, 'opencodeconsole_auth_failed')
  assert.equal(decodeError(403, 'forbidden').code, 'opencodeconsole_forbidden')
  assert.equal(decodeError(404, 'not found').code, 'opencodeconsole_endpoint_not_found')
  const limited = decodeError(429, 'rate limited', { 'retry-after': '3' })
  assert.equal(limited.code, 'opencodeconsole_rate_limited')
  assert.equal(limited.retryable, true)
  assert.equal(limited.retryAfterMs, 3000)
  assert.equal(decodeError(503, 'down').code, 'opencodeconsole_upstream_error')
  const redacted = decodeError(400, 'bad key ' + 'sk-' + 'abcdefgh12345678')
  assert.ok(!redacted.message.includes('sk-' + 'abcdefgh12345678'))
  assert.ok(redacted.message.includes('sk-***'))
})

test('console 会话头：绝不转发原始 thread-id，且域派生稳定', () => {
  const req = { headers: { 'thread-id': 'thread-should-not-leak' } }
  const provider = { id: PROVIDER_ID, baseUrl: CONSOLE }
  const a = newHeaders({ req, provider, salt: 'test-salt', principalRef: 'u1', scope: 'root' })
  const b = newHeaders({ req, provider, salt: 'test-salt', principalRef: 'u1', scope: 'root' })
  assert.notEqual(a.session.value, 'thread-should-not-leak')
  assert.equal(a.session.value, b.session.value)
  assert.equal(a.session.mode, 'derived')
  const other = newHeaders({ req, provider, salt: 'other-salt', principalRef: 'u1', scope: 'root' })
  assert.notEqual(a.session.value, other.session.value)
  const noThread = newHeaders({ req: { headers: {} }, provider })
  assert.equal(noThread.session.mode, 'request')
})

test('console 能力：无证据 unknown，过期 stale', () => {
  assert.equal(capabilities(null).freshness, 'unknown')
  assert.equal(capabilities(null).proven, false)
  const stale = capabilities({ source: 'fixture', observedAt: '2026-01-01', expiresAt: '2026-02-01', facts: { tools: true } }, { now: Date.parse('2026-03-01') })
  assert.equal(stale.freshness, 'stale')
  assert.equal(stale.proven, false)
  const fresh = capabilities({ source: 'fixture', observedAt: '2026-11-01', expiresAt: '2027-01-01', facts: { tools: true, efforts: ['low'] } }, { now: Date.parse('2026-11-14') })
  assert.equal(fresh.freshness, 'fresh')
  assert.equal(fresh.facts.tools, true)
  assert.deepEqual(fresh.facts.efforts, ['low'])
})

test('console encode：只改模型名，流式补 usage', () => {
  const out = encode({ model: 'mg-console-x', stream: true }, { vendorModel: 'deepseek-v4.1-flash' })
  assert.equal(out.ok, true)
  assert.equal(out.body.model, 'deepseek-v4.1-flash')
  assert.deepEqual(out.body.stream_options, { include_usage: true })
  assert.equal(encode(null).code, 'opencodeconsole_body_invalid')
  assert.equal(ENTRIES.CONSOLE_CHAT.assumed, true)
})
