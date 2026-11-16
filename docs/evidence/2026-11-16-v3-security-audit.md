# A4 安全与路由：离线审计与回归证据（2026-11-16）

> 证据等级：**离线/源码判定 + 纯函数与 handler 层测试**。未连接真实付费上游、未触碰真实 `~/.codex`、
> 未改生产 `config/*.local.json`、未连接运行中的网关进程（PID 323092）、未安装任何依赖。
> 本文件不是发布批准，也不代表真实模型/原版 Desktop 通过。

## 基线

- 仓库：`xiaomengxizzh/model-gate`；分支 `fix/mg-a4-security`（基于 `9a371d3`），独立 worktree。
- 修复测试提交：`498a23255c48aa9cf6f6814d19eac76f60eb091c`。
- 固定任务书：`docs/roadmap/2026-11-16-modelgate-remediation-audit-and-start.md`（MG-FIX-P1-03 / P2-08 / P1-04）。

## 范围与写集

本代理拥有的产品文件：`src/providers/opencode-go.js`、`src/codex/target-authz.js`、`src/codex/auth.js`、
`src/subscription/*`。本次**未修改任何产品源码**（现有防线已满足任务约束，避免重复修复），只新增两份离线测试与证据文档。
未触碰 MAIN 拥有的 `src/aggregation/api.js` 等文件。

## 1. 授权域隔离与无静默回退（审计结论：现有防线充分，无需改动）

逐项核对既有实现与既有测试，确认以下不变量成立且已有回归覆盖：

- `src/codex/target-authz.js` `assertCredentialOriginDomain()`：`codex-subscription` / `siwc-app` / `api-key`
  三域来源必须等于出站授权域，跨域 typed 403；消息只带域名（`credential_domain_mismatch`）。
- `classifyAuthDomainFailure()` / `authFailureReceipt()` / `authFailureResponse()`：401/402/403 与配额型 429
  为授权域终态，`fallbackAllowed=false / rewriteModel=false / rewriteStatus=false`，按真实域回传，不被吞成
  `all_providers_failed`；速率型 429 仅同域重试，仍 `fallbackAllowed=false`。
- `src/subscription/isolation.js`：凭据来源域租约，token 不可枚举、`toJSON` 脱敏，loopback 例外仅订阅域且需显式开启。
- `src/providers/opencode-go.js`：`GoError` / `failurePolicy()` / `readiness()` 对 Go 失败一律
  `allowModelSwitch=false / allowProviderSwitch=false`，4xx 终结、未知模型 typed 拒绝。
- `src/codex/auth.js`：第三方目标剥除官方专用头与凭据头；extraHeaders 不得注入鉴权头。

既有覆盖：`agg-v2-auth-domains`、`agg-v2-auth-isolation`、`agg-v2-subscription-guards`、`agg-auth-leak`、
`p03-opencode-go`、`agg-v2-go-routing`、`admin-origin`、`admin-secrets`。本次回归实跑其中三套共 25/25 通过。

## 2. MG-FIX-P2-08：发现完成态（红灯测试 + 给 MAIN 的修复建议）

- 新测试 `scripts/test/offline/agg-v2-security-discovery-state.test.mjs`，通过公开 HTTP 面
  `GET /api/aggregation/models → body.discovery`（真实 `handleAggregationApi`，隔离 `MG_CONFIG_DIR`）驱动
  `src/aggregation/api.js` 的 `discoverySummary()`。
- 复现条件：2 个 provider，仅 1 个有完整快照（其余从未同步）。当前源码返回
  `{state:'complete', complete:true, providersComplete:false}` —— UI 读 `state/complete` 显示假“已准备就绪”。
- 当前结果：3 用例中 1 失败（刻意保留的红灯）、2 通过。该红灯**预期在 MAIN 修复前失败**，未被删除或放宽。
- 给 MAIN 的最小修复（`discoverySummary()`，api.js:166–196）：收集快照时记录 `missing`（无快照的 provider id）；
  在 `partial` 分支之后、`complete` 返回之前插入
  `if (missing.length) return {state:'partial', complete:false, discovered, reason:'providers_not_synced', missingProviders:missing, truncated:true}`；
  最终 `complete` 返回的 `providersComplete` 改为 `true`（此时 missing 为空）。保留空/失败分支不变。
- 修复验证：在临时副本套用该补丁后 3/3 全绿；临时副本已删除，未提交产品改动。

## 3. 负向测试（新文件 `agg-v2-security-auth-invariants.test.mjs`，7/7 通过）

1. 显式官方模型 ID（`gpt-6-luna`）打到 Go：`mapModel`/`identityOf`/`readiness` 全部 typed 拒绝，
   `vendorModel` 为空，绝不静默映射为 deepseek（P1-03 边界）。
2. V2 目标模型仍可正常映射（证明拒绝来自策略，不是全盘失效）。
3. 401/402/403/配额 429 在三域均 terminal，不改写模型/状态、不夹带其它授权域。
4. 速率型 429 同域可重试但仍不产生 fallback 收据。
5. 令牌/账号在租约序列化、跨域拒绝消息、错误 Bearer/sk-/JWT 解码中均不出现。
6. 缺 `explicitAdmin` 的聚合写 → 403 `explicit_admin_required`，零写入。
7. 非回环来源的聚合写 → 403 `aggregation_loopback_required`（回环地址不等于永久管理员）。

说明：跨源 Origin/Host 绑定与远程管理令牌的 HTTP 层负向用例已由 `admin-origin.test.mjs` 覆盖；handler 层
`explicitAdmin`/`isLocal` 守卫由本文件补充。两者均未修改 MAIN 拥有的产品代码。

## 测试命令与结果（SHA `498a232`）

| 命令 | 结果 |
| --- | --- |
| `node --test scripts/test/offline/agg-v2-security-discovery-state.test.mjs` | 3 tests, 2 pass, 1 fail（P2-08 红灯，预期） |
| `node --test scripts/test/offline/agg-v2-security-auth-invariants.test.mjs` | 7 tests, 7 pass, 0 fail |
| 两文件合并运行 | 10 tests, 9 pass, 1 fail（唯一失败为红灯） |
| `node --test agg-v2-auth-domains / agg-v2-auth-isolation / p03-opencode-go` | 25 tests, 25 pass, 0 fail（无回归） |
| `node --check`（2 新测试 + 5 个拥有模块共 11 文件） | 全部 OK |

## 失败项 / 阻断 / 待办

- 唯一红灯为 MG-FIX-P2-08，根因在 MAIN 拥有的 `src/aggregation/api.js`，本代理无权修改；已提供精确修复建议，
  待 MAIN 应用后转绿。**不删除、不放宽、不伪造 PASS_REAL。**
- 本轮无真实付费模型调用授权，所有真实/GUI 项标 BLOCKED；本证据不涉及真实上游。

## 回滚

本次仅新增 3 个文件（2 测试 + 本证据），无产品代码改动。回滚即删除这 3 个文件并撤销提交 `498a232`；
对 MAIN 的 api.js 修复建议若被采纳，其回滚由 MAIN 在其提交内单独负责。
