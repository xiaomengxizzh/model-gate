# MCP 委派 Fixture v1（G2）

契约：[ModelGate 本地 MCP 委派契约 v1](../../../modelgate-mcp-delegation-v1.md)。
威胁模型：[MCP 委派威胁模型](../../../../explanation/mcp-delegation-threat-model.md)。

状态：**手写派生样例，未抓包、未接真实服务**。基线分支 `feat/mg-g2-mcp-contract`（2026-11-13）。
本目录只有 JSON，没有任何运行时代码；除 `README.md` 外每个文件都是合法 JSON。

## 1. 文件

| 文件 | 用途 | 契约锚点 |
| --- | --- | --- |
| [tools-list.json](tools-list.json) | `tools/list` 完整响应：5 个工具的 entry | §3.1–3.6 |
| [transport.json](transport.json) | `initialize`/`initialized`/`ping`、版本协商、通道 A 拒绝 | §2.1–2.5、§9.1 |
| [valid-delegate.json](valid-delegate.json) | 合法 `modelgate_delegate_task` 调用 | §3.2 |
| [valid-get.json](valid-get.json) | 合法 `modelgate_get_task` 调用 | §3.3 |
| [valid-wait.json](valid-wait.json) | 合法 `modelgate_wait_task` 调用 | §3.4 |
| [valid-followup.json](valid-followup.json) | 合法 `modelgate_followup_task` 调用 | §3.5 |
| [valid-cancel.json](valid-cancel.json) | 合法 `modelgate_cancel_task` 调用 | §3.6 |
| [result-samples.json](result-samples.json) | tools/call 结果与失败信封样例 | §4.1–4.4、§5.4、§7.3 |
| [rejections.json](rejections.json) | 29 条拒绝矩阵负例（通道 B） | §3.7、§8.2、§9.2 |

## 2. 生成方式（手写派生，不是抓包）

1. 以契约 §3 的 schema 为唯一来源，手写 `tools-list.json`；不读取任何真实实例、不抓取真实响应。
2. 每类工具各写一条合法调用；参数取真实形状（工作区别名 `mg-self`、相对引用路径），
   但任务正文是虚构的核对任务，不含真实仓库内容与真实凭据。
3. 结果样例按契约 §4.2 的 24 个字段逐项填齐；`resultDigest` 用 §4.4 规则**真实计算**，
   `artifacts[0].sha256` 是 `tools-list.json` 的**真实 SHA-256**（见 §5 复算）。
4. 拒绝矩阵按 §8.2 的优先级与 §9.2 的码表逐条写，每条只引入一个违规点。
5. 全部文件做 `JSON.parse` + 脱敏扫描 + 摘要复算（§5），三项全过才算交付。

## 3. 文档 ↔ fixture 逐字段对照（人工核对表）

"核对"列是本轮人工逐项比对的结果；**没有自动化脚本消费本目录**（见 §7）。

### 3.1 tools-list.json

| fixture 路径 | 契约 | 核对 |
| --- | --- | --- |
| `result.tools[].name` = 5 个 `modelgate_*` | §3.1 表 / §3.2–3.6 | ✔ 名称、数量一致；无第六个工具 |
| `result.tools[].annotations` 4 个布尔 | §3.1 表 | ✔ 逐工具比对（cancel 为 destructiveHint:true，get/wait 为 readOnlyHint:true） |
| `result.tools[].inputSchema.additionalProperties:false` | §3.1 | ✔ 5 个 entry 全为 false |
| 无 `outputSchema` | §3.1 | ✔ 5 个 entry 都没有该键 |
| delegate `required` = `["task","idempotencyKey","workspace"]` | §3.2 | ✔ |
| delegate `task.maxLength` = 65536 | §3.2、§3.7 | ✔ 与"任务正文上限 64 KiB"一致 |
| `idempotencyKey.pattern` = `^[A-Za-z0-9_.:-]{8,128}$` | §3.7、§6.1 | ✔ 无空白、无 Unicode |
| `workspace.required` = `["root"]`；`refs.maxItems` = 16；`path.maxLength` = 512 | §3.2、§8.3 | ✔ |
| `refs[].mode` = `read`/`write` | §8.3 | ✔ 与小节"write 需 read_write"配合 |
| `permissionMode` = `read_only`/`read_write` | §3.2、§8.4 | ✔ 默认值 read_only 写在 §3.2，不写进 schema |
| `toolPolicy` 5 个枚举 + `maxItems` = 6 | §8.4 | ✔ read_file/list_dir/search/write_file/exec |
| `reasoningEffort` = `low`/`high`/`max` | §3.2 | ✔ 与 `GO_EFFORTS` 一致，无 medium |
| `budget.maxElapsedMs` 1000..1800000；`maxToolCalls` 1..200 | §3.2 | ✔ |
| `parentThreadId.pattern` ≤128 | §7.2 | ✔ |
| `taskRef.pattern` = `^mgtask-[0-9a-f]{16}$` | §0.0、§1、§3.3–3.6 | ✔ 5 处 pattern 完全一致 |
| `timeoutMs` 0..60000 | §3.4 | ✔ 默认 15000 属默认值，不进 schema |
| `maxResultBytes` 1024..65536 | §3.3、§3.7 | ✔ |
| `cancel.reason` 4 个枚举 | §3.6 | ✔ user_request/parent_abort/timeout/other |

