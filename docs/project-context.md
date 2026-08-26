# model-gateway · 项目交接 / 上下文速览

> 供下一次会话的 AI 快速掌握项目全貌、红线与未完成事项。请先读本文件，再动代码。
> 位置：`E:\ai\workplace\idproject\model-gateway`（2026-08-27 确认；旧文档曾写 `E:\ai\aiwork\working\model-gateway`，已迁移）

---

## 1. 项目是什么

**本地模型网关（Node.js 原生 http，零第三方依赖）**。位于 `/v1/*`，把上游多家 LLM 组合成一个 OpenAI 兼容入口，给 agent 用。核心能力：

- **数据面**：Chat 转发（`/v1/chat/completions`、`/chat/completions` 别名）。
- **虚拟共享模型**：客户端用固定 Key 调「虚拟共用模型名」（如 `gatemodel`），网关按默认目录注入真实模型并回写响应 model 名。
- **跨模型兜底**：一条链 a→b→c 失败自动切下一个，并支持**有界循环兜底**（回到队首重试）。
- **统计/趋势/缓存命中**、**代码面板 CRUD**、**keys 加密存储**、**上游熔断/亲和/预热/命中率路由**。

## 2. 运行方式（红线 1：行尾）

- 入口：**双击 `start.bat`**（前台，关窗即停；自带清理残留 8787 进程）。
- **`.bat/.cmd` 必须 CRLF + 无 BOM**，否则 cmd 直接解析失败（`找不到盘符`/闪退）。之前多次踩坑。
- 生产监听 `127.0.0.1:8787`。

## 3. 目录结构

```
config/gateway.json        # 模板（无敏感值），含 defaults/providers/models
config/gateway.local.json  # 真实配置（gitignore，不入库）
config/keys.local.json     # 加密 keys 库（gitignore，永不明文）
config/stats.json          # 统计持久化（gitignore）
logs/gateway.log           # 运行日志（gitignore）
src/
  index.js   # 网关主体：鉴权/路由/forwardChain/统计/保存/健康
  router.js  # resolve()、配置加载、provider 构建
  request.js # 转发 + keep-alive + 分层/整体超时 + 退避重试 + 熔断 + 预热
  format.js  # adapterFor(api) 适配 + cacheHitMiss 命中率
  sse.js     # isStreamResponse / relayStream（断点续传）/ 数据面
  admin.html # 控制面板（原生 JS，赛璐璐风格）
scripts/test/  # 集成测试运行器 run.mjs + 各用例
docs/          # 规划与交接文档
```

## 4. 安全红线（必须遵守）

- **API Key / 客户端&管理 token 永不打印、不写盘、不落日志**。`logger` 掩码所有秘密。`/api/status` 只回掩码。
- `keys.local.json` **始终 AES-GCM 加密**（头 `MG1:`），主密钥 `MG_KEYS_MASTER` 或自动生成的机器 `master.key`；拒绝写明文。
- `clientKey` / `__mg_client` 及未来 `__mg_vm_*` 一律加密落盘、掩码回显。
- `MG_ADMIN_TOKEN` 未设时 `/api/*` 裸奔（仅限回环，建议设）。
- 数据面鉴权：`Bearer` + `safeTokenCmp`（常量时间比较）。`MG_CLIENT_KEY` > keys `__mg_client` > `defaults.clientKey` 的取值优先级。

## 5. 关键机制

- **forwardChain 重试 + 循环兜底（src/index.js ~L363-533）**：
  三层重试（forward 内退避）→ 同模型 fallbacks → 跨模型 directory；外层 `while(loopDeadline)` **循环回队首**，受 `loopMs`(默认120s) 与熔断护栏约束；**deadline 只卡「开新轮」，一轮内所有候选都会被尝试**（避免慢上游饿死兜底）。成功/502 都带 `chain=` 兜底链标记。**每个新请求永远从队首重新决策（无会话粘滞）**：在途请求不迁移走完；链首恢复后下一个请求即回归，唯一延迟是熔断窗口（连续 5 败 open 10s：`FAIL_OPEN_THRESHOLD/COOLDOWN`；429 另有 provider 级 `rateUntil`=Retry-After）。
