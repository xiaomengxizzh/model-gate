# ModelGate 真实 Luna 父推理验收（A5 首次授权实跑，2026-11-14）

- **被测树 SHA**：`4feafe0e51dc02d48c45734df5b34e70d3679bd5`（分支 `mg-codex-native`；本轮对仓库只读，未修改、未检出、未提交任何 `src/**`）
- **运行环境**：Linux x86_64，Node `v24.22.2`，Codex CLI `0.167.0`；请求窗口 2026-11-14 12:25:33Z–12:27:13Z（20:25–20:27 CST），整轮实跑 20:23–20:41 CST
- **隔离实例**：网关监听 `127.0.0.1:19020`；隔离 `CODEX_HOME` 与 `MG_CONFIG_DIR` 均在 `/tmp` 下，所有中间产物只写入 `/tmp`
- **未触碰**：所有者常驻进程 551774、`127.0.0.1:18787` 网关、全部 ChatGPT Electron 实例；未写用户级 `config.toml`；未安装、未下载
- **性质**：真实上游、真实本机订阅登录、请求级模型核验。**不含** Desktop GUI、不含原生父子线程、不含中断/恢复。本文件只登记实际观测，不推断未观测的能力。

## 1. 授权预算台账

所有者授权：仅 `gpt-6-luna`，40 次上游请求或 25 分钟，先到即止。

| 项目 | 实际 |
| --- | --- |
| 上游请求 | **4 / 40** |
| 墙钟 | **18 / 25 分钟**（20:23–20:41 CST） |
| 无效尝试 | 1 次 `curl` 在网关尚未监听时连接失败，**0** 次上游请求 |

| # | 时间（UTC） | 模型（请求级核验） | host / path | HTTP |
| --- | --- | --- | --- | --- |
| 1 | 12:25:33 | `gpt-6-luna` | `chatgpt.com` / `/backend-api/codex/responses` | 200 |
| 2 | 12:26:37 | `gpt-6-luna` | 同上 | 200 |
| 3 | 12:27:04 | `gpt-6-luna` | 同上（TLS 校验开启） | 200 |
| 4 | 12:27:13 | `deepseek-v4.1-flash`（负向对照，非 GPT） | `opencode.ai` / `/inference/go/v1/responses` | 401 |

## 2. 场景结果

| 场景 | 状态 | 观测 |
| --- | --- | --- |
| 父推理（MG-R012 / R002 官方请求半边） | `PASS_REAL` | 3/3 HTTP 200；请求体 `model=gpt-6-luna` 经出站观测确认；上游 `response.completed` 回显 `model:gpt-6-luna`、`status:completed`、`output_text="A5_LUNA_R3"`、usage 42/10 |
| 原生子代理（MG-R005） | `BLOCKED` | 两条独立原因，见 §2.1；未用 mock 替代 |
| 中断 / 恢复（MG-R006） | `BLOCKED` | 依赖上一项；无活跃子线程，无可观测事件 |
| 负向对照（MG-R008 的 `no-silent-fallback`） | `PASS_REAL`（窄） | 上游 401 `{"error":{"type":"authentication_error","message":"OpenCode Go requires an API key"}}` 原样透传；恰好 1 次出站，模型/供应商/协议均未替换，零 GPT 请求 |

### 2.1 原生子代理为何是 `BLOCKED` 而不是 `FAIL`

1. 真实 Codex CLI 父进程需要可写 `CODEX_HOME`：要么用所有者现用的用户级目录（本轮禁止），要么复制凭据文件（本轮禁止）。用符号链接搭建的隔离目录在**只读**路径上是安全的，但对可写 CLI 不安全——CLI 可能刷新令牌并沿链接写回，等同于改写用户凭据（该风险同样记录在 §4）。
2. 该树中没有 OpenCode Go 凭据（`config/keys.local.json` 不存在），跨供应商子模型无法真实调用。

因此 R005 / R006 的跨供应商半边保持 `BLOCKED`，不以 mock 或替代模型冒充。`src/codex/native-capabilities.js:98` 声明了 `response.cancel` / `response.interrupted`，但本轮没有任何取消请求被真实发出，不能据此登记 `NOT_ACCEPTED`。

> **2026-11-14 政策更正（不改变本轮状态）**：§2.1 第 1 条里的两处“本轮禁止”是**当轮的政策限制，不是技术限制**——当时“不复制、不触碰认证材料”的一刀切规则在生效，所以该场景没有运行。所有者已于 **2026-11-14** 解除该限制：`~/.codex/auth.json` 可在明确、有界、可审计的授权下读取与备份（见 [接口 ADR](../architecture/2026-11-14-aggregation-interfaces.md) §10「凭据处理协议」）。因此“禁止复制凭据”**不再是有效的阻塞理由**，MG-R005 / MG-R006 的原生场景属于**待重跑**，不是不可实现。本轮未重跑，状态不变。

## 3. 请求级取证

模型 ID **不是**从配置意图推断的，而是从网关自身 socket 上实际写出的明文请求体读取的。观测方式：对**本轮自建的隔离实例**注入只读观测钩子（`NODE_OPTIONS=--require`，包装 `https.request` 的 `end/write`，只记录 host/path/method/字节数/`model`/头名，不修改请求）。

