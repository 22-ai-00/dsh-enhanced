# RSI 当前状态

更新：2026-09-27。此页是当前进展与剩余验收的唯一入口；历史流水保留在 Git 历史，配置以各插件 README 为准。

## 项目方向

构建利用 DSH 原生 AgentLoop 与 Cordis 组合、注入、资源归属和重载能力的自我迭代工具/插件智能体。模型是可替换供应；自我修复/迭代默认继承用户会话或来源任务的实际模型，可显式配置固定模型覆盖，`super-relay / auto_model/alwaysday1` 是可用供应之一。每轮固定供应、预算与验收标准，持久修复记录解析后的选路供恢复使用，保留身份、任务历史和能力版本。

闭环为：任务反馈 → 技能/工具/插件候选 → 独立验证 → 有限推广 → 新任务复用 → 观察与回滚。验收和留出集须在候选写权限之外。研究依据见[自迭代原则](research-dsh-plugin-self-iteration-2026-09-19.md)，开发约束见 [AGENTS.md](../AGENTS.md)。

**当前开发目标：让 Agent 在用户日常使用中自我修复、自我迭代。** 一次配置与授权后，正常会话中的失败、纠正、重复任务及后续结果应自动进入持久成长流程，由 Agent 在既有授权和预算内形成、验证、采用改进，并观察和回滚；用户无需逐次调用捕获、修复或比较工具。固定场景仅用于必要回归，不再以反复手动运行模型探针作为开发主线。

## 当前交付边界

- 新用户安装简化已实现：检测本机 `traex` / `trae-cli` 后自动安装并启用，保留显式模型、命令和工作目录；精确登录检查通过且没有显式选择时，只为目标 profile 设置默认模型。未登录或 `--model skip` 仍启用插件；失败仅恢复目标 profile。支持 pnpm 嵌套依赖布局。Lark 首次 owner 默认开放已安装工具能力，已有应用/owner 保留权限，显式关闭不因重装恢复。整仓检查通过，真实 DSH dump-config 已验证启用状态和配置保留；未执行真实 TraeX ACP 请求、飞书平台授权或生产 npm 安装。Host 已默认 Full access；这不等同于已取得全部飞书平台权限或完成成长授权。
- supervised 新安装自动补齐 Skills、Verifier 与 Growth Driver，并在飞书配置前准备私有源码工作区和本地 bare 发布仓库。npm 固定取本次 CLI 版本的官方 tag，本地安装只取已提交 HEAD；重复执行保留已推进的修复基准，原开发工作区不变。该步骤移除手动建仓库配置。满足当前 Linux x64/Docker 29.4.1 条件时，安装器还会自动构建离线镜像并保存不可变 image ID 与 `sourceBuild` 配置，重装核对后复用；同时从该镜像导出独立固定的原生 Node/pnpm、离线 store 与策略缓存，返回发布 adapter 可直接使用的 `releaseBuild`；重复安装拒绝资源漂移。前置条件缺失会明确报告构建未就绪，实际构建失败会停止。真实仓库发布构建发现并修复缺少策略缓存、`/bin/sh`、工作区依赖预编译以及 pnpm 转换依赖 map 顺序不稳定四个阻断；依赖值、条件 exports 顺序、其他文件内容与 tar 元数据保持原样，仍要求两次完整制品一致。正式发布适配器已消费安装器生成的配置，在真实提交上完成两次独立离线构建，制品摘要与签名回执一致，独立复核通过；前轮冻结源码的整仓检查已通过。owner-bound 授权与 manifest 的生成/准备接口已接入 Linux supervised 安装末尾，自动取得 owner、准备协调器、成对应用并启动双 Host。构建资源或包实体预检未就绪时返回退出码 3；本地 supervised 新安装已改为冻结 HEAD 构建 tarball，目标与协调器均核对内部运行依赖闭包及安装文件；旧目录链接仍在停服与签授权前报告未就绪。真实 24 包构建及原生 DSH 安装已通过；安装器自动使用 isolated 布局、沿用冻结源码的安装脚本清单，避免同版本 registry 包混入。缺失文件的一次自动强制重装与配置加载已通过，整仓检查已通过。真实正向部署及完整普通使用闭环尚未完成。配置与独立命令见 [RSI 安装指南](../plugins/lark-channel/docs/rsi-setup.md)。
- 飞书向导默认接入官方业务 CLI：应用采用智能体权限模板，复用契约兼容 CLI 或校验下载官方 latest，安装时为绑定 owner 申请 `--domain all` 用户授权；由 DSH 原生技能按需读取 CLI 内嵌能力说明。身份同时核对本地验证状态与服务端 user_info，重复安装复用有效授权；更换 owner/app/account 或显式关闭时先撤旧技能。真实 Linux CLI 1.0.96 下载、离线复用与原生技能加载已验证；平台授权和真实业务操作尚未执行，不能宣称租户全部权限已开通。macOS/Windows 尚未实机验证，系统钥匙环与同一 DSH_HOME 的用户技能目录不构成独立凭据隔离。
- Linux 安装现在自动准备私有授权运行时与本地发布存储，也提供 `--prepare-authorities` 独立入口：复制同版本官方 Control Plane CLI/模块和独立 Node，为八个发布阶段准备独立程序文件，并生成 14 个独立 Ed25519 身份、安装/账本标识及本地 file registry/catalog。重复执行严格核对固定字节和密钥，保留发布内容、catalog、状态与配置；缺失或漂移拒绝覆盖。实际副本在含特殊字符的路径下通过模块加载，删除源包后仍可执行；真实 trust loader 接受独立程序 pins，并拒绝共用路径。独立资源命令只准备资源，不签发 owner grant 或启动 Host。后续内部生成接口可由当前 owner 与真实部署输入生成完整 manifest、五份有限授权、八阶段配置及 schema4 Host 配置；准备器创建真实账本与 observer 密钥，并通过生产 profile/授权/adapter 预检。重复输入保留已用状态，首次准备不接管未登记的账本；自动 owner 安装已调用这些资源，真实正向部署及普通使用闭环尚未验收。
- 双 Host 配置器现将 trust 选用的九项标准发布/Host 配置路径持久保存到私有绑定文件，成对写入 systemd unit；重装复用绑定，不依赖后续 shell。目标和协调器配置、绑定与 unit 共用可回滚 journal，schema4 授权核对实际加载的 Environment。service-aware 升级同时检查绑定、精确 unit 和有效环境，在复制、切换及恢复时拒绝漂移。真实 systemd 小型进程已验证含特殊字符的九项路径在启动、重渲染及重启后保持，并验证生产环境读回函数的匹配/不匹配行为；自动安装已接入 owner-bound manifest、停机状态下真实 systemd 属性捕获及成对部署；该探针不代表实际 Agent 或普通反馈闭环。用法见 [RSI 安装指南](../plugins/lark-channel/docs/rsi-setup.md)。
- 按用户确认跟随官方 npm `latest`，当前验证基线为 DSH `0.1.5-rc.3`；registry 尚无正式 `0.1.7`，`0.1.7-rc.2` 属于 next。测试依赖保持精确版本以复现结果，新装默认 selector 将跟随 latest 并验证兼容范围，已有兼容 Host 保持复用。`update --all` 尚不更新 DSH Host，后续须补齐受管 Host 更新事务。原生 Agent setup、Inbox、PTC 审计事件、系统提示和会话句柄 API 已迁移，完整 `pnpm check` 退出 0。真实 latest CLI 的三进程会话写入、未知事件拒绝和冷读恢复，以及 systemd reload/readiness/物理 restore 探针已通过；这些兼容性结果不代表生产自迭代闭环或 npm 发布门槛已完成。
- 已修复本地自动发布的 trust/runner 契约冲突：schema4 trust 现在可加载 owner 私有的 canonical `file:` registry，普通源码发布可进入既有八阶段；HTTPS/npm 配置保持原行为。回归从真实私有 trust 文件加载，再进入签名与持久发布状态；外部 adapter 执行仍为测试替身。Host schema4 安装预检已补齐 wrapper、resolver 和授权绑定；整仓检查与独立复核通过，完整安装与实际部署闭环仍未完成。
- 普通反馈→持久复盘→源码候选→发布/采用协调已有接线，`dsh-rsi-setup` 已实现。已提供可选[有限试用采用合同](bounded-live-adoption.md)：独立源码审核及 reload/readiness 后，使用精确部署下的普通任务反馈签发资格，最终提交同时重验原失败来源与资格反馈；负向或失效证据进入原有物理回退。窗口约束决定与回退请求，不保证物理恢复时限；整个 profile 会暴露候选，同 UID 不是 OS 隔离。双 Host 配置器校验第五个签发器与第六份预算，完整工程检查与独立源码复核通过，真实部署闭环尚未验收。缺省严格合同保持原独立行为阶段；现有 systemd attestor 不能签发全局 `externalEffects=0`，新合同也不作此声明。

