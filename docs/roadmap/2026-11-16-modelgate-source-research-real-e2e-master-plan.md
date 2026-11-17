# ModelGate｜源码级竞品调研、原生聚合修复与真实使用验收总任务书
> 2026-11-16 立项 · 2026-11-17 **本机校准修订版（rev2）** · 任务状态：**PLAN / NOT EXECUTED**
> 适用基线：GitHub main @ `886e22a863343192e4ae5ab41e38396df4d4813c`（2026-11-17 本机 fetch 核实）
>
> 本文是**执行计划而不是完成报告**。rev1 只完成远端仓库现状读取与公开资料核查；**rev2 已完成本机只读取证与源码逐行审计**（见 [本机基线快照](../evidence/modelgate-local-baseline-20261117.md)），但**尚未运行新一轮真实模型测试或修改生产服务**。任何执行 AI 不能把本任务书写成验收通过。建议文档分支合并前由所有者审阅；不得以此文档替代发布审批。
>
> **rev2 修订说明**：
> 1. 新增 §1.2 本机已核实事实（服务停止、当前日常路径=官方直连、CC Switch 仅二进制、Codex 0.167.0 机制），G0 改为"复核快照"而非从零盘点。
> 2. T01 按"本机无 CC Switch 源码"的真实情况重新定界：二进制/配置/日志元数据 + 上游 v4.0.27 tag 源码（已有 /tmp/ccs427 选摘快照）。
> 3. 全部源码引用校准到 886e22a 实际行号，更正 `forward` 归属（src/request.js，非 forward.js）；新增 7 项 rev1 未发现的风险（详见 [补充任务书 rev2](../research/modelgate-stream-interruption-reliability-20261117.md) §3.8）。
> 4. 全部公开 Issue 状态经 GitHub API 核实（CC Switch 12 项、Codex 7 项）；四篇 arXiv 论文核实真实存在，另补 2 篇更直接相关的候选。
> 5. 新增 §12 G0/G0.5 可执行清单与三路径操作规程指针；启动提示词独立成文（[2026-11-17-modelgate-deep-research-start-prompt.md](2026-11-17-modelgate-deep-research-start-prompt.md)）。
> 与 rev1 冲突时以 rev2 为准；与补充任务书冲突时以补充任务书为准；与所有者最新明确指示冲突时以所有者指示为准。

## 0. 不可退让的产品目标及工程边界

### 0.1 目标用户旅程（必须与日常真实开发体验一致）
1. 用户在 Linux KDE Plasma 桌面打开 **ModelGate GUI**；无需手工维护 TOML 或手调 API，能够检测并接入现有原版 Codex Desktop / CLI，预览、备份、激活、禁用及无损恢复。
2. 完整保留 **ChatGPT 原有登录、套餐配额和官方模型**。原版 Codex Desktop 选择器中出现用户可用的 GPT 模型及 OpenCode Go 的 **deepseek-v4.1-flash**。多模型之间的路由真实、准确、可观察，不静默替换。
3. 使用 **Codex 原生 Harness 及原生 Agent Team**；父代理可用官方 GPT，默认或指定子代理可用 Go DeepSeek。保留 spawn、wait、follow-up / send input、interrupt、原生工具、会话上下文、恢复及模型选择等完整能力。可配置父子模型和 reasoning effort；不能改用 MCP 代理或伪 Agent Team 冒充原生。
4. **上下文压缩必须由 Codex 自己管理和执行**，不得由 ModelGate 开发第二套 LLM 摘要/截断/压缩体系；必须在真实长会话中证明压缩前后同一原生线程和工具历史的连续性，不能靠放大窗口、关压缩、删历史造绿。
5. 仅强制交付 OpenCode Go 的 deepseek-v4.1-flash；其他 OpenCode 模型或协议**不属必达**，小规模初探失败即可停，禁止再扩展泛模型适配吞噬核心资源。
6. 严格隔离订阅授权域、第三方 API Key、会话内容、用量、日志；支持用户需要的可控分发/双实例隔离与撤销；无静默 GPT 回退、无跨供应商泄漏。
7. GUI、后台服务、Codex 客户端、OpenCode Go 的**真实端到端开发体验**须可持续稳定使用；最后以真实项目工作流闭环而不是单轮"模型回答你好"判定完成。

对应现行合同：docs/product/2026-11-14-owner-scope-v2.md（MG-R001–MG-R012，含 N04 历史导出书面例外）。原文档的 V1 历史约定不得覆盖本 V2 合同。

**本机形态说明（rev2）**："原版 Codex Desktop" 在本机 = **ChatGPT 桌面 26.1103.32239 内置 Codex app-server**（`/usr/lib/chatgpt/resources/codex`），无独立 Codex 桌面应用；Codex CLI 0.167.0 在 `~/.local/bin/codex`。验收手册 `docs/how-to/desktop-acceptance.md` 的隔离实例流程（`bin/mg-desktop.mjs` + `MG_DESKTOP_STATE=/tmp/…`）就是针对该形态，直接沿用。

### 0.2 对实验/协作的硬约束
- 本轮真实 GPT 调用**只准 gpt-6-luna**（父代理真实测试同样如此），所有子代理数量**最多五个**；不得通过把 GPT 模型偷偷改为其他名称、禁用原生能力或强制子代理换 GPT 得到表面通过。**日常 config 默认模型虽已是 gpt-6-luna，仍须每次出站请求级核验，不得依赖默认。**
- 原生压缩只使用 Codex 的能力；不会解密、伪造、抹除 opaque/encrypted 片段以声称完整协议保真。必要的无损续轮重建与"自造压缩/摘要"必须严格区分，任何变换均须有输入-输出语义不变证据。
- 不下载模型权重、大型运行时、训练框架、软件套件，**不擅自安装任何依赖**；先定位主机现有安装、源码、缓存和工具链，若确需任何下载须单独申请批准（RESOURCE_APPROVAL.md）。代码调研优先读已有本地文件、GitHub 文件和网页，不把下载源代码等价于允许安装。**rev2 已有 /tmp/ccs427 的 v4.0.27 tag 源码选摘（研究快照，非安装），优先复用。**
- 不触碰、打印、提交真实 auth.json/密钥值；不擅自改用户个人 Codex 主配置或 CC Switch 安装文件。需要真实配置写入演练时，先备份、核对修改范围，并在所有者已授权的隔离环境中执行，无法隔离才申请明确许可。
- 已有真实测试授权意向**不等于无限额收费授权**。执行前检查当前有效授权、GPT 套餐额度、Go 计费/额度及本轮预算；若缺明确限额，只能执行不产生付费的研究和最小安全验证，输出需批准的真实测试预算申请，不得把 mock 写成 real。收费测试按批准的请求/时长/费用三重上限，先达者立即停。
- 从运行中的生产进程和配置上取证以**只读为默认**；修改 production 8787、systemd、CC Switch 运行配置、默认 Codex 登录等必须有单独授权及字节级可回滚收据。**rev2 取证时网关与 CC Switch 均停止；启动任何服务必须先明确树/端口/配置并记录 PID/SHA，不得默认拉起生产服务。**
- 任一阶段禁止静默降低原合同的难度。若遇到上游加密隔离使某能力技术上不可能，记录 **UNSUPPORTED / NO-GO + 原始证据 + 可供所有者裁决的替代路线**，不能擅自启用 classic 模式冒充 V2 原生通过。
- 不自动合并 main、不自动发正式版本、不代写所有者审批、不伪造门禁 PASS_REAL。
- **GUI 取证纪律（rev2，所有者偏好）**：禁止把截图回读进模型上下文；用 AT-SPI 无障碍树、网关日志、stats.json 回执、剪贴板文本断言 GUI 状态。截图可脱敏留存供人审阅，AI 不得依赖读图下结论。

