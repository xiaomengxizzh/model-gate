# Codex 聚合模型目录（E2）

> 状态：E2 离线实现与验证完成（2026-11-11）；真实客户端加载与同会话切换属 E3，NOT_RUN。
>
> 对应决策：D2（动态维护本地 Codex JSON）、D1-A（内置 openai 身份下的本地目录）。
>
> 实现：`src/codex/catalog.js`（纯函数）、`scripts/codex-catalog.mjs`（CLI）、`scripts/test/offline/codex-catalog.test.mjs`（离线测试）。

## 1. 为什么需要生成器

Codex 0.167 的 `model_catalog_json` 是**整体替换**语义：文件里的 `models` 数组就是客户端看到的全部模型，而不是在官方目录之上做增量。因此：

- 普通 OpenAI `/v1/models` 的 `{object:"list",data:[{id,...}]}` **不能**当目录使用；
- 只放第三方条目的"最小目录"会失败（缺 `supported_reasoning_levels` 等字段直接启动失败）；
- 想同时保留官方模型和第三方模型，必须输出**官方全量 + 第三方增量**的完整 `ModelInfo` 合并结果。

生成器把"官方目录（`codex debug models` 导出）"与"ModelGate 已配置第三方模型"合并成一份自包含目录，并负责校验、稳定 ID、版本、回滚与差异摘要。

## 2. Codex 0.167 契约（实测）

在本机 Codex CLI 0.167.0（`harness/codex/cli/bin/codex`，musl vendor 构建）上用 `CODEX_HOME=<临时目录> codex debug models -c 'model_catalog_json="<file>"'` 逐项探测：

### 2.1 serde 必填字段

从只含 `slug` 的对象开始，按报错逐个补齐，实际必填集合为：

| 字段 | 说明 |
| --- | --- |
| `slug` | 模型 ID；解析器不限制字符集，但聚合目录只允许 `[A-Za-z0-9._-]` |
| `display_name` | 选择器显示名 |
| `supported_reasoning_levels` | 非空数组，元素 `{effort, description}` |
| `shell_type` | `default / local / shell_command / unified_exec / disabled` |
| `visibility` | `list / hide / none` |
| `supported_in_api` | 布尔 |
| `priority` | 非负整数（官方样本为 1–13、43，升序排列） |
| `support_verbosity` | 布尔 |
| `truncation_policy` | `{mode: bytes|tokens, limit: 正整数}` |
| `experimental_supported_tools` | 字符串数组 |
| `base_instructions` 或 `model_messages.instructions_template` | 二者至少一个；都缺时报 missing both |

其余字段 Codex 都有 serde 默认值：省略不会解析失败，但会静默退化成未知能力（例如 `context_window` 变成 undefined）。所以聚合目录额外把 `context_window` / `max_context_window` 列为**策略必填**。

### 2.2 类型与枚举

- `context_window` / `max_context_window` 是 `i64`：小数会被拒绝；`0` 能解析但等于"未知能力"，生成器拒绝。
- `apply_patch_tool_type` 目前只接受 `freeform`。
- `default_verbosity`：`low / medium / high`；`default_reasoning_summary`：`auto / concise / detailed / none`。
- `web_search_tool_type` 接受字符串或对象，**拒绝 null**；`service_tiers`、`additional_speed_tiers` 必须是数组（可为空），**拒绝 null**。
- 未知字段在顶层和模型层都被忽略（`codex debug models` 原样回显）。生成器仍保持输出文件只含 `models`，元数据放独立 sidecar。
- 重复 `slug` 解析器接受，但选择器会歧义 → 生成器 fail-closed。
- 缺模型元数据时客户端运行时告警 "Model metadata for … not found. Defaulting to fallback metadata"，这正是 M1 里"列表可见但能力退化"的根源。

### 2.3 两条消费路径是同一个结构

- 本地文件：`-c model_catalog_json="<abs file>"`；
- 远端列表：官方身份下 Codex 会先 `GET {base_url}/v1/models?client_version=0.167.0`，返回 `{"models":[完整 ModelInfo…]}` 时客户端不再告警 fallback metadata（Lead 实测，mock 返回 1 条）。

两条路径使用同一个 `ModelsResponse { models: ModelInfo[] }` 结构，因此 CLI 的 `--format=catalog-json|codex-models` 输出**同一份字节**：单一真源，避免两路径漂移。`--format` 只影响元数据记录与默认文件名，便于将来区分发布渠道。请求体编码（含官方路径可能使用 zstd 的 `content-encoding`）与目录无关。

