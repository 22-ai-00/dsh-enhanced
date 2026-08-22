# @dsh-enhanced/assistant-delivery

`assistant-delivery` 是个人助理唯一的、与厂商无关的消息核心。它把外部身份、一次性配对、conversation→DSH session 绑定、持久 Inbox/Outbox、adapter 生命周期、receipt、重试、对账和 dead letter 放在一个可审计边界内；飞书、Telegram 等包只实现协议适配。

本包不声明 exactly-once。它保证发送前先持久化 intent；若平台可能已经接收但响应丢失，则保留 `unknown_after_send`，只走 adapter 对账或显式 operator 决策，不盲目重发。

## 兼容性与安装顺序

- DSH / Agent / LLM / Session：`>=0.1.0-rc.8 <0.2.0`
- Cordis：`^4.0.1`
- `@dsh-enhanced/assistant-policy`：`>=0.1.0 <0.2.0`，硬依赖
- 真实多轮恢复还要求 profile 已配置官方 `ctx.sessionPersistence` provider；缺失时新建空 session 可以成功，但冷 resume 会进入有界失败/死信路径。

```sh
dsh plugin --profile headless add @dsh-enhanced/assistant-policy
dsh plugin --profile headless add @dsh-enhanced/assistant-delivery
dsh --profile headless --dump-config
```

Patch 通过 `inject: [assistantPolicy]` 固定加载依赖。`schedulerEnabled` 默认开启，因此生产环境必须由 launchd、systemd 或 Docker restart policy 监管 DSH 进程。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `databasePath` | `$DSH_HOME/assistant-delivery/state.sqlite` | 私有 SQLite 权威账本，必须为绝对路径 |
| `spoolPath` | `$DSH_HOME/assistant-delivery/spool` | 预留的私有附件隔离目录，必须为绝对路径 |
| `schedulerEnabled` | `true` | 启用 Inbox/Outbox 后台 pump |
| `tickIntervalMs` | `1000` | pump 周期 |
| `leaseMs` | `30000` | 单次 Inbox/Outbox/模型确认 claim 租约，也是模型确认实时解析的 deadline |
| `maxAttempts` | `5` | 可证明未产生副作用的最大尝试数；未知发送不自动转 dead |
| `maxConcurrency` | `4` | 跨 binding 并发数；同一 binding 始终串行 |
| `maxTextBytes` | `65536` | 单条入站/出站正文 UTF-8 上限 |
| `retryBaseMs` / `retryMaxMs` | `1000` / `300000` | 指数退避边界；adapter 的 Retry-After 是下限 |
| `pairingTtlMs` / `pairingMaxAttempts` | `600000` / `5` | 一次性本地配对时效与尝试上限 |
| `defaultWorkspace` | `$DSH_HOME/assistant-workspace` | owner DM 新 session 的绝对工作区 |
| `defaultAgentPreset` | `standard` | 新 session 使用的 preset；该内置 preset 提供 Bash、文件、检索、Skills 等完整编码能力 |
| `policyRef` | `owner-dm` | 固化在 binding 上的策略引用标签 |
| `agentProvider` / `agentModel` | `deepseek-official` / `deepseek-v4-flash` | 渠道 Agent 的部署默认模型；会话可用 `/model` 覆盖 |
| `agentMaxOutputTokens` | `8192` | 单轮模型输出上限 |
| `modelPickerTtlMs` | `900000` | `/model` 选择卡片的签名提交有效期；范围 1 分钟至 24 小时 |

所有可变部署值都经过 Schemastery 校验。SQLite 使用 `WAL`、`synchronous=FULL`、foreign keys、busy timeout 和 forward-only schema；目录/数据库权限分别收窄为 `0700` / `0600`，未来 schema 会拒绝打开。

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
    subject: { kind: agent, id: primary, workspace: "/absolute/workspace" }
    actions: [reply]
    resource: { kind: message, id: "*" }
    context: { initiators: [external] }
  - id: one-automation-send
    effect: allow
    subject: { kind: background, id: daily-review, workspace: "/absolute/workspace" }
    actions: [approval.send, send]
    resource: { kind: message, id: "binding_*" }
    context: { initiators: [background] }
