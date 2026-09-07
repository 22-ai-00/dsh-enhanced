# @dsh-enhanced/assistant-goals

为 DSH 原生目标保存有 owner 身份的业务上下文：原始目标、当前目标、下一步、阻塞、到期假设、证据引用和依赖。新会话可以找回同一 owner 的目标笔记。原生 `complete` 只显示为 `awaiting-verification`，不代表独立验收通过。

## 安装与启用

本包目前是开发中的独立 bundle，已接入显式 `web` 安装场景的目标上下文组合；步骤验收、整体结果与累计预算仍需配置。正式发布后也可安装到已有 profile：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-goals
dsh --profile web --dump-config
```

Host 须提供 `0.1.2-rc.1` 的 AgentRegistry、GoalService、SessionProjectionRegistry，以及本仓库当前版本的 `assistant-delivery` 和 `assistant-policy`。工具需要 ToolRuntime，动态上下文需要启用 runtime context 的 SystemPrompt。缺少必需服务时插件保持未就绪，不从模型参数推断身份。安装本包不会安装或启用原生 goal-round-driver，不会启动新的模型循环。

**仅有 Web 对话不构成 Delivery owner 证明。** 当前入口要求已有 Delivery 配对和实际 owner 会话；`assistant-web-owner` 与 Web setup 已提供固定本地 owner 的入口。完整自治验收、生产计量和隔离安装仍在开发。使用全局旧版 DSH 或只复用 Web 模型线路，也不能代替 Host 兼容性验证。

可覆盖 bundle 配置：

```yaml
- id: dsh-enhanced-assistant-goals
  name: '@dsh-enhanced/assistant-goals'
  config:
    databasePath: !!js dshHomePath('assistant-goals.sqlite')
    maxContextChars: 12000
    verifyNativeRounds: false
    stepMaxDurationMs: 60000
#    backgroundWake:
#      ownerRouteId: local/owner
#      budgetId: goal-budget/owner
```

`databasePath` 默认 `~/.dsh/assistant-goals.sqlite`，必须是绝对路径（仅测试使用 `:memory:`）。`maxContextChars` 为每次自动上下文的字符上限，范围 1,024–65,536。数据超限时返回明确提示，不截断 JSON 或伪造完整证据。

将下面的精确范围规则合并到现有 Policy `rules`，替换 workspace 为实际绝对路径；不要覆盖原有规则。它授权目标创建和笔记操作，工具执行授权仍按 Host/Policy 现有规则处理：

```yaml
- id: primary-business-goal-context
  effect: allow
  subject:
    kind: agent
    id: primary
    workspace: /absolute/path/to/workspace
  actions: [create, edit, pause, resume, clear, observe, inspect, snapshot, focus, checkpoint]
  resource:
    kind: goal
    id: business-context
  context:
    initiators: [external]
