# A3 · 跨项目/论文/社区研究交付：传输层技术路线矩阵（G0.5，只读研究）

> 作者：A3（跨项目/论文/社区研究员）. 日期：2026-11-17. 基准：main `886e22a863343192e4ae5ab41e38396df4d4813c`.
> 裁决口径（team-lead 权威）：唯一已证实阻断 = P0-B/T05（官方工具续轮 400，经 8787 网关）；P0-A/T13 为研究+验收目标。
> 状态枚举：PASS_REAL / FAIL_REAL / PASS_MOCK / NOT_RUN / BLOCKED。本文所有结论均为**只读研究**，未改任何共享/生产文件。
> 硬约束遵守：未读取/打印/提交任何密钥、Token、auth.json 内容；只留脱敏元数据；未安装依赖、未整树 clone、未臆造 URL（所有 URL 来自检索结果或已提供线索）。

---

## 0. 一句话结论

跨供应商密文不可解不是 ModelGate 一家的 bug，而是上游未修复的协议事实（OpenCodeX #92 `closed/not_planned`；OpenAI Codex #33267 全 open 无官方修复，9/9 复现）。工业界共识是：**不解密、不伪造、不静默丢弃**——要么用原生 Responses 把密文原样透传给保存了链的后端，要么用连接内缓存重建完整明文历史，要么 opt-in 让客户端自己产出可移植明文摘要。OpenCodeX PR #4092 的"客户端压缩"正是第三条路的代表，但其核心动作（切到专用 provider 身份）与所有者"不切 named provider"决议冲突，不能直接照搬。

---

## 1. OpenCodeX PR #4092 精读

### 1.1 权威事实（gh api 取证）

| 项 | 值 |
| --- | --- |
| 仓库 / 许可证 | `lidge-jun/opencodex` / **MIT** |
| PR #4092 | `merged=true`，merged_at `2026-09-09T11:10:03Z`，head `97841a79`，merge commit `8213fada` |
| 规模 | 25 files，**+627 / −33** |
| 标题 | `feat(codex): opt into client-side compaction` |
| 关联 issue #3978 | `closed / state_reason=completed`，标题 `[Feature]: opt into Codex client compaction without disabling V2 routing`，2 评论 |
| 上游加密任务限制 issue #92 | `closed / state_reason=not_planned`，标题 `V2 cross-provider sub-agent loses NEW_TASK body in encrypted_content`，**28 评论** |

> 注：另有一个 `yuanyuanlove/opencodex` 仓库（#4092/#3978 在那里 404），以 `lidge-jun/opencodex` 为准。"ocx1:" 是该项目 compaction 封套前缀，不是仓库名。

### 1.2 PR 做了什么（逐文件）

新配置 `codexClientCompaction`（默认 off），经 zod schema（`src/config.ts:1189`）、类型（`src/types/config.ts:693`）、GET/PUT `/api/settings`（`src/server/management/config-routes.ts:329,419,516,604`）、CLI `ocx system settings --client-compaction on|off`（`src/cli/system-command.ts`）、Dashboard 九语言开关落地。核心逻辑在 `src/codex/inject.ts`：

- `usesProviderTable()` 增加 `clientCompaction===true` 触发条件（`inject.ts:204`）——从 Design B（根 `openai_base_url` 覆盖、保留内置 `openai` 身份）切到专用 provider 表 `model_provider="opencodex"`，`wire_api="responses"`，`requires_openai_auth=true`（`inject.ts:1015-1075`，docs guide `:245-313`）。
- 关键设计 `keepRootOverrideAlongsideTable`（`inject.ts:1035-1050`）：compaction 模式下**同时保留**标记归属的根 `openai_base_url` 覆盖。理由写得很清楚——Codex 用 `merge_configured_model_providers(built_in_model_providers(openai_base_url), model_providers)` 构造 provider map，根覆盖会落到内置 `openai` 条目上；这样"已标记 `openai` 的旧 thread"仍能解析到本代理，而非 `api.openai.com`（脱离路由）。不改写 resume history（`:1379-1400`，`resumeHistory: ... && !keepRootOverrideAlongsideTable`），不触碰任何 `ocx1:` payload——**future-only**。
- 与 `codexDesktopAuthless` 的优先级：authless 更强，二者同开时写 `requires_openai_auth=false` 并沿用 history forward-tagging；compaction-only 形式跳过 history unit。
- 副作用如实记录：模式激活期间不注入 `experimental_realtime_ws_base_url`（provider 表形式携带不了），Codex Desktop 语音走原生端点；有测试断言 profile 不含该键。

