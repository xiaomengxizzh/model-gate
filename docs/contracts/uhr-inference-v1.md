# UHR 推理契约与回执 v1（M5-1 / T-AGENT-01）

状态：**契约 + 纯函数实现已交付**；实现 `src/routing/inference-receipt.js`，验收
`scripts/test/offline/inference-receipt.test.mjs`（12 项）。
接线方（forward.js / UHR 适配层）由 M1-3/M3-3 负责；本模块不选候选、不发请求、不记账。

## 1. 这份契约解决什么

一次跨模型推理结束时，审计要能回答四个问题，且答案不能靠"事后从日志里猜"：

1. 谁在什么授权下发起（caller / scope）；
2. 用了哪个授权候选，精确到 `model/provider/protocol/generation`（上游看到的 = 回执写的）；
3. 终态是什么（与 M1-1 的 attempt 阶段一一对应）；
4. 用量多少 —— **不知道就写 `unknown`，绝不填 0**。

`modelgateInfer(uhrReceipt)` 是纯函数：只读输入、不取墙钟、不写日志、无随机，同输入必然同输出，
输出深度冻结。它可以被重复调用做"回执复核"。

## 2. 输入

```js
{
  caller: { ref, kind? },                    // 调用者（UHR 会话/CLI/子代理）
  scope: {                                    // 任务作用域（授权边界）
    ref, authorized: true, expiresAt,
    currency: 'USD',
    candidates: [{ model, provider }],        // 授权候选集（必须非空）
    allowOfficial?: false                     // 是否允许官方订阅身份进入本作用域
  },
  request: { id, submittedAt },               // 请求引用与发起时刻
  budget: { timeMs | deadlineAt, costMicro, currency },   // 时间 + 费用预算
  attempts: [{                                // 至少一个；按发生顺序
    attemptId, phase,                         // succeeded/failed/cancelled_unsent/sent_unknown/tool_risk/stop_reconcile
    route: { model, provider, protocol, generation, providerKind? },
    startedAt?, finishedAt?
  }],
  decision?,      // M3-1 decide() 结果（只用 action/code/target）
  ledger?,        // M3-2 账本 receipt（status/actualMicro/currency/attemptId）
  usage?,         // 'unknown' | { verified: true, inputTokens, outputTokens, costMicro }
  expectedRoute?  // 上游实际收到的路由（与 attempt.route 三方对齐）
}
```

金额一律 **micro 整数**（1e-6 货币单位）+ 显式币种；`budget/scope/ledger` 币种必须一致，
**不做任何汇率换算**。

## 3. 输出（成功）

```js
{
  ok: true, contract: 'uhr-inference-v1', version: 1,
  refs: {
    callerRef: 'caller_<24hex>', callerKind,
    scopeRef: 'scope_<24hex>',
    requestId: 'req_<24hex>',
    attemptIds: ['att_<24hex>', ...]
  },
  terminal: 'SUCCEEDED' | 'FAILED' | 'CANCELLED_UNSENT' | 'SENT_UNKNOWN' | 'TOOL_RISK' | 'STOP_RECONCILE',
  unknownUsage: boolean,
  usage: 'unknown' | { known: true, inputTokens, outputTokens, totalTokens, costMicro, currency, unit: 'micro', source },
  cost: { known, micro, currency, unit: 'micro', source: 'upstream' | 'ledger' | 'ledger_released' | 'not_sent' | 'unknown' },
  route: { model, provider, protocol, generation, providerKind },   // exact route
  routeExact: true,
  attempts: [{ attemptId, phase, terminal, sent, route, startedAt, finishedAt }],
  budget: { timeMs, costMicro, currency },
  window: { submittedAt, finishedAt, elapsedMs, deadlineAt },
  authorization: { candidates: ['model|provider'], officialAllowed, scopeExpiresAt },
  decision: { action, code } | null,
  ledger: { attemptId, status, actualMicro, currency } | null,
  receiptHash: '<sha256>'      // 对除自身外的 body 做 canonical JSON 哈希
}
```

### 3.1 为什么引用只给哈希

四类引用（caller/scope/request/attempt）都由 `sha256` 派生短 id，前缀标明种类。
明文引用（会话 id、工作区 id、请求 id）只存在于各自模块内部，不出现在回执、日志或错误里；
`hashRef(kind, raw)` 是对外唯一的派生规则，便于把回执与内部日志对上。模型/供应商名保留，
因为它们必须能和"上游看到的"逐字比对。

## 4. 终态与 attempt 阶段（与 M1-1 对齐）

