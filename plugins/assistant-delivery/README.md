# @dsh-enhanced/assistant-delivery

`assistant-delivery` 是个人助理唯一的、与厂商无关的消息核心。它把外部身份、一次性配对、conversation→DSH session 绑定、持久 Inbox/Outbox、adapter 生命周期、receipt、重试、对账和 dead letter 放在一个可审计边界内；飞书、Telegram 等包只实现协议适配。

本包不声明 exactly-once。它保证发送前先持久化 intent；若平台可能已经接收但响应丢失，则保留 `unknown_after_send`，只走 adapter 对账或显式 operator 决策，不盲目重发。

## 兼容性与安装顺序

- DSH / Agent / Agent Presets / LLM / Session：`>=0.1.0-rc.8 <0.2.0`
- `@deepseek-ai/dsh-attachment`：`>=0.1.0-rc.8 <0.2.0`，仅图片入站路径需要的可选 Host service
- `@deepseek-ai/dsh-host-apiproxy`：`>=0.1.0-rc.8 <0.2.0`，可选 Host service。它保持唯一的 `ctx.userQuestions` provider；存在时 Delivery 使用 rc.8 的 `events.mux()` 桥接已绑定渠道会话的问题，缺失时不阻止非 Web profile 启动，只是不提供跨渠道问题交互。
- `@deepseek-ai/dsh-user-questions`：`>=0.1.0-rc.8 <0.2.0`，仅使用其 wire-safe question/answer 类型；provider 仍由 Host ApiProxy 独占。
- `@deepseek-ai/dsh-commands`：`>=0.1.0-rc.8 <0.2.0`，可选 Host command service；按 `0.1.0-rc.8` 命令语法/执行契约只委托安全的原生 `/compact`。`/help`、`/status`、`/session`、`/new`、`/clear`、`/stop`、`/feedback`、`/learning` 及模型/权限控制命令都由 Delivery 自有；其他原生命令即使被宿主发布也不委托、不进入 LLM
- `@deepseek-ai/dsh-permission-presets` / `@deepseek-ai/dsh-sandbox-policy` / `@deepseek-ai/dsh-user-approval`：`>=0.1.0-rc.8 <0.2.0`，权限档位命令使用 preset service，并通过 sandbox/approval 包的 canonical setter 固化执行事实；所需 Host service 缺失时命令 fail closed
- Cordis：`^4.0.1`
- `@dsh-enhanced/assistant-policy`：`>=0.1.0 <0.2.0`，硬依赖
- Preference Learning 是反向订阅 `subscribePreferenceFeedback()` 的可选下游；Delivery 不声明对它的 peer/runtime 依赖，避免消息核心与学习插件形成双向包依赖
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
| `maxConcurrency` | `4` | 跨 owner scope 并发数；同一 durable principal row + workspace + preset 即使有多个 binding 也按 Inbox admission 顺序串行 |
| `maxTextBytes` | `65536` | 单条入站/出站正文 UTF-8 上限 |
| `retryBaseMs` / `retryMaxMs` | `1000` / `300000` | 指数退避边界；adapter 的 Retry-After 是下限 |
| `pairingTtlMs` / `pairingMaxAttempts` | `600000` / `5` | 一次性本地配对时效与尝试上限 |
| `defaultWorkspace` | `$DSH_HOME/assistant-workspace` | 新 session 的绝对工作区；fresh create 前自动创建缺失目录 |
| `defaultAgentPreset` | `standard` | 新 session 解析并挂载的 preset；该内置 preset 提供 Bash、文件、检索、Skills 等完整编码能力 |
| `policyRef` | `owner-dm` | 固化在 binding 上的策略引用标签 |
| `agentProvider` / `agentModel` | `deepseek-official` / `deepseek-v4-flash` | 渠道 Agent 的部署默认模型；会话可用 `/model` 覆盖 |
| `agentMaxOutputTokens` | `8192` | 单轮模型输出上限 |
| `agentMaxAutoContinuationTurns` | `2` | 截断、空响应或超出渠道正文预算时的后台自动恢复轮数；范围 `0`–`8`，设为 `0` 可关闭 |
| `modelPickerTtlMs` | `900000` | `/model` 选择卡片的签名提交有效期；范围 1 分钟至 24 小时 |
| `permissionPickerTtlMs` | `900000` | `/permissions` 三档权限卡片的签名提交有效期；范围 1 分钟至 24 小时 |
| `toolApprovalTtlMs` | `300000` | 当前 open turn 的即时工具审批有效期；范围 1 秒至 5 分钟 |
| `ownerRoutes` | `[]` | Host-owned 稳定 owner 路由；每项精确固定 id、conversation、principal、绝对 workspace、preset、policyRef 和 minimumGeneration |

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
  - id: supervised-growth-owner-route
    effect: allow
    subject:
      kind: background
      id: growth-supervisor
      workspace: "/absolute/workspace"
      principal: "lark/my-bot/my-tenant/my-user"
    actions: [send]
    resource: { kind: message, id: "route:supervised-growth-owner" }
    context: { initiators: [background] }
