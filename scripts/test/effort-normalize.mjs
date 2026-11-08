// 思考强度（effort）入站归一化 + per-route 整形回归（自包含：mock 上游 + 隔离网关实例，零外部依赖、零真实上游消耗）
// 背景：生产 2026-09-17 —— ZCode CLI 发嵌套 reasoning:{effort}，网关原样透传；主上游 OpenRouter 认得所以平时正常，
// 一旦兜底到严格上游（jiyuan/tokenrhythm，字段白名单校验）就 400 UNKNOWN_FIELD「未知请求字段：reasoning.effort」。
// 覆盖：①嵌套 reasoning 归一为平面 reasoning_effort（严格上游不再 400 且出站无 reasoning 键）
//       ②关闭思考的同义拼写归一（none/disabled/false -> off）
//       ③潜伏项：兜底切到 effortFormat 不同的模型时，字段形态随**目标模型**变化（双向）
//       ④既有语义不回归：虚拟入口客户端没给档位就不注入；真实模型入口按配置默认注入；档位白名单仍本地拦截。
import { check, count } from './utils.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const TMP = path.join(ROOT, '.tmp-test-effort')
const PORT = 8796
const BASE = 'http://127.0.0.1:' + PORT
const ADMIN = { 'Authorization': 'Bearer devtoken', 'Content-Type': 'application/json' }
const CH = { 'Authorization': 'Bearer testkey123', 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 上游 mock：记录最后收到的请求体；strict 模式模拟 jiyuan —— 见到嵌套 reasoning 对象即 400 UNKNOWN_FIELD；
// fail 模式恒 429（用来把请求逼到目录链的下一个模型，制造跨 effortFormat 兜底）。
const seen = {}
function mockUpstream(name, mode) {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      let body = null; try { body = JSON.parse(b) } catch {}
      seen[name] = body
      if (mode === 'fail') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'rate limited' } })); return }
      if (mode === 'strict') {
        // 严格上游：①见到嵌套 reasoning 对象即 400（jiyuan/LiteLLM 语义）②按 OpenRouter 的
        // reasoning_effort 词表校验取值——这条词表里**没有 off、只有 none**，正是 2026-09-17 首版
        // 归一方向搞反时被打回的那条（openrouter 400 Invalid option）。词表必须进 mock，否则
        // 「归一成上游不认的拼写」这类回归测不出来。
        const VOCAB = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']
        if (body && Object.prototype.hasOwnProperty.call(body, 'reasoning')) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 'UNKNOWN_FIELD', message: '未知请求字段：reasoning.effort', data: { field: 'reasoning.effort' } }))
          return
        }
        if (body && body.reasoning_effort !== undefined && !VOCAB.includes(String(body.reasoning_effort))) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'reasoning_effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"', code: 400 } }))
          return
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'm1', object: 'chat.completion', model: body && body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }))
    })
  })
}
const sFail = mockUpstream('p-fail', 'fail')
const sStrict = mockUpstream('p-strict', 'strict')
const sLenient = mockUpstream('p-lenient', 'lenient')
await new Promise(r => sFail.listen(9891, r))
await new Promise(r => sStrict.listen(9892, r))
await new Promise(r => sLenient.listen(9893, r))

