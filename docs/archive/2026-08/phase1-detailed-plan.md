# Phase 1 详细实施计划 · 多虚拟模型 + 独立 Key + 并发写安全

> 基于 2026-08-25 代码侦察（index.js/router.js 现状）细化，取代 phased-execution-plan.md 中 Phase 1 章节的执行粒度。
> 第 0 步（8788 开发网关 + scripts/dev.gateway.json）已完成。

## 〇、范围不变量（全程有效）

1. 旧 `gatemodel` + 全局 clientKey 零迁移可用；未匹配模型名继续走 `defaults` 链。
2. 生产 8787 不中断；全部迭代在 8788；上线=秒级重启。
3. Key/token 永不明文落盘/日志；`__mg_vm_*` 走既有 AES-GCM keys 库。
4. 回滚性质：`virtualModels` 是新增字段，**旧代码读到会忽略**——回滚只需换回旧代码，配置无需回退。

## 一、实施步骤（按依赖排序，每步独立可验证）

### Step 1 · 并发写安全（地基，先行）

改动点（index.js / router.js）：
- **写互斥**：进程级 promise 队列串行化所有写盘。现状风险实测：`writeJsonAtomic` 的 tmp 名 = `path.pid.tmp`（router.js L19），同进程两个并发写同一文件 → 同一 tmp 路径互相覆盖；且 `saveConfig` 内部还会写 keys 文件（clientKey 迁移分支），与 `saveKeys` 构成跨函数竞态。
- **读改写全程持锁**：`saveConfig`/`saveKeys` 的 load→merge→encrypt→write 整体进锁；锁覆盖 tmp 写 + rename 全程。
- **`configVersion` 单调递增**：持久化进 `gateway.local.json` 顶层（重启延续）；每次成功 save +1；`buildStatus` 暴露；`/api/config/save`、`/api/keys` 接受 `version` 参数，**过期 → 409**（响应带最新 version）。
- **旧客户端宽容**：请求缺 `version` 字段视为旧版面板，接受保存并在响应带回最新 version（避免上线瞬间旧缓存面板全挂）。

### Step 2 · 配置 schema + 校验

- `gateway.local.json` 新增顶层 `virtualModels: [{ name, directory[] }]`；key 不落明文（存 keys 库 `__mg_vm_<name>`）；**不设思考强度字段**（透传，见决策 3 的连锁校验）。
- `loadConfig` 校验：name 唯一、directory 非空、引用的模型/上游存在、**name 不得与真实模型名/别名/`defaults.model` 冲突**。
- 虚拟模型支持额度与限流字段：`quota/dailyQuota/maxContext/maxConcurrent/qps`（见风险 A3——否则额度检查对虚拟模型静默失效）。
- `configPaths()` 支持**可选** `MG_CONFIG_DIR`（决策 2）：未设置=现状 `cwd/config/`，零迁移；多实例隔离时开发实例设置该变量，keys/stats 随之独立。

### Step 3 · 路由与转发

- `resolve()` 优先级：真实模型/别名 → **虚拟模型（返回其自身 directory）** → `defaults.model`（旧入口保留）。
- `forwardChain`：`model=虚拟名` 时用**其自身 directory** 建 routes（不再拼全局 `defaults.directory`）；`modelName`/限流/额度取虚拟模型自身定义；响应 model 回写天然复用（canonicalName=虚拟名）。
- `routeLimit` 扩展：额度检查先查 `cfg.models` 再查 `virtualModels`。
- `staticModels`/`buildStatus` 并入虚拟模型名与状态。
- **路由解析规则（借鉴 sub2api COMPOSITE_GROUPS）**：Phase 1 仅 exact 匹配 + 名字唯一（简单优先）；schema 预留 `priority` 字段位，exact/prefix 混合匹配与确定性定序（exact>prefix、endpoint 专属>any、低 priority 优先）留 Phase 2 启用。
- **路由试算端点（借鉴同源）**：新增 `POST /api/route-preview`（管理鉴权，body: `{model}`）→ 返回将命中的虚拟模型、目录链、上游序列与额度状态；面板虚拟模型卡加「试算」按钮，配置前可验证路由意图。

