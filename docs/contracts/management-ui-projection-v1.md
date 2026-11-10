# 管理面 UI 投影契约 v1（MG-009 草案，未冻结）

适用提交：`dev/gateway-audit-20261108` / MG-002 `5498c1a` + 本卡工作树（2026-11-09）。**服务端 D-2/D-7 与 §8 白名单已实现**（见 §5.3、§8.4 的状态标注），面板 D-3/D-7 已修，浏览器与托盘实跑仍未执行。本文件是 [管理 API v1 基线](management-api-v1.md)（MG-016）之上的**前端读写契约**，不修改、不替代基线；与基线冲突时以基线为准，本文件只补充"状态投影如何被 UI 读取、配置如何被 UI 回存"。

源码依据：`src/index.js` 的 `buildStatus`（174–229）、`doSaveConfig`（331–454）、`doSaveKeys`（456–474）、`makeHandler`（552 起）；`src/admin.html` 的 `buildCfrom`（632–635）、`ingestStatus`（637–641）、`saveAll`（730–733）。行号是 HEAD `b2283ae` 的快照；源码并行演进后以函数名检索为准。既有回归见 [admin-contract.test.mjs](../../scripts/test/offline/admin-contract.test.mjs)。

**证据边界**：本文件由源码审阅与手写 fixture 派生，不含浏览器真实鉴权、真实保存回读、真实上游、托盘 UI 或视觉验收。相关验收项在 §10 统一标注 **NOT EXECUTED**，不得把本文件当作已通过前端验收的证明。

## 1. 结论先行

1. **`GET /api/status` 是只读投影，不是可编辑配置文档。** 它混有运行统计、探针、掩码凭据与配置快照；其中 `providers` / `models` 是带统计的数组，不是磁盘上的配置映射。
2. **`POST /api/config/save` 是唯一的整包配置写入口。** `providers` / `models` / `virtualModels` 整体替换，`defaults` 顶层合并；写成功后 `configVersion` +1，响应带最新 `status`。
3. **凭据走独立通道。** 上游 Key 与虚拟模型 Key 走 `POST /api/keys`；管理令牌走 `POST /api/admin-token`；任何 Key 都不经 `/api/status` 或 `/api/config/save` 回显。
4. **视图字段与配置字段必须显式分离。** UI 从投影构造"可编辑表单"，保存前剥离统计/探针/掩码字段；不得把 `status.providers` / `status.models` 原样作为请求体。
5. **未知配置字段必须保留。** `defaults` 由服务端合并保留；`providers` / `models` 由于整体替换，只能由客户端用"不透明扩展字段袋"原样回送；`virtualModels` 不支持未知字段。
6. **冲突不自动重试。** 409 表示他处已写入新版本；UI 必须停止保存、呈现冲突、让用户选择"加载最新/保留本地草稿/复制本地修改"，绝不能用新版本号静默覆盖。

## 2. 通道与职责

| 通道 | 职责 | 版本参数 | 副作用 | UI 规则 |
| --- | --- | --- | --- | --- |
| `GET /api/status` | 状态投影：配置快照 + 统计 + 探针 | 无 | 无配置写入 | 只读；用于展示与构造表单初值 |
| `POST /api/config/save` | 编辑 `providers/models/defaults/virtualModels` | 可选 `version`；建议必带 | 写 local、可能写 keys、`configVersion`+1、热重载 | 整包提交；保存前剥离投影字段 |
| `POST /api/keys` | 增删改单个凭据条目 | 可选 `version`；建议必带 | 写加密 keys、`configVersion`+1、热重载 | 只允许已知 id；不并入 config 表单 |
| `POST /api/admin-token` | 设置/清除管理令牌 | 无 | 写加密 keys、热重载 | 独立对话框；不进入配置草稿 |
| `POST /api/config/reload` | 重新读盘并重建路由 | 无 | 丢弃内存视图、不改文件 | 有未保存修改时必须二次确认 |
| `POST /api/probe`、`/api/model-test` | 探测上游/模型 | 无 | **真实请求上游** | 需单独授权；结果只更新投影 |
| `POST /api/route-preview` | 只读路由预演 | 无 | 无 | 不触上游 |

