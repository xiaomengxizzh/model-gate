# G3/G4 证据｜本地 MCP 委派（OpenCode Go 外部 worker）

- 日期：2026-11-13
- 分支：`feat/modelgate-native-delegation-20261113`（基线 `dc7d15f` = release `c6d97da` + 方案文档）
- 证据分级：**PASS(mock)** 为本文件主体；**真实 Go / 真实 Codex 父模型 = 见 G6 文档**（未在本文件冒充）
- 新增大型安装/下载：无

## 1. 本轮真正落地了什么

```
Codex CLI（用户自己的官方登录，GPT 父模型直连官方服务）
  └─ 本地 stdio MCP 调用 modelgate_delegate_task
       └─ ModelGate（bin/mg-mcp.mjs）
            ├─ 持久化任务状态机（<config>/mcp/tasks/*.json + idem.json）
            ├─ OpenCode Go provider（独立凭据，src/providers/opencode-go.js）
            │    └─ /inference/go/v1/responses（SSE）
            └─ 本地受限工具 read_file/write_file/list_dir/stat_path
                 └─ 结果 + 产物 sha256 回执给父模型
```

**诚实性边界**：这是「工具驱动的外部 worker 委派」，**不是** Codex 原生 `spawn_agent` 跨供应商子线程。
返回结构里恒有 `delegation: {kind:"external_delegation", native:false, degraded:true}`。

## 2. 新增文件与职责

| 文件 | 职责 |
| --- | --- |
| `src/mcp/delegation-contract.js` | 工具 schema、拒绝优先级（V2/凭据/URL/provider/model/值级密钥）、错误码、上限、resultDigest、ownerRef/turnRef 派生 |
| `src/mcp/delegation-store.js` | 原子落盘存储、状态机转移校验、幂等索引（只存哈希）、重启对账 |
| `src/mcp/delegation-tools.js` | 受限工作区工具（路径逃逸/绝对路径/符号链接逃逸拒绝）、引用指纹与前后 diff |
| `src/mcp/delegation-executor.js` | Go Responses 发送 + SSE 解析 + 本地工具循环（复用 forward/buildHeaders/createBudget/SSE parser） |
| `src/mcp/delegation-server.js` | JSON-RPC 分派、5 个工具语义、并发槽位、取消中止、ACK |
| `bin/mg-mcp.mjs` | stdio 入口（stdout 只走 JSON-RPC，日志走 stderr；`--doctor` 自检） |
| `scripts/test/offline/mcp-delegation.test.mjs` | 11 个离线用例 |

## 3. 执行命令与结果（本机真实复跑，Node v24.22.2 / npm 11.19.1）

| 命令 | exit | 结果 |
| --- | --- | --- |
| `node --test scripts/test/offline/mcp-delegation.test.mjs` | 0 | 11 通过 / 0 失败（约 0.2s） |
| `npm test` | 0 | **79 套件通过 / 0 失败**；**806 通过 / 1 跳过 / 0 失败**；75.2s |
| `npm run check` | 0 | 全部 `node --check` + `check-ui` 16/16 |
| `node bin/mg-mcp.mjs --doctor` | 0 | provider=opencodego / model=deepseek-v4.1-flash / tools 4 项 / 启动对账 0 条 |

基线对比：G0 时为 77 套件 / 782 通过；本轮新增 2 个套件（`mcp-delegation`、`sse-lifecycle`）与 G1 的 +5 用例。

## 4. 覆盖的行为（每条都有断言）

1. **完整闭环**：delegate → 上游 SSE 返回 function_call → 本地真实写文件 → 第二轮把 `function_call_output` 回填 → 结果回执；断言磁盘内容与 `sha256` 一致。
2. **不重复派发**：整个闭环上游只被命中 2 次（工具轮 + 收敛轮）；5xx 时只命中 1 次（`noRetry`）。
3. **凭据/会话隔离**：Go 请求头只有 `authorization: Bearer <网关自有 Go key>` 与 `x-opencode-session: mgs-<32hex>`；**没有** `chatgpt-account-id`，`store:false`、`stream:true`。
4. **同 session 追派**：第二轮复用同一 `taskRef` 且 `x-opencode-session` 与第一轮完全一致；追派幂等回放不再发上游。
5. **幂等**：同 key 同摘要 → 回放同一 taskRef、零新请求；同 key 不同摘要 → `MCP_IDEMPOTENCY_CONFLICT`。
6. **wait 超时 ≠ 失败**：`timeoutMs=80` 返回 `waitTimedOut:true` 且状态仍为 `RUNNING`。
7. **取消**：`RUNNING` 时取消 → `CANCELLED`，`cancel.delivered=true`、`upstreamStopUnknown=true`；二次取消 `noop`。
8. **重启对账**：`DISPATCHED` 状态重建 store 后被标为 `UNKNOWN`，再次对账幂等，且禁止追派（不重发）。
9. **归属隔离**：不同 `ownerRef` 读取/取消他人 taskRef → `MCP_NOT_OWNER`。
10. **拒绝矩阵**：V2 密文键、凭据键、任意 URL、provider、model、未知字段、超长正文、坏幂等键、预算越界、绝对/父目录引用、引用内联正文。
11. **无工具模式不虚构**：`MG_MCP_TOOLS=none` 时结果 `toolCallCount=0` 且 `lossy[].kind="no_workspace_tools"`。

## 5. 未验证 / 阻断

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实 OpenCode Go 上游 | **G6 单独执行** | 本文件不声称真实；见 `2026-11-13-g6-codex-mcp-live.md` |
| 真实 Codex CLI 作为 MCP 客户端 | **G6 单独执行** | 需要 `gpt6luna` 父模型与用户授权 |
| Codex Desktop | **NOT_RUN** | G7 独立验收 |
| 上游真实工具的多样性（Go 侧是否支持 `tools`） | 未经真实上游证实 | mock 只证明协议形状与本地循环；真实 Go 若不接受 `tools` 会返回 `MCP_UPSTREAM_PROTOCOL`/`MCP_UPSTREAM_ERROR`，不会伪造成功 |
| 行长上限/批处理/初始化门禁 | NOT_IMPLEMENTED | 见 [对齐记录 §6](../contracts/modelgate-mcp-delegation-v1-alignment.md) |

## 6. 回滚

```bash
git revert <本段提交>            # 或 git reset --hard <G1 合并点>
rm -rf <config>/mcp              # 删除任务状态目录（仅本地派生数据）
```
回滚不影响网关既有数据面、用户 Codex 配置或生产 8787。
