# ModelGate｜V2 直接执行计划：Codex Desktop × OpenCode Go DeepSeek × 原生压缩

> **本文件替代** [V1 全模型实施计划](2026-11-14-aggregation-pseudocode-plan.md) 作为当前执行入口，理由为 2026-11-14 所有者的**明确范围变更**，不是开发 AI 擅自降级。唯一现行验收依据为 [V2 所有者决议](../product/2026-11-14-owner-scope-v2.md)。历史 PR #7 / `mg-codex-native@743ddec` 与原证据必须保留，不重复规划或重写历史。
>
> 直接执行，所有代码块均为**待实现伪代码 + 设计注释**，不能将本计划当作已实现功能。禁止安装大型依赖、耗费真实 GPT/Go 推理、修改日用 Codex 凭据/服务、自动合并 main，除非所有者针对该具体动作明确授权。

## 0. 单一交付目标、不可用旧门禁蒙混

**只验收**：ModelGate GUI 开启聚合 → 一次添加 OpenCode Go（目标模型 `deepseek-v4.1-flash`）→ 原版 Codex Desktop GUI 中保留 ChatGPT 套餐、可选官方模型与该 Go 模型 → Codex 原生父子 Agent Team 完成工具、追派、中断、**原生压缩**、恢复 → GUI 退出后原配置与登录完整恢复。

**明确非目标**：OpenCode Console 全量；20 条 Anthropic/Google 协议模型；所有 Go 模型；自建摘要/压缩算法。其他模型可进行一次无需新开发的有界初探，失败即 OPTIONAL_STOP。

**优先验收映射**：MG-R003（唯一 DeepSeek 目标）、MG-R004（原版 Desktop 选模）、MG-R006（Codex 原生压缩及连续任务）、MG-R008（无静默模型/历史降级）、MG-R012（Codex 真实 GPT 仅 Luna）。其它 MG-R 编号继续按现行 V2 契约验收。

**判定边界**：此前 CLI 真测 R005/R006 虽已取得真实原生 spawn/interrupt/resume 回执，但原生压缩发生 `unsupported_input_item`，故**V2 MG-R006 尚未完整通过**。V1 矩阵标出的 R006 `PASS_REAL` 仅为旧用例历史状态。此轮新门禁必须包含压缩实测；绝不删掉已有失败记录。

## 1. 执行顺序、Agent Team 与责任边界

- 主代理：架构/集成/PR/共享入口（`src/index.js`、`src/router.js`、package/CI/导航），独立于验收；不亲自执行 Codex 真实 GPT 测试。
- **A1 / Codex Native Compaction Engineer**：只负责原版 Codex 原生压缩能力选择、协议保真与兼容；写 `src/codex/interop.js`、相关原生目录/能力元数据（经主代理分配）、专属测试。
- **A2 / Go Single-Model Integration**：只负责 Go `deepseek-v4.1-flash` Provider 模板、授权/Responses 路由、模型 ID/状态；写 `src/providers/opencode-go.js`、受控 `src/aggregation/*` 的分配文件及测试；**禁止展开到 Console/全模型**。
- **A3 / Desktop GUI & Configuration**：只负责 GUI 一键开启、选模、退出和无损回滚；写 `src/ui-next/js/views/aggregation.js`、`src/codex/desktop-integration.js` 的独占块及 UI 测试；原版 GUI 实测由 A5 验收。
- **A4 / Subscription Security & Reliability**：只负责 ChatGPT 套餐保持、双授权域、请求收据、SSE/取消安全、凭据保护与可分发账户隔离；写 `src/subscription/*`、`src/codex/target-authz.js` 及安全测试。
- **A5 / Independent Native QA**：只读原始需求及代码审计、维护独立测试/证据，负责所有真实 Codex 测试；提交失败记录与门禁结果；不得修改产品契约或通过删测试实现通过。

