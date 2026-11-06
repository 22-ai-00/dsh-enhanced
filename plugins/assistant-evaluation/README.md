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

当前有四个 trusted producer：`assistant-automations`、`assistant-delivery`、`assistant-verifier` 与 `assistant-work-items`。`assistant-work-items` 把已结算的 work-item outcome（`observed` / `unverified` / `not-applicable`）通过同一私有 registration seam 投影为 trusted 证据；它的 `objectiveStatus`/`deliveryStatus` 恒为 `unknown`，`executionStatus` 由 evidence state 派生，因此 work-item 结算永远不能升级自身的目标判断（也没有 automation-run ref，`queryTasks()` 会把它保留为独立 outcome）。

Evaluation 保持 producer-agnostic：registration/claims 类型在 `src/types.ts` 本地定义，不 import 任何 producer 运行时；producer 侧只以 type-only import + optional peer 引用这些契约类型。新增 producer 只需要在自己的 package 里实现 generation + sink 注册。

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
| `notificationOutcomesEnabled` | `false` | WP22：在既有 projection tick 上同步 Delivery 通知结果事实。 |
| `notificationResponseWindowMs` | 1 天 | 已发出且无反应的通知超过此窗口记为 `expired-unhandled`。 |
| `notificationObservationHorizonMs` | 30 天 | 已知通知自通知时间起在此期间内被重查，以吸收迟到回复、更正与撤回；有效值至少为响应窗口的两倍。超出观察期的通知不再被扫描（按 `occurred_at` 范围索引）。 |
| `notificationSyncBatchSize` | `100` | 每次同步新摄入与重查的条数上限（最大 500）。 |
| `notificationSyncIntervalMs` | 60 秒 | 定时器驱动的通知同步最小间隔（projection tick 更频繁，同步按此节流；`0` 表示每个 tick）。 |
| `attentionTuningAutoAdopt` | `false` | WP22 切片 2：按 cohort 有界自动采用收紧类注意力参数并在回归时回退；要求 `notificationOutcomesEnabled`。 |
| `attentionTuningCohorts` | `[{ lane: owner-notification, sourceId: assistant-proactive/v1 }]` | 可调 cohort（`lane` + `sourceId`），最多 16 个。 |
| `attentionTuningMinSample` | `20` | 提议与回归判断所需的最少已判定通知数（最小 5）。 |
| `attentionTuningNegativeRatePpm` | `600000` | 负向率（rejected + expired-unhandled）达到此值时收紧一步。 |
| `attentionTuningMuteRatePpm` | `900000` | 其余参数已到上界后，负向率还须达到此值才停用该 cohort；须 ≥ 收紧阈值。 |
| `attentionTuningRegressionMarginPpm` | `100000` | 观察期负向率高于采用依据负向率加此余量时回退。 |
| `attentionTuningObservationMs` | 7 天 | 采用后的观察期，持久化，重启后继续。 |
| `attentionTuningEvaluationWindowMs` | 7 天 | 提议所用证据的回看窗口（且不早于上一次版本变化）。 |

## 权限与数据边界

- **文件系统：** 创建数据库父目录并写入本地 SQLite；新数据库目录使用 `0700`、数据库使用 `0600`。现有数据库若为符号链接、硬链接、非当前用户所有或对 group/other 开放，会拒绝启动。数据库启用 WAL、`synchronous=FULL`、迁移版本检查和 5 秒 busy timeout。
- **网络：** 默认 Evaluation 插件无网络访问；显式调用 experimental benchmark SDK 时，模型 delegate 或独立 holdout authority 是否联网由可信 Host/operator 的部署决定，SDK 本身只使用进程内调用或 stdio transport。
- **子进程：** 默认 Evaluation 插件不创建子进程；显式调用 `./benchmark/holdout` 的 `openHoldoutProvider()` 会启动 operator 指定的 authority executable；`./benchmark/skills` 还会通过 Isolation 启动 Docker 验收作业。
- **凭据：** 默认 Evaluation 插件不读取凭据；`./benchmark/holdout` provider 只收到 operator 显式给出的精确 environment，不继承 Host 环境。`./benchmark/skills` 使用的 Skills authority transport 继承 Host 环境；模型 delegate 所需凭据由可信 Host 自行装配和撤销。
- **浏览器：** 无。
- **install script：** 无；仅有标准 TypeScript build/prepack 和仓库发布保护脚本。

