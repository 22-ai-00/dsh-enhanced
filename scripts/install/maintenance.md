# 安装维护与历史迁移

首次安装请从[简明安装指南](README.md)开始。本页保留旧 Home、升级、恢复、实验场景及高级参数的操作细节；带 `./scripts/install/` 的示例从仓库根目录执行。执行任何维护事务前，以当前 CLI 帮助和 [RSI 当前状态](../../docs/rsi-status.md) 核对适用版本与能力边界。

## 本地 checkout 安装

在仓库根目录运行：

```sh
pnpm install
pnpm build
bash scripts/install/install-local.sh
```

本地安装默认仍选择交互式 supervised；首次本人绑定不能用 `--yes` 跳过。

## 事件与主动跟进

`supervised` 安装包含 `event-triggers` 和 `assistant-proactive`，复用原生 Goals/Automations 做持久等待和主动提醒。支持的来源包含 GitHub 仓库/CI/评审、精确飞书日历、文件、HTTPS JSON 和签名 webhook；安装两个 bundle 不等于授权读取账户。空配置不轮询、不创建目标、不发送提醒，也不恢复既有暂停任务。

首次接线须配置主人范围内的事件来源、有限观测预算和 Goals 等待/执行权限；GitHub 可使用 Web Owner 的 `repositoryDelivery.events` 配置，飞书日历还需要应用只读 scope 与精确日历 ID。主人可在对话中让现有目标等待已授权来源，Goals 上下文显示可用来源和机会策略，使用 `goal_wait_event` 持久登记，而不是让模型反复查询。`remind`、`prepare`、`execute` 分别对应提醒、准备和继续目标，配置与限制见 [事件来源](../../plugins/event-triggers/README.md) 和 [主动跟进](../../plugins/assistant-proactive/README.md)。目前不提供聊天创建任意账户监控或任务之外无授权的自主发现。

## 首次安装依赖审批

公开 npm 新装会在调用 `dsh plugin add` 前，由 DSH 初始化目标 profile 的 workspace，并在该 profile 的 `pnpm-workspace.yaml` 中明确设置 `allowBuilds.protobufjs: false`。`protobufjs` 的 postinstall 只输出依赖版本建议，已发布的 SDK 使用预构建文件，不需要执行该脚本。重试时，安装器只会将 pnpm 留下的 `set this to true or false` 未决占位改成 `false`；已有 `false` 保持原样，`true` 或其它值则拒绝覆盖。其它依赖的构建决策保持原样，不会自动批准。

Linux `autonomy` 场景需要原生依赖 `koffi`。pnpm 11.7.0 首次安装可能以 `ERR_PNPM_IGNORED_BUILDS` 停止，并列出 `koffi` 和实际 profile 目录。进入该报错中的目录，使用同一个 pnpm 11.7.0 执行：

```sh
pnpm approve-builds koffi
```

该命令只批准并构建当前 profile 的 `koffi`；成功后返回原工作目录，使用相同的 `DSH_HOME`、profile 和参数重跑安装命令。不要使用 `--all` 批准其它待审依赖。`--yes` 不代替 pnpm 的依赖构建审批。

## 安装入口

安装器默认解析官方 npm `latest`，并校验当前源码允许的精确兼容基线；未知新版不会未经验证直接装入现有环境。新源码的目标 Host 为 `0.2.1-rc.2`，此前公开 `0.1.55` 安装仍使用 `0.2.0-rc.2`，不要把源码支持误认为已公开发布或完成实机验收。旧 `0.1` Home 到 `0.2` 不走普通自动升级；满足下述严格前提时使用显式联合迁移，否则在独立新 Home 中验证新版。远端引导器的固定 tag 和资产摘要由 release prepare 更新。

macOS 的本地和 npm 安装入口会在安装末尾检查受管 LaunchAgent；若 `ai.deepseek.dsh.profile.<profile>` 未注册，会自动调用当前 profile 的服务注册入口并再次确认，再执行健康检查，无需手动运行 `launchctl bootstrap`。修复复用服务注册入口，不启动新的飞书 onboarding；已有中断的 setup 事务仍由原入口恢复。`--no-service`、`--lark skip` 以及不管理常驻服务的场景保持跳过；独立 `doctor.sh` 仍只检查。注册失败会保留具体错误并停止安装。

同一 macOS 用户的同名 profile 共用一个 launchd 目标。安装、重启与清理会核对 plist 和已加载服务的 DSH_HOME、profile 与执行参数，并按该目标互斥；另一 Home 已占用时停止操作。替换服务失败会尝试恢复原定义与注册状态，无法证明停服或恢复时保留现场并报错。运行检查要求 `state = running` 和有效 PID；重启还须确认新 PID，只有注册记录不算运行成功。

macOS purge 从枚举 profile 到停服、备份和删除结束持续持有 Home 生命周期锁，并在停服前获取全部目标服务锁，阻止同 Home 的安装或同目标的启动与清理并发。`/tmp` 中的 Home 和服务锁文件保留稳定 inode；进程退出即释放内核锁，保留文件不表示仍被占用。同 profile 的手动 Host 若无法证明所属 Home，清理会中止，`--yes` 不会自动终止它。


