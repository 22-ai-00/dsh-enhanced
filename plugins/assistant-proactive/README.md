# @dsh-enhanced/assistant-proactive

为已获主人授权的目标事件等待增加机会筛选。事件经过合并窗口、静默时段、收益阈值、冷却及每目标预算判断后，保存静默记录、向主人发送提醒，或交回 Goals 恢复原目标。实际执行继续使用原会话、Policy、预算和独立验收。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-proactive
dsh --profile web --dump-config
```

插件可独立安装；与 `assistant-goals`、`event-triggers` 配合使用时，先按 Goals 文档配置持久化事件等待、主人路由、执行预算与独立验收。安装本插件不会自行创建目标或订阅事件。

## 配置与使用

在本插件的 Cordis 配置行设置（将数据库路径替换为本机私有目录）：

```yaml
databasePath: /home/operator/.dsh/assistant-proactive.sqlite
profiles:
  - id: useful-report
    mode: execute
    expectedBenefit: 100
    successPpm: 900000
    executionCost: 10
    interruptionCost: 5
    possibleLoss: 5
    minimumUtility: 1
    mergeWindowMs: 2000
    cooldownMs: 60000
    rejectionCooldownMs: 3600000
    quietHours:
      timezone: Asia/Shanghai
      startMinute: 1380
      endMinute: 480
    maxDecisionsPerGoal: 20
    maxExecutionsPerGoal: 2
    maxRemindersPerGoal: 0
  - id: useful-draft
    mode: prepare
    preparation:
      provider: configured-provider
      model: configured-model
      budgetId: preparation-runs
      maxOutputTokens: 2048
      timeoutMs: 120000
    expectedBenefit: 100
    successPpm: 900000
    executionCost: 10
    interruptionCost: 5
    possibleLoss: 5
    minimumUtility: 1
    mergeWindowMs: 2000
    cooldownMs: 60000
    rejectionCooldownMs: 3600000
    maxDecisionsPerGoal: 20
    maxExecutionsPerGoal: 0
    maxRemindersPerGoal: 0
# 可选（默认关闭）：把 WorkItems 的 inferred 入站文本交给一个冻结的
# provider/model 判断。规则即 Host 的一次性授权；ceiling 是模型只能下调、
# 不能上调的上限。显式开启前本插件不读取 llm/WorkItems 服务。
intakeEvaluation:
  enabled: true
  rules:
    - ruleId: triage
      ceiling: digest
  provider: configured-provider
  model: configured-model
  maxCallsPerHour: 20
  timeoutMs: 30000
  maxConsecutiveFailures: 3
