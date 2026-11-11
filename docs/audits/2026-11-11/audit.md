# ModelGate 独立技术审计

审计日期 2026-11-11（Asia/Shanghai）。审查固定源树 [远端 main 6bc6441](https://github.com/xiaomengxizzh/model-gate/tree/6bc6441fc7bf3e620b19af5af3b4d62543b31193)、[#5 ec66b24](https://github.com/xiaomengxizzh/model-gate/tree/ec66b24b529cc6c4e531d2bb718ac22edb70f334)、[#6 64a5c96](https://github.com/xiaomengxizzh/model-gate/tree/64a5c96df8ec6445371150fb21414b98aed1bac3)。旧 PR 与分支核对见 [Git 与 PR 审计](git-pr.md)。测试和最小验证由 gpt-6-luna high 执行。主控及两位独立静态审阅者沿标准与需求检查源码入口、运行状态、测试断言和历史证据。

## 完成度和架构判断

以需求中的最终产品为 100%。各项满分要求运行时接入、独立测试与相应产品端验收。分数为本轮评估，基于证据权重，具体环节的成熟度如下。

| 维度 | 权重 | main 得分 / 该项 | #5+#6 候选得分 / 该项 | 证据和扣分 |
| --- | ---: | ---: | ---: | --- |
| 专业网关 | 25 | 55% | 65% | Chat、映射、限流熔断已具雏形。候选增加取消、429、管理投影和 Responses，仍有身份、事务与一致治理缺口。 |
| Codex 深度适配 | 25 | 4% | 45% | 候选存在目录、真实 CLI 历史文本证据和工具桥接；正式身份域、工具与恢复保真、Desktop GUI 待验证。 |
| 多 Agent | 20 | 0% | 15% | 识别 v2 不透明材料并拒绝，历史 spawn 到模型 slug 后受阻；无跨供应商闭环。 |
| 智能路由与成本 | 15 | 10% | 25% | 原有配置链、健康和 token 额度；候选有纯决策模块及部分运行接入，实际目标/费用/重放未闭合。 |
| 产品与运维 | 15 | 25% | 50% | 旧面板可管理基本配置，候选管理投影及新版 UI 已接线；配置写入、历史/额度工作流和升级发布不足。 |
| **加权** | **100** | **20%** | **42%** | 按四舍五入。 |

保留 Node 内置模块和本地部署、供应商配置与模型映射、旧 Chat 合约、请求预算、SSE 适配、现有测试夹具、身份分类、目录生成/版本化、只读诊断与新版 UI。核心重构放在唯一出站执行、版本化目录、配置事务及真实费用账本。PR #2 独立桥和 G0–G4 同功能并行实现留作源材料。多 Agent 的执行生命周期交 UHR。详见[总体架构提案](architecture.md)和[开发总计划](roadmap.md)。

## 数据流与实现分层

| 模块 | 实际实现及保留边界 |
| --- | --- |
| 供应商和配置 | `router.js` 合并 default/local/加密 Key，支持环境来源、provider/model 和虚拟目录。探测、预热、failback 已可复用模型解析，管理投影与写入事务仍分离。 |
| 协议兼容 | `format.js` 负责 OpenAI、Anthropic、Gemini 请求/结果映射，`request.js` 处理 TLS/HTTP、超时和上游重试。Responses 可以原生 HTTP/SSE 或 Chat 转换。原生流直传保留上游事件，桥接流需要自己合成 item、终态及 usage。 |
| 排队与生命周期 | `budget.js` 提供 deadline/abort，Chat 共享 provider 和 model 并发、QPS、健康/亲和。Native、媒体和视频的保护范围各异。 |
| 统计与日志 | 网关保存请求、模型、上游、token、cache 等计数与有限历史。Native Usage 额外读配置的来源，不能替代实际费用或订阅账单。上游错误体和自定义头须收敛在日志边界。 |
| 管理台 | #5 两套 UI 同时可达。/ui-next 用 API store 管理状态、请求投影和 409 冲突。#6 把 Codex 导出和策略摘要接到 Clients。管理 API 权限和文件写入的边界详见 P0-2。 |

[配置与供应商](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/router.js#L53-L92) · [协议适配](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/format.js#L232-L282) · [请求预算](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/budget.js#L15-L65) · [新版管理台](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/ui-next/app.js)

## P0 合并阻断

| 编号 | 证据与影响 | 修复验收 |
| --- | --- | --- |
| P0-1 省略配置字段可能撤销数据面全局 Key | main 的配置保存和 #5/#6 后续实现继承同一行为。保存时先合并 defaults，再把占位空串当成显式清空加密 Key，重载后对没有独立虚拟模型 Key 的路由放行无凭据调用。条件是实例依赖持久化 Key、没有环境变量覆盖、客户端能触达数据面。该条件下可导致未授权调用与费用。未访问实际部署配置。 | 对省略、掩码、显式清空建独立事务用例。按当前数据迁移契约保护已存在 Key。 [main 保存逻辑](https://github.com/xiaomengxizzh/model-gate/blob/6bc6441fc7bf3e620b19af5af3b4d62543b31193/src/index.js#L216-L226) · [#5 密钥写入](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/index.js#L503-L529) · [#5 请求鉴权](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/index.js#L1070-L1089) |
| P0-2 #6 的 Codex 配置 API 扩大本地信任域 | 入口复用允许无 token 本地初始化的管理判断。预览允许以文件名规则选择服务进程可读的配置，响应含保留行原文，包括可能存放 MCP 环境值和认证头的配置。应用/备份/回滚只部分校验路径，文件代际与外部写者亦有竞态。实际风险取决于网关进程权限和可访问客户端。 | 默认关闭管理文件写入。以显式身份、固定根、最小字段投影、无秘密差异和受控备份为前置，验证只读与写入授权分别生效。 [入口鉴权](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/index.js#L1086-L1097) · [预览响应](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/api.js#L313-L344) · [路径与备份](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/config.js#L47-L73) |
| P0-3 #6 官方模型身份未贯穿到最终目标 | 官方目录 slug 只验证目标存在。目标若配置错指第三方或未分类，入口可能继续走原生 Responses，原始历史进入错误域。官方分支检查的 host/path 来自拼装前信息，实际发送另行构造 URL。此前实验的隔离断言覆盖特定配置，不能消除此路径。 | 每次发送对规范化完整 URL 与所选身份一并授权。目录绑定、错误候选、探测和各适配器都使用同一个检查；官方原始输入仅对显式允许目标可发。 [目录绑定](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/router.js#L302-L316) · [入口分支](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/index.js#L1519-L1536) · [目标校验](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/auth.js#L150-L185) · [最终 URL](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/request.js#L243-L247) |

P0 是能跨越身份/数据边界的源码发现。上游重放列为 P1，但只要存在不可安全重试或可能重复计费的请求，仍阻断相应端点进入主干。未对任何真实环境复现安全缺陷。

## P1 和 P2

| 级别 | 发现及证据 |
| --- | --- |
| P1 重放 | #5 Chat/SSE reconnect 发整个请求，流交付标志偏重文本。#6 在决策器处理断流前已经执行 relay。官方代理把 `noRetry` 传进 `ctl`，转发器实际只读 `opts`，捕获异常后还能继续官方候选。当前判定把请求已发但没有收到头的网络错误当作 UNSENT。对托管工具、扣费及断流副作用均需按未知提交处理。 [#5 reconnect](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/forward.js#L567-L578) · [#6 官方调用](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/index.js#L967-L995) · [底层参数](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/request.js#L262-L270) |
| P1 管理和数据安全 | #5 配置 Key 与配置代际顺序写盘，第二步失败会部分提交。旧面板输出的日期字符串与后端数值比较不一致，虚拟 Key 可在预期过期后仍有效。上游错误片段可能回显请求内容并写日志。 [配置事务](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/index.js#L524-L544) · [旧 UI](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/admin.html#L573) · [到期比较](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/index.js#L1083-L1086) · [上游错误日志](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/forward.js#L689-L707) |
| P1 端点治理分叉 | Chat 走 `forwardChain`，原生 Responses、媒体、视频、Embedding 和 Rerank 自行选目标。原生分支不共享模型额度/QPS 及 429 最终响应语义。视频创建的异步上游调用发生在本地幂等记录之前，并发或失联会重复计费。 [原生 Responses](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/index.js#L838-L895) · [视频入口](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/index.js#L1265-L1279) |
| P1 目录契约 | #6 目录缓存忽略同名模型配置变化，读取和路由可能跨代，虚拟名称能先于目录解析。生成 slug 基于规范化 provider/model，碰撞能拒绝，重命名需要迁移别名。第三方生成仍继承官方模板的 tool/search/patch/agent 等行为字段，解析成功不足以证明能力或官方目录覆盖账号可见项。 [目录缓存](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/index.js#L136-L175) · [路由优先级](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/router.js#L335-L351) · [模板行为](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/catalog.js#L474-L506) |
| P1 协议保真 | 原生官方分支仍拒绝 `previous_response_id`、`store`、后台及部分字段。Chat 桥默认丢弃托管工具和某些控制项，`allowed_tools` 约束可能变宽，配对诊断未阻断发送。v2 观察到的嵌套密文显式拒绝，顶层密文字段扫描漏项。旧 SSE 逐 chunk 解码，UTF-8 跨块、CRLF 分隔、无界残留及合成工具终态输出不完整。 [Responses 映射](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/responses.js#L83-L176) · [密文边界](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/interop.js#L223-L279) · [SSE 帧读取](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/sse.js#L246-L261) · [合成终态](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/src/responses-stream.js#L134-L151) |
| P1 凭据与会话关联 | #6 同一 Authorization 头同时承接通用数据面 Key 与官方透传，配置全局 Key 时两者无法正常共用。OpenCode Go 的派生头仍含原 Codex 线程/会话值，须按供应商隔离标识。官方端没有 WebSocket 代理，HTTP fallback 的历史结果仅覆盖指定 CLI 构建。 [入口鉴权](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/index.js#L1245-L1265) · [会话映射](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/forward.js#L103-L116) |
| P1 Fallback 预算与执行偏差 | 运行时未使用决策返回的目标，候选工具从需求复制，价格/授权来源弱，任务和日 spent 固定 0，部分提交没有真实生产转换。详见下节。 |
| P1 E6–E8 产品接入 | API 覆盖 E6 policy/plan/apply/rollback/catalog，客户端页面实际预览/导出。E7 诊断/迁移计划为库，写接口显式拒绝，演练由测试脚本改合成副本。E8 以注入数据及纯状态机为主，运行时另读手工应急布尔值。两者无管理路由和实际 UI；官方额度源缺失应标 UNKNOWN。 [Codex API](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/api.js#L30-L36) · [客户端 UI](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/ui-next/js/views/clients.js#L362-L426) · [历史迁移入口](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/history.js#L451-L457) · [额度来源](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/codex/quota.js#L106-L119) |
| P1 旧集成 runner 授权边界 | #6 `live.mjs` 扫描测试目录，排除表遗漏真实 v1 验收脚本。执行整套可能访问认证文件和真实官方服务，和隔离说明冲突。迁移为显式离线文件白名单，真实验证单独授权。 [旧 runner](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/scripts/test/live.mjs#L14-L23) · [真实 v1 验收脚本](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/scripts/test/codex-v1-live.mjs#L10-L27) |
| P2 可维护性和证据漂移 | `index.js` 同时做管理面、配置、接入、转发、持久化，部分旧注释仍称原生 Responses 未实现。旧 UI 与新版投影双维护。E9 对真实第三方验收有互相冲突的段落，版本化目录/运行时/真实客户端证据应随发布固定同一个 SHA。 [入口注释](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/index.js#L1510-L1518) · [E9 历史报告](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/docs/roadmap/2026-11-11-codex-aggregation-e9-acceptance.md) |

## Fallback 实际成熟度

| 情况 | 已接入路径与缺口 |
| --- | --- |
| 429 与熔断 | #5 Chat 主链已传播 Retry-After 和归因，受剩余预算和上游冷却影响。429 和故障各自归因。原生分支仍可折叠 429 成 502，污染熔断。 |
| 402 / 404 / 5xx | 传统分支按配置链和亲和处理模型拒绝、支付及故障。#6 Codex 聚合路径调用纯决策器，执行器大多只是继续下一个旧候选，无法保证实际执行 `d.target`。 |
| 超时 / 网络 / 用户取消 | 单请求预算、AbortSignal 和队列取消已有代码。必须区分发送前中止、送达未知、服务器受理和可安全续流，当前状态只在拿到上游结果时推进。 |
| 断流 / 工具失败 / 部分提交 | 有 SSE 恢复尝试、流断熔断及模型/上游转移。正则按 chunk 扫工具迹象，副作用和终止事件未统一，纯决策器部分提交不等于运行证据。工具失败应由客户端/UHR 接收并由授权状态决定下一步。 |
| 费用超限 | 原有 token 统计和软额度存在。#6 request 估算从零开始，Task/Daily 实际消费为零，缺少预留与真实账本对账。未知成本判定依赖候选 paid 字段，而集成构造器不提供。 |
| 能力与官方备用池 | 模态/工具来源不足，健康与估算分数没有接管执行。聚合链显式排除后备官方候选，但其他分支不经过同一策略。现有上限、循环时间和次数能约束部分重试，整体次数和副作用约束还需统一。 |

[路由循环、候选与费用](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/forward.js#L339-L433) · [执行顺序](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/forward.js#L712-L770) · [错误决策与实际执行](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/forward.js#L1149-L1174) · [重放规则](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/src/routing/decision.js#L792-L814)

## Codex 同线程、Desktop 与 v2

Codex 0.167.0 的 [ModelInfo schema](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/protocol/src/openai_models.rs#L414-L501) 使用有类型的字段及枚举，包括 reasoning、shell/tool、visibility、上下文、输入模态与兼容性字段。ModelGate 的校验、模板和实际 CLI 解析共同证明一份目录样本可消费。真实账号目录完整性、模板声明的第三方工具能力与不同构建行为分别验收。 `openai_base_url` 改的是内置 OpenAI provider 的推理地址，`model_catalog_json` 是启动时加载的目录文件。保持内置身份可避开 App Server 对跨 provider resume 的拒绝，但同一线程可重开仍不保证历史和工具保真。 [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) · [App Server 线程](https://learn.chatgpt.com/docs/app-server)

历史提交记录有 9/9 双 mock、5/5 真官方加第三方 mock、7/7 双真实文本三轮。E3 的 E 段补记 OpenCode Go 真上游，E9 末段仍写第三方 mock。真双上游脚本复用线程 ID，断言退出和文本，第三方轮接受非空输出。它没有逐项证明历史、工具配对、SSE 次序、断流或凭据集合。历史记录给出正向文本证据，当前 head 的真实供应商验收标 NOT_RUN。当前快照独立双 mock 的原样夹具在 65,536 字节门槛返回 413，2/9 断言通过且无上游命中。零头部命中的断言无法据此证明隔离。提高临时夹具上限后，CLI 三轮达到两个 mock 目标，复验 8/9。官方角色 mock 未收到认证头，第三方轮仍回退模型元数据。该结果支持文本路由和线程复用，工具调用、目录选择器和真实身份仍未获本轮验收。 [E3 原始记录](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/docs/evidence/2026-11-11-e3-live-switching.md) · [真实双上游测试断言](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/scripts/test/codex-live-real.mjs#L55-L70)

历史 Desktop 证据包含应用静态审计和内置 `0.167.0-alpha.3.2` 二进制作为 CLI 的 5/5 本地 mock。实际 GUI 的模型选择、同线程切换、工具、会话归属、断流与 v2 均为 NOT_RUN。验收维持独立客户端矩阵。 [Desktop 历史二进制证据](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/docs/evidence/2026-11-11-desktop-binary-compat.txt)

v2 跨供应商历史实测在加密任务处 BLOCKED。原生密文只保留在授权域。走 Codex 明文 MCP 工具到 UHR 的受限任务委派，保留原生官方通路与第三方模型网关。维护原生 v2 第三方互通须有公开支持和真实闭环证据。 [v2 失败记录](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/docs/evidence/2026-11-11-e4-v2-live-blocked.md) · [架构比较](architecture.md)

## 本轮独立测试

测试时间、命令、完整 SHA、隔离环境、分项计数和证据见[复验记录](verification.md)。远端 CI、真实上游、真实 Desktop GUI、真实历史迁移和正式部署均标明相应未运行边界。产品源代码和共享工作树没有本轮编辑。
