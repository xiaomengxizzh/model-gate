// A3 / P03：聚合视图的结构性契约测试（无 DOM）。
// 证明模块可解析、导出契约已接线、诚实性判定与端到端静态不变量成立。
// 真实 GUI 行为不在此处冒充；见交付报告中的手动验证脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VIEW = join(ROOT, 'src/ui-next/js/views/aggregation.js')

async function loadView () {
  return import(new URL('../../../src/ui-next/js/views/aggregation.js', import.meta.url))
}

test('聚合视图：模块解析并导出稳定契约与 ADR §5 的 8 条路径', async () => {
  const mod = await loadView()
  assert.equal(mod.AGGREGATION_VIEW_CONTRACT, 'mg-ui-aggregation/1')
  assert.equal(typeof mod.render, 'function')
  assert.ok(mod.render.length >= 1, 'render(root, ctx) 签名')
  const ep = mod.AGGREGATION_ENDPOINTS
  assert.equal(ep.providers, '/api/aggregation/providers')
  assert.equal(ep.provider('opencode-go'), '/api/aggregation/providers/opencode-go')
  assert.equal(ep.sync('opencode-go'), '/api/aggregation/providers/opencode-go/sync')
  assert.equal(ep.models, '/api/aggregation/models')
  assert.equal(ep.health, '/api/aggregation/health')
  assert.equal(ep.diagnostics, '/api/aggregation/diagnostics')
  assert.equal(ep.activate, '/api/aggregation/activate')
  assert.equal(ep.deactivate, '/api/aggregation/deactivate')
  assert.equal(Object.isFrozen(ep), true)
})

test('模型数量诚实性：失败/部分/空目录/未知各走独立分支，绝不把失败读成 0', async () => {
  const mod = await loadView()
  const failed = mod.summarizeDiscovery({ discovery: { state: 'failed', code: 'upstream_403', discovered: 0 } }, [])
  assert.equal(failed.state, 'failed')
  assert.equal(failed.kind, 'bad')
  assert.equal(failed.countText, null)
  assert.match(failed.detail, /不是“0 个模型”|不是.*0 个模型/)

  const partial = mod.summarizeDiscovery({ discovery: { state: 'partial', discovered: 7, reason: 'page_limit' } }, new Array(7).fill({}))
  assert.equal(partial.state, 'partial')
  assert.equal(partial.countText, '已获取 7 个（非完整）')
  assert.match(partial.detail, /不是完整目录/)

  const truncated = mod.summarizeDiscovery({ discovery: { complete: false, discovered: 3 } }, [])
  assert.equal(truncated.state, 'partial', 'complete=false 也必须按未完成展示')

  const empty = mod.summarizeDiscovery({ discovery: { state: 'complete', complete: true, upstreamConfirmedEmpty: true } }, [])
  assert.equal(empty.state, 'empty_confirmed')
  assert.match(empty.countText, /0 个（上游明确返回空目录）/)

  const complete = mod.summarizeDiscovery({ discovery: { state: 'complete', complete: true } }, [{}, {}, {}])
  assert.equal(complete.state, 'complete')
  assert.equal(complete.countText, '3 个模型')

  const unknown = mod.summarizeDiscovery(null, null)
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.countText, null)
  assert.match(unknown.detail, /不能把空列表读成“0 个模型”/)
})

test('激活请求与冲突描述：只回传 consentToken + expectedSha，409 只展示三方差异', async () => {
  const mod = await loadView()
  assert.deepEqual(mod.buildActivateRequest({ consentToken: 'cf_1', expectedSha: 'abc' }, false), { consentToken: '', expectedSha: 'abc' })
  assert.deepEqual(mod.buildActivateRequest({ consentToken: 'cf_1', expectedSha: 'abc' }, true), { consentToken: 'cf_1', expectedSha: 'abc' })

  const none = mod.describeThreeWay({ detail: {} })
  assert.equal(none.available, false)
  const described = mod.describeThreeWay({
    detail: {
      threeWay: {
        base: { sha256: 'a'.repeat(64) },
        ours: { sha256: 'b'.repeat(64) },
        theirs: { sha256: 'c'.repeat(64) },
        oursVsTheirs: [{ kind: 'same', text: 'x' }, { kind: 'add', text: 'y = 1', redacted: false }],
        guidance: 'keep',
      },
    },
  })
  assert.equal(described.available, true)
  assert.equal(described.rows.length, 1, '只展示非 same 行')
  assert.match(described.summary, /基准 aaaaaaaa/)
  assert.equal(described.guidance, 'keep')
})

