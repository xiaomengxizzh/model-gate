# ModelGate 前端 V3｜产品状态投影与模块契约（UX-00）

> 契约 ID：`mg-ui-product-status/1`（代码：`src/ui-next/js/product-status.js`）
> 依据：[V3 执行计划](../roadmap/2026-11-15-frontend-experience-v3-execution-plan.md) §2/§3/§5/§6 · [V2 产品契约](../product/2026-11-14-owner-scope-v2.md)
> 状态：UX-00 已冻结（2026-11-15）。A1/A2/A3/A4/A5 一律按本文件的接口、状态名和诚实性等级实现；不得各自解释 `/api/status`。

## 1. 为什么需要这一层

旧控制台把 `/api/status` 的原始字段直接铺到首页，聚合页又用 `AGG.fetched` 私有缓存读另外四个接口，导致：

1. 首页说"未配置上游"，聚合页说"聚合已启用"（同一时刻两个事实）；
2. "检测到登录文件/目录里有模型/HTTP 200" 被渲染成绿色"已连接"，没有证据等级；
3. 384/404 的老实例被读成"0 个模型"，未知被读成否定。

本契约把"用户看到的状态"收敛成**一个纯函数投影**（`deriveProductStatus`），首页、连接向导、聚合详情、状态层共用同一份判定。视图只渲染，不再自己推导。

## 2. ProductStatus 投影

```ts
deriveProductStatus({
  authenticatedAdmin: boolean,   // 已解锁管理面
  loading: boolean,              // 首个快照未到
  phase?: 'conflict'|'write_in_progress'|null,
  status: Status | null,         // GET /api/status
  config?: Config | null,        // GET /api/config
  aggregation: { health, providers, models, diagnostics, unsupported? } | null,
  aggregationError?: { status, code, message, data } | null,
  statusLoadedAt?: number, now?: number,
}) => ProductStatus
```

`ProductStatus` = `{ contract, state, overall, primary, secondary, official, go, codex, aggregation, error, missingSections, checkedAt, readOnly }`。

| 字段 | 唯一来源 | 允许的等级 | 禁止 |
| --- | --- | --- | --- |
| `official` | `GET /api/status.official`（服务端 `probeLocalCodexAuth`，只读、无 token） | `detected` | 不得标 `runtime-verified`；不得显示账号、token、邮箱 |
| `go` | `GET /api/aggregation/providers` + `GET /api/status.providers[id].hasKey` + `GET /api/aggregation/models` | `detected` / `configured` / `runtime-verified` | 不得把 `hasKey` 当"已验证"；不得把未同步读成 0 个模型 |
| `codex` | `GET /api/aggregation/health.detect`（desktop/bundledCli/cli/restart） | `detected` | 不得猜"已重启"；`restart.needed` 缺失时只能说"无法确认"。**实测注**：`computeRestartState()` 的所有分支都返回布尔 `needed`，真实响应不会缺该字段；只有手工合成快照可能缺失，此时按"需要重启"提示（附"无法确认"原因），属诚实保守而非缺陷 |
| `aggregation` | `GET /api/aggregation/health`（mode/backup/activation） | `detected` | 不得把 `unknown` 写成 `official`（未聚合）或反之 |

**公共模型 ID 事实（已核对代码）**：已发布公共 ID 由 `src/codex/catalog.js:stableModelId()` 生成，为 **`mg-opencodego-deepseek-v4-1-flash`**（`AGGREGATED_ID_PREFIX + 段 + '-' + 模型段`）；上游真实模型名是 `deepseek-v4.1-flash`；`/api/status.models[i].name` 与 `lastServing.model` 都是公共 ID。`product-status.js` 的 `matchesGoTargetId()` 容错接受 `mg-opencodego-deepseek-v4-1-flash` / `opencodego/deepseek-v4.1-flash` / `deepseek-v4.1-flash`，并**不**把 `mg-opencodego-gpt-6-luna` 等其它模型算作目标。

**`go.level === 'runtime-verified'` 的唯一允许条件**：`/api/status.lastServing` 的 `provider` 是 Go 供应商 **且** `model` 命中上述目标模型 ID。任何"配置写好""探测 200""发现目录成功"都只能到 `configured`。用户界面显示 `DeepSeek V4.1 Flash`，不要求用户理解或输入任何 ID。

### 2.1 首页状态机（`state`）

