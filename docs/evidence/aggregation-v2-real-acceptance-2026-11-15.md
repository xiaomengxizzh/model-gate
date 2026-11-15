# ModelGate V2｜真实验收记录（2026-11-15，所有者授权后首轮）

> 所有者授权：本轮对话中明确「授权真实验收」。执行范围遵守 V2 契约：**真实 GPT 只允许 `gpt-6-luna`**；Go 只用 `deepseek-v4.1-flash`；不下载、不安装、不改用户日常 Codex 配置与生产服务。
> 本文件只记录**实际发生**的事实，不构成对未执行项的通过。

被测树绑定（按用例区分，避免"一次实验绑所有回执"的精度问题）：
- §2.1 直连 Go 回执：`2645b8f29d2a5ac31302300f56830d3222ae349c`。该路径是 `/v1/responses` 直连，**不经过** `projectThirdPartyResponsesParams`（只在 Codex 原生代理路径生效），因此在 `2645b8f` 上可复现。
- §2.2–§2.4 Codex 会话回执：`3dfd44aee948409825306cbbff067bbf4f23b2c4`（含第三方参数投影修复）。

## 1. 环境与隔离

| 项目 | 值 |
| --- | --- |
| 网关 | 本仓库 `node src/index.js`，`MG_CONFIG_DIR=/tmp/mg-real-accept/state`（复制自 `~/.local/state/modelgate-desktop/gateway`），`127.0.0.1:8891` |
| Go 凭据 | `OPENCODE_API_KEY` 取自 systemd user environment（`~/.config/environment.d/90-apikeys.conf`），**未打印、未入库** |
| 客户端 | `/usr/lib/chatgpt/resources/codex` → `codex-cli 0.167.0-alpha.3.2`；`CODEX_HOME=/tmp/mg-real-accept/codexhome`（全新，未触碰 `~/.codex`） |
| 模型目录 | 注入本地 ModelInfo：`context_window=8000`、`auto_compact_token_limit=1200`（测试夹具，用于在真实 token 量下触发自动压缩） |
| provider 能力 | `[model_providers.mgreal.capabilities] remote_compaction = "unsupported"` |

## 2. 实测结果

### 2.1 Go 真实推理：PASS_REAL（网关层，绑定 `2645b8f`）

```
POST http://127.0.0.1:8891/v1/responses
{"model":"deepseek-v4.1-flash","input":"Reply with exactly: REAL_GO_OK","max_output_tokens":64}
→ HTTP 200 / 1.86s / model 回写 deepseek-v4.1-flash / 输出 "REAL_GO_OK"
→ usage.opencode.billing_source = "go"，total_tokens 71
```

公共别名同样可路由并按别名回写：`mg-opencodego-deepseek-v4-1-flash` → HTTP 200、`model` 回写该别名、`billing_source=go`（`max_output_tokens=16` 导致 `status=incomplete`，属截断不是失败）。

**结论**：MG-R003 的「Go 凭据 + 目标模型真实推理 + 公共 ID 出站一致」在网关层成立。

### 2.2 Codex 原生压缩（真实 Go 模型）：observed（部分成立，不足以判该子用例 PASS_REAL）

真实 `codex exec` 两轮（第二轮回放同一会话）：

```
turn1: 用户要求执行 printf COMPACT_BEFORE_OK → 输出中出现 COMPACT_BEFORE_OK
turn2: codex exec resume --last → 客户端输出 "context compacted"，随后继续该会话
```

压缩由 **Codex 自己**执行（`context compacted` 由客户端打印），网关只转发；Go 上游收到的是明文压缩提示，不是伪造密文。

**边界**：V2 的 `native-compaction` 子用例还要求压缩事件属性（`owner=codex`）、历史未丢、压缩后上下文可续；本节只证明了「Codex 自己触发压缩 + 网关透传」，故仅记 `observed`，不把该子用例写成 `PASS_REAL`。

### 2.3 真实缺口 1：第三方 Responses 参数（已修，本轮）

