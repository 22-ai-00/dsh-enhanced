# 安装 dsh-enhanced

当前是实验性版本；安装成功表示服务可用，不表示普通使用驱动的完整自迭代闭环已验收。进展见 [RSI 当前状态](../../docs/rsi-status.md)。以下是 macOS / Linux 新用户的默认路径。

## 准备

- 推荐安装 [Node.js 24 LTS](https://nodejs.org/en/download)（推荐 `>=24.9.0`，与各包 `package.json` 的 `engines.node` 一致；当前安装脚本预检仍兼容 22.19+ / 24+，详见[兼容性基线](../../docs/compatibility.md)），确保 `node`、`npm` 可在终端运行。安装器会检查和准备兼容的 DSH 与 pnpm。
- 默认安装需要飞书账号，以及已登录的本机 **TraeX (`traex`) / Antigravity (`agy`)** 或模型服务的 API Key。按向导选择机器人、发送验证码绑定本人；服务启动后再发送 `/model`，建立真实聊天会话。步骤见[连接飞书](../../plugins/lark-channel/docs/setup.md)。暂不接飞书可选下方[只用本机 Web](#只用本机-web)。
- 在信任的机器和账号上运行。新安装且没有既有权限设置时，后续新会话默认 **Full access**：可访问文件和网络，不逐次请求批准。已有权限设置和会话选择会保留。若需收紧新会话默认，安装时加 `--permission workspace-write`（人工批准）。原生自动审查在 Harness 当前会话中选择，助手内部自动审批由已绑定主人发送 `/permission auto` 开启。
- macOS 原生安装、新工具构建与验证无需 Docker。Linux 新安装的默认完整学习场景采用原生隔离，需要可用的 systemd 用户服务、bubblewrap（`bwrap`）与已委派的 cgroup v1 四控制器或统一 cgroup v2 子树；环境不足时可能只能完成普通助理安装，学习授权会报告未就绪。旧部署不会自动切换 backend。完整环境前提与实验性 `autonomy` 的边界见[维护说明](maintenance.md#实验性-web-与-autonomy)。

## 安装：默认 supervised

在**交互式终端**运行：

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
dsh-rsi install
```

默认 `supervised` 包含飞书常驻助理、`owner-console`（「文鳐」控制台与原生设置 UI）、`assistant-proactive` / `assistant-growth-driver` / `assistant-memory-learning` / `assistant-work-items` 等自主组件。安装器解析并固定兼容的 DSH Host（`0.2.2-rc.5`）和同批插件版本；遇到未知 Host 版本会拒绝安装，并把绑定的 Host 写入 `$DSH_HOME/.dsh-rsi-host.json`。第一次安装请按终端向导完成飞书应用、本人绑定、模型与可选能力选择。

交互式首装先问一次“按推荐配置一路继续 / 逐项自定义”：
- **推荐继续**：自动探测本机 `PATH` 上已登录的 `traex`/`trae-cli` 与 `agy`（均先用无交互命令检查，必要时启用 `traex-acp-provider` 并通过 `--default-if-absent` 在未设默认模型时设为默认），缺少本机 agent 登录时则配置 DeepSeek 官方默认模型 `deepseek-v4-flash`（缺少 Key 时隐藏输入一次，存入 `0600` 的 `$DSH_HOME/.credentials.yaml`）；随后连接飞书、验证模型 route、等待首次 owner 会话（最长 600 秒，`--owner-wait-seconds <n>` 调整，`0` 关闭），并执行 `dsh-plugin-setup preset recommended`。
- **自定义或显式选项**：可用 `--proactive <auto|on|off>`、`--dreaming <auto|on|off>`、`--growth <auto|on|off>`（引导模式下使用白话询问是否打开；选择结果与 `--learning` 一并持久记录到 `$DSH_HOME/.dsh-enhanced/install-intent.json`）以及可重复传入的 `--with <coding|traex|console|health|heartbeat|events|bridge|proactive|dreaming>` 按需组合；其中 `assistant-dreaming` 默认以 `enabled: false` fail-closed 休眠安装，只有显式补齐 `scope.{workspace,preset,principalId,ownerRouteId}`、`$DSH_HOME` `databasePath`、`provider`/`model` 与 `budgetId`/`budgetAmount` 后才会启用。已有模型或飞书配置会保留。

全新 managed `supervised` 安装还会在 owner 学习配置生成后自动、幂等地再应用一次 `recommended` 装配（步骤显示为“自治学习装配”）：WorkItems 以 `enabled: true`、`mode: observe`、`intakeLedger.enabled: true` 落库，交付/评测/事件轮询等有限开关一并打开。全新 profile 的 RSI owner 安装同时生成只观察 intake evaluator 的规则与模型 route、WorkItems 评估开关和三份带 `workItemExperiences` 的记忆授权，预设随后只按既有前置打开对应开关。该装配只修改已安装且未禁用的插件行，不打开 admit/auto/worker，也不改 Policy、凭据、ownerRoutes 或密封状态；签名 `workItemAuthorities` pin、修订采用密钥等 owner 授权材料仍不自动生成，缺前置时在输出中逐项 skipped。显式 `--plugin-preset skip`、引导中选择否，或对已有 profile 重跑安装时都不会隐式改写其显式插件配置。

全新 `supervised` 首装的普通使用/记忆学习授权是显式、可持久的安装决策：可用 `--learning authorize|skip` 指定（引导式首装会单独问一次；默认仅对全新 `supervised` 为 authorize，`--yes`/非交互采用同一默认并在输出中说明）。决策在创建 profile 前原子写入 `$DSH_HOME/.dsh-enhanced/install-intent.json`（0600，所在目录 0700；新建 DSH_HOME 也以 0700 创建，既有 Home 权限不改）；重试沿用该决策，不会把 skip 变 authorize，也不会重复签发或续期授权；marker 无法通过校验时拒绝继续（fail-closed，不回退猜测）。`--learning skip` 在 Linux 上不生成普通使用/记忆学习授权，也不写 learner、personal-memory 或 verifier 的学习配置（owner setup 收到 `--skip-memory-learning`）；supervised 常规 RSI 的 Growth/Automation 预算与规则仍按场景配置，它们不属于学习授权。显式 `--learning` 只接受全新 profile：既有安装（未记录决策）会拒绝并提示沿用记录或改用新 profile。macOS 原生 owner 部署必须 authorize，跳过会被拒绝。已有 profile 未记录决策时安装器保留其现状，不新增或撤销学习授权。

`--yes` 跳过场景菜单；若环境中已有 `DEEPSEEK_API_KEY`（或 `DSH_ENHANCED_MODEL_API_KEY`）且尚未存储 Key，会自动配置上述默认模型并把 Key 写入 `.credentials.yaml`。`--yes` **不能跳过首次本人绑定**（飞书应用确认和 `DSH-CONNECT` 短语仍需本人完成，之后只有已绑定的 owner 能操作和授权），也不能确认已有 active/paused Automation；后者需要显式 `--ack-existing-automations`。

已有模型选择会保留；没有可用默认模型时须在引导中配置。API Key 只从环境变量或隐藏输入读取，不要写在命令参数中，安装输出也不会打印 Key。授权有期限和预算，重试不会自动续期。事件来源、账号读取和主动提醒还需要单独配置与授权，见[事件来源](../../plugins/event-triggers/README.md)及[主动跟进](../../plugins/assistant-proactive/README.md)。

## 打开 Web 并验收

安装结束后可直接用 `dsh-rsi open` 打开本地 Web UI 与「文鳐」控制台，并用 `doctor --json` 做无交互只读检查：

```sh
dsh-rsi open --profile web          # 等待受管地址并在桌面自动打开浏览器（--no-browser 仅输出）
dsh-rsi status [--json]             # 查看 .dsh-rsi-host.json 绑定、安装意图与服务状态
dsh-rsi doctor [--profile web] [--json]
dsh-rsi web-url --profile web       # 仅读取已运行服务的带 token URL
```

在浏览器打开授权地址（勿公开分享 token），即可在左侧栏 **文鳐** 或 **Settings → 文鳐助手** 中查看飞书连接、检测/切换 `traex` 与 `agy`，并管理 Proactive/Dreaming/Growth；也可给已绑定的飞书机器人发一条本人私聊确认回复。`doctor`（等价底层 `./scripts/install/doctor.sh --json`）只做结构化只读诊断，不代替真实对话或长期学习效果；服务未运行时先查看日志，`start` 只启动**已注册**的服务。

## 只用本机 Web

适合先在本机体验聊天与「文鳐」控制台，暂不连接飞书；无需 Docker。`--scenario web` 直接包含 `owner-console` 与 `assistant-web-owner`；极简 `--scenario core` 可按需追加 `--with console`。两者都不默认注册常驻服务，安装后直接运行 `dsh-rsi open --profile web` 即可自动读取 `.dsh-rsi-host.json` 绑定的 `0.2.2-rc.5` 私有 Host 前台启动并打开浏览器：

```sh
dsh-rsi install --scenario web --model skip --yes
dsh-rsi open --profile web
```

如需手动在前台直接拉起新安装的 `0.2.2-rc.5` 私有 Host，可运行（旧 Home 或自定义路径请先[查找绑定的 Host 入口](maintenance.md#查找私有-host-入口)）：

```sh
~/.local/share/dsh-enhanced/hosts/0.2.2-rc.5/node_modules/.bin/dsh --profile web
```

前台启动需要保持终端运行（Ctrl-C 停止）；它没有注册常驻服务，因此不用 `dsh-rsi web-url` 或 `start`。按[模型指南](../../docs/models.md)或左栏 **Settings** 配置模型后即可对话，切勿用另一个全局 `dsh` 代替 Home 绑定入口。

## 常用命令

```sh
dsh-rsi open --profile web
dsh-rsi status --json
dsh-rsi doctor --json
dsh-rsi growth-report --since 7d
dsh-rsi upgrade --check
dsh-rsi logs --profile web --lines 100
dsh-rsi restart --profile web
dsh-rsi install --help
```

只需升级全局 CLI：`dsh-rsi update`；普通日常用户的就地自助升级与自动回滚用 `dsh-rsi upgrade --check` / `--dry-run` / `--yes`。受支持的**现有 Linux 原 Docker 冻结 owner/cohort** 可先用 `dsh-rsi update --all --dry-run --yes` 看计划，再运行 `dsh-rsi update --all --yes`，从原绑定官方源码一次性迁移至 native 并更新至 `0.2.2-rc.5`（保留原 owner、授权与历史；空历史与代码层已实现的非空采用封存/审查库 v2 handoff 均尚未完成完整 live 实机验收）；旧 CLI 须先单独运行一次 `dsh-rsi update`。完整条件与恢复步骤见[冻结 owner 升级](maintenance.md#现有-linux-冻结-owner-程序升级)及 [CLI 升级说明](../../packages/dsh-rsi-cli/README.md#升级与重装)。macOS 必须先停止整个 Home 并显式确认；**冻结了原生 owner/source/cohort 资源的 Mac Home 暂不支持普通原地升级。** `dsh-rsi reinstall` 属于破坏性清理重装；先核对 [CLI 重装与 purge 说明](../../packages/dsh-rsi-cli/README.md#升级与重装) 和[维护说明](maintenance.md#彻底卸载purge)。

## 配置插件

安装后用 profile 内的 `dsh-plugin-setup` 查看和调整插件，无需手改 `cordis.patch.yml`：

```sh
bin=~/.dsh/profiles/web/node_modules/.bin/dsh-plugin-setup
$bin                                  # 终端内引导菜单
$bin list
$bin enable work-items
$bin set event-triggers pollerEnabled true
$bin preset recommended --dry-run     # 查看推荐的可选功能
$bin preset recommended --yes
$bin preset dogfood --yes             # 日常记忆/偏好通道自用预设（含 assistant-association，见 docs/examples/dogfood-macos.profile.json）
dsh-rsi restart --profile web         # 改动重启后生效
```

CLI 先读取原生有效配置，单项修改时自动保留整行其它配置，写入后核对生效，失败则恢复原文件。它拒绝写入秘密值、修改 Policy/Control Plane 与 owner 授权项，飞书凭据仍用 `dsh-lark-setup`。默认值不变；`recommended` 显式打开 work-items observe 台账与 intake 账本、Delivery `attentionAttachOverCap`、Evaluation 通知结果和 event-triggers 轮询，并在 owner 已声明前置时打开 intake 评估生产者、后台 WorkItem 经验/失败学习开关；模型路由与规则、签名 pin、修订密钥等不会由预设生成，未满足前置的项以 skipped 原因列出。`--plugin-preset dogfood`（配合 `--scenario web`）会自动补齐 `preference-learning`、`assistant-evaluation`、`assistant-verifier`、`assistant-memory-learning`、`assistant-work-items` 与 `assistant-association` 6 个顶层包，开启本地联想召回（S3 `dreaming`/`intakeSignal` 与 S4 `webLearning` 保持关闭）并强制主动通道停留在 `observe` 模式。安装器的 `--plugin-preset <name>` 与引导式首装的最后一问都调用 `dsh_enhanced_apply_plugin_preset`，写入后自动重启已注册的常驻服务；全新 supervised 安装的学习装配另见上文。完整说明见 [assistant-policy](../../plugins/assistant-policy/README.md#插件配置-clidsh-plugin-setup)。

逐环节就绪状态可用只读 `dsh-autonomy-doctor --readiness`（`assistant-web-owner` 提供，需匹配版本；Web/autonomy 场景的 Home 自带该入口）查看：它读取组合后的 profile，输出确定性文本加一行 JSON，覆盖安装/启用、WorkItems observe+intake、intake 评估生产者配置、交付自然反馈入口、后台学习开关、修订采用授权和 event poller；缺项标 not-ready 并给原因，必需环节未就绪时退出码为 1。它不激活 Host、不请求模型，因此不能证明运行时注册、Policy 或外部送达。

## 场景与参数入口

| 场景 | 适用情况 |
| --- | --- |
| 默认 `supervised` | 首次交互式安装；飞书常驻、`owner-console`、学习与有限采用，含 WorkItems observe 台账、Proactive/Growth 与首装学习装配。 |
| `--scenario lark` | 飞书常驻与偏好学习，无 supervised 成长层。 |
| `--scenario core` | 本机轻量核心，无飞书渠道和后台学习。**不默认注册常驻服务**，安装后用 `dsh-rsi open --profile <name>` 前台启动并打开 Web。 |
| `--scenario web` / `autonomy` | 本机 Web 控制台（`owner-console` + `assistant-web-owner`）及 Linux 隔离执行（`autonomy` 仅 Linux）；不默认注册常驻服务，可用 `dsh-rsi open --profile <name>` 打开。见[维护说明](maintenance.md#实验性-web-与-autonomy)。 |

常用开关与选装模块：
- `--with <addon>`（可重复）：`coding`、`traex`、`console`、`health`、`heartbeat`、`events`、`bridge`、`proactive`、`dreaming`（用于按需追加功能而不切全套场景）。
- `--proactive <auto|on|off>`、`--dreaming <auto|on|off>`、`--growth <auto|on|off>`：显式覆盖对应自主能力的安装决策并持久化到 `install-intent.json`（`dreaming` 启用前仍要求明确授权/作用域/模型与预算齐备，默认 fail-closed 休眠）。
- `--model-provider <route>`：指定 `deepseek-official`、自定义网关、`traex-agent` 或 `agy-agent`。

`dsh-rsi install --help` 显示全部安装器参数；[CLI 指南](../../packages/dsh-rsi-cli/README.md)说明 `open`、`doctor`、`install`、`update`、`reinstall`、`purge` 的边界。开发 checkout 的构建和本地安装命令见[维护说明](maintenance.md#本地-checkout-安装)。场景能力基础叠加为 `core ⊂ lark ⊂ supervised`；显式 `--lark skip` 或 `--no-service` 是有限安装，不等同于完整默认场景。

## 故障排查

- **`npm: command not found`**：先安装上面的 Node.js，重新打开终端，再运行安装命令。

- **提示需要交互式飞书引导 / 本人尚未绑定**：在真实终端运行 `dsh-rsi install`，按向导连接机器人；不要用管道或 `--yes` 绕过。
- **报 `exactly one current owner DM is required`**：交互式安装会在这一步前自动等待首次私聊；若等待超时、在非交互终端运行或传了 `--owner-wait-seconds 0`，先确认受管服务已启动，用本人账号给机器人私聊发送 `/model` 并完成卡片确认；保留已有绑定，再用相同的 `dsh-rsi install` 命令续跑。该步骤不要求重新授予业务权限。
- **没有 Web 地址或服务未运行**：先运行 `dsh-rsi status` 和 `dsh-rsi logs --profile web --lines 100`。仅对已注册服务使用 `dsh-rsi start --profile web`；若选了 `core` / `web` 或 `--no-service`，参照上文的私有 Host 前台命令及版本说明。
- **模型无法对话**：检查默认模型、登录或 API Key。安装时的模型设置会选择当前 profile 默认模型；参照[模型指南](../../docs/models.md)，勿把密钥贴入命令行或日志。
- **Linux 依赖构建被 pnpm 拒绝**：当前安装器已在 `dsh plugin add` 前自动写入经评审决策（`koffi: true`、`protobufjs: false`）；仅旧版安装器首装、报出决策表之外的未知待审包、或 profile 预设有冲突值时才需手工处理——在报错的 profile 目录用相同 pnpm 版本运行 `pnpm approve-builds <包名>`（或在 `pnpm-workspace.yaml` 写明布尔），再以同一 Home / profile 重试；不要批准全部待审脚本。更多首次安装依赖说明见[维护说明](maintenance.md#首次安装依赖审批)。
- **半装 bundle 残留（早期中断恢复）**：若历史首装在 `dsh plugin add` 阶段中断导致包已在 `dependencies` 中但未写入 `dsh.profile.bundles`，当前安装器会在 add 前自动移除同类半装残留并完成注册；极端历史现场的手工处理见[维护说明](maintenance.md#失败-add-的半装-bundle-自愈)。
- **升级或恢复被拒绝**：保留报错与状态，查看[维护说明](maintenance.md)和 [CLI 指南](../../packages/dsh-rsi-cli/README.md)；不要通过删账本或重装掩盖未知结果。

<details>
<summary>高级维护入口（保留旧章节链接）</summary>

## 旧链接与维护入口

以下章节保留旧锚点，具体步骤已移到维护说明。

### 旧 Home 的联合 Host / 源码迁移

见[联合迁移](maintenance.md#旧-home-的联合-host--源码迁移)。

### 已 applied、未首次采用的 owner 修复

见[owner 修复](maintenance.md#已-applied未首次采用的-owner-修复)。

#### 已运行但未就绪的修复后继

见[修复后继](maintenance.md#已运行但未就绪的修复后继)。

### Checkout 内的 pre-owner 冻结源码维护

见[冻结源码维护](maintenance.md#checkout-内的-pre-owner-冻结源码维护)。

#### 未启用 owner 的旧行为镜像

见[旧行为镜像](maintenance.md#未启用-owner-的旧行为镜像)。

## 为已有 Web Session 配置有限 Goal admission

见[Goal admission](maintenance.md#为已有-web-session-配置有限-goal-admission)。

</details>

## 配置默认模型

见[模型指南](../../docs/models.md)。安装器配置模型会设置当前 profile 的默认模型；已有明确选择会保留。
