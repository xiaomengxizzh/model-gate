# G3 剩余 E2E 验收——R13/R17/R20 PASS_REAL + 原生压缩完整形态部分覆盖

> 状态：R13 / R17 / R20 三项 **PASS_REAL**；原生压缩完整形态 **部分覆盖**（诚实判定，不冒充 PASS_REAL）。
> 执行与本文落盘：general-purpose-1 · 2026-11-17 · 隔离 g7（网关 `127.0.0.1:18790`）。本文依据 `/tmp/mg-g7-e2e/receipts/` 下四份脱敏收据逐条核对后写入共享文档分支。
> 本文只写脱敏证据与结论：不含任何密钥 / auth.json 内容 / token / cookie / prompt / 报文正文；所有 id 仅以截断形态出现（完整值见收据，且收据本身亦为截断/ hash 形态）。
> 统一枚举：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；**只有 `PASS_REAL` 算验收通过**。
> 边界：纯文档写入——不碰源码 / 生产配置、不启动服务、不发起付费请求、不 push、不合并 main。

## 0. 环境与被测树

- 被测树：`dc6e26e6dd149d57bbd9ff7770f76cb98ca119a9`（R13 官方直连、R17/R20/压缩经网关，执行前后一致；工作树干净，未 push，未改共享 docs）。
- 隔离：全部在 `/tmp/mg-g7-e2e` 与端口 `18790` 完成；官方直连基线另用隔离 `direct/codex-home`。
- 形态：first-party `model_provider=openai` + `openai_base_url=127.0.0.1:18790`（等价生产 8787 仅换端口；R13 为纯官方直连、无 `openai_base_url` 覆盖）、local 订阅（`chatgpt-plan` / `local_codex_auth`）。
- 模型：父 `gpt-6-luna` 全程请求级核验；子代理固定 `mg-opencodego-deepseek-v4-1-flash`。R13 未挂任何网关代理。
- 反降级审计：全程**未换模型 / 未关能力 / 未删历史 / 未放大窗口 / 未关压缩**；唯一一次瞬时上游 502 为自然抖动、由 WS 重连恢复，未触发换候选重放。
- 生产隔离：未触碰生产 `8787` / systemd / CC Switch；日常 config / auth 仅字节复制 + 哈希核验，从未读内容。

## 1. R13 官方直连基线 ＝ PASS_REAL（P0-A 对照）

- 路径：`model_provider=openai`、无 `openai_base_url` 覆盖的纯官方直连；隔离 `direct/codex-home`；本项不改被测树。
- 真实行为（同一官方直连形态）：
  1. 无工具单轮返回精确标记 `R13_DIRECT_NO_TOOL_OK`（thread `01a1e9ba…`）；
  2. 真实 shell 工具调用（`function_call call_BSV3…` → `function_call_output` 配对）后正确复述文件真实内容、无 400（thread `01a1e9bc…`）；
  3. 同 thread `resume` 续轮返回 `R13_DIRECT_CONT_OK`，rollout `task_complete` 由 1→2。
- 判定：**3 次有效 codex exec 均 EXIT=0、无 turn.failed、无 400、无孤儿 output** → `PASS_REAL`。证明官方直连本身在多轮 + 工具续轮场景稳定，即 P0-A 上游 / 客户端基线稳定。
- 失败项（如实记）：产品链路无；仅一次 harness 自错（resume 误传 `-C`，codex CLI `EXIT=2`、零请求、无 stdout 事件），改用 fresh exec 完成工具场景，该次不计入产品判定。
- 时间窗 `2026-11-17T21:38:25+0800 → 21:42:37+0800`；codex-cli `0.167.0` / node `22.22.2`；压缩事件未触发（短场景，非本项标）。

## 2. R17 旧 / 新线程续轮隔离 ＝ PASS_REAL

