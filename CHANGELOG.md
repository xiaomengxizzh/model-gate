# Changelog

本项目所有显著变更记录于此。格式参考 Keep a Changelog；版本号随发布推进（`package.json` 已随 0.2.3 同步）。

### Verified (real) —— G6

- **真实链路已通过**：Codex CLI 0.167.0（用户自己的 ChatGPT 官方登录，父模型 `gpt-6-luna` 直连官方服务）通过本机 stdio MCP 调用 `modelgate_delegate_task` → `modelgate_wait_task` → `modelgate_followup_task` → `modelgate_wait_task`，两个回合均 `ACKNOWLEDGED`，子任务（`deepseek-v4.1-flash`，provider `opencodego`）真实执行本地文件工具并落盘，父端最终回执里的两个 `sha256` 与磁盘一致。
- 运行参数：`--ephemeral`（不写会话文件）、`--ignore-user-config`（不加载/不修改 `config.toml`）、MCP 服务经 `-c` 命令行覆盖注入；未读取或转发 `auth.json`。
- 父模型标识核验：CLI 显式 `-m gpt-6-luna` + `codex doctor --json` 解析结果为 `model=gpt-6-luna / model provider=openai` + `codex debug models` 目录存在该 slug；**限制**：`exec --json` 事件流不含 `model` 字段，已在证据文档记录该限制，未从会话文件反推。
- 证据：[G6 真实链路](docs/evidence/2026-11-13-g6-codex-mcp-live.md)、[脱敏收据](docs/evidence/2026-11-13-g6-receipt.json)。

## [Unreleased] —— 2026-11-13 本地 MCP 委派（G2–G5）

### Added

- **本机 OpenCode Go 委派 MCP 服务（stdio）**：`bin/mg-mcp.mjs` + `src/mcp/delegation-*.js`，提供 `modelgate_delegate_task` / `modelgate_get_task` / `modelgate_wait_task` / `modelgate_followup_task` / `modelgate_cancel_task` 五个工具。JSON-RPC 2.0 换行分隔，stdout 只走协议、日志走 stderr。
- **持久化任务状态机**：`CREATED→ADMITTED→DISPATCHED→RUNNING→RESULT_READY→ACKNOWLEDGED`，另有 `FAILED/CANCELLED/UNKNOWN`；`DISPATCHED` 在发起网络写入前落盘，进程重启把在途回合对账成 `UNKNOWN` 并**禁止重发**。幂等键只落哈希，同键同摘要回放、同键不同摘要冲突。
- **本地受限工作区工具**：子模型只能调用 `read_file`/`list_dir`/`write_file`/`stat_path`，根目录由 `MG_MCP_WORKSPACE` 指定；绝对路径、`..` 与符号链接逃逸一律拒绝；引用路径在任务前后计算 `sha256` 作为真实改动证据。
- **结果回执**：`resultText` + `toolCalls` + `artifacts[{sha256Before,sha256After,changed}]` + `usage` + `lossy` + `resultDigest`（不含 `state`，ACK 前后一致）。默认完整回执，只有 `allowResultTruncation=true` 才裁剪。
- 回归 `scripts/test/offline/mcp-delegation.test.mjs`（11 用例）与 `scripts/test/offline/sse-lifecycle.test.mjs`（8 用例）；`npm test` 增至 79 套件。

### Security

- 工具参数**不能**指定 URL/host/provider/model/凭据：任意层级键名按「V2 密文 → 凭据 → 目标 URL → provider → model → 值级凭据形状」顺序拒绝，命中即零提交（`MCP_V2_OPAQUE` / `MCP_CREDENTIAL_IN_ARGUMENT` / `MCP_URL_NOT_ALLOWED` / `MCP_PROVIDER_NOT_ALLOWED` / `MCP_MODEL_NOT_ALLOWED` / `MCP_SECRET_IN_ARGUMENT`）。
- `ownerRef`（配置目录 + OS 用户派生）做归属隔离，跨 owner 读写一律 `MCP_NOT_OWNER`；模型无法控制该值。
- Go 凭据只出现在上游请求头，不返回给调用方、不落盘；上游 `opencodego_*` 内部码不外透。
- SSE 生命周期独立回归覆盖 completed/failed 唯一终态、无终态 close、客户端断开、首字节前取消、整体 deadline、长首字节，并断言上游命中次数以证明无重复发送。

### Docs

- 新增 [MCP 委派契约 v1](docs/contracts/modelgate-mcp-delegation-v1.md)、[实现对齐记录](docs/contracts/modelgate-mcp-delegation-v1-alignment.md)、[威胁模型](docs/explanation/mcp-delegation-threat-model.md)、[G0 审计](docs/evidence/2026-11-13-g0-repo-audit.md)、[G3/G4 证据](docs/evidence/2026-11-13-mcp-delegation-g3-g4.md)、[SSE 生命周期审计](docs/evidence/2026-11-13-sse-lifecycle-audit.md)。

### Not verified

- 真实 OpenCode Go 上游与真实 Codex CLI 父模型闭环（G6）未执行；**本段不表示真实上游已验收**。
- Codex Desktop（G7）、GUI 与发布整合（G8）未执行；未 push、未开 PR、未合并。

## [Unreleased] —— 2026-11-13 认证边界退役（G1）

### Security —— 行为变更（部署前必须确认）

- **`gatewaySubscription` 生产认证路径退役（G1）**：删除 `src/codex/local-subscription.js`。网关不再读取 Codex 登录态（`auth.json` / `CODEX_HOME` 推导），不再向 `chatgpt.com/backend-api/codex/responses` 发送本机 Codex token；官方目标只保留网关自有 key 直连。
- **残留配置 fail-closed**：`providers.<id>.gatewaySubscription.enabled=true` 在官方原生 `/v1/responses`、第三方原生 `/v1/responses`、官方 Chat 桥三个入口均返回 403 `gateway_subscription_retired`，**零上游请求**、不降级、不读取登录态。请删除旧配置并为官方目标配置 `apiKeyEnv`/面板 Key。
- **授权层移除 `GATEWAY_SUBSCRIPTION` 模式**：`CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION` 不再存在；旧调用方传 `gatewaySubscription=true` 或 `credentialMode='gateway-subscription'` 得到 typed `gateway_subscription_retired`。`/backend-api/codex` 永不进入官方路径白名单。

### Changed

- `/api/status` 的 provider `gatewaySubscription` 恒为 `false`；残留旧配置另以 `gatewaySubscriptionRetired` 暴露，仅用于迁移提示。
- `src/forward.js` 不再把 `opts.gatewaySubscription` 传入授权 intent（参数保留仅为兼容旧签名，实际忽略）；转发链在获取并发/预算与任何上游发送前统一 fail-closed。
- 回归：`native-boundary` 的“不读取登录态”改为递归扫描全部 `src/**/*.js`（覆盖 F01 回归漏掉的 `local-subscription.js`）；`codex-p09-native-proxy` 由正向代理验证改造为“退役 + 静态扫描”套件。

### Docs

- 配置参考 P09 段标记为已退役并给出迁移；ADR-0002 增加 2026-11-13 G1 修订；新增 [认证边界退役证据](docs/evidence/2026-11-13-auth-boundary-retirement.md)。

### Not changed

- P07 SIWC 原型（`src/subscription/*`）仍默认关闭；本次不改变其能力与边界。

## [Unreleased] —— 2026-11-12 收工闭环（`integration/modelgate-release`）

> 本段记录从 A1 基线 `2a735fb` 起的新集成线：G0 冻结 + G1 后端/协议/控制面的定向移植与收紧。**CLI 原生门（Q03/Q04）与正式 GUI（U01–U07）未开始**，本段不表示发布就绪。

### Fixed

- Codex 原生 Responses 投影等待流完成后释放请求预算和上游并发槽位，避免上游延迟发送终态时被网关提前取消。
- 第三方收到只有 Codex 协作信封和密封正文的任务时，发送前返回 `opaque_agent_message`。混合消息仍支持投影已有的可读正文。
- Codex 聚合别名沿同一供应商绑定读取原模型的能力和报价，避免丢失工具能力后返回 `MG_FB_NO_CANDIDATE`。
- 隔离 CLI 三轮用例改用当前支持的合成上游 Key，回环流量绕过出站代理。

### Security —— 行为变更（部署前必须确认）

1. **官方原生凭据透传彻底退役（F01）**：`/backend-api/codex` 与 `MG_CODEX_OFFICIAL_PASSTHROUGH` 不再启用任何能力。官方目标无网关自有 Key 时 `403 official_no_gateway_key`；设了旧开关则 `403 official_passthrough_retired`（含迁移提示）。两者均零上游请求，绝不改投第三方；网关不读取 `auth.json`/`CODEX_HOME`。`credentialModeAllowed('official-subscription')` 返回 `credential_mode_retired`。
2. **配置与 Key 恢复一律 fail-closed（F02）**：截断的 `keys.local.json`/`gateway.local.json` 不再静默变空（此前会静默降级鉴权并清空用户配置），分别报 `keys_unreadable`/`local_config_unreadable`；锁改 `linkSync` 原子发布，0 字节残留锁可回收、不可解析锁保留现场；加密不可用时保存返回 `500 key_encryption_unavailable`（原 400），绝不退回明文；坏状态以 `CONFIG_UNREADABLE` 拒启动。
3. **发送前授权统一（F03）**：`/v1/responses` 官方分支与原生分支都在发送前经 `authorizeSendTarget` 冻结目标并复核实际 `upstreamUrl`；官方目标带 userinfo 等异常形态返回 typed 403 且零发送；原生 responses 加 `noRetry`，上游 3xx 统一 `502 upstream_redirect_rejected`。
4. **下游响应头白名单**：JSON 响应仅下发 `retry-after`（拒绝控制字符），上游 `set-cookie`/`x-*` 不再可能到达客户端（移植 R1 `2c4f2a9` 语义并补反向断言）。
5. **付费候选默认拒绝无计量发送（N02）**：未配预算上限且未接账本时，`costEstimateUsd>0` 或 legacy paid 候选在发送前被拒（`EXCLUDE.billing_unmetered`，零上游）；显式放行需 `defaults.codexBudget.billingPolicy='allow_unmetered'`（审计面可见）。
6. **Go 会话头改 HMAC 域派生（P03）**：不再转发客户端原始 `session-id`/`thread-id`，移除固定常量；会话值按主体+provider+root/child 域+目标域+线程派生。
7. **生成授权默认 fail-closed（N01）**：目录墓碑优先于现存条目（下架模型零上游拒绝）；同代别名指向墓碑/不存在目标时 fail-closed，不回落默认上游。

### Added

- **显式清单型离线门禁**：`scripts/test/run.mjs` 扩至 70 套件，新增 `native-boundary`、`codex-role-provider`、`codex-v2-responses`、`codex-v2-stream`、`codex-v2-lifecycle`、`p03-opencode-go`、`n01-catalog-authz`、`n02-routing-budget`、`n03-cli-contract`、`siwc-preview`，并把经隔离审计的 legacy `circuit.mjs` 纳入默认回归（`affinity.mjs` 因夹具过期未纳入，待重写）。
- **管理 CLI `bin/mg.mjs` 与 `mg-management/1`（N03）**：`doctor`/`provider`/`model`/`config`/`client` 子命令；`doctor --json` 纯检出可跑且 `noNetwork:true`；统一错误信封带 `code`/`requestId`/`nextAction`；写操作绑定 `planId`，缺失/错误返回 `409 plan_id_mismatch`。
- **V2 协议移植（P01/P02/P04/P05/P07）**：envelope 校验 + 有序历史投影 + 控制项/加密项分类（不可读密文与未支持关键工具发送前拒绝）、工具 namespace/identity 恢复、原生 Responses SSE 适配器（终态归因、usage once、EOF→`STREAM_INTERRUPTED`）、真实 CLI 离线 V2 生命周期清单（13 case，`FIXTURE_PREPARED`，真实运行仍需 egress 隔离）、合成 SIWC/OIDC 预览（默认 off）。
- **目录世代与同代授权（N01）**：快照 pin、证据来源/过期、同代别名、墓碑、只读客户端模板与 drift。
- **CLI 原生角色边界（P01）**：ADR-0003 锁定 CLI 0.167.0 的 role 不应用 `model_provider`，附四矩阵 fixture（证据边界 `UNKNOWN_PRIMARY_SOURCE`：本机无该版本源码）。
- **收工证据包**：`docs/evidence/2026-11-12-closure/`（环境实测与 Q02 隔离判决、Q03/Q04 续跑手册、交付报告）。

