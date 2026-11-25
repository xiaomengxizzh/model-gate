# A1｜源码级外部研究与内部后端审计

- 日期：2026-11-24
- ModelGate 采集树：`48325bf0027e583108c66677c7dec15fd5007228`
- 方法：本地文件只读审计 + 官方 GitHub release/commit 源码只读研究。未 clone、下载依赖、运行参考服务或调用付费上游。
- 结论：**A1 源码研究与 ADR 完成；外部版本仅代表研究时快照，不构成 ModelGate 生产验收。**

## 1. ModelGate 真实后端（实现真源）

| 机制 | 源码证据 | 可复用 | 不可直接复用/缺口 |
| --- | --- | --- | --- |
| 配置与 Key 同代事务 | `src/config-transaction.js:143-183,218-380`；`src/index.js:634-640,1312-1318` | 目录锁、旧/新指纹、journal、commit marker、fsync/rename、崩溃恢复、409 | 缺省 `version` 仍宽容；defaults 顶层合并且不能删字段；需资源级 preview/impact |
| 管理 API | `src/index.js:2858-2966`；`src/aggregation/api.js:481-737`；`src/codex/api.js:112-123` | status/config/keys/route-preview、聚合 modes/switch/rollback/reconcile、Codex plan/apply | 无通用 service/connection/model/pool/template/backup 资源层；不得另造平行写通道 |
| 虚拟模型/路由 | `src/router.js:385-394,539-575`；`src/forward.js:287-303,1077-1099` | 有序目录、onFail/afterAll、provider 白名单、quota、QPS/并发、独立 Key | 不是命名多池；无 member weight/稳定 poolId/双向引用 |
| 字段保留 | `src/index.js:1503` | 现有校验与 meta 三态 | `cleanVms` 只保留固定字段，池扩展字段会被静默丢弃，A4 前必须修复并加回归 |
| 账户身份 | `src/router.js:337-349`；`src/aggregation/registry.js:161-174,413-418` | provider Key/env 解析 | 一 provider 一 Key；注册表禁止同 kind 第二实例；无 connectionId/quotaScope/cooldown |
| 请求预算 | `src/budget.js:10-19`；`src/request.js:569-613`；`src/forward.js:1187-1189` | 单一 AbortSignal 已贯穿排队/连接/头/流/续传 | 默认 `overallMs=0`；持续 SSE 可无限运行。正常长任务不强制硬超时，但故障/恢复等待必须有独立总预算 |
| Codex 三模式 | `src/codex/profiles.js:9-69`；`src/codex/desktop-integration.js:984-992`；`src/aggregation/api.js:347-375` | official/route/aggregated、预览/consent/备份/回滚 | route 父子固定同一 Go slug；HTTP switch 只透传 mode/parentModel，child 固定，不能宣称角色池已可配 |
| 原生能力 | `src/codex/interop.js`、`chat-compat.js`、`catalog.js`；`src/responses-continuation.js` | 原生 Responses、工具历史重建、第三方能力过滤、Codex 自有压缩路径 | 不得自建压缩；Chat 桥不等于 native tools/compaction；真实同子恢复与 GUI 仍 BLOCKED |
| 用量/日志 | `src/index.js:2865,3823-3834`；`src/logger.js:45-50,77-107`；`src/observability/events.js:12-18,74-113` | 90 天分桶、脱敏、轮转、内存 observability ring | model-stats 漏虚拟 slug；30s 落盘有崩溃窗口；日志非结构化分页；ring 易失且 UI 未消费 |
| 备份 | `src/config-transaction.js:369-370`；`src/codex/config.js:579-624`；`src/aggregation/catalog.js:573-653` | 事务旧代际、Codex `.bak/.bak.prev`、目录整代历史 | 无通用 Web 备份/恢复 API；Codex backupId 重启失效；不能把事务恢复当用户备份 |
| 现有 UI | `src/ui-next/js/router.js:10-87`；`api.js:78-107`；`store.js:263-381`；`product-status.js:579-667` | 共享状态投影、CAS 草稿、Key 独立通道、429/403/409 处理 | 8 个 hash 路由与 R2 六项一级导航不同；作为旧生产入口保留，A2 另建 `/ui-vnext` |

