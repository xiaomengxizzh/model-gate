# 官方额度预警与手动应急（E8 / D7-B）

> 状态：**预警与应急状态机已实现（2026-11-11，纯函数 + 显式注入）**；真实官方额度 API 与真实应急切换 **NOT_RUN**。
> 代码：[src/codex/quota.js](../../src/codex/quota.js) · 回归：[scripts/test/offline/codex-quota.test.mjs](../../scripts/test/offline/codex-quota.test.mjs)
> 相关：D7 决策见 [E0 基线](../roadmap/2026-11-11-codex-aggregation-e0-baseline.md)；v2 子代理边界见 [Codex v2 子代理说明](codex-v2-agents.md)。

## 1. 目标与非目标

**目标**：在官方额度不可知/偏高/耗尽时，给用户**可解释的预警**与**完全手动**的应急入口；任何状态都可恢复，且不改变官方登录与账单。

**非目标（D7 明确禁止）**：

- 不自动切换 provider/模型、不自动进入第三方应急态。
- 不购买 API 额度、不绕过官方限制、不退出/删除官方登录、不共享账号。
- 不把未知额度当成 0%/100%，不虚构重置时间或套餐。
- 不宣称"无缝"：应急态会改变 provider 分组与会话可见性，通常需要独立实例或重启客户端。

## 2. 额度数据源（可注入）

调用方注入 `readQuota()`（或直接传 `quota` 对象）：

```js
// readQuota() -> 只读取以下白名单字段；额外字段不会进入输出
{
  source: 'trusted',        // 可信来源标签；不安全字符会被回退为 'trusted'/'injected'
  ok: true,                 // false 或抛错 -> UNKNOWN
  usedPercent: 76.5,        // 0..100；缺失/越界 -> UNKNOWN（不 clamp、不猜测）
  resetsAt: '2026-11-12T00:00:00Z', // 可选；无法解析 -> null（不臆造）
  plan: 'pro',              // 可选；仅展示用
  error: 'network_down'     // 可选；只保留像错误码的短串
}
```

配置：`cfg.defaults.codexQuota = { warnPercent: 80, criticalPercent: 95, source: 'none' | 'trusted' }`

- `source:'none'`（默认）：即使调用了注入读数也**不采用**，状态为 `unknown`。
- `source:'trusted'`：使用注入读数；没有注入时仍为 `unknown`（`no_source_configured`）。
- 阈值非法回退默认；`criticalPercent < warnPercent` 时收敛为 `criticalPercent = warnPercent`。

## 3. 预警状态

| 状态 | 条件 | 显示 | 影响说明（`impacts`） |
| --- | --- | --- | --- |
| `unknown` | 无来源 / `ok:false` / 抛错 / usedPercent 缺失或越界 | `UNKNOWN` | `quota_unknown`；不推断、不自动切换 |
| `normal` | `usedPercent < warnPercent` | `42%` | 无 |
| `warn` | `warnPercent ≤ usedPercent < criticalPercent` | `80%` | `official_quota_warn`（含受影响官方模型） |
| `critical` | `usedPercent ≥ criticalPercent` | `95%` | `official_quota_critical` + `client_send_may_be_locked` |
| 耗尽 | `usedPercent ≥ 100` | `100%` | 额外 `official_quota_exhausted`（仍不自动行动） |

`evaluateQuota(opts)` 返回（节选）：

```jsonc
{
  "state": "critical",
  "display": "100%",
  "usedPercent": 100,
  "resetsAt": "2026-11-12T00:00:00.000Z",
  "plan": "pro",
  "source": "trusted",
  "thresholds": { "warnPercent": 80, "criticalPercent": 95 },
  "exhausted": true,
  "impacts": [
    { "code": "official_quota_critical", "models": ["gpt-6.1-sol"] },
    { "code": "official_quota_exhausted" },
    { "code": "client_send_may_be_locked" }
  ],
  "actions": [
    { "code": "review_budget_and_usage", "requiresConfirmation": false },
    { "code": "wait_for_quota_reset", "requiresConfirmation": false, "resetsAt": "…" },
    { "code": "prepare_manual_emergency", "requiresConfirmation": true,
      "requires": { "acknowledged": true, "reason": "", "backupPoint": "" } }
  ],
  "prohibited": ["auto_switch_provider", "auto_purchase_api_quota", "logout_official_account", "delete_credentials", "silent_session_provider_change"],
  "automation": { "autoSwitch": false, "autoPurchase": false, "logout": false, "changeSessionProvider": false },
  "emergency": { "active": false, "mode": "normal", "since": null, "acknowledged": false, "reason": "", "backupPoint": "", "timeline": [] },
  "mode": "normal"
}
```