```

`issuePairing()`、`linkPrincipal()`、`resolveDeadLetter()` 是可信本地控制面 API，不注册为模型工具。配对 code 只返回一次，数据库只保存随机 salt 的 scrypt hash；空 allowlist 不会把第一位来信者设成 owner。跨平台 principal 必须分别配对后再由 owner 显式 link。

`pairPrincipalLocally()` 是给安装向导使用的更窄离线入口：调用方必须已经拥有私有 Delivery SQLite 的本机文件权限，并提供完整 typed principal；函数内部仍走一次 challenge/confirm 事务，只返回 principal 记录，不返回 code。`lark-channel` 向导先用一次性 DM 短语确认具体 `open_id`，再调用该入口；普通 Agent、外部消息和后台任务都无法访问它。

## Adapter contract

渠道包通过 `ctx.assistantDelivery.registerAdapter()` 注册精确的 `(channel, account)`：

- `start({ accept, receipt })` 必须等 `accept()` 成功返回后才 ack/cursor；此时 event 已经持久化。
- `send(intent, signal)` 只能返回 `accepted`、可证明 `not-sent` 或 `unknown`。HTTP 200/平台 request accepted 只叫 `accepted`，不能伪装成 delivered/read。
- 429/明确 5xx 未发送应给出 `retryable` 与可选 `retryAfterMs`；永久 4xx 进入 dead。
- 请求可能已到平台但 response 丢失时返回 `unknown`。若声明 `reconcileUnknownSend` capability，必须实现对账；否则记录保持 `unknown_after_send`。
- receipt 必须带同一个 channel、account、provider message id；状态只允许单调 `accepted→delivered→read`。
- adapter 的 socket、timer、SDK client 和 listener 必须由 `start()` disposer 释放。

内部身份始终是结构化的 `ExternalPrincipalKey`、`ConversationRef` 与 `ConversationBinding`，不会从 `platform:chat:thread` 字符串反解析路由。DM 不允许 thread；当前 group 入口要求显式 thread，从而避免所有群成员共享主 session。

## Agent 与工具

获批入站正文以 user-role message 写入 DSH，source 固定包含：

```json
{ "kind": "delivery", "channel": "lark", "account": "my-bot", "eventId": "...", "trust": "untrusted" }
```

真实 principal、tenant、token 不注入 prompt。每个 binding 的 session id 由 conversation + generation 确定生成；`/new` 新建下一 generation 并保留旧 session。lookup/create 进程内 single-flight，SQLite unique constraint 是最终冲突边界。

渠道控制命令在进入 Agent 前处理，因此默认模型未安装或临时不可用时，仍可自助恢复：

```text
/model
/model use codex-subscription/default
/model reset
```

`/model` 从宿主 `ctx.llm` 的实时 provider/model 目录生成受限的 typed `model-picker` intent，不发起模型生成；每个模型会显式关联它自己的 `effortIds`，而不是共享全局 effort 并集。支持它的渠道可以据此显示“分组、模型、effort”三级联动选择和确认按钮，不支持它的渠道会把该 intent 明确拒绝而不会降级为任意卡片 JSON。持久 selection 会先投影为不含 `updatedAt/version` 的纯路由再进入严格 intent 边界；如果目录中的异常数据仍使卡片校验失败，系统会立即退回完整纯文本目录，确定性校验错误不会重试。某个 provider 或模型能力解析失败不影响其他项，最多载入 20 个 provider、50 个模型、每模型 20 档 effort，并且全目录最多 20 个不同 effort id。

卡片提交后，Delivery 会再次核对 active binding、精确 principal/chat 和 Policy，并用实时 `resolveModelInfo()` 验证 provider/model 及该模型支持的 effort；通过后把三项选择按 canonical conversation 持久化到 Delivery SQLite。选择从下一条普通消息生效，保留当前 session 上下文，跨 `/new` 和 Host 重启仍有效。卡片可选择“默认（由模型决定）”；`/model use` 保留为无卡片渠道和排错时的文字后备，`/model reset` 删除会话覆盖并恢复 `agentProvider` / `agentModel`。模型目录按宿主约定是建议性的，最终调用是否成功仍由对应 adapter 和账号认证决定。

只注册两个模型工具：

- `delivery_reply`：只能回复当前 Agent session 已验证的 binding，不能传 channel/account/chat/user。
- `delivery_status`：只返回有界 id/status/time/failureCode，不返回正文、route 或 secret。

普通 Agent 回复、Automation 结果和未来 Heartbeat 都必须 enqueue 到同一 Outbox。相同 `idempotencyKey` + 相同不可变 intent 返回同一行；同 key 改正文或 route 会冲突。

延迟审批使用 `enqueueApproval()` 写入同一 Outbox，intent 只允许固定的 operation/proposal/version/expiry/title 字段。渠道签名后的点击仍必须回到 `settleApproval()`；它重新核对 active binding、principal、chat、proposal version 和 operation id，重复点击只会得到同一持久化结果。

模型选择同样不开放任意渠道 payload。`model-picker` intent 只允许有界的 provider/model/effort 目录和有效的 model→effort 引用；目录与 operation 一起保存在 Outbox，渠道可在 Host 重启后按 operation 恢复同一份选择目录。schema v5 另外保存每个 operation 的选择 revision 和确认结算：渠道联动回调通过 CAS 前进，旧 revision 只能读取当前状态；确认先持久领取 operation，带租约和 fencing token 的 worker 在启动与 tick 时恢复未完成任务，并在实时模型解析后重新校验 active principal、binding 与 Policy。最终模型选择、结算结果与确认 Outbox 在同一事务中提交，因此重启、慢解析与重复回调不会重复应用选择。

## 故障语义

- Inbox：`received→authorized→queued→claimed→processed|retry_wait|dead_letter`。
- Outbox：`pending→attempting→accepted→delivered→read`，另有 `retry_wait`、`dead`、`unknown_after_send`。
- attempt 与 receipt 都是独立追加账本；不同 binding 可并行，同一 binding 保序。
- claim/complete 带 owner + fencing token；过期 worker 不能提交新 owner 的结果。
- Agent dispatch 前写 `dispatch-started` marker。此后进程崩溃会进入 `dispatch-ambiguous` dead letter，避免自动产生第二个 turn；这会牺牲一次自动重放，需要 owner 审阅后显式 retry。
- 当前 rc.8 `followup()` 没有跨进程 `sourceEventId` 唯一接纳/完成 handle，因此本包诚实承诺“持久 event 去重 + at-most-once 自动 Agent dispatch”，不声称端到端 exactly-once。若宿主未来提供该 seam，可升级为安全的 at-least-once wake。
- Outbox adapter 抛异常一律视为可能已发送；不会按照普通 5xx 重试。

## 权限与数据边界

- **文件系统：**读写配置的 SQLite 与私有 spool 目录；不读任意 workspace 文件。
- **网络：**本包自身无网络访问；网络权限属于注册的渠道 adapter。
- **进程/浏览器：**无 subprocess、shell 或 browser 权限。
- **凭据：**不接收、存储或输出 provider token；adapter 必须通过 SecretRef/后续 credentials service 获取。
- **数据：**Inbox/Outbox 会保存消息正文、外部 identity 和 route，属于 PII。入站附件只登记最多 10 个受限 provider descriptor，状态固定为 `metadata`，不会自动下载；工具与 Policy audit 只暴露状态或 hash。当前版本不自动清理历史，请依部署的数据保留策略备份/轮换私有数据库。

## 当前非目标

- 多主机分布式 worker、跨平台自动合并、群聊共享主 session、广播、presence/read SLA。
- 附件 payload 下载、病毒扫描与 multipart 可靠发送；当前仅实现 durable metadata quarantine，二进制能力必须另行授权和验收。
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
