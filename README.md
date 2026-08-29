# model-gateway

本地 **OpenAI 兼容** API 网关：为不稳定的模型服务端断连提供统一韧性层、做跨模型路由与治理，并让多个 Agent（zcode / trae / dsh / 任意 OpenAI 兼容客户端）与多套模型服务（官方 / 中转 / 本地 / Anthropic / Gemini）复用同一份管理。

零第三方依赖（仅 Node 内置 http/https），Node >= 18。纯面板化配置（控制台 `http://127.0.0.1:8787/`）。

## 解决什么（能力矩阵）

| 类别 | 能力 |
|---|---|
| 重试 | 指数退避自动重试（仅网络错与可重试状态码；业务 4xx 不重试） |
| 超时 | 分层：建连+首字节 firstByteMs（墙钟兜底，响应头到达后转 idleMs 空闲检测）· 流式空闲 idleMs · 整体预算 overallMs（0=不限）；connectMs 仅用于预热/探活 |
| 流式 | SSE 断流自动重连 + 内容去重；断流显式收尾；多协议重建为 OpenAI delta |
| 故障转移 | 模型内 `fallbacks` 备用上游链；`defaults.directory` 跨模型兜底；命中率/亲和择优（亲和带 `affinityTtlMs` 有效期）· **主上游回切探活 `failbackProbe`（降级中主动探活，主上游恢复即自动切回）** |
| 熔断 | `provider.circuit{maxFailures, openDurationMs}`；open→half→ok（冷却结束自动半开、放行一次探测，成功即恢复） |
| 并发/限流 | 每 provider 并发 · 每 model 并发 `maxConcurrent` · 每 model QPS `qps` |
| 限速 | 429 尊重 `Retry-After` 排队 · 请求体超限 413 |
| 额度/上下文 | 每模型日额度 `dailyQuota` · 总额度 `quota`（已持久化，重启不失效）· 最大上下文 `maxContext`（中文按 1 字≈1 token 估算）· 超限自动切下一模型 |
| 思考强度 | 每模型可配允许档位 `effortOptions`（本地校验，非法 400）与默认档位 `reasoning` |
| 缓存 | keep-alive 连接复用 · **会话/上游亲和**（同前缀稳定同上游，降厂商缓存碎片化）· **主动预热 preheat** · **命中率路由 + 趋势骤降告警**；流式也解析 usage 计入命中；命中率按 hit/(hit+miss) 真实统计 |
| 安全 | 管理令牌 `MG_ADMIN_TOKEN` · 数据面客户端 Key `MG_CLIENT_KEY`（加密存储）· Key 加密落盘 · 转发剥离客户端授权头 · 虚拟模型名 |
| 可观测 | provider/model 维度统计 · 模型级平均延迟 · p50/p95 · 延迟趋势 · 每模型天级 token/缓存命中率 · **按对话统计**（会话 ID 或时间切分）· 日志文件 |
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

