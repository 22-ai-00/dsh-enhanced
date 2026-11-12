# @dsh-enhanced/assistant-dreaming

默认关闭、owner 显式启用的"做梦/突发奇想"插件。启用后它以低频率、确定性随机、
空闲感知的方式回顾**已认证的历史投影**（可信任务投影、owner 目标、活动技能的
有界摘要），在随机时刻让一个冻结的单工具 Agent 产生少量结构化 idea，并只写入
插件私有的 SQLite 账本。

它**不是**成长复盘：输入是跨任务的模式与空白，输出是未验证假设。默认级别 L0
（仅私有 idea），默认不通知、不开 Goal/WorkItem、不形成候选、不自动采用；模型输出
schema 不允许任何评分/置信度/自收益字段，沉默不算正向。

## 召回抽奖（"无事找事"）

在触发门（活跃时段/空闲/日上限/概率抽签）全部通过后，wake 不会直接调用模型，
而是先跑一段纯代码的 per-subject 抽奖：每个可回顾对象（任务投影、目标、技能，以及
本 lane 尚未了结的已记录 idea）由 `HMAC(seed, lane+kind+key)` 派生出一个
`[0, 1_000_000)` 内的稳定**票号**并登记入账；每个 wake 槽位再由
`HMAC(seed, lane+occurrence)` 滚出一个**开奖号**，票号落在开奖号环形窗口
（默认 ±5,000，约 1%）内的对象被"召回"。已了结（validated/rejected/withdrawn）
的 idea 每 wake 清理其票，不再被召回。没有任何票命中是正常的无思考槽位：
执行器返回 no-effect success（`failureCode` 恒为 `none`，跳过原因保留在
`health().lastSkipReason === 'lottery-no-hit'`），完全不调用模型；命中时才启动
Agent，并把
被召回对象作为聚焦提示注入（recorded-idea 附带其 summary），模型围绕它展开思考。
全程确定性、可审计、可重放，随机性只来自 owner seed 的 HMAC，代码里没有
`Math.random`。

## 信任边界与权限

- Cordis 注入：`assistantAutomations`、`assistantDelivery`、`assistantEvaluation`、
  `assistantGoals`、`assistantSkills`、`agents`、`sessions`、`tools`（全部是 Host
  提供的服务）。模型调用本身经 `agents`/Agent Loop 与 Host 的 `llm` route 发生，
  不直接持有 `llm` 服务；`assistantAutomations` 自带 `assistantPolicy` 依赖，授权与
  预算检查发生在 Automations 边界。可选 `assistantPolicy` 存在时，插件会把 dream
  Agent 绑定为 `background` initiator，避免前台规则/人工审批语义渗入无人值守 wake。
- 不读 Memory、不读原始 transcript/工具参数/验收回执、不读凭据；所有输入是 Host
  投影后的有界摘要，每条带证据摘要，idea 必须引用本 wake 材料内的证据 digest。
- 工具面冻结为恰好一个 `dream_submit_ideas`；其余全局工具在 Agent setup 中
  `restrict` 拒绝，并做精确 allowlist 断言。真实 Host 的 Policy 仍会检查这次工具
  调用，默认拒绝的部署需要为它添加一条后台 allow 规则（见“安装与启用”）。
- 每次 occurrence 的预算预留/结算由 `assistant-automations` 持有；dreaming 执行器
  不再重复预留，只在自己的账本里按 `maxDreamsPerDay` 计日上限。模型/工具调用
  次数、输出 token、时长、输入字节、每日次数都有硬顶。
- 随机性是 `HMAC(seedDigest, lane+occurrence)` 的确定性抽签，可审计可重放，从不
  调用 `Math.random`。

