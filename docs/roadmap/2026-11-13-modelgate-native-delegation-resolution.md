# ModelGate｜2026-11-13 最新进度审计、问题解决方案与执行启动书

- 日期：2026-11-13
- 文档性质：最新代码/证据审计 + 架构纠偏 + 分阶段执行计划
- 仓库：https://github.com/xiaomengxizzh/model-gate
- 审计基线：`integration/modelgate-release` @ `c6d97dabf871c10046d2b174d11b3401bd5d46d8`
- main 基线：`main` @ `6bc6441fc7bf3e620b19af5af3b4d62543b31193`
- 本次提交范围：只新增本方案文档；不改运行时代码、不合并、不部署、不触碰真实 Codex 配置。
- 新增大型安装/下载：无。不得通过子代理、CI、容器或 bootstrap 绕过资源授权。

## 0. 最终判断

ModelGate 的多供应商路由和 Codex Responses 适配已经取得实质进展；真实 Codex CLI、ChatGPT 官方服务和 OpenCode Go 的同线程切换有 7/7 记录。11 月 13 日又进一步完成了真实 Go 子代理初派与同子追派，四次 Go 请求均 HTTP 200。

但当前实现仍有三个不能忽略的缺口：

1. **官方订阅认证路径存在产品化风险。** 最新实验分支的 `src/codex/local-subscription.js` 会读取 `CODEX_HOME/auth.json` 或 `$HOME/.codex/auth.json`，提取 Codex 登录态，再由 ModelGate 向 `chatgpt.com/backend-api/codex/responses` 发起请求。这不是当前公开 SIWC 文档所示的应用授权路径，而且与 11 月 12 日交付报告中“F01 不读 auth.json、关闭官方原生凭据透传”的安全结论冲突。
2. **跨供应商子代理的父端交接还没有稳定闭环。** 子代理已经实际运行并返回结果，但第一次父进程没有收取 Code Mode 顶层等待单元；同一父会话恢复后才成功完成追派。尚未通过一次不被外部测试器中断、父端完整收取两轮结果并正常结束的单进程验收。
3. **发布整合和 GUI 未完成。** 当前整合候选分支比 main 超前 246 个提交、涉及约 300 个文件，没有对应 PR。PR #5/#6 仍是不同分支上的 Draft，不能把它们等同于当前 release 候选。新控制台契约仍是纸面规格，不能视为 GUI 已交付。

**推荐纠偏方向：保留 Codex 官方原生登录与 GPT 父模型直连；ModelGate 不再读取或转发 Codex 订阅凭据，而是提供仅供本机 Codex 使用的 OpenCode Go 委派工具（优先本地 stdio MCP）。** 这样 GPT 父模型继续由用户自己的 Codex 官方客户端调用，OpenCode Go 子任务由 ModelGate 使用独立的 Go 凭据执行。ChatGPT 套餐不被包装成通用 API，也不经过 ModelGate 反向代理。

这条路径的代价是：外部 Go worker 通过本地工具委派，而不是伪装成 Codex 原生 `spawn_agent` 的异 provider 子代理。若“必须是原生 spawn_agent 且必须跨 provider”是不可让步的硬要求，则在获得官方明确支持的明文委派/供应商选择机制之前，应继续显式阻断，不能伪造兼容。

---

## 1. 最新仓库状态与证据分级

### 1.1 分支与 PR

| 对象 | 当前核查结果 | 处理意见 |
|---|---|---|
| `main` | `6bc6441` | 保持不动 |
| `integration/modelgate-release` | `c6d97da`，相对 main ahead 246 / behind 0 | 当前最新整合候选；先做 ancestry 与文件级审计 |
| PR #5 | Draft，整合候选相关分支 | 不自动合并 |
| PR #6 | Draft，Codex 多供应商聚合实现，base 为 `integration/modelgate-next` | 与 release 分支不是同一提交对象 |
| release 分支 PR | 未发现 | 不得假设已进入评审/发布流程 |

release 候选分支与 main 之间有 246 个提交差异、比较结果最多返回 300 个文件。不得直接把它当成一个小型功能 PR 合并；先识别哪些提交属于既有基线、哪些属于聚合功能、哪些属于 11 月 13 日实验增量。

### 1.2 已有成果

