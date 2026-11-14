# ModelGate 聚合模式独立验收结论（基线 2026-11-14）

## 0. 结论

被测树 `2f641a975a6345f086aca0d547ab5f0e2523a28c` 的发布门禁为 **`ready:false` / `status:'BLOCKED'`**。

- 12 项需求中**0 项**取得真实目标上的 `PASS_REAL`；门禁第一个失败项是 `MG-R001`。
- `MG-R012` 因缺少所有者授权的 GPT-6 Luna 调用额度与时间窗而 `BLOCKED`（客观阻断，非降级）。
- 其余 11 项 `NOT_TESTED`：没有在真实产品路径上执行过，不是“通过”。
- 本轮新增的离线套件只证明**门禁本身诚实**（不虚报、不误放行），不证明任何产品能力，也不改变上述状态。

本结论不因任何开发者“已完成”声明而上调。要改变它，只能提交真实目标上的 `PASS_REAL` 证据并通过 `scripts/test/offline/aggregation-gate.js`，再由所有者批准。

## 1. 被测对象与环境

| 项目 | 值 |
| --- | --- |
| 提交（被测树） | `2f641a975a6345f086aca0d547ab5f0e2523a28c`（`feat/agg-a5-acceptance`，HEAD） |
| 交付基线（状态采集点） | `a9f32c976f5415adb898c31605b362b25d2ee6aa`；该点之后到被测树只改文档/测试清单/`package.json`，未改 `src/**` |
| Node / npm | `v24.22.2` / `11.19.1`，Ubuntu 26.04 x86_64 |
| 验收来源 | [产品契约](../product/2026-11-14-owner-product-contract.md) §1–§2；[执行计划](../roadmap/2026-11-14-aggregation-pseudocode-plan.md) §I；[接口 ADR](../architecture/2026-11-14-aggregation-interfaces.md) §8 |
| 状态来源 | [聚合基线证据](aggregation-baseline-2026-11-14.md) §5 |
| 运行方式 | 纯离线；未启动/停止任何既有进程，未读取任何凭据文件，未联网，未产生付费调用 |

## 2. 门禁调用

```bash
node scripts/test/offline/aggregation-gate.js --baseline --sha 2f641a975a6345f086aca0d547ab5f0e2523a28c
```

门禁逻辑（`scripts/test/offline/aggregation-gate.js`）：任一需求缺少经校验的 `passedAllOnRealTarget` ⇒ `{ready:false, status:'BLOCKED', failedRequirement:<id>}`；全部满足后仍要求 `ownerApproval === true`。校验器只承认同时具备完整 40 位 SHA、可复制命令、含 `traceId` 的回执、`realTarget:true`，且计划内每个用例都 `passed` 且未 `skipped` 的 `PASS_REAL`。

### 2.1 顶层输出

```json
{
  "ready": false,
  "status": "BLOCKED",
  "failedRequirement": "MG-R001",
  "failedRequirements": ["MG-R001", "MG-R002", "MG-R003", "MG-R004", "MG-R005", "MG-R006", "MG-R007", "MG-R008", "MG-R009", "MG-R010", "MG-R011", "MG-R012"],
  "reason": "not_tested",
  "canAskOwnerToMerge": false,
  "ownerApproval": false,
  "headSha": "2f641a975a6345f086aca0d547ab5f0e2523a28c"
}
```

### 2.2 逐项阻塞原因与解除条件

