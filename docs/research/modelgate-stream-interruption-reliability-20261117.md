# ModelGate｜官方套餐对话中断与 Responses 传输可靠性专项补充任务书
> 2026-11-17 · **P0 增补 / 研究先行 / 尚未执行**
> 关联总计划：[2026-11-16-modelgate-source-research-real-e2e-master-plan.md](../roadmap/2026-11-16-modelgate-source-research-real-e2e-master-plan.md)
> 本文新增 T13，并对总计划的优先级、真实测试矩阵及启动指令作补充。与旧文冲突时，以本补充任务书为准。

## 0. 新增问题与结论边界

用户报告：即使使用 ChatGPT 官方套餐模型进行普通对话，也会出现不明原因的中断/停滞；类似现象曾在旧版 CC Switch 使用期间出现。它可能与 ModelGate、CC Switch、Codex 客户端、ChatGPT Codex 上游、HTTP/SSE/WebSocket 传输或网络设备有关。

**不得预先认定为 ModelGate bug，也不得因为 CC Switch 某个旧 Issue 已关闭就认定此类问题全部解决。** “stream disconnected” 是多个故障类别共用的表面错误，必须先按真实传输路径和终止事件分类。

本轮公开资料已证实：
1. Codex 官方仓库至今仍有 ChatGPT 登录用户的 Responses WebSocket 中断、HTTP 200 但无 SSE 事件、旧线程卡住、连接重用超时等开放报告。
2. CC Switch 曾修复特定的 Codex Chat 截断识别和 405→426 HTTP 回退问题，也修复过终止事件之后继续消费流的问题；这些修复并不等于实现真正端到端 WebSocket，也不等于通用的中途自动续传。
3. 当前 ModelGate main 的 WS 桥是**客户端 WebSocket → ModelGate 内部 HTTP POST → 上游 HTTP/SSE → 客户端 WebSocket**，不是端到端 WS/WSS 透传。桥接会每 60 秒向客户端发 Ping，但当前实现未见 PONG 健康计时/超时判定。上游流异常处理必须继续审计。
4. ModelGate 原生 Responses 转发当前调用 forward(..., noRetry: true)；streamCodexResponse 的 catch 未绑定/保留原始 err，而是映射为通用的 upstream stream interrupted / timeout。该设计是否造成用户看到的中断，尚未证明；但会妨碍根因分类，必须纳入研究和改进评估。
5. 因此，“Codex 客户端 WebSocket 连接仍活着”不等于“上游模型正在生成”；“HTTP 200”不等于“已经收到 Responses 事件”；“收到流 EOF”不等于“模型正常完成”。

## 1. CC Switch 过往修复：逐项理解，禁止概括成‘已解决’

### 1.1 405 → 426：解决旧客户端无法握手，不是真正 WS 代理
- 旧问题：CC Switch 本地路由最初没有 GET /v1/responses WebSocket 处理，Codex 先尝试 WS 得到 405，进入 Reconnecting。
- 后续兼容：CC Switch 4.x 对 WS 握手返回 **426 Upgrade Required**，使 Codex 主动回退到 HTTPS/HTTP SSE。
- 当前可见实现：src-tauri/src/proxy/handlers.rs::handle_responses_websocket 固定返回 426/websocket_not_supported；src-tauri/src/proxy/server.rs 将 GET /v1/responses 路由到该 handler。
- Issue #8404（2026-10-16）仍为 Open，要求真正的 WS Upgrade 与双向 WS/WSS 转发。维护者明确承认 426 只代表 HTTP fallback，不代表 WS proxy 已实现。
- 对 ModelGate 的意义：不能把“握手没有 405”当作 WebSocket 已打通；必须记录 Codex 客户端与上游各自实际使用的协议。

### 1.2 Chat 上游截断检测：v3.16.2 / v3.16.4
- CC Switch #4535：Codex 路由下 Chat 上游提前结束，导致 stream closed before response.completed。
- 维护者在 2026-06-27 说明：v3.16.2 加入 Codex Chat 截断流检测；只有流真正结束才正常收尾，缺少 finish_reason/[DONE] 时按部分输出 incomplete 或 stream_truncated 失败处理；v3.16.4 继续加固代理链路。Issue 关闭为 completed。
- 这属于**识别截断、避免把残缺流误判为正常完成**，不代表上游连接不会断，也不代表 ModelGate 可以无条件重试并续传。