scope、situation、producer/evaluator id、证据引用和指标属于本地评测元数据，可能仍有隐私含义；调用方不应把原始 prompt、secret、消息正文或绝对产物路径放入这些字段。

## 工作项报告的主人结果反馈

WorkItems 的普通结算仍只能记录 `objectiveStatus: unknown`。显式启用其独立报告反馈入口后，Delivery 对真实报告回复建立当前 owner 来源，Evaluation 再通过当前 WorkItems 代次的 opaque capability 独立读取精确报告、冻结供应和已静止且预算结算的真实 production 证明。`ready`、退出码或 provider accepted 都不自动形成目标成功；`achieved` / `not-achieved` 是主人对这条报告的判断。

该路径使用 `work-item` / 原 `itemId` 作为唯一 canonical 主体；报告 revision、digest 和原生 run 是证据，不增加学习票数，也不沿续办 stream 改评后来的子项。执行状态来自独立 proof，按持久 report revision 选择；同 revision 的矛盾 proof 保持不可学习。主人判断走既有 initial / correct / withdraw CAS 和持久 operation 幂等链。`getTrustedWorkItemLearningProjection({ scope, itemId })` 返回当前有版本与 digest 的投影，撤回返回 `retract`；`getTrustedTaskLearningProjection`、owner revision reader 和 writer fence 同样支持这个主体。模型自评不能创建该可信结果。新的结果写入还要求当前 Delivery 提供源 writer fence：最后一次 WorkItems 读取后重核当前反馈授权和冻结来源，在同一源锁内写入 owner 判断并结算来源。通知在源事务提交后发送；跨库失去回执时保留原操作身份恢复，不声称可原子回滚两个数据库。

schema 13 扩展任务投影的主体身份约束及投影 outbox 的状态约束，保留既有 outcome、owner 命令、projection、投影 outbox、scope watermark 和 feed head 的值。旧 `work-item` settlement 仍是独立 outcome audit，不追认或合并为新结果。Growth / Memory 消费者可以继续拒绝尚未支持的新主体；这一来源不自行触发模型、采用插件或授予执行预算。当前 Evolution 不支持该新主体，因此其投递 outbox 诚实保存为 `not-required`，不会伪造 applied/recorded、指数重试或消耗恢复预算；canonical feed、来源 reader 和 canonical writer fence 仍可使用。要求已经投递 Evolution 的旧 learning writer fence 则明确拒绝 `work-item` 证据。

## 通知结果账本（WP22 切片 1，只读）

schema 14 新增与任务投影分离的 `evaluation_notification_outcome_*` 表：以 Delivery Outbox id 为通知主键，每次分类变化追加不可改、不可删的 revision 并推进该 scope 独立的通知 watermark；digest 不变只刷新检查时间。分类器 `notification-outcome` v1 确定性、无模型调用，优先级：owner/工作项判断 `not-achieved`→`rejected`、`achieved`→`accepted`；回复或 `partial`→`reacted`；传输 `dead`→`failed`；已发出且超过响应窗口→`expired-unhandled`（含 `expiry: { at, responseWindowMs }`），否则 `delivered`；未发出→`pending`。撤回（`unknown`）不计入判断。响应窗口只写入 `expired-unhandled` 记录，改配置只对到期判定实际改变的通知形成新 revision。格式错误或 scope 与已记录 head 冲突的事实计入 `invalid` 并跳过，不阻塞游标。head 必须与其 revision 的 digest、结果、watermark、scope 与通知时间一致，通知 watermark 与同步游标只进不退、不可删（触发器保证）。回复条数与任何正文不入库。

启用后每个 projection tick 先从持久游标摄入新审计行，再按最久未查顺序重查观察期内的已知通知；格式错误的事实计入 `invalid` 并跳过，不阻塞游标。Delivery 缺席时为零结果。读接口：`inspectNotificationOutcome({ scope, notificationId })`（当前 + 全部 revision）、`notificationOutcomeFeed({ scope, after?, limit? })`（按 watermark 可续读的当前 head）、`notificationOutcomeSummary({ scope, fromNotifiedAt?, toNotifiedAt? })`（按 outcome 与 attention verdict 计数）。本切片不写 Evolution、不改任何参数、不触发 Growth。

## 注意力参数有界收紧与回退（WP22 切片 2）

