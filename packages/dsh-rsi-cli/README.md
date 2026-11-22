# `dsh-rsi`：安装和管理 DSH enhanced

`dsh-rsi` 管理 macOS / Linux 上的 DSH enhanced 插件集合。安装器会安装这个全局命令；也可单独安装 CLI（Node.js `^22.19.0 || >=24.0.0`）：

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
```

常用操作从这里开始：

```sh
dsh-rsi install                     # 交互式安装，默认 supervised 场景
dsh-rsi open --profile web          # 打开本地 Web UI 与「文鳐」控制台
dsh-rsi status --json               # 结构化查看 Home、.dsh-rsi-host.json 绑定与服务状态
dsh-rsi doctor --json               # 只读实时体检（配置、traex/agy 登录、autonomy、OS 前提）
dsh-rsi growth-report --since 7d    # 只读成长计分卡（纠正率、记忆召回、候选验收、通知、成本与联想层留出对照）
dsh-rsi logs --profile web            # 查看日志尾部
dsh-rsi web-url --profile web         # 仅读取受管服务最近的 Web 授权 URL
dsh-rsi restart --profile web         # 重启已注册的常驻服务
```

首次 `supervised` 安装需要在交互式终端完成飞书 owner 配对和模型配置；未完成配对时，`--yes` 不会跳过 onboarding。新会话默认 Full access，可访问任意文件和网络，不逐次审批；按需收紧权限见[安装指南](../../scripts/install/README.md)。完整安装参数用 `dsh-rsi install --help` 查看。若只需轻量场景，可运行 `dsh-rsi install --scenario core --yes`；本地 checkout 用 `dsh-rsi install --local <checkout目录>`。

Linux native 安装及运行要求已委派给当前用户的 cgroup v1 四控制器或统一 cgroup v2 子树（`/sys/fs/cgroup/dsh-native/uid-<uid>` 或 `systemd --user` `.../user@<uid>.service/dsh-native/uid-<uid>`），不会自动委派或提权。完整准备条件见[安装指南](../../scripts/install/README.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `status`（省略命令时默认） | 只读查看 DSH Home、`.dsh-rsi-host.json` 私有 Host 绑定、`.dsh-enhanced/install-intent.json`、profile、安装形态（npm/local）、受管服务、`.credentials.yaml` 键名（不含密钥值）及生命周期残留；支持 `--json`。 |
| `doctor` | 全面实时只读诊断：检查 `.dsh-rsi-host.json` 绑定 Host、`--dump-config` 组合（含 `traex`/`agy`、`dreaming` 前置；对 Electron 独占托管的 `desktop` profile 直接只读校验 `package.json` 与 `cordis.patch.yml`，损坏或 YAML 语法错误仍 fail-closed）、凭据权限与环境变量、`traex login status` 与无交互 `agy models`、`dsh-autonomy-doctor --readiness`、回环监听与脱敏 Web URL、OS 前提及错误日志；支持 `--json`（隐藏 token 与密钥）。 |
| `growth-report` | 只读成长计分卡（零 schema 变更）：汇总窗口（`--since <7d\|14d\|24h\|...>`，默认 `7d`；可选 `--now <ms\|iso>` 固定重放时刻）内的任务与纠正/重做/撤回率及趋势、新增与有来源记忆及提示词暴露次数、候选生成/验收通过与失败/采用/回退、通知送达/反应/忽略与 `would-accept` 吻合度及 1/4 留出已决样本数、按冻结模型分层的成本与延迟分布、第 6 节联想层在线指标（非留出热路径 `p50`/`p99` 延迟、超时率、回退步数、注入条数与按来源贡献、强/弱使用率、`assoc_read` 命中率、参数档案版本与采用/回滚次数、可选 S3 隐式低可信信号/生产评估池/待处理技能候选计数及可选 S4 Web 学习运行/预算耗尽/入库页面/活跃节点/请求与字节使用计数，在旧库保持为 `null`）与密封留出组 vs 注入组任务对照（含窗口内活跃任务的跨窗口前序 `assoc_holdout_assignments` 对账，关联 Evaluation 与可选 `assoc_task_telemetry`；当评估或轮数/成本/token 遥测缺失时严格返回 `null` / `不可用`，绝不伪造为 `0`），并核对记忆通道 14 天预登记口径与主动放宽 20 样本门控；严格区分 `no-data` 与 `zero`，支持 `--json`。 |
| `open` | 读取 `.dsh-rsi-host.json` 绑定 Host 打开 Web UI 与「文鳐」Owner Console：受管服务等待 URL 最多 `--wait` 秒（默认 `8`），未注册服务的轻量场景（`core`/`web`/`autonomy`）在前台启动并捕获地址；桌面上自动拉起浏览器（可用 `--no-browser` 跳过，按凭据保护带 token URL）。 |
| `logs` | 查看各 profile 的 Host 日志尾部；`--lines <n>` 设置每份日志行数（1–10000，默认 200），`--errors-only` 只看错误日志。 |
| `web-url` | 从受管服务日志取最近的、带 token 的 Web 授权 URL（支持 `--wait <0..60>`，默认 `0`）；请按凭据保护该 URL。服务未运行时先 `start`，旧 URL 重启后可能失效。 |
| `start` / `stop` / `restart` | 只切换**已注册**常驻服务的运行状态，保留服务定义和数据；未注册时会报错，需通过 `install` 注册。 |
| `upgrade` | 检查最新包/Host 版本并安全执行就地升级：`--check`（仅检查状态）、`--dry-run`（输出只读升级计划）、`--yes`（执行备份、升级、`doctor` 核验与失败自动回滚）；支持 `--json`、`--registry`、`--version`、`--dsh-version`、`--confirm-dsh-home-stopped`。 |
| `maintenance` | 运维结算两个没有模型入口的台账：`dead-letters` / `resolve` 结算 Delivery 死信，`system-automations` / `pause-system` 暂停卡在未授权恢复重试上的系统自有 automation。写操作会先在同一事务里落不可变 receipt，再做精确状态与版本的 CAS 更新；重复提交同一决定会重放，换操作者或相反决定会冲突。 |
| `version` | 打印 CLI 版本。 |

不带 `--profile` 时，服务、日志和 Web URL 命令面向当前 DSH Home 下的全部真实 profile。可用 `--profile <name>` 指定一个。`status` / `doctor` 返回 0 只说明诊断命令执行成功，不证明真实模型可用或普通使用学习闭环通过；当前能力边界见[RSI 状态](../../docs/rsi-status.md)。

## 升级与重装

```sh
dsh-rsi upgrade --check --json          # 仅检查当前/最新包与 Host 版本及前置就绪状态
dsh-rsi upgrade --dry-run --json        # 只读预演升级步骤，不修改 Home 或重启服务
dsh-rsi upgrade --yes                   # 备份后就地升级、运行 doctor 核验并在失败时自动回滚
dsh-rsi update --dry-run                # 预览 CLI 自身升级
dsh-rsi update                          # 只升级全局 dsh-rsi
dsh-rsi update --all --dry-run --yes    # Linux：先看整套升级计划
dsh-rsi update --all --yes              # Linux：升级支持的现有 Home
dsh-rsi reinstall --dry-run             # 预览清理与重新安装两阶段
dsh-rsi reinstall                       # 备份、删除、重新安装并重做 onboarding
```

`dsh-rsi upgrade` 面向普通日常用户的可审计自助升级：先通过有界超时的 npm registry 查询（优先 `/latest` 并并行检查）与只读 `.dsh-rsi-host.json` 对比当前与最新版本（网络不可用或超时干净回退为离线报告，不崩进程），并在 `--dry-run` / `--yes` 前做 fail-closed 就绪检查（损坏或符号链接绑定、非空 `creation-review`/`revision-review`/`revision-regression`/`creation-adoptions` 台账等直接阻断）。未显式传入 `--dsh-version` 时，若远端 `@deepseek-ai/dsh` 领先于已验证基线，会自动将目标 Host 版本钳制至已验证基线（如 `0.2.2-rc.5`），同时保留 `registry.latestDshHostVersion` 展示真实远端版本；显式传入未验证的 `--dsh-version` 会提前阻断。在 Linux 受控 systemd 冻结部署上会委托 `scripts/install/upgrade-program.mjs` 并维持锁定 Host 基线；在 macOS / 非受控本地 profile 上会要求先停止同 Home 进程或显式 `--confirm-dsh-home-stopped`，自动区分 `pnpm` profile（同步更新 `package.json` 与 `pnpm-workspace.yaml` `overrides` 的 `@dsh-enhanced/*` 并保留 `file:` 本地协议，随后执行 `pnpm install --no-frozen-lockfile --ignore-scripts`）与纯 npm profile（使用 `--legacy-peer-deps`）。升级前对 `cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`package-lock.json` 与 `@dsh-enhanced/*` 生成 `0600` 备份、升级后执行 `doctor` 复验，若关键检查失败自动字节级回滚恢复原状态。升级成功只证明包版本与静态就绪检查通过，不自动替代真实模型可用性或长期普通任务效果评估。

`update --all` 先升级 CLI，再按原场景升级插件。对于保留的**原 Docker 后端 Linux 冻结 owner/cohort Home**，`dsh-rsi update --all --yes` 仅在全部前置成立时执行一次性 docker→native 升级（将候选固定更新至 `0.2.2-rc.5`，保留原 owner 绑定、期限、已用额度、凭据、模型、Session、Goal 与历史）：绑定官方仓库 `dev`/`main` 可干净快进（detached HEAD 须在本机记录的 `origin/dev` 或 `origin/main` 历史内）、原 Host 属于支持基线（`0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.2-rc.1` / `0.2.2-rc.3` / `0.2.2-rc.5`）、owner 授权未过期且 target/coordinator 双服务均活动、无已采用源码或未结 activation，以及已配置的 `creation-review` / `revision-review` / `revision-regression` / `creation-adoptions` 业务记录均为空（不存在的库不算空库）。已有 owner 的 native→native 程序升级、非空创建历史迁移与完整 live Docker→native 切换均不支持/未验收。

尚无 owner 的 pre-owner Home 另有 checkout 内的 v3 维护入口，见 [pre-owner 维护](../../scripts/install/maintenance.md#checkout-内的-pre-owner-冻结源码维护)。若本机旧版 CLI 尚不能识别冻结 owner 升级，先单独执行一次 `dsh-rsi update` 自举 CLI 后再运行 `dsh-rsi update --all --yes`；普通待恢复事务与已绑定 readiness 修复按[维护说明](../../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)处理，能力状态见[RSI 状态](../../docs/rsi-status.md)。

普通 Linux npm cohort 升级由安装器事务停服并恢复已注册受管服务，额外的手工 Host 须先停止。macOS 须先停止**同一 DSH Home 的全部 Host**，在整个升级期间保持停止，并显式传 `--confirm-dsh-home-stopped`；冻结的原生 owner/source Home 不支持普通原地升级。未冻结的 Mac Home 更新完成后，使用 `dsh-rsi start` 恢复服务。可用 `update --version <精确版本或dist-tag>` 选择 CLI 版本；`--all` 下的其它安装器选项只适用于非冻结 Home。

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

用法：`dsh-rsi [全局选项] <命令> [命令参数]`。`--dsh-home <path>` 选择 Home（默认 `$DSH_HOME`，否则 `~/.dsh`）；`--profile <name>` 选择 profile；`--json` 让 `status` / `doctor` / `upgrade` / `growth-report` 输出结构化 JSON；`--since` 与 `--now` 控制 `growth-report` 统计窗口；`--wait <0..60>` 与 `--no-browser` 控制 `open` / `web-url` 行为；`--dry-run` 预览操作；`--yes` 适用于清理确认并在安装时透传。`-h` / `--help` 查看 CLI 帮助，`install --help` 查看安装器帮助。`--capabilities` 是供救机脚本使用的只读 JSON 探测接口。

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功执行，包含只读查看和 dry-run；不代表模型或学习能力已验证。 |
| `1` | CLI 操作失败，例如服务未注册、Home/进程归属无法确认、备份或清理失败；不存在的 profile 也报错。 |
| `2` | CLI 参数错误。 |
| 其它非零 | `install` / `reinstall` 委托安装器后，透传其退出码。 |

许可证：MIT。
