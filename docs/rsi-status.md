# RSI 当前状态

更新：2026-11-06。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始证据在忽略的 `docs/evidence/`。

当前接手入口：`docs/evidence/handover/CURRENT.md`。先核对该入口的源码清单，再续做下一步。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；通过持久任务、原生 Agent、独立验收和有限采用，减少用户管理上下文与逐步协调的负担。主动性是核心：借鉴 Superagent 原型“用最少的人类注意力换最多的价值”，按“触发→判断→行动→验收→学习”闭环自主发现并推进工作；确定性 gate 与模型判断分离，文本不能提升权限；对外发言由 Host 校验目的与字数，空闲不发言。与原型靠人工调规则不同，本项目的放开由留出证据、独立验收、有界采用与精确版本回退驱动，人只在超出一次性预授权范围时回答一个结构化问题。仅保留 `dev`、`main`：开发提交推送走 `dev`，发布验收通过后才合入 `main`。

## 已交付能力与边界

- Linux 原生隔离、源码 prepare、工具创建/修订、独立验收及 owner 升级事务已有实现。普通 autonomy 安装、Web setup/doctor 已接通 native 资源；重复 setup 保留身份、原期限和已用额度。Linux x64/cgroup v1 已实测；cgroup v2 拒绝，arm64 未验收。pre-owner 资源迁移已有双端根检查，不能代替 live owner 升级。
- 原生 Goal 已贯通真实 Cordis/Loader/NativeWeb/AgentLoop、产物绑定及独立 Linux 验收。正确产物得到 achieved，退出码为零的错误产物被拒绝；冷账本和资源清理已独立核验。供应商为本地脚本，不证明真实模型或任意任务能力。
- WorkItems 默认关闭、observe 模式；持久准入、认领、报告和有界 resume 已实现。显式 diagnosis 使用冻结 supplier、权限和有限预算执行只读诊断；只在准确 occurrence 成功且结算后续办，unknown 不自动重放。主人前台 `work_item_list` / `work_item_recall` 按 owner lineage 过滤并支持跨会话分页召回，不恢复旧授权或额度。
- 显式 `ownerReplyContinuation` 接通真实报告回复、持久子项与原生续办；先保存子项再 ACK，ACK 前不派发。显式 `ownerReportFeedback` 将准确 owner 结果回复接入 Evaluation，更正、撤回及丢 ACK 按原操作对账。Delivery schema 31（新增只追加的注意力审计表）、Evaluation schema 16（WP22 通知结果账本、注意力参数版本链与放宽授权/密封提议/决定/owner 问题四张不可改表）、WorkItems schema 12（只追加的确定性 intake 账本、inferred 评估表与准入表；显式 `intakeLedger` 时 lark-channel 经 Delivery 以元数据/摘要观察写入，显式 `evaluation` 时只存评估等级与引文偏移、正文不落盘；显式 `evaluation.admit`（默认关）才把 accept 的 inferred 候选经 `admitDecision` 准入）；报告入队不代表外部送达，owner testimony 不等于独立技术成功。
- 安装与插件配置：一路引导安装只问一次推荐/自定义，环境变量有 key 时自动存储，`dsh-rsi-setup --wait-owner-dm` 等首次 owner 私聊（默认 600 秒），末步可选插件预设（`--plugin-preset <name|skip>`）；`dsh-plugin-setup` 套用 recommended 预设（work-items + observe intake、Delivery 超额注意力附加、Evaluation 通知结果、event-triggers poller），不改默认值、不改 Policy/CP、secret 与 ownerRoutes。权限默认 danger-full-access；owner 鉴权、封存验收与日志脱敏保留。
- 后台反馈 → 持久经验 → 后续召回已交付至 `dev`（实现 `9d515afc`）。学习、独立审查、有限采用三份授权须分别启用 `workItemExperiences`；默认及前台 v1 不变。认证主人原文提供经验引文，worker 报告只作背景；更正、撤回或来源不可用时隐藏失效经验，unknown 不重复付费或返还额度。真实组件和新会话 Memory.search 已贯通；组件重挂不等于全进程重启，Host 调用不证明模型自主召回。

## 当前交付：后台反馈驱动工程成长

实现已提交并推送 `dev`（`d8c9fdd2`，双端精确提交根检查通过）。完整、可验证的原始主人任务沿父链进入既有工程 Growth，执行候选创建、独立验收、有限采用及后续调用；空白、附件或历史来源不完整时拒绝，不用 worker 简报或结果短句替代工程目标。后台作者使用精确预授权；前台工具调用保留原审批边界。没有新增 Agent Loop 或 timer。

