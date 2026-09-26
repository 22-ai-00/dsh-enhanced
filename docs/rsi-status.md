# RSI 当前状态

更新：2026-09-26。此页是当前进展与剩余验收的唯一入口；历史流水保留在 Git 历史，配置以各插件 README 为准。

## 项目方向

构建利用 DSH 原生 AgentLoop 与 Cordis 组合、注入、资源归属和重载能力的自我迭代工具/插件智能体。模型是可替换供应；自我修复/迭代默认继承用户会话或来源任务的实际模型，可显式配置固定模型覆盖，`super-relay / auto_model/alwaysday1` 是可用供应之一。每轮固定供应、预算与验收标准，持久修复记录解析后的选路供恢复使用，保留身份、任务历史和能力版本。

闭环为：任务反馈 → 技能/工具/插件候选 → 独立验证 → 有限推广 → 新任务复用 → 观察与回滚。验收和留出集须在候选写权限之外。研究依据见[自迭代原则](research-dsh-plugin-self-iteration-2026-09-19.md)，开发约束见 [AGENTS.md](../AGENTS.md)。

**当前开发目标：让 Agent 在用户日常使用中自我修复、自我迭代。** 一次配置与授权后，正常会话中的失败、纠正、重复任务及后续结果应自动进入持久成长流程，由 Agent 在既有授权和预算内形成、验证、采用改进，并观察和回滚；用户无需逐次调用捕获、修复或比较工具。固定场景仅用于必要回归，不再以反复手动运行模型探针作为开发主线。

## 当前交付边界

- 新用户安装简化已实现：检测本机 `traex` / `trae-cli` 后自动安装并启用，保留显式模型、命令和工作目录；精确登录检查通过且没有显式选择时，只为目标 profile 设置默认模型。未登录或 `--model skip` 仍启用插件；失败仅恢复目标 profile。支持 pnpm 嵌套依赖布局。Lark 首次 owner 默认开放已安装工具能力，已有应用/owner 保留权限，显式关闭不因重装恢复。整仓检查通过，真实 DSH dump-config 已验证启用状态和配置保留；未执行真实 TraeX ACP 请求、飞书平台授权或生产 npm 安装。Host 已默认 Full access；这不等同于已取得全部飞书平台权限或完成成长授权。
- 飞书向导默认接入官方业务 CLI：应用采用智能体权限模板，复用契约兼容 CLI 或校验下载官方 latest，安装时为绑定 owner 申请 `--domain all` 用户授权；由 DSH 原生技能按需读取 CLI 内嵌能力说明。身份同时核对本地验证状态与服务端 user_info，重复安装复用有效授权；更换 owner/app/account 或显式关闭时先撤旧技能。真实 Linux CLI 1.0.96 下载、离线复用与原生技能加载已验证；平台授权和真实业务操作尚未执行，不能宣称租户全部权限已开通。macOS/Windows 尚未实机验证，系统钥匙环与同一 DSH_HOME 的用户技能目录不构成独立凭据隔离。
- 按用户确认跟随官方 npm `latest`，当前验证基线为 DSH `0.1.5-rc.3`；registry 尚无正式 `0.1.7`，`0.1.7-rc.2` 属于 next。测试依赖保持精确版本以复现结果，新装默认 selector 将跟随 latest 并验证兼容范围，已有兼容 Host 保持复用。`update --all` 尚不更新 DSH Host，后续须补齐受管 Host 更新事务。原生 Agent setup、Inbox、PTC 审计事件、系统提示和会话句柄 API 已迁移，完整 `pnpm check` 退出 0。真实 latest CLI 的三进程会话写入、未知事件拒绝和冷读恢复，以及 systemd reload/readiness/物理 restore 探针已通过；这些兼容性结果不代表生产自迭代闭环或 npm 发布门槛已完成。
- 普通反馈→持久复盘→源码候选→发布/采用协调已有接线，`dsh-rsi-setup` 已实现。本轮新增可选[有限试用采用合同](bounded-live-adoption.md)：独立源码审核及 reload/readiness 后，使用精确部署下的普通任务反馈签发资格，最终提交同时重验原失败来源与资格反馈；负向或失效证据进入原有物理回退。窗口约束决定与回退请求，不保证物理恢复时限；整个 profile 会暴露候选，同 UID 不是 OS 隔离。双 Host 配置器校验第五个签发器与第六份预算，完整工程检查与独立源码复核通过，真实部署闭环尚未验收。缺省严格合同保持原独立行为阶段；现有 systemd attestor 不能签发全局 `externalEffects=0`，新合同也不作此声明。

