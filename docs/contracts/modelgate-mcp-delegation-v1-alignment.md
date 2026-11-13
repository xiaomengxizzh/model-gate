# 实现对齐记录｜modelgate-mcp-delegation-v1

状态：**规范delta**。本文件是 [契约 v1](modelgate-mcp-delegation-v1.md) 与已落地实现
（`src/mcp/delegation-*.js` + `bin/mg-mcp.mjs`）之间的**权威差异表**。
契约文档描述设计意图；发生冲突时以本文件的「已实现」列为准，并在下一版契约中回填。

契约自己已预留这条通道（§0.0：「实现若另定需在合入前回报并对齐」）。

## 1. 参数形状：扁平（已实现）vs 嵌套（契约草案）

| 契约草案 | 已实现 | 原因 |
| --- | --- | --- |
| `workspace: { root, refs, toolPolicy }` | `workspaceRefs: [{ path, kind }]` | 服务端只有一个显式工作区根（`MG_MCP_WORKSPACE`），不需要模型选根；少一层嵌套少一类模型错误 |
| `budget: { maxElapsedMs }` | `budgetMs` | 同上 |
| `reasoningEffort` | 顶层 `reasoningEffort`（low/high/max） | 与契约取值域一致 |
| `maxResultBytes` | **不开放** | 用户要求「子任务结果完整返回父模型」；实现只在显式 `allowResultTruncation=true` 时裁剪，默认完整回执 + `lossy` 标记 |

## 2. 标识符（已实现＝契约）

| 名称 | 已实现 | 说明 |
| --- | --- | --- |
| `taskRef` | `mgtask-<16 hex>` | 一次委派 = 一个 taskRef |
| `turnRef` | `mgturn-<16 hex>` | 初派 + 每次追派各一轮；对外字段 `turnRef`（历史别名 `turnId` 仍在内部记录里） |
| `ownerRef` | `mgowner-<16 hex>` | `sha256("owner:"+配置目录绝对路径+":"+OS 用户名)`；模型不可控制 |
| `resultDigest` | sha256(canonicalJson({artifacts, model, provider, resultText, taskRef, turnRef})) | **不含 state**，因此 ACK 前后一致 |

## 3. 状态机（已实现）

`CREATED → ADMITTED → DISPATCHED → RUNNING → RESULT_READY → ACKNOWLEDGED`，另有 `FAILED` / `CANCELLED` / `UNKNOWN`。

- `DISPATCHED` 在**发起网络写入前**落盘；进程重启时把 `DISPATCHED`/`RUNNING` 对账成 `UNKNOWN`（`reason=upstream_unconfirmed`），**禁止自动重发**。
- 并发槽位未拿到时保持 `ADMITTED`（尚未写网络）。
- `wait` 超时只返回 `waitTimedOut:true`，**不改状态**。
- 「首次把结果放进成功响应」时从 `RESULT_READY` 推进到 `ACKNOWLEDGED`（`get`/`wait` 且 `includeResult !== false`）。
- `UNKNOWN` 上禁止 `followup`/`cancel`，返回 `MCP_UNKNOWN_OUTCOME`（不假装成功）。

## 4. 错误码：已实现子集

已发出（与契约 §9 同名）：

`MCP_INVALID_ARGUMENTS`、`MCP_ARGUMENT_TOO_LARGE`、`MCP_IDEMPOTENCY_KEY_INVALID`、`MCP_IDEMPOTENCY_CONFLICT`、
`MCP_URL_NOT_ALLOWED`、`MCP_CREDENTIAL_IN_ARGUMENT`、`MCP_SECRET_IN_ARGUMENT`、`MCP_V2_OPAQUE`、
`MCP_WORKSPACE_DENIED`、`MCP_BUDGET_INVALID`、`MCP_PROVIDER_NOT_ALLOWED`、`MCP_MODEL_NOT_ALLOWED`、
`MCP_TASK_NOT_FOUND`、`MCP_NOT_OWNER`、`MCP_TASK_STATE_INVALID`、`MCP_BUSY`、
`MCP_UPSTREAM_UNAVAILABLE`、`MCP_UPSTREAM_TIMEOUT`、`MCP_UPSTREAM_PROTOCOL`、`MCP_UPSTREAM_ERROR`（上游失败聚合码，保留）、
`MCP_UNKNOWN_OUTCOME`、`MCP_STORE_UNAVAILABLE`、`MCP_TOOL_EXEC_FAILED`（本地工具执行失败，契约未列，新增追加）、
`MCP_UNKNOWN_TOOL`（通道 A，-32602）、`MCP_METHOD_NOT_FOUND`（通道 A，-32601）、`MCP_INTERNAL`（通道 A，-32603）。

