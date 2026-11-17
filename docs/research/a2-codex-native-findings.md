# A2 · Codex/Go 原生协议研究员成果（G0.5）

> 研究时间 2026-11-17 · 角色 A2（T02/T06/T07/T13-B）· 只读研究
> 源码基准：官方 `openai/codex` tag **rust-v0.167.0**，路径相对 `codex-rs/`；单文件 raw 读取，未整树 clone。
> 本机 CLI `codex-cli 0.167.0`；本机 Desktop 内置 app-server `codex-cli 0.167.0-alpha.3.2`（见 §4）。
> 所有结论区分【tag 已核实事实】（源码行号直证）与【待真机验证假说】。

## 证据文件清单（本地快照，供复核）
`research/rust-v0.167.0/`：`mpi_lib.rs`(946) `api_lib.rs`(130) `client_provider.rs`(103) `responses_websocket.rs`(1456) `responses_retry.rs`(211) `retry.rs`(118) `features_lib.rs`(2376) `core_client.rs`(3271) `config_toml.rs`(1203) `feature_configs.rs`(605) `capabilities.rs`(60) `responses_websocket_probe.rs`(101) `world_model_catalog.rs`(163) `appserver_model_catalog.rs`(134) `inter_agent_message.rs`(73) `spawn.rs`(252) `multi_agents_handler.rs`(99) `agent_message_board.rs`(295) `multi_agents_session.rs`(121) `world_multi_agent_mode.rs`(107) `child_config.rs`(374) `openai_models.rs`(2280) `turn.rs`(3612) `turn_context.rs`(1515) `state_turn.rs`(316) `protocol.rs` `tree.json`。
抓取 URL 模板：`https://raw.githubusercontent.com/openai/codex/rust-v0.167.0/codex-rs/<path>`。

---

## 1. §2.2 传输机制表核实（tag rust-v0.167.0）

逐条复核补充任务书 §2.2。**全部 9 项与任务书表述一致**，下列给出直证行号（=任务书行号已核实，无偏差）。

| 机制 | 任务书引用 | 本次核实行号（tag） | 源码事实 | 判定 |
| --- | --- | --- | --- | --- |
| 握手 URL | mpi lib.rs:86 / api lib.rs:19 / provider.rs:91 | `mpi_lib.rs:86` `api_lib.rs:19` `client_provider.rs:90-98` | `CHATGPT_CODEX_BASE_URL="https://chatgpt.com/backend-api/codex"`；`RESPONSES_PATH="/responses"`；`websocket_url_for_path` 把 http→ws、https→wss | ✅ tag 已核实 |
| connect timeout 15s | mpi lib.rs:77 | `mpi_lib.rs:77`、getter `:561-566` | `DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS=15_000` | ✅ |
| idle 300s 统一含首事件 | mpi lib.rs:72；responses_websocket.rs:809/1048 | `mpi_lib.rs:72`；`responses_websocket.rs:806-810`、`:1043-1048` | `DEFAULT_STREAM_IDLE_TIMEOUT_MS=300_000`；`tokio::time::timeout(idle_timeout, ws_stream.next())` 位于 `loop` 顶部，对**每个** next 计时（含首事件），无独立 first-event timeout；超时文本 "idle timeout waiting for websocket" | ✅（**无独立首事件超时**得到确认，#23807 根因成立） |
| 客户端不主动 ping / 无 pong deadline | responses_websocket.rs:102-108 | `responses_websocket.rs:102-108`、`:986` | 只在收到 `Message::Ping` 时回 `Pong`；收到 `Pong` 时空操作；无定时 ping、无 pong deadline | ✅ 客户端侧确无保活心跳 |
| 重试 5/4/100、Reconnecting n/max、隐藏第 1 次 WS 重试 | mpi lib.rs:73-81；responses_retry.rs:156；retry.rs | `mpi_lib.rs:73-74,79-81`；`responses_retry.rs:142-167`；`retry.rs:43-52` | STREAM=5 / REQUEST=4 / 硬上限各 100；"Reconnecting... {n}/{max}"；`report_error = retry_count>1 \|\| debug \|\| !ws_enabled`（release 隐藏首次）；指数退避 `2^(n-1)`+jitter 0.9–1.1，尊重 retry_after | ✅ |
| unbounded_connection_retries（0.167 新增，Stable 默认 true） | features lib.rs:1550；responses_retry.rs:23-24,96-118 | `features_lib.rs:1548-1553`；`responses_retry.rs:23-24,94-119` | `unbounded_connection_retries` Stage::Stable / default_enabled=true；ConnectionFailed → "Reconnecting... waiting for network"，5s 起、×2、60s 封顶，无次数上限（仅 Sampling 且非 internal/bedrock） | ✅ |
| HTTPS fallback：426 立即；流重试耗尽永久降级，警告文本，计数清零 | core/client.rs:1751,2193,791；responses_retry.rs:120-139 | `core_client.rs:1751-1755,2193-2195,2562-2571,789-810`；`responses_retry.rs:121-140` | ① 426→`try_switch_fallback_transport()` 立即；② `retries>=max_retries`→`force_http_fallback()`：`disable_websockets.swap(true)` 永久置位、清 `cached_websocket_session`、发 "Falling back from WebSockets to HTTPS transport" warning、`retries=0` | ✅ |
| 永久降级最坏 25 分钟 | （任务书推导：5×300s） | 由 `mpi_lib.rs:72-73` + `responses_retry.rs:121-140,165-167` 组合 | 每次流重试最长 idle 300s，5 次耗尽才降级 → **推导最坏 ≈25 分钟**。源码未写死"25 分钟"，是该两常量的组合推论 | ✅ 推导成立（标注为推导，非字面常量） |
| WS previous_response_id 增量 + x-codex-turn-state + store:false + mismatch 全量重发 | core/client.rs:1163,424,头注12-26 | `core_client.rs:12-18,170,424-495,1150-1170,1622-1636,2222-2291`；`mpi_lib.rs` store 字段 | HTTP 请求恒 `store:false`(:1163)；WS 用 `previous_response_id`+增量 input(:2271-2291)；`X_CODEX_TURN_STATE_HEADER="x-codex-turn-state"`(:170,2222)；mismatch 比较 model/tools/tool_choice/parallel/reasoning/store/stream/include/service_tier/prompt_cache/text，任一变化→`NonIncrementalReason`→全量重发(:424-495,1636) | ✅ |
| 60 分钟 WS 寿命 + previous_response_not_found→全量重发 | responses_websocket.rs:980,175-179,735-748 | `responses_websocket.rs:175-179,735-748,980-983`；`turn_context.rs:1294-1305` | 常量 `WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE` + 文本明确 "(60 minutes)"；二者均映射 `ApiError::Retryable`；not_found 文本 "Retrying the full request."；close before completed→Err | ✅ |
| 握手 probe（0.167 新增） | responses_websocket_probe.rs | `responses_websocket_probe.rs:1-101`、`responses_websocket.rs:510` | 带类型的握手失败分期（Tls/Unknown），含 immediate_close 捕获；Debug 脱敏（reason/header 不打印） | ✅ 新增项佐证 |