```

## 使用

在已认证 owner 的当前人类回合中，用 `goal_create {"objective":"完成九月交付报告","max_goal_rounds":2}` 创建目标。DSH 原生 `create_goal` 只接受 `source.kind: user`；Delivery 保留真实 `delivery` 来源，由本插件核验 owner 当前 turn 后调用原生 GoalService，不伪造直接用户消息。工具执行权限还须按现有 Host/Policy 授权 `goal_create`、`goal_context`、`goal_checkpoint` 和 `goal_control`。

插件在 `goal/changed` 时建立业务记录。安装前已有或身份不明时创建的目标不会被追认，以免归属转移泄漏历史。创建不覆盖尚未完成的原生目标；原生状态为 complete 后可按 DSH 规则创建新的 GoalId，旧业务记录仍保留为待验收；如果目标已经创建而业务索引失败，会明确报告部分完成，先检查原生目标再重试。已有 Host goal-round-driver 若已启用，会按其原生规则继续执行新目标；本插件自身不启用该 driver。

1. `goal_context {}` 列出最近的目标摘要及版本；最多读取 50 条，输出受字符预算约束，`truncated` 明确标记省略。
2. `goal_context {"goal_id":"返回的业务记录 ID"}` 查看原始目标和笔记；业务 ID 与原生 GoalId 不同。
3. 使用返回的 `version` 保存下一步：

```json
{
  "goal_id": "返回的业务记录 ID",
  "expected_version": 1,
  "next_step": "读取当前测试结果，再检查失败原因",
  "blockers": [],
  "assumptions": [{ "statement": "上次测试仍代表当前代码", "expires_at": 0 }],
  "evidence_refs": ["run:example"],
  "dependencies": []
}
```

这是 `goal_checkpoint` 的参数；`expires_at` 是 Unix 毫秒时间，示例 0 表示已到期。版本变化会拒绝旧写入，应重新读取再决定是否更新。依赖只能指向相同 owner record/version、workspace 和 preset 的业务目标，不允许重复、自依赖或环。

新会话使用 `goal_context {"goal_id":"已保存的业务记录 ID","focus":true}` 后，后续模型步骤会收到该目标上下文。focus 只保存引用，不创建、转移、恢复或完成原生目标；开始新的原生目标会切换到新记录。跨会话 focus 和笔记在插件重启后保留。过期假设标记为 `stale`，当前没有自动重查执行器。

## 修改、暂停和恢复

在原目标所属的当前 owner 会话中调用 `goal_control`，`expected_revision` 使用 `goal_context` 返回的 **native.revision**，与保存笔记的 `expected_version` 不同：

```json
{
  "goal_id": "返回的业务记录 ID",
  "expected_revision": 1,
  "operation": "pause"
}
```

操作支持 `edit`、`pause`、`resume`、`clear`。edit 至少提供 `objective` 或 `max_goal_rounds`；其他操作不接受这两个字段。每次操作读取当前原生目标，由 DSH 以调用方的 `expected_revision` 做 CAS，旧值会被拒绝。修改保留 `originalObjective` 和检查点；clear 清除当前原生目标但保留业务记录及历史，不删除数据。

这些操作要求实时 owner 当前回合，并分别获得同名 Policy action 的授权。跨会话 focus 不能据此控制原会话目标；恢复必须在原 Session 完成。原生进程重启后 activation 为 disarmed，存储的 focus 和笔记不会自动重新授权执行。resume 使用原生机制重新激活；它不重置已使用的目标轮次。暂停停止后续原生续跑，不宣称已经终止正在执行的工具、子进程或外部动作。

若原生操作已提交，而随后 owner 被撤销、服务退出或业务读回失败，工具明确报告部分完成。先检查原生现状再决定后续操作，不用旧 revision 盲目重放。这里没有两套数据库的原子事务承诺。

## 原生回合的累计预算

可选 `executionBudget` 要求同时开启 `verifyNativeRounds`；默认不配置、不启用。它按 owner scope 与业务目标 ID 累计所有原生回合，普通前台回复不计入。下面是配置形状，数值仅为示例：

```yaml
verifyNativeRounds: true
executionBudget:
  modelCalls: 20
  toolCalls: 40
  inputTokens: 100000
  outputTokens: 30000
  costUsdMicros: 2000000
  durationMs: 86400000
  maxOutputTokensPerCall: 4096