### Changed

- **支持矩阵收敛到 Linux + Node 24（N00）**：`engines.node` 改为 `>=24`，CI 矩阵 `['24']`，README/`check-metadata` 同步；Node 18/20/22 与 Windows/macOS 标记未验收/退役。
- 错误状态表统一（`src/attempt-state.js`）：授权 403、目录 404、上游 502、超时 504、store 类 409，未登记码归 502。
- `bin/mg.mjs --version` 打印 `modelgate.cli/1 version 0.2.3 api mg-management/1`；`doctor` 的 Node 说明与 N00 一致。

### Not wired（已知缺口，见交付报告 §缺口矩阵）

- P02/P04 的 `src/index.js` 接线（`prepareCodexNativeRequest`/`restoreResponseJson`/`createCodexStreamAdapter`）尚未进入生产请求路径；模块与夹具已交付并通过单测。
- N01 的请求入口目录 pin 尚未接入 `src/index.js`（router 侧已 fail-closed 兜底）。
- `src/budget.js` 默认时钟仍为墙钟；`src/sse.js` 流式下游头仍为黑名单语义；探活/媒体/可选端点尚未统一走 `target-authz`。
- CLI 原生门（Q03/Q04）与 GUI（U01–U07）、Q05/Q06、R01/R02 未开始或阻断。

## [Unreleased] —— 2026-11-11/12 加固循环（M0–M5，本次交付）

> 本次交付以 `dev/modelgate-hardening-a1` 集成分支为准。标注「未接线」的能力表示模块/契约已交付、生产入口仍走旧路径；部署前请按 [支持矩阵](docs/roadmap/2026-11-11-support-matrix.md) 与 [回滚与禁用](docs/how-to/rollback-and-disable.md) 核对。

### Security —— 用户可观察的行为变更（Breaking / 部署前必须确认）

1. **`/api/codex/*` 现在要求显式管理员令牌**：未设置 `MG_ADMIN_TOKEN`（或 `server.adminToken`）时**不再走 loopback 放行**，一律 `403 explicit_admin_required`，且在读取 body 之前拒绝。旧 `/api/*` 语义未变。
2. **配置保存改为同代际事务**：`gateway.local.json` 与加密 `keys.local.json` 作为一个代际提交，新增跨进程锁与中断恢复；外部修改返回 `409 store_conflict`、锁被占返回 `409 store_locked`，不再出现「keys 已写、config 未写」的部分提交。
3. **保存配置时省略 `defaults.clientKey` 不再清空数据面 Key**（此前会误删 → 无凭据可调用的 P0）。只有显式发送 `""` 才是清空；掩码（含前后空白）与省略都表示保留。
4. **虚拟模型过期时间改为后端单一真源**：非法/歧义值保存即 `400`（`expiry_*` 码）；旧 `datetime-local` 与毫秒值保存后写显式时区 ISO；旧 `YYYY-MM-DD` 保留原样（兼容回读）。修复「过期 Key 永久有效」。
5. **省略 `virtualModels` 或其中 `expiresAt`/`note` 字段不再清空元数据**（此前会清空并让过期 Key 复活）：整个数组或字段省略 = 保留，显式空值才清空。
6. **第三方 Codex 目录要求能力证据**：`codex.capabilities` 中的非保守能力必须配 `codex.evidence.<同键> = { source, observedAt }`，否则目录生成以 `capability_evidence_missing` fail-closed；保守值 `false`/`[]`/`'disabled'` 无需证据。迁移做法：删除未证实字段，或补齐证据。
7. **SSE / Chat 桥默认收紧**：`bridge()` 对托管工具、控制项、未知字段与无法精确表达的 `allowed_tools` 默认 `typedUnsupported`；产品入口 `responsesToChat()` 仍默认 `LEGACY_BRIDGE_COMPAT`（有损但逐项记录）。原生分支改由 `nativeContract` 驱动。
8. **上游重放语义收紧（模块级，尚未全量接线）**：写开始即 `SENT_UNKNOWN`；写后无头、收头后 5xx、已交付后断流、工具风险一律不重放；只有未发送或可证明的前置拒绝（402/404/429）才允许下一跳。该语义位于 `src/request.js` 的新执行器，`forward()` 的生产接线状态以交付报告为准。
9. **离线验证入口改为显式清单**：`scripts/test/run.mjs` 只执行 `SUITES` 字面量清单，新增测试文件**必须显式登记**否则不会执行；旧 `test:live` 改为**正向白名单 + 两道 opt-in**（`MG_ALLOW_LIVE_TESTS=1`，必要时再加 `MG_LIVE_ALLOW_UNLISTED=1`）。

### Added

- **M0 交付门禁**：离线 runner 改为显式清单 + 每 suite 独立 HOME/TMPDIR + 子进程环境白名单 + 超时与进程组回收；live runner 改正向白名单；`docs:check`、发布元数据与 CI 契约列为纯检出可判定门禁。
- **M0 配置事务**：`src/config-transaction.js` 以 journal/commit marker + 原子 rename + fsync 实现配置与 Key 的同代际提交、锁与故障恢复（覆盖 9 个注入点与真实 SIGKILL）。
- **M1 单次发送执行器**：`execute()/forwardOnce()` 提供单调截止、尝试状态机与 `SENT_UNKNOWN` 不重放语义（模块已交付，`forward()` 生产接线待后续，见「未接线」）。
- **M1 SSE 流式解码与桥接**：SSE 流式解码、`nativeContract` 驱动的原生分支，Chat 桥严格默认（模块/契约交付，生产接线待后续）。
- **M1 可选端点与视频幂等**：embedding/rerank/audio/image/video 共用 `src/optional/policy.js` 策略入口（未证实能力默认关闭、401、限流、429 Retry-After、取消终态）；视频创建先落 `PENDING_SEND` 再调上游，并发同键单次、主体隔离、重启恢复、结果未知不重发（模块已交付，入口接线待后续）。
- **M2 授权与目录**：最终目标授权记录（`target-authz`）与拼装后二次校验；Codex 目录世代、零碰撞、第三方能力证据与 CAS 发布。
- **M3 路由与预算**：证据化候选选择（可追溯）、legacy 能力信任收敛与 D7 身份闸门归一化、持久预算账本与 `MG_FB_BUDGET_EXCEEDED` 停机码。
- **M4 管理面与控制台**：`/api/codex/*` 显式管理员入口与登记根；控制台 loading/empty/unknown/error 状态完备、401 清理与锁屏、409 保留草稿、客户端导出仅含客户端字段；历史只读诊断与额度三态/应急审计（模块侧）。
- **M5 回执与委派**：UHR 推理回执契约（`ROUTE_MISMATCH`、verified usage 隔离）、本地 MCP 委派适配器与 mock UHR；支持矩阵与回滚/禁用开关文档。

### Changed

- 管理面错误信封新增结构化 `code`（如 `store_conflict`/`store_locked`/`optional_endpoint_disabled`/`capability_evidence_missing`），原有 `error` 文本保持兼容。
- 控制台区分「会话失效（401）」与「功能级 403」：后者只让对应卡片/视图进入可重试错误，不清 token、不清其它视图数据、不跳登录；刷新与切路由在数据到达前渲染 loading 骨架，不再用旧数据顶替。
- 控制台不再把未知计数渲染为 0/正常；`/admin` 旧面板保留为回退入口（退役条件：核心操作等价 + 双跑通过 + 真实浏览器 E2E 证据）。

### Fixed

- 修复 P0-1：省略 `defaults.clientKey` 的保存会删除加密库 `__mg_client`，导致数据面无凭据即可调用。
- 修复 P1：省略 `virtualModels`/`expiresAt`/`note` 会清空元数据并让已过期虚拟 Key 复活。
- 修复：虚拟 Key 过期判定把 ISO/`datetime-local` 经 `Number()` 变成 `NaN`，过期 Key 永久有效。
- 修复：掩码 `'********  '`（尾随空白）被当成真实 Key 写入，导致数据面被锁死。
- 修复：旧 runner denylist 可被字符串拼接/大小写/base64 绕过；改为正向白名单，未列入即永不执行。
- 修复：控制台把功能级 403（如 `write_disabled`）当成会话失效，进入「客户端接入」即掉登录态。

### NOT_RUN / 边界

- 模块已交付但生产入口未接线：`forward()` 尚未切到新执行器（重放语义/预算/授权断言尚未成为线上行为）；可选端点入口接线；`/api/codex/*` 历史/额度模块侧生产接线。重开条件见支持矩阵。
- 真实上游、真实 Codex CLI 三轮、真实浏览器 R00 验收：本轮离线/mock 范围之外未执行（E2E 由独立 QA 在 R00 执行）。

## 2026-11-11 Codex 聚合 M2 LIVE 边界：v2 加密任务显式阻断

### Verified
- 官方主代理（真实 chatgpt.com）成功调用 spawn_agent 派生第三方子代理（真实 OpenCode Go），model 覆盖生效；子代理请求含加密 agent_message 时网关返回 v2_encrypted_task_unsupported，主代理如实回显错误并结束轮次。未解析/未删除/未伪造密文，未静默降级 v1。证据 docs/evidence/2026-11-11-e4-v2-live-blocked.md。

### NOT_RUN
- 真实 v2 子代理成功闭环：被加密边界阻断（D3 设计内结果）；明文重新委派与官方子代理路径未实现。

## 2026-11-11 Codex 聚合补丁：OpenCode Go 会话头与真实第三方复验

### Fixed
- `forward.js`：`opencodego` 目标缺失 `x-opencode-session` 时上游返回 `400 MissingSessionID`。现从客户端 `x-opencode-session`/`session-id`/`thread-id` 派生（最后回退一次性 `mg-<uuid>`），仅派生值、不转发原始官方头。回归 `offline/codex-opencode-session.test.mjs`(2)。

### Verified
- **LIVE-REAL 7/7**：真实 Codex CLI + 真实 chatgpt.com 官方后端 + 真实 OpenCode Go `deepseek-v4.1-flash`，同线程 GPT→第三方→GPT 全部成功（证据 `docs/evidence/2026-11-11-e3-live-switching.md` §E）。
- `npm test` 44/44 隔离套件。

### NOT_RUN
- Desktop；真实 v2 跨供应商；真实配置写入/历史迁移/额度演练。

## 2026-11-11 Codex 聚合 E5/E9：安全 Fallback 与验收矩阵

### Added
- `src/routing/decision.js` 接入 `src/forward.js`（仅 Codex 聚合/官方目标）：请求阶段状态机（accepted/tool_side_effect/stream_delivered/partially_committed/user_cancelled）、13 类错误分类、429+Retry-After 同上游重试、5xx/402/404 授权候选 failover、工具副作用/已交付流/取消/v2 不可读一律 stop、预算耗尽停机不降级、官方候选永不进入通用池、官方 402 需 `defaults.codexEmergency` 显式确认。非聚合请求走旧链路逐字节不变。

### Verified
- `offline/codex-fallback-forward`(10)：429→retry_same、5xx/402/404→failover、tool_call 后断流→stop、已交付后断流→stop、官方 402 未确认→stop、预算耗尽→停机、400→stop、非聚合模型旧兜底。
- `docs/roadmap/2026-11-11-codex-aggregation-e9-acceptance.md` 记录完整 Mock/CLI LIVE/Desktop/TOOLS 矩阵与回滚。

### 未验证 / 边界
- task/daily 费用账本未接 stats；`partially_committed` 无自动信号；Desktop 端到端 NOT_RUN。

## 2026-11-11 Codex 聚合 E7/E8：历史只读诊断与额度应急

### Added
- `src/codex/history.js`（E7）：只读扫描显式 sessions 目录，统计 provider/model、目录缺失模型、工具回放风险计数、v2 加密历史（`unreadable`，不解密）、`planSelectiveMigration` 只读迁移预演（含 sha256/备份建议），写入接口一律 `not_authorized`。输出无正文/密文/绝对路径。
- `src/codex/quota.js`（E8）：官方额度只读评估，无可信数据时严格 `UNKNOWN`；阈值 `warnPercent/criticalPercent`；手动应急态需 `{acknowledged,reason,backupPoint}`，记录时间线、可恢复；输出禁止项（自动切换/购买/退出登录）恒为 false。
- 回归：`offline/codex-history`(3)、`offline/codex-quota`(6)。