网关同时兼容 `/chat/completions` 与 `/v1/chat/completions`、`/models` 与 `/v1/models`——所以 Base URL 填 `http://127.0.0.1:8787`（不带 `/v1`）也能接入，代理自动拼的两种路径都能用。

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
    "preheat": [],                          // 主动缓存预热：[{ "model": "xx", "system": "<长 system 前缀>", "everyMs": 300000 }]
    "affinityTtlMs": 300000,                // 缓存亲和有效期：超时后主上游可被重新试用（0=不过期，亲和永不失效）
    "failbackProbe": { "enabled": true, "everyMs": 30000, "successStreak": 2, "system": "ping" }  // 主上游回切探活
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
- `defaults.model`：**虚拟共用模型名**。客户端统一请求这个名字时，网关把它当作「默认链」——沿 `defaults.directory` 首项把**真实模型名**发给上游，并把响应里的 `model` 回写为该虚拟名（虚拟名会出现在 `/v1/models`）。不会把虚拟名透传给上游（否则上游会报 `Model <虚拟名> is not supported`）。
- `defaults.clientKey`：数据面鉴权 Key。面板录入后改存**加密 keys 库**，`/api/status` 只回掩码 `********`，不会明文落盘。
- `defaults.directory`：跨模型兜底。`mode: afterAll` 表示按序全部尝试，`onFail` 表示仅当前模型失败时才启用后续。**整条链(a→b→c)一轮全败后网关会回到队首反复重试（循环兜底）**，直到成功 / 业务 4xx / 整体超时 / 全部熔断；单轮兜底时间上限由 `defaults.timeout.loopMs`（默认 120000ms）约束，最长一次请求的兜底重试时长不会超过它。请求日志会带 `chain=实际尝试过的模型链` 标记，可直接看到兜底是否触发。
- `models.<名>.effortOptions`：允许的思考强度档位（客户端传的档位不在列表 → 本地 400）。`reasoning`：客户端未指定时注入的默认档位。`effortFormat`（可选）：思考强度参数格式——`reasoning_effort`（默认，OpenAI 风格字符串，DeepSeek/OpenAI 系）；`thinking`（MiniMax 风格对象，如 `MiniMax-M3` 认 `thinking:{"type":"adaptive"}`）。客户端入口统一传 `reasoning_effort`，网关按 `effortFormat` 转换注入；虚拟共用名/虚拟模型入口透传链首真实模型的格式。
- `models.<名>.dailyQuota/quota/maxContext`：0=不限；超限的模型在路由中被自动跳过并切到目录中的下一模型。`quota` 已持久化到 `stats.json`，重启不失效。
- `defaults.preheat`：主动缓存预热，默认空（关闭）。配置后按 `everyMs` 周期性向该模型上游发 `max_tokens:1` 的带长 `system` 请求，保持厂商 prefix cache 存活。
- `defaults.affinityTtlMs`：**缓存亲和有效期**（默认 `300000` = 5 分钟，0 = 不过期）。请求成功后会记住「该模型最近一次成功用的上游」，后续请求优先复用它（保持厂商缓存亲和、降碎片化）。有效期过后亲和失效，请求回到配置里的**主上游**（`models.<名>.provider`）——避免「上游恢复后因亲和粘性永不回流」。TTL 内不会来回抖动。
- `defaults.failbackProbe`：**主上游回切探活**（默认开启，仅降级中工作）。当某模型当前由**备用上游**（`fallbacks`）服务时，按 `everyMs`（默认 30s）向主上游发最小探活请求（真实 chat、`max_tokens:1`、**不计额度**、超时取 `defaults.timeout.connectMs`），连续 `successStreak`（默认 2）次成功后清除亲和，下一个请求即回到主上游。这样**回切前已验证可用**，真实请求不会踩到"刚恢复又挂"的雷；正常态（用主上游时）**零开销、不发探活**。主上游处于熔断中时跳过探活（交给熔断的半开机制，避免打架）。`system` 为探活消息内容（默认 `ping`，省 token；以 **user 角色**发送——部分上游/聚合网关的 LiteLLM 层拒绝 system-only 请求并返回 400 `LITELLM_ERROR`，用 system 前缀探活会永远失败）。
  - 与 `affinityTtlMs` 的关系：探活是**主动**回切（30s 粒度、验证后切），TTL 是**被动**兜底（过期后下一个请求试水）；二者互补，探活为主。
  - 探活**刻意不用** `/v1/models`：聚合平台常见「models 通、chat 挂」（平台健康、推理层过载），用 models 探活会误判为已恢复，切过去反而卡住。
- `gateway.local.json`（已 gitignore）：真实 baseUrl / Key 名 / 私有覆盖放这里，浅合并覆盖 `gateway.json` 的 providers/models/defaults；`server` 段始终取自 `gateway.json`。`MG_CONFIG=/path/config.json` 可指定别处配置。
- **上游 HTTP 代理 `proxy`**：默认不配置＝直连。字段可放 `defaults.proxy`（全局）或 `providers.<名>.proxy`（单上游覆盖）；形如 `"http://user:pass@127.0.0.1:7890"`。也可不写配置、直接给网关进程设系统级 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量。**优先级**：`providers.<名>.proxy` > `defaults.proxy` > 环境变量。**按上游定名单**（auto 模式生效）：单上游 `proxy` 留空/缺省 = 继承全局；填 `http(s)://...` = 强制走该代理；填 `direct`（或 `false`）= 强制直连、无视全局。**全局 `defaults.proxy` 可在面板「默认上游」卡「网络代理」输入框配置，单上游名单在「上游服务」编辑弹窗「代理」字段配置（均持久化，不再丢）**。网关用 Node 内置 `https` 的 **CONNECT 隧道**实现，零依赖；`proxy.proxy` 指向 Clash/mihomo 等本地混合端口即可让上游请求走代理出口（**注意**：网关的转发、探活、模型测试、预热一律经代理；本机回环上游如 `127.0.0.1:3050` 自动跳过代理直连）。
- **代理模式 `proxyMode`**（`auto` 默认 / `direct` / `global`，面板「代理模式」下拉或配置 `defaults.proxyMode`）：
  - `auto`：按配置/名单——回环直连；非回环按 `providers.<名>.proxy` > `defaults.proxy` > 环境变量，名单里标 `direct`/`false` 的单上游强制直连；
  - `direct`：全部上游强制直连，无视任何代理配置（断代理排查/临时绕开 Clash）；
  - `global`：非回环上游**全部**强制走全局代理（`defaults.proxy` 或环境变量），忽略单上游名单（含 `direct`）；回环仍自动直连。
  - 三者切换只需保存配置即热生效（`reloadConfig`），不重启网关。

