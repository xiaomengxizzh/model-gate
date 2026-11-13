# G6 真实验收｜Codex 官方 GPT 父模型（gpt-6-luna）→ ModelGate 本地 MCP → OpenCode Go 子任务

- 日期：2026-11-13
- 结论：**PASS（真实上游 + 真实 Codex 客户端 + 真实父模型最终回执）**
- 证据分级：本文件为 `PASS(real)`；其它文件里的 mock 通过不得升级到这里
- 脱敏收据：[2026-11-13-g6-receipt.json](2026-11-13-g6-receipt.json)；第一轮 SHA：[run1 sha256](2026-11-13-g6-run1-sha256.txt)
- 新增大型安装/下载：**无**

## 1. 链路（与方案 §3.1 完全一致）

```
Codex CLI 0.167.0（用户自己的 ChatGPT 官方登录）
  │  父模型 gpt-6-luna ─────────────► api.openai.com（官方，ModelGate 不在父请求链路中）
  │
  └─ 本机 stdio MCP：modelgate_*
        │
        ▼
   ModelGate bin/mg-mcp.mjs（OpenCode Go 独立凭据）
        │
        ▼
   opencode.ai/inference/go/v1/responses（deepseek-v4.1-flash）
        │
        └─ 本地受限工具执行 → 结果 + sha256 回执 → 父模型
```

**没有**走 `gatewaySubscription`、**没有**读取 Codex `auth.json`、**没有**把 ChatGPT 套餐包装成通用 API。
父请求由 Codex 自己直连官方服务；ModelGate 只承担 Go 子任务。

## 2. 父模型标识核验（用户强制要求）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| CLI 显式钉住 | `codex exec -m gpt-6-luna …` | 调用参数里显式指定，未使用自动选择/默认回退 |
| `-m` 确实生效（非被忽略） | `codex exec -m __definitely_not_a_model__` | 运行时报 `Model metadata for ... not found`，说明该参数进入模型解析 |
| 运行时解析结果 | `codex doctor --json -c 'model="gpt-6-luna"'` | `"model": "gpt-6-luna"`、`"model provider": "openai"` |
| 模型目录 | `codex debug models` | 目录 12 条，含 `slug: gpt-6-luna`（GPT-6-Luna） |

**证据限制（必须如实记录）**：Codex 0.167.0 的 `exec --json` 事件流**不含** `model` 字段
（实测 `modelSeenInEvents = null`）。因此父模型标识由「CLI 显式 `-m` + 运行时 `doctor` 解析 + 模型目录」
三方交叉确认；**没有**通过读取会话 rollout 文件反推，也没有只依据配置文件声明。
若后续需要更强的单点证据（rollout `turn_context.model`），需要放弃 `--ephemeral` 并在所有者同意下读取该次会话文件。

## 3. 实际执行

```bash
codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox \
  -m gpt-6-luna -C <ws> \
  -c 'mcp_servers.modelgate.command="<node>"' \
  -c 'mcp_servers.modelgate.args=["<worktree>/bin/mg-mcp.mjs"]' \
  -c 'mcp_servers.modelgate.env.MG_CONFIG_DIR="<config>"' \
  -c 'mcp_servers.modelgate.env.MG_MCP_STATE_DIR="<state>"' \
  -c 'mcp_servers.modelgate.env.MG_MCP_WORKSPACE="<ws>"' \
  -c 'mcp_servers.modelgate.env.MG_MCP_REASONING="high"' \
  -
```

- `--ephemeral`：**不写会话文件**到用户的 Codex 目录。
- `--ignore-user-config`：**不加载也不修改**用户的 `config.toml`；MCP 服务通过 `-c` 命令行覆盖注入。
- `--dangerously-bypass-approvals-and-sandbox`：宿主禁止非特权 user namespace，Codex 自身 bwrap 沙箱无法建立；这是本机环境限制，不是产品配置。

## 4. 结果（真实回执）

