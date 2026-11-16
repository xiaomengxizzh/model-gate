# Responses WebSocket 桥接交付与回退说明（2026-11-16）

## 基线 / 分支 / 提交 / 部署

- 分支：`feat/responses-ws-bridge-20261116`（已推送 `origin/feat/responses-ws-bridge-20261116`）
- 基线：`5ab1a517a7ea498b018a619e39e527841cc89cc7`（`fix/modelgate-remediation-20261116`，已交付树）
- 提交链：
  - `d6e01f1` WS 桥主体（握手 + 帧解析 + 重放进 POST + SSE 回帧 + 回滚开关）
  - `1a685b0` 交付/回退说明
  - `53d886d`→`2f9ff2c`→`b5af929` 真机暴露的订阅后端参数剔除（`previous_response_id`、`access_programs`、`prompt_cache_key`）
  - 末次提交：SSE 正文嗅探（content-type 误标修复）+ status 门禁 + 测试加固
- **部署状态**：已部署到生产网关 8787，由 systemd user 单元 `model-gateway.service`（`Restart=always`）托管。
- **通用 GUI 身份保持不变**：`~/.codex/config.toml` 仍为 `model_provider="openai"` + `openai_base_url="http://127.0.0.1:8787"` + `model="gpt-6-luna"`；未切 named provider，未改 `auth.json`（sha `de7cc6e…` 未变）。

## 需求映射

- 对应问题：通用 Codex（`openai_base_url`）首轮 `Reconnecting 1/5…5/5`（7 次 upgrade 尝试）。
- 上游定性：`openai/codex#27381`（含 #28503）；内置 `openai` provider 的 `supports_websockets` 被保留 ID 守卫拒绝覆盖，`[features] responses_websockets=false` 已移除且静默无效；自定义 provider 会把 thread 按 provider id 标记，导致 `resume --last` / 选择器丢历史。所有者否决"切 named provider 换无重连"。
- 本变更不改写产品契约 `MG-R001–MG-R012`，只为既有 Responses 入口增加一条与 HTTP 等价的 WS 传输入口。

## 真实行为变化

1. `POST /v1/responses` 能力不变：模型路由、工具修复、鉴权、计费链路原样。
2. 新增 `GET /v1/responses`（及 `/responses`）的 WebSocket 升级：握手前 Host/Origin 校验，返回 `101`；WS 帧头与逐跳头绝不转发上游。
3. 每个 `response.create` 帧重放进**同一进程** `POST /v1/responses`，复用同一鉴权/路由/工具修复链路。SSE 事件按原 JSON 文本逐条作为 WS text frame 回传。
4. 预热帧（帧内 `generate===false`）本地应答、零上游调用；`request_kind=prewarm` 的 header 在真实轮次也会出现，**不能**用于判定（曾误判导致 0 tokens，已修正为仅看帧内 `generate`）。
5. `response.processed` 确认、`response.interrupt` 中止在途轮次。
6. 关键真机修复：订阅后端 `chatgpt.com/backend-api/codex/responses` 不接受 `previous_response_id` / `access_programs:null` / `prompt_cache_key`，在 `patchSubscriptionRequestBody` 发往订阅前剔除（第三方路径仍严格 nativeGate，不放宽）。
7. 关键真机修复：网关某些 Responses 路径把 SSE 字节标成 `application/json`。WS 桥按**正文前缀**（`event:`/`data:`）嗅探，不被 content-type 误标欺骗；非 200 状态一律不回 `response.completed`。
8. 回滚开关：`server.responsesWebSocket = false` → 不挂载 upgrade 监听，回到"WS 升级 404 → HTTP 回落"旧行为。

## 测试证据（真实执行）

- `scripts/test/offline/responses-ws-bridge.test.mjs`（7/7 PASS）：握手 101、SSE→WS 逐帧、头隔离、`generate:false` 零上游、同 socket 续轮、`response.interrupt` 真中止、401 error 帧、回滚开关、非法帧、SSE 正文嗅探、`application/json` 误标不产生 completed。
- `codex-official.test.mjs`（7/7 PASS）：订阅后端参数剔除、第三方仍严格拒绝、官方 WS 握手零上游命中。
- 全量：`npm test` **128 suites / 1240 tests PASS / 0 failed / 3 skipped**；`npm run check`、`contract:check`、`docs:check`、`gate:v2`、`gate:v2:independent`、`gate:audit-diff` 全 PASS。
- **真机验收（通用 GUI 身份，`codex exec -m gpt-6-luna`）**：
  - `Compute 2+2…Reply with ONLY the single digit: 4` → EXIT=0，输出 `4`，**0 次 reconnect**，无 error 帧（25s）。
  - 修复前对照：同一命令反复 `Reconnecting 2/5…5/5` + `Falling back from WebSockets to HTTPS`（502），已消失。
  - 上游偶发的 `localhost:9001/mcp/stream`（penpot MCP）报错与 ModelGate 无关，不影响推理。

## 回退方案（三档）

1. 配置回退（秒级）：网关 `gateway.json` 的 `server` 段加 `"responsesWebSocket": false`，`systemctl --user restart model-gateway.service`。恢复"WS 升级 404 → HTTP 回落"旧行为。
2. 代码回退：从 `5ab1a51` 重部署 `src/index.js`、`src/responses-ws.js`、`package.json`、`scripts/test/**`。
3. Git 回退：`git revert <末次提交>…d6e01f1`；不触碰 `main` / `deploy/modelgate-ux-v3`。

## 边界 / 已知项

- WS 帧大小上限复用 `server.maxBodyBytes`（默认 32 MiB），与 HTTP 一致。
- 未实现 `permessage-deflate`（官方可选）；不影响功能。
- 真机长会话（含 compaction / luna→DeepSeek 父子派单）本次未重跑；此前 HTTP 模式证据仍有效，WS 桥对每条 create 帧走同一 POST 链路，不改变父子语义。
- 所有「上游失败」均如实回 error 帧，绝不伪造 `response.completed`；mock 未记为真实通过。