### 未验证 / 边界
- 真实 `~/.codex/sessions` 扫描与实际历史迁移：NOT_RUN（D6 要求逐条授权 + 隔离副本 + 回滚演练）。
- 真实官方额度 API 与应急端到端（provider 分组/会话可见性/重启）：NOT_RUN。

## 2026-11-11 Codex 聚合 E2/E3/E4/E6：目录、同线程切换、v2 互操作、受控配置

### Added
- `src/codex/catalog.js` + `scripts/codex-catalog.mjs`：Codex 完整模型目录生成器（官方基线 + 第三方聚合），稳定 ID `mg-<provider>-<model>`、serde/策略校验闸门、版本化与回滚、差异摘要；`--verify-codex` 用 `codex debug models -c` 离线校验。第三方模型必须声明 `maxContext`（缺少即 fail-closed）。
- `GET /v1/models?client_version=…` 返回 Codex `{models:[ModelInfo…]}`（启动与热重载同源注入 `cfg._codexCatalog`）；普通 OpenAI 客户端维持旧 list 形状。
- E3 官方透传代理（`index.js`）：`classifyTarget==='official'` 时按 D1-A 走官方后端（`/backend-api/codex/responses`），官方请求不重试、不跟随重定向、候选只能是官方目标；WS upgrade 回 404 让客户端回落 HTTPS；请求体支持 `content-encoding: zstd/gzip/deflate/br`（Codex 0.167 实测 zstd），未知/损坏编码 415 且零上游。
- `src/codex/interop.js`（E4）：`namespace` 工具可逆展开 `mg_ns__<ns>__<tool>` 与回程 `{name,namespace}` 还原、call_id 配对、托管工具 `unsupported_tool` 显式错误、v2 加密任务 `v2_encrypted_task_unsupported`；原生 responses 透传 `mode:'native'` 不经过桥校验。
- `src/codex/config.js`（E6）+ `/ui-next` D1-A 客户端卡片：受控写入 config.toml（只改 model_provider/openai_base_url/model/model_catalog_json/features），sha256+令牌门禁、原子写、.bak/.prev 备份、并发冲突拒绝、`[model_providers.openai]` 只告警保留、拒绝写 auth.json。
- 回归：`offline/codex-catalog`(27)、`codex-interop`(15)、`codex-config`(31)、`codex-official`(4)、`codex-control-items`(1)、`request-encoding`(4)、`codex-routing-catalog`(10)。

### Fixed
- resume 切模型时 Codex 发来的控制项 `configuration_update` / `additional_tools` 不再让 Chat 桥整条 400，改为显式丢弃并记 `lossy: input_dropped:<type>`。
- 启动路径补齐 `cfg._codexCatalog` 注入：官方 slug 不再因"未知非保留前缀"回落 `defaults.provider`（跨身份串线）。

### Verified
- **LIVE（真实 chatgpt.com 官方后端 + 真实 Codex CLI）**：同一线程 GPT → 第三方 → GPT，5/5 通过；官方轮 usage 21,849 input / 8 output。证据 `docs/evidence/2026-11-11-e3-live-switching.md`。
- 离线真客户端 × 双 mock：9/9（官方头只到官方、第三方零官方头、WS 回落、同线程三轮）。
- 目录真实生成物 14 模型（12 官方 + 2 第三方），`codex debug models -c` 解析 exit 0。
- `npm run check` / `npm test` / `docs:check` / `check-metadata` 全绿（最终计数见 E9 报告）。

### 未验证 / 边界
- Desktop 同会话切换、WebSocket 传输代理、真实第三方付费上游在聚合模式下的轮次：NOT_RUN。
- 官方订阅经本地网关的条款/政策边界：本轮由所有者授权测试；产品化发布前需单独合规结论。

## 2026-11-11 Codex 聚合 E1：凭据隔离与严格路由（未发布）

### Added
- `src/codex/identity.js`：目标身份域分类（`official` / `thirdParty` / `unknown`）。判定依据是**官方 host 白名单 + 显式 `providers.<名>.codexIdentity`**，provider 名字不参与——把条目叫 openai 既不构成官方目标，也不使其自动成为第三方。声明与 host 冲突（声明 official 却指向非官方 host，或反之）判 `unknown` 并 fail-closed。新增 `defaults.codexOfficialHosts`（**替换**内置 `api.openai.com`/`chatgpt.com`/`chat.openai.com` 清单）。
- `src/codex/auth.js`：请求头防火墙。第三方目标剥除官方专用集（`authorization`、`chatgpt-account-id`、`openai-beta`、`version`、`originator`、`session-id`、`thread-id`、`x-client-request-id` 及 `chatgpt-*`/`openai-*`/`x-codex-*`/`x-openai-*` 前缀）与 WebSocket/逐跳头（`sec-websocket-*`、`upgrade`、`connection`）；官方目标只放行白名单。官方目标新增 host/scheme/path 白名单与两条互斥凭据路径（网关自有 key；客户端官方凭据透传，`MG_CODEX_OFFICIAL_PASSTHROUGH=1` 才开启，默认 403 `official_passthrough_disabled`）。E3 集成导出 `isOfficialTarget` / `OFFICIAL_REQUEST_HEADER_NAMES` / `buildOfficialHeaders` / `officialPassthroughEnabled`，与转发路径共用同一组常量。
- 严格聚合路由：`defaults.aggregatePrefixes`（默认 `mg-`/`mg/`）为聚合保留 ID 前缀；命中前缀但未在 `models`/别名显式声明时返回 404 `unknown_model`（附 `available` 列表）且零上游请求，不再静默回退 `defaults.provider`。非保留前缀的未知模型维持旧兜底语义。
- 回归 `scripts/test/offline/codex-identity.test.mjs`（14 组）：第三方逐头剥离/官方白名单/两条凭据路径互斥、host·scheme·path fail-closed、恶意 `extraHeaders`（不得覆盖或注入鉴权头）、302 不跟随、WS upgrade 不转发、聚合 ID 404 与旧兜底兼容。

### Changed
- `src/forward.js` `buildHeaders` 改为按身份域逐头决策，并在转发前增加身份门禁（拒绝产生零上游 I/O）。日志只记录被丢弃/拦截的**头名**，不记录头值。
- `extraHeaders` 不再能覆盖或注入 `authorization`/`x-api-key`/`x-goog-api-key`/`chatgpt-account-id`/`cookie` 等凭据头与帧层头：命中即忽略并写审计日志（`forward.js`、`embeddings.js`、`rerank.js` 同一守卫）。

### Verified
- `npm run check` 0（含 UI）；`npm test` **35/35** 隔离套件通过（新增 codex-identity 14/14）；`npm run docs:check` PASS；`node scripts/check-metadata.mjs` 21 项 PASS。
- 全部为本地 mock + 动态端口 + 临时配置目录：**零真实上游调用**，未读写 `~/.codex`、未改正式配置、未占用 8787。

### 未验证 / 边界
- 真实官方登录透传（`openai_base_url` 指向网关 + 客户端 ChatGPT 凭据）与 `GET /v1/models?client_version`、WS→HTTPS 回落在 `index.js` 侧收口：本阶段只提供离线头矩阵与门禁，真实链路标 NOT_RUN。
- 网关探活/预热/模型测试路径（`src/request.js` 的 `applyProviderHeaders`）仍走旧 `extraHeaders` 合并；本阶段未纳入同一守卫。

## 2026-11-10 Codex 多 provider 边界与原生用量采集（未发布）

### Added
- `GET /api/native-usage?days=1|7|30|90` 与 `src/native-usage.js`：只读汇总 Codex 本地 sessions 的 `session_meta`/`turn_context`/`token_count`，返回 token 计数、按日/按模型聚合；**不读取消息正文**。配置 `defaults.nativeUsageDir` 或 `MG_NATIVE_USAGE_DIR`，默认关闭（`off`/空串）。管理 API 契约与 UI 矩阵同步。
- 新前端「监控与诊断」增加“原生 / 直连用量（只读采集）”卡片；「安全与设置」增加采集目录与保存入口。
- `GET /api/status` 的模型增加 `effectiveApi` 与 `hostedTools`（`native` / `chat-bridge-lossy`），把托管工具保真度变成可观察字段。
- 回归：`offline/native-usage.test.mjs`（2 组：精确聚合/不含消息正文/非 jsonl 忽略；默认关闭与目录不存在）、`offline/hosted-tools.test.mjs`（原生保留 web_search/namespace；Chat 桥丢弃并保留函数工具）。

### Verified
- Codex CLI 0.167 的 `/model` 只列出当前 provider 的模型；`codex exec resume` 跨 provider 被明确拒绝（`modelProviderMismatch`）。同一 thread 不能原地切换 provider，结论从“未验证”变为“已验证限制”。
- ChatGPT Desktop 26.1103.32239 的 app-server 协议支持 per-thread `modelProvider`，但 Desktop 创建线程固定传 `modelProvider:null`，模型列表无 provider 过滤、UI 无 profile 选择器；单实例只能用当前 provider。
- 本机只读扫描真实 Codex sessions：39 文件 / 32 会话 / 389 ms / 0 解析错误（个人用量数字不外发），证明采集性能与格式兼容。
- `npm test` 30/30 隔离套件；浏览器 14/14（含原生用量卡与设置项）。

### 未验证 / 边界
- 用独立 `CODEX_HOME` 启动第二个 Desktop 实例的端到端 GUI 流程：未验证，不作为已交付能力。
- 真实原生 Responses 上游的 `web_search`/`namespace` 托管工具：本机只有 mock wire 级验证；OpenCode Chat 上游本身不提供这些工具，网关不能凭空补齐。
- 原生用量采集是观察，不是配额/限流；只读，默认关闭。

## 2026-11-09 整合候选版 /ui-next 控制台（未发布，integration/modelgate-next）

### Added
- **全新 `/ui-next` 控制台**（`src/ui-next/`，零第三方依赖）：Dashboard、Providers、Models & Routing、Clients、Observability、Security & Settings 六个功能区；共享 API 客户端（内存令牌、统一错误与 401 锁定）、状态 store、hash 路由、组件库（表格/对话框/图表/toast）、版本化配置草稿与差异预览、409 冲突重载、Provider/模型/虚拟模型 CRUD、独立 Key 通道、探活与模型测试的费用确认、客户端模板与验证等级、日志过滤与真实派生分类、配置导出脱敏。旧 `/` 与 `/admin` 保留。
- `/ui-next/**` 只读静态服务：扩展名白名单、编码穿越与隐藏文件拒绝、严格 CSP（`default-src 'none'; script-src 'self'`）、nosniff、no-referrer。
- 浏览器验收夹具与工具：`scripts/test/ui-fixture.mjs`（隔离配置 + 本地 mock 上游 + 可复现流量）、`scripts/test/ui-browser-check.mjs`（零依赖 CDP：桌面/平板/手机、明暗主题、409、XSS、鉴权、控制台健康）。证据见 `docs/evidence/2026-11-09-integration/`。

### Fixed
- `GET /api/config` 未回显虚拟模型 `expiresAt/note` → 前端一次“读→改→保存”会清空元数据；现从 `keys.__mg_vm_meta_<name>` 投影并在 `offline/ui-contract.test.mjs` 回归。
- `GET /api/config` 的 `defaults.clientKey` 只检查明文 defaults，永远回显空串；现同时检查加密 `__mg_client` 并回显 `********`。
- 数据面 JSON 分发忽略 `out.headers`，429 `Retry-After` 无法到达客户端；两处分发已合并 `out.headers`。

