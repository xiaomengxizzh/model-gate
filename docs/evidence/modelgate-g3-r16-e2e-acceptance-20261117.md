# G3 R16 真实多文件开发任务闭环验收——PASS_REAL（跨供应商 V1 委派可用、P0-B 修复未回退）

> 状态：R16 主轮 **PASS_REAL**；跨供应商 V1 明文委派可用、V2 NO-GO 未触发；原生压缩触发与连续性已证、完整自然形态**部分覆盖**。
> 执行：隔离 g7（网关 `127.0.0.1:18790`）· general-purpose-1 · 2026-11-17。本文由 general-purpose-1 依据脱敏收据逐条核对后落盘。
> 本文只写脱敏证据与结论：不含任何密钥 / auth.json 内容 / token / cookie / prompt / 报文正文；所有 id 仅以截断形态出现（完整值见收据）。
> 统一枚举：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`。

## 1. 摘要

在隔离 g7 中对 ModelGate 原生父子委派做 R16 决定性验收。被测树 `dc6e26e`（工作树干净、前后未变）；形态为 first-party `model_provider=openai` + `openai_base_url=127.0.0.1:18790`（等价生产 8787 仅换端口）、local 订阅（`chatgpt-plan` / `local_codex_auth`），父模型 `gpt-6-luna` 请求级核验，子代理固定 `mg-opencodego-deepseek-v4-1-flash`（`go_deepseek`）。

- **R16 主轮 ＝ PASS_REAL**：真实多文件缺陷被第三方子代理用真实工具修复，父续轮无 400，同 child 追问与上下文记忆成立，codex exit 0，0 错误 / 0 重复副作用；**P0-B 修复在完整多代理闭环下未回退**。
- **跨供应商 NO-GO 未触发**：V1 明文委派下子正常改文件；V2 encrypted-task 路径未启用、不背书。
- **原生压缩**：真实压缩触发与同 thread / 同 child 连续性已证（隔离 fixture 取证）；"真实窗口下长任务自然触发压缩 + 同子完成剩余工作"的完整形态**部分覆盖**，不冒充完整 PASS。

版本口径：codex-cli `0.167.0`；gateway node `22.22.2`；test node `24.22.2`。主轮时间窗 `2026-11-17T20:58:53+0800 → 21:05:57+0800`（约 7m04s，无无限悬挂）。

## 2. 主轮闭环证据（逐环节 PASS_REAL）

| 环节 | 观察结果 | 证据 | 判定 |
| --- | --- | --- | --- |
| 父拆解 | 父 rollout 用 `multi_agent_v1.spawn_agent` 拆解，请求级 `model=gpt-6-luna` | 父 rollout `01a1e996…`；stats byModel | PASS_REAL |
| Go 子实际改文件 | 真实 `exec_command` 修改 4 个文件：`src/rate-limiter.js`（off-by-one `<=`→`<`）、`test/rate-limiter.test.js`（新增窗口滚动回归用例）、`src/config.js`（`V8_VERBOSE`）、`src/cli.js`（verbose 开关）；`git diff` 19+/2- | `task-repo-fix.diff`；git log `ef090b5` | PASS_REAL |
| 工具结果续轮 | 全日志 0× `status=400` / `fail_closed` / `continuation_state_missing`；20 请求 errors=0 | gateway 主日志；stats 快照 | PASS_REAL（P0-B 未回退） |
| 回父 | 父 stderr 引用子真实 diff 与 `node --test` exit 0 汇总 | codex stderr | PASS_REAL |
| 追问同子 | `send_input` + `wait_agent` 作用同一 child `01a1e998…`；子记住上轮修复并新增 verbose 开关（截断 call id `call_PUxVx…` / `call_zsgJW…`） | 父 rollout；`config.js`/`cli.js` diff | PASS_REAL |
| 中断恢复 | V1 工具集无 `interrupt_agent`（V2 才有）；以同 child 续派，child id 一致、无双终态；压缩轮含 `resume_agent` 同 thread | rollout；压缩取证 | PASS_REAL（V1 语义内） |
| 完成 | QA 侧提交 `ef090b5`；`node --test` pass 1 / fail 0；codex `EXIT=0` | git log；test 输出；exit-code 文件 | PASS_REAL |

**父自适应重试（非重复副作用）**：父首次 `spawn_agent(fork_context=True)` 未返回 child（失败），随即以 `fork_context=False` 重试得到唯一工作 child `01a1e998…`。全程只有 1 个子代理改文件、单终态，不构成重复副作用。

## 3. stats 与无回退

- 主轮请求 **20**：11 official（`chatgpt-plan`）+ 9 thirdParty（`opencodego`）；`errors=0`、`retries=0`、`interrupts=0`；byModel `deepseek=1,646,048`（父 tokens 由订阅记账，byModel=0 属订阅出站口径）。
- 全日志四类致命串计数**全 = 0**：`status=400` / `fail_closed` / `continuation_state_missing` / `http_error`。
- 终态：父 `event_msg task_complete`；codex `exit=0`；无 `turn_aborted` / `error` 事件。
- **P0-B 修复在完整多代理闭环下未回退**：工具结果续轮无 400、终态 items 保持与 `function_call` 保留机制在父子多轮场景中成立（与 g2 第二轮 `dc6e26e` 真机结论一致）。

## 4. 跨供应商 NO-GO 观测（关键判定）

**结论：NO-GO 未触发；子代理正常改文件 → PASS_REAL 继续闭环。**

- 四类密文错误串在全部 g7 证据中计数**全 = 0**：`unreadable_encrypted_agent_task` / `clear_encrypted_content` / `v2_encrypted_task_unsupported` / `encrypted_task_id`。
- 实际密文相关行为是**网关对第三方做能力裁剪**：`Codex 参数按目标能力剔除 opencodego include:reasoning.encrypted_content`（9×）。这是删除"推理密文回传"能力声明，**不是**把不可读的 V2 agent 任务当空任务下发；无 `v2_encrypted_task_unsupported` 报错、无静默降级。
- **凭据域严格分离**：official 出站 12× `credential=local_codex_auth`（chatgpt-plan）；thirdParty 出站 9× `identity=thirdParty` + 9× `domain=thirdParty`。官方凭据未发往第三方。
- **产品形态为 V1 明文委派**：`multi_agent_version=v1`，未启用 `multi_agent_v2`。A2 源码判定所述 V2 密文不可读路径在当前委派模式下未被触发。
- **诚实边界**：本轮只证明"V1 明文委派 + 跨供应商子实际改文件"路径可用，**不为 V2 encrypted-task 背书**。V2 若启用，其密文边界须单独真实验收；替代路线（类 native 明文 task 透传是否可行）交 owner 裁决。

## 5. 原生压缩（fixture 触发 + 连续性，诚实标注）

- 主轮父单轮上下文 ~117–128k，低于 luna 真实 272k 窗口，**未自然触发**压缩（agent 自报 `compaction_seen=false`，与日志一致）。
- 为取证压缩闭环，用隔离 fixture **仅下调 Codex 客户端压缩触发提示**（`auto_compact_token_limit` / `context_window`），不改模型 / 工具 / 能力-auth / 不关压缩——恰恰是让压缩更早发生；**真实 `gpt-6-luna` + 真实 Go `deepseek` 请求不变**。
- 结果：codex stderr 3× `context compacted`；父 rollout 3× `CONTEXT CHECKPOINT COMPACTION`，**全部同一 thread `01a1e9a0…`**；压缩序列 `spawn_agent → wait_agent → resume_agent` 在同一 child 上连续，子 rollout 带 `parent_thread_id`，无 error / abort 事件。→ 压缩触发与同 thread / 同 child 连续性 **PASS_REAL**。
- **诚实标注的 fixture 伪影**：首轮把子模型窗口降到 8000，导致子的 remote-compaction route 不可用、子在该轮失败，并产生 1× `status=400` + 数个 502。这是**人为极小窗口伪影**，不是真实 128k / 272k 配置下的产品缺陷；该轮隔离存证 `compact-artifact-*`，**不作 PASS/FAIL 判据**。
- 修正 fixture（子保持真实窗口，仅父阈值 200k）复跑：压缩未在单会话内触发（父线程停在 116k < 200k），但同 child `send_input` / `wait` 全程干净、`EXIT=0`、无新 400（`faithful-compact-*`）。
- 判定：压缩可真实触发且同 thread / child 连续（artifact 已证）；但"真实窗口下长任务自然触发压缩 + 同子完成剩余工作"的完整形态本轮**未完全覆盖**，记**部分覆盖**。

## 6. R13–R20 覆盖矩阵

| 项 | 状态枚举 | 说明 |
| --- | --- | --- |
| R13 direct 基线 | `NOT_RUN` | 本轮聚焦 ModelGate 路径 |
| R14 经 ModelGate 同任务 | `PASS_REAL` | 主轮 PASS_REAL，见 §2–§4 |
| R15 CC Switch 对照 | `BLOCKED` | 无写入授权，默认 BLOCKED |
| R16 长时间 / 多文件任务 | `PASS_REAL` | 主轮 PASS_REAL；压缩为部分覆盖（见 §5） |
| R17 旧 / 新线程 | `NOT_RUN` | 本轮为新线程 |
| R18 有工具 vs 无工具 | `PASS_REAL` | 有工具主轮 PASS_REAL（真实工具 call/output 配对、无 400）；无工具普通对话 `NOT_RUN`（未单列） |
| R19 WS 长连接 / 断线恢复 | `PASS_REAL` | collab `wait` / `send_input` 长会话稳定；断网切换 `NOT_RUN` → 整体部分覆盖 |
| R20 故障恢复 / 用户可见错误 | `PASS_REAL` | artifact 轮记录 fixture 伪影 400/502 与自恢复；真实故障注入 `NOT_RUN` |

## 7. 硬约束与收尾

- 全程未读 / 打印 / 提交任何密钥 / auth.json 正文 / token / cookie / prompt / 报文正文；客户端 auth.json 仅**字节复制**（hash `c4c34ff5…`，从未读内容），收尾已删。
- 脱敏自检：evidence / receipt 无任何 API key / 授权头 / 访问或刷新令牌类明文字符串；证据仅结构 / 计数 / 布尔 / 截断 id。
- 不改源码 / 生产配置、不启动生产服务、不改日常 config / auth（仅哈希 HASH_MATCH，`c4c34ff5…` 既有漂移不 revert）、不换模型 / 不关能力 / 不放大窗口 / 不关压缩。
- 收尾核验：隔离网关 SIGTERM 退出、无残留进程；18790 REQUEST REFUSED；生产 service=inactive、8787 未监听；config / auth HASH_MATCH；被测树 HEAD `dc6e26e` 工作树干净。
- 不 push、不改共享 docs、不合并 main；任务副本为一次性 `/tmp` 副本，删除即回滚，未触碰生产 8787 / systemd / CC Switch。
- 付费请求有目的性：`gpt-6-luna` + `go_deepseek` 锁定，无换模型 / 自动回退；主轮 20 请求，压缩取证两轮另有界。

## 8. 证据路径

- 目录：`/tmp/mg-g7-e2e/evidence-r16/`
- 收据：`R16-receipt-20261117.md`（§0–§8 全字段）
- 主轮：`gateway-main-daily.log`（11 次官方出站 + 9 次 opencodego 出站）、`main-codex-stderr.log` / `main-codex-stdout.jsonl`、stats 主轮快照、exit-code 文件
- 修复 diff：`task-repo-fix.diff`（`c6dd5ac…` → `ef090b5`，4 文件 19+/2-）
- 压缩取证：父 / 子 rollout（截断 id `01a1e996…` / `01a1e998…` / 压缩同 thread `01a1e9a0…`）、`compact-artifact-*`（伪影，不作判据）、`faithful-compact-*`（修正轮子保持真实窗口）
- 状态枚举统一：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；本轮唯一主轮状态 `PASS_REAL`，压缩轮含 fixture 伪影已明确标注、无 mock 记为真实通过。
