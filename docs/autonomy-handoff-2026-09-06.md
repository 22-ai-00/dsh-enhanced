# 自主智能体目标：跨设备交接

> 2026-09-08 当前批次（基线 `b8cba5b`）：事件 envelope 已贯通 file/HTTPS JSON/HMAC webhook → Automations，来源与投递目标持久绑定；改配置及缺少来源证明的旧 pending 事件进入 quarantine。原生任务集成分别覆盖独立验收成功/失败和一次替身接受的投递，未验证出站内容承载验收结论；报告预写、模型与出站为替身。DeepSeek 生产工厂已通过全新安装后的 CLI 替身验证，真实模型效果待凭据。完整 18 项为 **3 已验证 / 9 实现中 / 6 待做**；WP11 的事件等待/目标关联和真实日历等来源仍待完成。见[当前账本](agent-autonomy-implementation.md)与[本批证据](evidence/strategy-deepseek-2026-09-08.json)，下列更新按历史保留。


> 2026-09-08 最新推进（基线 `b8cba5b`）：交付可选 DeepSeek 生产 strategy-v1 工厂与配置模板，保持供应商输出上限和派发前保守输入预留，并把模型适配器/credentials 源码加入双方计划。最终检查与安装运行证据见 [本批证据](evidence/strategy-deepseek-2026-09-08.json)。真实供应商响应和策略收益仍待可用凭据与实际调用验证；完整 18 项状态不变，继续按依赖和证据推进。

> 2026-09-08 最新推进（基线 `13ef450`）：strategy-v1 完整 executor/journal、setup 全流程期限、持久失败证据、实际工具/persona/Policy/源码核对及 CLI/doctor 已接通。独立安装的四题×两臂×两次重复 16 cell 全部完成失败修订后通过，120 次明确夹具请求和 64 份独立验收回执可回读；重开 run/report 不增加请求。源码、全仓最终状态与独立复核见 [本批证据](evidence/strategy-executor-2026-09-08.json)，用法见[策略协议](goal-strategy-evaluation.md)。真实模型收益仍未证明，完整 18 项继续保持 3 已验证 / 8 实现中 / 7 待做；下一步接兼容限额的实际模型比较及其他工作包，不为日历排期或长期观察等待。以下旧交接段落按历史保留。

> 2026-09-07 策略诊断与验收关联（基线 `11d294c`）：schema 2 策略账本保存观测到的执行阶段和终止原因，旧诊断保持未知。后续目标上下文重验 exact parent run 的独立回执，不用后来成功覆盖早先策略对应的失败；关联不是因果收益。9 条真实原生场景覆盖额度、工具拒绝、撤权、迟到 start、模型流/usage/请求钩子/流构造失败，预留与 unknown 语义保留。最终全仓和安装浏览器证据见 [本批证据](evidence/strategy-assessment-2026-09-07.json)。完整 18 项仍 3 已验证 / 8 实现中 / 7 待做；下一步沿[固定预算比较协议](goal-strategy-evaluation.md)接实际 executor，真实模型收益尚未证明。

> 2026-09-07 原生策略接线（基线 `eb48662`）：可选 `goal_strategy` 复用原生 subagents，在同一已准入目标预算内进行调查、复核或双视角比较。子任务无工具、只返回未验证建议；原生身份、私有一次性许可、当前父目标授权和预算均在请求前核对。实际安装场景仍由独立隔离验收完成失败→修正→通过；模型响应是明确夹具，未证明真实智能收益。完整命令与限制见 [本批证据](evidence/goal-strategy-native-2026-09-07.json) 和落地账本。18 项为 3 已验证 / 8 实现中 / 7 待做；继续按依赖和证据推进，长期观察留在交付后。

> 2026-09-07 私有目标配置接线（基线 `16f9515`）：已安装的 Web owner CLI 能以私有任务 JSON 和既有 Session 写入独立验收、有限预算和精确后台 route，重复字节幂等、只读 owner/grant 检查且不续权。真实浏览器经过 3 个 Host 进程、原生模型选择器和实际后台重启，完成两轮隔离产物修正、step/outcome 失败后通过、4 条预算结算及成功 wake。根检查和专项通过；付费模型响应仍为明确夹具，Session ID 发现/图形配置与完整 WP17 尚未完成。最终命令和限制见 [本批证据](evidence/goal-admission-setup-2026-09-07.json) 与落地账本，全部 18 项继续按依赖和证据推进。