### 已验证
- `npm test`：28/28 隔离套件通过；`npm run check` 0（含 UI 模块 15/15）；docs:check PASS；metadata 21 项 PASS。
- 浏览器：14/14 检查通过（锁定页、真实指标、六个路由、对话框 Esc、409、XSS 文本化、主题、1440/1024/768/390 无横向溢出、错误令牌、0 未捕获异常）。
- DSH 0.2.2-rc.1 × 本地 mock：Chat、Responses Chat 桥、原生 Responses 三条路径均 exit 0。
- **真实客户端 × 真实上游（最小验证）**：Codex CLI 0.167 与 DSH 0.2.2-rc.1 经隔离 8789 → OpenCode Go `deepseek-v4.1-flash`，均 exit 0，输出 `MODELGATE_REAL_OK` / `DSH_REAL_OK`；网关 3 请求 / 18,809 tokens / 0 错误。证据 `docs/evidence/2026-11-09-integration/real-client-validation.txt`。
- 分支已推送并创建 Draft PR #5（base main）；#2/#4 均为 OPEN/Draft 且 MERGEABLE。

### 未验证 / 阻断
- 真实工具执行（Codex/DSH shell/apply_patch）：宿主 bwrap 仍不能创建非特权 user namespace，文本/流式已验证，工具往返 NOT_RUN；未使用跳过沙箱参数。
- Codex Desktop：未启动；CLI 证据不覆盖桌面端。
- 429/5xx 真实故障注入：NOT_RUN；真实上游仅做最小成功链路。
- Web 备份/恢复：后端无 API，界面明确 NOT_SUPPORTED。
- 嵌入/重排内联链的 429 仍按旧逻辑计熔断；流式重连对工具请求的重发边界未改。

## 2026-11-09 429 归因 / Retry-After / 非幂等不重放治理（未发布，G1 移植）

### Added
- `src/retry-policy.js`（零依赖纯函数）：`classify429` 把上游 429 归因为 `platform_quota|model_capacity|rate_limit|unknown`（读 ≤8KB 错误体，匹配不到不臆造）；`parseRetryAfterMs`/`retryWaitCap`/`retryWaitFits` 把 Retry-After 与请求剩余预算对齐（单次上限 30s、留 50ms 收尾余量、支持 HTTP-date）；`isToolBearingBody` 识别 `tools`/`tool_calls`/`role:"tool"`/`input` 工具项等非幂等请求。
- 离线回归 `scripts/test/offline/retry-governance.test.mjs`（11 用例）：四类归因、Retry-After 解析与预算钳制、429 原样返回、等得下才等、等不下立即 429、429 不熔断、普通请求仍可重试、tool 请求同上游不重试/可换一次上游/不回队首重放、预算耗尽仍 504 且不计上游失败。

### Fixed
- **上游 429 被吞成 502**：`forwardChain` 追踪最后一次 429（含所有上游都在 429 冷却中），链/预算结束时按原状态回 `429` + `Retry-After` + `{type:"rate_limited", code:"MG_429_<ATTRIBUTION>", attribution, upstream_status, retry_after_ms, attempts}`；数据面 JSON 分发透传结果里的 `headers`。已进入流式阶段仍走流内错误事件（不改已发出状态码）。
- **429 触发熔断**：429 不再 `markFail`/打开 `circuit`，只做 `min(Retry-After, 60s)` 上游冷却；仍计入 errors/retries 与延迟样本。5xx/网络错继续熔断。
- **Retry-After 空等**：只有能在剩余预算内等完才等（`retryWaitCap`），等不下立即停止重试并上抛，不再把 5s/1h 的 Retry-After 硬等成超时，也不越过 deadline；冷却超出预算的上游直接跳过。
- **非幂等重放**：带工具语义的请求同上游只发一次，且整条链最多走一轮（本轮内可换一个上游/模型，但不回队首重放），避免重复触发 `shell_command`/`apply_patch` 这类客户端工具。
- 上游可重试错误的响应体只读 ≤8KB 用于归因，读完即销毁连接；429 归因不影响 2xx/4xx 透传路径。

### Changed
- 带工具语义的请求默认不再自动重放：同上游只发一次（不按 `retry.maxAttempts` 重试），整条链最多走一轮——本轮内仍可换一个上游/模型继续尝试（可用性优先：**Codex CLI / DSH 每轮都带工具定义**，不能让这类 agent 流量整体失去 fallback），但不回队首重复整条链。可用 `forwardChain(..., opts.noReplay = false)` 显式放开，取舍记录在 [请求生命周期契约](docs/contracts/request-lifecycle-v1.md) §9.5。

### 未验证
- 真实上游 429 与真实客户端（DSH/Codex）重放行为实跑：`NOT_RUN_LIVE`（本轮全部为本地离线 mock）。
- `/v1/embeddings`、`/v1/rerank` 内联链的 429 仍按旧逻辑计入熔断并最终回 502，未纳入本次治理（不在 `src/forward.js` 链内）。

## 2026-11-09 剩余验证闭环与 Responses 客户端兼容（未发布）

### Fixed
- **`/v1/responses` 桥拒绝真实客户端固定发送的 `include` 项**：Codex CLI（0.167）与 DSH headless（0.2.2-rc.1）在 Responses 请求里固定带 `include:["reasoning.encrypted_content"]`，原实现整条拒绝 → 真实客户端直接 400 `unsupported_parameter`（本轮 DSH 复现）。现只接受**丢弃后不影响正确性**的项（`reasoning.encrypted_content`、`output_text.logprobs`）并记 `lossy: include_dropped:<项>`；图片/托管产物/未知项仍显式拒绝，避免静默丢产物。契约 §3.3/§4/§7 与 `offline/responses-mapping.test.mjs` 同步。
- **Responses 桥对托管工具/`namespace` 整条拒绝 → Codex CLI 完全不可用**：Codex 0.167 已取消 `wire_api="chat"`（openai/codex discussions#7782 明确要求统一 `responses`），且每轮固定发 `type:"namespace"`（`multi_agent_v1`）与 `type:"web_search"`；原实现按契约整条 400，等于永不支持 Codex。现桥方向**丢弃 Chat 无法表达的工具类型**并逐项记 `lossy: tool_dropped:<type>`，`tool_choice` 点名被丢弃工具时降级 `auto` 并记 `tool_choice_dropped:<name>`；`store/previous_response_id/background/truncation` 的显式拒绝不变，原生 `api:"responses"` 透传不受影响。回归 `offline/responses-mapping.test.mjs`（丢弃 + tool_choice 降级）与 `offline/responses-endpoint.test.mjs`（丢弃后仍 200 且上游只收到 function tool）。

### 已验证（真实客户端/真实上游）
- DSH 0.2.2-rc.1 以 `api: openai-responses` 经 `/v1/responses` 完成真实回合（rc=0、completed、final 非空）；`/v1/responses` 真上游非流式与流式均 200，流式按契约发出 created→…→completed 且不发 `[DONE]`。
- 虚拟共用名 `gatemodel` 经 `defaults.directory` 链真实往返成功（日志 `model=gatemodel serving=deepseek-v4.1-flash`）。
- 真实上游 402（openrouter 余额不足）按模型级拒绝继续目录链，最终 200——真实 402 兜底口径成立。
- 管理面并发保存：带 `version` 且过期返回 409 + `currentVersion` 且配置不变（API 层；面板双标签 UI 交互仍未实跑）。
- **真实 Codex CLI 0.167 经网关完成真实回合**：`wire_api="responses"` 指向 `127.0.0.1:8788/v1`，rc=0、输出 `CODEX_OK`、tokens used 8,468；并完成一次真实工具往返（`exec_command pwd` → `function_call_output` → 第二回合输出目录）。网关日志可见有损项：`include_dropped:reasoning.encrypted_content, tool_dropped:namespace, tool_dropped:web_search, reasoning_summary, unknown_field:prompt_cache_key, unknown_field:client_metadata`。

### 未完成（不得当通过）
- **真实 Codex CLI 对照已 PASS**（见上「已验证」）；代价是 Codex 的 `web_search`/`multi_agent` 工具经网关不可用（有损，日志逐项可见）。若将来要支持它们，只能走原生 `api:"responses"` 上游，不能在 Chat 桥里伪装。
- **Draft PR #2 不合并原样**：它把 `/v1/responses` 旁路到独立 handler，绕过 `forwardChain`（无预算/取消/额度/虚拟模型/SSE 背压），且与已合并的两套事件序列冲突；仅 `noRetry429`（429 原样透传 + `Retry-After`）值得并入 MG-002 余项。审计见验证报告 §7.2。
- anthropic 协议适配的真实上游对照仍缺（openrouter 账户 402）；embeddings/rerank/audio/image/video 没有对应 capability 模型，需先做「模型 + 计费」决策。
- MG-009 托盘实跑缺 `gir1.2-ayatanaappindicator3`（按资源门禁不自行安装）；Windows/macOS 按用户指示本轮不做；Node 18/20 本机无第二运行时。

## 2026-11-09 真实客户端链路验证（未发布，DSH CLI × ModelGate）

### Added
- 用户级环境变量兜底的**离线回归** `scripts/test/offline/user-env.test.mjs`（5 用例）：来源优先级 keys→env→env-registry→无、60s TTL 正/负缓存与清缓存重查、变量名白名单（非法名不触达读取器）、`environment.d` 排序覆盖与注释/非法行、双引号转义还原。为可测性给 `src/router.js` 增加 `__setUserEnvReaderForTest()`/`__clearUserEnvCache()` 注入点（注入后仍复用同一份缓存与白名单）与 `readEnvironmentDir(name, baseDir?)` 可选目录参数；**运行时行为不变**。
- 文档 `docs/roadmap/2026-11-09-dsh-cli-live-verification-report.md`：DSH CLI 作为真实客户端经网关调 OpenCode 上游的端到端证据（流式/工具调用/同 SID 续传）、Linux Key 链路两种启动方式、错误路径对照；全掩码，无 Key/正文/私有配置。

### Fixed
- **Linux 兜底的文档口径过期**：本节历史条目写「仅 Windows 生效（其他平台维持进程环境行为）」，与代码事实不符——`resolveKey` 在 Linux/POSIX 已走 `systemctl --user show-environment` 再回落 `~/.config/environment.d/*.conf`（同一份 60s TTL 正/负缓存）。[配置参考](docs/reference/configuration.md)补 `apiKeyEnv` 的三段解析顺序，并写明「网关的用户级兜底不替客户端进程补 Key，客户端缺变量报的是客户端侧 `MISSING_CREDENTIAL`」。

### 已验证（真实链路；真实上游消耗按最小必要）
- DSH CLI `0.2.2-rc.1` → 隔离网关 8788 → OpenCode 上游：3 回合（纯文本流式、`read`/`glob`/`bash` 工具调用、同 SID 续传）全部 exit 0、`turn_end.reason.kind=completed`、final 非空；网关 `requests`/`tokens` 与回合进程一致。
- `reasoning_effort=high` 由 CLI 发出、被网关原样透传到上游（本地 mock 上游对照取证，零成本）；客户端显式 `low` 不被网关覆盖。
- 错误路径（未知模型 / 上游 400 / 上游 500 / 首字节超时 / 缺 Key）：状态码与错误信封正确、CLI 报错可读、不泄露上游 Key。

### 未验证
- 生产 8787 与 systemd 服务（按约束未触碰）；真实上游故障注入（改用本地 mock 复现）；Windows/macOS 与 Node 18/20。
- 本轮复现出 DSH 侧缺陷（流式 tool_call 参数整串重发被重复拼接 → `MALFORMED_RESPONSE`）与「档位白名单两侧须一致」；归因/复现/修法见验证报告 §6，属 DSH 仓库，本仓库不改 vendored 依赖。

## 2026-11-09 管理面 D-1/D-6 收尾（未发布，MG-009 余项）

### Added

- `GET /api/config` 只读配置投影（D-6）：返回 `{configVersion, providers, models, defaults, virtualModels}`，形状与 `POST /api/config/save` 请求体一致；剥离 providers/models 运行时字段、不返回 `_keys`/`_paths`、`defaults.clientKey` 掩码；未知扩展字段保留；鉴权/错误信封同管理 GET。
- 面板未知字段不透明袋（D-1）：`admin.html` 的 `buildCfrom` 把未识别字段存入 `_extra`，provider/model 编辑用 `Object.assign` 保留，`saveAll` 通过 `serializeMap` 合并回送，不再静默洗掉插件/新版本字段。
- 回归 `scripts/test/offline/config-projection.test.mjs`（3 组：投影形状与脱敏/鉴权与保存回读/面板 `_extra` 静态检查）；管理 API 契约与投影契约同步。

### 未验证
- 浏览器真实鉴权与保存回读、双标签 409、Linux/Windows 托盘实跑（本机无 Chrome/桌面环境，**NOT EXECUTED**）；provider 删除联动清 Key 仍未实现。

