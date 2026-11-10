# 浏览器管理面板 Smoke 记录（2026-11-09，MG-009）

**目的**：用真实浏览器（Chrome Headless + CDP）验证管理面板同源加载、真实鉴权、配置保存与回读；补 MG-009 的“浏览器真实鉴权/保存回读”证据。**不替代**完整 UI 交互、双标签 409、托盘与视觉验收。

## 环境与隔离

- Chrome：`/usr/bin/google-chrome` 153.0.8010.36，`--headless=new --remote-debugging-port=9222`，独立 `--user-data-dir=/tmp/mg-chrome-smoke`（不读取日常配置）。
- 网关：本仓库 `src/index.js`，`MG_CONFIG_DIR=/tmp/mg-smoke-cfg`、`MG_CONFIG=/tmp/mg-smoke-cfg/gateway.json`、端口 8899；配置含 1 个上游（mock，含扩展字段 `vendorRateClass`）与 1 个模型（demo，含扩展字段 `vendorCapability`）。未连接真实上游、未使用真实 Key。
- 页面：`http://127.0.0.1:8899/`（同源 API 调用，Origin 校验路径真实生效）。

## 结果

| 检查 | 结果 |
| --- | --- |
| 面板加载 | PASS：`document.title = "MODEL·GATE — 本地模型网关控制台"`；页面显示上游 1 个、模型 1 个（demo）、虚拟模型 0 个；无 console/page error |
| 同源 `GET /api/status` | PASS：`needAuth=false`，models 含 `{name:"demo",capability:"chat"}` |
| 同源 `GET /api/config` | PASS：返回 `configVersion/providers/models/defaults/virtualModels`；含扩展字段 `vendorRateClass`/`vendorCapability`，无运行时字段 |
| 同源 `POST /api/config/save` | PASS：200，`configVersion` 1 → 2；回读后 `vendorRateClass`/`vendorCapability` 保留，`defaults.smokeField` 保留，无 `requests/hasKey` 等运行时字段 |
| 鉴权（本机初始化令牌） | PASS：`POST /api/admin-token` 200；无令牌 `GET /api/config` → 401；正确 `Bearer` → 200；错误令牌 → 401；重置令牌 200 |
| 双标签 409 / dirty baseVersion | NOT EXECUTED（需交互式双标签与面板事件链） |
| 面板拖拽/弹窗/视觉 | NOT EXECUTED（仅页面加载与同源 API 往返） |
| 托盘（Linux/Windows） | NOT EXECUTED（本机无桌面托盘依赖；Windows 未编译） |

## 复现步骤（摘要）

1. 启动隔离网关（`MG_CONFIG_DIR=/tmp/mg-smoke-cfg` + 上面的 gateway.json）；
2. 启动 headless Chrome（CDP 9222）；
3. 打开 `http://127.0.0.1:8899/`，执行同源 XHR：`GET /api/status` → `GET /api/config` → `POST /api/config/save`（带 version）→ 再 `GET /api/config` 回读；
4. 执行 `POST /api/admin-token`（设置/校验/重置）并重复 `GET /api/config` 的 401/200 断言。

**清理**：smoke 网关与 Chrome 已停止；`/tmp/mg-smoke-cfg`、`/tmp/mg-chrome-smoke` 为临时目录。本记录不含真实令牌/Key/账号。