> 2026-09-07 DeepSeek 预算接线（基线 `c611295`）：新增可选 `assistant-deepseek-budget`，固定 DeepSeek v4 adapter 与同生命周期的精确 route meter，按保守输入上界预留、实际输出限额发送并凭完整 usage 结算。金额费率未知时拒绝金额预算，凭据撤销、卸载、重定向与挂起请求均有边界检查；不会把 token 约束称为账单硬限。实际安装的原生目标闭环使用生产 adapter/meter 和明确的供应商响应夹具，没有真实付费 API 调用。最终命令与限制见 [本批证据](evidence/deepseek-goal-budget-2026-09-07.json) 和落地账本；完整 18 项继续按依赖与证据推进，无按天或长期观察等待。

> 2026-09-07 目标重启接线更新（基线 `5e116b9`）：真实安装与新进程恢复已揭示并修复“原生 idle/blocked 早于独立验收、后台提前释放 Agent”的竞态；Delivery 增加版本化的当前 Agent 结算等待，末轮 blocked→complete 的额外 revision 只凭精确实际执行与全目标 achieved 回执接纳。有限 `goal_schedule` 预授权默认关闭并保留原生 Policy；按依赖与证据推进，不为日历排期或长期观察等待。最终浏览器、全仓命令和限制见 [本批证据](evidence/goal-wake-runtime-2026-09-07.json) 与落地账本；完整 18 项目标继续推进。

> 最新接线更新（2026-09-07，基线 `6c8524b`）：新增 v4 隔离产物来源绑定与独立容器验收，步骤和全目标使用同一原生 Goals 生命周期。真实 Web 临时 profile 已验证一次请求→首轮错误产物→独立验收失败→下一原生回合收到反馈并修正→step/outcome achieved→native complete，零逐条审批。模型与计量器是明确的确定性夹具，Goals/Verifier 精确配置是安装后显式 test overlay，不能称为安装器默认完成全部自治或真实模型智能证明。有限 `goal_create` 预授权默认关闭，开启必须有两个 isolated profiles、累计预算、精确线路 meter 和 live owner turn。最终命令、源码哈希与独立复核见 [本批证据](evidence/isolated-goal-2026-09-07.json)；全部 18 项仍为 3 已验证 / 7 实现中 / 8 待做，按依赖与证据推进，不按天等待，长期效果观察放在交付后的使用中。


> 2026-09-07 最新接线：显式 `--scenario autonomy` 已接入有限离线 Web owner 安装、生产 Docker probe、幂等 grant 与原生隔离工具预授权。真实安装揭示并修复了 Isolation/Actions default export 丢失可信插件名的问题。当前证据与限制见[落地账本](agent-autonomy-implementation.md)及[安装证据](evidence/autonomy-install-2026-09-07.json)；完整目标仍进行中，下一步接可信隔离 artifact 到 Goals/Verifier。长期主动性观察与按天估算均不设交付等待期。

> 有限动作 broker 更新（2026-09-07）：新增实验性 `assistant-actions`，可信 Host 通过短期凭据 lease，只向 operator 精确授权的 GitHub 仓库/分支/文件执行带 expected-head 的原子 commit。持久动作账本保留未知结果、阻止同 key 重放及同目的地/旧 head 的新 key 重试；撤权不承诺撤销已送达的提交。真实 ToolRuntime、Isolation 路由、Policy、受保护凭据文件和本地 HTTP 协议夹具已组合验证；没有调用真实 GitHub mutation。最终全仓与独立结论见落地账本末尾及[动作证据](evidence/action-broker-2026-09-07.json)。完整 18 项继续推进。

> 隔离存储更新（2026-09-07）：schema v5 新增全状态目录观测准入、有限记录数和持久 storage reservation。结果正文清理默认关闭，显式启用后仅处理已确认停止的已知终态，保留原结果摘要、清理标记、幂等记录和累计预算；所有 unknown 正文保留。Host 后台与独立 `dsh-isolation maintain` 共用有界维护，WAL 忙时保留读者，SQLite freelist 不抵扣暂存预留。当前保护不是文件系统硬配额；最新验证与限制见落地账本末尾及[存储证据](evidence/isolation-storage-2026-09-07.json)。全部 18 项仍未完成，按依赖与验证继续，不按人工天/周等待。