**精度修正（供主代理注意）**：
1. "会话级永久降级"更精确是 **进程/客户端级**：`disable_websockets` 位于 `ModelClientState`（`core_client.rs:209,226`），由 `ModelClient`(:299) 与每个 turn 的 `ModelClientSession`(:328) 共享，`swap(true)` 后直到 ModelClient 重建才恢复——比"单会话"更持久。注释自称 "session-scoped fallback state"(:1189) 但物理归属是共享 state。
2. `x-codex-turn-state` 在 auth owner 变化时清空（`core_client.rs:1830-1831` `turn_state=Arc::new(OnceLock::new())`）——状态所有权随认证归属重置，是 ModelGate 复用 WS 时必须尊重的边界。
3. 25 分钟是 5×300s 推导值，非源码字面常量。

---

## 2. direct 路径完整状态机（官方直连：Codex 0.167 → chatgpt.com/backend-api/codex）

```
[INIT / 新 turn]
   │ 读取 provider 能力 supports_websockets(:606 true for OpenAI)
   │ ws_enabled = supports_websockets && !disable_websockets  (core_client.rs:1189-1195)
   ├──false─► [HTTP/SSE 路径]  store:false, 请求级 max_attempts=4 (request_max_retries)
   │
   └──true──► [HANDSHAKE]
        │ GET upgrade wss://chatgpt.com/backend-api/codex/responses
        │ connect timeout 15s (mpi:77)；握手 probe 分期(Tls/Unknown)
        ├──426 Upgrade Required──► [永久降级 HTTP] (core_client.rs:1751-1755)  ← 观测点 O1
        ├──TLS/其它握手失败──────► unbounded_connection_retries (5s→60s 无上限)  ← O2
        └──101 upgrade OK──► [WS ESTABLISHED]
                 │ (可选) prewarm: v2 response.create generate=false，等 completed
                 │        视为首连接尝试 (core_client.rs:头注:16-25)  ← O3
                 ▼
            [STREAM / IDLE LOOP]  (responses_websocket.rs:806-810)
                 │ 每轮 tokio::time::timeout(300s, ws_stream.next())
                 │ 服务端 Ping→回 Pong(:102)；客户端无主动 ping/无 pong deadline
                 │ previous_response_id + 增量 input + x-codex-turn-state 续轮
                 ├──收到 response.completed/failed/incomplete──► [TURN DONE]  ← O4
                 ├──300s 无事件 "idle timeout waiting for websocket"──► [RETRY]  ← O5
                 ├──server Close before completed (:#980)──► [RETRY]  ← O6
                 ├──code=websocket_connection_limit_reached (60min)──► [RETRY]  ← O7
                 ├──code=previous_response_not_found──► [RETRY + 全量重发]  ← O8
                 └──收到 response.interrupt──► Drain(排空)/Cancel{deadline}(:311-333)  ← O9
                 ▼
            [RETRY]  (responses_retry.rs)
                 │ Retryable→retry_delay（指数退避+jitter, 尊重 Retry-After）
                 │ 连接失败 + unbounded feature→"waiting for network" 无上限
                 │ 流级→Reconnecting n/5（release 隐藏首条）
                 ├──retries < 5──► 回 [STREAM]（同 conn 若未 closed，否则重连）
                 └──retries >= 5─► force_http_fallback：disable_websockets=true 永久，
                                   warning，retries=0 ──► [HTTP/SSE 永久路径]  ← O10
```

