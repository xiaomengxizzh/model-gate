# 独立控制台 v1 契约（纸面冻结候选）

> **状态：纸面契约，未实现、未验收。** 本文件写于 Q04 未 PASS 期间，依据基线 `2a735fb772c5490222130f5eddc3420bd2dca7bd` 的源码、契约与离线测试能力面。没有写任何 GUI 代码，没有启动服务，没有浏览器实跑，没有改动 `src/`、`console/`、`package.json` 或 `scripts/`。现有 `/admin` 与 `/ui-next` 只是参考原型，不是重建完成，也不是 CLI Gate 已过的证据；对照见 [现有控制台对照](../explanation/console-rebuild-comparison.md)。

本文回答三个问题：新控制台每个页面要做什么、每项交互依赖哪条真实 API、在这些 API 冻结前哪些地方只能标 GAP 而不能伪造。它不定义后端实现，也不替代 [管理 API v1](management-api-v1.md)、[管理面 UI 投影](management-ui-projection-v1.md)、[请求生命周期](request-lifecycle-v1.md) 的字段契约；冲突时以已冻结的后端契约为准。

**冻结条件**：Q04 PASS 且 CLI 管理 API 版本、fixture、generation 冻结（N03 交付物）后，由 Lead 与 E 复核本文的端点表；届时把 GAP 表按“已补 / 仍缺 / 不承诺”三态定稿。冻结前任何字段都可能调整，不允许把本文当 API 已经存在的依据。

## 0. 术语与统一口径

| 术语 | 含义 | 不表示 |
| --- | --- | --- |
| 快照（snapshot） | 某资源一次读取的完整投影 + 版本 + 读取时刻 | 实时一致 |
| revision | 资源级并发/新鲜度标识；配置类用 `configVersion`，分页类用游标，事件类用单调事件号 | 语义版本号 |
| 草稿（draft） | 管理员尚未确认的本地编辑，含 `baseVersion` 与不透明扩展字段袋 | 已提交 |
| 请求状态（requestState） | `idle/saving/conflict/unknown/error`，与草稿分离 | 数据状态 |
| 确认（confirm） | 管理员对具体 plan/diff 的显式动作；包括二次输入或复选框 | 自动保存 |
| planId / confirmToken | 服务端签发、绑定管理员+目标+代际+TTL 的一次性凭据 | 可复用的授权 |
| 已知 | 后端明确返回 `proven/enabled` 且未过期 | 探测过 = 可用 |
| 未知 | 没有样本、没有读取权限、或数据过期；必须显示“未知”，不得显示 0 | 失败 |
| GAP | 本文需要、当前源码没有真实路由或语义不足的部分 | 计划中的承诺 |

统一规则：**只渲染真实响应**。任何 API 未返回前显示 loading 骨架；任何字段缺失显示“未知/未采集”；不得用 0、空数组或“正常”占位。

## 1. 页面与导航

### 1.1 信息架构

左栏固定六组，顺序不可随意增加：

| 导航组 | 页面路由（建议） | 承载卡 | 主问题 |
| --- | --- | --- | --- |
| 总览 | `#/overview` | U02 | 服务是否健康、有什么需要处理、最近变化 |
| 连接 | `#/connect/providers`、`#/connect/auth`、`#/connect/models` | U03 | 上游、凭据、模型是否可用且证据充分 |
| 路由 | `#/routing/aliases`、`#/routing/policies`、`#/routing/aggregate`、`#/routing/fallback` | U04 | 请求会走哪条链、为什么、改动后会怎样 |
| 运行 | `#/run/usage`、`#/run/requests`、`#/run/subagents`、`#/run/errors`、`#/run/logs` | U05 | 用量、请求轨迹、子代理、错误与日志 |
| 客户端 | `#/clients/codex`、`#/clients/history`、`#/clients/emergency` | U06 | 如何接入、历史是否兼容、应急边界 |
| 系统 | `#/system/config`、`#/system/access`、`#/system/settings` | U01/U06/U07 | 配置版本与备份、权限、系统设置 |

上栏常驻：实例标识（Host + 端口）、当前 `configVersion`/事件 revision、数据新鲜度（`fresh/stale/unknown` + 相对时间）、全局搜索。全局搜索**只索引非敏感 ID、模型名、别名、provider 名、请求 ID、状态码**；不索引 Key、请求正文、日志正文、`auth.json` 内容。

全局约束：

- 同一页面只有一个主操作（Primary），其余为次操作；危险操作（回滚、删除 Key、应急启用、历史导出）只出现在系统/客户端页，并附带影响说明与确认。
- 诊断错误必须可跳转到相关的 provider、模型或策略；不能只显示一段错误文本。
- 深链接只放路由与筛选 ID；**不得**把 token、Key、完整请求正文、`extraHeaders`、代理 userinfo 放进 URL 或 `location.hash`。
- 未登录/锁定状态不渲染任何资源数据；锁定页只显示“如何解锁”和公开的 `/api/auth` 结果。

### 1.2 页面可用性总表

| 页面 | 当前可用的真实 API | 只靠纸面/API 缺口 | 状态 |
| --- | --- | --- | --- |
| 总览 | `GET /api/status`、`GET /api/auth` | 事件 SSE、统一 revision、用量时序（G-01/G-02/G-03） | 只能做静态骨架与现有快照 |
| 连接 | `GET /api/config`、`GET /api/status`、`POST /api/config/save`、`POST /api/keys`、`POST /api/probe`、`POST /api/model-test` | 上游认证状态、配额事实、能力证据（G-07/G-08/G-22） | 主体可做，认证/配额页缺事实源 |
| 路由 | `POST /api/route-preview`、`GET /api/config`、`POST /api/config/save` | 路由列表/解释、网关配置 plan/apply/rollback（G-09/G-10/G-11） | 只能做配置编辑与单点预演 |
| 运行 | `GET /api/status`、`GET /api/model-stats`、`GET /api/native-usage`、`GET /api/logs` | requests/attempt/diagnostics/events/父子关联（G-02/G-03/G-04/G-05/G-06/G-21） | 只能做聚合与日志尾部 |
| 客户端 | `GET /api/config`、`GET /api/codex/policy`、`GET /api/codex/catalog/status`、`GET /api/codex/config/export` | client-profiles、history、emergency（G-15/G-16/G-17） | 模板与只读摘要可做 |
| 系统 | `GET /api/config`、`POST /api/config/save`、`POST /api/config/reload`、`POST /api/admin-token` | access 角色、settings、备份恢复、统一错误、CSRF（G-12/G-13/G-14/G-19/G-20） | 只能做单管理员令牌模型 |

