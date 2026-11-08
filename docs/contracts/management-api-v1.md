# 管理 API v1（当前实现清单，待冻结）

源码依据：src/index.js 的 makeHandler/buildStatus/doSaveConfig/doSaveKeys。此清单是 G0 初稿，尚未通过完整前端 fixture 验收，不意味着稳定 schema 已冻结。变更时同步本表及回归。

## 公共规则

除 GET /api/auth 外均需要管理鉴权，已配置令牌时采用 `Authorization: Bearer <token>` 或 `x-mg-admin`；未配置令牌时允许本地初始化。管理令牌来源优先级：MG_ADMIN_TOKEN → server.adminToken → keys.__mg_admin。错误鉴权为 401。

POST 接收 JSON；body 大小默认 32 MiB，可由 server.maxBodyBytes 覆盖；超限为 413、error.type=payload_too_large。当前各接口的 JSON 形状校验并不统一，详见 MG-003，客户端应严格发送下表形状。

## 路径

| 方法 / 路径 | 输入 | 主要输出与状态 |
| --- | --- | --- |
| GET /api/auth | 无 | 200 `{needAuth, startedAt}`；公开，不代表已登录 |
| GET /api/status | 无 | 200 状态快照，见下文 |
| POST /api/admin-token | `{token: string}`；空串清除 keys 中管理令牌 | 200 `{ok, needAuth}`；已有令牌时需旧令牌；加密失败 400；不推进 configVersion |
| POST /api/config/save | 可选 `{version, providers, models, defaults, virtualModels}` | 200 `{ok, status}`；校验错误 400；过期版本 409 `{error,currentVersion}` |
| POST /api/config/reload | 无 | 200 `{ok}`，重新读配置，不重启 HTTP 监听 |
| POST /api/keys | `{id, key, version?}`；key 为空时删除该 id | 200 `{ok,status}`；缺 id/加密失败 400；版本过期 409；当前 id 未严格白名单，待 MG-003 |
| POST /api/route-preview | `{model}` | 200 `{ok,hit}`；hit.type 为 virtual/defaults/model/unknown；缺 model 400；不调用上游 |
| POST /api/probe | `{id?}`；不传 id 时遍历全部 provider | 200 `{ok,results,status}`；单项包含 id/ok/code/ms/err；会调用上游 |
| POST /api/model-test | `{id?}`；不传 id 时遍历全部真实模型 | 200 `{ok,result,status}` 或 `{ok,results,status}`；未知 id 为 400；会发最小推理请求 |
| GET /api/model-stats?days=7 | days 限制到 1–90；默认 7 | 200 `{days,mode,models}`；1 天模式实际为过去 24 小时点；其他模式为按日期桶 |
| GET /api/logs?lines=200 | lines 范围 1–5000，默认 200 | 200 `{lines:[string]}`，读取当前日志文件；不是全局日志搜索 |

## 配置与状态

status 顶层包括 needAuth/configVersion/virtualModels/server/startedAt/uptimeMs/counters/lastServing/global/cache/dialogues/providers/models/defaults。providers/models 是带 name/id 和统计的数组，不等于磁盘配置映射。把状态数组直接回存会破坏配置，应由明确映射构造待保存对象。

defaults 返回 clientKey 掩码（有值时为 `********`）；保存该掩码表示保留原 Key。providers 返回 hasKey/keySource，不返回 apiKey 本身，但 extraHeaders/proxy 仍可能包含敏感值，须按 MG-005 收敛后才能向外暴露诊断快照。virtualModels 返回 keySet 与 expiresAt/note 等元数据，不返回 Key。

version 请求字段对应 status.configVersion；显式过期时 409，缺 version 仍宽容接受旧客户端。providers/models 有传则整体作为保存映射，defaults 采用顶层合并；加载时主模板和本地 patch 还会合并，删除语义待 MG-003。模型 api/providerModels/maxTokensMax/forceNoStream 等字段已进入状态回显和保存回归。

## 待冻结门槛

MG-016 补完整 JSON schema、无秘密 fixture、每条路径的真实管理鉴权/错误/409 契约测试、前端读写一致性；MG-001/003/005 完成后再冻结 v1。当前只对已有源码作清单，不承诺尚未实现的备份、恢复、trace 或 Responses 状态字段。
