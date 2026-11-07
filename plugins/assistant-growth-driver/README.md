# @dsh-enhanced/assistant-growth-driver

默认关闭的有界后台成长驱动。可通过 `usageLearning` 让真实前台任务结果自动触发持久成长作业，另经显式 `workItemFailures` 授权消费后台失败反馈，或由 Host 显式唤醒。Agent 回顾 owner 的已验收成功、沉淀 pending 技能候选；启用源码轨后可准备已有 gap 对应的插件修改提案。在配套 Control Plane、有限授权和独立验收配置齐备时，工具创建轨已接通持久构建、独立行为验收和受限动态采用。技能候选仍须另经独立验证与重复成功门；修改、修订和持续观察各有自己的授权与验收条件，不能由一次 `reviewed` 推定完成。`reviewed` 仅表示本次成长复盘结束，不代表完整长期成长闭环已验收。

有源码接口且普通认证反馈的 objective 为 `not-achieved` 时，本轮先查看当前 owner 的任务缺口与任务证据，再按相关性读取目标清单、源码或已授权的创建模板。文件清单只供发现路径，替换前仍须读取正文；证据不足时可以不提案。成功、周期唤醒和缺少源码接口的反馈仍用通用成功工作流；技能候选始终经过独立验证与重复成功门。新运行将实际发送的完整提示（含脱敏反馈数据）绑定到执行摘要；旧来源绑定不补写，也不自动重放 unknown。

同一插件内还有**第二条、独立开关**的学习轨 `workflowOwnerAnchored`（默认关闭）：它不起模型、不触网，只在本地枚举最近完成的 owner-root goal，把 locator（不含任何 prompt/步骤/验收结论）交给 `assistant-delivery`；由 Delivery 自己再调 goals 的 `inspectOwnerVerifiedWorkflowSource` 独立复核（owner-root、whole-goal succeeded 且 quiescent、cwd/preset 精确匹配），只接受可诚实归约为**单步零工具 agent-turn** 的 goal，通过后经 content-free trace v2 沉淀为 workflow growth candidate，并由 Growth 以 **paused** automation 落库待 owner 批准。自由 objective 无法跨任务聚齐重复门，故该轨**单条即沉淀**：每个独立复核通过的成功 goal 产一条独立 paused 候选。候选带冻结的**占位 cron**（`0 0 29 2 *` UTC，由 store 的激活门阻断执行）；automations 在 store 层 fail-closed——Growth 所属且仍带占位 schedule 的 workflow 无法经 owner 批准 `resume` 或系统 reconcile 转 active，必须先由 owner 显式做一次 schedule mutation（换真 cron）。该轨同样零 approve/activate/install。

自动成长默认继承 Delivery 随来源任务保存的实际 `request/header` 模型快照，包括 adapter 默认 reasoning effort；历史来源不读取后来切换的会话模型。可同时配置 `provider` / `model` 固定覆盖。Host 显式 `wake({ sourceAgent })` 读取该 Agent 的实际请求，普通周期 wake 仍读取外部会话当前选择。原生 Web 无来源时不猜模型。`health().run.model` 记录本轮模型；已派发但中断的持久作业保持 unknown，不换模型或自动重放。

普通 owner 反馈复盘还可收到 Delivery 核对的原始已发送答复，模型可见文本最多 4096 UTF-8 字节。Delivery 在 16 KiB 完整读取上限内先过滤常见凭据形状，再截断展示；超过读取上限时只给占位文本，不发送原文前缀，并保留截断和过滤标志。模型只收到该文本及标志，Outbox 身份和完整原文摘要留在 Host 冻结来源内。答复属于不可信任务材料，不是工具 stdout、根因证明、独立验收或执行授权；部分文本不能建立完整修复依据。过滤不能识别任意秘密。旧 Delivery 没有此字段时仍可复盘；已有持久作业的答复证据若新增、移除或改变，原来源检查会拒绝继续，不会补写旧快照或重放 unknown。

## 安装

