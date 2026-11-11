# 历史诊断与官方额度契约 v1（E7/E8 · M4-3a）

状态：**模块侧契约已交付**（`src/codex/history.js`、`src/codex/quota.js` + 两个离线套件）。
管理路由接线属 M4-3b；本页只描述模块对外契约与边界。

> 两条贯穿全篇的纪律：
> 1. **只读承诺**：诊断/迁移预演绝不写真实历史目录（`applySelectiveMigration` 永远 `not_authorized`）。
> 2. **未知不得伪装已知**：额度三态里只有 `fresh` 才能当"当下余额"；`stale`/`unknown` 一律不得渲染成 0% 或 100%。

## 1. 历史诊断（E7）

### 1.1 只读承诺

- `diagnoseHistory` / `planSelectiveMigration` 只读文件：**不写、不改 mtime、不备份、不 rename、不删除**；
  返回前不会创建任何文件（含 `.bak`）。
- 唯一的"写"入口 `applySelectiveMigration()` 恒抛 `not_authorized`；`planSelectiveMigration({apply:true})` 同样抛。
- 迁移只产出**导出计划**（`plan.export`）：相对路径 + sha256 + 字段改动 + 备份建议，供人工/外部工具执行；
  本模块不实现写入。
- 回归用"文件 hash + mtime + 目录清单前后一致"证明零写入（`codex-history.test.mjs` 的只读承诺用例）。

### 1.2 路径根受限（登记制）

不允许调用方传任意路径。**唯一**允许被诊断的是已登记的根：

| 接口 | 行为 |
| --- | --- |
| `registerHistoryRoot({ id, dir, label? })` | `dir` 必须是**绝对路径**、存在、是目录、且本身不是符号链接；成功返回 `{id,label,registeredAt}` |
| `listHistoryRoots()` | 只返回 `{id,label,registeredAt}`，**不含绝对路径** |
| `unregisterHistoryRoot(id)` / `clearHistoryRoots()` | 取消登记/清空（不触碰任何文件） |
| `diagnoseHistory({ rootId })` | 按 id 解析；未登记 ⇒ `history_root_not_registered` |
| `diagnoseHistory({ sessionsDir })` | 只接受"已登记且解析后完全相同"的目录；否则同样拒绝 |

开发/隔离测试的逃生门是显式 `allowUnregisteredRoot: true`：管理面**不得**传这个开关。

### 1.3 拒绝码（稳定，不解析 message）

| 码 | 触发 |
| --- | --- |
| `history_root_required` | 既没给 `rootId` 也没给 `sessionsDir` |
| `history_root_not_registered` | rootId 未登记 / 目录未登记 |
| `history_root_missing` | 登记或诊断时目录不存在 |
| `history_root_not_dir` | 路径不是目录 |
| `history_root_symlink` | 根本身是符号链接（登记时拒绝；登记后被换成链接也会在诊断时拒绝） |
| `history_path_escape` | 遍历中出现越根路径（`relative()` 以 `..` 开头）：跳过并计数 `scanned.escapedPaths` |
| `not_authorized` | 任何写入/应用迁移 |

失败时 `report.enabled=false`，`report.errorCode` 给上面的码；**不做任何文件访问**（根解析失败即返回）。

### 1.4 规模上限（只能调低）

| 项 | 硬上限 | 说明 |
| --- | --- | --- |
| `maxFiles` | 2000 | 达到即停，`truncatedReasons=['files']` |
| `maxTotalBytes` | 128 MiB | "已达"或"再读一个就超"都截断，`truncatedReasons=['bytes']` |
| `maxLineBytes` | 2 MiB | 超长行跳过并计数 `scanned.skippedLongLines`（不解析、不进内存） |
| `maxLinesPerFile` | 400000 | 超限截断，`truncatedReasons=['lines']` |
| `maxNodes` | 5000 | 目录遍历节点上限 |

调用方可用 `limits` **调低**，超过硬上限会被夹回；传 0/负数回落默认。
截断时 `scanned.truncated=true` 且 `scanned.truncatedReasons` 非空，并写入 `notes`——**绝不静默**。

### 1.5 输出与脱敏

- 只回计数、模型/provider 标签、相对路径、sha256、风险码；**不回**消息正文、工具参数、密文、凭据、绝对路径。
- 符号链接跳过并计数（`scanned.skippedSymlinks`）；不可读项计数（`scanned.unreadable`）。
- 损坏 JSONL：命中关键字但 `JSON.parse` 失败的行计入 `scanned.parseErrors`，扫描继续，不整体失败。
- v2 加密内容只判"不可读"（`v2.unreadable=true`），不解密、不删除、不伪造。