## 3. 输入

### 3.1 官方基线

必须是 `codex debug models` 的原始输出：

```bash
CODEX_HOME=<临时目录> codex debug models > /tmp/mg-e2/official-catalog.json
```

`--base` 接受文件路径或目录（目录下按 `catalog.json`、`models.json` 顺序查找）。基线自身必须通过同一套校验闸门；不通过直接失败。

### 3.2 ModelGate 配置（可选）

`--models <gateway.json>` 读取现有配置形状：

```json
{
  "providers": { "opencode-go": { "name": "OpenCode Go" } },
  "models": {
    "deepseek-v3": {
      "provider": "opencode-go",
      "capability": "chat",
      "maxContext": 128000,
      "effortOptions": ["low", "medium", "high"],
      "reasoning": "medium"
    }
  }
}
```

纳入规则：

| 情况 | 行为 |
| --- | --- |
| `provider` 属于 `openai / chatgpt / codex / openai-official / openai-codex`（可用 `--official-provider` 覆盖） | 跳过：官方模型已在基线目录里，不重复生成 |
| `capability` 非 `chat`（embedding/rerank/audio/image/video） | 跳过：不进 Codex 模型选择器 |
| `disabled: true` | 跳过 |
| 模型名与官方 `slug` 相同 | 失败：聚合模型不得遮蔽官方 ID |

### 3.3 每个第三方模型的可选 `codex` 覆盖

```json
"deepseek-v3": {
  "provider": "opencode-go",
  "maxContext": 128000,
  "codex": {
    "displayName": "DeepSeek V3 (OpenCode Go)",
    "description": "…",
    "contextWindow": 128000,
    "maxContextWindow": 128000,
    "modalities": ["text"],
    "reasoningLevels": ["low", "medium"],
    "defaultReasoningLevel": "medium",
    "priority": 44,
    "visibility": "list",
    "multiAgentVersion": "v1",
    "webSearchToolType": "text",
    "baseModel": "gpt-6-astra",
    "supportedInApi": true,
    "experimentalSupportedTools": [],
    "toolMode": "code_mode_only"
  }
}
```

`codex` 里出现未列出的字段会直接报 `unknown_override_field`（防止拼写错误被静默忽略）。

## 4. 合并算法

1. 校验基线目录（serde 必填 + 枚举 + 重复 slug + 上下文）。
2. 选择模板模型：`--template-model`，否则第一个 `visibility=list` 且 `supported_in_api!=false` 的官方模型（官方 0.167 样本为 `gpt-6-astra`）。
3. 每个第三方模型 = **深拷贝模板** + 覆盖能力字段：
   - 覆盖：`slug / display_name / description / visibility / supported_in_api / priority / supported_reasoning_levels / default_reasoning_level / context_window / max_context_window / input_modalities`；清空 `additional_speed_tiers`、`service_tiers`、`experimental_supported_tools`，删除 `comp_hash`。
   - 继承：`base_instructions / model_messages / shell_type / support_verbosity / truncation_policy / apply_patch_tool_type / web_search_tool_type / use_responses_lite / tool_mode / multi_agent_version` 等客户端行为字段。原则是"能力由 ModelGate 声明，客户端行为跟随官方模板"，保证同一会话切换模型时客户端语义一致。
4. priority：默认从官方最大 priority + 1 递增（官方样本最大 43 → 第三方 44、45…），即排在官方模型之后。
5. 生成完整目录后再跑一次校验；通过才允许落盘。

模板继承的代价：每个第三方条目会带上官方 `base_instructions`（官方样本约 21 KB/模型），目录体积约 `(12+第三方数) × 60 KB`。12 官方 + 2 第三方实测 915 KB。

## 5. 稳定聚合 ID 与绑定

- 形态：`mg-<provider>-<model>`，两段都做小写化并把非 `[a-z0-9]` 折叠为 `-`。例：`opencode-go` / `deepseek-v3.2` → `mg-opencode-go-deepseek-v3-2`。
- 不做哈希后缀：ID 由来源唯一决定，可人工核对；代价是不同原始名可能折叠成同一个 ID。
- 因此 state 记录 `bindings[slug] = {provider, model, providerName, capability}`，每次生成与上一版本比较：
  - 同一 slug 指向不同 provider/model → `stable_id_rebinding`，退出码 4，状态不推进（D2 禁止同名新模型偷换身份）；
  - 已退役的 slug（`retiredBindings`）被重新用于不同目标 → `retired_id_reuse`，同样失败；
  - 同一模型换 provider 会得到新 ID（旧 ID 退役），这是刻意设计：迁移必须显式发生，不能静默改绑。

