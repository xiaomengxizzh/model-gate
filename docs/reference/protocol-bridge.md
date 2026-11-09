# 协议桥契约与有损转换清单

基线：2026-11-08（MG-008 / P2）。实现：`src/format.js`；回归：`scripts/test/offline/wire-format.test.mjs`。
本文只描述**适配器层**（OpenAI Chat ⇄ Anthropic Messages / Gemini generateContent）的字段契约，以及这些转换中不可逆或当前未实现的信息损失。它不替代[配置参考](configuration.md)、[架构说明](../explanation/architecture.md)与[测试指南](../how-to/testing.md)。

## 1. 责任边界

- 入口只有 OpenAI Chat Completions。`adapterFor(api)` 对 `anthropic`/`gemini` 返回适配器，其余（含 `openai`、未知值）返回 `null`，由调用方透传。
- `build(openaiBody) → { path, body }`：请求整形；纯函数，不修改客户端请求体。
- `fromUpstream(obj) → OpenAI chat.completion`：非流式响应还原；`makeOA` 负责统一信封（`chatcmpl-` 随机 id、`chat.completion`、秒级 `created`、单 `choice`）。
- `extractStreamContent(dataStr) / extractStreamFinish(dataStr)`：从一条 SSE data 帧抽取正文与结束原因。**事件顺序、`[DONE]`、续传、keepalive、错误事件由 [src/sse.js](../../src/sse.js) 的 `relayStream` 负责**，适配器不排序、不补帧。
- 上游错误信封、鉴权头、重试/降级、响应 `model` 回写由 [src/forward.js](../../src/forward.js)、[src/request.js](../../src/request.js)、[src/index.js](../../src/index.js) 负责；**适配器不映射错误体**。
- 明确不在本层：Responses/Codex（MG-015，入口与 Chat 桥在 `src/responses.js`/`src/responses-stream.js`；将来原生 responses 协议如接入需新增适配器并在此登记）、Embedding/Audio/Image/Video（MG-011/013/014）、图片下载或转码（遵守[资源规则](../../RESOURCE_APPROVAL.md)与隐私边界，网关不代抓调用方 URL）。

## 2. 请求映射

### 2.1 OpenAI Chat → Anthropic Messages（`POST /v1/messages`）

| OpenAI 字段 | Anthropic 字段 | 行为 |
| --- | --- | --- |
| `model` | `model` | 原样 |
| `messages[role=system]` | `system` | 归一为一个字符串；多条按出现顺序以 `\n` 连接 |
| 用户/助手文本 `content` | `content` 字符串 | 数组形式按 parts 顺序拼接（`text` part 取 `text`，其余 part 跳过） |
| `assistant.tool_calls` | `content[{type:"text"}?, {type:"tool_use"}...]` | `arguments` 反序列化为对象放进 `input`；`id` 原样保留（缺失时生成 `tc_` id） |
| `messages[role=tool]` | `content[{type:"tool_result"}]` | 紧邻的并行 tool 结果合并进**同一个** `user` 消息（连续 user 轮会触发 roles-must-alternate 400） |
| `max_tokens` / `max_completion_tokens` | `max_tokens` | 取前者；都缺省时 4096 |
| `temperature` / `top_p` | 同名字段 | 原样；开启 thinking 时**删除**（Anthropic 硬约束） |
| `stop` | `stop_sequences` | 字符串包成数组；`stop: []` 会得到空数组（边界未对真实上游验证） |
| `tools[].function` | `tools[{name,description,input_schema}]` | `parameters` 进 `input_schema`；缺省 `{type:"object",properties:{}}` |
| `tool_choice` | `tool_choice` | `auto`→`{type:"auto"}`、`required`→`{type:"any"}`、`none`→`{type:"none"}`、指定函数→`{type:"tool",name}` |
| `stream` | `stream` | 原样 |
| `reasoning_effort` / `thinking` | `thinking: {type:"enabled",budget_tokens}` | 档位：minimal 1024、low 2048、medium 8192、high 16384、xhigh 32768、enabled/on/adaptive 8192；显式 `budget_tokens` 优先；关闭档（off/none/disabled/false）不生成字段 |

