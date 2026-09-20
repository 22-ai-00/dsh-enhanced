# RSI 当前状态

更新：2026-09-20。此页是当前进展与剩余验收的唯一入口；历史流水保留在 Git 历史，配置以各插件 README 为准。

## 项目方向

构建利用 DSH 原生 AgentLoop 与 Cordis 组合、注入、资源归属和重载能力的自我迭代工具/插件智能体。模型是可替换供应；自我修复/迭代默认继承用户会话或来源任务的实际模型，可显式配置固定模型覆盖，`super-relay / auto_model/alwaysday1` 是可用供应之一。每轮固定供应、预算与验收标准，持久修复记录解析后的选路供恢复使用，保留身份、任务历史和能力版本。

闭环为：任务反馈 → 技能/工具/插件候选 → 独立验证 → 有限推广 → 新任务复用 → 观察与回滚。验收和留出集须在候选写权限之外。研究依据见[自迭代原则](research-dsh-plugin-self-iteration-2026-09-19.md)，开发约束见 [AGENTS.md](../AGENTS.md)。

**当前开发目标：让 Agent 在用户日常使用中自我修复、自我迭代。** 一次配置与授权后，正常会话中的失败、纠正、重复任务及后续结果应自动进入持久成长流程，由 Agent 在既有授权和预算内形成、验证、采用改进，并观察和回滚；用户无需逐次调用捕获、修复或比较工具。固定场景仅用于必要回归，不再以反复手动运行模型探针作为开发主线。

## 当前交付边界

- 发布基线仍为 `0.1.32`；`dev` 工作区版本为 `0.1.33`，后续开发不等于已发布。安装器和 Host 兼容范围见[兼容性说明](compatibility.md)与[发布账本](../release-manifest.json)。
- 下一版 npm 的发布门槛是：安装部署后，在既有授权内由真实使用持续驱动修复、验证、采用与观察/回滚，并通过完整发布检查。用户已同意达到该门槛后重新发布；当前中间能力尚不满足条件。
- 日常使用中的工具/插件自迭代尚未贯通。普通 Lark 已有低风险偏好自动学习；Growth `usageLearning` 已可根据已验收前台任务结果自动调度持久复盘；启用源码轨时，可信失败会自动形成 owner 私有修复缺口并进入源码候选工具，仍止于 pending 产物。Skills 有限修复链仍需对精确来源 Goal 手动 `skill_repair_arm`；既有授权下的独立验证、采用及持续观察仍待接通。
- 成长与修复的模型默认继承来源，可配置固定覆盖。Delivery schema 22 在 DSH 最终 `request/header` 保存来源实际 provider/model/effort，包括 adapter 默认值；用户随后切换模型不改变历史任务。旧任务无快照或同任务多模型时不猜测。自动 Growth 作业保存该快照，queued 可恢复，已派发但中断的任务保持 unknown、不重放；Skills 沿用其修复授权中的冻结选择。
- Evaluation 的可信 canonical feed 包含纠正/撤回；Delivery 核对精确 owner 身份与原始任务，支持 `/new` 后读取旧任务并拒绝身份换代继承。Growth 在 writer fence 内落游标/意图，复用 Automations 扫描、调度和预算；每次模型/工具调用重查来源，排除后台结果递归触发。Control Plane schema 16 保留精确 owner/canonical 来源引用，自动源码轨只读取本次缺口，检查与最终计划提交重验来源；`/new` 改变完整 owner receipt 后停止旧工作。当前只处理具备可信结果与明确归属的前台任务；模型结束或工具退出本身不构成学习依据。
- 基本 RSI 已在限定任务族跑通真实修复、独立比较、后续任务 canary、两轮晋升与安全检查点恢复。它不证明任意任务都能自我改进，也不允许重放未结算的模型或外部调用。
- Day1 已经通过原生 Agent/Growth Driver 提交源码修复候选，独立 Host 作业完成离线仓库检查并形成待审批计划；其中 personal-memory 修复经开发复核整合。待审批提案不等于自主发布或生产启用。
- Control Plane 已有 npm 发布/独立读回/catalog adapter，以及 systemd reload、readiness、物理 rollback 的签名与持久操作组件。认证有限回放端点支持晚到 Ed25519 授权：readiness 落账后，将真实 schema-2 请求交给同一 DSH CLI `0.1.5-rc.2` Host 执行，保持 PID/InvocationID、候选 Fiber 与部署文件不变。完成态重启失效，SIGKILL 中断后保留 unknown；同 scope 换 operation 或重新签发 grant 不能恢复派发权限。其输出不证明全局 `externalEffects = 0`，不能代替独立签名。
- Host request schema 2 固定同一 activation/fence 下前一阶段的完整签名回执摘要与 generation，并在 dispatch、apply 时复核；普通阶段不能换代。systemd attestor v5 已通过真实 reload/readiness 与物理 restore 探针。旧 schema-1 已应用历史可作为前驱，未完成操作必须先用原兼容版本对账；此改动仍不提供独立副作用观测。
- Skills 已接入同进程 Host 受限委派：来源重新验证后，将冻结的活动技能或 pending 候选临时挂载到全新 owner scope，经原生 `skill_run` 执行；持久 cell reservation 与调用记录阻止换调用键或重启重放。来源和接收方重载、撤权、到期及取消均保留失败或 unknown。Evaluation 原生模型 cell 与冻结后独立任务已接入，12-cell Docker 工程验证两臂各 6 次达成，候选实际复用 6 次、质量平局。Day1 同预算收益比较仍待完成；见[接线指南](native-skill-reuse.md)。
- 完整 RSI 目标尚未完成。组件测试、历史局部真实运行和 fixture 不能合并推导为 WP16/WP18 的生产端到端验收。

