# Codex 管理面 API 参考（E6 / D5）

适用于 `src/codex/api.js`（处理器）与 `src/ui-next/js/views/codex.js`（前端探测）。本页写 HTTP 契约；配置写入语义见 [codex-config.md](codex-config.md)。

当前状态：处理器与离线测试已落地（26 条），**index.js 挂载由 Lead 完成**；真实 `~/.codex/config.toml` 写入与客户端重载仍是 NOT_RUN。

## 1. 路由

| 方法 | 路径 | 写盘 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/codex/policy` | 否 | 字段所有权 + 目录摘要 + 路由清单 + 鉴权要求 |
| POST | `/api/codex/config/plan` | 否 | 只读预览：diff / 既有值 / 保留项 / `confirmToken`；**绝不写盘** |
| POST | `/api/codex/config/apply` | 是 | 需要 `expected` 快照 + `confirmToken`；二次快照 + 原子写 + `.bak` + 写后校验 |
| POST | `/api/codex/config/rollback` | 是 | 需要 `backupPath` + `expectedSha256` + `confirmToken`；回滚前另存 `.bak.pre-rollback` |
| GET | `/api/codex/catalog/status` | 否 | 目录世代 / 计数 / 截断后的 slugs（**不回全量目录**） |

未知路径 404（`unknown_endpoint`）；已知路径但方法不符 405（`method_not_allowed`）；两者都在鉴权之后才暴露。

## 2. 处理器契约

`handleCodexApi(ctx) → Promise<{ status, body } | null>`；`null` 表示「响应已由注入的鉴权函数写出」，调用方什么都不要再发。

`ctx` 字段：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `method` / `path`（或 `url`） | 是 | `url` 带 query 时自动解析 |
| `query` | 否 | 对象或 `'limit=10'` 字符串；缺省从 `url` 解析 |
| `body` / `rawBody` / `bodyBuffer` | POST 必需 | 对象、JSON 字符串或 Buffer 均可 |
| `cfg` | 否 | 用于 `defaults.codexCatalogBasePath` 与 `_codexCatalog` |
| `log` | 否 | 审计出口，只用 `info()`；缺失或抛错都不影响响应 |
| `requireAdmin` | 是 | `(ctx) => boolean \| Promise<boolean>`；**应当是纯判定**。若它已自行写出 401（`res.headersSent`），本模块返回 `null` |
| `isAdmin` | 备选 | 未注入 `requireAdmin` 时必须显式 `true`，否则 401（fail closed） |
| `isLocal` / `remoteAddress` / `req.socket.remoteAddress` | 否 | 本机判定来源；默认严格只放行 loopback |
| `allowRemote` | 否 | 显式 `true` 才放宽远程限制（默认关闭） |
| `res` | 否 | 仅用于 `headersSent` 探测 |

## 3. 挂载（index.js，一行分支）

```js
if (isCodexApiPath(path)) {
  const out = await handleCodexApi({
    method: req.method, url, path, cfg: state.cfg, log, req, res,
    requireAdmin: () => requireAdmin(req, res),   // 现有实现会自己写 401，本模块据此返回 null
    rawBody: req.method === 'POST' ? await collectBody(req) : undefined,
  })
  if (out) sendJson(res, out.status, out.body)
  return
}
```

## 4. 安全模型

- **鉴权**：所有路由都要管理令牌（`MG_ADMIN_TOKEN` / `server.adminToken`）。未注入判定函数即 401。
- **来源**：只放行 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`；其余 403 `remote_forbidden`；拿不到地址时不阻断（令牌仍强制），并在 `/policy` 里如实标注判定依据。
- **路径护栏**：绝对路径、`basename === config.toml`、拒绝 `..` 段、拒绝控制字符、拒绝 `auth.json`（403 `forbidden_path`）、拒绝 `sessions/**`；符号链接由 `src/codex/config.js` 拒绝（403 `symlink_refused`）。
- **写入链**：`plan` → `confirmToken` → `apply`；`expected` 快照（`exists/size/sha256`）不匹配即 409 `concurrent_modification`；缺令牌 400 `confirmation_required`；不做盲写。
- **回滚链**：`backupPath` 必须位于 `<path>.bak*` 名下，`expectedSha256` 必须匹配当前文件，`confirmToken` 派生自 `(path, currentSha, backupSha)`。
- **不回显内容**：错误体只有 `{ ok:false, error, code }`，不含文件正文、令牌或哈希之外的元数据。
- **审计**：只写一行 `audit codex <action> path=<abs path> fields=<受控字段名> result=<ok|错误码>`；不含正文、令牌、文件哈希。