相关组件专项、manifest 和零警告 lint 已通过。Mac 已分别通过并独立复核四个真实原生场景：创建→独立验收→采用→新会话调用，错误候选拒绝，更正/撤回，以及采用提交后丢 ACK 的组件重挂恢复。恢复沿用原身份、授权、证书与额度，没有重复作者或审查；不代表未知采用事务或全进程恢复。供应商均为本地脚本，Mac 编译打包不等于候选自测。

**当前待验收：** Linux 正常创建→独立验收→采用→新会话调用、错误候选拒绝、更正撤回及丢 ACK 冷恢复四个原生场景已通过并独立复核。丢 ACK 场景在组件重挂后恢复原 alias，只发生一次主人调用（`allowed-once`），未再付费生成作者或审查，adoption 仍为同一 `plan_id`。该场景曾因预算快照断言接连失败（`ack-r1`、`ack-r2`）；现改为在 automations 空闲后取一致快照，新增预留只能是绑定当前扫描定义 digest、`amount=actual_amount=1` 的 finalized 结算，既有预留的不可变字段逐字段不变（仅允许仓内 `reserved` 行首次结算为 `finalized`/`released`），保留失败尝试。原始 Policy 预留行未纳入归档，预算归属由该次通过运行的测试断言及复核代码证明。新后台任务的 Host 期限修复、读取取消竞态修复均已独立通过，旧 v1 定义不迁移。Linux 采用场景的测试总时限按实测多阶段耗时设为 600 秒，Mac 保持 300 秒；生产各阶段限额及根默认超时不变。双端根检查已在精确提交 `d8c9fdd2` 通过；新控制台插件检查（含两处评审阻塞修复）在精确提交 `94b86b61` 通过（见下节）。证据入口：`docs/evidence/work-item-engineering-growth/integration-current-checkpoint.json`。

## 当前开发：左侧栏控制台插件

`@dsh-enhanced/owner-console` 已在 `dev` 上迭代到精确提交 `f984d8c7`（双端根检查通过），功能闭环，剩余验收受 live 环境限制。左侧栏「控制台」入口 + 一页面板，设计沿用 Superagent 原型的注意力预算（一页、只显示需要人处理的事）。当前能力：

- **左侧栏即用**：面板顶部「开始对话」直接进入当前工作区的智能体会话（`uiWorkspace.startSession()`），
  「打开插件页」跳到 DSH 原生插件页（`layout.selectPanel('plugins')`）；两个客户端服务在点击时惰性解析，
  缺失时入口与状态页仍注册、按钮无操作。
- **飞书两种对接方式（配置 `lark-channel` 通道，不是 lark-cli）**：直接配置（appId + 恰好一个 secret
  引用：环境变量名或 keychain handle；secret 明文不接受）与一键配置（从 Host 进程环境
  `LARK_APP_ID`/`FEISHU_APP_ID` 或插件配置的默认 appId 探测）。lark-cli 只是可随时安装的独立 skill，
  不是本插件依赖；本插件既不调用它、不探测它的路径，也不管理它的安装，通道配置与它无关。写入用 `settings.mutate` 的显式 set/unset + `secretSource` 判别字段，解决 bundle 层默认 `credentialHandle` 无法被 unset 清掉的继承问题；account/tenant 留空时沿用现值，不静默改身份。
- **TraeX**：只切换 `traex-acp-provider` 条目的 enabled/command。
- **本项目插件管理（pluginManager）**：列出本项目 bundle 层（版本/安装/启用/可移除）与已加载条目
  （entryId/模块名/fiber 阶段），一键启用/停用；安装只接受 `@dsh-enhanced/<name>` 包名，走 DSH 自己的
  pnpm 路径并一并安装声明依赖；拒绝本地路径、git 地址与他人 scope。`restart-required` 视为已持久化并提示
  重启，校验拒绝保持红色告警。高级入口仍可对 live 字段合并 JSON 配置（≤16 KiB）。
- **写入即生效**：volatile 写入只更新 fiber 引用，面板写入后对目标条目执行 `fiber.update(持久化 raw config, true)` 重启一次，apex 会以新纯配置重建连接/provider；无法解析/重载时如实提示重启。
- **只读安全边界**：读取严格查找 service、投影不返回 secret 明文、业务拒绝以 `applied:false + note` 返回并在面板显示、client 卸载后不再 setState。
- **按状态给下一步**：飞书/TraeX 未安装→一键安装（pluginManager/pnpm，含依赖）、已安装未启用→启用、活动条目→配置表单；`not-bundle` 依赖行既不算已安装也不进管理列表。
- **管理动作**：本项目 bundle 可启用/停用/移除（移除仅对 `removable` 且非自身、需浏览器确认）；安装只接受 `@dsh-enhanced/<name>`。
- **飞书连接状态**：「连接」行读取 `larkChannel.health()` 同步快照，只透传 lark-channel 枚举内的连接状态与错误码；无 service 显示「未加载」，health 抛错/缺失/未知值显示「已加载，状态未知」，不推断为已连接。复制的枚举由契约测试对照 lark-channel 源码，新增状态或错误码会使测试失败。未用真实 Bot 验收。

