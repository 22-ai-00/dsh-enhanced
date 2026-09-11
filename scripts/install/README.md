# 安装、诊断与重启

安装器先确保 Node.js、pnpm 和已验证的 DSH `0.1.2-rc.1`（或发布账本允许的兼容 Host），再按场景安装最小 bundle 集合。三档场景能力逐级叠加：`core ⊂ lark ⊂ supervised`——`lark` 包含全部 `core` 能力，`supervised` 又在 `lark` 之上追加评测、演化与恢复。首次非交互运行和 `--yes` 都选择安全的 `core` 场景：安装个人助理四核心和只读的插件控制面，不创建飞书应用、不启动 daemon、不发送模型请求。

```sh
./scripts/install/install-local.sh --yes
```

现有无常驻服务的 `web` / `autonomy` profile 可显式执行离线升级或卸载：

```sh
./scripts/install/install-local.sh --operation upgrade --scenario web \
  --confirm-dsh-home-stopped --yes
./scripts/install/install-local.sh --operation uninstall --scenario web \
  --confirm-dsh-home-stopped --yes

# Linux systemd --user managed Lark profile; the installer stops and restores
# the proven same-home unit set itself.
./scripts/install/install-local.sh --operation uninstall --scenario lark \
  --confirm-dsh-home-stopped --yes

# Linux systemd --user managed supervised profile; checkout-local lifecycle.
./scripts/install/install-local.sh --operation upgrade --scenario supervised \
  --confirm-dsh-home-stopped --yes
./scripts/install/install-local.sh --operation uninstall --scenario supervised \
  --confirm-dsh-home-stopped --yes
```

两种操作都要求整个 `DSH_HOME` 在复制和切换时保持静止，且都会拒绝活动的第三方顶层 bundle，因为安装器无法穷举其私有状态路径；未作为 bundle 激活的普通第三方依赖会原样保留。`web` / `autonomy` 由操作者预先停止所有相关进程；Linux `lark` 和 `supervised` upgrade/uninstall 则由安装器在锁内停止并屏蔽已证明归属的 systemd units，操作者只需预先停止其它外部或手工进程。安装器持有 home 外的独占锁，在无网络隔离环境中对私有副本更新 package/lockfile、组合配置和实际激活；只有副本通过才提交。成功升级只更新当前已安装的 `@dsh-enhanced/*` 顶层依赖，不新增场景能力，并保留自定义 patch、凭据、Session、Goal 与其它任务状态。卸载的语义是停用并归档目标 profile 的受管能力：它把完整旧 profile 归档到 `$DSH_HOME/uninstalled-profiles/`，创建干净的同名 DSH 基础 profile；事务不会主动清除该 live profile 之外的凭据 locator、owner binding、Session、Goal 或数据库记录，也不承诺这些状态已被撤销、永久退休或逐字节验证。原 active units 在 clean profile 通过 fresh readiness 后恢复，原 inactive units 保持停止。归档配置不会继续激活；后续显式重装或共享同一状态库的其它 profile 仍可能再次解释这些保留状态。归档 profile 绑定完整树摘要；source proof 只覆盖协议明确列出的 Delivery、Recovery、Automations、owner 与非受管 Automation 摘要。再次卸载已无受管依赖的基础 profile 是幂等 no-op。

