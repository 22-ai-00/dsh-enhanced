# 安装、诊断与重启

安装器先确保 Node.js、pnpm 和 DSH `0.1.0-rc.8`，再按场景安装最小 bundle 集合。三档场景能力逐级叠加：`core ⊂ lark ⊂ supervised`——`lark` 包含全部 `core` 能力，`supervised` 又在 `lark` 之上追加评测、演化与恢复。首次非交互运行和 `--yes` 都选择安全的 `core` 场景：安装个人助理四核心和只读的插件控制面，不创建飞书应用、不启动 daemon、不发送模型请求。

```sh
./scripts/install/install-local.sh --yes
```

交互运行不传参数会选择场景；自动化可显式指定：

```sh
# 本机 Web/direct 核心
./scripts/install/install-local.sh --scenario core --yes

# 飞书/Lark 持久消息、owner onboarding 与日常使用自动偏好学习
./scripts/install/install-local.sh --scenario lark --lark configure

# 在上述能力上增加 Evaluation + Evolution + Recovery；低风险自动、高影响审批
./scripts/install/install-local.sh --scenario supervised --lark configure
```

飞书向导支持纯 SSH/无桌面 Linux：默认先探测 Secret Service，不可用时会在 OAuth 前自动验证并改用当前用户 `0700` 目录下的版本化 `0600` protected-file，不要求安装 GNOME Keyring。该文件没有额外静态加密，同 UID、root 与可读备份仍能读取；需要强制系统钥匙环时可在安装后直接运行 `dsh-lark-setup --linux-credential-provider secret-service`。

管理内建服务时，安装器会在 OAuth 前检查 systemd user manager 和 lingering。当前用户有权时会自动启用 lingering；需要管理员权限时，交互向导会先展示唯一的固定提权命令，并询问是否现在通过 `sudo` 执行，密码由 `sudo` 直接读取，不进入安装器、参数或日志。拒绝、失败或非交互运行都会在云端授权前停止并给出同一条可复制命令。容器、未启用 systemd 的 WSL 或其他没有 systemd user manager/logind 的系统应使用 `--no-service`，并由 Docker、s6、runit 等外部 supervisor 保持 `dsh --profile <name> --no-open` 常驻；此时安装器不会宣称或验证内建服务的注销后存活能力。

普通 `lark` 场景已经安装 Preference Learning：经 owner onboarding 的完成对话只产生无正文的有界行为证据，并可在固定 T1 目录、阈值和回滚门内自动应用偏好；它不要求 Health、Heartbeat 或 Recovery，也不会新增通用 Agent 工具授权。`--disable-agent-tools` 只移除向导托管的规则，不覆盖用户自定义规则或显式的全局 Policy 默认值。

`supervised` 在此基础上额外安装 Evaluation、Evolution、Growth Experiments、Heartbeat、Recovery 与 Health；v2 激活器用同一 nonce 执行 preview→active 的固定 Host runbook。Recovery bootstrap 本身不依赖模型；独立 `supervised-growth-analyst` 每天最多运行一次，只能读取一个 Host 选出的 adoption candidate 并生成 owner 审批 proposal，不能投递普通模型正文。成长 overlay 会把 Heartbeat 连同 Delivery、Evaluation、Preference Learning、Evolution、Growth Experiments、Recovery、Lark Channel 和四个核心 service 标记为 Health required，并为审批后的 workflow replay/shadow/单次 canary 配置独立的低额度预算与 exact owner route。升级时旧 `supervised-growth` model heartbeat 会被安全暂停；TraeX 仍只在显式 `--with traex` 时安装。

`--with coding|traex|health|heartbeat|events|bridge` 可为其他场景追加能力。`--scenario full` 只用于迁移旧的全量默认集合；新安装不应使用它。`--mode supervised-growth` 保持兼容，等价于 supervised 场景。

核心 profile 中的 `plugin_discover` 可立即按能力检索内置、完整性固定的首方候选目录；它不会下载或启用任何包。Agent 只能生成待审批 plan，owner 仍需用 `dsh-plugin-control approve` 与 `activate` 在 staging profile 中显式启用。写入 `~/.dsh/plugin-control/catalog.json` 的 owner catalog 会取代内置目录。

默认 Permission 是 `workspace-write + ask`；完整访问需要明确确认：

```sh
./scripts/install/install-local.sh --permission danger-full-access --confirm-dangerous-full-access
```

默认不更改安装器托管的 Agent capability 规则。飞书场景中才可显式用 `--agent-tools allow` 或 `--agent-tools disable`；`core` 场景保持 `preserve`。

## 配置默认模型

DSH 需要一个能解析的默认模型才能真正对话。所有场景在飞书/常驻服务处理之后、模型 route 验证之前都会进入一次模型配置引导：交互运行会检测当前 profile 是否已能解析 `agent-default-model` 的 provider/model，已配置则默认保留，未配置则默认现在配置；`--yes` 和非交互运行只保留 profile 已组合的默认（至少是内置的 `deepseek-official`），绝不擅自写入新 route。

引导支持三种目标，都由 `dsh-model-setup` 写入 `settings.yaml` 的 `agent-default-model`（自定义网关另写 `llm-pi-ai.providers.<route>`）：

