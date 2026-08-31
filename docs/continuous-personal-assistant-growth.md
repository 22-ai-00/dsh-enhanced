# 持续成长的个人助理

## 目标

在不依赖模型本身升级的前提下，让个人助理从日常使用、可验证任务结果、长期记忆、故障恢复和少量用户纠正中持续改进。系统应当越来越了解唯一 owner 的偏好和工作方式，也应当能够发现能力缺口、验证改进并安全回滚。

这里的“持续成长”指长期、复利式、受预算约束的改进，不指无限资源、无边界权限或能够修改自身安全边界的执行体。

## 当前个人优先交付口径

完整目标仍包含后文的长期运维、恢复与能力工厂，但个人助理的首个可用里程碑不以这些重型能力为前置条件。普通 Lark 场景必须在不安装 Health、Heartbeat 或 Recovery 的情况下形成一条无人编排的低风险闭环：完成的 authenticated owner 对话产生不含正文的持久偏好证据，达到固定阈值后自动启用 Host catalog 内的 T1 overlay，真实下一轮提示词记录 exact exposure，明确的持续偏好纠正能够回滚被暴露的版本并自动启用新选择。使用者只需正常对话；不需要手工写数据库、调用学习 API、运行维护命令或逐条批准 T1 变化。

跨任务 Evaluation/Evolution、固定 Recovery runbook 与能力工厂仍可作为显式 supervised/实验能力启用。自由文本 guidance、新插件、外部承诺、权限扩大和不可逆动作不会因为“个人优先”而自动获批；它们不属于上述普通使用闭环的完成证明，也不能被包装成已经全自动上线。

## 成功状态

完成形态需要同时满足以下条件：

1. DSH 由外部 supervisor 常驻监管，重启后恢复任务、投递、审批、评测与成长周期。
2. 每个重要任务都能区分执行完成、目标达成、结果送达和用户价值，不再把 Agent loop 正常结束等同于成功。
3. 系统能结合 user-confirmed Memory、当前任务约束和可验证证据进行自评；模型自评始终保留为低信任信号。
4. 系统能从重复失败、返工、纠正、低效和能力缺口中形成有证据的改进候选。
5. 用户偏好以可解释、可纠正、可衰减、可删除的假设累积；当前明确指令始终优先。
6. 行为 guidance、workflow、Skill 或插件改进必须经过 replay、shadow/canary、预算和回滚门。
7. Policy、凭据、评测基准、预算上限和外部 supervisor 不可由成长执行体修改。

## 两类反馈

个人助理不能假设 owner 会频繁点击“有用”或填写评分。反馈分为两类。

### 可验证反馈

优先作为可信证据：

- 单元测试、lint、typecheck、构建和业务断言；
- 文件、任务、日程、消息等外部系统的结构化回执；
- Automation 的执行、超时、工具限制和投递状态；
- owner 通过认证绑定发出的明确纠正、重做、取消、批准或拒绝；
- 同一目标是否在短时间内被重复请求或人工修复。

### 自评反馈

固定模型也可以结合任务要求和 Memory 做复盘，但结果只能标记为 `self-reported`：

- 先检索当前 workspace 与 user-global 的已确认偏好和约束；
- 列出本次任务的可验证验收项；
- 对每项给出 passed、failed 或 unknown，不允许用“感觉完成”替代证据；
- 保存 evaluator id/version、引用的 Memory id 和结果 evidence ref；
- 只有独立证据或后续用户行为支持时，才能提升为可信结果。

自评可用于发现问题、生成候选和安排复查，不能单独授权生产变更。

## 统一结果模型

评测层至少分离以下状态：

```text
executionStatus  = succeeded | failed | timed-out | cancelled | unknown
objectiveStatus  = achieved | partial | not-achieved | unknown
deliveryStatus   = delivered | failed | unknown | not-required
```

一条 outcome 还应包含：