### 1.3 相似问题并非全都消失
- CC Switch #2750 的用户报告与“代理请求 200 但 Codex 在 response.completed 前断流”高度相似。维护者称 v3.16.0/3.16.2 已有基础修复，但后续仍有人在 3.16.2、3.16.5、3.20.0、3.20.1 等版本报告相似症状；部分报告涉及 Responses 原生、Chat 转换、供应商 base_url、认证配置等不同因素。
- CC Switch #5920：从 DeepSeek 切回 OpenAI Official 后出现 builder error/疑似旧 API Key 残留；维护者将其并入 #3566，并说明 v4.0 对配置切换做了重构。它是配置/凭据切换问题，不应与上游流断开混成同一个根因。
- 必须研究安装版及对应源码/Issue 后，才能判断用户以前遇到的是哪一种。

### 1.4 v4.0.12 附近的 DONE 边界修复不是中途重试
- CC Switch #8126：v4.0.5 在上游 body 中途读取错误时，把错误作为 terminal stream_error 发出；Issue 提出保留底层 ECONNRESET 原因并尝试安全的中途续传。
- PR #8281（2026-10-15）合并：两个 Chat 转换器在发出 [DONE] 终止结果后立即停止消费上游，避免后续 reset/迟到内容再追加 error 或第二个 terminal，也避免上游永不 EOF 时客户端流一直不结束。
- **PR 描述明确表示它不实现 retries/continuation**。尽管 #8126 页面标记经 #8281 completed，不能将其误读为中途断流可自动恢复。必须区分“终止边界修复”和“中途重试/续传”。

## 2. 官方 Codex / ChatGPT 上游证据

以下都是公开报告，不代表每个用户都会遇到，也不等于 OpenAI 已确认统一根因。执行代理必须复核当前 Issue 状态、评论、版本和后续修复。

- Codex #20739：Responses WebSocket 在 response.completed 前关闭，Codex 重试并可能中断 turn；Open。
- Codex #32366：长线程中 WebSocket 在 response.completed 前关闭；关闭 WS 后 HTTP fallback 可返回 200/chunked，但没有 response.in_progress / output_item / response.completed；同配置新线程可以正常工作；截至 2026-11-17 仍 Open。说明需做旧线程/新线程 A/B，不能只测新线程。
- Codex #23807：旧版 CLI 0.132.0 在工具结果后复用陈旧 WS，出现精确 300 秒停顿；报告讨论 first-event timeout 与 stream idle timeout 分离。该版本较旧，只作为设计线索，不可直接推断当前版本仍有相同默认值。
- Codex #36059：统一桌面端 rollout 后某报告者在特定环境的流断开率从 0/206 升至 24/115（20.9%）；WebSocket 多轮超时后回退 HTTPS，短任务可完成但长任务仍出现 error decoding response body；Open。
- Codex #44099：ChatGPT Pro 用户在无 VPN/代理的家庭网络中报告 WebSocket broken pipe、Reconnecting 1/5…5/5，每次等待数分钟；同账号同网络的 ChatGPT Web 正常；Open。说明此类故障可能不由本地网关造成。
- Codex #51886：某 Responses 客户端对 ChatGPT Codex backend 直连及经代理的请求均观察到约 900 秒断流；报告统计为部分模型/请求，不应外推为普遍 15 分钟限制；Open。
- OpenAI Help Center 的网络建议明确指出：Codex 使用 wss://chatgpt.com/；代理、防火墙、TLS inspection 不应阻断/改写 Upgrade 或提前关闭长连接；需检查 WebSocket idle timeout 与最大 frame/message 限制。

## 3. ModelGate 当前源码观察（事实与假说分开）

以本次读取的 GitHub main 源码为基准，执行时必须重新核对 SHA：
- src/responses-ws.js：WsPeer 每 60 秒发送客户端 Ping（约 L113），但 PONG 分支仅返回，不记录 RTT 或执行 pong deadline；runTurn 通过本机 http.request POST /v1/responses，Accept 为 text/event-stream（约 L291 起、L330 起）。因此这条链路不是端到端上游 WebSocket。
- src/responses-ws.js：SSE 收到 response.completed/failed/incomplete 后结束逻辑 turn；上游 end 但没有 terminal event 时合成 response.failed；上游 error 时回 error frame。需要验证这些事件是否足以让 Codex 可靠恢复，以及正常终态之后内部 HTTP/SSE 是否确实被及时收尾。
- src/index.js::proxyOfficialResponses：原生 Responses forward 调用显式传 noRetry:true（main 约 L2091）。需要研究该开关实际禁用了哪一层重试，及其对连接失败/中途断流的影响。
- src/index.js::streamCodexResponse（约 L1864–1898）：读取上游流时 catch 未绑定 err，最终只记录 request timeout 或 upstream stream interrupted；底层 ECONNRESET、ECONNABORTED、socket hang up 等原因无法从此处区分。需要改进安全诊断，不得记录 Authorization、cookie、完整 prompt 或原始敏感 body。
- src/index.js::streamRawResponses（约 L2311 起）：pipeline 回调和 stream error 终止语义也需要纳入审计，特别是客户端能否收到明确的 incomplete/failed 终态。
- 上述观察只指出**需要审计的风险点**，不是已经证明这些代码导致用户遇到的故障。必须以真实报文、时序和复现证据确认。

