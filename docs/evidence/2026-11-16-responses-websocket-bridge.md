# Responses WebSocket 桥接交付与回退说明（2026-11-16）

## 基线 / 分支 / 提交

- 分支：`feat/responses-ws-bridge-20261116`
- 基线：`5ab1a517a7ea498b018a619e39e527841cc89cc7`（`fix/modelgate-remediation-20261116`，已交付树）
- 实现提交：`d6e01f1`（本文件所在提交为证据提交）
- 生产工作树 `/home/xiaomengxizi/ai/workplace/idproject/model-gateway`（`deploy/modelgate-ux-v3`）**未改动、未部署**。

## 需求映射

- 对应问题：通用 Codex（`model_provider = "openai"` + `openai_base_url`）首轮 `Reconnecting 1/5…5/5`（7 次 upgrade 尝试）。
- 上游定性：`openai/codex#27381`（含 #28503 重复）；内置 `openai` provider 的 `supports_websockets` 被保留 ID 守卫拒绝覆盖，`[features] responses_websockets=false` 已被移除且静默无效；自定义 provider 虽可关闭 WS，却把 thread 按 provider id 标记，导致 `resume --last` / 选择器丢历史。
- 本变更不新增或改写产品契约 `MG-R001–MG-R012`，只为既有 Responses 入口**增加一条与 HTTP 等价的 WS 传输入口**。

## 真实行为变化

1. `POST /v1/responses` 能力不变：所有模型路由、工具调用修复、鉴权、计费链路保持原样。
2. 新增 `GET /v1/responses`（及 `/responses`）的 WebSocket 升级：握手前完成 Host/Origin 来源校验，返回 `101 Switching Protocols`。
3. 每个 `response.create` 帧被重放进**同一进程**的 `POST /v1/responses`；上游收到的请求与 HTTP 模式一致，WS 握手头（`upgrade`、`connection`、`sec-websocket-*`）与逐跳头绝不转发。
4. SSE 事件按原 JSON 文本逐条作为 WS `text` frame 发出；终止事件为 `response.completed` / `response.failed` / `response.incomplete`。`generate:false` 本地预热（零上游调用）、`response.processed` 确认、`response.interrupt` 中止在途轮次。
5. 原"WS 升级返回 404"分支保留为兜底：配置 `server.responsesWebSocket = false` 时不挂载 upgrade 监听，回到旧行为。

**未做（明确边界）**：不实现另一套 Responses 协议；不自建 compaction/summarization；不改 `~/.codex/config.toml`；不切 named provider；不动 auth.json；不把升级帧头或凭据送给第三方上游。

## 测试证据（真实执行）

- 新增 `scripts/test/offline/responses-ws-bridge.test.mjs`（6/6 PASS）：握手 101、SSE→WS 逐帧、握手头隔离、`generate:false` 零上游、同 socket 续轮完整 input 重放、`response.interrupt` 真中止、内部 POST 401 以 error 帧回传、回滚开关、非法帧处理。
- 更新两个陈旧断言（旧行为"升级必须 404"）为 101 握手 + 零上游命中：`codex-identity.test.mjs`、`codex-official.test.mjs`（20/20 PASS）。
- 全量：`npm test` 128 suites / 1237 tests PASS / 0 failed / 3 skipped；`npm run check`、`contract:check`、`docs:check`、`gate:v2`、`gate:v2:independent`、`gate:audit-diff` 全 PASS。
- **未验证**：真实 `gpt-6-luna` 长会话（含 compaction 与父子代理）下的端到端重连消失。需所有者另行授权预算/时间窗后跑 `codex-e2e`；本轮不把 mock 记为真实通过。

## 回退方案（三档，按影响从小到大）

1. **配置回退（秒级，无需改代码）**：在网关 `gateway.json` 的 `server` 段加 `"responsesWebSocket": false`，重启网关。upgrade 监听不挂载，恢复"WS 升级 404 → HTTP 回落"旧行为。
2. **代码回退（分支级）**：从 `fix/modelgate-remediation-20261116`（`5ab1a51`）重新部署生产 `src/index.js`、`package.json`、`scripts/test/**`，不部署 `src/responses-ws.js`。生产工作树当前与该基线一致（未改动）。
3. **Git 回退**：`git revert d6e01f1`（本证据提交单独 revert 或直接删除）；不触碰 `main` / `deploy/modelgate-ux-v3`。

## 风险与待办

- WS 帧大小上限复用 `server.maxBodyBytes`（默认 32 MiB）；与 HTTP 入口一致，超大 compact 历史同样受限，无新增回归。
- 升级阶段未实现 `permessage-deflate`（官方可选）；不影响功能。
- 非流式 200 响应会合成为 `response.created` + `response.completed`；Codex 实际总是 `stream:true`，该分支仅作健壮性兜底。
- 真实付费模型验收仍为 BLOCKED（未授权），保持诚实状态。
