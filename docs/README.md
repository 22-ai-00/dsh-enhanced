# 文档索引

第一次使用从[首页的三步安装](../README.md#开始使用)开始。无需先了解插件结构或自迭代架构。

## 使用帮助

| 想做什么 | 从这里开始 |
| --- | --- |
| 安装、选择场景、解决启动问题 | [安装指南](../scripts/install/README.md) |
| 添加 API 模型、使用 TraeX、切换模型 | [模型配置](models.md) |
| 连接飞书、绑定机器人、排查没有回复 | [飞书接入](../plugins/lark-channel/docs/setup.md) |
| 查状态、看日志、升级、重装或卸载 | [dsh-rsi 命令参考](../packages/dsh-rsi-cli/README.md) |
| 了解当前能力与平台限制 | [当前状态](rsi-status.md) |
| 安装更多功能 | [插件目录](../plugins/README.md) |

以下资料供开发、维护或专项验收时查阅。

## 自迭代主线

- [当前状态](rsi-status.md)：唯一进展入口；目标是在普通使用中完成反馈、改进、独立验证、采用和后续观察。
- [双 Host 安装](../plugins/lark-channel/docs/rsi-setup.md)、[有限试用采用](bounded-live-adoption.md)：当前主线部署与采用合同。
- [完整验收合同](rsi-acceptance.md)：涉及具体能力或发布审查时查阅，保留完整成功条件与限定验收边界。
- [持续成长设计](continuous-personal-assistant-growth.md)：产品目标、反馈信任和自治边界；偏好学习不替代工具/插件自迭代。

## 开发与维护

- [新增插件](creating-a-plugin.md)：插件目录、manifest、patch、测试、README 和目录登记的完整清单。
- [仓库架构](architecture.md)：bundle 与共享库边界、独立发布和 Host/Web 双面设计。
- [Cordis 运行时契约](cordis-runtime-contracts.md)：修改生命周期、注入、配置、资源归属或重载时必读。
- [兼容性基线](compatibility.md)：DSH、Cordis、Node.js 与 pnpm 的版本约束。
- [发版指南](releasing.md)：统一版本、tag/workflow、失败重试、竞态和 npm 凭据协议。

## 高级维护与平台兼容

- [高级维护](../scripts/install/maintenance.md)：旧 Home 迁移、冻结源码维护和中断恢复。
- [ACP Windows 兼容性复查](acp-windows-compatibility.md)：原生 Windows 支持现状和限制。

## Provider 参考与历史研究

- [Coding subscription provider 详细参考](coding-subscription-provider-reference.md)：完整配置、认证门禁、传输协议、错误码与已知限制。
- [CLIProxyAPI 设计依据](cliproxyapi-provider-evidence-review.md)：固定上游来源、已采用机制与当前 provider 契约入口。

## 按需实现与验证参考

- [原生技能复用评测接线](native-skill-reuse.md)：来源验证、受限 Host 委派、原生双臂评测与签名留出报告。
- [目标编排](goal-orchestration-design.md)：原生执行、独立验收、持久唤醒与事件等待。
- [固定任务评测](benchmark-implementation.md)、[执行策略评测](goal-strategy-evaluation.md)：固定供应与预算的比较方法及证据限制。
- [技能比较配置](skill-comparison-profiles.md)、[独立留出验收](skill-holdout-authority.md)：原生重放、冻结后生成任务、签名验收与有限 canary。
- [源码提案与持久检查](live-durable-source-proposal.md)、[真实仓库 E2E](live-repository-e2e.md)：可复现入口与当前验证边界。
- [插件生态研究](dsh-personal-assistant-plugin-landscape.md)：固定来源与第三方候选审查；旧安装方案和建设清单已移除，当前包列表见[插件目录](../plugins/README.md)。
- [systemd Host 签名器](systemd-host-attestor.md)、[运行时观测](runtime-observer.md)、[阻断回放](effect-blocked-replay.md)：当前发布/启用组件契约与验证限制。
- [发布 adapter](npm-publish-adapter.md)、[独立发布验签](npm-release-verifier.md)、[catalog 准入](npm-catalog-admission.md)、[registry 读回](npm-registry-readback.md)：发布组件与可复现探针；[adapter 生命周期](control-plane-adapter-lifetime.md)说明进程归属、取消和清理边界。

原始运行 JSON 和日志留本地或 CI artifacts；当前文档只记录可复现命令、验证结论及限制。过期交接快照和实施流水从 Git 历史查询。

## 历史研究（仅按需读取）

- [自迭代研究与开发原则](research-dsh-plugin-self-iteration-2026-09-19.md)：模型供应、原生组合与独立验收的设计依据。

以下飞书文档保存设计依据，不作为当前配置或行为说明；当前行为见 [`lark-channel`](../plugins/lark-channel/README.md) 与 [`assistant-delivery`](../plugins/assistant-delivery/README.md)。

- [飞书连接与会话模型选择](lark-channel-open-source-design-notes.md)：官方与社区实现的设计取舍。
- [消息 Reaction 与安全进度展示](lark-message-reactions-and-progress-notes.md)：API、权限、隐私和进度状态研究。