schema 15 新增 `evaluation_attention_tuning_versions`（不可改、不可删，按 scope + cohort 递增版本，记录精确父版本与父 digest、参数、依据统计与 scope watermark、变化项、来源 `auto`/`request`、sha256 digest）、`_heads`（当前生效版本、`idle`/`observing` 状态与持久观察窗口）和 `_events`（`adopted`/`rolled-back`/`settled`/`request-rejected` 只追加审计）。cohort 是 Evaluation scope 内的 Delivery `lane` + `sourceId`；只统计通知结果账本当前 head。

Delivery 事实可带 `route: { kind: 'linked', originBindingId }`（经 owner linked 别名跨渠道兜底送达的工作项报告）。归一化严格校验：只接受恰好这两个键、`kind` 为 `linked`、`originBindingId` 为非空规范字符串且不等于本通知 `bindingId`，否则计入 `invalid`；记录原样保留该字段，缺席即 origin（不写入），因此无 route 记录的 digest 与改动前一致，分类结果不受 route 影响，分类器仍为 v1。linked 记录照常进入 revision、feed 与 summary，但调优的统计、提议器、留出密封与重放、owner 结构化问题一律按 `coalesce(json_extract(record_json,'$.route.kind'),'origin')='origin'` 排除，别名信道上的反应不污染 origin cohort。依据中的 `scopeWatermark` 仍是 scope 级账本位置（含 linked），只作来源锚点。

参数与固定界限：`interruptionCostDelta` 0–100 步长 10、`minimumUtilityDelta` 0–100 步长 10、`quietExtensionMinutes` 0–120 步长 30（在既有静默时段两侧各延长，总长不超过 1439 分钟）、`muted`。默认全零，即不改变消费者行为。纯函数提议器确定性、只收紧：已判定数不足 `attentionTuningMinSample` 为 no-op；负向率达到阈值时按固定顺序（打扰成本→阈值→静默→停用）对第一个未到上界的参数前进一步，`muted` 另需停用阈值。

`reconcileAttentionTuning()` 在通知同步之后运行（同一节流与错误边界），每个 cohort 在一个 `BEGIN IMMEDIATE` 事务内：空闲时提议并采用一步（幂等键绑定父版本、父 digest、scope watermark 与变化），进入观察；观察中若当前版本 digest 校验失败，或观察期内样本足够且负向率高于依据率加余量，则回退到精确父版本（含版本 0 默认值）；正向或持平证据从不触发回退，观察期满记为 `settled`。被回退版本的证据不复用，须重新累积样本。`currentAttentionTuning({ scope, cohort })` 返回经 digest 校验的当前版本，校验失败时沿父链回落到最近可校验版本或默认值；开关关闭时返回 `undefined`。

`requestAttentionTuning({ scope, cohort, parameters })` 是 Host 内部入口（不注册工具）：任何放宽（含与收紧混合）一律拒绝为 `loosening-requires-holdout` 并记录事件；越界、无变化、多于一步、开关关闭或观察中同样被拒绝并记录。合规的单步收紧以 `request` 来源采用并进入同样的观察与回退。`attentionTuningStatus({ scope, cohort })` 只读返回当前版本、全部版本和事件。本切片不实现放宽、留出重放或 owner 结构化问题，不写 Evolution，不触发 Growth。

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

**当前完成范围：** 冻结协议、持久账本、有界协调器、统计计算、原生 AgentLoop 执行器及 `dsh-benchmark` 命令。默认 `research-v1` 保留 8 道公开研究/注入开发题；`memory-v2` 增加 6 道公开记忆开发题。`strategy-v1` 增加 4 道公开合成 shell 开发题：整数汇总、接触区间合并、按频次/字典序词频和依赖拓扑排序。`families-v1` 增加 9 道公开合成题，覆盖代码、研究、跨日、主动性、注入、撤销、目标变化与重复操作 8 个任务族（提示层代理，纯函数判定）。它们是开发语料，不是 holdout，也没有真实模型收益证据。

原生变体可设 `review: true` 追加冻结复核指引，并用 `role: "ablation"`（persona 与唯一 candidate 相同、只关闭一个开关）做消融；报告以 candidate 为消融参照臂。报告（`distributionVersion: 1`，加法字段）另含 min/p10/p90/max、分族结果、每题跨重复成功率分布与配对指标差。`assertHoldoutIsolation()` 检查留出计划与公开开发清单不重叠，由所有执行入口共用的 `runBenchmark()` 对任何 holdout 计划强制执行（`runIndependentHoldout()` 还会在打开 authority 前提前检查）；`assertCandidateGenerationInput()` 拒绝把非 development 计划用于候选生成，但本包内尚无候选生成代码调用它，需由将来的生成入口接入。二者均为清单级检查。

