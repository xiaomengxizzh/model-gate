# 前端 F0 调用矩阵（MG-009）

状态：F0 契约盘点，2026-11-09，HEAD `b2283ae`。F1/F2 前端尚未开始；本表只回答"要做的 UI 能力，今天有哪些 endpoint、缺什么"，不包含视觉设计、不证明浏览器或真实上游验收。相关契约见 [管理面 UI 投影契约 v1](../../management-ui-projection-v1.md)、[管理 API v1 基线](../../management-api-v1.md)；长期目标见 [前端 F0–F5 计划](../../../roadmap/2026-11-07-frontend-rebuild-plan.md)。

## 现有 endpoint 清单

| 类别 | Endpoint | 鉴权 | 触上游 |
| --- | --- | --- | --- |
| 公开 | `GET /api/auth` | 否 | 否 |
| 管理 | `POST /api/admin-token` | 当前令牌（已启用时） | 否 |
| 读 | `GET /api/status` | 是 | 否 |
| 读 | `GET /api/model-stats?days=` | 是 | 否 |
| 读 | `GET /api/logs?lines=` | 是 | 否 |
| 写 | `POST /api/config/save` | 是 | 否 |
| 写 | `POST /api/config/reload` | 是 | 否 |
| 写 | `POST /api/keys` | 是 | 否 |
| 只读计算 | `POST /api/route-preview` | 是 | 否 |
| 探测 | `POST /api/probe` | 是 | **是** |
| 测试 | `POST /api/model-test` | 是 | **是** |

除 `/api/auth` 外均受 MG-001 来源策略约束（Host/Origin/本机限制）；未配置令牌时远程管理请求 403。

## 调用矩阵

