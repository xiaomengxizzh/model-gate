# ModelGate V2｜真实 Codex 客户端原生压缩实测（回环上游，零额度）

> **状态：`PASS_MOCK`（真实 Codex 客户端 + 回环 mock 上游）**。这证明「压缩由 Codex 自己执行、网关只透传」这条产品路径在**真实客户端二进制**上成立；
> **不等于** `PASS_REAL`：上游不是真实 OpenCode Go / ChatGPT，模型没有真实推理，真实额度与原生父子/追派仍未验收。
> 本轮零付费调用、零下载、零对真实 `~/.codex` 的写入。

## 1. 环境（本机只读事实）

| 项目 | 值 |
| --- | --- |
| 客户端 | `/usr/lib/chatgpt/resources/codex --version` → `codex-cli 0.167.0-alpha.3.2`（原版 Desktop 捆绑）|
| Desktop 产物版本 | `26.1103.32239`（`resources/linux-package-metadata.json`）|
| 隔离 | `CODEX_HOME=/tmp/mg-compact-exp/codexhome`（全新目录，未触碰 `~/.codex`）|
| 上游 | 回环 mock `http://127.0.0.1:8799/v1`（Node 内置 `http`，零依赖，仅回 `response.*` SSE）|
| 网关 | 本仓库 `node src/index.js`，`MG_CONFIG_DIR=/tmp/mg-compact-exp/gw`，监听 `127.0.0.1:8788` |
| 模型目录注入 | `model_catalog_json` 指向一条 ModelInfo：`context_window=2000`、`auto_compact_token_limit=400`（用于在毫秒级触发自动压缩；**这是测试夹具**，不是对 Go 模型真实能力的声明）|

## 2. 关键实验与结果

### 2.1 声明 `remote_compaction = "unsupported"`：Codex 走自己的本地压缩

配置（隔离 CODEX_HOME）：

```toml
[model_providers.mgmock.capabilities]
remote_compaction = "unsupported"
```

两轮会话（`codex exec` + `codex exec resume --last`，总用量 < 200 tokens 的 mock 回执）后，客户端输出：

```text
context compacted
```

上游收到 3 个请求，形状如下（mock 侧记录）：

| # | input 项 | 说明 |
| --- | --- | --- |
| 0 | 4 × `message` | 首轮任务 |
| 1 | 6 × `message` | 第 2 项正文以 `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.` 开头 —— **Codex 自己发起的本地压缩**，网关只是转发 |
| 2 | 6 × `message` | 压缩后追派同一会话的新一轮任务，正常完成 |

**没有**出现 input item `type:"compaction"`，**没有** `unsupported_input_item`，**没有**网关生成任何摘要文本。

### 2.2 对照：声明 `remote_compaction = "v2"`：走远程压缩 v2，客户端要求 `compaction` 输出项

同一会话形状下，上游收到：

```json
{ "type": "compaction_trigger" }
```

客户端报错（证明这条路径依赖上游返回密文）：

```text
ERROR: Error running remote compact task: Fatal error: remote compaction v2 expected exactly one compaction output item, got 0 from 1 output items
```

结论：`compaction_trigger` 是**请求侧**标记，`compaction`（带 `encrypted_content`）是**响应侧**产物，只在真正支持远程压缩的上游（官方 Responses）存在。Go/DeepSeek 无法承接，因此产品路径必须是「provider 声明不支持远程压缩 → Codex 本地压缩」。

### 2.3 经 ModelGate 的完整链路（真实客户端 → 网关 → 上游）

把 Codex 的 `base_url` 指向网关 `http://127.0.0.1:8788/v1`，模型配置 `api:"responses"` + `codex.history.compaction:"preserve"` + `codex.nativeCompaction:"codex-owned-local"`，重复 2.1：

- 客户端输出 `context compacted`；
- 网关把 `CONTEXT CHECKPOINT COMPACTION` 提示**逐字**送达上游（证明压缩文本由 Codex 生成）；
- 压缩后的 `second turn` 正常完成，无 `unsupported_input_item`、无重复终态。

## 3. 由此得到的代码修复（已提交）

1. `src/codex/interop.js`：显式识别 input item `compaction_trigger`；只有 `codex.nativeCompaction = codex-owned-remote` 的路由原样透传，其余返回 `native_compaction_route_not_ready`（此前它落入 `unknown` → `unsupported_input_item`，会在支持远程压缩的上游上误伤）。
2. `scripts/test/offline/agg-v2-real-client-compaction.test.mjs`：把上述三种真实请求形状编码为回放回归（压缩提示逐字透传、压缩后追派不被拒、触发标记路由闸门、网关不伪造密文）。
3. Desktop 侧 provider 能力声明（A3）：`[model_providers.modelgate.capabilities] remote_compaction = "unsupported"`（枚举由该二进制 serde 解析器实测）。

## 4. 仍未满足（不得因此签收 MG-R006）

- 真实 OpenCode Go `deepseek-v4.1-flash` 推理（需要 Go 凭据/额度授权）；
- 真实 ChatGPT 套餐调用（只允许 `gpt-6-luna`）；
- 原生父子 Agent Team + 压缩后同子追派/中断/恢复（本实验是单会话压缩，不是子代理）；
- 原版 Desktop GUI 内的模型选择器与真实登录状态。

复现命令（摘录，完整过程见 `/tmp/mg-compact-exp/`，该目录不入库）：

```bash
CODEX_HOME=/tmp/mg-compact-exp/codexhome MG_MOCK_KEY=dummy codex exec --skip-git-repo-check "first turn"
CODEX_HOME=/tmp/mg-compact-exp/codexhome MG_MOCK_KEY=dummy codex exec resume --last --skip-git-repo-check "second turn"
```
