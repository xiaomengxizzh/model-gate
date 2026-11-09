# Changelog

本项目所有显著变更记录于此。格式参考 Keep a Changelog；版本号随发布推进（`package.json` 已随 0.2.3 同步）。

## 2026-11-09 管理面 D-1/D-6 收尾（未发布，MG-009 余项）

### Added

- `GET /api/config` 只读配置投影（D-6）：返回 `{configVersion, providers, models, defaults, virtualModels}`，形状与 `POST /api/config/save` 请求体一致；剥离 providers/models 运行时字段、不返回 `_keys`/`_paths`、`defaults.clientKey` 掩码；未知扩展字段保留；鉴权/错误信封同管理 GET。
- 面板未知字段不透明袋（D-1）：`admin.html` 的 `buildCfrom` 把未识别字段存入 `_extra`，provider/model 编辑用 `Object.assign` 保留，`saveAll` 通过 `serializeMap` 合并回送，不再静默洗掉插件/新版本字段。
- 回归 `scripts/test/offline/config-projection.test.mjs`（3 组：投影形状与脱敏/鉴权与保存回读/面板 `_extra` 静态检查）；管理 API 契约与投影契约同步。

### 未验证
- 浏览器真实鉴权与保存回读、双标签 409、Linux/Windows 托盘实跑（本机无 Chrome/桌面环境，**NOT EXECUTED**）；provider 删除联动清 Key 仍未实现。

## 2026-11-09 原生 Responses 透传（未发布，MG-015 收尾）

### Added

- `models.<名>.api="responses"`（保存校验已允许）时，`/v1/responses` 走原生透传而非 Chat 桥：请求原样发往 `responsesPath`（默认 `/v1/responses`），`providerModels` 覆盖名生效；非流式 JSON 透传并把 `model` 回写客户端请求名，流式 SSE 逐字节管道（复用背压与预算中止）。拒绝矩阵（store/previous_response_id/background/include/truncation/托管工具）与能力隔离仍生效；上游错误体/状态透传。
- 回归 `scripts/test/offline/responses-native.test.mjs`（4 用例：非流式请求/响应/记账、SSE 原样、拒绝与能力隔离、错误与预算 504）；协议桥/契约/配置参考同步。

### Fixed
- 请求预算小于 `firstByteMs` 时，first-byte 定时器会先触发并被当作普通网络超时（502 `provider` 失败）；现按预算中止语义上报 504 `request_timeout`（影响所有入口的预算测试稳定性）。

### 未验证
- 真实 Codex CLI/桌面与 DSH 对照、Draft PR #2 审计；原生流式不改 model 字段（有损，已在契约 §7/§9 记录）。

## 2026-11-09 Video 异步任务池（未发布，MG-014）

### Added

- `capability=video` 与 Video API：`POST /v1/videos` 创建任务（支持 `Idempotency-Key`，同 key 返回既有任务不重复请求上游）、`GET /v1/videos/:id` 查询（惰性 ≥1.5s 一次 + 后台 5s 轮询）、`POST /v1/videos/:id/cancel`、`GET /v1/videos` 列表。
- 任务持久化到 `<配置目录>/videos.json`（原子写、单进程）：状态机 queued/running/succeeded/failed/canceled，终态幂等；重启恢复未完成任务并继续轮询；终态保留 7 天、总量上限 500、非终态超 24h 判 failed；启动与每小时 GC。
- 上游只桥接 OpenAI 兼容协议；路径可按模型覆盖 `videoCreatePath` / `videoStatusPath` / `videoCancelPath`（默认 `/v1/videos`、`/v1/videos/{id}`、`/v1/videos/{id}/cancel`）；任务 id 兼容 `id/task_id/request_id`，状态词归一；创建/轮询/取消复用 `forward()` 的 retry/timeout 与 `overallMs` 预算。
- 决策文档 `docs/explanation/adr-0001-video-task-pool.md`；回归 `scripts/test/offline/video.test.mjs`（6 用例：创建→轮询→完成与落盘、幂等、取消、重启恢复+GC、能力隔离/不支持协议、校验与预算）。

### Changed
- `npm run check` 覆盖 `src/videos.js`；`configPaths()` 新增 `videos`；admin 编辑器 capability 增加 video。

### 未验证
- 真实视频上游（Sora/Veo/Kling 等）路径/状态词/结果格式与计费；多进程共享配置目录；webhook 与结果转存；Windows/macOS、Node 18/20。

## 2026-11-09 Audio/Image 媒体能力（未发布，MG-013）

### Added

- `capability=audio|image` 与四个媒体入口：`POST /v1/audio/speech`（JSON → 二进制音频，content-type/字节透传）、`POST /v1/audio/transcriptions`（multipart）、`POST /v1/images/generations`（JSON）、`POST /v1/images/edits`（multipart）。只桥接 OpenAI 兼容上游；Anthropic/Gemini/Cohere 显式 502 且不触上游。
- multipart 处理：只解析 `model` 字段用于路由与 per-上游覆盖名替换（`replaceMultipartField`），文件字节原样转发；请求体受 `server.maxBodyBytes`；响应体受 `defaults.mediaMaxResponseBytes`（默认 64MiB，超限 → 502 `media_too_large`）。
- 媒体能力隔离（与 chat/embedding/rerank 互斥）；复用 provider `fallbacks`、熔断、并发信号量与 `overallMs` 预算/取消；usage token（图片 JSON 响应等）计入账本，无 usage 记 0；audio/image 不提供在线探测（避免计费媒体）；admin 编辑器 capability 增加 audio/image。
- 回归 `scripts/test/offline/media.test.mjs`（8 用例：speech 二进制、transcription 与 edits 的 multipart 原样转发、图片 JSON 与 usage 记账、能力隔离、Anthropic 拒绝、响应体积上限、预算 504 与 multipart 缺 model 400）；文档见配置参考与协议桥 §9。

### Changed
- `npm run check` 覆盖 `src/media.js`。

### 未验证
- 真实 OpenAI 音频/图像上游与计费、大文件（>32MiB）上传/下载、multipart 多文件与 `response_format=base64` 的真实行为；Windows/macOS、Node 18/20。

## 2026-11-09 Rerank 能力（未发布，MG-012）

### Added

- `capability=rerank` 与 `POST /v1/rerank`（兼容 `/rerank`）：OpenAI 兼容上游走 `/v1/rerank`，`api=cohere` 上游走 `/v2/rerank`；请求校验（query 非空、documents 非空字符串数组且 ≤2048、top_n 正整数、return_documents 布尔）。
- 响应归一：`results[]` 保留 `index/relevance_score/document`，按 score 降序、同分按 index 升序稳定排序，`top_n` 再次裁剪，`model` 回写客户端请求名；上游 `meta`/`usage` 原样保留；usage token 计入模型/日/全局/上游账本。
- 能力隔离：rerank 模型不能进 chat/embeddings，chat/embedding 模型不能进 rerank；虚拟模型不支持 rerank；Anthropic/Gemini 无 rerank → 502 且不触上游。
- 复用 provider `fallbacks`、熔断、并发信号量、`overallMs` 预算与 `maxBodyBytes`；`/api/model-test` 按 capability 走 rerank 探测；模型编辑器 capability 增加 rerank 选项。
- 回归 `scripts/test/offline/rerank.test.mjs`（6 用例：OpenAI 透传/排序/记账、Cohere 路径与 meta、能力隔离、fallback、校验、探测与预算）；文档见配置参考与协议桥 §8。

### Changed
- `npm run check` 覆盖 `src/rerank.js`；模型 `api` 校验新增 `cohere`。