### 1.3 重点：它如何在"不解密跨供应商密文"前提下实现 passthrough（本任务核心）

PR #4092 本身只加 compaction 开关；passthrough 机制是该仓库既有能力，PR 文档（`codex-integration.md`，已下载到 notes）明确描述。归纳为四条不变量：

1. **只有原生 Responses passthrough 能回答"本代理丢了历史"的轮次**——它把 `previous_response_id` 原样转发给"保存了这条链"的后端（`codex-integration.md:527-529`）。其它所有 wire（Anthropic/Gemini/Devin/Cursor/Kiro，以及 `statelessResponses:true` 的 Responses provider）都从每轮 input 重建会话，**没有一条能解密或重建上游密文**。
2. **密文逐字节保留、绝不解析/执行/注入**：转发 `x-openai-encrypted-tool-arguments`、tool-output-truncation-policy，"Encrypted arguments, response bodies, and upstream error statuses are preserved"（`:235-239`）；hosted `multi_agent_call` 的工具事件与 encrypted agent messages "preserved, never executed or injected by OpenCodex"（`:1715-1717`）。推理签名用 `ocxr1:` 封套**藏在 `encrypted_content` 槽里原样回放**（DeepWiki `lidge-jun/opencodex` 4.2），不是解密后重签。
3. **自造封套只用于自己能解码的摘要**：`ocx1:`/`ocx2:` 是代理自己生成的透明 compaction 封套；它对 native ChatGPT 不透明——"一旦 OpenCodeX 离开请求路径，native ChatGPT 无法验证该封套"（`:547`）。PR #4092 的解法不是去解密/兼容它，而是让 Codex **自己产出可移植明文摘要**（client-side compaction），从源头不再产生新的 `ocx1:`；已有 `ocx1:` 不改写，只提供显式 history recovery。
4. **typed 拒绝 + 完整上下文重放，代替静默丢轮**：续轮状态过期/属于别的 task scope 时，返回 `previous_response_not_found`（`:505-516`），Codex 的 WS 客户端据此在**正常 stream retry 预算内**用完整保留上下文（含已完成的 tool calls 与结果）重连；HTTP 客户端必须显式处理并去掉 `previous_response_id` 重发全量。**绝不静默剔除 id 后只发当前轮**（那会无声丢上下文）。`allowEncryptedV2AgentTasks` 明文透传加密 V2 子代理任务；"experimental V2 recovery" 明示增加配额/延迟/后端依赖/可能的保真损失，且 **"does not repair the upstream protocol"**（`:1484-1490`）。

### 1.4 原生性 / 许可证风险 / 适配代价

- **原生性**：协议层是原生 Responses API（wire_api=responses），但 PR 的核心动作是从"保留内置 openai 身份"切到**专用 provider 表**——即放弃原生 thread 身份连续性来换 Codex 自管压缩。这是明确的权衡，不是"更原生"。V1/明文委派无公开开关；V2 跨供应商能力上游已 `not_planned`。
- **许可证风险**：**低**。MIT，无 copyleft、无商业授权门槛。真正风险不是许可证而是**行为依赖**：封套前缀、include 白名单、WS 帧契约都依赖 Codex 内部行为，可随版本无声变化（对照 ModelGate 自己的 `codex 0.167 include output.encrypted_content 400` 教训，handoff §2.B）。
- **适配代价**：**中高**。ModelGate 已有等价的 WS 桥 + 续轮缓存（`src/responses-ws.js`、`src/responses-continuation.js`），但走的是 Design B 根覆盖 + 内置 `openai` 身份，**所有者已否决切 named provider**（handoff §2.F.3 / memory：通用身份固定 `model_provider=openai` + `openai_base_url`）。因此 PR #4092 的"专用 provider 表"动作**需所有者重新裁决**才能借鉴；可借鉴的是"opt-in + future-only + 不改写既有密文 + 保留旧 thread 可达性"的设计纪律。

