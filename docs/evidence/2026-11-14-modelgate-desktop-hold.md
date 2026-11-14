# ModelGate × Codex Desktop 暂停报告

2026-11-14（北京时间）。按用户要求暂停联调。验收目标是在原版 Codex 桌面端，由使用 ChatGPT 套餐的 GPT‑6 Luna 创建原生子代理，将任务交给 OpenCode Go 的 `deepseek-v4.1-flash`，等待工具和任务结果，向同一个子代理追派，再正常结束。ModelGate 是模型网关。桌面端仍由 Codex 管理代理、工具、上下文、会话与恢复。新增大型安装或下载为无。

## 已验证到哪里

| 项目 | 现场结果 | 证据边界 |
| --- | --- | --- |
| 原版桌面加载 ModelGate | 已启动独立的桌面窗口与环回网关 `127.0.0.1:18787`。桌面发送合成探针，收到 ModelGate 的套餐授权缺失提示（HTTP 401）。独立 Codex 会话元数据记录 `originator=codex_work_desktop`、`cli_version=0.167.0-alpha.3.2`、`model_provider=modelgate`。 | 证明原版桌面发送到了网关并经过了父路由的授权检查。桌面没有拿到真实 GPT 回答。 |
| Go 真实端点 | 以现有 Go 授权向 `https://opencode.ai/inference/go/openai/v1/responses` 发送最小合成请求，HTTP 200，返回模型 `deepseek-v4.1-flash`，预期回执匹配。 | 证明 Go 端点、凭据和实际模型在本机可用。该探针直接调用 Go，未经过桌面子代理。 |
| 原生协作和恢复 | 上一轮原版 Codex CLI 0.167.0 + ModelGate + 两个回环模拟上游的 V1 用例通过 11/11。首次派发、两次真实 shell 工具执行、等待、一次同子追派、父端正常退出均通过。追派保留首轮上下文。另行恢复同一父会话，未产生新子请求。 | CLI 和模拟结果是协议与运行时证据。本次桌面真实双上游仍未验收。 |
| 旧订阅实验 | 上一次授权范围内的 V2 实验，GPT 父和 Go 子都收到真实上游响应，完成一次初派和一次同子追派。首次父进程在 Code Mode 等待阶段停滞，之后恢复同一父会话完成追派。 | 该实验调用 ChatGPT 私有 Codex 后端，且用到了恢复。独立应用授权和桌面单进程闭环尚未由此验证。见[旧实验报告](2026-11-13-modelgate-native-live.md)。 |

## 当前阻碍

第一次使用公开 Sign in with ChatGPT 注册 ModelGate，浏览器回调携带授权码，随后服务端令牌交换返回 HTTP 403，未生成本地授权记录。第一次实现只记录 HTTP 状态，**未捕获该次 403 的 OpenAI 错误码**。后来相同 token endpoint 的无效授权码探针在 Node 直连环境返回 HTTP 403 和 `unsupported_country_region_territory`。使用系统已配置的 HTTP 出站环境做同一无效码探针则返回 HTTP 400 `invalid_request`。这说明两种网络环境下请求进入了不同的校验阶段，不能据此认定真实授权已经可用，也不能把后续无效码探针的错误码当成第一次真实授权的定论。应以 OpenAI 支持的服务地区和工作区政策为准。 [OpenAI 地区说明](https://help.openai.com/en/articles/9131992-chatgpt-and-api-services-in-unsupported-countries-and-territories)

后续为 OAuth 失败增加了仅输出 HTTP 状态和受限错误码的诊断。第二次授权尝试已按用户暂停指令中止。尚未用有效应用授权从公开 Responses API 发出真实 GPT‑6 Luna 请求。该账号能否用应用授权选到 Luna、实际请求里的工具及客户端字段是否被接受，均待验证。

## 本轮采用的方案及原因

1. **原版桌面使用一个指向 ModelGate 的自定义 Responses Provider。** Codex 子代理继承父线程的 Provider。角色允许覆盖模型，不能覆盖 Provider。桌面配置以 `gpt-6-luna` 为父模型，以明确的原生 `go_deepseek` 角色选择 `mg-opencodego-deepseek-v4-1-flash`，由网关按模型绑定选择上游。原生 app-server 继续管理父子生命周期，桌面本身无需更换。 [Codex 官方子代理配置](https://learn.chatgpt.com/docs/agent-configuration/subagents)
2. **父、子使用独立授权。** 父路由拟使用用户授予 ModelGate 的 ChatGPT 套餐访问令牌，仅发送到 `https://api.openai.com/v1/responses`；Go 路由继续使用独立 Go Key。桌面只拿本机网关入口凭据。独立授权允许由账号本人授予和撤销，避免将现有 Codex 登录凭据加入第三方 API 链路。 [应用授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [公开推理端点](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
3. **使用 Codex V1 直接协作工具。** 当前公开套餐预览不接受顶层 `programmatic_tool_calling` 与 `tool_search`，上一轮 V2 Code Mode 还留下了让出单元未收取的问题。固定模型目录为直接工具、关闭 `supports_search_tool`，原版 Codex 会直接发布 V1 `spawn_agent`、`wait_agent`、`send_input`。真实桌面中的业务流程仍应验收两份工具回执、一个子 ID、一次追派和父端正常退出。 [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [详细方案](../explanation/codex-subscription-routing.md)

## 暂停时的交付与恢复点

独立桌面窗口和本机网关保留现场，未修改默认桌面配置，也未部署生产服务。本次用于验证的 Desktop launcher、公开 OAuth 和真实路由原型留在 `mg-codex-native` 本地工作树。它们尚未达到真实交付标准，和上一轮未提交的测试修改一起保留原样。远端只提交本次暂停报告及其方案说明。

恢复时先拿到符合 OpenAI 官方支持边界的有效应用授权，验证公开模型目录和一个 Luna 前台请求，然后在同一独立原版桌面会话中跑真实父子两轮。最终验收须同时核对桌面原生会话中一个子 ID、两次工具结果及终态，和网关两套真实上游的实际模型、授权域和流终态。
