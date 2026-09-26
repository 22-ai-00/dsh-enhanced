# @dsh-enhanced/assistant-growth-driver

默认关闭的有界后台成长驱动。可通过 `usageLearning` 让真实前台任务结果自动触发持久成长作业，或由 Host 显式唤醒。Agent 回顾 owner 的已验收成功、沉淀 pending 技能候选；启用源码轨后可准备已有 gap 对应的插件修改提案。当前自动入口已接通，修复后的有限采用与持续观察需另配 Control Plane；可安装部署与独立行为验收仍未贯通，`reviewed` 仅表示本次成长复盘结束。

同一插件内还有**第二条、独立开关**的学习轨 `workflowOwnerAnchored`（默认关闭）：它不起模型、不触网，只在本地枚举最近完成的 owner-root goal，把 locator（不含任何 prompt/步骤/验收结论）交给 `assistant-delivery`；由 Delivery 自己再调 goals 的 `inspectOwnerVerifiedWorkflowSource` 独立复核（owner-root、whole-goal succeeded 且 quiescent、cwd/preset 精确匹配），只接受可诚实归约为**单步零工具 agent-turn** 的 goal，通过后经 content-free trace v2 沉淀为 workflow growth candidate，并由 Growth 以 **paused** automation 落库待 owner 批准。自由 objective 无法跨任务聚齐重复门，故该轨**单条即沉淀**：每个独立复核通过的成功 goal 产一条独立 paused 候选。候选带冻结的**占位 cron**（`0 0 29 2 *` UTC，由 store 的激活门阻断执行）；automations 在 store 层 fail-closed——Growth 所属且仍带占位 schedule 的 workflow 无法经 owner 批准 `resume` 或系统 reconcile 转 active，必须先由 owner 显式做一次 schedule mutation（换真 cron）。该轨同样零 approve/activate/install。

自动成长默认继承 Delivery 随来源任务保存的实际 `request/header` 模型快照，包括 adapter 默认 reasoning effort；历史来源不读取后来切换的会话模型。可同时配置 `provider` / `model` 固定覆盖。Host 显式 `wake({ sourceAgent })` 读取该 Agent 的实际请求，普通周期 wake 仍读取外部会话当前选择。原生 Web 无来源时不猜模型。`health().run.model` 记录本轮模型；已派发但中断的持久作业保持 unknown，不换模型或自动重放。

## 安装