### 未验证
- 真实 Cohere/Jina/SiliconFlow rerank 上游与计费；`return_documents` 与上游 `document` 形状差异；Windows/macOS、Node 18/20。

## 2026-11-09 能力声明与 Embedding（未发布，MG-011）

### Added

- `models.<名>.capability`：`chat`（默认）/`embedding` 能力声明；保存接口校验未知值（400），`/v1/models` 与 `/api/status` 暴露该字段，模型编辑器可切换。
- `POST /v1/embeddings`：OpenAI 兼容请求（`model`/`input` 字符串或字符串数组/`dimensions`/`encoding_format`，批量上限 2048）；OpenAI 兼容上游原样透传；Gemini 经 `:batchEmbedContents` 适配（`dimensions → outputDimensionality`，`embeddings[].values → data[].embedding`）；Anthropic 无此能力 → 502 且不触上游。复用 provider `fallbacks`、熔断、`defaults.timeout`/`overallMs` 预算、`maxBodyBytes` 与并发信号量。
- 能力隔离（双向）：embedding 模型从对话入口调用返回 400 `unsupported_model`；chat 模型从 embeddings 入口调用返回 400；虚拟模型/默认共用名不支持 embeddings。
- 记账与探测：embedding usage token 计入模型/日/全局/上游账本；`/api/model-test` 按 capability 选择 embeddings 端点；`/v1/models` 暴露 capability。
- 回归 `scripts/test/offline/embeddings.test.mjs`（7 用例：OpenAI 透传与记账、双向隔离、Gemini 路径/请求体/协议头/响应归一、Anthropic 拒绝、fallback、能力探测、预算 504）；文档见配置参考与协议桥 §7。

### Changed
- `npm run check` 覆盖 `src/embeddings.js`。

### 未验证
- 真实 OpenAI/Gemini embeddings 上游与计费、token-id 输入、base64 编码输出透传行为；Windows/macOS、Node 18/20。

## 2026-11-09 Responses 入口与 Chat 桥（未发布，MG-015）

### Added

- `/v1/responses`（与 `/responses` 别名）入口：将 Responses 请求映射为 Chat Completions 走既有治理（虚拟模型/Key/配额/熔断/亲和/统计/日志脱敏/MG-002 预算），再把上游结果重建为 Responses JSON 或 SSE 事件。非 POST 返回 405。
- `src/responses.js`：纯函数映射 `responsesToChat`（input/instructions/tools function|custom/tool_choice/reasoning/max_output_tokens；custom tool 自由文本编码为 `{input}`；**拒绝** store=true、previous_response_id、background=true、非空 include、truncation≠disabled、托管工具，400 且不触上游）、`chatToResponse`（`resp_*`、model 回写、output/output_text、usage/incomplete_details）、`makeSSEWriter`（§6 事件顺序、sequence 单调、不发 [DONE]）。
- `src/responses-stream.js`：Chat SSE → Responses 事件桥，复用 `relayStream` 的断流续传/空闲看门狗/预算/背压；流式终态 `response.completed` 或 `response.failed`（预算耗尽 `REQUEST_TIMEOUT`）；上游降级为 JSON 时以单帧事件交付。
- 回归：`scripts/test/offline/responses-mapping.test.mjs`（17 用例）与 `responses-endpoint.test.mjs`（6 用例：非流式整形、拒绝矩阵、SSE 顺序/无 [DONE]、工具参数分片、错误透传、405）。

### Changed
- `npm run check` 覆盖新增的 `src/budget.js`、`src/responses.js`、`src/responses-stream.js`。

### 未实现 / 未验证
- 原生 `api:"responses"` 透传（配置校验仍只允许 openai/anthropic/gemini）、真实 Codex CLI/桌面与 DSH 对照、Draft PR #2 审计均 **UNVERIFIED**；工具并行多调用以收尾时逐条补发完整参数呈现，不是逐调用并行 delta。

### 验证
- `npm run check` 0；`npm test` 18/18 隔离套件；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件；`npm run docs:check` PASS。

## 2026-11-09 模型解析一致性与错误信封（未发布，MG-008 余项）

### Fixed

- **预热/failback 与转发模型解析不一致**：`warm()`（缓存预热）与 `probeChat()`（主上游回切探活）此前固定打 `/v1/chat/completions` 并使用网关模型名，导致 per-model `api`（anthropic/gemini）与 `providerModels` 覆盖名在这两条路径失效（非 OpenAI 上游预热/探活永远失败，或探活打到错误模型）。现两者接受 `{ api, upstreamModel }`，按协议生成 path/body 与鉴权头（Anthropic `/v1/messages` + `x-api-key`/`anthropic-version`；Gemini `generateContent`/`streamGenerateContent` + `x-goog-api-key`）；Anthropic/Gemini 预热补一条 user 消息（协议要求至少一条非 system 消息）。
- **非 OpenAI 上游 4xx 原生错误信封原样回给 OpenAI 客户端**：Anthropic `{type:"error",error:{type,message}}` / Gemini `{error:{code,message,status}}` 客户端拿不到 `error.message`。现由 `mapErrorEnvelope()` 映射为 `{error:{message,type:'upstream_error',code}}`（状态码保留；已是 OpenAI 形状的代理响应原样透传；日志仍记录原始片段）。

### Added

- `router.modelTarget(cfg, modelName, pid)` 单一模型解析入口：`servingName`（providerModels 覆盖名）/`api`（模型优先、上游兜底）/`effortFormat`/`maxTokensMax`；转发、`probeModel`、预热、failback 全部复用。
- 回归 `scripts/test/offline/model-resolution.test.mjs`（7 用例）：modelTarget 优先级、warm/probeChat 的 Anthropic/Gemini path+覆盖名+鉴权头、错误信封映射、Anthropic 400 集成、OpenAI 错误透传对照。
- 文档：`docs/reference/protocol-bridge.md` §7（模型解析与错误信封）。

### 验证

- `npm run check` 0；`npm test` 16/16 隔离套件；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件；`npm run docs:check` PASS。
- 未验证：真实 Anthropic/Gemini 上游、预热/failback 的实时定时器端到端（仅函数级 + 转发集成）、Windows/macOS、Node 18/20。

## 2026-11-09 管理面投影清洗与 Key 标识白名单（未发布，MG-009）

### Fixed

- **配置保存把投影统计字段写进 `gateway.local.json`（D-2）**：`/api/status` 的 `providers`/`models` 混有 `st`/`probe`/`requests`/`errors`/`tokens` 等运行时字段，旧面板原样回送时被整体替换落盘，配置被污染。`doSaveConfig` 现以显式 denylist 剥离 `providers[*]`（hasKey/keySource/keyOk/st/probe）与 `models[*]`（probe/requests/errors/tokens/today/hitRate/affinity/avgMs/inTokens/outTokens/latencySum/latencyCount）后再写入；**未识别的扩展字段仍保留**（不透明袋约定）。
- **Key 保存无版本校验（D-7，面板侧）**：`admin.html` 上游 Key 保存/删除与虚拟模型 Key 统一走 `postKey()`，携带 `baseVersion ?? ST.configVersion`；409 提示后加载最新，不再静默覆盖。
- **dirty 时 3s 轮询洗掉保存基准版本（D-3）**：首次脏化冻结 `baseVersion`，`ingestStatus` 在脏状态不覆盖 `ST.configVersion`；保存/409/重载成功后清空。
- **`/api/keys` 可写任意 id（§8）**：未配置的上游/虚拟模型标识不再接受，避免产生 UI 无法删除的孤儿键。