**Agent Team 同时最多 5 个子代理**（A1–A5），主代理协调；每个子代理独立 worktree/写集，冲突文件由主代理单写者集成。若所用执行环境不提供原生 Agent Team，只能如实串行工作，不能虚构子代理已运行。

## 2. P00（第一优先）：状态保全与 V2 验收门禁纠偏 —— 主代理 + A5

```bash
git status --short && git branch --show-current && git rev-parse HEAD
# 先查未提交原型，不覆盖任何 worktree/用户进程/真实 Codex HOME。
# 读取 V2 所有者决议、V1 证据、PR #7、RESOURCE_APPROVAL.md。
npm run check && npm test && npm run docs:check
node scripts/check-metadata.mjs && node scripts/check-product-contract.mjs
```

```ts
// 主代理 + A5 必须先将当前验收权威源改为 V2，保留旧状态作为 historic/v1。
// 修改: scripts/test/offline/aggregation-matrix.js / aggregation-gate.js /
//       aggregation-acceptance-matrix.test.mjs / docs/evidence/* / check-product-contract.mjs
const requirements = parseOwnerScopeV2("docs/product/2026-11-14-owner-scope-v2.md");
const cases = new Map([
  ["MG-R003", ["go-deepseek-auth-real","go-deepseek-inference-real","model-id-exact"]],
  ["MG-R004", ["desktop-picker-gpt","desktop-picker-deepseek"]],
  ["MG-R006", ["native-tool","same-child-followup","interrupt","native-compaction",
               "post-compact-followup","context-proof","resume","no-duplicates"]],
  ["MG-R008", ["no-silent-model-fallback","no-silent-tool-drop",
               "no-silent-compaction-drop","typed-error","request-identity"]],
]);
function migrateGate(oldEvidence) {
  // 保留历史 SHA、回执、失败；只复用语义等价的实测子用例。
  // R006 的旧 PASS_REAL 不足以通过新 native-compaction 子用例。
  // 不允许手工篡改以前通过的回执；生成 V2 独立矩阵与版本钉死。
  return regenerateV2MatrixWithUnmetNewCriteria(oldEvidence, requirements, cases);
}
```

**P00 完成条件**：所有 AI 入口指向 V2，CI 可以发现“20 个不支持模型”不再是阻断、但“Codex 原生压缩未真实通过”仍然阻断；旧 V1 文档保持可追溯，PR Draft 不自动转 ready。新增门禁通过不等于产品通过。

## 3. P01（最高产品优先级，可与 P02 并行）：原版 Desktop 一键聚合 —— A3 + A2 + A4

现有产物：`src/codex/desktop-integration.js`、`src/ui-next/js/views/aggregation.js`、`src/aggregation/handlers.js`、`src/codex/catalog-generation.js`、`src/codex/config.js`。优先修复真实用户操作，不重新写 UI 框架。

```ts
async function onboardGoFromGui(input, currentCodex) {
  assertInteractiveUserConsent(input);                 // 初次配置授权
  const go = selectPreset("opencode-go");             // 正式只要求该提供商
  await storeScopedCredential(go, input.credential);  // 不把 Key 打印、入库正文/日志
  const model = await resolveExactTarget("deepseek-v4.1-flash");
  if (!model.availableOrVerified) return typedBlocked("target_model_unavailable");
  const candidate = aggregate([officialCodexModels(), model]); // 保留官方列表
  const diff = await codexConfigPreview(currentCodex, candidate);
  await userApproveVisibleConfigDiff(diff);
  const backup = await atomicBackupWithSha(diff.original);
  try {
    const applied = await applyOwnedKeysOnly(diff);   // 不要求用户手改 TOML
    await checkGatewayCatalogAndClientReload(applied);
    return { status:"active", model:"mg-opencodego-deepseek-v4-1-flash",
             needsCodexRestart: detectRestartNeed(), backupId:backup.id };
  } catch (cause) {
    await rollbackWithoutOverwritingConcurrentUserEdits(backup);
    return typedFailure(cause);
  }
}
async function exitAggregation() {
  // 只撤销 ModelGate 拥有的变更；不删除 ChatGPT 登录，
  // 冲突时给出三方差异，不覆盖用户后来修改的配置。
  return restoreOriginalCodexIntegration();
}
```

