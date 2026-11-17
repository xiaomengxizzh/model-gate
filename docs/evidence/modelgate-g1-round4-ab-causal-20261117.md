# G1 第四轮受控 A/B/C 因果取证——降级转发证实为必要传导环节（2026-11-17）

> **真机取证集成文档 / LIVE FORENSICS INTEGRATION（第四轮·受控 A/B/C 因果实验）**：本文机械集成 G1 第四轮（付费第 3 单轮）受控因果取证的脱敏证据与结论。每轮仅开启一个因果实验开关，每轮付费一单轮，baseline 全 OFF 复用第二 / 三轮数据（不重跑）。本文档写入为**纯文档操作**：不触发任何请求、不启动服务、不改源码、不改生产配置、**未 push、未合并 main**。
> **脱敏声明**：全文仅含脱敏证据与结论，未写入、未打印、未提交任何**密钥 / auth.json / token / cookie / prompt 或正文原文**。所有 response id / call id 仅保留必要截断形态（如 `call_6YHEbXy…`、`call_UX78TlG…`）；corr 为诊断关联哈希串，不含凭据。凭据相关仅做哈希比对（HASH_MATCH），从不记录值、从不读取正文。
> **被测树**：worktree `.agents/worktrees/g1-p7-structdiag`，git 实测 HEAD `930d0ae`（补丁⑨，parent `55434b7`=补丁⑧）。**状态枚举**统一为 `PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；mock 不得记为真实通过。
> 共享 docs 分支：`docs/modelgate-deep-research-live-e2e-20261116`；起始 HEAD `f91eb68`（第三轮落盘提交）。

---

## 1. 摘要

第四轮（付费 3 单轮，每轮仅开一个因果实验开关）first-party 形态下完成受控因果取证，**把第三轮锁定的根因链进一步推进为逐环节的因果判定**：

- **受控设计**：单轮 A 仅开 `idRegisterFromClientPrev=true`；单轮 B 仅开 `bridgeIdUseRealPrev=true`（开机即开）；单轮 C 仅开 `reconstructFailClosedOnRestoredZero=true`；每轮关闭上一轮开关。baseline 全 OFF 复用第二 / 三轮（不重跑）。
- **核心结论（强）**：环节③**降级转发被证实为上游 400 的必要传导环节**——单轮 C 把降级改为 fail-closed 后，400 从"不可诊断的上游孤儿 output 400"决定性地变为"网关 typed 400"，且携带孤儿 output 的上游 POST 不再发出（2→1）。
- **环节①②各自单独不足**：单轮 A 否证①的充分性（登记合成 opaque id 错 key，400 未消失）；单轮 B ②机制不可达（无真实 id 可配对，开关形同虚设）。
- **更深层根因**：①②均为同一深层根因"**续轮响应体无真实 response id**"的下游表征，单独修补任一环节均无效。

## 2. 被测树与形态

| 项 | 值 |
| --- | --- |
| worktree | `.agents/worktrees/g1-p7-structdiag` |
| HEAD（git 实测） | `930d0ae`（补丁⑨，parent `55434b7`=补丁⑧） |
| first-party 形态 | `model_provider=openai` + `openai_base_url=http://127.0.0.1:18790`（等价生产 8787，仅换端口） |
| 订阅形态 | local 订阅；上游 target=`chatgpt.com/backend-api/codex/responses` |
| 模型核验 | `gpt-6-luna`，请求级核验通过（仅该 GPT 型号；未自动切换其他型号） |
| 续轮触发 | shell 工具触发父工具 → 结果续轮 |
| 受控开关 | 每轮仅开一个、关上一轮；取证后全部删除（详见 §8） |
| 隔离端口 | 18790（生产 8787 / systemd 未触碰） |
| 全程纪律 | 未读 / 未打印 / 未提交任何凭据正文（只哈希）；client auth.json 仅字节复制、退出即删 |

## 3. 单轮 A（仅 `idRegisterFromClientPrev=true`）

- **状态**：PASS_REAL，400 复现未消失；corr=`02d1fe0a557802ee`。
- **信号**：
  - `reconstruct_hit`：`restored=0`、`n=0`、`idLevel=opaque`。
  - `register_from_prev`：`recorded=1`、`idLevel=opaque`——登记的是**合成 opaque id（错 key）**，非预期 `other`。
  - `degraded`：`continuation_state_missing`、`idLevel=other`。
- **400 来源**：上游孤儿 output（`call_6YHEbXy…`）。
- **出站 / 退出 / token**：2 次上游出站、`exit=1`、tokens 113,271。
- **判定**：环节①（从客户端 prev 登记 id）单独 **NON-充分（中-强）**——即使强制登记，登记的仍是合成 opaque id 且 key 错误，重建 `restored=0`，400 原样复现。

## 4. 单轮 B（仅 `bridgeIdUseRealPrev=true`，开机即开）

- **状态**：PASS_REAL，400 复现未消失；corr=`efe5039273388d17`。
- **信号**：
  - `reconstruct_hit`：`restored=0`。
  - `degraded`：`continuation_state_missing`。
  - `alias_link` / `bridge_alias`：**完全缺位**。
- **400 来源**：上游孤儿 output（`call_UX78TlG…`）。
- **判定**：环节②（桥接使用真实 prev id）**机制不可达（强）**——别名建立点（`src/index.js:2383` / `:2104` / `:2142` / `:2595` / `:2606`）要求**当前 POST 响应带真实 response id**，但续轮响应体空 / 无 id，无真实 id 可配对，故开关形同虚设、`alias_link` 完全缺位。