### Added

- `/api/keys` 标识白名单（MG-009 §8.3）：允许并集 = 当前 `providers` 键 ∪ 当前虚拟模型 `__mg_vm_<name>` ∪ `__mg_client`/`__mg_admin` ∪ keys 库已存在条目（保留历史键清理路径）；未知标识返回 `400 {error:'未知的 Key 标识：<id>'}`；`__mg_vm_meta_*` 只允许删除，不允许写字符串。
- 管理面 UI 投影契约与前端 F0 fixture（`docs/contracts/management-ui-projection-v1.md`、`docs/contracts/fixtures/v1/`）与托盘部署说明（`docs/how-to/tray-deployment.md`）。
- 回归：`scripts/test/offline/admin-projection.test.mjs`（D-2 剥离与扩展字段保留、白名单允许/拒绝/删除、Key 版本三态、面板 D-3 静态检查）；`config-schema` 的未知 `id` 断言同步改为 400。

### 验证

- `npm run check` 0；`npm test` 15/15 隔离套件；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件；`npm run docs:check` PASS。
- 未验证：浏览器真实鉴权/保存回读/双标签 409、托盘实跑、Windows/macOS、Node 18/20、真实上游与计费。

## 2026-11-09 请求生命周期预算与 SSE 背压（未发布，MG-002）

### Fixed

- 单次数据面请求此前没有统一的跨排队/流式 deadline：`overallMs` 只在 `forward()` 重试循环里检查，排队（QPS/并发/429 退避）、代理 CONNECT、读客户端 body、非流式读体和流式中继都可能无限等待；客户端断开也只在中继阶段生效，排队与上游等待会泄漏。
- 代理 CONNECT 挂起（TCP 接受但不应答）此前没有任何超时，请求永久悬挂。

### Added

- `src/budget.js`：请求级预算与 AbortSignal 单一来源。`createBudget({overallMs, signal})` 提供 `deadlineAt`/`remaining()`/`expired()`/`abort(reason)`；`abortedError()` 统一取消/超时错误（status 504、`aborted=true`，上层据此跳过重试与熔断）；`sleepWith()` 为可取消退避。
- SSE 背压：`relayStream` 在 `res.write()` 返回 false 后暂停读取上游并等待 `drain`；等待超过 30s 或未写出缓冲超过 8MiB 立即中止并销毁客户端/上游，按 clientGone 记账（不计上游故障）。
- 契约与回归：`docs/contracts/request-lifecycle-v1.md`（AC-1..AC-7）；`scripts/test/offline/deadline.test.mjs` 13 用例覆盖满队列预算、代理 CONNECT 挂起、慢响应头、慢上游体、客户端断开的排队/等头/流式三种时序、流式预算耗尽、SSE 背压（确定性 fake client）与慢请求 body；`scripts/test/offline/harness.mjs` 新增 `startScriptedUpstream` / `startHangingProxy` 两个夹具导出。

### Changed

- **超时语义（行为变更）**：`defaults.timeout.overallMs>0` 现在是从请求进入网关起算的硬上限，覆盖读 body、全部排队等待、代理 CONNECT、等响应头、非流式读体、SSE 中继与续传，并把模型链 `loopMs` 钳制到剩余预算；每个阶段有效上限 = min(阶段配置, 剩余预算)。**流式阶段同样受该上限约束**。默认 0 保持旧行为（无全局上限），但客户端断开取消始终生效。
- 预算耗尽响应：响应头未发出 → `504 {error:{type:'request_timeout'}}`；已进入流式 → SSE `error`（`type=stream_interrupted`, `code=REQUEST_TIMEOUT`）+ `[DONE]`，已发出的状态码与内容不撤回。
- 排队取消：`acquireProvider`、模型并发信号量、QPS 令牌等待与退避 sleep 均可取消；waiter 从队列移除、已预留 QPS 令牌归还、`release()` 恰好一次；取消不记上游错误、不熔断。
- 探测/预热/回切探活与管理面请求不在本契约范围，行为不变。

### 验证

- `npm run check` 退出码 0；`npm test` 14/14 隔离套件（含 deadline 13 用例）通过；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件通过；`npm run docs:check` PASS；`node scripts/check-metadata.mjs` PASS (21)。
- 独立 review（只读，2026-11-09）发现 H1（`expired()` 把 `client_closed` 误判为预算耗尽）与 M1–M4，已修复并补测试：新增 `budget.timedOut()/cancelled()`、SSE 按 `timedOut()` 分支；客户端断开/写停滞不再计入上游中断与错误（M1）；QPS 令牌在取消且未发上游时归还（M2）；背压等待响应 `noEventMs` 看门狗（M3）；已完成流不判超时（M4）；另修 dispose 晚到 abort、唤醒后取消的下一位 waiter、写后缓冲复核、极早期断开。
- 二次复核（2026-11-09，只读）：H1/M1–M3 PASS；M4 的“已完成流仍可能被判超时”边界已修（`timedOut = budgetHit && !done`，forward 同时要求 `!relay.completed`，新增 AC-4e）。
- 未验证：真实上游与计费、生产 8787 重启、Windows/macOS、Node 18/20 实跑；长稳/并发压测未做。

## 2026-11-08 审计修复（未发布）

### Fixed

- 无全局客户端 Key 时，绑定 Key 的虚拟模型仍须鉴权；剥离管理/Google Key、客户端 Host 和动态逐跳头。
- 管理请求采用配置的 body 上限，超限保留响应 socket 返回 413；非法 Chat JSON 返回 400。
- 模型探测采用模型协议与 providerModels 覆盖名；配置保存先克隆 defaults。
- QPS 为并发等待请求预留额度，避免相同定时器同时放行突破限速。

### Added

- 管理 API v1 契约基线与离线回归：`scripts/test/offline/harness.mjs`（临时目录 + 动态端口 + 本地 mock 夹具）与 admin-contract / admin-secrets / admin-origin / config-schema / logger-secrets / lifecycle / wire-format 七套离线回归；契约正文见 `docs/contracts/management-api-v1.md`。
- 管理面来源策略配置项 `server.allowedHosts` / `server.allowedOrigins`（反代/自定义域名/跨源面板的唯一放行入口）。

### Changed

