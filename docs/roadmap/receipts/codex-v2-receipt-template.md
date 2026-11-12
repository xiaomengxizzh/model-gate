# 收据模板 · Codex Multi-Agent V2 客户端验收

> 用法：复制本文件到 `docs/roadmap/receipts/<YYYY-MM-DD>-codex-v2-<阶段>-<client>.md` 后逐格填写。
> 规则见[验收矩阵](../2026-11-12-codex-v2-acceptance.md) §9。**三条硬纪律**：①缺指纹/版本/授权块不受理；②状态只用五态枚举；③只写摘要与布尔，不写 Key、Key 片段/长度、请求正文、prompt 全文、账号信息。
> 本模板自身不是证据，不填写的空格一律等价于 `NOT_EXECUTED`。

## 0. 标识

| 字段 | 值 |
| --- | --- |
| 收据 ID | `MG017-<阶段>-<client>-<yyyymmdd>-<序号>` |
| 阶段标签 | `OFFLINE` / `COMPONENT` / `REAL`（**三选一**；`OFFLINE`/`COMPONENT` 不得写成真实验收） |
| 客户端 | `CLI` / `Desktop` / `both` / `none(离线)` |
| 执行人 / 复核人 | ______ / ______ |
| 开始时间 / 结束时间 | `date -Is` → ______ / ______（Asia/Shanghai） |
| 所在工作树与分支 | ______ |
| `git rev-parse HEAD` | ______ |
| `git status --short` 摘要 | ______（有未提交改动时逐项列文件名，不贴内容） |

## 1. 环境指纹

| 项 | 值 | 复核命令 |
| --- | --- | --- |
| Node | `v______` | `node -v` |
| CLI 版本 + sha256 | `codex-cli ______` / `sha256:______` | `$CLI --version`；`sha256sum …` |
| Desktop 捆绑版本 + sha256 | `codex-cli ______` / `sha256:______` | `/usr/lib/chatgpt/resources/codex --version`；`sha256sum …` |
| 实际运行的 bundled app-server argv | ______ | `pgrep -a -f /usr/lib/chatgpt/resources/codex` |
| app-server 自报版本 | `appServerVersion=______` | `… app-server --print-startup-config` |
| 隔离 `CODEX_HOME` | `$ISO/codex` = ______（**不得是 /tmp**） | `echo $ISO` |
| `MG_CONFIG_DIR` / `MG_CONFIG` | ______ / ______ | 同左 |
| 网关口径 | `/healthz`=______；监听端口 ______；`configVersion`=______ | `curl -s $BASE/healthz` |
| **目录指纹** | `sha256:______`（对 `$ISO/manifest.sha256` 再取 hash，见矩阵 §2.8） | `sha256sum $ISO/manifest.sha256` |
| 单文件指纹 | `gateway.json` ______；`config.toml` ______；`catalog.json` ______；`agents/*.toml` ______ | `sha256sum …` |

## 2. 授权块（逐项，缺项即封锁）

| 编号 | 授权项 | 状态（`GRANTED` / `NOT_GRANTED`） | 取值/边界（用户原话摘要） | 授权时间 |
| --- | --- | --- | --- | --- |
| A1 | 认证模式（Platform API Key / ChatGPT 登录+工作区） | ______ | ______ | ______ |
| A2 | 模型与档位（GPT 服务名/effort；DS 服务名/effort） | ______ | ______ | ______ |
| A3 | 费用上限（总额/单请求/失败即停阈值） | ______ | ______ | ______ |
| A4 | 数据范围（合成目录 allowlist、禁止路径、脱敏要求） | ______ | ______ | ______ |
| A5 | 隔离 Desktop 测试配置入口 | ______ | ______ | ______ |
| A6 | 隔离运行面（目录落点、端口范围、回环监听） | ______ | ______ | ______ |
| A7 | 上游凭据放置方式（不进入脚本/日志/Git） | ______ | ______ | ______ |

> 出现任一 `NOT_GRANTED` 或留空 → 相关用例只能记 `BLOCKED_PENDING_AUTHORIZATION`，并且本收据的结论不得给出任何等级。

## 3. 用例行（每个 ID 一行；状态只用五态枚举）

