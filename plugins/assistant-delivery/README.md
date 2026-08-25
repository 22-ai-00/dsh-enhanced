# @dsh-enhanced/assistant-delivery

`assistant-delivery` 是个人助理唯一的、与厂商无关的消息核心。它把外部身份、一次性配对、conversation→DSH session 绑定、持久 Inbox/Outbox、adapter 生命周期、receipt、重试、对账和 dead letter 放在一个可审计边界内；飞书、Telegram 等包只实现协议适配。

本包不声明 exactly-once。它保证发送前先持久化 intent；若平台可能已经接收但响应丢失，则保留 `unknown_after_send`，只走 adapter 对账或显式 operator 决策，不盲目重发。

## 兼容性与安装顺序

- DSH / Agent / Agent Presets / LLM / Session：`>=0.1.0-rc.8 <0.2.0`
- `@deepseek-ai/dsh-attachment`：`>=0.1.0-rc.8 <0.2.0`，仅图片入站路径需要的可选 Host service
- `@deepseek-ai/dsh-permission-presets` / `@deepseek-ai/dsh-sandbox-policy` / `@deepseek-ai/dsh-user-approval`：`>=0.1.0-rc.8 <0.2.0`，权限档位命令使用 preset service，并通过 sandbox/approval 包的 canonical setter 固化执行事实；所需 Host service 缺失时命令 fail closed
- Cordis：`^4.0.1`
- `@dsh-enhanced/assistant-policy`：`>=0.1.0 <0.2.0`，硬依赖
- 真实多轮恢复还要求 profile 已配置官方 `ctx.sessionPersistence` provider；缺失时新建空 session 可以成功，但冷 resume 会进入有界失败/死信路径。

```sh
dsh plugin --profile headless add @dsh-enhanced/assistant-policy
dsh plugin --profile headless add @dsh-enhanced/assistant-delivery
dsh --profile headless --dump-config
```

标准 DSH `base` patch 已挂载 `@deepseek-ai/dsh-attachment-local`，因此由标准 profile 组合出来的 `web` / `headless` 部署无需重复安装 AttachmentStore；图片对象会以 content-addressed 形式保存在 `$DSH_HOME/attachments/v1`。如果自定义 profile 绕过了标准 `base`，必须自行挂载一个提供 `ctx.attachments` 的 `@deepseek-ai/dsh-attachment` 实现。服务缺失时只有图片路径会以 `attachment-store-unavailable` fail closed：不会调用渠道下载、不会把 provider reference 或伪占位文字交给 Agent，也不会退化为内存附件；普通文本仍按原路径工作。

当前 AttachmentStore 没有 reference-aware GC，也没有按 principal、时间窗口或全局容量实施磁盘配额。下载保存成功后若进程在 session 引用持久化前崩溃或授权被撤销，可能留下不可达的 content-addressed 对象；生产部署必须为该目录设置文件系统配额和容量监控，并由运维在能够证明无会话引用后清理孤儿对象。

Patch 通过 `inject: [assistantPolicy]` 固定加载策略依赖；入站 Agent runtime 另外等待 `agents`、`sessions` 与 `llm` 就绪。Web profile 提供 `agentPresets` 时会解析并挂载 session preset；不带 roster 的 headless profile 保留宿主全局工具组合。`schedulerEnabled` 默认开启，因此生产环境必须由 launchd、systemd 或 Docker restart policy 监管 DSH 进程。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `databasePath` | `$DSH_HOME/assistant-delivery/state.sqlite` | 私有 SQLite 权威账本，必须为绝对路径 |
| `spoolPath` | `$DSH_HOME/assistant-delivery/spool` | 预留的私有附件隔离目录，必须为绝对路径 |
| `schedulerEnabled` | `true` | 启用 Inbox/Outbox 后台 pump |
| `tickIntervalMs` | `1000` | pump 周期 |
| `leaseMs` | `30000` | 单次 Inbox/Outbox/模型确认 claim 租约，也是模型确认实时解析的 deadline；运行中的 Inbox turn 与 Outbox send 都会周期续租 |
| `maxAttempts` | `5` | 发送与 unknown 对账各自的自动尝试上限；owner 显式 retry 会在不重置审计计数的前提下再授予一次尝试；无对账能力的 unknown 保持待人工处理 |
| `maxConcurrency` | `4` | 跨 binding 并发数；同一 binding 始终串行 |
| `maxTextBytes` | `65536` | 单条入站/出站正文 UTF-8 上限 |
| `retryBaseMs` / `retryMaxMs` | `1000` / `300000` | 指数退避边界；adapter 的 Retry-After 是下限 |
| `pairingTtlMs` / `pairingMaxAttempts` | `600000` / `5` | 一次性本地配对时效与尝试上限 |
| `defaultWorkspace` | `$DSH_HOME/assistant-workspace` | 新 session 的绝对工作区；fresh create 前自动创建缺失目录 |
| `defaultAgentPreset` | `standard` | 新 session 解析并挂载的 preset；该内置 preset 提供 Bash、文件、检索、Skills 等完整编码能力 |
| `policyRef` | `owner-dm` | 固化在 binding 上的策略引用标签 |
| `agentProvider` / `agentModel` | `deepseek-official` / `deepseek-v4-flash` | 渠道 Agent 的部署默认模型；会话可用 `/model` 覆盖 |
| `toolCapableProviders` | `[deepseek-official]` | 尚未发布 registry metadata 的上游原生工具 provider 审计列表；未知 provider + 非空工具 fail closed |
| `agentMaxOutputTokens` | `8192` | 单轮模型输出上限 |
| `modelPickerTtlMs` | `900000` | `/model` 选择卡片的签名提交有效期；范围 1 分钟至 24 小时 |
| `toolApprovalTtlMs` | `300000` | 当前 open turn 的即时工具审批有效期；范围 1 秒至 5 分钟 |

