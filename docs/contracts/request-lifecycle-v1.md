# 请求生命周期契约 v0（MG-002）

状态：**未冻结**（实现已完成，离线验收 AC-1..AC-7 通过；冻结待独立 review 与真实上游对照）。本契约定义数据面单次请求的预算（deadline）、取消（AbortSignal）与 SSE 背压语义，是 MG-002 的实现与验收依据。改动需同步 `docs/reference/configuration.md` 与开发计划。

实现与证据（2026-11-09）：`src/budget.js`（预算/取消原语）、`src/request.js`（CONNECT/等头/退避可中止、429 错误体限读与 Retry-After 预算）、`src/forward.js`（排队取消、链循环钳制、流式中止收尾、429 收尾/不熔断/非幂等不重放）、`src/retry-policy.js`（429 归因与不重放判定，§9）、`src/sse.js`（背压与流式预算）、`src/index.js`（请求入口预算与 504 信封）；离线验收 `scripts/test/offline/deadline.test.mjs`（13 用例）与 `scripts/test/offline/retry-governance.test.mjs`（10 用例）随默认套件运行（`npm test` 28/28 套件通过）。

## 1. 术语

| 术语 | 含义 |
| --- | --- |
| 整体预算 | 由 `defaults.timeout.overallMs` 声明的单次数据面请求墙钟上限；`0`（默认）= 不设全局上限 |
| deadlineAt | 请求进入网关时刻 + 整体预算；预算为 0 时为 `null` |
| 预算耗尽 | `Date.now() >= deadlineAt` |
| 取消 | 客户端断开或预算耗尽导致的中止；两种原因不得混淆（实现：`budget.reason` 只有 `client_closed`/`request_timeout`，调用方用 `cancelled()`/`timedOut()` 区分；`expired()` 仅表示「已中止」） |
| 排队 | 429 rateUntil 等待、provider 并发信号量、模型并发信号量、QPS 令牌等待 |
| 流式阶段 | 上游响应头已到达、SSE 中继进行中（含断流续传） |

## 2. 预算覆盖范围

整体预算**从数据面请求进入 handler 起算**，覆盖以下全部阶段；当前实现只覆盖 `forward()` 的重试循环，必须收敛：

1. 读取客户端请求 body（含慢客户端/半截 body）；
2. 鉴权前的 body 预读（虚拟模型 Key 路径）；
3. 全部排队等待（QPS 令牌、provider 并发、模型并发、429 rateUntil 等待与退避 `settle()`、链轮空转 `_sleep(300)`）；
4. 代理 CONNECT 隧道建立；
5. 上游建连与响应头等待（firstByte）；
6. 非流式响应体读取；
7. SSE 中继、断流续传重连与空闲/无事件看门狗；
8. 模型兜底链循环（`loopMs` 上限进一步被整体预算钳制）。

每个阶段的有效上限 = `min(该阶段配置值, 剩余预算)`；剩余预算 ≤ 0 时立即以预算耗尽收尾，不再发起新连接、新重试或新续传。

## 3. 取消源与语义

| 取消源 | 触发 | 行为 |
| --- | --- | --- |
| 客户端断开 | 响应未结束时 `res` 触发 `close`，或请求 `aborted` | `reason=client_closed`：立即销毁上游 socket/流、移除排队 waiter、归还已获取的信号量、清空全部定时器；不写任何响应；不计上游失败、不熔断 |
| 预算耗尽 | 定时器到达 deadlineAt | `reason=request_timeout`：同上销毁与释放；响应头未发出 → `504` JSON 信封（见 §4）；已进入流式 → 以流内错误事件收尾（见 §4） |
| 网关关闭 | `close()` 排空超时 | 允许沿用现有 close 语义，不要求逐请求区分 |

排队取消规则：

- waiter 必须可从队列中移除，被移除的 waiter 不得在后续 release 时被唤醒并继续执行（不得出现“取消后仍发起上游请求”）。
- 已预留的 QPS 令牌在取消后归还（避免取消把令牌余额永久打成负数）。
- `release()` 只在成功获取后进行恰好一次；取消路径不得重复释放。

## 4. 响应语义

### 4.1 响应头未发出

返回 `504`，信封与现有数据面错误一致：

```json
{ "error": { "message": "请求超时：超出整体预算 300ms（defaults.timeout.overallMs）", "type": "request_timeout" } }
```