- 路径：同一 first-party openai 父 / 同一隔离网关进程内，跨线程 continuation store 隔离。
- 真实行为：
  - thread A 先跑（2×真实 shell 工具，`reconstructed … restored=7`，thread `01a1e9c6…`）；
  - thread B 新开（1×真实 shell 工具，`restored=4`，thread `01a1e9c8…`，读到且仅读到 B 自己的 marker，不含 A 的 marker → 无串扰）；
  - 在 B 之后恢复 thread A（同 thread id `01a1e9c6…` 经网关，`restored=0 delta=14` + `restored=15`，续轮重建自有历史、上下文连续、无 400）。
- 判定：**4 次有效 run 全 EXIT=0、无 turn.failed；R17 时间窗网关日志 0× `status=400` / 0× fail-closed / 0× degraded** → `PASS_REAL`。各 thread 的 response / call id 互不混用，无 fail-closed、无误降级。
- 失败项（如实记）：
  - 一次瞬时上游 502（13:58:22Z，A3 期间一次 `responses-ws internal POST failed status=502`）：客户端 WS 重连后同轮成功、EXIT=0、无 turn.failed，属上游瞬时抖动已恢复，非串扰 / 非产品缺陷。
  - 两处 harness 自错（非产品）：①首跑用 `nohup&` 起网关被进程组回收→ Connection refused 重连循环，改 managed background 修复；②首版 A2 resume 漏传 `-c base_url` 走官方直连未过网关（stats 未增）不计判据，用 A3 经网关重做。均已如实标注。
- stats：`chatgpt-plan` requests 28→35（+7），errors 1→2（+1 瞬时 502）。时间窗 `2026-11-17T21:50:32+0800 → 21:59:06+0800`。

## 3. R20 真实故障注入 ＝ PASS_REAL（MG-R008 无静默降级真机验证）

- 注入方式（真实、非 mock）：①直接向网关数据面 `POST /v1/responses` 发送未知 `previous_response_id` + 孤儿 `function_call_output`（模拟"工具结果续轮但上一轮状态丢失"的历史 P0-B 真实故障形态）；②对 WS 端点 `/responses` 握手后 3 次 socket 突然断开（mid-handshake cut）；③注入后跑一次真实 codex 工具续轮。注入体零密钥 / 零正文，响应仅回 typed 错误字段 + corr hash。
- 真实行为与逐项判定：
  1. **止损 typed 400**：重建未命中不再把孤儿 output 降级转发给上游造成不可诊断 400，而是 fail-closed 返回 HTTP 400 typed 错误 `{code=continuation_reconstruct_failed, type=continuation_error, message 含 corr=038…}`；日志留 `continuation reconstruct fail-closed reason=continuation_state_missing idLevel=other restored=0 corr=…`（`0354b83e…`）。**上游 POST 未发出（stats 35→35，零付费、零副作用）** → `PASS_REAL`。
  2. **断流进程不挂**：3× mid-handshake cut 后 healthz 200、18790 仍监听、stats 不变、无 degraded / fail-closed 误触发、无无限 spinner、无重复副作用 → `PASS_REAL`。
  3. **恢复轮正常**：注入后真实工具续轮 EXIT=0、读到探针内容、返回 `R20_RECOVERED`（thread `01a1e9cf…`）；期间 5× 上游瞬时 502 被网关"终止而不换候选重放"（MG-R008 正确行为，无静默降级），客户端 WS 重连后同轮成功 → `PASS_REAL`。
- 失败项（如实记）：注入故障本身（预期，typed 400 被正确止损，非产品缺陷）；5× 上游瞬时 502（恢复轮，属 chatgpt.com 抖动，网关正确终止不重放）；全日志 `continuation degraded=0`。
- 时间窗 `2026-11-17T22:00:08+0800 → 22:04:11+0800`；恢复轮 chatgpt-plan requests 35→37（含 5×502 重试消耗），errors 2→7；gpt-6-luna 请求级核验。

## 4. 原生压缩完整形态 ＝ 部分覆盖（诚实判定，不冒充 PASS_REAL）

