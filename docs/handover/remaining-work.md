# 剩余功能实施方案

本方案按依赖顺序交付，不按目录逐个“补功能”。完整成功条件仍以[验收合同](../rsi-acceptance.md)为准；WP01–03、14–15、17 保留原已验收范围，仅补受影响的回归，不重新扩张全部旧门槛。未验收的普通任务实现封装在交接 patch 中。

协调者负责契约、跨插件接线、集成与最终判断；可把独立路径交给实现者、只读探索者并行处理，每个可写文件同一时刻只有一个负责人。实质代码改动必须交给独立复核者，要求真实命令、退出码和输出，不能只接受实现者自评。

<a id="A"></a>
## A：先把已有续办能力交付完

**用户价值**：主人回复一个已有任务后，助手续办并报告可信的结果；缺少独立验收时不能发“完成”。本补丁仅覆盖非 diagnosis 的 active 部署中的既有 owner continuation，不证明首次任意委托已打通。

涉及 `assistant-work-items` 的 continuation/dispatch/acceptance-binding/service/store、`assistant-automations` 的 native/host execution/operator/store/sqlite、Lark retirement 与安装兼容；完整路径见 [39 文件清单](ordinary-files.tsv)。先恢复 patch，不重写相同接线。

已实现但仍待完整验收的契约：

1. 从认证续办保存原始目标、来源、实际供应者与有限预算；在首个 worker 模型调用前由真实 Delivery 与 Verifier 准备本次验收。
2. Host proof 绑定同一 occurrence/attempt、原生 outcome、不可变 run、已结算预算和当前 owner。schema 17→18 添加可空 `host_proof_json`；旧行保持 NULL，旧 writer 不能继续写 18。
3. WorkItems 在尚未绑定验收时也持有 ready 报告；晚绑定、重试、重启只能接受当前 worker/occurrence/receipt；配置关闭不能绕过已经冻结的要求，旧 v1/v2 计划保留旧要求。
4. timeout 保持未验证，worker 自述与 Evaluation 的未知结果不能升级为成功。安装和退休覆盖 schema 15–18，19 拒绝。

### A1：修复唯一已知的最新包测试阻断

入口 `plugins/assistant-isolation/tests/controller-startup.spec.ts` 的 `does not steal a renewing live controller lease`。最新快照 39 包已全部结算，只有这一项失败；[证据](verification.md)保留了所有此前失败，不把它笼统称为 flaky。

当前用例以 500ms lease，100ms 续租间隔和 750ms 等待推断“活租约仍有效”，但构建 Context/挂载发生在续租 timer 注册之前，且忽略续租返回值。生产事务只拒绝尚未过期的他人租约；renew 同时要求 owner、fence 与未过期。事件循环停顿可能让租约合法过期。`settled === false` 只证明 mount Promise 未结束，不能证明它尚未取得租约；旧日志也未记录每次续租结果，尚不能归因生产抢锁缺陷。

建议最小修复步骤（尚未实施）：

1. 先读 Controller/ledger 的 claim、renew、timeout 和 dispose 路径，确认构造时捕获 clock 的方式。
2. 在两个 ledger 构造前控制 Date、timeout、interval；保留真实 SQLite 事务、500/100/750ms 和原业务断言。
3. 逐步推进 750ms，断言七次真实续租均返回 true；透传 spy 记录竞争者 claim 的时间和结果，必须存在初始 500ms 到期点之后仍被拒绝的尝试。
4. 断言 owner/fence 不变、mount 仍等待；释放旧 owner 后验证接管与清理。恢复 timer/spy，确保断言失败也 dispose。
5. 保留相邻主动释放、自然过期、等待超时用例，不拉长 timeout、不加重试、不 skip。如果受控证据仍显示未过期租约被抢，再单独修真实实现与回归。

仅改该 fixture 时独立提交最小修复可以先解开 CI 与普通任务共用阻断；它不属于已保存的 39/8 路径 patch，修改后另记目标 hash。

