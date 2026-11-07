# 网关能力升级验收报告（G0→G4）

- 日期：2026-11-07
- 分支：`dev/gateway-g0-g4-20261107`（基于 `main@6bc6441`）
- 测试环境：Linux 7.0.0-42、Node v22.23.2、零第三方依赖、本地 mock 上游、临时配置目录、随机端口
- 结论：**G0 PASS / G1 PASS(离线) / G2 PASS(离线, mock) / G3 PARTIAL / G4 PARTIAL**；真实客户端与真实上游 `NOT_RUN_LIVE`。

## 1. 各阶段状态

| 阶段 | 交付 | 状态 | 证据 |
| --- | --- | --- | --- |
| G0 | 管理 API 契约 v1、协议兼容矩阵、fixtures、G0 审计、宿主/分支盘点 | **PASS** | `docs/contracts/*`、`docs/audits/2026-11-07-g0-audit.md` |
| G1 | 单请求尝试预算、429 归因、非幂等不重放、脱敏、掩码回写、configVersion 并发、诊断字段 | **PASS（离线）** | §3.1、§3.2；`10/15/20` 套件 |
| G2 | `/v1/responses` 一等入口、Chat 桥接、原生直通、Codex SSE 事件顺序、call_id/custom tool、upstreamModel、wire 过滤 | **PASS（离线 mock）** | §3.3；`30/40` 套件 |
| G3 | `/api/capabilities`、`/v1/models.capabilities`、状态诊断字段 | **PARTIAL** | 能力矩阵与指标仅做只读契约；Embedding/Rerank/Audio/Image/Video 未实现（无需求输入，不擅自铺开） |
| G4 | 契约冻结、runbook、验收报告、CHANGELOG、回滚说明 | **PARTIAL** | 文档齐全；真实实机验收与 PR 合并需 owner |

## 2. 代码变更（相对 `main@6bc6441`）

```
src/budget.js       +106   单请求预算 + 429 归因（纯函数）
src/redact.js        +60   文本/头/代理/错误体脱敏
src/responses.js    +423   Responses ⇄ Chat 转换 + Codex SSE 事件顺序 + 原生直通
src/request.js       +73   预算接入、429 错误体归因、Retry-After 上限、noRetry
src/forward.js      +113   预算/429/熔断拆分、wire 过滤、upstreamModel、会话头、408
src/index.js        +207   /v1/responses、trace/attempts、状态脱敏、/api/capabilities、端口 0
scripts/test/offline/*     零依赖离线验收套件（6 文件 82 断言）
docs/contracts/*           契约 + 矩阵 + fixtures
docs/runbooks/*            429/Codex/运维
```

无新增依赖；`package.json` 仅新增 `test:offline` 与 `check` 覆盖新文件。

## 3. 测试证据

### 3.1 命令

```bash
npm run check                 # node --check 全部 src（含 4 个新模块）
npm run test:offline          # 82 断言，0 失败
```

完整输出：`docs/audits/evidence/2026-11-07-offline-tests.log`。

### 3.2 G1 验收项映射

| 验收要求 | 结果 | 用例 |
| --- | --- | --- |
| 400 | PASS | `10`·「400 只命中 1 次」「原样回显」 |
| 401 | PASS | `10`·「401 只命中 1 次且不 fallback」 |
| 403（模型级） | PASS | `40`·「403 继续目录链」 |
| 404（模型级） | PASS | `15`·「404 继续目录链」 |
| 408 | PASS | `15`·「408 有界重试后回 408」 |
| 409（上游瞬态） | PASS | `15`·「409 重试后成功」 |
| 422 | PASS | `15`·「422 不重试且原样回显」 |
| 429 | PASS | `10`·429 归因/Retry-After/预算封顶；`30`·Responses 429 |
| 5xx | PASS | `10`·「5xx 仍可切换备用上游」；`40`·熔断打开/跳过/半开恢复 |
| 重试预算 | PASS | `10`·上游命中 ≤ `budget.maxAttempts`；`Retry-After` 超上限不等待 |
| 非幂等不重放 | PASS | `10`·tool 5xx/429 仅 1 次；`30`·Responses+tools |
| 取消/断流 | PASS | `40`·Chat `stream_interrupted`+`[DONE]`、Responses `response.failed`、客户端 abort 后健康 |
| 双客户端并发配置 | PASS | `20`·同版本并发保存 200+409 |
| 敏感字段脱敏 | PASS | `20`·status/proxy/错误体/日志/keys 落盘；掩码回写不覆盖真实值 |
| 既有 Chat 无回归 | PASS（mock） | `00`·非流式/流式/别名/未知模型 |

### 3.3 G2 验收项映射

| 验收要求 | 结果 | 用例 |
| --- | --- | --- |
| `/v1/responses` 走既有鉴权 | PASS | `30`·无 Key 401；`50`·虚拟 Key |
| 工具调用闭环（call_id/参数） | PASS | `30`·`call_abc` 保留、`{"cmd":"ls"}` 拼接 |
| custom tool | PASS | `30`·入站 function(input)、出站 `custom_tool_call` |
| SSE 事件顺序 | PASS | `30`·`output_item.added → content_part.added → output_text.delta`；`response.completed` 输出顺序 |
| usage | PASS | `30`·input/output/total 映射 |
| 无法保真输入 422 | PASS | `30`·`previous_response_id`、`input_file` |
| 原生 Responses 直通 | PASS（mock） | `30`·事件原样、`response.completed` |
| wire 不静默降级 | PASS | `30`·`wire_mismatch` 422 |
| model 名与 upstream id 分离 | PASS | `30`·`upstreamModel` |
| 上游 429 | PASS | `30`·429 + Retry-After + 归因 |
| 断流 | PASS | `40`·`response.failed`，无 `response.completed` |
| 真实 Codex/DSH/OpenCode Go | **NOT_RUN_LIVE** | 无合法凭据/成本授权 |