## 2026-11-09 原生 Responses 透传（未发布，MG-015 收尾）

### Added

- `models.<名>.api="responses"`（保存校验已允许）时，`/v1/responses` 走原生透传而非 Chat 桥：请求原样发往 `responsesPath`（默认 `/v1/responses`），`providerModels` 覆盖名生效；非流式 JSON 透传并把 `model` 回写客户端请求名，流式 SSE 逐字节管道（复用背压与预算中止）。拒绝矩阵（store/previous_response_id/background/include/truncation/托管工具）与能力隔离仍生效；上游错误体/状态透传。
- 回归 `scripts/test/offline/responses-native.test.mjs`（4 用例：非流式请求/响应/记账、SSE 原样、拒绝与能力隔离、错误与预算 504）；协议桥/契约/配置参考同步。

### Fixed
- 请求预算小于 `firstByteMs` 时，first-byte 定时器会先触发并被当作普通网络超时（502 `provider` 失败）；现按预算中止语义上报 504 `request_timeout`（影响所有入口的预算测试稳定性）。

### 未验证
- 真实 Codex CLI/桌面与 DSH 对照、Draft PR #2 审计；原生流式不改 model 字段（有损，已在契约 §7/§9 记录）。

## 2026-11-09 Video 异步任务池（未发布，MG-014）

### Added

- `capability=video` 与 Video API：`POST /v1/videos` 创建任务（支持 `Idempotency-Key`，同 key 返回既有任务不重复请求上游）、`GET /v1/videos/:id` 查询（惰性 ≥1.5s 一次 + 后台 5s 轮询）、`POST /v1/videos/:id/cancel`、`GET /v1/videos` 列表。
- 任务持久化到 `<配置目录>/videos.json`（原子写、单进程）：状态机 queued/running/succeeded/failed/canceled，终态幂等；重启恢复未完成任务并继续轮询；终态保留 7 天、总量上限 500、非终态超 24h 判 failed；启动与每小时 GC。
- 上游只桥接 OpenAI 兼容协议；路径可按模型覆盖 `videoCreatePath` / `videoStatusPath` / `videoCancelPath`（默认 `/v1/videos`、`/v1/videos/{id}`、`/v1/videos/{id}/cancel`）；任务 id 兼容 `id/task_id/request_id`，状态词归一；创建/轮询/取消复用 `forward()` 的 retry/timeout 与 `overallMs` 预算。
- 决策文档 `docs/explanation/adr-0001-video-task-pool.md`；回归 `scripts/test/offline/video.test.mjs`（6 用例：创建→轮询→完成与落盘、幂等、取消、重启恢复+GC、能力隔离/不支持协议、校验与预算）。

### Changed
- `npm run check` 覆盖 `src/videos.js`；`configPaths()` 新增 `videos`；admin 编辑器 capability 增加 video。

### 未验证
- 真实视频上游（Sora/Veo/Kling 等）路径/状态词/结果格式与计费；多进程共享配置目录；webhook 与结果转存；Windows/macOS、Node 18/20。

## 2026-11-09 Audio/Image 媒体能力（未发布，MG-013）

### Added

- `capability=audio|image` 与四个媒体入口：`POST /v1/audio/speech`（JSON → 二进制音频，content-type/字节透传）、`POST /v1/audio/transcriptions`（multipart）、`POST /v1/images/generations`（JSON）、`POST /v1/images/edits`（multipart）。只桥接 OpenAI 兼容上游；Anthropic/Gemini/Cohere 显式 502 且不触上游。
- multipart 处理：只解析 `model` 字段用于路由与 per-上游覆盖名替换（`replaceMultipartField`），文件字节原样转发；请求体受 `server.maxBodyBytes`；响应体受 `defaults.mediaMaxResponseBytes`（默认 64MiB，超限 → 502 `media_too_large`）。
- 媒体能力隔离（与 chat/embedding/rerank 互斥）；复用 provider `fallbacks`、熔断、并发信号量与 `overallMs` 预算/取消；usage token（图片 JSON 响应等）计入账本，无 usage 记 0；audio/image 不提供在线探测（避免计费媒体）；admin 编辑器 capability 增加 audio/image。
- 回归 `scripts/test/offline/media.test.mjs`（8 用例：speech 二进制、transcription 与 edits 的 multipart 原样转发、图片 JSON 与 usage 记账、能力隔离、Anthropic 拒绝、响应体积上限、预算 504 与 multipart 缺 model 400）；文档见配置参考与协议桥 §9。

### Changed
- `npm run check` 覆盖 `src/media.js`。

### 未验证
- 真实 OpenAI 音频/图像上游与计费、大文件（>32MiB）上传/下载、multipart 多文件与 `response_format=base64` 的真实行为；Windows/macOS、Node 18/20。

## 2026-11-09 Rerank 能力（未发布，MG-012）

### Added

- `capability=rerank` 与 `POST /v1/rerank`（兼容 `/rerank`）：OpenAI 兼容上游走 `/v1/rerank`，`api=cohere` 上游走 `/v2/rerank`；请求校验（query 非空、documents 非空字符串数组且 ≤2048、top_n 正整数、return_documents 布尔）。
- 响应归一：`results[]` 保留 `index/relevance_score/document`，按 score 降序、同分按 index 升序稳定排序，`top_n` 再次裁剪，`model` 回写客户端请求名；上游 `meta`/`usage` 原样保留；usage token 计入模型/日/全局/上游账本。
- 能力隔离：rerank 模型不能进 chat/embeddings，chat/embedding 模型不能进 rerank；虚拟模型不支持 rerank；Anthropic/Gemini 无 rerank → 502 且不触上游。
- 复用 provider `fallbacks`、熔断、并发信号量、`overallMs` 预算与 `maxBodyBytes`；`/api/model-test` 按 capability 走 rerank 探测；模型编辑器 capability 增加 rerank 选项。
- 回归 `scripts/test/offline/rerank.test.mjs`（6 用例：OpenAI 透传/排序/记账、Cohere 路径与 meta、能力隔离、fallback、校验、探测与预算）；文档见配置参考与协议桥 §8。

### Changed
- `npm run check` 覆盖 `src/rerank.js`；模型 `api` 校验新增 `cohere`。

### 未验证
- 真实 Cohere/Jina/SiliconFlow rerank 上游与计费；`return_documents` 与上游 `document` 形状差异；Windows/macOS、Node 18/20。

## 2026-11-09 能力声明与 Embedding（未发布，MG-011）

### Added

- `models.<名>.capability`：`chat`（默认）/`embedding` 能力声明；保存接口校验未知值（400），`/v1/models` 与 `/api/status` 暴露该字段，模型编辑器可切换。
- `POST /v1/embeddings`：OpenAI 兼容请求（`model`/`input` 字符串或字符串数组/`dimensions`/`encoding_format`，批量上限 2048）；OpenAI 兼容上游原样透传；Gemini 经 `:batchEmbedContents` 适配（`dimensions → outputDimensionality`，`embeddings[].values → data[].embedding`）；Anthropic 无此能力 → 502 且不触上游。复用 provider `fallbacks`、熔断、`defaults.timeout`/`overallMs` 预算、`maxBodyBytes` 与并发信号量。
- 能力隔离（双向）：embedding 模型从对话入口调用返回 400 `unsupported_model`；chat 模型从 embeddings 入口调用返回 400；虚拟模型/默认共用名不支持 embeddings。
- 记账与探测：embedding usage token 计入模型/日/全局/上游账本；`/api/model-test` 按 capability 选择 embeddings 端点；`/v1/models` 暴露 capability。
- 回归 `scripts/test/offline/embeddings.test.mjs`（7 用例：OpenAI 透传与记账、双向隔离、Gemini 路径/请求体/协议头/响应归一、Anthropic 拒绝、fallback、能力探测、预算 504）；文档见配置参考与协议桥 §7。

### Changed
- `npm run check` 覆盖 `src/embeddings.js`。

### 未验证
- 真实 OpenAI/Gemini embeddings 上游与计费、token-id 输入、base64 编码输出透传行为；Windows/macOS、Node 18/20。

## 2026-11-09 Responses 入口与 Chat 桥（未发布，MG-015）

### Added

- `/v1/responses`（与 `/responses` 别名）入口：将 Responses 请求映射为 Chat Completions 走既有治理（虚拟模型/Key/配额/熔断/亲和/统计/日志脱敏/MG-002 预算），再把上游结果重建为 Responses JSON 或 SSE 事件。非 POST 返回 405。
- `src/responses.js`：纯函数映射 `responsesToChat`（input/instructions/tools function|custom/tool_choice/reasoning/max_output_tokens；custom tool 自由文本编码为 `{input}`；**拒绝** store=true、previous_response_id、background=true、非空 include、truncation≠disabled、托管工具，400 且不触上游）、`chatToResponse`（`resp_*`、model 回写、output/output_text、usage/incomplete_details）、`makeSSEWriter`（§6 事件顺序、sequence 单调、不发 [DONE]）。
- `src/responses-stream.js`：Chat SSE → Responses 事件桥，复用 `relayStream` 的断流续传/空闲看门狗/预算/背压；流式终态 `response.completed` 或 `response.failed`（预算耗尽 `REQUEST_TIMEOUT`）；上游降级为 JSON 时以单帧事件交付。
- 回归：`scripts/test/offline/responses-mapping.test.mjs`（17 用例）与 `responses-endpoint.test.mjs`（6 用例：非流式整形、拒绝矩阵、SSE 顺序/无 [DONE]、工具参数分片、错误透传、405）。

### Changed
- `npm run check` 覆盖新增的 `src/budget.js`、`src/responses.js`、`src/responses-stream.js`。

### 未实现 / 未验证
- 原生 `api:"responses"` 透传（配置校验仍只允许 openai/anthropic/gemini）、真实 Codex CLI/桌面与 DSH 对照、Draft PR #2 审计均 **UNVERIFIED**；工具并行多调用以收尾时逐条补发完整参数呈现，不是逐调用并行 delta。

### 验证
- `npm run check` 0；`npm test` 18/18 隔离套件；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件；`npm run docs:check` PASS。

## 2026-11-09 模型解析一致性与错误信封（未发布，MG-008 余项）

### Fixed

- **预热/failback 与转发模型解析不一致**：`warm()`（缓存预热）与 `probeChat()`（主上游回切探活）此前固定打 `/v1/chat/completions` 并使用网关模型名，导致 per-model `api`（anthropic/gemini）与 `providerModels` 覆盖名在这两条路径失效（非 OpenAI 上游预热/探活永远失败，或探活打到错误模型）。现两者接受 `{ api, upstreamModel }`，按协议生成 path/body 与鉴权头（Anthropic `/v1/messages` + `x-api-key`/`anthropic-version`；Gemini `generateContent`/`streamGenerateContent` + `x-goog-api-key`）；Anthropic/Gemini 预热补一条 user 消息（协议要求至少一条非 system 消息）。
- **非 OpenAI 上游 4xx 原生错误信封原样回给 OpenAI 客户端**：Anthropic `{type:"error",error:{type,message}}` / Gemini `{error:{code,message,status}}` 客户端拿不到 `error.message`。现由 `mapErrorEnvelope()` 映射为 `{error:{message,type:'upstream_error',code}}`（状态码保留；已是 OpenAI 形状的代理响应原样透传；日志仍记录原始片段）。

### Added

- `router.modelTarget(cfg, modelName, pid)` 单一模型解析入口：`servingName`（providerModels 覆盖名）/`api`（模型优先、上游兜底）/`effortFormat`/`maxTokensMax`；转发、`probeModel`、预热、failback 全部复用。
- 回归 `scripts/test/offline/model-resolution.test.mjs`（7 用例）：modelTarget 优先级、warm/probeChat 的 Anthropic/Gemini path+覆盖名+鉴权头、错误信封映射、Anthropic 400 集成、OpenAI 错误透传对照。
- 文档：`docs/reference/protocol-bridge.md` §7（模型解析与错误信封）。

### 验证

- `npm run check` 0；`npm test` 16/16 隔离套件；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件；`npm run docs:check` PASS。
- 未验证：真实 Anthropic/Gemini 上游、预热/failback 的实时定时器端到端（仅函数级 + 转发集成）、Windows/macOS、Node 18/20。

