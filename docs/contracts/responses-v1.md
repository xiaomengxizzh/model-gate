# Responses / Codex 接入契约 v0（MG-015）

状态：**Chat 桥与原生 `api:"responses"` 透传均已实现（2026-11-09），真实 Codex/DSH 客户端对照未执行，未冻结**。实现：`src/responses.js`（纯映射）、`src/responses-stream.js`（Chat SSE → Responses 事件桥）、`src/index.js` 入口接线；回归 `scripts/test/offline/responses-mapping.test.mjs`（17 用例）与 `responses-endpoint.test.mjs`（6 用例）。本文件定义 `/v1/responses` 的入口、路由、wire 映射与验收边界，是 MG-015 的实现依据；实现前先补失败复现与 wire fixture。依赖 MG-002（请求生命周期预算，已闭环）、MG-004（测试隔离，已闭环）、MG-016（管理面契约基线，已闭环）。

> 审计边界：Draft PR #2 与真实 Codex CLI/桌面、DSH 对照**未审计、未执行**（本机无网络与 `gh`，未做任何 PR 内容推断）。本文只依据本仓库现有实现（`src/router.js`、`src/format.js`、`src/forward.js`、`docs/reference/protocol-bridge.md`）与 OpenAI Responses 公开语义撰写。

## 1. 目标与非目标

- 目标：让 Codex CLI / 桌面与其它 Responses 客户端可以把网关当作 OpenAI 兼容入口；复用现有治理（模型/别名/虚拟模型、fallbacks、熔断、配额、统计、缓存亲和、日志脱敏、请求预算、SSE 背压）。
- 非目标：不实现 OpenAI 托管侧专有行为（web search / file search / code interpreter 等托管工具、后台任务、远程 MCP）；仍以 Chat 能力为可实现子集。不改官方 `auth.json`、不改 Codex 客户端源码。

## 2. 入口契约

| 项 | 约定 |
| --- | --- |
| 方法/路径 | `POST /v1/responses`（兼容别名 `POST /responses`，与现有 `CHAT_PATHS` 同等处理） |
| 鉴权 | 与数据面一致：全局客户端 Key（`Authorization: Bearer <key>`）或虚拟模型独立 Key；管理面来源策略（Host/Origin）同样生效 |
| 请求体 | JSON 对象；`model` 必填（或走 `defaults.model`/默认目录）；`input` 支持字符串或消息数组 |
| 流式 | `stream:true` → `text/event-stream`；`stream:false` → JSON |
| 响应 | 原生 Responses 形状（`object:"response"`、`output[]`、`usage`）；Chat 桥路径由网关重建同一形状 |
| 错误 | 响应头未发出时沿用数据面信封 `{error:{message,type}}`；已进入流式时用 `response.failed` 事件 + 终态（见 §6） |
| 其他 | 请求体大小、body 读取预算、整体 deadline、SSE 背压全部复用 MG-002 语义（不做第二套） |

## 3. 路由与协议选择

1. 模型解析、虚拟模型目录、`fallbacks`、`providerModels`、熔断/亲和/配额与 Chat 路径**完全相同**（同一 `forwardChain` 治理层）。
2. 协议落点沿用 per-model `api` 字段，新增值 `responses`：
   - `models.<名>.api = "responses"` 或 `providers.<id>.api = "responses"` → **原生转发**：路径 `/v1/responses`，鉴权头按上游协议注入，请求/响应尽量透传（只剥离管理凭据与逐跳头）。
   - 空/其它值 → **Chat 桥**：把 Responses 请求转换为 Chat Completions 请求发给上游，再把上游 JSON/SSE 重建为 Responses JSON/事件。
