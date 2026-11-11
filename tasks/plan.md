# ModelGate M0–M5 执行规格

2026-11-11 · 供 [AgentTeam 启动提示词](agentteam-start.md) 调用。任务、文件范围和验收编号见 [任务卡与验收矩阵](todo.md)。安全发现、Git 依赖和基线证据见 [独立审计](../docs/audits/2026-11-11/audit.md)、[PR 审计](../docs/audits/2026-11-11/git-pr.md) 与 [复验](../docs/audits/2026-11-11/verification.md)。

## 1. 交付口径

本次计划完成一条从远端 main 开始、可验证、可回退的本地集成线。修复三个 P0，统一网关尝试与 SSE 语义，交付安全的 Codex 目录及适配、可解释路由和预算、控制台与本机导出、UHR 委派契约与隔离演练。最小产品默认保持官方 Codex 直连、第三方使用独立 profile，避免改变现有用户线程和凭据。受控官方聚合、真实 UHR、真实 Desktop、真实历史迁移和订阅额度分别有激活门槛及验收矩阵。

- **本地交付默认。** 提示词默认 `DELIVERY=local`。执行到隔离集成提交、最终复验、证据和遗留清单。启跑前可在同一条提示词选 `draft-pr` 或 `merge-main` 授权相应远端动作。远端阶段遇到缺失检查、分支漂移或冲突，保留可交付本地结果并结束。部署另有权限，三种模式都不部署。
- **开发调用与产品调用分别算。** 开发主控、四位作者与 QA 均走已有 OpenCode Go 的 DeepSeek V4.1 Flash。ModelGate 的测试上游全部合成和回环，真实产品 API 预算 0。继续使用启动环境已授权的开发额度，不启用额外付费或换账号。
- **允许有限降级。** 合法未授权的路径实现到默认关闭和可验收的隔离边界。UHR 契约不可用时交付 mock 与契约测试。只要候选仍有 P0 或回归，受影响入口不得接进集成线，后续任务依赖该入口时标 `BLOCKED_DEPENDENCY` 并继续其余分支。
- **保持源码历史。** 参考 SHA 为 main `6bc6441`、#5 `ec66b24`、#6 `64a5c96`。开跑重读实际远端、关联 PR、合并祖先和所有工作树。稳定能力从 #5/#6 按切片保留出处，G0–G4、#2、#4 只取经证实的唯一差异与测试，避免重复接线。审计文档提交 `d84a2a4` 是参考，产品线基于实时核实的远端 main。

依赖图如下。相同文件一次只有一位写者。前置契约已冻结时，纯模块、静态审查、夹具可并行，运行接线按顺序进入同一集成线。

```text
P00 现场冻结
  ├─ M0-1 安全 runner → M0-2 Key 语义 → M0-3 存盘事务 ─┐
  └─ M0-4 文档与检查 ──────────────────────────────────┤
       ├─ M1-1 尝试与状态 → M1-2 SSE/桥 → M1-3 接线 → M1-4 可选端点
       └─ M2-1 出站身份 → M2-2 目录 ─┬─ M2-3 真实 CLI 双 Mock
                ↑ M1-1               └─ M3-1 决策 → M3-2 账本 → M3-3 接线
       ├─ M4-1 管理安全 → M4-2 控制台 → M4-3 历史/额度投影
       └─ M5-1 推理回执 → M5-2 MCP / mock UHR → M5-3 可用性矩阵
   R00 固定集成树回归 → R01 交付与收口
```

## 2. M0 主干安全与事务

### 2.1 默认离线 runner