## 6. 来源与置信度

每个第三方条目在 sidecar 元数据中记录：

| 字段 | 可能置信度 | 说明 |
| --- | --- | --- |
| `contextWindow` / `maxContextWindow` | `declared` | 必须来自 `maxContext` 或 `codex.*`；缺失直接失败，不猜数字 |
| `reasoningLevels` | `declared` / `assumed` | 来自 `effortOptions`、`reasoning` 或 `codex.reasoningLevels`；都没有时按 `['medium']` 生成并记 `assumed_reasoning_levels` 警告 |
| `inputModalities` | `declared` / `assumed` | 默认只声明 `['text']`（不假定第三方支持图片） |
| `baseInstructions` / 客户端行为字段 | `inherited` | 记录来源官方模板 slug |
| `multi_agent_version` | `inherited` / `declared` | 默认继承模板的 `v2`；v2 加密任务跨供应商可读性属 E4，尚未验证（见 §10） |

元数据同时保留 `inheritedFields` / `overriddenFields`，便于 E6 UI 展示"哪些能力是声明的、哪些是继承的"。

## 7. CLI

```bash
# 生成（官方基线 + ModelGate 第三方）
node scripts/codex-catalog.mjs --base /tmp/mg-e2/official-catalog.json --models /tmp/mg-e2/gateway.json --out /tmp/mg-e2/work/catalog.json --state-dir /tmp/mg-e2/work/state --format catalog-json --verify-codex

# 只预览差异
node scripts/codex-catalog.mjs --base <file|dir> --models <file> --out <file> --dry-run

# 机器可读
node scripts/codex-catalog.mjs ... --json

# 状态 / 版本 / 回滚
node scripts/codex-catalog.mjs --status --out <file> --state-dir <state>
node scripts/codex-catalog.mjs --list-versions --state-dir <state>
node scripts/codex-catalog.mjs --rollback prev --out <file> --state-dir <state>
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--base` | 必填 | 官方目录文件或目录 |
| `--models` | 无 | ModelGate 配置；省略则只输出官方模型 |
| `--out` | 必填 | 目录文件；拒绝写入 `~/.codex` |
| `--format` | `catalog-json` | `catalog-json` / `codex-models` |
| `--state-dir` | `<out 目录>/.codex-catalog` | 版本/回滚状态 |
| `--template-model` | 首个可见官方模型 | 第三方条目的继承模板 |
| `--official-provider` | `openai,chatgpt,codex,…` | 可重复；这些 provider 视为官方直连 |
| `--history-limit` | 5 | 保留最近 N 版 |
| `--priority-start` | 官方最大 + 1 | 第三方 priority 起始 |
| `--strict` | 关 | 警告升级为错误 |
| `--allow-unknown-efforts` | 关 | 未知推理档位不告警（Codex 解析器本身接受任意字符串） |
| `--verify-codex` | 关 | 发布前用 `codex debug models` 离线解析生成物；失败即中止且不发布 |
| `--codex-bin` | `PATH` 中的 `codex` 或 `MG_CODEX_BIN` | 验证用可执行文件 |
| `--codex-home` | 系统临时目录 | 验证用 `CODEX_HOME`；绝不使用真实 `~/.codex` |

退出码：`0` 成功；`2` 用法/路径守卫；`3` 校验或生成失败；`4` 身份冲突（重绑定/ID 冲突）；`5` IO；`6` codex 校验失败。

## 8. 校验闸门（fail-closed）

任何错误都在落盘前抛出，不会留下"半个目录"：

```text
catalog_shape / openai_list_shape           输入不是 Codex ModelsResponse
base_catalog_invalid                        基线目录自身不合法
missing_required_field                      serde 必填字段缺失（如 supported_reasoning_levels）
missing_instructions                        base_instructions 与 instructions_template 都缺失
missing_capability_field                    context_window / max_context_window 缺失
invalid_type / invalid_enum                 类型或枚举不合法
duplicate_slug                              重复 slug
default_reasoning_level_unsupported         默认档位不在支持列表
context_window_order                        max_context_window < context_window
stable_id_rebinding / retired_id_reuse      聚合 ID 被重绑定（退出码 4）
slug_collision                              两个配置项折叠成同一 ID
official_slug_reuse                         遮蔽官方模型 ID
third_party_context_missing                 第三方上下文未知（不猜）
unknown_override_field                      codex 覆盖字段拼写错误
```

