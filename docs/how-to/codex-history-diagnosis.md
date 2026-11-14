# 只读诊断 Codex 历史会话（E7）

> 状态：**只读诊断已实现（2026-11-11）**；选择迁移只做**预演**，实际写入未实现（调用即抛 `not_authorized`）。
> 代码：[src/codex/history.js](../../src/codex/history.js) · 回归：[scripts/test/offline/codex-history.test.mjs](../../scripts/test/offline/codex-history.test.mjs)
> 相关：v2 密文 wire 事实见 [Codex v2 子代理说明](../explanation/codex-v2-agents.md)；只读用量采集见 [原生用量](../reference/configuration.md)。

## 1. 什么时候用

需要在**不改动任何历史文件**的前提下回答：

- 这些会话分别属于哪个 provider / 用了哪些 model、各多少轮？
- 哪些 model 已经不在当前目录（catalog）里，切换后会不会回落？
- 历史里有没有工具调用带 `unsupported` / `unknown` 标记，或调用没有结果（回放风险）？
- 有没有 v2 加密任务（`encrypted_content` / `encrypted_task_id`）？能不能读？
- 如果只迁移某几条会话，**将会改哪些文件/字段**、原文件 sha256 是什么、备份名建议是什么？

## 2. 安全边界（硬约束）

- **必须显式传入 sessions 目录**：本模块不会默认读取 `~/.codex`，也不猜测路径。未传目录时返回 `enabled:false` 且不访问文件系统。
- **只读**：不写、不改 mtime、不删除、不重命名；只读取 `.jsonl`（跳过符号链接与非 jsonl）。
- **不解密**：含 `encrypted_content` / `encrypted_task_id` 的会话一律 `unreadable:true`、`recoverable:false`，不尝试解码、不伪造、不删除。
- **脱敏**：输出只有计数、model slug、provider、相对路径、sha256 和风险 code；不含消息正文、工具参数/输出、密文、凭据。
- **不联网**；只使用 Node 内置模块。

## 3. 用法

```js
import { diagnoseHistory, planSelectiveMigration } from './src/codex/history.js'

// 1) 诊断：catalog 可选，用于 missingModels；传数组或 Codex ModelsResponse 均可
const report = await diagnoseHistory({
  sessionsDir: '/explicit/path/to/codex/sessions', // 必须显式；测试用 mkdtemp
  catalog: ['gpt-6.1-sol', 'deepseek-v4.1-flash'],
})
console.log(JSON.stringify(report.summary, null, 2))

// 2) 迁移预演（只读）：选中会话 + 目标 provider/model
const plan = await planSelectiveMigration(
  { sessions: ['<session_id 或 relPath>'], target: { provider: 'openai', model: 'gpt-6.1-sol' } },
  { sessionsDir: '/explicit/path/to/codex/sessions', catalog: ['gpt-6.1-sol'] },
)
console.log(JSON.stringify(plan, null, 2))
```

命令行（不写死路径，避免误读真实目录）：

```bash
CODEX_SESSIONS_DIR=/explicit/path/to/codex/sessions \
node --input-type=module -e "
import { diagnoseHistory } from './src/codex/history.js'
const r = await diagnoseHistory({ sessionsDir: process.env.CODEX_SESSIONS_DIR })
console.log(JSON.stringify(r.summary, null, 2))
"
```

## 4. 诊断输出

```jsonc
{
  "version": 1, "generatedAt": 1794190000000,
  "enabled": true, "source": "codex-sessions", "readOnly": true,
  "dirLabel": "sessions", "catalogProvided": true,
  "scanned": { "files": 3, "sessions": 3, "bytes": 8192, "parseErrors": 0, "truncated": false },
  "summary": {
    "sessions": 3,
    "totals": { "files": 3, "bytes": 8192, "turns": 4, "toolCalls": 4, "encryptedItems": 2, "agentMessages": 1 },
    "byProvider": [ { "provider": "custom", "sessions": 2, "turns": 3,
                      "models": [ { "model": "deepseek-v4.1-flash", "turns": 3 } ] } ],
    "byModel": [ { "model": "deepseek-v4.1-flash", "providers": ["custom"], "sessions": 2, "turns": 3, "inCatalog": false } ],
    "unreadableEncrypted": { "sessions": 1, "items": 2 },
    "missingModels": ["deepseek-v4.1-flash"],
    "risks": {
      "missingModels": { "models": ["deepseek-v4.1-flash"], "sessions": 2 },
      "toolReplay": { "items": 1, "sessions": 2, "unpairedCalls": 2 },
      "encryptedUnreadable": { "sessions": 1, "items": 2 }
    }
  },
  "sessions": [
    { "relPath": "2026/11/11/rollout-v2-encrypted.jsonl", "sha256": "…", "size": 2048,
      "sessionId": "s-v2", "provider": "custom",
      "models": [ { "model": "deepseek-v4.1-flash", "turns": 1 } ],
      "turns": 1, "toolCalls": 1, "toolOutputs": 0,
      "toolRiskItems": 0, "unpairedToolCalls": 1,
      "v2": { "encryptedItems": 2, "encryptedTaskIds": 1, "agentMessages": 1,
              "unreadable": true, "recoverable": false, "reason": "encrypted_content_opaque" },
      "risks": ["v2_encrypted_unreadable", "tool_call_unpaired", "missing_model:deepseek-v4.1-flash"] }
  ],
  "notes": ["只读诊断：未修改任何历史文件；不含消息正文、工具参数或密文。"]
}
```