### 独立留出 provider Host SDK（实验性）

`@dsh-enhanced/assistant-evaluation/benchmark/holdout` 是 inert Host SDK：导入它不会挂载 Cordis 插件、启动 provider、创建数据库或注册模型工具。普通 `runIndependentHoldout()` 也只在可信 Host 显式调用时运行。若调用发生在插件生命周期内，应使用 `runIndependentHoldoutInContext(ctx, options)`；它把 benchmark journal、evidence store、authority/delegate session 和取消控制注册为当前 Cordis Fiber 的一个 owned effect。Fiber 卸载会停止新准入、abort 运行、等待有界清理并关闭两个 store；自然完成也会关闭资源并移除该 effect。`providerTimeoutMs` 为任意 Host provider 的启动、每个请求和关闭设置上限；在 abort 或期限后才解析的 provider 会只做一次有界 `close()`，不会再请求 manifest 或写入 store。它没有把 `ctx.isolate()` 当作进程、凭据或数据集隔离。

operator 必须同时固定 `{ id, version, digest }` 数据集 pin 和 Ed25519 authority public key。authority 按顺序返回四类严格 envelope：

- `manifest` 签名公开 dataset/case identity 及 input/acceptance commitments；
- `input` 签名并绑定 exact manifest、plan、cell、input digest 和本次临时输入 bytes；
- `verdict` 签名并绑定 exact input/acceptance/output digest、plan、cell 与判定；
- `finish` 签名完整 cell 数和按计划顺序排列的 signed-verdict envelope digest 链。

Host 不接受 authority 自报的资源用量：delegate 必须返回与冻结 variant 一致的版本、Host 侧 metrics、execution evidence digest 和 quiescence，runner 再核对每 cell 预算；墙钟 latency 由 runner 计量。这里的 Host 计量仍是可信同进程 adapter 的自证，不是独立外部 meter。`acceptanceDigest` 只承诺验收材料没有被事后替换，不加密低熵答案，也不能证明该材料在候选生成前已经冻结。

私有 input 只在当前 delegate 调用期间存在，raw output 只用于本次 verdict 请求；SDK 在结算后尽力清零持有的 byte arrays。Benchmark SQLite、content-addressed evidence 与报告只保存 digests、Host metrics、执行证据引用以及 signed manifest/verdict/finish，不保存 signed input envelope、raw input 或 raw output。这个约束只覆盖 Host SDK 的持久化面，不能证明外部 authority、delegate、模型服务或同 UID 进程没有另行复制数据。

恢复语义保持保守：完整 journal 加不可变 completion marker 可在不启动 authority/delegate 的情况下重验；已有 unknown 直接保持终态。completed prefix、遗留 running intent、缺失/漂移的 finish marker 都在 provider startup 前失败关闭，v1 不选择性续跑。若最后一个 cell 已发布 finish marker、但进程在 SQLite cell 终态提交前崩溃，重启仍看到 running intent；operator 必须先确认旧执行停止，再调用 `BenchmarkStore.interrupt()` 将其记为 unknown，不能用 marker 自动升级为成功。

内置 provider transport 使用单请求 NDJSON、固定 `cwd: /`、完全显式的 child environment、长度/时间上限和 TERM→KILL 有界关闭。POSIX 关闭同时等待 leader/stdio 关闭和当前数值进程组消失，Windows 只管理直接 child 与其 stdio；继承管道仍未关闭时会有界报 `termination-unconfirmed`。普通 PID/PGID 信号不能约束脱离进程组的后代，也不能排除数值复用导致误发信号，因而不是无竞态进程身份或强 OS containment 证明。executable 只做绝对 canonical pathname 校验，没有 fd/inode 绑定，因此 pathname 在校验与 `spawn` 之间被替换不在当前保证内。现有真实子进程回归使用同 UID synthetic authority fixture；它验证 transport、签名链、无 raw I/O 持久化、零-spawn 重验和 fail-closed 恢复，不证明独立账号/机器/UID 部署、历史冻结透明度或真实隐藏性。目前也没有真实模型、真实独立 holdout 或 live benefit 证据，WP04 继续为实现中。

