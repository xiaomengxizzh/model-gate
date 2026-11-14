# 本地 MCP ↔ UHR 委派契约 v1（M5-2 / T-AGENT-02）

状态：**mock 契约已交付**。实现 `src/mcp/uhr-adapter.js`（边界校验）+ `src/mcp/uhr-mock.js`
（进程内 mock UHR，落盘任务表），验收 `scripts/test/offline/mcp-uhr-contract.test.mjs`（15 项）。

> **这是 mock 契约验收，不是真实 UHR 验收。** 真实 UHR 集成 = **NOT_RUN**：
> 需要读到现行授权接口、确认写集后另开分支。本卡只交付适配器边界、mock 与契约。

## 1. 术语

| 名称 | 含义 |
| --- | --- |
| connectionIdentity | 一次 MCP 连接携带的身份：caller/scope/到期/只读意图/引用种类/工具范围/预算上限 |
| taskRef | mock UHR 生成的任务引用（`task-<20hex>`），跨重启稳定 |
| scoped grant | 允许他人读取/取消某个 taskRef 的授权（`task_<24hex>` token） |
| refs | 不透明引用 `{kind, ref}`：只传"引用什么"，不传内容 |

## 2. 工具

| 工具 | 作用 | 归属要求 |
| --- | --- | --- |
| `uhr_delegate_task` | 委派一个只读任务 | 需要授权的 connectionIdentity |
| `uhr_get_task_result` | 读任务状态/结果 | 拥有 taskRef 或 scoped grant |
| `uhr_cancel_task` | 取消任务（幂等） | 同上 |

`toolDefinitions()` 只暴露契约字段：`readOnlyIntent`（枚举只有 `read_only`）、`budgetMicro`、
`currency`、`timeMs/deadlineAt`、`toolScope`、`summary{title,goal,tags}`、`refs[{kind,ref}]`、
`parentRef`、`idempotencyKey`。多一个字段都不接受。

## 3. connectionIdentity（授权边界）

```js
{
  callerRef, scopeRef,                 // 必需；缺失 ⇒ UHR_REJECT_IDENTITY
  authorized: true,                    // 必需；false ⇒ UHR_REJECT_SCOPE
  expiresAt,                           // 必需；<= now ⇒ UHR_REJECT_SCOPE
  currency: 'USD',                     // 必需；决定预算币种，不做换算
  allowedIntents: ['read_only'],       // 默认只允许只读
  allowedRefKinds: ['file','doc','issue','commit','symbol'],
  allowedToolScope: ['read_file','search','list_dir'],
  maxBudgetMicro,                      // 缺省用策略上限
  grants: ['task_<24hex>']             // scoped grant 列表
}
```

### 3.1 信任边界（必读）

adapter 假定 `connectionIdentity` 由**已验证的传输层/调用方**注入（例如本地 MCP 服务器在建立连接时
按已认证的会话构造）。adapter 只校验这个对象的形状与授权字段，**不重新认证它**：
任何"让模型或工具参数控制 `connectionIdentity`"的接线都会绕过本模块的全部边界检查
（模型只能提供 tool arguments，绝不应能提供 identity）。

## 4. 委派请求（只允许有界摘要 + 不透明引用）

```js
{
  readOnlyIntent: 'read_only',
  budgetMicro: 100000, currency: 'USD',
  timeMs: 60000,                       // 或 deadlineAt
  toolScope: ['read_file'],
  summary: { title: '≤200', goal: '≤500', tags: ['≤10 个标签'] },
  refs: [{ kind: 'file', ref: 'src/routing/decision.js' }],
  parentRef: 'task-parent-1',          // 上级任务的不透明 id
  idempotencyKey?: 'k-1'               // 缺省由 toolCallId 派生
}
```

**绝不转发**：对话正文 / 工作区内容 / 绝对路径 / 密钥 / 内联正文 / v2 密文。
实现上不是"尽力裁剪"，而是**明确拒绝**（超长标题除外，按契约裁剪并标
`summaryTruncated: true`）：