> 隔离回收更新（2026-09-07）：schema v4 已接通完整请求回执下的 Host 后台与独立 CLI 配额回收。原 supervisor 退出、同 Docker 代次、三资源精确清理回执及当前 fence/CAS 必须同时成立；保留 unknown 业务结果与已消耗预算，不重放执行。回执缺失、被中断 mutation 和 daemon 换代仍持有配额，systemd 诊断不能替代 containerd/shim 停止证明。真实 Docker、协议异常、冻结全仓检查与独立复核见[最新证据](evidence/isolation-reconciliation-2026-09-07.json)和落地账本末尾；全部 18 项继续推进。

> 隔离恢复更新（2026-09-07）：schema v3 在 fork 前持久写入派发意图，修复 prepared 状态下 Host 崩溃仍可能晚到 create 的早释窗口；已派发 unknown 与旧版缺证据记录继续占用，不因当前资源不存在而释放。新增私有 daemon/supervisor 诊断及真实独立 rootless 重启探针，但可信 socket 绑定与自动释放协议仍未完成。最新全仓、反向实验和独立复核见落地账本末尾；完整 18 项目标保持未完成。


> 用户验收调整（2026-09-07）：取消“两个完整工作周主动性效果观察”的交付要求，长期主动性效果在交付后的实际使用中持续打磨，不设固定观察期。交付前仍验证主动性功能、指标记录与安全边界。以[当前落地账本](agent-autonomy-implementation.md)和[更新后的规划](agent-intelligence-autonomy-roadmap-2026-09-06.md)为准。

> 用户执行节奏调整（2026-09-07）：按天/周的规划只是人工工作量估算，不是智能体的配额或等待条件。按依赖和验收证据持续推进、并行处理独立任务，不受原排期限制；功能本身的超时、冷却、调度等时间语义仍需正确验证。

> 最新浏览器更新（2026-09-07）：修复 Web owner 缺浏览器模块、原生 workspaceId 被拒绝及空闲回收误移除界面会话三个真实缺口。全新临时 profile 的认证、原生审批、HTTP/WS、业务 Goal、Host 重启与新浏览器上下文恢复同一 Session 已连续三次通过；[结构化证据](evidence/web-owner-browser-2026-09-07.json) 和测试入口 `pnpm test:web-owner` 已保存。模型为有界确定性夹具，不证明真实模型收益、整体目标达成、跨日或 OS 隔离。最终全仓检查与独立复核以落地账本末尾为准，完整 18 项继续推进。

> 最新安装更新（2026-09-07）：显式 `--scenario web` 已接到现有安装器，先安全初始化 owner/物化 profile 配置再探测启动。全新临时 DSH_HOME 的实际 DSH `0.1.2-rc.1` 安装和 Host activation 通过；重复 setup 保持 owner lineage 与配置不变。默认 core、真实用户 profile 和全局模型/权限设置未被擅自改变。最新完整检查与独立复核见落地账本末尾。浏览器消息端到端、完整自治配置、真实模型、跨日运行与其他工作包继续待做；这不是完整 18 项验收完成。

> 最新 Web owner 入口更新（2026-09-07）：可选实验性 `assistant-web-owner` 已接通原生文本 → 固定 Delivery owner/Policy → 业务 Goal，以及共享 Session lease 与真实 teardown。实际 Gateway 的两个事件订阅端、foreign RPC 拒绝、撤权/超时/卸载/相同内容伪造消息取消和历史订阅撤权均已有回归证据。插件尚未发布或激活到真实 web profile；浏览器/HTTP/WS、完整安装、图片与忙时排队、真实模型及跨日验证仍待完成。完整根检查、独立复核与 C2C 记录以落地账本末尾为准；下文保存历史进度，不把旧 WIP 限制误当当前实现。全部 18 项目标仍未完成。

用户要求暂时收尾并提交全部当前修改，换设备继续。本次为 **WIP 检查点**，不是完整验收或发布。主分支为 `dev`；接手先拉取远端，再读本文件及 [完整落地账本](agent-autonomy-implementation.md)。

> 接手更新：以下进度与优先事项保留 `fdcee5c` 冻结时的历史事实。续跑护栏和 teardown 缺口已修复，并通过真实驱动、超时、停止、撤权、lease 丢失及独立复核；最新全仓检查和剩余工作以完整落地账本末尾为准。完整 18 项目标保持未完成，续跑配置默认仍为 `0`。