test('聚合视图源码：无注入 sink、无持久化、覆盖激活/退出/冲突/重启与诚实提示', () => {
  const src = readFileSync(VIEW, 'utf8')
  assert.doesNotMatch(src, /innerHTML\s*=/)
  assert.doesNotMatch(src, /insertAdjacentHTML/)
  assert.doesNotMatch(src, /localStorage\.(set|get)Item|sessionStorage|indexedDB/)
  assert.doesNotMatch(src, /from\s+['"][^'"]*codex\//, '视图不得 import 后端实现')
  for (const ep of ['/api/aggregation/activate', '/api/aggregation/deactivate', '/api/aggregation/providers', '/api/aggregation/models', '/api/aggregation/health', '/api/aggregation/diagnostics']) {
    assert.ok(src.includes(ep), 'missing endpoint: ' + ep)
  }
  assert.match(src, /不是“0 个模型”/, '失败路径必须明确否定 0')
  assert.match(src, /非完整/, '部分发现必须标注非完整')
  assert.match(src, /拒绝覆盖/, '冲突路径必须拒绝覆盖')
  assert.match(src, /三方差异|threeWay/, '必须展示三方差异')
  assert.match(src, /需要重启 Codex/, '必须给出重启提示')
  assert.match(src, /不编辑 TOML、不碰 auth\.json/, '必须声明零手工配置边界')
  assert.match(src, /一次性确认/, '必须体现一次同意交互')
  assert.match(src, /PASS_MOCK ≠ PASS_REAL|PASS_REAL/, '不得把 UI 当真实 GUI 验收')
})

test('共享入口：providers 与 clients 页只做增量链接，旧视图结构不变', () => {
  const providers = readFileSync(join(ROOT, 'src/ui-next/js/views/providers.js'), 'utf8')
  const clients = readFileSync(join(ROOT, 'src/ui-next/js/views/clients.js'), 'utf8')
  assert.match(providers, /#\/aggregation/)
  assert.match(clients, /#\/aggregation/)
  assert.match(providers, /export function render\s*\(\s*root, ctx = \{\}/, 'providers render 签名保持')
  assert.match(clients, /export function render\s*\(\s*root, ctx = \{\}/, 'clients render 签名保持')
  assert.match(clients, /modelgate-client-export\/1/, 'clients 既有导出契约保持')
})

test('F6 回归：404 提示不得再声称后端未接线/需要主代理打补丁（路由已由 /api/aggregation/* 提供）', () => {
  const src = readFileSync(VIEW, 'utf8')
  // 曾经的过期文案：把已接线的路由说成 404 未接线，并让用户去找交付报告里的补丁。
  assert.doesNotMatch(src, /尚未接线/, '不得再声称聚合接口尚未接线')
  assert.doesNotMatch(src, /后端还没有把\s*\/api\/aggregation/, '不得再声称后端没有挂载聚合路由')
  assert.doesNotMatch(src, /交付报告中的精确补丁/, '不得再让用户去找不存在的接线补丁')
  // 404 仍然需要解释，但解释必须指向真实原因（版本/实例未加载模块）。
  assert.match(src, /404/, '仍须说明 404 的含义')
  assert.match(src, /版本较旧|升级到提供/, '必须给出可执行的版本/实例原因')
  // 渲染条件不变：只有 routeMissing 时才显示该提示。
  assert.match(src, /if \(AGG\.routeMissing\) root\.append\(routeNotice\(ctx\)\)/)
})
