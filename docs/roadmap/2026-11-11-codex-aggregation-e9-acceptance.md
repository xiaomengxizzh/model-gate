# E9 验收矩阵与交付记录（2026-11-11）

> 分支：`dev/codex-aggregation-20261111`（基线 `ec66b24` = Draft PR #5 head）
> 实现提交：`d373a06`（E1–E8 代码 + 测试 + CLI + UI）；文档/证据提交：本提交（`git log -2`，紧随实现提交之后）。
> **未合并、未推送、未部署、未修改 main / 现有 Draft PR / 正式配置 / systemd / 8787。**

## 1. 阶段状态

| 阶段 | 状态 | 主要产物 | 证据 |
| --- | --- | --- | --- |
| E0 审计与隔离 | ✅ | `docs/roadmap/2026-11-11-codex-aggregation-e0-baseline.md` | 30/30 基线套件、端口/哈希隔离断言 |
| E1 凭据隔离 + 严格路由 | ✅ | `src/codex/identity.js`、`auth.js`、`forward.js`、`router.js` | `offline/codex-identity`(14)、`codex-routing-catalog`(10) |
| E2 动态目录 | ✅ | `src/codex/catalog.js`、`scripts/codex-catalog.mjs` | `offline/codex-catalog`(27)，真实 `codex debug models` 解析 14 模型 |
| E3 同线程切换 | ✅ | 官方透传代理、zstd 解码、`/v1/models` Codex 形状 | **LIVE 5/5**（真实官方后端）、离线真客户端 9/9 |
| E4 v2 互操作 | ✅ | `src/codex/interop.js`、`responses.js` | `offline/codex-interop`(15)、真实 wire 抓包 |
| E5 智能 Fallback | ✅ | `src/routing/decision.js` 接入 `forward.js` | `codex-fallback`(29) + `codex-fallback-forward`(10) |
| E6 受控配置 + UI | ✅ | `src/codex/config.js`、`api.js`、`ui-next` | `codex-config`(31)、`codex-api`(26)、浏览器 8/8 |
| E7 历史只读 | ✅ | `src/codex/history.js` | `codex-history`(3)，零写入断言 |
| E8 额度应急 | ✅ | `src/codex/quota.js` | `codex-quota`(6)，UNKNOWN 语义 |

## 2. 验收矩阵（如实分级）

| 验收任务 | 离线 Mock | 真实 Codex CLI | 真实 Codex Desktop | 说明 |
| --- | --- | --- | --- | --- |
| 官方/第三方认证头隔离 | ✅ 必须 | ✅ 本轮 | NOT_RUN | 逐头断言 + 真实请求抓包（只记头名） |
| 同一目录 /model 可见 | ✅ | ✅（catalog 生效，无 fallback 告警） | NOT_RUN | 目录 14 模型 |
| GPT→第三方→GPT 同线程 | ✅ 9/9 | ✅ **LIVE 5/5 + LIVE-REAL 7/7** | NOT_RUN | 真实 chatgpt.com + 真实 OpenCode Go（deepseek-v4.1-flash）同线程三轮 |
| SSE 与历史重放 | ✅ | ✅ 连续三轮 resume | NOT_RUN | 流内 completed 正常 |
| v2 子代理工具闭环 | ✅ 映射/阻断 15/15 | ⛔ BLOCKED（显式） | NOT_RUN | 官方主代理成功 spawn 第三方子代理；子代理请求含加密 agent_message，网关返回 v2_encrypted_task_unsupported（证据 docs/evidence/2026-11-11-e4-v2-live-blocked.md） |
| v2 加密失败显式 | ✅ | NOT_RUN | 适用时 NOT_RUN | 无"解密成功"假象 |
| 智能 Fallback | ✅ 10/10 | 经授权可复测 | — | 429/5xx/402/404/断流/取消/预算全注入 |
| 配置 diff/冲突/回滚 | ✅ | 隔离目录 | 隔离目录 | 真实 `~/.codex/config.toml` 写入 NOT_RUN |
| 历史选择性迁移 | ✅ 模拟 | NOT_RUN 未授权 | NOT_RUN 未授权 | 写入接口 `not_authorized` |
| 官方额度/应急 | ✅ | NOT_RUN | NOT_RUN | 无可靠额度源 → UNKNOWN |

