# model-gateway

本地 **OpenAI 兼容** API 网关，为不稳定的模型服务端断连提供统一韧性层，并让多个 Agent（zcode / trae / dsh / 任意 OpenAI 兼容客户端）与多套模型服务（官方 / 中转 / 本地 / Anthropic / Gemini）复用同一份治理。

零第三方依赖（仅 Node 内置 http/https），Node >= 18。支持纯面板化配置管理（控制台 `http://127.0.0.1:8787/`）。

## 解决什么（能力矩阵）

| 类别 | 能力 |
|---|---|
| 重试 | 指数退避自动重试（仅网络错与可重试状态码；业务 4xx 不重试） |
| 超时 | 分层：连接 connectMs · 首字节 firstByteMs · 流式空闲 idleMs · **整体整体预算 overallMs**（单位 ms，0=不限） |
| 流式 | SSE 断流自动重连 + 内容去重（对重放输出跳过已发出的重复段）；断流显式收尾 |
| 故障转移 | 模型可配 `fallbacks` 备用上游链；连续失败自动切换 |
| 熔断 | `provider.circuit{maxFailures, openDurationMs}` 可配；open→half→ok 生命周期 |
| 并发/限流 | 每 provider 并发上限 · 每 model 并发 `maxConcurrent` · 每 model **QPS 令牌桶 `qps`** |
| 限速 | 429 尊重上游 `Retry-After` 排队 · 请求体超限 413 |
| 安全 | 管理 API 令牌（`MG_ADMIN_TOKEN`）· 转发剥离客户端授权头 · key 落盘 ACL 收紧 · **key 加密 `MG_KEYS_MASTER`** |
| 可观测 | provider/model 维度统计 · p50/p95 · **延迟趋势 sparkline** · 在线检活 · 熔断态 · 日志文件 |
| 互转 | **OpenAI⇄Anthropic⇄Gemini**（含 function calling，文本对话） |
| 合规 | 空 model 无默认 → 显式 400（不再静默用第一个上游） |

## 快速开始

```bash
# 1) 配置 providers 与 models（见下）；API Key 一律用环境变量，凭据零入库
# 2) 设好对应环境变量，例如：
export DEEPSEEK_API_KEY=sk-xxxx
# 3) 启动
node src/index.js
# 4) 健康检查
curl http://127.0.0.1:8787/healthz   # -> ok
curl http://127.0.0.1:8787/v1/models  # -> 已配置模型清单
```

全部配置都可在控制面板 `http://127.0.0.1:8787/` 完成（增删改 provider/model、设 Key、调参、保存即热加载），无需手改配置文件。

## 接入 Agent（所有 agent 的 base_url 都指向网关）

把各 Agent 里"模型供应商 / 自定义 API"的 **Base URL 填到 `http://127.0.0.1:8787/v1`**，模型名填 `config/models` 中配置的名字（或别名）。

- zcode / trae：在模型供应商设置里新增一个 OpenAI 兼容供应商，Base URL 指向网关。
- dsh / 任意 SDK：同样把 baseUrl / openai_base 指到网关即可。

