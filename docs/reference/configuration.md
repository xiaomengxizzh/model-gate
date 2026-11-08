# 配置与现有行为参考

适用于仓库实现；具体账号、服务状态与价格不在本页维护。路径均相对仓库根目录。

## 配置

```jsonc
{
  "server": {
    "host": "127.0.0.1", "port": 8787, "logFile": "logs/gateway.log", "maxBodyBytes": 33554432,
    "allowedHosts": [],        // 额外放行的 Host 名字（反向代理/自定义域名）；IP 字面量与 localhost 默认放行
    "allowedOrigins": []       // 额外放行的浏览器 Origin（如 http://panel.lan）；同源面板默认放行
  },
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
- `models.<名>.effortOptions`：允许的思考强度档位（客户端传的档位不在列表 → 本地 400）。`reasoning`：客户端未指定时注入的默认档位。`effortFormat`（可选）：思考强度参数格式——`reasoning_effort`（默认，OpenAI 风格字符串，DeepSeek/OpenAI 系）；`thinking`（MiniMax 风格对象，如 `MiniMax-M3` 认 `thinking:{"type":"adaptive"}`）。客户端入口统一传 `reasoning_effort`，网关按 `effortFormat` 转换注入；虚拟共用名默认不注入，除非设置了 `defaults.reasoning`。
- `defaults.reasoning`：可选的虚拟共用名默认思考档位；客户端显式传入的 `reasoning_effort` 优先。档位形态仍按链中目标模型自己的 `effortFormat` 转换。
- `models.<名>.dailyQuota/quota/maxContext`：0=不限；超限的模型在路由中被自动跳过并切到目录中的下一模型。`quota` 已持久化到 `stats.json`，重启不失效。
- `defaults.preheat`：主动缓存预热，默认空（关闭）。配置后按 `everyMs` 周期性向该模型上游发 `max_tokens:1` 的带长 `system` 请求，保持厂商 prefix cache 存活。
- `defaults.affinityTtlMs`：**缓存亲和有效期**（默认 `300000` = 5 分钟，0 = 不过期）。请求成功后会记住「该模型最近一次成功用的上游」，后续请求优先复用它（保持厂商缓存亲和、降碎片化）。有效期过后亲和失效，请求回到配置里的**主上游**（`models.<名>.provider`）——避免「上游恢复后因亲和粘性永不回流」。TTL 内不会来回抖动。
- `defaults.failbackProbe`：**主上游回切探活**（默认开启，仅降级中工作）。当某模型当前由**备用上游**（`fallbacks`）服务时，按 `everyMs`（默认 30s）向主上游发最小探活请求（真实 chat、`max_tokens:1`、**不计额度**、超时取 `defaults.timeout.connectMs`），连续 `successStreak`（默认 2）次成功后清除亲和，下一个请求即回到主上游。这样**回切前已验证可用**，真实请求不会踩到"刚恢复又挂"的雷；正常态（用主上游时）**零开销、不发探活**。主上游处于熔断中时跳过探活（交给熔断的半开机制，避免打架）。`system` 为探活消息内容（默认 `ping`，省 token；以 **user 角色**发送——部分上游/聚合网关的 LiteLLM 层拒绝 system-only 请求并返回 400 `LITELLM_ERROR`，用 system 前缀探活会永远失败）。
  - 与 `affinityTtlMs` 的关系：探活是**主动**回切（30s 粒度、验证后切），TTL 是**被动**兜底（过期后下一个请求试水）；二者互补，探活为主。
  - 探活**刻意不用** `/v1/models`：聚合平台常见「models 通、chat 挂」（平台健康、推理层过载），用 models 探活会误判为已恢复，切过去反而卡住。
- `gateway.local.json`（已 gitignore）：真实 baseUrl / Key 名 / 私有覆盖放这里，浅合并覆盖 `gateway.json` 的 providers/models/defaults；`server` 段始终取自 `gateway.json`。`MG_CONFIG=/path/config.json` 可指定别处配置。保存接口删除上游/模型时会在该文件写 `_removed: {providers:[…],models:[…]}` 墓碑，加载时先合并后删除，因此删除在重启后仍然生效；重新加回同名条目会自动撤销墓碑。
- **上游 HTTP 代理 `proxy`**：未配置时可能使用进程代理环境变量。字段可放 `defaults.proxy`（全局）或 `providers.<名>.proxy`（单上游覆盖）；形如 `"http://user:pass@127.0.0.1:7890"`。也可不写配置、直接给网关进程设系统级 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量。**优先级**：`providers.<名>.proxy` > `defaults.proxy` > 环境变量。**按上游定名单**（auto 模式生效）：单上游 `proxy` 留空/缺省 = 继承全局；填 `http(s)://...` = 强制走该代理；填 `direct`（或 `false`）= 强制直连、无视全局。**全局 `defaults.proxy` 可在面板「默认上游」卡「网络代理」输入框配置，单上游名单在「上游服务」编辑弹窗「代理」字段配置（均持久化，不再丢）**。网关用 Node 内置 `https` 的 **CONNECT 隧道**实现，零依赖；`proxy.proxy` 指向 Clash/mihomo 等本地混合端口即可让上游请求走代理出口（**注意**：网关的转发、探活、模型测试、预热一律经代理；本机回环上游如 `127.0.0.1:3050` 自动跳过代理直连）。
- **代理模式 `proxyMode`**（`auto` 默认 / `direct` / `global`，面板「代理模式」下拉或配置 `defaults.proxyMode`）：
  - `auto`：按配置/名单——回环直连；非回环按 `providers.<名>.proxy` > `defaults.proxy` > 环境变量，名单里标 `direct`/`false` 的单上游强制直连；
  - `direct`：全部上游强制直连，无视任何代理配置（断代理排查/临时绕开 Clash）；
  - `global`：非回环上游**全部**强制走全局代理（`defaults.proxy` 或环境变量），忽略单上游名单（含 `direct`）；回环仍自动直连。
  - 三者切换只需保存配置即热生效（`reloadConfig`），不重启网关。