```

能力挂载、Policy 可达性和执行审查是分层的门：preset mount 决定 `bash`、`read`、`glob`、`grep` 等工具是否进入 Agent 目录，Policy 再按主体与 initiator 授权。安装器默认为本地 Web/direct `foreground` Agent 写入跨 preset/workspace 的通用 capability 规则，并为 Delivery 写入精确 preset + 绝对 workspace + canonical external principal + `external` 规则；Delivery 在每次 create/resume 时从 binding/envelope 绑定同一 principal。通配 action/resource 同时覆盖动态工具和 `memory.search`、`wiki.read`、`automation.propose` 等插件内部二次 Policy 动作，而 `background` 不会因此放宽。自定义部署可使用更窄的 allowlist 或显式 deny，deny 始终优先。message ingress/reply 使用 `resource.id: "*"` 是预期行为。`policyRef` 目前只是 binding 上的审计标签，不会把规则自动收窄为 DM；同一 owner principal 在群内 @ 机器人时仍会使用其精确 external Agent 规则。

`issuePairing()`、`linkPrincipal()`、`resolveDeadLetter()` 是可信本地控制面 API，不注册为模型工具。配对 code 只返回一次，数据库只保存随机 salt 的 scrypt hash；空 allowlist 不会把第一位来信者设成 owner。跨平台 principal 必须分别配对后再由 owner 显式 link。

### 稳定 owner 路由

长期运行的 supervised-growth / recovery 控制面不应把某一代 `bindingId` 当作永久收件地址。部署方可以在 Delivery 配置中声明稳定但不扩权的 Host authority：

```yaml
ownerRoutes:
  - id: supervised-growth-owner
    conversation:
      channel: lark
      account: my-bot
      tenant: my-tenant
      kind: dm
      chat: oc_owner
    principal:
      channel: lark
      account: my-bot
      tenant: my-tenant
      user: my-user
    workspace: /absolute/workspace
    agentPreset: personal-assistant
    policyRef: owner-dm
    minimumGeneration: 1
