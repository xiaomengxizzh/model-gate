# ADR-0003：Codex 0.167.0 角色不应用 model_provider 的边界（P01）

- 状态：Accepted（2026-11-12，离线边界；真实验收仍归 Q02/Q03）
- 范围：原版 Codex CLI **0.167.0** 的 role / 子代理 provider 选择；不覆盖 Desktop 差异、不覆盖 SIWC 自有预览客户端。
- 关联：[ADR-0002 多供应商聚合身份](adr-0002-codex-aggregation-identity.md)、[Codex 配置参考](../reference/codex-config.md)、[反向 fixture 说明](../../scripts/test/fixtures/codex/README.md)。

## 1. 结论（锁定边界）

对 0.167.0，**角色（role）不能改变 `model_provider`**。子 turn 的 provider 由父 turn 复制而来；role 覆盖白名单不含 `model_provider`。role 可以换 `model`，但只在继承到的同一 provider 身份内换模型。

因此：

1. 任何“给子代理配另一个 `model_provider` 来实现跨供应商”的设计，在 0.167.0 上**不成立**，不得作为 M2 的实现依据。
2. 原生跨供应商只能走 ADR-0002 的单一 provider 身份（内置 `openai` + `openai_base_url` 指到网关），由网关按模型选择上游；这不是 role 能力。
3. 若 role 配置里出现 `model_provider`，按**反向 fixture**处理：不应用、不据此路由，并产生明确诊断。不得静默把它当作已生效。
4. 网关不得依据 role 名、`agent_type`、UA、`client_metadata` 或任何客户端头做授权或路由判定；只依据显式路由配置与实际请求 `model`。
## 2. 证据等级（本 ADR 的诚实边界）

| 等级 | 含义 | 本卡是否具备 |
| --- | --- | --- |
| `CITED_UPSTREAM_SOURCE` | 计划包引用了 upstream 源码路径/行号；本环境**未重新抓取** | 有（见 §3） |
| `UNKNOWN_PRIMARY_SOURCE` | 没有本地 upstream 源码检出，且禁网，无法独立复核 | 是 |
| `SYNTHETIC_FIXTURE` | 由本仓库合成 parser/app-server fixture 与离线测试锁定 | 有（见 §5） |
| `BLOCKED_ENV` | 已安装 CLI 在本环境无法启动，真实 CLI 用例未执行 | 是（见 §3.2） |
| `UNKNOWN_LIVE` | 真实账户/真实上游行为 | 是（Q02/Q03 前不可声称） |

“锁定”指**工程边界**已固定并可回归；不等于已完成真实 CLI 验收。

## 3. 版本与现场证据（只读）

### 3.1 版本

- 本机既有安装：`/home/xiaomengxizi/ai/harness/codex/cli/versions/0.167.0/`。
- 该目录 `package.json` 的 `version` 为 `0.167.0-linux-x64`（只读读取，未安装、未升级、未登录）。
- 源码引用（来自计划包，未重新抓取）：
  - `openai/codex` @ `rust-v0.167.0`：`codex-rs/core/src/agent/child_config.rs` —— 子 turn 从父 turn 复制 provider；
  - `codex-rs/core/src/agent/role.rs#L69-L113` —— role 覆盖白名单**不含** `model_provider`。

> 这两条是 `CITED_UPSTREAM_SOURCE`。本机没有 Rust 源码检出，P01 全程禁网，因此**不能**声称已独立复核源码正文（`UNKNOWN_PRIMARY_SOURCE`）。

### 3.2 本机 CLI 执行：BLOCKED_ENV

隔离环境（临时 `HOME` / `TMPDIR` / `CODEX_HOME`，无凭据、无网络请求）尝试：

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=<B-home> TMPDIR=<B-tmp> \
  CODEX_HOME=<B-home>/codex-home \
  codex --version
