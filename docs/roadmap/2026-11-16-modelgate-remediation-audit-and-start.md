# ModelGate｜全量问题审计、材料索引与修复执行任务书（2026-11-16）

> 文档类型：只读审计结论 + 待执行任务书；**不是代码已修复、测试已重新运行、发布已获准的证明**。
> 仓库：xiaomengxizzh/model-gate；规划分支：`plan/modelgate-remediation-20261116`（从 `feat/modelgate-ux-v3` 派生）。
> 审计基线：`feat/modelgate-ux-v3` / `deploy/modelgate-ux-v3` 在编写时同源（GitHub compare 为 identical）；基准提交 `9a371d39e74ca964cd7ff9df8c9faf30b83a6e90`。执行前必须再次 `git fetch`、核对实际 HEAD 和部署树，不可假设它们永远不变。
> 上一代集成分支：`mg-codex-native@708cf5e803fed27517caf8639af1bebb28401e04`；PR [#7](https://github.com/xiaomengxizzh/model-gate/pull/7) 仍 Draft，未合入 `main@6bc6441fc7bf3e620b19af5af3b4d62543b31193`。
> 审计方法：读取 GitHub 已提交代码、证据与交接记录；**本次未连接用户运行主机、未重新运行生产服务、未触碰本机凭据、未产生模型费用**。以下区分已实测故障、静态源码结论、待证实假设与已明确批准的例外。

## 0. 最终目标与不可降低的边界

交付真正可用的 ModelGate：原版 Codex Desktop 保留原有 ChatGPT 套餐身份、模型选择与原生 Harness；通过网关使用 OpenCode Go 的 `deepseek-v4.1-flash`；允许 GPT-6 Luna 父代理通过 **Codex 原生**子代理派单到 DeepSeek；原生工具、等待、追派、中断、上下文、压缩、恢复和配置回滚都保持保真。ModelGate 只做授权、模型配置、路由、协议适配、可观测性和安全配置事务，绝不建立第二套代理调度或总结/压缩系统。

强制约束：

1. **真实 GPT 测试的父模型只允许 `gpt-6-luna`**；第三方正式强制目标仅为 OpenCode Go `deepseek-v4.1-flash`。其他 OpenCode 模型和全协议适配不属于必达；小规模初探失败即停止，不扩充任务。
2. 压缩必须由 Codex 自身实现与触发；网关不可自行 summarize、截断历史、生成摘要缓存、伪造加密 compaction 产物，亦不可调大窗口或关闭压缩来冒充通过。已有 `history/export` 是所有者书面批准的**显式历史迁移导出例外**，严禁与压缩或模型推理混用。
3. 原生父/子 Agent Team 必须继续由 Codex 管理，**不得以 MCP/外部 CLI 子代理/自造线程取代**。执行 AgentTeam **子代理最多 5 个**，主代理负责集成与最终判断。
4. 不安装/下载任何大型软件、模型权重或重型依赖；任何新增依赖/下载都必须先核对本地是否已存在，并取得用户明确授权。优先使用现有 Node 与仓库测试脚本。禁止私自占用 GPT 套餐/Go 额度发起真实测试；缺明确额度及期限授权则只做离线、隔离、mock，真实项标 BLOCKED。
5. 不私改 `main`、现有 PR #7 的发布状态、真实 `~/.codex`、生产 `config/*.local.json` 或部署服务。默认在从最新开发树创建的**独立修复分支/worktree** 工作，最终合并、发版、切换生产配置需所有者明确批准。不得手填审批、篡改证据、虚报 PASS_REAL、强行让门禁变绿。

权威产品契约：[`docs/product/2026-11-14-owner-scope-v2.md`](../product/2026-11-14-owner-scope-v2.md)。**任何结论以该契约及用户最新明确指示为准；本文不作范围降级。**

## 1. 必读材料索引（按优先级阅读）

| 顺序 | 文件（仓库相对路径） | 用途 / 为什么必须读 |
| --- | --- | --- |
| 1 | `docs/roadmap/2026-11-16-modelgate-handoff.md` | **最新生产交接**：13:27 孤立 tool output 400、服务/环境/部署、真实请求与已知未修阻断；以此优先于 11/15 旧结论 |
| 2 | `docs/product/2026-11-14-owner-scope-v2.md` | 官方交付范围、R001–R012、仅 Go DeepSeek、原生压缩、N04 导出例外 |
| 3 | `docs/roadmap/2026-11-15-ux-v3-delivery.md` | V3 前端已开发/已部署、生产启用记录、不能直接操作聚合的权限缺口、真实与 mock 测试边界 |
| 4 | `docs/roadmap/2026-11-15-frontend-experience-v3-execution-plan.md` | 用户路径、普通/高级信息架构、状态机、阶段与 GUI 验收规格 |
| 5 | `docs/roadmap/2026-11-15-v2-handoff.md` | V2 原生路由/压缩坑、R006 冻结树差异、审批和恢复、证据索引 |
| 6 | `docs/evidence/aggregation-v2-release-verdict-2026-11-15.md` | V2 尚未获发布许可的最终裁决；12 行历史 PASS_REAL 不代表同一最终树完整通过 |
| 7 | `docs/evidence/aggregation-v2-freeze-rerun-2026-11-15.md` | R006 四项未在冻结树重现（压缩 3 项 + same child resume）、A3/其它真实复核 |
| 8 | `docs/evidence/aggregation-v2-real-acceptance-2026-11-15.md` | Luna/Go 原生真实请求、Agent Team 与工具验收原始说明 |
| 9 | `docs/evidence/aggregation-v2-native-compaction-real-client-2026-11-15.md` | Codex bundled CLI + loopback 模拟上游测试：`remote_compaction="unsupported"` 引导 Codex 本地压缩 |
| 10 | `docs/evidence/aggregation-v2-desktop-gui-2026-11-15.md` | 原版 Codex Desktop GPT/Go 双模型 GUI 实跑证据 |
| 11 | `docs/evidence/aggregation-v2-r001-r007-2026-11-15.md`、`aggregation-v2-r008-r009-2026-11-15.md`、`aggregation-v2-r010-2026-11-15.md` | 配置激活/回滚、权限隔离、错误回退、崩溃恢复 |
| 12 | `docs/evidence/aggregation-v2-qa-findings-2026-11-15.md`、`aggregation-v2-independent-qa-2026-11-15.md` | A5 早期 F1/F2 门禁绕过证据；部分问题已有补丁，不可把历史缺陷误称为新发现 |
| 13 | `docs/evidence/2026-11-15-ux-v3-a5-acceptance.md`、`docs/contracts/ui-v3-product-status.md` | V3 前端独立验收、证据等级、无伪成功、状态投影合同 |
| 14 | `docs/evidence/aggregation-v2-receipts-2026-11-15.json`、`aggregation-acceptance-matrix-v2.md`、`aggregation-v2-status-2026-11-15.md` | 逐要求回执、历史采集 SHA 与部分状态 |
| 15 | `docs/evidence/v2-frozen-sha.txt`、`v2-pins.json`、`v2-release-approvals.json` | 冻结树、门禁哈希、真实签收依据；审批记录在本次检查时为空，**禁止代填** |
| 16 | `docs/roadmap/2026-11-14-go-deepseek-native-compact-plan.md` | V2 正式实施分阶段计划与必需验收 |
| 17 | `docs/how-to/desktop-acceptance.md` | Desktop 与隔离 `CODEX_HOME` 运行步骤 |

资料须按分支辨认：1、3、13 的完整 V3 生产信息在 `feat/modelgate-ux-v3`（或本规划分支）上；6–16 为 V2 历史证据。对照源码应选择**同一个待修基线树**，不能从旧 `mg-codex-native` 复制覆盖最新 V3 实现。

## 2. 直接定位的关键源码和测试

| 范围 | 核心文件 | 需要查看的实现 |
| --- | --- | --- |
| Codex → 第三方 Responses | `src/index.js` 约 L677–784、L1953–2010 | `projectThirdPartyResponsesParams`、`repairThirdPartyToolCallIds`、`firstEmptyToolCallId`、`proxyNativeResponses` |
| 原生压缩协议/历史 | `src/codex/interop.js`、`src/codex/catalog.js`、`src/codex/config.js` | `compaction_trigger`、`remote_compaction`、第三方 tool/input 形状、capability |
| 第三方上游与鉴权 | `src/providers/opencode-go.js`、`src/codex/target-authz.js`、`src/codex/local-subscription.js`、`src/codex/auth.js` | Go session header、订阅域与 Go 凭据隔离、刷新/请求头 |
| 聚合 API 与错误映射 | `src/aggregation/api.js` 约 L164–192、L311–332、L390–410 | `discoverySummary`、`pickModel`、`handleAggregationApi` 管理身份 |
| 聚合 Provider 和目录 | `src/aggregation/registry.js`、`discovery.js`、`catalog.js`、`handlers.js` | adopt、Go 单模型目录、授权发现、已发布版本 |
| Desktop 配置事务 | `src/codex/desktop-integration.js`、`src/codex/config.js`、`bin/mg-desktop.mjs` | 428 consent、409 并发冲突、原子写、字节备份/恢复、子代理配置所有权 |
| 前端 V3 | `src/ui-next/js/views/connections.js`、`dashboard.js`、`aggregation.js`、`product-status.js`、`store.js`、`app.js`、`styles.css` | 管理令牌状态、聚合向导、实际可用性证据、恢复 UX、状态竞态 |
| 门禁与自动回归 | `scripts/test/run.mjs`、`scripts/test/offline/aggregation-freeze-check.mjs`、`aggregation-gate-v2.js`、`aggregation-matrix-v2.js`、`aggregation-audit.js`、`aggregation-audit-diff.mjs` | 冻结、证据等价映射、审计防篡改、正确显示 blocked |
| 真实/GUI 证据 | `scripts/test/live/desktop-gui-checklist.mjs`、`console-toggle-check.mjs`、`desktop-crash-recovery.mjs`、`negative-and-tenant-check.mjs`、`scripts/e2e/ui-v3-browser.mjs` | 分离真实上游、回环 mock、浏览器断言、无凭据泄漏 |
| 应重点扩充的测试 | `scripts/test/offline/agg-v2-tool-declaration.test.mjs`、`agg-v2-compaction-protocol.test.mjs`、`agg-v2-real-client-compaction.test.mjs`、`agg-v2-go-routing.test.mjs`、`agg-v2-third-party-params.test.mjs`、`aggregation-provider-adopt.test.mjs`、`ui-v3-acceptance.test.mjs` | 工具 ID 和孤立结果、协议、错误码、拒绝静默丢弃、前端状态 |

参考真实运行位置（**只是交接记录中的设备路径，远端 GitHub 无法证明现在仍存在**）：

- 生产工作树：`/home/xiaomengxizi/ai/workplace/idproject/model-gateway`，部署分支 `deploy/modelgate-ux-v3`；
- 用户服务：`model-gateway.service`，监听 `127.0.0.1:8787`；日志 `logs/gateway-2026-11-16.log`；
- Codex 配置：`~/.codex/config.toml`；既有备份 `~/.codex/config.toml.bak`、`~/.codex/config.toml.bak-before-agents-<ts>`、`~/.codex/config.toml.bak-before-subagent-<ts>`；
- Go 子代理配置：`~/.codex/go-deepseek.toml`；官方模型基线缓存 `config/codex-models-baseline.json`；聚合目录 `config/aggregation/catalog/local/current.json`；
- 生产运行配置：`config/gateway.local.json`，Go 凭据引用 `OPENCODE_API_KEY`。**不得输出/复制真实值、提交文件、打印 `auth.json` 内容**。

## 3. 关键问题台账（严重程度、证据、改法、验收）

### MG-FIX-P0-01：真实 Codex 会话无法通过 DeepSeek（确认故障）

- **真实证据**：`docs/roadmap/2026-11-16-modelgate-handoff.md` `1/`4/`5；13:27:15 日志有 `function_call_output` 第五项缺 `call_id`、此前四项为 `message`，没有前序可配对 `function_call`。`src/index.js` `firstEmptyToolCallId` 命中，返回 HTTP 400 / `third_party_tool_call_id_missing`，导致 Desktop 新会话重连后失败。网关直连 Go 单轮成功**不能**证明真实 Codex 对话成功。
- **已有修复**：第三方 `stream_options` 过滤、缺 ID 调用/结果的部分按位置补齐；切勿再次把已修复部分当全新问题。
- **根因未证实**：可能是原生 Codex 序列化/分支叉分上下文、历史 item 分类、上游 portable Responses 约束或网关路由形状；**不得假定一定是 Codex bug 或 Go bug**。
- **修复顺序**：先补仅结构信息的最小脱敏 trace（序号/type/role/name/id/call_id 是否存在、thread/correlation/route，不含正文、token、authorization）；复刻被拒输入到离线 fixture；对照同一会话官方/Go 入参；判断可无损规范化的边界；无法安全配对时继续 typed fail-closed，不吞掉 output、不伪造 function_call/摘要。若必须协议切换或有损操作，单列设计说明和反方评估，请用户明确审批，不可默认采用。
- **验收**：原版 Desktop 中选择 Go DeepSeek，在隔离环境通过首轮/连续多轮/真实工具往返/子代理工具往返；事件序列完整、工具结果关联准确、无未知 400、无重复出站、无静默丢历史；异常孤立输入仍获 typed 可归因错误。使用第三方真实付费流量前必须有额度授权。

### MG-FIX-P0-02：Codex 原生压缩与恢复不一致（真实复核部分未通过）

- **证据**：`docs/evidence/aggregation-v2-freeze-rerun-2026-11-15.md` `2：最终冻结树三次未触发压缩（`native-compaction`、`post-compact-followup`、`context-proof` 只能引用中间树 `3116459`），另两次 resume 都新建 childId，而非恢复原 childId。`docs/evidence/aggregation-v2-release-verdict-2026-11-15.md` 将 R006 四项标 partial。
- **已知正向**：`docs/evidence/aggregation-v2-native-compaction-real-client-2026-11-15.md` 在真实 Codex binary+回环上游确认 `remote_compaction="unsupported"` 可由 Codex 发起本地 checkpoint；不能把此 mock 路径冒充真实 Go 子代理端到端。
- **修复方向**：首先修复 P0-01，避免脏历史干扰；复查 Codex 自身原生恢复语义与版本限制；设计可复现的长上下文真实子线程用例，收集压缩事件、before/after childId、工具和上下文证据；只修协议保真/能力声明/配置适配。**不可发明网关侧压缩，也不可为了通过而改验收断言**。若原生版本无法保证原 childId 恢复，呈报不可达证据及客户端侧可选路线供所有者裁决。
- **验收**：真实 `gpt-6-luna` 父代理 + `deepseek-v4.1-flash` 子代理，能够原生压缩、继续工具、复述压缩前 marker、核对 childId 与中断/恢复/去重，逐项附真实采集 SHA 与回执。

### MG-FIX-P1-03：显式模型选择可能静默回退（源码确认，需补反向测试）

- **源码**：`src/aggregation/api.js` `pickModel` 约 L311–318；`requested` 不存在时，会返回配置默认模型，继而目录首项；`activationOptions` 约 L321–332 直接调用。
- **风险**：用户明确要求 DeepSeek 而目录缺失时，可能被选成官方 GPT/其它模型，不符合 MG-R008 无静默切换。
- **修复**：区分“用户未传 model”（允许明示默认）与“传了不存在的 model”（稳定 422、要求重新同步）；在激活预览与实际写入间检查请求模型与目录/绑定的一致性，失败不写配置；前端明确展示预期目标，不能自行兜底。
- **验收**：未知 ID → 422、零配置写入、零模型出站；显式 DeepSeek 目录不存在不选 Luna；正常无显式模型的预设规则另行测试。

### MG-FIX-P1-04：关闭管理令牌后管理面无法操作（真实部署现象）

- **证据**：`docs/roadmap/2026-11-16-modelgate-handoff.md` `2/`9、`docs/roadmap/2026-11-15-ux-v3-delivery.md` `7.2.5：`/api/auth.needAuth=false` 且 `/api/aggregation/*` 403。`src/aggregation/api.js` `handleAggregationApi` 要求 `explicitAdmin===true`；当前控制台无法通过 GUI 直接退出聚合。
- **修复**：提出并实现清晰、安全、可测试的本地管理身份模型：普通状态可只读、写配置仍必须满足显式 consent 与身份；可以选择带用户授权的本机初始化/本地管理会话，但**不得简单删除鉴权或把“回环地址”当永久管理员**。保持跨站请求防护与敏感数据隔离；前端要显示如何解锁/为何拒绝，而不是死循环。
- **验收**：无管理凭据时信息状态准确，写操作按授权策略拒绝；完成本地授权后，预览/开启/关闭/回滚流程可用；外部访问、跨来源请求、未授权写均拒绝。

### MG-FIX-P1-05：多代理配置与回滚所有权不完整（生产记录确认）

- **证据**：`docs/roadmap/2026-11-16-modelgate-handoff.md` `3/`10：`[features].multi_agent`、`[agents.go_deepseek]` 与 `go-deepseek.toml` 是手工新增；退出聚合不会自动按托管语义清理。
- **修复**：厘清哪些字段/文件属于 ModelGate 托管；在 `desktop-integration.js` 的 preview/consent/事务/rollback 中纳入原生子代理配置且 byte-compatible 回滚；如果用户已自行修改某字段，必须报告 409/三方差异，不能覆盖用户改动。保持 Codex 原生配置方式，不构造伪 AgentTeam。
- **验收**：空白用户及既有配置用户均无手工 TOML 操作；启用后 GPT 父与 Go 子原生存在；退出后仅撤销 ModelGate 所有权内容，原始配置/独立用户更改均保留；崩溃重启可恢复。

### MG-FIX-P1-06：V3 开发/部署与正式发布门禁不在同一基线（已确认）

- **证据**：V2 `v2-frozen-sha.txt` 为 `12cf5d97a60f151af59c731e26b71245a50e5169`；V3 分支在 `mg-codex-native@708cf5e` 之后继续开发并在部署分支使用。PR #7 仍 Draft，`v2-release-approvals.json` 仍为空。历史矩阵中 12 行 `PASS_REAL` 含多棵采集树，R006 4 partial、R009 条件验收；不可据此宣布当前 V3 树 PASS_REAL。
- **修复**：将修复分支重建在**最新真实代码基线**上；现有 V2/UX-V3 证据原样保留；新增本轮测试独立记录，提交/测试/回执严格绑定 SHA；按规定重新冻结/验证/独立 A5 验收；审批保留由所有者实际签收。若存在 A5 早期 F1/F2 的历史问题，先检查最新门禁已修复的代码，不得误报或删改测试冒充修复。
- **验收**：冻结树可复现、`npm run release:freeze` 仅在真实满足且所有者签收后通过；未获批准继续 BLOCKED；不自动合并或发布。

### MG-FIX-P2-07：合成工具 ID 的碰撞与错误配对风险（静态推导，未证实生产触发）

- **源码**：`src/index.js` `repairThirdPartyToolCallIds` 约 L734–775，合成 `call_mg_1`、`call_mg_2`，未显式避开输入已有 ID；遇到带 ID 的 output 时采用待配对栈顶项，未完整校验该 ID 是否就是原 call 的 ID。
- **风险**：同一输入中有现存 `call_mg_1`、多调用交错/同一 input 重复工具引用时可能产生重复 ID 或错绑；**当前只属于需测试的风险，不是已确认事故**。
- **修复**：补本地对抗输入测试；仅在具有可靠关联证据时补齐/映射 ID，确保已有 ID 的唯一性与映射一致，保持对未知孤儿输出 fail-closed。
- **验收**：相同 ID 不重复、输出与 call 一一匹配、多工具并发/混合有无 ID/已有 ID 等用例全部通过。

### MG-FIX-P2-08：部分 Provider 未发现时可能标记整体 complete（源码确认）

- **源码**：`src/aggregation/api.js` `discoverySummary` 约 L164–192：所有“存在的快照”都 complete，但 `snaps.length < providers.length` 时，仍可返回 `state:"complete"`、`complete:true`，仅另带 `providersComplete:false`。
- **修复**：总体 complete 应包含全部 Provider 是否已有可信快照；未知不等于空白，更不等于完整。普通用户仅显示“已配置/已发现/真实推理已验证”相应等级，避免误报。
- **验收**：任意未同步 Provider → partial/unknown；全部真实快照 complete 才 complete；UI 不显示假“准备就绪”。

### MG-FIX-P2-09：R009 多用户形态与验收待决（产品/架构缺口）

- **证据**：V2 已验证双实例 A/B 凭据/日志/配置隔离和部分 Key 轮换，但单实例多租户接线仍缺失；`docs/roadmap/2026-11-15-v2-handoff.md` `5.6 与发布裁决 R009 标记要求所有者批准“双实例验收形态”。
- **处理原则**：不要擅自扩大成复杂单实例多租户平台，也不要宣称单实例多租户已经完成。保留双实例证据并交所有者明确选择；如需单实例多租户，另提 schema、scope-store、授权、日志隔离与迁移方案。
- **验收**：所选形态的真实隔离证据与正式审批；任何跨身份读/写/刷新不越界。

## 4. 环境、既有正向成果与不能重复修复的内容

- V2 真实证据覆盖：Go `deepseek-v4.1-flash` 200、Luna 官方 200、Codex native 父→子工具、GUI 模型选择、原子配置回滚、双实例隔离。**这是历史采集树证据，不代表最新生产会话已经解决 P0-01**。
- V3 已实现：普通用户首页 + 连接向导 + 折叠高级导航 + 状态机 + 浏览器三视口；历史记录 `npm test` 127 套件 / 1230 passed / 0 failed / 3 skipped。此数字是交接报告，不是本次独立复跑，也不等于真实模型通过。
- 11 月 16 日生产交接记录：聚合模式在服务进程配置中为 aggregated，目录 12 条（11 官方 + 1 Go），Go 环境变量 Key 可发现；真实 DeepSeek 直连成功。但**真实 Codex 会话因孤立 output 失败**，管理 API 因显式管理身份不足 403。
- 旧 F1/F2 门禁对抗缺陷在 V2 集成报告已登记“已修”；不要根据早期 QA 记录直接当作最新源码尚未修复。
- `history/export` 保留是明确书面批准的迁移导出例外，严禁无故移除或让它参与 compaction。
- 真实生产目前已经部署，但运行状态是否仍一致需要操作设备上重新确认；本文件不授权更改现有生产实例。

## 5. 执行路径（从修复到产品闭环，不另起大规模规划）

| 顺序 | 工作包 | 交付物 | 准入/阻断 |
| --- | --- | --- | --- |
| G0 | 冻结本轮源代码基线、定位原始问题并备份测试路径 | HEAD、分支与工作树、日志脱敏摘要、问题映射；独立工作树 | 禁止碰生产、凭据、付费上游 |
| G1 | P0-01 工具历史形状复现与无损修复 | fixture、代码补丁、对抗性回归、错误诊断 | 无法确认历史配对时保持 fail-closed |
| G2 | P1-03、P2-07、P2-08 请求保真和目录准确性 | 422 拒绝静默换模、ID 不碰撞、discovery 正确完成态 | 离线检查完全通过 |
| G3 | P1-04、P1-05 管理身份与原生子代理配置恢复 | 本地授权机制、GUI 解锁与 428/409、事务回滚、空白/既有用户测试 | 无真实 `~/.codex` 修改 |
| G4 | P0-02 原生压缩与同子恢复 | Codex native 事件证据、未覆盖行为清单、明确客户端版本限制 | mock 只能 PASS_MOCK，付费实测需审批 |
| G5 | V3 前端端到端状态、真正可操作路径 | 从连接 Go 到启用到退出恢复的 UX 全链条 + 实际状态证据 | 不造虚假按钮、不静默调用付费模型 |
| G6 | A5 独立审计、冻结与发布准备 | 审计报告、证据矩阵、真实/离线分层、完整交接、PR（草稿） | 没有所有者签收不合并、不发版 |

**严禁以完成低优先级视觉/UI 打磨代替 P0-01 的实际修复。** 遇到真实 Codex 端能力不可达时，形成可复现证据/客户端方案和决策点，不擅自改用户要求。

## 6. 建议检查命令（只读/离线；执行时以 README 和实际脚本为准）

在独立工作树执行：

~~~bash
git status --short
git rev-parse HEAD
git branch --show-current
git diff --stat origin/mg-codex-native...HEAD

npm run check
npm test
npm run docs:check
npm run contract:check
node --test scripts/test/offline/agg-v2-tool-declaration.test.mjs
node --test scripts/test/offline/agg-v2-compaction-protocol.test.mjs
node --test scripts/test/offline/agg-v2-real-client-compaction.test.mjs
node --test scripts/test/offline/agg-v2-go-routing.test.mjs
node --test scripts/test/offline/agg-v2-third-party-params.test.mjs
node --test scripts/test/offline/ui-v3-acceptance.test.mjs

npm run gate:v2
npm run gate:v2:independent
node scripts/test/offline/aggregation-matrix-v2.js --check
npm run release:freeze
~~~

- `npm run gate:v2` 是合成反绕过自证（不是发布批准），`release:freeze` **预期仍 BLOCKED/失败**，除非用户已真实签收并完成条件。
- `scripts/e2e/ui-v3-browser.mjs` 需本机**已有** Chrome/CDP、隔离可启动；不得为了运行而擅自安装浏览器。真实 Go/GPT 测试必须另获预算、时间窗和隔离目录授权。
- 执行过程中持续记录 `npm test` 的真实 suite/pass/fail/skip 和 SHA；不复用旧统计，也不因本轮跳过而标通过。

## 7. 最终验收清单与停止条件

**P0 关闭前不得宣布“ModelGate 已完成”**：

- [ ] 原版 Codex Desktop 新会话可以真实选择 Go DeepSeek，工具往返不再触发孤立 output 400；
- [ ] GPT-6 Luna 原生父 → Go DeepSeek 子；原生工具、等待、追派、中断、恢复/压缩连续，不能以 MCP/自造 Agent 代替；
- [ ] `MG-R006` 的压缩后同一子代理语义有**同一最终冻结树**的证据；否则必须显式记 BLOCKED 并请求所有者技术裁决，不因旧树 PASS_REAL 或 mock 宣布完成；
- [ ] 未知显式模型 ID 不发生任何静默切换；
- [ ] 生产 Go/GPT 授权域分离、敏感数据不出日志/仓库、无跨域 fallback；
- [ ] 管理权限与 GUI 一键激活、退出、字节恢复可一致工作，所有新增代理配置可被准确撤销；
- [ ] 双实例隔离等 R009 验收形态由所有者显式批准，或独立实现经批准的多租户方案；
- [ ] 真实客户端与 mock 的结果、请求预算、完整 SHA、复现命令、证据文件、失败案例分别呈现；
- [ ] 新冻结树通过必须的检查和独立 A5 审计，`v2-release-approvals.json` 仅由真实审批写入，PR 保持 Draft 直到批准；
- [ ] 不删除/重写 V1、V2、UX-V3 历史证据；不安装未经授权的新依赖；不直接改生产或 `main`。

完成评估应明确区分：`修复已提交`、`离线验收通过`、`真实上游通过`、`原版 Desktop 通过`、`所有者已签收`、`已发布`。这些状态不可合并。

## 8. 给执行代理的启动要求（简版）

以本文作为固定任务书、按 G0→G6 执行，先处理 P0-01，不再进行没有新证据的空泛架构重规划。主代理负责串联，总计最多 5 个子代理，独立工作树和文件写集；建议 A1 Codex/Go 协议与历史、A2 原生 Agent/压缩、A3 GUI/配置事务、A4 安全与路由、A5 独立 QA。真实 GPT 父仅 `gpt-6-luna`，Go 仅 `deepseek-v4.1-flash`。每阶段报告百分比进度、完成项、阻断项、真实/模拟证据、提交 SHA 和下一步。无真实付费测试授权时停止该类调用并写 BLOCKED，**不要私自降低验收**。只提交到新修复分支并创建 Draft PR，未获得用户同意不合并、不部署。

---

**文档定位**：本文件是本次修复的唯一汇总索引；原始契约、证据和历史记录继续以各自源文件为权威，文档不足以替代真实运行取证。