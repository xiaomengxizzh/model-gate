# 三问题分析（2026-11-16）

## 问题 1：首轮"重连 5 次"
- **根因确证**：真机输出反复出现 `responses_websocket: failed to connect to Responses WebSocket`，
  随后 `collab`/正常推理继续。Codex 0.167 在真实会话首选 Responses WebSocket，连接失败后
  回退 HTTPS；历史证据 `aggregation-native-real-2026-11-14.md` L81 记录"每次运行 5 次重试"。
  这是**传输协商**，非模型故障，不影响最终输出（EXIT 0、正常回报）。
- **干净 A/B**：隔离 `codex exec`（无官方登录）WS=0、POST=1，不复现——说明 WS 试探与
  内置 openai provider 的官方身份/WS endpoint 相关。
- **根治手段（需所有者决定）**：把日常 config 从内置 `openai` provider 切到产品自有的
  `modelgate` provider（`mg-desktop.mjs configure` 已生成 `supports_websockets=false`），
  让 Codex 跳过 WS 试探。但切 provider 身份涉及 ChatGPT 登录复用语义（MG-R002），
  **不在本轮擅自改真实 config.toml**（sha `8f3d6cc6…` 保持不变）。当前 5 次重连无害。

## 问题 2：子→父信息传输
- **结论：正常，PASS_REAL**。干净隔离环境真机（生产 8787，gpt-6-luna 父→go_deepseek 子）：
  `EXIT=0`，`collab: SpawnAgent`→`collab: Wait`，父代理**如实回报子代理原话**
  （"The child reported: 'I can't run shell commands...'"）——通道通、未篡改、未编造。
  子模型 `shell_type:"disabled"` 故无 exec_command（产品目标允许，子只做推理）；
  有工具的历史证据 `A5_CHILD_TOOL_OK` 证明子能执行工具并回报。传输无需修复。

## 问题 3：子代理压缩阈值
- **发现真实缺陷**：聚合目录 deepseek 条目漏 `auto_compact_token_limit`，Codex 用默认阈值。
  官方 OpenCode 目录真值 `943718`（1M×90%，cc-switch-model-catalog.json 取证）。
- **修复**（`0e7d490`）：projectionEntry 写入该字段，默认官方签名值，可由
  gateway 配置 `models.<id>.codex.capabilities.autoCompactTokenLimit` 覆盖，夹到 contextWindow。
  生产目录重发（世代 5→6），已持久化 `auto_compact_token_limit=943718`。不自建压缩。
- **Codex 上限澄清**：并非固定 256k/512k。官方目录 `max_context_window` 最高 872000、
  `context_window` 最高 500000；deepseek 声明 1M。真实 ModelInfo 字段是 `auto_compact_token_limit`
  （本例 943718）+ `model_auto_compact_token_limit`（config.toml 全局覆盖，二进制 schema 确认）。
  当前已设为官方 1M 的 90%（≈922K tokens），高于 256k/512k。要更高需同步提高 context_window，
  但那会改变模型可见历史长度，属产品决策，不擅自上调。

## 问题 1 追加：切 provider 消除首轮 WS 重连（2026-11-16，已完成）

### A/B 真机取证（隔离 HOME + 真 auth + 生产 8787，最小 luna 请求）
| 配置 | wsErrors | exit | 推理 |
| --- | --- | --- | --- |
| A：内置 `openai` provider + `openai_base_url`（原形态） | **7** | 0 | AB_OK |
| B：`modelgate` provider + `supports_websockets=false` | **0** | 0 | AB_OK |

B 形态下日志仍为 `gateway_subscription ... chatgptplan ... local_codex_auth`、`domain=official`，
即 **ChatGPT 本机登录/套餐能力完整保留**；父子派单 `collab: SpawnAgent`+`collab: Wait` 正常。

### 已应用到真实 ~/.codex/config.toml（原子写，完整回滚）
最小改动（其它字段逐字节不变）：
- `model_provider = "openai"` → `"modelgate"`
- 移除顶层 `openai_base_url`，新增 `[model_providers.modelgate]`：
  `base_url="http://127.0.0.1:8787/v1"`、`wire_api="responses"`、
  `requires_openai_auth=false`、**`supports_websockets=false`**
- `model_catalog_json` 保持顶层；`features.multi_agent`、`agents.go_deepseek` 不变。
- auth.json 未变（sha `de7cc6e9…`）。
- 回滚：`cp ~/.codex/config.toml.bak-before-websocket-fix-20261116T172052 ~/.codex/config.toml`

### 最终真机验收（用改动后的真实 config，非隔离副本）
`codex exec "Reply with exactly FINAL_OK"`：**exit=0、wsErrors=0、FINAL_OK** ——
首轮重连彻底消除、真实 luna 推理正常。生产 8787 healthz ok。

### 用户操作提示
Codex Desktop 需**新开对话**才会读取新 config（旧会话不会重载）；请在 GUI 新会话确认首轮无重连。

## 问题 1 最终取舍：保留通用 codex，WS 重连为官方身份固有行为（2026-11-16）

所有者明确：要用**原版通用 codex（内置 openai provider，功能更全）**，不用 modelgate 专用。
因此已回滚 config 到 `model_provider="openai"` + `openai_base_url`（sha `8f3d6cc6…`），
回退备份 `config.toml.bak-before-websocket-fix-20261116T172052` 保留。

### 为什么通用 codex 下无法消除 WS 重连（三条独立取证）
1. 给内置 `openai` provider 加 `[model_providers.openai] supports_websockets=false`：
   Codex **不启动失败**，但 WS 错误仍出现（10 次）→ 内置 provider 的该标志被忽略。
2. WS 探针（本地网关监听 upgrade）：`UPGRADE HITS: []` → Codex 的 WS 试探**不连本地网关**，
   连的是内置 provider 硬编码的官方 endpoint；因此网关无法用"实现 WS"来消除。
3. 只有切到非内置 `modelgate` provider + `supports_websockets=false` 时 WS=0（A/B 已证），
   但那正是所有者不要的"专用 codex"形态。

### 结论与取舍
- 通用 codex 下"首轮 N 次重连"是**官方身份 Responses-WebSocket→HTTPS 回退协商**，
  属 Codex 客户端固有行为，**不影响结果**（推理 EXIT=0、回答正常）。
- 在不牺牲通用 codex 功能/身份的前提下，本仓库范围**无法**消除它（证据如上）。
- 若要强行消除，唯一途径是放弃通用身份切 modelgate provider——所有者已否决。
- 因此：保留通用 codex + 保留全部已修复功能 + 接受无害的 WS 回退日志；不擅自再改 provider。