## 2. 逐页契约

### 2.1 总览（U02）

**主交互**：先看“服务状态 / 需处理的连接 / 错误与限流 / 最近变更”四张状态卡；点任一异常进入对应明细；空系统给出第一步（去连接页新增 Provider）。趋势图默认 24 小时，可切 7/30 天，图下有同数据的表格文本备份。

| 端点 | 方法 | 现状 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `/api/status` | GET | ✅ 真实 | `configVersion`、`startedAt/uptimeMs`、`counters`、`lastServing`、`global.{requests,errors,retries,interrupts,p50,p95,latTrend}`、`providers[].{id,st,hasKey,keySource}`、`models[].{name,requests,errors,tokens,today}`、`cache.alert`、`dialogues`、`nativeUsage` | 唯一的总览聚合源；不含请求级明细 |
| `/api/model-stats?days=1/7/30/90` | GET | ✅ 真实 | 每模型 `{tokens,inTokens,outTokens,hit,miss,hitRate}` 时间桶 | 只覆盖真实模型，不含虚拟模型 |
| `/api/native-usage?days=` | GET | ✅ 真实 | `enabled/source/days/dirLabel/scanned/totals/byDay/byModel/note` | 官方本地会话只读采集，默认关闭；与代理流量分开 |
| `/api/v1/events` | GET (SSE) | ❌ GAP G-02 | `eventId`、`type`、`revision`、`at`、脱敏 ID | 现状只能 15s 轮询；没有 Last-Event-ID |
| `/api/v1/usage` | GET | ❌ GAP G-03 | 时间桶 + 口径（provider/官方本地/估计） | 不能把 `model-stats` 冒充实测总量 |
| `/api/v1/status` | GET | ❌ GAP G-01 | 统一 `revision`、`freshness`、`nextCursor` | 现 `configVersion` 只是配置代际 |

**关键字段处置**：

- `global.latTrend` 是真实样本序列；空数组显示“暂无样本”，不能画一条平线冒充 0 ms。
- `providers[].st.state` ∈ 熔断器状态；`openUntilMs` 是剩余毫秒；必须同时显示文字与图标，不能只用红/绿。
- `nativeUsage.enabled=false` 时显示“未采集（默认关闭）”，不显示 0 token；目录不存在显示明确错误，不显示“正常”。
- `configVersion` 与事件 revision 分开显示；不能用配置版本推断事件新鲜度。

**空态/错误态**：

| 场景 | 呈现 | 禁止 |
| --- | --- | --- |
| 首次启动、无请求 | “尚无流量”，给出接入 CTA 与“数据自服务启动起累计”说明 | 显示 0 请求绿色健康 |
| 配置为空 | “没有 Provider/模型”，链接到连接页 | 显示默认上游为已配置 |
| 401 | 锁屏、清空卡片与缓存、停止轮询/SSE | 保留旧数字 |
| 403 | 只在当前卡片显示“无权读取该资源”，其余卡片保留 | 跳登录 |
| 500/超时 | 卡片级错误 + 脱敏 requestId + 重试按钮 | 自动重试写操作 |
| 数据过期 | `stale` 徽标 + 读取时刻 + 继续显示最后快照 | 把过期当实时 |

**验收前置（U02）**：`GET /api/status`、`GET /api/model-stats`、`GET /api/native-usage` 必须已冻结；事件与用量时序需 G-01/G-02/G-03 补齐，否则 U02 只能验收“无事件/轮询降级”路径，不能签“实时”。

### 2.2 连接（U03：Provider、认证、模型）

**主交互**：新增/编辑 Provider → 写一次密钥引用 → 显示 `hasKey/keySource` 与能力 → 选模型与档位 → 显式确认后才探活/模型测试。任何“检测”按钮旁必须写清是否消耗额度、请求哪个上游、是否只读。

| 端点 | 方法 | 现状 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `/api/config` | GET | ✅ 真实 | `configVersion`、`providers`、`models`、`defaults`、`virtualModels` | 可编辑投影；不含运行时统计/Key |
| `/api/status` | GET | ✅ 真实 | `providers[].{hasKey,keySource,apiKeyEnv,st}`、`models[].{probe,capability,effectiveApi,hostedTools}` | 运行时与证据视图 |
| `/api/config/save` | POST | ✅ 真实 | `{version,providers,models,defaults,virtualModels}` | 整包；`version` 必带；409 不自动重试 |
| `/api/keys` | POST | ✅ 真实 | `{id,key,version}` | Key 只写一次；空值=删除；任何响应不回显 |
| `/api/probe` | POST | ✅ 真实（触上游） | `{id?}` → `{results:[{id,ok,code,ms,err}]}` | 只请求 `/v1/models`，不代表 chat/tool/stream 可用 |
| `/api/model-test` | POST | ✅ 真实（触上游） | `{id?}` → `{result,results:[{id,ok,code,ms,err}]}` | 最小推理请求，可能计费；必须显式确认 |
| `/api/v1/providers/{id}/auth-status` | GET | ❌ GAP G-07 | `configured/mode/freshness/checkedAt/source/displayHint` | 现只有布尔 `hasKey` 与来源枚举 |
| `/api/v1/providers/{id}/quota` | GET | ❌ GAP G-08 | `state/freshness/checkedAt/source/used/limit/unknownReason` | 额度模块存在，但没有 HTTP 路由 |
| 能力证据字段 | — | ❌ GAP G-22 | `proven/unknown/disabled` + `source/time` | 现只有 `capability` 字符串与 probe 结果 |

**关键字段处置**：

- `keySource` 取值来自运行时解析（`keys/env/env-registry/null`）；`apiKeyEnv` 只显示变量名，永不显示变量值。
- `hasKey=false` 与“探测失败”分开：前者是未配置，后者是配置了但上游拒绝。
- `probe`/`model-test` 结果带 `at` 时显示时间；无样本显示“未测试”，不得显示“通过”。
- 模型 `capability`（`chat/embedding/rerank/audio/image/video`）是声明值，不是已验证值；`hostedTools=native|chat-bridge-lossy` 必须原样显示。
- 模型别名、fallback、`providerModels` 的编辑校验以服务端 400 为准；前端只做必填与类型提示。