`locked → loading → read_only_unknown | needs_admin_token | cannot_detect_codex | needs_go_key | go_key_invalid | ready_to_enable | needs_codex_restart | ready | conflict | recoverable_error`

派生顺序（先命中先返回，实现见 `homeStateOf`）：

1. `loading`；2. `!authenticatedAdmin → locked`；3. 聚合接口 404 → `read_only_unknown`；4. 读取错误（409 → `conflict`，其它 → `recoverable_error`）；
5. `!codex.found → cannot_detect_codex`；6. `go.state==='error' → go_key_invalid`；7. `!go.credentialPresent → needs_go_key`；
8. `!go.targetModelConfigured` 或 `mode!=='aggregated' → ready_to_enable`；9. `restartNeeded → needs_codex_restart`；10. 否则 `ready`。

每个状态**只有一个** `primary`（`{id,label,kind,route,detail}`）；`secondary` 最多列出"查看高级诊断 / 退出并恢复 / 重新检测"。`kind==='route'` 的 `route` 使用 `#/connections?step=key|model|enable|restart|use|revert|conflict|codex`。

### 2.2 三模式状态投影扩展（P1 实现中，真机未验收）

三模式（直连 / 路由 / 聚合）接入方式统一在本投影层暴露，**不得由视图各自解释**：

| 字段 | 含义 | 允许值 | 禁止 |
| --- | --- | --- | --- |
| `mode` | 当前接入方式（**历史字段 `profile` 已更名为 `mode`**，消费方只读 `mode`） | `official` / `route` / `aggregated` / `unknown` | 不得把 `unknown` 写成 `official` 或反之；不得接受白名单外取值 |
| `previousMode` | 切换前的上一模式，供回滚使用 | 同上，或 `null` | 缺失/非法时拒绝回滚，不猜测默认值 |
| `drifted` | 配置漂移标记：受控字段被外部改动导致快照与回执不一致 | 布尔 | `true` 时禁止静默切换，必须先解决漂移并由用户确认 |

- 来源：服务端状态记录（`mode` / `previousMode` / `appliedSha`）与 `unmanagedFingerprint` 一致性判定；投影只做只读呈现。
- 切换走 预览 → 确认 → 回执；**切换后必须完全退出并重新打开 Codex GUI 才生效**（含切回直连）。视图不得显示"已生效"除非回执明确且用户已重启。
- 路由 `mode=route` 的验收硬指标是零 GPT（`chatgpt-plan` 出站 = 0）；非 luna 父按 MG-R012 标 `UNVERIFIED`，不得签 `PASS_REAL`。
- 接入方式到契约的映射与 config 形态见[三模式接入方式映射](../product/2026-11-18-three-mode-access-mapping.md)。

## 3. 后端最小补充（本次唯一后端改动，主代理执行）

`GET /api/status` 新增只读字段（不新增端点、不新增写入通道）：

```json
{
  "official": {
    "credential": "detected | missing | unknown",
    "reason": "local_codex_chatgpt | auth_file_missing | auth_mode_missing | api_key_mode | access_token_expired | ...",
    "authMode": "chatgpt | null",
    "level": "detected | unknown",
    "source": "local_codex_auth_probe",
    "checkedAt": "ISO"
  }
}
```

约束：只读 `CODEX_HOME/auth.json` 的 `auth_mode` 与 token **存在性**；不返回、不记录、不刷新 token；探测异常返回 `credential:'unknown'`（不假定已登录）。

**凭据优先复用系统环境变量**：若 `providers.opencodego.apiKeyEnv`（默认 `OPENCODE_API_KEY`）在进程环境或用户级环境中存在，`/api/status.providers[].hasKey=true`、`keySource=env|env-registry`，向导必须提供"使用现有凭据并连接"（不调用 `POST /api/keys`、不回显值）；只有环境里没有时才要求用户粘贴。聚合发现（sync）与转发链共用 `resolveKey`，不会出现"状态说有、同步说没有"。

**Go Key 写入通道**沿用现有 API，不新建存储：`POST /api/aggregation/providers`（可用 `preset:'opencode-go'` 省略 ID/URL/env）→ `POST /api/keys {id:'opencodego', key}` → `POST /api/aggregation/providers/opencodego/sync` → `POST /api/aggregation/activate`（428 预览 → consentToken → 原子写 → 回执）。每一步独立可重试/可回滚（`DELETE /api/aggregation/providers/:id`）。