生命周期事务目前只支持 Linux，并要求 Node.js、`flock`、Perl、`/usr/bin/python3` 和 bubblewrap。本地 upgrade 会先对当前 checkout 执行 `pnpm install --offline --frozen-lockfile` 和构建；npm upgrade 则在同一生命周期锁内先把发布 selector 解析为精确 cohort，并以禁用 install scripts 的 `pnpm store add` 预取，随后才创建 transaction，且 bwrap 内的 package 更新强制 offline + copy。uninstall 不访问 npm registry 或 pnpm store。`web` / `autonomy` 仍使用操作者预先停止整个 home 的离线事务；Linux `lark` 和 `supervised` upgrade/uninstall 会在锁内枚举同一 canonical `DSH_HOME` 的 installer-managed systemd user units，以绑定 inode 的高优先级 `user.control` mask 屏蔽后全部停止，在每次 rename 前后复核进程静止，并只恢复原 active units；启动由独立 crash guardian 执行，fresh InvocationID 的 journal ready marker 与稳定窗口通过后才删除旧备份。明确属于其它绝对 HOME 的 custom/legacy unit 不会被修改，但它的 ownership 摘要会写入事务并持续复核；归属缺失、相对、冲突、漂移为当前 HOME 或嵌套于当前 HOME 都会 fail closed。此前卸载留下的同 HOME clean profile 只有在四文件和目录闭集精确匹配 installer baseline 时才允许共存，其摘要同样绑定到事务并在恢复、启动、验收与清理前复核。此能力要求 `DSH_HOME` 与用户 systemd 配置位于同一文件系统，以便用 Linux `renameat2(RENAME_NOREPLACE)` 原子移动受管 mask 和 enablement link。此能力不适用于外部 supervisor、macOS 或 Windows，这些组合会在变更前明确拒绝。`supervised` upgrade/uninstall 还要求 source 已安装支持只读 operator/attestation seam 的 cohort；安装器绝不回退到会迁移数据库的 Store 读取。停服后会绑定 Recovery、Automations 与 Delivery owner 快照；copied state 只按内容和语义摘要比较，允许 inode 改变。升级后的私有副本用 fresh UUID 和新包 catalog 生成 preview；preview Host 在无网络 bwrap 中运行，并只在该进程的临时 overlay 里禁用 Lark、从 Health required providers 移除 `larkChannel`。这个唯一 external-provider exemption 会绑定进事务且不会进入 active 配置。swap 后真实 upgraded service 必须同时通过 fresh InvocationID/journal、真实 Lark required-health、generation 严格前进的 exact active attestation 与稳定窗口。`supervised` uninstall 则在停服后绑定只读 source proof，将旧 profile 归档并换成 installer-clean Web profile；clean target 只按通用 fresh InvocationID/journal readiness 与稳定窗口验收，不要求已被停用的 Lark/Health/supervised active attestation。失败会保持服务收容并保留 current/original homes 和 manifest，不自动回滚。事务也不会修改权限、模型或 Agent 工具配置，并会拒绝不安全 owner/权限、home 内的外部状态链接、外部硬链接、挂载点、特殊文件及无法证明归属的旧事务残留；失败证据保留在同级 transaction 目录供人工排查。`--confirm-dsh-home-stopped` 对 service-aware lifecycle 表示除安装器将自行停止的 systemd units 外，其它使用整个 `DSH_HOME` 的外部/手工进程均已停止；它不是允许安装器 kill 未知进程的授权。

Linux Lark/supervised service-aware upgrade/uninstall 另外要求固定系统解释器 `/usr/bin/python3`，用于 `renameat2(RENAME_NOREPLACE)` 的无覆盖文件屏障；`DSH_HOME` 与用户 systemd 配置目录必须位于同一文件系统。

交互运行不传参数会选择场景；自动化可显式指定：

```sh
# 本机 Web/direct 核心
./scripts/install/install-local.sh --scenario core --yes

# 实验性本机 Web owner：固定本机 workspace 与 preset，不配置飞书或常驻服务
./scripts/install/install-local.sh --scenario web --workspace "$PWD" --agent-preset standard --yes

# 飞书/Lark 持久消息、owner onboarding 与日常使用自动偏好学习
./scripts/install/install-local.sh --scenario lark --lark configure

# 在上述能力上增加 Evaluation + Evolution + Recovery；低风险自动、高影响审批
./scripts/install/install-local.sh --scenario supervised --lark configure
```

安装器不会把 `dsh --dump-config` 当作“可用”的证明：对于尚未配置 Lark 的 profile，它会在安装 bundle 后、飞书 OAuth 前，在 OS 分配的 loopback 端口短暂启动一次 Web Host，等待 Loader 的就绪信号。已启用 Lark 的旧 profile 则不会启动第二个 Host 去并发访问同一份状态；若由安装器管理服务，最终会以真正的常驻进程和稳定性窗口验收。Lark 是否已启用按 DSH 的 home→profile 覆盖层计算，profile 的 `disabled`、`enabled` 或 App ID 覆盖会优先于 home 层，避免把已禁用的 bot 误判为可保留。临时 probe 中的 Lark Channel 会被 process-only overlay 禁用，不会建立第二条 WebSocket，也不会改写 profile。任何 Cordis service 依赖未满足都会明确失败。对于历史 profile 中已存在 `assistant-evolution` 而缺少其 `assistant-evaluation` provider 的情况，安装器会只补齐 Evaluation bundle；不会删除或默默启用其它旧插件。

