# A3 桌面配置事务 + 前端修复证据（2026-11-16）

> 工作树：`.agents/worktrees/fix-mg-a3-desktop-ux`，分支 `fix/mg-a3-desktop-ux`，基线 `9a371d3`。
> 证据级别：**离线 PASS_MOCK / PASS_OFFLINE**；浏览器 DOM 为 **PASS_BROWSER（隔离 fixture，无真实模型调用）**。
> 本文件不宣称真实 GPT/Go 付费通过，不宣称已发布、已签收。

## 1. MG-FIX-P1-05：原生多代理配置纳入 ModelGate 托管

- `src/codex/config.js`：`OWNED_SECTIONS` 新增 `agents.go_deepseek`（`description` / `config_file`）；
  `[features].multi_agent` 原已在白名单。新增纯函数 `buildManagedAgentConfig()` /
  `withManagedAgentDesired()`，产出确定性的 `go-deepseek.toml` 字节（model 取聚合目标别名，effort 固定 `medium`，无凭据）。
- `src/codex/desktop-integration.js`：`buildDesired()` 默认注入托管字段（普通/既有配置用户均零手工 TOML；
  `managedAgent:false` 可显式关闭）。preview 增加 `agentChild` 计划与 409 阻断；
  consent token 同时绑定 config.toml 与子文件的 before/after sha；activate 将子文件写入纳入同一事务
  （失败连 config.toml 一并回滚）；deactivate 字节兼容恢复（新建→删除、认领→保持、被改动→409 三方差异，零写入）；
  崩溃恢复、状态、策略导出同步覆盖子文件。
- `bin/mg-desktop.mjs`：启动器改用同一 canonical 字节，消除“启动器 low / 控制台 medium”造成的跨入口 409。
- 非规范化已存在子文件一律视为用户所有：preview `ok:false` + blocked，activate/deactivate 409，绝不覆盖。
- 回归：`scripts/test/offline/agg-desktop-managed-agent.test.mjs`（8/8 PASS），
  覆盖空白用户、既有配置用户、逐字节回滚、认领、用户改动子文件/托管字段 409、显式关闭、崩溃恢复。

## 2. G5：普通用户端到端可操作性

- 连接向导 preview 如实展示 `agentChild` 计划；428 确认请求仅含 `consentToken` + `expectedSha`
  （不夹带 Key/模型切换）；409 子代理冲突给专属说明与三方差异；“退出并恢复”回执带真实 sha。
- 状态竞态与鉴权门控由既有 store 逻辑保证（取消过期响应、403 局部错误不清 token）；未解锁时零管理面请求。
- 离线回归：`scripts/test/offline/ui-v3-managed-journey.test.mjs`（4/4 PASS）。
- 浏览器验收：用脚本自带隔离 headless Chrome（`/usr/bin/google-chrome`，端口 9333，临时 profile，零安装）：
  `node scripts/e2e/ui-v3-browser.mjs --cdp 9333 --suffix -mg-a3` → **11/11 PASS，exit 0**，
  三视口截图落在 `docs/evidence/screenshots/ui-v3-{360x800,768x900,1440x900}-mg-a3.png`；无页面错误、无凭据持久化、无假成功按钮。

## 3. P1-04（前端半）：403 只读状态可解锁

- `api.js` 新增 `adminUnlock()`；`product-status.js` 的 `needs_admin_token` 主操作改为
  `local-admin-unlock`（设置令牌降为次级入口），并新增 `readOnlyReason` 准确投影 403；
  `dashboard.js` 渲染只读说明与解锁方式；`app.js` 的 `unlockAdminLocal()` 调用解锁端点、仅内存 setToken，
  404/403 如实提示并降级（不轮询死循环）。
- 离线回归：`scripts/test/offline/ui-v3-admin-unlock.test.mjs`（5/5 PASS）。

### 3.1 前端期望主代理实现的 API 契约（精确）

- 路径与方法：`POST /api/admin/unlock`
- 请求：`Content-Type: application/json`，body 恒为 `{}`（无参数、无令牌字段）。
  必须同源 + loopback + Origin/Host 校验；不要求全局 `MG_ADMIN_TOKEN` 已设置。
- 成功 `200`，body：
  `{ "ok": true, "token": "<opaque 本地管理会话令牌，仅内存使用>", "scope": "local-admin", "expiresAt": <epoch-ms 或 null> }`
  - 返回的 `token` 必须被 `explicitAdminOf()` 接受为显式管理员，使随后 `/api/aggregation/*`、`/api/codex/*` 不再 403；
    会话级、网关重启即失效、不得落盘/不得写日志。
- 失败：
  - `403` `{ "ok": false, "code": "admin_unlock_denied", "error": "…" }`（非 loopback / 跨源 / Host 不符）
  - `404` `{ "ok": false, "code": "admin_unlock_unavailable", "error": "…" }`（端点尚未实现；前端自动降级到设置页）
- 前端行为：`200` → `setToken(data.token)` 后重新读取快照；`401` 不触发全局锁屏（`authEvent:false`）；
  `403`/`404` 只提示，不清 token、不跳登录、不重复轮询。

## 4. 测试汇总（本工作树，离线）

- `node --test scripts/test/offline/*.test.mjs`：**1262 tests / 1259 pass / 0 fail / 3 skip**（最终复跑）。
  此前一轮曾出现 1 例 `config-transaction.test.mjs` 隔离网关启动抖动，单独重跑 26/26 PASS，最终整轮未复现。
- 定向：desktop+config+transaction 110/110；UI 六套件 71/71；CLI 6/6；订阅/session 7/7；新增四套件 22/22。
- `node --check`：`src/codex/config.js`、`src/codex/desktop-integration.js`、`bin/mg-desktop.mjs`、新增测试均通过。

## 5. 未做 / BLOCKED

- 未连接真实 GPT/Go 付费上游；未触碰真实 `~/.codex`、`config/*.local.json` 或运行中的网关（PID 323092）。
- 未实现服务端解锁端点（属 MAIN；见 3.1）；前端已在 404 时优雅降级。
- 未合并、未推送、未发布；浏览器截图仅为隔离 fixture 证据，不代表真实模型通过。
