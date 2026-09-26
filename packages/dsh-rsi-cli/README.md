# @dsh-enhanced/dsh-rsi-cli — 全局 `dsh-rsi` 命令

DSH enhanced 插件集合的安装 / 控制 / 诊断 / 彻底卸载工具。安装插件集合（npm cohort 或本地 checkout 形态）后，安装器会同时把本包装成全局 `dsh-rsi` 命令；也可单独安装：

```bash
npm install --global @dsh-enhanced/dsh-rsi-cli
```

零运行时依赖（仅用 Node.js 内置模块），要求 Node.js `^22.19.0 || >=24.0.0`，支持 macOS 与 Linux。

## 命令

```
dsh-rsi [全局选项] <命令>
```

| 命令 | 说明 |
| --- | --- |
| `status`（默认） | 列出 DSH home、各 profile 与安装形态（npm 实体副本 / local 符号链接）、全局 host 版本、launchd / systemd 受管服务状态、外部凭据条目数、生命周期事务/锁残留。**只读**。 |
| `doctor` | 在 `status` 基础上扫描各 profile 的 `*-host.error.log`，识别已知崩溃模式（如旧版 event-support oracle 拒绝注册）并给出升级/重建建议。**只读**。 |
| `start` / `stop` / `restart` | 切换已注册受管常驻服务的运行状态。**只改运行状态**，不新建/改写/删除 launchd plist 或 systemd unit；未注册时报错并给出注册指引。 |
| `logs` | 查看各 profile 的受管 `*-host.log` / `*-host.error.log` 尾部（默认末 200 行）。**只读**。 |
| `web-url` | 从运行中受管服务的 journal（Linux）或 `*-host.log`（macOS）解析最近一次 `dsh web:` 行，输出带 token 的完整 Web 授权 URL。**只读**，不关闭或绕过 Web 认证；服务未运行时提示先 `dsh-rsi start`。 |
| `update` | 升级全局 dsh-rsi 自身；加 `--all` 再把插件集合交给安装器 `--operation upgrade` **原地升级**（保留 patch、凭据、Session、Goal）。 |
| `install` | 安装/修复插件集合：npm 形态下载与本 dsh-rsi 同版本的官方安装器执行，`--local <dir>` 执行 checkout 内安装器；其余参数原样透传。 |
| `reinstall` | 先 `purge`（默认先备份、同样的安全门控）再立即 `install`，用于干净重装。 |
| `purge` | 彻底卸载：进程静止检查 → 停服注销 → tar.gz 备份 → 删除 profile / DSH home / 生命周期残留 → 清理外部凭据。 |
| `version` | 打印版本。 |

全局选项：

- `--dsh-home <path>`：指定 DSH home（默认取 `$DSH_HOME`，否则 `~/.dsh`；install 经 `DSH_HOME` 环境变量传给安装器）
- `--profile <name>`：仅操作单个 profile（`purge` 默认全量；install/reinstall 同时透传给安装器）
- `--dry-run`：只打印将执行的动作，不做任何修改（install/reinstall 透传给安装器）
- `--yes`：`purge` / `reinstall` 时跳过交互确认（install/reinstall 透传给安装器）
- `-h, --help`：无命令位置时显示 dsh-rsi 帮助；`dsh-rsi install --help` 透传展示**安装器**完整参数清单

## install / reinstall（薄委托）

`dsh-rsi install` 不复制任何安装逻辑，只做统一入口与引导器版本固定：

- **npm 形态（默认）**：下载 `https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/v<本包版本>/scripts/install/install-npm.sh` 到临时目录执行。引导脚本内部会按内嵌 SHA-256 自校验 `common.sh` 等资产，dsh-rsi 不重复 hash 逻辑。**锁定的只是引导脚本与同 tag 的安装器资产，不是插件 cohort 版本**：安装器默认把 `@dsh-enhanced/personal-assistant@latest` 解析为精确版本，再以该版本安装整套 `@dsh-enhanced/*` bundle；要锁定插件版本需透传 `--plugin-version <x.y.z|dist-tag>` 或预设 `DSH_ENHANCED_VERSION`。安装器尾部还会执行 `npm install --global @dsh-enhanced/dsh-rsi-cli@<cohort 版本>`，可能因此把全局 dsh-rsi 升降级到该 cohort 版本。
- **local 形态**：`--local <checkout 目录>`，直接执行该目录下 `scripts/install/install-local.sh`，并从该 checkout 的 packages/dsh-rsi-cli 全局安装（本地开发 / 无网救机）。
- 安装器 stdio 与终端直连（交互提示照常），退出码原样透传。

