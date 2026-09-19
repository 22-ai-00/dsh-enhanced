# @dsh-enhanced/assistant-growth-driver

Opt-in、默认关闭的「主动成长轮」驱动：没有新消息时周期性唤醒一个严格有界的后台 Agent，让它只做一件事——回顾该 owner **已被 Host 独立验收过的历史成功**，把重复出现的可复用流程沉淀为一个 **paused skill candidate（pending 候选）**，停在待 owner 批准。它不创建 goal、不发 guidance、不记 capability gap，不 activate / install / retire / rollback 任何东西，也不修改 policy。候选的后续 compare / canary / owner approve / activate 全部沿用 `assistant-skills` 既有的 owner 门，本插件一律不触碰。

同一插件内还有**第二条、独立开关**的学习轨 `workflowOwnerAnchored`（默认关闭）：它不起模型、不触网，只在本地枚举最近完成的 owner-root goal，把 locator（不含任何 prompt/步骤/验收结论）交给 `assistant-delivery`；由 Delivery 自己再调 goals 的 `inspectOwnerVerifiedWorkflowSource` 独立复核（owner-root、whole-goal succeeded 且 quiescent、cwd/preset 精确匹配），只接受可诚实归约为**单步零工具 agent-turn** 的 goal，通过后经 content-free trace v2 沉淀为 workflow growth candidate，并由 Growth 以 **paused** automation 落库待 owner 批准。自由 objective 无法跨任务聚齐重复门，故该轨**单条即沉淀**：每个独立复核通过的成功 goal 产一条独立 paused 候选。候选带冻结的**占位 cron**（`0 0 29 2 *` UTC，2 月 29 日永不触发）；automations 在 store 层 fail-closed——Growth 所属且仍带占位 schedule 的 workflow 无法经 owner 批准 `resume` 或系统 reconcile 转 active，必须先由 owner 显式做一次 schedule mutation（换真 cron）。该轨同样零 approve/activate/install。

模型路由在代码中钉死为 `super-relay` / `auto_model/alwaysday1`，不能通过配置改写；凭据缺失、super-relay 契约过期或 owner route 漂移时，本轮 fail-closed 跳过（写入 `health()` 原因），绝不换路由、不降级到其他模型、不自启用。owner-anchored 轨本身不产生模型请求，但它与 skill 轨共用同一枚有界 authority 与同一组 preflight。

## 安装