所有可变部署值都经过 Schemastery 校验。每个 binding 会持久固定 workspace 与已解析的 preset id；有 roster 时，fresh create 和 cold resume 都在 Agent 发布前挂载该 preset，不能把 session header 中的 `agentPreset` 当成已经完成组合。fresh create 的新 workspace 使用 `0700` 请求模式，已有目录的权限不会被改写；cold resume 只验证持久 workspace 仍是目录，不会在仓库被删除或网络盘掉线时悄悄创建一个空目录。SQLite 使用 `WAL`、`synchronous=FULL`、foreign keys、busy timeout 和 forward-only schema；私有目录/数据库权限分别收窄为 `0700` / `0600`，未来 schema 会拒绝打开。

## Policy 最小示例

默认无规则即全部拒绝。下面只是字段示意，请把 account、tenant、user、workspace 和 automation id 收窄到自己的真实值：

```yaml
rules:
  - id: local-pairing
    effect: allow
    subject: { kind: external, id: "local:owner-cli" }
    actions: [pair.issue, pair.link, delivery.resolve]
    resource: { kind: message, id: "*" }
    context: { initiators: [foreground] }
  - id: owner-lark-ingress
    effect: allow
    subject: { kind: external, id: "lark/my-bot/my-tenant/my-user" }
    actions: [pair.confirm, ingest, approval.decide]
    resource: { kind: message, id: "*" }
    context: { initiators: [external] }
  - id: owner-channel-reply
    effect: allow
    subject: { kind: agent, id: standard, workspace: "/absolute/workspace" }
    actions: [reply]
    resource: { kind: message, id: "*" }
    context: { initiators: [external] }
  - id: owner-channel-bash
    effect: allow
    subject: { kind: agent, id: standard, workspace: "/absolute/workspace" }
    actions: [execute]
    resource: { kind: tool, id: bash }
    context: { initiators: [external] }
  - id: one-automation-send
    effect: allow
    subject: { kind: background, id: daily-review, workspace: "/absolute/workspace" }
    actions: [approval.send, send]
    resource: { kind: message, id: "binding_*" }
    context: { initiators: [background] }
```

工具可见性和执行授权是两道独立门：preset mount 决定 `bash`、`read`、`glob`、`grep` 是否进入 Agent 工具目录，Policy 再按精确 preset、workspace、initiator 和工具名决定能否调用。不要为 external 的 `execute/tool` 规则使用工具 id `"*"`；message ingress/reply 使用 `resource.id: "*"` 是预期行为。`policyRef` 目前只是 binding 上的审计标签，不会把规则自动收窄为 DM；`external` Agent 规则会覆盖同一 preset/workspace 下已经通过 Delivery ingress 的外部会话，包括群内 @ 场景。

`issuePairing()`、`linkPrincipal()`、`resolveDeadLetter()` 是可信本地控制面 API，不注册为模型工具。配对 code 只返回一次，数据库只保存随机 salt 的 scrypt hash；空 allowlist 不会把第一位来信者设成 owner。跨平台 principal 必须分别配对后再由 owner 显式 link。

