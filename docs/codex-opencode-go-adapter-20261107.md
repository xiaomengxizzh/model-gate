# Codex ↔ ModelGate ↔ OpenCode Go（实验性接入指南，2026-11-07）

> 状态：**Draft / 未实机验收**。这是 ModelGate 自有适配层，不依赖 CC Switch，且不修改 Codex 官方登录文件。项目资源门禁：新增大型软件/模型下载 **无**；一切安装/更新之前先审查本机与共享缓存，未取得用户授权不得下载。参见 `AGENTS.md` 与 `RESOURCE_APPROVAL.md`。

## 目标与边界

- 使用 Codex 桌面端 / CLI 原生 Responses 协议请求 **ModelGate** (`POST /v1/responses`，同样支持 `/responses`)。
- ModelGate 使用现有 Node.js HTTP 转发模块、现有 Key 环境变量、已有供应商配置，通过 `codexWire: "chat"` 把 OpenAI Responses 输入映射到 OpenCode Go 的 Chat Completions；或者通过 `codexWire: "native"` 使用上游原生 Responses。
- 把 Chat SSE 转回 Responses SSE，支持基础文本、function_call、function_call_output 和 Codex 常见的 custom_tool_call；稳定转发 `session-id` / `thread-id` 至 `x-opencode-session`。保留 429 原始状态码和 `Retry-After`，**适配层单次请求，不进行第二次内部重试**。
- **不**读取/重写 `~/.codex/auth.json`、不修改生产 8787 配置、不直接合并到 main、不安装依赖、不替 Codex 管理 ChatGPT OAuth。保留官方登录 != 通过 ModelGate 使用 ChatGPT 套餐模型；后者另行实现。
- 这是不改变传统 `/v1/chat/completions` 路由逻辑的单独入口；模型必须在 `models` 下显式配置，未知模型 404。为防绕开既有额度、虚拟模型和 fallback，第一阶段检测到上述治理配置时返回 422，待后续统一路由再启用。

## 推荐对照验证顺序（先隔离配置；不要替换现有生产入口）

1. 先对宿主环境做存在性检查：`node --version`、`command -v node`、已有 ModelGate 进程/端口、现有 `config/gateway.local.json`、Codex CLI/桌面端现有配置。没有访问宿主时标记 `UNKNOWN_LOCAL_STATE`，不执行任何新安装。
2. 使用独立的、受保护的 ModelGate **开发实例（例：8788）**；复用 Node 与现有代码。确保测试实例和生产使用**不同的配置目录、日志、数据面 Key 和端口**，避免并发覆盖。
3. 在 **仅供开发实例** 的本地配置中添加以下示例片段；不要向 Git 提交真实 API Key：

```json
{
  "providers": {
    "opencode-go": {
      "baseUrl": "https://opencode.ai/inference/go",
      "apiKeyEnv": "OPENCODE_API_KEY",
      "api": "openai",
      "codexWire": "chat",
      "opencodeSession": true,
      "omitStreamOptions": true,
      "omitReasoningEffort": true
    }
  },
  "models": {
    "deepseek-v4.1-flash": { "provider": "opencode-go" }
  }
}
```

这只是新增片段，须合并到现有 `gateway.json` / 私有配置，不能覆盖原有服务。只有确认在 DSH 上成功的**同一个 Go 模型 ID、账户与端点**后才用于真实验证。不同账户或供应商的 Key 可能不通用；上述端点路径应以 OpenCode Go 最新模型接口实际返回为准，不能靠修改路径来绕过产品授权。

4. ModelGate 接入 Codex 的配置示意（先备份，再仅在**测试 profile** 试用）：

```toml
[model_providers.modelgate]
name = "ModelGate"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
# 数据面启用 MG_CLIENT_KEY 时按 Codex 当前版本配置 env_key = "MG_CLIENT_KEY"
# 若客户端要求环境变量 token，优先使用单独的本地测试 Key，不要把 OpenCode Go Key 填在这里。

[profiles.modelgate-deepseek]
model = "deepseek-v4.1-flash"
model_provider = "modelgate"
```

请先对照你实际 Codex 的 `config.toml` 版本确认配置字段。不要自动覆盖默认官方 profile，不要修改 `auth.json`。Codex 桌面端是否按 CLI profile 切换，需实机验证。

5. 首先做一条最小的非流式请求（携带固定会话头、模型名和数据面 Key），再做流式文本请求、连续多轮同一 session、function_call、custom_tool_call（尤其 `apply_patch`）、客户端取消和长上下文。**再**在 DSH 同账户同模型同时间做对照，比较上游 HTTP 状态、响应体、`Retry-After`、Session ID、模型路径；脱敏后记录证据。
6. 若真实 Go 返回 429，保持原样并记录上游响应信息；若返回 400，优先从脱敏响应体查是否是 `stream_options`、`reasoning`、tools、请求格式或会话绑定；不把 429 当成需要无限指数退避的网络错误。

## 实现路径

- `src/codex-responses.js`：Responses 输入 / Chat 请求及 Chat 输出 / Responses 输出；SSE 事件包装，带工具调用。
- `src/codex-handler.js`：独立路由、上游 Key 注入、会话头传递、上游协议选择、429 原样透传、治理门禁。
- `src/index.js`：鉴权后分流 `POST /v1/responses` 和 `POST /responses`。
- `src/request.js`：只对显式 `noRetry429` 生效，传统 Chat 转发不变。
- `tests/codex-responses.test.mjs`：纯 Node 内置模块测试。运行 `node --test tests/codex-responses.test.mjs`，无需 `npm install`。

## 第一阶段未覆盖和验收门禁

- **不是完整 Responses API**：图像以外的多模态输入、复杂推理状态、compaction、`previous_response_id`、严格 JSON schema、所有 OpenAI API tools、WebSocket、会话恢复、全部事件类型和特殊 token 使用明细尚未通过真实 Codex 验证。未支持字段应明确失败，禁止丢数据后伪装成功。
- SSE 流转换事件的顺序、工具调用增量和结束事件需真实 Codex SDK/桌面端双向测试。只通过单元模拟，不代表模型已能可靠执行 shell/apply_patch。
- 第一阶段**不支持**带额度、跨模型 fallback、默认目录、虚拟模型的 Responses 路由（返回 422）。后续应将 Responses 接入现有 `forwardChain` 治理而非长期旁路；还需补统计计费、熔断和 per-provider QPS。
- 不应发布“已支持所有模型”或“DeepSeek 429 已解决”：当前只有协议适配与限流放大防护；上游 429 仍可能出现。缺真实用户客户端与真实 Go 请求时验收状态为 **NOT_RUN_LIVE**。
- 因 `stream_options` 在 Chat 路径可能触发 400，第一阶段默认示例显式移除。通过实际对照确认能力后再开启。
- 继续保留完整生产回滚路径：关闭测试实例、撤销测试 profile 或改回原有模型，回滚 Git 分支即可；不得自动杀掉 8787 上正在运行的其他进程。
- **下一阶段**：先补真实 Codex 请求捕获、mock wire contract、工具调用循环测试，再打通 Responses 与原有额度/限流/统计；最后做 GUI 中 Provider/Model 配置管理与一键备份恢复（保留官方身份认证）。

## 测试证据口径

2026-11-07：隔离 Node 22.16.0 原型中，8 项 mock/单元测试 PASS；**不含**真实 Codex 桌面端、OpenCode Go 或完整仓库集成测试。真实 GitHub CI 状态单独检查。所有环境安装状态依照用户资源门禁判断，不能假定本机已有或缺少任何程序。