thinking 开启时 `max_tokens` 必须严格大于 `budget_tokens`，否则抬到 `budget_tokens + 1024`（思考 token 计入输出计费，但不占回答预算）。

### 2.2 OpenAI Chat → Gemini generateContent

路径：`/v1beta/models/{encodeURIComponent(model)}:{generateContent|streamGenerateContent?alt=sse}`。带工具（非空 `tools` 或 `tool_choice`）时固定 `:generateContent`；否则按 `stream` 选择。请求体不带 `stream` 字段，流式由路径表达。

| OpenAI 字段 | Gemini 字段 | 行为 |
| --- | --- | --- |
| `messages[role=system]` | `systemInstruction.parts[0].text` | 多条以 `\n` 连接 |
| 用户/助手文本 | `contents[].role=user/model`、`parts[0].text` | parts 顺序拼接 |
| `assistant.tool_calls` | `parts[{text}?,{functionCall}]` | `arguments` 反序列化为 `args` |
| `messages[role=tool]` | `parts[{functionResponse}]` | 相邻并行结果合并进同一 `user` content；name 由同请求内 assistant `tool_calls` 的 id→name 映射回填，缺失回退 `fn` |
| `temperature`/`top_p`/`max_tokens` | `generationConfig.temperature/topP/maxOutputTokens` | 原样；未给则不建 `generationConfig` |
| `tools[].function` | `tools[0].functionDeclarations[]` | `parameters` 原样；缺省空 object schema |
| `tool_choice` | `toolConfig.functionCallingConfig` | `auto`→AUTO、`required`→ANY、`none`→NONE、指定函数→ANY + `allowedFunctionNames`；仅在带非空 tools 时下发 |

## 3. 响应映射

### 3.1 finish_reason

OpenAI 客户端只接受 `stop / length / tool_calls / content_filter` 四个值；上游专有原因全部收敛，原始原因不可逆。

| 来源 | 映射 |
| --- | --- |
| Anthropic `end_turn` / `stop_sequence` / `pause_turn` / `refusal` | `stop` |
| Anthropic `max_tokens` / `model_context_window_exceeded` | `length` |
| Anthropic `tool_use` | `tool_calls` |
| Gemini `STOP` | `stop` |
| Gemini `MAX_TOKENS` | `length` |
| Gemini `SAFETY` / `RECITATION` / `BLOCKLIST` / `PROHIBITED_CONTENT` / `SPII` / `IMAGE_SAFETY` / `LANGUAGE` | `content_filter` |
| Gemini `MALFORMED_FUNCTION_CALL` / `OTHER` / 未知值 | `stop` |
| 响应含工具调用块（任一协议） | 强制 `tool_calls`（覆盖上游 stop 原因） |
| Anthropic 未知 `stop_reason`；Gemini 无 `finishReason` | `stop` |
| Gemini `promptFeedback.blockReason`（提示词被安全策略拦截，无 candidates） | 映射为 `content_filter` |

### 3.2 usage

- **Anthropic**：原生 `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens` 全部保留，并补 `prompt_tokens`/`completion_tokens`/`total_tokens`（后两者为 input/output 之和）。
- **Gemini**：`usageMetadata.promptTokenCount → prompt_tokens`、`candidatesTokenCount → completion_tokens`、`totalTokenCount → total_tokens`（缺失时相加）；`cachedContentTokenCount > 0` 时写 `prompt_tokens_details.cached_tokens`。
- 无 usage 时输出三个 0（不虚报）。
- 网关自身的缓存命中四桶由 `cacheHitMiss(api, rawUsage)` 计算；`forward.js` 在**转换前**用上游原始 usage 记账，因此转换后的字段只影响客户端可见值，不影响计费/命中统计。

### 3.3 SSE 抽取