| 能力 | 当前证据 | 真实边界 |
|---|---|---|
| Codex 同线程 GPT → 第三方 → GPT | PR #6 / E3 记录 7/7 | 证明当时锁定版本和配置下的真实切换，不等于 Desktop 已验收 |
| Codex 目录与聚合 slug | 完整目录生成、别名解析、模型档位和路由测试 | 目录可见不等于模型权限/额度保证 |
| OpenCode Go 原生 Responses | 真实请求抵达 Go；11/13 四次请求 HTTP 200 | 真实 Go 已接受请求形状 |
| 原生子代理初派与追派 | 11/13 真实初派、恢复同一父会话后的同子追派成功 | 首次父进程没有完整父端回执；单进程连续闭环仍待验 |
| SSE 请求预算生命周期 | 最新代码已修复等待 SSE 终态时提前释放请求预算/并发槽位的问题 | 仍需长流、断流、取消和真实 Go 的完整回归 |
| V2 加密任务处理 | 纯密文/不可读任务显式拒绝；受控明文投影有测试 | 不得解密、伪造、静默删密文或自动降级 v1 |
| 离线测试 | 开发计划记录 76/76 suites、774 pass、1 skipped；check/docs/metadata/diff-check 通过 | 这是分支文档记录，不等于本轮重新执行，也不等于 GitHub Actions 已通过 |
| GUI | `/ui-next` 是已有预览；`console-v1.md` 是纸面契约 | 新控制台尚未完成实现和验收 |
| Desktop | 未完成端到端验收 | 独立于 CLI，不得推断通过 |

主要证据：
- [11/13 原生 Codex 真实双上游验收](../evidence/2026-11-13-modelgate-native-live.md)
- [11/13 原生 Codex 链路进度与阻塞](../evidence/2026-11-13-modelgate-native-flow-progress.md)
- [开发计划中的 11/13 复核记录](../development-plan.md)
- [11/12 加固交付报告](../evidence/2026-11-12-closure/delivery-report.md)
- [Codex V2 子代理 wire 事实](../explanation/codex-v2-agents.md)
- [M2 明文委派路径评估](../explanation/m2-plaintext-redelegation-options.md)

### 1.3 11 月 13 日真实链路的精确判定

已通过：
- 原版 Codex CLI 使用 ChatGPT 原生登录态启动父模型 `gpt-6-luna`。
- 父代理发起一次原生子代理初派。
- 子任务经 ModelGate 路由到 OpenCode Go 的 `deepseek-v4.1-flash`。
- 子代理执行工具并返回第一次随机挑战。
- 恢复同一父会话后，向同一子代理发起 `followup_task`，第二次随机挑战、工具执行和结果返回成功。
- 四次 Go 请求全部 HTTP 200，Go 请求使用 Go 凭据，没有携带 ChatGPT 账号头。
- 正式 Codex 配置 SHA-256 前后一致；实验进程和测试端口已退出。

尚未通过：
- 第一次父进程中，内部 `collaboration__wait_agent` 等待提前结束；Code Mode `exec` 单元让出控制后，没有观察到父进程继续调用顶层 `wait({cell_id})` 收取该单元。
- 子代理实际完成，不代表父代理已收到完整最终回执。
- 恢复同一父会话后追派成功，证明恢复路径可行，但不能替代单进程完整验收。
- 真实 Desktop 入口尚未验收。

此前报告中的 `ERR_STREAM_PREMATURE_CLOSE` 属于 ModelGate 转发层的请求作用域/预算生命周期问题；最新代码已修复“等待 SSE 终态期间提前释放预算和并发槽位”。11/13 真实测试留下的父端等待问题属于另一层：Codex Code Mode 的让出控制单元没有被顶层收取。不要把这两种问题混为一谈。

---

## 2. P0：官方订阅认证边界必须纠正

### 2.1 当前代码事实

当前 release 候选分支包含：

- `src/codex/local-subscription.js`：读取 `CODEX_HOME/auth.json` 或 `$HOME/.codex/auth.json`，提取 `tokens.access_token` 与 account id。
- `src/index.js`：当 `providers.<id>.gatewaySubscription.enabled === true` 时，要求网关监听与客户端都为 loopback，目标属于官方 host，并向 `/backend-api/codex/responses` 发送本地 Codex token。
- 该分支把 `Authorization: Bearer ...` 和可选 `chatgpt-account-id` 加到官方上游请求。
- 代码注释声明不刷新、不持久化、不交给第三方、不记录 token；这些是安全缓解措施，但不等于这条认证路径已经获得官方 SIWC 授权。

