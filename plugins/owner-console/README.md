# owner-console（文鳐 Ray）

个人助手「文鳐」（英文 Ray，小名小鳐；口号「小鳐小鳐，游而化飞」）在 DeepSeek Harness 左侧栏的
单一入口，即原来的「控制台」（主人控制台）；面板标题显示助手的名字与口号。改名只影响显示，包名、插件 id 与条目 id 仍是 `owner-console`。设计沿用
[dsh-superagent-prototype](https://github.com/22-ai-00/dsh-superagent-prototype) 的理念：
注意力是预算，只在被请求或书面规则允许时行动；只说需要人行动的话；一次一个问题；概念和设置尽量少；
面板只展示需要人处理的事。

当前切片：**文鳐专属个人助手对话窗口 + 分类优化设置页**。

- **文鳐专属对话窗口**（左侧栏「文鳐」的默认视图）：独立于 DSH 原生编码界面的 `conversation.content`，由 `src/chat-view.ts` 提供专属个人助手体验：顶部显示文鳐身份徽章与已加载能力胶囊（记忆 / Wiki / 飞书），不暴露内部工作区路径（助手工作区固定默认 `$DSH_HOME/assistant-workspace`），支持一键开启「新对话」与打开 ⚙ 设置；内置同 `/model` 的级联模型与 Effort 下拉切换条、权限预设开关、推荐开场白、Markdown 代码块渲染与复制、流式预览、附件上传及浏览器语音转写/朗读；并在输入框中支持 `/version`、`/autonomy version` 及「查看版本」「自己迭代了多少次？」等受限自然语言版本/自迭代次数本地即时查询（通过只读 `ownerConsole/versionInfo` RPC 返回结构化 Markdown 摘要，不消耗额外模型回合；自由表达的版本与迭代次数询问由已授权的 `owner_console_version_info` Host 工具处理）。底层仍直接复用 DSH 宿主 `sessions` 持久事件日志与 agent loop（不自建第二套 loop），且仅对文鳐助手注册表记录的会话在 `$DSH_HOME/assistant-workspace` 中注入 `owner-console:wenyao-persona` 身份提示，零干扰 DSH 原生编程对话。
- **设置页与 DSH 原生设置槽**（右上角 ⚙ 及 DSH 左侧设置弹窗 `wenyao-assistant`）：按「全部 / 体检自愈 / 模型与工具 / 自主与成长 / 飞书与插件 / 只读诊断」分组浏览 `src/settings-cards.ts` 卡片，提供一键体检自愈、`/model` 级联模型/Effort 与 CLI 路径下拉选择器、自主能力一键授权向导与飞书极简安全接入。除「文鳐」⚙ 设置页外，
  客户端还向 DSH `0.2.2-rc.5` 注入原生设置扩展槽：左侧栏设置分组 `settings.section` / `settings.section.icon`
  （「文鳐助手」）、通用设置一行快捷切换 `settings.general.item`（默认编程工具 `TraeX` / `Antigravity` /
  API 路由）、模型设置页脚 `settings.models.footer`（本地 ACP 就绪探测与默认路由切换），`settings.models.provider-card`（`dsh-enhanced-traex-acp-provider` 的模型/Effort/CLI 一键绑定），以及插件管理详情/摘要
  `plugins.bundle.config`（覆盖 `traex-acp-provider`、`lark-channel`、`assistant-proactive`、`assistant-dreaming`、
  `assistant-growth-driver`、`assistant-memory-learning` 6 个 `@dsh-enhanced/*` bundle）。
  配置写入只经 Host `settings` 服务合并到指定条目；bundle/条目管理与安装只经 Host `pluginManager`；
  本机 CLI 探测与 `/model` 目录聚合（`modelCatalog`）均只读无交互、不发起付费推理，受每 provider 6 秒超时与 30 秒 TTL 缓存保护。安装会把 pnpm 子进程和 registry 网络调用委托给
  DSH 自身的 plugin manager，不在本插件里实现网络或进程逻辑。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/owner-console
dsh --profile web --dump-config
```

安装由 DSH 的 pnpm 路径完成，本包声明的运行依赖（`@deepseek-ai/schemastery`、`zod`）随包安装；
Host 侧的 `typert` 与 Web 侧的 `react` 由 DSH 提供。安装后左侧栏出现「文鳐」入口，点击进入
对话窗口；首次打开会在默认工作区创建/复用一条专用会话并在浏览器里记住 id，之后继续同一会话。
面板不显示工作区、文件目录或会话目录；需要完整原生视图时点右上角「原生会话」，需要配置、
飞书 / TraeX 或插件管理时点 ⚙。

### 对话窗口的实现边界

- **会话生命周期与工作区隔离**：客户端调用 `ownerConsole.assistantChatContext()` 解析专属工作区（优先已配置的 owner 工作区，默认 `$DSH_HOME/assistant-workspace`，绝不借用软件安装/profile 配置目录或混入用户的开发仓库），调用 `sessions.create({ cwd })` 创建会话后经 `ownerConsole.registerAssistantSession(sessionId, true)` 绑定登记，再 `sessions.retain(id, { source: 'ownerConsoleChat' })` 取得持久流；浏览器侧 id 存放在 `localStorage['dsh.owner-console.assistant-chat-session.v2']`。Host 侧由 `systemPrompt.section('owner-console:wenyao-persona')` 按 session id 严格作用域注入文鳐身份，非注册编码会话返回空串 `''`，对普通编程对话零影响。
- **专属正文与工具栏**：`OwnerConsoleChat` 自包含渲染独立助手消息流（`renderChatMarkdown` 纯 React XSS 安全渲染）、代码片段复制、工具状态徽章、流式回复预览、模型与 Effort 级联 `<select>`（通过 `remote.session.selectModel` 热切，若目标 ACP 路由尚未开启则在保存默认路由后重试）与权限 `/permission <preset>` 命令切换；`OwnerConsoleConversation` 仍保留导出以维持历史子槽合约兼容。
- **语音与附件**：浏览器 `SpeechRecognition` / `webkitSpeechRecognition` 识别文本写入文鳐输入框，`SpeechSynthesis` 用于可选朗读；附件通过 `fileUpload.upload` / `uploadImage` 上传至当前会话后以 `{ type: 'file', receiptId }` 发送，服务缺失时显式告知限制。
- **权限目录**：可选权限预设读取 `remote.permissionPresets.catalog()`；高风险权限（`danger-full-access` / `auto`）仍需面板内二次确认后下发 `/permission`。
- **助手会话登记文件安全**：`$DSH_HOME/owner-console/assistant-sessions.json` 按 `0o600` 原子写入且拒绝符号链接（最多保留最近 32 条会话 id），仅用于隔离 `wenyao-persona` 注入作用域与续聊默认打开，不含消息正文或秘密凭据。

### 设置页（⚙）与左侧栏「文鳐助手」设置分组

设置页与 DSH 原生设置的「文鳐助手」分组共用以下配置卡片：

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| 自主能力一键开启向导（`AutonomyWizardCard`） | 基于当前激活的 Web 或飞书 owner 路由，一键授权、切换档位（`conservative` / `balanced` / `custom`）、选择默认模型或 `traex-agent` / `agy-agent` 路由并生成三权分立授权，或执行安全暂停（做梦保持 `enabled: true` + `retired: true`，成长安全关闭含子开关）与停用 | `autonomySetupStatus` + `configureAutonomySetup`（读只读 SQLite 与原子备份写 `cordis.patch.yml`） |
| 版本与自助升级（`SelfUpgradeCard`） | 检查当前包与 Host 版本及在线/离线最新可用版，预览升级计划（`--dry-run`），在受控 Linux systemd 下阻断应用内热改并给出 CLI 命令，在本地/macOS 二次确认后以后台无 shell 进程启动 `dsh-rsi upgrade --yes` | `checkSelfUpgrade` + `dryRunSelfUpgrade` + `runSelfUpgrade`（`src/upgrade-probe.ts`） |
| 编程工具与默认模型 | `traex-acp-provider` 条目中的 TraeX (`traex-agent`) 与 Antigravity (`agy-agent`) 开关/命令、`agent-default-model` 默认路由切换、无交互本机 CLI 就绪探测与修复提示 | `settings.describe` + `agentDefaultModel` + `llm` + `probeCodingTool` |
| 远程接入（飞书） | 接入方式、`lark-channel` 条目、连接状态（`larkChannel.health()` 快照）、appId 是否配置；支持一键官方扫码接入授权（RFC 8628 设备授权，自动加密存入系统凭据库并同步通道/消息策略）、扫码完成后三步一键向导（确认/一键设为主主人、一键重启生效、开放平台与私聊验证）、手动输入凭据入库、环境变量引用或 keychain handle 引用 | `settings.describe` + `larkChannel.health()` + `startFeishuQrOnboarding` / `feishuQrOnboardingStatus` / `cancelFeishuQrOnboarding` / `promoteFeishuQrOwner` / `restartProfile` |
| 自主做梦想法（Dreaming） | `assistant-dreaming` 运行健康与额度、想法列表（`recorded` / `acknowledged` / `validated` / `rejected` / `retired`）及主人授权流转（确认 / 验证 / 拒绝 / 休眠） | `assistantDreaming`（结构化读取，可缺省） |
| 主动准备与工作项 | `assistant-proactive` 未验证草稿（接受 / 拒绝 / 取消）、WP22 主人注意力放宽请求（仅本次授权 / 拒绝）及 `assistant-work-items` `observe` / `would-admit` 观察队列 | `assistantProactive` + `assistantWorkItems`（+ `assistantEvaluation` 回退，可缺省） |
| 成长与记忆学习 | `assistant-memory-learning` 剩余额度/授权可用性、`assistant-growth-driver` 最近唤醒、`usageHealth` 与 `dreamingIntake` 统计 | `assistantMemoryLearning` + `assistantGrowthDriver`（可缺省） |
| 成长计分卡（只读）（`GrowthReportCard`） | 支持切换 `7 天 / 14 天 / 30 天` 窗口，只读汇总五组闭环指标（任务与纠正/重做/撤回率及趋势、新增与有来源记忆/提示词暴露/同类纠正变化、候选生成/验收通过与失败/采用/回退、通知送达/反应/忽略与 `would-accept` 吻合度及 1/4 留出已决样本数、按冻结模型分层的成本与延迟均值/P50/P95）以及记忆通道 14 天预登记口径与主动放宽 20 样本门控，严格区分「无数据（`no-data`）」与「窗口内为 0（`zero`）」 | `growthReport`（复用 `assistantEvaluation` / `pluginControlPlane` / `assistantWorkItems` 只读接口与可选只读 SQLite，零 schema 变更） |
| 版本与自迭代统计（只读）（`versionInfo`） | 返回 `dsh-rsi/version/v1`（`schemaVersion: 1`）整体助手版本、绑定与运行中的 `@deepseek-ai/dsh` Host 版本、core 与 evolved 插件清单（去重不双计），以及 20 余项严格区分 `no-data`（`null`）与 `zero`（`0`）的自迭代/演进/升级计数；同步暴露 Host 工具 `owner_console_version_info`（仅对已授权 Owner 会话可见与执行）与对话端 `/version`、`/autonomy version` 及自然语言查询 | `versionInfo`（`src/version-info.ts` 只读 `DatabaseSync` + `.dsh-rsi-host.json` + `.dsh-enhanced/upgrade-history.jsonl` + `.dsh-rsi-upgrade-backups/` + 可选 Cordis `health()` 回退） |
| 本项目插件管理 | 本项目的 bundle 层（已安装/已启用/已加载、停用/启用、移除）、已加载条目（按 fiber 阶段的启用/禁用/诊断）、安装 `@dsh-enhanced/*`，以及对 live 字段的合并配置 | `pluginManager`（bundle/entry/安装）+ `settings.describe` / `settings.mutate`（live 字段） |
| 趋势快照（只读） | 已封存的普通使用趋势快照：序号、计划、窗口边界、会话数、flags、按冻结模型分层的 DiD 与平行趋势、digest 前缀；每页 10 条，可翻到更早一页 | `pluginControlPlane.inspectCreatedCapabilityOrdinaryUseTrendSnapshots`（结构化读取，可缺省） |
| intake 吻合度（只读） | 填写 Evaluation 作用域（workspace + preset）后读取：窗口、扫描通知数（是否截断）、intake 准入合计与按 level 的吻合 / 不吻合计数与比例、非 intake / 无法判断 / 他 scope 计数；只有计数，不含工作项 id 或正文 | `assistantEvaluation.inspectIntakeAttentionAgreement`（结构化读取，可缺省；开关关闭时显示未启用）+ `loader` 条目配置（只读开关，无需作用域） |

读取与写入都经 `typert` 的严格 invocation 返回；面板不缓存或上报任何内容。
Host 状态里仍带 `dependencies` 字段，但设置页不再渲染「依赖自检」卡片。
主面板根容器填满 Host 的固定高度；设置页自己有纵向滚动（`height: 100%` + `min-height: 0` +
`overflow-y: auto`），窗口较矮时底部的「高级：合并配置」仍可滚动到达。对话窗口的原生正文和
composer 由 DSH 的会话骨架自己滚动。飞书「连接」行读取
`larkChannel.health()` 的同步快照（无 I/O）：只透传枚举内的连接状态（已连接 / 已连接但期间有断档 /
连接中 / 重连中 / 未连接 / 已停用）与枚举内的最近错误码；没有该 service 显示「未加载」，service
存在但 health 抛错、缺失或返回未知值显示「已加载，状态未知」，不会推断为已连接。

### 飞书接入方式（配置的是 lark-channel 通道）

面板配置的对象是 **`lark-channel` 通道条目**，不是 lark-cli。lark-cli 只是一个可随时安装/配置的
独立 skill，不属于本插件的依赖，也不是必选项；系统里可能已经有它，但本插件既不调用、不探测它的路径，
也不管理它的安装。

1. **一键扫码接入（推荐，与安装脚本 `dsh-lark-setup` 同协议）**：
   - 点击「一键生成飞书扫码授权」后，Host 侧向飞书官方 OAuth 2.0 Device Authorization（RFC 8628）端点
     `https://accounts.feishu.cn/oauth/v1/app/registration`（国际版 `accounts.larksuite.com`）发起 `action=begin`，
     校验返回的官方 `*.feishu.cn` / `*.larksuite.com` 授权链接并附带与 `dsh-lark-setup` 相同的增量权限/事件/回调参数
     （`im:message.*`、`im:resource`、`im.message.receive_v1`、`card.action.trigger`，可选预设权限与日历只读及已有 `clientID`），
     在 Host 侧使用 `qrcode` 生成内联 SVG 二维码返回浏览器展示（同时提供直接打开与复制链接按钮）。
   - Host 侧后台按 RFC 8628 间隔轮询 `action=poll`（支持 `slow_down` 退避与国际版 `tenant_brand: 'lark'` 自动切域，插件卸载或用户取消时立即通过 Cordis effect 中止）；
     `device_code` 与 `client_secret` 始终留在 Host 内存中，绝不回传浏览器、日志或 YAML。
   - 扫码确认后自动将 `client_secret` 加密存入系统凭据库（macOS Keychain `/usr/bin/security` 或 Linux `0o600` 受保护文件），
     原子写入 `credentials-keychain` handle、`lark-channel` 配置与 `assistantPolicy` 凭据/消息/工具规则（重扫同一账号时保留主人已自定义或收紧的工具/能力策略；若 YAML 写入失败自动回滚本次新建凭据）；若飞书返回扫码用户的 `open_id` 且
     `assistant-delivery` SQLite 已存在，则在空闲库中绑定为 `owner` 或在已有活跃主人时以 `linked` 关联接入（`linked` 支持普通私聊，`/permission`、`/model`、审批卡片与自主授权仍锚定在现有主主人）。
   - **扫码完成后一键指引**：面板继续展示三步完成指引：① 若为关联身份，经面板内明确二次确认后可调用 `promoteFeishuQrOwner` 一键切换为本 profile 飞书主主人（原子移交 `assistant-delivery` SQLite 主主人并同步 `lark-owner-*` 策略，同时提示是否需重新锚定既有自主授权）；② 在 macOS `DeepSeek Harness.app` 或受管 LaunchAgent / 非冻结 Linux systemd 环境下，经明确确认后可调用 `restartProfile` 一键重启生效（支持与主主人切换合并为「一键设为主主人并重启生效」）；③ 提供可信的飞书开放平台应用管理链接（`https://open.feishu.cn/app/<appId>` / `open.larksuite.com`）、状态刷新与可选业务工具授权命令复制。
2. **手动填入凭据**：填写 `appId`（`cli_` + 16 位十六进制）与 `App Secret`，在 Host 内存直接加密写入本机凭据库并签发访问策略，配置文件零明文。
3. **环境变量 / keychain handle 引用配置**：填写 `appId` 或从 Host 环境探测 `LARK_APP_ID` / `FEISHU_APP_ID`，仅写入环境变量名或已有 keychain handle 引用。

扫码与手动入库模式采用原子备份写 `cordis.patch.yml`（绝不在进程内触发 `settings.mutate` 协调或热重载 `credentials-keychain` / `personal-assistant` / `lark-channel`），保存后显式提示重启一次 profile（重启 `DeepSeek Harness.app` 或运行 `dsh-rsi restart`）以干净加载新凭据句柄、策略与 WebSocket 长连接；环境变量 / 既有 handle 引用模式仍走 Host `settings.mutate` 的显式 set/unset + `secretSource` 判别字段，校验拒绝保持红色告警。
secret 明文永不进入 `cordis.patch.yml`、日志或浏览器状态。

卡片按实际状态给出下一步，状态由 `bundles[].enabled` 与 `plugins[].fiberPhase` 判定，不再把
“条目不在 `settings.describe()` 里”一律当成未启用：

- 未安装：显示「安装 lark-channel」（走 Host pluginManager 的 pnpm 安装，会先补装激活与加密入库所需的
  同伴 bundle `@dsh-enhanced/assistant-delivery`、`@dsh-enhanced/credentials-keychain`，再装该包及其 pnpm 依赖）；
- 已安装但 bundle 未启用：显示「启用 lark-channel」；
- 已启用但 fiber 为 pending / failed / 无条目：显示「已启用，等待依赖服务 / 已启用但加载失败 /
  已启用，但 Loader 没有条目」，附 fiber 阶段、诊断、缺少的 companion 服务（及对应要安装的
  `@dsh-enhanced/*` bundle）和一段可复制的最小 `cordis.patch.yml` 修复行；此时绝不显示「启用」
  （对已启用的 bundle 是无效动作），也不会把配置拒绝推给泛化文案；
- fiber active 且条目有 live 字段：才显示配置表单。

安装只包含该包本身及其 pnpm `dependencies`；`peerDependencies` 里的 `@dsh-enhanced/*` bundle 与它
在 profile 里需要的 Host 服务不会由 pnpm 自动装上。`lark-channel` 在激活时静态 import
`@dsh-enhanced/assistant-delivery`，因此面板的「安装 lark-channel」会先安装这个同伴 bundle；
其余缺失项仍由上面的状态区列出。
TraeX 卡片同理（安装/启用 traex-acp-provider）。

只有声明了 `.volatile()` 的配置字段才能这样实时改写：`lark-channel` 暴露
enabled/account/tenant/appId/appSecretEnv/credentialHandle/secretSource，`traex-acp-provider` 暴露
enabled/command（TraeX）与 agyEnabled/agyCommand（Antigravity），`agent-default-model` 暴露
provider/model/reasoningEffort。没有 live 字段的条目不会出现在面板里。

### 编程工具、自主能力控制与本项目插件

- **编程工具与默认模型路由**：保留 `status.traex` 与 `configureTraex(enabled, command)` 向后兼容，同时提供
  `configureAgy(enabled, command)`、`setDefaultModelRoute(provider, model, reasoningEffort)` 与
  `probeCodingTool(tool, command, force)`。切换默认工具为 `traex-agent` / `agy-agent` 时若对应 ACP 路由尚未启用，
  会先通过 `settings.mutate` 启用该路由并重载 `dsh-enhanced-traex-acp-provider`，再写入 `agent-default-model`。
  CLI 探测严格走只读无交互参数（`traex login status` 与 `agy --version` / `agy models`），仅传入最小环境变量白名单、
  拒绝含控制字符或换行命令、带有限超时（TraeX 8 秒，`agy --version` 3 秒 / `agy models` 18 秒）与
  15 秒结果缓存（同工具并发去重）。
- **自主做梦 / 主动准备 / 成长 / 记忆学习**：通过 `assistantOverview`、`actDreamingIdea`、
  `actAttentionQuestion`、`actProactiveDraft` 暴露可控开关与主人裁决入口；所有同伴插件缺失或权限门控未满足时
  均 fail-closed 降级展示，不绕过 owner 授权、预算或评估门控。
- **Bundle 层**：列出本 profile 里 `@dsh-enhanced/*` bundle 的版本、是否安装、是否启用、是否可移除
  （`not-bundle` 依赖行不显示，避免给出会被 Host 拒绝的启停按钮），
  一键启用/停用；停用只摘除该 bundle 的 patch 层，已安装依赖保留。每行另有「移除」（仅对可移除且非本面板自身的
  bundle 显示，并需浏览器确认；移除后可用面板安装入口或 `dsh plugin add` 重新添加；依赖是否留在
  profile 中由 DSH 的 pluginManager/pnpm 决定）。
- **已加载条目**：列出模块属于 `@dsh-enhanced/*` 的 Loader 条目（entryId、模块名、fiber 阶段），
  可单独启用/禁用；按模块归属而不是 bundle row 归属判断，第三方模块行不在此面板管理。
- **安装**：只接受 `@dsh-enhanced/<name>` 形式的包名，走 DSH 自身的 `pluginManager.installBundle`
  （与 `dsh plugin` 相同的 pnpm 路径），会一并安装该包声明的依赖并默认激活；本地路径和 git 地址
  不在此面板处理，避免面板成为任意代码源入口。安装/启用后如返回 `restart-required`，按提示重启 profile。
- **依赖构建脚本**：pnpm 可能拒绝依赖的构建脚本（`ERR_PNPM_IGNORED_BUILDS`）。Host 记录到
  `pendingBuilds` 时，面板会先让主人确认，再用这些精确名称重试。当前 Host 的 ANSI 解析缺陷会丢掉
  依赖名、使 `pendingBuilds` 为空，因此面板也支持从失败输出中读出依赖名交给主人确认；确认后不再
  依赖 Host 的 `approveBuilds`（它可能返回 `stale-approval`）：面板先把确认过的名称写入当前 profile
  的 `pnpm-workspace.yaml`（`allowBuilds: <name>: true`，原子写入、0600），再不带审批参数重试一次，
  所以一键安装不再需要人工改 `allowBuilds`。不会自动放行，也不会写入未确认的名称。
- **不兼容版本**：Host 以 `incompatible-version` 拒绝时，面板列出被拒的 `包@版本`、缺失的 DSH peer
  要求与当前 DSH 版本，并提示更新插件或为这个精确版本授予兼容豁免后重试。
- **高级**：对声明了 live 字段的条目仍可合并一段 JSON 配置（≤16 KiB），不重置其它字段。
- 面板收到 Host 的业务拒绝会原样显示原因（例如环境变量不存在、身份字段缺失、需要重启），不静默失败。
- 「方式」按条目里实际存在的 secret 引用显示（环境变量 secret 或 keychain secret），
  不再只反映本插件自己的偏好字段。

趋势快照卡片只读：唯一的按钮是「更早的快照 / 回到最新」，都只重新调用 `trendSnapshots`；面板没有封存、
编辑或删除入口，封存由 Host 侧 owner 调用 Control Plane 完成。结果固定 `causal: false`，不作为采用、晋升或撤权依据。
没有 Control Plane 显示未加载；查询被拒、已封存行未通过 digest 校验或返回值不合模式时显示「未通过校验」，不修复也不改写。

成长计分卡卡片（`GrowthReportCard`）只读：提供 `7 天 / 14 天 / 30 天` 窗口切换与刷新按钮，经 `growthReport` invocation 聚合现有只读服务与账本快照，不新增或迁移任何表结构，也不发起模型调用或修改配置。任一数据源未加载、未配置或账本不存在时显式标为 `no-data`（「无数据（未启用或账本不存在）」），账本已就绪且窗口内事件数为 `0` 时显式标为 `zero`，绝不将缺失数据混作 0 发生率。

intake 吻合度卡片只读：两个输入框只决定查询哪个 Evaluation 作用域，唯一的「读取」按钮只调用 `intakeAgreement`，
按 Evaluation 的默认摘要窗口读取；面板不写入、不采用、不发送。没有 Evaluation 显示未加载；Evaluation 未开启
`intakeAttentionAgreementEnabled`（默认关，需同时开启 `notificationOutcomesEnabled`）时显示「未启用」；作用域为空、
查询被拒或抛错（含相对路径等 Evaluation 拒收的作用域）、协议不符、`causal` 不为 `false`、计数不合模式或彼此矛盾（结果合计、吻合/不吻合与比例按 Evaluation 的算法复核）时显示「未通过校验」。修改任一输入框会清掉已显示的结果，读取进行中按钮禁用，过期的应答被丢弃，因此显示的计数总是对应输入框里的作用域。结果固定 `causal: false`：
口径混合了执行与注意力结果，不是 intake 准确率，只覆盖 auto 准入的工作项，不作为采用依据。

卡片顶部的「Evaluation 开关」来自 Host 状态的 `evaluation.intakeAgreement`，不需要作用域：没有 Evaluation
显示「未加载」；Evaluation 存在且唯一启用的 `@dsh-enhanced/assistant-evaluation` Loader 条目未开启
`intakeAttentionAgreementEnabled` 时显示「未启用」，开启时显示「已启用」；Evaluation 缺少该读取方法、没有 loader、
找不到或找到多个启用条目、或开关值不是布尔时显示「已加载，开关状态未知」。它不调用 Evaluation、不扫描通知，
只透传这四个枚举值，不含作用域、计数或其它配置；它也不阻止「读取」，作用域内的结果仍以读取为准。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖本行配置：

```yaml
- id: dsh-enhanced-owner-console
  name: '@dsh-enhanced/owner-console'
  config:
    feishuAppId: ''        # 可选：一键探测的默认 appId；app secret 不进入配置
```

配置为同步 Standard-Schema 校验，非法值在加载时被拒绝。

## 权限与数据边界

- **文件与配置边界**：常规插件字段写入仍委托给 Host `settings.mutate`（仅易失字段）与
  `pluginManager`；**自主能力一键授权向导**（`autonomySetupStatus` / `configureAutonomySetup` /
  `src/autonomy-setup.ts`）在主人显式点击授权或安全暂停/停用后，仅读取当前 `$DSH_HOME` 下激活的
  `assistant-delivery` 只读 SQLite（`delivery_principals` / `conversation_bindings`）与目标 profile 的
  `cordis.patch.yml`，按 `0o600` 权限创建时间戳备份并以临时文件+原子重命名更新 `cordis.patch.yml`
  （保留无关配置与 `!!js` 表达式；拒绝符号链接、拒绝 `~/.dsh` 越界数据库路径，绝不绕过
  `assistantPolicy` 有限预算与三权分立）。**只读成长计分卡**（`growthReport` / `src/growth-report.ts`）仅调用宿主只读检查方法并在存在 `$DSH_HOME` 内已配置的 `assistant-growth-driver`、`assistant-memory-learning`、`preference-learning` 等只读 SQLite 文件时以 `readOnly: true`（拒绝符号链接与越界路径、必要时仅对无有效 `-wal` 的只读目录启用 `immutable=1`，经 `PRAGMA quick_check` 与表/列存在性校验）统计记忆、偏好、演进与自迭代计数，不创建数据库、不调用插件 Store 构造函数、不写 WAL 且不改变任何 schema；同时只读读取 `$DSH_HOME/.dsh-enhanced/upgrade-history.jsonl` 与 `$DSH_HOME/.dsh-rsi-upgrade-backups/`（其中包含自助升级与 `doctor-*` 备份子目录）。
- **子进程、网络与凭据边界**（`src/probes.ts`、`src/upgrade-probe.ts`、`src/feishu-qr-onboarding.ts`、`src/doctor-repair.ts`）：
  - **飞书官方扫码授权、主主人移交与一键重启**（`startFeishuQrOnboarding` / `feishuQrOnboardingStatus` / `cancelFeishuQrOnboarding` / `promoteFeishuQrOwner` / `restartProfile` / `configureFeishuEasy`）：仅在主人显式点击后由 Host 侧通过 HTTPS POST 访问 `https://accounts.feishu.cn/oauth/v1/app/registration`（及国际版自动切域后的 `https://accounts.larksuite.com/oauth/v1/app/registration`），严格校验返回的授权链接与开放平台链接属于 `*.feishu.cn` / `*.larksuite.com`；`device_code` 与 `client_secret` 仅存在于 Host 瞬态内存中，经 `/usr/bin/security`（macOS Keychain）或 `$DSH_HOME/credentials-keychain/*.secret`（Linux `0o600` 原子写入且拒绝符号链接）持久化；`promoteFeishuQrOwner` 需显式确认后才以事务方式更新 `$DSH_HOME/assistant-delivery/state.sqlite` 主主人并同步 `cordis.patch.yml`；`restartProfile` 需显式确认后以无 shell 独立后台 helper（`ELECTRON_RUN_AS_NODE=1`）触发 macOS LaunchAgent（`/bin/launchctl kickstart -k`）、`DeepSeek Harness.app`（`/usr/bin/osascript` + `/usr/bin/open`）或非冻结 Linux systemd user unit（`systemctl --user restart`）；受控 Linux systemd 冻结实例拒绝在线改写凭据、移交主主人或触发重启；插件卸载时通过 Cordis effect 立即中止轮询。Setup Doctor 同时检测并一键修复 `assistant-verifier` 缺失 `databasePath` 与 YAML alias 导致的损坏策略规则。
  - 本机编程 CLI 就绪探测仅在主人显式触发时执行无 shell（`execFile`）只读命令（`traex login status`
    或 `agy --version` + `agy models`），传递最小环境变量白名单、有限超时与 15 秒缓存；绝不触发模型推理。
  - **版本检查与自助升级**（`checkSelfUpgrade` / `dryRunSelfUpgrade` / `runSelfUpgrade`）：严格只读读取
    `$DSH_HOME/.dsh-rsi-host.json`（`O_NOFOLLOW` / `0o600`）与运行时包版本；子进程环境变量沿用最小白名单并严格过滤密钥/token，校验并保留合法绝对路径的 `DSH_DESKTOP_NODE_EXECUTABLE`（供桌面端内置 `node` 包装脚本执行），注入 `DSH_HOME` 并去重追加实际存在的用户可执行目录（`~/.local/bin`、`~/.npm-global/bin`、`~/Library/pnpm`、`/opt/homebrew/bin`、`/usr/local/bin`；Windows 为 `%APPDATA%\npm`）到 `PATH`。通过有界超时的 `dsh-rsi upgrade --check`（25 秒）/ `--dry-run --json`（30 秒）或 `https://registry.npmjs.org/@dsh-enhanced%2Fowner-console/latest` 获取最新版本（带 60 秒 TTL 缓存与离线回退）；若 `dsh-rsi` 返回 `ENOENT`/`ENOTDIR`/`EACCES` 则回退扫描上述用户可执行目录并缓存绝对路径，且细化区分未安装、超时（`ETIMEDOUT`）、离线及脱敏后的 CLI 错误/阻塞诊断（预演通过后自动清理陈旧失败缓存并激活面板升级确认入口）。在非受控本地 / macOS profile 且主人完成预演与明确二次确认后，以无 shell 独立后台进程启动 `dsh-rsi upgrade --yes`（`standard-local` 模式自动附加 `--confirm-dsh-home-stopped`，`macos-launchd` 保持 LaunchAgent 停启事务参数不变；日志写入 `$DSH_HOME/logs/`）；在受控 Linux systemd profile 上拒绝进程内自升级并仅展示带外终端升级命令。
- 安装动作因此会经由 Host 启动 pnpm 并访问 registry（与 `dsh plugin` 相同）；只在主人点击时发生。
  依赖构建脚本只有在主人于面板再次确认后、且仅针对 Host 记入 `pendingBuilds` 或安装输出中读到的
  精确名称才被批准；确认写入 profile 的 `allowBuilds` 后由服务端重试，不经模型。
- 配置写入只经 Host `settings.mutate`，且限定到单个已安装条目；bundle/entry 管理只经 Host
  `pluginManager` 且限定 `@dsh-enhanced/*`；授权来源是主人自己在面板上的点击，不是模型工具调用，
  也不存在后台自动写配置。
- 对话窗口只读取当前 retained Session 自己的 `eventSource` / snapshot / `permissions` / `modelSelection`
  projection，用来显示消息流、模型选择和朗读；不读取其它会话、报告或记忆，也不上报内容。
  client bundle 只依赖宿主提供的 `react`（以及 `react/jsx-runtime`）与 Host 注入的客户端服务，
  不 import 其它 DSH 组件包；专属对话流由 `OwnerConsoleChat` 与 `chat-markdown.ts` 独立渲染。
- 语音识别/合成由浏览器完成，音频或文本可能发送给浏览器厂商的语音服务（不经过 DSH
  权限模型与审计）；插件不录音、不保存音频，只把识别结果填入当前对话框草稿。
- 安装/移除仅由主人点击触发，走 DSH 官方安装路径；移除只对 Host 标记为 `removable` 且非本面板自身的
  bundle 显示，并需浏览器确认（无确认通道时给出可见提示并停止）；不改动未列出的条目；
  secret 明文不接受、不存储、不回显。

## 测试

`tests/client-bundle.spec.ts` 用 Web 外壳的 `__ModuleLoader__` 契约加载实际构建产物
`lib/client.js`，以真实 `react`/`react/jsx-runtime` 执行 factory，断言全部客户端槽位
（`sidebar.panellist`、`main`、`owner-console.conversation`、`settings.section`、`settings.section.icon`、
`settings.general.item`、`settings.models.footer`、`settings.models.provider-card` 及 6 个 `plugins.bundle.config`）的注册与反向释放；
并断言侧栏标签为「文鳐」、main 槽根容器填满固定高度、产物内联 4 个 webp、包含专属控制条与 `/model` 下拉标识且不含外部图片 URL。
因此该测试依赖先运行 `pnpm --dir plugins/owner-console build`（根检查与 `pnpm check` 均先构建）。
`tests/coding-tools-service.spec.ts`、`tests/autonomy-service.spec.ts` 与 `tests/model-catalog.spec.ts` 覆盖 `agy` 配置、`/model` 目录聚合（超时隔离/休眠回退/写后缓存失效）、文鳐会话严格作用域系统提示隔离、级联下拉筛选、默认路由切换、无交互 CLI 探测以及 Dreaming / Proactive / WP22 / WorkItems / MemoryLearning / GrowthDriver 读写入契约与 fail-closed 降级；`tests/growth-report.spec.ts` 覆盖只读成长计分卡；`tests/settings-slots.spec.ts` 与 `tests/doctor-ui.spec.ts` 在 jsdom 中渲染设置分组、通用设置行、模型设置卡片与 6 个插件详情槽。
`tests/chat-dom.spec.ts` 在 jsdom 中真实挂载 React DOM，覆盖：专属助手对话窗口（GFM 表格/代码块 Markdown 渲染、macOS 顶栏避让、能力元信息与隐式固定工作区隔离、新对话、紧凑内嵌 `/model` 模型切换与缓冲自定义模型、`SessionFace.prompt` 发送、附件上传、语音识别/权限切换）、`OwnerConsoleConversation` 子槽相位计算以及齿轮打开设置页/返回对话；`tests/feishu-qr-onboarding.spec.ts` 与 `tests/feishu-qr-ui.spec.ts` 覆盖飞书官方扫码授权协议（`begin`/`poll`/切域/竞态/凭据脱敏与回滚/主主人移交与重启引导）及设置卡片交互。`tests/chat.spec.ts` 覆盖事件折叠、工具状态、会话创建/复用/过期、上传失败、权限标签等纯函数。`jsdom` / `react-dom` / `@types/react-dom` 只作为测试 devDependencies，不进入客户端产物。
`tests/client-render.spec.ts` 不依赖 DOM，桩掉 React hooks 后展开设置页元素树，断言页头品牌、
02 水墨化鹏主视觉/面板背景/印章/侧栏图标均为纯装饰（`alt=""` + `aria-hidden`）、状态胶囊带文字
标签与空状态文案。

## 界面布局

- **文鳐专属对话窗口**：遵循 Codex / DeepSeek 官方紧凑布局与 Apple 设计理念——顶部为单行 `48px` 毛玻璃标题栏（支持 `data-window-drag` 与 macOS `--dsh-frame-leading-clearance` 避让，含化鹏标、「文鳐 Ray」、状态点与精简元信息、右上角「+ 新对话」与 ⚙）；中部为无框通透阅读画布（居中欢迎卡片 + 2×2 推荐开场白、无框对齐用户气泡、全宽 Markdown/GFM 表格助手回复、回底悬浮按钮）；底部为单一悬浮 Composer 底座（柔和顶缘渐隐，内嵌边框归零输入框与单行紧凑工具栏：`+` 附件、权限芯片、`/model` 级联路由/模型/Effort、语音、朗读及圆形主发送/停止钮），字号联动 `--dsh-content-font-size`。
- **设置页与 DSH 设置弹窗共用分类卡片组（`SettingsCardsDeck`）**：支持「全部 / 体检自愈 / 模型与工具 / 自主与成长 / 飞书与插件 / 只读诊断」分组切换；共用 `--dsw-*` 样式与 `ModelRouteSelects`、CLI 路径下拉选择器。
- 两个视图共用同一套背景：02 水墨化鹏宽幅图以低透明度铺在面板表面、内容之下，明暗主题对比度不变；颜色只取宿主 `--dsw-*` 变量并带回退值。

### 主视觉与图标资产

源图 `02_水墨化鹏_副本/background.png`（1672×941）与 `icon.png`（1254×1254）不入库；只提交 `assets/` 下压缩后的派生文件（hero 1254×706、backdrop 960×540、icon 128/256，合计约 53 KB）与内联结果
`src/artwork.ts`，因此 `lib/client.js` 仍然自包含。构建本身不重写 `src/`；`tests/artwork.spec.ts`
校验已提交的 `src/artwork.ts` 与 `assets/` 逐字节一致，资产重新压缩后忘记刷新会直接测试失败。
`assets/` 不随 npm 包发布，也不需要发布：数据已内联在 `lib/` 中。

重新生成派生资产（仅当源图变化时；需要 Python + Pillow）：

```sh
python3 plugins/owner-console/scripts/prepare-assets.py /path/to/02_水墨化鹏_副本
```

派生资产变化后，用已提交的 `assets/` 重新生成 `src/artwork.ts`（幂等、无需源图）并提交：

```sh
pnpm --dir plugins/owner-console build:assets
```

## 限制

### 对话窗口

- **原生嵌入依赖 renderer 注入的 seats**：真实 Web 外壳会向每个 renderer 组件注入
  `SessionProvider` / `renderSlot` / `renderFactorySlot`，并允许插件 main 入口声明一个
  session-scoped 子槽；本插件据此复用 `conversation.content`。如果某个嵌入没有这些 seats，
  或 Host 没有注册 `conversation.content` 工厂，面板退回自包含的降级窗口（文本消息 + composer），
  不会假装渲染原生组件。2026-11-06 在临时 profile + pinned DSH `0.2.1-rc.2` 的真实 `dsh web`
  中已确认原生正文、composer、附件按钮、权限 chip 与模型选择都在面板内；语音输入由 Host
  composer 提供，面板自身不再重复渲染工具行（证据
  `docs/evidence/owner-console/wenyao-chat-20261106/`）。
- **没有真实模型/API Key，未完成一次真实发送**：隔离 profile 未登录、未配置模型，原生 composer
  显示「请选择模型」；因此只验证了 composer 的 DOM/按钮/草稿写入，没有验证真实模型回合并。
  降级 composer 的 `SessionFace.prompt` 发送路径由 jsdom 单测覆盖，但不是 live 模型验收。
- **专用会话不是专用 agent preset**：会话通过 `workspaces.initializeDefault()` +
  `uiWorkspace.connectWorkspace()` 建在默认工作区，运行 Host 默认 agent preset。若主人希望文鳐
  固定人格/固定权限/固定模型，需要 DSH 提供主机侧 agent preset 绑定，或由 owner 在设置中改变
  默认 preset；本插件不伪造第二个 agent 身份。
- **不显示目录**：面板不渲染工作区、文件目录或会话列表；`hero: false` 关掉原生工作区选择器。
  切换会话/工作区要用左侧栏或「原生会话」。如果默认工作区不可用，会话退回 Host 默认 cwd 的
  ungrouped 会话，原生视图可能要求选择工作区。
- **语音是浏览器能力（仅降级窗口）**：面板自己的「语音对话」/「朗读」分别依赖浏览器
  `SpeechRecognition` / `SpeechSynthesis`；不可用时按钮禁用并在 tooltip 说明。识别/合成由浏览器
  （及其可能的服务商）完成，不是 DSH 模型；插件不录音、不保存音频。**常见浏览器会把音频或待朗读
  文本发给浏览器厂商的语音服务，这段链路不经过 DSH 的权限模型与审计**；真实麦克风与真人语音未
  验收；jsdom 用桩覆盖降级与草稿写入。原生对话的语音入口归 Host composer，插件不渲染、不拦截。
- **降级窗口语音写入原生草稿会替换/追加纯文本**：通过 `conversation.input.for(actx).setDraft()`
  写入；当前已有引用 chip 时，`setDraft` 会把草稿变为纯文本（浏览器语音的固有边界）。原生输入
  服务缺失时按钮仍可点，但会显示可见失败，不会静默。
- **权限选项来自 Host**：原生权限 chip 需要 `ui-permission-presets`；没有它时本插件显示自己的
  权限行。可选 preset 目录由 Host `permissionPresets.catalog()` 决定；隔离 profile 中目录只返回
  一个可用 preset。切换只走 `/permission <preset>`，没有直接写会话权限的客户端 API；高风险
  preset 的确认由原生或面板的显式确认承担。
- **附件上传走原生 composer**：真实 GUI 只验证了附件按钮存在；没有实际选择文件/完成一次带附件
  的发送（无模型）。降级窗口的 `fileUpload` 上传/回执由单测覆盖；没有自定义拖拽、粘贴或预览。
- **降级窗口不是完整原生渲染**：只折叠 user/assistant 文本、工具名+状态和 turn 错误；不渲染
  markdown、图片、工具参数/结果、审批/计划/队列等原生卡片。这是诚实的最小可用面，真实 DSH Web
  不触发它。
- **原生会话入口**：调用 `uiWorkspace.openSession(id)`；服务缺失时显示可见提示。已验证在同一条
  会话上切换到原生视图（同一 session id、默认工作区 composer），未验证在原生视图发消息。

### 设置页与安装

- 一键模式只做 Host 环境变量探测，既不执行也不依赖 lark-cli；需要向导时由 owner 用系统已装的
  lark-cli skill 或其他方式自行提供 appId/secret 环境变量。
- 插件管理支持移除本项目 bundle（仅 `removable` 且非自身，且必须由浏览器确认；无确认通道时不执行）。
- **真实 Web GUI 已验证（设置/安装切片）**：临时 profile + pinned DSH `0.2.1-rc.2` 下左侧栏入口、
  设置页全部卡片、原生插件页已安装行、「打开插件页 / 开始对话」均通过（证据
  `docs/evidence/owner-console/browser-smoke/`）。2026-11-06 的新 smoke 也确认 ⚙ 打开设置页、
  五张卡片渲染、返回对话正常。当时 live Harness Mac app 为 `0.2.2-rc.1`（历史 `0.1.66` 起采用
  0.2 线 peer 范围，当前仓库 peer 基线已收紧至 `>=0.2.2-rc.5 <0.3.0`，详见[兼容性基线](../../docs/compatibility.md)），不再需要 owner 豁免即可安装；
  同日在 live `desktop` profile 复验了侧栏「文鳐」入口、对话面板、原生正文与 composer、
  ⚙ 设置入口（证据 `docs/evidence/owner-console/mac-live-app-20261106/`）。
- **未在真实 GUI 中复验的部分**：飞书/TraeX 的“已安装未启用→启用”“活动→配置”两态此前是用 patch
  覆盖伪造的状态，安装按钮也从未在真实 GUI 点击过；状态文案、安装拒绝与修复提示由单元测试覆盖。
  登录态、模型连接与真实飞书 Bot 仍未验收。
- 本地 `pnpm pack` 产物（非 workspace 链接）经 `dsh plugin add <tgz>` 安装已验证：随包依赖
  `@deepseek-ai/schemastery` / `zod` 由 pnpm 一并装入，入口、设置页与插件页已安装行正常；
  从 registry 发布后安装尚未验证。面板安装只接受 `@dsh-enhanced/*` 包名（不支持任意本地/git 源）。
- 设置页会列出 `owner-console` 自己的 bundle/entry：禁用它会隐藏这个入口，需用 `dsh plugin` 或 CLI
  重新启用（与 DSH 原生插件页语义一致）。
- 停用 bundle 只摘除 patch 层，依赖与包文件保留；「移除」经 Host `pluginManager.removeBundle`
  （内部走 pnpm），不是仅去掉 profile 里的选择。
- 连接状态是 `lark-channel` 自己报告的快照，面板不主动探测飞书；「已连接」来自通道的长连接状态，
  没有用真实飞书 Bot 验收过（按用户要求延后）。
- 不校验 app secret；secret 的写入通道留给 keychain 切片。
