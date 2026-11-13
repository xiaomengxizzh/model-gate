# ModelGate 本地 MCP 委派契约 v1（G2 / OpenCode Go worker）

状态：**契约草案，未冻结**（2026-11-13）。本文件是 G3 实现的唯一输入；实现与本文不一致时，
先改本文再改代码，不得让代码反向定义契约。本卡只交付契约与 fixture，**不含运行时代码**。

> **诚实性边界（必须先读）**
>
> 本条路径是**工具驱动的外部 worker 委派**：Codex 的 GPT 父模型通过本地 stdio MCP 工具把任务
> 交给 ModelGate，ModelGate 用**自己的 OpenCode Go 凭据**调用 `deepseek-v4.1-flash`。
> 它**不是** Codex 原生 `spawn_agent` 的跨 provider 子线程，也不会变成那样的子线程：
> 没有原生 child thread、没有父子会话继承、没有原生协作工具语义（`followup_task`/`wait_agent`）。
> 任何把它写成"原生子代理"的回执都是错误结论，见 §0.3。
>
> 本契约同时排除：读取/复制/转发 Codex `auth.json` 或 `CODEX_HOME`、代理
> `chatgpt.com/backend-api/codex/responses`、把 ChatGPT 套餐包装成通用 API、实现 HTTP/SSE 传输入口。

配套文档：

| 文档 | 作用 |
| --- | --- |
| [fixtures/mcp/v1/README.md](fixtures/mcp/v1/README.md) | 样例索引 + 文档↔fixture 逐字段人工核对表 |
| [MCP 委派威胁模型](../explanation/mcp-delegation-threat-model.md) | 信任边界、fail-closed 依据、诚实表述 |
| [UHR MCP 契约 v1](uhr-mcp-v1.md) | 上一代只读意图契约（**不要把它的只读/引用形状直接套成本契约**） |
| [请求生命周期契约](request-lifecycle-v1.md) | 预算/取消/SSE 终态语义（本契约的上游侧复用前提） |
| [方案 §3.3/§3.4](../roadmap/2026-11-13-modelgate-native-delegation-resolution.md) | 本轮唯一技术路线来源 |

## 0.0 与并行实现的取值对齐（2026-11-13）

以下取值由 G3 实现方在写码时确定，本文随之固定；它们是契约常量，不是实现细节：

| 项 | 取值 | 说明 |
| --- | --- | --- |
| `taskRef` | `mgtask-<16 hex>` | 形状 `^mgtask-[0-9a-f]{16}$` |
| 工具名 | 5 个 `modelgate_*` | 见 §3，不改名 |
| 状态枚举 | 9 个 | 见 §5，不增不减 |
| `wait` 默认/上限 | 15000ms / 60000ms | §3.4 |
| 任务正文上限 | 65536 UTF-8 字节 | §3.7 |
| 结果文本上限 | 65536 UTF-8 字节 | §4.2 / §3.7 |
| `turnRef` / `ownerRef` | `mgturn-<16 hex>` / `mgowner-<16 hex>` | 本文定义；实现若已另定需在合入前回报并对齐 |

## 0. 范围

### 0.1 在范围内

- JSON-RPC 2.0 over stdio（newline-delimited）的本地 MCP 服务：`initialize` /
  `notifications/initialized` / `tools/list` / `tools/call` / `ping`。
- 5 个工具的参数 schema、结果形状、任务状态机、幂等、归属、错误码、provider/model allowlist。
- 一次任务从 ADMITTED 到 ACKNOWLEDGED 的持久化与恢复语义。
- 代码任务特有的**工作区引用、工具权限、结果产物哈希**（UHR 只读契约不覆盖这些）。

### 0.2 非目标（明确不做）

| 非目标 | 原因 |
| --- | --- |
| HTTP / SSE / WebSocket 传输 | 只服务本机由 Codex 启动的子进程；不新增远程通用入口 |
| 读取 Codex 登录态 / 代理 ChatGPT 订阅端点 | 方案 §2 已判定为不可发布路径；本契约不提供任何相关字段 |
| 解密/改写/删除 V2 密文（`encrypted_content` 等） | 方案 P1-A：fail-closed，绝不猜测 |
| 原生 `spawn_agent` 跨 provider 子线程 | 客户端不支持；不伪造兼容 |
| 在工具参数里指定 provider / model / URL / host / 凭据 | 只有服务端配置 allowlist 能决定这些 |
| 多租户、远程鉴权、配额计费 | 本机单 OS 用户 stdio 场景；归属按 §7 判定 |

### 0.3 一句话差异表（防止误读）

| 维度 | Codex 原生 `spawn_agent` | 本契约 |
| --- | --- | --- |
| 子线程归属 | Codex 后端创建，父 turn 继承 provider | ModelGate 本地任务记录，provider 由服务端 allowlist 决定 |
| 任务正文 | V2 可能是后端密封的加密信封，网关读不到 | 普通 MCP 工具参数，明文、可审计、有字节上限 |
| 等待语义 | 内层 `wait_agent` + 顶层 Code Mode `wait({cell_id})` | `modelgate_wait_task` 有界等待 + 持久化 taskRef 对账 |
| 追派 | `followup_task` 到同一子 ID | `modelgate_followup_task` 到同一 taskRef 的下一个 turn |
| 结果回执 | 原生子代理消息 | MCP 工具结果 + 产物 sha256 |

## 1. 术语

| 名称 | 含义 |
| --- | --- |
| taskRef | 任务引用 `^mgtask-[0-9a-f]{16}$`；任务身份，跨重启稳定 |
| turnRef | 轮次引用 `^mgturn-[0-9a-f]{16}$`；一次派发对应一个 turn（初派与每次追派各一轮） |
| ownerRef | 归属引用 `^mgowner-[0-9a-f]{16}$`；由配置目录绝对路径 + OS 用户名派生（§7），跨重启稳定 |
| state | 任务状态枚举，见 §5 |
| idempotencyKey | 调用方提供的幂等键；同一键 + 同一规范化摘要 ⇒ 同一 taskRef/turnRef |
| requestDigest | 规范化请求摘要（sha256，§6.2）；只参与幂等判定，不回给调用方 |
| resultDigest | 结果回执摘要（sha256，§4.4）；用于父端核对回执完整性 |
| workspace | 服务端配置登记的工作区别名 + 相对引用集合（§8.3） |
| 终态 | `RESULT_READY` / `ACKNOWLEDGED` / `FAILED` / `CANCELLED`；`UNKNOWN` **不是**终态 |
| 等待超时 | `modelgate_wait_task` 本次等待窗口结束；**不等于任务失败**（§5.4） |