---

## 2. CLIProxyAPI / LiteLLM 对照

### 2.1 CLIProxyAPI（`router-for-me/CLIProxyAPI`，Go，MIT）

三个 issue 全部围绕 **Codex WebSocket executor**（均 `open / state_reason=null`，即无官方关闭结论）：

| issue | state | 内容 | 对 ModelGate 的价值 |
| --- | --- | --- | --- |
| #6567 | open | `oauth.providers.codex.websockets` 默认 false；auth 文件 `"websockets"` 字段优先；synthesizer 只加属性、不写 auth 文件；reload 生效 | 凭据侧"不改用户 auth 文件"的做法可借鉴（符合 memory 安全口径） |
| #7088 | open | opt-in 让 HTTP 下游也走 WS executor；实测固定延迟 WS **1.2s** vs HTTP **2.1s**（12×2 Terminal-Bench，230–270 请求/组；快网 1.9s vs 2.5s）→ 差距来自 WS session 而非 TLS | 量化"持久连接 vs 每轮 HTTP"的收益；呼应 ModelGate WS 桥消除首轮重连 |
| #4924 | open | 离线契约测试：prewarm `generate:false` 返回可链接 response id、同连接带 `previous_response_id` 增量续轮；复现 60 分钟 `websocket_connection_limit_reached` status-400 并用全新连接+完整请求恢复；auth failover 审计完整有序回放（`encrypted_content`、`phase`、`call_id`/`caller` 链、顺序、未知字段）在 `store:false` 下存活 | **直接给出 ModelGate 尚未覆盖的用例**：60 分钟连接上限恢复；跨凭据 failover 时如何保真整段 reasoning 历史 |

对照结论：CLIProxyAPI 的 WS executor ≈ ModelGate 的 WS 桥（连接内 `previous_response_id` 串联、prewarm 帧 `generate=false` 判定、`function_call` 缓存）。#4924 证明该路线有成套离线契约可测，且不依赖真机付费——是 P0-A/T13 可借鉴的**可证伪验证范式**。

### 2.2 LiteLLM（`BerriAI/litellm`，MIT）

reliability 栈 = `num_retries`（同 model group 内 sibling retry）→ `fallbacks`/`context_window_fallbacks`/`content_policy_fallbacks`/`default_fallbacks`（跨 group）→ `allowed_fails`/`cooldown_time`（冷却）→ `request_timeout`。安全护栏：fallback 目标仍校验 key/team/project 访问与预算（`enforce_fallback_model_access`、`enforce_fallback_budget`）。

与本题最相关的两条：

- **stream 失败不是"续跑"，是"降级重答"**：mid-stream 断流时，fallback 目标**丢弃它解不开的加密 reasoning**、只保留 Responses reasoning 的可读 summary（`/v1/messages` thinking block 整块丢），让目标"reason fresh"，以避免 `invalid_encrypted_content`。`encrypted_content_affinity`（v1.110.0+）给 reasoning item 打上"产出它的 deployment"标记，避免跨 provider 误保留/误丢弃。**没有解密、没有真正 resume**。
- **PR #41127（merged 2026-10-16）**：opt-in `enable_mid_stream_fallback_continuation`，仅 chat completions + 支持 prefill 的 provider（Claude Bedrock Converse/Databricks、Sonnet 4.6/Opus 4.6、Vertex DeepSeek v3.2/R1），把截断部分作为 assistant prefill 交给后备，join 时去掉回显文本、保留单一 id/created/role，并跑 `post_call_rules` 校验拼接文本。pre-first-byte 错误透明重试；post-first-byte 报 `MidStreamFallbackError`。

对照结论：连 LiteLLM 这种成熟网关都把"真正的中途续答"做成**opt-in 且受限**，跨 provider 的加密 reasoning 一律**丢弃而非解密**。这反向支持 ModelGate 当前 D3（显式拒绝 v2 密文）不是保守，而是与工业界一致的安全底线。

---

## 3. 六篇论文 → 工程难题映射表（逐篇，非泛泛）