**空态/错误态**：

| 场景 | 呈现 | 禁止 |
| --- | --- | --- |
| 没有 Provider | 空状态 + “新增第一个上游”；说明 Key 只写一次 | 预填假 baseUrl/假 Key |
| Provider 已配置但无 Key | 黄色徽标“缺少凭据”，提供“设置 Key” | 显示“已连接” |
| Key 加密不可用 | 400 错误原文 + 处置建议（检查主密钥） | 提示保存成功 |
| 探活超时/网络错误 | 每项错误码 + 耗时 + “重试”；保留其它 provider 结果 | 把整页判失败 |
| 409 | 保留表单与草稿，展示 `currentVersion`，让管理员重新加载/对比 | 静默改 version 重发 |
| 403 | 该表单/按钮局部禁用并说明来源/权限 | 清空整页或跳登录 |

**验收前置（U03）**：`/api/config`、`/api/status`、`/api/config/save`、`/api/keys`、`/api/probe`、`/api/model-test` 冻结；认证状态与配额必须补 G-07/G-08，否则“连接页”只能验收密钥与探活，不能签“认证/额度状态准确”。能力证据需 G-22，否则所有能力只能标“声明未验证”。

### 2.3 路由（U04：别名、策略、聚合、Fallback、熔断）

**主交互**：表格选择“直连 / 路由 / 聚合 / 默认链”；抽屉展示规则理由、优先级与拒绝条件；修改前先 dry run 对比候选与拒绝原因；保存走“预览 → 应用/回滚”，冲突保留草稿。熔断与 fallback 的展示必须来自真实运行时状态，不能靠前端推断。

| 端点 | 方法 | 现状 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `GET /api/config` | GET | ✅ 真实 | `models[].{provider,alias,fallbacks,providerModels,api,capability}`、`virtualModels[].directory`、`defaults.directory/provider` | 可编辑路由输入 |
| `GET /api/status` | GET | ✅ 真实 | `providers[].st.{state,openUntilMs}`、`models[].{affinity,probe,requests,errors}`、`lastServing` | 运行时熔断/亲和/最近路由 |
| `POST /api/route-preview` | POST | ✅ 真实 | `{model}` → `hit.type=virtual/model/defaults/unknown` + `directory/quota/quotaState/note` | 单点命中；不触上游；不含候选拒绝理由 |
| `GET /api/v1/routes` | GET | ❌ GAP G-09 | 路由列表 + 优先级 + 能力/预算约束 | 现在只能从 config 反推 |
| `POST /api/v1/routes/explain` | POST | ❌ GAP G-10 | `candidates[]`、`denied[]`（原因码）、`selected`、`budget/quota`、`generation` | `route-preview` 只有命中，没有拒绝原因 |
| `POST /api/v1/config/plans` → `apply` → `rollback` | POST | ❌ GAP G-11 | `{baseRev,patch,rootRef}` → `{planId,redactedDiff,warnings,expiresAt}`；应用绑定管理员/代际/TTL | 现有 `/api/codex/config/{plan,apply,rollback}` 只服务受控 `config.toml`（默认 403 `write_disabled`），不是网关配置事务 |
| 熔断手动复位/阈值 | — | ⚠ 仅配置字段 | `providers[].circuit.{maxFailures,openDurationMs}` | 无运行时手动复位 API |

**关键字段处置**：

- `hit.type=unknown` 必须显示“未命中原因”，不能退化成默认上游成功。
- `virtualModels[].directory[].mode` 只有 `afterAll/onFail`；未知值按无效处理，不猜。
- `quotaState` 来自服务端；前端不自行比较额度或时间。
- `fallbacks` 的跨身份限制以服务端拒绝为准；UI 只能提示“不得跨身份 fallback”，不能自行放行。
- 熔断展示：`state` + `openUntilMs` 倒计时 + 文字；倒计时结束仍需后端状态确认，不自动宣称恢复。

**空态/错误态**：

| 场景 | 呈现 | 禁止 |
| --- | --- | --- |
| 没有模型/虚拟模型 | “尚无路由”，链接到连接页新增模型 | 显示空表为“全部正常” |
| preview 未知模型 | 明确“未命中 + 可能原因 + 下一步” | 自动创建/自动回落 |
| dry run 不可用（GAP） | 按钮禁用并标“契约未冻结” | 伪造候选链或拒绝原因 |
| 保存 409 | 冲突面板：远端版本、N 个字段差异、保留本地草稿/加载最新/复制 | 自动递增 version |
| 保存 400 | 字段级错误定位；保留草稿 | 清空表单 |
| 熔断中 | 黄色状态 + 熔断开始/剩余时间 + 相关请求链接（如有） | 只用颜色 |

**验收前置（U04）**：`/api/config`、`/api/status`、`/api/route-preview`、`/api/config/save` 冻结；路由解释与网关配置 plan/apply/rollback 必须补 G-09/G-10/G-11，否则只能验收“编辑 + 单点预演 + 409”，不能签“预览→应用/回滚”。

### 2.4 运行（U05：用量、请求、子代理、错误、日志）

**主交互**：先用可读摘要与过滤（时间、模型、provider、状态、requestId）找到问题，再 drilldown 到 attempt timeline；父子/子代理关联只有在服务端明确给出时才连线，缺失显示“未关联”。provider 用量、官方本地用量、估计值三类事实分开显示。

| 端点 | 方法 | 现状 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `GET /api/status` | GET | ✅ 真实 | `global`、`dialogues`、`lastServing`、`counters` | 聚合，不含单请求 |
| `GET /api/model-stats` | GET | ✅ 真实 | 每模型时间桶 | 真实模型 token |
| `GET /api/native-usage` | GET | ✅ 真实 | `totals/byDay/byModel/scanned/note` | 只读本地会话 token |
| `GET /api/logs?lines=250/500/1000` | GET | ✅ 真实 | `{lines:string[]}` | 日志尾部，非检索、非持久化分类 |
| `GET /api/v1/requests?cursor=&limit=&filter=` | GET | ❌ GAP G-04 | `items[]`、`nextCursor`、`revision` | 无请求级 API |
| `GET /api/v1/requests/{id}` | GET | ❌ GAP G-05 | `requestId`、`attempts[]`、`reasonCode`、`upstream/model`、`state`、`latency`、`usage{kind,tokens,source}` | 无 attempt timeline |
| `GET /api/v1/usage` | GET | ❌ GAP G-03 | 分口径时间序列 | 现只有按模型 token |
| `GET /api/v1/diagnostics` | GET | ❌ GAP G-06 | 结构化诊断与原因码 | 现只有日志文本 |
| 父子/子代理关联 | — | ❌ GAP G-21 | `parentRequestId`、`childKind`、`toolCallId`（均脱敏/显式） | 无数据模型，不得前端猜 |