- **管理面来源策略（行为变更）**：Host 只接受 IP 字面量与 `localhost`/`server.host`/`allowedHosts` 中的名字，跨源 `Origin` 请求（含 `Origin: null`）在到达路由前 403；未配置管理令牌时管理接口仅允许本机对端，远程返回 403；数据面同样做 Host 校验并拒绝跨源写请求。用域名访问面板或跨源前端调用网关者需补白名单（见配置参考「管理面来源策略」）。
- 配置保存：形状与保留键校验收敛为单一入口，数组/字符串 body、`__proto__`/`constructor`/`prototype` 一律 400；新增删除墓碑 `_removed`，删掉的上游/模型重启后不再复活。
- 日志脱敏词表随配置热更新，代理 URL 内嵌凭据与通用 Bearer 兜底脱敏。
- `start()` 返回 `close()`：停定时器 → 排空连接 → 原子落盘；SIGTERM/SIGINT 优雅退出（退出码 0），损坏 stats 先备份 `.corrupt-<ts>` 再重建。
- 协议桥保真：Anthropic 并行 tool_result / Gemini 并行 functionResponse 合并、Gemini usage 与 finish_reason 映射、thought 摘要过滤、tool_choice 映射、空 tools 不再降级流式、SSE 末帧文本与 finish 同帧不再丢结束原因。
- CI：Node 18/20/22 手动矩阵（不下载 node，先探测 runner 自带），新增 `scripts/check-metadata.mjs`（21 项）与 MIT LICENSE，部署/回滚与兼容矩阵文档。
- 默认 npm test 仅运行隔离 mock 套件；27 个旧套件已全部迁移为自建隔离实例（OS 临时目录 + 动态回环端口 + 本地 mock），`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 即 27/27 文件、133 断言、无 SKIP；utils.mjs 删除「读改写目标配置」入口与 SKIP 语义。
- 修复 logger URL 凭据脱敏的 O(n²)：可回溯字符类改为线性扫描，128KB 单行 6.8s → 0ms、1MB 2ms。
- 现有模型状态字段、OpenCode 会话头/extraHeaders 改动纳入本轮核查；保留原有文档归档迁移。
- 新增 AI 接手入口、分层文档、审计记录、16 项后端任务及既有前端重建计划映射及 CI/文档链接检查。

## [Unreleased] —— 托盘小窗管理器 + 日志按天分文件与 7 天保留 + 交接问题修复批次

- **运维(2026-09-07)**:keys.local.json 明文 key 清空转环境变量解析(resolveKey source=env 实测:mimo-v2.5/glm-5.3-flash 200,gmi 到达上游仅账户余额不足);本机 master.key(自动生成的加密主密钥,keys 库空后无物可守)已删,后续写入 keys 时会按需重建;keys.local.json.enc-backup(Windows 加密旧备份)留存待用户定夺

### Fixed
- **OpenCode Go 接入使用过期路径/会话头且探测不带自定义头**：按 DSH 当前 `deepseek-v4.1-flash` provider 定义改用 `https://opencode.ai/inference/go/v1` 兼容路径并附加 `x-opencode-session`；ModelGate 将客户端的 `x-opencode-session` / `x-session-id` / `x-conversation-id` 或 body 会话 ID 映射到上游头。上游探测和模型探测现在也带 provider `extraHeaders`。同时支持 `defaults.reasoning` 让虚拟共用名在未指定档位时注入默认强度。
- **4xx 但语义是「上游出错」的响应被当客户端错误直接抛回，兜底链形同虚设（2026-09-18 生产实录）**：atria 短时故障返回 `422 {"error":{"message":"Inference request failed.","type":"atria_api_error","code":"upstream_error"}}`，`isModelLevelRejection` 只认 402/403/404 与「含模型/上游不可用语义的 400」，422 落到「真·请求错误」分支 → **原样抛给客户端、不切兜底链**，而 `defaults.directory` 上还排着 qwen3.8-flash / glm-5.3-flash 两个健康模型没用上，用户那一轮 turn 直接失败（ZCode: `reason=invalid_request status=422 retryable=false`）。与 402 属同类问题（0.5f99b4c 的修法同源）。现 `src/forward.js` 新增 `isUpstreamSideFailure()`：4xx（排除 401/402/403/404/429 各自的专道）+ 响应体显式含上游出错语义（`upstream_error` / `inference request failed` / `internal server error` / `service unavailable` / `overloaded` / `bad gateway` / `gateway timeout` / `请稍后重试` / `服务不可用`）→ 计为**真·失败**（进熔断计数，反复这么报的上游该被冷却）、保留原始响应、**继续目录链**；整链全败时回最后一个上游的原始 4xx（非 502）。
  - **刻意收窄防过宽**：识别不出该语义的 4xx 仍按客户端错误直接返回，不去空跑整条链——例如 atria 自己的 400 `invalid_request "max_tokens must be an integer between 1 and 65536."`（09-15 实录）是确定性参数错误，换模型一样失败。
  - 回归测试 `scripts/test/upstream-side-4xx.mjs`（7 断言，mock 上游 + 隔离实例）：上游侧故障继续链拿到 200 / 兜底被实际调用 / 计入失败统计 / 整链全败透传原始 422 / **对照组**确定性 400 直接返回且兜底未被调用。反向验证：临时关闭该判定后 ①组 4 项失败（客户端重现拿到 422），恢复后 7/7。
- **测试套件每跑一次就把 live 配置的模型字段洗一遍（2026-09-18 排查发现，2026-09-17 22:56 实锤）**：`scripts/test/utils.mjs` 的 `snapshot()` 把每个模型压成 `{ provider, alias, fallbacks, maxConcurrent }` 四个字段，而 `saveConfig` 对 `body.models` 是**整体替换**（`body.models !== undefined ? body.models : cur.models`）——于是任何走「读-改-写」的测试（affinity / circuit / concurrency / empty-model / modelstats / payment-402 / qps / rate429 / stream-* / z-defaults-merge …）每跑一次都把 live 配置洗一遍：`reasoning` / `effortFormat` / `effortOptions` / `api` / `providerModels` / `maxTokensMax` / `qps` / `dailyQuota` / `quota` / `maxContext` / `probe` 全被清空（实测 6 个模型全中；配置文件 mtime 与跑测时刻逐秒吻合）。**后果最重的一例**：`union-alpha` 的 `providerModels: {openrouter: "stealth/union-alpha"}` 被洗掉后，网关改发 `union-alpha` 给 OpenRouter → 404 `No endpoints found for union-alpha`，把「模型已下线」的真实原因也盖住了（slug 修回后才拿到上游的真话：stealth 期结束、改用 `unbiased/pareto`）。现 `snapshot()` 改为**黑名单式逐字段回写**（仅剔除运行时统计字段 `name/requests/errors/tokens/today/hitRate/affinity/avgMs` 与 provider 的 `id/hasKey/keySource/st`），将来新增配置字段无需再改白名单。往返验证：修正后 `save(snapshot())` 前后 models 快照逐字节一致；全量跑测后 live 配置字段完好。
- **`/api/status` 对 models 已暴露全部配置字段**（`api`/`providerModels`/`effortFormat`/`effortOptions`/`reasoning`/`maxTokensMax`/`qps`/额度/上下文/`probe`/`forceNoStream`），是本次快照能做到无损回写的前提——与 0.2.2 对 `defaults` 的修法（原样返回）同源。
- **未知请求字段 `reasoning.effort`（客户端违约 + 网关零归一化，2026-09-17 生产实录 20 次）**：ZCode CLI 按 OpenRouter 惯例发**嵌套** `reasoning:{effort}`；网关此前既无入站字段归一化、也无出站白名单，未知字段一律原样透传——而 OpenRouter 认得该字段，所以打主上游的 685 次请求全部 200、把问题完全掩盖；一旦主上游 429/熔断、目录链兜底到**严格上游**（jiyuan/tokenrhythm，LiteLLM 内核按白名单校验字段）就 400 `{"code":"UNKNOWN_FIELD","message":"未知请求字段：reasoning.effort"}`。症状是「平时不报、只在兜底时炸」，且网关日志只记上游返回体、不记出站体，归因极难。现 `src/forward.js` 新增 `normalizeEffortInput()`：入站把 `reasoning.effort` 并入平面 `reasoning_effort`（客户端已显式给出平面字段时以平面字段为准），嵌套 `reasoning` 对象**一律剔除**（含 `summary`——OpenAI chat 协议无该字段位置，且它正是严格上游的拒绝点），"关闭思考"的同义拼写（`off`/`disabled`/`false`）统一归一到 **`none`**（`canonEffort`；白名单比较两侧同源归一，本地 `effortOptions` 里惯写的 `off` 与 `none` 视为同档）。归一事件落 `[warn] 思考强度入站归一化` 日志留痕。
  - **纠错（同日 23:19）**：首版把规范拼写成 `off`，结果 openrouter 回 400 `reasoning_effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"`——该词表里**没有 `off`、只有 `none`**。规范拼写改回 `none`；`THINKING_TYPE_MAP` 补 `none → disabled`（thinking 形态不受影响）。回归用例的 mock 上游**补上取值词表校验**（此前只校验"有没有嵌套 reasoning 键"，测不出"归一成上游不认的拼写"这类回归）：把方向改回 `off` 实测 5 项失败，改回 `none` 全绿。
