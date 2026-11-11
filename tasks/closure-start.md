# ModelGate 项目闭环 · AgentTeam 启动提示词

你是 ModelGate 的执行队长。沿 R1 的实际交付继续，从安全修复推进到推理网关、Codex 客户端、运维界面、委派和交付验收。按本文的阶段、依赖、写集和门槛自动推进。无需回 Sol 重做规划。普通实现取舍、失败诊断、验证重跑和集成由队长在这里的边界内裁决。遇到外部权限或环境硬阻断，先完成所有不受影响的卡、落盘证据和复开动作，再按真实状态收口。

## 1. 输入、基线和授权

- 项目源仓库 `/home/xiaomengxizi/ai/workplace/idproject/model-gateway`，远端 `xiaomengxizzh/model-gate`。
- R1 独立集成仓库 `/home/xiaomengxizi/ai/tmp/modelgate-hardening-20261111-r1/repo`，分支 `dev/modelgate-hardening-20261111-r1`，已验收本地交付 `505890a5197218425d133e2f24bf9703a915388a`。独立 QA 覆盖 `e57235f`，最终提交只改两项文档计数，最终 `verify` 为 14/14 套件、532/532 断言，回环网关 E2E 12/12。用实际收据复核。
- [R1 交付报告](/home/xiaomengxizi/ai/tmp/modelgate-hardening-20261111-r1/DELIVERY-REPORT.md)、[R1 独立 QA](/home/xiaomengxizi/ai/tmp/modelgate-hardening-20261111-r1/evidence/qa/r00/REPORT.md)、[R1 支持矩阵](/home/xiaomengxizi/ai/tmp/modelgate-hardening-20261111-r1/repo/docs/support-matrix.md) 是进度来源。[原始伪代码规格](plan.md)、[原测试矩阵](todo.md) 与[独立审计](../docs/audits/2026-11-11/audit.md) 是行为来源。本文覆盖旧启动提示词的入口、优先级和交付状态。
- 远端参考 `main=6bc6441`、`#5=ec66b24`、`#6=64a5c96`。#6 基于 #5，#4 已是 #5 的祖先，#2 是旧实验。开跑实时读取远端 refs、PR/checks 与祖先关系。R1 尚无远端分支，不能从 origin 直接取得其提交。先在新目录独立克隆 R1 取得 `505890a`，再从实际 GitHub 远端读新基线，禁止覆盖任何既有 worktree、未提交文件及作者克隆。禁止 force reset、force push 或变更旧 PR 来绕过审查。
- **本次默认 `DELIVERY=local`。** 我授权在独立候选线内开发、隔离验证、提交和本地集成。如果我在发出本提示词前明确把该值改成 `draft-pr`，也授权推送本轮新分支和维护本轮 Draft PR。如果改成 `merge-main`，也授权在真实远端检查及合并前门槛通过后，合并本轮受审窄切片并按目标 SHA 复验。三种模式都保留历史 PR 和用户工作树。默认动作不包含关闭旧 PR、部署、系统服务操作或真实用户数据迁移。
- 开发模型走已有 OpenCode Go 授权额度，禁止更换账号、开启额外付费或安装依赖。**真实产品上游预算为 0。** 默认所有产品上游为回环 mock。禁止读写或复制真实 `auth.json`、用户历史、密钥和私有配置，禁止探测或调用正式 8787，禁止改 systemd、宿主安全策略、真实服务和全局 profile。
- 真实上游、真实 Desktop、真实 UHR 和部署是独立验收项。可在启动前随任务明确附加已授权的环境、作用域和限制。缺失授权、受控宿主或外部契约时，保留默认关闭、记录 `NOT_RUN` 或 `BLOCKED_EXTERNAL`，继续独立任务。将明确支持的隔离验证做完。后续补齐前置条件时，同一提示词从账本中复开对应任务，无需再写计划。
- 开跑读取工作区 AGENTS、目标仓库 AGENTS、README、RESOURCE_APPROVAL，若目标分支有 CONTRIBUTING 则读。DSH 遵循[本机 headless 规范](/home/xiaomengxizi/ai/harness/deepseek/docs/headless-runbook.md)。历史记录仅用来定位证据。

