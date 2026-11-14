# Codex 原生父子代理与订阅路由

适用版本为原版 Codex CLI/app-server 0.167.0。新增大型安装/下载为无。Desktop 捆绑版本另行验收。

## 为什么采用一个 Codex Provider

原版 Codex 创建子代理时从父 turn 继承 Provider。V1、V2 的派发参数可指定模型。角色配置覆盖模型、推理力度等字段，覆盖清单没有 `model_provider`。App-server 的 `thread/start.modelProvider` 可用于开启另一条顶层会话，不能替代同一父代理的原生派发。两个 thread 分别指定 Provider 无法建立目标父子关系。依据 [0.167.0 子配置源码](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/agent/child_config.rs#L120-L163)、[角色配置源码](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/agent/role.rs#L35-L91)、[官方子代理配置](https://learn.chatgpt.com/docs/agent-configuration/subagents) 和 [Provider 边界 ADR](adr-0003-codex-role-provider-boundary.md)。

在 Codex 配一个自定义 Responses Provider 并指向本机 ModelGate。父模型与子模型使用不同的显式 ID，由 ModelGate 选上游。Codex 负责创建原生子线程、派发、执行工具、等待、同子追派、历史和恢复。网关的写集限于模型目录、按模型的路由、协议适配、流转发和运行指标。单个自定义 Provider 可用于 CLI 或 app-server，app-server 适合后续自有本地界面，原版 Codex 继续运行实际代理。 [App-server 协议](https://learn.chatgpt.com/docs/app-server) · [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

以下是直接协作时的客户端配置形态。地址、目录和模型 ID 用隔离实例生成的实际值。入口凭据由调用环境提供。

```toml
model_provider = "modelgate"
model = "<SIWC 账号可用 GPT 模型>"
model_catalog_json = "<隔离模型目录的绝对路径>"
web_search = "disabled"

[model_providers.modelgate]
name = "ModelGate"
base_url = "http://127.0.0.1:<隔离端口>/v1"
env_key = "MODELGATE_CLIENT_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[features]
multi_agent = true
multi_agent_v2 = false
code_mode = false
```

将 GPT 父模型的目录条目设置为 `tool_mode="direct"`、`multi_agent_version="v1"`、`supports_search_tool=false` 和 `use_responses_lite=false`。0.167.0 使用 `supports_search_tool` 决定是否公开 `tool_search`，为 false 时直接声明 V1 协作工具。 [原生工具发布逻辑](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/spec_plan.rs#L1569-L1576)

模型目录保留 GPT 父模型的原始 ID，并为 Go 子模型生成聚合 ID，例如 `mg-opencodego-deepseek-v4-1-flash`，实际名称以生成目录为准。公开 SIWC 路由、凭据存储与发行后的正式体验仍按下方条件验收。

## 两个独立的授权域

- **GPT 父路由**使用应用经 Sign in with ChatGPT 获取的 ChatGPT 套餐授权。官方方案为本地开源应用注册自己的 OAuth client、由用户选择账号和工作区并授予 `resource.invoke` 与 `chatgpt.tokens.use.direct`，再向 `https://api.openai.com/v1/responses` 发送 HTTP SSE 请求。父模型先用同一授权查询账号目录，选择可用的 GPT ID。 [SIWC 授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [官方 app-server 接入](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- **DeepSeek 子路由**使用独立 Go 工作区 Key，Responses 路径按 Go 当前文档为 `https://opencode.ai/inference/go/openai/v1/responses`，携带稳定的子会话 ID。上一轮真实回执使用当时配置的 `/inference/go/v1/responses`。2026-11-14 公共目录返回 30 个模型，其中包含 `deepseek-v4.1-flash`。真实验收仍需用独立 Go 授权对账实际返回的模型。 [Go 公共模型目录](https://opencode.ai/inference/go/v1/models) · [OpenCode Codex 接入](https://opencode.ai/docs/console/harnesses/codex/) · [OpenCode Harness 认证和路径](https://opencode.ai/docs/console/harnesses)
- Codex 进程只拿本机 ModelGate 入口凭据。作为 OAuth 客户端，本地集成在独立授权存储中续期，并把短期令牌交给固定的 OpenAI 父路由。该路由只允许 HTTPS 的 `api.openai.com/v1/responses`，拒绝重定向与跨授权域回退；将已发请求的错误或流终态送回 Codex。刷新令牌留在授权方，Go 不接收订阅 token 或 ChatGPT 账号头。父路由的账户授权必须由用户授予和可撤销。
- 既有 `gatewaySubscription` 读取 Codex 本机登录态，并走 `chatgpt.com/backend-api/codex`。它只对应 [上次经用户授权的隔离实验](../evidence/2026-11-13-modelgate-native-live.md)。OpenAI 的 app-server 示例将订阅授权直接交给 app-server 并连接公开 Responses。通过 ModelGate 聚合是基于文档中允许应用直接请求公开 Responses 的集成方案，仍需验证实际模型、客户端归属和请求约束。P07 已有合成 OAuth 单元，接入正式父路由前，需要实现官方动态注册，使用 `ext_agent_host_id` 和 `agent_name_hint`，接入回调签发的 client ID，在代码交换及刷新时带上 `resource=https://api.openai.com/v1`，用 JWKS 验签，并按客户端注册和已验证的主体分别保管令牌。P07 当前未开启真实登录。 [OpenAI 授权续期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

## 为什么分开验证等待与官方推理

上轮真实 V2 用 Code Mode 发送可读任务。内层 `collaboration__wait_agent` 超时与外层 `exec` 单元让出是两个事件。单元让出后须用顶层 `wait` 收取对应 `cell_id`。只有目标子代理的完成消息和工具回执齐备，父代理才可追派或结束。 [等待工具源码](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/code_mode/wait_spec.rs) · [原生消息生成](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L54-L67)

公开 SIWC Responses 预览支持 Codex 本地工具和子代理。顶层工具 `programmatic_tool_calling`、`tool_search`、请求字段 `multi_agent` 及若干托管能力超出当前预览范围。已证的 V2 Code Mode 实验不能直接迁移到该端点。V2 直接消息 schema 仍含 `encrypted` 标记，不能预期公开路由会产生 Go 能读的任务。优先单独核验原生 V1 直接工具 `spawn_agent → wait_agent → send_input → wait_agent`。两轮明文任务都走 Codex 内部会话，保留原生工具调度和相同子 ID。明确选择模式，运行中不得自动切协作版本。必须按真实请求核对公开预览契约，包括原版请求携带的客户端元数据及其序列化结果。原版源码同时含 `client_metadata` 和会话缓存键，只有官方请求结果才能确认实际是否接受。 [0.167.0 请求构造](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/client.rs#L1150-L1172)

若当前版本的原生直接工具仍不能通过公开契约，先寻求 Codex 上游支持，如预览专用 tool schema 或角色 Provider 覆盖；app-server 或 SDK 包装本身不会改变原生继承和工具声明。 [预览约束](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [0.167.0 原生工具声明](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)

## 父代理启动指令

> 本会话只创建一个原生子代理。使用指定的 Go 模型别名，初派只发任务 A，关闭完整历史分叉。保存工具返回的子 ID 或路径。调用当前协作版本的原生等待工具。等待超时只表示本次等待结束。若 Code Mode 返回仍在运行的单元，立即用顶层 `wait` 收取同一 `cell_id`，直至单元结束。只有收到该子代理的终态和任务 A 的工具结果后，才向同一子代理发送一次任务 B。再次等待并核对任务 B，最后报告两个结果和同一子标识。遇到等待预算耗尽或工具错误，返回已有回执与错误，避免重复派单。任务 A、B 只由原生消息交给子代理。

V1 的对应工具为 `multi_agent_v1.spawn_agent`、`multi_agent_v1.wait_agent`、`multi_agent_v1.send_input`。V2 Code Mode 使用 `collaboration__spawn_agent`、`collaboration__wait_agent`、`collaboration__followup_task`，另以顶层 `wait` 收取让出的单元。

## 2026-11-14 本机运行证据

使用原版 Codex 0.167.0、单一自定义 ModelGate Provider 和两套回环上游。Linux 网络命名空间只启用 loopback。父 GPT mock 请求使用 `/v1/responses`，Go mock 使用实际模型 ID `deepseek-v4.1-flash`。Codex 到网关、网关到 GPT mock、网关到 Go mock 使用三个不同的合成凭据。一次进程内收到 A 后才向同一子 ID 追派 B，两个回合均执行了 Codex 本地工具，父端收到两次等待结果并正常结束。V1 验收通过 11/11。子代理 B 的请求包含 A 的任务、工具调用、成功输出和子终答。父线程正常结束后，另外用同一个 Provider 执行原生 `resume` 验证父端 A/B 历史仍可读，子请求数不变。原有 V2 直接派发夹具复跑 7/7。

本轮另用回环上游复现了 V2 一进程两轮任务。一次运行的脚本直接完成，未走外层等待。设置 500 ms 让出阈值后记录了同一单元的重复顶层等待，但该次未收到子推理请求。V2 Code Mode 的让出和收取闭环仍未通过。

父请求使用 `store:false`、`stream:true`。还观察到 `client_metadata`、`prompt_cache_key`、`reasoning`、`include`、`text` 等字段。最终验收夹具只声明 `custom`、`function` 与 `namespace` 三种工具类型。目前只通过本地检查对照公开文档列出的 HTTP 形态和禁用字段、工具；账号实际允许的模型、功能和用量须在真实应用授权后确认。

复现 V1 隔离验收时，把下列命令中的 Node 和 Codex 路径替换为本机已安装的可执行文件。命令须在 ModelGate 仓库内运行。

```bash
unshare -Urn sh -eu -c '
  ip link set lo up
  test -z "$(ip route show default)"
  test -z "$(ip -6 route show default)"
  exec env -i PATH=/usr/bin:/bin LANG=C.UTF-8 MGR_E2E_NETWORK_ISOLATED=1 "$@"
' sh /absolute/path/to/node scripts/test/codex-e2e.mjs --native-v1 \
    --codex /absolute/path/to/codex
```

## 从公开预览到真实验收的顺序

1. 用原版 Codex 与两个回环 mock 锁定直接工具和完整本地会话行为。保留父请求字段与工具类型摘要，检查上游未支持字段和工具，验证子线程收件、工具回填及追派。
2. 对齐并接入 P07 的独立应用授权。以已授权账号目录和一条无工具的合成请求核验 GPT 套餐可用性，再检查原生工具请求。若端点拒绝必需字段或工具，保留错误的 `code` 与 `param`。若缺公开客户端扩展点，向 Codex 上游申请支持。
3. 已验收路径固定父、子上游与授权域，通过同一个 Codex 进程跑 A、B。授权前核对模型与账号，验收后关闭临时服务。后续独立验证恢复及上下文。

## 真实验收条件

1. 使用独立应用授权与 Go Key，在隔离目录运行原版 Codex。父端使用公开 Responses，Go 端使用 Go 官方 Responses。记录实际模型、目标、状态和鉴权域，收据只保留脱敏字段。
2. 同一个 Codex 进程调用一次原生初派、一次同子追派。分别只在派单正文放随机 A、B。Go 收到对应任务，子代理运行原生 shell 工具并回填。父端分别等到同一子 ID 的两次完成，最终回执同时核对 A、B，各次响应完整，进程正常退出。
3. 在单独用例中另验原生会话恢复和上下文保留。核对回执已存在时不会重复派发。正式闭环不靠进程重启。Desktop 和托管能力按各自入口及官方约束记录。
