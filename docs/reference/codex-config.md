# Codex 配置受控写入参考（E6 / D5）

适用于 `src/codex/config.js`（实现）与 `src/ui-next/js/views/codex.js`（只读预览）。本页写契约，不写操作步骤。

当前状态：模块、离线测试与 **`/api/codex/*` HTTP 路由均已落地**（`src/codex/api.js` 在 `src/index.js` 中挂载，见 §3.1）。受控写入默认关闭：只有当启动期用 `MG_CODEX_MANAGED_ROOT` 登记了名为 `config.toml` 的受控根时，`apply` / `rollback` 才可用（否则 403 `write_disabled`）。**真实日常 `~/.codex/config.toml` 写入与 Codex 重启后的加载仍属真机验收项，NOT_RUN**（见 §7）。本页只描述字段与事务口径，不记录任何密钥。

## 1. 身份前提（D1-A，Codex 0.167 实测）

| 事实 | 后果 |
| --- | --- |
| `openai` 是 reserved built-in provider ID | 写 `[model_providers.openai]` 会让客户端直接启动失败；本模块**永不生成**该段 |
| 唯一受支持的改向字段是顶层 `openai_base_url` | 目标配置只经该字段把官方身份指到 ModelGate |
| 官方身份下先 `GET {openai_base_url}/v1/models?client_version=<ver>` | 网关必须提供该形状的目录；缺失时客户端告警并回落 fallback metadata |
| 客户端先尝试 `WebSocket GET /v1/responses`（upgrade），失败后回落 `POST` | 现象是连接失败而不是模型错误时先查这一点 |
| 请求体 `content-encoding` 可能是 `zstd` | 网关必须能解码或明确拒绝 |
| 官方身份会带真实 ChatGPT Bearer 与 `chatgpt-account-id` | 只允许走受支持的官方路径；第三方上游一律不得接收（E1 身份隔离） |

> 表中「唯一受支持的改向字段」指**内置 `openai` 身份**下的顶层 `openai_base_url`。经网关还有第二种形态：独立的 `[model_providers.modelgate]` provider 段（provider 级 `base_url`），用于路由接入方式；两者语义不同，详见 §2.1 与[三模式接入方式映射](../product/2026-11-18-three-mode-access-mapping.md)。

## 2. 字段所有权

**受控可写（模块唯一能改的字段）**

| 字段 | 含义 |
| --- | --- |
| `model_provider` | 固定语义为内置 `openai` 身份（D1-A） |
| `openai_base_url` | 指向 ModelGate 根地址（不带 `/v1`；客户端自行追加 `/v1/...`） |
| `model` | 聚合模型 ID |
| `model_catalog_json` | 本地完整 Codex 目录的绝对路径（全量替换语义） |
| `[features]` 的 `multi_agent` / `multi_agent_v2` | D3 的 v2 优先开关（0.167 默认 `false`） |

**owned 白名单变化（受控可写的段，随三模式扩展）**：除上表的顶层字段外，模块还拥有以下段；段内只允许白名单键，其余键一律 `not_owned_field` 拒绝。

| 段 | 允许键 | 用途 |
| --- | --- | --- |
| `[features]` | `multi_agent`、`multi_agent_v2` | D3 的 v2 优先开关（0.167 默认 `false`） |
| `[model_providers.modelgate]` | `name`、`base_url`、`wire_api`、`requires_openai_auth`、`supports_websockets` | 路由接入方式的独立 provider 段；三模式引入 `supports_websockets` 到白名单 |
| `[model_providers.modelgate.capabilities]` | `remote_compaction` | 仅 `unsupported` / `v2`（RemoteCompactionSupport 枚举，由 Codex 解析器实证） |
| `[agents.go_deepseek]` | `description`、`config_file` | 聚合方式的托管原生子代理（GPT 父 → DeepSeek 子） |

**managed 形态字段说明**（路由接入方式，`mode=route`）：

- `base_url = "http://127.0.0.1:8787/v1"` —— **带 `/v1`**，是 provider 级地址；与顶层 `openai_base_url`（网关根地址、不带 `/v1`）语义不同，不可混写。
- `wire_api = "responses"`、`requires_openai_auth = false` —— 该 provider 不依赖官方 ChatGPT Bearer；**不写任何内嵌 Key 字段、不写 bearer token / 客户端密钥**，仅信任本机回环。
- `supports_websockets = false` —— 关闭 WebSocket 升级，统一走 HTTP `POST /v1/responses`。
- `[model_providers.modelgate.capabilities] remote_compaction = "unsupported"` —— 关闭远程压缩，由 Codex 侧本地压缩。
- 禁止触碰 `[model_providers.openai]`（reserved built-in provider ID，发现既有段只告警、不删改）。

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

