# ModelGate 管理面 / 数据面 API 契约 v1

> 状态：**G0 冻结草案（2026-11-07）**，基线 `main@6bc6441`。前端轨道只依赖本文件与 `docs/contracts/fixtures/`，不得依赖 `src/admin.html` 的内部实现。
> 变更规则见文末「兼容性承诺」。任何破坏性改动必须升 `contract: management-api-v2` 并保留 v1 至弃用窗口结束。

## 0. 通用约定

| 项 | 约定 |
| --- | --- |
| 监听 | 默认 `127.0.0.1:8787`；`server.host/port` 可配，`0` 表示由内核分配（离线测试） |
| 编码 | JSON UTF-8；请求/响应 `application/json`（流式 `text/event-stream`） |
| 请求体上限 | `server.maxBodyBytes`，默认 32 MiB；超限 `413`，`error.type=payload_too_large` |
| 错误信封 | `{"error": {message, type, code?, param?, trace_id?, ...}}`；管理面保存失败沿用 `{"error": "文案", ...}`（见 §2.6，历史兼容） |
| Trace | 所有 `/v1/*` 与 `/api/*` 响应带 `x-mg-trace-id`；错误体同值 |
| 尝试数 | 数据面 JSON 响应带 `x-mg-attempts`（本次请求真实发出的上游请求数） |
| 脱敏标记 | 管理面读到的敏感值统一为 `"****"`；保存时回传 `"****"` 表示**未改动**（服务端还原现值） |
| 时间 | epoch 毫秒，除特别标注 `_sec` 的字段（OpenAI 兼容 `created_at` 为秒） |

## 1. 鉴权

### 1.1 管理面 `/api/*`

管理令牌来源优先级：`MG_ADMIN_TOKEN` 环境变量 > `server.adminToken` > 加密 keys 库 `__mg_admin`。

请求头二选一：

```
Authorization: Bearer <admin-token>
x-mg-admin: <admin-token>
```

- 未配置令牌：管理面**完全开放**（仅建议回环地址），`/api/auth` 返回 `needAuth:false`。
- 令牌错误/缺失：`401`，不区分「未设置」与「错误」，不做时序侧信道（常量时间比较）。
- `/api/auth`、`/healthz`、`/` 面板 HTML 不需要令牌。

### 1.2 数据面 `/v1/*`

客户端 Key 解析顺序：

1. 全局：`MG_CLIENT_KEY` > keys 库 `__mg_client` > 旧 `defaults.clientKey`。
2. 虚拟模型：请求体 `model` 命中 `virtualModels[].name` 且存在 `__mg_vm_<name>` 时，必须匹配该 Key。
3. 虚拟 Key 可带元数据 `__mg_vm_meta_<name>.expiresAt`，过期返回 `401`。

```
Authorization: Bearer <client-key>
```

- 未配置任何客户端 Key：数据面不鉴权（历史行为）。
- 虚拟模型名与 Key 不匹配：统一 `401`，**不区分**「模型不存在 / Key 错误」，防枚举。
- 比较为常量时间；不接受 Cookie / `x-api-key` 作为数据面凭据。
- 请求头 `authorization`、`cookie`、`x-api-key`、`api-key`、`proxy-*` 一律**不转发**给上游。

## 2. 管理面端点

### 2.1 `GET /healthz`

- 鉴权：无。返回 `200 text/plain: ok`。仅表示进程存活，不代表上游可用。

### 2.2 `GET /api/auth`

- 鉴权：无。
- 响应：`{"needAuth": boolean, "startedAt": number}`。
- 用途：前端启动时决定是否显示登录框。

### 2.3 `POST /api/admin-token`

- 鉴权：已启用令牌时需携带当前令牌；未启用时开放（本地初始化）。
- 请求：`{"token": "..."}`；空字符串表示清除令牌。
- 响应：`200 {"ok": true, "needAuth": boolean}`；无法加密 keys 库时 `400`。
- 副作用：写加密 keys 库并热加载；不写明文。

### 2.4 `GET /api/status`

- 鉴权：管理令牌。
- 响应：见 `docs/contracts/fixtures/status.example.json`。关键字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `needAuth` | bool | 是否启用管理鉴权 |
| `configVersion` | int | 单调递增配置版本，保存时必须回传 |
| `server` | obj | `maxBodyBytes/keyEncrypted/host/port` |
| `providers[]` | array | `id/baseUrl/hasKey/keySource/apiKeyEnv/pathPrefix/api/extraHeaders/proxy/circuit/st` |
| `providers[].extraHeaders` | obj | **敏感值已掩码为 `"****"`**，键名保留 |
| `providers[].proxy` | string | **userinfo 已掩码**，host:port 保留 |
| `models[]` | array | 真实模型配置 + 运行统计 + `affinity` |
| `virtualModels[]` | array | `keySet` 只报是否设置，绝不回显 Key |
| `defaults` | obj | 原样返回（`clientKey` 掩码），保存采用**合并**语义 |
| `budget` | obj | 当前单请求尝试预算默认值 |
| `wires` | obj | 入口路径与原生 Responses 模型清单 |

