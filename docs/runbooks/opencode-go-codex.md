# Codex / OpenCode Go 接入配置

> 目标：让 Codex（Responses 协议）与 OpenCode Go 通过 ModelGate 使用既有鉴权/额度/路由/统计/熔断。
> **本文件不包含真实端点、Key 或会话凭据**；OpenCode Go 的 `baseUrl`/`session` 语义以你实际使用版本的官方说明为准（`NOT_RUN_LIVE`）。

## 1. 两种 wire 怎么选

| 场景 | 配置 | 特征 |
| --- | --- | --- |
| 上游只有 Chat Completions | `models.<name>.responsesWire="chat"`（默认） | 网关把 Responses 转 Chat；工具/custom tool/事件顺序由网关重建 |
| 上游原生支持 `/v1/responses` | `responsesWire:"native"` + `providers.<id>.api="responses"` | 字节直通，事件原样 |
| 不确定 | 先 `chat` | 声明 `native` 但上游不是 Responses 会 `422 wire_mismatch`（不静默降级） |

## 2. 配置样例（占位值，需替换）

```json
{
  "providers": {
    "opencode-go": {
      "baseUrl": "https://<your-opencode-go-host>",
      "apiKeyEnv": "OPENCODE_GO_API_KEY",
      "api": "openai",
      "pathPrefix": "/openai/v1",
      "opencodeSession": true,
      "circuit": { "maxFailures": 3, "openDurationMs": 15000 }
    },
    "codex-native": {
      "baseUrl": "https://<your-responses-host>",
      "apiKeyEnv": "CODEX_API_KEY",
      "api": "responses",
      "passthroughSession": true
    }
  },
  "models": {
    "codex-chat": {
      "provider": "opencode-go",
      "upstreamModel": "<upstream-model-id>",
      "responsesWire": "chat",
      "effortOptions": ["low", "medium", "high"],
      "reasoning": "medium",
      "fallbacks": []
    },
    "codex-native": {
      "provider": "codex-native",
      "upstreamModel": "<upstream-model-id>",
      "responsesWire": "native"
    }
  }
}
```

要点：

- `upstreamModel` 把**网关暴露名**与**上游真实 model id** 分离（客户端看到 `codex-chat`）。
- `opencodeSession: true` 或 `passthroughSession: true` 才会把 `session-id/thread-id/x-codex-session-id/x-opencode-session` 透传给上游；Cookie/鉴权永不透传。
- `pathPrefix` 若与 `baseUrl` 重复 `/v1` 会被归一（不会双拼）。

## 3. Codex 指向网关

Codex 的 `base_url` 指到网关根（如 `http://127.0.0.1:8787`），模型名填网关暴露名（`codex-chat`/`codex-native`）。

- 网关不接受 `previous_response_id`/`item_reference`（无服务端会话存储），Codex 需回传完整 `input` 历史；否则 `422 unsupported_previous_response`。
- `local_shell` 工具在 `chat` wire 下不可保真 → `422`；需要时改用 `native` 上游，或让 Codex 用 function 形式的 shell 工具。
- `custom` 工具（如 `apply_patch`）在 `chat` wire 下被映射为「单 `input` 字符串参数」的 function，出站再还原 `custom_tool_call`。

## 4. 验证顺序（不烧额度 → 烧额度）

1. **离线**：`npm run test:offline`，确认 Responses 事件顺序/工具/call_id/usage。
2. **无上游成本**：`POST /api/route-preview {"model":"codex-chat"}` 看目录与 provider。
3. **最小真实请求**（需成本授权）：`POST /api/model-test {"id":"codex-chat"}`。
4. **Codex 会话**：非流式 → 流式文本 → 多轮 → shell/apply_patch 闭环 → 长上下文 → 取消。
5. 每一步保存脱敏日志（见协议矩阵 §6）：`x-mg-trace-id`、`x-mg-attempts`、`Retry-After`、上游 status。

## 5. 已知限制

- 原生 Responses 的 `store`/`include`/服务端会话未实现（直通模式下由上游决定）。
- `input_image` 只在 Chat 桥接为 `image_url`，多模态未做端到端验收。
- 真实 Codex 桌面 + OpenCode Go 组合为 `NOT_RUN_LIVE`；不要在未实测前对外宣称「已兼容」。
- 本文件不提供也禁止写入任何官方 `auth.json`；网关只使用仓库配置/加密 keys 库/环境变量。
