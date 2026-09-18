// 上游侧故障（4xx 但语义为「上游出错」）的兜底行为回归（自包含：mock 上游 + 隔离网关实例，零外部依赖、零真实上游消耗）
// 背景：生产 2026-09-18 —— atria 短时故障返回 422 {"error":{"message":"Inference request failed.","type":"atria_api_error",
// "code":"upstream_error"}}，网关按普通 4xx 直接抛给客户端，而目录链上还排着 qwen3.8-flash / glm-5.3-flash 两个健康模型
// 没用上 → 用户那一轮 turn 直接失败（ZCode: reason=invalid_request status=422 retryable=false）。
// 覆盖：①4xx 上游侧故障 → 继续目录链、客户端拿到 200；②整链都这样 → 回最后一个上游的原始响应（不是 502）；
//       ③**对照组**：确定性参数错误（atria 的 400 invalid_request）仍直接返回、不去空跑兜底链。
import { check, count } from './utils.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const TMP = path.join(ROOT, '.tmp-test-upside')
const PORT = 8798
const BASE = 'http://127.0.0.1:' + PORT
const ADMIN = { 'Authorization': 'Bearer devtoken', 'Content-Type': 'application/json' }
const CH = { 'Authorization': 'Bearer testkey123', 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const hits = {}
function mockUpstream(name, status, payload) {
  hits[name] = 0
  return http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      hits[name] += 1
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}
// atria 实测原文
const P_UPSTREAM_FAULT = { error: { message: 'Inference request failed.', type: 'atria_api_error', code: 'upstream_error' } }
// 对照：atria 实测的确定性参数错误（09-15 实录），绝不能算上游侧故障
const P_INVALID_REQ = { error: { message: 'max_tokens must be an integer between 1 and 65536.', type: 'atria_api_error', code: 'invalid_request' } }
const P_OK = { id: 'm1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }

const s422 = mockUpstream('p-422', 422, P_UPSTREAM_FAULT)
const s422b = mockUpstream('p-422b', 422, P_UPSTREAM_FAULT)
const s400 = mockUpstream('p-400', 400, P_INVALID_REQ)
const sOk = mockUpstream('p-ok', 200, P_OK)
await new Promise(r => s422.listen(9894, r))
await new Promise(r => s422b.listen(9895, r))
await new Promise(r => s400.listen(9896, r))
await new Promise(r => sOk.listen(9897, r))

const mdef = (provider) => ({ provider, alias: [], fallbacks: [], maxConcurrent: 0, qps: 0, reasoning: '', effortOptions: [], dailyQuota: 0, quota: 0, maxContext: 0 })
const gatewayCfg = {
  server: { host: '127.0.0.1', port: PORT },
  defaults: { provider: 'p-422', model: 'gatemodel', clientKey: '', directory: [], retry: { maxAttempts: 1 }, timeout: { connectMs: 3000, firstByteMs: 8000, idleMs: 8000 } },
  providers: {
    'p-422': { baseUrl: 'http://127.0.0.1:9894', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' },
    'p-422b': { baseUrl: 'http://127.0.0.1:9895', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' },
    'p-400': { baseUrl: 'http://127.0.0.1:9896', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' },
    'p-ok': { baseUrl: 'http://127.0.0.1:9897', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' },
  },
  models: { 'm-422': mdef('p-422'), 'm-422b': mdef('p-422b'), 'm-400': mdef('p-400'), 'm-ok': mdef('p-ok') },
  virtualModels: [
    { name: 'up-422-then-ok', directory: [{ model: 'm-422', mode: 'afterAll', providers: [] }, { model: 'm-ok', mode: 'afterAll', providers: [] }] },
    { name: 'up-all-422', directory: [{ model: 'm-422', mode: 'afterAll', providers: [] }, { model: 'm-422b', mode: 'afterAll', providers: [] }] },
    { name: 'up-400-then-ok', directory: [{ model: 'm-400', mode: 'afterAll', providers: [] }, { model: 'm-ok', mode: 'afterAll', providers: [] }] },
  ],
}
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
fs.writeFileSync(path.join(TMP, 'gateway.json'), JSON.stringify(gatewayCfg, null, 2))
fs.writeFileSync(path.join(TMP, 'keys.local.json'), '{}')

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: ROOT,
  env: { ...process.env, MG_CONFIG_DIR: TMP, MG_CONFIG: path.join(TMP, 'gateway.json'), MG_CLIENT_KEY: 'testkey123', MG_ADMIN_TOKEN: 'devtoken', MG_SILENT: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let ready = false
for (let i = 0; i < 40 && !ready; i++) { try { ready = (await fetch(BASE + '/healthz')).ok } catch {} ; if (!ready) await sleep(250) }

const chat = async (model) => {
  const r = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: CH, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }) })
  return { code: r.status, text: await r.text() }
}
const base = count()

try {
if (!ready) {
  check('隔离网关实例启动', false, 'healthz 超时')
} else {
  // —— ① 上游侧故障 → 继续目录链 ——
  const before = hits['p-ok']
  let r = await chat('up-422-then-ok')
  let j = null; try { j = JSON.parse(r.text) } catch {}
  check('①4xx 上游侧故障(422 upstream_error) 继续链，客户端拿到 200', r.code === 200, 'code=' + r.code + ' ' + r.text.slice(0, 160))
  check('①兜底模型被实际调用', hits['p-ok'] === before + 1, { ok: hits['p-ok'], before })
  check('①返回的是兜底模型的正常响应', !!(j && j.choices && j.choices[0]), r.text.slice(0, 120))
  const st = await (await fetch(BASE + '/api/status', { headers: ADMIN })).json()
  const p422 = (st.providers || []).find(p => p.id === 'p-422')
  check('①上游侧故障计入失败统计（供熔断计数）', !!(p422 && p422.st && p422.st.errors > 0), p422 && p422.st && p422.st.errors)

  // —— ② 整链都是上游侧故障：回最后一个上游的原始响应，而不是 502 ——
  r = await chat('up-all-422')
  check('②整链上游侧故障 → 透传 422（保留上游原始错误，非 502）', r.code === 422 && /upstream_error|Inference request failed/i.test(r.text), 'code=' + r.code + ' ' + r.text.slice(0, 160))

  // —— ③ 对照组：确定性参数错误仍直接返回、不空跑兜底链 ——
  const beforeOk = hits['p-ok']
  r = await chat('up-400-then-ok')
  check('③确定性参数错误(400 invalid_request) 直接返回 400', r.code === 400 && /invalid_request|max_tokens must be/i.test(r.text), 'code=' + r.code + ' ' + r.text.slice(0, 160))
  check('③未误伤：兜底模型没被调用（不空跑整条链）', hits['p-ok'] === beforeOk, { ok: hits['p-ok'], before: beforeOk })
}
} finally {
  try { child.kill() } catch {}
  try { s422.close() } catch {}
  try { s422b.close() } catch {}
  try { s400.close() } catch {}
  try { sOk.close() } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}
const c = count(); const mp = c.pass - base.pass; const mf = c.fail - base.fail
console.log('  （upstream-side-4xx 子结果: ' + mp + '/' + (mp + mf) + '）')
if (mf) throw new Error('upstream-side-4xx 有 ' + mf + ' 项失败')