## 2026-11-09 管理面投影清洗与 Key 标识白名单（未发布，MG-009）

### Fixed

- **配置保存把投影统计字段写进 `gateway.local.json`（D-2）**：`/api/status` 的 `providers`/`models` 混有 `st`/`probe`/`requests`/`errors`/`tokens` 等运行时字段，旧面板原样回送时被整体替换落盘，配置被污染。`doSaveConfig` 现以显式 denylist 剥离 `providers[*]`（hasKey/keySource/keyOk/st/probe）与 `models[*]`（probe/requests/errors/tokens/today/hitRate/affinity/avgMs/inTokens/outTokens/latencySum/latencyCount）后再写入；**未识别的扩展字段仍保留**（不透明袋约定）。
- **Key 保存无版本校验（D-7，面板侧）**：`admin.html` 上游 Key 保存/删除与虚拟模型 Key 统一走 `postKey()`，携带 `baseVersion ?? ST.configVersion`；409 提示后加载最新，不再静默覆盖。
- **dirty 时 3s 轮询洗掉保存基准版本（D-3）**：首次脏化冻结 `baseVersion`，`ingestStatus` 在脏状态不覆盖 `ST.configVersion`；保存/409/重载成功后清空。
- **`/api/keys` 可写任意 id（§8）**：未配置的上游/虚拟模型标识不再接受，避免产生 UI 无法删除的孤儿键。

### Added

- `/api/keys` 标识白名单（MG-009 §8.3）：允许并集 = 当前 `providers` 键 ∪ 当前虚拟模型 `__mg_vm_<name>` ∪ `__mg_client`/`__mg_admin` ∪ keys 库已存在条目（保留历史键清理路径）；未知标识返回 `400 {error:'未知的 Key 标识：<id>'}`；`__mg_vm_meta_*` 只允许删除，不允许写字符串。
- 管理面 UI 投影契约与前端 F0 fixture（`docs/contracts/management-ui-projection-v1.md`、`docs/contracts/fixtures/v1/`）与托盘部署说明（`docs/how-to/tray-deployment.md`）。
- 回归：`scripts/test/offline/admin-projection.test.mjs`（D-2 剥离与扩展字段保留、白名单允许/拒绝/删除、Key 版本三态、面板 D-3 静态检查）；`config-schema` 的未知 `id` 断言同步改为 400。

### 验证

- `npm run check` 0；`npm test` 15/15 隔离套件；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件；`npm run docs:check` PASS。
- 未验证：浏览器真实鉴权/保存回读/双标签 409、托盘实跑、Windows/macOS、Node 18/20、真实上游与计费。

## 2026-11-09 请求生命周期预算与 SSE 背压（未发布，MG-002）

### Fixed

- 单次数据面请求此前没有统一的跨排队/流式 deadline：`overallMs` 只在 `forward()` 重试循环里检查，排队（QPS/并发/429 退避）、代理 CONNECT、读客户端 body、非流式读体和流式中继都可能无限等待；客户端断开也只在中继阶段生效，排队与上游等待会泄漏。
- 代理 CONNECT 挂起（TCP 接受但不应答）此前没有任何超时，请求永久悬挂。

### Added

- `src/budget.js`：请求级预算与 AbortSignal 单一来源。`createBudget({overallMs, signal})` 提供 `deadlineAt`/`remaining()`/`expired()`/`abort(reason)`；`abortedError()` 统一取消/超时错误（status 504、`aborted=true`，上层据此跳过重试与熔断）；`sleepWith()` 为可取消退避。
- SSE 背压：`relayStream` 在 `res.write()` 返回 false 后暂停读取上游并等待 `drain`；等待超过 30s 或未写出缓冲超过 8MiB 立即中止并销毁客户端/上游，按 clientGone 记账（不计上游故障）。
- 契约与回归：`docs/contracts/request-lifecycle-v1.md`（AC-1..AC-7）；`scripts/test/offline/deadline.test.mjs` 13 用例覆盖满队列预算、代理 CONNECT 挂起、慢响应头、慢上游体、客户端断开的排队/等头/流式三种时序、流式预算耗尽、SSE 背压（确定性 fake client）与慢请求 body；`scripts/test/offline/harness.mjs` 新增 `startScriptedUpstream` / `startHangingProxy` 两个夹具导出。

### Changed

- **超时语义（行为变更）**：`defaults.timeout.overallMs>0` 现在是从请求进入网关起算的硬上限，覆盖读 body、全部排队等待、代理 CONNECT、等响应头、非流式读体、SSE 中继与续传，并把模型链 `loopMs` 钳制到剩余预算；每个阶段有效上限 = min(阶段配置, 剩余预算)。**流式阶段同样受该上限约束**。默认 0 保持旧行为（无全局上限），但客户端断开取消始终生效。
- 预算耗尽响应：响应头未发出 → `504 {error:{type:'request_timeout'}}`；已进入流式 → SSE `error`（`type=stream_interrupted`, `code=REQUEST_TIMEOUT`）+ `[DONE]`，已发出的状态码与内容不撤回。
- 排队取消：`acquireProvider`、模型并发信号量、QPS 令牌等待与退避 sleep 均可取消；waiter 从队列移除、已预留 QPS 令牌归还、`release()` 恰好一次；取消不记上游错误、不熔断。
- 探测/预热/回切探活与管理面请求不在本契约范围，行为不变。

### 验证

- `npm run check` 退出码 0；`npm test` 14/14 隔离套件（含 deadline 13 用例）通过；`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27 文件通过；`npm run docs:check` PASS；`node scripts/check-metadata.mjs` PASS (21)。
- 独立 review（只读，2026-11-09）发现 H1（`expired()` 把 `client_closed` 误判为预算耗尽）与 M1–M4，已修复并补测试：新增 `budget.timedOut()/cancelled()`、SSE 按 `timedOut()` 分支；客户端断开/写停滞不再计入上游中断与错误（M1）；QPS 令牌在取消且未发上游时归还（M2）；背压等待响应 `noEventMs` 看门狗（M3）；已完成流不判超时（M4）；另修 dispose 晚到 abort、唤醒后取消的下一位 waiter、写后缓冲复核、极早期断开。
- 二次复核（2026-11-09，只读）：H1/M1–M3 PASS；M4 的“已完成流仍可能被判超时”边界已修（`timedOut = budgetHit && !done`，forward 同时要求 `!relay.completed`，新增 AC-4e）。
- 未验证：真实上游与计费、生产 8787 重启、Windows/macOS、Node 18/20 实跑；长稳/并发压测未做。

## 2026-11-08 审计修复（未发布）

### Fixed

- 无全局客户端 Key 时，绑定 Key 的虚拟模型仍须鉴权；剥离管理/Google Key、客户端 Host 和动态逐跳头。
- 管理请求采用配置的 body 上限，超限保留响应 socket 返回 413；非法 Chat JSON 返回 400。
- 模型探测采用模型协议与 providerModels 覆盖名；配置保存先克隆 defaults。
- QPS 为并发等待请求预留额度，避免相同定时器同时放行突破限速。

### Added

- 管理 API v1 契约基线与离线回归：`scripts/test/offline/harness.mjs`（临时目录 + 动态端口 + 本地 mock 夹具）与 admin-contract / admin-secrets / admin-origin / config-schema / logger-secrets / lifecycle / wire-format 七套离线回归；契约正文见 `docs/contracts/management-api-v1.md`。
- 管理面来源策略配置项 `server.allowedHosts` / `server.allowedOrigins`（反代/自定义域名/跨源面板的唯一放行入口）。

### Changed

- **管理面来源策略（行为变更）**：Host 只接受 IP 字面量与 `localhost`/`server.host`/`allowedHosts` 中的名字，跨源 `Origin` 请求（含 `Origin: null`）在到达路由前 403；未配置管理令牌时管理接口仅允许本机对端，远程返回 403；数据面同样做 Host 校验并拒绝跨源写请求。用域名访问面板或跨源前端调用网关者需补白名单（见配置参考「管理面来源策略」）。
- 配置保存：形状与保留键校验收敛为单一入口，数组/字符串 body、`__proto__`/`constructor`/`prototype` 一律 400；新增删除墓碑 `_removed`，删掉的上游/模型重启后不再复活。
- 日志脱敏词表随配置热更新，代理 URL 内嵌凭据与通用 Bearer 兜底脱敏。
- `start()` 返回 `close()`：停定时器 → 排空连接 → 原子落盘；SIGTERM/SIGINT 优雅退出（退出码 0），损坏 stats 先备份 `.corrupt-<ts>` 再重建。
- 协议桥保真：Anthropic 并行 tool_result / Gemini 并行 functionResponse 合并、Gemini usage 与 finish_reason 映射、thought 摘要过滤、tool_choice 映射、空 tools 不再降级流式、SSE 末帧文本与 finish 同帧不再丢结束原因。
- CI：Node 18/20/22 手动矩阵（不下载 node，先探测 runner 自带），新增 `scripts/check-metadata.mjs`（21 项）与 MIT LICENSE，部署/回滚与兼容矩阵文档。
- 默认 npm test 仅运行隔离 mock 套件；27 个旧套件已全部迁移为自建隔离实例（OS 临时目录 + 动态回环端口 + 本地 mock），`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 即 27/27 文件、133 断言、无 SKIP；utils.mjs 删除「读改写目标配置」入口与 SKIP 语义。
- 修复 logger URL 凭据脱敏的 O(n²)：可回溯字符类改为线性扫描，128KB 单行 6.8s → 0ms、1MB 2ms。
- 现有模型状态字段、OpenCode 会话头/extraHeaders 改动纳入本轮核查；保留原有文档归档迁移。
- 新增 AI 接手入口、分层文档、审计记录、16 项后端任务及既有前端重建计划映射及 CI/文档链接检查。

## [Unreleased] —— 托盘小窗管理器 + 日志按天分文件与 7 天保留 + 交接问题修复批次

- **运维(2026-09-07)**:keys.local.json 明文 key 清空转环境变量解析(resolveKey source=env 实测:mimo-v2.5/glm-5.3-flash 200,gmi 到达上游仅账户余额不足);本机 master.key(自动生成的加密主密钥,keys 库空后无物可守)已删,后续写入 keys 时会按需重建;keys.local.json.enc-backup(Windows 加密旧备份)留存待用户定夺

### Fixed
- **OpenCode Go 接入使用过期路径/会话头且探测不带自定义头**：按 DSH 当前 `deepseek-v4.1-flash` provider 定义改用 `https://opencode.ai/inference/go/v1` 兼容路径并附加 `x-opencode-session`；ModelGate 将客户端的 `x-opencode-session` / `x-session-id` / `x-conversation-id` 或 body 会话 ID 映射到上游头。上游探测和模型探测现在也带 provider `extraHeaders`。同时支持 `defaults.reasoning` 让虚拟共用名在未指定档位时注入默认强度。
- **4xx 但语义是「上游出错」的响应被当客户端错误直接抛回，兜底链形同虚设（2026-09-18 生产实录）**：atria 短时故障返回 `422 {"error":{"message":"Inference request failed.","type":"atria_api_error","code":"upstream_error"}}`，`isModelLevelRejection` 只认 402/403/404 与「含模型/上游不可用语义的 400」，422 落到「真·请求错误」分支 → **原样抛给客户端、不切兜底链**，而 `defaults.directory` 上还排着 qwen3.8-flash / glm-5.3-flash 两个健康模型没用上，用户那一轮 turn 直接失败（ZCode: `reason=invalid_request status=422 retryable=false`）。与 402 属同类问题（0.5f99b4c 的修法同源）。现 `src/forward.js` 新增 `isUpstreamSideFailure()`：4xx（排除 401/402/403/404/429 各自的专道）+ 响应体显式含上游出错语义（`upstream_error` / `inference request failed` / `internal server error` / `service unavailable` / `overloaded` / `bad gateway` / `gateway timeout` / `请稍后重试` / `服务不可用`）→ 计为**真·失败**（进熔断计数，反复这么报的上游该被冷却）、保留原始响应、**继续目录链**；整链全败时回最后一个上游的原始 4xx（非 502）。
  - **刻意收窄防过宽**：识别不出该语义的 4xx 仍按客户端错误直接返回，不去空跑整条链——例如 atria 自己的 400 `invalid_request "max_tokens must be an integer between 1 and 65536."`（09-15 实录）是确定性参数错误，换模型一样失败。
  - 回归测试 `scripts/test/upstream-side-4xx.mjs`（7 断言，mock 上游 + 隔离实例）：上游侧故障继续链拿到 200 / 兜底被实际调用 / 计入失败统计 / 整链全败透传原始 422 / **对照组**确定性 400 直接返回且兜底未被调用。反向验证：临时关闭该判定后 ①组 4 项失败（客户端重现拿到 422），恢复后 7/7。
