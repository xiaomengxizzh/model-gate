# ModelGate 网关能力完善计划 V1.0｜2026-11-07

> 类型：执行任务书，不是已完成报告。基线 main SHA 7d616cc1507d2889bc726b192a21db409f316518；Codex / OpenCode Go 实验 PR #2 仍为 Draft，不能默认视作已合并。执行前须刷新 HEAD、分支、PR 和测试状态。

## 目标与边界

将 ModelGate 建设为本地优先、以 API 为核心、多 Provider / 多模型 / 多 CLI 共用的可靠网关，稳定支持 Codex、DSH、其他 CLI 与用户自建工作台。职责集中于入口、协议、路由、鉴权、额度、弹性和可观测，不承担 UHR 的多智能体编排，也不下载或部署模型权重。长期运行不依赖 CC Switch。

现有可复用：Node 18+ 原生 HTTP（package.json 无第三方依赖）；index.js 提供控制面和数据面；router.js 管理 provider/model/virtual model、Key 与配置；forward.js 完成路由链、限流、熔断、故障转移与记账；request.js 管理重试与 timeout；sse.js 处理 Chat SSE；format.js 进行 OpenAI Chat、Anthropic、Gemini 互转。既有 docs/phased-execution-plan.md 的 Phase 1 已落实部分能力，Phase 2 能力维度与 Embedding、Phase 3 多模态不能未经审计就当作完成。

重点缺口：main 无原生 Responses；PR #2 的 Responses 适配为隔离实验，不支持完整治理，尚未经过真实 Codex CLI/桌面+OpenCode Go 验收。旧 Chat 入口的 429 可能被 request 重试与 forward 循环链放大。不同上游的模型推理路径、探活路径、reasoning、stream_options、会话头和 tool calling 不保证相同。旧测试依赖实际网关及配置，缺更强的离线模拟、wire contract 与故障证据。

## 目标架构

六层职责必须明确：
1. entry：/v1/chat/completions、/v1/responses、/v1/models 等入口；认证、body 上限、capability 和输入 schema。
2. normalizer：抽象消息、工具、流事件及计费语义；无法保真转换的字段明确拒绝，不悄悄丢失。
3. adapter：选择 client wire × provider wire × model capability。相同协议原生直通优先，异构协议使用专用桥或中间表示；保留 reasoning/tool ID。
4. route：复用现有真实模型、虚拟模型、独立 Key、目录、fallback、亲和、quota，不允许新 Responses 旁路绕开。
5. transport：连接、取消、stream/backpressure、重试、模型级限流、熔断、整体请求预算。
6. accounting/observability：token、成本（有可靠定价才显示）、缓存命中、重试次数、trace、错误类型、可诊断日志。

网关对 API 调用负责，不直接读取、修改或复制 Codex 的官方 auth.json；保留用户官方登录不等于用 ChatGPT 订阅额度转发第三方 API。

## 阶段 G0：审计与冻结最小接口（先做）

