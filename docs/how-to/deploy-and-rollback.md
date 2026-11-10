# 安装、升级与回滚

本页只写操作步骤与判据。运行排错见[运维指南](operations.md)，字段含义见[配置参考](../reference/configuration.md)，版本与平台边界见[兼容矩阵](../reference/compatibility.md)。

前提：Node.js >= 18（`package.json` 的 `engines`）。仓库**运行时零第三方依赖**（没有 `dependencies` / `devDependencies`），所以安装与升级都**不需要也不应该**跑 `npm install` / `npm ci`。任何新增依赖动作先按[资源门禁](../../RESOURCE_APPROVAL.md)盘点并取得用户授权。

## 安装

```bash
node --version                 # 必须 >= 18
git clone <仓库地址> /opt/model-gateway
cd /opt/model-gateway
npm run check                  # 语法自检，不起服务
```

配置分三层，各管一段：

| 文件/变量 | 放什么 | 是否入库 |
| --- | --- | --- |
| `config/gateway.json` | 基座：`server` 段 + 非敏感默认 | 入库（模板） |
| `config/gateway.local.json` | 私有覆盖：真实 baseUrl、Key 名、模型/上游覆盖 | gitignore |
| `MG_CONFIG_DIR` | 隔离 keys.local.json、stats.json 与 local 的目录 | 不入库 |

`server` 段**始终**取自 `gateway.json`，local 改不动端口与绑定地址。凭据放环境变量或加密 keys 库，不要写进这两个 JSON。

离线验收四连（默认套件只跑本地 mock，不连真实上游）：

```bash
npm run check && npm test && npm run docs:check && node scripts/check-metadata.mjs
```

预期末尾三行形如 `Isolated suites: <n>/<n> passed`（n 随套件增减）、`Documentation paths: PASS`、`Metadata: PASS (21 checks)`。任一条退出码非 0 就不要继续部署；套件失败先按[测试指南](testing.md)区分端口占用、并发修改与真实回归。

首次启动先在**隔离目录与空闲端口**验证，不要拿生产端口试：

```bash
MG_DEMO_DIR=$(mktemp -d)
node --input-type=module - "$MG_DEMO_DIR" <<'JS'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
writeFileSync(join(dir, 'gateway.json'), JSON.stringify({
  server: { host: '127.0.0.1', port: 8792, logFile: join(dir, 'gateway.log') },
  defaults: { preheat: [], failbackProbe: { enabled: false } }, providers: {}, models: {}
}))
JS
MG_CONFIG_DIR="$MG_DEMO_DIR" MG_CONFIG="$MG_DEMO_DIR/gateway.json" node src/index.js
```

另开终端 `curl --fail http://127.0.0.1:8792/healthz` 应返回 `ok`，`/v1/models` 返回空列表。Ctrl+C 结束自己启动的进程。

投入生产时设置 `MG_ADMIN_TOKEN`（管理面）与 `MG_CLIENT_KEY`（数据面），再用你的服务管理器启动。**源码就位不等于生产已部署**：必须重启实际运行该源码的进程，JavaScript 才生效（管理的面板 HTML 是逐请求读盘，属例外）。生产端口 8787、systemd 单元与真实上游账号都是本机部署事实，不由仓库状态证明。

## 升级

### 先备份

```bash
DEPLOY=/opt/model-gateway
BK=/var/backups/model-gateway/$(date +%Y%m%d-%H%M%S)
mkdir -p -m 700 "$BK"
cp -a "$DEPLOY"/config/*.json "$BK"/ 2>/dev/null || true
```

`keys.local.json` 必须与**主密钥**（`MG_KEYS_MASTER` 或用户目录的 `master.key`）成对备份；只拷加密库、丢了主密钥就解不开。备份含凭据，放受限权限目录。

### 步骤

1. 记录当前提交，升级失败时这就是回滚点：`git -C "$DEPLOY" rev-parse HEAD`
2. `git -C "$DEPLOY" status --short`：有未提交改动先停下确认来源，不要强行覆盖
3. `git -C "$DEPLOY" fetch --all --prune && git -C "$DEPLOY" pull --ff-only`
4. 重跑离线验收四连
5. 重启进程，然后核对：
   ```bash
   curl --fail http://127.0.0.1:8787/healthz
   curl --fail -H "Authorization: Bearer $MG_ADMIN_TOKEN" http://127.0.0.1:8787/api/status
   ```
   判据：`healthz` 为 `ok`；`/api/status` 的 `configVersion` 与升级前一致（面板保存后才 +1）；日志无启动异常。
6. 记录日期、升级前后提交 sha、执行命令与结果、未验证项。**mock 全绿不等于真实上游验收**，后者需要单独授权与单独记录。

### 配置数据兼容

