# ModelGate｜聚合模式至完整交付的可执行工程计划（伪代码 + 注释）

> **直接执行版** 2026-11-14。以 [所有者产品契约 MG-R001..MG-R012](../product/2026-11-14-owner-product-contract.md) 为唯一最终验收标准。当前分支起点 `mg-codex-native@4c5db53`；历史计划只能作为参考，不得定义更低的“完成”。执行入口见 [Agent Team 启动提示词](2026-11-14-aggregation-agentteam-start.md)。
>
> 本文所有 `pseudo` 代码为**明确的待实施设计，不是已经上线的代码**。开发代理必须直接审计现有实现、落地真正的代码/测试和原生 GUI，而不能把伪代码提交为产品交付。不得下载重型依赖/模型权重，未经单独授权不得运行付费真实测试、修改生产配置或合并主分支。

## A. 执行总原则：需求与实现分离

```ts
// 所有者目标固定：一键聚合 + 保留 ChatGPT 套餐 + OpenCode 全量模型 + 原版 Codex Desktop + 完整原生 Agent Team。
// 开发者可以更换内部算法、数据结构、Provider 路由，但不得自行改目标。
const RELEASE_GATE = ["MG-R001","MG-R002","MG-R003","MG-R004","MG-R005","MG-R006",
  "MG-R007","MG-R008","MG-R009","MG-R010","MG-R011","MG-R012"];

function canRelease(evidence, ownerApproval) {
  // mock PASS、文档 PASS、CLI PASS 不能代替 Desktop REAL PASS。
  return ownerApproval === true &&
    RELEASE_GATE.every(id => evidence[id]?.status === "PASS_REAL" && evidence[id]?.commitSha === HEAD);
}
function handleBlocked(id, reason) {
  // 永远不修改需求、验收口径或模型授权域；提交根因、复现与恢复点。
  return { id, status: "BLOCKED", reason, productRequirementUnchanged: true };
}
```

## B. 先执行基线冻结与真实状态盘点（任务 P00，主代理，先于并行）

```bash
git status --porcelain=v1
git branch --show-current
git rev-parse HEAD
# 先保全尚未提交的 Desktop launcher、SIWC/OAuth、真实路由原型。
# 不要 reset --hard / git clean / 覆写宿主 ~/.codex/config.toml / 读取或提交密钥。
# 独立 worktree：每个 Agent 使用不同目录和文件所有权；先查重依赖，禁止安装。
npm run check
npm test
npm run docs:check
node scripts/check-metadata.mjs
node scripts/check-product-contract.mjs
```

固定基线：记录原版 Codex CLI/Desktop 的实际可执行文件路径、版本、ModelGate/Go 入口、既有配置归属、`src/index.js` 与 `src/codex/catalog.js` 的边界；检查 [暂停报告](../evidence/2026-11-14-modelgate-desktop-hold.md) 中提及的本地未提交原型是否仍存在。**如果没有权限检查本地，就标 `UNKNOWN_LOCAL_STATE` 而不是假定可用。**

产物：`docs/evidence/aggregation-baseline-<date>.md`（脱敏），逐项标记 existing/reusable/missing/regression；列出 12 个需求初始状态，默认 NOT_TESTED / BLOCKED，禁止虚构百分比。

## C. 工程写集与 Agent Team（最多 5 个子代理）

| Agent | 专责 | 拥有写集（新增文件优先） | 依赖 |
| --- | --- | --- | --- |
| A1 / Codex 原生协议 | Codex Provider、目录、原生父子工具/上下文/恢复 | `src/codex/*`（与 A4 的授权文件排除重叠）；`scripts/test/offline/codex-*.test.mjs` 的专属新增测试 | P00 |
| A2 / OpenCode 聚合 | Console/Go 授权、模型发现与路由绑定 | `src/providers/opencode-*.js`、新增 `src/aggregation/discovery.js`、专属测试 | P00 |
| A3 / GUI/Desktop 产品 | 一键聚合、Provider 表单、自动安装/恢复流程 | `src/ui-next/js/views/*` 的指定 UI 文件、`src/codex/desktop-integration.js`、UI 测试 | A1/A2 契约 |
| A4 / 授权与安全 | 订阅保留、身份隔离、令牌授权域、配置事务 | `src/subscription/*`、`src/codex/auth.js`、`src/codex/config.js`、安全测试 | P00 |
| A5 / 独立验收 | 只读审计 + 隔离 mock/真实客户端测试 + 反向用例 | `docs/evidence/*` 新证据、`scripts/test/offline/aggregation-acceptance*.test.mjs`；不得改产品契约 | 任意集成候选 |

