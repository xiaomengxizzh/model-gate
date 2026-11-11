# 智能跨模型 Fallback 决策（E5）

状态：**已接入 `src/forward.js` 的 Codex 聚合路径**（2026-11-11，分支 `dev/codex-aggregation-20261111`）；非聚合请求仍走原有 forwardChain，本模块不参与。
实现：`src/routing/decision.js`（纯函数，零第三方依赖、零 IO）；验收：`scripts/test/offline/codex-fallback.test.mjs`；集成与真实上游验证由后续阶段单独授权。

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

筛选是硬过滤（不满足即出局，不参与打分），顺序固定，拒绝原因稳定可审计：

| 顺序 | 检查 | 拒绝原因码 |
| --- | --- | --- |
| 1 | `authorized === true` | `unauthorized` |
| 2 | 非官方订阅 | `official_subscription_excluded` |
| 3 | 应急候选需 `emergency.acknowledged` | `emergency_not_acknowledged` |
| 4 | 非当前/已尝试目标 | `same_target` / `already_tried` |
| 5 | 能力匹配（chat/embedding 等） | `capability_mismatch` |
| 6 | 模态覆盖 | `modality_unsupported` |
| 7 | 上下文窗口 | `context_exceeded`（开启 `requireVerifiedContext` 时 `context_unverified`） |
| 8 | v2 任务可读性 | `task_unreadable` |
| 9 | 工具/托管工具支持 | `tools_unsupported` / `hosted_tools_unsupported` |
| 10 | 健康（熔断/冷却） | `unhealthy`（冷却到点按 half-open 放行一次） |
| 11 | 预算/费用闸门 | `budget_exceeded` / `cost_unknown` |

通过过滤的候选按确定性评分排序：`priority*1000 + halfOpen*100 + errorRate*10 + costUsd*1000`，四舍五入到 1e-6；同分以 `model`、`provider` 字典序、最后输入顺序打破。评分与输入顺序无关，同一输入永远得到同一结果。

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
| 预算耗尽（任一维度） | `stop_with_error / MG_FB_BUDGET`（不降级） |
| 400/422 确定性拒绝 | `stop_with_error / MG_FB_BAD_REQUEST` |
| 官方订阅 + 402 且未确认应急 | `stop_with_error / MG_FB_OFFICIAL_QUOTA` |
| 重放不安全（阶段/风险） | `stop_with_error / MG_FB_SIDE_EFFECT_REPLAY_BLOCKED` |
| 可重试 + 次数未用尽 + 等待在预算内 + 费用闸门通过 | `retry_same`（`MG_FB_RETRY_<CLASS>`） |
| 可换候选 + 次数未用尽 + 存在可用候选 | `failover`（`MG_FB_FAILOVER_<CLASS>`） |
| 候选池为空或全被过滤 | `stop_with_error / MG_FB_NO_CANDIDATE` |
| 重试/换模型次数用尽 | `stop_with_error / MG_FB_ATTEMPTS_EXHAUSTED` |
| 其他 | `stop_with_error / MG_FB_<CLASS>` |

`<CLASS>` 取值：`RATE_LIMITED`、`UPSTREAM`、`QUOTA`、`MODEL_UNAVAILABLE`、`AUTH`、`NETWORK`、`TIMEOUT`、`STREAM_INTERRUPTED`。

## 7. 预算与费用

输入（`budget`）：`limits.requestUsd / taskUsd / dailyUsd`（0 = 不限）与 `spent.*`；`enforceUnknownCost` 默认 `true`。