实现要点：`lark-channel`/`traex-acp-provider` 只在 owner 可编辑字段上标记 `.volatile()`，并在 schema 边界接受 volatile 引用、输出纯值；`lark-channel` 用 `secretSource` 在 callable 与 `~standard` 两条验证路径上屏蔽未选引用，并让非法配置 fail-soft（记录后保持 disabled，不炸 Loader 树）。飞书面板配置的是 `lark-channel` 通道；lark-cli 只是可随时安装的独立 skill，本插件既不调用它、
不依赖它，也不管理其路径或安装。面板用单选决定 secret 引用方式，提交时只发送选中的那一个引用；
项目 bundle 可启用/停用/移除（移除仅对 removable 且非自身、且需浏览器确认）。
飞书/TraeX 卡片按实际状态给出下一步：未安装→一键安装（走 Host pluginManager/pnpm，含依赖）；
已安装未启用→启用；活动条目才显示配置表单；not-bundle 依赖行既不算已安装，也不显示在管理列表。
typert 参数顺序与 Host 方法签名对齐并有回归断言；Web client 构建产物通过 `__ModuleLoader__` 契约测试。

该切片经过多轮独立 harness 复核（真实 Cordis Loader/Include、`dsh-settings`、`config-editor`、
`plugin-manager`）：逐项验证 describe/mutate/重启/双模式切换、bundle 与条目启停、安装转发与拒绝边界，
并修正了页面把 `restart-required` 当成失败的问题；导航快捷入口再经一次静态复核（APPROVE，确认
`layout`/`uiWorkspace` 服务与入口 id）。复核和根检查还暴露并修复了三个稳定性缺陷：`usage-runtime`
假时钟跨分钟边界会多认领一次 usage-scan、isolation 归档 CLI 对实时写入源账本的大小断言过严、
WorkItems 原生 fixture 用等待代替显式信号 sweep 导致准入超时。三处修复后各自连跑 3~15 次稳定。

**真实 Web GUI 冒烟已通过：** 用临时 `DSH_HOME` + pinned `@deepseek-ai/dsh@0.2.1-rc.2` 安装本插件并启动
`dsh web`，无头 Chrome 实测左侧栏「控制台」入口、面板全部卡片与字段、原生插件页「已安装插件」行、
以及「打开插件页」「开始对话」两个快捷入口；无页面 JS 错误。证据在
`docs/evidence/owner-console/browser-smoke/`（含截图与复现脚本）。限制：未验证登录态与真实飞书/模型连接。仓库 peer 约定仍是精确 `0.2.1-rc.2`（由兼容性测试强制），
live Harness app 的 `0.2.1-rc.5` 需要 owner 显式风险豁免；已在该版本线的临时运行时上通过
`allow-version --accept-risk` 安装并验证入口、面板与 typert 状态（同证据目录 `console-panel-rc5-exempt.png`）。
飞书/TraeX 三态卡片也在真实 GUI 中复验：未安装→「安装 lark-channel（含依赖）」、已安装未启用→
「启用 lark-channel」、点击启用后得到 restart-required 提示；活动态→配置表单（见 `setup-states.md`）。
本地打包产物（`pnpm pack` tarball，与全新构建逐文件一致，非 workspace 链接）经 `dsh plugin add` 安装同样通过：
随包依赖 `schemastery`/`zod` 由 pnpm 装入，入口、面板与原生插件页已安装行正常（见 `tarball-install.md`）；
从 registry 发布后安装未验证。

尚未完成：从面板选择任意 registry 源（出于安全只允许本项目包名）、真实飞书长连接验收
（按用户要求延后，未连活 Bot）。lark-cli 不在本插件范围内，其安装/配置由 owner 自行通过 skill 完成。
远端真实使用验收仍由正式连接门保留。

## 待办与延后验收