## 模型名回写

跨模型兜底时，网关把请求 `model` 改写为实际落地的模型发给上游，但**响应里的 `model` 会回写为客户端请求的名字**（流式与非流式均处理），避免客户端续写/统计因名字错位而出错。

## 安全

- **管理令牌**：设置后受保护的管理接口需 `Authorization: Bearer <token>` 或 `x-mg-admin: <token>`，未授权返回 401；未设置时只有**本机**（回环对端）可调用管理接口，远程对端一律 403，启动会打警告（非回环绑定且无令牌时升级为错误级）。三种设置方式（优先级从高到低）：① 环境变量 `MG_ADMIN_TOKEN`；② `gateway.json` 的 `server.adminToken`；③ 控制面板顶部「令牌」按钮——**面板录入即写服务端并热生效**
- **管理面来源策略（MG-001）**：① Host 只接受 IP 字面量与 `localhost`/`server.host`/`server.allowedHosts` 中的名字，其他域名返回 403（DNS 重绑定防护）；② 带 `Origin` 的浏览器请求必须同源或命中 `server.allowedOrigins`，跨源写/读一律 403（`Origin: null` 同样拒绝）；③ 无 `Origin` 的 CLI/curl 不受影响。数据面同样做 Host 校验，跨源写请求返回 403 `{error:{message,type:'forbidden'}}`。**迁移**：用自定义域名或局域网域名访问面板/网关时，把该名字加入 `server.allowedHosts`；用另一源的前端页面调用网关时，把该源加入 `server.allowedOrigins`；远程管理访问必须先配置管理令牌。（加密存于 keys 库，重启不失效），留空则关闭保护。若设了环境变量，以环境变量为准。
- **面板门禁**：启用管理令牌后，打开控制台先显示**登录卡片**，输入正确令牌才进入主界面（令牌错误红字提示）。浏览器记住当前网关实例（按启动时间戳 `startedAt` 判定），同一实例内刷新不再要求输入；**网关重启后需重新输入令牌**。
- **数据面鉴权**：`MG_CLIENT_KEY` 或面板里的 `clientKey` 设置后，`/v1/*` 需携带同一 Key，否则 401；未配置全局 Key 时，绑定独立 Key 的虚拟模型仍需验证其 Key；其他入口保留本地匿名访问。全局 Key 可访问全部模型；虚拟 Key 在启用全局门禁时只放行自己的入口。
- **转发鉴权**：向各上游转发时**剥离客户端自带** `Authorization/Cookie/x-api-key/proxy-*`，统一由网关注入，杜绝绕过。
- **Key 加密落盘**：`config/keys.local.json` **始终 AES-256-GCM 加密**（文件头 `MG1:`），主密钥优先取 `MG_KEYS_MASTER`，否则自动生成并持久化到用户目录的 `master.key`。`clientKey` 同样加密存于 keys 库，不写明文。文件启动时收紧权限（Windows `icacls` / 其它 `chmod 0600`）。
- **日志脱敏**：日志对已登记密钥/Token 值统一掩码，减少密钥落日志的风险；热更新后脱敏名单同步仍见开发计划 MG-005。

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
- **模型级平均延迟**：模型卡片显示 `请求X · 错Y · 均 xx ms` 统计行，随真实请求流量累计（进程内累计；持久化恢复字段以 index.js 为准）。