### 3.2 transport.json

| fixture 路径 | 契约 | 核对 |
| --- | --- | --- |
| `framing.maxLineBytes` = 1048576 | §2.1 | ✔ 1 MiB |
| `framing.contentLengthFraming:false`、`batch:"unsupported"` | §2.1 | ✔ |
| `framing.supportedProtocolVersions` / `fallbackProtocolVersion` | §2.2 | ✔ 两个版本 + 2024-11-05 回退 |
| `initialize.response.result.capabilities.tools.listChanged=false` | §2.2 | ✔ 不声明 logging/prompts/resources |
| `serverInfo.name` = `modelgate-delegation` | §2.2 | ✔ |
| `negotiate.unknown-version.expect.protocolVersion` = 2024-11-05 | §2.2 | ✔ 未知版本降级而不报错 |
| `reject.batch` → -32600 / `MCP_BATCH_UNSUPPORTED` | §2.1、§9.1 | ✔ |
| `reject.unknown-method` → -32601 / `MCP_METHOD_NOT_FOUND` | §2.5、§9.1 | ✔ |
| `reject.not-initialized` → -32002 / `MCP_SERVER_NOT_INITIALIZED` | §2.2、§9.1 | ✔ |
| `reject.unknown-tool` → -32602 / `MCP_UNKNOWN_TOOL` | §9.1 | ✔ 用的名字是 `modelgate_spawn_native_agent`（故意不存在） |
| `reject.duplicate-initialize` → -32600 / `MCP_INVALID_REQUEST` | §2.2、§9.1 | ✔ |
| `reject.parse-error` → -32700 / `MCP_PARSE_ERROR`，`id:null` | §2.1、§9.1 | ✔ rawLine 故意缺右括号 |
| `reject.frame-too-large` → -32600 / `MCP_FRAME_TOO_LARGE` + `closeAfter` | §2.1、§9.1 | ✔ |

### 3.3 valid-*.json

| fixture 路径 | 契约 | 核对 |
| --- | --- | --- |
| `request.jsonrpc` = "2.0"、`method` = "tools/call"、`params.name` | §2.1、§3.1 | ✔ 5 个文件的 `name` 与 `tools-list.json` 完全一致 |
| delegate 参数只含 6 个合同字段 | §3.2 | ✔ 无 provider/model/url/凭据键 |
| get/wait 的 `taskRef` 形状 | §1、§3.3 | ✔ `mgtask-` + 16 hex |
| valid-wait `timeoutMs` = 15000 | §0.0、§3.4 | ✔ 即默认值，同时也是合法显式值 |
| valid-followup 无 `workspace`/`permissionMode`/`toolPolicy` | §3.5 | ✔ 追派不得提权，也不接受这些键（`additionalProperties:false`） |
| 每个文件的 `expect` 只描述语义（如 `timedOutIsNotFailure`） | §5.4 | ✔ 不是 golden 输出，不冒充服务端返回 |

### 3.4 result-samples.json

