# RSI 当前状态

更新：2026-09-29。唯一进展入口；实现依据为仓库代码与已提交验收记录，部署结论以注明的检查范围为限。配置查对应插件 README，完整成功条件按需查[验收合同](rsi-acceptance.md)，已完成流水查 Git。

## 目标与完成标准

**实现一个能在使用过程中不断进化的智能体，包含持久记忆学习与工程能力进化，以 Cordis 动态加载的插件为主要扩展载体。** 一次配置与授权后，日常任务的失败、纠正和重复需求应自动驱动：

```text
真实任务与反馈 → 持久学习 → 技能/工具/插件候选 → 独立验证
             → 授权范围内有限采用 → 后续真实任务 → 观察、保留或回滚
```

用户不必逐次调用捕获、修复、比较或发布工具。沿用 DSH 原生 AgentLoop、Automations 和 Cordis 生命周期；默认继承来源任务模型，每轮冻结供应、预算与验收，保留身份、历史和能力版本。验收不能由候选改写，模型自评和工具退出码不能证明改进。

**结论：基础组件及多段工程链路已实现，普通使用驱动的完整自迭代闭环尚未验收，下一版 npm 发布门槛尚未满足。**

## 已具备的能力

| 能力 | 当前实现与证据边界 | 按需入口 |
| --- | --- | --- |
| 日常助手 | 飞书 owner 绑定、普通对话、持久投递、工具审批和固定 T1 偏好学习已有实现；已有本机真实基本对话记录。偏好适配不代表工具/插件自迭代完成。 | [Delivery](../plugins/assistant-delivery/README.md)、[偏好学习](../plugins/preference-learning/README.md) |
| 持久记忆 | 普通任务事实与后到客观结果经验的自动学习 bundle 已接入原生调度、候选提取、独立审查及有限采用；纠正/撤回重验检索，手动版本受保护，unknown 对账不重放。初始 owner 安装组合仍缺；工程集成的模型/审查语义用 fixture，尚未验收真实后续任务收益。 | [自动学习](../plugins/assistant-memory-learning/README.md)、[Memory](../plugins/personal-memory/README.md#有限授权的事实与经验采用) |
| 反馈进入成长 | 内置外部渠道支持回复精确结果消息的明确自然反馈（有限语句模式）、纠正/撤回、canonical 去重与来源模型冻结；Growth 通过原生 Automations 持久复盘，生成 owner 绑定的修复依据。工程集成包含模型/传输替身；新增自然反馈入口不覆盖原生 Web、自定义运行时或所有后台任务。 | [Growth Driver](../plugins/assistant-growth-driver/README.md)、[Evaluation](../plugins/assistant-evaluation/README.md) |
| 候选与独立验证 | 普通反馈可生成现有插件的源码修改，隔离检查、有限批准、独立审查与本地发布阶段已接线；自动创建新插件尚未接通；Skills 有版本化比较及限定任务族的真实留出/canary 证据。通用收益与同预算改善未验收，Skills 仍有逐 Goal 手动 arm 的缺口。 | [源码提案](live-durable-source-proposal.md)、[技能复用](native-skill-reuse.md) |
| 采用、观察与恢复 | Control Plane 已有跨 Host 交接、reload/readiness、有限试用资格、普通任务归因、重启补证及物理回退组件；内置采用仍重启整个 Host，Cordis 行级动态采用尚未接通。工程测试和分段真实探针不能合并为生产全链证明；严格合同的独立行为/副作用观测仍缺。 | [有限试用合同](bounded-live-adoption.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 安装与维护 | Linux supervised 已接入冻结源码包、离线构建资源、独立签名身份、owner 配置与双 Host 安装；pre-owner 单 profile 更新已有真实记录。已有 owner 的成对冻结源码完整升级仍未实现；真实跨版本 Host 升级待兼容官方候选。 | [安装指南](../scripts/install/README.md)、[双 Host 配置](../plugins/lark-channel/docs/rsi-setup.md) |

## 当前阻塞

本机 `dsh-profile-assistant.service` 只读检查为 active/running、NRestarts=0；目标 profile patch 的 owner routes 为空且 scheduler 关闭，独立协调器尚未完成部署。此前固定 Recovery 激活的健康门因 Delivery 失败和 Automation 告警阻止安装。普通 RSI 安装已与固定 runbook 解耦，保留历史、原健康门及 scheduler 启动授权；工程检查和独立静态复核通过，真实成对部署与普通任务连续验收仍缺。

最新审批卡终态的真实点击、拒绝态视觉检查及业务授权中断恢复仍待验证，属于日常使用可靠性收尾。应用/用户 scopes 以平台实际批准为准，基本聊天不证明所有业务权限可用。

## 下一步：按顺序完成一个可用闭环

1. **打通实际 owner 自迭代安装。** 处理当前失败/告警的真实原因与安装耦合，保留历史和恢复门；验收目标与协调器启动、有限授权/预算、原生调度、重复安装与失败恢复。已有 owner 成对冻结升级按实际部署需要补齐，不让一般升级扩展取代主线。
2. **接入两条进化通道。** 将自动记忆学习的准确 owner、独立审查与采用 grant/预算组合进初始安装，验收真实来源和后续召回；工程通道能在有限授权内生成新插件，经独立验证后通过 Cordis 动态加载采用、观察并回滚。复用现有原生运行循环与签名状态机，不能以手动记忆工具、脚手架或整 Host 重启代替。
3. **从普通反馈完成真实改进并观察后续任务。** 同一可追溯链路覆盖真实失败/纠正 → 持久复盘 → 候选 → 独立验证 → 授权采用 → 新任务复用；验证纠正/撤回、重启、退化与回退，unknown 外部动作先对账、不重放。有限试用须显式使用其合同，不冒充严格 shadow/canary/soak/health 验收；部署关联不等于因果收益。记录质量、成本、延迟与回归，必要时同供应同预算比较。
4. **通过发布门后交付 npm。** 可安装部署完成上述普通使用闭环、独立复核和整仓 `pnpm check` 后，按[发版指南](releasing.md)发布。组件测试、手工探针或待审批提案不能替代该门槛。

长期业务目标、策略收益、记忆决策收益、独立 broker/生产平台、真实事件来源、主动建议效果、3–5 类高频流程及真实仓库 CI/readback 等完整目标保留在[验收合同](rsi-acceptance.md)；它们不作为重复加载的日常流水，也不因此被宣称完成。

## 验证与维护

- 本轮自动生产者的存储、原生 Agent 守卫、原生调度和真实 Delivery/Evaluation/Memory 集成测试已通过；覆盖晚到来源/结果、额度、锁、纠正撤回、unknown 不重放与后续 prompt/检索。提取模型和独立审查结论仍用 fixture，不证明真实供应商效果或后续收益。
- 本轮自动生产者经独立只读复核，`VITEST_MAX_WORKERS=4 pnpm check` 完整通过：manifest、零警告 lint、类型、根及全部包测试、干净构建与全部包 dry-run pack。原始日志放忽略的 `docs/evidence/rsi-memory-learning/`；外部测试跳过不作为 live 证据，未改生产部署或发布 npm。
- 本页只保留当前结论、阻塞与下一项验收。完成项合并进能力表并删除过程叙述；细节维护在对应指南，原始日志留忽略的 `docs/evidence/` 或 CI artifacts，历史查 Git。
