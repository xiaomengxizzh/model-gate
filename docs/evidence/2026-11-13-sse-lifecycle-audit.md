# SSE 终态 / 取消 / 超时生命周期独立回归审计（G5 / P1-B）

- 日期：2026-11-13
- 任务：`task-3`（G5：SSE 终态/取消/超时生命周期独立回归，仅新增测试）
- 分支 / worktree：`feat/mg-g5-sse-protocol` / `.agents/worktrees/native-sse`
- 审计基线：`dc7d15f`（`docs: add ModelGate native delegation resolution plan`，其父 `c6d97da` 为 `integration/modelgate-release` 合入 `mg-codex-native` 的整合提交）
- 运行环境：Node.js `v24.22.2`，Linux 回环，本地 mock 上游
- 新增大型安装/下载：**无**。零第三方运行时依赖；不读取 `~/.codex/auth.json` / `~/.codex/config.toml`；不触碰生产 8787 / systemd；全部合成凭据与临时配置目录。
- 写集（仅新增，未改 `src`、`package.json`、`scripts/test/run.mjs`）：
  - `scripts/test/offline/sse-lifecycle.test.mjs`
  - `docs/evidence/2026-11-13-sse-lifecycle-audit.md`（本文件）

## 1. 目标与判定口径

路线图 §4 P1-B 要求：**保持请求预算、并发槽位和上游流在完整终态之前有效**；补齐 `response.completed`、`response.failed`、无终态、上游提前 close、客户端断开、取消、整体 deadline、长时间首字节和长流场景；**每条请求最多一个终态**；超时返回 504 或一个失败终态，不重复写终态。契约依据 `docs/contracts/request-lifecycle-v1.md` §3/§4.2/§5（§4.2 后半段明确 Codex 投影原生 Responses 流使用单个 `response.failed`，且网关在流结束前持有请求预算与上游并发槽位）。

本套件的判定口径：

1. **唯一的可观测重放证据是上游命中次数**：每个用例都断言 `upstream.hits.length`（流式用例为 1 或 2，并在沉降等待后复查不变）。
2. **唯一终态按 SSE 的 `event:` 行统计**，不统计 data JSON 里的 `"type":"response.completed"`（否则同一事件会被数两次）。
3. 只使用 `api:"responses"` + `codex:{}` 的**原生 Responses 投影路径**（`src/index.js` `proxyNativeResponses` → `streamCodexResponse` → `src/responses-stream.js` `createCodexStreamAdapter`），因为该路径才有「合成唯一失败终态」的协议责任；未声明 `codex` 的原生逐字节管道只做字节透传，不在本轮 P1-B 的终态责任范围内（见 §5 未覆盖项）。

## 2. 既有覆盖审计（改动前）

| 套件 | 已有覆盖 | 与 G5 的关系 |
| --- | --- | --- |
| `scripts/test/offline/deadline.test.mjs`（24 用例） | AC-1/1b 排队 504 与令牌归还；AC-2 CONNECT 挂起；AC-3/3b 慢头/慢体；AC-4a/4b/4c 客户端在排队/等头/流中断开；AC-4d client_closed 与 request_timeout 分类；AC-4e 已完成流不判超时；AC-5 流式预算耗尽（`stream_interrupted`+`[DONE]`）；AC-6a..6e 背压/超时/缓冲上限/断开/看门狗；AC-7 慢 body；T-LIFE-02a..2f 单调 deadline/退避 | 只覆盖 **Chat SSE** 路径；原生 Responses 的 `response.completed/failed` 终态唯一性、终态前的 provider 槽位持有均未覆盖 |
| `scripts/test/offline/responses-native.test.mjs`（7 用例） | 非流式 JSON 透传与 model 回写；原生 SSE 逐字节透传；legacy 拒绝矩阵零上游；上游 4xx 透传与慢上游 504；Codex 投影「延迟完成帧 + 保持预算至流结束」；opaque 密文零上游；「按下游是否已开流返回 504 或一次超时终态」 | 只断言「延迟完成帧能通过」「超时一次 failed」，**未覆盖**：终态后继续到达的帧、上游无终态 close、客户端断开/取消、并发槽位在终态前不得释放、长首字节 |
| `scripts/test/offline/codex-v2-stream.test.mjs`（30 用例） | `createCodexStreamAdapter` 单元层：终态支持列表；终态后帧忽略；EOF→合成 `STREAM_INTERRUPTED`；`end()`/显式 `fail` 幂等；`[DONE]` 丢弃；背压/断开 | 适配器单元语义已有，但**没有 HTTP 全链路**证据：槽位/预算是否在终态前保持、上游是否真的只命中一次、断开后是否泄漏槽位 |
| `scripts/test/offline/codex-p09-native-proxy.test.mjs`（8 用例，第 8 例） | 子原生 SSE：namespace/marker 恢复、单终态、usage once、EOF 合成 failed | 与 HTTP 路径最接近，但断言集中在投影身份与 usage，不含槽位/取消/长首字节/终态后帧 |
| `scripts/test/offline/sse-chunking.test.mjs`（7 用例） | SSE 帧解码（UTF-8/CRLF/有界）、`relayStream` 的 `[DONE]` 唯一与超限中断 | 纯进程内单元，不启动网关 |

