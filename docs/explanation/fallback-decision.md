# 智能跨模型 Fallback 决策（E5）

状态：**已接入 `src/forward.js` 的 Codex 聚合路径**（2026-11-11，分支 `dev/codex-aggregation-20261111`）；非聚合请求仍走原有 forwardChain，本模块不参与。
实现：`src/routing/decision.js`（纯函数，零第三方依赖、零 IO）+ `src/routing/facts.js`（候选事实信封与新鲜度）+ `src/routing/ledger.js`（持久预算账本，M3-2）。
验收：`scripts/test/offline/codex-fallback.test.mjs`（旧契约 29 项）、`scripts/test/offline/routing-decision.test.mjs`（证据/排序/对账 15 项）、`scripts/test/offline/routing-ledger.test.mjs`（预算账本 13 项）；真实上游验证仍由后续阶段单独授权。

本页解释**为什么**这样决策以及契约边界。配置字段见 [配置参考](../reference/configuration.md)，请求预算/取消/SSE 边界见 [请求生命周期契约](../contracts/request-lifecycle-v1.md)，模块边界见 [架构说明](architecture.md)。

## 1. 要解决的问题

跨模型 fallback 的收益是可用性，风险是**重复计费**与**重复外部操作**：上游可能已经执行了 shell/MCP/hosted 工具，或已经向客户端发出可见内容，此时"再换一个模型"不是恢复，而是把一次任务变成两次却伪装成一次。

因此本模块不回答"哪个模型最好"，只回答四个动作之一：

| 动作 | 语义 | 是否产生新上游调用 |
| --- | --- | --- |
| `continue` | 放行/继续当前请求（发送前选候选，或已有进展无需干预） | 发送前选候选 = 是；已进行中 = 否 |
| `retry_same` | 同一上游再试一次（受 Retry-After/退避与预算约束） | 是 |
| `failover` | 换到另一个**已授权**候选（模型可同、provider 可不同） | 是 |
| `stop_with_error` | 显式失败，附稳定错误码 + 原因 + 用户可执行动作 | **否** |

非目标：不做真实上游探测、不读配置、不写日志、不改 `forward.js`。接入点由 E5 集成阶段完成。

## 2. 三条不可协商的约束

1. **副作用优先于可用性（D4）**：阶段一旦进入工具副作用、已交付可见流、任务部分提交，任何重试/换模型都被拒绝。"没收到结果"不等于"没执行"。
2. **授权与身份隔离（D4/D7）**：候选必须 `authorized === true`；官方订阅（`providerKind: 'official_subscription'`）**永不进入通用 fallback 池**；官方额度耗尽只能由用户显式确认后进入第三方应急，禁止自动换池。
3. **预算超限停机（D4）**：单请求/单任务/日累计任一维度耗尽即停机，不允许为了继续服务而自动切到更便宜的候选（"悄悄降级"）。

## 3. 请求阶段状态机

阶段是单调推进的；`advancePhase()` 只接受合法迁移，非法回退返回 `MG_FB_PHASE_INVALID`。

```text
unsent --上游受理--> accepted_no_side_effect --出现工具/hosted 副作用--> tool_side_effect
   |                        |                                            |
   +--客户端取消--+          +--向客户端交付有效内容--> stream_delivered
                  |          |                                            |
                  |          +--任务部分提交--------> partially_committed
                  +---------> user_cancelled（终态）
```

| 阶段 | 含义 | 允许自动重放 |
| --- | --- | --- |
| `unsent` | 未发送 | 是（发送前只是候选选择） |
| `accepted_no_side_effect` | 上游已受理，但无工具/hosted 副作用证据 | 视请求的副作用风险（见 §4） |
| `tool_side_effect` | 已出现工具或 hosted 工具副作用 | **否** |
| `stream_delivered` | 已向客户端交付有效内容/流 | **否**（拼接另一模型输出等于伪装无中断） |
| `partially_committed` | 任务/会话已部分提交 | **否** |
| `user_cancelled` | 客户端/用户取消（终态） | **否** |

合法迁移：`unsent -> {accepted, user_cancelled}`；`accepted -> {tool_side_effect, stream_delivered, partially_committed, user_cancelled}`；`tool_side_effect -> {stream_delivered, partially_committed, user_cancelled}`；`stream_delivered -> {tool_side_effect, partially_committed, user_cancelled}`；`partially_committed` 与 `user_cancelled` 无出边。