## 2. 模型、团队和调度

全程只有 `opencode-go/deepseek-v4.1-flash`。队长、四位作者和独立 QA 均使用该模型，DSH 请求 `reasoningEffort: high`，仅继承已注入的 `OPENCODE_API_KEY`。记录 provider/model、CLI 版本、会话、请求力度及可观测的生效证据。无独立遥测时将实际力度或窗口记 UNKNOWN。禁止自动切到其他模型或供应商。

队长之外最多五位子代理，无嵌套派发。默认同时最多两位产品写者，E 可并行复核。角色保持独立 cwd 和证据目录。

| 角色 | 责任 |
| --- | --- |
| 队长 | 冻结基线、维护依赖账本、掌握共享入口写锁、集成、门禁裁决及交付。作者与 E 运行项目测试。 |
| A 配置与验收基础 | Key、配置事务、恢复与磁盘保护、测试隔离、Node/CI 与交付运维。 |
| B 推理与协议 | 请求执行器、Chat/Responses/SSE、工具往返、可选端点和视频幂等。 |
| C 身份、目录与管理台 | 管理入口、出站身份、目录、Codex 客户端适配、UI、历史与额度。 |
| D 路由、预算与委派 | 选择与预留、回执、对账、MCP 与 UHR 契约。 |
| E 独立 QA | 在干净固定树复核 diff，运行行为、浏览器、兼容和验收，交独立证据。 |

已有 AgentTeam 工具能证明固定模型、独立 cwd 和真实结束证据时使用它。否则按[启动与模型绑定](plan.md)用已有 DSH headless 调度同样的角色，零下载。首次创建私有 profile，后续在原 cwd/profile/SID 续办。若成员不可恢复，先确认旧写者、进程与工具均结束，再按现有角色写集移交。E 保持独立审查，禁止为自己写的产品变更签独立通过。

阶段按下文卡号推进。共享文件 `src/index.js`、`src/forward.js`、`src/router.js`、`package.json`、配置及协议契约均串行领取。队长允许独立模块提前实现，但依赖未通过前仅收为候选。交审后冻结 SHA，不 amend 已交接提交。使用追加提交与固定 diff；移植 #5/#6 时用可审查的提交切片或记录原 SHA 和差异的移植，按当前入口重接。缺文件是移植任务的输入，不能据此把核心 Responses、管理台和调度任务归为不适用。

```text
start():
    # 新运行目录和单写者账本。角色私有运行态不入产品 Git。
    pin(r1_head, live_remote_main, source_pr_heads, environment, permissions)
    reconcile prior receipts, existing worktrees, dirty author files
    create isolated integration line from verified R1
    if remote moved: integrate latest allowed baseline on disposable tree and reverify
    load all cards and resume completed checks only if exact artifact and SHA still match

dispatch_loop():
    mark external blockers with prerequisites; keep independent cards runnable
    freeze card: base/tree, cwd, owner, write set, acceptance, commands, evidence, deadline
    launch ready cards in dependency order, respecting write locks and five-role limit
    wait for meaningful events; verify terminal state, process ownership and actual files
    if ordinary failure: narrow fix, then re-test; if necessary split once with preserved evidence
    if transport/429: reconcile tools/process/write lock, resume same SID within original limit
    if repeated failure: preserve last good SHA, isolate blocked chain, continue other cards
    E reviews exact candidate and checks merge tree; advance only on green
    persist state after every candidate, review, integration and activation decision
    if nothing runnable and no process active: close local work with exact blocked items
```

每张卡回执含任务 ID、owner、base/head/tree、写集和实际 diff、工具/模型运行状态、命令、时间与时区、环境版本、退出码、通过/失败/跳过数量、证据路径、独立 review SHA、回滚点。原始 session、凭据、请求正文和私有日志不进 Git。测试只能用明确地址与合成数据，采用已核实的回环 namespace 或进程内 mock。开发 DSH 的模型调用与产品测试进程的出网边界独立。禁止按端口号试探生产环境。需要新资源时，记录已有资源和复开条件并继续其他卡。

