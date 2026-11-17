# ModelGate｜CC Switch v4.0.27 本机源码级 Source Atlas（T01 / A1）

> 研究版本：**CC Switch v4.0.27 tag**（上游 farion1231/cc-switch）
> 源码来源：`/tmp/ccs427/`（v4.0.27 tag 关键文件选摘，16 个 .rs，~1.84MB）。
> 基线 SHA：ModelGate `main`/`886e22a863343192e4ae5ab41e38396df4d4813c`；研究文档分支 `docs/modelgate-deep-research-live-e2e-20261116` @ `7beb346`。
> 任务口径：总任务书 rev2 §3.2 机制 A–J；补充任务书 rev2 §1.0 issue/release 对照。
> 状态：**READ-ONLY 研究笔记**，未改任何生产/共享文件；未触碰真实凭据内容；未发起任何真实模型请求。
> 事实分级：**[源码事实]** = 本机 v4.0.27 tag 选摘逐行核对；**[元数据事实]** = 本机只读 dpkg/文件元数据；**[待真机验证假说]** = 需在隔离环境 A/B 证实；**[上游状态/文档]** = GitHub API/rev2 任务书已核实，非本轮重新抓取。

---

## 0. 版本溯源清单

| 项 | 结论 | 证据 | 分级 |
| --- | --- | --- | --- |
| 本机二进制版本 | `cc-switch 4.0.27` | `dpkg-query -W -f='${Package} ${Version}' cc-switch` → `cc-switch 4.0.27` | [元数据事实] |
| 二进制形态 | 48,663,488 B Tauri 单文件，`/usr/bin/cc-switch`，mtime 2026-11-07 17:00 | `ls -la /usr/bin/cc-switch` | [元数据事实] |
| 源码工作树 | 本机无 CC Switch 源码工作树；仅 deb + 解包资源 | rev2 基线快照 §3.1 | [上游状态/文档] |
| 选摘来源 | `/tmp/ccs427/` v4.0.27 tag 关键文件（16 .rs），抽样 4 文件与上游 tag 逐字节一致 | 任务书授权说明 + 本轮重算 4 文件 sha256（见下） | [元数据事实] |
| 上游最新 | v4.0.33（2026-11-16），本机落后 6 个 patch | rev2 基线快照 | [上游状态/文档] |
| 关键约束 | 线上 main/v4.0.33 代码不代表用户当前运行版；本 atlas 全部绑定 v4.0.27 tag | 总任务书 §3.1 | [上游状态/文档] |

**选摘文件 sha256（本机重算，用于审计追溯）**
```
adde4fe3...  mode/state.rs            fb77040d...  mode/contract.rs
bde7cee4...  proxy/handlers.rs        740e95ed...  proxy/providers/streaming_responses.rs
```
完整哈希见本轮工具输出；`wc -l`：`controller.rs 9011`、`codex_config.rs 6595`、`streaming_responses.rs 7529`、`handlers.rs 5628`、`streaming_codex_chat.rs 1781`、`stack.rs 1748`、`server.rs 1465`、`operation.rs 1204`、`codex_login.rs 805`、`state.rs 515`、`contract.rs 158`。

> 注：任务书给的起点行号（L54/L583/L1185/etc.）与本轮 `/tmp/ccs427/` 选摘**全部吻合**，无需重新定位。这是选摘可信度的强证据。

---

## 1. Source Atlas（文件:函数:行号，绑定 v4.0.27 tag）

