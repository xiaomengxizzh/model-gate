# Codex 配置受控写入参考（E6 / D5）

适用于 `src/codex/config.js`（实现）与 `src/ui-next/js/views/codex.js`（只读预览）。本页写契约，不写操作步骤。

当前状态：模块与离线测试已落地，**尚未接入任何 HTTP 路由**，**未在真实 `~/.codex/config.toml` 上写入**（见 §7 NOT_RUN）。

## 1. 身份前提（D1-A，Codex 0.167 实测）

| 事实 | 后果 |
| --- | --- |
| `openai` 是 reserved built-in provider ID | 写 `[model_providers.openai]` 会让客户端直接启动失败；本模块**永不生成**该段 |
| 唯一受支持的改向字段是顶层 `openai_base_url` | 目标配置只经该字段把官方身份指到 ModelGate |
| 官方身份下先 `GET {openai_base_url}/v1/models?client_version=<ver>` | 网关必须提供该形状的目录；缺失时客户端告警并回落 fallback metadata |
| 客户端先尝试 `WebSocket GET /v1/responses`（upgrade），失败后回落 `POST` | 现象是连接失败而不是模型错误时先查这一点 |
| 请求体 `content-encoding` 可能是 `zstd` | 网关必须能解码或明确拒绝 |
| 官方身份会带真实 ChatGPT Bearer 与 `chatgpt-account-id` | 只允许走受支持的官方路径；第三方上游一律不得接收（E1 身份隔离） |

## 2. 字段所有权

**受控可写（模块唯一能改的字段）**

| 字段 | 含义 |
| --- | --- |
| `model_provider` | 固定语义为内置 `openai` 身份（D1-A） |
| `openai_base_url` | 指向 ModelGate 根地址（不带 `/v1`；客户端自行追加 `/v1/...`） |
| `model` | 聚合模型 ID |
| `model_catalog_json` | 本地完整 Codex 目录的绝对路径（全量替换语义） |
| `[features]` 的 `multi_agent` / `multi_agent_v2` | D3 的 v2 优先开关（0.167 默认 `false`） |

**只读保留（模块不修改、不改写顺序）**：`[mcp_servers.*]`、`[projects.*]`、`approval_policy` / `sandbox_mode` 等权限与信任段、所有未知字段与注释。写前写后各算一次 `unmanagedFingerprint`，指纹不一致即拒绝写入（fail closed）。

**禁止触碰**：`auth.json`（文件名直接拒绝，读写都不做）、`[model_providers.openai]`（发现既有段只告警、不删改）。

## 3. API（纯函数 + 显式绝对路径，不读 HOME）

服务端路由直接调用下列导出；所有路径必须由调用方给出，模块不猜默认值、不读 `~`。

| 导出 | 作用 |
| --- | --- |
| `describeConfigPolicy()` | JSON 化的所有权与保证清单（可直接回给 UI） |
| `snapshotConfigFile(path)` | `{ exists, size, sha256, mtimeMs, mode }`；不写入 |
| `readOwnedFields(text)` | 只读：当前 owned 字段取值 + 需要人工处理的既有段 |
| `planConfigApply({ path, desired, allowCreate?, includeTexts? })` | 纯预览：before/after 快照、`changed`、`diff`、`preserved`、`warnings`、`confirmToken`；默认**不回传文件正文** |
| `applyConfigChange({ path, desired, expected, confirmToken, allowCreate?, backupDir? })` | 实际写入：快照校验 → 令牌校验 → 写前二次快照 → `.bak` → tmp+fsync+rename → 写后 sha256 校验 |
| `planRollback({ path, backupPath? })` / `rollbackConfigChange({ path, backupPath, expectedSha256, confirmToken })` | 回滚：需要当前 sha256 与回滚令牌；回滚前把当前状态另存 `config.toml.bak.pre-rollback` |
| `buildDesiredCodexConfig({ gatewayBaseUrl \| openaiBaseUrl, model, modelCatalogJsonPath?, features? })` | 生成 D1-A 目标配置 + 风险清单（路由与 UI 共用同一口径） |
| `mergeOwnedFields(text, desired)` / `diffConfigText(before, after)` | 纯函数合并与行级差异（每行标注 `owner`） |
| `ConfigError` | 带稳定 `.code` 的错误类型 |

`desired` 形状：

```js
{
  topLevel: { model_provider: 'openai', openai_base_url: 'http://127.0.0.1:8787', model: 'mg/x', model_catalog_json: '/abs/path/catalog.json' },
  sections: { features: { multi_agent_v2: true } }   // 可选
}
```

## 4. 写入事务与冲突语义