## 2. CC Switch（本机已有，不重复下载）

- 实际路径：`$HOME/ai/projects/cc-switch`（66 MB）与 `/usr/bin/cc-switch`。
- 版本：**4.0.27**；本机 deb 元数据和二进制启动串一致。二进制 SHA256 均为 `69ba4f2c…072a203`（完整值由本机文件重新计算，不在报告中猜测）。
- 重要限制：该目录只有 deb、解压二进制和 desktop 文件，没有 `.git`、Rust/TS 源码或 package.json；因此 commit 与源码行号 **UNKNOWN**。不能把内存解压 JS/二进制偏移称为源码仓库证据。
- 可观察机制：Tauri 2.10.3/Rust/React；providers 与 AuthBinding 分离（二进制偏移 `0x3a4ab9/0x3a8ff7`）；Codex live/editor 与 original_config 备份（`0x2bc1e9/0x2cb994/0x3a6ce9`）；`/models` 发现与同源 catalog URL（`0x2e4faa/0x2bc801`）；健康/流式检测/用量（`0x3a62df/0x3a0cc5`）；keyring 引用 `go-keyring-base64:`（`0x650408`）。
- 复用：供应商与账户绑定分层、编辑冲突、备份/回滚 UX、目录缓存/回退、凭据引用而非前端持有。
- 不复用：Tauri 桌面运行时、Codex CLI 切换语义、无法证明的崩溃原子性和文件权限；ModelGate 继续使用 Node 事务与现有加密 Key 库。

## 3. Sub2API v0.2.25

