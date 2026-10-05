# RSI 当前状态

更新：2026-10-05。本页是唯一进展入口；只加载本页及当前任务相关 README。验收条件见[合同](rsi-acceptance.md)，历史细节查 Git。

## 目标

实现普通使用驱动的持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 当前边界 | 入口 |
| --- | --- | --- |
| 任务与记忆 | 已有认证反馈、原生调度与持久记忆学习；真实后续决策收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已有源码目标发现、失败任务优先复盘、新工具独立验收、有限签名采用与动态加载。明确配置保留期后，已采用工具可跨单次任务、plan 和证书窗口，冷启动延续原额度；仍受原使用授权截止时间约束。实际调用归因、版本替换回退与真实收益待验收。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 部署 | 本机冻结更新已成功，绑定 `c79d30e`，25 个包/18 个根 bundle，包含默认禁用的 Memory Learning；原身份与配置保留。尚未安装 owner/coordinator 或启用学习调度。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

下一步完成一次 owner/coordinator 配置。开启 scheduler 涉及现有三个 paused Automation，已请求确认但尚无答复，不能自动添加 `--ack-existing-automations`；重复任务提示不等于该确认。部署准备已完成，学习仍禁用。

当前工程交付先补齐可信的实际工具调用与具体普通任务、能力版本的关联，再推进版本替换与回退；同一 Session 的多个 Inbox 不能互相借用归因。

启用后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

本阶段 `VITEST_MAX_WORKERS=4 pnpm check` 退出 0：8163 项通过、61 项跳过，零 lint 警告、类型检查、干净构建及 37 个包 dry-run pack 通过，独立审查 PASS。有限保留测试覆盖过期 plan、原产物清理、完整 Context 冷启动、原调用额度和纠正/撤回；采用真实 Cordis/SQLite，Delivery/Evaluation 与容器执行器为测试替身，不能作为真实部署复用收益证据。

本机已部署版本仍为 `c79d30e`；其正式升级及独立部署复核曾通过，身份与配置摘要未变，Host 与真实 Lark 连接正常。本阶段尚未部署。原始记录分别保存在忽略目录 `docs/evidence/rsi-retained-capabilities/` 和 `docs/evidence/rsi-next-deployment/`；外部跳过测试不证明 live 行为。