```

次数、token 和可选费用上限为 0–1,000,000,000 的整数；费用单位是百万分之一美元。`durationMs` 为 1ms–31 天，从业务目标创建时间起算；`maxOutputTokensPerCall` 为 1–1,000,000,000。暂停、恢复、修改目标定义或插件重启不会重置已保存的上限、计数和期限；已有目标的配置变更会拒绝冲突，不自动扩额。新建且重新获 owner 授权的业务目标拥有独立预算，本功能不是账户级总预算。

启用前，可信 Host 必须调用 `ctx.assistantGoals.registerBudgetMeter()`，为实际 `provider` / `model` 精确路由注册 `GoalBudgetMeter`。`inputTokenUpperBound(options)` 必须给出实际完整请求（包括消息、工具、多模态及提供商封装）的输入 token 上界；两个 `*UsdMicrosPerMillionTokens` 费率必须保守覆盖输入/缓存和输出/推理的全部收费类别。此 API 没有模型工具入口，返回的 disposer 应纳入 Host 的 Cordis 生命周期。包内不预装通用计量器或生产路由价格；缺少计量器拒绝调用，配置了费用上限但任一费率未知也拒绝调用。未配置费用时可将两个费率都设为 `null`，只约束次数与 token。可信计量声明和适配器遵守输出上限是保证的前提，不能把估算或未知价格称为提供商账单硬限。

可选的 [assistant-deepseek-budget](../assistant-deepseek-budget/README.md) 同时提供固定 `deepseek-goal-metered` adapter 和两个 DeepSeek v4 路由 meter，使用保守输入预留、实际输出限制及完整 usage 结算。该插件默认关闭、有明确契约到期时间，不提供金额上限；真实付费 API 兼容性仍待验证。它不替代任务验收 profile 或 owner 授权配置。

每次实际模型请求在提供商调用前，用 SQLite 事务预留一次调用、完整输入上界和输出上限；请求的 `maxTokens` 同时限制为每次上限与剩余额度。只有流完整结束且 usage 有效、不超过预留时才结算。输入按 uncached + cacheRead + cacheWrite 累计，reasoning 属于 output 不重复累计；若有 `totalTokens`，必须等于完整输入与输出之和。取消、异常、缺失/无效 usage 或崩溃保留全额预留，不自动退款或重放。工具执行体进入前计一次工具额度，失败也不退还；没有预算的工具不会进入执行体。

计量等待、流读取与目标回合受同一绝对期限和取消信号约束；计量器撤销会取消使用它的在途调用。期限取消和停止等待不证明提供商、第三方工具或 OS 进程已经停止，未知执行仍保持待对账。`goal_context` / 新模型上下文的 `executionBudget` 展示累计与 held 预留；可信 Host 可用 `inspectBudget(agent, goalId)` 和 `health().budget` 查看状态。

## 单次计划唤醒（可选）

后台唤醒默认关闭，Host 还须安装并连接 `assistant-automations`。`backgroundWake.maxDelayMs` 默认一天、最多 31 天；`runTimeoutMs` 默认 60 秒，范围 1–300 秒。实际到期时间还受目标创建时起算的累计预算期限限制。配置要求 `verifyNativeRounds: true` 和持久 `executionBudget`。调度时核对有效 Delivery owner route，以及 Policy 中 metric 为 `automation-runs` 的 `backgroundWake.budgetId`；实际模型调用还必须通过该路由的可信 Host meter 检查，缺少 meter 时不会调用提供商。

`goal_schedule` 设置 `wake_at`（UTC epoch 毫秒）需要当前认证 owner 的人类回合；省略 `wake_at` 时只检查已有计划。它以原生 revision CAS 暂停目标、完成 Session checkpoint，并为同一业务 Goal、原 Session、原生 GoalId、revision、owner record/version 和定义建立一次性 `at` 意图。恢复仍限定在该原 Session/Goal/revision；没有 recurring、跨目标、跨 owner 或“全部目标”调度。

可选 `preauthorizedSchedule: true` 允许有限隔离作用域中的精确 `goal_schedule` 免逐条审批；默认关闭，不改变工具默认注册或省略 `wake_at` 的检查行为。开启要求持久 `backgroundWake`、累计预算、步骤与全目标独立验收，并在每次调用核对当前 owner 人类回合、原 Session/Goal/revision、剩余预算、精确模型 meter、owner route 和两个隔离验收 profile。免审批参数必须恰为 `goal_id`、`expected_revision`、`wake_at`；验收条件必须覆盖唤醒的有效期限。该只读预检查不创建预算或验收任务，实际执行仍经过 Policy 授权和原有 CAS；它不开放 `goal_control` 或其他目标操作。

维护者可用 `DSH_ISOLATION_TEST_IMAGE=sha256:<本机已有镜像摘要> pnpm test:autonomy:wake` 验证实际安装、进程重启、撤权拒绝及中断后不重放；本机 Chromium 可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。该测试显式添加固定验收条件、精确 owner route、后台 Policy 和确定性模型计量器，不证明默认安装已具备生产模型计量或完整自治能力。

后台恢复要求 Delivery 提供版本 1 的终态验收等待能力；旧版缺少该能力时在调度与执行边界拒绝。原生 idle 或达到轮次上限不是验收结束：Delivery 保留原 Agent 和会话租约，等待这个 Agent 的步骤及全目标验收，随后重新核对授权、期限和状态。最后一轮可先达到轮次上限，再凭对应 owner/定义/实际执行的独立全目标回执转为 complete；不能仅凭较大的 revision 推断完成。

协议依次持久化 Automations 的 **paused** 定义、Goals 的不可变 definition-hash 绑定、再激活定义。Delivery 在恢复前重读 owner route、目标和期限；紧邻原生恢复前 Goals 用 occurrence CAS 写入 dispatch。已派发后的退出、lease 到期、撤权、期限或 teardown 都不证明执行停止，因而 unknown 不自动重放；进程崩溃留下的 dispatched 记录同样禁止重放，保持未确认状态等待对账；没有 dispatch CAS 的 scheduler 终态只收敛为 denied。Session 忙碌或前置授权失败会拒绝本次 wake，不自动延期；由 owner 检查后决定下一步。Automations、Goals、Delivery 与 Session 不是原子事务。

## 诊断与边界

`verifyNativeRounds: true` 为已经启用的原生 goal-round-driver 接入独立步骤验收。它还需要 Delivery 的 `agentGoalContinuationTimeoutMs` 为正、上述 goal Policy 额外允许 `execute`，以及同一 Host 的 `assistant-verifier`。Verifier profile 使用 `taskKind: goal-step`，精确匹配实际 owner record/version、workspace/preset 和当前目标 objective；成功条件与 authority 按 Verifier README 配置。没有匹配 profile 时，即使 Verifier 设置 `requireAcceptance: false`，该目标回合也会在模型调用前停止。默认不开启此行为，也不自动挂载 driver。

每个真实原生回合在模型调用前持久保存定义版本、原 Session/GoalId/revision、step/run、轮次上限、Policy 授权摘要、期限及 v2 验收绑定，并先完成 Session flush。`stepMaxDurationMs` 为单步骤期限，默认 60,000ms，范围 1–300,000ms。目标 objective 修改递增语义定义版本；pause/resume 或修改轮次上限只改变 native revision。模型请求与工具执行前重查 owner、定义、revision、轮次上限和期限，目标完成后也不再放行该回合的新工具。

实际回合终态和 Session checkpoint 供 Verifier 独立回读；验收结果进入 Evaluation 的独立 `goal-step` 投影。普通前台仍按原始入站消息验收。原生 complete、步骤运行成功和整个业务目标达成分别记录，单个步骤回执不会自动完成业务目标；历史旧定义成功也不能成为新定义的执行权限。启用步骤验收后，`goal_context` 与每次模型上下文提供 `stepFeedback`：重新验证完整合同、回执、owner/scope、定义和真实执行绑定。当前已结算结果与待验收步骤分列，最多回读当前 owner/目标的最新 50 个执行、展示 3 个历史条目；旧定义和过期证据不能当作当前成功。失败条件用于修订计划，未知执行要求先对账，成功步骤仍要求检查目标剩余条件。模型检查点不能覆盖这些结果，反馈建议不授予权限。Host 可用 `executionRuns(agent, goalId)` 和 Verifier `inspectAcceptedTask(contractId)` 取得完整绑定；带权限检查的 `describeForAgent(agent, goalId)` 与工具使用相同反馈路径。

回合终态持久保存后，运行一次现有 Verifier 的有界检查周期。下个模型上下文组装等待同一 Agent 的上一终态结算，再刷新本插件的上下文；取消信号与期限约束等待。繁忙队列可能仍显示待验收，不承诺一次检查就取得该目标的回执。读取不缓存成功；Verifier 卸载、绑定不匹配或证据无效会明确失去可用验收结果。步骤反馈只能引导后续决策，当前没有独立的调查动作执行器；可选的整体结果核验见下文。

取消、超时或失去授权后，旧 Agent handle 保留拒绝护栏，迟到工具即使用新 signal 也不能继续执行。支持范围是 Delivery 的实际生命周期：结束后释放旧 handle，下一个 owner 回合从同一 Session 创建新的 handle；不能复用被取消的旧 Agent。停止等待不证明不合作工具、子进程或外部动作已终止，相关回执保持 `unknown / quiescent:false`。重启时已 dispatch 且没有终态的 run 记为 unknown，先查证，绝不自动重放；仅 prepared 的意图也不会恢复提交。`health().execution` 分别报告 enabled、verifierConnected 和 activeRounds。

可信 Host 可读取 `ctx.assistantGoals.health()` 的 `ready`、`goals`、`awaitingVerification`、`observationFailures`。`ready` / `contextReady` 仅表示上下文必需服务存在；空目录时检查 Delivery 配对、当前人类 turn、workspace/preset 和上述 Policy 授权。扁平字段分别报告步骤验收、整体结果、预算和唤醒的启用与连接状态，以及已注册 meter 数量；原有 `execution`、`outcome`、`budget`、`wake` 对象继续可用。`assistant-health` 只采集公开的低基数诊断字段，缺少已启用能力的依赖、预算 meter 或仅启用上下文时给出降级原因。拥有 meter 不证明当前模型路由有计量器，组件连接也不证明任意 owner/目标已具备 profile 或授权。观察失败会计数，原生 goal 自身不会因此被改写；诊断不向模型提供跨 owner 目录。

- 原始目标保持不变；原生 edit 更新当前目标投影。笔记和证据引用都是未验证的数据，不获得权限，也不构成 achieved 回执。
- 每次新上下文/工具访问重查 live Agent、owner record/version 和 Policy。SystemPrompt 已经写入 Session 的历史快照不会被此插件擦除；不能把撤销新读取权限等同于历史清除或跨 owner 复用旧 Session 的隔离保证。
- Delivery 桥接覆盖创建、业务笔记和 owner 的 edit/pause/resume/clear；没有给模型增加独立验收成功写入入口，native complete 仍由受支持的原生入口或可信 Host 管理。
- 本包已有可选的原生回合与整体结果验收、单步骤期限、跨步骤累计预算和一次性计划唤醒；完整持久多步骤编排、跨日生产运行和生产安装路径仍待完成。

## 原生策略子任务（可选）

配置 `strategy: {}` 后，已准入的原生目标回合可以通过 `goal_strategy` 调整解题方法：`investigate` 分析给定上下文，`review` 检查推理，`compare` 顺序请求两个独立视角。明确的下一步继续直接执行；调查结果只是 `unverified` 建议，不能代替步骤或整个目标的独立验收，也不能把模型的自我评价作为策略收益。

需要持久 `databasePath`、`verifyNativeRounds: true`、`executionBudget`、当前模型路由的可信 meter，以及 Host `subagents` 服务。Policy 还须允许当前 owner/workspace/preset 的 goal `delegate` 和 tool `goal_strategy`；拒绝规则继续优先。默认不开启，不授予子任务文件、网络工具或通用 owner 身份。这里的调查只分析调用方给出的材料，模型请求会发往父目标同一 provider/model。

默认限制为 `maxDurationMs: 30000`、`maxPromptBytes: 32768`、`maxOutputBytes: 16384`、`maxRunsPerGoal: 16`，最多分别为 300000 / 65536 / 65536 / 32。期限同时受父回合和目标累计期限约束。父工具及全部子模型调用共用原目标预算；子调用用独立 run ID 记账，工具结果和后续目标上下文显示调用/token/已知费用及未结算预留。没有为子任务发放新的预算。

使用 DSH 原生 `ctx.subagents.start()` 与 `startInProcessRun()`，不复制 AgentLoop。策略 schema 2 位于 `databasePath + '.strategies'`，保存 intent、父 run/Session、定义摘要、模型路由、子 Session、终态和输出摘要，不保存建议正文；原生 Session 仍保存模型交互。schema 1 在事务中验证并迁移，旧记录缺少的子任务诊断保持缺失，终止原因保持 unknown。预算与策略账本分别提交，重启将未完成记录标为 unknown，不自动回放，也不退还未知模型预留。未确认停止的子任务不能记录为成功。只读策略建议不是操作系统沙箱承诺；Host 扩展仍属于受信任进程代码。

新子任务的 `diagnostics` 记录实际工具拒绝次数、输出是否满足非空/长度限制，以及预算运行时最后观察到的失败阶段（准入、请求限额、meter、预留、模型流、用量或结算）。阶段说明失败发生在哪里，不从异常文本猜测预算耗尽或推理错误。`failure.dispatched` 只表示取得了下游流迭代器；不证明真实供应商请求，false 也不证明没有外部效果，更不触发退款。策略工具和历史还给出期限、取消、父授权变化、执行失败或无法确认停止等终止原因。

后续目标上下文最多展示 3 次策略及每个父步骤的 3 项验收条件。`parentStep` 每次重验当时 exact run/Session/定义的独立回执，不能用后续成功覆盖早先失败；缺失、过期或定义变化保持显式状态。`attribution: same-parent-step-only` 仅为关联，不给策略记因果功劳，也不把建议评价为正确。明确执行故障时先检查执行链，独立条件失败时修订解法，unknown 执行先对账。Host 的 `inspectStrategyAssessments(agent, goalId)` 与目标上下文使用同一 owner 授权和有界读模型。

## 权限与数据

- **文件系统**：保存目标原文、owner scope、笔记、focus 和追加历史到独立 SQLite；使用 WAL 与 FULL 同步。新建数据库权限为 `0600`，启动前后检查数据库及已有 WAL/SHM 的私有权限、所有权和链接。目录创建为 `0700`，直接父目录须属于当前用户且不可被组或其他用户写入，不修改既有父目录权限；这不是对同 UID 恶意进程或路径替换的 OS 隔离保证。数据库不加密，应置于可信私有目录。启动时重建并核对历史与当前状态，拒绝损坏/截断记录及无效 focus；这不是密码学防篡改日志。当前没有历史自动清理。
- **网络**：本插件不直接联网；注入的上下文及工具结果会随宿主请求发送给所选模型提供商。
- **步骤账本**：开启验收时另写 `databasePath + '.executions'` 及其 WAL/SHM，保存目标原文、scope、定义/原生身份、期限、授权摘要、契约绑定及执行终态，使用同样的私有文件要求。执行账本 schema 2 在事务中迁移旧记录并添加 owner/目标/时间查询索引，每次读取核对派生键与原意图。两套 SQLite 与 Session 不是一个原子事务；dispatch 标记后的未知窗口不自动重放。卸载保留两套数据文件。
- **预算账本**：启用累计预算时另写 `databasePath + '.budgets'` 及其 WAL/SHM，保存 owner scope、业务目标 ID、不可变上限/期限、run/request ID、预留和结算 token/费用、工具次数；不保存请求正文。沿用私有文件、WAL/FULL、启动完整性检查要求，卸载保留文件。预算库、执行库与 Session 分别提交，未知预留保持占额，没有自动清理或退款入口。
- **唤醒账本与后台执行**：启用 `backgroundWake` 后另写 `databasePath + '.wakes'` 及 WAL/SHM，保存原始目标、owner/binding 身份、原 Session/GoalId/revision、定义 hash、时间和派发状态，沿用私有权限及 WAL/FULL。还会通过 Automations 写入持久 at 定义、occurrence 与执行记录，通过 Delivery 重新加载原 Session；后台模型和获准工具使用当前 Host 的 preset、Policy 与预算权限，可能产生模型费用及外部动作。卸载保留这些数据库和调度记录，但注销执行器、撤销当前 wake capability；不能以卸载推断在途外部动作已终止。
- **子进程与验收网络**：本插件不直接启动进程或请求外部目标；启用步骤验收后会调用 Host Verifier 的检查周期，由它按已批准的 profile/authority 执行程序验证、文档获取或目标回读，沿用其期限、证据预算和权限范围，见 [Verifier 权限说明](../assistant-verifier/README.md)。
- **凭据、浏览器、安装脚本**：无直接访问。
- **卸载**：移除 bundle 后注册和数据库连接随 Cordis 生命周期释放，数据保留；停用所有使用该库的 Host 后可手工删除数据库及其 WAL/SHM。插件不写自定义 Session event，原生目标仍由 DSH 管理。

## 兼容性

见 [仓库基线](../../docs/compatibility.md) 和 [完整落地账本](../../docs/agent-autonomy-implementation.md)。测试使用确定性模型和 transport，不代表真实 Web 部署或智能收益已验收。

## 整体目标验收

可选 `verifyGoalOutcome: true` 要求同时开启 `verifyNativeRounds` 并使用持久数据库。管理员还需配置精确匹配 owner、workspace/preset 和 objective 的 Verifier `taskKind: goal-step` 与 `goal-outcome` profiles。`goal_create` 和 `goal_control` 的 edit 在修改原生目标前查询两份配置；匹配文本遵循原生目标去掉首尾空白的规则。缺少规格、验证器未连接或有效期不足时拒绝修改，不留下本次新建的原生目标或契约。步骤 profile 的有效期须超过单步骤期限加步骤验证预算；整体 profile 还须覆盖整体验证预算。这是最低配置要求，排队与后续工作仍受原有绝对期限检查。

创建或改变 objective 时冻结 v3 整体成功条件；只改轮数或提交同一 objective 时沿用原条件、profile 摘要与绝对期限。如果当前配置已替换冻结规格，或原截止时间不足以覆盖下一轮和验证，编辑会在原生修改前拒绝，不通过重新冻结来延长期限或放宽标准。预检只读配置，不创建虚构的任务身份，也不授予执行权限；实际绑定与派发仍重新核对。原生修改、业务索引与验收账本并非一个事务，预检之后的写入或身份变化仍可能造成部分失败，此时应先检查已有原生目标。

上述跨轮次冻结针对 v3 整体成功规格。v2 步骤规格在每个实际 run 派发前分别冻结：管理员可更新后续新 run 的步骤 profile，预检会检查当前版本及有效期；该更新既不能重写旧步骤契约，也不能改变已冻结的整体成功条件。

每个真实原生回合有独立的 v2 步骤契约和 v3 整体目标 assessment。后续 assessment 保持初次条件、profile、预算和绝对截止时间不变，且截止时间必须覆盖原生回合及验证。`goalAcceptance` 向模型提供冻结条件、逐项失败与整体结果；步骤通过不能替代整体成功。更换目标定义会隔离旧结果，不能用旧定义的通过结果结束新目标。

新鲜的整体 achieved 回执可由 Host 重新核对 live Agent、owner/Policy、定义、Session/GoalId 和原生 revision 后完成原生目标，停止额外模型调用。回执已保存但原生完成尚未提交时显示 `nativeCompletion: pending`，后续模型步骤前尝试按同一绑定恢复完成；绑定改变或授权缺失时不会完成。已派发但无法确认的 assessment 在恢复时保持 unknown；丢失现场校验能力的成功 execution 也不能据此新签发 achieved 回执。历史回执不代表外部系统持续保持同一状态。

额外私有文件为 `databasePath + '.outcomes'` 及 WAL/SHM：保存冻结目标条件、assessment、触发 run 与执行证据，沿用 WAL/FULL 和私有权限，卸载保留数据。整体验证可能通过 Verifier 执行管理员批准的子进程、文档抓取或目标回读，权限与步骤验证相同。当前默认关闭；确定性模型的真实驱动测试不等于跨日实跑、云模型能力收益或生产 Web 安装完成。

Verifier 回执、Goals 数据库投影与原生 Session 事件独立提交。`nativeCompletion: complete` 表示当前读回的原生状态，不是跨库原子提交或操作系统崩溃后的 exactly-once 保证；原生完成追加不等待独立 Session flush。恢复只在已有状态、准确轮次与当前授权可核对时收敛，投影/Session 不一致需要继续对账。


## Host 任务检索上下文

`assistantGoals.taskContext(agent)` 返回只读 `goal-task-context/v1`：owner scope、目标 ID/definition version/digest、原生状态、objective 和 checkpoint nextStep。每次读取重新检查 live Agent、Delivery owner 和 Policy `snapshot` 授权；默认使用当前原生目标，也可使用同 owner 在本会话明确设置的 focus。当前会话的投影须匹配 live 原生 GoalId/revision/active 状态，终态、身份失效或拒绝授权返回 `undefined`。

这是 Personal Memory 等 Host 消费者的检索输入。跨会话 focus 不授予执行权，checkpoint 不成为可信事实；本接口不修改原生目标或业务索引、不创建模型调用或唤醒任务。Memory 可独立安装，并在该接口不可用时继续按原用户输入召回。

## 隔离验收与有限创建预授权

v4 的 step / whole-goal profile 可引用 Verifier 的 `isolated-process-behavior`。原生回合已持久 acceptance 并完成 dispatch admission 后，Goals 才向 Host Isolation 提供不可变 artifact admission。它不是模型参数，也不是 focus 的历史上下文。回合结束后，step 和 whole-goal 通过独立容器验收；失败反馈可用于后续原生回合修正产物，只有整体条件通过才由既有 Goals 完成判定更新原生目标。

`preauthorizedCreateMaxRounds` 默认 `0`，保持普通审批路径。显式设为 `1–32` 要求同时开启 `verifyNativeRounds`、`verifyGoalOutcome` 和 `executionBudget`；当前精确模型线路还必须已注册可用 Host meter。创建预授权只接受实时 owner 人类 turn、Policy 允许的 scope、精确 objective 对应的两个全 isolated profile，以及不超过配置的 `max_goal_rounds`。省略轮数时采用配置上限；额外参数、不匹配目标或不可用 meter 均不获得预授权。实际执行仍重查 Policy，deny 不会被绕过。

预授权绑定 shipped Goals 插件注册的 exact `goal_create` 工具，不授予 `goal_control`、其他 shell 或跨 owner 操作权限。Isolation 管理的 scope 仅为这个已通过预授权的创建调用开放路由。生产计量器与任务验收 profile 仍须由 Host 配置，安装场景不会从任意自然语言自动产生可信成功条件。