| 用例 ID | 状态 | 运行命令（可复现，含 workdir/env） | 实际输出摘要（脱敏） | 证据文件（路径 + sha256） | 失败归因（client/gateway/upstream/authz） |
| --- | --- | --- | --- | --- | --- |
| CL-__ | `NOT_EXECUTED` |  |  |  |  |
| CL-__ | `BLOCKED_PENDING_AUTHORIZATION` |  |  |  |  |
| DS-__ | `EXECUTED_PASS` / `EXECUTED_FAIL` / `EXECUTED_PARTIAL` |  |  |  |  |

填写规则：

- `EXECUTED_PARTIAL` 必须在「实际输出摘要」里写出**缺哪一项**字段（例：缺 child turn ID，只有 child SID）。
- 退出码、`tests/pass/fail` 计数照抄真实输出；`SKIP`、超时、退出非零都不得写成通过。
- 写「未运行」时不要留空，写 `NOT_EXECUTED`。

## 4. 身份与关联证据（最少集，缺一不收）

| 字段 | root | child | grandchild |
| --- | --- | --- | --- |
| 线程 ID（SID） | ______ | ______ | ______ |
| parent / task path | — | ______ | ______ |
| 创建时间 | ______ | ______ | ______ |
| 供应商 + 服务模型 | ______ | ______ | ______ |
| turn ID（本轮） | ______ | ______ | ______ |
| 工具 call ID | ______ | ______ | ______ |
| 上游响应 ID（可关联） | ______ | ______ | ______ |
| SSE 终态 | ______ | ______ | ______ |

补充证据：

| 项 | 值 |
| --- | --- |
| nonce A（根给出）/ B（沙箱文件内） | ______ / ______ |
| 根是否核对到 A 与 B | ______（B 未进入根 prompt 的证明：______） |
| 恢复前身份（root SID / 既有 child ID / 父子关系） | ______ |
| 恢复后身份（同上，成对记录） | ______ |
| 恢复是否同一会话（依据） | ______ |
| 客户端事件文件（JSONL）路径 + sha256 | ______ |

> **模型自报的身份/模型名不作为任何一格证据。** 上表每一格都必须来自客户端事件、原生线程状态或上游收据。

## 5. 上游收据（每路一段；只写形状与 ID，不写正文）

| 路 | 上游/端点 | 模型（服务名） | 鉴权来源（网关持有 / 客户端透传） | 响应 ID | SSE 事件数 / 终态 | 耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| GPT 根 | ______ | ______ | ______ | ______ | ______ | ______ |
| DeepSeek 子 | ______ | ______ | ______ | ______ | ______ | ______ |
| （孙代理，如涉及） | ______ | ______ | ______ | ______ | ______ | ______ |

边界声明（勾选）：

- [ ] 本轮**无** mock 上游参与（若有 mock，必须写明哪些用例是 mock，且这些行状态不得是 `EXECUTED_PASS` 的真实验收）
- [ ] 本轮**无** Chat 桥参与（仅原生 `api:"responses"` 试点路由）
- [ ] 客户端带来的 `authorization`/`cookie`/`chatgpt-account-id`/`x-api-key` 未被转发到第三方上游（依据：______）

## 6. 脱敏与泄漏扫描

| 检查 | 命令/方法 | 结果 |
| --- | --- | --- |
| 收据与日志无 Key/Token | 在内存里比对变量值，只输出变量名与命中数 | `hits=______` |
| 无请求正文/prompt 全文 | 人工 + `grep` 关键字 | `suspects=______` |
| 无账号标识 | 同上 | `suspects=______` |

## 7. 结论

| 项 | 值 |
| --- | --- |
| 记分卡 | `CARD-API` / `CARD-ChatGPT`（两张分开登记，不互相代偿） |
| 等级 | `基础通过` / `完整通过` / `工作区通过` / `未通过` / `BLOCKED_PENDING_AUTHORIZATION` |
| 通过的用例 | ______ |
| 失败用例（含归因） | ______ |
| 未执行 / 部分执行用例 | ______ |
| 与验收矩阵的偏差 | ______（矩阵需重新签署时写原因） |
| 回退是否执行 | ______（若执行：时间 + 原入口 8787 `/healthz` 状态） |
| 下一步 | ______ |

## 8. 签署

| 角色 | 姓名/代理 | 时间 | 结论 |
| --- | --- | --- | --- |
| 执行 | ______ | ______ | ______ |
| 复核 | ______ | ______ | ______ |