| fixture 路径 | 契约 | 核对 |
| --- | --- | --- |
| `response.content[0].text` 与 `structuredContent` 同源 | §4.1 | ✔ 由同一对象 `JSON.stringify` 生成 |
| `structuredContent.contract`/`version`/`tool`/`ok` | §4.1 | ✔ 9 个样例一致（失败样例 `ok:false`+`isError:true`） |
| task 24 个字段全在、无多余字段 | §4.2 | ✔ 逐字段比对（含 `reconcileRequired`、`ackSeq`、`delegation`） |
| `delegation` = `{native:false,degraded:true,kind:"external_worker_delegation",proof:"modelgate-mcp-delegation-v1"}` | §4.2、威胁模型 §1.2 | ✔ 5 处出现，值完全相同 |
| `resultDigest` 覆盖 `{artifacts,model,provider,resultText,taskRef,turnRef}`（不含 state） | §4.4 | ✔ 见 §5 复算命令输出 |
| `get.result_ready` 与 `get.acknowledged` 的 `resultDigest` 相同 | §4.4、AC-11 | ✔ 两个样例 digest 相等，只有 state/ack 字段不同 |
| `wait.timeout`：`ok:true`、`isError:false`、`timedOut:true`、state 仍 `RUNNING` | §5.4 | ✔ 未把超时写成失败 |
| `delegate.duplicate`：`duplicate:true` | §6.3 | ✔ |
| `cancel.cancelled`：`cancel.reachedUpstream:true` | §3.6 | ✔ 三态之一 |
| `get.failed`：`ok:true` + `state:FAILED` + `error.code:MCP_UPSTREAM_TIMEOUT` | §4.2、§9.2 | ✔ 与通道 B 拒绝区分 |
| `failure.not_owner`：`task:null`、`details.reason:"owner_mismatch"` | §4.3、§7.3 | ✔ 不回显他人字段 |
| `failure.unknown_outcome`：对 `UNKNOWN` 取消返回拒绝并回显 state | §3.6、§9.2 | ✔ |
| `artifacts[0]` 指向 `tools-list.json` 的真实 sha256 与字节数 | §4.6 | ✔ 见 §5 复算（bytes = 文件实际大小） |

### 3.5 rejections.json

| case | 期望码 | 契约 | 核对 |
| --- | --- | --- | --- |
| R01-task-too-large | `MCP_ARGUMENT_TOO_LARGE`(task/65536) | §3.7 | ✔ |
| R02-arbitrary-url | `MCP_URL_NOT_ALLOWED`(url) | §8.2-3 | ✔ |
| R03-base-url | `MCP_URL_NOT_ALLOWED`(baseUrl) | §8.2-3 | ✔ |
| R04-api-key-argument | `MCP_CREDENTIAL_IN_ARGUMENT`(apiKey) | §8.2-2 | ✔ |
| R05-headers-argument | `MCP_CREDENTIAL_IN_ARGUMENT`(headers) | §8.2-2 | ✔ |
| R06-missing-idempotency-key | `MCP_INVALID_ARGUMENTS`(required) | §3.2、§6.3 | ✔ |
| R07-bad-idempotency-key | `MCP_IDEMPOTENCY_KEY_INVALID` | §3.7 | ✔ |
| R08-idempotency-conflict | `MCP_IDEMPOTENCY_CONFLICT`(digest_mismatch) | §6.3 | ✔ 需前置同键记录，`given` 已说明 |
| R09-secret-in-task | `MCP_SECRET_IN_ARGUMENT`(task) | §8.2-6 | ✔ |
| R10-v2-encrypted-content | `MCP_V2_OPAQUE`(encrypted_content) | §8.2-1 | ✔ |
| R11-v2-opaque-in-refs | `MCP_V2_OPAQUE`(refs[0].encrypted_payload) | §8.2-1 | ✔ 任意层级 |
| R12-workspace-absolute-root | `MCP_WORKSPACE_DENIED`(path_not_allowed) | §8.3 | ✔ |
| R13-refs-path-escape | `MCP_WORKSPACE_DENIED`(escape) | §8.3 | ✔ |
| R14-write-ref-without-permission | `MCP_TOOL_POLICY_DENIED`(refs[0].mode) | §8.3、§8.4 | ✔ |
| R15-exec-in-read-only | `MCP_TOOL_POLICY_DENIED`(toolPolicy) | §8.4 | ✔ |
| R16-effort-not-proven | `MCP_INVALID_ARGUMENTS`(reasoningEffort) | §3.2 | ✔ |
| R17-budget-out-of-range | `MCP_BUDGET_INVALID`(999<1000) | §3.2 | ✔ |
| R18-arguments-too-large | `MCP_ARGUMENT_TOO_LARGE`(arguments/262144) | §3.7 | ✔ 先整体后单字段（stimulus） |
| R19-unknown-field | `MCP_INVALID_ARGUMENTS`(messages) | §3.1、§8.2 | ✔ |
| R20-provider-argument | `MCP_PROVIDER_NOT_ALLOWED` | §8.2-4 | ✔ 即使值等于默认也拒绝 |
| R21-model-argument | `MCP_MODEL_NOT_ALLOWED` | §8.2-5、§8.1 | ✔ 用 `gpt-6-luna` 作父模型 slug 的反例 |
| R22-get-cross-owner | `MCP_NOT_OWNER` | §7.3 | ✔ |
| R23-cancel-not-owner | `MCP_NOT_OWNER` | §7.3 | ✔ |
| R24-cancel-terminal-task | `MCP_TASK_STATE_INVALID`(RESULT_READY) | §3.6 | ✔ |
| R25-cancel-unknown-task | `MCP_UNKNOWN_OUTCOME` | §3.6、§5.2 禁止转移 | ✔ |
| R26-followup-parent-mismatch | `MCP_FOLLOWUP_CONFLICT` | §7.3 | ✔ |
| R27-followup-while-running | `MCP_TASK_STATE_INVALID`(RUNNING) | §3.5 | ✔ |
| R28-wait-timeout-too-large | `MCP_INVALID_ARGUMENTS`(60001) | §3.4 | ✔ |
| R29-bad-taskref-shape | `MCP_INVALID_ARGUMENTS`(pattern) | §3.3 | ✔ 用旧 `task-` 前缀 |

