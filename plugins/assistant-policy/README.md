# @dsh-enhanced/assistant-policy

个人助理的统一授权边界：默认拒绝、单调工具 guard、策略自有硬预算、持久审批提案、紧急停止和脱敏审计。后续 Memory、Wiki、Automation、Channel 与 Credential 插件只通过 `ctx.assistantPolicy` 请求授权，不应各自实现一套可绕过的规则。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh --profile web --dump-config
```

默认配置把数据库放在 `$DSH_HOME/assistant-policy/policy.sqlite`，并且 `rules` 为空。因此插件安装后会拒绝所有经过 DSH `tools.guard()` 的工具调用，直到 profile 的 `cordis.patch.yml` 明确配置 allow 规则。这是预期的 fail-closed 行为。

## 最小配置

下面只允许 `primary` preset 在指定 workspace 的前台会话读取文件；`bash` 和后台任务仍会被拒绝：

```yaml
- id: dsh-enhanced-assistant-policy
  name: '@dsh-enhanced/assistant-policy'
  config:
    databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
    proposalMaintenanceIntervalMs: 15000
    rules:
      - id: allow-primary-workspace-read
        effect: allow
        subject:
          kind: agent
          id: primary
          workspace: /absolute/path/to/workspace
        actions: [execute]
        resource:
          kind: tool
          id: read
        context:
          initiators: [foreground]
    budgets: []
```

匹配支持完整字符串中的 `*` 通配符。任意匹配的 deny 都优先于 allow；同 effect 先选更具体的规则，再按声明顺序决定。工具身份来自 rc.8 的 `Agent.session.header.agentPreset` 与绝对 `cwd`，缺少 agent、preset 或 workspace 时直接拒绝，调用方参数不能伪造这些字段。

## 硬预算

额度定义属于 policy 配置，消费者只能引用 `budgetId`，不能传入或抬高 `limit`、`periodMs`：

```yaml
rules:
  - id: allow-budgeted-background-tool
    effect: allow
    actions: [execute]
    resource: { kind: tool, id: wiki_* }
    context: { initiators: [background] }
    budget: { id: background-tool-calls, amount: 1 }
budgets:
  - id: background-tool-calls
    metric: tool-calls
    limit: 100
    periodMs: 86400000
    scope: subject
```

每次带预算的授权必须提供幂等键。策略先在 SQLite 短事务中预留，再立即计入固定收费；进程在两步之间崩溃最多造成保守占额，不会超额。同一业务操作即使跨过预算周期仍重放原 reservation，不会重复扣费；换 scope、metric、period 或 amount 继续失败关闭。可变成本消费者使用 `reserve()`，完成后调用 `finalize()`，失败调用 `release()`。`scope` 可为 `global`、`subject` 或 `workspace`，同样由配置决定。

## 服务 API

注入名为 `assistantPolicy`。持久账本只属于 service 内部，不从包根导出；消费者不能直接打开数据库或绕过 service 规则。主要方法为：

- `evaluate(request)`：只评估，不写审计；紧急停止优先于所有规则。
- `authorize(request, options)`：执行预算检查并追加脱敏审计。
- `reserve` / `finalize` / `release`：策略配置约束下的可变成本预算。
- `propose` / `decideProposal`：绑定 principal、版本 CAS、TTL 与幂等键的持久审批提案。所有提案永久保存 diff SHA-256；只有携带 `dispatch` 的 pending 提案会临时保存 immutable diff 原文，路由与提案在同一个 SQLite 事务中落盘。路由 principal 必须与提案 principal 完全一致、workspace 必须为绝对路径。无路由提案和 v1 legacy 提案只凭 hash 安全重放，绝不会在重放时补建路由。
- `getProposal`：只读地返回某个提案的当前状态（含终态与决定者）。`getProposalByIdempotencyKey` 用完整的 requester、principal、action 和 resource scope 做只读诊断；它绝不创建、重放或延长提案。
- `recoverOrCreateProposal`：业务域跨 SQLite 恢复时使用的原子入口。调用方提交不可移动的绝对 `notAfter`；Policy 在 `BEGIN IMMEDIATE` 中选择“恢复 exact 既有提案 / 创建一次 / 过期后永久 tombstone 幂等键”。tombstone 的 SHA-256 intent hash 固定绑定 deadline、requester、principal、action、resource、diff、summary 以及 dispatch presence/route，但不保存 diff 明文；v4 遗留 tombstone 缺少可验证 identity，迁移后只会阻止复用，任何 recovery 都失败关闭。因此多个进程不能在 lookup 与 create 之间制造孤儿审批卡，也不能借重启获得新 TTL。本插件**从不回调**业务域，方向永远是域读取 Policy 后通过自己的 gate 提交。
- `listPendingApprovalDispatches` / `markApprovalDispatchEnqueued`：向 Delivery 提供有界、可 CAS 的 durable approval outbox。展示用的 summary、diff、action、resource、版本与过期时间只能从 policy 已持久化的 canonical proposal 派生，调用方不能替换卡片文案。终态或已过期提案不会被列出。
- `validateApprovalSettlement(snapshot, expectation)`：跨 Memory / Wiki / Automations / Evolution 共用的纯函数提交门。它逐字段核对 immutable proposal、重新计算 diff SHA-256，并要求终态版本恰好为原版本 `+1`；approved/rejected 必须由绑定 principal 决定，expired 必须由 `system:expiry` 决定。缺失或冲突会抛出稳定的 `ApprovalSettlementConflict`，业务域应 fail closed。
- `setEmergencyStop` / `getEmergencyStop`：持久紧急停止。
- `queryAudit`：按 sequence 有界分页，单次最多 100 条。
- `bindInitiator(agent, initiator)`：供受信调度器在 agent 生命周期内标记 `background`；释放后恢复前一层绑定。

DSH 原生 `user-approval` 仍只负责 open turn 内的即时询问；本插件的 proposal 是跨 turn、可重启恢复的审批状态，不把两者混为一个授权凭证。

## 数据与权限

- 文件系统：创建一个 SQLite 数据库及 WAL/SHM 辅助文件；新目录权限 `0700`，主数据库 `0600`。数据库使用 WAL、`busy_timeout`、外键、FULL synchronous 和前向 schema 版本。
- 网络：无。
- 子进程：无。
- 凭据：不读取或保存凭据值。审计按敏感 key/value、shell `command`、授权头、token、password、path/cwd 做脱敏，资源 id 仅保存 SHA-256。
- 浏览器：无。
- 安装脚本：无。

审批展示预算由包根的 frozen `APPROVAL_DISPLAY_BUDGET` 统一公开：Delivery 默认文本上限 64 KiB，summary 最多 120 UTF-8 bytes，diff 最多 60 KiB，预留 4 KiB 给渠道渲染。原始 diff 只在 routed dispatch 仍为 pending 时存在；成功 enqueue、批准、拒绝或过期都会在同一状态事务中清除，v2→v3 迁移也会清除无路由、已 enqueue 和终态记录的遗留原文。业务域仍不得把 credential、token 或其他秘密写进 diff。`proposalMaintenanceIntervalMs` 默认每 15 秒有界地过期 stale proposal，设为 `0` 可关闭，最大值为 `2147483647`。审计是 append-only；当前版本不会自动删除记录，部署者应根据自己的隐私与合规周期备份或轮换整个数据库。SQLite 提供单机多连接并发安全，不承诺多主机共享文件系统上的一致性。

## 兼容性

已针对 DeepSeek Harness `0.1.0-rc.8`（源码提交 `141eb6fef83422698aef7a981029e843e8161534`）验证。详见仓库[兼容性基线](../../docs/compatibility.md)。