- **潜伏项：思考强度字段形态只按链首模型决定，兜底换模型即形态错配（P1 实测项）**：`body` 是各路由共享的，此前在入口按「请求模型 / 链首模型」的 effortFormat 转换一次就定死——链首 `reasoning_effort`、兜底 `thinking`（`union-alpha → qwen3.8-flash`）时后者拿不到自己认的字段；反向（链首 thinking、兜底 reasoning_effort）则多送一个它不认的对象。当时未爆是因为平面 `reasoning_effort` 恰好被 openrouter / jiyuan 双方接受（直连实测两个上游对 qwen3.8-flash 均 200），属"配置没生效也不报错"的静默错配。现**字段形态下沉到每条路由**按目标模型自身 `effortFormat` 整形（取值不变：客户端显式档位 > 入口默认档位；两字段互斥，不共存于同一 body）。既有语义保持：虚拟模型 / 虚拟共用名入口仍"客户端没给档位就不注入"，真实模型入口仍注入配置默认档位。
- 回归测试 `scripts/test/effort-normalize.mjs`（18 断言，自包含 mock 上游 + 隔离实例）：嵌套归一为平面且出站无 `reasoning` 键、平面优先、仅 summary 剔除、三种关闭拼写归一、双向跨 effortFormat 兜底形态正确、虚拟入口不注入 / 真实入口注入 / 白名单本地拦截 / 客户端显式优先。
- **opencodego provider 注入 `x-session-id`（Linux 迁移后 zen/go 上游 400 MissingSessionID）**：opencode zen/go 上游对无会话头的 chat/completions 一律 400 `{type: MissingSessionID}`（Windows 时代直连也如此，dsh 走 /responses 不受影响；ownrag KB 网关经网关的 gatemodel 通道则必挂）。在 `gateway.local.json` providers.opencodego.extraHeaders 注入静态 `x-session-id: mg-opencodego-bridge`（buildHeaders 对 extraHeaders 的合并优先于客户端头，forward.js:45-46；静态会话仅影响上游按会话的路由亲和）。configVersion 112→113，重启生效；直连网关 mimo-v2.5 chat/completions 实测 200。备份 `gateway.local.json.bak-20260907-*`。


### Added
- **apiKeyEnv 用户级环境变量实时读取（绕过进程快照）**：进程 env 是启动时的副本——用户在系统里新增的 API key 变量（如 `BAI_API_KEY`）对已运行网关不可见，此前必须重启网关才能生效，且须连托盘一起重启（拉活的网关继承托盘旧环境）。现 `resolveKey` 在进程环境找不到时 fallback **实时查注册表 `HKCU\Environment`**（带 60s TTL 缓存：spawnSync 有毫秒级开销且在每请求路径上；正负值都缓存防高频空查；变量名白名单校验防注入），改完变量**最多 ~60s 生效**，无需重启任何东西。仅 Windows 生效（其他平台维持进程环境行为）。回归测试 `scripts/test/user-env-fallback.mjs`（注册表写入临时变量 → 进程环境无此变量 → 请求验证 Authorization 取到注册表值 → 自动清理）。
- **mg-tray 托盘小窗管理器**（`scripts/tray/mg-tray.cs`，Windows 自带 .NET Framework csc 编译为 ~24KB `mg-tray.exe`，零第三方依赖）：无边框置顶悬浮小窗（状态/uptime/今日 token/请求错误 + 启动/停止/重启/面板/日志按钮，可拖动、右键切置顶、✕ 缩托盘）+ 托盘常驻（双击唤出、菜单全套操作、崩溃 5s 退避自动拉活、连续快速失败 ≥5 次熔断）+「开机自启」开关（HKCU Run 键，免管理员）+ 启动前清端口残留 node（同 start.bat 语义，只杀 node.exe）；检测到端口已有 node 实例显示「外部实例/未接管」不重复拉起；数据面轮询 `/healthz` + `/api/status`（401 自动降级）。
- `scripts/tray/build.cmd`：一键编译（系统自带 csc.exe；ASCII-only 规避批处理 GBK 解析坑）。
- `scripts/test/z-defaults-merge.mjs`：defaults 合并保存契约回归（完整/面板式/无键/显式覆盖，7 断言）。
- `scripts/test/z2-noevent.mjs`：半死流看门狗回归（纯注释心跳流判死并回错误事件；注释+data 交替的健康流不误杀）。
- **悬浮窗四卡改版**（`8b32f36`）：右列三卡扩为四卡（上游/模型/词元/价格），卡内文字 10pt→8.5pt；**价格卡=当日全部使用模型的计费**——每 30s 读 `stats.json` 按模型日桶（in/hit/miss/out）× 上游实付价（`effective_pricing`，与平台账单一致；无折扣回落标价）按币种汇总（¥人民币/$美元，多币种 + 间隔），只计价表内模型（天然排除 VM 入口双计与无价上游）；每 10min 拉上游 `/v1/models` 价表（直连失败走 Clash 代理重试）。
- **托盘诊断文件**：每轮覆盖写 `logs/tray-debug.txt`（价表条目数/计费模型/cny/usd/BillText/最近异常），托盘问题无需截图即可核查。
- `scripts/tray/swap.cmd`：托盘换装脚本（杀托盘→`mg-tray.new.exe`→`mg-tray.exe`→启动；托盘重启会短暂重启其守护的网关）。