安装器先确保 Node.js、pnpm 和兼容的 DSH。新安装解析官方 `@deepseek-ai/dsh` 的 `latest` 并固定精确版本；与当前源码基线不符或解析失败时会拒绝，不追踪 `next` 或 beta。`--dry-run` 离线展示计划，显式 `--dsh-version` 可指定允许的精确版本。`dsh-rsi install` 对全新空 Home 将 Host 安装到独立目录，并在 Home 内持久绑定精确版本；重试、插件升级及生成的服务复用该入口，不修改全局 DSH。已有未绑定 Home 保留原 Host。普通 Linux npm cohort 的受管 Host 更新与下述冻结 owner 程序升级有不同适用条件；真实跨版本验收状态见 [RSI 状态](../../docs/rsi-status.md)，缓存与重装说明见 [CLI 指南](../../packages/dsh-rsi-cli/README.md#升级与重装)。

三档场景能力逐级叠加：`core ⊂ lark ⊂ supervised`。`0.1.49` 起，`dsh-rsi install/reinstall` 未指定 `--scenario` 或 `--mode` 时默认进入 `supervised`；当前 checkout 的 shell 安装脚本在 Linux/macOS 默认准备持久记忆学习、普通任务成长、新工具独立验收和有限采用，Linux 另配置独立采用协调器，不因 `--yes` 或非交互而降为 `core`。全新 Home 的 supervised 安装需要交互式飞书 onboarding；尚未配对时，`--yes` 或管道执行会在安装前停止。显式 `--scenario core` 保留无渠道、无后台学习的轻量安装；`--lark skip` 或 `--no-service` 保留有限场景。macOS 使用原生 launchd Host，支持记忆学习、新工具独立验证与动态采用；源码替换发布轨仍限 Linux。也可显式选择 `core` 等轻量场景。

默认启用流程不会给缺配置的 bundle 强行打开开关。安装器复用可信飞书私聊配对确定 owner，保留已有模型选择；首次没有可用模型时须在安装引导中配置，数据库路径、独立身份、构建资源、有限授权与预算由现有 RSI 安装器生成。新授权默认记忆提取每日最多 7 次、成长复盘每日最多 7 次（既有合法聚合预算优先），独立审查另有有限额度并可能增加模型调用；授权有固定期限，重试不续期、不返还消耗、不重放 unknown。缺少模型、owner、Linux systemd / macOS launchd 或隔离构建前提时应按具体提示完成配置，不能把未启用的学习报告成安装成功。已有 active/paused Automation 仍须显式确认 `--ack-existing-automations`；`--yes` 不代替该确认。新会话默认 Full access，可访问任意文件及网络、不逐次审批；显式收紧权限见下文。

```sh
./scripts/install/install-local.sh
```

现有无常驻服务的 `web` / `autonomy` profile 可显式执行离线升级或卸载：

```sh
./scripts/install/install-local.sh --operation upgrade --scenario web \
  --confirm-dsh-home-stopped --yes
./scripts/install/install-local.sh --operation uninstall --scenario web \
  --confirm-dsh-home-stopped --yes

# Linux systemd --user managed Lark profile; the installer stops and restores
# the proven same-home unit set itself.
./scripts/install/install-local.sh --operation uninstall --scenario lark \
  --confirm-dsh-home-stopped --yes

# Linux systemd --user managed supervised profile; checkout-local lifecycle.
./scripts/install/install-local.sh --operation upgrade --scenario supervised \
  --confirm-dsh-home-stopped --yes
./scripts/install/install-local.sh --operation uninstall --scenario supervised \
  --confirm-dsh-home-stopped --yes
```

两种操作都要求整个 `DSH_HOME` 在复制和切换时保持静止，且都会拒绝活动的第三方顶层 bundle，因为安装器无法穷举其私有状态路径；未作为 bundle 激活的普通第三方依赖会原样保留。`web` / `autonomy` 由操作者预先停止所有相关进程；Linux `lark` 和 `supervised` upgrade/uninstall 则由安装器在锁内停止并屏蔽已证明归属的 systemd units，操作者只需预先停止其它外部或手工进程。安装器持有 home 外的独占锁，在无网络隔离环境中对私有副本更新 package/lockfile、组合配置和实际激活；只有副本通过才提交。成功升级只更新当前已安装的 `@dsh-enhanced/*` 顶层依赖，不新增场景能力，并保留自定义 patch、凭据、Session、Goal 与其它任务状态。卸载的语义是停用并归档目标 profile 的受管能力：它把完整旧 profile 归档到 `$DSH_HOME/uninstalled-profiles/`，创建干净的同名 DSH 基础 profile；事务不会主动清除该 live profile 之外的凭据 locator、owner binding、Session、Goal 或数据库记录，也不承诺这些状态已被撤销、永久退休或逐字节验证。原 active units 在 clean profile 通过 fresh readiness 后恢复，原 inactive units 保持停止。归档配置不会继续激活；后续显式重装或共享同一状态库的其它 profile 仍可能再次解释这些保留状态。归档 profile 绑定完整树摘要；source proof 只覆盖协议明确列出的 Delivery、Recovery、Automations、owner 与非受管 Automation 摘要。再次卸载已无受管依赖的基础 profile 是幂等 no-op。

Linux 的强隔离生命周期事务要求 Node.js、`flock`、Perl、`/usr/bin/python3` 和 bubblewrap。本地 upgrade 会先对当前 checkout 执行 `pnpm install --offline --frozen-lockfile` 和构建，任一步失败都在事务开始前终止。macOS 的 Lark/supervised upgrade 仅在整个 DSH_HOME 已静止时开放：安装器在任何 package、registry、store 或工作目录变更前检查 canonical Home 的所有 profile、launchd 与 Host 进程，并在修改 profile 前复检；状态未知时拒绝。Home 中已有冻结的原生 owner/source/cohort 资源时，普通升级直接拒绝；保留现有数据的专用迁移目前尚未实现。未冻结且已停止的 Home 会完整备份 profile，精确更新既有受管 bundle，执行组合配置与临时 Host 激活验证；失败自动恢复原 profile 并保留失败现场。macOS 只有两次静止检查，没有覆盖整个升级过程的 Home 独占锁；操作者必须在升级全程保持同一 Home 的 Host 停止。该路径不重跑 onboarding、不创建或启动 LaunchAgent。跨版本私有 Host 更新在任何插件变更前拒绝；同版本 Host 保留不动。`dsh-rsi update --all` 在 macOS 不会代替操作者确认停服，必须显式传入 `--confirm-dsh-home-stopped`；预检失败时也不会先自更新 CLI。

npm upgrade 则在同一生命周期锁内把发布 selector 解析为精确 cohort，在 `DSH_HOME` 外的私有目录准备最终 package manifest、workspace 配置和 lockfile；以固定的公开 registry 和 pnpm 策略完成供应链校验、完整预取，随后才创建 transaction。bwrap 内按同一份元数据执行 frozen/offline install，缓存与 store 只读，禁止 install scripts、pnpmfile hooks 和 `trustLockfile` 跳过验证。

原配置中的严格 release-age 策略保持有效；非严格模式只允许 pnpm 为本轮精确 cohort 添加例外，不使用通配放宽。当前不支持 profile `.npmrc`、带凭据的 registry 配置或会加载额外代码的 pnpm 配置依赖；这些情况会在 profile pnpm 查询前或元数据准备阶段拒绝，原 profile 保留。声明在 `/tmp` 或 `/run` 中的外部 Web 工作区仅在 Host 启动预检时以只读目录描述符挂入；既有 Host peer 外链在包物化时暂时移开，结束后恢复，避免生成新的锁文件外可执行链接。

uninstall 不访问 npm registry 或 pnpm store。`web` / `autonomy` 仍使用操作者预先停止整个 home 的离线事务；Linux `lark` 和 `supervised` upgrade/uninstall 会在锁内枚举同一 canonical `DSH_HOME` 的 installer-managed systemd user units，以绑定 inode 的高优先级 `user.control` mask 屏蔽后全部停止，在每次 rename 前后复核进程静止，并只恢复原 active units；启动由独立 crash guardian 执行，fresh InvocationID 的 journal ready marker 与稳定窗口通过后才删除旧备份。明确属于其它绝对 HOME 的 custom/legacy unit 不会被修改，但它的 ownership 摘要会写入事务并持续复核；归属缺失、相对、冲突、漂移为当前 HOME 或嵌套于当前 HOME 都会 fail closed。此前卸载留下的同 HOME clean profile 只有在四文件和目录闭集精确匹配 installer baseline 时才允许共存，其摘要同样绑定到事务并在恢复、启动、验收与清理前复核。此能力要求 `DSH_HOME` 与用户 systemd 配置位于同一文件系统，以便用 Linux `renameat2(RENAME_NOREPLACE)` 原子移动受管 mask 和 enablement link。此 Linux service-aware 能力不适用于外部 supervisor 或 Windows；macOS 仅支持调用方已停止整个 Home 的 upgrade，不支持 service-aware uninstall。`supervised` upgrade/uninstall 还要求 source 已安装支持只读 operator/attestation seam 的 cohort；安装器绝不回退到会迁移数据库的 Store 读取。停服后会绑定 Recovery、Automations 与 Delivery owner 快照；copied state 只按内容和语义摘要比较，允许 inode 改变。升级后的私有副本用 fresh UUID 和新包 catalog 生成 preview；preview Host 在无网络 bwrap 中运行，并只在该进程的临时 overlay 里禁用 Lark、从 Health required providers 移除 `larkChannel`。这个唯一 external-provider exemption 会绑定进事务且不会进入 active 配置。swap 后真实 upgraded service 必须同时通过 fresh InvocationID/journal、真实 Lark required-health、generation 严格前进的 exact active attestation 与稳定窗口。`supervised` uninstall 则在停服后绑定只读 source proof，将旧 profile 归档并换成 installer-clean Web profile；clean target 只按通用 fresh InvocationID/journal readiness 与稳定窗口验收，不要求已被停用的 Lark/Health/supervised active attestation。失败会保持服务收容并保留 current/original homes 和 manifest，不自动回滚。

Linux `supervised` 的已登记 RSI 双 Host 可以在同一个 Home 事务中成对升级插件：目标及协调器必须处于活动状态，安装收据和现有版本一致，共享 catalog/trust、owner 与 handoff 通过核对。协调器只包含原生基础配置及 Policy、Automations、Control Plane 三个增强包，三包随目标同批更新。npm 路径先分别准备并完整预取两个 profile 的锁文件；切换前更新副本收据并实际激活两个 profile。协调器预览只在进程 overlay 中关闭 scheduler，真实启动须生成本次启动后的 owner-bound Automation 登记。原始/候选的有效配置、收据和包版本在恢复、接受及清理前重新核对。停服前还要求旧协调器本次 InvocationID 已有就绪信号；缺少信号时原服务继续运行。切换前失败可恢复原活动服务；切换后失败保持双服务停止、保留新旧 Home 与事务供对账，不自动覆盖可能已迁移的状态。固定本地源码或存在 `rsi-local-cohorts` 的安装在 registry 查询、停服和包修改前拒绝普通 npm 升级，包括尚未生成协调器收据的冻结安装。开发版 `dsh-rsi-setup --prepare-local-update` 可在 Home 外准备保留既有修复的合并源码与隔离构建制品；尚无 RSI owner/coordinator 的安装可使用下述 checkout 内显式维护入口。已授权双 Host 的通用源码升级仍未开放；下文仅开放符合严格条件的程序升级，已 applied、未首次采用的失败首启另有有界 `host-owner-repair` 入口。详见 [RSI 配置](../../plugins/lark-channel/docs/rsi-setup.md)；成对卸载仍未支持。跨版本 Host 更新作为插件升级之后的独立阶段，见下文。


## 查找私有 Host 入口

`dsh-rsi status` 中的 Host 版本来自全局 PATH。旧 Home 或自定义缓存应读取 Home 自身的绑定；下面只输出入口路径，不输出凭据：

```sh
node -e 'const fs=require("node:fs"),p=require("node:path"),os=require("node:os");const h=process.env.DSH_HOME||p.join(os.homedir(),".dsh");const {cacheRoot,version}=JSON.parse(fs.readFileSync(p.join(h,".dsh-rsi-host.json"),"utf8"));console.log(p.join(cacheRoot,version,"node_modules",".bin","dsh"))'
```

用输出的完整路径代替 `dsh`，再加 `--profile web` 启动。若使用自定义 `DSH_HOME`，两次命令应保留相同设置。没有绑定文件的旧 Home 不适用此方法，先按原安装方式核对 Host。

## 现有 Linux 冻结 owner 程序升级

从 CLI `0.1.57` 起，对支持的现有 Linux owner/cohort Home，可运行：

```sh
dsh-rsi update --all --dry-run --yes
dsh-rsi update --all --yes
```

若当前 CLI 是 `0.1.55` 等旧版，先单独运行 `dsh-rsi update`，确认新进程为 `0.1.57` 或更新版本；旧版 `--all` 不会自动以新 CLI 进程识别冻结 owner。此后 CLI 先升级自身，再识别 Home 中唯一的冻结 target/coordinator 与原 `sourceRepository`；只接受绑定仓库的官方 GitHub origin、干净的 `dev` / `main` 分支，并执行 `git fetch`、仅快进合并、锁文件安装和构建。候选目前要求私有 Host 从受支持的 `0.2.0-rc.2` / `0.2.1-rc.2` 到 `0.2.1-rc.2`，同时更新冻结插件。要求原 owner 授权有效、target 与 coordinator 受管服务均活动、没有已采用的源码或未结 activation；额外参数会被拒绝。事务自动停启这对服务，保留原 owner 绑定、模型、权限、凭据、有限授权期限与已用额度、Session、Goal 和历史，不重做 onboarding，也不自动续期或扩权。已过期授权会在升级预检中被拒绝，需先按原授权流程处理。

若有普通待恢复的程序升级事务，CLI 先用**原安装器**恢复，本次不拉取新源码；恢复后再次执行同一升级命令。若报错指出事务已绑定独立审核的签名 readiness 修复安装器，须从**该许可绑定的独立审核 checkout** 显式运行 `node scripts/install/upgrade-program.mjs --dsh-home <绝对Home路径> --profile <原target> --recover-readiness`；不要修改原安装器或删除事务。`--dry-run` 仅显示计划。拒绝或失败时保留报错及事务现场；不要删除账本或改用 `reinstall` 冒充保留数据的升级。当前发布与实机验收状态见 [RSI 状态](../../docs/rsi-status.md)。macOS 冻结 owner/source Home 仍不支持普通原地升级。

### 旧 Home 的联合 Host / 源码迁移

开发 checkout 提供显式 `host-local-update`，适用于尚无 owner 授权、具有精确匹配的惰性预备协调器及单个活动目标服务的 Linux Home。原 Host 必须有可验证的私有缓存收据；支持未绑定 Home 的 `0.1.x → 0.2.0-rc.2`，以及已绑定 `0.2.0-rc.2` 的同 Host 源码更新。它不是普通 `dsh-rsi update` 的自动路径，也不自动开启学习。其他状态仍拒绝，不能删除协调器标记或伪造 Host 绑定来满足前提。

先准备 schema 1 冻结源码候选，再用 CLI 包的 `prepareUnboundHostUpdatePlan` 显式提供旧 Host 的 `cacheRoot`、`version`、`dshPath`，将返回计划保存为 Home 外当前用户独占的 `0600` 文件。准备过程核对完整旧 / 新 Host 收据，不修改 Home。使用已经审核、构建且在事务期间保持不变的 checkout 执行：

已经完成 Host 迁移、但尚未启用 owner 的 Home，改用 `prepareHostUpdatePlan` 生成 schema 1 `current` 计划；原 / 候选 Host、收据和绑定必须完全相同。相同命令仍原子更新整个 Home 的配套源码和全部 profile，复用隔离预取与离线物化，不依赖上次事务已清理的 pnpm store。systemd unit 和 PATH 只校验、不重写，普通 `host-update current` 仍不做任何更新；已授权 owner 不适用。

```sh
node /reviewed/checkout/scripts/install/lifecycle-profile.mjs \
  host-local-update assistant /absolute/dsh-home \
  /absolute/original-private-dsh /usr/bin/bwrap /usr/bin/systemctl /usr/bin/journalctl \
  /absolute/private-plan.json /absolute/prepared-local-update /reviewed/checkout \
  /absolute/private-auxiliary-root
```

事务检查整个 Home 的所有 profile，包括未运行的 ACP、Web 和预备协调器。缺少的增强包从同一冻结候选提交隔离构建；辅助目录在恢复结束前必须保留。同一收据只在全部输入和字节仍一致时复用。停服前的副本仅供依赖解析和预取，绝不作为运行状态切换；屏蔽、停止并核对整个 Home 静止后重新复制，在无网络隔离中物化所有锁定依赖。原 patch、身份、密钥和授权树保持不变，源码维护记录仍为 pre-owner，不授予 owner 权限。候选 authority runtime、包文件、锁图及空 profile 残留在切换前、恢复启动前和验收后核对。

沿用 v4 Host 事务的崩溃收容与 `host-recover`：候选尚未运行时可恢复原 Home 和 unit；候选已运行后保留候选绑定并继续验收，不自动覆盖可能已变更的业务状态。真实目标服务还必须通过新 InvocationID、飞书就绪和稳定窗口。迁移成功后才单独执行 `dsh-rsi-setup --install-owner --ack-existing-automations`，使用既有配对和模型生成有限学习配置；迁移通过不代表学习就绪或普通任务闭环通过。

DSH `0.2` 使用原生 runtime resolution，不再依赖旧的共享 `profiles/node_modules` 或 profile 内 `.dsh-module-fallback`。联合迁移只在暂存副本退役经过库存核对的纯链接缓存；真实文件、自定义包目录、未知链接来源或准备后的漂移都会拒绝。如果缓存还引用旧全局安装，须在上述命令的辅助制品目录后追加原全局 `@deepseek-ai/dsh` 包的 canonical 目录，供显式核验。原 Home 和回滚副本保留原缓存；不会跟随悬空链接删除目标，也不把旧全局 DSH 路径当作候选代码授权。

旧 `settings.yaml` 必须在迁移前单独核对：DSH `0.2` 的原生导入器会在启动后异步将其改名为 `settings.yaml.imported`，逐节写入当前 profile；被拒绝的节仅保留在改名文件中，不会重试。联合迁移现在在停服前拒绝尚待导入的文件，避免运行中改写已冻结配置。不能把目标 profile 的设置移动到 Home 级 patch：后者会覆盖其他 profile 的独立模型、路由和权限。

针对旧版联合事务已启动候选、通过就绪验收后才遇到这种已知原生导入的现场，提供显式 `host-recover-settings`，不是普通摘要漂移的宽松恢复。它要求原事务已接受、服务已收容停用；独立禁网副本重放原生导入并逐节审计，证明原补丁字节前缀及完整导入后字节都精确匹配，再由既有 Host 身份签署绑定事务、原 manifest、Host 收据、设置、补丁和回放证据的许可。原设置、旧导入标记、前后补丁、回放方法和收据须保存在事务外的私有归档，不能随清理丢弃。当前协议只支持明确审核的六节 / 三行导入形状；未知节、额外变更、错误签名或归档漂移均拒绝。

```sh
node /reviewed/recovery-checkout/scripts/install/lifecycle-profile.mjs \
  host-recover-settings assistant /absolute/dsh-home \
  /absolute/candidate-private-dsh /usr/bin/bwrap /usr/bin/systemctl /usr/bin/journalctl \
  /absolute/private-settings-archive/permit.json
```

恢复许可只接纳已经发生且独立复现的单 profile 配置后继，不重播导入、不改写配置、不重签源码链、不更换旧 installer 绑定，也不回退已运行的 Home。恢复 checkout 可以独立审核，但原收据引用的 installer 必须保持原字节。许可持久化后中断可用同一 recovery checkout 的普通 `host-recover` 继续；其余 profile、制品、原身份、系统服务和 fresh InvocationID 验收仍照常执行。被原生拒绝的 UI / 旧 preset 节应明确记录并保留原件，不得宣称它们已生效。

### 已 applied、未首次采用的 owner 修复

`host-owner-repair` 是独立的失败首启修复入口，不是通用的 owner 升级或权限重置。它只接受同一受支持 Host 的 `current` 计划、原本活动的精确目标 / 协调器双服务、完整 applied journal、尚无 activation 的原控制账本，以及尚未使用的签发器状态。已有 Host overlay、未知变更或在途工作会拒绝；不得删除状态以满足这些条件。

先在 Home 外准备真实冻结源码候选，再显式选择已授权的持久权限预设：`workspace-write` 或 `danger-full-access`。后者允许任意文件和网络访问、不逐次审批；命令不会把旧 `auto` 静默放宽。以下示例采用较严格的一档：

```sh
node /reviewed/checkout/scripts/install/lifecycle-profile.mjs \
  host-owner-repair assistant /absolute/dsh-home \
  /absolute/current-private-dsh /usr/bin/bwrap /usr/bin/systemctl /usr/bin/journalctl \
  /absolute/private-current-plan.json /absolute/prepared-local-update /reviewed/checkout \
  workspace-write /absolute/private-auxiliary-root
```

事务在屏蔽并停止双服务后重新复制 Home，追加真实 owner-ledger 源码维护记录，物化候选包和独立构建的 creation image，并用原身份、原始期限与预算重新编译配置。原 bootstrap 不覆盖；旧配置、journal、creation receipt 保留在私有审计中，新配置由单独的 Host 签名 repair overlay 绑定，不虚构 activation。unit 与 service environment 保持不变，其他 profile 不得改变行为。

停服前仅允许原签名配置绑定的 observer socket，按精确路径、所有者及文件身份核验；准备副本不保留该运行时端点。原 Home 的 socket 不由安装器删除，必须由服务正常关闭清理，停服后再执行不允许特殊文件的严格快照检查。未知 socket、FIFO、符号链接替换或身份漂移继续拒绝。

候选启动前复核原账本历史和追加记录。切换后必须通过新鲜 systemd InvocationID、飞书就绪、真实 HMAC observer 与原生协调器登记，不能以进程 active 代替验收。恢复沿用 `host-recover`：候选未运行可恢复原 Home；已经运行则保留候选和事务继续对账，不覆盖业务状态。该命令的实现、生产验收和普通使用闭环是不同门，当前验证边界见 [RSI 状态](../../docs/rsi-status.md)。

停服前绑定原双服务的 InvocationID、PID、Host 就绪及原生登记状态。仅在候选从未启动、原证明仍完整时，恢复才允许保留原先缺失的就绪信号，恢复原 active / enablement 并明确报告 `degraded-original-restored`；原先已有的就绪信号仍须重新产生。这不降低候选验收门，也不把原来未就绪的学习服务宣称为成功。

owner 身份复核使用新鲜、原子读取的完整绑定、查询范围、数据库版本及主数据库设备号 / inode；正常停服 checkpoint 导致的 WAL / SHM 清理不视为身份变化。候选未启动的 owner 修复回滚验证原 Home、已安装包和签名资源，不要求废弃候选或外部开发分支 HEAD 仍然可用；候选准备、切换和接受的完整来源校验不变。

正式事务应使用独立冻结的已构建安装器目录；不要在同一目录并行构建或运行会重建 `lib/` 的测试，也不要与会创建同用户隔离进程的测试并行迁移。用量监控等外部 Home 读取进程同样可能阻止静止证明，应在明确授权后临时暂停、结束后恢复，而不是放宽进程检查。准备候选后，保持其外部源码 HEAD 不变直至事务结束，避免前向来源校验拒绝漂移。

#### 已运行但未就绪的修复后继

首修候选已实际运行，而冻结代码缺陷使 `host-recover` 反复未通过 readiness 时，不能替换其包文件、修改冻结 installer、删除事务或回退最老 Home。开发入口 `host-owner-repair-successor` 仅接受同 Host、已运行但尚未接受、无采用和签发器用量的 owner 修复事务；预设必须与前次显式授权相同。它不是一般升级、放宽验收或已有业务采用的恢复协议。

```sh
node /reviewed/new-checkout/scripts/install/lifecycle-profile.mjs \
  host-owner-repair-successor assistant /absolute/dsh-home \
  /absolute/current-private-dsh /usr/bin/bwrap /usr/bin/systemctl /usr/bin/journalctl \
  /absolute/private-current-plan.json /absolute/new-prepared-local-update /reviewed/new-checkout \
  danger-full-access /absolute/private-new-auxiliary-root
```

新源码及安装器必须独立准备。停服后重新校验当前候选、原备份、完整包图、原签名链、owner 绑定、全部授权和未使用状态；复制 Home 导致的身份库 inode 变化仅在设备、完整绑定及存储摘要均相同时接纳，同一 Home 的通常恢复仍要求 inode 不变。先持锁写入并同步原 Host 签署的 Home 外后继意图，再将当前候选作为明确未就绪的降级基线恢复服务、完整归档旧事务，随后从当前 Home 制作新的事务副本。新事务保留业务数据库、原 bootstrap、所有历史签名、期限和累计预算，追加源码维护记录及下一条 repair overlay；不会把旧失败事务记为成功。

后继意图未完成时，其余生命周期命令拒绝操作；可识别的中断使用完全相同的后继命令继续。基线检查临时移开绑定 mask 以读取真实 unit 属性，期间保留启用屏障与 crash guardian，正常退出及校验失败均恢复 mask 并确认进程停止。若检查进程硬崩溃，guardian 先停止已知服务，再按已验证旧事务中的 inode、属主和目标无覆盖地复装原 persistent mask，确认服务 masked 且无进程；身份缺失或变化时持续收容，不另造 mask 或宣称恢复成功。此机制防范自动重启与异常退出，不保证零时间窗口，也不抵御同 UID 主动修改 unit 或手工启动；不能手工 unmask 来绕过恢复归属检查。新候选运行前只允许恢复当前降级基线，不能恢复最老 Home；新候选运行后只前滚并重新接受。只有完整新鲜双 Host、飞书、HMAC observer、记忆学习及协调器原生登记通过后，才归档接受证据并清除后继意图。原失败事务与最老 Home 保留为私有审计，不随新事务清理删除。此入口的实际生产状态以[当前状态](../../docs/rsi-status.md)为准。

### Checkout 内的 pre-owner 冻结源码维护

已安装冻结源码/cohort、尚无 RSI owner、coordinator 或 control ledger 的 Linux systemd Home，可显式调用已经审核并构建的本地 checkout。此入口尚未接入普通 `dsh-rsi update`、远程 helper 下载或发布版本 pins；不要复制单个新版 `lib` 文件到正式 profile。先以 `dsh-rsi-setup --prepare-local-update` 在 Home 外制作候选；候选与执行维护的 reviewed checkout 是两份独立绑定的输入。

维护事务在停服前另用 Home 外的私有 profile 和全新缓存，按原有效 pnpm 配置验证原锁文件并预取依赖。随后在一次性同级 profile 中，以原直接依赖执行完整原生 `add --force --ignore-scripts` 在线安装，补齐完整 registry 元数据、依赖包及 pnpm 在安装时短暂获取但不保留在最终锁图中的 peer 包。仅锁解析及 fetch 不足以覆盖这些临时请求。再以另一份原元数据、没有预热 node_modules 的 profile 做完整离线安装复演。在线与离线结果图必须一致，并保留原 registry 包和可选依赖；原生 `file:` peer 上下文可以重算。预热与复演的整个 profile 均丢弃，不把其 manifest、锁或 node_modules 复制到 Home 或正式副本。两份安装都禁用安装脚本与 pnpmfile，不启动 Host。可选依赖解析失败、未知跳过原因、损坏或截断的验证输出，即使 pnpm 退出 0 也会拒绝准备，不把不支持其他平台误作失败。

预热后重新核对原锁的原始字节及本次供应链收据，原 manifest、workspace、lock 文件必须保持不变；无软链的 registry 镜像摘要、pnpm 程序、配置及文件身份随准备绑定，并在缓存复制后复核，不能直接复用全局验证标记。准备失败时原服务继续运行。停服后的原生 DSH 安装使用已核对缓存的独立副本，仍无网络、禁用安装脚本和 pnpmfile，并保留供应链策略检查；缺失或漂移的证明不能靠放宽策略继续安装。此准备覆盖原依赖图，不表示新增候选 registry 依赖已经可离线安装。

私有准备不复制全局 registry 认证字段；registry 与供应链策略等非认证配置仍须精确一致，依赖以匿名方式读取，需要凭据而无法预取时在停服前拒绝。传入的 pnpm 程序按文件身份和字节摘要绑定，包安装的 PATH 优先使用其目录；若使用 wrapper，其后续加载文件仍属于外部受信运行环境。本机部署验证使用 pnpm 的独立原生程序。

包树更新后的完整文件、依赖闭包和身份检查在新的 Node 进程内执行，避免预检缓存的模块解析路径继续指向旧包目录；检查条件保持一致。新进程沿用当前安装隔离边界，校验失败仍拒绝切换。

旧冻结安装缺少 `assistant-memory-learning` 时，可用同一 reviewed checkout 的 CLI 显式准备唯一受支持的根包扩展。目标必须已提供 Personal Assistant、Delivery、Evaluation 和 Verifier，且通过实际 pre-owner 权限与签名历史检查；这不是任意增删插件的入口：

```sh
node /reviewed/checkout/plugins/lark-channel/bin/dsh-rsi-setup.js \
  --prepare-local-update --add-memory-learning --profile assistant \
  --dsh-home /absolute/dsh-home --source-repository /absolute/source-repository
```

该候选使用独立 schema 2 收据和目录，冻结旧 cohort 与精确新增包；普通 schema 1 更新仍保持原 roots。准备不切换服务、不启用学习。随后按下述 `local-service-upgrade` 激活同一候选：停服副本只增加该根依赖及原生 bundle mount，原 patch 字节不变；真实有效配置只允许新增官方 `disabled: true`、无 config 的 learner 行，保留其固定 injections、其他行的动态标签及所有其他 profile。成功迁移后再执行 owner 安装，分别签发有限授权与预算；已有 paused Automation 的确认仍属于 owner 安装。

```sh
node /reviewed/checkout/scripts/install/lifecycle-profile.mjs \
  local-service-upgrade assistant /absolute/dsh-home \
  /absolute/pinned-dsh /usr/bin/bwrap /usr/bin/systemctl /usr/bin/journalctl \
  /absolute/pnpm /absolute/prepared-local-update /reviewed/checkout

# 失败或崩溃后，仍须显式指定同一 reviewed checkout。
node /reviewed/checkout/scripts/install/lifecycle-profile.mjs \
  local-service-recover assistant /absolute/dsh-home \
  /absolute/pinned-dsh /usr/bin/bwrap /usr/bin/systemctl /usr/bin/journalctl \
  /reviewed/checkout
```

调用前停止其它外部或手工 Home writers；受管 systemd units 由既有 Home 锁、mask、guardian 和原子 Home 切换事务接管。预检先检查 Home 及所有 profile 的持久 YAML，随后只在私有 Home 副本的 bwrap 逻辑路径内执行原生配置导出，逐字节核对配置未被导出改写。正常 `!!js` 路径/脚本文本只惰性解析，动态 owner 配置、额外配置格式、隐藏授权、非空 Recovery jobs 和启用的 Automations scheduler 均拒绝。`profiles/node_modules` 是原生共享依赖目录，不作为 profile。

#### 未启用 owner 的旧行为镜像

源码维护不会静默改写既有 `rsi-creation-builds` 收据。若首次 owner 安装发现行为镜像仍绑定旧源码，先完成经过认证的源码及构建资源更新，确认当前行为镜像配方与依赖锁一致。再显式迁移这个尚未被 owner 使用的辅助资源：

```sh
node /reviewed/checkout/scripts/install/creation-build-migration.mjs \
  assistant /absolute/dsh-home \
  /absolute/.dsh-rsi-creation-build-migration-reviewed-20261013 /reviewed/checkout
```

归档须是 Home 同级、同文件系统下尚不存在的 `.dsh-rsi-creation-build-migration-` 前缀目录。入口持有 Home 生命周期锁，核对签名源码历史、未初始化的 owner / registry / 账本及旧收据，只把严格识别的旧资源原样归档到 Home 外；新收据必须由当前源码和构建环境的原生镜像准备器生成。日志和旧收据保留，重复调用沿同一日志恢复，不覆盖未知目录或用旧镜像冒充新环境。已有 owner、未知资源、漂移或不完整归档均拒绝；不能用删除旧目录替代迁移。镜像准备可能访问 Debian 包源，但候选行为验收仍禁网运行。这个操作不启用 scheduler，也不代表普通使用学习已验收。

若在首次日志落盘前崩溃，空归档不会被自动认领；原资源尚未移动，经人工核对后可另指定新归档重试。日志原子替换前崩溃留下的临时文件也会被拒绝，需检查原日志、临时内容和两侧资源后处理；不要直接删除归档重跑。已完成迁移的新资源丢失时同样拒绝重建，不把未知丢失当成首次安装。

DSH `0.2` 的 standalone setup 需要 Host 原生模块解析器；不要用旧 PATH 中的 DSH 或手工补 `NODE_PATH`。在已审核 checkout 中，指定 Home 绑定的私有 Host 后调用安装器入口：

```sh
export PATH=/absolute/verified-host/node_modules/.bin:$PATH
source /reviewed/checkout/scripts/install/common.sh
dsh_enhanced_run_profile_setup 0 /absolute/dsh-home assistant dsh-rsi-setup \
  --install-owner --profile assistant --dsh-home /absolute/dsh-home \
  --source-repository /absolute/source-repository --ack-existing-automations
```

只有返回 `mode: "ready"` 才证明本次双 Host 就绪、owner-bound 协调器及记忆扫描登记完成。确认旧 Automation 仅允许打开调度，不恢复 paused 定义，也不续期旧授权。

离线包安装完成后，在同一隔离副本内调用已固定 Host 的原生 `loadProfileDirectory` / `healProfilesModuleFallback`，重新生成依赖解析的 `.dsh-module-fallback` 链接；不启动 Host 或插件，不修改持久配置。缺失原生 API 或 Host 身份不符时拒绝继续。仅导出配置不会修复这些链接。

副本链接检查沿已打开的目录 FD 逐级读取内部链接，再以真实路径核对最终目标的副本边界；FD 路径别名不会把内部 pnpm 链接当作外链。某一相对链接离开副本时，按切换后的逻辑 Home 位置解析该跳，因此原样的 `.bin` → 包目录 → 仓库链接仍可核对原目标身份。副本内目标缺失时不回读原 Home；内部链最多 40 跳，循环仍被拒绝。最终目标在副本外或不存在的包链接，仅允许原文本与原目标身份均不变的白名单条目。这保留既有最终目标校验合同，未增加外部中间链接的逐跳隔离。

事务记录真实 composed scenario 和独立 pre-owner 证明，绑定 reviewed installer 的完整已安装模块树、候选收据、六类源码/制品/授权资源和所有持久/有效配置摘要；即使版本号相同也验证安装闭包的实际字节。停服后复核，将 stage 根目录收窄为 0700，再于无网络副本离线物化既有 bundle，并以原 Host 身份签署 pre-owner 源码维护链。包安装保留已验证的 pnpm store 路径别名，只写事务内的独立 store/cache 副本；SQLite 索引用在线备份，原缓存不作为可写挂载，副本不继承项目登记和 dlx 执行缓存。复制并非全树原子快照，仍以离线完整性检查和最终安装字节核验拒绝缺失或变化内容。不会创建 owner ledger、改动用户授权、开启 scheduler 或清除历史工作。预览在额外的完整可丢弃 Home 副本中运行，丢弃其队列、数据库和会话写入，最终待切换副本不会被预览启动。预览使用仅限 pre-owner 的配置派生检查：只禁用 Lark 连接，并在 Health 原本要求 larkChannel 时删除该项；缺失的检查不凭空创建，其他 provider、配置和动态标签保持一致；正式接受仍要求 fresh InvocationID、Host ready、真实飞书连接与稳定窗口，接受记录持久化后才清理事务。包含 Recovery/Control Plane 的 pre-owner profile 即使被组合分类为 supervised，仍使用 pre-owner 接受记录；owner 证明决定专用验收分支。切换前失败恢复原活动服务；切换后失败保留新旧 Home 和事务，重试必须重新验证模块、资源、配置及安装包字节。已有 owner/coordinator 的 supervised 升级继续使用原有 attestation/Health 门。

受管 Host 更新是第二个独立事务：先完成同批插件升级，使目标与协调器可以读取新的维护记录，再迁移 Host。Home 外先准备候选 Host 及每个 profile 的原生依赖锁文件，随后停止同 Home 受管服务，复制完整 Home，离线重建原生依赖并验证候选配置，最后切换 Home 和 unit。Host 阶段失败不撤销已提交的插件升级；切换后验收失败保留事务与新旧 Home 供重试对账。所有受管 profile 参与校验，原先停止的服务保持停止。登记过的 RSI 安装保留原 bootstrap、密钥、授权期限和使用记录，以原 Host 身份签署维护关联，更新当前部署和回滚备份的文件基线。真实启动还检查目标的飞书连接、owner/数据库绑定和新运行代次，以及协调器的本次 Automation 登记。

Host 依赖准备阶段联网验证 pnpm 供应链策略并完整预取；离线副本安装前重新核对准备元数据摘要，随后仅信任这份已验证锁文件，允许写入独立临时 store，仍禁止网络、安装脚本与 pnpmfile hooks。RSI 迁移在停服前及停服后的原账本和副本上检查未结任务、发布、激活与观察回执；这些工作须先在原 Host 完成对账，避免替换授权配置后无法继续处理原请求。

CLI 重试先处理未完成的 Host 事务。现有未绑定 Home 不自动接管全局 Host；普通 registry 更新仍拒绝冻结本地源码/cohort，支持的现有 Linux owner 改走上文的程序升级路径。当前仅实现 Linux 受管事务，兼容窗口以 [兼容性说明](../../docs/compatibility.md) 为准；受控夹具中的合成版本不代表官方发布或真实跨版本验收。

事务也不会修改权限、模型或 Agent 工具配置，并会拒绝不安全 owner/权限、home 内的外部状态链接、外部硬链接、挂载点、特殊文件及无法证明归属的旧事务残留；失败证据保留在同级 transaction 目录供人工排查。`--confirm-dsh-home-stopped` 对 service-aware lifecycle 表示除安装器将自行停止的 systemd units 外，其它使用整个 `DSH_HOME` 的外部/手工进程均已停止；它不是允许安装器 kill 未知进程的授权。

Linux Lark/supervised service-aware upgrade/uninstall 另外要求固定系统解释器 `/usr/bin/python3`，用于 `renameat2(RENAME_NOREPLACE)` 的无覆盖文件屏障；`DSH_HOME` 与用户 systemd 配置目录必须位于同一文件系统。

## 彻底卸载（purge）

`--operation uninstall` 是**保留数据的归档**（旧 profile 移入 `$DSH_HOME/uninstalled-profiles/`，凭据 / Session / Goal 等状态保留）。需要**彻底删除**整个安装（崩溃救机、报废环境、干净重装）时，使用随插件集合一起安装的全局 `dsh-rsi` 命令：

```sh
dsh-rsi doctor          # 只读诊断：host 版本、服务、凭据条目数、已知崩溃模式
dsh-rsi purge --dry-run # 查看完整删除计划
dsh-rsi purge --yes     # 先在 ~ 生成 0600 的 tar.gz 备份，再删除 DSH home 与全部受管痕迹
```

purge 覆盖 npm cohort 实体副本与本地 checkout 符号链接两种形态。**全量**（默认）删除整个 `$DSH_HOME`（profiles、logs、uninstalled-profiles、home 内锁文件）以及 home 外生命周期事务目录、失败诊断目录、home 锁；Linux 另清理 `/tmp` rendezvous 锁，macOS 保留共享内核锁文件以维持并发互斥。**单 profile**（`--profile <name>`）只删除 `profiles/<name>`、该 profile 的两份 host 日志与 `.failed-<name>-*` 失败诊断目录，共享的生命周期事务目录与两把锁因可能涉及其它 profile 而刻意保留——注意单 profile 的 tar.gz 备份仍覆盖**整个** `$DSH_HOME`。两种范围都会停用并注销 launchd / systemd --user 受管服务，并按各 profile 的 setup journal 权威反查清理 Keychain / Secret Service 中 service 前缀为 `dsh/` 的凭据。选项：`--no-backup`、`--keep-keychain`、`--remove-host`（同时卸载全局 `@deepseek-ai/dsh`，默认保留；仅限全量）。本地 checkout 源码只删符号链接、**绝不删除 checkout**，报告会列出 checkout 路径。清理前会先停用受管服务。Linux 停服后若还有可证明属于目标 Home 的残留进程，`--yes` 会尝试终止它们；没有 `--yes` 时会拒绝并列出进程。无法证明归属的进程，或旧检查仍发现运行中的 Host，均会阻止删除；`--yes` 不能绕过归属检查。systemd unit 文件内容不匹配受管标记时只报告保留。完整命令参考见 [CLI 指南](../../packages/dsh-rsi-cli/README.md#故障与卸载)。

机器上 host 已损坏或全局命令被删时，可执行单文件救机脚本，参数与 `dsh-rsi purge` 一致。Linux 优先委托 `dsh-rsi`，找不到时使用内联精简实现；macOS 必须找到具有 `macos-launchd-ownership-v1` 能力的完整 CLI，旧 CLI 或缺失 CLI 均停止清理并提示升级，不停止服务、不删除数据：

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/purge.sh \
  | bash -s -- --yes
# 或 checkout 内：
./scripts/install/purge.sh --dry-run
```

`purge.sh` 是 **mutable-main 运维脚本**：始终取 main 分支最新版本，不做 release pin / SHA-256 校验，也不纳入 `install-npm.sh` 的引导资产清单（引导器不会下载执行它）。它与固定 tag、最多六项按需资产摘要校验的供应链引导路径刻意分离；需要可复现引导校验时仍应使用 `install-npm.sh`。

## 通过 `dsh-rsi` 安装与重装

全局 `dsh-rsi` 也可以直接发起安装（修复损坏安装、救机重装），它是**薄委托**：自身不复制任何安装逻辑，只锁定版本并把参数原样交给对应安装器，stdio 与终端直连。

```sh
# npm 形态（默认）：下载与本 dsh-rsi 同版本（vX.Y.Z）的 install-npm.sh 到临时目录执行；
# 引导脚本内部仍按内嵌 SHA-256 自校验 common.sh 等资产
dsh-rsi install

# 只需轻量 core 时可跳过飞书 onboarding
dsh-rsi install --scenario core --yes

# local 形态：执行 checkout 内 install-local.sh
dsh-rsi install --local ~/work/github/dsh-enhanced --scenario web

# 安装器支持的全部参数（--scenario/--workspace/--model-route/--lark …）原样透传
dsh-rsi install --help

# 干净重装：先按 purge 安全门控备份+彻底删除，再交互式完成 onboarding
dsh-rsi reinstall
dsh-rsi reinstall --local ~/work/github/dsh-enhanced
# 非交互重装可显式选择轻量 core
dsh-rsi reinstall --profile web --scenario core --yes
```

`--dsh-home` 由 dsh-rsi 经 `DSH_HOME` 环境变量传给安装器（安装器不识别该 flag）；`reinstall` 的 purge 阶段支持 `--no-backup` / `--keep-keychain` / `--remove-host` / `--profile`，未加 `--yes` 仍需输入 `purge` 确认。安装器退出码原样透传。

交互运行不传参数会选择场景；自动化可显式指定：

```sh
# 本机 Web/direct 核心
./scripts/install/install-local.sh --scenario core --yes

# 实验性本机 Web owner：固定本机 workspace 与 preset，不配置飞书或常驻服务
./scripts/install/install-local.sh --scenario web --workspace "$PWD" --agent-preset standard --yes

# 飞书/Lark 持久消息、owner onboarding 与日常使用自动偏好学习
./scripts/install/install-local.sh --scenario lark --lark configure

# 在上述能力上增加 Evaluation + Evolution + Recovery；按有限授权和独立验收处理
./scripts/install/install-local.sh --scenario supervised --lark configure
```

原生 `web` 模板的新 profile 会预检 Web 端口；原生自定义 profile 只加载 `dsh-base`，不会因为另一个 profile 占用 3080 而被阻止安装。`DSH_ENHANCED_WEB_PORT` 只指定诊断端口，不会改写 DSH 的实际监听配置。

安装器不会把 `dsh --dump-config` 当作“可用”的证明：对于尚未配置 Lark 的 profile，它会在安装 bundle 后、飞书 OAuth 前，短暂启动一次 Host，等待原生 Loader 完成审计后的就绪信号；Web 使用 OS 分配的 loopback 端口，自定义 profile 通过临时 `appReady` 监听接收信号。已启用 Lark 的旧 profile 则不会启动第二个 Host 去并发访问同一份状态；若由安装器管理服务，最终会以真正的常驻进程和稳定性窗口验收。Lark 是否已启用按 DSH 的 home→profile 覆盖层计算，profile 的 `disabled`、`enabled` 或 App ID 覆盖会优先于 home 层，避免把已禁用的 bot 误判为可保留。临时 probe 中的 Lark Channel 会被 process-only overlay 禁用，不会建立第二条 WebSocket，也不会改写 profile。任何 Cordis service 依赖未满足都会明确失败。对于历史 profile 中已存在 `assistant-evolution` 而缺少其 `assistant-evaluation` provider 的情况，安装器会只补齐 Evaluation bundle；不会删除或默默启用其它旧插件。

新 Control Plane 会在原生 Host 完成启动审计后向 stderr 打印 `dsh-enhanced host ready: v1`。安装探针及单目标 Lark/supervised 生命周期事务可用此信号验收无 Web Host；旧 Web URL 信号继续支持。systemd 验收仍绑定新 InvocationID，并执行原有 Lark、稳定性与持久状态检查。旧无 Web cohort 未必具备通知，缺少当前就绪记录时会在停服前拒绝升级。已登记的双 Host 插件升级与独立 Host 更新事务见本页前文。

飞书向导支持纯 SSH/无桌面 Linux：默认先探测 Secret Service，不可用时会在 OAuth 前自动验证并改用当前用户 `0700` 目录下的版本化 `0600` protected-file，不要求安装 GNOME Keyring。该文件没有额外静态加密，同 UID、root 与可读备份仍能读取；需要强制系统钥匙环时，参阅[飞书凭据后端](../../plugins/lark-channel/docs/setup.md#linux-凭据后端)中的独立向导参数及运行前提。

配置飞书时还会自动安装或复用官方 `lark-cli`，使用同一应用完成 owner 的业务域授权，并生成原生 DSH 业务技能；后续有效授权可复用。已有 channel 选择 keep/skip 时不重新发起授权，需要新增业务接入时运行 `--lark configure`。暂缓业务授权的续跑方式见[飞书指南](../../plugins/lark-channel/docs/setup.md#业务权限可以单独处理)。`--no-business-tools` 只属于依赖环境已就绪的独立 `dsh-lark-setup`，不能传给 `dsh-rsi install`；范围、凭据存储和失败恢复见[业务工具参考](../../plugins/lark-channel/docs/setup.md#自动业务工具接入)。

管理内建服务时，安装器会在 OAuth 前检查 systemd user manager 和 lingering。当前用户有权时会自动启用 lingering；需要管理员权限时，交互向导会先展示唯一的固定提权命令，并询问是否现在通过 `sudo` 执行，密码由 `sudo` 直接读取，不进入安装器、参数或日志。拒绝、失败或非交互运行都会在云端授权前停止并给出同一条可复制命令。Linux 安装完成后还会观察 user unit 的 `ActiveState`、`ExecMainStatus` 和 `NRestarts` 一个短窗口；发现快速崩溃/重启循环会打印最近 journal 并停止该 unit，避免 systemd 无限重启掩盖原始错误。容器、未启用 systemd 的 WSL 或其他没有 systemd user manager/logind 的系统应使用 `--no-service`，并由 Docker、s6、runit 等外部 supervisor 保持 `dsh --profile <name> --no-open` 常驻；此时安装器不会宣称或验证内建服务的注销后存活能力。
Linux 上的 Lark 与 supervised setup 还要求 `/usr/bin/flock` 和安全的 root-owned `01777` `/tmp`；setup 会在任何 profile、凭据、数据库或 service mutation 前持有与 upgrade/uninstall 相同的 canonical `DSH_HOME` rendezvous lock，避免 onboarding/reconfigure 与 service-aware lifecycle 并发。

普通 `lark` 场景已经安装 Preference Learning：经 owner onboarding 的完成对话只产生无正文的有界行为证据，并可在固定 T1 目录、阈值和回滚门内自动应用偏好；它不要求 Health、Heartbeat 或 Recovery，也不会新增通用 Agent 工具授权。用户面参数 `--agent-tools disable` 只移除向导托管的规则，不覆盖用户自定义规则或显式的全局 Policy 默认值（安装器内部再映射为 `dsh-lark-setup` 的 `--disable-agent-tools`，不能直接把后者传给安装脚本）。

`supervised` 在此基础上额外安装 Evaluation、Evolution、Growth Experiments、Heartbeat、Goals、Skills、Verifier、Growth Driver、Memory Learning、Recovery 与 Health；Goals 必须与 Recovery 同场景安装，因为 Recovery 的运行时 Cordis 注入要求 `assistantGoals`。Memory 已由 Personal Assistant 内嵌提供，Memory Learning 安装后默认禁用，直到 owner 配置组合三份有限授权和调度预算。普通使用自迭代由下述 `dsh-rsi-setup --install-owner` 成对配置，不要求先激活固定 Recovery runbook，也不因该 runbook 的全局健康门阻止 owner 配置。固定 `supervised-growth/v2` runbook 与 adoption analyst 仍可通过[独立激活器](../../plugins/lark-channel/docs/supervised-growth.md)显式启用，保留原有严格健康检查。新安装发现本机 TraeX 可执行文件时，会把 provider 纳入同一安装集并启用当前 profile 的 route，升级不会自动追加。

新安装 `supervised` 时还会自动调用 `dsh-rsi-setup --prepare-build --optional-build`，在 `$DSH_HOME/rsi-sources/<profile>` 创建私有源码工作树和本地 bare 发布仓库。npm 来源固定为本次安装版本的官方 Git tag，本地来源只取已提交 HEAD；重装保留已推进的修复基准。需要 Git，npm 来源还需要 GitHub 连接；准备失败会停止安装并显示原因，`--dry-run` 只展示命令。符合当前完整仓库检查条件（Linux x64、Docker Server `29.4.1/linux/amd64`）时，还会自动构建并保存不可变的离线镜像配置；前置条件不可用时明确记录构建未就绪并继续普通安装，实际构建失败会停止。重装复用已核对的镜像；不会把缺失的已登记镜像静默换掉。Linux 上该步骤还会自动复制私有授权工具与固定 Node，生成独立签名身份、私有本地 registry/catalog 和状态目录；缺少 Docker 时仍保留这些资源。重复执行保留身份和发布进展，拒绝固定资源漂移。

macOS 的 supervised 使用原生 launchd Host、私有固定 Node 与系统沙箱，无需 Docker。安装时从官方归档及冻结 lockfile 准备运行依赖，重试核对摘要；候选在禁止联网、禁止子进程、只读工作区中接受固定 TypeScript 编译和独立留出行为检查。原生授权限制次数、累计时长和输出，不提供容器的内存、CPU、磁盘硬配额。Apple Silicon 已有实机证据，Intel Mac 仍需独立实机验证。安装失败恢复本次尝试前的配置与服务，重复执行不续期、不重置额度。具体边界见[原生 macOS 学习](../../plugins/lark-channel/docs/rsi-setup.md#原生-macos-学习)。

在最终模型、TraeX、飞书配置和 doctor 后，Linux/macOS `supervised` 安装调用当前 profile 内的 `dsh-rsi-setup --install-owner`，自动读取当前 owner 并生成有限授权；Linux 补装独立协调器并成对启动两个 systemd Host，macOS 启动单个原生 launchd Host。本地安装会传入源码仓库路径。构建前置条件不足，或旧的本地目录链接使必需包实体位于 profile 外时，此阶段返回 `not-ready` 和退出码 3，安装命令不打印“安装流程完成”，已准备的普通 Agent 与资源可用于重试。其他配置或服务就绪失败也非零退出。重试保留原授权期限和额度；`--local` 的 supervised 新安装会从冻结的已提交 HEAD 构建独立 tarball，并将选定插件及其运行依赖安装到目标 profile 内；协调器复用同一批包，安装后校验制品摘要和实际文件。重试保持原提交和包选择，未提交修改不会进入 Agent。包安装失败时保留固定制品和配置，Host 保持停机，供修复后重试。owner route 缺失时在同一配置事务内创建，既有精确路由沿用。打开原先关闭的 scheduler，或迁入另一 Automation 数据库前，会检查原库与目标库；存在 active 或 paused 定义须显式传入 `--ack-existing-automations`，停机后库存变化仍会拒绝。稳定启动验收不等于真实普通任务自迭代闭环，详见[RSI 配置指南](../../plugins/lark-channel/docs/rsi-setup.md)。

`--with coding|traex|health|heartbeat|events|bridge` 可为其他场景追加能力。`--scenario full` 只用于迁移旧的全量默认集合；新安装不应使用它。`--mode supervised-growth` 保持兼容，等价于 supervised 场景。

## 实验性 Web 与 autonomy

`web` 是实验入口：它安装 core、Delivery、Goals 与 Web owner，并在第一次配置组合/activation probe 前运行 profile 内的 `dsh-web-owner-setup`，使用 `web/account=<profile>/tenant=local/user=operator` 的固定本机 owner。安装器通过已验证的 Host 解析配置工具的依赖；当前 DSH 0.2 使用原生运行时解析，不创建旧版共享 peer 目录。它不接入 Lark、不启动常驻服务，也不提高原生权限默认值。该入口尚不代表完整自治或真实模型验收；仍应按部署的模型、权限和工作区边界单独验证。Web owner 复用有效的 Delivery databasePath（默认是 `$DSH_HOME/assistant-delivery/state.sqlite`），不会替换或复活已有 owner；若另一 profile 的 Lark 也共享该数据库，setup 会拒绝，需使用独立的 `DSH_HOME`。为避免同一 profile 的 owner 语义混杂，已有启用 Lark channel、`--lark configure|keep`，或 `--agent-tools` 非 `preserve` 时会被拒绝。

`autonomy` 是显式选择的实验性离线执行入口，安装 Web 场景以及 Isolation、Actions、Keychain、Evaluation、Verifier、Event Triggers、Proactive 和 Skills。后面三者没有匹配授权时保持静默：不会自动创建任务、续期或发起网络请求。基本 RSI 首版包含有限 repair admission 与同一任务族的两轮改进验收；完整自治规划仍在推进，使用边界见两轮验收记录。

```sh
./scripts/install/install-local.sh --scenario autonomy --workspace "$PWD" \
  --isolation-image sha256:<已存在的本机镜像ID> \
  --isolation-max-runs 20 --isolation-lease-minutes 60 \
  --isolation-runtime-minutes 10 --yes
```

安装前需准备非 root Linux Host、可访问的本机 Docker 和兼容 Isolation 的固定镜像（要求见 [Isolation 文档](../../plugins/assistant-isolation/README.md)）。安装器不拉取镜像、不安装或重启 Docker。setup 使用最终配置的 Docker 路径，通过生产 supervisor 实际执行非 root、只读根目录、隔离工作卷与 artifact 导出探测，成功后才初始化 owner 并写入 grant。失败会给出运行时原因；清理状态未知时保留私有 probe 证据目录，需要先排查其中记录的资源。探测只证明该固定任务的执行链路，不证明任意自定义任务或完整自治。

首次 grant 精确绑定本机 Web owner 版本、workspace 和 preset，默认 20 次、60 分钟期限、10 分钟累计预留执行时长；次数最多 10000、期限最多 7 天、累计时长最多 1 天。单次任务仍受 Isolation 的独立限制。重复 setup 保留原过期时间、撤销记录和已使用预算，即使过期也不自动续权；修改原绑定、镜像或预算需显式迁移。profile 私有 Isolation/Actions 状态和 Keychain 路径与其他 profile 分开，已有合法自定义路径保留。

autonomy 安装在 Host 激活检查后还会执行有限隔离诊断；已撤销、过期或耗尽的旧 grant 会使这一步失败，重复安装不会恢复它。日常复查使用 `./scripts/install/doctor.sh --profile web --require-isolation`。它读取已组合配置、Delivery owner 和 Isolation 的持久账本，报告累计次数/预留时长、剩余额度及 unknown 作业，再用同一镜像和 Docker 路径做临时探测；探测后重新核对配置及授权。该命令不启动第二个 Host，不配对、迁移账本、续期或消费业务 grant，可在已有 Host 运行时诊断。

诊断当前只支持 installer-managed Web owner 与单一 `autonomy-<profile>` grant、Delivery schema 20 和 Isolation schema 6；缺失、旧版或不一致的状态明确失败，需先按正常升级/迁移流程处理。通过表示该时刻的有限隔离检查通过，仍不能证明后续动态 Policy、实际资源准入、模型计量、Goal 独立验收或外部 Actions 可用；这些能力在结果中明确未检查。不要通过删除账本或重跑 setup 绕过已消耗的授权。

在该受管作用域中，模型只能调用受支持的隔离、目标上下文/检查点和获准的有限 Actions 工具，不能退回宿主 shell。Actions 默认无 grant，Keychain 不创建凭据。模型配置沿用安装器的独立引导；GitHub 目标/凭据、独立目标验收、后台唤醒以及完整自治生命周期仍需后续配置与验证。不要通过删除账本重置授权。

## 为已有 Web Session 配置有限 Goal admission

`autonomy` 安装完成后，`dsh-web-owner-setup` 可通过 `--goal-admission <private-json> [--session-id "$existingSessionId"]` 写入一个有限目标 admission。先停止目标 Host，任务 JSON 必须是工作区外的绝对路径、当前用户所有并为 `0600`；随后重启 Host 才会读取新 patch。先运行 `--list-goal-sessions` 查看当前 owner、workspace 和 preset 下的真实 idle Web Session；省略 `--session-id` 时仅在唯一候选时自动选择，多候选会打印可选 ID 并失败。它从不创建或伪造 Session/binding；新 profile 请先从原生 Web UI 打开一次。

v1 任务只能选 `deepseek-v4-flash` 或 `deepseek-v4-pro`，并需为每次调用预留至少 `2097152` input tokens；没有 USD 硬预算，也不接受 `costUsdMicros`。它固定 provider endpoint，使用 credential reference（如 `DEEPSEEK_API_KEY`），不接受明文 key。v2 任务使用 `{ "route": { "provider", "model" } }` 和 `{ "mode": "calls", "routes": [同一精确 route] }`；route 必须与实际配置的 `agent-default-model` 完全相同，setup 不会复制 secret 或修改模型配置。v2 硬限制为模型/工具请求数、时长和单次输出上限；usage 若由 adapter 提供仅作记录，不是 token/USD 硬限。任务还必须提供有限的 isolated verification cases；可选 wake 也有独立次数、延迟和运行期限。重启后 v1 需在已有 Session 中选择 `deepseek-goal-metered` 下的任务模型；v2 沿用已配置 route。

此操作不会续期或重置 installer-managed Isolation grant；与本次任务要求冲突的已有受管配置或同 ID 条目会拒绝，不被覆盖。该精确 Session 只用于核验 owner 和可选 wake route，profiles 绑定 owner、scope 和 objective。成功只表示本地配置、已有 Web owner snapshot 和持久 grant 在写入时一致；不代表真实模型/网络调用、业务 Goal 完成、独立验收成功或完整自治功能已交付。详见 [Web owner Goal admission](../../plugins/assistant-web-owner/README.md#有限-goal-admission实验性)。

核心 profile 中的 `plugin_discover` 可立即按能力检索内置、完整性固定的首方候选目录；它不会下载或启用任何包。Agent 只能生成待审批 plan，owner 仍需用 `dsh-plugin-control approve` 与 `activate` 在 staging profile 中显式启用。写入 `~/.dsh/plugin-control/catalog.json` 的 owner catalog 会取代内置目录。

新安装在没有用户权限设置时默认 **Full access**（`danger-full-access + never`），不逐次请求批准，可访问任意文件和网络；只应在信任的环境中使用。安装器仍默认 `--permission preserve`：已有用户设置原样保留，已记录的会话档位也不会被升级覆盖。需要更严格的后续会话默认，用 `--permission workspace-write`（人工批准）或 `--permission auto`（自动审核）。显式把既有默认改为完全访问时，使用：

```sh
./scripts/install/install-local.sh --permission danger-full-access --confirm-dangerous-full-access
```

当前会话不必为了切换档位而重启：Web 使用原生 Permission selector；飞书发送 `/permission` 打开卡片，或发送 `/permission ask`、`/permission auto`、`/permission full confirm`。这些入口修改当前会话；安装器的 `--permission` 修改后续新会话默认。Full access 不绕过显式 Policy 拒绝、紧急停止、身份、预算以及操作系统权限。

新安装飞书场景的 `--agent-tools` 默认为 `auto`：新 owner 使用向导的 Agent 工具默认规则，已有 owner 保留原规则。显式 `allow`、`preserve`、`disable` 仍可选；非飞书场景及升级默认保留现有规则，`core` 场景固定为 `preserve`。

## 配置默认模型

DSH 需要一个能解析的默认模型才能真正对话。新安装时若 PATH 上有真正可执行的 `traex` 或 `trae-cli`，安装器会在写入前把 TraeX provider 加入同一 cohort 预检、安装并启用当前 profile 的 route，不弹模型菜单。它只在最终有效命令已登录、且 settings/home/profile 都没有显式默认模型时，为当前 profile 选择 `traex-agent` 默认模型；已有命令、工作目录与明确默认模型均保留。未登录时 route 仍启用，但不声称可对话，只提示运行最终命令的 `login`；`--model skip` 仍安装并启用 route，但不选择默认模型。未发现 TraeX 时沿用模型配置引导；仅在未检测到 TraeX 且未显式指定 provider 时，`--yes` 和非交互运行不主动写入新 route。升级不自动追加 TraeX 或改模型 route。

引导支持三种目标，都由 `dsh-model-setup --profile <目标 profile>` 写入目标 profile 的 `cordis.patch.yml`：`agent-default-model` 选择模型，自定义网关另写 `llm-pi-ai.providers.<route>`。各 profile 的选择彼此隔离：

```sh
# DeepSeek 官方：只需模型名（缺省 deepseek-v4-flash）与 API Key
./scripts/install/install-local.sh --model-provider deepseek-official --model-name deepseek-v4-flash

# 自定义 OpenAI 兼容网关：provider + base URL（+ 可选协议/显示名）
./scripts/install/install-local.sh \
  --model-provider my-gateway --model-name my-model \
  --model-base-url https://gateway.example/v1 \
  --model-api openai-completions --model-display-name 'My Gateway'

# 本机 TraeX：复用已登录的 traex/trae-cli，无需 API Key
./scripts/install/install-local.sh --model-provider traex-agent
```

`--model-api` 仅用于自定义网关，缺省 `openai-completions`（`/v1/chat/completions`），也可选 `openai-responses` 或 `anthropic-messages`；`deepseek-official` 由内置 `dsh-llm-deepseek` 服务，禁止携带这些传输字段。`--model configure` 在交互终端会额外弹出选择向导；`--model skip` 跳过默认模型选择，但不阻止自动启用本机 TraeX route。

### 本机 TraeX 作为默认模型

若显式选择 `--model configure`，且本机 PATH 上存在 `traex` 或 `trae-cli`，交互向导会多出一个「本机 TraeX」选项；也可用 `--model-provider traex-agent` 直接指定。这是一个 **agent route**（由本机已登录的 TraeX 通过 ACP 提供），因此：

显式 `--model-provider traex-agent` 和上面的自动发现路径都只写当前 profile 的默认行，不改全局 settings。

- 不需要 API Key，也不接受 `--model-base-url/--model-api/--model-display-name`。
- 安装器会自动把 `@dsh-enhanced/traex-acp-provider` 加入安装集，把目标 profile 的 `agent-default-model` 指向 `traex-agent`，并在同一 patch 层把 provider 行置为 `enabled: true`（保留其它行、注释与 `!!js` 表达式；已有 `cwd` 覆盖不被改写）。
- 当本轮将默认模型设为 TraeX 且 `--model-route` 保持 `auto` 时，安装器会先做不消耗额度的 `traex login status` 校验，再写入目标 profile 默认模型并检查适配器；未安装、未登录或 profile 未注册适配器都会失败。后两步失败或在此窗口被中断时，会恢复本次前的配置快照。显式 `--model-route skip` 仍可跳过该检查。

`traex-agent` 的适配器按 profile 注册（只在启用了 `traex-acp-provider` bundle 的 profile 里存在）。安装器只把它设为目标 profile 的默认值，并通过该 profile 的 `--dump-config` 与 `traex login status` 做结构化验证，不消耗模型额度。每次真实调用会新起一个 `traex acp serve` 子进程并消耗 TraeX 侧额度；具体边界见 [`traex-acp-provider` 文档](../../plugins/traex-acp-provider/README.md)。

API Key 推荐在 [Web 模型设置](../../docs/models.md)中保存，使用当前 Host 的凭据格式；不要手工编辑 `.credentials.yaml` 或把密钥写入命令。安装器支持从 `DSH_ENHANCED_MODEL_API_KEY` 或提供商对应变量读取密钥，终端无环境变量时也会询问隐藏输入；这些部署入口用于配置默认值。只添加一个可选模型时使用 Web，无需重跑安装器。TraeX 不需要 API Key。

独立 `dsh-model-setup` 入口要求正确的 Host 依赖解析与 PATH；私有 Host 安装请优先通过安装器调用。源码开发环境可用 `dsh-model-setup --help` 查看所有选项。

手动调用 `dsh-model-setup` 或 `dsh-permission-setup` 时请传 `--profile`。省略时仍写旧版全局 `settings.yaml`；DSH 0.2 会在首个启动的 profile 上执行一次性导入，不能用于多个 profile 的定向设置。对应旧区段尚待导入时，`--profile` 会拒绝写入；先将旧值迁移到目标 profile 的原生 patch，确认后再运行配置器，安装器不会擅自删除或分配旧设置。

模型 route 不会被安装器静默调用；配置模型后可请求一次最小验证：

```sh
./scripts/install/install-local.sh --scenario lark --lark keep --model-route verify
```

验证方式取决于目标 profile 的有效默认 provider：普通 API-key/网关 route 先从目标 profile 的 `--dump-config` 读取 provider/model，再用临时只含该选择的 headless overlay 发送一次固定最小请求；待导入的全局 `settings.yaml` 存在时拒绝真实验证，以免消费其它 profile 的遗留配置。agent route（`traex-agent`）不发模型请求，改为校验目标 profile 已注册 `traex-acp-provider` 适配器并检查 `traex login status`。

新建原生 `web` 模板时会预检 Web 端口（默认 `127.0.0.1:3080`，可用 `DSH_ENHANCED_WEB_PORT` 覆盖）。自定义 profile 不要求 Web 端口；安装器在飞书配置前通过原生 Host 就绪信号验证插件真实激活，而非只验证 YAML 可组合；已管理的 Lark profile 则以实际常驻服务验收。独立诊断：

```sh
./scripts/install/doctor.sh --profile web
./scripts/install/doctor.sh --profile web --require-service
./scripts/install/doctor.sh --profile web --require-isolation

# 安装前预检：只检查 Web 端口占用，不组合 profile、不启动 Host
./scripts/install/doctor.sh --preflight --port 3080
```

`doctor.sh` 参数：`--preflight` 切换为安装前预检（只查 Web 端口，默认 postflight 会组合 profile 并对未启用 Lark 的 profile 做一次前台激活）；`--port <1..65535>` 指定预检端口（默认取 `DSH_ENHANCED_WEB_PORT`，再缺省 `3080`）；`--require-service` 验证受管常驻服务与 Linux 注销后存活；`--require-isolation` 检查有限隔离授权、配对 owner 与临时 Docker 探测（不另起 Host、不续授权）。`--require-isolation` 不得与 `--preflight` 或 `--require-service` 同用，违反时以退出码 2 拒绝。

`--require-service` 在 Linux 同时验证 systemd user unit、稳定性窗口和 lingering；若检测到循环崩溃会停止该 unit 并输出 journal，若未启用 lingering，注销会停止 user service，按 doctor 提示运行 `sudo loginctl enable-linger "$(id -u)"`。未带 `--require-service` 的 doctor 会避免对已启用 Lark 的 profile 启动第二个 Host；macOS LaunchAgent 与 Windows 当前用户计划任务只能在用户登录会话中运行；Windows 的任务会在失败后重启，但不宣称注销后继续运行。

远程 npm 安装器（`install-npm.sh`）是薄引导器。将它下载到新建的私有目录再执行：若同目录存在可读的 `common.sh`，脚本会直接 source sibling，仅可信 checkout 适合该模式。没有 sibling 时，引导器从固定 `vX.Y.Z` 发布标签下载并校验 `common.sh`；最终 `--operation` 为 `upgrade` 或 `uninstall` 时，再下载 `lifecycle-config.mjs` 和 `lifecycle-profile.mjs`；存在 `DSH_ENHANCED_HOST_UPDATE_PLAN` 或 `DSH_ENHANCED_HOST_RECOVERY_ONLY=1` 时，再下载 `host-lifecycle.mjs`、`host-profile-update.mjs` 和 `host-rsi-update.mjs`。所需资产先写入私有临时目录的 `.download` 文件，逐项通过内嵌 SHA-256 校验后才封存，并在 source `common.sh` 前核验文件身份。缺失、无效或占位的必需摘要会拒绝对应操作。

远程 bootstrap 要求 `TMPDIR` 是绝对路径；逻辑路径上的每个符号链接组件都必须由 root 拥有并解析到目录，因此接受 macOS `/var` → `/private/var`（每用户 `TMPDIR` 所在）与 `/tmp` → `/private/tmp` 这类操作系统别名，任何非 root 拥有的符号链接组件都会在下载前被拒绝。完全解析到 canonical 路径后，最终目录必须由当前用户拥有，其非系统临时目录祖先不能由非 root/当前用户拥有或向 group/other 开放写权限；系统 `/tmp` 必须解析到 root-owned `01777` 目录。六项资产摘要可分别由 `DSH_ENHANCED_INSTALL_COMMON_SHA256`、`DSH_ENHANCED_INSTALL_LIFECYCLE_CONFIG_SHA256`、`DSH_ENHANCED_INSTALL_LIFECYCLE_PROFILE_SHA256`、`DSH_ENHANCED_INSTALL_HOST_LIFECYCLE_SHA256`、`DSH_ENHANCED_INSTALL_HOST_PROFILE_UPDATE_SHA256` 和 `DSH_ENHANCED_INSTALL_HOST_RSI_UPDATE_SHA256` 覆盖；`DSH_ENHANCED_INSTALL_REF` 可覆盖固定发布 tag。已请求资产的摘要必须是精确的 64 位小写十六进制值。远程模式的安装逻辑和生命周期执行器不从 mutable `main` 执行；可信 checkout 的 sibling 模式直接使用本地 helper。

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash -s -- --scenario core
```

管道示例只安装轻量 `core`。首次完整 `supervised` 需要终端交互；不使用 npm CLI 时先下载脚本再执行：

```sh
installer_directory="$(mktemp -d)"
curl -fsSLo "$installer_directory/install-npm.sh" https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh &&
  bash "$installer_directory/install-npm.sh" --scenario supervised
install_status=$?
rm -rf -- "$installer_directory"
test "$install_status" -eq 0
```

默认仍推荐[简明安装指南](README.md)中的 npm CLI 入口。

安装器默认先把 `@dsh-enhanced/personal-assistant@latest` 解析为一次安装的精确版本，再用该精确版本预检并安装每个选中的 `@dsh-enhanced/*` bundle；registry 查询固定使用 npm 的 global location，避免当前 checkout 中 pnpm 专用 `.npmrc` 键被 npm 误报为 unknown project config。profile add 仅把 pnpm 日志级别降到 error：安装器自己的 cohort/阶段输出保留，Host 已提供的 optional peer 与已明确忽略的 build-script 重复提示不再刷屏，真实 package-manager 错误仍原样显示并以非零退出。因此仍会获得最新的完整发布，不会因各包独立解析 `latest` 而混装。预检发现任一 bundle 尚未发布该版本时，会在修改 profile 前失败。显式传入 `--plugin-version` 或 `DSH_ENHANCED_VERSION` 可使用精确 SemVer 或 npm dist-tag；tag 同样先由 anchor 解析为精确版本。版本 range 会被拒绝，因为它不能表达一个可验证的单一 cohort。`--dry-run` 不访问 npm registry，会显示待执行的 anchor 解析与预检；要确认实际发布状态请去掉 `--dry-run`。`supervised` 场景要求完整的 bundle 集合，安装后由 owner RSI 入口成对配置目标与协调器。

本地源码改动后仅重建并重启已有常驻服务：

```sh
./scripts/install/restart.sh [profile]
```
