# RSI 当前状态

更新：2026-11-08。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始证据在忽略的 `docs/evidence/`。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；通过持久任务、原生 Agent、独立验收和有限采用，减少用户管理上下文与逐步协调的负担。主动性是核心：借鉴 Superagent 原型“用最少的人类注意力换最多的价值”，按“触发→判断→行动→验收→学习”闭环自主发现并推进工作；确定性 gate 与模型判断分离，文本不能提升权限；对外发言由 Host 校验目的与字数，空闲不发言。与原型靠人工调规则不同，放开由留出证据、独立验收、有界采用与精确版本回退驱动，人只在超出一次性预授权范围时回答一个结构化问题。仅保留 `dev`、`main`：开发提交推送走 `dev`，发布验收通过后才合入 `main`。

## 发布状态

- `0.1.66` 已发布（tag `v0.1.66`，`main`=`48fa40fa`，CI 全自动）。双端精确根检查 PASS：Mac 11,179/1,933、Linux 12,796/311。
- `0.1.67` 已发布（tag `v0.1.67`，`main`=`3a459679`，record `5f960f16`，CI 全自动，38 包同版）：peer bot 入站与话题回复、P1-1 四个 wake 切片、P1-2 owner 问题回复闭环、P0-3 全新安装自足装配、非 LLM 路由 fail-closed、独立复核修复、CI 去重分片与根测试 PATH 规范化。精确提交 `09cffe2b` Linux 根检查与 CI 四 lane 全绿；本地柳七月 profile 18 个依赖已从 file: 切到 registry 0.1.67。
- Host 兼容基线 `>=0.2.1-rc.2 <0.3.0`，固定候选 0.2.2-rc.1；pnpm 11.7.0、store v11、Node 22.23.2（隔离运行时）/ 24（开发）。

## 已交付能力与边界

- **原生隔离与能力工厂**：Linux 原生 namespace/cgroup v1 执行、源码 prepare/build、离线工具创建（38 包），独立行为验收、审查证书、有限动态采用、修订采用（精确父版本 CAS + 回滚）。x64 实测；cgroup v2 拒绝，arm64 未验收。Docker→native 非空迁移：封存归档+新 plan 重新验证，真实模型重采用已在 Linux 内部基准网关实测通过；活 Home 原地切换按用户要求延后。
- **原生 Goal**：真实 Cordis/Loader/NativeWeb/AgentLoop 贯通，产物绑定独立 Linux 验收；正确产物 achieved、错误产物被拒；冷账本与资源清理核验。供应商为本地脚本，不证明任意任务能力。
- **持久工作项（默认关、observe）**：准入、认领、报告、有界 resume、显式诊断、owner 召回/续办/结果反馈；事件跟随（Event Triggers、订阅）、Policy 变更通知、跟进归属与终态释放、结果窗口结算均搭既有 native scheduler wake，无新 Loop/timer。独立验收绑定（句柄晚绑定）、裁决门、held 报告均为 opt-in 切片，合同见 WP21。
- **普通使用学习**：认证主人事实/经验→三份显式授权（学习/审查/采用）→独立审查→有限召回；后台 WorkItem 结果可进入经验（`workItemExperiences`），更正/撤回/unknown 有界。2026-11-07 起全新 supervised/native 安装可 `--enable-ordinary-use-learning` 自动生成只观察 intake evaluator（ceiling `digest`，从 Delivery 模型路由或显式 `--intake-provider/--intake-model`）、WorkItems 评估开关与三份带经验标记的记忆授权；非 LLM provider（如 `traex-agent`）会 fail-closed。`revisionCapabilities` 与 growth `workItemFailures` 签名 pin 仍未自动生成。
- **自改进插件**：`assistant-growth-driver` 把完整原任务父链送入工具创建/修订 Growth；`plugin-control-plane` 管理隔离验证、采用/回滚与修订父版本；`assistant-evolution` 只允许经 owner 批准的 guidance 注入与退化精确回退。后台 WorkItem 失败走廊的修订能力（P1-3）已落地 wire/授权/准入/验证层：`source-run/v3` + revision authorities pins（`b2e784b7`）、准入守卫与 verifier 开关（`a9b906e6`）、控制面 revision readiness/frame/prepared-revision v2 handoff（`f9dec899`）、verifier work-item 修订验证（`18b57a1d`）、v1 验证路径回归修复（`dd902af2`，CI 六 lane 全绿、control-plane 1732/1732）；growth-driver 修订走廊（`74090b9e`）在入队时按确定性目标匹配冻结 create/revise-created 走廊，bindSourceRun 构造 v2/v3 binding，工具面按走廊冻结为 4 创建工具或 6 修订工具并由 policy 仅对 growth-driver Fiber 预授权，匹配不到/歧义/peer 离线全部 fail-closed 回退创建；`e31ce7cb` 补齐两份受保护插件 denylist（growth-driver 自身等 11 个信任根），`664d3762` 进一步把成长模型提案边界（23 项宽名单）与 owner 监督式 source-repair/签名授权边界（12 项不可变根窄名单）拆成两个显式常量并加子集断言，避免治理组件失去 owner 修复通道。全部默认关、显式授权才开。剩余可选 regression/adoption v3 分支；完整长期“新版本更好”收益（同供应商同预算比较）尚未用连续普通使用验收。
- **渠道与主动性**：Delivery 持久 inbox/outbox、owner 配对、会话 generation、Policy 硬预算与默认拒绝；lark-channel 飞书长连接、脱敏进度、卡片；可选 peer bot 白名单（linked principal，精确白名单每条消息重检，peer 不继承 owner 权限/记忆/反馈通道）；话题群可按 `thread_id + principal` 做 lane，回复留在话题。Proactive 提醒、Evaluation 通知结果账本、注意力参数收紧自动回退、放宽留出重放 + 一次性授权 + 结构化 owner 问题（P1-2 起回复可在显式开关与 `answer-attention-question` Policy 规则下生效）。
- **做梦/突发奇想（默认关、实验性）**：独立 `assistant-dreaming` 插件（`b0fe5dd2`，S0+S1）。确定性 HMAC 抽签 + active-hours/idle/日上限门决定何时跑一次；冻结为恰好一个 `dream_submit_ideas` 工具的 Agent 只记录私有 idea（L0），每条引用 Host 投影的证据 digest；无通知、无 Goal/WorkItem、无自动采用，schema 禁评分/自评；默认配置完全休眠（无 automation/无 sqlite/零写入）。L1 owner 摘要通知与后续晋升切片未实现。
- **安装与配置**：引导安装只问一次；fresh supervised 安装自动应用 recommended 预设（observe work-items、自然反馈、通知结果、事件 poller）；权限默认 danger-full-access；owner 鉴权、封存验收与日志脱敏保留。owner-console 左栏控制台可管理飞书/TraeX/本项目 bundle，doctor `--readiness` 报告普通学习装配各环。
- **Web**：原生 Web owner 固定；owner-console GUI 冒烟通过，真实明暗主题长跑未验收。