**主代理独占共享入口**：`src/index.js`、`src/router.js`、`src/ui-next/js/api.js`（若需）、`package.json`、CI、`README.md` 和本计划的状态记录。子代理不交叉编辑同一文件。最大并发 5 个子代理，主代理仅整合、审查和控制写集；**Codex 的真实测试一律由 A5 执行**，所有真实 GPT 调用必须只为 GPT-6 Luna。Go 的非 GPT 子模型可按测试要求使用。

### 产出统一接口（A1–A4 实现前先约定）

```ts
type AggregationMode = "direct" | "routing" | "aggregation";
type ProviderKind = "chatgpt-official" | "opencode-console" | "opencode-go" | "custom";
type ModelBinding = {
  publicId: string; // 稳定、唯一、不与官方 slug 冲突
  providerId: string; upstreamModelId: string; api: "responses" | "chat";
  contextWindow?: number; reasoningLevels?: string[];
  capabilities: Record<string, "verified" | "unknown" | "unsupported">;
  evidence: { source: string; checkedAt: string; version?: string };
};
type AuthDomain = "codex-owned-chatgpt" | "app-authorized-openai" | "opencode-key";
type OperationReceipt = {
  traceId: string; modelPublicId: string; upstreamModelId: string;
  authDomain: AuthDomain; providerId: string; status: number;
  streamTerminal?: "completed" | "failed" | "cancelled"; lossy?: string[];
};
type ProductStatus = "NOT_TESTED" | "BLOCKED" | "FAIL" | "PASS_MOCK" | "PASS_REAL";
```

## D. 阶段 P01：Provider 自动发现与聚合目录（A2 主责、A1 对接）

现有 `src/providers/opencode-go.js` 已有 Go 入口约束；`src/codex/catalog.js` 从已配置模型生成目录，但**不负责在线自动发现**。不重新造路由器，而是在已有 Provider 配置与目录生成器之间增加发现/快照层。

```ts
// 待新建：src/aggregation/discovery.js、src/providers/opencode-console.js
async function addProviderFromGui(input, userScope) {
  assertLocalAdminAuthorization(userScope);                 // 不接收无凭据远程修改
  const candidate = normalizeOpenCodePreset(input);       // Go 与 Console 分别使用官方 Responses base URL
  const keyRef = await saveEncryptedKey(candidate.apiKey); // Key 不进入目录/报告/日志
  const result = await discoverAuthorizedModels({ provider: candidate, keyRef, budget: DISCOVERY_BUDGET });
  if (!result.ok) return typedFailure(result);             // 失败不可伪称空模型目录
  const snapshot = validateEveryModel(result.models);     // 精确 ID、无重复、保留来源和观测时间
  const binding = buildNamespacedBindings(candidate, snapshot); // 原模型名原样转发，公共名可区分冲突
  return atomicPublishProviderAndCatalog(candidate, binding);  // 一次版本，409 重试必须先重新预览
}
async function discoverAuthorizedModels(ctx) {
  // 首选官方允许的账户模型目录；Go/Console 不假设返回同一集合。
  // 如果接口分页则穷尽全部页，处理限流/错误、ETag、超时和缓存陈旧状态。
  // 有权限但不暴露目录的上游：提示发现缺口，支持从官方已公布目录导入并真实验收；
  // 不可将“暂时只发现 1 个 DeepSeek”标记为已覆盖“全部模型”。
  return queryAllPagesWithNoSilentTruncation(ctx);
}
function publishFullCatalog(official, thirdParty) {
  const full = dedupeAndPreserve(official, thirdParty);    // 保留所有原生 GPT 条目
  if (remoteCatalogWouldExceedCodexLimit(full)) {
    // 自动维护分代的本机 model_catalog_json 快照，不要求用户手工处理；
    // 确认 Desktop 实际选择器可展示所有条目后才准 PASS。
    return generateLocalCatalogAtomically(full);
  }
  return publishVersionedRemoteAndLocalFallback(full);    // 兼容当前 Codex Desktop 目录行为
}
```