先装好 `assistant-delivery`、`assistant-goals`、`assistant-skills`、`assistant-policy` 与 `assistant-super-relay-budget`，再安装本包：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-growth-driver
dsh --profile web --dump-config
```

包内 `cordis.patch.yml` 只注册插件、不带任何 `enabled` 配置，因此**安装后处于休眠状态**：无 timer、不起 Agent、零写入。第一期不随任何生产 profile 默认启用。

## 工作机制

每次唤醒（`intervalMs > 0` 的 unref timer，或显式调用 `wake()`）：

1. **Preflight（不触网、不起 Agent）**：用配置中冻结的 owner scope 经 `assistantDelivery.validateOwnerRoute` 重新锚定真实 owner route 并铸造一枚短-lived authority（寿命 `≤ maxDurationMs`，硬顶 300000ms，每次使用都重新校验 route，route 漂移即整轮作废）；校验 super-relay 契约仍 current；解析凭据引用（只验存在，不打印）；确认 policy 服务在线；可选地预留 owner 配置的后台预算。
2. **有界后台 Agent**：照 `assistant-skills` repair-agent 的冻结范式运行——`llm/stream` 逐请求钉 provider/model/maxTokens/tools digest，`tools.guard` 白名单 + 双预算计数，system-prompt 按身份过滤，`deadline = min(expiresAt, now + maxDurationMs)` 到点 abort。刻意**不挂载任何 preset**：默认工具面恰好是下面四个 `growth_*` realm 工具；显式开启源码提案且 control-plane 服务在线且配置了构建器时增加两个 `plugin_source_*` 工具。任何其它可见工具都会在发请求前被拒绝。
   - `growth_list_owner_goals`：列最近的 owner-root goal（只读投影）。
   - `growth_read_verified_workflow`：读一条已完成 goal 的**脱敏**摘要；Host 独立复核 owner-root（非 subagent、无 parent session、delegationDepth=0）、whole-goal succeeded 且 quiescent，cwd/preset 精确匹配；不返回步骤参数与验收回执。
   - `growth_list_skills`：列该 owner 的 active skill 与 pending candidate，避免重名。
   - `growth_propose_skill_candidate`：唯一的写工具，只产「提议」。
3. **Host 侧复核沉淀（系统 authority，非模型）**：提议携带的每个 `{session_id, goal_id}` 都由 skills 服务经 goals 独立重读、逐条重新验收；必须有 **≥ `minRepeatedSuccesses` 个不同** 的 owner-verified 成功（模型无法把门槛降到配置值以下，谎报/伪造/重复 locator 一律拒绝且零写入），同名 active / pending / retired 冲突不写。通过后只 `stageCandidate` 产一条 **pending candidate**（TTL ≤ 7 天，带 reason/trigger/parentVersion）：不进 current 版本，`skill_run` 不可达。

## 配置与使用

所有配置项 fail-closed；未知字段直接报错。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 必须显式置 `true` 才运行；且启用时必须同时声明 `scope`，否则启动报错。 |
| `scope` | 无 | 冻结的 owner 四字段 `workspace` / `preset` / `principalId` / `ownerRouteId`。driver 只在该 scope 内动作，identity 不从模型输出派生。`ownerRouteId` 必须是 Delivery 中既有的、已认证的 owner route id；route 不存在/不匹配时每轮跳过并记 `missing-binding`。 |
| `intervalMs` | `0` | `0` = 不轮询，只能由 Host 显式触发 `wake()`；`>0` 起 `unref` timer（上限 24h）。唤醒串行化，长复盘不会与下一次 tick 重叠。 |
| `minRepeatedSuccesses` | `3` | Host 侧重复门下限（1–32），模型提交值只允许更高。 |
| `maxReviewsPerWake` | `10` | 每轮枚举历史 goal 的条数上限（1–50）。 |
| `candidateTtlMs` | `86400000` | pending candidate TTL，schema 硬顶 7 天。 |
| `maxModelCalls` / `maxToolCalls` / `maxOutputTokens` | `8` / `24` / `8192` | 单轮预算，到顶即 abort/cancel。 |
| `maxDurationMs` | `120000` | 单轮墙钟上限，**硬顶 300000ms**（安全根，配置不可越过）。 |
| `budgetId` / `budgetAmount` | 均无 | 必须**同时出现**；配置后每轮先经 policy `reserve` 预留后台预算，Agent 已提交则保守 finalize、未提交才 release。 |
| `apiKeyEnv` | `SUPER_RELAY_API_KEY` | **只收凭据引用名**（`[A-Z_][A-Z0-9_]*`）：优先经 credentials 服务解析该引用，回退到同名环境变量。绝不接受明文 key，不打印值。 |
| `workflowOwnerAnchored.enabled` | `false` | owner-anchored workflow 轨独立开关；置 `true` 时要求驱动本体 `enabled: true` 且已声明 `scope`，否则启动报错。 |
| `workflowOwnerAnchored.maxCommitsPerWake` | `5` | 单轮最多尝试提交的候选数（1–50）；goals/delivery 不可用、authority/route 漂移即中断本轮。幂等重放代价很低。 |
| `pluginSourceProposals.enabled` | `false` | 开启后通过可选 `pluginControlPlane` 服务准备既有插件的 pending 修改提案。缺少该服务或构建器未配置时仍保持四工具基线。 |
| `pluginSourceProposals.repository` | 无 | 开启时必填的绝对规范仓库路径；由 owner 配置，模型不可传入。 |
| `pluginSourceProposals.maxPlansPerWake` | `1` | 每轮构建尝试上限（1–5）；失败也占一次，避免失败循环反复消耗资源。 |
| `pluginSourceProposals.isolatedBuildTimeoutMs` | `180000` | 请求的构建时间上限（60000–240000ms）；控制面可进一步收窄，单轮 authority 到期仍会取消。 |
| `pluginSourceProposals.offline` | `true` | 源码提案必须离线构建；`false` 配置会拒绝。镜像须预先准备依赖。 |
| `pluginSourceProposals.planTtlMs` | `86400000` | 待批 worktree 保留期限（15 分钟–24 小时）。 |
| `workflowOwnerAnchored.lookbackMs` | `86400000` | 只枚举该回看窗口内更新过的 owner goal（1 分钟–7 天）。 |

super-relay 自身的 5 个键（`enabled` / `apiKeyEnv` / `timeoutMs` / `maxResponseBytes` / `defaultMaxTokens`）在 `assistant-super-relay-budget` 插件上配置；driver 不重复定义。

### copy-paste opt-in 片段

在 profile 的 `cordis.patch.yml` 中插入本插件（路径/身份按实际 owner 替换）：

```yaml
- insert:
    - id: dsh-enhanced-assistant-growth-driver
      name: '@dsh-enhanced/assistant-growth-driver'
      config:
        enabled: true
        intervalMs: 3600000
        minRepeatedSuccesses: 3
        maxDurationMs: 120000
        apiKeyEnv: SUPER_RELAY_API_KEY
        scope:
          workspace: /abs/path/to/owner/workspace
          preset: primary
          principalId: owner-1
          ownerRouteId: <exact-delivery-owner-route-id>
        budgetId: growth-budget
        budgetAmount: 1
        # 第二条、独立开关的学习轨；整段删除即保持关闭。
        workflowOwnerAnchored:
          enabled: true
          maxCommitsPerWake: 5
          lookbackMs: 86400000