3. 默认必须是 Chat 桥；不得因为上游"看起来支持"就自动切原生（避免半兼容上游静默丢工具/推理字段）。
4. Chat 桥只支持文本与 function/custom tool；`background:true`、`previous_response_id` 续轮、`store:true`、`truncation` 在两条路径都必须**显式拒绝**（`400 unsupported_parameter`），不允许静默忽略。托管工具与命名空间分组见 4.2。
4.1 `include` 例外：真实客户端（Codex CLI、DSH headless）固定发 `include:["reasoning.encrypted_content"]`。网关本就不产生加密推理，该项在语义上等于"没有可返回的东西"，整条拒绝会让 Responses 入口对真实客户端完全不可用（2026-11-09 实测 DSH 0.2.2-rc.1 因此 400）。因此**只接受丢弃后不影响正确性的项**（`reasoning.encrypted_content`、`output_text.logprobs`）并记 `lossy: include_dropped:<项>`；图片/托管产物/未知项仍旧显式拒绝，避免静默丢掉客户端要求的产物。
4.2 托管工具与 `namespace` 分组：Chat 协议只能表达 function/custom tool，托管工具（`web_search` / `file_search` / `code_interpreter` / `mcp` / `computer_*` / `image_generation` / `local_shell`）与命名空间分组（Codex 的 `type:"namespace"`，如 `multi_agent_v1`）在桥方向**丢弃并逐项记 `lossy: tool_dropped:<type>`**；`tool_choice` 点名被丢弃的工具时降级为 `auto` 并记 `tool_choice_dropped:<name>`（否则上游会因"无名工具"400）。理由：Codex 0.167 已取消 `wire_api="chat"`（openai/codex discussions#7782 要求统一 `responses`），而它每轮固定发送 `namespace` 与 `web_search`；按 4. 整条拒绝等于"不支持 Codex"，与 MG-015 目标冲突。原生 `api:"responses"` 透传不经过桥映射，工具原样交给上游。

## 4. 请求映射（Chat 桥）

| Responses 字段 | Chat Completions | 说明 |
| --- | --- | --- |
| `input` 字符串 | `messages:[{role:"user",content:<str>}]` | 原样 |
| `input[] role=user/assistant/system/developer` | 同名 role（`developer`→`system`） | 多段 content 的 `input_text`/`output_text` 拼接为文本；非文本 part 见 §7 有损清单 |
| `input[] role=tool / function_call_output` | `messages[role=tool]` | `call_id` → `tool_call_id` |
| `input[] function_call / custom_tool_call` | `assistant.tool_calls[]` | `call_id`→`id`；`name`/`arguments` 原样。`custom_tool_call` 的 `input`（自由文本）必须编码为 `{"input": "<raw>"}` 的 arguments，并记录"有损" |
| `instructions` | 首条 `system` 消息 | 与 `input` 内 system/developer 合并顺序：instructions 在前 |
| `tools[{type:"function",name,description,parameters,strict}]` | `tools[{type:"function",function:{name,description,parameters}}]` | `strict` 透传（上游支持时） |
| `tools[{type:"custom",name,format}]` | `tools[{type:"function",function:{name,...}}]` | Chat 无 custom tool 语义；以 function 模拟，`format` 的有损见 §7 |
| `tool_choice` | 同义映射 | `auto/required/none`；指定函数→`{type:"function",function:{name}}`；`allowed_tools` 无法表达 → 有损 |
| `max_output_tokens` | `max_tokens` | 受 `models.<名>.maxTokensMax` 归一化 |
| `temperature/top_p` | 同名 | 原样 |
| `reasoning.effort` | `reasoning_effort` | 复用 `canonEffort` 与 per-route `effortFormat` 整形 |
| `stream` | `stream` | 桥路径始终向上游请求流式（除非模型 `forceNoStream`），再按客户端 `stream` 决定是否聚合 |
| `metadata`, `user` | 丢弃 | 有损；网关不向上游透传调用方任意元数据 |
| `previous_response_id`, `store`, `background`, `truncation` | **拒绝** | 见 §3.4 |
| `include`（仅 `reasoning.encrypted_content` / `output_text.logprobs`） | 接受并**记有损** | 见 §3.4 |
| `include`（其它项） | **拒绝** | 见 §3.4 |
| 托管工具 / `namespace` 分组 | 丢弃 + 记 `tool_dropped:<type>` | 见 §3.2 4.2 |

## 5. 响应映射（Chat 桥，非流式）

Responses 响应最小形状：

```jsonc
{
  "id": "resp_<gateway-id>",
  "object": "response",
  "created_at": 1794190000,
  "status": "completed",
  "model": "<客户端请求名>",
  "output": [ { "type": "message", "role": "assistant", "content": [ { "type": "output_text", "text": "..." } ] } ],
  "output_text": "...",           // 便捷聚合（可选）
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "input_tokens_details": { "cached_tokens": 0 }, "output_tokens_details": { "reasoning_tokens": 0 } }
}
```