| 输入 | 结果 |
| --- | --- |
| 顶层多出字段（如 `messages`/`transcript`/`workspacePath`） | `UHR_REJECT_SHAPE`（details.field） |
| `summary` 里出现绝对路径 | `UHR_REJECT_SHAPE`（reason=absolute_path） |
| `summary` 里出现 `sk-…`/Bearer/api_key/password | `UHR_REJECT_SHAPE`（reason=secret） |
| `summary` 多行（粘贴的对话正文） | `UHR_REJECT_SHAPE`（reason=multiline） |
| 摘要超过硬上限（默认 `summaryMaxBytes=1024` 字节；或 title>200 / goal>500 / tags>10 或单标签>40） | `UHR_REJECT_SUMMARY_TOO_LARGE`（默认**拒绝，不裁剪**） |
| 引用带 `content/body/text/patch` 等内联正文 | `UHR_REJECT_REFS`（details.field） |
| 引用是绝对路径 / 含 `..` / 带凭据 URL / 种类不在白名单 | `UHR_REJECT_REFS` |
| 任何字段藏 `encrypted_content`/`encrypted_task_id`/`opaque_v2` | `UHR_REJECT_V2_OPAQUE`（跨域前拒绝，绝不解密） |

`parentRef` 只接受不透明 id 形状（`[A-Za-z0-9_.:-]{1,128}`），不接受路径。

### 4.1 摘要硬上限：默认拒绝，不裁剪

- 硬上限：`summaryMaxBytes = 1024`（UTF-8 字节，按 canonical JSON 计）**且**字段上限
  `title ≤ 200` / `goal ≤ 500` / `tags ≤ 10`（单标签 ≤ 40）。
- 超过任一上限 ⇒ `UHR_REJECT_SUMMARY_TOO_LARGE`（`details.reason = 'total_bytes' | 'field_length'`），
  **拒绝且零提交**（不产生 taskRef、executions 不增）。默认**不裁剪**：静默裁剪长正文等于把完整对话偷渡进摘要。
- 只有调用方显式传 `allowSummaryTruncation: true` 才允许裁剪；回执带
  `summaryTruncated: true`、`summaryOriginalBytes`、`summaryBytes`，原始长度可核对。
- 多行 / 绝对路径 / 密钥 / 内联正文仍然一律拒绝（与是否允许裁剪无关）。

### 4.2 v2 密文检测是键级契约

检测只看**键名**：`encrypted_content` / `encrypted_task_id` / `encrypted_payload` / `opaque_v2`
（任意层级、最多扫描 500 个节点）。它**不扫描字符串值内容、不做语义猜测**：
把 base64 密文放进 `summary.title` 或 `refs[].ref` 的值里不会触发 `UHR_REJECT_V2_OPAQUE`
（这是**设计边界**，不是 bug；若有需要，应在更深一层的协议/格式校验里做，而不是在这里猜）。
值级安全仍由"绝对路径/密钥/多行/内联正文"规则与引用白名单兜底。

## 5. 预算 / 截止 / 工具范围

- `budgetMicro` 必须是**正整数**：`0`、负数、浮点都拒绝（`UHR_REJECT_BUDGET`）；
- 不得超过身份上限与策略上限（`details.limitMicro` 回显较小值）；
- 币种必须显式且与身份一致（不做换算）；
- `deadlineAt`（或 `timeMs`）必须晚于当前、且不晚于身份 `expiresAt`（`UHR_REJECT_DEADLINE`）；
- `toolScope` 必须 ⊆ 身份允许 ∩ 策略允许的只读工具（`UHR_REJECT_TOOL_SCOPE`）。

## 6. 幂等与取消

- 幂等键 = `request.idempotencyKey` 或 `mcp:<toolCallId>`；
- 适配器对"将要发出的 payload"做 canonical JSON + `sha256` 得到 `digest`；
- **同键同摘要** ⇒ 返回同一 `taskRef`，`duplicate: true`，mock 侧 `executions` 不增（不重复执行）；
- **同键不同摘要** ⇒ `UHR_REJECT_CONFLICT`（不允许悄悄换一个任务）；
- 取消幂等：重复取消返回同一 `cancelled` 状态且 `duplicate: true`；已终态的任务取消 ⇒ `UHR_REJECT_STATE`。

## 7. 归属

`uhr_get_task_result` / `uhr_cancel_task` 必须满足其一：

1. 调用者身份就是任务 `ownerRef`（`sha256(callerRef|scopeRef)` 派生）；或
2. 身份 `grants` 里含该任务的 `taskRefToken(taskRef)`。

否则 `UHR_REJECT_NOT_OWNER`；`taskRef` 不存在/形状非法分别 `UHR_REJECT_TASK_NOT_FOUND` / `UHR_REJECT_BAD_REQUEST`。
适配器在 mock 存储的 `ownerRef` 上做判定（不信任调用方自述）。

