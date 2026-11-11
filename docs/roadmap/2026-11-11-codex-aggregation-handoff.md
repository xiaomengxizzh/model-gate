# Codex 聚合交付 HANDOFF（2026-11-11）

> 一句话：E1–E8 已实现并验证，Draft PR #6 待评审；M2 被 v2 加密任务边界显式阻断；正式环境零改动。

## 1. 从哪里看起

| 目的 | 文档 |
| --- | --- |
| 验收矩阵 / 门禁真值 / 回滚 / NOT_RUN | [E9 验收](2026-11-11-codex-aggregation-e9-acceptance.md) |
| 为什么这样设计（D1-A/D2） | [ADR-0002](../explanation/adr-0002-codex-aggregation-identity.md) |
| 真实同线程切换证据（真官方 + 真第三方） | [E3 证据](../evidence/2026-11-11-e3-live-switching.md) |
| M2 为何阻断 | [M2 取证](../evidence/2026-11-11-e4-v2-live-blocked.md)、[v1 取证](../evidence/2026-11-11-e4-v1-probe.txt) |
| 配置写入语义 | [Codex 管理面 API](../reference/codex-api.md)、[目录契约](../reference/codex-catalog.md) |
| E0 事实审计与隔离基线 | [E0 基线](2026-11-11-codex-aggregation-e0-baseline.md) |
| 所有者锁定的 D1–D7 计划 | [执行计划](2026-11-10-codex-aggregation-d1-d7-execution-plan.md) |

## 2. 代码地图

```text
src/codex/
  identity.js   身份域判定（official / thirdParty / unknown）
  auth.js       请求头防火墙 + 官方 host/scheme/path 白名单
  catalog.js    Codex 完整目录生成/校验/稳定 ID/版本回滚
  interop.js    namespace 工具可逆映射、call_id 配对、v2 加密判定
  config.js     受控 config.toml 写入（原子/备份/409）
  api.js        /api/codex/*（policy / config plan·apply·rollback / catalog status）
  history.js    历史只读诊断 + 迁移预演（写入 not_authorized）
  quota.js      额度 UNKNOWN 语义 + 手动应急状态机
src/routing/decision.js   Fallback 决策状态机（接入 src/forward.js）
src/index.js              官方透传代理、zstd 解码、Codex /v1/models、API 挂载
```

配置字段：`defaults.codexCatalogBasePath`、`defaults.codexOfficialProvider`、`defaults.codexOfficialHosts`、
`defaults.aggregatePrefixes`、`defaults.codexFallback/codexEmergency/codexBudget`、`defaults.codexQuota`、
环境变量 `MG_CODEX_OFFICIAL_PASSTHROUGH`。

## 3. 五分钟复现（全部离线）

```bash
cd workplace/idproject/model-gateway-codex-agg
npm test                     # 45/45
npm run check && npm run docs:check && node scripts/check-metadata.mjs

# 目录：生成 + 回滚
node scripts/test/codex-catalog-rollback.mjs
# 配置写入链（隔离目录）
node scripts/test/codex-config-e2e.mjs
# 真客户端（需 CODEX_BIN，上游为本地 mock）
CODEX_BIN=<codex> node scripts/test/codex-e2e.mjs
```

需要真实官方/第三方时（会产生真实请求，需授权）：
`codex-live.mjs`（官方 + mock 第三方）、`codex-live-real.mjs`（官方 + 真实 OpenCode Go）。

## 4. 未完成与决策点

| 项 | 状态 | 需要的动作 |
| --- | --- | --- |
| 合并 PR #6 | Draft | 所有者评审后合并（本项目不擅自合并） |
| 真实 `~/.codex/config.toml` 写入 + 重载 | NOT_RUN | D5 逐次确认 + 备份 |
| Desktop GUI 端到端 | 二进制已验，GUI NOT_RUN | 关闭当前 Desktop 或授权第二实例 |
| 真实历史迁移 | 演练 11/11，真实 NOT_RUN | 逐条授权 + 备份/回滚 |
| 真实额度应急 | 流程 13/13，真实 NOT_RUN | 可信额度源 + 独立实例 |
| M2 跨供应商子代理 | 显式阻断 | 需客户端明文委派能力（0.167 不具备） |

## 5. 回滚

- 分支整体：`git revert <commits>`；PR #6 可直接关闭并删除远端分支。
- 无配置/数据迁移；未触碰 `~/.codex`、systemd、8787；临时 CODEX_HOME 与凭据副本均已删除。

## 6. 已知风险

- 官方订阅流量经本地网关的条款边界由所有者判断（本轮仅授权测试）。
- 目录整体替换语义：生成器缺字段会直接让客户端解析失败（已用校验闸门兜住）。
- 多写者写同一 state 目录语义未定义（并发探测仅证明 5 轮未损坏）。
- WebSocket 传输未代理，依赖客户端回落 HTTPS。
