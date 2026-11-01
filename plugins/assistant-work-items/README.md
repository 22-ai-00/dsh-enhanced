# @dsh-enhanced/assistant-work-items

把外部信号沉淀为**有界、可恢复、可审计**的工作项账本，并用一次原生 automation occurrence 驱动 agent 认领、汇报和 owner 通知。本插件不创建第二套 agent loop、timer、outbox、预算系统、设置面板或 session store：调度复用 `assistant-automations` 的稳定 occurrence，执行复用原生 DSH Agent run，通知复用 `assistant-delivery.enqueueBackground()`，授权复用 `assistant-policy` 的默认拒绝。

账本提供认领与汇报工具 `work_item_claim`、`work_item_report`，状态查询 `work_item_status`，以及只读报告召回 `work_item_read_report`。在账本之上有一个默认关闭的**自动准入**切片：它从已认证的 in-tree 只读来源拉取真实信号并以相同闸门入账，因此普通使用（owner 自己发起的请求失败后，worker 被下一次 claim 唤醒）就会产生自驱工作项，无需 operator 手工调用 `admit(...)`，也无需新定时器。

终态报告只记录 worker 自己的结论；账本另有一条 append-only 的**结果结算**（outcome settlement）修订链，用 `assistant-delivery` 已认证的 execution 记录独立验证 `ready` 是否真的对应成功执行，并在证据窗内保持 `pending`、到期保持 `unverified`，绝不把 `ready` 当作目标达成。GitHub、邮件、IM、任务日历等**仓库外**来源属于独立插件的职责：它们实现一个只读 `WorkItemSignalSource`，用 `registerSignalSource(...)` 注册进来，就走与本内置来源完全相同的扫描、provenance、去重、冷却与已结项围栏，而不是另开写路径。

## 安装与启用

本插件要求宿主已提供 `ctx.assistantPolicy`（patch 中 `inject: [assistantPolicy]`），运行中的 profile 还需有 agent loop、LLM、session 和 tools 服务。要让 queued 工作项真正被执行，还需要 `@dsh-enhanced/assistant-automations`；要让终态报告送达 owner，还需要 `@dsh-enhanced/assistant-delivery` 和已配置的 owner route。

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/assistant-automations
dsh plugin --profile web add @dsh-enhanced/assistant-delivery
dsh plugin --profile web add @dsh-enhanced/assistant-work-items
dsh --profile web --dump-config
```

Patch 默认 `enabled: false`、`mode: observe`，安装后不创建目录、不打开数据库、不调用模型、不发消息。启用 active 模式必须同时显式给出 `workerAutomationId`、`scope`（完整 owner 五元组）和至少一个 `admission.allowedKinds`，否则配置校验失败关闭。

### 一次性准备 worker automation

在同一个 profile 里，先由可信 owner 前台 Agent 创建一条普通 Agent automation（`automation_create` 只提交 ID、名称、prompt、schedule 和 `allowed_tools`，workspace/preset/owner 从当前 Agent 派生），例如：

```yaml
# 在 owner 前台会话里调用 automation_create
id: work-item-worker
name: Work item worker
schedule: { kind: cron, expression: '*/15 * * * *' }
prompt: |-
  调用 work_item_claim。若没有工作项，直接结束，不要输出内容。
  否则按工作项的 brief 和 acceptanceRef 完成工作，用 work_item_report
  汇报 progress/ready/blocked/failed，并在结束前给出终态报告。
  resume 摘要不足时，用 work_item_read_report 按 revision 读取报告，沿
  nextOffset 继续正文，沿 previousRevision 找回更早报告。
allowed_tools: [work_item_claim, work_item_report, work_item_status, work_item_read_report]
budgetId: <owner 批准的 automation-runs 预算>
budgetAmount: 1
```

要求：

- automation id 必须与配置里的 `workerAutomationId` 完全一致；
- automation 的 workspace 和 preset 必须与 `scope.workspace` / `scope.preset` 完全一致；
- worker preset 的最终工具平面必须包含 `work_item_*`（若 preset 自带 scoped tool 列表，需要把这些工具纳入）；
- 每次 occurrence 都会创建新的原生 Agent；工作项身份来自 `assistant-automations` 注入的**冻结 production 执行上下文**，前台会话、preview 运行和其他 automation 一律失败关闭。

然后开启本插件：

```yaml
- id: dsh-enhanced-assistant-work-items
  name: '@dsh-enhanced/assistant-work-items'
  config:
    enabled: true
    mode: active
    databasePath: !!js dshHomePath('assistant-work-items/state.sqlite')
    workRoot: !!js dshHomePath('assistant-work-items/work')
    intakeSourceId: work-items/v1
    workerAutomationId: work-item-worker
    scope:
      workspace: /absolute/workspace
      preset: primary
      principalId: <owner principal id>
      ownerRouteId: <assistant-delivery owner route id>
      expiresAt: 1893456000000   # epoch ms，必须晚于当前时间
    admission:
      allowedKinds: [review, triage, foreground-repair]
    sources:
      foregroundFailures:
        enabled: true
        kind: foreground-repair
        includeTimedOut: true
        maxCandidatesPerSweep: 10
        maxAdmitsPerSweep: 2
        sweepIntervalMs: 3600000