### 原生策略比较的 Host 接口

`strategy-v1` 已由 `dsh-benchmark corpus|doctor|plan|run|report` 支持。它冻结 `direct` 和 `adaptive-strategy` 两分支、策略执行限额、已安装能力来源与任务/验收摘要；每个 cell 在私有 state 目录保存可重读的详细观察和摘要。模型只能收到公开 objective、提示和示例；独立 verifier 的向量不进入 prompt。

`parseStrategyBenchmarkPlan` 固定两个分支 `direct` / `adaptive-strategy`、共同预算、模型调用上限、单次输出和原生 Goal 轮数。共同 persona/工具/Policy/runtime 与策略 guide/tool/Policy/runtime 分别声明摘要，并派生两分支版本；任意额外版本差异会被拒绝。parser 验证声明一致，实际 executor 另外核对挂载的能力。`strategyBenchmarkJournalPlan` 将完整策略契约绑定到既有 journal，修改限额不能复用旧计划 ID。调用 `installStrategyBenchmarkRequestMeter` 会先核对 exact cell/计划/模型，再安装外层限额；executor 将同一 `maxGoalRounds` 交给真实 Goal。

计量器必须在首次入站前安装在专用 Context，覆盖前台、父 Goal 和 child 的全部 `llm/stream` 与工具执行。仅接受可信输入上界和供应商输出上限；estimate/observed 配置显式拒绝。模型流在 dispatch 前共享原子预留，结束后根据完整 usage 结算；取消、缺 usage、异常和提前关闭保留预留，`assertComplete()` 拒绝未结清、空测量或尚在运行的工具。费用为 null 时只约束 token，不声称金额硬限。快照是进程内观察；executor 将它与计划/cell 绑定、持久保存，并与独立验收和资源停止证据核对。取得下游迭代器的 `dispatched` 不是实际付费 HTTP 证明。

`createBenchmarkStrategyOwnerRuntime` 要求全新 Context、两个现存且独立的 canonical 私有目录：候选 workspace 和其外部 stateRoot。它在 stateRoot 独占创建 runtimeRoot，写入 JSONL Session、Delivery/Policy SQLite 及 spool；显式保存空会话头，使原生 Delivery 创建后可以真实恢复。它只配对本地合成 owner、注册本地回复捕获通道；该身份只用于评估，不是对任何真实用户/外部服务的授权，不发现或修改用户 profile，也不发外部通知。只暴露指定工具 allow-list，额外 Policy 规则由可信 Host 提供。模型 adapter 则拥有操作者声明的网络/凭据权限，由调用者安装和销毁。

executor 在实际每个父请求上比较完整 persona、每个实际工具 schema，并通过 `assistantPolicy.inspectHostConfiguration()` 比较完整 Policy 配置；同时记录已解析安装源码的身份摘要。该检查发现计划与运行时的普通漂移，但不构成对同进程恶意 Host 代码或远端 provider 实现的形式证明。全流程 deadline 覆盖装配、调用、验证和关闭；不能证明停止、usage 或证据完整性时结果保持 `unknown`，不会重放 cell 或启动后续 cell。

### 开发集命令

```sh
dsh-benchmark doctor
dsh-benchmark corpus
dsh-benchmark doctor --suite memory-v2
dsh-benchmark corpus --suite memory-v2
dsh-benchmark corpus --suite families-v1
dsh-benchmark corpus --suite strategy-v1
dsh-benchmark doctor --suite strategy-v1 --config ./docs/examples/strategy-benchmark.config.json
dsh-benchmark plan --config ./docs/examples/strategy-benchmark.config.json --output ./private/strategy-plan.json
dsh-benchmark run --config ./docs/examples/strategy-benchmark.config.json --adapter /absolute/trusted-adapter.mjs --database ./private/strategy.sqlite --output ./private/strategy-report.json
dsh-benchmark report --database ./private/strategy.sqlite --plan strategy-public-development --config ./docs/examples/strategy-benchmark.config.json --output ./private/strategy-report-copy.json
```

