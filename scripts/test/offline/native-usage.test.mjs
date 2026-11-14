import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'

const TOKEN = 'native-usage-token'
const AUTH = { authorization: 'Bearer ' + TOKEN }
const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()

function line (obj) { return JSON.stringify(obj) + '\n' }
function usage (input, cached, output, reasoning, total) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total }
}

async function fixtureDir () {
  const dir = await mkdtemp(join(tmpdir(), 'mg-native-usage-'))
  const s1 = [
    line({ timestamp: iso(3600000), type: 'session_meta', payload: { session_id: 's1', model_provider: 'openai' } }),
    line({ timestamp: iso(3500000), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
    line({ timestamp: iso(3400000), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage(10, 2, 5, 1, 15) }, secret: 'SECRET_MESSAGE_SHOULD_NOT_LEAK' } }),
    line({ timestamp: iso(3300000), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage(20, 4, 10, 2, 30) } } }),
  ].join('')
  const s2 = [
    line({ timestamp: iso(1800000), type: 'session_meta', payload: { session_id: 's2', model_provider: 'custom' } }),
    line({ timestamp: iso(1700000), type: 'turn_context', payload: { model: 'deepseek-v4.1-flash' } }),
    line({ timestamp: iso(1600000), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage(100, 20, 50, 5, 150) } } }),
  ].join('')
  await writeFile(join(dir, 'rollout-a.jsonl'), s1)
  await writeFile(join(dir, 'rollout-b.jsonl'), s2)
  await writeFile(join(dir, 'ignored.txt'), 'not jsonl')
  return dir
}

test('native usage: read-only aggregation from Codex session logs', { timeout: 30000 }, async (t) => {
  const dir = await fixtureDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const gw = await startGateway({ name: 'native-usage', env: { MG_ADMIN_TOKEN: TOKEN, MG_NATIVE_USAGE_DIR: '' }, config: { defaults: { nativeUsageDir: dir } } })
  t.after(() => gw.stop())

  assert.equal((await gw.get('/api/native-usage')).status, 401)
  const res = await gw.get('/api/native-usage?days=7', AUTH)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.enabled, true)
  assert.equal(data.days, 7)
  assert.equal(data.scanned.files, 2)
  assert.equal(data.scanned.sessions, 2)
  assert.equal(data.totals.inputTokens, 130)
  assert.equal(data.totals.cachedInputTokens, 26)
  assert.equal(data.totals.outputTokens, 65)
  assert.equal(data.totals.reasoningOutputTokens, 8)
  assert.equal(data.totals.totalTokens, 195)
  assert.equal(data.totals.turns, 3)
  const byModel = Object.fromEntries(data.byModel.map((m) => [m.provider + '/' + m.model, m.totalTokens]))
  assert.equal(byModel['openai/gpt-6.1-sol'], 45)
  assert.equal(byModel['custom/deepseek-v4.1-flash'], 150)
  assert.ok(data.byDay.length >= 1)
  assert.equal(JSON.stringify(data).includes('SECRET_MESSAGE_SHOULD_NOT_LEAK'), false, 'must not expose message content')
  assert.equal(JSON.stringify(data).includes('not jsonl'), false, 'only .jsonl files are scanned')
})

test('native usage: disabled by default and missing directory is explicit', { timeout: 30000 }, async (t) => {
  const off = await startGateway({ name: 'native-off', env: { MG_ADMIN_TOKEN: TOKEN, MG_NATIVE_USAGE_DIR: '' } })
  t.after(() => off.stop())
  const disabled = await (await off.get('/api/native-usage?days=7', AUTH)).json()
  assert.equal(disabled.enabled, false)
  assert.match(disabled.note, /未启用/)

  const missing = await startGateway({ name: 'native-missing', env: { MG_ADMIN_TOKEN: TOKEN, MG_NATIVE_USAGE_DIR: '' }, config: { defaults: { nativeUsageDir: '/nonexistent/mg-native-usage-test' } } })
  t.after(() => missing.stop())
  const data = await (await missing.get('/api/native-usage?days=7', AUTH)).json()
  assert.equal(data.enabled, true)
  assert.match(data.error, /目录不存在/)
})