原则：**读投影、写配置、写凭据三条通道不混用**；任何"配置保存"按钮只调用 `/api/config/save`，不隐式调用 keys 或 probe；Key 的"保存"只调用 `/api/keys`。

## 3. 状态投影 schema 与字段处置

### 3.1 顶层字段

| 字段 | 类型 | 来源 | 保存时处置 |
| --- | --- | --- | --- |
| `needAuth` | boolean | `!!state.adminToken` | 投影字段，不保存 |
| `configVersion` | number | local `configVersion` | **并发令牌**；作为保存请求的 `version`，不写回配置 |
| `virtualModels` | array | `state.cfg.virtualModels` + 统计 + keys 元数据 | 整体重建后提交，见 3.4 |
| `providers` | array | `state.cfg.providers` + 统计 + Key 判定 | 映射为对象后提交，见 3.2 |
| `models` | array | `state.cfg.models` + 统计 + 探针 | 映射为对象后提交，见 3.3 |
| `defaults` | object | 固定默认 + `state.cfg.defaults` + `clientKey` 掩码 | 允许部分提交，服务端合并，见 3.5 |
| `server` | object | `server.maxBodyBytes/keyEncrypted/host/port` | **不可经保存接口修改**；只读展示 |
| `startedAt` / `uptimeMs` | number | 进程状态 | 投影字段 |
| `counters` | object | 进程内累计 | 投影字段 |
| `lastServing` | object 或 null | 最近一次服务 | 投影字段 |
| `global` / `cache` / `dialogues` | object/array | 统计与趋势 | 投影字段 |
| 其他顶层字段 | — | — | 服务端只持久化五个业务键（见 4.3），顶层未知字段不保留 |

### 3.2 `providers[]` → 可保存对象

| 投影字段 | 语义 | 保存处置 |
| --- | --- | --- |
| `id` | 上游标识（对象键） | 作为 `providers` 的键 |
| `baseUrl`、`apiKeyEnv`、`pathPrefix`、`api`、`extraHeaders`、`proxy`、`circuit` | 可编辑配置 | 原样提交（`apiKeyEnv` 只是变量名，不是 Key） |
| `hasKey` | 是否解析到 Key | **剥离**，不提交 |
| `keySource` | `keys` / `env` / `env-registry` / `null` | **剥离**，不提交 |
| `keyOk` | 客户端兼容别名（当前 admin.html） | **剥离**；服务端也会剥离该字段 |
| `st` | `{requests,errors,retries,tokens,avgMs,p50,p95,state,openUntilMs,probe}` | **剥离**，不提交 |
| 未识别字段 | 新版本/插件写入的扩展项 | 存入不透明袋，保存时原样回送 |

### 3.3 `models[]` → 可保存对象

| 投影字段 | 保存处置 |
| --- | --- |
| `name` | 作为 `models` 的键 |
| `provider`、`alias`、`fallbacks`、`maxConcurrent`、`qps`、`reasoning`、`effortOptions`、`effortFormat`、`dailyQuota`、`quota`、`maxContext`、`maxTokensMax`、`api`、`providerModels`、`forceNoStream` | 可编辑，原样提交 |
| `probe`、`requests`、`errors`、`tokens`、`today`、`hitRate`、`affinity`、`avgMs` | **剥离**，不提交 |
| 未识别字段 | 不透明袋，保存时原样回送 |

> 当前实现只为 `providers[*]` 剥离 `keyOk/keySource`（`doSaveConfig` 的 `clean` 构造），**不剥离 `models[*]` 的运行时字段**。因此客户端剥离是硬要求；服务端剥离是 F1 待办（§5.3 D-2）。

### 3.4 `virtualModels[]` → 可保存对象

