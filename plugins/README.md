# 插件目录

每个条目都是可独立安装、发布的 DSH bundle；按职责分组如下。不自动激活的共享库与 CLI 见[共享包目录](../packages/README.md)，发布版本见[发布账本](../release-manifest.json)（36 个插件 + 4 个共享包 = 40 个发布包），当前开发进展和验收边界见 [RSI 状态](../docs/rsi-status.md)。

## Agent 与模型接入

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [acp](acp) | `@dsh-ray/acp` | 实验性 | 原生优先的 ACP stdio bridge，支持四种 DSH Agent 预设、动态模型/推理等级、富事件映射与可选原始事件出口。 |
| [coding-subscription-provider](coding-subscription-provider) | `@dsh-ray/coding-subscription-provider` | 实验性 | 将本机已登录的 Codex、Claude Code、Cursor Agent 与 Grok Build 编程套餐注册为 DSH 模型 provider；四者动态发现模型，Codex/Claude/Grok 支持逐模型 reasoning effort。 |
| [traex-acp-provider](traex-acp-provider) | `@dsh-ray/traex-acp-provider` | 实验性 | 让 DSH 作为 ACP client 调用本机 TraeX（`traex-agent`）与 Antigravity CLI（`agy-agent`），支持模型发现、推理强度与配置热重载。 |
| [assistant-deepseek-budget](assistant-deepseek-budget) | `@dsh-ray/assistant-deepseek-budget` | 实验性 | 官方 DeepSeek 文本模型的固定路由与持续目标 token 预算计量；保守预留，禁止重定向，不声明硬金额上限。 |

## 个人助理核心

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-policy](assistant-policy) | `@dsh-ray/assistant-policy` | 实验性 | 个人助理的默认拒绝授权、硬预算、审批提案和脱敏审计边界。 |
| [assistant-evaluation](assistant-evaluation) | `@dsh-ray/assistant-evaluation` | 实验性 | 区分执行、目标与投递的本地评测账本；Host 写可信事实，模型只能在精确 scope 内追加独立的低信任自评。 |
| [assistant-verifier](assistant-verifier) | `@dsh-ray/assistant-verifier` | 实验性 | 默认开启 `requireAcceptance: true`：事前冻结 AgentLoop 任务验收，独立核对结果、支持 `'tool' | 'service' | 'channel' | 'ui'` 候选行为验收并记录可信反馈修订。 |
| [assistant-goals](assistant-goals) | `@dsh-ray/assistant-goals` | 实验性 | 按 owner 持久保存原生目标的上下文、下一步和阻塞；跨会话检索，完成状态等待独立验收。 |
| [preference-learning](preference-learning) | `@dsh-ray/preference-learning` | 实验性 | 默认开启 `enabled` 与 `autonomousT1Enabled`：从有界 typed feedback 形成可衰减偏好假设；只允许 Host 固定目录中的 T1 局部偏好临时生效并自动回滚，不把推断伪装成长期 Memory。 |
| [personal-memory](personal-memory) | `@dsh-ray/personal-memory` | 实验性 | 有界、分域的长期记忆，默认开启 `automaticLearning: true`，支持手动审批及独立审查后的有限事实/经验采用。 |
| [assistant-memory-learning](assistant-memory-learning) | `@dsh-ray/assistant-memory-learning` | 实验性 | 默认开启 `enabled` 与 `workItemExperiences`：前台任务驱动事实/经验学习，并在三份授权齐备后自动从后台 WorkItem 结果提取经验。原生调度、独立审查、有限采用，保留纠正撤回与未知结果对账。 |
| [assistant-association](assistant-association) | `@dsh-ray/assistant-association` | 实验性（`web`/`lark`/`supervised` 常规包含） | 进程内存双缓冲关联图与 ≤5ms 联想召回层（S1–S4，Schema v4）：默认开启本地召回、撤回级联、密封留出、Hebbian 更新与 WP22 参数自调参，以及默认开启的 S3 做梦建边/`intakeSignal`/片段聚类与 S4 OS 级隔离子进程只读白名单 Web 学习，配合 `growth-report` 第 6 节对照。 |
| [personal-wiki](personal-wiki) | `@dsh-ray/personal-wiki` | 实验性 | 以 Markdown 为真源、支持中文检索与审批写入的个人知识库。 |
| [assistant-automations](assistant-automations) | `@dsh-ray/assistant-automations` | 实验性 | 单机冷启动持久调度、occurrence/task/run 账本、租约 fencing 与隔离 Agent 执行。 |
| [personal-assistant](personal-assistant) | `@dsh-ray/personal-assistant` | 实验性 | 只组合 Policy、Memory、Wiki、Automations 四核心的保守默认 meta-bundle。 |

