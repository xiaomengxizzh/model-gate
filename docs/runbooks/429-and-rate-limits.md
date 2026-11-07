# 429 与限流排障指南

> 适用：`>= 0.3.0`。相关实现：`src/budget.js`、`src/request.js`、`src/forward.js`。

## 1. 先看三个字段

任何数据面响应/错误都带：

- `x-mg-trace-id`：本次请求唯一 ID（错误体 `trace_id` 同值）。
- `x-mg-attempts`：真实发出的上游请求数。**这是判断「重试放大」的第一证据。**
- `Retry-After`：429 时回给客户端的建议等待秒数。

错误体里还有 `error.code`（`MG_429_<ATTRIBUTION>`）与 `error.attribution`。

## 2. 归因对照

| attribution | 含义 | 处置 |
| --- | --- | --- |
| `rate_limit` | RPM/TPM/并发速率限制（通常带 Retry-After） | 降客户端并发/加 QPS 上限；不要盲目加 Key |
| `model_capacity` | 单模型容量/过载 | 换模型/上游，或错峰 |
| `platform_quota` | 账户额度/余额/账单问题 | 充值/换账号；重试无意义 |
| `cooldown` | 网关本地冷却，所有上游都在 429 冷却窗口 | 等 `Retry-After`；检查上游是否持续 429 |
| `unknown` | 上游 429 但无可用文本/头 | 抓脱敏样本（矩阵 §6）再判 |

## 3. 预算为什么能止住放大

旧行为：`client 重试 × request.js maxAttempts × provider fallback × 120s while 循环` 可把一次 429 放大到几十次上游请求。

新行为（`defaults.budget`，见管理契约 §4）：

- `maxAttempts`（默认 8）是**单请求真实上游请求总数**的硬上限；
- `maxMs`（默认等于 `timeout.loopMs`，120s）是墙钟上限；
- 单次 `Retry-After` 等待超过 `maxWaitMs`（默认 30s）→ 不等待，换上游或直接回 429；
- 429 不再计入熔断（只做上游冷却）；
- 含 `tools`/工具结果的请求**不自动重放**（一次上游尝试），避免重复执行 `shell`/`apply_patch`。

调整示例（`config/gateway.local.json` 的 `defaults`，改后 `POST /api/config/reload`）：

```json
{
  "defaults": {
    "budget": { "maxAttempts": 4, "maxMs": 60000, "maxWaitMs": 5000 },
    "retry": { "toolRequests": false }
  }
}
```

> 调小 `maxAttempts` 会让客户端更快拿到 429，但上游压力更可控；调大不会改变「工具请求不重放」的硬约束。

## 4. 排查流程

1. 记下 `x-mg-trace-id`，`GET /api/logs?lines=500` 搜该 trace 对应的 `data ... -> 429` / `provider failed` 行（日志已脱敏）。
2. `GET /api/status` 看 `providers[].st`：`state`（`open`/`half`）、`errors`、`p95`；`models[].affinity` 看是否被钉在故障上游。
3. 看 `error.attempts`：等于 `budget.maxAttempts` → 预算是主动收尾，不是崩溃。
4. 若 `attribution=platform_quota`：`/api/model-test` 单模型验证（会产生少量费用，需授权）。
5. 若 `attribution=cooldown`：`/api/status` 的 `openUntilMs` 为 0 但仍在冷却说明是 429 冷却窗口，等待 `Retry-After`。

## 5. 常见误判

- **「网关 429 = 网关限流」**：多数是上游 429 透传。看 `upstream_status` 与 `attribution`。
- **「加 Key 能解决」**：`platform_quota` 加 Key 无效；`rate_limit` 加 Key 只在多账号分摊时有意义。
- **「重试次数越多越稳」**：429 场景下重试是放大器；预算 + `Retry-After` 才是正确策略。
- **「工具调用可以随便换上游重放」**：本轮起禁止；只有 `retry.toolRequests=true` 才会放开（不建议）。

## 6. 证据与复现

离线复现（零成本、不需要真实 Key）：

```bash
node --version           # >= 18，本机 22.23.2
npm run test:offline     # 96 断言；含 429/预算/408/409/422/断流/取消/合并硬化回归
```

相关用例：`scripts/test/offline/10-budget-429.test.mjs`、`15-status-matrix.test.mjs`。