**真实演练**：原版 Codex Desktop → 官方 GPT-6 Luna 正常调用 → 切换 Go DeepSeek → 再切 GPT；用户无需改配置，选择器确实列出模型。记录 GUI 回执、供应商模型真值、订阅仍有效、退出/恢复后的配置哈希。其他模型存在于旧目录但不应成为必须逐一验证的功能。

**缺省失败**：如果官方 Desktop 当前版本无法热加载模型目录，则 GUI 提示用户重启一次并在重启后自动继续；不得要求手动修 TOML。

## 4. P02（第二优先级，也是关键阻断）：适配 Codex 原生压缩 —— A1（A4 支援）

**既有真实失败**：`src/codex/interop.js` 对 input item `type: "compaction"` 的历史投影在部分第三方路由上返回 `unsupported_input_item`；旧实测调整 128k→200k 避开触发，并没有验证压缩工作。

**必须先查原版 Codex 0.167.0 / 当前 Desktop 捆绑 Codex 的源码与真实行为**。Codex 原生可有本地由客户端管理的压缩和远程 Responses compaction 两种路径，选择可能与 Provider capabilities 有关。**不能凭最新版 Codex 源码假定 0.167.0 的行为完全相同。** 

```ts
type NativeCompactionPath = "codex-owned-local" | "codex-owned-remote-supported";
async function inspectNativeCompaction(codexVersion, childModel) {
  // 依据实际客户端版本查 compact.rs / compact_remote_v2.rs / child_config.rs /
  // models.rs、RemoteCompactionSupport、模型目录和选模/会话配置。
  const trace = await captureNativeCompactionControlAndItems(codexVersion, childModel);
  return {
    trigger: trace.trigger, // Codex 自己发出的 compaction_trigger 或 native compaction event
    ownership: trace.owner, // MUST codex runtime
    historyFormat: trace.historyFormat,
    remoteCompaction: trace.providerCapabilities,
    opaque: trace.containsEncryptedContent,
    resume: trace.nativeResumeBehavior
  };
}
function planCompactionCompatibility(codex, goModel) {
  // 通过 Codex **原生** Provider/model capabilities 与受支持配置，
  // 使 Go 子代理采用 Codex 自己管理、目标模型可处理的压缩流程。
  // 不给 DeepSeek 塞 ChatGPT 加密的 compact item；不能默默丢掉该 item。
  // 需要时改 Codex 客户端的合法配置/模型能力声明，或提交可审计的原生扩展方案，
  // 不在 ModelGate 另建 summarizer、摘要缓存、服务端压缩请求或 LLM 历史裁剪。
  return selectNativeCodexPathProvenCompatible(codex, goModel);
}
function forwardOrRejectCompactionInput(item, route) {
  if (route.nativeCompactionOwnedByCodex && route.accepts(item)) return passOpaqueUnchanged(item);
  // 这里拒绝是防止泄漏和伪成功的技术保险，不是最终功能验收结果。
  // 修复方向是让 Codex 选出可兼容的原生路径，而不是跳过/删除 item。
  throw typedError("native_compaction_route_not_ready", { model:route.model });
}
```

### 必须实现的压缩验收（不可用增大窗口代替）

```ts
async function verifyCodexNativeCompact(codexParent, deepseekChild) {
  const child = await codexParent.spawnNative(deepseekChild);
  await child.execTool("printf COMPACT_BEFORE_OK");
  await child.addHistoryAndWaitForCodexOwnedCompaction(); // 测试模式用原生门槛触发
  const evt = await observeActualNativeCompactionEvent();
  assert(evt.owner === "codex");                        // 不是 ModelGate 独立摘要
  assert(evt.terminalSuccess && !evt.droppedHistory);
  const result = await child.followup("继续，并回忆第一次工具标记");
  assert(result.includes("COMPACT_BEFORE_OK"));
  assert(child.id === result.childId);                  // 同一原生子代理
  assert(noSilentModelSwitchOrToolLoss());
  await verifyNativeResumeAndInterruptAfterCompaction(child);
}
```

