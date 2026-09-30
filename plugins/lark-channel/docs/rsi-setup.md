# 日常使用自迭代的双 Host 配置

`dsh-rsi-setup` 将已配置的 Lark owner 目标 profile 和独立采用协调器接入原生 Automations。目标 Host 从普通任务学习持久事实与经验，并从真实任务反馈形成源码修复，协调器在目标重启期间继续有限交接；目标恢复后重验当前 owner 和反馈，再完成采用。后续任务进入观察与回滚流程。

Linux `supervised` 新安装在最终模型、TraeX、Lark 配置和 doctor 完成后自动运行 `dsh-rsi-setup --install-owner`。它使用当前 active owner，准备独立协调器、有限授权与发布/Host 配置，成对应用并启动两个 systemd user Host。需要可用的 systemd user session、完整离线构建资源和同批已安装插件；缺少构建前置条件会返回 `not-ready` 和退出码 3，安装流程不打印完成。完整生产部署仍需实际使用验收。源码发布轨使用授权的本地 registry，仓库公共 npm 发版仍走仓库发布流程。

## 1. 准备源码、构建环境与两个 profile

新安装的 `supervised` 场景会自动准备私有源码仓库，并安装下述目标依赖。源码放在 `$DSH_HOME/rsi-sources/<profile>/`：`checkout` 为独立工作树，`release.git` 为本地 bare 发布仓库，`bootstrap.json` 保存来源与初始提交。npm 安装读取本工具版本对应的官方 `v<version>` tag；本地安装只复制 checkout 已提交的 HEAD，保留原工作区的未提交修改。

已有安装可单独运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --prepare-source --profile web --dsh-home "$HOME/.dsh"
# 本地开发安装额外传 --source-repository /absolute/path/to/dsh-enhanced
```

输出 JSON 的 `repository` 与 `baseline` 可直接用于 `sourceJobs`；Growth 与相关授权须引用同一仓库。初始发布分支为 `repairs`，受管基准为 `refs/dsh-source/repairs`。重复执行会复用并核对已保存的来源和版本，保留已推进的发布分支及基准；它不会把日常修复回退到安装版本。不同版本或来源不能覆盖已有目录，须先完成部署迁移。准备过程需要 Git，官方来源还需要访问 GitHub；失败或中断不会被当成完成。

Linux 上的新安装还会自动准备授权工具与本地发布资源，无需手工复制程序、生成密钥或创建 registry。`--prepare-build` 在构建准备前执行此步骤，因此 Docker 不可用时也能保留它们。已有安装可独立运行，不需要 Git、Docker、源码 checkout 或 owner manifest：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --prepare-authorities --profile web --dsh-home "$HOME/.dsh"
```

输出的 `authorityRuntime` 包含 `$DSH_HOME/rsi-authority-runtimes/<profile>` 内独立 Node、官方 Control Plane CLI、运行模块及摘要。八个发布阶段各有独立程序文件，脚本固定使用私有 Node；不依赖 profile 后续替换的程序。只复制当前同版本安装包的文件，执行版本和模块加载检查，不执行 npm 安装脚本。再次准备会核验源包与已部署字节，版本或内容漂移会停止，不能用重装静默改换已固定的运行时。

`authorityResources` 包含 `$DSH_HOME/rsi-authorities/<profile>` 内 14 个独立 Ed25519 身份的公钥与私钥路径、安装/账本标识、私有 `file:` registry、catalog、配置及状态目录。私钥正文不出现在输出中。重复执行复用相同身份并保留已发布内容、catalog 条目及授权状态；缺失、损坏或权限漂移不会触发密钥重建或存储清空。失败只清理本次创建的目录；崩溃留下不完整目录时拒绝覆盖，需要先检查残留。独立的 `--prepare-authorities` 只准备资源；自动 `--install-owner` 后续才生成 owner 配置并启动服务。

新安装还会尝试准备离线构建镜像。当前完整仓库检查沿用已验证的 Linux x64、Docker Server `29.4.1/linux/amd64` 与嵌套 sandbox 配置；不满足这些前置条件时，安装器保留源码并报告 `buildUnavailable`，普通 Agent 安装继续，但不声称源码修复构建已经可用。实际镜像构建失败或已有资源不一致会停止安装。