## 渠道、触发与投递

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-delivery](assistant-delivery) | `@dsh-ray/assistant-delivery` | 实验性 | 不含厂商 SDK 的持久消息核心：配对、会话绑定、inbox/outbox、receipt、重试与未知发送对账；默认开启 WP19 注意力强制/超长转附件/跨车道保序（`attentionEnforce`/`attentionAttachOverCap`/`orderAcrossLanes`）、默认注册 `inProcessReload`、R4 会话控制指令，以及 `/version`、`/autonomy version` 与自然语言只读版本及自迭代演进统计查询（支持委托 `ownerConsole.versionInfo()` 与独立只读回退）。 |
| [assistant-web-owner](assistant-web-owner) | `@dsh-ray/assistant-web-owner` | 实验性 | 原生 Web 的固定 owner、可信文本回合与 Session 生命周期接入。 |
| [lark-channel](lark-channel) | `@dsh-ray/lark-channel` | 实验性 | 飞书/Lark 长连接薄适配器：持久化后应答、`Get`/`DONE` 状态、脱敏执行进度、模型/审批卡片、安全 onboarding、R4 自然语言整体开启/关闭/升级与恢复控制、`/version` 与自然语言只读版本及自迭代演进统计查询，以及 launchd/systemd/Windows Task 常驻。 |
| [owner-console](owner-console) | `@dsh-ray/owner-console` | 实验性（`web`/`supervised` 包含） | 统一「文鳐」控制台与 DSH 原生左栏 Settings UI（`settings.section` / `general` / `models` / `plugins.bundle.config`）：飞书接入、TraeX / Antigravity `agy` 启用切换、R4 整体助手启停升级与恢复、`ownerConsole/versionInfo` / `owner_console_version_info` 只读版本与自迭代演进统计查询，以及 Dreaming/Proactive/WorkItems/Learning/Growth 只读状态与受控操作。 |
| [assistant-heartbeat](assistant-heartbeat) | `@dsh-ray/assistant-heartbeat` | 实验性 | 复用 Automations 的 active-hours 主动巡检、scratch CAS、busy coalescing 与成本硬界限。 |
| [event-triggers](event-triggers) | `@dsh-ray/event-triggers` | 实验性 | 持久化 file、HTTPS/JSON、GitHub 仓库状态、滚动时间窗飞书日历、内置 `webhookListen` HTTP 监听、`task-system`、非飞书日历（`ics`/`json-events`）与邮件（`rest-json`/`jmap`）事件；默认开启 `pollerEnabled`，支持有限 owner 授权观察、opt-in intake 桥接与目标终态无轮询退订。 |
| [assistant-proactive](assistant-proactive) | `@dsh-ray/assistant-proactive` | 实验性（`web`/`supervised`/`autonomy` 场景包含） | 已授权目标事件的收益筛选、静默记录、合并、冷却和持久预算；默认开启 `intakeEvaluation` 与 WP12 四因子动态效用/打扰成本计算（`computeDynamicUtility`），含主人注意力提问，实际执行仍经 Goals 验收。 |
| [assistant-work-items](assistant-work-items) | `@dsh-ray/assistant-work-items` | 实验性 | 默认开启 `enabled`、`intakeLedger` 与 `intakeLedger.evaluation`；支持 WP21 SQLite AEAD 密封跨重启准入持久化、WP22 `assistant-evaluation` 自动 `observe → auto` 与动态准入规则采用，以及持久认领/汇报、有界 resume、诊断与结果反馈。 |