先装好 `assistant-delivery`、`assistant-goals`、`assistant-skills`、`assistant-policy` 和所用模型 adapter，再安装本包。模型供应完全由 owner 配置的 provider/model 与对应 adapter 决定：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-growth-driver
dsh --profile web --dump-config
```

单独添加本包时，包内 `cordis.patch.yml` 只注册插件、不带任何 `enabled` 配置，因此**处于休眠状态**：无 timer、不起 Agent、零写入。安装器在取得 owner 授权并完成资源准备后生成的原生 RSI 组合会显式启用本包及 `usageLearning`，固定 owner scope、期限和有限预算，并设置 `intervalMs: 0` 复用原生调度。该组合允许工具创建提案，不默认开放修改或修订；这与单独添加本包的休眠默认值不同。

## 工作机制

每次唤醒（`intervalMs > 0` 的 unref timer，或显式调用 `wake()`）：

1. **Preflight（不触网、不起 Agent）**：用配置中冻结的 owner scope 经 `assistantDelivery.validateOwnerRoute` 重新锚定真实 owner route 并铸造一枚短-lived authority（寿命 `≤ maxDurationMs`，硬顶 300000ms，每次使用都重新校验 route，route 漂移即整轮作废）；读取并冻结所选模型；若配置了 `apiKeyEnv` 则按该引用解析凭据，否则由对应 DSH adapter 管理凭据；确认 policy 服务在线；可选地预留 owner 配置的后台预算。
2. **有界后台 Agent**：照 `assistant-skills` repair-agent 的冻结范式运行——`llm/stream` 逐请求钉 provider/model/maxTokens/tools digest，`tools.guard` 白名单 + 双预算计数，system-prompt 按身份过滤，`deadline = min(expiresAt, now + maxDurationMs)` 到点 abort。刻意**不挂载任何 preset**：默认工具面恰好是下面四个 `growth_*` realm 工具；显式开启源码提案且 control-plane 服务在线且配置了构建器时增加三个基础 `plugin_source_*` 工具；可选 provider 另有目标发现、durable 状态或创建接口时按配置追加相应工具。任何其它可见工具都会在发请求前被拒绝。
   - `growth_list_owner_goals`：列最近的 owner-root goal（只读投影）。
   - `growth_read_verified_workflow`：读一条已完成 goal 的**脱敏**摘要；Host 独立复核 owner-root（非 subagent、无 parent session、delegationDepth=0）、whole-goal succeeded 且 quiescent，cwd/preset 精确匹配；不返回步骤参数与验收回执。
   - `growth_list_skills`：列该 owner 的 active skill 与 pending candidate，避免重名。
   - `growth_propose_skill_candidate`：唯一的写工具，只产「提议」。
3. **Host 侧复核沉淀（系统 authority，非模型）**：提议携带的每个 `{session_id, goal_id}` 都由 skills 服务经 goals 独立重读、逐条重新验收；必须有 **≥ `minRepeatedSuccesses` 个不同** 的 owner-verified 成功（模型无法把门槛降到配置值以下，谎报/伪造/重复 locator 一律拒绝且零写入），同名 active / pending / retired 冲突不写。通过后只 `stageCandidate` 产一条 **pending candidate**（TTL ≤ 7 天，带 reason/trigger/parentVersion）：不进 current 版本，`skill_run` 不可达。

## PTC 呈现（可选，默认 native）

`toolPresentation: ptc` 只把**模型看到的工具形态**从「逐条 schema」换成 Host 原生的 PTC 模式：
模型只看到保留传输 `run_code` 与由冻结 allowlist 生成的 TypeScript SDK，可在一次模型回合内用程序
编排多次嵌套工具调用，嵌套结果不逐条进入上下文，只有脚本 curated 输出回到模型。它**不改变**工具
许可、审批、预算或输出上限：PTC 不是安全边界，脚本只能经冻结工具面触达宿主。

- **冻结工具面不变**：工具集合、`tools.guard` allowlist、每轮 `maxToolCalls`、Policy 预授权与
  `health().run.sourceProposals` 语义都保持；`schemas()` 仍返回完整 allowlist（`toolContractDigest`
  与执行契约摘要只对 allowlist 计算，native 与 PTC 对同一配置得到相同摘要）。PTC 下 registry 会追加
  唯一的保留 `run_code` 传输：driver 不注册、不覆盖它；setup 会核对它的存在与身份，并拒绝任何多余/
  缺失/重复的工具；模型可见 wire schema 摘要另算，native 与 PTC 各自稳定。
- **预算语义**：`maxToolCalls` 统计 `run_code` 本身与每个通过 guard 的嵌套子调用（含其后失败或取消
  的调用）；被预算拒绝而未执行的调用不计数。嵌套调用仍逐次经过同一 `tools/pre-execute`、Policy
  guard、审批与输出上限。
- **轨迹摘要**：PTC 运行结果的 `usage.ptc` 只含 `assistant-growth/ptc-trajectory/v1` 有界结构化计数
  （`run_code` 调用/失败数、脚本总字节与 SHA-256 摘要、嵌套调用/失败/非 allowlist 计数、按工具名
  计数、最长子调用与 `run_code` 耗时）。脚本正文、嵌套参数和工具结果正文不进入运行结果；native
  运行的 `usage` 形状与旧版逐字段一致（没有 `ptc` 键）。

**前置条件（缺一不可；不满足时 fail-closed，绝不静默回退 native）：**

1. profile 挂载 `ctx.ptcRuntime`（例如 `@deepseek-ai/dsh-ptc-runtime-node`）；缺省时 Host 的
   `dsh-tools` 会拒绝 PTC prompt。driver 在创建 Agent 前检查，缺失即失败并给出可操作错误。
   PTC 的 `run_code` 还要求 Host 有 `workingDirectory` 服务。
2. 审批策略不得对 `run_code` 请求人工审批：后台 Agent 无法回答交互审批。`assistant-policy` 把顶层
   `run_code` 归为 `ask-human`，因此默认 `never` 会直接拒绝（`approval-disabled`），其他弹审批的
   profile 也不可用。默认关闭；只有明确不请求人工审批的后台策略才可开启。
3. Policy 需要为 growth agent 的 background `run_code` 建立精确 allow 规则（`action: execute`,
   `resource: {kind: tool, id: run_code}`）。RSI 生成 profile 目前只给 `growth_*` / `plugin_source_*`
   建规则，**本切片不生成该规则、也不改 assistant-policy**；缺失时 `run_code` 按 default-deny 失败
   关闭（计入 `health().run.usage.ptc.failedRunCodeCalls`），wake 不会伪造成功。
4. WorkItem author lane（`usageLearning.workItemFailures`）暂不支持 PTC：其冻结预授权只有 4 个
   `plugin_source_*` 工具，保留传输不在其中。driver 在创建 Agent 前直接拒绝
   （`PTC presentation is not supported for the WorkItem author lane yet`）；启用该 lane 时需要
   Host 侧预授权或规则后才可开启，本切片不生成。

**未覆盖**：真实 `@deepseek-ai/dsh-ptc-runtime-node` 的沙箱执行与真实模型长跑未验收（本切片不新增
devDependency 或锁文件变更）。聚焦测试用最小 fake `ctx.ptcRuntime` 驱动 Host 原生 `run_code` 桥、
嵌套调度、Policy/guard 与 session 事件，属工程层证据；真实执行测试仅在 runtime 包可解析时运行，
当前跳过。

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
| `toolPresentation` | `native` | 工具呈现模式：`native` 直接发送冻结 allowlist 的每个 schema；`ptc` 只发送 Host 保留的 `run_code` 传输与生成 SDK（见 [PTC 呈现](#ptc-呈现可选默认-native)）。只改呈现，不改 allowlist/审批/预算/输出上限；开启需满足该节全部前置条件，默认关闭且关闭时行为与旧版完全一致。 |
| `budgetId` / `budgetAmount` | 均无 | 必须**同时出现**；显式 wake 经 Policy 预留；usage 作业由 Automations 预留，避免重复扣取。已提交的未知消耗不退回。 |
| `provider` / `model` | 继承会话 | 同时配置以固定修复/成长模型；只配置一个会拒绝。不会自动回退到 Day1。 |
| `reasoningEffort` | 继承会话；固定模型时用供应默认 | 只有同时配置固定 provider/model 时可覆盖。 |
| `apiKeyEnv` | 随供应 | 可选凭据引用名；未设置时由对应 adapter 管理凭据。引用优先经 credentials 解析，再读同名环境变量；不接受或打印明文 key。 |
| `workflowOwnerAnchored.enabled` | `false` | owner-anchored workflow 轨独立开关；置 `true` 时要求驱动本体 `enabled: true` 且已声明 `scope`，否则启动报错。 |
| `workflowOwnerAnchored.maxCommitsPerWake` | `5` | 单轮最多尝试提交的候选数（1–50）；goals/delivery 不可用、authority/route 漂移即中断本轮。幂等重放代价很低。 |
| `pluginSourceProposals.enabled` | `false` | 开启后通过可选 `pluginControlPlane` 服务准备既有插件的 pending 修改提案。缺少该服务或构建器未配置时仍保持四工具基线。 |
| `pluginSourceProposals.repository` | 无 | 开启时必填的绝对规范仓库路径；由 owner 配置，模型不可传入。 |
| `pluginSourceProposals.preparationMode` | `inline` | `inline` 保持本轮隔离构建；`durable` 只把已读、冻结 base 的内容排入 Control Plane 自己的持久队列。队列 authority、构建超时和执行生命周期都由 Control Plane 配置，独立于模型 wake。 |
| `pluginSourceProposals.allowCreation` | `false` | 仅 `durable` 可开启新插件候选。还须配置 Control Plane 的独立 `sourceJobs.creation` 授权；缺少创建读取接口或有效命名规则时保持既有修改工具。 |
| `pluginSourceProposals.allowModification` | `true` | 设为 `false` 时不提供既有插件修改工具；创建读取必须显式使用 `mode: create`。原生创建路径应同时配置 Control Plane 的 `sourceJobs.allowedModes: [create]`。 |
| `pluginSourceProposals.allowRevision` | `false` | 仅在 `pluginSourceProposals.enabled: true`、`preparationMode: durable` 且 `usageLearning.enabled: true` 时可显式开启已采用插件的修订候选；另需 Control Plane 的独立有限修订授权和验收引用。`allowCreation` 不会开启此轨。 |
| `pluginSourceProposals.maxPlansPerWake` | `1` | 每轮源码提案尝试上限（1–5）；inline 的 prepared 与 durable 的 queued 都占用此预算，失败也占一次。 |
| `pluginSourceProposals.isolatedBuildTimeoutMs` | `180000` | 仅 `inline` 使用的构建时间上限（60000–240000ms）；控制面可进一步收窄，单轮 authority 到期仍会取消。`durable` 使用控制面 `sourceBuild.timeoutMs`。 |
| `pluginSourceProposals.offline` | `true` | 源码提案必须离线构建；`false` 配置会拒绝。所选隔离后端须预先准备运行时和依赖。 |
| `pluginSourceProposals.planTtlMs` | `86400000` | 待批 worktree 保留期限（15 分钟–24 小时）。 |
| `workflowOwnerAnchored.lookbackMs` | `86400000` | 只枚举该回看窗口内更新过的 owner goal（1 分钟–7 天）。 |
| `usageLearning.enabled` | `false` | 真实任务触发开关；要求主开关、owner scope、预算及 Evaluation/Automations 服务。 |
| `usageLearning.workItemFailures` | `false` | 严格可选布尔值；缺失/false 在授权摘要中省略，true 要求 usageLearning、durable source、allowCreation 与显式 workItemAuthorities。只允许后台新工具创建；前台 modify/revise 开关不改变。 |
| `usageLearning.workItemAuthorities` | 无 | 后台开关开启时必填的准确四份 pins：sourceJobs（authorityId/authorityDigest/expiresAt）、creationGrant（id/digest/expiresAt）、creationAcceptance（完整独立验收引用）、adoption（authorityId/authorityDigest/expiresAt），外层 protocol 为 `assistant-growth/work-item-authorities/v1`。从已授权当前 CP 免费 readiness 获取并由 owner 显式冻结，不自动补签或扩大旧 grant。 |
| `usageLearning.databasePath` | 无 | 开启时必填的私有 SQLite 绝对路径，保存游标、冻结来源与作业状态。 |
| `usageLearning.maxPending` | `16` | 同时 queued/running 上限（1–100）；满时保留未消费游标，释放容量后继续。 |
| `usageLearning.lookbackMs` | `86400000` | 来源结果最大年龄与排队 TTL（1 分钟–7 天）。 |

所选供应自身的配置键由对应 adapter/插件定义；driver 不重复定义。

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
        # provider: custom-gateway
        # model: configured-model-id
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

- 服务方法 `health()` 返回最近一次唤醒的 `lastWakeAt` / `outcome`（`never-run`/`ran`/`skipped`/`failed`）/ `reason` / 运行用量；PTC 呈现下运行用量另含 `usage.ptc`（有界轨迹摘要，见上文），native 下没有该键。跳过原因包括 `missing-scope`、`missing-binding:*`、`contract-expired:*`、`missing-credential`、`missing-policy`、`budget:*`。
- `health().ownerAnchored`（仅该轨启用且本轮跑过时存在）给本地轨计数：`considered`（窗口内完成的 goal）/ `attempted`（实际尝试提交）/ `recorded`（新沉淀）/ `replayed`（幂等重放）/ `abstained`（多工具等无法归约为单步 agent-turn，诚实跳过）/ `stopped`（非空时为 fail-closed 中断原因，如 `inspect:*`、`authority:*`、`runtime-unavailable:*`）。
- 停用：把 `enabled` 置回 `false`（或移除插件配置）即恢复休眠，不影响已经 staged 的 pending candidate——它们仍只由 owner 在既有 skills/automations 审批面处理。

## 既有插件源码提案

源码审阅与技能沉淀分别执行：启用本能力后，即使没有历史完成目标，也会检查已登记的开放 gap。重复、独立验收成功仍是技能候选的必要条件；源码候选按 gap、读取版本、权限和隔离检查规则准入。

另行安装同批 `plugin-control-plane`，按其 README 配置 owner trust 和隔离构建后端，再给 driver 增加：

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

当可选 Control Plane 提供目标发现接口时，本轮另有 `plugin_source_targets({gap_id})`：先发现当前开放 gap，再读取可信 Git 基线中至多 128 个非保护插件的名称和可选简介。清单来自已提交的正规 manifest，不含工作区脏文件、未跟踪目录、链接、仓库路径或授权字段；简介最多 512 UTF-8 字节，并作为不可信选择线索。清单不证明某插件就是根因，不授权修改，也不能替代读取待替换文件。模型仍须结合原任务证据与源码决定是否修改已有插件，或在独立创建授权下新增能力。

目标清单的首次基线绑定后续修改源码和创建模板读取；若此前已经读取源码，目标发现必须使用同一基线。重复清单、源码或服务提供者发生漂移时拒绝旧上下文；模型不能自行指定基线、仓库或刷新基线继续提交。旧 provider 没有此可选接口时维持原工具面。

Host 在本轮内按 gap 与插件保存首次读取的 commit，后续读取和准备均绑定该 commit；HEAD 变化即拒绝旧上下文。同一文件在同一 commit 的再次读取若内容漂移也会拒绝。完整替换既有文件前必须读取原内容；精确编辑只能作用于已读的既有文件，可在已有目录中增加源码或测试文件。模型不能指定 commit，也不能只凭文件清单覆盖未读文件。服务提供者更换后读上下文与待执行动作一并失效；未提供源码读取接口的旧版 control-plane 保持四工具基础模式。

Control Plane 拥有 worktree、源码快照、隔离构建和 SQLite 写入。`inline` 成功时仅返回待审批 plan id 与检查摘要；`durable` 成功时只返回 content-free job id/status，Host 接受队列后继续以它自己的 durable authority 运行，即使模型 wake 随后到期也不会伪造为 prepared。`plugin_source_job_status` 只在 durable 模式出现，并用当前 Growth authority 的 owner scope 查询 job。owner 仍需通过控制面的签名审批、源码复核和发布流程处理。模型看不到 worktree 路径或构建日志。检查失败、owner route 漂移、provider 移除、插件卸载或本轮到期均终止尚未被 Host 接受的操作。`health().run.sourceProposals` 分别提供 `queued`、`prepared` / `rejected` 数量；可选 provider 更换后下一轮重新绑定，旧轮次不会跨代继续写入。

### 新插件候选

在上述 `durable` 配置中增加 `allowCreation: true`，并在 Control Plane 配置[有限创建授权](../plugin-control-plane/README.md#自动创建新插件候选)。正常使用的可信失败复盘可选择创建新能力，沿用同一原生 AgentLoop、冻结来源模型（或显式 Growth 固定覆盖）、owner、gap 与预算。

gap 的 `capability` 是问题分类，不是现有 `plugin_name`。任务证据没有指向可修复的现有插件时，不猜修改目标；确需新增能力且已有创建授权时才选择创建，并非每个失败任务都要产出插件。创建工具公开 Host 允许的 `namePrefix` 命名规则。模型选择此前缀下尚不存在的插件名后，可首次调用 `plugin_source_read({gap_id, plugin_name, mode: "create", paths: ["README.md", "src/index.ts", "tests/index.spec.ts"]})`，一次取得完整文件清单、冻结 Git base 和这些模板内容；未知路径仍可用 `paths: []` 探索。替换任何模板文件前必须读过其内容，再以 `plugin_source_create({gap_id, plugin_name, files: [{path, content}]})` 排队。创建与修改快照分别绑定；命名规则变化、过期或来源纠正使旧创建快照失效。单轮 `maxDurationMs` 限定本地唤醒时间，不保证模型供应商在默认 120 秒内完成；排队后的 Host 作业另行推进。

可信任务复盘的创建排队另附 Host 私有 source-run 绑定：原生 Automations claim 与真实 Growth Agent setup 后，driver 持久记录任务修订、owner、模型来源、预算、实际 session、工具面摘要和生成截止时间。模型的创建参数没有这些字段；Control Plane 通过可选 provider 重新读取当前绑定，不能从模型输出推断。旧 Usage 记录没有该绑定，不能取得任务绑定创建资格；运行变为 unknown、来源纠正/撤回、配置或 owner 变化及来源过期时读取失败。可用的 reviewed 绑定可跨重启只读恢复，不重放模型工作。修改提案仍沿用原有来源和权限检查。

配置 Control Plane `creationVerifications` 与 Verifier `creationReviews` 后，Agent setup 在首次作者模型请求前将当前验收政策引用持久写入 `creationAcceptance`。恢复继续要求同一未过期政策；历史无引用记录不会补写，也不能由新政策取得签名资格。模型没有选择或更改验收政策的参数；独立行为检查由 Host 原生 SourceJobs 续跑推进，见 [Verifier](../assistant-verifier/README.md#普通任务产生的新插件验收)。

候选只能写 README、源码与测试；manifest、patch、版本、许可证、构建配置、目录行和锁文件由 Host 生成且不能覆盖，不允许新增依赖。创建与修改共享每轮提案预算；Host 另持久计量创建额度，失败和 unknown 也消耗额度。检查通过仅产生 `prepared-create` / `pending-approval`，现有修改审批器不会批准这种计划。候选本身不授予采用权限；显式签名采用与动态加载见 Control Plane，真实任务收益仍待验收。

### 已采用插件的新任务修订候选

本轨默认关闭。在上述 `durable` 源码配置中显式增加 `allowRevision: true`，同时启用下述 `usageLearning`，并为 Control Plane 配置独立的 `sourceJobs.revision` 有限授权、`revisionVerifications` 公开验收引用和已采用插件源码归档；Verifier 对应配置 `revisionReviews`。缺少当前授权、归档读取接口、原生 Usage 来源或验收引用时，不向模型提供修订工具。历史配置省略 `allowRevision` 仍按 `false` 处理，既有运行不会补写新验收引用。

只有**新的、当前仍有效的普通认证失败任务**可进入此轨。Agent 先读取该任务专属的当前 gap，再用 `plugin_source_revision_targets({})` 查看 Host 提供的至多 64 个同 owner 已采用父版本线索 `{parentPlanId, name, parentSourceDigest}`。线索不证明根因。模型只能从该清单选父计划和插件名，再调用 `plugin_source_revision_inspect({parent_plan_id, plugin_name, paths})` 读取父版本冻结的 staged 归档源码；`paths: []` 返回完整清单。路径仅限 `README.md` 与直接位于 `src/`、`tests/` 的代码文件。替换既有文件前必须先读正文，随后以 `plugin_source_revise({parent_plan_id, plugin_name, files: [{path, content}]})` 排队；该工具不接收 `gap_id`、仓库、基线、授权、模型、预算、期限或验收政策。Host 重新核对父归档、当前任务、owner、源码基线和权限。任务纠正、撤回或来源漂移会阻止旧上下文继续提交。

修订与创建、修改共用本轮 `maxPlansPerWake`、模型/工具调用和字节上限，不增加 Agent 循环。首次作者模型请求前，Growth 把**这次新任务**的实际 supplier、预算、任务修订、工具/执行摘要与 `revisionAcceptance` 固定到 source-run；可选回归授权已配置且 provider 提供当前引用时，同步冻结独立的 `revisionRegressionAcceptance`。恢复和后续 Host 读取要求已冻结引用仍与当前政策的规范摘要一致且未过期；政策变化会拒绝旧 run，不会补写新引用。它可以与独立的 `creationAcceptance` 同时存在，但创建授权、旧任务和旧创建额度都不能替代修订或回归授权。旧 provider 未提供回归引用、或历史 run 没有冻结该字段时，原有 `prepared-revise` / `pending-approval` 候选仍只是原候选，不能追认回归证书或因新增配置取得回归资格。

排队仅返回 `revise-created` 作业的无内容状态；后续独立验收最多形成 `prepared-revise` / `pending-approval` 候选及修订凭证。已冻结回归引用的候选可由 Host 调用独立的父保留用例比较并取得回归凭证，见 [Verifier](../assistant-verifier/README.md#已采用插件的新任务修订验收)。这些凭证都不授予候选执行、替换当前版本或扩大旧创建采用额度；版本切换/回滚和后续真实任务收益尚需分别验证。

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

普通任务来源保留实际执行时的 binding 版本和代次。同一主人 `/new` 后，任务驱动的复盘及已检查候选可以在原窗口内继续；每次使用仍核对当前 route、主人记录与版本、workspace、preset 和 canonical 修订。重新配对、撤权、授权变化或代次倒退会拒绝继续。新 Session 不改写原来源、模型、预算、额度或期限；其他显式 Growth wake 保留原 binding 栅栏。

同时启用 `pluginSourceProposals` 后，可信 `not-achieved` 前台结果会在模型启动前自动登记 Control Plane 私有 gap，无需预先人工登记。Host 重新读取 Delivery 来源，在 Evaluation writer fence 内记录 owner、任务修订和来源摘要；gap 不保存任务原文，默认 ROI 为未知占位值 0。成功、unknown、撤回、未结束及截断来源不产生失败 gap。新控制面接口缺失时失败关闭，不读取全局手工 gap。

源码检查、最终计划提交及 durable job 的排队、恢复和执行都重新核对来源。完整原执行 owner receipt 固定后，同主人 `/new` 可在原授权窗口内继续；身份或授权变化、纠正或撤回会拒绝旧来源继续产出计划，历史引用保留。Driver 负责候选生成；后续有限审批、发布、独立审查、采用与真实任务观察由另行配置的 [Control Plane](../plugin-control-plane/README.md) 接续。组件已接线，可安装部署与独立行为验收尚未贯通，不能据此宣称生产自迭代已完成。

### 后台失败的工程来源

后台分支使用 schema3 的独立 WorkItem 游标与持久定位表；旧前台游标、意图 JSON、摘要、source-run 和 unknown 保留。仅当前认证 not-achieved 可登记，同 item/canonical 修订只接纳一次。先原子保存定位与游标，再完整读取工程上下文；reader 或 peer 临时缺失保留同定位及原到期时间，不返还或重置 Policy/Automations 额度。

工程 objective 是 Delivery 逐段核对的根→当前 child 原样主人输入及有版本 JSON framing，总 UTF-8 不超过16KiB；不得改用 worker brief、根目标摘要或 owner 反馈。背景报告与反馈分栏作为不可信材料，封存 manifest 绑定精确父链及报告版本。完整来源、原 supplier（或显式固定覆盖）、有限预算与 pins 在 Delivery → Evaluation → WorkItems → UsageStore writer frame 内冻结后才进入原生作业；缺失 reasoning effort 保持缺失。同 owner 新 Session 不改写冻结 owner/source-run 摘要。

CP 免费 readiness 必须明确返回工程来源协议、source-run v2、后台能力及完全相同且未过期的 pins。schedule/activate、claim 和首次 LLM 前要求正余额与 available；缺方法、旧协议或摘要不符时不启动付费作者。既有 run 不因自己的末次额度消耗而失效；后续授权仍核对当前活 peer、原 pins、来源及各独立账本。后台作者只看到 gaps/read/job-status/create 工具，不进入技能写、modify/revise 或通用成功轨。候选仍需独立真实构建、held-out 验收及采用，不把主人 testimony 或工具成功当证书。

后台四个 source 工具还要求当前 Policy 的 WorkItem Growth 预授权能力。仅实际发布的 `dsh-enhanced-assistant-growth-driver` plugin Fiber 可注册本 Agent realm 的准确工具定义；注册初始不可用，真实持久化 v2 source-run 返回并匹配 session、occurrence、来源、工具摘要及预算后才启用。每次执行重核当前 owner/source、Policy、期限和工具次数，关闭或取消立即撤销；此许可仅跳过这四个工具的逐次审批，不绕过 Policy 的 execute 规则、预算或急停。前台 v1 仍保留既有审批流程，后续普通任务调用新工具也沿用其真实前台权限/审批通道。

source-run v2 producer 将持久 binding 深冻结后，在真实 UsageStore writer frame 内交给同步 CP consumer；禁止 thenable、同实例写方法重入及上游回读。running/reviewed 才可提供通用 producer 授权；unknown 保留原作业且不重派、不重扣，不能借其创建新作业或签新采用授权。旧 v1 协议与校验保留。本轮包内 fixture 不证明真实跨包工程创建/采用/后续工具调用链，完整组合与长期真实收益仍需独立验收。

### 显式 native 验收入口

Node 24+，在仓库根目录显式准备资源；替换绝对仓库路径与已验证提交（Linux 两项均必填）。准备可能下载依赖，不会由普通根检查自动执行：

```sh
node --experimental-strip-types plugins/assistant-growth-driver/tests/work-item-engineering.native.ts --prepare-macos /absolute/repository 876f4b66760cca67d619e8848e414e58edb8698a
node --experimental-strip-types plugins/assistant-growth-driver/tests/work-item-engineering.native.ts --prepare-linux /absolute/repository 876f4b66760cca67d619e8848e414e58edb8698a
```

保存输出的 `resourcePath` 后，从 `plugins/assistant-growth-driver` 目录运行：

```sh
CI=1 VITEST_MAX_WORKERS=1 DSH_WORK_ITEM_ENGINEERING_RESOURCES=/absolute/native-resources.json node ../../node_modules/vitest/vitest.mjs run --dir tests tests/work-item-engineering.integration.spec.ts
```

Linux 需要预先存在的 delegated cgroups/user namespace helpers；准备命令不更改主机设置。未配置资源时跳过 native 项，跳过不是验收。helper 的静态/无命令检查不证明完整链路；完整 native 创建、验收、采用与后续真实任务调用仍按独立结果核验。

## 权限与数据

- 网络：经本轮冻结的 DSH 模型 adapter 发出请求，目标及凭据由该供应配置决定；没有模型之外的网络工具。
- 文件系统：启用 `usageLearning` 后写私有 SQLite（文件权限 `0600`），保存冻结任务正文、owner 与模型，未自动清理历史。前台正文最多 4096 字符；后台完整 objective 最多16KiB，另有封存背景报告（单条64KiB、合计256KiB）和有界反馈。均经 owner 校验后作为不可信数据交给获授权的成长模型；Automations 定义与公开 health 不含正文。skill candidate 由 Skills 入库，源码提案经 Control Plane 写入其私有 worktree 和 SQLite。
- 子进程：源码轨开启时委托 Control Plane 调用 Git 与实际隔离 runner（按 CP 配置支持 native 等后端）构建；构建权属于 owner 配置的 Control Plane，见其权限说明。driver 无浏览器能力。
- 凭据：只读解析一次凭据引用（存在性检查），不持久化、不回显、不入日志。
- 审批/策略：每次沉淀与每个工具调用都在 service 边界经 `assistant-policy`；空规则默认拒绝。driver 只产候选；独立 CP 另获创建审查与采用授权后可有限 adopt，driver 不直接 activate/install。

## 明确不做（边界）

- 不自主发起/执行 goal、不提议 guidance、不记 capability gap。
- 不 activate / install / retire / rollback、不扩权、不改 policy 规则表、不碰预算上限与急停等安全根。
- owner-anchored 轨只提交 locator：证据（objective、步骤、验收结论）一律由 Delivery 持 goals 独立重取，driver 不接受调用方自带 prompt，也不自造 trace source/authority。
- 源码轨只到经过检查的 pending 提案；owner 签名、发布、生产启用和 HMR reload 由独立控制面处理。
- owner-anchored 轨的证据是 Delivery 在进程内对真实 goals SQLite 的独立复核（工程层）；真实外部供应商端到端与真实外部平台深评测均不在本期，前者仅由 owner 显式 opt-in 后手动触发一次。

## 兼容性

See the repository [compatibility baseline](../../docs/compatibility.md)。


扫描器在启动、原生派发及来源复核前先检查 Automations 的持久退休标记与 Delivery 的当前 owner 状态。仅准确 owner 被持久撤销时，以原定义摘要及版本退休自身扫描 cron；旧任务、unknown、请求、grant 与已用预算原样保留，不再做旧来源失效或自动回退扫描。退休标记跨重启和身份切回保留，相同扫描 ID 不会自动复活。新 owner 必须使用显式配置的新代次，不能转移旧授权。

缺失 binding、临时数据库/连接故障不触发永久退休；扫描器保留原生 executor、事件或 cron 恢复入口。退休查询暂不可用时，仅尝试由 Automations 的事务与数据库退休栅栏准入原扫描 cron；明确退休、明确撤销或退休被 Policy 拒绝时不激活。若注册也暂时失败，未完成初始化的实例由现有原生 scheduler wake 重试初始化；成功后只沿原 cron 和预算扫描，不增加业务扫描频率。恢复初始化不派发业务工作或消耗新的学习 admission。Policy 拒绝退休时同样阻止新工作，并报告失败；不把拒绝当退休成功。卸载仍独立取消及有界等待本扫描器拥有的执行，不关闭普通聊天或整个插件。