接口：`POST /api/aggregation/providers`、`POST /api/aggregation/providers/:id/sync`、`GET /api/aggregation/models`、`GET /api/aggregation/health`；所有管理接口与现有 `configVersion`、管理令牌、回环来源策略一致，不绕过 `src/codex/api.js` 的授权。

验收：mock 验证发现分页、重复 ID、模型新增/删除、密钥过期、目录超限、不同用户隔离、目录回滚；真实目录与 GUI/Codex 清单双向对账（MG-R003）。不存在上游权限的模型必须标明无权，而不是显示成可调用。

## E. 阶段 P02：保留 ChatGPT 套餐与统一路由（A4/A1，主代理负责整合）

```ts
// 不能假定唯一授权方式是独立 SIWC，也不能默认把私有 Codex Backend 当成公开 SIWC。
// 官方订阅默认体验：跟随用户已有 Codex 登录，不重置 auth.json；在符合平台和官方授权
// 条件的客户端 Provider 路径下做订阅透明接入。SIWC 作为独立授权模式，状态隔离。
// 两条路径的能力/请求终点/授权域分别验证；失败不偷偷降级到另一授权路径。
function resolveUpstream(request, catalogBinding, sessionAuth) {
  if (catalogBinding.providerId === "chatgpt-official") {
    return routeOfficialSubscription(request, sessionAuth);
  }
  const provider = requireEnabledProvider(catalogBinding.providerId);
  assertNoChatgptBearerOrAccountHeader(request.forwardedHeaders); // 订阅密钥绝不能进 Go
  return routeToAuthorizedOpenCodeResponses(provider, catalogBinding.upstreamModelId, request);
}
function routeOfficialSubscription(request, sessionAuth) {
  // 优先评估现有 Codex 官方登录保持模式及成熟网关的双层凭据做法。
  // 真实 OAuth 认证、requires_openai_auth 及 desktop 请求具体表现必须实测。
  // 如果采用 SIWC：必须走对应公开推理端点、验证 audience/scopes 和动态注册；
  // 如果采用 Codex 登录透传：单独审计身份路径与实际支持边界。
  // 不复制/落库原 Codex 登录文件；未知授权状态不能静默当成 API Key。
  return dispatchOnlyAfterCorrectAuthDomainAndModelValidation(request, sessionAuth);
}
```

改造核点：`src/codex/auth.js`、`src/codex/local-subscription.js`、`src/subscription/oauth.js`、`src/codex/target-authz.js`、`src/router.js`、`src/index.js`。认证层记录诊断码但不得记录 Token；拒绝跨域重定向、凭据混用、非法回退；401/403 不转为成功或者私自转其他模型。

验收：官方登录保持前后同一账户；官方 GPT 请求确为 GPT-6 Luna；Go 子请求确为指定非 GPT 模型，且无 ChatGPT 账户头；错误路径都为 typed status。**本阶段可以先完成零费用模拟；真实订阅测试未获授权则 BLOCKED。**

## F. 阶段 P03：Codex Desktop 一键配置集成（A3/A4）

```ts
// 目标：用户点击“聚合模式”后由 ModelGate 自动完成全部配置，不要求编辑 TOML。
async function activateAggregationFromGui(choice) {
  const found = await detectInstalledCodexAndDesktopVersions();
  const current = await readUserOwnedConfigWithoutReadingAuthJson();
  const preview = diffOnlyOwnedKeys(current, {
    model_provider: "modelgate", catalog: "autoManagedFullCatalog",
    default_subagent_model: choice.subAgentModel ?? undefined
  });
  await displayReadablePreviewAndCollectConsent(preview);      // 首次设置及覆盖既有配置明确确认
  const lease = await acquireConfigLockAndCheckSha(preview.originalSha);
  const backup = await backupExactBytesWith0600Permissions(current);
  try {
    await atomicApplyOnlyOwnedKeysAndValidateParser(preview);
    await verifyModelGateHealthCatalogAndDesktopConfig();     // 不可写盘后立刻称完成
    return { mode: "aggregation", backupId: backup.id, needsAppRestart: found.needsRestart };
  } catch (error) {
    await atomicRestoreIfWeStillOwnChangedBytes(backup, lease);
    throw typedConfigError(error);                            // 不擦除第三方新增改动
  } finally { await releaseConfigLock(lease); }
}
async function deactivateAggregation() {
  // 恢复用户原配置及官方登录状态；仅撤销本产品负责的配置字段
  // 若用户在此期间手动修改，先 409 + UI 展示三方 diff，不覆盖。
  return compareAndRestoreOwnedChanges();
}
```

