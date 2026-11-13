# G7 Desktop 独立验收矩阵（2026-11-13，未执行）

状态：**NOT_RUN**。原因不是"没法测"，而是必须由所有者在本机 GUI 会话中按下面矩阵执行，
且不得复用 G6 的 CLI 结论（方案 §5 G7 明确要求独立证据）。

## 1. 为什么本轮不执行

| 阻断 | 说明 |
| --- | --- |
| 需要真实 GUI 会话 | Desktop 是 Electron 应用，需用户桌面会话、单实例锁与已登录账户；本轮执行环境是非交互终端 |
| 不得碰日常配置 | Desktop 使用 `~/.codex` 单实例与默认 provider；验收必须在**独立 profile/实例**下进行，否则会改写所有者日常配置 |
| 不得从 CLI 推断 | CLI 通过不等于 Desktop 通过（历史上 Desktop 单实例固定默认 provider、UI 无 profile 选择器） |

## 2. 验收矩阵（所有者执行）

前置：**父模型只允许 `gpt6luna`（`gpt-6-luna`）**；先做模型核验，再做链路。

| # | 场景 | 步骤 | 通过标准 |
| --- | --- | --- | --- |
| D0 | 父模型核验 | Desktop 设置/会话信息确认当前模型为 `gpt-6-luna` | 实际生效标识 = `gpt-6-luna`；若不可用 → **停止**，不得换模型 |
| D1 | 官方直连 | 不配置 `openai_base_url`，正常对话 | 官方服务可用；ModelGate 不在父请求链路 |
| D2 | MCP 可见 | 在 Desktop 的 MCP 设置中登记 `node <worktree>/bin/mg-mcp.mjs`（stdio） | 5 个 `modelgate_*` 工具可见且可调用 |
| D3 | 初派 | 让父模型 `delegate_task` 一个写文件挑战 | 工具返回 taskRef；`wait_task` 返回 RESULT_READY；文件落盘且 sha256 与回执一致 |
| D4 | 同 session 追派 | `followup_task` 同一 taskRef | 复用同一 taskRef/session；第二轮结果独立回执且父端完整引用 |
| D5 | 取消 | 对一个长任务 `cancel_task` | 状态 CANCELLED 且如实返回 `upstreamStopUnknown` |
| D6 | 重启恢复 | 关闭 Desktop 后重开，按 taskRef 查询 | 在途回合为 UNKNOWN 且**不重发**；不产生重复任务 |
| D7 | 隔离 | 全程检查 | Desktop profile / 日常 `config.toml` 未被改写；未读取 `auth.json` 到 ModelGate |

## 3. 本轮可交付的支撑

- CLI 侧同一 MCP 服务已真实通过（G6），Desktop 只需要验证"客户端侧 MCP 接线与交互"这一层差异。
- 若 Desktop 不支持 stdio MCP 或工具审批无法放行，结论应为 `BLOCKED(desktop-mcp-unsupported)`，不得改写为 PASS。
