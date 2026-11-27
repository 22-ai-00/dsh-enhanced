# @dsh-ray/traex-acp-provider

把同一台机器、同一 OS 用户已经登录的 **TraeX / TRAE CLI（`traex-agent`）** 与 **Google Antigravity CLI（`agy-agent`）** 注册为 DeepSeek Harness 的本地 ACP model provider。DSH 在这里是 **ACP client**：每次模型请求都会在校验 live Agent session 工作区后启动新的受限 ACP 子进程（`traex acp serve` 或 `agy acp`）、完成 ACP v1 握手、创建会话、校验模型/effort，并把握手目录作为非权威展示缓存。普通 `agent_message_chunk` 会映射为 DSH 文本；当请求带 DSH tool schema 时，后端返回受控工具信封，插件把它转换成 DSH 原生 tool call，由 Harness 执行后进入下一 step。当 DSH 挂载了 `ctx.attachments` 且 ACP 后端在 `initialize` 握手时声明 `agentCapabilities.promptCapabilities.image: true` 时，插件同时支持用户附件图片与 `read_image` 工具结果图片，按 1-based 顺序通过原生 ACP `ImageContent` 转发给模型（且图片字节独立于文本 prompt，不占用 `agy acp` 的 `<USER_REQUEST>` ~192 KiB 文本上限）。

启用时，插件会在同一个 `LlmRuntime` 上通过 `@dsh-ray/llm-route-capabilities` 为启用的 route（`traex-agent` / `agy-agent`）发布 `toolCalls: bridge`，并随 Cordis fiber 撤回；同时在支持时向 `LlmRuntime` 登记可配置 provider 目录，便于设置界面识别和切换。这个字段只描述 adapter 如何把模型输出投影成标准 DSH tool call，不参与 Delivery/Automations 准入，也不改变模型可见的工具或 Skill；真正的工具授权与执行仍由统一的 Agent Loop、Policy、审批和 sandbox 负责。

这不是订阅 OAuth 转接，也不是模型 API provider。认证、模型供应、网络请求和可能产生的费用均由本机 TraeX / Antigravity 负责；插件不读取或托管 token。仓库中的 [`@dsh-ray/acp`](../acp) 方向正好相反——它让 DSH 自己成为供编辑器调用的 ACP agent。

## 前置条件

### TraeX（`traex-agent`）

需要包含 ACP server 的 TraeX 版本。先在运行 DSH 的同一用户下检查：

```sh
traex --version
traex acp serve --help
traex login status
```

`--version` 只是人工兼容记录；运行时的机器门禁是精确 `login status` 加 ACP `initialize` 返回的 protocol / agent identity / auth method，不依赖对版本文本的宽松解析。

一键安装器自动检测 `traex` / `trae-cli` 并补入实际可执行路径；手动安装时可在插件配置中覆盖 `command`。首次登录应在 DSH 外单独完成，例如本机版本提供的 `traex login --sso` 或 `traex login --sso-device`；插件不会启动交互式登录或打开浏览器。

公开的 ByteDance `trae-agent` Python 项目与这里检测到的 TraeX / TRAE CLI 不是同一个运行时。只有 `acp serve` 可用且握手返回 `agentInfo.name = "traex-acp"` 或 `"traecli-acp"` 的实现会被本插件接受；仍要求 ACP protocol v1 与 Trae SSO 认证方法。

### Google Antigravity CLI（`agy-agent`）

需要包含 `acp` 子命令的 Antigravity CLI（已验证基线 `agy 1.5.9`）。在运行 DSH 的同一用户下检查：

```sh
agy acp --help
agy models
```

`agy` 没有 `login status` 子命令，也没有独立 `acp serve` 子命令；未登录时 `agy models` 会以非零退出并提示登录，而 `agy acp` 会在 `session/new` 返回 JSON-RPC `-32000 Authentication required`（映射为 `ACP_AUTH_REQUIRED`）。首次登录请在 DSH 外运行交互式 `agy`（或 `agy acp --login`）完成 Google 账号认证；插件不会启动交互式登录或自动读取 API key 环境变量。只有 `initialize` 返回 ACP protocol v1 且 `agentInfo.name = "Antigravity ACP Server"` 的实现会被接受。

## 安装

```sh
dsh plugin --profile web add @dsh-ray/traex-acp-provider
dsh --profile web --dump-config
```