1. 控制台插件各切片（`94b86b61`、`da5f8d42`、`124a52a1`、`2c295a40`、`4b78dc68`、`cea6beb1`、`c0f077e2`、`44ec103c`、`f984d8c7`、`4b7d8b80`）均已双端通过精确根检查，并完成真实 Web GUI 冒烟（含三态卡片与本地打包产物安装）。下一验收受 live 环境限制：真实飞书长连接、登录态与远端使用需 owner 在活 Host 上显式授权（当前按用户要求延后）。
2. 非空迁移资格（Docker→linux-native）已交付：`a45eac07` 封存迁移 + `68e4d8b3` Linux `NODE_PATH` 修复 + `c9ef3bd4` 仅测试的真实模型验收准备。非空采用历史只读归档（0400）后清空活账本，旧用量作为继承用量计入上限、不退还；Docker 时期 active 工具只能以新 plan id 与新 native 证书重新采用，原 plan id 被拒绝；审查库用 v2 grant handoff 原地交接，保留 `used`/`maximum` 与全部 verification 行。归档写入与事务中崩溃均可重试（WAL 与回滚日志两种残留）；整张审计表被删在 verify 时被拒；链上含封存 handoff 时，Host 更新在准备（原 Home 与暂存 Home）和切换前后的验证中都要求活账本的封存审计摘要等于签名 `proofDigest`，缺失、不同或已安装 control-plane 无读取函数时拒绝。限制：交接前签发的审查证书切换后仍被当前授权检查拒绝；按决定（`c2e2a5c2` 后），Docker 时期父版本一律以新 plan 在当前授权下重新验证、重新采用，Control Plane 不放宽；verifier 的 `creationReviews.history` 读取已就绪但保持休眠，仅供将来 native→native 原地交接使用；verifier 已有可选 `creationReviews.history` 消费者（`readRetainedCases` 按签名 head 解析历史证书并用旧公钥验签），但安装器尚未写入该字段、Control Plane 读取修订父版本仍只认当前 authority，端到端尚不可达；`pendingReverification` 尚无消费者，重新采用来自普通新失败任务；真实 owner Home 的完整 live Docker→native 切换、复制恢复与 native→native 仍未验收。真实模型复验（Linux，deepseek-v4.1-flash）前四次因预算或供应方故障未通过：封存、继承用量与真实路由每次都正常。第 1 次（`465ba29c` 前，作者输出上限 4096）写源码时撞上上限（`length`）；第 2 次（8192）在 Growth 120 秒 `maxDurationMs` 内未写完被中断（`interrupted-after-dispatch`）；这两次都没有提交源码作业，各 4 次真实调用。第 3 次（`1712b656`，仅测试把该场景 Growth 时限放宽到 300 秒）作者写完并提交了源码（单次 7,868 输出 token），共 6 次真实调用，但源码作业在入队检查时被判 `source-job-task-source-changed`（`source-jobs.ts` 中 `withJobSource` 抛出非“生产者不可用”错误），没有构建、审查与采用。根因已查明：作者依次调用 gaps、read、read、create、job_status，已用满冻结合同的 `maxModelCalls: 5`；第 6 次模型请求被 Growth 钩子以 `assistant-growth-driver-model-rejected` 拒绝并取消运行，运行记为 `unknown`，源码作业的任务来源 fence 只接受 `running`/`reviewed` 的运行，于是按设计判 `source-job-task-source-changed`。这是预算失败关闭，不是迁移或来源绑定缺陷；脚本场景只用 4 次模型调用所以不受影响。迁移的真实模型重新采用仍未实测，需把该场景的作者 `maxModelCalls` 提高到 6 后再验。原始证据在忽略的 `docs/evidence/sealed-real/`。 第 4 次（`b1347bf6`，仅测试把作者 `maxModelCalls` 放宽到 7、总上限 9）作者正确识别缺口 `work-item-task-repair` 并读取模板，第 3 次调用遇 LLMBox 上游 502（`provider_error`，EOF），Growth 记为 `review-incomplete`，共 3 次真实调用；属供应方瞬时故障，非预算或代码问题。累计 17 次真实调用；之后用户明确要求重跑（连通性已确认）。第 5 次（用户授权，`9beb746b`）作者走 gaps→read→create→job_status，用 5/7 次调用提交源码，但原生 `tsc --noEmit` 退出 2：`additionalProperties: { type: string }` 不符合 `ValueSchemaSpec`（要求布尔值），输出类型因此推成 `never`，handler 返回值再报错；create/submit 配额各 1，无法修复，且 Control Plane 通用 catch 把这次确定性失败记成 `unknown/source-job-interrupted`。修复（本提交）：隔离构建在精确 runner 合同下静止、非零退出且私有工作树清理成功时，作业落 `failed/source-build-check-failed`，并附有界脱敏诊断（插件相对路径的 `file:line:column`、TS 代码与消息，最多 20 条、尾部 12 行、每条 300 字符，去掉绝对路径与类密钥串）；中断、超时、不静止或清理未证实仍为 `unknown`。`plugin_source_job_status` 可在本次唤醒时限内带 `wait_ms`（≤240 秒）等待终态并返回诊断；同一 Growth 运行内对同一缺口和插件名最多 1 次修复，且仅在 Control Plane 已认证上次作业为 `source-build-check-failed` 时允许，修复作业照常经过入队检查（配额、生成截止、缺口状态）、原生构建与独立审查，第三次提交失败关闭。作者提示与工具说明补充了 `ValueSchemaSpec` 对象节点（`additionalProperties` 必填布尔，自由映射用 `{type:"json"}`）与 handler 返回 `Promise<InferValue<output>>` 的规则。真实场景仅在测试里把作者 `maxModelCalls` 放到 10、总上限 12（verifier 2）、source create/submit 配额 2、automations 并发 2（Growth 唤醒占一个槽，等待构建需要第二个）：首稿 gaps/read/create/job_status 共 4–5 次调用，修复 create 与收尾再需 2–3 次，留 2 次余量吸收重读；默认配置不变，仍是单次提交。第 6 次（`9e5bedb6`）修复回路实测有效：首个作业因 `tests/index.spec.ts` TS2345 落 `failed/source-build-check-failed` 并带诊断，作者据此提交的修复作业 `prepared`；独立审查发现、合同与 3 个用例均通过，但 contract 与 source review 共用 verifier 累计 `maxOutputTokens: 2048`，推理模型的 contract 用去 1179，review 只剩 869 且全部耗在推理上（`max-tokens`，无裁决），按设计失败关闭为 `unknown/verification-unknown`；共 9 次真实调用（作者 7、verifier 2）。修复（仅测试）：真实场景 verifier 累计上限 16384、时限 600 秒，仍是 2 次调用、审查语义不变，单测固定 review 拿到累计上限减去 contract 实际用量。第 7 次（`06226c74`）单个作业首次即 `prepared`，contract 用 3601 完成，但 review 剩余 12783 仍全部耗在推理上（约 5.5 万字符，反复权衡 README 与源码不一致，无正文），再次 `max-tokens` → `unknown/verification-unknown`，未到采用；共 7 次真实调用（作者 5、verifier 2）。探测确认供应方接受 `max_tokens` 32767。修复（仅测试）：真实场景 verifier 累计上限取配置上界 32768、时限 900 秒，用例时限 1500 秒，仍 2 次调用、审查语义不变。第 8 次（`d744c376`）作业首次 `prepared`，contract 用 1431 完成、3 个用例通过，review 用 6161 正常给出裁决 `rejected/source-review-rejected`：候选用普通 `{}` 累积，合法输入 `__proto__=x` 不会成为自有属性，返回对象缺该键，不满足“每个非空唯一键映射原值”。这是独立审查按设计拦下真实缺陷，不是预算或格式问题；未到采用、新会话调用与封存拒绝；共 8 次真实调用（作者 6、verifier 2）。随后（`dae2db48`）作者提示新增通用安全编码规则：以不可信输入为键的映射用 `Map` 或 `Object.create(null)`，结果经 `Object.fromEntries`/`Object.defineProperty` 构造，使 `__proto__` 等键成为自有属性；README 必须与代码行为一致；不向作者泄露审查结论或留出用例。第 9 次（`dae2db48`）作者 gaps→read→read 后，第 4 次调用在写源码前以 `max-tokens` 结束（单次 8192 输出上限，推理约 2.2 万字符），运行 `review-complete-not-adopted`，未提交源码作业；共 4 次真实调用（作者 4）。属作者单次输出预算失败，非审查拒绝；第 10 次（`628ad7ca`，仅测试把真实场景作者单次输出上限提到 16384，默认仍 8192）端到端通过（EXIT=0，约 634 秒）：作者 gaps→read×3→create→job_status→create；首个作业原生检查中 1 个 vitest 用例失败，落 `failed/source-build-check-failed`（诊断条目为空，仅标记截断：解析器只认 TypeScript 诊断，未覆盖测试失败；`bee2272c` 起同时提取 vitest 失败（`code: VITEST`，测试名路径与首行错误、测试文件内首个栈帧位置），`5021c2ea` 同步作者修复提示），修复作业 `prepared`，plan `source-c034e7ca-c355-4d21-bc27-7e76588537ca`；独立审查 contract 2463、review 15559 输出 token 后 `approved`，签发 v3 证书（`linux-native-process-seccomp-v1`）；新 plan id 采用、新会话调用 1 次完成、封存 id `sealed-docker-normalize` 保持拒绝。共 10 次真实调用（作者 8、verifier 2），输入约 98.2k、输出约 35.1k token。迁移的真实模型重新采用至此实测通过；无需第 11 次。封存工具重放（`827dc60a`）停在 S1：`readSealedReverificationSource` 校验签名 `proofDigest`、`pendingReverification` 成员、0400 归档身份/字节/摘要、归档行摘要、旧公钥签名与源码绑定后，只读返回原 README/src/tests，不授予采用。S2/S3 不接线，原因有三：原缺口仍挂着原候选 id，无法再次使用；原 Growth 运行的生成窗口已过，重放需要新的准入路径；新 plan id 可能与封存行同名，需先定义命名隔离。`5644ebc4` 起封存读取只在 `-wal` 与 `-shm` 同时存在时按活 WAL 打开，单独 sidecar 或热 `-journal` 拒绝，双端精确根检查通过。
3. Router 跨信道协调、订阅直通和长期普通使用收益尚未完整验收。已交付两个前置切片（`1b8f4b0a` 双端根检查通过）：只读 linked owner alias，只允许 work-items 查看（list/recall），不允许续办，每次检查双读比较 digest 并绑定链接版本；创建能力普通使用报告 `inspectCreatedCapabilityOrdinaryUseReport`，按模型分层、样本不足时标记不足，明确非因果。别名读取已改为主人显式名单（work-items `ownerRecall.linkedAliases`，默认无名单即拒绝，Delivery link 与未限定 principal 的 Policy 规则均不足以授权）。撤销 owner 现会使其 link 失效，同一 record 重新激活须重新 link；别名读取按 principal 在 Policy 独立预算分区计费（`authorizeAgentForPrincipal`），不再消耗主人额度，且要求规则带预算。第三个切片：`inspectCreatedCapabilityAvailabilityAttribution`，以采用时间为界、全 scope 当前认证前台任务的等长前后窗意向处理归因，按冻结模型分层给精确达成率差，跟随更正、排除撤回，scope writer fence 内重读比对，并发采用仅标记；仍为观察性 `causal: false`，未消除时间趋势，无真实模型数据。第四个切片：跨信道报告路由（work-items `ownerReportRouting.linkedFallback`，默认关闭），origin 优先，仅 origin 不可用时由 Delivery `routeWorkItemReport` 投到主人列出的已 link 别名，记录绑定链接版本、撤销/重新 link 后不发送，别名回复只能查看不能续办。第五个切片：只读 `inspectCreatedCapabilityOrdinaryUseTrend`，按固定窗（默认 7 天）纵向观察单个采用，以同 scope 未使用该能力的会话为对照，按冻结模型分层给 DiD 估计与简单区间，平行趋势可疑即标 `parallel-trend-suspect`，仍为 `causal: false`；单会话 owner DM 无对照组。真实模型 Web 普通使用 e2e（Linux LLMBox，`9beb746b` 起，两轮共 127 次调用，证据仅本地）：event 通过；real-skill run7 通过（Host 重启后 `skill_run` 回放先读观察再写，独立验收回执刷新后可回读，根因是测试 allowlist 缺 `read`）；real-capture run3 通过（自动采集→候选→单次试运行→独立验收→owner 激活；修复 `skill_trial` 成功后结束本回合并只指引 `skill_activate`，此前模型在试运行回合继续调 glob 致激活被 proof gate 拒绝），skill_activate 原始结果未留存，仅有 session-audit `isError:false` 与 proof 记录；canary/repair/topology 因缺 traex 预检拒绝未跑。现有持久任务不代表完整自主工程成长；旧五次真实模型额度已用尽、不重置，新实验仅用 LLMBox 有界预算并本地留证。
5. 主动进化（Superagent 原型融合，2026-11-05 只读评审）：验收见合同 WP19–WP22。顺序为注意力合同 → 统一 intake 与 observe 影子判断 → 决策准入 WorkItem → 注意力结果回流学习；不新增 Loop/timer，不连活飞书。WP21 第 1 片（WorkItems `admitDecision` 冻结 Mandate 准入，无 schema 变更）与第 2 片（host-only Policy 变更通知、工作线程跟进归属与结束释放，仅事件行、无 schema 变更）已交付；独立审查后身份改为只取 decisionId（换 kind 不再开第二项），规则不符先经无副作用 `evaluate` 拒绝、不扣 Policy 预算。WP21 第 3 片（`994422b9`）：显式 `intakeLedger.evaluation.admit`（默认关）让 WP20 accept 的 inferred 候选成为 `admitDecision` 首个调用方，decisionId 由 source+eventId+ruleId+policyVersion 确定性派生，observe 只记 would-admit，auto 按小时预算准入，拒绝/错误终态带原因码不重试，只搭既有 scheduler wake；WorkItems schema 12 新增只追加准入表。WP21 第 4 片（`fd2a40c9`，审查修复 `6ece4319`）：execute 决策可带 `acceptance: {contractId, contractDigest}` 句柄，WorkItems 经 `assistantVerifier.inspectAcceptedTask` 回读合同，仅接受 `awaiting-execution`，一个合同只绑一个工作项，摘要 `work-items/acceptance-binding/v1`；host-only `settleAcceptance(itemId)` 读 verifier done 回执记 `acceptanceVerdict`，首个回执生效，合同漂移或回执早于工作项创建判 drift，须先过存储基线且 attempt≥1、state `ready`，仅追加事件行，schema 仍 12。限制：裁决只是事件不改状态，`settleAcceptance` 无触发器，生产代码尚无调用方传句柄，仍无 Delivery 调用方。WP19 调用方声明（`339c1dc3`）：仓库内全部后台/owner 通知与 WorkItem 报告调用方显式声明 `result`，AST 守卫测试扫描 `plugins/*/src`、`packages/*/src`，未声明或把通知方法当回调传走即失败；`attentionEnforce` 仍默认关，是否默认开启待定。 WP22 切片 1：Delivery 只读通知结果事实适配器 + Evaluation schema 14 按通知 id 的可修订结果账本（delivered/reacted/accepted/rejected/expired-unhandled/failed/pending），默认关闭，搭既有 projection tick，只读消费。WP22 切片 2：Evaluation schema 15 只收紧的注意力参数版本链（有界一步提议、 默认关、观察期负向率超阈回退精确父版本、放宽一律拒绝），Proactive remind 结构化叠加，缺席零行为变化。WP22 切片 3（`ee4b760c`）：Evaluation schema 16 放宽类经密封留出重放（通知 id 哈希取模 4 划分、提议时冻结留出 digest、提议器只读训练集，父版本与候选比较误报/漏报）后，仅在 owner 一次性授权（上下界、单步、次数、到期）内自动采用，额度回退不退还；超出时只记录结构化 owner 问题（不发送）；`attentionLooseningEnabled` 默认关且须同时开 `attentionTuningAutoAdopt`。WP22 切片 4（`78cfa702`，审查修复 `57e9b63c`、`cb7b8e3c`）：Evaluation schema 17 只追加投递与回复账本，结构化 owner 问题经 Delivery 最多投递一次（幂等键 `attention-owner-question:<id>`，purpose `result`），`attentionOwnerQuestionDeliveryEnabled` 默认关，须同时开 `attentionLooseningEnabled` 并配置 `attentionOwnerQuestionOwner`；通知文案不含回复指引，回复只记录不生成 grant，关闭或过期的问题拒收回复；问题关闭或过期时发送前撤回（转 dead），撤回权由 ctx 槽位担保的 authority 绑定，Delivery 发放随机 handle，入队与只读 `inspectOwnerNotification` 均须出示，未担保或失效 handle 失败关闭（保持 retry_wait 至到期），owner 重启后重新登记可接管已排队通知；Web 通知列表不受撤回影响；schema 17 打开与迁移时与参照 DDL 比对，漂移拒绝。限制：撤回只在发送前有效、登记仅在内存；幂等键跨来源共享，他源抢占同键时问题停在 `enqueue-failed` 至到期（不发送、不被采纳）；回复入口仅 Host API；依赖 WP20 的 intake 吻合度未接。WP04 families 真实模型实验（Linux LLMBox，`47853217`，54 cell/54 次调用，证据仅本地）：candidate 18/18、baseline 16/18、no-review 16/18（Δ −0.111，区间 [−0.333, 0]），失败来自格式与题面歧义（`service-b` 对 `B`）；无 holdout，隔离检查 0 次调用；样本小，不构成提升结论。
4. 用户已延后飞书机器人实连和后续真实使用验收；正式连接门保留。完整临时双服务升级、就绪、回滚及活 Home 切换未验收，暂不操作活服务。活 owner Home Docker→native 第 8 次更新在 relocation 拒绝（"relocation target already exists"：原地暂存 Home 本就带 owner 的 `rsi-authorities/<profile>`）；`846b2856` 改为原地暂存只要求 behavior family 不存在、并要求 authority 与 `state` 目录私有，活 Home 未变、服务仍 active。切换已可重跑，但按当前目标延后。Linux `$HOME` 下 40 个旧 dsh 隐藏目录（24 个旧 `transaction.failed-*`、手工/测试遗留，约 87 GiB）已 `mv` 归档到 `~/.local/state/dsh-enhanced/archive/20261106/home-dotfiles/`（含 `MANIFEST.tsv`），活 Home、锁、rollback-readiness 与 owner-predecessor 恢复依据、最新 failed 目录及产品缓存保留原位。