## 3. 门禁真值（最终一次）

```text
npm run check        → 0（UI modules 16/16）
npm test             → 43/43 隔离套件通过
npm run docs:check   → PASS
node scripts/check-metadata.mjs → PASS (21 checks)
scripts/test/codex-e2e.mjs  → 9/9（真实 Codex CLI × 双 mock）
scripts/test/codex-live.mjs → 5/5（真实 Codex CLI × 真实官方后端 × 本地第三方 mock）
```

旧集成套件（`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs`）**未纳入默认门禁，本轮 NOT_RUN**：
它包含需要 CDP Chrome:9222 的 `ui-browser-check` 与常驻 fixture 服务，本机无该浏览器会话时会阻塞/报错（实测 `connect ECONNREFUSED 127.0.0.1:9222`），
因此不作为聚合改动的回归证据；默认白名单 43 套件才是本仓库的回归闸门。

> 另：`ui-browser-check` 的 dashboard 断言在“部分上游熔断”状态下会得到 `13/14`（该断言读 `/api/status` 的熔断态，与本次 Codex 改动无关，clients 页检查本身 PASS、0 页面异常）；未修改该历史脚本。

## 4. 复现（隔离，不触碰正式环境）

```bash
# 目录
node scripts/codex-catalog.mjs --base /tmp/mg-e0/catalog-default.json \
  --models <gateway-config.json> --out /tmp/catalog.json --verify-codex

# 离线真客户端（双 mock 上游）
CODEX_HOME=/tmp/<temp> node scripts/test/codex-e2e.mjs

# LIVE（真实官方后端；需临时 CODEX_HOME 中的官方登录副本）
CODEX_HOME=/tmp/<temp> node scripts/test/codex-live.mjs
```

## 5. 回滚

| 阶段 | 回滚 |
| --- | --- |
| E1–E8 | `git revert d373a06`（或按阶段 revert 对应文件）；新增文件删除即可 |
| 目录/配置 | 无正式配置文件被写；`~/.codex` 未改动；临时 `CODEX_HOME` 全部可删 |
| 证据 | 本目录与 `docs/evidence/2026-11-11-*` 可整体删除 |

## 6. 未完成 / NOT_RUN / 风险

- **Desktop 同会话切换**：NOT_RUN（Desktop 打包 app 的 openai_base_url 与单实例行为未验证）。
- **真实第三方付费上游的聚合轮次**：本轮第三方轮用本地 mock；真实 OpenCode Go 文本链路已在 2026-11-09 证据中验证。
- **v2 跨供应商真实端到端**：NOT_RUN（需真实第三方 v2 工具 + 官方主代理）。
- **真实配置写入/客户端重载、历史迁移、额度应急**：NOT_RUN（按 D5/D6/D7 需逐项确认）。
- **WebSocket 代理**：未实现（回 404 让客户端回落 HTTPS，实测可用）。
- **P1**：Fallback 链仍按配置顺序推进；`partially_committed` 无自动信号；`ui-browser-check` 的 dashboard 断言在部分熔断态下 13/14（与本次 diff 无关，已单独记录）。
- **P0 合规**：官方订阅流量经本地网关的条款/政策边界由所有者授权本轮测试；产品化发布前需单独合规结论。

## 7. 合并建议（不自动执行）

仅向所有者提交评审：建议按 E1/E2/E3/E4/E5/E6/E7/E8 分组审阅 `d373a06`，重点看
`src/codex/auth.js`（凭据边界）、`src/forward.js`（决策接入）、`src/index.js`（官方透传与目录注入）。
未获批准前不合并、不推送、不部署。