| 论文（arXiv） | 核心贡献（已核实标题/摘要） | 映射到 ModelGate 哪个难题 | 可借鉴点（具体） |
| --- | --- | --- | --- |
| **2610.15459** *When Messages Go Wrong: Understanding Communication Faults in LLM-Based Multi-Agent Systems* (2026-10-11) | 跨层故障分类法（低层扰动→应用可见故障）+ 故障注入/追踪；29,000+ 执行；**20.7% 失败无即时信号，partial-content 故障达 76.2%**；Flat 拓扑 53.0% 成功率 vs Sequential/Hierarchical 3.3%/3.2%；证据恢复取决于是否存在未受影响的可信信息路径 | **MG-R006 / P0-B/T05**：父子跨供应商消息丢失/部分内容故障正是本轮 400 与"孤儿 output"的类属；静默降级（无即时失败信号）对应网关"降级转发后上游才 400" | 把"无即时失败信号"列为一级验收反例：降级必须可观测（结构化诊断日志已在 handoff §2.E 就位）；为父子任务设计**冗余信息路径**（同一 call 的真实性从上游 SSE 与本地缓存双路可证），对应本仓库"不伪造 call、从 SSE 捕获真实 call"的做法 |
| **2606.19135** *A Technical Taxonomy of LLM Agent Communication Protocols* (2026-06-17) | 五维分类法（counterparty / payload / interaction state / discovery / schema flexibility）；9 个活跃开源协议全部"混合 payload + 会话状态持久化"；趋势是 schema 灵活化；长期将是**联邦式分层协议栈**，无单一协议能同时最大化通用性/效率/可移植性 | **ADR 的方法论层**：MG-R005/R006 要求"原生 Harness，不以 MCP 替代"，本质是协议选型问题；本轮 a–d 路线正是在分层栈里选哪一层承接状态 | 用五维给路线打标签：a=原生同 provider stateful、b=连接内 session-state、c=客户端明文 payload、d=typed 拒绝；接受"不存在赢家通吃"，ADR 按层分配职责而非强行统一 |
| **2609.31590** *AgentWorld: Benchmarking Long-Horizon Collaboration of Multi-agent LLMs* (2026-09-25, COLM 2026) | 100 任务、50+ 轮、3–20 agent、blackbox（彼此看不到内部状态）；**CCE**（Causal Collaboration Effectiveness）图指标衡量"团队有多少努力真正贡献到结果"；最强模型仅 52.0% 成功；失败模式：通信崩溃、角色混淆、跨轮无法维护共享计划 | **MG-R006 长会话/父子协作验收**：GPT 父 + Go 子跨供应商 = 天然 blackbox；"共享计划跨轮维护"对应同子代理两轮不同任务（P04 `sendNativeFollowup`） | 把 CCE 思路简化为可证伪清单：第二轮任务必须**实际用到第一轮的工具回执**（不是只 EXIT=0）；本仓库已用 `restored=5 delta=1`、`taskBCompleted && receivedTaskAContext` 表达，方向一致，可补"努力有效性"而非只看终态 |
| **2504.16736** *A Survey of AI Agent Protocols* (2025-04-23, v3 2025-06-21) | 首个全面 agent 协议综述；二维分类（context-oriented vs inter-agent、general vs domain-specific）；按 security/scalability/latency 比较；趋势：分层架构、隐私保护、群体交互 | **MG-R005 边界定义**：明确"网关承担授权/目录/协议路由/观测，Harness 承担调度"的层间契约；避免把协议层职责下放到网关 | 用二维分类给 Nexus/Responses 协议归档：Responses 的 `encrypted_content` 属 context-oriented + provider-specific；跨供应商边界必须视为**不同安全域**，对应 D3 的 typed 拒绝 |
| **2503.13657** *Why Do Multi-Agent LLM Systems Fail?* (2025-03-17, v3 2025-10-26) | MAST-Data（1600+ traces, 7 框架）+ MAST 分类法（14 失败模式，3 类：system design / inter-agent misalignment / task verification），标注者一致性 κ=0.88 | **MG-R008 / MG-R011**：本轮 400 属"inter-agent misalignment"（tool call 与 output 配对错位）；验收必须能区分"设计问题/对齐问题/验证缺失" | 给阻断打 MAST 类目标签（P0-B/T05 = inter-agent misalignment + task verification 缺失），使交付报告可审计；把"task verification"独立成检查项，对应 A5 独立验收职责 |
| **2404.16283** *Andes: Defining and Enhancing Quality-of-Experience in LLM-Based Text Streaming Services* (2024-04-25, v2 2024-12-13) | 定义文本流式 QoE（首 token 及时、后续平滑可消化）；token 粒度抢占式调度；同等 GPU QoE 提升 4.7× 或省 61% GPU | **SSE/WS 流生命周期（P04）与 #51886 900s 截断**：断流/尾延迟直接破坏 QoE；"retryable-looking error"让客户端误判可重试 | 区分**可重试断流 vs 服务端硬截断**（#51886 的 `request_timeout`/900s 属后者，重试同 id 无效）；网关续轮状态应有 TTL/预算并显式上报（现有 128 条/128 会话/6h TTL 缓存即 QoE 取舍），避免"流被截断后续轮状态已丢" |