`pairPrincipalLocally()` 是给安装向导使用的更窄离线入口：调用方必须已经拥有私有 Delivery SQLite 的本机文件权限，并提供完整 typed principal；函数内部仍走一次 challenge/confirm 事务，只返回 principal 记录，不返回 code。`lark-channel` 向导先用一次性 DM 短语确认具体 `open_id`，再调用该入口；普通 Agent、外部消息和后台任务都无法访问它。

## Adapter contract

渠道包通过 `ctx.assistantDelivery.registerAdapter()` 注册精确的 `(channel, account)`：

- `start({ accept, receipt })` 必须等 `accept()` 成功返回后才 ack/cursor；此时 event 已经持久化。
- `send(intent, signal)` 只能返回 `accepted`、可证明 `not-sent` 或 `unknown`。HTTP 200/平台 request accepted 只叫 `accepted`，不能伪装成 delivered/read。
- 429/明确 5xx 未发送应给出 `retryable` 与可选 `retryAfterMs`；永久 4xx 进入 dead。
- 请求可能已到平台但 response 丢失时返回 `unknown`。若声明 `reconcileUnknownSend` capability，必须实现对账，并使用独立的有界对账 attempt；连续无法判定达到上限后进入 dead，释放同 lane 后续消息。未声明该能力时记录保持 `unknown_after_send`，不会被领取为空对账 attempt，直到 owner 显式 retry/cancel。
- receipt 必须带同一个 channel、account、provider message id；状态只允许单调 `accepted→delivered→read`。
- adapter 的 socket、timer、SDK client 和 listener 必须由 `start()` disposer 释放。

内部身份始终是结构化的 `ExternalPrincipalKey`、`ConversationRef` 与 `ConversationBinding`，不会从 `platform:chat:thread` 字符串反解析路由。DM 不允许 thread；当前 group 入口要求显式 thread，从而避免所有群成员共享主 session。

## Agent 与工具

获批入站正文以 user-role message 写入 DSH，source 固定包含：

```json
{ "kind": "delivery", "channel": "lark", "account": "my-bot", "eventId": "...", "trust": "untrusted" }
```

受支持的图片入站不会把渠道资源 key 当作正文。Delivery 在确认 binding、Policy、当前模型明确声明 `image` input modality 且 AttachmentStore 可用后，才调用原 adapter 的窄图片下载接口；通过 store 的批量限额、格式解码和持久写入后，只把返回的 `ImageAttachmentRef` 作为 `ImageBlock` 追加到 session。下载后的字节由 AttachmentStore 管理，session 重启和 fork 复用同一个不可变引用，不会再次访问渠道。命令、文件、音频、视频和 sticker 不进入这条下载路径。

真实 principal、tenant、token 不注入 prompt。每个 binding 的 session id 由 conversation + generation 确定生成；`/new` 新建下一 generation 并保留旧 session。有 roster 时，binding 中的 preset 会在每次 create/resume 时重新解析并挂载到 Agent scope，因此 Web profile 可以继续关闭全局 Bash/FS，而渠道 Agent 仍获得自己的 preset 工具；无 roster 的 headless profile 则沿用宿主全局组合。lookup/create 进程内 single-flight，SQLite unique constraint 是最终冲突边界。

渠道控制命令在进入 Agent 前处理，因此默认模型未安装或临时不可用时，仍可自助恢复：

```text
/model
/model use codex-subscription/default
/model reset
/permissions
/permission ask
/permission auto
/permission full confirm
```

`/model` 从宿主 `ctx.llm` 的实时 provider/model 目录生成受限的 typed `model-picker` intent，不发起模型生成；每个模型会显式关联它自己的 `effortIds`，而不是共享全局 effort 并集。支持它的渠道可以据此显示“分组、模型、effort”三级联动选择和确认按钮，不支持它的渠道会把该 intent 明确拒绝而不会降级为任意卡片 JSON。持久 selection 会先投影为不含 `updatedAt/version` 的纯路由再进入严格 intent 边界；如果目录中的异常数据仍使卡片校验失败，系统会立即退回完整纯文本目录，确定性校验错误不会重试。某个 provider 或模型能力解析失败不影响其他项，最多载入 20 个 provider、50 个模型、每模型 20 档 effort，并且全目录最多 20 个不同 effort id。