未发出（实现暂未产生，保留给后续）：`MCP_PARSE_ERROR`、`MCP_INVALID_REQUEST`、`MCP_PROTOCOL_VERSION_UNSUPPORTED`、
`MCP_SERVER_NOT_INITIALIZED`、`MCP_BATCH_UNSUPPORTED`、`MCP_FRAME_TOO_LARGE`、`MCP_TOOL_POLICY_DENIED`、
`MCP_FOLLOWUP_CONFLICT`、`MCP_UPSTREAM_AUTH_FAILED`、`MCP_UPSTREAM_RATE_LIMITED`、`MCP_RESULT_UNAVAILABLE`。

> 上游 `opencodego_*` 内部码不外透：由 `src/providers/opencode-go.js#decodeError` 映射后再进入 `MCP_UPSTREAM_*`。

## 5. 持久化布局

| 项 | 契约草案 | 已实现 |
| --- | --- | --- |
| 位置 | `<config>/delegation/tasks.json`（单文件） | `<config>/mcp/tasks/<taskRef>.json`（一任务一文件）+ `<config>/mcp/idem.json` |
| 写方式 | tmp + fsync + rename + 目录 fsync | tmp + rename + `0600`（未做 fsync；单进程本地场景，崩溃后由 `reconcile` 兜底把在途回合标 UNKNOWN） |
| 幂等索引 | 明文键不落盘，存 `sha256(ownerRef:key)` 前 32 hex | **已实现** |

一任务一文件的原因：单任务记录可能较大（含结果摘要与产物表），单文件全量重写会在任务多时放大写放大，
且局部损坏的影响面更小（损坏文件被隔离为 `.corrupt-<ts>`，其余任务可读）。

## 6. 未实现 / 明确延后

| 契约条目 | 状态 | 说明 |
| --- | --- | --- |
| `workspace.root` 别名注册表 | **未实现** | 当前只有一个由启动参数决定的工作区根；模型不能选根，符合安全边界 |
| `workspace.toolPolicy` | **未实现** | 工具集合由 `MG_MCP_TOOLS` 启动参数决定（默认 read/list/write/stat，无 shell） |
| `maxResultBytes` 参数 | **未实现** | 默认完整回执；`allowResultTruncation` 显式才裁剪 |
| 在途 tools/call 8 并发 + 32 排队 | **部分实现** | 8 并发上限返回 `MCP_BUSY`；**没有排队**，超限立即拒绝 |
| 单行 1 MiB 上限 / 批处理拒绝 / 初始化前门禁 | **未实现** | `bin/mg-mcp.mjs` 目前逐行解析、不限制行长、不强制 initialize 先行；本地 stdio 由 Codex 单客户端驱动，风险面有限，登记为后续 |
| `MCP_FOLLOWUP_CONFLICT`（parentThreadId/scope 不一致） | **未实现** | 追派只校验 owner + 上轮终态；parentThreadId 只留不可逆短摘要 |
| 任务/回合数量上限（32 turns） | **未实现** | store 不限制 turn 数；本地单客户端场景登记为后续 |

## 7. 与既有能力的复用关系

| 能力 | 复用来源 |
| --- | --- |
| 头构造 / 身份域防火墙 / Go 会话头 | `src/forward.js#buildHeaders` + `src/providers/opencode-go.js#newHeaders` |
| HTTP 发送 / 超时 / noRetry | `src/request.js#forward`（`noRetry: true`：委派任务只允许一次写入） |
| 预算与取消 | `src/budget.js#createBudget` |
| SSE 解码 | `src/responses-stream.js#createCodexSSEParser` |
| 目标分类 / 入口校验 | `src/codex/identity.js`、`src/providers/opencode-go.js#validate` |
| 上游错误映射 | `src/providers/opencode-go.js#decodeError` |

未复用 `src/mcp/uhr-adapter.js`：UHR 是「只读意图 + 不透明引用」契约，Go 代码任务是可写执行，
形状与权限模型不同，直接套用会伪造能力。

## 8. 变更纪律

本文件中标注「未实现」的条目，若要实现必须在对应阶段补契约条目 + 负例 fixture + 回归用例，
不得只改代码不改契约。
