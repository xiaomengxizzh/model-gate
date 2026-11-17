# ModelGate｜G1 P0-B 真机取证（两轮）——400 复现与根因机制锁定（2026-11-17）

> **真机取证集成文档 / LIVE FORENSICS INTEGRATION**：本文机械集成 G1 两轮 P0-B 真机取证（原始取证由 general-purpose-1 执行）的脱敏证据与结论。本文档写入为**纯文档操作**：不触发任何请求、不启动服务、不改源码、不改生产配置、**未 push、未合并 main**。
> **脱敏声明**：全文仅含脱敏证据与结论，未写入、未打印、未提交任何**密钥 / auth.json / token / cookie / prompt 或正文原文**。原始取证仅对凭据做哈希，client auth.json 为字节复制（长度 3995、从未读取内容、退出即删）。标识符仅保留必要截断形态（如 `resp_0f7f…`、`call_hpCbw…`）。
> **被测树**：worktree `.agents/worktrees/g1-p7-structdiag`，HEAD `ec37d4b`（parent `ec9028b`，补丁⑦）。**状态枚举**统一为 `PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；mock 不得记为真实通过。
> 共享 docs 分支：`docs/modelgate-deep-research-live-e2e-20261116`。

## 0. 结论速览

| 项目 | 状态 | 一句话结论 |
| --- | --- | --- |
| P0-B 400 复现 | **PASS_REAL** | 第二轮 first-party 形态真机复现 `400 No tool call found for function call output`。 |
| 第一轮 custom provider 复现 | **FAIL_REAL** | 形态错误（无 `previous_response_id`）未进入续轮，未复现 400。 |
| 根因机制 | 已锁定 | 续轮带 `previous_response_id` → continuation store=0（官方响应**从未登记**）→ 降级未重建历史 → 上游收孤儿 `function_call_output` → 400。 |
| H1–H4 唯一区分 | **NOT_RUN / BLOCKED（待定）** | 单轮内 H1/H2 仅 PARTIAL/CONSISTENT，决定性 P1/P2 行缺失，不强行归因。 |

---

## 1. 摘要

两轮 **single-turn（严格单轮付费请求）** 真机取证：

- **第一轮**：custom provider 形态，`model_provider="modelgate"` + codex 0.167 `history_mode=paginated`，每轮发全量历史、无 `previous_response_id` → P1–P4 整体未执行、**未复现 400**（记 `FAIL_REAL`：真机执行但目标未出现，且形态错误）。3 次出站全部 HTTP 200。
- **第二轮**：first-party 形态，`model_provider="openai"` + `openai_base_url="http://127.0.0.1:18790"`（等价生产 8787，仅换端口）→ **成功复现 P0-B 400**（记 `PASS_REAL` 复现，非全绿；H1–H4 唯一区分仍未定）。codex `exit=1`，`turn.failed`。
- **根因机制锁定**：`continuation store=0`——官方响应**从未登记**（不是"登记后 lookup 失败"）→ 续轮降级时未重建历史 → 上游收到孤儿 `function_call_output` → 400。该形态与 G0 已核实的生产形态一致。

## 2. 被测树与开关

| 项 | 值 |
| --- | --- |
| worktree | `.agents/worktrees/g1-p7-structdiag` |
| HEAD | `ec37d4b`（parent `ec9028b`，补丁⑦ P1–P5 结构诊断） |
| 诊断开关 | `server.diagnosticOfficialStructure=true`，**仅取证期开启**；取证后 persisted `gateway.json` 的 server 键为 `[host,port,logFile]`，`diagnosticOfficialStructure` **ABSENT(=OFF)** |
| 隔离端口 | 18790（生产 8787/systemd/CC Switch 未触碰） |
| 模型核验 | `gpt-6-luna`，请求级核验通过（stats `byModel` 仅 `gpt-6-luna`） |
| 订阅形态 | local 订阅（`local_codex_auth`）；上游 target=`chatgpt.com/backend-api/codex/responses` |
| 全程纪律 | 未读 / 未打印 / 未提交任何凭据正文（只哈希）；未改共享生产配置 |

## 3. 第一轮（custom provider，`FAIL_REAL` 未复现）

- 形态：`model_provider="modelgate"`（自定义 provider）+ codex 0.167 `history_mode=paginated`，每轮发全量历史、**无 `previous_response_id`**。
- 结果：P1–P4 整体未执行、**无 400、无 `No tool call found for function call output`**。3 次出站全部 HTTP 200（`gateway_subscription` target=`chatgpt.com/backend-api/codex/responses`）。
- 计数：`stats.json` requests 0→3，errors=0，confirmed=0，retries=0。
- Codex 侧：`exit=0`；2 次真实 shell 工具调用（exit 0 each）+ 收尾 agent_message；input_tokens=57692 / cached=41728 / output=299。
- 时间窗：16:48:50 → 16:49:19 +0800（约 29s）。
- id 形态：`response_id=other50`（50hex）、`call_id=other24`；非旧假设的 56hex 官方 / 32hex Go。
- corr 串线：`02dd63ce38967a1f`（3 行同串）。
- 证据备份：`round1-stdout.log`、`round1-stats.json`（见 §9）。

> 第一轮为**形态错误**导致的未复现（缺 `previous_response_id`，续轮块整体跳过），不构成 P0-B 已修复的证据。

## 4. 第二轮（first-party，`PASS_REAL` 复现）

- 形态（唯一变量）：`model_provider="openai"` + `openai_base_url="http://127.0.0.1:18790"`（first-party 标准 provider，base_url 指向隔离网关；**等价生产 `openai_base_url=8787`，仅换端口**）。其余严格不变。
- 结果：codex 0.167.0，`exit=1`；`turn.failed`，error =
  `400 {"message":"No tool call found for function call output with call_id call_hpCbw…","type":"invalid_request_error","param":"input"}`
  —— **P0-B 400 原样复现**。
- 链路：1 次真实 shell `function_call`（`call_hpCbw…`，item.type=function_call）+ 1 条同 id 的 `function_call_output` → 续轮时上游 400。
- 时间窗：16:59:28 → 17:00:30 +0800（约 62s）；上游 200 在 16:59:59，degraded 在 17:00:19，上游 400 在 17:00:29。
- 计数：`stats.json` requests 3→4（Δ+1），errors 0→1，retries=0，confirmed=0；日志内 2 次 `gateway_subscription` 出站（一 200、一 400）。
- corr 串线：`70c7635b33947331`（P1–P5 全同串）。

## 5. 决定性差异（续轮触发机制）

- 第一轮（modelgate 自定义 provider）3 次出站**均无** `previous_response_id` → P1–P4 整体未执行 → 无 400。
- 第二轮（first-party openai）出站续轮帧**携带 `previous_response_id`** → **P4 degraded 分支真实进入** → 降级转发 → 上游 400。
- 两轮 rollout 均为 `history_mode=paginated`（first-party 形态仍为 paginated），但 WS 桥续轮帧仍带 `previous_response_id`。
- **结论**：触发续轮的是 **WS 桥续轮帧**，与 rollout 的 `history_mode` 无关。

## 6. P1–P5 证据（第二轮，corr 全同串 `70c7635b33947331`）

| 点 | 实测 | 结论 |
| --- | --- | --- |
| P1 `recorded id=…` | 未出现（无 recorded 行、无 `mgp0.offstruct.store` 行） | **NOT_OBSERVED** |
| P2 `capture empty events=…` | 未出现 | **NOT_OBSERVED** |
| P3 `reconstructed prev=… restored=N delta=M` | 未出现 | **NOT_OBSERVED** |
| P4 `degraded reason=continuation_state_missing` | 出现：`reason=continuation_state_missing prev=resp_0f7f…(50hex) store=0` | **OBSERVED（决定性）** |
| P5 结构诊断 | 6 组齐全（见下） | **OBSERVED** |

P5 原始脱敏行（按时间序，×6 组齐全）：

1. `entry … pid=chatgpt-plan identity=official host=chatgpt.com path=/backend-api/codex/responses status=200 ct=`（content-type 空）
2. `firstframe … kind=json keys= idLevel=opaque idH=none status=none`（顶层键名为空、id 无法量测）
3. `terminal … kind=json type=none status=200 synthetic=0`
4. `store … point=degraded idLevel=other idH=457701f1 store=0`
5. `entry … status=400 ct=`
6. `terminal … kind=http type=http_error status=400 synthetic=0`

同链路非 `mgp0` 前缀但相关的续轮/失败行：

- `[warn] responses continuation degraded reason=continuation_state_missing prev=resp_0f7f…(50hex) store=0`
- `[warn] responses-ws internal POST failed status=400 bodyKeys=error`（即网关 `responses-ws internal POST failed status=400`）

## 7. §3.7 H1–H4 判定（结合 id 形态复核）

**id 形态复核（必须纳入，不机械套旧假设）**：两轮实际观测 `prev=resp_<50hex>`（分类器 level=`other50`）、`response_id=other50`、`call_id=other24`。**不是**旧假设的「56hex 官方／32hex Go」。补丁⑦ `offStructIdLevel` 把它们归入 `other/opaque` 是分类器既有类别的正确行为（非 bug），但意味着 **H4 的「官方 56hex id」前提在订阅后端形态下不成立、需复核**——本轮 prev 为 50hex，不能按 56hex 归类。

| 假说 | 判定 | 依据 |
| --- | --- | --- |
| **H1**（SSE 信封/解析未进 applyEvent） | **PARTIAL/CONSISTENT（非决定性）** | P5 有异常信号（ct 空、`keys=` 空、`idLevel=opaque`）与「信封未识别→事件未进 applyEvent」一致；但决定性 P2（capture empty）缺位，不能坐实。 |
| **H2**（该分支未挂 captureSink） | **PARTIAL/CONSISTENT** | P1 全程无 recorded（store=0，从无登记），P4 `continuation_state_missing store=0` 直接指向「无状态可重建」；但 P5 信封异常，不满足 H2 要求的「信封正常」前提。 |
| **H3**（id 在第三嵌套位置） | **NOT_CONCLUSIVE（偏弱）** | P5 `idLevel=opaque`（id 完全未解析出）+ `keys=` 空 + P1 未登记，属「未解析」而非明确「位置错误」。 |
| **H4**（登记后 lookup 失败） | **NOT_SUPPORTED** | P1 无官方 56hex id 登记、P4 出现但 store=0（说明「从未登记」而非「登记后 lookup 失败」）、P3 缺、P5 无 store 命中时序；且其 56hex id 前提在本订阅形态下不成立。 |

**机制结论（可证事实，非 H1/H4 单独归因）**：续轮帧带 `previous_response_id` → 网关 store=0（`continuation_state_missing`，官方响应**从未登记**）→ 优雅降级未重建历史 → 上游收到孤儿 `function_call_output` → 400 `No tool call found for function call output`。与 G0 已核实的 P0-B 生产故障形态一致。H1/H2 各有部分一致信号，H3 弱、H4 不支持；**单轮内无法在 H1/H2 间给出唯一决定性区分**（决定性 P1/P2 行在 store=0 路径未产出），不强行归因。

## 8. 收尾核验（全部通过）

- 诊断开关：diag-on 配置副本已删；persisted `gateway.json` 的 server 键 = `[host,port,logFile]`，`diagnosticOfficialStructure` **ABSENT(=OFF)**。
- 进程/端口：隔离网关（第一轮 PID 845748、第二轮 PID 887232）经 SIGTERM 优雅退出，background task completed；**18790 已释放、无 `src/index.js` 残留进程**。
- 诊断副本 + client auth 副本**已删除**（client auth.json 为字节复制、长度 3995、从未读取内容）。
- 哈希：`sha256sum ~/.codex/config.toml ~/.codex/auth.json` 与 `baseline-daily.sha256` 逐项一致（**HASH_MATCH**）。
- 生产：`systemctl --user is-active model-gateway.service` = **inactive**；**8787 未监听**；**未 push、未改共享生产配置 / docs worktree**。

## 9. 证据路径（仅记录路径，不记录内容）

- 取证收据：`/tmp/mg-a5-e2e/g1-forensics-receipt-20261117.md`、`/tmp/mg-a5-e2e/g2-forensics-receipt-20261117.md`
- 网关全量日志（P1–P5 全 6 行 + continuation 行）：`/tmp/mg-a5-e2e/modelgate/gateway/stdout.log`
- stats：`/tmp/mg-a5-e2e/modelgate/gateway/stats.json`
- Codex stdout：`/tmp/mg-a5-e2e/g1-codex-stdout.jsonl`、`/tmp/mg-a5-e2e/g2-codex-stdout.jsonl`；stderr：`g1-codex-stderr.log`、`g2-codex-stderr.log`
- 第一轮备份：`/tmp/mg-a5-e2e/modelgate/gateway/round1-stdout.log`、`round1-stats.json`
- rollout jsonl（**只记路径，不记内容**）：
  - 第一轮 `/tmp/mg-a5-e2e/modelgate/cli-home/sessions/2026/11/17/rollout-2026-11-17T16-49-02-01a1e8b2-0083-7d53-b04b-4b40f1925832.jsonl`
  - 第二轮 `/tmp/mg-a5-e2e/modelgate/cli-home2/sessions/2026/11/17/rollout-2026-11-17T16-59-36-01a1e8bb-b06f-7813-b9a2-4145f1317c25.jsonl`
- 时间窗：`g1-request-start.txt` / `g1-request-end.txt`、`g2-request-start.txt` / `g2-request-end.txt`
- 前置/哈希：`g1-precheck.sha256`、`baseline-daily.sha256`

## 10. 状态标注（统一枚举）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| P0-B 400 复现（第二轮 first-party） | **PASS_REAL** | 真机、真实请求、真实 400 响应可证；为复现，非全绿。 |
| 第一轮 custom provider 复现 | **FAIL_REAL** | 真机执行但形态错误、目标 400 未出现。 |
| H1–H4 唯一区分 | **NOT_RUN / BLOCKED（待定）** | 单轮内 H1/H2 仅 PARTIAL/CONSISTENT，决定性 P1/P2 行缺失；需 owner/A4 复核 56hex 前提或二次受控取证。 |
| mock 证据 | 无 | 未以 mock / 离线结果记任何真实通过。 |