## 4. 错误分类与重放安全

`classifyError()` 输出稳定类别与两个判定：`retryableSame`（同上游重试是否有意义）、`failoverable`（换候选是否有意义）；`deterministic` 表示换模型也一样失败。

| 上游事实 | 类别 | 同上游重试 | 可换候选 |
| --- | --- | --- | --- |
| 429（含 Retry-After） | `rate_limited` | 仅当 Retry-After/退避在剩余预算内 | 是 |
| 5xx（500-599） | `upstream_unavailable` | 是 | 是 |
| 402 / 余额、额度停服 | `quota_exhausted` | 否（余额不会退避回来） | 是 |
| 404 / 模型不存在 | `model_unavailable` | 否 | 是 |
| 400 / 422 | `bad_request`（`upstreamFault: true` 时按 `upstream_unavailable`） | 否 | **否**（确定性） |
| 401 / 403 | `auth_failed` | 否 | 是（换另一供应商凭据可能成功） |
| 传输层错误（ECONNRESET/ENOTFOUND 等） | `network_error` | 是 | 是 |
| 超时（ETIMEDOUT / request_timeout / 408） | `timeout` | 是 | 是 |
| 流中断 | `stream_interrupted` | 视阶段（已交付内容后禁止） | 视阶段 |
| 客户端取消 | `user_cancelled` | 否 | 否 |
| v2 加密任务不可读 | `v2_task_unreadable` | 否 | **否**（备用模型同样读不懂密文） |
| 工具已产生副作用 | `tool_side_effect` | 否 | 否 |

重放安全（`assessReplaySafety()`）叠加阶段与请求副作用风险：

| 阶段 | 请求副作用风险 | 重放 |
| --- | --- | --- |
| `unsent` | 任意 | 安全 |
| `accepted_no_side_effect` | `none`（纯文本 / 仅客户端执行类工具） | 安全 |
| `accepted_no_side_effect` | `possible`（hosted 工具等） | 仅"处理前拒绝"类别安全：429/402/404/400/422/401/403 |
| `accepted_no_side_effect` | `occurred` | 禁止 |
| 工具副作用 / 已交付流 / 部分提交 / 已取消 | 任意 | 禁止 |

副作用风险默认由请求推导：带 hosted 工具则为 `possible`，否则为 `none`；调用方可用 `request.sideEffectRisk` 覆盖。客户端执行类 function/local_shell 工具只有在 `tool_side_effect` 阶段出现后才被视为已发生副作用。

## 5. 候选筛选

筛选是硬过滤（不满足即出局，不参与排序），顺序固定，拒绝原因码稳定可审计。候选有两种形状，**同一候选集合里可以混用**：

- **evidence（推荐）**：`candidate.facts = { identity, authorization, capabilities, pricing, health }`，每条事实都是
  `{ value, source, observedAt }` 证据信封（见 `src/routing/facts.js`）。没有信封、没有观测时间、超过 `maxAgeMs`、
  或算不出年龄（未注入时钟）**一律按未知处理**：未知 ≠ 支持、未知 ≠ 免费、未知 ≠ 已授权。
- **legacy（兼容）**：没有 `facts` 的旧扁平候选（当前 `forward.js` 形状），按调用方显式声明的字段放行，
  语义与 M3-1 之前一致；`audit.board.skipped[].factMode` 与 `audit.facts.candidates` 会标出用了哪一层。

**混池规则（M3-1b 返工，E 的对抗用例）**：只要候选池里**存在任一 evidence 候选**，legacy 候选的
**能力声明就不得用于入围/排序**（按 `capability_unproven` 处理）。否则"把请求工具复制进候选"这种伪造能力
可以击败合法 evidence 候选（实测老实现 `eligible=2` 且选中 forged-legacy）。legacy-only 池仍然可用，
但审计必须留痕：`audit.facts.capabilityTrust = 'legacy_only'`、`audit.board.legacyUnverifiedCapability = ['model|provider', ...]`，
被选中的目标带 `capabilitySource: 'legacy_declared'`（legacy-only）或 `'evidence'`。

