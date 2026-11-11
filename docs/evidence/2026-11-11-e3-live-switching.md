# E3 验收证据：同线程 GPT → 第三方 → GPT（2026-11-11）

> 基线：`dev/codex-aggregation-20261111`（= `ec66b24`，Draft PR #5 head）
> 环境：Codex CLI 0.167.0（vendor 二进制）；隔离 `CODEX_HOME`（官方登录副本，权限 600，测试后删除）；ModelGate 隔离实例（临时 MG_CONFIG_DIR、动态回环端口）。
> 上游：第 1/3 轮 = **真实 chatgpt.com 官方后端**（用户已授权）；第 2 轮 = **本地 mock 第三方**（零真实费用）。

## A. 真客户端 + 真官方后端 + 同线程双向切换（scripts/test/codex-live.mjs）

```text
CODEX_HOME=<temp> node scripts/test/codex-live.mjs
PASS  LIVE turn1 官方真实请求 exit 0
PASS  LIVE turn1 有 assistant 输出（agent_message: LIVE_OFFICIAL_OK；usage input 21,849 / cached 12,288 / output 8）
PASS  LIVE turn1 thread id 01a1c920-…
PASS  LIVE turn2 同线程切第三方 exit 0（mg-third-deepseek-v4-flash → 本地 mock）
PASS  LIVE turn3 同线程切回官方 exit 0
5/5 live checks passed
```

结论：**M1 的"同一新会话可选官方 GPT 与第三方模型并来回切换"在真实官方账号 + 真实客户端下成立**。
同线程切换不再出现 `modelProviderMismatch`——因为两边都在 Codex 内置 openai provider 身份内，网关按模型选择官方/第三方上游。

## B. 全离线复验（scripts/test/codex-e2e.mjs，夹具上游）

```text
9/9 checks passed
turn1 官方模型 → 官方 mock 收到 authorization + chatgpt-account-id
turn2 同线程 mg-third-* → 第三方 mock 收到 0 个官方专用头（authorization/chatgpt-account-id/session-id/thread-id/x-codex-*/openai-beta 全部缺失）
turn3 同线程切回官方 → 官方 mock 再次收到
```

## C. 本次修掉的三个真实阻断（不是 mock 假象）

1. **内置 openai 不能被 `model_providers.openai` 覆盖** → 只用顶层 `openai_base_url`（E0/E6 已固化）。
2. **`GET /v1/models?client_version=…` 必须是 `{models:[ModelInfo…]}`**：旧 `{object:'list'}` 让 Codex 在 resume 时报 `failed to decode models response` 并失败。现由 `cfg._codexCatalog`（E2 目录）提供，启动与热重载同源注入。
3. **resume 切换模型会带控制项 `configuration_update` / `additional_tools`**：Chat 桥原实现整条 400。现显式丢弃并记 `lossy: input_dropped:<type>`（不是用户内容，不伪造），由 `offline/codex-control-items.test.mjs` 锁定。

## D. 边界 / NOT_RUN

- WebSocket 传输：网关回 404 让客户端回落 HTTPS（实测日志 `unexpected status 404 → Falling back from WebSockets to HTTPS`）；WS 代理未实现。
- Desktop 同会话切换：NOT_RUN（Desktop 打包 app 的 `openai_base_url` 配置与单实例行为未验证）。
- 官方订阅流量经本地网关的**条款/政策**边界：HANDLED-BY-OWNER（用户已明确授权本轮真实测试；产品化发布前仍需单独合规结论）。
- 第三方真实付费上游：本轮第三方轮用本地 mock；真实 OpenCode Go 付费链路已在 2026-11-09 证据中验证文本往返，聚合模式下的真实第三方轮标 NOT_RUN（可随时用同一脚本替换 provider 复测）。