> 后续更新：原生回合的可选 v2 独立步骤验收、目标定义版本与私有执行账本已接入 Verifier → Evaluation → Evolution，并通过根检查与独立复核。配置默认关闭；步骤结果已接回当前目标上下文，后续原生回合可以依据独立失败条件修订计划。可选的跨步骤预算预留已通过根检查（主 3,263 项测试；Goals 46、Delivery 622 项包测试），默认关闭且需要可信 Host 路由计量器；完整 WP05 的持久唤醒、跨日恢复和整体目标结果仍待完成。最新命令、计数与限制见完整落地账本末尾。

> Session 排他更新：Delivery schema 19 已把已有 Session 恢复与首次/new construction 纳入同一持久凭证。有效占用等待，已派发而无法证明停止的执行保持 unknown；旧 Agent 和迟到调用失去权限，只有真实 teardown 与已跟踪操作结束才释放。冷恢复会提示核对，`/new` 保留旧 Session 并独立开始。后台 owner 入口、Automations 持久 wake 与跨日实跑仍待完成，本层不代表完整 WP05 或 OS 隔离通过。最终工程证据以落地账本末尾为准。

> 单次 wake 更新：默认关闭的 `backgroundWake` 已接入 owner 当前回合授权、Automations 两阶段 at 物化、原 Session/GoalId/revision 恢复与 dispatch CAS。六项真实恢复专项通过，含独立步骤验收、撤权、持久旧 Inbox 拒绝、deadline、/stop 和迟到工具拒绝；最终全仓证据见落地账本末尾。进程崩溃遗留 dispatched 与 unknown 均不重放，跨日生产运行和业务目标整体验收仍待完成。

> 整体目标验收更新（2026-09-07）：可选 v3 `goal-outcome` 已冻结整体成功条件并贯通 Verifier → Evaluation → Evolution。真实驱动两轮测试验证步骤通过但整体失败、下一轮按失败条件修复、整体通过后准确完成原生目标；恢复/释放/迟到验收保持 unknown 或待完成，不重放业务执行。最终根检查 `/tmp/dsh-goal-outcome-check-v5.log` 与 `.exit=0`：主 234 文件/3,320 测试，Delivery 642、Goals 68、Verifier 47，全构建/dry-run pack 及独立复核通过。下文旧 WIP 段落是历史记录；最新证据与限制以落地账本末尾为准。跨库 Session flush/原子提交、真实跨日闭环、生产计量与 Web owner/安装仍未验收；全部 18 项目标保持未完成。

> 创建预检与诊断更新（2026-09-07）：Goals 创建/编辑前已精确检查 step/whole profiles，缺规格或期限不足不会先修改原生目标；同一定义的整体标准与绝对期限保持冻结。Health 已接 Goals，并修复实际三个 Verifier 生产者被旧白名单误拒绝的问题。最终根检查 `/tmp/dsh-goal-readiness-check-v2.log` 与 `.exit=0`：主 234 文件/3,332 测试，Goals 72、Health 45、Verifier 51、Delivery 642，全构建/dry-run pack 及独立复核通过。真实 `web` profile 当前解析到 DSH `0.1.2-rc.1` 且已有浏览器认证，后续应复用现有界面补 Web 到 Delivery owner/权限的关联；不要根据旧 Web 缓存重复实现认证或另建聊天界面。默认自治安装、生产计量和真实跨日验证仍未完成，完整 18 项范围不变。

> Web Session 执行保护更新（2026-09-07）：已验证实际 `SessionController@0.1.2-rc.1` 的 cold follow 和 live prompt 两条借用路径。未持有本地凭证的 Agent 无法执行 Delivery Session；向正在运行的同一 Agent 追加原生用户消息会取消租约，已派发任务保存 `dead_letter / processor-ambiguous` 且不重放。普通未托管 Web 会话仍能创建并完成原生用户轮。最终根检查 `/tmp/dsh-web-lease-check-v3.log` 与 `.exit=0`：主 234 文件/3,343 测试、Delivery 653、Policy 186，全部类型检查/构建/dry-run pack 通过。取消 Web Agent 不等于释放 Controller 持有的生命周期；下一步必须把 Web owner/Policy、恢复准入与 teardown 一起接通。尚未验证浏览器端到端、完整自治安装或跨日收益；全部 18 项目标仍未完成。C2C 仅有本地执行记录，未取得实际 ChatGPT 评审。