卡片提交后，Delivery 会再次核对 active binding、精确 principal/chat 和 Policy，并用实时 `resolveModelInfo()` 验证 provider/model 及该模型支持的 effort；通过后把三项选择按 canonical conversation 持久化到 Delivery SQLite。选择从下一条普通消息生效，保留当前 session 上下文，跨 `/new` 和 Host 重启仍有效。卡片可选择“默认（由模型决定）”；`/model use` 保留为无卡片渠道和排错时的文字后备，`/model reset` 删除会话覆盖并恢复 `agentProvider` / `agentModel`。模型目录按宿主约定是建议性的，最终调用是否成功仍由对应 adapter 和账号认证决定。

`/permissions`（别名 `/permission`）只允许当前 active binding 的精确 owner 使用，命令本身不会进入 Agent 或触发 LLM。裸命令显示“请求批准（ask）/帮我批准（auto）/完全访问权限（full）”；前两档都使用 `workspace-write + ask`，区别是持久 reviewer 为 `user` 或 `auto-review`。`full` 使用 `danger-full-access + never + none`，可访问网络及任意文件，因此 `/permission full` 只显示橙色风险警告，必须再次发送 `/permission full confirm` 才切换。

档位不依赖 preset 名称，而是从 `ctx.permissionPresets.resolve()` 动态匹配底层 bundle；缺少 service 或所需组合时拒绝切换。每次读写都 resume binding 中的精确 session，并在解析、resume、写入和回复边界复核 owner 授权。命令会在 preset 之外通过 sandbox/approval 包的 canonical setter 显式固化两个执行事实，即使它们恰好等于部署默认值，旧 session 也不会依赖隐式默认值推断权限。升至 full 时按 `reviewer=none → approval=never → sandbox=danger-full-access` 写入；退出 full 时先由 preset 把 sandbox 收窄为 `workspace-write`，再恢复 reviewer。所有事件必须在同一 session log 中一次成功 flush；首次 mutation 或 flush 返回 `false` / 抛错时，不回滚追加日志，而是在同一 session 继续追加 `workspace-write + ask + reviewer=user` 安全补偿并再做一次 best-effort flush。补偿 flush 即使仍失败，内存有效权限也保持 ask，命令绝不回复切换成功，也不自动重放已经发生的权限 mutation。

权限命令在第一次 reviewer/policy/sandbox mutation 前还必须先取得 Inbox 的 durable dispatch claim；每个异步边界后都复核 abort 与租约。若续租失败、flush 结果不确定或较新的权限命令已经接管，旧命令会补偿回安全的 `ask` 并进入 `processor-ambiguous` dead letter，不会把过期的 `full` 自动重放到新状态之上。

普通消息真正 resume Agent 时，Delivery 会在 preset 挂载完成后检查最终 scoped tool schemas。非空工具要求 provider 通过 `@dsh-enhanced/llm-route-capabilities` 声明 `native`/`bridge`，或位于部署审计的 `toolCapableProviders`（默认仅 `deepseek-official`）；显式 `none` 永远覆盖列表。Claude、Cursor、Grok 和 Codex CLI 等 text-only route 因此会在 `followup()`、认证和子进程之前返回可操作的 `/model` 提示；显式 opt-in 的 Codex direct route 声明 `native`，可把 function call 交回同一个 DSH Agent Loop 执行。fresh session 创建本身不执行模型，仍可先持久建立 binding。最终工具为空时不要求能力声明。

只注册两个模型工具：

- `delivery_reply`：只能回复当前 Agent session 已验证的 binding，不能传 channel/account/chat/user。
- `delivery_status`：只返回有界 id/status/time/failureCode，不返回正文、route 或 secret。

普通 Agent 回复、Automation 结果和未来 Heartbeat 都必须 enqueue 到同一 Outbox。相同 `idempotencyKey` + 相同不可变 intent 返回同一行；同 key 改正文或 route 会冲突。

延迟审批由 domain 先通过 `prepareAgentApproval()` 从当前 Agent 的 active owner binding 派生不可伪造的 source/binding/workspace/principal route，再把该 route 随 Policy proposal 持久化；background Agent 可由可信 runner 使用 `bindAgentApprovalRoute()` 临时绑定 automation definition 中的 immutable `deliveryBindingId`，该绑定不会注册为模型工具。Delivery tick 会在发送前领取 Policy dispatch，以 `approval-card:<proposalId>` / `approval:<proposalId>` 写入同一 Outbox，再用 CAS 标记已入队；若进程在两步之间退出，重放仍命中同一 intent。schema v6 另以带版本 fence 的持久 `(createdAt, proposalId)` 高水位分页扫描 pending dispatch：无效 route 不会被伪标为已入队，但也不能用一个 poison page 永久饿死后续审批；扫描到尾后回绕重试这些条目，Host 重启与并发 scanner 都不会倒退覆盖新游标。

