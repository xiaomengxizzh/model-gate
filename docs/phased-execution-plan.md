# 网关多虚拟模型 + 多能力扩展 · 三阶段执行计划

> 目标：在不中断线上网关运行的前提下，分三个阶段实现：
> 1. **多虚拟模型**（多个 agent 入口，各自绑定目录模板、各自独立接入 Key）
> 2. **能力维度框架**（把 entry→capability→adapter→provider→accounting 抽象为能力接口）并落地 **Embedding**
> 3. **逐项铺开** Rerank / Audio / Image / Video（视频异步最后）
>
> 全程遵守第 0 节「运行保障原则」。

---

## 0. 运行保障原则（先读）

Node 没有源码热加载（改代码需重启才生效），但可以**生产/开发分开**，实现「工程在线，线上无感」：

| 实例 | 端口 | 配置 | 用途 | 模型 |
|---|---|---|---|---|
| **生产网关** | `8787` | 现有 `config/gateway.local.json` 不动 | 线上 agent 继续用 `gatemodel` 等，全程不重启(除非上线点) | 现有真实组合 |
| **开发网关** | `8788` | `MG_CONFIG=scripts/dev.gateway.json` | 所有迭代、并发/写入/多能力 QA | **低成本组合或 mock（零成本）** |

执行纪律：
1. 开发期 **8787 保持不动**，agent 无感知。
2. 功能/并发/写入冲突等测试**优先用 mock（零成本）**，不烧真实 token。
3. 需要真调模型时，8788 指向**低成本/免费组合**。
4. 每阶段在 8788 冒烟通过后，选低峰**秒级重启一次 8787**（`start.bat` 自带清理残留进程）完成上线。

---

## 阶段总览

| 阶段 | 核心交付 | 能力 | 是否新增写并发面 |
|---|---|---|---|
| Phase 1 | 多虚拟模型 + 每模型独立 Key + 并发写安全（地基） | Chat（现有超集） | 是，先行堵死 |
| Phase 2 | 能力接口抽象 + Embedding | Chat + Embedding | 复用 Phase 1 地基 |
| Phase 3 | Rerank → Audio → Image → Video | 全能力 | 复用，仅新增可配置字段 |

---

## Phase 1 — 多虚拟模型 · 独立 Key · 并发写安全（能力 = Chat）

### 目标
agent 可调用**多个虚拟模型**，各带独立 Key、各绑自己的目录；堵死并发写丢数据；兼容旧 `gatemodel`。

### 0. 开发网关配置（新建）
`scripts/dev.gateway.json`：端口 8788、低价/免费模型组合、`.gitignore` 忽略（不入库），用于全部迭代。

### 1. 配置 schema（自包含快照，不做模板迁移/版本化）
```jsonc
// gateway.local.json（生产）/ dev.gateway.json（开发）
"virtualModels": [
  { "name": "gate-a",
    "directory": [ { "model": "x-preview-f-free", "mode": "afterAll", "providers": [] } ],
    "key": "" }            // key 不落明文，改存加密 keys 库 __mg_vm_gate-a
]
```
- 每虚拟模型**自带 directory（快照）**，改模板不影响已建虚拟模型。
- 旧 `defaults.model` / `defaults.clientKey` 保留，作为隐式旧入口（迁移期兼容）。

### 2. 并发写安全（地基，全局收益）
- `saveConfig` / `saveKeys` 各加**异步写互斥**（队列串行化），杜绝并发写同一文件。
- **读-改-写原子化**：同一把锁内完成 `load → 改 → write`。
- `save` 返回单调 **`configVersion`**；面板带版本提交，服务端拒绝过期保存（**409**），防多标签页互相覆盖。
- `reloadConfig` 只作用于新请求，在途请求用旧快照，保证一致性。

### 3. 代码改动
- `router.js`
  - `resolve()` 匹配优先级：真实模型 → **已有虚拟模型名→返回虚拟模型目录** → 旧 `defaults.model`。
  - `loadConfig` 校验：`virtualModels` 名字唯一、`directory` 非空、引用的模型/上游存在。
  - `staticModels()` 并入所有 `virtualModels[i].name`。