## 3. R2 安全基线和真实入口

### R2-01 · Key 三态、失败保存和虚拟模型鉴权（A → E）

写集 `src/index.js` 的配置与鉴权片段、必要的 `src/router.js` 与 `scripts/test/offline/key-semantics.mjs`。保留 R1 已验证的封存 Key、掩码和显式清空行为。修复 `body.defaults` 缺省时引用内存现态的问题，虚拟模型独立 Key 校验脱离全局 Key 是否存在。

```text
saveConfig(patch):
    current = immutablePublishedConfig
    next = copyAndValidate(current, patch)   # 禁止在旧对象上清空 Key 或提前更新代际
    keyDelta = planFromOriginalPatch(patch, current)
    committed = commitBothWithFingerprint(next, keyDelta)
    if failed: return typedError and keep current
    publishVerifiedGeneration(committed)

authorizeDataRequest(request, model):
    if validGlobalKey: allow its existing scope
    if model has independent key: require matching unexpired key
    else if configuredGlobalKey: deny
    else: follow explicit policy for public model
```

验收从真实 HTTP 入口覆盖封存 Key 省略、掩码、替换、显式清空、env 覆盖，及仅旧明文 Key 时非法保存或事务失败后原 Key 仍有效、匿名请求仍拒绝。覆盖仅虚拟 Key、过期/非法日期、其他模型和列表请求的权限语义。隔离环境中只使用合成密钥。此卡不过时保留 R1 作为历史候选，后续可做独立模块，禁止发布受影响入口。

### R2-02 · 恢复冲突、代际发布和 staging（A → E，依赖 R2-01 接口）

写集 `src/config-transaction.js`、`src/index.js` 的启动/reload、`.gitignore` 和 `config-tx.mjs`。读取文件并验证代际与恢复锁时保持一致。热重载冲突返回 409 并保留已知良好内存态，冷启动无法证明有效代际时拒绝服务。恢复到原本不存在的文件状态只处理事务自己生成且指纹吻合的文件。限制 staging 权限、目录与 Git 纳入范围。

验收故障注入覆盖写意图、逐个落盘、commit marker、恢复过程与外部修改。核实未提交写不发布、已提交重启读完整代际、冲突保留磁盘、未授权仍明确 401/拒绝启动，消除接受任一 200/401 的弱断言。

### R2-03 · 旧测试隔离和执行器准备（A + E，可与 R2-01/02 分文件并行）

`scripts/test/run.mjs` 停止扫描式 legacy 入口。逐个迁移确需保留的用例为显式清单，旧体积测试的固定 8787 和旧 Key 测试按脚本 URL 找宿主配置的路径均排除，直到改成夹具传参。核对测试退出时进程组回收、超时和计数。独立检查现有 Node 目标，R1 只验过 Node 24，按 package engines 和目标 CI 复用已存在的版本。修改 CI 时仅用预装或已核实缓存的版本；不能把可能下载的 setup-node 配置写成零下载。

验收一份纯检出空环境可跑 `npm run verify`，未列脚本不执行。E 在允许的宿主检查现有 Codex 二进制和回环网络隔离，DSH 的 bwrap/unshare 被拒时使用已授权的宿主测试执行器，保持 DSH 代理模型一致。若仍无可用环境，按实测分项记 BLOCKED，继续协议 mock。

### R2-04 · 管理 API 和出站身份接线（C，依赖 R2-02，队长串行接线）

复用 `src/codex/admin-guard.js`、`identity.js`，接管理写入口和实际出站。令牌、来源和权限在读取请求体之前判定，设置有界 body 并产生稳定错误。初始管理令牌按显式本机初始化契约处理。配置预览只投影允许字段，外部 Codex 配置默认只导出。自管文件用登记引用和版本，备份与回滚禁止任意路径。出站计算一次规范化 URL、认证域与头集合，真实发送消费同一不可变授权记录。普通推理、探测、预热等所有相关路径均受目标域约束。第三方凭据和会话派生仅限其域，官方 token/账号/原线程标识不跨域。官方真实 bearer 默认不进入 ModelGate。

