# G2 治本修复真机验证——400 未消失、ct 误判已修但因终态快照冲掉 function_call（2026-11-17）

> 状态：修复单轮 **FAIL_REAL**；普通对话护栏 **PASS_REAL**；新增待修根因＝终态快照空 output 覆盖已捕获 function_call；再修复＝**pending owner 裁决**。
> 执行：general-purpose-3 · 2026-11-17 · 严格 2 单轮 gpt-6-luna 请求（修复 ON 1 + 护栏 1）。
> 本文只写脱敏证据与结论：不含任何密钥 / auth.json 内容 / token / cookie / prompt / 报文正文；所有 id 仅以截断形态出现。
> 统一枚举：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`。

## 1. 摘要

严格 2 单轮 gpt-6-luna 真机验证（first-party `model_provider=openai` → `127.0.0.1:18790`，等价于生产 8787 仅换端口；local 订阅；请求级核验 `stats.byModel` 仅含 gpt-6-luna）：

- **修复单轮（工具结果续轮）＝ FAIL_REAL**：治本修复确实 ENGAGE（content-type 误判已修正、sink 已挂载、登记真实 50hex id），但 400 仍在、codex `exit=1`。
- **普通对话护栏 ＝ PASS_REAL**：`exit=0`、行为未被治本改变（P0-A / MG-R002 不回退）。

核心结论：治本三项已修正 ct 误判并登记真实 id，但暴露更深一层根因——`captureSink` 终态快照用空 output 覆盖了已捕获的 `function_call`，导致 `reconstruct` 只恢复 input 不含 `function_call`、下一轮 `function_call_output` 成为孤儿，再次触发上游 400。故 **P0-B 未真正解决**。

## 2. 被测树

- worktree：`.agents/worktrees/g1-p7-structdiag`
- HEAD ＝ `6026e87`（parent `cc6a797`），含治本 `continuationRootFix` 默认 ON + 止损项。
- 前后未变：`git rev-parse` 执行前后均为 `6026e87`，未改树。
- 独立评审：**PASS_WITH_NITS / GO**（见前序文档）。

## 3. 单轮 1：修复 ON 工具结果续轮 ＝ FAIL_REAL

- corr ＝ `b2d2728d…`（全部 `mgp0.offstruct` 行同串）。
- codex-cli 0.167.0，shell 工具调用后回传 `function_call_output` 续轮；thread `01a1e924…d2f96`；tokens 113,258；时间窗 18:54:07→18:54:47+0800。
- **codex `exit=1`**。stderr 终态：`400 No tool call found for function call output with call_…`（P0-B 400 原样复现）。

### 3.1 治本确实 ENGAGE（ct 误判已修）

- `entry … status=200 ct=`（content-type 为空，正是治本要处理的形态）→ SSE 正文嗅探走 SSE 分支。
- `sinkattach branch=raw official=1 attached=1 continuation=1` ← 治本生效（对照基线 `55434b7` 为 `attached=0`）。
- 26 行 SSE applyevent（`output_item.added×2` / `function_call_arguments.delta×22` / `metadata×1` / `arguments.done×1` / `output_item.done×1`），`firstframe=sse`，sinkrecv `ntypes=8 sawAny=1 hasRespId=1`。
- `responses continuation recorded id=resp_0cb924cf…08d09f0 items=1` ← recorded key 为**真实 50hex**（非 opaque / 非 `resp_mgws_`），治本 #2/#3 命中。
- `reconstructed prev=resp_0cb924cf…08d09f0 restored=3 delta=1` + `store point=reconstruct_hit idLevel=other idH=cb553c73 store=2` ← 重建命中、`restored>0`、真实 id 层级。
- **无 degraded、无 continuation_state_missing、无 fail_closed、无 typed 400**。

### 3.2 但 400 仍在

- 上游出站 **2 次**（200 + 400）。
- 网关 `entry status=400` / `terminal kind=http type=http_error status=400` / `responses-ws internal POST failed status=400`；stats global `requests=1 errors=1`。

### 3.3 content-type 写回下游真机表现

首轮 200（ct 空 → 嗅探为 SSE → 写回 `text/event-stream; charset=utf-8`）后，codex 正常解析 SSE 并拿到 `function_call`，工具执行成功、stdout 有完整 tool 事件，**无字节漂移 / 无解析失败**。结论：400 不在 CT/SSE 解析层。

## 4. 新根因（关键强线索）

同一 id 的 recorded 序列：

```
items=0 (10:54:29) → items=1 (10:54:34，function_call 已捕获) → items=0 (10:54:41.016 terminal=1) → record_final
```

- `captureSink.snapshot()`（`responses-continuation.js:193-196`）**优先取 `completedOutput`**（来自 `response.completed.response.output`），而非增量的 `outputById`。
- 本后端 `response.completed.response.output` 为空（**全程无 `response.completed` 的 applyevent**，`function_call` 只在 `output_item.done` 携带），终态快照返回**空 output**。
- `recordContinuation`（`responses-continuation.js:84-95`）幂等覆盖，把已捕获的 `function_call` 条目（`items=1`）冲成空（`items=0`）。
- 于是 `reconstruct restored=3` 只恢复 input 历史、**不含 `function_call`**；下一轮 `function_call_output` 变孤儿 → 上游 400。

修复方向：终态快照合并 / 保留 `outputById` 已捕获项；或 `recordContinuation` 拒绝用空 output 覆盖已有非空 output（勿在记录窗口把真实 `function_call` 冲掉）。

## 5. 单轮 2：普通对话护栏 ＝ PASS_REAL

- 无工具、无子代理、gpt-6-luna 普通连续对话；thread `01a1e926…f4d5`；tokens 113,213；时间窗 18:56:07→18:56:59+0800。
- **codex `exit=0`**，stdout `4`，stderr `codex … 4` 正常收尾。
- 无 typed 400、无 degraded、无 fail_closed；上游出站 **1 次**（200）；corr `9e78dca3…` 全程 200。
- 唯一 `reconstructed prev=resp_mgws_ce3740ba… restored=0 delta=3` 是 WS 桥**会话开局预热**（治理前后均存在，非工具结果续轮、无 400），不属 P0-B 续轮路径。
- 结论：普通对话行为未被治本改变（P0-A / MG-R002 不回退）。

## 6. 综合判定

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| P0-B 工具续轮 | **FAIL_REAL** | 决定性单轮 1 仍 400、`exit=1`，未真正解决 |
| ct 误判修正 | 生效 | 登记真实 id、sink 挂载、CT 写回正常，400 不在 CT/SSE 解析层 |
| 新增待修点 | 强线索 | 终态快照空 output 覆盖已捕获 function_call，致 reconstruct 缺 function_call、孤儿 output 400 |
| 普通对话护栏 | **PASS_REAL** | 单轮 2 `exit=0`，行为未回退 |
| 再修复 | **pending owner 裁决** | 按 §4 方向修订治本后需重验 |

## 7. 收尾

- 隔离 diagnostic 开关：`diagnosticOfficialStructure` 已删（治本默认 ON 无需关）；实验开关从未开。
- 进程 / 端口：两隔离网关 TaskStop 优雅退出；18790 RELEASED；无 `node src/index.js` 残留。
- 哈希：日常 config/auth 与本轮自有前置 baseline 逐项 **HASH_MATCH**（auth `c4c34ff5…`）；相对 16:46 冻结基线的 auth 漂移为既有 token 刷新，未 revert；隔离 auth 副本已删。
- 生产：service=inactive、8787 未监听。
- 测试树 HEAD 仍 `6026e87`；未 push、未改共享 / docs worktree；全程未读 / 打印密钥 / Cookie / token / auth.json / 正文。

## 8. 证据路径

- 收据：`/tmp/mg-g5-e2e/g5-forensics-receipt-20261117.md`
- `evidence-r1/`：run1 stats + 网关日志
- `gateway-r1-stdout.log` / `gateway-r2-stdout.log`
- `g5-r{1,2}-codex-{stdout.jsonl,stderr.log,exit-code.txt,request-start/end.txt}`
- `g5-pre-run.sha256`（前置哈希 baseline）

## 9. 状态

- 修复单轮：**FAIL_REAL**
- 护栏：**PASS_REAL**
- 新根因：强线索（终态快照空 output 覆盖 function_call）
- 再修复：**pending owner 裁决**
- 枚举口径：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`