---

## 4. 社区 issue state_reason 与"关闭后复发"核对表

> 方法：gh api 取 `state`/`state_reason`/`closed_at`/`updated_at`/timeline/comments。`closed_at < updated_at` 且关闭后仍有评论 = 关闭后复发的强信号（需看评论内容确认）。

| # | 仓库 | title（摘） | 当前 state | state_reason | 关闭后复发？ |
| --- | --- | --- | --- | --- | --- |
| #8126 | farion1231/cc-switch | Codex Responses route: mid-stream read errors terminate stream instead of retrying | closed (2026-10-15) | **completed** | 未见关闭后评论（timeline 仅 closed）；复发证据弱 |
| #8281 | farion1231/cc-switch | fix(proxy): stop Chat stream converters at DONE boundary | closed (2026-10-15) | **null（由 commit/PR 关闭）** | timeline 有 10-23 后续 referenced（commit `766f1460`）；疑似修复后续，**非用户复发** |
| #8404 | farion1231/cc-switch | Codex 路由模式支持真正 WebSocket 转发而非 426 回退 HTTP/SSE | **open** | null | 不适用（仍 open）；说明"WS 而非 426 回退"诉求至今未满足 |
| #2750 | farion1231/cc-switch | Codex 经本地代理持续 Reconnecting，流在 completed 前断开 | closed (2026-06-09) | **completed** | **是，强复发**：关闭后 13 条评论，跨 v3.16.5 / v3.19.2 / v3.20.0 / v3.20.1（截至 2026-09-07）持续复现；用户称"重写代理不用 cc-switch 解决" |
| #51886 | openai/codex | 后端 Responses 流 900s 截断 + gpt-6-astra 跑满 900s 不完成 | **open** | null | 不适用（仍 open，**无官方修复**）；15/943 astra、6/88k sol；错误伪装成可重试断连 |
| #33267 | openai/codex | multi_agent_v2 子代理结果不可用：`Encrypted function output content could not be decrypted or decoded` | **open** | null | 不适用（仍 open，**无官方修复**）；9/9 复现；证实错误字符串来自服务端（客户端无此串）；fork_turns=none 仍失败 → 出错的是 agents-tool 函数输出密文本身 |
| #3978 | lidge-jun/opencodex | opt into Codex client compaction without disabling V2 routing | closed | **completed** | PR #4092 实现，未见关闭后复发 |
| #92 | lidge-jun/opencodex | V2 cross-provider sub-agent loses NEW_TASK body in encrypted_content | closed | **not_planned** | **关键**：上游以"不计划修复"关闭（28 评论）——跨供应商密文不可解是**上游明确不做**的协议事实 |

补充：openai/codex 中 `stream disconnected before completion` 类 issue 检索到大量 **全 open** 条目（#61966、#46248、#46161、#37996、#14613、#38001、#38000、#37652、#41340、#35526、#53777、#53315 等），与"7 个断流 issue 全 open 无官方修复"口径一致。

**结论**：closed ≠ solved 在本组里是真实存在的（#2750 铁证；#92 是 not_planned 式"关闭"）。任何竞品"issue 已关"都不能作为"问题已解"的证据——这正是 P0-A/T13 研究目标要守的纪律。

---

## 5. 传输层 a–d 四路线矩阵（总任务书 §4.4 交付物）