### Step 4 · 鉴权（结构性改动，最需谨慎）

现状：数据面**先 header 鉴权 → 再 collectBody**（index.js L637-650）。虚拟模型 key 按 model 区分，而 model 在 body 里。采用**两阶段鉴权**（避免反转顺序扩大 DoS 面）：
1. 第一阶段（现状不变）：Bearer 匹配全局 clientKey → 通过即放行（常规 agent 零额外开销）。
2. 第二阶段（仅当第一阶段失败且配置了 virtualModels）：才 `collectBody` 解析 model → 命中虚拟模型且存在 `__mg_vm_<name>` → 用该 key 常量时间比较，key 错 → 401；**未命中任何已知名 → 404 + 明确文案**（决策 1，不再静默走 defaults 链）。
- 错误信息统一为「无效的客户端接入 Key」，不区分「模型不存在/key 错」，防虚拟模型名枚举；404 文案可提示查 /v1/models。

### Step 5 · keys 库与面板

- keys：`__mg_vm_<name>` 存/删/掩码；`/api/status` 的掩码遍历覆盖 `__mg_vm_*` 前缀；**删除虚拟模型时同步删 key**（防孤儿 key 被同名新建继承）。
- **key 元数据（借鉴 sub2api api_key 模型，按本项目口径裁剪）**：keys 库新增 `__mg_vm_meta_<name>` JSON = `{ expiresAt, note }`；鉴权时校验 `expiresAt`（过期 → 401 + 「该虚拟模型 Key 已过期」文案）；`lastUsedAt` 存内存 state 仅面板展示（重启清零可接受，避免高频写盘）。Phase 1 不做多窗口限速（5h/7d 留 Phase 2），1d 窗口复用现有 dailyQuota 机制。
- 面板 admin.html：「默认上游」卡交换虚拟名↔Key 位置；新增虚拟模型管理器（列表/新建/从 localStorage 模板一键生成目录/Key 设删/过期时间/**试算**/保存/删除）；所有保存带 `configVersion`，409 时提示并自动重拉。

#### 面板 UI 设计要点（2026-08-25 截图评估结论：无需重构，增量修改）

视觉体系（赛璐璐描边+投影+CSS 变量昼夜主题）健康，新组件全部复用现有视觉词汇（`--card2/--edge/--shadow/--cel-accent`），不引入框架/构建链。评估发现的两个一致性缺陷作为本 Step 顺手修复项：

1. **KPI 口径统一**：统计页四张 KPI 大卡读进程内存计数（重启清零），与下方全局统计（持久化恢复值）重启后数字不一致（0 vs 1403）——大卡改读 global 或标注「本次运行」。
2. **v-config 改纵向滚动**：现 100vh 固定 + 左列双卡 flex 分割，上游 4 个时「模型路由」卡被压到首屏不可见；虚拟模型管理器加入后内容更多——放弃固定高度，卡片按内容自然生长、页面纵向滚动。

虚拟模型管理器视觉方案：
- **折叠列表**（放右列「默认上游」卡下方）：收起态一行 = 名字 + Key 徽章（含过期标记）+ 目录摘要（首模型→…）+ 展开箭头；展开态 = 复用 `diritem` 目录编辑器 + Key/过期时间/试算按钮——N 个虚拟模型不撑爆页面；
- 试算结果复用现有 `openModal` 弹窗呈现「命中虚拟模型 → 目录链 → 上游序列」。

实施注意（延续既有修复原则）：
- 409 自动重拉**必须走确认对话框**（「配置已被他处更新，是否加载最新？」），不得静默覆盖用户正在编辑的内容；
- 虚拟模型编辑器的所有输入框纳入重绘保护（activeElement/光标恢复机制），防 3s 轮询打断输入；
- 唯一建议的小重构：把目录编辑逻辑从 `renderRoute()` 抽成 `renderDirItems(box, dirArr, opts)` 共用（默认上游卡与 N 个虚拟模型卡共用，避免复制 N 份）。

### Step 6 · 验证矩阵（全部在 8788）