验收通过真实入口测试令牌、来源、过大 body、授权目标、错误绑定、拒绝分支零上游命中、请求和响应头白名单以及无隐式重定向。只使用受控合成身份和回环目标。P0-2/3 仅在其对应入口、旧路径及替代路径证据齐备时关闭。

**R2 检查点。** A/C 自检，E 独立验证最小失败回归与完整离线门禁，队长给出安全基线 SHA。B、D 可准备纯模块；主路径未绿不切换默认入口。

## 4. R3 产品数据面、Responses 与 Codex 目录

| 卡 | 角色与依赖 | 实现与验收 |
| --- | --- | --- |
| R3-01 原生 Responses 和 Chat 桥 | B，R2-04 | 从 #5 窄移植 `responses.js`、`responses-stream.js` 及对应测试。复用 R1 的 attempt/SSE/deadline，不带回独立重试循环。至少验证 Chat、原生 Responses、桥接三种真实入口。原生按协议保留工具与状态字段；桥接保留 item/call ID、工具结果、限制范围及终态；不可表达字段返回明确不支持，只有显式有损模式才允许丢弃。 |
| R3-02 目录和身份同世代 | C，R2-04；接线与 R3-01 串行 | 用 `catalog.js` 为 /v1/models、Codex 目录、resolve 和管理视图共享同一不可变快照。验证官方字段、第三方能力来源、别名冲突、重命名、墓碑、未知 ID、并发更新、重启和回滚。保留旧 OpenAI 模型列表形态。CLI 目标 metadata 来自真实加载输出。 |
| R3-03 同线程 CLI 与 v2 边界 | C + B → E，R3-01/02 | 固定真实本地 Codex 版本，在回环双 mock 运行官方角色→第三方→官方角色，同 thread ID 进行至少一次允许的只读工具往返。分别断言实际目录无 fallback、模型/上游命中、历史及工具 call/output、SSE 顺序与结束、认证域隔离。夹具请求体上限显式记录。官方认证头用合成专用入口验证，真实登录另立状态。v2 不透明任务零跨域发送，返回稳定错误；官方原生能力默认直连。 |
| R3-04 可选能力逐项移植 | B，R3-01 的共用执行器稳定 | embeddings、rerank、媒体、视频独立卡逐个接入。每项通过同一授权、取消和 429 契约才启用。视频先持久记录意图，按主体、请求摘要与幂等键处理并发，重复同内容复用，不确定结果只查状态或人工核对。未通过的能力默认关闭，有明确拒绝测试。 |

所有主路径的无重放判断使用已记录的发送、交付与副作用证据。未发送、已证实前置拒绝和供应商明确支持的同一尝试续传可按策略恢复。写后无头、半截流、已交付、部分提交或副作用未知时不得隐式重放；保留 429 和 Retry-After，用户取消独立终态。SSE 测试覆盖跨 chunk 的 UTF-8、CRLF、背压、工具参数增量、ID 配对、终态唯一及客户端断开。

**R3 检查点。** E 签产品入口三条路径、目录世代、真实 CLI 独立记录。真实 CLI 宿主受阻时保留 mock 证据，官方聚合继续实验或默认关闭。R3-04 可与下游管理和账本的非共享写集并行。

## 5. R4 路由、预算、回执与可靠性