## 5. 目录状态（只读摘要）

`GET /api/codex/catalog/status` 与 `/policy` 里的 `catalog` 字段：

| 字段 | 说明 |
| --- | --- |
| `available` | `cfg._codexCatalog` 是否存在 |
| `reason` | `not_configured`（没有 `codexCatalogBasePath`）/ `catalog_unavailable`（配置了但生成失败或基线缺失） |
| `generation` | `sha256(view.key)` 前 12 位，稳定标识这一次目录视图 |
| `counts` | `{ official, thirdParty, total }` |
| `officialSlugs` | 截断后的官方 slug（默认 50，`?limit=` 最大 200），配 `officialSlugsTruncated` / `officialSlugCount` |
| `thirdParty` | 截断后的 `{ slug, provider, model, capability }`，配 `thirdPartyTruncated` |
| `stale` | 用 `view.key` 里的 `(mtimeMs, size)` 与当前文件对比；文件读不到时为 `null`（不编造） |
| `basePathName` | 只给文件名，不给完整路径 |

整份目录（数百 KB 的 `ModelInfo`）**永不出现在响应里**；测试用 `base_instructions` 哨兵断言过。

## 6. 前端行为（/ui-next「客户端接入」）

- 渲染时探测 `GET /api/codex/policy`（走 `js/api.js` 的同源客户端，令牌只在内存中）；带 15s 缓存，失败不抛错。
- 探测成功：写入徽标显示「服务端受控写入就绪」，目录世代取自服务端摘要，字段所有者表以服务端 `policy` 为准。
- 探测失败（401/403/404/网络错误）：徽标回落「仅导出（接口未就绪）」，目录世代显示 `UNKNOWN`，所有者表退回内置常量。
- 浏览器始终不直接写文件、不重启客户端；写入必须由人把路径交给服务端并确认令牌。

## 7. 错误码

| HTTP | code |
| --- | --- |
| 400 | `invalid_body` `invalid_path` `invalid_desired` `not_owned_field` `unsupported_value` `multiline_value` `duplicate_key` `duplicate_section` `unsupported_layout` `snapshot_required` `confirmation_required` `not_a_file` |
| 401 | `unauthorized` |
| 403 | `forbidden_path` `symlink_refused` `remote_forbidden` |
| 404 | `unknown_endpoint` `config_not_found` `backup_not_found` |
| 405 | `method_not_allowed` |
| 409 | `concurrent_modification` `unmanaged_conflict` |
| 413 | `too_large` |
| 500 | `stat_failed` `backup_failed` `write_failed` `verify_failed` |

## 8. 测试

```bash
node --test scripts/test/offline/codex-api.test.mjs     # 26/26
```

直接调用 `handleCodexApi(ctx)`，不起网关：覆盖 401/403/404/405、`headersSent` 不二次写头、本机判定、路径护栏（相对/`auth.json`/`sessions`/非 `config.toml`/符号链接）、plan 不写盘、缺 `expected`/缺令牌拒绝、并发冲突 409、apply→`.bak`→rollback 全链路、目录摘要与 stale 判定、大 diff 截断、审计不含正文/令牌/哈希、以及前端探测成功与四种失败回落（stub fetch，不联网）。

## 9. NOT_RUN

- 真实 `~/.codex/config.toml` 写入、Codex 重启后的实际加载：**NOT_RUN**（需所有者逐项授权）。
- index.js 实际挂载与真实浏览器里的 401/403 链路：**NOT_RUN**（等 Lead 挂载后复验）。
- 反向代理/远程管理场景：本接口默认只允许本机，未做远程用例。