```text
runDefault(selected = explicitOfflineManifest):
    # 仅接受列出的合成测试，目录新增文件不会自动进入运行器
    for suite in filterKnownSuiteNames(selected):
        tmp = freshPrivateDirectory()
        mock = bindLoopbackEphemeral()
        launchGateway(config = syntheticConfig(mock.url),
                      home = tmp.home, configDir = tmp.config,
                      keysMaster = syntheticMaster,
                      childEnv = allowlistedEnvironment())
        # 每条旧测试先改造为接受当前实例地址，默认地址不许退回 8787
        assert suite has explicit URL and owned fixture
        result = runSuiteWithTimeout(suite, loopbackOnly, isolatedState)
        finally stopOwnedFixtureAndReapChildren()
        report suites, assertions, errors, skips separately

# 已知 legacy live.mjs 的扫描式排除曾漏掉读取凭据的真实测试。
# opt-in 真实验收必须有独立脚本和场景授权，绝不由文件名自动发现。
```

主干现有 `MG_CONFIG_DIR`、`MG_CONFIG`、`MG_KEYS_MASTER` 可复用。旧版缺少支持端口 0 的公开启动返回值时，先加测试注入或确认隔离实例实际监听端口。测试网络从运行 DSH 的环境分离，首选已验证的 `unshare -Urn` 回环命名空间，或使用进程内 transport mock 保证无出网。禁止借宿主真实服务填缺口。

### 2.2 数据面 Key 的三态与过期

```text
planClientKeyUpdate(patch, current):
    # 先看原始 patch 是否自有该字段，合并 defaults 后无法判断省略意图
    if fieldAbsent(patch.defaults, "clientKey") or valueIsMask(patch):
        if hasSealedClientKey(current): return KEEP
        if hasLegacyPlaintext(current): return MIGRATE_EXISTING_VALUE
        return KEEP
    if value == "": return EXPLICIT_CLEAR
    if !validNonEmptyString(value): return INVALID_400
    return REPLACE_WITH_SEALED(value)

parseVirtualExpiry(persisted):
    if missing or empty: return NO_EXPIRY
    # 同时兼容已有毫秒值、ISO 8601 带时区及旧 datetime-local。
    # 无时区的旧值按现有 UI 的本地时区解释，保存后写显式时区或 epoch 毫秒。
    parsed = parseAndValidateKnownFormats(persisted)
    if invalid or ambiguous: return INVALID_DENY_AND_DIAGNOSTIC
    return parsed.epochMs
```

`MG_CLIENT_KEY` 保持已有环境覆盖优先级。密钥删除须显式，管理审计只记录动作和代际。前端不应以空输入代替“未改动”。过期边界用可注入时钟，已有格式用固定时区夹具覆盖。

### 2.3 配置与 Key 的提交和恢复

两个文件无法用单次 rename 一起提交。继续读原有 JSON 与加密 key 格式，以目录级单写者锁、受保护的意图记录和提交标记协调。项目内部管理写入、reload 和 key/token 保存共享入口。外部编辑仍可被识别，无法保证与不协作外部编辑者做跨文件 CAS。发生无法归因的内容变化时，保留文件、停止写入、保留已知运行快照或启动拒绝，交由收尾记录。

```text
updateConfig(request):
    requireAdminAndValidOrigin()
    with configWriterLock:
        current = loadAndRecoverOwnedStore()
        validateGenerationAndDiskFingerprints(request.expected, current)
        next = validateAndBuildWholeGeneration(current, request)
        # journal 只存受限文件 ID、代际、哈希和阶段，payload 只在私有 staging
        stageOldAndNewGeneration(configJSON, sealedKeys, mode = 0600)
        fsyncStagedFilesAndDirectory()
        persistIntent(oldHash, newHash, operationId)
        # 保存出错期间不发布内存 cfg，也不降低已有鉴权
        for target in [keys, config]:
            assert target matches expectedBytes and ownedStorePath
            replaceViaAtomicRename(staged[target], target)
        fsyncDirectory()
        persistCommitMarker(operationId)
        publishInMemoryGeneration(next)
        cleanupOnlyOwnedCompletedArtifacts()

recover():
    if noIntent: return validatedLegacyOrCurrentSnapshot()
    inspect current fingerprints against journal old/new pair
    if explicitCommitMarker and bothNew: finalizeCommittedGeneration()
    else if uncommitted and eachFileIsOldOrNew: restoreOwnedOldGeneration()
    else: recordConflictPreserveDiskAndFailClosed()
```

