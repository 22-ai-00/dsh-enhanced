# 插件目录

每个条目都是可独立安装、发布的 DSH bundle；按职责分组如下。发布版本见[发布账本](../release-manifest.json)，当前开发进展和验收边界见 [RSI 状态](../docs/rsi-status.md)。

## Agent 与模型接入

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [acp](acp) | `@dsh-enhanced/acp` | 实验性 | 原生优先的 ACP stdio bridge，支持四种 DSH Agent 预设、动态模型/推理等级、富事件映射与可选原始事件出口。 |
| [coding-subscription-provider](coding-subscription-provider) | `@dsh-enhanced/coding-subscription-provider` | 实验性 | 将本机已登录的 Codex、Claude Code、Cursor Agent 与 Grok Build 编程套餐注册为 DSH 模型 provider；四者动态发现模型，Codex/Claude/Grok 支持逐模型 reasoning effort。 |
| [traex-acp-provider](traex-acp-provider) | `@dsh-enhanced/traex-acp-provider` | 实验性 | 让 DSH 作为 ACP client 调用本机 TraeX coding agent，并实时发现可选模型及逐模型 reasoning effort。 |
| [assistant-deepseek-budget](assistant-deepseek-budget) | `@dsh-enhanced/assistant-deepseek-budget` | 实验性 | 官方 DeepSeek 文本模型的固定路由与持续目标 token 预算计量；保守预留，禁止重定向，不声明硬金额上限。 |

## 个人助理核心

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-policy](assistant-policy) | `@dsh-enhanced/assistant-policy` | 实验性 | 个人助理的默认拒绝授权、硬预算、审批提案和脱敏审计边界。 |
| [assistant-evaluation](assistant-evaluation) | `@dsh-enhanced/assistant-evaluation` | 实验性 | 区分执行、目标与投递的本地评测账本；Host 写可信事实，模型只能在精确 scope 内追加独立的低信任自评。 |
| [assistant-verifier](assistant-verifier) | `@dsh-enhanced/assistant-verifier` | 实验性 | 事前冻结 AgentLoop 任务验收，独立核对结果并记录可信反馈修订。 |
| [assistant-goals](assistant-goals) | `@dsh-enhanced/assistant-goals` | 实验性 | 按 owner 持久保存原生目标的上下文、下一步和阻塞；跨会话检索，完成状态等待独立验收。 |
| [preference-learning](preference-learning) | `@dsh-enhanced/preference-learning` | 实验性 | 从有界 typed feedback 形成可衰减偏好假设；只允许 Host 固定目录中的 T1 局部偏好临时生效并自动回滚，不把推断伪装成长期 Memory。 |
| [personal-memory](personal-memory) | `@dsh-enhanced/personal-memory` | 实验性 | 有界、分域的长期记忆，支持手动审批及独立审查后的有限事实/经验采用。 |
| [assistant-memory-learning](assistant-memory-learning) | `@dsh-enhanced/assistant-memory-learning` | 实验性 | 前台任务驱动事实/经验学习；三份授权显式启用后可从后台 WorkItem 结果提取经验。原生调度、独立审查、有限采用，保留纠正撤回与未知结果对账。 |
| [personal-wiki](personal-wiki) | `@dsh-enhanced/personal-wiki` | 实验性 | 以 Markdown 为真源、支持中文检索与审批写入的个人知识库。 |
| [assistant-automations](assistant-automations) | `@dsh-enhanced/assistant-automations` | 实验性 | 单机冷启动持久调度、occurrence/task/run 账本、租约 fencing 与隔离 Agent 执行。 |
| [personal-assistant](personal-assistant) | `@dsh-enhanced/personal-assistant` | 实验性 | 只组合 Policy、Memory、Wiki、Automations 四核心的保守默认 meta-bundle。 |

## 渠道、触发与投递

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-delivery](assistant-delivery) | `@dsh-enhanced/assistant-delivery` | 实验性 | 不含厂商 SDK 的持久消息核心：配对、会话绑定、inbox/outbox、receipt、重试与未知发送对账。 |
| [assistant-web-owner](assistant-web-owner) | `@dsh-enhanced/assistant-web-owner` | 实验性 | 原生 Web 的固定 owner、可信文本回合与 Session 生命周期接入。 |
| [lark-channel](lark-channel) | `@dsh-enhanced/lark-channel` | 实验性 | 飞书/Lark 长连接薄适配器：持久化后应答、`Get`/`DONE` 状态、脱敏执行进度、模型/审批卡片、安全 onboarding 与 launchd/systemd/Windows Task 常驻。 |
| [owner-console](owner-console) | `@dsh-enhanced/owner-console` | 实验性 | 左侧栏主人控制台：飞书远程接入、TraeX 与本项目 bundle/条目的一页管理；只读状态 + 主人点击的配置/启用/安装，写入只经 Host `settings`/`pluginManager`，不发起模型调用。 |
| [assistant-heartbeat](assistant-heartbeat) | `@dsh-enhanced/assistant-heartbeat` | 实验性 | 复用 Automations 的 active-hours 主动巡检、scratch CAS、busy coalescing 与成本硬界限。 |
| [event-triggers](event-triggers) | `@dsh-enhanced/event-triggers` | 实验性 | 持久化 file、HTTPS/JSON、GitHub 仓库状态与 HMAC webhook 事件，支持有限 owner 授权观察与目标等待来源。 |
| [assistant-proactive](assistant-proactive) | `@dsh-enhanced/assistant-proactive` | 实验性 | 已授权目标事件的收益筛选、静默记录、合并、冷却和持久预算；实际执行仍经 Goals 验收。 |
| [assistant-work-items](assistant-work-items) | `@dsh-enhanced/assistant-work-items` | 实验性 | 默认关闭、observe 模式；持久认领/汇报与有界 resume，显式授权可启用诊断、主人召回、报告回复续办及结果反馈。复用 Automations/Delivery/Policy，不新增 loop、timer 或 outbox；结果反馈可另行授权进入经验学习，工程 Growth 仍待完整验收。 |