```

owner-anchored 轨不需要额外 policy 规则：它不挂模型 Agent，唯一写动作是 Host-only 的 Delivery 提交口（系统 authority，非模型面）。产出的 paused automation 需 owner 在 automations 既有审批面处理——**批准 resume 前必须先把占位 cron 显式改成真实 schedule**，否则批准会落 `conflicted` 且行保持 paused（这是 store 层硬门，不是 UI 提示）。

后台 Agent 以 `background` initiator 绑定 owner principal；policy 默认空规则全拒，需在 `dsh-enhanced-assistant-policy` 的 `rules` 中补两条最小 allow（主体 id 是 scope 的 preset，workspace/principal 必须与 scope 精确一致）：

```yaml
rules:
  - id: growth-draft
    effect: allow
    subject: { kind: agent, id: primary, workspace: /abs/path/to/owner/workspace, principal: owner-1 }
    actions: [draft]
    resource: { kind: evolution, id: verified-workflows }
    context: { initiators: [background] }
  - id: growth-tool-execute
    effect: allow
    subject: { kind: agent, id: primary, workspace: /abs/path/to/owner/workspace, principal: owner-1 }
    actions: [execute]
    resource: { kind: tool, id: 'growth_*' }
    context: { initiators: [background] }
```

使用 `budgetId` 时还要在 policy `budgets` 中存在同 id、`scope: subject` 的预算。任何规则都只授予「读历史 + 提 pending 候选」；driver 不注册、也不需要 save/activate/install/retire/rollback 权限。

### 观察与关闭

- 服务方法 `health()` 返回最近一次唤醒的 `lastWakeAt` / `outcome`（`never-run`/`ran`/`skipped`/`failed`）/ `reason` / 运行用量；跳过原因包括 `missing-scope`、`missing-binding:*`、`contract-expired:*`、`missing-credential`、`missing-policy`、`budget:*`。
- `health().ownerAnchored`（仅该轨启用且本轮跑过时存在）给本地轨计数：`considered`（窗口内完成的 goal）/ `attempted`（实际尝试提交）/ `recorded`（新沉淀）/ `replayed`（幂等重放）/ `abstained`（多工具等无法归约为单步 agent-turn，诚实跳过）/ `stopped`（非空时为 fail-closed 中断原因，如 `inspect:*`、`authority:*`、`runtime-unavailable:*`）。
- 停用：把 `enabled` 置回 `false`（或移除插件配置）即恢复休眠，不影响已经 staged 的 pending candidate——它们仍只由 owner 在既有 skills/automations 审批面处理。

## 既有插件源码提案

另行安装同批 `plugin-control-plane`，按其 README 配置 owner trust 和隔离构建镜像，再给 driver 增加：

```yaml
pluginSourceProposals:
  enabled: true
  repository: /abs/path/to/dsh-enhanced
  maxPlansPerWake: 1
  isolatedBuildTimeoutMs: 180000
  offline: true
  planTtlMs: 86400000
