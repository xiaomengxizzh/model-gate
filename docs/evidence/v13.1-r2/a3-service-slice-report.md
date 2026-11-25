# A3｜稳定服务资源写切片交付报告

- 日期：2026-11-24
- HEAD：`48325bf0027e583108c66677c7dec15fd5007228`（工作树未提交）
- 最终代码指纹：`e1e4cacf9dcdeb7273df3e70d6082925c1534e609fa4978e44022498885a12d4`
- 结论：**服务创建/编辑/删除切片通过；A3 全范围未完成。**
- 新增大型安装/下载：无；真实付费/GUI 仍未授权。

## 1. 实现范围

- 在现有 provider 配置上增加稳定 `serviceId`，保留 providerId 作为路由兼容键；旧服务显示 `legacy:<id>`，不迁移或重写既有引用。
- 新增 `mg-services/1`：服务列表/详情、创建/更新/删除预览、确认写入、操作回执。
- 预览绑定 action/service/version/requestId/计划 hash，5 分钟一次性；缺失/过期 428，不匹配 409。
- 创建/编辑校验显示名、http(s) 地址、协议、区域；本地/私有地址需显式确认，禁止 URL userinfo、fragment 与云元数据地址。
- 删除影响覆盖模型、虚拟模型池、Codex 目录绑定、聚合 provider；有引用返回 422，不写入。
- 凭据删除与 provider 删除复用同一 keys/local 事务；也可明确选择 retain。
- requestId 幂等回执进程内保留 24 小时；重启后不承诺回执持久，但版本冲突防止重复写。
- 独立 UI 添加/编辑/删除/凭据弹窗，统一 Modal、焦点圈定、Esc、焦点恢复、footer 可达、忙碌防重复提交。
- Key 只提交后端 `/api/keys`，不进入 localStorage、URL、日志、导出。

## 2. 证据

### 真实隔离 HTTP + fixture

`node --test scripts/test/offline/v13-services.test.mjs scripts/test/offline/v13-services-http.test.mjs scripts/test/offline/v13-capabilities.test.mjs scripts/test/offline/v13-capabilities-http.test.mjs`

- 8/8 PASS。
- 创建→编辑→添加模型引用→删除 422→移除引用→删除服务/凭据→同 body 幂等重放。
- 403、404、畸形 ID、`__proto__` 拒绝、过期版本 409、敏感字段 canary、零上游。
- 这是真实 HTTP + fixture，不是真实厂商。

### 真实 Chrome + 真实隔离后端

`node scripts/e2e/ui-v13-browser.mjs`

- 20/20 检查 PASS。
- A3 弹窗创建、预览、确认、凭据保存、编辑、删除影响、确认删除、Esc/焦点恢复。
- 服务弹窗 3 尺寸 × 2 主题 = 6/6，footer 在视口内；页面 6 × 7 × 2 = 84/84。
- 404/500/offline、零上游、localStorage 无 Key、无未捕获 JS 异常。
- 截图：`browser/a3-service-create-dialog-1440.png`、`a2-harness-dark-1440.png`、`a2-harness-light-1440.png`、`a2-pools-dark-1440.png`。
- 原始回执：`browser/a2-browser-report.json`，含最终代码指纹、Chrome 版本、20 项检查、84 页面几何与 6 弹窗几何。

### 全量回归

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS；旧 UI 19/19，新 UI 13/13 |
| `npm test` | 151 suites / 1413 passed / 3 skipped / 0 failed |
| `npm run docs:check` | PASS |
| `node scripts/check-metadata.mjs` | PASS 39 checks |
| `npm run contract:check` | PASS |
| `git diff --check` | PASS |

## 3. 安全与诚实边界

- 新服务 API 不返回完整 status 或配置正文；capabilities 不返回 extraHeaders/proxy。
- 旧 `/api/status`、`/api/config` 的敏感字段收敛仍未完成，A3 P0 继续保留。
- 地址校验不包含 DNS 解析后私网复核；当前管理面仅回环/显式 allowRemote + Host/Origin，不能宣称完整 SSRF 防护。
- 新服务默认只是 configured；health=ok 仅表示熔断状态，不表示权限、额度或真实推理通过。
- 未实现服务启停、ProviderTemplate 版本 API、授权流程、按连接发现、Connection/ConnectionModel、多账户额度/冷却。UI 不展示这些为可用。
- 未实现持久化 Operation/预览/幂等回执；进程重启后需重新预览，不能假装取消已提交事务。

## 4. 下一步

A3 余项按顺序：旧状态/配置敏感字段收敛 → 版本化模板与授权 → 连接/模型稳定 ID 与发现差异 → 多连接额度/冷却。完成后才进入 A4 池与统一预算。当前不满足 A3 全退出门禁。
