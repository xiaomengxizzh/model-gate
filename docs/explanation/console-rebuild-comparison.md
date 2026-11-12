# 现有控制台对照与迁移/回退

> **一句话结论：现有控制台是参考原型，不是重建完成，也不是 CLI Gate 已过的证据。** 本文件对照旧 `/admin`（[`src/admin.html`](../../src/admin.html)）与 `/ui-next`（[`app.js`](../../src/ui-next/app.js)）在基线 `2a735fb772c5490222130f5eddc3420bd2dca7bd` 上的能力面，说明哪些交互可以参考、哪些不能继承、哪些测试可以复用，以及新入口默认切换与回退的判据。所有 U 卡（U01–U07）当前一律 **WAITING_CLI_GATE**；Q04 PASS 前不得动正式 GUI，不创建 `console/`，不改 `src/index.js` 静态入口。

目标契约见 [独立控制台 v1 契约](../contracts/console-v1.md)；字段事实以 [管理 API v1](../contracts/management-api-v1.md)、[管理面 UI 投影](../contracts/management-ui-projection-v1.md)、[/ui-next 适配矩阵](../contracts/ui-next-api-matrix.md) 为准。

## 0. 证据边界

- 本文依据源码、契约文档、离线测试文件与既有浏览器证据做**静态对照**；本轮没有启动网关、没有打开浏览器、没有跑测试。
- 仓库内 `docs/evidence/2026-11-09-integration/` 的 14/14 浏览器验收与截图属于 `integration/modelgate-next` **当时的候选 SHA**，不是当前基线的运行证据，也不能证明 CLI Gate；只能参考其用例设计。
- `/ui-next` 的“已实现/已测”描述来自 [适配矩阵](../contracts/ui-next-api-matrix.md) 与离线测试，仍明确区分 PASS/PARTIAL/NOT_SUPPORTED；不把静态检查当浏览器验收。
- 旧 `/admin` 与 `/ui-next` 都只是前端调用同源管理 API 的页面，不是独立服务；它们的存在不代表 G3 开始。

## 1. 对照对象

| 对象 | 位置/入口 | 形态 | 与基线的 Git 关系 |
| --- | --- | --- | --- |
| 旧管理台 | `GET /`、`/admin`、`/admin.html` → `src/admin.html`（770 行，内联 CSS/JS） | 单文件、三标签：配置 / 统计 / 日志 | 基线内 |
| 冻结原型 | `GET /ui-next` → `src/ui-next/`（ESM，`app.js` + `js/` + `views/`，含样式约 5.2k 行） | 六路由：总览 / 上游供应商 / 模型与路由 / 客户端接入 / 监控与诊断 / 安全与设置 | 基线内 |
| #4 | 提交 `35bed9b`（2026-11-09） | `fix(ui-next): honor strict CSP and clear stale data on revoked admin auth` | 基线的祖先 |
| #5 | 提交 `1ab84f3`（2026-11-09） | `fix(ui-next): preserve unknown fields and tighten delete/edit guards` | 基线的祖先 |
| A1 | 提交 `6a4e8c2`（2026-11-12） | `fix(ui): 401-only 会话失效 + 用户路径可达的 loading 骨架`（A1 硬化镜像） | 基线的祖先 |
| 新控制台 | 目标 `GET /console`（GAP G-18） | 尚未创建 | 无 |

提交能力点：

| 提交 | 实际改动 | 可继承的行为 | 不能当作 |
| --- | --- | --- | --- |
| `35bed9b` | 严格 CSP 下的布局类调整；401/会话撤销时清空已渲染的 `status/config/logs` | “认证撤销不保留 stale 投影”；CSP 兼容的样式组织 | 完整权限/会话设计；浏览器验收 |
| `1ab84f3` | 模型编辑保留未知字段；provider 删除前检查 `defaults.provider` 与 `defaults.directory` 引用；`extraHeaders`/代理/能力字段空地删除而非写成空串 | 未知字段不静默洗掉；删除前引用检查 | 服务端引用校验的替代 |
| `6a4e8c2` | 只有 401 清会话；功能级 403 局部错误；首屏/刷新/切路由可达 loading 骨架；后台轮询静默 | 401 与 403 分离；loading 不显示旧数据/0 | 409/未知态全链路的证明 |

