# RSI 当前状态

更新：2026-11-03。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始证据在忽略的 `docs/evidence/`。

当前未提交现场的唯一接手入口：`docs/evidence/handover/CURRENT.md`。开发写入及测试已停止；先核对该入口的源码清单，再续做下一步。

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

`@dsh-enhanced/owner-console` 已提交 `dev`，精确提交 `da5f8d42` 通过双端根检查。左侧栏「控制台」入口 + 一页面板，设计沿用 Superagent 原型的注意力预算（一页、只显示需要人处理的事）。当前能力：

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

实现要点：`lark-channel`/`traex-acp-provider` 只在 owner 可编辑字段上标记 `.volatile()`，并在 schema 边界接受 volatile 引用、输出纯值；`lark-channel` 用 `secretSource` 在 callable 与 `~standard` 两条验证路径上屏蔽未选引用，并让非法配置 fail-soft（记录后保持 disabled，不炸 Loader 树）。飞书面板配置的是 `lark-channel` 通道；lark-cli 只是可随时安装的独立 skill，本插件既不调用它、
不依赖它，也不管理其路径或安装。面板用单选决定 secret 引用方式，提交时只发送选中的那一个引用；
项目 bundle 可启用/停用/移除（移除仅对 removable 且非自身、且需浏览器确认）。
typert 参数顺序与 Host 方法签名对齐并有回归断言；Web client 构建产物通过 `__ModuleLoader__` 契约测试。

该切片经过多轮独立 harness 复核（真实 Cordis Loader/Include、`dsh-settings`、`config-editor`、
`plugin-manager`）：逐项验证 describe/mutate/重启/双模式切换、bundle 与条目启停、安装转发与拒绝边界，
并修正了页面把 `restart-required` 当成失败的问题；导航快捷入口再经一次静态复核（APPROVE，确认
`layout`/`uiWorkspace` 服务与入口 id）。复核和根检查还暴露并修复了三个稳定性缺陷：`usage-runtime`
假时钟跨分钟边界会多认领一次 usage-scan、isolation 归档 CLI 对实时写入源账本的大小断言过严、
WorkItems 原生 fixture 用等待代替显式信号 sweep 导致准入超时。三处修复后各自连跑 3~15 次稳定。

尚未完成：插件卸载与从面板选择任意 registry 源（出于安全只允许本项目包名）、真实飞书长连接验收
（按用户要求延后，未连活 Bot）。lark-cli 不在本插件范围内，其安装/配置由 owner 自行通过 skill 完成。
远端真实使用验收仍由正式连接门保留。

## 待办与延后验收

1. 对新控制台插件切片 `9e004c50` 跑双端精确提交完整检查；此前工程成长切片 `d8c9fdd2` 已双端通过。Linux 大测试、缓存和证据使用 `/data00`，启动前核对实际文件系统；旧系统盘测试数据已校验归档迁出，运行服务未变。
2. 非空 review 历史 CAS/封存已有组件专项；installer、Host head、运行时消费者及非空 adoption 迁移资格仍缺。旧 Docker 证书不能作为 Linux 资格；owner 升级的空业务采用 CAS 不代表非空迁移、复制恢复或 native→native 已支持。
3. Router 跨信道协调、订阅直通和长期普通使用收益尚未完整验收。现有持久任务不代表完整自主工程成长；两端此前五次真实模型运行额度已用尽，不重置失败或预算。
4. 用户已延后飞书机器人实连和后续真实使用验收；正式连接门保留。完整临时双服务升级、就绪、回滚及活 Home 切换未验收，暂不操作活服务。

本地与远端项目均只保留主 `dev` checkout，`main` 分支保留；旧 worktree 的修改、暂存成果和证据已保全，归档候选未全部整合。未发布、未合入 main；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

以下结果覆盖工程成长切片：精确实现 `d8c9fdd2e07284ab6fcd89b5dbc5d369211a9f3d`，tree `eef5361d0647dd8095eec368f2786aa89d4dd061`。

