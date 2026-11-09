# Codex：保留原生套餐，同时接入 ModelGate 的其他订阅模型

问题：Codex 原生套餐（ChatGPT 登录）和 OpenCode Go / OpenRouter 等其他订阅，能否同时使用而不互相干扰？

结论：**能，但要按“启动 profile / 单次覆盖”隔离，不能假设同一交互会话内无缝切换 provider。**

本机实测（2026-11-09，Codex CLI 0.167.0）：

- 当前默认：`model=gpt-6.1-sol`，`model provider=openai`，`auth mode=chatgpt`（`~/.codex/auth.json`），即原生 ChatGPT 套餐路径。
- 临时 CODEX_HOME 中验证：默认 provider 与 ModelGate profile 分别启动，互不影响；两个会话并发执行，均 exit 0。
- 真实链路验证：Codex → ModelGate（8789）→ OpenCode Go `deepseek-v4.1-flash`，exit 0、输出 `MODELGATE_REAL_OK`。

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

## 边界

- **同一交互会话内切换 provider 未验证**：Codex 的 `-p` 是启动级；稳妥做法是两个终端/两个 profile。TUI 的 `/model` 是否能跨 provider 取决于版本，本机未验证。
- **Codex Desktop 未验证**：CLI 证据不能替代桌面端；桌面端是否暴露 profile 选择需单独确认。
- **工具保真**：OpenCode 走 Chat 协议时，Codex 的 `namespace`/`web_search` 等托管工具会被网关显式丢弃并记 `lossy`；函数工具可用。需要完整托管工具时，应接原生 `api:"responses"` 上游。
- **不要动 `auth.json`**：原生套餐的 OAuth 凭据保持原样；ModelGate profile 只用 `env_key`，不要把真实 Key 写进 `config.toml`。
- 验证同一“原生 + 其他订阅”并发时，建议分别观察两边会话；网关日志只覆盖经过网关的那一路。