## 2. 能力面对照

| 能力 | 旧 `/admin` | `/ui-next` | Console v1 目标 | 对照结论 |
| --- | --- | --- | --- | --- |
| 入口与模块 | `/` 默认，单文件内联脚本 | `/ui-next` 显式入口，ESM 模块 | `/console` 独立入口 + 共享资产层 | 可参考目录结构，不可直接复制 |
| 会话/鉴权 | Bearer；token 存 `localStorage('mg-token')`；按 `mg-startedAt` 记住实例；401 弹框 | Bearer 仅内存；25s abort；401 清 token/数据/锁屏；403 局部 | 内存 Bearer 或同源 Cookie+CSRF；角色化 | **不能继承旧 token 持久化** |
| 导航 | 顶部三标签 + 单页滚动 | 左栏六路由 + hash 深链 + 上栏状态 | 六组左栏 + 上栏实例/revision/新鲜度/搜索 | 可参考 ui-next 导航 |
| 总览 | 统计标签：累计、延迟画布、健康、对话、缓存 | 状态卡、趋势、上游健康、关注项（派生并标注） | 状态/待办/错误/最近变更 + 事件 revision | 可参考卡片与空态；不能签“实时” |
| Provider | 列表 + 编辑 + Key + 探活 | 状态/配置分离；Key 只写；header 掩码；409 | 同左 + auth-status/quota 事实 | 可参考读写分离 |
| 认证 | 管理令牌设置/清除 | 同左；环境变量优先提示 | 角色/会话/CSRF + 上游认证状态 | 仅管理令牌，不是完整权限 |
| 模型 | CRUD + 能力 + 别名/fallback + 虚拟模型 | 同左 + 证据标签 + `effectiveApi/hostedTools` | 同左 + 能力证据 freshness | 可参考能力标签的“未验证”口径 |
| 路由/别名 | 编辑 + 单点预览 | 编辑 + route-preview + 关系可视化 | routes/explain + plan/apply/rollback | 可参考编辑/预览，不可签解释 |
| 聚合/虚拟模型 | 目录顺序、模板存 localStorage | 目录顺序、409 草稿、未知字段保留 | 同左 + 预算/权限/租户边界 | **模板不能继承 localStorage** |
| 配置保存 | 从 `status` 反推后整包保存 | 从 `/api/config` 读、`_extra` 保留、409 冲突 | 快照+revision、草稿分离、readback | 不可继承 status-as-config |
| 熔断 | 显示 state/openUntil | 显示 state/openUntil | 同左 + 原因/关联请求 | 只能展示运行时事实 |
| 用量 | 全局/模型统计 + 画布 | model-stats 1/7/30/90 + native-usage | 分口径 usage + 时间序列 | 不可把两类相加 |
| 请求历史 | 无 | 无（只有聚合/对话） | requests + attempt timeline | 缺 API（G-04/G-05） |
| 子代理关联 | 无 | 无 | 显式父子/子代理关联 | 缺数据模型（G-21） |
| 错误/日志 | 日志尾部 + 文本高亮 | 日志尾部 + “派生分类”明确标注 | diagnostics + 原因码 + requestId | 不可把派生当全量 |
| 客户端接入 | 无（仅上游配置） | Codex/DSH/SDK 模板 + 诚实标签 | profiles + 只读诊断 + 版本矩阵 | 模板可参考，不能宣称已连接 |
| 历史 | 无 | 无 | history diagnose/export | 模块有、API 无（G-16） |
| 应急 | 无 | 无 | emergency plan/activate/restore | 模块有、API 无（G-17） |
| 备份/恢复 | 无 | 明确 NOT_SUPPORTED | backups + restore | 缺 API（G-14） |
| 权限/角色 | 单管理员令牌 | 单管理员令牌 | admin/viewer + 资源隔离 | 缺 API（G-12） |
| CSP/响应头 | `/admin` 无 CSP/nosniff | 严格 CSP + nosniff + no-referrer + no-store | 同 ui-next | **不能继承旧入口头** |
| SSE | 轮询/定时器 | 15s 轮询 | SSE + Last-Event-ID + 兜底 | 缺 API（G-02） |
| 窄屏/主题 | 有响应式与主题 | 390/768/1024/1440 + 明暗 + reduced-motion | 同左 + 图表表格备份 | 可复用验收点 |
| 默认入口 | `/`、`/admin` | `/ui-next` 显式 | 切换需配置/判定，当前无开关 | 缺回退开关（G-18/G-23） |

