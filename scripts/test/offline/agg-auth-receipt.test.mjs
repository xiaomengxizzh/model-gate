// A4 收据回归：收据必须记录**真正要发出去的** host authority 与 path。
//
// 两个曾经真实发生的拒绝（独立验收复现）：
//   F2 authorized=127.0.0.1 actual=127.0.0.1:18991 → send_target_drift（非默认端口被当成漂移）
//   F3 authorized=/v1/responses actual=/v1/v1/responses → send_target_drift（收据漏了 pathPrefix）
// 根因是收据用 identity.host（只有主机名）与 responsesPath（未合成 prefix）构造，而
// assertResolvedUpstream 按 URL 的 host（含端口）与完整 pathname 比较。这里同时钉住：
//   · 非默认端口 + pathPrefix 的提供商会得到与真实请求一致的收据（不再误拒）；
//   · 漂移校验仍然严格：换 host、换端口都必须继续被拒绝；
//   · 真实网关进程 + 本地 mock 上游的整条代理路径（不是只测工具函数）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyCodexAuthReceipt } from '../../../src/index.js'
import { assertResolvedUpstream, isTargetAuthzError, TARGET_DOMAINS } from '../../../src/codex/target-authz.js'
import { upstreamUrl } from '../../../src/request.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const CFG = Object.freeze({ defaults: { codexOfficialHosts: ['127.0.0.1', 'localhost'] }, providers: {} })
const TARGET = Object.freeze({ servingName: 'gpt-6-luna' })

function receipt (over = {}) {
  return verifyCodexAuthReceipt(Object.assign({
    pid: 'official-loopback',
    modelName: 'gpt-6-luna',
    target: TARGET,
    // classifyTarget() 的真实形状：host 只有主机名，端口只在 baseUrl 里（F2 的触发条件）。
    identity: { kind: TARGET_DOMAINS.OFFICIAL, host: '127.0.0.1' },
    prov: { baseUrl: 'http://127.0.0.1:18991', pathPrefix: '', apiKey: 'sk-receipt-test' },
    upstreamPath: '/v1/responses',
    headers: { authorization: 'Bearer sk-receipt-test' },
    cfg: CFG,
    gatewaySubscription: false,
    appPlan: false,
  }, over))
}

function driftOf (resolved, url) {
  try { assertResolvedUpstream(resolved, url) } catch (e) {
    assert.equal(isTargetAuthzError(e), true, '必须是 typed deny')
    assert.equal(e.deny, true)
    return e
  }
  assert.fail('预期漂移被拒绝，实际放行：' + url)
}

test('F2：非默认端口的 loopback 官方目标，收据 host 含端口并被接受', () => {
  const out = receipt()
  assert.equal(out.denied, undefined, '收据不得因端口被拒：' + (out.denied && out.denied.message))
  assert.equal(out.resolved.upstreamHost, '127.0.0.1:18991', '收据必须记录实际发送的 host authority（含端口）')
  assert.equal(out.resolved.upstreamPath, '/v1/responses')
  // 收据与真实出站 URL 完全一致（同源，不是两处拼接）。
  assert.equal(out.resolved.upstreamHost, new URL('http://127.0.0.1:18991/v1/responses').host)
  assert.doesNotThrow(() => assertResolvedUpstream(out.resolved, upstreamUrl({ baseUrl: 'http://127.0.0.1:18991', pathPrefix: '' }, '/v1/responses').href))
})

test('F2 反向：换 host、换端口仍是 send_target_drift（不放松为前缀/主机名匹配）', () => {
  const { resolved } = receipt()
  const otherHost = driftOf(resolved, 'http://127.0.0.2:18991/v1/responses')
  assert.equal(otherHost.code, 'send_target_drift')
  assert.match(otherHost.message, /authorized=127\.0\.0\.1:18991 actual=127\.0\.0\.2:18991/)
  const otherPort = driftOf(resolved, 'http://127.0.0.1:18992/v1/responses')
  assert.equal(otherPort.code, 'send_target_drift')
  assert.match(otherPort.message, /authorized=127\.0\.0\.1:18991 actual=127\.0\.0\.1:18992/)
  // 收据带端口时，主机名形式（去掉端口）也不算一致。
  const noPort = driftOf(resolved, 'http://127.0.0.1/v1/responses')
  assert.equal(noPort.code, 'send_target_drift')
})