复用 `src/codex/config.js` 的配置事务、`src/codex/catalog-generation.js` 的原子目录、`src/ui-next/js/views/codex.js` 的预览、`src/ui-next/js/views/providers.js` 的 Provider 表单、`src/ui-next/js/views/clients.js` 的客户端检测。主代理接入新增 `src/codex/desktop-integration.js` 和 `src/ui-next/js/views/aggregation.js`，保持旧 UI 功能可用。

必须验证本机 Codex 版本的远程 `model_catalog_url` 与本地 `model_catalog_json` 在原版 Desktop GUI 的真实行为；远程目录失效时由 ModelGate 自动维护本地全量目录，**不将手工编辑作为正式用户的兼容办法**。

验收：空白配置、已有手改配置、多版本 Desktop、模型增加/删除、目录超限、损坏配置、进程崩溃、并发覆盖、回滚前后 SHA 与启动 GUI 的真实模型列表。只准有一次性用户授权交互，不能要求开发命令操作。

## G. 阶段 P04：原生 Agent Team 不降级（A1，A5 验收）

```ts
async function verifyNativeAgentTeam(codexDesktop, gptParent, opencodeChild) {
  assert(gptParent.model === "gpt-6-luna");             // 仅允许这一 GPT 父模型
  assert(opencodeChild.isAuthorizedNonGptModel);
  const t = await codexDesktop.startNativeThread(gptParent);
  const child = await t.spawnNativeAgent({ model: opencodeChild.publicId, task: randomTaskA() });
  const a = await t.waitNative(child.id);                 // 同一原生 thread ID
  assert(a.toolReceipt && a.taskACompleted);
  const b = await t.sendNativeFollowup(child.id, randomTaskB());
  assert(b.childId === child.id);                        // 不通过重启创建新子代理
  const done = await t.waitNative(child.id);
  assert(done.taskBCompleted && done.receivedTaskAContext);
  await t.interruptAndResumeNativeSubagentInSeparateCase(child.id);
  assertOriginalProviderAndToolsPreserved(t, child);
  return collectRedactedReceiptsBoundToCommit(t, child);
}
```

在 `src/codex/interop.js`、`src/responses.js`、`src/responses-stream.js` 内遵守如下不变量：不可读密文不得当空任务发 Go；协议适配不得静默删除未知工具；SSE 要有唯一终态且终态前保留请求预算与并发槽位；取消/等待/工具消息的关联 ID 保真；不默默将高能力协作改成经典 V1、Chat 桥或 MCP。

如果上游发送的 V2 任务正文不可读：保持错误可见、执行保真分析与受支持的原生接口适配，研究并实现真正闭环；**不得把关闭 followup/interrupt 或改成外部调度器当完成**。经典工具可用于诊断与回归，但完整发布门禁仍为 MG-R005/R006。

## H. 阶段 P05：多用户与安全（A4 主责、A5 反向验证）

```ts
function authenticatedOperation(actor, providerId, modelId) {
  const owner = requireUserScope(actor);                          // 用户隔离，零默认跨账号
  const provider = requireProviderOwnedBy(owner, providerId);
  const model = requirePublishedBindingFor(owner, provider, modelId);
  enforceKeySeparationAndNoSecretsInLogs(owner, provider);
  enforceQuotaAndSafeCancellation(owner, provider, model);
  return invokeWithoutCrossTenantFallback(provider, model);
}
```

验收：两个完全隔离的本地用户/工作区 fixture；跨租户配置、Key、目录、用量、日志拒绝；官方 Token 永不送到 Go；网络跳转/密钥错误/计费软阈值都明确提示；不得默认上传用户历史或请求正文。