> 共享 factory 生命周期更新（2026-09-07）：Delivery service 的运行时注入范围现在构造唯一租约管理器，内置 create/resume 复用宿主 factory，并保留调用方独立 fiber 的真实清理责任。实际 Controller 冷 follow、Host notice 完成、独立 Web scope 卸载后 Delivery 更高 fence 续接、setup/commit 回滚及上游迟到 preparation 已纳入回归。独立复核发现并修复了公开 resume 取消早于底层加载清理的窗口：setup 前的 resume 失败按原生 factory 代次/可见性、owner fiber 与组合 signal 核对全部三条取消路径；普通已结束的加载错误保留恢复重试，取消或缺少证明时保持 unknown，不把迟到 cleanup 猜测为自动解锁依据。最终完整检查与独立复核证据见落地账本末尾。

> 下一步接线位置已确定：在原生 `session-controller` bundle 行的构造入口提供限定作用域的 `agents` facade，复用共享原始 registry；不能改装已构造 Controller 的私有闭包。当前 facade 只存在于真实测试，生产仍缺 service 颁发的固定 owner capability、Web 新 Session binding、当前人类输入与原生 source 的确切关联、Policy 和 idle/wake 生命周期交接。不能公开内部 raw lease manager 当作 Web 授权，也不能把 Web conversation 冒充为现有 Lark owner 的路由；canonical transport identity 与 owner lineage 需要显式处理。完整 18 项目标保持未完成。

> 工具证据恢复更新（2026-09-07）：WP07 已接原生成功 `read` 的 FS 观测/owner 绑定索引、压缩后引用清单和分页原文回读；实际 JSONL 关闭重建、撤权、半提交、原文损坏和符号链接改指已纳入回归。旧正文仍为 historical-unverified，当前授权重读不把历史事实变新；任意工具通用回放、真实长期闭环与其余工作包仍未完成。最新工程证据以落地账本末尾及 `docs/evidence/tool-evidence-recovery-2026-09-07.json` 为准。

## 完整目标

完整落实此前分析和规划，让项目成为高智能、高主动、能长期自主推进任务并持续自我改进的智能体；高权限与可验证的安全边界兼顾，同时安装、配置、升级和通过 Web 对话都方便友好。保留账本全部 18 个工作包，不能把目标缩成当前已实现的切片。

## 当前进度

18 个工作包中 3 项已验证、4 项实现中、11 项待做；它们工作量不等，不代表智能能力完成百分比。可信任务结果、反馈修订、独立任务验收已有工程证据；真实模型比较基线、目标持续执行、记忆和安装仍在推进。跨日目标闭环、高权限隔离、主动任务选择、自我改进收益与完整 Web 部署仍未完成。

上一次完整通过根检查并推送的提交为 `e285440f6aae3ed52a9bcce2dcd5e701e3b492ce`。当时 `CI=true pnpm check` 退出 0：24 插件、3 共享库，主测试 218 文件/3,113 通过、82 跳过，lint/typecheck/build/dry-run pack 通过。这个结果 **不覆盖本次 WIP**。

本次修改：

- `assistant-goals` 增加 `goal_control` edit/pause/resume/clear：当前 owner 人类回合、逐操作 Policy、同 Session/GoalId 与原生 revision CAS；提交后重查授权与业务投影，失败报告部分完成；clear 保留历史。Goals 包当前 24 项测试通过，生命周期静态独立审查 PASS。
- Delivery 新增默认关闭的 `agentGoalContinuationTimeoutMs`（0–300000ms），尝试保留 Agent 供原生 goal-round-driver 继续执行。动机已复现：驱动排入第一轮后，原有 Delivery 清理取消了该轮。当前实现 **尚未通过运行时验证**。
- 已写真实原生驱动的暂停→恢复测试，断言保留同一 GoalId、两轮上限/轮次累计、检查点上下文，以及自主回合不得调用 owner 生命周期控制。此次冻结前未运行更新后的该测试；超时、停止和撤权测试尚待补齐。
- [目标编排设计](goal-orchestration-design.md) 保留普通入站消息的原始验收要求；长期目标独立契约、预算和持久唤醒仍待实现。

本次冻结前 Delivery TypeScript 检查退出 0，`git diff --check` 通过；没有运行本次完整 `pnpm check`，不能声称全仓验收通过。依赖已恢复，root `CI=true pnpm install --no-frozen-lockfile --ignore-scripts` 退出 0。临时日志不随 Git 同步，不应把另一设备缺少 `/tmp` 日志当作已有测试失败或通过的新证据。

## 接手优先处理

