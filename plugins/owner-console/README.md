# owner-console（文鳐 Ray）

个人助手「文鳐」（英文 Ray，小名小鳐；口号「小鳐小鳐，游而化飞」）在 DeepSeek Harness 左侧栏的
单一入口，即原来的「控制台」（主人控制台）；面板标题显示助手的名字与口号。改名只影响显示，包名、插件 id 与条目 id 仍是 `owner-console`。设计沿用
[dsh-superagent-prototype](https://github.com/22-ai-00/dsh-superagent-prototype) 的理念：
注意力是预算，只在被请求或书面规则允许时行动；只说需要人行动的话；一次一个问题；概念和设置尽量少；
面板只展示需要人处理的事。

当前切片：**专属对话窗口 + 设置页**。

- **对话窗口**（左侧栏「文鳐」的默认视图）：正文和 composer 复用 DSH 自己的
  `conversation.content` 组件工厂，通过 renderer 注入的 `SessionProvider` / `renderSlot` /
  `renderFactorySlot` 渲染在插件自己的 `main` 面板里。消息流、发送、附件、停止、权限 chip、
  模型选择、工具/审批/计划行和空态都来自原生实现；本插件不复制这些组件，也不启动第二个
  Agent loop。右上角「原生会话」把同一条会话切到 DSH 原生会话视图。
- **设置页**（右上角 ⚙）：保留原有只读状态 + 主人点击的一次性配置与管理动作。配置写入只经
  Host `settings` 服务合并到指定条目；bundle/条目管理与安装只经 Host `pluginManager`。
  两类动作都由主人点击触发，不发起模型调用、不创建 Bot、不接受明文 secret、不改动未列出的
  插件。安装会把 pnpm 子进程和 registry 网络调用委托给 DSH 自身的 plugin manager，不在本插件里
  实现网络或进程逻辑。

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

- **会话生命周期**：客户端只调用 Host 注入的 `sessions` / `uiWorkspace` / `conversation` 服务。
  首次打开用 `workspaces.initializeDefault()` 解析默认工作区，再用 `uiWorkspace.connectWorkspace()`
  创建/复用会话（不可用时退回 `sessions.create()`）；随后 `sessions.retain(id,
  {source: 'ownerConsoleChat'})` 取得 `SessionBinding`，面板卸载时 `release()`。会话 id 存在
  `localStorage['dsh.owner-console.chat-session']`，过期或打不开时清除并重新创建。
- **原生正文**：主入口声明一个 session-scoped 子槽；renderer 因此注入 `SessionProvider` 与
  `renderSlot`。子槽按原生 `conversationPhase` 同样的规则计算 `phase`，然后
  `renderFactorySlot('conversation.content', {variant: 'embedded', phase, hero: false}, …)`。
  `hero: false` 关掉工作区选择器和 agent preset 座；面板不会渲染目录清单。
- **语音**：「语音对话」用浏览器 `SpeechRecognition`（`webkitSpeechRecognition` 回退）识别，
  通过 `conversation.input.for(actx).setDraft()` + `focus()` 写入**原生 composer 草稿**；
  「朗读」用浏览器 `SpeechSynthesis`。浏览器没有对应 API 时按钮禁用并在 tooltip 中说明。
  语音识别/合成由浏览器（或其服务商）完成，不是 DSH 模型；插件不录音、不保存音频。
  **隐私边界**：常见浏览器会把麦克风音频或待朗读文本发送给浏览器厂商自己的语音服务，
  这段链路不经过 DSH 的权限模型、策略与审计，也不受本插件控制。
- **权限**：当前值读会话 `permissions` projection，可选目录读
  `ctx.get('remote.permissionPresets').catalog()`；切换只提交原生 `/permission <preset>` 命令，
  不直接写会话状态、不绕过 Policy。原生 composer 的权限 chip 在可用时是主入口；本插件自己的
  权限行只在原生 chip 不可用（或没有 renderer 的降级窗口）时显示。高风险预设仍走原生/面板的
  显式确认。
- **附件**：原生 composer 的附件按钮与上传/回执路径原样可用。降级窗口（没有 renderer seats 的
  嵌入）用 `fileUpload.upload` / `uploadImage` 取得 receipt，再以 `{type: 'file', receiptId}`
  交给 `SessionFace.prompt`；服务缺失时只显示可见限制，不伪造附件。
- **降级窗口**：当 renderer 没有注入 `SessionProvider` / `renderSlot` / `renderFactorySlot`
  （非 Web renderer 的嵌入或旧 Host）时，面板退回自包含实现：从 `binding.eventSource` 折叠
  文本消息/工具行/错误，用 `SessionFace.prompt` 发送，用 `fileUpload` 上传附件。它是诚实的
  最小可用面，不是完整原生渲染；真实 DSH Web 走上面的原生工厂路径。

### 设置页（⚙）

设置页保留以下配置卡片：

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| 远程接入（飞书） | 接入方式、`lark-channel` 条目、连接状态（`larkChannel.health()` 快照）、appId 是否配置；两种对接：直接填写 appId + secret 引用，或从 Host 环境一键探测 appId | `settings.describe` + `larkChannel.health()` |
| TraeX | `traex-acp-provider` 条目、是否启用、命令 | `settings.describe` |
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

卡片按实际状态给出下一步，状态由 `bundles[].enabled` 与 `plugins[].fiberPhase` 判定，不再把
“条目不在 `settings.describe()` 里”一律当成未启用：

- 未安装：显示「安装 lark-channel」（走 Host pluginManager 的 pnpm 安装，只装该包及其 pnpm 依赖）；
- 已安装但 bundle 未启用：显示「启用 lark-channel」；
- 已启用但 fiber 为 pending / failed / 无条目：显示「已启用，等待依赖服务 / 已启用但加载失败 /
  已启用，但 Loader 没有条目」，附 fiber 阶段、诊断、缺少的 companion 服务（及对应要安装的
  `@dsh-enhanced/*` bundle）和一段可复制的最小 `cordis.patch.yml` 修复行；此时绝不显示「启用」
  （对已启用的 bundle 是无效动作），也不会把配置拒绝推给泛化文案；
- fiber active 且条目有 live 字段：才显示配置表单。

安装只包含该包本身及其 pnpm `dependencies`；`peerDependencies` 里的 `@dsh-enhanced/*` bundle 与它
在 profile 里需要的 Host 服务不会随安装自动装上，缺失项由上面的状态区列出。
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
  不在此面板处理，避免面板成为任意代码源入口。安装/启用后如返回 `restart-required`，按提示重启 profile。
- **依赖构建脚本**：pnpm 可能拒绝依赖的构建脚本（`ERR_PNPM_IGNORED_BUILDS`）。Host 记录到
  `pendingBuilds` 时，面板会先让主人确认，再用这些精确名称重试。Host 未记录（当前 Host 的解析没认出
  带 ANSI 的输出）时，面板会从失败输出中读出依赖名交给主人确认；确认后若 Host 仍返回 `stale-approval`，
  面板把确认过的名称写入当前 profile 的 `pnpm-workspace.yaml`（`allowBuilds: <name>: true`，原子写入、0600），
  再重试一次。不会自动放行，也不会写入未确认的名称；Host 安装器本身的缺陷未在面板内修补。
- **不兼容版本**：Host 以 `incompatible-version` 拒绝时，面板列出被拒的 `包@版本`、缺失的 DSH peer
  要求与当前 DSH 版本，并提示更新插件或为这个精确版本授予兼容豁免后重试。
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

- 本插件自身不直接读写文件、不直接联网、不直接起子进程、不读取凭据；需要落盘的动作都委托给
  Host 的 `settings`（配置）与 `pluginManager`（bundle/条目管理与 pnpm 安装），由后者执行。
- 安装动作因此会经由 Host 启动 pnpm 并访问 registry（与 `dsh plugin` 相同）；只在主人点击时发生。
  依赖构建脚本只有在主人于面板再次确认后、且仅针对 Host 记入 `pendingBuilds` 的精确名称才被批准。
- 配置写入只经 Host `settings.mutate`，且限定到单个已安装条目；bundle/entry 管理只经 Host
  `pluginManager` 且限定 `@dsh-enhanced/*`；授权来源是主人自己在面板上的点击，不是模型工具调用，
  也不存在后台自动写配置。
- 对话窗口只读取当前 retained Session 自己的 `eventSource` / snapshot / `permissions`
  projection，用来显示状态、降级文本和朗读；不读取其它会话、报告或记忆，也不上报内容。
  client bundle 只依赖宿主提供的 `react`（以及 `react/jsx-runtime`）与 Host 注入的客户端服务，
  不 import 其它 DSH 组件包；原生正文由 renderer 的 factory seat 渲染。
- 语音识别/合成由浏览器完成，音频或文本可能发送给浏览器厂商的语音服务（不经过 DSH 权限模型与审计）；
  插件不录音、不保存音频，只把最终转写写进当前会话的原生草稿。
- 安装/移除仅由主人点击触发，走 DSH 官方安装路径；移除只对 Host 标记为 `removable` 且非本面板自身的
  bundle 显示，并需浏览器确认（无确认通道时给出可见提示并停止）；不改动未列出的条目；
  secret 明文不接受、不存储、不回显。

## 测试

`tests/client-bundle.spec.ts` 用 Web 外壳的 `__ModuleLoader__` 契约加载实际构建产物
`lib/client.js`，以真实 `react`/`react/jsx-runtime` 执行 factory，断言 sidebar / main /
session-scoped 子槽三个注册与释放；并断言侧栏标签为「文鳐」、main 槽根容器填满固定高度、产物
内联 4 个 webp、包含原生对话与设置标记且不含外部图片 URL。因此该测试依赖先运行
`pnpm --dir plugins/owner-console build`（根检查与 `pnpm check` 均先构建）。
`tests/chat-dom.spec.ts` 在 jsdom 中真实挂载 React DOM，覆盖：降级消息列表与 composer 发送
(`SessionFace.prompt`)、附件上传 receipt、上传服务缺失时的可见限制、语音不可用禁用/tooltip、
可用时浏览器识别写入草稿、权限投影与 `/permission` 切换、renderer seat 下的原生
`SessionProvider`/子槽渲染、原生 phase 计算、语音写入原生草稿、齿轮打开设置页并保留全部卡片、
返回对话。`tests/chat.spec.ts` 覆盖事件折叠、工具状态、会话创建/复用/过期、上传失败、权限标签等
纯函数。`jsdom` / `react-dom` / `@types/react-dom` 只作为测试 devDependencies，不进入客户端产物。
`tests/client-render.spec.ts` 不依赖 DOM，桩掉 React hooks 后展开设置页元素树，断言页头品牌、
11 深海觉醒主视觉/面板背景/印章/侧栏图标均为纯装饰（`alt=""` + `aria-hidden`）、状态胶囊带文字
标签与空状态文案。

## 界面布局

- **对话窗口**：紧凑页头（圆形鲸标、标题「文鳐 Ray」、状态胶囊、副标题、右上角「原生会话」与 ⚙），
  下面是语音/朗读工具行；正文和 composer 由 DSH 原生会话骨架占满剩余高度。原生 composer 自带
  发送、附件、权限 chip、模型选择与停止，宽屏居中、窄屏自适应。
- **设置页**：顶部「← 返回对话」+「设置」；下面是保留的 11 深海觉醒 3:1 主视觉 banner（webp
  data URI，纯装饰 `alt=""`）、标题与圆形鲸印章、副标题，以及「开始对话 / 打开插件页」；再往下是
  配置卡片。
- 两个视图共用同一套背景：方形鲸图以低透明度铺在面板表面、内容之下，文字仍落在主题卡片/原生
  会话表面上，明暗主题的对比度不变。
- 侧栏入口图标与设置页印章都来自 11 深海觉醒 `icon.png`（方形裁切，可作圆形头像裁切）。
- 卡片：统一圆角与边框，标题前一枚小云纹；状态用「圆点 + 文字」胶囊（ok/warn/error），不只靠颜色。
- 颜色只取宿主 `--dsw-*` 变量并带回退值，明暗主题通用；不引入外部 CSS、字体或网络资源。
  装饰 SVG 见 `src/art.ts`。

### 主视觉与图标资产

源图 `11_深海觉醒/background.png`（1254×1254，1893031 bytes）与 `icon.png`（1254×1254，
1240250 bytes）不入库；只提交 `assets/` 下压缩后的派生文件（合计约 88 KB）与内联结果
`src/artwork.ts`，因此 `lib/client.js` 仍然自包含。构建本身不重写 `src/`；`tests/artwork.spec.ts`
校验已提交的 `src/artwork.ts` 与 `assets/` 逐字节一致，资产重新压缩后忘记刷新会直接测试失败。
`assets/` 不随 npm 包发布，也不需要发布：数据已内联在 `lib/` 中。

重新生成派生资产（仅当源图变化时；需要 Python + Pillow）：

```sh
python3 plugins/owner-console/scripts/prepare-assets.py /path/to/kunpeng-11/11_深海觉醒
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
  中已确认原生正文、composer、附件按钮、权限 chip、模型选择与语音工具行都在面板内（证据
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
- **语音是浏览器能力**：「语音对话」/「朗读」分别依赖浏览器 `SpeechRecognition` /
  `SpeechSynthesis`；不可用时按钮禁用并在 tooltip 说明。识别/合成由浏览器（及其可能的服务商）
  完成，不是 DSH 模型；插件不录音、不保存音频。**常见浏览器会把音频或待朗读文本发给浏览器厂商的
  语音服务，这段链路不经过 DSH 的权限模型与审计**；真实麦克风与真人语音未验收；jsdom 用桩覆盖
  降级与草稿写入，真实 Chrome 用注入的假识别器验证了「转写写入原生 Lexical 草稿」。
- **语音写入原生草稿会替换/追加纯文本**：通过 `conversation.input.for(actx).setDraft()` 写入；
  当前已有引用 chip 时，`setDraft` 会把草稿变为纯文本（浏览器语音的固有边界）。原生输入服务
  缺失时按钮仍可点，但会显示可见失败，不会静默。
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
  五张卡片渲染、返回对话正常。live Harness Mac app 为 `0.2.2-rc.1`：owner-console `0.1.65` 的
  tgz 经 app 自带 dsh 装入 `desktop` profile（peer 版本不符，需 owner 显式
  `dsh plugin allow-version … --accept-risk`），更早验证了侧栏入口、面板、插件页已安装行与
  「开始对话」；本次对话窗口未在 live app profile 复验。
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