### A2：定向验收与最后完整门

先按[启动说明](README.md)安装并构建，在 Linux 运行：

```sh
pnpm --filter @dsh-enhanced/assistant-isolation test tests/controller-startup.spec.ts --testTimeout=15000
pnpm --filter @dsh-enhanced/assistant-work-items test tests/owner-continuation.integration.spec.ts tests/continuation-runtime.spec.ts tests/runtime.spec.ts --testTimeout=15000
pnpm --filter @dsh-enhanced/assistant-automations test tests/host-agent-execution.spec.ts tests/store.spec.ts tests/operator.spec.ts tests/retirement-snapshot.spec.ts --testTimeout=15000
pnpm --filter @dsh-enhanced/assistant-delivery test tests/agent-runtime.spec.ts --testTimeout=15000
pnpm --filter @dsh-enhanced/assistant-memory-learning test tests/work-item-feedback.integration.spec.ts --testTimeout=15000
pnpm --filter @dsh-enhanced/lark-channel test tests/rsi-scanner-retirement-runtime.spec.ts tests/rsi-scanner-retirement-stage.spec.ts tests/rsi-scanner-retirement-transition.spec.ts tests/supervised-growth-lifecycle.spec.ts --testTimeout=15000
```

按当前文件名确认命令；继承本轮工具链、有限并发与超时。定向完成后一次新的冷标准 `pnpm check`，包含根测试、39 包和每包 pack；若包数量因新 dev 变化，以实际 manifest 为准。不要把先前各轮通过项拼成一次完整 PASS。

独立复核须确认：真实 Host/Delivery/Verifier 组合的正确目标、错误目标、缺 profile；缺 profile 在 worker 首个模型请求前阻断；重启/旧回执/配置关闭/旧计划；schema 迁移兼容；拒绝后没有泄漏执行权。现有真实组件组合仍使用有限 fake LLM 与固定写入工具，不能写成真实外部模型和渠道验证。

### A3：收束仍未解决的产品语义

以下是后续工作，不能随 A2 通过宣称完成：

- 缺 profile 虽已做到零 worker 请求，外层 unknown 与 finalized budget 可能让任务停驻；确定可解释的 blocked 原因及 owner 修改后新 attempt 的恢复路径，保持已耗预算不可复活。
- 文件准则只证明批准路径当前内容，可能是旧文件；若任务要求“本次创建/修改”，补独立 before/after 事实与本次 run 的关联，不能只比文件 hash 就认定因果。
- “报告已排队”后发生 owner 更正、撤回或 receipt 失效，需要发送时重新检查；provider 接受不等于 delivered/read 或任务被认可。复用 Delivery 的既有撤回/反馈接口。
- 默认 diagnosis 配置迁移必须另行有界验证，不把 active 非 diagnosis 的证据推广到默认首装。

本工作包交付：最小 fixture 修复、续办能力、当前状态/契约更新、真实完整门与独立 PASS、精确提交 CI。验收后移除已吸收的普通 patch 与旧文件清单，历史从 Git 查，避免双份实现长期存在。

<a id="B"></a>
## B：首次自然语言委托到结果验收

**目标**：从空任务账本出发，主人正常说“帮我完成这件事”，助手冻结目标、判断需要什么证据、执行、独立验收并汇报；用户不必先写结构化准则或为每项任务配置 profile。先支持可独立测量的任务，无法核实的任务明确保持 unknown/blocked。

### B1：复用生产入口，冻结真实意图

先追踪 `assistant-goals/src/tools.ts` 的 `goal_create(start_native_rounds=true)` → `service.ts` 的 owner/Policy 校验 → 原生 Goal → Delivery native driver → Goals `execution.ts` 的 step 验收与 `outcome.ts` 的全目标结果。现有工具的 objective 来自模型参数，不能当成认证原话；以后多轮执行的实际 supplier 也需要明确冻结。