### Fixed
- **面板 Key 徽标与真实能力不同步（环境变量已生效仍显示「设 Key」）**：`/api/status` 的 `hasKey` 判定独立只查 `process.env`，未走 `resolveKey` 的注册表 fallback——环境变量修复后面板仍显示「设 Key」，而转发/探活实际已取到 key（用户截图：探活「通 122ms」但徽标「设 Key」，误判未生效）。现 `buildStatus` 改用 `resolveKey` 同源判定（keys 存储 → 进程环境 → 注册表实时读取），面板徽标文案新增「环境·注册表」区分来源。
- **baseUrl 带 `/v1` 结尾时 URL 双拼 404**：`request.js` 拼 URL 为 `baseUrl + pathPrefix + /v1/chat/completions`，而大量 OpenAI 兼容服务的文档示例 baseUrl 自带 `/v1`（如 `https://kuaipao.pro/v1`）——照抄即拼出 `/v1/v1/chat/completions` 上游 404（生产 09-04 实录：kuaipaoai 全部请求 404 后被目录链切走，用户以为 key 未生效）。新增 `upstreamUrl()` 规范化：baseUrl 尾斜杠归一；base 以 `/v1` 结尾且 path 又以 `/v1/` 开头时去掉 base 的版本段。5 处拼接点（forward/probe/probeModel/探活）统一走该函数。
- **今日计费恒为 ¥0.00**：模型日桶按「下一个引号键」切块时日期键同样命中模型键正则，块被截空 → 今日桶永远找不到；且金额公式漏 ÷1e6（修复后会显示约 ¥1976 万）。改为括号配平截取 `daily` 段 + 按模型分块扫描。
- **回答（content）已回传后断流不再硬中断——新增 `streamInterruptOnContent` 策略**：上游在正式回答已回传后断流（续传 2 次失败），此前一律报错收尾。现支持两种策略：默认（`streamInterruptOnContent: false`）保持报错收尾（客户端干净重试）；开启后**同样切下一上游/模型**——客户端会收到「半截旧回答 + 新回答」拼接（已发出的字节无法撤回，接受重复呈现）。配套改动：`relayStream` 中断时**不再自动 end 客户端连接**（切/不切由模型链循环决定，切则下一上游的流继续写同一连接，不切则调 `endInterruptedStream` 发错误事件收尾）；流已开始后的全链失败以流内错误事件收尾（不再尝试写 json 状态码）；`streamRelay` 二次写入跳过响应头（`headersSent` 防护）。测试 `stream-failover.mjs` 扩展至 5 场景 10 断言：未回传断流切上游/切模型、已回传断流按配置切（拼接证据 half-+ok-B）、配置关时错误事件收尾不切。
- **窗控按钮只显示空心圆**：萝莉体 9.5pt 下「—」「×」笔画仅 10×1px 发丝线（叠加 Opacity 0.8 不可见）——改矢量线绘制（`Pen` 圆头线帽，悬停转红不变），字体无关。
- **托盘单实例互斥偶发失效**：`Mutex` 局部变量无根引用被 GC 回收——改静态根引用持有；互斥/唤起事件名按 exe 目录哈希派生（多实例部署互不干扰）。
- **流式「头 2xx + 立刻断流」不切下一上游/模型（根因修复）**：上游返回 2xx/event-stream 后一个 token 都没回传就断流时，此前 `forward.js` 一旦拿到流式响应即 `return` 交付中继，模型链循环终止——断流只走同上游续传，永不尝试备用上游/下一模型（上游故障形态从「响应头失败」转为「流式中断」后，切模型机制形同虚设）。现：`sse.js` relayStream 返回流结局（`completed`/`contentSent`）；`forward.js` 在模型链循环内等待 relay 结局——**未回传任何内容的中断视为该上游失败（计入熔断），继续模型链切下一上游/模型**；已回传内容仍维持「不可重发、按中断结束」语义。新增 `scripts/test/stream-failover.mjs` 模拟「2xx + 0 token 断流」验证同模型切备用、跨模型切目录下一模型。

### Changed
- **日志按天分文件 + 7 天保留**：`logs/gateway.log` 改为落盘 `logs/gateway-YYYY-MM-DD.log`（配置 `logFile` 仅指定前缀/目录），启动/跨天清理 7 天前旧文件（含 `.old` 轮转件；历史无日期旧版按 mtime 判断）；单文件超 5MB 轮转 `.old`；`/api/logs` 改读当前天文件（logger 暴露 `file()`）；`start.bat` 前台调试用法不变。
- **defaults 合并保存（交接问题 2 根治）**：`saveConfig` 此前把 `body.defaults` 整体替换现有配置，而面板只回传 9 个白名单字段——面板每次保存都会冲掉 `affinityTtlMs`/`failbackProbe` 等自定义字段（生产 configVersion 78→89 实录丢失）。现改为合并：提交的字段覆盖、未回传字段保留；面板 `extraHeaders` 从 status 回写。代价：字段无法经保存接口删除（需要时直接编辑 gateway.local.json）。

### Fixed
- **SSE 流中断计入熔断（交接问题 1）**：流式响应此前在响应头 2xx 阶段即 `markOk` 并记亲和，「头 2xx + 流中断」的故障上游被间歇性成功反复洗白，熔断计数永远攒不齐——生产 08-29 15:00-15:10 UTC 七请求钉死 jiyuan、备用零接管即此。现 markOk/亲和延后到流完整结束，流中断按上游失败同口径 `markFail`（客户端主动断开不计）；回切探活改 `stream:true` 按首条 SSE 数据判定恢复；续传重连校验必须 event-stream。
- **半死流事件级看门狗**：字节级 idle 只认「上游没字节」——上游用 SSE 注释/垃圾字节续命却从不发 `data` 事件时，字节计时被反复喂活、网关 keepalive 注释又喂活客户端空闲检测，客户端既无内容也无错误地无限悬挂（生产 08-30 09:43-09:48 实录，悬挂 3 分多钟后客户端自行放弃）。新增事件级看门狗（默认 2×idleMs）：收到含 `data:` 的完整事件才重置，超时判死走续传/报错，客户端最终收到 `stream_interrupted` 错误事件。
- **判死定时器改「掐流+带内续传」**：idle/看门狗定时器此前直接 fire-and-forget 调 `resume`，续传链脱离 await 链——顶层 `pump(firstUpstream)` 可能永不返回（onEnd 不触发、成败记账丢失），旧泵 iterator 复活还会与新泵双写客户端。现定时器只判死+掐流，由被掐断的泵在 catch 里带内续传；引入泵代数（gen），被换掉的旧泵醒来即静默退场。
- **流式中断终态落日志**：`finalize` 此前只对客户端发错误事件、日志无痕；现记录终态（含「客户端已断开，未发送错误事件」分支），事后可查。
- **连续断流上游「一断流就永久出局」（半开恢复）**：`streamDrops >= 3` 后该上游被绕开，但绕开时还会再 `markFail`（熔断被反复续期），而 `streamDrops` 只在流完整结束时归零——被绕开的上游永远拿不到流量，永远无法自证恢复，整条兜底链退化成单点（生产 09-01 实录：jiyuan 504 抽风期 113 次重试、13 次 400 全部卡在「opencodego 早已被钉死」）。现改为：绕开仅限冷却期（`defaults.streamDropCooldownMs`，默认 60s）内，到点放行一次半开探测——成功即解除（归零），再断流则重新计时；绕开时不再 `markFail`；非流式请求完整成功同样解除绕开。回归测试 `scripts/test/stream-drop-halfopen.mjs`（绕开仍生效 + 冷却后复活）。
- **流已开始后上游 4xx 二次写响应头崩溃**：首个上游流式响应头已发给客户端后，模型链切到的下一上游若返回非流式 4xx，`forward.js` 直接 `return json` → `index.js` 二次 `writeHead` 抛 "Cannot write headers after they are sent to the client"，客户端只拿到没有 `[DONE]` 的半截流（生产 09-01 日志 7 次实录）。现：流已开始后的 3xx/4xx 按上游失败继续切下一上游（4xx 为确定性拒绝，不计入可重试，轮末即收尾），全链失败以流内 `stream_interrupted` 错误事件 + `[DONE]` 收尾；`index.js` json 回写处加 `headersSent` 防御兜底。回归测试 `scripts/test/stream-started-4xx.mjs`。
- **上游「模型不可用」400 被当业务错误直接抛给客户端，目录链中断**：opencodego 等上游对「模型不可用」也返回 400（`Provider rejected the model request` / `Model not supported`，生产 09-03 08:13-08:21 UTC 实录：jiyuan 504 故障期目录链切到 opencodego 后 400 直接透传，zcode 断连、未继续尝试 MiniMax）。此前仅 403/404 视为模型级拒绝继续目录链，400 一律按「业务 4xx」直接返回。现新增 `isModelLevelRejection()`：403/404 恒真，400 需响应体含「模型/上游不可用」语义（reject/not support/disabled/MODEL_DISABLED/模型已关闭等）——这类**换下一模型可能成功，继续目录链**；真·参数错误 400（messages 格式/字段非法等）不误伤，仍直接返回保留原始错误。顺带：所有 4xx 现在把响应体前 300 字符写入日志（此前只记 status，排查 400 需靠直测猜 body）。回归测试 `scripts/test/model-reject-failover.mjs`（模型级拒绝切备用 + 参数错误不切不浪费）。