| 协议 | 帧类型 | `extractStreamContent` | `extractStreamFinish` |
| --- | --- | --- | --- |
| Anthropic | `content_block_delta.delta.text` | 文本 | `''` |
| Anthropic | `thinking_delta` / `input_json_delta` | `''` | `''` |
| Anthropic | `message_delta.delta.stop_reason` | `''` | 映射后的 finish_reason |
| Anthropic | `message_start` / `message_stop` / `[DONE]` | `''` | `''` |
| Gemini | 候选帧内全部非 `thought` 的 `text` part | 拼接文本 | `''` |
| Gemini | `functionCall` / `thought:true` part | `''` | `''` |
| Gemini | 带 `finishReason` 的候选帧 / `promptFeedback` 帧 | `''` | 映射后的 finish_reason |
| 两者 | 非 JSON / 空串 | `''` | `''` |

## 4. 有损转换清单

“证据”列对应 `scripts/test/offline/wire-format.test.mjs` 的用例名或明确的不测理由。表中“已修”表示本卡在 `src/format.js` 内修复并有失败→通过证据；“有损”表示按当前设计必然丢失；“未实施”表示可映射但本卡未做。

| # | 字段 / 语义 | 方向 | 状态 | 影响 | 证据 / 理由 |
| --- | --- | --- | --- | --- | --- |
| 1 | `image_url` / `input_image` / `input_audio` / `file` 等非文本 part | 请求 | 有损 | 图片/文件被丢弃，纯图片消息退化为空文本；网关不代抓 URL、不转码 | `anthropic build…`、`gemini build…` 断言文本为 `look now`（图片无痕丢弃） |
| 2 | content parts 之间的分隔符 | 请求 | 已修 | 修复前图片 part 会插入空字符串并按 `\n` 连接，产生 `look \n\nnow`；现按协议语义直接拼接 | 同上（修复前基线 9 项失败之一） |
| 3 | 并行 `tool_result` 的 user 轮次 | 请求（Anthropic） | 已修 | 修复前每条 tool 结果各起一条 user 消息，连续 user 轮触发上游 400 | `anthropic build：并行 tool_calls 的 tool_result 合并…` |
| 4 | 并行 `functionResponse` 的 user 轮次 | 请求（Gemini） | 已修 | 同上，连续同角色 content 触发 Gemini 交替校验 | `gemini build：并行 tool_calls 的 functionResponse 合并…` |
| 5 | `tool_choice` | 请求（Gemini） | 已修 | 修复前工具调用策略完全丢失（`none` 也可能被上游当 auto）；现映射 `toolConfig` | `gemini build：tools 场景…tool_choice 映射` |
| 6 | 空 `tools: []` | 请求（Gemini） | 部分修 | `hasTools` 现按长度判断，空数组不再走非流式端点；但 `forward.js` 仍用真值判断，会把 `stream` 置 false 并标 degraded（见 §5） | `hasTools：空 tools 数组不算带工具` |
| 7 | `cache_control`（Anthropic prompt caching 断点） | 请求（Anthropic） | 有损 | OpenAI 无对应字段，不代调用方声明缓存断点；响应 usage 的 cache 字段仍保留 | 不测：输入侧无等价 OpenAI 字段，无法从客户端请求产生 |
| 8 | `response_format` / `seed` / `n` / `presence_penalty` / `frequency_penalty` / `logit_bias` / `logprobs` / `user` / `metadata` | 请求（两协议） | 有损 | 结构化输出约束、可复现性、多样性、惩罚项、日志概率全部丢失 | 不测：适配器无对应输出字段，纳秒级断言只能锁定“不存在” |
| 9 | `parallel_tool_calls:false` | 请求（两协议） | 有损 | 上游仍可能并行发起多个工具调用 | 不测：当前输出结构里无该开关，需真实上游行为才能验证后果 |
| 10 | `stop: []` 的空数组边界 | 请求（Anthropic） | 未验证 | 会下发 `stop_sequences: []`，是否被上游按 400 拒绝未知 | 不测：属上游参数容忍度，离线无法确认；需要真实上游 smoke |
| 11 | `stop` | 请求（Gemini） | 未实施 | 停止序列不下发，上游可能继续生成 | 不测：当前不产生字段；映射为 `generationConfig.stopSequences` 可后续补 |
| 12 | `thinkingConfig` / Gemini 思考预算 | 请求（Gemini） | 有损 | `reasoning_effort` 只对 Anthropic 生效；Gemini 思考档位不可控 | `anthropic build：thinking 预算整形` 只覆盖 Anthropic |
| 13 | Anthropic `thinking` / `redacted_thinking` 响应块 | 响应（Anthropic） | 有损 | 思考内容被丢弃，不映射 `reasoning_content`（OpenAI Chat 无标准 reasoning 通道，映射会污染 content 或破坏兼容） | `anthropic fromUpstream…`（content 只含正文）；`anthropic SSE…`（`thinking_delta` → `''`） |
| 14 | Anthropic `citations` / `server_tool_use` / `web_search_tool_result` / image / document 块 | 响应（Anthropic） | 有损 | 引用与检索结果不可见 | 不逐一测：同一“非 text/tool_use 白名单跳过”分支，行为等价于 thought 块用例 |
| 15 | Anthropic `stop_sequence` 命中字符串 | 响应（Anthropic） | 有损 | 只能得到 `finish_reason=stop`，调用方不知道命中哪个序列 | 不测：输出结构无标准字段可承载 |
| 16 | Anthropic 非标准 usage 字段（`input_tokens` 等） | 响应（Anthropic） | 保留（非标准） | 严格 OpenAI schema 客户端会看到额外字段；保留源于网关历史计费/缓存兼容 | `anthropic fromUpstream…` 断言原生字段仍在 |
| 17 | Gemini `safetyRatings` / `citationMetadata` / `groundingMetadata` / `avgLogprobs` | 响应（Gemini） | 有损 | 安全评分、引用、检索接地信息不可见；安全类只聚合为 `content_filter` | `gemini fromUpstream…` 断言 `safetyRatings` 不外露 |
| 18 | Gemini `thought:true` 摘要与 `thoughtSignature` | 响应 + 流式（Gemini） | 已修 | 修复前思考摘要被拼进 `content`；现跳过 thought part。`thoughtSignature` 仍丢弃（多轮工具循环的原生续接能力损失） | `gemini fromUpstream：thought part…`、`gemini SSE：thought part…` |
| 19 | Gemini `thoughtsTokenCount` | 响应（Gemini） | 有损 | `completion_tokens` 只含候选输出，`prompt+completion` 可能小于 `total_tokens`（保留上游 total） | `gemini fromUpstream…` 断言 total 原样 |
| 20 | Gemini `n>1` 多候选 | 响应（Gemini） | 有损 | 只取 `candidates[0]`，其余候选丢弃 | 不测：输出信封固定单 choice |
| 21 | Gemini `functionCall` 无 id | 响应（Gemini） | 保留（生成） | 网关生成随机 `call_` id；同一请求内 tool 结果可回填 name，跨请求 id 不稳定（客户端仅需回显） | `gemini fromUpstream…` 断言前缀；`makeOA…` 断言信封 |
| 22 | `finishReason` → `finish_reason` | 响应 + 流式（Gemini） | 已修 | 修复前恒为 `stop`、流式完全没有 finish 帧；现按表映射，`promptFeedback` 也能给 `content_filter` | `gemini fromUpstream：finishReason 映射…`、`gemini SSE…` |
| 23 | `model` 字段 | 响应（Gemini） | 已修 | 修复前 Gemini 响应无 `model` 时输出空串，`forward.js` 的响应 model 回写因此跳过；现回退 `modelVersion` | `gemini fromUpstream：…model 缺失时回退 modelVersion` |
| 24 | 流式工具调用增量（`tool_calls` delta + `index`） | 流式 | 有损（设计选择） | 带工具且 `stream:true` 时 `forward.js` 强制非流式 + 单帧 SSE（`degraded`），因此没有增量 functionCall / `delta.index` | 本卡不改 `forward.js`；`gemini build…tools 场景 path` 断言固定 `:generateContent` |
| 25 | 流式 `finish_reason` 的触发时机 | 流式（Gemini） | 有残留风险 | `relayStream` 只在“内容为空”的帧调用 `extractFinish`；若上游把 `finishReason` 与最后一段文本放同一帧，finish_reason 会丢（`sse.js` 限制，见 §5） | 不测：需修改 `sse.js`，不在本卡写集 |
| 26 | 错误信封 / 错误类型 / 上游错误体 | 两者 | 不在适配器 | 适配器不参与；错误透传、脱敏与 502/4xx 归属由 `forward.js`/`index.js` 决定 | 见[架构说明](../explanation/architecture.md) |
| 27 | 多 choice / `n` 输出、Responses API、多模态输出 | 两者 | 不在本卡 | `makeOA` 固定单 choice；Responses 归 MG-015，多模态能力归 MG-013 | 开发计划边界 |
| 28 | wire id 的确定性 | 两者 | 有损（可接受） | `makeOA` 的 `chatcmpl-`、Gemini `call_` 均由 `Math.random` 生成，同一输入两次调用 id 不同 | fixture 只断言前缀/形状，不断言具体值 |