## 4. 新增 P0 任务 T13：官方套餐普通对话连续性与传输可靠性

**目标：即使没有子代理、没有工具调用、没有 DeepSeek，只用 gpt-6-luna 官方套餐进行普通对话，也不能出现静默停滞、假完成、无解释中断或无穷重连。**

T13 必须先做源码研究和真实对照，再决定是否改架构。子任务：

### T13-A：精确定位用户实际使用路径
- 核对用户使用的是 Codex Desktop、Codex CLI，还是其他界面；确认发生中断时实际模型为 gpt-6-luna。
- 确认当时是 Codex 直连 ChatGPT 官方、经 CC Switch（Direct/Routing/Aggregation 哪种）、还是经 ModelGate。
- 记录客户端版本、Codex CLI/app-server 版本、网关 SHA/运行 PID、Provider、配置是否热更新/重启、当前 transport。
- 不读取/输出账号 token、auth.json、cookie、API Key 明文。

### T13-B：端到端传输拓扑研究
必须分别绘制并解释：
1. 原版 Codex → ChatGPT Codex backend 的官方直连 WS/HTTPS fallback。
2. Codex → CC Switch 本地路由/聚合 → 上游（当前 4.x 的 426 → HTTP/SSE 行为）。
3. Codex → ModelGate WS bridge → 内部 HTTP POST → 上游 HTTP/SSE。
4. 未来候选：Codex WS → ModelGate → 上游 WS/WSS（仅当真实支持且研究证明值得做）。
对每条链路标记：握手、认证域、首事件、事件流、ping/pong、SSE keepalive、连接复用、取消、中断、terminal、重试/续传、超时和状态归属。绝不将“客户端到网关是 WS”描述为“端到端 WS”。

### T13-C：故障分类和可观测性
必须区分以下故障码/阶段：
- WS handshake 失败（405/426/403/timeout）。
- WS 成功升级后 server close / abnormal close / broken pipe。
- WS reused stale connection，发送后 first event 超时。
- HTTP 200 但在 first event deadline 内没有任何 SSE/JSON 事件。
- SSE 正常数据后 EOF，但缺 response.completed / failed / incomplete。
- SSE 中途 ECONNRESET / ECONNABORTED / socket hang up / decode error。
- 上游明确 response.failed / response.incomplete / request_timeout。
- 本地 overall budget 超时、client disconnect、用户 interrupt。
- terminal 已发出后继续收到内容、重复 terminal 或连接迟迟不结束。
- 历史状态/工具续轮 400（与传输中断分开记录）。
每次请求至少记录脱敏元数据：request/trace ID、client/upstream transport、HTTP status/content-type、upgrade status、首事件延迟、事件间隔、持续时间、已收字节数/事件数、terminal type、WS close code/reason、ping/pong RTT、EOF/error errno/code、budget 类型、重试次数、实际 provider/model。禁止记录秘密和完整内容。

### T13-D：超时、心跳和流终态
- 将连接/握手超时、首事件超时、流式 idle timeout、整体预算、WS pong deadline 分开研究；不能把一个超时值复用为全部场景。
- 研究客户端 WS Ping/Pong、网关到客户端 Ping、上游 WS 心跳和上游 HTTP SSE keepalive 各自作用。当前 60s 客户端 Ping 必须验证是否有 Pong 监测，不得仅凭 Ping 已发送声称连接健康。
- SSE 注释 keepalive 只能维持支持它的 HTTP 流中间链路，不能伪造 Responses 业务事件；不得把心跳当成模型输出。
- 每个 response.create 必须恰有一个可信终态；response.completed 只能在上游真实完成时发送；截断不得伪装完成；中途错误必须保留安全的根因代码与可诊断阶段。
- 对正常 terminal 后上游不立即 EOF 的情况，验证内部流/Provider permit/AbortController 是否及时释放，防止旧请求泄漏影响下一轮。

