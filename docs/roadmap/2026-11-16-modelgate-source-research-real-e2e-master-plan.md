# ModelGate｜源码级竞品调研、原生聚合修复与真实使用验收总任务书
> 2026-11-16 · 任务状态：**PLAN / NOT EXECUTED** · 适用基线：GitHub main @ 886e22a863343192e4ae5ab41e38396df4d4813c
>
> 本文是**执行计划而不是完成报告**。本次只完成远端仓库现状读取与公开资料核查；**尚未读取用户本机 CC Switch 文件、尚未运行新一轮真实模型测试或修改生产服务**。任何执行 AI 不能把本任务书写成验收通过。建议文档分支合并前由所有者审阅；不得以此文档替代发布审批。

## 0. 不可退让的产品目标及工程边界

### 0.1 目标用户旅程（必须与日常真实开发体验一致）
1. 用户在 Linux KDE Plasma 桌面打开 **ModelGate GUI**；无需手工维护 TOML 或手调 API，能够检测并接入现有原版 Codex Desktop / CLI，预览、备份、激活、禁用及无损恢复。
2. 完整保留 **ChatGPT 原有登录、套餐配额和官方模型**。原版 Codex Desktop 选择器中出现用户可用的 GPT 模型及 OpenCode Go 的 **deepseek-v4.1-flash**。多模型之间的路由真实、准确、可观察，不静默替换。
3. 使用 **Codex 原生 Harness 及原生 Agent Team**；父代理可用官方 GPT，默认或指定子代理可用 Go DeepSeek。保留 spawn、wait、follow-up / send input、interrupt、原生工具、会话上下文、恢复及模型选择等完整能力。可配置父子模型和 reasoning effort；不能改用 MCP 代理或伪 Agent Team 冒充原生。
4. **上下文压缩必须由 Codex 自己管理和执行**，不得由 ModelGate 开发第二套 LLM 摘要/截断/压缩体系；必须在真实长会话中证明压缩前后同一原生线程和工具历史的连续性，不能靠放大窗口、关压缩、删历史造绿。
5. 仅强制交付 OpenCode Go 的 deepseek-v4.1-flash；其他 OpenCode 模型或协议**不属必达**，小规模初探失败即可停，禁止再扩展泛模型适配吞噬核心资源。
6. 严格隔离订阅授权域、第三方 API Key、会话内容、用量、日志；支持用户需要的可控分发/双实例隔离与撤销；无静默 GPT 回退、无跨供应商泄漏。
7. GUI、后台服务、Codex 客户端、OpenCode Go 的**真实端到端开发体验**须可持续稳定使用；最后以真实项目工作流闭环而不是单轮“模型回答你好”判定完成。

对应现行合同：docs/product/2026-11-14-owner-scope-v2.md（MG-R001–MG-R012）。原文档的 V1 历史约定不得覆盖本 V2 合同。

### 0.2 对实验/协作的硬约束
- 本轮真实 GPT 调用**只准 gpt-6-luna**（父代理真实测试同样如此），所有子代理数量**最多五个**；不得通过把 GPT 模型偷偷改为其他名称、禁用原生能力或强制子代理换 GPT 得到表面通过。
- 原生压缩只使用 Codex 的能力；不会解密、伪造、抹除 opaque/encrypted 片段以声称完整协议保真。必要的无损续轮重建与“自造压缩/摘要”必须严格区分，任何变换均须有输入-输出语义不变证据。
- 不下载模型权重、大型运行时、训练框架、软件套件，**不擅自安装任何依赖**；先定位主机现有安装、源码、缓存和工具链，若确需任何下载须单独申请批准。代码调研优先读已有本地文件、GitHub 文件和网页，不把下载源代码等价于允许安装。
- 不触碰、打印、提交真实 auth.json/密钥值；不擅自改用户个人 Codex 主配置或 CC Switch 安装文件。需要真实配置写入演练时，先备份、核对修改范围，并在所有者已授权的隔离环境中执行，无法隔离才申请明确许可。
- 已有真实测试授权意向**不等于无限额收费授权**。执行前检查当前有效授权、GPT 套餐额度、Go 计费/额度及本轮预算；若缺明确限额，只能执行不产生付费的研究和最小安全验证，输出需批准的真实测试预算申请，不得把 mock 写成 real。收费测试按批准的请求/时长/费用三重上限，先达者立即停。
- 从运行中的生产进程和配置上取证以**只读为默认**；修改 production 8787、systemd、CC Switch 运行配置、默认 Codex 登录等必须有单独授权及字节级可回滚收据。
- 任一阶段禁止静默降低原合同的难度。若遇到上游加密隔离使某能力技术上不可能，记录 **UNSUPPORTED / NO-GO + 原始证据 + 可供所有者裁决的替代路线**，不能擅自启用 classic 模式冒充 V2 原生通过。
- 不自动合并 main、不自动发正式版本、不代写所有者审批、不伪造门禁 PASS_REAL。

## 1. 已确认现状与本轮优先级