- **模型探针 probeModel（src/request.js）**：POST max_tokens=1 真实调用，**超时 90s**——某思考型模型实测 5s~90s+ 波动（上游代理内部重试期间不发字节），30s 会误报 ETIMEDOUT（已修）；上游级 probe（GET /v1/models 可达性）仍 20s。
- **SSE 续传**：流中途断开 → `maxReconnects=2` 重连去重；续传仍失败 → `onEnd({interrupted})` → 记中断+上游错误+**`streamDrops` 连续中断计数**，≥`STREAM_DROP_THRESHOLD`(3) 后路由**绕开该上游**（`markOk` 不重置 streamDrops，故真正生效）。
- **下游客户端断线(relayStream, sse.js)**：绑定客户端连接 `close/error` → `clientGoneAt` 标记 + 主动销毁上游流 + 停 idle 定时器，杜绝死等挂起上游导致的连接/资源泄漏与续传浪费；`pump` 对续传链用 `return resume(...)` **完整等待**（不能裸调 `resume()`），否则主流程会在续传补完前就执行 `client.end()` 把客户端掐断——这也是「对话直接中断」的根因。
- **统计持久化**：daily/hourly/byModel/dialogue/global/byProvider/latTrend 每30s落盘 `stats.json` 并在重启恢复（此前做的「重启即归零」已修）。
- **曲线图/按模型/按对话/按上游**统计面板；缓存命中率按 `cacheRead/(cacheRead+cacheWrite+uncached)` 协议分桶精确算。
- **gzip**：转发出 `accept-encoding:identity`，Magic 或申报 gzip 都强制解压，失败视为失败走 fallback。
- **3xx→502**、坏 gzip→fallback、慢/挂起上游不饿死兜底、流中断真正绕开——**均已实现并在上一轮用矩阵 mock 验证过**（20 种失效场景）。

## 6. 近期已交付

虚拟共享模型+客户端key、入口别名、健壮 start.bat、请求级日志(含 chain)、缓存命中真统计、流式中断计数+绕开、有界循环兜底、并发限流（每上游 maxPerProvider 默认8）、统计全量持久化、面板大量修复（bat CRLF、曲线图、滚动条挤卡片、上游卡 3 张、模板、输入不被打断、刷新反馈等）。

**SSE 下游截断加固（本轮）**：固定了「上游停摆+客户端断开→上游连接泄漏」与「续传中被 `client.end()` 掐断→对话直接中断」两处根因（sse.js：客户端 close 监听销毁上游流 + `return resume()` 等完整续传链）；配套隔离沙箱回归测试 `scripts/tmp-trunc/`（含 client-truncation.mjs + gateway.json，仅本地用、不入库），14 场景全绿（S1 基线/S2 abort/S3 cancel/S4 上游停摆+S5 续传完整/S6 续传中断释放/S7 并发）。

**曲线图渲染两轮修复 + 探针加长 + 本地协议转换代理接入（本轮）**：
- 曲线图①隐藏态守卫：`renderModelStats`/`drawTrend` 在面板 `display:none` 时 rect=0，直接跳过（不再按 320×160 兜底尺寸固化位图）；`switchView('stats')` rAF 重绘 + `redrawTrend` + resize 联动重绘。
- 曲线图②鉴权根因：`msAuthH()` 误用 `window.TOKEN`（**全文件从未赋值**，登录令牌实际在模块变量 `TOKEN`）→ `/api/model-stats` 永远 401 → 画布空白「暂无数据」。已改用 `TOKEN`。教训：**面板新接口鉴权一律走 `japi()` 或模块 `TOKEN`**；验证勿 stub fetch，会绕过真实鉴权路径。
- `probeModel` 超时 30s→90s（对齐 firstByteMs）。
- **本地协议转换代理接入**：代理部署在本地独立目录（不在本仓库内，含自启 bat）；某上游 baseUrl 指向 `http://127.0.0.1:3050`（代理已绑定回环、日志落盘其目录内），key 走**用户级环境变量**（用户选择保留环境变量设计，勿再建议迁移）。背景：该上游的 API 通道对当前账户等级不开放（403），经代理以兼容协议接入；其中某思考型模型经代理可用但瞬时限流频发（响应 5s~90s+），由另一上游兜底。代理已经安全审计：无窃密行为、零第三方依赖。
- **上游 HTTP 代理（proxy）已完整接通（2026-08-27）**：`router.js`（provider.proxy > defaults.proxy > 环境变量，回环自动直连）+ `request.js`（CONNECT 隧道，零依赖）为转发层；本次补齐 `buildStatus` 回显、`saveConfig` 持久化（含格式校验 400）、面板「默认上游」卡「网络代理」输入项——面板保存不再丢 proxy。此前半成品状态见 `session-reflection-2026-08-26.md`，已收尾。
- `scripts/dev.gateway.json` 已建（8788，models 镜像生产+代理上游，logFile=logs/dev.log），Phase 1 第 0 步完成。

## 7. 开发/验证作业法（重要）