### 可证伪观测点（每个绑定日志/事件字段，供真机或离线注入核对）
- **O1** 握手 426：客户端是否**当轮立即**转 HTTP（无 Reconnecting）。证据=`codex.transport.fallback_to_http` counter + 无 429/5xx 重试日志。cc-switch 注释（补充任务书 §1.1）为一手旁证。
- **O2** 网络断：`Reconnecting... waiting for network` 文本出现且次数**不封顶**、间隔 5→10→…→60s。若出现 5/5 终止则 unbounded feature 未生效/被排除条件命中。
- **O3** prewarm：首轮前是否发 `generate=false` 的 `response.create` 并等 completed；`last_response_from_untraced_warmup` 标记。若 prewarm 失败是否走流重试而非直接降级。
- **O4** 正常终态：`response.completed` 到达即发下一轮，不等流结束（订阅后端 completed 后不关流）。
- **O5** idle 300s：工具结果后停顿精确 300.003s（#23807），期间无 first-event timeout；`idle timeout waiting for websocket` 文本。
- **O6** close before completed：`websocket closed by server before response.completed` 后进入重试而非 400。
- **O7** 60min：`websocket_connection_limit_reached` + "60 minutes" 文本 → Retryable 重连（非永久降级）。
- **O8** not_found：`previous_response_not_found` → "Retrying the full request." → 下轮无 `previous_response_id`（全量 input）。
- **O9** interrupt：Drain 保留部分输出不超时；Cancel 超 deadline → "timed out draining interrupted response"。
- **O10** 5 次耗尽：`Falling back from WebSockets to HTTPS transport` warning + retries 清零 + 后续同进程所有 turn 均 HTTP（永久）。

---

## 3. 原生能力结论表（V2 / 契约硬要求；禁止 MCP 代理/classic 子工具/自建 AgentTeam 偷换）

