# 业务目标编排：执行与验收接线

> `fdcee5c` 的跨设备检查点曾将 Delivery 有界续跑保存为 WIP。接手已修复并通过真实原生驱动、取消和 teardown 边界测试及独立复核；全仓结果见 [落地账本](agent-autonomy-implementation.md)。已实现可选的原生回合独立验收与累计预算；持久唤醒仍未完成。

本设计延续 [完整落地账本](agent-autonomy-implementation.md) 的工作包 05、08、17。当前切片涵盖 owner 目标创建、业务上下文、原生生命周期控制与 Delivery 有界续跑；已接入原生回合的 v2 独立执行契约、期限和真实回读；长期授权 lease、跨日自动恢复与完整目标验收仍须实现，不能因设计存在而记为完成。

## 保留两种不同的要求

Delivery 的前台任务验收保留当前入站 `envelope.text`，在 `markDispatching()` 和 `agent.followup()` 之前冻结。某个会话有活动目标，不代表后续每条用户消息都是该目标的执行步骤；“解释这个概念”“暂停一下”不能被替换成旧目标原文。

业务目标有自己的定义与成功条件。`originalObjective` 保留首次建立目标时的文本；用户修改目标产生新定义版本，不能改写历史目标或旧验收契约。生命周期 revision 同时会因 pause/resume/complete 改变，不能直接等同于语义定义版本。未来应区分：

- 原生 `GoalId + revision`：DSH 的并发与续跑状态；只属于原 Session。
- 业务记录 `id + version`：目标状态投影与规划笔记的更新版本。
- 目标定义版本：用户确认的目标、成功条件、依赖及资源范围；编辑会使未执行的旧步骤过期。
- 步骤执行与验收身份：固定 definition、step、Session、run 与验收契约摘要。

同 owner 的跨会话 focus 继续只提供上下文，不成为执行授权，也不能自动改变步骤的 owning Session。

## 已实现的生命周期边界

`goal_control` 只在 exact live Agent 的已认证 owner 当前回合中接受 edit/pause/resume/clear；每项操作有独立 Policy action。`expected_revision` 是原生 goal revision，原生 GoalService 执行 CAS。它不是业务 checkpoint version 的跨数据库原子提交承诺。

控制目标必须属于当前 Session，且业务记录的原生 GoalId 必须等于当前 native goal。clear 保留业务 tombstone 和历史。原生目标已完成后可创建新 GoalId；旧记录仍待独立验收。Native 状态已经改变而业务读回失败时报告部分完成，调用方先读取现状，不盲目重放命令。

暂停和恢复仍使用上游 GoalService/goal-round-driver，不新增模型循环。暂停不承诺终止已经开始的外部动作；真正撤销、取消和进程终止由后续 lease/broker 边界提供。进程重启后的 native activation 默认 disarmed，业务记录本身不能成为自动 rearm 授权。

Delivery 的 `agentGoalContinuationTimeoutMs` 默认关闭。启用后，在当前前台任务内等待原生驱动继续执行，待原生目标停止再释放 Agent；超时、停止或当前授权失效则取消并保留未知结果。它保留原 Session、GoalId 和轮次累计，不把普通用户消息替换成目标原文。该等待占用当前任务的串行位置，不是后台调度或新目标执行契约；原先的前台回执也不能作为整个业务目标达成的证明。

续跑修复采用先将原前台回复持久入队、再等待原生驱动的顺序；原生驱动仍可在前台结束的 idle 边界开始工作，不能把这一顺序理解成“用户已收到回复后才会开始目标轮”。入队、送达、原任务验收和业务目标达成是四个独立事实。护栏覆盖后续模型步骤（包括不再带有 goal 源消息的工具结果后步骤），并保留到 Agent 的实际异步 teardown 结束；Delivery 停止等待不表示第三方工具或进程已经终止。

## 原生回合执行契约与待完成编排

现有可选 Host 原生回合入口以 `verifyNativeRounds` 启用，复用 Verifier 的注册代际、契约冻结、真实执行回读、独立 authority 与结果 outbox。选择显式 goal-execution 生产者或严格版本化的 goal-step 关联；不要让模型通过传入任意 taskRef/contractId 将他人的成功附到自己目标。

完整编排开始步骤前，Host 必须持久化：目标记录及定义版本、owner record/version、workspace/preset、原 Session/GoalId/revision、step/run、成功条件、资源授权摘要、预算预留、期限和幂等身份。只有所有前置检查仍有效时才向已有 AgentLoop 提交。v1 的前台/Automation 任务契约与历史回执保持原意；新协议须显式升级 types/wire/存储/生产者/消费方测试，不能把未知 kind 默认为前台任务。