- `index.js`
  - Chat 入口：`model=某虚拟模型` 时用**它自己的 directory** 建 routes（不再用全局 `defaults.directory`）；`modelName`=虚拟名（归名/响回写天然兼容）。
  - 鉴权：`model=gate-a` → 有 `__mg_vm_gate-a` 则必须匹配该 key（常量时间比较），错则 401；否则回退全局 `clientKey`。
  - `buildStatus` 暴露 `virtualModels`（key 掩码 `********`）+ `configVersion`。
  - 写锁 + 版本检测接入所有保存入口（上游/模型/虚拟模型/模板/keys）。
- `keys.local.json`：每虚拟模型 key 以 `__mg_vm_<name>` 加密存储，`currentClientKey`、掩码逻辑相应扩展、永不明文落盘/日志。

### 4. 面板 `admin.html`
- 「默认上游」卡：**虚拟共用模型名 ↔ 客户端接入 Key 交换位置**。
- 新增「虚拟模型」管理器：列表卡片（名字 / 从现有模板**一键生成 directory** / 独立 key 设·删·掩码 / 保存 / 删除）。
- 保存强校验：名字唯一 + directory 非空。
- 模板仍留 localStorage，仅作「快速生成目录」工具。

### 5. 验证清单（8788 上）
- [ ] `gate-a`(K1,目录A) / `gate-b`(K2,目录B)：带对 key+对应模型名分别路由到 A/B。
- [ ] `gate-a` 带 K2 → 401；`gate-a` 不带 key → 401；键错 → 401。
- [ ] `/v1/models` 列出所有虚拟模型名。
- [ ] 两个标签页并发保存：后保存带旧版本 → 409，不丢前者改动。
- [ ] 并发写 keys + config 同时发生不互相覆盖、不坏文件。
- [ ] 旧 `gatemodel` + 旧全局 key 照常可用。
- [ ] 并发压测（如 12 agent × 限流）全部 200、排队不丢、网关不崩。

### 6. 上线步骤
- 8788 全绿 → `start.bat` 快速重启 8787（停1-2秒）→ 确认 `/healthz` + 旧 gatemodel 正常 → 新 agent 接入多虚拟模型。

### 7. 验收标准
多 agent 分别使用各自虚拟模型与独立 Key，互不可越权；并发保存杜绝丢数据；旧入口零迁移可用。

---

## Phase 2 — 能力维度框架 + Embedding

### 目标
把「能力」变成一等公民，抽象出**能力六件套**，为 Phase 3 铺平；端到端支持 Embedding（token 口径最兼容）。

### 能力接口框架（Phase 3 的杠杆，先定死）
每新增能力 = 注册六件套：
1. **entry**：path → capability 归一化（如 `/v1/embeddings`）。
2. **adapter**：按 `capability × provider api` 的请求/回包转换（`format.js` 扩展 `adapterFor(api, capability)`）。
3. **provider 能力声明**：`providers.[id].capabilities: ["chat","embedding"]`；按能力过滤上游，无能力则跳过/换下一个。
4. **accounting**：每能力计量口径（chat/embedding 用 token；其余各自定义）。
5. **probe**：按能力做连通测试（embedding 极小 input）。
6. **models 列表**：`/v1/models` 带能力维度（分组或 capability 字段）。

#### 协议转换架构（借鉴 sub2api apicompat 包，2026-08-25 增补）
协议数增长时两两直写是 N² 复杂度，采纳其三层设计：
1. **IR 中转**：以 OpenAI Responses 风格为中间表示，每协议只需「入口→IR」「IR→出口」两个转换器（N 协议 2N 个，非 N²）；`thinking`/`cache_control`/结构化 system 等字段经 IR 会丢失。
2. **直连桥逃生舱**：字段保真敏感的组合（如 OpenAI⇄Anthropic）保留直连桥跳过 IR——现有 `format.js` 的直写互转即直连桥，保留并纳入新架构。
3. **流式事件顺序 wire 测试**：协议转换的流式事件顺序是隐性契约（例：OpenAI SDK 累积式流助手要求 `content_part.added` 先于 `output_text.delta`，缺失即 IndexError）。每个转换器配 wire 级事件顺序测试，钉住契约防回归。
现有 `sse.js` 的多协议流式重建纳入此测试体系（现有 20 场景矩阵测故障，不测事件顺序契约，互补）。