先装好 `assistant-delivery`、`assistant-goals`、`assistant-skills`、`assistant-policy` 和所用模型 adapter，再安装本包。只有选用 super-relay 时才需要安装并启用 `assistant-super-relay-budget`：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-growth-driver
dsh --profile web --dump-config
```

包内 `cordis.patch.yml` 只注册插件、不带任何 `enabled` 配置，因此**安装后处于休眠状态**：无 timer、不起 Agent、零写入。第一期不随任何生产 profile 默认启用。

## 工作机制

每次唤醒（`intervalMs > 0` 的 unref timer，或显式调用 `wake()`）：

1. **Preflight（不触网、不起 Agent）**：用配置中冻结的 owner scope 经 `assistantDelivery.validateOwnerRoute` 重新锚定真实 owner route 并铸造一枚短-lived authority（寿命 `≤ maxDurationMs`，硬顶 300000ms，每次使用都重新校验 route，route 漂移即整轮作废）；读取并冻结所选模型；仅使用 super-relay 时检查其契约和默认凭据引用，其他供应由对应 DSH adapter 管理凭据；确认 policy 服务在线；可选地预留 owner 配置的后台预算。
2. **有界后台 Agent**：照 `assistant-skills` repair-agent 的冻结范式运行——`llm/stream` 逐请求钉 provider/model/maxTokens/tools digest，`tools.guard` 白名单 + 双预算计数，system-prompt 按身份过滤，`deadline = min(expiresAt, now + maxDurationMs)` 到点 abort。刻意**不挂载任何 preset**：默认工具面恰好是下面四个 `growth_*` realm 工具；显式开启源码提案且 control-plane 服务在线且配置了构建器时增加三个 `plugin_source_*` 工具。任何其它可见工具都会在发请求前被拒绝。
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
| `intervalMs` | `0` | 显式 wake 的可选周期（上限 24h）；启用 `usageLearning` 时必须为 `0`，由 Automations 负责调度。 |
| `minRepeatedSuccesses` | `3` | Host 侧重复门下限（1–32），模型提交值只允许更高。 |
| `maxReviewsPerWake` | `10` | 每轮枚举历史 goal 的条数上限（1–50）。 |
| `candidateTtlMs` | `86400000` | pending candidate TTL，schema 硬顶 7 天。 |
| `maxModelCalls` / `maxToolCalls` / `maxOutputTokens` | `8` / `24` / `8192` | 单轮预算，到顶即 abort/cancel。 |
| `maxDurationMs` | `120000` | 单轮墙钟上限，**硬顶 300000ms**（安全根，配置不可越过）。 |
| `budgetId` / `budgetAmount` | 均无 | 必须**同时出现**；显式 wake 经 Policy 预留；usage 作业由 Automations 预留，避免重复扣取。已提交的未知消耗不退回。 |
| `provider` / `model` | 继承会话 | 同时配置以固定修复/成长模型；只配置一个会拒绝。不会自动回退到 Day1。 |
| `reasoningEffort` | 继承会话；固定模型时用供应默认 | 只有同时配置固定 provider/model 时可覆盖。 |
| `apiKeyEnv` | 随供应 | 可选凭据引用名；未设置时，super-relay 使用 `SUPER_RELAY_API_KEY`，其他供应由对应 adapter 管理。引用优先经 credentials 解析，再读同名环境变量；不接受或打印明文 key。 |
| `workflowOwnerAnchored.enabled` | `false` | owner-anchored workflow 轨独立开关；置 `true` 时要求驱动本体 `enabled: true` 且已声明 `scope`，否则启动报错。 |
| `workflowOwnerAnchored.maxCommitsPerWake` | `5` | 单轮最多尝试提交的候选数（1–50）；goals/delivery 不可用、authority/route 漂移即中断本轮。幂等重放代价很低。 |
| `pluginSourceProposals.enabled` | `false` | 开启后通过可选 `pluginControlPlane` 服务准备既有插件的 pending 修改提案。缺少该服务或构建器未配置时仍保持四工具基线。 |
| `pluginSourceProposals.repository` | 无 | 开启时必填的绝对规范仓库路径；由 owner 配置，模型不可传入。 |
| `pluginSourceProposals.preparationMode` | `inline` | `inline` 保持本轮隔离构建；`durable` 只把已读、冻结 base 的内容排入 Control Plane 自己的持久队列。队列 authority、构建超时和执行生命周期都由 Control Plane 配置，独立于模型 wake。 |
| `pluginSourceProposals.maxPlansPerWake` | `1` | 每轮源码提案尝试上限（1–5）；inline 的 prepared 与 durable 的 queued 都占用此预算，失败也占一次。 |
| `pluginSourceProposals.isolatedBuildTimeoutMs` | `180000` | 仅 `inline` 使用的构建时间上限（60000–240000ms）；控制面可进一步收窄，单轮 authority 到期仍会取消。`durable` 使用控制面 `sourceBuild.timeoutMs`。 |
| `pluginSourceProposals.offline` | `true` | 源码提案必须离线构建；`false` 配置会拒绝。镜像须预先准备依赖。 |
| `pluginSourceProposals.planTtlMs` | `86400000` | 待批 worktree 保留期限（15 分钟–24 小时）。 |
| `workflowOwnerAnchored.lookbackMs` | `86400000` | 只枚举该回看窗口内更新过的 owner goal（1 分钟–7 天）。 |
| `usageLearning.enabled` | `false` | 真实任务触发开关；要求主开关、owner scope、预算及 Evaluation/Automations 服务。 |
| `usageLearning.databasePath` | 无 | 开启时必填的私有 SQLite 绝对路径，保存游标、冻结来源与作业状态。 |
| `usageLearning.maxPending` | `16` | 同时 queued/running 上限（1–100）；满时保留未消费游标，释放容量后继续。 |
| `usageLearning.lookbackMs` | `86400000` | 来源结果最大年龄与排队 TTL（1 分钟–7 天）。 |

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
        # 默认继承会话；需要固定模型时添加以下两项：
        # provider: super-relay
        # model: auto_model/alwaysday1
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

源码审阅与技能沉淀分别执行：启用本能力后，即使没有历史完成目标，也会检查已登记的开放 gap。重复、独立验收成功仍是技能候选的必要条件；源码候选按 gap、读取版本、权限和隔离检查规则准入。

另行安装同批 `plugin-control-plane`，按其 README 配置 owner trust 和隔离构建镜像，再给 driver 增加：

```yaml
pluginSourceProposals:
  enabled: true
  preparationMode: durable # 删除或设为 inline 时保持当前同步构建行为
  repository: /abs/path/to/dsh-enhanced
  maxPlansPerWake: 1
  isolatedBuildTimeoutMs: 180000
  offline: true
  planTtlMs: 86400000