- 离线：实际 Codex 协议 fixture 验证 item 次序、工具 call_id、历史完整、不透明项拒绝/安全透传、SSE 终态、取消信号，不能删 `compaction` 后假成功。
- 原版 CLI：在**隔离** Codex 配置中使用 Codex 自身支持的较低自动压缩阈值触发真实压缩（不得通过修改 Go 上游声称完成）；观察完整客户端事件及压缩前后状态。
- 原版 Desktop：在可执行的有界测试里重复压缩/追派、恢复；若真实令牌预算不足，记 BLOCKED，不通过把窗口调大让压缩不发生来签收。
- 任何真实 Codex GPT 调用**只允许 `gpt-6-luna`**；A5 执行并记录带 SHA 的真实回执；Go 请求只允许目标 DeepSeek。
- 先保留既有 128k 溢出失败的原始报告。修复完要有实际压缩事件成功及相同会话的后续输出，不能仅宣称 200k 顺利完成。
- **禁止** `ModelGate.summarize()`、伪装 `compaction` 返回对象、按 token 进行历史裁剪、自建 summary worker、生成虚假的 `encrypted_content`、默认关闭自动压缩。

## 5. P03：打通真实原生体验并修复阻断 —— 主代理 + A1/A3/A4；A5 验收

```ts
const criticalPath = [
  "desktop-aggregation-on",
  "official-gpt-6-luna-in-original-desktop",
  "opencodego-deepseek-v4.1-flash-in-original-desktop",
  "native-gpt-parent-spawns-go-child",
  "native-shell-tool-and-wait",
  "native-followup-same-child",
  "native-interrupt-resume",
  "native-codex-compaction-and-post-compact-followup",
  "desktop-restart-session-resume",
  "desktop-aggregation-off-and-login-unchanged"
];
async function finishProductPath() {
  for (const step of criticalPath) {
    const result = await independentQA(step);
    record({ step, status: result.status, commitSha: HEAD,
             version:result.version, redactedReceipt: result.receipt });
    if (result.status !== "PASS_REAL") markBlockingAndFixWithoutChangingTarget(step);
  }
}
```

- 清除 P01/P02 的实际阻断，尽可能复用已有真实 CLI R005/R006 成果；不重跑非必要全量模型、Anthropic/Google 适配。
- 原生等待、追派、中断、会话重启后恢复与 SSE/WS 必须与使用中的 Codex 版本对齐；若 WS 升级失败但有可靠原版客户端原生 HTTP 回退，按本次目标真实测试，不单因协议名字阻断；任何工具或会话语义损失仍是 FAIL。
- Go key 失效、错模型、父套餐额度耗尽等错误必须按真实域返回，禁止静默换路由/套餐。
- 账号 token 文件可在用户授权下安全读取/备份用于隔离验收，不再使用“永不触碰”作为阻断理由；不泄漏、不提交、不影响日常登录。

## 6. P04：未来用户可用性、隔离与成本控制 —— A3/A4

```ts
function installForAnotherUser(scope) {
  // 第一次启动：启动服务→选择聚合→填 Go Key→自动配置 Codex
  // 退出聚合：原始授权/配置仍正常。
  const profile = isolateUserScopedConfigAndKey(scope);
  assertNoCrossTenantKeysOrHistory(profile);
  return guiOnboardingWithoutDeveloperCommands(profile);
}
function optionalModelProbe(model) {
  // 只复用现有适配器；有许可且有预算才发测试。
  const result = oneBoundedProbe(model);
  return result.ok ? {status:"OPTIONAL_COMPATIBLE"} : {status:"OPTIONAL_STOP"};
  // 不生成后续适配任务，不增加正式发布门禁。
}
```