## 配置（`config/gateway.json`）

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8787, "logFile": "logs/gateway.log", "maxBodyBytes": 33554432 },
  "defaults": {
    "provider": "deepseek-official",            // 未匹配 model 时的兜底 provider
    "retry": { "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 8000, "jitter": 0.2 },
    "timeout": { "connectMs": 10000, "firstByteMs": 60000, "idleMs": 30000, "overallMs": 0 },
    "concurrency": { "maxPerProvider": 8 },     // 每上游并发上限
    "extraHeaders": {}
  },
  "providers": {
    "deepseek-official": { "baseUrl": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY", "api": "openai", "extraHeaders": {} },
    "claude":           { "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "ANTHROPIC_API_KEY", "api": "anthropic", "circuit": { "maxFailures": 3, "openDurationMs": 10000 } },
    "gemini":           { "baseUrl": "https://generativelanguage.googleapis.com", "apiKeyEnv": "GEMINI_API_KEY", "api": "gemini" },
    "local-ollama":     { "baseUrl": "http://127.0.0.1:11434", "apiKeyEnv": "" }
  },
  "models": {
    "deepseek-chat": { "provider": "deepseek-official", "alias": ["ds"], "maxConcurrent": 0, "qps": 0 },
    "claude-3-5":   { "provider": "claude" },
    "gemini-x":     { "provider": "gemini", "fallbacks": ["deepseek-official"] }
  }
}
```

- `providers.<id>.apiKeyEnv`：从该环境变量读 API Key；本地/无 Key 服务留空字符串。请求头 `Authorization: Bearer <key>` 由网关注入。
- `providers.<id>.api`：上游协议，`openai` | `anthropic` | `gemini`（默认 openai）。非 openai 时网关自动做请求/响应格式互转（含流式）。**注意**：带 tools/function calling 的流式请求会自动转非流式、以一次性 SSE 输出，保证 tool_calls 完整。
- `providers.<id>.circuit`：熔断参数（连续失败 `maxFailures` 次后进入 open，冷却 `openDurationMs` 毫秒）。缺省用内置默认 3 / 10000。
- `providers.<id>.pathPrefix`：个别服务路径前缀不同时可覆盖。
- `models.<名>.alias`：别名；agent 里填别名也能路由到同一 provider。
- `models.<名>.maxConcurrent`：该模型独立并发上限（0=不限）。
- `models.<名>.qps`：该模型 QPS 令牌桶限速（0=不限）。
- `models.<名>.fallbacks`：备用上游链，主上游失败/熔断时依次降级。
- `server.maxBodyBytes`：请求体大小上限（字节），超限返回 413。

### 本机私有覆盖 `config/gateway.local.json`

真实 baseUrl / key 名差异不要提交 git，放 `gateway.local.json`（已 gitignore），其 `providers/models/defaults` 会浅合并覆盖 `gateway.json`；`server` 段始终取自 `gateway.json`。也支持 `MG_CONFIG=/path/to/config.json` 指定别处配置。

`loadConfig` 始终以 `gateway.json` 为基座、`gateway.local.json` 覆盖 providers/models/defaults（保证 `server` 段不被 local 覆盖丢失）。

## 扩展新模型

只需在 `models`（必要时加 `providers`）各加一条即可，无需改代码：

```jsonc
"models": { "deepseek-v3": { "provider": "deepseek-official" } }
```

## 安全

- **管理令牌**：设置 `MG_ADMIN_TOKEN` 后，所有 `/api/*`（配置/Key/检活/重载）需携带 `Authorization: Bearer <token>`；数据面 `/v1/*` 不受影响。面板顶部"令牌"按钮录入并记住。
- **转发鉴权**：网关向各上游转发时**剥离客户端自带的 `Authorization / Cookie / x-api-key / proxy-*`**，统一由网关注入，杜绝客户端绕过；面板按 provider 填写 Key 即可。
- **key 落盘**：`config/keys.local.json` 启动时收紧为本机当前用户（Windows `icacls /inheritance:r /grant:r`, 其它 `chmod 0600`）。
- **key 加密**：设置 `MG_KEYS_MASTER` 后 key 以 AES-256-GCM 加密落盘（文件以 `MG1:` 开头）；未设置则明文兼容。启用了加密的网关重启时**必须**再次提供同一 `MG_KEYS_MASTER` 才能解密读取。

## 协议互转（OpenAI ⇄ Anthropic ⇄ Gemini）

`provider.api = anthropic | gemini` 时，网关在 `/v1/chat/completions` 统一 OpenAI 出入口内部自动互转：

| 方向 | 转换 |
|---|---|
| 请求 | OpenAI messages/system/temperature/max_tokens/tools/tool_choice → Anthropic `system/messages/tools(input_schema)/tool_use/tool_result` → Gemini `contents/systemInstruction/tools(functionDeclarations)/functionCall/functionResponse` |
| 响应 | Anthropic `content[]`、Gemini `candidates[].parts[]` → OpenAI `choices[0].message`（含 `tool_calls`/`finish_reason: tool_calls`） |
| 流式 | 非 tools 流式重建为 OpenAI delta；**带 tools 的流式 → 自动转非流式、以一次性 SSE 输出**（保证 tool_calls 完整） |

## 项目结构

```text
model-gateway/
  config/gateway.json      # 配置模板（server/provider/model/defaults）
  src/index.js             # HTTP 入口 + 路由 + 治理状态（熔断/并发/QPS/趋势/统计）
  src/router.js            # 配置加载（含 key 加密读写/解密） + 模型->provider 路由
  src/request.js           # 后端转发 + 分层/整体超时 + 指数退避重试 + 熔断计数
  src/sse.js               # SSE 断流续传 + 多协议流式重建（OpenAI/Anthropic/Gemini）
  src/format.js            # 协议适配：OpenAI ⇄ Anthropic/Gemini（含 tools）
  src/logger.js            # 控制台 + 文件日志
  scripts/test/            # 按主题拆分的测试 + 索引运行器 run.mjs
  logs/                    # 运行时日志（gitignore）
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `<各 provider 的 apiKeyEnv>` | provider 鉴权，留空则不带 Authorization |
| `MG_KEYS_MASTER` | 设置后 key 以 AES-256-GCM 加密落盘（启动/读写需保持一致） |
| `MG_ADMIN_TOKEN` | 管理 API 令牌（设置后需面板录入或请求带 Bearer） |
| `MG_MAX_BODY` | 覆盖 `server.maxBodyBytes` 的请求体上限（测试/临时调参用） |
| `MG_CONFIG` | 指定非默认路径的配置文件 |
| `MG_SILENT` | 置 1 关闭控制台日志（仍写文件） |
| `MG_GW` | 仅测试用：指定网关地址（默认 `http://127.0.0.1:8787`） |

## 边界说明

- 重试仅发生在**尚未开始向客户端回 2xx 响应头**之前的失败；一旦 2xx/流式开始回传，不再整请求自动重试（避免重复内容），改为断流显式收尾。
- 流式"断点续传"是**重连重放 + 内容去重**（OpenAI 协议无二进制断点语义）；若上游重放内容偏移，会降级为"少量可能重复"并记日志。
- tools 互转当前覆盖**文本对话 + function calling**（非流式完整；带 tools 的流式降级为一次性 SSE）。
- 客户端流式上传（请求体很大）目前先整体缓冲再转发，以支持重试；对常规对话已足够。

## 测试（按主题拆分 + 索引运行器）

先启动网关（`node src/index.js`），再运行：
- `npm test` / `node scripts/test/run.mjs` —— 全部
- `node scripts/test/run.mjs sse` / `... format` / `... qps`—— 按关键词筛选单个/某类

测试位于 `scripts/test/`（每个自带合成上游、结束自动恢复配置基线、可反复执行）：

- `sse-resume` 断流续传 · `concurrency` provider/model 并发 · `rate429` 429 排队
- `format-conversion` OpenAI⇄Anthropic/Gemini · `tools` functions 互转（含流式降级）
- `circuit` 熔断参数可配 · `qps` model 限速 · `empty-model` 空 model 400 · `acl` key 加固
- `trend` 延迟趋势 · `modelstats` 每模型天级 token/缓存命中率 · `body-limit` 请求体 413 · `key-encrypt` key 加密读写

其中两项在**普通环境下会 SKIP**，需对应受限启动才有意义：
- `body-limit`：`MG_MAX_BODY=1200 node src/index.js` 启动
- `key-encrypt`：`MG_KEYS_MASTER=<密钥> node src/index.js` 启动

`MG_GW` 指定网关地址。