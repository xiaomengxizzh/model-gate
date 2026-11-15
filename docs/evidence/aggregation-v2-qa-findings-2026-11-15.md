# ModelGate V2 门禁事后对抗性复核（A5，2026-11-15）

> 复核对象（只读，不切换、不修改）：
> - `13d1354b07080c45e475ca32c02c85b453d84b9a` feat(gate): V2 验收门禁迁移（Go 单模型 + Codex 原生压缩）[V2-00]
> - `fbc9a73a3cd572efad0b47ecccc1688ea5727c39` test(gate): 状态文档自证不得放行 + 状态→门禁输入 API 收敛 [V2-00]
>
> 对象文件：`scripts/test/offline/aggregation-matrix-v2.js`、`aggregation-gate-v2.js`、`aggregation-acceptance-v2.test.mjs`、`docs/evidence/aggregation-acceptance-matrix-v2.md`、`docs/evidence/aggregation-v2-status-2026-11-15.md`、V2 计划 §2.1、`check-product-contract.mjs`、`.github/workflows/check.yml`、`package.json`。
>
> 方法：`git show` / `git archive` 只读快照到 `/tmp`，再用**伪造证据与门禁自减**做黑箱攻击；不改仓库、不联网、不触碰真实 Codex/凭据。所有攻击脚本与产物仅存 `/tmp`，不随仓库提交。

## 0. 结论摘要

| 级别 | 编号 | 结论 | 是否阻断发布 |
| --- | --- | --- | --- |
| 高 | F1 | **反降级审计覆盖不到 V2 计划/门禁文件**：可协调删除 `NATIVE_COMPACTION_CASES` 与自证 check，审计 `ok:true`、`npm test` 12/12、`gate:v2` exit 0，随后伪造证据 `ready:true` | 是（审计承诺不成立） |
| 高 | F2 | **`--evidence` 无真实性绑定，且默认 `headSha` 不是实际 HEAD**：实测旧树 SHA + 伪造 JSON → `ready:true`；状态文档“按实际 HEAD 判定 stale_evidence”不成立 | 是（换树失效承诺不成立） |
| 中 | F3 | `native-compaction` 只校验 `passed:true`，不校验 `owner=codex`/真实事件形状；**结构性弱点**（A5 已预先声明，不据此判 Lead 降级） | 风险（非门禁逻辑错误） |
| 中 | F4 | 旧树 `PASS_REAL`（R005/R012）在 V2 矩阵显示为 `PASS_REAL @ 9db5ed1`，与“换树即失效”和状态文档自述矛盾 | 否（门禁仍阻断，但状态误导） |
| 低 | F5 | `V2_CANCELLED_CASES` 把“Console 范围取消”与“用例改名/删除”混在一个集合，遮蔽 `catalog-not-truncated` 被移除的事实 | 否 |
| 低 | F6 | `npm run gate:v2` 是 9 条合成自证，不是实际门禁输出；CI 从不运行 `gateV2()` 真实结果 | 否（当前状态另由 V2 套件挡住） |
| 低 | F7 | `parseV2PlanCases` 只取第一个 `V2-MATRIX-BEGIN` 块，后置诱饵块被静默忽略 | 否 |

**总体判定**：核心阻断与状态迁移**成立**（A/B/D 三项按 Lead 声明通过；R006 保持 `FAIL`，门禁 `ready:false`）。但“反降级”与“换树即失效”两项**承诺当前不成立**（F1/F2），其中 F1 可让门禁在**不触发 native compaction**的情况下变绿。发布仍为 `ready:false`；F1/F2 需 Lead 修复后才可进入 P05 所有者审批。

## 1. 逐项回应 Lead 提出的 5 个对抗点

