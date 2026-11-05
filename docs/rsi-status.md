# RSI 当前状态

更新：2026-11-04。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始证据在忽略的 `docs/evidence/`。

当前接手入口：`docs/evidence/handover/CURRENT.md`。先核对该入口的源码清单，再续做下一步。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；通过持久任务、原生 Agent、独立验收和有限采用，减少用户管理上下文与逐步协调的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，发布验收通过后才合入 `main`。

## 已交付能力与边界

- Linux 原生隔离、源码 prepare、工具创建/修订、独立验收及 owner 升级事务已有实现。普通 autonomy 安装、Web setup/doctor 已接通 native 资源；重复 setup 保留身份、原期限和已用额度。Linux x64/cgroup v1 已实测；cgroup v2 拒绝，arm64 未验收。pre-owner 资源迁移已有双端根检查，不能代替 live owner 升级。
- 原生 Goal 已贯通真实 Cordis/Loader/NativeWeb/AgentLoop、产物绑定及独立 Linux 验收。正确产物得到 achieved，退出码为零的错误产物被拒绝；冷账本和资源清理已独立核验。供应商为本地脚本，不证明真实模型或任意任务能力。
- WorkItems 默认关闭、observe 模式；持久准入、认领、报告和有界 resume 已实现。显式 diagnosis 使用冻结 supplier、权限和有限预算执行只读诊断；只在准确 occurrence 成功且结算后续办，unknown 不自动重放。主人前台 `work_item_list` / `work_item_recall` 按 owner lineage 过滤并支持跨会话分页召回，不恢复旧授权或额度。
- 显式 `ownerReplyContinuation` 接通真实报告回复、持久子项与原生续办；先保存子项再 ACK，ACK 前不派发。显式 `ownerReportFeedback` 将准确 owner 结果回复接入 Evaluation，更正、撤回及丢 ACK 按原操作对账。Delivery schema 30、Evaluation schema 13、WorkItems schema 9；报告入队不代表外部送达，owner testimony 不等于独立技术成功。
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
2. 非空迁移资格（Docker→linux-native）已交付：`a45eac07` 封存迁移 + `68e4d8b3` Linux `NODE_PATH` 修复 + `c9ef3bd4` 仅测试的真实模型验收准备。非空采用历史只读归档（0400）后清空活账本，旧用量作为继承用量计入上限、不退还；Docker 时期 active 工具只能以新 plan id 与新 native 证书重新采用，原 plan id 被拒绝；审查库用 v2 grant handoff 原地交接，保留 `used`/`maximum` 与全部 verification 行。归档写入与事务中崩溃均可重试（WAL 与回滚日志两种残留）；整张审计表被删在 verify 时被拒；Host 更新在链上含封存 handoff 时拒绝，直到它能自行携带封存证明。限制：交接前签发的审查证书切换后仍被当前授权检查拒绝，需等运行时 `resolveHistoricalCertificate` 接入；`pendingReverification` 尚无消费者，重新采用来自普通新失败任务；真实 owner Home 的完整 live Docker→native 切换、复制恢复与 native→native 仍未验收。下一步：Linux 上 deepseek-v4.1-flash 封存工具重新采用实测（≤7 次调用）。 真实模型复验（Linux，deepseek-v4.1-flash）三次尝试均未通过，本场景不再追加真实调用：封存、继承用量与真实路由每次都正常。第 1 次（`465ba29c` 前，作者输出上限 4096）写源码时撞上上限（`length`）；第 2 次（8192）在 Growth 120 秒 `maxDurationMs` 内未写完被中断（`interrupted-after-dispatch`）；这两次都没有提交源码作业，各 4 次真实调用。第 3 次（`1712b656`，仅测试把该场景 Growth 时限放宽到 300 秒）作者写完并提交了源码（单次 7,868 输出 token），共 6 次真实调用，但源码作业在入队检查时被判 `source-job-task-source-changed`（`source-jobs.ts` 中 `withJobSource` 抛出非“生产者不可用”错误），没有构建、审查与采用。该拒绝的根因尚未诊断，可能是测试编排与任务来源绑定的交互，也可能是真实缺陷；在查清前不计为迁移已实测。原始证据在忽略的 `docs/evidence/sealed-real/`。
3. Router 跨信道协调、订阅直通和长期普通使用收益尚未完整验收。现有持久任务不代表完整自主工程成长；两端此前五次真实模型运行额度已用尽，不重置失败或预算。
4. 用户已延后飞书机器人实连和后续真实使用验收；正式连接门保留。完整临时双服务升级、就绪、回滚及活 Home 切换未验收，暂不操作活服务。

本地与远端项目均只保留主 `dev` checkout，`main` 分支保留；旧 worktree 的修改、暂存成果和证据已保全，归档候选未全部整合。未发布、未合入 main；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

最近三个切片的双端精确根检查结果（更早切片保留在 `docs/evidence/verification-<sha8>/`）：

| 精确提交 | 环境 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `c9ef3bd4`（39 包，封存迁移 + 实测验收准备） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1201.19 秒 | 10,431 / 1,927 | 714 / 86 | `54d818c30850ec7c4f810aee343f34e9ca73cd68648626ea9ebabf649640e1c0` |
| `c9ef3bd4`（39 包，封存迁移 + 实测验收准备） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2445.28 秒 | 12,044 / 311 | 767 / 33 | `cc3dba6ccdfbfedc0a40fc10bf4c1ee4577e6cd7ccdcfc01abd8e80cd0f6dbc2` |
| `98e7916f`（39 包，历史分类与封存元数据） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1235.16 秒 | 10,320 / 1,925 | 707 / 85 | `e4890526ed66082996126b249860d7952afb199dae31d9b871ed49feffce96af` |
| `98e7916f`（39 包，历史分类与封存元数据） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2428.32 秒 | 11,933 / 309 | 760 / 32 | `b4df5340064d45a4195819ef77747bda3c81da54dfb4fe77695f8a08b4adc53b` |
| `4b7d8b80`（39 包，健康枚举契约测试） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1202.12 秒 | 10,308 / 1,925 | 706 / 85 | `0fc6fa526a026fd9942d6109b6e484447e72585ac7f37a7ae15faa22ad92e740` |
| `4b7d8b80`（39 包，健康枚举契约测试） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2415.21 秒 | 11,921 / 309 | 759 / 32 | `506e718f7113a877c18473d357a1f33ce2095e9311ff005a8f8329ea24a240c1` |

两端覆盖 manifest、零警告 lint、包构建与类型检查、测试组及唯一 dry-run pack（39 包 / 40 测试组）；源码前后同一提交且工作树干净。Linux 用 `TMPDIR=/data00/home/jiataorui/t`；准确命令与结果见对应 `docs/evidence/verification-<sha8>/`。成长切片 `d8c9fdd2` 的双端结果与早期控制台切片日志也保留在 `docs/evidence/`。Linux attempt 1 的失败是缺少测试运行时环境，已保留。跳过项、真实模型/Bot、活服务升级与长期收益不计为已验收。