### 1.1 模式与凭据生命周期（机制 A / C / I）
| 文件 | 符号 | 行号 | 作用 |
| --- | --- | --- | --- |
| mode/state.rs | `enum Mode { Direct, Proxy }` | 54–57 | Routing 与 Aggregation **共用 Proxy 模式**；无单独 Aggregation 枚举值 |
| mode/state.rs | `struct Contract {version,key,exclusive}` | 61–69 | 契约摘要 `key`(sha256) + 独有字段；摘要相同则不重写客户端文件 |
| mode/state.rs | `ModeState{mode,attached,proxy_route,contract}` | 73–85 | 设备级模式状态；`attached` 退出时分离、启动再接；`proxy_route` 退出代理仍保留 |
| mode/state.rs | `load/save/update/pending/set_pending` | 304/326/333/345/353 | 状态持久化与挂起事务 |
| mode/contract.rs | `key_of(parts) = sha256_hex(...)` | 18–20 | 契约摘要算法（sha256 of sorted JSON parts） |
| mode/contract.rs | `claude(...)/gemini(...)/...` + `CONTRACT_VERSION=1` | 16,24,42… | 各 app 契约构造；代理地址/独有字段/1M 标记进摘要 |
| mode/stack.rs | `encode(app,key,model,one_m)` | 118–127 | 聚合模型 ID 前缀编码（Codex `ccs-`、Claude `ccs-claude-`、Desktop 数字码） |
| mode/stack.rs | `decode(app,id) -> Decoded{Plain,Malformed,Stack,Code}` | 163–202 | 请求侧前缀解码分流 |
| mode/stack.rs | `desktop_code(key,model)` FNV-1a 6 位 | 131–142 | Desktop 稳定散列（不用 std 保证跨版本稳定） |
| mode/stack.rs | `stack_mode_now(app)` | 583–594 | 是否在 Stack（代理且 Stack 开）；读失败按否 |
| mode/controller.rs | `write_proxy(...)` | 379–… | 写代理契约；`force=ATTACH||CATALOG`；`unchanged = !force && live_now.has_contract(key)` |
| mode/controller.rs | `switch_route_for_failover()` | 1164–1170 | 开启故障转移切 P1；调 `switch_route_checked(...,reject_stacked=true)` |
| mode/controller.rs | 聚合拒绝故障转移 | 1183–1189 | `settled_stack.enabled` 时返回中文错误"聚合模式不做故障转移" |
| mode/controller.rs | `record_failover_route()` | 1692 | 路由模式故障转移只记指针、不写客户端文件（测试 L3154 佐证） |
| mode/controller.rs | `drain_legacy_backup()` | 1883–… | 清理旧版备份；`had_backup` 在 L1756 被调用 |
| mode/operation.rs | `get/set_proxy_flags_sync` (auto_failover) | 456–460 | 代理/自动故障转移开关持久化 |

### 1.2 官方登录暂存/归还、凭据原子双写（机制 I，核心可借鉴）
| 文件 | 符号 | 行号 | 作用 |
| --- | --- | --- | --- |
| codex_login.rs | `STASH_FILENAME="codex-login-stash.json"` | 29 | `~/.cc-switch/`，0600，不同步（文件头注 L11） |
| codex_login.rs | `is_residue(auth, third_party_keys)` | 181–184 | 识别旧版切第三方残留 Key（仅 `OPENAI_API_KEY` 且在供应商表内才算残留） |
| codex_login.rs | `access_token_expired(auth, now)` | 188–196 | 按 JWT `exp` 判过期；过期的旧登录不归还（#8573） |
| codex_login.rs | `AuthTarget{ThirdParty,ProxyThirdParty,Managed,Official}` | 199–207 | 凭据目标枚举；注释含 #8431/#8573 真实 issue 对应 |
| codex_login.rs | `plan(input) -> AuthPlan` | 242–319 | 登录暂存/归还主决策；分流 4 目标；输出 `auth/stash/login_on_disk` |
| codex_login.rs | `official(row_auth, native, clearable, stash)` | 323–355 | 切官方卡：API Key 直写 / OAuth 身份比对 / 暂存还原 |
| codex_config.rs | `get_codex_auth_path()` | 278–280 | `~/.codex/auth.json` |
| codex_config.rs | `sync_codex_managed_oauth_live_auth_after_refresh()` | 793–… | compare-and-swap 式托管 OAuth 写回（L786–791 注：best-effort 跨进程 guard，非真正原子） |
| codex_config.rs | `write_codex_live_atomic(auth, config_text_opt)` | 841–888 | **auth.json + config.toml 原子双写**：第一步写 auth(L873–874)，第二步写 config(L876–877)，失败回滚 auth(L878–884) |
| codex_config.rs | `extract_codex_experimental_bearer_token(config_text)` | 3092–… | 第三方 Key 走 `[model_providers.*].experimental_bearer_token`，保留 auth.json 登录 |
| codex_config.rs | `multi_agent_v2` 强制检测 | 900–907,2731 | `[features] multi_agent_v2=true` 比目录优先（#33267 同类机制） |

