# ModelGate 整合候选版验收与合并建议（2026-11-09）

性质：**候选分支验收报告，不是生产变更授权**。本报告只陈述实际执行过的命令与结果；未执行项明确标为 NOT_RUN / BLOCKED，不以历史文档或预期替代。

- 候选分支：`integration/modelgate-next`
- 起点：`35bed9b`（`dev/gateway-audit-20261108` @ `3a4ba89` + 新前端三个预览提交）
- 候选代码 HEAD（报告提交前）：`1ab84f3`
- 对照主线：`origin/main` @ `6bc6441`（**未合并、未改写**）
- 工作树：`workplace/idproject/model-gateway-next`（独立 worktree；审计 worktree 的未跟踪托盘文件未被触碰）
- 新增依赖：**0**；真实上游调用：**0**；生产 8787 / systemd / 用户私有配置：**未触碰**

## 0. 结论摘要

| 交付 | 状态 | 说明 |
| --- | --- | --- |
| A 后端整合候选 | **PARTIAL → 可评审** | 以审计分支为主体；移植 429/Retry-After/工具请求不重放；修复配置投影两处契约缺口；未整包合并 G0–G4 或 PR #2。 |
| B 可使用的 /ui-next 前端 | **PASS（Mock/浏览器层）** | 六区齐全，供应商/模型/虚拟模型/Key/409/诊断/设置均真实连通；旧 `/` 保留。 |
| C 前后端 API 适配报告 | **PASS** | [ui-next-api-matrix.md](../contracts/ui-next-api-matrix.md)：逐操作列出 API、鉴权、错误与状态。 |
| D 测试与验收报告 | **PASS（分层）** | 28/28 离线套件、14/14 浏览器检查、DSH 真客户端 × 本地 Mock 3 条路径；真实上游/Codex 阻断。 |
| E Git 交接与合并建议 | **PASS（本地）** | 8 个候选提交、无冲突、无未提交文件；远端推送/PR 因本机无 GitHub 写凭据而 BLOCKED。 |
| 合并 main | **不允许** | 未获所有者明确批准；真实上游/客户端与部署验收未完成。 |

## 1. 分支审计与取舍

基线复核（`git fetch --all --prune` 后）：

| 分支 | HEAD | 与候选关系 | 本轮处置 |
| --- | --- | --- | --- |
| `main` | `6bc6441` | 候选起点上游 | **不合并、不改写** |
| `dev/gateway-audit-20261108` | `3a4ba89` | 候选的直接祖先 | 作为后端主体基线 |
| `dev/gateway-hardening-20261107` | `e746385` | 已是 audit 的祖先 | 无需重复移植 |
| `dev/gateway-g0-g4-20261107` | `66f274c` | 与 audit 分叉（8 个独有提交，改同一批 src 文件） | **只移植 G1 429 治理**，不整包合并 |
| `dev/ui-next-integration-plan-20261109` | `35bed9b` | audit + 3 个 UI 预览提交 | 作为候选起点，保留并扩展 |
| `feature/codex-opencode-go-adapter-20261107`（PR #2） | `9a0bfe3` | 独立旁路实现 | **不合并**；仅吸收 `noRetry429` 理念到统一链 |

不做“按最新/提交最多”选择：G0–G4 的 Responses 实现与 audit 的 Chat 桥/原生透传是两套语义，整包合并会重复实现并绕过统一预算/额度；PR #2 把 `/v1/responses` 旁路到独立 handler，绕过 `forwardChain`，与统一治理冲突（审计结论沿用 `docs/roadmap/2026-11-09-dsh-cli-live-verification-report.md` §7.2，本轮未重新实机验收 PR #2）。

### 1.1 功能差异记录（摘要）

