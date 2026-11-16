# ModelGate V3｜Codex 原生压缩与同子恢复调查（MG-FIX-P0-02 / G4，2026-11-16）

> 文档类型：**只读根因调查 + 离线可复现证据**。不是「压缩已通过」「同子恢复已实现」「可发布」的证明。
> 工作分支：`fix/mg-a2-compaction`（基于 `9a371d3`），独立 worktree，未触碰生产、真实 `~/.codex`、部署服务或真实凭据。
> 本轮**零付费模型调用、零下载、零对真实上游的 `codex` 调用**。所有结论区分「实测故障 / 静态源码结论 / 客户端限制 / 待授权 BLOCKED」。
> 契约边界（任务书 §0）：压缩必须由 Codex 自身实现与触发；网关绝不 summarize、截断历史、生成摘要缓存、补造加密 `compaction` 产物、调大窗口或关闭压缩冒充通过。`history/export` 是所有者书面批准的显式历史迁移导出例外，**严禁**与压缩或模型推理混用。

## 0. 一句话结论

冻结树三次未触发 `context compacted`、两次 resume 新建 `childId`，**根因都在 Codex 客户端侧**（0.167.x 的自动压缩触发条件与 resume 子线程复用策略），**不是网关协议缺陷**。网关的压缩协议保真与能力声明已正确且离线/回环可复核；在本范围内**不存在可安全修复的网关侧缺陷**能改变这两个客户端行为。真实通过项（真实 Go + `gpt-6-luna` 父代理原生压缩、压缩后同子追派、resume 复用同一 childId）因缺付费额度与长会话实跑授权，**全部 BLOCKED**，不得宣称通过。

---

## 1. 证据基线交叉核对

| 来源 | SHA / 版本 | 与本调查的关系 |
| --- | --- | --- |
| 本工作分支基线 | `9a371d3` | 唯一被本调查读取/修改的源码树 |
| V2 冻结目标 | `12cf5d9` | 发布裁决的 `codeEquivalentFreeze` 目标 |
| 冻结树真机复核树 | `1a527c6` | `aggregation-v2-freeze-rerun` 的采集树；三次压缩未触发、两次 resume 新建 childId |
| 中间树（压缩成功来源） | `3116459` | 三条 `PASS_REAL` 压缩证据的真实采集树；与冻结树行为不一致 |
| 真实客户端回环实验 | 树见 `aggregation-v2-native-compaction-real-client` | `PASS_MOCK`：真实 Codex CLI 二进制 + 回环 mock 上游 |
| 客户端版本 | CLI `codex-cli 0.167.0` / Desktop 捆绑 `0.167.0-alpha.3.2`（Desktop `26.1103.32239`） | 所有客户端限制结论的版本锚点 |

三份必读证据的事实要点：

- `aggregation-v2-freeze-rerun-2026-11-15.md` §2：冻结树 `auto_compact_token_limit` 取 32000 / 32000（更大 prompt）/ 24000 三次，均**未**出现 `context compacted`；同时工具执行与「复述第一条命令输出 `FREEZE_BASE_OK`」正常；三条压缩真机证据仍来自 `3116459`。同树两次 resume 均 `spawn_agent` 新建子线程（`01a1deca-…`），未复用被中断的 `01a1dec9-…`。
- `aggregation-v2-native-compaction-real-client-2026-11-15.md` §2：`remote_compaction="unsupported"` 时真实 Codex 二进制自行发出以 `You are performing a CONTEXT CHECKPOINT COMPACTION.` 开头的本地压缩提示，网关**逐字**转发；无 `type:"compaction"` 输入项、无 `unsupported_input_item`、无网关摘要。`remote_compaction="v2"` 时请求侧发 `{"type":"compaction_trigger"}` 并要求上游回一个带 `encrypted_content` 的 `compaction` 输出项——Go/DeepSeek 无法承接。状态为 `PASS_MOCK`，**不是** `PASS_REAL`。
- `aggregation-v2-release-verdict-2026-11-15.md` §1/§2：R006 四项（`native-compaction`、`post-compact-followup`、`context-proof`、`resume`）为 `partial`，沿用旧树证据；最终冻结树无真实重测；审批为空、PR #7 仍 Draft。

---

## 2. 根因矩阵（三分法：客户端限制 / 网关可修 / BLOCKED）

### 2.1 三次未触发原生压缩

