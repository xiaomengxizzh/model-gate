# 管理面投影 Fixture v1（MG-009 / F0）

状态：草案，跟随 [管理面 UI 投影契约 v1](../../management-ui-projection-v1.md) 与 [管理 API v1 基线](../../management-api-v1.md)；不改变 MG-016 基线，也不代表任何真实实例。基线：`dev/gateway-audit-20261108` / HEAD `b2283ae`（2026-11-09）。

## 文件

| 文件 | 用途 | 形状来源 |
| --- | --- | --- |
| [status.json](status.json) | `GET /api/status` 的脱敏投影样例 | `src/index.js` `buildStatus`（174–229） |
| [config-form.json](config-form.json) | 前端"可编辑表单"内部模型：含 `_extra` 不透明袋与 `configVersion` | `buildStatus` + `admin.html` `buildCfrom`（632–635） |
| [config-save.json](config-save.json) | 由表单派生、实际发给 `POST /api/config/save` 的请求体 | `doSaveConfig`（331–454） |
| [f0-call-matrix.md](f0-call-matrix.md) | UI 能力 → 现有 endpoint → 缺口 | 源码路由与 `admin.html` 调用 |

## 生成方式（手写派生，不是抓包）

1. 阅读 `buildStatus`，逐字段抄下**响应形状**；不读取生产实例、不抓取真实响应。
2. 构造两个虚构上游（`demo-openai`、`demo-backup`）、两个模型（`demo-chat`、`demo-reasoner`）、一个虚拟模型（`team-chat`）与一个会话，填入统计/探针数值。数值仅用于展示形状，不对应任何真实流量。
3. `config-form.json` 在 status 形状基础上转成"对象映射 + 不透明袋"；`config-save.json` 从表单派生，演示：
   - 剥离 `hasKey/keySource/st/probe/requests/errors/today/hitRate/affinity/avgMs`；
   - 回送 provider 扩展字段 `vendorRateClass` 与 model 扩展字段 `vendorCapability`；
   - `defaults` 只提交改动字段（`proxyMode`、`clientKey`），其余由服务端合并保留（包括 `x-fixture-extension`）。
4. 手工做脱敏扫描（见下）并 `JSON.parse` 校验。**没有生成脚本**；本目录不是自动化快照，改动需按 §更新流程手工同步。

投影到表单的固定映射：`providers[]` 按 `id` 转对象；`models[]` 按 `name` 转对象；`virtualModels[]` 保持数组与顺序；`defaults` 原样复制（`clientKey` 保持掩码）；统计/探针/掩码字段剥离；白名单外字段进 `_extra`。

## 字段来源

| 字段 | 生成依据 |
| --- | --- |
| `needAuth` / `configVersion` / `server` / `startedAt` / `uptimeMs` / `counters` / `lastServing` | `buildStatus` 顶层返回 |
| `providers[].id/baseUrl/apiKeyEnv/pathPrefix/api/extraHeaders/proxy/circuit` | `state.cfg.providers` 条目 |
| `providers[].hasKey/keySource` | `resolveKey`（`src/router.js`）的判定结果 |
| `providers[].st` | `stats.byProvider` + `ensureHst` + `pct` |
| `models[].provider/alias/fallbacks/.../providerModels/forceNoStream` | `state.cfg.models` 条目 |
| `models[].probe/requests/errors/tokens/today/hitRate/affinity/avgMs` | `stats.byModel`、`stats.daily`、`state.affinity` |
| `virtualModels[].name/directory/quota/.../qps` | `state.cfg.virtualModels` |
| `virtualModels[].expiresAt/note` | keys 库的 `__mg_vm_meta_<name>` |
| `virtualModels[].keySet` | keys 库是否存在 `__mg_vm_<name>` |
| `virtualModels[].requests/errors/tokens/today/hitRate` | `stats.byModel` / `stats.daily` |
| `defaults` | 固定默认 + `state.cfg.defaults`，`clientKey` 被替换为 `********` 或 `""` |
| `global` / `cache` / `dialogues` | `state.stats.global`、`cacheTrend/cacheAlert`、`state.dialogue`（最近 30 个） |

注意：`buildStatus` 中值为 `undefined` 的字段经 JSON 序列化会**消失**；fixture 已补齐非空值，不用 `undefined` 表达"未配置"。

## 脱敏规则

- 域名一律使用 RFC 2606 保留的 `example.invalid`；不使用真实厂商域名、内网 IP 或 LAN 主机名。
- 不出现任何真实 Key、管理令牌、客户端 Key、Cookie、`Authorization` 值；`hasKey` 只给布尔，`keySource` 只给枚举，`clientKey` 只给掩码。
- `extraHeaders` 只用虚构值 `fixture-only`；`proxy` 不含 `user:pass@`。
- 不出现真实用户名、邮箱、绝对路径、日志内容、`config/admin.token` 或 `keys.local.json` 内容。
- 时间戳固定为 2026-11-09/10（epoch 毫秒），便于肉眼识别为样例。

可重复执行的显性扫描（只扫 JSON，避免误伤说明文字）：

```bash
grep -nE 'sk-[A-Za-z0-9]|Bearer |AKIA|BEGIN (RSA|OPENSSH)|10\.[0-9]+\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.' docs/contracts/fixtures/v1/*.json
node -e "const fs=require('node:fs');for(const f of ['status.json','config-form.json','config-save.json']){JSON.parse(fs.readFileSync('docs/contracts/fixtures/v1/'+f,'utf8'));console.log(f+': OK')}"
```

预期：grep 无输出；node 打印三个 OK。

## 使用方式（F0/F1）

- 作为**形状**参考：字段名、嵌套、数组/对象边界；不要把统计数值当 golden。
- 未来离线测试可把 `status.json` 作为 `buildStatus` 字段集合的对照（字段漂移检测），把 `config-save.json` 作为"保存请求不得包含投影字段"的断言输入。
- `config-form.json` 的 `_extra` 是**客户端内部约定**，不属于服务端 schema；保存请求中不得出现 `_extra` 键，应把内容平铺回条目。
- `config-save.json` 故意包含 `vendorRateClass` / `vendorCapability` 两个虚构扩展字段，用来验证"未知字段回送后保留"；它们不是已知配置项。

## 已知限制

- 不是从真实服务捕获的快照，不能证明服务端当前行为；服务端行为以 [基线契约](../../management-api-v1.md) 与离线测试为准。
- 未包含 `GET /api/model-stats`、`GET /api/logs`、`/api/probe` 的响应样例；这些归后续 fixture。
- 不覆盖错误响应（400/401/403/409/413）；错误形状见基线契约与投影契约 §6。
- 没有测试消费本目录；"字段漂移检测"仍是建议项（投影契约 §10.3 AC-8）。
- `config-save.json` 的 `defaults` 是**部分提交**样例；若 UI 选择提交完整 `defaults`，未知字段同样因合并而保留，但不会演示"省略即保留"的语义。
- `config-save.json` 的 `version` 固定为 7，与 `status.json` 对齐；直接用于其他实例前必须替换成该实例的 `configVersion`，否则会 409。

## 更新流程

1. 先改契约（投影契约或基线），再改 fixture；不要用 fixture 反向定义契约。
2. 修改 `buildStatus` 字段或保存语义时，同步更新本 README 的字段来源表与 [F0 矩阵](f0-call-matrix.md)。
3. 重跑 §脱敏规则 的扫描与 JSON 校验；任何一项失败不得交付。
4. 在交付记录中写清"手工派生、未抓生产"，不要写"已从线上验证"。