## 配置（全部默认关；未知字段拒绝）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 关闭时不注册 automation、不打开数据库、零写入。 |
| `retired` | `false` | owner 暂停开关：`enabled: true` 且 `retired: true` 时加载即把 system automation 收敛为 paused、不注册执行器（账本照常打开并执行保留期），用于暂停后再关闭/卸载。必须同时 `enabled: true`；`enabled: false` 时保留 `retired: true` 会 fail-closed 报错（disabled 路径无法 pause，不能让 owner 误以为已退役）。去掉该标志后的下一次加载用新的 reconcile key 恢复 active。 |
| `scope` | 无 | `workspace/preset/principalId/ownerRouteId`；启用时必填。 |
| `databasePath` | 无 | 私有 SQLite 绝对规范路径；启用时必填，目录不可组/全局可写。 |
| `baseIntervalMs` | `3600000` | 抽签节拍（15 分钟–24 小时），复用原生 Automations `every`。 |
| `runProbabilityPpm` | `250000` | 每节拍抽中率（0–1,000,000）。 |
| `idleMinMs` | `1800000` | 距最近可信活动至少 30 分钟才触发；缺活动标记 fail-closed。 |
| `lotteryWindow` | `5000` | 召回开奖号环形窗口半宽（0–500,000；0 = 仅精确票号命中），按命中率调节召回频率。 |
| `activeHours` | 无 | 同日窗口 `timezone/startMinute/endMinute`，不跨午夜。 |
| `randomSeed` | 无 | 可选 HMAC seed；只持久化其 digest。 |
| `maxDreamsPerDay` | `3` | 每日做梦次数硬顶（1–24）。 |
| `maxIdeasPerWake` | `3` | 每次 wake 最多 idea 数（1–5）。 |
| `maxModelCalls` / `maxToolCalls` / `maxOutputTokens` / `maxDurationMs` | `2/1/2048/90000` | 单轮冻结上限。 |
| `maxInputBytes` / `maxEvidenceRefs` | `16384/8` | 输入材料上限。 |
| `notifyOwner` | `false` | L1：开启后在每日/间隔门内发一条有界 owner 摘要（仅计数与前 3 条 summary，经 Delivery 认证通知通道；撤回/拒收不推断），默认关闭。 |
| `maxNotificationsPerDay` | `1` | L1 每日通知硬顶（0–3），不得超过 `maxDreamsPerDay`。 |
| `notifyMinIntervalMs` | `86400000` | 两次 L1 通知的最小间隔（1 分钟–7 天）。 |
| `budgetId` / `budgetAmount` | 无 | 必须成对；启用时必填，写入 system automation 定义，由 `assistant-automations` 在每个 occurrence 前预留并结算。Policy 里要有同 id、metric 为 `automation-runs` 的 budget。 |
| `provider` / `model` | 无 | 供应商中立通用字段，必须成对；启用时必填，必须是 Host 已注册的 LLM route。`reasoningEffort` 可选。 |
| `retentionDays` | `90` | idea 保留期；插件加载时与每次成功做梦后硬删除过期 idea。 |

启用时 fail-closed 校验：scope（含规范绝对 `workspace`）、规范绝对 `databasePath`、
provider/model 对、budget 对、`maxNotificationsPerDay <= maxDreamsPerDay`、activeHours
同日窗口；任何一项不满足直接拒绝装配。

## 安装与启用（真实部署）

插件默认关闭：安装后 `enabled: false`，不注册 automation、不打开 SQLite、零写入、
零模型调用。

1. 安装 bundle（npm 发布后）或把本地打包 tarball 装进目标 profile：

   ```sh
   dsh plugin --profile <profile> add @dsh-enhanced/assistant-dreaming@0.1.67
   # 或本地验证：pnpm --dir plugins/assistant-dreaming pack --pack-destination /tmp
   # dsh plugin --profile <profile> add /tmp/dsh-enhanced-assistant-dreaming-0.1.67.tgz
   dsh --profile <profile> --dump-config | grep -A2 assistant-dreaming
   ```

   `dsh plugin add` 会把包注册进 profile 的 `dsh.profile.bundles`，bundle patch 插入
   一行 `dsh-enhanced-assistant-dreaming`（无 config，即关闭状态）。