警告（不阻断）：`assumed_reasoning_levels`、`default_reasoning_level_fallback`、`unknown_reasoning_level`、`slug_charset`、`unknown_model_field`、`unknown_top_level_field`、`listed_but_not_api`。`--strict` 把警告升级为错误，供发布流水线使用。

## 9. 版本化、回滚与状态

状态目录布局：

```text
<state-dir>/
  state.json                          当前版本 + 最近 N 版 + 绑定 + 退役绑定
  versions/v000003-<sha8>.json        已发布目录（逐字节快照）
  versions/v000003-<sha8>.meta.json   该版本的元数据（绑定、来源、警告、校验记录）
```

`state.json` 记录：`currentVersion`、`current`（version/file/sha256/generatedAt/counts/sourceFingerprint/bindings/verified）、`history`（保留最近 `--history-limit` 版）、`retiredBindings`、`lastRollback`。

- 源指纹：官方目录 sha256 + 配置 sha256 + 模板 + priority 起始的合并哈希，用于判断"输入是否变了"。
- 发布顺序：版本文件 → 输出文件 → `state.json`（提交点）。若输出写入失败，状态不推进；下次生成会得到同一版本号。
- `--rollback prev|<版本号>|v000003|<sha 前缀>`：先校验目标版本（含 sha256 完整性），再原子覆盖输出文件并把 `current` 指回该版本；`history` 保留较新版本，可再次前滚。
- `--status`：输出 `published`（已发布）、`out.matchesPublished`、`out.clientMayBeStale`（输出文件被外部改动或缺失）、`verified`（codex 实际解析记录，未跑为 NOT_RUN）。

## 10. 已知边界与 NOT_RUN

- **真实客户端加载未验证**：本轮只用 `codex debug models` 离线解析；真正启动 Codex CLI/Desktop、在 `/model` 里同时看到官方与第三方、以及同一线程 GPT→第三方→GPT 属 E3，NOT_RUN。
- **远端 `/v1/models` 由网关提供**属 E1/E6 接线；本模块只负责产出该形状的字节与校验，不修改 `src/index.js`。
- **`multi_agent_version` 默认继承模板（官方样本为 `v2`）**：第三方线路上的 v2 加密任务可读性属 E4，当前未验证。若 E4 判定不可读，应在 `codex.multiAgentVersion` 里显式声明，而不是靠生成器猜。
- **`web_search_tool_type` 继承模板**：Schema 不接受 null/禁用值；第三方是否真能承载 hosted web_search 取决于 Responses/Chat 桥（E4 的有损工具问题），目录层无法表达"部分支持"。
- **模板继承 `base_instructions`**：第三方模型会以官方系统提示运行；这是客户端行为一致性选择，不代表第三方模型真实能力等同官方。
- **未写入任何正式配置**：不写 `~/.codex`（路径守卫会拒绝），不重启客户端，不做真实付费调用。

## 11. 验证证据（2026-11-11）

```text
$ node scripts/codex-catalog.mjs --base /tmp/mg-e0/catalog-default.json --models /tmp/mg-e2/gateway-catalog-input.json --out /tmp/mg-e2/evidence/catalog.json --state-dir /tmp/mg-e2/evidence/state --verify-codex --codex-bin harness/codex/cli/bin/codex
catalog v1 -> /tmp/mg-e2/evidence/catalog.json
format: catalog-json | schema: modelgate.codex-catalog/1
models: 14 (official 12, third-party 2)
version: versions/v000001-50e29f8b.json (history 1)
verified: codex 0.167.0, 14 models parsed

$ CODEX_HOME=/tmp/mg-e2/evidence/codex-home codex debug models -c 'model_catalog_json="/tmp/mg-e2/evidence/catalog.json"'
# exit 0，14 个模型；slug 尾部为：
#   mg-opencode-go-deepseek-v3-2  (ctx 128000, levels low/medium/high, default medium, priority 44)
#   mg-opencode-go-glm-5          (ctx 200000, levels low/high, default high, priority 45)
```

离线测试：`node --test scripts/test/offline/codex-catalog.test.mjs` → 27 项通过（含 1 项真实 codex 校验，需 `MG_CODEX_VERIFY=1`）。默认 `npm test` 白名单下同一文件 26 项通过、1 项按环境跳过。

## 12. 相关文档

- [配置参考](configuration.md)
- [测试指南](../how-to/testing.md)
- [协议桥接](protocol-bridge.md)