| 投影字段 | 保存处置 |
| --- | --- |
| `name`、`directory`、`quota`、`dailyQuota`、`maxContext`、`maxConcurrent`、`qps` | 可编辑，提交后由 `cleanVms` 重建 |
| `expiresAt`、`note` | 可编辑；服务端写入 `__mg_vm_meta_<name>`（keys 库），不写进 local 的 VM 对象 |
| `keySet` | 投影字段；编辑 Key 走 `/api/keys`（id=`__mg_vm_<name>`） |
| `requests`、`errors`、`tokens`、`today`、`hitRate` | 剥离 |
| 未识别字段 | **不保留**：`cleanVms` 只重建固定字段（§5.1） |

删除虚拟模型时，服务端同步删除 `__mg_vm_<name>` 与 `__mg_vm_meta_<name>`；重新创建同名模型不会继承旧 Key。

### 3.5 `defaults`

`/api/status` 返回的 `defaults` 是"固定默认 + 配置文件 + 掩码"的合并视图，包含 `directory/preheat/retry/timeout/concurrency/extraHeaders/proxy/proxyMode` 以及 `affinityTtlMs/failbackProbe` 等扩展项。

- 保存时服务端做**顶层合并**：请求未回传的键保持当前值。因此 UI 可以只提交改动字段（推荐），也可以提交完整可编辑子集。
- 未知 `defaults` 字段由服务端自然保留，这是当前唯一由服务端保证的未知字段保留路径。
- 代价：**无法经保存接口删除 `defaults` 字段**；删除需要编辑文件后 `/api/config/reload`（运维动作，不在 UI 常规路径）。
- `clientKey` 有值时固定回显 `********`；掩码原样回送=不改，空串=清除，新值=替换（详见 §7）。

## 4. 保存请求契约

### 4.1 请求形状

```jsonc
POST /api/config/save
{
  "version": 7,
  "providers": { "<id>": { "baseUrl": "...", "api": "openai", "apiKeyEnv": "...", "extraHeaders": {}, "proxy": "", "circuit": null, "扩展字段": "原样回送" } },
  "models": { "<name>": { "provider": "<id>", "alias": [], "fallbacks": [], "providerModels": {}, "扩展字段": "原样回送" } },
  "virtualModels": [ { "name": "...", "directory": [], "quota": 0, "dailyQuota": 0, "maxContext": 0, "maxConcurrent": 0, "qps": 0, "expiresAt": "", "note": "" } ],
  "defaults": { "proxyMode": "auto", "clientKey": "********" }
}
```

- 建议总是带 `version`（取表单加载时的 `configVersion`）。不带时服务端按旧客户端宽容接受，但会失去冲突保护。
- 未提交的段=保持当前值；提交的空对象 `{}` 对 `providers` / `models` 表示清空该段（整体替换语义），UI 必须对"清空"二次确认。

### 4.2 客户端构造步骤（强制）

1. 取 `GET /api/status` 快照，记录 `baseVersion = status.configVersion`。
2. 按 §3 的映射构造可编辑表单；对每个 `provider` / `model` 保留一个不透明袋（建议键名 `_extra`，仅客户端内存使用），装入所有不在可编辑白名单内的字段。
3. 保存前执行 `stripProjection()`：删除 §3 列出的投影字段；校验没有把 `hasKey/st/probe/requests/...` 带入。
4. 合并不透明袋到各自条目（若扩展字段与可编辑字段同名，可编辑字段优先，并在 UI 提示冲突）。
5. 发送 `{version: baseVersion, providers, models, virtualModels, defaults}`。
6. 收到 200 后，用响应 `status` 更新视图，并立即 `GET /api/status` 回读核对（§6.5）。

### 4.3 服务端当前语义（must-know）

