# 简约演示前端 v1 契约（cel-dusk）

> 状态：演示契约，2026-11-22。目标是在**不替换、不重启**运行中 `/ui-next` 控制台的前提下，提供一份只读、零表单的极简前端演示，用于验证「后端真实投影 → 前端直接消费」的最小闭环。演示不是新的生产控制台，不提供任何配置写入入口。

## 1. 范围与边界

- 只读：仅 GET 管理 API；唯一的客户端动作是刷新、切换时间窗口、切换明暗主题。
- 零手动填写：没有 Provider/Key/模型/配置表单，没有解锁、导入、保存。
- 不改运行中前端：`src/ui-next/**` 不动；演示静态资源独立在 `src/ui-demo/**`，由独立预览服务器提供。
- 不重启 8787：预览服务器把 `/api/*` 反向代理到运行中的网关；后端字段修复只在新进程生效，演示对字段缺失显式降级。
- 视觉基线：style-atlas 的 `cel-dusk`（赛璐璐夜色，现役基线），令牌逐值取自 `tokens/cel-dusk/tokens.css`，亮/暗两档都可用。

## 2. 数据源与口径

| 演示区域 | 端点 | 字段 | 口径 |
| --- | --- | --- | --- |
| 网关在线/版本/运行时长 | `GET /api/status` | `needAuth`、`configVersion`、`startedAt`、`uptimeMs`、`server` | 进程级快照 |
| 启动以来计数 | `GET /api/status` | `counters.requests/errors/retries/interrupts` | 本进程启动以来 |
| 持久化累计 | `GET /api/status` | `global.requests/errors/tokenCount/todayTokens/p50/p95` | 跨重启持久化（stats.json） |
| 上游状态 | `GET /api/status` | `providers[].id`、`hasKey`、`st.state`、`st.requests`、`st.errors`、`st.p95` | `st.requests` 是上游尝试累计，不是客户端请求数 |
| 模型用量 | `GET /api/model-stats?days=1\|7\|30` | 每模型时间桶 `requests`、`tokens`、`inTokens`、`outTokens`、`cacheHitTokens`、`cacheMissTokens`、`hitRate` | `requests` 是网关记账请求数，与 `/api/status.counters.requests` 同源；Chat 路径沿用既有逐上游尝试记账（重试会多次 +1），Responses/媒体/embeddings/rerank 为成功请求 +1。`hit/miss` 是**缓存命中/未命中的 prompt token**，旧字段名保留兼容 |
| 最近一次服务 | `GET /api/status` | `lastServing.model/provider/at` | 只表示最近一次成功的上游服务 |
| 接入方式 | `GET /api/aggregation/health` | `mode`、`drifted`、`needsRestart` | 只读；不可识别时显示未知 |
| 日志尾部 | `GET /api/logs?lines=80` | `lines[]` | 尾部读取，不是全量检索 |

### 2.1 后端对齐（最小必要修复）

现有 `/api/model-stats` 的时间桶只有 `tokens/hit/miss/inTokens/outTokens`，没有请求数；旧前端把 `hit+miss` 当请求数，导致数量级错误（本机出现 4.45 亿“请求”）。修复：

1. 请求成功记账统一走一个函数（`state.st.counters.requests`、`byProvider.requests`、`byModel.requests`、日/小时桶 `requests` 同时 +1），保持既有「Chat 按上游尝试」「其它路径按成功响应」口径不变。
2. `/api/model-stats` 每桶新增 `requests`、`cacheHitTokens`、`cacheMissTokens`；`hit/miss` 保留为兼容别名。
3. `/api/status.models[]` 新增 `todayRequests`，与 `today`（今日 token）同一日桶。
4. 口径写进 `docs/contracts/management-api-v1.md`。

### 2.2 字段缺失时的降级（不伪造）

- 整体没有 `requests`（旧版后端）：显示「当前后端未提供逐桶请求数」并只展示 token 趋势；绝不把 `hit+miss` 当请求数。
- 升级前的历史桶 `requests` 为 `null`：表格该格显示 `—`，不计入合计，并提示「部分历史桶早于请求计数字段」。
- 新写入的桶 `requests` 为数字；数字 0 表示确实没有请求。
- 聚合接口 404/403：接入方式显示「未知」并保留其余快照。
- 任一请求失败：对应卡片进入 error 态并给出重试按钮（仅重新 GET），不拿旧数据顶替。

## 3. 信息架构（单页，三段）

1. **顶栏**：ModelGate 标识、在线胶囊、接入方式、配置版本、刷新、明暗切换。
2. **状态带**：启动以来请求 / 持久化请求 / 今日 Token / 缓存命中率 / P95 / 运行时长。
3. **用量**：24h/7d/30d 分段；token 趋势（SVG，真实桶）；请求数仅在字段存在时显示。
4. **连接与模型**：上游状态紧凑表 + 模型用量表（token、请求、命中率）。
5. **最近**：lastServing + 日志尾部（等宽、可滚动、默认 20 行）。
6. **页脚**：数据来源与只读声明。

响应式：≥1024 三列，768–1023 两列，≤767 单列；390px 下不横向滚动。

## 4. 视觉令牌（cel-dusk）

- 属性：`<html data-style="cel-dusk" data-mode="light|dark">`。
- 深色：底 `#101A4E`、表面 `#1B2566/#1D2A72`、描边 `#3D4DAB` 2px、位移实色影 `3px 3px 0 var(--line)`、动效 `steps(2,end)`。
- 亮色：底 `#DCE4FB`、表面 `#FFFFFF/#EEF1FF`、描边 `#373D85`。
- 字体：标题 `Anton/Liberation Sans Narrow/Noto Sans CJK SC`，正文 `Noto Sans SC/system-ui`，数字用 `Cascadia Mono/Hack`。
- 可访问性：正文对比度 ≥ 4.5:1，非文本控件 ≥ 3:1（令牌表已实测）；焦点环 `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`；`prefers-reduced-motion` 下动效退化为直接切换。

## 5. 验收

- `node scripts/ui-demo-preview.mjs` 启动后，浏览器可打开演示并通过代理读取真实 `/api/*`。
- 1440×1000 与 390×844、亮/暗四处截图无溢出、无遮挡、无控制台错误。
- 禁用 JavaScript 时显示说明，不出现空白页。
- 后端关闭时页面显示可重试错误，不显示假 0。
- 新后端下 `requests` 桶与请求数一致（离线测试覆盖）。