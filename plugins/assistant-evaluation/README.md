# @dsh-enhanced/assistant-evaluation

个人助理的可信自评测账本。它把一次任务的三个事实分开记录：执行是否正常、目标是否达成、结果是否送达；不会再把“Agent loop 正常结束”误当成“用户目标已经完成”。

插件提供本地、追加式 SQLite service，以及两个严格限权的模型工具：`evaluation_review` 读取当前 Agent 精确 scope 的有界结果，`evaluation_self_assess` 只能给既有、objective 未知的结果追加一条 `self-reported` 目标判断。公开 `assistantEvaluation.append()` 永远拒绝 `trusted`；可信事实只从 Evaluation 实例为真实 Host producer 建立的进程内私有注册进入，模型和普通调用方都不能创建或升级可信记录。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-evaluation
dsh --profile web --dump-config
```

默认数据库位于 `$DSH_HOME/assistant-evaluation/evaluation.sqlite`。

## 数据模型

`OutcomeEnvelope` 必须包含：

- 精确作用域 `scope.workspace + scope.preset` 和稳定 `situation`；
- 相互独立的 `executionStatus`、`objectiveStatus`、`deliveryStatus`；
- Host producer 的 `source`、证据等级 `trust`；
- 仅含引用的 `evidence`，不复制原始对话或产物；
- 有界 JSON `metrics`，标准整数键为 `costUsdMicros`、`latencyMs`、`inputTokens`、`outputTokens`、`toolCalls`、`retries`；
- `occurredAt`、`idempotencyKey` 和为判断逻辑定版的 `evaluator.id/version`。

公开 service 接口是：

```ts
ctx.assistantEvaluation.append(outcome)
const scope = canonicalEvaluationHostScope({ workspace, preset })
ctx.assistantEvaluation.getTrustedOutcome({ scope, outcomeId })
ctx.assistantEvaluation.appendSelfAssessment({ outcomeId, scope, objectiveStatus, evidence, occurredAt, idempotencyKey, evaluator })
ctx.assistantEvaluation.queryTasks({ scope, situation, limit: 20 })
ctx.assistantEvaluation.query({ scope, situation, limit: 20 })
ctx.assistantEvaluation.summary({ scope, fromOccurredAt, toOccurredAt })
ctx.assistantEvaluation.health()
ctx.assistantEvaluation.limits()
```

`append()` 只接受 `external` 或 `self-reported` 等低信任输入；传入 `trusted` 会直接失败。Automations 的 production terminal receipt 与 Delivery 的 exact owner feedback 通过各自 durable outbox 和 Evaluation 私有 producer registration 写入，preview、复制 registration、过期 generation 或公开调用都不能进入可信 lane。相同 `idempotencyKey` 的完全相同输入安全重放；内容变化会以 `idempotency-conflict` 失败关闭。

`getTrustedOutcome()` 是供本地固定 Host runbook 做跨账本投影的精确读取 seam。它要求由
`canonicalEvaluationHostScope()` 产生的冻结、不可序列化 scope token；缺失、跨 scope 或非
`trusted` 的记录一律不返回。凭证只包含状态、来源、证据引用和 evaluator，不暴露 metrics、
producer 幂等键或账本写入时间。该读取证明“这条 trusted 判断确实存在”，不会证明关联的
Automation run 属于生产流量；调用方仍必须向 Automations 取得 exact production attribution。

schema v4 保留每条原始 envelope，并另外持久化一个可查询的 task projection。相同精确 scope 内，只有 evidence 中恰好一个唯一 `automation-run` ref 的记录才会归入同一任务；没有该引用、引用不唯一或旧数据无法确定关联时，每条 outcome 都保持独立，不做相似度猜测。`query()` 仍返回 append-only 审计记录，`queryTasks()`、`summary()` 与模型 `evaluation_review` 则只按 task projection 计一次。

Automation task 的合并规则固定如下：

- execution、资源 metrics、任务时间和主要展示记录只取 `assistant-automations` 的 trusted terminal/Host-runbook producer；owner feedback 不能声称执行成功或替换成本数据；
- exact `assistant-delivery/typed-owner-feedback` trusted reply 优先覆盖 objective，并把 delivery 提升为 `delivered`；没有 owner 判断时，其他 trusted evaluator 高于 terminal 的初始 objective；`external`/`self-reported` 永远不能覆盖 trusted Automation task；
- 多条相同 owner 判断安全折叠；多个 owner objective 互相冲突时，projection 明确进入 `objective-conflict`、objective 退回 `unknown`，不会按最后写入者静默选边；
- 同一来源层级需要选择记录时，先按 `recordedAt`，再按不可变 outcome id 做确定性 tie-break。owner 冲突检测不受写入顺序影响。

projection 保存选中的 execution/objective/delivery component id，原始两条或多条审计记录不会被改写或删除。schema v3 升级会按上述 exact ref 保守回填；不能证明关联的旧记录继续独立。`health()` 同时报告 `taskProjections` 与 `conflictedTaskProjections`。

`appendSelfAssessment()` 要求既有 `outcomeId` 和相同 scope；账本继承原记录的 execution/delivery 状态，只追加 objective 判断与 evidence refs，并强制保存在独立的 `self-reported` assessment 表。它不会增加任务总数或升级原 outcome 的 trust。模型侧的 `evaluation_self_assess` 进一步固定 scope、时间、幂等键和 evaluator，只允许选择目标状态并引用最多 10 个实际检索到的 Memory id。

`query()` 与 `queryTasks()` 永远要求精确 scope，并对条数、字符串、时间和枚举做边界校验。`summary()` 只接受不超过 `maxSummaryWindowMs` 的窗口。`evaluation_review` 从当前 live Agent 派生 scope，只返回有界 task projection 摘要、脱敏结果、冲突状态和经过 first-party provenance + 格式校验的 Automation run id；不返回 workspace、source id 或任意 evidence ref。已有 trusted owner objective 的 terminal 不再以 `unknown` 候选出现，直接调用自评 seam 也会再次按 task projection 拒绝它。默认自动 review 会排除 `automation:heartbeat:*`，避免维护任务递归自评并饿死真实任务；显式 situation 查询仍可审计它们。内置 self-evaluation skill 要求先精确读取 run，再通过 `memory_search_confirmed` 检索非敏感 owner-confirmed Memory，证据不足时保持 `unknown`。

## 配置

| 键 | 默认值 | 说明 |
|---|---:|---|
| `databasePath` | DSH patch 设置 | 绝对 SQLite 路径；测试可用 `:memory:`。 |
| `maxQueryLimit` | `100` | Host 单次查询硬上限，最大可配置为 500。 |
| `maxReviewOutcomes` | `20` | 模型单次 review 最近结果上限，最大 50。 |
| `maxSituationBytes` | `200` | situation 的 UTF-8 字节上限；200 是 producer 互操作下限，只能上调。 |
| `maxMetricsBytes` | `4096` | canonical metrics JSON 字节上限；256 是 durable producer 互操作下限，只能上调。 |
| `maxEvidenceRefs` | `32` | 每条 outcome 的证据引用数上限。 |
| `defaultSummaryWindowMs` | 30 天 | 未指定起点时的默认汇总窗口。 |
| `maxSummaryWindowMs` | 365 天 | 单次汇总允许的最大窗口。 |

## 权限与数据边界

- **文件系统：** 创建数据库父目录并写入本地 SQLite；新数据库目录使用 `0700`、数据库使用 `0600`。现有数据库若为符号链接、硬链接、非当前用户所有或对 group/other 开放，会拒绝启动。数据库启用 WAL、`synchronous=FULL`、迁移版本检查和 5 秒 busy timeout。
- **网络：** 无。
- **子进程：** 无。
- **凭据：** 无。
- **浏览器：** 无。
- **install script：** 无；仅有标准 TypeScript build/prepack 和仓库发布保护脚本。

scope、situation、producer/evaluator id、证据引用和指标属于本地评测元数据，可能仍有隐私含义；调用方不应把原始 prompt、secret、消息正文或绝对产物路径放入这些字段。

## 限制

- 账本保存“谁以什么证据做了什么判断”，并不把模型自评提升为 ground truth。
- 自评可以辅助判断 objective，但永远保持 `self-reported`；插件不自动修改 Memory、Evolution、Automation、代码或权限。
- scope 路径做绝对路径的语法规范化，不主动访问文件系统解析符号链接。
- 当前面向单机个人助理，SQLite 依赖仓库兼容基线规定的 Node.js 版本。

## 配对评测 Host SDK（实验性）

`@dsh-enhanced/assistant-evaluation/benchmark` 提供 `parseBenchmarkPlan`、`benchmarkPlanDigest`、`benchmarkSchedule`、`BenchmarkStore`、`runBenchmark` 和 `benchmarkReport`。这是可独立导入的 Host 集成入口，不自动启用，也不注册模型工具。它使用单独的 benchmark SQLite 文件，不改变日常任务评价数据库。

计划冻结数据集版本与摘要、逐题输入/验收摘要、模型、prompt、skills、tools、policy 和 runtime 的 SHA-256 配置/内容摘要。模型摘要应覆盖实际 provider、具体模型版本、采样参数和计价配置，不能只记录别名。能力比较要求模型相同；模型比较只能改变模型配置。消融必须与唯一候选保持版本一致，并只关闭记忆、规划、复核或成长中的一项。变体共享完全相同的预算与逐题 seed；执行顺序轮换。seed 记录不意味着模型服务一定支持确定性采样，adapter 必须如实记录提供商能力。

可信 Host 先构造 `BenchmarkPlan`，创建 `new BenchmarkStore(absolutePrivateDatabasePath)`，再调用 `await runBenchmark(store, plan, executor, signal)`，用 `benchmarkReport(plan, store.results(plan.id))` 获取报告，最后关闭 store。`executor.execute(request)` 必须实际创建隔离且等价的任务环境，按冻结配置调用原生 AgentLoop、限制计量预算、收集 Host 计量、等待资源停止并使用独立 verifier 判定结果。请求只含计划中的任务身份及摘要，输入和答案由可信数据集提供方分别交给执行器与验收器；不得让模型自行填写 observation。控制器对版本/摘要漂移、缺失预算计量、超预算与未停止的执行返回 unknown。

每个 cell 在执行前持久保存运行意图。相同计划可继续尚未开始的 cell，但完成的 cell 不再执行；同 ID 不接受修改后的计划或结果。启动时遇到运行中意图会拒绝，不能因为进程重启就重放可能有副作用的任务。管理员可以用 `store.interrupt(planId, timestamp)` 将遗留意图记为 interrupted/unknown；这不会停止实际进程，也不会恢复该计划的后续执行。先确认旧执行已停止，再创建新的完整比较计划，不能选择性重跑失败题来提高分数。

超时和取消发出 AbortSignal 后有界返回，迟到结果不能改写账本；unknown 传输或生命周期状态阻止后续 cell。该机制不能强制终止同 UID 任意代码、子进程或远端调用，实际撤销/隔离仍由 Host adapter 和独立 broker 实现。数据库文件要求当前用户拥有、私有权限、非符号链接/硬链接；这不是对同 UID 对手的隔离。

报告保留所有计划 cell 作为已验证成功率分母，unknown 和缺测单列，缺失费用/token/返工/人工介入量不会补成零。提供配对胜负、差值和均值/中位数/P95；区间按任务聚类 bootstrap，同题重复不当作独立任务。任一比较臂有缺测或 unknown 就不报告收益差值与区间，不能把基线的未知结果当作失败来制造增益；单臂有 unknown 也不报告其成功率区间。少于两个任务不提供区间。小样本或同质任务仍不足以证明泛化收益，报告始终 `promotionAuthorized: false`。

**当前完成范围：** 冻结协议、持久账本、有界协调器、统计计算、8 道公开合成开发题（研究/注入各 4 道）、原生 AgentLoop 执行器及 `dsh-benchmark` 命令。原生执行器每个 cell 创建独立 Context/Session/临时目录，只做一次无工具模型请求，当前只比较 persona；记忆/规划/复核/成长插件均关闭，不能冒充完整功能消融。真实模型比较、其他六个任务域、实际生产 profile 安装与独立留出隔离仍须分别验收。

### 开发集命令

```sh
dsh-benchmark doctor
dsh-benchmark corpus
dsh-benchmark plan --config ./benchmark.json --output ./plan.json
dsh-benchmark run --config ./benchmark.json --adapter /absolute/trusted-adapter.mjs --database ./private/results.sqlite --output ./report.json
dsh-benchmark report --database ./private/results.sqlite --plan my-plan --output ./report-copy.json
```

`doctor` 检查所需 Host 包可解析，不证明模型或凭据可用。`plan` 不调用模型，并显示整组最大 token 与费用预算。`run` 读取配置、冻结计划，再载入操作者指定的可信模块；模块须导出 `createNativeAdapter(model)`，返回 `LlmAdapter`、`inputTokenUpperBound(options)` 和 `dispose()`，入口 SHA-256 必须同时匹配 `adapterDigest` 与 `tokenCounterDigest`。这是有宿主权限的扩展，不能执行候选生成的不受信任模块；摘要不覆盖传递依赖，也不是同 UID 文件系统攻击防护。原生依赖保持 optional peer，通过 `./benchmark/native` 单独导入；轻量 SDK 不强制加载 AgentLoop。

配置示例、计量协议和限制见 [评测实施文档](../../docs/benchmark-implementation.md)。预算为每 cell 上限；金额单位为美元的百万分之一，计价为每百万 tokens 对应的该单位。`costUsdMicros: null` 明确选择仅 token 预算，模型输入/输出价格也可同时为 null；报告中的未知费用不会填成零。声明金额上限时必须提供价格。可信适配器须关闭隐藏自动重试、提供可靠的输入上界，并规范化提供商计量；原生执行器拒绝未规范化的缓存/推理分项，避免漏算或重复计算。超时或 unknown 会停止后续 cell，不声称撤销远端已经发生的计费。

命令使用网络/凭据的权限由可信模型适配器决定；自身读取配置和模块，写独立私有 SQLite 与独占新建的 JSON 报告，创建并清理临时工作目录，不安装提供商、不修改日常 profile。报告不包含模型原始答案，判定绑定答案哈希与开发集验收摘要。`split: holdout` 只声明用途，同 UID 文件或公开仓库中的题目/答案不属于安全隐藏留出。

## 兼容性

对齐仓库的 [DSH / Cordis 兼容性基线](../../docs/compatibility.md)。Host 提供 Cordis、Agent 和 ToolRuntime；插件自身携带 Schemastery。

Host 可通过 `getTrustedAutomationRunLearningProjection({ scope, runId })` 精确读取一个 run 的 ready canonical learning projection，无需扫描受 limit 限制的原始 audit 列表。不存在或 objective-conflict 时不返回证明；返回值沿用同一 canonical projection、revision、digest 和 scope watermark。调用方须检查 disposition 和执行/目标状态，并在产生依赖该证据的写入时使用 `withTrustedLearningWriterFence`。

`withTrustedCanonicalLearningWriterFence` 为依赖 Evaluation canonical 状态本身的 Host 写入提供同样的 scope watermark、精确 task tuple 和同步写锁校验，但不要求投递给 Evolution 的 outbox 已完成。`withTrustedLearningWriterFence` 继续为 Evolution 依赖方保留 projection-pending gate；两者都不会代替或伪造 outbox 投递。

### Owner outcome revisions

Delivery's authenticated capability can explicitly correct or withdraw one exact delivered result. Schema 8 retains immutable raw outcomes, linked owner revisions, provider command receipts (including rejected CAS attempts), and a single canonical task projection. Owner lanes include principal record id and version. Only explicitly linked predecessors are superseded; independent contradictory owner evidence stays quarantined. Withdrawal is an authoritative `unknown` tombstone, so earlier terminal/evaluator success cannot reappear. The revision, digest, audit and projection outbox commit in the same SQLite transaction.

Legacy schema 7 owner rows are adopted lazily through the exact Host delivery capability and stable initial idempotency key. Adoption verifies the run and Outbox references without rewriting raw history. Host consumers receive revision notifications and must also revalidate durable proof on startup / dispatch; a failed listener cannot prevent other consumers or the projection outbox from progressing.
