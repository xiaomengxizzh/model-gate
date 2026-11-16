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