- 绝不返回：Provider Key 明文、客户端 Key、管理令牌、加密主密钥、请求正文。

### 2.5 `GET /api/capabilities`

- 鉴权：管理令牌。
- 响应：见 `fixtures/capabilities.example.json`。
- 说明：只读协议能力矩阵（`chat` / `native-responses` / `sessionPassthrough`），供前端渲染「该模型支持哪些入口」，不参与路由决策（路由以配置为准）。

### 2.6 `POST /api/config/save`

- 鉴权：管理令牌。
- 请求（所有字段可选，见 `fixtures/config-save.request.json`）：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `version` | int | **推荐必传**。与当前 `configVersion` 不等 → `409`；缺省视为旧客户端，宽容放行并返回最新版本 |
| `providers` | obj | 整体替换上游集合；`extraHeaders`/`proxy` 中的 `"****"` 还原为现值；`keyOk/keySource` 被丢弃 |
| `models` | obj | 整体替换模型集合；校验 `provider/fallbacks` 存在、额度字段非负、`effortFormat ∈ {reasoning_effort, thinking}` |
| `defaults` | obj | **合并**：提交字段覆盖，未提交字段保留（防止面板白名单冲掉 `affinityTtlMs`/`failbackProbe`/`budget` 等） |
| `virtualModels` | array | 整体替换；名字唯一、目录非空、引用存在；删除虚拟模型会同步清理其 Key 与元数据 |

- 成功：`200 {"ok": true, "status": <见 2.4>}`。
- 参数错误：`400 {"error": "校验文案"}`（历史兼容形状）。
- 版本冲突：`409 {"error": "...", "currentVersion": N}`。
- 并发保证：读-改-写全程串行（写锁），落盘为临时文件 + rename 原子替换；同一版本并发保存只有一个成功。
- 副作用：推进 `configVersion`；热加载仅作用于新请求，在途请求使用旧快照。

### 2.7 `POST /api/config/reload`

- 鉴权：管理令牌。重新读取 `gateway.json + gateway.local.json + keys`。
- 响应：`200 {"ok": true}`。手改配置后使用；不推进 `configVersion`。

### 2.8 `POST /api/keys`

- 鉴权：管理令牌。
- 请求：`{"id": "<providerId|__mg_client|__mg_vm_<name>|__mg_admin>", "key": "<secret>", "version"?: int}`；`key` 为空表示删除。
- 响应：`200 {"ok": true, "status": ...}`；`400` 缺 `id`；`409` 版本冲突。
- 安全：Key 以 AES-256-GCM 加密落盘（`MG1:` 前缀，主密钥来自 `MG_KEYS_MASTER` 或用户目录自动主密钥），文件权限 `0600`；任何响应/日志不含明文。

### 2.9 `POST /api/probe`

- 鉴权：管理令牌。请求 `{"id"?: "<providerId>"}`；缺省探测全部上游。
- 语义：GET `{baseUrl}{pathPrefix}/v1/models`，**只要拿到 HTTP 响应即视为可达**（含 4xx/5xx），超时/拒连/DNS 失败才算不通。
- 响应：`200 {"ok": true, "results": [{id, ok, code, ms, err}], "status": ...}`。

### 2.10 `POST /api/model-test`

- 鉴权：管理令牌。请求 `{"id"?: "<model>"}`；缺省测试全部模型。
- 语义：向该模型上游发 `max_tokens=1` 的真实请求（**会产生少量费用**），验证模型名可调用。
- 响应：`200 {"ok": true, "result"|"results": [{id, ok, code, ms, err}], "status": ...}`。

### 2.11 `POST /api/route-preview`

- 鉴权：管理令牌。请求 `{"model": "<name>"}`。
- 响应：`200 {"ok": true, "hit": {...}}`，`hit.type ∈ {virtual, defaults, model, unknown}`，包含目录、额度状态与 provider 顺序。只读，不产生上游请求。

### 2.12 `GET /api/model-stats?days=N`

- 鉴权：管理令牌。`days=1` 返回小时桶，`2..90` 返回日桶。
- 响应：`{"days": N, "mode": "hourly"|"daily", "models": {name: [{date, tokens, inTokens, outTokens, hit, miss, hitRate}]}}`。

### 2.13 `GET /api/logs?lines=N`

