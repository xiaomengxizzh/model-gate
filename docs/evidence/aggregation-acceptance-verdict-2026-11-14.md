# ModelGate 聚合模式独立验收结论（当前门禁，被测树 `4feafe0`）

> 本页是**当前**发布门禁结论。上一版记录的是合并前基线 `2f641a9`（12 项全 `NOT_TESTED`，
> `MG-R012` 为 `BLOCKED`）；该历史快照已被本页取代，仅保留为起点记录。
> 矩阵 [aggregation-acceptance-matrix.md](aggregation-acceptance-matrix.md) 由证据文档生成，
> 与本页同源；两者任一处手工改动都会在 `npm test` 中失败。

## 0. 结论

被测树 `4feafe0e51dc02d48c45734df5b34e70d3679bd5` 的发布门禁为 **`ready:false` / `status:'BLOCKED'`**。

- 12 项需求中 **1 项**取得真实目标上的 `PASS_REAL`：`MG-R012`（仅 GPT-6 Luna，请求级收据，
  见 [真实 Luna 验收](aggregation-real-luna-2026-11-14.md)）。
- 其余 11 项没有真实目标回执；门禁第一个失败项是 `MG-R001`，`reason: pass_mock_cannot_release`。
- `PASS_MOCK` 不是通过，`NOT_TESTED` 不是通过，一项 `PASS_REAL` 也不构成发布条件。
- 即使把 `ownerApproval` 置为 `true`，门禁仍为 `ready:false`——所有者批准不能替代逐项真实证据。

## 1. 被测对象与环境

| 项目 | 值 |
| --- | --- |
| 提交（被测树） | `4feafe0e51dc02d48c45734df5b34e70d3679bd5`（`mg-codex-native`） |
| Node / npm | `v24.22.2` / `11.19.1`，Ubuntu x86_64 |
| 验收来源 | [产品契约](../product/2026-11-14-owner-product-contract.md) §1–§2；[执行计划](../roadmap/2026-11-14-aggregation-pseudocode-plan.md) §I |
| 状态来源 | [真实 Luna 验收](aggregation-real-luna-2026-11-14.md)、[整合证据](aggregation-integration-2026-11-14.md) §8、[P01 发现证据](agg-p01-opencode-discovery-2026-11-14.md) §5 |
| 证据记录 | [aggregation-real-luna-2026-11-14.json](aggregation-real-luna-2026-11-14.json) |
| 性质 | 离线门禁 + 一条真实上游回执；未在 Desktop GUI 上执行任何用例 |

## 2. 门禁调用

```bash
node scripts/test/offline/aggregation-gate.js \
  --evidence docs/evidence/aggregation-real-luna-2026-11-14.json
```

门禁逻辑（`scripts/test/offline/aggregation-gate.js`）：任一需求缺少经校验的 `passedAllOnRealTarget`
⇒ `{ready:false, status:'BLOCKED', failedRequirement:<id>}`；全部满足后仍要求 `ownerApproval === true`。
校验器只承认同时具备完整 40 位 SHA、可复制命令、含 `traceId` 的回执、`realTarget:true`，
且计划内每个用例都 `passed` 且未 `skipped` 的 `PASS_REAL`。

### 2.1 顶层输出

```json
{
  "ready": false,
  "status": "BLOCKED",
  "failedRequirement": "MG-R001",
  "failedRequirements": ["MG-R001", "MG-R002", "MG-R003", "MG-R004", "MG-R005", "MG-R006",
                         "MG-R007", "MG-R008", "MG-R009", "MG-R010", "MG-R011"],
  "reason": "pass_mock_cannot_release",
  "canAskOwnerToMerge": false,
  "ownerApproval": false,
  "headSha": "4feafe0e51dc02d48c45734df5b34e70d3679bd5"
}
```

### 2.2 逐项状态与解除条件