## 2. 传输：JSON-RPC 2.0 over stdio（newline-delimited）

### 2.1 帧格式

- stdin/stdout 各是一个 JSON-RPC 2.0 消息流，**每条消息一行 UTF-8 JSON + `\n`**。
- 行内不得出现裸换行/裸回车；字符串内的换行必须 JSON 转义。不允许 LSP 式 `Content-Length` 头帧。
- stdout **只写 JSON-RPC 消息**；日志一律走 stderr（脱敏后），否则会破坏协议流。
- 单行上限 `maxLineBytes = 1 MiB`：超限返回通道 A 错误 `MCP_FRAME_TOO_LARGE`（`id:null`），
  flush 后**关闭连接**——此时分帧已不可信，不再尝试续读。
- 顶层 JSON 必须是对象（消息），**不接受数组批处理**：`MCP_BATCH_UNSUPPORTED`。
- 无法解析的行 ⇒ `MCP_PARSE_ERROR`（`-32700`，`id:null`），继续读下一行。

### 2.2 生命周期与版本

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"codex","version":"0.167.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"modelgate-delegation","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

| 规则 | 内容 |
| --- | --- |
| 支持版本 | 精确集合 `["2024-11-05","2025-06-18"]`；客户端版本命中则原样回显 |
| 未知版本 | 不回错误：以 `"2024-11-05"` 回显（协商降级），并在 stderr 记一条 warn |
| 缺 `protocolVersion` / 非字符串 | `MCP_PROTOCOL_VERSION_UNSUPPORTED`（`-32602`），连接保持 |
| capabilities | `{"tools":{"listChanged":false}}`；不声明 logging/prompts/resources |
| serverInfo | `name:"modelgate-delegation"`；`version` 由实现给出，形状 `^\d+\.\d+\.\d+$` |
| 初始化前调用 | `initialize`/`ping` 之外的请求 ⇒ `MCP_SERVER_NOT_INITIALIZED`（`-32002`） |
| 重复 initialize | `MCP_INVALID_REQUEST`（`-32600`），不重置已有状态 |
| `notifications/initialized` | 通知，永不回响应；未知通知一律静默丢弃且不回错误 |
| `ping` | 返回 `{}`；初始化前后都可用 |

不允许协商能力扩展：客户端 `capabilities` 里的采样/roots/elicitation 一律忽略，服务端不会发起请求。

### 2.3 两条错误通道（本契约的显式偏离）

| 通道 | 用于 | 形状 |
| --- | --- | --- |
| **A：JSON-RPC error** | 传输/分帧/解析/方法名/初始化/未知工具名 | `{"jsonrpc":"2.0","id":<id|null>,"error":{"code":-32xxx,"message":"<中性描述>","data":{"modelgateCode":"MCP_*"}}}` |
| **B：工具结果 isError** | **参数内容**、归属、状态机、上游结果 | `result:{content:[{type:"text",...}],structuredContent:{ok:false,code:"MCP_*",...},isError:true}` |

偏离说明：MCP 规范建议参数非法用 `-32602`；本服务把**参数内容错误**放进通道 B，理由是
单一用途本地服务需要让模型在同一次 `tools/call` 里读到可自纠的字段级错误，且拒绝矩阵只需一条通道。
实现与测试必须按本表分道，不得混用；混用即视为契约缺陷。

### 2.4 并发、顺序与关闭

- 响应可以**乱序**（JSON-RPC 允许）；调用方必须按 `id` 关联，不得依赖到达顺序。
- `modelgate_wait_task` 与 `modelgate_delegate_task` 必须**不阻塞**同连接上的
  `modelgate_get_task`/`modelgate_cancel_task`。
- 每连接在途 `tools/call` 上限 8，排队上限 32；超出立即返回通道 B `MCP_BUSY`（`retryable:true`）。
- stdin EOF 或 SIGTERM：停止接受新调用，等待在途调用 ≤5s，未完成任务记录保持 `RUNNING`/`UNKNOWN`
  **原样落盘**（不取消、不伪造终态），然后退出码 0。
- 服务端不设空闲超时（Codex 会长期保持连接）。

### 2.5 明确不支持

`sampling/createMessage`、`roots/list`、`resources/*`、`prompts/*`、`logging/setLevel`、
`completion/complete`、`notifications/tools/list_changed`。收到这些请求返回
`MCP_METHOD_NOT_FOUND`（`-32601`），**不静默成功**。

## 3. 工具

### 3.1 tools/list entry 形状

每个 entry：`{name, title, description, inputSchema, annotations}`，**不含 `outputSchema`**
（结果形状由 §4 单点规定，避免两处定义漂移；输出 schema 留待 v2）。

`annotations` 固定为：

| 工具 | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| --- | --- | --- | --- | --- |
| `modelgate_delegate_task` | false | false | true | false |
| `modelgate_get_task` | true | false | true | false |
| `modelgate_wait_task` | true | false | true | false |
| `modelgate_followup_task` | false | false | true | false |
| `modelgate_cancel_task` | false | true | true | false |

`inputSchema` 使用 JSON Schema 2020-12 子集：`type/required/properties/additionalProperties/enum/
pattern/minLength/maxLength/minimum/maximum/maxItems/items`。**所有工具**
`additionalProperties:false`（多一个顶层字段就拒绝，见 §8.2 的拒绝优先级）。

> 长度语义：`maxLength` 按 Unicode 码点计；服务端另有**字节**硬上限（§3.7），超字节上限返回
> `MCP_ARGUMENT_TOO_LARGE` 并带 `details.bytes`。schema 的 `maxLength` 只是前置粗筛。

### 3.2 `modelgate_delegate_task`

