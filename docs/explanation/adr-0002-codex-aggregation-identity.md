# ADR-0002：Codex 多供应商聚合身份与目录（D1-A / D2）

- 状态：Accepted（2026-11-11，未合并草稿分支）；**F01 修订（2026-11-12）**：官方原生凭据透传与 `/backend-api/codex` 入口已移除，官方目标只保留 API Key 直连（见下决策 2/4 的删除线说明）；**G1 修订（2026-11-13）**：`gatewaySubscription`（网关读取本机 Codex 登录态并代理订阅后端）已从生产路径退役，残留配置与旧模式一律 fail-closed（见文末修订）
- 决策来源：[D1–D7 执行计划](../roadmap/2026-11-10-codex-aggregation-d1-d7-execution-plan.md)（所有者锁定）
- 实现证据：[E9 验收矩阵](../roadmap/2026-11-11-codex-aggregation-e9-acceptance.md)、[E3 同线程切换证据](../evidence/2026-11-11-e3-live-switching.md)

## 背景

Codex 0.167 的会话绑定 provider：`/model` 只列当前 provider 的目录，`exec resume` 跨 provider 直接 `modelProviderMismatch`。
要让官方 GPT 与第三方模型在**同一会话**切换，不能新增 `model_providers.<x>` 让用户切 provider，只能让两者共享**同一个 Codex provider 身份**，由网关按模型选择上游。

## 决策

| # | 决策 | 落地 |
| --- | --- | --- |
| 1 | 复用内置 `openai` 身份 | Codex 侧只写 `model_provider="openai"` + 顶层 `openai_base_url`；**禁止**写 `[model_providers.openai]`（0.167 报 reserved built-in provider IDs，启动失败） |
| 2 | 网关按模型选上游 | `classifyTarget()` 判定 official/thirdParty/unknown；官方 slug → 官方**直连**（`/v1/responses`，网关自有 key），`mg-*` 聚合 slug → 第三方 + Chat 桥。F01 删除：官方订阅后端路径 `/backend-api/codex/responses` |
| 3 | 动态本地目录 | `defaults.codexCatalogBasePath`（`codex debug models` 导出）+ 已配置第三方 → `buildCatalog()`；`GET /v1/models?client_version` 返回 `{models:[…]}`，与 `model_catalog_json` 同形 |
| 4 | 凭据分域 | 官方专有头只在官方目标放行；第三方一律剥离。官方目标凭据**只来自网关自有 key**。F01 删除：客户端官方凭据透传（原 `MG_CODEX_OFFICIAL_PASSTHROUGH` 开关）——无 key 时 403 `official_no_gateway_key` / 旧开关残留时 403 `official_passthrough_retired`，均零发送 |
| 5 | 传输现实 | 请求体可能是 `content-encoding: zstd`；客户端先试 WebSocket，网关回 404 促其回落 HTTPS |
| 6 | v2 加密任务 | 含 `encrypted_content`/`encrypted_task_id` 的任务在桥方向显式 `v2_encrypted_task_unsupported`；不解析/不删除/不伪造/不降级 |

## 被否方案

- **新增自定义 provider 让用户切换**：会话绑 provider，切换即 `modelProviderMismatch`，无法满足 M1。
- **把 `/v1/models` 的 OpenAI list 形状直接喂给 Codex**：客户端 `failed to decode models response`，resume 必失败。
- **尝试解密 v2 任务以跨供应商重放**：违反 D3，且密文语义不可控；已实测为显式阻断点。
- **全局切回 v1 绕过加密任务**：计划明令禁止；本项目只做显式判定。

## 后果

正面：M1（同线程 GPT→第三方→GPT）在真实官方后端 + 真实第三方上游下成立；路由/目录/凭据边界均可离线回归。
代价与边界：
- 官方流量经本地网关，条款/政策边界需所有者判断（当前仅授权测试，未产品化）。
- 目录是整体替换语义，生成器必须输出完整 `ModelInfo`，缺字段即客户端解析失败；第三方条目继承官方 `base_instructions`（体积随第三方数增长）。
- 网关不支持 WebSocket 传输时依赖客户端回落；若未来客户端不再回落，需要 WS 代理。
- M2（v2 跨供应商子代理）被加密任务边界阻断，需要「明文重新委派」或上游原生理解密文的方案，均需单独设计授权。

## 未来触发点

- 若 Codex 取消 `openai_base_url` 或改为强制 per-thread provider（需重新评估 D1-A）。
- 若上游提供原生 Responses 且能理解加密任务（重新评估 M2）。
- 若官方政策明确禁止本地代理官方流量（回退为官方直连 + 第三方独立 provider）。

## 修订：2026-11-13 G1 —— gatewaySubscription 退役

- 背景：11 月 13 日实验分支的 `src/codex/local-subscription.js` 读取 `CODEX_HOME/auth.json` / `~/.codex/auth.json`，再由网关向 `chatgpt.com/backend-api/codex/responses` 发送本机 Codex token。这与 F01 的“不读取登录态、官方目标只认网关自有 key”结论冲突，也缺少公开 SIWC 文档授权（SIWC 要求应用使用自己经授权流程获得的 token，而不是读取另一个 Codex 安装目录的登录态）。
- 决策：删除 `local-subscription.js` 与 `src/index.js` 的 `gatewaySubscription` 发送分支；`/backend-api/codex` 永不进入官方路径白名单；`src/codex/target-authz.js` 移除 `GATEWAY_SUBSCRIPTION` 凭据模式，只保留对旧调用方的 typed retired 识别。生产代码不读取、不复制、不刷新、不持久化 Codex 登录态，也不向订阅后端发送本机 token。
- 行为（用户可观察）：配置仍可加载；残留 `providers.<id>.gatewaySubscription.enabled=true` 在官方原生 `/v1/responses`、第三方原生 `/v1/responses`、官方 Chat 桥三个入口都返回 403 `gateway_subscription_retired`，零上游请求、不重试、不换账号、不改投其它候选。启动时写一条退役告警。`/api/status` 的 `gatewaySubscription` 恒为 false，旧配置另以 `gatewaySubscriptionRetired` 暴露。
- 迁移：官方目标配置网关自有 `apiKeyEnv`/面板 Key（与 F01 相同）；第三方子任务使用 OpenCode Go provider。用户自己的 Codex 客户端原生登录直连官方服务，不再经 ModelGate 反向代理。
- 不变：决策 1/2/3/5/6 继续有效；官方自有 key 直连、客户端官方头零透传、V2 密文 fail-closed、P07 SIWC 合成预览默认关闭均未改变。
- 证据：[2026-11-13 认证边界退役证据](../evidence/2026-11-13-auth-boundary-retirement.md)；静态扫描与三入口零上游回归见 `scripts/test/offline/native-boundary.test.mjs`、`scripts/test/offline/codex-p09-native-proxy.test.mjs`。
