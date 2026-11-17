# G1 第三轮真机取证——store=0 表象推翻与 P0-B 根因链锁定（2026-11-17）

> **真机取证集成文档 / LIVE FORENSICS INTEGRATION（第三轮）**：本文机械集成 G1 第三轮（付费第 3 单轮）P0-B 受控真机取证的脱敏证据与结论。本文档写入为**纯文档操作**：不触发任何请求、不启动服务、不改源码、不改生产配置、**未 push、未合并 main**。
> **脱敏声明**：全文仅含脱敏证据与结论，未写入、未打印、未提交任何**密钥 / auth.json / token / cookie / prompt 或正文原文**。所有 response id / call id 仅保留必要截断形态（如 `resp_059d0195…`、`resp_mgws_ec788f15…`、`call_TPetw…`）；corr 为诊断关联哈希串，不含凭据。凭据相关仅做哈希比对（HASH_MATCH），从不记录值、从不读取正文。
> **被测树**：worktree `.agents/worktrees/g1-p7-structdiag`，git 实测 HEAD `55434b7`（补丁⑧，parent `ec37d4b`=补丁⑦）。**状态枚举**统一为 `PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；mock 不得记为真实通过。
> 共享 docs 分支：`docs/modelgate-deep-research-live-e2e-20261116`；起始 HEAD `b1a93d6`（第二轮落盘提交）。

---

## 1. 摘要

第三轮（付费第 3 单轮）first-party 形态下 **400 真机复现**，并据此推翻第二轮"store=0"的表述、把 P0-B 根因链进一步锁定：

- **推翻"store=0"表述**：本轮 `store=1` 仍复现 400。第二轮观测的 `store=0` 是表象，不是稳定根因；两轮 `store=0`（第二轮）与 `store=1`（第三轮）都出现 400，故 **store 计数不构成稳定根因**。
- **根因链锁定**（强度：强）：续轮响应体空 / 无 id → 真实 50hex id 从不登记 → WS 桥合成 id（`resp_mgws_` 前缀）与 codex 续轮帧真实 50hex id 不一致 → 重建 `restored=0` / `continuation_state_missing` → 降级 → 孤儿 `function_call_output` → 400。
- **§3.7 H1/H2 二分不完备**：在 JSON / WS 桥路径下，A 点 `applyevent` 与 B 点 `sinkattach` 的表观签名均为**按构造（by construction）**出现，不构成独立因果证据，不能据此宣布 H2 证实。

## 2. 被测树与开关

| 项 | 值 |
| --- | --- |
| worktree | `.agents/worktrees/g1-p7-structdiag` |
| HEAD（git 实测） | `55434b7`（补丁⑧，parent `ec37d4b`=补丁⑦） |
| first-party 形态 | `model_provider=openai` + `openai_base_url=http://127.0.0.1:18790`（等价生产 8787，仅换端口） |
| 订阅形态 | local 订阅（`local_codex_auth`）；上游 target=`chatgpt.com/backend-api/codex/responses` |
| 模型核验 | `gpt-6-luna`，请求级核验通过（仅该 GPT 型号；未自动切换其他型号） |
| 诊断开关 | 仅本轮取证期开启；取证后关闭（详见 §9） |
| 隔离端口 | 18790（生产 8787 / systemd 未触碰） |
| 全程纪律 | 未读 / 未打印 / 未提交任何凭据正文（只哈希）；client auth.json 仅字节复制、退出即删 |

## 3. 400 复现（PASS_REAL）

- 形态：third paid round，first-party `openai` provider、base_url 指向隔离网关；付费第 3 单轮。
- 结果：codex `exit=1`；`turn.failed`，400 = `No tool call found for function call output`（孤儿工具输出）——**P0-B 400 原样复现**。
- call_id（截断）：`call_TPetw…`。
- 计数：`stats.json` requests 4→5（Δ+1）、errors 1→2（Δ+1）、`retries=0`；日志内 2 次上游出站（一 200、一 400）。
- token：113,269。
- 时间窗：17:29:25 → 17:30:48 +0800。

## 4. A/B 点证据（corr=`62534be2cb0b286c`，同串）

**A 点（applyevent ×1）**：`kind=json branch=json official=1 n=1 hasRespId=0 idLevel=opaque hasFnCall=0 hasFnCallOut=0`。

- `src/index.js:2316`：JSON 分支的 `applyevent` 为**无条件发出（by construction，offOn）**——该行的出现不依赖任何上游事件被正确解析，因此"A 点出现"不能作为"事件已进入分发"的真实证据。
- `hasFnCall=0` 与本轮**实际发生了 function_call** 相矛盾，进一步佐证 A 点日志行是按构造产出、未反映真实事件流。

**B 点（sinkattach ×1）**：`branch=json official=1 attached=0 continuation=1 sinkrecv=0`。

- `src/index.js:2318`：硬编码 `attached=false`（by construction）。`attached=0` 不构成"该请求未挂 captureSink"的独立因果证据。

**结论**：H2 的表观签名（`attached=0`）虽然存在，但 A/B 两点的日志行均为按构造产出，**不能宣布 H2 证实**。H2 表观签名与真实因果机制脱钩。

## 5. P5 / P1–P4 证据（同 corr=`62534be2cb0b286c`）

**续轮请求（400 前）200 响应首帧（响应体空 / 无 id 的直接证据）**：`firstframe kind=json keys=空 idLevel=opaque idH=none status=none`，`entry` 的 `ct` 空。顶层键名为空、id 无法量测，直接证明续轮响应体空 / 无 id。