### T13-E：重试与续传的安全边界
- 研究官方 Codex 的 WS sampling retry、HTTPS fallback 和 previous_response_id 续轮语义，并核对当前安装版源码。
- 不能盲目重放已经产生部分输出、工具调用或副作用的请求；先证明幂等性、真实 response state 与 call/output 配对，才可启用自动恢复。
- 对能安全恢复的阶段设计有限次数、退避、去重、预算和取消；对不能安全恢复的阶段返回明确 incomplete/failed 与恢复指引。
- 不允许通过伪造 response.completed、删除历史、重发工具调用、静默切换模型或切换官方/第三方凭据域来掩盖断流。
- 评估 end-to-end upstream WebSocket、HTTP/SSE 增强、官方请求保持原生路径/第三方走本地路由等方案；先做 ADR，不预设必须实现 WS proxy。

### T13-F：根因修复与用户体验
- streamCodexResponse 保留脱敏 errno/code/cause 与发生阶段；评估 noRetry:true 的实际影响，决定哪些错误能安全重试、哪些必须 fail closed。
- 补齐首事件/idle 监控、WS PONG deadline、SSE 终态一致性和异常资源释放。
- GUI 需要显示当前模型、实际 Provider、当前传输（WS/HTTP/SSE）、首事件等待、重试状态、错误原因、是否保留部分结果；不得只显示“请求失败”或无限 spinner。
- 如果是 OpenAI backend/Codex runtime 问题，保留最小复现与诊断包，建议通过官方反馈渠道报告；ModelGate 不得把上游问题伪装成已修复。

## 5. T13 真实测试矩阵（替代简单冒烟）

必须在同一台用户主机、相同网络时段、同一 Codex 版本、同一 ChatGPT 官方登录和 gpt-6-luna 下进行受控对照。各测试串行执行，不同时开多个接管工具。

| ID | 路径/场景 | 目标证据 | 通过标准 |
| --- | --- | --- | --- |
| R13 | 原版 Codex 直连官方基线 | 实际 transport、完整事件时序、终态 | 真实多轮任务完成，异常可归因；作为上游/客户端基线 |
| R14 | 同任务经 ModelGate | client WS 与 upstream HTTP/SSE 分开记录 | 真实工作任务完整完成；无静默停滞、无假完成 |
| R15 | 同任务经本机 CC Switch 实际安装版 | 版本、模式、426/HTTP fallback、上游协议 | 作为同环境竞品对照，不把 HTTP fallback 误称 WS |
| R16 | 有代表性的长时间生成/多文件任务 | 首事件、长间隔、总时长、字节、终态 | 不用 1+1 探针；按真实工作负载评估稳定性 |
| R17 | 旧长线程 vs 新线程 | 同账号同配置，比较 history/previous_response_id 与 transport reuse | 定位是否线程状态相关；新线程通过不能覆盖旧线程失败 |
| R18 | 无工具普通对话 vs 有真实工具的编码任务 | 区分纯传输与 tool/continuation 问题 | 普通对话和工具任务分别有结论 |
| R19 | WS 长连接、空闲后恢复、断线/网络切换 | Ping/Pong、close code、idle timeout、首事件 deadline | 死连接在合理期限内被识别；恢复不重复执行工具 |
| R20 | 故障恢复与用户可见错误 | partial output、terminal、重试/取消、费用 | 无无限 spinner、无重复副作用、错误能解释且可恢复 |

真实对照要求：
- 优先一个完整且具有代表性的编码任务，而不是每个路径重复大量简单 prompt。
- 当某路径出现失败，再做最小的针对性复测以证伪假说；每次复测必须改变/隔离一个变量。
- 需要记录 direct / CC Switch / ModelGate 三路径，但若无法在不破坏真实配置的前提下安全切换，先申请隔离 profile 或明确权限，不擅自改 auth/config。
- 对旧线程失败必须保留该线程的只读证据，禁止删线程后宣布修复。
- 测试 GPT 父模型严格使用 gpt-6-luna；DeepSeek 对照固定 deepseek-v4.1-flash。
- 每项标 PASS_REAL / FAIL_REAL / PASS_MOCK / NOT_RUN / BLOCKED；只有真实场景 PASS_REAL 才进入发布门禁。

## 6. 研究资料与必须追踪的公开来源

