# Codex：保留原生套餐，同时接入 ModelGate 的其他订阅模型

问题：Codex 原生套餐（ChatGPT 登录）和 OpenCode Go / OpenRouter 等其他订阅，能否同时使用而不互相干扰？

结论：**能，但要按“启动 profile / 单次覆盖”隔离，不能假设同一交互会话内无缝切换 provider。**

本机实测（2026-11-10，Codex CLI 0.167.0 / ChatGPT Desktop 26.1103.32239）：

- 当前默认：`model=gpt-6.1-sol`，`model provider=openai`，`auth mode=chatgpt`（`~/.codex/auth.json`），即原生 ChatGPT 套餐路径。
- 临时 CODEX_HOME 中验证：默认 provider 与 ModelGate profile 分别启动，互不影响；两个会话并发执行，均 exit 0。
- 真实链路验证：Codex → ModelGate（8789）→ OpenCode Go `deepseek-v4.1-flash`，exit 0、输出 `MODELGATE_REAL_OK`。
- **同一 thread 不能换 provider**：`/model` 只列出当前 provider 的模型；`codex exec resume` 跨 provider 被 Codex 明确拒绝（`modelProviderMismatch`）。
- **Desktop 单实例只有当前 provider**：协议支持 per-thread `modelProvider`，但 Desktop 创建线程时传 `modelProvider:null`（默认配置），UI 没有 profile/provider 选择器。

## 方案 A：不改任何 Codex 配置文件（推荐先试）

用单次 `-c` 覆盖，默认 `codex` 仍是原生套餐；只有这条命令走 ModelGate。

```bash
# 网关启用客户端 Key 时，把值放在环境变量里；未启用时用任意非空占位值即可。
export MODELGATE_API_KEY='<网关客户端 Key 或占位值>'

codex -c 'model_provider="modelgate"' \
      -c 'model="deepseek-v4.1-flash"' \
      -c 'model_providers.modelgate.name="ModelGate"' \
      -c 'model_providers.modelgate.base_url="http://127.0.0.1:8787/v1"' \
      -c 'model_providers.modelgate.wire_api="responses"' \
      -c 'model_providers.modelgate.env_key="MODELGATE_API_KEY"'
```

建议做成 shell alias / 小脚本，例如 `codex-ds`。它不会修改 `~/.codex/config.toml`，也不会碰 `auth.json`。

## 方案 B：独立 profile 文件（长期使用）

Codex 0.167 的 `-p/--profile` 会在基础配置之上叠加 `$CODEX_HOME/<name>.config.toml`（不是 `[profiles]` 表）。

新建 `~/.codex/opencode.config.toml`：

```toml
model = "deepseek-v4.1-flash"
model_provider = "modelgate"

[model_providers.modelgate]
name = "ModelGate"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "MODELGATE_API_KEY"
```

使用：

```bash
codex                 # 原生 ChatGPT / 当前默认 provider
codex -p opencode     # OpenCode DeepSeek（经 ModelGate）
```

默认配置里的 `model_provider=openai` 与 ChatGPT auth 保持不变；profile 只影响带 `-p` 的那次启动。

## ModelGate 侧

- 现有生产配置已有 `opencodego` provider 与 `deepseek-v4.1-flash`；也可用模型别名/虚拟模型把多个订阅收口成一个入口。
- 若网关启用了客户端 Key（`MG_CLIENT_KEY` / `defaults.clientKey`），把同一 Key 放进 `MODELGATE_API_KEY`；未启用时用占位值。
- ModelGate 只承载“其他订阅”的流量；原生 ChatGPT 流量仍直连 OpenAI，不经过网关，因此不受网关限流/统计/路由影响。

## 已验证的边界（不是猜测）

### 1. 同一交互会话内不能换 provider