- 即时审批沿用已发布能力：Policy 的 `auto` 对非凭据本地只读与单个命名 Skill 加载直接继续，显式 `ask` 仍询问；Lark 使用 CardKit callback，`format_error` 时降级为同一 owner 私聊的精确文字允许/拒绝。本轮另修复 Auto 来源判定：当前 format 3 中残留 `auto` 选择不能授权后来切换的 full-access 自动审核；独立复核与 Policy 定向测试通过。
- `dsh-rsi` 已提供安装、升级、状态/doctor、服务 start/stop/restart、日志查看与彻底卸载。上一轮修复了 DSH `profiles/node_modules` 被误识别为 profile、未注册服务指向不可用全局 `dsh-rsi-setup`、npm/pnpm 重复提示刷屏，以及 supervised 新装漏选 Goals 导致 Recovery 等待 `assistantGoals` 的运行时失败。降噪只使用 npm global location 与 pnpm error log level；真实 package-manager 错误仍保留并非零退出。
- `dsh-rsi update --all` 部署闭环修复已完成：自升级固定写回当前 CLI 的真实 npm prefix；profile 升级使用同一精确版本 tag；Linux 已注册受管服务的精确 systemd MainPID 由 service-aware lifecycle 接管（`update --all` 只阻止非受管 Host，受管服务 MainPID 交给 lifecycle 事务），只有额外手工/测试 Host 才阻止升级；受管服务 stop 后对失败单元执行 `reset-failed`，masked unit 的 raw 状态改用不含 `ExecStart` 的 `SYSTEMD_RUNTIME_PROPERTIES` 读取。真实 Linux 部署验收（2026-09-25）通过公开路径完成：旧 profile 经 `dsh-rsi purge --profile web --yes` 正式清除后，`dsh-rsi install --scenario lark --lark skip --local` 干净重装，`dsh-profile-web.service` active/running/MainPID>0，web 端点响应，profile 下全部 @dsh-enhanced/* 包统一为 0.1.46，active 事务目录已清理（仅保留 lifecycle 重命名的 failed evidence 目录）。升级前的同 UID 进程扫描对 non-dumpable 会话基础设施严格证明后放行：root sshd 认证会话（comm=`sshd`、父进程 uid=0 且父 comm=`sshd`）与 systemd --user 的 `(sd-pam)` PAM 辅助进程（comm=`(sd-pam)`、父 comm=`systemd` 且父 Uid 为当前用户）的 environ/cwd/root/fd/maps 返回 EACCES/EPERM 时不再误拦；证明按进程惰性缓存，普通不可读同 UID 进程仍 fail-closed，已证明会话若可读 cmdline/cwd/fd/maps 真实引用 DSH_HOME 仍阻止升级。CLI 补传静止确认并从 effective/composed profile 识别场景。macOS 已停止 Home 的 Lark/supervised profile 会先完整备份再升级，组合或真实激活失败时恢复原 profile；旧 Recovery profile 缺失 `assistant-goals` 时自动补齐。
- 当前 npm 发布基线以发布账本的 `current` 为准；后续 dev 开发及 `pending` 不等于已发布。安装器和 Host 兼容范围见[兼容性说明](compatibility.md)与[发布账本](../release-manifest.json)。
- 下一版 npm 的发布门槛是：安装部署后，在既有授权内由真实使用持续驱动修复、验证、采用与观察/回滚，并通过完整发布检查。用户已同意达到该门槛后重新发布；当前中间能力尚不满足条件。
- 日常使用中的工具/插件自迭代尚未贯通。普通 Lark 已有低风险偏好自动学习；Growth `usageLearning` 已可根据可信前台任务结果自动调度持久复盘；内置 Delivery 普通对话的已认证 owner 反馈也可触发，无需预设任务验收 profile；启用源码轨时，可信失败会自动形成 owner 私有修复缺口并进入源码候选工具，可经有限源码审批；精确制品的有限采用已接到同一持久作业，后续普通任务版本归因已接入可选 Host 配置；有限可信反馈批次、观察签发与自动回退已接通，配置已可编译，真实部署端到端仍待验收。Skills 有限修复链仍需对精确来源 Goal 手动 `skill_repair_arm`；既有授权下的独立验证、采用及持续观察仍待接通。
- 成长与修复的模型默认继承来源，可配置固定覆盖。Delivery schema 23 为普通 owner 前台任务单独保存执行回执，在 DSH 最终 `request/header` 保存来源实际 provider/model/effort，包括 adapter 默认值；用户随后切换模型不改变历史任务。旧任务无快照或同任务多模型时不猜测。自动 Growth 作业保存该快照，queued 可恢复，已派发但中断的任务保持 unknown、不重放；Skills 沿用其修复授权中的冻结选择。
- Evaluation 的可信 canonical feed 包含纠正/撤回；Delivery 核对精确 owner 身份与原始任务，支持 `/new` 后读取旧任务并拒绝身份换代继承。Growth 在 writer fence 内落游标/意图，复用 Automations 扫描、调度和预算；每次模型/工具调用重查来源，排除后台结果递归触发。Control Plane schema 24 保留精确 owner/canonical 来源引用和 source release→activation 绑定，自动源码轨只读取本次缺口，检查与最终计划提交重验来源；`/new` 改变完整 owner receipt 后停止旧工作。普通对话可直接回复实际结果提交明确自然反馈，仍保留 typed `/feedback`；自然回复继续进入 Agent，Evaluation 暂不可用时保存待补记意图，不假称已完成投影。unknown/未停止执行不能被反馈改判。旧普通任务不回填；此新增入口覆盖内置外部渠道运行时，尚不覆盖原生 Web 或自定义运行时。模型结束或工具退出本身不构成学习依据。
- Delivery schema 24 为明确自然任务反馈增加持久日志：初评、更正和撤回固定原始 Inbox/Outbox、owner、入站顺序与版本条件；恢复只补记反馈，不重跑用户模型。Growth 通过当前 canonical owner 操作身份取得有界纠正原因，同值重复不替换原证据；旧复盘随更正/撤回失效。该入口只覆盖内置外部渠道的普通前台结果，Automation、whole-goal 和原生 Web 仍走各自原入口。此能力不补足下述独立行为观测和自动采用部署缺口。
- 基本 RSI 已在限定任务族跑通真实修复、独立比较、后续任务 canary、两轮晋升与安全检查点恢复。它不证明任意任务都能自我改进，也不允许重放未结算的模型或外部调用。
- Day1 已经通过原生 Agent/Growth Driver 提交源码修复候选，独立 Host 作业完成离线仓库检查并形成待审批计划；其中 personal-memory 修复经开发复核整合。待审批提案不等于自主发布或生产启用。
- Control Plane 已有 npm 发布/独立读回/catalog adapter，以及 systemd reload、readiness、物理 rollback 的签名与持久操作组件。Host 派发在外部调用前落持久 claim，执行期间释放控制面写锁；结果未知时不重复调用，精确签名回执可对账，未结算前阻止同计划回退与恢复文件清理。认证有限回放端点支持晚到 Ed25519 授权：readiness 落账后，将真实 schema-2 请求交给同一 DSH CLI `0.1.5-rc.2` Host 执行，保持 PID/InvocationID、候选 Fiber 与部署文件不变。完成态重启失效，SIGKILL 中断后保留 unknown；同 scope 换 operation 或重新签发 grant 不能恢复派发权限。其输出不证明全局 `externalEffects = 0`，不能代替独立签名。
- Host request schema 2 的普通部署阶段固定同一 activation/fence 下前一阶段的完整签名回执摘要与 generation，并在 dispatch、apply 时复核；普通阶段不能换代。systemd attestor v5 已通过真实 reload/readiness 与物理 restore 探针。旧 schema-1 已应用历史可作为前驱，未完成操作必须先用原兼容版本对账；此改动仍不提供独立副作用观测。
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
3. 完成普通使用部署验收：使用已有 [`dsh-rsi-setup`](../plugins/lark-channel/docs/rsi-setup.md) 为目标与独立协调器编译有限配置、原生预算和 Policy，核对 owner/trust/签名授权。该入口不代替授权器和独立行为观测部署；默认继承来源任务模型。
4. 完成可选有限试用合同的部署验收：独立签发器、普通任务资格、最终提交纠正竞争、重启后观察与物理回退。缺省严格合同仍需补齐独立行为观测；有限试用不代表 shadow/canary/soak/health 或全局无副作用验收。
5. 在实际部署中验证普通反馈驱动候选、独立验证、有限采用和后续真实任务观察/回滚，然后完成发布检查并发布 npm。保留上表未完成边界；Skills 路径仍需去除逐 Goal 手动 arm，WP18 仍需真实仓库授权提交与精确 CI/readback。固定场景和测试夹具不算生产闭环。

## 开发入口与验证

- 当前完整验证：`NODE_OPTIONS=--max-old-space-size=8192 pnpm check` 退出 0，覆盖清单校验、零警告 lint、类型检查、测试、构建与打包。根目录 670 项、36 个包 6,087 项测试通过，50 项跳过；其中 Control Plane 743 项、Delivery 810 项、Growth Driver 92 项、Lark 517 项通过。36 个包 dry-run pack 均成功，32 个插件包含 patch，所有包包含 README/LICENSE；新增资格签名器及编译模块已进入包内，未混入测试和日志。独立只读源码复核通过。
- 有限试用新增工程覆盖：真实 SQLite 源码发布/交接、reload/readiness 签名、普通任务持久归因、独立资格签发与重放、失败/期限/不足样本、旧提交失效，以及 v23→24 保留签名与外键。最终采用测试使用真实 EvaluationStore 与 ControlPlaneStore 的组合 writer fence/CAS，并验证结果更正后资格拒绝；其中实时 Host 采样回调是测试桩。原生 cron 覆盖重启后缺失 observer 的失效处理，配置器覆盖第五签名器的条款、公钥和有效期。模型、传输或 supervisor 的部分路径仍为替身，不能据此宣称生产闭环完成。
- 自然反馈集成使用真实 Lark 适配器、Delivery 原生 AgentLoop、Evaluation、Automations 与持久 UsageRuntime，模型和传输为测试替身。验证正常续答、原反馈正文与来源模型、重复投递去重、同值不替换原证据，以及更正/撤回后旧作业失效且原生调度不执行旧复盘。运行时另覆盖缺 Evaluation、反馈日志准备失败、两库暂时不同步后的补记，以及附件来源拒绝。跨库恢复依靠冻结意图与幂等，不能称为原子提交；这些工程检查不证明生产自修复或自动采用。
- Delivery v24 新增自然反馈日志；升级准备所需的 Lark owner 只读快照明确接受 23/24 并返回实际版本，避免新 Host 尚未迁移旧库时提前拒绝升级。真实 v23 SQLite 文件的绑定读取、指纹不变、无迁移、空库与不支持版本拒绝已验证；运行时和 Web doctor 仍按 v24 检查。
- 真实 Linux 官方 CLI 1.0.96 下载及断网复用成功；原生 DSH `0.1.5-rc.3` 技能发现、读取，以及撤下文件后同一运行实例的目录失效已验证。TraeX 临时 profile 的真实 dump-config 已验证 Loader/provider 启用、既有 command/cwd/settings 保留及条件默认模型只作用于目标 profile。未执行真实 TraeX ACP prompt、飞书 OAuth、业务 API 写入或 npm 发布；这些检查不替代生产普通反馈采用与独立行为验收。

- [插件目录](../plugins/README.md)、[仓库架构](architecture.md)、[持续成长设计](continuous-personal-assistant-growth.md)。
- [源码提案与持久检查](live-durable-source-proposal.md)、[真实仓库 E2E](live-repository-e2e.md)。
- [systemd Host 签名器](systemd-host-attestor.md)、[运行时观测](runtime-observer.md)、[原生阻断回放及有限端点](effect-blocked-replay.md)。
- 原生维护预算修复独立复核通过：Control Plane 三个相关 spec 共 16 项、Growth 使用复盘 spec 共 19 项。真实 Automations + Policy 路径证明三个 cron 成功结算预算、耗尽后不进入执行器；扫描与模型复盘按 scope 分开额度，未开启无预算旁路。部署配置现在须补齐必填字段；这些组件测试不证明真实双 Host 安装或生产使用闭环，尚未发布 npm。
- 当前工作区真实 DSH CLI `0.1.5-rc.3` 探针：`DSH_READINESS_FIXTURE=1 DSH_READINESS_DSH=/absolute/path/to/dsh node scripts/e2e/systemd-readiness-real-dsh.mjs --output <local-evidence.json>`，默认及 `DSH_READINESS_ROLLBACK=restore` 均退出 0。覆盖临时 profile 的 dump-config、真实 Host reload/readiness 与物理恢复；未执行 npm 制品安装、生产采用或独立行为质量验收。会话兼容三进程冷读探针也已通过。历史 rc2 回放端点验收不自动视为本轮新版验证，边界见 [Host 签名器](systemd-host-attestor.md)和[阻断回放](effect-blocked-replay.md)。


原始运行 JSON、日志和临时身份留本地或 CI artifacts，仓库只保留命令、结论和限制。确需供可重复探针使用的固定输入留在 `scripts/e2e/fixtures/`，不从本次网络结果反推预期值。
