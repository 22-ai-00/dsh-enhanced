# DSH 个人助理插件生态研究与建设清单

> 事实截点：**2026-08-20（Asia/Shanghai）**
> 研究对象：GitHub `dsh-plugin` topic、`awesome-dsh-plugin`、DeepSeek Harness 官方仓库、本仓库，以及 OpenClaw / Hermes Agent 官方仓库与文档。
> 结论性质：源码与发布材料审查，不等同于安全审计；未使用真实飞书、Telegram、浏览器账号或云端记忆凭据做端到端验收。
> 当前仓库已升级到 DSH `0.1.2-rc.1`。下文第三方插件版本、源码链接和实测结论仍是事实截点时针对 rc.8 的历史快照；peer range 即使语法上覆盖 rc.1，也必须重新做隔离 profile smoke 才能称为当前兼容。

## 一页结论

1. GitHub topic 不是插件商店。检索日页面显示约 **8,865** 个仓库，但首屏已混入通用记忆框架、skills 集合和与 DSH 无关的项目。只有同时存在 `package.json#dsh.bundle.patch`、可解析的 `cordis.patch.yml`、实际 Host 源码和可安装产物，才应称为 DSH 插件。
2. [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/588e49808284c589073ef2eefdf9260c2913a9dc/README.md) 在本次快照共有 **1,691 条插件行**（README 有 1,694 个 Markdown 列表项，其中 3 个是目录链接），质量高于 topic 搜索；但其[收录规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/588e49808284c589073ef2eefdf9260c2913a9dc/contributing.md)明确是结构与维护活跃度的人工检查，不是运行兼容、安全或生产质量认证。
3. 当前 DSH `0.1.2-rc.1` 已经提供会话持久化、skills、目标/计划、subagent、workflow、后台 jobs、工具审批、sandbox、Web/Search 等大部分“智能体骨架”。不要重复开发这些基础件。
4. 真正阻挡“OpenClaw / Hermes 式个人助理”的 P0 缺口是：**正式长期记忆接口与默认实现、会话关闭后仍可执行的持久调度、统一消息网关、后台任务的权限/预算/审计与插件隔离**。
5. 事实截点时建议的个人落地候选是：DSH rc.8 + 本仓库模型桥接（可选）+ `dsh-memento` + `dsh-routines` + `dsh-lark-channel`（或小型 Telegram 插件）+ 官方 MCP client overlay + `dsh-pilot`（按需）+ 内置 sandbox/approval + `dsh-taintguard`（纵深防御）。迁移到当前 `0.1.2-rc.1` 前必须逐个重验第三方插件。
6. “达到 Claude 级智能”不是多装记忆插件就能得到。上限主要来自基础模型、上下文组织、工具可靠性、任务分解/复核和评测闭环；记忆与主动性主要改善连续性和执行覆盖，不能把弱模型直接变成强模型。

## 研究方法与真实性门槛

本报告优先采用一手证据：固定 commit 的 README、`package.json`、`cordis.patch.yml`、源码、测试和官方文档。GitHub stars、topic 和作者自述只作辅助信号。

### 判定口径

| 等级 | 判定要求 | 本报告如何表述 |
| --- | --- | --- |
| 结构可安装 | 有 `dsh.bundle.patch`，patch 实际 mount 包名，并有 Host 入口/可发布文件 | “可安装” |
| 有可用证据 | 在上项基础上，有源码、测试脚本/CI、版本发布、清晰的权限和失败语义 | “可试用 / 候选” |
| 快照兼容 | peer range 覆盖 rc.8，或刻意使用结构类型且源码没有明显依赖旧接口 | “rc.8 可试”；不自动外推到当前 rc.1 |
| 生产可用 | 还需真实账号 E2E、升级/故障恢复、秘密管理、攻击面与负载验证 | 本次审查**不授予任何社区插件此结论** |

特别注意：DSH 官方 README 仍把项目标为 **developer preview**，预览期允许破坏性变更；“peer range 能解析”也不等于运行期行为完全兼容。证据见[官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/README.md)和本仓库[兼容性约定](./compatibility.md)。

## 社区到底有多少“真的插件”

### `dsh-plugin` topic：只能用于发现