`doctor --suite strategy-v1 --config` 会在不安装依赖、不拉取镜像的前提下检查 Host packages，并执行有界的离线 Docker/image probe；ready 不证明模型凭据或 provider 可用。`plan` 不调用模型。`run` 只装载操作者指定的 trusted adapter，费用和 token 限额来自配置；adapter 入口的 SHA-256 必须同时匹配 `adapterDigest` 与 `tokenCounterDigest`。策略 suite 固定 `inputLimitMode: "upper-bound"` 和 `outputLimitMode: "provider"`；现有 Codex 订阅 adapter 的 estimate/observed 模式不兼容策略运行。`report` 重新打开已保存的 cell 观察和摘要，并从 `--config` 重建当前 plan 进行比对；它不重新激活已关闭 runtime 或重放模型调用。

配置示例、计量协议和限制见 [评测实施文档](../../docs/benchmark-implementation.md)。预算为每 cell 上限；金额单位为美元的百万分之一，计价为每百万 tokens 对应的该单位。`costUsdMicros: null` 明确选择仅 token 预算，模型输入/输出价格也可同时为 null；报告中的未知费用不会填成零。声明金额上限时必须提供非缓存输入、cache read、cache write、输出四类费率，且必须使用输入上界和提供商输出上限；输入预留采用三类输入的最高费率。DSH 的非缓存 input 与两类 cache 相加为实际输入，reasoning 已包含在 output 中，不重复计费。实际使用了缺价的 cache 时，费用保持 null。可信适配器须关闭隐藏自动重试。

非策略原生 suite 仍可使用 estimate/observed 的 token-only 配置；这不扩展到 strategy-v1。策略运行创建私有 workspace/state 根并持久化证据，日常 profile 不会安装、启用或加载这些可选 Host peers。

命令使用网络/凭据的权限由可信模型适配器决定；自身读取配置和模块，写独立私有 SQLite 与独占新建的 JSON 报告，创建并清理临时工作目录，不安装提供商、不修改日常 profile。报告不包含模型原始答案，判定绑定答案哈希与开发集验收摘要。`split: holdout` 只声明用途，同 UID 文件或公开仓库中的题目/答案不属于安全隐藏留出。

## 兼容性

Goals 的独立 Verifier v2 回执使用 `goal-step` 任务身份，按 `goal:<goal-id>:definition:<version>` 归因；同一 ref 的前台或 Automation 任务不会与之合并。schema 10 迁移保留既有投影、证据与视图。原有 owner 反馈修订入口仍只支持前台和 Automation，目标步骤成功也不自动宣告整个长期目标完成。

对齐仓库的 [DSH / Cordis 兼容性基线](../../docs/compatibility.md)。Host 提供 Cordis、Agent 和 ToolRuntime；插件自身携带 Schemastery。

Host 可通过 `getTrustedAutomationRunLearningProjection({ scope, runId })` 精确读取一个 run 的 ready canonical learning projection，无需扫描受 limit 限制的原始 audit 列表。不存在或 objective-conflict 时不返回证明；返回值沿用同一 canonical projection、revision、digest 和 scope watermark。调用方须检查 disposition 和执行/目标状态，并在产生依赖该证据的写入时使用 `withTrustedLearningWriterFence`。

`listTrustedTaskLearningProjections({ scope, after, limit })` 提供同一 scope 内当前 trusted canonical heads 的可重启增量读取，包含 retract；同一任务的中间修订可能合并。cursor 必须带该 exact scope key 与已观察 watermark，limit 为 1–100；future、跨 scope 或畸形 cursor 被拒绝。每个 canonical 更新在同一 SQLite writer transaction 更新 head 与 scope watermark；分页读取使用一致快照。schema 12 为既有可信任务一次性分配新 watermark，保留原证据和 canonical version/digest；后续重启不重复分配。scope 不证明 owner 归属；`inspectTrustedTaskOwnerRevision()` 只返回当前 canonical objective 对应的精确 principal record/version 最新修订。消费者仍须独立确认任务 owner，并在写入前用 receipt 校验与 writer fence；读取接口不授予执行权限。

`withTrustedCanonicalLearningWriterFence` 为依赖 Evaluation canonical 状态本身的 Host 写入提供同样的 scope watermark、精确 task tuple 和同步写锁校验，但不要求投递给 Evolution 的 outbox 已完成。`withTrustedLearningWriterFence` 继续为 Evolution 依赖方保留 projection-pending gate；两者都不会代替或伪造 outbox 投递。