2. 在 profile 的 `cordis.patch.yml` 里按 id 覆盖该行，写入启用配置（值按实际 owner
   替换；行内 config 是整段替换，不是深合并）：

   ```yaml
   - id: dsh-enhanced-assistant-dreaming
     name: '@dsh-enhanced/assistant-dreaming'
     config:
       enabled: true
       scope:
         workspace: /Users/<owner>/.dsh/assistant-workspace   # 规范绝对路径
         preset: standard                                     # 必须是该 workspace 的 Agent preset
         principalId: <existing-delivery-principal-id>
         ownerRouteId: <existing-delivery-owner-route-id>
       databasePath: !!js dshHomePath('assistant-dreaming/dream.sqlite')
       baseIntervalMs: 3600000          # 1 小时一个抽签槽
       runProbabilityPpm: 250000        # 1/4 槽位通过触发门
       idleMinMs: 1800000               # 距最近可信活动 ≥30 分钟
       lotteryWindow: 5000              # 每个 subject 每槽约 1% 召回率
       activeHours: { timezone: Asia/Shanghai, startMinute: 480, endMinute: 1380 }
       randomSeed: "<owner 提供的 ≥16 字符 seed>"
       maxDreamsPerDay: 3
       maxIdeasPerWake: 3
       budgetId: assistant-dreaming-runs
       budgetAmount: 1
       provider: <host-registered-llm-provider>
       model: <host-registered-model-id>
       # 可选 L1 摘要通知；默认关闭：
       # notifyOwner: true
       # maxNotificationsPerDay: 1
       # notifyMinIntervalMs: 86400000
   ```

3. Host 侧前置条件（缺一不可，缺失时按 fail-closed 处理而不是伪造成功）：

   - **Automations 调度器**：目标 profile 的 `assistant-automations` 行必须
     `schedulerEnabled: true`（插件默认 `false`），否则 automation 注册成功但永远
     不会触发；同时 `allowUnbudgetedExecution` 保持默认 `false`。
   - **Policy 预算**：`budgetId` 必须在 `assistant-policy` 的 `budgets` 里存在且
     metric 精确为 `automation-runs`；Automations 在每个 occurrence 调用执行器前
     预留、结束后结算 `budgetAmount`。因为**每个调度槽**都会消耗一次，budget 的
     limit/period 至少要覆盖该周期内的槽位数（例如 1 小时节拍 + 每日 limit 24），
     否则当天晚些槽位会因预算耗尽跳过。

     ```yaml
     budgets:
       - id: assistant-dreaming-runs
         metric: automation-runs
         limit: 24            # 1 小时节拍时覆盖一天 24 个槽
         periodMs: 86400000
         scope: subject
     ```
   - **Policy 规则（默认 deny 的 profile 必须配，否则加载即失败）**：
     `assistant-automations` 在**加载时**先以 background subject
     `{kind: background, id: 'assistant-dreaming', workspace, principal}`、
     action `reconcile` 请求授权（缺失时 `reconcileSystem` 抛 policy-denied，插件
     等加载失败并已自行清理），每次 occurrence 又以
     `{kind: background, id: <automationId>, ...}`、action `execute` 授权。
     因此 automation 规则要同时覆盖 `reconcile` 与 `execute`，subject id 用
     `'*'`（owner id 与 automation id 都会出现），workspace/principal 必须与
     scope 精确一致（身份字段不能用通配）。冻结 Agent 里的唯一工具
     `dream_submit_ideas` 也要 allow；dream Agent 已绑定 background initiator，
     所以用 `initiators: [background]`。若 profile 已设
     `toolDefaultEffect: allow`，工具规则可省略。示意：

     ```yaml
     rules:
       - id: assistant-dreaming-automation
         effect: allow
         subject: { kind: background, id: '*', workspace: /Users/<owner>/.dsh/assistant-workspace, principal: <principal> }
         actions: [reconcile, execute]
         resource: { kind: automation, id: 'dsh-enhanced-assistant-dreaming:*' }
         context: { initiators: [background] }
       - id: assistant-dreaming-submit
         effect: allow
         subject: { kind: agent, id: standard, workspace: /Users/<owner>/.dsh/assistant-workspace, principal: <principal> }
         actions: [execute]
         resource: { kind: tool, id: dream_submit_ideas }
         context: { initiators: [background] }
       # 仅 notifyOwner: true 时需要（L1 摘要走 Delivery 后台 send）
       - id: assistant-dreaming-notify
         effect: allow
         subject: { kind: background, id: 'assistant-dreaming-idea-summary/v1', workspace: /Users/<owner>/.dsh/assistant-workspace }
         actions: [send]
         resource: { kind: message, id: '*' }
         context: { initiators: [background] }
     ```

   - **Delivery owner route**：`ownerRouteId` 必须是 Delivery 中既有的、已认证 active
     route；生成输入材料前会用当前 route 重新校验，缺失/撤权时该 wake 以
     `dream-material-unavailable`（配置类失败、零模型调用）结束。开启
     `notifyOwner` 时还需要上面的 Delivery `send` 规则；Delivery 校验失败时不发送，
     插件把通知失败当成“不影响做梦结果”，不伪造送达。
   - **模型 route**：`provider`/`model` 必须是 Host LLM 插件已注册的 route；dreaming
     不携带凭据，也不读环境变量里的 key。