- 检索日 topic 页面显示约 8,865 个 public repositories。
- 列表同时出现 DSH 本体、通用 Agent Memory 项目、skills 仓库和未提供 DSH bundle 的项目；打标签不要求经过 DSH 官方审核。
- 因此不能写成“社区已有 8,865 个可用插件”，更不能按 topic 直接自动安装。

### `awesome-dsh-plugin`：结构性候选目录

固定快照共 1,691 条插件行，分类分布如下：

| 类别 | 数量 | 类别 | 数量 | 类别 | 数量 |
| --- | ---: | --- | ---: | --- | ---: |
| UI | 248 | Tools | 213 | Development | 139 |
| Sessions | 107 | Workflow | 104 | Usage | 99 |
| Memory | 89 | Notifications | 86 | Themes | 69 |
| Vision | 67 | Skills | 67 | Security | 66 |
| Fun | 68 | Marketplace | 52 | Model | 50 |
| Git | 43 | Browser | 36 | Remote | 35 |
| Voice | 27 | Docs | 26 | 合计 | **1,691** |

其收录规则要求真实代码、`dsh.bundle`、至少约一天/十次提交、近期活跃和人工 sanity check，也明确没有做安全审计与质量排名。因此，本报告没有假装逐个运行 1,691 个包，而是按个人助理关键链路抽查高相关候选。

## 当前 DSH `0.1.2-rc.1` 已经具备什么

官方 base bundle 的[组合配置](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/bundle/base/cordis.patch.yml)已覆盖：

| 能力层 | 已有能力 | 边界 |
| --- | --- | --- |
| Agent loop | 模型调用、工具循环、重试、超时、重复提醒、compaction | 仍是 developer preview |
| 持久会话 | JSONL session、恢复、查询后端 | base 中全文检索未默认打开；会话历史不等于长期人格记忆 |
| 任务组织 | goal、plan、todo、Ralph、subagent、workflow worker | 需要上层策略决定何时分派、何时复核 |
| 后台工作 | jobs registry、完成通知、可唤醒 idle owner | 通知主要是进程内；退休窗口、连续 wake 上限和预算继承都有边界，见[tool-jobs README](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/jobs/tool-jobs/README.md) |
| 能力扩展 | skill registry/filesystem、DeepSeek Search、Web、shell/filesystem | Web fetch 并非所有 profile 默认打开；联网内容仍是不可信输入 |
| 安全 | permission preset、approval waterfall、sandbox | 主要约束模型工具；原生 Cordis 插件仍与 DSH 进程同权限 |

两个容易漏掉、但不必重新发明的官方可选件：

- [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/mcp/mcp-client/README.md)：支持 stdio / Streamable HTTP MCP 和重连，但未挂入 base；当前主要注册 tools，不消费 MCP resources/prompts。
- [`@deepseek-ai/dsh-schedule`](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/subsystems/schedule.md)：支持 `after`、绝对时间和不小于 5 分钟的 fixed-rate 重复计划，事件持久化；但 `deliveryMode` 只有 `session-local`，原会话必须活着。冷会话只在重新打开后补跑，没有 cron 表达式、独立外部投递和真正冷启动执行。

## 本仓库已经具备什么

本仓库的[插件目录](../plugins/README.md)有四个独立 bundle，均有 patch、README、LICENSE、测试和发布边界，但都仍标为 experimental：

| 插件 | 对个人助理的价值 | 结论 |
| --- | --- | --- |
| [`@dsh-enhanced/acp`](../plugins/acp/README.md) | 把 DSH 暴露成 ACP stdio agent，支持 preset/model/effort、权限事件和 session reuse | 适合接入编辑器/ACP 客户端；不是 Telegram/飞书等常驻消息网关 |
| [`@dsh-enhanced/coding-subscription-provider`](../plugins/coding-subscription-provider/README.md) | 把本机 Codex、Claude Code、Cursor、Grok 登录态桥接为 DSH LLM route | 可提高模型上限/降低重复订阅；Codex 最稳，Claude 有合规提示，Cursor/Grok 为 beta；它把整段 DSH 对话封成一次外部 coding-agent 调用，不等同于原生完整 agent 语义 |
| [`@dsh-enhanced/traex-acp-provider`](../plugins/traex-acp-provider/README.md) | 通过 ACP 把 TraeX 作为模型 provider | 只建议只读/受控工具；每次新进程/会话，没有原生 session resume 与完整 UI/plan 事件 |
| hello | 模板与冒烟示例 | 不提供个人助理业务能力 |

