# ADR-0003：聚合模式接口契约（AGG-P01..P06 绑定）

- **状态**：Binding（已冻结）。本文是决定，不是候选方案。
- **适用**：AGG-P01..P06（执行计划 P01–P06 阶段）的全部实现与验收。
- **修订权**：仅主代理。子代理只能在自己的交付报告中登记偏差，不能改写本文或绕开本文。
- **优先级**：与 `docs/product/2026-11-14-owner-product-contract.md`（MG-R001..MG-R012）冲突时以产品契约为准；本文不重述、不改写任何 MG-R 措辞。

## 1. 目的与效力

冻结聚合模式下五个专职代理共享的模块边界、导出签名、模型身份、授权不变量、HTTP 面、文件写集、测试登记与证据格式，使并行工作不产生接口漂移。任何子代理交付若违反本文，视为未完成；主代理整合时可直接拒绝，不需要逐条重新讨论。本文与子代理报告冲突时，以本文为准；本文确有错误的，只能由主代理提交新的 ADR 修订。

## 2. 冻结的模块边界与导出签名

下列签名是冻结契约。实现可以增加内部字段，但不得改名、减参、改变返回类型或退化成宽松匹配。

- `src/aggregation/registry.js`（新增，A2）：`listProviders()`、`getProvider(id)`、`addProvider(cfg)`、`removeProvider(id)`。持久化复用既有 gateway 配置与 `configVersion` CAS（`src/index.js` 保存路径：版本 +1、旧版本 409 并回传 `currentVersion`），写入走 `src/config-transaction.js` 的既有事务；**不得新建第二配置库、第二把锁或第二套版本号**。
- `src/aggregation/discovery.js`（新增，A2）：`discover(provider, {signal, maxPages}) -> {snapshot, diagnostics}`；`sync(providerId) -> {snapshot, changed:{added,removed,updated}}`。失败必须返回 typed error（稳定 `code` + `diagnostics`）；**绝不返回 `ok:true` 的空快照**，因为空快照会被读成“该账户没有任何模型”。只有上游明确返回空授权目录时才允许 `snapshot.models=[]`，并必须在 `diagnostics` 标注空目录已被上游证实；否则记 `NOT_TESTED`/`BLOCKED`。
- `src/aggregation/catalog.js`（新增，A2）：`publishAggregatedCatalog(scopeRef) -> {catalogRef, version, modelCount, diagnostics}`。必须经 `src/codex/catalog-generation.js` 生成世代（`buildGenerationRecord` / `persistAndSwapValidatedGeneration`）并经 `src/codex/catalog.js` 校验（`assertCatalog`、`assertZeroCollisions`）。**A2 不得另写一套 catalog ID 生成、指纹或落盘逻辑。**
- `src/codex/desktop-integration.js`（新增，A3）：`detect()`、`preview()`、`activate({consentToken, expectedSha})`、`deactivate({expectedSha})`、`status()`。每次配置写必须走 `src/codex/config.js` 的事务语义：预览 → 二次快照（sha256+size+mtime）→ 备份 → 原子写 → 写后校验；`consentToken` 即确认令牌，`expectedSha` 即预览时冻结的 `before.sha256`，不一致即 409 中止。**绝不读写 `auth.json`。**
- 授权域（A4，扩展 `src/codex/target-authz.js`）：`AuthDomain = 'codex-subscription' | 'siwc-app' | 'api-key'`；`resolveUpstream(receipt)` 返回 typed receipt `{providerId, authDomain, upstreamHost, upstreamPath, model, upstreamModel}`；`assertNoSubscriptionCredentialToThirdParty(headers, upstreamHost)`。`codex-subscription` 只映射现存 `gatewaySubscription`（`/backend-api/codex` 入口），`api-key` 映射 `provider-key`，`siwc-app` 使用 `src/subscription/*` 的独立授权域；三者互不替代。
- 原生协议（A1）：`src/codex/interop.js`、`src/responses.js`、`src/responses-stream.js`、`src/sse.js` 保持今日签名兼容；A1 确需改签名的，必须在其报告中单列理由、调用方清单与迁移方式，未经主代理确认不得改。

## 3. 模型身份规则

- 公共 ID 沿用已发布方案，已上线 Go 模型必须字节兼容：`mg-opencodego-<vendor-slug>`。新 kind 在 `<kind>` 段扩展为 `console` / `official`，即 `mg-console-<vendor-slug>`、`mg-official-<vendor-slug>`。`kind=go` 的段名固定为 `opencodego`，**不得写成 `mg-go-...`**，否则破坏已发布 ID。实现只能复用 `stableModelId()`（provider 段取 `opencodego`/`console`/`official`），不得新增第二套生成器。
- 零碰撞由 `src/codex/catalog.js` 的 `assertZeroCollisions` 唯一判定；冲突即 fail-closed，不自动改名、不静默丢模型。
- 上游精确模型 ID 保存在 `upstreamId` 并原样转发；公共 ID 只用于本地目录与计费归属，**绝不出现在上游请求体**（`src/providers/opencode-go.js` 的 `encode()` 只把 `body.model` 换成 vendor 模型）。
- 每条模型记录固定为：`{publicId, providerId, upstreamId, displayName, contextWindow?, capabilities:{tools, supportsSearchTool, supportsWebsockets}, authorized, evidence:{source, observedAt}}`。`evidence` 必填；无证据时 `capabilities` 三项一律 `false`，不得宣称支持。
- 账户无权使用的模型以 `authorized:false` 存档，可出现在诊断里，**不得发布为可调用模型**，也不得进入路由候选。