- 形状校验 `validateConfigShape`：请求体必须是 JSON 对象；`providers/models/defaults` 必须是对象；`virtualModels` 必须是数组；`version` 必须是数字；保留键 `__proto__/constructor/prototype` 一律 400。失败不写盘、不改内存、不推进版本。
- 版本冲突 `versionConflict`：显式 `version` 且不等于当前值 → 409 `{error, currentVersion}`。
- 引用校验：模型引用的上游、`fallbacks`、`providerModels`、默认目录、预热、虚拟模型目录必须存在；失败 400。
- `providers`：剥离 `keyOk/keySource` 后整体写入；`models`：按请求整体写入（**不做运行时字段剥离**）。
- `virtualModels`：`cleanVms` 只保留固定字段；`expiresAt/note` 转存 keys 元数据；删除的 VM 清理 Key 与元数据。
- `defaults`：`Object.assign({}, cur.defaults, body.defaults)`；`clientKey` 按掩码规则处理。
- 墓碑：被删除的上游/模型名写入 local 的 `_removed`；重启后不复活；同名重新加回即撤销。
- 落盘：local 只回写 `configVersion/providers/models/defaults/virtualModels`（有删除时加 `_removed`）；成功 `configVersion+1` 并 `reloadConfig`。
- 响应：成功 `200 {ok:true, status}`，`status` 是保存后的完整投影；失败 `400 {error}` / `409 {error,currentVersion}` / `413`。

### 4.4 `/api/keys` 当前语义

- 请求 `{id, key?, version?}`；缺 `id` 400；`key` 为空/假值=删除；加密失败 400；版本过期 409。
- 成功 `200 {ok:true,status}`，`configVersion+1`，并写 local 的 `configVersion`。
- 当前 `id` **没有完整白名单**（只拒绝空值与保留键），任意非空字符串都能成为 keys 条目（§8）。

## 5. 未知字段保留

### 5.1 服务端保证矩阵

| 配置段 | 保存语义 | 未知字段是否保留 | 依据 |
| --- | --- | --- | --- |
| `defaults` | 顶层合并 | **是**（请求未回传即保留） | `doSaveConfig` 的 `Object.assign` |
| `providers` | 整体替换 | **仅当客户端原样回送**；服务端只剥离 `keyOk/keySource`，其余未知字段会随条目落盘 | `clean` + `localOut.providers` |
| `models` | 整体替换 | **仅当客户端原样回送**；服务端不剥离任何字段 | `localOut.models = models` |
| `virtualModels` | 固定字段重建 | **否** | `cleanVms` |
| local 顶层 | 只写五个业务键 + `_removed` | **否** | `localOut` |
| keys 库 | 读盘合并、按键增删 | 其他 id 保留；未知值原样保留 | `doSaveKeys` |

### 5.2 客户端义务（"无静默洗配置"）

- 不得用 `status.providers/models` 数组直接回存；必须经显式白名单映射。
- 不得丢弃不认识的 `provider/model` 字段；保存前把不透明袋合并回去。
- 保存前至少展示一份**变更摘要**：新增/删除的上游、模型、虚拟模型，以及"保留了 N 个扩展字段"。没有摘要就不提供"一键保存"。
- 不得自动保存、不得在轮询回调里保存、不得把 409 自动重试。
- 不认识的顶层字段不承诺保留；需要长期保留的扩展项应放进 `defaults`。

### 5.3 当前偏离（F1/F2 需处理）