Codex 真实请求体包含（tee 代理捕获）：

```json
{"reasoning":{"effort":"none","context":"all_turns"},
 "text":{"verbosity":"low"},
 "include":["reasoning.encrypted_content"]}
```

OpenCode Go 上游直接 400：`reasoning.context: this reasoning option requires a native Responses target`。**修复**：`src/index.js` 新增 `projectThirdPartyResponsesParams()`，只对非官方 Responses 目标剔除 `reasoning.context`、`text.verbosity`、`include:reasoning.encrypted_content`，并把剔除项写入诊断日志；官方目标仍逐字节透传。修复后真实 Codex 首轮即 200。

### 2.4 真实缺口 2：Codex 未向第三方 Go 模型下发工具定义（未修，阻断 MG-R005/R006）

真机观察（隔离 CODEX_HOME，逐次捕获请求体）：

| 观测 | 结果 |
| --- | --- |
| Codex → 网关请求体 `tools` 字段 | **`tools: None`**（三种目录变体均如此：`tool_mode="code_mode_only"`、去掉 `tool_mode`、`tool_mode="non_code_mode_only"`）|
| 网关直连 Go 的工具探针 | **正常**：返回结构化 `function_call exec_command {"cmd":"printf TOOL_PROBE_OK"}` |
| Codex 会话里的工具执行 | **未发生**：要求创建 `marker.txt`，客户端 exit=0 但文件不存在；输出渲染出 12 行原始 `<|DSML| invoke …>` 文本 |

结论：**网关的 `function_call` 翻译是通的**；断点在 Codex 判定该模型「不下发工具」，模型拿不到工具定义后才用 DSML 文本"假装"调用。因此 MG-R005 `native-tools` 与 MG-R006 `native-tool` / `post-compact-followup` / `context-proof` 不通过。「context compacted」只证明压缩机制成立。

下一步定位：Codex ModelInfo 里决定是否下发 function tools 的能力位（二进制可见 `tool_mode` 枚举：`code_mode_only` / `non_code_mode_only` / `code_mode_only_strict_3p_tools` / `js_repl_tools_only`，另有 `tool_mode": null`），需要在 ModelGate 生成的目录里给出该第三方模型**正确**的声明（当前实现未映射，A1/A3 待办）。

## 3. 状态更新（严格按证据）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| MG-R003 Go 真实授权 + 推理 + 模型 ID | **PASS_REAL** | §2.1（两条 200 回执，绑定本轮被测树）|
| MG-R006 native-compaction（Codex 自己压缩） | **observed（partial）** | §2.2（不写满子用例 PASS_REAL）|
| MG-R005 / MG-R006 其余（工具、追派、中断、恢复、压缩后上下文） | **FAIL** | §2.4 工具未执行 |
| MG-R012 真实 GPT 仅 Luna | 未在本轮复测（保持旧树 PASS_REAL，门禁仍按 stale 阻断）| 本轮零 GPT 调用 |
| MG-R001/R004/R007 真实 Desktop GUI | **BLOCKED** | 需 GUI 会话与用户本机交互 |

## 4. 下一步（按优先级）

1. **修复 DSML→Responses `function_call` 桥接**（否则 Go 子代理无法执行任何工具，MG-R005/R006 不可能通过）：解析 `<|DSML| invoke name=...>` 文本为 `function_call` 输出项，并把工具结果回填；需离线 fixture + 真机复测。
2. 修完后复测真实两轮：工具执行 → 压缩 → 压缩后追派并复述压缩前标记（`context-proof`）。
3. 原生父子（GPT 父 + Go 子）与中断/恢复真机验收（GPT 仅 `gpt-6-luna`）。
4. 原版 Desktop GUI 选模与退出恢复的真实演练（需 GUI 会话）。

## 5. 费用与边界

- 本轮真实调用：Go 推理 4 次（含 1 次截断探针与 1 次工具探针）+ Codex 四轮会话（1 轮工具形状排查）；GPT 调用 0 次。
- 未下载/安装任何资源；未改 `~/.codex` 与生产服务；凭据未打印、未入库；`/tmp/mg-real-accept` 为一次性隔离目录。