**关键字段处置**：

- `usage.source` 必须区分 `provider`（上游返回）、`native`（官方本地日志）、`estimated`（估计）；三者在同一图里用不同标识，不能相加成“总用量”。
- 未知费用/额度显示“未知”，不显示 0 或 $0；不改写失败请求为成功。
- 日志分类（429/超时/5xx）只能标“从当前窗口派生”，并给出样本数与窗口大小；不得冒充全量持久化统计。
- 请求正文、响应正文、工具参数、Prompt 一律不返回、不渲染、不导出。

**空态/错误态**：

| 场景 | 呈现 | 禁止 |
| --- | --- | --- |
| 无请求历史（API GAP） | “请求明细 API 未冻结”，只展示真实聚合与日志 | 用日志行伪造请求卡片 |
| 日志文件不存在/为空 | 明确“无日志/未启用”，给配置入口 | 显示空框假装已加载 |
| 429 限流 | 原因码 + `Retry-After`（若有）+ 建议 | 自动重试或隐藏 |
| 断流/取消 | 终态与“已出帧/未出帧”区分；关联 ID 可复制 | 把取消算成上游失败 |
| 分页断连 | 保留已加载页；重连从游标续；游标失效则重拉第一页 | 拼接重复行 |
| 500/超时 | 脱敏 requestId + 重试；写操作先回读 | 直接重发 |

**验收前置（U05）**：`/api/status`、`/api/model-stats`、`/api/native-usage`、`/api/logs` 冻结；请求/attempt/diagnostics/events/关联必须补 G-02/G-03/G-04/G-05/G-06/G-21，否则只能验收“聚合 + 日志尾部 + 取消/断流展示”，不能签“请求追踪”。

### 2.5 客户端（U06：Codex CLI/Desktop、历史、应急）

**主交互**：接入向导生成可复制的无秘密命令/配置片段；只读诊断；预览最小明文摘要并以新线程导出；应急启用/退出必须有影响确认与回退路径。控制台**不读取** `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.dsh` 或任何凭据文件。

| 端点 | 方法 | 现状 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `GET /api/config` | GET | ✅ 真实 | 模型目录、别名、`api`、能力 | 生成模板的唯一数据源 |
| `GET /api/codex/policy` | GET | ✅ 真实（需显式管理员+回环） | `policy`、`catalog`、`write.available`、`paths`、`routes` | 只描述受控 `config.toml` 写入策略；`write.available=false` 是默认 |
| `GET /api/codex/catalog/status` | GET | ✅ 真实 | 世代/计数/截断 slugs | 不回全量目录 |
| `GET /api/codex/config/export?root=` | GET | ✅ 真实（受控根） | 所拥有字段的归一化投影 | 不返回保留行/凭据/整文件 |
| `POST /api/codex/config/{plan,apply,rollback}` | POST | ✅ 真实（需登记根） | `plan`/`confirmToken`/`backupId`/`409` | `plan`/`export` 无登记根时 404；`apply/rollback` 普通模式 403 `write_disabled`；只服务受控 `config.toml` |
| `GET /api/v1/client-profiles` | GET | ❌ GAP G-15 | profile 模板 + 版本/兼容矩阵 | 现由前端拼模板，无法统一验证 |
| `POST /api/v1/history/diagnose` | POST | ❌ GAP G-16 | `rootRef`、版本/opaque counts、拒绝原因 | `src/codex/history.js` 有函数，无 HTTP 路由 |
| `POST /api/v1/history/export` | POST | ❌ GAP G-16 | 最小明文摘要 + 原件哈希不变 | 迁移写入明确 `not_authorized` |
| `POST /api/v1/emergency` | POST | ❌ GAP G-17 | `plan/activate/restore` + 影响预览 + 审计 | `src/codex/quota.js` 有函数，无 HTTP 路由 |

**关键字段处置**：

- 接入模板只使用占位符与 `location.origin`；不得自动写入用户配置，不得显示“已连接”。
- `/api/codex/policy` 的 `write.available` 是服务端声明；前端不得用本地判断开启写入。
- 历史诊断只接受登记后的不透明 `rootRef`；不得提交路径；不得扫描用户私有根。
- 应急只改“新 profile/新线程”的配置，不自动改账号、不自动充值、不覆盖原历史；退出必须对称恢复。
- 官方额度未知时显示 `UNKNOWN`，不显示剩余百分比。

**空态/错误态**：

| 场景 | 呈现 | 禁止 |
| --- | --- | --- |
| 未登记 history root | 空状态 + “如何登记（运维）”；不提供“扫描 HOME” | 自动探测 `~/.codex` |
| history 诊断不可写 | 明确“只读诊断，不迁移/不改写” | 显示“已迁移” |
| 应急未确认 | 影响清单 + 明确复选框 + 取消 | 单击即启用 |
| 官方额度未知/过期 | `UNKNOWN/stale` + 检查时刻 | 显示 0% |
| `/api/codex/*` 403 | “未启用/需显式管理员/仅回环”说明 | 当作系统故障 |

**验收前置（U06）**：`/api/config`、`/api/auth`、`/api/codex/policy`、`/api/codex/catalog/status`、`/api/codex/config/export` 冻结；client-profiles/history/emergency 必须补 G-15/G-16/G-17，否则只能验收“模板 + 只读摘要 + 403 说明”，不能签“历史迁移/应急”。

### 2.6 系统（U01/U06/U07：配置版本与备份、权限、设置）

**主交互**：查看当前代际与变更；对比/预览/应用（CAS）；备份与恢复只做不透明 ID；权限页区分管理员/观察者能力；设置页只放可写字段并说明哪些必须改配置文件/重启。高风险操作集中在“危险区”，每项都有影响说明与确认。