```sh
# DeepSeek 官方：只需模型名（缺省 deepseek-v4-flash）与 API Key
./scripts/install/install-local.sh --model-provider deepseek-official --model-name deepseek-v4-flash

# 自定义 OpenAI 兼容网关：provider + base URL（+ 可选协议/显示名）
./scripts/install/install-local.sh \
  --model-provider super-relay --model-name glm5.2 \
  --model-base-url https://super-relay.example/v1 \
  --model-api openai-completions --model-display-name 'Super Relay'

# 本机 TraeX：复用已登录的 traex/trae-cli，无需 API Key
./scripts/install/install-local.sh --model-provider traex-agent
```

`--model-api` 仅用于自定义网关，缺省 `openai-completions`（`/v1/chat/completions`），也可选 `openai-responses` 或 `anthropic-messages`；`deepseek-official` 由内置 `dsh-llm-deepseek` 服务，禁止携带这些传输字段。`--model configure` 在交互终端会额外弹出选择向导；`--model skip` 完全跳过。

### 本机 TraeX 作为默认模型

若本机 PATH 上存在 `traex` 或 `trae-cli`，交互向导会多出一个「本机 TraeX」选项，也可用 `--model-provider traex-agent` 直接指定。这是一个 **agent route**（由本机已登录的 TraeX 通过 ACP 提供），因此：

- 不需要 API Key，也不接受 `--model-base-url/--model-api/--model-display-name`。
- 安装器会自动把 `@dsh-enhanced/traex-acp-provider` 加入安装集，把 `agent-default-model` 指向 `traex-agent`，并在**该 profile 的 patch 层**把 provider 行置为 `enabled: true`（保留其它行、注释与 `!!js` 表达式；已有 `cwd` 覆盖不被改写）。
- 随后探测 `traex login status`；未登录只给出非致命提示（请在同一 OS 用户下 `traex login`），不会中断安装。

注意 route 启用是**按 profile** 的（写在 `profiles/<profile>/cordis.patch.yml`），与写全局 `settings.yaml` 的默认模型选择不同。每次真实调用会新起一个 `traex acp serve` 子进程并消耗 TraeX 侧额度；具体边界见 [`traex-acp-provider` 文档](../../plugins/traex-acp-provider/README.md)。

API Key 只从环境读取，绝不作为命令行参数（避免进入进程列表、日志与历史）。安装器优先读取 `DSH_ENHANCED_MODEL_API_KEY`，其次是按 provider 派生的凭据引用（`deepseek-official` 用 `DEEPSEEK_API_KEY`，其余形如 `SUPER_RELAY_API_KEY`）；命中任一即在写入 route 后把密钥存入 `$DSH_HOME/.credentials.yaml`（`0600`，目录 `0700`）。交互终端未命中环境变量时会用隐藏输入（`read -s`）询问一次，仅为该子进程导出、结束即清除。都没有时仍写入 route 选择，并提示稍后设置对应环境变量或编辑 `.credentials.yaml`，不会中断安装。agent route（TraeX）不涉及 API Key。

也可安装后单独运行：

```sh
DSH_ENHANCED_MODEL_API_KEY=… "$DSH_HOME"/profiles/web/node_modules/.bin/dsh-model-setup \
  --provider deepseek-official --model deepseek-v4-flash

# TraeX：写默认选择并在 web profile 启用 route（需先 --with traex 或已安装该 bundle）
"$DSH_HOME"/profiles/web/node_modules/.bin/dsh-model-setup --provider traex-agent --enable-in-profile web
```

模型 route 不会被安装器静默调用；配置模型后可请求一次最小验证：

```sh
./scripts/install/install-local.sh --scenario lark --lark keep --model-route verify
```

每次新 profile 都会预检 Web 端口（默认 `127.0.0.1:3080`，可用 `DSH_ENHANCED_WEB_PORT` 覆盖），并在结束时验证 profile 可组合。独立诊断：

```sh
./scripts/install/doctor.sh --profile web
./scripts/install/doctor.sh --profile web --require-service
```

`--require-service` 在 Linux 同时验证 systemd user unit 和 lingering；若未启用 lingering，注销会停止 user service，按 doctor 提示运行 `sudo loginctl enable-linger "$(id -u)"`。macOS LaunchAgent 与 Windows 当前用户计划任务只能在用户登录会话中运行；Windows 的任务会在失败后重启，但不宣称注销后继续运行。

远程 npm 安装器不再从 mutable `main` 下载库文件。应从一个发布标签下载 `install-npm.sh`；当脚本不在 `common.sh` 旁边运行时，它只会获取同一 `vX.Y.Z` 标签的 `common.sh` 并验证内嵌 SHA-256。发布流程会在 `release:prepare` 自动更新该 tag 与 digest。
安装器默认把每个 `@dsh-enhanced/*` 目标精确固定到这个内嵌发布标签的版本，避免递归 npm 发布尚未全部完成时由 `latest` 解析出混合版本；只有显式传入 `--plugin-version` 或 `DSH_ENHANCED_VERSION` 才会覆盖。`supervised` 场景要求完整的同版本 bundle 集合，安装后才运行 preview→active 激活器。

本地源码改动后仅重建并重启已有常驻服务：

```sh
./scripts/install/restart.sh [profile]
```