### `virtualModels[i].capability`
- 默认 `chat`；Embedding 虚拟模型设 `capability:"embedding"`。

### 代码改动
- `index.js`：入口路径泛化（非 chat 也不再只认 chat）；按 `path→capability` 归一化后转发；能力不匹配返回明确错误。
- `format.js`：`adapterFor(api, capability)`；新增 embedding adapter（request: model+input；response: `data[].embedding`、`usage.total_tokens`）。
- `request.js`：embedding 的探活。
- 记账：embedding 有 `usage.total_tokens` → 直接进现有 token 统计；`byModel/capability` 维度补齐。
- 写安全/鉴权/兼容沿用 Phase 1，无新增写并发面（capability 属虚拟模型内部字段，走既有写锁）。

### 验证（8788）
- [ ] `gate-emb`(K3, embedding 上游)：`POST /v1/embeddings model=gate-emb` → 返回向量 + 用量计入。
- [ ] K3 鉴权：错 key 401。
- [ ] chat 虚拟模型请求 `/v1/embeddings` → 明确「能力不匹配」错误，不误路由。
- [ ] provider `capabilities` 不含 embedding 时自动换下一候选。

### 上线
同 Phase 1：8788 绿 → 秒级重启 8787。

---

## Phase 3 — Rerank · Audio · Image · Video（按序）

> 前提：Phase 2 框架使每项基本是「注册六件套」的机械增量；**Video 异步语义例外，需单独设计**。

### 3.1 Rerank `/v1/rerank`
- adapter：query + documents → `results[].score`。
- accounting：无标准 token → 记请求数与字符估算；provider `capabilities:["rerank"]`。

### 3.2 Audio TTS `/v1/audio/speech`
- 输入端 text → 输出**二进制 audio 流**；二进制中继（非 SSE/JSON），content-type 透传。
- accounting：按字符估算或单独「字节/生成数」指标；provider `capabilities:["audio"]`。（`transcriptions` 反向可作子项）

### 3.3 Image `/v1/images/generations`
- JSON 入，输出 base64/URL 透传；按「生成数」计量；provider `capabilities:["image"]`。

### 3.4 Video（最难，最后）`/v1/videos/generations` + `/v1/videos/<id>`
- **异步任务 + 轮询**：create 返回 taskId → GET 轮询上游 → 返回结果。
- 需**任务态存储**（内存 + 可选持久化）、TTL、取消；与同步中继范式冲突，**单独设计任务池，不与同步路径混用**。
- **任务池五原则（借鉴 sub2api ASYNC_IMAGE_TASKS 成品设计，2026-08-25 增补，Image 异步同样适用）**：
  1. **大结果外置**：视频/图像等 MB 级结果落盘 `data/tasks/`（或对象存储），任务记录只存小 JSON（引用+状态），防内存被结果撑爆；
  2. **同 key 轮询隔离**：只有提交任务时用的那把虚拟模型 Key 能轮询该任务，跨 key 轮询返回 not found（防越权窥测）；
  3. **功能门控**：存储未配置/未启用时异步端点返回 404 + 启动 WARN 列出缺失配置项（不做半残运行）；
  4. **关闭不搁浅**：停用开关后拒新任务，在途任务保持可轮询直至终态；
  5. **失败不存大 payload**：结果写盘失败 → 任务标 failed，绝不持久化原始大响应。
  另采纳其配套细节：轮询响应带 `expiresAt`；任务终态（completed/failed/expired）明确枚举。