`getTrustedGoalOutcomeLearningProjection({ scope, assessmentId })` 是 whole-goal 消费者的 Host-only 精确读取入口。它只接受 `canonicalEvaluationHostScope()` 产生的 token，并且只查询相同 canonical workspace/preset 下 subject 恰为 `goal-outcome/<assessmentId>` 的当前 projection；缺失或跨 scope 返回 `undefined`。返回的 `version`、`digest`、`disposition` 与 scope watermark 是 Evaluation 当前状态，不把原始 immutable Verifier receipt 永久视为事实。该入口只证明 assessment 的 canonical 状态；owner、Goal、Session、run 和 outcome profile 的关联仍须由调用方从 Goals 的当前 Host snapshot 独立证明。

`withTrustedCanonicalTaskWriterFence({ scope, scopeWatermark, evidence }, callback)` 是对应的同步 commit fence。它逐项核对 exact subject kind/ref、revision、digest 和 `upsert | retract` disposition，并在 Evaluation writer lock 持有期间执行同步 callback；scope 内任何任务推进 watermark，或该 assessment 被纠正、撤回、替换，都会在 callback 运行前返回 `evidence-changed` / `watermark-changed`。它不等待可选 Evolution projection outbox，因此可让下游在 exact retract 下原子移除旧观察；异步 callback 会失败并回滚。原 `withTrustedCanonicalLearningWriterFence` 继续只接受可推广的 `upsert`，其契约不被放宽。

`getTrustedForegroundLearningProjection({ scope, inboxId })` 按 exact foreground subject 读取当前可信 canonical projection，使用该 subject 已存在的真实 projection outbox trigger；较新的 display primary 即使没有产生学习更新，也不会遮蔽 canonical 状态。返回值仍包含当前 retract 与 scope watermark；缺失或跨 scope 返回 `undefined`。

`withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark }, callback)` 为 Host 来源读取提供精确 scope 的同步 writer exclusion，返回 `{ matched, value }` 或 watermark 拒绝结果。它允许尚无 canonical 行时的 watermark `0`，但空 scope 不证明业务成功，也不提供可信 outcome。callback 必须在锁内重新读取所依赖的当前 projection / owner revision，再同步提交下游事务；Promise / thenable 或 callback 异常会回滚。跨库锁序为 Delivery → Evaluation → Memory / review store，不跨 `await`。该入口不等待可选 Evolution outbox；既有 evidence fences 仍要求非空 evidence 与正 watermark。

### Owner outcome revisions

Delivery's authenticated capability can explicitly correct or withdraw one exact delivered result. Schema 8 retains immutable raw outcomes, linked owner revisions, provider command receipts (including rejected CAS attempts), and a single canonical task projection. Owner lanes include principal record id and version. Only explicitly linked predecessors are superseded; independent contradictory owner evidence stays quarantined. Withdrawal is an authoritative `unknown` tombstone, so earlier terminal/evaluator success cannot reappear. The revision, digest, audit and projection outbox commit in the same SQLite transaction.

Legacy schema 7 owner rows are adopted lazily through the exact Host delivery capability and stable initial idempotency key. Adoption verifies the run and Outbox references without rewriting raw history. Host consumers receive revision notifications and must also revalidate durable proof on startup / dispatch; a failed listener cannot prevent other consumers or the projection outbox from progressing.

整体目标的独立 v3 回执使用 `goal-outcome/<assessmentId>` subject，与同 ref 的步骤、前台和 Automation 分离，仍按完整目标定义归因。schema 11 在事务内迁移旧 task projections 并保留历史。Delivery v2 producer 可携带 current Goals process-local capability，把 exact whole-goal Verifier receipt 惰性采纳为 owner revision 1；Evaluation 不信任 Delivery metadata，而会通过当前 Goals provider 重建 proof，并从当前 Verifier `inspectAcceptedTask()` 独立核对 owner/scope、Goal definition、Session/native Goal、assessment、run、profile、contract、receipt 及 digest。provider generation、capability 或任一绑定变化时 fail closed。

同一 `goal-outcome/<assessmentId>` 随后使用既有 owner CAS 协议：`correct` 必须匹配当前 version 与 previous status，`withdraw` 写入 canonical `unknown` retract tombstone，重复命令幂等，乱序或同版本冲突保留拒绝审计而不覆盖 current projection。baseline adoption 在一个事务中把 exact immutable Verifier outcome 认领为 revision 1；如果 Evaluation 在原 receipt 产生时离线且恢复前 receipt 已过期，则只在当前 Goals opaque proof、当前 Verifier 原始 service identity/generation 以及 exact contract/receipt/execution 全部重验后，同构补写原 `assistant-verifier:<receiptId>` outcome、projection、outbox、watermark 与 revision 1，不续期、改写或伪造 receipt。后续每次 correction/retract 的新 owner revision、task projection、scope watermark 和 projection outbox 在一个 Evaluation SQLite writer transaction 中提交。因此 Skills 的 exact canonical monitor 会看到 v2 correction/retract，而不会把原始 immutable receipt 永久当作 achieved。历史回执可以在有效期后接受 owner 标注，但每次 issue/inspect/append 都必须由当前 Goals/Verifier 重验其不可变身份；这不是放宽发送前 freshness。