从 Delivery `readOwnerForegroundToolInput` 与 agent-runtime 已保存的本次请求事实取得原始消息、owner、Inbox/session/tool 关联，和规范化目标一起持久化。冻结实际 supplier、预算、验收版本与执行身份；继续使用原生 Goal/Session/run，避免新建平行任务循环。明确 Goals 与 WorkItems 的身份映射、唯一主状态、恢复责任，不能假设两者已经等价。

先做小 schema/生产接线探针，再安排集成：伪造 owner、过期 human turn、错误会话、改写目标、供应者变化、预算耗尽和重放都不能得到执行权。普通问答保持原交互。

### B2：让准则来自受保护的准备阶段

现有 Verifier 只匹配批准 profile，future assessment 需要已配置 digest；A 的 preflight 只覆盖固定 exact profiles。需要将“准备准则”变成受限、可审查的生产阶段：

1. 受信准备者读取原始目标和已授权资源，产出有限、可执行的候选标准，优先复用现有确定性 drivers；区分 step 成功与全目标成功。
2. 独立 Verifier 校验来源、权限范围、路径/目标、可判定性，封存 contract/digest；执行候选无权改 acceptance 或留出集。
3. worker 只读冻结合同，运行事实按 goal/definition/run/assessment 精确绑定；缺失或模糊标准在执行前阻断，需要澄清时只问最关键的问题。
4. 重启与恢复使用原 supplier/预算/合同；重新定义目标要显式新版本，失效旧回执。错误结果不能凭 worker “成功”或工具 exit 0 通过。

受保护不一定需要新插件。先检查 Verifier/Goals/Policy 的已有类型和执行 driver，再选择最小契约改动；跨插件注入和生命周期变动要读 Cordis 运行时合同并对锁定 fork 做探针。

### B3：验收真实完整路径

至少两种普通自然语言任务，从空账本进入，不能预置逐任务 objective profile。正确状态通过，错误/陈旧状态拒绝，worker 不能改准则；无授权或准则不可判定时执行前零 worker 请求。覆盖跨会话、重启、重复消息、owner 更正/撤回、实际 supplier 和预算冻结。外部提交未知时先读回核对再重试。

先真实组件+有限供应 fixture，再使用 owner 已批准的真实模型/目标系统做小规模任务；单独记录实际投递事实和用户验收。交付至少包含“原始委托→合同→运行→外部状态→独立结论→通知/反馈”可追溯证据。固定用例只是回归，不等于普通使用已经能自主泛化。

<a id="C"></a>
## C：全新安装就能使用，以及普通使用中的学习

入口：Lark supervised-growth setup/profile、安装 lifecycle、`assistant-memory-learning` 和 `personal-memory`。先装配依赖/预设并验证 readiness，再发学习授权；修复 skip/decline/失败语义、重装幂等和真实失败传播。fresh supervised 默认 `digest` ceiling 是授权边界，不得在装配时静默提高到 auto。

逐项交付：

1. 空 Home 完成首装、owner 绑定、预设加载与必要 WorkItems 接线；拒绝或跳过不产生授权；失败显示真实阶段，重试不重复授权或覆盖既有任务。
2. 认证结果、纠正与撤回进入事实/经验候选，经独立审查后持久化；用原任务版本去重，lost ACK/重启不可重复学习，撤回与冲突传播到索引和后续召回。
3. 召回附来源、适用条件、反例、失效条件；围绕当前 goal/step/query 使用，源状态变化时重查。
4. 用后续真实任务记录模型是否选择召回、是否改变决策、返工/成本是否降低；提取、写入或采用成功不能单独作为收益。

验收：fresh profile 实际生效、skip/decline 零授权、重装保留状态；完整认证反馈链和撤回；随后至少几个频繁真实工作流的正负样本。先交可安装能力，长期收益持续观察。

<a id="D"></a>
## D：工程成长与真实外部执行

入口：Control Plane 的 `revision-capability-runtime`、`task-observation-runtime`、`source-release-runner`、`in-process-reload`，以及 Actions、Isolation、EventTriggers；修改前以当前源码确认文件位置。已有修订 v3 审查证书只表示审查结果，不能授予自动采用。