写入临时文件、落盘、发布三个时点须可注入失败，测试进程中断后重启。日志只含动作、代际、结构化错误。权限、失效、外部修改、遗留迁移必须在相同提交的配置文档明确。

## 3. M1 单请求执行器、SSE 与端点接线

### 3.1 请求生命周期

```text
execute(request, adapter, policy):
    deadline = monotonicDeadline(request.overall)
    context = { stage: UNSENT, attempts: [], firstCommit: null }
    while deadline.remaining and policy.hasBudgetForAnotherAttempt(context):
        decision = policy.next(context)              # 返回明确 provider/model/attempt
        if decision.stop: return typedErrorOrSafeTerminal(decision)
        permit = authorizeFinalTarget(decision.target, request)
        # 目标等待也消耗同一个 deadline，取消可唤醒；令牌一律 finally 归还
        lease = acquireConcurrencyAndRateLimit(permit, deadline, request.signal)
        try:
            if signalAbortedBeforeSend: return CANCELLED_UNSENT
            attempt = openAttempt(permit, deadline)
            onWriteBegin -> SENT_UNKNOWN             # 写开始即不能假设未送达
            onKnownRejection -> REJECTED_BEFORE_EXECUTION only with evidence
            onResponseHeaders -> ACCEPTED
            onFirstSemanticEvent -> DELIVERED
            onToolIntentOrCommit -> TOOL_RISK_OR_PARTIAL_COMMIT
            onTerminal -> SUCCEEDED_OR_FAILED
            result = adapter.forwardOnce(attempt)
            context = recordTypedOutcome(result)
        finally:
            release(lease)

    # 不按 HTTP status 单独推导可安全重放。
    # 未发送或供应商可证明前置拒绝时才考虑下一次。
    # 写后无头、半截流、工具/视频副作用未知时返回可诊断终态。
```

低层 `forwardOnce` 禁止内部自动再尝试。已证实前置限流时按 `Retry-After` 与剩余预算决定是否等待，保持 429 及头语义，独立于熔断。402 与模型不可用有明确归因且未执行时才可换候选。不能归类的业务 4xx 原样归一返回。取消独立于失败和熔断，断流返回一次终态。仅当供应商公开续传且同 attempt 能证明恢复位置时允许续流。先接 Chat / 原生 Responses / Chat 桥，再接其他端点。

### 3.2 SSE 与工具配对

```text
relay(readable, writable, wire):
    decoder = streamingUtf8Decoder()
    items = Map<responseItemId, itemState>()
    calls = Map<callId, ownerAndArgumentState>()
    for chunk in readable:
        frames = parseBoundedSse(decoder.decode(chunk), newline = LF_OR_CRLF)
        for frame in frames:
            event = wire.normalize(frame)
            # 同一 item 的 add/delta/done/completed.output 使用同一 ID
            # 工具 delta 按上游协议增量累加，只能给对应 callId
            updateStateWithoutRenumbering(event, items, calls)
            if event is semanticOutput: markDelivered()
            if event is toolIntent: markToolRisk()
            await writeWithBackpressure(event, abortSignal)
            if event provesTerminal: return exactlyOneTerminal(event, items)
    return interruptedOrIncompleteOnce()

bridge(input):
    requireToolOutputMatchesKnownCallId()
    preserve explicit allowed_tools scope when representable
    if requested field/tool cannot be represented:
        return typedUnsupported unless caller chose documented lossy mode
    if contains opaque agent task or cross-domain opaque continuation:
        return typedUnsupported before any send
    map supported messages, tool calls, tool outputs, usage
```

原生分支由真实目标协议契约校验字段。Chat 桥的限制不得误加到原生分支。视频继续保留任务表时，按主体、目标与幂等键预留记录，先记录 `PENDING_SEND` 再发送。相同键同一输入复用任务，不同输入冲突；状态未知后仅查状态或人工核对。原有可选端点达不到共用执行器语义时按兼容模式关闭对应新路径，记录 404/能力未启用等稳定契约。