| 维度 | 结论 | 具体依据 |
| --- | --- | --- |
| **(a) 真正的客户端能力/版本限制** | **主因。** 自动压缩由 Codex 客户端根据模型级 `auto_compact_token_limit` 与**实际 token 增长**触发，不是网关可下发的一次性命令。`codex-cli 0.167.0` / Desktop `0.167.0-alpha.3.2` 上：`v2-handoff` §7 实测 20k–32k 阈值在短会话里**不触发**，4k 阈值会循环压缩；需要 6–10 轮长会话自然增长才可靠。冻结树三次用 32000/24000 的短夹具，未到客户端真实阈值 → 无 `context compacted`。`3116459` 曾出现 2–3 次压缩，说明**同一能力在客户端是可触发的，阈值/会话长度才是变量**。 | `freeze-rerun` §2；`v2-handoff` §P0-2、§5.4、§7；`interop.js:435-445`（本地压缩由 `core/src/compact.rs` 发起） |
| **(b) 网关协议保真缺口（可安全离线修复）** | **未发现导致「不触发」的网关缺陷。** 压缩协议路径已正确：① `config.js:1107-1143` 在 managed provider 写 `remote_compaction="unsupported"`，迫使 Codex 走本地压缩；② `catalog.js:99-113,744-772` 不把 `remote_compaction` 塞进 ModelInfo（它是 provider 级能力），并校验 `auto_compact_token_limit <= contextWindow`（`catalog.js:717-721`）；③ `interop.js:932-966,1023-1039` 对压缩项做 preserve/reject/drop typed 闸门，不伪造密文。回环实验已证明这条路在真实客户端成立。**条件性缺口（非本 worktree 文件、交主代理核验）**：要*接受*本地压缩产生的 `context_compaction` 标记，路由必须显式声明 `codex.history.compaction='preserve'` + `codex.nativeCompaction='codex-owned-local'`；而 `src/index.js:1650-1651` 的默认路由能力是 `compaction:'reject'`。若生产聚合 Go 模型的 catalog 条目未覆盖这两项，真实压缩发生后标记会被 typed 拒绝（`unsupported_input_item`），导致 `post-compact-followup` 失败——这是**配置声明问题，非协议实现缺陷**，且需读取生产 catalog 才能确认（本轮越界，未做）。 | `interop.js:932-966,1023-1039`；`config.js:1107-1143`；`catalog.js:744-772`；`src/index.js:1648-1666,943-944` |
| **(c) 仅真实付费可证（BLOCKED）** | 证明真实 Go DeepSeek 经长会话确实触发 `context compacted`、压缩后工具/复述 marker 通过、采集真实 SHA 与回执，必须用真实 Go + `gpt-6-luna` 父代理长会话并花额度。无授权 → BLOCKED。 | 任务书 §0 约束 1/4；`native-compaction-real-client` §4 |

### 2.2 两次 resume 新建 childId（未复用原子）

| 维度 | 结论 | 具体依据 |
| --- | --- | --- |
| **(a) 真正的客户端能力/版本限制** | **主因。** `resume` 是否复用被中断的子线程，由 Codex harness/CLI 决定；网关在协议层只看到 collaboration 工具项（`spawn_agent` / `send_input` / `followup_task`）与 `call_id`，**从不生成、持有或映射 `childId`/thread 身份**（全仓 `src/` 无 childId 生成/存储逻辑）。`v2-handoff` §5 明示：`resume` **不保证**复用同一 child thread，冻结树两次都新建子代理；「若产品要同子恢复，需要客户端侧方案，不能用网关代码硬造」。`3116459` 曾有一次 resume 后工具结果落回原子 rollout，与冻结树不一致 → **客户端行为跨构建不稳定，不能作为产品保证**。 | `freeze-rerun` §2；`v2-handoff` §5、§P0-2；`interop.js:479-480`；`native-capabilities.js:45-52,74-87` |
| **(b) 网关协议保真缺口（可安全离线修复）** | **无。** 网关的 `native-cells.js` 只保证「一个 cell 唯一终态、终态后拒绝重复派单、预算/槽位仅终态释放」（`replayCodeMode` / `createCellLedger`），与子身份复用正交，且已离线证明。补「同子恢复」只能在网关自造线程映射——这直接违反任务书 §0 约束 2/3（禁止第二套调度），因此**不是可修项，而是不可越界项**。 | `native-cells.js:168-345,347-416`；`native-capabilities.js:74-87` |
| **(c) 仅真实付费可证（BLOCKED）** | 证明同一子 ID 在压缩前/中断/恢复后不变、工具与上下文连续、无重复派单，需真实长会话采集 before/after childId、rollout 与工具证据 + 付费额度。若客户端确实无法保证，需呈报不可达证据与客户端侧可选路线，由所有者裁决。 | 任务书 §0 约束 1/4、MG-FIX-P0-02 验收；`v2-handoff` §5 |

---

## 3. 不自建压缩的前提下，离线/回环可实现且已实现的东西

以下是「压缩由 Codex 自己执行、网关只做协议保真/能力闸门/配置适配」路径上，**可在零额度下复核并已锁定为真**的不变量：

