# RSI 验收合同

此页保留完整验收合同，供相关能力开发或发布审查时按需读取；当前优先级只维护在 [RSI 当前状态](rsi-status.md)。已关闭项不再进入日常待办。

“已验收”沿用已提交的限定范围结论，不代表重新运行了历史实验或完成生产闭环；工程全检不替代工作包验收。精简进展不缩小以下成功条件。

当前用户目标另要求三条真实普通使用通道，不能用已关闭的局部工作包替代：

- **记忆进化：** 经认证的普通任务/纠正自动形成有来源、版本与适用条件的事实或经验记忆；一次授权后无需逐次调用记忆工具；去重、纠正、撤回、重启、检索与后续真实决策收益均有证据。
- **工程进化：** 普通失败/重复需求能自动创建有界新插件并修改已有插件；独立验收与写权限分离，通过 Cordis 动态加载采用不可变制品，保持非目标能力可用，验证 disposer、缺失 injection、失败恢复、撤权、后续任务收益与精确版本回退。CLI 脚手架、源码审查或整 Host 重启各自不能证明此通道完成。
- **主动进化：** 认证来源与常驻订阅中未被订阅的输入，经 Host 确定性分级（explicit/inferred/ignore；名单内寄址或在已有工作线程上跟进为 explicit，名单内未寄址为 inferred，bot 至多 inferred），inferred 候选经有预算、只降不升、引文须为认证原文子串的模型评估后先 observe 记录 would-accept；凭 would-accept 与 owner 后续结果的吻合度、密封留出重放、独立验收与有界采用逐规则自动放开，超出一次性预授权范围才向 owner 提一个结构化问题。执行时冻结 Mandate 并由独立 verifier 验收；对外发言由 Host 校验目的（result/attention/answer）与字数，确认一次后静默至结果、决策或阻塞；注意力结果（采纳、拒绝、忽略、漏报）回流并驱动有界调参与精确版本回退。固定场景、运营估值或模型自评不能证明此通道完成。