```bash
# npm 形态安装 core 场景（其余安装器参数任意透传）
dsh-rsi install --scenario core --yes

# local checkout 形态
dsh-rsi install --local ~/work/github/dsh-enhanced --scenario web

# 查看安装器支持的全部参数
dsh-rsi install --help

# 干净重装：先备份+purge，再按相同形态重新安装
dsh-rsi reinstall --yes
dsh-rsi reinstall --profile web --yes
```

`reinstall` 支持的 rsi 侧选项与 `purge` 一致（`--no-backup` / `--keep-keychain` / `--remove-host` / `--profile`）；只有既未加 `--yes` 也未加 `--dry-run` 时才需输入 `purge` 确认——`reinstall --dry-run` 全程无交互、无修改：先打印 purge 计划，再以 `--dry-run` 透传演练安装器（`--dry-run` 同时作用于 purge 与安装两个阶段）。重装阶段默认走 npm 形态；local 重装加 `--local <dir>`。

## update（升级自身 / 升级整套）

```bash
# 只升级全局 dsh-rsi 自身（默认 latest）
dsh-rsi update

# 先看会装哪个版本
dsh-rsi update --dry-run

# 指定精确版本或 dist-tag
dsh-rsi update --version 0.1.38
dsh-rsi update --version next

# 自身 + 整套插件集合原地升级；受管 Linux 服务由事务停服/恢复，额外 Host 会被拒绝
dsh-rsi update --all --yes
```

`update` 选项：

- `--all`：自身升级成功后，把插件集合交给同一目标版本的安装器原地升级；Linux 受管服务由事务停服并恢复，额外或手工启动的 Host 必须先停止。该选项目前不升级 DSH Host。用户无需传 `--confirm-dsh-home-stopped` 或重复声明 `--scenario`；安装器从 effective/composed profile 自动识别场景。
- `--version <v|tag>`：dsh-rsi 自身的目标版本或 dist-tag（默认 `latest`）。只接受精确版本 `x.y.z`（可带预发布后缀）或纯字母 dist-tag；范围表达式如 `>=0.1.0` 会被拒绝。
- `--dry-run`：解析出目标版本并打印将执行的命令，不做任何安装。
- 其余参数在 `--all` 下原样透传给安装器；`--local <dir>` 走 local 形态。显式 `--scenario` 仍可作为一致性断言，但不再是必填项。

### 三条语义边界

- **自身先行，失败即止**。`--all` 下先升级 dsh-rsi 自身，失败就**不**继续升级 cohort —— 避免用旧版 rsi 的判断去驱动一轮新的 cohort 升级。
- **同版本闭环**。自身升级固定写回当前 `dsh-rsi` 实际所属的 npm prefix，不受当前目录 `.npmrc` 或沙箱 prefix 影响；`--all` 使用 registry 解析出的精确版本 tag 下载安装器，无法确定精确版本时停止，绝不回退到旧进程版本。
- **已是目标版本则跳过自身安装，但继续 `--all`**。先用 `npm view` 把 selector 解析为精确版本，与自身版本相同时不重复安装 CLI；`--all` 仍继续升级 profile。registry 无法解析 dist-tag 时可单独升级 CLI，但整体升级会 fail-closed，避免 CLI 与安装器 tag 错配。

### 与 install / reinstall 的区别

| | `update --all` | `install` | `reinstall` |
| --- | --- | --- | --- |
| 语义 | 原地升级已装的 cohort | 安装 / 修复 | **先 purge 再装** |
| 保留 patch、凭据、Session、Goal | 是 | 是 | **否**（purge 阶段删除） |
| 新增场景能力 | 否（只升当前已装的顶层依赖） | 是 | 是 |
| 升级 dsh-rsi 自身 | 是（本命令的主职责） | 顺带（安装器尾部按 cohort 版本装） | 同 install |

## 日常运维：start / stop / restart / logs

```bash
# 改完配置或升级插件后让 profile 生效
dsh-rsi restart --profile web

# 停掉全部 profile 的常驻服务（服务定义与数据都保留，可再 start）
dsh-rsi stop

# 先看会执行什么，再真正动手
dsh-rsi restart --dry-run

# 看日志尾部
dsh-rsi logs --profile web --lines 100
dsh-rsi logs --errors-only
```

