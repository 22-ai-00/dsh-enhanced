# 原生目标策略的比较协议

本协议对应落地账本 WP04/06。当前已实现策略子任务、共用 Goal 预算、执行诊断和 exact parent-step 的独立验收关联；已新增冻结策略契约、进程内全 cell meter 与真实临时 Delivery/JSONL owner 装配；已接通单 cell 的真实 Goal/隔离产物/独立 Verifier 与关闭后证据保存，但下述固定预算比较 executor 尚未实现，不能把已有安装测试或 persona 比较计作策略收益。

## 可复用入口与需要替换的假设

`assistant-evaluation/src/benchmark/native.ts` 当前只运行一次无工具模型调用，并把 `toolCalls` 固定为 0。沿用其中的单调用拦截器会拒绝真实策略；仅切换 persona 也没有运行 `goal_strategy`。保留 `runner.ts`、`store.ts`、`schema.ts`、`report.ts` 的冻结计划、cell 身份、配对与 unknown 语义，为新的 `strategy-v1` 使用单独 executor。旧研究/记忆 suite 的版本和行为保持可复现。

## 两个比较分支

两分支均装配真实原生 GoalService、goal-round-driver、Delivery owner、Goals 独立步骤/整体验收与同一模型 adapter。使用相同初始任务、公共 persona、验收模板、公共工具、非策略 Policy、轮数上限和总预算；candidate 只额外提供 Goals 策略工具及其必需的最小授权。不能用“无 Goals 的一次回答”对比“有 Goals、反馈和多轮重试的完整策略流程”，否则无法把差异归因于策略。

- `direct`：保留直接解题和独立反馈修订，不提供策略工具。
- `adaptive-strategy`：提供实际 `goal_strategy`，由父 agent 决定是否调查、复核、比较或直接继续。记录实际是否调用以及子任务数量；未选择策略不伪装为已执行的消融，也不因没调用就判任务失败。

固定两个分支的模型、任务输入和非策略 persona 摘要；策略工具描述、guide 和历史是候选能力的可见差异，不能声称完整 system prompt 逐字相同。能力、Policy、运行时与 adapter 的精确版本分别进入 plan digest。每个 cell 使用新的私有工作区、owner、Session 和账本，不让前一分支留下答案或记忆；比较等价的验收模板/criteria 摘要，而非不同 owner 的 contract/receipt 摘要。模型只能看到公开任务；独立验收答案不进入 prompt、工具返回或策略材料。

## 总预算与真实执行边界

每 cell 的外层 meter 必须在第一个前台模型请求前生效，汇总前台准入、父目标、子任务和工具结果后的所有模型请求。已有 Goal budget 从原生目标回合开始计量，单独使用它会漏掉前台协调开销。保留生产 Goal 内层准入与子预算绑定，同时以外层总预算约束完整 cell；缺少任一 usage、仍 held、无法确认停止或超预算均不能记为完整比较结果。

所有分支使用相同 input/output/tool-call/duration 限制及模型调用上限。现有 `BenchmarkBudget`/`BenchmarkMetrics` 没有 model-call 字段，schema v1 也拒绝额外字段；需要新增计划 schema 或独立 strategy-plan parser，冻结 modelCalls、单请求输出上限及外层总限额，并由 executor 请求前强制执行。只保存配置哈希或依靠原生轮数限制不足以实施总预算。外层 meter 必须有预留、结算和 unknown 保留语义，不能仅事后相加。真实供应商不支持可信请求前输入上界或输出限额时，显式记录观测模式；没有费率就不声称金额硬限。不能通过放大 candidate 预算、忽略 failed child 或退还 unknown 来取得“收益”。

现有 `BenchmarkMetrics` 可承载聚合 token、费用、工具次数、延迟与返工；返工定义为独立 not-achieved 回执之后新增的父 Goal 回合，不能从模型文本推断。现有 journal 仅保存 plan/cell/result，结果只有 `evidenceDigest`，尚无详细策略证据存储。新 executor 必须在候选无法写入的 Host 私有目录持久保存不可变证据对象，记录父/子模型调用、策略类别、失败阶段、held 数、准确的验收 run/receipt 和资源停止结果，并把协议版本和对象摘要绑定到 cell result；读取时复核摘要、plan digest 及 cell 身份。不能只保存摘要而丢掉核验依据。

## 独立结果和归因