客户端断开导致的中止不返回响应（socket 已不可写）。

### 4.2 已进入流式

保持现有 SSE 错误收尾形态（`endInterruptedStream`）：

1. `data: {"error":{"message":"...","type":"stream_interrupted","code":"REQUEST_TIMEOUT"}}`;
2. `data: [DONE]`;
3. `res.end()`；上游流与定时器必须已销毁。

启用 Codex 投影的原生 Responses 流使用单个 `response.failed` 终态（`error.code=REQUEST_TIMEOUT`）收尾。网关在流结束前持有请求预算和上游并发槽位。客户端可从错误事件识别预算耗尽，已发出的状态码和内容保留。

## 5. SSE 背压

- 每次写客户端都检查 `res.write()` 返回值；返回 `false` 后**暂停读取上游流**，等待 `drain`。
- 等待 `drain` 的超时 = `WRITE_WAIT_MS`（内置 30000ms，与 idle 看门狗相互独立）；超时视为客户端不再消费：销毁客户端连接与上游流，按 client_closed 记账，不计上游失败。
- 未写出缓冲上限 `MAX_CLIENT_BUFFER_BYTES`（内置 8MiB）：`res.writableLength` 超过上限立即中止，禁止无界缓冲。
- 背压等待期间必须仍响应取消信号（客户端断开/预算耗尽）与 `noEventMs` 看门狗语义。

## 6. 兼容与默认值

- `overallMs=0`（默认）时：不新增任何全局超时，既有 `connectMs/firstByteMs/idleMs/loopMs` 语义不变；**客户端断开取消永远生效**（此前仅流式阶段处理，排队/等待阶段会泄漏）。
- `overallMs>0` 时：该值是硬上限，包含流式阶段；长生成任务需由用户显式调大或设为 0。
- 管理面请求（`/api/*`）不在本契约范围；不因 MG-002 改变管理面的错误信封。
- 探测/预热/回切探活（`probe/warm/probeChat`）不在本契约范围，保持现状。

## 7. 可观测性

- 预算耗尽：`log.warn('request timeout', ...)`，含 `overallMs`、实际耗时、是否已开始流式、模型/上游（不记正文与凭据）。
- 客户端断开：`log.warn('request canceled (client closed)', ...)`，同一请求只记一次。
- 背压超时：`log.warn('client write stalled')`，含 `writableLength` 与等待时长。

## 8. 验收（AC）

| ID | 场景 | 判定 |
| --- | --- | --- |
| AC-1 | 满队列 + 小 `overallMs` | 排队中的请求按预算结束并返回 504，不发起上游请求；不破坏队列（后续请求可正常获得槽位） |
| AC-2 | 代理 CONNECT 挂起（TCP 接受但不应答） | 在预算内结束并返回 504，隧道 socket 关闭 |
| AC-3 | 慢上游响应头（超过预算） | 预算内返回 504；上游连接被销毁；不再继续重试/切换 |
| AC-4 | 客户端在排队/上游等待/流式中途断开 | 上游 socket 关闭、waiter 移除、信号量归还；网关不继续为该请求发起新上游请求 |
| AC-5 | 流式阶段预算耗尽 | 客户端收到 SSE 错误事件 + `[DONE]`；上游流销毁；不再续传 |
| AC-6 | 慢客户端背压 | 客户端 `write` 返回 false 后网关暂停读取上游；`drain` 后恢复；等待超限或缓冲超限时中止且不无界缓冲 |
| AC-7 | 慢 body | 读取 body 受预算约束，超时返回 504 并释放连接 |

以上全部使用离线 mock 覆盖（OS 临时配置目录 + 动态回环端口 + 本地 mock 上游），不触达真实上游；不引入任何第三方依赖。

## 9. 429 / Retry-After / 非幂等不重放（G1 治理，2026-11-09）

429 是「限流/额度」语义，不是上游故障：必须原样回给客户端并保留可重试信号；含工具语义的请求非幂等，禁止自动重放。实现：`src/retry-policy.js`（零依赖纯函数：归因/等待预算/工具判定）、`src/request.js`（限长错误体 + Retry-After 预算）、`src/forward.js`（429 收尾/不熔断/不重放）；离线验收 `scripts/test/offline/retry-governance.test.mjs`。

### 9.1 归因

上游 429 只读**最多 8KB** 错误体做保守文本归因（`classify429`），归因固定四类；匹配不到一律 `unknown`，不臆造：

