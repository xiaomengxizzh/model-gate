# mg-capabilities/1｜V13.1 只读控制面契约（A2）

状态：A2 实施中。该端点是现有管理 API 的**只读安全投影**，不是第二配置真源，不替代 `/api/status`、`/api/config` 或聚合 API。

## 1. 请求与安全

- `GET /api/capabilities`
- 仅 GET/HEAD；POST 返回现有管理面 404，不进入数据面。
- 与 `/api/status` 相同：Host/Origin 前置校验，非回环且未显式 allowRemote 返回 403。
- 不读取 Key 值，不返回 `extraHeaders`、`proxy`、authorization、token、auth.json、文件路径、请求正文。
- `Cache-Control: no-store`；响应可含配置计数与脱敏运行状态，但不得把 configured/detected 标成 runtime-verified。

## 2. 响应 schema

```ts
{
  contract: 'mg-capabilities/1',
  product: 'model-gateway',
  generatedAt: string,                 // ISO
  build: { packageVersion: string, node: string, commitSha: string|null },
  runtime: { configVersion: number, startedAt: number },
  sections: [{ id, label, route, state, endpoint, checkedAt }],
  features: [{ id, available, stage, evidence, reason? }],
  navigation: {
    primary: [{ id, label }],          // 固定六项，顺序固定
    advanced: [{ id, label, route }]   // 按需展开，不新增一级菜单
  },
  services: [{ id, serviceId, providerId, label, baseUrl, api, credential: 'configured'|'missing'|'unknown',
               keySource, health: 'ok'|'open'|'half'|'unknown', modelCount }],
  models: [{ name, label, serviceId, api, capability, aliases, enabled }],
  pools: [{ name, label, kind: 'legacy-virtual-model', candidateCount,
            candidates: [{model, mode, providers}], maxContext, verification: 'configured' }],
  reliability: { retry, timeout, concurrency, codexFallbackLimits, effectivePolicy: false },
  usage: { gateway: 'available', native: 'enabled'|'disabled'|'unknown' },
  aggregation: { supported: boolean, mode?: 'official'|'route'|'aggregated'|'unknown',
                 previousMode?: string|null, drifted?: boolean,
                 officialCredential?: 'detected'|'missing'|'unknown' },
  ui: { preview: true, defaultEntry: '/ui-vnext/', productionEntry: '/ui-vnext/',
        writeOperations: false, serviceWriteOperations: true, pollingMs: 15000 }
}
```

### 字段来源

| 字段 | 来源 | 证据等级 |
| --- | --- | --- |
| build.packageVersion | package.json | source |
| build.node | process.version | runtime |
| build.commitSha | `MG_BUILD_SHA`；未注入为 null | unknown，不猜 git HEAD |
| runtime.configVersion/startedAt | state.configVersion/st.startedAt | runtime |
| services | cfg.providers + resolveKey + ensureHst/effState | configured/health，不是推理成功 |
| models | cfg.models | configured |
| pools | cfg.virtualModels | configured；明确 legacy-virtual-model |
| usage.native | nativeUsageConfig | configured |
| aggregation | 聚合状态 + status.official 只读探测 | detected，不是推理验证 |
| features | 源码固定能力表 + 当前接线 | source；未接线 available=false |

`baseUrl` 去除 userinfo/query/hash；无凭据 URL 才返回。服务显示名暂用 id，A3 增加 displayName。模型 enabled 缺省 true，与现有加载语义一致。

## 3. Feature IDs（A2 冻结）

| id | available | stage | evidence |
| --- | --- | --- | --- |
| read-only-control-plane | true | A2 | source+http |
| provider-templates | true | A3 | source+http；63 模板版本化，非实时账户目录 |
| service-lifecycle | true | A3 | source+http；创建/编辑/启停/删除 |
| connection-lifecycle | true | A3 | source+http；独立 Key 运行时 |
| model-lifecycle | true | A3 | source+http；创建/更新/启停/删除 |
| named-pools | true | A4 | source+http；virtualModels 扩展 |
| bidirectional-bindings | true | A4/A5 | source+http；desired binding + Codex 角色目标 |
| unified-request-budget | true | A4 | source+http；single-request-ledger |
| effective-policy | true | A4 | source+http；scoped-inheritance |
| codex-three-modes | true | A5 | source；real-verification-blocked |
| native-compaction | true | A5 | protocol-boundary-only；real-verification-blocked |
| structured-usage | true | A6 | source+http；持久累计逻辑/尝试/token |
| structured-logs | true | A6 | source+http；脱敏文本与事件投影 |
| backup-restore | true | A6 | source+http；脱敏文件与导入回滚 |
| harness-adapters | true | A6 | source+fixture；Claude/OpenCode/DSH，xmxz unsupported |

`available:true` 只表示代码路径存在，绝不等于真实验收通过。`native-compaction` 的证据文字必须明确“协议边界；真实 BLOCKED”。

## 4. 错误与前端映射

| HTTP/条件 | 响应 | UI |
| --- | --- | --- |
| 200 | 全投影 | 分区渲染；空数组显示空状态，不显示假 0 成功 |
| 403 | 现有 `{error}` | 只读/来源错误，可重试，不锁屏 |
| 404 | text/plain `not found` | 旧后端不支持；停止写操作并提供升级说明 |
| 500 | 现有错误信封 | 局部错误 + 重试；旧快照标 stale，不伪装在线 |
| 网络失败/超时 | 无 HTTP | offline；保留非敏感草稿，不缓存凭据 |

前端只允许保存主题、密度、导航展开、非敏感筛选/草稿到 localStorage。Key、consent token、authorization、完整配置与请求正文禁止进入 localStorage/sessionStorage/URL。

## 5. 验收

1. 隔离真实 HTTP：200 形状、固定六导航、无敏感字段 canary、HEAD、非回环 403、未知 POST 404。
2. 真实浏览器同 origin：六页面、刷新/前进后退、加载/空/离线/404/500、主题、焦点、无页面级横溢出。
3. 无上游请求：GET capabilities 不得触发 probe/model-test/真实推理。
4. 与现有 `/ui-next` 并存；根路由 302 到 `/ui-vnext/`，`/ui-next/` 仅作回滚入口。生产切换与 8787 重启由所有者单独授权。