仓库回归使用本地 Delivery/Goals/Verifier/Evaluation fixture 验证上述 Host 协议；没有连接真实 Lark、真实模型或生产 deployment cohort，不能写成真实渠道验收或长期收益。


`memory-v1` 保留首轮公开试验的原始题目与判定，可按原计划复现。`memory-v2` 是单独版本，明确当前资料 ID、Memory provenance URI 与 `claim:<key>` 的引用约定；改进题目说明后必须建立新计划，不会重写 v1 的失败结果。

策略 Host 接口新增 `createStrategyGoalRuntime`、`strategyGoalTaskDigests` 和 `StrategyEvidenceStore`。单 cell 真实装配原生 Goal/driver/subagents、Goals、Delivery、Isolation 与 Verifier；模型通过真实工具创建目标并导出隔离产物，独立验证向后续轮次提供反馈。运行结束后读取当前 owner 路由授权的持久目标快照，等待资源清理成功，再保存内容寻址的私有证据；证据包含每轮 step/outcome 的独立回执、真实 triggerRunId、策略子会话和外层计量，读取时重验 plan/cell/digest。清理超时保留 unknown，不能据此重放或启动下一 cell。

此接口运行本机 Docker 和离线任意候选 shell：输入复制入容器，验证向量只供独立 runner，Host 持久状态保存在候选工作区之外。调用方必须提供受信任 adapter factory、已有私有目录、固定本机镜像及明确限额；不查找或修改用户 profile，不发送真实渠道消息。`execute`/`close` 清理有等待上限，但不合作资源可能仍未停止。adapter factory 与初始装配仍由调用方的整体期限控制，不能把本接口计量窗口视为完整比较墙钟期限。目录权限不隔离同 UID 的可信 Host 代码。

策略 executor 会核对实际挂载工具、完整 persona、完整 Policy 配置、运行时来源和 adapter；这些观察连同全流程故障证据写入 journal 外的私有证据目录。普通 Evaluation bundle 不自动激活上述可选 Host peers，且尚无真实模型收益结论。

### DeepSeek strategy adapter

The optional `./benchmark/deepseek` export supplies the trusted `createNativeAdapter` entry for strategy-v1. Explicitly install the matching `assistant-deepseek-budget` Host peer and provide the `DEEPSEEK_API_KEY` credential reference in the current credentials service or process environment. The factory registers no services or profile configuration; disposal shuts down its adapter. It uses the existing fixed HTTPS production transport and sends public task context and tool messages to that provider. No subprocess, credential file scan, model-generated adapter or automatic retry is added.

The input reserve is the production contract's conservative 2,097,152-token upper bound per request; prices remain unknown. Use the [DeepSeek example and instructions](../../docs/goal-strategy-evaluation.md#deepseek-生产模型入口), rather than the small generic fixture budget. Source commitments include the selected DeepSeek and credentials packages. Runtime readiness, online model access and measured strategy benefit remain separate evidence.

## 原生技能复用比较

`./benchmark/skills` 提供 `createNativeSkillGoalRuntime`、`runNativeSkillBenchmark` 和 `nativeSkillBenchmarkReport`。它复用原生 DSH Goal、Skills 委派、BenchmarkStore 和 prospective authority；冻结同供应/预算后才生成隐藏任务，最终签名验收后才计算成功率。训练用量单列，unknown 不重派，报告不授权晋升。来源服务需保持存活，所有实验资源需显式关闭；详见[接线与证据边界](../../docs/native-skill-reuse.md)。

此入口显式写入私有 runtime、SQLite 和逐 cell 原始证据，并使用 Skills 的 NDJSON authority transport（继承 Host 环境/cwd）；默认 Evaluation bundle 的权限不变。真实模型凭据由调用方提供，候选只有隔离执行能力。