不带 `--profile` 时作用于 DSH home 下的**全部真实 profile**。枚举以 `profiles/<name>/package.json` 为 profile 身份锚点；共享的 `profiles/node_modules`、缓存目录、无 manifest 的暂存目录和符号链接不会被当成 profile，也不会生成 `ai.deepseek.dsh.profile.node_modules` 之类的错误服务目标。

`logs` 选项：

- `--lines <n>`：每个日志文件显示的尾部行数（默认 200，范围 1..10000；非法值报错退出 2，不静默回落）
- `--errors-only`：只显示 `*-host.error.log`

### 与 purge 的职责分界

这三个运维命令和 `purge` 的停服步骤刻意分开：

| | start / stop / restart | purge |
| --- | --- | --- |
| 改变运行状态 | 是 | 是 |
| 删除 plist / unit 定义 | **否** | 是 |
| 删除 profile 数据 | **否** | 是 |
| 服务未注册时 | 报错并给出注册指引 | 视作已停止，继续删数据 |

`stop` 之后服务定义仍在，所以可以再 `start` 起来；`purge` 的停服会连定义一起注销。

### 安全门控

- **不隐式注册服务**：服务定义文件不存在时**不会**顺手装一个（那会绕过安装器的归属、路径与凭据校验）。`core` / `web` 场景默认没有常驻服务，这是正常状态；命令会提供可直接复制的 `dsh-rsi install --profile <p> --scenario lark` / `--scenario supervised`，并以退出码 1 结束。`dsh-rsi-setup` 是插件包内的专用工具，不保证作为全局命令存在，因此不再把它作为用户修复入口。
- **归属 fail-closed**：同名文件存在但内容不属受管（人工改写或被第三方占用）时拒绝操作、原样保留文件，并说明需人工确认归属。判定依据与 purge 一致 —— Linux 要求 unit 同时含 `DeepSeek Harness profile`、对应 `--profile <p>`、`--no-open`；macOS 要求 plist 的 `Label` 为 `ai.deepseek.dsh.profile.<p>` 且 `ProgramArguments` 含 `--profile <p>` 与 `--no-open`。
- **dry-run 措辞与实际执行严格区分**：`--dry-run` 下不执行任何命令，结论行为「将启动/将停止/将重启」；只有真正执行过才输出「已…」。
- **多 profile 部分失败即非零**：任一 profile 出错，命令整体以退出码 1 结束，便于脚本判定；其余 profile 的处理结果照常打印。
- 仅支持 macOS（launchd）与 Linux（systemd --user），其它平台明确报错而非静默成功。

## status / doctor

```bash
dsh-rsi status
dsh-rsi --profile web status
dsh-rsi doctor
DSH_HOME=/custom/.dsh dsh-rsi doctor
```

两个命令都不修改任何文件，适合在升级、报障或怀疑安装损坏时先跑一遍。

## purge（彻底卸载）

```bash
# 先看计划（强烈建议）
dsh-rsi purge --dry-run

# 全量 purge（交互时需输入 purge 确认）
dsh-rsi purge --yes

# 只清单个 profile，保留兄弟 profile 与共享 DSH home
dsh-rsi purge --profile web --yes

# 连同全局 @deepseek-ai/dsh host 一起卸载（仅限全量）
dsh-rsi purge --yes --remove-host

# 不备份、保留外部凭据
dsh-rsi purge --yes --no-backup --keep-keychain
```

purge 选项：

- `--no-backup`：删除前不生成 `~/dsh-purge-backup-<UTC时间戳>.tar.gz`（默认备份，权限 0600）
- `--keep-keychain`：保留 macOS Keychain / Linux Secret Service 中的受管凭据
- `--remove-host`：同时 `npm uninstall -g @deepseek-ai/dsh`（仅限全量；默认保留 host）

### purge 会删除 / 保留什么

**删除：**