- **任务态持久化选型（2026-08-25 技术栈评审定）**：用 **`node:sqlite`**（Node 22+ 内置，零第三方依赖）——任务记录/TTL/崩溃恢复由它承担，既跨过纯文件方案的费劲点，又不引入外部数据库，符合零依赖哲学。大结果仍按五原则落盘 `data/tasks/`。

### 跨项
- **记账扩展**：token 不再唯一——按能力分指标（`tokens|chars|generations|bytes`）。
- **面板**：虚拟模型加**能力选择器**；按能力探活/连通；分能力统计视图。
- 写安全覆盖所有新增可配置字段。

### 每项验证（8788）
独立性对应于该能力 mock 上游；正确的入口+鉴权+能力过滤+结果/度量+错误；无能力冲突。

### 上线
逐项 8788 绿 → 秒级重启 8787。

---

## 技术债清理（Phase 1.5，Phase 1 收尾后、Phase 2 开工前穿插执行；2026-08-25 技术栈评审产出）

> 评审结论：技术栈与「单人本地工具」定位高度匹配（内存实测 14.5~87MB、零供应链面），不换栈；以下三项是评审发现的、会随时间恶化的债，全部在零依赖哲学内，合计约 0.5~1 天。

### TD1 · 测试沉淀（最高优先，维护债主源）
- **现状**：Phase 1 开发期的验证脚本（tmp-verify-step1/23/4.mjs 等）用完即删，未沉淀为自动化测试；现有 scripts/test 集成套件依赖真实上游+运行网关，纯 mock 回归跑不了。
- **目标**：Step 1-5 的验证矩阵改造为常驻 mock 集成测试（scripts/test 已有 mock 基础设施：起隔离实例 + mock 上游 + 断言），纳入 `npm test`；覆盖：configVersion 409/并发唯一成功、虚拟模型路由/404/额度 429/档位补校验、两阶段鉴权 9 场景、删模型清 key。
- **收益**：后续任何重构（含 index.js 拆分）有回归网。

### TD2 · stats 历史保留窗口
- **现状**：`stats.daily/hourly` 按模型×日期无限累积，90 天视图只读不删，长期运行 stats.json 持续膨胀（当前 23KB，数月后可观）。
- **目标**：30s 落盘时顺带清理超过保留窗口（默认 90 天，常量可调）的日期键；一次性迁移兼容旧文件。

### TD3 · index.js 职责拆分（顺手级）
- **现状**：index.js 963 行承载 HTTP 路由+鉴权+forwardChain+统计+保存。
- **目标**：forwardChain（含 routes 构建/循环兜底）抽为独立模块；不紧急，与 TD1 同批做（有测试网后拆分安全）。

---

## 风险与依赖

| 风险/依赖 | 说明 | 对策 |
|---|---|---|
| **能力接口抽象质量** | Phase 2 抽象好则 Phase 3 是机械增量，否则每项重写 | Phase 2 先定死六件套契约；不要提前写具体能力代码 |
| **Video 异步语义** | 唯一与现有同步中继冲突的点 | 单独任务池设计，最后做 |
| **并发写** | 全局地基 | Phase 1 先落地写锁+版本检测，后续所有新配置都走它 |
| **鉴权多 key** | 常量时间比较、不泄露是哪个 key 不匹配；加密落盘、掩码 | 复用 `safeTokenCmp`；keys 库 `__mg_vm_*` |
| **模板/版本化** | 不迁移 localstorage 模板、不做 schema 版本化（YAGNI） | 虚拟模型存自包含快照 |
| **生产稳定性** | 大改不得影响线上 agent | 第 0 节：8787 不动 + 8788 开发 + mock + 秒切上线 |

---

## 执行入口（下一动作）
从 **Phase 1 开始**：先做「开发网关 8788 + 低成本配置 + mock」，再落地「并发写互斥/configVersion」地基 + 「virtualModels/每模型 key/面板交换位置」，全部在 8788 实测（含两页并发保存不丢数据）后经秒切上线 8787。