- **R4-01 决策与预算契约（D，依赖 R2-04 与 R3 目录契约）。** 使用 R1 `decision.js`、`ledger.js`，冻结能力、健康、价格、授权和时钟的来源。固定 caller scope，官方订阅从通用备用池排除。明确请求级总预算、任务和日预算、尝试级幂等 ID、跨日记账与 quote version；不得让多次尝试绕过同一请求上限。余额未知或报价过期时按预算契约拒绝。
- **R4-02 生产路径接线（D + B，依赖 R3-01/02 与 R4-01，队长串行）。** 先接一条真实第三方推理入口，使用合成上游跑通完整链。保留旧显式路由配置，仍通过统一授权与尝试策略。追踪实际尝试目标及响应。未知用量保留待对账，旧 token 统计独立展示。
- **R4-03 对账与持久性（D + A，依赖 R4-02）。** `inference-receipt.js` 生成稳定回执。增加账本生命周期、容量/压实、崩溃恢复和回滚策略，单机锁支持范围写明。无可靠多主能力时拒绝共享目录。重复核销和重启不得重复计费；保存独立的压力与错误日志摘要。

```text
for each actual send:
    route = decide(facts, generation, health, priorAttempt)
    permit = authorizeFinalTarget(route, callerScope)
    reservation = ledger.reserve(parentRequestId, attemptId, exactTarget, boundedQuote)
    # 保留同一目标、同一代际和同一预留，锁冲突或预算不足立即终止
    result = transport.sendOnce(permit, reservation)
    if verifiedUsage: settleOnce(actualUsage)
    else if verifiedNotExecuted: releaseOnce()
    else: keepUnknownUntilReconciled()
    emitRedactedReceipt(route, attemptId, terminal, usageState)
```

E 验证真实入口的实际目标与裁决一致，发送前有预留，超限、取消、未知、价格过期、重复请求、并发、跨日、崩溃、账本锁失败与恢复均有行为断言。无隐式换模型/重复发送。证据分别标 mock 与已授权真实上游。

## 6. R5 管理台、客户端安装和运维

- **R5-01 控制台（C，依赖 R2-04、R3-02；费用视图依赖 R4 回执）。** 从 #5 按 API 合约移植 `src/ui-next` 各视图，复用 R1 的鉴权、版本、配置事务与实际用量投影。验收登录、401 后清状态、409 保留用户编辑、提供者/模型/客户端/观察/设置核心动作、保存失败回退、目录一致、缺用量为 UNKNOWN。旧面板等价且可回滚后才退役。
- **R5-02 Codex 配置、历史和额度（C，依赖 R5-01）。** 默认导出受所有权约束的配置，保留用户字段，管理端不回传完整 TOML。历史只读、限制规模与登记根，迁移生成计划和导出。额度区分新鲜、陈旧与未知，应急模式需显式授权，官方订阅不足时不自动改走付费身份。实际写入/回滚只对隔离的自管配置验收，真实用户数据另有权限。
- **R5-03 桌面与客户端交付（C + E）。** 生成版本化配置样例、兼容矩阵、安装/升级/回滚及运行手册。系统 Chrome 用临时 profile 做本地控制台验收。Codex Desktop 只有在现有独立 profile、回环和正常沙箱均可用时做 GUI 验收；二进制测试独立归类。未通过时功能保留默认关闭或标未支持。
- **R5-04 恢复和运维（A + E，依赖 R4-03、R5-01）。** 用一次性配置、Key、目录、账本演练备份、重启、升级和回滚。配置与账本分开确认，冲突时不覆盖外部修改；只用受控健康探针与脱敏指标。保证 P0 修复不会因回滚到旧配置模式而失效。

## 7. R6 MCP / UHR 委派与原生边界

**R6-01 持久委派（D，依赖 R4-03，可与 R5 并行）。** 复用 R1 `delegation.js`，持久绑定 `callId`、请求摘要、父任务和幂等键，重启后重复调用复用结果。结果读取与取消是独立权限；授权以调用主体、任务租约、可用工具、预算及过期时间为准。任务只传明示的摘要和范围受限的引用，优先只读。快照的单写者、崩溃残留和已提交结果对账进入测试。