| 编号 | 偏离 | 影响 | 归属 |
| --- | --- | --- | --- |
| D-1 | **已修复（2026-11-09，面板侧）**：`buildCfrom` 把未知字段放进 `_extra`，编辑时 `Object.assign` 保留，`saveAll` 用 `serializeMap` 合并回送 | — | 静态回归见 config-projection.test.mjs；浏览器实跑 NOT EXECUTED |
| D-2 | **已修复（2026-11-09）**：服务端 `doSaveConfig` 以显式 denylist 剥离 `providers[*]`（hasKey/keySource/keyOk/st/probe）与 `models[*]`（probe/requests/errors/tokens/today/hitRate/affinity/avgMs/inTokens/outTokens/latencySum/latencyCount）后再落盘；未知扩展字段保留。面板仍会回送投影字段，但已不再污染配置 | — | 已实现，回归见 `scripts/test/offline/admin-projection.test.mjs` |
| D-3 | **已修复（2026-11-09，面板侧）**：`markDirty` 首次脏化时冻结 `baseVersion`，`ingestStatus` 在 `dirty` 且已冻结时不覆盖 `ST.configVersion`；保存/409/重载成功后清空 | — | 静态回归见 admin-projection.test.mjs；浏览器实跑 NOT EXECUTED |
| D-4 | `providers/models` 无服务端 PATCH/合并；只有整体替换 | 客户端必须自己保证完整视图，升级后旧视图可能删掉新字段 | F1 评估 PATCH 语义（v1.1） |
| D-5 | `virtualModels` 未知字段被 `cleanVms` 丢弃 | 扩展项不能放在 VM 条目上 | 契约接受；扩展项放 `defaults` |
| D-6 | **已实现（2026-11-09）**：`GET /api/config` 返回只读配置投影（五大业务键 + configVersion；剥离运行时字段、不返回 keys/paths、clientKey 掩码） | — | 面板仍走 status，F1/F2 迁移到该端点 |
| D-7 | **已修复（2026-11-09）**：`admin.html` 新增 `postKey()`，上游 Key 保存/删除与虚拟模型 Key 均带 `baseVersion ?? ST.configVersion`，409 提示后加载最新；服务端 `doSaveKeys` 本就有 `versionConflict`。服务端缺省 `version` 仍放行以兼容旧客户端 | — | 回归见 admin-projection.test.mjs（409/当前/缺省三态） |

## 6. 409 版本冲突与刷新反馈

### 6.1 版本语义

- `configVersion` 在每次成功 `config/save` 或 `keys` 写入后 +1；加载/重启不改变它。
- `version` 是**乐观并发令牌**，不是数据迁移版本号；前端不得在未保存时自行 +1。
- 缺 `version` 的请求会被宽容接受，但界面必须始终带版本。

### 6.2 冲突时间线

1. 标签页 A、B 同时读到 `configVersion=7`。
2. A 保存成功 → 服务端版本 8，返回 `status.configVersion=8`。
3. B 仍以 7 保存 → 409 `{error:"配置版本已过期…", currentVersion:8}`。
4. B **不得**把 `version` 改成 8 后自动重发（那会覆盖 A 的修改）；应显示冲突面板：
   - "服务端已是版本 8；你在版本 7 上修改了 N 个字段。"
   - 操作：`加载最新（丢弃本地修改）` / `保留本地草稿并查看差异` / `复制本地修改`。
5. 用户选择"加载最新"后，重新 `GET /api/status`，重建表单，`baseVersion=8`。

### 6.3 状态处理矩阵

| 结果 | UI 行为 |
| --- | --- |
| 200 | 采纳响应 `status`；回读核对；toast"已保存并回读"；清除 dirty；更新 `baseVersion` |
| 400 | 保留 dirty 与表单；展示服务端 `error`；定位到相关字段（可做启发式） |
| 401 | 打开令牌门禁；不重试保存 |
| 403 | 展示来源策略提示（Host/Origin/本机限制）；不要提示用户改令牌 |
| 409 | 进入冲突态；不自动重试；按 §6.2 处理 |
| 413 | 提示请求体超限；禁止静默裁剪配置 |
| 网络错误/超时 | **结果未知**：先 `GET /api/status`；若版本已前进且内容匹配，按成功处理；否则提示"可能未保存"并允许用户手动重试。禁止直接重发 |
| 5xx/非 JSON | 视为未知；回读后再决定 |

### 6.4 轮询与 dirty