4. 启用后产生的副作用：

   - 每个通过触发门且召回抽奖命中的槽位会创建一次冻结 Agent 并调用**付费模型**
     （上限 `maxModelCalls`/`maxToolCalls`/`maxOutputTokens`/`maxDurationMs`）；
     未命中抽奖的槽位零模型调用。
   - 写入 `databasePath` 指向的插件私有 SQLite（WAL/SHM；目录必须 owner-private，
     组/全局可写会拒绝启动）：`dream_runs`/`dream_ideas`/`dream_idea_events`/
     `dream_counters`/`dream_tickets`/`dream_recalls`。
   - 默认只有私有 idea，不写 Goals/WorkItems、不创建候选、不自动采用、不发消息；
     `notifyOwner: true` 时才通过 Delivery 认证通道发有界摘要（每日/间隔门内）。
   - 自有 idea 读取：服务只读 `health()` / `inspectIdeas()`。`retire()` 方法会
     暂停 system automation、注销执行器并保留账本，但**仓库当前没有普通 owner 可
     直接调用的 retire 入口**（它是 Host 侧 service API，只有测试/新的 Host 调用方
     会用到），所以 owner 的实际退役路径是配置项 `retired: true`：
     1) 在 profile patch 里保持完整配置、加 `retired: true`，重载/重启 profile：
        automation 收敛为 paused、执行器不注册；构造失败时插件会自行回滚
        executor 与账本再抛错，不会留下半装状态；
     2) 确认 paused 后，把 `enabled` 设为 `false`（或移除/卸载 bundle）；**同一次
        修改里必须删除 `retired`**：`enabled: false` + `retired: true` 会被配置
        fail-closed 拒绝（disabled 路径在 reconcile 之前就返回，根本不会 pause，
        接受该组合会制造“看起来已安全退役”的假象）；
     3) 恢复时删除 `retired`（或设 false）并重载：active 与 paused 的 reconcile key
        都按每次加载生成（Automations 对相同 key 回放旧收据），所以 resume、
        重复 retire、resume 后再 retire 都能收敛到目标状态，不会被旧收据挡住。
        代价是每次加载多一条 system-reconcile 审计收据（已知限制 P2）。
     若已误把 `enabled` 改成 false：Automations 在 materialize 阶段就找不到执行器，
     会为每个到期 slot 记录 availability incident（**不产生 run**，也没有模型调用），
     需要用 Automations 的 owner/system ownership 入口暂停或删除该
     `dsh-enhanced-assistant-dreaming:*` 行，然后重载 profile。

## 账本

`dream_runs`（每次抽签/运行与 drawDigest）、`dream_ideas`（含状态机
`recorded → owner-acknowledged → validated/rejected` 或 `withdrawn`，同 lane 同日
同摘要去重）、`dream_idea_events`、`dream_counters`（每日做梦/通知计数）、
`dream_tickets`（每个 subject 的稳定票号，重复登记不覆盖原票）、`dream_recalls`
（每次开奖命中的审计行，槽位重放幂等）。
`PRAGMA user_version=2`（schema 2 仅对 1 做加法迁移），schema 变新即拒绝启动。
插件加载时把重启遗留的 running 行改为 `interrupted`，并按 `retentionDays` 硬删除
过期 idea（每次成功做梦后再执行一次）；`dream_runs` 的审计摘要保留。

