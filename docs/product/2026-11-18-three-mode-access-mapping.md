# 三模式接入方式映射（直连 / 路由 / 聚合）

> 日期：2026-11-18。状态：设计口径已定，实现进行中（配置形态与状态事务由 P0/P1 落地），**真机验收未完成**。
> 依据：[所有者产品契约](2026-11-14-owner-product-contract.md)（MG-R001–MG-R012） · [聚合实施计划](../roadmap/2026-11-14-aggregation-pseudocode-plan.md) · [Codex 配置参考](../reference/codex-config.md)

## 0. 边界（先读）

- 本文只做**接入方式（access method）到既有契约的映射**，不新增、不改写、不重新解释 MG-R001–MG-R012 的任何条款或验收指标。
- 用词统一为「接入方式」，**不用「新增契约模式」**：三种接入方式是同一产品契约下三种用户可选的配置形态，不是对契约的扩展。
- **不记录任何明文密钥。** 文中 `OPENCODE_API_KEY` 等只是环境变量名 / 字段名，不是值；三种方式都不要求客户端配置 Key（回环信任、无客户端 Key）。本文不给出任何内嵌 Key 字段或 bearer token 的配置示例。

## 1. 三种接入方式 ↔ 契约映射

| 接入方式 | `mode` 值 | 与契约的关系 | 父模型 | 子模型 | GPT 调用 |
| --- | --- | --- | --- | --- | --- |
| 直连 | `official` | 等于 MG-R001 的「退出聚合 / 默认官方套餐保持可用」；请求不经网关 | 官方默认 | 无 | 是（官方直连） |
| 路由 | `route`（新增接入方式） | 属于「经网关的接入」；**纯 DeepSeek 独立呈现** | `mg-opencodego-deepseek-v4-1-flash` | 同一别名 | **否**（`chatgpt-plan` 出站 = 0） |
| 聚合 | `aggregated` | 属于「经网关的接入」；官方 GPT 父 + DeepSeek 子原生父子协作（MG-R005/R006） | 官方 GPT（默认 `gpt-6-luna`） | DeepSeek 别名 | 是 |

必须明确的三点：

1. **直连 = MG-R001 的退出聚合状态。** 网关进程可以仍在运行，但不在请求路径上；直连不需要停网关服务（见[安装、升级与回滚](../how-to/deploy-and-rollback.md)「停止与重启」）。
2. **路由与聚合都属于「经 ModelGate 网关的接入」。** 区别是路由**完全不调用 GPT**，只把同一个 DeepSeek 别名同时作为父与子呈现；聚合则保留 GPT 父并新增 DeepSeek 子。
3. **路由是纯 deepseek 独立呈现**：模型选择器里只出现 DeepSeek 别名，没有官方 GPT 模型入口；任何 GPT 出站都是路由模式的验收失败项。

## 2. config 形态对照表

### 2.1 直连 `official`

- 无重定向字段：`openai_base_url` 不指向网关；**不生成** `[model_providers.modelgate]`；`model_provider` 为内置 `openai`。
- 无父/子解耦，无托管子代理配置。与引入三模式前的官方默认配置字节一致。

### 2.2 路由 `route`（新增接入方式）

独立 `modelgate` provider 段，回环信任、无客户端 Key：

```toml
model_provider = "modelgate"
model = "mg-opencodego-deepseek-v4-1-flash"

[model_providers.modelgate]
name = "ModelGate"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[model_providers.modelgate.capabilities]
remote_compaction = "unsupported"
```

- **无内嵌 Key 字段、无 bearer token、无任何客户端密钥字段。** HTTP 调用只信任本机回环。
- 父 = `mg-opencodego-deepseek-v4-1-flash`，子 = 同一别名；没有 GPT 父。
- 验收硬指标：全程 `chatgpt-plan` 出站 = 0。

### 2.3 聚合 `aggregated`

内置 `openai` 身份 + 顶层重定向 + 本地目录：

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:8787"
model = "gpt-6-luna"
model_catalog_json = "<隔离目录>/models.json"
```

- `openai_base_url` 为网关**根地址，不带 `/v1`**（客户端自行追加 `/v1/...`）；路由模式的 `base_url` 是 provider 级、**带 `/v1`**。两者语义不同，不可混写。
- `model_catalog_json` 提供模型清单与子模型能力声明；不手工维护。
- 父 = 官方 GPT（默认 `gpt-6-luna`），子 = DeepSeek 别名。

> 字段所有权、受控写入与只读保留边界见 [Codex 配置参考](../reference/codex-config.md)。

## 3. 切换 / 重启语义

1. 前端三个接入方式**单选**。
2. 切换走 **预览 → 确认 → 回执**：先给出字段差异与影响（预览、零写入），用户确认后经受控写入落盘，返回回执（含 `needsRestart` 等）。
3. **切换后必须完全退出并重新打开 Codex GUI 才生效**（含从聚合切回直连）。仅关闭窗口、刷新页面或切换会话都不足以让新 `mode` 生效。
4. 切换支持**回滚**：回到上一模式（投影字段 `previousMode`，见[产品状态投影](../contracts/ui-v3-product-status.md)）。回滚同样需要完全退出并重开 Codex GUI。
5. 切换/回滚失败时按 [回滚与降级开关](../how-to/rollback-and-disable.md)「模式切换与回滚」处理（`previousMode` / 备份）。

## 4. 父模型与真实性等级

- GPT 父可选订阅内**任意合法模型**，默认 `gpt-6-luna`；**不得自动替换或降级**。
- 按 MG-R012，真实 GPT 测试调用**仅可使用 GPT-6 Luna**；因此：
  - 只有 `gpt-6-luna` 父可签 `PASS_REAL`（且需真实脱敏收据证明 GPT model 为 Luna）；
  - 其余 GPT 父模型一律标 `UNVERIFIED`，不得签 `PASS_REAL`；
  - 要为其他父模型签 `PASS_REAL`，必须由**所有者书面放宽 MG-R012**，AI 不得自行签或改测试口径。
- 零出站 mock 不构成真实 Luna 验收（MG-R011/MG-R012）。

## 5. 诚实状态与失败项

- 三模式实现进行中；本文描述的是已定设计口径，不代表已全契约通过。
- 真机（原版 Codex Desktop GUI）验收项见[桌面验收手册](../how-to/desktop-acceptance.md)，当前为 `NOT_TESTED` / 待授权。
- 路由模式零 GPT 调用、非 luna 父 `UNVERIFIED`、切换后重启：均为验收必查项，尚未签收。
- 失败项、边界与回滚方案见对应 how-to 文档；任何 `PASS_REAL` 结论必须绑定唯一源码 SHA、环境、命令与脱敏回执，缺一不可（MG-R011）。