- `workspace + agentPreset` 的稳定 scope；
- `situation`、task/session/run 标识与幂等键；
- `source`、`trust`、evaluator id/version；
- 有界 evidence references，而不是无界复制原始正文；
- latency、token、tool call、retry 和成本等有界指标；
- 可选的 rule id/generation、automation id 和 delivery ref；
- 发生时间、记录时间和 schema version。

评测证据优先级为：确定性断言与外部回执、owner 明确反馈、规则化检查、独立 reviewer、执行 Agent 自评。

## 用户偏好模型

`personal-memory` 继续作为确认后长期事实和偏好的唯一真源。推断层维护候选；只有 Host 固定目录里的低风险、局部、可逆偏好可以作为带 TTL 的 tentative overlay 生效，不能混入 Memory 或伪装成已确认事实：

```text
PreferenceHypothesis
  key / value / scope / sensitivity
  claimState  = tentative | proposed | confirmed | rejected | expired
  effectState = shadow | active | suppressed | rolled-back | inactive
  confidence / supportCount / contradictionCount
  evidenceRefs / sourceTrust
  firstSeenAt / lastSeenAt / expiresAt
```

规则：

1. 当前明确指令 > workspace 确认偏好 > user-global 确认偏好 > tentative 假设。
2. 重复行为只能提高假设置信度；未经确认不能伪装成 `user-confirmed`。
3. “不要再做”与明确纠正是强负反馈，应立即抑制同类建议。
4. 偏好按领域和 workspace 隔离，随时间衰减；长期稳定且低敏感的条目才建议晋升 Memory。
5. 不被动推断健康、宗教、政治、身份、财务等敏感属性。
6. owner 能查看“为什么这样判断”、确认、纠正、导出、删除或关闭学习。
7. 高置信度影响建议和排序，不等于操作权限。

## 风险分级自治

成长动作默认由 AI 选择和排序，审批依据是动作的实际影响，而不是“是否由 AI 发起”。风险级别由不可自修改的 Host 目录判定；模型不能为自己的动作降级、修改目录或扩大预授权范围。

因此人工审批应当是高后果例外，而不是 AI 每走一步都要请示：AI 在已委托的权限、预算和数据边界内自主决定做不做、何时做、先做什么，并对低风险失败自动撤销；只有可能伤害人、形成法律/财务/对外承诺、扩大隐私或安全暴露、不可逆破坏，或要求扩大自身权力时才升级 owner。这里保留的是“危险动作的否决权”，不是把日常成长重新变成人工编排。

| 等级 | 默认处置 | 典型动作 |
|---|---|---|
| T0 观察/影子 | 自动 | 收集有界指标、形成假设、离线 replay、shadow 对比、ROI 排序。 |
| T1 局部可逆 | 自动，带 TTL、预算、暴露记录、circuit breaker 和回滚 | 回答长短/结构/语言、建议排序、停用表现退化的 guidance、固定 runbook 自愈。 |
| T2 高影响 | AI 自主形成 exact proposal，owner 审批后执行 | 敏感长期 Memory、跨 workspace、对外承诺/联系人、真实资金、明显费用变化、provider 或数据边界、不可逆删除。 |
| T3 安全根 | 禁止成长执行体自行扩大或移除 | Policy 的授权上限、凭据、风险目录、评测基准、预算上限、紧急停止、审计保留、顶层使命和敏感属性推断。 |

人工审批不是唯一保护。T0/T1 仍必须通过确定性 schema、精确 scope、硬预算、幂等账本、可观测 exposure、回归阈值和自动回滚；证据不足时保持 shadow，不把不确定性伪装成成功。不可逆删除、对外承诺、隐私边界变化和会影响他人的动作即使看起来“常规”，也不能因为模型有信心而降到 T1。

## 改进循环

```text
任务 / 反馈 / 运行指标
        ↓
Outcome 与 Evaluation 账本
        ↓
机会检测：重复失败、返工、成本回归、能力缺口、偏好冲突
        ↓
改进候选：假设、预期收益、风险、预算、验收、回滚
        ↓
隔离实现或 guidance/workflow 提案
        ↓
replay → shadow → canary
        ↓
提升或回滚
        ↺
```

