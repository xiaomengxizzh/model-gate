# 管理 API v1 契约（G0 基线，未冻结）

源码依据：`src/index.js` 的 `makeHandler`（419–673）、`buildStatus`（138–193）、`reloadConfig`（210–217）、`doSaveConfig`（233–341）、`doSaveKeys`（342–358）。

契约回归：[scripts/test/offline/admin-contract.test.mjs](../../scripts/test/offline/admin-contract.test.mjs)、[admin-secrets.test.mjs](../../scripts/test/offline/admin-secrets.test.mjs)；`npm test` 自动纳入。

**边界**：本文件只描述当前源码行为，证据来自本地 mock 与隔离临时实例，不含真实上游、真实账号权限、生产部署或前端视觉验收。冻结门槛见末节：MG-001/003/005/009 完成后再冻结 v1，在那之前任何字段都可能调整。

## 1. 鉴权矩阵

令牌来源优先级：`MG_ADMIN_TOKEN`（环境变量）→ `server.adminToken`（配置文件）→ `keys.__mg_admin`（面板写入，加密存储）。

凭据形式：`Authorization: Bearer <token>` 或 `x-mg-admin: <token>`；比较为常量时间，两端空白被裁剪。

| 路径 | 未配置令牌 · 本机对端 | 未配置令牌 · 远程对端 | 已配置令牌 · 无/错凭据 | 已配置令牌 · 有效凭据 |
| --- | --- | --- | --- | --- |
| `GET /api/auth` | 200 | 200（公开） | 200（公开） | 200 |
| `POST /api/admin-token` | 200（本地初始化） | 403 | 401 | 200 |
| `GET /api/status`、`GET /api/config`、`GET /api/logs`、`GET /api/model-stats`、`GET /api/native-usage` | 200 | 403 | 401 | 200 |
| `POST /api/config/save`、`POST /api/config/reload`、`POST /api/keys` | 200 | 403 | 401 | 200 |
| `POST /api/route-preview`、`POST /api/probe`、`POST /api/model-test` | 200 | 403 | 401 | 200 |
| 其他 `/api/*` 未知路径 | 404 | 404 | 404 | 404 |

除鉴权外，所有请求先过来源校验（MG-001）：Host 必须是 IP 字面量或 `localhost`/`server.host`/`server.allowedHosts` 中的名字，否则 403；带 `Origin` 的浏览器请求必须同源或命中 `server.allowedOrigins`，否则 403（`Origin: null` 拒绝）。无 `Origin` 的 CLI 客户端放行。数据面同样做 Host 校验，跨源写请求 403（`{error:{message,type:'forbidden'}}`）。

环境变量令牌存在时面板无法清除它（`/api/admin-token` 会把 `keys.__mg_admin` 清空，但 `MG_ADMIN_TOKEN` 仍生效），响应 `needAuth` 如实反映。

## 2. 通用规则

| 规则 | 契约 |
| --- | --- |
| 请求体 | `POST` 接受 JSON；管理面 body 上限默认 32 MiB，可由 `server.maxBodyBytes` 覆盖，启动时 `MG_MAX_BODY` 优先 |
| 超限 | 413，信封 `{error:{message,type:'payload_too_large'}}`（**与下一条不同形**，MG-003 统一） |
| 管理面错误信封 | `{error: string}`（400/401/409） |
| 数据面错误信封 | `{error:{message:string,type:string}}` |
| 版本 | `configVersion` 每次成功写盘 +1；请求显式带 `version` 且不等于当前值 → 409 `{error,currentVersion}`；缺 `version` 视为旧客户端，宽容接受 |
| 未知路径 | `/api/*` 未匹配 → 404 `text/plain` `not found`；不落入数据面转发 |
| 副作用 | `/api/probe`、`/api/model-test` 会真实请求上游；其余接口不触达上游 |

## 3. 逐路径契约