飞书向导支持纯 SSH/无桌面 Linux：默认先探测 Secret Service，不可用时会在 OAuth 前自动验证并改用当前用户 `0700` 目录下的版本化 `0600` protected-file，不要求安装 GNOME Keyring。该文件没有额外静态加密，同 UID、root 与可读备份仍能读取；需要强制系统钥匙环时可在安装后直接运行 `dsh-lark-setup --linux-credential-provider secret-service`。

管理内建服务时，安装器会在 OAuth 前检查 systemd user manager 和 lingering。当前用户有权时会自动启用 lingering；需要管理员权限时，交互向导会先展示唯一的固定提权命令，并询问是否现在通过 `sudo` 执行，密码由 `sudo` 直接读取，不进入安装器、参数或日志。拒绝、失败或非交互运行都会在云端授权前停止并给出同一条可复制命令。Linux 安装完成后还会观察 user unit 的 `ActiveState`、`ExecMainStatus` 和 `NRestarts` 一个短窗口；发现快速崩溃/重启循环会打印最近 journal 并停止该 unit，避免 systemd 无限重启掩盖原始错误。容器、未启用 systemd 的 WSL 或其他没有 systemd user manager/logind 的系统应使用 `--no-service`，并由 Docker、s6、runit 等外部 supervisor 保持 `dsh --profile <name> --no-open` 常驻；此时安装器不会宣称或验证内建服务的注销后存活能力。
Linux 上的 Lark 与 supervised setup 还要求 `/usr/bin/flock` 和安全的 root-owned `01777` `/tmp`；setup 会在任何 profile、凭据、数据库或 service mutation 前持有与 upgrade/uninstall 相同的 canonical `DSH_HOME` rendezvous lock，避免 onboarding/reconfigure 与 service-aware lifecycle 并发。

普通 `lark` 场景已经安装 Preference Learning：经 owner onboarding 的完成对话只产生无正文的有界行为证据，并可在固定 T1 目录、阈值和回滚门内自动应用偏好；它不要求 Health、Heartbeat 或 Recovery，也不会新增通用 Agent 工具授权。`--disable-agent-tools` 只移除向导托管的规则，不覆盖用户自定义规则或显式的全局 Policy 默认值。

`supervised` 在此基础上额外安装 Evaluation、Evolution、Growth Experiments、Heartbeat、Recovery 与 Health；v2 激活器用同一 nonce 执行 preview→active 的固定 Host runbook。Recovery bootstrap 本身不依赖模型；独立 `supervised-growth-analyst` 每天最多运行一次，只能读取一个 Host 选出的 adoption candidate 并生成 owner 审批 proposal，不能投递普通模型正文。成长 overlay 会把 Heartbeat 连同 Delivery、Evaluation、Preference Learning、Evolution、Growth Experiments、Recovery、Lark Channel 和四个核心 service 标记为 Health required，并为审批后的 workflow replay/shadow/单次 canary 配置独立的低额度预算与 exact owner route。升级时旧 `supervised-growth` model heartbeat 会被安全暂停；TraeX 仍只在显式 `--with traex` 时安装。

`--with coding|traex|health|heartbeat|events|bridge` 可为其他场景追加能力。`--scenario full` 只用于迁移旧的全量默认集合；新安装不应使用它。`--mode supervised-growth` 保持兼容，等价于 supervised 场景。