创建一个 Go worker 任务。`provider`/`model` 由服务端 allowlist 决定，**不接受参数**。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["task", "idempotencyKey", "workspace"],
  "properties": {
    "task": { "type": "string", "minLength": 1, "maxLength": 65536 },
    "idempotencyKey": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{8,128}$" },
    "workspace": {
      "type": "object",
      "additionalProperties": false,
      "required": ["root"],
      "properties": {
        "root": { "type": "string", "minLength": 1, "maxLength": 128 },
        "refs": {
          "type": "array", "maxItems": 16,
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["path", "mode"],
            "properties": {
              "path": { "type": "string", "minLength": 1, "maxLength": 512 },
              "mode": { "enum": ["read", "write"] }
            }
          }
        },
        "permissionMode": { "enum": ["read_only", "read_write"] },
        "toolPolicy": {
          "type": "array", "maxItems": 6,
          "items": { "enum": ["read_file", "list_dir", "search", "write_file", "exec"] }
        }
      }
    },
    "reasoningEffort": { "enum": ["low", "high", "max"] },
    "budget": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "maxElapsedMs": { "type": "integer", "minimum": 1000, "maximum": 1800000 },
        "maxToolCalls": { "type": "integer", "minimum": 1, "maximum": 200 }
      }
    },
    "parentThreadId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,128}$" }
  }
}
```

字段语义：

| 字段 | 必填 | 默认 | 语义与限制 |
| --- | --- | --- | --- |
| `task` | 是 | — | 完整任务正文（代码任务允许换行/多段）。1..65536 UTF-8 字节；含凭据形状 ⇒ 拒绝 |
| `idempotencyKey` | 是 | — | 8..128 字符，`[A-Za-z0-9_.:-]`；作用域 = ownerRef（§6.1） |
| `workspace.root` | 是 | — | **别名**（配置登记键），不是路径；传绝对/相对路径 ⇒ `MCP_WORKSPACE_DENIED` |
| `workspace.refs` | 否 | `[]` | ≤16 条；`path` 相对 alias 根，禁绝对路径/`..`/盘符/URL（§8.3） |
| `workspace.permissionMode` | 否 | `read_only` | `read_only` 时 `write_file`/`exec` 与 `mode:"write"` 引用一律拒绝 |
| `workspace.toolPolicy` | 否 | `["read_file","list_dir","search"]` | ⊆ 服务端工具 allowlist（§8.4） |
| `reasoningEffort` | 否 | `high` | 只接受 Go 已证实档位 `low/high/max`；其它值 ⇒ `MCP_INVALID_ARGUMENTS` |
| `budget.maxElapsedMs` | 否 | 300000 | 1000..1800000；worker 墙钟上限，超时归 `FAILED` + `MCP_UPSTREAM_TIMEOUT` |
| `budget.maxToolCalls` | 否 | 64 | 1..200；worker 工具调用次数上限，超限按失败收尾 |
| `parentThreadId` | 否 | null | **仅分组标签**，不参与鉴权（§7.2）；`[A-Za-z0-9_.:-]` ≤128 |

### 3.3 `modelgate_get_task`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["taskRef"],
  "properties": {
    "taskRef": { "type": "string", "pattern": "^mgtask-[0-9a-f]{16}$" },
    "includeResult": { "type": "boolean" },
    "maxResultBytes": { "type": "integer", "minimum": 1024, "maximum": 65536 }
  }
}
```

`includeResult` 默认 `true`（`false` 时 `resultText` 恒为 `null`、`truncated:false`、`resultDigest:null`）；
`maxResultBytes` 默认 16384。每次成功返回**终态**记录的调用都会推进 ACK（§5.3）。

### 3.4 `modelgate_wait_task`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["taskRef"],
  "properties": {
    "taskRef": { "type": "string", "pattern": "^mgtask-[0-9a-f]{16}$" },
    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 60000 },
    "includeResult": { "type": "boolean" },
    "maxResultBytes": { "type": "integer", "minimum": 1024, "maximum": 65536 }
  }
}
```

`timeoutMs` 默认 **15000**、硬上限 60000。返回 `waitedMs` 与 `timedOut`：

| 任务状态 | 行为 |
| --- | --- |
| `RESULT_READY`/`ACKNOWLEDGED`/`FAILED`/`CANCELLED` | 立即返回 `timedOut:false`，状态不变 |
| `ADMITTED`/`DISPATCHED`/`RUNNING` | 等到状态变化或窗口结束；窗口结束返回 `timedOut:true`，**状态原样回显** |
| `UNKNOWN` | 立即返回 `timedOut:false`，`reconcileRequired:true`（不在等待中重发） |

`timeoutMs:0` = 纯轮询（立即回显当前状态，永不阻塞）。等待超时**不写任何状态、不产生失败**；
调用方必须区分 `timedOut:true`（继续等/查）与 `state:"FAILED"`（任务真的失败）。
客户端自身可能有更短的请求超时，服务端不为此缩短窗口。

### 3.5 `modelgate_followup_task`

在**同一 taskRef** 上追派下一轮，复用同一 Go 会话；**不得隐式新建任务**。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["taskRef", "task", "idempotencyKey"],
  "properties": {
    "taskRef": { "type": "string", "pattern": "^mgtask-[0-9a-f]{16}$" },
    "task": { "type": "string", "minLength": 1, "maxLength": 65536 },
    "idempotencyKey": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{8,128}$" },
    "reasoningEffort": { "enum": ["low", "high", "max"] },
    "budget": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "maxElapsedMs": { "type": "integer", "minimum": 1000, "maximum": 1800000 },
        "maxToolCalls": { "type": "integer", "minimum": 1, "maximum": 200 }
      }
    }
  }
}
```

- 允许的任务状态：`RESULT_READY` / `ACKNOWLEDGED`。其余（含 `RUNNING`/`UNKNOWN`/`CANCELLED`/`FAILED`）
  ⇒ `MCP_TASK_STATE_INVALID`。
- `turnCount` 上限 32，超出 ⇒ `MCP_TASK_STATE_INVALID`（`details.reason="turn_limit"`）。
- 幂等命名空间独立于 delegate（§6.3）；同键同摘要返回同一 `turnRef` 且 `duplicate:true`，不重复派发。
- 工作区/工具权限**沿用创建时的记录**，追派不得提权（不允许在 followup 里改 permissionMode/toolPolicy）。

