# ModelGate V2 独立黑箱验收（A5，2026-11-15）

> 角色：**A5 / Independent QA & Release Gatekeeper**。本轮只做独立验收与对抗性复核，不实现、不改写 Lead 的 V2 门禁产物。
> 验收依据（以契约为准，不从开发者声明出发）：[V2 所有者范围](../product/2026-11-14-owner-scope-v2.md)、[V2 执行计划](../roadmap/2026-11-14-go-deepseek-native-compact-plan.md) §0/§2/§4/§7、[V2 角色启动提示词](../roadmap/2026-11-14-go-deepseek-native-compact-start.md) A5 段。
> 历史证据按原样保留，不得改写：[V1 矩阵](aggregation-acceptance-matrix.md)、[V1 原生实跑](aggregation-native-real-2026-11-14.md)。

## 0. 被测对象与树

| 对象 | SHA / 路径 | 说明 |
| --- | --- | --- |
| A5 独立工作树基线 | `9db5ed11a557d30203b661d8002a98f61c0e6031`（分支 `feat/v2-a5-acceptance`） | 本证据与本套件所在树；不导入 Lead 生成器/门禁内部实现 |
| Lead V2 门禁（事后复核对象） | `13d1354b07080c45e475ca32c02c85b453d84b9a`、`fbc9a73a3cd572efad0b47ecccc1688ea5727c39`（`mg-codex-native`） | 只读 `git show`/`git archive`，未切换、未修改 |
| 集成镜像（只读快照） | `git archive fbc9a73` → `/tmp/a5-mirror-fbc9a73` + 本套件 | 用于验证本套件在 Lead 产物齐全的树上行为；临时目录，不随仓库保留 |
| 独立套件 | `scripts/test/offline/aggregation-v2-independent-qa.test.mjs` | 单跑：`node --test scripts/test/offline/aggregation-v2-independent-qa.test.mjs`；**未**改 `scripts/test/run.mjs`，注册由 Lead 集成时完成 |

**独立性声明**：本套件只解析契约/计划/状态/矩阵**文本**，并只把 Lead 门禁当 **CLI 黑箱**观测其 JSON 输出；不 `import` `aggregation-matrix-v2.js` / `aggregation-gate-v2.js` / `aggregation-matrix.js` 的导出函数。因此 Lead 重写内部实现不会改变本套件的判断口径。

## 1. 本轮可执行与不可执行项

| # | 检查项 | 状态 | 命令 / 依据 | 未满足条件 |
| --- | --- | --- | --- | --- |
| 1 | V2 契约 12 条齐全、顺序固定、R006/R012 关键措辞可追踪、禁止自建 summarize 原文在 | `PASS` | 独立套件用例 1–2；`docs/product/2026-11-14-owner-scope-v2.md` | — |
| 2 | V2 计划 §2.1 冻结 12 行用例映射，R006 含 `native-compaction` / `post-compact-followup` / `context-proof` | `PASS`（集成镜像） | 独立套件用例 3；`fbc9a73` §2.1 `V2-MATRIX-BEGIN/END` | 在 A5 基线树（`9db5ed1`）该块尚未合入，见 §2.1 |
| 3 | V2 已取消的 Console 全量模型用例不再进入 V2 阻断清单，且 V1 历史仍可追溯 | `PASS`（集成镜像） | 独立套件用例 5；V2 §2.1 + V1 矩阵 | — |
| 4 | V1 历史未被改写：R006 旧 `PASS_REAL` 与 `unsupported_input_item` / 128k 失败记录逐字节仍在 | `PASS` | 独立套件用例 6（sha256 钉死 `2de6d14…`、`ad9e0cd…`） | — |
| 5 | “native compaction 真实通过”是发布必要条件；R006 `PASS_REAL` 必须含 native compaction 实测子用例且不得只绑 V1 旧树 | `PASS`（结构层） | 独立套件用例 7 | 真实事件本身 `BLOCKED`（无授权），见 #10 |
| 6 | R006 未真实通过时，V2 门禁 `ready:false` 且 `failedRequirements` 含 `MG-R006` | `PASS`（集成镜像） | 独立套件用例 8 以 CLI 黑箱运行 `aggregation-gate-v2.js` | — |
| 7 | 禁止自建压缩：`src/**` 无 `summarizeHistory`/`summaryCache`/`truncateHistory` 等实现；compaction 必须显式识别、不得静默吞；V2 路线不得配 `compaction:'drop'` | `PASS` | 独立套件用例 10；`src/codex/interop.js`、`src/index.js` | — |
| 8 | 网关侧“摘要导出”可达路径与契约绝对条款“网关不得自建 summarize”的冲突已移除或登记所有者豁免 | **`FAIL`** | 独立套件用例 11 | `src/codex/history.js` + `/api/codex/history/export` 仍在；V2 状态/契约无豁免记录 |
| 9 | 真实 GPT 只允许 `gpt-6-luna`：证据/契约/计划无其他 GPT 型号，源码无其他 GPT 父模型回退 | `PASS` | 独立套件用例 12 | — |
| 10 | **真实** Codex 原生压缩（触发→完成→同子继续→记得压缩前标记→中断/恢复） | `BLOCKED` | 无额度/时间窗授权，本轮**零**真实请求 | 所有者批准 GPT-6 Luna/Go 额度 + 时间窗后重测 |
| 11 | 原版 Codex Desktop GUI 选择 GPT-6 Luna / Go DeepSeek | `BLOCKED` | 同上 | 同上 |
| 12 | 真实 GPT-6 Luna 请求级收据（仅 Luna、无 fallback） | `BLOCKED` | 同上 | 同上 |
| 13 | 真实 OpenCode Go `deepseek-v4.1-flash` 推理成功 | `BLOCKED` | 同上 | 同上 |