> **生产候选必须用 `facts` 构造。** `src/forward.js` 把请求里的工具复制成候选能力
> （`tools:{types: requestInfo.tools.slice(), hosted: ...}`）是**已知的待接线缺陷**，由 M1-3/M3-3 修复；
> 在接线完成前，线上走的就是 legacy 语义 + 上面这些审计标记，不能宣称"能力已被证据支持"。

**官方订阅判定只有一个入口（`identityOf`，M3-1b）**：evidence 看
`facts.identity.value.kind ∈ { official, official_subscription }`（大小写/空白归一化，`value.official === true` 也算），
legacy 看 `providerKind`、显式 `official/subscription` 标记，以及调用方传入的 `officialIdentities` 名单（如 `['openai']`）。
**只写身份名字却没有任何 kind 的 legacy 候选按"身份未证明"处理**，不再默认当第三方放行。
D7 的 402 闸门走同一个入口：官方命中（或 evidence 模式下身份无法证明）⇒ `MG_FB_OFFICIAL_QUOTA` 停机，
不会自动换到第三方/账单身份。

| 顺序 | 检查（evidence 模式） | 拒绝原因码 |
| --- | --- | --- |
| 1 | 授权事实 proven 且 `value === true` | `authorization_unproven`（缺证据/过期）/ `unauthorized` |
| 2 | 身份事实 proven | `identity_unproven` |
| 3 | 非官方订阅（`kind !== 'official_subscription'`） | `official_subscription_excluded` |
| 4 | 请求点名身份时必须一致 | `identity_conflict` |
| 5 | 应急候选需 `emergency.acknowledged` | `emergency_not_acknowledged` |
| 6 | 非当前/已尝试目标 | `same_target` / `already_tried` |
| 7 | 能力事实 proven，且 capability/模态/上下文/可读性/工具覆盖需求 | `capability_unproven`（未知/过期）/ `capability_mismatch` / `modality_unsupported` / `context_exceeded` / `context_unverified` / `task_unreadable` / `tools_unsupported` / `hosted_tools_unsupported` |
| 8 | 健康：冷却中/熔断中排除；未知只降权（warning `health_stale` / `health_unknown`） | `unhealthy` |
| 9 | 价格事实 proven 且已知；有上限时未知报价即排除 | `quote_unknown` / `budget_exceeded` / `worst_case_exceeds_budget` / `budget_unverified` |

legacy 模式沿用旧码（`unauthorized` / `official_subscription_excluded` / `capability_mismatch` / …），
费用未知仍报 `cost_unknown`；两种模式共用 `EXCLUDE` 常量，差别只在"未知是否算证据"。

**为什么能力不能从需求继承**：M3-1 之前接入层把请求的 `tools` 复制成候选能力，于是"候选支持工具"只是把需求抄了一遍。
evidence 模式现在要求候选自己带 `capabilities` 证据；顶层 `tools.types` 与需求一致也不再被采信。

排序（不是评分，是字典序比较，因此不存在"四舍五入后同分"的隐蔽顺序依赖）：

1. **显式兼容性**：`request.preferredTarget` / `request.explicitTargets` 点名，或候选显式声明 `explicitCompatibility`；
2. **健康**：`closed` > `half_open` > 未知（未知来自缺失/过期健康事实）；
3. **价格**：已知价格升序，未知价格排在已知之后；
4. **配置 tieBreak**（`candidate.tieBreak`，legacy 兼容 `priority`）；
5. **model / provider 码点字典序**（不用 `localeCompare`，不依赖宿主 locale）。

被打乱的输入顺序必须得到同一选择与同一审计（含 `excluded` 列表本身也按 model/provider/原因稳定排序）。
`candidate.score` 只是给日志看的紧凑编码，**不是**排序依据。

## 6. 决策表