| 端点 | 方法 | 现状 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `GET /api/config` | GET | ✅ 真实 | `configVersion` + 五大业务键 | 配置投影 |
| `POST /api/config/save` | POST | ✅ 真实 | `version`（CAS）、409 `currentVersion` | 整包保存；支持未知字段保留规则 |
| `POST /api/config/reload` | POST | ✅ 真实 | 无 body；409 `store_conflict` | 丢弃内存视图，不改文件 |
| `POST /api/admin-token` | POST | ✅ 真实 | `{token}`；环境变量优先 | 只影响管理令牌，不回显 |
| `GET /api/auth` | GET | ✅ 真实 | `{needAuth,startedAt}` | 公开；不代表已授权 |
| `GET /api/v1/access` | GET | ❌ GAP G-12 | `role`（admin/viewer）、能力、资源范围 | 现只有单令牌，无角色 |
| `GET/PATCH /api/v1/settings` | GET/PATCH | ❌ GAP G-13 | 可写设置 + 需重启项 + 代际 | `server.*` 目前不可经保存接口修改 |
| `GET /api/v1/config/backups` + `restore` | GET/POST | ❌ GAP G-14 | 不透明 `backupId`、代际、TTL | 现无备份/恢复 API；UI 明确 NOT_SUPPORTED |
| 统一错误信封 + `requestId` | — | ❌ GAP G-19 | `{code,message,requestId,nextAction}` | 现有 `{error:string}` 与 `{error:{message,type}}` 并存 |
| Cookie 会话 + CSRF | — | ❌ GAP G-20 | HttpOnly/SameSite/CSRF 或审查过的内存 session | 现仅 Bearer |

**关键字段处置**：

- `configVersion` 是并发令牌；任何保存都带加载时的版本；不得预递增、不得自动重试 409。
- `clientKey` 三态：省略/掩码=保留，`""`=清空，新值=替换；UI 必须显示“已设置/未设置”，不回显值。
- `server.maxBodyBytes/host/port/keyEncrypted` 只读展示；修改路径必须写明“改配置文件并重启”，不得伪造保存按钮。
- 权限拒绝（403）只隔离当前资源，不重登、不清其它页；401 才锁屏。

**空态/错误态**：

| 场景 | 呈现 | 禁止 |
| --- | --- | --- |
| 无备份能力（GAP） | 明确“无管理 API；按运维文档做停机窗口文件备份” | 提供无效“一键备份” |
| 版本冲突 | 冲突面板 + 远端版本 + 3 个选择（加载/保留/复制） | 静默覆盖 |
| 令牌来自环境变量 | 提示“环境变量优先，面板无法清除” | 显示清除成功 |
| 未保存离开 | `beforeunload` 提醒；切页保留草稿 | 自动丢弃 |
| 权限撤销 | 清当前资源局部并提示；不保留敏感投影 | 继续显示旧数据 |

**验收前置（U01/U06/U07）**：`/api/auth`、`/api/status`、`/api/config`、`/api/config/save`、`/api/config/reload`、`/api/admin-token` 冻结；`/console` 静态入口（G-18）、角色（G-12）、设置（G-13）、备份（G-14）、统一错误（G-19）、会话/CSRF（G-20）必须在 U01/U06/U07 开工前定稿，否则只能验收单管理员 Bearer 路径。

## 3. API 缺口清单（23 项）

下表是本文所有 GAP 的唯一编号源。**“现状”列写真实路径；查不到就写“无”。**

| ID | 维度 | 期望契约 | 现状（真实路径/行为） | 影响 |
| --- | --- | --- | --- | --- |
| G-01 | 状态 | `GET /api/v1/status` 统一 `revision/freshness/nextCursor` | `GET /api/status` 有 `configVersion`，无统一 revision/freshness | U02/U05 |
| G-02 | 事件 | `GET /api/v1/events` SSE + `Last-Event-ID` + 有界回放 | 无；前端只能 15s 轮询 | U02/U05 |
| G-03 | 用量 | `GET /api/v1/usage` 分口径时间序列 | `/api/model-stats` 仅按真实模型 token | U02/U05 |
| G-04 | 请求 | `GET /api/v1/requests` cursor/筛选 | 无 | U05 |
| G-05 | 请求 | `GET /api/v1/requests/{id}` attempt timeline | 无 | U05 |
| G-06 | 诊断 | `GET /api/v1/diagnostics` 结构化原因码 | 无；只有 `/api/logs` 文本 | U05 |
| G-07 | 认证 | `GET /api/v1/providers/{id}/auth-status` | 无；仅 `status.providers[].hasKey/keySource` | U03 |
| G-08 | 额度 | `GET /api/v1/providers/{id}/quota` | 无；`src/codex/quota.js` 未挂载 | U03 |
| G-09 | 路由 | `GET /api/v1/routes` | 无；只能从 `/api/config` 反推 | U04 |
| G-10 | 路由 | `POST /api/v1/routes/explain` 候选+拒绝原因 | `POST /api/route-preview` 只回 `hit` | U04 |
| G-11 | 配置 | 网关配置 `plans/apply/rollback`（planId/redactedDiff/TTL） | 无；`/api/codex/config/*` 只服务受控 `config.toml`（无登记根 404；`apply/rollback` 普通模式 403） | U04/U06 |
| G-12 | 权限 | `GET /api/v1/access` 角色与资源范围 | 无；仅单管理员令牌 | U01/U06/U07 |
| G-13 | 设置 | `GET/PATCH /api/v1/settings` | 无；`server.*` 不可经 `/api/config/save` 修改 | U06/U07 |
| G-14 | 备份 | `GET /api/v1/config/backups` + restore | 无；UI 当前标 NOT_SUPPORTED | U06 |
| G-15 | 客户端 | `GET /api/v1/client-profiles` | 无；模板由前端拼 | U06 |
| G-16 | 历史 | `POST /api/v1/history/{diagnose,export}` | 无 HTTP 路由；`src/codex/history.js` 有函数 | U06 |
| G-17 | 应急 | `POST /api/v1/emergency` plan/activate/restore | 无 HTTP 路由；`src/codex/quota.js` 有函数 | U06 |
| G-18 | 入口 | `/console` 静态入口 + `src/console-assets.js` | 无；现有 `/ui-next` 静态白名单 | U01/U07 |
| G-19 | 错误 | 统一 `{code,message,requestId,nextAction}` | 两种信封并存（`{error:string}` / `{error:{message,type}}`） | 全页 |
| G-20 | 会话 | 同源 Cookie（HttpOnly/SameSite/CSRF）或审查过的内存 session | 无；现仅 Bearer token | U01 |
| G-21 | 关联 | 父子/子代理请求显式关联字段 | 无数据模型；不得前端猜 | U05 |
| G-22 | 证据 | 能力/配置来源 `proven/unknown/disabled` + source/time | 只有 `capability` 字符串与 probe 结果 | U03/U02 |
| G-23 | 回退入口 | 旧 `/admin`、`/ui-next` 与新入口同权限 + 同 CSP/响应头 | `/admin` 无 CSP；旧面板令牌存 localStorage；旧 `/api/*` 无令牌时回环放行 | U07 |