本批每次模型请求和工具执行重查 owner、定义、native revision、轮次上限与步骤期限；未来授权 lease 过期同样必须阻止新动作及旧步骤提交。历史“当时已观察到成功”的任务回执保留，不通过删除历史掩盖曾经发生的行为；该历史回执也不能成为现在继续执行的授权。对已发出但不能证明结束的动作记录 unknown，并走回读/补偿，不自动再发一次。

GoalStore 与 Session 不构成一个原子数据库。协议须采用持久执行意图、CAS/fence、原生 Session flush、回执对账与明确的未知状态，覆盖每个提交窗口；不能以两次普通写入冒充原子事务。

### 实施落点与完整恢复协议（部分实现）

当前代码核对表明，普通 Automation Agent runner 在 `assistant-automations/src/runner.ts` 中使用 `agents.create()` 创建运行 Session。不能将它直接当作原生目标恢复入口。采用 Automations 已有的 Host executor 注册和持久 `at` 调度，Goals 持有明确的目标步骤执行器；执行器通过受保护的 Host 入口恢复原 Session。跨会话 focus 不能调用该入口。

| 层 | 实施文件 | 必须一起改变的契约 |
| --- | --- | --- |
| 验收身份 | `packages/task-acceptance-contract/src/{types,wire}.ts` | 显式版本化的 goal-step 身份与严格 parser；保留 v1 前台/Automation 原意 |
| 目标账本 | `plugins/assistant-goals/src/{types,store,service}.ts` | 定义历史、步骤意图、run、预算预留、期限、授权摘要、wake 与验收绑定，SQLite 迁移和 CAS |
| 可信验收生产者 | `plugins/assistant-verifier/src/{host,service,store}.ts` | Goals 的独立注册代际、精确 kind 路由、prepare 和 durable execution readback |
| 持久唤醒 | `plugins/assistant-automations/src/{host-executors,coordinator,runner}.ts` 与 Goals 执行器 | 复用 occurrence/task/run、scheduler lease 和 Host executor descriptor，禁止重新实现定时轮询器 |
| 结果消费 | `plugins/assistant-evaluation/src/service.ts` 与 Goals | 显式识别 goal-step，精确回执绑定、去重与可重放投影，不把未知 kind 当 foreground-turn |

执行意图按以下顺序推进，各状态必须有重启后的对账动作：

1. `prepared`：Host 冻结 definition/step/run、原 Session/GoalId、owner lineage、权限、预算和期限，持久化意图与验收绑定；此时还没有模型或外部提交。
2. `scheduled`：通过幂等的 Host `at` 定义物化 wake。若创建唤醒已提交但 ACK 丢失，按原幂等身份回读，不能另建一个 wake。
3. `claimed`：持有 scheduler lease 的 executor 对目标意图 CAS，重查定义、原生目标、owner、授权、期限和预算，再恢复原 Session；发现其他仍运行的 owning Agent 时不能并发接管。
4. `dispatching`：先持久化已提交边界，再向原生运行时交付精确 step。进程在这里崩溃后，无法证明未提交时必须是 `unknown`；恢复先检查 Session/外部系统，禁止自动重放可能有副作用的工作。
5. `awaiting-verification`：持久化执行终态与 Session checkpoint，Verifier 从生产者回读；模型 complete 或进程退出 0 都不能直接产生 achieved。
6. `verified` / `needs-attention`：消费绑定 definition/step/run 的独立回执；迟到旧定义成功只保留历史，不能完成新定义。unknown 按缺失证据生成新的调查步骤，新步骤仍需要新的授权和预算检查。

定义编辑与 pause/resume revision 分开记账。用户修改成功条件或资源范围生成新的定义版本并使未提交旧步骤过期；暂停不重置累计预算。已发出步骤继续保存当时的证据，不能通过删记录规避对账。当前只实现立即执行的原生回合 prepared/dispatching/awaiting-verification 及 Verifier/Evaluation 接线。scheduled/claimed 持久唤醒、自动调查步骤、目标整体结果投影和外部提交补偿仍未实现；完整 WP05 未完成。

## 独立验收与下一步

目标达成来自目标成功条件的独立观测，不来自 native `complete`、模型自评、步骤退出码或“所有子步骤已完成”。结果需绑定目标定义及新鲜度；部分步骤完成只改善进度，不能消除剩余条件。

已实现的步骤反馈回读使用完整冻结合同与当前回执，检查 owner/scope、goal definition、run/task 和实际执行终态；当前结果、待验收和有限历史分列，旧定义、过期和 unknown 不推导目标达成。回合终态触发现有 Verifier 单次有界检查；SystemPrompt assembly 等待前轮结算并重读授权与结果，避免 pre-step 之前生成的旧上下文遗漏失败。模型可以依据失败条件修订方案；反馈不是新的动作权限，也没有自动完成业务目标。