const mdef = (provider, extra) => Object.assign({ provider, alias: [], fallbacks: [], maxConcurrent: 0, qps: 0, reasoning: '', effortOptions: ['off', 'low', 'medium', 'high'], dailyQuota: 0, quota: 0, maxContext: 0 }, extra || {})
const gatewayCfg = {
  server: { host: '127.0.0.1', port: PORT, logFile: path.join(TMP, 'gateway.log') },
  defaults: { provider: 'p-strict', model: 'gatemodel', clientKey: '', directory: [], retry: { maxAttempts: 1 }, timeout: { connectMs: 3000, firstByteMs: 8000, idleMs: 8000 } },
  providers: {
    'p-fail': { baseUrl: 'http://127.0.0.1:9891', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' },
    'p-strict': { baseUrl: 'http://127.0.0.1:9892', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' },
    'p-lenient': { baseUrl: 'http://127.0.0.1:9893', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' },
  },
  models: {
    'm-strict': mdef('p-strict'),                                                        // 严格上游 + 默认格式
    'm-dflt': mdef('p-lenient', { reasoning: 'low' }),                                   // 真实模型入口：配了默认档位
    'm-flat-fail': mdef('p-fail', { effortFormat: 'reasoning_effort' }),                 // 链首：平面格式但恒失败
    'm-think-fail': mdef('p-fail', { effortFormat: 'thinking' }),                        // 链首：thinking 格式但恒失败
    'm-flat': mdef('p-lenient', { effortFormat: 'reasoning_effort' }),                   // 兜底：平面格式
    'm-think': mdef('p-strict', { effortFormat: 'thinking' }),                           // 兜底：thinking 格式（落在严格上游）
  },
  virtualModels: [
    { name: 'chain-f2t', directory: [{ model: 'm-flat-fail', mode: 'afterAll', providers: [] }, { model: 'm-think', mode: 'afterAll', providers: [] }] },
    { name: 'chain-t2f', directory: [{ model: 'm-think-fail', mode: 'afterAll', providers: [] }, { model: 'm-flat', mode: 'afterAll', providers: [] }] },
    { name: 'chain-plain', directory: [{ model: 'm-flat', mode: 'afterAll', providers: [] }] },
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

const chat = async (model, extra) => {
  const r = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: CH, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, ...(extra || {}) }) })
  return { code: r.status, ...(await r.json().catch(() => ({}))) }
}
const has = (b, k) => !!(b && Object.prototype.hasOwnProperty.call(b, k))
const base = count()

try {
if (!ready) {
  check('隔离网关实例启动', false, 'healthz 超时')
} else {
  // —— ①入站归一化：嵌套 reasoning:{effort} ——
  seen['p-strict'] = null
  let r = await chat('m-strict', { reasoning: { effort: 'high' } })
  check('嵌套 reasoning.effort 不再被严格上游拒绝', r.code === 200, 'code=' + r.code + ' ' + JSON.stringify(r).slice(0, 160))
  check('出站体已剔除嵌套 reasoning 键', !has(seen['p-strict'], 'reasoning'))
  check('嵌套 effort 并入平面 reasoning_effort', seen['p-strict'] && seen['p-strict'].reasoning_effort === 'high', seen['p-strict'] && String(seen['p-strict'].reasoning_effort))

  // 客户端同时给了平面字段时以平面为准、嵌套对象仍剔除
  seen['p-strict'] = null
  r = await chat('m-strict', { reasoning_effort: 'low', reasoning: { effort: 'high', summary: 'auto' } })
  check('平面优先且嵌套对象一并剔除', r.code === 200 && seen['p-strict'].reasoning_effort === 'low' && !has(seen['p-strict'], 'reasoning'), 'code=' + r.code)

  // 只有 summary、没有 effort 的嵌套对象同样剔除（OpenAI chat 协议无该字段位置）
  seen['p-strict'] = null
  r = await chat('m-strict', { reasoning: { summary: 'auto' } })
  check('仅 summary 的 reasoning 对象被剔除且不注入档位', r.code === 200 && !has(seen['p-strict'], 'reasoning') && !has(seen['p-strict'], 'reasoning_effort'), 'code=' + r.code)

  // —— ②关闭思考的同义拼写归一 ——
  // 目标拼写是 'none'（OpenAI/Responses/OpenRouter 词表里的关闭档，且这些上游**不认 off**）；
  // 本地 effortOptions 里惯用的 'off' 与之等价（白名单两侧同过 canonEffort），故 off 也要折成 none。
  for (const v of ['none', 'off', 'disabled', 'false']) {
    seen['p-strict'] = null
    r = await chat('m-strict', { reasoning: { effort: v } })
    check('关闭拼写 ' + v + ' 归一为 none 且被上游接受', r.code === 200 && seen['p-strict'] && seen['p-strict'].reasoning_effort === 'none', 'code=' + r.code + ' got=' + (seen['p-strict'] && seen['p-strict'].reasoning_effort))
  }
  // 客户端同时发嵌套 + 平面（ZCode 实测形态）：平面优先，且取值仍落在上游词表内
  seen['p-strict'] = null
  r = await chat('m-strict', { reasoning_effort: 'none', reasoning: { effort: 'none' } })
  check('平面 none + 嵌套 none：上游词表内且不被拒', r.code === 200 && seen['p-strict'].reasoning_effort === 'none' && !has(seen['p-strict'], 'reasoning'), 'code=' + r.code)

  // —— ③潜伏项：per-route 形态随目标模型变化 ——
  // 链首平面格式恒 429 -> 兜底 thinking 格式：兜底必须收到 thinking 对象（且严格上游不该见到 reasoning_effort）
  seen['p-strict'] = null
  r = await chat('chain-f2t', { reasoning_effort: 'high' })
  check('兜底切到 thinking 格式模型：请求成功', r.code === 200, 'code=' + r.code + ' ' + JSON.stringify(r).slice(0, 160))
  check('兜底 thinking 模型收到 thinking:{type:enabled}', !!(seen['p-strict'] && seen['p-strict'].thinking && seen['p-strict'].thinking.type === 'enabled'), JSON.stringify(seen['p-strict'] && seen['p-strict'].thinking))
  check('兜底 thinking 模型不再收到平面 reasoning_effort', !has(seen['p-strict'], 'reasoning_effort'))

  // 反向：链首 thinking 恒 429 -> 兜底平面格式：兜底必须收到平面字段，且不带 thinking 对象
  seen['p-lenient'] = null
  r = await chat('chain-t2f', { reasoning_effort: 'high' })
  check('兜底切到平面格式模型：请求成功', r.code === 200, 'code=' + r.code)
  check('兜底平面模型收到 reasoning_effort:high', seen['p-lenient'] && seen['p-lenient'].reasoning_effort === 'high', JSON.stringify(seen['p-lenient'] && seen['p-lenient'].reasoning_effort))
  check('兜底平面模型不再收到 thinking 对象', !has(seen['p-lenient'], 'thinking'))

  // 客户端没给档位：虚拟入口不注入（保持既有语义，避免凭空改变上游默认行为）
  seen['p-lenient'] = null
  r = await chat('chain-plain', {})
  check('虚拟入口未给档位时不注入任何档位字段', r.code === 200 && !has(seen['p-lenient'], 'reasoning_effort') && !has(seen['p-lenient'], 'thinking'), 'code=' + r.code)

  // —— ④既有语义不回归 ——
  seen['p-lenient'] = null
  r = await chat('m-dflt', {})
  check('真实模型入口仍注入配置默认档位', r.code === 200 && seen['p-lenient'].reasoning_effort === 'low', seen['p-lenient'] && String(seen['p-lenient'].reasoning_effort))
  r = await chat('m-dflt', { reasoning_effort: 'xhigh' })
  check('档位白名单仍本地拦截(400)', r.code === 400 && r.error && r.error.type === 'UnsupportedParamsError', 'code=' + r.code)
  r = await chat('m-dflt', { reasoning_effort: 'medium' })
  check('客户端显式档位优先于配置默认', r.code === 200 && seen['p-lenient'].reasoning_effort === 'medium', seen['p-lenient'] && String(seen['p-lenient'].reasoning_effort))
}
} finally {
  try { child.kill() } catch {}
  try { sFail.close() } catch {}
  try { sStrict.close() } catch {}
  try { sLenient.close() } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}
const c = count(); const mp = c.pass - base.pass; const mf = c.fail - base.fail
console.log('  （effort-normalize 子结果: ' + mp + '/' + (mp + mf) + '）')
if (mf) throw new Error('effort-normalize 有 ' + mf + ' 项失败')