Day1 原生技能的真实双臂比较仍待完成。最近来源实验的产物作业成功，但整个原生 Goal 回合达到 240 秒期限：6 次模型调用已结算，另 1 次用量 unknown 并保留预留；整体 Goal 验收为 unknown，未进入捕获或比较，本地 runtime 清理确认成功。旧失败和 unknown 不改判、不重放，未知用量不计零。

Goals 已通过现有 SystemPrompt/`goal_context` 提供 `roundTiming`：首个请求只见配置上限，回合准入后的请求可见同一持久 run 的准确截止与剩余时间。Docker 回归已核对模型实际输入与持久 admission 一致，并验证正常结束后仍由独立验收完成 Goal；这不延长预算，也不证明真实收益。固定 Day1 探针暂不继续运行；下一步交付日常使用驱动的成长接线。

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

1. 在已接通的真实反馈→持久复盘→owner 私有失败 gap→源码候选之上，连接有界修复授权，去除逐 Goal 手动 arm。若走 Skills 修复，普通前台来源须经 owner 授权的 Host 入口创建真实原生 Goal，不能伪造现有修复契约要求的来源 Goal；调度继续复用 Automations。
2. 接通成长触发 → 自主修复/技能或插件候选 → 独立验证 → 已授权范围内采用 → 后续真实使用观察与回滚。复用既有 Skills、Growth Driver 和 Control Plane；仅停留在 pending 提案不算完整交付。
3. 提供可安装的日常使用配置，明确正常入口、针对成长能力范围的一次授权、预算、停止和恢复方式。模型保持可替换供应，成长状态随 Agent 持久化；无需为每个来源 Goal 手动 arm，或为每个任务重新编排固定场景。自动调用预设场景仍不能替代这一目标。
4. 保留上表未完成验收与真实发布/外部系统边界。WP16 的独立副作用观测、签名和推广恢复，以及 WP18 的精确提交 CI/readback，按日常自迭代链路所需逐项接入；测试夹具不能代替生产授权或真实收益。

## 开发入口与验证

- [插件目录](../plugins/README.md)、[仓库架构](architecture.md)、[持续成长设计](continuous-personal-assistant-growth.md)。
- [源码提案与持久检查](live-durable-source-proposal.md)、[真实仓库 E2E](live-repository-e2e.md)。
- [systemd Host 签名器](systemd-host-attestor.md)、[运行时观测](runtime-observer.md)、[原生阻断回放及有限端点](effect-blocked-replay.md)。
- 真实失败来源链已通过独立代码与证据复核。定向检查：Growth 整包 83 项通过；Control Plane store/来源 fence/Host 准备与迁移相关 106 项、durable source job 与原生调度 15 项通过。覆盖 exact owner gap、全局列表隔离、反馈变化、最终提交冲突、重启和 unknown 不重放；两包类型、构建、lint、manifest 与 dry-run pack 通过。测试使用本地脚本模型与隔离构建夹具，不作为真实供应商效果或自动采用证据。
- 上轮全仓 `pnpm check` 在 Evaluation 的 4 个旧版本迁移测试处停止：降级 fixture 误留 v12 专用反馈索引外键，已修正并独立复核；Evaluation 整包 344 项通过、10 项跳过。当前完整门禁正在重跑，尚未确认通过。
- Control Plane 基线 `5cfc3c8` 的真实 DSH CLI `0.1.5-rc.2` 探针 `systemd-readiness-real-dsh.mjs`（默认及 `DSH_READINESS_ROLLBACK=restore`）和 `replay-endpoint-real-dsh.mjs` 均退出 0。覆盖同 Host 的 readiness→grant→回放、重启/SIGKILL 后拒绝重新派发以及物理恢复；命令与证据边界见 [Host 签名器](systemd-host-attestor.md)和[阻断回放](effect-blocked-replay.md)。
- 未结算 generation 测试修复 `e33a6ae` 已通过 Linux、macOS 与 Windows 的 [CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/35494781155)。测试用真实派发后丢失确认建立持久未结算状态，检查新 operation 不再重启。该跨平台结论不覆盖之后的新改动。

原始运行 JSON、日志和临时身份留本地或 CI artifacts，仓库只保留命令、结论和限制。确需供可重复探针使用的固定输入留在 `scripts/e2e/fixtures/`，不从本次网络结果反推预期值。