`web` 是实验入口：它安装 core、Delivery、Goals 与 Web owner，并在第一次配置组合/activation probe 前运行 profile 内的 `dsh-web-owner-setup`，使用 `web/account=<profile>/tenant=local/user=operator` 的固定本机 owner。它不接入 Lark、不启动常驻服务，也不提高原生权限默认值。该入口尚不代表完整自治或真实模型验收；仍应按部署的模型、权限和工作区边界单独验证。Web owner 复用有效的 Delivery databasePath（默认是 `$DSH_HOME/assistant-delivery/state.sqlite`），不会替换或复活已有 owner；若另一 profile 的 Lark 也共享该数据库，setup 会拒绝，需使用独立的 `DSH_HOME`。为避免同一 profile 的 owner 语义混杂，已有启用 Lark channel、`--lark configure|keep`，或 `--agent-tools` 非 `preserve` 时会被拒绝。

`autonomy` 是显式选择的实验性离线执行入口，安装 Web 场景以及 Isolation、Actions、Keychain、Evaluation、Verifier、Event Triggers、Proactive 和 Skills。后面三者没有匹配授权时保持静默：不会自动创建任务、续期或发起网络请求。当前使用本仓库本地安装器；这些新增能力尚未作为完整自治产品发布。

```sh
./scripts/install/install-local.sh --scenario autonomy --workspace "$PWD" \
  --isolation-image sha256:<已存在的本机镜像ID> \
  --isolation-max-runs 20 --isolation-lease-minutes 60 \
  --isolation-runtime-minutes 10 --yes
```

安装前需准备非 root Linux Host、可访问的本机 Docker 和兼容 Isolation 的固定镜像（要求见 [Isolation 文档](../../plugins/assistant-isolation/README.md)）。安装器不拉取镜像、不安装或重启 Docker。setup 使用最终配置的 Docker 路径，通过生产 supervisor 实际执行非 root、只读根目录、隔离工作卷与 artifact 导出探测，成功后才初始化 owner 并写入 grant。失败会给出运行时原因；清理状态未知时保留私有 probe 证据目录，需要先排查其中记录的资源。探测只证明该固定任务的执行链路，不证明任意自定义任务或完整自治。

首次 grant 精确绑定本机 Web owner 版本、workspace 和 preset，默认 20 次、60 分钟期限、10 分钟累计预留执行时长；次数最多 10000、期限最多 7 天、累计时长最多 1 天。单次任务仍受 Isolation 的独立限制。重复 setup 保留原过期时间、撤销记录和已使用预算，即使过期也不自动续权；修改原绑定、镜像或预算需显式迁移。profile 私有 Isolation/Actions 状态和 Keychain 路径与其他 profile 分开，已有合法自定义路径保留。

autonomy 安装在 Host 激活检查后还会执行有限隔离诊断；已撤销、过期或耗尽的旧 grant 会使这一步失败，重复安装不会恢复它。日常复查使用 `./scripts/install/doctor.sh --profile web --require-isolation`。它读取已组合配置、Delivery owner 和 Isolation 的持久账本，报告累计次数/预留时长、剩余额度及 unknown 作业，再用同一镜像和 Docker 路径做临时探测；探测后重新核对配置及授权。该命令不启动第二个 Host，不配对、迁移账本、续期或消费业务 grant，可在已有 Host 运行时诊断。

诊断当前只支持 installer-managed Web owner 与单一 `autonomy-<profile>` grant、Delivery schema 19 和 Isolation schema 6；缺失、旧版或不一致的状态明确失败，需先按正常升级/迁移流程处理。通过表示该时刻的有限隔离检查通过，仍不能证明后续动态 Policy、实际资源准入、模型计量、Goal 独立验收或外部 Actions 可用；这些能力在结果中明确未检查。不要通过删除账本或重跑 setup 绕过已消耗的授权。

在该受管作用域中，模型只能调用受支持的隔离、目标上下文/检查点和获准的有限 Actions 工具，不能退回宿主 shell。Actions 默认无 grant，Keychain 不创建凭据。模型配置沿用安装器的独立引导；GitHub 目标/凭据、独立目标验收、后台唤醒以及完整自治生命周期仍需后续配置与验证。不要通过删除账本重置授权。

## 为已有 Web Session 配置有限 Goal admission

