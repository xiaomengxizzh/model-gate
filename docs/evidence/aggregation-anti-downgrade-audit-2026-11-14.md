# ModelGate 反降级审计规则（A5，2026-11-14）

## 1. 目的

开发者可以在不撒谎的前提下“看起来完成”：把 mock 当真实、把 CLI 当 GUI、把 MCP 当原生、少算几个模型、在同一次提交里改源码并删断言、把 skip 计成 pass、或者悄悄改需求措辞。本文把这些动作变成**可判定的硬规则**。

实现：`scripts/test/offline/aggregation-audit.js`；自证：`scripts/test/offline/aggregation-acceptance-audit.test.mjs`。规则对候选证据与候选 diff 求值，输出 `findings`（硬阻断）与 `manualSteps`（必须人工核对）。任何一条 `findings` 非空 ⇒ 拒绝签收。

## 2. 七条规则

| 规则 ID | 检测内容 | 离线判定方式 | 作用范围 |
| --- | --- | --- | --- |
| `mock-as-real` | mock 冒充真实 | `PASS_REAL` 但 `realTarget !== true`；回执 `mock:true`；命令指向 mock 却声称真实 | 自动 |
| `cli-for-gui` | CLI 冒充 GUI/Desktop | `gui-*` / `desktop-*` 用例记录的 `client` 不是 `desktop-gui`，或整条需求 `client=codex-cli` | 自动 |
| `mcp-as-native` | MCP/外部调度器冒充原生 | 原生用例 `engine !== 'codex-native'`，或回执 `nativeEngine` 为 `mcp` / `external-scheduler` | 自动 |
| `model-count-reduced` | 模型数量被缩减 | 本次 `catalog.modelCount` 低于上一版已签收值；或 `PASS_REAL` 且 `modelCount=0` | 自动 |
| `assertions-weakened` | 同一提交改源码又弱化测试 | diff 同时含 `src/**` 变更与“只删断言/删测试文件” | 自动（启发式） |
| `skipped-as-passed` | skip 计为通过 | 证据中 `passed:true` 且 `skipped:true`；或 diff 给已有测试新增 `skip` | 自动 |
| `requirement-reworded` | 需求被改写 | diff 触及 `docs/product/**` 或 `docs/roadmap/2026-11-14-aggregation*`；或契约 sha256 与钉住值不符 | 自动 |

## 3. 离线不可判定、必须人工的步骤

以下七项由 `MANUAL_AUDIT_STEPS` 固化，任何 `PASS_REAL` 签收前必须逐条留痕：

1. 核对 GUI 截图/录屏确实来自原版 ChatGPT Desktop 窗口（窗口标题、进程，而不是浏览器 mock 页）。
2. 用上游服务端日志交叉核对回执 `traceId`；开发者本机日志可被伪造，单边证据不够。
3. 人工比对原生日志的 parent/child thread id 与 spawn 事件，确认不是 MCP 或外部调度器。
4. 核对所有者书面批准记录（PR 评论/签名），而不是代理自述“已获授权”。
5. 核对 GPT-6 Luna 的账户资格与额度归属，确认没有其他 GPT 模型被调用。
6. 核对第二个测试身份的独立创建记录，确认不是同一账户的第二个 Key。
7. 把契约与基线文件同所有者控制的只读快照比对；仓库内脚本不构成真正防篡改（契约 §3 已声明）。

## 4. 对候选执行审计

最省事的方式是把 diff 直接交给门禁，由 `evaluateRelease` 同时求值门禁与七条规则：

```bash
git diff <base-sha>..<candidate-sha> > /tmp/candidate.diff
node scripts/test/offline/aggregation-gate.js \
  --evidence evidence.json --sha <candidate-sha> --owner-approval --diff /tmp/candidate.diff
```

输出中 `audit.findings` 非空时，`ready` 强制为 `false`、`reason` 为 `anti_downgrade_findings`。

也可以只对 diff 求值：

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { auditCandidate } from './scripts/test/offline/aggregation-audit.js'
const report = auditCandidate({
  diff: readFileSync('/tmp/candidate.diff', 'utf8'),
  evidence: JSON.parse(readFileSync('/tmp/evidence.json', 'utf8')),
  previous: JSON.parse(readFileSync('/tmp/last-accepted.json', 'utf8')),
  pinned: { contractSha256: '<所有者快照中的契约哈希>' },
})
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
"
```

`evidence.json` 是候选的逐需求证据记录（与 `aggregation-gate.js` 同结构）。`previous` 提供上一版已签收的 `catalog.modelCount`，用于规则 4。

## 5. 已知局限（不得当成“已审计”的借口）

- `assertions-weakened` 是行级启发式：把 `assert.equal(a, 1)` 改成 `assert.ok(true)` 不会触发，必须人工读 diff。
- `model-count-reduced` 依赖上一版证据存在；首次签收没有可比基线时只能人工核对上游目录。
- 七条规则都只审**声明与 diff**，不审**真伪**。回执可以编造；第 3 节的人工步骤是唯一补偿手段。
- 规则实现本身在仓库内，可被有写权限的人修改；规则自证套件能发现“规则被删/放宽”，但不能阻止提交者连测试一起改。独立验收的价值来自外部只读快照与所有者复核。
