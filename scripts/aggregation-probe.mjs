#!/usr/bin/env node
// A2 / P01：OpenCode 模型发现 live 探针（**未执行，等待所有者批准**）。
//
// 目的：用一次真实调用核对“模型清单端点/形状是假设”这件事，并给出账户实际可用模型的 ID 列表。
// 安全边界：
//   - 只有显式设置 `MG_AGG_LIVE_PROBE=1` 才会发网络请求；否则立即退出（默认永不联网）。
//   - 只做一次发现（默认 max-pages=1），不重试、不缓存、不写目录、不改配置。
//   - 输出只有 counts + 公共 ID/上游 ID + 诊断 code；**绝不**打印 Key、Authorization、账户标识或上游正文。
//   - 凭据只从既有解析链读取（keys.local.json 或 apiKeyEnv 变量），本脚本不读 auth.json。
//
// 建议命令（所有者批准后）：
//   MG_AGG_LIVE_PROBE=1 node scripts/aggregation-probe.mjs --provider opencodego --max-pages 3
//   MG_AGG_LIVE_PROBE=1 node scripts/aggregation-probe.mjs --provider console --max-pages 3
//
// 预期：打印 { completeness, counts, models:[{publicId,upstreamId}] }。若 code 是
// discovery_endpoint_missing / discovery_shape_unrecognized / discovery_pagination_unknown，
// 说明本仓库登记的端点/形状假设不成立——这是有价值的结果，不是“账户没有模型”。

import { configPaths, loadConfig, resolveKey } from '../src/router.js'
import { createRegistry } from '../src/aggregation/registry.js'
import { createDiscoveryEngine } from '../src/aggregation/discovery.js'

function parseArgs(argv) {
  const out = { provider: null, scope: 'local', maxPages: 1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') out.provider = argv[++i]
    else if (a === '--scope') out.scope = argv[++i]
    else if (a === '--max-pages') out.maxPages = Number(argv[++i])
    else if (a === '--help' || a === '-h') out.help = true
  }
  if (!Number.isInteger(out.maxPages) || out.maxPages < 1) out.maxPages = 1
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write('usage: MG_AGG_LIVE_PROBE=1 node scripts/aggregation-probe.mjs --provider <id> [--scope local] [--max-pages 3]\n')
    return 0
  }
  if (String(process.env.MG_AGG_LIVE_PROBE || '') !== '1') {
    process.stderr.write('refused: live probe is gated. Set MG_AGG_LIVE_PROBE=1 only after owner approval.\n')
    return 3
  }
  if (!args.provider) {
    process.stderr.write('refused: --provider <id> is required\n')
    return 2
  }
  const paths = configPaths()
  const cfg = loadConfig()
  const registry = createRegistry({ paths, readConfig: () => cfg })
  const provider = registry.getProvider(args.provider)
  if (!provider) {
    process.stderr.write('provider not found in aggregation registry: ' + args.provider + '\n')
    return 2
  }
  const def = (cfg.providers || {})[provider.id] || {}
  const resolved = resolveKey(cfg, def, provider.id)
  const credential = resolved && resolved.key ? resolved.key : undefined
  const engine = createDiscoveryEngine({ registry, cfg })
  const result = await engine.discover(provider, {
    credential,
    scope: args.scope,
    maxPages: args.maxPages,
    cache: null,
  })
  const ids = (result.snapshot ? result.snapshot.models : []).map((m) => ({ publicId: m.publicId, upstreamId: m.upstreamId }))
  const out = {
    providerId: provider.id,
    kind: provider.kind,
    scope: args.scope,
    completeness: result.completeness,
    code: result.code || null,
    counts: result.counts || null,
    models: ids,
    diagnostics: (result.diagnostics || []).map((d) => d.code),
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  return result.ok && result.completeness === 'discovery_complete' ? 0 : 1
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  process.stderr.write('probe failed: ' + ((error && error.code) || (error && error.name) || 'error') + '\n')
  process.exitCode = 1
})