## I. 阶段 P06：完整产品验收与发布门禁（A5 独立负责，主代理只整合）

```ts
const matrix = [
  {id:"MG-R001", tests:["gui-activate","gui-deactivate","restart"]},
  {id:"MG-R002", tests:["codex-official-login-unchanged","official-gpt-6-luna-real"]},
  {id:"MG-R003", tests:["all-opencode-console-models","all-opencode-go-models","refresh-diff"]},
  {id:"MG-R004", tests:["desktop-model-picker-official","desktop-model-picker-go","desktop-model-picker-console"]},
  {id:"MG-R005", tests:["native-child-thread-not-mcp","native-tools"]},
  {id:"MG-R006", tests:["same-child-two-tasks","interrupt","resume","context","no-duplicate"]},
  {id:"MG-R007", tests:["fresh-install-no-manual-edit","existing-config-preserve"]},
  {id:"MG-R008", tests:["no-silent-fallback","unsupported-tool-fails-explicitly","catalog-not-truncated"]},
  {id:"MG-R009", tests:["two-user-isolation","token-rotation","redacted-logs"]},
  {id:"MG-R010", tests:["rollback-byte-compatible","crash-recovery","conflict-409"]},
  {id:"MG-R011", tests:["receipts-pin-sha","mock-vs-real-accuracy"]},
  {id:"MG-R012", tests:["codex-gpt-parent-only-luna","no-gpt-fallback"]},
];
function review(candidate, evidence, ownerApproval) {
  for (const requirement of matrix) {
    if (!evidence[requirement.id]?.passedAllOnRealTarget) {
      return { ready: false, status: "BLOCKED", failedRequirement: requirement.id };
    }
  }
  return { ready: ownerApproval === true, canAskOwnerToMerge: true };
}
```

离线执行：`npm run check && npm test && npm run docs:check && node scripts/check-metadata.mjs && node scripts/check-product-contract.mjs`；每条新增测试可由 A5 脱敏登记。真实 Codex 测试只能经 A5 在用户明确授权的额度/时间窗中进行，GPT 父模型仅 `gpt-6-luna`；Go 子模型不被替换。测试不通过就继续修复，不反向改动断言或需求。

## J. 集成顺序、PR 策略与不可重复规划约束

```text
P00 基线保全与需求映射（主代理）
  ├─ P01 OpenCode 全量发现（A2）────────────────────────────┐
  ├─ P02 订阅授权与隔离（A4）──────────────────────────────┤
  ├─ P03 原版 Desktop 自动配置与 GUI（A3，在接口稳定后）──────┤
  └─ P04 原生协议、会话与 Agent Team（A1）─────────────────┤
                 ↓ 主代理整合共享入口、无并发冲突               │
             P05 多用户安全（A4）                               │
                 ↓                                              │
             P06 独立真实验收（A5） ←───────────────────────────┘
                 ↓
             所有者明确批准 PR 合并 / 发布（不自动进行）
```

- 既有 Draft PR #5 与 `integration/modelgate-release` 等分支按差异逐项复用，不做无审计的 `merge -s ours`、强推或覆盖；优先在 `mg-codex-native` 新建隔离实现分支/ worktree。小 PR 按“接口/发现/授权/GUI/原生协议/验收”分开，防止大改掩盖回归。
- A1–A4 的独立分支不得写同一个共享文件；主代理将共享入口和集成冲突串行处理；A5 只审查证据和反向用例，发现源码/测试被同时弱化应拒绝签收。
- 每个 PR 描述必须列出关联 MG-R ID、变更前后用户体验、模型/上游实际身份、真实与模拟结果、未解决阻断、预算与回滚。不得用“完成任务数量/通过单测数量”代替产品能力。
- 允许研发任务连续执行直至所有可免费验证的条目完成；**涉及新增资源、付费 API、生产配置、最终合并、发布时停在明确审批门**。阻断是阶段事实，不是缩小功能的授权。
- 不再生成替代总体方向的新计划；需要调整内部实现时只更新局部 ADR/代码注释/PR 记录。未经所有者批准，绝不删除或降低 MG-R001..MG-R012。