| attempt 阶段 | 终态 | 是否发送过字节 | usage 能否为已知 |
| --- | --- | --- | --- |
| `succeeded` | `SUCCEEDED` | 是 | 是（需 verified 用量） |
| `failed` | `FAILED` | 是 | 是（同上） |
| `cancelled_unsent` | `CANCELLED_UNSENT` | 否 | 是，且**必须是 0** |
| `sent_unknown` | `SENT_UNKNOWN` | 是 | **否，必须 unknown** |
| `tool_risk` | `TOOL_RISK` | 是 | 按验证情况（通常 unknown） |
| `stop_reconcile` | `STOP_RECONCILE` | 是 | **否，必须 unknown** |

多 attempt 时的优先级：`TOOL_RISK` > `STOP_RECONCILE` > `SENT_UNKNOWN` > `CANCELLED_UNSENT` > `SUCCEEDED`/`FAILED`
（末两个看最后一个已发送 attempt 是否 succeeded）。未知阶段一律拒绝，不猜。

`decision.code === MG_FB_STOP_RECONCILE` 同样归约为 `STOP_RECONCILE`：
"可能已提交且无可信续传"时，回执不得假装这次推理有确定结论。

## 5. 收敛条件与拒绝码

| 检查 | 拒绝码 |
| --- | --- |
| 输入形状/缺 attempt/缺时间戳/未知阶段/route 缺字段 | `UHR_REJECT_BAD_REQUEST` |
| 缺 caller | `UHR_REJECT_IDENTITY` |
| scope 未授权/缺到期/发起前已过期 | `UHR_REJECT_SCOPE` |
| attempt 路由不在授权候选集；官方订阅未 `allowOfficial` | `UHR_REJECT_CANDIDATE` |
| 实际耗时 > 时间预算 | `UHR_REJECT_TIME_BUDGET`（details 带 timeMs/elapsedMs） |
| 已知费用 > 费用预算 | `UHR_REJECT_COST_BUDGET`（details 带预算/实际 micro） |
| attempt.route ≠ decision.target 或 ≠ expectedRoute | `UHR_REJECT_ROUTE_MISMATCH`（details 带 field/expected/received） |
| 上游用量与账本结算金额不一致；账本 attemptId 不在列表 | `UHR_REJECT_USAGE_MISMATCH` / `UHR_REJECT_BAD_REQUEST` |
| 币种缺失或不一致 | `UHR_REJECT_CURRENCY` |

拒绝也返回**冻结对象**，`details` 只放白名单字段（枚举值、数字、`model|provider` 标签），
不含密钥、URL、请求正文或上游错误体。超预算时"拒绝"而不是"降级成更便宜的候选"：
回执只描述已经发生的事实，不负责改选。

## 6. 未知用量的三条硬规则

1. `SENT_UNKNOWN` / `STOP_RECONCILE` **按定义**输出 `usage: 'unknown'`，即使调用方给了数字也不采信；
2. 没有 `verified: true` 的用量、或 token 数不完整 ⇒ `usage: 'unknown'`，同时用 `cost` 单独表达"钱是否已知"；
3. `CANCELLED_UNSENT` 是"确证未发送"，usage 是**已知的 0**（`source: 'not_sent'`）——这不是未知。

未知用量不会被回执"抹成 0"，额度仍由 M3-2 账本的 `reserved/unknown` 预留占着，直到 `reconcile` 收口。

## 7. 与 M3-1 / M3-2 的连接

- **M3-1**：`decision.target` 的 `model/provider`（若带 `protocol/generation` 也比）必须与 `route` 一致。
  M3-1 的 `STOP_RECONCILE` 映射成本契约的 `STOP_RECONCILE` 终态。
- **M3-2**：`ledger.status === 'settled'` 时以 `actualMicro` 为权威费用；`released` ⇒ 0；`reserved/unknown` ⇒ 费用未知。
  账本 `attemptId` 必须能在回执 `attemptIds` 里找到（链路完整性），币种必须一致。

## 8. 幂等与不可变

- 同输入同输出：`receiptHash` 对 body 做排序键的 canonical JSON 哈希，与对象键顺序无关；
- 输出递归 `Object.freeze`，调用方试图改写会抛 `TypeError`（严格模式），不会"改了但没人知道"；
- 无墙钟读取：时间只来自 `submittedAt / finishedAt / deadlineAt`，因此可离线复算。

## 9. 未验证 / 非目标

- **NOT_RUN**：真实 UHR 调用、真实计费结算、真实上游用量回传；本契约只用注入事实做单元验收。
- 非目标：候选选择（M3-1）、金额记账（M3-2）、协议转换（E4/interop）、UHR 侧任务编排。
- `providerKind` 在 route 里是可选标签；官方判定接受 `official_subscription` 与 `official` 两种写法。