**全序列（按时间序）**：`entry200 → firstframe空 → terminal200 → applyevent → sinkattach → degraded → entry400 → terminal400`。

| 点 | 实测 | 结论 |
| --- | --- | --- |
| P1 `recorded` | 未出现——`recordContinuation` 守卫（`src/index.js:2321`）未过，从未登记 | **NOT_OBSERVED** |
| P2 `capture empty` | 未出现（空） | **NOT_OBSERVED** |
| P3 `reconstructed` | OBSERVED：`prev=resp_mgws_ec788f15… restored=0 delta=3` + `point=reconstruct_hit store=1` | **OBSERVED**（命中 WS 桥合成空条目，`restored=0`） |
| P4 `degraded` | OBSERVED：`prev=resp_059d0195…(50hex) store=1` + `point=degraded store=1` | **OBSERVED**（决定性，store=1） |

> P3 的 `prev` 为 WS 桥合成 id（`resp_mgws_` 前缀），P4 的 `prev` 为真实 50hex id（`resp_059d0195…`），两者形态不一致——这是根因链的关键观测（见 §6）。

## 6. 根因链（强度：强）

**证据强度依据**：4 条独立日志行（P3、P4、P5 首帧、A/B 点）+ `src/index.js:2316/2318/2321` 逐行源码追踪 + 两轮（store=0 / store=1）交叉对照。

根因链：

1. **续轮响应体空 / 无 id** → 真实 50hex id 从不登记（P1 NOT_OBSERVED、`src/index.js:2321` 守卫未过；P5 首帧 `keys=空 idLevel=opaque`）。
2. **WS 桥合成 id `resp_mgws_` 与 codex 续轮帧真实 50hex id 不一致** → 重建命中合成空条目、`restored=0` / `continuation_state_missing`（P3 `restored=0`、P4 `continuation_state_missing`，`store=1`）。
3. **降级 → 孤儿 `function_call_output` → 400**（全序列 `degraded → entry400 → terminal400`）。

**两轮交叉对照**：第二轮 `store=0` 与第三轮 `store=1` 同样复现 400。**故 store 计数非稳定根因**；第二轮"store=0 是根因"的表述被推翻，根因在于"响应体空 / 无 id + WS 桥合成 id 与真实 id 不一致"导致的历史重建失败。

## 7. 假说判定

| 假说 | 判定 | 依据 |
| --- | --- | --- |
| **H1**（SSE 信封 / 解析未进 applyEvent） | 不作区分性根因 | A 点 `applyevent` 按构造（by construction）出现，无 SSE 信封的真实证据未被识别；不能据此区分。 |
| **H2**（该分支未挂 captureSink） | 不能宣布证实 | 表观签名（`attached=0`）存在，但 A/B 均按构造产出，因果性被独立评审否定。 |
| **新假说（建议 owner 采纳）** | **强度：强** | §3.7 H1/H2 二分在 JSON / WS 桥路径不完备；真因链如 §6：空体 / 无 id 响应 + WS 桥合成 id 与真实 50hex id 不一致 → 重建 `restored=0` → 降级 → 孤儿输出 → 400。 |

**id 形态冲突**：本轮观测 id 形态为 50hex / 24hex / `mgws` 合成，与 H4 的"官方 56hex id"前提冲突。需 owner 采纳并相应修订契约 / 假说表述（第二轮文档 H4 前提已标注需复核；本轮进一步坐实冲突）。

## 8. 修复方向候选（待 owner 裁决，不自行定案）

以下为候选方向，**仅登记、不实施**：

1. 空体响应按 codex 实际将引用的 id 登记（而非依赖响应体中的 id 字段）。
2. JSON 分支挂 `captureSink`。
3. 重建 `restored=0` 改为 fail-closed（避免以空历史降级后放出孤儿工具输出）。

> 任何修复前须由 owner / A4 复核 §7 的 id 形态冲突与契约表述；禁止为修补 400 伪造原官方 call 或删除工具历史。

## 9. 收尾核验（全部通过）

- 诊断开关：diagn-on 副本**已删**；persisted `gateway.json` **无诊断键**（`diagnosticOfficialStructure` ABSENT=OFF）。
- 进程 / 端口：隔离网关 **PID 1007127** 经 **SIGTERM 优雅退出**；**18790 已释放、无残留进程**。
- 哈希：`config` / `auth` 与 baseline 逐项一致（**HASH_MATCH**）；客户端 `auth.json` 副本（哈希=baseline）**已删**。
- 生产：`model-gateway.service` = **inactive**；**8787 未监听**；**未 push、未改共享生产配置**。
- 全程**未读凭据正文**（只做哈希与字节复制，退出即删）。

## 10. 状态标注（统一枚举）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| P0-B 400 复现（第三轮 first-party） | **PASS_REAL** | 真机、真实请求、真实 400 响应可证；为复现，非全绿。 |
| 根因链 | **强证据** | 4 独立日志行 + 源码逐行追踪 + 两轮交叉对照；store 计数非稳定根因。 |
| §3.7 H1/H2 二分 | **不完备（待修订）** | JSON / WS 桥路径下 A/B 均按构造，H2 不能宣布证实；建议采纳 §7 新假说。 |
| 契约 / 假说修订 | **pending owner** | id 形态 50hex/24hex/mgws 与 H4 56hex 前提冲突，需 owner 裁决。 |
| 修复 | **NOT_RUN** | 方向候选仅登记（§8），未实施。 |
| mock 证据 | 无 | 未以 mock / 离线结果记任何真实通过。 |

> 统一枚举：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`。