```bash
env -u NODE_TLS_REJECT_UNAUTHORIZED \
  NODE_OPTIONS="--require /tmp/mg-a5-real/tap.js" \
  MG_CONFIG_DIR=/tmp/mg-a5-real/config \
  CODEX_HOME=/tmp/mg-a5-real/codex-home \
  node <tree>/src/index.js            # 127.0.0.1:19020

curl --noproxy '*' -X POST http://127.0.0.1:19020/v1/responses \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -H 'originator: codex_cli_rs' -H 'version: 0.167.0' \
  -H 'session_id: a5-scratch-3' -H 'openai-beta: responses=experimental' \
  --data-binary @/tmp/mg-a5-real/req3.json
```

请求 3 的脱敏收据（与 §2 同一格式）：

```json
{
  "ts": "2026-11-14T12:27:04.231Z",
  "proto": "https",
  "host": "chatgpt.com",
  "port": 443,
  "method": "POST",
  "path": "/backend-api/codex/responses",
  "bytes": 309,
  "model": "gpt-6-luna",
  "headerNames": ["accept", "accept-encoding", "authorization", "chatgpt-account-id",
                  "content-length", "content-type", "openai-beta", "originator",
                  "user-agent", "version"],
  "auth": "REDACTED",
  "accountHeaderPresent": true
}
```

响应：`HTTP/1.1 200`；上游自有字段 `model=gpt-6-luna`、`status=completed`、`usage={input:42, output:10}`；正文含且仅含一次 `A5_LUNA_R3`。凭据来自本机既有 Codex 登录（`gatewaySubscription` 只读路径），未发起任何新 OAuth，未复制、未打印令牌。收据不含 token、不含 account id、不含凭据文件内容。

## 4. 凭据保全证明

| 检查点 | 运行前 | 运行后 |
| --- | --- | --- |
| `auth.json` 大小 | 3995 B | 3995 B |
| `auth.json` mtime | 2026-11-07 18:23:19 | 2026-11-07 18:23:19 |

只读取元数据（size/mtime），**未打开正文、未复制、未持久化**；网关在进程内读取该文件用于构造上游 `Authorization`。隔离 `CODEX_HOME` 通过符号链接指向这份既有文件，仅用于只读路径。**该模式不可用于可写的原生 CLI**：CLI 的令牌刷新会沿链接写回用户凭据，这一点是原生子代理 `BLOCKED` 的直接原因之一（§2.1）。

## 5. 明确未声称

没有 Desktop GUI 运行；没有模型选择器观测；没有真实目录对账；没有第二个身份；没有原生父子线程；没有工具/wait/followup；没有中断/恢复；没有真实配置回滚。`PASS_REAL` 只覆盖上表所列的父推理与负向对照两项。

## 6. 真实流量下的观察

**(a) TLS 校验被环境变量静默关闭（环境风险，不是产品缺陷）**
本机操作 shell 导出 `NODE_TLS_REJECT_UNAUTHORIZED=0`。请求 1–2 继承该变量，实际在**未校验证书**的情况下完成。请求 3 以 `env -u NODE_TLS_REJECT_UNAUTHORIZED` 重启后复测通过。任何从这类 shell 启动的进程都会静默失去 TLS 校验，足以让一份"全绿"证据失去意义，因此必须登记。所有者常驻进程 551774 的环境中没有该变量。

**(b) `providers.<id>.apiKey` 被静默忽略（MG-R008 相邻的真实 UX 缺陷）**
`src/router.js:271-283` 的 `resolveKey` 只读 `keys.local.json` 与 `apiKeyEnv`，不读 `providers.<id>.apiKey`。把 key 直接写进 `gateway.json` 时，网关**不报错、不告警**，把请求无凭据地发往上游，操作者只看到上游的 `"requires an API key"`（本次负向对照即由此产生 401）。失败本身是 fail-closed 的，但归因信息不精确，属于"失败必须显示精确原因"的对立面。**修复待定，本文件不修**。

**(c) SSE 正文配 `content-type: application/json`（归因为上游）**
网关把 `content-type: application/json; charset=utf-8` 与 `event: response.created` 形式的 SSE 正文一起返回。`src/sse.js:20-26` 的 `FORWARD_SAFE_HEADERS` 含 `content-type`，该头由上游透传而非网关自造；但依赖 content-type 判定流式的严格客户端会误解析。仅登记，暂不要求修复。

## 7. 需求状态（本轮增量）

| 需求 | 状态 | 依据 |
| --- | --- | --- |
| MG-R012 | `PASS_REAL` | 请求级脱敏收据见 `docs/evidence/aggregation-real-luna-2026-11-14.md`，证明上游 `model=gpt-6-luna`（`4feafe0e51dc02d48c45734df5b34e70d3679bd5`，三段：200/200/200，无其他 GPT 模型、无自动回退）；订阅域拒绝面的离线不变量由 `agg-auth-subscription.test.mjs` 覆盖；取代 BLOCKED @ docs/evidence/agg-p01-opencode-discovery-2026-11-14.md（该轮零 GPT 调用、无 Luna 授权，属历史快照） |

其余 11 项状态不变，见 [整合证据](./aggregation-integration-2026-11-14.md) §8 与 [验收矩阵](./aggregation-acceptance-matrix.md)。