| # | Lead 的问题 | A5 实测结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 状态文档改成全 `PASS_REAL` 是否会放行 | **不会**。`gateV2({ownerApproval:true, evidence: v2EvidenceFromStatus(allPassRealRows)})` → `ready:false / BLOCKED / invalid_evidence`，12 条全部 `invalid_evidence` | 镜像内运行；`v2EvidenceFromStatus` 不带 commitSha/command/receipt/realTarget |
| 2 | `--evidence` 只覆盖部分需求是否放行 | **不会**。只给 `MG-R006` 时 → `ready:false / missing_evidence`，`failedRequirements` 列出其余 11 条 | CLI 黑箱 |
| 3 | `native-compaction` 自述 `passed:true`、无真实事件是否会放行 | **会放行**。结构校验只要求 `passed:true && skipped!==true`；`{native-compaction:{passed:true}}` 即可通过。**这是已知结构性弱点**（门禁只校验结构，真实性由 A5 真实回执负责），不据此判 Lead 降级，但列为发布风险 F3 | 伪造证据 `ready:true / PASS_REAL / owner_approved` |
| 4 | V1 套件是否仍能独立证明历史未被改写 | **能**。V1 矩阵/审计/门禁三套件 37/37 pass；独立套件另用 sha256 钉死 `2de6d14…`、`ad9e0cd…` | `node --test aggregation-acceptance-{matrix,audit,gate}.test.mjs` |
| 5 | CI 是否真的会阻止“native compaction 未通过”的合并 | **对当前状态会**（V2 套件断言 R006=`FAIL`、`gateV2` `ready:false`；`gate:v2` 9 条自证）；**对“协调改门禁文件”不会**（F1：审计盲区）。因此是“部分成立” | F1 实测 |

## 2. 高危：F1 反降级审计覆盖不到 V2 计划与门禁文件

### 2.1 攻击

在 `/tmp/a5-bypass2`（`git archive fbc9a73` 的独立快照）做两处**只改测试/门禁、不改 `src/**`** 的修改：

1. `aggregation-matrix-v2.js`：`NATIVE_COMPACTION_CASES` 置为 `Object.freeze([])`（不再强制三件套，且 `buildV2Matrix` 的循环变为空转）；
2. `aggregation-gate-v2.js`：删除自证 check 3/4/5（缺记录 / skipped / 旧 V1 证据三条），共 44 行。

然后对该 diff 调用反降级审计：

```
auditCandidate(diff) => { "ok": true, "findings": [], "stats": { "files": 2, "srcTouched": false,
  "removedAssertions": 0, "addedAssertions": 0, "skipAdded": 0 } }
```

### 2.2 后果（同一快照实测）

| 观测 | 结果 |
| --- | --- |
| `node scripts/test/offline/aggregation-gate-v2.js --assert-native-compaction-blocking`（即 `npm run gate:v2`） | **exit 0**，只剩 6 条 PASS（三条 native compaction 反绕过自证被删） |
| `node --test scripts/test/offline/aggregation-acceptance-v2.test.mjs` | **12/12 pass**（`NATIVE_COMPACTION_CASES` 已空，`every` 空真；删除的自证不再被引用） |
| `node scripts/test/offline/aggregation-gate-v2.js --evidence <伪造全 PASS_REAL> --owner-approval` | **`ready:true / PASS_REAL / owner_approved`** |

### 2.3 根因（`scripts/test/offline/aggregation-audit.js`）

```js
const protectedDiff = files.filter((f) =>
  f.file.startsWith('docs/product/') || /^docs\/roadmap\/2026-11-14-aggregation/.test(f.file))
if (srcTouched && removedAssertions > 0 && addedAssertions === 0) add('assertions-weakened', …)
```

- **保护集合不含** `docs/roadmap/2026-11-14-go-deepseek-native-compact-plan.md`（V2 计划）与 `scripts/test/offline/aggregation-*-v2.js`（V2 门禁本身）。
- `assertions-weakened` 要求 `srcTouched === true`；只删测试/门禁不会触发。
- 被删的自证是 `check(...)`，不匹配 `ASSERTION` 正则（`assert(`/`ok(`/`expect(`），`removedAssertions` 计为 0。

### 2.4 现存的缓解与其不足

- `check-product-contract.mjs` 新增 `ok(v2CaseBlock.includes('native-compaction'))` 与 `package.json`/CI 接线检查，能挡住“只改计划”的单点降级。
- 但同一提交可以**同时**修改 `check-product-contract.mjs`，而审计不检查该文件；因此是“提高成本”而非“不可绕过”。
- `fbc9a73` 自身已通过 `V2 状态文档里写 PASS_REAL 不足以放行` 收紧了状态自证，这一点值得肯定。

### 2.5 修复建议（按优先级）

1. 把 `docs/roadmap/2026-11-14-go-deepseek-native-compact-plan.md` 与 `scripts/test/offline/aggregation-{matrix,gate}-v2.js` 加入 `requirement-reworded` 的保护集合（或新增 `gate-tampered` 规则）。
2. `assertions-weakened` 不应以 `srcTouched` 为前提：门禁/矩阵/证据守卫文件的删除同样降级。
3. 把 `NATIVE_COMPACTION_CASES` 从“可变常量”改为**由契约/计划文本派生的硬断言**（例如计划 §2.1 的 `MG-R006` 行必须逐字含三件套，缺失即生成失败；常量仅作展示）。
4. 自证 check 清单再加一条：`NATIVE_COMPACTION_CASES.length === 3` 且与计划交集相等（防止空集合空真）。