### 2.2 与历史安全结论冲突

`docs/evidence/2026-11-12-closure/delivery-report.md` 的 F01 写明：
- 关闭官方原生凭据透传；
- 不读取登录态；
- `auth.json` 与 `CODEX_HOME` 不读不写。

而 11 月 13 日的实验代码重新引入了本机 Codex 登录态读取。这应登记为 **F01 回归/实验性越界**，不能只通过“loopback 限制”把它解释成原安全设计仍然成立。

### 2.3 官方 SIWC 资料带来的新边界

截至 2026-11-13，官方资料显示：

1. [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) 要求使用官方支持的 SIWC 登录流程；订阅计划使用必须来自用户控制的本地运行时或用户控制的远端运行时；请求必须属于已连接应用和该用户的活动；不得把订阅计划变成其他工具的通用 API，也不得跨用户共享额度或认证令牌。
2. [Codex app-server SIWC 文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) 展示的模式是：应用完成授权码交换后，读取自己获得的 `access_token`，通过 `ACCESS_TOKEN` 环境变量交给 Codex app-server；provider 指向 `https://api.openai.com/v1`，调用 Responses API。该文档没有授权应用读取另一个 Codex 安装目录的 `auth.json`，也没有把 `chatgpt.com/backend-api/codex/responses` 作为通用应用接入端点。
3. [SIWC Preview Limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) 规定了该预览路线的请求限制，例如 `store:false`、`stream:true`，并列出不支持的字段（包括 `multi_agent`）；同时说明 Codex app-server 可以通过受支持的 function/custom tool calls 协调本地工具和子代理。
4. [Request a client ID](https://developers.openai.com/siwc/request-client-id) 当前说明 SIWC 只向部分商业合作伙伴开放，其他申请者需要加入 waitlist。因此不能假设本项目现在已经具备真实 SIWC client_id、scope 或接入资格。
5. 当前仓库的 `src/subscription/oauth.js`、`session.js`、`capabilities.js` 是 P07 合成预览原型：scope 标签、注册数据和端点均有 UNKNOWN/合成属性，默认关闭；不能把它描述为已接通真实 SIWC。

### 2.4 处理决策

**必须停止把 `gatewaySubscription` 当作可发布的 ChatGPT 订阅适配器。**

- 从生产请求路径禁用并移除 `readSubscriptionCredential()` 对 Codex `auth.json` 的读取。
- 不再由 ModelGate 向 `chatgpt.com/backend-api/codex/responses` 发送从 Codex 本地登录态提取的 token。
- 不复制、缓存、刷新、导出或转交 Codex `auth.json`。
- 不允许把 ChatGPT 套餐包装成通用 `/v1` API，供任意客户端或其他工具使用。
- 保留必要的历史证据，但把 P09/本地订阅透传标记为实验性、不可发布；修正文档中 F01/P09 的冲突。
- P07 SIWC 原型继续默认关闭。只有拿到正式 client_id、真实 scope/endpoint 和官方资格后，才可另开 SIWC 实施任务；实施时必须读取应用自己通过授权流程获得的 token，并满足 SIWC 的应用范围、用户控制、同意、撤销和本地存储要求。

这不是断言所有本地代理行为都必然违规，而是当前 `auth.json` + 私有 `backend-api` 方案缺少公开文档支持，且与之前锁定的凭据隔离边界冲突，不能作为正式产品路径。

---

## 3. 推荐目标架构：官方父模型直连 + ModelGate 本地委派工具

### 3.1 数据流

```text
用户
 │
 ▼
Codex CLI（用户自己的官方 ChatGPT 登录）
 │
 ├── GPT 父模型请求 ───────────────────────► OpenAI 官方服务
 │
 └── 本地工具调用：modelgate_delegate_task
          │
          ▼
     ModelGate 本地 stdio MCP Server
          │
          ├── 本地任务状态 / 幂等 / 等待 / 取消
          │
          ▼
     ModelGate OpenCode Go Provider
          │
          ▼
     OpenCode Go / deepseek-v4.1-flash
          │
          ▼
     子任务结果、工具结果、产物引用
          │
          ▼
     MCP 工具结果返回 Codex GPT 父模型
```

关键边界：
- GPT 父模型由 Codex 官方客户端直接调用官方服务，ModelGate 不处于 GPT 请求链路中。
- ModelGate 不读取 Codex 登录态，不持有 ChatGPT token，不代理 ChatGPT 套餐。
- ModelGate 仅使用用户单独配置的 OpenCode Go 凭据调用 Go。
- Codex 通过本机 stdio MCP 工具向 ModelGate 委派任务；不暴露面向任意客户端的 ChatGPT 订阅 API。
- ModelGate 现有通用 API Gateway 继续服务 API Key/其他已授权 provider；ChatGPT 套餐不是其中一个可供任意客户端调用的 provider。

### 3.2 为什么选择本地 MCP/工具委派

Codex 0.167.0 的现有取证已经锁定：
- 子代理 provider 继承父 turn 的 provider；
- role 的 `model_provider` 不能可靠地把子代理切换到另一个 provider；
- V2 的 `agent_message` 可能是后端密封的加密信封，网关无法读取其任务正文。

因此不要再把“改 role 的 model_provider”或“解密/改写 V2 密文”作为跨供应商方案。

本地工具委派把任务文本作为普通、显式、可审计的工具参数传给 ModelGate，绕过对 V2 密文的猜测和重写。它是一种**工具驱动的外部 worker 委派**，不是 Codex 原生 `spawn_agent` 子线程。官方 SIWC app-server 文档也明确描述了通过受支持的 function/custom tool calls 协调本地工具和子代理的路线；但本项目当前首先使用 Codex CLI 原生登录，不以尚未获批的 SIWC 资格作为前提。

如果未来要求必须保留原生 `spawn_agent` 语义，必须先取得 Codex 官方支持的明文委派/跨 provider 机制和真实证据；在此之前保持显式阻断。

### 3.3 MCP 工具契约建议

建议新增独立的 OpenCode 委派 MCP 模块，不要把 UHR mock 适配器误当成现成的 OpenCode 执行器。

| 工具 | 职责 | 关键规则 |
|---|---|---|
| `modelgate_delegate_task` | 创建 Go 子任务 | 输入显式任务文本、任务约束、工作区引用、预算和幂等键；provider/model 由服务端 allowlist 决定 |
| `modelgate_get_task` | 查询任务状态与结果摘要 | 只返回调用者拥有的 taskRef |
| `modelgate_wait_task` | 有界等待任务终态 | 支持短轮询、deadline、取消；等待超时不等于任务失败 |
| `modelgate_followup_task` | 在同一个 Go session/child ID 上追派 | 绑定原 taskRef 与 session；不得隐式新建重复任务 |
| `modelgate_cancel_task` | 取消运行中的子任务 | 幂等；记录取消是否真正到达上游 |

MCP 服务：
- 优先使用 stdio，限定为本机 Codex 启动的子进程；不新增远程通用 API 入口。
- 优先使用 Node 内置能力或本机已经存在的兼容依赖；新增依赖前必须盘点并获得用户授权。
- 不允许工具参数指定任意 URL、任意 provider host 或任意上游凭据。
- provider 默认限定为已配置的 `opencodego`，model 默认限定为 `deepseek-v4.1-flash`；扩展必须由配置显式允许。
- Go Key 只在 ModelGate 内部使用，不返回给 Codex 工具调用结果。
- 任务正文、工具结果和日志必须有大小上限与脱敏规则；日志不记录 API Key、Authorization、完整敏感正文。

### 3.4 任务生命周期

采用持久化、幂等的状态机：

```text
CREATED
  └─► ADMITTED
        └─► DISPATCHED
              └─► RUNNING
                    ├─► RESULT_READY ─► ACKNOWLEDGED
                    ├─► FAILED
                    ├─► CANCELLED
                    └─► UNKNOWN（发送结果无法确认）
```

要求：
- `taskRef`、`parentThreadId`、`providerSessionId`、`turnId` 和幂等键建立明确关联。
- 发送前持久化 admission/dispatch 记录；网络写入开始后若结果未知，必须进入 `UNKNOWN`，不能简单重发。
- `wait` 的超时只代表本次等待窗口结束，不自动把任务改成失败。
- `followup` 复用同一 Go session，且同一幂等键只能产生一次有效派发。
- Codex 父会话恢复时，先按 taskRef 查询现状，再决定继续等待、追派或结束；禁止因为父进程重启而重复创建任务。
- 只有收到上游终态、核对任务 ID 和结果摘要后，才能标记 `RESULT_READY`；父代理确认读取后才标记 `ACKNOWLEDGED`。
- 结果至少返回：taskRef、状态、模型、执行时间、结果摘要、工具执行摘要、产物引用/哈希、是否截断、lossy 信息。

---

## 4. P0/P1 问题解决方案

### P0-A：清除非正式订阅凭据桥

写集：
- 禁用并移除 `src/index.js` 中生产路径的 `gatewaySubscription` 特殊发送分支。
- 删除或隔离 `src/codex/local-subscription.js`，确保生产代码不再读取 `CODEX_HOME/auth.json`。
- 删除对应配置开关或明确标记为 retired/unsupported；不得留一个 UI 开关让用户误以为已正式支持。
- 修订 F01、P09、SIWC 文档，明确“Codex 原生登录直连”与“应用自己的 SIWC OAuth”是两个不同身份域。
- 增加静态/单元回归：生产代码路径不读取 `auth.json`，不从 `CODEX_HOME` 推导订阅凭据，不向 `chatgpt.com/backend-api/codex/responses` 发送本机 Codex token。

### P0-B：实现 OpenCode Go 本地 MCP 委派

- 先核查现有 `src/mcp/`、OpenCode Go provider、Responses 转发、会话头构造和任务存储，不重复造已有能力。
- 新增独立的 OpenCode 委派适配器和 stdio MCP 入口。
- 复用现有 Go provider 发送链、身份隔离、目标授权、预算、SSE 生命周期和脱敏能力。
- 不把 UHR 的只读意图/引用契约直接套成 Go 写任务；为代码任务单独定义读写范围、工作区和工具权限。
- 初期只允许明确的 Go provider/model，先实现单任务，再实现同 session follow-up、wait、cancel。
- 使用本地双 mock 验证，不使用真实订阅额度。

### P0-C：完成任务等待、恢复与父端回执

若当前 native `spawn_agent` 实验保留为对照：
- 内层 `collaboration__wait_agent` 只负责短窗口等待。
- 当 Code Mode `exec` 返回运行中的单元 ID，父进程必须调用顶层 `wait({cell_id})` 收取该单元。
- 循环等待同一子 ID 的终态，不能把内层等待工具返回误认为子任务完成。
- 超时恢复先核对原生历史，避免重复 spawn/followup。
- 真实验收必须在一个未被外部测试器中断的 Codex 进程中完成初派、父端收取、同子追派、再次收取和父端最终文本回执。

在推荐的 MCP 路径中，以上语义由 `modelgate_wait_task` 和持久化 taskRef 承担；同样必须区分“等待超时”与“任务终态”。

### P1-A：V2 密文边界

- 继续拒绝不可读 `encrypted_content` / `encrypted_task_id` / 不可读工具参数。
- 不解密、不伪造、不静默删除密文、不自动切换 V1。
- 明文委派只能通过显式 MCP 工具参数或已被官方证明可读的客户端路径。
- 若已有 `plaintextTools + agentMessage=project` 投影配置，必须保留明确的 lossy 记录和空信封拒绝；不能把“保留少量文本”误报成完整任务交付。
- 任何新路径都要证明任务正文完整到达 Go，而不仅仅是子代理启动。

### P1-B：SSE/预算生命周期

- 保持请求预算、并发槽位和上游流在完整终态之前有效。
- 补齐 `response.completed`、`response.failed`、无终态、上游提前 close、客户端断开、取消、整体 deadline、长时间首字节和长流场景。
- 确保每条请求最多一个终态；超时返回 504 或一个失败终态，不重复写终态。
- 用同一份投影 body 对比 Go 的 TTFB、总耗时和 ModelGate 中转耗时。

### P1-C：管理 GUI

- CLI/MCP 完整验收前，不启动新 GUI 大改。
- `/ui-next` 仍作为预览，不改默认入口。
- `console-v1.md` 是纸面契约，不标记为已实现。
- CLI Gate 通过、管理 API 契约冻结后，再独立启动新 GUI 任务；Desktop 另设验收矩阵。

---

## 5. 分阶段执行计划与验收门槛

| 阶段 | 工作 | 完成条件 |
|---|---|---|
| G0 现场冻结 | 检查分支、worktree、未提交改动、资源门禁；核对 release 与 main 的 246 个提交差异 | 有基线 SHA、写集、分支图和差异清单；不改用户工作树 |
| G1 认证边界收口 | 退役 `gatewaySubscription` / `local-subscription` 生产路径；修正文档矛盾；保持 P07 SIWC 默认关闭 | 无 auth.json 读取；无本机 Codex token 发往 ModelGate；回归测试证明 |
| G2 Go MCP 委派契约 | 定义工具 schema、provider allowlist、任务状态机、幂等、权限、结果形状 | 合同 fixture、拒绝矩阵、数据流和威胁模型通过审查 |
| G3 MCP MVP | 实现 stdio MCP server、delegate/get/wait/cancel；复用现有 Go Responses provider | 双 mock 端到端；Codex 能调用工具；任务只发送一次 |
| G4 同 session 追派与恢复 | 实现 followup、父会话恢复对账、结果 ack、未知状态对账 | 同一 task/session 两轮随机挑战均成功；重启不重复派发 |
| G5 安全与协议验收 | V2 opaque fail-closed、Go key 隔离、工具输入上限、SSE 终态/取消/超时 | 负向测试零上游命中；所有敏感头隔离；SSE 终态唯一 |
| G6 CLI 真实验收 | 用户明确授权后，以原生 Codex 登录直连 GPT，MCP 委派到真实 Go | 一次连续父会话完成两轮委派、父端收到结果、父端正常退出；记录脱敏收据 |
| G7 Desktop | 独立 profile/实例与 GUI 测试，不碰日常配置 | Desktop 独立证据，不从 CLI 结果推断 |
| G8 GUI 与发布整合 | 冻结 API 后开发 GUI；完成 release 分支 diff 审查、PR、迁移和回滚计划 | 所有者审阅并批准后才合并/发布 |

### 必须运行的本地门禁

在不安装新依赖的前提下，至少执行：

```bash
npm run check
npm test
npm run docs:check
node scripts/check-metadata.mjs
git diff --check
```

真实上游测试必须单独授权，不能混入默认 `npm test`。任何因缺少授权、网络隔离或环境不具备而未运行的测试，标记 `NOT_RUN` / `BLOCKED_ENV`，不得伪称 PASS。

### 真实端到端验收标准

1. Codex CLI 使用用户自己的官方登录，父 GPT 请求直接到官方服务；ModelGate 不在父请求链路中。
2. 父模型通过本地 MCP 工具创建 OpenCode Go 子任务；Go 端只收到 Go 自己的凭据。
3. 第一次随机挑战只在初派任务中出现，第二次随机挑战只在同一子 session 的 follow-up 中出现。
4. 两轮子任务都执行实际工具，并返回可核验的结果/产物哈希。
5. 父模型收到两轮完整工具结果后正常结束；不能只证明 Go HTTP 200。
6. 恢复同一父会话后，不重复执行已经成功的任务；未知发送状态进入对账。
7. 取消、超时、Go 429/5xx、流中断和父进程恢复均有可复现测试。
8. 真实凭据、请求正文和 token 不进入 Git、测试日志、报告或 CI artifact。

---

## 6. Git、资源与执行纪律

- 当前执行起点是 `integration/modelgate-release@c6d97da`，不是 main。
- 先读 `AGENTS.md`、`RESOURCE_APPROVAL.md`、README、开发计划和相关 ADR。
- 在隔离 worktree/分支执行；不在共享主工作树上 reset、clean、强制 checkout 或覆盖用户改动。
- 不直接合并 PR #5/#6，不把 246 个提交一次性盲合并到 main。
- 每个工作流/子代理明确文件所有权，避免多人同时修改 `src/index.js`、`src/router.js` 等共享核心文件。
- AgentTeam 最多 5 个子代理；先划分独立研究/实现/QA 写集，再并行。合并前由主执行者检查冲突、接口契约和证据。
- 不安装新依赖、不下载模型权重、不启动 Docker/浏览器包下载；确需新增资源时先检查本机已有版本/缓存/重复下载风险，再提交资源清单并等待用户明确批准。
- 不触碰生产 8787、systemd、真实 `~/.codex/config.toml`、`auth.json`、sessions 历史或用户日常 Desktop 配置。
- 真实 Go 测试可能消耗订阅额度；未获得该轮明确授权时只跑 mock。
- 不在未获用户批准时 push、开 PR、合并、打 tag、release 或部署。

---

## 7. 执行 AI 启动提示词

以下提示词用于从当前仓库状态继续工作，不允许重新规划一套与本方案无关的路线：

> 你负责继续实施 ModelGate。仓库地址：**https://github.com/xiaomengxizzh/model-gate**。
>
> 当前执行基线：`integration/modelgate-release`，审计提交 `c6d97dabf871c10046d2b174d11b3401bd5d46d8`。先读取 `AGENTS.md`、`RESOURCE_APPROVAL.md`、`docs/development-plan.md`，再完整阅读本方案：
> `docs/roadmap/2026-11-13-modelgate-native-delegation-resolution.md`。
>
> 本方案是本轮已确定的方向基线。不要把 main 的旧状态当成最新实现，也不要把 Draft PR #5/#6 当成已经合并。先核对当前 HEAD、分支、worktree、未提交改动和 release 相对 main 的 246 个提交差异，建立隔离工作树；严禁覆盖用户已有改动。
>
> **核心目标：GPT 父模型继续由用户自己的 Codex 官方客户端原生登录并直连官方服务；ModelGate 不读取 Codex `auth.json`、不转发 ChatGPT token、不代理 `chatgpt.com/backend-api/codex/responses`。ModelGate 负责 OpenCode Go 子任务，优先通过仅本机使用的 stdio MCP 工具提供 delegate/get/wait/followup/cancel 能力。** 这是工具驱动的外部 worker 委派，不得谎称为 Codex 原生跨 provider `spawn_agent`。
>
> 先处理 P0：核对并退役 `gatewaySubscription` / `src/codex/local-subscription.js` 的生产认证路径，修复与 11 月 12 日 F01 安全结论的文档冲突；随后定义独立 OpenCode 委派 MCP 契约、任务状态机、幂等和恢复机制。复用现有 OpenCode Go provider、Responses 转发、目标授权、SSE 生命周期、会话头和预算逻辑，不重复实现已有能力。保持 V2 密文 fail-closed，不解密、不伪造、不删密文、不静默降级 V1。
>
> AgentTeam 最多 5 个子代理，按文件所有权和依赖分工，使用独立 worktree；共享核心文件只由指定负责人修改。至少安排独立 QA 审核认证边界、任务生命周期、协议映射和回归证据。先完成本地双 mock 和离线测试，再申请真实 Go/Codex 验收；未经用户当轮授权不得消耗真实额度。
>
> 不安装依赖、不下载模型/大型资源、不启动生产服务、不改用户 Codex 配置、不读取/复制/写入 `auth.json`，不修改 systemd/8787，不 push、不合并、不发布。依赖盘点和资源授权严格遵守 `RESOURCE_APPROVAL.md`。
>
> 交付时必须提供：实际修改文件清单、逐项测试命令与 exit code、测试数量、真实/Mock 证据分级、未完成项、风险、回滚点、当前百分比进度和下一步唯一阻断。不得把 mock 通过写成真实上游通过，不得把子代理 HTTP 200 写成父端任务闭环。
>
> 不要再次停下来做泛泛的架构规划；按本方案 G0→G8 推进。若发现本方案与当前代码或官方文档冲突，先给出可复现证据和最小修正建议，不能静默改变架构边界。

---

## 8. 官方资料与仓库依据

### OpenAI 官方资料（审计日 2026-11-13）
- [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
- [Codex app-server — Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [SIWC Preview Limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Request a client ID](https://developers.openai.com/siwc/request-client-id)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)

### 仓库证据
- [当前 release 候选](https://github.com/xiaomengxizzh/model-gate/tree/integration/modelgate-release)
- [审计基线提交 c6d97da](https://github.com/xiaomengxizzh/model-gate/commit/c6d97dabf871c10046d2b174d11b3401bd5d46d8)
- [11/13 真实子代理验收](https://github.com/xiaomengxizzh/model-gate/blob/integration/modelgate-release/docs/evidence/2026-11-13-modelgate-native-live.md)
- [11/13 完整链路进度](https://github.com/xiaomengxizzh/model-gate/blob/integration/modelgate-release/docs/evidence/2026-11-13-modelgate-native-flow-progress.md)
- [11/12 加固交付报告](https://github.com/xiaomengxizzh/model-gate/blob/integration/modelgate-release/docs/evidence/2026-11-12-closure/delivery-report.md)
- [Codex V2 子代理边界](https://github.com/xiaomengxizzh/model-gate/blob/integration/modelgate-release/docs/explanation/codex-v2-agents.md)

**文档结论：当前技术成果值得保留，但不应继续沿着“读取 Codex auth.json → ModelGate 代理 ChatGPT 订阅端点”的路径产品化。先收紧认证边界，再用本地 MCP 委派把 GPT 父模型与 OpenCode Go 子任务连接起来。**
