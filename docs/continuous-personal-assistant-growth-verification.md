# 持续成长系统验证账本

本文件记录 `continuous-personal-assistant-growth` 的逐轮活体审查、故障证据、修复和验收。
它不是完成声明；只有所有 P0/P1 关闭、真实链路故障注入通过且根目录 `pnpm check` 成功后，才可把结论标记为可用。

## 判定规则

- `P0`：会中断可信学习主链、造成错误生产变更、绕过审批/预算，或使安装后无法自行运行。
- `P1`：不会立即破坏账本，但会误导 owner、留下不可恢复窗口，或让长期运行明显退化。
- `P2`：增强项；不阻断当前纵向闭环，但属于完整阶段目标。
- 每轮由不同视角独立寻找反例；测试绿色不能替代产品链路证明。
- 学习数据、生产动作、审批、预算和投递均以持久账本及精确幂等回执为准，不以进程内状态或日志为准。

## 审查轮次

| 轮次 | 角色 | 发现 | 处置与证明 | 状态 |
|---|---|---|---|---|
| 1 | 架构 / 运行时 | heartbeat 实际未进模型；preset 后额外工具突破 allowlist；健康把基础设施故障混成学习结果 | Agent preset 挂载后重新收敛工具集；Automation 增 typed receipt、Host 执行、incident/circuit 与 Evaluation outbox | 已修复，待最终全仓复验 |
| 2 | 测试 / 故障注入 | 生产 outcome 固定 `objective=unknown`；Evaluation 与 Evolution 断链；旧测试靠 helper 手工造学习样本 | 接通 authoritative Evaluation projection；真实 Automation、owner feedback、重启、审批、曝光、归因、退役 E2E | 已修复，定向 E2E 已通过 |
| 3 | 架构 / 恢复 | Recovery 只有骨架；缺 Cordis runtime、exact replay、canary、route 复核、deadline、预算崩溃恢复 | 落地固定七步 Host runbook、preview/active、exact receipts、atomic canary/pause、deadline 与预算恢复 | 已修复，Recovery 定向 100 tests；待最终全仓复验 |
| 4 | 产品 / owner | task-level owner precedence 只修正报表，没有覆盖 Evolution；关闭旧 heartbeat 后无人自动合成 adopt guidance；审批和 incident 无终态 | task learning projection、独立 growth analyst、审批/incident 生命周期已形成纵向切片；后续安全轮发现权威边界仍需收紧 | 定向修复已通过，待第 6 轮反例关闭 |
| 5 | 能力工厂架构 / 发布 | CLI 可自带公钥成为信任根；所谓 readiness/replay/soak 只是命令标签，没有真实语义；SQLite lease 没有围住文件系统副作用；审批未绑定安装目标；候选继承完整环境 | 否决首次实现；改为 owner 私有信任配置、目标与 source identity 全绑定、OS 级 profile lock + fencing、环境 allowlist、真实 Host attestation/replay/effect-blocked/canary/soak | 修复中，未放行 |
| 6 | 安全 / 审批 | Evaluation 撤回与 Evolution 结算存在跨库竞态；公开 `append` 可伪造可信样本；公开 presentation 可伪造 applied/resolved；Agent analyst 不进入 incident；冲突卡、撤销入口和失败展示恢复不完整 | 引入 Evaluation 权威水位与 writer fence、实例绑定私有 producer capability、Agent incident authority、同事务 terminal outbox、确定性二次撤销入口及无限可恢复展示 | 修复中，未放行 |

## 必须通过的纵向验收