## 6. 追加实测：用 ModelGate **生成目录**修复工具下发（2026-11-15 12:35–12:45）

### 6.1 根因（A1 用真实 Codex 二进制 + 本地 mock 定位，零付费）

| ModelInfo 声明 | Codex 请求里的 tools |
| --- | --- |
| `use_responses_lite: true` | **完全没有 tools**（真机 `tools: None` 的根因）|
| `shell_type: "disabled"` | 有 tools，但无 `exec_command` |
| `tool_mode: "code_mode_only"` | 只有 code-cell `exec/wait`，无 `exec_command` |
| `shell_type: "unified_exec"`（不写 tool_mode） | 9 个 tools，含 `exec_command` + `write_stdin` |

这三个字段都是从**官方 GPT 目录抄 ModelInfo** 带进来的；本节起改用 `buildCatalog()` 生成目录。

### 6.2 实测结果（真实 Go 上游 + 真实 Codex + 生成目录）

| 步骤 | 结果 |
| --- | --- |
| `buildCatalog()` 生成的 Go 条目 | `slug=mg-opencodego-deepseek-v4-1-flash`、`shell_type=unified_exec`、`apply_patch_tool_type=freeform`、`auto_compact_token_limit=4000`（夹具）、无 `use_responses_lite`/`tool_mode` |
| Codex 工具调用 | **成功**：`exec_command` 真实执行，`/tmp/mg-real-accept/marker-real.txt` 内容 `TOOL_REAL_OK`，输出 **0 行 DSML** |
| 沙箱前提 | `codex exec --sandbox workspace-write`（默认 read-only 会拒绝写文件；这是客户端沙箱语义，不是网关缺陷）|
| 压缩 | 第 2 轮出现 `context compacted`（Codex 自己压缩）；但夹具阈值 4000 过低时该轮出现**重复压缩（20 次）**并超时 —— 说明阈值必须取真实模型能力值，不可用过小夹具 |
| 压缩后追派 / context-proof | **未成立**：该轮超时，未产出 `marker-after-compact.txt` |

### 6.3 结论边界

- `MG-R005 native-tools` / `MG-R006 native-tool`：真实目标上**工具执行成立**（有文件与命令回执）。
- `MG-R005 native-child-thread-not-mcp`：仍需真实父 GPT 子 Go 的 spawn 回执，未测。
- `MG-R006` 其余用例（`same-child-followup` / `interrupt` / `resume` / `post-compact-followup` / `context-proof` / `no-duplicates`）：未成立，整体仍 `FAIL`。
- 下一次真机复测必须：① 用生成目录；② `auto_compact_token_limit` 取真实能力值（不要 4000 这类夹具）；③ `--sandbox workspace-write`；④ 两轮带工具 + 压缩 + 复述标记。

### 6.4 本轮真机附加调用

Go 推理：生成目录工具测试 1 次 + shell 变体 1 次 + workspace-write 工具测试 1 次 + 压缩复测 1 轮（超时）；GPT：0 次。


## 7. 追加实测（2026-11-15 12:50–13:15）：真实压缩后工具与记忆、父 GPT 阻断

**绑定树**：`e8f02a0`（`buildCatalog` 工具声明修复）与 `4f5a35f`（状态/矩阵更新）。本节真机调用在 `e8f02a0` 的代码上完成，无未提交中间态；`4f5a35f` 仅改文档/测试。

### 7.1 用「真实能力值」生成目录（非夹具）

`buildCatalog()` 生成：`context_window=1048576`、`auto_compact_token_limit=943718`（A1 从本机 OpenCode 目录快照取证）、`shell_type=unified_exec`、`apply_patch_tool_type=freeform`、无 `use_responses_lite`/`tool_mode`。

### 7.2 真实 Go：工具 → 压缩 → 压缩后工具 → 压缩前记忆（全部成立）

基线单轮（工具）：`exec_command` 执行，`marker-a.txt=BASE_OK`，`tokens used 20,850`。