| 工作包 | 成功条件 | 当前状态与边界 |
| --- | --- | --- |
| WP01 | Canary 只消费 Evaluation 的 canonical 最新投影；promotion 提交时持有 writer fence，并绑定任务版本、digest 与 scope watermark。纠正、并发纠正、重启都不能复用旧成功。 | **已验收（原范围）**。Evaluation canonical 投影、writer fence 与修订测试。 |
| WP02 | Delivery 提供 owner 对任务结果的查询、更正和撤回；Evaluation 保留历史但每任务只计算当前一票，变化传播到成长消费者和已推广版本。 | **已验收（原范围）**。Delivery owner 反馈、Evaluation 修订和撤票传播。 |
| WP03 | 冻结不可变 TaskAcceptanceContract；由独立 verifier 对代码行为、文档引用或目标系统状态验收，并接入前台与 Automation。退出码或模型自评不能代替目标达成，无法确认时保持 unknown。 | **已验收（原范围）**。Verifier/Goals/Isolation 独立任务契约。 |
| WP04 | 固定任务集、独立留出集、可重跑 baseline runner 与版本化结果；同模型同预算记录成功率、成本、延迟、返工、分布和消融，留出不参与候选生成。 | **实现中，未完成验收**。已有固定 runner 与配对比较；`families-v1` 以确定性 fixture 覆盖 8 个任务族，原生 runner 支持复核消融，报告含分布、分族与配对指标差，所有 holdout 执行（共用 `runBenchmark`）建账前执行公开清单隔离检查；候选生成守卫已提供但尚无生成入口调用。真实同预算收益、真实模型下的消融结果与规划/成长消融仍待验收。 |
| WP05 | 业务目标 bundle 保存成功条件、期限、依赖、预算、授权、假设、阻塞、唤醒与证据，并把原生 goal/session/run 合成唯一执行闭环；跨会话/重启完成且不重复外部提交。 | **实现中，未完成验收**。原生 Goals、持久上下文与恢复已接线；完整长期业务目标验收仍待补齐。 |
| WP06 | 按任务难度选择直接执行、调查、实验、独立复核、候选比较或原生 subagent；区分工具故障与推理失败，记录协调成本，并以固定预算证明策略收益。 | **实现中，未完成验收**。原生 subagent 与策略预算已接线；真实策略收益及协调成本比较仍待补齐。 |
| WP07 | Memory 围绕当前 goal/step/query 检索，保留来源、适用条件、反例、失效条件和冲突；工具证据压缩可追溯，状态变化时重查，并证明召回改善决策。 | **实现中，未完成验收**。任务检索、来源和版本化索引已实现；另行授权的后台结果经验已通过真实组件组合与双端根检查。模型自主选择召回、真实决策收益与长期冲突处理仍待验收；最新边界见当前状态，不以提取或采用成功代替收益。 |
| WP08 | Policy 能表达长期能力包和短期 lease，约束资源、动作、目的地、敏感度、期限、次数、费用与撤销；提交绑定 digest、前置版本和幂等键，常规授权内不逐动作审批。 | **实现中，未完成验收**。Policy、lease、动作准入已有实现；完整业务授权维度和真实撤权闭环仍待验收。 |
| WP09 | 独立动作/凭据 broker 与隔离 worker 至少支持一个生产平台；worker 任意代码不能读取 token/信任根或绕过网络/动作代理，崩溃恢复不重复提交。 | **实现中，未完成验收**。Actions 外部 broker 与隔离 worker 已有组件；真实独立身份部署及生产平台闭环仍待验收。 |
| WP10 | 提供外部停止、worker 不可覆写审计、版本回滚和不可逆动作补偿；终止 worker、撤 lease/凭据/出口，并为部分失败保存明确结果。 | **实现中，未完成验收**。停止、审计、补偿和恢复已有组件；跨边界部分失败的完整外部验收仍待补齐。 |
| WP11 | 统一 event envelope 并关联目标；至少接入代码库与任务/日历两个真实来源。来源、版本、时间、可信度、去重、授权可追溯，乱序/重复不重复动作，目标完成后退订。 | **实现中，未完成验收**。事件去重、目标关联和恢复已接线；代码库及任务/日历两个真实来源的完整验收仍待补齐。 |
| WP12 | 对机会做可解释排序，并支持静默准备、提醒和预授权执行；落实静默时段、合并、拒绝冷却、每目标预算，交付前验证功能/指标/安全，交付后持续观察采纳、漏报、打扰与收益。 | **实现中，未完成验收**。机会筛选、提醒、预算与冷却已有实现；提醒文本已不含估值与 id，并按目标来源与事件观测内容持久去重未变化提醒；后台通知的目的与字数预算尚未强制（见 WP19）。真实采纳、漏报、打扰及长期收益仍待评测，打扰成本仍为运营估值。 |
| WP13 | typed workflow/skill 描述输入、前置条件、依赖、参数、工具、验收和失败补偿；从失败及重复轨迹生成候选，覆盖至少 3–5 类真实高频流程，并绑定父版、原因、指标、权限差异和回滚目标。 | **实现中，未完成验收**。版本化技能/工作流、比较与回退已接线；3–5 类真实高频流程覆盖仍待补齐。 |
| WP14 | 对历史输入真实重放 baseline/candidate，以独立质量验收完成 shadow、密封留出、同预算比较、有限 canary 和自动晋升；独立验证、收益、回归三个 gate 必须同时通过。 | **已验收（原范围）**。限定 template-render 任务族的真实 TraeX 比较、独立留出和有限 canary 已验收；不等于通用流程收益。 |
| WP15 | 对推广后的 guidance/workflow/skill/plugin deployment cohort 持续监控；exact 版本退化自动关闭或回滚，撤票触发回滚，新增正向证据不误撤，重启后继续观察。 | **已验收（原范围）**。guidance/skill/workflow/plugin 四类工程验收；生产长期质量分布属于后续强化。 |
| WP16 | 沿 Control Plane 提供真实发布/启用 adapter：构建、签名、不可变版本、有限实验生命周期/存储、发布、验签、启用、监测和回滚；隐藏评测不可被候选读取或修改。 | **实现中，未完成验收**。已有 npm adapter、systemd 重启/就绪/回滚（进程内 reload 尚未交付，见下）、原生阻断回放；独立副作用观测、签名、后续有限推广及真实授权发布全链仍待完成。 |
| WP17 | 提供一致的自治安装入口、依赖预检、模型/预算引导、隔离 bootstrap、doctor、升级和卸载；全新临时 profile 能完成示例目标，重复安装幂等并保留配置和既有任务。 | **已验收（原范围）**。新 profile、示例 Goal、依赖修复和重复安装已验收；更多平台/升级卸载组合属于后续强化。 |
| WP18 | 完整仓库维护纵向切片：一次授权→真实 CI/issue→目标→隔离修复→独立验证→授权分支直接提交→精确提交 CI/readback→技能复用；真实模型/仓库/授权系统端到端，同类任务同预算改善，停止和回滚有效。 | **实现中，未完成验收**。已有真实模型修复、隔离检查与待审批提案；真实仓库事件→授权分支提交→精确 CI/readback→同预算技能复用全链仍待验收。 |
| WP19 | 注意力合同：Delivery 后台/owner 通知须携带 Host 校验的目的（result、attention 须绑定工作项与当前唯一结构化问题、answer 须指向原提问且一次有效），按 `Intl.Segmenter` 计词设硬上限（链接文字与地址计入，不许拆条规避），超长转附件；确认一次、按源触发跨重启去重，之后静默至结果/决策/阻塞，不重复未变化结果；同一工作项消息保序，丢弃有记录且不重排；后台进度默认对 owner 不可见。旧调用方先给默认值并审计，再分阶段强制。 | **实现中（第 1 阶段：审计）**。Delivery schema 31 对后台、owner 通知与 typed 结果通道持久记录目的、字数与 would-reject/would-attach 判定，只读 `inspectAttentionAudit`；不改变任何发送，未声明目的按 result 记录。尚无强制、附件转换或提醒文本修正；前台进度未覆盖，提醒文本外露估值与 id 仅记原因码，飞书进度默认直出。 |
| WP20 | 统一 intake 账本返回 stored/duplicate/filtered，重放返回原决策；Host 计算候选强度，未寄址群消息与未订阅事件仅在 owner 逐来源开启后以元数据/摘要进入 observe；inferred 候选的模型评估逐规则判定一次、引文须为认证原文子串，不合格降级 ignore 并记原因码；评估超时有界重排，连续失败记 unavailable，基于过时 Policy 的决策按新版本重排；observe 期无外部副作用。 | **实现中（第 1 阶段：确定性 intake 账本）**。WorkItems schema 10 新增只追加的 intake 账本：Host-only `recordIntake` 按 (source, sourceEventId) 记录 stored/duplicate/filtered、原因码与 Host 计算的 explicit/inferred/ignore 强度（名单同时限定寄址与跟进，非白名单跟进为 ignore/filtered 并记 `follow-up-not-allowlisted`），bot 封顶 inferred，内容重复只由不弱于本条的原行判定，重放（含重启）返回原决策且不写第二行；未寄址群消息与未订阅事件默认 filtered，owner 逐来源开启后才以元数据进入；只存布尔信号与摘要，不存正文，默认关闭、observe 可用、无外部副作用。评估合同：`assistant-work-items` 新增纯模块 `InferredIntakeEvaluationQueue`：只接受 `inferred` 候选，逐规则每 Policy 版本评估一次、只降不升、引文精确子串校验与原因码、有界预算、超时退避重排、连续失败 `unavailable`、过时 Policy 的条目待 Host 按新版本重新匹配（含新上限）后重排、回填决策须自洽、observe 仅记 would-accept；注入 evaluator，无真实模型调用、无 schema 变更，尚未接入 intake 账本与运行时；intake 账本尚未接入 lark-channel 等真实入站源；未订阅→Eval 缺失。 |
| WP21 | proactive/intake 的 execute 决策以冻结 Mandate 准入 WorkItem，验收绑定 TaskAcceptanceContract 与独立 verifier；inferred 仅在 auto 模式、匹配 Policy 规则与剩余预算同时成立时可执行，且只做被准入范围内的工作；派发时按 Mandate 依据逐类重验，Policy 变更不取消工作而是通知受影响的活工作项；工作线程上的人类跟进归该工作项，结束时未处理消息释放回判断；重放不开第二个工作项。 | **实现中（第 1 片：冻结 Mandate 准入；第 2 片：Policy 变更通知与跟进归属）**。WorkItems host-only `admitDecision` 以 `work-items/execute-decision/v1` 准入：decisionId 单独决定身份（不含 kind，普通信号键域隔离），跨窗口、终态与重启重放回到原工作项，同 id 不同 mandate 摘要为 `identity-mismatch`；inferred 须 auto、命名规则且剩余预算 ≥ 1，并须 Policy 以同一规则 allow（先以无副作用 `evaluate` 比对，不一致不扣 Policy 预算）；Mandate 冻结在既有 `authority_basis`（无 schema 变更），派发复核规则改变即 park（`mandate-rule-changed`）。第 2 片：host-only `noticePolicyChange` 以 Policy `evaluate`（无审计/预算）逐活项比较冻结依据，受影响项每 (item, policyVersion) 记一条持久通知（同一事务批量写入，单次至多 1000 项并以 `remaining`/`next` 游标续跑，不静默截断），不取消/park/wake，重启重放幂等；`ownFollowUp` 让工作线程跟进（身份为线程 + messageId）归该活项，项结束后 `releaseFollowUps` 把未处理跟进释放回判断（返回列表，无外部副作用）；仅追加事件行，无 schema 变更。预算为决策方上报事实；独立 verifier 绑定与 observe 决策记录缺失；尚无 intake/Delivery 调用方。 |
| WP22 | 每条通知的送达、反应、接受、拒绝、到期未理与 would-accept 吻合度进入 Evaluation canonical；收紧类参数（打扰成本、阈值、静默时段、停用噪声规则）有固定上下界并自动采用；放宽类（observe→auto、新准入规则）经密封留出重放（父版本与候选比较误报/漏报）与独立验收，在一次性预授权范围内自动采用，超出时向 owner 提一个结构化问题；拒绝/忽略率上升按 cohort 自动回退精确版本，正向证据不误撤，重启后继续观察。 | **未开始**。依赖 WP19、WP20；复用 WP14/WP15 机制。 |

WP14 的独立性证据限定于 after-freeze 任务生成与绑定，不证明模型训练数据独立或完整 OS 隔离；TraeX 历史运行只有调用次数预算，不能宣称 token/金额预算相等。WP15 的 plugin cohort 回滚原验收是账本关闭与重新激活路径；新 systemd 物理恢复组件不自动证明所有推广后生产场景。WP15/WP17 的后续强化不反向增加原关闭门槛。