- 轮询只更新统计、探针、日志等投影字段；**不得**在 dirty 时重建表单或改写 `baseVersion`。
- 轮询发现 `configVersion` 大于 `baseVersion` 且表单 dirty：显示"他处已更新"预警（黄色横幅），但保留用户输入；保存时仍用旧 `baseVersion`，让服务端返回 409，避免覆盖。
- 若用户选择"接受远端版本"，才重建表单并清 dirty。

### 6.5 保存回读

保存成功不是只信 POST 响应：

1. 用响应 `status` 更新统计与版本。
2. 再 `GET /api/status`，核对 `configVersion` 等于响应值。
3. 核对本次修改的可编辑字段在投影中生效（例如 `defaults.proxyMode`、模型 `fallback`、VM `note`）。
4. 若回读不一致：标记"保存状态异常"，展示差异，禁止继续自动保存。
5. 关键字段（上游/模型/VM 数量）在回读后与预期不符时，提示"配置可能被其他客户端改写"。

### 6.6 `/api/keys` 冲突

同样带 `version`；409 处理与配置保存一致。Key 保存成功后也要回读 `hasKey/keySource` 或 `keySet`，确认掩码状态变化；Key 值本身永不回读。

### 6.7 重载

`/api/config/reload` 会丢弃内存视图但不改文件。dirty 时必须确认"未保存修改将丢失"；重载后 `baseVersion` 取新 `configVersion`，并重建表单。

## 7. 敏感字段与掩码

| 数据 | `/api/status` 行为 | UI 展示规则 | 回存规则 |
| --- | --- | --- | --- |
| 上游 API Key | 永不回显；只给 `hasKey/keySource/apiKeyEnv` | 显示"已配/未配/来源"；不显示值 | 走 `/api/keys`；config 表单不含 Key |
| 客户端 Key | 有值时 `defaults.clientKey="********"`；无值时 `""` | 只显示掩码与"已设置" | `"********"`=不改；`""`=清除；新值=替换 |
| 虚拟模型 Key | 只给 `keySet` | 显示"已设/未设" | 走 `/api/keys`，id=`__mg_vm_<name>` |
| 管理令牌 | 永不回显；`/api/auth` 只给 `needAuth` | 只显示"已启用/未启用" | 走 `/api/admin-token`；环境变量优先，面板无法覆盖 |
| `extraHeaders` | **原样回显**（管理 API 基线 §5 风险项） | 值默认掩码，按需"显示一次"；不写日志/不落 localStorage | 原样回送以保留；视作敏感内存 |
| `proxy` | **原样回显**，可能含 `user:pass@` | 隐藏 userinfo；只显示协议/主机/端口 | 原样回送；不写日志 |
| 日志 | 已脱敏，但可能含上游错误摘要 | 作为诊断只读；不复制到公开报告 | 不适用 |
| 浏览器存储 | 当前 `admin.html` 把管理令牌放 `localStorage`（风险项） | F1 目标：默认不持久化，或提供"仅本次会话"选项与清除按钮 | 不适用 |

补充：

- 掩码不是"新值"：任何把 `********` 当 Key 内容提交到 `/api/keys` 的行为都是错误。
- `apiKeyEnv` 是变量名，可以展示与编辑；不要把它和变量值混为一谈。
- 客户端 Key 还受进程环境变量 `MG_CLIENT_KEY` 控制：它优先于 keys 库。UI 的掩码/清空只影响 keys 库，无法关闭环境变量门禁；状态掩码可能仍然存在。
- 转录/截图/报告不得包含 `extraHeaders`、`proxy` userinfo、任何 Key 或令牌；fixture 规则见 [fixtures/v1/README.md](fixtures/v1/README.md)。

## 8. `/api/keys` 的 `id` 白名单（待定项）

### 8.1 现状

`doSaveKeys` 只拒绝空 `id` 与保留键，其他任意非空字符串都会成为 keys 条目。投影侧能表达的凭据身份只有三类：真实上游 `id`、虚拟模型 `__mg_vm_<name>`、内部键 `__mg_client` / `__mg_admin`（还有 `__mg_vm_meta_<name>` 元数据）。

