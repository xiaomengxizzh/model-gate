# /ui-next 控制台 ↔ 管理 API 适配矩阵（2026-11-09 候选版）

源码依据：`src/ui-next/**`、`src/index.js` 的 `makeHandler`；契约细节见 [management-api-v1.md](management-api-v1.md)、[management-ui-projection-v1.md](management-ui-projection-v1.md) 与 [request-lifecycle-v1.md](request-lifecycle-v1.md)。本文件只记录当前前端实际调用与验证边界；不把静态检查或 Mock 通过写成真实上游验收。

状态口径：**PASS** = 代码连通 + 本轮离线/浏览器实跑；**PARTIAL** = 已有安全降级或只覆盖部分路径；**NOT_SUPPORTED** = 后端没有对应能力，界面明确标注而不是伪造按钮。

## 1. 会话与鉴权

| UI 操作 | API | 请求 | 返回 / 错误 | 状态 |
| --- | --- | --- | --- | --- |
| 启动读取鉴权模式 | `GET /api/auth` | 无 | `{needAuth,startedAt}` | PASS |
| 解锁控制面 | `GET /api/status` | `Authorization: Bearer <token>` | 200 / 401 | PASS（错误令牌浏览器实测） |
| 任意请求 401 | 统一拦截 | — | 清空内存令牌、显示锁定页，不保留旧数据 | PASS |
| 令牌持久化 | 无（设计上不调用） | — | 仅模块内存；刷新即丢失；主题偏好是唯一 localStorage 键 | PASS（静态检查） |

## 2. Dashboard｜运行总览

| UI 功能 | API | 关键字段 | 状态 |
| --- | --- | --- | --- |
| 运行状态 / 版本 / uptime | `GET /api/status` | `configVersion,uptimeMs,server,needAuth` | PASS |
| 请求、错误、Token、P50/P95 | `GET /api/status` | `global.*` | PASS |
| 延迟趋势 | `GET /api/status` | `global.latTrend`（真实样本；空则空状态） | PASS |
| 上游健康 | `GET /api/status` | `providers[].st.state/openUntilMs/hasKey` | PASS |
| 最近路由 / 会话 | `GET /api/status` | `lastServing,dialogues` | PASS |
| 缓存提醒 | `GET /api/status` | `cache.alert` | PASS（有值才显示） |
| 关注项 | 派生 | 缺 Key、熔断、空目录、未启令牌、错误率 | PASS（页面标注“仅根据当前状态推导，不触发探活”） |

## 3. Providers｜上游供应商

| UI 操作 | API | 请求 | 返回 / 错误 | 状态 |
| --- | --- | --- | --- | --- |
| 列表 | `GET /api/status` + `GET /api/config` | — | 运行时状态与可编辑配置分离 | PASS |
| 新增/编辑/删除 | `POST /api/config/save` | `{version,providers,models,defaults,virtualModels}` | 200 / 400 / 409 | PASS（浏览器实测 409） |
| 独立 Key 设置/清除 | `POST /api/keys` | `{id,key,version}` | 200 / 400 / 409；不回显 Key | PASS（离线契约 + 浏览器只读检查） |
| 上游探活 | `POST /api/probe` | `{id}` | `{results:[{id,ok,code,ms,err}]}` | PASS（显式确认；仅 GET /v1/models，不代表 chat/tool/stream 可用） |
| 代理 / 自定义头 / 熔断 | 配置字段 | `proxy,extraHeaders,circuit` | 400 校验 | PASS |
| 自定义头值展示 | 前端掩码 | — | 默认 `••••`，点“显示值”仅当前标签页内存 | PASS |

## 4. Models & Routing｜模型与路由

| UI 操作 | API | 请求 | 返回 / 错误 | 状态 |
| --- | --- | --- | --- | --- |
| 真实模型目录 | `GET /api/config` + `GET /api/status` | — | 可编辑定义 + 运行时统计 | PASS |
| 真实模型 CRUD | `POST /api/config/save` | 完整 `models` 映射 | 200 / 400 / 409 | PASS |
| 能力标签 | 配置字段 | `chat/embedding/rerank/audio/image/video` | 服务端白名单 | PASS；`audio/image/video` 标“实验” |
| 别名 / fallback / providerModels | 配置字段 | `alias,fallbacks,providerModels` | 400 交叉引用校验 | PASS |
| 上下文 / Token / 额度 / 并发 / QPS / reasoning | 配置字段 | `maxContext,maxTokensMax,dailyQuota,quota,maxConcurrent,qps,reasoning,effortOptions,effortFormat` | 非负校验 | PASS |
| 虚拟模型 CRUD | `POST /api/config/save` | `virtualModels[]`（有序 directory） | 200 / 400 / 409 | PASS |
| 虚拟模型 Key | `POST /api/keys` | `id=__mg_vm_<name>` | 200 / 400 / 409 | PASS |
| 有效期 / 备注 | 服务端元数据 | `__mg_vm_meta_<name>`；`GET /api/config` 回显 | — | PASS（本轮修复投影缺失，见 §7） |
| 路由预览 | `POST /api/route-preview` | `{model}` | `hit.type=virtual/model/defaults/unknown` | PASS（不触上游） |
| 模型连通测试 | `POST /api/model-test` | `{id}` | 200 / 400；真实推理请求 | PASS（显式费用确认）；audio/image/video 服务端拒绝探测 |
| 关系可视化 | 派生 | 真实模型 ↔ 虚拟模型目录 | — | PASS |

