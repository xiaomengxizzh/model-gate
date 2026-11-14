# Codex v2 子代理：wire 事实、互操作映射与可读性边界（E4）

> 状态：**离线实现与回归完成（2026-11-11）**；真实 v2 跨供应商端到端 **NOT_RUN**（需 E3 官方登录 + 单独授权）。
> 基线：`dev/codex-aggregation-20261111` @ `ec66b24`（= Draft PR #5 head）。
> 代码：[`src/codex/interop.js`](../../src/codex/interop.js)、[`src/responses.js`](../../src/responses.js)、[`src/index.js`](../../src/index.js)（仅原生透传校验一行）。
> 回归：[`scripts/test/offline/codex-interop.test.mjs`](../../scripts/test/offline/codex-interop.test.mjs)（15 用例）。
> 决策背景：D3（v2 优先、加密任务显式阻断）与 E4 验收项；计划见 [E0 基线](../roadmap/2026-11-11-codex-aggregation-e0-baseline.md)。

## 1. 为什么需要这一层

Codex 0.167 已取消 `wire_api="chat"`，每轮固定向 `/v1/responses` 发送托管工具与命名空间（namespace）工具；而第三方 OpenCode Go 等上游只有 Chat Completions。`src/responses.js` 旧实现把 `web_search` / `namespace` 整条丢弃并记 `tool_dropped:<type>`——真实客户端**看起来能跑**，但 M2（GPT 主代理创建第三方子代理）不可能成立：模型看不到子代理工具，也无法把带 `namespace` 的调用告诉 Codex。

本层做三件事：

1. **可逆表达**：把 `namespace` 内嵌 function 展开成合法的 Chat function 名；回程（JSON 与 SSE 事件）再还原成 Codex 需要的 `{name, namespace}`。
2. **显式不支持**：Chat 无法表达的托管工具逐项产出稳定错误码 `unsupported_tool`（而不是静默丢弃），并允许切换成整条请求失败。
3. **可读性判定**：v2 的加密任务内容在桥方向显式 `v2_encrypted_task_unsupported`；绝不解析、删除、伪造密文，也不静默降级 v1。原生 Responses 透传路径原样交给上游。

## 2. 实测方法与证据（无网络、无真实凭据）

隔离边界：临时 `CODEX_HOME=/tmp/mg-e4/codex-home-*`、本地 mock（`127.0.0.1:0` 系统分配端口）、`PROBE_API_KEY=sk-dummy-not-a-real-key`、`--sandbox read-only`；**未读写 `~/.codex`，未访问任何真实上游**。

复现最小步骤（Node 内置模块，零依赖）：

```bash
# 1) 本地 mock：记录 POST /v1/responses 的 body，返回最小 Responses SSE（message "ok"）
#    端口用 server.listen(0, '127.0.0.1') 由系统分配。
# 2) 临时 CODEX_HOME 写 config.toml（自定义 provider，base_url 指向 mock）：
cat > /tmp/mg-e4/codex-home/config.toml <<'EOF'
model = "probe-model"
model_provider = "probe"
approval_policy = "never"

[model_providers.probe]
name = "Probe"
base_url = "http://127.0.0.1:<mock-port>/v1"
wire_api = "responses"
env_key = "PROBE_API_KEY"
EOF

# 3) 跑一轮（默认 v2 关闭）：
CODEX_HOME=/tmp/mg-e4/codex-home PROBE_API_KEY=sk-dummy-not-a-real-key \
  codex exec --ephemeral --sandbox read-only --skip-git-repo-check "say hi"

# 4) 开 v2 再跑一轮：
CODEX_HOME=/tmp/mg-e4/codex-home-v2 PROBE_API_KEY=sk-dummy-not-a-real-key \
  codex exec --ephemeral --sandbox read-only --skip-git-repo-check --enable multi_agent_v2 "say hi"
```

抓到的请求体（本轮真实形状，正文已最小化）关键字段：

```jsonc
{
  "model": "probe-model", "stream": true, "tool_choice": "auto", "parallel_tool_calls": true,
  "store": false, "include": ["reasoning.encrypted_content"],
  "reasoning": { "summary": "auto" },
  "tools": [ /* 9 项，见下 */ ],
  "input": [ /* message×4：developer 系统提示、skills、environment_context、user "say hi" */ ]
}
```