| attribution | 语义 | 典型文本 |
| --- | --- | --- |
| `platform_quota` | 账户额度/计费停服（等 Retry-After 无意义） | `insufficient_quota`、`quota`、`余额`、`额度` |
| `model_capacity` | 单模型容量/过载 | `overloaded`、`capacity`、`busy`、`并发` |
| `rate_limit` | 请求速率/频率限制（有 Retry-After 但无文本也归此类） | `rate limit`、`too many requests`、`rpm`、`频率` |
| `unknown` | 匹配不到 | — |

### 9.2 Retry-After 与请求预算

- `Retry-After` 支持秒数与 HTTP-date；解析失败视为「上游未提供」，退回指数退避。
- 等待必须同时满足：≤ 剩余整体预算 − 50ms（`retryWaitCap`）且 ≤ 单次上限 30s。**等不下就不等**：立即停止重试，把最后的状态/归因/Retry-After 交给上层，绝不空等越过 deadline。
- 429 上游冷却（`throttle.rateUntil`）同样只在剩余预算内等待；冷却超出预算的上游直接跳过。
- deadline 真正触发时仍是 §4 的 `504 request_timeout`/aborted，不因 429 治理改成 429；预算耗尽不计上游失败、不熔断（§3 语义不变）。

### 9.3 响应语义

响应头未发出时，429 原样返回（不得吞成 502）：

```json
{ "error": { "message": "上游限流（429）：rate_limit，已按请求预算停止重试", "type": "rate_limited",
  "code": "MG_429_RATE_LIMIT", "attribution": "rate_limit", "upstream_status": 429,
  "retry_after_ms": 5000, "attempts": 2 } }
```

同时回 `Retry-After: <秒>` 响应头（`retry_after_ms=0` 回 `0`；上游未提供则不发明响应头）。`attempts` 为本次请求实际发起的上游调用次数（含同上游重试）。已进入流式阶段（§4.2）仍只能以流内错误事件收尾，不改已发出的状态码。

### 9.4 熔断与记账

- 429 **不计入熔断**（不 `markFail`、不打开 `circuit`），只做上游级冷却 `min(Retry-After, 60s)`：一次限流不该把可用上游打进冷宫。
- 429 仍计入 `errors`/`retries` 统计与延迟样本（账目不被吞）。
- 链/预算结束时，若**最后一次**失败是 429（含所有上游都在 429 冷却中），按 §9.3 回 429；若最后一次失败是 5xx/网络错，仍回 502。

### 9.5 非幂等不重放

`isToolBearingBody(body)` 为真（`tools` 非空、Responses `input` 含 `tool_call`/`function_call`、消息含 `role: "tool"` 或 `tool_calls`）即视为非幂等，除非调用方显式覆盖（`forwardChain` 的 `opts.noReplay`）：

- 同一上游**只发一次**（`forward(..., { noRetry: true })`）：不按 `retry.maxAttempts` 重试，杜绝同一上游对同一请求执行两次；
- 整条链**最多走一轮**：本轮内仍允许换下一个上游/模型继续尝试（可用性优先——Codex CLI / DSH 每轮都带工具定义，tool 请求若失去 fallback 会整体拖垮这类 agent 流量），但绝不回到队首重复整条链；
- 一轮链走完仍失败：按 §9.3/§9.4 收尾（最后一次是 429 回 429，否则 502），不再做循环兜底；
- 流式断流续传（§2.7）不属本条，语义未变。

取舍（明确记录）：切断的是「同一上游对同一请求的重复执行」；代价是某上游失败后不再回到队首重试（原有循环兜底对 tool 请求失效），但保留「换一个上游/模型试一次」的可用性兜底。

### 9.6 验收

`scripts/test/offline/retry-governance.test.mjs`（11 用例，随默认 `npm test` 运行）：四类归因、Retry-After 解析与预算钳制、429 原样返回（`Retry-After` 头 + `MG_429_*` + attempts，不是 502）、Retry-After 等得下才等（真等待后 200）、等不下立即 429 且上游只被调用一次、连续 429 不打开熔断、普通请求仍按 `retry.maxAttempts` 重试、tool 请求同上游不重试但可换一次上游且不回队首重放、预算耗尽仍是 504 且不计上游失败。全部离线 mock；真实上游 429 与真实客户端重放行为未对照（`NOT_RUN_LIVE`）。

