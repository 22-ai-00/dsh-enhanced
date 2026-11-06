# owner-console（文鳐 Ray）

个人助手「文鳐」（英文 Ray，小名小鳐；口号「小鳐小鳐，游而化飞」）在 DeepSeek Harness 左侧栏的
单一入口，即原来的「控制台」（主人控制台）；面板标题显示助手的名字与口号。改名只影响显示，包名、插件 id 与条目 id 仍是 `owner-console`。设计沿用
[dsh-superagent-prototype](https://github.com/22-ai-00/dsh-superagent-prototype) 的理念：
注意力是预算，只在被请求或书面规则允许时行动；只说需要人行动的话；一次一个问题；概念和设置尽量少；
面板只展示需要人处理的事。

当前切片：只读状态 + 主人点击的一次性配置与管理动作。配置写入只经 Host `settings` 服务合并到
指定条目；bundle/条目管理与安装只经 Host `pluginManager`。两类动作都由主人点击触发，
不发起模型调用、不创建 Bot、不接受明文 secret、不改动未列出的插件。安装会把 pnpm 子进程和
registry 网络调用委托给 DSH 自身的 plugin manager，不在本插件里实现网络或进程逻辑。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/owner-console
dsh --profile web --dump-config
```

安装由 DSH 的 pnpm 路径完成，本包声明的运行依赖（`@deepseek-ai/schemastery`、`zod`）随包安装；
Host 侧的 `typert` 与 Web 侧的 `react` 由 DSH 提供。安装后左侧栏出现「文鳐」入口：
顶部「开始对话」直接进入当前工作区的智能体会话，「打开插件页」跳到 DSH 原生插件页；下面是配置卡片：

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| 远程接入（飞书） | 接入方式、`lark-channel` 条目、连接状态（`larkChannel.health()` 快照）、appId 是否配置；两种对接：直接填写 appId + secret 引用，或从 Host 环境一键探测 appId | `settings.describe` + `larkChannel.health()` |
| TraeX | `traex-acp-provider` 条目、是否启用、命令 | `settings.describe` |
| 本项目插件管理 | 本项目的 bundle 层（启用/停用）、已加载条目（启用/禁用/阶段）、安装 `@dsh-enhanced/*`（含依赖），以及对 live 字段的合并配置 | `pluginManager` + `settings.describe` / `settings.mutate` |
| 趋势快照（只读） | 已封存的普通使用趋势快照：序号、计划、窗口边界、会话数、flags、按冻结模型分层的 DiD 与平行趋势、digest 前缀；每页 10 条，可翻到更早一页 | `pluginControlPlane.inspectCreatedCapabilityOrdinaryUseTrendSnapshots`（结构化读取，可缺省） |
| intake 吻合度（只读） | 填写 Evaluation 作用域（workspace + preset）后读取：窗口、扫描通知数（是否截断）、intake 准入合计与按 level 的吻合 / 不吻合计数与比例、非 intake / 无法判断 / 他 scope 计数；只有计数，不含工作项 id 或正文 | `assistantEvaluation.inspectIntakeAttentionAgreement`（结构化读取，可缺省；开关关闭时显示未启用） |

读取与写入都经 `typert` 的严格 invocation 返回；面板不缓存或上报任何内容。
Host 状态里仍带 `dependencies` 字段，但面板不再渲染「依赖自检」卡片。
面板根容器自带纵向滚动（`height: 100%` + `min-height: 0` + `overflow-y: auto`），窗口较矮时
底部的「高级：合并配置」仍可滚动到达。飞书「连接」行读取
`larkChannel.health()` 的同步快照（无 I/O）：只透传枚举内的连接状态（已连接 / 已连接但期间有断档 /
连接中 / 重连中 / 未连接 / 已停用）与枚举内的最近错误码；没有该 service 显示「未加载」，service
存在但 health 抛错、缺失或返回未知值显示「已加载，状态未知」，不会推断为已连接。

### 飞书两种对接方式（配置的是 lark-channel 通道）

面板配置的对象是 **`lark-channel` 通道条目**，不是 lark-cli。lark-cli 只是一个可随时安装/配置的
独立 skill，不属于本插件的依赖，也不是必选项；系统里可能已经有它，但本插件既不调用、不探测它的路径，
也不管理它的安装。

1. **直接配置**：填写 `appId`（`cli_` + 16 位十六进制），先选 secret 引用方式（单选），点「应用配置」：
   - 环境变量名：secret 留在 Host 进程环境里；
   - keychain handle：secret 由 `credentials-keychain` 持有。
   可选 account/tenant 留空时沿用条目现值，不静默改身份。
2. **一键配置**：Host 进程环境里已有 `LARK_APP_ID` 或 `FEISHU_APP_ID`（或本插件配置的默认 appId）时，
   点一个按钮即用探测到的 appId 写入同一份通道配置。环境变量可以由任何方式提供（shell、launchd、
   或你自己安装的 lark-cli skill），本插件只读取环境，不执行外部 CLI。

写入通过 Host `settings.mutate` 的显式 set/unset + `secretSource` 判别字段完成，并重启 `lark-channel`
条目让通道按新配置重建；`restart-required` 视为已持久化并提示重启，校验拒绝保持红色告警。
secret 明文永不进入配置、日志或本插件。

卡片会按实际状态给出下一步：未安装时显示「安装 lark-channel（含依赖）」（走 Host pluginManager 的
pnpm 安装），已安装但未启用时显示「启用 lark-channel」，只有条目处于活动状态才显示配置表单。
TraeX 卡片同理（安装/启用 traex-acp-provider）。

只有声明了 `.volatile()` 的配置字段才能这样实时改写：`lark-channel` 暴露
enabled/account/tenant/appId/appSecretEnv/credentialHandle/secretSource，`traex-acp-provider` 暴露
enabled/command。没有 live 字段的条目不会出现在面板里。

### TraeX 与本项目插件

- TraeX 卡片只切换 `traex-acp-provider` 条目的 `enabled`（可选覆盖 `command`），不启动进程。
- **Bundle 层**：列出本 profile 里 `@dsh-enhanced/*` bundle 的版本、是否安装、是否启用、是否可移除
  （`not-bundle` 依赖行不显示，避免给出会被 Host 拒绝的启停按钮），
  一键启用/停用；停用只摘除该 bundle 的 patch 层，已安装依赖保留。每行另有「移除」（仅对可移除且非本面板自身的
  bundle 显示，并需浏览器确认；移除后可用面板安装入口或 `dsh plugin add` 重新添加；依赖是否留在
  profile 中由 DSH 的 pluginManager/pnpm 决定）。
- **已加载条目**：列出模块属于 `@dsh-enhanced/*` 的 Loader 条目（entryId、模块名、fiber 阶段），
  可单独启用/禁用；按模块归属而不是 bundle row 归属判断，第三方模块行不在此面板管理。
- **安装**：只接受 `@dsh-enhanced/<name>` 形式的包名，走 DSH 自身的 `pluginManager.installBundle`
  （与 `dsh plugin` 相同的 pnpm 路径），会一并安装该包声明的依赖并默认激活；本地路径和 git 地址
  不在此面板处理，避免面板变成任意代码源入口。安装/启用后如返回 `restart-required`，按提示重启 profile。
- **高级**：对声明了 live 字段的条目仍可合并一段 JSON 配置（≤16 KiB），不重置其它字段。
- 面板收到 Host 的业务拒绝会原样显示原因（例如环境变量不存在、身份字段缺失、需要重启），不静默失败。
- 「方式」按条目里实际存在的 secret 引用显示（环境变量 secret 或 keychain secret），
  不再只反映本插件自己的偏好字段。

趋势快照卡片只读：唯一的按钮是「更早的快照 / 回到最新」，都只重新调用 `trendSnapshots`；面板没有封存、
编辑或删除入口，封存由 Host 侧 owner 调用 Control Plane 完成。结果固定 `causal: false`，不作为采用、晋升或撤权依据。
没有 Control Plane 显示未加载；查询被拒、已封存行未通过 digest 校验或返回值不合模式时显示「未通过校验」，不修复也不改写。

intake 吻合度卡片只读：两个输入框只决定查询哪个 Evaluation 作用域，唯一的「读取」按钮只调用 `intakeAgreement`，
按 Evaluation 的默认摘要窗口读取；面板不写入、不采用、不发送。没有 Evaluation 显示未加载；Evaluation 未开启
`intakeAttentionAgreementEnabled`（默认关，需同时开启 `notificationOutcomesEnabled`）时显示「未启用」；作用域为空、
查询被拒或抛错（含相对路径等 Evaluation 拒收的作用域）、协议不符、`causal` 不为 `false`、计数不合模式或彼此矛盾（结果合计、吻合/不吻合与比例按 Evaluation 的算法复核）时显示「未通过校验」。修改任一输入框会清掉已显示的结果，读取进行中按钮禁用，过期的应答被丢弃，因此显示的计数总是对应输入框里的作用域。结果固定 `causal: false`：
口径混合了执行与注意力结果，不是 intake 准确率，只覆盖 auto 准入的工作项，不作为采用依据。

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

- 本插件自身不直接读写文件、不直接联网、不直接起子进程、不读取凭据；需要落盘的动作都委托给
  Host 的 `settings`（配置）与 `pluginManager`（bundle/条目管理与 pnpm 安装），由后者执行。
- 安装动作因此会经由 Host 启动 pnpm 并访问 registry（与 `dsh plugin` 相同）；只在主人点击时发生。
- 配置写入只经 Host `settings.mutate`，且限定到单个已安装条目；bundle/entry 管理只经 Host
  `pluginManager` 且限定 `@dsh-enhanced/*`；授权来源是主人自己在面板上的点击，不是模型工具调用，
  也不存在后台自动写配置。
- 不读取会话内容、报告或记忆；client bundle 只依赖宿主提供的 `react` 与 `remote`/`slots`。
- 安装仅由主人点击触发，走 DSH 官方安装路径；不提供卸载，不改动未列出的条目；
  secret 明文不接受、不存储、不回显。

## 测试

`tests/client-bundle.spec.ts` 用 Web 外壳的 `__ModuleLoader__` 契约加载实际构建产物
`lib/client.js`，以真实 `react`/`react/jsx-runtime` 执行 factory，断言 sidebar/main 两个注册与释放；
并断言侧栏标签为「文鳐」、main 槽根容器带纵向滚动样式；
因此该测试依赖先运行 `pnpm --dir plugins/owner-console build`（根检查与 `pnpm check` 均先构建）。
`tests/client-render.spec.ts` 不依赖 DOM，桩掉 React hooks 后展开元素树，断言页头品牌、装饰元素
`aria-hidden`、状态胶囊带文字标签与空状态文案。

## 界面布局

- 页头：内联的文鳐主视觉 banner（`src/wenyao-hero.ts`，webp data URI，纯装饰 `alt=""`）、
  标题「文鳐 Ray」与朱红印章、副标题，以及主按钮「开始对话」。
- 卡片：统一圆角与边框，标题前一枚小云纹；状态用「圆点 + 文字」胶囊（ok/warn/error），不只靠颜色。
- 颜色只取宿主 `--dsw-*` 变量并带回退值，明暗主题通用；不引入外部 CSS、字体或网络资源。
  装饰 SVG 见 `src/art.ts`。

## 限制

- 一键模式只做 Host 环境变量探测，既不执行也不依赖 lark-cli；需要向导时由 owner 用系统已装的
  lark-cli skill 或其他方式自行提供 appId/secret 环境变量。
- 插件管理支持移除本项目 bundle（仅 `removable` 且非自身，且必须由浏览器确认；无确认通道时不执行）；
- **真实 Web GUI 已验证**：临时 profile + pinned DSH `0.2.1-rc.2` 下左侧栏入口、面板全部卡片、
  原生插件页已安装行、「打开插件页 / 开始对话」均通过（证据 `docs/evidence/owner-console/browser-smoke/`）。
  live Harness Mac app 现为 `0.2.2-rc.1`：owner-console `0.1.65` 的 tgz 经 app 自带的 dsh 装入
  `desktop` profile（peer 版本不符，需 owner 显式 `dsh plugin allow-version … --accept-risk`），
  2026-11-06 验证了侧栏入口、面板、插件页已安装行与「开始对话」（证据在被 git 忽略的
  `docs/evidence/owner-console/mac-live-app-20261106/`）。
  飞书/TraeX 三态卡片（未安装→安装、已安装未启用→启用、活动→配置）也在真实 GUI 中复验：
  启用动作返回 restart-required 并提示重启。登录态与真实飞书/模型连接仍未验收。
  本地 `pnpm pack` 产物（非 workspace 链接）经 `dsh plugin add <tgz>` 安装也已验证：随包依赖
  `@deepseek-ai/schemastery` / `zod` 由 pnpm 一并装入，入口、面板与插件页已安装行正常；
  从 registry 发布后安装尚未验证。
  面板安装只接受 `@dsh-enhanced/*` 包名（不支持任意本地/git 源）。
- 面板会列出 `owner-console` 自己的 bundle/entry：禁用它会隐藏这个入口，需用 `dsh plugin` 或 CLI
  重新启用（与 DSH 原生插件页语义一致）。
- 「开始对话 / 打开插件页」调用 DSH 客户端 `uiWorkspace.startSession()` 与 `layout.selectPanel()`；
  两个服务在点击时惰性解析，缺少它们时入口与状态页仍注册。已在真实无头 Chrome 中验收：
  入口出现、面板渲染、插件页显示已安装行、开始对话进入 composer（证据同下）。
- 停用 bundle 只摘除 patch 层，依赖与包文件保留；彻底移除仍用 `dsh plugin remove`。
- 连接状态是 `lark-channel` 自己报告的快照，面板不主动探测飞书；「已连接」来自通道的长连接状态，
  没有用真实飞书 Bot 验收过（按用户要求延后）。
- 不校验 app secret；secret 的写入通道留给 keychain 切片。
