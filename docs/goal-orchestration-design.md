# 业务目标编排：执行与验收接线

> 本次跨设备保存为 WIP：Delivery 有界续跑尚未完成运行时验收，已知缺口见 [交接记录](autonomy-handoff-2026-09-06.md)。以下边界同时描述实现意图，不能当作已验证行为。

本设计延续 [完整落地账本](agent-autonomy-implementation.md) 的工作包 05、08、17。当前切片涵盖 owner 目标创建、业务上下文、原生生命周期控制与 Delivery 有界续跑；以下执行契约、预算授权、跨日自动恢复和目标验收仍须实现，不能因设计存在而记为完成。

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

## 下一步执行契约

新增明确的 Host 目标步骤生产入口，复用 Verifier 的注册代际、契约冻结、真实执行回读、独立 authority 与结果 outbox。选择显式 goal-execution 生产者或严格版本化的 goal-step 关联；不要让模型通过传入任意 taskRef/contractId 将他人的成功附到自己目标。

开始步骤前，Host 必须持久化：目标记录及定义版本、owner record/version、workspace/preset、原 Session/GoalId/revision、step/run、成功条件、资源授权摘要、预算预留、期限和幂等身份。只有所有前置检查仍有效时才向已有 AgentLoop 提交。v1 的前台/Automation 任务契约与历史回执保持原意；新协议须显式升级 types/wire/存储/生产者/消费方测试，不能把未知 kind 默认为前台任务。

原生 goal 修改、owner 撤销、lease 过期或定义变更应阻止新动作及旧步骤提交。历史“当时已观察到成功”的任务回执保留，不通过删除历史掩盖曾经发生的行为；该历史回执也不能成为现在继续执行的授权。对已发出但不能证明结束的动作记录 unknown，并走回读/补偿，不自动再发一次。

GoalStore 与 Session 不构成一个原子数据库。协议须采用持久执行意图、CAS/fence、原生 Session flush、回执对账与明确的未知状态，覆盖每个提交窗口；不能以两次普通写入冒充原子事务。

## 独立验收与下一步

目标达成来自目标成功条件的独立观测，不来自 native `complete`、模型自评、步骤退出码或“所有子步骤已完成”。结果需绑定目标定义及新鲜度；部分步骤完成只改善进度，不能消除剩余条件。

未知或失败应形成可执行的后续计划：重查过期假设、收集缺失证据、改变方法或请求具体资源。下一步仍受预算与授权约束。复用 Automations 的持久 at 唤醒、occurrence/task/run 幂等身份和 scheduler lease；不再创建第二套定时器。唤醒时重验 scope、定义、期限、预算和 lease，并恢复原 Session；跨会话迁移必须有明确的新关联协议。

## 必须验证的真实路径

1. 真实 owner 工具创建、编辑、暂停、恢复和 clear；旧 revision、错误 owner、非人类回合及跨 Session focus 均无法控制目标。
2. 真实原生 driver 暂停后不继续，重启保持 disarmed，明确授权恢复后由已有 AgentLoop 推进；轮次上限不被重启或反复恢复重置。
3. 明确目标步骤在模型调用前冻结契约；普通聊天任务仍按原消息验收，不被活动目标替换。
4. 定义修改、owner 撤销和预算耗尽发生在准备、提交、回读的不同边界，均不能用过期权限继续；unknown 恢复不重复外部提交。
5. 完整跨会话/跨日目标通过独立条件验收，包括真实失败、过时假设重查、依赖变化传播、停止和恢复。
6. 受支持的全新 Web profile 从能力选择、owner 建立、模型预算到完成示例目标；doctor 分别报告上下文可用、原生续跑可用、独立验收可用和隔离执行可用。缺少某一层时给出准确修复，不将可调用工具的数量当作自治就绪。

上述各项最终需要真实模型和部署证据；确定性 Host 测试只证明相应工程机制。整体智能收益继续由工作包 04 的同预算基线与留出评测衡量。