```

`sources.foregroundFailures.enabled: true` 时，`claim()` 会先做一次被间隔门控的来源扫描；因此 worker 每次被唤醒时都会顺带消费新出现的 owner 失败请求。也可以由可信 Host 显式调用 `sweepSignals(force)` 立即扫描一次。

### 注册自己的来源（外部信号插件）

Host 或同 profile 的其他插件可以把自己的只读来源接进同一套自动准入：

```ts
const dispose = ctx.assistantWorkItems.registerSignalSource({
  // 只读契约（由来源实现遵守）：sweep 只读外部系统，不写 delivery/automations
  source: {
    id: 'github-review-requests',            // 稳定 lower-kebab-case，同时是 provenance.source
    sourceVersion: 'github-review-requests/v1',
    sweep({ now, limit, cursor }) {
      // 用 cursor 做有界分页；degraded 表示本次跑不了（例如缺少凭据），不是异常
      return { candidates, cursor: nextCursor }
    },
  },
  // 可选：不填时沿用 sources.foregroundFailures 的间隔/预算默认值
  intervalMs: 900_000,
  maxCandidatesPerSweep: 20,
  maxAdmitsPerSweep: 3,
})
// 插件卸载 / 配置切换时撤销注册（幂等）
ctx.effect(() => () => dispose())
```

约束：

- 每个候选必须自带 `provenance`（source、sourceVersion、signalDigest、observedAt、可选 evidence）、`externalId`、`originBindingId` 和 `disposition`；admission 会逐字段严格校验，缺失或超长直接拒绝而不是猜。
- `disposition: 'withdrawn'` 永远不会产生新工作项。若同一 canonical execution 已有在途工作项（`queued/claimed/working/waiting`），撤回会把该 dedup key 下**所有**在途行退役为 `dropped`（`stateReason: 'signal-withdrawn'`），包括去重窗口滚动前遗留的旧行；已结项的同一信号仍由跨窗口围栏挡住，来源不能复活它。每次扫描报告新增 `retired`，只统计本次真正被退役的工作项（可能一次多条）；`withdrawn` 仍只统计观察到的撤回候选。
- 撤回的边界：退役会释放活动 claim、把仍处于 `pending` 的 dispatch 行标为 `failed`（`reason: 'signal-withdrawn'`，不再重新武装唤醒），但**不能召回**已经交给 `assistant-delivery` 的报告/通知；随后 `claim`/`report` 会以 `claim-conflict` 失败（claim 已释放；若 owner route 恰好变化也可能先报 `owner-route-*`），status 工具会显示 `dropped`。撤回只读取规范化的 `externalId` 与来源归属，不重跑 owner route、Policy、cooldown、kind/rate/capacity 闸门，因为它只会减少待办工作；provenance 的来源与本次扫描来源不一致的候选会被直接拒绝。来源归属只保证「来源为自己发信号」：dedup identity 仍是 `intakeSourceId + kind + externalId`，扩展来源必须给 `externalId` 加自己的前缀，否则两个来源可能碰撞到同一工作项。
- 注册在插件 disabled 或已 dispose 时失败关闭（`disabled` / `storage`），不会先排队再补扫；同一 id 重复注册或格式非法抛 `invalid-input`，且不影响已注册来源。
- 来源仍然只依赖冻结的 owner route（`assistant-delivery` 的 `validateOwnerRoute`）；注册不绕过 Policy `admit` 授权。
- 没有新定时器：来源只在 `claim()` 或显式 `sweepSignals(force)` 时被扫一次，受各自的持久化 `intervalMs` 门控。
- 内置适配器的 id 是 `owner-foreground-failures`；用同一 id 注册表示**替换**内置适配器（不会双重扫描），该来源沿用内置适配器已有的 `signal.cursor:owner-foreground-failures` / `signal.sweptAt:owner-foreground-failures` 键，因此首次扫描可能被判为 `not-due`。

### Policy 最小规则

默认无规则即全部拒绝。需要三条彼此独立的授权：

```yaml
rules:
  # ① 允许本插件把外部信号提升为 active 工作项并唤醒 worker occurrence
  - id: allow-work-item-admission
    effect: allow
    subject: { kind: background, id: work-items/v1, workspace: /absolute/workspace, principal: <principal id> }
    actions: [admit]
    resource: { kind: automation, id: work-item-worker }

  # ② 允许 worker Agent 调用本插件的 CAS 工具（tool guard 默认拒绝）。
  #    subject.id 是 worker 会话的 Agent preset id（即 definition.agentPreset /
  #    scope.preset），不是 automation id，也不是 "primary"：assistant-policy 在
  #    authorizeToolExecution 里用 session.header.agentPreset 作 subject.id。
  - id: allow-work-item-tools
    effect: allow
    subject: { kind: agent, id: <worker preset id>, workspace: /absolute/workspace }
    actions: [execute]
    resource: { kind: tool, id: "work_item_*" }
    context: { initiators: [background] }

  # ③ 允许本插件经 Delivery 向固定 owner route 发通知。
  #    resource.id 是 assistant-delivery 的 conversation binding id（通知真正
  #    投递所绑定的会话），不是 ownerRouteId：Delivery 的
  #    enqueueBackgroundAuthorized 以 binding.id 作 resource.id 再次授权。
  - id: allow-work-item-owner-notify
    effect: allow
    subject: { kind: background, id: work-items/v1, workspace: /absolute/workspace, principal: <principal id> }
    actions: [send]
    resource: { kind: message, id: <conversation binding id> }