## 模型名回写

跨模型兜底时，网关把请求 `model` 改写为实际落地的模型发给上游，但**响应里的 `model` 会回写为客户端请求的名字**（流式与非流式均处理），避免客户端续写/统计因名字错位而出错。

## 安全

- **管理令牌**：设置后所有 `/api/*` 需 `Authorization: Bearer <token>`，未授权返回 401；未设置时控制台对回环可访问，但启动会打警告。三种设置方式（优先级从高到低）：① 环境变量 `MG_ADMIN_TOKEN`；② `gateway.json` 的 `server.adminToken`；③ 控制面板顶部「令牌」按钮——**面板录入即写服务端并热生效**（加密存于 keys 库，重启不失效），留空则关闭保护。若设了环境变量，以环境变量为准。
- **面板门禁**：启用管理令牌后，打开控制台先显示**登录卡片**，输入正确令牌才进入主界面（令牌错误红字提示）。浏览器记住当前网关实例（按启动时间戳 `startedAt` 判定），同一实例内刷新不再要求输入；**网关重启后需重新输入令牌**。
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

命中率口径：`hit / (hit + miss)`，按**提示词 token**（不含输出）加权累计。各协议按官方字段精确取数，不混用：

| 上游协议 | 命中（hit） | 未命中（miss） |
|---|---|---|
| DeepSeek | `prompt_cache_hit_tokens` | `prompt_cache_miss_tokens`（两者之和 = `prompt_tokens`） |
| OpenAI 兼容（含同类聚合服务） | `prompt_tokens_details.cached_tokens` | `prompt_tokens − cached_tokens`（`prompt_tokens` 含命中） |
| Anthropic | `cache_read_input_tokens` | `cache_creation_input_tokens + input_tokens`（`input_tokens` 为断点后未缓存部分） |
| Gemini | `usageMetadata.cachedContentTokenCount` | `promptTokenCount − cachedContentTokenCount` |

注意：命中率反映的是「本次请求提示词里有多少比例从厂商缓存读取」。在 agent 多轮循环、长 system 前缀高度复用的场景下，命中率接近 90%+ 是**正常且理想**的（重复前缀无需重算）；若希望降低，通常是前缀不稳定（如 system 里塞了时间戳/动态值）或请求分散到不同上游所致，与公式无关。

某模型缓存「继承」给另一模型：厂商侧缓存按模型名区分，无法跨模型复用；真正省 token 靠让相同前缀稳定走相同 模型+上游。

## 按对话统计

数据统计页「全局统计」卡片内置三种模式：**全局 / 按模型 / 按对话**。按对话模式以「会话」为单位聚合 token 与缓存命中：

- **会话 ID 优先**：请求头 `X-Conversation-Id` / `X-Session-Id`，或请求体 `session_id` / `conversation_id`。Agent 在自定义请求头里带固定会话 ID 即可精确统计（部分 Agent 支持配置自定义请求头）。
- **无 ID 兜底**：同来源请求间隔 ≤ 5 分钟视为同一对话，超过自动开新对话（面板以 `⌁` 标记区分兜底会话）。
- 保留最近 50 个对话，超量自动清理最旧的。

## 连通性测试

「模型配置」页的测试按钮（赛璐璐面板）：

- **单测**：每个上游/模型卡片上的「测」按钮，向上游发一次真实请求验证连通（上游 GET `/v1/models` 探可达；模型 POST 最小对话请求探可调用），结果以徽章显示 `通 xx ms` / `失败 xx ms`，可反复点击重新测试。
- **统测**：卡片区头部「测试」按钮一次测全部。上游走 `/api/probe`（无 id = 全部上游）；模型走 `/api/model-test`（无 id = 全部模型，服务端循环一次返回）。失败时面板明确提示原因，不误报「完成」。
- **模型级平均延迟**：模型卡片显示 `请求X · 错Y · 均 xx ms` 统计行，随真实请求流量累计（与上游卡片的 p50/p95 口径同级，重启清零）。

## 启动与日志

