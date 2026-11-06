# @dsh-enhanced/assistant-automations

面向个人助理的单机、冷启动可恢复调度器。它把 automation 定义、稳定 occurrence、task、attempt、run 和 duty lease 写入 SQLite；进程重启后从账本继续，而不是把内存 timer 当作事实源。普通 Agent automation 每次执行创建一个新的 DSH `0.2.0-rc.2` Agent，固定 workspace、preset 身份、provider/model、输出预算、工具白名单和工具调用上限；system-owned Host automation 调用进程内注册、版本和 catalog digest 精确匹配的固定执行器；执行器只有取得下述新预算与私有 invocation 能力后，才可启动一次有界原生 Agent。

执行前会先解析并挂载 automation 固定的 Agent preset，再在该 Agent 的最终工具平面上校验 immutable allowlist；preset 只提供 scoped tool 时也能被正确发现，preset 额外暴露未批准工具则整次 setup fail closed。通过校验的最终 tool schemas 会与 provider/model 无关地交给 Agent Loop；模型只供应生成，不决定工具可见性或授权，也没有部署侧 provider 能力名单。协议元数据缺失、`native` 和 `bridge` 都会放行；只有 adapter 主动声明 `toolCalls: none` 且最终 scope 非空时，才会在 provider 执行前因未实现统一 DSH tool-call 协议失败关闭。每次工具执行仍受 automation 白名单、调用上限、Policy、sandbox、审批和预算约束。

## 安装

本插件要求 `@dsh-enhanced/assistant-policy` 先提供 `ctx.assistantPolicy`，并要求运行中的 DSH profile 已有 agent loop、LLM、session 和 tools 服务：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/assistant-automations
dsh --profile web --dump-config
```

默认 `schedulerEnabled: false`，且 assistant-policy 默认拒绝，所以安装后不会在后台调用模型。确认规则和预算后再同时开启调度器与精确的 background allow 规则：

```yaml
- id: dsh-enhanced-assistant-policy
  name: '@dsh-enhanced/assistant-policy'
  config:
    databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
    rules:
      - id: allow-primary-automation-tools
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [execute]
        resource: { kind: tool, id: automation_* }
        context: { initiators: [foreground] }
      - id: allow-primary-automation-service
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [history, list, propose, run-dry]
        resource: { kind: automation, id: "*" }
        context: { initiators: [foreground] }
      - id: allow-reviewed-background-automations
        effect: allow
        subject: { kind: background, id: auto-daily-review, workspace: /absolute/workspace }
        actions: [execute]
        resource: { kind: automation, id: auto-daily-review }
        context: { initiators: [background] }
    budgets:
      - id: assistant-automations-proposals
        metric: automation-runs
        limit: 8
        periodMs: 86400000
        scope: workspace
- id: dsh-enhanced-assistant-automations
  name: '@dsh-enhanced/assistant-automations'
  config:
    databasePath: !!js dshHomePath('assistant-automations/state.sqlite')
    runsPath: !!js dshHomePath('assistant-automations/runs')
    schedulerEnabled: true