### CC Switch
- #1673：Codex WS 405；后续 426 fallback 的兼容修复。https://github.com/farion1231/cc-switch/issues/1673
- #4535：Chat upstream 截断检测，v3.16.2 / v3.16.4。https://github.com/farion1231/cc-switch/issues/4535
- #2750：相似断流报告及跨多个版本的后续用户反馈。https://github.com/farion1231/cc-switch/issues/2750
- #5920：切换到 OpenAI Official 的 builder error / 凭据配置问题。https://github.com/farion1231/cc-switch/issues/5920
- #8126：Responses route mid-stream read error。https://github.com/farion1231/cc-switch/issues/8126
- #8281：DONE 终止边界修复（明确不实现 retry/continuation）。https://github.com/farion1231/cc-switch/pull/8281
- #8404：真正的 Responses WebSocket proxy 需求，目前仍需跟踪。https://github.com/farion1231/cc-switch/issues/8404
- 当前 handlers.rs： https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/handlers.rs
- 当前 streaming_responses.rs： https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/streaming_responses.rs
- 当前 server.rs： https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/server.rs
- v3.16.2 release notes： https://github.com/farion1231/cc-switch/blob/main/docs/release-notes/v3.16.2-zh.md
- 最新发行版本与变更： https://github.com/farion1231/cc-switch/releases

### Codex / OpenAI
- #20739 WS 在 response.completed 前关闭：https://github.com/openai/codex/issues/20739
- #23807 300 秒 stale WS/first event timeout：https://github.com/openai/codex/issues/23807
- #32366 长线程 WS 关闭、HTTP 200 无事件：https://github.com/openai/codex/issues/32366
- #36059 unified desktop 后 WS/HTTPS 断流回归：https://github.com/openai/codex/issues/36059
- #44099 无本地代理的 Pro 用户 broken pipe / reconnect loop：https://github.com/openai/codex/issues/44099
- #51886 ChatGPT Codex backend 的 900 秒流截断：https://github.com/openai/codex/issues/51886
- OpenAI 网络/WebSocket 建议：https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps
- Codex 官方源码：https://github.com/openai/codex

以上是研究起点。执行代理必须重新核实 Issue 状态、最新评论、对应版本源码和实际安装版；不要只引用搜索摘要。

## 7. 总计划的优先级和阶段修订

将原计划 1.2 的阻断顺序调整为：
1. **P0-A / T13：官方套餐普通对话与 Responses 传输可靠性**（新增，先区分 direct / CC Switch / ModelGate）。
2. P0-B / T05：官方 GPT 父代理工具续轮 400。
3. P0-C / T06：跨供应商原生 V2 子任务与密文边界。
4. P0-D / T07：Codex 原生 compaction 与 same-child resume。
5. 其余 T01–T04、T08–T12 按依赖关系并行研究/实施；本机 CC Switch 源码研究 T01 与 T13 同时启动。

阶段新增 G0.5：
- G0：环境、版本、授权与实际路由盘点。
- **G0.5：普通官方对话的 direct / CC Switch / ModelGate 传输基线，完成故障分类、现有日志取证和 T13 研究方案。**
- G1：本机 CC Switch、Codex 原生源码、竞品/论文/社区研究与路线 ADR。
- G2 及以后沿用总计划 G2–G6，但只有 T13 与 T05–T07 等 P0 阻断有真实证据后，才推进发布冻结。

## 8. 本补充的执行纪律

- 先读取用户已有日志和本机 CC Switch 安装版本，使用脱敏元数据；不要要求用户重复提供已经能从本机安全读取的事实。
- 不要擅自更新 CC Switch / Codex，也不要安装监控软件、抓包软件或新的依赖。
- 不要因为 direct Codex 也有中断就免除 ModelGate 的责任；也不要因为 ModelGate 出现中断就默认上游正常。用同环境 A/B 证据分离责任。
- 不要因为 CC Switch issue closed 就断言全局修复；核对关闭原因和合入代码实际解决的故障类别。
- 不要盲目禁用 WebSocket、强制 HTTP-only、关闭工具/压缩或更换模型来制造通过。任何传输策略变化先用临时 profile 做诊断，不能覆盖用户日常环境。
- 不要无脑自动重试已开始输出或已触发工具的请求；重试前先证明不会重复执行副作用。
- 用户体验验收必须包括：长时间无事件时 UI 是否明确显示等待/超时，连接断开是否保留部分输出，用户能否取消/重试，以及是否能在原线程继续工作。
- T13 研究记录必须独立成文，含真实调用图、故障分类、对照矩阵、源码行号、证据 URL、ADR、真机测试收据和明确未决项。