```

这段是 driver 完整配置的补充。DSH patch 的 `config` 为整值替换，覆盖配置时必须同时保留 `enabled`、`scope` 和其它需要的值。Policy 还需对相同 owner、workspace、preset 和 `background` initiator 授予 `execute` / `tool:plugin_source_*`。

Agent 先通过 `plugin_source_gaps` 发现 owner 配置的控制面账本中已有的开放 gap，通过 `plugin_source_read` 列出并读取目标插件在 Git 提交中的文本源码，最后通过 `plugin_source_prepare` 提交 `gap_id`、`plugin_name` 与两种互补的修改输入：新增短文件或完整替换用 `files: [{path, content}]`；已读的长既有文件用 `edits: [{path, before, after}]`。每个 `before` 必须在本轮缓存的原始文本中精确且唯一地出现，编辑按原始偏移处理，且不能重叠；`files` 与 `edits` 可以一起使用，但路径必须互不相同。Host 先展开为完整文件再交给 Control Plane，模型不会从确认结果取回缓存源码。普通手动 wake 读取既有手工 gap，这类记录没有逐条 owner 来源证明，多 owner 部署仍须隔离手工账本。启用下述 `usageLearning` 时只读取本次可信失败的专属 gap，绝不退回全局列表。至少提供一种非空输入；两种输入合计最多 64 项，单个完整内容、`before`、`after` 与最终每个文件最多 64 KiB，最终完整文件最多 64 个、合计 256 KiB。模型不能给仓库路径、命令、镜像、环境、TTL、审批或发布参数。安全根插件由 driver 和控制面同时拒绝。

`plugin_source_read` 接收 `gap_id`、`plugin_name`、`paths`；`paths: []` 返回文件清单，再按需读取源码、测试、README、package.json 和 patch。只读取已提交的文本，不读取工作区改动、未跟踪文件、符号链接、隐藏文件或生成目录。单文件最多 64 KiB，每轮内容累计最多 256 KiB，并受现有工具调用次数与运行时限控制。读取的内容属于不可信数据，不能改变工具权限。

Host 在本轮内按 gap 与插件保存首次读取的 commit，后续读取和准备均绑定该 commit；HEAD 变化即拒绝旧上下文。同一文件在同一 commit 的再次读取若内容漂移也会拒绝。完整替换既有文件前必须读取原内容；精确编辑只能作用于已读的既有文件，可在已有目录中增加源码或测试文件。模型不能指定 commit，也不能只凭文件清单覆盖未读文件。服务提供者更换后读上下文与待执行动作一并失效；未提供源码读取接口的旧版 control-plane 保持四工具基础模式。

Control Plane 拥有 worktree、源码快照、容器构建和 SQLite 写入。`inline` 成功时仅返回待审批 plan id 与检查摘要；`durable` 成功时只返回 content-free job id/status，Host 接受队列后继续以它自己的 durable authority 运行，即使模型 wake 随后到期也不会伪造为 prepared。`plugin_source_job_status` 只在 durable 模式出现，并用当前 Growth authority 的 owner scope 查询 job。owner 仍需通过控制面的签名审批、源码复核和发布流程处理。模型看不到 worktree 路径或构建日志。检查失败、owner route 漂移、provider 移除、插件卸载或本轮到期均终止尚未被 Host 接受的操作。`health().run.sourceProposals` 分别提供 `queued`、`prepared` / `rejected` 数量；可选 provider 更换后下一轮重新绑定，旧轮次不会跨代继续写入。

## 真实使用自动触发

在完整 driver 配置中加入：

```yaml
enabled: true
intervalMs: 0
budgetId: growth-budget
budgetAmount: 1
usageLearning:
  enabled: true
  databasePath: /absolute/private/assistant-growth.sqlite
  scanBudgetId: growth-discovery-runs
  scanBudgetAmount: 1
  maxPending: 16
  lookbackMs: 86400000