### 8.2 为什么必须随 MG-009 一起定

1. **投影身份与凭据身份必须一一对应**：UI 只能对投影里存在的上游/虚拟模型提供"设 Key"按钮；接口却允许写任意 id，UI 的合法集合与接口的合法集合不一致。
2. **孤儿 Key**：为已不存在的上游写 Key 会留下永远无法在 UI 里删除的条目；logger 的 secrets 收集会把它当敏感值，增加泄漏面。
3. **命名冲突**：`__mg_*` 是内部保留前缀；任意 id 可能与未来内部条目碰撞。
4. **删除语义**：当前删除上游不会删除其 Key；白名单必须同时定义"删除上游时是否清理 Key""已删除实体的 Key 如何清理"，否则白名单会把孤儿键锁死。
5. **错误契约**：白名单需要明确的 400 语义（是否新增 `code`），这会改动管理 API 基线的错误信封，属于 v1 冻结前必须决定的事项。

### 8.3 候选规则（草案，未实现）

允许 `id` 当且仅当属于以下并集：

- 当前 `cfg.providers` 的键；
- 当前 `cfg.virtualModels` 对应的 `__mg_vm_<name>`；
- 内部键 `__mg_client`、`__mg_admin`；
- **keys 库中已存在的条目**（用于清理历史孤儿键，避免白名单锁死）。

拒绝返回 `400 {error:'未知的 Key 标识：<id>'}`（沿用管理面 `{error:string}` 信封，未新增 `code`）。删除 provider 时同步删除其 Key **仍未实现**（白名单通过“keys 库已有条目可删除”保留人工清理路径）；重命名按删除+新建处理。

### 8.4 状态

**IMPLEMENTED（2026-11-09，MG-009）**：`doSaveKeys` 采纳上面并集规则；内部元数据条目 `__mg_vm_meta_*` 只允许删除、不允许把对象覆盖成字符串 Key。回归见 `scripts/test/offline/admin-projection.test.mjs`（允许集/拒绝集/删除路径）。Provider 删除联动清理与 `code` 字段仍未落地，留待 v1 冻结前决定。

## 9. Fixture 与 F0

- 脱敏状态样例：[status.json](fixtures/v1/status.json)
- 表单模型样例：[config-form.json](fixtures/v1/config-form.json)
- 保存请求样例：[config-save.json](fixtures/v1/config-save.json)
- 字段来源与生成/更新方式：[fixtures/v1/README.md](fixtures/v1/README.md)
- 前端 F0 调用矩阵：[fixtures/v1/f0-call-matrix.md](fixtures/v1/f0-call-matrix.md)
- 托盘部署（独立主题）：[tray-deployment.md](../how-to/tray-deployment.md)

Fixture 只表达形状，不代表任何真实实例的数值；不得从生产实例抓取后直接提交。

## 10. 验收清单

### 10.1 本轮已执行的静态检查

| ID | 检查 | 命令 | 结果 |
| --- | --- | --- | --- |
| S-1 | fixture JSON 语法 | `node -e` 逐个 `JSON.parse` | PASS（3 个 JSON） |
| S-2 | fixture 脱敏扫描 | 关键字/域名/IP/凭据显性模式扫描 + 人工复核 | PASS（显性模式无命中；仅 `example.invalid` 与回环默认值） |
| S-3 | 文档相对链接 | `npm run docs:check` | PASS（见交付记录） |
| S-4 | `config-save.json` 不含投影字段、含扩展字段、`defaults` 为部分提交 | 本地断言脚本 | PASS |

> S-1/S-2/S-3 只证明文档与 fixture 自身可解析、无显性秘密、链接存在；**不证明**浏览器行为、服务端实现或托盘运行。

### 10.2 浏览器真实鉴权 + 保存回读（NOT EXECUTED）

必须在隔离实例执行，禁止使用生产 8787、真实配置或真实上游：

