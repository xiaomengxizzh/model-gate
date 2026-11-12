# Codex 原生 Multi-Agent V2 跨供应商契约 v0（MG-017）

状态：**实现与离线验收完成（2026-11-12），真实验收待用户授权**。基线 `dev/gateway-audit-20261108@3a4ba8956732e2aabdff2cfce8a118107189542a`；任务工作树分支 `codex-multiagent-v2`。离线验收：映射 44 / SSE 38 / 路由 8 / 生命周期 gated 16 全过；真实 GPT+DeepSeek、CLI/Desktop GUI、ChatGPT 工作区属 `BLOCKED_PENDING_AUTHORIZATION`。审计依据 `/home/xiaomengxizi/.codex/visualizations/2026/11/12/01a1ce0e-afae-77c3-90fc-cca8854fad99/modelgate-codex-multi-agent-v2.md`。路线 **A 主导、B 补充**：Codex 持有线程/工具/权限/收件箱/并发/调度/取消/通知/恢复；ModelGate 只做模型路由、请求/响应转换、鉴权隔离、推理流治理。

**新增大型安装/下载：无；历史提议仅供研究，不自动执行。**

## 1. 现场基线（2026-11-12 实测）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 分支 / HEAD | `dev/gateway-audit-20261108` @ `3a4ba895…` | `git rev-parse`；与审计基线一致，无跟踪文件改动 |
| 用户未跟踪文件 | `config/videos.json`、`scripts/tray/{icons/,mg-prices.json,mg-tray-linux.py}` | 原工作区保持只读，未改动 |
| Node | v24.22.2 | `node -v` |
| Codex CLI | `0.167.0`（`/home/xiaomengxizi/ai/harness/codex/cli/bin/codex` → `versions/0.167.0/…/codex`） | `codex --version` |
| Desktop 捆绑 | `0.167.0-alpha.3.2`（`/usr/lib/chatgpt/resources/codex`，另有 `~/.codex/plugins/.plugin-appserver/codex` 同版本） | `--version` |
| Feature 现状 | `multi_agent=true(stable)`、`multi_agent_v2=false(stable)`、`multi_agent_v2_dynamic_tools=false`、`code_mode=false` | `codex features list`；`-c features.multi_agent_v2=true` 可显式开启 |
| 基线回归 | `npm run check`=0；`npm test`=25/25 套件；三个 Responses 套件 27/27 | 本文件 §10 记录命令 |
| 现场缺陷 | ① 原生分支用 `responsesToChat()` 当校验 → 明文 `agent_message` 400；② Chat 桥丢 `namespace`（`tool_dropped:namespace`），`function_call` 的 namespace/`encrypted_function_args` 无法保真；③ 原生透传无目的端投影、无工具项恢复、无流式终态记账；④ `resolve()` 未知名可落 `defaults.provider` | `/tmp/mg-baseline-repro.mjs` 合成复现（§10.3） |

## 2. 目标与非目标

目标：同一原生 Codex 会话内，GPT 根代理与 DeepSeek 子代理分别路由到各自上游；网关负责把 V2 协作工具声明成上游可消费的明文形状、把完成项恢复成 Codex 原生形状、把 DeepSeek 不认识的 `agent_message` 投影为标准 user message，并在流式路径上保持事件身份、终态、usage 与取消语义。

非目标（首版显式不做）：WebSocket 上游、远程 compaction、`previous_response_id` 续轮、托管工具转发、Codex 线程/邮箱/任务状态的网关侧重建、跨供应商历史迁移、ChatGPT 工作区认证实现（仅留契约与合成 header 测试）。

## 3. 冻结配置契约