- 目标：真实窗口（272000 / effective 95%，阈值 258,400）下长任务自然触发压缩 + 同 thread 跨压缩 spawn→wait→resume **同子**完成剩余工作完整形态。
- 硬约束遵守：不改窗口配置（与 catalog 原值逐字节一致）、不关压缩、不换模型、不关能力、不删历史；**不使用 fixture 伪影充当真实自然触发**（未下调阈值、未用极小窗口伪影）；auth 仅字节副本 + 哈希；未碰生产 8787 / CC Switch；脱敏元数据 only。
- **已证**：真实窗口下把同一 thread（`01a1e9d8…`）上下文自然推过阈值（观测 `token_count input=280906 > 258400`），Codex 原生触发压缩——rollout 出现真实 `compacted` 事件（`window_number=1`、replacement_history、`compaction_response_id=resp_005652…`、window 由 `01a1e9d8-fc34…` → `01a1e9e7-1c87…`），压缩后 token_count 归零；压缩后同 thread 继续工作，再次 spawn_agent + wait_agent，子进程真实出站（opencodego 14→21，+7 请求）。这是 R16 曾用 fixture 证明之"压缩可触发 + 同 thread 连续"在**真实窗口、零阈值改动**下的再次独立确认。
- **未证 / 不成立（关键判据未满足）**：
  - **同子续轮不成立**：压缩前 child `01a1e9d9…`（spawn `call_rfEv…`），压缩后是 NEW spawn child `01a1e9e6…`（`call_3NsS…`），并非 resume 同一 child id——"同子跨压缩"判据未满足。
  - **终态未干净**：触发轮在委派后等待 MCP / 子返回期间卡于 `chatgpt.com/backend-api/ps/mcp` 重试，900s 超时 **EXIT=124**，未产出最终报告 JSON（turn 停在 `collab_tool_call`）。
  - 两次独立自然尝试（60 文件逐文件 cat）因工具输出 10k token 截断 + 模型拒绝超长 grind，per-turn 上下文仅到 ~128k 未触发压缩；改用 stdin 注入真实源码（用户消息不受工具截断，非 fixture、仅用户消息）才把真实上下文推过阈值。
- 判定：按枚举本项等价 **NOT_RUN 于"同子完整形态"这一判据**，记 **部分覆盖**，不硬套、不伪造 `PASS_REAL`。成本边界：已发多轮有目的性真实请求（2 次未触发尝试 + stdin 注入 + 超时轮），按"成本 / 时长过高即如实记部分覆盖"口径不再无限追加。
- 时间窗 `2026-11-17T22:06:49+0800 → 22:40:51+0800`（多轮累计）；gpt-6-luna 请求级核验；无 400 由压缩引起（全日志唯一 status=400 为 13:12 R16 旧伪影）。

## 5. 完整 R13–R20 验收矩阵汇总

| 项 | 状态枚举 | 说明 |
| --- | --- | --- |
| R13 direct 基线 | `PASS_REAL` | 官方直连无网关；无工具单轮 + 真实工具 call/output 配对 + 同 thread resume 续轮；3× EXIT=0、无 400，P0-A 基线稳定（§1） |
| R14 经 ModelGate 同任务 | `PASS_REAL` | G3 R16 主轮 PASS_REAL，见既有 `modelgate-g3-r16-e2e-acceptance-20261117.md` §2–§4 |
| R15 CC Switch 对照 | `BLOCKED` | 无写入授权；符合"借鉴 CC Switch 而非完善它"的口径，默认 BLOCKED |
| R16 长时间 / 多文件任务 | `PASS_REAL` | G3 R16 主轮 PASS_REAL；原生压缩为部分覆盖（见 §4） |
| R17 旧 / 新线程 | `PASS_REAL` | A→B→恢复 A（同 thread id），各自 reconstructed 自有历史（restored 7/4/15），B 不读 A marker；0×400 / 0× fail-closed（§2） |
| R18 有工具 vs 无工具 | `PASS_REAL` | 有工具主轮 PASS_REAL（真实工具 call/output 配对、无 400）；无工具普通对话 `NOT_RUN`（未单列） |
| R19 WS 长连接 / 断线恢复 | 部分覆盖 | collab wait / send_input 长会话稳定；本轮断流 3× + 瞬时 502 恢复，断网 / 网络切换 `NOT_RUN` → 整体部分覆盖 |
| R20 故障恢复 / 用户可见错误 | `PASS_REAL` | 真实故障注入全过：typed 400 止损（stats 35→35 零付费零副作用）、3× 断流进程不挂、恢复轮真实工具续轮 EXIT=0、5×502 终止不重放后重连成功（§3） |
| 原生压缩完整形态 | 部分覆盖 | 真实窗口触发原生 compacted 事件 + 压缩后同 thread 子进程真实出站 +7；但压缩后 NEW spawn 而非 resume 同子、触发轮 EXIT=124 无干净终态，"同子跨压缩"未满足（§4） |
| P0-B 历史 400 | `PASS_REAL`（已解决） | G2 第二轮 `dc6e26e` 真机已确认 400 消除、continuity 恢复；R16 / R20 闭环无回退 |
| 跨供应商委派 | V1 `PASS_REAL` / V2 不背书 | V1 明文委派 + 子实际改文件可用；V2 encrypted-task 未启用、不背书 |