## [0.2.3] · 2026-08-29 —— 测试套件修正与文档口径同步

### Fixed
- **`rate429.mjs` 断言过时**：0.2.0 循环兜底后 429 排队对客户端透明——首请求在网关内按 `Retry-After` 等待并重发上游，最终 200；旧断言仍期待「首请求 502/429 + 次请求排队」的 0.2.0 前语义。现改为：首请求内部排队（耗时 ≥ Retry-After、上游恰 2 次命中）后成功，次请求冷却已过不再等待。
- **`acl.mjs` 崩溃修复**：`st` 是已解析的 status 对象却被当函数调用（`(await st())` → TypeError），deepseek-official 存在时整个文件 ERROR——改为重新拉取 status 并对字段缺失败的容错取值。
- **测试子结果计数隔离**：`results` 为套件级共享数组，virtual-models 结尾的子结果统计会把其它文件的失败算进自己头上误报 ERROR——改为按进入时基线取增量。
- **SSE 续传用尽时给客户端明确交代**：流式中断、续传 2 次仍失败时，`finalize` 此前只发 `[DONE]`（正常结束标记）——zcode 等 OpenAI 兼容客户端把「无输出的 [DONE]」当对话正常结束，直接静默收场，用户无感知。现先发 OpenAI 兼容**错误事件**（`type: "stream_interrupted"`）再发 `[DONE]` 收尾，客户端可据此显示错误提示而非静默。8/25 的 `16f770a` 只修了「续传被 end 掐断」，续传用尽后的客户端信号一直是缺失的——本次补齐。

### Changed
- README/CHANGELOG 口径同步：探活超时实为 `defaults.timeout.connectMs`（模板 15s，并非固定 10s）；分层超时表更新（转发建连阶段对齐 firstByteMs，connectMs 仅用于预热/探活）；0.2.1 补记同窗口的 TD1 测试沉淀 / TD2+TD3 重构条目。
- `package.json` 版本同步 0.2.3（此前长期停留在 0.1.0）。

## [0.2.2] · 2026-08-29 —— 主上游回切探活 + 缓存亲和有效期

### Added
- **主上游回切探活 `defaults.failbackProbe`**（默认开启 `{ everyMs: 30000, successStreak: 2, system: "ping" }`，仅降级中工作）：某模型当前由**备用上游**（`fallbacks`）服务时，按 `everyMs` 向主上游发最小探活请求（真实 chat、`max_tokens:1`、**不计额度**、超时取 `defaults.timeout.connectMs`），连续 `successStreak` 次成功后清除缓存亲和，下一个请求即回到主上游。解决「主上游恢复后无法及时回流」——此前只能等亲和过期、并靠下一个真实请求去试水（试水请求可能卡满整轮重试）。回切前**已验证可用**，真实请求不会踩到"刚恢复又挂"的雷；正常态（用主上游时）零开销、不发探活；主上游熔断中时跳过探活（交给熔断半开，避免打架）。
  - 探活**刻意不用** `/v1/models`：聚合平台常见「models 通、chat 挂」（平台健康、推理层过载），用 models 探活会误判为已恢复。
- **缓存亲和有效期 `defaults.affinityTtlMs`**（默认 `300000`，0 = 不过期）：请求成功后记住该模型最近一次成功用的上游并优先复用（保持厂商 prefix cache、降碎片化），超时应期后亲和失效、请求回到配置里的主上游，TTL 内不抖动。与回切探活互补——探活是主动回切（30s 粒度、验证后切），TTL 是被动兜底。
- 测试 `scripts/test/affinity.mjs`（亲和有效期 4 项）、`scripts/test/failback.mjs`（回切探活 4 项；把 `affinityTtlMs` 设为 1 小时以排除 TTL 干扰，确保验证的是探活本身）。

### Fixed
- **自定义 `defaults` 字段在任意一次配置保存后被静默丢弃**（如本次新增的 `affinityTtlMs`/`failbackProbe`，以及未来的任何扩展字段）：根因是 `/api/status` 只返回白名单内的 defaults 字段，面板/测试走「读-改-写」时未返回的字段被覆盖。现 `buildStatus` 的 `defaults` 改为**原样返回**（仅 `clientKey` 掩码）——一次修复覆盖所有自定义字段，无需再逐字段加白名单。
- **`/api/status` 不暴露 provider 的 `circuit`**：此前面板/测试保存配置会把手动配的熔断参数清成 `null`（同类问题）。现已暴露并在测试 `snapshot()` 中原样带回，熔断配置不再被吃掉。
- **回切探活请求格式修复**：探活此前复用 `warm()` 的 system-only 消息，被 LiteLLM 类网关（如 tokenrhythm/jiyuan）以 400 拒绝（`LITELLM_ERROR: messages 参数非法`）——探活从未成功，回切只能依赖亲和 TTL 兜底，且失败日志误报为 `preheat status`。新增 `probeChat()`（**user 角色**消息 + 独立 `failback probe` 日志文案），探活恢复工作，日志不再误导。
- **回切探活动作修复（清除亲和 → 亲和置为主上游）**：探活成功时此前仅 `delete affinity`，但无亲和时路由**退化为按缓存命中率排序**——缓存热的备用上游（opencodego）会把主上游（jiyuan）挤到后面，请求继续走备用（生产日志：3 次「主上游已恢复」后请求仍在 opencodego）。现探活成功直接把 `affinity` 置为主上游，利用现有亲和机制让主上游必然排第一，且探活自动停止（`cur === primary`）形成闭环。测试同步注入缓存命中率差异（备用 100% 命中、主 0%），复现「命中率路由反超」场景——原测试 cacheStat 为空会碰巧切回，掩盖该缺陷。

## [0.2.1] · 2026-08-27 —— 上游代理（proxy）面板化收尾

### Added
- **面板「网络代理」输入项**（「默认上游」卡）：`defaults.proxy` 全局代理可在面板配置（留空=直连，形如 `http://user:pass@127.0.0.1:7890`），保存即持久化——修复此前「面板一保存 `defaults.proxy` 即被丢弃、网关连不上 Clash」的反复现象。
- **`/api/status` 回显 `defaults.proxy`**：面板可读到当前代理配置。
- **保存校验**：`defaults.proxy` 非空时必须为合法 http(s) 代理地址，非法值 400 拦截（防垃圾值落到转发层）。
- **代理模式 `proxyMode`**（`auto` 默认 / `direct` / `global`，面板「代理模式」下拉）：auto=按配置（provider 级 > 全局 > 环境变量，显式关闭生效）；direct=全部上游强制直连；global=非回环上游全部强制走全局代理（回环豁免）。保存即热生效，不重启。
- **按上游代理名单**（面板「上游服务」编辑弹窗新增「代理」字段）：单上游 `proxy` 留空=继承全局；填 `http(s)://...`=强制走该代理；填 `direct`=强制直连（替代原 `""` 语义，空串现改为继承全局）。`/api/status` 回显 provider 级 proxy；保存校验（非法地址 400）。
- **思考强度参数格式可选 `effortFormat`**（面板模型弹窗「思考强度·参数格式」下拉）：`reasoning_effort`（默认，OpenAI 风格）/ `thinking`（MiniMax 风格对象）。客户端入口统一 `reasoning_effort`，网关按模型配置转换注入（thinking 格式转 `thinking:{"type":...}` 并删除 reasoning_effort）；虚拟共用名/虚拟模型入口透传链首真实模型格式。解决「MiniMax-M3 填 adaptive 不生效」——其官方认 `thinking` 对象而非 `reasoning_effort`。
- **Phase 1 验证矩阵沉淀为常驻 mock 集成测试**（`scripts/test/virtual-models.mjs`，18 项断言）：自起隔离实例 + mock 上游，零外部依赖、零真实上游消耗，纳入 `npm test`。