```jsonc
{
  "providers": {
    "openai-official": { "baseUrl": "https://api.openai.com", "apiKeyEnv": "OPENAI_API_KEY", "api": "responses" },
    "deepseek-official": { "baseUrl": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY", "api": "responses" }
  },
  "models": {
    "codex-gpt": {
      "provider": "openai-official",
      "api": "responses",
      "providerModels": { "openai-official": "gpt-6.1-sol" },
      "maxContext": 200000,
      "codex": { "multiAgentVersion": "v2", "plaintextTools": true,
                 "history": { "agentMessage": "preserve", "reasoning": "preserve", "compaction": "reject" } }
    },
    "codex-deepseek": {
      "provider": "deepseek-official",
      "api": "responses",
      "providerModels": { "deepseek-official": "deepseek-v4-pro" },
      "maxContext": 128000,
      "codex": { "multiAgentVersion": "v2", "plaintextTools": true,
                 "history": { "agentMessage": "project", "reasoning": "drop", "compaction": "reject" } }
    }
  },
  "defaults": { "codex": { "strictModelRouting": true } }
}
```

规则（保存校验与运行时都必须执行）：

1. `codex` 仅允许出现在 `api:"responses"` 的非虚拟模型上；出现即视为**试点路由**。
2. `codex.multiAgentVersion` 仅接受 `"v2"`。`codex.plaintextTools` 仅布尔。`codex.namespace` 可选，默认 `"collaboration"`，仅接受该默认值（其它值首版拒绝，避免与服务端契约分叉）。
3. `codex.history.agentMessage` ∈ `preserve|project|reject`；`.reasoning` ∈ `preserve|drop|reject`；`.compaction` ∈ `reject|drop`（默认 `reject`）。
4. 试点路由**禁止 fallbacks**（保存 400：`codex 试点模型不允许 fallbacks`），运行时也只打 `model.provider` 单一上游，不做跨上游迁移。
5. `defaults.codex.strictModelRouting=true` 时，`/v1/responses` 上**未在 models 声明**的模型名一律 400 `unknown_model`，不得回落 `defaults.provider`；已声明但非 codex 试点模型保持原有行为。
6. 凭据隔离：数据面只允许注入该路由 provider 的服务端凭据；客户端带来的 `authorization`/`cookie`/`chatgpt-account-id`/`openai-*`/`x-api-key` 一律不转发。ChatGPT 工作区模式（后续阶段）只能以 allowlist 形式把指定官方头转发到**固定官方端点**，首版不实现，仅保留合成 header 测试断言"当前不透传"。
7. 示例文件 `config/gateway.json` 只放无密钥样例；凭据只经 `keys.local.json`/环境变量。

## 4. 冻结模块接口

### 4.1 `src/codex-responses.js`（纯函数，零 import）

```js
// route 由 router.codexRoute() 产出，形状固定：
// { alias, provider, upstreamModel, api:'responses',
//   codex:{ multiAgentVersion, plaintextTools, history:{agentMessage,reasoning,compaction}, namespace } }

export function validateCodexResponsesEnvelope(body)
  // -> { ok:true, lossy:[] } | { ok:false, rejected:{ code, message } }
  // 只校验 Responses 原生信封：model 必填字符串；input 为字符串或数组；
  // 拒绝 store=true / background=true / previous_response_id 非空 / truncation!='disabled'（沿用既有语义）；
  // include 仅接受可丢弃项（reasoning.encrypted_content / output_text.logprobs）；
  // 不因 agent_message / reasoning / namespace 工具而拒绝——那是 Chat 桥的语义。

export function buildToolPlan(tools, route)
  // -> { plan, rejected }；plan = {
  //      declared: Map<upstreamName, { kind:'function'|'custom'|'namespace',
  //                                   name, namespace, messagePlaintext, restoredName }>,
  //      declarations: [...给上游的 tools 数组...],   // 已投影
  //      toolChoice,                                   // 已映射
  //      lossy: [] }
  // 无 tools → declared 空 Map，declarations 为 undefined。
  // 冲突：同一 upstreamName 对应两个不同工具身份 → rejected{code:'tool_identity_conflict'}。

export function projectOrderedHistory(input, route, plan)
  // -> { input, lossy, rejected }；按原顺序逐项投影，绝不重排。
  // agent_message：仅当 route.codex.history.agentMessage==='project' 且整条消息可证明为明文
  //   （content 仅 input_text/text、正文为 string、无 encrypted_content 字段、无未知字段）时投影为
  //   标准 user message：content=[{type:'input_text',text: '[agent_message from=<author> to=<recipient>]\n<正文>'}]
  //   （author/recipient 缺失则省略该前缀；仅作文本，不提升权限）。
  //   preserve → 原样保留；reject → rejected{code:'agent_message_unsupported'}。
  //   任何非空 encrypted_content、未知字段、非字符串正文 → rejected{code:'opaque_agent_message'}（绝不猜测）。
  // function_call / custom_tool_call / function_call_output / custom_tool_call_output：
  //   按 call_id 配对校验（缺失/重复冲突 → rejected{code:'tool_call_pairing'}）；
  //   名字经 plan 反查，别名映射回原名；namespace 工具在该路由声明为扁平名时保留扁平名。
  // reasoning：preserve 原样；drop 省略并记 lossy 'reasoning_dropped'；reject → rejected{code:'reasoning_unsupported'}。
  //   带 encrypted_content 的 reasoning 永远不得转成文本。
  // compaction / unknown item type：按 route 能力 reject（默认 rejected{code:'unsupported_input_item'}）。

export function restoreToolItem(item, route, plan)
  // -> { item, lossy, rejected }；对完成态工具项：
  //   · 名精确命中 plan 中 namespace 工具 → 恢复 { namespace: route.codex.namespace, name: 原name }，
  //     去掉扁平别名；仅当该工具本轮以明文声明且参数合法时补 encrypted_function_args: []
  //   · 已存在非空 encrypted_function_args / 未知 opaque 字段 → rejected{code:'opaque_function_args'}
  //   · 调用 id / arguments 必须保留原值（不得改写 call_id、不得重算 arguments）
  //   · 其它工具原样返回

export function restoreResponseJson(json, route, plan)
  // -> { json, lossy, rejected }；对 output[] 逐项走 restoreToolItem；model 不回写（由调用方处理）。
```