| 编号 | F0 能力（用户故事） | 现有 endpoint | 读/写 | 今天可拿到的数据 | 缺口 / 风险 | F1/F2 行动 |
| --- | --- | --- | --- | --- | --- | --- |
| F0-01 | 打开面板并确认是否需要登录 | `/api/auth`；`/api/status` 验证令牌 | 读 | `needAuth`、`startedAt` | 令牌存 `localStorage`；重启后按 `startedAt` 重新登录 | F1 改为会话级凭据 + 明确登出；不把令牌写日志 |
| F0-02 | 看运行状态、uptime、请求/错误/token | `/api/status` | 读 | `counters/global/startedAt/uptimeMs` | 轮询 3s；无推送；`configVersion` 与统计混在同一投影 | F2 抽"运行状态"视图；轮询只更新投影 |
| F0-03 | 看按天/小时模型用量 | `/api/model-stats?days=` | 读 | 每模型桶（token/in/out/hit/miss） | 不含虚拟模型；`days` 夹取 1–90；无同比/导出 | F3 图表与导出；不改服务端前先本地聚合 |
| F0-04 | 看日志尾部 | `/api/logs?lines=` | 读 | 文本行（默认 200，上限 5000） | 只读尾；无级别过滤/搜索；日志可能含错误摘要 | F3 过滤与脱敏提示；不得提供"下载原始日志"到公开位置 |
| F0-05 | 读取可编辑配置 | 无专用 endpoint，只能 `/api/status` | 读 | 投影中的 `providers/models/defaults/virtualModels` | 配置与统计混在一起；无原始配置投影；`undefined` 字段消失 | F1 催生 `GET /api/config` 只读投影（需改 src）或严格投影适配层 |
| F0-06 | 保存配置 | `POST /api/config/save` | 写 | `{ok:true,status}` | 整包替换；无 PATCH；无 dry-run；未知字段需客户端保留 | F2 保存前 diff/校验；F1 评估 PATCH |
| F0-07 | 新增/编辑/删除上游 | `/api/config/save` | 写 | 保存后 status | 删除靠"整体替换+墓碑"；无单条 endpoint；删除上游不清理其 Key | F2 二次确认 + 引用检查；F1 定义 Key 清理 |
| F0-08 | 设置/删除上游 Key | `/api/keys` | 写 | `hasKey/keySource` | id 无白名单；任意 id 可写入；孤儿 Key；错误只给 `error` 字符串；上游 Key 路径未带 `version` | F2 只允许投影中存在的上游并带 `baseVersion`；F1 落白名单（§8） |
| F0-09 | 探测上游连通 | `/api/probe` | 写（触上游） | `{id,ok,code,ms,err}` + status | 真实请求；需要授权；失败原因可能含上游摘要 | F3 探测前提示计费/授权；默认离线 mock |
| F0-10 | 新增/编辑/删除模型 | `/api/config/save` | 写 | 保存后 status | 引用校验在保存时；无单条 endpoint；运行时字段易被回存 | F2 白名单构造；剥离 `probe/requests/...` |
| F0-11 | 测试模型可调用 | `/api/model-test` | 写（触上游） | `{id,ok,code,ms,err}` + status | 真实计费请求；未知模型 400；批量无进度 | F3 明确"会发真实请求"，逐项结果 |
| F0-12 | 虚拟模型：目录/额度/Key/备注/过期 | `/api/config/save` + `/api/keys` + `/api/route-preview` | 读写 | VM 定义、`keySet`、`expiresAt/note`、路由命中 | VM 未知字段被丢弃；Key 走独立通道；同名删除/重建语义需提示 | F2 表单拆分"配置"与"凭据"；迁移说明 |
| F0-13 | 预演某模型会路由到哪 | `/api/route-preview` | 只读计算 | `virtual/defaults/model/unknown` 四种 hit | 不触上游；未知模型提示依赖已配置 VM | 直接复用；加"为什么这样路由"的解释 |
| F0-14 | 编辑默认参数、代理、超时、目录 | `/api/config/save`（`defaults` 合并） | 写 | 保存后 status | 字段无法经保存删除；代理字段可能含凭据；`extraHeaders` 原样回显 | F2 敏感字段掩码；删除走文件+reload |
| F0-15 | 设置/清除客户端 Key | `/api/config/save`（`defaults.clientKey`） | 写 | 掩码 `********` / `""` | 掩码/空串语义容易误用；环境变量优先；无法经 status 读回真值 | F2 明确三态：不改/清除/替换 |
| F0-16 | 设置/修改/清除管理令牌 | `/api/admin-token` | 写 | `{ok,needAuth}` | 无版本；环境变量令牌无法被面板清除；当前令牌存 localStorage | F1 令牌生命周期与安全存储 |
| F0-17 | 从文件重载配置 | `/api/config/reload` | 写 | `{ok:true}` | 丢弃未保存修改；不返回新 status | F2 先确认再 reload，随后 GET status |
| F0-18 | 处理"他处已更新"冲突 | 依赖 `version` + 409 | 写 | `{error,currentVersion}` | 轮询会刷新 `configVersion`，导致 409 保护失效；无冲突 UI | F2 冻结 `baseVersion`、冲突面板、禁止自动重试 |
| F0-19 | 升级后不丢扩展字段 | 无专用机制 | 写 | — | `providers/models` 整体替换；`virtualModels` 不支持未知字段；`defaults` 合并保留 | F2 不透明袋；F1 评估 PATCH/服务端清洗 |
| F0-20 | 托盘常驻状态 | `/healthz` + `/api/status`（+ `/api/model-stats`） | 读 | 存活、今日 token/请求 | Linux 托盘不读管理令牌；启用令牌后状态可能误显示为停止；Windows 单独实现 | 见 [托盘部署](../../../how-to/tray-deployment.md)；F1 统一只读探活契约 |
| F0-21 | 导出/导入/差异对比配置 | 无 | — | — | 无 endpoint；只能手工备份文件 | F4 评估；不得未经授权读写生产配置 |
| F0-22 | 可访问性/键盘/移动端 | 不涉及后端 | — | — | 当前面板未做系统验收 | F4 独立验收，不在 F0 范围 |

## F0 结论

1. **读侧基本够用**：`/api/status` + `/api/model-stats` + `/api/logs` + `/api/route-preview` 足以支撑状态、统计、日志、路由试算。缺的是"配置投影"与"投影/配置分离"，不是新统计接口。
2. **写侧只有三条粗粒度通道**：整包 `config/save`、单 Key `keys`、令牌 `admin-token`。没有单条 CRUD、PATCH、dry-run、配置 diff；前端必须自己保证完整视图与未知字段。
3. **F0 最大风险不是接口缺失，而是误用现有接口**：
   - 把 status 数组直接回存（会洗字段、带统计）；
   - 轮询刷新版本号（让 409 失效）；
   - 自动重试保存（覆盖他人修改）；
   - 把 `********` 当 Key 回写；
   - 对任意 id 调 `/api/keys`。
4. **建议 F1 先交付"只读壳 + 投影适配层"**：不开放保存按钮；先把 status → 表单模型的映射、不透明袋、冲突状态机做出来，再在 F2 打开写路径。
5. **需要后端配合的缺口**（需单独授权、改 `src`）：只读配置投影（D-6）、`models[*]` 运行时字段清洗（D-2）、`/api/keys` 白名单（§8）、可选的 `providers/models` PATCH（D-4）。本卡不实现。

## 不在本表范围

- F1 视觉/交互实现、F4 可访问性与安全验收、F5 影子部署与入口替换。
- 真实上游计费、真实模型验收、Windows/Linux 托盘实跑。
- 生产 8787、systemd、真实凭据与日志。