1. **provider 能力声明**：`remote_compaction` 枚举只接受 `unsupported | v2`（`config.js:29`，经 0.167.0-alpha.3.2 serde 实测）；managed provider 默认写 `unsupported` 到 `model_providers.modelgate.capabilities.remote_compaction`（`config.js:1122-1142`）。内置 `openai` 是 reserved ID，不能承载该声明（`config.js:20-22`）。
2. **能力归属投影**：`codex.nativeCompaction ∈ {codex-owned-local, codex-owned-remote, unsupported}`；`nativeCompactionCapability()` 对未声明返回 `null`（`interop.js:457-466`）。
3. **压缩项 typed 闸门**（`interop.js:932-966`）：
   - `history.compaction='preserve'` + 本地 `context_compaction` 标记（无密文）→ 原样透传；
   - `preserve` + 密文 `compaction` 且 `codex-owned-remote` → 原样透传；
   - `preserve` + 密文 `compaction` 且 `codex-owned-local` → `native_compaction_route_mismatch`；
   - `preserve` + 密文且未声明/`unsupported` → `native_compaction_route_not_ready`；
   - `compaction` 缺非空 `encrypted_content` → `native_compaction_item_malformed`；
   - `drop` → `compaction_dropped`/`context_compaction_marker_dropped` lossy；`reject`（默认）→ `unsupported_input_item`。
4. **触发标记闸门**：`{"type":"compaction_trigger"}` 只在 `codex-owned-remote` 路由透传，本地路径 typed 拒绝（`interop.js:1023-1031`）。
5. **无网关侧总结**：`CONTEXT CHECKPOINT COMPACTION` 提示逐字透传，`interop.js` 不生成 `encrypted_content` 字面量/压缩响应对象（`agg-v2-real-client-compaction.test.mjs:84-88` 静态锁定）。
6. **同子/中断的网关不变量**：cell 账本唯一终态、终态后重复 wait 为 `code_mode_cell_duplicate_dispatch`、未让出 cell 的 wait 被拒绝，`replayCodeMode` 发送前 fail-closed（`native-cells.js`）。
7. **诚实能力记账**：`nativeCapabilityInventory()` 把真实 Luna 与 Desktop GUI 标 `BLOCKED`，V2 追派/中断标 `NOT_ACCEPTED`，`agentTeamComplete=false`（`native-capabilities.js`）。

本轮新增离线套件 `scripts/test/offline/agg-v2-compaction-resume-investigation.test.mjs` 覆盖以上 2/3/4/5/6/7 的关键不变量（见 §5）。

---

## 4. 明确的 Codex 客户端版本限制（产品边界，非网关可改）

| # | 限制 | 版本锚点 / 证据 |
| --- | --- | --- |
| L1 | 自动压缩由客户端按模型级 `auto_compact_token_limit` + 真实 token 增长触发；20k–32k 阈值在短会话不触发，4k 会循环压缩，无「立即压缩」开关。 | `codex-cli 0.167.0` / Desktop `0.167.0-alpha.3.2`；`v2-handoff` §7 |
| L2 | 本地压缩产物是**明文** `CONTEXT CHECKPOINT COMPACTION` 提示 + `context_compaction` 标记（密文可空）；远程压缩产物是带非空 `encrypted_content` 的 `compaction`，请求侧标记为 `compaction_trigger`。 | `interop.js:435-445,588-590`；真实客户端回环实验 §2 |
| L3 | `remote_compaction` 是 **provider 级**能力（`RemoteCompactionSupport`），枚举仅 `unsupported | v2`；`v2` 要求上游返回恰好一个 `compaction` 密文项，Go/DeepSeek 无法承接 → 产品路径只能 `unsupported`（客户端本地压缩）。 | `config.js:24-29`；`catalog.js:99-113`；真实客户端回环实验 §2.2 |
| L4 | `[model_providers.openai*]` 是 reserved built-in ID，0.167.x 加载即失败；provider 能力只能写在自有 provider（ModelGate `modelgate`）。 | `config.js:6-7,20-22`；Desktop 压缩实验 |
| L5 | `resume` 是否复用原子线程由客户端决定，**跨构建不稳定**，冻结树两次均新建 childId；网关无法感知/强制 childId。 | `v2-handoff` §5；`freeze-rerun` §2 |
| L6 | `auto_compact_token_limit` 必须 `<= contextWindow`，否则压缩永不触发（目录构建会拒绝）。 | `catalog.js:717-721` |

---

## 5. 可复现离线 / mock 流程（零额度，本工作树可跑）

