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

DSH 复现使用临时 `DSH_HOME` 与 overlay（见 `client-mock-validation.txt`）；不要指向真实上游或真实 Key。Codex CLI 在本机因 `bwrap` user namespace 不可用而阻断，未使用跳过沙箱参数。