压缩轮（测试夹具阈值 32k，仅为在低成本下触发；**不是**产品默认值）：`compaction=2 次`，输出 `BASE_OK` —— 压缩后仍记得压缩前命令输出。

压缩后工具轮（`resume --last` + 显式 `-c sandbox_mode="workspace-write"`）：

| 观测 | 结果 |
| --- | --- |
| `context compacted` | 3 次（Codex 自己压缩）|
| 工具执行 | **成功**：`marker-b.txt=POST_COMPACT_MARKER` |
| 压缩前记忆 | **成立**：回答仍为 `BASE_OK` |
| 本轮用量 | 402,350 tokens（真实 Go 计费）|

即真实目标上的 `native-tool`、`native-compaction`（observed）、`post-compact-followup`、`context-proof`、`resume` **均有真实回执**；仍缺 `same-child-followup` / `interrupt` / `no-duplicates`（需要原生父 GPT spawn 子 Go）。

### 7.3 关键阻断：父 GPT 经 ModelGate 被 F01 拒绝

| 步骤 | 结果 |
| --- | --- |
| 应用侧目录 `/home/xiaomengxizi/.local/state/modelgate-desktop/codex/models.json` | 已含 `gpt-6-luna` 与 `mg-opencodego-deepseek-v4-1-flash`（正是 V2 目标形态）|
| 应用侧 Codex 配置 | `model_provider="modelgate"`、`base_url=http://127.0.0.1:18787/v1`、`model="gpt-6-luna"` |
| 按应用方式启动网关后请求 `gpt-6-luna` | **403** `official_no_gateway_key`：「F01 起不再透传客户端官方凭据，请配置 apiKeyEnv」 |

结论：**同一 Codex 会话里父用 ChatGPT 套餐、子用 Go 模型，在当前网关实现下不成立**——因为会话只有一个 `model_provider`，父请求也走网关，而网关对官方目标要求**网关自有 key**（F01 已退役客户端凭据透传）。这不是配置问题，是 F01 的产品决策与 V2「保留套餐 + 同会话父子」的冲突。

需要所有者决策的三种出路：
1. **网关自有 OpenAI key**（可用 API 计费模型；`gpt-6-luna` 是否可用取决于该 key 的模型权限）；
2. **恢复一条受限的订阅凭据路径**（仅 loopback + 仅官方目标 + 只读租约，带审计），即对 F01 做**范围受限**的回退；
3. **Codex 侧按角色分 provider**（父用内置 openai 订阅、子用 modelgate）——需要确认 0.167.0 是否支持子代理配置覆盖；若不支持，则产品形态必须改。

### 7.4 本轮真实调用与费用

- Go 推理：基线 1 轮 + 压缩轮 2 次 + 压缩后工具轮 3 次（含 compaction 调用）；tokens 合计约 65 万（含 22.4 万与 40.2 万两轮大头）。
- GPT：`gpt-6-luna` 1 次探针，被 F01 拒绝（**零上游请求、零费用**）。
- 无下载/安装；未改 `~/.codex` 与生产服务；应用侧网关仅临时启动后关闭。


## 8. 订阅承载打通（2026-11-15 13:20–13:35）：按 cc-switch / codex-responses-proxy 的既有做法

### 8.1 生态做法（已核实，非推测）

