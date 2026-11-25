# A2｜独立只读控制面垂直切片交付报告

- 日期：2026-11-24
- HEAD：`48325bf0027e583108c66677c7dec15fd5007228`（工作树有本切片未提交变更）
- 代码指纹（A3 候选复验）：`e1e4cacf9dcdeb7273df3e70d6082925c1534e609fa4978e44022498885a12d4`
- 指纹算法：`scripts/tree-fingerprint.mjs`，对 106 个运行/测试文件按 `relative path + NUL + bytes` 做 SHA256。
- 结论：**A2 只读核心通过；A2 全范围仍未完成。A3 仅在独立预览推进，不代表 A2/A3 全门禁通过。**
- 注：本报告原始只读切片后由 A3 候选同树复验；当前浏览器回执额外包含 A3 服务写链，A2 断言仍全部通过。
- 新增大型安装/下载：无。复用本机 Node 24.22.2、Chrome 与原生 Web/CDP。

## 1. 已实现

### 后端

- 新增 `GET /api/capabilities`（HEAD 可用），契约 `mg-capabilities/1`，实现 `src/capabilities.js`。
- 返回版本、配置代际、固定六项一级导航、高级入口、能力阶段/证据、脱敏服务/模型/旧虚拟模型池、可靠性配置、原生用量开关。
- 不返回 Key、认证头、代理凭据、URL userinfo/query/hash、文件路径或配置正文。
- `available:true` 只表示源码路径存在；native compaction 明确标真实验证 BLOCKED。
- 新增独立 `/ui-vnext` 静态资源入口，白名单路径、无目录遍历、CSP、no-store；根 `/` 仍 302 到 `/ui-next/`。

### 前端

- 原生 ES modules：`api/store/router/components/pages/preferences`，无框架、无第三方依赖、无 `innerHTML`。
- V13.1 共享设计令牌、216px 导航、64px 顶栏、深浅主题、舒适/紧凑密度、响应式布局、独立列表/表格滚动。
- 六项一级导航固定：应用接入、模型服务、模型池、用量分析、稳定性策略、设置；高级四项沿用现有真实管理面。
- 统一 `loading/ready/partial/error/offline` 状态；旧快照不伪装在线，空数组不显示调用成功。
- 真实服务搜索、模型池候选、零上游 route-preview、真实模型统计/CSV、原生用量开关、主题/密度偏好。
- 未实现写操作明确显示“未接线/规划”，没有模拟检查、模拟限流、假授权或假成功按钮。

## 2. 真实执行证据

### 隔离 HTTP / fixture

`node --test scripts/test/offline/v13-capabilities.test.mjs scripts/test/offline/v13-capabilities-http.test.mjs`

- 4/4 PASS。
- 使用动态回环端口、OS 临时 `MG_CONFIG_DIR`、虚构主密钥、本地 HTTP fixture。
- 验证 200/HEAD/404/403、敏感字段 canary、CSP、路径遍历、旧入口并存、 capabilities 零上游请求。
- 证据类型：**真实 HTTP + fixture**，不是真实厂商。

### 真实 Chrome 用户旅程

`node scripts/e2e/ui-v13-browser.mjs`

- 20/20 检查 PASS（含 A3 服务写链复验）。
- 六页导航、面包屑、前进/后退、刷新、服务搜索、池预演、主题、localStorage 敏感字段检查。
- 6 页 × 7 尺寸 × 2 主题 = **84/84** 无页面级横向溢出；不等于完整 V01 的 19 页/12 弹窗。
- CDP 注入 HTTP 404/500，随后停止隔离网关验证 offline；三类预期网络错误均可见，无未捕获 JS 异常。
- 整个浏览器旅程上游 fixture 命中数 **0**；未调用真实 DeepSeek/Luna/Codex GUI。
- 截图：`browser/a2-harness-dark-1440.png`、`browser/a2-harness-light-1440.png`、`browser/a2-pools-dark-1440.png`。
- 原始回执：`browser/a2-browser-report.json`（含 Chrome 版本、HEAD、代码指纹、逐窗口几何与检查）。
- 证据类型：**真实浏览器 + 真实隔离后端 + fixture**。

### 全量回归

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS；旧 UI 19/19，新 UI 12/12 |
| `npm test` | 151 suites passed / 0 failed；1413 tests passed / 3 skipped |
| `npm run docs:check` | PASS；147 files、742 links |
| `node scripts/check-metadata.mjs` | PASS；39 checks |
| `npm run contract:check` | PASS；12 requirements、7 stages、5 roles |
| `git diff --check` | PASS |

完整测试输出由工具保存到本会话临时输出文件；汇总以本报告与 `a2-browser-report.json` 为准。

## 3. 未完成与阻断

1. A2 全范围尚未完成：19 页面/12 弹窗、完整键盘/焦点/屏幕阅读器、长列表/缩放/IME、所有资源 CRUD 错误矩阵未验收。
2. A3 已交付服务创建/编辑/删除切片，但模板版本化、连接/模型稳定 ID、真实授权/发现、多账户仍未完成。
3. 旧 `/api/status` 与 `/api/config` 仍可能回显 `extraHeaders`/代理字段；新 UI 不请求/渲染它们，但全局敏感字段收敛是 A3 P0，不能宣称安全全完成。
4. 当前池明确标为 `legacy-virtual-model`；`cleanVms` 丢字段、命名池/权重/双向引用未修。
5. Codex 子目标固定、默认 `overallMs=0`、统一预算未完成。
6. 真实 DeepSeek/Luna/原版 GUI 测试 BLOCKED（用户暂不授权付费）；未用 mock/CLI 替代。
7. 未重启 8787、未替换根入口、未修改生产配置、未 push/merge/commit。

## 4. 下一步门禁

A3 已先做稳定 Service ID、创建/编辑/删除与现有事务薄封装；下一门禁是旧敏感字段收敛、模板/授权、Connection/Model 资源与发现。A4 才能修池字段与统一预算。任何未实现能力继续标规划。