### `GET /api/auth`
公开。响应 `{needAuth: boolean, startedAt: number}`；`needAuth` 只表示"是否已启用令牌"，不代表请求方已通过鉴权。

### `POST /api/admin-token`
请求 `{token: string}`（前后空白裁剪）。空串=清除 `keys.__mg_admin`。
成功 `200 {ok:true, needAuth:boolean}`；已启用令牌时缺当前令牌 `401 {error}`；`keys.local.json` 无法加密（缺主密钥）`400 {error}`。不推进 `configVersion`。

### `GET /api/status`
响应即状态快照，字段见第 4 节。所有模型/上游统计与掩码 Key 元数据都在此聚合，前端只读。

### `GET /api/config`

只读配置投影（MG-009 D-6）：返回 `{ configVersion, providers, models, defaults, virtualModels }`，形状与 `POST /api/config/save` 的请求体一致，可直接“读 → 改 → 保存”。不含运行时统计/探针字段（providers 的 hasKey/keySource/keyOk/st/probe、models 的 probe/requests/errors/tokens/today/hitRate/affinity/avgMs 等），不返回 `_keys`/`_paths`；`defaults.clientKey` 在 `keys.__mg_client` 或旧明文存在时固定回显 `********`（只检查 defaults 会导致永远为空、前端误判未设置）；`virtualModels[*]` 回显 `expiresAt`/`note`（存于 `keys.__mg_vm_meta_<name>`，不回显则一次保存会误清空），并额外返回后端判定的 `expiresAtState`（`none`/`valid`/`expired`/`invalid`）与 `expiresAtMs`（无效时另带 `expiresAtDiagnostic` 码）；前端只展示状态，不自行比较时间；未知扩展字段按原样返回。鉴权与错误信封同其它管理 GET（401/403）。回归见 `scripts/test/offline/config-projection.test.mjs`、`scripts/test/offline/ui-contract.test.mjs`。

### `POST /api/config/save`
请求（均可选）：`{version?: number, providers?: object, models?: object, defaults?: object, virtualModels?: array}`。
成功 `200 {ok:true, status}`（`status` 为保存后的新快照）。失败：校验不通过 `400 {error}`；版本过期 `409 {error, currentVersion}`；body 非 JSON 对象 `400 {error:'请求体必须为 JSON 对象'}`；磁盘被外部修改 `409 {error, code:'store_conflict'}`（保留现场、不覆盖）；另一个写者持锁 `409 {error, code:'store_locked'}`（不排队）；事务中途失败 `500 {error, code:'transaction_failed'|'injected_fault'}`。

保存是「同一代际」事务（M0-3，见 `src/config-transaction.js`）：`keys.local.json` 与 `gateway.local.json` 先写暂存件并 fsync，写 journal 后逐目标「校验旧指纹 → rename → fsync 目录」，全部完成后写 commit marker、发布内存代际并清理自有工件。任何一步失败/进程被杀，重启时 `start()` 或下一次写入会先恢复：有 commit marker 且两文件均为新 → 前滚；无 marker 且每个文件只可能是旧或新 → 回滚到旧；出现第三种内容（外部编辑）→ 保留磁盘、fail-closed 并记录结构化冲突。失败期间不发布内存 cfg、不改鉴权。
形状校验（MG-003，单一入口 `validateConfigShape`）：请求体必须是 JSON 对象；`providers/models/defaults` 必须是对象，`virtualModels` 必须是数组，`version` 必须是数字；任一层级出现保留键 `__proto__`/`constructor`/`prototype`（含 `providerModels` 内层与虚拟模型名）一律 400。校验失败不写盘、不改内存、不推进 `configVersion`。