## 技能与持续成长

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-skills](assistant-skills) | `@dsh-enhanced/assistant-skills` | 实验性 | 独立验收任务的私有版本化工具技能、原生发现与新目标复用。 |
| [assistant-evolution](assistant-evolution) | `@dsh-enhanced/assistant-evolution` | 实验性 | 审批门控的行为自演化：按证据提出 guidance，经 owner 批准后注入；只允许对 Host 证明已退化的 exact rule 自动回滚，不能自我采用、扩权或原地改写。 |
| [assistant-growth-experiments](assistant-growth-experiments) | `@dsh-enhanced/assistant-growth-experiments` | 实验性（supervised 场景包含） | 审批后的工作流 replay/shadow/单次 canary、晋升与撤回；已接入真实 Automations 服务及组合测试。core/lark 不默认安装，阶段通过不单独证明能力相对基线改善。 |
| [assistant-growth-driver](assistant-growth-driver) | `@dsh-enhanced/assistant-growth-driver` | 实验性 | 按真实前台 owner 任务反馈创建持久成长作业，复用原生调度并冻结实际模型与预算；技能/工作流候选仍需独立验证，新工具创建可在配套授权下独立验收并有限采用，修订替换另有验收门。完整长期成长闭环尚未验收。 |

## 安全、治理与运维

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [credentials-keychain](credentials-keychain) | `@dsh-enhanced/credentials-keychain` | 实验性 | macOS Keychain/Linux Secret Service/Windows DPAPI/单变量 provider、policy gate、TTL/撤销和 secret-free lease 审计。 |
| [memory-wiki-bridge](memory-wiki-bridge) | `@dsh-enhanced/memory-wiki-bridge` | 实验性 | 只通过公开 service 生成带稳定 provenance 的 Memory↔Wiki 审批提案。 |
| [assistant-health](assistant-health) | `@dsh-enhanced/assistant-health` | 实验性 | 聚合 provider 自有 health seam 的脱敏 liveness/readiness/详细报告。 |
| [assistant-recovery](assistant-recovery) | `@dsh-enhanced/assistant-recovery` | 实验性 | 无模型、固定 catalog、带幂等步骤账本的 `supervised-growth/v2` Host 恢复控制面。 |
| [assistant-isolation](assistant-isolation) | `@dsh-enhanced/assistant-isolation` | 实验性 | 有限 owner 授权的离线 Linux 原生/Docker 执行、持久恢复、私有审计与外部撤销；Linux 原生新装及 pre-owner 维护已接通，cgroup v1 与已有 owner 迁移限制见[运行时指南](../docs/dockerless-runtime.md)。 |
| [assistant-actions](assistant-actions) | `@dsh-enhanced/assistant-actions` | 实验性 | 有限 owner 授权的 GitHub 动作；外部 v1 broker 支持 expected-head commit、仓库/分支/文件/PR/check/review/指定提交检查读取，以及独立授权的已验收产物 PR 交付。直接模型建 PR 仅限内嵌模式。外部凭据与权威账本由独立 broker 持有，UID、service unit、key 与基础设施由部署方配置。 |
| [plugin-control-plane](plugin-control-plane) | `@dsh-enhanced/plugin-control-plane` | 实验性 | 按能力发现、owner 审批、隔离验证与原子启用 bundle；按配置后端准备并检查源码候选。新工具创建支持独立行为验收和有限动态采用，修改、修订与源码发布各有独立授权和验收门；平台与迁移限制见本包说明。 |

## 示例与开发

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [hello](hello) | `@dsh-enhanced/hello` | 示例 | 最小可安装 bundle，用于验证仓库契约和开发链路。 |

<!-- plugin-catalog:end -->

状态建议使用“实验性 / Beta / 稳定 / 已弃用”。新增、重命名、弃用或移除插件时必须同步维护此表。
