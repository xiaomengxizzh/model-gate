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
| `GET /api/status`、`GET /api/logs`、`GET /api/model-stats` | 200 | 403 | 401 | 200 |
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

### `POST /api/config/save`
请求（均可选）：`{version?: number, providers?: object, models?: object, defaults?: object, virtualModels?: array}`。
成功 `200 {ok:true, status}`（`status` 为保存后的新快照）。失败：校验不通过 `400 {error}`；版本过期 `409 {error, currentVersion}`；body 非 JSON 对象 `400 {error:'请求体必须为 JSON 对象'}`。
形状校验（MG-003，单一入口 `validateConfigShape`）：请求体必须是 JSON 对象；`providers/models/defaults` 必须是对象，`virtualModels` 必须是数组，`version` 必须是数字；任一层级出现保留键 `__proto__`/`constructor`/`prototype`（含 `providerModels` 内层与虚拟模型名）一律 400。校验失败不写盘、不改内存、不推进 `configVersion`。

语义：`providers`/`models`/`virtualModels` 整体替换（缺省=保持不变）；`defaults` 顶层合并（未回传字段保留，无法经此接口删除字段）；`providers[*].keyOk/keySource` 等展示字段被剥离后再落盘；被删除的虚拟模型同步清理其 `__mg_vm_<name>` Key 与 `__mg_vm_meta_<name>` 元数据；被删除的上游/模型名记入 local 的 `_removed` 墓碑，重启后不复活（重新加回即撤销）。

### `POST /api/config/reload`
无请求字段。`200 {ok:true}`，重新读盘并重建路由，不重启 HTTP 监听。

### `POST /api/keys`
请求 `{id: string, key?: string, version?: number}`。缺 `id` → `400 {error:'缺少 provider id'}`；`key` 为空/falsy → 删除该 id；加密失败 `400`；版本过期 `409 {error,currentVersion}`；成功 `200 {ok:true,status}` 且 `configVersion` +1。
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
| `virtualModels` | array | `{name,directory,quota,dailyQuota,maxContext,maxConcurrent,qps,keySet,expiresAt,note,requests,errors,tokens,today,hitRate}`；**不含 Key** |
| `defaults` | object | 配置默认值原样回显，`clientKey` 有值时固定为 `********` |
| `server` | object | `{maxBodyBytes,keyEncrypted,host,port}` |

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

`src/admin.html` 实际调用：`/api/auth`、`/api/status`、`/api/model-stats?days=`、`/api/logs?lines=250`、`/api/config/save`（带 `version`，整体回传 `providers/models/defaults/virtualModels`）、`/api/config/reload`、`/api/keys`（含 `__mg_vm_*`）、`/api/route-preview`、`/api/probe`、`/api/model-test`、`/api/admin-token`。面板用 `Authorization: Bearer`；401 时弹令牌输入框。

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