> **零真实调用的证明**：本轮 A5 未发起任何 Codex Desktop / GPT / Go 上游请求，未做 live probe、未读取或提交凭据；所有 `BLOCKED` 项均因“无所有者额度授权”，不是失败，也不是通过。

## 2. 独立套件执行结果

### 2.1 两棵树（同一套件、同一 SHA 内容）

```bash
# A5 独立树（9db5ed1 + 本提交）
node --test scripts/test/offline/aggregation-v2-independent-qa.test.mjs
# => tests 12 / pass 6 / fail 6（其中 5 项失败的原因是 Lead 的 V2 产物尚未合入 A5 树，属并发工作，不是产品失败）

# 集成镜像（git archive fbc9a73 + 本套件；只读快照 /tmp/a5-mirror-fbc9a73）
node --test scripts/test/offline/aggregation-v2-independent-qa.test.mjs
# => tests 12 / pass 11 / fail 1（唯一失败为 #8 摘要导出，真实发现）
```

| 用例 | A5 树（`9db5ed1`） | 集成镜像（`fbc9a73`） | 说明 |
| --- | --- | --- | --- |
| 契约 12 条 | PASS | PASS | 文本事实 |
| R005/压缩归属 | PASS | PASS | 文本事实 |
| §2.1 冻结映射 | FAIL（产物未合入） | PASS | A5 树无 `V2-MATRIX-BEGIN` |
| §4/§7 停止条件 | PASS | PASS | 文本事实 |
| Console 取消项 | FAIL（依赖 §2.1） | PASS | — |
| V1 历史冻结 | PASS | PASS | 字节钉死 |
| native compaction 必要条件 | FAIL（缺状态文档） | PASS | A5 树无 V2 状态文档 |
| 门禁 `ready:false` | FAIL（缺门禁文件） | PASS | CLI 黑箱观测 |
| 门禁反绕过文本检查 | FAIL（缺门禁文件） | PASS | — |
| 禁止自建压缩 | PASS | PASS | `src/**` 扫描 |
| 摘要导出冲突 | **FAIL** | **FAIL** | 真实发现，见 #8 |
| gpt-6-luna | PASS | PASS | 证据/契约/源码扫描 |

### 2.2 集成镜像上 Lead 自带套件与门禁（黑箱复跑）

```bash
node --test scripts/test/offline/aggregation-acceptance-v2.test.mjs   # 12/12 pass
node --test scripts/test/offline/aggregation-acceptance-matrix.test.mjs \
           scripts/test/offline/aggregation-acceptance-audit.test.mjs \
           scripts/test/offline/aggregation-acceptance-gate.test.mjs   # 37/37 pass（V1 历史守卫）
npm run gate:v2                                                        # 9 条自证 PASS，exit 0
node scripts/test/offline/aggregation-gate-v2.js                       # ready:false / BLOCKED
```

当前门禁输出（`node scripts/test/offline/aggregation-gate-v2.js`）：

```json
{ "ready": false, "status": "BLOCKED", "failedRequirement": "MG-R001",
  "reason": "pass_mock_cannot_release",
  "failedRequirements": ["MG-R001","MG-R002","MG-R003","MG-R004","MG-R005","MG-R006","MG-R007","MG-R008","MG-R009","MG-R010","MG-R011","MG-R012"],
  "headSha": "9db5ed11a557d30203b661d8002a98f61c0e6031" }
```

> 注意两个“首个阻断”口径不同：门禁遍历顺序的 `failedRequirement` 是 `MG-R001`（`PASS_MOCK` 不能发布）；**产品级首个阻断是 `MG-R006`**（原生压缩未真实通过）。对外报告必须同时写清，不能只引用 `MG-R001` 掩盖压缩阻断。

## 3. native compaction 状态（本轮最关键结论）

**状态：`FAIL`（未真实通过）；`BLOCKED`（真实重测待授权）。**