## 3. 高危：F2 证据无真实性绑定 + 默认 SHA 不是实际 HEAD

### 3.1 攻击一：伪造 `--evidence` 直接变绿

用一份手工 JSON（12 条全 `PASS_REAL`、每条 `commitSha=9db5ed1…`、`receipt` 为任意字符串、`native-compaction:{passed:true}`、`realTarget:true`、`passedAllOnRealTarget:true`）运行：

```
node scripts/test/offline/aggregation-gate-v2.js --evidence /tmp/a5-fabricated-evidence.json --owner-approval
=> ready=true status=PASS_REAL reason=owner_approved headSha=9db5ed11a557d30203b661d8002a98f61c0e6031
```

实际仓库 HEAD 为 `fbc9a73a3cd572efad0b47ecccc1688ea5727c39`。`validateEvidence` 接受 `receipt` 为任意非空字符串；`--owner-approval` 只是布尔开关，无签名/工单绑定。

### 3.2 攻击二：默认 `headSha` 锚定证据文档自身，不是 git HEAD

```js
export function gateV2({ sha = V2_BASELINE_SHA, … })   // V2_BASELINE_SHA 来自状态文档「被测树 SHA」
```

- `V2_BASELINE_SHA` 解析自 `docs/evidence/aggregation-v2-status-2026-11-15.md`，当前是 `9db5ed1…`（P00 起点）。
- 因此“换树即失效”实际只对**证据里的 commitSha 与状态文档里的基线 SHA** 比较；把状态文档 SHA 与伪造证据 commitSha 对齐，就能永久复用旧树回执，哪怕 `src/**` 已大幅变化。
- 这与状态文档第 9 行自述“门禁按实际 HEAD 判定 `stale_evidence`”**不一致**；`aggregation-acceptance-v2.test.mjs` 也从未把 `headSha` 与 `git rev-parse HEAD` 比较。

### 3.3 修复建议

1. CLI 默认 `sha` 改为 `git rev-parse HEAD`（只读、离线），或强制要求 `--sha` 且与 HEAD 相等；`V2_BASELINE_SHA` 只作文档说明。
2. `--evidence` 记录必须绑定**已提交的证据文档路径**：`case.receipt.traceId` 必须出现在该路径文本中，且路径在 `docs/evidence/` 下、存在、通过 `git ls-files`。
3. `PASS_REAL` 的 `receipt` 不接受裸字符串：必须是 `{traceId, evidenceDoc, requestId}`，且 `evidenceDoc` 可解析。
4. `--owner-approval` 改为引用所有者批准工件（PR 评论/签名文件），而不是调用方自报布尔值。
5. 套件新增断言：`gate.headSha === git HEAD`（在冻结 SHA 上运行）。否则“换树失效”只是口号。

## 4. 中危：F3 native-compaction 只做结构校验（已知弱点，发布风险）

- `validateEvidence` 对计划的每个用例只要求 `rec.passed === true && rec.skipped !== true`；**不要求用例级 receipt**，更不校验 `owner=codex`、压缩事件、childId 一致性。
- 因此 `native-compaction:{passed:true}` 与 `native-compaction:{passed:true, receipt:"真实事件"}` 等价。
- 这是门禁的**结构性边界**，不是实现错误；A5 同意 Lead 的定性：不据此判降级，但必须作为发布风险由 A5 真实回执兜底。
- 建议在不改变“A5 负责真实性”分工的前提下，增加**低成本形状校验**：`native-compaction` 记录必须含 `owner:'codex'`、`childId`、`eventRef`（指向已提交证据文档中同名 traceId/事件行）；且 `post-compact-followup`/`context-proof` 的 `childId` 必须与 `native-compaction` 相同。这样伪造成本显著上升，且不替代真实回执。

## 5. 中危：F4 旧树 `PASS_REAL` 被显示成当前树通过

V2 状态文档与矩阵对 R005/R012：

- 状态列：`PASS_REAL @ 9db5ed11`；
- 依据列：真实回执绑定旧树 `67b9735…` / `4feafe0e…`，并写明“V2 当前树未复测”。

这与契约“代码或测试变化后旧证据不得复用”和矩阵头“换树即失效”矛盾。门禁实际上会因 `commitSha:null` 把这两行判 `invalid_evidence`（不会放行），所以**不是放行漏洞**，但会误导所有者以为 12 条里已有 2 条在本轮完成。

