# ModelGate 真实原生父子代理验收（A5 原生 Agent Team，2026-11-14）

> 本文件固化一次**已完成的真实上游实跑**的报告与脱敏原始证据。该实跑由独立的 A5 agent 在树 `67b9735` 上执行，原始材料仅存于临时目录，不随仓库保留。**收尾轮（本轮）没有发起任何新的上游请求、没有 live probe、没有 OAuth、没有真实模型调用**；下文所有数字与结论均来自对该次实跑只读报告的整理。本文件只登记实测事实，**不宣告矩阵/门禁状态升级**。

- **被测树 SHA**：`67b97354ad28a3924607b35a663801f417f14b8e`（短 `67b9735`，分支 `mg-codex-native`；实跑对该树只读，未修改、未检出、未提交任何 `src/**`）
- **运行环境**：Linux x86_64，Node `v24.22.2`，Codex CLI `0.167.0`；请求窗口 2026-11-14 12:53–13:07Z
- **隔离实例**：网关 `127.0.0.1:19030`；负向对照网关 `127.0.0.1:19031`；隔离 `CODEX_HOME` 与 `MG_CONFIG_DIR` 均置于临时目录；两者收尾均已关闭
- **未触碰**：所有者常驻进程 551774、`127.0.0.1:18787` 网关、全部 ChatGPT Electron 实例；未写所有者用户级 `config.toml`；未安装、未下载
- **性质**：真实上游、真实本机订阅登录、原生 Codex 父子线程与原生工具/中断/恢复；**不含** Desktop GUI、不含第二身份、不含外部中断、不含 Responses WebSocket 实测

## 1. 授权预算台账

所有者授权：仅 `gpt-6-luna`，60 次上游请求或 40 分钟，先到即止。

| 项目 | 实际 |
| --- | --- |
| 上游请求 | **37 / 60**（阶段表 36 + 1 次目录导出） |
| 墙钟 | **14 / 40 分钟**（12:53–13:07Z） |
| GPT 请求 | **26 / 26 全部 `gpt-6-luna`**（0 次其他 GPT 型号） |
| Go 请求 | 9 次 `deepseek-v4.1-flash` |
| 负向对照（错误凭据） | 1 次 |

| 阶段 | # | 请求级模型 | 结果 |
| --- | --- | --- | --- |
| baseline | 1 | `gpt-6-luna` | 200 |
| attempt 1（上下文溢出） | 6 | 5 luna + 1 deepseek | 6×200 |
| R005 retry | 7 | 5 luna + 2 deepseek | 7×200 |
| R006 第二任务 | 6 | 4 luna + 2 deepseek | 6×200 |
| R006 中断 | 5 | 4 luna + 1 deepseek | 4×200 + `ECANCELED` |
| R006 恢复 | 5 | 3 luna + 2 deepseek | 5×200 |
| R006 上下文证明 | 5 | 4 luna + 1 deepseek | 5×200 |
| 负向对照（错误凭据） | 1 | `deepseek-v4.1-flash` | 401 |

请求级核验方式：对隔离实例注入只读 `https.request` 观测钩子，从实际写出的明文请求体读取 `model`，不修改请求。原始逐行记录 35 行 + 错误凭据对照 1 行。

## 2. 场景结果（全部 `PASS_REAL`）

| 场景 | 状态 | 观测 |
| --- | --- | --- |
| 父进程派单（R005） | `PASS_REAL` | 真实 `codex exec`；父 thread `01a1da23-1790-7382-ba19-17560e66e3db`；`collaboration__spawn_agent` 产出 `{"task_name":"/root/toolprobe"}`，子模型 `mg-opencodego-deepseek-v4-1-flash` |
| 子线程身份 | `PASS_REAL` | 真实 rollout `01a1da23-6c27-72a2-a0aa-1824370f6377`：`parent_thread_id` 等于上述父 thread，`source.subagent.thread_spawn={depth:1,...}`；2 次真实 Go 调用；`NEW_TASK` 为明文而非加密 |
| 原生工具调用 | `PASS_REAL` | 子代理 `exec_command` → `printf A5_CHILD_TOOL_OK`，`exit_code=0`；父进程回执 `PARENT_OK:CHILD_DONE_A5_CHILD_TOOL_OK` |
| 同一子代理第二个任务 | `PASS_REAL` | `codex exec resume` + `followup_task`；同一 rollout 收到第二个 `NEW_TASK`，`printf A5_CHILD_TOOL_B` exit 0；未新建子会话 |
| 原生中断 | `PASS_REAL` | 第三个 `followup_task`（`sleep 45`）后调用原生 `interrupt_agent`：子代理 `turn_aborted reason:"interrupted"`（13:02:55.879Z，单一终态）；在途 Go 调用 `ECANCELED`；`list_agents` 为 `interrupted`；无 `task_complete` |
| 中断后恢复 | `PASS_REAL` | 同一子代理的下一个 `followup_task`：`printf A5_CHILD_TOOL_C` exit 0 且 `task_complete`；父进程回执 `PARENT_OK_C:...` |
| 上下文保持 | `PASS_REAL` | 第四个任务要求子代理在无工具情况下引用首个任务标记；子代理输出 `CONTEXT_PROOF:A5_CHILD_TOOL_OK` |
| 无重复派单 | `PASS_REAL` | 1 个 `spawn_agent` 回执、5 条 `NEW_TASK` 对应 5 个父命令、仅 4 个 rollout 文件（2 父 + 2 子）；所有 R006 轮次均落在同一子线程 `01a1da23-6c27…` |
| 负向 A（错误模型） | `PASS_REAL` | `mg-opencodego-does-not-exist` → 404 `unknown_model`，出站增量 **0**；无默认供应商回退 |
| 负向 B（错误凭据） | `PASS_REAL` | 隔离 19031 + 无效 Go key → 401 `authentication_error`；**恰好 1 次**出站，模型 `deepseek-v4.1-flash`，无重试、无 GPT 替换 |

