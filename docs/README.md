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

## Provider 调研

- [CLIProxyAPI 第一手证据复核](cliproxyapi-provider-evidence-review.md)：两个 provider 的上游证据与可采用边界。
- [CLIProxyAPI Provider 优化调研](cliproxyapi-provider-optimization-research.md)：更完整的历史方案与实现建议。
- [Grok Bot Codex 路由调研](grok-bot-codex-router-research.md)：Codex 路由模式的历史研究。

## 个人助理设计

- [插件生态研究与建设清单](dsh-personal-assistant-plugin-landscape.md)：社区方案、能力拆分和风险对照。
- [全自研插件路线图](dsh-personal-assistant-self-built-plugin-roadmap.md)：个人助理的总体边界、阶段和未实现项。

## 飞书历史研究

以下文档保存设计依据，不作为当前配置或行为说明；当前行为见 [`lark-channel`](../plugins/lark-channel/README.md) 与 [`assistant-delivery`](../plugins/assistant-delivery/README.md)。

- [飞书连接与会话模型选择](lark-channel-open-source-design-notes.md)：官方与社区实现的设计取舍。
- [消息 Reaction 与安全进度展示](lark-message-reactions-and-progress-notes.md)：API、权限、隐私和进度状态研究。

## 历史实施计划

[`superpowers/plans`](superpowers/plans/) 保存个人助理各插件与阶段性修复的历史实施计划。它们用于追溯设计过程；当前行为仍以代码、插件 README 和上述维护文档为准。
