# P0-01 无损修复：真实会话验证（2026-11-16，所有者授权真实调用）

> 文档类型：**真实运行取证**。所有者在本轮明确授权：① 真实 `gpt-6-luna` 父→Go 长会话；
> ② 真实付费调用。本文记录在本机用**隔离网关 + 隔离 CODEX_HOME**（OME 配置）驱动的
> 真实调用，**未触碰生产服务 PID 323092 / 8787，未改真实 `~/.codex`**（前后 sha256 一致：
> config.toml `867d53d5…`、go-deepseek.toml `da9d53e4…`）。凭据只从环境注入，未落盘/未打印。
> 真实调用**有费用**；费用仅为下列少量有界请求。

## 1. 现象与根因（用户报告确证）

用户报告：“请求 deepseek 能正常输出，但错误地显示重连五次”。生产日志
`logs/gateway-2026-11-16.log` 的 `05:27:15` 形状：
`message×4|function_call_output|message×2|function_call_output|message`（第 5 项孤儿 output）。
网关对无法配对的孤儿 output 返回 `400 third_party_tool_call_id_missing`（零计费），
Codex 反复重连五次。**这就是用户所见现象，根因确证为 P0-01。**

## 2. 修复（无损，已提交）

`repairThirdPartyToolCallIds` 对真孤儿 output 补**稳定合成关联键** `call_mg_orphan_<hash>`：
- 不伪造 `function_call`（不新增 call item）；
- 不删历史、不改 `content`/`output`/`name`（仅补缺失的 `call_id`）；
- id 由输出内容确定性派生 → 重连拿到同一 id（不漂移）；
- 记 `orphan-adopt` 透明诊断；其它非法输入仍 fail-closed。

提交：P0-01 修复 `5f765f7`；原生子代理 effort `1010a63`。

## 3. 真实验证结果（隔离环境，真付费，有界）

| 验证 | 命令/方式 | 结果 |
| --- | --- | --- |
| 修复前复现 | 隔离网关（固定代码前状态）+ 生产孤儿形状 | **HTTP 400** `third_party_tool_call_id_missing`，零计费 |
| 孤儿形状修复后 | 隔离网关（修复代码）+ 同一 payload | **HTTP 200 / status=completed**，模型正确看到工具结果内容；耗时 ~9.5s（真实 DeepSeek 计费） |
| 重连稳定性 | 同一形状连发两次（模拟 Codex 重连） | 两次均 **200/completed**，合成 id 相同 → 不再形状漂移 |
| 官方父模型 | 隔离网关 `model=gpt-6-luna` 最小请求 | **HTTP 200**，所有 SSE 事件 `model=gpt-6-luna`，无其他 GPT 型号（MG-R012） |
| 原生父子派单 | 真实 `codex exec` + 隔离配置（`mg-desktop.mjs configure` 生成） | **exit 0**；父 rollout `gpt-6-luna`（含 `spawn_agent`/`wait_agent`），子 rollout `mg-opencodego-deepseek-v4-1-flash`；父回报 `NATIVE_OK`；网关日志 3×chatgpt-plan + 2×opencodego 子请求；**无 400、无重连** |

### 真机发现并修复的第二个缺陷
首次真实父子会话报 `Reasoning effort 'medium' is not supported for model
mg-opencodego-deepseek-v4-1-flash. Supported: low, high`。根因：`mg-desktop.mjs configure()`
未传 `reasoningEffort`，落全局默认 `medium`，而 Go DeepSeek 目录只声明 `low/high`。
修复 `1010a63`：configure 显式传 `high`（不动全局默认，保字节兼容）。修复后重跑：
错误消失，日志出现 `collab: SpawnAgent` + `collab: Wait`，父回报 `NATIVE_OK`，
子 rollout 使用 `mg-opencodego-deepseek-v4-1-flash`。

## 4. 状态分层（严格区分）

- **PASS_REAL（本树）**：P0-01 孤儿形状→200（消除重连）；MG-R012 仅 `gpt-6-luna`；MG-R005 原生父→子派单（父 gpt-6-luna / 子 Go，无 MCP）。
- **PASS_MOCK/离线**：全部离线套件 + 新增 `agg-v2-orphan-adopt` 5/5、`agg-desktop-child-effort` 3/3。
- **仍 BLOCKED（需授权）**：MG-R006 原生压缩与压缩后同子 resume（四项 partial；需长会话+付费额度专门验收，本轮有界会话未覆盖压缩触发）；MG-R009 形态批准；完整原版 Desktop GUI 模型选择器多视口（本轮以 CLI 原生 harness 验证，非 GUI 截图）。
- 不宣称 MG-R006 已通过；不把本轮 PASS_REAL 外推到未测用例。

## 5. 复现命令（离线零额度部分）

```bash
node --test scripts/test/offline/agg-v2-orphan-adopt.test.mjs
node --test scripts/test/offline/agg-desktop-child-effort.test.mjs
node --test scripts/test/offline/agg-v2-tool-id-collision.test.mjs
```

真实调用部分因需付费凭据与隔离环境，不在 CI 重放；证据为本文件记录的网关日志/rollout 结构。