## 5. 本卡发现但未改（写集外，交 Lead 决策）

1. **`src/sse.js`：Gemini 末帧 finish 丢失风险**。`relayStream` 只在 `ct === ''`（该帧无文本）时调用 `extractFinish`；Gemini 常把 `finishReason` 放在无文本收尾帧（已覆盖），但若与最后一段文本同帧则丢掉 finish_reason。建议在发送 delta 后也检查 `extractFinish`，并用 `finishSent` 保证只发一次。
2. **`src/forward.js`：空 `tools: []` 的真值判断**。第 463 行 `(routeBody.tools || routeBody.tool_choice)` 对空数组为真，仍会把 `stream` 置 false 并标 `degraded`；与 `format.js#hasTools` 的长度判断不一致。建议改为与 `hasTools` 相同的长度判断（本卡未改 `forward.js`）。
3. **流式工具调用降级**：`forward.js` 对“工具 + stream”统一降级为非流式单帧 SSE。若要让原生客户端获得增量 `tool_calls` delta，需要在 `sse.js`/`forward.js` 重建 delta 与 `index`，属独立设计（本卡只断言现状并记录）。
4. **错误映射**：适配器层不做错误映射；非 OpenAI 原生错误信封的映射已由 MG-008 余项补齐，见 §7.2（`mapErrorEnvelope`，在 `forward.js` 返回前应用）。