### 4.1 字段语义

| 字段 | 含义 |
| --- | --- |
| `scanned` | 找到/扫描的文件、会话、字节、与已知事件相关的 JSON 解析错误；`truncated` 表示触发上限 |
| `summary.byProvider` | provider 维度：会话数、轮数、model 使用次数 |
| `summary.byModel` | model 维度：使用轮数、涉及的 provider、会话数、`inCatalog`（未提供 catalog 时恒为 true） |
| `summary.missingModels` | 历史出现过但 catalog 中没有的 model slug（catalogProvided=false 时不计算） |
| `summary.unreadableEncrypted` | 含 v2 密文的会话数与密文项数；这些任务**不可读** |
| `summary.risks.toolReplay.items` | 带 `unsupported`/`unknown`（call/tool）标记的工具项数 |
| `summary.risks.toolReplay.unpairedCalls` | 有 `call_id` 但没有对应输出的调用数（回放/续轮风险） |
| `sessions[].sha256` | 文件内容 sha256（迁移预演据此发现外部并发修改） |
| `sessions[].relPath` | 相对 sessions 根的路径（不输出绝对路径，避免泄露用户名/目录结构） |
| `sessions[].risks` | 稳定风险 code：`v2_encrypted_unreadable`、`tool_replay_marker`、`tool_call_unpaired`、`missing_model:<slug>` |

模型计数来自 `turn_context.payload.model`（每个 turn_context 计 1 轮）；provider 来自 `session_meta.payload.model_provider`。

## 5. 迁移预演

`planSelectiveMigration(selection, opts)` 只返回计划，**不写文件**：

```jsonc
{
  "dryRun": true, "authorized": false, "writeSupported": false,
  "selection": { "requested": ["s-third"], "matched": [ { "relPath": "…", "sessionId": "s-third" } ], "unmatched": [] },
  "target": { "provider": "openai", "model": "gpt-6.1-sol" },
  "changes": [ {
    "relPath": "2026/11/11/rollout-thirdparty.jsonl", "sessionId": "s-third",
    "sha256": "…", "size": 2048,
    "fields": [
      { "field": "session_meta.payload.model_provider", "from": "custom", "to": "openai" },
      { "field": "turn_context.payload.model", "from": ["deepseek-v4.1-flash"], "to": "gpt-6.1-sol" }
    ],
    "backupSuggested": "2026/11/11/rollout-thirdparty.jsonl.bak-20261111-200000",
    "writeMode": "tmp+rename", "requiresApproval": true
  } ],
  "backup": { "suggested": true, "strategy": "复制原文件为 <file>.bak-<stamp> 并记录 sha256；写入用临时文件+rename；失败用备份恢复", "files": [ … ] },
  "totals": { "files": 1, "bytes": 2048 },
  "warnings": [],
  "note": "只读预演：不写入任何历史文件。真正迁移需逐条授权、备份与回滚演练（当前写入接口抛 not_authorized）。"
}
```

选择方式：`{ sessions: [sessionId|relPath] }`、`{ relPaths: [...] }` 或 `{ all: true }`；目标可用 `target:{provider,model}` 或 `targetProvider/targetModel`。未匹配的选择进入 `selection.unmatched`，不猜测。

**写入被明确拒绝**：`applySelectiveMigration()` 与 `planSelectiveMigration({…, apply:true})` 抛 `code === 'not_authorized'`，不落盘。真正迁移的前置条件（逐条授权、备份、哈希校验、tmp+rename、失败恢复演练）尚未实现，不要用其它脚本绕过。

## 6. 上限与注意

- 上限：2000 文件 / 128MiB 总量 / 每文件 40 万行 / 单行 2MiB；触顶时 `scanned.truncated=true`。
- 跳过符号链接与非 `.jsonl` 文件；不可读文件跳过而不报错（诊断不因单文件权限失败）。
- `diagnoseHistory({ includeSessions:false })` 只返回 summary，适合大目录快速巡检。
- 输出可直接 JSON 序列化；不含任何正文/参数/密文。若需要人工复核，请用 `relPath + sha256` 定位文件，而不是把内容贴进报告。

## 7. 验证

```bash
node --test scripts/test/offline/codex-history.test.mjs   # 3 用例
npm run check && npm test && npm run docs:check && node scripts/check-metadata.mjs
```

测试全部使用 `mkdtemp` 合成会话：官方、第三方、v2 加密各一，断言计数精确、输出无正文/密文、目录缺失识别、迁移计划只读（前后内容与 mtime 不变）、写入被拒。

## 8. 未做 / 边界

- **真实 `~/.codex/sessions` 未扫描**：测试与文档示例只用显式临时目录；真实用户历史的诊断需在明确授权与隔离副本上执行，并记录版本/SHA。
- **实际迁移未实现**：按 D6，写入需要单会话授权、备份、模拟与回滚演练；本阶段只提供预演。
- **不提供 /api 或 UI 入口**：目前是库函数；接入管理面需另行设计与鉴权。
- **不解密、不重建 v2 任务**：密文对网关永久不透明；可读性只能由官方原生 Responses 上游保证。
