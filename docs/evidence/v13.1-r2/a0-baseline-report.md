# A0｜V13.1 R2 基线冻结与取证报告

- 日期：2026-11-24
- 执行树：`deploy/modelgate-ux-v3`
- 采集 HEAD：`48325bf0027e583108c66677c7dec15fd5007228`
- 固定历史开发基线：`0ba7c1fe7c8becd97a927004208cbc06c89f269c`
- 结论：**输入完整且哈希一致；A0 通过。真实付费与原版 GUI 测试未授权，相关验收保持 BLOCKED。**
- 新增大型安装/下载：无。历史提议仅供研究，不自动执行。

## 1. 交付包核验

用户提供的实际文件名是 URL 编码形式：`$HOME/下载/ModelGate-V13.1-%E5%AE%8C%E6%95%B4%E6%89%A7%E8%A1%8C%E4%BA%A4%E4%BB%98%E5%8C%85-R2.zip`。

| 项 | 结果 |
| --- | --- |
| ZIP SHA256 | `a959520beb9912b5f1d2734afe4b93c6f5b044f871875dc8b520be99476dc37d` |
| 压缩包体积 | 7,759,788 bytes；解压内容 8,968,714 bytes |
| 清单 | 74 个文件 |
| `sha256sum -c SHA256SUMS.txt` | 74/74 OK |
| V13 HTML | `735e6d10250d5ac68f8d721ce2ec3e8f2fda8afcf717f17c96ca9eaff320eb70` |
| V13.1 HTML | `c3395588357af460708ceae3eac89e3c1b076a7e826fc190e04de040541a7343` |
| 供应商目录 | `1a2a160dd39142488f340f3dcb147616314ffad89a03abc9f7472bd0a2eb08ba`；63 模板、87 示例模型 |
| R2 实施方案 | 包内哈希通过；与单独附件内容一致 |
| 视觉审计 | 266 页面组合、72 弹窗组合、5 项交互，均为前轮离线 HTML 注入记录，未在本轮重跑 |
| 三份 CSV | 均已读取并复制到 `input/04-执行清单/`，不把初始 NOT_TESTED 改为通过 |

固定设计输入已复制到 `docs/evidence/v13.1-r2/input/`；完整图集仍在用户交付包中，未把 74 个文件重复复制进仓库。

## 2. 文档与现场核对

