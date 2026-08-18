# 插件目录

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [acp](acp) | `@dsh-enhanced/acp` | 实验性 | 原生优先的 ACP stdio bridge，支持四种 DSH Agent 预设、动态模型/推理等级、富事件映射与可选原始事件出口。 |
| [hello](hello) | `@dsh-enhanced/hello` | 示例 | 最小可安装 bundle，用于验证仓库契约和开发链路。 |
| [coding-subscription-provider](coding-subscription-provider) | `@dsh-enhanced/coding-subscription-provider` | 实验性 | 将本机已登录的 Codex、Claude Code、Cursor Agent 与 Grok Build 编程套餐注册为 DSH 模型 provider；四者动态发现模型，Codex/Claude/Grok 支持逐模型 reasoning effort。 |
| [traex-acp-provider](traex-acp-provider) | `@dsh-enhanced/traex-acp-provider` | 实验性 | 让 DSH 作为 ACP client 调用本机 TraeX coding agent，并实时发现可选模型及逐模型 reasoning effort。 |

<!-- plugin-catalog:end -->

状态建议使用“实验性 / Beta / 稳定 / 已弃用”。新增、重命名、弃用或移除插件时必须同步维护此表。