| 需求 | 门禁状态 | 门禁 reason | 阻塞事实 | 解除条件（精确前置） |
| --- | --- | --- | --- | --- |
| MG-R001 | `PASS_MOCK` | `pass_mock_cannot_release` | 未在真实 Desktop 执行一键接入/退出与重启一致性 | 原版 GUI 内 activate/deactivate 录屏 + 回执 + 重启后状态一致 |
| MG-R002 | `PASS_MOCK` | `pass_mock_cannot_release` | `official-gpt-6-luna-real` 已有请求级真实回执；`codex-official-login-unchanged` 只有运行期元数据未变，无登录/登出/切换测试 | 补登录/登出/切换前后身份与元数据对比，且不重置既有登录 |
| MG-R003 | `PASS_MOCK` | `pass_mock_cannot_release` | 真实 Console/Go 目录未对账 | 分页穷尽的目录快照 ↔ GUI/Desktop 清单双向对账 |
| MG-R004 | `NOT_TESTED` | `not_tested` | 原版 Desktop 选择器未实际操作 | 在 Desktop 逐一选择官方/Go/Console 模型并核对供应商回执 |
| MG-R005 | `PASS_MOCK` | `pass_mock_cannot_release` | 原生子代理 `BLOCKED`：真实 CLI 父进程需可写 `CODEX_HOME`（禁止使用所有者目录、禁止复制凭据）；该树亦无 OpenCode Go 凭据 | 真实父/子线程日志（parent/child thread id + 工具回执），且子模型可用 |
| MG-R006 | `NOT_TESTED` | `not_tested` | 依赖真实子线程；无活跃子线程，中断/恢复未执行 | 同一 childId 两轮任务 + 工具回执 + 取消/恢复 + 无重复派单 |
| MG-R007 | `PASS_MOCK` | `pass_mock_cannot_release` | 未做空白安装与已有配置的真实 GUI 演练 | 空白 HOME 与已有配置两套 GUI 流程 + 字节级回滚 |
| MG-R008 | `PASS_MOCK` | `pass_mock_cannot_release` | `no-silent-fallback` 已有真实 401 负向对照，但未配置候选回退，无回退只被弱证明；工具/目录两例未在真实路径执行 | 配置真实回退候选后强制失败，证明零替换；工具与目录不截断各自取证 |
| MG-R009 | `PASS_MOCK` | `pass_mock_cannot_release` | 第二真实身份未创建（授权项） | 两个独立身份的跨租户读写/刷新/日志脱敏测试 |
| MG-R010 | `PASS_MOCK` | `pass_mock_cannot_release` | 可丢弃实例演练未做 | 导入/回滚前后字节一致 + 异常中断恢复 |
| MG-R011 | `PASS_MOCK` | `pass_mock_cannot_release` | 本阶段新增一条真实回执，其余阶段仍缺真实目标回执 | 每个阶段绑定 SHA + 命令 + 环境 + 脱敏回执 |
| MG-R012 | `PASS_REAL` | `proven_on_real_target` | —（已通过） | 保持：仅 Luna、请求级核验、无自动回退 |

## 3. 为什么仍然不能发布

1. 12 项里只有 1 项有真实目标回执；契约 §2 要求正式交付的每一项都具备 `PASS_REAL`。
2. `PASS_MOCK` 只证明离线套件执行过相应行为，不能替代 Desktop/GUI/真实账户。
3. 本阶段没有 Desktop GUI 运行、没有模型选择器观测、没有真实目录对账、没有原生父子线程，
   因此 MG-R001/R003/R004/R005/R006/R007/R009/R010 的真实面全部缺席。
4. 一项 `PASS_REAL` 不等于"聚合模式可用"；`MG-R012` 只约束"真实 GPT 测试只能用 Luna"这条边界。

## 4. 复现与有效期

```bash
npm run check
npm test
npm run docs:check
node scripts/check-metadata.mjs
node scripts/check-product-contract.mjs
node scripts/test/offline/aggregation-matrix.js --check
node scripts/test/offline/aggregation-gate.js --evidence docs/evidence/aggregation-real-luna-2026-11-14.json
```

- 本结论绑定 `4feafe0e51dc02d48c45734df5b34e70d3679bd5`。任何 `src/**`、证据或断言变化都会使本结论过期；
  必须用新 SHA 重跑门禁，旧回执不得复用（契约 §4）。
- 门禁脚本在仓库内，只防误漂移，不构成防篡改；权威判定需要所有者控制的只读快照与外部检查（契约 §3）。

## 5. 后续审查者不得声称

1. 不得以"离线套件全绿"声称任一 MG-R 通过——离线结果只证明支撑不变量与门禁自身。
2. 不得把 `PASS_MOCK`、CLI 回放、MCP 调度、HTTP 探针写成 `PASS_REAL`。
3. 不得在未取得 Luna 额度时声称 `MG-R002` 整行通过，也不得用其他 GPT 模型代跑。
4. 不得把本页的 `MG-R012 PASS_REAL` 外推为"聚合模式已验收"；本页字面结论是 `ready:false`。