### 3.1 已落地的 HTTP 路由（`/api/codex/*`）

服务端 `src/codex/api.js` 的 `handleCodexApi` 已在 `src/index.js` 挂载；一律要求**显式管理员令牌**（未设置 adminToken 时回环也 403 `explicit_admin_required`），Host/Origin/来源校验先于读 body。

| 方法 / 路径 | 作用 | 写盘 |
| --- | --- | --- |
| `GET /api/codex/policy` | 字段所有权 + 目录摘要 + 路由清单 | 否 |
| `POST /api/codex/config/plan` | 只读预览：差异 / 脱敏值 / `planId` + `confirmToken` | 否 |
| `POST /api/codex/config/apply` | 受控写入：二次快照 + 原子写 + 备份 + 写后校验（仅 managed，必须回传 `planId`） | 是 |
| `POST /api/codex/config/rollback` | 按不透明 `backupId` 回滚（仅 managed，必须回传 `planId`） | 是 |
| `GET /api/codex/config/export` | 只回 owned 字段的归一化投影（无保留行、无凭据） | 否 |
| `GET /api/codex/catalog/status` / `quota` / `emergency` | 目录世代、官方额度三态、应急试算 | 否 |

`apply` / `rollback` 默认 403 `write_disabled`；仅当启动期 `MG_CODEX_MANAGED_ROOT` 成功登记受控根后可用。路由已接入 ≠ 真实 `~/.codex` 已写入：后者仍需隔离实例与真机授权验收（§7）。

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
- 写入路径：`/api/codex/config/*` 路由已接入（§3.1）。未登记 managed 根时 `plan` 可做只读预览、`apply`/`rollback` 返回 403 `write_disabled`，UI 据此降级为「仅导出」；登记后走预览→确认→回执。浏览器永不直接写文件，也不重启客户端；**切换接入方式后必须完全退出并重新打开 Codex GUI 才生效**。
- 接入方式三选一（直连 / 路由 / 聚合）与父子模型可不同：聚合方式下 GPT 父（默认 `gpt-6-luna`）与 DeepSeek 子是不同模型；路由方式下父与子是同一 DeepSeek 别名。父模型不由模块自动替换或降级。映射口径见[三模式接入方式映射](../product/2026-11-18-three-mode-access-mapping.md)。

## 6. 测试与证据

```bash
node --test scripts/test/offline/codex-config.test.mjs     # 24/24
npm run check                                              # 含 check-ui 16/16
```

覆盖：保留未知字段/MCP/projects/权限/注释、字段级 diff 所有者、缺快照与错令牌拒绝、并发冲突（sha256/size/删除）、原子写无 tmp 残留、`.bak` 与 `.bak.prev`、回滚一致性、写失败零改动、`allowCreate` 0600、既有 `[model_providers.openai]` 只告警、CRLF 与无结尾换行、拒绝 `auth.json`/相对路径/符号链接/多行值/重复键、`openai_base_url` 语义、以及「模块不读 HOME、不触网」的静态断言。

浏览器验收（隔离实例 18766 + 本地 mock 上游 + CDP Chrome，`scripts/test/ui-browser-check.mjs`）：14/14 PASS，含「客户端接入」页渲染与 1440/1024/768/390 无横向溢出。证据截图 `/tmp/mg-e6-ui-shots`（非仓库资产）。

## 7. 未验证 / NOT_RUN

- 真实日常 `~/.codex/config.toml` 写入与 Codex 重启后的实际加载：**NOT_RUN**（需所有者逐项授权；§3.1 的路由已接入不等于已对日常文件写入）。
- `/api/codex/config/*` 路由接入（index.js 侧）：**已实现**（`src/codex/api.js`，见 §3.1），并有离线路由契约测试；先前「未实现、UI 固定 export-only」的表述已过期。未登记 managed 根时 `apply`/`rollback` 仍返回 403 `write_disabled`，属默认关闭策略而非未接入。
- 三模式（直连 / 路由 / 聚合）切换、切换后重启生效、路由模式零 GPT 调用：**实现中 / 真机 NOT_TESTED**，见[三模式接入方式映射](../product/2026-11-18-three-mode-access-mapping.md)与[桌面验收手册](../how-to/desktop-acceptance.md)。
- 真实官方账号下 `openai_base_url` 指向网关后的同会话切换、目录加载、WebSocket 回落：**NOT_RUN**（属 E3 证据范围）。
- 非 `gpt-6-luna` 的 GPT 父模型真实验收：**UNVERIFIED**（MG-R012 仅允许 Luna 签 `PASS_REAL`，需所有者书面放宽方可放宽）。
- Desktop 端配置形态：三模式接入方式在真实 Codex Desktop GUI 的行为未验证。

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