### 3.6 `modelgate_cancel_task`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["taskRef"],
  "properties": {
    "taskRef": { "type": "string", "pattern": "^mgtask-[0-9a-f]{16}$" },
    "reason": { "enum": ["user_request", "parent_abort", "timeout", "other"] }
  }
}
```

- 允许状态：`ADMITTED` / `DISPATCHED` / `RUNNING`；`CANCELLED` 重复取消返回 `duplicate:true`。
- 其它终态（`RESULT_READY`/`ACKNOWLEDGED`/`FAILED`）⇒ `MCP_TASK_STATE_INVALID`（`details.state` 回显）。
- `UNKNOWN` ⇒ `MCP_UNKNOWN_OUTCOME`（`retryable:false`）：发送结果未确认时不得假装取消成功；先对账。
- 结果里 `cancel.reachedUpstream`：`true` 已确认到达上游 / `false` 派发前取消 / `null` 已请求但未确认。
- `reason` 默认 `user_request`，只写日志与记录，不回传上游。

### 3.7 参数硬上限（服务端强制）

**校验顺序固定**：先校验整个 `params.arguments` 的 canonical JSON 字节数，再校验单字段。
因此"整体超限"与"单字段超限"不会给出互相矛盾的码（见 R18）。

| 项 | 上限/形状 | 超出时 |
| --- | --- | --- |
| 整个 `params.arguments` | ≤262144 字节（canonical JSON） | `MCP_ARGUMENT_TOO_LARGE`（`field:"arguments"`） |
| `task` 正文 | 1..65536 UTF-8 字节 | `MCP_ARGUMENT_TOO_LARGE`（`field:"task"`,`bytes`） |
| `workspace.refs` | ≤16 条，`path` ≤512 字节 | `MCP_ARGUMENT_TOO_LARGE`（`field`,`limit`） |
| `workspace.toolPolicy` | ≤6 项，枚举内且 ⊆ 允许集 | `MCP_TOOL_POLICY_DENIED` |
| `idempotencyKey` | `^[A-Za-z0-9_.:-]{8,128}$` | `MCP_IDEMPOTENCY_KEY_INVALID` |
| `parentThreadId` / `workspace.root` | ≤128 字符 | `MCP_INVALID_ARGUMENTS` |
| `cancel.reason` | 枚举，≤200 字符 | `MCP_INVALID_ARGUMENTS` |
| `wait.timeoutMs` | 0..60000（默认 15000） | `MCP_INVALID_ARGUMENTS`（`limit:60000`） |
| `maxResultBytes` | 1024..65536（默认 16384） | `MCP_INVALID_ARGUMENTS`（`limit`） |
| 结果文本（存储与返回） | ≤65536 UTF-8 字节 | 截断 + `RESULT_TRUNCATED` lossy |
| 在途 `tools/call` | 8 并发 + 32 排队 | `MCP_BUSY`（`retryable:true`） |

## 4. 结果形状

### 4.1 信封

```json
{
  "content": [{ "type": "text", "text": "<与 structuredContent 完全相同的 JSON 字符串>" }],
  "structuredContent": {
    "ok": true,
    "contract": "modelgate-mcp-delegation-v1",
    "version": 1,
    "tool": "modelgate_get_task",
    "task": { "...": "§4.2" },
    "duplicate": false
  },
  "isError": false
}
```

`content[0].text` 与 `structuredContent` 必须是**同一份**序列化（不允许只给其一）。
`waitedMs`/`timedOut` 只出现在 `modelgate_wait_task`；`duplicate` 只出现在
delegate/followup/cancel。样例见 [result-samples.json](fixtures/mcp/v1/result-samples.json)。

### 4.2 task 对象（唯一结果形状）

| 字段 | 类型 | 恒在 | 语义 |
| --- | --- | --- | --- |
| `taskRef` | string `^mgtask-[0-9a-f]{16}$` | 是 | 任务身份 |
| `state` | enum §5 | 是 | 当前状态 |
| `provider` | string | 是 | 服务端 allowlist 实际使用的 provider（本版恒 `"opencodego"`） |
| `model` | string | 是 | 服务端 allowlist 实际模型（默认 `"deepseek-v4.1-flash"`） |
| `turnRef` | string \| null | 是 | 当前轮引用；未派发时为 `null` |
| `turnCount` | integer ≥1 | 是 | 已登记的轮数（初派=1） |
| `parentThreadId` | string \| null | 是 | 调用方提供的分组标签（非鉴权，§7.2） |
| `createdAt` | integer | 是 | 任务登记时刻（epoch ms） |
| `updatedAt` | integer | 是 | 最后一次状态/结果变更时刻（epoch ms） |
| `dispatchedAt` | integer \| null | 是 | 首次写上游请求的时刻；`null`=尚未派发 |
| `elapsedMs` | integer \| null | 是 | worker 执行墙钟（DISPATCHED→终态）；等待时间不计入 |
| `resultText` | string \| null | 是 | 结果正文（已脱敏、已按 `maxResultBytes` 截断，≤65536 字节） |
| `resultBytes` | integer | 是 | 返回的 `resultText` 的 UTF-8 字节数（`null` 时为 0） |
| `truncated` | boolean | 是 | `resultText` 是否被截断 |
| `resultDigest` | string \| null | 是 | 结果回执摘要（64 位小写 hex，§4.4）；无结果为 `null` |
| `toolSummary` | array | 是 | `[{name,calls,failed}]`；`name` ≤64 字符，未知工具归 `"other"`；≤32 项 |
| `artifacts` | array | 是 | `[{path,sha256,bytes}]`；`path` 相对 workspace 根，`sha256` 64 位小写 hex，`bytes` ≥0；≤32 项 |
| `lossy` | array | 是 | `[{code,detail?}]`；`code` 见 §4.5；≤16 项 |
| `delegation` | object | 是 | `{native:false,degraded:true,kind:"external_worker_delegation",proof:"modelgate-mcp-delegation-v1"}` |
| `error` | object \| null | 是 | `{code,message,retryable}`；仅 `FAILED` 非空，`code` 来自 §9 |
| `cancel` | object \| null | 是 | `{requestedAt,reason,reachedUpstream}`；仅取消相关状态非空 |
| `acknowledged` | boolean | 是 | 是否已被调用方读取过终态（`state==="ACKNOWLEDGED"` ⇔ true） |
| `ackSeq` | integer ≥0 | 是 | 终态投递序号（每次投递 +1；0=未投递） |
| `reconcileRequired` | boolean | 是 | `state==="UNKNOWN"` 时为 true，提示必须对账（§5.3） |

只允许以上字段。**不返回**：Go Key/Authorization/会话头、上游 baseUrl、客户端原始 header、
V2 密文、请求原始 body、服务端绝对路径、`requestDigest`、其它 owner 的任务。

### 4.3 失败信封（通道 B）

```json
{
  "content": [{ "type": "text", "text": "{\"ok\":false,...}" }],
  "structuredContent": {
    "ok": false,
    "contract": "modelgate-mcp-delegation-v1",
    "version": 1,
    "tool": "modelgate_cancel_task",
    "code": "MCP_TASK_STATE_INVALID",
    "message": "任务已是终态，不可取消",
    "details": { "state": "RESULT_READY" },
    "retryable": false,
    "task": null
  },
  "isError": true
}
```

`details` 只允许键：`field`、`reason`、`limit`、`bytes`、`state`、`allowed`。
`message` 是中性描述，**不得**含路径、Key、上游原始错误体、堆栈。
`task` 在可定位任务时回显当前记录（便于调用方判断是否可重试），参数拒绝时为 `null`；
跨 owner 时**必须**为 `null`（§7.3）。

### 4.4 resultDigest 的计算规则

`resultDigest = sha256_hex( canonicalJson({ artifacts, model, provider, resultText, taskRef, turnRef }) )`

- `canonicalJson`：对象键按字典序、无空白、数组保序、`null` 显式、UTF-8；
  与 `src/mcp/uhr-adapter.js` 的 `canonicalJson` 同一算法（可直接复用）。
- 摘要覆盖**返回给调用方的那一份** `resultText`（脱敏+截断之后），因此父端可对回执做完整性核对。
- **`state` 不参与摘要**：ACK 会改变 `state`，若把它算进去，同一条结果的 digest 会在 ack 前后变化，
  父端就无法复核。fixture 里的 `get.result_ready` 与 `get.acknowledged` 必须是同一个 digest。
- 结果为空时 `resultDigest` 为 `null`（不制造"空结果也有摘要"的假象）。

### 4.5 lossy 码

| code | 含义 |
| --- | --- |
| `RESULT_TRUNCATED` | `resultText` 命中 `maxResultBytes` 上限被截断 |
| `RESULT_REDACTED` | 结果文本里命中凭据形状并被替换为 `[redacted]` |
| `TOOL_SUMMARY_UNAVAILABLE` | 上游未提供可用的工具执行信息 |
| `STREAM_INCOMPLETE` | 上游流无终态即结束（结果可能不完整，但仍须如实返回） |
| `ARTIFACT_HASH_MISMATCH` | worker 自报哈希与 ModelGate 复算不一致（以复算为准，不一致的产物被丢弃） |
| `REASONING_SUMMARY_DROPPED` | 上游推理摘要不可表达被丢弃 |
| `USAGE_UNAVAILABLE` | 上游未返回 usage（不影响结果有效性） |

### 4.6 产物哈希的权威性

`artifacts[].sha256` **恒由 ModelGate 在任务收尾时对 workspace 内文件复算**，
不采信 worker 自报值：

- 文件不存在/越出 workspace 根 ⇒ 不列入 `artifacts`，并加 `ARTIFACT_HASH_MISMATCH`（`detail` 用相对路径）；
- 复算值与 worker 自报不一致 ⇒ 以复算值为准 + `ARTIFACT_HASH_MISMATCH`；
- `bytes` 同样是复算的文件字节数。

## 5. 任务状态机

### 5.1 状态

```text
CREATED ──► ADMITTED ──► DISPATCHED ──► RUNNING ──┬─► RESULT_READY ──► ACKNOWLEDGED
   │            │             │             │      ├─► FAILED
   │            │             │             │      └─► CANCELLED
   │            └─────────────┴─────────────┴─► UNKNOWN ──(对账)──► RESULT_READY / FAILED / CANCELLED
   └─(拒绝)─► 无记录                      (RESULT_READY/ACKNOWLEDGED ──followup──► RUNNING)
