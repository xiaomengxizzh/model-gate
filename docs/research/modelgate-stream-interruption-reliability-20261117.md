# ModelGate｜官方套餐对话中断与 Responses 传输可靠性专项补充任务书
> 2026-11-17 · **P0 增补 / 研究先行 / 尚未执行** · **2026-11-17 本机校准修订版（rev2）**
> 关联总计划：[2026-11-16-modelgate-source-research-real-e2e-master-plan.md](../roadmap/2026-11-16-modelgate-source-research-real-e2e-master-plan.md)
> 本机事实基线：[modelgate-local-baseline-20261117.md](../evidence/modelgate-local-baseline-20261117.md)（G0 预取证快照，执行前必须复核）
> 本文新增 T13，并对总计划的优先级、真实测试矩阵及启动指令作补充。与旧文冲突时，以本补充任务书为准。
>
> **rev2 修订说明**：原版（rev1）基于云端 GitHub 网页阅读，部分行号过时、一处文件归属错误（`forward` 实在 `src/request.js`，不在 `src/forward.js`）。本修订版已用本机 `886e22a` 树逐行核实全部源码引用，用 GitHub API + v4.0.27 tag 原文核实全部 CC Switch Issue 状态，并补充了 rev1 未发现的 7 项额外风险。所有行号绑定 **main @ `886e22a863343192e4ae5ab41e38396df4d4813c`**；执行 AI 若在不同 SHA 工作，必须重新定位符号而不是照抄行号。

## 0. 新增问题与结论边界

用户报告：即使使用 ChatGPT 官方套餐模型进行普通对话，也会出现不明原因的中断/停滞；类似现象曾在旧版 CC Switch 使用期间出现。它可能与 ModelGate、CC Switch、Codex 客户端、ChatGPT Codex 上游、HTTP/SSE/WebSocket 传输或网络设备有关。

**不得预先认定为 ModelGate bug，也不得因为 CC Switch 某个旧 Issue 已关闭就认定此类问题全部解决。** "stream disconnected" 是多个故障类别共用的表面错误，必须先按真实传输路径和终止事件分类。

### 0.1 本机已核实的起点事实（2026-11-17 取证，详见基线文件）

1. **当前日常路径是官方直连**：`~/.codex/config.toml`（今天 12:41 修改）`model="gpt-6-luna"`、`model_provider="openai"`。ModelGate 服务 **inactive (dead)**（8787/8788/8789 无监听），CC Switch **没跑**（15721 无监听）。因此**今天发生的任何中断都不经过 ModelGate 或 CC Switch**；用户报告的历史中断需要确认时间窗与当时接管工具（T13-A 第一问）。
2. `config.toml` 的 `[model_providers.custom]` 指向 `http://127.0.0.1:15721/v1`（CC Switch 代理口，当前死端口）；`model_catalog_json` 指向仓库聚合目录。**任何三路径对照不得直接复用日常 config 的 custom 段**，必须按隔离手册准备。
3. 本机 CC Switch = **v4.0.27 二进制**（dpkg，2026-11-07 安装，与上游 tag 发布日期一致），无源码工作树；`/tmp/ccs427/` 有本次调研抓取的 tag 源码选摘（可丢弃，用前核对）。上游最新 v4.0.33（2026-11-16），本机落后 6 个 patch。
4. Codex CLI 0.167.0；"原版 Codex Desktop" 实为 **ChatGPT 桌面 26.1103.32239 内置 Codex app-server**（`/usr/lib/chatgpt/resources/codex`）。
5. 旧线程素材充足：sessions/ 454 文件 + archived_sessions/ 113 + thread_history_1.sqlite 446MB。R17 旧线程 A/B 可直接取材。
6. 本机 CC Switch 日志最后活动停在 11/13 的刻意 429 注入测试，**无自然断流记录**；不能从本机日志直接证明历史断流根因。

### 0.2 本轮公开资料已证实（rev2 复核更新）

1. Codex 官方仓库至今仍有 ChatGPT 登录用户的 Responses WebSocket 中断、HTTP 200 但无 SSE 事件、旧线程卡住、连接重用超时等开放报告（§2 逐项状态）。
2. CC Switch 的修复**全部是"检测截断 + 终态边界防污染 + 426 回退"**，没有任何中途重试/续传：PR #8281 正文明确写 "does not implement retries or continuation and does not close #8126"；#8126 是维护者手动关闭（无关联修复 commit）。真 WS 转发需求 #8404 仍 open 且无排期。
3. 当前 ModelGate main 的 WS 桥是**客户端 WebSocket → ModelGate 内部环回 HTTP POST → 上游 HTTP/SSE → 客户端 WebSocket**，不是端到端 WS/WSS 透传（§3.1 调用链已逐行核实）。
4. ModelGate 原生 Responses 转发调用 `forward(..., noRetry: true)`，禁用的是**发送级重试循环**；流中途重试在 native/official 路径**本来就不存在**（§3.3）。`streamCodexResponse` 的 catch 未绑定 err 且零日志（§3.4）。
5. 因此，"Codex 客户端 WebSocket 连接仍活着"不等于"上游模型正在生成"；"HTTP 200"不等于"已经收到 Responses 事件"；"收到流 EOF"不等于"模型正常完成"；**"字节级 idle 计时器被重置"也不等于"模型在产出事件"**（keepalive 注释会喂活字节 idle，见 §3.6）。

## 1. CC Switch 过往修复：逐项理解，禁止概括成"已解决"（rev2 全部经 GitHub API + tag 原文核实）

### 1.0 Issue/PR 状态总表

| 编号 | 状态（state_reason） | 修复落地版本 | 实际范围 | 等于"断流已解决"？ |
| --- | --- | --- | --- | --- |
| #1673 | closed (completed, 10-10) | v4.0.0 起 426 | GET WS 握手固定回 426，Codex 本会话回退 HTTP/SSE；未实现 WS 转发 | **否**，只消 405/Reconnecting 症状 |
| #2750 | closed (completed, 06-09) | 声称 v3.16.0/3.16.2 | 关闭后持续复发：3.16.2/3.16.5/3.19.2/3.20.0/3.20.1 均有复现报告，未重开 | **否**，closed≠解决 |
| #4535 | closed (completed, 06-27) | v3.16.2 检测 / v3.16.4 加固 | 检测截断并如实报 stream_truncated/incomplete；不阻止断流、无重试 | **否**，检测≠修复 |
| #5920 | closed (**not_planned**, 10-10) | 并入 #3566 | 切回 Official 后 auth.json 残留第三方 Key；凭据问题非断流 | 不适用 |
| #3566 | closed (completed, 10-05) | **v4.0.0**（0e6430abd 重写认证写入） | 官方登录暂存/归还 + 残留 Key 清除；v4.0.27 已含 | 已修（凭据域） |
| #8126 | closed (completed, 10-15) | **维护者手动关闭，无修复 commit** | 期望的 mid-stream retry/continuation 与结构化 error cause **均未实现**；错误原因仍只是 `format!("Stream error: {e}")` 拼字符串 | **否**，期望大半未实现 |
| PR #8281 | merged (10-15, f318e65) | **v4.0.13** | Chat 双转换器 [DONE] finalize 后立即 return，不再消费上游；明确不做 retry/continuation | 终态边界防污染，非断流修复 |
| PR #8138 | merged (10-14) | **v4.0.12** | Responses 转换器终态后传输错误静默 break（防第二终态） | 同上 |
| #8404 | **open**（10-16） | 无排期 | 维护者承认只回 426、无真 WS 转发 | 真 WS 代理仍未实现 |
| #7400 | closed (not_planned, 10-10) | 并入 #7196，**v4.0.9**（PR #8136） | 孤儿 function_call_output 转 Chat 时改发带标记用户消息，避 DeepSeek 400 | 已修（工具配对域） |
| #6449 | closed (**stale 机器人自动关**, 10-30) | 无修复声明 | v4.0.27 已有按 index 累积 tool_calls + parallel/missing/dropped 回归测试，行为已改善但非"修复关闭" | 部分 |
| #7459 | **open** | 无 | 通用 oneOf tool schema 被上游拒（400）；只有 moonshot/xai 特化清洗 | 未解决 |