test('F3：pathPrefix 提供商的收据 path 是合成后的真实请求路径', () => {
  const prov = { baseUrl: 'https://opencode.ai', pathPrefix: '/inference/go', apiKey: 'sk-receipt-test' }
  const out = receipt({ pid: 'opencodego', identity: { kind: TARGET_DOMAINS.THIRD_PARTY }, prov })
  assert.equal(out.denied, undefined, '收据不得因 pathPrefix 被拒：' + (out.denied && out.denied.message))
  assert.equal(out.resolved.upstreamHost, 'opencode.ai')
  assert.equal(out.resolved.upstreamPath, '/inference/go/v1/responses')
  assert.equal(out.resolved.upstreamPath, upstreamUrl(prov, '/v1/responses').pathname)
  assert.doesNotThrow(() => assertResolvedUpstream(out.resolved, upstreamUrl(prov, '/v1/responses').href))
})

test('F3 复现串：pathPrefix=/v1 时收据是 /v1/v1/responses 而不是 /v1/responses', () => {
  const out = receipt({ prov: { baseUrl: 'http://127.0.0.1:18991', pathPrefix: '/v1', apiKey: 'sk-receipt-test' } })
  assert.equal(out.denied, undefined, '收据不得因前缀重复被拒：' + (out.denied && out.denied.message))
  assert.equal(out.resolved.upstreamPath, '/v1/v1/responses')
  const drift = driftOf(out.resolved, 'http://127.0.0.1:18991/v1/responses')
  assert.equal(drift.code, 'send_target_drift')
  assert.match(drift.message, /authorized=\/v1\/v1\/responses actual=\/v1\/responses/)
})

test('F3 反向：合成路径不同仍是 send_target_drift', () => {
  const out = receipt({
    identity: { kind: TARGET_DOMAINS.THIRD_PARTY },
    prov: { baseUrl: 'https://opencode.ai', pathPrefix: '/inference/go', apiKey: 'sk-receipt-test' },
  })
  const wrong = driftOf(out.resolved, 'https://opencode.ai/v1/responses')
  assert.equal(wrong.code, 'send_target_drift')
  assert.match(wrong.message, /authorized=\/inference\/go\/v1\/responses actual=\/v1\/responses/)
})

test('端到端：真实网关进程把带端口与 pathPrefix 的聚合请求送到上游，零 send_target_drift', async (t) => {
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-6-luna', output: [] }))
  })
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-receipt-'))
  const gw = await startGateway({
    dir,
    env: { MG_TEST_OFFICIAL_KEY: 'gw-official-test-key' },
    config: {
      // loopback 官方 mock：host 白名单显式放行，端口是动态分配的非默认端口（F2 的触发条件）。
      defaults: { codexOfficialHosts: ['127.0.0.1'] },
      providers: {
        'official-loopback': { baseUrl: 'http://127.0.0.1:' + upstream.port, pathPrefix: '/v1/qg', codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' },
        // 只有存在聚合记录时 A4 收据闸门才启用；本 provider 不参与该请求的路由。
        opencodego: {
          baseUrl: 'https://opencode.ai',
          apiKeyEnv: 'MG_TEST_GO_KEY',
          aggregation: { schema: 'modelgate.aggregation.provider/1', id: 'opencodego', kind: 'opencode-go', providerSegment: 'opencodego', enabled: true },
        },
      },
      models: { 'gpt-6-luna': { provider: 'official-loopback', api: 'responses' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop(); await rm(dir, { recursive: true, force: true }) })

  const r = await gw.call('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { model: 'gpt-6-luna', input: 'hi', stream: false },
  })
  const text = await r.text()
  assert.equal(r.status, 200, '带端口与 pathPrefix 的聚合请求必须被接受，实际：' + r.status + ' ' + text)
  assert.equal(text.includes('send_target_drift'), false)
  assert.equal(hits.length, 1, '必须真的到达上游一次')
  // pathPrefix 与响应路径合成后只有一份 /v1（F3 的触发条件：曾经收据只有 /v1/responses）。
  assert.equal(hits[0].url, '/v1/qg/v1/responses')
  assert.equal(hits[0].headers.authorization, 'Bearer gw-official-test-key')
})