## 1. 已确认现状与本轮优先级

### 1.1 已确认的 GitHub 事实（rev2 本机核实）
- origin/main = **886e22a**；原生聚合 PR #7 已合并；**PR #8 仍 Draft**（`fix/modelgate-remediation-20261116` head `5ab1a51`，标注勿合并）；另有 Draft PR #6（聚合 E1–E8，head 64a5c96）、#4（ui-next 预览，head 35bed9b）。gh CLI 已登录 xiaomengxizzh，可直接取证。
- 本机规范克隆 `~/ai/workplace/idproject/model-gateway`（deploy/modelgate-ux-v3 @ 886e22a = main，工作树干净）；另有 4 个旧分支克隆（dev/next/codex-agg/frontend）**不得作为执行基线**。远端 deploy 分支仍在 9a371d3（落后）。工作树约定 `.agents/worktrees/<name>`。
- docs/roadmap/2026-11-16-modelgate-handoff-evening.md 状态 **PARTIAL**，**当前唯一阻断**：官方 GPT 父代理**工具结果续轮** HTTP 400 "No tool call found for function call output"。官方后端 resp id（56 位 hex）从未被登记；6 条 recorded 全是 Go 的 32 位 hex。降级转发按设计工作但官方拒孤儿。交接指定下一步：proxyOfficialResponses 结构日志 → 一次真机单轮取证 → 再修 sink，**禁止盲猜兼容**。
- 台账：A 审计 17 项全修复；B include 400 已修（ae9e23c）；C 终态即登记（e60414d）；D 增量预登记+优雅降级+诊断（e8ed185，未根治）；E=当前阻断；F 非阻断 6 项（含父/子模型分设 API 缺失、重启丢续轮状态）。
- "133 suites / 1289 pass / 0 fail" 是**旧树离线**报告，不代表当前真实验证。真机已证：Go 派单+续轮重建、官方单轮；未过：官方父多轮工具、原生压缩长会话、完整 Desktop 旅程。
- 代码热点（rev2 校准）：src/index.js（proxyOfficialResponses L1984 / proxyNativeResponses L2154 / streamCodexResponse L1864 / streamRawResponses L2311 / Responses 分流 L2960–3098 / 续轮重建降级 L3009–3021）、**src/request.js:267 forward（noRetry 语义在此，不在 forward.js）**、src/responses-continuation.js（capture sink L138–227）、src/responses-ws.js（WS→环回 HTTP→SSE）、src/responses-stream.js（SSE 终态 L297/L629）、src/sse.js（chat 事件看门狗 L374）、src/codex/native-capabilities.js、interop.js、desktop-integration.js、catalog.js、src/ui-next/*。

### 1.2 本机已核实事实（rev2 新增，详见基线快照）
- **ModelGate 服务 inactive (dead)**（8787/8788/8789 无监听）；托盘在跑但只经 systemctl 控制；生产 Node 22.22.2（~/.workbuddy/binaries）。
- **CC Switch 没跑**（15721 无监听），v4.0.27 二进制（dpkg，11/7），无源码工作树；日志最后活动 11/13 刻意 429 注入，无自然断流记录。
- **当前日常路径 = 官方直连**：config.toml（11/17 12:41 改）model=gpt-6-luna、model_provider=openai；[model_providers.custom] 指向死端口 15721；model_catalog_json 指向仓库聚合目录；[features] multi_agent=true；[agents.go_deepseek] config_file=go-deepseek.toml。
- 旧线程素材充足（sessions 454 + archived 113 + 446MB sqlite）。
- **含义**：今天发生的中断不经过任何网关；历史中断需向用户确认时间窗与接管工具（T13-A 第一问）。复现 P0-B 需先启动被测树隔离实例。三路径对照不得复用日常 config 的 custom 段。

### 1.3 阻断顺序（rev2 与补充任务书一致）
**P0-A T13 官方套餐普通对话/Responses 传输可靠性** → P0-B T05 官方父代理工具续轮 400 → P0-C T06 跨供应商 V2 原生任务与密文边界 → P0-D T07 Codex 原生压缩 + same-child resume → P1-D 父/子模型完整 GUI 管理 → P1-E 重启、断流、凭据/目录/回滚与 UX → P1-F 真机长任务、发布冻结。

工程上不能把 P0-C 与 P0-D 当成只需优化兼容字段的普通 BUG：可能牵涉 **Codex 客户端密码学边界或 Provider 继承机制**（#33267 证实 catalog 强制 v2 覆盖 config、跨供应商密文不可解），必须先查真实源码和实验事实。

## 2. 全任务的强制研究门槛（每项代码工作开始之前必过）

每一项任务（T00–T13）都必须留一份独立研究记录，至少覆盖：
1. **本仓库证据**：基线 SHA、实际文件 + 行号、请求/事件流向、字段所有权、状态机、已有测试与失败条件；不能只复述 README。**rev2 已提供 886e22a 行号校准（补充任务书 §3），执行 AI 在不同 SHA 工作时必须重新定位符号。**
2. **原生依赖证据**：与该任务有关的 Codex 当前安装版（0.167.0）及对应源码（tag rust-v0.167.0）/配置 schema；版本、tag/commit、差异、是否属于官方稳定行为；OpenCode Go 实际协议形状。**补充任务书 §2.2 已给出 0.167.0 传输机制核实表，直接引用并复核。**
3. **竞品实现证据**：本地 CC Switch 的对应实现（**本机仅二进制，源码走 v4.0.27 tag**）、上游对应版本的源码及具体调用链；再至少选择 1 个其他独立项目（优先 OpenCodeX），列出做法、前置条件、代价与潜在失效。
4. **论文/社区证据**：相关开源 issue/PR/discussion/论坛复现，以及合适的系统/Agent/协议论文；区分工程已证事实、理论方案、用户报告和无法核实传言。**论文不是每个微型修复都必须找到一篇直接对应文献**，但必须检索并说明是否有可用证据，不能硬凑。
5. **方案取舍**：列出至少三条技术路线（若领域内只有两条可行路线，解释为何第三条不成立），明示对原生性、协议保真、成本、用户体验、维护负担、上游版本漂移的影响，给出选择与被否决原因。
6. **真机验证方案**：与用户实际 GUI/CLI/AgentTeam 操作相同的行为；预期上下游 request ID、response ID、call_id、tool output、thread/child ID、实际模型、SSE/WS 终态、压缩前后上下文。事先定义失败路径及不会掩盖问题的终止条件。
7. **可审查成果**：研究记录、ADR、最小代码 diff、真实重现与修复证据、回滚方案。若真实源不可得，明确标 NOT_OBSERVED，不能猜测后编造行号。

研究记录至少四栏：**问题 → 代码/讨论/论文一手来源 → 已核实行为 → 对 ModelGate 的决策**。每条事实应提供 URL 或本机绝对路径 + tag/SHA + 行号/符号名，关键证据用可复现命令和脱敏日志关联。

### 2.1 "读完源码"的具体定义
不要求机械通读 CC Switch 中与聚合无关的每一行，但对**相关全调用链必须端到端吃透**：
- 从 UI 的操作事件，到数据库/配置持久化、目录生成、模型 ID 映射、子代理配置，再到请求入口、身份路由、Headers、转换、SSE/WS、压缩和回滚；
- 对每条链路绘出调用图和状态图，标出每个条件分支、错误边界、兼容性选择、feature flag、版本检测、线程/模型切换后的状态恢复；
- 对所有与 ModelGate 的 P0/P1 问题相关的 CC Switch commit、issue、测试和真实 release 行为做对照，能解释它**为什么这么写、解决了什么、牺牲了什么、还有什么不能解决**；
- 抽取可独立验证的设计原理，不盲抄源码；记录版权许可证和引入依赖的代价。

任何 Agent 不得声称"研究完 CC Switch"但只给 UI 截图、安装目录文件名或 README 摘要。**本机只有二进制时，必须明确报告"本机无源码"，并以 v4.0.27 tag 源码 + 二进制/配置/日志元数据完成研究，不得声称读了本地不存在的源码。**

## 3. 重点：本机已安装的 CC Switch 源码级逆向研究（T01，必过）

### 3.1 环境、版本与源码归属（rev2 已预取证，执行时复核）
- **已确认**：CC Switch v4.0.27（dpkg deb，/usr/bin/cc-switch，48.6MB Tauri 二进制，2026-11-07 安装，与上游 tag 发布日期一致）；**本机无源码工作树**；~/ai/projects/cc-switch 只有 deb 与解包资源。上游最新 v4.0.33（11/16），本机落后 6 patch。
- **已有研究快照**：`/tmp/ccs427/`（1.8MB，v4.0.27 tag 关键文件选摘：proxy/handlers.rs、proxy/server.rs、proxy/providers/streaming_responses.rs、proxy/providers/streaming_codex_chat.rs、mode/、codex_config.rs、codex_login.rs、live/ 等）。/tmp 可丢弃，用前核对；缺失则按同 tag 重新抓取单文件（raw 读取属允许的研究方式）。整树 shallow clone 需按 RESOURCE_APPROVAL 提交候选申请。
- 数据/密钥只允许只读元数据级核对：~/.cc-switch/cc-switch.db（21.9MB，mtime 11/13）、settings.json、live-state.json、codex-official-models.json、backups/、logs/cc-switch.log（最后 11/13）。**不能把数据库、Key、OAuth 存档或登录会话复制进模型上下文/日志。**
- 线上 main/v4.0.33 的代码不代表用户当前实际运行版；一切对照绑定 v4.0.27 tag。

### 3.2 必须拆解的 CC Switch 机制（rev2 给出源码起点）
A. Direct / Routing / Aggregation 三模式配置生命周期：**v4.0.27 中 Routing 与 Aggregation 共用 Proxy 模式**（mode/state.rs L54 enum Mode{Direct,Proxy}），聚合即 Stack（mode/stack.rs，stack_mode_now L583，模型 ID 前缀 encode/decode L118/163）；mode/controller.rs（9011 行）编排切换，L1185 聚合不做故障转移，L1883 drain_legacy_backup。**契约摘要（sha256）决定客户端文件是否重写**（mode/contract.rs）——代理内换供应商若契约相同只换上游、不动客户端文件。
B. Codex Desktop 与 CLI 探测、连接、model_catalog_json 结构、配置刷新、选择器、前后台生效时序。
C. 统一入口区分官方订阅与第三方路由；模型前缀、空别名、fallback（聚合禁用）、同线程模型切换、用量来源、错误与权限域。
D. Responses → Chat / 原生 Responses：tool call/output ID、空/孤儿工具结果（**#7400→#7196 v4.0.9 PR #8136：孤儿 output 改发带标记用户消息**）、并行 tool_calls（#6449 stale 关闭但代码已有按 index 累积+回归测试）、tool schema（#7459 oneOf 仍 open）、reasoning、input/output 对应。
E. SSE/WS 事件生命周期、终态与 stream 不关闭的处理：**handlers.rs L1060–1074 固定 426 websocket_not_supported**；streaming_responses.rs L4595–4599 终态后传输错误静默 break（PR #8138→v4.0.12）；streaming_codex_chat.rs L801–807 [DONE] 后 return（PR #8281→v4.0.13）；EOF 兜底区分纯文本收尾与 tool/reasoning 截断报 stream_truncated（L4617–4707 / L842–856）；零 usage incomplete 判为上游拒绝（L84）。**没有任何 mid-stream retry/continuation**（#8126 维护者手动关闭，期望未实现）。
F. V2 子任务加密边界与 classic 子工具兼容开关：**真实出处 docs/guides/aggregation-mode-guide-zh.md L158–177 + v4.0.13 release notes（#8253，开关默认打开）**，不在 v4.0.0 release notes（rev1 错误已更正）；跨供应商密文不可解（Encrypted function output content could not be decrypted / unreadable_encrypted_agent_task），classic 明文传任务缺 followup_task/interrupt_agent；[features] multi_agent_v2=true 优先级高于开关。
G. native/local/remote compaction 的模型能力声明、触发与重启恢复；如何避免把密文传到不能解密的 Provider。
H. UI 设置流：父/子模型和 effort 分设、模型不可用禁用提醒、首次体验、错误解释、预览确认、诊断可视化。
I. 安全/可维护性：**官方登录暂存/归还**（codex_login.rs L29 STASH_FILENAME=codex-login-stash.json，0600 不同步；L242 plan()/L323 official()/L181 is_residue 清除残留 Key）；**auth.json+config.toml 原子双写、第二步失败回滚第一步**（codex_config.rs L840 起）；第三方 Key 走 experimental_bearer_token（与本机 config.toml 一致）。
J. 其他隐藏状态：配额耗尽行为、旧配置污染、App/CLI 版本差异、增量配置漂移、本机部署形态限制。

**T01 强制产物**：版本溯源清单、相关模块源码索引（文件、函数、行号，绑定 v4.0.27 tag）、端到端调用图、状态转移图、机制对照表、已知 issue/release 对应清单（补充任务书 §1.0 已给出核实状态表）、ModelGate 可借鉴/不可借鉴决定。最后应能回答"CC Switch 为什么在同类场景能跑，哪里是有损折中，哪里同样不支持"。

**可借鉴（rev2 提炼）**：契约摘要决定客户端文件重写；凭据 stash+残留识别+原子双写回滚；终态后立即停止消费上游、终态后传输错误静默忽略；零 usage incomplete 判为请求拒绝；EOF 兜底区分可收尾与必须报错；孤儿 tool 结果降级为带标记用户消息。**不可借鉴/须自建**：mid-stream retry/continuation（上游空白）、真 WS 转发（#8404 open 无排期）、聚合故障转移（明确不做）。ModelGate 的续轮韧性/增量预登记路线是上游空白，不能以"上游已 closed"当作断流已解决——#2750 跨版本复发史是反例。

## 4. 其它项目、原生源码、论文和社区研究（T02/T03）

### 4.1 优先源码对照（rev2 状态核实）
- **Codex 官方源码和本机 Codex 构建**：openai/codex，**对照 tag rust-v0.167.0**（本机 CLI 0.167.0；Desktop 内置 app-server 版本需另行取证）。补充任务书 §2.2 已核实传输机制（300s 统一 idle、5 次流重试、会话级永久 HTTP fallback、store:false、previous_response_id 增量、x-codex-turn-state、60 分钟 WS 寿命、previous_response_not_found→全量重发、properties_mismatch→全量重发、unbounded_connection_retries）。关注 config schema、agents.default_subagent_model、父子 Provider 继承、multi_agent_v2（**catalog 可强制 v2 覆盖 config，#33267**）、spawn/follow-up/wait/interrupt、turn/resume、remote_compaction（provider 能力 OpenAI/Azure 默认 V2）、加密 agent_message、工具结果 ID 配对。
- **CC Switch 上游**：farion1231/cc-switch，**对照 tag v4.0.27**（§3）。classic 子工具是跨供应商解密失败的有损兼容，**绝不允许直接抄作本项目完成方案**。
- **OpenCodeX**：lidge-jun/opencodex（默认分支 dev，18.6k star，push 2026-11-16，高度活跃）。**#3978 已 closed**：作者经 PR #4092（8213fada0）实现"保留 V2 路由同时 opt-in 客户端 compaction"，直接涉及加密 task 传递（`ocx1:` 密文）与 remote compaction 边界——**这是 T06/T07 最有希望的原生参照，优先精读该 PR diff**。另有 WS 相关 open PR #8801/#8816。研究 provider 前缀命名、单目录多模型、Codex 本地压缩偏好、加密 task passthrough、session pinning、恢复/迁移、客户端版本检测。
- **CLIProxyAPI**：router-for-me/CLIProxyAPI（58.8k star，push 2026-11-17，极活跃）。把 ChatGPT Codex 等包装成兼容 API；Codex WS 直接相关 open issue：**#6567（OAuth 默认走 WS）、#7088（HTTP 下游经 WS executor）、#4924（WS continuation 契约测试）**——上游 WS 代理与续传契约的现成讨论。重点官方账号认证/配额/路由、请求身份域、安全与原生 Codex 客户端接入；不能把开放通用 API 自动等同于原生 AgentTeam 兼容。
- **LiteLLM Gateway**：BerriAI/litellm；参考模型编排、预算、回退、请求路由、配额账本、provider 错误归因（docs/routing、docs/proxy/reliability、docs/proxy/users 已核实可达），但其面向通用 API 的设计不能替代 Codex 原生任务语义。
- 如发现更接近的项目（需先核实许可证、维护时间和真实行为），按"相关程度、源码可查、近期实测、核心技术差异"纳入，不为堆数量走过场。

### 4.2 论文维度（rev2 全部核实真实存在，禁止空泛堆文献）
- When Messages Go Wrong: Understanding Communication Faults in LLM-Based Multi-Agent Systems，arXiv:2610.15459（**已核实**；消息缺失、延迟、上下文过期、传播与检测）；对应续轮与中断恢复。
- A Technical Taxonomy of LLM Agent Communication Protocols，arXiv:2606.19135（**已核实**；payload、交互状态、发现与 schema）；对应跨供应商边界与状态归属。
- AgentWorld: Benchmarking Long-Horizon Collaboration of Multi-agent LLMs，arXiv:2609.31590（**已核实**；长周期协作和因果贡献）；对应真实长任务验收设计。
- A Survey of AI Agent Protocols，arXiv:2504.16736（**已核实**；协议层次、安全与互操作）；对应非 MCP 的原生代理方案边界。
- **rev2 新增更直接候选**：Why Do Multi-Agent LLM Systems Fail?（MAST 故障分类学），arXiv:2503.13657（**已核实**）——直接对应多代理通信故障分类；Andes: Quality-of-Experience in LLM-Based Text Streaming Services，arXiv:2404.16283（**已核实**）——LLM 流式传输 QoE/可靠性，对应 T13 首事件/idle/用户体验指标。
- 可扩展 context management、distributed systems replay、at-most-once、event sourcing、property-based testing 等真正对方案有帮助的论文。对每篇总结"对应哪条工程难题、可验证假说、不能直接推断的点"，不把论文类比误写成已经实现。

### 4.3 社区证据（rev2 状态已核实，必须交叉审阅）
- CC Switch：#7400→#7196（v4.0.9 孤儿 output 修复）、#6449（stale 自动关，代码已改善）、#7459（oneOf 仍 open）、#1673（426）、#2750（closed 但跨版本复发）、#4535（截断检测）、#5920→#3566（v4.0.0 凭据重写）、#8126（手动关闭，retry 未实现）、PR #8281/#8138（终态边界）、#8404（真 WS open）。完整状态表见补充任务书 §1.0。
- Codex：**#20739/#23807/#32366/#36059/#44099/#51886/#33267 全部 open，无官方修复**（补充任务书 §2.1）。#23807 机制在 0.167.0 原样存在；#51886 是服务端 900s 时限；#33267 证实 catalog 强制 v2 + 跨供应商密文不可解。OpenCodeX #3978 已 closed（PR #4092）。
- GitHub Issues/PR/Discussions、官方文档、开发者论坛、Reddit 的 firsthand reproduction；记录版本、时间、环境、复现与反例，不能以单个帖子断言所有环境。
- 优先近版本、关闭且有修复提交与测试的 issue；未解决讨论作为线索而不是设计定论。**引用 closed issue 必须核对 state_reason 与关闭后复发评论。**

### 4.4 技术路线矩阵（必须填实证，不得先写赢家）
至少比较：（1）单统一 Provider + ModelGate 模型分流；（2）独立父/子 Provider 配置（若 Codex 当前版本不支持，明确限制）；（3）Codex 原生版本修补/扩展或上游 issue/PR 路线；（4）CC Switch classic 兼容路线**仅用作有损对照，不可替代目标**；（5）**rev2 新增：OpenCodeX ocx1: 密文 passthrough + opt-in 客户端压缩路线（PR #4092）**，评估其原生性与许可证。
维度：Codex 原生 AgentTeam、跨供应商任务可读性、V2 密文边界、same-child followup/interrupt、原生压缩、Desktop 配置、账号保护、性能/成本、变更风险、长期维护与真实验收结果。
传输层另比较：（a）客户端 WS→环回 HTTP/SSE（现状）；（b）426 回退 HTTP/SSE（cc-switch 路线）；（c）端到端上游 WS/WSS 代理（#8404/CLIProxyAPI #6567/#7088 需求）；（d）官方直连保持原生 + 第三方走本地路由。由 T13 ADR 裁决，不预设赢家。

## 5. 具体执行任务与每项研究/验收要求

> T00–T13 每项都继承第 2 节的研究门槛。任务负责人必须填写"研究充分/研究未完成"的可验证证据，不能因进度赶而跳过。
> 可并行研究，但**共享源码写集与主干集成、生产部署和发布冻结必须串行**。

| ID | 优先级 | 目标 / 研究重点 | 主线交付 | **真实验收（至少）** |
| --- | --- | --- | --- | --- |
| T00 | P0 | 基线、环境与授权盘点；**复核 rev2 基线快照**；重算 main/PR/部署 SHA；调查现有实机日志/端口/配置差异 | baseline、权限表、故障时间线、研究追踪台账 | 以只读方式验证真实安装/进程/版本；不对真实模型做无意义"你好"探针 |
| T01 | P0 | **本机 CC Switch（v4.0.27 二进制 + tag 源码）完整相关链路**，配合真实运行版与上游对照 | CC Switch source atlas、调用图、差异矩阵、ADR 候选 | 真实 CC Switch 同场景有限 A/B 观察（不覆盖原配置、不私改账户），附版本和脱敏收据 |
| T02 | P0 | 本机 Codex 0.167.0 原生 Harness / OpenCode Go 协议、V2 密文与 Provider 继承 | Codex/OpenCode 行号级源码研究、可行性边界 | 用真实 CLI/Desktop 观察 model/provider、spawn/subagent 工具和事件实际形状 |
| T03 | P0 | OpenCodeX（PR #4092 优先）、CLIProxyAPI、LiteLLM、论文与社区失败模式 | 技术路线矩阵、引用索引、明确取舍 | 对最有希望方案先做针对真实故障的小规模对照，不能拿模拟通过代替最终结论 |
| T04 | P0 | 统一路由、续轮与状态 ownership 架构 ADR；明确哪些机制必须忠于 Codex（store:false、previous_response_id、x-codex-turn-state、properties_mismatch） | 协议不变量、状态机、错误树、无损边界 | 真实客户端可复现序列和可对照收据；不能只跑协议单元测试 |
| T05 | P0 | **官方 GPT 父代理工具续轮 400**：capture sink、JSON/SSE、responseId 对齐、原子终态登记、真正的 call/output 配对 | 根因最小证据 + 有限 diff + 确认无损的捕获/重建 | 原版 Codex gpt-6-luna，真实工具执行→后续工具结果→至少 3 个连续轮次，上一轮 responseId 和 callId 可追踪，0 上游 400 |
| T06 | P0 | **跨供应商原生 V2 子任务**：加密任务、provider 继承、same-child followup/interrupt；探索可行原生修复边界（含 OpenCodeX ocx1: 路线评估） | 可行性 ADR、真实交互端到端、若不可行则 NO-GO | GPT-6 Luna 父→Go DeepSeek 子，原生 spawn/wait/follow-up/interrupt、任务正文可达、产物回父、同一 child ID |
| T07 | P0 | **Codex 自有原生 compaction**：local vs remote、provider 元数据（remote_compaction 能力默认 V2）、真正触发和续轮 | 选择/配置方案与不引入自建压缩的源码/日志证明 | 真实长会话发生 Codex 原生压缩，前后 same-child、保留工具与关键上下文、继续完成代码任务 |
| T08 | P1 | **真实 GUI 用户旅程**：父子模型独立设置、effort、发现、聚合开关、目录/选择器、备份/退出 | 统一状态管理与原版 Desktop 端到端、无需手改 TOML | GUI 点击激活→真实 Desktop 新会话模型选择→父子运行→关闭恢复，用户能理解错误，不出现僵尸配置 |
| T09 | P1 | 账号/额度/域隔离、注入、429/403、模型/凭据精确路由、双实例分发 | 身份权限 ADR、真实请求账本与脱敏验证 | 官方与 Go 请求实际目标/模型/凭据域一致，错误不自动换官方，重启/并发下不串线 |
| T10 | P1 | Responses WS/SSE 生命周期、中断取消、状态缓存过期/重启、备份和版本升级 | 原生事件/状态完整性，恢复和退出策略 | 真实 SSE 完成但不关流、客户端中断、网关重启后明确恢复或失败、无重复工具派单或丢结果 |
| T11 | P1 | **用户真实开发任务验收**：跨文件代码修改、工具和子代理长链、回滚、错误诊断/易用性 | E2E task receipts、体验问题台账 | 真实项目至少一个完整编码任务，运行中需要子代理、实际工具和多轮会话，用户视角可完成并解释每一步 |
| T12 | P1 | 集成、回归、文档/支持矩阵、独立 QA、发布冻结 | 冻结 SHA + 真机验收矩阵 + 最终报告 + 可复现回滚 | 同一冻结树上核心场景真实 PASS_REAL；未通过的每项显式阻止发布 |
| T13 | **P0-A** | **官方套餐普通对话连续性与 Responses 传输可靠性**；direct/CC Switch/ModelGate 三路径基线、故障分类、超时分层、安全重试边界 | 本机路由溯源、传输调用图、故障分类、脱敏诊断、竞品/官方源码研究、ADR（详见补充任务书） | 同主机/账号/网络三路径受控真实对照；覆盖旧/新线程、长任务、首事件、SSE terminal、WS ping/pong、错误恢复；不得用 1+1 冒充 |

### 5.1 T05 真正的根因实验，不要继续盲修（rev2 绑定源码）
现有报错关键事实：真实官方订阅响应无 recorded（56 位 hex id 从未登记）；Go response recorded/reconstructed 正常（32 位 hex）；官方 SSE completed 后不关流。sink 已支持嵌套 obj.response.id 与顶层 obj.id 两种形状（responses-continuation.js:160–165），因此根因收窄为四个假说（补充任务书 §3.7）：
- H1：官方 SSE 信封与 feedSse 解析不匹配（content-type 误判、data 多行/前缀、事件名不在 response.* 族）→ 根本没进 applyEvent；
- H2：官方路径该请求没挂 captureSink（continuation 为 null 的分支条件）；
- H3：id 在第三种位置（嵌套层级不同）；
- H4：登记成功但 cache key/prevId/thread 不一致导致 lookup 失败。

**先在 proxyOfficialResponses（index.js:1984）上游成功边界添加只记录元数据的结构诊断**（补充任务书 §4.6 补丁⑦）：HTTP content-type、首个成功解析 data JSON 的键名列表、response ID 所在层级、终态类型、向 Codex 发出的 ID、store 记录时序（不可记内容、Token、原始输入输出）。按一次真实父代理带工具单轮取证区分 H1–H4，再修 sink：
- 如果官方未被解析：纠正实际 JSON/SSE 包装，测试事件拆包、data 多行、BOM、注释与无 EOF；
- 如果已解析却无登记：纠正 created/output_item.done/completed 的时序与 sink 生命周期；
- 如果已登记但找不到：检查 response ID 一致性、cache key、prevId、thread ID、provider/模型切换以及并发竞态；
- 如果工具仍孤儿：检查完整 input + 真实 function_call/output 的关联，区分由 Codex 注入的特殊孤儿和本该匹配的官方上一轮真实调用。**不允许为修补 400 伪造原官方 call 或删除工具历史。**
每个假说用日志证据排除；修复后真实三轮以上复现 + 失败案例。同时修复 snapshot() 未见终态默认 completed 的误登记风险（responses-continuation.js:196，补充任务书 §4.6 补丁⑥），但不得在无证据时改动登记语义。

### 5.2 T06/T07 原生兼容性困难的真实结论机制（rev2 更新证据）
若 Codex V2 的 encrypted agent_message / reasoning 以供应商密钥绑定，任何通用代理都不能无损解密。**#33267 已证实：catalog 强制 multi_agent_v2 时 config 关闭无效；自建 Responses 代理下 GPT 子代理必败、非 GPT 成功（跨供应商密文不可解）。** 必须在源码及真实事件中证明可行的**原生**替代路径或如实写技术 NO-GO。优先评估 OpenCodeX PR #4092 的 ocx1: 密文 passthrough + opt-in 客户端压缩路线（#3978 已 closed）：它是否保持 V2 原生语义、许可证是否允许借鉴、对 ModelGate 的适配代价。classic 工具只作为竞品妥协对照（cc-switch 聚合指南 L158–177 / v4.0.13 #8253）。可提交上游兼容性 PR/Issue 的研究建议，但不得偷偷引入 forked Codex 替换用户官方 Desktop。
压缩问题需真实证明是 Codex 决定/执行；研究 remote_compaction provider 级能力（OpenAI/Azure 默认 V2）与 unified provider 的冲突，不能靠"增大 context_window"回避。若触发成本很高，先提交预计请求/额度与最小复现方案，执行得到预算授权后再做，而不是假称已过。

## 6. 真实测试策略：替换无效冒烟测试

### 6.1 什么**不算**验收
- 单次 GET /healthz、浏览器页面能打开、模型列表出现、API Key 返回 200；
- "你好/1+1"单轮回答、一个简单 shell 成功；
- mock/fixture/静态截图/测试套件全绿、历史其他 SHA 的 PASS_REAL；
- 单次 spawn 成功但没有子任务正文、工具结果回父与 same-child 恢复；
- 通过关闭 multi_agent_v2、关掉压缩、替换 GPT/Go 模型、删历史、断开原生工具、**设 supports_websockets=false 或调大 stream_idle_timeout_ms** 以换取 200。

上述检查可作为**极简安全前置检查**，不得投入反复测试周期，更不可计作用户验收。**诊断性单变量 A/B（如隔离 profile 临时 supports_websockets=false）允许用于归因，但不得作为最终验收配置。**

### 6.2 真实验证基础
- 执行环境优先用户真实 **Linux KDE Plasma + 原版 Codex Desktop（ChatGPT 桌面内置）+ Codex CLI 0.167.0 + 本地 ModelGate + 既有 CC Switch v4.0.27（竞品对照）**；同步记录版本、实际进程、SHA、真实模型、Provider、协议、UI 是否重启生效、**实际生效代理变量**。
- 用用户通常会做的中等复杂度开发任务：阅读已有代码→父代理拆解→Go 子代理实际检查与修改若干文件→工具执行→父代理等待/汇总→用户追问→同子继续→适当中断/恢复→更长上下文触发 Codex 原生 compaction→任务完成。真实工作区只在受控、可回滚的工作树内执行。
- 在合理预算内优先针对 P0 故障进行**有诊断价值的真实多轮**；没有真实证据就记 BLOCKED/NOT_RUN。
- 配置两条对照：真实 Codex 直连/现有 CC Switch 聚合（只读或经许可的隔离 profile）与 ModelGate，尽量保持同版本 Codex、相同任务和可比较的模型/额度；**当竞品使用 classic 有损退路时必须标注**。三路径切换的具体操作规程见补充任务书 §5.1（隔离 CODEX_HOME、-c 单次覆盖、MG_CONFIG_DIR 隔离网关、CC Switch 写入授权与字节级回滚）。
- 测试记录：冻结 commit、binary/version、时间、模型/Provider、请求计数/费用、真实上下游目标、traceId、threadId、childId、responseId、callId、工具 exit code、压缩事件、终态、**脱敏 errno/code/首事件延迟/事件计数**、中断恢复/回滚结果、失败原始错误类别。GUI 证据用 AT-SPI/日志/回执，不读图。
- 每个 P0 修复至少具有真实故障复现（red）、新实现真实通过（green）、真实回归。如果问题具有随机性，以足够的独立真实回合验证稳定性，说明样本数，不作"100% 可靠"空口承诺。
- 可保留快而确定的离线回归作代码保护（**T13 必须补的 6 项离线回归见补充任务书 §3.9**）；优先级与时间预算以实机真实 E2E 为主。单元通过不是门禁豁免。
- 真实 UI 使用体验是独立门禁；没有原版 Desktop 操作的所谓"UI 已完成"必须标为 PARTIAL。

### 6.3 真实场景最低矩阵
R01 官方 GPT 多轮工具 call/output 无 400；R02 GPT 父→Go 子原生派单且子确实收到任务；R03 同一 child 追派两次且记住先前上下文；R04 wait/interrupt 后恢复且无双终态；R05 Go 子实际修改受控代码并回传父；R06 原生 compaction 真触发并同子续轮；R07 Desktop GUI 一键聚合、目录、模型选择/effort/回滚无手改；R08 官方 auth 与 Go Key 不交叉、429/401 不暗转；R09 网关/客户端重启后明确恢复/可解释失败；R10 CC Switch 对照与来源链；R11 一次真实多文件开发任务完整交付；R12 冻结 SHA + 配置/凭据回滚与发布审批。
**R13–R20 传输可靠性矩阵见补充任务书 §5**（direct 基线/ModelGate/CC Switch/长任务/旧新线程/无工具与有工具/WS 长连接/故障恢复）。
逐项记录 PASS_REAL / FAIL_REAL / PASS_MOCK / NOT_RUN / BLOCKED；**只有 PASS_REAL 才满足最终现实产品验收**。

### 6.4 真机预算 / 权限 / 风险节流
- 每批真实测试前出示剩余额度、批准上限与 stop conditions，按真实性、阻断解决价值和成本排序；禁止用海量无效探针换信心。
- 所有 GPT 请求只允许 gpt-6-luna；Go 模型固定 deepseek-v4.1-flash；模型别名不得绕开请求级模型核验。
- 可选择隔离 CODEX_HOME/临时 profile；如真实体验必须在原版 Desktop 的现有配置测试，则先申请该范围的真实写入许可与回滚验证。
- 模型请求异常时记录一份原始脱敏信封的结构和事件时间线；避免反复重试同一未归因 400。每一次真实复测必须能证伪一个假说。
- 如果无法取得某项真实环境/收费授权，停在该项并继续其他只读研究与无费工作；成果记阻断与准确下一步，绝不可自动降级验收。

## 7. 分工、交付结构与里程碑

### 7.1 AgentTeam：主代理 + 最多五个子代理（rev2 与启动提示词一致）
- **主代理**：整体架构、冲突裁决、共享代码集成、预算权限、最终冻结与用户汇报；所有真实 GPT 父模型强制 gpt-6-luna。
- **A1 CC Switch 源码研究员**：T01，本机 v4.0.27 二进制/元数据 + tag 源码（/tmp/ccs427 优先）+ 问题链，默认只读，不修改 CC Switch。
- **A2 Codex/Go 原生协议研究员**：T02/T06/T07/T13-B；rust-v0.167.0 源码、协议与密文边界、压缩能力、上游 Issue（补充任务书 §2.2 为起点）。
- **A3 跨项目/论文/论坛研究员**：T03/T04；OpenCodeX PR #4092、CLIProxyAPI WS issues、LiteLLM、学术与社区证据矩阵。
- **A4 网关实现工程师**：T05/T09/T10/T13-F；仅在已完成研究/ADR 后进入其独立文件写集，修复最小根因（补充任务书 §4.6 补丁规格为起点）。
- **A5 独立真实 E2E QA + UX**：T08/T11/T12/T13 测试矩阵；实际 Codex Desktop 工作流、三路径对照、失败追踪、反降级与冻结审计，不用 mock 冒充真实。

任务实际分工可动态微调，但主/子数量、独立 worktree、互斥写集、独立 QA 审查与所有者审批不可取消。共享 src/index.js、config.toml 生成器、catalog 和发布脚本必须由单一集成者按依赖顺序提交。**启动顺序：G0 复核后，A1–A5 并行启动（T01 与 T13 同时）；完成 G0.5 之前不得大规模改写代理传输层。**

### 7.2 必需的交付物（开发者须落盘，已有文件先复用）
- docs/evidence/modelgate-local-baseline-20261117.md（**rev2 已预置 G0 快照**）
- docs/research/modelgate-ccswitch-local-source-atlas-20261116.md（T01 atlas，绑定 v4.0.27 tag）
- docs/research/modelgate-codex-opencode-protocol-20261116.md（T02，绑定 rust-v0.167.0）
- docs/research/modelgate-competitors-papers-community-20261116.md（T03/T04）
- docs/research/modelgate-stream-interruption-reliability-20261117.md（**T13 研究记录，rev2 已预置源码审计；执行 AI 续写运行时证据/ADR/收据**）
- docs/architecture/adr-modelgate-native-cross-provider-v2.md（T06）
- docs/architecture/adr-modelgate-transport-reliability.md（**T13 传输 ADR，rev2 新增**）
- docs/evidence/modelgate-live-root-cause-20261116.md（T05）
- docs/evidence/modelgate-live-user-journey-20261116.md（T08/T11）
- docs/evidence/modelgate-acceptance-matrix-latest.md（R01–R20）
- docs/roadmap/modelgate-execution-progress.md（进度台账）

文档要有**百分比进度**，但进度只按有审查证据的已完成任务权重核算（例：Research 0/4、P0 0/4、UX 0/2、E2E 0/3）；不得凭主观观感写 90%。必须额外显示**真实验收比例**，与代码完成率分开。每次会话中断都要能从最新 SHA 和记录恢复。

### 7.3 阶段闭环（阶段闸门）
G0 环境/版本/源定位（**复核 rev2 快照**）→ **G0.5 普通官方对话 direct/CC Switch/ModelGate 传输基线 + 故障分类 + T13 研究方案** → G1 CC Switch/原生源码/竞品/文献研究与技术路线决策 → G2 官方多轮续轮实机修复（T05）+ 传输可靠性修复（T13-F）→ G3 原生跨供应商 AgentTeam & Codex compaction 真实可行性与实施 → G4 一键 GUI/父子配置与安全/恢复 → G5 真实长任务开发体验 → G6 独立 QA、同树冻结、批准后发布。
任何阶段如果关键研究证据不够，优先继续研究而非先写一堆补丁；若"技术不可能"的证明成立，交付 NO-GO 和裁决方案，保留目标，不静默改合同。每个阶段给一份下一阶段可直接执行的任务清单/启动状态，并注明剩余预算、实际障碍和回滚点。

## 8. 关键行为伪代码 / 不变量（设计示意）

> rev2 注：本节是协议不变量示意；**绑定实际源码行号的最小补丁规格见补充任务书 §4.6**（catch 保留 errno、pipeline 终态退出、finish() abort、pong deadline、事件看门狗、snapshot 守卫、官方结构诊断）。实现人员必须用真实源码修正示意，尤其状态缺失策略不能机械照抄为一律拒绝。

    on_codex_request(request):
        assert user-authorized local configuration and exact target
        owner = resolve_request_owner(request.model, request.thread)
        assert owner in {"official-chatgpt-subscription", "opencode-go-deepseek"}
        assert no cross-domain auth headers or fallback model rewriting
        # Codex 原生语义（rust-v0.167.0 核实）：HTTP 恒 store:false；WS 增量靠 previous_response_id
        # + x-codex-turn-state；model/tools/store/service_tier 变化 → 客户端全量重发

        if request.previous_response_id exists:
            previous = continuation_store.lookup_exact(request.previous_response_id)
            if previous missing:
                record_typed_failure_with_trace()
                # e8ed185 降级：degraded=true + 剔除 prev_id；注意客户端可能因此全量重发，评估副作用
                stop_or_use_a_proven_native_safe_resume_path()
            else:
                request.input = faithful_concat(previous.actual_input, previous.actual_output, request.delta)
                preserve_call_output_pairing_and_encrypted_payload_ownership()
                remove_only_unsupported_wire_field_with_logged_reason()

        response = forward_to_frozen_target(request)   # forward = src/request.js:267
        for each actual event from response:
            parse_actual_upstream_envelope_version_aware()
            record_real_response_id_and_tool_items_before_codex_can_continue()  # 终态即登记，不等流结束
            forward_preserving_protocol_meaning()
        on terminal:
            atomically_commit_trace_and_actual_response_items()
            record_single_terminal_even_if_transport_keeps_open()
            release_internal_stream_and_abort_loopback()   # 官方 completed 后不关流，必须主动释放
        # 截断/半死流：事件级看门狗超时 → 如实 incomplete/failed（保留部分输出），绝不伪造 completed
        # when a provider truly cannot support V2 encryption/compaction:
        # return explicit unsupported; don't synthesize decrypted content or mock success.

    approve_task(task_id):
        require_local_source_research + official_source_research + cross_project_matrix
        require_credible_issue_or_paper_scan + ADR + test_red_case
        do_minimal_patch()
        run_targeted_offline_regression_as_fast_guardrail()
        run_authorized_real_codex_desktop_or_cli_e2e()
        qa_independently_check_trace_and_user_visible_outcome()
        mark PASS_REAL only when frozen_sha_and_real_target_evidence_match()

## 9. 交接资料与研究起点（rev2 状态核实）

### ModelGate 本仓库（本机路径 + GitHub）
- 规范克隆：`~/ai/workplace/idproject/model-gateway`（deploy/modelgate-ux-v3 @ 886e22a = main）
- 本机基线快照：docs/evidence/modelgate-local-baseline-20261117.md
- 晚间交接（当前唯一阻断）：docs/roadmap/2026-11-16-modelgate-handoff-evening.md
- V2 不可降级需求：docs/product/2026-11-14-owner-scope-v2.md
- 修复审计与材料索引：docs/roadmap/2026-11-16-modelgate-remediation-audit-and-start.md
- 操作手册：docs/how-to/{testing,desktop-acceptance,deploy-and-rollback,codex-multi-provider}.md
- 源码：src/index.js、src/request.js（forward）、src/responses-continuation.js、src/responses-ws.js、src/responses-stream.js、src/sse.js
- PR #8（Draft，勿合并）：https://github.com/xiaomengxizzh/model-gate/pull/8

### 官方源码与可参考实现
- CC Switch 仓库（对照 tag v4.0.27）：https://github.com/farion1231/cc-switch/tree/v4.0.27
- CC Switch 聚合机制（classic 妥协真实出处）：docs/guides/aggregation-mode-guide-zh.md L158–177 + v4.0.13 release notes
- OpenCodeX（dev 分支，PR #4092 优先）：https://github.com/lidge-jun/opencodex
- Codex 官方源（对照 tag rust-v0.167.0）：https://github.com/openai/codex/tree/rust-v0.167.0
- CLIProxyAPI：https://github.com/router-for-me/CLIProxyAPI
- LiteLLM：https://docs.litellm.ai/docs/routing 、/docs/proxy/reliability

### 值得直接研究的故障和论文（状态见补充任务书 §1.0/§2.1）
- CC Switch #7196（孤儿 output 修复）、#8126/#8281/#8138（终态边界）、#8404（真 WS open）、#2750（复发反例）
- Codex #33267（V2 密文）、#23807（300s idle）、#32366（旧线程 HTTP 200 无事件）、#51886（900s 服务端截断）
- OpenCodeX #3978（closed，PR #4092）
- 论文：arXiv:2610.15459、2606.19135、2609.31590、2504.16736、2503.13657（MAST）、2404.16283（Andes）

以上只是**起始必查索引，不是调研结果已经完成的证明**。rev2 已核实版本/状态/行号；运行时行为、本机源码路径及竞品真实 A/B 结果必须由后续执行代理在用户主机获得证据后填写。

## 10. 完工定义

只有用户在**原版 Codex Desktop + ModelGate GUI** 中，不经任何手工协议补丁完成以下场景，才能声明真正完成：保留官方套餐登录、选择 GPT-6 Luna 父代理和 Go DeepSeek 子代理、可靠多轮工具执行、原生派单/同子追派/等待/中断/恢复、真实 Codex 原生压缩后的同子连续工作、复杂开发任务完成、出错可诊断且不会静默换模型、退出恢复原环境。**普通官方对话（无工具、无子代理）也必须连续稳定（T13）。** 上述每一环具有同一最终冻结 SHA 上的真实证据，安全、授权与最终所有者审批通过。

未完成任何一环，诚实报告 PARTIAL / BLOCKED / NO-GO，保持交付能力与用户目标的区别。禁止在失去关键原生功能的前提下宣布完成。

## 11. 2026-11-17 P0 增补：ChatGPT 官方套餐普通对话断流与传输可靠性

> **本节优先级高于原 1.2、6.2、6.3 的旧顺序；详细研究范围、公开证据、诊断方法、补丁规格和验收矩阵见 [补充任务书 rev2](../research/modelgate-stream-interruption-reliability-20261117.md)。**

用户新增报告：即使仅使用 ChatGPT 官方套餐模型普通对话，也可能无故中断/停滞；类似现象曾在旧版 CC Switch 出现。该问题独立于 DeepSeek 子代理和工具续轮，必须提升为 P0。不得预设它是 ModelGate、CC Switch 或 OpenAI 单方问题。

### 11.1 已核实的外部证据（rev2 摘要）
- CC Switch 修复全部是检测截断 + 终态边界 + 426 回退，**无 mid-stream retry/continuation**（#8126 手动关闭、#8281 明确拒绝实现）；真 WS 代理 #8404 open 无排期；#2750 closed 后跨版本复发。
- Codex 7 个断流相关 issue 全部 open 无官方修复；0.167.0 源码证实 300s 统一 idle timeout（含首事件）+ 5 次流重试 + 会话级永久 WS→HTTP 降级（最坏 25 分钟停顿）；#51886 是服务端 900s 截断。
- **本机当前日常路径是官方直连，两个网关都停**——direct 路径本身即可发生数分钟停顿，不能预设网关是根因。

### 11.2 ModelGate 传输架构审计结论（rev2 摘要，详见补充任务书 §3）
- WS 桥 = Client WS → 环回 HTTP POST → 上游 SSE → Client WS，非端到端 WS；60s Ping 无 pong deadline。
- noRetry:true 禁用发送级重试（request.js:274）；流中途重试 native 路径本不存在。
- streamCodexResponse catch 未绑定 err、零日志（index.js:1893）；streamRawResponses pipeline 吞 err、无终态提前退出（index.js:2348/2350）。
- **native 路径无事件级看门狗 + overallMs=0 + finish() 不 abort 环回 → 半死流可无限悬挂（静默停滞头号假说 N5/N1/N2）。**
- 续轮 sink 未见终态默认 completed（responses-continuation.js:196）、合成 failed 缺 id/error（responses-ws.js:436）等 7 项额外风险。

### 11.3 T13 与阶段/矩阵修订
T13（P0-A）子任务 T13-A…F、故障分类、超时分层、安全重试边界、最小补丁规格见补充任务书 §4；R13–R20 见 §5；三路径操作规程见 §5.1。新增阶段 G0.5（§7.3）。新 P0 顺序：T13 → T05 → T06 → T07。

### 11.4 启动指令
执行 AI 使用独立启动提示词 [2026-11-17-modelgate-deep-research-start-prompt.md](2026-11-17-modelgate-deep-research-start-prompt.md)。G0 复核后并行启动 A1–A5；完成 G0.5 之前不得直接大规模改写代理传输层。任何未能真实复现或未能取得证据的项标 NOT_RUN/BLOCKED，不得猜测归因。

## 12. G0 / G0.5 可执行清单（rev2 新增，本机校准）

### 12.1 G0：复核基线（只读，≤30 分钟，不重复盘点）
```bash
# 1. 复核基线快照 §9 的全部命令（仓库 SHA/服务/端口/版本/配置结构/PR）
# 2. 读三份文件：
#    docs/evidence/modelgate-local-baseline-20261117.md（本机事实）
#    docs/research/modelgate-stream-interruption-reliability-20261117.md（源码审计+上游机制）
#    docs/roadmap/2026-11-16-modelgate-handoff-evening.md（当前唯一阻断）
# 3. 读 AGENTS.md / RESOURCE_APPROVAL.md / docs/product/2026-11-14-owner-scope-v2.md
# 4. 核对 /tmp/ccs427 快照是否存在；缺失则按 v4.0.27 tag 重新抓取关键单文件
# 5. 向用户确认：中断时间窗、当时客户端/接管工具/模型、本轮真实测试预算上限
# 6. 输出：基线复核差异表 + 权限/预算表 + 研究追踪台账（docs/roadmap/modelgate-execution-progress.md）
```
G0 产出必须明确：当前日常路径、网关/CC Switch 运行状态、被测树 SHA、可用隔离端口、已授权与待授权事项。**不得在 G0 启动生产服务或发起付费请求。**

### 12.2 G0.5：三路径传输基线（研究先行，付费需授权）
1. **A2 补齐 direct 段调用图**：基于补充任务书 §2.2 的 0.167.0 机制，绘制 Codex→wss://chatgpt.com/backend-api/codex/responses 的握手/ping/idle/重试/fallback/续轮状态机；取证本机 Desktop 内置 app-server 版本。
2. **A1 补齐 CC Switch 段**：v4.0.27 的 426→HTTP/SSE 行为（§1.1）、三模式凭据生命周期（§1.5）；本机二进制/配置元数据取证。
3. **A4 补齐 ModelGate 段**：补充任务书 §3.1 调用链已核实；取证生产配置有效 timeout 值（只读结构）、官方 completed 后 keepalive 行为（需隔离实例+授权真实单轮）。
4. **A5 制定对照方案**：按补充任务书 §5.1 操作规程准备三路径隔离环境；R13–R20 收据模板；预算申请（请求/时长/费用三重上限）。
5. **故障分类台账**：按补充任务书 §4 T13-C 的分类，把用户历史报告与本机日志逐条归类；无法归类的标 UNCLASSIFIED 待取证。
6. **第一批假说**（已有源码支撑，待运行时证实）：
   - H-A（静默停滞）：native 路径无事件看门狗 + keepalive 喂活字节 idle + overallMs=0（N5/N2）；
   - H-B（资源泄漏）：finish() 不 abort + raw pipeline 无终态退出（N1/N3）；
   - H-C（续轮 400）：官方 id 未登记 H1–H4（§5.1）；
   - H-D（direct 停顿）：客户端 300s idle + 5 次重试 + 服务端 900s 截断（§2.2/§2.3），与网关无关；
   - H-E（假完成）：snapshot 默认 completed / 纯 JSON 合成 completed（N4/N7）。
7. **G0.5 闸门**：三路径调用图 + 故障分类 + 假说清单 + 对照方案 + 预算边界齐备后，才进入 G1/G2 代码修改。**每个假说必须绑定一个可证伪的真实/离线实验。**

### 12.3 执行纪律（每轮报告）
每轮报告必须提供：研究完成率、代码完成率、真实验收完成率（三者分开）、本机 CC Switch 研究进度、三路径对照结果、已证实问题与待验证假说、当前阻断及费用、下一阶段实际执行任务。所有成果持续写入 GitHub 文档分支，保持版本、证据和真实运行状态一致。**不自动合并 main、不自动发布、不代填审批。**