- Release commit：`348997267d756eab5729bb6b78a275a15d18796a`（2026-11-24）；main 当时 `0f66714`。
- 账户：AES-256-GCM、PUT 保留未重提秘密：[`aes_encryptor.go:16-59`](https://github.com/Wei-Shaw/sub2api/blob/348997267d756eab5729bb6b78a275a15d18796a/backend/internal/repository/aes_encryptor.go#L16-L59)、[`account_credentials_redact.go:5-45`](https://github.com/Wei-Shaw/sub2api/blob/348997267d756eab5729bb6b78a275a15d18796a/backend/internal/service/account_credentials_redact.go#L5-L45)。
- 调度：粘性会话、优先级、负载、失败账户排除、复合路由：[`gateway_scheduling.go:51-185`](https://github.com/Wei-Shaw/sub2api/blob/348997267d756eab5729bb6b78a275a15d18796a/backend/internal/service/gateway_scheduling.go#L51-L185)。
- 重试/并发：指数退避、同账号后跨账号、账号/用户槽位：[`gateway_forward.go:33-94`](https://github.com/Wei-Shaw/sub2api/blob/348997267d756eab5729bb6b78a275a15d18796a/backend/internal/service/gateway_forward.go#L33-L94)、[`concurrency_service.go:21-34`](https://github.com/Wei-Shaw/sub2api/blob/348997267d756eab5729bb6b78a275a15d18796a/backend/internal/service/concurrency_service.go#L21-L34)。
- 复用：发现/映射分层、选路与槽位分离、失败归因后冷却、TTFT/切换指标。
- 不复用：Redis/DB 多账户商业池、利润/计费门、分布式槽位；不适合零依赖单机配置。

## 4. Portkey Gateway v1.15.2

- Release commit：`ca7712947ec8c0887803990b746740d36011c697`（2026-01-12）；研究时 main 已到 `669825c`，结论绑定 release。
- 路由：fallback、加权、条件路由：[`handlerUtils.ts:662-723`](https://github.com/Portkey-AI/gateway/blob/ca7712947ec8c0887803990b746740d36011c697/src/handlers/handlerUtils.ts#L662-L723)。
- 重试：状态码/次数、Retry-After 与截止时间：[`retryHandler.ts:84-180`](https://github.com/Portkey-AI/gateway/blob/ca7712947ec8c0887803990b746740d36011c697/src/handlers/retryHandler.ts#L84-L180)。
- 日志：目标索引、耗时、span：[`logsService.ts:36-92`](https://github.com/Portkey-AI/gateway/blob/ca7712947ec8c0887803990b746740d36011c697/src/handlers/services/logsService.ts#L36-L92)。
- 复用：策略树、状态码 fallback、总等待上限、逐尝试日志。
- 不复用：客户端请求头携带上游 Key、正文日志、外部 validator；OSS 未发现完整断路器/并发实现，不能据此宣称已有。

## 5. LiteLLM v1.110.3

- Release commit：`e76668a4719faaa3f8ad68c2c5c42c45211f8135`。
- Deployment 分离公共模型/上游/能力：[`types/router.py:802-906`](https://github.com/BerriAI/litellm/blob/e76668a4719faaa3f8ad68c2c5c42c45211f8135/litellm/types/router.py#L802-L906)。
- 权重/RPM/TPM、cooldown：[`simple_shuffle.py:43-67`](https://github.com/BerriAI/litellm/blob/e76668a4719faaa3f8ad68c2c5c42c45211f8135/litellm/router_strategy/simple_shuffle.py#L43-L67)、[`router.py:79-105`](https://github.com/BerriAI/litellm/blob/e76668a4719faaa3f8ad68c2c5c42c45211f8135/litellm/router.py#L79-L105)。
- 总 deadline：[`total_deadline.py:83-96`](https://github.com/BerriAI/litellm/blob/e76668a4719faaa3f8ad68c2c5c42c45211f8135/litellm/litellm_core_utils/total_deadline.py#L83-L96)；健康按 key/model 授权：[`_health_endpoints.py:1557-1617`](https://github.com/BerriAI/litellm/blob/e76668a4719faaa3f8ad68c2c5c42c45211f8135/litellm/proxy/health_endpoints/_health_endpoints.py#L1557-L1617)。
- 复用：公共模型与 deployment 分离、预算状态机、分级健康、迁移 dry-run。
- 不复用：Pydantic/YAML/云 SDK、Rust core、Redis、httpx/asyncio、Prisma/NaCl；违背当前零第三方运行时结构。

## 6. New API v1.0.0-rc.51

- Release commit：`c9c6da2786b6a0912215127e78e28fbc6650c85f`。
- Channel：类型/Key/BaseURL/模型映射/分组/优先级/权重、逐 Key 禁用：[`model/channel.go:28-80,195-295`](https://github.com/QuantumNous/new-api/blob/c9c6da2786b6a0912215127e78e28fbc6650c85f/model/channel.go#L28-L295)。
- 选路：优先级分层后层内加权：[`model/channel_cache.go:123-218`](https://github.com/QuantumNous/new-api/blob/c9c6da2786b6a0912215127e78e28fbc6650c85f/model/channel_cache.go#L123-L218)。
- 错误决策/超时：[`service/relay_error.go:18-56`](https://github.com/QuantumNous/new-api/blob/c9c6da2786b6a0912215127e78e28fbc6650c85f/service/relay_error.go#L18-L56)、[`service/http_client.go:107-139`](https://github.com/QuantumNous/new-api/blob/c9c6da2786b6a0912215127e78e28fbc6650c85f/service/http_client.go#L107-L139)。
- 复用：稳定渠道身份、逐 Key 隔离、错误分类表、版本化迁移。
- 不复用：Go/Gin/GORM/Redis 栈；跨尝试总 deadline 未在已读源码证实；删除式迁移不适合无损回滚。

## 7. Models.dev 与 Harness 官方协议

### Models.dev（快照 `8eb615a`，2026-11-24）

- 社区 TOML，`schema=2`；`/api.json?type=all` 为 v1 API；provider 的 npm/env/doc/api，model 的 tool_call/reasoning/modalities/limit/cost/status/canonical_model_id；ETag + must-revalidate。
- 复用：模型元数据、能力提示、别名归一、来源与新鲜度字段。
- 不复用为权威：社区目录不证明账户权限、端点/流式/工具/压缩兼容；`last_updated` 不是本次抓取时间。63 模板必须先版本化并标证据等级。

### Codex 0.172.0（2026-11-24）

- `~/.codex/config.toml`；provider 的 `base_url/wire_api/env_key/http_headers`；`model_catalog_json`；当前官方配置只接受 Responses，不支持 `wire_api="chat"`。
- 工具由 Codex Harness/MCP 管理；`model_auto_compact_token_limit/compact_prompt` 是客户端配置，压缩由 Codex 执行。
- 复用：Responses adapter、目录注入、原生父子和压缩；不复用 Chat-only 桥作为原生能力证明，也不读写/伪造官方登录。

### Claude Code 2.1.331（2026-11-23）

- `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`apiKeyHelper`；`/v1/messages`、`/v1/messages/count_tokens`；模型目录过滤 Claude/Anthropic。
- 复用：独立 Messages adapter、原生 `/compact`/autoCompact；不复用 OpenAI 兼容配置或非 Claude 模型冒名。

### OpenCode v2.4.1（2026-11-23）

- `opencode.jsonc` 的 `providers.<id>.package`、`settings.baseURL/apiKey`、`models.<id>.modelID/capabilities/limit`；目录合并 Models.dev；MCP servers。
- 复用：按 package 拆 adapter、模型声明；不复用 V1 配置或假定其 compaction 可移植。默认压缩可由 OpenCode 本地摘要执行，ModelGate 不自建。

### DSH 0.2.3-alpha.2（2026-11-22，预览）

- `$DSH_HOME/profiles/<profile>/cordis.patch.yml`；`llm-pi-ai.config.providers.<id>` 的 apiKeyEnv/api/baseURL/models；四协议 openai-completions/openai-responses/anthropic-messages/google-generative-ai；凭据引用 `.credentials.yaml`。
- 复用：四协议 adapter seam 与插件工具边界；不复用预览版字段到稳定合同，忽略 compat 差异或跨协议套用。
- xmxz Harness 未找到可验证公开官方资料，状态 UNKNOWN；不展示“一键已支持”。

## 8. 对本轮设计的决策

1. 扩展现有 `virtualModels`、router、forward、config transaction、aggregation/Codex 模块，不建立第二网关或第二配置真源。
2. 资源层采用稳定 ID 投影；旧 name/slug 仅作兼容显示与请求别名。写入统一 expectedVersion + impact preview + 现有事务。
3. A2 先交付 `/api/capabilities` 与 `/ui-vnext` 只读壳，真实浏览器验证 origin/导航/错误；写能力未接线不显示可点击假按钮。
4. A3 再补 service/connection/model/template；A4 再修 cleanVms、pool 与统一预算；A5 再扩 Codex 角色池。不能在前端先模拟通过。
5. 用量保留 null/unknown；日志不记正文和凭据；Models.dev/目录仅作元数据，真实权限以连接发现和推理回执为准。
6. 所有真实外部测试仍 BLOCKED； fixture/真实 HTTP/真实浏览器证据不得标 PASS_REAL。

## Sources

- [Sub2API release](https://github.com/Wei-Shaw/sub2api/releases/tag/v0.2.25)
- [Portkey release](https://github.com/Portkey-AI/gateway/releases/tag/v1.15.2)
- [LiteLLM release](https://github.com/BerriAI/litellm/releases/tag/v1.110.3)
- [New API release](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.51)
- [Models.dev](https://models.dev/api.json?type=all)
- [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.172.0)
- [Claude Code gateway](https://code.claude.com/docs/en/llm-gateway-connect.md)
- [OpenCode providers](https://opencode.ai/docs/providers/)
- [DSH providers](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md)