## 3. 可以参考的交互

只参考“交互形状与信息层级”，不复制实现：

1. **锁定 → 解锁 → 首屏 loading → 数据**：ui-next 的锁定页只暴露 `/api/auth`；任一 API 返回前显示骨架，不用 0/旧值占位（`6a4e8c2`）。
2. **401 与 403 分离**：401 清 token/数据/锁屏；功能级 403 只让当前视图局部错误（`6a4e8c2`）。这是 Console v1 故障语义的直接来源。
3. **409 冲突面板**：保留草稿、显示远端版本、提供“加载最新/查看差异/复制”，绝不静默覆盖（旧 admin 与 ui-next 都有雏形；ui-next 的草稿冻结更完整）。
4. **未知字段不静默洗掉**：编辑 provider/model 时把不认识字段放进不透明袋，保存前合并（`1ab84f3`）。这是 `/api/config` 整包替换语义下必须保留的行为。
5. **删除前引用检查**：删除 provider 前检查模型/虚拟模型/默认目录引用（`1ab84f3`），避免保存时才 400。
6. **Key 只写一次**：输入框 `type=password`，只显示 `hasKey/keySet`；掩码回存=保留；保存后清空输入（旧 admin/ui-next 均有）。
7. **探活/模型测试显式确认**：按钮旁说明会触上游、是否可能计费；结果逐项显示 `ok/code/ms`（ui-next）。
8. **配置读→改→存**：用 `GET /api/config` 而非 `status.providers/models` 构造表单；保存带 `version`；成功后回读（ui-next 的方向；Console v1 强化）。
9. **Codex 接入诚实标签**：“已配置/Mock/真实客户端/真实上游/降级或不支持”分级；不自动探测客户端（ui-next 客户端页）。
10. **只读的 Codex 策略探测**：`/api/codex/policy` 成功才展示写入能力，失败回落 export-only，不编造（`codex-api.test.mjs` 覆盖）。
11. **可访问导航**：skip-link、`aria-current`、路由切换焦点到主内容、`aria-live` toast、Esc 关闭对话框（ui-next）。
12. **窄屏与主题**：390/768/1024/1440 无横向溢出；明暗主题；`prefers-reduced-motion`（证据目录有截图与 14/14 用例）。

## 4. 明确不能继承的部分

| 不能继承 | 原因 | Console v1 的处理 |
| --- | --- | --- |
| 旧 `/admin` 把管理令牌放 `localStorage` | XSS/共享设备/截图可窃取；刷新后仍有效 | 仅内存 Bearer，或审查后的 HttpOnly Cookie+CSRF |
| 旧 `/admin` 按 `startedAt` 记住令牌 | “同实例免登录”扩大暴露面 | 每次会话重新解锁；不持久化 |
| 旧 `/admin` 无 CSP/nosniff 等头 | 内联脚本/样式使 XSS 面更大 | 严格 CSP、无内联、静态白名单 |
| 旧 `/admin` 用 `/api/status` 反推配置再整包回存 | 会把统计/探针/掩码字段写回配置或误删未知字段 | 只读 `/api/config`；显式白名单+不透明袋+readback |
| 旧 `/api/*` 的“未设令牌 ⇒ 回环放行”语义 | 新入口若沿用等于无鉴权 | 新入口显式管理员；旧入口同权限（G-23） |
| 旧面板的前端模板存 `localStorage` | 目录/凭据元数据外泄、跨标签污染 | 草稿仅内存；模板由服务端/显式导出 |
| 旧面板“有数据即正常”的颜色/健康判定 | 可能把未知/过期显示成绿色 | 状态必须带文字+图标+时间/来源 |
| ui-next 的 `/api/codex/policy` 探测当作写权限 | policy 成功不代表 managed root 可用 | 以 `write.available`/服务端 403 为准 |
| ui-next 的“已实现”描述 | 多数是静态/离线测试，浏览器未全跑 | 以 Q05 GUI_PASS 与当前 SHA 收据为准 |
| 14/14 浏览器验收与截图 | 属旧候选 SHA/旧 API 面 | 只复用脚本与用例；当前基线必须重跑 |
| 旧入口“复制到 /console”式重建 | 会带入旧权限/存储/CSP 债 | 独立重建，按 [console-v1.md](../contracts/console-v1.md) |

