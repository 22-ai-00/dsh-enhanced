# RSI 当前状态

更新：2026-09-29。日常只加载本页和相关插件 README；实现与验证历史查 Git，完整成功条件按需查[验收合同](rsi-acceptance.md)。

## 唯一目标

**实现一个能在普通使用中持续自迭代的智能工具，包含持久记忆与工程能力进化，以创建和动态加载 Cordis 插件为主要扩展方式。** 初始配置与授权后，用户不必逐次编排改进：

```text
真实任务与反馈 → 持久学习 → 技能/工具/插件候选 → 独立验证
             → 有限授权采用 → 后续真实任务 → 观察与回滚
```

复用 DSH 原生 AgentLoop、Automations 和 Cordis 生命周期。默认继承来源任务模型，冻结每轮供应、预算与验收；验收不能由候选改写，模型自评、工具成功和部署关联不能证明收益。

**当前结论：基础组件与部分链路已实现；普通使用驱动的完整闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 已实现 / 尚缺 | 按需入口 |
| --- | --- | --- |
| 日常助手 | owner 绑定、持久投递、工具审批和偏好学习已有实现与基本对话记录；不代表自迭代验收。 | [Delivery](../plugins/assistant-delivery/README.md) |
| 持久记忆 | 自动提取事实/经验、独立审查、有限采用、纠正撤回与 unknown 对账已接线；初始 owner 安装组合和真实后续任务收益待验收。 | [自动学习](../plugins/assistant-memory-learning/README.md)、[Memory](../plugins/personal-memory/README.md) |
| 反馈与工程候选 | 普通反馈、canonical 去重、原生调度复盘及现有插件源码修改已有实现；自动创建新插件未接通，Skills 仍有逐 Goal 手动 arm 缺口。 | [Growth Driver](../plugins/assistant-growth-driver/README.md)、[技能复用](native-skill-reuse.md) |
| 采用与恢复 | 跨 Host 交接、有限试用、任务归因、重启补证和回退已有组件；采用仍重启整 Host，Cordis 动态加载和独立行为/副作用观测未接通。 | [Control Plane](../plugins/plugin-control-plane/README.md)、[有限试用合同](bounded-live-adoption.md) |
| 安装 | 冻结源码、签名身份、owner 配置和双 Host 安装已有工程实现；真实成对部署、已有 owner 的完整冻结升级仍缺。 | [安装指南](../scripts/install/README.md)、[双 Host 配置](../plugins/lark-channel/docs/rsi-setup.md) |

## 当前阻塞与下一项验收

此前本机只读检查：目标服务 active/running，但 owner routes 为空、scheduler 关闭，独立协调器尚未部署。普通 RSI 安装已与固定 Recovery 解耦；真实部署仍需通过原健康门，保留历史和有限授权；此前 Delivery 失败与 Automation 告警需复验处理。审批卡真实点击/拒绝态及业务授权中断恢复也未验收。

1. **完成可用的 owner 安装。** 接入自动记忆学习的准确 owner、独立审查/采用 grant 与预算；验收双 Host 启动、原生调度、重复安装和失败恢复，以及真实来源到后续记忆召回。已有 owner 的升级按实际部署需要补齐。
2. **完成工程进化。** 有限授权内自动创建新插件，独立验证后由 Cordis 动态加载、观察并回滚；复用现有原生循环和签名状态机。
3. **验收普通使用闭环并交付。** 从真实失败/纠正走到采用和后续任务复用，验证撤回、重启、退化及 unknown 不重放，记录质量、成本、延迟与回归。有限试用不等于严格 shadow/canary/soak/health 验收。通过完整验收、独立复核和整仓检查后，按[发版指南](releasing.md)发布 npm。

## 最新验证与维护

自动记忆学习组件经独立只读复核，`VITEST_MAX_WORKERS=4 pnpm check` 完整通过；提取模型与审查结论使用 fixture，跳过的外部测试不作为真实运行证据。未改生产部署、未发布 npm。

本页只保留目标、能力边界、当前阻塞、下一项验收与最新验证；完成过程删除，详细合同与配置按需读取，原始证据留忽略的 `docs/evidence/` 或 CI artifacts。
