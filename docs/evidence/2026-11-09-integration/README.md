# 2026-11-09 整合候选版证据

本目录保存 `integration/modelgate-next` 候选版的可复核证据。所有 UI 截图来自隔离实例 `127.0.0.1:8788` 与本地 mock 上游；**没有真实上游请求、真实 API Key 或生产配置**。

## 文件

| 文件 | 内容 |
| --- | --- |
| `ui-dashboard-light.png` / `ui-dashboard-dark.png` | 总览，明/暗主题 |
| `ui-providers.png` | 上游供应商（真实状态/配置、Key 来源、掩码 headers） |
| `ui-models.png` | 模型与路由（能力、fallback、额度、虚拟入口） |
| `ui-clients.png` | 客户端接入（模板、原生 Responses/Chat 桥、诚实验证口径） |
| `ui-observability.png` | 监控与诊断（真实指标、Provider 表、日志） |
| `ui-settings.png` | 安全与设置（实例、令牌、韧性参数） |
| `ui-conflict-409.png` | 双写入 409 冲突提示与重新加载 |
| `ui-dashboard-tablet.png` | 820×1180 平板布局 |
| `ui-dashboard-mobile.png` | 390×844 手机布局 |
| `browser-acceptance.txt` | CDP 浏览器验收原始输出（14/14） |
| `client-mock-validation.txt` | DSH 0.2.2-rc.1 × 本地 mock 的 Chat / Responses 桥 / 原生 Responses 结果与阻断说明 |
| `real-client-validation.txt` | Codex CLI / DSH × 真实 OpenCode Go 最小链路、网关记账、GitHub/PR 与 MCP 更正 |
| `raw-codex-real.txt` / `raw-dsh-real.txt` | 真实客户端原始输出（无 Key） |
| `codex-switching-desktop.txt` | Codex TUI `/model`、`resume` 跨 provider、Desktop bundle 与 hosted tools 边界 |
| `ui-observability-native-usage.png` | 观测页“原生 / 直连用量（只读采集）”卡片 |
| `raw-codex-mock-chat.txt` / `raw-codex-mock-native.txt` | Codex × 本地 mock 的 Chat 桥 / 原生 Responses 原始输出 |

原始日志末尾的 `/tmp/mg-ui-final3` 是生成时的临时目录；对应截图已复制到本目录。

## 复现

```bash
# 1) 隔离网关 + 本地 mock 上游 + 可复现流量（不占 8787）
node scripts/test/ui-fixture.mjs --port 8788

# 2) 宿主机已有 Chrome（本机 153）开 CDP；不要下载浏览器
google-chrome --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=/tmp/mg-chrome-profile \
  --window-size=1440,1000 about:blank

# 3) 浏览器验收
node scripts/test/ui-browser-check.mjs --port 8788 \
  --token fixture-admin-token --out /tmp/mg-ui-shots
```

DSH 复现使用临时 `DSH_HOME` 与 overlay（见 `client-mock-validation.txt` / `real-client-validation.txt`）。真实上游最小验证只使用用户级环境中的既有 Key（网关运行时解析，不读取值），共 3 请求 / 18,809 tokens。Codex 通过 vendor 二进制 + `--sandbox read-only` 运行；真实工具执行仍因宿主 bwrap user namespace 不可用而 NOT_RUN，未使用 `--dangerously-bypass...`。