`enqueueApproval()` 只接受固定的 operation/proposal/version/expiry/title/diffHash 字段，并重新核对 active owner、精确 workspace/principal、Policy pending snapshot、展示标题和正文 SHA-256，调用方不能替换审批卡片展示内容。渠道签名后的点击仍必须回到 `settleApproval()`；它从 Outbox 取回持久 operation tuple，并再次核对 active owner binding、principal/chat、proposal version/expiry/diffHash 与 Policy pending snapshot，重复点击只会得到同一持久化结果。若 Policy 已提交而 Delivery 在写回结果前退出，只有此前已经落盘的同一 settlement 且当前 Policy 为精确同一终态时才能通过 `recoverApprovalSettlement()` 补全；该恢复路径不会新建 settlement，也不会决定 pending/expired proposal。

即时工具审批是另一条刻意不持久化的 open-turn 路径：effective reviewer 为 `user` 时由 Delivery 交给 owner；`auto-review` 则先由 Policy reviewer 处理，低风险 grant 不出卡，只有本地明确敏感、原生 sandbox escalation，或模型未 grant/失败后由 Policy 按 exact request identity 标记升级的请求，才允许 Delivery 接管。Policy listener 使用 prepend 注册，因此即使 Delivery 先于 LLM/reviewer 就绪也仍先完成自动审查；未标记或未知来源的 auto-review 请求只继续 waterfall，不会被 Delivery 抢跑。`never`/`none` 不创建渠道提示。以上人工路径还必须具有精确 direct binding 或显式 `bindAgentApprovalRoute()` delegated binding、当前 active owner，且会话为 DM；群聊一律 `unavailable`，因为 raw arguments 可能含 secret，不能向旁观者展示。Delivery 同时识别当前未结束 turn 内唯一且未结算的顶层 `tool/call`，以及带 exact root/parent/sub-call identity 的 Code Mode `tool/code-dispatch-start`；已经出现 `tool/result` 或 `tool/code-dispatch` 的调用一律拒绝。raw arguments 必须完整且不超过 16 KiB，reason 必须完整且不超过 2 KiB，均不截断。reason 只是未经信任的展示说明、绝不是可执行指令，但仍作为用户看到的 exact 内容纳入授权 hash。

展示前，`ctx.sessions.flush(session)` 必须返回 `true`，即至少一个持久化 listener 已成功把包含 `approval/asked` 与 exact tool/call 的事实落盘；返回 `false` 或抛错都会 `unavailable`。每次请求使用不可猜的随机 operation nonce，并以 SHA-256 `actionHash` 绑定 exact binding revision/route、owner、session incarnation、当前 turn、顶层或 Code Mode 调用身份与 raw arguments、exact reason、当前 provider/model/effort、人工 review route/escalation 与 permission/reviewer/policy 事件。flush 后、adapter 返回后都会重新核对 binding/principal/agent/delegated token/adapter 与 actionHash；撤权、解绑、route、escalation 或权限漂移都不能返回 grant。owner 返回允许后还会以不重复消耗预算的只读方式复核 Policy emergency stop；卡片等待期间打开紧急停止会把 grant 收紧为拒绝。

这类工具卡只在 `toolApprovalTtlMs` 内和当前进程的 open turn 中有效；调用方 abort 才是 `cancelled`，超时、过期、adapter 异常/断线/注销、Host 重启或 Delivery dispose 都 fail closed 为 `unavailable`。旧卡不恢复、不自动重放，也不进入 Outbox。它不同于上面的 durable Policy proposal：proposal 有持久 operation、CAS settlement 和受控 recovery，适合延迟审批；即时工具授权只允许同一 live call 的一次结果。

模型选择同样不开放任意渠道 payload。`model-picker` intent 只允许有界的 provider/model/effort 目录和有效的 model→effort 引用；目录与 operation 一起保存在 Outbox，渠道可在 Host 重启后按 operation 恢复同一份选择目录。schema v5 另外保存每个 operation 的选择 revision 和确认结算：渠道联动回调通过 CAS 前进，旧 revision 只能读取当前状态；确认先持久领取 operation，带租约和 fencing token 的 worker 在启动与 tick 时恢复未完成任务，并在实时模型解析后重新校验 active principal、binding 与 Policy。最终模型选择、结算结果与确认 Outbox 在同一事务中提交，因此重启、慢解析与重复回调不会重复应用选择。

