// MG-005 日志脱敏：热更新后的 Key 立即纳入脱敏、代理内嵌凭据兜底、Barear 通用规则。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../../../src/logger.js'
import { startGateway, startMockUpstream } from './harness.mjs'

test('MG-005 logger：启动词表、运行期刷新、代理凭据与 Bearer 兜底', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-logger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'gw.log')
  const log = createLogger({ logFile: file, silent: true, secrets: ['sk-startup-secret'] })
  log.info('startup key sk-startup-secret ok')
  assert.match(await readFile(log.file(), 'utf8'), /\*\*\*\*/, '启动词表内的秘密被抹除')
  assert.ok(!(await readFile(log.file(), 'utf8')).includes('sk-startup-secret'))

  // 运行期刷新：新 Key 立即生效（对应配置保存/Key 热更新后的 reloadConfig）
  log.setSecrets(['sk-hot-secret-123'])
  log.info('after rotation sk-hot-secret-123 leaked?')
  const text = await readFile(log.file(), 'utf8')
  assert.ok(!text.includes('sk-hot-secret-123'), '刷新后的新 Key 被抹除')

  // 代理内嵌凭据与 Bearer 兜底与词表无关
  log.info('proxy http://alice:p%40ss@proxy.internal:8080 failed; header Authorization=Bearer abcdefghijklmn')
  const t2 = await readFile(log.file(), 'utf8')
  assert.ok(!t2.includes('alice:p%40ss@'), '代理 userinfo 被抹除')
  assert.match(t2, /\/\/\*\*\*\*:\*\*\*\*@proxy\.internal/)
  assert.ok(!t2.includes('abcdefghijklmn'), '通用 Bearer 被抹除')
})

test('MG-005 端到端：通过 API 热更新的凭据在日志里即刻脱敏', { timeout: 30000 }, async (t) => {
  const HOT = 'sk-hot-client-20261108'
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'logger-hot',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // 启动后才写入的客户端 Key：启动时词表里没有它
  assert.equal((await gw.post('/api/config/save', { defaults: { clientKey: HOT } })).status, 200)
  // 把该 Key 塞进请求模型名，使其必然出现在请求日志行里
  // 未知模型会报错并把模型名（=刚写入的 Key）带进错误摘要，正好检验脱敏是否已热生效
  const r = await gw.post('/v1/chat/completions', { model: HOT, messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer ' + HOT })
  assert.equal(r.status, 502)

  const logs = await (await gw.get('/api/logs?lines=500')).json()
  const joined = logs.lines.join('\n')
  assert.match(joined, /route failed/, '错误摘要已写入日志')
  assert.ok(!joined.includes(HOT), '热更新的凭据不得以明文出现在日志里')
  assert.match(joined, /\*\*\*\*/, '错误摘要中的凭据被抹成 ****')
})