```

保留前文 `scope` 和模型/工具预算；按需保留源码轨配置。安装并挂载 `assistant-evaluation` 与 `assistant-automations`，启用 Automations scheduler。Policy 需允许 background 主体 `assistant-growth-usage` 对相同 workspace/principal 的 `automation:*` 执行 `reconcile`，并允许对应后台作业的 `execute`。使用全局或 owner 聚合的周期预算限制持续成长总消耗；每个 review 由原生 Automations 预留一次预算，driver 不重复扣取。已有 `growth_*` 与可选 `plugin_source_*` 工具规则仍适用。

`scanBudgetId/scanBudgetAmount` 是启用时的必填配置；对应 Policy budget 的 metric 为 `automation-runs`，扫描建议用 `subject` scope（每个 owner scope 的 scan automation id 稳定）。每分钟扫描即使队列为空也需要预算；例如每天最多 1,440 次扫描可配置 `limit: 1440, periodMs: 86400000, scope: subject`。模型复盘继续使用顶层 `workspace/global` 聚合预算。Policy 账本按 scope、metric 和周期计量，仅换 budget id 不会分开额度；扫描用 `subject`、复盘用 `workspace/global` 可以避免扫描占用模型额度。扫描预算耗尽暂停跨进程发现，同进程通知仍可登记候选，但 review 仍须通过自己的预算；不要开启 `allowUnbudgetedExecution` 绕过配置。升级已启用配置须补齐扫描预算，旧排队作业因配置摘要变化停止，不自动重放。

同进程 Evaluation 变化即时扫描，原生每分钟 scan 负责重启及其他进程写入的恢复；scan 自身不调用模型。只处理精确 owner、已结束且 quiescent、未截断的前台可信结果（独立 Verifier 或已认证 owner 反馈）。内置 Delivery 普通对话可在回复原结果“还是不行，保存报错”等明确自然反馈后触发，也保留 `/feedback not-achieved`，无需预先配置任务验收 profile；原文继续进入普通 Agent 对话。Delivery 用当前 canonical 修订的操作身份核对自然反馈原文，复盘最多收到 4096 字的纠正原因及截断标志，作为不可信任务材料；历史记录没有该证据时不猜测原因。单纯模型结束不会生成可信结果。排除 Automation/后台成长自己的结果，避免递归触发。缺模型快照或多请求模型不一致且没有固定覆盖时不发起作业。相同 canonical 修订只接纳一次；纠正/撤回使旧排队作业失效，运行中的作业在模型/工具边界重查来源。原始记录和评价仍由 Evaluation 持有。

`usageHealth()` 返回连接、扫描错误与各状态数量，不返回任务正文。queued 可在重启后恢复；running 中断转 unknown，不自动重跑。配置、owner 身份/route 或来源变化会阻止旧作业继续。停用 `usageLearning` 会卸载执行器并中止本代工作；持久作业不会被清除。它目前自动驱动有界复盘和候选生成，尚不创建任意修复 Goal；完成复盘不代表候选已采用或带来收益。

同时启用 `pluginSourceProposals` 后，可信 `not-achieved` 前台结果会在模型启动前自动登记 Control Plane 私有 gap，无需预先人工登记。Host 重新读取 Delivery 来源，在 Evaluation writer fence 内记录 owner、任务修订和来源摘要；gap 不保存任务原文，默认 ROI 为未知占位值 0。成功、unknown、撤回、未结束及截断来源不产生失败 gap。新控制面接口缺失时失败关闭，不读取全局手工 gap。

源码检查、最终计划提交及 durable job 的排队、恢复和执行都重新核对来源。完整 owner receipt 固定后，`/new` 导致 binding/generation 变化也会停止旧任务。纠正或撤回后保留历史引用，禁止旧来源继续产出计划。Driver 负责候选生成；后续有限审批、发布、独立审查、采用与真实任务观察由另行配置的 [Control Plane](../plugin-control-plane/README.md) 接续。组件已接线，可安装部署与独立行为验收尚未贯通，不能据此宣称生产自迭代已完成。

## 权限与数据

- 网络：经本轮冻结的 DSH 模型 adapter 发出请求，目标及凭据由该供应配置决定；没有模型之外的网络工具。
- 文件系统：启用 `usageLearning` 后写私有 SQLite（文件权限 `0600`），保存冻结任务正文、owner 与模型，未自动清理历史。正文最多 4096 字符，经 owner 校验后作为不可信数据交给获授权的成长模型；Automations 定义与公开 health 不含正文。skill candidate 由 Skills 入库，源码提案经 Control Plane 写入其私有 worktree 和 SQLite。
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