### 3.1 三模式切换端点（switch / rollback / modes，已接线；真机验收 NOT_TESTED）

| 操作 | 端点 | 语义 | 写盘 / 重启 |
| --- | --- | --- | --- |
| 列出模式 | `GET /api/aggregation/modes` | 返回可用模式、当前 `mode`、`previousMode`、`drifted`，只读 | 否 / 否 |
| 切换模式 | `POST /api/aggregation/switch` | 428 预览 → 确认 → 200 回执；目标 `mode` 必须合法（`official`/`route`/`aggregated`），非法→422 | 是 / **必须完全退出并重开 Codex GUI** |
| 回滚模式 | `POST /api/aggregation/rollback` | 428 预览 → 确认 → 回到 `previousMode`，按 `appliedSha`/备份校验；`drifted=true` 或无 previous→409 | 是 / 必须重开 Codex GUI |

- 端点路径与代码一致，统一走 `/api/aggregation/*`（`isAggregationApiPath` 已支持）；服务端已接线并通过离线 + HTTP 夹具验证，**真机 GUI 仍 `NOT_TESTED`**。
- 切换/回滚一律要求显式管理员令牌、回环来源（或显式 `allowRemote`），不接受浏览器提供的路径或原始 TOML。
- 非法 `mode` / `previousMode` / `drifted=true`：返回明确错误，配置与状态零改动，不静默降级。
- 与既有受控配置写入 `/api/codex/config/plan|apply|rollback` 的关系：后者是字段级事务，前者是模式级编排；两者共用同一份 `mode` 状态与备份口径。

## 4. 路由与导航契约（A1 实现，A3 消费）

`js/router.js` 的 `ROUTES` 仍是唯一路由表，每项增加 `group: 'primary' | 'advanced'`、`title`、`icon`、`navLabel`：

| 分区 | id | 标题 | 说明 |
| --- | --- | --- | --- |
| primary | `overview` | 首页 | 状态 + 唯一主操作 |
| primary | `connections` | 模型与账号 | Go 接入向导、聚合启停、退出恢复（**新增**） |
| primary | `settings` | 设置 | 常规设置、配置恢复 |
| advanced | `providers` | 上游供应商 | 原完整通用 Provider 管理 |
| advanced | `models` | 模型与路由 | 原高级路由/虚拟模型 |
| advanced | `clients` | 客户端接入 | DSH/SDK/CLI 导出 |
| advanced | `aggregation` | 聚合详情 | 原诊断长表（深链保留） |
| advanced | `observability` | 监控与诊断 | 原全部指标 |

硬约束：

- 七个旧 id **全部继续可用**；`#/connections?step=key` 的 `routeFromHash()` 必须返回 `connections`（查询串不参与路由匹配）。
- 不删除 `/ui-next` 的 `/ui-next/index.html` 深链；`/`、`/admin` 旧控制台不受影响。
- 导航项使用 `data-route` + `aria-current="page"`；核心导航最少 3 项，高级功能默认收起但**可键盘展开**。

## 5. 状态层契约（A3 实现，A1/A2 只消费）

`js/state` 层必须提供（名称固定）：

```ts
// store.js
state.product: ProductStatus | null
productStatus(): ProductStatus | null                       // 当前快照的投影
refreshProduct(opts?: {reason?: string, force?: boolean}): Promise<ProductStatus>
invalidateProductStatus(reason?: string): void
onProductStatus(fn): () => void                             // 每次新快照后调用（含 invalidate）
aggregationState(): {health, providers, models, diagnostics, error, loadedAt, freshness} | null
setProductPhase(phase: 'conflict'|'write_in_progress'|'preview_pending'|null): void

// api.js
api.aggregationHealth() / aggregationProviders() / aggregationModels() / aggregationDiagnostics()
api.addAggregationProvider(body) / syncAggregationProvider(id) / removeAggregationProvider(id, body)
api.activateAggregation(body) / deactivateAggregation(body)
```

可靠性要求（`ui-state` 套件验证）：

1. `refreshProduct` 用 **epoch/AbortController**：旧响应不得覆盖新快照；并发调用合并为一次在途请求。
2. 路由可见才刷新；`FRESHNESS_BUDGET` 内不重复请求；启停成功/失败、401、`online` 事件后强制失效。
3. 401 清空快照与敏感 DOM；403 只进局部错误态（不得清 token）。
4. 轮询**只读**，绝不触发真实推理、不写配置。
5. 打开中的表单/草稿在快照刷新时不被重建（`editDialogOpen()` 语义）。