## 启动与日志

- **健壮启动**：`start.bat` 启动前会自动清理**占用 8787 的残留/孤儿 node 进程**，避免 `EADDRINUSE` 与「旧实例占着端口、agent 连不上」造成的空窗；前台运行，关闭窗口即停。
- **请求级日志**：每次数据面请求写一行 `data <METHOD> <path> -> <status> model=<请求模型> serving=<实际服务模型> provider=<上游>`。若返回 **2xx 却无正文内容**会额外告警 `data 2xx 无正文内容 ...`，便于定位空响应。日志只记元数据，**不含消息正文/密钥**。数据面鉴权失败返回统一 401。
- **日志按天分文件 + 7 天保留**：实际落盘为 `logs/gateway-YYYY-MM-DD.log`（配置里的 `logFile` 只指定前缀），启动/跨天自动清理 7 天前的旧日志（含历史无日期旧版与 `.old` 轮转件）；单文件超 5MB 轮转 `.old`。面板「日志」页读当前天文件。
- **数据持久化**：`config/stats.json` 每 30s 落盘并在重启后恢复：按天/按小时/按模型的 token 与命中率、按对话、全局计数（请求/错误/token/平均延迟/趋势）、各上游计数与探针。重置数据：停止网关后把该文件内容清为空结构即可。面板顶部「刷新」会立即重拉状态并重绘曲线。

## 托盘小窗管理器（可选）

`mg-tray.exe`（`scripts/tray/build.cmd` 用 Windows 自带 .NET Framework 编译，零第三方依赖，产物 ~24KB）：无边框置顶悬浮小窗 + 托盘常驻，告别命令行窗口。

- **悬浮小窗**：状态 ●、uptime、今日 token、请求/错误，按钮 启动/停止/重启/面板/日志；可拖动，右键菜单切「置顶」，✕ 缩到托盘（守护不中断）。
- **托盘**：双击唤出小窗；右键菜单 = 面板/小窗/启动/停止/重启/**开机自启**（写 HKCU Run 键，免管理员）/日志文件夹/退出（会停止网关，有确认）。
- **看门狗**：托盘拉起的网关崩溃后 5s 自动重启（连续快速失败 ≥5 次熔断并气泡提示）；启动前自动清占用端口的残留 node（同 start.bat 语义）。检测到端口已有 node 实例时显示「外部实例/未接管」，不重复拉起。
- 数据源：轮询 `/healthz`（存活）与 `/api/status`（统计；设置了管理令牌时自动降级为「统计需令牌」）。

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
  scripts/test/          # 默认隔离套件 + 显式选择的旧测试
  scripts/tray/          # 托盘小窗管理器（mg-tray.cs 源码 + build.cmd 一键编译）
  logs/                  # 运行时日志（gitignore，按天分文件保留 7 天）
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
| `MG_CONFIG_DIR` | keys/local/stats 隔离目录；未指定时为 cwd/config |
| `MG_GW` | 旧测试目标；需显式指定可丢弃的本地实例，禁用生产端口 8787 |


## HTTP 边界

Chat 请求必须为 JSON 对象，否则 400。管理和数据面请求均受 server.maxBodyBytes（默认 32 MiB）限制，超限返回 413。跨源请求与非 IP 字面量 Host 在到达路由前即被 403（见上文「管理面来源策略」）。客户端 Host、Cookie、鉴权头、x-mg-admin、x-goog-api-key 以及 Connection 列出的逐跳头不会转发；上游鉴权来自 provider。/healthz 和 /api/auth 是公开的状态入口。