### 2.1 每轮 tools 的真实形状（9 项）

| 类型 | 内容 |
| --- | --- |
| `function` × 8 | `exec_command`、`write_stdin`、`request_user_input`、`view_image`、`get_goal`、`create_goal`、`update_goal`（字段：`type,name,description,strict,parameters`） |
| `namespace` × 1 | v2 关闭：`multi_agent_v1`（5 个 nested function：`close_agent,resume_agent,send_input,spawn_agent,wait_agent`）；`--enable multi_agent_v2`：`collaboration`（6 个：`followup_task,interrupt_agent,list_agents,send_message,spawn_agent,wait_agent`） |
| 托管 × 1 | `{ "type": "web_search", "external_web_access": ... }` |

namespace 项形状：

```jsonc
{ "type": "namespace", "name": "multi_agent_v1", "description": "Tools for spawning and managing sub-agents.",
  "tools": [ { "type": "function", "name": "spawn_agent", "description": "…", "strict": false, "parameters": { … } } ] }
```

### 2.2 命名空间调用在 wire 上怎么表示（关键新事实）

Codex 回放历史时，命名空间工具调用是**带 `namespace` 字段的 `function_call` item**：

```jsonc
{ "type": "function_call", "status": "completed", "id": "fc_…", "call_id": "call_…",
  "name": "wait_agent", "namespace": "multi_agent_v1", "arguments": "{\"targets\":[\"…\"]}" }
```

用本地 mock 回发不同形状后实测路由结果（`codex exec` stderr 判定）：

| mock 回发的 item | Codex 结果 |
| --- | --- |
| `{name:"wait_agent"}`（无 namespace） | `error=unsupported call: wait_agent` |
| `{name:"multi_agent_v1.wait_agent"}` | `error=unsupported call: multi_agent_v1.wait_agent` |
| `{name:"wait_agent", namespace:"multi_agent_v1"}` | **正常路由进工具**（仅因 agent id 非法而报参数错） |

进一步把 namespace 只放在 `response.completed.response.output`、或只放在 `response.output_item.done`：**只有 item 事件带 namespace 才会被路由**。因此回程还原必须覆盖 `response.output_item.added/done`（Codex 实际依据），终态对象也一并还原（其它客户端可能读终态）。

### 2.3 v2 子代理历史：`agent_message` 与加密边界

启用 v2 并让 mock 返回一次 `collaboration.spawn_agent` 调用后（`--ephemeral` 会因无 rollout 失败，需在临时 `CODEX_HOME` 内保留 session），父线程下一轮出现：

```jsonc
{ "type": "agent_message", "id": "amsg_…", "author": "/root", "recipient": "/root/probe_task",
  "content": [
    { "type": "input_text", "text": "Message Type: NEW_TASK\nTask name: /root/probe_task\nSender: /root\nPayload:\n" },
    { "type": "encrypted_content", "encrypted_content": "…" }
  ] }
```

同时 `spawn_agent` 的返回是 `{"task_name":"/root/probe_task"}`；v2 工具 schema 里 `message` 参数带 `"encrypted": true` 标记：

```jsonc
"message": { "type": "string", "description": "Initial plain-text task for the new agent.", "encrypted": true }
```

**判定规则（网关侧）**：只要 `input[]` 里出现 `encrypted_content` 或 `encrypted_task_id`（含 function_call arguments / function_call_output 的 JSON 内），就按"不可读 v2 任务"处理。理由：

- 字段语义是"由后端加密的不透明内容"，网关没有密钥，也无法验证能否解密；
- 本轮 mock 场景下该字段恰好是明文（mock 就是"服务端"，没有加密能力），但**网关不能依赖这个巧合**；把 `encrypted_content` 当普通文本透传/改写会在真实官方路径上变成"假装解密成功"。
- 因此网关只做**不透明判定**：不解析、不打印、不删除、不伪造，也不把整会话静默降级成 v1。

## 3. 映射规则（`src/codex/interop.js`）

### 3.1 工具展开（请求方向）

