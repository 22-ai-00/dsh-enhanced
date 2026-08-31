# @dsh-enhanced/preference-learning

面向个人助理的有界偏好学习。插件把可信 Host 产生的离散信号汇总为可审计假设，并且只允许证据充分的低风险 T1 偏好进入临时、可回滚的 Agent overlay。它不会从聊天正文自由推断规则，也不会把 tentative 偏好冒充用户确认事实。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/preference-learning
dsh --profile web --dump-config
```

插件需要 `assistant-policy` 与 DSH `system-prompt`。安装 `assistant-delivery` 时会自动订阅它验证过的日常使用 observation 与明确偏好 event；Delivery 是可选 producer，不构成本插件的启动依赖。Profile 必须为目标 Agent 明确授权：

- `review` / `activate` / `rollback` / `snapshot`，资源 `preference:*`；
- `execute`，资源 `tool:preference_*`。

未授权时默认拒绝，跨 workspace 或 Agent preset 的假设不可见。

固定的 `supervised-growth/v2` Host runbook 不需要构造 Agent，也不会从 session header 猜 scope。可信
Host 分别调用 `canonicalPreferenceHostScope({ workspace, preset })` 与
`hostReview` / `hostActivationCandidate` / `hostActivateOne` / `hostRollbackOne` / `hostMaintainOne`；这些入口都要求显式 authenticated owner
`principal + operationId`，并以固定 background Policy subject
`dsh-enhanced-assistant-recovery` 对 exact workspace/action/resource 重新授权。scope token 为冻结的
runtime brand，复制、展开或序列化后会失效。所有 Host 操作还绑定 Delivery principal row id/version；
`hostOwnerFence` 提供同样授权保护的只读 plan-time fence，返回冻结的
`{ ownerGeneration, principalLineage }`，供后台工作在执行前后做 exact-owner CAS；
`hostActivationCandidate` 返回确定性排序后的
`{ hypothesisId, expectedVersion, ownerGeneration, principalLineage }`，并复用激活时相同的 T1、owner typed evidence、latest selection、
active cap 与 same-key 判定；它只是 plan hint，`hostActivateOne` 最终仍在事务内重新执行相同门槛和
exact-version CAS，单次调用最多改变一个 hypothesis。activation 与最小回执在同一 `BEGIN IMMEDIATE`
事务内提交，返回 `{ hypothesisId, expectedVersion, resultVersion, ownerGeneration, principalLineageId, principalLineageVersion, replayed }`；即使提交后响应丢失或进程
重启，同一 `operationId + scope + target + version` 也只会重放原结果，不会因 stale CAS 误报失败；同一
operation 改 scope/target/version 会冲突，另一 operation 也不能冒认旧提交。重放会先重新验证当前 exact
owner generation 与 Delivery principal lineage；验证通过后，已提交的 durable receipt 不受后来 pause、
全局 disable 或 evidence/readiness 变化影响，只有首次 mutation 才受 enabled、paused 与 CAS 门槛约束。
receipt 只保存 scope digest、
哈希操作身份、hypothesis/version 和 owner generation/lineage，不保存 workspace、preset 或偏好值。A→B→A 后，gen1 的旧 receipt 不会在 gen3 replay 或虚报成功。`hostRollbackOne` 只接受 exact active T1，reason
由 Host 固定为 `regression`。
`hostMaintainOne` 只删除该 exact scope 最旧的一条已过 evidence TTL 的 signal；deletion 与
`operationId` receipt 同事务提交，同一步骤崩溃重试不会多删第二条；receipt 只保留 scope digest 与
哈希幂等身份，不保留 workspace/preset 明文。

## 风险模型

风险等级和值来自只读 Host catalog，调用者不能提交自由文本或自报风险等级：

- T0：只记录结构化观测，不生成行为假设；
- T1：格式、语言、详略、建议频率和推荐排序等本地可逆偏好；先处于 `shadow`，证据达标后才可激活；
- T2：长期记忆、自动通知、外部承诺、数据边界和预算策略；保持 `proposed + inactive`。首版只有 `memory.retention=long-term` 经过独立 promotion ledger 形成 owner 审批提案；其他 T2 不会进入 producer allowlist；
- T3：审批边界、凭据、安全风险目录和破坏性默认值；拒绝记录为偏好证据。

`actorTrust`（谁给出的信号）与 `interpretationTrust`（如何解释信号）分别保存。`tentative + active` 仍然不是 `confirmed`。Preference 不直接写 Memory：它只通过 Personal Memory 私有、可撤销 registration 投递固定 proposal，并仅在收到绑定最终 Memory record 的 committed receipt 后投影 `confirmed`。

长期 Memory 晋升不接受单一信号：当前门槛是至少 3 个支持信号、至少 2 个独立的 interpretation/source 通道、confidence >= 8500 bps、contradiction <= 1500 bps，且 hypothesis 必须仍是未过期的 `memory.retention=long-term`。请求只有 catalog tuple、计数、摘要和 owner fence，没有自由正文；Personal Memory 固定渲染为 `Retain information the owner explicitly confirms for long-term memory.`。这只表示 owner 希望长期保留其明确确认的信息，不会把其他偏好、聊天正文或推断自动写进 Memory。

promotion 与 Memory proposal outbox 在同一 Preference SQLite 事务创建。Memory 不可用时指数退避并在重启后继续；Memory 通过 Delivery 当前 owner route v2 重新验证 scope/principal/lineage/generation 后才建立审批，不允许 headless 降级。终态严格区分 `confirmed`、owner-explicit `rejected`、`expired`、`conflicted` 与 `stale-owner`。forget、owner rotation 和 superseding evidence 会创建 durable cancellation outbox；旧终态回执只能收到 `cancelled` ACK，不能复活已删除状态。若 Memory 在取消前已经 commit，则回报 `already-confirmed`，本轮不会伪装撤销已提交 Memory。

## 信号接入

owner 证据只接受 `assistant-delivery` 的私有 producer lane。普通消息必须来自 exact active owner，并且只有在 Agent turn 完成、session flush 成功、final reply Outbox 已经 durable enqueue 后，Delivery 才会用本机确定性分类器发布 content-free `response.language` behavioral observation。连续 6 次同语言使用才可自动激活；一次偶然切换不会回滚。连续 6 次相反使用且不存在 TTL 内更强的明确选择时，旧语言 overlay 才会回滚并切换。

Delivery 还把很短、整条消息完全匹配闭集的持续纠正（例如“以后简短一点”“以后用中文回答”“今后少用列表”及固定英文等价）映射为 `explicit-selection`。仅本轮的“请用中文回答 / Please be concise”等指令会被单独识别：既不会变成长期偏好，也不会反向贡献语言行为证据；混合任务、引用、代码、多行、长文本和不支持的 directive-like 语句一律保守 abstain。`/feedback <key> <value>` 仍可作为显式控制面；单词评价与 `too-long` 派生信号保持较弱的 `typed-feedback`。

owner 还可在同一对话使用 `/learning status|explain|export|pause|resume|rollback <exact-T1-key> confirm|forget confirm`。控制请求通过 Delivery 私有 registration 进入，不是模型工具；它绑定 exact Inbox、binding、Delivery principal row lineage 和 durable admission cursor。cursor 由 Delivery instance epoch 与严格递增的 Inbox admission sequence 组成，同一次 Inbox 重放保持不变。`status`、`explain` 和 `export` 为回执化读取，不推进 high-water；`explain` 只保存和返回 content-free T1 key/value/state/version/evidence-count 摘要，`export` 在同一事务内保存同样稳定排序的 current-scope T1 snapshot，并由 Delivery 输出 `dsh-preference-learning` v1 JSON。导出不写文件，不包含正文、workspace、principal/lineage/generation/session/event/Inbox/Outbox/cursor/idempotency/exposure 等内部数据。pause、resume、rollback、forget 只在 sequence 严格越过该 owner lineage 的持久 high-water 时生效，乱序控制会留下可重放的 durable no-op receipt。rollback 用一个事务 CAS 回滚该 key 的当前 active T1 并推进 projection cutoff；没有 active 值时不改偏好记录，但仍提交 cutoff 和可重放的准确 no-op receipt。pause/restart 后仍不收集、不激活、不注入；暂停期间或 forget/rollback 之前已持久排队的 projection 只会 ACK-ignore。forget 保持 pause 状态，删除较旧 control/explain/export/rollback 快照以防泄露已删除的值或计数。缺少 cursor 的旧 Delivery payload 会 fail-closed：事件 ACK-ignore，控制返回 stale。

从无 lineage/cursor 的旧 schema 首次 claim 时，插件会换代并清除旧 signals、hypotheses、overlay、exposures 以及 Host/control receipts，绝不继承激活状态；若 v6 已保存的 exact lineage 与本次 claim 完全相同，则仍执行证据隔离，但保留用户的 paused 状态。不同 Delivery epoch 不做字符串排序，无法证明顺序时 fail-closed。

两条路径都会先验证 exact active binding、Inbox/envelope、active owner、inbound/reply Policy 和 durable dispatch fence，再取得 exact external owner 的 `signal` / `preference:<preset>/<catalog-key>` Policy 授权，最后调用本插件私有注册的唯一 batch sink。该 sink 在一个 SQLite 事务内提交整批信号并返回逐项 durable receipt；`preference-learning` 没有任何公开方法可自报 `owner-authenticated`、`direct-owner-feedback` 或跨 scope owner 证据。

其他 Host producer 只能提交低信任观测：

```ts
ctx.assistantPreferenceLearning.appendObservation({
  scope: { workspace: '/absolute/workspace', preset: 'primary' },
  preferenceKey: 'response.verbosity',
  candidateValue: 'concise',
  stance: 'support',
  interpretationTrust: 'behavioral-inference',
  source: 'system-observation',
  occurredAt: Date.now(),
  idempotencyKey: 'producer-owned-event-id',
})
```

服务固定赋予这类输入 `system-attested`，且只接受 `behavioral-inference` / `model-inference` 与非 owner 来源。它们可形成 shadow 供审计，但自身不能满足激活门槛或授权回滚。原始幂等键按 producer lane 做域隔离哈希，聊天正文不进入账本。

模型可见工具只有：

- `preference_review`：读取当前 Agent scope 的有界假设；
- `preference_activate`：用 `hypothesis_id + expected_version` 激活证据达标的 T1；
- `preference_rollback`：用 `hypothesis_id + expected_version` 请求移除 shadow/active 假设；审计原因由 Host 固定，模型不能声称“owner 已拒绝”或伪造回归。

未验证身份、公共 observation 或模型推断可以形成 shadow，但无论累计多少，都不能满足自动激活门槛，也不能自动回滚已激活偏好。只有经过 Delivery 私有 completed-turn 证明的 owner behavioral observation，以及 owner explicit/typed feedback，才参与 effect 决策。明确选择在 TTL 内优先于之后的行为观察；一个闭集明确选择可立即激活固定 T1，typed feedback 仍需普通证据门槛，behavioral observation 必须达到单独的强阈值。

激活后的 prompt 由固定 catalog renderer 生成，当前请求始终优先。插件使用 DSH dynamic runtime context，在每个模型步骤重新读取 exact Agent scope，并由 AgentLoop 替换上一份快照。每次实际注入会把 exact `hypothesisId + version + sessionId + sourceEventId` 写入 durable exposure；turn 完成事件再绑定 exact `sourceInboxId + replyOutboxId`。回复该 Outbox 的相反 owner 明确反馈会留下 exposure-correction 关联并自动回滚对应旧 effect。账本不保存用户文本或模型输出。owner 更正、TTL 到期、显式回滚、forget、禁用/卸载和 session resume 都不会留下永久历史指令；下一步会得到新快照或明确清除旧快照。`overlayForAgent()` 是其他 Host prompt composer 的同一有界接入面。

## 配置

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `enabled` | `true` | `false` 时停止所有 producer 收集、激活和注入；Delivery 控制 registration 仍可返回 disabled 状态和执行 owner forget，Host 仍可审计、回滚和 forget |
| `databasePath` | Patch 设置 | 私有 SQLite 文件的绝对路径 |
| `signalTtlMs` | 90 天 | 信号衰减和保留窗口，硬上限 365 天 |
| `hypothesisTtlMs` | 30 天 | 假设 TTL，硬上限 30 天且不得大于信号窗口 |
| `minSignalsForActivation` | `2` | 激活所需最少支持信号 |
| `minBehavioralSignalsForActivation` | `6` | completed owner turns 的连续同值强阈值（4–20） |
| `autonomousT1Enabled` | `true` | 私有可信事件写入后自动 CAS 激活；启动与维护周期补偿已提交未激活项 |
| `minConfidenceBps` | `7500` | 最低置信度（万分比） |
| `maxContradictionBps` | `2500` | 最大矛盾比例（万分比） |
| `maxActiveOverlays` | `6` | 单 scope 活跃 overlay 硬上限（最多 8） |
| `maxReviewHypotheses` | `20` | 单次审计上限（最多 50） |
| `maxOverlayBytes` | `2048` | 固定 renderer 输出硬上限 |
| `maintenanceIntervalMs` | 1 小时 | 有界清理过期 signal 的周期（1 分钟至 24 小时） |
| `maintenanceBatchSize` | `500` | 每轮物理清理的最大 signal 数（最多 5000） |
| `promotionReconcileLimit` | `50` | 每轮提交、取消和终态回执投影的最大数量（最多 1000） |

置信度使用固定 actor/interpretation 权重、时间衰减、支持/矛盾质量和证据覆盖率计算；不调用模型打分。证据或状态更新与信号写入位于同一 `BEGIN IMMEDIATE` 事务中。

## 隐私、权限与数据

- 文件系统：创建并读写 `databasePath`；目录权限为 `0700`、数据库为 `0600`，SQLite 使用 WAL、`synchronous=FULL`、`secure_delete=ON` 和外键。
- 数据内容：保存规范化绝对 workspace、Agent preset、固定 catalog key/value、信任枚举、时间和哈希标识，以及 content-free exposure 的 hypothesis/version/Inbox/Outbox 标识；不保存聊天正文、模型输出、自由文本解释、凭据或原始幂等键。
- 保留与删除：`signalTtlMs` 是 evidence window，也是真实 signal 保留期限；后台按有界批次物理删除过期行，极端 backlog 会跨多轮收敛。假设、状态迁移和 forget tombstone 属于审计状态，不按 signal TTL 删除。可信 Host 可调用 `forgetScope(scope, idempotencyKey)` 删除该 exact scope 的信号、假设和状态历史；owner 控制面另保留不可逆 scope digest tombstone以及不含外部 principal 明文的最小 generation/pause/admission-cursor fence，阻止旧事件重放且不因删除而恢复学习。返回成功前还会完成并验证 WAL truncate，若读者占用导致 checkpoint busy，则以 `privacy-purge-pending` 要求按同一幂等键重试，而不虚报物理清除。没有模型可见删除工具。
- 网络、子进程、浏览器、凭据、安装脚本：无。

## 限制

owner 身份、日常 completed-turn 证明与显式反馈由 `assistant-delivery` 负责；未安装 Delivery 时仍可记录低信任系统观测，但不会产生可自动激活的 owner 证据。未安装 Personal Memory 时，合格 T2 promotion 会安全地留在本地 durable outbox；它不会绕过审批。当前自动学习只改变固定低风险表达偏好，不改变 Policy、工具权限、凭据、预算或安全阈值。

## 兼容性

基线见仓库的 [compatibility.md](../../docs/compatibility.md)。