- **测试套件每跑一次就把 live 配置的模型字段洗一遍（2026-09-18 排查发现，2026-09-17 22:56 实锤）**：`scripts/test/utils.mjs` 的 `snapshot()` 把每个模型压成 `{ provider, alias, fallbacks, maxConcurrent }` 四个字段，而 `saveConfig` 对 `body.models` 是**整体替换**（`body.models !== undefined ? body.models : cur.models`）——于是任何走「读-改-写」的测试（affinity / circuit / concurrency / empty-model / modelstats / payment-402 / qps / rate429 / stream-* / z-defaults-merge …）每跑一次都把 live 配置洗一遍：`reasoning` / `effortFormat` / `effortOptions` / `api` / `providerModels` / `maxTokensMax` / `qps` / `dailyQuota` / `quota` / `maxContext` / `probe` 全被清空（实测 6 个模型全中；配置文件 mtime 与跑测时刻逐秒吻合）。**后果最重的一例**：`union-alpha` 的 `providerModels: {openrouter: "stealth/union-alpha"}` 被洗掉后，网关改发 `union-alpha` 给 OpenRouter → 404 `No endpoints found for union-alpha`，把「模型已下线」的真实原因也盖住了（slug 修回后才拿到上游的真话：stealth 期结束、改用 `unbiased/pareto`）。现 `snapshot()` 改为**黑名单式逐字段回写**（仅剔除运行时统计字段 `name/requests/errors/tokens/today/hitRate/affinity/avgMs` 与 provider 的 `id/hasKey/keySource/st`），将来新增配置字段无需再改白名单。往返验证：修正后 `save(snapshot())` 前后 models 快照逐字节一致；全量跑测后 live 配置字段完好。
- **`/api/status` 对 models 已暴露全部配置字段**（`api`/`providerModels`/`effortFormat`/`effortOptions`/`reasoning`/`maxTokensMax`/`qps`/额度/上下文/`probe`/`forceNoStream`），是本次快照能做到无损回写的前提——与 0.2.2 对 `defaults` 的修法（原样返回）同源。
- **未知请求字段 `reasoning.effort`（客户端违约 + 网关零归一化，2026-09-17 生产实录 20 次）**：ZCode CLI 按 OpenRouter 惯例发**嵌套** `reasoning:{effort}`；网关此前既无入站字段归一化、也无出站白名单，未知字段一律原样透传——而 OpenRouter 认得该字段，所以打主上游的 685 次请求全部 200、把问题完全掩盖；一旦主上游 429/熔断、目录链兜底到**严格上游**（jiyuan/tokenrhythm，LiteLLM 内核按白名单校验字段）就 400 `{"code":"UNKNOWN_FIELD","message":"未知请求字段：reasoning.effort"}`。症状是「平时不报、只在兜底时炸」，且网关日志只记上游返回体、不记出站体，归因极难。现 `src/forward.js` 新增 `normalizeEffortInput()`：入站把 `reasoning.effort` 并入平面 `reasoning_effort`（客户端已显式给出平面字段时以平面字段为准），嵌套 `reasoning` 对象**一律剔除**（含 `summary`——OpenAI chat 协议无该字段位置，且它正是严格上游的拒绝点），"关闭思考"的同义拼写（`off`/`disabled`/`false`）统一归一到 **`none`**（`canonEffort`；白名单比较两侧同源归一，本地 `effortOptions` 里惯写的 `off` 与 `none` 视为同档）。归一事件落 `[warn] 思考强度入站归一化` 日志留痕。
  - **纠错（同日 23:19）**：首版把规范拼写成 `off`，结果 openrouter 回 400 `reasoning_effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"`——该词表里**没有 `off`、只有 `none`**。规范拼写改回 `none`；`THINKING_TYPE_MAP` 补 `none → disabled`（thinking 形态不受影响）。回归用例的 mock 上游**补上取值词表校验**（此前只校验"有没有嵌套 reasoning 键"，测不出"归一成上游不认的拼写"这类回归）：把方向改回 `off` 实测 5 项失败，改回 `none` 全绿。
- **潜伏项：思考强度字段形态只按链首模型决定，兜底换模型即形态错配（P1 实测项）**：`body` 是各路由共享的，此前在入口按「请求模型 / 链首模型」的 effortFormat 转换一次就定死——链首 `reasoning_effort`、兜底 `thinking`（`union-alpha → qwen3.8-flash`）时后者拿不到自己认的字段；反向（链首 thinking、兜底 reasoning_effort）则多送一个它不认的对象。当时未爆是因为平面 `reasoning_effort` 恰好被 openrouter / jiyuan 双方接受（直连实测两个上游对 qwen3.8-flash 均 200），属"配置没生效也不报错"的静默错配。现**字段形态下沉到每条路由**按目标模型自身 `effortFormat` 整形（取值不变：客户端显式档位 > 入口默认档位；两字段互斥，不共存于同一 body）。既有语义保持：虚拟模型 / 虚拟共用名入口仍"客户端没给档位就不注入"，真实模型入口仍注入配置默认档位。
- 回归测试 `scripts/test/effort-normalize.mjs`（18 断言，自包含 mock 上游 + 隔离实例）：嵌套归一为平面且出站无 `reasoning` 键、平面优先、仅 summary 剔除、三种关闭拼写归一、双向跨 effortFormat 兜底形态正确、虚拟入口不注入 / 真实入口注入 / 白名单本地拦截 / 客户端显式优先。
- **opencodego provider 注入 `x-session-id`（Linux 迁移后 zen/go 上游 400 MissingSessionID）**：opencode zen/go 上游对无会话头的 chat/completions 一律 400 `{type: MissingSessionID}`（Windows 时代直连也如此，dsh 走 /responses 不受影响；ownrag KB 网关经网关的 gatemodel 通道则必挂）。在 `gateway.local.json` providers.opencodego.extraHeaders 注入静态 `x-session-id: mg-opencodego-bridge`（buildHeaders 对 extraHeaders 的合并优先于客户端头，forward.js:45-46；静态会话仅影响上游按会话的路由亲和）。configVersion 112→113，重启生效；直连网关 mimo-v2.5 chat/completions 实测 200。备份 `gateway.local.json.bak-20260907-*`。


### Added
- **apiKeyEnv 用户级环境变量实时读取（绕过进程快照）**：进程 env 是启动时的副本——用户在系统里新增的 API key 变量（如 `BAI_API_KEY`）对已运行网关不可见，此前必须重启网关才能生效，且须连托盘一起重启（拉活的网关继承托盘旧环境）。现 `resolveKey` 在进程环境找不到时 fallback **实时查注册表 `HKCU\Environment`**（带 60s TTL 缓存：spawnSync 有毫秒级开销且在每请求路径上；正负值都缓存防高频空查；变量名白名单校验防注入），改完变量**最多 ~60s 生效**，无需重启任何东西。仅 Windows 生效（其他平台维持进程环境行为）。回归测试 `scripts/test/user-env-fallback.mjs`（注册表写入临时变量 → 进程环境无此变量 → 请求验证 Authorization 取到注册表值 → 自动清理）。
- **mg-tray 托盘小窗管理器**（`scripts/tray/mg-tray.cs`，Windows 自带 .NET Framework csc 编译为 ~24KB `mg-tray.exe`，零第三方依赖）：无边框置顶悬浮小窗（状态/uptime/今日 token/请求错误 + 启动/停止/重启/面板/日志按钮，可拖动、右键切置顶、✕ 缩托盘）+ 托盘常驻（双击唤出、菜单全套操作、崩溃 5s 退避自动拉活、连续快速失败 ≥5 次熔断）+「开机自启」开关（HKCU Run 键，免管理员）+ 启动前清端口残留 node（同 start.bat 语义，只杀 node.exe）；检测到端口已有 node 实例显示「外部实例/未接管」不重复拉起；数据面轮询 `/healthz` + `/api/status`（401 自动降级）。
- `scripts/tray/build.cmd`：一键编译（系统自带 csc.exe；ASCII-only 规避批处理 GBK 解析坑）。
- `scripts/test/z-defaults-merge.mjs`：defaults 合并保存契约回归（完整/面板式/无键/显式覆盖，7 断言）。
- `scripts/test/z2-noevent.mjs`：半死流看门狗回归（纯注释心跳流判死并回错误事件；注释+data 交替的健康流不误杀）。
- **悬浮窗四卡改版**（`8b32f36`）：右列三卡扩为四卡（上游/模型/词元/价格），卡内文字 10pt→8.5pt；**价格卡=当日全部使用模型的计费**——每 30s 读 `stats.json` 按模型日桶（in/hit/miss/out）× 上游实付价（`effective_pricing`，与平台账单一致；无折扣回落标价）按币种汇总（¥人民币/$美元，多币种 + 间隔），只计价表内模型（天然排除 VM 入口双计与无价上游）；每 10min 拉上游 `/v1/models` 价表（直连失败走 Clash 代理重试）。
- **托盘诊断文件**：每轮覆盖写 `logs/tray-debug.txt`（价表条目数/计费模型/cny/usd/BillText/最近异常），托盘问题无需截图即可核查。
- `scripts/tray/swap.cmd`：托盘换装脚本（杀托盘→`mg-tray.new.exe`→`mg-tray.exe`→启动；托盘重启会短暂重启其守护的网关）。

### Fixed

## [0.2.3] · 2026-08-29 —— 测试套件修正与文档口径同步

### Fixed
- **`rate429.mjs` 断言过时**：0.2.0 循环兜底后 429 排队对客户端透明——首请求在网关内按 `Retry-After` 等待并重发上游，最终 200；旧断言仍期待「首请求 502/429 + 次请求排队」的 0.2.0 前语义。现改为：首请求内部排队（耗时 ≥ Retry-After、上游恰 2 次命中）后成功，次请求冷却已过不再等待。
- **`acl.mjs` 崩溃修复**：`st` 是已解析的 status 对象却被当函数调用（`(await st())` → TypeError），deepseek-official 存在时整个文件 ERROR——改为重新拉取 status 并对字段缺失败的容错取值。
- **测试子结果计数隔离**：`results` 为套件级共享数组，virtual-models 结尾的子结果统计会把其它文件的失败算进自己头上误报 ERROR——改为按进入时基线取增量。
- **SSE 续传用尽时给客户端明确交代**：流式中断、续传 2 次仍失败时，`finalize` 此前只发 `[DONE]`（正常结束标记）——zcode 等 OpenAI 兼容客户端把「无输出的 [DONE]」当对话正常结束，直接静默收场，用户无感知。现先发 OpenAI 兼容**错误事件**（`type: "stream_interrupted"`）再发 `[DONE]` 收尾，客户端可据此显示错误提示而非静默。8/25 的 `16f770a` 只修了「续传被 end 掐断」，续传用尽后的客户端信号一直是缺失的——本次补齐。

### Changed
- README/CHANGELOG 口径同步：探活超时实为 `defaults.timeout.connectMs`（模板 15s，并非固定 10s）；分层超时表更新（转发建连阶段对齐 firstByteMs，connectMs 仅用于预热/探活）；0.2.1 补记同窗口的 TD1 测试沉淀 / TD2+TD3 重构条目。
- `package.json` 版本同步 0.2.3（此前长期停留在 0.1.0）。

## [0.2.2] · 2026-08-29 —— 主上游回切探活 + 缓存亲和有效期