## 6. 验证

本层为纯函数，测试不启动网关、不连上游、不读写配置；`npm test` 会通过 `scripts/test/run.mjs` 自动发现 `offline/*.test.mjs`。

| 命令 | 结果 |
| --- | --- |
| `node --test scripts/test/offline/wire-format.test.mjs` | 22/22 通过（修复前同一文件 9 项失败；另 2 项针对 HEAD 版 `format.js` 单独复现） |
| `npm test` | Isolated suites 10/10 通过（2026-11-08 收尾现场；套件数随并行任务新增，本卡相关的 `wire-format` 全绿） |
| `npm run check` | 退出码 0 |
| `npm run docs:check` | 通过（本文件链接与长度检查） |

**未验证范围**：真实 Anthropic/Gemini 上游行为（含 `stop: []`、`stop_sequences`、thinking 预算上限、Gemini 末帧时序）、Windows、生产端口 8787、SSE 断流/重连（属 `sse.js` 既有测试与 MG-002/MG-004）。本文件不能作为真实上游验收证据。

## 7. Embeddings 映射（MG-011）

入口：`POST /v1/embeddings`（OpenAI 形状）。本层只描述上游适配；能力声明、记账与隔离见配置参考。

| 项 | OpenAI 兼容上游 | Gemini 上游 |
| --- | --- | --- |
| 路径 | `/v1/embeddings`（透传） | `/v1beta/models/{model}:batchEmbedContents` |
| 请求体 | 原样（model/input/dimensions/encoding_format） | `requests[].{model:"models/<名>", content:{parts:[{text}]}, outputDimensionality?}` |
| 鉴权 | `Authorization: Bearer` | `x-goog-api-key`（extraHeaders 照常合并） |
| 响应 | 原样，model 回写客户端请求名 | `embeddings[].values → data[].embedding`，index 按顺序重建；无 usage 时计 0（不臆造） |
| 不支持 | — | Anthropic 无 embeddings：入口直接 502 `all_providers_failed`，不发起上游请求 |

