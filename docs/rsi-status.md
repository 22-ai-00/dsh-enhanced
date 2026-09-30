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
| 工程进化 | 现有插件修改已交付；新插件候选准备正在验收，尚未提交。创建实现包含有限 owner 授权、持久配额、模板与锁文件保护和隔离检查，仅到 pending。新插件独立签名采用尚缺，现有采用仍重启整 Host。 | [Control Plane](../plugins/plugin-control-plane/README.md)、[Growth](../plugins/assistant-growth-driver/README.md) |
| 安装与恢复 | 冻结安装、owner 配置、双 Host 交接、有限试用及回退已有组件；生产激活与普通使用验收尚缺。 | [安装配置](../plugins/lark-channel/docs/rsi-setup.md)、[有限试用](bounded-live-adoption.md) |

## 当前缺口与下一项验收

1. **当前交付：完成新插件候选准备的隔离验收。** 完成真实 Docker 整仓复验、实际打包与独立复核后单独提交。随后接通独立验收与有限签名采用：验收规则须在候选写权限之外，绑定当前 owner、任务修订、模型、预算和制品。创建的 pending 计划不能沿用旧修改审批器；初始授权后不应再逐插件人工编排。
2. **工程使用闭环：Cordis 动态加载 → 后续任务 → 观察/回滚。** 须完成真实 Host 的有界动态加载、副作用与磁盘状态恢复，以及源码 unknown 的自动资源对账；现有 unknown 不重放但仍需 Host 显式对账。Skills 的逐 Goal 手动 arm 缺口也需消除。
3. **真实普通使用验收。** 完成 owner、独立协调器、有限授权与预算的双 Host 部署，处理业务死信与告警；验证反馈驱动记忆和工程改进、后续任务复用，以及纠正撤回、重启、退化和 unknown 恢复。全部通过后按[发版指南](releasing.md)发布 npm。

## 最新验证

最近宿主 `VITEST_MAX_WORKERS=4 pnpm check`：7863 tests passed、51 skipped，manifest/lint/typecheck/build 与 37 包 dry-run pack 通过。真实 Docker 根测试通过 825 项、跳过 2 项；隔离测试夹具修复后，制品完整性聚焦 29 项通过。未提交能力仍待完整 Docker 整仓复验、实际打包及独立终态验收。模型语义仍主要使用 fixture，跳过不证明外部行为；生产普通使用闭环与 npm 发布门尚未满足。
