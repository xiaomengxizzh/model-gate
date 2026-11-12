# 执行测试

在仓库根目录运行：

```bash
npm run check
npm test
npm run docs:check
```

`npm test` 串行启动白名单内的自包含测试：virtual-models、effort-normalize、upstream-side-4xx，以及 offline 下的 Node 测试（管理面契约、来源策略、秘密边界、配置结构、指标口径、生命周期、协议 wire）。mock 不访问厂商服务；子进程显式使用测试主密钥。所有套件都用系统分配端口与 OS 临时目录（`scripts/test/isolate.mjs`、`scripts/test/offline/harness.mjs`），因此同一 checkout 可重复运行。

筛选如 `npm test -- probe`。筛选未命中返回非零，不作为“通过”。

## 旧集成套件

`npm run test:live -- 关键词` 运行 27 个旧套件。它们已迁移为自建隔离实例（mkdtemp 配置目录 + 动态回环端口 + 本地 mock 上游），因此只需 `MG_ALLOW_LIVE_TESTS=1`，不再要求 `MG_CONFIG_DIR`/`MG_GW`，也不会碰 8787 或真实上游。`live.mjs` 按文件独立子进程运行，退出码即结果。

旧套件已全部隔离（MG-004）：配置读写经加密 Key 与临时目录，上游为本地 mock，默认 `npm test` 与旧套件互不影响。`user-env-fallback` 的 Windows 分支在 Linux 上打印 `N/A`（不计通过）。仍不要为了让测试通过而关闭日常网关鉴权。

若测试失败，保留命令、错误、Node 版本和相关 diff，先排除端口占用，再判断行为回归。退出、SKIP 和超时均不得写成成功。

## Codex 原生 Multi-Agent V2 套件（MG-017）

三个新套件随默认 `npm test` 运行（都是自包含 mock，不访问厂商服务）：

| 套件 | 覆盖 | 命令 |
| --- | --- | --- |
| `offline/codex-responses.test.mjs` | 纯映射：三工具明文声明、marker 七态、命名空间扁平别名、agent_message 投影、reasoning/compaction、配对与不可变 | `npm test -- codex-responses` |
| `offline/codex-responses-stream.test.mjs` | SSE 增量解析（UTF-8/CRLF/多行 data）、身份恢复、终态一次、usage 一次、断流、背压 | `npm test -- codex-responses-stream` |
| `offline/codex-routing.test.mjs` | 双 mock 路由：GPT/DeepSeek 分路与鉴权隔离、严格路由零上游、单 provider 不迁移、保存校验 | `npm test -- codex-routing` |

### 原生 Codex 生命周期（门禁）

`offline/codex-v2-lifecycle.test.mjs` 默认只跑纯编排/解析快测；真实 CLI 子用例必须显式开启门禁：

```bash
MG_CODEX_V2=1 node --test scripts/test/offline/codex-v2-lifecycle.test.mjs
```

它使用本机原版 Codex（CLI `0.167.0` 稳定入口 `/home/xiaomengxizi/ai/harness/codex/cli/bin/codex`、Desktop 捆绑 `0.167.0-alpha.3.2`）、隔离 `CODEX_HOME`（不要放 `/tmp`，会触发 helper 别名警告）、临时 `MG_CONFIG_DIR` 与动态回环端口；两个 mock 上游只编排模型输出，线程/任务/通知全部由 Codex 生成。未装 Codex 或未设门禁时该组显示 skip，**skip 不是通过**。

判定口径：组件验收（裸 CLI/app-server）< 离线生命周期（两个 mock）< 真实验收（真实 GPT + 真实 DeepSeek + 原版客户端）。前两者不得写成真实验收，详见 `docs/roadmap/2026-11-12-codex-v2-acceptance.md`。
