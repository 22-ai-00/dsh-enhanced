# @dsh-enhanced/preference-learning

面向个人助理的有界偏好学习。插件把可信 Host 产生的离散信号汇总为可审计假设，并且只允许证据充分的低风险 T1 偏好进入临时、可回滚的 Agent overlay。它不会从聊天正文自由推断规则，也不会把 tentative 偏好冒充用户确认事实。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/preference-learning
dsh --profile web --dump-config
```

插件需要 `assistant-policy` 与 DSH `system-prompt`。安装 `assistant-delivery` 时会自动订阅它验证过的 `/feedback` typed event；Delivery 是可选 producer，不构成本插件的启动依赖。Profile 必须为目标 Agent 明确授权：

- `review` / `activate` / `rollback` / `snapshot`，资源 `preference:*`；
- `execute`，资源 `tool:preference_*`。

未授权时默认拒绝，跨 workspace 或 Agent preset 的假设不可见。

## 风险模型

风险等级和值来自只读 Host catalog，调用者不能提交自由文本或自报风险等级：

- T0：只记录结构化观测，不生成行为假设；
- T1：格式、语言、详略、建议频率和推荐排序等本地可逆偏好；先处于 `shadow`，证据达标后才可激活；
- T2：长期记忆、自动通知、外部承诺、数据边界和预算策略；仅形成 `proposed + inactive`，本插件不能激活；
- T3：审批边界、凭据、安全风险目录和破坏性默认值；拒绝记录为偏好证据。

`actorTrust`（谁给出的信号）与 `interpretationTrust`（如何解释信号）分别保存。`tentative + active` 仍然不是 `confirmed`；本插件没有确认或写入 Memory 的 API。

## 信号接入

owner 反馈只接受 `assistant-delivery` 的 `/feedback` 命令。Delivery 会先验证 exact active binding、Inbox/envelope、active owner、inbound/reply Policy 和 durable dispatch fence，再取得 exact external owner 的 `signal` / `preference:<preset>/<catalog-key>` Policy 授权，最后调用本插件私有注册的唯一 batch sink。该 sink 在一个 SQLite 事务内提交整批信号并返回逐项 durable receipt；`preference-learning` 没有任何公开方法可自报 `owner-authenticated`、`direct-owner-feedback` 或跨 scope owner 证据。

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

服务固定赋予这类输入 `system-attested`，且只接受 `behavioral-inference` / `model-inference` 与非 owner 来源。它们可形成 shadow 供审计，但不能激活或回滚偏好。原始幂等键按 producer lane 做域隔离哈希，聊天正文不进入账本。

模型可见工具只有：

- `preference_review`：读取当前 Agent scope 的有界假设；
- `preference_activate`：用 `hypothesis_id + expected_version` 激活证据达标的 T1；
- `preference_rollback`：用 `hypothesis_id + expected_version` 请求移除 shadow/active 假设；审计原因由 Host 固定，模型不能声称“owner 已拒绝”或伪造回归。

每个 Agent 实例最多尝试一次偏好变更。未验证身份、行为推断或模型推断可以形成 shadow，但无论累计多少，都不能满足自动激活门槛，也不能自动回滚已激活偏好。只有经过 Delivery 验证的 owner typed feedback 参与 effect 决策；最新一次 owner 明确选择优先于旧信号，改变选择会先撤掉旧 effect，新候选仍需独立达到激活门槛。

激活后的 prompt 由固定 catalog renderer 生成，当前请求始终优先。插件使用 DSH dynamic runtime context，在每个模型步骤重新读取 exact Agent scope，并由 AgentLoop 替换上一份快照。owner 更正、TTL 到期、显式回滚、forget、禁用/卸载和 session resume 都不会留下永久历史指令；下一步会得到新快照或明确清除旧快照。`overlayForAgent()` 是其他 Host prompt composer 的同一有界接入面。

## 配置

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `enabled` | `true` | `false` 时停止收集、激活和注入；仍可审计、回滚和执行 Host forget |
| `databasePath` | Patch 设置 | 私有 SQLite 文件的绝对路径 |
| `signalTtlMs` | 90 天 | 信号衰减和保留窗口，硬上限 365 天 |
| `hypothesisTtlMs` | 30 天 | 假设 TTL，硬上限 30 天且不得大于信号窗口 |
| `minSignalsForActivation` | `2` | 激活所需最少支持信号 |
| `minConfidenceBps` | `7500` | 最低置信度（万分比） |
| `maxContradictionBps` | `2500` | 最大矛盾比例（万分比） |
| `maxActiveOverlays` | `6` | 单 scope 活跃 overlay 硬上限（最多 8） |
| `maxReviewHypotheses` | `20` | 单次审计上限（最多 50） |
| `maxOverlayBytes` | `2048` | 固定 renderer 输出硬上限 |
| `maintenanceIntervalMs` | 1 小时 | 有界清理过期 signal 的周期（1 分钟至 24 小时） |
| `maintenanceBatchSize` | `500` | 每轮物理清理的最大 signal 数（最多 5000） |

置信度使用固定 actor/interpretation 权重、时间衰减、支持/矛盾质量和证据覆盖率计算；不调用模型打分。证据或状态更新与信号写入位于同一 `BEGIN IMMEDIATE` 事务中。

## 隐私、权限与数据

- 文件系统：创建并读写 `databasePath`；目录权限为 `0700`、数据库为 `0600`，SQLite 使用 WAL、`synchronous=FULL`、`secure_delete=ON` 和外键。
- 数据内容：保存规范化绝对 workspace、Agent preset、固定 catalog key/value、信任枚举、时间和哈希标识；不保存聊天正文、自由文本解释、凭据或原始幂等键。
- 保留与删除：`signalTtlMs` 是 evidence window，也是真实 signal 保留期限；后台按有界批次物理删除过期行，极端 backlog 会跨多轮收敛。假设、状态迁移和 forget tombstone 属于审计状态，不按 signal TTL 删除。可信 Host 可调用 `forgetScope(scope, idempotencyKey)` 删除该 exact scope 的信号、假设和状态历史，只保留不可逆 scope digest tombstone，阻止旧事件重放；返回成功前还会完成并验证 WAL truncate，若读者占用导致 checkpoint busy，则以 `privacy-purge-pending` 要求按同一幂等键重试，而不虚报物理清除。没有模型可见删除工具。
- 网络、子进程、浏览器、凭据、安装脚本：无。

## 限制

owner 身份与 `/feedback` 命令由 `assistant-delivery` 负责；未安装 Delivery 时仍可记录低信任系统观测，但不会产生可自动激活的 owner 证据。T2 的批准与 Memory 持久化属于独立、审批化的后续集成。当前学习只改变固定低风险表达偏好，不改变 Policy、工具权限、凭据、预算或安全阈值。

## 兼容性

基线见仓库的 [compatibility.md](../../docs/compatibility.md)。