| 阶段 / 错误 | 决策 |
| --- | --- |
| 无错误 + `unsent` | `continue`：返回评分最优的已授权候选 |
| 无错误 + 其他阶段 | `continue`：不产生新调用 |
| `user_cancelled` 或取消类错误 | `stop_with_error / MG_FB_CANCELLED` |
| v2 不可读 | `stop_with_error / MG_FB_TASK_UNREADABLE` |
| `tool_side_effect` 或副作用类错误 | `stop_with_error / MG_FB_SIDE_EFFECT_REPLAY_BLOCKED` |
| `stream_delivered` | `stop_with_error / MG_FB_STREAM_DELIVERED` |
| `partially_committed` | `stop_with_error / MG_FB_PARTIAL_COMMIT` |
| 调用方已取消 | `stop_with_error / MG_FB_CANCELLED` |
| 请求截止已到 | `stop_with_error / MG_FB_DEADLINE` |
| 上一次尝试可能已提交且无可信续传 | `stop_with_error / MG_FB_STOP_RECONCILE`（先对账，不换下一个候选） |
| 预算耗尽（任一维度） | `stop_with_error / MG_FB_BUDGET`（不降级） |
| 400/422 确定性拒绝 | `stop_with_error / MG_FB_BAD_REQUEST` |
| 官方订阅 + 402 且未确认应急 | `stop_with_error / MG_FB_OFFICIAL_QUOTA` |
| 重放不安全（阶段/风险） | `stop_with_error / MG_FB_SIDE_EFFECT_REPLAY_BLOCKED` |
| 可重试 + 次数未用尽 + 等待在预算内 + 费用闸门通过 | `retry_same`（`MG_FB_RETRY_<CLASS>`） |
| 可换候选 + 次数未用尽 + 存在可用候选 | `failover`（`MG_FB_FAILOVER_<CLASS>`） |
| 候选池为空或全被过滤（混合原因） | `stop_with_error / MG_FB_NO_CANDIDATE` |
| 全部候选只因预算/报价原因出局 | `stop_with_error / MG_FB_BUDGET_EXCEEDED`（F-b2；`audit.board.exclusionCause='budget'`） |
| 重试/换模型次数用尽 | `stop_with_error / MG_FB_ATTEMPTS_EXHAUSTED` |
| 其他 | `stop_with_error / MG_FB_<CLASS>` |

`<CLASS>` 取值：`RATE_LIMITED`、`UPSTREAM`、`QUOTA`、`MODEL_UNAVAILABLE`、`AUTH`、`NETWORK`、`TIMEOUT`、`STREAM_INTERRUPTED`。

## 7. 预算与费用

决策器只消费一个 `budget` 输入：`limits.requestUsd / taskUsd / dailyUsd`（0 = 不限）、`spent.*`、
`spendKnown.*`（已花费是否可信）、`spendSource.*`（`spent` / `ledger` / `unset`）、`unit`（`usd` 或 `micro`）、
`currency`、`enforceUnknownCost`（默认 `true`）。

- **费用估算可注入**：`estimateCost(candidate, ctx) -> usd`；未注入时读 `candidate.estimatedCostUsd` 或 `candidate.pricing.estimatedCostUsd`。返回非有限或负数按"未知"处理。
- **健康可注入**：`healthOf(candidate) -> {state, cooldownUntilMs, errorRate}`；未注入时读 `candidate.health`。注入器异常按"无健康信息"回退到候选快照。
- **未知费用 fail-closed**：证据模式 + 已配置上限 + 没有可信报价 = 拒绝（`quote_unknown`，审计 `exceededBy=unknown_cost`）；legacy 模式保持旧语义（付费候选报 `cost_unknown`）。绝不假设免费。
- **已花费不可验证也 fail-closed**：配置了 `taskUsd/dailyUsd` 上限却没给对应 `spent`（且没给 `ledger`）时报 `budget_unverified`——不再把"不知道"当成 0。
- **不降级**：任一维度 `spent >= limit` 直接停机；重试预计会突破上限也停机，不会改选更便宜候选来绕过上限。
- **停机码可区分预算**：换模型/选候选时如果所有候选都只因预算类原因出局，返回 `MG_FB_BUDGET_EXCEEDED`
  （`audit.board.exclusionCause='budget'`），而不是笼统的 `MG_FB_NO_CANDIDATE`；混合原因保持 NO_CANDIDATE。
- **最坏情况**：证据模式可用 `pricing.worstCaseUsd`；`spent + worstCase` 超限即 `worst_case_exceeds_budget`。

### 7.1 持久预算账本（`src/routing/ledger.js`，M3-2）

决策器是纯函数，不落盘、不记账；"这个请求/任务/今天已经花了多少"由账本唯一拥有。账本契约：