冻结细节：三工具固定为 `spawn_agent`、`send_message`、`followup_task`（`COLLABORATION_TOOLS` 常量导出）。明文化只对这三者生效，判定只依据**本轮已声明**的工具身份，不依据 UA、名字相似或上游输出字段。扁平别名规则：默认用原名；若与同名普通 function 冲突，用 `<namespace>__<name>`（确定性，仅由本轮声明集合决定）。

### 4.2 `src/codex-responses-stream.js`

```js
export function createSSEParser()
  // -> { push(buf): string[], flush(): string[] }  // 返回**完整** SSE 事件块（含 event:/data: 行）
  // 缓冲式增量解析：UTF-8 多字节跨 chunk、CRLF/CR/LF、多行 data 以 \n 拼接、注释行、空行分隔。

export function createCodexStreamAdapter(res, { plan, route, model, id, createdAt, onUsage, log })
  // -> { push(chunk): Promise<void>, end(): Promise<void>, fail(note, extra): Promise<void>,
  //      events, terminal, usage }
  // push 内部：解析 → 逐事件规范化 → 写 res；res.write false 时等待 drain（复用 responses-stream.js
  //   makeSink 的 30s/8MiB 上限语义）。
  // 规范化仅改需要改的字段：
  //   · response.output_item.done / response.output_item.added 的 item 走 restoreToolItem
  //     （added 只恢复身份/namespace；done 才补 encrypted_function_args: []）
  //   · response.completed 的 response.output[] 走 restoreResponseJson；缺失 output 时补 output_text
  //   · 事件 id / output_index / call_id / sequence_number 保持上游值，不重排、不重编号
  //   · terminal = completed|failed|incomplete：终态后忽略后续帧；usage 只在此记账一次
  //   · 流在终态前结束 → fail('upstream stream ended without terminal event')，不自动重发

export function isTerminalEvent(type)   // 'response.completed' | 'response.failed' | 'response.incomplete'
```

### 4.3 `src/router.js`

```js
export function codexRoute(cfg, modelName)   // 精确名/别名命中且声明 codex → route 对象；否则 null
export function codexPilotEnabled(cfg)       // 任一模型声明 codex → true
```

`modelTarget()` 语义不变（`servingName/api/effortFormat/maxTokensMax`）。`codexRoute` 内部复用别名表，不复制解析规则：建议抽出内部 `lookupModel(cfg, name)` 供 `createRouter().resolve()` 与 `codexRoute()` 共用。

