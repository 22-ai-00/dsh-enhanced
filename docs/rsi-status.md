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
- **自改进插件**：`assistant-growth-driver` 把完整原任务父链送入工具创建/修订 Growth；`plugin-control-plane` 管理隔离验证、采用/回滚与修订父版本；`assistant-evolution` 只允许经 owner 批准的 guidance 注入与退化精确回退。后台 WorkItem 失败走廊的修订能力（P1-3）已落地 wire/授权/准入/验证层：`source-run/v3` + revision authorities pins（`b2e784b7`）、准入守卫与 verifier 开关（`a9b906e6`）、控制面 revision readiness/frame/prepared-revision v2 handoff（`f9dec899`）、verifier work-item 修订验证（`18b57a1d`）、v1 验证路径回归修复（`dd902af2`，CI 六 lane 全绿、control-plane 1732/1732）；全部 fail-closed，growth 走廊工具层尚未放开。完整长期“新版本更好”收益（同供应商同预算比较）尚未用连续普通使用验收。
- **渠道与主动性**：Delivery 持久 inbox/outbox、owner 配对、会话 generation、Policy 硬预算与默认拒绝；lark-channel 飞书长连接、脱敏进度、卡片；可选 peer bot 白名单（linked principal，精确白名单每条消息重检，peer 不继承 owner 权限/记忆/反馈通道）；话题群可按 `thread_id + principal` 做 lane，回复留在话题。Proactive 提醒、Evaluation 通知结果账本、注意力参数收紧自动回退、放宽留出重放 + 一次性授权 + 结构化 owner 问题（P1-2 起回复可在显式开关与 `answer-attention-question` Policy 规则下生效）。
- **安装与配置**：引导安装只问一次；fresh supervised 安装自动应用 recommended 预设（observe work-items、自然反馈、通知结果、事件 poller）；权限默认 danger-full-access；owner 鉴权、封存验收与日志脱敏保留。owner-console 左栏控制台可管理飞书/TraeX/本项目 bundle，doctor `--readiness` 报告普通学习装配各环。
- **Web**：原生 Web owner 固定；owner-console GUI 冒烟通过，真实明暗主题长跑未验收。

## 下一批（按目标优先级）

1. **触发→自动准入闭环**：在 fresh install 显式开关下生成 `accept` ceiling + `intakeLedger.evaluation.admit` + auto 有界预算，使普通消息→模型判断→自动 WorkItem→执行→独立验收形成全自动闭环（确定性 gate 与预算仍 fail-closed）。
2. **P1-3 后台失败任务的工具修订（进行中）**：wire（v3 协议+revision grant）、准入守卫、控制面 readiness/frame/handoff、verifier 修订验证已提交且 fail-closed；剩余 growth-driver 走廊（7 工具集、identity、usage-runtime v3 构造）与可选的 regression/adoption v3 分支。完成后后台作者可修订既有插件。
3. **P1-4 后续收益**：同供应商、同预算的前后版本质量/返工/成本/延迟比较与回退，用连续 3–5 类真实任务完成“新版本更好”的普通使用验收。
4. 终态释放 follow-up 重新进入判断的生产消费方；话题 lane 后台通知仍按顶层发送（无 `replyToEventId`）。

## 延后验收

- 飞书机器人真实长期使用（用户按次授权测试）；活 Home Docker→native 原地切换与活系统升级。
- 全局 CLI 在 `~/.npm-global`；本地柳七月（`assistant` profile）用 registry 0.1.67 持续体验，保留飞书 bot 与模型配置，旧 file: 装配配置已备份。

## 最新完整检查

| 精确提交 | 环境 | 结果 | 测试 passed / skipped | 文件 passed / skipped |
| --- | --- | --- | --- | --- |
| `09cffe2b`（0.1.67 发布提交） | Linux / Node 24.7.0，隔离 Node 22.23.2 | EXIT 0，PASS，2286 秒 | 12,954 / 314 | 823 / 32 |
| `48fa40fa`（0.1.66 发布提交） | Mac / Node 26.11.1 | EXIT 0，PASS，1148 秒 | 11,179 / 1,933 | 765 / 85 |

更早切片结果保留在 `docs/evidence/verification-<sha8>/`（gitignored）。`09cffe2b` 同时由 CI 四 lane（linux-packages、linux-root-tests 双分片、macos-verify、windows-acp-smoke）全绿背书；macOS 平台行为由 macos-verify lane 持续覆盖。