顶层使命由 owner 固定。系统自主生成的是可证伪的改进假设，不是可重写顶层使命的“内在动机”。

## 包边界

- `assistant-evaluation`：Outcome/Evaluation 权威账本、汇总、健康、scope 内 review 与独立低信任自评。
- `assistant-evolution`：当前从可信 Automation execution episode 生成行为 guidance 候选并保留 exact exposure 归因；后续改为消费 Evaluation 的 objective/latest projection。采用自由文本 guidance 仍需 owner 审批，确定性退化回滚可按 T1 自治。
- `personal-memory`：确认后的短期之外个人事实、偏好与约束。
- `preference-learning`：使用 Host 固定 T0–T3 catalog 消费 typed feedback 和 Delivery 私有证明的完成对话行为，维护 claim/effect 分离、可衰减和可删除的偏好假设；已认证 owner 的明确选择可立即控制固定 T1，普通行为必须达到更高连续阈值，T2 只形成 proposal，T3 拒绝进入学习层。
- `assistant-automations`：冷启动可恢复的执行和评测触发器，不拥有学习结论。
- `assistant-health`：统一健康投影、阈值和告警信号，不直接修复。
- 后续 `assistant-recovery`：只执行版本化固定 runbook、circuit breaker 和回滚请求。
- `plugin-control-plane`：能力发现、完整性固定、staging、canary 与版本提升。
- `assistant-policy`：权限、预算、审批、紧急停止和不可绕过的外部约束。

只有出现第二个真实消费者时，纯类型或算法才下沉到 `packages/*`；每个用户可启用能力仍保持独立 bundle。

## 自动化等级

系统按风险逐步扩大自治：

1. 自动观察、汇总和自评；
2. 自动生成改进候选和 Memory/Automation 提案；
3. 自动在隔离环境实现和测试；
4. 在预授权、低风险、可逆、预算内的范围自动 canary；
5. 达到统计和安全门后自动提升低风险版本；
6. Policy、权限、凭据、评测基准、风险目录、破坏性动作和外部承诺永不自授权。

第 6 条不意味着每个工具调用都要人工批准。`--permission auto` 和成长风险目录都遵循同一原则：确定性安全、局部可逆动作自动；不能证明低风险，或触及网络、凭据、破坏性操作、提权和复杂 shell 时再升级人工。AI 可以自主选择动作，但不能兼任给自己扩权的裁判。

## 评测指标

不要用消息量或使用时长作为主要奖励。长期指标至少包括：

- 可验证任务成功率和 unknown 比例；
- owner 返工、纠正和人工介入率；
- 主动建议采纳率、误报率和“别再提醒”率；
- Memory 抽样准确率、冲突率、过期率和删除后召回率；
- 每次可验证成功的 token、工具调用、耗时和预算；
- canary 回归、自动回滚、连续失败和恢复时间；
- 候选到采用、改善、退役的完整成长周期；
- 权限越界、秘密暴露和错误外发必须保持为零。

## 推进顺序

### 阶段 0：修通现有成长闭环

- fresh supervised-growth 安装必须包含 Evaluation/Evolution/Health/Recovery 与独立 Heartbeat analyst；v2 Recovery 取代旧 maintenance Heartbeat，升级时先暂停旧 job；analyst 每天最多一次，只能把 Host 选出的 adopt 候选转为 owner 审批卡；
- 成长 route 不再与特定模型绑定；
- Evolution 加入 Health；成长任务连续失败可靠通知 owner；
- 真实 effective config、重启和激活路径进入集成测试。

### 阶段 1：可信自评测

- 新增 `assistant-evaluation`；
- Automation terminal outcome 进入评测账本；
- 区分 execution、objective 和 delivery；
- 提供基于 Memory 的低信任自评 workflow；
- Evolution 逐步改为消费 objective/evaluation 证据。

### 阶段 2：偏好与工作流学习