```

结果：**exit=1**，launcher 在 exec 前失败：

```text
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.
```

这与已知的宿主限制一致（unshare/bwrap 不可用）。因此本卡**没有**执行任何 Codex turn、没有读取 `auth.json`、没有访问真实会话或真实上游。真实 CLI 行为归 Q02，且要求 OS 级出网隔离。

## 4. 四矩阵

字段说明：`parent.provider` 是父 turn 的 provider；`role.model_provider` 是 role 里写的值；`expected` 是 0.167.0 边界下的期望。

| id | 形态 | parent.provider | role.model_provider | expected.provider | expected.model | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `official-direct` | 官方直连（对照） | `openai` | `openai` | `openai` | role 的 `model` 生效 | `CITED_UPSTREAM_SOURCE` + `BLOCKED_ENV`；live 属 Q03 |
| `mock-dual-provider` | 本地双 mock（反向） | `probe-a` | `probe-b` | **`probe-a`（不切换）** | role 的 `model` 生效 | `CITED_UPSTREAM_SOURCE` + `SYNTHETIC_FIXTURE`；真 CLI 属 Q02 |
| `same-provider` | 同 provider 换模型 | `probe-a` | `probe-a` | `probe-a` | role 的 `model` 生效 | `CITED_UPSTREAM_SOURCE` + `SYNTHETIC_FIXTURE` |
| `siwc-preview` | SIWC 自有预览 | `siwc-registration` | 不适用（无原生 role） | `siwc-registration` | 由预览客户端自身固定 | `OUT_OF_SCOPE_NATIVE_ROLE`；未实现、未开放登录 |

矩阵同时固化在 [`role-provider-matrix.json`](../../scripts/test/fixtures/codex/role-provider-matrix.json)，由离线测试逐行断言：**没有任何一行的 role 能改变 provider**。
## 5. 反向 fixture（合成 parser / app-server）

写集：

- [`role-provider-matrix.json`](../../scripts/test/fixtures/codex/role-provider-matrix.json)：版本、provenance、四矩阵、证据/状态枚举、终止条件。
- [`role-provider-0.167.0.mjs`](../../scripts/test/fixtures/codex/role-provider-0.167.0.mjs)：受限 parser + `resolveChild()` 合成模型。**不是 upstream 源码**，不执行 CLI、不读文件/环境/凭据、不联网。
- [`roles/0.167.0-negative.toml`](../../scripts/test/fixtures/codex/roles/0.167.0-negative.toml)：隔离客户配置夹具（loopback、合成 key 名，**不写入真实 HOME**）。其中 role 段故意声明 `model_provider = "probe-b"`，父级为 `probe-a`。
- [`codex-role-provider.test.mjs`](../../scripts/test/offline/codex-role-provider.test.mjs)：离线回归。

合成模型的行为：

1. `provider` 恒等于 `parentProvider`；缺失父 provider 时 **fail closed**（返回 `null` + `parent_provider_missing`），不臆造。
2. role 的 `model_provider` 记入 `ignored`，诊断 `role_model_provider_not_applied`，绝不应用。
3. role 的 `model` 记入 `applied`，只改模型名。
4. 未知 role 字段记 `role_field_unknown:<key>`，不应用、不推断语义；完整白名单属 `UNKNOWN_PRIMARY_SOURCE`。
5. 输入对象不被修改；parser 只支持 `[section]` 与 `key = "string"`，遇到其它语法定向抛错，避免假装理解通用 TOML。

为什么是“反向”：它验证的是 **0.167.0 不支持的行为**（role 换 provider）必须被忽略并留诊断，而不是被当作可用能力。未来只有新客户端版本**正式**支持 role-level provider 时，才允许新增正向用例；届时本 ADR 需 supersede。

## 6. 发送前终止条件

以下任一成立即**在出网前拒绝**，不得解密、不得删除密文后继续、不得静默降级 v1：

1. 输入含不可读密文（`encrypted_content` / `encrypted_task_id` / 非空 `encrypted_function_args`）。
2. 含未支持的关键工具或无法保真的工具身份/配对。
3. 没有合法明文委派路径。

此时报 `BLOCKED_VENDOR_CAPABILITY`（或 P02/P04 定义的 typed error），并保留可复现证据；不得伪造子代理、通知或成功终态。

## 7. 对下游卡的约束

- **P02**：可读历史/控制项分类不得依赖 role 换 provider；不可读密文在发送前拒绝。
- **P04**：工具 identity 与 SSE 只恢复本轮已声明的身份；namespace 工具不因 role 配置获得额外权限。
- **P05**：生命周期夹具只能建模“同一 provider 身份 + `spawn_agent.model` 覆盖”；不得把 role `model_provider` 当可切换开关。真实 CLI 执行归 Q02。
- **N01**：客户端配置样例/模板不得生成 role-level `model_provider`；仍按 ADR-0002 使用内置 `openai` 身份。
- **P07**：SIWC preview 是自有客户端路径，与原生 role 无关；未满足条件的客户端不暴露登录。

## 8. UNKNOWN / NOT_RUN

- `UNKNOWN_PRIMARY_SOURCE`：未在本机复核 `child_config.rs` / `role.rs` 正文；源码引用来自计划包。
- `UNKNOWN_PRIMARY_SOURCE`：role 覆盖白名单的完整字段集（本 ADR 只锁定 `model_provider` 不在其中）。
- `BLOCKED_ENV`：本机 0.167.0 CLI 无法启动（bwrap 不可用），真实 parser/app-server 行为未执行。
- `UNKNOWN_LIVE`：官方订阅直连、双 mock 真 CLI、同 provider 真 CLI 的运行时行为均未执行；需 Q02（双 mock、OS 隔离）与 Q03（真实授权）。
- **Desktop 未验证**：Desktop 捆绑版本独立冻结、独立判定；本 ADR 不对其作结论。

## 9. 重开条件

满足任一即重开本 ADR：

1. 新客户端版本**正式**支持 role-level `model_provider`（需官方文档/源码 + 真实 CLI 证据）。
2. 本机可获得锁定版本的 upstream 源码并完成只读复核，替换 `UNKNOWN_PRIMARY_SOURCE`。
3. Q02 在 OS 隔离下完成真实双 mock 反向用例，替换 `BLOCKED_ENV` 证据。
4. Desktop 版本行为与 CLI 不同，需单独 ADR 或补充矩阵行。

## 10. 回滚

纯文档与新增 fixture/测试，无运行时代码、无配置、无数据迁移。删除本 ADR 与 `scripts/test/fixtures/codex/` 下对应文件、移除离线测试登记即可回到 P01 前状态。