### 1.3 代理入口、路由与 426 回退（机制 C / E）
| 文件 | 符号 | 行号 | 作用 |
| --- | --- | --- | --- |
| proxy/server.rs | `ProxyServer::build_router()` | 301–… | 路由注册 |
| proxy/server.rs | `/responses`,`/v1/responses`,`/v1/v1/responses`,`/codex/v1/responses` → `post(handle_responses).get(handle_responses_websocket)` | 335–352 | 四路径 GET 一律 426、POST 走 HTTP/SSE |
| proxy/server.rs | test `responses_websocket_handshake_is_answered_with_upgrade_required` | 507–509 | 断言握手回 426 |
| proxy/handlers.rs | `handle_responses_websocket()` | 1060–1074 | 固定 `(426, {error:{code:"websocket_not_supported"}})`；注释=Codex 426→本会话立即改 HTTP 的一手旁证 |
| proxy/handlers.rs | `handle_responses` 入口 | 1076–… | `/v1/responses` 请求处理 |
| proxy/handlers.rs | `decode_codex_request_body` | 935–… | 请求体解码/前缀处理 |
| proxy/handlers.rs | `codex_proxy_error_code(err)` | 2573–2595 | errno→错误码映射（quota/forward_failed/timeout/...），**脱敏元数据可参照** |
| proxy/handlers.rs | `chat_sse_to_response_value` 截断守卫 | 3004–3198 | L3194–3198：无 finish_reason 且无 [DONE] → "Upstream SSE stream appears truncated" |
| commands_provider.rs | `switch_provider_internal/switch_provider` | 190/208 | 供应商切换入口 |
| commands_provider.rs | `resolve_native_credentials/queryProviderUsage` | 616/571 | 用量来源与凭据解析 |

### 1.4 流式转换、终态边界、截断分类（机制 D / E，核心可借鉴）
| 文件 | 符号 | 行号 | 作用 |
| --- | --- | --- | --- |
| streaming_responses.rs | `is_unprocessed_max_output_rejection()` | 84–106 | 终态 incomplete + 零 input/output usage → 判"上游拒绝处理"（如工具 schema 正则被拒），非 max_tokens |
| streaming_responses.rs | `anthropic_error_sse()` | ~60 | 错误 SSE 构造 |
| streaming_responses.rs | `create_anthropic_sse_stream_from_responses` 终态后传输错误 | 4594–4613 | `Err(e) => if terminated { break; }` 静默忽略迟到错误；未终态发 error SSE 后 break（**无重试**） |
| streaming_responses.rs | EOF 兜底 | 4617–4706 | 有实质输出且无 open tool/search/reasoning → 以 `max_tokens` 收尾；否则 `stream_truncated`（tool JSON 半截/thinking 缺签名不可安全 finalize） |
| streaming_responses.rs | snapshot merge（非重试） | 1125–1137 | `cumulative_continuation`=内容片段合并，**与 mid-stream retry 无关**（易误读，特此标注） |
| streaming_codex_chat.rs | `ChatToResponsesState` | 60–96 | Chat→Responses 转换状态；默认 `response_id="resp_ccswitch"` |
| streaming_codex_chat.rs | `[DONE]` 终态立即 return | 801–807 | `[DONE]` → `state.finalize()` 后 `return`，不再消费上游（PR #8281/v4.0.13） |
| streaming_codex_chat.rs | 错误/传输错误分支 | 814–837 | error chunk → failed_event + `break`；Err(e) → failed_event("Stream error: {e}") + break（**无重试**） |
| streaming_codex_chat.rs | EOF 兜底 | 841–857 | completed/finish_reason→finalize；有输出无 finish→`length`；否则 `stream_truncated` |
| streaming_codex_chat.rs | test `truncated_or_empty_compaction_turn_is_reported_as_retryable` | 1608 | "retryable" 指**终态错误分类**供客户端判断，非本地重试实现 |

> **关键负面结论 [源码事实]**：对全部 `proxy/providers/*.rs` 检索 `retry|reconnect|mid-stream|previous_response_id`，除 snapshot 合并与测试名外**无任何 mid-stream retry / continuation / reconnect 实现**；错误路径一律 `break/return` 终止并报 failed/truncated。

---

## 2. 端到端调用图

