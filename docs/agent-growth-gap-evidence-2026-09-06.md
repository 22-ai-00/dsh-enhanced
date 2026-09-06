# 自主成长能力审计证据（2026-09-06）

本文只审计 Evaluation、Preference Learning、Evolution、Growth Experiments、Delivery workflow producer 与 Automations 的成长连接。依据为当前源码、测试实现与成长文档的最新补充章节；没有修改运行代码，也没有执行全套测试；另外复制既有 real-stack harness 运行了一个独立临时测试，验证 owner 后续否定的当前产品语义，完成后删除临时测试文件。源码位置以本次工作树为准。`real-stack` 表示真实服务组合，不等于真实模型、真实飞书或长期运行。DSH 上游已有 goal、plan、subagent 等基础能力；本文不把未在本插件库重复实现它们计为缺陷。

主要判断：项目已经具有严肃的可信证据账本、可恢复实验状态机与受限偏好学习，但尚不能从这些机制推出“通用智能持续提高”。当前自主成长主要覆盖固定偏好、少量静态 workflow 模板和需 owner 批准的文字 guidance。最紧缺的是可自动产生的领域结果证据、真正的对照评测、推广后的持续质量监控，以及将策略增益转化为版本化能力的统一路径。

## 1. 先区分安装范围

- `core` 只选择 personal-assistant 与 plugin-control-plane 顶层 bundle；`lark` 增加 Delivery、凭据、Lark 与 Preference Learning；`supervised` 再增加 Evaluation、Evolution、Growth Experiments、Heartbeat、Health、Recovery。[实际数组](../scripts/install/common.sh#L11)，[实际场景选择分支](../scripts/install/common.sh#L2168)。因此 Growth Experiments 是 **supervised 场景默认包含**，而非普通 core/lark 默认包含。
- supervised analyst 的日预算只有一次，workflow 实验日预算为三次。[profile 预算](../plugins/lark-channel/src/supervised-growth-profile.ts#L724)。这有助于约束成本，也意味着当前主动成长吞吐很低，不能把安装 supervised 等同于开放式持续研发。
- 文档是追加历史的验证账本，不能拿旧 WIP 结论覆盖最新实现。[最新 Memory/release 章节](continuous-personal-assistant-growth-verification.md#L269)已经覆盖旧的“晋升未接通、source release 延期”。Memory promotion 和 local release 均应记为已实现；真实远端发布、production activation 和 wall-clock long soak 仍未证明。[最新边界](continuous-personal-assistant-growth-verification.md#L320)。

## 2. 已有能力，以及这些能力究竟证明了什么

| 能力 | 当前源码证据 | 可以证明 | 尚不能证明 |
|---|---|---|---|
| 三分结果模型 | [evaluation/types.ts:1](../plugins/assistant-evaluation/src/types.ts#L1)、[types.ts:66](../plugins/assistant-evaluation/src/types.ts#L66) | execution、objective、delivery 分离，包含信任、证据、评测版本、成本指标 | 每种任务已有独立成功验证器 |
| 可信结果入口 | [evaluation/service.ts:362](../plugins/assistant-evaluation/src/service.ts#L362)、[automations/service.ts:624](../plugins/assistant-automations/src/service.ts#L624) | 普通调用者不能自称 trusted；Host producer 绑定真实 production run | 模型任务的业务目标已经被自动验证 |
| 最新任务证据投影 | [evaluation/store.ts:1241](../plugins/assistant-evaluation/src/store.ts#L1241)、[store.ts:1277](../plugins/assistant-evaluation/src/store.ts#L1277) | 矛盾 owner 反馈隔离为 conflict；不再简单按最后到达者覆盖；学习可 retract | 所有成长消费者都消费最新投影，见第 3 节 |
| 偏好自动启用 | [preference/service.ts:76](../plugins/preference-learning/src/service.ts#L76)、[catalog.ts:22](../plugins/preference-learning/src/catalog.ts#L22) | 固定 T1、TTL、数量/字节限制，默认六次行为证据阈值 | 能泛化学习任意任务策略或推理技能 |
| 偏好与身份绑定 | [delivery/service.ts:2449](../plugins/assistant-delivery/src/service.ts#L2449)、[service.ts:2480](../plugins/assistant-delivery/src/service.ts#L2480) | 仅 authenticated owner，验证完成 Inbox/持久回复与 owner lineage，发送 content-free 信号 | 任意自然语言纠正都能被精确理解 |
| 长期 Memory 晋升 | [preference/store.ts:756](../plugins/preference-learning/src/store.ts#L756)、[sqlite.ts:544](../plugins/preference-learning/src/sqlite.ts#L544) | 固定 memory.retention=long-term，多来源阈值，审批后确认、可恢复取消 | 通用经验可自动归纳成任意长期知识；当前 promotion 是单一 allowlisted key/value |
| guidance 归因及回滚 | [evolution/store.ts:1296](../plugins/assistant-evolution/src/store.ts#L1296)、[store.ts:1643](../plugins/assistant-evolution/src/store.ts#L1643) | 可信失败样本触发候选，exact exposure 后退化可撤销特定版本 | 新 guidance 已在采用前证明会改善任务 |
| 实验持久状态机 | [growth/service.ts:269](../plugins/assistant-growth-experiments/src/service.ts#L269)、[service.ts:357](../plugins/assistant-growth-experiments/src/service.ts#L357) | approval→replay→shadow→一次 canary→promotion/rollback，重启和 ACK 丢失可恢复 | replay/shadow 已构成行为质量的对照实验 |

## 3. 结果纠错有两个必须分开的层次

### 3.1 已动态验证的产品限制：第一次目标判定不能被后续 owner 纠正

复用 `real-stack.spec.ts` 的真实 Delivery/Policy/Automations/Evaluation/Growth 服务与独立临时 SQLite，在 canary 获得 `/feedback achieved` 后，再通过同一 authenticated owner 对 exact result message 发送 `/feedback not-achieved`。结果是：

- Delivery 明确回复“该次任务已经记录了不同的任务结果；为避免重复计票，本次未覆盖原记录。”
- Evaluation 最新任务仍为 `achieved / ready / upsert`，未生成 `objective-conflict / retract`。
- 沿既有流程继续后，experiment 仍达到 `promoted`，Automation active version 2；后续 owner workflow retract 仍能正确回滚。

这不是绕过已生效的 retract：用户被明确告知第二次判定未覆盖第一条。它证明的是**当前缺少 owner 修订/撤回任务目标判定的产品能力**。成长系统需要支持“刚才以为成功，后来发现并没有成功”这个常见反馈，否则旧的错误成功标签会永久影响后续实验。

原因是 [Delivery/service.ts:2781](../plugins/assistant-delivery/src/service.ts#L2781)的目标反馈幂等键固定绑定结果/run，不包含 judgement 或事件；[Evaluation/store.ts:569](../plugins/assistant-evaluation/src/store.ts#L569)对不同 payload 抛 idempotency-conflict；[Delivery agent-runtime:2310](../plugins/assistant-delivery/src/agent-runtime.ts#L2310)向 owner 明确返回“未覆盖”。建议增加显式修订/撤销命令，保留历史审计，但为同一任务推进 canonical revision；重复同值继续幂等，修订不得增加任务投票数。

临时命令：`pnpm exec vitest run plugins/assistant-growth-experiments/tests/audit-temp-canary.spec.ts --maxWorkers=1 --no-file-parallelism`。最终结果 `1 file / 1 test passed`，测试时长 308 ms，总时长 915 ms；临时文件已删除。首次试图断言 objective-conflict 的两个运行失败，原因正是第二次 owner 判定被拒绝，随后将测试断言修正为验证上述真实产品行为。它们不能被描述为 raw/latest 缺口的动态复现。

### 3.2 静态正确性风险：Workflow canary 未使用最新结果投影

以下为静态代码审计发现的高优先级正确性风险，尚未动态构造出具有已生效 conflict/retract 的 canary；不能写成已复现事故。

1. [Automations `inspectWorkflowCanary`:1158](../plugins/assistant-automations/src/service.ts#L1158)调用 `evaluation.query` 搜索 `trusted + achieved`，再通过 `getTrustedOutcome` 取证。只要找到唯一 matching achieved 原始记录，就满足 passed。
2. [Evaluation `query`:974](../plugins/assistant-evaluation/src/store.ts#L974)实际查询 append-only `evaluation_outcomes`；[getTrustedOutcome:485](../plugins/assistant-evaluation/src/service.ts#L485)也只读取原始 outcome。
3. 但 Evaluation 已在[任务投影:1241](../plugins/assistant-evaluation/src/store.ts#L1241)把互相矛盾的 owner judgements 设为 `objective-conflict`，并在[学习投影:1277](../plugins/assistant-evaluation/src/store.ts#L1277)设为 unknown/retract。raw achieved 不会因此消失。
4. 所以一条 achieved 后又存在 not-achieved 时，canary 查询仍可能找到唯一旧 achieved，并忽略 conflict。即使 inspect 时结果有效，后续 [promoteWorkflowAutomation:1215](../plugins/assistant-automations/src/service.ts#L1215)也只检查保存过 evaluation id/digest，没有在激活 CAS 前重新验证 latest task revision。

建议先修这条链，再扩大成长权限：使用 exact canary run 的 canonical task projection；要求 ready、trusted achieved、最新 revision/digest，并在 promotion 的副作用提交前进行跨账本 writer fence。Evaluation 已给 Evolution 提供[最新投影 API:510](../plugins/assistant-evaluation/src/service.ts#L510)和[writer fence:523](../plugins/assistant-evaluation/src/service.ts#L523)，应复用同一语义。新增三个测试：批准前冲突、inspect 后 promotion 前纠正、重启后旧 achieved receipt 重放；都必须拒绝升级。

## 4. 普通使用自动学习的真实范围很窄

Preference 的被动路径目前提取 `response.language`，而不是开放语义的工作方式。[Delivery completedPreferenceEvents:2449](../plugins/assistant-delivery/src/service.ts#L2449)先分类持续选择/普通内容，随后[只为观察创建 response.language:2554](../plugins/assistant-delivery/src/service.ts#L2554)。其他 T1 包括详略、结构、解释深度、建议频率、推荐排序，均为[固定 catalog 与 renderer](../plugins/preference-learning/src/catalog.ts#L22)。这是可用的个性化起点，但还不是从失败中学会新算法、研究方法或领域知识。

Workflow 自动 producer 更窄：

- 只有每日和每周工作区状态摘要两个静态模板、六个 exact selector，固定 UTC cron，既不 trim 也不折叠大小写。[workflow-auto-producer.ts:24](../plugins/assistant-delivery/src/workflow-auto-producer.ts#L24)、[selector:49](../plugins/assistant-delivery/src/workflow-auto-producer.ts#L49)。
- 一次正常完成回复不会自行产生 verified-repetition。必须 owner 对 exact delivered message 回复 `/feedback achieved`，否则不能形成可信 trace。[store.ts:5630](../plugins/assistant-delivery/src/store.ts#L5630)、[source/feedback 验证:5678](../plugins/assistant-delivery/src/store.ts#L5678)。
- 三次 verified success 或一次 owner-explicit 即可让候选 ready。[growth/store.ts:738](../plugins/assistant-growth-experiments/src/store.ts#L738)、[service 默认:35](../plugins/assistant-growth-experiments/src/service.ts#L35)。形成 ready 后又会生成审批 proposal。[growth/store.ts:407](../plugins/assistant-growth-experiments/src/store.ts#L407)。
- 任意自然语言、含附件或 selector 之外的任务会 privacy-abstain；owner 可以走 `/workflow save`，但那是显式定义流程，不是无需编排的重复流程发现。

建议把“内容不进入成长账本”和“只能支持两个固定模板”解耦：在原任务 scope 内生成去敏的 typed action graph、参数槽、资源引用及每步回执；成长账本只接收规范化结果和 digest。先覆盖真实高频 3–5 个流程，逐类增加可信 extractor，避免一开始无限制抽取任意文本。

## 5. 结果证据不足导致成长依赖人工反馈

[Automations terminal producer:637](../plugins/assistant-automations/src/service.ts#L637)只有固定 Host runbook 能从执行终态给 objective achieved/not-achieved；普通 Agent run 的 objective 固定 unknown。这个保守语义正确，但意味着必须补上任务级 verifier 才能实现无需人工评分的成长。

现有 [Evaluation 自评 workflow:56](../plugins/assistant-evaluation/src/service.ts#L56)会结合 Memory 和 run result 进行自评，但固定为 self-reported，不能作为可信生产升级证据。最新投影还明确[排除 Host runbook 作为 guidance 学习样本](../plugins/assistant-evaluation/src/store.ts#L1281)。因此“系统维护成功”不能自动供给“一般任务越来越聪明”的训练信号。

真实组合测试反映了这个现状：[real-stack.spec.ts:560](../plugins/assistant-growth-experiments/tests/real-stack.spec.ts#L560)由测试模拟 owner 发 `/feedback achieved` 才让 canary 获得可信目标成功并进入推广。测试证明协议接通，不证明模型能独立评出真实工作价值。

建议添加 `TaskAcceptanceContract` 与按任务种类选择的 verifier：代码任务连接独立测试/行为断言，文档任务连接引用完整性/事实可追溯检查，日程任务连接 provider 回读，流程任务连接原始业务约束。保存通过/失败/未知及证据，当前运行 Agent 不得修改其自身验收标准。主观质量可用独立模型评审作为辅助，但必须校准其与 owner 返工、后续结果的一致性。

## 6. replay、shadow、canary 的名字强于当前质量证明

- [replayWorkflowAutomation:1038](../plugins/assistant-automations/src/service.ts#L1038)不重新执行历史任务。它对 evidence/template/steps 计算 digest，仅以 `evidenceCount > 0` 判 passed。[直接判断:1062](../plugins/assistant-automations/src/service.ts#L1062)。
- [shadowWorkflowAutomation:1070](../plugins/assistant-automations/src/service.ts#L1070)确实执行且要求工具/投递 effect blocker，但 passed 只依据 `run.status === 'succeeded'`。[判断:1095](../plugins/assistant-automations/src/service.ts#L1095)。
- [canary:1110](../plugins/assistant-automations/src/service.ts#L1110)有一次 production exposure 上限并要求可信 achieved；这是最强的当前目标验收关，但一次成功不能证明相对基线更优。
- [real-stack 的 LLM:105](../plugins/assistant-growth-experiments/tests/real-stack.spec.ts#L105)是固定输出 `Growth canary completed.` 的 adapter；其真实 AgentLoop、SQLite、Policy、Delivery 组合测试很有价值，但不能用来声称推理能力得到提高。

建议将当前 replay 定位为证据完整性检查，再增加真正的 replay runner：固定历史输入、工具快照、独立验收与基线策略，对新旧策略运行相同任务；shadow 同时记录质量、成本、延迟、失败原因，canary 按任务族和风险逐步扩样。明确区分“可执行”“达成目标”“优于旧策略”三个 gate。

## 7. Guidance 演化是失败阈值驱动的经验文字，不是完整策略搜索

[Evolution candidates:1296](../plugins/assistant-evolution/src/store.ts#L1296)按 situation 聚类，以最少样本和失败率阈值发现 adopt/retire。默认窗口 20、最少 5 次、失败率 0.4。[配置:89](../plugins/assistant-evolution/src/service.ts#L89)。Analyst 选择一个高失败率候选，模型生成 guidance，然后进入 owner proposal。[选择:768](../plugins/assistant-evolution/src/service.ts#L768)、[提案:801](../plugins/assistant-evolution/src/service.ts#L801)。最终是向 prompt 注入 advisory learned guidance。[guidance.ts:38](../plugins/assistant-evolution/src/guidance.ts#L38)。

这能积累实用规则，但当前候选没有显式的多策略备选、实验假设、根因类别、成功概率、预期节省、迁移适用条件或基线对照。失败率排序也不是改进价值排序：昂贵而少发生的故障可能比大量便宜失败更值得解决，工具/环境故障也不应总转成文字提醒。

建议将候选分为事实/偏好修订、环境修复、策略改进、工具缺口、模型能力不足五类；允许生成多个候选，但在固定预算内以验证净收益排序。策略改进至少绑定触发条件、不可变验收、基线、预期收益、作用范围、撤回条件，避免 guidance 不断变长却不再带来收益。

## 8. 推广后的质量反馈还未形成统一环路

Growth tick 的[runnable 查询:458](../plugins/assistant-growth-experiments/src/store.ts#L458)排除 promoted；没有周期读取已推广 Automation 目标质量的 monitor。当前推广后回滚主要来自来源 trace 的修订/撤回，[invalidateCandidateExperiments:786](../plugins/assistant-growth-experiments/src/store.ts#L786)会把已有 artifact 设为 rollback-pending。真实组合测试的 rollback 正是[owner retract:629](../plugins/assistant-growth-experiments/tests/real-stack.spec.ts#L629)，不是生产中出现质量退化后自主诊断并撤销。

另一个需要产品决策与回归测试的语义：新正向 trace 改变 evidence digest 时，[recomputeCandidate:767](../plugins/assistant-growth-experiments/src/store.ts#L767)同样调用 invalidate，后者查询不排除 promoted。静态推导上，增加一条同流程成功证据也可能撤回已经推广的版本，再开启新审批周期。这是保守 immutable evidence 设计的连带效应，尚未单独动态复现，不能把它理解为智能质量回归监控。

Evolution 有 exact exposure 的退化回滚，可作为实现参考。[rollbackRule:1643](../plugins/assistant-evolution/src/store.ts#L1643)。但它仍使用有限样本的经验失败率比较，缺少任务难度/模型版本等变化的控制变量，也不是统计因果增益证明。

建议新增推广后 quality monitor，独立维护 deployment cohort、最新 evidence revision、任务族、观察窗口及自动暂停/回滚规则；区分“证据被撤销/冲突”与“新证据增加”，增量成功不应自动撤销有效部署。将同样机制用于 guidance、workflow、Skill 和插件，而不是各自只记录一次 promoted。

## 9. 建议落实顺序与验收

1. **结果正确性优先。** 修复 canary latest projection 与 promotion fence；验收包含矛盾反馈、迟到纠正、并发升级、重启重放。否则更多权限只会放大错误证据的影响。
2. **让成功变得可观察。** 选 3–5 类真实高频任务，接通 acceptance contract 与独立 verifier；以可信 objective 覆盖率、unknown 比例、误判成功率验收，不能只数 tool success。
3. **让改进变得可比较。** 建立固定离线任务集与按任务族的 replay/shadow 比较，报告成功率、每次成功成本、时延、owner 返工率及置信区间。模型和工具版本、数据快照都须固定或记录。
4. **让成长真正自动运行。** 将 verified structured traces 接入 workflow discovery，扩大受控模板抽取；将新策略自动测试、低风险 canary/推广与质量监控连起来。预算内可自主选择实验，只有扩大授权范围或产生高后果时升级 owner。
5. **再扩大能力演化。** 将已证明增益的策略沉淀成 versioned guidance、workflow、Skill 或插件；沿现有 control-plane local release/activation 边界接通真实远端适配器和长期 soak。不能用本地模拟回执替代真实发布/长期质量证据。

安全与高自主可以协同：把高权限授予明确 scope、限时预算与可撤销 capability，让执行体在范围内自主试验；验收标准、授权上限、凭据代理、紧急停止和版本推广证据由独立运行边界持有。关键不是反复询问每个步骤，而是确保失败能被识别、影响受界定、变更能撤销、证据不能被执行体重写。
