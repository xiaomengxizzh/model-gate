# V13.1 资源与管理接口契约（A3–A6 设计基线）

状态：A2–A6 已实现并通过隔离 HTTP/浏览器 fixture；真实账户、原版 GUI 与付费推理未签收。所有新增写操作复用现有配置事务，不并行维护第二份持久化。

## 1. 通用规则

- 前缀 `/api`；同源 + Host/Origin + 回环/显式 allowRemote，与现有管理面一致。
- 读：`GET /api/<resource>`、`GET /api/<resource>/:id`。
- 写：`POST` 创建、`PATCH` 更新、`DELETE` 删除；均为 JSON object。
- 创建/更新/删除必须带 `expectedVersion`（现有 configVersion）与 `requestId`；requestId 在同资源+同操作+同 body hash 范围幂等，重复返回首个回执，不同 body 返回 409。
- 影响操作先 `POST /api/config/preview`，返回 `previewId`、`expiresAt`、before/after hash、影响集合与确认要求。确认重验 expectedVersion/preview hash；过期 428，代际变化 409。
- 禁止前端传文件路径、原始 TOML、完整 auth.json、命令或任意 URL 之外的文件位置。服务 endpoint 仅 http(s)，并执行 SSRF/回环许可策略。
- 旧 `/api/config/save`、`/api/keys` 也已改为 `/api/config/write:preview` → 原端点确认提交；直接写入返回 428。aggregation/* 保持既有独立 consent 契约。新资源是事务上的编排层，不绕过校验、Key 加密、删除墓碑或运行时重载。

### 统一错误

```ts
{ code, message, details?, retryable, currentVersion?, traceId? }
```

| HTTP | code 类别 | 前端动作 |
| --- | --- | --- |
| 400 | invalid_body/invalid_reference | 就地修正，不重试原 body |
| 403 | remote_forbidden/write_disabled/policy_denied | 只读或解释授权，不自动绕过 |
| 404 | unknown_endpoint/unknown_resource | 旧后端升级提示 |
| 409 | version_conflict/preview_conflict/idempotency_conflict/store_conflict | 刷新差异，保留草稿 |
| 422 | capability_unsupported/last_member/invalid_transition | 引导修复，不伪造成功 |
| 428 | preview_required/preview_expired/confirmation_required | 重新预览/确认；consent 不落盘 |
| 500 | transaction_failed/upstream_unavailable | 显示阶段，支持安全重试 |

## 2. 领域对象

```ts
ProviderTemplate { templateId, version, category, region, authKind, protocol,
  baseUrl?, discovery, docs, evidence: {level, source, checkedAt}, enabled }
Service { serviceId, templateId?, displayName, region, endpoint, enabled, revision }
Connection { connectionId, serviceId, credentialRef, identityDomain, quotaScopeId,
  enabled, priority, maxConcurrent, verification: {state, checkedAt, code?} }
ConnectionModel { connectionId, modelId, availability, capabilityEvidence }
Model { modelId, serviceId, upstreamModelId, displayName, capability, api,
  enabled, metadataProvenance, revision }
Pool { poolId, slug, name, enabled, selection, recoveryPolicyRef, revision }
PoolMember { poolId, modelId, priority, weight, enabled, constraints }
HarnessBinding { harnessId, instanceId, mode,
  roleTargets: {parent?: Target, child?: Target, route?: Target},
  policyRef?, desiredRevision, appliedRevision, verifiedRevision }
Target = {kind:'native'|'model'|'pool', id:string}
Policy { scopeType:'global'|'harness'|'pool', scopeId, overrides, revision }
Operation { operationId, kind, state:'queued'|'running'|'partial'|'succeeded'|'failed'|'cancelled',
  steps:[{id,state,code?,retryable?}], createdAt, updatedAt }
```

- 名称是显示属性，不参与引用。旧 provider/model/virtual name 生成稳定 ID 的迁移映射必须保存。
- `verification.state`: configured / detecting / verified / failed / expired / unknown。只有对应真实请求回执可标 verified。
- Pool slug 建议 `mg-pool-<stable-id>`，但必须先验证 Codex 目录和身份分类；未知 `mg-*` 不得自动落到默认上游。
- 同一会话固定 model/connection/protocol/config generation；新会话才重新选候选。在途请求不受编辑/删除影响。

## 3. 端点与字段来源

| 操作 | 端点 | 字段来源/约束 | 阶段 |
| --- | --- | --- | --- |
| 能力启动 | GET `/api/capabilities` | 已实现，见 capabilities-v1 | A2 |
| 模板列表 | GET `/api/provider-templates?query=&category=&region=&cursor=` | 本地版本化静态目录 + evidence；不返回账户模型权限 | A3 |
| 模板详情 | GET `/api/provider-templates/:id` | docs/protocol/discovery；63 模板逐一溯源 | A3 |
| 服务 CRUD | `GET /api/services`、`POST /api/config/preview`、`POST|PATCH|DELETE /api/services` | A3 已实现创建/编辑/启停/删除薄切片，详见 services-v1 |
| 连接 CRUD/发现 | `/api/connections`、`/:id`、`POST /api/connections/:providerId/:connectionId/discover` | 独立 Key/优先级/并发/额度域；OpenAI 兼容目录发现 |
| 模型 CRUD | `/api/models`、`/:id` | 稳定 modelId、上游 ID、启停与引用保护 |
| 池 CRUD | `/api/pools`、`/:id` | virtualModels 扩展；稳定 poolId/slug、成员权重/轮询 |
| 应用引用 | `/api/harness-bindings`、`/:id` | desired binding、双向查询、删除保护；Codex 实际生效另走 switch |
| 有效策略 | `/api/policies/effective`、`POST /api/policies` | 全局/Harness/池继承、预算最严、硬约束 |
| 用量/日志 | `/api/usage/summary`、`/api/logs/structured` | 持久累计请求/尝试/token；脱敏事件投影 |
| Harness | `/api/harnesses`、`/preview`、`/apply`、`/rollback` | 显式 MG_HARNESS_ROOT 才写；xmxz unsupported |
| 连接授权（规划） | POST `/api/connections/:id/authorize` | OAuth/授权流程尚未实现；当前支持 Key 与环境变量引用 | A3 |
| 连接健康（规划） | POST `/api/connections/:id/health` | 真实探测可能计费，须显式确认；当前使用熔断/429 运行状态 | A3 |
| 成员批量变更（规划） | POST `/api/pools/:id/members:batch` | 当前通过 pool.update 全量成员预览/事务实现 | A4 |
| 路由预演扩展（G11） | POST `/api/route-preview` | `{model}` 旧响应字段完全不变；扩展 role/capability/scenario/budget 复用 router、effectivePolicy、routing/decision 与 RequestLedger，零上游 | G11 已实现（离线 HTTP） |
| 模式预览/切换 | 既有 aggregation switch/rollback/reconcile | 已扩展 routeTarget/childTarget；428+expectedSha；官方父不替换 | A5 |
| 操作状态/取消 | GET `/api/{services|models|pools|connections|harness-bindings|config/backups|config/write-operations}/operations/:id`、POST 同路径 `/:id/cancel` | 持久 Operation/preview/requestId receipt；一次性确认；仅未开始步骤可取消；重启未知态禁止重跑 | A3–A6 |
| 备份 | GET/POST `/api/config/backups` | 脱敏快照、版本、保留期；Key 默认排除 | A6 |
| 导入预览/应用 | POST `/api/config/import:preview`、`:apply` | schema/版本/差异/冲突/重新授权；不覆盖原文件 | A6 |

### 3.1 G11 路由预演

- 请求仍必须含 `model`。仅 `{model}` 时返回旧 `{ok,hit}`，不添加 `preview` 或其他字段。
- 扩展可选字段：`role`、`capability`、`scenario`、`budget`；角色解析另可用 `harnessId` 或显式 `target`。`role` 接受 `official|route|aggregated|parent|child` 或 `{kind:'native'|'model'|'pool',id}`；`capability` 为 `chat|embedding|rerank|audio|image|video`；`scenario` 为 `normal|failover|recovery|cancel|quota`。
- `budget` 仅接受 `maxTotalAttempts|maxFailovers|maxRecoveryAttempts|maxWaitMs|maxElapsedMs|maxAttemptsPerCandidate`（非负整数，`maxElapsedMs` 可 null）与 `requestUsd|taskUsd|dailyUsd`（非负有限金额）；也接受 `budget.limits` 的次数/时长子集。未知字段、负值、非整数次数/时长一律拒绝。
- 响应保留旧 `hit`，并新增 `preview`：`wouldSend`（候选顺序、连接、额度域、估算费用）、`blockedCandidates`（稳定原因码）、`decision`、`ledger`（有效上限、剩余量、纯预演状态）、`replaySafety`、`quotaState`、`policy`、`budget`。weighted/round-robin 池标记 `deterministic:false`，不伪造随机抽中的顺序。
- 预演只构造内存 RequestLedger，不 record 真实发送、不写配置/用量/回执、不探测上游、不返回请求正文、凭据、认证头、端点 URL 或原始错误。normal 为发送前裁决；failover/quota 注入可证明的前置拒绝；recovery 要求原目标与原生可信续传；cancel 禁止再发送。
- 稳定拒绝码：400 `invalid_route_preview|invalid_role|invalid_capability|invalid_scenario|invalid_budget`；422 `route_preview_unresolved|route_preview_target_unavailable|route_preview_no_candidate`；500 `route_preview_failed`。失败均不发送上游。

## 7. 单实例多租户

- 根配置 `tenancy:{mode:"multi",scopes,root}`；身份只来自宿主注入的 `resolveActor(req)`，返回 `{id,scopeId,role}`。请求头 `x-scope` 永不作授权来源。
- 每 scope 懒加载独立 config/keys/catalog/usage/logs 与资源回执；跨 scope 资源 404，普通 role 管理写 403，宿主 Codex/aggregation/Harness 路径 403。
- 旧单用户缺省 `local` 行为不变；详细配置与目录权限见 [配置参考](../../reference/configuration.md)。

## 8. 可靠性预算与存储边界

- 单请求 ledger 字段：firstSend、attemptsByCandidate、attemptsByConnection、failovers、recoveryAttempts、waitMs、elapsedMs、amountByCurrency、cancelReason。
- 首次发送计入总发送次数；各候选/账户/模型/整链预算独立且取最严上限。内层与外层不得相乘重试。
- 400 停止；401 要求重新授权；明确共享额度耗尽跳过整个域；429 尊重 Retry-After，超过剩余预算则不提前发。
- 已交付流、工具已执行/未知、非幂等、部分提交、不可读加密上下文禁止自动重放。原生恢复协议优先原目标。
- 正常长生成默认 overallMs=0 可保留，但必须另有故障/恢复总预算；UI 显示“不限正常生成时长”和真实故障预算，不能隐藏无界等待。
- 默认推荐值须由隔离真实 HTTP 故障链校准；当前提案数值不得写入生产默认。

- 持久回执按分类记录数与总字节设限；超限在副作用前返回 429/507。过期未消费预览和无 live operation 引用的过期回执可清理；终态操作与 commit marker 只允许显式清理，绝不静默删除。
- G15 观测事件使用 scope-owned `config/observability/events.jsonl`（单用户即 `<配置目录>/observability/events.jsonl`），当前文件 + `.1` 总记录/字节有界，0600 文件、0700 目录、追加 fsync、原子轮转。损坏行跳过计数且不返回；持久历史只供结构化日志/历史分页，实时 SSE 仍使用独立 ring。
- 真实 HTTP(S) 每次建连前解析全部 A/AAAA、校验目标与代理并固定 socket lookup；旧单用户无 `allowPrivateNetwork` 字段时保留本地兼容，多租户与新资源默认拒绝私网。

## 9. 删除、引用与回滚

- 删除预览覆盖有效/无效/草稿/历史/在途/备份引用，返回 blocking 与可解除项。
- 删除最后候选/目标时 422，引导替换、解绑或明确停止管理；不永久锁死应用。
- 删除服务不删除历史用量/日志名称快照；Key 处理策略必须显示并在确认中绑定。
- 所有写回执含 configVersion/revision、previewId、backupId（不透明）、appliedAt、needsRestart；未重启不标实际生效。
- Codex 回滚只接受不透明 backupId，不接受路径；重启后 backup 元数据必须仍可恢复。

## 10. 前端动作契约

每个动作必须登记：`actionId → API/local preference → loading → success feedback → error/cancel/conflict → acceptance ID`。

- 本地偏好仅主题/密度/筛选/导航/非敏感草稿；本地失败可见，不吞异常。
- 未实现动作标 `planned` 或隐藏；禁用按钮说明能力缺口，不能点击后无反馈。
- 所有异步动作防重复提交；完成通知不抢走正在编辑表单的焦点。
- 导出对 CSV 单元格做公式注入防护；文本使用 DOM textContent，禁止把服务/模型/日志内容注入 innerHTML。