至少验证空白用户、已有 Codex 配置用户、隔离第二用户、崩溃回滚、409 配置冲突；保证不破坏用户日常服务。真实用户测试有权限/费用门槛则标 BLOCKED 申请授权。

## 7. P05：独立最终验收、PR/CI 与停止条件 —— A5 + 主代理

1. `npm run check`、`npm test`、`npm run docs:check`、`node scripts/check-metadata.mjs`、`node scripts/check-product-contract.mjs`、V2 门禁均必须通过。
2. **冻结最终源码 SHA 后重新执行核心路径**；历史 `4feafe0` Luna、`67b9735` 原生 CLI 证据可用于确定修复起点，不自动覆盖新 SHA 下的缺少验收。
3. `MG-R001..012` 每行关联真实原版目标证据；`MG-R006` 必须包含 native compaction 实测后才允许 PASS_REAL；`MG-R003` 只需 DeepSeek 而不是 80 个 OpenCode 模型。
4. PR #7 保持 Draft，未获所有者批准不得合并主线、发布或改保护规则；分支执行使用 fast-forward，不强推，冲突先停并重审。
5. 付费真实测试、安装/下载、修改生产配置、运行日常 Codex 或新增公开 OAuth 均需要按 `RESOURCE_APPROVAL.md` 和所有者指令审批。**本计划不自动提供新真实计费测试授权**。
6. **禁止无尽规划循环**：每个角色只提交代码、测试、脱敏证据与准确状态；优先交付 GUI 和压缩闭环，不为可选模型增加工作包，不给“不需要实现”的范围继续消费 Token。

## 8. 可复制的 QA 任务卡（每项有明确 owner、被测对象和交付）

| 优先 | 任务 ID | Owner | 实现写集（检查现有代码后分配） | 必须得到的结果 |
| --- | --- | --- | --- | --- |
| 0 | V2-00 | 主 + A5 | `scripts/test/offline/aggregation-{matrix,gate}*.js`、`docs/evidence/*`、守卫 | V2 契约不与 V1 混淆，原生压缩是新正式门禁 |
| 1 | V2-01 | A3 | `src/codex/desktop-integration.js`, `src/ui-next/js/views/aggregation.js` | 原版 Desktop 无手工修改的聚合/选模/退出 |
| 1 | V2-02 | A2 | `src/providers/opencode-go.js`, `src/aggregation/{registry,catalog,handlers}.js` | 唯一 DeepSeek 模型绑定、授权和正确出站 |
| 1 | V2-03 | A4 | `src/subscription/*`, `src/codex/target-authz.js` | 原 ChatGPT 订阅继续正常、Go 凭据隔离、错误可归因 |
| 2 | V2-04 | A1 | `src/codex/interop.js`, `src/codex/catalog.js`, 目标测试 | Codex **自身**压缩触发→完成→同子恢复，无自建压缩 |
| 3 | V2-05 | 主 + A5 | 共享 `src/index.js`, SSE/路由测试；真实证据 | 原版 Desktop 多回合 E2E，不静默丢工具 |
| 4 | V2-06 | A3/A4/A5 | 安装/配置/租户测试与证据 | 两用户隔离、异常恢复、回滚 |
| 5 | V2-07 | 主 + A5 | CI/PR/evidence | 完整真实门禁、最终批准（不自动合并） |

**任何完成声明必须区分** `PASS_MOCK`、`PASS_REAL`、`BLOCKED`、`NOT_TESTED`、`FAIL`。测试中的临时规避只能服务诊断，不能冒充修复。每轮结束只报已可使用能力、明确未完成问题、证据、下一步修复，禁止编造进度百分比。

[角色激活启动提示词](2026-11-14-go-deepseek-native-compact-start.md)