`autonomy` 安装完成后，`dsh-web-owner-setup` 可通过 `--goal-admission <private-json> [--session-id "$existingSessionId"]` 写入一个有限目标 admission。先停止目标 Host，任务 JSON 必须是工作区外的绝对路径、当前用户所有并为 `0600`；随后重启 Host 才会读取新 patch。先运行 `--list-goal-sessions` 查看当前 owner、workspace 和 preset 下的真实 idle Web Session；省略 `--session-id` 时仅在唯一候选时自动选择，多候选会打印可选 ID 并失败。它从不创建或伪造 Session/binding；新 profile 请先从原生 Web UI 打开一次。

v1 任务只能选 `deepseek-v4-flash` 或 `deepseek-v4-pro`，并需为每次调用预留至少 `2097152` input tokens；没有 USD 硬预算，也不接受 `costUsdMicros`。它固定 provider endpoint，使用 credential reference（如 `DEEPSEEK_API_KEY`），不接受明文 key。v2 任务使用 `{ "route": { "provider", "model" } }` 和 `{ "mode": "calls", "routes": [同一精确 route] }`；route 必须与实际配置的 `agent-default-model` 完全相同，setup 不会复制 secret 或修改模型配置。v2 硬限制为模型/工具请求数、时长和单次输出上限；usage 若由 adapter 提供仅作记录，不是 token/USD 硬限。任务还必须提供有限的 isolated verification cases；可选 wake 也有独立次数、延迟和运行期限。重启后 v1 需在已有 Session 中选择 `deepseek-goal-metered` 下的任务模型；v2 沿用已配置 route。