## 4. M2 身份、目录与同线程

```text
authorizeFinalTarget(intent, catalogGeneration, binding):
    # 同一不可变授权记录贯穿解析、构建请求和发送
    require binding.generation == catalogGeneration
    target = canonicalizeUrlOnce(binding.origin, binding.path)
    require allowedSchemeHostPortPath(target, intent.domain)
    require credentialModeAllowed(intent.domain, target, callerScope)
    if intent.official: require binding.officialVerified and officialIngressPolicy
    else: require binding.thirdPartyVerified
    headers = buildAllowlistedHeaders(domain, caller, targetCredential)
    # 第三方头从空白构造。供应商要会话关联时，只派生该供应商域的标识。
    # 禁用重定向；实际发送使用这里授权的同一个 target 对象。
    return immutable(target, headers, modelBinding, generation)

publishCatalog(inputs, expectedGeneration):
    assert publishedInputsHaveDeclaredOriginAndContentDigests()
    next = buildOfficialAndThirdPartyView(inputs)
    validateAgainstPinnedClientModelInfo(next.wire)
    reserveImmutableIdsAndTombstones(next)
    require zeroCollisionsAcrossRealModelsAliasesVirtualAndReservedNames()
    require all bindings reference exact provider/model/protocol identity
    persistAndSwapValidatedGeneration(expectedGeneration, next)
    # /v1/models、resolve、管理投影统一引用同一 generation
    # 并发请求固定捕获开始时的 generation，回滚只换完整 generation
```

官方域、API Key 计费和 ChatGPT 订阅是不同授权。默认官方直连。聚合实验仅在显式测试入口和回环双 mock 下验证，默认不收真实官方 bearer。模型目录保留官方来源的必要字段、隐藏项及来源版本。第三方按能力证据生成客户端元数据，默认关闭未经证实的 search、patch、hosted tools、v2 能力。模型重命名用别名指向旧不可变 ID，删除保留墓碑。旧配置不得让别名、虚拟模型或默认模型遮住官方/聚合 slug。

真实 Codex CLI 目标按可用版本固定（审计为 0.167.0）。先验证实际 `debug models` 与 metadata 刷新，再做固定线程的三轮本地 mock。为三轮分别断言模型、上游、请求上下文、工具 call/output 配对、目录来源和完成事件。为隔离测试单独设清楚的请求体上限，测试默认生产约束与夹具上限分开记录。以合成身份测试第三方不接官方类头及原会话 ID，以官方专用回环夹具测试允许的认证头。无法取得真实账号头时，真实认证单独标 NOT_RUN。WebSocket HTTP 回落可记录，完整原生 WS 单列。

## 5. M3 决策、预算与对账

```text
decide(request, candidateFacts, health, lastAttempt, budget):
    if callerCancelled or deadlineExpired: return STOP
    if lastAttempt.possiblyCommitted and noTrustedResume: return STOP_RECONCILE
    for candidate in candidateFacts:
        exclude if unauthorized or identityConflict or officialSubscriptionFallback
        exclude if requiredCapabilityMissingOrUnproven or cooldownActive
        exclude if quoteUnknownAndCostLimitApplies
        exclude if estimatedWorstCaseExceedsBudget
    rank eligible by explicit compatibility, health, price, configured tieBreak
    return exact candidate or stable stop reason

reserveThenSend(requestId, taskRef, candidate, quote):
    # 所有金额使用最小整数单位与显式币种。计费日有固定时区，跨日记原预留日。
    with durableLedgerSingleWriter:
        prior = getRequestAttempt(requestId, requestDigest)
        if duplicateAndAlreadyStarted: return prior.receipt
        verify quote snapshot, caps at request/task/day and reservations
        persistReserved( attemptId, exactCandidate, maxCost, quoteVersion )
    executeSameCandidateOnlyOnce()
    if verifiedUsage: settleOnce(attemptId, actualCost)
    else if verifiedNotExecuted: releaseOnce(attemptId)
    else: keepUnknownReservationUntilReconciled(attemptId)
```