语义：`providers`/`models`/`virtualModels` 整体替换（缺省=保持不变）；`defaults` 顶层合并（未回传字段保留，无法经此接口删除字段）；`defaults.clientKey` 三态：省略/掩码=保留、`""`=显式清空、非空=替换，非法值 `400` 且不落盘；`virtualModels[*].expiresAt/note` 同为三态：整个数组省略或数组内对象省略该字段=保留现有 meta，显式 `""`=清空该字段，字段全空才删除 meta 条目；`providers[*].keyOk/keySource` 等展示字段被剥离后再落盘；被删除的虚拟模型同步清理其 `__mg_vm_<name>` Key 与 `__mg_vm_meta_<name>` 元数据；被删除的上游/模型名记入 local 的 `_removed` 墓碑，重启后不复活（重新加回即撤销）。

### `POST /api/config/reload`
无请求字段。`200 {ok:true}`：先恢复未完成的事务，再重新读盘并重建路由，不重启 HTTP 监听；恢复遇到外部修改/不可判定 → `409 {error, code:'store_conflict'}` 且保留现场。

### `POST /api/keys`
请求 `{id: string, key?: string, version?: number}`。缺 `id` → `400 {error:'缺少 provider id'}`；`key` 为空/falsy → 删除该 id；加密失败 `400`；版本过期 `409 {error,currentVersion}`；磁盘外部修改/锁竞争 `409 {code:'store_conflict'|'store_locked'}`；成功 `200 {ok:true,status}` 且 `configVersion` +1（keys 与 local 同代际原子提交）。
`id` 目前不设白名单（任意字符串都会成为 keys 条目）：MG-003 收敛为"真实上游 id / `__mg_vm_*` / `__mg_client` / `__mg_admin`"。

### `POST /api/route-preview`
请求 `{model: string}`。缺 `model` → `400 {error:'缺少 model'}`。
成功 `200 {ok:true, hit}`，`hit.type` 取值：
- `virtual`：`{type,name,directory:[{model,mode,providers,limit}],quota,dailyQuota,used,quotaState}`
- `defaults`：`{type,name,directory}`（命中默认虚拟名）
- `model`：`{type,name,provider,note:null}`
- `unknown`：`{type,name,provider?,note}`；解析抛错时 `{type:'unknown',model,note}`
不调用上游。

### `POST /api/probe`
请求 `{id?: string}`；缺 `id` 遍历全部上游。成功 `200 {ok:true, results, status}`，每项 `{id,ok,code,ms,err}`。未知 `id` 不在 `results` 中且不报错（结果数组为空）。会请求上游 `/v1/models`。

### `POST /api/model-test`
请求 `{id?: string}`。带 `id`：未知模型 `400 {error}`；已知 → `200 {ok:true,result,status}`，`result` 为 `{id,ok,code,ms,err}`。缺 `id` → `200 {ok:true,results,status}` 遍历全部真实模型。发最小推理请求。

### `GET /api/model-stats?days=7`
`days` 夹取到 1–90（`0`/`abc` → 7）。`days=1` → `mode:'hourly'`，每模型 24 个小时桶（`date:'HH:00'`）；其余 `mode:'daily'`，每模型 `days` 个日期桶（`date:'YYYY-MM-DD'`）。桶字段 `{tokens,inTokens,outTokens,hit,miss,hitRate}`，`hitRate` 无样本时为 `null`。只覆盖真实模型，不含虚拟模型。

### `GET /api/native-usage?days=7`
只读采集 Codex 本地会话日志（默认关闭）。配置来源：`MG_NATIVE_USAGE_DIR` 环境变量优先，其次 `defaults.nativeUsageDir`；空串或 `off` 关闭。`days` 夹取 1–90。响应 `{enabled, source:'codex-sessions', days, dirLabel, generatedAt, scanned:{files,sessions,bytes,parseErrors}, totals:{inputTokens,cachedInputTokens,cacheWriteTokens,outputTokens,reasoningOutputTokens,totalTokens,turns}, byDay:[...], byModel:[...], note}`；关闭时 `{enabled:false, reason/note}`，目录不存在时 `{enabled:true, error:'目录不存在或不可读'}`。只解析 `session_meta`/`turn_context`/`token_count`，**不读取消息正文**；不代表经过网关的代理流量。回归见 `scripts/test/offline/native-usage.test.mjs`。