支持的环境可单独运行严格构建准备：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --prepare-build --profile web --dsh-home "$HOME/.dsh"
```

输出中的 `sourceBuild` 可用于 Control Plane manifest。安装器还自动从同一不可变镜像导出原生 Node、pnpm、离线 store 和供应链策略缓存，输出 `releaseBuild` 可直接用于本地发布 adapter 的 `build` 配置；无需手填工具链路径和摘要。资源保存在 `$DSH_HOME/rsi-release-builds/<profile>`，回执固定所有文件内容与模式。导出只创建未启动的容器，复制固定路径后删除容器，不执行其中的源码。发布仍使用本机 `/usr/bin/bwrap` 和 `/usr/bin/tar`；`--optional-build` 在缺少这些前置条件时报告 `releaseBuildUnavailable`，保留已准备的源码验证镜像。实际复制、工具链版本校验或已有回执漂移失败仍会停止安装。配置使用不可变镜像 ID，并将私有回执与 seccomp 保存到 `$DSH_HOME/rsi-builds/<profile>`。重新执行会核对来源、构建输入与本地镜像；不会静默换镜像或重新构建丢失的已登记镜像。Docker 构建脚本、Dockerfile 与 seccomp 必须匹配安装包内登记的摘要，只把 lock、workspace 配置及包清单放入构建上下文；不复制源码、主机包缓存或凭据。首次镜像准备需要网络，随后候选构建离线运行。

自动配置沿用完整仓库检查的 30 分钟、16 GiB 内存、8 CPU、1024 PID、4 GiB 工作区和 2 GiB 临时目录上限；宿主需提供相应资源。嵌套 sandbox 的系统路径与 seccomp 边界见[构建镜像指南](../../../scripts/isolation/README.md#nested-sandbox-profile)。准备资源只完成安装前置步骤；`--install-owner` 会核对已安装 Host、owner 和最终配置后再应用。

目标先完成 [Lark 配对](setup.md)与 [supervised 安装](../../../scripts/install/README.md)，已有唯一 active owner DM。无需先激活固定 Recovery runbook；缺失的 owner route 在成对配置事务内生成，既有唯一精确路由（包括 `supervised-growth-owner`）沿用原 ID 和 minimum generation。路由冲突或重复会拒绝，不覆盖其他授权。新安装自动补齐目标依赖；旧安装若缺依赖，为目标补装同一构建的 Growth Driver、Goals、Skills、Verifier、Memory Learning 与 Control Plane。Memory 由 Personal Assistant 内嵌提供，不再添加独立 Memory bundle。开发版应使用本地构建的包；仅有相同版本号不能证明含有这些新增 API。

```sh
dsh plugin --profile web add \
  @dsh-enhanced/assistant-growth-driver \
  @dsh-enhanced/assistant-goals \
  @dsh-enhanced/assistant-skills \
  @dsh-enhanced/assistant-verifier \
  @dsh-enhanced/assistant-memory-learning \
  @dsh-enhanced/plugin-control-plane

dsh plugin --profile rsi-coordinator add \
  @dsh-enhanced/assistant-policy \
  @dsh-enhanced/assistant-automations \
  @dsh-enhanced/plugin-control-plane
