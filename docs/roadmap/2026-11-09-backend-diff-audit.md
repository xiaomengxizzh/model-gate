# 后端能力差异审计（2026-11-09）

范围：`dev/gateway-audit-20261108`（下称 **audit**）与 `dev/gateway-g0-g4-20261107`（下称 **g0g4**）的逐能力对照。`dev/gateway-hardening-20261107` 已是 audit 的祖先，不重复列；`feature/codex-opencode-go-adapter-20261107`（PR #2）作为旁路实现单独评估；新前端分支只作为 audit 的 UI 增量。

依据：本仓库源码、两个分支的 `git show`/diff、离线测试与 2026-11-09 验证报告。**历史文档不作为“当前已通过”证据。**

风险等级：低=有回归且语义清晰；中=有回归但边界依赖上游/客户端；高=可能重复计费、危险重放或协议失真，需所有者决策。

| 功能 | 所属分支 | 已知问题 | 实现差异 | 测试证据 | 保留方案 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI Chat Completions | 两者 | 无重大分叉 | 基本同源；g0g4 另加 attempt budget | `wire-format`、`upstream-side-4xx`、`stream-*` | 保留 audit | 低 |
| Responses API | 两者 | audit 早期拒绝真实客户端 `include`；g0g4 把 namespace 展开为函数（伪保真） | audit：Chat 桥 + `models.api="responses"` 原生透传；g0g4：独立一等入口 | `responses-mapping/endpoint/native`；DSH mock 3 路径 | 保留 audit，显式丢弃不可表达工具并记 lossy | 中 |
| OpenAI/Anthropic/Gemini/Cohere 转换 | 两者 | 有损字段清单需持续维护 | 同源 `format.js`；g0g4 改动较小 | `wire-format` 22 例 | 保留 audit | 低 |
| Codex CLI/Desktop、DSH、OpenAI 兼容客户端 | audit / PR #2 / g0g4 | Codex 0.167 只支持 `wire_api="responses"`；Chat 桥丢托管工具；Desktop 未被 CLI 测试覆盖 | audit 在桥内丢弃并记录；PR #2 旁路 `forwardChain`；g0g4 展开 namespace | audit 历史真实链路；本轮 DSH mock 3 路径；Codex 本机 BLOCKED | 保留 audit 统一入口；不合并 PR #2 | 中 |
| 真实模型 / 别名 / 虚拟模型 | 两者 | 虚拟模型未知扩展字段被 `cleanVms` 丢弃 | 同源；g0g4 无额外能力 | `virtual-models`、`model-resolution`、`ui-contract` | 保留 audit，UI 不声称保留未知虚拟字段 | 中 |
| Provider 优先级 / fallback / 故障恢复 | 两者 | 429 曾被当故障熔断；流式断流重连对工具请求可能重发 | audit 用熔断+目录链；g0g4 加 429 冷却与 attempt budget | `failback`、`circuit`、`retry-governance` | audit 链 + 移植 429 冷却语义 | 中 |
| 429 / Retry-After / 重试预算 / 超时 / 熔断 | 两者 | **audit 把 429 吞成 502 并 markFail**；多层重试可能放大 | g0g4 有归因、预算等待、`noRetry429`；audit 有统一 deadline/取消 | `retry-governance` 11 例；旧 `rate429` 2/2 | 移植 g0g4 归因/等待/不熔断；保留 audit 预算 | 中 |
| 非幂等（工具）请求重放 | g0g4 | 整链禁用 fallback 会伤 Codex/DSH 可用性；断流重连仍有重发窗口 | g0g4 一轮即止；本轮改为“同上游一次 + 整链一轮” | `retry-governance`（tool fallback/不重放/不回队首） | 采用折中策略，记录取舍 | **高** |
| SSE 事件流 / 工具调用语义 | 两者 | Chat 桥无法表达 hosted tools；SSE 错误状态不得转成功 | audit 有续传/背压/预算；g0g4 另有 wire 维度 | `stream-failover`、`deadline`、`responses-native` | 保留 audit；原生 Responses 保真 | 中 |
| 额度 / 并发 / QPS / 请求预算 | audit | 额度是软限制；并发/QPS 与预算相互作用复杂 | g0g4 另建 attempt budget，易与 audit budget 叠加 | `boundary`、`concurrency`、`qps`、`deadline` | 只保留 audit 一套预算，不引入第二套 | 低 |
| API Key 加密 / 管理权限 / 配置版本 | 两者 | `/api/keys` id 白名单历史缺口；投影曾漏虚拟元数据/clientKey | audit 已补白名单、加密落盘、409；g0g4 基本同源 | `admin-*`、`config-schema`、`ui-contract` | 保留 audit + 投影修复 | 低 |
| 日志 / 统计 / 健康 / 诊断 | 两者 | 无按状态码持久化；`extraHeaders/proxy` 仍回显原值（鉴权后） | g0g4 有 redact/status matrix；audit 有日志脱敏与容量裁剪 | `logger-secrets`、`metrics`、`lifecycle` | 保留 audit；UI 派生分类并标注 | 中 |
| Embeddings / Rerank / 图片 / 音频 / 视频 | audit | 只有 Mock 回归；内联链 429 仍 markFail；真实上游未验收 | audit 已有全套入口；g0g4 无对应实现 | `embeddings`、`rerank`、`media`、`video` | 保留并标“实验”；429 统一列为后续卡 | 中 |
| 管理 API 契约 / 持久化 | 两者 | v1 未冻结；`defaults` 合并且无法删除字段；备份/恢复无 API | audit 有只读投影/save/409/墓碑；g0g4 有契约草案 | `admin-contract`、`config-projection`、`ui-contract` | 保留 audit；契约矩阵化，冻结待所有者 | 中 |

## 结论

- **只整包合并一个分支**会丢能力或引入旁路：audit 是主体，g0g4 只取 429 治理，PR #2 不合并。
- 高风险项集中在“非幂等重放”和“Chat 桥工具保真”，已用显式策略与日志暴露，不伪装完整兼容。
- 真实上游 429/5xx、Codex CLI/Desktop、DSH 工具调用、媒体真实上游仍是候选版合并前的阻断项。
