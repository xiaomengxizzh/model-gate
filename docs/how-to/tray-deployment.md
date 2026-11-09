# 托盘管理器部署、替换与回滚（Linux / Windows）

状态：2026-11-09，HEAD `b2283ae`。本页只写托盘这一**可选本机组件**的部署、替换、回滚与 smoke 记录模板；网关本体见[部署与回滚](deploy-and-rollback.md)，配置字段见[配置参考](../reference/configuration.md)，运行排错见[运维指南](operations.md)。

**证据边界**：本页由源码与既有脚本审阅写成。**Linux 托盘未在本卡运行；Windows 版本未编译、未运行；没有桌面环境、托盘图标或计费数字的视觉验收。** 文中的 Windows 步骤全部标注为"未在 Windows 实跑"，不得当作已通过验收。

## 1. 定位与共同边界

- 托盘是可选客户端，不是网关运行的必要条件。Linux 版由 systemd 用户服务守护网关，托盘只提供状态与快捷操作；Windows 版由托盘拉起/守护网关进程。两种实现的职责不同，**不能互相套用步骤**。
- 托盘与网关通过本机 HTTP 通信：默认 `http://127.0.0.1:8787`，数据源为 `/healthz`、`/api/status`（Linux 还读 `/api/model-stats?days=1`）。
- 托盘不是管理面的替代品：它不提供配置编辑、不代理模型请求、不保存上游 Key。
- 仓库只保存源码、图标、构建脚本和价格表**模板**；`mg-tray.exe`、`mg-tray.new.exe` 与 `config/admin.token` 已在 `.gitignore` 中，不得提交。价格、令牌、日志、主机名属于本机部署事实，不由仓库状态证明。
- 本页不记录任何真实令牌、Key、账号、内网地址或价格报价；smoke 记录保存在仓库外的运维记录中。

## 2. Linux：python 托盘

### 2.1 组成与前置条件

| 文件 | 作用 |
| --- | --- |
| `scripts/tray/mg-tray-linux.py` | 托盘主程序（Ayatana AppIndicator + GTK）；本机工作区文件，仓库不跟踪 |
| `scripts/tray/icons/mg-tray-running.png` / `mg-tray-stopped.png` | 两态图标；本机工作区文件，仓库不跟踪 |
| `scripts/tray/mg-prices.json` | **用户自填**的本地单价表；缺失时托盘不显示花费（模板样例见工作区，仓库不跟踪） |

脚本顶部写死了部署相关常量（`scripts/tray/mg-tray-linux.py` 第 22–26 行）：

- `PROJ`：项目绝对路径；
- `BASE`：`http://127.0.0.1:8787`；
- `UNIT`：`model-gateway.service`（systemd 用户单元）；
- `ICON_DIR` / `PRICE_FILE`：相对 `PROJ` 的路径。

**部署前必须逐项核对**：仓库搬到别处、网关端口不是 8787、systemd 单元名不同，都要先改这些常量，否则托盘会显示错误状态或操作错服务。

依赖（只检查，不在本页执行安装；缺少时按 [RESOURCE_APPROVAL.md](../../RESOURCE_APPROVAL.md) 取得用户授权后再装）：

```bash
python3 -c "import gi; gi.require_version('AyatanaAppIndicator3','0.1'); from gi.repository import AyatanaAppIndicator3; print('tray deps: ok')"
systemctl --user status model-gateway.service --no-pager
curl -fsS http://127.0.0.1:8787/healthz
```

脚本的注释目标环境是 KDE Plasma Wayland，需要用户会话 D-Bus。注意源码**硬编码检查** `/run/user/1000/bus`：uid 不是 1000 的用户需要先改脚本，否则会打印"无用户会话总线，退出"并返回 1。其他桌面环境未验证。

### 2.2 首次部署

1. 确认 systemd 用户单元存在且网关可被当前用户启停（`systemctl --user`）。托盘只调用 `systemctl --user start/stop/restart`，不直接拉起 `node`。
2. 按 §2.1 修改脚本常量与价格表路径；确认 `PRICE_FILE` 存在（可以只有 `{}` 或模板字段，缺失时脚本静默返回空表）。
3. 启动托盘（前台运行便于看错误）：
   ```bash
   /usr/bin/python3 /path/to/model-gateway/scripts/tray/mg-tray-linux.py
   ```
4. 单实例：脚本用 `/tmp/mg-tray-linux.lock` 记录 pid；已有存活实例时第二次启动直接返回 0；锁文件过期/进程不存在时自动接管。不要并行启动多个。
5. 需要开机自启时，由用户在本机创建桌面自启动项（不要提交到仓库）：
   ```ini
   [Desktop Entry]
   Type=Application
   Name=ModelGate Tray
   Exec=/usr/bin/python3 /path/to/model-gateway/scripts/tray/mg-tray-linux.py
   X-GNOME-Autostart-enabled=true
   ```
   保存为 `~/.config/autostart/model-gateway-tray.desktop`。不同桌面环境的自启动目录/字段可能不同，未验证。
