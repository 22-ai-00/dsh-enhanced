# 插件目录

每个条目都是可独立安装、发布的 DSH bundle；按职责分组如下。

## Agent 与模型接入

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [acp](acp) | `@dsh-enhanced/acp` | 实验性 | 原生优先的 ACP stdio bridge，支持四种 DSH Agent 预设、动态模型/推理等级、富事件映射与可选原始事件出口。 |
| [coding-subscription-provider](coding-subscription-provider) | `@dsh-enhanced/coding-subscription-provider` | 实验性 | 将本机已登录的 Codex、Claude Code、Cursor Agent 与 Grok Build 编程套餐注册为 DSH 模型 provider；四者动态发现模型，Codex/Claude/Grok 支持逐模型 reasoning effort。 |
| [traex-acp-provider](traex-acp-provider) | `@dsh-enhanced/traex-acp-provider` | 实验性 | 让 DSH 作为 ACP client 调用本机 TraeX coding agent，并实时发现可选模型及逐模型 reasoning effort。 |

## 个人助理核心

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-policy](assistant-policy) | `@dsh-enhanced/assistant-policy` | 实验性 | 个人助理的默认拒绝授权、硬预算、审批提案和脱敏审计边界。 |
| [personal-memory](personal-memory) | `@dsh-enhanced/personal-memory` | 实验性 | 有界、分域、审批写入的个人助理长期记忆。 |
| [personal-wiki](personal-wiki) | `@dsh-enhanced/personal-wiki` | 实验性 | 以 Markdown 为真源、支持中文检索与审批写入的个人知识库。 |
| [assistant-automations](assistant-automations) | `@dsh-enhanced/assistant-automations` | 实验性 | 单机冷启动持久调度、occurrence/task/run 账本、租约 fencing 与隔离 Agent 执行。 |
| [personal-assistant](personal-assistant) | `@dsh-enhanced/personal-assistant` | 实验性 | 只组合 Policy、Memory、Wiki、Automations 四核心的保守默认 meta-bundle。 |

## 渠道、触发与投递

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-delivery](assistant-delivery) | `@dsh-enhanced/assistant-delivery` | 实验性 | 不含厂商 SDK 的持久消息核心：配对、会话绑定、inbox/outbox、receipt、重试与未知发送对账。 |
| [lark-channel](lark-channel) | `@dsh-enhanced/lark-channel` | 实验性 | 飞书/Lark 长连接薄适配器：持久化后应答、`Get`/`DONE` 状态、脱敏执行进度、模型/审批卡片、安全 onboarding 与 launchd/systemd/Windows Task 常驻。 |
| [assistant-heartbeat](assistant-heartbeat) | `@dsh-enhanced/assistant-heartbeat` | 实验性 | 复用 Automations 的 active-hours 主动巡检、scratch CAS、busy coalescing 与成本硬界限。 |
| [event-triggers](event-triggers) | `@dsh-enhanced/event-triggers` | 实验性 | 持久化 file、HTTPS/JSON 与 HMAC webhook 边缘事件，再以稳定 id 交给 Automations。 |

## 安全、治理与运维

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [credentials-keychain](credentials-keychain) | `@dsh-enhanced/credentials-keychain` | 实验性 | macOS Keychain/Linux Secret Service/Windows DPAPI/单变量 provider、policy gate、TTL/撤销和 secret-free lease 审计。 |
| [memory-wiki-bridge](memory-wiki-bridge) | `@dsh-enhanced/memory-wiki-bridge` | 实验性 | 只通过公开 service 生成带稳定 provenance 的 Memory↔Wiki 审批提案。 |
| [assistant-evolution](assistant-evolution) | `@dsh-enhanced/assistant-evolution` | 实验性 | 审批门控的行为自演化：观察结果、按证据提出行为规则、经 owner 批准后作为顾问性上下文注入；不能自我批准、不能扩权、不能原地改写。 |
| [assistant-health](assistant-health) | `@dsh-enhanced/assistant-health` | 实验性 | 聚合 provider 自有 health seam 的脱敏 liveness/readiness/详细报告。 |
| [plugin-control-plane](plugin-control-plane) | `@dsh-enhanced/plugin-control-plane` | 实验性 | 按能力发现、owner 审批、隔离验证与原子启用 bundle；源码创建/修改只允许 linked Git worktree + `pnpm check` + PR。 |

## 示例与开发

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [hello](hello) | `@dsh-enhanced/hello` | 示例 | 最小可安装 bundle，用于验证仓库契约和开发链路。 |

<!-- plugin-catalog:end -->

状态建议使用“实验性 / Beta / 稳定 / 已弃用”。新增、重命名、弃用或移除插件时必须同步维护此表。