```

`resolveOwnerRoute(id)` 每次从 binding ledger 读取该 conversation 的当前 active binding，只接受 active owner，且要求 principal、workspace、agent preset、policyRef 全部逐项相等、generation 不低于显式 floor；`/new` 产生的同 lineage 下一代可单调前进，任一身份或作用域漂移都会 fail closed。authority 只存在于 Host 配置和 service API，不注册为 Agent 工具、不进入 prompt，也不能由成长系统自行创建或修改。

`enqueueBackgroundRoute()` 的 Policy resource 固定为精确的 `message/route:<authorityId>`，subject 同时带配置中的 workspace 与 canonical owner principal；部署规则不需要、也不应为这条控制路径授予 message 通配符。Policy 通过后，Delivery 会在同一个 `BEGIN IMMEDIATE` 事务内重新解析 active binding 并写 Outbox，封住授权期间 `/new` 的竞态。claim 时还会在同一写事务内重新验证 authority、source hash、完整 owner scope、generation floor 与当前 exact Policy；route 被删除、修改或撤权时不会调用 adapter，而是写入带 `owner-route-*` failure code 的 terminal Outbox 和 `outbox_attempts` 审计 receipt。

显式 Policy deny 表示 T3 撤权并永久 dead；Policy 检查本身抛错（例如 SQLite busy、滚动部署中的短暂不可用）不等同撤权。claim 前发生时，消息保持 `retry_wait`、`attemptCount` 不增加并暴露 `owner-route-policy-check-failed`；claim 后、adapter I/O 前发生时，当前 not-sent attempt 进入带退避的 `retry_wait`。两者都不会调用 provider，Policy 恢复后可自动继续。锁顺序也保持单向：enqueue 的 Policy 写在进入 Delivery 事务前已经完成；claim 只有 Delivery→Policy 的同步检查，没有持有 Policy 写事务再进入 Delivery 的反向路径。运维可用 `pendingOutbox` 加该 failure code 定位持续锁冲突，而不丢失唯一告警。

每条 route Outbox 的 immutable metadata 都保存 authority/source identity、authority/source hash、最初与当前解析出的 binding id/version/generation、minimumGeneration 与 receipt version，供 incident 按原 lineage 和实际 dispatch generation 对账。相同 idempotency key、authority、source、正文与格式在 `/new` 或 Host 重启后仍返回原 Outbox；修改任何不可变内容都会冲突。

若尚未发生 provider I/O，`pending` 或由 provider 明确证明 not-sent 的 `retry_wait` 可以在 claim 前用 CAS 单调重绑定到同身份、同 scope 的 `/new` generation；intent、route snapshot/hash 与 lane 会一起原子更新，最初 lineage 保持不变。claim 后、真正调用 adapter 前还会再次核对 authority 与 Policy；刚好在 claim 后提交的同 scope `/new` 可继续向稳定 conversation 发送，任何 principal/workspace/preset/policyRef 漂移仍失败关闭。已有 `attempting`/accepted/ambiguous 证据的记录绝不通过该路径迁移。

如果原记录已经是 `unknown_after_send`，重放只返回该 ambiguous 记录，不迁移到新 generation、不重新入队、更不会自动重发；稳定 route 的 operator `retry` 也会被拒绝。它只能在原 lineage 上由 adapter reconcile、由 owner cancel/park，或被后到的 provider receipt 单调结算。这是稳定 route 比普通 Outbox 更严格的 unknown-send 契约。

不同 Host 必须部署同一份 authority 配置。同一 idempotency key 的配置漂移会由 authority hash receipt 拒绝；本功能刻意不增加数据库 schema，因此使用不同新 key 的两个 Host 不会通过账本互相证明配置一致，部署层仍需用同一受控 profile 发布并校验配置。

`pairPrincipalLocally()` 是给安装向导使用的更窄离线入口：调用方必须已经拥有私有 Delivery SQLite 的本机文件权限，并提供完整 typed principal；函数内部仍走一次 challenge/confirm 事务，只返回 principal 记录，不返回 code。`lark-channel` 向导先用一次性 DM 短语确认具体 `open_id`，再调用该入口；普通 Agent、外部消息和后台任务都无法访问它。

## Adapter contract

渠道包通过 `ctx.assistantDelivery.registerAdapter()` 注册精确的 `(channel, account)`：

- `start({ accept, receipt })` 必须等 `accept()` 成功返回后才 ack/cursor；此时 event 已经持久化。
- `send(intent, signal)` 只能返回 `accepted`、可证明 `not-sent` 或 `unknown`。HTTP 200/平台 request accepted 只叫 `accepted`，不能伪装成 delivered/read。
- 429/明确 5xx 未发送应给出 `retryable` 与可选 `retryAfterMs`；永久 4xx 进入 dead。
- 请求可能已到平台但 response 丢失时返回 `unknown`。若声明 `reconcileUnknownSend` capability，必须实现对账，并使用独立的有界对账 attempt；连续无法判定达到上限后进入 dead，释放同 lane 后续消息。未声明该能力时记录保持 `unknown_after_send`，不会被领取为空对账 attempt，直到 owner 显式 retry/cancel。
- receipt 必须带同一个 channel、account、provider message id；状态只允许单调 `accepted→delivered→read`。
- `progress()` 收到的工具参数/结果仅是最多 1500 字符的展示预览，并会脱敏常见 credential 字段与 token 形态；畸形或原始输入过大的参数只产生状态标记，不回显 raw text。它不包含任何 reasoning/thinking 内容或 provider 原始错误。adapter 仍必须按当前受众决定是否展示明细，群聊等共享受众应保持 status-only。
- adapter 的 socket、timer、SDK client 和 listener 必须由 `start()` disposer 释放。

内部身份始终是结构化的 `ExternalPrincipalKey`、`ConversationRef` 与 `ConversationBinding`，不会从 `platform:chat:thread` 字符串反解析路由。DM 不允许 thread；group 入口要求渠道提供显式且稳定的 thread，可以是真实 provider root，也可以是渠道命名空间内按 principal 派生的顶层合成 lane。binding 仍固定精确 principal，任何同 conversation 的另一 principal 都会在进入 session 前 dead-letter，不能共享既有 owner 上下文。Lark 顶层群消息使用按发送者派生的合成 lane，真实回复串继续按 `root_id` 隔离。

### 跨渠道 `ask_user_question`

`apiProxy` 始终是 `ctx.userQuestions` 的唯一 provider；Delivery 不注册第二个 provider。可选的 rc.8 `apiProxy.events.mux()` 将 pending `question/requested` 帧交给 Delivery，Delivery 只在其 session 仍对应 exact active owner binding、当前 adapter 仍具备问题交互能力时，转给该渠道；回答以同一 rpc id 回写 `apiProxy.respond()`。同一请求同时可被 Web 与渠道界面看到，谁先被 ApiProxy 接受谁生效（first-claim-wins）；晚到、撤销或重复回答不会制造新的 Agent turn。

渠道自由文本只有在明确回复对应问题消息时才会结算，并要求 account、tenant、conversation、principal、binding version/generation 与当前 owner fence 全部匹配；同一路由恰好只有一个 pending question 也不会吞掉未引用的新消息。匹配回答直接恢复原来的工具调用，不写 Inbox、不作为普通新消息排队；`/stop`、`/new`、`/clear` 仍按渠道正常命令接入规则取消旧 wait（例如群聊可能仍要求 @ 机器人），问题卡的取消按钮则不依赖文字命令。问题发往原 binding 会话，不保证是私聊：若原会话是群聊，问题正文和选项对该群可见，敏感问题应在私聊中发起或改用其他交互方式。

## Agent 与工具

获批入站正文以 user-role message 写入 DSH，source 固定包含：

```json
{ "kind": "delivery", "channel": "lark", "account": "my-bot", "eventId": "...", "trust": "untrusted" }
```

受支持的图片入站不会把渠道资源 key 当作正文。Delivery 在确认 binding、Policy、当前模型明确声明 `image` input modality 且 AttachmentStore 可用后，才调用原 adapter 的窄图片下载接口；通过 store 的批量限额、格式解码和持久写入后，只把返回的 `ImageAttachmentRef` 作为 `ImageBlock` 追加到 session。下载后的字节由 AttachmentStore 管理，session 重启和 fork 复用同一个不可变引用，不会再次访问渠道。命令、文件、音频、视频和 sticker 不进入这条下载路径。

真实 principal、tenant、token 不注入 prompt。每个 Delivery SQLite 在首次创建时持久生成随机实例命名空间；新 binding 的 session id 由该命名空间 + conversation + generation 确定生成。数据库重开会复用同一命名空间和既有 binding，数据库删除重建或另一个 profile 的独立数据库则得到不同命名空间，避免共享 DSH session 日志根时串用旧上下文；已持久 binding 始终按自身 `sessionId` 冷恢复，不受后续算法变化影响。`/new` 新建下一 generation 并保留旧 session。有 roster 时，binding 中的 preset 会在每次 create/resume 时重新解析并挂载到 Agent scope，因此 Web profile 可以继续关闭全局 Bash/FS，而渠道 Agent 仍获得自己的 preset 工具；无 roster 的 headless profile则沿用宿主全局组合。lookup/create 进程内 single-flight，SQLite unique constraint 是最终冲突边界。

## 会话命令与持久上下文

- `/help`：列出当前实际可用的命令。
- `/status`（别名 `/session`）：显示 session 代次与指纹、上下文消息数、已记录轮次和当前模型。
- `/new`（别名 `/clear`）：停止当前任务并切换到空白的下一 generation；旧 session 及历史不删除。
- `/stop`：停止当前任务，保留当前 session 与已持久的上下文。
- `/compact`：仅在当前 DSH command service/preset 实际发布时出现；通过原生命令面执行，不交给模型。
- `/feedback`：提交固定枚举的响应偏好，或对 exact Automation 结果提交任务目标状态；在 Delivery 本地处理，不恢复 Agent、不交给模型。
- `/learning`：查看状态或 content-free T1 摘要、导出版本化稳定 JSON、暂停、恢复、按 exact T1 key 回滚或清除当前 workspace + preset 的偏好学习；只允许 exact active owner，在 Delivery 本地处理，不恢复 Agent、不交给模型。

渠道 command envelope 只接受从正文第一字节开始的小写 ASCII slash 语法。未知命令、当前 preset 未发布的命令，以及大写、空命令等非法 slash 形态都只返回确定性帮助/错误，绝不作为自然语言进入 LLM。普通 Agent turn 只有在 session persistence `flush()` 明确返回 `true` 后才入队最终回复；返回 `false` 或抛错时不宣称任务成功。

Agent Loop 以 `max-tokens` 结束、正常结束却没有正文，或完整正文超过 `maxTextBytes` 时，Delivery 默认在同一 session 中发起最多两轮后台恢复：先续写缺失部分；若仍未结束，最后一次机会优先根据当前请求和其后全部已有回答片段压缩为预算内的完整答案，不会把同一长会话中更早已完成的任务混入结论。空回答会重新生成，首轮即超长的回答会直接压缩。每个片段先持久化，再开始下一轮；恢复轮沿用已经选定的 provider、model 和 effort，但 source 明确标记为 Delivery 的内部 notice。恢复轮禁止工具执行：rc.8 仍可能把 scoped tool schema 序列化给 provider，但任何调用都会在审批和执行前被拒绝，并立即结束该恢复轮；工具状态也不会展示给用户，后续恢复仍受同一总轮数限制。最终只投递一次合并后的完整回复并标记完成，不需要用户发送”继续”。
后台恢复是新的、有界模型 turn，可能产生额外模型用量，不是对同一个已提交请求的透明重试。若恢复轮失败或次数耗尽、没有新增正文，或已经持久化但无法建立安全调度边界，Delivery 才保留当前最佳正文、附加明确的未完成提示并标记失败；完全没有可用正文时发送重试提示。失败提示不再要求用户发送“继续”这类协议词。若任何片段无法确认持久化，则不投递该结果，也不宣称完成。这些失败回复不会进入 completed-turn preference projection。`agentMaxAutoContinuationTurns` 设为 `0` 时保留直接失败提示行为。

`/feedback` 的完整固定语法如下；不接受附件或额外自由文本：

```text
/feedback helpful|not-helpful|too-long|too-short|wrong-format|wrong-action|unwanted-reminder
/feedback achieved|partial|not-achieved
/feedback verbosity concise|balanced|detailed
/feedback structure prose|bullets|mixed
/feedback language zh-CN|en
/feedback explanation result-first|balanced|tutorial
/feedback suggestions low|normal
/feedback ranking recency|familiarity|evidence
```

`helpful`、`not-helpful` 等只进入 Preference Learning，绝不被推断成任务成功或失败。对于
Automation 结果，`achieved`、`partial`、`not-achieved` 只接受为带固定反馈说明的、exact production
Automation 成功结果的直接回复；Automation 结果只能通过 Host-only `enqueueAutomationResult(...)` 进入
这条路径：Delivery 会重新核对 immutable run、workspace、binding 与输出 digest，并自行生成保留的
`dsh.learning.*` 证据；普通 `enqueueBackground(...)` 不能提交这些保留 metadata。同一 immutable run
的相同目标状态幂等重放为同一 Evaluation outcome，之后提交相反状态会报告冲突，不会形成第二票。

普通 Agent 回复另有一条更窄的本地 workflow 证据路径：active owner 必须精确回复该条已持久、已投递的 reply，且原始入站正文必须逐字命中已审查的闭集静态 catalog。只有 `achieved` 与该 catalog 同时成立，Delivery 才原子记录 content-free `verified-repetition` trace，并把静态模板保留在私有 registry；正文、模型输出和 owner 自由文本不会投影到 Growth。`partial`、`not-achieved`、未命中 catalog、preview、失败运行、旧 schema、手写 background intent 或不能由 durable Inbox/Outbox route 重新证明的目标只留下不可改写的本地 `no-trace` 回执，绝不宣称任务成功或形成学习样本。

workflow trace 只会投影给一个由 Growth 以 `registerWorkflowTraceSink(...)` 注册的进程内、可撤销 sink。
Delivery 先持久化 trace outbox，再异步投影并验证 exact receipt；sink 暂时不可用会退避重试，卸载、替换或
disposer 会立即撤销该 authority。这个 sink 不是模型工具、通用 Growth service 写入面或任意调用方可伪造的
callback。

只有 exact active binding 上的 active `owner` principal 可以提交。Delivery 在现有 inbound/reply Policy 通过后核对 durable Inbox/envelope、binding revision、workspace、preset 与 owner 身份，先写 `dispatch-started` fence，再复核一次身份，并对 exact external owner + workspace 执行可审计的 `signal` / `preference:<preset>/<catalog-key>` Policy 授权，最后才向唯一权威 sink 发布不可变 typed batch。`linked` principal 即使拥有普通消息入口也不能获得 `owner-authenticated`；event idempotency key 由 provider-scoped event、binding snapshot、durable principal row lineage、Inbox admission cursor 和固定 catalog selection 做 SHA-256 派生，不把 event/principal 原文传给下游。每个 Delivery SQLite 用不可变 instance epoch + 递增序号为 Inbox 建立持久全序，同毫秒事件和跨 binding 控制不依赖墙钟排序；`receivedAt` 只用于保留期，不决定控制 precedence。`too-long` / `too-short` 在同一原子 batch 中发布 T0 响应评价和对应的 T1 verbosity 选择。

注册接口是 Host-only、只读、非模型工具；`preference-projection/v2` 全进程只允许一个 authoritative sink。sink 必须将整个 batch 原子、持久、幂等地提交，并逐 event 返回 exact key + `recorded` receipt。Delivery 先把投影与 reply 写进自己的 SQLite；Preference 尚未安装、重载中或 sink 暂时失败时保留 pending/retry row，之后按原 admission cursor 重放，不重新调用 Agent。投影 outbox 以 `Delivery epoch + workspace + preset + principal row/version` 组成持久 owner lane；同 lane 较早的未终态 cursor 即使尚未到重试时间，也会阻止后续任意 preference key 和 `/learning` control 越过。control 因屏障而 defer 时保留其 durable Inbox recovery，不会把 drain 返回误报为控制成功。缺回执、错 key、重复 key或异常不会伪造下游成功；相同 provider event 与 cursor 由稳定 key 安全去重。旧 v1 或无 cursor 投影在升级边界作为全局 fail-closed 屏障，交给新 Preference 终态 ACK-ignore；无法规范化的损坏行则保留 terminal quarantine 审计后解除屏障，既不会被应用，也不会永久锁死全部学习控制。

Profile 还必须为当前 owner principal 添加精确授权，例如：`subject={kind: external, id: <canonical-owner>, workspace: <workspace>}`、`action=signal`、`resource={kind: preference, id: <preset>/*}`、`initiator=external`。没有这条规则时默认拒绝，普通 `reply` 权限不会隐式获得偏好写入权。

日常使用无需发送命令：普通 owner 文本只有在 Agent turn 完成、session 已 flush 且 exact reply Outbox durable enqueue 后，才会发布 content-free `response.language` behavioral observation。分类器只输出固定的 `zh-CN` / `en`，对短文本、代码块、URL 和混合语言会 abstain；正文和模型输出不会进入学习 event。整条短消息精确匹配“以后简短一点 / 以后用中文回答 / 今后少用列表”等持续偏好闭集（及固定英文等价）时发布 `explicit-selection`；“请用中文回答”等本轮指令不会固化，也不会贡献相反的语言证据。多行、引用、代码、长文本或仅包含短语都不会触发。下游仍须独立执行阈值、TTL、scope、CAS 与回滚门槛。

`/learning` 使用字节精确的闭集语法：`status`、`explain`、`export`、`pause`、`resume`、`rollback <exact-T1-catalog-key> confirm`、`forget confirm`。token 之间只接受一个 ASCII 空格，不做 trim 或 Unicode 空白归一化；单独发送 `forget` 只显示确认提示，不删除；命令不接受附件。`explain` 只返回 exact owner + lineage 的 catalog key/value、effect state、version 和 evidence counts；`export` 复用同一 owner/binding/lineage/admission fence 和 receipt-backed 读取，但由 Delivery 严格校验结构化 receipt 后自行生成 `dsh-preference-learning` v1 JSON。JSON 只含 current-scope T1 key/value/state/version/evidence counts，按 key/value 稳定排序，不含正文、workspace 绝对路径、principal/lineage/generation/session/event/Inbox/Outbox/cursor/idempotency/exposure，也不写文件。两种读取都不调用模型、不推进 admission high-water；相同 Inbox 重放会返回持久保存的原快照。`pause` 持久阻断新证据、T1 激活与 prompt 注入但保留已有记录；`resume` 只接受恢复命令之后收到的新事件，暂停期间已排队的 projection 会被 ACK 丢弃而不会复活；`rollback` 只 CAS 回滚该 key 当前 active T1，无 active 时是准确 no-op，两者都推进 cutoff 防止较旧 projection 复活；`forget confirm` 物理删除该 scope 的信号、假设、transition、exposure 以及较旧 status/pause/explain/export/rollback 快照，并保留最小 cutoff 防止旧 durable projection 重放。控制回执与 mutation 在同一事务提交，响应丢失或重启后以同一幂等键重放原结果。状态回复独立显示管理员 enabled gate、owner pause gate、已存 active overlays 和当前 effective overlays。

需要 resume 的命令遇到已知的持久化格式不兼容、事件类型缺失或日志损坏时，只返回有界诊断码与恢复建议，不回显 prompt/历史，也不删除原 session；可在修复对应 DSH 插件后重试，或用 `/new` 开始空白会话。

`/stop` 与 `/new` 的 cancel-and-drain 强保证目前只覆盖同一 Host 进程；在该边界内，`/new` 的 generation rotation 与命令 Inbox 已原子提交，后到消息不会夹入旧 generation。共享 SQLite 的多 Host 部署可持久 fence 尚未 dispatch 的较早 Inbox，但还没有跨 Host cancel channel，已在另一 Host dispatch 的 turn 不保证立即停止；本包不宣称跨 Host 全局 exactly-once 停止/换代。

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

卡片提交后，Delivery 会再次核对 active binding、精确 principal/chat、原始 provider message id 和 Policy，并用实时 `resolveModelInfo()` 验证 provider/model 及该模型支持的 effort；通过后把三项选择按 canonical conversation 持久化到 Delivery SQLite。渠道可以等待该 durable settlement：同实例由完成通知即时唤醒，共享数据库的另一实例完成时由有界轮询感知，从而把原卡更新成不可交互的最终结果。选择从下一条普通消息生效，保留当前 session 上下文，跨 `/new` 和 Host 重启仍有效。卡片可选择“默认（由模型决定）”；`/model use` 保留为无卡片渠道和排错时的文字后备，`/model reset` 删除会话覆盖并恢复 `agentProvider` / `agentModel`。模型目录按宿主约定是建议性的，最终调用是否成功仍由对应 adapter 和账号认证决定。若某个已持久化的显式 effort 在下一条普通消息前被 DSH 核心判为不支持，Delivery 会在任何 prompt 或 durable dispatch 标记之前，以 version CAS 仅清除该 effort、重新预检同一 provider/model 的默认档位；CAS 冲突会重试而不会覆盖更晚的 `/model` 选择。模型不会被静默替换，也不会重放或重复计费。

`/permissions`（别名 `/permission`）只允许当前 active binding 的精确 owner 使用，命令本身不会进入 Agent 或触发 LLM。支持 typed `permission-picker` 的私聊渠道会显示“请求批准（ask）/帮我批准（auto）/完全访问权限（full）”三档卡片并标出当前档位；不支持卡片或渲染失败时自动退回含同等信息的文字命令。前两档都使用 `workspace-write + ask`，区别是持久 reviewer 为 `user` 或 `auto-review`。`full` 使用 `danger-full-access + never + none`，可访问网络及任意文件；卡片按钮带原生风险确认，文字入口则由 `/permission full` 显示橙色警告，必须再次发送 `/permission full confirm` 才切换。

权限卡片作为受限 Outbox intent 持久化，并用独立 HMAC 域绑定原始 route、精确 owner、binding version、session、权限状态指纹、Policy 紧急停止版本、目标档位和有效期。点击时还必须匹配原卡的 provider message id，并重新核对 active owner/binding、DM、Policy 与 session；转发、错人、跨 chat、篡改、过期、`/new` 后的旧卡，以及权限状态或紧急停止版本变化后的旧卡都会明确提示失效。最终提交在权限 mutation 前、reviewer 等待后和 session flush 后重复核对紧急停止版本，因此紧急停止开→关的 ABA 也只会触发 ask 补偿，不会完成旧卡提权。同一张卡的第一次选择进入原 binding 的 durable Inbox 串行队列；点击 Toast 只表示“已受理”，真正切换成功会另发持久回复。平台重投同一选择幂等，相反选择冲突而不会晚到覆盖；需要再次切档时应重新发送 `/permissions`。

原生 DSH 设置与 Web 权限面板会写 preset、sandbox 和 approval。生产表的 `workspace-write` / `auto` / `danger-full-access` 已由 AssistantPolicy 直接解释为 `user` / `auto-review` / `none`，所以 Web 与 Delivery 可互相切档且后写者获胜，不再为 canonical 三档补 custom reviewer。只有单 workspace preset、动态 id 和旧 session 继续使用兼容 reviewer event；非 canonical legacy full 仍经过严格迁移与 flush barrier。

旧版本中，这个缺口会产生一个很迷惑的症状：session 看似已经是 native full，但 reviewer 缺失会保守折叠成 `user`，AssistantPolicy 因而把未知/敏感工具送去 `ask-review`；同一 session 的 `approval=never` 又会在渠道审批展示前直接拒绝，上游最终误写成 `"the user rejected tool"`，所以用户既没看到弹窗也没有机会批准。迁移后精确 full 会持久补齐 `reviewer=none`；同时进度适配器会把嵌套 `tool-result.isError=true` 显示为工具失败，而不是继续显示“已完成”。

档位从 `ctx.permissionPresets.resolve()` 动态匹配：一个 `workspace-write + ask` 候选兼容旧版共享 ask/auto，两个候选按声明顺序映射 ask/auto，更多候选或多个 full 候选会失败关闭；full 候选必须唯一。目标表指纹也进入权限卡状态哈希，防止卡片发出后配置漂移。命令会显式固化 sandbox/approval；canonical 三档写官方 preset，动态/共享目标只在必要时写兼容 reviewer。mutation、flush、controller 或回复失败后会收敛并持久化到 ask；只有确认 ask 已 durable 且终态回复已经进入同一 Outbox，Inbox 才能结束，不会用“持久化结果不确定”冒充终态。

权限命令在第一次 reviewer/policy/sandbox mutation 前还必须先取得 Inbox 的 durable dispatch/recovery marker；每个异步边界后都复核 abort 与租约。若进程退出、续租失败、flush 未确认、依赖尚未就绪或回复入队失败，该 marker 会绕过普通 `maxAttempts`，在原 binding 串行 lane 中继续恢复，直到确认已持久化目标并补发成功终态，或安全收敛到 ask 后补发失败/取消终态。`/stop` 和 `/new` 会在 abort 前把正在执行的权限命令原子改标为 cancelled recovery；旧命令不会以 `processor-ambiguous` 终止，也不会从原始文本重新制造一次可能已取消的 full 提权。

普通消息真正 resume Agent 时，Delivery 先解析并挂载 binding 固定的 preset，再把该 Agent 的最终 scoped tool schemas 原样交给当前 provider/model。工具和 Skills 属于 Agent/preset，模型切换不会改变它们的可见集合，Delivery 也不维护 provider 工具白名单或部署侧能力名单。协议元数据缺失、`native` 和 `bridge` 都会放行；只有 adapter 主动声明 `toolCalls: none` 且最终 scope 非空时，才会在 prompt 发送前因“未实现统一 DSH tool-call 协议”失败关闭。这个检查描述 adapter 的传输实现，不是模型权限或能力分级；实际工具执行仍逐次经过 ToolRuntime、Policy、sandbox、审批、身份与预算检查。fresh session 创建本身不执行模型，仍可先持久建立 binding。

只注册两个模型工具：

- `delivery_reply`：只能回复当前 Agent session 已验证的 binding，不能传 channel/account/chat/user。
- `delivery_status`：只返回有界 id/status/time/failureCode，不返回正文、route 或 secret。

普通 Agent 回复、Automation 结果和未来 Heartbeat 都必须 enqueue 到同一 Outbox。相同 `idempotencyKey` + 相同不可变 intent 返回同一行；同 key 改正文或 route 会冲突。

延迟审批由 domain 先通过 `prepareAgentApproval()` 从当前 Agent 的 active owner binding 派生不可伪造的 source/binding/workspace/principal route，再把该 route 随 Policy proposal 持久化；background Agent 可由可信 runner 使用 `bindAgentApprovalRoute()` 临时绑定 automation definition 中的 immutable `deliveryBindingId`，该绑定不会注册为模型工具。Delivery 在同一 owner 事务内从 active binding 派生 canonical external `principalId`，并把它固定到私有 workflow template content/digest；Host resolver 在返回 prompt 前会再次核对 exact binding version/generation 与 principal。该 principal 不进入 Growth trace 或 Growth 数据库。Delivery tick 会在发送前领取 Policy dispatch，以 `approval-card:<proposalId>` / `approval:<proposalId>` 写入同一 Outbox，再用 CAS 标记已入队；若进程在两步之间退出，重放仍命中同一 intent。schema v6 另以带版本 fence 的持久 `(createdAt, proposalId)` 高水位分页扫描 pending dispatch：无效 route 不会被伪标为已入队，但也不能用一个 poison page 永久饿死后续审批；扫描到尾后回绕重试这些条目，Host 重启与并发 scanner 都不会倒退覆盖新游标。

Policy 的 `approved` 只表示 owner 决定，不表示领域变更已经应用。schema v10 的 Host-only
presentation publisher 由 Delivery 只向当前 Evolution 或 Automations 实例签发、可撤销的进程内 capability；它不是
公开 service API，也不能由普通调用方伪造。该 capability 接收领域结算或 Automation incident 生成的单调版本 typed
projection，持久等待原 Outbox 真正取得 provider message id，再通过 adapter 原位替换同一条消息。
只有带 exact rule id/version/status 的 `applied` 可以显示为已生效；`conflicted`、`expired`、
`rejected` 各自保留独立终态。更新采用 lease、fencing token、payload digest 与重启重试；新 revision
会压过旧 provider completion，撤权或原消息永久失败则明确进入 dead，而不会把“已入队”误当成“已展示”。
临时 adapter/provider 更新失败不消耗普通 Outbox 的 `maxAttempts`，会持续退避恢复；只有原消息已不可变 dead
或 authority/owner route 被撤销才终止该 presentation。

Automation incident 使用 `automation-incident:<incidentId>:g<generation>` 同时作为 presentation 与原始 Outbox identity。同 generation 的 open/detail/recovering/resolved revision 会在发送前合并到最新期望；原消息处于 attempting 或 unknown 且没有 provider id 时只等待，不猜测发送结果。取得 provider id 后，每次更新都重新验证原始 owner-route receipt、当前 authority/generation/owner 和 exact Policy；暂时检查失败或 provider update 异常会退避重试，Host 重启和失去 fence 后仍可恢复。generation+1 使用新 identity，因此真正 reopen 会创建新消息。损坏的 presentation 行会原位隔离，不能饿死后续生命周期。

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
- schema v9 为每次 operator `cancel|retry` 写入不可变的 `dead_letter_resolutions` receipt，精确绑定 `kind + message id + attempt_count`、原状态/故障码、必填 operator 和 receipt version；消息与 attempt 审计行不会被删除。控制面返回 `{record, receipt, replayed}`，响应丢失后同一 operator 重放同一决定会在重新通过当前 Policy 后幂等返回，换 operator 或相反决定冲突；其中 receipt 指向被结算的旧 exact attempt，record 是重放时的当前消息投影，可能已经进入下一 attempt 或外部 receipt 终态。`retry` receipt 只结算旧 attempt，下一次 claim 会增加 `attempt_count`，若再次失败会重新成为 actionable。
- v8→v9 会为旧版仅以 `operator-cancelled` 标记的结算回填 legacy receipt，并从 exact attempt 恢复旧 unknown 的 ambiguous 状态。actor 无法恢复，因此明确使用 `legacy-v8-migration` sentinel；被覆盖前故障码优先从同 message + attempt number 的 attempt history 精确恢复，历史缺失或没有 failure code 时写入字面值 `legacy-unknown`，不把缺失伪装成可归责事实。迁移后数据库 trigger 要求所有新的 resolution UPDATE 先有同事务、同原状态/故障快照的 v9 receipt；因此迁移前已打开的 v8 writer 会安全失败，不能绕过 operator identity 或重新领取已取消的 unknown。共享数据库滚动部署应先排空旧 writer，旧实例出现该 fence 错误后由 v9 控制面重做明确决策。
- `health().deadLetterInbox/deadLetterOutbox/unknownOutbox` 保留为历史 terminal 行总数以兼容旧消费者；告警与健康聚合应使用 `actionableDeadLetterInbox/actionableDeadLetterOutbox/actionableUnknownOutbox`。对应 `resolved*` 字段统计当前 exact attempt 已有 cancel tombstone 的行，因此 operator 已处理的历史不会让系统永久 degraded。
- `unknown_after_send` cancel 后仍保留为独立的 ambiguous 状态和原始 resolution receipt，不伪装成确定未发送；该 exact attempt 不会再被自动 reconcile/send，并视为 lane terminal，cancel receipt 也不能改写成 retry。若平台随后给出匹配 provider message id 的 delivered/read receipt，外部事实可单调提升当前状态并清除当前失败标记，原 cancel/attempt ledger 仍保留。普通尚未结算的 unknown 只能由显式、Policy-gated operator `retry` 重新入队；稳定 owner route 禁止 retry，只能原 lineage reconcile/cancel/park。系统从不自动重发 unknown send。
- Agent dispatch 前写 `dispatch-started` marker。此后进程崩溃会进入 `dispatch-ambiguous` dead letter，避免自动产生第二个 turn；这会牺牲一次自动重放，需要 owner 审阅后显式 retry。
- `/permission` 是受限例外：它使用专用 commit/cancel/failure recovery marker，并以精确 Inbox id（兼容旧 event id）与 `replyToEventId` 共同证明终态 Outbox；崩溃恢复不会把普通 background Outbox 或同名伪造 key 当成完成见证。
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
