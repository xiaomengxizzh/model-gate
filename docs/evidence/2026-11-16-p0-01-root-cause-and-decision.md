# MG-FIX-P0-01｜孤立 `function_call_output` 400：根因、离线结论与决策点（2026-11-16）

> 状态：离线/无损部分 **DONE**；真实 Desktop 400 的“关闭”**BLOCKED（需所有者裁决/真实额度授权）**。
> 本文不宣称 P0 已关闭，不伪造 `PASS_REAL`，不改历史证据。基线 `9a371d3`（`feat/modelgate-ux-v3`）。

## 1. 脱敏结构证据（已获取，未重写）

`logs/gateway-2026-11-16.log`（生产树，原样保留）13:27:15：

```
第三方 Responses 历史中工具项缺少 call_id opencodego index=4 type=function_call_output
shapes=message|message|message|message|function_call_output|message|message|function_call_output|message
```

即：4 个 `message` 之后直接出现 `function_call_output`，**整段 input 里没有任何
`function_call`/`custom_tool_call`/`local_shell_call`/`computer_call` 可与它配对**，且该 output
缺 `call_id`。网关 `firstEmptyToolCallId` 命中 → 在发往上游之前 typed 400
（`third_party_tool_call_id_missing`），**零模型计费、零重复出站、不吞历史、不伪造调用**。

## 2. 已排除（不要重复修复）

- `stream_options` 导致 Go 400 —— 已由 `projectThirdPartyResponsesParams` 剔除（历史提交）。
- 缺 id 的 `function_call` / `function_call_output` 按位置补齐 —— 已由 `repairThirdPartyToolCallIds`
  补齐（`call_mg_N` 合成 + assign/pair/backfill），本轮进一步硬化见 §4。
- 代理/端口/Host、Key 解析、模型路由、目录缺失 —— 交接文档 §4/§5 已排除。

## 3. 根因判定（严格区分“已证实”与“待证实”）

**已证实**：失败是“孤儿 output 无 call 可配对”，且网关的 fail-closed 行为正确（没有静默放行、没有丢历史）。

**待证实（无法离线确证，禁止假定是 Codex bug 或 Go bug）**：Codex 为何在指向第三方 provider 时
发出这种形状。候选（来自交接文档 §5，本轮未新取证）：

- H1 原生 fork/分支叉分上下文：子线程或 resume 把父线程工具结果回放为 output，但对应 call 在另一线程。
- H2 历史 item 分类/投影：Codex 把工具结果序列化为 `type:message`（可能被重命名），
  而把配对 call 放在 reasoning/加密段；第三方上游看不到配对关系。
- H3 portable Responses 约束：官方后端接受无 call 的历史（按位置/加密上下文推断），Go 便携上游要求非空 `call_id`。

本轮新增的脱敏 trace（`toolHistoryShapeTrace`）已能在下一次真实请求时区分 H1/H2：
它记录每项的 `type/role/name/id/call_id 是否存在`（不记录正文），以及线程/关联的**哈希值**。

## 4. 本轮已交付的无损修复（可审计）

| 项 | 文件 | 证据 |
| --- | --- | --- |
| 最小脱敏结构 trace | `src/index.js` `toolHistoryShapeTrace()` + 400 守卫接线 | `scripts/test/offline/agg-v2-p0-01-shape-trace.test.mjs` 5/5 |
| 400 detail 携带结构形状（无正文） | 同上 error.detail.historyShape | 同上 |
| 孤立输出 fail-closed 不变量 | `firstEmptyToolCallId` | 同上 fixture（第 5 项） |
| 合成 ID 不与已有 ID 碰撞 / 不错误回填真实 id | `src/index.js` `repairThirdPartyToolCallIds()` 硬化 | `scripts/test/offline/agg-v2-tool-id-collision.test.mjs` 6/6 |

**没有做**、也**不允许默认做**的事：
- 不删除/丢弃孤儿 output（交接文档选项 b）——会改变模型可见历史，需所有者批准。
- 不伪造占位 `function_call`（选项 c）——语义造假，需所有者批准。
- 不改走 Chat 桥（选项 a）——原生 Responses/压缩链路需重新验收，属协议切换，需所有者批准。
- 不静默降级为“全量协议扩张”或换模型/供应商。

## 5. 为什么真实 400 的“关闭”是 BLOCKED，而不是本次宣称已修

- 三个候选根因要区分，必须复刻**同一真实会话**在“指向官方 vs 指向网关/Go”时的入参差异；
  本轮可用的真实 CLI 回环脚本（`scripts/test/codex-e2e.mjs`）被 `MGR_E2E_NETWORK_ISOLATED`
  门控（空 `CODEX_HOME` 首次启动会触发 curated plugin sync 的外连风险），在无 OS 级出网隔离的
  本机运行它可能造成**未授权下载**——与绝对约束 4/6 冲突，故不运行。
- 复现/验证选项 b/c/a 的任一真实效果，都需要**真实 OpenCode Go DeepSeek 额度**（付费流量），
  当前**无此预算与时间窗授权**（绝对约束 8）。
- 因此：离线结构诊断 + 无损配对硬化 = DONE；真实根因确证与选项落地 = **BLOCKED**。

## 6. 给所有者的决策点（需明确选择，不代为决定）

1. 是否授权一次**真实 `gpt-6-luna` 父 → Go DeepSeek 子**的长会话，配合新增 trace 取证以确证 H1/H2/H3？
   （仅 Go DeepSeek 额度；父模型仅 `gpt-6-luna`；需额度、时间窗、隔离目录授权）
2. 若确证为真孤儿且无法无损配对，三选一（均需书面批准）：
   - (a) 改走 Chat 桥（重验原生压缩/Responses）；
   - (b) 显式丢弃孤儿 output + lossy 诊断（改变模型可见历史）；
   - (c) 合成占位 `function_call`（历史语义造假）；
   - (d) 调整 Codex 侧开关（`unified_exec`/`code_mode`/子代理 `fork_context` 等）使其不发此形状。
   推荐先做 (d) 的安全初探，失败再在 (a)/(b) 间由所有者裁决；(c) 不推荐。

## 7. 复现命令（离线，零额度）

```bash
node --test scripts/test/offline/agg-v2-p0-01-shape-trace.test.mjs
node --test scripts/test/offline/agg-v2-tool-id-collision.test.mjs
node --test scripts/test/offline/agg-v2-third-party-params.test.mjs
```