### 2.1 模式切换 / 配置生命周期（机制 A/C/I）
```
[UI commands_provider::switch_provider / set_route]
  → mode::controller::set_route / switch_route_checked
      → [if reject_stacked && stack.enabled] 拒绝故障转移 (controller.rs:1183-1189)
      → lock_settled → switch_route_locked
          → write_proxy (controller.rs:379)
              → build_proxy_urls
              → contract::{claude,gemini,codex,...} → key_of = sha256 (contract.rs:18)
              → unchanged = !force && live_now.has_contract(key)   // 契约相同 = 不碰客户端文件
              → direct_patch / run(写客户端) / PendingTarget → state::set_pending
          → state::save → 发布路由
  → [退出代理] drain_legacy_backup (controller.rs:1883) / 模式状态 attached=false
```

### 2.2 凭据原子双写（机制 I）
```
[切供应商 / 官方登录 / 归还]
  → codex_login::plan (L242)
      ├─ AuthTarget::Official   → official() (L323)：stash.take/put 还原官方登录
      ├─ AuthTarget::ThirdParty → native 登录 stash.put；写 {} 或删 auth.json
      ├─ AuthTarget::ProxyThirdParty → restore_last（未过期）从 stash 还回（#8431/#8573）
      └─ AuthTarget::Managed    → stash.put(native)，写托管 auth
      → is_residue (L181) 识别残留 Key → 清除
  → codex_config::write_codex_live_atomic (L841)
      1) read old_auth (L853) → write_json_file_private(auth.json) (L874)
      2) write_text_file_private(config.toml) (L877)
         └─ 失败 → atomic_write(old_auth) 回滚 (L878-884) → return Err
```

### 2.3 请求 / 流式响应（机制 C/D/E）
```
Codex 客户端 (GET upgrade 试探)
  → server.rs:337-352 GET /v1/responses → handlers::handle_responses_websocket (L1063)
      → (426, websocket_not_supported)  → 客户端本会话改走 HTTP/SSE
  → POST /v1/responses → handlers::handle_responses (L1076)
      → decode_codex_request_body (L935) → stack::decode (L163) 前缀分流
      → 选 provider / 注入凭据 (experimental_bearer_token 或官方登录)
      → 上游 HTTPS SSE
      → 转换器二选一：
          streaming_responses.rs (原生 Responses→Anthropic SSE)
             ├─ 终态后 Err → if terminated break (L4597) 静默忽略
             └─ EOF 未终态 → 有输出 max_tokens 收尾 / 否则 stream_truncated (L4617-4706)
          streaming_codex_chat.rs (Chat→Responses)
             ├─ [DONE] → finalize + return (L801-807)
             ├─ error/Err → failed_event + break (L814-837)
             └─ EOF → completed/finish→finalize | 有输出 length | 否则 stream_truncated (L841-857)
      → 错误码映射 codex_proxy_error_code (L2573) → 客户端
```
**中断/断流路径无任何"重试→续传"回边**：终止即向客户端报 failed/incomplete/stream_truncated，由**客户端**决定是否重连（Codex 侧机制属 A2 范围）。

---

## 3. 状态转移图（文字化）

### 3.1 应用模式状态（mode/state.rs）
```
[首次运行/无 mode 值] --按遗留 attached 定--> Direct | Proxy
Direct --enter proxy(write_proxy 成功,set_pending 落定)--> Proxy{contract,proxy_route}
Proxy --换路由且契约 key 相同--> Proxy（仅换代理上游，客户端文件不动）
Proxy --换路由且契约 key 不同--> Proxy（先改客户端文件再发布路由）
Proxy --exit/退出--> Direct（attached=false；proxy_route 保留；drain_legacy_backup）
Proxy + stack.enabled --故障转移请求--> 拒绝（保持原默认供应商）
```

### 3.2 凭据状态（codex_login.rs AuthTarget）
```
native 登录(用户原生) ─┬─ preserve 关/第三方直连 → stash.put + auth.json 清空/删
                       ├─ 代理第三方 → 注入 bearer，不动 native；无登录则 restore_last(未过期)
                       ├─ 托管账号 → stash.put(native)，写 managed auth
                       └─ 切官方 → official()：按 OAuth 身份 stash.take/put 还原
is_residue=真 → 残留 Key 清除； access_token_expired=真 → 该 stash 项不自动归还
```