```

- `CREATED` 是**内存内的校验阶段**，不落盘；任何拒绝都发生在 `CREATED`，返回通道 B 错误且
  **零提交**（不分配 taskRef、不占用 idempotencyKey、任务表不增）。
- `UNKNOWN` **不是终态**，也**不是失败**：它表示"发送结果无法确认"，只能通过对账离开。

### 5.2 转移表（触发者 + 持久化时机）

| # | 转移 | 触发者 | 触发条件 | 持久化时机 |
| --- | --- | --- | --- | --- |
| T1 | `CREATED→ADMITTED` | 服务端 | 参数/allowlist/工作区/预算全部通过且幂等租约登记成功 | **先写** task 记录 + 幂等索引（同一原子写）再返回 |
| T2 | `CREATED→无记录` | 服务端 | 任一项拒绝 | 不写任何东西（零提交） |
| T3 | `ADMITTED→DISPATCHED` | 服务端 | 组装上游请求完成，即将写入 socket | **先落盘** `dispatchedAt`，再写 socket |
| T4 | `DISPATCHED→RUNNING` | 服务端 | 上游明确接受（响应头/首个应答帧） | 可与终态合并写；但 UNKNOWN 判定**不得**依赖它 |
| T5 | `DISPATCHED→UNKNOWN` | 服务端 | 写 socket 失败、无应答、连接中断且拿不到终态 | 立即落盘（含失败原因枚举） |
| T6 | `RUNNING→RESULT_READY` | 服务端 | 收到上游终态且任务标识/结果核对通过 | 立即落盘结果、产物复算哈希、`resultDigest` |
| T7 | `RUNNING→FAILED` | 服务端 | 上游终态失败 / 不可重试错误 / 超过 `maxElapsedMs` 或 `maxToolCalls` | 立即落盘 `error` |
| T8 | `RUNNING→CANCELLED` | 服务端 | 取消已到达上游并被确认 | 立即落盘 `cancel.reachedUpstream=true` |
| T9 | `ADMITTED→CANCELLED` | 服务端 | 派发前取消 | 立即落盘 `reachedUpstream=false` |
| T10 | `RUNNING→UNKNOWN` | 服务端 | 流中断且无终态帧 | 立即落盘，禁止按失败处理 |
| T11 | `RESULT_READY→ACKNOWLEDGED` | 服务端（响应投递） | **首次**把终态记录放进成功的工具响应 | 同一次响应处理内落盘 `ackSeq` |
| T12 | `RESULT_READY/ACKNOWLEDGED→RUNNING` | 服务端 | followup 新 turn 登记成功 | **先落盘** turn 记录（含新 `turnRef`）再派发 |
| T13 | `UNKNOWN→RESULT_READY/FAILED/CANCELLED` | 服务端 | 对账（`get`/`wait`/启动恢复）找到上游终态 | 立即落盘，附对账来源 |

禁止的转移（实现必须显式拒绝，不是"忘记实现"）：

- `UNKNOWN→DISPATCHED` / `UNKNOWN→RUNNING`（等于重发，禁止）；
- 任何非 `RESULT_READY`/`ACKNOWLEDGED` 状态下的 followup；
- `FAILED`/`CANCELLED` 的任务复活（只能新建任务，不能用追派"抢救"）；
- `ACKNOWLEDGED` 之后的 ack 递减/清零。

### 5.3 ACK 与恢复对账

- ACK 的唯一触发是"服务端把终态记录放进成功的工具响应"，不需要客户端额外调用。
  没有 ack 工具：多一个工具就多一条可被模型绕过的路径。
- 父会话恢复（Codex 重启/MCP 进程重启）：先用 `modelgate_get_task`/`modelgate_wait_task` 按
  `taskRef` 查现状，再决定继续等、追派或结束；**禁止**因为进程重启而重新 `delegate` 同一任务。
  重新 delegate 只能靠 `idempotencyKey` 命中同一 taskRef（§6）。
- `UNKNOWN` 的任务在启动时与每次 `get`/`wait` 时尝试对账；对账成功按 T13 转移；
  对账失败保持 `UNKNOWN` 并返回 `MCP_UNKNOWN_OUTCOME`（`retryable:false`）。
- 对账**不得**触发新的上游派发。

### 5.4 "等待超时 ≠ 任务失败"（本契约的红线）

| 事件 | 任务状态 | 返回值 |
| --- | --- | --- |
| `wait` 窗口结束，任务仍在跑 | 不变（`RUNNING` 等） | `ok:true`, `timedOut:true`, 状态原样 |
| 上游流中断无终态 | `UNKNOWN` | `ok:true`, `reconcileRequired:true` |
| worker 超过 `maxElapsedMs` | `FAILED` + `MCP_UPSTREAM_TIMEOUT` | `ok:true`, `state:"FAILED"` |
| MCP 进程被杀 | 记录原样（`RUNNING`/`UNKNOWN`） | 重启后按 §5.3 对账 |

反例（实现若这样做即违约）：把 `timedOut:true` 写成 `isError:true`；把等待超时落成 `FAILED`；
在 `UNKNOWN` 上直接返回"已取消/已失败"。

## 6. 幂等

### 6.1 作用域

- 键的作用域 = `ownerRef`（本机本配置目录，§7.1），**不是**全局、也不是"每个工具调用"。
- `idempotencyKey` 只以 `sha256(ownerRef + ":" + key)` 的前 32 hex 落盘，**明文键不落盘**。
- 命名空间：`delegate` 与 `followup` 各自独立（同一字符串可分别用于两者）。

### 6.2 规范化摘要

`requestDigest = sha256_hex(canonicalJson(normalizedRequest))`，其中 `normalizedRequest`：

1. 只取合同字段：delegate 取 `{task, workspace:{root,refs,permissionMode,toolPolicy}, reasoningEffort,
   budget:{maxElapsedMs,maxToolCalls}, parentThreadId}`（缺省字段按 §3.2 默认值补齐后参与）；
   followup 取 `{taskRef, task, reasoningEffort, budget}`（缺省同样补齐）；
2. **排除**瞬态字段：`idempotencyKey`、`includeResult`、`maxResultBytes`、`timeoutMs`、JSON-RPC `id`；
3. 数组按提交顺序保序；对象键按字典序；无空白；UTF-8。

### 6.3 判定

| 条件 | 结果 |
| --- | --- |
| 同 key + 同 digest | 返回**同一** `taskRef`（followup：同一 `turnRef`），`duplicate:true`，**不重复派发** |
| 同 key + 不同 digest | `MCP_IDEMPOTENCY_CONFLICT`（`details.reason:"digest_mismatch"`），不覆盖、不新建 |
| key 已登记但任务已 `FAILED`/`CANCELLED` | 仍返回同一 taskRef + `duplicate:true`，状态原样（不复活） |
| key 形状非法 | `MCP_IDEMPOTENCY_KEY_INVALID`（零提交） |
| 无 key | `MCP_INVALID_ARGUMENTS`（`field:"idempotencyKey"`,`reason:"required"`），零提交 |

"不重复派发"的判据是上游请求计数：同 key 重放后，上游 mock 观测到的请求数不得增加（G3 验收项）。

### 6.4 取消幂等

重复取消 `CANCELLED` 任务 ⇒ `duplicate:true`、状态不变、不产生第二次上游取消请求。

## 7. 归属与身份

### 7.1 ownerRef

`ownerRef = "mgowner-" + sha256("owner:" + <规范化配置目录绝对路径> + ":" + <OS 用户名>).slice(0,16)`

- 跨重启稳定（否则恢复后的任务会变成"不是我的"）；
- 只落 16 hex，原始路径与用户名不落盘、不出现在工具结果里；
- stdio 单用户场景下这是**充分但不充分于多用户**的归属手段：它防的是"同一台机器上另一个配置目录/另一个
  MCP 实例"偷读任务，**不防**同 OS 用户下的恶意进程（那份进程本来就能读任务文件，见威胁模型 §3）。

### 7.2 parentThreadId 只是标签

`parentThreadId` 由调用方（模型参数）提供，**不可信**：它不参与鉴权，只用于在同一 owner 内分组/排序。
任何"用 parentThreadId 授权跨 owner 读取"的实现都是漏洞。

### 7.3 归属判定表

| 场景 | 返回 |
| --- | --- |
| taskRef 不属于本 owner | `MCP_NOT_OWNER`（`details.reason:"owner_mismatch"`），`task:null` |
| taskRef 不存在 | `MCP_TASK_NOT_FOUND` |
| followup 的 parentThreadId 与原记录不一致 | `MCP_FOLLOWUP_CONFLICT`（`reason:"parent_mismatch"`） |
| followup 的 workspace/权限与记录不一致 | `MCP_FOLLOWUP_CONFLICT`（`reason:"scope_mismatch"`） |
| 通过猜测/枚举访问他人任务 | 同 `MCP_NOT_OWNER` |

唯一的鉴权输入是 ownerRef（服务端派生）；模型能控制的只有 tool arguments，永远不能控制 ownerRef。
交叉读取失败时不得回显该任务任何字段（不泄露状态/模型/时间）。

## 8. allowlist 与凭据隔离

### 8.1 provider / model allowlist

服务端配置是唯一来源（示例字段名，最终配置名以 [配置参考](../reference/configuration.md) 为准）：

```json
{
  "delegation": {
    "enabled": false,
    "transport": "stdio",
    "provider": "opencodego",
    "model": "deepseek-v4.1-flash",
    "reasoningEffort": "high",
    "workspaceRoots": { "mg-self": "/absolute/path/to/repo" },
    "toolPolicy": { "allowed": ["read_file", "list_dir", "search", "write_file", "exec"] },
    "budgets": { "maxElapsedMs": 1800000, "maxToolCalls": 200 },
    "store": { "maxTasks": 500, "retentionMs": 604800000 }
  }
}
```

- 默认 `provider:"opencodego"`、`model:"deepseek-v4.1-flash"`；`gpt-6-luna` 等父模型 slug
  **不在** allowlist 内，出现即 `MCP_MODEL_NOT_ALLOWED`。
- 扩展 provider/model 只能改配置并重启；工具参数中出现相关键一律拒绝（§8.2）。
- 每任务实际使用的 `provider`/`model` 必须在结果中回显（§4.2），便于父端核对未被替换。

### 8.2 禁止参数（拒绝优先级，自上而下命中即返回）

| 优先级 | 检测 | 码 |
| --- | --- | --- |
| 1 | 任意层级键名命中 V2 密文键：`encrypted_content`/`encrypted_task_id`/`encrypted_payload`/`opaque_v2` | `MCP_V2_OPAQUE` |
| 2 | 任意层级键名命中凭据键：`apiKey`/`api_key`/`authorization`/`token`/`cookie`/`headers`/`secret`/`password` | `MCP_CREDENTIAL_IN_ARGUMENT` |
| 3 | 任意层级键名命中目标键：`url`/`uri`/`host`/`baseUrl`/`endpoint`/`pathPrefix`/`proxy` | `MCP_URL_NOT_ALLOWED` |
| 4 | 任意层级键名命中 `provider`/`providerId` | `MCP_PROVIDER_NOT_ALLOWED` |
| 5 | 任意层级键名命中 `model`/`modelId`/`upstreamModel` | `MCP_MODEL_NOT_ALLOWED` |
| 6 | 字符串值命中凭据形状（`sk-…`、`Bearer …`、`api_key=`、`password=`） | `MCP_SECRET_IN_ARGUMENT`（`details.field`） |
| 7 | 形状/枚举/上限不符 | 各自 §9 码 |

- 检测深度上限 500 个节点；只看**键名**与**字符串值**，不做语义猜测（值级只看凭据形状）。
- 键名匹配大小写不敏感；命中任意一层即整条调用拒绝，**零提交**。
- 不允许"忽略未知字段再继续"：`additionalProperties:false` 是硬约束（R19）。

### 8.3 workspace 引用规则

- `workspace.root` 必须是配置 `delegation.workspaceRoots` 的**键**（别名）；
  传路径（绝对/相对/`~`/盘符/URL）⇒ `MCP_WORKSPACE_DENIED`（`reason:"path_not_allowed"`）。
- `refs[].path` 相对别名根；拒绝：绝对路径、`..` 段、Windows 盘符、`~/`、`file://`、
  解析后逃出别名根（含 symlink 解析后的真实路径）、超 512 字节。