### `GET /api/logs?lines=200`
`lines` 默认 200，超过 5000 按 5000，负数与非法值按 1/200 处理。响应 `{lines: string[]}`，读当前日志文件尾部，不是全量检索。

## 4. 状态快照 schema（`GET /api/status`）

| 字段 | 类型 | 语义 / 敏感 |
| --- | --- | --- |
| `needAuth` | boolean | 是否已启用管理令牌 |
| `configVersion` | number | 与保存接口的 `version` 对应 |
| `startedAt` / `uptimeMs` | number | 进程启动时刻与运行时长 |
| `counters` | object | `{requests,errors,retries,interrupts}` 进程内累计 |
| `lastServing` | object\|null | `{model,provider,at}` |
| `global` | object | 全局累计：`requests/errors/retries/interrupts/tokenCount/todayTokens/avgMs/p50/p95/latTrend` |
| `cache` | object | `{trend:[{t,v}], alert}` |
| `dialogues` | array | 最近 30 个有请求的对话（`id,named,requests,tokens,hit,miss,hitRate,startAt,lastAt`） |
| `providers` | array | 每项 `{id,baseUrl,hasKey,keySource,apiKeyEnv,pathPrefix,api,extraHeaders,proxy,circuit,st}`；**不含 apiKey** |
| `models` | array | 每项含 `name,provider,alias,fallbacks,maxConcurrent,qps,reasoning,effortOptions,effortFormat,dailyQuota,quota,maxContext,maxTokensMax,api,providerModels,forceNoStream,requests,errors,tokens,today,hitRate,affinity,avgMs,probe` |
| `virtualModels` | array | `{name,directory,quota,dailyQuota,maxContext,maxConcurrent,qps,keySet,expiresAt,expiresAtState,expiresAtMs,note,requests,errors,tokens,today,hitRate}`（无效过期值另带 `expiresAtDiagnostic`）；`expiresAtState` ∈ `none/valid/expired/invalid`；**不含 Key** |
| `defaults` | object | 配置默认值原样回显，`clientKey` 有值时固定为 `********` |
| `server` | object | `{maxBodyBytes,keyEncrypted,host,port}` |
| `nativeUsage` | object | `{enabled,dirLabel}`；只暴露是否启用与目录标签，不返回日志内容 |

`providers`/`models` 是带统计的**数组**，不是磁盘配置映射；把状态数组直接回存会破坏配置。可保存对象必须由明确映射构造（MG-009 负责前端读写一致性）。

## 5. 敏感字段

| 类别 | 契约 | 当前实现 |
| --- | --- | --- |
| 上游 API Key | 任何响应不得回显 | `hasKey`/`keySource` 表达；`apiKeyEnv` 只回显变量名 |
| 客户端 Key | 只回显掩码 `********` | 掩码回存=保留原值 |
| 虚拟模型 Key | 只回显 `keySet` | 不返回 Key、不返回过期时间以外的元数据 |
| 管理令牌 | 不经任何响应回显 | `/api/auth` 只给 `needAuth` |
| 磁盘 | `keys.local.json` 为 `MG1:` 密文，权限 0600 | 无主密钥时拒绝明文写入并 400 |
| 日志 | 不落 Key 与请求正文 | 启动时收集 secrets 供 logger 脱敏 |
| 原生用量采集 | 只返回 token 计数/模型/provider/目录标签 | 不返回消息正文；默认关闭，目录由管理员显式配置 |
| `extraHeaders`/`proxy` | **风险项** | 状态快照原样回显，可含鉴权头值或代理用户信息；MG-005 收敛后才能对外暴露诊断快照 |

## 6. Fixture（测试实际发送的形状）