| 能力 | 结论 | tag 源码证据 | 配置面 / 边界 |
| --- | --- | --- | --- |
| `agents.default_subagent_model` | **原生支持** | `config_toml.rs:778` `pub default_subagent_model: Option<String>`（"Default model for spawned subagents when spawn call does not select one"）； sibling `default_subagent_reasoning_effort:780` | `[agents]` 段；与 spawn 调用内 `model`/`reasoning_effort` 覆盖同时存在；V2 spawn 还可用 `expose_spawn_agent_model_overrides`(`feature_configs.rs:348-352`) 暴露覆盖 |
| Provider 继承（子代理继承父 provider） | **原生支持** | `child_config.rs:143-159`：spawn 构造子 config 时 `config.model_provider = turn.provider.info().clone()`(:147)、`config.model = turn.model_info().slug`(:145)、reasoning effort/summary、developer_instructions 均继承 | 注意：这正是**跨供应商 V2 密文不可解**的结构根源——子代理沿用父 provider，但若被显式改到别家 provider 则密文断裂（见 #33267 行） |
| multi_agent_v2 catalog 强制（社区 #33267：catalog 强制 v2、config 关闭无效） | **原生机制存在；"config 关闭无效"待真机验证（社区已证实链）** | ① `MultiAgentV2` Stage::Stable default_enabled=**false**(`features_lib.rs:1598-1603`)；② 但 catalog/model 带 `multi_agent_version: Option<MultiAgentVersion>`(`openai_models.rs:283-285,511-512`)，enum=`Disabled/V1/V2`(`protocol.rs:3378-3382`)；③ 每 turn 解析 `multi_agent_version = resolve(...)`，`model_info.multi_agent_version` 参与(`turn_context.rs:1294-1305`)；④ `model_supports_multi_agent_backend` 在 V2 下过滤掉 `multi_agent_version=Disabled` 的 model(`child_config.rs:24-30`)，spawn catalog 亦按此过滤(`world_model_catalog.rs:35-42`)。**即模型 catalog 声明 V2 会覆盖 config 的关闭意图**：config `feature=false` 但模型声明 V2 → turn 仍取 V2，且 V1-only 模型被踢出 spawn 列表。 | workaround 是 models.json 把 `multi_agent_version` 置 v1/null（=有损 classic，**不得冒充 V2 通过**）。可证伪点：隔离 profile 设 `[features.multi_agent_v2] enabled=false` + 声明 V2 的 catalog → 观察 spawn 是否仍走 V2 工具（wait_agent/followup_task 存在即 V2）。 |
| remote_compaction 能力（OpenAI/Azure 默认 V2） | **原生支持（provider 能力层，非 feature flag）** | `capabilities.rs:33-55` `from_config`：`remote_compaction = if info.is_openai() \|\| is_azure_responses_provider(...) { V2 } else { Unsupported }`；`RemoteCompactionSupport::V2`；`ProviderCapabilities.remote_compaction:18`。feature `remote_compaction_v2` 已 **Stage::Removed**(`features_lib.rs:2276-2280`)=毕业进 provider 能力。执行路径 `turn.rs:248,1632-1673`（V2 远程压缩 + foreground/skip fallback） | 第三方 provider 默认 Unsupported，除非 `capabilities.remote_compaction` 显式覆盖(:45-52)。契约 T07 要求"只由 Codex 原生压缩"→走此 provider 能力，OpenAI/Azure 即 V2。 |
| 加密 agent_message 边界 | **原生支持（请求级密文 passthrough + 跨供应商清洗）；V2 跨供应商密文不可解是真实存在边界** | 请求构造时 `include=["reasoning.encrypted_content"]`，OpenAI+output_token_replay 才加 `output.encrypted_content`(`core_client.rs:1119-1122`)；**非 OpenAI 时** `clear_encrypted_content()` + `clear_internal_chat_message_metadata_passthrough()` + `encrypted_function_args=None`(:1091-1109)。即官方密文对第三方被主动清洗（对应 #33267 "跨供应商密文不可解"）——这是原生边界，不是 bug 可绕过。inter-agent 消息本体是明文 `payload: String`(`inter_agent_message.rs:23-29`)，作为 developer/assistant contextual fragment 注入（非独立加密信封）。 | 对 ModelGate 含义：若让 GPT 父(官方) spawn 第三方 provider 子，V2 加密工具输出跨供应商无法解 → 必须 NO-GO + 交所有者裁决，不得用 classic 明文子工具冒充 V2。可证伪点：跨 provider spawn 后子代理报 `unreadable_encrypted_agent_task`/`Encrypted function output content could not be decrypted`。 |

**能力结论汇总**：default_subagent_model=原生支持；Provider 继承=原生支持；multi_agent_v2=机制原生存在但 catalog 可强制（"config 关闭无效"社区已证、真机待证）；remote_compaction=原生支持（OpenAI/Azure 默认 V2）；加密 agent_message 边界=原生存在且**构成跨供应商 NO-GO 硬边界**。

---

## 4. 本机 app-server 版本取证（不读密钥）

| 项 | 值 | 取证方式（脱敏） |
| --- | --- | --- |
| ChatGPT 桌面包版本 | `26.1103.32239` | `dpkg-query -W -f='${Package} ${Version}' chatgpt` |
| 桌面内置 app-server 二进制 | `/usr/lib/chatgpt/resources/codex`（单文件 ~320MB，root:root） | `ls -la /usr/lib/chatgpt/resources/codex` |
| **内置 app-server 自报版本** | **`codex-cli 0.167.0-alpha.3.2`** | `/usr/lib/chatgpt/resources/codex --version`（只取 stdout 首行，无 token/cookie） |
| 本机 CLI 版本 | `codex-cli 0.167.0` | `~/.local/bin/codex --version`（symlink→`ai/harness/codex/cli/versions/0.167.0`） |
| 日常 config 身份（元数据） | `model=gpt-6-luna`, `model_provider=openai`, 存在 `[agents]`/`[agents.go_deepseek]`/`[model_providers.custom]`/`[features]` 段 | `grep` 只取 section 头与非敏感键名，**未读 auth.json / token / cookie** |