现有 token 额度继续独立展示。账本优先复用 Node 内置单写者事务策略，重启恢复与多进程争用覆盖。记实际超预估费用并阻止后续消费。健康、价格和能力带来源及时间。未知用量保留未知，不填零。日志、UI 与 API 只公开脱敏 reason 和账本摘要。跨模型仅使用裁决目标，候选与额度判定在第一次及每次请求发送前均生效。配置迁移保留旧显式路由模式，关闭智能模式可回退到受同一安全执行器约束的手工链。

## 6. M4 管理台、配置、历史与额度

```text
handleManagement(request):
    authenticateExplicitAdminBeforeReadingBody()
    requireTrustedOriginAndPeer()
    body = readBoundedBody()
    switch operation:
        policy / status -> redactedProjectionOnly()
        plan -> normalizeAllowedFieldDelta(); return summaryAndRevision()
        export -> return ownedFieldsOnlyToClient()
        apply / rollback -> disabled in ordinary product mode
        history -> boundedReadOnlyMetadataFromRegisteredSyntheticOrAuthorizedRoot()
        quota -> readFreshTrustedSourceOrReturnUNKNOWN()
```

写入能力仅作为隔离本机 CLI 或服务自管配置根的功能实验。优先复用 M0 事务和登记后的路径引用，浏览器不能传任意文件路径或原 TOML。只显示字段名和脱敏变化。需要写入时令牌绑定管理员、文件引用、版本、操作、过期时间，备份按不透明 ID 管理。外部配置仍以导出方式让用户掌控。真实历史迁移保持只读计划/导出。前端复用已有 API、store、409 提示和导航，支持 loading/empty/unknown/401/409/rollback 状态。旧控制台在核心操作等价并有回滚证据后才退役。额度应急由显式已授权行为激活，官方订阅不足不自动切到账单身份。

## 7. M5 MCP、UHR 与可用性

```text
delegateTask(connectionIdentity, request):
    require scoped connectionIdentity and allowed readOnlyIntent
    require budget > 0 and task summary within bounded shape
    refs = validateAuthorizedOpaqueReferences(request.refs)
    # 只传用户已允许的任务摘要和引用。权限来自调用主体与任务租约。
    task = uhr.submit(idempotencyKey, parentRef, refs, budget, deadline, toolScope)
    return { taskRef, state, minimalReceipt }

getTaskResult / cancelTask:
    require caller owns taskRef or holds scoped delegation grant
    return sanitizedStatusAndEvidenceRefs() / cancelIdempotently()

modelgateInfer(uhrReceipt):
    require authorized task scope, candidate set, time and cost budget
    return requestId, attemptIds, exact route, usage, terminal state, unknown usage
```

第一轮只读工作者用 mock UHR，结果经 MCP 返回原 Codex 工具 call ID，覆盖重复、越权拒绝、预算、取消和重启。UHR 拥有任务状态和执行工具。网关保存推理对账与回执，接不上真实 UHR 时 UI 反映不可用。真实 UHR 集成只在兼容 API 可读且有许可时以单独分支推进。原生 v2 密文保持拒绝跨域，仅记录公开支持变化。真实同线程认证、Desktop GUI、第三方工具和部署分开记录。

## 8. 验收证据与收口

独立 QA 从每个可合入的固定 SHA 归档或干净检出，测试之前看实际脚本与出网、目录、凭据行为。作者提供自检证据，QA 用新会话或不同任务上下文在同一模型上独立审查。代码改动重绑测试与 review，代码测试放在作者和 QA，队长处理 Git 和裁决。

每条记录含任务 ID、时间及区时、base/head/tree、实际命令、Node/npm/Codex 版本、mock/真实分级、套件/断言/跳过数量、退出码、证据路径、必要环境变量的名称与存在性、测试限制、回滚引用。开发模型记录 provider/model/请求档位及可观测的实际路由来源，账号额度、实际档位/上下文缺证据时写 UNKNOWN。保留 `PASS`、`FAIL`、`NOT_RUN`、`BLOCKED`，条件退出不能伪装产品完整通过。