本地与远端项目均只保留主 `dev` checkout，`main` 分支保留；旧 worktree 的修改、暂存成果和证据已保全，归档候选未全部整合。未发布、未合入 main；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

最近三个切片的双端精确根检查结果（更早切片保留在 `docs/evidence/verification-<sha8>/`）：

| 精确提交 | 环境 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `120d802a`（39 包，WP21 第 4 片 acceptance 绑定 `fd2a40c9`/`6ece4319`、WP22 第 4 片 owner 问题经 Delivery 投递 `78cfa702`/`57e9b63c`/`cb7b8e3c`、lark-channel 关 FORCE_COLOR `8dae8136`、writer-fence worker 补 attention-owner-questions 模块） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1130.28 秒（`c2e15da8` 因会话 FORCE_COLOR=3 失败，`8dae8136` 修复；`cb7b8e3c` 因 writer-fence worker 缺新模块 4 例失败，`120d802a` 修复） | 10,951 / 1,931 | 752 / 85 | `f4352e3ccc5a250245bf26ab8f2a673708c3a446c3c9624a56d9e9f90afeb4e3` |
| `120d802a`（39 包，WP21 第 4 片 acceptance 绑定 `fd2a40c9`/`6ece4319`、WP22 第 4 片 owner 问题经 Delivery 投递 `78cfa702`/`57e9b63c`/`cb7b8e3c`、lark-channel 关 FORCE_COLOR `8dae8136`、writer-fence worker 补 attention-owner-questions 模块） | Linux / Node 24.7.0 | EXIT 0，独立 PASS，2430.83 秒 | 12,568 / 311 | 805 / 32 | `2464e5da2c0f674e4b1950316a045d09b860a6b17e565226239ed8f3363e2bea` |
| `cd3b3435`（39 包，Router 跨信道报告路由 + /new 后保持 origin、WP19 第 3 阶段 attention 前置拒绝、WP20 第 3 阶段 observe 评估 + 落库重试/退避、普通使用纵向 DiD 趋势） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1130.37 秒（attempt r2；attempt 1 因 pnpm 依赖校验失败） | 10,860 / 1,928 | 746 / 85 | `a4066d2101b69ebe7adb2861f4abfbda8f92fb13344cd25e3a01f62313996385` |
| `cd3b3435`（39 包，Router 跨信道报告路由 + /new 后保持 origin、WP19 第 3 阶段 attention 前置拒绝、WP20 第 3 阶段 observe 评估 + 落库重试/退避、普通使用纵向 DiD 趋势） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2423.09 秒（attempt r2；attempt 1 为负载下 lease-loss 用例偶发超时，测试已由 `918ef8f9`、`0f527f9b` 固定 Host lease 时钟） | 12,474 / 311 | 799 / 32 | `5777b0026d2b33a2b8c627a55c8b4ddb27f31b4704aa421557096599e8a01715` |
| `7f6db83a`（39 包，vitest 失败诊断 `bee2272c` + 修复指引 `5021c2ea` + plugin-setup TS2352 修复 `f785654d` + writer-fence worker 补 WP22 账本模块） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1109.02 秒（attempt r2；attempt 1 因集成克隆缺被忽略的 node v24 固件失败） | 10,785 / 1,928 | 742 / 85 | `afda690690eddabe82cfa3d6ec5557f701f4121461d5831fc569628a0b704958` |
| `7f6db83a`（39 包，vitest 失败诊断 `bee2272c` + 修复指引 `5021c2ea` + plugin-setup TS2352 修复 `f785654d` + writer-fence worker 补 WP22 账本模块） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2423.02 秒 | 12,399 / 311 | 795 / 32 | `115f3d63013701a9a2651cc4ced99c942212e678eb0fe76ede3348ca428b36f4` |

两端覆盖 manifest、零警告 lint、包构建与类型检查、测试组及唯一 dry-run pack（39 包 / 40 测试组）；源码前后同一提交且工作树干净。Linux 用 `TMPDIR=/data00/home/jiataorui/t`；准确命令与结果见对应 `docs/evidence/verification-<sha8>/`。成长切片 `d8c9fdd2` 的双端结果与早期控制台切片日志也保留在 `docs/evidence/`。Linux attempt 1 的失败是缺少测试运行时环境，已保留。跳过项、真实模型/Bot、活服务升级与长期收益不计为已验收。