这意味着本仓库已经能解决“用更强 coding model”和“从 ACP 客户端访问”的一部分问题，尚未拥有记忆、冷调度或 IM gateway。

## 与 OpenClaw / Hermes 的能力差距

OpenClaw 的官方架构是“单操作者 Gateway + 多消息渠道 + tools/skills + 记忆 + cron/heartbeat + 浏览器/设备节点”。其[记忆文档](https://github.com/openclaw/openclaw/blob/71cff695c1fe182d8acda7bd5739a7f38ff467c9/docs/concepts/memory.md)把长期信息落到 Markdown，提供语义/混合检索、compaction 前 memory flush 和定时 dreaming；[sandbox 文档](https://github.com/openclaw/openclaw/blob/71cff695c1fe182d8acda7bd5739a7f38ff467c9/docs/gateway/sandboxing.md)也明确 sandbox 默认关闭且不包住 gateway/plugin 本身。

Hermes 官方 README/文档展示了多平台 gateway、双文件长期记忆、FTS5 session search、后台记忆/skill review、cron 跨平台投递、隔离 subagent 和多个终端 backend。证据见[官方仓库](https://github.com/NousResearch/hermes-agent)、[Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)、[Messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)和[Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)。

| 能力 | DSH `0.1.2-rc.1` | OpenClaw / Hermes 基准 | 缺口判断 |
| --- | --- | --- | --- |
| 会话内工具智能体 | 强 | 强 | 已具备 |
| skills / subagent / workflow | 已有 | 已有 | 已具备，主要缺调优与评测 |
| 长期人格/事实记忆 | 无正式 memory seam/default provider | profile + episodic + search + consolidation | **P0** |
| 精确/重复调度 | schedule 仅 live session；社区可补 | fresh session cron、历史、跨渠道投递 | **P0** |
| 条件触发/heartbeat | jobs 能唤醒；无通用持久 watcher | heartbeat、webhook/event trigger | P1，社区已有候选 |
| 多消息渠道 Gateway | 无统一一方实现 | 常驻 gateway、多渠道、身份绑定 | **P0** |
| Browser / computer use | 社区实现 | 一方集成且有安全边界 | P1 |
| 语音/移动/设备节点 | 很薄 | 语音、移动 companion、设备能力 | P2 |
| 插件隔离/供应链 | Cordis 插件进程内执行 | 两者也仍有 native plugin 信任边界 | **共同高风险，DSH 应 P0 加固** |

## 候选插件分档清单

### A. 推荐进入个人试运行组合

“推荐”表示源码/安装结构/测试证据相对完整，仍要 pin 版本并在隔离 profile 中验收。

| 领域 | 插件与快照 | 兼容、测试/CI 证据 | 权限与边界 | 建议 |
| --- | --- | --- | --- | --- |
| 安全型长期记忆 | [`dsh-memento` 0.4.2](https://github.com/PerryLink/dsh-memento/tree/ff92ee95b543384bfd686d7a9f06a99bdf707084) | bundle 完整；peer `>=0.1.0-rc.6` 覆盖当时验证的 rc.8，但按标准 semver 不接受当前 `0.1.2-rc.1`；需先更新 peer 并重新验证；有 CI/compat/release workflows、约 22 个测试文件 | 本地 `node:sqlite`，零网络/凭据；默认写入需 approval，审计和有界 scope；没有向量语义检索 | **首选个人记忆候选**。安全、可解释优先；上线前做 rc.1 smoke，且不要与另一记忆插件并装 |
| 冷调度 | [`@dsh-routines/bundle` 0.1.0](https://github.com/Jesse-njx/dsh-routines/tree/f59b4f03e7b36648b804fd07e57a53e276da5d81) | `^0.1.0-rc.6` ranges；有 build/typecheck、6 个测试文件，README 声明 46 项测试和 CI workflow | DSH 进程必须常驻；每次 fresh one-shot session；自动把需交互审批的动作拒绝，run JSON/MD 留审计；错过多次只补一次 | **首选主动任务**。先 file delivery，再接消息通道；用 launchd/systemd 保活 |
| 飞书/Lark Gateway | [`dsh-lark-channel` 0.0.7](https://github.com/omdsh-dev/dsh-lark/tree/632807d9abafbb866a5e208a0298eff21c7856d1) | README 要求 DSH rc.6+；24 个测试文件、typecheck/build、CI/publish workflows；WebSocket 有配额与退避 | App secret、IM、文件、工作区高权限；有 sender/group/approver allowlist、workspaceRoots、群文件出站强审批、用户服务保活 | **国内首选通道**。新项目，先只开本人 DM、单 workspace、最小权限 |
| 浏览器 | [`dsh-pilot` 0.1.1](https://github.com/Viger1/dsh-pilot/tree/65340d67a4de840205b9e8d00debed3180e87ad8) | bundle、build、6 个测试文件、GitHub workflow；peer 用 `*`，能安装但版本约束过松 | Playwright/Chrome 高权限；origin 在网络层拦截，未知站点跟随 DSH approval，无审批渠道 fail closed，密码字段默认拒绝 | **按需安装**。优于只在 tool entry 检查 URL；持久浏览器 profile 默认不要开 |
| Prompt-injection 纵深防御 | [`dsh-taintguard` 0.1.0](https://github.com/sashankh/dsh-taintguard/tree/421e6726d9d0865e36fbe00a12a263409390dc11) | peer `^0.1.0-rc.6` 覆盖当时验证的 rc.8，但按标准 semver 不接受当前 `0.1.2-rc.1`；需先更新 peer 并重新验证；typecheck/test/CI，有 AgentDojo eval | 不读文件、不联网、不落盘；按来源 sticky taint 后 gate 高危工具。官方 eval 同时承认 97.6% consequential calls 被 gate，误拦很粗 | 只作 sandbox/最小权限之后的**纵深防御**；无人值守明确设 deny，不要宣传成完备防注入 |

### B. 备选：适合特定目标，先做小范围验证

| 领域 | 候选 | 优点 | 为什么不是默认推荐 |
| --- | --- | --- | --- |
| 成熟后端记忆 | [`@vectorize-io/hindsight-coding-agents` 0.4.1](https://github.com/vectorize-io/hindsight/tree/68df690843954089cef49fd2467e3f9e3125ab0d/hindsight-integrations/coding-agents) | 真正的 DSH bundle；native lifecycle recall/write-back；成熟 Hindsight 后端，可 cloud/self-host/local，测试含 DSH 单测/E2E gate | 当前集成定位“每代码仓库记忆”，不天然等于跨生活域的个人画像；需要网络/服务端和数据驻留决策 |
| 团队/知识图谱记忆 | [`@co-engram/dsh` 0.1.1](https://github.com/Co-Engram/Co-Engram/tree/ade3df6b147f8782fa9359c1dc3e566d66fc0262/packages/dsh-plugin) | monorepo 有大量测试；git-backed engrams/synapses、去重、衰减、审计、viewer、跨 Claude/OpenClaw/DSH 共享 | DSH 包把 rc.6 tools 放 dependency 而非 peer；默认可起 viewer/maintenance，并可 spawn `claude` 做 night thinking；38 个工具、磁盘/git/子进程权限面大 |
| 条件触发 | [`dsh-sentinel` 0.11.0](https://github.com/fuhefei/dsh-sentinel/tree/833a4e95d00f3fe9777df2cf8f3db7edf62852c1) | sidecar JSONL、lease owner、at-least-once in-harness wake、重启恢复；文件/HTTP/process/webhook watchers；test/typecheck | 必须有 resident `dsh web`；watch 可触达文件、进程、HTTP 和外部 notify webhook；webhook notify 失败不重试 | 在 routine 稳定后增加，适合 CI 完成/文件变化/接口状态，而非首发必需 |
| 会话 heartbeat | [`dsh-plugin-heartbeat` 0.4.0](https://github.com/LittleBlackTong/dsh-plugin-heartbeat/tree/d470c35476f7b33f0778f9a32dd944349aae5b7e) | 定时 `agent.followup()`、忙时合并、退避、3 次无回复硬停、可先 compaction；有单测 | 仅进程与 agent 活着时存在，不持久；默认是进展汇报而非新工作；会产生额外模型成本 | 适合“陪伴/汇报感”，不是可靠 cron；必须设频率、小时上限和 hard stop |
| Telegram 最小桥 | [`@loserfox/telegram` 0.1.0](https://github.com/LoserFox/telegram/tree/a0a9ca11e427b62217250e2e561f6ad3c49d13f2) | 小而清晰、per-chat session、白名单默认拒绝、token 脱敏 | 无测试脚本；仅文本/私聊/long polling；投递失败无重试/账本；部分 peer 仍是早期 rc.1 | 个人 DM 可快速试，不适合承担关键提醒投递保证 |
| 共享可见浏览器 | [`dsh-builtin-browser` 0.1.15](https://github.com/wqty123/dsh-browser/tree/9ffe5d6c0d782f3c489d342943fee56d22d6d283) | 20 个工具、Electron 可见窗口、人可接管、cookie/下载/历史、动作白名单 | 无测试脚本；Electron 与 cookie/页面 JS/下载权限很高；peer 从 rc.1；动作白名单不是站点/数据流安全边界 | 必须要“同屏接管”才选；通常优先 dsh-pilot 的 origin fence |

### C. 暂缓：结构可能可装，但当前证据或风险不适合主助理

| 插件 | 暂缓原因 |
| --- | --- |
| [`@a9i5k4/dsh-auto-memory` 0.1.28](https://github.com/Aik358/dsh-auto-memory/tree/72660743af23adef4e2b4a060e7a240d30b2b9d8) | 四天发布 28 个版本；主要交付编译产物，常规源码/测试证据弱；每轮 subagent 整理、日记/反思/日历/问候很全，但同时读写文件、联网、执行子进程并可自更新包。其“主动提醒”主要是进程/页面或下次会话，不证明冷启动可靠投递。适合参考设计，不适合先托管个人数据。 |
| [`dsh-hermes-memory` 1.0.0](https://github.com/isheng-eqi/dsh-hermes-memory/tree/8d32188753774817203e1a4867a83030f6a5db28) | 接近 Hermes 的 MEMORY/USER 双 bank 和 frozen snapshot，但只有编译 JS、无测试脚本，README 对“一项/五项工具”表述矛盾；源码使用 storage 却未声明 inject。且缺 Hermes 官方现有的注入扫描、后台 review、approval、session search 和外部 provider。 |
| [`@openviking/dsh-memory-plugin` 0.1.0](https://github.com/volcengine/OpenViking/tree/2c205d8a7a9256457b582639795adf043b0ecc41/examples/dsh-memory-plugin) | 这是 OpenViking 官方仓库中的高质量 installable example，有多项测试、pending replay、URI guard 和可选 live E2E；但 peer **精确锁定 rc.6**，README 明确要求 exact rc.6，与当前 `0.1.2-rc.1` 不兼容。先升级适配再评估。 |
| [`dsh-permission-rules` 0.5.2](https://github.com/PerryLink/dsh-permission-rules/tree/369f146d4a73935005442d1b9350c421111ada04) | 功能、测试、审计和 network policy 很有价值，但所有关键 DSH peers 精确锁 `0.1.0-rc.7`；当前 `0.1.2-rc.1` 应先更新。它也明确不是 OS sandbox。 |
| [`messaging-core`](https://github.com/534119219/dsh-messaging/tree/f1c3399ef40e3f419161d153e997d6f30576a627) | 一包声称 27 渠道，有 bundle 与大量 adapter 代码，但仓库主要是编译 `lib/`、无测试，安装流程仍偏手工 file dependency；配置向导还明确提示 secret 输入不隐藏。广度远超可核验深度。 |
| [`dsh-im-channel` 0.2.1](https://github.com/shrekcg/dsh-im-channel/tree/fb64263341fba403a051b3c3fa9875933c425f8c) | 有源码/测试/CI，诚实标注仅飞书/Telegram 较完整；但架构包含独立 bridge、子进程调用 headless profile、额外 session package 与 40 个飞书工具，安装/权限/故障面明显大于 `dsh-lark-channel`。 |

## 推荐组合

### 最小可用个人助理（先跑通闭环）

1. **DSH `0.1.2-rc.1` base**：使用现成 session、skill、plan、subagent、jobs、sandbox/approval。
2. **模型**：先用官方 provider；如果确实拥有对应订阅，再选本仓库 `coding-subscription-provider` 的 Codex route。不要同时启多个未验证 beta route。
3. **记忆**：只装 `dsh-memento`，默认 `writePolicy=ask`；导入少量稳定偏好，不自动吞整个历史。
4. **通道**：国内首选 `dsh-lark-channel`，只允许本人 DM、一个 workspaceRoot、最小飞书 scopes；境外简单场景可先用最小 Telegram bridge。
5. **主动性**：`dsh-routines` 常驻，先做“每日摘要写文件 + 发到同一通道”一个 routine；所有 unattended approval 自动拒绝。
6. **外部能力**：按需挂官方 MCP client，只接日历/任务/只读文档；写邮件、发消息、支付、删除必须显式审批。
7. **安全**：内置 sandbox + approval 是主边界；`dsh-taintguard` 只作附加层。固定 package version/commit，独立系统用户运行，备份 `$DSH_HOME` 和 memory DB。

这个组合已经能实现：跨会话记住偏好、在 IM 中持续对话、按日主动运行任务、使用文件/Web/MCP、必要时分派 subagent；但它还不是“手机离线也保证准时送达”的产品级服务。

### 进阶组合（验证最小版稳定后）

- 增加 `dsh-sentinel`：监控 CI、长任务、目录或 API 状态，触发 dormant session followup。
- 增加 `dsh-pilot`：让助理处理需要登录/表单的网页；独立浏览器 profile，不复用主浏览器 cookie。
- 记忆如果以代码项目为中心，可从 memento **迁移**到 Hindsight；团队共享/图谱学习再评估 Co-Engram。不要并装三个记忆写入器。
- 增加 reviewer/eval 工作流：重要输出由另一模型/agent 复核，而不是让同一模型自评。
- 通道进程、scheduler 和记忆服务分别做健康检查、备份恢复和支出告警。

## 建议开发 backlog

### P0：没有这些，就还不是可靠个人助理

| 项目 | 交付定义 |
| --- | --- |
| 官方 `ctx.memory` seam + 安全默认 provider | profile/semantic/episodic 三层；来源、时间、置信度、scope、TTL；写入 approval；检索预算；冲突/删除/导出；compaction flush；迁移与备份。让 memento/Hindsight/OpenViking 都能实现同一契约 |
| 冷启动持久 scheduler | 独立于 live session；cron/timezone/one-shot；fresh session；missed-run 策略、幂等键、并发/重试/取消、run history；模型/权限快照；投递 outbox；系统服务部署模板 |
| 统一 channel gateway seam | inbound identity/pairing/allowlist、chat↔session mapping、附件、streaming、approval cards、delivery receipt/retry/dedup/outbox；先实现 Lark + Telegram，不追求首版 27 渠道 |
| 后台权限与成本控制 | foreground/background 分离 policy；tool/category/origin/recipient allow-deny-ask；时间/Token/金额/网络 egress budget；秘密只在执行器解析；完整审计与 emergency stop |
| 插件供应链与隔离 | manifest 声明 fs/network/subprocess/credential/browser/install-script authority；安装前 diff；lockfile/hash/signature；高风险插件 child process/container；明确“sandbox 不保护 Host plugin” |

### P1：从能用变成好用

| 项目 | 交付定义 |
| --- | --- |
| 事件触发总线 | file/process/HTTP/webhook/calendar/mail/queue adapters，持久 cursor、debounce、cooldown、fire budget、at-least-once + dedup；可吸收 sentinel 的成熟语义 |
| 记忆 consolidation/dreaming | 后台提炼、去重、矛盾检测、遗忘/衰减、人工 review inbox、可回滚；必须经过 prompt-injection 扫描和来源信任分层 |
| Session search | SQLite FTS/混合检索默认可配，引用回原消息，不把完整历史无界塞入 prompt |
| Browser/computer-use 标准 seam | origin/network fence、下载/上传策略、credential broker、可视接管、动作录像/回放；browser provider 可替换 |
| 可观测与恢复 | scheduler/channel/memory health、队列积压、token/费用、失败率；崩溃恢复、备份验证、升级兼容矩阵和 canary profile |
| 模型路由与评测 | 按任务风险/复杂度选模型；planner/executor/reviewer；真实个人任务集、工具成功率、记忆准确率、主动提醒准点率、安全回归集 |

### P2：接近 OpenClaw/Hermes 的完整产品形态

- 语音输入/转写/合成、移动 companion、设备节点和位置/相机等显式授权能力。
- 自主创建/改进 skill，但必须 proposal → tests/eval → 人审 → 版本化启用 → 自动回滚，禁止无审查自修改生产 skill。
- 多人/多租户身份与记忆隔离、跨设备同步和端到端数据驻留策略。
- GUI onboarding、权限体检、插件权限 diff、灾备导入导出与一键停机。

## 关键风险与实施原则

1. **不要并装同类核心插件。** 两个 memory writer 会重复注入/写入、污染召回；两个 gateway 会争抢 session mapping；两个 scheduler 会重复执行。
2. **Host 插件就是本机代码。** 它可以绕过模型工具 sandbox 直接读文件、联网、spawn；README 写“安全”不是隔离证据。
3. **主动性放大权限。** 同一个 `bash`，用户盯着时和凌晨无人值守时不是同一风险等级。后台 profile 应默认 deny，单独列白名单和预算。
4. **记忆是数据供应链。** 网页、邮件和群消息可把 prompt injection 固化成长期记忆；必须保存来源并把外部内容当不可信引用，而非系统指令。
5. **版本固定。** DSH 还在 rc；每次升级当前 `0.1.2-rc.1` 基线都应在 canary profile 回放 memory、schedule、channel、approval 和 recovery 测试。
6. **能力不等于智能。** 优先提升高质量模型路由、工具正确率和评测闭环；不要用无限 heartbeat、自改 skill 或大规模自动记忆制造“很主动”的假象。

## 建议的验收门槛

在把组合称为“个人助理”之前，至少通过以下场景：

- 重启 DSH 后准确恢复聊天映射、长期偏好和未完成的 schedule；重复重启不重复发消息。
- 电脑睡眠跨过三个触发点后，按配置只补跑一次或逐条补跑，且审计清楚。
- 恶意网页/邮件要求上传密钥时，browser → memory → scheduler → channel 全链路仍阻止外发。
- 非 allowlist 用户、转发 approval card、伪造 webhook、DNS rebinding、重复平台 event 都不能触发动作。
- token 失效、网络断开、模型 429、消息平台 5xx、磁盘满、DB 损坏时有 bounded retry、dead letter 和告警。
- 可导出/删除某条记忆并证明不再召回；可恢复备份；可查看每条主动动作的模型、prompt、工具、权限决定、费用与投递结果。

## 来源索引

- DSH 官方：[repository](https://github.com/deepseek-ai/deepseek-harness/tree/141eb6fef83422698aef7a981029e843e8161534)、[base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/bundle/base/cordis.patch.yml)、[schedule](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/subsystems/schedule.md)、[MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/mcp/mcp-client/README.md)。
- 社区入口：[GitHub topic](https://github.com/topics/dsh-plugin)、[`awesome-dsh-plugin` 固定快照](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/tree/588e49808284c589073ef2eefdf9260c2913a9dc)。
- 对标：[OpenClaw 固定快照](https://github.com/openclaw/openclaw/tree/71cff695c1fe182d8acda7bd5739a7f38ff467c9)、[Hermes Agent](https://github.com/NousResearch/hermes-agent)及其官方文档。
- 社区候选的固定 commit 链接已逐项放在清单表中；版本、peer、scripts 和 bundle 判断来自相应 commit 的 `package.json`、`cordis.patch.yml`、README、源码与测试目录。