命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm_config_verify_deps_before_run=error pnpm check`，pnpm 11.7.0；先核对并清理 38 包生成目录，保留根脚本默认 15 秒测试超时。Linux 调用前另需 CI 的 `DSH_TEST_PNPM_ROOT`（原生 `@pnpm/exe@11.7.0`）与指向已有 store 的 `pnpm_config_store_dir`，否则 release/lifecycle 两组 Linux 专用测试因缺少测试运行时失败。

| 精确提交 | 环境 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `d8c9fdd2`（38 包） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1081.58 秒 | 10,286 / 1,925 | 702 / 85 | `3029392783e7959812a75b8a03ac2f6f576e66e422f520c4a57b9977768a54bd` |
| `d8c9fdd2`（38 包） | Linux / Node 22.23.2（attempt r2） | EXIT 0，独立 PASS，2412.67 秒 | 11,899 / 309 | 755 / 32 | `9abc8f72ade4375626365982197d617e7050a626b0d31a79057327c0b767d1cf` |
| `94b86b61`（39 包，含控制台） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1087.85 秒 | 10,291 / 1,925 | 704 / 85 | `bb5a38c946f2b485ccad93355f0f2d28d6e5a228ddafd53769e7da6cea2a24d3` |
| `94b86b61`（39 包，含控制台） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2404.48 秒 | 11,904 / 309 | 757 / 32 | `dea2dd242f9e0685b15170f9185e62e04ed49341d79d8d07a5b0efa906f7783c` |
| `da5f8d42`（39 包，控制台配置切片） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1088.69 秒 | 10,298 / 1,925 | 704 / 85 | `f970b4bb04f1909035adb407decd082055443bf3a89124bb2378dfeb7aec4ee3` |
| `da5f8d42`（39 包，控制台配置切片） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2447.74 秒 | 11,911 / 309 | 757 / 32 | `7de6f6499152e3b0993c5333117aa67c98234cabefb7db2d0e9cd48da8f41c4a` |
| `124a52a1`（39 包，管理与稳定性切片） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1078.29 秒 | 10,299 / 1,925 | 704 / 85 | `1cb290d3fe62ba3130cb787c18bbaa1cd88198c4d5a64f2a5291baa9fb6d8acc` |
| `124a52a1`（39 包，管理与稳定性切片） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2402.39 秒 | 11,912 / 309 | 757 / 32 | `db64489406a869403ee5528a1ecc683abe4c18e23e4537459f7805510c8e90b0` |
| `2c295a40`（39 包，侧栏对话入口切片） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1192.69 秒 | 10,299 / 1,925 | 704 / 85 | `f22f854e017dc819cc09d152820759f2ffa32ca36c3286756066039da7be5838` |
| `2c295a40`（39 包，侧栏对话入口切片） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2398.93 秒 | 11,912 / 309 | 757 / 32 | `6f6d7497f4e44185f153ed211e283f4241e041d370965369018e9d332beefea5` |
| `4b78dc68`（39 包，通道语义与 RPC 对齐） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1248.46 秒 | 10,301 / 1,925 | 705 / 85 | `b82051454ba494b547b6fa48754e9a366cf0bc4d143dd6965fd55156294f2bb7` |
| `4b78dc68`（39 包，通道语义与 RPC 对齐） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2412.75 秒 | 11,914 / 309 | 758 / 32 | `17d5b7e25bc80b7e17039cbec74745feecca54386986867aaf1aab496e7232c9` |
| `cea6beb1`（39 包，单选 secret 与移除门控） | Mac / Node 26.11.1 | EXIT 0，独立 PASS，1178.01 秒 | 10,302 / 1,925 | 705 / 85 | `aed769ac988176f7983ac1842d3d49cd5f18c880da64d7a8b1645e7aaebdaed6` |
| `cea6beb1`（39 包，单选 secret 与移除门控） | Linux / Node 22.23.2 | EXIT 0，独立 PASS，2428.17 秒 | 11,915 / 309 | 758 / 32 | `7c7b7114c8403f80d8846e95bb9ba33715a5e5c1a7351d9b00326cf32c1fc261` |

两端覆盖 manifest、零警告 lint、包构建和类型检查、测试组及唯一 dry-run pack（38 包时 39 测试组；39 包时 40 测试组）；修改涉及的公开产物逐项核对入包，源码前后同一提交且工作树干净。Linux `TMPDIR=/data00/home/jiataorui/t`。准确命令与结果见 `docs/evidence/verification-d8c9fdd2/`、`docs/evidence/verification-94b86b61/` 、`docs/evidence/verification-da5f8d42/` 、`docs/evidence/verification-124a52a1/` 、`docs/evidence/verification-2c295a40/` 、`docs/evidence/verification-4b78dc68/` 与 `docs/evidence/verification-cea6beb1/`；Mac 原始日志在本地，Linux 原始日志留在远端同路径。Linux attempt 1 的失败原因是缺少测试运行时环境而非产品缺陷，已保留。跳过项、真实模型/Bot、活服务升级和长期收益不计为已验收。