1. 修复 Delivery 续跑 WIP 的已知窗口：当前 `goalContinuation.dispose()` 在 handle 释放前拆除护栏；应保留到实际 teardown 结束，兼顾取消时异步 disposer。自然结束前还需重查 signal 与当前授权。当前等待放在原回复入队前，需决定并核对原回复/续跑顺序，修正文档相应措辞。
2. 验证每个模型步骤（包括工具结果后的步骤）、工具执行前的授权重查；验证取消后不放行迟到副作用。超时不能被不响应取消的第三方工具或 `whenIdle()` 无限拖住，也不能因此谎报 quiescent。保留默认 0 的既有行为。
3. 运行真实驱动恢复用例，补 timeout、`/stop`、owner 撤销、unknown 验收和轮次耗尽后恢复不重置上限的测试。移除遗留无用等待；不得通过 skip 或削弱断言隐藏驱动问题。
4. 独立只读复核续跑代码和证据，再执行根 `CI=true pnpm check`。本仓库有本机监听测试，受限网络环境可能需相应权限。只有明确退出 0 才记全仓通过。更新账本后继续 WP05 独立目标执行契约、期限/预算/授权和复用 Automations 的持久唤醒。

## 持续约定

- 用户已授权把修改提交并 push 到 `dev`；本次必须保存全部当前修改，但 WIP 不应发布或启用续跑配置。
- 按 AGENTS.md 使用主协调、独立 worker 和 verifier；文件单写者，子代理不递归委派。只有根代理执行 pnpm，使用 `CI=true`；避免不同权限环境 store 不同导致重建 node_modules。
- 用户指定复用 `web` profile 与现有模型。先前小型真实基线见 `docs/evidence/benchmark-web-smoke-2026-09-06.json`：8 调用、输入 2084/output 164、同预算比较无增益证据。后续暂定输入 100k/output 30k tokens，有价格时费用约 2 美元上限；当前路由价格未知，不能声称金额硬限已生效。无需向用户索要密钥。
- 本机旧全局 DSH 为 0.1.0-rc.8，仓库基线 0.1.2-rc.1；接手在新设备重新核实。模型配置复用不等于 Web profile 已升级或验收。
- 用户要求合理使用 Codex with ChatGPT；此前 workspace-info 返回内部错误，未取得实际 ChatGPT 评审，也未启用隧道。不能把该意图写成已完成审查。
- 完整目标保持未完成。用户这次要求暂时收尾，不应在本设备继续自动扩展功能，也不应把暂停或跨设备交接标成目标达成。


2026-09-07 后续推进（基线 `bc67ce3`）：固定预算策略比较新增严格冻结契约、全 cell 外层 meter 和真实临时 Delivery/JSONL owner 装配。正常原生 compare 证明外层 5 请求包含内层 Goal 4 请求及 2 child；空 Session 头已通过 ensureMaterialized 真实持久化后恢复。完整 executor、隔离验收、CLI/doctor、持久详细证据与真实模型比较仍待接线；18项仍3已验证。详见落地账本最新 WP04/06 条目与 `docs/goal-strategy-evaluation.md`，继续按成果推进，不按天/周等待。

本批完整根检查已退出 0：291 文件 / 3,750 项，无跳过，31 份 dry-run pack 通过；新增公开接口与两包清空生成目录后的 bootstrap 均已验证。证据见 [strategy foundation](evidence/strategy-foundation-2026-09-07.json)，仍不把执行基础当作完整 executor 或真实策略收益。

2026-09-07 后续（基线 `eb106bb`）：已接通单 cell 的真实 Goal/Isolation/Verifier 与关闭后完整证据保存。当前 owner 路由允许在原生 Agent 释放后读取持久执行快照；step 和 outcome 合同通过真实 triggerRunId 分开关联，完整策略记录不截断。确定性 direct/strategy 两分支实际 Docker 错误产物→独立失败→修订→成功；完整比较 executor/CLI/实际能力核对与真实模型收益仍未完成。最新验收以落地账本和本批证据为准。

本批最终根检查（2026-09-08）已退出 0：294 文件 / 3,763 项，无跳过，31 份 dry-run pack 通过，公开入口导入成功；真实复制对象和完整命令哈希见 [strategy Goal cell 证据](evidence/strategy-goal-cell-2026-09-08.json)。继续接完整比较 executor/journal、setup 全局期限、失败持久证据、实际能力核对、CLI/doctor 与真实模型比较，再推进其余工作包。18 项仍为 3 已验证 / 8 实现中 / 7 待做；按依赖与证据连续推进，日/周安排和两周观察均不是交付等待条件。