### 3.3 流终态状态（两个转换器一致）
```
in_progress --终态事件(response.completed/[DONE]/finish_reason)--> terminal(commit)
in_progress --传输错误--> [未终态]发 error+failed，break  /  [已终态]静默忽略，break
in_progress --EOF 无终态-->
    ├─ 有实质输出 且 无未闭合 tool/reasoning → incomplete(max_tokens/length) 可收尾
    └─ 否则 → stream_truncated（不可安全 finalize）
终态后 → 停止消费上游（return/break），无 retry 回边
```

---

## 4. 机制对照表（A–J）

| 机制 | v4.0.27 实现 | 关键行号 | 对 ModelGate 的结论 |
| --- | --- | --- | --- |
| A 三模式生命周期 | Direct/Proxy 二态，聚合=Stack；契约摘要决定是否重写客户端 | state.rs:54, contract.rs:18, controller.rs:379 | **可借鉴**：契约摘要驱动的幂等配置写入 |
| B Desktop/CLI 探测、catalog | commands_provider 系列 + codex_config catalog | commands_provider.rs, codex_config.rs:2798 | 本轮选摘未含探测全链，标 **NOT_VERIFIED** |
| C 统一入口/官方 vs 第三方 | 前缀 decode + experimental_bearer_token + 官方登录 | stack.rs:163, codex_config.rs:3092 | **可借鉴**：凭据域隔离 |
| D Responses→Chat/原生 | 孤儿 output 降级（#7196）、tool 按 index 累积（#6449） | 选摘未含 #7196 转换细节，标 **NOT_VERIFIED**（issue 状态 [上游状态/文档]） | 孤儿输出降级思路可借鉴，需取对应函数 |
| E SSE/WS 生命周期 | 426 回退；终态后静默忽略迟到错误；[DONE] 即 return；EOF 截断分类 | handlers.rs:1063, streaming_responses.rs:4597/4617, chat.rs:801/841 | **可借鉴**（终态纪律、截断分类）；**不可借鉴**（无 retry） |
| F V2 密文边界/classic 妥协 | classic 明文子工具兼容开关（v4.0.13 #8253） | 选摘未含聚合指南；出处 docs/guides/aggregation-mode-guide-zh.md L158–177 [上游状态/文档] | **不可借鉴**（有损妥协），仅作对照 |
| G native/local/remote compaction | 本轮选摘未含 compaction 实现 | — | **NOT_VERIFIED**，交 A2/T07 |
| H UI 设置流 | 前端 Tauri 部分不在选摘 | — | **NOT_VERIFIED**，交 A5/T08 |
| I 凭据 stash/原子双写 | STASH_FILENAME、is_residue、write_codex_live_atomic | login.rs:29/181/242/323, config.rs:841 | **强可借鉴**（见 §6） |
| J 隐藏状态/配额漂移 | 配额保护错误码、旧备份清理、catalog 强制 v2 | handlers.rs:2575, controller.rs:1883, config.rs:2731 | **可借鉴**：错误码脱敏映射；漂移清理 |

---

## 5. Issue / Release 对照（绑定 v4.0.27，状态来自补充任务书 §1.0 已核实）

| 编号 | state_reason | 落地版本 | v4.0.27 是否已含 | 本轮源码佐证 |
| --- | --- | --- | --- | --- |
| #1673 | closed(completed) | v4.0.0 起 426 | 是 | handlers.rs:1063 + server.rs:507 |
| #2750 | closed(completed) | 声称 3.16.x | 否（跨版本复发反例） | 无法从 tag 单独证明，采信 [上游状态/文档] |
| #4535 | closed(completed) | 3.16.2/3.16.4 检测 | 是 | handlers.rs:3197 / chat.rs:854 截断检测 |
| #3566 | closed(completed) | v4.0.0 凭据重写 | 是 | login.rs:29/181/242 + config.rs:841 |
| #8126 | closed(**手动关闭，无修复 commit**) | 期望 retry/continuation **未实现** | 不适用 | 全 providers 无 retry [源码事实] |
| PR #8281 | merged | v4.0.13 | 是 | chat.rs:801-807 `[DONE]` return |
| PR #8138 | merged | v4.0.12 | 是 | responses.rs:4597 `if terminated break` |
| #8404 | **open** | 真 WS 无排期 | 否 | handlers.rs:1063 仍固定 426 |
| #7400→#7196 | closed | v4.0.9 孤儿 output 降级 | 是 | 选摘未含函数，标 NOT_VERIFIED（采信状态表） |
| #6449 | closed(stale 自动关) | 按 index 累积 tool_calls | 行为已改善 | chat.rs 的 `tools: BTreeMap<usize,..>`(L65) 佐证按 index 累积；回归测试存在 |
| #7459 | **open** | oneOf schema 清洗 | 否 | 仅 moonshot/xai 特化 [上游状态/文档] |
| #8253 | v4.0.13 release | classic 开关默认打开 | 是 | 出处指南 L158–177 [上游状态/文档] |