## 6. 剩余未覆盖与建议

- **MG-R006 同子跨压缩 resume 完整闭环（部分覆盖，待 owner 裁决）**：真实窗口下压缩触发与同 thread 连续已证，但"压缩前后同一个 child id 的 resume→完成剩余工作"未成立（模型压缩后自行新 spawn，且触发轮 MCP 重试超时 EXIT=124）。若需判定该项，建议追加**有界预算**重跑，并在提示词中**显式固化压缩前 child id**（本轮 `01a1e9d9…`）且强制压缩后首个 turn `resume_agent(child_id=<pre>)`（模型本轮未遵循隐含指令）；是否追加由 owner 裁决，不再无限投入。
- **R15 CC Switch 对照（BLOCKED）**：受写入授权限制，符合"借鉴 CC Switch 而非完善它"的既定口径；如需真机对照须先取得明确授权。
- **R19 断网 / 网络切换（未做）**：本轮仅验证 3× WS 断流（mid-handshake cut）与瞬时 502 恢复，未覆盖真实断网 / 网络切换场景。

## 7. 收尾核验

- 端口 / 服务：`18790` RELEASED（not listening）、生产 `8787` 未监听、`model-gateway.service` = inactive、无残留进程。
- 凭据：config / auth 哈希核验 `HASH_MATCH`（config `8f3d6cc6…` / auth `c4c34ff5…`，既有漂移不 revert）；隔离 `/tmp` 内 auth.json 字节副本已全部删除（现存数量 0）；全程未读 / 打印 / 提交密钥 / auth.json 正文 / token / cookie / prompt / 报文正文。
- 脱敏自检：对四份收据按四类敏感串（API key 前缀 / 授权头 / 访问令牌字段 / token 赋值）逐类计数——授权头 / 访问令牌字段 / token 赋值三类全 0；API key 前缀仅 R18 命中 2 次，经核为 `task-repo` 单词内的子串误报，实为 0 真实密钥命中。
- 被测树：HEAD `dc6e26e…` 未变、工作树干净；未 push、未合并 main、未改共享 docs（仅本分支新增本文）。
- 付费请求：仅 `gpt-6-luna` + `mg-opencodego-deepseek-v4-1-flash` 锁定，无换模型 / 自动回退；故障注入零上游 POST、零付费、零副作用。

## 8. 证据路径与状态口径

- 收据目录：`/tmp/mg-g7-e2e/receipts/`，四份原始收据：
  - `R13-direct-baseline-receipt.md`（R13，§1）
  - `R17-old-new-thread-receipt.md`（R17，§2）
  - `R20-fault-injection-receipt.md`（R20，§3）
  - `R18-natural-compaction-full-form-receipt.md`（原生压缩完整形态，§4）
- 状态枚举统一：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；**只有 `PASS_REAL` 算验收通过**；本文 R13 / R17 / R20 为 `PASS_REAL`，原生压缩完整形态与 R19 为部分覆盖（判据级 `NOT_RUN`），R15 为 `BLOCKED`，无 `PASS_MOCK` 冒充真实通过。