- 鉴权：管理令牌。`N ∈ [1,5000]`，默认 200。
- 响应：`{"lines": string[]}`；日志已按日分文件、7 天保留，写入前做密钥脱敏。

## 3. 数据面端点

### 3.1 `GET /v1/models`（别名 `/models`）

- 鉴权：客户端 Key（如已配置）。
- 响应：`{"object":"list","data":[{id, object, owned_by, capabilities, wire}]}`，见 `fixtures/models.example.json`。
- `capabilities`：`chat/responses/native_responses/streaming/tools/reasoning`；`wire ∈ {chat, native}`（`native` 表示该模型走原生 Responses 直通）。

### 3.2 `POST /v1/chat/completions`（别名 `/chat/completions`）

- 鉴权：客户端 Key。
- 请求：OpenAI Chat Completions；网关额外识别：
  - `reasoning_effort`：按模型 `effortOptions` 本地校验（非法 `400 UnsupportedParamsError`），按 `effortFormat` 转 `thinking:{type}`。
  - 会话头：`x-conversation-id` / `x-session-id` 或 body `session_id` / `conversation_id`（仅统计，不转发）。
- 响应：上游 2xx 原样透传（跨模型兜底时 `model` 回写为客户端请求名）；`stream:true` 为 SSE，断流时发 `stream_interrupted` 错误事件 + `[DONE]`，绝不伪装成功。
- 路由：真实模型/别名 → 虚拟模型目录 → `defaults.directory` → `defaults.provider`；未知模型且已配置虚拟模型 → `404 unknown_model`。

### 3.3 `POST /v1/responses`（别名 `/responses`）—— G2 新增

- 鉴权：客户端 Key（与 Chat 同一套；虚拟模型 Key 同样生效）。
- 方法限制：非 `POST` → `405`，`Allow: POST`。
- 请求：OpenAI Responses API 子集，见 `fixtures/responses.request.example.json`。

| 字段 | 支持 | 说明 |
| --- | --- | --- |
| `model` | ✅ | 必填；按网关模型/虚拟模型解析 |
| `input` | ✅ | string 或 item 数组（`message`/`function_call`/`function_call_output`/`custom_tool_call(_output)`/`reasoning` 跳过） |
| `instructions` | ✅ | 转为首条 system 消息 |
| `tools` | ✅ | `function`、`custom`、`namespace`（展开为 `namespace.tool`）；`web_search` 显式省略并记日志；`local_shell` 需原生 Responses 上游，否则 `422` |
| `tool_choice` | ✅ | `none/auto/required` 或 `{type,name}` |
| `max_output_tokens` | ✅ | → `max_tokens` |
| `temperature` / `top_p` | ✅ | 透传 |
| `reasoning.effort` | ✅ | → `reasoning_effort`，仍受模型 `effortOptions` 约束 |
| `text.format` | ✅ | `json_schema` / `json_object` → `response_format` |
| `stream` | ✅ | 默认建议 `true`（Codex 场景） |
| `previous_response_id` | ❌ 422 | 无状态桥接不保存服务端对话，需回传完整历史 |
| `input_file` / `item_reference` / `local_shell` | ❌ 422 | 无法保真，明确拒绝而非静默降级 |
| `store/truncation/include/metadata/service_tier/reasoning.summary` | 忽略 | 不影响请求内容保真；`include:["reasoning.encrypted_content"]` 在 Chat wire 无对应语义 |
| `parallel_tool_calls` | ✅ | 透传 |

- 两种 wire：
  - `chat`（默认）：Responses → Chat 有损桥接。`models.<name>.responsesWire` 缺省即此；事件顺序见 §3.3.1。
  - `native`：`models.<name>.responsesWire="native"` 且 `providers.<id>.api="responses"`，字节级直通原生 Responses SSE；声明不一致 → `422 wire_mismatch`（不静默降级）。
- 上游 model id 分离：`models.<name>.upstreamModel` 存在时发该 id，响应 `model` 仍回写客户端请求名；跨 provider 时 `models.<name>.providerModels[pid]` 优先。
- 模型级协议：`models.<name>.api`（`openai`/`anthropic`/`gemini`/`responses`）优先于 `providers.<id>.api`；`maxTokensMax` 钳制 `max_tokens`；`forceNoStream` 对「2xx 但零字节 SSE」上游降级为非流拉取再补 SSE。
- 事件顺序契约（Codex/DSH 依赖，见 `fixtures/responses.stream.events.jsonl`）：