- typed owner feedback、完成 owner turn 的 content-free 行为证据、固定 catalog、PreferenceHypothesis、冲突、衰减、删除和 T1 自动采用已具备；
- 后续补充更多经过身份与事件绑定证明的纠正/拒绝信号，以及低敏长期 Memory 晋升；
- 重复人工流程生成 Automation proposal。

### 阶段 3：恢复与安全改进

- health history、阈值、告警和 circuit breaker；
- 固定自愈 runbook 与外部 supervisor；
- replay、shadow、canary、自动回滚和低风险提升。

### 阶段 4：能力工厂

- 能力缺口登记与 ROI 排序；
- linked worktree 中生成 Skill/插件；
- 测试、评测、PR、签名包、staging、canary 和版本化启用；
- 逐类验证后再扩大自动提升范围。

> **本版本范围决定（2026-08-31）：明确延期 Stage 4 的 source/release lane。** 已验证的
> Host attestor 与 `source-plan` / `scaffold` 仅可生成并检查变更，终态严格止于
> `ready-for-human-review`；它们不构成 PR、签名、registry 发布、验证或 catalog admission。
> 只有补齐 durable release operation/CAS、独立可信的 Git/签名/registry adapter、真实端到端
> fixture 和对应故障恢复门后，才能重新开启本阶段的自动化范围。

## 2026-08-31 本轮 Stage 3 / Stage 4 覆盖更新

本节记录上述阶段说明之后新增的实现，只覆盖本轮已有代码与测试所能证明的范围。上面的历史范围决定保留为
当时快照；它不再代表当前 source/release lane 的实现上限。2026-08-31 的最终全仓门禁已经通过。

### Stage 3：Memory promotion

- Preference Learning 只会把固定 allowlist 中的 `memory.retention=long-term` T2 假设送入晋升链。请求使用固定
  renderer，不允许调用方携带自由文本或自行声明 Memory 写权限；只有 owner 明确批准后，Personal Memory
  才提交 `user-confirmed` 长期记录。
- Delivery 模式下的 Memory namespace 由稳定的 `principalRecordId + principalVersion` 构成，而不是 session、
  binding generation 或可复用的外部 principal 字符串。相同 owner 的 `/new` 只轮换 session/binding generation，
  因而已确认 Memory 对新 session 仍可见；owner A→B→A 时 principal version 前进，旧 owner 代的记录和
  pending promotion 不会泄漏给返回后的新代。
- promotion request、submission、terminal result 与 ACK 都有独立 digest、generation 和持久 outbox。
  `confirmed` 只在 Memory record 已提交后产生；`rejected`、`expired`、`conflicted` 与 `stale-owner` 保持为
  不同终态，不能被折叠成成功。
- `forget`、owner rotation 或 hypothesis supersede 会先写 durable cancellation tombstone。cancel-before-submit
  在多连接与冷重启后仍会阻止迟到提案。`superseded` 不删除已经确认的 Memory；后续 `forget` / owner
  rotation 可通过保留的不可逆 upgrade binding 将已脱敏 tombstone 升级为 privacy cancellation，并对 exact
  promotion-created record 做 CAS tombstone、删除检索 token，再完成结果 ACK，不能留下可检索的已遗忘记录。
- 集成测试使用真实 `AssistantDeliveryService`、`AssistantPolicyService`、`PersonalMemoryService` 和各自 SQLite
  账本，覆盖真实 Delivery owner lineage、binding rotation、Memory read/search 以及 A→B→A pending promotion
  fencing，其中同 owner 场景通过真实 Delivery `/new` command 轮换 binding 后再次召回已确认 Memory。
  测试仍使用本地 stub Agent/adapter，不构成真实飞书卡片发送或人工点击验收。

### Stage 4：local trusted source release vertical slice

- `ready-for-human-review` 之后必须取得新的 Ed25519 owner authorization；授权绑定 exact plan、base commit、
  checked tree/patch digest、scope 与 release policy，并在每个 phase 前重新验证。生成阶段的旧审批不能替代
  这次 post-check authorization。