### 1.1 已确认的 GitHub 事实（不是本次新实测）
- origin/main = **886e22a**；原生聚合 PR #7 已于 2026-11-16 合并至 main；修复 PR #8 仍为 Draft，**PR 文案的旧 HEAD 与实际分支 HEAD 可能不同**。以后状态以 refs 和最新提交、证据绑定 SHA 为准。
- docs/roadmap/2026-11-16-modelgate-handoff-evening.md 表示状态 **PARTIAL**：Go DeepSeek 子代理的部分派单与续轮重建有真机日志；官方 GPT 父代理**工具结果续轮**仍报 HTTP 400：“No tool call found for function call output”；根因尚未定论。
- 官方续轮响应没有被正确登记，Go 的 recorded/reconstructed 已出现；对官方 SSE / JSON 信封形状、WebSocket 合成 ID 一致性存在**待证假说**。不能再凭 mock/猜测修 sink。
- 已经有原生父/子跑通的历史证据，但最新树上的**真实长会话压缩、压缩后 same-child resume、完整 Desktop 体验、最终冻结**仍未完全通过。
- 曾记录“133 suites / 1289 pass / 0 fail / 3 skip”属于旧版本的**离线**报告，不代表新的真实验证结论。
- 代码热点：src/index.js（proxyOfficialResponses / streamRawResponses / Responses 分流）、src/responses-continuation.js（capture sink、state record/reconstruct）、src/responses-ws.js（WS→HTTP、SSE）、src/codex/native-capabilities.js、src/codex/interop.js、src/codex/desktop-integration.js、src/codex/catalog.js、src/ui-next/*。

### 1.2 阻断顺序
P0-A 官方父代理的连续工具轮次 400 → P0-B 跨供应商 V2 原生任务与密文边界 → P0-C Codex 原生 compaction + same-child resume → P1-D 父/子模型完整 GUI 管理 → P1-E 重启、断流、凭据/目录/回滚与 UX → P1-F 真机长任务、发布冻结。

工程上不能把 P0-B 与 P0-C 当成只需优化兼容字段的普通 BUG：可能牵涉 **Codex 客户端密码学边界或 Provider 继承机制**，必须先查真实源码和实验事实。

## 2. 全任务的强制研究门槛（每项代码工作开始之前必过）

每一项任务（T00–T12）都必须留一份独立研究记录，至少覆盖：
1. **本仓库证据**：基线 SHA、实际文件 + 行号、请求/事件流向、字段所有权、状态机、已有测试与失败条件；不能只复述 README。
2. **原生依赖证据**：与该任务有关的 Codex 当前安装版及对应源码/配置 schema；版本、tag/commit、差异、是否属于官方稳定行为；OpenCode Go 实际协议形状。
3. **竞品实现证据**：本地 CC Switch 的对应实现（若本机确实有源码）、上游对应版本的源码及具体调用链；再至少选择 1 个其他独立项目（优先 OpenCodeX），列出做法、前置条件、代价与潜在失效。
4. **论文/社区证据**：相关开源 issue/PR/discussion/论坛复现，以及合适的系统/Agent/协议论文；区分工程已证事实、理论方案、用户报告和无法核实传言。**论文不是每个微型修复都必须找到一篇直接对应文献**，但必须检索并说明是否有可用证据，不能硬凑。
5. **方案取舍**：列出至少三条技术路线（若领域内只有两条可行路线，解释为何第三条不成立），明示对原生性、协议保真、成本、用户体验、维护负担、上游版本漂移的影响，给出选择与被否决原因。
6. **真机验证方案**：与用户实际 GUI/CLI/AgentTeam 操作相同的行为；预期上下游 request ID、response ID、call_id、tool output、thread/child ID、实际模型、SSE/WS 终态、压缩前后上下文。事先定义失败路径及不会掩盖问题的终止条件。
7. **可审查成果**：研究记录、ADR、最小代码 diff、真实重现与修复证据、回滚方案。若真实源不可得，明确标 NOT_OBSERVED，不能猜测后编造行号。

研究记录至少四栏：**问题 → 代码/讨论/论文一手来源 → 已核实行为 → 对 ModelGate 的决策**。每条事实应提供 URL 或本机绝对路径 + tag/SHA + 行号/符号名，关键证据用可复现命令和脱敏日志关联。

### 2.1 “读完源码”的具体定义
不要求机械通读 CC Switch 中与聚合无关的每一行，但对**相关全调用链必须端到端吃透**：
- 从 UI 的操作事件，到数据库/配置持久化、目录生成、模型 ID 映射、子代理配置，再到请求入口、身份路由、Headers、转换、SSE/WS、压缩和回滚；
- 对每条链路绘出调用图和状态图，标出每个条件分支、错误边界、兼容性选择、feature flag、版本检测、线程/模型切换后的状态恢复；
- 对所有与 ModelGate 的 P0/P1 问题相关的 CC Switch commit、issue、测试和真实 release 行为做对照，能解释它**为什么这么写、解决了什么、牺牲了什么、还有什么不能解决**；
- 抽取可独立验证的设计原理，不盲抄源码；记录版权许可证和引入依赖的代价。

任何 Agent 不得声称“研究完 CC Switch”但只给 UI 截图、安装目录文件名或 README 摘要。

## 3. 重点：本机已安装的 CC Switch 源码级逆向研究（T01，必过）

### 3.1 先定位环境、版本与源码归属
- 在**实际用户主机**只读检测：操作系统及桌面会话、CC Switch 可执行文件/安装目录/包管理来源、是否已有源码工作树、缓存、发行包、符号/SourceMap、开发日志、UI 数据目录与配置（只记路径，不读秘密内容）。
- 用现有命令（如 command -v、readlink、包管理只读查询、限定目录 find、rg、git status / rev-parse）定位；禁止全盘无边界搜索、执行未知脚本或安装新工具。
- 明确区分 **“本机安装了应用”** 与 **“本机有可读源码”**。若只有 AppImage、二进制或打包资源，必须说明哪些部分能够直接审计，哪些需要对应上游开源 commit；不能声称已经研究到本地不存在的源码。
- 找到可读源码时取 git remote、branch/tag/HEAD、manifest/lock、构建版本及源/二进制关系；与本机应用版和 GitHub 上游对应 release **精确比对**。线上 main 的代码不代表用户当前实际运行版。
- CC Switch 所有真实数据/密钥只允许只读元数据级核对，不能把数据库、Key、OAuth 存档或登录会话复制进模型上下文/日志。

### 3.2 必须拆解的 CC Switch 机制
A. Direct / Routing / Aggregation 三种模式配置生命周期：激活、卸载、迁移、切换时原 Codex 凭据、TOML、目录和备份如何保持；并发写、回滚、重启语义。
B. Codex Desktop 与 CLI 的探测、连接、model_catalog_json 结构、配置刷新、客户端模型选择器、前台与后台生效时序。
C. 统一入口如何区分 ChatGPT 官方订阅与第三方路由；模型前缀、空别名、fallback（聚合模式通常禁用）、同线程模型切换、用量来源、错误与权限域。
D. Responses → Chat / 原生 Responses：tool call / output ID、空/孤儿工具结果、并行 tool_calls、tool schema、reasoning、input/output 对应与未知字段；联系其 Issue #7400、#6449 等讨论。
E. SSE/WS 事件生命周期、终态与 stream 不关闭的处理、retry 和错误映射；真实事件是否只是旁路透传还是由它保存后重建。
F. V2 子任务加密边界与 classic 子工具兼容开关；为什么 classic 可以跨域传任务、却失去新版 followup/interrupt；实际源码中 feature flag 如何配置与呈现。
G. native/local/remote compaction 的模型能力声明、触发与重启恢复；如何避免把密文传到不能解密的 Provider。
H. UI 的设置流：父/子模型和 effort 分设、模型不再可用时禁用与提醒、首次体验、错误解释、预览确认、诊断可视化。
I. 安全/可维护性：本地监听、鉴权、凭据归属、配置差分、日志脱敏、版本升级与多用户隔离。
J. 其他隐藏状态：客户端配额耗尽时的行为、旧配置污染、App/CLI 版本差异、增量配置漂移，以及本机实际部署形态的限制。

**T01 强制产物**：版本溯源清单、相关模块源码索引（文件、函数、行号）、端到端调用图、状态转移图、机制对照表、已知 issue/release 对应清单、ModelGate 可借鉴/不可借鉴决定。最后应能回答“CC Switch 为什么在同类场景能跑，哪里是有损折中，哪里同样不支持”。

## 4. 其它项目、原生源码、论文和社区研究（T02/T03）

### 4.1 优先源码对照
- **Codex 官方源码和本机 Codex 构建**：openai/codex；关注 config schema、agents.default_subagent_model、父子 Provider 继承、multi_agent_v2、spawn/follow-up/wait/interrupt、turn/resume、SSE/WS、remote_compaction、加密 agent_message、工具结果 ID 配对。始终与用户已安装的 CLI/Desktop 版本对齐，不拿未来/旧版源码误判。
- **CC Switch 上游**：farion1231/cc-switch，重点是用户已安装的对应 tag。官方聚合文档明确写 classic 子工具是跨供应商解密失败的兼容措施，代价是缺失新版 followup_task / interrupt_agent；这是对照信息，**绝不允许直接抄作本项目的完成方案**。
- **OpenCodeX**：lidge-jun/opencodex；研究 provider 前缀命名、单目录多模型、Codex 本地压缩偏好、加密 task passthrough、session pinning、恢复/迁移、客户端版本检测。其作者在公开文档讨论客户端压缩与 V2 子任务的组合，可优先考察真实代码。
- **CLIProxyAPI**：router-for-me/CLIProxyAPI；重点官方账号认证/配额/路由、请求身份域、安全与原生 Codex 客户端接入，不能把开放通用 API 自动等同于原生 AgentTeam 兼容。
- **LiteLLM Gateway**：BerriAI/litellm；参考模型编排、预算、回退、请求路由、配额账本、provider 错误归因，但其面向通用 API 的设计不能替代 Codex 原生任务语义。
- 如发现更接近的项目（如相关 fork/实现，需先核实许可证、维护时间和真实行为），按“相关程度、源码可查、近期实测、核心技术差异”纳入，不为了堆项目数量走过场。

### 4.2 论文维度（调查适用性，禁止空泛堆文献）
- When Messages Go Wrong: Understanding Communication Faults in LLM-Based Multi-Agent Systems，arXiv:2610.15459（消息缺失、延迟、上下文过期、传播与检测）；对应续轮与中断恢复。
- A Technical Taxonomy of LLM Agent Communication Protocols，arXiv:2606.19135（payload、交互状态、发现与 schema）；对应跨供应商边界与状态归属。
- AgentWorld: Benchmarking Long-Horizon Collaboration of Multi-agent LLMs，arXiv:2609.31590（长周期协作和因果贡献）；对应真实长任务验收设计。
- A Survey of AI Agent Protocols，arXiv:2504.16736（协议层次、安全与互操作）；对应非 MCP 的原生代理方案边界。
- 可扩展 context management、distributed systems replay、at-most-once、event sourcing、property-based testing 等**真正对方案有帮助**的论文。对每篇总结“对应哪条工程难题、可验证假说、不能直接推断的点”，不把论文类比误写成已经实现。

### 4.3 社区证据（必须交叉审阅）
- CC Switch Issue #7400（孤儿 function_call_output → 400）、#6449（并行 tool_calls ID/arguments 混并）、#7459（tool schema top-level oneOf）、发布说明中关于 DeepSeek/Kimi 工具续轮与 compaction 的真实修复记录。
- Codex Issue #33267（multi_agent_v2 跨供应商密文/工具输出的客户端侧失败）、OpenCodeX Issue #3978（客户端压缩与 V2 子代理兼容诉求）。
- GitHub Issues/PR/Discussions、官方文档、开发者论坛、Reddit 的 firsthand reproduction；记录版本、时间、环境、复现与反例，不能以单个帖子断言所有环境。
- 优先近版本、关闭且有修复提交与测试的 issue；未解决讨论作为线索而不是设计定论。

### 4.4 技术路线矩阵（必须填实证，不得先写赢家）
至少比较：（1）单统一 Provider + ModelGate 模型分流；（2）独立父/子 Provider 配置（若 Codex 当前版本不支持，明确限制）；（3）Codex 原生版本修补/扩展或上游 issue/PR 路线；（4）CC Switch classic 兼容路线**仅用作有损对照，不可替代目标**。
维度：Codex 原生 AgentTeam、跨供应商任务可读性、V2 密文边界、same-child followup/interrupt、原生压缩、Desktop 配置、账号保护、性能/成本、变更风险、长期维护与真实验收结果。

## 5. 具体执行任务与每项研究/验收要求

> T00–T12 每项都继承第 2 节的**源码+竞品+论文/社区检索+ADR+真机实验**研究门槛。任务负责人必须填写“研究充分/研究未完成”的可验证证据，不能因进度赶而跳过。
> 可并行研究，但**共享源码写集与主干集成、生产部署和发布冻结必须串行**。

| ID | 优先级 | 目标 / 研究重点 | 主线交付 | **真实验收（至少）** |
| --- | --- | --- | --- | --- |
| T00 | P0 | 基线、环境与授权盘点；重算 main/PR/部署 SHA；调查现有实机日志/端口/配置差异 | baseline、权限表、故障时间线、研究追踪台账 | 以只读方式验证真实安装/进程/版本；不对真实模型做无意义“你好”探针 |
| T01 | P0 | **本机 CC Switch 完整相关源码链路**，配合其真实运行版与上游对照 | CC Switch source atlas、调用图、差异矩阵、ADR 候选 | 真实 CC Switch 同场景的有限 A/B 观察（不覆盖原配置、不私改账户），附具体版本和脱敏收据 |
| T02 | P0 | 本机 Codex 原生 Harness / OpenCode Go 协议、V2 密文与 Provider 继承 | Codex/OpenCode 行号级源码研究、可行性边界 | 用真实 CLI/Desktop 观察 model/provider、spawn/subagent 工具和事件实际形状 |
| T03 | P0 | OpenCodeX、CLIProxyAPI、LiteLLM、论文与社区失败模式 | 技术路线矩阵、引用索引、明确取舍 | 对最有希望方案先做针对真实故障的小规模对照，不能拿模拟通过代替最终结论 |
| T04 | P0 | 统一路由、续轮与状态 ownership 架构 ADR；明确哪些机制必须忠于 Codex | 协议不变量、状态机、错误树、无损边界 | 真实客户端可复现序列和可对照收据；不能只跑协议单元测试 |
| T05 | P0 | **官方 GPT 父代理工具续轮 400**：capture sink、JSON/SSE、responseId/WS 对齐、原子终态登记、真正的 call/output 配对 | 根因最小证据 + 有限 diff + 确认无损的捕获/重建 | 原版 Codex gpt-6-luna，真实工具执行→后续工具结果→至少 3 个连续轮次，上一轮 responseId 和 callId 可追踪，0 上游 400 |
| T06 | P0 | **跨供应商原生 V2 子任务**：加密任务、provider 继承、same-child followup/interrupt；探索可行的原生修复边界 | 可行性 ADR、真实交互端到端、若不可行则 NO-GO | GPT-6 Luna 父→Go DeepSeek 子，原生 spawn/wait/follow-up/interrupt、任务正文可达、产物回父、同一 child ID |
| T07 | P0 | **Codex 自有原生 compaction**：local vs remote、provider 元数据、真正的触发和续轮 | 选择/配置方案与不引入自建压缩的源码/日志证明 | 真实长会话发生 Codex 原生压缩，前后 same-child、保留工具与关键上下文、继续完成代码任务 |
| T08 | P1 | **真实 GUI 用户旅程**：父子模型独立设置、effort、发现、聚合开关、目录/选择器、备份/退出 | 统一状态管理与原版 Desktop 端到端、无需手改 TOML | GUI 点击激活→真实 Desktop 新会话模型选择→父子运行→关闭恢复，用户能理解错误，不出现僵尸配置 |
| T09 | P1 | 账号/额度/域隔离、注入、429/403、模型/凭据精确路由、双实例分发 | 身份权限 ADR、真实请求账本与脱敏验证 | 官方与 Go 请求实际目标/模型/凭据域一致，错误不自动换官方，重启/并发下不串线 |
| T10 | P1 | Responses WS/SSE 生命周期、中断取消、状态缓存过期/重启、备份和版本升级 | 原生事件/状态完整性，恢复和退出策略 | 真实 SSE 完成但不关流、客户端中断、网关重启后明确恢复或失败、无重复工具派单或丢结果 |
| T11 | P1 | **用户真实开发任务验收**：跨文件代码修改、工具和子代理长链、回滚、错误诊断/易用性 | E2E task receipts、视频/截图（经许可）、体验问题台账 | 真实项目至少一个完整编码任务，运行中需要子代理、实际工具和多轮会话，用户视角可完成并解释每一步 |
| T12 | P1 | 集成、回归、文档/支持矩阵、独立 QA、发布冻结 | 冻结 SHA + 真机验收矩阵 + 最终报告 + 可复现回滚 | 同一冻结树上核心场景真实 PASS_REAL；未通过的每项显式阻止发布 |

### 5.1 T05 真正的根因实验，不要继续盲修
现有报错关键事实：真实官方订阅响应无 recorded；Go response recorded/reconstructed 正常；SSE 可能不关流。先在 **proxyOfficialResponses 上游成功边界**添加只记录元数据的诊断：HTTP content-type、是否 JSON/SSE、首个成功解析 data JSON 的键名、response ID 所在层级、终态类型、向 Codex 发出的 ID、store 记录时序（不可记内容、Token、原始输入输出）。
按一次真实父代理带工具闭环定位：
- 如果官方未被解析：纠正实际 JSON/SSE 包装，测试事件拆包、data 多行、BOM、注释与无 EOF；
- 如果已解析却无登记：纠正 created/output_item.done/completed 的时序与 sink 生命周期；
- 如果已登记但找不到：检查 response ID 一致性、cache key、prevId、thread ID、provider/模型切换以及并发竞态；
- 如果工具仍孤儿：检查完整 input + 真实 function_call/output 的关联，区分由 Codex 注入的特殊孤儿和本该匹配的官方上一轮真实调用。**不允许为修补 400 伪造原官方 call 或删除工具历史**。
每个假说用日志证据排除；修复后真实三轮以上复现 + 失败案例，不能用简单 200 回包验收。

### 5.2 T06/T07 原生兼容性困难的真实结论机制
若 Codex V2 的 encrypted agent_message / reasoning 以供应商密钥绑定，任何通用代理都不能无损解密。必须在源码及真实事件中证明可行的**原生**替代路径或如实写技术 NO-GO。classic 工具只作为竞品妥协对照。可提交上游兼容性 PR/Issue 的研究建议，但不得偷偷引入 forked Codex 替换用户官方 Desktop。
压缩问题需真实证明是 Codex 决定/执行；研究 remote_compaction provider 级能力与 unified provider 的冲突，不能靠“增大 context_window”回避。若触发成本很高，先提交预计请求/额度与最小复现方案，执行得到预算授权后再做，而不是假称已过。

## 6. 真实测试策略：替换无效冒烟测试

### 6.1 什么**不算**验收
- 单次 GET /healthz、浏览器页面能打开、模型列表出现、API Key 返回 200；
- “你好/1+1”单轮回答、一个简单 shell 成功；
- mock/fixture/静态截图/测试套件全绿、历史其他 SHA 的 PASS_REAL；
- 单次 spawn 成功但没有子任务正文、工具结果回父与 same-child 恢复；
- 通过关闭 multi_agent_v2、关掉压缩、替换 GPT/Go 模型、删历史、断开原生工具以换取 200。

上述检查可作为**极简安全前置检查**，不得投入反复测试周期，更不可计作用户验收。

### 6.2 真实验证基础
- 执行环境优先用户真实 **Linux KDE Plasma + 原版 Codex Desktop + 已安装 Codex CLI + 本地 ModelGate + 既有 CC Switch（竞品对照）**；同步记录版本、实际进程、SHA、真实模型、Provider、协议、UI 是否重启生效。
- 用用户通常会做的中等复杂度开发任务：阅读已有代码→父代理拆解→Go 子代理实际检查与修改若干文件→工具执行（如 grep/测试/编辑）→父代理等待/汇总→用户追问→同子继续→适当中断/恢复→更长上下文触发 Codex 原生 compaction→任务完成。真实工作区只在受控、可回滚的工作树内执行，防止测试改坏日常项目。
- 在合理预算内优先针对 P0 故障进行**有诊断价值的真实多轮**；没有真实证据就记 BLOCKED/NOT_RUN，而不是用越来越多 mock 填补。
- 配置两条对照：真实 Codex 直连/现有 CC Switch 聚合（只读或经过许可的隔离 profile）与 ModelGate，尽量保持同版本 Codex、相同任务和可比较的模型/额度；**当竞品使用 classic 有损退路时必须标注**，不得把它与原生 V2 直接视为同等方案。
- 测试记录：冻结 commit、binary/version、时间、模型/Provider、请求计数/费用、真实上下游目标、traceId、threadId、childId、responseId、callId、工具 exit code、压缩事件、终态、截图/录屏的来源（隐私脱敏）、中断恢复/回滚结果、失败原始错误类别。
- 每个 P0 修复至少具有真实故障复现（red）、新实现真实通过（green）、真实回归（同一类型复杂序列、不会引入旧问题）。如果问题具有随机性，以足够的独立真实回合验证稳定性，说明样本数，不作“100% 可靠”空口承诺。
- 可保留快而确定的离线回归作代码保护；**优先级与时间预算以实机真实 E2E 为主**。单元通过不是门禁豁免；禁止使用无意义短探针反复消耗额度。
- 真实 UI 使用体验是独立门禁：正常启动、错误说明、交互可理解、切换/退出清晰；没有原版 Desktop 操作的所谓“UI 已完成”必须标为 PARTIAL。

### 6.3 真实场景最低矩阵
R01 官方 GPT 多轮工具 call/output，无 400；R02 GPT 父 → Go 子原生派单且子确实收到任务；R03 同一 child 追派两次且可记住先前上下文；R04 wait/interrupt 后恢复且无双终态；R05 Go 子实际修改受控代码并回传父；R06 原生 compaction 真触发并同子续轮；R07 Desktop GUI 一键聚合、目录、模型选择/effort/回滚无手改；R08 官方 auth 与 Go Key 不交叉、429/401 不暗转；R09 网关/客户端重启后的明确恢复/可解释失败；R10 CC Switch 对照与来源链；R11 一次真实多文件开发任务完整交付；R12 冻结 SHA + 配置/凭据回滚与发布审批。
逐项记录 PASS_REAL / FAIL_REAL / PASS_MOCK / NOT_RUN / BLOCKED；**只有 PASS_REAL 才满足最终现实产品验收**。

### 6.4 真机预算 / 权限 / 风险节流
- 每批真实测试前出示剩余额度、批准上限与 stop conditions，按真实性、阻断解决价值和成本排序；禁止用海量无效探针换信心。
- 所有 GPT 请求只允许 gpt-6-luna；Go 模型固定 deepseek-v4.1-flash；模型别名不得绕开请求级模型核验。
- 可选择隔离 CODEX_HOME/临时 profile；如真实体验必须在原版 Desktop 的现有配置测试，则先申请该范围的真实写入许可与回滚验证，不以无权读取账户信息为借口伪造成功。
- 模型请求异常时记录一份原始脱敏信封的结构和事件时间线；避免反复重试同一未归因 400。每一次真实复测必须能证伪一个假说。
- 如果无法取得某项真实环境/收费授权，停在该项并继续其他只读研究与无费工作；成果记阻断与准确下一步，绝不可自动降级验收。

## 7. 分工、交付结构与里程碑

### 7.1 AgentTeam：主代理 + 最多五个子代理
- **主代理**：整体架构、冲突裁决、共享代码集成、预算权限、最终冻结与用户汇报；所有真实 GPT 父模型强制 gpt-6-luna。
- **A1 CC Switch 源码研究员**：T01，研究本机已安装对应版本 + 上游源码 + 问题链，默认只读，不修改 CC Switch。
- **A2 Codex/Go 原生协议研究员**：T02/T06/T07；真实源码、协议与密文边界、压缩能力和上游 Issue。
- **A3 跨项目/论文/论坛研究员**：T03/T04；OpenCodeX、CLIProxyAPI、LiteLLM、学术与社区证据矩阵。
- **A4 网关实现工程师**：T05/T09/T10；仅在已完成研究/ADR 后进入其独立文件写集，修复最小根因。
- **A5 独立真实 E2E QA + UX**：T08/T11/T12；实际 Codex Desktop 工作流、失败追踪、反降级与冻结审计，不用 mock 结果冒充真实。

任务实际分工可动态微调，但主/子数量、独立 worktree、互斥写集、独立 QA 审查与所有者审批不可取消。共享 src/index.js、config.toml 生成器、catalog 和发布脚本必须由单一集成者按依赖顺序提交。

### 7.2 必需的交付物（开发者须落盘）
可将后续研究、验收证据按以下目录管理（已有文件先复用，不为了文件名重复建档）：
- docs/research/modelgate-ccswitch-local-source-atlas-20261116.md
- docs/research/modelgate-codex-opencode-protocol-20261116.md
- docs/research/modelgate-competitors-papers-community-20261116.md
- docs/architecture/adr-modelgate-native-cross-provider-v2.md
- docs/evidence/modelgate-live-root-cause-20261116.md
- docs/evidence/modelgate-live-user-journey-20261116.md
- docs/evidence/modelgate-acceptance-matrix-latest.md
- docs/roadmap/modelgate-execution-progress.md

文档要有**百分比进度**，但进度只按有审查证据的已完成任务权重核算，例：Research 0/4、P0 0/3、UX 0/2、E2E 0/3；不得凭主观观感写 90%。必须额外显示**真实验收比例**，与代码完成率分开。每次会话中断都要能从最新 SHA 和记录恢复，不需要从头猜测。

### 7.3 阶段闭环（阶段闸门）
G0 环境/版本/源定位 → G1 CC Switch/原生源码/竞品/文献研究与技术路线决策 → G2 官方多轮续轮实机修复 → G3 原生跨供应商 AgentTeam & Codex compaction 的真实可行性与实施 → G4 一键 GUI/父子配置与安全/恢复 → G5 真实长任务开发体验 → G6 独立 QA、同树冻结、批准后发布。
任何阶段如果关键研究证据不够，优先继续研究而非先写一堆补丁；若“技术不可能”的证明成立，交付 NO-GO 和裁决方案，保留目标，不静默改合同。
每个阶段给一份下一阶段可直接执行的任务清单/启动状态，并注明剩余预算、实际障碍和回滚点。

## 8. 关键行为伪代码 / 不变量（设计示意，非直接可执行代码）

    on_codex_request(request):
        assert user-authorized local configuration and exact target
        owner = resolve_request_owner(request.model, request.thread)
        assert owner in {"official-chatgpt-subscription", "opencode-go-deepseek"}
        assert no cross-domain auth headers or fallback model rewriting

        if request.previous_response_id exists:
            # full reconstruction is deterministic replay of REAL items; never summarize
            previous = continuation_store.lookup_exact(request.previous_response_id)
            if previous missing:
                record_typed_failure_with_trace()
                # an "optimistic forward" cannot claim completeness; official orphan outputs must fail honestly
                stop_or_use_a_proven_native_safe_resume_path()
            else:
                request.input = faithful_concat(previous.actual_input, previous.actual_output, request.delta)
                preserve_call_output_pairing_and_encrypted_payload_ownership()
                remove_only_unsupported_wire_field_with_logged_reason()

        response = forward_to_frozen_target(request)
        for each actual event from response:
            parse_actual_upstream_envelope_version_aware()
            record_real_response_id_and_tool_items_before_codex_can_continue()
            forward_preserving_protocol_meaning()
        on terminal:
            atomically_commit_trace_and_actual_response_items()
            record_single_terminal_even_if_transport_keeps_open()
        # when a provider truly cannot support V2 encryption/compaction:
        # return explicit unsupported; don't synthesize decrypted content or mock success.

    approve_task(task_id):
        require_local_source_research + official_source_research + cross_project_matrix
        require_credible_issue_or_paper_scan + ADR + test_red_case
        do_minimal_patch()
        run_targeted_offline_regression_as_fast_guardrail()
        run_authorized_real_codex_desktop_or_cli_e2e()
        qa_independently_check_trace_and_user_visible_outcome()
        mark PASS_REAL only when frozen_sha_and_real_target_evidence_match

实现人员必须用真实源码修正示意伪代码。尤其对状态缺失策略，不能机械照抄为一律拒绝；先按官方/Go 的真实续轮机制、客户端恢复需求与安全属性做精确取舍。

## 9. 交接资料与研究起点

### ModelGate 本仓库
- 当前晚间交接：https://github.com/xiaomengxizzh/model-gate/blob/main/docs/roadmap/2026-11-16-modelgate-handoff-evening.md
- V2 不可降级需求：https://github.com/xiaomengxizzh/model-gate/blob/main/docs/product/2026-11-14-owner-scope-v2.md
- 源码：https://github.com/xiaomengxizzh/model-gate/blob/main/src/index.js
- 续轮缓存：https://github.com/xiaomengxizzh/model-gate/blob/main/src/responses-continuation.js
- WS 桥：https://github.com/xiaomengxizzh/model-gate/blob/main/src/responses-ws.js
- PR #7：https://github.com/xiaomengxizzh/model-gate/pull/7
- PR #8：https://github.com/xiaomengxizzh/model-gate/pull/8

### 官方源码与可参考实现
- CC Switch 仓库：https://github.com/farion1231/cc-switch
- CC Switch 聚合机制：https://ccswitch.co/docs/proxy-aggregation.html
- CC Switch V4 聚合说明：https://github.com/farion1231/cc-switch/blob/main/docs/release-notes/v4.0.0-en.md
- OpenCodeX：https://github.com/lidge-jun/opencodex
- OpenCodeX Codex 集成：https://github.com/lidge-jun/opencodex/blob/main/docs-site/src/content/docs/guides/codex-integration.md
- Codex 官方源：https://github.com/openai/codex
- Codex 配置 schema：https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json
- CLIProxyAPI：https://github.com/router-for-me/CLIProxyAPI
- LiteLLM 网关架构：https://docs.litellm.ai/docs/proxy/architecture

### 值得直接研究的故障和论文
- CC Switch #7400：https://github.com/farion1231/cc-switch/issues/7400
- CC Switch #6449：https://github.com/farion1231/cc-switch/issues/6449
- CC Switch #7459：https://github.com/farion1231/cc-switch/issues/7459
- Codex #33267：https://github.com/openai/codex/issues/33267
- OpenCodeX #3978：https://github.com/lidge-jun/opencodex/issues/3978
- 通信故障论文：https://arxiv.org/abs/2610.15459
- 通信协议分类：https://arxiv.org/abs/2606.19135
- 长周期协作 benchmark：https://arxiv.org/abs/2609.31590
- Agent 协议综述：https://arxiv.org/abs/2504.16736

以上只是**起始必查索引，不是调研结果已经完成的证明**。所有本地版本、本机源码路径及竞品真实 A/B 结果必须由后续执行代理在用户主机获得证据后填写。

## 10. 完工定义

只有用户在**原版 Codex Desktop + ModelGate GUI** 中，不经任何手工协议补丁完成以下场景，才能声明真正完成：保留官方套餐登录、选择 GPT-6 Luna 父代理和 Go DeepSeek 子代理、可靠多轮工具执行、原生派单/同子追派/等待/中断/恢复、真实 Codex 原生压缩后的同子连续工作、复杂开发任务完成、出错可诊断且不会静默换模型、退出恢复原环境。上述每一环具有同一最终冻结 SHA 上的真实证据，安全、授权与最终所有者审批通过。

未完成任何一环，诚实报告 PARTIAL / BLOCKED / NO-GO，保持交付能力与用户目标的区别。禁止在失去关键原生功能的前提下宣布完成。


---

## 11. 2026-11-17 P0 增补：ChatGPT 官方套餐普通对话断流与传输可靠性

> **本节优先级高于原 1.2、6.2、6.3 的旧顺序；详细研究范围、公开证据、诊断方法和验收矩阵见 [官方套餐对话中断与 Responses 传输可靠性专项补充任务书](../research/modelgate-stream-interruption-reliability-20261117.md)。**

用户新增报告：即使仅使用 ChatGPT 官方套餐模型普通对话，也可能无故中断/停滞；类似现象曾在旧版 CC Switch 出现。该问题独立于 DeepSeek 子代理和工具续轮，必须提升为 P0。不得预设它是 ModelGate、CC Switch 或 OpenAI 单方问题。

### 11.1 已发现的重要外部证据

- CC Switch #4535 的特定 Chat upstream 提前截断问题，在 v3.16.2 加入截断检测、v3.16.4 继续加固；这是检测不完整流，不代表中途自动恢复。
- CC Switch #1673 的 405 WebSocket 兼容问题以 426 触发 Codex 回退 HTTP/SSE 处理；当前 #8404 仍要求真正的 WS/WSS 代理。426 fallback 不能称为端到端 WebSocket。
- CC Switch #8126 / PR #8281 修复 Chat 转换器在 [DONE] 后仍继续消费上游的问题；PR 明确不实现 retry/continuation。Issue 被关闭不等于中途断流已能自动续传。
- Codex 官方仓库仍有多起公开断流报告：#20739、#32366、#36059、#44099、#51886；其中包括无本地代理的 ChatGPT Pro 用户断流、长线程 WebSocket 关闭、HTTP 200 无 SSE 事件以及特定请求的约 900 秒截断。
- OpenAI 网络建议明确提醒代理、防火墙、TLS inspection 和 WebSocket idle timeout 可能造成 Codex 连接停滞或断开。

以上证据说明同类现象确实存在，但不构成用户本机根因的证明。

### 11.2 ModelGate 当前传输架构必须重新审计

本次读取 main 源码发现：
- src/responses-ws.js 接受 Codex 客户端 WS，但 runTurn 实际向本机 /v1/responses 发 HTTP POST，并以 text/event-stream 消费上游；当前是 **Client WS → Local HTTP → Upstream SSE → Client WS**，不是端到端 WS。
- src/responses-ws.js 每 60 秒向客户端发 Ping；PONG 当前仅被忽略，尚需核实/补齐 liveness 计时。
- src/index.js::proxyOfficialResponses 的原生 Responses forward 调用传 noRetry: true；必须审计其确切作用及与中途恢复的关系。
- src/index.js::streamCodexResponse 的 catch 未绑定原始异常，只向下游映射通用 stream interrupted/timeout，可能丢失 ECONNRESET 等根因。需增加安全脱敏的阶段和 errno/code 观测。
- 必须检查 HTTP 200 但首事件长期不出现、SSE EOF 缺少真实 terminal、异常关闭和资源释放。

这些是源码审计发现的风险点，不是已证明的用户故障根因。

### 11.3 新增执行任务 T13（P0-A）

| ID | 优先级 | 目标 | 主线交付 | 真实验收 |
| --- | --- | --- | --- | --- |
| T13 | P0-A | 官方套餐普通对话连续性与 Responses 传输可靠性；分别研究 Codex 直连、CC Switch 本地路由/聚合、ModelGate WS→HTTP/SSE、候选端到端 WS | 本机实际路由与版本溯源、传输调用图、故障分类、脱敏诊断、竞品/官方源码研究、ADR | 同一主机/账号/网络的 direct / CC Switch / ModelGate 受控真实任务对照；覆盖旧线程/新线程、长任务、首事件、SSE terminal、WS ping/pong、错误恢复；不得用 1+1 冒充 |

T13 研究与真实验证至少包括：
1. 确认用户实际使用界面、客户端版本、官方登录路径、实际 Provider/模型、当时接管工具及其模式。
2. 画出 direct Codex、CC Switch、ModelGate 的完整 transport topology，区分客户端到网关与网关到上游的协议。
3. 区分 WS handshake 失败、WS 中途关闭、HTTP 200 无首事件、SSE 无 terminal EOF、ECONNRESET、first-event timeout、idle timeout、overall budget、用户中断、工具续轮 400。
4. 对照 Codex 官方 WS retry/fallback、CC Switch 426 fallback 与截断检测、ModelGate 内部 HTTP/SSE 适配。
5. 评估安全的 retry/continuation。禁止重放已产生副作用的工具调用，禁止伪造 completed、删历史、静默换模型或跨账号域回退。
6. 评估 first-event timeout、stream idle timeout、overall budget、WS pong deadline 的独立配置与可观测性。
7. GUI 必须让用户知道当前 Provider、模型、实际传输、首事件等待/重试状态、是否保留部分结果及可恢复操作。

### 11.4 优先级与阶段顺序修订

新的 P0 顺序：
1. **P0-A T13：官方套餐普通对话/Responses 传输可靠性**（先建立 direct / CC Switch / ModelGate 基线）。
2. P0-B T05：官方 GPT 父代理工具续轮 400。
3. P0-C T06：跨供应商原生 V2 子任务与密文边界。
4. P0-D T07：Codex 原生压缩与 same-child resume。

新增阶段 **G0.5**：在 G0 环境、版本、授权盘点之后，完成普通官方对话的 direct / CC Switch / ModelGate 传输基线、故障分类和 T13 专项研究方案；之后再进入 G1 源码/竞品研究与 G2 修复。T01 本机 CC Switch 源码研究必须与 T13 并行启动。

### 11.5 真实测试矩阵扩展

新增 R13–R20，详见补充任务书：
- R13 官方直连基线；
- R14 ModelGate 同任务；
- R15 本机 CC Switch 同任务；
- R16 有代表性的长时间生成/多文件任务；
- R17 旧长线程与新线程 A/B；
- R18 普通无工具对话与有工具编码任务对照；
- R19 WS 长连接、空闲恢复、断线与网络切换；
- R20 故障恢复、部分结果保留、取消/重试与用户可见错误。

只有同一冻结 SHA 上的真实 PASS_REAL 才计入最终门禁。禁止用健康检查、简单单轮 prompt、Mock、单纯 200 状态或禁用 WebSocket/工具/压缩换取通过。

### 11.6 启动指令更新

执行 AI 在原启动提示词的 G0 之后，必须先并行启动：
- A1：本机 CC Switch 版本/源码与相关历史修复研究（T01）；
- A2：Codex 原生 WebSocket、HTTP fallback、重试/超时和会话状态研究（T02/T13）；
- A3：ModelGate 当前 WS→HTTP/SSE 代码路径、错误保留与资源生命周期审计（T13）；
- A4：CC Switch/Codex Issues、PR、release、论坛和相关论文证据复核（T03/T13）；
- A5：独立 QA 制定 direct / CC Switch / ModelGate 同场景真实对照与收据模板（T13）。

主代理负责对齐真实用户路径、预算与授权；子代理最多五个。完成 G0.5 之前不得直接大规模改写代理传输层。任何未能真实复现或未能取得证据的项标 NOT_RUN/BLOCKED，不得猜测归因。
