# ModelGate V2｜发布裁决（2026-11-15 最终）

> 冻结树：`51e78e0da66846de0b28d2904dc5216685fc5732`（`docs/evidence/v2-frozen-sha.txt`）。
> **`npm run release:freeze` = PASS**：12 项 `PASS_REAL` 均绑定冻结树，冻结后仅文档改动。

> **两个结论必须分开读**：门禁迁移（V2-00）**PASS**；产品发布**FAIL / 不可签收**。
> 本文件是 Lead 对 A5 第五轮独立复核（`3dfd44a`）的登记，不替代 A5 原始证据，也不改变任何 `MG-R` 口径。
> 本页已 `取代` 早先 `edd0830` 版本（当时 R003 仍 BLOCKED、N04 无裁决），历史内容不再作为当前结论。

## 1. 结论

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| V2 门禁迁移（V2-00） | **PASS** | A5 第四轮复核：`gate:audit-diff --base main` 真实 PASS、空 diff fail-closed、`--replay` 不得放行、门禁模块/状态表哈希二次确认、`gate-weakened` 登记与单测 |
| 产品发布 | **达到发布门槛，待所有者审批** | 12/12 `PASS_REAL`；`release:freeze` PASS；见 §3 |

## 2. 本轮实测结果（被测树 `754a687e11ac8c891ea14bb2d6cc8830f10eb089`）

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS（UI modules 17/17）|
| `npm test` | 119 套件 / 1135 用例 / 0 失败 / 2 skipped |
| `node scripts/check-metadata.mjs` | PASS（39 checks）|
| `npm run docs:check` | PASS（92 文件）|
| `npm run contract:check` | PASS |
| `npm run gate:v2` | 9/9 自证 PASS |
| `aggregation-matrix-v2.js --check` | PASS（byte-identical）|
| `npm run gate:audit-diff --base main --all-commits` | PASS（0 未批准 findings；5 条历史改动见 `gate-approvals.json`）|
| `npm run gate:v2:independent` | **12/12**（N04 已由所有者书面例外覆盖）|

## 3. 发布阻断（不得删除）

1. **真实原生父生子已成立**：网关新增受限订阅承载（复用本机 Codex 登录 → `chatgpt.com/backend-api/codex`，仅显式 `gatewaySubscription` + loopback + 官方 host），真实 `gpt-6-luna` 父通过 `[agents.go_deepseek]` 派生真实 Go 子代理并执行工具；R002/R003/R005/R012 均已 `PASS_REAL`（绑 `754a687`）。
2. **MG-R006 已 `PASS_REAL`（已关闭）**：`interrupt`（工具执行中 SIGINT，父/子 `turn_aborted:1`、工具未完成、`spawn_agent:1`）与 `no-duplicates`（2 个会话来回复用、无第三个子会话）真机成立；`resume` 后继续用同一子代理。
3. **原版 Desktop GUI 已真机验收（R004 `PASS_REAL`）**：隔离实例窗口 + 选择器双方可见（截图/DOM）+ 官方 `gpt-6-luna` 与 Go 模型各一次真实请求；官方路径 403 已由 `0c867fd`（仅 app 模式注入 chatgptPlan）修复并复测通过。
4. **12/12 `PASS_REAL` 已完成**：R001（控制台启停/重启/回滚）、R004（原版 GUI 双方选模）、R007（空白/已有/409）、R008（真实负向：零上游/401 typed/429 跨域阻断）、R009（双实例隔离；单实例多租户为已知 GAP）、R010（10 时点 SIGKILL + 逐字节回滚）、R011（冻结回执与矩阵一致）、R006（工具/同子/中断/恢复/去重 + 压缩三条沿用中间树证据，已在冻结复核文档注明）。
5. **冻结流程**：`release:freeze` PASS；冻结后只允许 `docs/**` 改动，任何 `src/**` 或测试改动都会要求重新冻结。
6. **已知边界/未做**：原版 GUI 的 SSE 原文未单独抓取（用客户端 rollout + 网关日志代替，需再授权 1 次可选）；单实例多租户未实现（实例级隔离已验收）；PR #7 仍 Draft，合并/发布仍需所有者批准。
4. **结构性残余**：伪造 evidence 绑当前 HEAD + 布尔批准仍可过门禁；真实性由 A5 真实回执与所有者审批兜底。
4. **结构性残余（不可由仓库脚本消除）**：伪造 evidence 绑当前 HEAD + 所有者布尔批准仍可过门禁；真实性只能由 A5 真实回执与所有者审批兜底。哈希钉死与 `gate-approvals.json` 都是“可见的二次确认”，不是防篡改金库。

## 4. 所有者已决定事项

- **N04**：所有者已批准**保留 + 书面例外**（2026-11-15），边界写入 [V2 产品契约](../product/2026-11-14-owner-scope-v2.md)；A5 独立套件相应合法变绿（12/12）。不再计入发布阻断。
- **真实验收**：所有者已授权。首轮结果见 [真实验收记录](aggregation-v2-real-acceptance-2026-11-15.md)：Go 推理 `PASS_REAL`、Codex 原生压缩 `observed`、真实工具未执行 `FAIL`。
- 发布动作（PR #7 转 Ready、合并 main、发版）在「真实工具可用 + 真实 Desktop/Luna 验收」完成前不执行。

## 5. 本轮交付的代码与证据索引

- 门禁：[`aggregation-matrix-v2.js`](../../scripts/test/offline/aggregation-matrix-v2.js) / [`aggregation-gate-v2.js`](../../scripts/test/offline/aggregation-gate-v2.js) / [`aggregation-audit-diff.mjs`](../../scripts/test/offline/aggregation-audit-diff.mjs) / [`aggregation-acceptance-v2.test.mjs`](../../scripts/test/offline/aggregation-acceptance-v2.test.mjs)
- 状态与被测：[V2 当前验收状态](aggregation-v2-status-2026-11-15.md) / [V2 验收矩阵](aggregation-acceptance-matrix-v2.md)
- 本机事实与代码：[V2 集成证据](aggregation-v2-integration-2026-11-15.md)
- 真实客户端压缩实测：[native compaction real-client](aggregation-v2-native-compaction-real-client-2026-11-15.md)
- 独立验收：[A5 验收](aggregation-v2-independent-qa-2026-11-15.md) / [A5 对抗发现](aggregation-v2-qa-findings-2026-11-15.md)