- source release 已形成八个固定 phase：`pr → review → merge → build → sign → publish → registry-verify →
  catalog-admission`。每个 request 在执行前持久化，并以 operation id、attempt、plan revision、release fence、
  request/binding digest 和签名 receipt 做 single-flight 与 CAS；崩溃重放不能更换 payload 或跳过 phase。
- publish 结果不确定时进入 `publish-ambiguous`，只能由独立 registry verifier 的 request-bound 签名
  reconciliation receipt 收敛。`exists-match`、`absent`、`unknown` 与 `digest-conflict` 分别决定继续验证、
  提升 fence 后重试、保持不确定或 fail closed；裸 observation 不是发布证据。
- Linux release invoker 和 activation CLI 都通过持续打开的 `/proc/self/fd/*` 执行固定
  executable/interpreter；artifact phases 继承 tarball/SBOM/provenance fd，activation 则让下游从控制面持续
  持有的 artifact fd 读取。local adapter 内的 Git、tar、bubblewrap、Node、pnpm 与 catalog helper 也以
  descriptor-pinned 方式执行；toolchain/store 先复制为校验过的私有 snapshot，再从目录 fd 挂入 sandbox。
- 随包的 local-only reference adapter 在本地 bare Git 上创建 immutable PR ref、读取 owner-private review
  decision、以 `git update-ref` 做 merge CAS；从 exact merge commit 建独立 checkout，以固定 `/usr/bin/bwrap`
  隔离且断网地执行 pinned pnpm 的 `install --offline --frozen-lockfile --ignore-scripts`、目标包 `build` 和真实
  `pnpm pack`。两次独立构建校验 tgz bytes/packlist，产物再生成 CycloneDX SBOM 与 SLSA provenance、签名、
  写入 immutable filesystem registry、独立下载复核，并通过 request-bound v2 attempt journal、父目录
  descriptor `flock` 与原子 CAS 进入 catalog。
- `release-complete` 只表示 source release 和 catalog admission 完成。它把 gap 重新开放但保留 exact admitted
  candidate reservation；不会自动创建 activation plan或修改 production profile。后续 activation 必须显式使用
  该 candidate，并另经 staging、reload、readiness、effect-blocked replay、shadow、canary、soak 和 health。

本轮没有实现或验证 GitHub PR/branch-protection adapter、npm registry/dist-tag adapter、远端凭据与限流、
网络故障后的真实远端 reconciliation，也没有完成真实 wall-clock long soak 或 production activation。local
E2E 已证明 bwrap 内真实离线 pnpm install/build/pack 和干净 profile 的 tgz 安装/import，但没有在 sandbox 内
运行完整仓库测试。descriptor pin 与 catalog exchange 依赖 Linux procfs、`O_TMPFILE`、`renameat2`、bubblewrap
及由固定 `/usr/bin/python3` 安全解析出的 root-owned Python 3.8+；缺失时 fail closed。若威胁模型包含持续恶意的同 UID 进程，生产部署还必须让
catalog commit broker 使用独立 UID，或确保 worker 无权写 catalog 父目录。

最终验证：根 `pnpm check` 全绿，包含 workspace manifest 校验、零告警 lint、全包 typecheck/build、
`198` 个根测试文件 / `2847` 项测试、所有 package test，以及 `22` 个插件和 `2` 个共享包的 dry-run pack。
Stage 3 定向结果为 contract `11/11`、Personal Memory `90/90`、Preference Learning `84/84`；Stage 4
Control Plane 为 `150/150`，真实 local release adapter E2E 为 `3/3`。

## 完成证明

“持续成长”不能靠某个测试绿色或一次演示证明。最终验收必须包含长期 soak、真实任务集、跨重启恢复、故障注入、偏好纠错、错误记忆删除、预算耗尽、canary 回归和回滚。每个已采用改进都必须能回答：依据是什么、谁或什么评测了它、改善了什么、花费多少、如何撤销。