其它核对项：

| 项 | 契约 | 核对 |
| --- | --- | --- |
| 全部 case 的 `channel` = "B" | §2.3 | ✔ 参数/归属/状态错误一律通道 B |
| 每条 `expect.details` 只用白名单键（field/reason/limit/bytes/state/allowed） | §4.3 | ✔ |
| 每条 case 的 `request` 是完整 JSON-RPC 信封 | §2.1 | ✔ 可以直接喂给 `tools/call` |
| 拒绝必须零提交（上游命中 0、任务表不增） | §5.2 T2 | ✔ 写进文件级 `note`，由 G3 测试断言 |

## 4. stimulus（体积类负例的构造协议）

R01 与 R18 需要 65537 / 262145 字节的字符串。为了不让 fixture 变成一行 260 KB，
这两条 case 用 `stimulus` 描述构造方式，**其余 case 原样发送**：

```json
"stimulus": { "apply": "repeat_utf8", "path": "params.arguments.task", "base": "A", "bytes": 65537 }
```

发送前：定位 `path`（点分，相对整条 JSON-RPC 信封），把该位置的值替换为 `base` 字符重复
`bytes` 次（按 UTF-8 字节计；`base` 为单字节 ASCII）。替换后再序列化发送。
契约里 §3.7 已固定校验顺序（先整体 `arguments` 字节，后单字段），因此两条 case 的期望码互不冲突。

## 5. 可复算校验（三条命令，全部零依赖）

```bash
# ① 所有 JSON 必须可解析
node -e "const fs=require('node:fs'),d='docs/contracts/fixtures/mcp/v1';for(const f of fs.readdirSync(d).filter(n=>n.endsWith('.json')).sort()){JSON.parse(fs.readFileSync(d+'/'+f,'utf8'));console.log(f+': OK')}"
```

```bash
# ② 结果样例的 resultDigest 必须能按 §4.4 复算出来（且 ack 前后一致）
node --input-type=module -e "
import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';
const d='docs/contracts/fixtures/mcp/v1';
const canon=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canon).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
const s=JSON.parse(readFileSync(d+'/result-samples.json','utf8'));
for(const x of s.samples){const t=x.response.structuredContent.task;
  if(!t)continue;
  if(!t.resultDigest){console.log(x.id+': digest null (expected)');continue}
  const calc=createHash('sha256').update(canon({artifacts:t.artifacts,model:t.model,provider:t.provider,resultText:t.resultText,taskRef:t.taskRef,turnRef:t.turnRef}),'utf8').digest('hex');
  console.log(x.id+': '+(calc===t.resultDigest?'digest OK':'MISMATCH'))}
"
```