## 技能与持续成长

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [assistant-skills](assistant-skills) | `@dsh-ray/assistant-skills` | 实验性 | 独立验收任务的私有版本化工具技能、原生发现与新目标复用；支持 WP13 5 类高频真实工作流族（`repo-ci-fix`/`calendar-meeting-prep`/`email-inbox-triage`/`wiki-knowledge-synthesis`/`dependency-config-audit`）、多前置条件与通用补偿计划。 |
| [assistant-evolution](assistant-evolution) | `@dsh-ray/assistant-evolution` | 实验性 | 审批门控的行为自演化：按证据提出 guidance，经 owner 批准后注入；默认开启 `autonomousRollback` 对 Host 证明已退化的 exact rule 自动回滚，不能自我采用、扩权或原地改写。 |
| [assistant-growth-experiments](assistant-growth-experiments) | `@dsh-ray/assistant-growth-experiments` | 实验性（supervised 场景包含） | 审批后的工作流 replay/shadow/单次 canary、晋升与撤回；已接入真实 Automations 服务及组合测试。core/lark 不默认安装，阶段通过不单独证明能力相对基线改善。 |
| [assistant-growth-driver](assistant-growth-driver) | `@dsh-ray/assistant-growth-driver` | 实验性（`supervised` 场景包含） | 默认开启 `enabled`、`workflowOwnerAnchored`、`pluginSourceProposals`（含 `allowCreation`/`allowModification`/`allowRevision`）、`dreamingIdeas`、`associationCandidates` 与 `usageLearning.workItemFailures`（缺少宿主外部资源时自动安全休眠待命）：按真实前台 owner 任务反馈创建持久成长作业并消费已验证 dreaming idea；复用原生调度并冻结实际模型与预算，长期真实使用收益待发布后 D 类纵向观测。 |
| [assistant-dreaming](assistant-dreaming) | `@dsh-ray/assistant-dreaming` | 实验性（`--with dreaming` / `--dreaming` 选装，条件式默认启用） | 条件式默认启用的“做梦”插件：缺少 6 项必填前提时安全休眠（`enabled: false`），前提齐备且未显式禁用/退役时默认激活；采用确定性 HMAC 召回抽签+空闲/冷启动门，单工具冻结 Agent 只记录私有 idea（L0），通过可选 peer 接入外部插件，无自动采用/自评。 |

## 安全、治理与运维

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [credentials-keychain](credentials-keychain) | `@dsh-ray/credentials-keychain` | 实验性 | macOS Keychain/Linux Secret Service/Windows DPAPI/单变量 provider、policy gate、TTL/撤销和 secret-free lease 审计。 |
| [memory-wiki-bridge](memory-wiki-bridge) | `@dsh-ray/memory-wiki-bridge` | 实验性 | 只通过公开 service 生成带稳定 provenance 的 Memory↔Wiki 审批提案。 |
| [assistant-health](assistant-health) | `@dsh-ray/assistant-health` | 实验性 | 聚合 provider 自有 health seam 的脱敏 liveness/readiness/详细报告。 |
| [assistant-recovery](assistant-recovery) | `@dsh-ray/assistant-recovery` | 实验性 | 无模型、固定 catalog、带幂等步骤账本的 `supervised-growth/v2` Host 恢复控制面，并提供 WP10 不可逆外部副作用通用补偿注册表与执行器（`CompensationRegistry` / `executeCompensation`）。 |
| [assistant-isolation](assistant-isolation) | `@dsh-ray/assistant-isolation` | 实验性 | 有限 owner 授权的跨平台离线隔离执行（`auto` / `linux-native` / `macos-seatbelt` / `windows-job`）、持久恢复、私有审计与外部撤销；无 Docker 依赖，Linux 原生新装、cgroup v1/v2 委派及 pre-owner 维护已接通，限制见[运行时指南](../docs/dockerless-runtime.md)。 |
| [assistant-actions](assistant-actions) | `@dsh-ray/assistant-actions` | 实验性 | 有限 owner 授权的外部动作代理；广义 v2 broker 覆盖 `github`、`http`、`lark`、`calendar`、`shell` 与跨平台 peer/pipe 鉴权（Linux `SO_PEERCRED` / macOS `LOCAL_PEERCRED` / Windows 命名管道）及 WP08 策略/敏感度与 query 固定约束；外部凭据与权威账本由独立 broker 持有。 |
| [plugin-control-plane](plugin-control-plane) | `@dsh-ray/plugin-control-plane` | 实验性 | 按能力发现、owner 审批、隔离验证与原子启用 bundle；支持 `'tool' | 'service' | 'channel' | 'ui'` 多类候选插件创建/修订与验收，并将 `inProcessReload` 自动接入 `AdoptionCoordinatorRuntime`（含失败回退兜底）；修改、修订与源码发布各有独立授权和验收门。 |

## 示例与开发

| 插件 | 包 | 状态 | 说明 |
|---|---|---|---|
| [hello](hello) | `@dsh-ray/hello` | 示例 | 最小可安装 bundle，用于验证仓库契约和开发链路。 |

<!-- plugin-catalog:end -->

状态建议使用“实验性 / Beta / 稳定 / 已弃用”。新增、重命名、弃用或移除插件时必须同步维护此表。
