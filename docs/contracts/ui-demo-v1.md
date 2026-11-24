# 简约演示前端 v1 契约（cel-dusk）

> 状态：交互演示契约 v1.1，2026-11-24。目标是在**不替换、不重启**运行中 `/ui-next` 控制台的前提下，提供一份极简前端演示：三段功能区（模式 / 图表 / 设置）直接消费后端真实投影，只有「模式」页在用户显式知情确认后允许经既有 consent 流程写入 Codex 接入配置。演示不是新的生产控制台，也不是 `/` 的默认路由。

## 1. 范围与边界

- 三个功能区：**模式**（三模式快照 + 预览/回滚/reconcile 的确认写入）、**图表**（真实桶的 token/请求/命中率趋势与筛选）、**设置**（仅外观与演示偏好，存本机 localStorage）。
- 只读部分：所有状态数据仅 GET 管理 API；刷新、时间窗口、图表类型/指标、明暗主题切换都不写入服务端。
- 唯一的写入口：模式页的「预览切换 / 回滚 / 采纳基线」。写入是**两阶段**：先 POST 空 `consentToken` 取得 428 preview（不写任何文件），展示逐行 diff 与备份/冲突信息；用户勾选知情项后，才携带 preview 返回的 `consentToken` + `expectedSha` 再 POST 确认。没有 consent 令牌的写请求一律不发出。
- 设置页不碰任何网关配置或 Codex 配置：导入/导出/重置只作用于 `mg-demo-settings/1` 这个 localStorage 键；「切换前二次确认」固定开启、不可关闭。
- 不改运行中前端：`src/ui-next/**` 不动；演示静态资源独立在 `src/ui-demo/**`，由独立预览服务器提供；根路由 `/` 不变。
- 不重启 8787：预览服务器把 `/api/*` 反向代理到运行中的网关（含 POST 同源改写，仅转发浏览器请求，不自行发起写入）；后端字段修复只在新进程生效，演示对字段缺失显式降级。
- 视觉基线：style-atlas 的 `cel-dusk`（赛璐璐夜色，现役基线），令牌逐值取自 `tokens/cel-dusk/tokens.css`，亮/暗两档都可用。

### 1.1 写入安全边界（硬约束）

- 写入目标只有 `/api/aggregation/{switch,rollback,reconcile}`；不新增、不直写 `~/.codex/config.toml`，不读取或打印 `auth.json`、Key 与令牌。
- consent 令牌只存在于内存态 `state.modeUi.preview`，不进 localStorage、URL、日志或 DOM 隐藏副本；确认后即失效。
- 服务端返回 409 漂移 / 422 阻断 / 404 不支持时，只展示真实错误与重试入口，不自动覆盖、不降级为「成功」。
- 切换成功后仅提示「请完全退出并重开 Codex」，不声称已生效；`needsRestart` 只来自 `/api/aggregation/health` 的真实检测。

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

## 3. 信息架构（单页，三个 tab）

1. **顶栏**：ModelGate 标识、模式/图表/设置 三个 tab、在线胶囊、接入方式胶囊、刷新、明暗切换。
2. **模式（默认）**：当前接入方式快照（父/子模型、上一模式、配置 SHA、重启与漂移状态）、三模式单选卡、聚合父模型选择；「预览切换 / 回滚 / 采纳基线」→ 428 预览对话框（逐行 diff、SHA、备份、冲突、知情勾选）→ 确认写入 → 真实回执。
3. **图表**：24h/7d/30d 范围、Token/记账请求/缓存命中率指标、柱状/折线切换、Provider/模型筛选；SVG 真实桶趋势 + 选中桶详情 + 时间桶明细表；请求数字段缺失时显式提示，不把 `hit+miss` 当请求数。
4. **设置**：外观（主题/密度/动效/描边/圆角/阴影）、图表与刷新默认值、数据与显示、交互安全（二次确认固定开启）、配置导入导出/重置、网关信息（只读）、最近日志尾部；全部仅本机 localStorage，不写服务端。
5. **页脚**：数据来源与「只读快照 + 模式页显式确认写入」声明。

响应式：桌面三栏栅格收敛为窄屏单列；390px 下不横向滚动。键盘：tab 支持方向键/Home/End，对话框支持 Escape、焦点圈定与关闭后恢复焦点。

## 4. 视觉令牌（cel-dusk）

- 属性：`<html data-style="cel-dusk" data-mode="light|dark">`。
- 深色：底 `#101A4E`、表面 `#1B2566/#1D2A72`、描边 `#3D4DAB` 2px、位移实色影 `3px 3px 0 var(--line)`、动效 `steps(2,end)`。
- 亮色：底 `#DCE4FB`、表面 `#FFFFFF/#EEF1FF`、描边 `#373D85`。
- 字体：标题 `Anton/Liberation Sans Narrow/Noto Sans CJK SC`，正文 `Noto Sans SC/system-ui`，数字用 `Cascadia Mono/Hack`。
- 可访问性：正文对比度 ≥ 4.5:1，非文本控件 ≥ 3:1（令牌表已实测）；焦点环 `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`；`prefers-reduced-motion` 下动效退化为直接切换。

## 5. 验收

- `node scripts/ui-demo-preview.mjs` 启动后，浏览器可打开演示并通过代理读取真实 `/api/*`；三个 tab 均可渲染，模式预览可取得 428 预览对话框。
- 1440×1000 与 390×844、亮/暗各处截图无溢出、无遮挡、无控制台错误（`favicon` 以 data URI 提供，不产生 404）。
- 写入必须两阶段：无 consent 的预览请求不改任何文件；勾选知情项前确认按钮禁用；仅在持有 preview 的 `consentToken`/`expectedSha` 时才发确认写请求。
- 设置导入非法值回落默认、未知名键丢弃；刷新后外观保持；重置回默认；从不写服务端配置。
- 禁用 JavaScript 时显示说明，不出现空白页。
- 后端关闭时页面显示可重试错误，不显示假 0；旧后端缺 `requests` 桶时显式提示「后端未提供」。
- 纯函数契约由 `scripts/test/offline/ui-demo-contract.test.mjs` 覆盖（空值过滤、请求/缓存 token 量纲、模式请求体与响应分类、设置归一化、格式）；`check-ui` 覆盖全部 UI 模块语法。