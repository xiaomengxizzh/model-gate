# 首次在隔离目录启动

前提：Node.js >=18，当前目录为仓库根目录。以下 Bash 命令不访问真实模型，也不改用户实例。

```bash
MG_DEMO_DIR=$(mktemp -d)
node --input-type=module - "$MG_DEMO_DIR" <<'JS'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
writeFileSync(join(dir, 'gateway.json'), JSON.stringify({
  server: { host: '127.0.0.1', port: 8788, logFile: join(dir, 'gateway.log') },
  defaults: { preheat: [], failbackProbe: { enabled: false } }, providers: {}, models: {}
}))
JS
MG_CONFIG_DIR="$MG_DEMO_DIR" MG_CONFIG="$MG_DEMO_DIR/gateway.json" node src/index.js
```

看到启动消息后，另开终端执行：

```bash
curl --fail http://127.0.0.1:8788/healthz
curl --fail http://127.0.0.1:8788/v1/models
```

预期分别为 `ok` 与空模型列表。用 Ctrl+C 结束自己启动的进程。保留目录可继续试验；确认无需保留后再自行清理。真实接入前按[运维指南](../how-to/operations.md)设置管理与客户端 Key。