> 轴：跨供应商边界上如何承载"续轮状态 / 任务密文"。定义见每条首列；若总任务书对 a–d 有既定编号，请 team-lead 按此定义重映射（本矩阵不预设赢家，ADR 由总代理结合 A1/A2 成果裁决）。
> 许可证：四条路线的参照实现均为 MIT；真正风险是行为依赖而非 license。

| 路线 | 方案 | 原生性 | 许可证风险 | 适配代价 | 可证伪验证方式 | 推荐度（研究评估，非裁决） |
| --- | --- | --- | --- | --- | --- | --- |
| **a. 原生 Responses 透传** | 把 `previous_response_id` + 加密 blob **原样**转发给保存了链的后端；仅同 provider / 原生 Responses 成立（OpenCodeX native passthrough、CLIProxyAPI WS executor） | **高**（协议原生）；但跨供应商即失效——#33267/#92 证实密文在另一 provider 不可解 | MIT，低；依赖 Codex 内部 WS/响应形状，可随版本漂移 | **低-中**：ModelGate 官方路径已具备（handoff §2.E 官方目标直连），但订阅后端实测拒 `previous_response_id`（index.js:699-702），需按目标分流 | 同 provider 两轮：第二轮只带 id + 增量，断言上游接受且上下文完整；跨 provider 正例**预期 FAIL_REAL**（#33267 9/9）→ 证明边界 | 高（官方同 provider 场景）；跨供应商场景 **不适用** |
| **b. 连接内缓存重建** | WS 持久连接 + 进程内有界缓存，每轮从 SSE 捕获真实 `function_call`，重建完整 input+output；对第三方剔除 `previous_response_id` 后明文重建，不解密密文（ModelGate `responses-continuation.js`/`responses-ws.js`、CLIProxyAPI #4924） | **中**（连接层贴近原生 WS，但状态由网关重建而非上游托管） | MIT，低；同样依赖上游事件信封（handoff §2.E 未证实假设 1/2/3） | **已大部分投入**：本仓库已有 128/128/6h 缓存与 WS 桥；缺 60 分钟连接上限恢复、跨凭据 failover 保真（CLIProxyAPI #4924 用例） | 离线：prewarm `generate:false` 后同连接增量续轮、`websocket_connection_limit_reached` 后新连接+完整请求恢复、auth failover 下 `encrypted_content`/`phase`/`call_id` 有序回放（**全部可零费用 mock**）；真机：官方父代理单轮+续轮，grep `recorded`/`reconstructed`/`degraded` | **最高适配度**（贴合现状与所有者约束）；但 P0-B 真机阻断未解前不能记 PASS_REAL |
| **c. 客户端明文 / 客户端压缩** | opt-in 让 Codex 自管压缩、产出可移植明文摘要，避免自造 `ocx1:` 不透明封套；或 V1/明文委派（PR #4092、OpenCodeX `allowEncryptedV2AgentTasks`、m2 路径 A） | **中-低**：需切专用 provider（`opencodex`）或 V1，**与"不切 named provider"决议冲突**，需所有者重新裁决 | MIT，低；行为依赖同上 | **高**：配置注入/分流/历史可达性改造（PR #4092 98+19 行 inject.ts + 大量测试）；V1 路径 0.167 实测无 multi_agent_v1 工具（m2 路径 D 已否决） | 真机：启用后 next compaction 产出**可读明文摘要**、无新 `ocx1:`；旧 `openai` 标记 thread 仍经代理（不断路由）；关闭后行为还原（future-only）；负例：既有 `ocx1:` 不被改写 | 中（设计纪律值得学：opt-in / future-only / 不改写密文 / 保旧 thread 可达）；**实施前必须过所有者裁决门** |
| **d. 网关受控改写 / 显式拒绝** | 网关把密文改写为明文（**D3 否决**：不可猜/伪造/删除密文），或 typed 拒绝 `v2_encrypted_task_unsupported`（ModelGate 现状 `src/responses.js:340-353`） | **低**（放弃该能力可见性），但**安全域最清晰** | MIT，低；无行为依赖（只做判断不解码） | **最低**（已实现且有回归+LIVE 证据） | 负例即验收：注入含 `encrypted_content`/`encrypted_task_id` 的 v2 任务，断言**显式 typed 错误 + 父代理可见**，且无解析/伪造/静默删除（离线回归 + 一次真机） | 作为**安全底线/默认拒答**保留；不是"完成方案"，按契约记该能力 NOT_ACCEPTED 而非降级 |

