# model-gateway · 项目交接 / 上下文速览

> 供下一次会话的 AI 快速掌握项目全貌、红线与未完成事项。请先读本文件，再动代码。
> 位置：`E:\ai\aiwork\working\model-gateway`

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

- **forwardChain 重试 + 循环兜底（src/index.js ~L421-533）**：
  三层重试（forward 内退避）→ 同模型 fallbacks → 跨模型 directory；外层 `while(loopDeadline)` **循环回队首**，受 `loopMs`(默认120s) 与熔断护栏约束；**deadline 只卡「开新轮」，一轮内所有候选都会被尝试**（避免慢上游饿死兜底）。成功/502 都带 `chain=` 兜底链标记。
- **SSE 续传**：流中途断开 → `maxReconnects=2` 重连去重；续传仍失败 → `onEnd({interrupted})` → 记中断+上游错误+**`streamDrops` 连续中断计数**，≥`STREAM_DROP_THRESHOLD`(3) 后路由**绕开该上游**（`markOk` 不重置 streamDrops，故真正生效）。
- **下游客户端断线(relayStream, sse.js)**：绑定客户端连接 `close/error` → `clientGoneAt` 标记 + 主动销毁上游流 + 停 idle 定时器，杜绝死等挂起上游导致的连接/资源泄漏与续传浪费；`pump` 对续传链用 `return resume(...)` **完整等待**（不能裸调 `resume()`），否则主流程会在续传补完前就执行 `client.end()` 把客户端掐断——这也是「对话直接中断」的根因。
- **统计持久化**：daily/hourly/byModel/dialogue/global/byProvider/latTrend 每30s落盘 `stats.json` 并在重启恢复（此前做的「重启即归零」已修）。
- **曲线图/按模型/按对话/按上游**统计面板；缓存命中率按 `cacheRead/(cacheRead+cacheWrite+uncached)` 协议分桶精确算。
- **gzip**：转发出 `accept-encoding:identity`，Magic 或申报 gzip 都强制解压，失败视为失败走 fallback。
- **3xx→502**、坏 gzip→fallback、慢/挂起上游不饿死兜底、流中断真正绕开——**均已实现并在上一轮用矩阵 mock 验证过**（20 种失效场景）。

## 6. 近期已交付

虚拟共享模型+客户端key、入口别名、健壮 start.bat、请求级日志(含 chain)、缓存命中真统计、流式中断计数+绕开、有界循环兜底、并发限流（每上游 maxPerProvider 默认8）、统计全量持久化、面板大量修复（bat CRLF、曲线图、滚动条挤卡片、上游卡 3 张、模板、输入不被打断、刷新反馈等）。

**SSE 下游截断加固（本轮）**：固定了「上游停摆+客户端断开→上游连接泄漏」与「续传中被 `client.end()` 掐断→对话直接中断」两处根因（sse.js：客户端 close 监听销毁上游流 + `return resume()` 等完整续传链）；配套隔离沙箱回归测试 `scripts/tmp-trunc/`（含 client-truncation.mjs + gateway.json，仅本地用、不入库），14 场景全绿（S1 基线/S2 abort/S3 cancel/S4 上游停摆+S5 续传完整/S6 续传中断释放/S7 并发）。

## 7. 开发/验证作业法（重要）

- **生产 8787 不动；开发另起 8788**：`MG_CONFIG` 指一份开发配置（本金项目建议 `scripts/dev.gateway.json`，可低成本/mock）。
- 功能/并发/写入/多能力验证**优先用本地 mock 上游**（零成本、不烧 token）。
- 曾用的临时文件：`scripts/tmp-*.mjs`（矩阵/负载 mock）监听 8891，跑完即删；**改配置前先备份** `config/gateway.local.json`、`keys.local.json` 到 `.bak`，测完还原。
- 语法校验：`node --check src/*.js`。
- **PowerShell 下 `curl.exe -d '...json...'` 单引号会被吞坏 body**：用 `--data-binary "@文件"` 传 body。
- 端口占用用 `Get-NetTCPConnection -LocalPort N -State Listen` 的 OwningProcess 定位再 `Stop-Process`。

## 8. 进行中 / 已规划（下一步）

已写入 `docs/phased-execution-plan.md`，三阶段：

1. **Phase 1（下一动作）** — 多虚拟模型 `virtualModels`（各自 Directory 快照）+ 每模型独立 Key（`__mg_vm_*`）+ **并发写安全**（saveConfig/saveKeys 异步写互斥 + 读改写锁内 + 单调 `configVersion`，过期保存 409）+ 面板交换「虚拟共用模型名↔客户端接入 Key」位置 + 新增虚拟模型管理器 + `/v1/models` 聚合。能力仍=Chat，兼容旧 gatemodel。
2. **Phase 2** — 能力维度框架（**能力六件套**：entry→adapter→provider能力声明→accounting→probe→models）+ Embedding。
3. **Phase 3** — Rerank / Audio / Image / Video（Video 异步任务+轮询单独设计，最后做）。

已定决策：每虚拟模型**独有 key**；每虚拟模型**必须绑非空目录**；**保留旧 gatemodel/clientKey 兼容**；**不迁移 localstorage 模板、不做 schema 版本化**（虚拟模型存自包含快照）。

## 9. 陷阱清单

- `.bat` 用 CRLF（LF 会让 cmd 崩）。
- `gateway.local.json` / `keys.local.json` / `stats.json` / `logs/` **永不提交**（gitignore 已覆盖）。
- 虚拟名/响应 model 名：兜底改写后响应 model 要**回写为客户端请求名**（防「名字没对上」）。
- Mode BaseURL 不含 `/v1`；模型思考强度由 `effortOptions`/`reasoning` 控制。
- `commit` 时留意 `.gitignore`/`package.json` 常因 CRLF/LF 显示为 modified 而实为噪音，别误提交（按实际内容 diff 判断）。

## 10. 当前运行态（每次会话先确认）

- 上一轮结束时**网关未被拉起**（8787 空闲）。需要时 `start.bat` 启动。
- 真实配置存在 `gateway.local.json`（含真实上游 baseUrl / key 名，勿读内容外泄）。