1. `gate-a`(K1,目录A) / `gate-b`(K2,目录B)：正确 key+模型名路由到各自目录。
2. 401 矩阵：错 key / 缺 key / 用全局 key 访问绑了独立 key 的虚拟模型。
3. 旧入口回归：`gatemodel` + 全局 key 行为与升级前一致。
4. 并发保存：双标签页，后提交带旧 version → 409 且不丢前者改动。
5. keys+config 同时并发保存：不互踩、不坏文件（tmp 冲突回归）。
6. 虚拟模型额度：quota/dailyQuota 超限自动切目录下一项。
7. 未知名 + 已配置虚拟模型：返回 404 + 明确文案，不静默走 defaults 链（决策 1）。
8. 删除虚拟模型后 key 同步清除；同名重建不继承旧 key。
9. 12 agent 并发压测：全 200、排队不丢、无 5xx。
10. 回滚演练：带 virtualModels 的配置 + 旧版代码 → gatemodel 正常、虚拟名 404/兜底、无崩溃。

### Step 7 · 上线

低峰期：停 8788 → `start.bat` 秒重启 8787 → `/healthz` + gatemodel 回归 + 面板强刷（Ctrl+F5，见风险 D3）→ 观察 chain 日志 10 分钟。

## 二、连锁风险分析

### A. 路由回归
- **A1 命名冲突劫持**：虚拟名与真实模型/别名/`defaults.model` 同名会改变现有路由语义 → loadConfig 强校验拒绝（Step 2），面板保存同样拦截。
- **A2 resolve 优先级**：虚拟模型匹配必须插在「真实模型」之后、「defaults.model」之前，否则旧 gatemodel 入口被劫持。用测试 3 锁住。
- **A3 额度静默失效**：`routeLimit` 只查 `cfg.models[model]`，查不到直接放行——虚拟模型若不并入，quota/dailyQuota/maxContext 全部静默失效（不报错、不拦截）→ Step 2/3 显式支持字段并加测试 6。

### B. 鉴权
- **B1 鉴权/解析顺序**：若简单反转（先解析 body 再鉴权），未鉴权请求即可触发 10MB body 全量接收 → DoS 面扩大。两阶段设计（Step 4）保证常规路径零开销、异常路径才付解析成本。
- **B2 信息泄露**：401 文案必须统一（Step 4），防通过差异化报错枚举虚拟模型名。
- **B3 未知名静默兜底绕过隔离（已拍板：404）**：现状未知名走 defaults 链（全局 key 授权），Agent 打错虚拟模型名会静默落到默认链——隔离意图被绕过且无感知。已决策：配置 virtualModels 后未知名返回 404 + 明确文案（决策 1）。
- **B4 孤儿 key**：删虚拟模型不删 key → 同名重建自动继承旧 key（越权惊喜）。Step 5 删除同步清 key + 测试 8。

### C. 并发写
- **C1 tmp 同名冲突**：`writeJsonAtomic` tmp 名含 pid 不含随机数，同进程并发写同文件必冲突——写互斥的根因，测试 5 回归。
- **C2 跨函数竞态**：saveConfig（clientKey 迁移分支）与 saveKeys 都写 keys 文件——锁必须覆盖两函数全部写路径，不是各自内部加锁就完。
- **C3 跨进程写竞态（重大，易漏）**：`configPaths()` 固定 `cwd/config/`——8787 与 8788 **共享 keys.local.json/stats.json**，进程内锁管不了跨进程：8788 验证期保存虚拟模型 key 会直接改写生产 8787 的 keys 库。对策（择一）：① 验证期 8788 用独立工作目录启动（`cd` 到影子目录或 configPaths 支持 `MG_CONFIG_DIR`）；② 验证期只读共享 keys、写操作全部推迟到上线窗口。**建议 ①**，顺带成为 Phase 1 的一个前置小改动。
- **C4 configVersion 粒度**：单全局版本最简单，代价是无关修改互报 409（面板 409 后自动重拉可接受）；按文件分版本复杂度不值。定：全局单版本。
- **C5 读侧**：读无锁 + rename 原子覆盖（Windows MoveFileEx REPLACE_EXISTING）→ 读到完整旧版或完整新版，无半截文件。无需读锁。