1. 可信任务链：真实 production Automation → terminal outcome → owner 绑定回复 → task projection → Evolution 唯一有效样本。
2. 覆盖与撤票：evaluator 与 owner 相反结论最终以 owner 为准；多个 owner 冲突时贡献零个学习样本，且 outbox 不永久重试。
3. 自动候选：达到固定样本门槛后，无需 owner 先发起聊天，受预算的独立 analyst 最多生成一张 evidence-bound adopt 审批卡。
4. 审批与撤销：批准不等于应用；账本实际结算后显示终态，并能对 exact rule/version 发起独立撤销审批。
5. 行为归因：采用后的 production session 记录 exact rule/version exposure；回归证据只能归因给真实曝光版本。
6. 恢复：在下游提交、Recovery receipt、预算 finalize、Automation task complete 的每个崩溃窗口重启，外部动作最多一次且最终状态可收敛。
7. 两阶段激活：preview 与 active 都必须匹配当前 generation 的 exact nonce、plan digest、state；时间戳与“进程 running”不是证明。
8. 底线安全：成长执行体不能修改 Policy 上限、凭据、预算上限、评测真源或 supervisor；自由文本 guidance 始终由 owner 审批。
9. 低打扰：健康周期不发消息；同一候选/evidence digest 不重复发卡；incident 在同一生命周期消息上收敛到 resolved。
10. 发布门：manifest、lint、typecheck、全部 tests、build、每包 dry-run pack 和真实安装/重启故障注入全部通过。

## 未关闭事项

- P0：关闭 Evaluation 权威样本撤回与 Evolution 候选创建/审批结算之间的跨库竞态；普通插件不得自行声明可信 producer。
- P0：让 analyst Agent automation 进入与 Host automation 等价的 durable incident 生命周期。
- P0：能力工厂必须使用外部固定信任根、真实执行 attestation 和跨账本/文件系统 fencing；命令名称不能充当 readiness、replay 或 soak 证明。
- P1：收窄 terminal/incident presentation 为实例绑定 producer；冲突必须立即原位更新，投递长期失败后仍能自动恢复。
- P1：提供确定性、身份与 exact rule/version 绑定的撤销入口，且入口只创建第二次 owner 审批，不能直接 retire。
- P1：把真实 workflow trace、paused artifact、effect-blocked replay/shadow、单次 canary、可信评估与精确 promotion/rollback 接成一条链。
- P2：长期 Memory 晋升及能力来源 lane 的签名、PR、发布适配器仍需按实际完成度诚实标注。
- 最终：完成第 7 轮起的独立测试、产品、用户、运维与最终架构审查；至少达到 10 轮且最后一轮无新的可执行 P0/P1，再执行根目录发布门。

## 2026-08-30 预留收尾快照

本轮在角色任务仍运行时收到强制收尾指令，三个角色均已中断；此后没有再启动测试或实现。
因此，下列结果只代表中断前已经完整回报的定向验证，不代表当前整个工作树通过发布门：

- `assistant-automations`：175 项测试通过；typecheck、oxlint、build、diff check 通过。
- `assistant-evolution`：126 项测试通过；typecheck、oxlint、build、根 personal-assistant E2E 通过。
- `assistant-evaluation`：task-level summary/review 版本曾有 29 项测试通过；之后开始的版本化 learning projection 修改在角色中断前没有完成跨 Evolution 接线，也没有得到新一轮验证。
- `assistant-recovery`：100 项测试通过；typecheck、oxlint、build、pack dry-run、workspace validate、diff check 通过。
- `assistant-health`：27 项测试通过。
- `lark-channel`：两阶段 Recovery 激活和审批卡版本曾有 350 项测试通过；之后设计的 exact bootstrap attestation gate 尚未接入。
- 根 personal-assistant E2E：中断前已报告 3/3 通过，但不覆盖尚未完成的自动 analyst、终态通知和版本化 owner-wins 学习替换。

当前工作树是未提交的开发快照，并含一段中断时的未验证 WIP：Evaluation 已增加 canonical learning
version/digest/disposition 与查询 seam，但 Evolution 仍消费旧 raw outcome seam。不得把它发布或描述为完整闭环。
没有执行最终根目录 `pnpm check`，也没有提交或推送这个跨 102 个文件的混合工作树。

## 2026-08-31 预留收尾快照