### Fixed
- 上游代理特性完整接通（代码 + 配置持久化 + 面板置项三件套齐备）：`src/router.js` 的 proxy 解析（provider 级 > defaults > 环境变量，回环直连）、`src/request.js` 的 CONNECT 隧道（零依赖）此前为半成品，仅实现了转发层读取；本次补齐 `saveConfig` 持久化与面板配置入口，消除「改配置生效、面板保存丢失」的分裂。
- **兜底被 403/404 截断**：此前目录链中某模型返回 403/404 会直接中断整个请求（不试后续模型），导致「MiniMax-M3 限流 429 → muse-spark 被 opencode 403 拒绝 → mimo-v2.5 根本没机会」——现改为 403/404（模型/资源级拒绝）记录后继续尝试下一模型；整条链都被拒绝时回最后一个上游原始响应（保留真实错误）且不进入循环兜底空转。400/401/422 等请求/鉴权类错误仍直接返回不兜底。
- **曲线 tooltip 显示 缓存命中/未命中/输出**：统计新增输入（inTokens）与输出（outTokens）单独记账（`usage.prompt_tokens`/`completion_tokens`，流式末帧无明细则记 0 不臆造），daily/hourly 桶与 byModel 持久化扩展；`/api/model-stats` 每个数据点返回 `inTokens/outTokens/hit/miss`；曲线图 tooltip 在模型名下方显示「缓存命中 · 未命中 · 输出」三个具体数字（命中+未命中=输入，满足恒等式）。模型统计面板不加字段。
- **分层超时语义修正**：响应头到达后由 connect 静默检测转 idleMs 空闲检测，建连阶段静默上限对齐 firstByteMs——思考型上游首 token 前长静默不再被更短的 connect 定时器误杀（mock 三场景验证）。

### Changed
- **forwardChain 域拆分至 `src/forward.js`**（deps 注入共享辅助，`todayKey` 入 `shared.js`），index.js 963→672 行；stats 历史保留窗口 90 天（daily/hourly 落盘时清理超窗键，防 stats.json 无界膨胀）。

## [0.2.0] · 2026-08-25 —— 韧性加固 + Phase 1 多虚拟模型

### Added
- **多虚拟模型（Phase 1 核心）**：`virtualModels[]` 配置，每个虚拟模型自带目录快照与独立 Key（`__mg_vm_*`，AES-GCM 加密存储）；`/v1/models` 聚合虚拟模型名；响应 model 名回写为入口名。
- **两阶段数据面鉴权**：全局 clientKey 一阶段放行（常规路径零开销）；失败且配置虚拟模型时按 `model` 逐 `__mg_vm_*` Key 常量时间校验（支持 `expiresAt` 过期）；统一 401 文案防虚拟模型名枚举；全局 Key 为管理员级超级 Key。
- **并发写安全地基**：`configVersion` 单调递增持久化，过期保存返回 409（缺 version 的旧客户端宽容放行）；`saveConfig`/`saveKeys` 写盘互斥队列；keys 写路径改为盘上重读合并，消除「复活已删 key」窗口。
- **可选 `MG_CONFIG_DIR`**：多实例隔离（开发/生产 keys·stats·local 独立成套），未设置时行为与旧版完全一致。
- **面板虚拟模型管理器**：右列折叠列表（名字/Key 徽章/过期标记/目录摘要）+ 展开编辑器（目录增删排序、独立 Key、过期时间、备注、额度/并发/QPS 五项、🔍 路由试算弹窗）。
- **路由试算端点** `POST /api/route-preview`：返回将命中的虚拟模型、目录链、上游序列与额度状态。
- **虚拟模型入口治理**：未知名返回 404（不再静默走默认链，防 Key 隔离被无感绕过）；入口总额度（quota/dailyQuota，独立账本）超限 429；maxContext 入口约束；链首真实模型 `effortOptions` 补本地校验（参数 400 先于额度 429）。
- **循环兜底**：整条目录链 a→b→c 一轮全败后回队首有界重试（`loopMs` 默认 120s），成功/失败均带 `chain=` 链标记日志。
- **SSE 下游截断加固**：客户端断开主动销毁上游流（杜绝连接泄漏）；续传链完整等待（修复「对话直接中断」）。
- **文档体系**：分阶段执行计划（Phase 1-3 + 技术债清理）、项目上下文交接文档、Phase 1 详细实施计划（含连锁风险分析）、CHANGELOG。

### Fixed
- 曲线图两轮修复：隐藏面板首绘固化错误位图（隐藏态守卫 + 切视图/resize 重绘）；数据接口误用未赋值的 `window.TOKEN` 致 401 空白（改用登录令牌）。
- 模型探针超时 30s→90s：思考型模型响应 5s~90s+ 波动不再误报 ETIMEDOUT。
- 非流式响应日志 `serving` 字段显示入口名（缺字段），修正为实际服务模型。
- 虚拟模型编辑器轮询闪烁：3s 轮询重绘导致独立 Key 输入丢字——编辑中跳过重绘 + Key 输入草稿恢复。
- 不稳定上游下的兜底健壮性（503 重试、坏 gzip、慢上游不饿死兜底、流中断计数绕开）。

### Changed
- 面板 KPI 大卡改读持久化口径（消除重启后与全局统计的数字分裂）；模型配置页改纵向滚动（卡片不再被固定高度挤压）。
- 「默认上游」卡：客户端 Key 与虚拟共用模型名位置交换。

## [0.1.1] · 2026-08-24 —— 面板与统计完善（初始化日迭代）

### Added
- 缓存降碎片化体系：会话/上游亲和、命中率路由、主动预热、命中率趋势告警。
- 按对话统计（会话 ID 优先 / 5 分钟兜底切分）、模型级平均延迟、p50/p95。
- 面板：管理令牌门禁（登录卡片 + 实例记忆）、上游/模型单测与统测、模型目录模板（保存/应用/删除）、批量测试。
- 健壮启动：`start.bat` 自动清理占用 8787 的残留进程；请求级日志（含 serving/provider）。
- 数据面 Chat 入口路径别名：Base URL 不带 `/v1` 也能接入。

### Fixed
- 缓存命中率恒 100% 的统计错误（按协议官方字段精确分桶）。
- 虚拟共用模型名透传上游导致 `Model not supported`（改走默认目录真实模型）。
- `start.bat` 行尾 CRLF + 去 BOM（恢复双击运行）。
- 曲线图按实际显示尺寸与 DPR 初始化（修复拉伸与 tooltip 错位）。
- dialogue 持久化、全局/provider 计数持久化（重启不归零）、面板输入不再被自动保存/轮询重绘打断、模型单测后延迟标记消失、测试套件错误隔离（不再整次硬崩溃）。

## [0.1.0] · 2026-08-24 —— 项目初始化

- 本地 OpenAI 兼容 API 网关首版：Node 原生 http 零依赖，Chat 转发 + 分层超时（connect/firstByte/idle/overall）+ 指数退避重试 + 熔断 + 每上游并发/QPS 限制 + SSE 断流续传 + 三协议互转（OpenAI ⇄ Anthropic ⇄ Gemini）+ AES-GCM Key 加密存储 + 赛璐璐风格控制面板。