- 全量：整个 DSH home（profiles、logs、uninstalled-profiles、home 内锁文件），以及 home 外的生命周期事务目录、失败诊断目录、home 锁与 `/tmp` rendezvous 锁
- 单 profile：`profiles/<name>`、对应的两份 host 日志、归属该 profile 的失败诊断目录
- 受管常驻服务：macOS `launchctl bootout` + 删除 `~/Library/LaunchAgents/ai.deepseek.dsh.profile.<p>.plist`；Linux `systemctl --user disable --now` + `reset-failed` + 删除受管 unit 文件
- 外部凭据：按各 profile 的 setup journal / cleanup 记录**权威反查** service 前缀为 `dsh/` 的条目，逐条从 Keychain（`security delete-generic-password`）或 Secret Service（`secret-tool clear`）删除；home 内的 protected-file 凭据随 home 一起删除

**保留：**

- 本地 checkout 源码：local 形态在 `node_modules/@dsh-enhanced/` 下是指向 checkout 的符号链接，purge 只随 profile 目录删除链接本身，**绝不删除 checkout**；报告中会列出 checkout 路径，确认无用后可自行 `rm -rf`
- 全局 `@deepseek-ai/dsh` host（除非加 `--remove-host`）
- 外部凭据（加 `--keep-keychain` 时）

### 安全门控

- **进程静止检查**：Linux 已注册受管服务的精确 systemd MainPID 会交给 installer 的 service-aware 事务停服、屏蔽、升级和恢复；其它同 profile 的手工/测试 Host 仍会拒绝执行并列出 PID，不会被自动 kill。macOS 及无受管服务场景仍要求调用前保持整个目标 Home 静止。
- **systemd unit 归属 fail-closed**：仅当 unit 文件内容同时包含受管标记（`DeepSeek Harness profile`、对应 `--profile <p>`、`--no-open`）才删除；归属不明的同名文件只报告、保留。
- **locator 先扫描、文件先删除、凭据后清理**：删文件前先扫描各 profile 的 setup journal / cleanup 记录（journal 位于 DSH home 内，必须在删除前扫出凭据 locator）；随后**先删除文件**，再按预扫描的 locator 逐条删除外部凭据。单条凭据删除失败不会回滚已删文件，而是以「文件已删除，但以下凭据条目清理失败，请手工删除：…」报错并以退出码 1 结束。默认的 tar.gz 备份内含完整 journal，可解包后据此复查、手工补删；`--no-backup` 下文件与 journal 均不可恢复，只剩错误消息中列出的 service/account 可供定位。
- 单 profile 与 `--remove-host` 互斥；仅支持 macOS / Linux。

### 与安装器 `--operation uninstall` 的区别

安装器的 `uninstall` 是**保留数据的归档**：把旧 profile 移到 `$DSH_HOME/uninstalled-profiles/` 并重建干净基础 profile，凭据 / Session / Goal 等状态保留。`dsh-rsi purge` 是**彻底删除**：删除 DSH home 与生命周期残留（默认先打 tar.gz 备份），用于崩溃救机、报废环境或干净重装。

## 崩溃机器上的单文件救机脚本

机器上没有 `dsh-rsi` 时（host 已损坏或全局命令被删），可直接运行仓库中的自包含脚本；它会优先委托 `dsh-rsi`，找不到时使用等价的内联精简实现：

```bash
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/purge.sh \
  | bash -s -- --yes
```

该脚本是 mutable-main 运维脚本（非供应链引导路径），参数与 `dsh-rsi purge` 一致。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功。含 dry-run 与多数幂等场景：外部凭据条目本不存在、服务未注册、`rm --force` 删除已不存在的路径等 |
| 1 | update：selector 非法、`npm install --global` 失败（`--all` 下自身升级失败则不再委托安装器）；start/stop/restart：服务未注册、归属不明被拒、或底层 `systemctl`/`launchctl` 失败（多 profile 下任一失败即 1）；logs：DSH home 下没有任何 profile；purge 执行失败（活动进程、服务/凭据错误、备份失败等）；install 下载/委托失败。两个非幂等边界：① 默认备份下全量 purge 不存在的 DSH home，`tar` 因源目录不存在以退出码 2 失败、rsi 退出 1（`--no-backup` 同场景为 0）；② `purge --profile <不存在的名字>`（含 dry-run）直接报「profile 不存在」退出 1。单文件 `purge.sh` 的内联实现对不存在的 home 统一退出 0，在此边界上与 dsh-rsi 不一致 |
| 2 | 参数错误 |
| 其它非 0 | `install` / `reinstall` 安装器的退出码原样透传 |

## License

MIT
