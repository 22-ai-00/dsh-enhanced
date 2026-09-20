# 业务目标编排：执行与验收接线

更新：2026-09-20。本文说明当前组合边界；配置见 [Goals README](../plugins/assistant-goals/README.md)，剩余验收统一见 [RSI 当前状态](rsi-status.md) 的 WP03–WP06、WP08 与 WP18。

## 原生执行与独立验收

DSH 原生 Goal、Session 与 AgentLoop 拥有目标生命周期和执行轮次。Goals 保存业务定义、owner、依赖、预算和验收绑定；跨会话 focus 只提供上下文，不改变执行归属。前台请求的验收保留当前用户输入，不用旧目标原文替换后续消息。

原生 `GoalId + revision`、业务记录版本、目标定义和步骤执行身份分别校验。`goal_control` 使用原生 revision CAS，执行前重查 owner、定义、依赖、期限和预算。原生 complete、工具成功退出和模型自评均不能代替独立目标验收。

Verifier 从可信生产者回读准确的 step/run 与产物，以版本化契约验收。隔离测试向量由 Host authority 保存，来源 worker 与验证 worker 分开运行；具体协议见[共享任务契约](../packages/task-acceptance-contract/README.md)和 [Verifier](../plugins/assistant-verifier/README.md)。历史成功回执不能授权当前执行，业务库与 Session 也不构成原子事务。

## 持久唤醒与事件等待

可选 `backgroundWake` 复用 Automations 的持久 `at` 调度与 Host executor；Delivery 持有与前台共用的 Session lease，恢复原 Session、GoalId 和 revision。普通 Automation runner 创建新 Session，不可用作目标恢复入口。

`goal_schedule` 先暂停并 checkpoint 原生目标，再依次写入 paused Automation、Goals 的 definition-hash 绑定，最后激活。恢复前重新核对全部 authority；紧邻原生 resume 的 occurrence CAS 固定派发边界。派发后崩溃或无法证明停止时保持 unknown，禁止自动重放。`eventWaits` 将已有 Event Triggers 的受授权事件连接到同一恢复路径，不创建第二套调度或目标循环。

Delivery 等待准确 Agent 的步骤及全目标验收后再释放租约；idle 或轮次耗尽不是验收完成。前台有界续跑仍属于当前请求，回复入队、送达、任务验收和业务目标达成分别记录。

## 源码与验证入口

| 契约 | 实现入口 |
| --- | --- |
| 定义、步骤、结果及预算 | [Goals 源码](../plugins/assistant-goals/src/) |
| 唤醒准入、持久记录与执行 | [wake.ts](../plugins/assistant-goals/src/wake.ts)、[wake-store.ts](../plugins/assistant-goals/src/wake-store.ts) |
| 调度、租约与恢复 | [Automations](../plugins/assistant-automations/README.md)、[Delivery](../plugins/assistant-delivery/README.md) |
| 独立验收 | [Verifier](../plugins/assistant-verifier/README.md)、[Isolation](../plugins/assistant-isolation/README.md) |

`pnpm test:autonomy:wake` 检查临时 profile 的安装、进程重启、撤权和中断后不重放；需要已固定的本机 Docker 镜像及浏览器，参数见 Goals README。真实仓库路径见[仓库 E2E](live-repository-e2e.md)。这些入口及已有组件不等于跨日生产目标、完整授权维度或同预算收益已经验收。