交叉结论：a 与 b 是互补（同 provider 用 a、跨 provider 用 b）；c 是把 b/c 的"状态归属"从网关移到客户端，代价是身份/裁决；d 是任何路线失败时的统一拒答底线。**没有任何一条能单独满足 MG-R006 的跨供应商完整父子协作**——需组合（推荐 b 为主 + a 为同 provider 快路径 + d 为底线；c 待裁决），最终由 ADR 定。

---

## 6. 研究门槛 §2 逐项留痕

1. **本仓库源码行号**（基准 `886e22a`）：
   - `src/responses.js:340-353` v2 加密任务 typed 拒绝（"网关不解析、不删除、不伪造密文"）；`:86,100,140` gated 字段与加密信号识别；`:317-325` previous_response_id/加密 include 处理。
   - `src/index.js:695-702` 订阅后端删 `previous_response_id`（实测不支持）；`:719,727,810` 官方/第三方分流与工具 id 修复；`:745-752` 第三方丢加密 include、官方逐字节保留；`:2166-2179` 第三方投影/修复按钮；`:3041,3061` nativeGate 严格门禁与绕开条件；`:50` 第三方不放宽声明。
   - `src/responses-continuation.js:78` `recordContinuation`、`:102` warmup 预登记、`:119` `reconstructContinuation`、`:138` capture sink、`:22` 128MB 上限。
   - `src/responses-ws.js:1-40` WS 桥设计不变量（重放进 POST、不另立协议、帧头不转发、无第三方依赖）；`docs/explanation/m2-plaintext-redelegation-options.md` A/B/C/D 既有路径评估。
2. **原生依赖源码**：本地无 codex-rs 源码，未臆造；以**上游 issue 原文**为权威替代——#33267 明确"could not be decrypted or decoded"字符串不在 0.144.4 客户端、来自服务端拒绝 `FunctionCallOutputBody.encrypted_content`；#51886 给出 900s `request_timeout` 帧。OpenAI 官方文档（Responses WebSocket mode / persisted reasoning and stateless replay）经 CLIProxyAPI #4924 引用。
3. **竞品源码**：OpenCodeX `src/codex/inject.ts`（PR diff 全文已存 notes `pr4092.diff`）、`codex-integration.md` 全文（notes）；CLIProxyAPI `pkg.go.dev/.../v8@v8.0.58` thinking/translator/websocket 包结构；LiteLLM `docs/proxy/reliability`、`docs/proxy/load_balancing`、PR #41127 diff 摘要。
4. **issue / 论文 / 社区**：见 §1.1、§2、§3、§4，全部带 state_reason 或提交时间。
5. **≥3 路线取舍**：§5 四路线矩阵 + 交叉结论（a+b+d 组合 vs c 待裁决 vs d 底线），未预设赢家。
6. **真机验证方案**（P0-A/T13，均标注费用门）：
   - 零费用：CLIProxyAPI #4924 式离线契约（prewarm/连接上限恢复/failover 保真）移植为 ModelGate 单测；typed 拒绝负例回归。
   - 需授权真机：官方父代理**单轮**（取结构化诊断：content-type + 首个 data 块 `Object.keys` + id 位置，仅协议元数据）→ 定位 handoff §2.E 未证实假设 → 一次续轮验证 a/b 边界；只用 `gpt-6-luna`。
7. **可审查成果**：本文件 + `notes/pr4092.diff`（PR 全 diff）+ `notes/codex-integration.md`（上游指南全文），均在自有 worktree `.agents/worktrees/a3-cross-project`，未改任何共享/生产文件，未提交密钥/正文。

**未决/失败项（如实）**：OpenCodeX #92 `not_planned` 与 Codex #33267 全 open 意味着"跨供应商密文可解"无上游救兵；P0-B/T05 官方父代理续轮 400 仍为唯一已证实阻断，本文未做修复（只读研究），状态维持 **BLOCKED**；route c 涉及所有者已否决的 named provider 切换，需裁决后才能进入实现。