```

worker preset 需要与 definition 的 `agentPreset` 一致；`subject.id` 写成 automation id、`primary` 或 route id 都会被判 `default-deny`（默认拒绝，不会报“配置错误”），这是最容易踩空的一处。同理 ③ 写成 `route:<ownerRouteId>` 会因为 binding 查不到而抛 `missing-binding`。

注意：当前 `assistant-policy` 的资源类型词汇表没有 work-item/ticket kind，因此准入授权复用 `resource: { kind: automation, id: <workerAutomationId> }`。这是契约层面的错配，不是可配选项；后续若 Policy 增加专用 kind，应同步调整实现与规则。

## 工具

四条工具都要求调用者是配置中的 worker automation 的 exact production occurrence；工具调用落到前台会话或非 production 运行会被拒绝。调用方 Agent 的 workspace 与 preset 还必须与 `scope` 一致；claim 与 read_report 会复核 `scope.expiresAt`，过期即失败关闭。

- `work_item_claim`：按 occurrence 找到唯一绑定的工作项，用 CAS 取得 claim，返回 `itemId`、kind、title、brief、`workDir`、attempt 等。claim 没有独立续租动作：`progress` 报告会顺延租约；同一 run 的重复认领只在租约仍有效时幂等重放，租约过期则生成新的 claim 行与新的 attempt（受 `maxAttempts` 约束）。
- `work_item_report`：在活动 claim 下追加一条 append-only 报告修订（`progress` / `waiting` / `ready` / `blocked` / `failed`），可带 artifact 绝对路径；idempotency key 由 `status+summary+artifacts` 的 SHA-256 再按 item 与 claim 行限定，同一 claim 的重试返回已存修订而不重复写入，不同 claim 的同样文本则视为新修订。对已过期 claim 的报告会以 `claim-expired` 失败关闭。`waiting` 报告释放 claim 并按 `limits.waitingResumeMs` 安排一次**有界**恢复（受 `maxAttempts` 约束，见“生命周期与可靠性”）。终态报告会触发一次 owner 通知，通知失败只记录在报告行上，不删除报告证据。
- `work_item_status`：查询当前 occurrence 绑定的工作项、活动 claim 和报告列表；沿用既有租约恢复，不回显数据库路径、principal 或 Host 内部路径。
- `work_item_read_report`：只读召回当前 occurrence 所属工作项的指定报告正文与 artifact 引用，支持 UTF-8 字节分页及相邻 revision 导航；不接受 item ID 或任意文件路径。

`work_item_report` 的 `summary` 有字节上限（默认 16 KiB），超长会被截断并标记 `truncated`；artifact 路径必须是绝对路径，且位于该工作项的 scratch 目录或 `scope.workspace` 之内，相对路径与 `..` 逃逸一律拒绝。校验会逐级 realpath 每个已存在的路径组件，任何逃出根目录的符号链接都会失败关闭；scratch 目录仍应由部署者保持私有。

### 断点续办简报（resume）

`work_item_claim` 的返回值里带一个**只读、有界**的 `resume` 对象，让新 occurrence 在没有上一次模型记忆的情况下继续：`resumed` / `priorAttempts`、最近 5 次**先前** attempt（attempt 号、可得的 run id、开始时间、结束方式 `expired` / `reclaimed` / `attempt-exhausted` / `reported` / `settled`、以及终态报告的状态）、最近 5 条先前报告（revision、status、summary、`summaryTruncated`、记录时间；按时间从旧到新排列）与真实的 `reportsTotal`、最近一条已结算结果（revision、`settledBy`、execution/objective/evidence 状态、结算时间），以及 `truncated` 表示上游历史是否被上述上限截断。

- 简报只从本插件的 append-only 本地账本派生：`work_item_event` 与 `work_item_report` 按 `(item_id, …)` 主键前缀做有界扫描（`LIMIT`），不引入新表、不改变 schema 版本（仍为 7）、不新增 timer，也不调用模型或 peer。
- 报告 summary 在简报里最多保留 512 UTF-8 字节，超长按 UTF-8 边界截断并置 `summaryTruncated`；当前 attempt 自身不计入 `attempts`/`priorAttempts`。
- 简报是派生展示，不改变 claim/report/结算语义；它不含数据库路径、delivery id 或 evidence blob。首次认领与旧账本行可能得到空简报（`resumed: false`），重放同一 claim 会重新计算并返回一致的简报，不会追加新的 claim/attempt/事件。

### 摘要后的报告召回

`work_item_claim` 现在也会把非空 `acceptanceRef` 和非空 `leaseUntil` 投影给模型；缺失值省略。`resume.reports[].revision` 是稳定的报告引用，摘要超过 512 字节或较早报告被最近 5 条上限排除时，可调用：

```yaml
work_item_read_report:
  revision: 3
  offset: 0
  max_bytes: 4096