依次完成：

1. 修复修订收益投影误走创建账本；在请求入队时冻结供应者和审查预算，避免恢复时从活配置静默换模型；补采用前 parent/candidate 配对样本。
2. 普通失败、纠正和重复需求驱动 create/revise 候选；冻结 parent、artifact、权限差量和 rollback，保留失败尝试。候选生成入口必须调用已有 holdout 隔离守卫，不能只测试守卫函数。
3. 真实 build/sign/verify → Cordis load/readiness → 独立效果验证 → bounded adoption → 精确 parent CAS → 观察/rollback；接线与 Loader/Include 的锁定版本逐项验证。
4. 迁移旧 opt-in Native E2E 和 `check:quick` Git 过滤；先 Linux namespace/cgroup v1，后 cgroup v2、arm64 与活 Home 迁移，各自列独立证据，不能用 fixture 或 skipped 测试替代。
5. WP08–11、13、16、18 的真实链路：CI/issue 事件→Goal→隔离修复→独立测试→授权 dev 提交→精确 CI/目标读回→后续技能复用。broker 将身份、凭据、网络和发布权限与候选写权限隔离；撤销/停止/补偿可执行，未知结果先核对再重试。
6. 至少两个真实事件来源（如仓库与任务/日历），验证来源认证、去重、乱序、重启、取消订阅与 owner 边界；不再造另一套轮询循环。

实验版发布条件：安装、运行 readiness、完整检查、包内容及发布协议通过后，可发布明确标注边界的实验版本；长期成长收益继续观察。必须独立验证、有限预算、已有 owner 授权和可回退，不能为等纵向实验而无限阻塞发行，也不能把实验发行称为完整闭环已验收。

<a id="E"></a>
## E：主动性与通知闭环

入口：Delivery attention、WorkItems `recordIntake`/`admitDecision`/`settleAcceptance`、Proactive evaluator、Evaluation canonical feedback。当前生产已有 intake evaluator 注册，不沿用早期审计的缺注册结论；先检查活接线。

1. 逐来源 observe，记录 would-accept，再与真实 owner 结果进入 canonical 的结果比较；保留原始文字、来源分类与降权规则，设有限预算与幂等键。
2. inferred 准入传递原始目标和验收合同，先做 A/B 中已能核实的任务；不能以“规则命中”代替任务授权或结果验收。
3. 通知用途、文字硬上限、真实附件、同项顺序、一次关键问题/一次答案必须经过实际通道；区分 accepted、delivered、read、adopted、rejected、ignored、missed。
4. 只有独立密封留出比较通过、一次性预授权覆盖时，才允许 observe→auto 或新准入规则；父版本精确绑定，负向 cohort 恶化可回退，正向证据不误撤。
5. Dream 默认关闭、私有 idea 不自动晋升；Web GUI 在真实使用中验证状态、证据、停止/纠正与回退入口。

不以通知发出数衡量成功；衡量实际帮助、误报漏报、打扰和 owner 协调次数。

<a id="F"></a>
## F：证明长期改善，而不是只证明模块存在

WP04–07、12–13、19–22 使用 3–5 个经常发生的真实工作流，在相同 supplier 与有限预算下比较 parent/candidate。固定回归、独立 held-out、真实随后任务分开，冻结后生成的任务不能进入候选写权限。

记录任务成功率、质量、成本、延迟、返工、人工协调、误报/漏报和打扰的分布，不只平均数；分别消融规划、策略选择、独立复核、成长与记忆，包含失败尝试和回滚。部署关联不能当成因果改善，模型评分与估计成本不能自证真实收益。

交付顺序是：可用的普通任务闭环 → 可安装的学习和工程成长 → 有界主动性 → 后续真实收益。不要同时开启所有 WP；每次选择一个可独立使用、可验收的能力，更新短状态页，提交推送后再扩展。