有损/限制：批量上限 2048；仅文本 input（token-id 数组暂不支持）；`encoding_format=base64` 依赖上游支持，网关不转码；Gemini 不返回 usage，token 账本记 0。回归：`scripts/test/offline/embeddings.test.mjs`。

## 8. Rerank 映射（MG-012）

入口：`POST /v1/rerank`（OpenAI/Jina 风格）。上游按模型协议选择：

| 项 | api=openai（默认，Jina/SiliconFlow 等兼容） | api=cohere |
| --- | --- | --- |
| 路径 | `/v1/rerank` | `/v2/rerank` |
| 请求体 | `{model, query, documents, top_n?, return_documents?}` | 同左 |
| 鉴权 | `Authorization: Bearer`（extraHeaders 合并） | 同左 |
| 响应 | 原样 results；网关稳定排序 + top_n 裁剪 + model 回写 | 同左；`meta.billed_units` 原样保留 |

有损/限制：`documents` 上限 2048；仅字符串文档；Anthropic/Gemini 无 rerank（502 不触上游）；Gemini/Cohere 不返回 OpenAI usage 时 token 记 0；`document` 形状按上游原样保留。回归：`scripts/test/offline/rerank.test.mjs`。

## 9. 模型解析与错误信封（MG-008 余项）

### 9.1 单一模型解析入口

`modelTarget(cfg, modelName, pid)`（src/router.js）返回 `{ servingName, api, effortFormat, maxTokensMax }`：

- `servingName = models.<名>.providerModels[pid] || 模型名`（per-上游覆盖名）；
- `api = models.<名>.api || providers.<pid>.api || openai`（per-model 协议优先）；
- 转发（forward.js）、模型连通测试（probeModel/doProbeModel）、缓存预热（warm）、failback 探活（probeChat）全部走此入口，避免“转发用覆盖名、预热用网关名”这类同名不同路。
- 预热与 failback 还按协议生成 path/body 与鉴权头：Anthropic `/v1/messages` + `x-api-key`/`anthropic-version`；Gemini `:generateContent`/`:streamGenerateContent?alt=sse` + `x-goog-api-key`。Anthropic/Gemini 的预热消息会补一条 user 消息（协议要求至少一条非 system 消息）。
- 回归：`scripts/test/offline/model-resolution.test.mjs`。

### 9.2 上游错误信封映射

非 OpenAI 上游的**非 2xx 原生错误信封**在数据面返回前统一映射为 OpenAI 形状（状态码保留）：

```json
{ "error": { "message": "...", "type": "upstream_error", "code": "<上游 type/status/code>" } }
```

- Anthropic：`{ "type":"error", "error": { "type", "message" } }` → `code = error.type`；
- Gemini：`{ "error": { "code", "message", "status" } }` → `code = error.status`；
- 已是 OpenAI 形状（如代理已转译）或无法解析的 body **原样透传**；OpenAI 上游不做映射；
- 映射只影响客户端可见 body：日志仍记录上游原始响应片段；带内容的 4xx/上游侧故障继续按既有分类走 fallback 链。

有损：上游专有错误 type/status 被折叠进 `code`，`error.details`/`error.type` 以外的富字段丢弃。
