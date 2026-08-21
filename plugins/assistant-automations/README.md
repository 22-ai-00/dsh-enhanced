# @dsh-enhanced/assistant-automations

面向个人助理的单机、冷启动可恢复调度器。它把 automation 定义、稳定 occurrence、task、attempt、run 和 duty lease 写入 SQLite；进程重启后从账本继续，而不是把内存 timer 当作事实源。每次执行创建一个新的 DSH rc.8 Agent，固定 workspace、preset 身份、provider/model、输出预算、工具白名单和工具调用上限。

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
    budgets: []
- id: dsh-enhanced-assistant-automations
  name: '@dsh-enhanced/assistant-automations'
  config:
    databasePath: !!js dshHomePath('assistant-automations/state.sqlite')
    runsPath: !!js dshHomePath('assistant-automations/runs')
    schedulerEnabled: true
```

生产使用还必须由 systemd、launchd、Docker restart policy 或等价 supervisor 拉起 DSH。插件能恢复停机期间的账本状态，但不能在宿主进程没有运行时主动执行。

## 工具与审批

- `automation_create`：提交完整 immutable automation 提案；不会直接创建。
- `automation_list`：只读、有限输出；不回显 prompt、principal、数据库路径或运行目录。
- `automation_manage`：以 `expected_version` CAS 提交 pause/resume/delete 提案。
- `automation_run`：创建幂等 manual occurrence，并强制 `dryRun: true`、空工具白名单、无 delivery。
- `automation_history`：读取有限 occurrence/run 摘要，不暴露 artifact 的宿主绝对路径。

模型发起的 create/pause/resume/delete 全部走 `assistant-policy`。本地数据库保存完整目标快照，policy 只保存摘要与 diff hash；可信通道或 UI 再调用 `ctx.assistantAutomations.decideProposal(...)`。提案绑定 principal、TTL、版本和幂等键；批准时会重新检查 lifecycle version，过期或并发变化进入 `expired`/`conflicted`，不会覆盖新状态。

支持严格五字段 cron、IANA timezone、一次性 `at` 和 anchored `every`。`skip`、`latest`、`bounded-replay` 明确处理 misfire；catch-up 有硬上限。cron 在 DST 春季缺口自然跳过不存在的本地时间，在秋季重叠会产生两个不同 UTC occurrence。

## 可靠性语义

SQLite occurrence id 由 automation、trigger 类型和 scheduledAt/eventId 稳定派生并唯一约束。task 只在短事务中 claim；全局 duty lease 使用单调 fencing token，旧 owner 无法 heartbeat 或提交新 owner 的结果。过期但尚未启动的 `claimed` task 可安全重排；已经 `running` 的 task 默认变成 `unknown`。只有 immutable definition 明确声明 `retrySafety: idempotent` 且还有 retry 配额时，才会自动重排。

这不等于“外部副作用 exactly once”。模型可能已经调用外部工具，而进程在 run commit 前崩溃；默认的 `unknown` 正是对这段不可判定窗口的诚实记录。`overlap` 支持 `skip`、`queue-one` 和 `cancel-previous`，取消是请求而不是远端副作用回滚保证。

完整 JSON artifact 先通过同目录临时文件、fsync、atomic rename 写入，再提交 terminal run；SQLite 只保存有限 preview 和相对 artifact ref。execution 与 delivery 是两个状态域：若可选的 `assistant-delivery` 存在，带固定 `deliveryBindingId` 的成功 run 会以 `automation:<occurrenceId>:<bindingId>` 幂等写入它的 outbox；投递失败不会把成功 execution 改写成失败，后续 tick 只重试同一 enqueue。定义还可带有界的 `deliverySuppressExact`；空输出或精确匹配值会在同一账本中进入 terminal `suppressed`，不会送到 Delivery。该字段必须同时绑定 `deliveryBindingId`，Heartbeat 用它抑制 `HEARTBEAT_OK`。

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

## 权限与数据

- 文件系统：只读写显式 `databasePath`、SQLite WAL/SHM 和 `runsPath`；目录 `0700`，数据库/artifact `0600`。automation 的 workspace 只作为 DSH session 身份，本插件不自行扫描工作区。
- 网络：插件不直接发网络请求；它会通过宿主 DSH LLM provider 调用已批准的模型。被白名单允许的工具可能拥有自己的网络权限。
- 消息投递：`assistant-delivery` 是可选 peer；只有 automation 固定了 `deliveryBindingId` 且后台 send 策略允许时才会 enqueue。该服务不存在时，run 保持 `deliveryStatus: pending`，完整结果仍可从本地 artifact 获取。
- 子进程、凭据、浏览器、安装脚本：本插件自身无。白名单工具的独立权限仍然生效，assistant-policy 只能进一步拒绝，不能替代 OS/container 隔离。
- 模型成本：每个 occurrence 可产生一个或多个 LLM step。可选 `budgetId`/`budgetAmount` 会在 Agent 创建前预留 policy budget；出现可能已有副作用的歧义窗口时不会乐观释放。
- 保留与备份：删除 run artifacts 不改变账本，但会失去完整输出；备份时一致性复制 SQLite（含 WAL）和 runs 目录。prompt、输出与 usage 可能含私人信息。

## 范围边界

P0 是单机 scheduler，不支持共享网络文件系统、多主共识、DAG、任意 shell sensor、heartbeat、webhook/file watch、自己实现消息 transport、浏览器或 ingest。官方 DSH session-local schedule 也没有被复制为第二套 daemon；timer 只唤醒本协调器。

## 兼容性

已针对 DeepSeek Harness `0.1.0-rc.8`（源码提交 `141eb6fef83422698aef7a981029e843e8161534`）验证。详见仓库[兼容性基线](../../docs/compatibility.md)。
