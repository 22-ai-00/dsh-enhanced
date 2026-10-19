# `dsh-rsi`：安装和管理 DSH enhanced

`dsh-rsi` 管理 macOS / Linux 上的 DSH enhanced 插件集合。安装器会安装这个全局命令；也可单独安装 CLI（Node.js `^22.19.0 || >=24.0.0`）：

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
```

常用操作从这里开始：

```sh
dsh-rsi install                     # 交互式安装，默认 supervised 场景
dsh-rsi status                      # 查看 Home、profile 和服务状态
dsh-rsi doctor                      # 查看状态和已知错误日志线索
dsh-rsi logs --profile web    # 查看日志尾部
dsh-rsi web-url --profile web # 查看日志中最近的 Web 授权 URL
dsh-rsi restart --profile web # 重启已注册的常驻服务
```

首次 `supervised` 安装需要在交互式终端完成飞书 owner 配对和模型配置；未完成配对时，`--yes` 不会跳过 onboarding。新会话默认 Full access，可访问任意文件和网络，不逐次审批；按需收紧权限见[安装指南](../../scripts/install/README.md)。完整安装参数用 `dsh-rsi install --help` 查看。若只需轻量场景，可运行 `dsh-rsi install --scenario core --yes`；本地 checkout 用 `dsh-rsi install --local <checkout目录>`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `status`（省略命令时默认） | 只读查看 DSH Home、profile、安装形态、Host 和受管服务等状态。 |
| `doctor` | 只读查看状态，并扫描 Host 错误日志中的已知问题。 |
| `logs` | 查看各 profile 的 Host 日志尾部；`--lines <n>` 设置每份日志行数（1–10000，默认 200），`--errors-only` 只看错误日志。 |
| `web-url` | 从受管服务日志取最近的、带 token 的 Web 授权 URL；请按凭据保护该 URL。服务未运行时先 `start`，旧 URL 重启后可能失效。 |
| `start` / `stop` / `restart` | 只切换**已注册**常驻服务的运行状态，保留服务定义和数据；未注册时会报错，需通过 `install` 注册。 |
| `version` | 打印 CLI 版本。 |

不带 `--profile` 时，服务、日志和 Web URL 命令面向当前 DSH Home 下的全部真实 profile。可用 `--profile <name>` 指定一个。`status` / `doctor` 返回 0 只说明诊断命令执行成功，不证明真实模型可用或普通使用学习闭环通过；当前能力边界见[RSI 状态](../../docs/rsi-status.md)。

## 升级与重装

```sh
dsh-rsi update --dry-run                # 预览 CLI 自身升级
dsh-rsi update                          # 只升级全局 dsh-rsi
dsh-rsi update --all --yes              # Linux：CLI + 已安装插件集合原地升级
dsh-rsi update --all --confirm-dsh-home-stopped # macOS：整个 Home 已停时
dsh-rsi reinstall --dry-run             # 预览清理与重新安装两阶段
dsh-rsi reinstall                       # 备份、删除、重新安装并重做 onboarding
```

`update --all` 先升级 CLI，再委托安装器升级已安装的插件集合，保留 patch、凭据、Session 和 Goal；它不是对所有 Home 通用的升级路径。Linux 已注册的受管服务由升级事务停服并恢复，额外的手工 Host 须先停止。macOS 须先停止**同一 DSH Home 的全部 Host**，在整个升级期间保持停止，并显式传 `--confirm-dsh-home-stopped`；冻结的原生 owner/source Home 不支持普通原地升级。未冻结的 Mac Home 更新完成后，使用 `dsh-rsi start` 恢复服务。受管 Host 的版本迁移还有独立边界，详见[安装维护说明](../../scripts/install/maintenance.md)。可用 `update --version <精确版本或dist-tag>` 选择 CLI 版本；`--all` 下其它安装器选项可继续透传。

`install` 用于安装或修复；`reinstall` **先执行 purge，再执行 install**，默认在 `~` 生成备份，删除原数据后重新走安装和 owner onboarding。`reinstall --profile <name>` 只清理并重装该 profile。`--yes` 跳过清理确认并透传安装器，不能代替首次配对或已有 Automation 的单独确认；`--dry-run` 同时预览清理和安装。安装场景、模型及 Host 选择见[安装指南](../../scripts/install/README.md)。

## 故障与卸载

先运行 `dsh-rsi doctor`，再用 `dsh-rsi logs --profile <name> --errors-only` 看日志。常驻服务未注册时，`start` / `stop` / `restart` 不会创建服务；按提示重新运行 `install` 并选择有常驻服务的场景。维护和迁移故障见[安装维护说明](../../scripts/install/maintenance.md)；全局 CLI 损坏时见[单文件救机入口](../../scripts/install/maintenance.md#彻底卸载purge)。

```sh
dsh-rsi purge --dry-run                  # 预览删除范围
dsh-rsi purge                            # 输入 purge 确认
dsh-rsi purge --profile web --yes        # 只删除一个 profile
dsh-rsi purge --yes --keep-keychain      # 保留外部凭据
```

`purge` 会停用并注销受管服务，默认先在 `~` 创建权限为 0600 的 `dsh-purge-backup-<UTC时间戳>.tar.gz`。全量清理会删除整个 DSH Home（含 profile、历史与 Home 内凭据）、相关生命周期残留，并清理可定位的 macOS Keychain / Linux Secret Service 凭据；单 profile 清理只删除该 profile、对应日志和诊断，保留其他 profile 与共享 Home。两者均不会删除 local checkout 源码；全局 `@deepseek-ai/dsh` Host 默认保留。删除文件后若外部凭据清理失败，命令会报错，已删文件不会回滚。

`--yes` 跳过输入 `purge` 的确认，也可能终止已确认属于目标 Home 的残留进程；无法确认归属的进程仍会阻止清理。`--no-backup` 使被删数据和 Home 内凭据记录无法从本次备份恢复。`--keep-keychain` 保留外部凭据；`--remove-host` 额外卸载全局 Host，仅可用于不指定 `--profile` 的全量清理。`reinstall` 也接受这些清理选项。安装器的 `--operation uninstall` 是保留数据的归档操作，语义不同于 `purge`。

## 选项与退出码

用法：`dsh-rsi [全局选项] <命令> [命令参数]`。`--dsh-home <path>` 选择 Home（默认 `$DSH_HOME`，否则 `~/.dsh`）；`--profile <name>` 选择 profile；`--dry-run` 预览操作；`--yes` 适用于清理确认并在安装时透传。`-h` / `--help` 查看 CLI 帮助，`install --help` 查看安装器帮助。`--capabilities` 是供救机脚本使用的只读 JSON 探测接口。

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功执行，包含只读查看和 dry-run；不代表模型或学习能力已验证。 |
| `1` | CLI 操作失败，例如服务未注册、Home/进程归属无法确认、备份或清理失败；不存在的 profile 也报错。 |
| `2` | CLI 参数错误。 |
| 其它非零 | `install` / `reinstall` 委托安装器后，透传其退出码。 |

许可证：MIT。
