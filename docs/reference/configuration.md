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
    "codexOfficialHosts": ["api.openai.com", "chatgpt.com", "chat.openai.com"],  // 官方目标 host 白名单（替换内置清单，见「Codex 聚合身份域」）
    "aggregatePrefixes": ["mg-", "mg/"],    // Codex 聚合保留 ID 前缀：命中但未配置 → 404 unknown_model，不回落默认上游
    "codexFallback": false,                 // Codex 智能 Fallback 总开关（聚合 slug 自动启用；true 时非聚合模型也受决策器约束）
    "codexFallbackLimits": { "maxSameProviderAttempts": 1, "maxFailovers": 2, "maxTotalAttempts": 3, "maxWaitMs": 30000 },
    "codexBudget": { "requestUsd": 0, "taskUsd": 0, "dailyUsd": 0, "enforceUnknownCost": false },
    "codexEmergency": false,                // D7 手动应急：true 或 {"acknowledged":true} 才允许官方额度耗尽后切第三方
    "failbackProbe": { "enabled": true, "everyMs": 30000, "successStreak": 2, "system": "ping" }  // 主上游回切探活
  },
  "providers": {
    "deepseek-official": { "baseUrl": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY", "api": "openai", "extraHeaders": {} },
    "claude":           { "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "ANTHROPIC_API_KEY", "api": "anthropic", "circuit": { "maxFailures": 3, "openDurationMs": 10000 } },
    "gemini":           { "baseUrl": "https://generativelanguage.googleapis.com", "apiKeyEnv": "GEMINI_API_KEY", "api": "gemini" },
    "local-ollama":     { "baseUrl": "http://127.0.0.1:11434", "apiKeyEnv": "" },
    // Codex 聚合：官方直连示例（codexIdentity 可省略——官方 host 自动判定；第三方可显式声明 thirdParty）
    // F01：官方目标只走 API Key 直连；/backend-api/codex（ChatGPT 订阅后端）与客户端凭据透传已移除，必须配 apiKeyEnv/面板 Key。
    "codex-official":   { "baseUrl": "https://api.openai.com", "codexIdentity": "official", "apiKeyEnv": "OPENAI_API_KEY" }
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
- `defaults.clientKey`：数据面鉴权 Key。面板录入后改存**加密 keys 库**，`/api/status` 与 `/api/config` 只回掩码 `********`，不会明文落盘。保存语义是**三态**：省略该字段或回传掩码（`^\s*\*{8}\s*$`，允许首尾空白）= 保持现有 Key（省略绝不等于清空）；显式发送空字符串 `""` = 删除数据面全局 Key；非空字符串 = 替换。非法值（非字符串/纯空白/控制字符）返回 400 且不落盘。优先级固定为 `MG_CLIENT_KEY` 环境变量 > 加密 keys 库（`__mg_client`）> 旧版 `defaults.clientKey` 明文（省略字段保存时自动迁移进加密库并清掉明文）。审计日志只记动作（`clientKeyAction=...`）与配置代际（`version=N`），不记 Key 值。
- `defaults.directory`：跨模型兜底。`mode: afterAll` 表示按序全部尝试，`onFail` 表示仅当前模型失败时才启用后续。**整条链(a→b→c)一轮全败后网关会回到队首反复重试（循环兜底）**，直到成功 / 业务 4xx / 整体超时 / 全部熔断；单轮兜底时间上限由 `defaults.timeout.loopMs`（默认 120000ms）约束，最长一次请求的兜底重试时长不会超过它。请求日志会带 `chain=实际尝试过的模型链` 标记，可直接看到兜底是否触发。
- `defaults.timeout`：三层超时 + 请求级整体预算。`connectMs`（建连/代理 CONNECT 首包）、`firstByteMs`（等上游响应头）、`idleMs`（响应头后无字节/无 SSE 数据事件）各自兜底；`loopMs`（默认 120000）限制模型兜底链循环。`overallMs`（默认 0=不限）是**单次数据面请求的硬上限**：从请求进入网关起算，覆盖读客户端 body、全部排队等待（QPS 令牌/provider 并发/模型并发/429 退避）、代理 CONNECT、上游建连与等响应头、非流式读体、SSE 中继与断流续传，并把 `loopMs` 进一步钳制到剩余预算；每个阶段的有效上限 = min(该阶段配置, 剩余预算)。**`overallMs>0` 时包含流式阶段**——长生成任务请调大或设为 0。预算耗尽：响应头未发出 → `504` 且 `error.type=request_timeout`；已进入流式 → SSE `error` 事件（`type=stream_interrupted, code=REQUEST_TIMEOUT`）+ `[DONE]`，已发出的状态码与内容不撤回。**客户端断开始终会取消排队与在途上游请求（不依赖 `overallMs`）**，按客户端断开记账：不计上游失败、不熔断。契约见 [请求生命周期契约](../contracts/request-lifecycle-v1.md)。
- **SSE 背压**：慢客户端不再导致无界缓冲——`res.write()` 返回 false 后网关暂停读取上游并等待 `drain`；等待超过 30s 或未写出缓冲超过 8MiB 即销毁客户端连接与上游流，按客户端断开记账（不计上游故障）。这两个是内置上限，当前不提供配置项。
- `models.<名>.capability`：模型能力声明，`chat`（默认，对话/补全/Responses 桥）、`embedding`（仅 `/v1/embeddings`）、`rerank`（仅 `/v1/rerank`）、`audio`（`/v1/audio/*`）、`image`（`/v1/images/*`）或 `video`（`/v1/videos*`）。
- `defaults.optionalEndpoints`（F04）：可选端点能力总开关，作用于 embedding / rerank / audio / image / video 五类**已证实**能力。形如 `{ "embedding": false, "rerank": { "enabled": false, "reason": "contract_not_signed_off" } }`：
  - 省略该小节 = 保持既有行为（五类能力均可用），**旧配置无需迁移**；
  - 显式关闭的能力，其入口在读请求体/路由/触达上游**之前**返回 `501` `{code:"optional_endpoint_disabled", capability, reason}`，零上游调用；
  - 只接受上面五个能力名（含拼写错误一律 400，不落盘）；未证实的新能力无法通过配置开启；
  - 该开关只做「放行/拒绝」，不改变协议、不回退到其它能力（例如视频关闭后不会退化成同步图片接口）。能力隔离是双向的：任何非 chat 模型从对话入口调用返回 400，其他能力入口也互斥；`/v1/models` 与 `/api/status` 均暴露该字段，模型编辑器可切换。
- **Video（异步任务池，ADR-0001）**：`POST /v1/videos` 创建任务（`{model, prompt, ...}`，支持 `Idempotency-Key` 幂等）、`GET /v1/videos/:id` 查询（惰性 + 后台轮询上游）、`POST /v1/videos/:id/cancel` 取消、`GET /v1/videos` 列表。只桥接 OpenAI 兼容上游；路径可按模型覆盖 `videoCreatePath`（默认 `/v1/videos`）、`videoStatusPath`（默认 `/v1/videos/{id}`）、`videoCancelPath`（默认 `/v1/videos/{id}/cancel`）。任务持久化到 `<配置目录>/videos.json`（原子写，单进程）；状态机 queued/running/succeeded/failed/canceled；终态保留 7 天、总量上限 500、非终态超 24h 判 failed；启动与每小时 GC。创建/轮询/取消复用 `defaults.timeout` 与 `overallMs` 预算；video 不提供在线探测（避免计费生成）。
- **Audio / Image**：`POST /v1/audio/speech`（JSON → 二进制音频）、`POST /v1/audio/transcriptions`（multipart）、`POST /v1/images/generations`（JSON）、`POST /v1/images/edits`（multipart）。只桥接 OpenAI 兼容上游（`api=openai`），Anthropic/Gemini/Cohere 等显式 502 且不触上游。multipart 仅解析 `model` 字段用于路由与 per-上游覆盖名替换，文件字节原样转发；请求体受 `server.maxBodyBytes`；响应 content-type 逐字节透传；响应体上限 `defaults.mediaMaxResponseBytes`（默认 64MiB，超限 → 502 `media_too_large`）。usage token（图片 JSON 响应等）计入账本，无 usage 记 0；audio/image 不提供在线探测（避免产生计费媒体）。虚拟模型不支持媒体能力。
- **Responses 原生透传**：`models.<名>.api="responses"` 时 `/v1/responses` 原样转发到 `responsesPath`（默认 `/v1/responses`，可按模型覆盖），非流式 JSON 的 `model` 回写客户端请求名、流式 SSE 逐字节透传（不翻译事件、原生流不改 model）；其余模型仍走 Chat 桥。
- **Rerank**：`POST /v1/rerank`（兼容 `/rerank`；OpenAI/Jina 风格 `{model,query,documents,top_n,return_documents}`）。上游协议 `api=openai`（默认，`/v1/rerank`）或 `api=cohere`（`/v2/rerank`）；Anthropic/Gemini 无 rerank → 502 且不触上游。响应归一：`results[]` 保留 `index/relevance_score/document`，按分数降序、同分按 index 升序稳定排序，`top_n` 再裁剪，`model` 回写客户端请求名；`meta`/`usage` 原样保留；usage token 计入账本（无 usage 记 0）。复用 provider `fallbacks`、熔断、并发信号量、`overallMs` 预算与 `maxBodyBytes`；`documents` 上限 2048。虚拟模型不支持 rerank。
- **Embedding**：`POST /v1/embeddings`（OpenAI 兼容：`model`/`input` 字符串或字符串数组/`dimensions`/`encoding_format`）。单次批量上限 2048 条；仅支持文本输入（token-id 数组暂不支持）。OpenAI 兼容上游原样透传；Gemini 上游经 `:batchEmbedContents` 适配（`dimensions → outputDimensionality`，响应 `embeddings[].values → data[].embedding`，Gemini 不返回 usage 时计 0）；Anthropic 无 embeddings 能力 → 502 且不触上游。复用 provider `fallbacks`、熔断、`defaults.timeout`/`overallMs` 预算与 `maxBodyBytes`；usage token 计入模型/日/全局账本。虚拟模型不支持 embeddings。
- `models.<名>.effortOptions`：允许的思考强度档位（客户端传的档位不在列表 → 本地 400）。`reasoning`：客户端未指定时注入的默认档位。`effortFormat`（可选）：思考强度参数格式——`reasoning_effort`（默认，OpenAI 风格字符串，DeepSeek/OpenAI 系）；`thinking`（MiniMax 风格对象，如 `MiniMax-M3` 认 `thinking:{"type":"adaptive"}`）。客户端入口统一传 `reasoning_effort`，网关按 `effortFormat` 转换注入；虚拟共用名默认不注入，除非设置了 `defaults.reasoning`。
- `defaults.reasoning`：可选的虚拟共用名默认思考档位；客户端显式传入的 `reasoning_effort` 优先。档位形态仍按链中目标模型自己的 `effortFormat` 转换。
- `models.<名>.dailyQuota/quota/maxContext`：0=不限；超限的模型在路由中被自动跳过并切到目录中的下一模型。`quota` 已持久化到 `stats.json`，重启不失效。
- `defaults.preheat`：主动缓存预热，默认空（关闭）。配置后按 `everyMs` 周期性向该模型上游发 `max_tokens:1` 的带长 `system` 请求，保持厂商 prefix cache 存活。
- `defaults.affinityTtlMs`：**缓存亲和有效期**（默认 `300000` = 5 分钟，0 = 不过期）。请求成功后会记住「该模型最近一次成功用的上游」，后续请求优先复用它（保持厂商缓存亲和、降碎片化）。有效期过后亲和失效，请求回到配置里的**主上游**（`models.<名>.provider`）——避免「上游恢复后因亲和粘性永不回流」。TTL 内不会来回抖动。
- `defaults.failbackProbe`：**主上游回切探活**（默认开启，仅降级中工作）。当某模型当前由**备用上游**（`fallbacks`）服务时，按 `everyMs`（默认 30s）向主上游发最小探活请求（真实 chat、`max_tokens:1`、**不计额度**、超时取 `defaults.timeout.connectMs`），连续 `successStreak`（默认 2）次成功后清除亲和，下一个请求即回到主上游。这样**回切前已验证可用**，真实请求不会踩到"刚恢复又挂"的雷；正常态（用主上游时）**零开销、不发探活**。主上游处于熔断中时跳过探活（交给熔断的半开机制，避免打架）。`system` 为探活消息内容（默认 `ping`，省 token；以 **user 角色**发送——部分上游/聚合网关的 LiteLLM 层拒绝 system-only 请求并返回 400 `LITELLM_ERROR`，用 system 前缀探活会永远失败）。
  - 与 `affinityTtlMs` 的关系：探活是**主动**回切（30s 粒度、验证后切），TTL 是**被动**兜底（过期后下一个请求试水）；二者互补，探活为主。
  - 探活**刻意不用** `/v1/models`：聚合平台常见「models 通、chat 挂」（平台健康、推理层过载），用 models 探活会误判为已恢复，切过去反而卡住。
- **配置事务与恢复（M0-3）**：`gateway.local.json`（配置补丁+代际）与加密 `keys.local.json` 作为一个**代际**提交。写入流程为：目录级跨进程锁（`config-txn.lock`，拿不到锁立即 409，不排队）→ 恢复未完成事务 → 校验内存指纹与磁盘一致（外部编辑立即 409 `store_conflict`，不覆盖）→ 暂存新文件并 fsync → 写 journal（`config-txn.json`）→ 逐文件「校验旧指纹 → rename → fsync 目录」→ 写 commit marker（`config-txn.commit.json`）→ 发布内存代际 → 清理自有工件。进程在任意步骤崩溃后，重启时按 journal/marker 前滚或回滚到完整旧/新代际，绝不混合；无法判定时保留磁盘并 fail-closed。成功提交的 keys 文件权限为 0600。离线测试可用 `MG_TXN_FAULT=<注入点>[:throw|exit|kill]`（只应作用于测试子进程）覆盖故障矩阵，注入点见 `src/config-transaction.js` 的 `FAULT_POINTS`。
- **只读配置投影**：`GET /api/config` 返回可直接用于保存的配置（`configVersion/providers/models/defaults/virtualModels`），不含运行时统计与 Key 明文，`clientKey` 掩码；面板后续可改用它替代从 `/api/status` 反推（D-6）。`virtualModels[*]` 额外返回后端判定的 `expiresAtState`（`none`/`valid`/`expired`/`invalid`）与 `expiresAtMs`，前端只展示状态、不自行比较时间。
- `virtualModels[].expiresAt` / `virtualModels[].note`：**三态**——整个 `virtualModels` 字段省略、或数组里的对象省略这两个字段 = 保留现有元数据（省略绝不等于删除）；字段显式出现且为空字符串 = 清空该字段；两者都空才删除 `__mg_vm_meta_<name>` 条目。删除虚拟模型（不在数组中）仍会同时清理其独立 Key 与 meta。
- `virtualModels[].expiresAt`（续）：**单一真源在后端**。支持毫秒值、带时区 ISO8601、旧 `datetime-local`（`YYYY-MM-DDTHH:mm`，按本机时区解释）与旧日期 `YYYY-MM-DD`（本机零点，兼容历史配置）；保存 datetime-local/毫秒值后统一写显式时区 ISO（旧日期保留原值）。无时区的秒级 ISO 视为歧义；非法/歧义值保存返回 400（错误带 `expiry_*` code）且不落盘；已存在的非法值在鉴权时一律 deny（修复前 `Number()` 得 `NaN` 会永久放行）。到期判定沿用 `now > expiresAt`（到期瞬间仍有效），判定时刻可注入以覆盖边界测试。
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
- **转发鉴权**：向各上游转发时**剥离客户端自带** `Authorization/Cookie/x-api-key/proxy-*`，统一由网关注入，杜绝绕过；配置里的 `extraHeaders` 也不能覆盖或注入鉴权头（命中即忽略并留审计日志，只记头名）。详见下节「Codex 聚合身份域」。
- **Key 加密落盘**：`config/keys.local.json` **始终 AES-256-GCM 加密**（文件头 `MG1:`），主密钥优先取 `MG_KEYS_MASTER`，否则自动生成并持久化到用户目录的 `master.key`。`clientKey` 同样加密存于 keys 库，不写明文。文件启动时收紧权限（Windows `icacls` / 其它 `chmod 0600`）。
- **日志脱敏**：日志对已登记密钥/Token 值统一掩码，减少密钥落日志的风险；热更新后脱敏名单同步仍见开发计划 MG-005。

## 管理面入口：/api/codex/* 显式管理员与受控写入（M4-1b / P0-2）

- **显式管理员**：/api/codex/* 一律要求正确管理令牌（Authorization: Bearer <token> 或 x-mg-admin: <token>）。未设置令牌时**不再有任何本机放行**；未携带/错误令牌在读请求体之前返回 403 explicit_admin_required（大 body 不会被读取，也不会变成 413）。
- **可信来源**：Host/Origin 仍按上文「管理面来源策略」在路由前校验；非回环对端默认 403 remote_forbidden，只有 server.allowRemote=true 或环境变量 MG_ADMIN_ALLOW_REMOTE=1 才放行远程管理（仍要求显式令牌）。旧 /api/* 的管理语义未在本轮改动。
- **adminSubject**：入口用 sha256(管理令牌) 前 16 位派生稳定主体（形如 admin-xxxxxxxxxxxxxxxx），仅用于审计关联；日志与响应不含令牌本体。
- **受控写入默认关闭**：apply/rollback 返回 403 write_disabled（便于诊断，不是 404）。启用：设置 MG_CODEX_MANAGED_ROOT=<绝对路径且文件名为 config.toml>；启动时登记为不透明根 id managed-root（mode=managed）。plan/apply 只接受 root=managed-root，不接受任何浏览器提供的路径或原始 TOML。登记失败（非绝对路径/非 config.toml/符号链接/父目录不可解析）只记告警并保持关闭。
- **重启语义**：root/backup/confirmToken 注册表是进程内的；重启后旧 backupId 失效，需要重新 plan/apply 取得新 backupId；MG_CODEX_MANAGED_ROOT 会在每次启动时重新登记。
- 相关契约：docs/contracts/management-api-v1.md 第 10 节（模块边界）与本文件。

## Codex 第三方能力迁移（M2-2 行为变更）

自 2026-11-11 起，第三方条目的 tool/search/patch/agent/hosted tools 能力不再从官方模板继承；未证实能力默认不声明（shell_type=disabled、experimental_supported_tools=[]，可选能力字段不写）。

需要声明能力时，在 models.<名>.codex 中同时提供 capabilities 与同键 evidence：

    codex:
      capabilities:
        webSearchToolType: text_and_image
        multiAgentVersion: v1
      evidence:
        webSearchToolType: { source: "https://vendor.example/docs/models", observedAt: "2026-11-11" }
        multiAgentVersion: { source: "https://vendor.example/docs/agents", observedAt: "2026-11-11" }

- 旧字段 multiAgentVersion / toolMode / webSearchToolType / experimentalSupportedTools 视为同样的能力声明，也必须带 evidence.<同键>。
- 保守值无需证据：false、空数组、字符串 disabled/none；codex.baseInstructions 属声明文本，无需 evidence（默认已改为中性指令）。
- 缺失/非法证据是 fail-closed：生成目录报 capability_evidence_missing（details.model/field 指向具体项），不会静默降级。需要过渡时请删除未证实字段（自动落到保守骨架），不要依赖“只警告”模式。

## Codex 聚合身份域（E1）

Codex 0.167 在自定义 provider 与内置 openai 两条路径上都会带一批**会话/身份专用头**。网关按「目标身份域」逐头决定放行与否，避免官方凭据流入第三方、第三方 key 流入官方路径。

判定（`src/codex/identity.js`，**provider 名字不参与**）：
- 与 `baseUrl` 主机命中官方 host 白名单（默认 `api.openai.com` / `chatgpt.com` / `chat.openai.com`），或 `providers.<名>.codexIdentity="official"` 且主机在白名单 → **official**；
- 其它主机 → **thirdParty**；
- `baseUrl` 缺失/非法、`codexIdentity` 值非法、或**声明与主机冲突**（声明 official 却指向非官方 host、声明 thirdParty 却指向官方 host）→ **unknown**，一律 fail-closed（403 `target_identity_unknown`）。
- `defaults.codexOfficialHosts` 是**替换**内置清单而非追加；自行搭建官方中转时须把原官方 host 一并列回。回环主机允许 `http`（仅隔离测试用途）。

头策略：
- **第三方目标**：剥除 `authorization`、`chatgpt-account-id`、`openai-beta`、`version`、`originator`、`session-id`、`thread-id`、`x-client-request-id` 以及 `chatgpt-*` / `openai-*` / `x-codex-*` / `x-openai-*` 前缀头；`sec-websocket-*`、`upgrade`、`connection` 等帧层/逐跳头永不转发。无自有 key 时**不发** Authorization（宁可让上游 401，也不继承客户端官方 token）。确需放行个别非凭据头时用 `providers.<名>.forwardClientHeaders: ["thread-id"]` 显式声明（凭据类与帧层头即使列出也不放行）。
- **官方目标**：只放行白名单（`accept`/`accept-encoding`/`content-type`/`user-agent`/`originator`/`version`/`session-id`/`thread-id`/`x-client-request-id`/`openai-beta` + `x-codex-*`/`x-openai-internal-*`/`openai-*` 前缀），其余丢弃并记头名。**凭据只有一条路**：
  - **网关自有 key**（keys/apiKeyEnv）→ 注入 `Authorization: Bearer <自有 key>`；客户端带来的 `authorization` / `chatgpt-account-id` 一律丢弃（不在白名单内，且凭据类有独立守卫）。
  - **客户端官方凭据透传已移除（F01）**：`/backend-api/codex` 订阅后端与 `MG_CODEX_OFFICIAL_PASSTHROUGH` 开关不再启用任何能力。官方目标没有自有 key 时：设置了旧开关 → 403 `official_passthrough_retired`（含迁移提示）；未设置 → 403 `official_no_gateway_key`。两种情况都**零上游请求**，也绝不改投第三方。网关不读取客户端登录态（`auth.json`/`CODEX_HOME` 从不访问）。
- 官方目标还受 host/scheme/path 白名单约束：必须是 `https`（回环例外），路径前缀只剩 `/v1`（`/backend-api/codex` 已移除）；错误码 `official_target_insecure_scheme` / `official_host_not_allowlisted` / `official_path_not_allowlisted`。上游 3xx 一律按上游错误处理（502 `upstream_redirect_rejected`），**不跟随重定向**（不把凭据送到 Location），Location 目标零命中。

严格路由：`defaults.aggregatePrefixes`（默认 `mg-`、`mg/`）是**聚合保留 ID 前缀**。命中前缀但未在 `models` 显式声明（含别名）时，`/v1/*` 返回 404 `{type:"unknown_model", code:"unknown_model", available:[…]}` 且**零上游请求**，绝不回退 `defaults.provider`；已配置的聚合 ID 与非保留前缀的未知模型维持原行为（后者仍按 `defaults.provider` 兜底，旧接口兼容）。

### Codex 动态目录与官方 provider（D2）

| 字段 | 说明 |
| --- | --- |
| `defaults.codexCatalogBasePath` | 官方基线目录文件（`codex debug models` 导出）；网关用它 + 已配置第三方模型生成完整 Codex 目录，服务 `GET /v1/models?client_version=…`（`{models:[ModelInfo…]}`）与 `model_catalog_json`。未配置时回落旧的 `{object:"list",data:[…]}` 形状（Codex 会报 `failed to decode models response`）。目录构建失败时 fail-closed：官方/聚合 slug 按 unknown 处理并写日志。 |
| `defaults.codexOfficialProvider` | 官方模型 slug 的上游 provider id。官方模型**不需要**出现在 `models`（目录生成器禁止复用官方 slug）；缺该字段时官方 slug 判 unknown（404），不会回落 `defaults.provider`。 |
| 聚合 slug | 由目录生成器产出：`mg-<provider>-<model>`（`providers` id + `models` 键名净化）。请求该 slug 时网关映射到 `models.<原名>` 的上游及 `providerModels`，响应 `model` 回写 slug。 |
| `MG_CODEX_OFFICIAL_PASSTHROUGH` | **已退役（F01）**：客户端官方凭据透传已移除。保留该变量只会被判为旧配置并给出迁移提示，不启用任何能力（见下文环境变量表）。 |

**官方额度（D7）**：`defaults.codexQuota = { warnPercent: 80, criticalPercent: 95, source: "none" | "trusted" }`。`source:"none"` 时即使注入了读数也不采用（严格 UNKNOWN，不虚构余额）；没有可信数据时显示 `UNKNOWN`。应急态必须显式 `{acknowledged:true, reason, backupPoint}` 才能进入，记录时间线并可恢复；进入/恢复都需用户确认，绝不自动切换 provider、购买额度或退出官方登录。


### Codex 智能 Fallback（E5）

聚合 slug（`mg-<provider>-<model>`）、官方 slug，或 `defaults.codexFallback=true` 的请求由 `src/routing/decision.js` 决策：错误先分类，再按请求阶段（未发送 / 已受理无副作用 / 工具副作用 / 已交付流 / 部分提交 / 取消）判定能否重试或换候选。出现工具或托管副作用、已交付内容、部分提交、客户端取消、v2 加密任务不可读时**立即停机**，不重放。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaults.codexFallback` | `false` | 总开关。聚合 slug 与官方 slug 自动启用；`true` 时对其它模型也启用（旧模型链的换模型也要先过决策器）。 |
| `defaults.codexFallbackLimits.maxSameProviderAttempts` | `1` | 同上游最多重试次数（`retry_same`）。Codex 模式下由决策器拥有重试，`forward()` 内部重试关闭。 |
| `defaults.codexFallbackLimits.maxFailovers` | `2` | 最多换候选次数。 |
| `defaults.codexFallbackLimits.maxTotalAttempts` | `3` | 单请求总上游尝试上限。 |
| `defaults.codexFallbackLimits.maxWaitMs` | `30000` | Retry-After / 退避的单次等待上限。 |
| `defaults.codexBudget.requestUsd` | `0` | 单请求费用上限（USD；0=不限）。按 `models.<名>.costEstimateUsd` / `providers.<名>.costEstimateUsd` 的单次估算累计。 |
| `defaults.codexBudget.taskUsd` / `dailyUsd` | `0` | 单任务 / 日累计上限。**当前未接费用账本，spent 恒 0（NOT_RUN）**；字段保留给后续接入。 |
| `defaults.codexBudget.enforceUnknownCost` | `false` | `true` 时付费候选若没有费用估算则 fail-closed（宁可停机也不假设免费）。 |
| `defaults.codexEmergency` | `false` | D7 手动应急。`true` 或 `{"acknowledged":true}` 才允许「官方订阅 402」后切换到第三方候选；否则返回 `MG_FB_OFFICIAL_QUOTA`。 |
| `models.<名>.costEstimateUsd` / `providers.<名>.costEstimateUsd` | 未设置 | 单次调用费用估算（USD）。未设置时该候选费用未知。 |

行为要点：
- **候选授权**：已配置且凭据可用的第三方上游视为已授权；官方订阅（主机命中 `codexOfficialHosts`）永不进入通用 fallback 池，只在用户直接选择官方 slug 时作为主目标使用。
- **预算耗尽停机**：任一维度 `spent >= limit` 立即 `stop_with_error`（`MG_FB_BUDGET`，HTTP 402），不切更便宜的候选。
- **错误映射**：`MG_FB_RATE_LIMITED`→429、`MG_FB_BUDGET/MG_FB_QUOTA/MG_FB_OFFICIAL_QUOTA`→402、`MG_FB_BAD_REQUEST`→400、`MG_FB_TIMEOUT`→504、副作用/已交付/部分提交→409、其余→502；流已开始则改为流内 `stream_interrupted` 错误事件收尾。
- **日志**：只落一行 `codex fallback decision`（model/provider/error/phase/action/target/budget），不含令牌与请求正文。

> Codex 侧配置形态（`~/.codex/config.toml`）：`model_provider="openai"`、`openai_base_url="http://127.0.0.1:8787"`、`model_catalog_json="/abs/catalog.json"`。**不要**写 `[model_providers.openai]`——Codex 0.167 会以 `reserved built-in provider IDs` 启动失败。WebSocket 传输由网关回 404 触发 HTTPS 回落。

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
| `MG_ADMIN_ALLOW_REMOTE` | 置 `1`/`true`/`on` 允许非回环对端访问**管理面**（仍要求显式管理令牌）；默认关闭 |
| `MG_CODEX_MANAGED_ROOT` | 受控自管 Codex 配置文件的绝对路径（必须名为 `config.toml`）；设置后启动期登记不透明根 `managed-root`，启用 `/api/codex/config/apply|rollback`（仍要求显式管理员）。默认关闭 = apply/rollback 403 `write_disabled` |
| `MG_MAX_BODY` | 覆盖 `server.maxBodyBytes`（测试用） |
| `MG_CONFIG` | 指定非默认配置文件路径 |
| `MG_SILENT` | 置 1 关闭控制台日志（仍写文件） |
| `MG_CONFIG_DIR` | keys/local/stats 隔离目录；未指定时为 cwd/config |
| `MG_GW` | 旧测试目标；需显式指定可丢弃的本地实例，禁用生产端口 8787 |
| `MG_CODEX_OFFICIAL_PASSTHROUGH` | **已退役（F01）**：客户端官方凭据透传与 `/backend-api/codex` 已移除，置任何值都不会启用。启动时写一条迁移警告；官方目标若无网关自有 key 则 403 `official_passthrough_retired`。请删除该变量并为官方 provider 配置 `apiKeyEnv`/面板 Key |

**`apiKeyEnv` 的解析顺序**（`resolveKey`，转发/探测/预热/回切与 `/api/status` 同源）：① 面板 Key（加密 `keys.local.json`）→ ② **网关进程**环境变量 → ③ **用户级**环境变量。③ 在 Linux/POSIX 上先查 `systemctl --user show-environment`（其中已含 `~/.config/environment.d/*.conf`），未命中再直接解析 `~/.config/environment.d/*.conf`（按文件名排序，后者覆盖前者，支持双引号转义），因此改完环境变量最多约 60s 生效，无需重启网关或 `daemon-reload`；Windows 对应 `HKCU\Environment`。读取结果按变量名带 **60s TTL 正/负缓存**（避免每请求 `spawnSync` 空查），变量名先过标识符白名单（防注入）。

注意这条兜底只解决**网关进程自己**取 Key：由其它程序启动的客户端（如 DSH CLI headless）里，`apiKeyEnv` 指向的变量仍必须存在于**该客户端自己的启动环境**，网关的用户级兜底不会替客户端补 Key；客户端缺变量时报的是客户端侧的 `MISSING_CREDENTIAL`。


## HTTP 边界

Chat 请求必须为 JSON 对象，否则 400。管理和数据面请求均受 server.maxBodyBytes（默认 32 MiB）限制，超限返回 413。跨源请求与非 IP 字面量 Host 在到达路由前即被 403（见上文「管理面来源策略」）。客户端 Host、Cookie、鉴权头、x-mg-admin、x-goog-api-key 以及 Connection 列出的逐跳头不会转发；上游鉴权来自 provider。/healthz 和 /api/auth 是公开的状态入口。

## 收工闭环新增配置项（2026-11-12 补记）

| 键 | 语义 | 缺省行为 |
|---|---|---|
| `defaults.codexBudget.billingPolicy` | 付费候选在「没有预算上限且未接账本」时的放行策略。缺省 fail-closed：发送前拒绝并记 `billing_unmetered`（零上游）；显式 `allow_unmetered` 才放行，且审计面可见。 | 未设置 = 拒绝 |
| `defaults.opencodeGoHosts` | OpenCode Go 允许的 host 白名单（`src/codex/identity.js`）。 | 内置清单 |
| `providers.<名>.sessionHmacSecret` | Go 会话头的 HMAC 密钥来源。会话值按「主体 + provider + root/child 域 + 目标域 + 线程」派生，绝不转发客户端原始 `session-id`/`thread-id`。 | 未设置 = 请求内独立 id |
| `defaults.observability.capacity` | 观测事件环形缓冲容量；超出部分以 `dropped` 如实计数，不伪造历史。 | 见 `src/observability/events.js` |

相关接口：`GET /api/observability/events`（cursor 分页，`mg-observability-v1`）与 `GET /api/observability/stream`（有界快照 + 增量 + 15s keepalive）。
