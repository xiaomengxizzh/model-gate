# V13.1 迁移、生产切换与回滚 Runbook

## 当前边界

- 生产入口：`/ui-vnext/`；根 `/` 302 到该入口。`/ui-next/` 仅保留为回滚入口。
- 8787 已于 2026-11-25 22:52:54 CST 按所有者授权切换到 Node v24.22.2；23:18:10 CST 加载最终入口提示后 MainPID `275796`，既有凭据环境 drop-in 保留。
- Codex 本地入口已从失效的 `127.0.0.1:15721` 改为 `http://127.0.0.1:8787/v1`；原配置备份为 `~/.codex/config.toml.bak-pre-production-switch-20261125`。
- 通用“服务面板”托盘 `~/.local/bin/service-panel.py` 的 8787 映射已从 `/ui-next/` 改为 `/ui-vnext/`；原文件备份为 `~/.local/bin/service-panel.py.bak-pre-ui-vnext-20261126`，重启后 PID `664439`。
- 新 API：`mg-capabilities/1`、`mg-services/1`、connections/models/pools/harness-bindings/policies、usage/logs/backups/harnesses。
- 源码中的旧 `/api/config/save` 与 `/api/keys` 已改为预览确认，回滚旧 UI 前需同步回滚这组 API 契约。
- 未提交 git commit；运行源码由 HEAD `48325bf` + 当前代码指纹 `a0df9a9f91fed8620963ce5689d39a5d74e846ecec42b4af6e3d294eaa343123`（176 文件）绑定。

## 隔离预览步骤

1. 选择动态回环端口，创建 OS 临时 `MG_CONFIG_DIR`、`MG_CONFIG`、`MG_KEYS_MASTER`、日志路径与隔离 `CODEX_HOME`。
2. 只放虚构 Key/本地 fixture，不复制生产 Key、auth.json、stats 或日志。
3. 启动 `node src/index.js`，等待 `/healthz`；访问 `http://127.0.0.1:<port>/ui-vnext/`。
4. 验证 capabilities、服务/连接/模型/池/绑定、404/500/offline、route-preview；真实目录发现只访问明确 fixture。
5. Harness 写入另设 `MG_HARNESS_ROOT=<临时目录>`；不设置时只能检测。
6. 结束自己启动的进程并删除临时目录。不得操作 8787 或 systemd。

## 前端回滚

- 仅回滚根入口：将 `src/index.js` 的 `/` 302 目标改回 `/ui-next/`，同步 `src/capabilities.js`、README、契约与三组根路由测试，然后 `systemctl --user restart model-gateway.service`。
- `/ui-next/` 当前仍可直接访问，无需先删 `/ui-vnext`；只有所有者明确要求退役新前端时才移除其请求分支与目录。
- localStorage key `mg.ui-vnext.preferences.v1` 仅含主题/密度/高级导航偏好；清除即恢复默认，不涉及凭据。

## 后端回滚

- 资源 API 集中在 `src/resources/` 与 `src/index.js` 分发；可精确移除新路由和 import。
- `deleteProviderCredentials`/`deleteConnectionCredentials` 是现有事务可选扩展；保留不会触发，除非请求显式传入。
- policies/harnessBindings 是 local 配置新增顶层字段；旧代码会忽略未知字段。回滚代码前先导出脱敏备份并保留原 local，避免旧代码整体保存时丢失这些字段。
- virtualModels 的 poolId/slug/members 等扩展字段旧代码可能丢弃；回滚前必须使用备份或迁移导出，不得直接在旧代码上保存新池配置。
- RequestLedger 接线在 `src/forward.js`/`src/index.js`；回滚需恢复对应发送门禁，不能只删测试。
- Codex 角色目标与目录发布在 `src/codex/*`、`src/aggregation/api.js`；已应用配置使用既有 backup/rollback 恢复，不手工改 auth.json。
- 从 `scripts/test/run.mjs` 精确移除新增 suite，并同步 `package.json`/`scripts/tree-fingerprint.mjs`。

## 数据与兼容

- 新资源仍走 providers/models/virtualModels/defaults/policies/harnessBindings + keys 同代事务，没有第二配置库。
- 代码回滚不撤销已提交资源变更；使用写前备份、导入恢复或逐项反向预览。
- 通用备份默认排除 Key/认证头/代理凭据；真实用户重新授权后才能恢复秘密。
- 预览/confirm/requestId receipt 持久化到 `<config>/resource-operations/<scope>/`；token 仅存 SHA-256。重启后 succeeded 回执可重放，interrupted/unknown 操作禁止自动重跑，必须重新预览或人工对账。
- Harness 备份恢复要求当前配置仍等于 applied hash；第三方修改会 409，拒绝覆盖。

## 生产切换前置条件与结果

1. MG-R009 多租户、持久 Operation/取消、DNS 解析后私网复核、U04 在途删除保护已完成隔离 fixture 验收。
2. V02/V04/V05/V06 自动门禁已通过；V07 仍缺原 35 条权威断言清单，不能以其他测试替代。
3. 同一候选代码指纹通过 U01–U17、MG-R001..R012 所需真实层证据；真实服务/GUI 另获书面授权。
4. 用户批准生产窗口、预算、重启/切根/合并/发布。
5. 切换前备份现有前端、配置、Codex 状态与目录，记录 8787 PID/版本/健康；失败恢复旧 `/ui-next` 与兼容代码。

2026-11-25 所有者明确授权本地 8787 重启、根入口切换与 Codex 端点修复；该授权不包含真实付费测试、push/merge/commit/对外发布，也不解除 V07/xmxz/人工签收阻断。当前切换已通过健康、根路由、Node 版本、环境文件与模型目录核验；最小回滚包为 `.agents/deploy-backup-20261125-225052-local-switch`。
