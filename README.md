# model-gateway

本地 **OpenAI 兼容** API 网关：为不稳定的模型服务端断连提供统一韧性层、做跨模型路由与治理，并让多个 Agent（zcode / trae / dsh / 任意 OpenAI 兼容客户端）与多套模型服务（官方 / 中转 / 本地 / Anthropic / Gemini）复用同一份管理。

零第三方依赖（仅 Node 内置 http/https），Node >= 18。纯面板化配置（控制台 `http://127.0.0.1:8787/`）。

## 解决什么（能力矩阵）

| 类别 | 能力 |
|---|---|
| 重试 | 指数退避自动重试（仅网络错与可重试状态码；业务 4xx 不重试） |
| 超时 | 分层：连接 connectMs · 首字节 firstByteMs · 流式空闲 idleMs · 整体预算 overallMs（0=不限） |
| 流式 | SSE 断流自动重连 + 内容去重；断流显式收尾；多协议重建为 OpenAI delta |
| 故障转移 | 模型内 `fallbacks` 备用上游链；`defaults.directory` 跨模型兜底；命中率/亲和择优 |
| 熔断 | `provider.circuit{maxFailures, openDurationMs}`；open→half→ok |
| 并发/限流 | 每 provider 并发 · 每 model 并发 `maxConcurrent` · 每 model QPS `qps` |
| 限速 | 429 尊重 `Retry-After` 排队 · 请求体超限 413 |
| 额度/上下文 | 每模型日额度 `dailyQuota` · 总额度 `quota`（已持久化，重启不失效）· 最大上下文 `maxContext`（中文按 1 字≈1 token 估算）· 超限自动切下一模型 |
| 思考强度 | 每模型可配允许档位 `effortOptions`（本地校验，非法 400）与默认档位 `reasoning` |
| 缓存 | keep-alive 连接复用 · **会话/上游亲和**（同前缀稳定同上游，降厂商缓存碎片化）· **主动预热 preheat** · **命中率路由 + 趋势骤降告警**；流式也解析 usage 计入命中 |
| 安全 | 管理令牌 `MG_ADMIN_TOKEN` · 数据面客户端 Key `MG_CLIENT_KEY`（加密存储）· Key 加密落盘 · 转发剥离客户端授权头 · 虚拟模型名 |
| 可观测 | provider/model 维度统计 · p50/p95 · 延迟趋势 · 每模型天级 token/缓存命中率 · 日志文件 |
| 互转 | OpenAI ⇄ Anthropic ⇄ Gemini（含 function calling） |
| 合规 | 空 model 且无默认 → 显式 400 |

## 快速开始

```bash
# 1) 配好 providers/models（面板或 config/gateway.local.json）；Key 用环境变量或面板录入
# 2) 设环境变量，例如：export DEEPSEEK_API_KEY=sk-xxxx
# 3) 启动：node src/index.js   （Windows 也可 ./start.bat）
# 4) curl http://127.0.0.1:8787/healthz  # -> ok
#    curl http://127.0.0.1:8787/v1/models # -> 已配置模型（含虚拟模型名）
```

## 接入 Agent

各 Agent 的 Base URL 填 `http://127.0.0.1:8787/v1`，模型名填 `config/models` 中配置的名字（或别名/虚拟名）。配了 `clientKey` 时需带 `Authorization: Bearer <clientKey>`。