**结论**：v4.0.27 已包含 #8138/#8281/#3566/#7196 全部落地代码；用户运行版不是"旧版未修复"，而是"修复范围本来就只到**检测 + 终态边界 + 凭据域**"。

---

## 6. ModelGate 可借鉴 / 不可借鉴清单

### 6.1 可借鉴（源码级证据支撑）
1. **契约摘要驱动的幂等配置写入**（contract.rs:18–20, controller.rs:418）：sha256(契约 parts) 相同则不碰客户端文件 → ModelGate 配置事务/重启幂等可对照，避免每次切换全量重写丢配置。
2. **凭据 stash + 残留识别 + 原子双写回滚**（login.rs:29/181/242/323, config.rs:841–888）：官方登录暂存/归还、过期登录不归还（#8573）、auth.json+config.toml 双写第二步失败回滚第一步 → 凭据域隔离与无损恢复的成熟范式。
3. **终态后立即停止消费上游 + 迟到传输错误静默忽略**（responses.rs:4597, chat.rs:801–807）：防止第二终态/污染；对应 ModelGate `streamRawResponses` 无终态提前退出的反面（补充任务书 §3.5）。
4. **零 usage incomplete 判为上游拒绝**（responses.rs:84–106）：避免把工具 schema 被拒误报为 max_tokens。
5. **EOF 兜底区分可收尾 vs 必须报错**（responses.rs:4617–4706, chat.rs:841–857）：纯文本可 incomplete 收尾；tool/reasoning 未闭合必须 stream_truncated。
6. **错误码脱敏映射**（handlers.rs:2573–2595）：errno→`cc_switch_*` 码，日志只留元数据。

### 6.2 不可借鉴 / 须自建
1. **mid-stream retry / continuation**：上游为空白（#8126 手动关闭、PR #8281 明确 "does not implement retries or continuation"），**不得当作 CC Switch 已有能力**。ModelGate 的续轮韧性/增量预登记是上游空白。
2. **真 WS 转发（WSS 端到端代理）**：#8404 open 无排期，v4.0.27 仍固定 426；CC Switch 走的是"放弃 WS 语义"的简单路线，ModelGate 桥是"保留客户端 WS + 环回 HTTP"路线，取舍须在 T13 ADR 裁决。
3. **聚合故障转移**：明确不做（controller.rs:1183–1189 主动拒绝）；不要照搬。
4. **classic 明文子工具兼容**（F）：v4.0.13 #8253 有损妥协（缺 followup_task/interrupt_agent），**仅作有损对照，禁止抄作完成方案**。
5. **#2750 closed 后跨版本复发**：证明"closed≠解决"，引用任何 closed issue 必须核对 state_reason + 复发评论。

---

## 7. 研究门槛 §2 留痕表

| # | 门槛项 | 本轮留痕 | 状态 |
| --- | --- | --- | --- |
| 1 | 本仓库证据 | 基线 SHA 886e22a / 研究分支 7beb346；源码行号全部重新定位（§1）；ModelGate 热点对照见补充任务书 §3 | 完成 |
| 2 | 原生依赖证据 | CC Switch 绑定 v4.0.27 tag + 本机 dpkg 4.0.27 [元数据事实]；Codex/rust-v0.167.0 属 A2 范围，本轮不越界 | 部分（A2 接续） |
| 3 | 竞品实现证据 | CC Switch v4.0.27 tag 选摘逐行 + 调用图/状态图（§2/§3）；其他项目 OpenCodeX/CLIProxyAPI 属 A3 范围 | 部分（A3 接续） |
| 4 | 论文/社区证据 | issue/release 对照（§5）；论文属 A3，本轮不硬凑 | 部分（A3 接续） |
| 5 | 方案取舍 ≥3 路线 | §6 可借鉴/不可借鉴 + 总任务书 §4.4 传输四路线（a/b/c/d）；本轮给方向，最终 ADR 由 T13 裁决 | 完成（方向级） |
| 6 | 真机验证方案 | 见 §8 可证伪验证矩阵；本轮未发起真实请求 | 完成（方案级，待执行） |
| 7 | 可审查成果 | 本 atlas（独立 worktree，未碰共享文件）+ sha256 + 行号；真实源不可得处标 NOT_VERIFIED | 完成 |

