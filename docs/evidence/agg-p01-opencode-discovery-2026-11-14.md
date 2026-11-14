# A2 / P01：OpenCode 全量发现证据（2026-11-14）

- **角色**：A2 OpenCode Integration Architect
- **分支 / worktree**：`feat/agg-a2-discovery` / `.agents/worktrees/agg-a2-discovery`
- **绑定提交**：`3d68a80`（注册表 + Console 适配）、`b7027c1`（发现）、`cf14f7a`（目录 + 处理器 + 探针）、`47cca72`（离线用例）。本文件提交后其 SHA 由 `git log` 给出。
- **需求口径**：`docs/product/2026-11-14-owner-product-contract.md`（MG-R003/R004/R008/R009/R011/R012）与 `docs/architecture/2026-11-14-aggregation-interfaces.md`（ADR-0003）。
- **结论先行**：**MG-R003 仍为 `PASS_MOCK`，不是 `PASS_REAL`。** 真实 OpenCode Console/Go 的模型清单端点、JSON 形状与账户授权范围尚未由任何 live 调用核对；按任务约束，本轮**没有**向 `opencode.ai` 或任何上游发请求。

## 1. 本轮真正落地的行为

| 能力 | 实现 | 证据 |
| --- | --- | --- |
| Provider 自动入职 | `src/aggregation/registry.js`：写入既有 `gateway.local.json` 的 `providers` 映射，复用 `src/config-transaction.js` 的锁/指纹/原子 rename，推进既有 `configVersion`（过期 409 + `currentVersion`） | `agg-discovery-catalog.test.mjs` 注册表用例 |
| Console 适配 | `src/providers/opencode-console.js`：入口白名单、别名 fail-closed、effort、错误解码、HMAC 会话头、能力新鲜度 | `agg-discovery-console.test.mjs` 9 用例 |
| 全量发现 | `src/aggregation/discovery.js`：游标 + 页码分页、`maxPages` 上限、重复/别名合并、逐模型授权、ETag/Last-Modified、`discovery_complete/partial/failed` | `agg-discovery-pagination.test.mjs` 14 用例 |
| 同步 | `sync(providerId)`：新增/删除/更新；部分失败不覆盖已完成快照；scope 隔离 | `agg-discovery-sync.test.mjs` 7 用例 |
| 目录发布 | `src/aggregation/catalog.js`：经 `catalog-generation` 生成世代 + CAS 原子提交；`assertCatalog`/`assertZeroCollisions`；`mg-opencodego-*` 字节兼容；无权模型不发布；溢出写本机全量目录；整代回滚 | `agg-discovery-catalog.test.mjs` 10 用例 |
| HTTP 面 | `src/aggregation/handlers.js`：显式管理员 + 回环 + Host/Origin + `configVersion`；`activate/deactivate` 只转交 A3，未注入时 501 | 同上「HTTP 守卫」 |
| live 探针 | `scripts/aggregation-probe.mjs`，`MG_AGG_LIVE_PROBE=1` 才联网；只打印 counts/IDs | 本文件 §4 |

**没有**接线 `src/index.js`、`src/router.js`、UI、`package.json`、`scripts/test/run.mjs`。`run.mjs` 的临时登记已用 `git restore scripts/test/run.mjs` 还原（工作树无该文件改动）。

## 2. 可复制命令与结果

逐套件（无需登记，直接跑）：

```bash
node scripts/test/offline/agg-discovery-console.test.mjs      # tests 9  pass 9  fail 0
node scripts/test/offline/agg-discovery-pagination.test.mjs   # tests 14 pass 14 fail 0
node scripts/test/offline/agg-discovery-sync.test.mjs         # tests 7  pass 7  fail 0
node scripts/test/offline/agg-discovery-catalog.test.mjs      # tests 10 pass 10 fail 0
npm run check                                                 # PASS, UI modules 16/16
```

集成验证（临时把四个套件登记进 `scripts/test/run.mjs` 后）：

```bash
npm test
# suites: 81 passed, 0 failed, 0 skipped, 0 timed out, 0 not run (manifest 81/selected 81)
# tests:  822 passed, 0 failed, 1 skipped (76/81 suites reported node:test counts)
```

随后已还原 `scripts/test/run.mjs`；上述 81/822 不能靠当前工作树的 `npm test` 复现，直到主代理在整合时正式登记四个 suite。

## 3. 未核实的 API 假设（逐条）

本模块**不知道** OpenCode 的真实清单 API。以下全部是显式假设；不匹配时 fail-closed，不会退化成“空模型目录”。

