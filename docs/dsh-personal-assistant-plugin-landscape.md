# DSH 个人助理插件生态：历史研究

> 事实截点：**2026-08-20（Asia/Shanghai）**
> 研究对象：GitHub `dsh-plugin` topic、`awesome-dsh-plugin`、DeepSeek Harness 官方仓库、本仓库，以及 OpenClaw / Hermes Agent 官方仓库与文档。
> 结论性质：源码与发布材料审查，不等同于安全审计；未使用真实飞书、Telegram、浏览器账号或云端记忆凭据做端到端验收。
> 以下第三方比较及 rc.8/rc.1 迁移讨论均为历史研究，不是当前缺口、安装建议或兼容性结论。当前版本见[兼容性基线](compatibility.md)，能力和验收见[插件目录](../plugins/README.md)与 [RSI 当前状态](rsi-status.md)。

## 一页结论

1. GitHub topic 不是插件商店。检索日页面显示约 **8,865** 个仓库，但首屏已混入通用记忆框架、skills 集合和与 DSH 无关的项目。只有同时存在 `package.json#dsh.bundle.patch`、可解析的 `cordis.patch.yml`、实际 Host 源码和可安装产物，才应称为 DSH 插件。
2. [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/588e49808284c589073ef2eefdf9260c2913a9dc/README.md) 在本次快照共有 **1,691 条插件行**（README 有 1,694 个 Markdown 列表项，其中 3 个是目录链接），质量高于 topic 搜索；但其[收录规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/588e49808284c589073ef2eefdf9260c2913a9dc/contributing.md)明确是结构与维护活跃度的人工检查，不是运行兼容、安全或生产质量认证。
3. 研究所述 DSH `0.1.2-rc.1` 已经提供会话持久化、skills、目标/计划、subagent、workflow、后台 jobs、工具审批、sandbox、Web/Search 等大部分“智能体骨架”。不要重复开发这些基础件。
4. 当时列出的“OpenClaw / Hermes 式个人助理”建设需求是：**正式长期记忆接口与默认实现、会话关闭后仍可执行的持久调度、统一消息网关、后台任务的权限/预算/审计与插件隔离**。
5. 第三方插件的版本与兼容判断仅对应下表固定快照；本项目当前安装入口和验收目标见文末。模型供应变化不能替代工具可靠性、任务复核和新任务复用的评测。

## 研究方法与真实性门槛

本报告优先采用一手证据：固定 commit 的 README、`package.json`、`cordis.patch.yml`、源码、测试和官方文档。GitHub stars、topic 和作者自述只作辅助信号。

### 判定口径

| 等级 | 判定要求 | 本报告如何表述 |
| --- | --- | --- |
| 结构可安装 | 有 `dsh.bundle.patch`，patch 实际 mount 包名，并有 Host 入口/可发布文件 | “可安装” |
| 有可用证据 | 在上项基础上，有源码、测试脚本/CI、版本发布、清晰的权限和失败语义 | “可试用 / 候选” |
| 快照兼容 | peer range 覆盖 rc.8，或刻意使用结构类型且源码没有明显依赖旧接口 | “rc.8 可试”；不自动外推到 rc.1 |
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

## 研究所述 DSH `0.1.2-rc.1` 已经具备什么

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

## 本仓库的当前入口

当前 bundle、配置与安装命令见[插件目录](../plugins/README.md)，实现进展和未完成验收统一见 [RSI 当前状态](rsi-status.md)。早期四插件库存与建设流水已移除；下文第三方对比与候选审查均保留为研究截点时的设计依据，不作为当前缺口或安装建议。

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

## 历史候选审查

### A. 当时进入试运行候选的插件

“推荐”表示源码/安装结构/测试证据相对完整，仍要 pin 版本并在隔离 profile 中验收。