| 约束 | 落点 |
| --- | --- |
| 整数最小单位 | 所有金额是 `micro`（1e-6 货币单位）整数；`quote.amountMicro / actualMicro` 拒绝浮点、NaN、超安全整数 |
| 显式币种 | `openLedger({currency})` 与每笔 `quote.currency`/`settle({currency})` 必须一致；不一致报 `LEDGER_CURRENCY_MISMATCH`，**从不换算** |
| 单写者持久化 | 进程内互斥 + 跨进程 `ledger.lock`（`O_EXCL`，含 pid/token，死进程残锁可抢占）+ `tmp/fsync/rename` + 目录 `fsync` |
| 重启恢复 | `openLedger` 同步回读落盘状态；`recover()` 返回在途/未知预留（含金额），可直接继续 `settle` |
| 幂等 | `(requestId, requestDigest)` 同键同摘要 → 返回既有 receipt（`duplicate:true`），不双记；同键不同摘要 → `LEDGER_IDEMPOTENCY_CONFLICT`；已核销为"未执行"的键允许重试 |
| 预留 → 执行 → 结算 | `reserve` 先落盘（`reserved`）再允许发上游；`settle` 只记一次；`release` 需显式 `verifiedNotExecuted:true` |
| 未知用量保留 | `markUnknown` 不填 0、不释放，继续占用额度；只有 `reconcile`（实际金额或已验证未执行）能收口，未知预留不会自己消失 |
| 实际超预估 | 如实记 `actualMicro` 并标 `overrun:true`；后续 `reserve` 因 caps 不足被拒（`LEDGER_CAP_EXCEEDED`，含 `dimension`） |
| 跨日 | 固定 IANA 时区日切（默认 `Asia/Shanghai`）；在途与已结算一律记**原预留日**，跨日结算不挪到新的一天 |
| 并发 | 并发 `reserve` 合计不越 caps；预留失败（额度/锁/币种/状态）零副作用 |
| 脱敏 | `requestId/requestDigest/taskRef` 只落哈希；模型/供应商/备注经 `safeLabel`；对外只有计数、币种、单位、状态码、金额 |

为避免决策器与账本出现两套金额口径，接线时用 `facts.budgetFromLedger(ledger.usage(...), { limitsMicro })`
把整数账本视图转成 `budget`：三个维度都标 `spendKnown:true` / `spendSource:'ledger'`，
账本内仍是整数，只在边界除一次 `1e6`。也可以直接给决策器 `unit:'micro'` 的 `budget`（`lim`/`spent` 是 micro 整数），
换算同样只发生一次——**绝不把 micro 整数当美元用**。

注意口径命名：账本用 `request/task/day`，决策器输出用 `request/task/daily`（adapter 负责映射）。

## 8. 输出契约

```js
{
  action,                 // continue | retry_same | failover | stop_with_error
  code,                   // 稳定错误/决策码（MG_FB_*）
  reason,                 // 人类可读原因（不含正文/凭据）
  userAction,             // 建议用户动作
  target,                 // continue/failover 时为 {model, provider, score}，否则 null
  retry,                  // retry_same 时为 {afterMs, attempt, source}，否则 null
  willIncurCost,          // 是否会发起新的上游调用（stop 恒为 false）
  estimatedCostUsd,       // 本次动作预计费用（未知为 null）
  budget: { limits, spent, spendKnown, spendSource, unit, currency, nextUsd, remaining, exceededBy },
  excluded: [             // 结构化排除理由（稳定原因码；顺序稳定，与输入顺序无关）
    { model, provider, reasons: [...], warnings: [...], factMode: 'evidence' | 'legacy' }
  ],
  audit: {                // 最小化审计：类别、状态、阶段、次数、候选拒绝原因
    policy, phase, errorClass, errorStatus, replaySafe, replayReason,
    attempts, limits, board: { current, supplied, eligible, skipped },
    request: { capability, promptTokens, tools, hostedTools, requiresV2TaskRead, sideEffectRisk, streaming },
    emergency,
    costGate: { limitsConfigured, unknownCostPolicy, unit, currency, spendSource },
    facts: { clockProvided, maxAgeMs, candidates: { evidence, legacy }, warnings },
    reconcile: { possiblyCommitted, trustedResume } | null
  }
}
```