> 注：`/api/v1/*` 命名来自计划建议，当前源码中**不存在**任何 `/api/v1` 路由；上表不代表已经承诺该前缀，冻结时可由 N03 统一命名。现有真实路由以 `src/index.js` 与 [src/codex/api.js](../../src/codex/api.js) 为准。

## 4. 数据层契约

### 4.1 每资源快照 + revision

每个页面维护独立资源条目，禁止用一个全局 `status` 对象承载所有事实：

| 资源 | 快照来源 | revision | 新鲜度 | 失效条件 |
| --- | --- | --- | --- | --- |
| 配置 | `GET /api/config` | `configVersion` | 读取时刻 | 保存/回滚/重载成功；409 后远端前进 |
| 运行时状态 | `GET /api/status` | `startedAt + configVersion` | 轮询/事件时刻 | 进程重启、配置变更、401 |
| 模型统计 | `GET /api/model-stats` | 查询窗口 + 读取时刻 | 读取时刻 | 窗口切换、日期跨天 |
| 原生用量 | `GET /api/native-usage` | `generatedAt` | `enabled/warning/error` | 目录/配置变化 |
| 日志 | `GET /api/logs` | 行数窗口 + 读取时刻 | 读取时刻 | 手动刷新 |
| 事件 | `GET /api/v1/events`（GAP） | 单调 `eventId` | 连接状态 | 断线、缺口、401 |
| 请求列表 | `GET /api/v1/requests`（GAP） | `revision + nextCursor` | 读取时刻 | 游标失效、revision 变化 |
| 客户端/历史/应急 | 各 API（GAP） | 各自 `generation/checkedAt` | 各自标注 | 授权/根变化 |

规则：

- 快照必须携带 `fetchedAt`；超过该资源 TTL 显示 `stale`，但仍可读，禁止自动改写为“实时”。
- 资源 revision 变小（服务重启/回滚）时，清空该资源分页与选中项，重新拉第一页。
- 同一资源同时只有一个 in-flight 读；后发请求覆盖前发请求的结果时，必须校验 revision，旧 revision 结果丢弃。

### 4.2 草稿与请求状态分离

状态机（每张配置表单独立）：

```text
pristine --编辑--> dirty --保存--> saving --200+回读一致--> pristine
                         |              |
                         |              +--409--> conflict --加载最新--> pristine
                         |              +--4xx--> dirty(保留) 
                         |              +--网络/5xx--> unknown --回读--> pristine|conflict|error
                         +--放弃/重载--> pristine
```

- `draft` 存表单值、`baseVersion`、不透明扩展字段袋；`requestState` 只表示网络阶段。
- 首次脏化冻结 `baseVersion`；服务端版本前进只显示“他处已更新”横幅，不重建表单、不改 `baseVersion`。
- 保存成功前，**不得**把草稿写进展示快照，也不得用草稿覆盖 `configVersion`。
- 只有 200 + 回读一致才清 dirty；409 必须保留草稿直到管理员选择。

### 4.3 切换页面与 abort

- 每个路由创建 `AbortController`；离开页面时 abort 该路由**所有只读请求**。
- 已发出的写请求（保存/应用/回滚/Key/应急）**不 abort**；离开页面后结果进入 `unknown`，返回时先回读再决定。
- abort 后不得把 `AbortError` 显示为业务错误；也不得用被 abort 的响应更新快照。
- 路由切换先 abort，再进入 loading；不允许旧页数据在新页闪现。

### 4.4 游标与去重

- 列表类只使用服务端 `nextCursor`，不用 offset 猜页。
- 追加页按稳定 ID（`requestId`、`eventId`、`backupId`）去重；重复项保留最新状态。
- 游标失效/过期：丢弃已追加页，重拉第一页并提示“列表已重置”，不得拼接造成重复或断档。
- 事件流用 `Last-Event-ID` 续传；发现事件号缺口：停止追加 → 重拉快照 → 从快照时刻恢复，期间显示“正在补齐”，不静默跳过。

### 4.5 禁止 optimistic 回写替代管理员确认

- 保存/应用/回滚/Key 更新/应急启用都必须在服务端确认后才更新展示。
- 可以显示“处理中”占位，但不得先改列表为成功、不得先删行、不得先改版本号。
- 服务端响应与回读不一致：标记“保存状态异常”，展示差异，停止后续自动保存。
- 关键数量（provider/model/virtualModel 数）回读不符：提示“配置可能被其他客户端改写”。

### 4.6 保存流程（配置）

1. 读 `GET /api/config`，记录 `baseVersion = configVersion`，构造表单与不透明扩展袋。
2. 本地校验类型/必填/引用；不通过只标字段，不发请求。
3. 生成变更摘要：新增/删除/修改的 provider、model、virtualModel，以及“保留 N 个扩展字段”。
4. 有 G-11 时先 `POST /api/v1/config/plans`，展示脱敏 diff、warnings、TTL；管理员确认后 `apply`。
5. 无 G-11 时 `POST /api/config/save`，必须带 `version: baseVersion`。
6. 200：采纳响应 `status` → 再 `GET /api/config` 回读 → 核对版本与关键字段 → 清 dirty。
7. 409：保留草稿与 `baseVersion`，显示 `currentVersion`，让管理员选择加载最新/查看差异/复制；禁止自动重发。
8. 网络错误/超时/5xx：进入 `unknown`，先回读；版本前进且内容匹配按成功，否则提示“可能未保存”，允许人工重试。