**每条结论的可证伪方式**：
- "契约摘要相同不重写" → test `a_route_switch_with_the_same_contract_leaves_the_client_file_alone`（controller.rs:2900）可复跑；ModelGate 侧可做配置事务前后文件 mtime 对比。
- "无 mid-stream retry" → 全 providers grep `retry|reconnect` 无命中（本轮已做）；真机断流后观察客户端是否 Reconnecting（属 A2/T13）。
- "原子双写回滚" → 注入第二步写失败，断言 auth.json 还原旧字节；需隔离 CODEX_HOME。
- "终态后静默忽略" → 构造终态后迟到 Err，断言无第二终态事件；离线单测可做。

---

## 8. 待真机验证假说（**[待真机验证假说]**）

| 假说 | 依据 | 可证伪实验 | 归属 |
| --- | --- | --- | --- |
| H-CCS-1：426 回退在本机 Codex 26.1103 内置 app-server 仍即时生效 | handlers.rs:1060 注释为一手旁证，但那是上游作者观察 | 隔离 profile 抓 GET /responses 握手响应码=426 + 后续 POST；记录首事件延迟 | A1/A5（需授权隔离实例） |
| H-CCS-2：CC Switch classic 有损妥协确实导致跨供应商子任务失败 | #33267 + 聚合指南 [上游状态/文档] | GPT 父→Go 子 spawn，观察 `unreadable_encrypted_agent_task`；对比开关开/关 | A2/T06（需真实额度授权） |
| H-CCS-3：本机历史断流不经过 CC Switch（日常=官方直连，网关与 CCS 均停） | rev2 基线快照 [元数据事实] | 向用户确认中断时间窗 + 当时接管工具；比对 cc-switch.log（末次 11/13） | 团队/T13-A（第一问） |

---

## 9. 尚未覆盖 / 未核实项（诚实边界）

- 机制 B（探测/catalog 全链）、D（#7196 孤儿 output 转换函数）、F（聚合指南原文）、G（compaction）、H（UI）在 `/tmp/ccs427/` 选摘中**无对应文件**，本 atlas 标 **NOT_VERIFIED**，未编造行号；需要时按同 tag 用 `gh api` 单文件重抓（不整树 clone）。
- 本轮**未读取**任何 auth.json / 密钥 / OAuth Token / Cookie 内容；仅只读元数据（dpkg 版本、文件大小、sha256、源码文本）。源码中的 `experimental_bearer_token` 等仅作符号名引用，无真实值。
- 未启动任何服务、未改生产配置、未修改真实 CC Switch/Codex 登录、未发起任何真实模型请求。
- 所有 issue/release 状态来自 rev2 任务书已核实结果，本轮**未重新调用 GitHub API**（声明为 [上游状态/文档]，非本轮一手抓取）。

---

## 10. 一句话回答"CC Switch 为什么在同类场景能跑，哪里折中，哪里同样不支持"

- **能跑**：Direct/Proxy 二态 + 契约摘要幂等写配置 + 凭据 stash/原子双写保证"切换不丢登录、不串 Key"；终态纪律 + 截断分类保证"不把半截流当成功、不被迟到错误污染第二终态"。
- **有损折中**：终态后直接放弃流（不重试/不续传），靠客户端重连；WS 直接回 426 放弃 WS 语义；跨供应商子任务用 classic 明文妥协（缺 followup/interrupt）。
- **同样不支持**：mid-stream retry/continuation（上游空白）、真 WS 端到端代理（#8404 open）、聚合故障转移（主动拒绝）。**"closed issue" ≠ 断流已解决**（#2750 复发史为证）。