| 能力 | audit 基线 | G0–G4 | 本轮决定 | 证据 | 风险 |
| --- | --- | --- | --- | --- | --- |
| Chat Completions | 完整 | 完整 | 保留 audit | 既有 28 套件 | 低 |
| Responses | Chat 桥 + 原生透传 | 一等入口但工具策略不同 | 保留 audit（含 `include` 兼容、托管工具显式丢弃） | `responses-*` 套件、真实 Codex/DSH 历史证据 | 中（Chat 桥有损） |
| Anthropic/Gemini 转换 | 完整 | 相同基础 | 保留 audit | `wire-format` 22 例 | 低 |
| Codex/DSH 接入 | 真实链路已验证（历史） | namespace 展开为函数 | 保留 audit 的“显式丢弃 + lossy 日志”，不伪装完整工具兼容 | `responses-mapping`、DSH mock 3 路径 | 中 |
| 真实/虚拟模型、优先级、fallback | 完整 | 完整 | 保留 audit | `model-resolution`、`virtual-models` | 低 |
| 429 归因 / Retry-After | 429 被吞成 502、会熔断 | 有归因与预算 | **移植并适配** | `retry-governance` 11 例 | 中 |
| 非幂等重放 | 无专门策略 | 有 noReplay | 移植为“同上游一次 + 整链一轮” | 同上 | 中 |
| 额度/并发/QPS/请求预算 | 完整（MG-002/006） | 另有 attempt budget | 保留 audit，不引入第二套预算 | `deadline`、`boundary` | 低 |
| Key 加密/管理权限/版本 | 完整 | 完整 | 保留 + 投影修复 | `admin-*`、`ui-contract` | 低 |
| 日志/统计/健康 | 完整 | 有 redact/status matrix | 保留 audit；诊断页派生分类 | `metrics`、`logger-secrets` | 低 |
| Embedding/Rerank/媒体/视频 | Mock 级实现 | 部分 | 保留，界面标“实验” | `embeddings/rerank/media/video` | 中（真实上游未验收） |
| 管理 API v1 | 契约基线未冻结 | 冻结草案 | 保留 audit；修复投影后仍未冻结 | `ui-contract`、`admin-*` | 中 |

### 1.2 本轮后端改动

1. **429/Retry-After/不重放**（提交 `355e5e9`）
   - 新增 `src/retry-policy.js`：429 四类归因、Retry-After 解析与剩余预算钳制、工具请求识别。
   - `request.js`：可重试状态读 ≤8KB 错误体做归因；Retry-After 只在剩余预算内等待；`noRetry` 同上游一次。
   - `forward.js`：429 不再熔断；链/预算结束时返回 HTTP 429 + `Retry-After` + `MG_429_<归因>` 信封；工具请求同上游一次、整链最多一轮（允许换一个上游/模型，不回队首）。
   - 回归：`offline/retry-governance.test.mjs` 11 例；旧 `rate429` 透明重排仍 2/2。
2. **数据面 429 header 透传**：`src/index.js` 两处 JSON 分发合并 `out.headers`，否则 `Retry-After` 永远到不了客户端；由 429 测试严格断言。
3. **配置投影两处缺口**：虚拟模型 `expiresAt/note` 未回显、`defaults.clientKey` 永远为空；均已修复并加 `ui-contract` 回归。
4. **`/ui-next` 安全静态服务**：按扩展名白名单读取 `src/ui-next/**`，拒绝 `..`、编码穿越、隐藏文件与未知扩展；严格 CSP；不改变 `/` 与 `/admin`。

## 2. 新前端（/ui-next）

### 2.1 六大功能区

| 区域 | 实际能力 | 未支持/边界 |
| --- | --- | --- |
| Dashboard | 真实请求/错误/Token/P50/P95、延迟趋势、上游健康、最近路由、会话、缓存提醒、配置告警 | 不自动探活；无历史时间序列时显示空状态 |
| Providers | 列表/新增/编辑/删除、协议/端点/Key 来源、请求/错误/P95、熔断/冷却、代理、headers（默认掩码）、独立 Key、探活（显式确认） | 探活成功 ≠ chat/tool/stream 可用；删除不自动清理历史 Key |
| Models & Routing | 真实模型/别名/fallback/能力/上下文/Token/额度/并发/QPS/reasoning；虚拟模型有序目录/额度/expiresAt/note；路由预览；模型测试（费用确认） | 虚拟模型未知扩展字段会被服务端 `cleanVms` 丢弃；audio/image/video 不做在线探测 |
| Clients | Codex CLI/Desktop、DSH、OpenAI 兼容 SDK、自定义模板；原生 Responses vs Chat 桥；五档验证口径；能力矩阵 | 不读取客户端配置/auth 文件；不自动检测；不宣称“已连接” |
| Observability | 9 项全局指标、Provider 全表、1/7/30/90 天模型 Token、日志窗口过滤/复制、429/超时/5xx 派生分类、路由/会话 | 分类是日志窗口启发式，非持久化；无 trace/按客户端维度 API |
| Security & Settings | 实例信息、管理令牌、韧性参数、diff 预览、版本化保存、409 重载、配置重载、脱敏导出、备份边界说明 | Web 备份/恢复 NOT_SUPPORTED；defaults 合并语义导致字段无法经保存删除 |