6. 右键菜单应出现：运行状态、今日 token/请求、每模型今日 in/out（有价时带花费）、打开面板、启动/停止/重启网关、打开日志目录、退出托盘（网关继续运行）。图标绿点=收到 `/api/status`，灰点=未收到。

### 2.3 替换（升级托盘脚本）

1. 先备份当前脚本与图标：`cp scripts/tray/mg-tray-linux.py scripts/tray/mg-tray-linux.py.bak-20261109`（`*.bak-*` 已被忽略）。
2. 从托盘菜单选择"退出托盘"；网关不受影响。
3. 放入新脚本/图标；重新核对 §2.1 常量没有被上游模板覆盖。
4. 重新启动托盘，按 §2.5 的 smoke 清单验证。
5. 价格表改动不需要重启：脚本每 30 秒重新读 `mg-prices.json`；图标变更需要重启托盘。

### 2.4 回滚

1. 退出托盘。
2. 恢复备份脚本/图标（覆盖新版本）。
3. 启动托盘，确认图标、菜单、启动/停止动作恢复正常。
4. 不需要迁移配置或统计；托盘没有持久化数据。回滚后仍要记录原因、时间与结果。

### 2.5 Linux smoke 清单

| 检查 | 预期 | 备注 |
| --- | --- | --- |
| 依赖导入 | 打印 `tray deps: ok` | 缺依赖时不要自行安装 |
| 单实例 | 第二次启动立即退出，原托盘仍在 | 检查 `/tmp/mg-tray-linux.lock` 与 pid |
| 运行态图标 | 网关运行时绿点 | 依赖 `/api/status` 成功 |
| 停止态图标 | 网关停止时灰点 | 依赖 `/healthz` 与 `/api/status` 失败 |
| 菜单数据 | 今日 token、请求数、模型明细 | 来源 `/api/status` + `/api/model-stats?days=1` |
| 花费 | 仅对价格表内模型显示；未列出的不显示 | 数字是估算，不是账单 |
| 面板 | 打开 `http://127.0.0.1:8787` | 浏览器实际可访问 |
| 启动/停止/重启 | systemd 用户单元状态随之变化 | 托盘调用 `systemctl --user` |
| 日志目录 | 打开 `PROJ/logs` | 目录不存在时可能无反应 |
| 退出托盘 | 托盘退出，网关继续运行 | 与 Windows 的"退出会停网关"不同 |

**已知限制（源码审阅，未运行验证）**：启用 `MG_ADMIN_TOKEN` 后，`/api/status` 与 `/api/model-stats` 返回 401；脚本捕获异常并把状态当作 `None`，可能显示"网关未运行"，但启动/停止按钮仍会调用 systemd。启用令牌的实例不要只信图标，应以 `systemctl --user status` 与 `curl /healthz` 为准。托盘目前不读取管理令牌；需要令牌显示统计属于后续改造。

### 2.6 Linux smoke 记录模板

把下表复制到仓库外的运维记录，逐项填写；不要提交主机名、令牌、日志原文。

| 字段 | 内容 |
| --- | --- |
| 日期/操作者 | |
| 主机/桌面环境 | |
| 提交 | `git rev-parse --short HEAD` |
| Python/依赖版本 | |
| 网关单元/端口 | |
| 托盘脚本路径 | |
| 检查项 | 见 §2.5；逐项写 实际结果 / PASS / FAIL / NOT RUN |
| 令牌模式（开/关） | |
| 回滚是否验证 | |
| 未验证项 | |
| 结论 | 只能写"本机 smoke 通过/失败"，不得写"生产已验收" |

## 3. Windows：mg-tray.exe

### 3.1 组成与构建

| 文件 | 作用 |
| --- | --- |
| [mg-tray.cs](../../scripts/tray/mg-tray.cs) | Windows 托盘/小窗/看门狗源码 |
| [build.cmd](../../scripts/tray/build.cmd) | 用 Windows 自带 .NET Framework `csc.exe` 编译，零第三方依赖 |
| [swap.cmd](../../scripts/tray/swap.cmd) | 用已准备好的 `mg-tray.new.exe` 替换正在运行的托盘 |
| [mg-tray.ico](../../scripts/tray/mg-tray.ico) | 图标 |

产物为仓库根目录的 `mg-tray.exe`，已被 `.gitignore` 忽略；源码入库，exe 不入库。`build.cmd` 是批处理，修改时必须保持 **CRLF、无 BOM**（仓库规则）。