审计只记录模型/供应商/错误类别/次数/预算/事实状态/是否回退等最小字段；**不回显候选对象、凭据、请求体或上游错误正文**
（`provenance` 只含 status/source/observedAt；来源名经 `sanitizeSource`，疑似凭据/URL → `redacted`；有回归断言）。

`stop_with_error` 的稳定码除 `MG_FB_<CLASS>` 外还有：`MG_FB_CANCELLED`（调用方取消）、`MG_FB_DEADLINE`（截止已到）、
`MG_FB_STOP_RECONCILE`（可能已提交且无可信续传：先对账，不得换下一个候选）、
`MG_FB_BUDGET_EXCEEDED`（F-b2：全部候选只因预算/报价类原因出局，与"没有合格候选"区分开）。动作集合仍是 4 个（`ACTION`），
对账停机用 `action=stop_with_error` + `code=STOP.RECONCILE` 表达，接线请判 `code` 而不是猜动作。

预算类排除原因（`budget_exceeded` / `quote_unknown` / `cost_unknown` / `worst_case_exceeds_budget` /
`budget_unverified`）**全部命中**才升级为 `MG_FB_BUDGET_EXCEEDED`；只要混入健康/授权/能力等原因，
仍报 `MG_FB_NO_CANDIDATE`，并把归因写进 `audit.board.exclusionCause`（`budget` / `mixed`），避免把问题归错因。

## 9. 与 D4 / D7 的对应

| 决策 | 本模块落点 |
| --- | --- |
| D4 按错误类别/功能/可读性/上下文/费用/工具副作用判断 | §4 分类 + §5 过滤 + §6 决策表；`assessReplaySafety` 把"工具已产生副作用"变成硬门 |
| D4 不调用未授权收费服务 | 授权事实（evidence）或 `authorized`（legacy）硬过滤；未授权候选即使更便宜也不会被选中；stop 决策 `willIncurCost=false` |
| D4 "证据而不是愿望" | 能力/身份/价格/健康一律要求 `source + observedAt`；未知或过期即不可入选，绝不从需求或官方模板继承 |
| D4 不重复计费 | `src/routing/ledger.js` 先预留后发送；(requestId,digest) 幂等；未知用量保留到对账；实际超预估封顶后续消费 |
| D4 不盲目重放工具/流 | 阶段进入 `tool_side_effect` / `stream_delivered` / `partially_committed` 后只允许 `stop_with_error` |
| D4 超预算停机而非悄悄降级 | §7：耗尽即停 + 重试费用超限即停；不自动改选便宜候选 |
| D7 官方订阅不进通用池 | `official_subscription` 恒被过滤（测试覆盖"唯一候选"与"更便宜"两种情形） |
| D7 额度耗尽需手动应急 | 官方 + 402 且未确认则 `MG_FB_OFFICIAL_QUOTA`；确认后才允许切换，审计标记 `emergency` |
| D3 x D4 任务可读性先于模型选择 | `task_unreadable` 过滤 + `v2_task_unreadable` 显式失败（不换上游） |

## 10. 已接入路径（forward.js）

`src/forward.js` 在 Codex 聚合目标上启用本模块；其它请求 `codex=null`，所有新增分支短路，行为与接入前一致。

### 10.1 触发条件

| 条件 | 说明 |
| --- | --- |
| `def.codexAggregate` / `def.codexOfficial` | `router.js` 解析目录 slug（聚合 slug / 官方 slug）时设置 |
| `defaults.codexFallback === true` | 运营显式开启，对非聚合模型也生效 |
| 聚合保留前缀（`mg-` / `mg/`） | 已配置的聚合模型同样视为聚合目标 |

### 10.2 阶段推进

| 事件 | 推进到 |
| --- | --- |
| 上游返回任意响应（成功或错误） | `accepted_no_side_effect` |
| 流内出现 `tool_calls` / `function_call` / `local_shell_call` / `web_search_call` 等事件；或非流式 2xx 响应含工具调用 | `tool_side_effect` |
| 流完整结束、已交付内容后中断、非流式 2xx 已交付 | `stream_delivered` |
| 客户端断开 / 写停滞 | `user_cancelled` |

`partially_committed` 目前**没有自动信号**（forward.js 看不到"任务是否已提交"）：决策器支持该输入，但接入层不会自行推进；需要上层在会话/任务提交点显式标记。