- **生产 8787 不动；开发另起 8788**：`MG_CONFIG` 指一份开发配置（本金项目建议 `scripts/dev.gateway.json`，可低成本/mock）。
- 功能/并发/写入/多能力验证**优先用本地 mock 上游**（零成本、不烧 token）。
- 曾用的临时文件：`scripts/tmp-*.mjs`（矩阵/负载 mock）监听 8891，跑完即删；**改配置前先备份** `config/gateway.local.json`、`keys.local.json` 到 `.bak`，测完还原。
- 语法校验：`node --check src/*.js`。
- **PowerShell 下 `curl.exe -d '...json...'` 单引号会被吞坏 body**：用 `--data-binary "@文件"` 传 body。
- 端口占用用 `Get-NetTCPConnection -LocalPort N -State Listen` 的 OwningProcess 定位再 `Stop-Process`。

## 8. 进行中 / 已规划（下一步）

三阶段计划见 `docs/phased-execution-plan.md`，进度（2026-08-27 确认）：

- **Phase 1（多虚拟模型 + 独立 Key + 并发写安全）已落地**：virtualModels/两阶段鉴权/configVersion 409/写锁/MG_CONFIG_DIR/route-preview/未知名 404 全部可用，CHANGELOG 0.2.0。
- **技术债清理已完成**：TD1 测试沉淀（scripts/test 15 用例 + run.mjs）、TD2 stats 90 天保留窗口、TD3 forwardChain 拆至 forward.js。
- **proxy 收尾已完成（2026-08-27）**：面板「网络代理」输入项 + 持久化 + 回显（见第 6 节）。
- **Phase 2（下一动作）** — 能力维度框架（能力六件套：entry→adapter→provider 能力声明→accounting→probe→models）+ Embedding；协议转换采纳 sub2api 的 IR 中转 + 直连桥 + 流式事件顺序 wire 测试。virtualModels 已有 `priority` 字段位预留、exact/prefix 混合匹配留本阶段启用。
- **Phase 3** — Rerank / Audio / Image / Video（Video 异步任务池 + node:sqlite 持久化单独设计，最后做）。

已定决策：每虚拟模型**独有 key**；每虚拟模型**必须绑非空目录**；**保留旧 gatemodel/clientKey 兼容**；**不迁移 localstorage 模板、不做 schema 版本化**（虚拟模型存自包含快照）。

## 9. 陷阱清单

- `.bat` 用 CRLF（LF 会让 cmd 崩）；**chcp 65001 下 echo 行含全角括号`（）`会让 cmd 解析错位吃字节**，下一行被截断当命令执行——bat 中文行一律用半角标点（外部代理项目的 start.bat 踩过）。
- `gateway.local.json` / `keys.local.json` / `stats.json` / `logs/` / `*.bak` 备份 **永不提交**（gitignore 已覆盖）。
- 虚拟名/响应 model 名：兜底改写后响应 model 要**回写为客户端请求名**（防「名字没对上」）。
- Mode BaseURL 不含 `/v1`；模型思考强度由 `effortOptions`/`reasoning` 控制。
- `commit` 时留意 `.gitignore`/`package.json` 常因 CRLF/LF 显示为 modified 而实为噪音，别误提交（按实际内容 diff 判断）。
- 面板 admin.html 是**每请求 readFileSync 读盘**，改完刷新浏览器即生效（无需重启网关）；但浏览器可能缓存旧页，验证用 Ctrl+F5。

## 10. 当前运行态（每次会话先确认）

- **8787 生产网关**：由用户管理（start.bat 前台），2026-08-27 00:07 实测运行中（PID 46976，`/healthz` ok）。`config/gateway.local.json` 为 v17（configVersion 17，面板保存最新版），含 5 上游（opencodego/opencodezen/openrouter/command code/gmi）与 2 模型；`keys.local.json`/`stats.json` 当前 0 字节——key 全部走环境变量（合理）；stats 空说明可能被重置过或进程从未在本目录写盘，留意。
- **本地协议转换代理**：独立目录内的 start.bat 启动，监听 127.0.0.1:3050，日志落盘代理目录内；key 来自用户级环境变量（网关进程需继承该变量——新起的进程自动继承）。**2026-08-27 00:07 实测 3050 未在监听**，使用前需先启动。
- **8788 开发网关**：默认停止；`MG_CONFIG=scripts/dev.gateway.json MG_ADMIN_TOKEN=<测试令牌>` 启动。开发验证优先用 `MG_CONFIG_DIR` 独立目录 + 本地 mock（见第 7 节）。
- 真实配置存在 `gateway.local.json`（含真实上游 baseUrl / key 名，勿读内容外泄）；改动前备份为 `.bak`（gitignore 已覆盖）。