1. `planConfigApply` 读取文件 → `before = { exists, size, sha256 }`；调用方把 `before` 与 `confirmToken` 展示给用户。
2. `applyConfigChange` 先比对调用方传入的 `expected`：`sha256`、`size`、`exists` 任一不符 → `concurrent_modification`（原文件零改动）。
3. 校验 `confirmToken`（缺失/错误 → `confirmation_required`）；令牌由 contract + path + beforeSha + afterSha 派生，不含用户内容。
4. 写入前**再做一次**快照比对，把 TOCTOU 窗口压到一次 stat+read。
5. 旧内容写 `config.toml.bak`（0600）；已有且内容不同的 `.bak` 先轮转为 `.bak.prev`。
6. 临时文件 `.config.toml.mg-<pid>-<rand>.tmp` 写入 + fsync + chmod（沿用原文件模式）+ rename 原子替换。
7. 写后读回校验 sha256；失败则用 `.bak` 恢复并抛 `verify_failed`。
8. 合并结果与原文的 `unmanagedFingerprint` 必须一致，否则 `unmanaged_conflict`（拒绝整文件覆盖）。

错误码：`invalid_path`、`forbidden_path`、`symlink_refused`、`not_owned_field`、`unsupported_value`、`multiline_value`、`duplicate_key`、`duplicate_section`、`unsupported_layout`、`unmanaged_conflict`、`config_not_found`、`snapshot_required`、`confirmation_required`、`concurrent_modification`、`backup_failed`、`write_failed`、`verify_failed`、`backup_not_found`、`too_large`。

## 5. UI（/ui-next「客户端接入」）

新增卡片「Codex 聚合（D1-A 内置 openai 身份）」：

- 身份事实与风险提示（reserved provider、`/v1/models?client_version`、WebSocket 回落、zstd、官方凭据不外流）。
- 模板 = 仅所有权字段 + 注释；复制与导出（`.toml` 片段与计划 `.json`）。
- 字段所有者表（受控可写 / 只读保留 / 禁止触碰）。
- 前后差异：粘贴当前 `config.toml` 后在本标签页内存中逐字段比对（不发请求、不保存、不写盘），展示当前值→写入值、行号、将覆盖项与阻断项。
- 目录世代与写盘能力只认 `/api/status` 的真实字段；没有就是 `UNKNOWN`，不编造「已生效」。
- 写入路径：`/api/codex/config/*` 未就绪时固定「仅导出」；浏览器永不直接写文件，也不重启客户端。

## 6. 测试与证据

```bash
node --test scripts/test/offline/codex-config.test.mjs     # 24/24
npm run check                                              # 含 check-ui 16/16
```

覆盖：保留未知字段/MCP/projects/权限/注释、字段级 diff 所有者、缺快照与错令牌拒绝、并发冲突（sha256/size/删除）、原子写无 tmp 残留、`.bak` 与 `.bak.prev`、回滚一致性、写失败零改动、`allowCreate` 0600、既有 `[model_providers.openai]` 只告警、CRLF 与无结尾换行、拒绝 `auth.json`/相对路径/符号链接/多行值/重复键、`openai_base_url` 语义、以及「模块不读 HOME、不触网」的静态断言。

浏览器验收（隔离实例 18766 + 本地 mock 上游 + CDP Chrome，`scripts/test/ui-browser-check.mjs`）：14/14 PASS，含「客户端接入」页渲染与 1440/1024/768/390 无横向溢出。证据截图 `/tmp/mg-e6-ui-shots`（非仓库资产）。

## 7. 未验证 / NOT_RUN

- 真实 `~/.codex/config.toml` 写入与 Codex 重启后的实际加载：**NOT_RUN**（需所有者逐项授权）。
- `/api/codex/config/*` 路由接入（index.js 侧）：**未实现**，UI 因此固定 export-only。
- 真实官方账号下 `openai_base_url` 指向网关后的同会话切换、目录加载、WebSocket 回落：**NOT_RUN**（属 E3 证据范围）。
- Desktop 端配置形态：未验证。

## 8. 回滚

- 单次写入：用 `config.toml.bak` 走 `rollbackConfigChange`（回滚前状态另存 `.bak.pre-rollback`）。
- 代码：删除 `src/codex/config.js`、`src/ui-next/js/views/codex.js` 与 `scripts/test/offline/codex-config.test.mjs`，并移除 `clients.js` 中对 `codexAggCard` 的调用；不涉及数据迁移。
- 配置：本模块不迁移任何历史会话，回滚只需还原 `config.toml`。

## 9. 风险

| 级别 | 风险 | 缓解 |
| --- | --- | --- |
| P0 | 官方订阅经本地网关转发的条款/政策边界未核实 | 未获授权前不改 `openai_base_url`，保持官方直连 |
| P0 | 目录缺失导致能力静默退化 | `model_catalog_json` 必须完整；UI 明示回落到 fallback metadata |
| P1 | 用户已有 `[model_providers.openai]` 会让客户端启动失败 | plan 返回 `warnings` 与 `preserved.reservedOverrides`，只提示不删改 |
| P1 | 写入后不重启客户端，用户误以为已生效 | 文档与 UI 均写明「下次启动或重载生效」 |
| P2 | 同一文件多写者在毫秒级窗口内并发 | 写前二次快照 + 令牌；不做文件锁（本机单用户场景） |