**v4.0.27 已包含 #8138/#8281/#3566/#7196 的全部落地代码**（tag 源码逐行确认）。用户运行版不是"旧版未修复"，而是"修复范围本来就只到检测与终态边界"。

### 1.1 405 → 426：解决旧客户端无法握手，不是真正 WS 代理

v4.0.27 `src-tauri/src/proxy/handlers.rs` L1060–1074（`/tmp/ccs427/proxy/handlers.rs` 可核对）：

```rust
/// Responses 的 WebSocket 握手（GET 升级请求）：本地代理只讲 HTTP/SSE，回 426。Codex 内置
/// 的 openai 默认先连 WebSocket，握手拿到 426 就在本会话里改走 HTTP，其它失败要把重试
/// 用完才回退。
pub async fn handle_responses_websocket() -> (StatusCode, Json<Value>) {
    (StatusCode::UPGRADE_REQUIRED, Json(json!({ "error": {
        "type": "invalid_request_error",
        "code": "websocket_not_supported",
        "message": "CC Switch local routing does not support Responses over WebSocket; use HTTP",
    }})))
}
```

`server.rs` L335–351 把 `/responses`、`/v1/responses`、`/v1/v1/responses`、`/codex/v1/responses` 四条路径都注册 `post(handle_responses).get(handle_responses_websocket)`；L509 测试断言四条 GET 都回 426。

**这段注释同时是 Codex 客户端行为的一手旁证**：426 → 本会话立即改走 HTTP；其它握手失败 → 用完重试才回退。ModelGate 的 WS 桥（§3）走了相反路线——真正接受 upgrade。两条路线的取舍必须在 ADR 中对照：426 路线简单但放弃 WS 语义；桥接路线保留客户端 WS 但引入环回 HTTP 的全部超时/终态/资源问题。

### 1.2 Chat 上游截断检测：v3.16.2 / v3.16.4

#4535 维护者口径：v3.16.2 加入 Codex Chat 截断流检测，缺少 finish_reason/[DONE] 时按部分输出 incomplete 或 stream_truncated 失败处理；v3.16.4 加固。v4.0.27 现存逻辑佐证（`streaming_codex_chat.rs` L842–856）：EOF 无 finish_reason 时，有实质输出按 `length` 收尾，否则 `stream_truncated`。**这是识别截断、避免把残缺流误判为正常完成，不代表上游连接不会断，也不代表可以无条件重试续传。**（v3.16.x 原始源码未逐行核，标 NOT_VERIFIED，执行 AI 如需精确对照再取对应 tag。）

### 1.3 相似问题并非全都消失

#2750 关闭后在 3.16.2（06-12）、3.16.5（07-15）、3.19.2 Claude 路由截断循环（08-18）、3.20.0（08-20）、3.20.1（09-07）持续复发，涉及 Responses 原生、Chat 转换、供应商 base_url、认证配置等不同因素。**这是"closed≠解决"的最直接反例，执行 AI 引用任何 closed issue 时必须核对关闭原因与后续评论。**

### 1.4 v4.0.12/v4.0.13 的终态边界修复不是中途重试

v4.0.27 `providers/streaming_responses.rs` L4595–4599（PR #8138 落地）：

```rust
Err(e) => {
    // A late transport failure cannot invalidate an already emitted
    // terminal response or append a second terminal event.
    if terminated { break; }          // 终态后的传输错误被静默忽略
    log::error!("Responses stream error: {e}");   // 未终态：发 stream_error SSE 后 break，无重试
```

`streaming_codex_chat.rs` L801–807（PR #8281 落地）：

```rust
if data.trim() == "[DONE]" {
    for event in state.finalize() { yield Ok(event); }
    // [DONE] is terminal, including failed/incomplete finalization.
    return;                            // 立即停止消费上游
}
```

**对 ModelGate 的直接启示**：终态后必须停止消费上游并释放资源；终态后的迟到传输错误不得追加第二终态。ModelGate 当前 `streamRawResponses` 的 pipeline 没有终态提前退出（§3.5），正是这类问题的反面教材。同时注意 cc-switch 的 EOF 兜底区分"纯文本可收尾"与"tool/reasoning 未闭合必须报 stream_truncated"（streaming_responses.rs L4617–4707），以及"零 usage 的 incomplete 判为上游拒绝而非 max_tokens"（L84 `is_unprocessed_max_output_rejection`）——这两条分类逻辑值得 ModelGate 借鉴。

### 1.5 三模式与凭据生命周期（v4.0.27 源码结构）

- `mode/state.rs` L54：`enum Mode { Direct, Proxy }`——**Routing 与 Aggregation 共用 Proxy 模式**，聚合即 "Stack"（`mode/stack.rs`，`stack_mode_now` L583，模型 ID 前缀 encode/decode L118/163）。
- `mode/controller.rs`（9011 行）：模式切换编排；L1185 **聚合不做故障转移**；L1883 `drain_legacy_backup` 清理旧版备份。
- `mode/contract.rs`：**契约摘要（sha256）决定客户端文件是否重写**——代理内换供应商若契约相同则只换上游、不动客户端文件。这是避免"每次切换全量重写丢配置"的关键设计，ModelGate 配置事务可对照。
- `services/provider/codex_login.rs`：L29 `STASH_FILENAME="codex-login-stash.json"`（`~/.cc-switch/`，0600，不同步）；L242 `plan()`、L323 `official()` 官方登录暂存/归还；L181 `is_residue` 识别清除第三方残留 Key。
- `codex_config.rs` L840 起：auth.json + config.toml **原子双写、第二步失败回滚第一步**；第三方 Key 走 config.toml `experimental_bearer_token`（与本机 config.toml 所见一致）。

### 1.6 classic 子工具妥协的真实出处（rev2 更正）

**rev1 错误地把 classic 妥协文字归于 v4.0.0 release notes；已 grep 核实中英文版均无该内容。** 真实出处：`docs/guides/aggregation-mode-guide-zh.md` L158–177 与 **v4.0.13** release notes（#8253，开关默认打开）：跨供应商时新版子 agent 任务由主 agent 供应商加密、别家解不开（`Encrypted function output content could not be decrypted` / `unreadable_encrypted_agent_task`），妥协是改用经典子 agent 工具明文传任务，代价是缺 `followup_task`、`interrupt_agent`；`[features] multi_agent_v2=true` 优先级高于该开关。**这仍只是有损对照，绝不允许抄作 ModelGate 的完成方案。**

## 2. 官方 Codex / ChatGPT 上游证据（rev2：GitHub API 实时核实 + rust-v0.167.0 tag 源码逐文件核对）

### 2.1 Issue 状态表（7 个全部 OPEN，均无 OpenAI 成员回应、无关联修复 commit/PR）