| Responses 工具 | Chat 表达 | 可逆性 |
| --- | --- | --- |
| `{type:"function",name,description,parameters,strict}` | 同名 `{type:"function",function:{…}}` | 原样 |
| `{type:"custom",name,format}` | function 模拟（参数 `{input:string}`），`format` 记 `custom_tool_format` | 有损（既有行为） |
| `{type:"namespace",name,tools:[function…]}` | 每个 nested function 展开为 `mg_ns__<namespace>__<tool>`，描述加 `[namespace <ns>] ` 前缀 | **可逆**（`decodeNamespacedToolName`） |
| `web_search` / `file_search` / `code_interpreter` / `mcp` / `computer_*` / `image_generation` / `local_shell` / 未知 | 不下发给 Chat 上游 | 逐项 `unsupported_tool` |

约束与保护：

- 展开名只允许 `[A-Za-z0-9_-]` 且 ≤ 64 字符（Chat function 名上限）；namespace 名不含保留分隔符 `__`，保证解码无歧义；超长/非法/重名会产出具体错误码 `tool_name_too_long` / `tool_name_invalid` / `tool_namespace_ambiguous` / `duplicate_tool_name:<name>` 并记 lossy。
- 空 namespace（无 nested tools）保留既有 `tool_dropped:namespace` 口径，同时进入 `unsupported` 列表。
- **默认策略 drop**：真实 Codex 每轮都发 `web_search`，整条拒绝等于"不支持 Codex"；因此默认只丢弃不可表达项，但结果里带 `unsupported:[{code:"unsupported_tool",toolType,…}]`，不再静默。需要强失败时传 `onUnsupportedTool:"reject"`（`responsesToChat`）/ `onUnsupported:"reject"`（`planChatTools`），返回 `400 {error:{type:"unsupported_tool"}}` 且不触上游。

### 3.2 调用配对（请求方向）

- `function_call` / `custom_tool_call`：`call_id` → Chat `tool_calls[].id`；带 `namespace` 时 name 先展开。
- `function_call_output`：`call_id` → `role:"tool"` 的 `tool_call_id`（同一 id，不重新生成）。
- 并行调用：多条调用合并进同一条 assistant 消息的 `tool_calls[]`，结果按到达顺序各自作为 tool 消息。
- 缺 `call_id` 不伪造配对：保留既有兜底 id，但显式记 `tool_call_missing_call_id`，并通过 `pairing.problems` 报告 `tool_call_missing_call_id` / `tool_output_without_call` / `tool_call_without_output` / `duplicate_call_id`。

### 3.3 回程还原（响应方向）

- 非流式：`chatToResponse` 对每个 `tool_call.name` 调 `collapseToolCallName`，命中展开名则输出 `{name, namespace}`。
- 流式：`makeSSEWriter.beginToolCall/endToolCall` 在 `response.output_item.added/done` 里直接给 `{name, namespace}`；`completed()` 还会归一化终态 `response.output[]`。`responses-stream.js` 无需改动即可获得该行为。
- 普通 function / custom 工具名不含前缀，原样保留；用户若自定义以 `mg_ns__` 开头的函数名，回程可能被误判为展开名——该前缀属保留命名，见 §6 风险。

### 3.4 v2 任务判定

| 输入 | 行为 |
| --- | --- |
| `agent_message` 的 content 含 `encrypted_content`；或 v2 子代理工具（`spawn_agent`/`send_message`/`followup_task`）的 arguments/output 含 `encrypted_content`；或任何位置出现 `encrypted_task_id` | 桥方向 `400`，`error.type = "v2_encrypted_task_unsupported"`；不触上游；错误信息不含密文。普通工具里恰好同名的业务字段不误判（有回归用例） |
| `agent_message` 只有文本 part | 降级成一条 user 消息（保留 `[author=… recipient=…]` 标注），记 `agent_message_text_flattened` |
| 原生 Responses 透传（`models.<名>.api="responses"`） | 只做顶层拒绝矩阵（`store`/`previous_response_id`/`background`/`include`/`truncation`），`input`/`tools` 原样交给上游 |

原生路径的实现落点：`src/index.js` 的原生分支调用 `responsesToChat(body, { mode: 'native' })`；`mode:'native'` 是 E4 新增的显式开关，默认 `'bridge'` 行为完全不变（既有 `responses-mapping` / `responses-endpoint` / `hosted-tools` 回归全绿）。