## 4. 授权不变量（不可协商）

1. 订阅凭据绝不出现在发往非官方上游的请求中；官方与第三方的头从空白构造，不继承客户端原头。
2. 未知授权状态是 typed error，绝不“当作 API key 处理”，也不回落默认模型或默认凭据。
3. SIWC 令牌永不当作 Codex backend 令牌使用；两者入口、audience、诊断码各自独立。
4. 授权域之间无静默回退：`codex-subscription`、`siwc-app`、`api-key` 任一失败即失败，不透明换域。
5. 诊断只携带稳定 code 与 host/path，绝不携带 token、cookie、authorization 值或 `auth.json` 内容。

## 5. HTTP 面

全部挂在既有 `explicitAdmin` + loopback/origin 策略下，并遵守 `configVersion` 乐观锁，不新增匿名入口：

- `GET/POST /api/aggregation/providers`
- `DELETE /api/aggregation/providers/:id`
- `POST /api/aggregation/providers/:id/sync`
- `GET /api/aggregation/models`
- `GET /api/aggregation/health`
- `GET /api/aggregation/diagnostics`
- `POST /api/aggregation/activate`
- `POST /api/aggregation/deactivate`

子代理只实现 handler 与领域逻辑；**把路由接进 `src/index.js` 属主代理**。未接线的 handler 不得被报告为已完成接口。

## 6. 文件写入范围

| 代理 | 可写 | 禁止写 |
| --- | --- | --- |
| A1 | `src/codex/interop.js`、`src/responses.js`、`src/responses-stream.js`、`src/sse.js`、新增 `src/codex/native-*` | 其他代理文件、`src/index.js`、测试清单 |
| A2 | `src/providers/opencode-*`、新增 `src/aggregation/*` | `src/codex/*`、UI、`src/index.js` |
| A3 | `src/codex/desktop-integration.js`、`src/ui-next/js/views/aggregation.js`、对 `views/providers.js` 与 `views/clients.js` 的增量编辑 | 其他视图、`src/ui-next/js/api.js`、后端路由 |
| A4 | `src/subscription/*`、`src/codex/auth.js`、`src/codex/config.js`、`src/codex/target-authz.js`、`src/codex/local-subscription.js`、新增 `src/tenancy/*` | 目录生成、UI、`src/index.js` |
| A5 | `docs/evidence/` 下新文件、自己的验收测试 | 产品契约、路线图、任何实现文件 |
| 主代理独占 | `src/index.js`、`src/router.js`、`src/ui-next/js/api.js`、`package.json`、`scripts/test/run.mjs`、`.github/*`、`AGENTS.md`、`README.md`、`docs/roadmap/*` | — |

- 无人可写 `docs/product/*`。
- `src/codex/catalog.js`、`src/codex/catalog-generation.js`、`src/config-transaction.js` 未授予任何子代理；只能只读 import，需改动时由主代理在整合时进行。
- 子代理需要主代理文件变更时，提交可直接应用的补丁与理由，不得直接编辑。

## 7. 测试登记协议

- 新测试只放 `scripts/test/offline/`，**不得编辑 `scripts/test/run.mjs`**：五个代理同时改清单必然冲突。
- 每个新测试文件必须在报告中给出精确的 suite 名与路径，由主代理在整合时登记；**未登记的 suite 不算证据**。
- 离线测试必须跑在既有隔离 HOME runner 下，不联网、不读宿主凭据、不消费真实额度。

## 8. 证据协议

每条结论必须含：commit SHA、可直接复制的命令、pass/fail、真实/模拟标签（`PASS_REAL` / `PASS_MOCK`）。`PASS_MOCK` 永不等于 `PASS_REAL`；无法证明的记 `BLOCKED` 或 `NOT_TESTED` 并写明根因。不得用单测、mock 或 CLI 结果冒充原版 Desktop 的真实能力。

## 9. 禁止事项

- 不以 MCP 或自建调度器替代原生能力；
- 不以 CLI 冒充 GUI / Desktop 验收；
- 不使用非 Luna 的 GPT 模型做真实测试；
- 不修改 MG-R001..MG-R012 及其断言测试；
- 未经所有者批准，不做付费/真实调用，不写用户真实 `~/.codex/config.toml`。

## 10. 偏差记录

1. `stableModelId(provider, model)` 实际生成 `mg-<provider>-<model>`，无 `kind` 参数；按字面实现 `mg-go-...` 会破坏已发布 `mg-opencodego-*`。本文按 §3 固定 `kind=go` 的段为 `opencodego`，未改 `catalog.js`。
2. `catalog.js` 的模型字段是 Codex 目录形状（`slug`、`display_name`、`context_window` 等），与 §3 的聚合记录不同。§3 定义为聚合层记录，发布时投影为 `slug`/`display_name`/`context_window`；`context_window` 缺失时 fail-closed，不编造。
3. `target-authz.js` 中 `official-subscription` 已按 F01 退役并一律 deny；`codex-subscription` 因此只映射现存 `gatewaySubscription`，不复活退役模式。
4. 仓库内不存在 `AGG-P01..P06` 标识（执行计划用 `P00–P06`）。本文按 P01–P06 阶段解释，未改动路线图字样。