- `officialModels` 由调用方注入（当前目录里属于官方 provider 的模型）；不传时影响说明标记 `scope:'official_provider_models'`，不猜测具体模型。
- `actions` 只是建议；任何切换/应急都需要用户在 UI 上再次确认。

## 4. 应急状态机（手动）

```text
        enterEmergency({acknowledged:true, reason, backupPoint})
normal ───────────────────────────────────────────────▶ emergency
   ▲                                                        │
   └────────────────────────────────────────────────────────┘
        exitEmergency({reason?})   （记录 lastEmergency，可恢复）
```

| 操作 | 前置条件 | 拒绝 code | 成功 code |
| --- | --- | --- | --- |
| 进入应急 | `acknowledged === true` + 非空 `reason` + 非空 `backupPoint` | `acknowledgement_required` / `reason_required` / `backup_point_required` / `already_emergency` | `emergency_entered` |
| 退出应急 | 当前为 emergency | `not_in_emergency` | `emergency_recovered` |

- 缺任一项都**不改变状态**，并返回所需字段模板 `required:{acknowledged:true,reason:'',backupPoint:''}`。
- 时间线：`timeline:[{at, action:'enter_emergency'|'recover', mode, reason?, backupPoint?}]`，最多保留最近 50 条。
- 恢复后 `lastEmergency` 保留进入/恢复时间与原因作为审计证据；`emergency` 置空。
- 状态是普通 JSON（`serializeQuotaState` / `parseQuotaState`），版本 `version:1`，非法输入回退 `normal`。

### 4.1 进入应急必须展示的影响（`EMERGENCY_IMPACTS`）

1. **provider 分组可能改变**：同一会话的归属/可见性取决于客户端如何按 provider 分组。
2. **会话可见性可能改变**：旧会话可能不再出现在当前 provider 列表，不能承诺无缝可见。
3. **通常需要独立实例或重启客户端**：网关不重启用户进程，也不修改运行中的客户端。
4. **官方凭据不复用**：第三方只使用自己的、已授权的上游凭据。
5. **非无缝/可恢复**：应急是手动操作，退出也需要一次显式恢复。

## 5. UI 文案建议

- unknown：**官方额度 UNKNOWN** —— "未获取到可信额度数据。网关不会猜测余额，也不会自动切换；请在官方后台/客户端人工确认。"
- warn（≥80%）：**接近额度上限** —— "继续使用可能很快触发客户端限制。建议降低消耗；不会自动切换到第三方。"
- critical（≥95%）：**额度临界** —— "官方模型请求可能被拒绝，客户端可能锁定发送按钮。若确需第三方应急，请先准备备份点并显式确认。"
- 耗尽（100%）：**额度已耗尽** —— "不会自动切换、购买额度或退出登录。可等待重置（如已知 resetsAt）或手动进入应急态；应急会改变 provider 分组与会话可见性，通常需要独立实例/重启。"
- 应急确认对话框必须包含：原因输入、备份点输入、上述 5 条影响、"我已知晓"勾选（`acknowledged:true`）、以及"这不是无缝切换"的明确提示。
- 恢复入口：提示"退出应急后可能需要再次重启客户端才会回到官方 provider"。

## 6. 安全与脱敏

- 来源对象只取白名单字段；`token` / `apiKey` / 嵌套对象 / 自由文本错误不会进入输出（错误只保留错误码形态，否则收敛为 `quota_unavailable`）。
- `source` / `plan` 标签同样做字符集与长度校验，异常值回退为 `trusted` / `null`。
- 输出不含官方账号 ID、令牌、请求正文或账单明细；只给百分比、阈值、状态与建议。
- 模块不读文件、不发网络请求、不改客户端配置；状态由调用方持久化。

## 7. 验证

```bash
node --test scripts/test/offline/codex-quota.test.mjs   # 6 用例
npm run check && npm test && npm run docs:check && node scripts/check-metadata.mjs
```

覆盖：unknown（无来源/来源失败/抛错/越界）、normal/80/95/100 边界、耗尽动作与禁止项、确认三元组缺失拒绝、进入/重复进入/恢复/重复恢复、状态持久化形状、输出无凭据。

## 8. NOT_RUN 与待授权

- **真实官方额度 API**：来源、鉴权、字段与稳定性未核实（需按计划 §3.1 先核查官方文档/政策）；当前只用注入数据。
- **真实应急端到端**：Desktop/独立实例下的 provider 分组、会话可见性、恢复后的重启行为未验证。
- **UI 集成与持久化接线**：当前为库函数；管理面/UI 与状态持久化文件需另行设计与鉴权（不在本任务写集）。
- **费用与账单**：不读取账单、不估算费用；本模块不做任何购买/充值动作。

## 9. 回滚

纯增量：删除 `src/codex/quota.js`、测试与本文件即可；不改配置、不写状态、无迁移；真实环境未触碰。