| 需求 | 门禁状态 | 门禁 reason | 阻塞事实（基线原文） | 解除条件（精确前置） |
| --- | --- | --- | --- | --- |
| MG-R001 | `NOT_TESTED` | `not_tested` | 缺 P03 的一键流程与状态持久化实现 | 原版 GUI 内 activate/deactivate 全流程 + 重启一致性；`src/codex/desktop-integration.js` 与聚合视图落地 |
| MG-R002 | `NOT_TESTED` | `not_tested` | 真实桌面登录身份与额度归属未验证 | 真实 Desktop 登录（不重置 `auth.json`）+ 官方模型请求回执；需所有者授权真实调用 |
| MG-R003 | `NOT_TESTED` | `not_tested` | `src/aggregation/discovery.js` 不存在 | 真实 Console/Go 目录快照 ↔ GUI/Desktop 清单双向对账；分页穷尽、无静默遗漏 |
| MG-R004 | `NOT_TESTED` | `not_tested` | 需所有者授权在真实 Desktop 内操作 | 原版 Desktop 选择器逐一选择官方/Go/Console 模型，回执核对供应商 |
| MG-R005 | `NOT_TESTED` | `not_tested` | 需真实 CLI 会话与额度窗口 | 原生日志含 parent/child thread id 且无 MCP/外部调度；需真实会话 |
| MG-R006 | `NOT_TESTED` | `not_tested` | 需真实父子线程回执 | 同一 childId 两轮任务 + 工具回执 + interrupt/resume + 无重复派单 |
| MG-R007 | `NOT_TESTED` | `not_tested` | `src/codex/desktop-integration.js` 不存在 | 空白安装与已有配置安装各自 GUI 测试，原子写 + 无损回滚 |
| MG-R008 | `NOT_TESTED` | `not_tested` | 需 P06 独立反向用例 | 产品路径上的强制失败反向用例：typed error、零静默替换、目录不截断 |
| MG-R009 | `NOT_TESTED` | `not_tested` | 需第二个测试身份，属授权项 | 两个独立身份的跨租户读写/刷新/日志脱敏测试；需授权创建第二身份 |
| MG-R010 | `NOT_TESTED` | `not_tested` | 需在可丢弃实例上做前后一致性比对 | 导入/回滚前后配置字节一致 + 异常中断恢复；可丢弃实例演练 |
| MG-R011 | `NOT_TESTED` | `not_tested` | 其余阶段的 PASS_REAL 证据尚不存在 | 每个阶段交付绑定 SHA + 命令 + 环境的脱敏回执 |
| MG-R012 | `BLOCKED` | `blocked_on_prerequisite` | 需所有者授权的 Luna 调用额度与时间窗；无资格则保持 BLOCKED，不代换模型 | 所有者书面授权额度/时间窗 + 请求级收据证明 `model=gpt-6-luna` 且无其他 GPT 回退 |

### 2.3 完整输出

```json
{
  "ready": false,
  "status": "BLOCKED",
  "failedRequirement": "MG-R001",
  "failedRequirements": [
    "MG-R001",
    "MG-R002",
    "MG-R003",
    "MG-R004",
    "MG-R005",
    "MG-R006",
    "MG-R007",
    "MG-R008",
    "MG-R009",
    "MG-R010",
    "MG-R011",
    "MG-R012"
  ],
  "reason": "not_tested",
  "canAskOwnerToMerge": false,
  "ownerApproval": false,
  "headSha": "2f641a975a6345f086aca0d547ab5f0e2523a28c",
  "requirements": [
    {
      "id": "MG-R001",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "缺 P03 的一键流程与状态持久化实现"
    },
    {
      "id": "MG-R002",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "真实桌面登录身份与额度归属未验证"
    },
    {
      "id": "MG-R003",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "`src/aggregation/discovery.js` 不存在"
    },
    {
      "id": "MG-R004",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "需所有者授权在真实 Desktop 内操作"
    },
    {
      "id": "MG-R005",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "需真实 CLI 会话与额度窗口"
    },
    {
      "id": "MG-R006",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "需真实父子线程回执"
    },
    {
      "id": "MG-R007",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "`src/codex/desktop-integration.js` 不存在"
    },
    {
      "id": "MG-R008",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "需 P06 独立反向用例"
    },
    {
      "id": "MG-R009",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "需第二个测试身份，属授权项"
    },
    {
      "id": "MG-R010",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "需在可丢弃实例上做前后一致性比对"
    },
    {
      "id": "MG-R011",
      "status": "NOT_TESTED",
      "passed": false,
      "reason": "not_tested",
      "detail": "其余阶段的 PASS_REAL 证据尚不存在"
    },
    {
      "id": "MG-R012",
      "status": "BLOCKED",
      "passed": false,
      "reason": "blocked_on_prerequisite",
      "detail": "需所有者授权的 Luna 调用额度与时间窗；无资格则保持 BLOCKED，不代换模型"
    }
  ],
  "unmappedEvidence": []
}
```

