# 简约演示前端（cel-dusk）预览

> 契约：[ui-demo-v1](../contracts/ui-demo-v1.md)。这是一份**只读演示**，不是新的生产控制台；它不替换 `/ui-next`，也不需要重启 8787。

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

- 顶栏：在线状态、接入方式、刷新、明暗主题。
- 状态带：启动以来记账请求、持久化请求、今日 Token、本窗口缓存命中率、P95、错误。
- 用量：24h/7d/30d 分段时间桶的 Token 柱状图；逐桶请求数在新后端存在时单列。
- 上游 / 模型：真实状态与窗口用量；未知显示 `—`，不显示假 0。
- 最近：`lastServing` 与 `/api/logs` 尾部。
- 没有 Provider/Key/模型/配置表单，也没有任何写入按钮。

## 数据口径

- `requests` 与 `/api/status.counters.requests` 同源；Chat 路径沿用逐上游尝试记账，重试会多次 +1，页面在状态卡与表头标注「记账请求 / 含重试尝试」。
- `hit/miss` 是 prompt 缓存 token，不是请求数；新后端另给 `cacheHitTokens/cacheMissTokens` 同值显式字段。
- 升级前的历史桶没有 `requests` 字段 → 投影为 `null`，页面显示 `—` 并排除在合计外；新写入的空桶为数字 0。

## 验收与限制

- 已在 1440×1000、900×1800、390×844 的亮/暗两档用本机 Chrome 无头渲染检查：无横向溢出、无控制台错误、对比度按 cel-dusk 令牌实测通过。
- 运行中的 8787 若是升级前进程，`/api/model-stats` 没有 `requests`：页面会明确提示「当前后端未提供逐桶请求数」，只展示真实 Token。重启后新字段生效。
- 未验证：真实上游推理与真实 Desktop 交互；演示不发起推理请求。