**缺口结论**（本轮补齐的目标）：

1. 全链路上「终态帧之后到达的 completed/failed 帧」不得进入下游、不得产生第二终态；
2. 上游无终态提前 close 时全链路只合成一个失败终态，且不重发/不重放；
3. 客户端断开 / 取消（首字节前 abort）在原生投影路径上的计费语义（不计上游错误/中断）与槽位归还；
4. **2026-11-13 修复的回归**：SSE 等待终态期间请求预算与 provider 并发槽位不得提前释放；
5. 整体 deadline 在流中触发时只写一个失败终态（不是 504、不重复写）；
6. 长首字节（TTFB 接近 `firstByteMs`）不得误判超时/中断。

## 3. 新增用例（`scripts/test/offline/sse-lifecycle.test.mjs`，8 用例）

| ID | 场景 | 关键断言（含上游命中次数） | 结果 |
| --- | --- | --- | --- |
| G5-SSE-01 | `response.completed` 唯一终态，终态后上游再发 completed/failed | 下游恰 1 个终态且为 completed；`LATE_COMPLETED`/`LATE_FAILED` 不出现；上游命中 **1**；终态后上游连接被销毁（`closedAt` 非空）；沉降 250ms 后仍 1 | PASS |
| G5-SSE-02 | `response.failed` 唯一终态，上游随后发 completed | 恰 1 个终态且为 failed、`error.code` 原样保留；不追加 completed；上游命中 **1**；沉降后仍 1 | PASS |
| G5-SSE-03 | 无终态上游提前 close（`res.end()` 无终态帧） | 恰 1 个合成 `response.failed`、`code=STREAM_INTERRUPTED`；无 completed；上游命中 **1**；连接关闭；沉降后仍 1（不重放） | PASS |
| G5-SSE-04 | 客户端流式中途断开（底层 http 读到首帧后 destroy） | 上游 socket 关闭；上游命中 **1**；`global.errors=0`、`counters.interrupts=0`；`maxPerProvider=1` 下后续请求可命中（槽位归还），总命中 **2** | PASS |
| G5-SSE-05 | **终态前不释放并发槽位**（`maxPerProvider=1`，首个流挂起未终态） | 350ms 时上游命中仍 **1**、第二个请求仍未 settle；放行首个终态后首个恰 1 个 completed；第二个请求随后恰 1 个终态；总命中 **2**（每请求 1 次，无重复发送） | PASS |
| G5-SSE-06 | 取消（首字节前 `AbortController.abort()`） | 客户端以 AbortError 结束；不写任何终态；上游连接销毁；命中 **1**；`global.errors=0`；槽位归还后第二个请求命中，总命中 **2** | PASS |
| G5-SSE-07 | 整体 deadline（`overallMs=600`）在流中触发 | 200 已发出后恰 1 个 `response.failed`、`code=REQUEST_TIMEOUT`；无 completed；实际 1004ms 内收尾；上游命中 **1** 且被销毁；`global.errors=0`（预算不计上游失败）；无续传 | PASS |
| G5-SSE-08 | 长首字节（TTFB 500ms，`firstByteMs=3000`） | 200；恰 1 个 completed 且 `output_text="slow"`；实际 ≥450ms；上游命中 **1** | PASS |

说明：G5-SSE-04/05/06 复用 `defaults.concurrency.maxPerProvider=1` 作为「槽位是否泄漏/提前释放」的可观测放大器；若槽位在终态前被释放或取消后泄漏，命中次数与 settle 时序断言会立即失败。

## 4. 运行记录（本轮实际执行）

| 命令 | exit code | 结果 |
| --- | --- | --- |
| `node --test scripts/test/offline/sse-lifecycle.test.mjs` | **0** | tests 8 / pass 8 / fail 0，约 4.3s |
| 同上，连续重复 3 次 | **0** ×3 | 8/8 稳定通过，无 flaky 用例 |
| `npm test` | **0** | suites 77/77 passed（0 failed / 0 timed out / 0 not run）；tests 782 passed、0 failed、1 skipped；total 70.5s |