已读：仓库 `README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`RESOURCE_APPROVAL.md`、`docs/audit-20261108.md`、`docs/development-plan.md`、V1 产品合同、V2 范围修订、三模式映射、V2 HANDOFF、管理 API/UI 投影合同、包 README/manifest/R2/启动词、两版 HTML、目录 JSON、设计规范、原始视觉 JSON、三份 CSV。

- 产品优先级：2026-11-24 R2 为本次前后端一体化执行基线；现行 V2 将强制真实模型收敛为 Go `deepseek-v4.1-flash`，GPT 真实测试仅 `gpt-6-luna`。R2 的通用服务/池/Harness 能力作为产品能力保留，不把 63 个模板标成已验收。
- 当前分支相对固定历史基线：26 个文件、660 insertions、90 deletions。主要是一个后续提交 `48325bf`（Responses 续轮 function_call 补全、官方目录刷新及文档/测试）。不盲目回退。
- 开工未提交项只有 `?? .tmp-ui/`；其中是现有截图与 status.json。本轮未修改、删除或纳入交付。
- 未读取或打印私有 Key、auth token、请求正文；未修改 `config/`、用户 `~/.codex`、生产 HOME 或 8787。
- 只读观察 systemd user 服务：`model-gateway.service` active，MainPID `38474`，启动时间 2026-11-24 11:21:36 CST。仅证明观察时状态，不证明运行代码版本或健康；未重启、停止或替换。
- `git status --short` 在本轮产生新文件前再次核对，任何既有未知项均保留。

## 3. 环境与资源预检

| 资源 | 本机状态 | 证据 | 动作 |
| --- | --- | --- | --- |
| Node | 存在 v24.22.2 | `node --version` | 复用，满足 >=24 |
| npm | 存在 11.19.1 | `npm --version` | 复用，无安装 |
| Chrome | 存在 `/usr/bin/google-chrome` | `command -v` | 复用真实浏览器 |
| Codex | 存在 `$HOME/.local/bin/codex` | `command -v` | 本轮不启动真实推理 |
| CC Switch | 存在 `/usr/bin/cc-switch`；本地目录 66 MB | 版本与哈希见 A1 | 只读复用，不下载 |
| 浏览器自动化包 | 未检查/不需要新增 | 使用现有 Chrome CDP | 不安装 Playwright |
| 模型权重/重型依赖 | 未请求 | RESOURCE_APPROVAL | 不下载、不安装 |

## 4. 原型事实与偏差

- 两版均提取到 295 处按钮绑定、125 个唯一 action token；V13.1 多层覆盖了同名函数，证明不能复制其单文件 dispatch/state 为生产实现。
- V13 为 235,673 个 Unicode 字符、391 行；V13.1 为 254,894 个 Unicode 字符、424 行、291,140 bytes。R2 §2.1 把 V13.1 写成“235673 字符、390 行”，该描述实际对应 V13，属于文档元数据偏差；文件 SHA 正确，产品范围不受影响。
- 六项一级导航固定为：应用接入、模型服务、模型池、用量分析、稳定性策略、设置。高级模型目录、路由规则、API 与密钥、请求日志按需展开。
- 19 个页面状态与 12 类弹窗是最低视觉范围。旧动作中的“模拟检查/模拟限流/模拟同步/运行模拟/重置演示”不得进入生产 UI。
- 视觉审计只覆盖离线原型，不能证明真实 origin、刷新/前进后退、真实 API、真实服务、屏幕阅读器或用户旅程。

## 5. 授权矩阵

| 项目 | 本轮状态 | 边界 |
| --- | --- | --- |
| 源码研究、契约、ADR、纯代码 | AUTHORIZED | 可执行 |
| 隔离 HTTP + 本地 fixture + 真实浏览器 | AUTHORIZED | 动态回环端口、临时 HOME/config、虚构 Key |
| 真实 DeepSeek V4.1 Flash | BLOCKED | 用户明确选择“暂不授权付费测试” |
| 原版 Codex GUI / GPT-6 Luna | BLOCKED | 同上；不得用 CLI 或 mock 替代签收 |
| 新依赖、浏览器包、模型权重 | NOT_RUN_RESOURCE_APPROVAL | 未请求；先复用现有工具 |
| 生产 8787、旧 UI 替换、systemd 重启 | BLOCKED | 须所有者单独批准 |
| push、merge、PR、发布 | BLOCKED | 须所有者单独批准；本轮不提交 git commit |

## 6. A0 退出结论与残余风险

A0 门禁满足：固定 SHA、包哈希、真实/模拟边界、工作区、合同、授权和环境均有证据。后续风险：

1. R2 固定历史 SHA 比当前 HEAD 少一个续轮/目录修复提交；开发从当前 HEAD 继续，不丢失该修复。
2. 当前 `/ui-next` 与 V13.1 六项导航不一致；A2 必须独立预览，不得就地覆盖。
3. 历史“生产 active”只读观察不等于版本/健康证明；最终切换前需单独批准并采集生产回执。
4. 当前 V2 与 R2 的范围表述有层次差异：通用能力按 R2 建设，真实付费首轮只测指定 Go 模型与 Luna；不借 R2 扩大付费测试范围。

证据索引：`input/SHA256SUMS.txt`、`input/manifest.json`、`input/01-原型与目录/`、`input/01-原型与目录/modelgate-v12-provider-catalog.json`、`input/03-验收证据/modelgate-v13.1-visual-audit.json`、`input/04-执行清单/`。