## 4. 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/codex/interop.js` | 纯函数：`planChatTools`、`encode/decodeNamespacedToolName`、`collapseToolCallName`、`collapseResponseOutputItems`、`normalizeInputToolCall`、`detectOpaqueV2Task`、`flattenAgentMessage`、`analyzeToolPairs` |
| `src/responses.js` | 接入映射：`mapTools` 委托 `planChatTools`；`responsesToChat(input, opts)` 新增 `mode`/`onUnsupportedTool` 与 v2 判定；`chatToResponse`/`makeSSEWriter` 还原 namespace |
| `src/index.js` | 仅原生分支一行：`responsesToChat(body, { mode: 'native' })` |

## 5. 验证

```bash
npm run check
npm test
npm run docs:check
node scripts/check-metadata.mjs
node --test scripts/test/offline/codex-interop.test.mjs   # 15 用例
```

`codex-interop.test.mjs` 覆盖：

1. 真实 tools 形状展开（1 普通 + namespace 5 + web_search），展开名长度/字符/可逆性；
2. v2 `collaboration` 展开、嵌套不可表达工具、空 namespace、`onUnsupported:"reject"`；
3. 并行调用合并、`call_id` 配对、缺失 id 诊断；
4. 加密判定只返回信号（断言信号 JSON 不含密文串），`encrypted_task_id` 在 tool arguments 内也能识别；
5. 桥方向加密 `agent_message` → `v2_encrypted_task_unsupported`；可读 `agent_message` → 降级 + lossy；
6. `mode:'native'` 不因 v2 密文/托管工具误拒，但顶层拒绝矩阵仍生效；
7. `chatToResponse` 与 SSE writer 三处（added/done/completed）还原 `name+namespace`；
8. 隔离网关集成：原生 `/v1/responses` 收到原样 `agent_message`+密文+namespace（不 400）；同请求走 Chat 桥 → 400 且不触上游；桥方向展开工具下发、上游用展开名回调用、客户端拿到 `{name:"spawn_agent",namespace:"collaboration",call_id:…}`（JSON 与 SSE 各一遍）。

## 6. 边界、NOT_RUN 与风险

**NOT_RUN（需 E3 + 单独授权）**

- 真实官方 v2 端到端：GPT 主代理创建第三方子代理、第三方收到可读任务、执行真实工具、父线程续轮。本轮只有 mock wire 级证据。
- 真实密文的可读性/可解密性：网关不尝试解密，因此"官方后端写入的 `encrypted_content` 是否可被任何第三方还原"仍未验证；按 D3 显式阻断。
- Codex Desktop 的 v2 行为；真实工具执行（宿主 bwrap 仍不可用，本轮 mock 工具调用仅到 `unsupported call`/参数错误层）。
- 把 `onUnsupportedTool:"reject"` 暴露成配置项（当前只有代码级选项）；E5 路由层对 `v2_encrypted_task_unsupported` 的候选筛选。

**风险**

1. **密文与明文不可区分**：`encrypted_content` 在某些本地/自建后端可能是明文（本轮即如此）。策略选择"一律不可读"，代价是这类自建链路的 v2 任务在桥方向也会被拒——这是 D3 要求的显式失败，而不是静默冒险。
2. **命名约定占用**：`mg_ns__` 是保留前缀；用户自定义同名 function 可能被回程误还原。缓解：`decodeNamespacedToolName` 只在形状完全合法时命中；后续可加显式别名表（需跨请求状态，暂不引入）。
3. **托管工具仍不可执行**：`web_search`/`mcp` 等只能显式不支持；Chat 上游本身没有这些能力，网关不能凭空补齐。
4. **feature flag**：`multi_agent_v2` 在 Codex 0.167 默认 false（stable）。D3 的"v2 优先"必须显式 enable 并留证；关闭时走 `multi_agent_v1` namespace，本层对两者一视同仁。
5. **v1 静默降级禁令**：网关不切换 Codex 的 feature flag、不改 `config.toml`；本层只表达请求，不改客户端。

## 7. 回滚

纯增量：新增 `src/codex/interop.js` 与本文档、新增测试；`src/responses.js` 的改动可单独 revert 回"丢弃托管工具"旧行为；`src/index.js` 只有一行 `{ mode: 'native' }`。无配置、无数据、无迁移。
