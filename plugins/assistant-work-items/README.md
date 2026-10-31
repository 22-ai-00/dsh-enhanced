# @dsh-enhanced/assistant-work-items

把外部信号沉淀为**有界、可恢复、可审计**的工作项账本，并用一次原生 automation occurrence 驱动 agent 认领、汇报和 owner 通知。本插件不创建第二套 agent loop、timer、outbox、预算系统、设置面板或 session store：调度复用 `assistant-automations` 的稳定 occurrence，执行复用原生 DSH Agent run，通知复用 `assistant-delivery.enqueueBackground()`，授权复用 `assistant-policy` 的默认拒绝。

首个可工作的切片只提供内部账本和三条 CAS 工具：`work_item_claim`、`work_item_report`、`work_item_status`。它故意不内置任何真实外部来源（GitHub、邮件、IM 等）；外部来源应作为后续独立插件，通过可信 Host API `admit(...)` 提交信号。

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
allowed_tools: [work_item_claim, work_item_report, work_item_status]
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
      allowedKinds: [review, triage]
```

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

  # ② 允许 worker Agent 调用本插件的 CAS 工具（tool guard 默认拒绝）
  - id: allow-work-item-tools
    effect: allow
    subject: { kind: agent, id: primary, workspace: /absolute/workspace }
    actions: [execute]
    resource: { kind: tool, id: "work_item_*" }
    context: { initiators: [background] }

  # ③ 允许本插件经 Delivery 向固定 owner route 发通知
  - id: allow-work-item-owner-notify
    effect: allow
    subject: { kind: background, id: work-items/v1, workspace: /absolute/workspace, principal: <principal id> }
    actions: [send]
    resource: { kind: message, id: 'route:<ownerRouteId>' }
```

注意：当前 `assistant-policy` 的资源类型词汇表没有 work-item/ticket kind，因此准入授权复用 `resource: { kind: automation, id: <workerAutomationId> }`。这是契约层面的错配，不是可配选项；后续若 Policy 增加专用 kind，应同步调整实现与规则。

## 工具

三条工具都要求调用者是配置中的 worker automation 的 exact production occurrence；工具调用落到前台会话或非 production 运行会被拒绝。调用方 Agent 的 workspace 与 preset 还必须与 `scope` 一致，`scope.expiresAt` 过期时 claim/report/status 失败关闭。

- `work_item_claim`：按 occurrence 找到唯一绑定的工作项，用 CAS 取得 claim，返回 `itemId`、kind、title、brief、`workDir`、attempt 等。claim 没有独立续租动作：`progress` 报告会顺延租约；同一 run 的重复认领只在租约仍有效时幂等重放，租约过期则生成新的 claim 行与新的 attempt（受 `maxAttempts` 约束）。
- `work_item_report`：在活动 claim 下追加一条 append-only 报告修订（`progress` / `waiting` / `ready` / `blocked` / `failed`），可带 artifact 绝对路径；idempotency key 由 `status+summary+artifacts` 的 SHA-256 再按 item 与 claim 行限定，同一 claim 的重试返回已存修订而不重复写入，不同 claim 的同样文本则视为新修订。对已过期 claim 的报告会以 `claim-expired` 失败关闭。终态报告会触发一次 owner 通知，通知失败只记录在报告行上，不删除报告证据。
- `work_item_status`：只读返回当前 occurrence 绑定的工作项、活动 claim 和报告列表，不回显数据库路径、principal 或 Host 内部路径。

`work_item_report` 的 `summary` 有字节上限（默认 16 KiB），超长会被截断并标记 `truncated`；artifact 路径必须是绝对路径，且位于该工作项的 scratch 目录或 `scope.workspace` 之内，相对路径与 `..` 逃逸一律拒绝。校验会逐级 realpath 每个已存在的路径组件，任何逃出根目录的符号链接都会失败关闭；scratch 目录仍应由部署者保持私有。

## 生命周期与可靠性

```
外部信号 --admit--> 私有 SQLite 工作项账本
  ├─ observe: 只写 observed/dropped 行，绝不唤醒、绝不通知
  └─ active:  queued + dispatch 行
        └─ automations.ingestExternal({ sourceId: intakeSourceId, automationId: workerAutomationId, eventId: 工作项 ID })
              └─ 原生 Agent occurrence
                    ├─ work_item_claim  (CAS，租约默认 15 分钟)
                    ├─ work_item_report (append-only，终态通知)
                    └─ delivery.enqueueBackground({ bindingId: 工作项创建时的 originBindingId })
```