**R6-02 支持的 MCP 工具与真实 UHR 契约（D + C → E，依赖 R6-01）。** 用既有可复用 MCP 运行时验证从 Codex 发起、轮询/取消、结果归还原工具调用的路径；运行时不可用时实现协议夹具，MCP 实机保持 NOT_RUN。真实 UHR 先读当前版本和任务 API，确认读写授权、工作区、审批、成本、生命周期与回滚；满足前置条件时接最小只读任务，QA 绑定两个仓库的实际 SHA。UHR 有权管理 Agent 任务，ModelGate 提供推理和对账。真实 UHR 不可用时，交付可运行 mock、版本化契约、兼容性检查和复开动作。

**R6-03 v2 与官方订阅（C + D → E）。** 官方直连保持原生。未经证实的第三方密文任务在边界拒绝。只有公开支持的协议与明确授权同时成立，才开放原生跨供应商实验。跨供应商委派使用显式明文 MCP 任务。官方订阅聚合若获独立授权，先核对当前官方接入和政策边界，再执行受限真实测试。拒绝路径、凭据隔离和回退须有证据。

验收至少包括正常、重复、取消、崩溃后恢复、越权、过期权限、预算耗尽、结果归属和未知状态。不透明 v2 输入不跨域，真实 MCP/UHR 和 mock 的结论独立。

## 8. R7 发布候选、验收与闭环

| 门槛 | 负责 | 验收与处理 |
| --- | --- | --- |
| R7-01 最终 QA | E | 干净快照固定 SHA。运行 `npm run verify`、已接能力的集成测试、权限与代际恢复、真实 CLI 双 mock、浏览器和回滚演练。Node 版本按实际支持声明。列明每个阶段新增和保留的测试；测试总数来自本次日志。功能还未激活时验证默认关闭。 |
| R7-02 Git 集成 | 队长 + E | 核实时远端 base/head、检查状态、真实合并树和候选范围。先基础安全，再数据面，再产品管理/委派；不整包合并旧 #5/#6。按 DELIVERY 交本地候选、Draft PR 或通过门禁的合并。远端 CI 缺失、保护不满足或 P0 未关时保留本地已验收结果。合并后绑定目标 SHA 重跑，失败则按授权范围小修复或可审计 revert。 |
| R7-03 交付和回滚演练 | A + C + E | 给出安装与升级步骤、配置 schema、能力开关、兼容矩阵、运维手册、数据备份和恢复回执。实际部署仅在额外明确给定环境、范围、观察窗口与回滚授权时进行。先隔离演练、验证备份及可回滚性，再按授权窗口切换和观察。部署失败停止该入口并回滚到最近安全版本。 |
| R7-04 最终收口 | 队长 | 保存阶段和卡结果、已发布功能与默认关闭清单、全部 SHA/PR/CI、回滚点、真实测试状态、预算及风险。把剩余外部项标明责任方、具体缺口、复开命令与验收门槛。更新下一次续办入口指向同一账本。 |

项目闭环按下列结果如实结案：

1. **本地产品闭环通过**要求 R2 安全回归、R3 主要入口与目录、R4 实际预算、R5 控制台与运维、R6 在已支持环境中的委派路径和 R7 独立验收全部达标。若隔离环境无法实际跑 CLI/MCP，交付已过的核心产品，标对应能力未完成。受控可选能力以明确启用或关闭、可验收结果收尾。
2. **远端交付通过**要求实际 PR/合并 SHA、当前远端检查和合并后复验，按选择的 DELIVERY 记录。默认本地交付时远端状态为 NOT_RUN。
3. **真实环境闭环通过**要求已批准的真实上游、Desktop、UHR 或部署场景分别取证。每项标 PASS、FAIL、NOT_RUN 或 BLOCKED_EXTERNAL。授权或环境缺失时收口到安全的已交付状态，给出准确复开条件。核心能力未验收或 P0 未关时，最终报告须明确「未闭环」。

开始核对 R1 和当前远端，建立续办账本，领取 R2-01、R2-03 和 R2-04 的互斥准备工作。完成每个可执行阶段后继续下一阶段。只有所有授权范围内的卡都有真实终态、候选和证据已落盘，才提交最终交付报告。