| Issue | 状态 | 报告版本/环境 | 最新进展（核实到 2026-11-17） | 结论 |
| --- | --- | --- | --- | --- |
| [#20739](https://github.com/openai/codex/issues/20739) WS 在 completed 前关闭 | open（2026-05-02） | CLI 0.128.0，macOS arm64，gpt-5.5 | 2026-08-26 社区在 0.150.0 长线程（~718k token、自动压缩时）复现，Reconnecting 2/2 后 HTTPS fallback 恢复 | 无修复；0.150.0 仍可复现 |
| [#23807](https://github.com/openai/codex/issues/23807) 工具结果后精确 300s 停顿 | open（2026-05-21） | CLI 0.132.0，Win11，Plus，gpt-5.5 | 社区根因：跨请求复用陈旧 WS + `stream_idle_timeout` 默认 300000ms 且**首事件与事件间共用同一 idle timeout**；2026-08-12 仍报 300.003s | **0.167.0 源码证实默认值与机制未变（§2.2），未修复** |
| [#32366](https://github.com/openai/codex/issues/32366) 长线程 WS 关闭后 HTTP 200/chunked 无事件 | open（2026-07-11） | Desktop 26.707.41301 / CLI 0.144.0-alpha.4，macOS Intel，**Clash 代理**，gpt-5.6-sol | `supports_websockets=false` 可避开 WS 重连但**不能解释 HTTP 200 无事件**；11-17 最新评论仅推荐诊断工具 | 无修复；旧线程卡死/新线程正常未被官方解释 |
| [#36059](https://github.com/openai/codex/issues/36059) unified desktop 后断流 0/206→24/115 | open（2026-07-30） | Desktop 26.721.81911 / CLI 0.146.0-alpha.3.1 | 8 条社区复现跨 0.149.0/0.151.0-alpha.7.2：error decoding response body、idle timeout、Connection reset without closing handshake、os error 10053；**多在自动压缩前后触发** | 无修复；跨 5+ 版本持续 |
| [#44099](https://github.com/openai/codex/issues/44099) Pro 家庭网络 Broken pipe/Reconnecting 1/5..5/5 | open（2026-09-09） | Desktop 26.901.51231 / CLI 0.153.4，macOS arm64，**无代理**，读多图 turn 更严重 | 仅 bot 标重复，无人工评论 | 无修复；证明故障可不由本地网关造成 |
| [#51886](https://github.com/openai/codex/issues/51886) 后端 ~900s 截断流 | open（2026-10-08） | AI SDK 直连 chatgpt.com/backend-api/codex/responses，Pro | **0 评论**；900–902s 收到 server_error/request_timeout 帧，直连与过代理一致（gpt-6-astra 15/943、gpt-5.6-sol 6/~88000） | **服务端时限，客户端配置无法规避**；ModelGate 只能检测+如实报告 |
| [#33267](https://github.com/openai/codex/issues/33267) multi_agent_v2 加密工具输出解密失败 | open（2026-07-15） | CLI 0.144.4，macOS，Pro | **模型 catalog 强制 v2 时 config 关闭无效**（0.145.0-alpha.24 证实）；2026-09-19：0.154.0-alpha.6.2 + 自建 Responses 代理，GPT 子代理必败、非 GPT 成功 → 跨供应商密文不可解 | 无官方修复；workaround 是 models.json `multi_agent_version: v1/null`（**有损 classic，不得冒充 V2 通过**） |

共性：评论者 author_association 均为 NONE（bot 除外）。**执行 AI 不得把任何一个 issue 当作"已解决"引用；#23807 的机制在用户当前 0.167.0 中原样存在。**

### 2.2 Codex 0.167.0 原生传输机制（tag rust-v0.167.0 源码核实，路径相对 codex-rs/）

这是 T13-B/T13-E 的一手依据，也是 ModelGate WS 桥必须互操作的客户端行为契约：

| 机制 | 源码位置（rust-v0.167.0） | 行为/默认值 | 对 ModelGate 的含义 |
| --- | --- | --- | --- |
| 握手 URL | model-provider-info/src/lib.rs:86 + codex-api/src/lib.rs:19 + codex-client/src/provider.rs:91 | **wss://chatgpt.com/backend-api/codex/responses**；connect timeout 15000ms（mpi lib.rs:77） | 官方直连 WS 端点；上游 WS 代理候选必须对准此 URL |
| 客户端 Ping/Pong | codex-api/src/endpoint/responses_websocket.rs:102–108 | **客户端不主动发 ping、无 pong deadline**；只对服务端 Ping 回 Pong | ModelGate 桥向客户端发 Ping（60s）是网关侧行为；客户端会回 Pong，但桥当前丢弃（§3.2）。保活依赖服务端 ping + 客户端 idle timeout |
| idle timeout | mpi lib.rs:72；responses_websocket.rs:809/1048 | **DEFAULT_STREAM_IDLE_TIMEOUT_MS=300000**；`timeout(idle, ws_stream.next())` 对**含首事件的每个事件**统一计时；超时 "idle timeout waiting for websocket" | **没有独立 first-event timeout**。ModelGate 若 >300s 无事件，客户端会判超时重试。桥的事件看门狗（N5）必须 < 客户端 300s 才有意义 |
| 重试 | mpi lib.rs:73–81；core/src/responses_retry.rs:156；codex-client/src/retry.rs | STREAM_MAX_RETRIES=5、REQUEST_MAX_RETRIES=4、硬上限 100；"Reconnecting... {n}/{max}"（release 隐藏第 1 次 WS 重试通知）；指数退避+jitter，尊重 Retry-After | 用户看到的 Reconnecting 1/5..5/5 来源；ModelGate 错误终态形状影响客户端是否重试 |
| 无限连接重试（0.167 新增） | features/src/lib.rs:1550；responses_retry.rs:23–24,96–118 | `unbounded_connection_retries` Stable 默认 true：ConnectionFailed 类无限重试，5s→60s 封顶，"Reconnecting... waiting for network" | 0.132.0 无此 feature；连接级失败与流级失败重试策略不同 |
| HTTPS fallback | core/src/client.rs:1751,2193,791；responses_retry.rs:120–139 | ① 握手 **426** → 立即 FallbackToHttp；② **流重试耗尽（5 次）** → force_http_fallback，**会话级永久禁用 WS**，Warning "Falling back from WebSockets to HTTPS transport"，重试计数清零 | 中途断开不立即 fallback，先烧完 5 次重试（每次最长 300s → **最坏 25 分钟停顿**）。这解释了 direct 路径"无故停滞数分钟"；ModelGate 桥若持续无事件会触发客户端永久降级 |
| WS 启用开关 | mpi lib.rs:606；provider 能力 `supports_websockets` | 内置 OpenAI=true；responses_websockets/_v2 feature 已 Removed 毕业 | 诊断时可在隔离 profile 设 supports_websockets=false 做单变量 A/B，**但不得作为最终验收配置**（属禁用原生能力） |
| close code 特判 | responses_websocket.rs:980,175–179,735–748 | completed 前 Close → "websocket closed by server before response.completed"；`websocket_connection_limit_reached`（**60 分钟连接寿命上限**）；`previous_response_not_found` → Retryable 全量重发 | 长会话必遇 60 分钟上限；桥/上游代理必须正确处理这两个码，不得把 previous_response_not_found 当普通 400 |
| 续轮/store | core/src/client.rs:1163,424,头注:12–26 | **HTTP 恒 store:false**；WS 用 previous_response_id + 增量 input；v2 prewarm 发 generate=false 的 response.create 等 completed；model/tools/reasoning/**store**/service_tier 任一变化 → responses_request_properties_mismatch 放弃增量全量重发；服务端状态经 **x-codex-turn-state** 头传递 | ModelGate 续轮重建必须与 store:false + previous_response_id 语义对齐；改变 store/model/tools 会触发客户端全量重发（副作用风险）；x-codex-turn-state 是状态所有权关键头 |
| 中断 | responses_websocket.rs:311–333 | ResponseInterrupt::Drain（保流排空）/ Cancel{deadline}（超时 "timed out draining interrupted response"） | 桥的 interrupt 保留部分输出行为须与 Drain/Cancel 语义兼容 |
| 配置键 | mpi lib.rs:209–227 | [model_providers.*]：stream_idle_timeout_ms、stream_max_retries、request_max_retries、websocket_connect_timeout_ms、supports_websockets | 三路径对照可记录/隔离这些键；不得为通过验收偷偷调大 idle timeout |
| agents/压缩 | config/src/config_toml.rs:766；features/src/feature_configs.rs:303；model-provider/src/capabilities.rs | [agents]：enabled、max_concurrent_threads_per_session、default_subagent_model、default_subagent_reasoning_effort、[agents.<role>] config_file；[features.multi_agent_v2]：enabled、wait_timeout_ms 族（Stable 默认 false，**但 catalog 可强制 v2 覆盖**）；remote_compaction provider 能力 OpenAI/Azure 默认 V2 | T06/T07 的配置面；本机 config.toml 的 [agents.go_deepseek] 与此 schema 一致 |

**与 0.132.0 差异**（tag rust-v0.132.0 同路径核对）：四大默认值完全相同（300s/5/4/15s）；0.132 已有 prewarm/incremental 与 60 分钟限制码；0.167 新增 unbounded_connection_retries、previous_response_not_found 映射、safety buffering、握手 probe（responses_websocket_probe.rs）。**#23807 类停顿在 0.167.0 未被修复。**

### 2.3 对"普通对话中断"的责任分离含义（rev2 新增）

- **direct 路径即可发生数分钟停顿**：客户端 300s 统一 idle + 5 次重试 + 最坏 25 分钟才永久降级，叠加 #51886 服务端 900s 截断、#44099 无代理 broken pipe。用户当前日常路径正是 direct（§0.1），**不能预设中断是网关造成**。
- **ModelGate 桥的额外风险**：native 路径无事件看门狗（N5）+ overallMs=0 + finish() 不 abort（N1）→ 网关侧可无限悬挂，客户端 300s 后开始 Reconnecting，5 次后会话级永久降级 HTTP。桥必须比客户端更早发现死流并给出可归因终态。
- **900s 截断是服务端行为**：任何客户端/网关配置无法规避；ModelGate 只能检测 truncated、保留部分输出、如实报 incomplete/failed，不得伪造 completed。
- **网络变量必须受控**：#32366 报告者用 Clash 代理；本机 dev 配置默认 proxy=127.0.0.1:7890，会话级 http_proxy 可能被 GUI 继承。三路径对照必须记录并尽量统一实际生效代理。

## 3. ModelGate 当前源码审计（rev2：main @ 886e22a 逐行核实，事实与假说分开）

### 3.1 传输拓扑（已核实调用链）

```
Codex WS 客户端（0.167 默认先试 GET upgrade）
 │ WS/RFC6455；网关每 60s Ping、无 pong deadline；帧上限 maxBodyBytes(32MB)
 ▼ src/responses-ws.js handleUpgrade(L513) → WsPeer._dispatch(L227) → runTurn(L321)
 │ 环回 HTTP POST /v1/responses（L352–360，agent:false，自身无 setTimeout；
 │ AbortController 仅 interrupt(L504)/_teardown(L120) 触发；finish() 后 controller=null 不可达）
 ▼ src/index.js request handler(L2371) → Responses 分支(L2960) → 续轮重建/降级(L3009–3021)
 │ budget=overallMs（默认 0=不限，L2638–2639）；客户端 close → abort
 ▼ proxyOfficialResponses(L1984) / proxyNativeResponses(L2154)
 │ forward() = src/request.js:267（不是 forward.js！），noRetry → maxAttempts=1
 │ firstByte 60s（等响应头）、字节级 idle 60s；native 路径无事件级看门狗
 ▼ 上游 HTTPS SSE（官方订阅后端 completed 后不关流，持续 keepalive）
 ▼ 回程二选一：
 │ streamCodexResponse(L1864)：adapter.terminal 时 break → res.end（会关环回）；catch 丢 errno
 │ streamRawResponses(L2311)：pipeline 到底、无终态提前退出（上游不关流则环回悬挂）
 ▼ 环回 SSE → responses-ws.js sseParser(L265) → 逐事件 sendText；
   end 无 terminal → 合成 response.failed(L436，无 id/error 字段)
```

WS 桥启用条件：`server.responsesWebSocket !== false`（index.js:3520–3521，默认启用）；桥挂载时 `server.on('upgrade')`（responses-ws.js:564）处理，未挂载时 request handler 兜底 404 `ws_not_supported`（index.js:2939–2941）促回落 HTTPS。POST 分流：official → proxyOfficialResponses（L3053）；api:"responses" → proxyNativeResponses（L3092）；其余 Chat 桥（L3098）。

### 3.2 WS 桥：Ping/Pong、finish 与合成终态

```js
// src/responses-ws.js:113-117 —— 只有发送，没有健康判定
this.pingTimer = setInterval(() => {
  if (this.closed || this.closing || socket.destroyed) return
  this._enqueue(OPCODE.PING, Buffer.alloc(0)).catch(() => {})
}, 60000)
if (this.pingTimer.unref) this.pingTimer.unref()

// src/responses-ws.js:188 —— PONG 被丢弃，无 RTT、无 pong deadline
return // PONG
```

**结论**：Ping 已发送≠连接健康。死连接（对端消失但 TCP 未报错）最长可悬挂到 OS TCP 超时；T13-D 必须补 pong deadline。

```js
// src/responses-ws.js:343-349 —— finish() 不 abort 环回请求
const finish = () => {
  if (finished) return
  finished = true
  peer.controller = null      // ← 置空而非 abort；此后 _teardown/interrupt 都无法终止在途环回请求
  peer.turnActive = false
  peer.turnDone = true
}

// src/responses-ws.js:352-360 —— 环回请求无自身超时
const req = http.request({
  host: ..., port: targetPort, path: '/v1/responses', method: 'POST',
  headers, agent: false, signal: controller.signal,   // 唯一终止手段是 signal
})
```

```js
// src/responses-ws.js:436 —— end 无 terminal 时合成的 failed 缺字段
if (parse) parse('data: ' + JSON.stringify({
  type: 'response.failed', response: { status: 'failed', output: [] }
}) + '\n\n')                    // ← 无 response.id / model / error / usage；Codex 可能无法关联轮次

// src/responses-ws.js:429-433 —— 纯 JSON 200 响应合成 created+completed
const base = Object.assign({}, response, { id, status: response.status || 'completed' })
peer.sendJson({ type: 'response.created', response: base })
  .then(() => peer.sendJson({ type: 'response.completed', response: base }))
// ← 若上游 200 JSON 实为错误信封（无 status），会被包成 completed。需运行时取证确认官方是否存在该形状。
```

### 3.3 noRetry 的真实语义（rev2 更正归属文件）

调用点：`src/index.js:2091`（proxyOfficialResponses）与 `src/index.js:2234`（proxyNativeResponses）：

```js
const up = await forward(prov, upstreamPath, 'POST', headers, payload,
  state.cfg.defaults || {}, log, { budget, signal: budget.signal, noRetry: true })
```

`forward` 实现在 **`src/request.js:267`**（index.js:12 导入；src/forward.js 只在注释提及 noRetry）：

```js
// src/request.js:270-275
const timeout = Object.assign({ connectMs: 10000, firstByteMs: 60000, idleMs: 60000 }, opts.timeout)
const overallMs = timeout.overallMs || 0
const noRetry = opts.noRetry === true
const maxAttempts = noRetry ? 1 : Math.max(1, retry.maxAttempts)

// src/request.js:142-145 —— noRetry 禁用的重试覆盖这些错误
const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const NET_ERR_CODES = ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','ECONNABORTED','UND_ERR_SOCKET']
```

**精确结论**：
- noRetry 禁用的是**发送级重试循环**（建连失败 + 可重试 HTTP 码 + 网络错），即"请求还没拿到响应头"阶段的自动重发。
- **流中途重试在 forward 中本来就不存在**：收到响应头即 resolve（request.js:206）。chat 路径的断流续传在 sse.js relayStream（maxReconnects=2）；**native/official Responses 路径没有任何流中续传**。
- src/retry-policy.js 的 planAttemptRetry/execute 是 forwardChain/chat 用的执行器，与此调用无关。
- 跨候选 fallback 仍可能（index.js:2143 仅 singleShot/appPlan/noReplay 时禁止）——审计"静默换模型"时必须查这一层，不能只看 noRetry。
- **调整 noRetry 的决策必须区分**：建连阶段失败（无副作用，可安全重试）vs 已收到响应头/已产出事件/已触发工具（不可盲目重放）。当前一刀切 noRetry:true 把前者也禁了，是否放宽由 T13-E ADR 决定。

### 3.4 streamCodexResponse：errno 丢失点

```js
// src/index.js:1887-1898（catch 在 L1893）
for await (const chunk of up.stream) {
  if (captureSink) { captureSink.write(chunk); recordEarly() }
  await adapter.push(chunk)
  if (adapter.terminal) break        // ← 终态即 break，async iterator return 会 destroy 上游流
}
await adapter.end()
} catch {                            // ← 未绑定 err，catch 内零日志
  destroyUp()
  if (!budget.cancelled()) {
    const timedOut = budget.timedOut()
    if (timedOut && !res.headersSent) throw abortedError('request_timeout')
    await adapter.fail(timedOut ? 'request exceeded overall timeout' : 'upstream stream interrupted', { timeout: timedOut })
  }
}
```

下游收到合成 `response.failed`，`error.code` 为 `STREAM_INTERRUPTED`/`REQUEST_TIMEOUT`（responses-stream.js:636–656），`response.output:[]`。**ECONNRESET/ECONNABORTED/socket hang up/decode error 在此全部不可区分**——这是用户看到"通用中断"而无法归因的直接代码原因。T13-F 的最小修复就是绑定 err 并记录脱敏 errno/code/阶段（§4.6 补丁规格）。

### 3.5 streamRawResponses：pipeline 吞错 + 无终态提前退出

```js
// src/index.js:2344-2351
if (captureSink) {
  const tap = new Transform({
    transform (chunk, _enc, cb) { captureSink.write(chunk); recordEarly(); cb(null, chunk) },
  })
  pipeline(upstreamStream, tap, res, () => finish())   // ← 回调忽略 err 参数
} else {
  pipeline(upstreamStream, res, () => finish())        // ← 同上
}
```

- 上游流 error 时 pipeline 默认 destroy 全部流（含 res）：**直连 HTTP SSE 客户端得到无 terminal 事件的连接中断**（不像 codex adapter 路径会合成 failed）；WS 客户端经环回 upstream 'error' 得 502 error frame。
- **没有终态提前退出**：官方订阅后端 completed 后不关流（持续 keepalive），pipeline 会一直挂着 → 环回请求不结束 → 叠加 §3.2 finish() 置空 controller，该请求无法再被 interrupt/断连 abort。
- finish（L2332）静默 resolve，无错误日志。

### 3.6 超时分层现状（rev2 精确校准）

| 层 | 位置 | 默认值 | 实际语义 | 覆盖路径 |
| --- | --- | --- | --- | --- |
| connect | request.js:118 | 10000ms | **仅用于代理 CONNECT**；直连 socket 超时对齐 firstByteMs（L214） | forward |
| firstByte | request.js:211 | 60000ms | **等响应头**，不是等首个 SSE 事件 | forward |
| 字节级 idle | request.js:205 | 60000ms | 头到达后 `req.setTimeout(effIdle)`；**keepalive 注释会喂活它** | forward |
| overall budget | budget.js:15–19 / index.js:2638–2639 | overallMs=0（**不限**） | 到期 abortedError（504，budget.js:70–78） | 全路径 |
| 事件级看门狗 | sse.js:374 | noEventMs=idleMs*2（chat idleMs 默认 30000，L219） | 注释不重置事件看门狗（L312） | **仅 chat relayStream** |
| WS pong deadline | — | **不存在** | — | — |
| WS 环回请求自身超时 | — | **不存在** | 唯一终止手段是 controller.signal | WS 桥 |

**关键缺口**：native/official Responses 路径**没有事件级看门狗**。半死官方流（只发 keepalive 注释、无业务事件）+ overallMs=0 → 字节 idle 被注释喂活 → **可无限悬挂**。这是"普通对话静默停滞"的最有力源码假说（待运行时证实）。生产配置 `defaults.timeout` 实际值未读（私有配置），执行 AI 必须先取证运行配置的有效值再下结论。

### 3.7 续轮 sink 与 P0-B 的关系（事实 + 待证假说）

```js
// src/responses-continuation.js:160-174（applyEvent 节选）
if (obj.response && typeof obj.response === 'object') {
  if (typeof obj.response.id === 'string' && obj.response.id) responseId = obj.response.id
  if (typeof obj.response.status === 'string') status = obj.response.status
}
// 兼容 id 在事件顶层的形状（不同后端信封差异；只取协议元数据）。
if (!responseId && typeof obj.id === 'string' && obj.id && type.startsWith('response.')) responseId = obj.id
if (type === 'response.output_item.done' && obj.item) { considerItem(obj.item); if (responseId) pendingRecord = true }
if (type === 'response.created' && responseId) pendingRecord = true // 预登记（e8ed185）
if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
  if (obj.response && Array.isArray(obj.response.output)) completedOutput = obj.response.output
  // 真实订阅后端在 completed 后**不关闭 SSE 流**；Codex 收到终态即发下一轮。
  // 终态到达即视为可登记（e60414d），不得等流结束。
  terminal = true
  if (responseId) pendingRecord = true
}

// src/responses-continuation.js:196（snapshot）——未见终态也默认 completed
return { responseId, status: status || (sawAny ? 'completed' : null), output, sawAny, ... }
```

已核实的登记链路：captureSink 逐 chunk `takeRecordable()`（L217–221）→ streamCodexResponse recordEarly（index.js:1867–1874，`status: cap.status || 'in_progress'`）/ streamRawResponses（L2315–2322）；非流式 JSON 直接 recordContinuation（官方 L2115–2119，Go L2260–2262）。重建在 POST 入口 index.js:3009；**缺失降级**（e8ed185）L3013–3021：不再 400，`degraded=true` + warn + 剔除 prev_id + `continuation.prevId=null`（L3029），落回形状修复链。

**与当前唯一阻断（官方父代理续轮 400）的关系**：晚间交接证实官方后端 resp id（56 位 hex）从未被登记，6 条 recorded 全是 Go 的 32 位 hex。sink 已支持嵌套 `obj.response.id` 与顶层 `obj.id` 两种形状，因此"官方 id 未登记"的可能根因收窄为：
- H1：官方 SSE 信封形状与 feedSse 解析不匹配（content-type 误判、data 多行/前缀、事件名不在 response.* 族）→ 根本没进 applyEvent；
- H2：官方路径该请求没挂 captureSink（continuation 为 null 的分支条件）；
- H3：事件进了 applyEvent 但 id 在第三种位置（如 response.created 的嵌套层级不同）；
- H4：登记成功但 cache key/prevId/thread 不一致导致 lookup 失败。
**必须按交接指定的结构日志一次真机单轮取证区分 H1–H4，禁止盲猜兼容**（§4.6 补丁规格含此诊断）。`snapshot()` 默认 completed 与"顶层 id 兜底"是额外的误登记风险点，修复时一并加守卫，但不得在无证据时改动登记语义。

### 3.8 rev2 新增风险清单（rev1 未提，全部源码直接证明）

| # | 位置 | 风险 | 严重度 | 证实方式 |
| --- | --- | --- | --- | --- |
| N1 | responses-ws.js:343–350 | finish() 置空 controller 不 abort；终态后上游不关流时环回请求无法被 interrupt/断连终止 | 高（资源泄漏→后续轮次受影响） | 运行时：官方 completed 后观察环回连接存活时长 |
| N2 | responses-ws.js:352–360 | 环回 http.request 无自身超时；overallMs=0 时 WS 轮次无独立 deadline | 高 | 读运行配置 + 半死流复现 |
| N3 | index.js:2348/2350 | pipeline 回调吞 err；raw 路径上游 error 无合成终态、无日志 | 高 | 离线注入上游 error 断言下游形状 |
| N4 | responses-continuation.js:196 | 未见终态也把 status 记成 completed（sawAny 即默认） | 中（续轮状态失真） | 离线：只喂 created+output_item 断言 snapshot |
| N5 | native 路径无事件看门狗（§3.6） | keepalive 注释喂活字节 idle + overallMs=0 → 无限悬挂 | 高（静默停滞头号假说） | 离线：只发注释的 mock 上游 + 计时 |
| N6 | responses-ws.js:436 | 合成 failed 无 response.id/error，Codex 可能无法关联轮次 | 中 | 真实 Codex 对合成 failed 的反应取证 |
| N7 | responses-ws.js:429–433 | 纯 JSON 200 无 status 信封被合成 completed（假完成候选） | 中 | 官方非流式响应形状取证 |
| N8 | index.js:3021 | 降级路径直接 mutate 原 body（ok 路径是拷贝），形状不一致 | 低 | 代码审查 |

**证据边界**：以上行号、控制流、字段形状均为源码直接证明；严重度排序是假说，需运行时证据（①官方 completed 后 keepalive 行为与环回存活时长；②真实 Codex 对无 id 合成 failed/raw 断连的反应；③生产配置有效 timeout 值）确认后才能写进根因结论。

### 3.9 现有测试覆盖与缺口

已有：`scripts/test/offline/responses-ws-bridge.test.mjs`（15 test：握手/头不转发、续轮闭环、HTTP 回落共用缓存+降级、type/generate 剔除、误标 content-type、空 body 必回终态、预热、interrupt 保留部分输出、FIN 收尾、401 error 帧、回滚开关）；`responses-continuation.test.mjs`（11 test：重建顺序/去重/TTL/LRU/超容量 fail-closed、sink 捕获）；live 白名单内 stream-failover / stream-drop-halfopen / stream-started-4xx / sse-resume / z2-noevent（**仅 chat 路径**）；offline sse-lifecycle / sse-chunking / codex-v2-stream / agg-v2-go-stream。

**缺口（T13 必须补的离线回归）**：
1. WS terminal 后环回请求是否关闭（N1）；
2. raw pipeline 上游 error 时下游终态形状（N3）；
3. native 路径半死流（只发注释）看门狗（N5）；
4. snapshot 未见终态不得默认 completed（N4）；
5. 合成 failed 携带 response.id/error.code（N6）；
6. catch 保留脱敏 errno/code（§3.4）。

## 4. 新增 P0 任务 T13：官方套餐普通对话连续性与传输可靠性

**目标：即使没有子代理、没有工具调用、没有 DeepSeek，只用 gpt-6-luna 官方套餐进行普通对话，也不能出现静默停滞、假完成、无解释中断或无穷重连。**

T13 必须先做源码研究和真实对照，再决定是否改架构。子任务：

### T13-A：精确定位用户实际使用路径
- **第一问（rev2 新增）**：向用户确认中断发生的时间窗。当前（11/17 12:41 起）日常配置是官方直连且两个网关都停；若中断发生在该窗口，则属 direct 路径，对照 Codex 上游 Issue 而非网关代码。若发生在更早，确认当时是 Codex Desktop 还是 CLI、经 ModelGate 还是 CC Switch（Direct/Routing/Aggregation 哪种）、实际模型是否 gpt-6-luna。
- 记录客户端版本、Codex CLI/app-server 版本、网关 SHA/运行 PID、Provider、配置是否热更新/重启、当前 transport、**实际生效的代理环境变量（http_proxy/https_proxy/NO_PROXY）**。
- 不读取/输出账号 token、auth.json、cookie、API Key 明文。

### T13-B：端到端传输拓扑研究
必须分别绘制并解释（§3.1 已给出 ModelGate 段的核实版本，其余三段由 A2 补齐）：
1. 原版 Codex → ChatGPT Codex backend 的官方直连 WS/HTTPS fallback（对照 Codex 0.167.0 源码与 §1.1 cc-switch 注释旁证）。
2. Codex → CC Switch 本地路由/聚合 → 上游（v4.0.27 的 426 → HTTP/SSE 行为，§1.1/§1.5）。
3. Codex → ModelGate WS bridge → 环回 HTTP POST → 上游 HTTP/SSE（§3.1）。
4. 未来候选：Codex WS → ModelGate → 上游 WS/WSS（仅当真实支持且研究证明值得做；cc-switch #8404 证明该需求普遍存在但无人实现）。
对每条链路标记：握手、认证域、首事件、事件流、ping/pong、SSE keepalive、连接复用、取消、中断、terminal、重试/续传、超时和状态归属。绝不将"客户端到网关是 WS"描述为"端到端 WS"。

### T13-C：故障分类和可观测性
必须区分以下故障码/阶段（与 §3 代码位置绑定）：
- WS handshake 失败（405/426/403/timeout）——ModelGate 桥接受 upgrade，CC Switch 回 426，两者客户端行为不同。
- WS 成功升级后 server close / abnormal close / broken pipe。
- WS reused stale connection，发送后 first event 超时（对照 Codex #23807）。
- HTTP 200 但在 first event deadline 内没有任何 SSE/JSON 事件（**当前 native 路径无此 deadline，N5**）。
- SSE 正常数据后 EOF，但缺 response.completed / failed / incomplete（responses-stream.js:629–631 已有 fail；WS 桥 L417–437 合成 failed 缺字段，N6）。
- SSE 中途 ECONNRESET / ECONNABORTED / socket hang up / decode error（**当前 catch 丢 errno，§3.4**）。
- 上游明确 response.failed / response.incomplete / request_timeout。
- 本地 overall budget 超时、client disconnect、用户 interrupt。
- terminal 已发出后继续收到内容、重复 terminal 或连接迟迟不结束（**N1/N3，cc-switch #8138/#8281 是正面参照**）。
- 历史状态/工具续轮 400（与传输中断分开记录，P0-B）。
每次请求至少记录脱敏元数据：request/trace ID、client/upstream transport、HTTP status/content-type、upgrade status、首事件延迟、事件间隔、持续时间、已收字节数/事件数、terminal type、WS close code/reason、ping/pong RTT、EOF/error errno/code、budget 类型、重试次数、实际 provider/model。禁止记录秘密和完整内容。

### T13-D：超时、心跳和流终态
- 按 §3.6 分层表逐项研究：connect/firstByte/字节 idle/overall/事件看门狗/pong deadline 各自独立配置与可观测性；不能把一个超时值复用为全部场景。
- 补齐 native 路径事件级看门狗（参照 sse.js:374 chat 实现，注释不重置事件计时）；补齐 WS pong deadline；评估环回请求自身超时。
- SSE 注释 keepalive 只能维持 HTTP 流中间链路，不能伪造 Responses 业务事件；不得把心跳当成模型输出。
- 每个 response.create 必须恰有一个可信终态；response.completed 只能在上游真实完成时发送；截断不得伪装完成（N4/N7 守卫）；中途错误必须保留安全的根因代码与可诊断阶段。
- 对正常 terminal 后上游不立即 EOF 的情况（官方订阅实测如此），验证并修复内部流/Provider permit/AbortController 及时释放（N1/N3），防止旧请求泄漏影响下一轮。

### T13-E：重试与续传的安全边界
- 研究官方 Codex 的 WS sampling retry、HTTPS fallback 和 previous_response_id 续轮语义，**§2.2 已给出 0.167.0 核实版本，直接引用并复核**：HTTP 恒 store:false；WS 增量续轮靠 previous_response_id + x-codex-turn-state；`previous_response_not_found` 被客户端映射为 Retryable 全量重发；model/tools/reasoning/store/service_tier 任一变化触发 properties_mismatch 全量重发。ModelGate 的续轮重建/降级不得与这些原生语义冲突（例如降级剔除 prev_id 后，客户端可能全量重发——必须评估副作用）。
- 按 §3.3 精确区分：建连阶段失败（无副作用，可评估放宽 noRetry）vs 已产出事件/工具（不可盲目重放）。先证明幂等性、真实 response state 与 call/output 配对，才可启用自动恢复。
- 对能安全恢复的阶段设计有限次数、退避、去重、预算和取消；对不能安全恢复的阶段返回明确 incomplete/failed 与恢复指引。
- 不允许通过伪造 response.completed、删除历史、重发工具调用、静默切换模型或切换官方/第三方凭据域来掩盖断流。**注意跨候选 fallback 层（index.js:2143）与 noRetry 是两件事，审计必须分别覆盖。**
- 评估 end-to-end upstream WebSocket、HTTP/SSE 增强、官方请求保持原生路径/第三方走本地路由等方案；先做 ADR，不预设必须实现 WS proxy。cc-switch 的 426 路线（§1.1）是"放弃 WS 语义换简单"的已验证对照。

### T13-F：根因修复与用户体验（最小补丁规格）

以下为**设计示意补丁**（行号绑定 886e22a，实现时以符号定位），展示修改位置与不变量；不是可直接合并的最终 diff，实现者必须补测试与 ADR：

```js
// ① src/index.js streamCodexResponse catch（L1893）——保留脱敏根因
// 现状：} catch {  → 目标：
} catch (err) {
  destroyUp()
  // 只记协议元数据：errno/code/阶段/已收事件数；禁止记 Authorization、body、prompt
  log && log.warn('upstream stream failed',
    'phase=upstream-read', 'code=' + (err && err.code || ''), 'errno=' + (err && err.errno || ''),
    'events=' + adapter.eventCount, 'budgetTimedOut=' + budget.timedOut())
  if (!budget.cancelled()) {
    const timedOut = budget.timedOut()
    if (timedOut && !res.headersSent) throw abortedError('request_timeout')
    await adapter.fail(timedOut ? 'request exceeded overall timeout' : 'upstream stream interrupted',
      { timeout: timedOut, causeCode: err && err.code })   // error.code 透传到下游合成终态
  }
}

// ② src/index.js streamRawResponses pipeline（L2348/2350）——终态提前退出 + 错误终态
// 现状：pipeline(upstreamStream, tap, res, () => finish())
// 目标：tap 中检测 TERMINAL_TYPES → 主动 end res 并 destroy 上游（参照 cc-switch [DONE] return）；
//       pipeline 回调绑定 err → 未终态时合成 response.failed（含 id/causeCode）再 finish，禁止裸断连。

// ③ src/responses-ws.js finish()（L343）——终态后释放在途环回请求
const finish = () => {
  if (finished) return
  finished = true
  const c = peer.controller
  peer.controller = null
  if (c) { try { c.abort() } catch {} }   // 终态即 abort 环回；上游 keepalive 不再悬挂
  peer.turnActive = false
  peer.turnDone = true
}
// 注意：abort 必须发生在终态事件已 sendText 之后，且不得影响已登记的续轮状态。

// ④ src/responses-ws.js PONG（L188）——pong deadline
// 记录 lastPongAt；Ping 发送时若 now - lastPongAt > pongDeadlineMs（独立配置，默认建议 2×ping 间隔）
// → _close(1001, 'pong timeout')，让客户端明确重连而不是无限等待。

// ⑤ native 路径事件级看门狗——参照 sse.js:374，在 streamCodexResponse/streamRawResponses
// 增加 noEventMs 计时：只收到 keepalive 注释不重置；超时 → 合成 response.failed(error.code=FIRST_EVENT_TIMEOUT
// 或 STREAM_IDLE_TIMEOUT，区分首事件前/后)。默认值与配置键在 ADR 中定，不得复用字节 idleMs。

// ⑥ src/responses-continuation.js snapshot（L196）——未见终态不得默认 completed
// status: status || null（sawAny 不再推断 completed）；调用方 recordEarly 已用 in_progress，
// 最终登记必须来自真实终态事件。配套离线回归：只喂 created+output_item 断言 status=null。

// ⑦ 官方续轮结构诊断（P0-B 取证，先于任何 sink 修改）——proxyOfficialResponses 上游成功边界：
// 记录 content-type、首个成功解析 data JSON 的键名列表、response id 所在层级（嵌套/顶层/其它）、
// 终态类型、向 Codex 发出的 ID、store 记录时序。只记结构，不记内容/Token/原始输入输出。
// 一次真实父代理带工具单轮取证 → 区分 §3.7 H1–H4 → 再修 sink。
```

GUI 需要显示当前模型、实际 Provider、当前传输（WS/HTTP/SSE）、首事件等待、重试状态、错误原因、是否保留部分结果；不得只显示"请求失败"或无限 spinner。如果是 OpenAI backend/Codex runtime 问题，保留最小复现与诊断包，建议通过官方反馈渠道报告；ModelGate 不得把上游问题伪装成已修复。

## 5. T13 真实测试矩阵（替代简单冒烟）

必须在同一台用户主机、相同网络时段、同一 Codex 版本、同一 ChatGPT 官方登录和 gpt-6-luna 下进行受控对照。各测试串行执行，不同时开多个接管工具。

| ID | 路径/场景 | 目标证据 | 通过标准 |
| --- | --- | --- | --- |
| R13 | 原版 Codex 直连官方基线 | 实际 transport、完整事件时序、终态 | 真实多轮任务完成，异常可归因；作为上游/客户端基线 |
| R14 | 同任务经 ModelGate | client WS 与 upstream HTTP/SSE 分开记录 | 真实工作任务完整完成；无静默停滞、无假完成 |
| R15 | 同任务经本机 CC Switch v4.0.27 | 版本、模式、426/HTTP fallback、上游协议 | 作为同环境竞品对照，不把 HTTP fallback 误称 WS |
| R16 | 有代表性的长时间生成/多文件任务 | 首事件、长间隔、总时长、字节、终态 | 不用 1+1 探针；按真实工作负载评估稳定性 |
| R17 | 旧长线程 vs 新线程 | 同账号同配置，比较 history/previous_response_id 与 transport reuse | 定位是否线程状态相关；新线程通过不能覆盖旧线程失败 |
| R18 | 无工具普通对话 vs 有真实工具的编码任务 | 区分纯传输与 tool/continuation 问题 | 普通对话和工具任务分别有结论 |
| R19 | WS 长连接、空闲后恢复、断线/网络切换 | Ping/Pong、close code、idle timeout、首事件 deadline | 死连接在合理期限内被识别；恢复不重复执行工具 |
| R20 | 故障恢复与用户可见错误 | partial output、terminal、重试/取消、费用 | 无无限 spinner、无重复副作用、错误能解释且可恢复 |

### 5.1 三路径切换操作规程（rev2 新增，基于本机已验证约定）

**通用前置**（每路径相同）：
- 记录日常基线哈希：`sha256sum ~/.codex/config.toml ~/.codex/auth.json`（auth.json 只取哈希，禁读内容）。
- 记录网络变量：`env | grep -iE 'proxy'`（只记键与本机地址，不记远端凭据）。
- 真实付费测试前核对所有者批准的请求/时长/费用三重上限；未批准 → 该路径标 BLOCKED，先做离线/只读工作。
- GPT 请求级核验 `model=gpt-6-luna`（日常默认虽已改为 gpt-6-luna，仍须每次出站核验，不得依赖配置默认）。

**路径 A：direct（官方直连）**
```bash
# 隔离 CODEX_HOME，复制日常 config 但去掉 model_catalog_json/custom 段干扰；auth 经所有者授权的安全方式复用
export CODEX_HOME=/tmp/mg-t13-direct-$(date +%s)
# 用 -c 单次覆盖强制模型，不改日常配置：
codex -c 'model="gpt-6-luna"' exec '<真实工作任务>'
# 取证：~/.codex/sessions 对应 rollout jsonl（只读结构）、客户端日志、实际 transport
```
注意：隔离 CODEX_HOME 的官方登录复用必须按 desktop-acceptance.md 的授权方式进行，不得复制 auth.json 进模型上下文/日志/提交。

**路径 B：ModelGate**
```bash
# 被测树独立工作树 + 隔离网关实例（端口自选空闲，如 18790；不碰生产 8787）
git -C ~/ai/workplace/idproject/model-gateway worktree add .agents/worktrees/t13-<name> -b fix/t13-<name> origin/main
cd .agents/worktrees/t13-<name>
MG_CONFIG_DIR=/tmp/mg-t13-gw MG_CONFIG=/tmp/mg-t13-gw/gateway.json node src/index.js
# Codex 侧用 -c 覆盖指向隔离网关（codex-multi-provider.md 方案 A）：
codex -c 'model_provider="modelgate"' -c 'model="gpt-6-luna"' \
      -c 'model_providers.modelgate.base_url="http://127.0.0.1:18790/v1"' \
      -c 'model_providers.modelgate.wire_api="responses"' \
      -c 'model_providers.modelgate.env_key="MODELGATE_API_KEY"' exec '<同一任务>'
# 取证：网关日志（脱敏 errno/事件计数/终态）+ stats.json + 客户端 rollout
```
官方订阅经网关的路由/授权按现有 official provider 机制（src/codex/local-subscription.js、target-authz.js），不得把 ChatGPT token 发往第三方。

**路径 C：CC Switch v4.0.27**
- 启动 CC Switch 会写 `~/.codex/config.toml`（原子双写 + stash，§1.5）。**必须先取得所有者对该写入范围的明确授权**，备份日常 config/auth 哈希，测试后按其退出流程恢复并逐字节核验。
- 无法取得授权 → 用隔离 profile 或标 BLOCKED；不得私改日常配置。
- 记录其实际模式（Direct/Proxy/Stack）、426 fallback 是否发生、上游协议。

**旧线程对照（R17）**：`codex exec resume <thread-id>` **只能在同一 provider 路径内续接**（跨 provider 被 Codex 拒绝 modelProviderMismatch，本机已验证）。旧线程素材在 ~/.codex/sessions/（454 文件）；选取真实旧线程先只读取证结构，再在同路径 resume 对照新线程。禁止删线程后宣布修复。

**GUI 取证纪律**：遵守所有者偏好，**禁止把截图回读进模型上下文**；用 AT-SPI 无障碍树、网关日志、stats.json、剪贴板文本断言 GUI 状态。截图可留存供人审阅（脱敏账号标识），但 AI 不得依赖读图下结论。

### 5.2 真实对照要求
- 优先一个完整且具有代表性的编码任务，而不是每个路径重复大量简单 prompt。
- 当某路径出现失败，再做最小的针对性复测以证伪假说；每次复测必须改变/隔离一个变量。
- 对旧线程失败必须保留该线程的只读证据。
- 测试 GPT 父模型严格使用 gpt-6-luna；DeepSeek 对照固定 deepseek-v4.1-flash。
- 每项标 PASS_REAL / FAIL_REAL / PASS_MOCK / NOT_RUN / BLOCKED；只有真实场景 PASS_REAL 才进入发布门禁。

## 6. 研究资料与必须追踪的公开来源（rev2 状态已核实）

### CC Switch（farion1231/cc-switch，对照 tag = v4.0.27）
- #1673（closed completed；426 fallback）https://github.com/farion1231/cc-switch/issues/1673
- #4535（closed completed；截断检测 v3.16.2/v3.16.4）https://github.com/farion1231/cc-switch/issues/4535
- #2750（closed completed 但跨版本复发）https://github.com/farion1231/cc-switch/issues/2750
- #5920（closed not_planned，并入 #3566）https://github.com/farion1231/cc-switch/issues/5920
- #3566（closed completed，v4.0.0 凭据重写）https://github.com/farion1231/cc-switch/issues/3566
- #8126（维护者手动关闭，mid-stream retry 未实现）https://github.com/farion1231/cc-switch/issues/8126
- PR #8281（merged→v4.0.13，[DONE] 边界，明确不做 retry）https://github.com/farion1231/cc-switch/pull/8281
- PR #8138（merged→v4.0.12，终态后错误静默）https://github.com/farion1231/cc-switch/pull/8138
- #8404（open，真 WS 代理需求无排期）https://github.com/farion1231/cc-switch/issues/8404
- #7400→#7196（v4.0.9 PR #8136 孤儿 output 修复）https://github.com/farion1231/cc-switch/issues/7196
- #6449（stale 自动关）https://github.com/farion1231/cc-switch/issues/6449
- #7459（open，oneOf schema）https://github.com/farion1231/cc-switch/issues/7459
- v4.0.27 tag 源码（本机选摘 /tmp/ccs427/）：https://github.com/farion1231/cc-switch/tree/v4.0.27/src-tauri/src/proxy
- classic 子工具妥协真实出处：docs/guides/aggregation-mode-guide-zh.md L158–177 + v4.0.13 release notes（#8253）
- 最新 releases（当前 v4.0.33）：https://github.com/farion1231/cc-switch/releases

### Codex / OpenAI
- #20739 https://github.com/openai/codex/issues/20739
- #23807 https://github.com/openai/codex/issues/23807
- #32366 https://github.com/openai/codex/issues/32366
- #36059 https://github.com/openai/codex/issues/36059
- #44099 https://github.com/openai/codex/issues/44099
- #51886 https://github.com/openai/codex/issues/51886
- OpenAI 网络建议：https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps
- Codex 官方源码（对照本机 0.167.0 对应 tag）：https://github.com/openai/codex

以上是研究起点。执行代理必须重新核实 Issue 状态、最新评论、对应版本源码和实际安装版；不要只引用搜索摘要。

## 7. 总计划的优先级和阶段修订

将原计划 1.2 的阻断顺序调整为：
1. **P0-A / T13：官方套餐普通对话与 Responses 传输可靠性**（新增，先区分 direct / CC Switch / ModelGate）。
2. P0-B / T05：官方 GPT 父代理工具续轮 400。
3. P0-C / T06：跨供应商原生 V2 子任务与密文边界。
4. P0-D / T07：Codex 原生 compaction 与 same-child resume。
5. 其余 T01–T04、T08–T12 按依赖关系并行研究/实施；本机 CC Switch 源码研究 T01 与 T13 同时启动。

阶段新增 G0.5：
- G0：环境、版本、授权与实际路由盘点（**基线快照已预置，复核即可，不重复盘点**）。
- **G0.5：普通官方对话的 direct / CC Switch / ModelGate 传输基线，完成故障分类、现有日志取证和 T13 研究方案。**
- G1：本机 CC Switch、Codex 原生源码、竞品/论文/社区研究与路线 ADR。
- G2 及以后沿用总计划 G2–G6，但只有 T13 与 T05–T07 等 P0 阻断有真实证据后，才推进发布冻结。

## 8. 本补充的执行纪律

- 先读取用户已有日志和本机 CC Switch 安装版本，使用脱敏元数据；不要要求用户重复提供已经能从本机安全读取的事实（**基线快照已含大部分，先读它**）。
- 不要擅自更新 CC Switch / Codex，也不要安装监控软件、抓包软件或新的依赖。
- 不要因为 direct Codex 也有中断就免除 ModelGate 的责任；也不要因为 ModelGate 出现中断就默认上游正常。用同环境 A/B 证据分离责任。
- 不要因为 CC Switch issue closed 就断言全局修复；核对关闭原因和合入代码实际解决的故障类别（§1.0 表已给出 state_reason）。
- 不要盲目禁用 WebSocket、强制 HTTP-only、关闭工具/压缩或更换模型来制造通过。任何传输策略变化先用临时 profile 做诊断，不能覆盖用户日常环境。
- 不要无脑自动重试已开始输出或已触发工具的请求；重试前先证明不会重复执行副作用。
- 用户体验验收必须包括：长时间无事件时 UI 是否明确显示等待/超时，连接断开是否保留部分输出，用户能否取消/重试，以及是否能在原线程继续工作。
- T13 研究记录必须独立成文，含真实调用图、故障分类、对照矩阵、源码行号、证据 URL、ADR、真机测试收据和明确未决项。
- **rev2 新增**：所有源码行号引用必须绑定执行时的实际 SHA；本文行号绑定 886e22a，树变了就重新定位符号。修改生产服务/配置前按基线文件 §7 的隔离与回滚约定执行，字节级核验。