## 8. MCP 结果形状（toolCallId 原样回填）

```js
{
  toolCallId,                       // 与入参完全一致（成功和失败都回填）
  isError: boolean,
  structuredContent: { ok, contract, version, code?, message?, ...payload },
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }]
}
```

`toolCallId` **必须是非空字符串**（trim 后非空）：空/缺失 ⇒ `UHR_REJECT_BAD_REQUEST`，且拒绝发生在任何提交之前
（不产生 taskRef、`executions` 不增）。这样"结果回到原 call ID"才不是一句空话。

失败不抛异常、不泄漏内部细节：`code` 是稳定拒绝码，`message` 是中性描述。
任务结果文本在返回前做**脱敏 + 截断**（`sk-…` ⇒ `[redacted]`，上限 16KB，`redacted/truncated` 布尔可见）。

## 9. 持久化与重启

mock 把任务表写到 `<dir>/uhr-tasks.json`（tmp + fsync + rename + 目录 fsync，0600），
`openMockUhr` **打开即校验**：损坏 ⇒ `UHR_MOCK_CORRUPT`，绝不自动重置。
因此"重启后 taskRef 仍可查"是可验证的（归归属校验一并保留）。

任务表只存：`taskRef`、幂等键哈希、摘要哈希、`ownerRef`、`parentRef`、refs（`{kind,ref}` 原样，已在边界校验过）、
预算/币种/截止/工具范围、有界 summary、状态与结果文本（结果文本由 mock 保存，适配器返回前脱敏）。

## 10. 拒绝码一览

`UHR_REJECT_IDENTITY` / `SCOPE` / `INTENT` / `V2_OPAQUE` / `SHAPE` / `SUMMARY_TOO_LARGE` / `REFS` /
`BUDGET` / `DEADLINE` / `TOOL_SCOPE` / `NOT_OWNER` / `TASK_NOT_FOUND` / `CONFLICT` / `STATE` / `BAD_REQUEST`。

## 11. 未验证 / 非目标

- **NOT_RUN**：真实 UHR 服务、真实 MCP 传输（stdio/SSE 服务器）、真实授权系统、真实工作区引用解析、
  真实取消语义（本 mock 立即取消，不模拟上游在途任务）。
- 非目标：模型推理与回执（M5-1，见 [uhr-inference-v1.md](uhr-inference-v1.md)）、Agent 编排策略、
  工具执行器本身。
- 适配器是 `forward.js` 之外的隔离实验目录（`src/mcp/`）；接线由 M1-3/M3-3 决定调用点。

## P06 外部委派的降级语义（uhr-mcp-v1）

> 2026-11-12。外部 MCP/UHR 委派是**受控降级路径**，不是 Codex 原生 child thread；本契约不注册生产 MCP，
> 也不替代原生线程。原生 Gate（Q03/Q04）不能用本节的任何结果充抵。

| 项 | 契约 |
| --- | --- |
| 路径标识 | 委派结果与最小回执都带 `delegation: { kind:"external_delegation", native:false, degraded:true, proof:"uhr-mcp-v1" }`；查询/取消同样标注。 |
| 输入范围 | 只接受显式、限长的可读摘要与不透明引用（`{kind, ref}`）；对话正文、绝对路径、密钥、v2 密文、写工具一律拒绝（零提交）。 |
| 用户批准 | 回执登记 `registerExternalDelegation` 必须 `userApproved:true`；未批准拒绝码 `UHR_EXT_REJECT_APPROVAL_MISSING`。 |
| 作用域与幂等 | 绑定 `callerRef`/`scopeRef`（登记只留 sha256 短 id）与 `idempotencyKey`（只留哈希）；同键同摘要复用 taskRef，不同摘要冲突。 |
| 取消 | `cancel_task` 幂等；已终态不可取消；只有拥有 taskRef 或有 scoped grant 才可读/取消。 |
| 大小限 | 单行摘要超硬上限默认拒绝，显式 `allowSummaryTruncation` 才裁剪并留痕；回执登记 `summaryBytes` 超过 8192 字节拒绝。 |
| 不冒充原生 | 任何 `native:true`/`degraded:false`/`kind:"native_child_thread"` 的宣称都必须被拒绝（`isNativeDelegationClaim`）；外部委派不计入原生验收。 |
| 可禁用 | 不接入 MCP 即回到“手动导出摘要”的路径；本节不改变原生线程、不创建假 child、不产生伪通知。 |

