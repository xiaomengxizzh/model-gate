# G2 第二轮真机重验——P0-B 已 PASS_REAL 解决（400 消失、连续性恢复）

> 状态：修复单轮 **PASS_REAL**；普通对话护栏 **PASS_REAL**；**P0-B 真正解决**。
> 执行：隔离真机重验 g6；本文由 general-purpose-4 依据既有脱敏事实落盘 · 2026-11-17。
> 本文只写脱敏证据与结论：不含任何密钥 / auth.json 内容 / token / cookie / prompt / 报文正文；所有 id 仅以截断形态出现（完整 corr 值见收据）。
> 统一枚举：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`。

## 1. 摘要

第二轮真机重验针对 G2 首轮暴露的根因（终态快照空 output 冲掉已捕获 `function_call`）实施治本：被测树 `dc6e26e`（终态快照保留 `function_call` + `recordContinuation` 拒空覆盖）。在隔离 g6、first-party `model_provider=openai` → `127.0.0.1:18790`（等价生产 8787 仅换端口）、local 订阅、gpt-6-luna 请求级核验条件下，严格 2 单轮与 g5 同脚本、同形态复验：

- **修复单轮（工具结果续轮）＝ PASS_REAL**：400 消失、codex `exit=0`（对照 g5 基线 `exit=1` / 400 复现）。
- **普通对话护栏 ＝ PASS_REAL**：`exit=0`、行为未回退（P0-A / T13 不退化）。

结论：相对 g5 基线决定性反转，**P0-B 真正解决**。

## 2. 被测树

- worktree：`.agents/worktrees/g1-p7-structdiag`
- HEAD ＝ `dc6e26e`（parent `6026e87`），含两轮治本 + 止损项。
- 前后未变：执行前后 `git rev-parse` 均为 `dc6e26e`，工作树干净、未改树。
- 独立评审：**PASS_WITH_NITS / GO**。
- commit 链：`886e22a` → `930d0ae` → `cc6a797` → `6026e87` → `dc6e26e`。

## 3. 单轮 1：修复单轮 ＝ PASS_REAL（corr `abf52169…` 全同串）

- **400 消失**：全日志 `status=400` / `http_error` / `degraded` / `fail_closed` / `continuation_state_missing` / internal `POST failed` / typed400 / `capture empty` 计数**全 = 0**。
- 上游出站 **2 次均 200**（对照 g5 基线为 200 + 400）。
- codex **`exit=0`**（对照 g5 基线 `exit=1` / 400 原样复现）。
- corr ＝ `abf52169…`（全部日志行同串；完整值见收据）；thread `01a1e97f…348`；tokens 226,587；时间窗 20:32:57 → 20:34:02 +0800。
- 日志序列：entry 200 / ct 空 → SSE 嗅探走 SSE 分支 → sinkattach `attached=1` → 26 行 applyevent（`output_item.added hasFnCall=1` + `function_call_arguments.delta ×22` + `arguments.done` + `output_item.done hasFnCall=1`）→ `firstframe=sse` → sinkrecv `ntypes=8 sawAny=1 hasRespId=1` → recorded 真实 50hex id `resp_0d4b573a…674e4f9` → reconstructed `restored=4 delta=1` + store `reconstruct_hit store=2` → 第 2 次上游 200 → **`exit=0`**。

## 4. 终态 items 不回退（决定性差异）

同一 id 的 recorded 序列对比：

- `dc6e26e`：`0 → 1 → 1 (terminal=1) → record_final` —— 终态仍保留已捕获项。
- g5 基线：`0 → 1 → 0 (terminal) → final` —— 终态空快照冲掉 `function_call`。

`dc6e26e` 的 `mergeCapturedOutput` + `recordContinuation` 拒空覆盖生效，`function_call` 在终态快照中得以保留，不再被空 output 覆盖。

## 5. reconstruct 含 function_call 且顺序正确（充要条件双重证明）

① 真机证据：

- 第 2 次上游 **200（非 400）** 本身即证明 `function_call_output` 不再是孤儿。
- rollout 只读结构确认 `function_call` 与 `function_call_output` 的 `call_id` 配对（`call_wzNP4QcoEelF4O861…`），且 `function_call` 在前、顺序正确。
- `restored` 从 g5 的 **3 → 4**，多出的 1 项正是被保留的 `function_call` 项。

② 离线证据（`continuation-snapshot-fix.test.mjs` **13/13 PASS**）：

- test ③：`rec.input` 含 `function_call`。
- test ⑤⑥⑦：`outAt > fcAt` + end-to-end 200、无 400、无 fail-closed。
- test ④：回滚为 false 时复现旧行为（覆盖空快照）。
- 开局一条 `resp_mgws_` `restored=0` 为 WS 桥会话预热，非续轮、无 400，不计入 P0-B 路径。

## 6. 单轮 2：普通对话护栏 ＝ PASS_REAL

- 无工具、无子代理、gpt-6-luna 普通连续对话；corr ＝ `839bc207…`（完整值见收据）。
- codex **`exit=0`**，stdout 输出 `4` 正确。
- `status=400` / `http_error` / `degraded` / `fail_closed` / `continuation_state_missing` / typed400 **全 = 0**；上游出站 **1 次 200**。
- 结论：两轮治本未改变普通对话行为（P0-A / T13 不回退）。

## 7. 综合判定

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| P0-B 工具续轮 | **PASS_REAL** | 400 消失、`exit=0`、第 2 次上游 200，相对 g5 基线决定性反转 |
| 终态 items 保持 | **PASS_REAL** | `0→1→1(terminal)→record_final`，`function_call` 不再被空快照冲掉 |
| reconstruct 含 function_call 且排序正确 | **PASS_REAL** | 真机 200 + call_id 配对有序 + `restored=3→4`；离线 13/13 |
| 普通对话护栏 | **PASS_REAL** | 单轮 2 `exit=0`、输出正确，P0-A / T13 不回退 |
| 独立评审 | GO | 与评审 PASS_WITH_NITS / GO 一致 |
| 状态枚举 | 统一 | `PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED` |

总判定：**P0-B = PASS_REAL，真正解决**。

## 8. 收尾

- 诊断开关已删（`server` keys ＝ `[host, port, logFile]`）；治本 / 止损项默认 ON 未关；实验开关全 OFF。
- 进程 / 端口：两隔离网关 SIGTERM 优雅退出；18790 RELEASED；无残留进程。
- 哈希：日常 config / auth 与本轮自有前置 baseline 逐项 **HASH_MATCH**（auth `c4c34ff5…`）；相对既有基线的 auth 漂移为既有刷新，未 revert；隔离 auth 副本已删。
- 生产：service=inactive、8787 未监听。
- 被测树 HEAD 仍 `dc6e26e`、工作树干净；未 push、未改共享 docs；全程未读 / 打印密钥 / Cookie / token / auth.json / 正文。

## 9. 证据路径

- 收据：`/tmp/mg-g6-e2e/g6-forensics-receipt-20261117.md`
- `gateway-r1-stdout.log` / `gateway-r2-stdout.log`
- codex stdout / stderr / exit / 时间戳文件
- `g6-pre-run.sha256`（前置哈希 baseline）
- 离线 `continuation-snapshot-fix.test.mjs` 13/13 PASS
- corr：r1 ＝ `abf52169…`、r2 ＝ `839bc207…`（完整值见收据）