## 5. Clients｜客户端接入

| UI 功能 | 数据来源 | 边界 | 状态 |
| --- | --- | --- | --- |
| Codex CLI / Desktop 模板 | `location.origin` + `/api/config` 模型目录 | 不读取 `~/.codex/config.toml` 或 `auth.json` | PASS（模板可复制；不宣称已连接） |
| DSH 模板 | 同上 | 不读取 `~/.dsh` | PASS |
| OpenAI 兼容 SDK / curl | 同上 | Key 使用占位符 | PASS |
| 验证等级图例 | 静态说明 | 已配置 / Mock / 真实客户端 / 真实上游 / 降级或不支持；控制台无法自动检测 | PASS |
| 协议保真 | 模型 `api` + capability | 原生 `responses` 保真；Chat 桥丢弃 namespace/web_search 并记录 lossy | PASS |
| 能力矩阵 | `/api/config` | 声明能力 ≠ 已验证；逐项标“未验证” | PASS |

## 6. Observability｜监控与诊断

| UI 功能 | API | 边界 | 状态 |
| --- | --- | --- | --- |
| 请求/错误/重试/中断/延迟 | `GET /api/status` | 进程启动以来累计 | PASS |
| 上游成功率 / P95 / 熔断 | `GET /api/status` | 真实计数与熔断器状态 | PASS |
| 模型 Token 趋势 | `GET /api/model-stats?days=1|7|30|90` | 只覆盖真实模型，不含虚拟模型 | PASS |
| 日志窗口 | `GET /api/logs?lines=250|500|1000` | 尾部读取，非全量检索；前端仅本地过滤 | PASS |
| 429 / 超时 / 5xx 分类 | 从当前日志窗口派生 | 明确标注“派生，不是持久化分类指标”；无日志即空状态 | PARTIAL（后端暂无按状态码持久化统计 API） |
| 路由 / 会话结果 | `GET /api/status` | `lastServing,dialogues` | PASS |

## 7. Security & Settings｜安全与设置

| UI 操作 | API | 请求 | 返回 / 错误 | 状态 |
| --- | --- | --- | --- | --- |
| 实例信息 | `GET /api/status` + `GET /api/config` | — | — | PASS |
| 管理令牌更新/清除 | `POST /api/admin-token` | `{token}` | 200 / 400 / 401 | PASS（环境变量优先级提示） |
| 锁定当前控制台 | 前端 | — | 清空内存令牌 | PASS |
| 韧性参数编辑 | 草稿 + `POST /api/config/save` | `defaults.retry/timeout/concurrency/proxyMode` | 400 / 409 | PASS |
| 保存前差异 | 前端 | `diffObjects` | — | PASS |
| 409 冲突 | 前端 | — | 显示冲突对话框；可重新加载远端，禁止静默覆盖 | PASS（浏览器实测） |
| 重新加载配置 | `POST /api/config/reload` | 无 | 200 | PASS |
| 导出脱敏配置 | 前端 | 掩码 header / 代理凭据 / clientKey | — | PASS |
| 备份/恢复 | 无后端 API | — | 界面明确 NOT_SUPPORTED，指导停机窗口文件备份 | NOT_SUPPORTED（有意不伪造） |

## 8. 本轮修复的契约缺口

1. **`GET /api/config` 未回显虚拟模型 `expiresAt/note`**：元数据存于 `keys.__mg_vm_meta_<name>`，投影只输出 name/directory/额度。前端“读→改→保存”会把这些字段当删除而清空。已补回显并加 `offline/ui-contract.test.mjs` 回归。
2. **`GET /api/config` 的 `defaults.clientKey` 永远为空**：只检查 `cfg.defaults.clientKey`，而实际值在加密 keys 库 `__mg_client`。前端无法判断“已设置”，可能误清空。已改为两者任一存在即回显 `********`。
3. **数据面 JSON 分发丢弃 `out.headers`**：429 的 `Retry-After` 无法到客户端。已在 `src/index.js` 两处分发合并 `out.headers`，由 `retry-governance.test.mjs` 严格断言 wire header。
4. **静态资源白名单只覆盖三个文件**：改为只读 `/ui-next/**` 安全解析（扩展名白名单、拒绝 `..`/编码穿越/隐藏文件），保留旧 `/` 与 `/admin`。

## 9. 尚未适配 / 明确不支持

- 按状态码持久化的请求分类、trace 查询、按客户端维度指标：后端暂无 API，诊断页只展示真实可得数据并标注派生口径。
- Web 端备份/恢复：无管理 API；不提供无效按钮。
- 客户端 config/auth 文件探测：安全边界内不做；验证等级无法自动判定。
- 真实上游 429/5xx 故障注入与真实客户端回归：需要单独授权与预算，本轮按 `BLOCKED` 记录（见验收报告）。