```

自动安装从 DSH base 创建确定性命名的独立协调器 profile，并安装同版本 Policy、Automations、Control Plane；中断后的部分安装仅凭本次私有登记及停机状态修复。手动配置也须使用新的自定义 profile，勿从 `web` 模板复制：协调器不需要 Web 服务或第二个 Lark 入口。目标和协调器的 Policy/Automations 状态分开；协调器 Control Plane 的主库独立，专用采用连接按目标 trust 中的精确路径读取共享交接账本。

## 2. 准备一次性有限授权 manifest

manifest 是 owner 私有的 JSON（`chmod 600`），路径须 canonical，不含 symlink。它引用已存在的私有授权器配置、key、trust、catalog 和控制账本。配置器读取并验证这些文件，不生成授权或签名回执。

自动入口调用 `lib/rsi-bootstrap-manifest.js` 的 `createRsiBootstrapManifest`，从有效目标配置、真实 active owner DM、已准备资源及声明的插件/Host 文件范围生成完整 manifest；`lib/rsi-authority-config.js` 的 `compileRsiAuthorityConfigs` 生成 schema4 trust、五份有限授权、八个发布 adapter、公钥文件和 Host resolver/wrapper。安装器核对实际 DSH/Git/systemctl 与构建资源的 pins、最终 unit 属性，以及 Loader 条目的 observer 摘要；这些声明文件并非完整的传递性 JS 模块证明。默认模型继承原任务，已有显式 Growth 模型覆盖会保留。observer 不观察 Control Plane 自身，避免摘要自引用；Delivery、Growth Driver 与 Verifier 按最终生成的配置摘要观察，Lark 按原始 Loader 配置摘要观察；输入仍核对原始配置。安装器把 `!!js` 标量按 Loader 原始值处理，不执行该表达式。

`--install-owner` 在 home lifecycle lock 下调用 `prepareRsiOwnerConfiguration`，重新核对已准备的程序和身份，创建真实 Control Plane 账本和 observer 密钥，将配置写到私有目录，并执行 profile、授权和八阶段 adapter 配置预检。重复调用核对配置、密钥和 owner，保留已用账本与状态；重试复用原安装授权的起点及到期时间，不自动续期或增额。首次准备发现未登记的配置/账本则拒绝覆盖。`--local` 的 supervised 新安装固定源码 checkout 的已提交 HEAD，构建并保存独立 tarball；目标与协调器安装后都核对运行依赖闭包的文件清单和摘要。未提交修改不进入这批制品。安装接线已实现，真实普通任务闭环尚未验收。

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | `1` |
| `targetProfile` / `coordinatorProfile` | 已安装且不同的 profile 名 |
| `controlPlane` | 目标的完整 Control Plane config；必需 `sourceBuild`、`sourceJobs`、`sourceApprovals`、`sourceReleases`、`sourceReleaseExecution`、`sourceAdoptions.handoff`、`runtimeObserver`、`foregroundDeployments`、`taskObservations` |
| `growthDriver` | 完整 Growth config；`enabled: true`、`intervalMs: 0`、启用 `usageLearning` 与 durable `pluginSourceProposals`，绑定同一 owner/workspace/preset/repository |
| `sourceReviews` | 有限独立审查授权；owner 精确匹配当前 Delivery 记录，decisionRoot 与发布轨一致 |
| `memoryLearning` | 新自动安装必含 `{ learning, reviews, adoption, limits: { extractions, scans } }`；三份准确 owner 绑定的有限配置，旧手动 manifest 可省略以保留原行为。见下文。 |
| `coordinator` | `{ "budgetId": "rsi-adoption", "budgetAmount": 1, "timeoutMs": 900000 }`，按实际约束设置 |
| `limits` | 例如 `{ "periodMs": 86400000, "reviews": 5, "discovery": 1440, "source": 1440, "observations": 1440, "coordinator": 1440 }`；均为显式有限额度 |
| `serviceEnvironment` | 可选 `{ "target": { ... }, "coordinator": { ... } }`，显式替换两个服务的配置路径绑定；通常无需填写，见下文 |

具体配置契约见 [Control Plane](../../plugin-control-plane/README.md)、[Growth Driver](../../assistant-growth-driver/README.md)、[Verifier](../../assistant-verifier/README.md)。四份签名授权必须使用相同 owner、目标 ledger 与插件白名单，并与 trust 登记的公钥一致。采用授权绑定 executor、profile、handoff；观察授权绑定包名单和观察策略。所有授权须在有效期内。

### 普通任务的自动记忆学习

自动 manifest 为提取、独立审查、采用分别生成不同授权 ID，并绑定 Delivery 当前七字段 owner。默认各有 1,000 次生命周期 admission/mutation 上限，采用总内容上限 4,096,000 字节、记录 TTL 最多 30 天；提取队列最多 100 项、来源窗口 30 天。模型默认继承来源任务，单轮输入最多 65,536 字节、输出最多 2,048 token、期限 120 秒。只学习明确 owner 事实和可信客观结果绑定的经验。

`learning` 使用 [Memory Learning 配置](../../assistant-memory-learning/README.md)，`reviews` 写入 Verifier 的 `memoryReviews`，`adoption` 写入 Personal Assistant 内嵌的 `personalMemory.automaticLearning`。review/adoption 摘要从验证后的配置生成，跨 owner、摘要漂移或过期都会拒绝。三份 grant 和学习数据库均保持原期限、额度与已消耗状态，重复安装不续期、不清空历史；已有 owner manifest 缺此组不能靠重跑安装静默补签，仍需显式迁移。

原生调度的默认提取预算为每工作区每日 7 次，扫描预算为该扫描任务每日 1,440 次；每次 reservation 为 1。不同学习 job 共用工作区提取计数。Policy 按 scope/metric/period 共用计数，预算 ID 不隔离相同计数池；同 scope/metric/period 的其他工作区预算会拒绝，即使额度相同，避免静默共用；不覆盖额度。提取、审查、采用及调度规则均限定 owner/workspace，不开启 unbudgeted execution。

学习插件安装 patch 默认禁用且无配置。安装器核对其 profile-local 同批制品，并确认它与 Personal Assistant 解析同一物理 Memory provider；Memory 的 manifest、patch 与入口也进入声明文件 pins，这不是完整传递 JS 模块证明。配置器先验证整组配置，随后启用准确行；已启用行只允许完全相同的重试配置。最终 observer 同时核对 Personal Assistant 的 Policy/调度/Memory 配置、Verifier 及学习插件配置与服务实例。就绪使用本次 Host 的 PID/InvocationID 与 observer，扫描定义可复用原持久记录，但必须匹配 owner、executor、catalog、配置摘要与预算，不能用旧记录时间戳冒充失败或新激活。

这完成安装接线。临时 Home 的真实 DSH 配置导出和工程 fixture 不证明生产双 Host 已启动、真实模型学习效果或后续任务收益；这些仍按当前状态验收。

所有 owner 字段中的 `authorityId` 使用有效 Delivery 路由的 ID，即 `sourceJobs.ownerRouteId`。`sourceJobs.authorityId` 是源码作业的独立期限与额度标识，不能用作 owner 路由身份。

不填 Growth `provider/model` 和 Verifier `sourceReviews.model` 时继承来源任务的实际模型。需要固定修复或审查供应时显式配置；历史任务已冻结的模型不会跟随之后的会话切换。

配置器自动保存 trust 所选择的标准 adapter 配置路径：`DSH_SYSTEMD_HOST_ATTESTOR_CONFIG` 和 `DSH_RELEASE_{PR,REVIEW,MERGE,BUILD,SIGN,PUBLISH,REGISTRY_VERIFY,CATALOG_ADMISSION}_CONFIG`。首次配置从当前进程读取；之后优先复用 `$DSH_HOME/rsi-service-environments/<profile>.json`，重装服务或退出 shell 后无需重新 export。目标接收所选发布与 Host 路径，协调器只接收相同的 Host 路径。若要替换已有路径，可在 `serviceEnvironment` 明确给出两个映射；字段集合须与 trust 所选标准变量一致。引用的配置必须是当前用户私有、canonical、单链接普通文件，且位于 `profiles/` 之外。这里只保存配置路径，不复制 token、私钥或任意 shell 环境变量。

扫描、源码作业、观察与协调器使用 `subject` scope 的 `automation-runs` budget；模型复盘使用 `global` scope 汇总。Policy 按 scope、metric、period 计量，改 budget ID 不会隔离同一计数池。源码额度按每个原生 automation identity 计量，总作业数另由有限 `sourceJobs.maxSubmissions` 限制。空扫描也消耗配置额度；额度应覆盖所需扫描频率。已有同周期全局规则的额度必须兼容。配置器不会打开 `allowUnbudgetedExecution`。

## 自动安装与就绪判断

正常新装无需手填 manifest。`supervised` 安装完成模型、TraeX、Lark 与 doctor 后，调用当前 profile 内的 `dsh-rsi-setup --install-owner --profile <name> --dsh-home <absolute>`；本地源码安装再传 `--source-repository`。仅 Linux systemd user services 支持此入口。构建前置条件缺失，或旧的本地目录链接使必需包实体位于 profile 外时，返回 `{"mode":"not-ready",...}` 和退出码 3；旧链接在停服、创建协调器和签发授权前被拒绝。其他预检或部署失败也使安装命令非零退出，不显示“安装流程完成”。前序已安装的普通 Agent 与资源保留供修复后重试。

本地 supervised 新安装先运行 `--install-local-cohort`：在私有临时 checkout 中按冻结 lockfile 构建，将选定插件、协调器及其内部运行依赖打包到 `$DSH_HOME/rsi-local-cohorts/<profile>/`。bootstrap 构建复用本机 pnpm 缓存；这不是候选代码的隔离构建。冻结源码的 `allowBuilds` 布尔清单随 receipt 保存并在安装前合并，保留已有配置；同一依赖存在相反决定时停止，不自动扩大安装脚本权限。安装通过原生 DSH `plugin list/add` 完成，本地 supervised profile 使用 pnpm `nodeLinker: isolated`，防止 hoisted 布局把同版本 registry peer 混入本地运行依赖。依赖覆盖限定精确父包：运行依赖固定到本批制品；内部 peer 仅在其 provider 已属于当前 profile 的运行依赖闭包时固定到同一制品，不通过 peer 扩大安装集合。目标和协调器分别计算闭包，缺席的可选 peer 不自动安装。仅选定根包成为直接 bundle；每条内部运行依赖、已提供的 peer 和实际安装文件均须匹配制品，同名内部包必须解析到同一真实目录，防止同版本 npm/file 副本产生不同模块状态。重试复用 receipt 并核对原始提交、包选择与摘要，不自动改为新的 HEAD。构建发生在停服前；若后续包安装或文件核验失败，保留固定制品与覆盖配置，Host 保持停机，修复后以相同输入重试。若 pnpm 普通安装保留了缺失、已知文件内容不符或模块目录分裂的包，安装器会重验冻结制品和配置，再强制重装一次并核验结果。协调器的完整包名/版本不会掩盖文件缺失。额外文件、配置冲突及未知状态不会触发此自动修复；重验仍失败时保持停机，不自动删除用户的 profile。

既有冻结安装可重跑原 `--install-local-cohort` 命令修复同批 peer 解析；必须保持原 profile、源码路径和 bundle 选择。预检拒绝未知内部 override、改变的固定路径或制品；随后持生命周期锁停服，重新安装原 tarball 并核验，成功后恢复原服务。此修复不更新源码提交、冻结收据或业务状态；不是升级到当前开发 HEAD。

开发版提供本地更新候选的准备入口：

```sh
dsh-rsi-setup --prepare-local-update --profile web --dsh-home "$HOME/.dsh"
```

尚未安装 RSI owner 权限的旧冻结 profile 若缺少 Memory Learning，可在已审核并构建的 checkout 中显式追加 `--add-memory-learning`。它只允许这一根包扩展，生成独立 schema 2 候选；准备前后检查真实 pre-owner 权限与签名历史。后续 checkout 维护事务核验精确新增的默认 disabled、无 config 行及全部原配置，仍不启用 scheduler 或学习。原 schema 1 更新保持原 roots；已有 owner/coordinator 不支持这条扩展。具体命令与恢复边界见[安装器指南](../../../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护)。

它从既有冻结收据读取源码路径，固定上游已提交 HEAD 和当前修复分支；两条修复 ref 必须已对齐。可直接快进时复用提交，分叉时在私有新仓库合并；冲突会停止准备并保留原始分支。上游的精确包版本可以不同于已安装版本，未提交修改不进入候选。源码、tarball 及准备收据保存在 Home 同级的私有 `.dsh-rsi-local-updates-<home-hash>/` 内；相同原始制品、上游和修复提交会复用已核验的准备结果，变化则使用另一目录。准备期间上游、原始收据或已安装包变化时不返回成功。

更新构建先用已固定摘要的 manifest-only Docker 构建器准备依赖镜像，再导出独立 Node/pnpm/store/cache。候选的 build/pack 脚本在现有 release adapter 的离线 bubblewrap 环境内运行，只挂载构建副本、输出及只读工具链/依赖，不提供原 Home、原 Git 仓库、凭据或环境变量。此步骤需要与首次构建准备相同的 Linux x64、Docker 和 bubblewrap 支持；没有宿主机直接构建的回退路径。输出 `mode: prepared` 只表示源码和制品已准备，尚未迁移签名源码历史、构建/授权配置或切换服务；当前普通 upgrade 仍拒绝冻结本地安装。尚无 owner/coordinator 的安装可显式使用[本地 checkout 维护事务](../../../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护)；已配置 owner 的冻结安装尚不支持完整升级。激活须由停机事务重新核对当前状态，不能把准备收据当作激活授权。

安装事务可通过只读候选检查重新验证源提交、原安装、tarball、固定构建器和导出的工具链；它不会执行 Docker 或候选脚本，也不会补建丢失的资源。这里的构建资源检查证明本地记录和文件仍匹配，不证明 Docker 镜像当前可运行。源码维护 helper 在独立 Home 副本中导入新提交、更新受管 refs，并保留最初 bootstrap、Git 对象及 `baseline.initialCommit`；既有 Host 密钥签名的 `maintenance.json` 使后续源码读取和候选准备解析到新版本。Control Plane schema 28 将该维护记录与旧 release 收据一起校验，拒绝未结源码任务、断链、旧 tip 或不匹配的 Host 身份。它是完整升级事务的内部接口，尚未开放为直接替换运行中 Agent 的命令；协议边界见[兼容性说明](../../../docs/compatibility.md#本地源码维护历史control-plane-schema-28)。

内部激活准备已包含停服账本预检、维护签名生成和三类资源副本迁移。预检不会创建或迁移账本；非空 WAL/回滚日志、未结源码工作或冲突的部署观察须先在原 Host 对账。签名绑定原始与副本一致的部署及 readiness。资源迁移只重定位副本中的 tarball、构建器和发布工具链收据，并保留原安装与候选；替换或验证失败时尝试恢复副本原资源；已验证后的备份清理失败及进程崩溃由外层事务恢复或丢弃副本。成对包安装另由内部 `stageRsiLocalPairPackages` 处理：先核对两个 profile 的原制品文件、直接依赖、原生 Loader bundle 集合及固定 overrides，只替换原 cohort 拥有的精确依赖边；保留 profile 配置与注释，拒绝候选更改既有 build-script 决定或新增允许。两边安装和文件核验全部成功后才推进协调器登记，同版本源码更新也按制品字节核验。调用方须持有生命周期锁，并在隔离环境把可丢弃的已停写 Home 副本映射到原逻辑路径，准备相符的独立 pnpm store/cache；pnpm 会沿旧 `node_modules/.modules.yaml` 读取 store，且安装需要原 profile 的 lockfile 策略校验缓存和依赖包，仅复制源码构建缓存不足以离线安装。组件不自行建立这些边界，也不会放宽已有 lockfile 或脚本策略。安装中断或失败保留副本供外层恢复或丢弃，不宣称双方原子回滚。已配置 owner 的冻结安装仍需接入完整 owner 配置迁移、观察中的部署/回退证明、服务切换与崩溃恢复，因此这些成对内部组件不能当作升级成功。

尚未配置 owner 自动迭代的冻结安装另有显式内部 `maintenanceMode: 'pre-owner'`，不会因账本缺失自动启用。只读 `assertRsiPreOwnerInstallation` 核对原 Home/副本的初始授权资源、全部身份、bootstrap 与签名源码链，拒绝协调器、安装 journal、已配置 owner 或不明配置层；读取 Git 时禁用可选写锁。该模式保留初始身份与历史，以 `host:null` 签署连续维护记录，不创建控制账本。对应的 `stageRsiLocalSinglePackages` 只迁移单 profile，拒绝任何协调器残留，仍核验同版本的实际包字节。外层必须另外检查所有 profile 的有效插件图与真实启动参数，并负责停服、副本、切换和恢复；这些内部组件本身不负责服务切换。开发 checkout 已提供显式 `local-service-upgrade` / `local-service-recover`，复用 Home 锁、systemd 收容、完整 Home 副本及切换/恢复；预检的原生配置导出仅在私有副本运行，恢复前重验源码、安装模块和全部配置。激活预览使用额外可丢弃 Home 副本，其队列、数据库及会话写入不会进入正式安装。用法和未发布边界见[安装器指南](../../../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护)。

自动入口只收集已启用且可修复的 `@dsh-enhanced/*` 条目，核对同批包名、版本、patch、入口及声明的 Host 文件；最终 Delivery、Growth Driver、Verifier、Personal Assistant（含 Memory/Policy/调度）、Memory Learning 配置及原始 Lark Loader 配置都进入目标 observer。停机后临时加载最终计划的 systemd unit，以真实 `systemctl show` 捕获授权所需属性，再恢复原 unit；捕获期间不启动服务。随后成对应用 patch、环境绑定和 unit，先启动协调器再启动目标。就绪判断要求两个 PID、InvocationID 与重启计数连续 12 秒稳定，目标 observer 与实际进程和配置摘要一致，并读到本次启动后持久登记的、绑定当前 owner scope 的协调器原生 Automation。它证明这次部署的有限启动状态，不证明普通任务已产生候选、通过独立验收或完成采用/回滚。

崩溃留下的 `prepared` journal 会先在两个 Host 停机后回滚；若回滚确认成功，先恢复原来运行的服务，再继续新预检。应用前失败仅在原 patch、journal、unit 均可核对时恢复原服务；未知状态保持停机供对账。已应用后的启动或就绪失败保留 applied journal 和配置，供停止服务、排查后重试或显式回滚。自动重试沿用原有限授权起点、期限和额度。

自动安装和手动 `--apply` 都会检查两个 Host 的原 Automation 数据库，以及最终使用的数据库（协调器改用私有库）。关闭的 scheduler 将被开启、或启用另一数据库时，若原库或目标库存在 active 或 paused 定义，必须显式传入 `--ack-existing-automations`；没有固定 Recovery/Heartbeat 豁免；paused 也需确认，因为已有 Growth shadow/canary 作业仍可能被调度。数据库未知或检查失败会停止。自动入口停机后再核对同一库存；手动入口在写入前重查，发生变化即拒绝。该标志仅适用于 `--install-owner` 或 `--apply`，不续期授权、不重置次数，也不重放 unknown 动作。

## 3. 校验、应用、启动

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --manifest /private/owner/rsi.json
```

此手动 manifest 命令默认只读组合 profile、核对当前 owner 与有限授权，不修改 profile 或启动服务。`DSH_HOME` 可由环境变量或 `--dsh-home /absolute/path` 指定。

应用前停止两个 Host（包括手工启动的进程），并确认没有其他 writer。命令同时检查对应 systemd unit 处于 stopped 状态；系统服务状态不能证明手工进程已停止。

```sh
systemctl --user stop dsh-profile-web.service dsh-profile-rsi-coordinator.service
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --manifest /private/owner/rsi.json --apply --confirm-hosts-stopped --start
```

使用同一 DSH_HOME lifecycle lock；写入前重查 manifest、owner snapshot、两个原始 patch 以及服务绑定和 unit，保留有效配置中的其他字段与 `!!js`。成对写入后再次运行 `dsh --dump-config` 检查。存在受管服务环境时，同一事务保存两个绑定和 systemd unit，并执行 `daemon-reload`；schema4 Host grant 中的 `template.unitProperties.Environment` 必须与目标 unit 的实际 `systemctl show` 输出一致，否则自动恢复。准备 grant 时应使用最终计划的服务环境。`--start` 复用已有常驻服务安装器，先启动协调器，再启动目标；省略该参数仍保存并加载服务定义，但不启动服务。

## 恢复与停止

配置 journal 存在 `DSH_HOME/.rsi-setup-journal.json`，为私有文件，含上次变更前后的两个 patch。新 schema2 还保存两个环境绑定和 unit 的原始及新内容，原先不存在的文件回滚时删除；仍支持旧 schema1 journal。写入、最终组合或服务环境读回失败时自动恢复；崩溃留下 prepared journal 时先执行回滚。重复应用相同配置不会覆盖原回滚点。只有最近一次变更可由此入口恢复。

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --manifest /private/owner/rsi.json --rollback --confirm-hosts-stopped
```

回滚前仍须停止两个 Host。恢复不要求前向授权仍未过期；若任一 patch、服务绑定或 unit 被外部改过，会保留 journal 并在恢复任何文件前拒绝覆盖。服务启动失败时保留已应用配置，先排查/停止服务再决定恢复，避免改写活跃 Host。受管升级会同时校验绑定、unit 与有效环境，并在复制、切换和恢复时检查绑定内容未漂移。

成功采用后的同版本 Host 重启会自动申请新的运行实例证明，使用现有协调器的每分钟调度，无需用户逐次配置。签署和应用前的会话仍可执行，但这些任务不计入部署效果归因；新证明通过后恢复后续任务观察。旧签名、原授权期限和 reload 累计次数保持不变。见 [运行实例证明](../../../docs/systemd-host-attestor.md#runtime-continuity-after-restart)。

暂停自迭代可停止协调器及目标的相关 Automations，或撤销有限授权；重启不重置额度，也不重放 unknown 外部动作。授权续期需要新的合法授权标识与配置。配置 journal 恢复 profile 及上述服务配置；已发布或已采用能力的回退仍由 Control Plane 的签名恢复链负责。

此 CLI 读取 owner 数据库与私有配置；默认检查也会使用本地 lifecycle 锁和临时 WAL 快照，但不改变 profile 或业务状态。显式应用写两个 profile patch、受管服务绑定/unit 和 journal；校验会执行本地 `dsh --dump-config`、`systemctl show`，服务定义变更会执行 `daemon-reload`，显式启动会安装/启用/restart 用户级服务。它不向其他人发送消息。原始授权、私钥、数据库、journal 与运行日志留本地，不提交 GitHub。

## 使用普通任务资格合同

可按[有限试用采用指南](../../../docs/bounded-live-adoption.md)配置 `sourceAdoptions.liveQualification` 与 `controlPlane.liveQualification`，并设置 `limits.qualification` 和独立预算 ID。配置器核对第五份独立签名授权及公钥，生成资格扫描的原生 Policy/Automations 规则。该模式以限时真实 owner 任务替代严格 replay/shadow 等验收合同，不声称这些严格阶段已通过；已有未配置此模式的 manifest 保持原行为。实际部署端到端验收仍见当前状态。

Host 可通过 [systemd schema4](../../../docs/systemd-host-attestor.md#automatic-authorization-within-an-installation-grant) 自动解析已批准操作的逐次授权。配置器核对 `sourceAdoptions.hostDeploymentInputs` 与采用授权的同名列表；当 trust 选择 `DSH_SYSTEMD_HOST_ATTESTOR_CONFIG` 时，还读取已解析的服务绑定所指向的私有配置，预检 schema4 wrapper、resolver/config 摘要、固定解释器及 Host 签名身份，并核对 owner、ledger、目标 profile、协调器 handoff 和有限试用条款。预检仅执行已固定 attestor 的版本查询和已选官方 resolver 的语法检查，不签发逐次授权或重启服务。Host 授权配置与原始/候选 observer 仍须预先准备，配置器不会生成它们；路径的持久传递由上述服务绑定负责。预检通过不等于实际 reload/readiness 已验收。