## 2. 官方额度（E8）

### 2.1 三态与新鲜度

```
quota -> resolveQuotaSnapshot() -> readFreshTrustedSourceOrReturnUNKNOWN()
```

| 状态 | 条件 | `state` | `display` |
| --- | --- | --- | --- |
| `fresh` | 可信来源 + 读数合法 + `now - observedAt <= maxAgeMs`（边界相等算 fresh） | `normal/warn/critical` | `42%` |
| `stale` | 可信来源 + 读数合法，但观测时间超出窗口 | 固定 `unknown`（`observedState` 保留阈值判定） | `42% (stale)` |
| `unknown` | 无来源 / 来源关闭 / 读取异常 / 读数非法 / **没有可信观测时间**（`freshness_unproven`） | `unknown` | `UNKNOWN` |

- 新鲜窗口：`cfg.defaults.codexQuota.maxAgeMs`，默认 300000（5 分钟），夹在 `[1000, 86400000]`；非法回落默认。
- 实时来源（`readQuota()` 函数）没有时间戳时，观测时间就是 `now`（真的"此刻读的"）；**注入快照**没有时间戳不算新鲜。
- `readFreshTrustedSourceOrReturnUNKNOWN()`：只有 `fresh` 返回 `ok:true`；`stale/unknown` 返回
  `ok:false + freshness + reason`，且 `usedPercent: null`（不得把旧值当现值）。

### 2.2 未知不得渲染成 0%/100%

`state==='unknown'` 时 `display` 恒为 `UNKNOWN`、`usedPercent` 为 `null`（stale 保留原值但标 `(stale)`）。
`exhausted` 只在 `fresh && observedState==='critical' && >=100` 时为真；stale 的 100% 只体现在 `observedExhausted`。

### 2.3 不自动切换身份（D7 硬约束）

`evaluateQuota` 输出 `routing`：

```js
routing: {
  autoSwitch: false,                 // 永远 false
  switchAllowed: emergency.active,   // 只有显式应急态才允许人工切换
  requiresExplicitEmergency: true,
  quotaInsufficient,                 // observedState === 'critical'
  freshness,
  status: 'no_switch' | 'quota_insufficient_requires_explicit_emergency' | 'emergency_manual_switch_only'
}
```

断言：额度 `critical/exhausted` 且未进入应急态 ⇒ `switchAllowed=false`、`changeSessionProvider=false`、
动作列表里没有可自动执行的切换项。**官方订阅不足绝不自动切到账单/第三方身份。**

### 2.4 应急态与审计

- 进入必须 `{acknowledged:true, reason, backupPoint}` 三元组，缺一拒绝且状态不变；重复进入返回
  `already_emergency` 且**不重复记时间线**（幂等）。
- 可选 `subject`（审计标签，如 `official-openai`）：进入/退出都写入时间线。
- 时间线字段固定：`{ at, action, mode, reason, backupPoint, subject }`；`action ∈ {enter_emergency, recover}`。
- `reason/backupPoint` 允许自由文本，但**脱敏**：命中 `sk-… / Bearer / api_key= / password=` 形态即整体替换为
  `[redacted]`；`subject` 只接受安全标签字符，否则置空。持久化 `serializeQuotaState` 只输出白名单字段。
- 恢复（退出）保留 `lastEmergency` 作为审计证据（含 recoveredAt/recoverReason/subject）。

## 3. 版本与兼容

- `HISTORY_DIAGNOSIS_VERSION = 1`、`QUOTA_STATE_VERSION = 1`；新增字段只增不改，持久化解析对非法/旧版本回退 normal。
- 额度配置新增 `maxAgeMs`（可选）；缺省行为与旧版一致，但**注入读数不带 `observedAt` 时按 unknown 处理**
  （这是 M4-3a 的收紧：以前会被当成当下值）。

## 4. 未验证 / 非目标

- 管理路由与 UI 接线（M4-3b）；真实 `~/.codex/sessions` 与真实官方额度 API 未在本卡读取（隔离临时目录 + 注入数据）。
- Windows 符号链接语义、NFS、超大历史目录的性能未验证。
- 额度自动采集（登录态/官方接口）不在本卡：只接受显式注入且可验证新鲜度的来源。