```

- `revision` 为必填正安全整数；`offset` 是已存正文的 UTF-8 **字节**偏移，默认 `0`；`max_bytes` 默认 `4096`，取值 `4–8192`。返回正文总字节数 `summaryBytes`；还有后文时返回 `nextOffset`，原样传回即可续读；末页省略该字段。偏移超出正文或落在多字节字符中间会拒绝，不会跳字或产生半个字符。
- 返回实际存在的 `previousRevision` / `nextRevision`，首尾省略对应字段；因此可以从简报中的任一报告逐条找到早于最近 5 条的报告。`storedTruncated` 表示**原报告入库前**已被 `limits.maxReportBytes` 截断；召回只能恢复已存正文，不能恢复被丢弃的原输入。
- 读取只访问当前 occurrence 绑定的 item/report，重查 owner route 的 principal、版本及 binding 代次，并重跑原准入授权；缺依赖、撤权、owner/代次变化或到期均失败关闭。拒绝读取不 park 工作项，不触发恢复、结算或新增账本行；schema 仍为 7。
- `artifactPaths` 只是原报告登记的引用，不读取文件。正文及引用都按不可信数据渲染。`work_item_report` 显示通知已入队仅证明 Delivery 接受了 outbox 请求，不证明消息已发送、送达或已读；历史 `delivery: sent` 仍保留原枚举语义。
- 新 automation 的不可变工具白名单和 preset 工具平面都须包含 `work_item_read_report`；已存在的 automation 不会因插件升级自动取得该工具。

## 生命周期与可靠性

```
外部信号 --admit--> 私有 SQLite 工作项账本
  ├─ observe: 只写 observed/dropped 行，绝不唤醒、绝不通知
  └─ active:  queued + dispatch 行
        └─ automations.ingestExternal({ sourceId: intakeSourceId, automationId: workerAutomationId,
                                         eventId: 工作项 ID 或 工作项 ID#代次, occurredAt: dispatch 行 })
              └─ 原生 Agent occurrence
                    ├─ work_item_claim  (CAS，租约默认 15 分钟)
                    ├─ work_item_report (append-only，终态通知)
                    └─ delivery.enqueueBackground({ bindingId: 工作项创建时的 originBindingId })
```

- 状态机：`queued / claimed / working / waiting / ready / blocked / failed / dropped`。`ready`、`blocked`、`failed`、`dropped` 为终态；`queued`、`waiting` 可被认领。`ready` 表示 worker 汇报已完成，不代表目标已达成；独立结果证据见下节。
- 准入闸门顺序：enabled → 输入规范化 → owner route 校验（失败时零写入、零唤醒）→ 去重窗口重放 → **跨窗口已结项围栏**（`ready/blocked/failed/dropped` 的旧项不会被同一 canonical signal 复活）→ kind allowlist → cooldown → 每小时准入上限 → 未结工作项上限 → observe 记录或 active 入账 + dispatch 行。active 路径还会在写库前调用一次 `assistant-policy` 的 `admit` 授权。
- 自动准入（`sources`）：在 `claim()` 之前同步扫一遍已武装的来源，并按持久化的 `sweepIntervalMs` 做**运行间隔门控**（没有新 timer）。每个来源的游标 `signal.cursor:<source>` 和上次扫描时间 `signal.sweptAt:<source>` 都存在账本同一 SQLite 的 `work_item_schema_meta` 表中；adapter 抛错会把游标重置为空（下次从最旧信号重扫，去重保证重叠无害），并只记一条 warn，绝不让 claim 失败。每次扫描的准入数量由 `maxAdmitsPerSweep` 有界。
- 信号以**规范化 canonical key**（对持久身份做 SHA-256，不是原文）去重；工作项上通过 `admitted` 事件 detail 的 `provenance`（source、sourceVersion、signalDigest、observedAt、evidence）记录来源、来源版本与观察时间。provenance 复用事件 detail，因此 schema 版本不变。
- 已结项修复不会被同一信号再次唤醒：owner 的失败前台请求在 owner 重试前一直是 `failed`，语义上必须由跨窗口围栏挡住，否则每个去重窗口都会重开同一修复。
- 去重键 `sha256(sourceId\0kind\0externalId)` 加时间桶 UNIQUE；同一外部信号在 `dedupWindowMs` 内只入账一次，重放返回既有工作项。
- 唤醒身份按**代次**限定：`work_item_dispatch` 保存 `generation`、`event_id`、`occurred_at`，代次 0 就是准入事件（`event_id` = 工作项 ID、`occurred_at` = 准入时间）；每次重新武装都把 `generation + 1`、`event_id` 改写为确定性的 `工作项 ID#代次` 并写入新的 `occurred_at`。`wake()` 只使用 dispatch 行持久化的身份，绝不从工作项 ID 重新构造，因此重新武装一定对应 automation 侧的新 occurrence，而同一代次的重复唤醒仍解析到同一个 occurrence。
- 租约到期不靠 timer 回收：admit/claim/status/list/health 以及启动恢复时惰性调用 `reclaimExpired()`；到期 claim 被显式置为 `expired` 并记事件，工作项回到 `queued`，dispatch 行在同一事务里进入下一个代次并回到 `pending`，由后续普通 worker 流量中的有界 `wakePending()` 扫到（`occurred_at <= now` 才唤醒，绝不提前）；超过 `maxAttempts` 的项标记 `blocked`。
- `waiting` 报告会释放 claim 并**安排一次延迟恢复**：dispatch 行进入下一个代次、`reason = waiting-resume`、到期时间为报告时间 + `limits.waitingResumeMs`；只有 `attempt < maxAttempts`、未进入终态且未被观察时才安排，每次 waiting 报告最多一代，不会自旋。到期后由同一次惰性唤醒扫到，worker 以新 occurrence 重新认领并得到 `attempt + 1`。
- 崩溃恢复：`ingestExternal` 已成功但 dispatch 行仍未记账时，该行保持 `pending` 且身份不变，下一次有界恢复用**同一代次身份**重新唤醒，automation store 以相同 `(automationId, eventId, occurredAt)` 幂等返回既有 occurrence，绝不重复运行、绝不重复报告。
- 唤醒记账诚实：peer 抛出的错误若表示「不知道是否已经提交」（非 `policy-denied`/`policy`、非去重冲突），dispatch 行记为 `state='failed'`、`reason='unknown_after_send'`，`health().dispatchUnknown` 因此只统计仍然**开放且未被观察**的 item 上真实存在的这种行：item 一旦被撤回、终结或观察，就不再计入，也不会再被恢复扫描。这样的行在同一代次身份下最多被惰性恢复重试 **1 次**（`wake_attempts` 持久计数）；重试成功则转为 `dispatched`，再次失败则保持 `failed`/`unknown_after_send`，把无法消除的缺口留给 owner，而不是无限重试或假装成功。持久身份冲突（`idempotency-conflict`）是确定性错误，记为独立原因 `idempotency-conflict` 并抛 typed `WorkItemError`（`dispatch-failed`）；没有 occurrence 查询接口时无法自动收敛，因此不静默吞掉。
- SQLite 使用 `WAL`、`synchronous=FULL`、`BEGIN IMMEDIATE` 事务和 forward-only schema；`PRAGMA user_version` 只前进。升级写入边界要求单 writer：升级前停掉 DSH 进程。

### 准入授权的复核（依次 claim / wake 之前）

准入时的 `assistant-policy` allow 是**那一刻**的决定，不是永久的授权。工作项因此在真正派发之前会重新验证自己的“mandate”：同一个 `authorize(request, { idempotencyKey })` 请求在 claim 前和 wake 前各重跑一次，policy 仍是唯一权威。

- 准入把 allow 决定持久化为工作项上的 `authority_basis`（**仅供审计/复核，不授予任何新权限**）：协议 `work-items/authority/v1`、`action: admit`、background 主体（来源 ID、workspace、principal）、resource（automation id）、`effect: allow`、`reasonCode`、可选 `ruleId`、确定性的 idempotency key 与 `checkedAt`。复核时用这份**冻结**的 basis 重建请求，不从当前配置重算，因此覆盖不了 admission 之后被替换的配置。
- 复核结果只有两种：allow → 正常继续；deny / policy 抛错 / peer 缺失 / 决定畸形 → **fail closed**：把工作项停在 `waiting`（`stateReason` 为 `authority-revoked` 或 `authority-unavailable`，事件 detail 记 `reason` 与 `phase`），不 dispatch、不 claim、不标 `failed`，也绝不授予新 authority。`emergency-stop` 等 deny 原因原样上报。
- claim 阶段的拒绝会额外重新武装 dispatch（新一代次、`reason: 'authority-resume'`）：occurrence 已存在、单靠 park 会让工作项永远没有下一次唤醒。重新武装只产生一次普通唤醒机会，真正的派发仍要先过同一道复核，因此不构成新的授权。
- 之后 policy 重新 allow 时，同一工作项**原样恢复**（回到 `queued`，记 `authority-restored` 事件，不重新准入、不重置 attempt），下一次正常唤醒/认领即继续，这就是“在不变 mandate 下恢复”的原型。
- 不可读/畸形的已存 basis 视为 `revoked`（`malformed-basis`），绝不按 legacy 放行；`null` basis 只对应升级前的旧行（schema v7 之前），按既有 legacy 语义保持可认领。observe 模式、`following-thread` 等待和既有 `waiting-resume` 路径不受影响。
- 不带 basis 的内部构造（测试或旧行）按 legacy 处理；生产服务总是装配复核器。`health().authority` 暴露 `legacy`/`parked` 计数与最近一次拒绝的时间和原因，`stats()` 暴露 `authorityLegacy`/`authorityParked`；不暴露 basis 内容。

## 结果证据与结算（`ready` 只是报告）

- 终态与客观结果分离：`ready` 只表示 worker 自报完成（`trust: agent-self-report`）；`objectiveStatus` 目前只能从独立证据推导为 `unknown`，不会出现 `achieved`/`partial`。
- 每条终态报告在同一事务里追加一条 append-only 结果修订（`work_item_outcome`，主键 `item_id + revision`）：`report-ready`、`report-blocked`、`report-failed`、撤回 `cancelled/external-receipt`、重试耗尽 `retry-exhausted`。已结项的历史修订永不改写。
- 只有带可结算 provenance（source=`owner-foreground-failures`、`evidence.inboxId`、`evidence.completionSequence`）的准入才打开证据窗：`evidenceState: pending`，`deadlineAt = 报告时间 + settlement.windowMs`，基线取准入 `admitted` 事件 detail 里的 provenance。没有独立来源时直接 `not-applicable`（`no-independent-source`），不制造假的“待验证”。
- 结算不新增 timer：只在 `claim()` 或宿主显式 `settleOutcomes(force)` 时被动运行，受持久化键 `settlement.sweptAt` 门控；分页游标 `settlement.cursor` 仅在 peer 同时返回 `hasMore` 和非空 `nextCursor` 时保留，否则清除并从下一页顶部重新开始，避免把旧游标当成新证据。单次 pass 只读一页；`maxSourcesPerSweep` 是该页的**条数**（作为 `limit`），`maxPendingPerSweep` 是本 pass 检查的窗口数上限；待检查窗口按 `deadlineAt` 升序取前 N 个，超出部分顺延到后续 pass。`maxSettlementsPerSweep` 同时约束 observation 与 expiry 的追加总数。
- 证据匹配是严格相等而非“看起来像”：同一 `inboxId`、scope/principal/authorityHash 与准入时持久化的 owner route 一致（不是本次 pass 重算的值）、`source.protocol` 必须等于本插件约定的证据协议、`execution.status === 'succeeded'`、`quiescent === true`，且 `completionSequence > baselineSequence`。命中后追加 revision N+1：`observed-evidence`、`executionStatus: succeeded`、`trust: external-receipt`、`evidenceState: observed`；observation 只扩大信任面，`objectiveStatus` 仍是 `unknown`。
- 窗口到期仍无证据时追加 `window-expired`：保留原执行状态，`evidenceState: unverified`。channel 健康但安静记 `window-expired`；channel 不可用/路由撤销、或到期时本页读取抛错记 `channel-unavailable`（degraded）。两者都不会把结果写成成功；`channel-unavailable` 是终态，窗口关闭后不会因为之后 channel 恢复而重试成 observation。
- 证据只保留 allowlist 字段（`inboxId`、`completionSequence`、`completedAt`、`executionStatus`、`sourceDigest`、`bindingVersion`、`bindingGeneration`、`scope`），总长不超过 2048 字节，不读取 owner 原文。超限负载**整体丢弃**、绝不截断：报告 ready 路径记为 `not-applicable` / `evidenceReason: 'evidence-too-large'`，结算路径记为 `unverified` / `evidence-too-large`。
- host-only 接口：`settleOutcomes(force)`、`outcomes({ limit, evidenceState })`（没有对应的模型工具）；`status()` 增加 `outcome` 视图，`health().settlement` 与 `stats()` 暴露 pending/observed/unverified 计数。`settlement.enabled: false` 时报告 `skipped: 'disabled'` 且不扫描。
- 缺 `assistant-delivery`、缺 `listOwnerForegroundTaskSources` 或 owner route 撤销时只返回 `degraded`/`failed` 并 warn，不抛错、不写假结算，也不会让 `claim()` 失败。

### 跟随线程的提前收束（follows）

外部线程（ticket、PR 等）的关闭是**完成信号**，不是目标达成证据；它可以让一项进入终态报告后的等待提前结束，但不能替 owner 判断 objective 已实现。

- 准入时可选 `follows: WorkItemThreadRef[]`（`{ kind, ref }`，最多 8 条，按 `kind + ref` 去重；非法/超限/伪造来源整条准入失败），持久化到 `work_item_follow`（schema v6，`STRICT` + `WITHOUT ROWID`，主键 `item_id + position`，并有 open 状态查询索引）。信号源候选也可带 `follows`，原样进入准入。
- 只有 host 能注册解析器：`registerThreadSource({ source, generation, resolve(ref) })`。`resolve` **同步、只读、无 Promise**；每个 `source` 只能注册一次，重复/畸形注册 fail closed，返回的 disposer 撤销当前注册。注册的 `source` 必须与 follow 的 `kind` 同名：准入只把 `kind` 解析到对应注册，并把该注册的 `source`/`generation` 冻结在 follow 行上。
- 终态报告遇到仍 open 的 follow 时不追加 outcome，而是把 item 停在 `waiting`（`stateReason: 'following-thread'`，`last_report_status` 记下报告状态，claim 行收尾）——此时仍可被认领，且 `settleOutcomes` 报告 `deferred`。
- 结算 pass 在原有窗口检查之后、受同一 `maxSettlementsPerSweep` 预算约束地惰性解析 open follow：`open` 继续等待；`closed` 写回 `outcome`/`digest`/`closed_at`（CAS `state='open'`，重复或乱序的关闭只会命中一次）。当且仅当该 item 已无 open follow 时，恰好追加一条 `settledBy: 'closed-by-thread'`、`evidenceState: 'unverified'` 的修订；窗口到期仍是 `window-expired`。关闭**不会**设置 `objectiveStatus: achieved`，`observed` 仍只由交付 provenance 规则产生。结算候选同时要求 `waiting` 且没有 lease：被新 worker 重新 claim 的 item 不会被线程关闭在其运行期间收束。
- 无法解析时保持 `waiting` 并显式降级，绝不把缺失当成关闭：`source-missing`（注册已撤销/从未注册）、`generation-mismatch`（注册代际与准入时冻结的代际不一致）、`resolver-failed`（resolver 抛错、返回 undefined 或畸形 closure）。`health().follows` 暴露 `open`/`closed`/`unresolved` 计数与 `degraded` 原因（`source-missing` > `generation-mismatch` > 最近一次结算的降级），`stats().follows` 暴露总数；不暴露 ref 或 digest。open/unresolved 只统计仍活跃的 item，撤回或被其他路径结项的 item 留下的 follow 行不会造成永久降级。
- 没有 timer：只有 `claim()` 或宿主显式 `settleOutcomes(force)` 触发解析；无 follow 的 item 走原有窗口路径，行为不变。follow 不是新的 authority store，也不产生 objective-achievement 推断。
- 与 Evaluation 的衔接：`closed-by-thread` 修订按 unverified 结算投影（`executionStatus: 'unknown'`、`evaluator.version: 'unverified-v1'`、`objectiveStatus`/`deliveryStatus` 为 `unknown`、`trust: 'trusted'`），幂等键仍为 `work-items/<itemId>/<revision>/<evidenceState>`。协议 `assistant-work-items/evaluation/v1` 原生接受该原因，不做 `window-expired` 之类的别名替换。

### 可信 Evaluation 导出（第四个 trusted producer）

已结算的结果修订（`evidenceState != 'pending'`）会投影到 `@dsh-enhanced/assistant-evaluation` 的 trusted lane，作为该账本与交付/自动化的 latter 之外的**证据**，而不是目标判断：

- 每个结算修订最多投影一条 Evaluation 记录，幂等键为确定性的 `work-items/<itemId>/<revision>/<evidenceState>`；相同重放安全，内容变化由 Evaluation 以 `idempotency-conflict` 失败关闭。
- `evidenceState: observed` → `executionStatus: succeeded` 且 `evaluator.version: settlement-v1`；`unverified` / `not-applicable` → `executionStatus: unknown` 且 `unverified-v1`。投影的 `objectiveStatus` 与 `deliveryStatus` 在类型和运行时都只能是 `unknown`：work-item 结算永远不能把自身升级为目标达成证据，也不会因报告过 `ready` 而被 Evaluation 当作 achieved。
- 复用与 verifier 相同的私有 producer registration seam：`assistantEvaluation` 通过 `ctx` 发现本服务的 `trustedWorkItemProducerGeneration()` 与 `registerTrustedWorkItemEvaluationSink(registration)`，并校验 protocol（`assistant-work-items/evaluation/v1`）、generation、ownership 和单注册不变量；本插件不直接写 Evaluation 数据库。
- `assistant-evaluation` 是可选 peer：缺席时结算行保持 `pending`，不阻塞 claim/report；绑定后下一次 drain 会补导既有 pending 行。
- 有界且诚实降级：每 sweep 最多 10 条，失败最多重试 5 次后标记 `export-attempts-exhausted`；部署没有精确 workspace+preset scope 时标记 `skipped`（`owner-route-unavailable`）；observe 模式不导出。状态写入 `work_item_outcome.evaluation_*`（schema v5 引入，v6/v7 保持），`health().evaluation` 与 `stats()` 暴露 `evaluationPending/exported/skipped`。
- 依赖方向：本插件只以 **type-only import** 引用 `@dsh-enhanced/assistant-evaluation` 的 claims/registration 契约类型，并把该包声明为 optional peer + devDependency；Evaluation 保持 producer-agnostic，不依赖任何 producer 运行时。

#### 工作项执行指标（metrics）

投影的 `metrics` 不再只有 live 记录推算的 `latencyMs`/`retries`，而是同一账本里**可独立复算**的执行事实（`store.workItemExecutionMetrics(itemId, settledAt)`，只读、单条 SELECT、复用 prepared statement）：

- `latencyMs`（存在时总是非负）：`settledAt − item.createdAt`，即从准入到该结算修订的墙钟时间；时间戳非安全整数时箝位为 0。item 行缺失时 `workItemExecutionMetrics` 返回 `undefined`，drain 路径回退到 `metricsFor(undefined)`（即 `{}`，**没有** `latencyMs`）。
- `claims`/`retries`：`claims` 统计结算上界内的 `claimed` 事件数（每次成功 claim 在同一事务里恰好追加一条事件并原子递增 `attempt`，所以它就是 `settledAt` 时刻的尝试数，不会像可变的 `item.attempt` 那样吸收结算之后的重试；`work_item_event` 以 `(item_id, sequence)` 为主键，可按前缀索引搜索，避免扫全部历史 claim 行）；`retries = claims − 1`。`reports`/`waitingReports` 来自 `work_item_report`（按 `recorded_at`，其中 `waitingReports` 按 `status = 'waiting'`），`unknownDispatches`/`claimExpiries` 来自 `work_item_event` 的 `dispatch-unknown`/`claim-expired` 事件（按 `recorded_at`）。
- 所有计数都以 **`settledAt` 为上界**（`recorded_at/created_at <= settledAt`）：结算之后才落库的行属于后续观察，不会被已结算修订吸收；同一 item 的新修订重新计算即可看到它们。边界是 1 ms 粒度、含等号的（`<=`），因此同一毫秒内、结算之后才提交的行仍会被计入；这里刻意不用严格 `<`，否则会把合法的同毫秒行漏掉。
- 零/缺失计数直接省略（不写 `0`），值域是无符号安全整数；schema 仍是 v7，不新增表、不新增列。`workItemEvaluationClaims` 增加可选的第四个 `execution` 参数：drain 路径传入上面的只读计数包，直调三参数形式继续使用 live 记录回退，行为与旧版本一致（`{ latencyMs, retries? }`）。
- 刻意**不采集 provider token/成本指标**：本插件与 `assistant-automations` 之间没有 run-usage 契约，无法区分「本工作项消耗」与「同一 run 的其他开销」，复制过去的数字会把成本重复计入 Evaluation；需要成本归因时应由拥有 provider 账本的 producer 自己投影。执行指标只回答「做过多少事、等多久、重试几次」，不回答 objective 是否达成。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；关闭时不创建任何目录、文件或数据库 |
| `mode` | `observe` | `observe` 只记录观察行；`active` 才唤醒 worker、发通知 |
| `databasePath` | `$DSH_HOME/assistant-work-items/state.sqlite` | 私有账本绝对路径 |
| `workRoot` | `$DSH_HOME/assistant-work-items/work` | 每项 scratch/artifact 根目录绝对路径 |
| `intakeSourceId` | `work-items/v1` | 写入 automation 事件与 Policy background 主体标识 |
| `workerAutomationId` | 无 | 已存在的 worker automation id；active 模式必填 |
| `scope.workspace` / `scope.preset` / `scope.principalId` / `scope.ownerRouteId` | 无 | owner 五元组；active 模式必填，过期后 fail closed |
| `scope.expiresAt` | 无 | epoch 毫秒，必须晚于配置加载时间 |
| `admission.allowedKinds` | `[]` | 允许准入的 kind；active 模式至少一项 |
| `admission.maxOpenItems` | `8` | 未结工作项上限（1–100） |
| `admission.maxAdmitsPerHour` | `4` | 每小时准入上限（1–100） |
| `admission.dedupWindowMs` | `604800000` | 去重窗口（1 小时–30 天） |
| `admission.cooldownMs` | `600000` | 两次准入之间的最小间隔（0–1 天） |
| `admission.maxBriefBytes` | `8192` | brief UTF-8 上限（256 B–64 KiB） |
| `limits.leaseMs` | `900000` | claim 租约（30 秒–1 天） |
| `limits.maxAttempts` | `3` | 单工作项最大执行尝试（1–10） |
| `limits.maxReportsPerItem` | `20` | 每项最大报告修订（1–100） |
| `limits.maxReportBytes` | `16384` | 单条报告 summary UTF-8 上限（256 B–64 KiB） |
| `limits.waitingResumeMs` | `300000` | `waiting` 报告后延迟重新唤醒 worker 的时间（60 秒–1 小时） |
| `delivery.notifyOn` | `[ready, blocked, failed]` | 触发 owner 通知的终态报告状态 |
| `sources.foregroundFailures.enabled` | `false` | 是否武装内置的 owner foreground 失败来源；关闭时扫描是 no-op |
| `sources.foregroundFailures.kind` | `foreground-repair` | 该来源准入的工作项 kind；active 模式必须在 `admission.allowedKinds` 内 |
| `sources.foregroundFailures.includeTimedOut` | `true` | 是否把 `timed-out` 的 owner 请求也当作待修复信号 |
| `sources.foregroundFailures.maxCandidatesPerSweep` | `10` | 单次扫描最多读取的候选数（1–100） |
| `sources.foregroundFailures.maxAdmitsPerSweep` | `2` | 单次扫描最多准入数量（1–10） |
| `sources.foregroundFailures.sweepIntervalMs` | `3600000` | 两次自动扫描的最小间隔（60 秒–1 天，持久化门控） |
| `settlement.enabled` | `true` | 是否在终态报告后维护独立结果证据窗 |
| `settlement.windowMs` | `604800000` | 证据窗长度（1 小时–9 天） |
| `settlement.sweepIntervalMs` | `600000` | 两次结算扫描的最小间隔（60 秒–1 天，持久化门控，无新 timer） |
| `settlement.maxSourcesPerSweep` | `25` | 单次来源分页读取的页大小（每页条数，作为 `limit`，1–100） |
| `settlement.maxPendingPerSweep` | `10` | 单次最多检查的 pending 窗口；按 `deadlineAt` 升序，超出部分顺延到后续 pass（1–50） |
| `settlement.maxSettlementsPerSweep` | `10` | 单次最多追加的结算修订（1–50） |

所有可变部署值都经过同步 Schemastery 校验；未知字段、相对路径、文件系统根目录、`databasePath` 与 `workRoot` 重叠、过期 scope 都会失败关闭。

## 权限与数据

权限边界只有本地文件系统（显式 `databasePath` 与 `workRoot`）；跨插件调用只有只读的 `assistant-delivery` owner route/execution 查询，以及受 Policy 约束的 automation dispatch 与终态通知。

- 文件系统：只读写显式 `databasePath` 和 `workRoot`；目录 `0700`，数据库文件 `0600`，拒绝 leaf symlink。artifact 只能落在工作项自己的 scratch 目录内。
- 网络：插件自身不发网络请求。模型/工具调用发生在 `assistant-automations` 创建的原生 Agent run 内，其 provider 与工具权限由宿主和 Policy 决定。
- 子进程、凭据、浏览器：无。
- 安装脚本：包内没有 postinstall 或其他生命周期脚本；`prepublishOnly` 只要求用 pnpm 发布。
- 消息投递：只有 active 模式的终态报告才会经 `assistant-delivery` 入队；observe 模式从不调用 Delivery 的写接口。Delivery 会在入队和发送前重查 owner route、binding 版本/代次、有效期和 background `send` Policy。
- 跨插件只读：自动来源使用 `assistant-delivery` 的 `validateOwnerRoute` + `listOwnerForegroundTaskSources`（owner 认证、游标分页、host 公开、只读，不触发任何发送或写操作）。`assistant-delivery` 缺失或版本过旧（无该 API）时，来源退化为 no-op 或 `degraded: 'unsupported'`，插件激活与 claim 都不会抛错。
- 结果结算：只读取本地账本和 `assistant-delivery` 的只读 `listOwnerForegroundTaskSources`；不新增网络、子进程、凭据或写接口，结算失败/缺依赖时降级而不是重试外部写入。可选 `assistant-evaluation` 只通过进程内 registration 追加 trusted 证据，同样不发网络请求。
- 数据保留：账本保存外部 ID、标题、brief、owner 身份、报告正文和 artifact 路径，可能包含私人信息；备份时按 SQLite（含 WAL）一致性方式复制。删除 scratch 目录不影响账本，但会丢失完整 artifact。

## 限制

- 单独使用 observe 模式没有产品价值：它只积累观察行，不唤醒、不通知。observe 仍要求 `assistant-delivery` 可用，因为准入要先校验 owner route；没有 Delivery 时准入记录不会写入（失败关闭），这是当前实现的已知限制。
- 尚未**随包发布**仓库外真实来源（GitHub、邮件、IM、任务日历等）：插件提供了 `registerSignalSource(...)` 扩展点，但具体来源适配器仍待独立插件实现；内置来源只是 `assistant-delivery` 已认证的 owner foreground 记录，仍属于 in-tree 证据。
- 内置来源的 title/brief 由 delivery 行的**元数据**派生（inbox、binding、版本/代次、完成时间），不读取 owner 原文；因此 brief 不是完整任务复述，worker 只能依据 brief、provenance 和自身可用工具定位上下文。
- canonical key 以**单次 execution**（inbox + binding 版本/代次 + executionRef，不含 `disposition`）为单位，不是「同一意图第 N 次重复」；同一 execution 的状态修订（失败→撤回）共享同一身份，因此撤回能定位并退役已准入的项。owner 同一意图重试失败会产生新的工作项（cooldown 与 `maxOpenItems` 限制总量）。
- 已准入信号的 `disposition` 若被修正为成功（`succeeded`，即不再产生候选），不会自动关闭旧工作项；只有 `cancelled` 撤回会传播到在途项。撤回报告已经交给 delivery 的终态报告无法撤回，worker 只能从后续工具调用看到 `dropped`。observe 模式不会新建在途项，但若切换前遗留的在途项仍在，撤回仍会把它退役（内部账本变化，不唤醒、不通知）。
- 升级注意：本版本把 `disposition` 从 canonical key 移除。升级前已准入的旧工作项仍带旧 key，之后的撤回对它们会解析为 `absent`，只能等其自然结项；新信号不受影响。
- 观察期记录会占用去重窗口：同一 signal 从 observe 切到 active 后，窗口内仍视为已准入；需要时等待窗口过期或换 `externalId`。
- 工作项终态只是运维证据，不代表任务质量。`ready` 仅是 worker 自报，结果结算也只给出 `unknown/observed/unverified`；导出到 Evaluation 的是同一份证据，不证明修复质量，也不构成采用依据。
- `stats().openItems` 与 `health().openItems` 只统计 `queued/claimed/working/waiting`，不含仍需人处理的 `ready/blocked` 终态项。
- 精确定时仍属于 `assistant-automations`；本插件不自带 schedule、timer 或 retry daemon。

## 兼容性

以 DeepSeek Harness `0.1.2-rc.1` 的服务与工具契约验证。依赖 `node:sqlite`（Node.js 22+ 内置），不兼容 Node.js 20 及更早版本。