- `mode:"write"` 的引用必须在 `permissionMode:"read_write"` 下才允许；否则 `MCP_TOOL_POLICY_DENIED`。
- 引用只是**范围声明**，不携带内容：出现 `content`/`body`/`text`/`patch` 等内联正文键 ⇒ `MCP_INVALID_ARGUMENTS`。

### 8.4 工具权限

- `toolPolicy` ⊆ 配置 `delegation.toolPolicy.allowed`；
- 默认 `["read_file","list_dir","search"]`；`write_file`/`exec` 需 `permissionMode:"read_write"` **且**配置允许；
- 任一不满足 ⇒ `MCP_TOOL_POLICY_DENIED`（`details.allowed` 回显允许集合）。

### 8.5 凭据与日志

- Go Key 只在 ModelGate 进程内使用，**永不出现在**工具结果、任务记录、`resultText`、`lossy.detail`、日志；
- 日志只记：`taskRef`、`turnRef`、`state`、`provider`、`model`、`elapsedMs`、`resultBytes`、错误码；
  **不记** task 正文、结果正文、请求头、上游 body；
- 结果文本返回前做凭据形状脱敏（`[redacted]`）并加 `RESULT_REDACTED` lossy 标记；
- 不读取 `~/.codex/auth.json`、`CODEX_HOME`、`config.toml`，不向 `chatgpt.com` 发任何请求。