建议：矩阵状态列显示**回执绑定的 SHA**（或标注 `PASS_REAL(旧树)`），或把只有旧树回执的行在 V2 中降为 `PASS_MOCK`/`NOT_TESTED`；不要在“当前状态 @ 基线 SHA”列复用旧回执。

## 6. 低危：F5/F6/F7

### F5 `V2_CANCELLED_CASES` 语义混淆

集合同时包含：

- 真正因 V2 范围取消的 Console 全量：`all-opencode-console-models`、`all-opencode-go-models`、`desktop-model-picker-console`、`refresh-diff`；
- 被改名/替换的 R006/R008 用例：`same-child-two-tasks`→`same-child-followup`、`context`→`context-proof`、`no-duplicate`→`no-duplicates`、`no-silent-fallback`→`no-silent-model-fallback`、`unsupported-tool-fails-explicitly`→`no-silent-tool-drop`；
- 真正被移除、无后继的 `catalog-not-truncated`。

自证文案“V2 映射不含已取消的 Console 全量用例”会让人误以为上述改名项也是 Console 范围取消。建议拆成 `V2_CANCELLED_CONSOLE_CASES` 与 `V2_RENAMED_CASES`（附 old→new 表），并在 V2 状态文档写明 `catalog-not-truncated` 的移除理由（V2 只要求 DeepSeek，不再做全量目录对账）。这是“可审计性”问题，不是放宽条件。

### F6 `gate:v2` 名不副实

`npm run gate:v2` = `--assert-native-compaction-blocking`，跑的是 9 条**合成证据**自证，不是 `gateV2()` 的真实门禁输出。当前状态由 `npm test` 里的 V2 套件挡住，但 CI 日志会显示 “gate:v2 PASS”，容易被误读为“发布门禁通过”。

建议：拆成 `gate:v2:selfproof`（合成自证）与 `gate:v2:status`（真实门禁，断言 `ready:false` 直到 R006 真实通过）；CI 两个都跑，日志名不得暗示发布已通过。

### F7 计划映射块可被诱饵遮蔽

`parseV2PlanCases` 与 `check-product-contract.mjs` 都取**第一个** `V2-MATRIX-BEGIN..END`。若文件中存在第二个块，两个读取器都静默忽略，人工审计可能被后置块误导。

建议：`parseV2PlanCases` 断言 `V2-MATRIX-BEGIN` 只出现 1 次；计划里出现多次即生成失败。

## 7. 已确认成立的部分（避免误伤）

- `gateV2` 对状态文档自证、部分证据、`skipped`、旧 V1 `PASS_REAL`、换树（相对状态文档 SHA）均能阻断。
- V2 套件 `aggregation-acceptance-v2.test.mjs` 12/12；V1 三套件 37/37；`npm run gate:v2` 9 条自证 PASS；`node aggregation-gate-v2.js` 输出 `ready:false`。
- V1 历史矩阵与原生失败记录逐字节未变（A5 独立 sha256 钉死）。
- 取消的 Console 全量用例确实不再出现在 V2 §2.1 映射里；V1 历史仍保留可追溯。

## 8. 建议的修复顺序（不改变产品范围）

1. **F2**：门禁默认 SHA 锚定 `git HEAD`；证据绑定已提交证据文档与 traceId（否则任何“真实通过”声明都不可复核）。
2. **F1**：把 V2 计划与 V2 门禁文件纳入反降级保护；`assertions-weakened` 去掉 `srcTouched` 前提；自证加“三件套长度=3 且与计划交集相等”。
3. **F4**：矩阵按回执 SHA 显示状态；旧树回执不得标为当前树 `PASS_REAL`。
4. **F3**：增加 native-compaction 低成本形状校验（owner/childId/eventRef）。
5. **F5/F6/F7**：拆分取消/改名集合、拆分 `gate:v2` 命名、拒绝多映射块。

## 9. 待复核 / 未验证

- 本轮**未**发起真实 Codex Desktop / GPT-6 Luna / Go 推理，真实 native compaction 仍 `BLOCKED`（无额度授权）；F1/F2 的修复效果需在后续 SHA 上以 `git show` + 黑箱复跑复核。
- F1 的攻击在 `/tmp` 只读快照中进行，**仓库未被削弱**；仓库当前 `fbc9a73` 的门禁文件保持 Lead 提交原样。
- 未验证：A1 完成 compaction 修复后的真实事件形状、A2/A3/A4 的产品改动（不属本轮 A5 写集）。