## 5. 线级规则（A 主导）

1. **声明**（发往 GPT 根路由）：三工具在 `codex.plaintextTools=true` 时以普通 function 声明，`message` 参数为普通 string，**删除** `parameters.properties.message.encrypted`（若存在）；`tool_choice` 同步映射到扁平名。
2. **完成项**（回给 Codex）：仅对**本轮确实以明文声明的**三工具、且参数可判定为明文时，恢复 `namespace:"<route.codex.namespace>"`、`name:<原工具名>`、`encrypted_function_args: []`，`call_id`/`arguments` 原样。上游已给非空 `encrypted_function_args`、未知来源、未知字段 → 显式失败（`opaque_function_args`），不覆盖成空数组。
3. **目的端投影**（发往 DeepSeek 路由）：`agent_message` 按下表投影；不得把 `reasoning.encrypted_content`、`compaction`、OpenAI 账号元数据当正文。
4. **历史**：DeepSeek 无状态，每轮必须回传完整有效历史（同源 reasoning、工具调用与结果次序保留）；工具名跨请求可确定性还原。
5. **拒绝优先于猜测**：任何无法证明明文的载荷、无法配对的 `call_id`、无法保真的工具策略，返回 400 且**不出网**。

### 5.1 marker 矩阵（离线 fixture 必测）

| marker | 含义 | 期望 |
| --- | --- | --- |
| 缺失 `encrypted_function_args` | 普通函数调用 | 原样；不补 namespace、不补 marker |
| `null` | 未声明语义 | 原样；不补 |
| `[]` 且工具在本轮明文声明 | 合法明文完成项 | 恢复 namespace/name（补 `[]` 幂等） |
| `[]` 但工具未声明/不是三工具 | 伪造 marker | 不补；工具身份不变 |
| `["<非空>"]` | 上游密文 | 显式失败 `opaque_function_args` |
| 非 `collaboration` namespace | 其它命名空间 | 不参与明文判定 |
| `agent_message` 含非空 `encrypted_content` | 密文/未知来源 | `opaque_agent_message` 400 |


### 5.1 实测抓线（Codex CLI 0.167.0，本机隔离 mock，不含凭据）

**root 请求**顶层键：`client_metadata, include, input, model, parallel_tool_calls, prompt_cache_key, reasoning:{summary:"auto"}, store:false, stream:true, tool_choice, tools`；`include:["reasoning.encrypted_content"]`。

**tools**：`function×n`（exec_command / write_stdin / request_user_input / view_image / get_goal / create_goal / update_goal）+ `type:"namespace", name:"collaboration"`（内含 followup_task / interrupt_agent / list_agents / send_message / spawn_agent / wait_agent 六个 function）+ `type:"web_search"`。三个 message 工具的 `message` 参数为 `{"type":"string","description":"…","encrypted":true}`；其余三个无 message 参数。`spawn_agent` 参数：`task_name / model / reasoning_effort / fork_turns / message`（`fork_turns` 仅 `all|none`）。

**明文委派项**（子线程首回合 `input[]`，无 `encrypted_content` 字段）：

```json
{"type":"agent_message","id":"amsg_…","author":"/root","recipient":"/root/worker",
 "content":[{"type":"input_text","text":"Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n<任务正文>"}]}
```

**历史回放的工具项**（Codex 第二轮）：`{"type":"function_call","status":"completed","id":"fc_…","name":"spawn_agent","namespace":"collaboration","arguments":"…","call_id":"call_…"}` —— `namespace` 保留，但 `encrypted_function_args` 被自定义 provider 出站清理**删除**。因此"缺失 marker"不能当明文证据；`function_call_output` 形状为 `{type,call_id,id,output}`。

**Codex 接受的工具 SSE 序列**（实测可触发真实 spawn）：`response.created` → `response.output_item.added`（function_call，带 `namespace`/`call_id`/`arguments:""`）→ `response.function_call_arguments.delta` → `.done` → `response.output_item.done`（completed + `encrypted_function_args:[]`）→ `response.completed`（`response.output[]` 含同一 item 与 usage）。`added`/`done`/`completed` 三处的 `id`/`call_id`/`output_index` 必须一致。

