# ADR-0002：Codex 多供应商聚合身份与目录（D1-A / D2）

- 状态：Accepted（2026-11-11，未合并草稿分支）
- 决策来源：[D1–D7 执行计划](../roadmap/2026-11-10-codex-aggregation-d1-d7-execution-plan.md)（所有者锁定）
- 实现证据：[E9 验收矩阵](../roadmap/2026-11-11-codex-aggregation-e9-acceptance.md)、[E3 同线程切换证据](../evidence/2026-11-11-e3-live-switching.md)

## 背景

Codex 0.167 的会话绑定 provider：`/model` 只列当前 provider 的目录，`exec resume` 跨 provider 直接 `modelProviderMismatch`。
要让官方 GPT 与第三方模型在**同一会话**切换，不能新增 `model_providers.<x>` 让用户切 provider，只能让两者共享**同一个 Codex provider 身份**，由网关按模型选择上游。

## 决策

| # | 决策 | 落地 |
| --- | --- | --- |
| 1 | 复用内置 `openai` 身份 | Codex 侧只写 `model_provider="openai"` + 顶层 `openai_base_url`；**禁止**写 `[model_providers.openai]`（0.167 报 reserved built-in provider IDs，启动失败） |
| 2 | 网关按模型选上游 | `classifyTarget()` 判定 official/thirdParty/unknown；官方 slug → 官方后端（`/backend-api/codex/responses`），`mg-*` 聚合 slug → 第三方 + Chat 桥 |
| 3 | 动态本地目录 | `defaults.codexCatalogBasePath`（`codex debug models` 导出）+ 已配置第三方 → `buildCatalog()`；`GET /v1/models?client_version` 返回 `{models:[…]}`，与 `model_catalog_json` 同形 |
| 4 | 凭据分域 | 官方专有头只在官方目标放行；第三方一律剥离。客户端官方凭据透传默认关闭（`MG_CODEX_OFFICIAL_PASSTHROUGH=1` 才开） |
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