未知或失败应形成可执行的后续计划：重查过期假设、收集缺失证据、改变方法或请求具体资源。下一步仍受预算与授权约束。复用 Automations 的持久 at 唤醒、occurrence/task/run 幂等身份和 scheduler lease；不再创建第二套定时器。唤醒时重验 scope、定义、期限、预算和 lease，并恢复原 Session；跨会话迁移必须有明确的新关联协议。

## 必须验证的真实路径

1. 真实 owner 工具创建、编辑、暂停、恢复和 clear；旧 revision、错误 owner、非人类回合及跨 Session focus 均无法控制目标。
2. 真实原生 driver 暂停后不继续，重启保持 disarmed，明确授权恢复后由已有 AgentLoop 推进；轮次上限不被重启或反复恢复重置。
3. 明确目标步骤在模型调用前冻结契约；普通聊天任务仍按原消息验收，不被活动目标替换。
4. 定义修改、owner 撤销和预算耗尽发生在准备、提交、回读的不同边界，均不能用过期权限继续；unknown 恢复不重复外部提交。
5. 完整跨会话/跨日目标通过独立条件验收，包括真实失败、过时假设重查、依赖变化传播、停止和恢复。
6. 受支持的全新 Web profile 从能力选择、owner 建立、模型预算到完成示例目标；doctor 分别报告上下文可用、原生续跑可用、独立验收可用和隔离执行可用。缺少某一层时给出准确修复，不将可调用工具的数量当作自治就绪。

上述各项最终需要真实模型和部署证据；确定性 Host 测试只证明相应工程机制。整体智能收益继续由工作包 04 的同预算基线与留出评测衡量。

当前立即执行协议先保存私有执行意图和验收绑定，flush 原 Session 后标记 dispatch，再放行首个模型请求；后续模型步骤复用同一 run。终态需要真实 turn/end 和成功 checkpoint，取消/不确定清理保留 unknown。恢复不重放旧 run。执行账本为 Goals 数据库旁的 `.executions` 文件，用户目标历史库迁移到 schema 2，Evaluation schema 10 单独识别 goal-step。配置与权限详见 Goals README。以上机制依赖 Delivery 结束时释放旧 Agent、后续从原 Session 创建新 handle；取消后的旧 handle 继续拒绝迟到动作。

## 原生累计预算切片（2026-09-06）

可选 `executionBudget` 已接到原生回合：业务目标级不可变上限和绝对期限跨定义编辑、pause/resume 与重启保留；模型调用前持久预留，可信完整 usage 后结算，不确定结果保留全额。输入上界与费用声明来自精确 provider/model 的 Host-only meter，缺失声明拒绝；普通前台不计入。该能力需要 `verifyNativeRounds`，默认不启用，不预装生产计量器。

持久唤醒仍待实现。Automations 的 Host executor/reconcileSystem 可以复用现有 occurrence、task lease 和 owner/definition 校验；但 task lease 只排他同一调度任务，不能阻止同 Session 前台入站。安全接线还需 Delivery 受保护的后台恢复入口、共享持久 Session fence、同 owner record/version 与 Session/GoalId/revision 重查，以及 dispatch 前的 run intent CAS。普通 Automation runner 新建 Session，前台 `currentPreferenceTurn` 又必须证明真实人类入站，二者均不能直接冒充后台原 Session 恢复。未知已 dispatch 仍只对账、不重放。

Session lease 设计还必须保证同一 Session 不能从另一 binding 取得并行租约；仅按 binding ID 建主键不足以构成该保证。租约到期只代表持有者失去后续提交权限，不能证明已 dispatch 的外部动作停止。持久状态须区分未 dispatch 的可重取意图与需要对账的 dispatched/unknown；旧执行无法证明 quiescent 时，不能仅因超时启动同 Session 的替代执行。

## Session 排他接线（2026-09-06）

Delivery schema 19 已为内置前台、权限/compact 和首次/new construction 接入同一 Session ID 主键 lease。claim 与续约重读绑定及主体，fence 单调；有效持有者导致等待，未知执行禁止接管。released construction 的不可变会话身份防止 binding 提交前窗口被另一主体复用。正常 handle 清理和在途流/工具结束才释放；提前返回先记 unknown，同一原持有者迟到的完整清理可以结算，重启没有这份证明则继续保持 unknown。等待 Session 的 Inbox 不扣业务重试次数，审计 fence 仍递增。

这一层已供当前内置运行时使用；尚未暴露 Goals 后台 owner capability，也尚未把 Automations 的持久 wake 交付到同一 runtime。完整后台恢复继续要求原目标授权、Session/GoalId/revision/definition、预算与 wake run intent 一起核对。不能因为排他基础完成，就将跨日目标闭环记为通过。