```bash
cd /home/xiaomengxizi/ai/workplace/idproject/model-gateway/.agents/worktrees/fix-mg-a2-compaction

# 本调查新增：压缩/同子恢复协议不变量（纯离线）
node --test scripts/test/offline/agg-v2-compaction-resume-investigation.test.mjs

# 既有、与压缩相关的真实客户端回放 / 协议 / 配置门禁（均离线 mock）
node --test scripts/test/offline/agg-v2-real-client-compaction.test.mjs
node --test scripts/test/offline/agg-v2-compaction-protocol.test.mjs
node --test scripts/test/offline/agg-v2-desktop-compaction.test.mjs
node --test scripts/test/offline/agg-native-capabilities.test.mjs
node --test scripts/test/offline/agg-native-wait.test.mjs
node --test scripts/test/offline/agg-native-invariants.test.mjs
```

历史真实客户端回环实验（**仅作背景，不在本轮重跑**）步骤见 `aggregation-v2-native-compaction-real-client-2026-11-15.md` §4：隔离 `CODEX_HOME` + 回环 mock 上游 + `codex exec` / `codex exec resume --last`；状态为 `PASS_MOCK`。本轮不执行真实客户端、不联网、不读写真实配置。

---

## 6. 真实验收项（与离线结论严格分离，全部 BLOCKED）

> 以下**没有一项在本轮通过**。列在此处是为了明确「要关闭 MG-FIX-P0-02 还缺什么」，不是通过声明。

| ID | 真实验收项 | 状态 | 阻断原因 |
| --- | --- | --- | --- |
| RA-1 | 最终冻结树上，真实 Go `deepseek-v4.1-flash` 长会话触发 `context compacted` | **BLOCKED** | 需真实 Go 凭据/额度 + 长会话授权；短夹具阈值不触发（L1） |
| RA-2 | 压缩由 Codex 执行，压缩后 `exec_command` 仍可执行 | **BLOCKED** | 同 RA-1；需真实工具往返 |
| RA-3 | 压缩后能复述压缩前 marker（`context-proof`） | **BLOCKED** | 同 RA-1；需真实长会话 + marker |
| RA-4 | `post-compact-followup`：压缩后同一子代理继续新任务 | **BLOCKED** | 同 RA-1 + 生产 catalog 的 `history.compaction='preserve'` 声明待主代理核验（§2.1(b)） |
| RA-5 | resume 复用**同一 childId**（中断→恢复→工具/上下文连续、无重复派单） | **BLOCKED** | 客户端 resume 子线程复用不稳定（L5）；需所有者技术裁决客户端侧方案；无网关安全修法 |
| RA-6 | 真实 `gpt-6-luna` 父代理 + Go 子代理的上述全链路 | **BLOCKED** | 只允许 `gpt-6-luna` 且需付费授权；本轮零付费调用 |

即使 RA-1..RA-6 全部补齐，仍需 A5 独立审计、冻结门禁与所有者真实签收才能发布；离线 `PASS` / `PASS_MOCK` 不等于 `PASS_REAL` 或发布批准。

---

## 7. 交给主代理的范围外修复建议（精确指向，不在本 worktree 实施）

1. **核验并补齐 Go 模型 catalog 的压缩声明**（`src/index.js` 归属主代理，或聚合 catalog 生成侧）：确认聚合 Go 模型 `codex` override 显式含 `history.compaction:'preserve'` 与 `nativeCompaction:'codex-owned-local'`，且 provider 段 `remote_compaction='unsupported'`。若缺失，则真实压缩发生后 `context_compaction` 标记会被 `interop.js:1033-1039` typed 拒绝。函数位置：`defaultCodexCaps`（`src/index.js:1648-1652`）与 `buildCodexRoute`（`src/index.js:1656-1666`）的默认值合并；校验在 `src/index.js:941-944`。**不得**改 `interop.js` 的 typed 拒绝来「放宽」——那是 fail-closed 的正确行为。
2. **P0-01 先行**：按任务书要求先消除孤立 `function_call_output` 导致的 400（`src/index.js` / `src/aggregation/api.js`，主代理范围），否则脏历史会污染长会话，使 RA-1..RA-4 无法稳定复现。
3. **客户端侧路线（需所有者裁决）**：若 0.167.x resume 确实无法保证同一 childId，形成不可达证据 + 可选客户端方案（升级/固定客户端版本、或产品放宽为「同会话继续」而非「同一 childId」）交所有者决定；网关不自建线程映射。

本调查在自有范围内做的唯一源码改动是在 `src/codex/native-capabilities.js` 的**能力清单**中新增两条诚实记账项（`native_compaction_codex_owned`、`same_child_resume_after_interrupt`），使机器可读清单不再缺失压缩/同子恢复这一一等需求；不改任何协议行为、不放宽任何断言、不引入 `PASS_REAL`。