### 4.7 SSE、轮询与多标签

- 有 SSE（G-02）时：只更新投影字段（状态、事件、用量），不重建 dirty 表单；每事件带 revision。
- SSE 断开：指数退避重连；重连后先比对 `Last-Event-ID`；缺口按 4.4 处理。
- 无 SSE/降级：可见页 15s 静默轮询（不进入 loading、不覆盖草稿）；隐藏页暂停；错误退避；401 立即停止。
- 多标签：A 保存后 B 的 `configVersion` 前进 → B 显示“他处已更新”；B 保存仍用旧 `baseVersion` 触发 409，不允许自动合并。
- 轮询/SSE 回调中**禁止**调用保存、探活、模型测试、应急等有副作用操作。

## 5. 安全契约

### 5.1 秘密清单与允许面

| 秘密 | 允许出现 | 禁止 |
| --- | --- | --- |
| 上游 API Key | 服务端内存/加密库；UI 仅送回 `POST /api/keys` | 状态/配置响应、DOM 文本、localStorage、URL、日志、截图 |
| `clientKey` | 掩码 `********` 或“已设置” | 明文回显；掩码当作新 Key 提交 |
| 虚拟模型 Key | `keySet` 布尔 | 值、长度、前后缀 |
| 管理令牌 | 密码输入框（提交后清空）；内存 session | localStorage/sessionStorage、URL、DOM 文本、日志、错误信息 |
| `extraHeaders` | 掩码显示，按需“本次显示” | 持久化、截图、复制到报告 |
| `proxy` userinfo | 只显示协议/主机/端口 | 用户名/密码、完整 URL |
| `auth.json`/会话正文 | 永不读取 | 任何读取、探测、导出 |

附加规则：

- 表单中的 secret 字段使用 `type=password`、`autocomplete=off`、`spellcheck=false`；提交后立即清空变量。
- 任何错误消息不得包含带凭据的 URL、请求头值或上游响应正文；只给脱敏 `requestId`。
- 前端不得把 secret 写入 `console.log`、埋点、异常上报或浏览器缓存。
- 导出/复制功能只导出模板与占位符；导出前执行秘密扫描，命中则阻止。

### 5.2 静态资源、CSP 与第三方

- 服务端为 `/console` 返回与现有 `/ui-next` 同级的响应头：

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none';
  form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