## 9. 稳定错误码表

所有码以 `MCP_` 前缀，**发出即稳定**：不得改名、不得复用、不得删除；新增只能追加。

### 9.1 通道 A（JSON-RPC error）

| code | JSON-RPC | 触发 |
| --- | --- | --- |
| `MCP_PARSE_ERROR` | -32700 | 行不是合法 JSON |
| `MCP_INVALID_REQUEST` | -32600 | 缺 `jsonrpc:"2.0"`/缺 `method`/`id` 非法/重复 `initialize` |
| `MCP_METHOD_NOT_FOUND` | -32601 | 未实现的方法（§2.5） |
| `MCP_UNKNOWN_TOOL` | -32602 | `tools/call` 的 `name` 不在 5 个工具内 |
| `MCP_PROTOCOL_VERSION_UNSUPPORTED` | -32602 | `initialize.params.protocolVersion` 缺失或非字符串 |
| `MCP_SERVER_NOT_INITIALIZED` | -32002 | 初始化前调用 `initialize`/`ping` 之外的方法 |
| `MCP_BATCH_UNSUPPORTED` | -32600 | 顶层是 JSON 数组 |
| `MCP_FRAME_TOO_LARGE` | -32600 | 单行 >1 MiB（随后关闭连接） |
| `MCP_INTERNAL` | -32603 | 未预期异常（不泄露细节） |

### 9.2 通道 B（工具结果 isError）

| code | retryable | 含义 | `details` 可用键 |
| --- | --- | --- | --- |
| `MCP_INVALID_ARGUMENTS` | false | 形状/枚举/必填/未知字段不符 | `field`,`reason`,`limit`,`allowed` |
| `MCP_ARGUMENT_TOO_LARGE` | false | 命中字节/条数上限 | `field`,`limit`,`bytes` |
| `MCP_IDEMPOTENCY_KEY_INVALID` | false | 键形状非法 | `field`,`reason` |
| `MCP_IDEMPOTENCY_CONFLICT` | false | 同键不同摘要 | `reason` |
| `MCP_URL_NOT_ALLOWED` | false | 参数试图指定目标 URL/host | `field` |
| `MCP_CREDENTIAL_IN_ARGUMENT` | false | 参数试图指定凭据 | `field` |
| `MCP_SECRET_IN_ARGUMENT` | false | 值里出现凭据形状 | `field` |
| `MCP_V2_OPAQUE` | false | 出现 V2 密文键 | `field` |
| `MCP_WORKSPACE_DENIED` | false | 别名/引用越界 | `field`,`reason` |
| `MCP_TOOL_POLICY_DENIED` | false | 工具/引用模式越权 | `field`,`allowed` |
| `MCP_BUDGET_INVALID` | false | 预算越界或非整数 | `field`,`limit` |
| `MCP_PROVIDER_NOT_ALLOWED` | false | 参数指定 provider | `field`,`allowed` |
| `MCP_MODEL_NOT_ALLOWED` | false | 参数指定 model | `field`,`allowed` |
| `MCP_TASK_NOT_FOUND` | false | taskRef 不存在 | `field` |
| `MCP_NOT_OWNER` | false | taskRef 属于其它 owner | `reason` |
| `MCP_TASK_STATE_INVALID` | false | 当前状态不允许该操作 | `state`,`reason` |
| `MCP_FOLLOWUP_CONFLICT` | false | 追派与记录不一致 | `reason` |
| `MCP_BUSY` | **true** | 并发/排队上限 | `limit` |
| `MCP_UPSTREAM_UNAVAILABLE` | **true** | 连接失败/5xx/入口不可用 | `reason` |
| `MCP_UPSTREAM_AUTH_FAILED` | false | Go 凭据被拒（401/403/402） | `reason` |
| `MCP_UPSTREAM_RATE_LIMITED` | **true** | Go 429 限流/额度 | `reason`,`limit` |
| `MCP_UPSTREAM_TIMEOUT` | **true** | 超过 `maxElapsedMs`/首字节 | `limit` |
| `MCP_UPSTREAM_PROTOCOL` | false | 上游形状不可解析（含无终态） | `reason` |
| `MCP_UNKNOWN_OUTCOME` | false | 发送结果未确认，必须对账 | `reason` |
| `MCP_RESULT_UNAVAILABLE` | false | 终态已到但结果不可读/被拒 | `reason` |
| `MCP_STORE_UNAVAILABLE` | **true** | 任务表不可读写/损坏（fail-closed，不自动重置） | `reason` |