收到运行时收尾指令后，所有仍在工作的角色均被中断；此后不再运行验证，也不再修改业务实现。
当前工作树仍是未提交、未推送的混合开发快照，约 117 个 tracked 文件有差异，并包含多个
untracked 新包/源码文件。下列状态必须按“最后一次完整验证”与“中断 WIP”分开理解：

### 已形成且曾完成定向验证的切片

- Recovery exact bootstrap attestation 与 Lark generation/set gate：Recovery 公共 canonical set helper、
  preview→active generation 串联、集合/nonce/state/plan digest 精确核对已接通；最后完整回报为
  Recovery `103/103`、Lark `364/364`（随后 Lark 另有 incident 改动曾到 `367`），相关 typecheck/build 通过。
- 独立 `heartbeat:supervised-growth-analyst` 的安装、预算、工具 allowlist、approval binding 与
  Evolution analyst token/proposal 纵向切片已实现；最后完整 Evolution 回报为 `141/141`、typecheck、
  build、oxlint、dry-pack 通过，但之后 Evaluation/Evolution v7/v12 WIP 又修改了这些文件，因此该结果
  不能证明当前文件仍通过。
- 审批 domain application receipt/outbox 与 Host incident open→recovering→resolved 生命周期曾完成
  定向验证；最后完整回报为 Automations `179`、Delivery `407`、Lark `367` 及三包 typecheck/build 通过。
  第 6 轮又发现公开 presentation producer、Agent analyst incident、展示长期恢复和确定性撤销入口缺口，
  随后的修复未完成，故不能把该切片描述为最终关闭。
- Assistant Health 已增加 Growth/Control Plane/presentation 指标及 Recovery exact attestation 的
  content-free 投影；本次收尾前最后单独验证为 `34/34` tests、typecheck、build、oxlint、diff check、
  dry-pack 通过，dry-run 未遗留 tarball。
- `packages/assistant-growth-contract` 已建立严格 trace/template/八端口共享协议；中断前角色回报为
  6 项 tests 与 typecheck 通过。该包尚未完成最终依赖收口和根发布门。

### 中断时尚未验证完成的 WIP

- Evaluation v7 已写入 scope watermark、私有 Automations/Delivery producer capability、public trusted
  append 拒绝和 synchronous writer fence；Evolution v12 已开始冻结完整 evidence tuple、水位、冲突
  terminal outbox 与已采用规则的 correction auto-retire。`settle` 外层 fence、unattached crash recovery、
  编译修复和全套 tests 尚未完成；不得假定当前 Evaluation/Evolution 可编译。
- Delivery workflow schema/private template ledger/owner command/source outbox 已部分实现，Delivery 曾在
  该阶段通过一次 typecheck；持久 trusted-objective outbox、完整测试、Automations 八个真实 Growth port、
  verified-repetition 真源、真实 E2E、私有 presentation producer、Agent incident 和确定性 undo 均未完成。
- Plugin Control Plane 正在从 v5/v6 重新收紧唯一 ledger、executor digest、SQLite 全窗口互斥、不可偷取
  lock 与 no-backup rollback；角色在贯通 schema/CLI/tests 前被中断。真实 Host attestation/effect-probe
  issuer 和 PR/signer/registry adapter 仍不存在，不能声称能力工厂可自动激活或发布。
- 正式审查只完成到第 6 轮；第 5、6 轮均发现新的 P0/P1，未达到至少 10 轮，也未达到最后一轮无新建议。
- 未执行最终根目录 `pnpm check`，未执行最新真实安装/重启/故障注入，未提交、未推送、不得发布。

## 2026-08-31 个人优先闭环收尾快照

本次按 owner 要求把重型运维后置，优先施工“正常使用即可成长”的个人助理纵向切片。收到运行时收尾指令后，
`autonomous_preference`、`real_growth_e2e` 与 `repair_eval_evolution` 三个仍在运行的角色均已中断并确认进入
`interrupted`；此后没有再启动任何验证。

### 已落地的个人助理主链