### Added
- **主上游回切探活 `defaults.failbackProbe`**（默认开启 `{ everyMs: 30000, successStreak: 2, system: "ping" }`，仅降级中工作）：某模型当前由**备用上游**（`fallbacks`）服务时，按 `everyMs` 向主上游发最小探活请求（真实 chat、`max_tokens:1`、**不计额度**、超时取 `defaults.timeout.connectMs`），连续 `successStreak` 次成功后清除缓存亲和，下一个请求即回到主上游。解决「主上游恢复后无法及时回流」——此前只能等亲和过期、并靠下一个真实请求去试水（试水请求可能卡满整轮重试）。回切前**已验证可用**，真实请求不会踩到"刚恢复又挂"的雷；正常态（用主上游时）零开销、不发探活；主上游熔断中时跳过探活（交给熔断半开，避免打架）。
  - 探活**刻意不用** `/v1/models`：聚合平台常见「models 通、chat 挂」（平台健康、推理层过载），用 models 探活会误判为已恢复。
- **缓存亲和有效期 `defaults.affinityTtlMs`**（默认 `300000`，0 = 不过期）：请求成功后记住该模型最近一次成功用的上游并优先复用（保持厂商 prefix cache、降碎片化），超时应期后亲和失效、请求回到配置里的主上游，TTL 内不抖动。与回切探活互补——探活是主动回切（30s 粒度、验证后切），TTL 是被动兜底。
- 测试 `scripts/test/affinity.mjs`（亲和有效期 4 项）、`scripts/test/failback.mjs`（回切探活 4 项；把 `affinityTtlMs` 设为 1 小时以排除 TTL 干扰，确保验证的是探活本身）。

### Fixed
- **自定义 `defaults` 字段在任意一次配置保存后被静默丢弃**（如本次新增的 `affinityTtlMs`/`failbackProbe`，以及未来的任何扩展字段）：根因是 `/api/status` 只返回白名单内的 defaults 字段，面板/测试走「读-改-写」时未返回的字段被覆盖。现 `buildStatus` 的 `defaults` 改为**原样返回**（仅 `clientKey` 掩码）——一次修复覆盖所有自定义字段，无需再逐字段加白名单。
- **`/api/status` 不暴露 provider 的 `circuit`**：此前面板/测试保存配置会把手动配的熔断参数清成 `null`（同类问题）。现已暴露并在测试 `snapshot()` 中原样带回，熔断配置不再被吃掉。
- **回切探活请求格式修复**：探活此前复用 `warm()` 的 system-only 消息，被 LiteLLM 类网关（如 tokenrhythm/jiyuan）以 400 拒绝（`LITELLM_ERROR: messages 参数非法`）——探活从未成功，回切只能依赖亲和 TTL 兜底，且失败日志误报为 `preheat status`。新增 `probeChat()`（**user 角色**消息 + 独立 `failback probe` 日志文案），探活恢复工作，日志不再误导。
- **回切探活动作修复（清除亲和 → 亲和置为主上游）**：探活成功时此前仅 `delete affinity`，但无亲和时路由**退化为按缓存命中率排序**——缓存热的备用上游（opencodego）会把主上游（jiyuan）挤到后面，请求继续走备用（生产日志：3 次「主上游已恢复」后请求仍在 opencodego）。现探活成功直接把 `affinity` 置为主上游，利用现有亲和机制让主上游必然排第一，且探活自动停止（`cur === primary`）形成闭环。测试同步注入缓存命中率差异（备用 100% 命中、主 0%），复现「命中率路由反超」场景——原测试 cacheStat 为空会碰巧切回，掩盖该缺陷。

## [0.2.1] · 2026-08-27 —— 上游代理（proxy）面板化收尾

### Added
- **面板「网络代理」输入项**（「默认上游」卡）：`defaults.proxy` 全局代理可在面板配置（留空=直连，形如 `http://user:pass@127.0.0.1:7890`），保存即持久化——修复此前「面板一保存 `defaults.proxy` 即被丢弃、网关连不上 Clash」的反复现象。
- **`/api/status` 回显 `defaults.proxy`**：面板可读到当前代理配置。
- **保存校验**：`defaults.proxy` 非空时必须为合法 http(s) 代理地址，非法值 400 拦截（防垃圾值落到转发层）。
- **代理模式 `proxyMode`**（`auto` 默认 / `direct` / `global`，面板「代理模式」下拉）：auto=按配置（provider 级 > 全局 > 环境变量，显式关闭生效）；direct=全部上游强制直连；global=非回环上游全部强制走全局代理（回环豁免）。保存即热生效，不重启。
- **按上游代理名单**（面板「上游服务」编辑弹窗新增「代理」字段）：单上游 `proxy` 留空=继承全局；填 `http(s)://...`=强制走该代理；填 `direct`=强制直连（替代原 `""` 语义，空串现改为继承全局）。`/api/status` 回显 provider 级 proxy；保存校验（非法地址 400）。
- **思考强度参数格式可选 `effortFormat`**（面板模型弹窗「思考强度·参数格式」下拉）：`reasoning_effort`（默认，OpenAI 风格）/ `thinking`（MiniMax 风格对象）。客户端入口统一 `reasoning_effort`，网关按模型配置转换注入（thinking 格式转 `thinking:{"type":...}` 并删除 reasoning_effort）；虚拟共用名/虚拟模型入口透传链首真实模型格式。解决「MiniMax-M3 填 adaptive 不生效」——其官方认 `thinking` 对象而非 `reasoning_effort`。
- **Phase 1 验证矩阵沉淀为常驻 mock 集成测试**（`scripts/test/virtual-models.mjs`，18 项断言）：自起隔离实例 + mock 上游，零外部依赖、零真实上游消耗，纳入 `npm test`。

### Fixed
- 上游代理特性完整接通（代码 + 配置持久化 + 面板置项三件套齐备）：`src/router.js` 的 proxy 解析（provider 级 > defaults > 环境变量，回环直连）、`src/request.js` 的 CONNECT 隧道（零依赖）此前为半成品，仅实现了转发层读取；本次补齐 `saveConfig` 持久化与面板配置入口，消除「改配置生效、面板保存丢失」的分裂。
- **兜底被 403/404 截断**：此前目录链中某模型返回 403/404 会直接中断整个请求（不试后续模型），导致「MiniMax-M3 限流 429 → muse-spark 被 opencode 403 拒绝 → mimo-v2.5 根本没机会」——现改为 403/404（模型/资源级拒绝）记录后继续尝试下一模型；整条链都被拒绝时回最后一个上游原始响应（保留真实错误）且不进入循环兜底空转。400/401/422 等请求/鉴权类错误仍直接返回不兜底。
- **曲线 tooltip 显示 缓存命中/未命中/输出**：统计新增输入（inTokens）与输出（outTokens）单独记账（`usage.prompt_tokens`/`completion_tokens`，流式末帧无明细则记 0 不臆造），daily/hourly 桶与 byModel 持久化扩展；`/api/model-stats` 每个数据点返回 `inTokens/outTokens/hit/miss`；曲线图 tooltip 在模型名下方显示「缓存命中 · 未命中 · 输出」三个具体数字（命中+未命中=输入，满足恒等式）。模型统计面板不加字段。
- **分层超时语义修正**：响应头到达后由 connect 静默检测转 idleMs 空闲检测，建连阶段静默上限对齐 firstByteMs——思考型上游首 token 前长静默不再被更短的 connect 定时器误杀（mock 三场景验证）。

### Changed
- **forwardChain 域拆分至 `src/forward.js`**（deps 注入共享辅助，`todayKey` 入 `shared.js`），index.js 963→672 行；stats 历史保留窗口 90 天（daily/hourly 落盘时清理超窗键，防 stats.json 无界膨胀）。

## [0.2.0] · 2026-08-25 —— 韧性加固 + Phase 1 多虚拟模型

### Added
- **多虚拟模型（Phase 1 核心）**：`virtualModels[]` 配置，每个虚拟模型自带目录快照与独立 Key（`__mg_vm_*`，AES-GCM 加密存储）；`/v1/models` 聚合虚拟模型名；响应 model 名回写为入口名。
- **两阶段数据面鉴权**：全局 clientKey 一阶段放行（常规路径零开销）；失败且配置虚拟模型时按 `model` 逐 `__mg_vm_*` Key 常量时间校验（支持 `expiresAt` 过期）；统一 401 文案防虚拟模型名枚举；全局 Key 为管理员级超级 Key。
- **并发写安全地基**：`configVersion` 单调递增持久化，过期保存返回 409（缺 version 的旧客户端宽容放行）；`saveConfig`/`saveKeys` 写盘互斥队列；keys 写路径改为盘上重读合并，消除「复活已删 key」窗口。
- **可选 `MG_CONFIG_DIR`**：多实例隔离（开发/生产 keys·stats·local 独立成套），未设置时行为与旧版完全一致。
- **面板虚拟模型管理器**：右列折叠列表（名字/Key 徽章/过期标记/目录摘要）+ 展开编辑器（目录增删排序、独立 Key、过期时间、备注、额度/并发/QPS 五项、🔍 路由试算弹窗）。
- **路由试算端点** `POST /api/route-preview`：返回将命中的虚拟模型、目录链、上游序列与额度状态。
- **虚拟模型入口治理**：未知名返回 404（不再静默走默认链，防 Key 隔离被无感绕过）；入口总额度（quota/dailyQuota，独立账本）超限 429；maxContext 入口约束；链首真实模型 `effortOptions` 补本地校验（参数 400 先于额度 429）。
- **循环兜底**：整条目录链 a→b→c 一轮全败后回队首有界重试（`loopMs` 默认 120s），成功/失败均带 `chain=` 链标记日志。
- **SSE 下游截断加固**：客户端断开主动销毁上游流（杜绝连接泄漏）；续传链完整等待（修复「对话直接中断」）。
- **文档体系**：分阶段执行计划（Phase 1-3 + 技术债清理）、项目上下文交接文档、Phase 1 详细实施计划（含连锁风险分析）、CHANGELOG。

### Fixed
- 曲线图两轮修复：隐藏面板首绘固化错误位图（隐藏态守卫 + 切视图/resize 重绘）；数据接口误用未赋值的 `window.TOKEN` 致 401 空白（改用登录令牌）。
- 模型探针超时 30s→90s：思考型模型响应 5s~90s+ 波动不再误报 ETIMEDOUT。
- 非流式响应日志 `serving` 字段显示入口名（缺字段），修正为实际服务模型。
- 虚拟模型编辑器轮询闪烁：3s 轮询重绘导致独立 Key 输入丢字——编辑中跳过重绘 + Key 输入草稿恢复。
- 不稳定上游下的兜底健壮性（503 重试、坏 gzip、慢上游不饿死兜底、流中断计数绕开）。

### Changed
- 面板 KPI 大卡改读持久化口径（消除重启后与全局统计的数字分裂）；模型配置页改纵向滚动（卡片不再被固定高度挤压）。
- 「默认上游」卡：客户端 Key 与虚拟共用模型名位置交换。

## [0.1.1] · 2026-08-24 —— 面板与统计完善（初始化日迭代）

### Added
- 缓存降碎片化体系：会话/上游亲和、命中率路由、主动预热、命中率趋势告警。
- 按对话统计（会话 ID 优先 / 5 分钟兜底切分）、模型级平均延迟、p50/p95。
- 面板：管理令牌门禁（登录卡片 + 实例记忆）、上游/模型单测与统测、模型目录模板（保存/应用/删除）、批量测试。
- 健壮启动：`start.bat` 自动清理占用 8787 的残留进程；请求级日志（含 serving/provider）。
- 数据面 Chat 入口路径别名：Base URL 不带 `/v1` 也能接入。

### Fixed
- 缓存命中率恒 100% 的统计错误（按协议官方字段精确分桶）。
- 虚拟共用模型名透传上游导致 `Model not supported`（改走默认目录真实模型）。
- `start.bat` 行尾 CRLF + 去 BOM（恢复双击运行）。
- 曲线图按实际显示尺寸与 DPR 初始化（修复拉伸与 tooltip 错位）。
- dialogue 持久化、全局/provider 计数持久化（重启不归零）、面板输入不再被自动保存/轮询重绘打断、模型单测后延迟标记消失、测试套件错误隔离（不再整次硬崩溃）。

## [0.1.0] · 2026-08-24 —— 项目初始化

- 本地 OpenAI 兼容 API 网关首版：Node 原生 http 零依赖，Chat 转发 + 分层超时（connect/firstByte/idle/overall）+ 指数退避重试 + 熔断 + 每上游并发/QPS 限制 + SSE 断流续传 + 三协议互转（OpenAI ⇄ Anthropic ⇄ Gemini）+ AES-GCM Key 加密存储 + 赛璐璐风格控制面板。