- **健壮启动**：`start.bat` 启动前会自动清理**占用 8787 的残留/孤儿 node 进程**，避免 `EADDRINUSE` 与「旧实例占着端口、agent 连不上」造成的空窗；前台运行，关闭窗口即停。
- **请求级日志**：每次数据面请求写一行 `data <METHOD> <path> -> <status> model=<请求模型> serving=<实际服务模型> provider=<上游>`。若返回 **2xx 却无正文内容**会额外告警 `data 2xx 无正文内容 ...`，便于定位空响应。日志只记元数据，**不含消息正文/密钥**。数据面鉴权失败会记 `数据面鉴权拒绝(401) ...`（含 ip/ua）。
- **数据持久化**：`config/stats.json` 每 30s 落盘并在重启后恢复：按天/按小时/按模型的 token 与命中率、按对话、全局计数（请求/错误/token/平均延迟/趋势）、各上游计数与探针。重置数据：停止网关后把该文件内容清为空结构即可。面板顶部「刷新」会立即重拉状态并重绘曲线。

## 协议互转（OpenAI ⇄ Anthropic ⇄ Gemini）

`provider.api = anthropic | gemini` 时，网关在 `/v1/chat/completions` 内自动互转；非 tools 流式重建为 OpenAI delta；**带 tools 的流式自动转非流式、以一次性 SSE 输出**，保证 tool_calls 完整。

## 项目结构

```text
model-gateway/
  config/gateway.json    # 配置模板
  src/index.js           # HTTP 入口 + 路由 + 治理状态 + 请求级日志（熔断/并发/QPS/额度/统计/缓存亲和与告警）
  src/router.js          # 配置加载 + key 加密读写/解密 + 模型->provider 路由
  src/request.js         # 后端转发 + keep-alive + 分层/整体超时 + 退避重试 + 熔断计数 + 预热 warm
  src/sse.js             # SSE 断流续传 + 多协议流式重建 + 模型名回写 + usage/命中解析
  src/format.js          # 协议适配（含 per-api 缓存字段映射 cacheHitMiss）
  src/logger.js          # 控制台 + 文件日志（密钥脱敏）
  src/admin.html         # 赛璐璐风格控制面板
  start.bat              # 健壮启动脚本（自动清理占用 8787 的残留进程）
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
- **4xx 语义**：400/401/422 等请求/鉴权类错误视为确定性问题，直接返回不兜底（换模型无意义）；**403/404（模型/资源级拒绝，如上游对该模型无权限/不存在）会继续尝试目录中的下一模型**——换模型可能成功；整条链都被 403/404 拒绝时回最后一个上游的原始响应（保留真实错误，而非笼统 502），且不进入循环兜底空转。
- 流式"断点续传"是重连重放 + 内容去重；OpenAI 协议无二进制断点，重放偏移会降级为"少量可能重复"并记日志。
- 流式中断（未正常收到 `[DONE]` 即终止）会计入全局 `interrupts` 中断计数并打 `sse 流中断` 日志；断流前已产生的 token 仍按内容累计，但因拿不到上游 `usage`，无法补记 prompt token。
- 流式"续传仍失败"的中断会被当作该上游的一次**连续中断信号**（`streamDrops`，不受 `markOk` 重置）：计入该上游 `errors` 与模型错误；当**同一上游连续流中断 ≥ `STREAM_DROP_THRESHOLD`(默认3)** 时，后续请求的路由会**绕开该上游**，切换到其他上游/模型，避免反复硬撞。正常完成一次流会将连续计数清零，使上游有机会恢复。已在流中回传的内容无法切模型重发（会重复/冲突），因此该机制对"后续请求"生效而非原响应。
- 客户端大体积流式上传目前先整体缓冲再转发以支持重试；对常规对话已足够。
- **「上游没被使用」不等于「上游挂了」**：这是两套独立机制，排查时别混淆——
  - **熔断**（`providers.<名>.circuit`）：故障驱动。连续失败达 `maxFailures` 后拉闸 `openDurationMs`，期间**跳过该上游不发请求**，冷却结束自动半开放行一次探测，成功即恢复。
  - **亲和粘性**（`affinityTtlMs` / `failbackProbe`）：缓存驱动。上游**健康也可能被排在后面**——只要上次成功用的是备用上游，它就会被优先复用（为了复用厂商 prefix cache）。此时上游既没熔断也没故障，只是"被冷落"。
  - 判断依据：熔断看 `/api/status` 里 provider 的 `st.state`（`ok`/`half`/`open`）；被冷落则 `state` 仍为 `ok`，只是 `models[].affinity` 指向了别的上游。
- **熔断冷却应大于单次失败耗时**，否则体感接近无效：单次失败耗时 ≈ `retry.maxAttempts` × 单次超时（如 3 次重试 × 60s 上游 504 ≈ 180s）。若冷却仅 120s，冷却一过第一个请求又卡满 3 分钟。对**持续性 5xx（过载型）**，降低重试次数的收益通常大于调熔断阈值。
- **间歇性成功会重置熔断计数**：上游只要偶尔成功一次，连续失败计数即清零，阈值可能长期达不到——此时熔断形同虚设，要靠回切探活与重试策略治理，而非一味调低阈值。