## 不做的事

- 除可选 L1 摘要通知外不发消息；不读 Memory（S4）、不读 web、不调用任何写工具或
  Goal/WorkItem 候选 API。
- 不评分、不排序、不把工具成功或 owner 沉默当作收益证据；任何"采用"只认后续真实
  owner 动作或独立验收轨道。
- 不新建循环或定时器：调度完全走 `assistant-automations`，`misfire: skip`、
  `overlap: skip`、`retrySafety: never`、`maxRetries: 0`，重启后 running 仅转
  `interrupted`，不自动重放；错过的 slot 不会补跑，避免停机后集中产生付费调用。
- 执行器不自行预留预算：每个 occurrence 的 Policy budget 由 `assistant-automations`
  在调用执行器前预留并结算，执行结果只报告 outcome/副作用/可重试性，不报告预算结算。

## 已知限制

- P2：active 与 paused reconcile key 都带每次加载的 nonce，每次加载会向 Automations
  的 system-reconcile 审计表追加一条收据；行数随插件加载次数增长（低频、只增不改）。
- P3：`retired` 参与 configDigest，而 configDigest 也用作 definition 的
  `activationNonce`；切换 retired 会更新 system automation 的 definition hash。
  这是 resume 时重新收敛定义的结果，不影响正确性，但审计上会看到 definition 版本变化。
- P5：两个真实 `HostAutomationExecutorRegistry` 用例在 sibling
  `assistant-automations/lib` 不存在时跳过（`pnpm check` 先 build，正常会执行）；
  镜像终态断言始终执行。
- enabled:false 不会自动 pause 上次注册的 system automation（需要 Policy
  `reconcile` 授权且与“关闭零写入”冲突）；必须按上面的 retired 顺序退役。

## 测试

`pnpm --filter @dsh-enhanced/assistant-dreaming test`（54 个用例，6 个文件）：
config fail-closed、确定性抽签/active-hours/idle/日上限门、确定性票号/环形窗口匹配、
SQLite 账本/状态机/保留期（含带生命周期事件的过期 idea）/schema 1→2 迁移/ownData
防护、L1 通知路由验证与 fail-closed、真实 AgentLoop 冻结单工具集成，以及真实
Cordis 装载测试：

- 默认导出服务类可被 `ctx.plugin` 以 `(ctx, config)` 装载；关闭态不注册 automation、
  不注册执行器、不打开 SQLite。
- 启用态 reconcile 出的 system automation 定义（`every`/锚点/interval、
  `misfire: skip`、`overlap: skip`、budget、Host execution spec）与注册的
  `assistant-dreaming-v1` 执行器 allowlist。
- 执行器 4 条 wake 路径（preview / 触发门未过 / 抽奖未命中 / agent 失败 + 成功提交
  idea）的终态在测试里用本地镜像断言检查，并在 `assistant-automations` 构建产物
  存在时，额外用**真实** `HostAutomationExecutorRegistry.execute`（生产侧在
  `host-executors.ts` 的 `validateHostExecutorResult` 校验）跑真实注册/执行路径；
  镜像断言不是生产校验器，只为在无 sibling 构建时覆盖插件侧终态。
- 构造失败（例如 reconcile 被 Policy 拒绝）会回滚已注册 executor 与账本并抛错，
  回归测试验证：失败后 registry 无残留 descriptor、下一次装载能成功（含真实
  registry 的 duplicate-descriptor 断言）。
- 加载时按 `retentionDays` 清理过期 idea（先删事件再删 idea，事件外键不会让保留期
  静默失效）；`retire()` 暂停 automation 但保留账本；`retired: true` 加载为 paused
  且不注册执行器。
- 状态收敛回归：retire 后重载恢复 active；**retired → resume → 再次 retired 必须
  paused**；**reload 后调用 retire() 必须 paused**（paused reconcile key 也必须
  每次加载唯一，否则旧 paused 收据会让行卡在 active 而插件已 dormant）。

完整真实模型长跑与真实通知发送留待运行验收；`test` 不访问网络、不调用真实模型。