- 阅读 AGENTS.md、RESOURCE_APPROVAL.md、README.md、package.json、src/*、scripts/test、docs/phased-execution-plan.md、docs/project-context.md 与 PR #2 全部差异。
- 核对 main / PR #2 双方 SHA、旧面板真实使用的 API、配置并发版本、provider 与 virtual model 的权限语义、隐藏字段保留方式。
- 建立管理面 API 合同文件 docs/contracts/management-api-v1.md（执行时创建），逐个列 GET/POST URL、鉴权、字段、默认值、状态码、409、敏感字段、契约 fixture 与兼容性承诺。前端轨道必须依此开发。
- 建立协议兼容矩阵（Codex 桌面/CLI、DSH、OpenCode Go Chat/Responses、其他支持客户端）、功能缺口、失败请求样本的脱敏规范。
- 探测真实宿主已有 Node、版本、运行实例、端口、依赖和共享缓存；缺宿主权限标 UNKNOWN_LOCAL_STATE。先确定 8788 隔离开发配置和脱敏、回滚策略，不碰 8787。
- 输出 G0 evidence，区分实际执行 PASS、mock PASS、静态检查、NOT_RUN；无真实 Key 不运行付费请求。

验收：文档/契约/基线与风险清单齐全，未做未授权下载或真实线上切换。

## 阶段 G1：弹性、限流、权限及配置安全（P0）

- 429 分层归因：平台额度、单模型容量、请求速率、本地 QPS。保留原始 status、error type、Retry-After；引入单请求全局 attempt/time budget，防止 client retry × request.js retry × forward.js fallback × loop 无限放大。非幂等工具调用不得自动重放。
- 失败策略按 provider/model/capability 可配置；400/401/422 不盲重试；403/404/模型不可用 400 的处理以真实响应语义区分，而非宽泛字符串误识别；5xx 熔断与恢复可证明。
- 并发隔离、排队公平、取消向上游传播、流中断无伪成功；探活、预热使用最小流量且有禁用与限额。
- 控制面 API 安全审计：当前 /api/status 返回 provider.extraHeaders，检查是否有 token/代理密码；所有配置、日志、错误响应、调试导出须脱敏。数据面 Key、虚拟 Key、管理 Key 权限分区清晰；绝不把用户 prompt、Cookie、Authorization 写到 Git。
- configVersion 409、配置原子保存、未知字段保留、删除语义、故障回滚与旧版本向后兼容必须有模拟并发验收。
- 诊断字段：trace id、client、provider、model、wire、status、cause、attempt count、retry-after、stream termination、time/latency、fallback chain；无真实成本信息不伪造价格。

验收：离线 mock 覆盖 400/401/403/404/408/409/422/429/5xx、重试预算、取消/断流、双客户端并发配置、敏感字段脱敏；既有 Chat 行为无回归。

## 阶段 G2：统一 Codex/Responses 与 OpenCode Go（P0）

- 审计 Draft PR #2，针对工具调用循环、custom tool、Responses SSE 事件顺序、会话头、流取消、统计、权限、错误类型和端点路径做缺口修复，不能直接跳过 gate 合并。
- /v1/responses 必须进入既有鉴权/配额/路由/统计/熔断通用逻辑，消除 PR #2 的长期隔离捷径。模型名称与实际 upstream model id 分开配置。
- OpenCode Go 按模型选择 native Responses 或 Chat 适配路径，不根据名字盲推；遵照用户实际 DSH 插件及成功请求证据核对端点、header、session、reasoning、stream_options、tool_schema。
- 参考 CC Switch 的 Codex 第三方 provider 接入和官方登录保留思路，但不复制 CC Switch 存储 OAuth 的复杂组件；不修改官方 auth.json。
- 同 Key、同模型、同时间对照 DSH 成功、Codex→CC Switch 429、Codex→ModelGate 新实现。最小非流→流式文本→多轮→shell_command/apply_patch 工具闭环→长上下文→取消；真实 API 测试要在现有合法凭据/成本授权下进行。
- 任何不能保真表达的输入明确 422；不得只把 assistant 文本当作 Codex 工具调用通过。测试事件顺序、call_id、function arguments、usage、response.completed / failed。

验收：独立 Codex CLI/桌面实测日志 + 上游状态链完整；mock 测试不能替代实机；没有 Key 则 NOT_RUN_LIVE，不宣称修好 DeepSeek 429。

## 阶段 G3：多能力网关和治理（P1→P2）

- 沿现有阶段计划先完成 capability 六件套和 Embedding；按业务需要追加 Rerank、Audio、Image、Video，严格各能力接口+上下游兼容+计量不同语义。
- video/image async 必须有任务隔离、过期、取消、访问权限及结果保存策略，暂不引入任何大型运行时/模型/数据集。Node 内置实验能力须先确认宿主实际版本，不能默认可用。
- 按 Provider、真实模型、虚拟模型、client、protocol、会话做指标：成功率、p50/p95、429/5xx、缓存、token、成本来源、SSE 中断与趋势。探针区分 HTTP 可达、模型可推理、工具调用闭环可用。
- 路由预览、协议能力声明、健康和配置接口形成稳定可读契约；必要时增加只读诊断 API，但不将原始密钥/隐私信息暴露给前端。

验收：新能力有端到端 mock、鉴权、错误和用量路径；旧功能全部回归，通过独立的 frontend API fixture 验证。

## 阶段 G4：发布、稳定性和交付（P1）

- 冻结 /api/* contract v1，提供无秘钥 fixture/契约测试，逐项记录破坏性变更、弃用窗口和可回退方法。
- 每阶段独立 PR 和证据，不同功能可拆小 PR；全部在隔离 8788 或 mock 环境完成后再审计，未经用户授权不修改 8787/现有生产 Codex 配置。
- 交付运行手册、限流/429 排障指南、OpenCode Go 连接配置、模型/Provider schema、CHANGELOG、验收报告（PASS/PARTIAL/BLOCKED）和下一阶段清单。

## 并行开发与冲突边界

后端 AI 使用独立 dev/gateway-* 分支，负责 API schema 真相；前端 AI 使用 dev/frontend-* 分支，只使用契约、mock fixture 与 UI 文件，不随意修改业务后端。多 AI 不可在同一 worktree、同一 Git 分支、同一配置文件并发写入。先做 git status、branch、remote SHA、锁和运行进程检查；每次提交前 re-fetch，出现 409/非快进立即停止，避免覆盖其他执行者。PR #2 由后端 AI 独立审计，不经本计划自动合并。

## 资源与安全硬门禁

**新增大型安装/下载：无；历史提议仅供研究，不自动执行。** 任何依赖（无论大小）下载、安装、升级前必须检查真实宿主已有版本、缓存、跨项目副本、重复下载风险、增量大小、兼容性并明确申请授权；用户没有明确允许时禁止执行。禁止默认安装模型权重、训练框架、Docker/大镜像、浏览器包、重型前端套件；不能通过 CI 或子代理绕过。Node 内置模块和现有依赖优先，缺环境写 UNKNOWN_LOCAL_STATE。

不上传用户对话、密钥、环境变量、auth.json；真实 API 测试需有调用与成本授权。未经实测不声称验收通过。每个 PR 必须说明真实 vs mock/静态测试、blocker、可回滚命令与进度评价依据。

## 文档与参考

必读：AGENTS.md、RESOURCE_APPROVAL.md、README.md、package.json、docs/phased-execution-plan.md、docs/project-context.md、src/index.js、src/router.js、src/forward.js、src/request.js、src/sse.js、src/format.js、scripts/test/，以及 Draft PR #2 的 docs/codex-opencode-go-adapter-20261107.md。前端计划：docs/roadmap/2026-11-07-frontend-rebuild-plan.md。上游源码： https://github.com/openai/codex 、 https://github.com/farion1231/cc-switch ，OpenCode/DSH 以实际使用版本再核验。 
