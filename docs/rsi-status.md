# RSI 当前状态

更新：2026-09-30。默认只加载本页与当前任务相关的插件 README；历史查 Git，具体成功条件按需查[验收合同](rsi-acceptance.md)。

## 唯一目标

**实现一个能在普通使用中持续自迭代的智能工具，包含持久记忆与工程能力进化，以创建和动态加载 Cordis 插件为主要扩展方式。** 初始配置与授权后，用户不必逐次编排改进。

```text
真实任务与反馈 → 持久学习 → 技能/工具/插件候选 → 独立验证
             → 有限授权采用 → 后续真实任务 → 观察与回滚
```

复用 DSH 原生 AgentLoop、Automations 和 Cordis 生命周期；继承来源任务模型，冻结供应、预算与验收。独立验收不受候选改写，收益以随后真实任务的质量、成本、延迟和回归判断。

**当前结论：基础组件与部分链路已实现；普通使用驱动的完整闭环尚未验收，npm 发布门未满足。**

## 已交付边界

| 能力 | 当前边界 | 按需入口 |
| --- | --- | --- |
| 日常任务 | owner 绑定、持久投递、工具审批、普通反馈与原生调度已有实现。 | [Delivery](../plugins/assistant-delivery/README.md)、[Growth](../plugins/assistant-growth-driver/README.md) |
| 持久记忆 | 自动提取、独立审查、有限采用、纠正撤回及 unknown 对账已接线；真实部署与后续任务收益未验收。 | [自动学习](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 现有插件源码修改、检查与签名采用已有组件；自动创建新插件尚未交付，采用仍重启整 Host。 | [Control Plane](../plugins/plugin-control-plane/README.md) |
| 安装与恢复 | 冻结安装、owner 配置、双 Host 交接、有限试用及回退已有组件；旧 pre-owner 安装可准备新增学习插件的候选，实际激活与成对部署未验收。 | [安装配置](../plugins/lark-channel/docs/rsi-setup.md)、[有限试用](bounded-live-adoption.md) |

## 当前缺口与下一项验收

本机仍为 pre-owner 部署：owner routes 为空、scheduler 关闭。服务运行不代表业务健康，Delivery 死信与 Automation 告警尚未处理；已准备的学习插件候选不代表生产已激活。

1. **当前代码交付：自动创建插件候选。** 反馈驱动的模板读取、有限创建授权、持久配额与隔离检查正在实现，尚未整合验收；须完成独立复核及整仓检查后单独交付。候选检查通过不等于获准采用。
2. **完整工程链路：独立验证 → Cordis 动态加载 → 观察/回滚。** 创建候选的签名采用、真实 Host 动态加载与副作用恢复仍缺；Skills 的逐 Goal 手动 arm 缺口也需消除。
3. **真实普通使用验收。** 完成 owner、独立协调器、有限授权与预算的双 Host 部署；验证反馈到记忆/工程改进、随后任务复用，以及纠正撤回、重启、退化和 unknown 不重放。真实审批与业务授权恢复也在此门内。全部通过后按[发版指南](releasing.md)发布 npm。

## 最新验证

已交付代码 `8d2018a` 经独立复核与 `VITEST_MAX_WORKERS=4 pnpm check`：7780 tests passed、51 skipped，manifest/lint/typecheck/build/pack 通过；真实离线安装候选及读回已核验。模型语义仍主要使用 fixture，跳过不证明外部行为；未激活生产部署、未发布 npm。自动创建的工作区改动不包含在这次整仓验证中。