- TUI `/model` 只列出当前 provider 的模型目录；本机默认 native mock 时只显示 GPT-6.x 系列，不显示 ModelGate 的 `deepseek-fixture`。
- 用 `codex exec resume <thread-id> -c 'model_provider="modelgate"' ...` 续接同一 thread 会被拒绝：

  ```text
  thread/resume failed: This chat uses native, but your current provider is modelgate.
  Switch to native to continue. (code -32600, type modelProviderMismatch)
  ```

- **结论：一个 thread 绑定一个 provider。** 正确做法是开新会话（`codex -p opencode`）或两个终端；不要期待在同一个对话里原地切换。
- 这与原生套餐无关：Codex 自身就是这么设计的，网关无法在不伪造 provider 身份的情况下绕过。

### 2. Codex Desktop：单实例只能用一个 provider

- 安装的是 ChatGPT Desktop `26.1103.32239`，内置 Codex 0.167.0。
- Desktop 的 app-server 协议确实支持在 `thread/start`、`thread/resume`、`thread/fork` 传 `modelProvider`。
- 但 Desktop bundle 创建用户线程时固定传 `modelProvider:null`（走默认配置），模型列表请求也没有 provider 过滤；UI 没有 profile/provider 选择器。
- **结论：同一个 Desktop 实例里，原生套餐和 ModelGate 模型不能混用/切换。**
- 可行路径：
  1. **推荐**：Desktop 保持原生；需要 OpenCode/其他订阅时用 Codex CLI 的 profile/alias。
  2. 用独立的 `CODEX_HOME` 启动第二个 Desktop 实例（bundle 确实读取 `CODEX_HOME`），把该实例默认 provider 配成 ModelGate。该方式需要独立登录/独立用户数据目录，**未在本机做端到端 GUI 验证**，不要把它当成已交付能力。
- 不要通过改默认 `model_provider` 来“同时使用”：那会把原生套餐切走，且旧 thread 会触发 `modelProviderMismatch`。

### 3. 托管工具（namespace / web_search）的保真

- **原生 Responses 上游**（模型或 provider 的 `api="responses"`）：网关把 `tools` 原样转发，`web_search`/`namespace` 保留；本机 wire 测试断言上游收到 3 个工具且没有改写。`/api/status` 现在给每个模型标 `hostedTools:"native"`。
- **Chat 桥**（OpenCode 等 Chat 上游）：`web_search`/`namespace` 无法用 Chat 工具表达，网关**显式丢弃并记 lossy**，只保留函数工具；状态标 `hostedTools:"chat-bridge-lossy"`。这不是“完整工具兼容”，也不应如此宣称。
- **要完整托管工具**：必须接一个原生实现 Responses 且支持这些工具的上游。OpenCode 的 Chat API 本身不提供 `web_search`/`namespace`，网关无法凭空补齐；不要指望通过配置开关让 Chat 上游获得这些能力。

### 4. 原生流量不进网关统计 → 用只读采集补齐

- 原生 ChatGPT 流量直连 OpenAI，不经过 ModelGate，因此不会出现在网关的请求/Token/限流统计里。这是“不干预原生套餐”的必然结果。
- 本轮新增 **原生/直连用量只读采集**：
  - 后端 `GET /api/native-usage?days=7`，实现 `src/native-usage.js`。
  - 只读取 Codex sessions 的 `session_meta`（provider）、`turn_context`（model）、`token_count`（usage）；**不读取消息正文**。
  - 默认关闭；在「安全与设置 → 原生 / 直连用量采集」填 `~/.codex/sessions`（或 `MG_NATIVE_USAGE_DIR`）后启用。
  - 「监控与诊断」新增独立卡片，与代理流量分开显示；标签明确“只读采集、不代理”。
- 它提供的是**观察**，不是限流/配额：原生请求仍由 OpenAI 套餐自身计费与限流。

### 5. 不要动 `auth.json`

原生套餐的 OAuth 凭据保持原样；ModelGate profile 只用 `env_key`，不要把真实 Key 写进 `config.toml`。验证并发时分别观察两边会话；网关日志只覆盖经过网关的那一路。