## 6. 组件与样式契约（A4 实现，A1/A2/A3 使用）

`js/components.js` 现有导出**不得改名或删除**：`pageHead, card, metric, tag, statusTag, callout, empty, table, field, codeBlock, copyButton, toast, dialog, confirmDialog, kvList, lineChart, barChart, sectionTitle, tabs`。可新增 `stepper`、`statusRow`、`primaryAction` 等，但必须保持零依赖、纯 DOM、`h()` 构造（禁止 `innerHTML`）。

视觉底线：正文 14–16px、帮助文字 ≥12px、主按钮高度 ≥40px、`label` 完整、焦点可见、`aria-live` 只播报关键状态、弹窗 Escape + 焦点圈定 + 关闭后焦点归还、支持 360/768/1440 与 200% 缩放、明暗主题。技术长表只能出现在高级页并支持横向滚动。

## 7. 写集与 owner

| owner | 允许写 | 禁止写 |
| --- | --- | --- |
| Lead | `src/ui-next/js/product-status.js`、`src/index.js`（official 投影）、`docs/**`、`scripts/test/run.mjs`（清单）、集成冲突文件 | 不改 A1–A4 的视图文件（集成除外） |
| A1 | `src/ui-next/index.html`、`js/router.js`、`js/views/dashboard.js`、`scripts/test/offline/ui-v3-home.test.mjs` | 其它视图、store/api/app |
| A2 | `js/views/connections.js`（新建）、`js/views/aggregation.js`、`src/aggregation/api.js`（preset 透传）、`scripts/test/offline/ui-v3-connections.test.mjs` | dashboard/router/index.html、store/api/app |
| A3 | `js/store.js`、`js/api.js`、`app.js`、`scripts/test/offline/ui-v3-state.test.mjs` | 视图文件、product-status.js |
| A4 | `src/ui-next/styles.css`、`js/components.js`、`scripts/test/offline/ui-v3-visual.test.mjs`；**次级视图整理需主代理逐文件分配**（`providers/models/clients/observability/settings/clients`） | dashboard/router/index.html、store/api/app、connections/aggregation |
| A5 | `scripts/test/offline/ui-v3-acceptance.test.mjs`、`scripts/e2e/**`（新增，需主代理登记）、`docs/evidence/**` | 产品源码（只读） |

新增测试文件必须由主代理登记进 `scripts/test/run.mjs` 的字面量清单（`runner-selftest` 会拒绝未登记/重复/缺失文件）。

## 8. 错误矩阵（UI 必须区分）

| 条件 | 状态 | 文案要求 | 技术行为 |
| --- | --- | --- | --- |
| Go 401 | `go_key_invalid` | "OpenCode Go 验证失败，请更新 Key" | 不回显 Key、不回退 GPT |
| Go 429 | `go_key_invalid`/局部错误 | "OpenCode Go 当前受限" | 保留 `Retry-After`，不跨域兜底 |
| 428 | `preview_pending` | "即将更新 Codex 接入设置，请先确认" | 完整 diff + backup + consentToken |
| 409 | `conflict` | "设置已被其他程序修改，未覆盖" | 三方 diff，可重新检测，不强制覆盖 |
| 404 聚合接口 | `read_only_unknown` | "当前实例不支持聚合管理" | 停止自动写入 |
| 断网/超时 | `recoverable_error` | "无法连接本地网关，可重试" | 不显示旧成功状态 |
| 聚合接口 403 `explicit_admin_required` | `needs_admin_token` | "需要操作：设置管理令牌" | 不清 token、不锁屏、不冒充读取失败；CTA 指向 `#/settings?section=admin-token` |
| 401 管理令牌 | `locked` | "令牌已失效，请重新解锁" | 清空快照/敏感 DOM |

## 9. 非目标

- 不新增第二套压缩/摘要、不改 `src/codex/interop.js` 的 compaction 语义。
- 不新增付费请求；真实 GPT 只允许 `gpt-6-luna`，Go 只 `deepseek-v4.1-flash`。
- 不引入 React/Vue/任何新依赖，不加"打开 Codex"假按钮，不改 `main`/PR #7/历史回执。
