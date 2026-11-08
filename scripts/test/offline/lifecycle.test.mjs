// MG-007 生命周期：SIGTERM 优雅关闭、定时器清理、最终原子落盘、损坏 stats 恢复。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { startGateway, startMockUpstream } from './harness.mjs'

// 退出竞态：退出事件可能早于监听注册，用轮询 + once 双保险
async function waitExit(child, ms = 8000) {
  const deadline = Date.now() + ms
  const exited = once(child, 'exit').then(([code]) => code)
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    const race = await Promise.race([exited, new Promise((r) => setTimeout(() => r('tick'), 50))])
    if (race !== 'tick') return race
  }
  if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch {} ; await exited.catch(() => {}) }
  return child.exitCode
}

test('MG-007 SIGTERM：退出码 0、连接排空、统计最终落盘并在重启后恢复', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-life-'))
  const config = {
    providers: { mock: { baseUrl: upstream.base } },
    models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
  }
  t.after(async () => { await upstream.stop(); await rm(dir, { recursive: true, force: true }) })

  let gw = await startGateway({ name: 'life-sigterm', dir, config })
  const chat = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 200)

  gw.child.kill('SIGTERM')
  const code = await waitExit(gw.child)
  assert.equal(code, 0, 'SIGTERM 后应正常退出（不是被信号杀死）')

  const stats = JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8'))
  assert.equal(typeof stats.byModel, 'object')
  const demo = stats.daily.demo && stats.daily.demo[new Date().toLocaleDateString('en-CA')]
  assert.ok(demo && demo.tokens > 0, '关闭时写入了累计 token（不是空文件）')
  assert.ok(!(await readdir(dir)).some((f) => f.includes('.corrupt-')), '正常路径不产生损坏备份')

  // 同目录重启：统计从磁盘恢复
  gw = await startGateway({ name: 'life-sigterm', dir, config })
  t.after(() => gw.stop())
  const restored = await (await gw.get('/api/status')).json()
  const demoModel = restored.models.find((m) => m.name === 'demo')
  assert.ok(demoModel.today > 0, '重启后今日 token 从 stats.json 恢复')
  gw.child.kill('SIGTERM')
  assert.equal(await waitExit(gw.child), 0)
})

test('MG-007 损坏 stats：先备份再重建，网关照常启动', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-life-corrupt-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await writeFile(join(dir, 'stats.json'), '{ this is not json')
  const gw = await startGateway({ name: 'life-corrupt', dir })
  assert.equal((await gw.get('/healthz')).status, 200)
  const names = await readdir(dir)
  assert.ok(names.some((f) => f.includes('.corrupt-')), '损坏文件被留证备份')
  gw.child.kill('SIGTERM')
  assert.equal(await waitExit(gw.child), 0)
  const rebuilt = JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8'))
  assert.equal(typeof rebuilt.byModel, 'object', '关闭后写回可解析的 stats')
})