| 领域 | 插件与快照 | 兼容、测试/CI 证据 | 权限与边界 | 建议 |
| --- | --- | --- | --- | --- |
| 安全型长期记忆 | [`dsh-memento` 0.4.2](https://github.com/PerryLink/dsh-memento/tree/ff92ee95b543384bfd686d7a9f06a99bdf707084) | bundle 完整；peer `>=0.1.0-rc.6` 覆盖当时验证的 rc.8，但按标准 semver 不接受研究所述 `0.1.2-rc.1`；需先更新 peer 并重新验证；有 CI/compat/release workflows、约 22 个测试文件 | 本地 `node:sqlite`，零网络/凭据；默认写入需 approval，审计和有界 scope；没有向量语义检索 | **首选个人记忆候选**。安全、可解释优先；上线前做 rc.1 smoke，且不要与另一记忆插件并装 |
| 冷调度 | [`@dsh-routines/bundle` 0.1.0](https://github.com/Jesse-njx/dsh-routines/tree/f59b4f03e7b36648b804fd07e57a53e276da5d81) | `^0.1.0-rc.6` ranges；有 build/typecheck、6 个测试文件，README 声明 46 项测试和 CI workflow | DSH 进程必须常驻；每次 fresh one-shot session；自动把需交互审批的动作拒绝，run JSON/MD 留审计；错过多次只补一次 | **首选主动任务**。先 file delivery，再接消息通道；用 launchd/systemd 保活 |
| 飞书/Lark Gateway | [`dsh-lark-channel` 0.0.7](https://github.com/omdsh-dev/dsh-lark/tree/632807d9abafbb866a5e208a0298eff21c7856d1) | README 要求 DSH rc.6+；24 个测试文件、typecheck/build、CI/publish workflows；WebSocket 有配额与退避 | App secret、IM、文件、工作区高权限；有 sender/group/approver allowlist、workspaceRoots、群文件出站强审批、用户服务保活 | **国内首选通道**。新项目，先只开本人 DM、单 workspace、最小权限 |
| 浏览器 | [`dsh-pilot` 0.1.1](https://github.com/Viger1/dsh-pilot/tree/65340d67a4de840205b9e8d00debed3180e87ad8) | bundle、build、6 个测试文件、GitHub workflow；peer 用 `*`，能安装但版本约束过松 | Playwright/Chrome 高权限；origin 在网络层拦截，未知站点跟随 DSH approval，无审批渠道 fail closed，密码字段默认拒绝 | **按需安装**。优于只在 tool entry 检查 URL；持久浏览器 profile 默认不要开 |
| Prompt-injection 纵深防御 | [`dsh-taintguard` 0.1.0](https://github.com/sashankh/dsh-taintguard/tree/421e6726d9d0865e36fbe00a12a263409390dc11) | peer `^0.1.0-rc.6` 覆盖当时验证的 rc.8，但按标准 semver 不接受研究所述 `0.1.2-rc.1`；需先更新 peer 并重新验证；typecheck/test/CI，有 AgentDojo eval | 不读文件、不联网、不落盘；按来源 sticky taint 后 gate 高危工具。官方 eval 同时承认 97.6% consequential calls 被 gate，误拦很粗 | 只作 sandbox/最小权限之后的**纵深防御**；无人值守明确设 deny，不要宣传成完备防注入 |

### B. 当时保留的特定场景备选

| 领域 | 候选 | 优点 | 为什么不是默认推荐 |
| --- | --- | --- | --- |
| 成熟后端记忆 | [`@vectorize-io/hindsight-coding-agents` 0.4.1](https://github.com/vectorize-io/hindsight/tree/68df690843954089cef49fd2467e3f9e3125ab0d/hindsight-integrations/coding-agents) | 真正的 DSH bundle；native lifecycle recall/write-back；成熟 Hindsight 后端，可 cloud/self-host/local，测试含 DSH 单测/E2E gate | 当前集成定位“每代码仓库记忆”，不天然等于跨生活域的个人画像；需要网络/服务端和数据驻留决策 |
| 团队/知识图谱记忆 | [`@co-engram/dsh` 0.1.1](https://github.com/Co-Engram/Co-Engram/tree/ade3df6b147f8782fa9359c1dc3e566d66fc0262/packages/dsh-plugin) | monorepo 有大量测试；git-backed engrams/synapses、去重、衰减、审计、viewer、跨 Claude/OpenClaw/DSH 共享 | DSH 包把 rc.6 tools 放 dependency 而非 peer；默认可起 viewer/maintenance，并可 spawn `claude` 做 night thinking；38 个工具、磁盘/git/子进程权限面大 |
| 条件触发 | [`dsh-sentinel` 0.11.0](https://github.com/fuhefei/dsh-sentinel/tree/833a4e95d00f3fe9777df2cf8f3db7edf62852c1) | sidecar JSONL、lease owner、at-least-once in-harness wake、重启恢复；文件/HTTP/process/webhook watchers；test/typecheck | 必须有 resident `dsh web`；watch 可触达文件、进程、HTTP 和外部 notify webhook；webhook notify 失败不重试 | 在 routine 稳定后增加，适合 CI 完成/文件变化/接口状态，而非首发必需 |
| 会话 heartbeat | [`dsh-plugin-heartbeat` 0.4.0](https://github.com/LittleBlackTong/dsh-plugin-heartbeat/tree/d470c35476f7b33f0778f9a32dd944349aae5b7e) | 定时 `agent.followup()`、忙时合并、退避、3 次无回复硬停、可先 compaction；有单测 | 仅进程与 agent 活着时存在，不持久；默认是进展汇报而非新工作；会产生额外模型成本 | 适合“陪伴/汇报感”，不是可靠 cron；必须设频率、小时上限和 hard stop |
| Telegram 最小桥 | [`@loserfox/telegram` 0.1.0](https://github.com/LoserFox/telegram/tree/a0a9ca11e427b62217250e2e561f6ad3c49d13f2) | 小而清晰、per-chat session、白名单默认拒绝、token 脱敏 | 无测试脚本；仅文本/私聊/long polling；投递失败无重试/账本；部分 peer 仍是早期 rc.1 | 个人 DM 可快速试，不适合承担关键提醒投递保证 |
| 共享可见浏览器 | [`dsh-builtin-browser` 0.1.15](https://github.com/wqty123/dsh-browser/tree/9ffe5d6c0d782f3c489d342943fee56d22d6d283) | 20 个工具、Electron 可见窗口、人可接管、cookie/下载/历史、动作白名单 | 无测试脚本；Electron 与 cookie/页面 JS/下载权限很高；peer 从 rc.1；动作白名单不是站点/数据流安全边界 | 必须要“同屏接管”才选；通常优先 dsh-pilot 的 origin fence |

### C. 当时因证据或权限边界暂缓的插件

| 插件 | 暂缓原因 |
| --- | --- |
| [`@a9i5k4/dsh-auto-memory` 0.1.28](https://github.com/Aik358/dsh-auto-memory/tree/72660743af23adef4e2b4a060e7a240d30b2b9d8) | 四天发布 28 个版本；主要交付编译产物，常规源码/测试证据弱；每轮 subagent 整理、日记/反思/日历/问候很全，但同时读写文件、联网、执行子进程并可自更新包。其“主动提醒”主要是进程/页面或下次会话，不证明冷启动可靠投递。适合参考设计，不适合先托管个人数据。 |
| [`dsh-hermes-memory` 1.0.0](https://github.com/isheng-eqi/dsh-hermes-memory/tree/8d32188753774817203e1a4867a83030f6a5db28) | 接近 Hermes 的 MEMORY/USER 双 bank 和 frozen snapshot，但只有编译 JS、无测试脚本，README 对“一项/五项工具”表述矛盾；源码使用 storage 却未声明 inject。且缺 Hermes 官方现有的注入扫描、后台 review、approval、session search 和外部 provider。 |
| [`@openviking/dsh-memory-plugin` 0.1.0](https://github.com/volcengine/OpenViking/tree/2c205d8a7a9256457b582639795adf043b0ecc41/examples/dsh-memory-plugin) | 这是 OpenViking 官方仓库中的高质量 installable example，有多项测试、pending replay、URI guard 和可选 live E2E；但 peer **精确锁定 rc.6**，README 明确要求 exact rc.6，与研究所述 `0.1.2-rc.1` 不兼容。先升级适配再评估。 |
| [`dsh-permission-rules` 0.5.2](https://github.com/PerryLink/dsh-permission-rules/tree/369f146d4a73935005442d1b9350c421111ada04) | 功能、测试、审计和 network policy 很有价值，但所有关键 DSH peers 精确锁 `0.1.0-rc.7`；研究所述 `0.1.2-rc.1` 应先更新。它也明确不是 OS sandbox。 |
| [`messaging-core`](https://github.com/534119219/dsh-messaging/tree/f1c3399ef40e3f419161d153e997d6f30576a627) | 一包声称 27 渠道，有 bundle 与大量 adapter 代码，但仓库主要是编译 `lib/`、无测试，安装流程仍偏手工 file dependency；配置向导还明确提示 secret 输入不隐藏。广度远超可核验深度。 |
| [`dsh-im-channel` 0.2.1](https://github.com/shrekcg/dsh-im-channel/tree/fb64263341fba403a051b3c3fa9875933c425f8c) | 有源码/测试/CI，诚实标注仅飞书/Telegram 较完整；但架构包含独立 bridge、子进程调用 headless profile、额外 session package 与 40 个飞书工具，安装/权限/故障面明显大于 `dsh-lark-channel`。 |

## 后续开发入口

早期推荐安装组合、P0–P2 建设清单和重复验收门槛已由当前文档取代，历史内容可从 Git 查询：

- 安装与能力选择：[根 README](../README.md)、[插件目录](../plugins/README.md)。
- DSH/Cordis 组合与资源生命周期：[仓库架构](architecture.md)、[开发约束](../AGENTS.md)。
- 自迭代闭环与成功条件：[持续成长设计](continuous-personal-assistant-growth.md)、[RSI 当前状态](rsi-status.md)。

## 来源索引

- DSH 官方：[repository](https://github.com/deepseek-ai/deepseek-harness/tree/141eb6fef83422698aef7a981029e843e8161534)、[base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/bundle/base/cordis.patch.yml)、[schedule](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/subsystems/schedule.md)、[MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/mcp/mcp-client/README.md)。
- 社区入口：[GitHub topic](https://github.com/topics/dsh-plugin)、[`awesome-dsh-plugin` 固定快照](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/tree/588e49808284c589073ef2eefdf9260c2913a9dc)。
- 对标：[OpenClaw 固定快照](https://github.com/openclaw/openclaw/tree/71cff695c1fe182d8acda7bd5739a7f38ff467c9)、[Hermes Agent](https://github.com/NousResearch/hermes-agent)及其官方文档。
- 社区候选的固定 commit 链接已逐项放在清单表中；版本、peer、scripts 和 bundle 判断来自相应 commit 的 `package.json`、`cordis.patch.yml`、README、源码与测试目录。