## 故障语义

- Inbox：`received→authorized→queued→claimed→processed|retry_wait|dead_letter`。
- Outbox：`pending→attempting→accepted→delivered→read`，另有 `retry_wait`、`dead`、`unknown_after_send`。
- attempt 与 receipt 都是独立追加账本；不同 binding 可并行，同一 binding 保序。
- claim/complete 带 owner + fencing token；过期 worker 不能提交新 owner 的结果。
- 运行中的 Inbox/Outbox claim 每隔约三分之一租期按精确 owner + fencing token 续租；续租失败会 abort Agent/adapter signal，过期 worker 即使随后返回成功也不能提交结果。
- `maxAttempts` 只限制自动 claim；owner 对 dead letter/unknown 的显式 retry 把状态 CAS 回 `queued`/`pending` 并获得一次新 claim，`attempt_count` 与 attempt ledger 不回绕。
- Agent dispatch 前写 `dispatch-started` marker。此后进程崩溃会进入 `dispatch-ambiguous` dead letter，避免自动产生第二个 turn；这会牺牲一次自动重放，需要 owner 审阅后显式 retry。
- 当前 rc.8 `followup()` 没有跨进程 `sourceEventId` 唯一接纳/完成 handle，因此本包诚实承诺“持久 event 去重 + at-most-once 自动 Agent dispatch”，不声称端到端 exactly-once。若宿主未来提供该 seam，可升级为安全的 at-least-once wake。
- Outbox adapter 抛异常一律视为可能已发送；不会按照普通 5xx 重试。

## 权限与数据边界

- **文件系统：**读写配置的 SQLite 与私有 spool 目录，并在 fresh Agent create 前创建缺失的 workspace；cold resume 只验证原目录仍存在。图片字节通过宿主 AttachmentStore 持久化；标准 `attachment-local` 将其写入 `$DSH_HOME/attachments/v1`，Delivery 自己不把字节写进 SQLite、spool 或 session 日志。Delivery 本身不读取任意 workspace 文件。挂载 preset 后，获 Policy 允许的文件工具可在 DSH 文件权限边界内读取 workspace。
- **网络：**本包自身无网络访问；网络权限属于注册的渠道 adapter。
- **进程/浏览器：**Delivery 本身不启动 subprocess、shell 或 browser；它挂载的 preset 可以暴露 Bash/Pwsh，真正执行由宿主 sandbox、approval 与 Policy 三层共同约束。
- **凭据：**不接收、存储或输出 provider token；adapter 必须通过 SecretRef/后续 credentials service 获取。
- **数据：**Inbox/Outbox 会保存消息正文、外部 identity 和 route，属于 PII。入站只登记最多 10 个受限 provider descriptor；授权图片会额外保存经过校验的 AttachmentStore 引用和内容摘要，provider reference 始终留在隔离账本而不进入 prompt、模型请求或工具输出。图片二进制遵循所选 AttachmentStore 的保留策略；标准 `attachment-local` 当前没有引用垃圾回收。文件、音频、视频和 sticker 仍保持 metadata quarantine。当前版本也不自动清理 Delivery 历史，请依部署的数据保留策略备份/轮换私有数据库和附件对象。

## 当前非目标

- 多主机分布式 worker、跨平台自动合并、群聊共享主 session、广播、presence/read SLA。
- 普通文件、音频、视频、sticker 的 payload 下载，OCR、病毒扫描与 multipart 附件发送；当前二进制入站能力严格限于受支持的光栅图片。
- 任意收件人模型工具、把 provider accepted 当 delivered、对未知发送自动重试。
- OS 级恶意插件隔离。它约束遵守 Cordis service contract 的代码；同进程恶意 Host 插件仍需容器或独立 runtime。

## 验证

```sh
pnpm --filter @dsh-enhanced/assistant-delivery test
pnpm --filter @dsh-enhanced/assistant-delivery typecheck
pnpm --filter @dsh-enhanced/assistant-delivery build
pnpm --dir plugins/assistant-delivery pack --dry-run
```

兼容性基线见 [docs/compatibility.md](../../docs/compatibility.md)。