- 已接入自动 Host 授权：schema25 在暴露部署前保存批准输入及原始文件记录，systemd v6 的 schema4 包装层调用独立有限授权器，从 claimed 操作自动生成 reload/readiness/rollback 配置，避免每次更新人工填写摘要。候选与原始 Host 分别固定 observer；静态配置继续兼容。首次安装已准备源码仓库，并可在支持的 Docker 环境自动准备离线构建镜像；私有签名程序、身份与发布存储已自动准备；owner-bound 配置生成、独立协调器及安装器自动调用已接入；受管 Host 跟随 latest 更新仍待补齐。
- 本地发布后的连续源码基线已接入可选 [`sourceJobs.baseline`](../plugins/plugin-control-plane/README.md#持久源码检查任务可选)：完整发布的已应用签名合并链决定下一次读取、入队和构建的基准，专用 Git ref 可从账本恢复，旧候选和并行发布被拒绝。主工作区和关联 worktree 的 HEAD、索引与文件保持原状；外部同 UID 并发改写 Git 不构成原子隔离。真实 Git、SQLite 和签名的两轮发布后重开账本、下一作业入队已通过工程测试；发布执行器与调度器仍为替身。安装器已准备仓库与初始提交 pin，并把 baseline 写入自动生成的完整 manifest；未知合并结果仍需对账，不代表已实现无人配置的生产持续迭代。
- 双 Host 配置器修复了 owner 路由与源码作业授权 ID 的混用：审核与签名授权中的 owner 使用真实 Delivery route，源码作业的独立额度标识保持不变。生成配置接入真实 Verifier 的有效 owner、错误作业 ID 和 owner 版本变更准入检查已通过，独立复核通过；不是实际模型审核或生产采用验收。
- 即时审批沿用已发布能力：Policy 的 `auto` 对非凭据本地只读与单个命名 Skill 加载直接继续，显式 `ask` 仍询问；Lark 使用 CardKit callback，`format_error` 时降级为同一 owner 私聊的精确文字允许/拒绝。Auto 来源判定也已修复：当前 format 3 中残留 `auto` 选择不能授权后来切换的 full-access 自动审核；独立复核与 Policy 定向测试通过。
- `dsh-rsi` 已提供安装、升级、状态/doctor、服务 start/stop/restart、日志查看与彻底卸载。上一轮修复了 DSH `profiles/node_modules` 被误识别为 profile、未注册服务指向不可用全局 `dsh-rsi-setup`、npm/pnpm 重复提示刷屏，以及 supervised 新装漏选 Goals 导致 Recovery 等待 `assistantGoals` 的运行时失败。降噪只使用 npm global location 与 pnpm error log level；真实 package-manager 错误仍保留并非零退出。
- `dsh-rsi update --all` 部署闭环修复已完成：自升级固定写回当前 CLI 的真实 npm prefix；profile 升级使用同一精确版本 tag；Linux 已注册受管服务的精确 systemd MainPID 由 service-aware lifecycle 接管（`update --all` 只阻止非受管 Host，受管服务 MainPID 交给 lifecycle 事务），只有额外手工/测试 Host 才阻止升级；受管服务 stop 后对失败单元执行 `reset-failed`，masked unit 的 raw 状态改用不含 `ExecStart` 的 `SYSTEMD_RUNTIME_PROPERTIES` 读取。真实 Linux 部署验收（2026-09-25）通过公开路径完成：旧 profile 经 `dsh-rsi purge --profile web --yes` 正式清除后，`dsh-rsi install --scenario lark --lark skip --local` 干净重装，`dsh-profile-web.service` active/running/MainPID>0，web 端点响应，profile 下全部 @dsh-enhanced/* 包统一为 0.1.46，active 事务目录已清理（仅保留 lifecycle 重命名的 failed evidence 目录）。升级前的同 UID 进程扫描对 non-dumpable 会话基础设施严格证明后放行：root sshd 认证会话（comm=`sshd`、父进程 uid=0 且父 comm=`sshd`）与 systemd --user 的 `(sd-pam)` PAM 辅助进程（comm=`(sd-pam)`、父 comm=`systemd` 且父 Uid 为当前用户）的 environ/cwd/root/fd/maps 返回 EACCES/EPERM 时不再误拦；证明按进程惰性缓存，普通不可读同 UID 进程仍 fail-closed，已证明会话若可读 cmdline/cwd/fd/maps 真实引用 DSH_HOME 仍阻止升级。CLI 补传静止确认并从 effective/composed profile 识别场景。macOS 已停止 Home 的 Lark/supervised profile 会先完整备份再升级，组合或真实激活失败时恢复原 profile；旧 Recovery profile 缺失 `assistant-goals` 时自动补齐。
- 当前 npm 发布基线以发布账本的 `current` 为准；后续 dev 开发及 `pending` 不等于已发布。安装器和 Host 兼容范围见[兼容性说明](compatibility.md)与[发布账本](../release-manifest.json)。
- 下一版 npm 的发布门槛是：安装部署后，在既有授权内由真实使用持续驱动修复、验证、采用与观察/回滚，并通过完整发布检查。用户已同意达到该门槛后重新发布；当前中间能力尚不满足条件。
- 日常使用中的工具/插件自迭代尚未贯通。普通 Lark 已有低风险偏好自动学习；Growth `usageLearning` 已可根据可信前台任务结果自动调度持久复盘；内置 Delivery 普通对话的已认证 owner 反馈也可触发，无需预设任务验收 profile；启用源码轨时，可信失败会自动形成 owner 私有修复缺口并进入源码候选工具，可经有限源码审批；精确制品的有限采用已接到同一持久作业，后续普通任务版本归因已接入可选 Host 配置；有限可信反馈批次、观察签发与自动回退已接通，配置已可编译，真实部署端到端仍待验收。Skills 有限修复链仍需对精确来源 Goal 手动 `skill_repair_arm`；既有授权下的独立验证、采用及持续观察仍待接通。
- 成长与修复的模型默认继承来源，可配置固定覆盖。Delivery schema 23 为普通 owner 前台任务单独保存执行回执，在 DSH 最终 `request/header` 保存来源实际 provider/model/effort，包括 adapter 默认值；用户随后切换模型不改变历史任务。旧任务无快照或同任务多模型时不猜测。自动 Growth 作业保存该快照，queued 可恢复，已派发但中断的任务保持 unknown、不重放；Skills 沿用其修复授权中的冻结选择。
- Evaluation 的可信 canonical feed 包含纠正/撤回；Delivery 核对精确 owner 身份与原始任务，支持 `/new` 后读取旧任务并拒绝身份换代继承。Growth 在 writer fence 内落游标/意图，复用 Automations 扫描、调度和预算；每次模型/工具调用重查来源，排除后台结果递归触发。Control Plane schema 25 保留精确 owner/canonical 来源引用和 source release→activation 绑定，自动源码轨只读取本次缺口，检查与最终计划提交重验来源；`/new` 改变完整 owner receipt 后停止旧工作。普通对话可直接回复实际结果提交明确自然反馈，仍保留 typed `/feedback`；自然回复继续进入 Agent，Evaluation 暂不可用时保存待补记意图，不假称已完成投影。unknown/未停止执行不能被反馈改判。旧普通任务不回填；此新增入口覆盖内置外部渠道运行时，尚不覆盖原生 Web 或自定义运行时。模型结束或工具退出本身不构成学习依据。
- Delivery schema 24 为明确自然任务反馈增加持久日志：初评、更正和撤回固定原始 Inbox/Outbox、owner、入站顺序与版本条件；恢复只补记反馈，不重跑用户模型。Growth 通过当前 canonical owner 操作身份取得有界纠正原因，同值重复不替换原证据；旧复盘随更正/撤回失效。该入口只覆盖内置外部渠道的普通前台结果，Automation、whole-goal 和原生 Web 仍走各自原入口。此能力不补足下述独立行为观测和自动采用部署缺口。
- 基本 RSI 已在限定任务族跑通真实修复、独立比较、后续任务 canary、两轮晋升与安全检查点恢复。它不证明任意任务都能自我改进，也不允许重放未结算的模型或外部调用。
- Day1 已经通过原生 Agent/Growth Driver 提交源码修复候选，独立 Host 作业完成离线仓库检查并形成待审批计划；其中 personal-memory 修复经开发复核整合。待审批提案不等于自主发布或生产启用。
- Control Plane 已有 npm 发布/独立读回/catalog adapter，以及 systemd reload、readiness、物理 rollback 的签名与持久操作组件。Host 派发在外部调用前落持久 claim，执行期间释放控制面写锁；结果未知时不重复调用，精确签名回执可对账，未结算前阻止同计划回退与恢复文件清理。认证有限回放端点支持晚到 Ed25519 授权：readiness 落账后，将真实 schema-2 请求交给同一 DSH CLI `0.1.5-rc.2` Host 执行，保持 PID/InvocationID、候选 Fiber 与部署文件不变。完成态重启失效，SIGKILL 中断后保留 unknown；同 scope 换 operation 或重新签发 grant 不能恢复派发权限。其输出不证明全局 `externalEffects = 0`，不能代替独立签名。
- Host request schema 2 的普通部署阶段固定同一 activation/fence 下前一阶段的完整签名回执摘要与 generation，并在 dispatch、apply 时复核；普通阶段不能换代。历史 systemd attestor v5 已通过真实 reload/readiness 与物理 restore 探针；本轮 v6/schema4 的证据为工程集成测试，未重做该真实 Host 探针。旧 schema-1 已应用历史可作为前驱，未完成操作必须先用原兼容版本对账；此改动仍不提供独立副作用观测。
- Skills 已接入同进程 Host 受限委派：来源重新验证后，将冻结的活动技能或 pending 候选临时挂载到全新 owner scope，经原生 `skill_run` 执行；持久 cell reservation 与调用记录阻止换调用键或重启重放。来源和接收方重载、撤权、到期及取消均保留失败或 unknown。Evaluation 原生模型 cell 与冻结后独立任务已接入，12-cell Docker 工程验证两臂各 6 次达成，候选实际复用 6 次、质量平局。Day1 同预算收益比较仍待完成；见[接线指南](native-skill-reuse.md)。
- 普通 owner 失败源码候选可经部署时配置的有限审批器自动批准：精确源码、owner、期限与累计额度受约束，最终提交复查当前反馈，持久作业通过原生 Automations 恢复审批。审批本身不发布或启用候选；后续采用见下，有限 taskObservations 已接通，但配置已可编译，真实部署端到端仍待验收。
- 已检查源码的后续恢复接入原生每分钟 Automations：每轮最多一个当前有效作业，预算同时覆盖源码检查与恢复轮次。临时失败无须重启 Host，启动也不直接调用授权器；候选不重建、unknown 外部动作不重派，过期/撤回停止前向推进，已暴露版本保留恢复义务。队列空时暂停，新作业重新激活；仍需补齐上述部署接线。
- 修复候选可显式启用 Host 补丁版本管理：从基准 Git 提交生成 package/runtime 版本，在冻结检查树前纳入构建与审批；有限审批器须单独授权并核对其余 manifest 字段不变。相同基准仍会产生相同版本，自动采用还须串行推进获准源码，不能覆盖 registry/catalog 中的既有版本。
- 普通 owner 修复获批后，可用独立的有限本地发布授权自动进入既有 `awaiting-pr`：Host 重查源码，外部签名器固定版本、registry/catalog、配额和有效期，最终提交再次检查当前反馈。持久作业重启可接续审批/授权及未完成发布，不重建源码候选或重复签发；可显式启用 Host 自动推进八个既有本地 release 阶段；可另配 Verifier 有限源码审查：从精确 bare Git PR 读取补丁，用全新无工具原生 Agent 生成 decision，再接续既有签名阶段。默认模型继承来源任务，可固定 override；未知调用不重派，终态可恢复同一 decision。schema 18 发布派发前持久 claim，精确签名回执可对账。精确制品启用已接续，有限 taskObservations 已接通，但配置已可编译，真实部署端到端仍待验收。
- Control Plane 使用后的签名退化/撤回已接入原有物理回退：成功启用保留上一版，核对当前版和备份核心文件，恢复后须由 Host 签名确认旧版就绪或停服；支持 rename 中断与回执丢失恢复，拒绝覆盖较新的部署。schema 17 保留部署顺序与安装摘要，旧记录不补造恢复能力。普通前台任务版本归因已接入；有限 taskObservations 已接通，安装配置与真实部署端到端仍待验收。
- 后续普通 owner 任务已接入可选部署归因：Control Plane schema 20 在任务开始/完成时复用同一 Cordis observer，对照已签名 readiness 保留观测，固定当前源码采用的 package/version/integrity 与 Fiber 代次。重载、旧任务、owner 换代或执行未知不计有效观察；Delivery schema/source digest 不变。该记录不证明工具调用或因果退化；schema 21 的有限当前反馈批次、签名观察与物理回退已接通，日常使用配置已可编译，真实部署端到端仍待验收。

- 跨 Host 源码采用支持有限签名交接：`dossier.handoff` 由既有审批签名覆盖，schema 23 保存不可续期的目标授权。外部协调器复用原生 Automations 与部署引擎，仅推进至 `commit-pending`；目标恢复后重验当前反馈并最终启用。撤回/过期保留物理回退，Host 卸载保留交接，unknown 派发不重派。目标离线时仅能保证有限授权窗口，回退完成仍依赖运行中的协调器与签名服务；可选有限试用合同已接线，真实部署尚未验收；严格合同仍需独立行为签名。

- 原生调度预算已补齐：Growth 使用反馈扫描必填 `usageLearning.scanBudgetId/scanBudgetAmount`，采用协调器和任务观察必填 `budgetId/budgetAmount`。三者通过 Automations 的原有 Policy 预留执行，空队列扫描也消耗额度；模型复盘继续使用顶层预算，部署通过扫描的 `subject` scope 与复盘的 `workspace/global` scope 分开额度（仅换 budget id 不会分池）。此前无预算定义会被默认 Host runner 拒绝，升级须补齐配置。耗尽协调器或观察预算也会暂停自动恢复，不提供无预算旁路。

- 完整 RSI 目标尚未完成。组件测试、历史局部真实运行和 fixture 不能合并推导为 WP16/WP18 的生产端到端验收。

真实同预算收益仍未验收；历史 Day1 unknown 保持原判、不重放，未知用量不计零。固定模型探针不再作为开发主线，后续优先完成日常使用中的验证、采用和观察能力。

## 工作包验收

以下保留原始 18 项成功条件，不因文档清理缩小目标。“已验收”沿用已提交的限定范围验收结论；此次文档整理没有重新运行所有历史真实模型实验。工程全检也不替代工作包级验收。

| 工作包 | 成功条件 | 当前状态与边界 |
| --- | --- | --- |
| WP01 | Canary 只消费 Evaluation 的 canonical 最新投影；promotion 提交时持有 writer fence，并绑定任务版本、digest 与 scope watermark。纠正、并发纠正、重启都不能复用旧成功。 | **已验收（原范围）**。Evaluation canonical 投影、writer fence 与修订测试。 |
| WP02 | Delivery 提供 owner 对任务结果的查询、更正和撤回；Evaluation 保留历史但每任务只计算当前一票，变化传播到成长消费者和已推广版本。 | **已验收（原范围）**。Delivery owner 反馈、Evaluation 修订和撤票传播。 |
| WP03 | 冻结不可变 TaskAcceptanceContract；由独立 verifier 对代码行为、文档引用或目标系统状态验收，并接入前台与 Automation。退出码或模型自评不能代替目标达成，无法确认时保持 unknown。 | **已验收（原范围）**。Verifier/Goals/Isolation 独立任务契约。 |
| WP04 | 固定任务集、独立留出集、可重跑 baseline runner 与版本化结果；同模型同预算记录成功率、成本、延迟、返工、分布和消融，留出不参与候选生成。 | **实现中，未完成验收**。已有固定 runner 与配对比较；任务广度、真实同预算收益与消融仍待验收。 |
| WP05 | 业务目标 bundle 保存成功条件、期限、依赖、预算、授权、假设、阻塞、唤醒与证据，并把原生 goal/session/run 合成唯一执行闭环；跨会话/重启完成且不重复外部提交。 | **实现中，未完成验收**。原生 Goals、持久上下文与恢复已接线；完整长期业务目标验收仍待补齐。 |
| WP06 | 按任务难度选择直接执行、调查、实验、独立复核、候选比较或原生 subagent；区分工具故障与推理失败，记录协调成本，并以固定预算证明策略收益。 | **实现中，未完成验收**。原生 subagent 与策略预算已接线；真实策略收益及协调成本比较仍待补齐。 |
| WP07 | Memory 围绕当前 goal/step/query 检索，保留来源、适用条件、反例、失效条件和冲突；工具证据压缩可追溯，状态变化时重查，并证明召回改善决策。 | **实现中，未完成验收**。任务检索、来源和版本化索引已实现；真实决策收益与长期冲突处理仍待验收。 |
| WP08 | Policy 能表达长期能力包和短期 lease，约束资源、动作、目的地、敏感度、期限、次数、费用与撤销；提交绑定 digest、前置版本和幂等键，常规授权内不逐动作审批。 | **实现中，未完成验收**。Policy、lease、动作准入已有实现；完整业务授权维度和真实撤权闭环仍待验收。 |
| WP09 | 独立动作/凭据 broker 与隔离 worker 至少支持一个生产平台；worker 任意代码不能读取 token/信任根或绕过网络/动作代理，崩溃恢复不重复提交。 | **实现中，未完成验收**。Actions 外部 broker 与隔离 worker 已有组件；真实独立身份部署及生产平台闭环仍待验收。 |
| WP10 | 提供外部停止、worker 不可覆写审计、版本回滚和不可逆动作补偿；终止 worker、撤 lease/凭据/出口，并为部分失败保存明确结果。 | **实现中，未完成验收**。停止、审计、补偿和恢复已有组件；跨边界部分失败的完整外部验收仍待补齐。 |
| WP11 | 统一 event envelope 并关联目标；至少接入代码库与任务/日历两个真实来源。来源、版本、时间、可信度、去重、授权可追溯，乱序/重复不重复动作，目标完成后退订。 | **实现中，未完成验收**。事件去重、目标关联和恢复已接线；代码库及任务/日历两个真实来源的完整验收仍待补齐。 |
| WP12 | 对机会做可解释排序，并支持静默准备、提醒和预授权执行；落实静默时段、合并、拒绝冷却、每目标预算，交付前验证功能/指标/安全，交付后持续观察采纳、漏报、打扰与收益。 | **实现中，未完成验收**。机会筛选、提醒、预算与冷却已有实现；真实采纳、漏报、打扰及长期收益仍待评测。 |
| WP13 | typed workflow/skill 描述输入、前置条件、依赖、参数、工具、验收和失败补偿；从失败及重复轨迹生成候选，覆盖至少 3–5 类真实高频流程，并绑定父版、原因、指标、权限差异和回滚目标。 | **实现中，未完成验收**。版本化技能/工作流、比较与回退已接线；3–5 类真实高频流程覆盖仍待补齐。 |
| WP14 | 对历史输入真实重放 baseline/candidate，以独立质量验收完成 shadow、密封留出、同预算比较、有限 canary 和自动晋升；独立验证、收益、回归三个 gate 必须同时通过。 | **已验收（原范围）**。限定 template-render 任务族的真实 TraeX 比较、独立留出和有限 canary 已验收；不等于通用流程收益。 |
| WP15 | 对推广后的 guidance/workflow/skill/plugin deployment cohort 持续监控；exact 版本退化自动关闭或回滚，撤票触发回滚，新增正向证据不误撤，重启后继续观察。 | **已验收（原范围）**。guidance/skill/workflow/plugin 四类工程验收；生产长期质量分布属于后续强化。 |
| WP16 | 沿 Control Plane 提供真实发布/启用 adapter：构建、签名、不可变版本、有限实验生命周期/存储、发布、验签、启用、监测和回滚；隐藏评测不可被候选读取或修改。 | **实现中，未完成验收**。已有 npm adapter、systemd reload/readiness/rollback、原生阻断回放；独立副作用观测、签名、后续有限推广及真实授权发布全链仍待完成。 |
| WP17 | 提供一致的自治安装入口、依赖预检、模型/预算引导、隔离 bootstrap、doctor、升级和卸载；全新临时 profile 能完成示例目标，重复安装幂等并保留配置和既有任务。 | **已验收（原范围）**。新 profile、示例 Goal、依赖修复和重复安装已验收；更多平台/升级卸载组合属于后续强化。 |
| WP18 | 完整仓库维护纵向切片：一次授权→真实 CI/issue→目标→隔离修复→独立验证→授权分支直接提交→精确提交 CI/readback→技能复用；真实模型/仓库/授权系统端到端，同类任务同预算改善，停止和回滚有效。 | **实现中，未完成验收**。已有真实模型修复、隔离检查与待审批提案；真实仓库事件→授权分支提交→精确 CI/readback→同预算技能复用全链仍待验收。 |

WP14 的独立性证据限定于 after-freeze 任务生成与绑定，不证明模型训练数据独立或完整 OS 隔离；TraeX 历史运行只有调用次数预算，不能宣称 token/金额预算相等。WP15 的 plugin cohort 回滚原验收是账本关闭与重新激活路径；新 systemd 物理恢复组件不自动证明所有推广后生产场景。WP15/WP17 的后续强化不反向增加原关闭门槛。

## 下一步

1. 验证实际飞书部署：本机 TraeX 自动接入、原生 Full access、首次 Lark owner 默认规则和业务 CLI 安装/用户授权入口已实现；在实际安装中完成平台授权并验证普通业务任务。应用和用户 scopes 由平台批准，不能从本地规则或 fixture 推导全权限可用。停止、回滚、去重及独立验收继续保留。
2. 补齐已有 Host 跟随官方 latest 更新：扩展现有 service-aware 事务，以精确版本私有 Host 验证离线副本并切换受管服务；不能在活动 Host 下覆盖全局 npm。覆盖同一 home 的 sibling profile 兼容性及失败恢复。
3. 补齐普通使用的安装环境：源码 checkout、本地 bare 发布仓库、必要目标插件及支持环境下的离线镜像与发布工具链/store/cache 已由安装器准备；私有 Node/授权工具、14 个独立签名身份与本地 registry/catalog 已自动准备；owner-bound manifest/授权生成与真实资源预检已接入；现已在 Linux supervised 安装末尾准备独立协调器、采集声明的部署输入、调用生成器并复用 [`dsh-rsi-setup`](../plugins/lark-channel/docs/rsi-setup.md) 成对配置。配置器已预检 schema4 wrapper/resolver 与 attestor 固定解释器，持久服务环境及 service-aware 升级校验/回滚已接通；生成器已将资源绑定当前 owner，将源码、`sourceJobs.baseline` 与 `sourceBuild` 接入 manifest；默认继承来源任务模型。停机状态下的真实 systemd 属性和原始 Loader 条目已进入安装预检；仍须完成正向真实部署与普通任务验收。本地 supervised 新装已完成冻结提交的独立包安装；24 包真实构建、目标与协调器内部运行依赖和文件校验、DSH 配置加载已通过。旧目录链接仍在停服前返回 `not-ready`。此包安装探针没有启动 Host，不替代真实 owner 部署与普通反馈验收。
4. 完成可选有限试用合同的部署验收：独立签发器、普通任务资格、最终提交纠正竞争、重启后观察与物理回退。缺省严格合同仍需补齐独立行为观测；有限试用不代表 shadow/canary/soak/health 或全局无副作用验收。
5. 在实际部署中验证普通反馈驱动候选、独立验证、有限采用和后续真实任务观察/回滚，然后完成发布检查并发布 npm。保留上表未完成边界；Skills 路径仍需去除逐 Goal 手动 arm，WP18 仍需真实仓库授权提交与精确 CI/readback。固定场景和测试夹具不算生产闭环。

## 开发入口与验证

- 本地包安装通过独立只读复核，真实探针通过：从提交 `61956cb` 独立构建 24 个包，冻结 receipt 重试不重新构建；生产安装入口自动合并安装脚本清单并采用 pnpm isolated 布局。临时目标的 17 个直接根（含 TraeX）及协调器的 3 个直接根均通过内部运行依赖/文件摘要核验，原生 DSH `0.1.5-rc.3 --dump-config` 的增强包集合精确一致。删除协调器一个已知 lib 文件后，普通安装 API 自动执行一次强制重装，原文件 SHA 和全闭包核验通过；旧失败的 hoisted 临时 profile 迁移也通过。这不外推任意已有用户 profile 的迁移，不验证真实 Host 启动、owner 授权或普通反馈。探针目录已清理，原始日志保留在忽略目录。
- 自动 owner 安装接线已通过独立只读代码复核与完整工程检查；尚无完整正向 npm/systemd 部署或普通任务闭环证据。现有 `web` profile 运行 DSH `0.1.7-rc.2`，peer 不兼容使多个增强包未激活，只提供负向诊断证据。发布门槛保持未满足。
- 安装输入的独立正向探针通过：三个真实 `pnpm pack` 产物解包到临时 profile 内，以 DSH `0.1.5-rc.3 --dump-config` 的实际输出调用生产 collector，得到一个可修复插件、六项声明文件及 Delivery/Lark observer。该探针使用合成 lockfile/资源元数据，只验证包与配置收集，不验证 npm 依赖安装、owner 授权或 Host 运行；临时目录已清理。真实 systemd 捕获探针六项通过，仅临时加载并恢复 unit，不启动 Host。
- 最近完整验证（冻结源码的本地包安装及中断修复）：`NODE_OPTIONS=--max-old-space-size=8192 pnpm check` 退出 0，覆盖清单校验、零警告 lint、类型检查、测试、构建与打包；最终修改额外通过全仓 lint、Lark typecheck 和四文件 15 项聚焦测试。根目录 686 项、36 个包 6,236 项测试通过，51 项跳过；其中 Control Plane 794 项、Delivery 810 项、Growth Driver 92 项、Lark 615 项、TraeX provider 161 项通过。36 个包 dry-run pack 均成功，32 个插件包含 patch，所有包包含 README/LICENSE；新增 `rsi-local-cohort`、`rsi-local-install` 模块与声明进入 Lark 包，未混入测试、覆盖率、日志或私钥。
- owner 配置准备定向测试验证五份授权、八阶段配置、schema4 Host 配置及生产预检，重复准备保留真实账本和使用状态，owner/密钥/阶段漂移拒绝。补查默认 bundle 后修复 Growth Driver 无 `config` 的首次安装失败，并按 Loader 的 `null` 语义处理无配置 observer；相关回归包含在最终全检中，本能力独立只读复核 PASS。编译产物的独立 Node 探针使用真实 Git、SQLite、签名身份和复制后的生产程序，通过首次准备、重复身份/状态保留及旧 owner 拒绝；executor/systemctl/Docker 输入有替身，未启动实际 Agent，不代表完整安装或普通反馈采用。本轮自动安装已接线；这一前轮探针不验证新的自动部署，真实正向部署和普通反馈采用仍未验收。
- 授权资源定向测试验证 14 个独立 Ed25519 身份、八个独立发布程序、特殊字符路径、真实 trust loader 接受与共用程序拒绝，以及删除源包后的副本模块加载。编译后的 `dsh-rsi-setup --prepare-authorities` 在真实私有临时目录运行两次，实际签验签通过，密钥内容/inode、已有状态及 registry 文件保持，临时资源已清理。独立只读复核 PASS。CLI 与配置器定向三文件 36 项通过；固定资源漂移、失败清理和重复准备均有工程回归。这些证据只验证资源准备，未签发真实 owner grant，未启动 Agent 或完成普通反馈闭环。
- 服务配置定向回归覆盖私有路径绑定、首次选择与重装复用、成对应用、失败回滚、外部漂移拒绝及升级恢复。首次全检发现非 service 事务清理错误地读取服务列表，已修复为仅校验 service manifest，修复后的完整 685 项根测试全部通过。真实 user systemd 小型 Node 探针验证九项特殊字符路径在启动与重渲染后重启均保持一致；直接调用生产 schema4 环境读回函数，匹配时接受，不匹配及缺 template 时拒绝，测试 unit/进程已清理，独立只读复核 PASS。该 wrapper 为未签名读回样本，不代表真实签名链、实际 Agent 或普通任务自迭代验收；原始证据保留在忽略目录。
- 本地 registry 契约修复前，接入真实 trust loader 的 8 项源码发布回归全部被 HTTPS 限制阻断；修复后通过。`pnpm --filter @dsh-enhanced/plugin-control-plane exec vitest run tests/source-release-runner.spec.ts tests/release.spec.ts` 共 40 项通过；runner 复用真实 SQLite、独立 Ed25519 身份和私有 trust 文件，外部派发为替身。`pnpm exec vitest run --dir tests tests/release-adapter.spec.ts` 的 5 项真实八阶段适配器测试通过，其中 PR、签名、registry verify 经真实 trust loader 调用；其余阶段保持原真实适配器路径。Lark 的 authority/setup 两文件 35 项通过，覆盖真实 schema4 wrapper/config/grant、漂移拒绝、包集合倒序和不转发的环境变量。独立只读复核 PASS；这些证据不代表生产 owner 反馈或实际 systemd 部署验收。
- 发布构建环境已通过编译 CLI 的真实准备与重复执行，导出的原生 Node/pnpm、store 与 cache 使用正式 adapter 的摘要算法核验。正式本地发布 adapter 在真实已提交源码上完成两次全新离线构建，完整规范化制品一致，build 阶段签名回执及 provenance 独立核验通过；构建隔离保留断网和只读输入。最终新增的 tar 路径严格校验通过留存真实制品及整仓回归。独立只读复核 PASS。该探针使用工程测试签名身份，只验证 build 阶段，不代表真实 owner 授权、模型审核、registry 发布或生产采用；原始命令与证据留在忽略目录。
- 自动构建环境通过真实编译 CLI 的镜像准备与回执复用，生成的 `sourceBuild` 通过 Control Plane 校验。使用同一不可变镜像和生成配置，对前轮冻结工作区运行生产 `runDockerPreparedChecks`：离线安装、整仓 `pnpm check`、Control Plane 制品打包与最终源码摘要复查均成功，退出 0，耗时约 24 分 53 秒，保持单 worker 与 30 分钟上限，容器已清理。容器内根目录 673 项通过/2 项条件跳过，36 个包 6,143 项通过/62 项条件跳过；其中 12 项物理恢复用例要求可见的 supervisor cgroup，容器隐藏 `/sys` 时按真实环境条件跳过，宿主全检则全部执行通过。不可见层级的拒绝检查仍在容器运行。该前轮验证使用当时本地提交及冻结工作区，不包含真实模型候选、官方源码公网下载、registry 发布或生产采用。
- 离线与私有目录验证暴露的测试环境依赖已修复：子进程 Vitest 限定根测试目录，避免重复发现忽略目录内的源码副本；模型验证夹具显式设置默认模型；不安全权限夹具显式设置 mode，避免被私有 umask 收窄；授权 CLI 夹具使用私有解释器及匹配 shebang。受测授权 CLI 仍来自实际包，生产 attestor 与 Docker 边界未放宽；容器不能替代宿主物理恢复验证，生产 attestor 的解释器部署配置仍属于下一步。
- 自动源码准备已通过真实本地 Git、命令入口与安装器回归：仅复制提交内容、保留原工作区、重复执行保留后续发布进度、错误版本及损坏资源拒绝、子进程取消清理、常用代理/CA 透传及配置注入排除。编译后的 CLI 对实际仓库的准备与重复执行也通过；固定官方 GitHub tag 下载在本环境 60 秒超时，未验收公网下载，不据此宣称完整 npm/生产安装成功。独立只读源码复核通过；所有原始日志留在忽略的 `docs/evidence/`。
- 连续源码基线新增 20 项工程回归：真实 Git 的两次签名合并、零历史初始 pin、专用 ref 恢复、脏工作区保留、主/关联 worktree 的符号 HEAD 拒绝，以及篡改/分叉/未完成/失败后已合并的历史拒绝。真实 SQLite 和签名完成两轮发布后重开账本，受管作业冻结第二次基线并拒绝旧基线；服务读取和隔离准备也使用同一新基线。发布执行器、构建与调度部分仍用替身，不能据此宣称真实生产连续发布或采用完成；外部同 UID Git 改动不具原子隔离。
- 自动 Host 授权新增 29 项工程回归：v24→25 保留计划/批准签名、不可变部署记录、claimed 操作、过期撤权后的恢复、有限配额与精确重放、打包 CLI 子进程，以及 schema4 包装层的 reload/readiness/restore/stop 和解释器拒绝。真实 Store/resolver 与使用替身 resolver 的 attestor 测试分别验证各自边界，尚未合并执行完整生产链。真实离线 packed ACP 安装使用 pnpm hardlink，声明输入解离后链接数 2→1、SHA256 不变且捕获成功；该探针不证明完整 DSH 激活。旧明确授权配置的回归与全部 Control Plane 测试通过。失效授权下未知操作仍需精确回执对账，不宣称自动恢复。
- 有限试用新增工程覆盖：真实 SQLite 源码发布/交接、reload/readiness 签名、普通任务持久归因、独立资格签发与重放、失败/期限/不足样本、旧提交失效，以及 v23→24 保留签名与外键。最终采用测试使用真实 EvaluationStore 与 ControlPlaneStore 的组合 writer fence/CAS，并验证结果更正后资格拒绝；其中实时 Host 采样回调是测试桩。原生 cron 覆盖重启后缺失 observer 的失效处理，配置器覆盖第五签名器的条款、公钥和有效期。模型、传输或 supervisor 的部分路径仍为替身，不能据此宣称生产闭环完成。
- 自然反馈集成使用真实 Lark 适配器、Delivery 原生 AgentLoop、Evaluation、Automations 与持久 UsageRuntime，模型和传输为测试替身。验证正常续答、原反馈正文与来源模型、重复投递去重、同值不替换原证据，以及更正/撤回后旧作业失效且原生调度不执行旧复盘。运行时另覆盖缺 Evaluation、反馈日志准备失败、两库暂时不同步后的补记，以及附件来源拒绝。跨库恢复依靠冻结意图与幂等，不能称为原子提交；这些工程检查不证明生产自修复或自动采用。
- Delivery v24 新增自然反馈日志；升级准备所需的 Lark owner 只读快照明确接受 23/24 并返回实际版本，避免新 Host 尚未迁移旧库时提前拒绝升级。真实 v23 SQLite 文件的绑定读取、指纹不变、无迁移、空库与不支持版本拒绝已验证；运行时和 Web doctor 仍按 v24 检查。
- 真实 Linux 官方 CLI 1.0.96 下载及断网复用成功；原生 DSH `0.1.5-rc.3` 技能发现、读取，以及撤下文件后同一运行实例的目录失效已验证。TraeX 临时 profile 的真实 dump-config 已验证 Loader/provider 启用、既有 command/cwd/settings 保留及条件默认模型只作用于目标 profile。未执行真实 TraeX ACP prompt、飞书 OAuth、业务 API 写入或 npm 发布；这些检查不替代生产普通反馈采用与独立行为验收。

- [插件目录](../plugins/README.md)、[仓库架构](architecture.md)、[持续成长设计](continuous-personal-assistant-growth.md)。
- [源码提案与持久检查](live-durable-source-proposal.md)、[真实仓库 E2E](live-repository-e2e.md)。
- [systemd Host 签名器](systemd-host-attestor.md)、[运行时观测](runtime-observer.md)、[原生阻断回放及有限端点](effect-blocked-replay.md)。
- 原生维护预算修复独立复核通过：Control Plane 三个相关 spec 共 16 项、Growth 使用复盘 spec 共 19 项。真实 Automations + Policy 路径证明三个 cron 成功结算预算、耗尽后不进入执行器；扫描与模型复盘按 scope 分开额度，未开启无预算旁路。部署配置现在须补齐必填字段；这些组件测试不证明真实双 Host 安装或生产使用闭环，尚未发布 npm。
- 前轮真实 DSH CLI `0.1.5-rc.3` / attestor v5 探针：`DSH_READINESS_FIXTURE=1 DSH_READINESS_DSH=/absolute/path/to/dsh node scripts/e2e/systemd-readiness-real-dsh.mjs --output <local-evidence.json>`，默认及 `DSH_READINESS_ROLLBACK=restore` 均退出 0。覆盖临时 profile 的 dump-config、真实 Host reload/readiness 与物理恢复；未执行 npm 制品安装、生产采用或独立行为质量验收。会话兼容三进程冷读探针也已通过。历史 rc2 回放端点验收不自动视为本轮新版验证，边界见 [Host 签名器](systemd-host-attestor.md)和[阻断回放](effect-blocked-replay.md)。


原始运行 JSON、日志和临时身份留本地或 CI artifacts，仓库只保留命令、结论和限制。确需供可重复探针使用的固定输入留在 `scripts/e2e/fixtures/`，不从本次网络结果反推预期值。