- 旧 V1 的 `MG-R006 PASS_REAL` 只是历史用例状态；V2 状态文档已显式写 `取代 PASS_REAL @ docs/evidence/aggregation-native-real-2026-11-14.md`，**未被静默继承**。
- 旧失败 `unsupported_input_item`（compaction）与 128k 溢出尝试仍逐字节保留，未被删除或改写成通过。
- 结构层已具备四条阻断路径：缺 `native-compaction` 记录、`skipped`、旧 V1 `PASS_REAL`、换树 `stale_evidence`；`npm run gate:v2` 的 9 条自证全 PASS。
- 当前网关对 compaction 的姿态是 `reject`（typed error），未配置 `drop`；`src/**` 未发现自建 summarizer / 摘要缓存 / 历史截断实现。
- **但结构阻断 ≠ 真实通过**：门禁只能校验证据 JSON 的结构，无法独立证明“事件真的发生”。真实性由 A5 在获得授权后以真实回执负责（见 [findings](aggregation-v2-qa-findings-2026-11-15.md) F2/F3）。

## 4. 对抗性反绕过结果（摘要）

| 编号 | 绕过尝试 | 结果 | 结论 |
| --- | --- | --- | --- |
| A | 把状态文档 12 行全改成 `PASS_REAL` 后 `gateV2({ownerApproval:true})` | `ready:false` / `invalid_evidence` | 不能只靠状态自证 |
| B | `--evidence` 只覆盖 `MG-R006` | `ready:false`，11 条 `missing_evidence` | 未覆盖需求必阻断 |
| C | `native-compaction` 记录 `passed:true` 但无真实事件 | 结构校验放行 | **已知结构性弱点**（发布风险，非降级） |
| D | V1 历史被改写 | 37/37 V1 守卫 + 独立 sha256 钉死 | 可独立证明未被改写 |
| E | CI 是否阻止“压缩未通过”合并 | 当前状态会阻断；协调改门禁文件不会被审计发现 | 见 F1（高危） |
| F | 手工 JSON + 旧/任意 SHA 伪造 `--evidence` | 实测 `ready:true`（镜像内） | 见 F2（高危） |
| G | 默认 `headSha` 是否等于实际 HEAD | 否：`9db5ed1` vs 实际 `fbc9a73` | 见 F2 |
| H | 把 compaction 配成 `drop` 静默吞 | 当前无此配置（`reject`），独立套件已加守卫 | 残留路径见 F3 |

完整证据、攻击方法与修复建议见 [aggregation-v2-qa-findings-2026-11-15.md](aggregation-v2-qa-findings-2026-11-15.md)。

## 5. 未满足条件（不得删除）

1. **真实 Codex native compaction**：需在隔离 `CODEX_HOME` 用 Codex 自身自动压缩阈值真实触发，观测 `owner=codex` 的压缩事件、压缩后同一 childId 继续并复述压缩前标记、中断/恢复、无重复派单；**不得**用调大窗口、关闭压缩、自建摘要或删 compaction item 代替。
2. **真实原版 Codex Desktop**：GUI 一键聚合、选择器同时列出 GPT-6 Luna 与 Go DeepSeek、退出后登录/配置恢复。
3. **真实 GPT-6 Luna**：请求级收据只允许 `gpt-6-luna`，无其他 GPT 型号、无自动 fallback。
4. **真实 OpenCode Go `deepseek-v4.1-flash`**：授权成功 + 推理 200 + 公共 ID/真实模型/出站 model 三者一致。
5. **N04 摘要导出裁决**：按契约绝对条款移除 `/api/codex/history/export` 的可达路径，或由所有者书面豁免并写入 V2 状态文档。

**恢复条件（统一）**：所有者在具体动作上批准真实测试额度（GPT-6 Luna / Go）与时间窗，并指定隔离 `CODEX_HOME`、`MG_CONFIG_DIR`、日志路径；A5 在冻结源码 SHA 后重新执行，回执绑定该 SHA。**没有额度也不换型号**；GPT 只准 `gpt-6-luna`。

## 6. 结论

- **发布门禁**：`ready:false`。**产品级首个阻断：`MG-R006`（Codex 原生压缩未真实通过）**；门禁遍历首个 `failedRequirement` 为 `MG-R001`（`PASS_MOCK`）。
- 12 条 MG-R 中，V2 当前树没有任何一条取得**本轮目标**上的 `PASS_REAL`；`MG-R005`/`MG-R012` 的 `PASS_REAL` 绑定旧树，按契约“换树即失效”不得视为本轮完成。
- 独立套件在集成镜像上 11/12 通过；唯一失败项是摘要导出路径未裁决（`FAIL`），另有 2 项高危反绕过缺口（findings F1/F2）需 Lead 修复。
- 本证据不宣告任何 mock/静态检查为真实验收通过。