**已证实的跨供应商机制**：`spawn_agent.model` 显式覆盖即让子线程用另一模型，且子线程请求仍打到**同一个 provider base_url**（单 ModelGate provider 路线成立）；子模型目录自身声明 `multi_agent_version:"v2"` 后子线程仍获得 namespace collaboration 工具。root 第二回合与子线程首回合可能乱序到达，编排必须按 `model`+`input` 判态。


### 5.3 真实生命周期抓线修正（codex-lifecycle 用原版 0.167.0 实测）

- `spawn_agent` 参数为 `{task_name, message, model?, reasoning_effort?, fork_turns:"none"|"all"}`，**没有 `agent_type`**；子模型由 `model` 显式覆盖或角色锁定。
- namespace `collaboration` 下共 6 个工具：`spawn_agent / send_message / followup_task / wait_agent / list_agents / interrupt_agent`；只有前三者带 `message` 参数与 `encrypted` 标记。**明文/恢复只作用于这三者**，其余三个原样透传。
- **普通工具完成项绝不能带 `namespace`**：Codex 会把 `namespace+name` 拼成 `collaborationexec_command` 并报 `unsupported call`。
- **namespace `collaboration` 下 6 个工具的完成项都必须恢复 `namespace`**（实测：扁平 `wait_agent` 会被 Codex 报 `unsupported call: wait_agent`）；其中只有三消息工具补 `encrypted_function_args: []`，其余三个不得带该字段。
- mock 最小可执行 SSE：`response.created → output_item.added(item) → output_item.done(item) → response.completed(output=[item],usage)`；`function_call_arguments.delta` 非必需。
- 完成通知回 root 也是原生 `agent_message`（`author:"/root/worker", recipient:"/root"`，正文 `Message Type: FINAL_ANSWER … Payload: …`），`wait_agent` 可被它唤醒（`{"message":"Wait completed.","timed_out":false}`）。
- 子线程请求头带 `x-codex-parent-thread-id`、`x-openai-subagent: collab_spawn`；body `client_metadata.thread_id/parent_thread_id`、`x-codex-turn-metadata.{agent_name,subagent_kind,depth}`。可用于收据关联，**不得**用于授权或路由判定。
- 冷恢复：`codex exec resume <rootSid>` 不接受 `-s/-C/--ephemeral`（sandbox/cwd 来自 config.toml 与原 session），返回同一 root SID，历史含上一轮 `function_call`+`function_call_output` 与 `agent_message`；`followup_task` 可按需恢复目标并触发新 turn。
- 子线程继承父 `base_instructions`（provenance 显示父模型），不能据此判断实际路由；路由只看请求 `model` 与上游收据。
- root 第二回合与 child 首回合可能乱序到达，编排必须按 `model`+`input` 判态。

## 6. 模型目录（Codex `models[]`）

首版不新增远程目录端点：用隔离的 `model_catalog_json` 文件。**本机 0.167.0 实测可解析的最小形状**（`codex exec -c model_catalog_json=<path>`）：

```json
{ "models": [ {
  "slug": "codex-gpt", "display_name": "Codex GPT (ModelGate)",
  "supported_reasoning_levels": [{ "effort": "low", "description": "Low" },
                                 { "effort": "medium", "description": "Medium" },
                                 { "effort": "high", "description": "High" }],
  "shell_type": "default", "visibility": "list", "supported_in_api": true,
  "priority": 10, "support_verbosity": false,
  "truncation_policy": { "mode": "tokens", "limit": 10000 },
  "experimental_supported_tools": [],
  "base_instructions": "…",
  "context_window": 200000, "max_output_tokens": 32000,
  "supports_parallel_tool_calls": true,
  "multi_agent_version": "v2",
  "use_responses_lite": false, "prefer_websockets": false
} ] }
```