## 5. 可复用的测试与夹具

复用测试**代码与断言设计**，不继承结果；任何在当前 SHA 的执行都要重新记录。

| 测试/工件 | 覆盖 | 复用方式 | 不能证明 |
| --- | --- | --- | --- |
| [ui-next.test.mjs](../../scripts/test/offline/ui-next.test.mjs) | 静态树、CSP 头、鉴权、目录穿越；无 `innerHTML` 注入、无凭据持久化、无假数据串 | 直接改路径/改为 `/console` 后复用断言 | 浏览器行为、真实 API |
| [ui-state.test.mjs](../../scripts/test/offline/ui-state.test.mjs) | loading/ready/error 相位；401 清投影 vs 403 局部；409 保留草稿；掩码不提交；去抖/重试；差异脱敏；`expiresAtState`；客户端导出零凭据 | 作为 Console v1 状态机/保存流程的验收蓝本 | 真实多标签、真实后端 |
| [ui-contract.test.mjs](../../scripts/test/offline/ui-contract.test.mjs) | `/api/config` 可编辑/无损/带版本；秘密不回显、Key 独立版本化 | 直接复用，扩展新端点 | 页面视觉/键盘 |
| [config-projection.test.mjs](../../scripts/test/offline/config-projection.test.mjs) | 只读投影无运行时字段/无明文 Key/扩展字段保留；`_extra` 静态检查 | 复用 | 浏览器保存回读 |
| [admin-entry.test.mjs](../../scripts/test/offline/admin-entry.test.mjs) | 无令牌 403 且不读 body、错/缺令牌、回环+同源、managedRoot 默认关闭 | 复用到新入口/旧入口权限一致性 | 新角色模型 |
| [admin-origin.test.mjs](../../scripts/test/offline/admin-origin.test.mjs) | Host/Origin/跨源、CLI 无 Origin、远程管理 | 复用 | CSRF/ Cookie 会话 |
| [admin-secrets.test.mjs](../../scripts/test/offline/admin-secrets.test.mjs) | 状态/日志/磁盘不泄露明文凭据 | 复用并加新端点 canary | 前端截图/DOM |
| [codex-api.test.mjs](../../scripts/test/offline/codex-api.test.mjs) | 路由/显式管理员/路径护栏/plan/apply/rollback/export/UI 探测失败回落 | 复用 | 网关配置事务 |
| [native-usage.test.mjs](../../scripts/test/offline/native-usage.test.mjs) | 只读采集、默认关闭、目录缺失显式 | 复用 | 代理流量 |
| [ui-fixture.mjs](../../scripts/test/ui-fixture.mjs) | 隔离网关+mock 上游+可复现 UI 流量 | 复用为本地 fixture | 真实上游 |
| [ui-browser-check.mjs](../../scripts/test/ui-browser-check.mjs) + [浏览器验收输出](../evidence/2026-11-09-integration/browser-acceptance.txt) | 登录/锁定、六页、409、XSS、主题、响应式、无异常 | 复用脚本与用例清单；**重跑** | 当前 SHA 的 GUI_PASS（旧证据只属旧候选） |

补充：`ui-next` 的浏览器验收脚本依赖本机已有 Chrome/CDP；没有浏览器时记 `NOT_RUN`，不下载（与 [测试指南](../how-to/testing.md) 的资源规则一致）。

## 6. 迁移判据与默认切换

### 6.1 当前事实

- 默认入口：`GET /`、`/admin`、`/admin.html` → `src/admin.html`；`/ui-next` 需显式访问。
- **没有运行时默认入口开关**：切换默认入口目前只能改 `src/index.js` 路由（共享文件，Lead 负责）。这是 GAP，不是已有能力。
- 旧入口与新入口目前没有共享角色模型；旧 `/api/*` 在未设令牌时仍允许回环访问。新入口不能继承这个语义。

### 6.2 新入口默认切换判据（全部满足才切）

