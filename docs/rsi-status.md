# RSI 当前状态

更新：2026-09-30。本页是唯一进展入口；默认只加载本页和当前任务相关的 README。完成细节查 Git，验收条件按需查[合同](rsi-acceptance.md)。

## 唯一目标

**实现一个能在普通使用中持续自迭代的智能工具：持久记忆与工程能力一起进化，以创建、动态加载 Cordis 插件为主要扩展方式。** 初始配置和授权后，用户不必逐次编排改进。

真实任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 当前边界与阻塞

| 能力 | 已有实现与剩余边界 | 按需入口 |
| --- | --- | --- |
| 任务与记忆 | 任务反馈、原生调度和记忆学习已有实现；记忆对后续真实决策的收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已能准备任务绑定的插件候选并隔离观察行为；新插件仍停在 pending，独立验收与有限采用未贯通，采用仍重启整 Host。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md)、[Verifier](../plugins/assistant-verifier/README.md) |
| 部署 | 安装、双 Host 交接与回退已有组件；普通使用闭环待部署验收。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[试用](bounded-live-adoption.md) |

## 下一次验收

**打通普通任务产生的新插件候选的独立验收与有限签名采用。** 规则必须在候选写权限之外冻结，凭证绑定当前任务修订与精确制品，纠正、撤回和 unknown 不得复用旧成功。验收接线正在开发，尚未交付。

随后完成 Cordis 动态装卸、后续任务复用与退化回滚，消除逐 Goal 手动 arm；最终以真实普通使用验证记忆和工程收益、重启恢复与 unknown 对账，通过[发布门](releasing.md)后再发布 npm。

## 最新验证

已交付代码基线 `bd52b8e`：根 `pnpm check`、37 包打包检查及 7 项真实 Docker 回归通过。未提交的验收开发不在此结论内；局部验证和跳过的外部测试不证明普通使用闭环。