必填字段（实测 serde 逐个报错得出）：`slug`、`display_name`、`supported_reasoning_levels`、`shell_type`（枚举默认 `default`）、`visibility`（`list`）、`supported_in_api`、`priority`、`support_verbosity`、`truncation_policy{mode,limit}`、`experimental_supported_tools`，且必须给 `base_instructions` 或 `model_messages.instructions_template`；外层必须是 `{"models":[…]}` 且非空。递归门槛：**子线程模型自身**也要声明 `multi_agent_version:"v2"`，仅开全局 Feature 不够。

### 6.1 本机 0.167.0 实测通过的完整目录（供 lifecycle 复制）

`codex exec -c model_catalog_json=<path>` 已解析通过（两个模型都声明 `multi_agent_version:"v2"`，root 与 child 各一），CLI 启动时列出 `model: codex-deepseek / provider: mg`：

```json
{
  "models": [
    {
      "slug": "codex-gpt",
      "display_name": "Codex GPT (ModelGate)",
      "supported_reasoning_levels": [
        {
          "effort": "low",
          "description": "Low"
        },
        {
          "effort": "medium",
          "description": "Medium"
        },
        {
          "effort": "high",
          "description": "High"
        },
        {
          "effort": "xhigh",
          "description": "Extra high"
        }
      ],
      "shell_type": "default",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 10,
      "support_verbosity": false,
      "truncation_policy": {
        "mode": "tokens",
        "limit": 10000
      },
      "experimental_supported_tools": [],
      "base_instructions": "You are the root agent. Use only the tools declared in this request.",
      "context_window": 200000,
      "max_output_tokens": 32000,
      "supports_parallel_tool_calls": true,
      "multi_agent_version": "v2",
      "use_responses_lite": false,
      "prefer_websockets": false
    },
    {
      "slug": "codex-deepseek",
      "display_name": "Codex DeepSeek worker (ModelGate)",
      "supported_reasoning_levels": [
        {
          "effort": "low",
          "description": "Low"
        },
        {
          "effort": "medium",
          "description": "Medium"
        },
        {
          "effort": "high",
          "description": "High"
        }
      ],
      "shell_type": "default",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 20,
      "support_verbosity": false,
      "truncation_policy": {
        "mode": "tokens",
        "limit": 10000
      },
      "experimental_supported_tools": [],
      "base_instructions": "You are a worker agent. Use only the tools declared in this request.",
      "context_window": 128000,
      "max_output_tokens": 16000,
      "supports_parallel_tool_calls": true,
      "multi_agent_version": "v2",
      "use_responses_lite": false,
      "prefer_websockets": false
    }
  ]
}
```

字段语义（实测）：`supported_reasoning_levels[].effort` 决定可选档位；`visibility:"list"` 才在目录可见；`supported_in_api:true` 才可被 API 选择；`priority` 影响默认排序；`truncation_policy:{mode:'tokens',limit:N}`；`shell_type` 枚举 `default|local|shell_command|unified_exec|disabled`；`multi_agent_version:"v2"` 是递归门槛。`base_instructions` 与 `model_messages.instructions_template` 至少给一个。


## 7. 路由、端点与鉴权

- 端点：`models.<名>.responsesPath`（默认 `/v1/responses`）+ provider `baseUrl`；试点路由**只打一个 provider**。
- 认证：`Authorization: Bearer <provider 服务端 key>`，来自 `keys.local.json`/环境变量；客户端 `Authorization` 只用于网关自身鉴权（已消费）。
- 上游选择：`codexRoute` 命中即固定 provider + `providerModels` 服务名；不因 429/5xx 换上游（保留错误归因）。
- `strictModelRouting`：见 §3.5；`unknown_model` 400 且零上游请求。

## 8. 流式与故障治理