- 普通 `lark` 安装场景已直接包含 Preference Learning，不要求 Evaluation、Heartbeat、Health 或 Recovery；
  onboarding 只授予 exact owner/workspace/preset 的 `signal` 与 `snapshot` 能力，不借用通用 Agent 工具放行。
- 完成且已持久化回复的 authenticated owner turn 会产生不含正文的 language observation；连续 6 次同值证据
  可自动 CAS 激活固定 T1 catalog overlay，一次反向使用不会回滚。
- 持续性中英文短句可形成 explicit selection；一次性语言、详略或列表请求走 abstain，不作为长期行为证据。
- reply Outbox 与 Preference projection intent 已在 Delivery 同一 SQLite 写事务提交；Preference 未安装、重载、
  sink 异常或响应丢失时由 durable projection outbox 重放，不重新调用 Agent。
- 实际 prompt 注入记录 exact hypothesis/version/session/event exposure；完成回复后绑定 Inbox/Outbox，针对该回复的
  持续性明确纠正只回滚相同 effect lineage，并自动启用新的固定 T1 选择。
- Preference scope 已增加 principal digest/generation fence。owner 换绑时首轮 fail closed、物理清除旧 scope；
  延迟的旧 owner projection 会被幂等 ACK-ignore，不能在重启后夺回 scope。
- Automations→Evaluation→Evolution 已改为私有、版本化、幂等投影；preview 不产生可信 production outcome，
  public trusted append 与伪造 producer registration 被拒绝。

### 最后一次完整回报的定向证据

这些数字来自各项修改完成当时的完整命令，不能替代当前树的最终发布门：

- `assistant-delivery`：`414/414` tests，typecheck、build 通过。
- `preference-learning`：`46/46` tests，typecheck、build 通过。
- 根 personal-assistant 真实组合：`6/6`，覆盖普通使用自动激活、真实 prompt overlay、exact exposure correction、
  Preference 晚安装/两次重载、真实 Preference commit 后 Delivery ACK 丢失重放，以及 owner handoff 后旧事件重放。
- `assistant-automations`：`183/183`；`assistant-evaluation`：`34/34`；`assistant-evolution`：`142/142`；
  `assistant-recovery`：`103/103`；四包 typecheck 通过。
- `assistant-health`：`34/34`，typecheck、build 通过；Plugin Control Plane：`25/25`，typecheck、build 通过。
- Growth Contract：`6/6`；Growth Experiments：`13/13`；两包 typecheck 通过。
- Lark Channel 最后完整回报 `368/368`，installer `28/28`；workspace manifest validation 与当时的全仓 lint 通过。

### 收尾时仍未关闭

- 在上述 Delivery/Preference 与根 E2E 绿色之后，第 9 轮又把 `activateReadyScopes` 收紧为 JOIN 当前
  principal generation，拒绝 legacy ownerless 或 stale-generation 后台激活，并增加了相应 Store 回归测试；
  当前源码已写入，但因收尾中断，**尚未重新运行** Delivery/Preference/E2E 门禁。
- polite one-shot 闭集随后又扩展为保守 whole-message directive regex，覆盖
  `Could you please answer in Chinese?`、`麻烦用英文回答` 等形式；该最终版本同样**尚未重新运行**全套门禁。
  更宽的 token-level 保守 abstain 建议尚未落地，因此不能声称任意自然语言的一次性指令都已被穷尽。
- owner 可见的 `/learning status|pause|resume|forget confirm` 控制面尚未实现；现有 Host `forgetScope` API 不能替代
  日常用户入口。这仍是个人产品闭环的 P1，而不是运维增强。
- 正式审查虽然推进到第 10 轮，但最后两轮仍产生了上述可执行 P1；没有完成“最后一轮不再产生建议”的条件。
- 未运行最新根目录 `pnpm check`、dry-run pack 或最终真实安装复验；当前混合工作树未提交、未推送，不得描述为
  release-ready，也不得声称阶段 3 的完整运维闭环或阶段 4 能力工厂已经完成。