**首个尝试（诚实 `FAIL`）**：128k 子窗口 + 153,192 tokens 触发 Codex compaction，网关以 typed `unsupported_input_item` 拒绝；改用观测到的 200k 窗口后该步骤消失。此 `FAIL` 如实保留，不删除、不改写、不降级为 `PASS`。

## 3. 凭据保全证明

| 检查点 | 值 |
| --- | --- |
| 原文件 `sha256` | `de7cc6e996e6bcef35041d489f5dac84b799de735851531d5a11f7f6a4a7fc11` |
| 大小 | 3995 B |
| mtime | 1794046999 |
| mode | 600 |
| 运行前后 | **完全一致**（identical before/after） |

- 隔离副本 `sha256` 与原文件相同，说明**没有发生令牌刷新**。
- 临时凭据目录（目录 0700、文件 0600）与隔离 `CODEX_HOME` 内的凭据文件在收尾用 `shred -u` 销毁，已不存在。
- 令牌**未打印、未写入日志、未提交进仓库**；出站仅发往 `chatgpt.com`；未发起新 OAuth。
- 本文件与同名 JSON 只记录哈希与元数据，**不含任何令牌、凭据值、account id 或凭据文件正文**。

## 4. 对 MG-R 的影响（实测事实，非状态宣告）

- **MG-R005**：真实 CLI 父进程、原生 spawn、真实子线程与真实子模型调用、原生 `exec_command` 均观测到，证据支持 `PASS_REAL`。
- **MG-R006**：同一子代理跨五个任务（A、B、被中断的 sleep、C、上下文证明）、原生中断收敛到单一 `interrupted` 终态、中断后在同一子代理恢复、上下文保留、无重复派单，证据支持 `PASS_REAL`。
- **MG-R008**：两条 no-silent-fallback 负向对照（错误模型 0 出站、错误凭据恰好 1 出站且不重试不替换）取得真实证据；但 unsupported-tool 与 catalog 两例仍非真实路径，整行口径应保留 `PASS_MOCK / partial` 的窄证据 caveat，不得据此外推为整行真实通过。
- **MG-R012**：26/26 GPT 请求均为 `gpt-6-luna`，再次确认。

> 状态升级须由 `scripts/test/offline/aggregation-matrix.js` 从证据状态表**统一重新生成**，不得手改矩阵；较新证据取代旧快照时须在依据中写明 `取代 <OLD_STATUS> @ <OLD_DOC_PATH>`。本轮对应标记：`取代 PASS_MOCK @ docs/evidence/aggregation-integration-2026-11-14.md`（R005）、`取代 NOT_TESTED @ docs/evidence/aggregation-integration-2026-11-14.md`（R006）。门禁须仍为 `ready:false`（R001/R004 等仍非 `PASS_REAL`）。截至本文件提交，矩阵/门禁的重新生成为**待办**，未执行。

## 5. 明确未声称（unproven）

- 原版 Desktop GUI 与原始模型选择器（仅 CLI）。
- 外部中断（Ctrl-C、app-server `turn/interrupt`）；本轮实跑为原生 `interrupt_agent`。
- Responses **WebSocket**：网关返回 404，CLI 回退 HTTPS（每次运行 5 次重试）；这是真实缺口，不是静默成功。
- 子代理仅使用 Go `deepseek-v4.1-flash`；无 Console provider、无第二真实身份。
- 第三方原生模型的 `compaction_trigger` 被 typed 拒绝；无长上下文 compaction 路径。
- 未做真实 `~/.codex` 激活演练、未做原版 Desktop GUI 真实测试、未做 anthropic/google 路由决策。

## 6. 路径与隔离

- GPT 出站：`chatgpt.com/backend-api/codex/responses`
- 子代理出站：`opencode.ai/inference/go/v1/responses`
- 网关 `127.0.0.1:19030`、负向对照 `127.0.0.1:19031`，收尾均已关闭。
- 所有者常驻网关 `127.0.0.1:18787` 与进程 551774 全程未动。

## 7. 确认

本收尾轮未读取、未打印、未提交任何凭据，未发起新 OAuth、未安装下载、未做 live probe；上一轮真实实跑 37/60 请求、14/40 分钟，且 26/26 GPT 请求均为 `gpt-6-luna`。原始脱敏证据（routes、event JSONL、rollouts、negatives）仅存于临时目录，不随仓库提交。所有者进程与端口 19030/19031 状态如上。