- 上游 `message.content` → 一个 `message` output item；`tool_calls[]` 每个 → `{type:"function_call", call_id, name, arguments, status:"completed"}`；`custom` 工具来自桥方向的调用在回程还原为 `custom_tool_call` 仅在网关能识别时（Chat 上游不区分，默认按 function_call 返回，记录有损）。
- `finish_reason=length` → `status:"incomplete"` + `incomplete_details:{reason:"max_output_tokens"}`；`content_filter` → `status:"incomplete"` + `reason:"content_filter"`；其余 completed。
- `model` 一律回写为客户端请求名（与 Chat 路径的"名字没对上"加固一致）。
- usage 复用 `format.js` 的归一化（Anthropic/Gemini usage 先转为 Chat usage，再映射为 Responses usage；`reasoning_tokens` 无来源时写 0，不臆造）。

## 6. 流式事件顺序（Chat 桥 → Responses SSE）

必须按以下顺序，每个事件一帧 `event: <type>` + `data: <json>`：

1. `response.created`（status `in_progress`，含 id/model）
2. `response.in_progress`（可省略，但一旦发出必须紧跟 created）
3. 文本增量：`response.output_item.added`（message item）→ `response.content_part.added` → 每个 delta 一条 `response.output_text.delta` → `response.output_text.done` → `response.content_part.done`
4. 工具调用：`response.output_item.added`（function_call）→ 每个参数增量 `response.function_call_arguments.delta` → `response.function_call_arguments.done` → `response.output_item.done`
5. `response.completed`（含最终 `response` 对象与 usage）
6. 失败：`response.failed`（`error:{code,message}`），随后不得再发 `completed`；预算耗尽沿用 MG-002 的 `code:"REQUEST_TIMEOUT"`。
7. 取消：客户端断开 → 与 Chat 路径相同：销毁上游、不续传、不记账为上游失败（MG-002 §3）。

约束：事件 ID 与 `sequence_number` 单调递增；`[DONE]` 在 Responses 协议中**不使用**（以 `response.completed`/`response.failed` 为终态）。原生转发路径按上游原样透传事件，但同样受 SSE 背压与预算约束。

## 7. 有损转换清单（必须显式记录）

| 项 | 方向 | 有损点 |
| --- | --- | --- |
| `custom_tool_call` / `custom` tool 的自由文本 `input` | 请求/响应 | Chat 只有 JSON arguments；桥侧编码为 `{"input":...}` 并在响应侧标签上可能丢失 custom 类型 |
| `allowed_tools` / `parallel_tool_calls` 约束 | 请求 | Chat 无法表达细粒度允许列表；`parallel_tool_calls:false` 只能尽量提示 |
| `reasoning` 的 summary/encrypted content | 请求/响应 | Chat 无对应字段；只保留 effort 档位 |
| `store/previous_response_id/background` | 请求 | 明确拒绝，不静默降级 |
| `include: reasoning.encrypted_content / output_text.logprobs` | 请求 | 接受但丢弃（按契约 §3.4 4.1 记 `lossy: include_dropped:<项>`）；客户端拿不到加密推理与 logprobs |
| 托管工具（`web_search` / `file_search` / `code_interpreter` / `mcp` / `computer_*` / `image_generation` / `local_shell`）与 `namespace` 分组 | 请求 | **丢弃并记 `tool_dropped:<type>`**；`tool_choice` 点名被丢弃工具 → 降级 `auto` + `tool_choice_dropped:<name>`（见 §3.2 4.2） |
| 图片/文件/音频输入 | 请求 | 与现有 Chat 桥一致：丢弃非文本 part（见 protocol-bridge 有损清单） |
| 上游专有 `finish_reason` | 响应 | 收敛为四个 OpenAI 值（复用现有映射） |
| 事件级 `sequence_number` | 响应 | 原生路径透传上游值；桥路径由网关生成，与上游原始序号不可比 |

## 8. 测试矩阵（离线优先）