```jsonc
// 设置令牌
POST /api/admin-token  {"token":"local-token"}
→ 200 {"ok":true,"needAuth":true}

// 保存配置（带版本）
POST /api/config/save  {"version":0,"defaults":{"proxyMode":"direct"}}
→ 200 {"ok":true,"status":{ "configVersion":1 /* …完整状态快照… */ }}

// 版本过期
POST /api/config/save  {"version":99}
→ 409 {"error":"配置版本已过期（他处已保存过新版本），请刷新后重试","currentVersion":1}

// 写入/删除上游 Key
POST /api/keys  {"id":"mock","key":"mock-key"}   → 200 {"ok":true,"status":{…}}
POST /api/keys  {"id":"mock","key":""}           → 200 {"ok":true,"status":{…}}

// 路由预演（三种命中）
POST /api/route-preview {"model":"private"} → 200 {"ok":true,"hit":{"type":"virtual",…}}
POST /api/route-preview {"model":"demo"}    → 200 {"ok":true,"hit":{"type":"model","provider":"mock",…}}
POST /api/route-preview {"model":"ghost"}   → 200 {"ok":true,"hit":{"type":"unknown",…}}

// 上游探活
POST /api/probe {"id":"mock"} → 200 {"ok":true,"results":[{"id":"mock","ok":true,"code":200,"ms":1,"err":null}],"status":{…}}
```

## 7. 前端兼容矩阵

`src/admin.html` 实际调用：`/api/auth`、`/api/status`、`/api/model-stats?days=`、`/api/logs?lines=250`、`/api/config/save`（带 `version`，整体回传 `providers/models/defaults/virtualModels`）、`/api/config/reload`；`GET /api/config` 已提供但面板尚未改用（F1/F2 迁移点）、`/api/keys`（含 `__mg_vm_*`）、`/api/route-preview`、`/api/probe`、`/api/model-test`、`/api/admin-token`。面板用 `Authorization: Bearer`；401 时弹令牌输入框。

已知读写不一致（MG-009）：面板把 `status.providers/models` 数组映射为 `C.providers/C.models` 映射再整体回存，映射规则散落在面板脚本里，缺少服务端 fixture 校验。

## 8. 已知偏离与待冻结门槛

| 偏离 | 归属 |
| --- | --- |
| 已修复：数组/字符串 body、保留键、非数字 version 均 400；删除墓碑 `_removed` 落地（MG-003） | — |
| `/api/keys` 的 `id` 仍无完整白名单（仅拒绝保留键与空 id；任意合法字符串可写入） | MG-003 余项 |
| 401/413 与数据面错误信封不同形 | MG-003 |
| 无令牌时管理写接口仅限本机；跨 Origin/Host 策略已落地（MG-001 已闭环，见 1/2 节） | — |
| `extraHeaders`/`proxy` 原样回显 | MG-005 |
| 热更新 Key 后 logger 的 secrets 列表不刷新 | MG-005 |
| 前端 fixture 与视觉验收未做 | MG-009 / F0 |

冻结 v1 的判据：MG-001/003/005 完成、MG-009 给出前端 fixture 与服务端同源校验，且本文件的每条路径在默认 `npm test` 中有鉴权/错误/409/敏感字段回归。

## 9. 与 Draft PR #2 的边界

本契约只依据本仓库 `dev/gateway-audit-20261108` 的源码与离线测试。Draft PR #2 仍为 open/draft，head `9a0bfe3b7517068fb932dc4054c0192fee4e3791`；本轮未审计其实现、未将其字段纳入契约，也不以其通过代替本文件回归。

## 10. Codex 管理面（/api/codex/*）M4-1a 安全边界

> 2026-11-11 加固（P0-2）。本节约束 src/codex/api.js + src/codex/config.js 的模块侧行为；入口网关的 Origin/peer 前置判定属后续 M4-1b。