```

这段是 driver 完整配置的补充。DSH patch 的 `config` 为整值替换，覆盖配置时必须同时保留 `enabled`、`scope` 和其它需要的值。Policy 还需对相同 owner、workspace、preset 和 `background` initiator 授予 `execute` / `tool:plugin_source_*`。

Agent 先通过 `plugin_source_gaps` 发现 owner 配置的控制面账本中已有的开放 gap，再通过 `plugin_source_prepare` 提交 `gap_id`、`plugin_name` 和插件相对路径的文件内容。这些 gap 是控制面现有记录，并不携带逐条 owner-route 来源证明；多 owner 部署须隔离各自的账本。每轮最多枚举 `maxReviewsPerWake` 条、提交 `maxPlansPerWake` 次；模型不能给仓库路径、命令、镜像、环境、TTL、审批或发布参数。每次最多 64 个文件、单文件 64 KiB、合计 256 KiB。安全根插件由 driver 和控制面同时拒绝。

Control Plane 拥有 worktree、源码快照、容器构建和 SQLite 写入。成功时仅返回待审批 plan id 与检查摘要；owner 仍需通过控制面的签名审批、源码复核和发布流程处理。模型看不到 worktree 路径或构建日志。检查失败、owner route 漂移、provider 移除、插件卸载或本轮到期均终止本次操作。`health().run.sourceProposals` 提供本轮 `prepared` / `rejected` 数量；可选 provider 更换后下一轮重新绑定，旧轮次不会跨代继续写入。

## 权限与数据

- 网络：仅经 pinned super-relay 路由产生到 super-relay 端点的出站模型请求；无其他外联。
- 文件系统：driver 自身不写文件；skill candidate 由 Skills 入库，源码提案经 Control Plane 写入其私有 worktree 和 SQLite。
- 子进程：源码轨开启时委托 Control Plane 调用 Git 与隔离容器构建；构建权属于 owner 配置的 Control Plane，见其权限说明。driver 无浏览器能力。
- 凭据：只读解析一次凭据引用（存在性检查），不持久化、不回显、不入日志。
- 审批/策略：每次沉淀与每个工具调用都在 service 边界经 `assistant-policy`；空规则默认拒绝。产物仅 pending，零 activate/install。

## 明确不做（边界）

- 不自主发起/执行 goal、不提议 guidance、不记 capability gap。
- 不 activate / install / retire / rollback、不扩权、不改 policy 规则表、不碰预算上限与急停等安全根。
- owner-anchored 轨只提交 locator：证据（objective、步骤、验收结论）一律由 Delivery 持 goals 独立重取，driver 不接受调用方自带 prompt，也不自造 trace source/authority。
- 源码轨只到经过检查的 pending 提案；owner 签名、发布、生产启用和 HMR reload 由独立控制面处理。
- owner-anchored 轨的证据是 Delivery 在进程内对真实 goals SQLite 的独立复核（工程层）；真实 super-relay 端到端与真实外部平台深评测均不在本期，前者仅由 owner 显式 opt-in 后手动触发一次。

## 兼容性

See the repository [compatibility baseline](../../docs/compatibility.md)。
