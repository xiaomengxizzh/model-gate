// 主上游回切探活（failback）契约：主上游故障切到备用后，无需真实请求试水，
// 后台探活发现主上游恢复即把亲和切回主上游，下一个请求回到主上游。
//
// 关键对照：affinityTtlMs 设为 1 小时（本测试时间内绝不会过期），
// 若仍切回主上游，则只能是 failback 探活生效，而非亲和 TTL 过期。
import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'

const hits = { A: 0, B: 0 }      // 真实请求计数
const probes = { A: 0, B: 0 }    // 探活请求计数
const probeRoles = []            // 探活消息角色记录（必须为 user：LiteLLM 层拒 system-only，400）
const down = { A: false, B: false }
// 缓存命中率注入：B（备用）响应带 cached_tokens=100（命中率 100%），A（主）带 cache_write_tokens=100（命中率 0%）。
// 复现生产场景「无亲和时按缓存命中率排序，缓存热的备用上游反超主上游」——否则测试环境 cacheStat 为空会碰巧切回，
// 掩盖「探活成功却切不回去」的缺陷（探活须把亲和置为主上游，而非清除后交给命中率路由）。
const mkServer = (name) => http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let isProbe = false
    try {
      const j = JSON.parse(body)
      if (j.messages && j.messages[0] && j.messages[0].role === 'user' && String(j.messages[0].content).includes('ping')) { isProbe = true; probeRoles.push(j.messages[0].role) }
    } catch {}
    if (isProbe) probes[name] += 1; else hits[name] += 1
    if (down[name]) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); return }
    const usage = name === 'B'
      ? { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 100 } }
      : { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 't-fb-m',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok-' + name }, finish_reason: 'stop' }],
      usage,
    }))
  })
})
const sA = mkServer('A'); const sB = mkServer('B')
await new Promise(r => sA.listen(0, () => r()))
await new Promise(r => sB.listen(0, () => r()))
const portA = sA.address().port; const portB = sB.address().port

const base = await snapshot()
const origDefaults = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-fb-a'] = { baseUrl: `http://127.0.0.1:${portA}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.providers['t-fb-b'] = { baseUrl: `http://127.0.0.1:${portB}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.models['t-fb-m'] = { provider: 't-fb-a', alias: [], fallbacks: ['t-fb-b'], maxConcurrent: 0 }
base.defaults = {
  ...(base.defaults || {}),
  retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
  affinityTtlMs: 3600000,   // 1 小时：排除 TTL 过期导致回流的可能
  failbackProbe: { enabled: true, everyMs: 2000, successStreak: 2, system: 'ping' },
}
await save(base.providers, base.models, base.defaults)

// 1) 首请求：主上游 A 正常 → 命中 A
await chat('t-fb-m')
check('1·首请求命中主上游 A', hits.A === 1, { A: hits.A, B: hits.B })

// 2) A 故障 → 流量切到备用 B（亲和记录为 B）
down.A = true
await chat('t-fb-m')
check('2·主上游故障后切到备用 B', hits.B === 1, { A: hits.A, B: hits.B })

// 3) A 恢复；此后不发任何真实请求，仅等待后台探活
down.A = false
await new Promise(r => setTimeout(r, 20000))
check('3·降级期间后台确实发出了探活请求', probes.A >= 2, { probesA: probes.A, probesB: probes.B })
check('3b·探活消息必须为 user 角色（LiteLLM 拒 system-only）', probeRoles.length > 0 && probeRoles.every(r => r === 'user'), { probeRoles })

// 4) 真实请求应已回到主上游 A（TTL 为 1 小时未过期，只能是探活清除亲和所致）
const before = { A: hits.A, B: hits.B }
await chat('t-fb-m')
check('4·探活成功后自动回切主上游 A', hits.A === before.A + 1 && hits.B === before.B, { A: hits.A, B: hits.B, before })

const after = await snapshot()
delete after.providers['t-fb-a']; delete after.providers['t-fb-b']; delete after.models['t-fb-m']
await save(after.providers, after.models, origDefaults)
await new Promise(r => sA.close(r))
await new Promise(r => sB.close(r))