- **加载**：`gateway.json` 为基座，`gateway.local.json` 的 `providers` / `models` / `defaults` 逐层浅合并覆盖；`server` 段取基座；local 的 `configVersion` 覆盖基座。
- **面板保存**（`/api/config/save`）：先做引用完整性校验（模型引用的上游必须存在等），保存成功后 `configVersion` +1；请求里带的 `version` 已过期则返回 409 冲突，刷新面板后重试。
- `defaults` 是**逐字段合并**：客户端没回传的字段（`affinityTtlMs`、`failbackProbe`、`preheat` 等）保留原值。代价是字段无法经保存接口删除，需要删就编辑文件后 `POST /api/config/reload`。
- `providers` / `models` 是**整体替换**（提交什么存什么），面板保存等于用当前视图重写这两段；升级后不要用旧视图回写新版本已移除的字段。
- local 顶层只回写 `configVersion` / `providers` / `models` / `defaults` / `virtualModels` 五个键，自造的其它顶层键会在面板保存时消失——要长期保留就收进 `defaults`。
- `configVersion` 是**并发冲突检测**，不是数据迁移版本号：升级不迁移配置，回滚也不回退它的数值。
- 字段级的行为变化以 [CHANGELOG](../../CHANGELOG.md) 为准；本轮（dev/gateway-audit-20261108）没有需要停机迁移的破坏性字段变更。

## 回滚

触发条件：`/healthz` 失败、启动即退出、模型列表或探测异常、关键路径回归，且短时间排查不出原因。

源码回滚（**当前仓库没有发布 tag**，`git tag` 为空，只能按提交 sha）:

```bash
git -C "$DEPLOY" log --oneline -5
git -C "$DEPLOY" reset --hard <升级前记录的 sha>
```

或按部署方式切回上一份目录/软链（更适合有多个版本目录的部署）。共享工作树里可能有他人未提交改动，**不要在共享工作树上 reset**。

配置回滚：把备份的 `gateway.local.json` / `keys.local.json` / `stats.json` 放回 config 目录（`keys.local.json` 需配对主密钥）后重启。`stats.json` 损坏或缺失时网关按空统计启动，历史用量不可恢复，这也是要备份它的原因。

回滚验证：`/healthz`、`/v1/models`、`/api/status`（`configVersion` 与备份一致、模型与上游齐全）、日志无异常；记录回滚原因、时间与结果。

## 停止与重启

- 用 `SIGTERM`（`systemctl stop` 发的就是它）。2026-11-08 隔离实例实测：进程立即退出，退出状态 **143**（128+15 信号退出），日志没有关闭记录，端口随即释放。
- `stats.json` 周期写盘（约 30s 一次），停止前如需最新计数先等一个写盘周期；统一优雅关闭仍在计划项（开发计划 MG-007），本轮不声称支持。
- 重启后先 `curl --fail /healthz`，再 `/api/status` 核对 `configVersion` 与模型清单；面板登录状态按实例 `startedAt` 判定，重启后需要重新输入令牌。

## systemd 与凭据边界

示例单元（**本机部署细节不入库**，按实际路径与用户改写）：

```ini
[Unit]
Description=ModelGate local gateway
After=network.target

[Service]
WorkingDirectory=/opt/model-gateway
EnvironmentFile=/etc/model-gateway/env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=2
User=modelgateway

[Install]
WantedBy=multi-user.target
```

- `/etc/model-gateway/env` 权限 0600，放 `MG_ADMIN_TOKEN`、`MG_CLIENT_KEY` 与各上游 `apiKeyEnv`；环境变量令牌优先于配置与面板值。
- provider Key 走环境变量或加密 keys 库，不进 `gateway.json` / `gateway.local.json`、不进日志与提交。
- 修改源码后只有重启该单元才加载新 JS；升级后记得 `systemctl restart` 并复查 `/healthz`。

## 本轮验证记录（隔离实例，未触碰生产 8787）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `npm run check` | 退出码 0 |
| 离线套件 | `npm test` | 2026-11-08 23:56：`Isolated suites: 11/11 passed`，退出码 0（同日 23:31 基线为 8/8；并行任务持续增改套件，数量会变，以执行时输出为准） |
| 文档链接 | `npm run docs:check` | `Documentation paths: PASS` |
| 元数据 | `node scripts/check-metadata.mjs` | `Metadata: PASS (21 checks)` |
| 启动 | `node src/index.js`（`MG_CONFIG_DIR`=临时目录，端口 8792） | `/healthz` → `ok`；`/v1/models` → `["demo-chat"]`；`/api/status.configVersion` → 11 |
| 停止 | `kill -TERM <pid>` | 退出状态 143，端口释放，无残留进程 |
| 恢复/重启 | 同一配置目录再次启动 | `/healthz` → `ok`；`configVersion` 仍为 11，模型仍在 |
| 日志落盘 | `server.logFile=<dir>/gateway.log` | 实际文件为 `gateway-2026-11-08.log`（`logFile` 是前缀，按天分文件） |

未验证：真实上游转发与计费、生产 8787 上的重启、systemd 单元本身、Windows/macOS 部署、GitHub Actions 远程执行。
