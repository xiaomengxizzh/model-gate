# 收工执行环境实测与隔离判决（2026-11-12）

本文件只记录实测事实与由此得到的判决，不含任何凭据、正文或个人内容。所有命令均只读或本地；未访问产品上游。

| 项 | 实测 | 证据命令 |
|---|---|---|
| DSH | 0.2.2-rc.1 | `dsh --version` |
| 执行模型 | `deepseek-v4.1-flash`（会话自报）；reasoning effort 生效 = UNKNOWN | 工具注册表；无遥测证明 |
| Node | v24.22.2 / npm 11.19.1；**无 Node 22/20/18 runner** | `node --version`；nvm 目录仅 v24.22.2 |
| Git | 2.53.0 | `git --version` |
| Codex CLI 二进制 | 0.167.0，可直接运行（`codex-cli 0.167.0`） | 二进制直跑 |
| Codex 包装器 | **损坏**：`ai/harness/codex/cli/bin/codex` 调用不存在的 `cli/sandbox/launch` | 对照 `ls` |
| unshare / bwrap | 均不可用（非特权 userns 被禁） | `unshare --net/-U/-rn`、`bwrap` stderr |
| sudo | 不可用（no_new_privs） | `sudo -n` |
| firejail / nsjail / nft / iptables | 均不存在 | `command -v` |
| 一般出网 | **可用**（`http://1.1.1.1` -> 301）；DNS 可用 | `curl -m 4` |
| 可写文件系统 | 仅会话工作区；`/tmp` 为每次调用重置的私有 tmpfs；`/home/*/ai/tmp`、`/var/tmp` 拒绝 | touch 探针 + `/proc/mounts` |
| Chrome | `/usr/bin/google-chrome` 存在 | `ls` |

## 判决

1. **Q02 的 OS 级"仅回环"约束不可得**。计划要求"找已存在 OS 级出网约束，验证仅回环，不把环境开关自身当证明"。本机既无 namespace 能力、无特权、无防火墙工具，且一般出网可用；因此无法给出可审计的"仅回环"证明。按验证指南：**Q02 → BLOCKED_ENV**（不是 PASS，也不是产品失败）。不得用 `MGR_E2E_NETWORK_ISOLATED=1` 之类的环境开关自证。
2. **Codex 安全启动器缺失**：验证指南指定的同一安全启动器不存在（`sandbox/launch` 文件缺失），逆证了第 1 条。
3. **Node 支持矩阵收敛到已实测的 Node 24 / Linux**；Node 18/20/22 未验收，不得以 skip 或历史记录代替。
4. **不申请提权、不安装任何工具来"造出"隔离**：这属于关闭沙箱/安装新资源，无用户逐项授权。留作重开条件。

## 重开条件（Q02）

- 提供可执行且可审计的 OS 级出网约束（如可用的 userns + netns、或已配置的 nftables 规则、或受控宿主），并能对**子进程**证明仅回环；
- 恢复 `ai/harness/codex/cli/bin/codex` 的安全启动器，或用等价的、经审查的启动器；
- 二者齐备后按 `tasks/verification.md` 的两条命令执行并留收据。