```

`useful-draft` 还需要在 Policy 的 `budgets` 中配置 `id: preparation-runs`、`metric: automation-runs`、例如 `limit: 5`、`periodMs: 86400000`、`scope: subject`，并为 `background:assistant-proactive/v1` 授予目标资源的 `prepare`。subject 预算固定统计 `assistant-proactive-v1-preparation`，不会随事件或目标变更另开额度。将 provider/model 替换为当前实际可用线路。

### 主动 intake 判断（`intakeEvaluation`，默认关闭）

本插件可以为 `assistant-work-items` 的 inferred intake 评估提供生产模型判断者。默认关闭：不配置（或 `enabled: false`）时不读取 `llm`/`assistantWorkItems` 服务、不注册、不新增任何行为。显式开启后，只有本插件、`llm` 服务和已启用 `intakeLedger.evaluation` 的 `assistant-work-items` 同时就绪时才注册；任一缺失时插件照常加载、保持不注册，并由 `intakeEvaluationHealth()` 报出原因。

- 配置即授权：`rules[]` 的 `ruleId` 与 `ceiling`（`ignore | digest | notify | accept`，work-items 协议 1 的枚举）固定在这里；模型只能把等级下调到 ceiling 或更低，不能上调。`provider`/`model` 在运行期冻结。`maxCallsPerHour`、`timeoutMs`、`maxConsecutiveFailures` 约束本地产者：预算耗尽、连续失败断路和超时都会失败关闭（抛错），由 WorkItems 记录 `unavailable` 并按其自身退避/上限重试。
- 输入输出契约：一次调用只携带一个规则的 `ruleId`、其 ceiling 与已认证的入站正文；`tools: []`、输出 token 与流字节有界，模型只能返回 `{"ruleId","level","quotes"}`。规则 `ruleId` 必须与请求一致，`quotes` 必须是正文的精确子串（最多 4 段、每段最多 280 个 UTF-16 单元）；非严格 JSON、额外字段、非子串引文、非 ignore 却无引文都会抛错，WorkItems 队列还会再校验一次引文与 ceiling。
- 生命周期：注册随 `llm`/`assistantWorkItems` 服务代次绑定，服务替换会注销并重新注册，插件卸载时释放；不新增 Loop 或 timer，评估只由 WorkItems 的入站路径与原生 scheduler wake 驱动。
- 版本与重排：`policy().version` 是规范化规则加 provider/model 的 SHA-256（`v1-…`），仅调整规则顺序不改变版本；规则或 provider/model 改变必然换版本，使 WorkItems 按新版本重排已持有的文本并追加新结果行（旧行只追加、不覆盖）。
- 只读评估：本插件只提供判断者，不写 intake 工作项账本、不准入、不派发、不投递。WorkItems 仍按自身配置处于 observe；把 accept 结果准入为工作项需要 WorkItems 自己的 `intakeLedger.evaluation.admit` 显式授权。审计证据在 WorkItems 数据库：`work_item_intake_evaluation` 行只含等级、原因与引文的 UTF-16 偏移，不含正文。
- 只读健康：`assistantProactive.intakeEvaluationHealth()` 返回 `{ enabled, registered, policyVersion, lastError, readiness: disabled|unavailable|registered|degraded, provider, model, consecutiveFailures, callsInWindow, budgetExhausted }`，供 doctor/运维展示；不授予任何权限，组合展示时还可读 `assistantWorkItems.intakeEvaluationHealth()`。

对话示例：`为当前目标等待 report-file 触发器，使用 useful-report 机会策略，截止时间为一小时后。` 模型在当前主人请求中调用 `goal_wait_event`，显式提供 `opportunity_profile: useful-report`，以及实际目标 ID、native revision、触发器 ID 和毫秒时间戳。未知策略在暂停前被拒绝；省略策略保留 Goals 原有行为。

启用 Goals 事件等待后，主人目标上下文会列出当前可用策略的 ID、模式和每目标上限，供选择 `opportunity_profile`；不展示准备模型、供应商或预算标识。空策略配置不提供主动动作。列表只读且不授予等待、提醒、模型或执行权限；目标首次使用策略时仍按原逻辑冻结，执行时再次核验主人及权限。已认证主人可用 `proactive_status` 只读查看决定，无需对每次合法查询重复工具审批；`proactive_feedback` 仍需当前主人回合及原有审批。

- `execute`：达到条件后返回执行候选；Goals 再次核验当前目标和授权，才能恢复。
- `remind`：向冻结的主人会话投递一条持久提醒，正文只含主人自己的目标摘录（最多 200 个字素）和固定说明，不含配置估值、净收益、来源/事件/机会 ID 或事件元数据；这些仍可经 `proactive_status` 查看。不调用模型，不执行目标。同一主人、目标和来源（`sourceId`）只提醒一次：后续事件若来源观测内容（Goals 传入的事件 `observation.digest`）、正文、目标 revision/definition 与来源配置都未变化，记为 `suppress`/`unchanged` 并不再投递，不占用提醒预算；同一来源的观测内容变化仍会提醒。未提供观测摘要的旧 Goals 不做此去重。去重记录与决定在同一事务内持久化，重启后保持；若决定后、交给 Delivery 前发送窗口已关闭（例如重试落入静默时段），该记录被撤销，下一同内容事件仍可提醒。Delivery 接受后又过期或失败不会撤销去重。目标 revision 或来源配置变化、或主人对上次提醒给出 `proactive_feedback`（接受；拒绝另受拒绝冷却约束）后，才可再次提醒。提醒以 attention 目的 `result` 投递（无工作项或结构化问题，不适用 `attention`）；旧 Delivery 忽略该字段。要求 Delivery 支持 `enqueueOwnerNotification`、已配置主人路由，并为背景主体 `assistant-proactive/v1` 授予该会话消息的 `send` 权限。设置 `maxRemindersPerGoal` 为正数；重复处理同一决定复用相同投递键。Web 在原会话输入区显示“主动提醒”，重启后可继续读取；其他渠道通过已有适配器发送。
- `prepare`：默认只保存目标、事件标识与判断理由，供 `proactive_status` 查询；省略 `preparation` 时不生成模型草稿、不修改业务文件。显式配置 `preparation { provider, model, budgetId, maxOutputTokens, timeoutMs }` 后，才会排入持久准备队列并请求一次真实模型草稿。该草稿使用独立 Session、最多一次模型请求、`tools: []`、`maxToolCalls: 0`；准备运行只解析预设身份，不装载预设工具和 persona，原目标保持 `paused`；运行器禁止工具执行；提示要求只提供草稿、不声称完成或验收。模型文本本身不构成执行或验收证据。`proactive_status` 返回的草稿始终是 `verified: false` / `unverified-draft`，不是验收结果。目标继续等待后续事件，直到截止或主人控制。
- `proactive_feedback`：当前已认证主人可以接受或拒绝指定决定；拒绝为该目标/策略的后续决定设置持久冷却。反馈不会撤销已经执行的业务动作，也不会创建执行授权；对准备任务，拒绝会取消排队、请求在途运行停止并拒收迟到结果。

收益值为操作者配置的同一抽象单位，公式为 `floor(expectedBenefit * successPpm / 1000000) - executionCost - interruptionCost - possibleLoss`。它们不是独立测得的成功概率、货币成本或真实效果。策略首次用于目标时冻结；改变部署配置不会放宽该目标已冻结的策略。预算统计覆盖同一主人和目标下的所有策略；执行预算仍由 Goals 单独强制执行。

静默时段按 IANA 时区计算，支持跨午夜。合并等待和静默结束依靠 Goals 的周期核对；重启后继续读取原记录。事件内容不提供权限，也不作为新的目标指令。提醒投递有效期不晚于目标等待期限或下一个静默时段开始；未及时发送的提醒会失效，不跨静默时段补发。发送前及 Web 读取时重查原主人、绑定代次、路由和当前发送权限。Web 接受表示通知已可供读取，不表示用户已阅读。

`remind` 策略可选读取 Evaluation 的注意力版本（WP22 切片 2）：每次评估时按目标 scope 的 workspace/preset 与 cohort `owner-notification` / `assistant-proactive/v1` 调用 `currentAttentionTuning`，只接受界内、非默认、带 digest 的版本，并仅在本次评估叠加到冻结策略上（不写回冻结快照）：提高 `interruptionCost` 与 `minimumUtility`、在已配置静默时段两侧延长（未配置静默时段则不变）、或以 `attention-muted` 静默消费提醒。决定记录 `attentionTuning: { version, digest }`；提醒文本与有效期使用叠加后的估值和静默时段。Evaluation 缺席、开关关闭、返回版本 0、抛错或格式不符时不叠加，行为与未调参完全一致。`prepare` 与 `execute` 策略不受影响。

## 权限与数据

- 文件系统：保存配置数据库及 SQLite WAL/SHM；其中含主人身份范围、目标文本、事件标识、判断、反馈，以及按目标与来源记录的最后一次提醒内容摘要及是否已交给 Delivery（`proactive_reminders`，旧库启动时自动增建，不改动既有表）。另保存 `databasePath + '.preparations'` 及 WAL/SHM，其中含准备请求、模型草稿、有限 usage、独立 Session ID、状态和原因。数据库要求私有普通文件及不可由组/其他用户写入的父目录；不读取事件正文或业务文件。显式开启 `intakeEvaluation` 后，已认证的入站正文只在本插件与 WorkItems 进程内持有并调用模型，不写入本插件数据库；评估结果与引文偏移由 WorkItems 自己的数据库保存。
- 网络：本插件本身不直接联网；显式开启准备后，`assistant-automations` 通过宿主已配置的模型 provider 发送草稿请求，目标文本和草稿会进入该请求和本地准备账本。显式开启 `intakeEvaluation` 后，本插件只通过宿主 `llm` 服务调用配置行里冻结的 provider/model，每次请求携带一个规则的 ID、ceiling 和已认证入站正文（不回传其它工作项、主人身份或工具）。子进程、凭据、浏览器、安装脚本：本插件均不直接使用。
- 工具：注册 `proactive_status` 和 `proactive_feedback`，均要求真实 Agent、Delivery 主人身份及 Policy；反馈还要求当前主人请求。Policy 资源为 `goal:proactive-opportunities`，动作分别为 `inspect`、`feedback`；安装配套 Policy 后，仅严格匹配的只读 `proactive_status` 可按当前 owner 和 Policy 预授权，其他调用仍由宿主审批。
- 执行：未配置 `preparation` 且未开启 `intakeEvaluation` 时本插件不执行模型调用、不恢复目标；提醒通过 Delivery 的有类型接口持久入队。配置准备后还要求 Automations、Goals、Delivery 和 Policy 都可用，且 `background:assistant-proactive/v1` 对该 goal 的 `prepare` 被允许。开启 `intakeEvaluation` 只新增一次 allowlisted 且未点名的 inferred 入站文本判断，不写工作项、不准入、不派发、不恢复目标、不发送消息；accept 结果是否变成工作项仍由 WorkItems 自身的 `intakeLedger.evaluation.admit` 授权。真正业务操作及消息发送的权限由 Goals、Delivery 与具体工具负责。
- 卸载释放数据库和工具；保留历史数据库，重新安装可继续读取。删除历史数据库会丢失本插件计数和反馈，不应在活跃目标期间清空。

## 当前边界

提醒为结构化文本；Web 读取继承固定主人会话能力，并重查当前发送权限，不另设独立的消息读取 Policy 动作。`prepare` 只有显式 `preparation` 配置才生成模型草稿。准备队列持久化：重启发现 `running` 记录时标为 `unknown` 且不自动重试；撤销授权、目标/来源变化、静默截止或目标截止、主人拒绝都会阻止排队或在途准备。已经写成的 draft 不会因后续 feedback 删除。草稿未经独立验收，不能作为原目标完成、业务事实或主动性效果的证明。`intakeEvaluation` 默认关闭；开启后只评估注册之后到达的 inferred 行（入站正文从不落盘，重启不会重放历史正文），评估本身是 observe 证据，不是工作项准入、执行成功或主动性收益的证明。当前提供配置估值的事件筛选，未证明长期主动性收益；长期观察可在交付后的使用中进行。

## 兼容性

遵循仓库 [兼容性基线](../../docs/compatibility.md)。可选服务缺失时不授予执行能力。`intakeEvaluation` 需要的宿主 `llm` 与 `@dsh-enhanced/assistant-work-items`（`intakeLedger.evaluation.enabled: true`）都是可选 peer；缺失或未启用时本插件不注册评估者、行为与未配置一致。