## 5. 单轮 C（仅 `reconstructFailClosedOnRestoredZero=true`）

- **状态**：PASS_REAL，**故障性质决定性改变**；corr=`d199246ca2141082`。
- **信号**：
  - `reconstruct_hit`：`restored=0`。
  - `fail_closed`：`reason=continuation_state_missing`、`idLevel=other`、`restored=0`。
- **400 来源改变**：从"上游孤儿 output"变为**网关 typed 400**——`message="continuation reconstruct failed (causal experiment fail-closed)"`、`code=causal_reconstruct_fail_closed`、`type=causal_experiment`。
- **出站改变**：上游出站 **2→1**（携带孤儿 output 的那个 POST 未发出）。
- **判定**：环节③**降级转发为上游 400 的必要传导环节（强）**——阻断降级路径后，孤儿 output 不再抵达上游，上游 400 消失、替换为可诊断的网关 typed 400；同时证实重建缺失（`restored=0` / `continuation_state_missing`）为源头。

## 6. 综合根因链（强度：强，A/B/C + 第三轮交叉）

**证据强度依据**：三轮单变量受控实验（A 否证充分性、B 证明机制不可达、C 证明必要性）+ 第三轮已锁定的根因链交叉印证 + 逐行源码追踪（别名建立点 `:2383/:2104/:2142/:2595/:2606`）。

根因链：

1. **续轮响应体无真实 response id**（源头）。
2. → **合成 id ≠ 真实 id（A：登记合成 opaque id 错 key）** / **真实 id 从不登记（B：无真实 id 可配对）**。
3. → **重建 `restored=0` 或 `continuation_state_missing`**（A/B/C 三轮一致出现）。
4. → **降级转发**（C：阻断后上游 400 消失，证实为必要传导环节）。
5. → **孤儿 `function_call_output`**（A/B：`call_6YHEbXy…` / `call_UX78TlG…`）。
6. → **上游 400**（A/B 原样复现；C 被 typed 400 取代）。

**结论**：①②是深层根因"续轮响应体无真实 response id"的**下游表征**，单独修补任一环节均无效；只有③（降级转发）被实验证实为上游 400 的必要传导环节。

## 7. 修复方向建议（供 owner 单独批准，本轮未改修复）

仅登记候选方向，**本轮不实施任何修复**：

1. **止损（C 已验证机理）**：`reconstruct` 未命中 / `restored=0` 时改为 fail-closed，返回明确 typed 错误，替代不可诊断的上游 400。注意：此举**不恢复连续性**，仅改善可诊断性。
2. **治本**：让 WS 桥在工具调用响应阶段登记 codex 下一轮真正会引用的**真实 id**，并让 `reconstruct` 真正恢复工具调用历史（当前命中合成空条目、`restored=0`）。
3. **源头**：消除合成 `resp_mgws_` id 与真实 50hex id 在续轮帧中的不一致。

> 任何修复前须由 owner 单独批准；禁止为修补 400 伪造原官方 call 或删除工具历史。

## 8. 收尾核验（全部通过）

- **配置副本**：三份 experimental config 副本**已删**；persisted `gateway.json` server keys=`[host, port, logFile]`，`g1CausalExperiment` / `diagnosticOfficialStructure` 均 **ABSENT**。
- **进程 / 端口**：三轮网关经 **SIGTERM 优雅退出**；**18790 已释放、无残留进程**。
- **哈希**：`config` / `auth` 逐项 **HASH_MATCH**；客户端 `auth.json` 副本**退出即删**。
- **生产**：`model-gateway.service` = **inactive**；**8787 未监听**；**未 push、未合并 main、未改共享或 docs worktree 以外任何生产配置**。
- **纪律**：全程**未读 / 未打印密钥 / Cookie / Token / auth.json 正文**、未导正文 / prompt、未碰生产、未 push；**未发第五单轮、未重跑全 OFF baseline**。
- **worktree**：`.agents/worktrees/g1-p7-structdiag` 干净、HEAD=`930d0ae`。

## 9. 状态标注（统一枚举）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 单轮 A（仅 idRegisterFromClientPrev） | **PASS_REAL** | 400 原样复现；①单独 NON-充分（中-强）。 |
| 单轮 B（仅 bridgeIdUseRealPrev） | **PASS_REAL** | 400 原样复现；②机制不可达（强）。 |
| 单轮 C（仅 reconstructFailClosedOnRestoredZero） | **PASS_REAL** | 故障性质决定性改变（上游 400→typed 400）；③必要传导环节证实（强）。 |
| 因果判定 | **强证据** | ③证实 / ①②单独不足；A/B/C 三轮单变量受控 + 第三轮交叉。 |
| 综合根因链 | **强证据** | 续轮响应体无真实 id 为更深根因；①②为其下游表征。 |
| 修复 | **pending owner** | 三方向候选仅登记（§7），本轮未实施，需 owner 单独批准。 |
| baseline 全 OFF | **NOT_RUN（复用）** | 复用第二 / 三轮数据，本轮未重跑。 |
| 第五单轮 | **NOT_RUN** | 未发起。 |
| mock 证据 | 无 | 未以 mock / 离线结果记任何真实通过。 |

> 统一枚举：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`。