**对照结论**：桌面内置 app-server 与 CLI **同为 0.167.0 基线**，但桌面是 `alpha.3.2` 预发布、CLI 是 stable。源码核实用 tag `rust-v0.167.0`（stable），对桌面 alpha.3.2 属**同基线近邻**，精确逐字一致仍待真机确认（标【待验证】）。两端默认传输机制（§1）预期一致。

**边界遵守**：全程未读取/打印 `auth.json`、Cookie、OAuth Token、API Key；`strings` 扫描已过滤凭证样式输出，仅保留版本 marker（本次版本 marker 由 `--version` 直接给出，strings 过滤结果为空）。

---

## 5. 研究门槛 §2 逐项留痕

| 门槛 | 本轮完成 |
| --- | --- |
| 本仓库源码行号 | ✅ 读 docs 分支任务书/补充任务书/启动提示词；基线 main 886e22a（A4/A5 负责网关源码行号，本代理不重复） |
| 原生依赖源码 | ✅ tag rust-v0.167.0 逐文件 raw 读取 26 个文件，§2.2 9 项 + 5 项原生能力全部定位到文件:行号 |
| 竞品源码 | ⏸ 本任务书未要求 A2 做 CC Switch/OpenCodeX 竞品（归 A1/A3）；§1.1 cc-switch 426 注释作为旁证引用（A1 负责逐行） |
| issue/论文/社区 | ✅ 引用 #23807(300s)、#33267(catalog 强制/密文)、#51886、#44099、#32366 等（任务书状态表已核实，本代理复核与源码机制一致） |
| ≥3 条路线取舍 | ✅ 见 §6 |
| 真机验证方案 | ✅ 见 §7（O1–O10 + 能力可证伪点） |
| 可审查成果 | ✅ 本文 + `research/rust-v0.167.0/` 源文件快照 + 行号表，可被任何人按 URL 复核 |

## 6. 传输/能力 ≥3 路线取舍（不预设赢家）
1. **426 立即降级**（cc-switch 路线）：握手回 426 → 本会话转 HTTP/SSE。简单、无 Reload 抖动，但放弃 WS 语义（增量/turn-state 失效）。适合"只要不断流"场景。
2. **5 次重试+永久降级**（Codex 原生 0.167）：保留 WS 语义，代价是最坏 25 分钟停顿 + 会话级永久降级。是 direct 路径既定行为，ModelGate 桥必须与之互操作。
3. **真 WS/WSS 端到端代理**（#8404 无人实现）：最大程度保真，但引入环回/认证域/60min 寿命/密文边界全部复杂度；ModelGate 现状是"客户端 WS→环回 HTTP"，非端到端 WS。
4. **有界续传/半死流看门狗**（A4 T13-F）：补偿原生 300s idle 太慢 + 网关无事件看门狗，但须区分建连失败（可安全重试）与已产事件/工具（不可盲目重放）。

## 7. 真机验证方案（绑定可证伪观测）
- **direct 路径**：隔离 profile（`CODEX_HOME=/tmp/...`）跑 `codex exec`，开启 debug 日志，按 O1–O10 抓取 `Reconnecting n/5`/`waiting for network`/`idle timeout waiting for websocket`/`Falling back...`/`60 minutes`/`previous_response_not_found` 文本与计数。验证 300s idle 与 5 次重试上限（#23807 在 0.167 仍成立）。
- **能力**：`[features.multi_agent_v2] enabled=false` + V2-declaring catalog → 看 spawn 是否仍 V2（#33267）；跨 provider spawn → 看是否报密文不可解（NO-GO 证据）；GPT 父 + Go DeepSeek 子 `default_subagent_model`/reasoning effort 独立配置是否生效。
- **Desktop vs CLI**：桌面 0.167.0-alpha.3.2 与 CLI 0.167.0 各跑同一脚本，比对 §2.2 默认值是否逐字一致。
- **不得**：为通过验收调大 idle/关 supports_websockets/删历史/换模型；不得把 mock 记为 real。

---

## 8. 事实 / 假说分界
- **tag 已核实事实**：§1 全部 9 项机制；§3 五项能力的源码存在性与配置键；§4 版本号。均带文件:行号，可复核。
- **待真机验证假说**：桌面 alpha.3.2 与 stable 逐字一致；#33267 "config 关闭无效"在本机 catalog 的实际触发；25min 停顿的真实观测；各观测点 O1–O10 的真实日志序列；跨供应商 V2 密文不可解是否在 ModelGate 目标拓扑中必然触发（决定 NO-GO）。