说明：本套件尚未登记进 `scripts/test/run.mjs` 的 `SUITES`（按任务约束由 Lead 统一登记），因此 `npm test` 的 77 套件中**不包含**它；上表的直接 `node --test` 运行是它当前的验收证据。

### 4.1 需要 Lead 登记的一行

在 `scripts/test/run.mjs` 的 `SUITES` 字面量白名单中，按字母序插入到 `'scripts/test/offline/sse-chunking.test.mjs',` 之后、`'scripts/test/offline/ui-contract.test.mjs',` 之前：

```js
  'scripts/test/offline/sse-lifecycle.test.mjs',
```

登记后：`npm test` 套件数 78、用例数 +8；`runner-selftest` 的「保留全部 45 个基线套件 + 清单文件存在」断言不受影响（只增不减），但套件计数相关的既有断言若写死 77 需同步（当前 runner-selftest 只断言基线套件保留，不写死总数）。

### 4.2 实现侧依据（未改代码，仅审计）

- 终态唯一性：`src/responses-stream.js` `createCodexStreamAdapter` 首次终态即置 `terminal`，其后 `push` 直接返回、`end()` 只在无终态时合成 `response.failed`，`fail()` 幂等；`src/index.js` `streamCodexResponse` 在 `adapter.terminal` 后跳出读取循环。
- 预算/槽位保持：`proxyNativeResponses` 中 `release()` 位于 `finally`，而该分支 `await streamCodexResponse(...)` 返回后才离开 try，故 provider 槽位持有到中继结束；请求 `budget` 在最外层 `finally` 才 `dispose()`，故 deadline 计时在流式期间持续有效（G5-SSE-05/07 从外部观测这两点）。

## 5. 未覆盖 / 未验证项

- **真实上游（OpenCode Go）SSE 终态与取消语义**：`NOT_RUN_LIVE`。本轮只有本地 mock；不消耗真实额度、不携带真实 Key。
- **反向验证（负向对照）**：受「不改 `src`」约束，未临时回退 2026-11-13 修复来观察 G5-SSE-05 变红；该用例的判定仍基于外部可观测事实（350ms 时上游命中必须仍为 1、第二个请求必须未 settle），旧实现（终态前 `release()`）会在此断言处失败。标记 `NOT_RUN_INJECTION`，不作为已执行的反证。
- **未声明 `codex` 的原生逐字节管道**：该路径不合成终态（上游 close 即结束），本轮不把它纳入「唯一终态」判定，避免把设计边界写成回归。
- **`response.incomplete` 终态**：适配器层已由 `codex-v2-stream.test.mjs` 覆盖，本轮未做 HTTP 全链路补充。
- **原生路径 idle/首事件看门狗（`idleMs`）**：G5-SSE-07 特意把 `idleMs` 拉长以排除它；该看门狗在原生投影路径上的行为未单独回归。
- **背压（`write=false`/drain/8MiB）**：由 `deadline.test.mjs` AC-6 与 `codex-v2-stream.test.mjs` P04 背压用例覆盖，本轮未重复。
- **观测/指标面**：只断言了 `global.errors`、`counters.interrupts` 与上游命中；熔断状态、`streamDrops` 的具体计数未逐项断言。
- **Windows/macOS 与 Node 18/20**：本机仅 Node `v24.22.2`（Linux）。

## 6. 回滚方式

仅新增文件，无 `src`/`package.json`/`run.mjs` 改动：

1. 未登记前：删除 `scripts/test/offline/sse-lifecycle.test.mjs` 与本文件即可，无运行时影响。
2. 已登记后：先移除 `run.mjs` 中新增的 SUITES 行（或回退该提交），再删除测试文件；`git revert <commit>` 可一次覆盖两个文件与登记行（若登记行在同一提交）。

## 7. 资源与凭据边界（复核）

- 全部用例使用 `scripts/test/offline/harness.mjs` 的 `startGateway`（OS 临时配置目录、`MG_KEYS_MASTER=isolated-test-master`、动态 0 端口）与 `startScriptedUpstream`（回环动态端口）。
- 不读取/复制/改写 `~/.codex/auth.json`、`~/.codex/config.toml`；不改 systemd；不碰 8787；不 push/merge/PR。
- 无真实 Key、无真实上游请求、无外网访问；未新增依赖。