- **费用估算可注入**：`estimateCost(candidate, ctx) -> usd`；未注入时读 `candidate.estimatedCostUsd` 或 `candidate.pricing.estimatedCostUsd`。返回非有限或负数按"未知"处理。
- **健康可注入**：`healthOf(candidate) -> {state, cooldownUntilMs, errorRate}`；未注入时读 `candidate.health`。注入器异常按"无健康信息"回退到候选快照。
- **未知费用 fail-closed**：付费候选 + 已配置预算上限 + 未注入估算 = 拒绝（`cost_unknown`），绝不假设免费。
- **预算影响显式输出**：决策带 `budget.nextUsd`（本次动作预计新增费用）、`budget.remaining`、`budget.exceededBy`。
- **不降级**：任一维度 `spent >= limit` 直接停机；重试预计会突破上限也停机，不会改选更便宜候选来绕过上限。候选级"费用超限"过滤只用于换模型时的正常筛选。

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
  budget: { limits, spent, nextUsd, remaining, exceededBy },
  audit: {                // 最小化审计：类别、状态、阶段、次数、候选拒绝原因
    policy, phase, errorClass, errorStatus, replaySafe, replayReason,
    attempts, limits, board: { current, supplied, eligible, skipped },
    request: { capability, promptTokens, tools, hostedTools, requiresV2TaskRead, sideEffectRisk, streaming },
    emergency, costGate
  }
}
```

审计只记录模型/供应商/错误类别/次数/预算/是否回退等最小字段；**不回显候选对象、凭据、请求体或上游错误正文**（有回归断言）。

## 9. 与 D4 / D7 的对应

| 决策 | 本模块落点 |
| --- | --- |
| D4 按错误类别/功能/可读性/上下文/费用/工具副作用判断 | §4 分类 + §5 过滤 + §6 决策表；`assessReplaySafety` 把"工具已产生副作用"变成硬门 |
| D4 不调用未授权收费服务 | `authorized` 硬过滤；未授权候选即使更便宜也不会被选中；stop 决策 `willIncurCost=false` |
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
- 循环里对非主目标的官方 provider 直接跳过（"官方订阅不进通用池"）；用户直接选择的官方 slug 仍作为主目标（current）。
- 未授权候选即使更便宜也不会被选中；全部候选不可用时 `stop（MG_FB_NO_CANDIDATE）`。

### 10.5 预算

- `defaults.codexBudget.requestUsd` 按每次尝试前的单次估算累计（`models.<名>.costEstimateUsd` > `providers.<名>.costEstimateUsd`）。
- `taskUsd` / `dailyUsd` 已接线但 **spent 恒 0（未接费用账本）**，文档与交付均标 NOT_RUN。
- 任一维度耗尽 → `stop（MG_FB_BUDGET，HTTP 402）`，不切更便宜候选。

### 10.6 日志

每次决策一行：`codex fallback decision action=… code=… phase=… error=… model=… provider=… target=… budgetNextUsd=…`；不含令牌、请求正文或上游错误正文。

### 10.7 已知限制

- failover 的**目标**由决策器选出，但链仍按配置顺序推进（不重排）；候选集合一致，顺序可能与评分不同。
- 流内工具检测只匹配事件名（不解析正文），避免额外拷贝与误判；重连后的新流同样会包装。
- `partially_committed` 无自动信号（见 10.2）。
- `taskUsd` / `dailyUsd` 未接真实费用账本。

## 11. 验证

- 决策单元套件：`node --test scripts/test/offline/codex-fallback.test.mjs`（29 项，全绿；已自动纳入 `npm test` 白名单）。
- 接入套件：`node --test scripts/test/offline/codex-fallback-forward.test.mjs`（10 项，全绿）：429→retry_same、5xx→failover、402/404→failover、tool_call 后断流→stop、内容交付后断流→stop、官方 402 未确认→stop / 确认→failover、官方候选不进池（被列入目录也不选）、预算耗尽→stop、400→stop、非聚合模型旧行为不变。
- 覆盖：错误分类表、阶段迁移（合法/回退/终态）、重放安全、429 Retry-After 等得下/等不下、5xx/402/404/401/400 分支、副作用/流已交付/部分提交/取消、v2 不可读、未授权候选、官方订阅排除、官方额度手动应急、预算耗尽与未知费用、注入式费用估算、候选过滤原因、评分确定性、triedTargets 去重、审计脱敏。
- "无未授权费用 / 无重复外部操作"断言：所有 stop 决策 `willIncurCost=false` 且 `target=null`；所有 failover 目标 `authorized=true` 且非官方订阅。

**NOT_RUN**：真实上游调用、真实 Codex CLI/Desktop 端到端、`forward.js` 集成后的真实客户端行为、真实计费结算、`taskUsd` / `dailyUsd` 费用账本。

## 12. 未决与风险

- 费用估算依赖接入方注入；未注入时对免费候选按 0 处理、对付费候选 fail-closed（可能误停，但不会超支）。
- 客户端执行类工具（local_shell 等）在 `accepted` 阶段的 5xx 被视为可重放；若未来出现上游侧执行同类工具的路径，需要把风险标为 `possible`。
- `context_unverified` 默认不拦截（兼容 `maxContext=0` 表示不限的既有语义）；需要严格上下文保证时打开 `requireVerifiedContext`。
- 阶段推进依赖接入方在每个可观测点显式调用；漏标会让状态机过于乐观，因此接入时必须成对测试。
- 接入层尚未自动标记 `partially_committed`：多轮任务在"部分提交"后若上游失败，可能被当作可 failover；需要上层在提交点接线。
- 接入层按链顺序推进（不重排），因此决策器的评分排序只用于"是否允许/目标是否合法"，不保证实际先试最优候选。
