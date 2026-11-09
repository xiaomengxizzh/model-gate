# 请求生命周期契约 v0（MG-002）

状态：**未冻结**（实现已完成，离线验收 AC-1..AC-7 通过；冻结待独立 review 与真实上游对照）。本契约定义数据面单次请求的预算（deadline）、取消（AbortSignal）与 SSE 背压语义，是 MG-002 的实现与验收依据。改动需同步 `docs/reference/configuration.md` 与开发计划。

实现与证据（2026-11-09）：`src/budget.js`（预算/取消原语）、`src/request.js`（CONNECT/等头/退避可中止）、`src/forward.js`（排队取消、链循环钳制、流式中止收尾）、`src/sse.js`（背压与流式预算）、`src/index.js`（请求入口预算与 504 信封）；离线验收 `scripts/test/offline/deadline.test.mjs`（13 用例）随默认套件运行（`npm test` 14/14 套件通过）。

## 1. 术语

| 术语 | 含义 |
| --- | --- |
| 整体预算 | 由 `defaults.timeout.overallMs` 声明的单次数据面请求墙钟上限；`0`（默认）= 不设全局上限 |
| deadlineAt | 请求进入网关时刻 + 整体预算；预算为 0 时为 `null` |
| 预算耗尽 | `Date.now() >= deadlineAt` |
| 取消 | 客户端断开或预算耗尽导致的中止；两种原因不得混淆 |
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

已发出的响应头、状态码、已写内容不撤回；客户端可通过错误事件识别预算耗尽。

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