构建（**未在 Windows 实跑**）：

```bat
cd /d <仓库>\scripts\tray
build.cmd
```

预期输出 `Build OK: mg-tray.exe at project root`；失败时脚本打印 `[ERROR] csc.exe not found...` 或 `[ERROR] build failed` 并返回非 0。构建前确认 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（或 32 位路径）存在；缺失时按资源规则处理，不要下载替代工具链。

### 3.2 首次部署（未在 Windows 实跑）

1. 在 Windows 主机构建或取得 `mg-tray.exe`，放在仓库根目录（与 `config/` 同级）；托盘按 exe 所在目录解析配置与日志路径。
2. 确认网关配置、端口与 `config/` 就位；如果启用了管理令牌，按 §4 准备本机私有令牌来源，**不要把令牌写进 exe、脚本或仓库**。
3. 双击 `mg-tray.exe` 启动；应出现托盘图标与悬浮小窗，显示 ● 状态、uptime、今日 token、请求/错误。
4. 右键菜单：面板、小窗、启动、停止、重启、开机自启（写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `model-gateway-tray` 值，免管理员）、日志文件夹、退出（会停止网关，有确认）。
5. 看门狗：托盘拉起的网关崩溃后约 5 秒重启；连续快速失败达到阈值会熔断并气泡提示；启动前清理占用端口的残留 node（与 `start.bat` 同语义）。检测到端口已有外部 node 时显示"外部实例/未接管"，不重复拉起。
6. 开机自启由菜单开关控制；关闭自启会删除上述 Run 值。

### 3.3 替换（未在 Windows 实跑）

推荐用 `swap.cmd`：

1. 先把新构建放到仓库根目录并命名为 `mg-tray.new.exe`（已在 `.gitignore` 中）。
2. 运行 `scripts/tray/swap.cmd`。它会 `taskkill /F /IM mg-tray.exe`、等待 2 秒、把 `mg-tray.new.exe` 覆盖为 `mg-tray.exe`、再启动。
3. **注意**：托盘在守护网关；替换托盘会让网关短暂重启（`swap.cmd` 注释已说明）。安排在维护窗口，避免正在进行的请求。
4. 手动替代方案：任务管理器结束 `mg-tray.exe` → 备份旧 exe → 覆盖新 exe → 启动 → 按 §3.5 验证。

### 3.4 回滚（未在 Windows 实跑）

1. 保留上一版 exe 的本地备份（例如 `mg-tray.exe.bak-20261109`，不要提交）。
2. 结束当前 `mg-tray.exe`，把备份改回 `mg-tray.exe`，重新启动。
3. 如果新版本导致托盘无法启动、也无法通过菜单关闭自启，可在 `cmd` 中删除 Run 值：
   ```bat
   reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v model-gateway-tray /f
   ```
4. 验证托盘图标、小窗、启动/停止/重启、面板与日志入口；记录回滚原因与结果。

### 3.5 Windows smoke 清单（全部 NOT EXECUTED）

| 检查 | 预期 | 状态 |
| --- | --- | --- |
| 构建 | `build.cmd` 输出 Build OK，生成 `mg-tray.exe` | NOT EXECUTED（未在 Windows 实跑） |
| 启动 | 托盘图标 + 悬浮小窗出现 | NOT EXECUTED |
| 状态 | ● 运行、uptime、今日 token、请求/错误 | NOT EXECUTED |
| 面板 | 按钮打开 `http://127.0.0.1:8787` | NOT EXECUTED |
| 启动/停止/重启 | 网关进程与端口随之变化 | NOT EXECUTED |
| 看门狗 | 结束网关后约 5 秒自动重启；连续失败熔断 | NOT EXECUTED |
| 外部实例 | 已有 node 占用端口时显示"外部实例/未接管" | NOT EXECUTED |
| 开机自启 | 菜单开关写/删 HKCU Run 值 | NOT EXECUTED |
| 令牌模式 | 已设管理令牌时统计降级为"统计需令牌" | NOT EXECUTED |
| 价格来源 | 目标为用户输入的本地价格表；当前 Windows 源码自动拉取，属待改偏差 | NOT EXECUTED / 待改 |
| 退出 | 确认后停止网关并退出托盘 | NOT EXECUTED |
| 替换/回滚 | `swap.cmd` 与手工回滚均可恢复 | NOT EXECUTED |

### 3.6 Windows smoke 记录模板

