# ModelGate V2 集成证据（2026-11-15，P00–P04 离线实现）

> 本文件记录 **本轮代码与离线证据**，不构成任何真实上游验收。真实 Codex Desktop / GPT / Go 验收见各状态表与 A5 独立证据。
> 被测树以每次提交的 commit SHA 为准；换树即失效。

被测树 SHA：`2f91e53`（V2 门禁迁移 + A1/A2/A4 集成后的 Lead 集成提交；A3/A5 合入后的最终 SHA 见 `git log`）

## 1. 已实现（代码事实）

| 切片 | 交付 | owner 提交 |
| --- | --- | --- |
| V2 门禁 | `aggregation-matrix-v2.js` / `aggregation-gate-v2.js` / `aggregation-acceptance-v2.test.mjs`；V2 计划 §2.1 冻结映射；`npm run gate:v2` | Lead（V2-00）|
| 原生压缩协议 | `codex.nativeCompaction` 三值闸门；`history.compaction:"preserve"` 仅对声明支持的路线原样透传，否则 `native_compaction_route_not_ready/_mismatch/_malformed` typed 拒绝；`context_compaction` 显式分类；目录暴露 `auto_compact_token_limit`（`auto_compact_token_limit_exceeds_context` 拒绝） | A1（V2-04）|
| Go 单模型 | Provider preset、`v2Scope=go-single-model`、目录只发布 `deepseek-v4.1-flash`、越界模型 outOfScope 诊断、跨供应商 fallbacks 目录层 fail-closed、readiness/failurePolicy typed code | A2（V2-02）|
| Desktop 一键聚合 | 原版 Desktop/捆绑 Codex 版本文件探测、写前预览/consent/428、备份+原子写+写后校验+回滚、重启判定（/proc 启动时间）、退出只撤销自有键并保留用户后改、provider 级 `remote_compaction="unsupported"` 声明（reserved `openai` 身份拒绝） | A3（V2-01）|
| 订阅与安全 | 授权域终态归因（401/402/403/配额型 429 按真实域返回，不再吞成 502）、跨授权域 429 回退阻断、请求身份含 model、SSE 连接级单一终态、凭据来源域租约（订阅 token 不跨域） | A4（V2-03）+ Lead 接线 |
| 门禁反绕过 | 审计保护 V2 计划/门禁/矩阵文件并新增 `gate-weakened`；V2 门禁默认被测树取 `git rev-parse HEAD`（fail-closed）；矩阵对旧树 PASS_REAL 标注绑定树 | Lead（A5 F1/F2/F4）|

## 2. 本机事实取证（只读，未改真实配置、未发起模型调用）

- 原版 Desktop：`/usr/lib/chatgpt/ChatGPT`，产品版本 `26.1103.32239`（`resources/linux-package-metadata.json`）。
- 捆绑 Codex CLI：`/usr/lib/chatgpt/resources/codex --version` → `codex-cli 0.167.0-alpha.3.2`；本机另有 `/home/xiaomengxizi/ai/harness/codex/cli/versions/0.167.0`。
- 压缩路径选择：provider 级 `ModelProviderCapabilities{cyber_access_programs, external_web_access, remote_compaction}`（类型 `RemoteCompactionSupport`）。
- TOML 落点（A3 在隔离 `CODEX_HOME=/tmp` 用该二进制 serde 解析器实测，非猜测）：
  `[model_providers.modelgate.capabilities] remote_compaction = "unsupported"`，枚举仅 `unsupported` | `v2`；
  `remote_compaction = false` 报 `invalid type: unit variant, expected string only`；
  任何 `[model_providers.openai*]` 被拒：`model_providers contains reserved built-in provider IDs: openai`。
- 未验证：`requires_openai_auth = true` 的 managed provider 在运行时能否复用 ChatGPT 登录（UNVERIFIED，需真机）。

## 3. 本轮执行的离线命令与结果（集成树）

```bash
npm run check                     # PASS（UI modules 17/17）
npm test                          # 108 suites / 1068 tests / 0 fail / 2 skipped（A1/A2/A4 合入后）
node scripts/check-metadata.mjs   # PASS（39 checks）
npm run docs:check                # PASS
npm run contract:check            # PASS（12 requirements / 7 stages / 5 roles）
npm run gate:v2                   # 9 条自证全部 PASS
node --test scripts/test/offline/aggregation-v2-independent-qa.test.mjs   # 11/12（N04 见 §5）
```

## 4. 未执行（不得声称通过）

- 真实 Codex Desktop 模型选择器、真实 ChatGPT 套餐请求、真实 OpenCode Go 推理：**BLOCKED**（无所有者额度/时间窗授权）。
- Codex 原生压缩真实事件、压缩后同一子代理续跑/追派/中断/恢复：**BLOCKED**（同上）；离线协议侧仅为 `PASS_MOCK`。
- managed provider 身份切换后的运行时登录复用：**UNVERIFIED**，默认关闭（保持内置 openai 身份）。
- GPT 真实测试只允许 `gpt-6-luna`；本轮零 GPT 调用。

## 5. 待所有者裁决

**N04（摘要导出）**：`src/codex/history.js` + `/api/codex/history/export*` 是用户显式触发的**迁移导出**（写独立文件、原件不变、不参与任何模型请求组装，已加守卫断言）。A5 独立门禁按 V2 契约“网关不得自建 summarize”的绝对条款判 FAIL，因为契约与 V2 状态均无所有者书面豁免。两条出路，需所有者选择：

1. 保留但书面豁免（在 V2 状态文档登记「所有者批准的例外」）；
2. 移除该可达导出路径（删除/禁用路由与模块能力）。
