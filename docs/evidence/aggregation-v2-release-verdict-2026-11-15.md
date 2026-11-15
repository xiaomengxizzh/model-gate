# ModelGate V2｜发布裁决（2026-11-15，被测树 `edd0830`）

> **两个结论必须分开读**：门禁迁移（V2-00）**PASS**；产品发布**FAIL / 不可签收**。
> 本文件是 Lead 对 A5 四轮独立复核结论的登记，不替代 A5 原始证据，也不改变任何 `MG-R` 口径。

## 1. 结论

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| V2 门禁迁移（V2-00） | **PASS** | A5 第四轮复核：`gate:audit-diff --base main` 真实 PASS、空 diff fail-closed、`--replay` 不得放行、门禁模块/状态表哈希二次确认、`gate-weakened` 登记与单测 |
| 产品发布 | **FAIL（不可签收）** | 见 §3 阻断清单 |

## 2. 本轮实测结果（被测树 `edd08305a5cda63ec11b14638666fda8fae69896`）

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS（UI modules 17/17）|
| `npm test` | 114 套件 / 1107 用例 / 0 失败 / 2 skipped |
| `node scripts/check-metadata.mjs` | PASS（39 checks）|
| `npm run docs:check` | PASS（92 文件）|
| `npm run contract:check` | PASS |
| `npm run gate:v2` | 9/9 自证 PASS |
| `aggregation-matrix-v2.js --check` | PASS（byte-identical）|
| `npm run gate:audit-diff --base main` | PASS（0 findings，422 files，非空 diff）|
| `npm run gate:v2:independent` | 11/12（唯一 FAIL = N04）|

## 3. 发布阻断（不得删除）

1. **MG-R006 真实 Codex 原生压缩：FAIL / BLOCKED**。真实 Go `deepseek-v4.1-flash` 推理与真实原生父子 + 压缩后追派/中断/恢复未执行（无所有者额度/时间窗授权）。现有最强证据是真实客户端 + 回环上游的 `PASS_MOCK`（[实测记录](aggregation-v2-native-compaction-real-client-2026-11-15.md)），不得升级。
2. **N04 摘要导出：FAIL**。`src/codex/history.js` + `/api/codex/history/export*` 仍可达，契约“网关不得自建 summarize”为绝对条款且无所有者书面裁决。已加边界守卫（不参与模型请求组装），但**可达路径仍在**。
3. **真实原版 Desktop 选模、真实 ChatGPT 套餐（`gpt-6-luna`）、真实 OpenCode Go 推理：全部 BLOCKED**（无授权）。
4. **结构性残余（不可由仓库脚本消除）**：伪造 evidence 绑当前 HEAD + 所有者布尔批准仍可过门禁；真实性只能由 A5 真实回执与所有者审批兜底。哈希钉死是“二次可见确认”，不是防篡改金库。

## 4. 待所有者决策

- **N04**：保留并书面登记例外，或移除该可达导出路径。
- **真实验收授权**：批准额度/时间窗后，A5 只用 `gpt-6-luna` 做真实压缩/Desktop/Go 验收，回执绑定**冻结 SHA**。
- 发布动作（PR #7 转 Ready、合并 main、发版）在以上两项完成前不执行。

## 5. 本轮交付的代码与证据索引

- 门禁：[`aggregation-matrix-v2.js`](../../scripts/test/offline/aggregation-matrix-v2.js) / [`aggregation-gate-v2.js`](../../scripts/test/offline/aggregation-gate-v2.js) / [`aggregation-audit-diff.mjs`](../../scripts/test/offline/aggregation-audit-diff.mjs) / [`aggregation-acceptance-v2.test.mjs`](../../scripts/test/offline/aggregation-acceptance-v2.test.mjs)
- 状态与被测：[V2 当前验收状态](aggregation-v2-status-2026-11-15.md) / [V2 验收矩阵](aggregation-acceptance-matrix-v2.md)
- 本机事实与代码：[V2 集成证据](aggregation-v2-integration-2026-11-15.md)
- 真实客户端压缩实测：[native compaction real-client](aggregation-v2-native-compaction-real-client-2026-11-15.md)
- 独立验收：[A5 验收](aggregation-v2-independent-qa-2026-11-15.md) / [A5 对抗发现](aggregation-v2-qa-findings-2026-11-15.md)