- 首版 HTTP SSE + 完整有序历史；`response.output_item.done` 是执行关键点。
- 背压：`res.write()===false` 时暂停读上游直至 `drain`（30s 超时 / 8MiB 未写出上限，沿用 MG-002 语义）。
- 取消：客户端断开或预算耗尽 → 销毁上游，不续传、不计上游失败（client_closed）。
- 终态缺失：以 `response.failed {code:'STREAM_INTERRUPTED'}` 收尾；已送出可执行事件后**不自动重发**推理或工具调用。
- usage：一个响应只记一次账；`response.completed.response.usage` 缺失时记 0，不臆造。
- 终态记账：`response.failed` → 计上游错误并 markFail；`response.incomplete` → markOk（上游确实返回终态，只是内容未完成）并留 warn 日志；两类终态的 `response.output[]` 都做工具身份恢复（`completed` 与 `incomplete`），status/incomplete_details 原样保留。
- 非流式 JSON 与 SSE 必须共享同一套工具身份恢复（同一 `restoreToolItem`）。

## 9. 生命周期验收边界（离线）

阈值：root（GPT 别名，mock-OpenAI）→ child（DeepSeek 别名，mock-DeepSeek）→ grandchild（DeepSeek→GPT 与 DeepSeek→DeepSeek 各一次）。必须是**原版 Codex 创建线程**：mock 只编排模型输出，不得伪造任务/线程/通知。

必过项：root/child/grandchild 的 SID 与 parent/path；两路上游各自的请求收据（路径、鉴权头、模型名、工具声明形状）；`spawn_agent`/`send_message`/`followup_task`/`wait_agent`；完成通知；并发上限原生拒绝；审批拒绝/批准；取消；冷恢复（同 root SID + 既有 child ID 复用 + 历史重放）。`fork_turns:none` 先做，`all` 单列。

## 10. 验收与证据

### 10.1 本轮已执行（基线）

```
npm run check            -> 0
npm test                 -> Isolated suites: 25/25 passed
node --test scripts/test/offline/responses-{mapping,endpoint,native}.test.mjs -> tests 27 / pass 27
```

### 10.2 供应商证据边界

真实双上游、真实 Codex/Desktop GUI、ChatGPT 工作区认证、计费：**待用户授权**（认证模式、模型、额度、数据范围、隔离 Desktop 环境）。未授权前只做 mock + 离线 + 原生 app-server 组件验收，不得标为完整通过。禁止把 mock / HTTP 200 / UI 选择器截图当真实验收。

### 10.3 缺陷复现（合成）

`/tmp/mg-baseline-repro.mjs` 输出：明文 `agent_message` → `{"code":"unsupported_parameter","message":"不支持的 input item 类型: agent_message"}`；无 agent_message 时 `lossy=["tool_dropped:namespace"]`；带 `namespace`+`encrypted_function_args:[]` 的 `function_call` 在 Chat 桥丢失二者。

## 11. 回退

按 alias 关闭试点（删除 `codex` 块或把 `api` 改回原值）即回到既有入口；`strictModelRouting` 关闭即恢复未知名回落。保留原 Codex rollout，不迁移、不改写旧密文；需要跨路由时由用户同意后开新线程重发必要明文。隔离实例失败时停止该实例并确认原入口 `/healthz` 可用，不对生产做隐式回滚。

## 12. 剩余工作与责任

| 项 | 责任 | 写集 |
| --- | --- | --- |
| 路由/原生校验分离/端点鉴权/严格路由/目录接线 | gateway-routing 队友 | `src/index.js`、`src/router.js`、`config/gateway.json`、`docs/reference/configuration.md` |
| 纯映射与三工具/marker/历史投影 | responses-mapping 队友 | `src/codex-responses.js`、`scripts/test/offline/codex-responses.test.mjs` |
| SSE 解析/事件规范化/终态/背压 | responses-streaming 队友 | `src/codex-responses-stream.js`、`scripts/test/offline/codex-responses-stream.test.mjs` |
| CLI 与 bundled app-server 生命周期套件 | codex-lifecycle 队友 | `scripts/test/offline/codex-v2-lifecycle.test.mjs`、`scripts/test/offline/codex-v2-fixtures/` |
| 验收清单/执行收据 | client-acceptance 队友 | `docs/roadmap/2026-11-12-codex-v2-acceptance.md`、`docs/roadmap/receipts/` |
| 契约、开发计划、CHANGELOG、集成门禁、回归 | Lead | 本文件、`docs/development-plan.md`、`CHANGELOG.md`、`scripts/test/run.mjs`、`docs/how-to/testing.md` |