### 10.3 决策执行

- 失败后调用 `decide()`，动作映射：
  - `stop_with_error` → 立即收尾（流已开始则发流内 `stream_interrupted` 事件）；HTTP 状态按错误码映射（429/402/400/504/409/502）；
  - `retry_same` → 按 `afterMs` 等待（不超过剩余请求预算）后重跑同一上游；
  - `failover` → 继续配置链的下一个已授权候选。
- Codex 模式给 `forward()` 传 `noRetry: true`：同上游重试由决策器唯一拥有，避免与 `request.js` 内部重试双重计费。
- 官方订阅 402：未配置 `defaults.codexEmergency` 时直接 `stop（MG_FB_OFFICIAL_QUOTA）`；配置后才允许 failover 到第三方。

### 10.4 授权与官方候选

- `authorized` = 已配置且凭据可用的**第三方**上游（配置即授权）；官方订阅 `authorized=false`。
- 官方订阅判定统一走 `identityOf`（见 §5）：`providerKind` / identity 事实 / `officialIdentities` 名单三路归一，
  `kind:'official'` 与只写身份名字的 legacy 候选都不再能混进通用池；402 闸门同样按此判定（含 evidence 形状）。
- 循环里对非主目标的官方 provider 直接跳过（"官方订阅不进通用池"）；用户直接选择的官方 slug 仍作为主目标（current）。
- 未授权候选即使更便宜也不会被选中；全部候选不可用时 `stop（MG_FB_NO_CANDIDATE）`。

### 10.5 预算

- `defaults.codexBudget.requestUsd` 按每次尝试前的单次估算累计（`models.<名>.costEstimateUsd` > `providers.<名>.costEstimateUsd`）。
- `taskUsd` / `dailyUsd` 在 forward.js 侧**仍把 spent 恒填 0**（接线属 M3-3）：`codexBudgetOf` 只累计本请求的
  `requestUsd`，task/daily 没有账本来源。M3-2 已交付 `src/routing/ledger.js` 与 `facts.budgetFromLedger`，
  M3-3 应改为从账本取 `spent` 并置 `spendSource:'ledger'`；在那之前，配置 task/daily 上限不会真正约束消费，
  文档与交付继续标 NOT_RUN（不得当成已生效）。接线由 B 的 M1-3a 卡闭环
  （`reserve → 发送 → settle/release/markUnknown`，`receipt.status !== 'released' ⇒ possiblyCommitted ⇒ STOP_RECONCILE`）；
  当前状态与逐格证据见[支持矩阵](../roadmap/2026-11-11-support-matrix.md) 的 B7/B8，
  关闭/降级步骤见[回滚与禁用](../how-to/rollback-and-disable.md)。
- 任一维度耗尽 → `stop（MG_FB_BUDGET，HTTP 402）`，不切更便宜候选。

### 10.6 日志

每次决策一行：`codex fallback decision action=… code=… phase=… error=… model=… provider=… target=… budgetNextUsd=…`；不含令牌、请求正文或上游错误正文。

### 10.7 已知限制

- failover 的**目标**由决策器选出，但链仍按配置顺序推进（不重排）；候选集合一致，顺序可能与评分不同。
- 流内工具检测只匹配事件名（不解析正文），避免额外拷贝与误判；重连后的新流同样会包装。
- `partially_committed` 无自动信号（见 10.2）。
- `taskUsd` / `dailyUsd` 未接真实费用账本。

## 11. 验证

- 决策单元套件：`node --test scripts/test/offline/codex-fallback.test.mjs`（29 项，全绿；旧契约不变）。
- 证据/排序/对账套件：`node --test scripts/test/offline/routing-decision.test.mjs`（19 项）：授权/能力/健康/价格证据化、
  官方订阅排除、身份冲突、同分确定性（含乱序同审计）、过期健康降权、`STOP_RECONCILE`、取消/截止、脱敏、预算账本不可验证 fail-closed、
  旧形状兼容，以及 **M3-1b 返工回归**：混池里 legacy 伪造能力不得入围、legacy-only 池留痕、
  evidence 形状官方 + 402 必须停机、官方判定归一化（`kind:'official'`/名字-only/`officialIdentities`）。