| 项目 | 做法 |
| --- | --- |
| [codex-responses-proxy](https://github.com/David-Factor/codex-responses-proxy) | 读 `~/.codex/auth.json` 的 ChatGPT OAuth token → 转发 `https://chatgpt.com/backend-api/codex/responses`；过期用 refresh token 走 `https://auth.openai.com/oauth/token` 刷新并回写 0600；带 `ChatGPT-Account-ID`；请求整形：强制 `stream:true`、`store:false`、字符串 input→消息数组、删 `max_output_tokens`、删重放 reasoning 项、工具名重映射 |
| [cc-switch](https://github.com/farion1231/cc-switch) | 不做代理：按端点协议生成 Codex 的 `auth.json`/`config.toml`（含 base_url/wire_api/模型）|
| [liteLLM](https://docs.litellm.ai/docs/tutorials/openai_codex_byok) | 内置 `chatgpt/*` provider，用订阅凭据暴露 Responses 端点 |

结论：**"同一会话套餐父 + 第三方子"不是不可行，而是必须让网关自己持有订阅凭据**（读本机登录态或应用授权），而不是接收客户端凭据。F01 退役的是后者，前者从未被真正禁止。

### 8.2 本轮实现（受限、显式开关）

- `src/codex/auth.js`：新增 `SUBSCRIPTION_PATH_PREFIXES = ['/backend-api/codex']`；**只有** `providers.<id>.gatewaySubscription.enabled === true` 时才允许该路径，且仍需官方 host + loopback；订阅入口不要求 provider key（凭据由网关只读本机登录态），`/v1` 直连仍保持 F01（必须网关自有 key）。未开该开关时，订阅路径一律 `official_path_not_allowlisted`。
- `src/index.js`：订阅入口请求整形 `patchSubscriptionRequestBody()`（input→list、`store:false`、`stream:true`、删 `max_output_tokens`/`max_completion_tokens`、删重放 reasoning、`web_search_preview`→`web_search`）。
- `bin/mg-desktop.mjs`：`configure()` 检测 `~/.codex/auth.json`（auth_mode=chatgpt 且有 access_token）→ 父 provider 写成 `https://chatgpt.com` + `/backend-api/codex/responses` + `gatewaySubscription:{enabled:true}`；没有本机登录时保留应用自有 OAuth（`grant.json` + api.openai.com）路径。

### 8.3 真机结果（真实上游、真实计费）

| 步骤 | 结果 |
| --- | --- |
| 网关直连 `gpt-6-luna`（订阅入口） | **HTTP 200 / 1.62s**，SSE `model:"gpt-6-luna"`，含 `LUNA_REAL_OK` |
| 产品生成器 | `MG_DESKTOP_STATE=/tmp/mg-app-state node bin/mg-desktop.mjs configure` → provider `https://chatgpt.com` + gatewaySubscription + responsesPath；codex 配置含 `[agents.go_deepseek]` |
| **产品路径父生子** | 真实 `gpt-6-luna` 父 + `go_deepseek` 子 → 子代理执行 `printf PRODUCT_CHILD_OK`，`product-child.txt=PRODUCT_CHILD_OK`，父代理回报该输出 |
| 原生父子会话 | 两个 rollout：父 `gpt-6-luna`、子 `mg-opencodego-deepseek-v4-1-flash` |
| 同子追派 | 同一子代理第二次任务成功（`child.txt` = `CHILD_REAL_OK` + `CHILD_SECOND_OK`），并复述第一次输出 |

### 8.4 边界

- 本机 `auth.json` 只读使用，未写入、未复制到仓库；`mtime` 保持 `2026-11-15 11:07` 之前，运行期间未变。
- 仍未做：`interrupt` / `no-duplicates` 真机用例；原版 Desktop **GUI 选模**（本轮是 CLI 驱动同一份产品配置）；真实 GUI 的启停/回滚演练。
- 应用自有 OAuth 路径（`grant.json`）本机不存在（未做过 `mg-desktop sign-in`），因此走的是"复用本机 Codex 登录"路径；两条路径都由开关/存在性决定，不静默互换。


## 9. 门禁回执（脱敏）

- `docs/evidence/aggregation-v2-receipts-2026-11-15.json`：R002 / R003 / R005 / R012 的脱敏回执（commitSha + command + traceId + 逐用例 passed），不含 token、账号、路径。
- 门禁结果：`ready:false`；已承认 **4/12** 为 `proven_on_real_target`（R002、R003、R005、R012），其余 8 项 `missing_evidence`。
- R006 仍 FAIL：`interrupt` / `no-duplicates` 未做真机用例；压缩、压缩后工具与记忆、同子追派已真实成立。