### D. 面板
- **D1 409 风暴**：多标签页常态编辑会互报 409 → 前端 409 后自动重拉最新配置+版本再让用户改，提示「配置已被他处更新」。
- **D2 旧客户端窗口期**：上线瞬间浏览器缓存旧 JS（无 version 字段）→ 宽容策略（Step 1），响应带最新 version 引导自愈。
- **D3 缓存强刷**：admin.html 每请求读盘但浏览器可能缓存旧页——上线通知里写明 Ctrl+F5。

### E. keys 库
- **E1 旧代码兼容**：旧网关读到 `__mg_vm_*` 会当普通 provider id 查 → buildProvider 抛 unknown provider 但无人调用它 → 无害。回滚安全。
- **E2 掩码遗漏**：/api/status 若只掩码已知 provider id，`__mg_vm_*` 可能漏掩码回显明文 → 掩码逻辑改为「`__` 前缀一律掩码」。

### F. 上线
- **F1 在途流断**：start.bat 强杀进程会掐断在途 SSE——agent 侧重试兜底，选低峰窗口，提前公告。
- **F2 8788 残留**：上线窗口期 8788 必须停机，消除 C3 竞态窗口。
- **F3 回滚**：换回旧代码即可（A 不变量 4），配置文件无需回退；演练见测试 10。

### G. 性能
- resolve 加一层 Map O(1)；buildStatus 增量字段（3s 轮询 payload 增幅可忽略）；两阶段鉴权常规路径零额外解析（B1）。

## 三、已拍板决策（2026-08-25）

| # | 决策 | 结论 |
|---|---|---|
| 1 | B3 未知名行为 | **404 + 明确文案**（如「未知模型名；可用虚拟模型见 /v1/models」）。配置了 virtualModels 后未知名不再静默走 defaults 链，杜绝 key 隔离被无感绕过 |
| 2 | C3 跨进程隔离 | **`MG_CONFIG_DIR` 可选环境变量**：未设置=现状 `cwd/config/`（单实例用户零感知零配置）；设置时该目录的 keys/stats 独立成套。仅开发实例需设置，生产不设 |
| 3 | 虚拟模型思考强度 | **不支持、透传**。虚拟模型不设 effortOptions/reasoning；连锁处理：model 改写为真实模型名后，用**真实模型自身定义**补一次 effortOptions 本地校验（非法档位仍由网关 400 拦截，不浪费上游调用；校验用真实模型配置，非给虚拟模型加字段） |

## 四、借鉴 sub2api 的设计来源

Phase 1 三处增强源自 sub2api（Wei-Shaw/sub2api，本地克隆 `E:/ai/sub2api`）的成熟实现，按本项目口径裁剪：

| sub2api 原设计 | 本项目采纳 | 裁剪说明 |
|---|---|---|
| COMPOSITE_GROUPS 路由解析（exact/prefix、priority、确定性定序、preview 端点） | Phase 1 仅 exact + **路由试算端点** `POST /api/route-preview` + 面板「试算」按钮 | prefix/priority 留 Phase 2（YAGNI，先保名字唯一简单性） |
| api_key 模型（expires_at、多窗口限速、last_used_at、IP 白名单） | `__mg_vm_meta_<name>`（expiresAt/note）+ 内存 lastUsedAt | 多窗口限速留 Phase 2；IP 白名单本地场景不需要 |
| 协议兼容 apicompat 包（Responses 为 IR + 直连桥 + 流式事件 wire 测试） | 不进 Phase 1（不动 format.js）；**Phase 2 能力框架采纳**：N 协议以 IR 中转（2N 转换器替代 N²）、字段保真走直连桥、流式事件顺序用 wire 级测试钉住（如 content_part.added 必须先于 output_text.delta，OpenAI SDK 隐性契约） | 详见 phased-execution-plan Phase 2 增补 |

## 五、工作量预估

Step 1（0.5 天）→ Step 2+3（1 天）→ Step 4（0.5 天）→ Step 5（1 天）→ Step 6 验证（0.5 天）→ Step 7 上线（0.5 小时窗口）。全程 8788，生产零感知。