| 项 | 契约 |
| --- | --- |
| 管理员 | 每个路由声明 explicitAdmin: true，只接受显式管理员会话（ctx.explicitAdmin / requireExplicitAdmin）。“实例未设置 adminToken ⇒ 放行”已删除；旧 requireAdmin 返回值不再能单独放行。 |
| 来源 | 仅回环（127.0.0.1/::1）；显式 allowRemote=true 才放宽。 |
| 文件选择 | 只接受 registerConfigRoot({id,path,mode}) 登记后的不透明 root id；调用方提供的 path/file/backupPath 一律 400 path_not_allowed，原始 toml/content 一律 400 raw_content_not_allowed。basename=config.toml 只在登记时校验。 |
| 普通产品模式 | config/apply、config/rollback 一律 403 write_disabled；只有 managedRoot=true 且登记根 mode=managed（受控自管 fixture）才启用。 |
| plan | 只回白名单字段差异：{field, from, to, redacted, owner}（归一化取值，敏感字段 <redacted>），不回行级 diff、保留行原文、整文件、路径或备份路径。 |
| confirmToken | 服务端随机令牌，绑定 操作（apply/rollback）+ root id + 管理员 subject + 代际（before/after sha256）+ 过期（默认 5 分钟），单次使用；跨文件/跨操作/过期/复用分别返回 confirmation_binding_mismatch / confirmation_expired / confirmation_required。 |
| apply 竞态 | 预览携带 {exists,size,sha256,mtimeMs} 快照；写入前再次快照（hash+size+mtime），外部改动 ⇒ 409 concurrent_modification，不写。 |
| 备份 | 写后返回不透明 backupId（bk_ 32hex）；rollback 只接受 backupId，未知/跨根/路径形态一律 400/403/404，不接受文件路径。 |
| export | GET /api/codex/config/export?root=<id> 只回所拥有字段的归一化投影；不含保留行、外部段值、凭据或整文件。 |
| 审计 | 只记 action / root / 受控字段名 / 结果码；不记内容、路径、令牌或 hash。 |

## 11. 版本化管理面与 CLI v1（N03）

> 2026-11-12。`mg-management/1` 是 CLI/控制台可依赖的版本化契约；旧调用方不声明版本时保留
> 既有 confirmToken-only 语义（deprecated，**不是** v1 的一部分）。

### 11.1 版本协商

| 项 | 契约 |
| --- | --- |
| 版本 | 支持 `mg-management/1`（`src/codex/api.js` 的 `CODEX_API_VERSION`），列表对外只读暴露在 `/api/codex/policy.apiVersions`。 |
| 请求头 | `x-mg-api-version: mg-management/1`；缺省按当前版本处理（旧客户端兼容）。 |
| 不支持版本 | 读 body 前返回 400 `{ok:false, code:"unsupported_api_version", apiVersion, nextAction:"upgrade-client-or-pin-supported-api-version"}`，绝不按旧形状猜。 |

### 11.2 统一错误信封与状态

所有 codex 管理面错误统一为：

```json
{ "ok": false, "code": "<stable>", "error": "<redacted message>", "apiVersion": "mg-management/1", "nextAction": "<stable>", "requestId": "<optional>" }
```

| HTTP | 语义 | 代表 code |
| --- | --- | --- |
| 401 | 入口层令牌缺失/错误（index.js 管理入口；CLI 映射为 exit 2） | 无（入口信封） |
| 403 | 已识别但无权（非显式管理员/非本机/写被关闭/字段所有权） | explicit_admin_required, remote_forbidden, write_disabled, admin_subject_required |
| 409 | 代际/绑定冲突（不写盘，保留草稿） | concurrent_modification, unmanaged_conflict, plan_id_mismatch, confirmation_binding_mismatch, root_changed |
| 400 | 形状/确认/版本错误 | unsupported_api_version, plan_id_required, confirmation_required, invalid_body |
| 404 | 未知端点/root/backup | unknown_endpoint, unknown_config_root, backup_not_found |