```

- 无第三方脚本/字体/图片/CDN/分析；无内联脚本、无内联事件属性、无 `eval`/`new Function`、无 `innerHTML` 注入动态文本。
- 静态白名单只允许 `/console/**` 的已知扩展名，拒绝 `..`、编码穿越、隐藏文件、符号链接；不提供目录列表。
- 新入口与旧入口必须使用同一权限门禁；旧 `/admin` 的“无令牌回环放行”不得被新入口继承（G-23）。

### 5.3 会话与 CSRF

两条允许路径，二选一，不能混用：

1. **内存 Bearer（当前可实现）**：登录后 token 仅存模块内存；刷新即丢失；每次请求带 `Authorization: Bearer`；401 清空。
2. **同源 Cookie（需审查）**：`HttpOnly`、`SameSite=Strict`、按部署加 `Secure`；配套 CSRF token（双提交或自定义头）与 `Origin` 校验；禁止跨源读取；登出即失效。

无论哪种：`/api/auth` 只回 `needAuth/startedAt`；不泄露令牌是否存在以外的信息；管理请求必须在读 body 前完成鉴权（沿用现有 `/api/codex/*` 顺序）。

### 5.4 权限

- 至少两种能力：`admin`（读写、Key、应急、回滚）与 `viewer`（只读：状态、配置投影、请求、日志脱敏）。
- 授权按资源判定：`viewer` 调写接口返回 403，且不泄露资源内容；`admin` 失权只隔离该资源。
- 旧 `/admin`、`/ui-next`、新 `/console` 共享同一鉴权与来源策略；任何绕过（直接 fetch 旧 API、旧入口写 localStorage、无令牌回环）都算安全缺陷。
- 管理 API 与数据面客户端 Key 分离；`viewer` 不得读取上游 Key 元数据以外的秘密（本来也不回显）。

### 5.5 日志与证据

- 前端不记录请求体/响应体/secret；仅记录 `requestId`、状态码、耗时、路径模板。
- 截图/报告/fixture 不得含 Key、token、`extraHeaders`、代理 userinfo、真实账号或请求正文；使用虚构 canary。
- 调试开关默认关闭；打开时也必须脱敏。

## 6. 故障语义

| 结果 | UI 行为 | 数据/缓存 | 重试 | 证据 |
| --- | --- | --- | --- | --- |
| 401 | 锁屏；清空所有资源快照、DOM、选中项；停止 SSE/轮询；清 token | 不保留 stale 敏感投影 | 不自动重试；等管理员重新解锁 | 登录卡 + 无数据 |
| 403 | 只隔离失权资源/操作；显示 `code` 与“为什么/下一步”；其它页保留 | 不清 token、不清其它资源 | 不自动重试；管理员修权限后手动刷新 | 局部错误 + 其它数据仍在 |
| 409 | 保留草稿与 `baseVersion`；显示远端版本与差异；提供加载/保留/复制 | 不覆盖远端、不自动递增版本 | 由管理员选择后重做 plan | 冲突面板 + 草稿逐字段不变 |
| 400/413 | 字段级错误；保留草稿；不静默裁剪 | 不写盘 | 修正后手动重试 | 错误字段 + 原输入 |
| 429 | 显示原因与 `Retry-After`；禁用自动重试 | 保留最后快照 | 到时间后手动/有界重试 | 限流卡片 |
| 500/超时 | 进入 `unknown`；先回读；显示脱敏 `requestId` 与重试 | 写操作不假定成功 | 只读可重试；写操作先核对 | requestId + 回读结果 |
| SSE 断线 | “正在重连”；缺口提示；有界轮询兜底 | 保留最后 revision，缺口后重拉快照 | 指数退避；401 停止 | 连接状态 + 最后 eventId |
| 离线 | 顶部横幅；不显示假数据；写操作禁用 | 保留快照并标 stale | 恢复后手动刷新 | online/offline 状态 |
| 上游探测超时 | 该项错误码/耗时；其它项保留 | 不把超时当 0 | 单项重试 | 逐项结果 |

统一要求：所有 5xx/超时响应若后端提供 `requestId`，UI 必须显示且可复制；当前该字段缺失（G-19），在补齐前只能显示本地生成的关联码并明确“非服务端 requestId”。

## 7. 无障碍与响应式

### 7.1 键盘与焦点

- Tab 顺序：skip-link → 左栏导航 → 上栏操作 → 主内容 → 页脚；不得用正 tabindex 打乱。
- 路由切换后焦点到主内容标题（`tabindex=-1`）；不是滚回顶部就结束。
- 对话框：打开时焦点进入第一个可操作元素/标题；Esc 关闭；关闭后焦点回到触发按钮；焦点陷阱不逃逸。
- 表格/抽屉/冲突面板全程可键盘操作；禁止只用 hover 才显示的操作。
- 危险确认对话框默认焦点在“取消”，不默认在“确认”。

### 7.2 语义与状态

- 状态色必须同时有文字与图标（如“熔断 · 12s”），不能只靠红/绿。
- `aria-live` 用于 toast、保存结果、SSE 重连；错误用 `role=alert` 并关联字段 `aria-describedby`。
- 表单每个输入有可见 label；必填、错误、帮助文本可被读屏关联。
- 表格有 caption/表头 `scope`；排序/筛选状态可读；空表有说明而不是空白。
- 图表有同数据表格或文本摘要（可展开）；色盲友好；不把图当唯一信息源。

### 7.3 窄屏与动效

- 390px 宽无横向滚动；导航折叠为可滚动横向或抽屉；表格转卡片或允许受控横向滚动并保留列标题。
- 触控目标 ≥ 40×40；按钮/链接间距足够。
- 尊重 `prefers-reduced-motion`；不使用自动播放/闪烁；加载动画可关闭。
- 200% 缩放不丢内容；对比度满足 WCAG AA（正文 ≥ 4.5:1）。

## 8. U 卡验收前置

所有卡当前一律 **WAITING_CLI_GATE**；Q04 PASS 前不得创建 `console/`、`src/console-assets.js` 或改默认入口。

| 卡 | 依赖 | 必须先冻结的 API | 当前 GAP | 可开工条件 | 不能开工的原因 |
| --- | --- | --- | --- | --- | --- |
| U01 独立控制台与访问层 | Q04 | `/api/auth`、`/api/status`、`/api/config`、静态入口契约、鉴权/会话模型 | G-12、G-18、G-20、G-23 | Q04 PASS；N03 公布 access/session/入口契约；旧入口回退方案签字 | 角色/CSRF/入口均未冻结；先把单管理员 Bearer 当最终方案会返工 |
| U02 总览与实时状态 | U01 | `/api/status`、`/api/model-stats`、`/api/native-usage`、事件契约 | G-01、G-02、G-03、G-19 | U01 完成；事件/revision/用量契约冻结；缺口降级路径验收 | 无事件 API；实时只能轮询，不能签“实时” |
| U03 Provider 与模型 | U01 | `/api/config`、`/api/status`、`/api/config/save`、`/api/keys`、`/api/probe`、`/api/model-test`、auth-status/quota | G-07、G-08、G-22 | U01 完成；认证/配额/证据字段冻结 | 没有认证状态与配额事实源；能力只能标“声明” |
| U04 路由与聚合配置 | U03 | `/api/config`、`/api/status`、`/api/route-preview`、`/api/config/save`、routes/explain、config plans | G-09、G-10、G-11 | U03 完成；路由解释与网关配置 plan/rollback 冻结 | 无候选/拒绝原因；无网关配置 plan/rollback |
| U05 请求、额度与诊断 | U02 | `/api/status`、`/api/model-stats`、`/api/native-usage`、`/api/logs`、requests/attempt/diagnostics/events | G-02、G-03、G-04、G-05、G-06、G-21 | U02 完成；请求与诊断契约冻结 | 无请求级 API；父子关联无数据模型 |
| U06 客户端、历史与系统设置 | U03 | `/api/config`、`/api/auth`、`/api/codex/policy`、`/api/codex/config/export`、client-profiles/history/emergency、access/settings/backups | G-12、G-13、G-14、G-15、G-16、G-17 | U03 完成；四组契约冻结；只读/不写客户文件的边界签字 | 历史/应急/备份均无 HTTP 路由；角色未定义 |
| U07 一致性与退役开关 | U04、U05、U06 | U01–U06 全部 + 双入口权限/CSP + 默认切换配置 | G-18、G-23（+所有上游 GAP） | 六页验收绿；旧入口同权限；回退演练通过；Q05 前不切默认 | 无默认切换开关；旧入口权限/CSP 未对齐 |

**Q04 后可立即开工的子集**：U01 是唯一不依赖其它 U 卡的卡。在 N03 冻结 access/session 之前，可先做 **U01a**：`/console` 静态入口骨架、`/api/auth` 锁定/解锁、`GET /api/status` + `GET /api/config` 快照、loading/401/403/409 状态机、键盘/焦点/窄屏。U01a 不得包含角色、CSRF、默认入口切换（G-12/G-20/G-23），这些留 **U01b** 等 N03。

**Q04 前的禁止清单**：

- 不创建 `console/` 目录、不新建 `src/console-assets.js`、不改 `src/index.js` 静态入口。
- 不把 `/ui-next` 改名/复制成“新控制台”冒充重建。
- 不用旧 `/admin` 的令牌模型/localStorage 作为新入口基线。
- 不把 mock fixture、截图或纸面契约标成 GUI_PASS。

## 9. 未实现与未验证

- **未实现**：本文件描述的所有页面、组件、静态入口、SSE、权限、备份与迁移 UI。
- **未执行**：没有启动网关，没有打开浏览器，没有调用任何真实或 mock API，没有运行 UI 测试。
- **未冻结**：本文所有 GAP 与字段仍可能调整；现有 [管理 API v1](management-api-v1.md) 与 [UI 投影契约](management-ui-projection-v1.md) 自身也标“未冻结”。
- **不覆盖**：真实上游认证、真实 Codex/Desktop 连接、真实历史迁移、真实额度、跨平台、生产部署。这些不在本文证据内。
- **资源**：本任务只写文档，未安装/下载任何依赖；无需资源授权。
