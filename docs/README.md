# 文档索引

根 [`README`](../README.md) 只保留安装、能力和开发入口。本目录收录维护协议、兼容性说明与设计研究；具体插件的当前配置和行为以各插件 README 为准。

## 开发与维护

- [新增插件](creating-a-plugin.md)：插件目录、manifest、patch、测试、README 和目录登记的完整清单。
- [仓库架构](architecture.md)：bundle 与共享库边界、独立发布和 Host/Web 双面设计。
- [兼容性基线](compatibility.md)：DSH、Cordis、Node.js 与 pnpm 的版本约束。
- [发版指南](releasing.md)：统一版本、tag/workflow、失败重试、竞态和 npm 凭据协议。

## 安装与平台兼容

- [安装脚本](../scripts/install/README.md)：本地/远程安装、场景选择、升级、重启和凭据边界。
- [ACP Windows 兼容性复查](acp-windows-compatibility.md)：原生 Windows 支持现状和限制。

## Provider 参考与历史研究

- [Coding subscription provider 详细参考](coding-subscription-provider-reference.md)：完整配置、认证门禁、传输协议、错误码与已知限制。
- [CLIProxyAPI 设计依据](cliproxyapi-provider-evidence-review.md)：固定上游来源、已采用机制与当前 provider 契约入口。

## RSI 状态与设计

- [原生技能复用评测接线](native-skill-reuse.md)：来源验证、受限 Host 委派、原生双臂评测与签名留出报告。
- [RSI 当前状态](rsi-status.md)：唯一进展入口，保留 18 项验收条件、当前边界与剩余工作。
- [自迭代研究与开发原则](research-dsh-plugin-self-iteration-2026-09-19.md)：模型供应、DSH 原生组合、独立验收与新任务复用。
- [持续成长设计](continuous-personal-assistant-growth.md)：反馈、偏好、评测指标和长期成功条件。
- [目标编排](goal-orchestration-design.md)：原生执行、独立验收、持久唤醒与事件等待。
- [固定任务评测](benchmark-implementation.md)、[执行策略评测](goal-strategy-evaluation.md)：固定供应与预算的比较方法及证据限制。
- [技能比较配置](skill-comparison-profiles.md)、[独立留出验收](skill-holdout-authority.md)：原生重放、冻结后生成任务、签名验收与有限 canary。
- [源码提案与持久检查](live-durable-source-proposal.md)、[真实仓库 E2E](live-repository-e2e.md)：可复现入口与当前验证边界。
- [插件生态研究](dsh-personal-assistant-plugin-landscape.md)：固定来源与第三方候选审查；旧安装方案和建设清单已移除，当前包列表见[插件目录](../plugins/README.md)。
- [systemd Host 签名器](systemd-host-attestor.md)、[运行时观测](runtime-observer.md)、[阻断回放](effect-blocked-replay.md)：当前发布/启用组件契约与验证限制。
- [发布 adapter](npm-publish-adapter.md)、[独立发布验签](npm-release-verifier.md)、[catalog 准入](npm-catalog-admission.md)、[registry 读回](npm-registry-readback.md)：发布组件与可复现探针；[adapter 生命周期](control-plane-adapter-lifetime.md)说明进程归属、取消和清理边界。

原始运行 JSON 和日志留本地或 CI artifacts；当前文档只记录可复现命令、验证结论及限制。过期交接快照和实施流水从 Git 历史查询。

## 飞书历史研究

以下文档保存设计依据，不作为当前配置或行为说明；当前行为见 [`lark-channel`](../plugins/lark-channel/README.md) 与 [`assistant-delivery`](../plugins/assistant-delivery/README.md)。

- [飞书连接与会话模型选择](lark-channel-open-source-design-notes.md)：官方与社区实现的设计取舍。
- [消息 Reaction 与安全进度展示](lark-message-reactions-and-progress-notes.md)：API、权限、隐私和进度状态研究。