实现必须把上游 `opencodego_*` 码（`src/providers/opencode-go.js`）**映射**到上表，
不得把上游内部码直接透给模型。

## 10. 持久化与崩溃恢复

- 位置：`<config>/delegation/tasks.json`（`MG_CONFIG_DIR` 隔离），目录与文件权限 `0600`。
- 写方式：临时文件 + `fsync` + `rename` + 目录 `fsync`（与仓库既有原子落盘一致）。
- 单写者：`<config>/delegation/tasks.lock`（`O_EXCL`）。第二个实例启动即 `MCP_STORE_UNAVAILABLE`
  （`reason:"lock_held"`），**不**并发派发。
- 损坏：拒绝启动相关工具调用（`MCP_STORE_UNAVAILABLE`），保留现场，**绝不自动重置**。
- **任务正文不落盘**：只存 `taskDigest` + `taskBytes`；正文只在派发窗口内驻留内存。
- 任务记录只存：`taskRef`/`turnRef`/`ownerRef`/state/`provider`/`model`/`parentThreadId`/
  幂等键哈希/摘要哈希/时间戳/`elapsedMs`/结果文本（≤64 KiB）/产物（path+sha256+bytes）/`lossy`/`error`/`cancel`。
- 保留：最多 500 个任务、7 天；启动与每小时 GC 一次，先按时间后按数量，**只删终态**。
- 崩溃语义：`dispatchedAt` 已落盘但无终态 ⇒ 重启后为 `UNKNOWN`（T13 对账），**禁止**自动重发。

## 11. Fixture 索引

| 文件 | 内容 |
| --- | --- |
| [tools-list.json](fixtures/mcp/v1/tools-list.json) | `tools/list` 响应：5 个 entry 的完整 schema 与 annotations |
| [transport.json](fixtures/mcp/v1/transport.json) | `initialize`/`initialized`/`ping`/分帧与批处理拒绝样例 |
| [valid-delegate.json](fixtures/mcp/v1/valid-delegate.json) | 合法 `modelgate_delegate_task` 调用 |
| [valid-get.json](fixtures/mcp/v1/valid-get.json) | 合法 `modelgate_get_task` 调用 |
| [valid-wait.json](fixtures/mcp/v1/valid-wait.json) | 合法 `modelgate_wait_task` 调用（含等待超时语义） |
| [valid-followup.json](fixtures/mcp/v1/valid-followup.json) | 合法 `modelgate_followup_task` 调用 |
| [valid-cancel.json](fixtures/mcp/v1/valid-cancel.json) | 合法 `modelgate_cancel_task` 调用 |
| [result-samples.json](fixtures/mcp/v1/result-samples.json) | 结果/失败信封样例（含真实计算的 `resultDigest`） |
| [rejections.json](fixtures/mcp/v1/rejections.json) | 29 条拒绝矩阵负例（含期望码与字段） |

字段与 fixture 的逐项人工核对表在 [fixtures/mcp/v1/README.md](fixtures/mcp/v1/README.md)。

## 12. 验收（G3 消费本契约时的最小集合）

| ID | 断言 |
| --- | --- |
| AC-1 | `tools/list` 与 fixture 逐字段一致（5 个 entry、annotations、`additionalProperties:false`） |
| AC-2 | 29 条负例全部按期望码拒绝，且上游 mock 命中数为 0、任务表条数不变 |
| AC-3 | 同 `idempotencyKey` 重放：上游请求数不增，`duplicate:true`，taskRef 相同 |
| AC-4 | 同键不同摘要：`MCP_IDEMPOTENCY_CONFLICT`，不新建任务 |
| AC-5 | `wait` 超时返回 `timedOut:true` 且状态不变；随后 `get` 仍可读到 `RUNNING` |
| AC-6 | 跨 owner 的 get/cancel/followup 全部 `MCP_NOT_OWNER`/`MCP_FOLLOWUP_CONFLICT`，`task:null`，不泄露字段 |
| AC-7 | 进程在 `DISPATCHED` 后被杀：重启为 `UNKNOWN`，对账不产生新上游请求 |
| AC-8 | `artifacts[].sha256` 与文件复算一致；篡改后出现 `ARTIFACT_HASH_MISMATCH` |
| AC-9 | 工具结果与日志不含 Go Key、请求头、绝对路径；`resultText` 中凭据被替换为 `[redacted]` |
| AC-10 | 通道分道正确：参数错误走 isError 结果，协议错误走 JSON-RPC error，无混用 |
| AC-11 | `get` 在 ACK 前后返回同一个 `resultDigest`（`state` 不进摘要） |

**未验证（本卡）**：无任何运行时代码，因此以上全部是 G3 的验收项，不是本卡结论。
真实 Go 上游、真实 Codex 客户端、真实 V2 密文样本均为 `NOT_RUN`（不消耗额度、不读用户凭据）。

## 13. v1 稳定性规则

- 字段名、枚举值、错误码、工具名**发出即稳定**；改名/删除/改语义必须升 `version:2` 并另立文档。
- 只允许**追加**：新增可选字段、新增枚举成员（枚举只追加，不重排、不复用旧值）、新增错误码。
- 消费方（G3 实现、Codex 侧、测试）必须**忽略未知字段**，不得因多一个字段而失败。
- 默认值属于契约：改默认值算行为变更，需在 CHANGELOG 记录并同步本文件。
- 本文与 fixture 冲突时以本文为准，且必须修复 fixture 后同一提交内交付。