```bash
# ③ 产物哈希必须是被引用文件的真实 SHA-256
node -e "const c=require('node:crypto'),fs=require('node:fs'),d='docs/contracts/fixtures/mcp/v1/';const a=JSON.parse(fs.readFileSync(d+'result-samples.json')).samples.find(s=>s.id==='get.result_ready').response.structuredContent.task.artifacts[0];const got=c.createHash('sha256').update(fs.readFileSync(d+'tools-list.json')).digest('hex');console.log(got===a.sha256&&fs.statSync(d+'tools-list.json').size===a.bytes?'artifact sha256/bytes OK':'MISMATCH')"
```

预期：① 打印 9 行 OK；② `get.result_ready` 与 `get.acknowledged` 打印 digest OK、其余打印 null；
③ 打印 artifact sha256/bytes OK。

## 6. 脱敏规则

- 域名只用 RFC 2606 保留的 `example.invalid`；不出现真实厂商域名、内网 IP、LAN 主机名。
- 不出现真实 Key/令牌/Cookie/Authorization 值。**`rejections.json` 里的 `sk-f1xture-…` 是故意的
  合成凭据形状**，用来触发 `MCP_SECRET_IN_ARGUMENT`/`MCP_CREDENTIAL_IN_ARGUMENT`；它不是任何真实
  Key 的格式，也不对应任何账号。因此本目录**故意**不满足"grep sk- 无输出"这一全局规则。
- 唯一出现的绝对路径是 R12/R13 的反例（`/tmp/mg-fixture-not-a-workspace`、`../../../etc/passwd`），
  它们必须被拒绝，不能指向真实文件。
- 时间戳固定为 2026-11-13（epoch ms），taskRef/turnRef 是固定样例值，不对应任何真实任务。
- 任务正文是虚构的核对任务，不含真实仓库内容、真实路径、真实用户名。

可执行的局部扫描（除 rejections.json 外不得出现凭据形状）：

```bash
grep -rnE '(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{16})' \
  docs/contracts/fixtures/mcp/v1 --include='*.json' | grep -v rejections.json
```

预期：无输出。**必须用带左边界的分词正则**：裸 `grep "sk-"` 会把 `mgtask-0123…` 这类
合法 taskRef 当成密钥误报（`task-` 里就含 `sk-` 三个字符），这类误报不是泄漏。

## 7. 已知限制

- 不是从真实服务捕获的快照，**不证明任何服务端行为**；服务端行为以契约为准。
- **没有测试消费本目录**：一致性靠 §3 的人工核对表，字段漂移不会被自动发现（G3 建议加一个
  "fixture ↔ `tools/list` 实际输出"的对比测试，属实现卡范围）。
- `result-samples.json` 里只有 `get.result_ready`/`get.acknowledged` 带非空 `resultDigest`；
  其余样例没有结果正文，按契约 §4.4 为 `null`（不是缺字段）。
- `rejections.json` 中 R08/R22/R23/R24/R25/R26/R27 依赖前置状态（同键记录、他 owner 任务、终态任务等），
  文件用 `given` 说明，测试需自备 setup，不能只发请求。
- 未覆盖：`MCP_BUSY`（并发上限）、`MCP_STORE_UNAVAILABLE`（锁/损坏）、
  `MCP_UPSTREAM_*` 的映射细节；这些需要运行时环境，归 G3 的离线故障注入。
- 未覆盖 `tools/call` 的 `params._meta`（契约 §未定义，实现应忽略）。

## 8. 更新流程

1. 先改契约（[modelgate-mcp-delegation-v1.md](../../../modelgate-mcp-delegation-v1.md)），再改 fixture；
   不允许用 fixture 反向定义契约。
2. 改了 schema 字段/上限/枚举 ⇒ 同时更新 `tools-list.json` 与 §3.1 对照表；
   改了结果字段 ⇒ 同步 `result-samples.json`、§3.4 对照表，并重算 `resultDigest`（§5②）。
3. 改了 `tools-list.json` 字节 ⇒ `artifacts[].sha256`/`bytes` 必须重算（§5③），否则样例自相矛盾。
4. 新增负例 ⇒ 只在 `rejections.json` 追加，并同步契约 §12 AC-2 的条数与 §3.5 对照表。
5. 每次改完跑 §5 三条命令 + §6 扫描 + `node scripts/check-docs.mjs`；
   任一失败不得交付。
6. 交付记录写清"手写派生、未抓生产"，不得写"已从线上验证"。