| 字段 | 内容 |
| --- | --- |
| 日期/操作者 | |
| Windows 版本 / .NET Framework | |
| 提交与 exe 哈希 | |
| 构建命令与输出 | |
| 启动方式/端口 | |
| 令牌模式（开/关） | |
| 检查项 | 见 §3.5；逐项写 实际结果 / PASS / FAIL / NOT RUN |
| 替换/回滚是否验证 | |
| 未验证项 | |
| 结论 | 只能写"本机 smoke 通过/失败"；未实跑就写 NOT EXECUTED |

## 4. 价格与凭据

### 4.1 价格必须由用户输入

- **策略**：托盘显示的花费是"按用户填写的单价 × 网关 token 统计"的估算，不是上游账单；仓库不提供权威报价，不把任何厂商价格作为默认权威值，也不内置默认凭据。**Windows 当前实现是例外，见下条，部署前必须知晓。**
- **Linux**：`scripts/tray/mg-prices.json` 是本地用户文件，键=网关模型名，`in/out`=每 100 万 token 的单价；未列出的模型不显示花费，文件缺失/损坏时静默不显示。当前工作区里的该文件是**模板样例**，数值不代表任何厂商报价；部署时按自己的账单替换或清空。建议由 Lead 决定是否把该本地文件加入 `.gitignore`（当前未被忽略）。
- **Windows**：当前 `mg-tray.cs` 的计费不是读用户价格表，而是从上游 `/v1/models` 自动拉取 `pricing/effective_pricing` 计算（源码 355–399 行），默认 `baseUrl` 与 `JIYUAN_API_KEY` 环境变量名写死在源码里，可用 `gateway.local.json` 的 `jiyuan` 段覆盖。**这与"价格必须是用户输入"的目标不一致**，属于已记录的偏差；本卡不修改该源码。没有内置 Key 值，但硬编码的默认端点/变量名是部署耦合。使用前必须确认端点与价格来源，且不要把自动拉取的价格当权威账单。是否需要改为纯用户输入，需 Lead 决定并另开实现卡。
- 计费口径（Windows 源码 407–442 行）：未命中提示词×输入价 + 缓存命中×缓存读价 + 输出×输出价；只统计价表内模型。Linux 只按 `in/out` 两价估算，不含缓存价。两者都不是发票。

### 4.2 凭据与令牌

- 托盘不内置任何默认令牌。Linux 脚本当前**不发送**管理令牌；启用令牌后状态读取会 401（见 §2.5 限制）。
- Windows 托盘从本机私有来源读取管理令牌（源码 `ReadAdminToken`，310–353 行）：托盘专用本地文件（`config/admin.token`，已 gitignore）、用户级环境变量、进程环境变量、`server.adminToken`，以及旧版明文 keys 的兼容兜底。**具体值不得写入仓库、文档、截图、smoke 记录或 exe**；本地文件权限应收紧（Windows ACL/仅当前用户）。
- **优先级不一致**：网关实际门禁优先级是 `MG_ADMIN_TOKEN` 环境变量 > `server.adminToken` > 面板写入；而 Windows 托盘 `ReadAdminToken` 的读取顺序是本地令牌文件 → 用户级环境变量 → 进程环境变量 → `server.adminToken` → 旧版明文 keys。两者可能读到不同值；以网关实际生效的令牌为准，并保持本机私有文件与进程环境一致。通过面板清除令牌不会移除环境变量值。
- 托盘诊断日志（Windows 写在托盘根目录的 `logs/tray-debug.txt`，每轮覆盖）只用于本机排错，不得提交；分享前检查是否含模型名、端点或路径。
- 任何"设置 Key/令牌"的操作都应走网关管理面或本机私有文件，不要经过托盘配置文件。

## 5. 未验证项

- Linux：托盘脚本、图标、依赖、systemd 用户单元、菜单动作、令牌模式、价格读取、自启动项均**未在本卡运行**；未做桌面/Wayland 视觉验收。
- Windows：**未在 Windows 编译、未运行 exe、未验证 csc、未验证看门狗/自启/替换/回滚**；所有 Windows 步骤来自源码与构建脚本，状态一律 NOT EXECUTED。
- 未验证托盘对真实上游/真实计费的影响；托盘只读统计，但"模型测试/探测"类操作不在托盘内，仍应单独授权。
- 未验证 `mg-prices.json` 的实时重载（源码为 30 秒定时器，未实跑）。
- 未验证跨桌面环境（GNOME 等）与多用户会话。

## 6. 维护

- 修改托盘源码、路径常量、价格来源、令牌来源或构建脚本时，同步更新本页与 [配置参考](../reference/configuration.md) 的"托盘小窗管理器"段。
- smoke 记录写在本机运维记录，不提交仓库；如必须入库，先脱敏主机名、路径、令牌、价格与日志原文。
- 不要把本页的步骤当成"已部署"证明；是否在运行、哪个版本、哪个端口，必须现场核对。