- 状态机：`queued / claimed / working / waiting / ready / blocked / failed / dropped`。`ready`、`blocked`、`failed`、`dropped` 为终态；`queued`、`waiting` 可被认领。
- 准入闸门顺序：enabled → 输入规范化 → owner route 校验（失败时零写入、零唤醒）→ 去重窗口重放 → kind allowlist → cooldown → 每小时准入上限 → 未结工作项上限 → observe 记录或 active 入账 + dispatch 行。active 路径还会在写库前调用一次 `assistant-policy` 的 `admit` 授权。
- 去重键 `sha256(sourceId\0kind\0externalId)` 加时间桶 UNIQUE；同一外部信号在 `dedupWindowMs` 内只入账一次，重放返回既有工作项。
- 租约到期不靠 timer 回收：admit/claim/status/list/health 以及启动恢复时惰性调用 `reclaimExpired()`；到期 claim 被显式置为 `expired` 并记事件，工作项回到 `queued`，dispatch 行同时回到 `pending` 以便 `wakePending()` 重新唤醒；超过 `maxAttempts` 的项标记 `blocked`。
- 崩溃恢复：`ingestExternal` 已成功但 dispatch 行仍 pending 时，下一次有界恢复会重新唤醒（`ingestExternal` 幂等）；唤醒失败记录在 dispatch 行上并通过 `health().dispatchUnknown` 暴露，绝不重复报告。
- SQLite 使用 `WAL`、`synchronous=FULL`、`BEGIN IMMEDIATE` 事务和 forward-only schema；`PRAGMA user_version` 只前进。升级写入边界要求单 writer：升级前停掉 DSH 进程。

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
| `delivery.notifyOn` | `[ready, blocked, failed]` | 触发 owner 通知的终态报告状态 |

所有可变部署值都经过同步 Schemastery 校验；未知字段、相对路径、文件系统根目录、`databasePath` 与 `workRoot` 重叠、过期 scope 都会失败关闭。

## 权限与数据

- 文件系统：只读写显式 `databasePath` 和 `workRoot`；目录 `0700`，数据库文件 `0600`，拒绝 leaf symlink。artifact 只能落在工作项自己的 scratch 目录内。
- 网络：插件自身不发网络请求。模型/工具调用发生在 `assistant-automations` 创建的原生 Agent run 内，其 provider 与工具权限由宿主和 Policy 决定。
- 子进程、凭据、浏览器：无。
- 安装脚本：包内没有 postinstall 或其他生命周期脚本；`prepublishOnly` 只要求用 pnpm 发布。
- 消息投递：只有 active 模式的终态报告才会经 `assistant-delivery` 入队；observe 模式从不调用 Delivery 的写接口。Delivery 会在入队和发送前重查 owner route、binding 版本/代次、有效期和 background `send` Policy。
- 数据保留：账本保存外部 ID、标题、brief、owner 身份、报告正文和 artifact 路径，可能包含私人信息；备份时按 SQLite（含 WAL）一致性方式复制。删除 scratch 目录不影响账本，但会丢失完整 artifact。

## 限制

- 单独使用 observe 模式没有产品价值：它只积累观察行，不唤醒、不通知。observe 仍要求 `assistant-delivery` 可用，因为准入要先校验 owner route；没有 Delivery 时准入记录不会写入（失败关闭），这是当前实现的已知限制。
- 不内置真实外部来源；在来源插件出现前，只能由可信 Host 直接调用 `admit(...)`。
- 观察期记录会占用去重窗口：同一 signal 从 observe 切到 active 后，窗口内仍视为已准入；需要时等待窗口过期或换 `externalId`。
- 没有评估、学习或采用反馈回路；工作项终态只是运维证据，不代表任务质量。
- `stats().openItems` 与 `health().openItems` 只统计 `queued/claimed/working/waiting`，不含仍需人处理的 `ready/blocked` 终态项。
- 精确定时仍属于 `assistant-automations`；本插件不自带 schedule、timer 或 retry daemon。

## 兼容性

以 DeepSeek Harness `0.1.2-rc.1` 的服务与工具契约验证。依赖 `node:sqlite`（Node.js 22+ 内置），不兼容 Node.js 20 及更早版本。