验收首先判断最终任务产物是否满足固定条件，不以建议非空、native complete、调用了策略或模型自评判成功。第一组实际任务优先复用已安装的隔离产物→独立容器验证链；可以使用公开合成开发题验证接线，但不得称为隐藏留出或生产收益。

策略历史的 `parentStep` 只读关联当时那个父 run 并重验已有回执，本身不执行验收。它可以同时显示“建议已返回”与“父步骤未达标”；后续修复成功不覆盖这条历史。执行阶段诊断用于分开报告调用/工具问题和独立条件失败，不能据此断言失败必然源于推理。策略因果收益只由同预算配对实验支持。

沿用任务簇配对统计和多次重复；unknown、缺少分支或过少任务不能给出增益区间。通过候选比较不自动授予推广、扩权或发布资格。验收顺序是：实际生产路径 fixture 接线、真实模型公开开发比较、冻结候选后的独立留出和综合回归；不设置人工日历等待期。

## 实现验收

先补 `strategy-v1` CLI 配置、doctor 依赖集、原生 Goal/subagent peers、executor 与可信 adapter 接口。新 executor 必须实际产生父 Goal 回合、策略工具执行与原生 child Session；比对外层全部 usage 和内层 `strategy-*` 预留，证明协调开销未遗漏。测试必须包含策略未选择、策略报错后直接修订、真实模型故障、共享限额拒绝、错误答案被独立验收拒绝、取消/撤权与迟到子任务停止。最后从已安装 CLI 运行两个分支并保存可核验结果；仅配置校验或内存替身不足以完成 WP06。

## 已落地的执行基础（2026-09-07）

`benchmark/strategy-plan.ts` 是独立严格 parser：冻结共同/策略能力摘要、精确两个分支及 modelCalls/单次输出/Goal轮数，并把契约摘要绑定至既有journal runtime版本。`benchmark/strategy-meter.ts` 在所有模型请求前共享预留，覆盖前台/父/child和实际工具调用，未知预留不退还；当前仅接受 upper-bound/provider，观测模式尚未实现。`benchmark/strategy-owner.ts` 使用真实 Delivery、Policy、原生 Session/AgentLoop 与 JSONL，显式持久化初始空会话头，再恢复执行，回复仅进入本地捕获通道。

这些基础接口尚未组成完整 strategy-v1 executor。下文已接通单 cell 的原生 Goals/Verifier/Isolation 装配和不可变详细证据；完整比较调度、独立隔离产物语料、能力实装核对、CLI/doctor、真实模型公开开发比较及冻结留出仍待完成。进程内 meter 快照不替代完整 cell 证据，不能仅靠摘要或单测认定比较有效。

## 原生 cell 与完整回执（2026-09-07，基线 eb106bb）

`createStrategyGoalRuntime` 将现有基础装配为一个实际原生目标 cell：确切公共任务和验收模板与计划摘要相符，模型实际调用 `goal_create`、`isolation_run`，候选可调用 `goal_strategy`，后续轮次接收独立失败反馈。临时 owner 先配对供验收 owner lineage 使用，实际路由在入站创建 binding 后才可验证；Isolation 使用具名默认插件入口，保留 Policy 的插件身份验证。

Goals 新增当前 owner route 前后校验的只读执行快照，不复活已释放 Agent。每轮 step contract 与 whole-goal assessment contract 是不同对象；快照保留每个真实 triggerRunId、完整策略记录与重新核对的回执。`execute` 在清理成功后保存私有内容寻址证据，读取时校验全部绑定；新输出选择确切当前 outcome contract，早期回执不能取代后续结果。单份合同仍保留既有校验上限，多合同 cell 使用独立的 32 MiB / 500,000 节点聚合上限。

同一公开合成任务的确定性 adapter 已覆盖 direct/strategy 两分支：实际 Docker 导出错误产物→step/outcome 都 not-achieved→反馈修订→step/outcome 都 achieved。两分支分别外层6/9次请求、内层4/7次，最初前台协调开销都是2次，候选有2个原生 child；这只是接线与计量证据，不是质量收益。取消到达实际 adapter，未结算预留保留；不合作 disposer 到期仍报告 unknown。

完整比较仍缺 `BenchmarkExecutor`/journal 调度连接、实际能力挂载核对、公开开发语料与冻结留出、strategy-v1 CLI/doctor、真实模型比较。当前 helper 接受受信任 factory；初始装配和 factory 的整体期限、失败路径的完整持久证据仍应由最终 executor 统筹。不得把声明的 plan capabilities 或确定性 fixture 当作已验证的实际配置和策略增益。