## 配置（`config/gateway.json`，本地覆盖 `gateway.local.json`）

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8787, "logFile": "logs/gateway.log", "maxBodyBytes": 33554432 },
  "defaults": {
    "provider": "deepseek-official",      // 兜底上游（未匹配模型时）
    "model": "auto",                      // 虚拟共用模型名：客户端可统一用这个名字接入
    "clientKey": "",                      // 数据面客户端Key（存面板后写入加密 keys 库，此处保持空）
    "retry": { "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 8000, "jitter": 0.2 },
    "timeout": { "connectMs": 15000, "firstByteMs": 90000, "idleMs": 60000, "overallMs": 0 },
    "concurrency": { "maxPerProvider": 8 },
    "extraHeaders": {},
    "directory": [                          // 跨模型兜底路由：按序尝试，某模型不可用则切下一个
      { "model": "deepseek-chat", "providers": ["deepseek-official"], "mode": "afterAll" }
    ],
    "preheat": []                           // 主动缓存预热：[{ "model": "xx", "system": "<长 system 前缀>", "everyMs": 300000 }]
  },
  "providers": {
    "deepseek-official": { "baseUrl": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY", "api": "openai", "extraHeaders": {} },
    "claude":           { "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "ANTHROPIC_API_KEY", "api": "anthropic", "circuit": { "maxFailures": 3, "openDurationMs": 10000 } },
    "gemini":           { "baseUrl": "https://generativelanguage.googleapis.com", "apiKeyEnv": "GEMINI_API_KEY", "api": "gemini" },
    "local-ollama":     { "baseUrl": "http://127.0.0.1:11434", "apiKeyEnv": "" }
  },
  "models": {
    "deepseek-chat": { "provider": "deepseek-official", "alias": ["ds"], "maxConcurrent": 0, "qps": 0 },
    "deepseek-r1":  { "provider": "deepseek-official", "effortOptions": ["low","medium","high"], "reasoning": "medium", "dailyQuota": 0, "quota": 0, "maxContext": 0 },
    "claude-3-5":   { "provider": "claude", "fallbacks": ["deepseek-official"] },
    "gemini-x":     { "provider": "gemini" }
  }
}
```

要点：
- `defaults.model`：**虚拟共用模型名**。客户端统一请求这个名字，网关自动落到 `defaults.provider`（虚拟名会出现在 `/v1/models`）。
- `defaults.clientKey`：数据面鉴权 Key。面板录入后改存**加密 keys 库**，`/api/status` 只回掩码 `********`，不会明文落盘。
- `defaults.directory`：跨模型兜底。`mode: afterAll` 表示按序全部尝试，`onFail` 表示仅当前模型失败时才启用后续。
- `models.<名>.effortOptions`：允许的思考强度档位（客户端传的档位不在列表 → 本地 400）。`reasoning`：客户端未指定时注入的默认档位。
- `models.<名>.dailyQuota/quota/maxContext`：0=不限；超限的模型在路由中被自动跳过并切到目录中的下一模型。`quota` 已持久化到 `stats.json`，重启不失效。
- `defaults.preheat`：主动缓存预热，默认空（关闭）。配置后按 `everyMs` 周期性向该模型上游发 `max_tokens:1` 的带长 `system` 请求，保持厂商 prefix cache 存活。
- `gateway.local.json`（已 gitignore）：真实 baseUrl / Key 名 / 私有覆盖放这里，浅合并覆盖 `gateway.json` 的 providers/models/defaults；`server` 段始终取自 `gateway.json`。`MG_CONFIG=/path/config.json` 可指定别处配置。

## 模型名回写

跨模型兜底时，网关把请求 `model` 改写为实际落地的模型发给上游，但**响应里的 `model` 会回写为客户端请求的名字**（流式与非流式均处理），避免客户端续写/统计因名字错位而出错。

## 安全

- **管理令牌**：`MG_ADMIN_TOKEN` 设置后，所有 `/api/*` 需 `Authorization: Bearer <token>`；未设置时控制台对回环可访问，但启动会打警告。
- **数据面鉴权**：`MG_CLIENT_KEY` 或面板里的 `clientKey` 设置后，`/v1/*` 需携带同一 Key，否则 401；不配则不鉴权（向后兼容）。
- **转发鉴权**：向各上游转发时**剥离客户端自带** `Authorization/Cookie/x-api-key/proxy-*`，统一由网关注入，杜绝绕过。
- **Key 加密落盘**：`config/keys.local.json` **始终 AES-256-GCM 加密**（文件头 `MG1:`），主密钥优先取 `MG_KEYS_MASTER`，否则自动生成并持久化到用户目录的 `master.key`。`clientKey` 同样加密存于 keys 库，不写明文。文件启动时收紧权限（Windows `icacls` / 其它 `chmod 0600`）。
- **日志脱敏**：日志对已登记密钥/Token 值统一掩码，杜绝密钥落日志。

## 缓存与命中

网关不做响应/前缀缓存本身（prefix cache 在上游厂商侧，会按 `上游+模型+prompt 前缀` 命中和计数）。网关侧做的是让前缀缓存稳定命中的**零存储**手段：

- keep-alive：复用 TCP/TLS 连接，减少握手。
- 会话/上游亲和：模型记住最近成功的上游，同前缀默认走同一上游，避免因切上游导致厂商缓存碎片化。
- 命中率路由：同一模型多上游时，优先近期缓存命中率更高的上游。
- 主动预热 `preheat` + 命中率趋势告警（命中率骤降≥20 且仍≥30% 时告警，提示缓存碎片化）。

某模型缓存「继承」给另一模型：厂商侧缓存按模型名区分，无法跨模型复用；真正省 token 靠让相同前缀稳定走相同 模型+上游。

## 协议互转（OpenAI ⇄ Anthropic ⇄ Gemini）

`provider.api = anthropic | gemini` 时，网关在 `/v1/chat/completions` 内自动互转；非 tools 流式重建为 OpenAI delta；**带 tools 的流式自动转非流式、以一次性 SSE 输出**，保证 tool_calls 完整。

## 项目结构

```text
model-gateway/
  config/gateway.json    # 配置模板
  src/index.js           # HTTP 入口 + 路由 + 治理状态（熔断/并发/QPS/额度/统计/缓存亲和与告警）
  src/router.js          # 配置加载 + key 加密读写/解密 + 模型->provider 路由
  src/request.js         # 后端转发 + keep-alive + 分层/整体超时 + 退避重试 + 熔断计数 + 预热 warm
  src/sse.js             # SSE 断流续传 + 多协议流式重建 + 模型名回写 + usage/命中解析
  src/format.js          # 协议适配（含 per-api 缓存字段映射 cacheHitMiss）
  src/logger.js          # 控制台 + 文件日志（密钥脱敏）
  src/admin.html         # 赛璐璐风格控制面板
  scripts/test/          # 按主题拆分的集成测试 + 索引运行器
  logs/                  # 运行时日志（gitignore）
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `<各 provider 的 apiKeyEnv>` | provider 鉴权；留空则不带 Authorization |
| `MG_KEYS_MASTER` | 可选：keys 加密主密钥；默认自动生成并持久化，keys 始终加密存储 |
| `MG_CLIENT_KEY` | 数据面客户端接入 Key（配了则 /v1/* 需带 Bearer） |
| `MG_ADMIN_TOKEN` | 管理 API 令牌 |
| `MG_MAX_BODY` | 覆盖 `server.maxBodyBytes`（测试用） |
| `MG_CONFIG` | 指定非默认配置文件路径 |
| `MG_SILENT` | 置 1 关闭控制台日志（仍写文件） |
| `MG_GW` | 测试用：网关地址（默认 http://127.0.0.1:8787） |

## 测试（按主题拆分 + 索引运行器）

`npm test` / `node scripts/test/run.mjs [关键词]`。套件是**依赖真实运行网关 + 上游配置 + 管理鉴权**的集成测试；运行器会对每个文件做错误隔离并预检网关状态，缺环境时相应用例 SKIP/报错而不中途崩溃。

## 边界说明

- 重试仅发生在尚未向客户端回 2xx 响应头之前；一旦开始回传不再整请求自动重试（避免重复内容），改为断流显式收尾。
- 流式"断点续传"是重连重放 + 内容去重；OpenAI 协议无二进制断点，重放偏移会降级为"少量可能重复"并记日志。
- 客户端大体积流式上传目前先整体缓冲再转发以支持重试；对常规对话已足够。