### 2.2 架构与约束

- 原生 HTML/CSS/ES Modules，**零第三方依赖**；`src/ui-next/js/` 按 `api/store/router/components/format/dom/config-draft/save-flow/views` 拆分，不再把业务堆进单文件。
- 所有动态数据经 `textContent`/DOM API 插入，源码禁止 `innerHTML`；令牌仅模块内存，主题是唯一 localStorage 键。
- 配置保存顺序：`GET /api/config` → 独立草稿 → 保留未知字段 → 校验/差异 → 带 `configVersion` 提交 → 成功重读；409 显示冲突并允许重新加载，禁止静默覆盖。
- 视觉：统一 token、深色导航/浅色内容、明暗主题、`prefers-reduced-motion`、1440/1024/768/390 响应式、键盘可达与对话框 Esc/焦点圈定。

## 3. 测试与验收证据

### 3.1 分层结果

| 层级 | 命令/方式 | 结果 | 证据 |
| --- | --- | --- | --- |
| STATIC_CHECK | `npm run check` | **PASS**（含 UI 模块 15/15） | 本轮最终执行 exit 0 |
| STATIC_CHECK | `npm run docs:check` | **PASS** | 同上 |
| STATIC_CHECK | `node scripts/check-metadata.mjs` | **PASS (21)** | 同上 |
| MOCK_OFFLINE | `npm test` | **PASS 28/28 隔离套件** | 新增 `retry-governance`、`ui-contract`；既有 26 套件无回退 |
| MOCK_OFFLINE | `npm test ui-next` | **PASS 2/2** | 静态资源/CSP/鉴权/穿越/注入面 |
| BROWSER | `node scripts/test/ui-browser-check.mjs` | **PASS 14/14** | `docs/evidence/2026-11-09-integration/browser-acceptance.txt` |
| CLIENT_MOCK | DSH 0.2.2-rc.1 × 本地 mock | **PASS 3/3** | Chat、Responses 桥、原生 Responses；见 `client-mock-validation.txt` |
| CLIENT_LIVE | Codex CLI × 网关 × 真实上游 | **BLOCKED** | 宿主 `bwrap` 不允许非特权 user namespace；未使用跳过沙箱参数 |
| UPSTREAM_LIVE | 真实上游计费调用 | **BLOCKED** | 本轮无逐次费用授权/预算确认；未调用 |
| DEPLOY | 8787/systemd/灰度 | **NOT_RUN** | 按约束未触碰生产实例 |

### 3.2 浏览器检查明细（14/14）

锁定页 → 登录真实指标 → Providers 列表/对话框/Esc → Models 目录/能力/虚拟模型 → Clients 模板与诚实状态 → Observability 真实统计/日志/派生分类 → Settings → 409 冲突 → XSS 文本化 → 明暗主题 → 1440/1024/768/390 无横向溢出 → 错误令牌拒绝/正确令牌解锁 → 全程 0 未捕获异常。截图见 `docs/evidence/2026-11-09-integration/`。

### 3.3 本轮没有验证的东西

- 真实上游的 429/5xx 故障注入、Retry-After 真实值、非幂等工具请求真实重放行为。
- Codex CLI / Codex Desktop 真实客户端；本机 Codex 被宿主沙箱阻断。
- DSH 实际工具调用（本轮只跑文本/流式；历史审计分支有真实工具往返证据，但未在本候选分支复跑）。
- Windows/macOS、Node 18/20；本机仅 Node v24.22.2。
- 生产部署、回滚演练、负载/长稳。

## 4. 已知风险与未完成项