1. **Console 入口形状**：`/console/v1`、`/console/openai/v1`、`/zen/v1`（chat/responses）。每条 `validate()` 都带 `console_entry_assumed` 警告；未知形状报 `opencodeconsole_entry_unknown`。
2. **Console 模型清单 URL**：入口根 + `/models`（或显式 `modelListUrl`）。报 `endpoint_assumed` / `entry_assumption_unverified` 诊断。
3. **Go 模型清单 URL**：由 Go 入口推导 `<root>/models`（`/inference/go` 根则 `/inference/go/v1/models`）。Go 文档没有登记 list 端点；报 `go_list_assumption`。
4. **响应形状**：裸数组、`{data}`、`{models}`、`{items}`、`{objects}`、`{result}`、`{result:{data|models|items}}`。其它形状报 `discovery_shape_unrecognized`。
5. **游标分页字段**：`next_cursor`/`nextCursor`/`pagination.next_cursor`；`has_more` 时读 `cursor`。
6. **页码分页字段**：`next_page`/`nextPage`/`next`（数字）/`has_next`；`total` + `per_page` 推导；`next` 为 URL 时只允许同源。
7. **模型字段别名**：`id`/`model_id`/`modelId`/`slug`/`name`；上下文窗口 `context_window`/`contextWindow`/`context_length`/`contextLength`/`max_context_tokens`/`limits.context`。
8. **授权字段**：`authorized`/`enabled`/`allowed`/`access`/`status`/`permissions.chat`；缺席时按“出现在账户清单即授权”处理（`authBasis=listed`），并强制 `authorization_inferred_from_listing` 警告。
9. **能力字段**：`tools`/`supports_tools`、`supports_search_tool`、`supports_websockets` 及 `capabilities.*` 同义；缺席一律 `false`。
10. **条件缓存**：假设上游支持 `ETag` / `Last-Modified` 与 304；不支持时只是每次全量，不影响正确性。
11. **Codex 目录规模上限**：`maxModels: 512`、`maxBytes: 2 MiB` 是**假设**（可经 `limits` 覆盖），不是官方实测值。超限时写 `full-catalog.json`，绝不裁剪。
12. **Console/Go 是否暴露上下文窗口**：未知。缺失时发布 `fail-closed`（`context_window_missing`），不编造数字。
13. **429/403 语义**：与 Go 适配器同构的保守分类；Console 的额度/工作区错误文案未核实。

## 4. 等待所有者批准的 live 探针（未执行）

```bash
# Console
MG_AGG_LIVE_PROBE=1 node scripts/aggregation-probe.mjs --provider console --max-pages 3
# Go
MG_AGG_LIVE_PROBE=1 node scripts/aggregation-probe.mjs --provider opencodego --max-pages 3
```

前提：该 provider 已在网关配置中入职、凭据已由既有 keys/env 链可解析。输出仅 `{completeness, code, counts, models:[{publicId,upstreamId}], diagnostics:[code]}`；不含 Key、Authorization、账户标识或上游正文。默认 `max-pages=1`，不重试、不写目录、不改配置。

判读：`discovery_endpoint_missing` / `discovery_shape_unrecognized` / `discovery_pagination_unknown` 表示假设不成立，需要按真实响应修正旁路，而不是“账户没有模型”。

## 5. 需求状态

| 需求 | 状态 | 依据 |
| --- | --- | --- |
| MG-R003 自动发现全部可用模型并同步 | **PASS_MOCK** | 逻辑与失败分类由录制 fixture 证明；真实目录 ↔ GUI/Codex 双向对账 **BLOCKED**，待 §4 探针与 A3 GUI 验收 |
| MG-R004 GUI/Codex 使用聚合模型 | NOT_TESTED | A3/A5 范围 |
| MG-R008 无静默降级 | **PASS_MOCK**（模块级） | 失败不返回空目录、部分页=partial、无权模型不发布、缺上下文 fail-closed、溢出不裁剪；GUI 反向验收仍待 A5 |
| MG-R009 多用户隔离 | **PASS_MOCK**（快照/目录 scope） | 两个 scope 独立文件与世代；完整多身份隔离属 A4/A5 |
| MG-R011 真实证据 | PASS（本文件） | 绑定上述 SHA、命令与 pass/fail；明确 mock ≠ real |
| MG-R012 仅 GPT-6 Luna | N/A | 本轮无任何 GPT 调用 |

`PASS_MOCK` 永不等于 `PASS_REAL`。在所有者批准 §4 探针并完成 A3 GUI 对账前，MG-R003 不得签收。

## 6. 已知失败与边界

- 无离线失败；`npm test` 1 个 skip 是既有 `MG_CODEX_VERIFY=1` 门禁项，与本轮无关。
- `catalog-generation` 的 `verified.official/thirdParty=true` 是**生成器结构校验**标志，不代表真实上游已核对；本轮记录额外带 `verified.realUpstream=false`。
- 未接线路由、未登记 suite、未推送、未开 PR；均为主代理整合步骤。