此操作不会续期或重置 installer-managed Isolation grant；与本次任务要求冲突的已有受管配置或同 ID 条目会拒绝，不被覆盖。该精确 Session 只用于核验 owner 和可选 wake route，profiles 绑定 owner、scope 和 objective。成功只表示本地配置、已有 Web owner snapshot 和持久 grant 在写入时一致；不代表真实模型/网络调用、业务 Goal 完成、独立验收成功或完整自治功能已交付。详见 [Web owner Goal admission](../../plugins/assistant-web-owner/README.md#有限-goal-admission实验性)。

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
- 安装器会自动把 `@dsh-enhanced/traex-acp-provider` 加入安装集，把全局 `settings.yaml` 的 `agent-default-model` 指向 `traex-agent`，并在**该 profile 的 patch 层**把 provider 行置为 `enabled: true`（保留其它行、注释与 `!!js` 表达式；已有 `cwd` 覆盖不被改写）。
- 当本轮将默认模型设为 TraeX 且 `--model-route` 保持 `auto` 时，安装器会先做不消耗额度的 `traex login status` 校验，再写入全局默认模型并检查 profile 适配器；未安装、未登录或 profile 未注册适配器都会失败，不会把部署宣称为可用。后两步失败或在此窗口被中断时，会恢复本次前的 `settings.yaml` 和该 profile patch，因此不会把其它 profile 留在未经验证的 `traex-agent` 默认上。显式 `--model-route skip` 仍可跳过该检查。

注意 `traex-agent` 的**适配器是按 profile 注册的**（只在启用了 `traex-acp-provider` bundle 的 profile 里存在），而 `agent-default-model` 是**全局唯一**的 settings 段、被所有 profile 共享。因此把默认设为 `traex-agent` 后，只有已启用该 route 的 profile（默认 `web`）能真正解析它；`headless` 等未安装该 bundle 的 profile 若用这个默认会报 `NO_ADAPTER`。安装器为此对 agent route 采用**结构化验证**：不发模型请求，而是确认目标 profile 的 `--dump-config` 已注册 `traex-acp-provider` 并检查 `traex login status`，避免误用 `headless` 触发 `NO_ADAPTER`，也不消耗任何额度。每次真实调用会新起一个 `traex acp serve` 子进程并消耗 TraeX 侧额度；具体边界见 [`traex-acp-provider` 文档](../../plugins/traex-acp-provider/README.md)。

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

验证方式取决于当前全局默认的 provider 类型：普通 API-key/网关 route 通过 `headless` profile 发送一次固定的最小请求；agent route（`traex-agent`）不发模型请求，改为校验目标 profile 已注册 `traex-acp-provider` 适配器并检查 `traex login status`。

每次新 profile 都会预检 Web 端口（默认 `127.0.0.1:3080`，可用 `DSH_ENHANCED_WEB_PORT` 覆盖），并在飞书配置前验证 profile 能真实激活，而非只验证 YAML 可组合；已管理的 Lark profile 则以实际常驻服务验收。独立诊断：

```sh
./scripts/install/doctor.sh --profile web
./scripts/install/doctor.sh --profile web --require-service
./scripts/install/doctor.sh --profile web --require-isolation
```

`--require-service` 在 Linux 同时验证 systemd user unit、稳定性窗口和 lingering；若检测到循环崩溃会停止该 unit 并输出 journal，若未启用 lingering，注销会停止 user service，按 doctor 提示运行 `sudo loginctl enable-linger "$(id -u)"`。未带 `--require-service` 的 doctor 会避免对已启用 Lark 的 profile 启动第二个 Host；macOS LaunchAgent 与 Windows 当前用户计划任务只能在用户登录会话中运行；Windows 的任务会在失败后重启，但不宣称注销后继续运行。

远程 npm 安装器（`install-npm.sh`）可从 `main` 直接拉取执行，但它只是薄引导器；当脚本不在 `common.sh` 旁边运行时，它从固定 `vX.Y.Z` 发布标签拉取并校验 `common.sh`。仅当参数中的最终 `--operation` 为 `upgrade` 或 `uninstall` 时，它才从同一个 tag 拉取 `lifecycle-config.mjs` 和 `lifecycle-profile.mjs`；所需资产先写入私有临时目录中的 `.download` 文件，全部通过各自内嵌的 lowercase SHA-256 校验后才原子改名并设为只读，随后才 source `common.sh`。远程 bootstrap 要求 `TMPDIR` 是绝对 canonical 路径、最终目标不是 symlink、由当前用户拥有，且其非系统临时目录祖先不能由非 root/当前用户拥有或向 group/other 开放写权限；系统 `/tmp`（包括 macOS 指向 `/private/tmp` 的标准别名）必须解析到 root-owned `01777` 目录。实际安装逻辑和生命周期执行器都不从 mutable `main` 执行。可分别用 `DSH_ENHANCED_INSTALL_COMMON_SHA256`、`DSH_ENHANCED_INSTALL_LIFECYCLE_CONFIG_SHA256`、`DSH_ENHANCED_INSTALL_LIFECYCLE_PROFILE_SHA256` 覆盖 digest，并用 `DSH_ENHANCED_INSTALL_REF` 覆盖固定发布 tag；所有 digest 必须是精确的 64 位小写十六进制值。当前 `v0.1.24` 发布不含两个 lifecycle helper，因此它们继续使用全零 sentinel：普通远程 install 仍只下载并校验 `common.sh`，远程 upgrade/uninstall（包括 supervised uninstall）则在任何下载或 source 前 fail closed。本地 sibling 模式仍直接使用 checkout helper，下一次 `release:prepare` 会在新 release 中写入三个真实 digest。因而 checkout 中尚未发布的安装逻辑不会被远程引导器加载。

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash
```

安装器默认先把 `@dsh-enhanced/personal-assistant@latest` 解析为一次安装的精确版本，再用该精确版本预检并安装每个选中的 `@dsh-enhanced/*` bundle；因此仍会获得最新的完整发布，不会因各包独立解析 `latest` 而混装。预检发现任一 bundle 尚未发布该版本时，会在修改 profile 前失败。显式传入 `--plugin-version` 或 `DSH_ENHANCED_VERSION` 可使用精确 SemVer 或 npm dist-tag；tag 同样先由 anchor 解析为精确版本。版本 range 会被拒绝，因为它不能表达一个可验证的单一 cohort。`--dry-run` 不访问 npm registry，会显示待执行的 anchor 解析与预检；要确认实际发布状态请去掉 `--dry-run`。`supervised` 场景要求完整的 bundle 集合，安装后才运行 preview→active 激活器。

本地源码改动后仅重建并重启已有常驻服务：

```sh
./scripts/install/restart.sh [profile]
```