## 3. 为什么当前是 0 项 `PASS_MOCK`

`PASS_MOCK` 的定义是“用例本身在模拟目标上执行过”。P06 的 33 个用例全部要求 GUI、原版 Desktop、真实账户或真实原生会话；本基线不存在这些产品面（聚合视图、发现器、Desktop 集成层均缺失），因此**没有任何用例被以 mock 方式执行**，也就不能登记 `PASS_MOCK`。

现有 782 个离线用例证明的是**支撑不变量**，不是 P06 用例，按契约 §2 只能作为额外静态检查：

| 现有离线证据 | 实际证明 | 不能证明 |
| --- | --- | --- |
| `codex-config` / `config-transaction` | 原子写、CAS、回滚的库级语义 | Desktop 一键流程、崩溃恢复、409 三方 diff（MG-R001/R007/R010） |
| `codex-catalog` / `codex-catalog-coherence` | 目录零碰撞与形状校验 | 真实账户全量发现、目录不截断（MG-R003/R008） |
| `codex-target-authz` / `codex-p09-native-proxy` | 回环 mock 上的授权域与投影不变量 | 真实登录身份、额度归属、真实子线程（MG-R002/R005/R006） |
| `codex-v2-*` / `responses-*` | 协议投影与终态语义 | 原生 Agent Team 的 followup/interrupt/resume 真实闭环（MG-R006） |

## 4. 本轮新增资产及其边界

| 资产 | 作用 | 不证明什么 |
| --- | --- | --- |
| [验收矩阵](aggregation-acceptance-matrix.md) | 契约 → 12 行 × 33 用例的可判定表，生成式、不可手改 | 不是证据，不产生任何 `PASS_REAL` |
| `scripts/test/offline/aggregation-gate.js` | 门禁与证据校验（SHA/命令/回执/用例/脱敏/SHA 绑定） | 不能验证回执真伪（需人工比对上游日志） |
| `scripts/test/offline/aggregation-matrix.js` | 从契约/计划/基线生成矩阵，漂移即失败 | 不重新观测任何状态 |
| `aggregation-acceptance-{gate,matrix,redaction,audit}.test.mjs` | 证明门禁不会放过 mock、缺证据、伪造回执、泄密证据、被改写或降级的候选 | 不执行任何产品用例 |
| [反降级审计规则](aggregation-anti-downgrade-audit-2026-11-14.md) | 对候选 diff 的七条硬规则 + 人工步骤 | 启发式可被绕过，需人工复核 |

## 5. 复现与有效期

```bash
npm run check
npm test
npm run docs:check
node scripts/check-metadata.mjs
node scripts/check-product-contract.mjs
node scripts/test/offline/aggregation-matrix.js --check
node scripts/test/offline/aggregation-gate.js --baseline
```

- 本结论绑定 `2f641a9`。任何 `src/**`、证据或断言变化都会使本结论过期：必须用新 SHA 重跑门禁，旧回执不得复用（契约 §4）。
- 门禁脚本在仓库内，只防误漂移，不构成防篡改；真正的权威需要所有者控制的只读快照与外部检查（契约 §3）。
- 本轮基线全量：`77 suites / 782 tests passed, 0 failed, 1 skipped`；临时登记 4 个验收套件后：`81 suites / 823 tests passed, 0 failed, 1 skipped`（既有 opt-in CLI 跳过）。登记已用 `git restore scripts/test/run.mjs` 撤销，交付不修改测试清单。

## 6. 后续审查者不得声称

1. 不得以“782 个离线用例全绿”或“验收套件 15/8/7/11 全绿”声称任一 MG-R 通过——这些只证明支撑不变量与门禁自身。
2. 不得把 `PASS_MOCK`、CLI 回放、MCP 调度、HTTP 探针写成 `PASS_REAL`；契约 §2 明确此类结果不得签收。
3. 不得在未取得 Luna 授权额度时声称 MG-R002/MG-R012 通过，也不得用其他 GPT 模型“代跑”。
4. 不得用单个 provider 的快照声称“全部 OpenCode 模型”（MG-R003），也不得在目录超限时静默删模型（MG-R008）。
5. 不得引用本文件为“已验收通过”；它的字面结论是 `ready:false`。
