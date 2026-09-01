# Changelog

本项目所有显著变更记录于此。格式参考 Keep a Changelog；版本号随发布推进（`package.json` 已随 0.2.3 同步）。

## [Unreleased] —— 托盘小窗管理器 + 日志按天分文件与 7 天保留 + 交接问题修复批次

### Added
- **mg-tray 托盘小窗管理器**（`scripts/tray/mg-tray.cs`，Windows 自带 .NET Framework csc 编译为 ~24KB `mg-tray.exe`，零第三方依赖）：无边框置顶悬浮小窗（状态/uptime/今日 token/请求错误 + 启动/停止/重启/面板/日志按钮，可拖动、右键切置顶、✕ 缩托盘）+ 托盘常驻（双击唤出、菜单全套操作、崩溃 5s 退避自动拉活、连续快速失败 ≥5 次熔断）+「开机自启」开关（HKCU Run 键，免管理员）+ 启动前清端口残留 node（同 start.bat 语义，只杀 node.exe）；检测到端口已有 node 实例显示「外部实例/未接管」不重复拉起；数据面轮询 `/healthz` + `/api/status`（401 自动降级）。
- `scripts/tray/build.cmd`：一键编译（系统自带 csc.exe；ASCII-only 规避批处理 GBK 解析坑）。
- `scripts/test/z-defaults-merge.mjs`：defaults 合并保存契约回归（完整/面板式/无键/显式覆盖，7 断言）。
- `scripts/test/z2-noevent.mjs`：半死流看门狗回归（纯注释心跳流判死并回错误事件；注释+data 交替的健康流不误杀）。
- **悬浮窗四卡改版**（`8b32f36`）：右列三卡扩为四卡（上游/模型/词元/价格），卡内文字 10pt→8.5pt；**价格卡=当日全部使用模型的计费**——每 30s 读 `stats.json` 按模型日桶（in/hit/miss/out）× 上游实付价（`effective_pricing`，与平台账单一致；无折扣回落标价）按币种汇总（¥人民币/$美元，多币种 + 间隔），只计价表内模型（天然排除 VM 入口双计与无价上游）；每 10min 拉上游 `/v1/models` 价表（直连失败走 Clash 代理重试）。
- **托盘诊断文件**：每轮覆盖写 `logs/tray-debug.txt`（价表条目数/计费模型/cny/usd/BillText/最近异常），托盘问题无需截图即可核查。
- `scripts/tray/swap.cmd`：托盘换装脚本（杀托盘→`mg-tray.new.exe`→`mg-tray.exe`→启动；托盘重启会短暂重启其守护的网关）。

### Fixed
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