## 下一批（按目标优先级）

1. **触发→自动准入闭环**：在 fresh install 显式开关下生成 `accept` ceiling + `intakeLedger.evaluation.admit` + auto 有界预算，使普通消息→模型判断→自动 WorkItem→执行→独立验收形成全自动闭环（确定性 gate 与预算仍 fail-closed）。
2. **P1-3 收尾（可选 v3 分支）**：growth-driver 修订走廊已落地；剩余可选的 revision regression 与 revision adoption 的 v3 work-item 分支（两者均为可选 pin，默认不触发）。
3. **P1-4 收益门（进行中）**：非劣合同与纯函数评估器（`65d353e8`，修正后 `80935f21`）、采用门缝隙/`source_revision_benefit_outcomes` 账本（`0e009d26`）、窗口聚合与 Host-only `evaluateRevisionBenefit(planId)` + 完整合同配置 `sourceJobs.revisionBenefit`（`22370991`）已落地；配置 benefit 后在成本/延迟可测数据源接通前保持 fail-closed（只判 insufficient）。剩余：采用后负向越界自动回滚（复用 revisionCapabilityRuntime 精确 CAS rollback）。
4. 终态释放 follow-up 重新进入判断的生产消费方；话题 lane 后台通知仍按顶层发送（无 `replyToEventId`）。
5. **CI 提速（已建夜间门禁，待分批落地）**：CI 已加 `schedule` 夜间全量门禁（`ci.yml`，前提项）；已删除复现旧 AND 链 bug 的重复测试（`6d1afd2d`）。后续按风险从低到高：合并三个安装成功事务、delivery schema 23–31 矩阵分层（日常只跑首尾版、夜间全矩阵）、release-adapter 无缓存全链转夜间；最大收益项是把 12k 行/353 用例的 `tests/installers.spec.ts` 按安装/升级/回滚/原生拆文件并重分片（注意共享清理状态，不能简单并发），以及 registry-fetch 证书复用与重复构建去重（需先实测）。规则：任何分流到夜间的用例，其关键风险在日常门禁仍保留代表场景。

## 延后验收

- 飞书机器人真实长期使用（用户按次授权测试）；活 Home Docker→native 原地切换与活系统升级。
- 全局 CLI 在 `~/.npm-global`；本地柳七月（`assistant` profile）用 registry 0.1.67 持续体验，保留飞书 bot 与模型配置，旧 file: 装配配置已备份。

## 最新完整检查

| 精确提交 | 环境 | 结果 | 测试 passed / skipped | 文件 passed / skipped |
| --- | --- | --- | --- | --- |
| `09cffe2b`（0.1.67 发布提交） | Linux / Node 24.7.0，隔离 Node 22.23.2 | EXIT 0，PASS，2286 秒 | 12,954 / 314 | 823 / 32 |
| `48fa40fa`（0.1.66 发布提交） | Mac / Node 26.11.1 | EXIT 0，PASS，1148 秒 | 11,179 / 1,933 | 765 / 85 |

更早切片结果保留在 `docs/evidence/verification-<sha8>/`（gitignored）。`09cffe2b` 同时由 CI 四 lane（linux-packages、linux-root-tests 双分片、macos-verify、windows-acp-smoke）全绿背书；macOS 平台行为由 macos-verify lane 持续覆盖。