- 预算账本套件：`node --test scripts/test/offline/routing-ledger.test.mjs`（13 项，真实临时目录）：整数/币种、
  幂等不双记、未知保留与 reconcile、超预估封顶、跨日 1ms 边界与原预留日归属、并发不越限、重启恢复、
  锁争用（活进程 BUSY / 死进程残锁抢占）、损坏拒绝启动、脱敏、报价时效、`budgetFromLedger` 与决策器集成。
- 接入套件：`node --test scripts/test/offline/codex-fallback-forward.test.mjs`（10 项，全绿）：429→retry_same、5xx→failover、402/404→failover、tool_call 后断流→stop、内容交付后断流→stop、官方 402 未确认→stop / 确认→failover、官方候选不进池（被列入目录也不选）、预算耗尽→stop、400→stop、非聚合模型旧行为不变。
- 覆盖：错误分类表、阶段迁移（合法/回退/终态）、重放安全、429 Retry-After 等得下/等不下、5xx/402/404/401/400 分支、副作用/流已交付/部分提交/取消、v2 不可读、未授权候选、官方订阅排除、官方额度手动应急、预算耗尽与未知费用、注入式费用估算、候选过滤原因、评分确定性、triedTargets 去重、审计脱敏。
- "无未授权费用 / 无重复外部操作"断言：所有 stop 决策 `willIncurCost=false` 且 `target=null`；所有 failover 目标 `authorized=true` 且非官方订阅。

**NOT_RUN**：真实上游调用、真实 Codex CLI/Desktop 端到端、`forward.js` 集成后的真实客户端行为、真实计费结算、
`forward.js` → 账本接线（M3-3；目前 forward 侧 `taskUsd`/`dailyUsd` 仍是 spent=0）。

账本自身的"落盘/重启/并发/跨日/锁"已有真实目录测试，不依赖 mock fs；但**没有**做真实磁盘掉电/fsync 可靠性验证，
也没有跨机器共享目录（NFS）下的锁行为验证——这两项按未验证处理。

## 12. 未决与风险

- 费用估算依赖接入方注入；未注入时对免费候选按 0 处理、对付费候选 fail-closed（可能误停，但不会超支）。
  证据模式下没有报价就是 `quote_unknown`（不管候选自称免费与否）：这是刻意的保守面。
- 账本 caps 的 `request` 维度是"本请求累计"（同一 requestId 的多次尝试叠加），`task`/`day` 是跨请求累计；
  一旦实际结算超过 caps，额度会显示为负剩余，后续预留被拒——这是"如实记账"的代价，不做静默修正。
- 账本只保证单机目录内的一致性；多机共享同一目录不在验证范围内（锁文件语义依赖本地 pid 可见性）。
- 混池会把 legacy 候选整体排除（能力按未证明处理），因此"混池"只适合过渡期：一旦接入层开始产出 evidence 候选，
  同池其它 legacy 候选就不可选中。这是刻意的保守面，不是 bug。
- `officialIdentities` 名单由接入方配置（decision 是纯函数，不读配置）；不配置时"只写身份名字"的 legacy 候选
  只会被判成"身份未证明"而排除，不会被误认成官方。
- 客户端执行类工具（local_shell 等）在 `accepted` 阶段的 5xx 被视为可重放；若未来出现上游侧执行同类工具的路径，需要把风险标为 `possible`。
- `context_unverified` 默认不拦截（兼容 `maxContext=0` 表示不限的既有语义）；需要严格上下文保证时打开 `requireVerifiedContext`。
- 阶段推进依赖接入方在每个可观测点显式调用；漏标会让状态机过于乐观，因此接入时必须成对测试。
- 接入层尚未自动标记 `partially_committed`：多轮任务在"部分提交"后若上游失败，可能被当作可 failover；需要上层在提交点接线。
- `STOP_RECONCILE` 需要调用方传入 `lastAttempt.possiblyCommitted`；forward.js 目前不传，因此"可能已提交"只能靠
  `partially_committed` 阶段兜底。M3-3 接线后应按账本 receipt 的 `reserved/unknown` 状态补这个输入。
- 接入层按链顺序推进（不重排），因此决策器的评分排序只用于"是否允许/目标是否合法"，不保证实际先试最优候选。