- 功能分支入本地集成前须通过其卡验收、独立静态复核和组合回归。无独立 QA 时保持候选状态。
- 远端 merge 另需指定配送模式、实际通过的远端检查、base/head 重核、无已知 P0 和影响面回归。检查没运行时以本地整合证据结案。
- 收口给出已接受的 commit、未合入切片、是否有 PR/合并 SHA、风险与实测矩阵。每个未执行项提供具体复开条件。最终清理只限本轮自建并确认已停的临时进程，保留证据与回滚点。

## 启动与模型绑定

使用本机已有 DSH 入口。OpenCode Go 是推理供应商，AgentTeam 是工作编排方式。本机本轮读到 DSH `0.2.2-rc.1` 和 `--profile`、`--from-default-profile`、`--patch`，启动环境存在 `OPENCODE_API_KEY`。没有发模型请求，实际账户可用性须从首个任务请求记录。OpenCode Go 的完整模型标识是 `opencode-go/deepseek-v4.1-flash`。DSH overlay 将其拆为 provider 与 model，固定请求 `high`。团队全程同模型，禁自动选其他 provider/model。配置所请求与已观测实际路由分开记。 [OpenCode Go 模型及账户条件](https://opencode.ai/docs/console/go/)

按 [本机 DSH headless 规范](/home/xiaomengxizi/ai/harness/deepseek/docs/headless-runbook.md) 使用既有工具。可把 [长任务提示词](agentteam-start.md) 粘贴到已固定该模型的队长会话。若从 shell 启动，在通常有 OpenCode Go 环境的终端运行下列片段。仅初始化新任务私有目录和新 profile。进程以前台运行，结构化日志落私有目录。若中断，保留现有 cwd、环境、profile 和真实 SID，按 runbook 续传。

```bash
set -eu
umask 077
: "${OPENCODE_API_KEY:?请从现有 OpenCode Go 授权环境启动}"
mg_dsh=/home/xiaomengxizi/ai/harness/deepseek/cli/bin/dsh
mg_prompt=/home/xiaomengxizi/ai/tmp/modelgate-audit-20261111/tasks/agentteam-start.md
mg_run=$(mktemp -d /home/xiaomengxizi/ai/tmp/modelgate-team.XXXXXX)
mg_runtime=$(mktemp -d /home/xiaomengxizi/ai/tmp/modelgate-runtime.XXXXXX)
export DSH_HOME="$mg_runtime/home"
export DSH_AGENTS_HOME="$mg_runtime/agents"
export TMPDIR="$mg_runtime/tmp"
mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$TMPDIR"
"$mg_dsh" --version
"$mg_dsh" --help
cat > "$mg_runtime/model.yml" <<'YAML'
- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: high
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_API_KEY
        baseURL: https://opencode.ai/inference/go/v1
YAML
cd "$mg_run"
"$mg_dsh" --profile mg-team --from-default-profile headless \
  --patch "$mg_runtime/model.yml" --dump-config > "$mg_runtime/composed.private.yml"
# 将 stdout、stderr 和退出码分别保留。私有 NDJSON 不上传、不提交。
"$mg_dsh" --profile mg-team --patch "$mg_runtime/model.yml" --json \
  < "$mg_prompt" > "$mg_runtime/lead.private.ndjson" 2> "$mg_runtime/lead.private.stderr"
```

每个工作者使用独立运行目录。已有 AgentTeam 插件只有在实际工具面、角色模型、工作目录及权限都可核时采用。否则由队长用上述 DSH CLI 和任务账本调度同一组角色。插件缺失不触发安装，也无需回 Sol 重新规划。若当前执行器只能用其他模型运行子代理，必须使用同模型的隔离 DSH 会话；两种入口均不可用时保留真实阻断和进展。