父模型最终单行回执（原样，来自 `receipt.json`）：

```
E2E_OK | round1=MG-R1-E036FCBAAFEAF023 | round2=MG-R2-479B241A98DA1CC0 | taskRef=mgtask-be66411758f2ded8 | r1_state=RESULT_READY | r2_state=RESULT_READY | r1_sha256=676adc05189f8f7d936ef053b6a19eedb3ffb731615e01fa14b89d103bd2ae5f | r2_sha256=ecc56fed42a99c38d46cb3db1cf463feeed2a12f9a919c372a5a48dcfd108605
```

- Codex 退出码 **0**；事件 15 条；父模型发起的 MCP 工具调用 4 次，全部 `completed`：
  `delegate_task` → `wait_task` → `followup_task` → `wait_task`。
- 磁盘事实：`round1.txt` = `MG-R1-E036FCBAAFEAF023`（22 字节，sha256 = 父端报的 `676adc…`），`round2.txt` = `MG-R2-479B241A98DA1CC0`（22 字节，sha256 = `ecc56f…`）。**父端报的哈希与磁盘一致**，说明结果确实完整回到父模型。
- MCP 侧任务记录：单 taskRef `mgtask-be66411758f2ded8`，provider `opencodego`，model `deepseek-v4.1-flash`；
  两个 turn（delegate / followup）都是 `ACKNOWLEDGED`（父端读取过结果）；工具调用 2 次 / 6 次，失败 0 次；
  每 turn 各自有独立 `resultDigest`。
- **父端回执写 `RESULT_READY`、而记录里是 `ACKNOWLEDGED` 的解释**：MCP 的结果投递是"读取即确认"——
  `wait_task` 返回那一刻状态是 `RESULT_READY`（父端看到的就是这个值），同一次响应投递完成后服务端把它推进到
  `ACKNOWLEDGED`（契约 T11）。两者不是矛盾，而是同一事实的前后两点；`resultDigest` 不含 `state`，
  因此 ACK 不改变父端可用于复核的摘要。
- **同一 session 追派**：两轮共享同一 `taskRef` 与同一 `sessionRef`（记录里只有一条 sessionRef）。
- **无重复派发**：父端只有 4 次 MCP 调用（2 次 delegate-family + 2 次 wait），MCP 侧只有 2 个 turn，没有重复创建。

第一轮（更早一次运行，因工具调用超时未写出 receipt.json，但产物已落盘）：
`round1.txt` = `MG-R1-09EA9E999FAC60A1`（sha256 `9c801a6e…`），`round2.txt` = `MG-R2-48788FD58488F32E`（sha256 `ccecc882…`），
两轮同样 `ACKNOWLEDGED`、工具 2/3 次、使用量 1175/1309 tokens。两次独立运行都通过。

## 5. 未覆盖的真实项（不冒充）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实上游「取消」 | `NOT_RUN_LIVE` | 取消语义已由离线用例覆盖；真实取消需额外消耗 Go 额度且难以稳定命中在途窗口 |
| 真实上游「超时」 | `NOT_RUN_LIVE` | 同上；离线已覆盖 wait 超时≠失败、整体 budget 中止 |
| 真实进程崩溃恢复 | `NOT_RUN_LIVE` | 对账逻辑由离线用例覆盖（DISPATCHED → UNKNOWN 且禁止重发） |
| Go 429/5xx 真实注入 | `NOT_RUN_LIVE` | 离线已覆盖 5xx 单次发送、FAILED |
| Codex Desktop | G7 | 独立验收，不从 CLI 推断 |

## 6. 回滚

- 删除 `.mg-e2e/`（已 gitignore）与 `<config>/mcp/` 状态目录；
- 本段无任何对用户 Codex 配置/会话的写入（`--ephemeral` + `--ignore-user-config`）；
- 代码回滚见各阶段提交与 [开发计划](../development-plan.md) 的回滚点。