## 4. 完成度

| 能力 | 权重 | 现状 | 依据 |
| --- | --- | --- | --- |
| 管理面契约 | 10% | 95% | 契约 + fixtures + capabilities；前端联调未发生 |
| 路由/虚拟模型/Key/额度 | 15% | 85% | 离线回归；实机未验 |
| 弹性/429/预算/熔断 | 20% | 85% | 预算+归因+熔断/半开离线证据；真实上游未验 |
| 安全/脱敏/配置并发 | 15% | 90% | 掩码/回写/409/加密落盘 |
| Chat 协议适配 | 10% | 75% | openai PASS；anthropic/gemini 未新增实机证据 |
| Responses/Codex | 20% | 75% | 桥接+原生 mock PASS；实机 0 |
| 可观测/诊断 | 5% | 65% | trace/attempts/归因/能力矩阵；成本与趋势 API 未扩展 |
| 文档/运维/交付 | 5% | 85% | 契约/矩阵/3 份 runbook/验收报告 |

**加权约 82%**。计算基准：每项按「契约 25% + 实现 25% + 离线证据 30% + 实机证据 20%」加权；实机缺失项不能满分。

## 5. 阻断项

- **B1 基线分叉**：本地 `main@e746385` 领先远端 17 个未推送提交（约 900 行硬化修复），与远端 `main@6bc6441` 分叉。本 PR 基于远端 main；若 owner 直接以本分支覆盖 main 会丢这些修复。需 owner 决定：先审阅/推送那 17 个提交，或明确放弃。
- **B2 实机验收**：Codex CLI/桌面、DSH、OpenCode Go 的真实调用需要合法凭据与费用授权 → `NOT_RUN_LIVE`。
- **B3 PR #2 处置**：需 owner 在 GitHub UI 关闭/归档；本环境无 `gh`/API token（MCP GitHub 调用 `fetch failed`），无法代操作。

非阻断：anthropic/gemini 的 Responses 工具流为降级语义；无成本定价；`gh` 缺失（用 SSH push 替代）。

## 6. 合并建议

**建议：G1 + G2 可合并（条件式）**，前提是 owner 先处理 B1 基线分叉并接受「实机验收未完成」的显式声明。理由：

1. 变更集中在新增模块与受控入口，默认行为对既有 Chat 无破坏（`00` 回归）。
2. 429/预算/脱敏均为安全与稳定性修复，离线证据完整。
3. Responses 默认 `chat` 桥接，只有显式 `responsesWire=native` 才走直通，风险可控。
4. PR #2 不合并；其能力已由独立实现覆盖。

不建议把本分支直接当生产发布：真实 Codex/OpenCode Go 组合仍需实机日志后才能宣告兼容。

## 7. 下一阶段可操作任务

1. Owner 处理 B1（推送/审阅 17 个提交）后 rebase，跑 `npm run test:offline`。
2. 在隔离 8788 实例用真实低成本模型做 Chat 冒烟（需费用授权），记录 `x-mg-trace-id`/`x-mg-attempts`。
3. 用真实 Codex 配置指向 8788：非流式 → 流式 → 多轮 → shell/apply_patch → 取消，保存脱敏日志。
4. 对比 DSH 成功、Codex→CC Switch 429、Codex→ModelGate，形成实机对照表。
5. G3 按实际需求再做 Embedding/Rerank/Audio/Image/Video，每能力独立 PR + mock。
6. G4 冻结 v1 前补：`/api/metrics` 趋势、成本来源字段（有可靠定价才展示）、弃用窗口。

## 7.1 PR 状态（平台限制）

- 分支已推送：`dev/gateway-g0-g4-20261107`（`git ls-remote` 可核对 SHA）。
- **PR 未能程序化创建**：`gh` 未安装；本环境无 GitHub API token；GitHub MCP `create_pull_request` 持续 `fetch failed`（api.github.com 从 shell 可达，故障在 MCP 进程侧）；`git push -o pull_request.create` 被远端静默忽略（`refs/pull/*` 仅 1/2/3）。
- 已提供可直接开 PR 的描述文件与本分支 compare 链接：
  - 描述：`docs/roadmap/2026-11-07-pr-description.md`
  - 链接：https://github.com/xiaomengxizzh/model-gate/pull/new/dev/gateway-g0-g4-20261107
- 需 owner 一次点击创建；创建后本报告即可补齐 PR 号。

## 8. 并行开发边界（实测）

- 本轮开始时 `git worktree list` 只有主 worktree；开发中检测到前端轨道新增
  `workplace/idproject/model-gate-frontend`（分支 `dev/frontend-console-rebuild-20261107`，基于 `6bc6441`）。
- 后端只在自己的 `model-gateway-dev` worktree / `dev/gateway-g0-g4-20261107` 分支写入；
  未触碰前端 worktree、未改 `admin.html`、未共享同一分支或配置文件。
- 推送前会重新 `git fetch` 比对 `main` SHA；若主分支被移动，改为 rebase 后重跑离线套件，不强制推送。

## 9. 未授权行为声明

- 未执行任何下载/安装/升级（npm/pip/docker/浏览器/模型权重）。
- 未发起真实模型 API 调用（无费用产生）。
- 未修改生产 `config/`、未监听/重启 8787、未读写 Codex `auth.json`。
- 未向 `main` 推送任何提交；未合并 PR。
