# 简约交互演示前端（cel-dusk）预览

> 契约：[ui-demo-v1](../contracts/ui-demo-v1.md)。这是三 tab 的**交互演示**（模式 / 图表 / 设置），不是新的生产控制台；它不替换 `/ui-next`，不改根路由，也不需要重启 8787。只有「模式」页在显式知情确认后才经既有 consent 流程写入 Codex 接入配置；设置只存本机 localStorage。

## 启动

在仓库根目录（本分支）执行：

```bash
node scripts/ui-demo-preview.mjs
# 打开 http://127.0.0.1:8791/
```

默认行为：

- 静态资源来自 `src/ui-demo/`；
- `/api/*` 反向代理到 `http://127.0.0.1:8787`（运行中的网关，只读 GET）；
- 监听 `127.0.0.1:8791`，不写配置、不改 `/ui-next`、不启停服务。

可选参数：

```bash
node scripts/ui-demo-preview.mjs --port 8799 --target http://127.0.0.1:8787
node scripts/ui-demo-preview.mjs --fixture .preview/fixture.json   # 离线设计验收
```

`--fixture` 的 JSON 是 `{ "/api/status": {...}, "/api/model-stats?days=1": {...} }` 的键值表；fixture 模式不触达任何网关。

## 页面在做什么

- **模式（默认 tab）**：当前接入方式快照（父/子模型、上一模式、配置 SHA、重启与漂移状态）+ 三模式单选卡 + 聚合父模型选择。三个动作都是**两阶段**：`预览切换 / 回滚 / 采纳基线` 先 POST 空 `consentToken` 取 428 preview，弹出逐行 diff、前后 SHA、备份与冲突；勾选「我已了解：需要完全退出并重开 Codex Desktop」后确认按钮才可用，确认时携带 preview 的 `consentToken` + `expectedSha` 再 POST 一次。没有令牌不写、不自动覆盖漂移配置。
- **图表**：24h/7d/30d 范围、Token / 记账请求 / 缓存命中率、柱状/折线、Provider/模型筛选；SVG 真实桶趋势 + 选中桶详情 + 时间桶明细表；键盘方向键可调整选中桶。
- **设置**：外观（主题/密度/动效/描边/圆角/阴影）、图表与刷新默认值、数据与显示、交互安全、配置 JSON 导入导出/重置、网关只读信息、最近日志尾部。全部只写 `localStorage` 键 `mg-demo-settings/1`，「切换前二次确认」固定开启不可关闭。
- 没有 Provider/Key/配置表单；不存在绕过 consent 的写入按钮。

## 写入安全

- 写入只走 `/api/aggregation/{switch,rollback,reconcile}`；代理仅转发浏览器请求并做同源改写，不自行发起写入、不启停网关。
- consent 令牌只在内存中，不进 localStorage、URL、日志或 DOM 隐藏副本；确认后即失效；每次预览重新取令牌。
- 切换成功只提示「请完全退出并重开 Codex」，不声称已生效；409/422/404 显示真实错误，不降级为成功。
- 想完全避免写入，只用「图表」「设置」两个 tab，或在预览对话框点「取消（不写入）」。

## 数据口径

- `requests` 与 `/api/status.counters.requests` 同源；Chat 路径沿用逐上游尝试记账，重试会多次 +1，页面在状态卡与表头标注「记账请求 / 含重试尝试」。
- `hit/miss` 是 prompt 缓存 token，不是请求数；新后端另给 `cacheHitTokens/cacheMissTokens` 同值显式字段。
- 升级前的历史桶没有 `requests` 字段 → 投影为 `null`，页面显示 `—` 并排除在合计外；新写入的空桶为数字 0。

## 验收与限制

- 已在 1440×1000、900×1800、390×844 的亮/暗两档用本机 Chrome 无头渲染检查：三 tab 可渲染、模式预览可取得 428 对话框、设置持久化与重置生效、无横向溢出、无控制台错误（`favicon` 用 data URI，不产生 404）、对比度按 cel-dusk 令牌实测通过。
- 运行中的 8787 若是升级前进程，`/api/model-stats` 没有 `requests`：页面会明确提示「当前后端未提供逐桶请求数」，只展示真实 Token。重启后新字段生效。
- 演示不是生产控制台：`src/ui-next/**` 与 `/` 路由未改，8787 未启停；生产接入仍需所有者按正式计划另行裁决。
- 未验证：真实上游推理与真实 Desktop 交互；演示不发起推理请求；确认写入的真实生效（需完全退出并重开 Codex 后由所有者按三模式验收口径实测）。
