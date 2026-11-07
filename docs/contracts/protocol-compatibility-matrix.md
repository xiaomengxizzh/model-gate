# 协议兼容矩阵 v1（2026-11-07）

> 基线 `main@6bc6441`。本矩阵描述**网关能力**，不代表已对真实客户端/真实上游完成实机验收；实机项一律标 `NOT_RUN_LIVE`。
> 证据等级：`PASS_MOCK`＝离线 mock 断言通过；`STATIC`＝代码/配置审计；`NOT_RUN_LIVE`＝需真实 Key/宿主。

## 1. 入口 × 上游 wire

| 客户端入口 | 网关 wire | 上游 `provider.api` | 支持度 | 说明 |
| --- | --- | --- | --- | --- |
| `/v1/chat/completions` | chat | `openai` | ✅ PASS_MOCK | 原生直通，保留 reasoning/tool_calls/usage |
| `/v1/chat/completions` | chat | `anthropic` | ✅ 静态 + 既有测试 | `format.js` 直连桥；工具 + 流式会降级为非流 JSON 再转 SSE（`asSSE`），已知语义损失 |
| `/v1/chat/completions` | chat | `gemini` | ✅ 静态 + 既有测试 | 同上 |
| `/v1/chat/completions` | chat | `responses` | ❌ 422/跳过 | Chat 请求不会落到 native-only 模型（wire 维度过滤） |
| `/v1/responses` | chat（桥接） | `openai` | ✅ PASS_MOCK | 文本/工具/custom tool/usage/事件顺序均验证 |
| `/v1/responses` | chat（桥接） | `anthropic` / `gemini` | ⚠️ 部分 | 文本可桥接；工具 + 流式同样走 `asSSE` 降级；`reasoning` 不保留 |
| `/v1/responses` | native | `responses` | ✅ PASS_MOCK（mock 直通） | 字节直通，不改写事件；真实 Codex 桌面未验证 `NOT_RUN_LIVE` |
| `/v1/responses` | native | 非 `responses` | ❌ 422 `wire_mismatch` | 不静默降级 |
| `/v1/responses` | chat | 模型声明 `responsesWire=native` | ❌ 跳过该模型 | 防止 fallback 把 Chat body 发到 Responses 端点 |

## 2. 客户端 × 能力

| 客户端 | 使用入口 | 工具闭环 | 流式 | 会话头 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Codex CLI / 桌面 | `/v1/responses`（`wire=chat` 或 `native`） | function_call / custom_tool_call、`call_id` 保留、参数拼接 | ✅ 事件顺序契约 | `session-id`/`thread-id` 透传（provider 开启 `passthroughSession`/`opencodeSession`） | `PASS_MOCK`；实机 `NOT_RUN_LIVE` |
| DSH（DeepSeek Harness） | `/v1/chat/completions` | tool_calls / usage | ✅ | `x-session-id`/`x-conversation-id` | 既有行为回归 `PASS_MOCK`；DSH 实机 `NOT_RUN_LIVE` |
| OpenCode Go | Chat 或 Responses | 取决于上游 | ✅ | `x-opencode-session` / Codex session 头（需 provider 标记） | `STATIC`（PR #2 文档 + 代码）；实机 `NOT_RUN_LIVE` |
| OpenAI SDK / curl | Chat | ✅ | ✅ | 可选 | `PASS_MOCK` |
| 任意 OpenAI 兼容客户端 | `/chat/completions`（无 `/v1`） | ✅ | ✅ | — | 路径别名，`PASS_MOCK` |

## 3. Provider 字段（协议维度）

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `api` | 上游 wire：`openai` / `anthropic` / `gemini` / `responses` | `openai` |
| `baseUrl` / `pathPrefix` | 端点前缀；重复 `/v1` 已归一 | — |
| `extraHeaders` | 额外请求头；管理面回显掩码，保存 `****` = 不改 | `{}` |
| `proxy` | `http(s)://user:pass@host:port`；回环地址自动直连 | 继承 `defaults.proxy` |
| `circuit` | `{maxFailures, openDurationMs}` | `{5, 10000}` |
| `passthroughSession` / `opencodeSession` | 透传会话头白名单（不含 Cookie/鉴权） | `false` |
| `apiKeyEnv` | 环境变量名（非值），用于免落盘 Key | — |

## 4. 模型字段（路由/能力维度）

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `provider` / `fallbacks` | 主上游 / 备用上游 | 必填 |
| `alias` | 客户端可用别名 | `[]` |
| `quota` / `dailyQuota` / `maxContext` | 累计/日额度、上下文估算上限；超限按目录链切换 | `0`=不限 |
| `maxConcurrent` / `qps` | 模型级并发/QPS | `0`=不限 |
| `reasoning` / `effortOptions` / `effortFormat` | 思考强度默认值、允许档位、参数形态（`reasoning_effort`/`thinking`） | `''`/`[]`/`reasoning_effort` |
| `responsesWire` | `chat`（桥接）或 `native`（直通） | `chat` |
| `upstreamModel` | 发给上游的真实 model id（与网关暴露名分离） | 模型名 |

## 5. 已知缺口（不在本轮假装完成）

1. **真实 Codex CLI/桌面 + OpenCode Go 实机**：无合法凭据/成本授权，`NOT_RUN_LIVE`。
2. **原生 Responses 的真实上游**：只有 mock 直通；上游事件顺序、`store`、`previous_response_id` 服务端状态、`include` 未验证。
3. **Responses → Anthropic/Gemini 工具流**：受 `format.js` 桥降级限制，工具 + 流式会变成非流 JSON 后由网关补发 SSE，事件粒度非原生。
4. **Responses 多轮服务端状态**：无 `previous_response_id`/`store` 服务端存储；要求客户端回传完整历史（显式 422）。
5. **图片输入**：Responses `input_image` 仅在 Chat 桥接为 `image_url`，未对多模态上游做端到端验证。
6. **成本**：无可靠定价不计算/不展示金额（仅 token）。
7. **DSH 插件真实端点**：以用户实际版本再核验，本文件不固化未经证实的 URL。

## 6. 脱敏后的失败样本规范

提交 issue/PR 时，上游失败样本必须：

1. 删除 `Authorization`、`Cookie`、`x-api-key`、代理 userinfo、会话 ID；
2. 保留：HTTP status、`error.type/code`、`Retry-After`、`content-type`、上游模型名、`x-mg-trace-id`、`x-mg-attempts`；
3. 请求体只保留结构（如 `stream=true`、`tools` 数量），不保留 prompt 正文；
4. 标注采集时间、客户端版本、网关 SHA、wire（`chat`/`native`）。

示例（合法）：

```json
{
  "status": 429,
  "headers": { "retry-after": "20", "content-type": "application/json" },
  "body": { "error": { "type": "rate_limit_error", "code": "rate_limited" } },
  "gateway": { "sha": "6bc6441", "trace_id": "…", "attempts": 3, "wire": "chat", "model": "gpt-5.6-codex" }
}
```
