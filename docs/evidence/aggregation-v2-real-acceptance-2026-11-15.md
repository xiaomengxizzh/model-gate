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