1. Q04 PASS，CLI 管理 API 版本/fixture/generation 冻结（N03）。
2. Q05 GUI_PASS：在隔离后端、当前 SHA 上完成登录/权限/六页/409/401/403/空态/错误/断网/窄屏/键盘验收。
3. 六页能力对照表逐项签字；未实现的 GAP 以“明确不可用/禁用”呈现，不伪造。
4. 新旧入口共用同一鉴权与来源策略；旧入口不能绕过新权限（G-23 关闭）。
5. 无 secret 落入 localStorage/URL/DOM/日志/截图；CSP/响应头与 `/ui-next` 同级。
6. 回退演练通过：能在一个发布候选周期内切回旧入口，且不需要数据迁移。
7. Lead 与 E 记录切换决定、SHA、配置代际与回退点。

### 6.3 旧入口保留与退役条件

| 阶段 | 旧入口状态 | 条件 |
| --- | --- | --- |
| Q04 前 | 保留现状 | 不动入口；不创建 `console/` |
| Q04 后、U01–U07 开发中 | 保留 `/`、`/admin`；`/console` 可显式访问 | 新入口不得静默替换默认 |
| Q05 PASS 后 | 新入口可设默认；旧入口继续可达 | 6.2 全部满足；保留至少一个发布候选周期 |
| 退役 | 移除默认路由或重定向；保留 Git 历史与文档 | R02 给出路径级保留/替代/退役清单；无内部依赖；发布说明记录 |

退役不得删除 `src/admin.html` 的 Git 历史，也不得在未签收时用 404 隐藏旧入口。

### 6.4 回退步骤（默认入口切回旧面板）

1. 触发条件：新入口出现 P0（泄密/越权/不可登录）或关键页面不可用，且无法在窗口内修复。
2. 把默认入口切回 `/admin`/`src/admin.html`（当前需改 `src/index.js` 路由；未来应有配置开关，GAP G-18/G-23）。
3. 保留 `/console` 静态资源可达或临时禁用；不得删除用户配置/草稿（服务端数据未变）。
4. 验证：`/api/auth` 的 `needAuth`、401/403 行为、旧面板可登录、无 secret 回显。
5. 如果新入口已引入新的配置写路径，先按配置代际核对/回滚（409 不自动覆盖）。
6. 记录：触发原因、切换 SHA、验证命令、未验证项、后续修复卡；不把回退成功当新入口验收。

> 注意：当前没有配置级开关，第 2 步本质是代码回退/重新部署；这正是 U07 必须先做“双入口同权限 + 默认可切换”的原因。

## 7. U01–U07 状态

| 卡 | 状态 | 说明 |
| --- | --- | --- |
| U01 独立控制台与访问层 | WAITING_CLI_GATE | 依赖 Q04；需 access/session/入口契约冻结 |
| U02 总览与实时状态 | WAITING_CLI_GATE | 依赖 U01；需事件/revision/usage |
| U03 Provider 与模型 | WAITING_CLI_GATE | 依赖 U01；需 auth-status/quota/证据字段 |
| U04 路由与聚合配置 | WAITING_CLI_GATE | 依赖 U03；需 routes/explain + 网关配置 plan/rollback |
| U05 请求、额度与诊断 | WAITING_CLI_GATE | 依赖 U02；需 requests/attempt/diagnostics/关联 |
| U06 客户端、历史与系统设置 | WAITING_CLI_GATE | 依赖 U03；需 profiles/history/emergency/access/backups |
| U07 一致性与退役开关 | WAITING_CLI_GATE | 依赖 U04/U05/U06；需双入口同权限与回退开关 |

**Q04 PASS 前禁止**：写 GUI 代码、创建 `console/`、新建 `src/console-assets.js`、改默认入口、把 `/ui-next` 冒充新控制台、把现有截图/测试当当前验收。

## 8. 未验证与后续

- 未执行：浏览器、真实后端、真实上游、历史迁移、应急、备份、跨平台。
- 未验证：新旧入口同权限、Cookie/CSRF 方案、默认切换开关、回退演练。
- 后续：Q04 PASS 后由 Lead 冻结 N03 API，再按 [console-v1.md](../contracts/console-v1.md) §8 的 U 卡顺序推进；Q05 由 E 独立验收，D 不自签。