| 层 | 用例 | 类型 |
| --- | --- | --- |
| 映射纯函数 | 请求/响应/tool/custom tool/usage/finish 映射表逐项 | 单元（新 `src/responses.js` + wire fixture） |
| 桥流式 | delta 顺序、tool 参数分片、completed/failed 终态、`response.output_text.done` 只一次 | 单元（构造上游 SSE 帧） |
| 治理复用 | 虚拟模型/别名/fallbacks/配额/熔断/亲和/日志脱敏在 Responses 入口生效 | 集成（隔离网关 + 本地 mock 上游） |
| 预算/背压 | MG-002 AC 在 Responses 入口复跑（慢头、慢 body、流式预算、慢客户端） | 集成（复用 `harness.mjs`） |
| 原生转发 | `api:"responses"` 时路径/鉴权头/逐跳头剥离/错误信封 | 集成（mock 上游断言收到路径与头） |
| 拒绝项 | 托管工具/background/previous_response_id/store → 400 且未触上游 | 集成 |
| 真实对照 | Codex CLI/桌面、DSH 三家；记录版本与 SHA | **单独授权后才做**，不在离线套件 |

## 9. 实现状态（2026-11-09）

### 9.1 已实现

- 入口：`POST /v1/responses` 与 `/responses`；非 POST → 405；鉴权/虚拟模型 Key/配额/熔断/亲和/统计/日志脱敏全部复用 Chat 路径（同一 `forwardChain`）。
- 请求映射：`responsesToChat()` 覆盖 §4 表格；拒绝矩阵（store/previous_response_id/background/truncation/托管工具、以及不可丢弃的 `include` 项）返回 `400 {error:{message,type:'unsupported_parameter'}}` 且不触上游。
- 非流式：上游 Chat JSON → `chatToResponse()`（`resp_*` id、`model` 回写、output/output_text、usage 映射、incomplete_details）。
- 流式：`createResponsesStream()` 复用 `relayStream`（续传/空闲看门狗/MG-002 预算/背压），把 Chat SSE 帧翻译为 §6 事件序列；不发 `[DONE]`；预算耗尽/断流以 `response.failed`（`code=REQUEST_TIMEOUT`/`STREAM_INTERRUPTED`）收尾。
- 降级：客户端 `stream:true` 但上游返回 JSON（forceNoStream/混合协议降级）时以单帧事件序列交付。
- 回归：`responses-mapping.test.mjs` 17 用例 + `responses-endpoint.test.mjs` 6 用例（非流式、拒绝、SSE 顺序、工具分片、错误透传、405），并随 `npm test` 运行。

### 9.2 未实现 / 未验证

- **原生透传已实现（2026-11-09）**：`models.<名>.api="responses"`（保存校验已允许）时，`/v1/responses` 不做 Chat 桥转换：请求原样发往 `responsesPath`（默认 `/v1/responses`，支持 `providerModels` 覆盖名），非流式 JSON 透传并把 `model` 回写客户端请求名，流式 SSE 逐字节管道（不翻译事件；**原生流不改 model 字段**，见 §7 有损）。拒绝矩阵与能力隔离仍然生效。回归 `scripts/test/offline/responses-native.test.mjs`（4 用例）。
- **真实 Codex CLI/桌面与 DSH 对照：UNVERIFIED**（本机无网络/未做真实客户端测试）。
- **Draft PR #2 审计：UNVERIFIED**（未联网，未做任何内容推断）。
- 工具流的并行多调用以“收尾时逐条补发完整参数”呈现，不是逐调用并行 delta；custom tool 回程默认 function_call（`ctx.customToolNames` 才还原）。

## 10. 未验证与待决

- **UNVERIFIED**：Draft PR #2 内容与 SHA（本机无网络/无 `gh`，未执行 `git fetch`/API 查询）；真实 Codex/DSH 行为与字段版本兼容性。
- 待决：原生 Responses 上游列表（哪些 provider 实际支持、是否需要 per-provider 开关）、`strict`/structured outputs 的桥接深度、是否提供 `GET /v1/responses/:id`（当前设计为不提供，且不存响应）。
- 实现顺序：先 `src/responses.js` 纯映射 + fixture，再接 `src/router.js` 路径与 `src/format.js` 适配器，最后在 `forward.js/index.js` 接线（必须等 MG-008 余项收口，避免同文件多作者）。

## 11. 验收（实现时）

1. 全部 §8 离线用例通过，且默认套件（含 legacy 27 文件）不回归；
2. 拒绝项不触上游、不产生 5xx；
3. 错误/取消/usage/配额与 Chat 路径同一口径；
4. 文档 `protocol-bridge.md`、配置参考（`api` 取值新增 `responses`）与 CHANGELOG 同步；
5. 真实客户端对照单独记录，包含版本、命令与 SHA，未做就写 UNVERIFIED。