```

生产使用还必须由 systemd、launchd、Docker restart policy 或等价 supervisor 拉起 DSH。插件能恢复停机期间的账本状态，但不能在宿主进程没有运行时主动执行。

## 工具与审批

- `automation_create`：只提交 ID、名称、prompt、schedule 和 `allowed_tools`；workspace/preset/owner/投递绑定从当前 Agent 与 Delivery 派生，provider/model、执行上限、策略和预算来自可信配置，不会直接创建。
- `automation_list`：只读、有限输出；不回显 prompt、principal、数据库路径或运行目录。
- `automation_manage`：以 `expected_version` CAS 提交 pause/resume/delete 提案。
- `automation_run`：创建幂等 manual occurrence，并强制 `dryRun: true`、空工具白名单、无 delivery。兼容字段 `dryRun: true` 在 terminal sink 被解释为 `preview` 模式；即使 automation 定义带有 `deliveryBindingId`、模型成功返回非空结果，也不会创建 pending Delivery、进入 Delivery/Evolution outbox，或进入可信 Evaluation 账本。
- `automation_history`：按当前 Agent 的 exact workspace + preset 返回 newest-first 的有限 occurrence/run 摘要；`run_id` 可精确读取 Evaluation 指向的单次运行。历史归属使用 claim 时的不可变 definition snapshot，跨 scope 或无法验证的旧记录按 not-found 处理；输出明确标为不可信数据，且不暴露 session id 或 artifact 宿主路径。

模型发起的 create/pause/resume/delete 全部走 `assistant-policy`。模型工具 schema 不接受 principal、workspace、preset、provider/model、投递绑定、预算、TTL、执行上限或 retry/misfire/overlap 等 authority selector。存在 Delivery 时，服务通过当前 Agent 的已认证 owner binding 派生 principal/workspace/binding；没有 Delivery 的 headless 调用必须由可信宿主 API 显式提供 principal。提案 TTL 只来自配置。

本地数据库保存完整目标快照和不可变 dispatch route，policy 只保存摘要与 diff hash；可信通道或 UI 再调用 `ctx.assistantAutomations.decideProposal(...)`。批准时会重新校验 Policy 的完整 tuple 以及 lifecycle version；任何 proposal/requester/principal/action/resource/summary/diff/expiry/version 不匹配都会持久化为 `conflicted`，不会应用变更。

支持严格五字段 cron、IANA timezone、一次性 `at` 和 anchored `every`。`skip`、`latest`、`bounded-replay` 明确处理 misfire；catch-up 有硬上限。cron 在 DST 春季缺口自然跳过不存在的本地时间，在秋季重叠会产生两个不同 UTC occurrence。

## 可靠性语义

SQLite occurrence id 由 automation、trigger 类型和 scheduledAt/eventId 稳定派生并唯一约束。task 只在短事务中 claim；全局 duty lease 使用单调 fencing token，旧 owner 无法 heartbeat 或提交新 owner 的结果。过期但尚未启动的 `claimed` task 可安全重排；已经 `running` 的 task 默认变成 `unknown`。只有 immutable definition 明确声明 `retrySafety: idempotent` 且还有 retry 配额时，才会自动重排。

这不等于“外部副作用 exactly once”。模型可能已经调用外部工具，而进程在 run commit 前崩溃；默认的 `unknown` 正是对这段不可判定窗口的诚实记录。`overlap` 支持 `skip`、`queue-one` 和 `cancel-previous`，取消是请求而不是远端副作用回滚保证。`cancel-previous` 即使本地并发槽已满也会先在同一 duty fence 下持久标记旧 task，再由协调器中止本地 runner；新 occurrence 等旧 lease/槽真实释放后才 claim。`queue-one` 在已有 active task 时只保留最新一个尚未尝试的 occurrence，其余以 `overlap-queue-one-coalesced` 终结并保留 occurrence 审计；已有 attempt 的可恢复 retry 不会被该合并丢弃。

完整 JSON artifact 先通过同目录临时文件、fsync、atomic rename 写入，再提交 terminal run；SQLite 只保存有限 preview 和相对 artifact ref。artifact 写入失败会立即提交 content-free `unknown` + `artifact-write-failed` receipt，不等 running lease 过期，也不把可能已发生的模型/工具效果说成没有发生。execution 与 delivery 是两个状态域：若可选的 `assistant-delivery` 存在，带固定 `deliveryBindingId` 的成功 run 会以 `automation:<occurrenceId>:<bindingId>` 幂等写入它的 outbox；投递失败不会把成功 execution 改写成失败，后续 tick 只重试同一 enqueue。定义还可带有界的 `deliverySuppressExact`；空输出或精确匹配值会在同一账本中进入 terminal `suppressed`，不会送到 Delivery。该字段必须同时绑定 `deliveryBindingId`，Heartbeat 用它抑制 `HEARTBEAT_OK`。

Agent definition 还可由可信 Host/system owner 设置独立的 `approvalBindingId`。后台 Agent 的审批委托使用 `approvalBindingId ?? deliveryBindingId`，普通 run 结果仍只认 `deliveryBindingId`；因此只有审批路由的 analyst 不会把模型正文发给 owner。Agent terminal incident 也使用同一不可变 owner-facing 选择规则：优先 `approvalBindingId`，只为兼容旧定义才回退到 `deliveryBindingId`。模型可见的 `automation_create` schema 不接受 `approvalBindingId`，不能自行选择或扩大审批 authority。

schema v8 为每个 run 固化 Host 派生的 `executionMode`、immutable definition hash 和 typed execution diagnostic：`failureClass/failurePhase/failureCode`、prompt 是否已提交（Host 固定为 `not-applicable`）、外部副作用是否可能发生、retryability，以及固定 `automation-runs` 预算的 settlement 状态。真实 DSH runner 在 preset、Agent setup、prompt、模型、session flush、预算边界分别产生 receipt；自定义/旧 runner 缺字段时只记为 `unknown`，不会根据异常正文猜测。Agent 创建、session flush、Host 写入或已 finalized/unknown 的预算都不能声称 `sideEffectState: none` 或安全重试；一般 Agent/Host 的预算崩溃窗口同样保持 `unknown` 且不可自动重跑。唯一例外是 immutable definition 明确为 idempotent、executor 固定为 `assistant-recovery`、同一 occurrence 的后续受限 attempt：runner 会以绑定 automation、occurrence、definition hash、metric 与 budget 的 canonical key 重新读取 receipt。exact `reserved + replayed` 会续用原 reservation，取得 Recovery 的 durable terminal result 后只 finalize 一次；若 Recovery 与预算已经完成、进程仅在 Automations terminal commit 前崩溃，exact `finalized + replayed` 只再次调用幂等 Recovery executor 读取同一 durable terminal result，不再 finalize/release，也不重复外部动作。first attempt、普通 Host、non-idempotent、released、超出 retry 配额、非 replayed terminal receipt 或 key/definition/occurrence 漂移全部失败关闭；误建的新 reservation 会先释放，释放结果不明则记为 ambiguous。预算 settlement 只是记录现有完整 per-run reserve/finalize/release 语义，不把 token usage 改成计费单位。协调器把 timeout/cancel 与 runner promise 做有界竞速；即使 Agent flush/dispose 或 Host callback 不响应 AbortSignal，也会先提交保守的 unknown-boundary receipt，迟到结果不能越过 terminal CAS 改写账本。

Delivery 和 Evolution evidence 在每次出队时都会重新证明 exact production mode、claim 时的不可变 snapshot、definition hash；Delivery 还必须重新取得 snapshot 内的 binding。preview、legacy unknown、缺 snapshot、hash 不符或 poison row 都单调进入 `suppressed`，同批其他行继续处理。preview 即使 runner 返回 exact session 也不会查询 exposure receipt。v6→v7 迁移会在一个事务内清除历史 `dry_run=1` 的 pending evidence payload，并把可能残留的 pending Delivery intent 终结为 suppressed。

terminal run 还会在同一 SQLite 事务中写入不可变、有限大小的**运维证据**。稳定 situation 使用 `automation:<automationId>`，可编辑名称只进入展示 detail；`succeeded`、`failed`、`timed_out` 进入独立 evidence outbox，`cancelled`、`unknown` 则持久化为 `suppressed`。该二元 execution 结果不是回答正确或有用的质量证据；Evolution 只能把带 immutable Evaluation reference 的 objective/verification outcome 纳入学习。可选的 `assistant-evolution` 暂不可用或抛错时不会改变 run 终态，leader 后续以 `automation-run:<runId>` 重放同一条运维记录。runner 只有返回 exact session 时，证据才会携带 session；rule/version 还要求 Evolution 能查到 guidance 成功注入后持久化的同 session、scope、automation exposure receipt。计划中的 active rule 或 setup 前失败不会被伪装成因果证据。

`configuration`、`policy`、`budget` 的首个 **production** typed failure 会按 `(automationId, definitionHash)` 持久开路；后续 exact definition 在调用 Policy budget 或创建 Agent/Host executor 前失败关闭。preview 不读取、占用、打开或关闭 production circuit。改过的 definition 使用独立 hash，不被旧故障误伤；回退到旧 bytes（ABA）仍会命中旧 circuit。模型没有 reset/probe 工具；Host/operator 的 `probeCircuit(...)` 必须提交 exact system owner、current hash、circuit version、有界 lease 和 Recovery step 的 `operationId`，并再次通过 background Policy `repair`。probe transition 与 operation receipt 在同一事务：同 operation/exact payload 重放返回原 circuit 且 `replayed: true`，同 operation 异 payload 冲突，新 operation 不能冒认既有 half-open。CAS 只会把 `open` 变为持久 `half-open`，不会直接关闭。并发任务再原子竞争 `half-open → probing`，仅一个 exact production task 获得 probe；成功才 `closed`，失败/取消/超时或 lease 过期均回到 `open`。probe token 不出现在模型面或健康投影。`health().openCircuits` 统计所有非 closed 状态。

Host runbook 可调用非模型 seam `inspectSystemOwned({ owner, automationId })`。它先校验 exact system owner，只返回 current definition hash/version、按 production/preview 分栏的最新 terminal status/typed diagnostic（兼容别名 `latestTerminalRun` 只指 production）、经过 run hash + immutable claim snapshot 证明的历史 workspace/preset，以及当前 circuit/incident 的 content-free 状态；不返回 prompt、输出、artifact/session、usage 或 probe capability，也绝不拿当前 definition 猜历史 scope。

Host-only `inspectProductionOccurrence({ automationId, occurrenceId, workspace, agentPreset })` 查询一个精确 production occurrence。schema 17 在真实协调器完成事务中保存 runner 的可空 `quiescent`；旧行保持 NULL，不补造静止证明。只有完整终态、真实静止、无活动 task/attempt/lease、不可变历史 scope/definition 与安全预算状态同时成立，才返回不含任务正文的证明；unknown、preview、历史 NULL、损坏关联均返回 undefined。调用方仍须验证本任务绑定、owner 和所需预算状态。此接口不重试任务，也不把 worker 的 ready 报告当作客观成功。

Host-only `inspectOccurrenceAcceptance({ automationId, occurrenceId, workspace, agentPreset })` 只读返回该 occurrence 的 production worker task（`task-<occurrenceId>`）在提交 prompt 前冻结的 acceptance 句柄 `{ contractId, contractDigest }` 及其冻结时的 Delivery binding 元数据 `{ bindingId, bindingVersion, bindingGeneration }`；与 `inspectAcceptedExecution` 同样只认 production：dry run、不可变 task 快照为 host 定义或 scope 不符、已有终态 run 但其 execution mode 不是 `production`、无绑定均返回 undefined。不返回契约正文或判定，调用方（如 WorkItems `acceptance.bindWorkerRun`）须自行从 verifier 读回并校验契约（task.ref 为 `run-task-<occurrenceId>`）。验收准则来自该 automation 共用的 prompt 与 verifier profile，不随单个外部事件定制。

Host 消费者可用 `onSchedulerWake(listener: () => void): () => void` 把同步、有限的初始化重试挂到现有 scheduler tick。注册通过调用方 Cordis use-site effect 拥有，可幂等注销；consumer 卸载或 Automations 关闭后不会再调用。每次手动、自动或内部原生 tick 在数据库调度、materialize/claim 前通知当前每份注册一次，单个异常不阻塞其他监听者或调度。它不增加 timer、执行任务、预算或授权；消费者仅应在初始化未完成时重新检查持久退休/授权并 reconcile，完成后 no-op，业务扫描继续使用既有 cron 与预算门。`schedulerEnabled: false` 时没有自动唤醒；Host 可显式调用已有 `tick()`。

Host 可通过 `retireSystemOwned({ owner, operationId, automationId, definitionHash, expectedVersion, reason: 'owner-revoked', evidenceDigest })` 永久退休精确现存的 active/paused 定义。它沿用 background Policy `reconcile` 授权；可信 Host 调用方负责把精确 Delivery 撤权证据与扫描身份摘要成 64 位十六进制 `evidenceDigest`，接口不会新建定义、恢复 owner、转移 grant 或预留预算。schema v16 在同一事务中 CAS 暂停、清空 next-run、递增版本并追加独立永久标记；原定义内容与 occurrence/task/run/unknown 历史保持不变。`inspectSystemOwnedRetirement({ owner, automationId })` 只返回身份、版本、原因与摘要回执。退休后同 owner/id 的旧 reconcile 缓存、nonce/definition/key 变化、resume、重启和身份切回均不能激活，已排队任务不能获得新 claim。删除定义不会删除标记；幂等退休重放重新检查真实 paused/hash/version/next-run，状态已变化时拒绝旧成功回执。普通 `pauseSystemOwned` 仍是可恢复暂停。新 owner 配合新 automationId 可单独授权使用；不能重解释旧授权、额度或 unknown。

Host 可通过 `reconcileSystemExact` 以当前 definition hash/version 做事务内 CAS；它沿用 `reconcileSystem` 的 Policy 授权，拒绝缺失、跨 owner 或已变更的行。同一幂等键只能重放相同输入，返回原操作收据；调用方仍须读回当前行，不能把历史收据当作当前状态。该接口不出现在模型工具面，也不延长原有预算和授权。

Host definition 的 `execution` 固化 executor id/contract version、runbook id/version、catalog digest、target scope、owner route 和非 bearer `activationNonce`。normalize 会从 canonical `[workspace, preset]` 重算 `scopeDigest`，并要求 target scope 与 definition 的 workspace/preset 精确相等；Host surface 禁止 prompt/provider/model/tools、普通 `deliveryBindingId` 和输出 sink。registry 对重复 descriptor、多个 executor 同时 `accepts` 一个 spec、异常 accepts 都 fail closed；disposer 会使 registration token 失效并取消 lifecycle，非协作 callback 也由 bounded race 隔离。scheduler 在 materialize、claim、Policy budget 前三次证明 exact availability；不可用时不造 run、不耗预算，并按 exact automation/hash/stage 持久化 incident。

Host 消费者可通过内部 `registerHostShutdown` 把关闭动作归属自己的 Context，并绑定 exact owner、automation id 与 activation nonce。注册时通过 Policy 授权，consumer 卸载或 Automations provider 关闭时只暂停匹配的本代登记；provider 停用开始即拒绝普通调用，对每个回调最多等待 3 秒，再关闭存储，避免 Cordis 同级 disposer 并发导致登记残留 active。重复关闭复用同一 Promise，新一代登记不会被旧回调暂停。此接口不暴露给模型，也不保证进程被强制终止时执行；未知执行仍须按原有账本对账。

incident 与 terminal run、circuit 投影和 alert projection 在同一 SQLite 事务结算。Host 与带 owner-facing binding 的 Agent production run 在 failed/timed_out/保守 unknown 时都会 open；普通 succeeded 输出不会凭空创建 incident，主动 cancel 也不会为 Agent 新建告警。Agent 的后续 production attempt 在开始时持久进入 `recovering`，失败/进程 lease 过期回到 `open`，成功才 `resolved`。每行 incident 持久保存 reopen `lifecycleGeneration`、跨代单调 `presentationRevision` 和 CAS version。Host owner route 的同代 detail、`open → recovering → resolved` 只更新同一个 provider message；Agent 的 approval/result binding 不是 Host owner-route authority，因此每个 revision 使用独立稳定幂等键写入一条 content-free 状态更新。resolved 后再次失败会进入 generation+1。两条通道都从 terminal run 的 immutable claim snapshot 重新证明 exact route/workspace，不使用当前可变 definition，也不会包含 prompt/output/path。`enqueued` 仅表示期望投影已持久交给 Delivery，绝不表示 provider 已发送或状态已呈现。emergency stop 或 Policy 拒发时 incident 与 pending projection 保留；部署方必须为 `assistant-automations-incidents` 精确授权对应 owner route/binding 的 background send。`health()` 额外公开当前相关且未 resolved 的 `openIncidents` 和当前相关的 `pendingIncidentAlerts`。

对于尚未创建 run 的 `materialize`/`claim` 执行器可用性事件，若同一 system-owned automation 已换成不同 definition hash，旧的 open/recovering 行只保留为历史，不再计入当前健康、占用待通知批次或取得通知目标。发送前会再次核验定义；回退到旧 hash 后，旧事件会重新纳入判断。缺失当前定义、真实 terminal 失败和未知结果仍保留；resolved 待发送事件也保留，以便关闭先前的通知。此判断不改写历史账本或重试任务。

incident presentation 不调用公开的 Delivery publisher。Delivery 只向当前 Automations 实例的 exact
producer generation 签发私有、可撤销的进程内 registration；Automations 只把它保存在 coordinator
adapter closure 中，Agent、Automation definition、模型 payload 和普通 service caller 都不能伪造。服务
替换、卸载或 disposer 会立即撤销旧 registration；尚未成功呈现的 durable revision 留在本地等待有效
producer 与 Delivery 重试，而不是把 stale completion 显示成新状态。

Recovery 激活可使用 `runSystemDry({ owner, automationId, definitionHash, idempotencyKey })`：它要求 exact system owner/hash 和 background Policy `run-dry`，无 Agent 地创建一次 preview occurrence。激活方应以远未来 `at` schedule 临时置 active，preview 通过后立即 reconcile paused；即使中途崩溃，也不会产生到期 production schedule。preview 不产生 circuit、incident、Delivery 或 Evolution evidence。

Evaluation/Evolution 可直接调用 `resolveQualityEvidence(...)`，用 Evaluation 提供的 exact scope/situation/occurredAt/`automation-run` ref 重新证明 production、immutable attempt/snapshot/hash 和持久 evidence attribution。只有 `succeeded|failed|timed_out` 返回 frozen、content-minimal receipt；`validateQualityEvidence(...)` 会重新查账并 exact 比较。preview、cancelled、unknown、缺 snapshot 或篡改 tuple 一律无 proof，且 receipt 不含 prompt、principal、artifact、output 或 usage。

每个 **production** terminal run 还会原子写入独立的 Evaluation outbox；payload 固化 `executionMode: production`，并经 Evaluation 实例绑定的 process-local capability 写入可信账本。preview 从源头不创建该 outbox；升级前残留的 preview row 也会按 Automation 权威 run mode 直接终结，绝不发送。`assistant-evaluation` 未安装或暂时失败不会重跑任务，也不会阻塞 Evolution。发送使用稳定幂等键、超时、指数退避和有界尝试，永久失败进入 `dead-letter`，只保存有界错误类别而不保存异常正文。`health()` 分开公开当前 `pendingEvaluations`、`retryingEvaluations`、`deadLetterEvaluations`、最老 pending 时间，以及只用于做增量/速率观测的累计 `failedEvaluationAttempts`；历史失败总数本身不表示当前不健康。

schema v8 建立了需要停写的单 writer 升级边界；当前 schema v11 延续这一要求，不承诺旧 binary
与新 binary 的 N/N-1 并发兼容。v9 增加 incident lifecycle/presentation ledger，v10 增加受监督
Growth 的 operation 与 paused artifact 账本。部署必须先停止所有旧 scheduler owner，再备份 SQLite/WAL，
启动一个 v11 binary 完成迁移并验证后才恢复 supervisor；v11 为 Growth artifact 增加 canonical canary proof 列；旧 binary 看到更高 `user_version` 会 fail closed，
而不是假装可安全降级。

## 配置

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `databasePath` | `$DSH_HOME/assistant-automations/state.sqlite` | automation/occurrence/task/attempt/run/lease/proposal 账本 |
| `runsPath` | `$DSH_HOME/assistant-automations/runs` | 私有 JSON run artifacts |
| `schedulerEnabled` | `false` | 是否启动常驻调度 tick |
| `tickIntervalMs` | `5000` | 唤醒频率；不承担调度事实源角色 |
| `dutyLeaseMs` | `15000` | 单机多进程 owner lease |
| `taskLeaseMs` | `30000` | claim/running lease |
| `misfireGraceMs` | `60000` | 超过该窗口按 misfire policy 处理 |
| `maxCatchUp` | `100` | 单 tick materialize/recovery 上限 |
| `maxConcurrency` | `1` | 同时 fresh Agent 数量 |
| `maxArtifactBytes` | `1048576` | 单个 run artifact 上限 |
| `defaultProposalTtlMs` | `900000` | 默认提案有效期 |
| `reconcileIntervalMs` | `15000` | 提交“会话结束后才被批准”的提案的轮询间隔；即使 `schedulerEnabled: false` 也会运行；`0` 关闭定时器 |
| `reconcileLimit` | `50` | 每轮 reconcile 检查的本地待决提案上限 |
| `allowUnbudgetedExecution` | `false` | 是否允许无人值守 execution 不绑定 Policy budget；默认 fail closed |
| `proposalDefaults` | 见 patch | 模型提案使用的可信 provider/model、工具上限、execution bounds、策略和必填 budget |

## 延迟审批的提交闭环

`automation_create` / `automation_manage` 只创建提案。审批可能发生在原 turn 结束之后（例如几分钟后在飞书卡片上点击），因此本插件会周期性调用 `reconcileProposals()`：读取 policy 账本中该提案的**终态**，再走与 `decideProposal` 相同的 `createApproved`/`changeApproved` 路径。

该定时器**独立于 scheduler**：即使 `schedulerEnabled: false`，批准一个 automation 也必须生效，否则审批会永远悬空。

- **不推断批准**：pending 仍然是 pending。
- **幂等**：重复 reconcile 不会重复创建 automation 或重复结算。
- **冲突不丢决定**：版本已变化时提案降级为 `conflicted`。
- **无跨库孤儿或复活**：本地 creation intent 先冻结绝对 `notAfter`，再由 Policy 在同一 `BEGIN IMMEDIATE` 中按完整 tuple 原子 recover-or-create。attach 前崩溃后，deadline 前只会恢复/创建同一个 proposal；既有终态即使 deadline 已过也会精确结算；deadline 后仍缺失则写永久 tombstone 并将本地 intent 置为 `conflicted`，普通 propose 也无法再生成孤儿审批卡。
- **有界公平**：每轮仍为 pending 的记录会持久化轮转，终态记录不会因固定 limit 长期饿死。

`automation_pending` 用于列出仍在等待审批的提案（仅有界元数据，不含 prompt、principal 或主机路径），避免对同一变更重复提案。

## owner-anchored 占位 schedule 的激活门

Growth 的 owner-anchored workflow 证据桥（见 `assistant-growth-driver` 的 `workflowOwnerAnchored` 开关）沉淀的 paused automation 冻结了一条**永不触发的占位 cron**（`0 0 29 2 *`，UTC，2 月 29 日）。它不是新的 schedule kind，只是一条普通合法 cron；其意义由 store 层一道 fail-closed 门赋予：system owner 为 Growth（`assistant-growth-experiments`）且 schedule 与该冻结值逐字段相等的行，**不能经任何路径转 active**——

- owner 批准一条 `resume` 提案时，`changeApproved` 抛 `invalid-state`，提案结算降级为 `conflicted`（不重新询问 owner），automation 行保持 paused、版本不变；
- 系统侧 `reconcileSystemOwned({ desiredStatus: 'active' })` 直接拒绝（因此 Growth 即使在非默认的 full promotionMode 下也无法自行 promote 占位 artifact）。

解锁方式只有一个：owner 通过既有 system reconcile（upsert，definition hash 变化即原地替换 schedule）或删除后重建，显式给它一条真实 schedule；相等不再成立后激活门自然放行。owner 自有的 `system_owner = NULL` 行、以及其他 system owner 使用完全相同 cron 的行不受此门限制——owner 自主权优先，门只约束 Growth 自己的工件。paused 行本身也永远不会被调度（materialize 只取 active 行）。

## Proactive 的可选草稿运行

`assistant-proactive` 的 `mode: prepare` 只有 profile 显式提供 `preparation { provider, model, budgetId, maxOutputTokens, timeoutMs }` 时，才经由本插件执行一次真实模型草稿；省略该对象仍是 Proactive 的 metadata-only 记录。该运行不创建 AutomationStore 的 definition、occurrence 或可投递 run，而是为这条准备记录创建独立 Session。它固定 `allowedTools: []`、`maxToolCalls: 0`、`retrySafety: never` 和零重试；原 Goals 目标仍为 `paused`。输出由 Proactive 标为 `unverified-draft`，不代表业务文件被修改、目标执行或独立验收。

这类请求只允许当前、未过期的 Goals 等待和 owner route，并持续重查 `background:assistant-proactive/v1` 对 goal 的 `prepare` Policy 授权。其 Policy **授权主体**是 `assistant-proactive/v1`，而 `automation-runs` 预算的固定 **预算主体**是 `assistant-proactive-v1-preparation`；两者不可用决策 ID、goal ID 或输入文本替换。预算按单次模型运行预留并结算 `budgetAmount: 1`，不是累计 token 或金额预算；`maxOutputTokens` 和 `timeoutMs` 分别只是这一模型 turn 的输出和时长上限。重启时未确认的准备 `running` 记录由 Proactive 标为 `unknown`，不自动重试。撤权、owner route 变化、静默截止（quiet deadline） 或目标 deadline、以及主人拒绝都会阻断尚未完成的请求；已经产生的 draft 保留给状态读取，不会被反馈删除。

## 权限与数据

- 文件系统：只读写显式 `databasePath`、SQLite WAL/SHM 和 `runsPath`；目录 `0700`，数据库/artifact `0600`。automation 的 workspace 只作为 DSH session 身份，本插件不自行扫描工作区。
- 网络：插件不直接发网络请求；Agent automation 会通过宿主 DSH LLM provider 调用已批准的模型，Host automation 则调用已注册插件执行器。执行器和白名单工具各自声明的网络权限仍独立生效。
- Proactive 草稿：显式开启的准备会把目标文本发送给其配置的宿主模型 provider，并保存独立 Session ID、有限 usage 和未验收草稿；它不获取工具、文件、浏览器或消息发送权限。该模型网络依赖和上述持久数据仅在 `assistant-proactive` 显式开启 `preparation` 后存在。
- 消息投递：`assistant-delivery` 是可选 peer；只有 automation 固定了 `deliveryBindingId` 且后台 send 策略允许时才会 enqueue。该服务不存在时，run 保持 `deliveryStatus: pending`，完整结果仍可从本地 artifact 获取。
- 子进程、凭据、浏览器、安装脚本：macOS 的只读 operator inventory 会用固定系统 `/usr/bin/perl` 子进程，对显式继承的数据库/WAL/SHM 文件描述符查询 POSIX 写锁，并通过固定的私有目录描述符清理快照副本；不向它传数据库路径或凭据，环境仅含固定的 PATH/locale 与描述符数量。其余插件运行不自行启动子进程。白名单工具的独立权限仍然生效，assistant-policy 只能进一步拒绝，不能替代 OS/container 隔离。
- macOS operator inventory 拒绝读取本进程已经打开的同一数据库或 WAL/SHM inode，避免关闭临时描述符时释放该进程持有的 SQLite POSIX 锁；系统 Perl 辅助进程缺失或锁查询无法判定时按数据库忙碌拒绝。
- `inspectAutomationRetirementSnapshot(databasePath)` 是显式授权的本地升级证明入口，读取真实 v15/v16 而不迁移；普通 `inspectAutomationsOperatorSnapshot` 继续只接受 v16 且不返回定义正文。新证明返回完整规范定义、原创建 key 的摘要、非生命周期原列的 `immutableDigest`、所有绑定的退休回执、每张历史表的行数/摘要和全部原始 schema SQL/摘要。历史行以 SQLite 类型、列名及完整原值字节哈希，流式读取后仅排序固定长度行摘要，支持大整数、BLOB 与 WITHOUT ROWID；不返回 task/run/message 正文。`snapshotDigest` 绑定全部语义证明及主库/WAL `storageDigest`，文件身份另列。调用方必须从可信 before 逐项比较原 schema SQL、定义 immutableDigest 和全部 historyTables，并只允许经授权的精确 v16 表/触发器及生命周期/退休回执变化；摘要本身不代表迁移获准。永久标记在定义物理删除后仍完整保留并严格校验自身字段；现存定义必须保持同 owner/hash 的精确退休暂停态，或由正式 delete 回执证明的 deleted 后继（仅再增一个版本，更新时间及完整结果与原子 change 回执一致）。接口拒绝未知表/列/索引/视图、缺失或被改写的退休表/触发器、非规范定义与不一致回执，沿用严格 inventory 的私有路径、固定 inode、写锁、WAL 副本、journal 和源漂移保护，不创建源文件、改权限、checkpoint 或打开可写 SQLite 连接。定义含 prompt/权限，此证明只应交给可信安装器，不能作为普通状态或模型输出。
- `listActiveAutomationsForReadiness(databasePath)` 仅通过 SQLite 只读事务读取 active 注册及其完整定义，允许现存同 inode WAL 在读取时增长；不执行全库校验、复制或字节哈希。它要求私有 owner 路径、主库及现存 WAL/SHM 的安全 inode 和权限，拒绝不完整 sidecar、替换、错误 schema/定义与忙碌或损坏的数据库。SQLite 在 WAL 模式下必须使用现存 SHM 协调读锁，读操作可能更新 SHM 内容；因此此入口不提供源文件全字节不变保证，也不能替代严格 operator snapshot。没有 sidecar 的 WAL 库会拒绝读取，以免只读连接创建 SHM。
- 模型成本：每个 occurrence 可产生一个或多个 LLM step。默认要求 immutable `budgetId`/`budgetAmount`，并在 Agent 创建前预留 Policy budget；只有显式设置 `allowUnbudgetedExecution: true` 才能绕过。runner 会通过 Policy 的只读配置接口证明该 budget 的 metric 精确为 `automation-runs`，其他单位在 reserve 和 Agent 创建前 fail closed。reservation 幂等键同时绑定 automation、occurrence、definition hash、metric 和 budget；唯一允许读取 finalized receipt 的 Recovery 恢复路径不会再次结算预算，executor 自身以同一 operation key 返回已有 terminal result。
- 每次执行使用可信配置的固定 per-run cost，并始终按完整 `budgetAmount` finalize（通常设为 `1`，budget limit 表示周期内允许的运行次数）；provider usage 只保留为执行证据/审计，不参与退款或换算。因此 input/cache/reasoning 的不可知上界和沉默 CLI/ACP route 都不会突破执行前已预留的硬上限。只有能确定 Agent 尚未提交时才 release。
- 保留与备份：删除 run artifacts 不改变账本，但会失去完整输出；备份时一致性复制 SQLite（含 WAL）和 runs 目录。prompt、输出与 usage 可能含私人信息。

## 范围边界

P0 是单机 scheduler，不支持共享网络文件系统、多主共识、DAG、任意 shell sensor、heartbeat、webhook/file watch、自己实现消息 transport、浏览器或 ingest。官方 DSH session-local schedule 也没有被复制为第二套 daemon；timer 只唤醒本协调器。

## 兼容性

已针对 DeepSeek Harness `0.1.2-rc.1` 验证。详见仓库[兼容性基线](../../docs/compatibility.md)。

Growth 的 canary 检查只接受 Evaluation 按 exact run 返回的 ready canonical learning projection：必须是 upsert，可信执行成功且目标 achieved。原始 append-only 成功不构成 promotion 证明。schema v11 保存 canonical revision、digest、scope watermark 与完整 scope/run 证明；promotion 重新读取当前证明，并在当前 scope watermark 的 Evaluation writer fence 内提交激活。canary 证据冲突、撤回、scope 不匹配或未完成投影都拒绝激活；同 scope 的无关 canonical 进展会刷新 fence watermark，不会改变已检查 canary 的身份。旧版保存的成功证明不会自动升级为新授权，须重新进行实验；已完成的 promotion 操作仍可幂等重放。Evaluation 未提供 exact canonical lookup 时检查保持 pending。

Promoted Growth automations retain their exact canary run identity. Owner correction or withdrawal rechecks canonical eligibility immediately, on restart, and before every coordinator dispatch tick (including timer/internal ticks). Unknown, conflicting, partial or failed canonical objectives pause the exact deployed definition by version/digest CAS and retain a durable rollback receipt; unrelated definitions remain untouched. A newer positive owner judgement does not revoke an already successful deployment. Activation with a lost acknowledgement is recovered from the exact active version before rollback. Failed rollback remains retryable and prevents dispatch of a still-unsafe exact deployment.

准备运行使用 Host-only `modelOnly` 投影：仅允许空工具契约，解析预设身份但不装载该预设的工具与 persona；原生 Agent loop、选定 provider/model、Policy 和会话持久化照常使用。每份准备最多分派一次模型请求；失败保存稳定诊断，不保存异常原文，也不自动重试。

## Host occurrence 的有界原生 Agent

Host executor 可调用 `service.runAgentForHostExecution(invocation, contract)`。`invocation` 必须是正在执行的真实 HostRunner 交给注册 executor 的同一个冻结对象：生产模式、首次 attempt、`retrySafety: never`、`maxRetries: 0`，并且本次已获得新的 `automation-runs` 预算预留。即使普通 Host 部署允许无预算执行，该接口仍拒绝无预算、preview、恢复重放、结构复制、跨服务对象、已结束或取消的调用。契约验证通过后能力消费一次，之后不能更换契约再运行。

契约包含 `provider`、`model`、可选 `reasoningEffort`、`prompt`、`allowedTools`、`toolSchemaDigest`、`maxModelCalls`、`maxToolCalls`、`maxOutputTokens`、`timeoutMs`。effort 缺省表示已经观察到的无 effort；适配器默认后来出现 effort 也会拒绝，不会自动改供应者。工具摘要使用导出的 `hostAgentToolSchemaDigest(schemas)`：按工具名 codepoint 排序，对完整 schema 使用 `acceptanceDigest`。名称必须唯一；实际工具集合须完全一致，不能新增未知工具或同名替换 schema。调用者不提供 preset 或 setup 回调；workspace、preset 元数据及 Session ID 来自真实 occurrence，运行时不挂载 preset。

Automations 与普通 DshRunner 共享原生 Agent 执行代码及 DSH Loop。新路径在实际准备完成的请求处检查供应者、effort（包括无值）、精确工具 schema 和输出 token 配置；每次工具执行前再检查当前 schema 和取消信号。模型调用最多 100 次、工具最多 1000 次、每次请求最多 131072 个输出 token、最长 1 小时且不超过 occurrence 原期限；调用者通常应设更小值。请求强制输出 token 上限，并拒绝适配器报告的超额输出；额外以每输出 token 32 字节限制文本、推理与工具参数增量的缓冲量，这不是本地 tokenization 证明。契约的 canonical JSON 总量以及包含完整 output、usage、diagnostic 的返回收据各自还有 1 MiB 上限；契约超限在消费能力和创建定时器前拒绝，返回收据超限保守进入 unknown，不能把缓冲字节预算当作最终收据容量。Session 的 `plugin:assistant-automations/host-agent-contract` 记录冻结契约和摘要，权威 run 记录关联实际 Session 与使用量。

Agent 生命周期由 Automations 持有。注册卸载、调用取消、executor 提前返回或服务停止会先撤销调用能力并中止 Agent，再共享同一次最多 2 秒的回收确认（API、registry 和服务停止不会重新开始计时）；迟到的创建/结果不能成为成功。不能确认回收时保留 unknown、可能副作用和禁止重试，不声明业务任务成功。HostRunner 仍是唯一预算结算者，内部原生执行不再预留第二份预算；结算结果不明确时不重复 finalize。该 API 只证明本次 Host occurrence 具有有界执行能力，不证明其输入继承某个原始用户任务的供应者或动作授权，消费者必须独立核对来源与 owner 授权。它不注册模型工具，也不新增网络、文件或命令权限；实际工具原有的 Policy、凭据与隔离边界继续生效。

撤权、卸载或回收不明时，内部收据仍保留实际 Session 已记录的模型使用量与已发生工具调用，并带 `usage.observedPartial: true`。这是观察到的下界，不是完整账单；不读取调用方异常里的 usage/session，也不接受迟到结果改写已结算 run。Evaluation 的固定指标协议无法标记部分成本，因此省略这类 run 的 token/tool 指标，原始 run 收据保留数字与标识；外层真实 latency/retries 仍可投影。

### 非持久同步授权围栏与 external-only 调度

`hostAgentAuthorizationVersion()` 返回 `1` 表示支持 `runAgentForHostExecution(invocation, contract, authorization?)` 的第三参数。需要当前 owner/source 授权的消费者必须先核对此版本，再提供 `{ signal, assertCurrent }`：信号和同步函数必须为自有数据字段，不接受 getter 或 async 函数。`assertCurrent` 必须同步返回 `undefined`；返回 Promise/thenable 拒绝，普通未篡改内建 Promise 的拒绝尽力吸收，任意 thenable 的回调不执行；不支持自定义 Promise 子类、constructor 或 `@@species`。围栏在该 invocation 消费之后执行，不能重入启动第二个 Agent，也不能安装工具、更换 supplier 或获得 setup 权限。

围栏的信号与原 occurrence、注册生命周期及期限信号合并。在异步 Agent 创建完成后的首次 prompt、每次本 Agent 的实际模型派发、工具 guard 与最终结果接受前重新检查；stream 每个 chunk 只保留取消/期限检查，不逐 chunk 查询消费者数据库。回调抛错或返回异步值会撤销并中止本次调用，之后的模型/工具请求拒绝；已经派发的请求仍计费，未知结果不重试。无第三参数时保留旧 Host API 行为。围栏不证明跨数据库原子性；工具 execute 仍须在自身审批等待后独立重核授权。

Host definition 可以选择精确的 `schedule: { kind: 'external' }`。它没有日历 next/previous/due 时间，create/reconcile/resume/restart 都不产生 `nextRunAt`，只能由现有认证 `ingestExternal` 创建事件 occurrence。普通 Agent definition 和模型创建/更新入口拒绝此调度；manual/run-now、system dry-run 及日历/canary occurrence 拒绝，不消耗运行预算。暂停后的重启保持暂停，不自动恢复执行权限；显式授权 resume 仍没有日历任务。该扩展不迁移数据库、不新增 timer，也不改变既有 at/every/cron 的序列化语义。

实际消费这一原生 Agent 能力时，协调器在任何异步等待前单调记录“业务目标未经独立验证”。即使 Host executor 随后正常返回 succeeded，Evaluation 的 `objectiveStatus` 仍为 unknown；超时抢先结束或缺少最终原生回执也不会丢失该减权标记。未使用 Agent 的确定性 Host runbook 保留既有固定目标语义。它不改写历史 outbox，也不能用工具退出码或模型终态报告把 unknown 提升为 achieved。

Host Agent 的 Policy initiator 同时绑定 occurrence 已冻结的 `principal`，供工具规则核对实际 owner。`inspectSystemOwned` 的生产与预览 run 投影分别返回 `occurrenceId`；续办消费者须将它与原报告对应的 claim 核对，再检查持久 run 状态、不可变执行上下文和预算结算。仅有 waiting 报告不足以证明上一次执行已经安全结束；旧 Host 缺少该字段时不能据此自动续办。