```
response.created
response.in_progress
(response.output_item.added → response.content_part.added → response.output_text.delta* →
 response.output_text.done → response.content_part.done → response.output_item.done)*
(response.output_item.added → response.function_call_arguments.delta* →
 response.function_call_arguments.done → response.output_item.done)*
response.completed | response.failed
```

  - `call_id` 与上游/客户端 `call_id` 保持一致，不重新生成。
  - `custom` 工具：入站映射为「单 `input` 字符串参数」的 function；出站还原 `custom_tool_call` 与 `input`。
  - 上游断流/无终态：`response.failed`，不得发 `response.completed`。
  - 非幂等（含 `tools` 或工具结果）请求**不自动重放**：只允许一次上游尝试（详见 §4）。

- 非流式响应：见 `fixtures/responses.response.example.json`。客户端 `stream:true` 但上游返回 JSON 时，发一条 `response.created` + `response.completed`，不伪造 Chat SSE。

## 4. 429 / 重试 / 预算

### 4.1 单请求预算

`defaults.budget`：

| 字段 | 默认 | 语义 |
| --- | --- | --- |
| `maxAttempts` | 8 | 单请求真实上游请求总数上限（含 request 内重试、跨 provider、跨模型、while 循环）。**不跟随 `retry.maxAttempts` 下调**，否则目录 fallback 会被预算饿死 |
| `maxMs` | `timeout.loopMs` 或 120000 | 单请求墙钟上限 |
| `maxWaitMs` | 30000 | 单次按 `Retry-After` 等待的上限；超过则不等待，直接换上游或回 429 |

- 预算耗尽时立即收尾，不再空转到 `loopMs`。
- `retry.toolRequests`（默认 `false`）：含工具定义/工具结果的请求不自动重放；同上游不重试、不切备用。

### 4.2 429 归因

| `attribution` | 判据（响应体文本/头） |
| --- | --- |
| `platform_quota` | insufficient/quota/billing/balance/credit/额度/余额/配额 |
| `model_capacity` | capacity/overload/busy/concurrency/系统繁忙 |
| `rate_limit` | rate limit/too many requests/rpm/tpm/throttle/频率/速率，或带 `Retry-After` |
| `cooldown` | 本地 429 冷却窗口内无上游可试 |
| `unknown` | 无法归因 |

响应：HTTP `429` + `Retry-After`（秒，向上取整）+ 错误码 `MG_429_<ATTRIBUTION>`，见 `fixtures/error.rate-limited.json`。429 **不计入熔断**，只做上游级冷却。

### 4.3 不重试清单

`400/401/403/404/405/409(客户端)/422` 不进入重试；`403/404`、以及含「模型/上游不可用」语义的 `400` 按模型级拒绝处理，继续目录链但保留上游原始响应作为兜底。

## 5. 状态码总表

| 码 | 场景 |
| --- | --- |
| 200 | 成功（含流式已收尾） |
| 400 | JSON/字段校验失败、未知模型且无默认上游、思考档位非法 |
| 401 | 管理/客户端鉴权失败 |
| 404 | 已配置虚拟模型时的未知模型名；未知路径 |
| 405 | Responses 非 POST |
| 409 | `configVersion` 过期（携带 `currentVersion`） |
| 413 | 请求体超限 |
| 422 | Responses 无法保真转换、wire 声明不一致 |
| 429 | 上游限流、预算耗尽、虚拟模型额度耗尽 |
| 502 | 全部上游失败、上游 3xx、传输错误 |
| 504 | 网关未主动产生（超时以 408/502 语义表达） |

## 6. 敏感字段与脱敏

| 位置 | 规则 |
| --- | --- |
| `/api/status` `extraHeaders` | 键名保留，敏感键值 `"****"`（`authorization/api-key/token/secret/password/cookie/session-id/...`） |
| `/api/status` `proxy` | userinfo → `****`，保留协议与 host:port |
| `/api/status` `defaults.clientKey` | 已设置时 `"********"` |
| 上游 4xx/5xx 回显 | `sk-*`、`Bearer *`、已知密钥字面量 → `****` |
| 日志 | 环境变量 Key、面板 Key、extraHeaders 值（含 `Bearer` 后的裸 key）、客户端/管理令牌 → `****` |
| 保存 | 回传 `"****"` 视为未改动，绝不把掩码写入真实配置 |

## 7. 兼容性承诺

1. v1 内新增字段为**增量**，客户端必须忽略未知字段；删除/改义字段需 v2 + 至少一个发布周期的双写。
2. `defaults` 保存为合并语义：未提交字段保留；字段删除仅支持直接编辑配置文件。
3. 错误信封：数据面新增 `code`/`trace_id`/`attempts` 等字段，`message/type` 保持稳定；管理面保存错误沿用 `{error: string}`（历史面板兼容）。
4. `configVersion` 语义不变；任何写操作（含 Key）都推进版本。
5. 前端只依赖本文件 + fixtures；`admin.html` 不是契约。
6. 离线契约测试：`node scripts/test/offline/run.mjs`（不访问 8787、不需要真实 Key）。