### 11.3 写操作绑定 planId（v1 必需）

- `POST /api/codex/config/plan` 返回 `planId`（`pl_` + 24 hex，由 confirmToken 单向派生）与 `confirmToken`；同时返回 `generation`、`redactedDiff`（{field, from, to, redacted, owner}）、`before/after` hash 与 `expiresAt`。
- 声明了 `x-mg-api-version` 的 `config/apply`、`config/rollback` 必须回传 planId：缺失 400 `plan_id_required`；与 confirmToken 不属于同一 plan → 409 `plan_id_mismatch`，任何写入前拒绝。
- `apply` 返回 `rollback.planId` / `rollback.confirmToken` / `rollback.backupId` / `rollback.expectedSha256`，回滚同样绑定 planId。
- 权限/只读/数据面隔离不变：管理面只认显式管理员；`/v1/*` 客户端 Key 永不授权 `/api/codex/*`；普通产品模式 apply/rollback 仍 403 `write_disabled`。

### 11.4 路由分级

`/api/codex/policy.routes` 为每条路由给出 `kind`（`readonly` / `management`）、`write`、`explicitAdmin`、`requiresPlanId`。只读路由（policy/plan/export/catalog status）绝不写盘；写路由必须同时满足 managed root + 显式管理员 + confirmToken + planId。

### 11.5 CLI（`node bin/mg.mjs`，纯检出可运行）

| 命令 | 网络 | 说明 |
| --- | --- | --- |
| `doctor --json` | 无 | 版本、Node 支持范围、管理 API 版本、显式配置的 providers/models 计数、目录完整性/证据新鲜度（stale 计数）、keys 文件存在性（**不读值**）、支持矩阵；未显式给配置时 config=unknown，不去读 HOME/全局配置。 |
| `provider list/show`、`model list/show`、`route explain` | 无 | 只读投影；host 只回主机名，key 只回引用来源（store/env/config/absent），不打印任何值；`route explain` 未命中聚合保留 ID 时 exit 5 且 `zeroUpstream:true`。 |
| `client codex export` | 无 | 只读 TOML 模板（profile + 别名样例 + 显式角色样例）；角色样例标注 `providerOverride:"unsupported"`，不冒充原生同会话切模型；不写文件。 |
| `config plan` | HTTP | 前置：loopback 目标 + 管理令牌环境变量。输出 planId/generation/redactedDiff/confirmToken。 |
| `config apply/rollback` | HTTP | 必须 `--plan`；非 TTY 必须 `--yes`；无隐式重试；只写登记 root 指向的 config.toml。 |

CLI 约定：

- 管理令牌只从环境变量读取（默认 `MG_ADMIN_TOKEN`，`--admin-token-env` 可改），不进 argv/输出/日志。
- 默认只允许 loopback 目标；非 loopback 需显式 `MG_CLI_ALLOW_REMOTE=1`（输出标注 `remoteTarget:true`）。
- 退出码：0 ok / 1 形状或服务端 4xx / 2 令牌缺失或 401 / 3 403 / 4 409 / 5 404。
- JSON 输出稳定且不含凭据/正文；不写全局文件、不读 `~/.codex`、不碰 auth.json。


### 可观测性端点（N06，2026-11-12）

- `GET /api/observability/events?cursor=&limit=` 返回 `{contract: mg-observability-v1, version: 1, items, nextCursor, hasMore, retained: {count, capacity, dropped}, stats}`；非法 cursor 返回 400 稳定 code。
- `GET /api/observability/stream`：短期 SSE，重放不超过 100 条的有界快照 + 增量 + 15s keepalive，断开即退订。
- 事件中的 id 只能由 hashId() 派生；正文、凭据、密文与原始 parent id 在 emit 阶段显式拒绝（全链路 canary 断言）。