因此，本快照证明了个人助理无人编排的低风险学习主链已经形成并曾在真实组合中通过，但当前最新文件仍需要
完成用户学习控制面、重新跑稳定态门禁和最后无新增 P0/P1 的复审，才能结束原任务。

## 2026-08-31 GhostAP 预留收尾快照（二）

收到运行时预留收尾指令后，`acceptance_guard`、`agent_incident_fix` 与
`control_plane_attestor` 均被立即中断；权威 agent 状态随后确认三者均为 `interrupted`。本节只保存
中断前已经完整返回的结果，不把正在编辑的源码或未完成测试当成通过。收尾后未再启动门禁。

### 已完成并在对应修改后完整返回的定向证明

- Preference owner lineage 已补齐 A→B→A 的 pending projection 隔离、投递前同步 live-owner fence、
  exact principal+lineage review，以及 Recovery malformed generation/lineage receipt 反例；完成该切片的
  三包定向测试、typecheck/build/lint 曾全部通过。
- `/learning` 已有严格 Host 本地 `status / explain / pause / resume / rollback <exact-T1-key> confirm /
  forget confirm`。`explain` 不推进 admission high-water，不回显历史正文；rollback 只撤销当前 owner
  lineage 的一个 active T1；forget 清理旧控制 receipt。最后完整回报为 Delivery `489/489`、Preference
  Learning `68/68`、两包 typecheck/build/oxlint，以及根 Lark→Preference→重启→ACK-loss E2E `8/8`。
- Evaluation→Evolution 已加入固定锁序 writer fence 与确定性双 SQLite/worker 竞态覆盖；修复了批准后
  rule 被 correction 退役时，terminal replay 错误地用新 rule 版本重算 immutable receipt 的缺陷。
  最后完整回报为 Evaluation `36/36`、Evolution `148/148`，两包 typecheck/build/oxlint 通过。
- Agent Automation terminal failure 已进入 durable incident，Host 使用 exact owner-route，Agent 使用
  exact approval binding；该切片完成时 Automations `186/186`、typecheck/build/oxlint 通过。之后该包又
  进入 workflow 施工，所以上述数字不能证明当前中断文件仍然绿色。
- Plugin Control Plane 的 Host attestor 已完成 owner-private trust、固定 executable/interpreter
  path+digest+权限、危险环境拒绝、真实无 shell 子进程、七阶段签名 evidence、SQLite single-flight/CAS、
  crash/restart、单次 canary 与失败 rollback。进入 Stage 4 修改前最后完整回报为本包 `37/37`、
  typecheck/build/oxlint/diff-check/dry-pack 通过。
- supervised 安装/profile 已把 Growth Experiments、Recovery、Health 纳入同版本完整集合，并加入独立
  workflow 日预算、默认 no-tool proposal bounds、owner-bound approval/delivery 与 required health。
  本次修改后的相关 4 个测试文件 `71/71`、Lark Channel typecheck/build、scoped oxlint、shell syntax、
  workspace manifest validation 均已通过。

### 中断时仍未关闭，禁止宣称完成

- **当前工作树不是发布候选。** `git status --short` 有 158 个条目；tracked diff 覆盖 126 个文件，另有
  多个未跟踪的新包/源码/测试。没有运行最新根 `pnpm check`、全包 dry-pack、隔离 fresh supervised
  install、真实 resident restart 或最终故障注入。
- **Workflow 自动学习仍断一段。** Delivery 的可信 trace 目前只由 owner 回复结果后显式执行
  `/workflow save` 产生；普通完成 turn 不生成 `verified-repetition` trace。中断中的真实组合 E2E 尚未
  收口，且 post-promotion 回归监控/自动 rollback 尚未形成完整验收。不得把 Growth Store 的 fake port
  测试或 owner-explicit capture 描述成“正常使用自动学习重复流程”。
- **Presentation producer P1 未关闭。** Delivery 仍公开 `publishDeliveryPresentation`，只校验可猜的字段
  形状；Automations/Evolution 尚未使用实例绑定、可撤销的私有 producer capability。approval-application
  的 transient presentation failure 仍受 `maxAttempts` 限制，长期故障可能进入 dead 而不能自行恢复。