直接添加 bundle 时该实验性 route 默认关闭；一键安装器发现本地命令后自动启用。手动安装确认本机版本、登录和 ACP 入口后设置 `enabled: true`，再在 DSH 的 provider/model 选择处选择 `traex-agent`。首次打开模型选择器时，`listModels` 会自动执行一次不提交 prompt 的只读 ACP discovery，展示当前账号完整模型目录；并发查询共享同一次发现，短 TTL 内直接复用，过期后刷新。`default` 沿用 TraeX 当前模型。具体模型和 effort 都通过 ACP session config option 选择，不会拼进 shell 命令。

### 设为部署默认模型

除了在选择器里临时选用，也可把 `traex-agent` 设为该 profile 的部署默认模型。个人助理套件的 `dsh-model-setup`（见 [`personal-assistant`](../personal-assistant/README.md#配置默认模型)）会把 `agent-default-model` 指向 `traex-agent`，并在指定 profile 的 patch 层把本 route 置为 `enabled: true`：

```sh
dsh-model-setup --provider traex-agent --enable-in-profile web
```

一键安装器检测到本机 `traex` / `trae-cli` 就会自动安装并启用本 bundle，无需手动选插件。已登录且没有显式模型选择时，自动设置当前 profile 的默认模型；已有 settings/home/profile 选择以及 command/cwd 保留。没有登录时插件仍启用，但不会自动切换默认模型或宣称可对话；完成一次 TraeX 登录即可继续。`--model skip` 保留默认模型，仍自动启用插件。

关键区别：手动 `dsh-model-setup` 不带条件选项时写入的 `agent-default-model` settings 段被所有 profile 共享；自动安装使用的 `--default-if-absent` 只写目标 profile 的组合默认值；而本 route 的**适配器按 profile 注册**，只在启用了本 bundle 的 profile 里存在。因此把默认设为 `traex-agent` 后，只有已启用本 route 的 profile（默认 `web`）能解析它，`headless` 等未安装本 bundle 的 profile 会报 `NO_ADAPTER`。安装器的 `--model-route verify` 因此对 agent route 采用结构化验证（校验目标 profile 已注册适配器 + `traex login status`），不发模型请求、不消耗额度。`enabled` 仍是本 bundle 的最终开关。

## 快速开始（5 步）

1. **确认 ACP 可用**：`traex acp serve --help` 能打开、`traex login status` 输出 `Logged in using Trae`。命令名是 `trae-cli` 时用它替换下面的 `traex`。
2. **安装插件**：`dsh plugin --profile web add @dsh-ray/traex-acp-provider`。
3. **开启 route**：本 route 默认关闭，需在配置里显式设 `enabled: true`（命令名不同则一并改 `command`）。bundle 已把 `cwd` 设为 `$DSH_HOME/assistant-workspace`，与标准 Delivery 的新会话工作区一致；若覆盖整段 `config`，必须保留该值或同时把两端改到同一目录。
4. **落盘检查**：`dsh --profile web --dump-config` 确认 `enabled`、`command` 与 `cwd` 生效。
5. **选择模型调用**：打开 DSH 模型选择器；首次查询会通过安全、无 prompt 的 ACP discovery 加载 `traex-agent` 完整目录。选 `default` 会沿用 TraeX 当前模型，也可直接选目录里的具体模型与 effort。

每次调用会启动一个新的 `traex acp serve` 进程并消耗 TraeX 侧额度。遇到报错先看下文「协议与失败策略」的错误码表。

## 配置

完整配置如下。Cordis `config` 会整段替换，覆盖时请保留仍需使用的字段：

```yaml
- id: dsh-ray-traex-acp-provider
  name: '@dsh-ray/traex-acp-provider'
  config:
    enabled: true
    command: traex
    cwd: !!js dshHomePath('assistant-workspace')
    cwdMode: session
    models: [default]
    agyEnabled: false
    agyCommand: agy
    agyModels: [default]
    agyIncludeDefaultCustomizations: false
    agyDisableTelemetry: true
    agyMode: default
    timeoutMs: 600000
    contextWindow: 200000
    agyContextWindow: 128000
    authProbeTimeoutMs: 30000
    maxAuthProbeBytes: 32768
    killGraceMs: 3000
    maxMessageBytes: 2097152
    maxProtocolBytes: 16777216
    maxProtocolMessages: 10000
    maxOutputBytes: 2097152
    maxStderrBytes: 32768
    maxPromptBytes: 4194304
    agyMaxPromptBytes: 184320
    maxRequestImageBytes: 25165824
    extraEnvNames: []
    logDiagnostics: false
```

- `enabled` / `command` / `models` 控制 TraeX route（`traex-agent`），默认 `enabled: false`；`enabled` 与 `command` 均支持 live-editable 设置。
- `agyEnabled` / `agyCommand` / `agyModels` 控制 Antigravity route（`agy-agent`），默认 `agyEnabled: false`；`agyEnabled` 与 `agyCommand` 均支持 live-editable 设置，可与 TraeX 同时开启并在模型选择器中实时切换。
- `agyIncludeDefaultCustomizations` 默认 `false`（向 `agy acp` 传 `--include-default-customizations=false`），避免把 Antigravity 内置技能提示注入 DSH 后端上下文；`agyDisableTelemetry` 默认 `true`（传 `--disable-telemetry`）；`agyMode` 可选 `default` 或 `plan`，在 `session/new` 后通过 `session/set_config_option` 切换（`agy acp` 不接受 `--model` / `--effort` / `--mode` / `--disable-slash-commands` CLI flag，参数均通过 ACP `configOptions` 传递）。
- `command` / `agyCommand` 均是单个可执行文件名或绝对路径；插件固定参数数组并使用 `shell: false`，不接受 shell 片段。当配置为不带路径分隔符的裸命令名（如默认 `traex` / `agy`）时，适配器会先按 `PATH` 查找，再依次检查标准用户/系统安装目录（POSIX：`~/.local/bin`、`~/.antigravity/antigravity/bin`（仅 `agy`）、`~/.npm-global/bin`、`~/Library/pnpm`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`；Windows：`%APPDATA%\npm`、`%LOCALAPPDATA%\Programs\{Antigravity,Trae}\bin`、`%USERPROFILE%\.local\bin`），避免在 launchd / Desktop GUI 精简 `PATH` 下因 `ENOENT` 回退为空目录；若配置了显式路径则严格原样使用不做回退，未找到时原样传出以保留标准 `CLI_NOT_FOUND`。
- `cwd` 与 `cwdMode`（`'session' | 'exact'`，默认 `'session'`，且 `cwdMode` 支持 live-editable）决定 ACP `session/new` 使用的工作目录；bundle 默认将 `cwd` 设为 `$DSH_HOME/assistant-workspace`，与标准 Delivery 默认值一致。相对路径按 DSH 进程启动目录解析。每个**带 prompt 的普通对话调用**或**由 Host `claimCompaction` 核验的 compaction 摘要请求**必须是深冻结的 DSH Agent Loop 请求：同模块 marker 可直接验证；包被源码 link 或 DSH 在 adapter 边界复制请求时，则由 Host `agents` 服务核对仍在运行的精确 Agent、registry/session 对象身份，并从 live Session 的 header 与 derived messages 重建请求，只容许 `forAdapter()` 删除跨 route `replayState`。当 `cwdMode` 为默认值 `'session'` 时，插件对同一 live Session 的 `header.cwd` 做 `realpath` 验证并直接绑定给 ACP（即使尚未创建 `cwd` 目录或用户在 Desktop/Web 打开了不同项目文件夹）；设为 `'exact'` 时，则会把 `cwd` 与 live Session `header.cwd` 分别 `realpath` 后要求完全相等。缺失、过期、伪造、未核验的辅助/嵌套调用、请求变形、`exact` 模式下 cwd mismatch 或不存在的工作目录都会在 `traex login status` 和 ACP 启动前以 `LOCAL_SESSION_CWD_REQUIRED` 拒绝；ACP 收到的是 canonical live-session cwd。
- `listModels` 在缓存为空、过期或只有不完整的普通 stream 观察时，会通过当前 adapter 的 `probeReadiness` 执行 `traex login status`（仅 `traex-agent`）和无 prompt 的 ACP discovery，读取 2 维 `configOptions`（`model` 与逐模型 `thought_level` / `reasoning_effort`，完整透传 `low` / `medium` / `high` / `xhigh` / `max` 等档位；`default` 别名同时继承当前活动模型的 effort 档位）与 `agentCapabilities.promptCapabilities.image`。当 `ctx.attachments` 可用且最近一次有效握手未声明 `promptCapabilities.image: false` 时，`listModels` 与 `resolveModel` 会向 DSH 声明 `inputModalities: ['text', 'image']`（使得 `read_image` 与图片输入对所有模型包括 `agy-agent` 的 `gemini-pro-orchestrator-neon` 可用）；缺少 `ctx.attachments` 或握手明确声明 `promptCapabilities.image: false` 时回退为 `['text']`。它使用配置 `cwd`（若该目录尚不存在则安全回退到系统临时目录）、read-only sandbox、`ask-for-approval=never`，不携带消息内容，不声明文件/terminal capability，并拒绝 permission request。目录巡检中若单个模型的 `set_config_option` 返回非认证类 JSON-RPC 错误或无效的可选 reasoning 描述，只跳过该模型的 effort 元数据而不丢弃整份模型列表（认证错误 `-32000`、帧/协议错误与 `prompt` 执行路径仍严格 fail closed）。并发查询 single-flight；完整目录默认缓存 20 分钟（覆盖 15 分钟模型选择卡 TTL）。瞬态刷新失败（`timeout` / `protocol` / `process`）不会清空仍在有效期的已观测目录，`listModels` 会优先保留缓存观测，仅在 `auth-required` / `entitlement` / `not-found` 或无缓存时回退到配置别名，并只记录带无凭据 `outcome` 分类的固定诊断。
- `resolveModel` 仍然 **不认证、不启动子进程**，只读取配置与当前内存缓存以及按需探测 `ctx.attachments`，保证 Agent Loop 的 `prepareCall` 路径 process-free。真实 `stream` 不信任该展示缓存；它继续要求 live session + canonical cwd，并在握手时再次核验 `agentCapabilities.promptCapabilities.image === true` 后才提交带图片请求，同时以自己新建 ACP session 的目录重新权威校验模型与 effort。
- 部署工具仍可在启用 route 前显式调用包导出的 `probeTraexReadiness`，主动验证本机登录和完整目录；调用完成后应 shutdown 临时 adapter。adapter shutdown 会 abort 尚未完成的目录发现、清除 single-flight 引用与缓存。
- `models` 是实时 ACP 目录以外需要额外展示的非权威别名列表，默认只有 `default`。它不是执行允许列表；每次请求都会在新的 ACP 会话里重新验证具体模型，模型不可用时失败且不会静默换模型。若 DSH 已放行的 effort 在新会话的 selector 中消失，transport 会保留当前模型并使用该会话的默认档位，绝不重放 prompt。
- `timeoutMs` 覆盖握手、建会话和整轮 prompt。取消或超时时先发 ACP `session/cancel` 和 `SIGINT`，等待 `killGraceMs` 后升级为 `SIGKILL`，再等待一个等长窗口确认 `close`。仍未关闭时以 `teardown=failed` 错误结算，保留原始 abort/timeout 分类，并继续跟踪迟到的 `close`；不会伪称已完成回收。
- `contextWindow`（默认 `200000`）与 `agyContextWindow`（默认 `128000`）分别向 DSH 上报 `traex-agent` 与 `agy-agent` 的模型上下文窗口大小供会话压缩与模型切换校验；DSH 默认 `compaction-basic` 的 `headroomTokens` 为 `65536`，自定义时需在未预留请求 `maxTokens` 时保持 `contextWindow >= 80000`（若按常见 `maxTokens: 8192` 预留则需 `contextWindow >= 86212`，否则切换模型会触发 `MODEL_SWITCH_COMPACTION_FAILED`）。`agyContextWindow` 取 `128000`（扣除 `65536` headroom 与 `8192` 预留输出后压力阈值为 `54272` tokens、保留尾部 `19169` tokens），在避免切模型报错和反复压缩抖动的同时配合请求序列化精简贴合 `agy acp` 180 KiB 传输预算。
- `authProbeTimeoutMs` / `maxAuthProbeBytes` 限制每次 `traex-agent` live-session 调用前的 `traex login status`；`authProbeTimeoutMs`（默认 `30000`）同时作为 `listModels` 的 auth + ACP discovery 整体时限，目录查询不会沿用生成请求默认 10 分钟的 `timeoutMs`。当前 TraeX 可能把精确文本 `Logged in using Trae` 单独写入 stdout 或 stderr，这两种形式都会被接受，混合输出、ChatGPT、API key、access token、未登录与未知输出全部拒绝。`agy-agent` 不再额外起 `agy models` 进程，直接以同一次 `agy acp` `session/new` 验证登录状态（未登录返回 `-32000 Authentication required` -> `ACP_AUTH_REQUIRED`）。
- `maxMessageBytes`（默认 `2097152`，即 2 MiB）限制单条 NDJSON，`maxProtocolBytes` / `maxProtocolMessages` 限制整轮 ACP 输入，`maxOutputBytes`（默认 `2097152`）限制助手文本；字节限制均按 UTF-8 计算。
- `maxPromptBytes` 限制序列化后的 DSH 请求，默认 4 MiB；`agyMaxPromptBytes`（默认 `184320`、上限 `190000`）专用于 `agy-agent`（实际生效上限为 `min(maxPromptBytes, agyMaxPromptBytes)`），用于在 `agy acp` 对 `<USER_REQUEST>` 的 ~192 KiB 静默截断前于 preflight 阶段返回标准 `CONTEXT_WINDOW_EXCEEDED` 触发自动压缩。由于每次 ACP 调用都是无状态的独立子进程，序列化器会自动去重历史中已被替代的 `runtime-context`（`form: 'snapshot'`）与 `skill-catalog`（`update: true`）快照，把 `constraints` 置于 `conversation` 之前，在 `Antigravity` 路由附加禁止进入 plan mode / `exit_plan_mode` 的指令约束，精简 `constraints.tools.available` 中冗余的描述文本与非结构化 JSON Schema 字段（保留 `name`/`type`/`properties`/`required`/`enum`/`items`/`anyOf`/`oneOf`/`allOf`/`additionalProperties` 校验约束），并在普通请求超限时先有界裁剪较早历史中的超大 `tool-result` 文本块（完整保留最近一组尾部 `tool-result` 与所有 `{ "type": "image", "index": N, ... }` 描述符的 1-based 顺序），在 `purpose: 'compaction'` 超过字节上限时把历史图片替换为有界文本说明（不携带图片字节）并对历史正文按 UTF-8 安全裁剪与保留尾部摘要指令（仅保留工具名），避免频繁触顶与压缩死锁。若裁剪后仍超限，仍在握手前 fail closed 返回 `CONTEXT_WINDOW_EXCEEDED`，prompt 确定未进入 ACP 流。prompt 通过 ACP `session/prompt` 经 stdin 发送，**不作为 argv 元素**，不存在操作系统命令行长度限制；当请求携带图片时，文本 JSON 中只写有界元信息描述符，原生 base64 `ImageContent` 紧随文本块按 1-based 顺序发送。
- `maxRequestImageBytes`（默认 `25165824`，即 24 MiB；范围 `1024..67108864`）限制单次 ACP 请求中未卸载保留图片的原始总字节数。preflight 阶段在读取任何图片字节前通过 DSH `requiredImageOffload` 检查该预算，超限时抛出标准 `IMAGE_OFFLOAD_REQUIRED`（携带 `offloadImages`）触发旧图卸载重试；已标记 `offloaded: true` 的图片会被确定性地投影为文本占位符，不再读取或发送字节。只有在 live-session cwd 与认证校验全部通过后，插件才会从 `ctx.attachments.readImage()` 顺序读取并校验图片字节与引用一致性（`mediaType`、`bytes`、`width`、`height`、`attachmentId`），不会暴露或读取本地文件路径。
- `extraEnvNames` 只允许填写要从 DSH 启动环境继承的变量名，配置中不能写变量值或 secret。
- API key/token、Authorization/private-key/database credential 以及 OpenAI/Codex 等 provider endpoint 变量，即使列入 `extraEnvNames` 也会被硬排除；`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（含小写）代理 URL 中的 userinfo 会被删除，无法安全解析的含 `@` 代理值会被拒绝。
- `logDiagnostics` 默认为 `false`，此时对 stderr 只记录“TraeX 写入 stderr”；启用后仅记录经过常见 token/key/邮箱规则脱敏的有界尾部，仍不适合输出业务秘密。独立于该开关，插件始终会在每次请求结算时记录一条**无凭据**的生命周期诊断（阶段、prompt 是否提交、结果分类、teardown 状态、能可靠测得的毫秒级延迟指标，以及 ACP 返回时的纯数值 usage 快照），成功走 `debug`、非成功走 `info`；并在观测到模型目录时只记录**模型数量**。这些行不含 prompt、stderr 原文、认证凭据或任何 model id 原文；usage 快照可能包含 ACP 报告的 token 数量，但不会映射或转发为 DSH `TokenUsage`。

## 固定安全策略

插件只接受并启动下面两组受限 server 参数之一：

```text
# traex-agent
traex --sandbox read-only --ask-for-approval never acp serve

# agy-agent
agy acp --sandbox [--include-default-customizations=false] [--disable-telemetry] --stdio
```

不会传 `--yolo`、`--dangerously-skip-permissions`、`--login`、`--add-dir` 或任意用户追加参数。ACP client 不声明文件系统或 terminal capability；后端发起的每个 `session/request_permission` 都返回 `cancelled`。注意边界差异：`traex` 在 CLI 层同时支持 `--sandbox read-only --ask-for-approval never`；而 `agy acp --sandbox` 仅开启终端沙箱限制且没有 `--ask-for-approval never` 或 `--settings` flag——因此切勿在 `~/.gemini/antigravity-cli/settings.json` 中为不可信仓库开启宽松的自动放行规则，必要时可设 `agyMode: plan` 并始终结合容器/只读挂载隔离不可信工作区。模型请求的 DSH tool call 会返回 Harness，由 Harness 既有的工具注册、sandbox、权限和审计链决定是否执行；插件不会替它放行。

安全仍取决于外部 CLI 对其配置和沙箱的正确实现。不要把 prompt 约束当作操作系统隔离；处理不可信仓库时，仍应使用只读挂载、容器或独立 OS 账号。

## 权限与数据边界

| 能力 | 行为 |
|---|---|
| 文件系统 | 对 prompt-bearing 调用，只把经过 live-loop session 身份和 canonical `realpath` 精确校验的 cwd 发送给 TraeX，并强制 read-only sandbox。冷/过期的 `listModels` 可在配置的 static cwd 启动无 prompt、read-only/no-approval discovery；`resolveModel` 不启动进程。插件本身不提供 ACP 文件读写接口。 |
| 网络 | 插件本身不直连模型服务；TraeX 会连接自己的认证、推理、更新或遥测服务。 |
| 子进程 | 每次经过 live-session 校验的请求直接启动一个 TraeX ACP stdio 子进程，`shell: false`，并从同一握手观察目录。冷/过期的 `listModels` 或部署者显式调用 `probeTraexReadiness` 时，会另开无 prompt 临时 ACP 会话；并发列表查询只启动一个。取消/shutdown 时先 abort discovery 或走 ACP cancel，再回收进程组；Windows 后代进程回收为 best-effort。 |
| 凭据 | 不读取 TraeX auth 文件、不实现登录、不刷新或上传 token；只让 TraeX 在本机用户配置目录中使用自己的缓存凭据。 |
| 浏览器 | 插件不会打开浏览器；用户在插件外执行 TraeX login 时可能打开。 |
| ACP 权限 | 所有 permission request 均拒绝；不暴露 client-side FS、terminal 或 MCP server。 |
| DSH 工具 | 请求中的 tool schema 会进入模型隐藏的兼容协议；只接受本次实际声明的精确工具名和对象参数，随后映射为 DSH tool call。工具声明只表示可用性，不构成授权；模型须遵循序列化的 DSH system/user 指令和先前 tool result。某项操作被 user、Policy 或缺失授权拒绝后，除非后续经授权的 user 或 system 指令明确允许，模型不得重试、绕过或以等效操作替代；参数无效且工具回执建议只读发现时可以在原授权内纠正。模型可以继续独立获准的工作，或如实说明阻塞，不能把未发生的工作称为完成。真正的读写、网络、子进程或外部服务权限仍由对应 DSH 工具及 Harness 策略控制。 |
| 日志 | 不主动记录 prompt；stderr 有界且默认不输出内容。每次请求结算记录一条无凭据生命周期诊断（阶段/提交状态/结果分类/teardown、可测得的毫秒级延迟指标，以及 ACP 返回时的纯数值 usage 快照），并在观测目录时只记录模型数量。均不含 prompt、stderr 原文、认证凭据或 model id 原文；usage 快照可能包含 ACP 报告的 token 数量。 |
| 安装脚本 | 包内没有 install/postinstall 脚本，也不会安装或更新 TraeX。 |

## 协议与失败策略

- 只接受 ACP protocol v1 和精确的 `traex-acp` / `traecli-acp` agent identity；版本或 identity 不符时 fail closed。
- SDK 前的 wire guard 会追踪 JSON-RPC request id；非法 envelope、未知/重复 response id、未声明的 filesystem/terminal request 和未知 notification 都会终止该轮，不交给 SDK 宽松处理。
- 只消费当前 session 的文本 `agent_message_chunk`；普通文本直接成为最终回复，严格匹配 `dsh-tool-calls/v1` 的信封会转换为 DSH tool call。thought、plan 和 TraeX 自己的 tool update 不会伪装成 DSH 输出。
- 工具信封只允许调用本次 `GenerateOptions.tools` 中存在的精确名称，参数必须是 JSON 对象。兼容模型把参数编码成 JSON 字符串的情况，但只解码一次，结果仍须是对象；数组、null、畸形文本和再次编码的字符串均拒绝。未知工具、空调用或畸形信封以 `ACP_PROTOCOL_ERROR` fail closed。参数继续交给原生工具校验和权限检查。截断终态不会执行工具信封。若模型误在合法信封前附加一小段进度说明，插件会只提取并隐藏该信封，避免原始 JSON 泄漏到对话界面；不含协议标记的普通 JSON 仍按文本处理。
- `end_turn` 是正常完成终态；`max_tokens`、`max_turn_requests` 都映射为 DSH `max-tokens` 截断终态，供上层决定是否创建新的补全 turn。`refusal`、`cancelled`、断连、畸形/超限 NDJSON、无文本或缺少终态都会失败。
- TraeX 可能仍在 stderr 记录 `unsupported call` 一类内部工具路由告警；这是其内部工具未向本兼容层开放，不等同于 DSH 工具失败。插件会要求模型只返回 `dsh-tool-calls/v1` 信封；若调用仍失败，生命周期日志会同时给出 phase、terminal、exitCode 和 signal，便于区分终态缺失、协议校验与进程退出。
- 已保存的 effort 可能在切换模型、账号权益变化或目录更新后失效。此时插件在 `session/prompt` 前丢弃该陈旧值，使用本次 ACP session 返回的当前默认档位继续执行；不会重放 prompt 或重复计费，生命周期日志会标记 `reasoningFallback=true`。下次打开模型选择器会显示新目录。
- Provider 不会重放同一个已提交请求。外部 agent 可能已经读取上下文或产生服务端计费，原请求自动重试会放大副作用；上层 `assistant-delivery` 可在持久化 `max_tokens` / `max_turn_requests` 终态后，选择创建新的、有界、禁止工具执行的后续 turn 来补齐回答，这不属于 Provider 重试。DSH 当前基线仍可能向 Provider 序列化 scoped tool schema，但恢复期间的任何工具调用都会在审批和执行前被拒绝。TraeX 的每个后续 turn 仍会启动新进程/session，并按一次新的模型调用消耗额度。

调用失败时返回的稳定 `LlmError` code 与排查：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `ACP_AUTH_REQUIRED` | 每次调用前的 `traex login status` 未精确报告 `Logged in using Trae` | 在同一 OS 用户下重新 `traex login`；ChatGPT/API key/access token/未登录都会被拒。 |
| `LOCAL_SESSION_CWD_REQUIRED` | 请求没有匹配的 live loop session，或其 canonical cwd 与配置 cwd 不完全一致 | 从真实 DSH Agent Loop 发起调用；确认 session header cwd 与插件 `cwd` 指向同一 realpath，且不要通过 symlink 跨出该目录。 |
| `ACP_ENTITLEMENT_REQUIRED` | 握手成功但当前 Trae 账号没有任何可用模型 | 确认账号权益/套餐，必要时在 TraeX 侧切换账号。 |
| `ACP_MODEL_UNAVAILABLE` | 请求的模型不在本次 ACP 会话的 model selector 中 | 刷新模型列表或用 `default`；账号权益或 TraeX 目录可能已经变化。 |
| `ACP_REFUSAL` | TraeX 明确拒绝了本次请求 | 属模型侧决定，调整 prompt 后重试。 |
| `ACP_TIMEOUT` | 握手+建会话+整轮 prompt 超过 `timeoutMs` | 简化 prompt 或调大 `timeoutMs`。 |
| `ACP_OUTPUT_LIMIT` | 助手文本超过 `maxOutputBytes` | 调大 `maxOutputBytes` 或缩小任务。 |
| `ACP_PROTOCOL_ERROR` | protocol/identity 不符、非法 envelope、无文本或缺终态 | 确认 TraeX 版本仍提供 ACP v1 + `traex-acp` 或 `traecli-acp` identity；升级后握手变化时插件会拒绝而非猜测。 |
| `ACP_PROCESS_FAILED` | 子进程非零退出或其他未归类失败 | 开 `logDiagnostics` 看脱敏 stderr；单独 `traex acp serve` 复现。 |
| `CONTEXT_WINDOW_EXCEEDED` | 序列化后的 DSH 请求超过 `maxPromptBytes`，在握手前失败 | 调大 `maxPromptBytes`，或压缩/清理对话历史；该上限只防本机内存膨胀，与 argv 长度无关。 |
| `IMAGE_OFFLOAD_REQUIRED` | 请求中未卸载保留图片的累计字节超过 `maxRequestImageBytes`（默认 24 MiB） | DSH 会按 `offloadImages` 卸载较早图片后重试；必要时调大 `maxRequestImageBytes` 或减少单轮保留图片。 |
| `ACP_IMAGE_UNSUPPORTED` | 请求包含图片，但 ACP 服务端在 `initialize` 中未声明 `promptCapabilities.image: true` | 确认本地 `traex` / `agy` 版本支持图片输入，或切换为纯文本请求（`promptSubmissionState: 'not-submitted'`）。 |
| `ACP_PROMPT_INVALID` | 请求中含无法序列化的内容（如缺失/校验失败的附件图片、`assistant`/`system` 图片、无 `attachments` 服务时的顶层图片或未知 block） | 确认附件存储 `ctx.attachments` 可用且图片完整有效，或移除非法/不支持的内容块。 |
| `CLI_NOT_FOUND` | 找不到可执行文件（`ENOENT`） | 核对 `command` 名称/路径及 `PATH`。 |
| `INVALID_PROVIDER` | 选择了非 `traex-agent` 的 provider id | 只使用 `traex-agent`。 |

- 认证不足会返回 `ACP_AUTH_REQUIRED`，无可用权益/模型分别映射为 `ACP_ENTITLEMENT_REQUIRED` / `ACP_MODEL_UNAVAILABLE`，明确拒绝映射为 `ACP_REFUSAL`；其他稳定错误包括 `ACP_PROTOCOL_ERROR`、`ACP_TIMEOUT`、`ACP_OUTPUT_LIMIT`、`ACP_PROCESS_FAILED`、`CONTEXT_WINDOW_EXCEEDED`、`IMAGE_OFFLOAD_REQUIRED`、`ACP_IMAGE_UNSUPPORTED`、`ACP_PROMPT_INVALID` 和 `CLI_NOT_FOUND`。
- 握手前的 prompt 序列化、图片卸载预算与附件校验失败一律带稳定错误码抛出，不会退化为未分类失败；此时 prompt 确定未进入 ACP 流，重试安全。
- `initialize` 未声明 `promptCapabilities.image: true` 时，`ACP_IMAGE_UNSUPPORTED` 会在 `session/prompt` 提交前失败，保持 `promptSubmissionState: 'not-submitted'`。

> 模型目录：`listModels` 在冷启动、TTL 到期或仅有不完整观察时调用 `probeReadiness`，以 prompt-free、read-only/no-approval ACP session 加载完整 2 维目录（模型 + 逐模型 effort）；单个模型的非认证 `set_config_option` 错误或无效可选 reasoning 仅跳过该模型 effort 而不丢弃整份目录。并发调用 single-flight，成功结果默认 20 分钟 TTL 复用；瞬态刷新失败保留仍在有效期的已观测目录，仅在 `auth-required` / `entitlement` / `not-found` 或无缓存时回退配置别名并输出无凭据 `outcome` 诊断。`resolveModel` 始终只读缓存、不做 I/O。每次真实调用仍以自己的 `session/new` 返回值为唯一执行依据，重新选择并核对模型与 effort；auth 失败、reload 或 shutdown 会清除缓存。目录日志只输出模型数量，不含 model id 原文。

## 已知限制

- DSH 当前基线暴露的是 `LlmAdapter` seam，因此工具调用通过模型隐藏的严格 JSON 信封桥接，不是 TraeX 原生 tool update，也不是完整 ACP UI。TraeX 的 plan、diff、permission UI、会话列表和富内容不会进入 DSH。
- 每次 DSH 请求使用一个新的 TraeX 进程和 ACP session，不恢复外部历史；完整 DSH 对话会被序列化进 prompt。
- 暂不转发音频或 TraeX token usage；用户附带图片与 `read_image` 工具结果图片会在挂载 `ctx.attachments` 且 ACP 后端声明 `promptCapabilities.image: true` 时通过原生 ACP `ImageContent` 转发。DSH tool schema 会随每一步序列化，工具结果则通过下一步的完整 DSH 对话返回给模型；实验性的 ACP `PromptResponse.usage` 只保留显式数值字段用于内部诊断，不会映射或发送为 DSH usage chunk。
- TraeX 是变化中的开发工具；本实现以 `traecli 0.201.1 (internal edition)` 的 ACP v1 握手和本机 `traecli 0.210.1 (internal edition)` 的 `traecli-acp` 身份、模型目录、逐模型 reasoning selector，以及官方 ACP SDK `0.25.1` 为验证基线。升级后若 identity、模型/effort selector 或终态变化，插件会拒绝而不是猜测兼容。

## 兼容性与调研

- Node.js：`package.json` 声明 `engines.node >=24.9.0`（详细运行时与安装器基线见[兼容基线](../../docs/compatibility.md)）
- DeepSeek Harness / `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` `>=0.2.2-rc.5 <0.3.0`（已验证基线 `0.2.2-rc.5`）
- Cordis `^4.1.0`
- Agent Client Protocol SDK `0.25.1`，protocol version `1`

进一步阅读：[Provider 设计依据与来源](../../docs/cliproxyapi-provider-evidence-review.md)、[兼容基线](../../docs/compatibility.md)。