1. **工具请求可用性取舍**：同上游只发一次、整链最多一轮；Codex/DSH 每轮带 tools，因此失去同上游重试，但保留一次 fallback。流式重连（断流重连）对工具请求仍可能重发一次，未改。
2. **429 归因是启发式**：≤8KB 文本匹配，HTML/非 JSON 429 归 unknown；真实上游 429 未实测。
3. **内联链 429 未统一**：`/v1/embeddings`、`/v1/rerank` 的内联转发仍按旧逻辑 `markFail` 并可能 502；不在 `forwardChain` 治理内，已记录为后续卡。
4. **虚拟模型未知扩展字段**：服务端 `cleanVms` 只保留固定字段；前端不声称保留未知字段。真实模型/上游的未知字段保留。
5. **观测口径**：429/超时/5xx 计数由当前日志窗口派生，不是持久化指标；无 trace/客户端维度 API。
6. **备份/恢复**：没有管理 API，设置页明确 NOT_SUPPORTED，不提供无效按钮。
7. **配置删除语义**：`defaults` 顶层合并且无法经保存删除字段；需要直接编辑文件或后续 API。
8. **凭据回显**：`/api/status` 与 `/api/config` 仍返回 `extraHeaders`/`proxy` 原值（鉴权后）；新版 UI 默认掩码、导出脱敏，但接口层脱敏仍是后续安全项。
9. **GitHub 写操作**：本机无 HTTPS token、SSH 22 不通，无法 push 或创建/查询 PR；PR #2/#4 状态本轮只能用 `git ls-remote` 校验分支 SHA，API 查询被未认证速率限制。

## 5. Git 交接

```
分支：integration/modelgate-next
起点：35bed9bfc0bd8b013312460ffcb4d51de7dbe087
候选代码 HEAD（报告前）：1ab84f3
main：6bc6441（未合并）
提交：
  355e5e9 fix(gateway): unify 429 attribution, Retry-After and non-idempotent replay governance
  6630633 feat(ui-next): rebuild console shell, design system and dashboard
  2807e7e feat(ui-next): add provider and model management
  8a34976 feat(ui-next): add client onboarding and observability views
  949eac8 feat(admin): serve /ui-next assets and align config projection
  0c811bc test(integration): add isolated UI fixture and CDP browser acceptance
  dcaec9e docs(evidence): add UI screenshots, browser acceptance and DSH mock validation
  1ab84f3 fix(ui-next): preserve unknown fields and tighten delete/edit guards
```

- 合并冲突：**无**（候选分支线性构建，未合并 main）。
- 未提交文件：报告提交后应为空（运行日志已清理；`.tmp-*` 等被 gitignore）。
- 远端：分支未推送（无写凭据）；所有者可在具备凭据的环境执行 `git push origin integration/modelgate-next`，再创建 **Draft PR** 到 main。
- 合并条件（未满足）：真实上游/真实 Codex/Desktop 验收、所有者对工具重放取舍与前端默认入口的明确批准、生产回滚演练。

### 回滚

- 候选分支整体回滚：`git revert` 上述提交，或切回 `35bed9b`。
- UI 回滚：停止使用 `/ui-next` 即可；`/` 与 `/admin` 未被替换，不受影响。
- 配置回滚：保存为原子写；变更前备份 `config/gateway.local.json` 与 `config/keys.local.json`（后者为密文，不应外传）。

## 6. 资源与安全合规

- 未安装/下载任何新依赖、浏览器包、模型或镜像；浏览器使用宿主已有 Chrome 153（headless CDP），测试夹具使用 Node 内置模块与本地 mock 上游。
- 未读取/打印真实 API Key、Codex/DSH auth 文件或私有配置；DSH 使用临时 `DSH_HOME` 与假 Key 环境变量；mock 上游忽略鉴权。
- 未修改 Git 全局设置、未强推、未删除共享分支、未合并 main、未切换生产默认前端。

## 7. 评分维度（只用于说明剩余工作量，不作为验收替代）

| 维度 | 权重 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| 后端能力整合与契约一致 | 30% | 429 治理 + 投影修复 + 28 套件 | 80%：内联链 429、真实上游未验 |
| 前端功能完整度 | 25% | 六区真实连通 + CRUD/Key/409 | 75%：备份/恢复、trace 无后端 |
| 前后端契约与安全 | 20% | API 矩阵 + 越权/穿越/XSS/CSP | 80%：接口层 header 脱敏待做 |
| 测试证据可复核 | 15% | 静态/离线/浏览器/客户端 Mock | 80%：真实客户端/上游阻断 |
| 合并与部署就绪 | 10% | 分支/回滚/隔离入口 | 40%：无远端推送、无生产演练 |

**综合判断：可提交所有者评审的候选版；不具备直接合并 main 或替换默认前端的条件。**