- **Stage 4 source/release 是中断 WIP。** 新 `release.ts`、schema 3 表和 phase/request/receipt 类型已经写入，
  但 durable operation/CAS、CLI、真实 git/registry fixture、独立 review/build/sign/publish/verify/catalog
  admission 全链及本包门禁没有完成。只有前述 Host attestor 可视为已验证。
- **长期 Memory 晋升仍未接通。** T2 hypothesis 只会保持 proposed/inactive；稳定低敏偏好尚不会自动形成
  owner-bound Personal Memory proposal，Memory 批准结果也未反向成为 confirmed preference 真源。
  `/learning export` 同样没有实现。
- 最终独立 goal/产品/用户/安全审查在产出报告前被中断；正式账本仍未达到至少十轮且最后一轮没有新增
  可执行 P0/P1。当前未提交、未推送；在上述缺口和最终发布门关闭前，提交或推送一个“完成版”会造成
  错误完成声明。

## 2026-08-31 本轮 workflow / presentation / 发布门验证

本节覆盖上方历史快照中关于本轮已完成工作流真源、私有 presentation producer 和最终发布门的
“中断 WIP”描述；历史发现、当时的测试数字和未纳入本版本的长期目标仍保留原样，不追溯改写。

### 已验证的 workflow producer

- Delivery 只在 active owner 对一条已投递普通 Agent 回复作出精确
  `/feedback achieved` 时建立 `verified-repetition` receipt。事务内重新证明 source Inbox 已 processed、
  reply Outbox 使用 exact `inbound:<inbox>:reply` idempotency key、已取得 provider message id，且 feedback
  的 reply target、owner binding、principal、conversation 和 objective command 全部精确一致。
- 只有闭集的静态 catalog selector 可生成模板；所有模板内容、schedule、tool catalog 和 privacy
  attestation 都由 Delivery 固定导出。自由文本、附件、改写 selector、partial/not-achieved、无投递回执
  或二次相反 judgement 均保留 content-free no-trace / immutable conflict，不能变成学习输入。
- trace 通过单个进程内、可撤销的 `registerWorkflowTraceSink` durable outbox 投影到 Growth；真实公共
  E2E 覆盖 `ordinary reply → /feedback achieved → verified-repetition → Growth`，并证明 Growth 只看到
  去内容化的 `verified=1, ownerExplicit=0` 候选。

### 已验证的 presentation capability

- Delivery 不再向公共 service surface 暴露 presentation publisher。它只向当前 Automations incident
  或 Evolution approval-application 实例签发带 generation、exact registration object 和 disposer fence
  的进程内 capability；proxy sibling、替换、卸载和 stale completion 都会失效。
- producer 只能更新自己持久 outbox 对应的 exact key/revision。临时 adapter/provider 更新失败保留在
  durable projection 队列中持续恢复，不消耗普通消息 Outbox 的 `maxAttempts`，且不能把旧状态投影成新终态。

### Stage 4 范围决定

**明确延期 source/release lane。** 本版本验证的 Host attestor、`source-plan` 与 `scaffold` 的终态是
`ready-for-human-review`；它们不代表 PR、签名、registry publish/verify 或 catalog admission。重新开启
自动化范围前，必须补齐 durable release operation/CAS、独立可信 Git/签名/registry adapters、真实端到端
fixture 和相应 crash/recovery gates。

### 最终门禁

- `pnpm install --frozen-lockfile`：通过。
- `pnpm check`：通过，涵盖 workspace manifest validation、零 warning lint、全仓 typecheck、根目录
  `192` 个测试文件 / `2626` 项测试、每包测试、clean build 与全部插件/共享包 `pack --dry-run`。
- `pnpm release:prepare`：本地准备 `0.1.8`；`pnpm release:status` 显示 current `0.1.7`、pending `0.1.8`。
  本轮没有执行 publish、push 或创建 Git tag。
