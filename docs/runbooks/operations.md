# ModelGate 运维手册

## 1. 进程与端口

| 实例 | 端口 | 配置来源 | 说明 |
| --- | --- | --- | --- |
| 生产 | 8787 | `config/gateway.json` + `config/gateway.local.json` | 现有 agent 使用；本轮**未触碰** |
| 隔离开发/测试 | 随机（`port:0`）或 8788 | `MG_CONFIG_DIR=<临时目录>` + `MG_CONFIG=<file>` | 离线测试与联调 |

启动：

```bash
npm start                     # 使用 cwd/config
MG_CONFIG_DIR=/tmp/mg-dev MG_CONFIG=/tmp/mg-dev/gateway.json node src/index.js
```

健康检查：`GET /healthz`（仅进程存活，不代表上游可用）。上游可用性看 `POST /api/probe` 或 `/api/model-test`。

## 2. 配置优先级

```
环境变量（MG_* / apiKeyEnv 指向的变量）
  > config/gateway.local.json（面板写入，gitignored）
  > config/gateway.json（入库默认值）
```

- 面板/`/api/config/save` 只写 `gateway.local.json`，**不修改** `gateway.json`。
- `defaults` 保存是**合并**：未提交字段保留；要删字段只能手改文件后 `POST /api/config/reload`。
- `configVersion` 单调递增；并发保存旧版本返回 `409`，前端刷新后重试。

## 3. 密钥

- Provider Key：面板 `/api/keys` 或环境变量 `apiKeyEnv`；落盘为 AES-256-GCM（`MG1:`），权限 `0600`。
- 主密钥：`MG_KEYS_MASTER`；未设置时自动生成到 `~/.model-gateway/master.key`（跨项目复用，勿删）。
- 客户端 Key：`MG_CLIENT_KEY` / `__mg_client`；虚拟模型 Key：`__mg_vm_<name>`。
- 管理令牌：`MG_ADMIN_TOKEN` / `server.adminToken` / `__mg_admin`。
- **禁止**：把 Key、Cookie、`auth.json`、请求正文写入 Git、日志、issue、PR。

## 4. 升级与回滚（本仓约定）

1. 独立 `dev/gateway-*` 分支 + 独立 worktree；不与其他执行者共用工作树。
2. 改动前：`git status`、`git worktree list`、端口检查、`git fetch` 比对 SHA。
3. 提交前：`npm run check` + `npm run test:offline`（零成本、零真实 Key）。
4. 隔离环境冒烟（随机端口/8788）→ 低峰期再切 8787（秒级重启），确认 `/healthz` + 既有 agent 正常。
5. 回滚：`git revert <sha>` 或切回上一个 release 提交后重启；配置回滚用 `config/gateway.local.json.bak-*`（已有备份约定）。

## 5. 诊断字段

| 字段 | 位置 | 用途 |
| --- | --- | --- |
| `x-mg-trace-id` | 数据面/管理面响应头 | 关联日志与错误体 |
| `x-mg-attempts` | 数据面响应头 | 本次真实上游请求数，判断重试放大 |
| `Retry-After` | 429 响应头 | 客户端退避 |
| `error.attribution` | 429 错误体 | `rate_limit` / `platform_quota` / `model_capacity` / `cooldown` |
| `/api/status.budget` | 管理面 | 当前预算默认值 |
| `/api/status.providers[].st` | 管理面 | 熔断状态、p50/p95、probe |
| `/api/capabilities` | 管理面 | 模型/上游协议能力矩阵 |
| `logs/gateway-YYYY-MM-DD.log` | 文件 | 按日 7 天保留、写入前脱敏 |

## 6. 常见故障

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 502 no_provider | `/api/status` 的 `hasKey`、熔断 `state` | 补 Key / 等熔断冷却 / 查上游可达性 |
| 429 | `attribution` + `x-mg-attempts` | 见 `429-and-rate-limits.md` |
| 流式中断 | 日志 `sse 流中断`、`streamDrops` | 上游问题；冷却后半开自动恢复 |
| 配置保存 409 | `currentVersion` vs 提交 `version` | 刷新面板重试 |
| 面板显示 `****` | 正常脱敏 | 回写 `****` 表示不改；不要手填星号到真实配置 |

## 7. 资源与授权

- 本项目零第三方运行时依赖；**新增依赖/模型/镜像/浏览器包必须先按 `RESOURCE_APPROVAL.md` 盘点并取得 owner 明确授权**。
- 本轮未新增任何下载/安装；离线测试使用 Node 内置模块 + 本地 mock 上游。