1. 用 OS 临时目录作 `MG_CONFIG_DIR`，动态回环端口，`MG_KEYS_MASTER` 用测试主密钥；准备本地 mock 上游或空 providers。
2. 启动 `node src/index.js`，浏览器访问该回环端口。
3. 设置 `MG_ADMIN_TOKEN` 或在面板设置测试令牌；确认刷新/重启后需要重新登录。
4. 修改一个 `defaults` 字段与一个模型字段，保存；确认 `configVersion` +1、响应 `status` 与再次 `GET /api/status` 一致。
5. 在两个标签页同时打开；A 保存后 B 保存必须收到 409，且 B 不得自动覆盖；选择"加载最新"后表单与版本更新。
6. 在 `defaults` 预置一个未知字段（测试实例文件），保存后确认字段仍在；在 provider/model 条目预置未知字段，按不透明袋回送后确认仍在。
7. 确认 `gateway.local.json` 中没有 `probe/requests/errors/avgMs` 等运行时字段（当前代码预期会失败，除非客户端已剥离；这是 D-2 的验收点）。
8. 设置客户端 Key 后确认状态只显示 `********`；以掩码保存不改变 Key；清空后状态显示未设置。设置上游 Key 后确认任何响应都不含 Key 值。
9. 断网/超时模拟一次保存，确认 UI 走"结果未知→回读"而不是盲目重试。
10. 记录浏览器、提交、隔离目录、命令、结果与未验证项；清理临时目录。

**状态：NOT EXECUTED（2026-11-09，本卡未运行浏览器）。**

### 10.3 后续可自动化回归（建议）

| ID | 断言 | 归属 |
| --- | --- | --- |
| AC-1 | `/api/status` 响应不含 `apiKey`，`clientKey` 有值时固定掩码 | offline |
| AC-2 | 带过期 `version` 保存 → 409 且 `currentVersion` 正确 | 已有 admin-contract |
| AC-3 | 掩码 `clientKey` 回存不改变 Key；空串清除 | offline |
| AC-4 | `defaults` 未知字段保存后保留 | offline |
| AC-5 | `providers/models` 未知字段回送后保留；不回送则丢失（记录为已知语义） | offline |
| AC-6 | 保存后 local 不含 `models[*]` 运行时字段（当前预期 FAIL，直到服务端清洗） | offline（需先修 D-2） |
| AC-7 | `/api/keys` 白名单拒绝未知 id（白名单落地后） | offline |
| AC-8 | fixture 与 `buildStatus` 字段集合一致（字段漂移检测） | offline |

## 11. 未验证项与待决

**未验证**：浏览器真实鉴权、保存回读、双标签冲突、掩码回存、未知字段回存、网络未知态、Linux/Windows 托盘、真实上游与计费、管理 API 基线 §5 对 `extraHeaders/proxy` 的脱敏收敛、§10.2 全部步骤。

**待决**：

1. `/api/keys` 白名单与孤儿键清理（§8，MG-003/MG-009）。
2. `providers/models` 是否引入服务端 PATCH/字段合并（D-4），以及迁移策略。
3. 服务端是否剥离 `models[*]` 运行时字段（D-2）；这是契约与当前实现的差异。
4. 管理令牌的浏览器持久化策略（localStorage → session/内存/可选记住）。
5. `GET /api/config` 只读投影是否在 F1 新增（D-6）。
6. v1 冻结时间：本文件在 MG-016 基线的冻结门槛满足前保持草案。

## 12. 维护规则

- 修改 `buildStatus` 字段、`doSaveConfig` 语义、`doSaveKeys` 白名单或 `admin.html` 映射时，同步更新本文件、fixture 与 [F0 矩阵](fixtures/v1/f0-call-matrix.md)。
- 不把本节内容复制进 [管理 API v1 基线](management-api-v1.md)；基线由 MG-016 维护。
- 任何"已验收"声明必须附浏览器/离线证据；mock 测试不能代替真实浏览器鉴权，源代码审阅不能代替保存回读。
