# @dsh-enhanced/lark-channel

飞书/Lark 的薄协议适配器。它把长连接消息转换成 `assistant-delivery` 的 typed inbox，并把后者已经落盘的 outbox intent 转成飞书发送或回复 API；本包不拥有配对、会话、重试或授权真源。

默认是 `enabled: false`，所以安装包不会立刻读取凭据或联网。

启用后，合法的新消息完成鉴权、去重并进入持久 Inbox 后，机器人会在原消息上添加 `Get`；普通 Agent 任务同时创建一条飞书原生执行进度消息，只展示阶段、步骤说明、工具名和显式待办状态；最终答复发送成功后再在原消息上添加 `DONE`。进度与 reaction 都是 best-effort 展示层，最终答复仍由 Delivery Outbox 保证。进度载荷不会发送流式 `reasoning-delta`、工具参数或工具原始结果；`ask + user` 以及 `auto` 档中被本地规则/隔离 reviewer 升级的敏感操作会向 owner 私聊发送工具审批卡，卡片显示有界的 exact arguments，供人仅允许一次或拒绝。`auto` 的低风险 grant 和 `full` 不出卡。

## 最快启用：跨平台 setup wizard

安装完成后，推荐让向导完成 Keychain、owner 身份、最小 Policy 和 Web profile 配置，而不是手写 YAML：

```sh
cd /path/to/dsh-enhanced
pnpm --filter @dsh-enhanced/lark-channel build
pnpm --filter @dsh-enhanced/lark-channel run onboard --profile web --create-app --allow-agent-tools
```

如果 Web profile 已按本仓库的本地源码方式安装，也可以直接运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup --profile web --create-app --allow-agent-tools
```

向导会依次：

1. 调用飞书官方 Node SDK 的 `registerApp`，显示十分钟有效的确认链接和终端二维码；
2. 你在飞书中选择已有应用或创建新应用，并确认权限增量；
3. 将返回的 `App Secret` 自动写入 macOS Keychain、Linux Secret Service 或当前 Windows 用户的 DPAPI 加密文件；Secret 不经过命令行参数、不写 profile、也不打印；
4. 用真实凭据建立一次临时长连接；
5. 显示一次性 `DSH-CONNECT-...` 短语，等待你私聊机器人并原样发送；
6. 从这条单聊取得应用作用域下的准确 `open_id`，只把该身份配为 owner；
7. 更新 `web/cordis.patch.yml`，启用 channel，添加精确 ingress/reply/credential 规则；显式传入 `--allow-agent-tools` 时，为本地 `foreground` Agent 添加跨 preset/workspace 的通用 capability 规则，同时为 Delivery 当前及兼容 preset、绝对 workspace、canonical owner principal、`external` initiator 添加精确主体的通用 capability 与工具规则；它们同时覆盖动态工具和插件内部二次 Policy 动作，不放宽 `background`；随后运行 `dsh --profile web --dump-config` 自检；
8. 安装并启动该 profile 的用户级常驻服务：macOS 使用 launchd，Linux 使用 systemd，Windows 使用 best-effort Task Scheduler；均以 `dsh --profile web --no-open` 运行。

一键模式使用官方的 OAuth 2.0 Device Authorization Grant。只传 `--create-app` 时，官方确认页会同时提供“选择已有应用”和“创建新应用”；与 `--app-id` 组合时则锁定更新该已有应用。两种方式都会先展示权限、事件和回调的增量，只有你确认后才会生效。向导始终不传 `createOnly`，并使用 `addons.preset: false`，不采用官方默认智能体模板中与本 channel 无关的文档、Wiki、群管理、批量消息等权限。确认页只申请：

- `application:bot.basic_info:read`：连接时取得机器人身份；
- `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`：接收私聊和群内 @ 消息；
- `im:message.reactions:write_only`：在原消息上添加 `Get` / `DONE` 状态；
- `im:message:send_as_bot`：发送及回复消息；
- `im:resource`：通过[获取消息中的资源文件](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get)接口，按消息 ID 与该消息内的 image key 下载用户发送的图片。
- `im.message.receive_v1`：消息事件；
- `card.action.trigger`：处理审批卡片按钮、模型选择级联刷新和最终确认按钮。

事件与回调由官方一键创建流程预置为 WebSocket 长连接，不需要公网 callback URL。实现依据是飞书开放平台的[一键创建飞书智能体应用](https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/overview)和官方 Node SDK 的[`registerApp` 文档](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#%E4%B8%80%E9%94%AE%E5%88%9B%E5%BB%BA%E5%BA%94%E7%94%A8)。

已有应用仍可复用：

```sh
# 通过官方授权页给指定已有应用增量补齐权限、事件和回调（推荐）
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app \
  --app-id cli_0123456789abcdef

# 仅手工录入已有应用凭据，不修改飞书控制台配置
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --app-id cli_0123456789abcdef
```

单独使用 `--app-id` 的手工路径会通过当前系统的安全输入读取 App Secret，适合已自行完成控制台配置的应用。通常应使用官方授权路径；省略 `--create-app` 和 `--app-id` 时，向导会询问 App ID，直接回车即进入一键选择/创建。

重复执行会更新同一个 account 的受管配置，不重复添加规则或 handle。Agent 能力策略是显式三态：不传参数会保留现状，`--allow-agent-tools` 写入本地 foreground 与精确 Delivery 主体两类通用 capability 可达性规则（并保留外部主体的工具级 allow/deny），`--disable-agent-tools` 删除向导为该 account 管理的这些规则；普通重跑不会意外授权或撤权。profile 校验失败时会在进程内恢复原内容；不会保留备份文件。

### 只刷新 Agent Policy

更新 capability 规则不需要重走 onboarding；Web/direct-only profile 即使没有启用飞书，也使用同一个非交互刷新模式：

```sh
# 写入/刷新本地 foreground；若飞书已启用，同时刷新精确 Delivery 能力规则
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --refresh-agent-policy \
  --allow-agent-tools

# 删除 setup 托管的 foreground；若飞书已启用，同时删除该 account 的 Agent 能力规则
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --refresh-agent-policy \
  --disable-agent-tools
```

`--refresh-agent-policy` 必须与上述 allow/disable 之一搭配，除 `--profile` 外只可选带 `--account`。本地 foreground 规则独立于 Lark row，总能在已安装的 personal-assistant profile 中刷新；只有 profile 已启用 Lark 时才同时重建精确 Delivery 规则，传入 account 时也必须与该 account 精确相同。该模式不读 App Secret，不发起设备授权，不修改 App、credential handle、owner、conversation binding 或其他 channel 配置，也不安装/重启常驻服务。它原子写入 profile 后立即运行 `dsh --dump-config` 校验；校验失败会原子恢复原 patch。

飞书授权只是建立应用凭据和 owner 绑定；`lark-channel` 本身仍是运行在 DSH Host 内的插件。因为这里安装到 `web` profile，默认由向导在后台常驻这个 profile，不需要保持浏览器打开，也不需要再手动执行 `dsh web`。

## 可选：受监督成长激活器

`dsh-supervised-growth-setup --profile web` 仅在完成上述 Lark onboarding 后使用。它只读取
Delivery/Automations 的本地 SQLite 控制面，不解析或执行任何模型输入；先等待一条与 profile 中
account、tenant、默认 workspace 和 preset 完全一致的活动 owner 私聊 binding。没有匹配时会要求
owner 再发一条普通私聊并有界轮询，超时或存在多个匹配时都不修改 profile。

激活器随后检查活动 automation：**任何**已有 active job（包括旧 `assistant-heartbeat` job）都会默认
阻止启用。scheduler 一旦开启会加载全部 durable row，不能按 owner 名称猜测旧 heartbeat 是否安全。
确认这些任务可在 scheduler 开启后继续运行时才显式传入 `--ack-existing-automations`；该确认不会恢复、
创建或改写 job 定义，但不会阻止其被 scheduler 领取。

通过检查后，激活器基于 `dsh --dump-config` 的有效组合树写入完整受管 overlay，而不是假定用户 raw
patch 已含 meta-bundle 的 config。Delivery/Automations DB 路径也从有效树读取。原子写入后它会再次
dump 并验证 scheduler、TraeX cwd/route、`automation-runs` budget、heartbeat 和每条受管 Policy rule；
若 home/profile 高优先级 layer 覆盖了其中任一项，立即恢复原 patch。它在写入前和重启前都会重读同一
owner binding 的完整 route/status/version；版本变化、撤销或多 binding 均 fail closed。

在重启 Host 前，激活器调用 TraeX provider 唯一的 installer-only readiness probe：固定 read-only ACP
catalog handshake 会验证可执行文件、登录和至少一个可用模型，但不会发送模型 prompt。普通
`listModels`/`resolveModel` 不使用这个静态 cwd 例外；实际模型执行仍要求 live loop session 的 canonical
cwd 与配置 workspace 完全一致。restart 后还必须通过 resident running health gate，否则会恢复原 profile
和旧服务。Windows Task Scheduler 没有这个实现可验证的健康信号，supervised-growth 因而在 Windows
拒绝激活，不伪装为常驻成功。

overlay 仅允许精确 workspace/preset 的后台 heartbeat 在 08:00–22:00 每 120 分钟运行一次（恰好每日
7 次）：先 `evolution_review`，才可最多一次 `evolution_propose`；每轮最多 2 次工具调用和 512 输出
token。Policy budget 的 metric 是 `automation-runs`，每天最多 7 次、每次固定计 1；512 仅是输出上限，
不是不可证明的总 token 预算。pending Evolution proposal 的审批卡只可由固定 Evolution 背景主体投递到
这个 exact owner binding，owner approval 仍是唯一 apply 门。scratch 明确禁止 decide/apply、修改代码、
凭据、Policy 或既有 automation；无候选时精确输出 `HEARTBEAT_OK`。overlay 不授予 shell、文件系统、
网络或凭据权限。

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-supervised-growth-setup --profile web
# 仅当确认已有活动任务可以在 scheduler 开启后继续运行时：
~/.dsh/profiles/web/node_modules/.bin/dsh-supervised-growth-setup --profile web --ack-existing-automations
```

升级前已经存在的 conversation binding 会继续固定旧 preset/workspace（旧安装常见 preset 为 `primary`），新 binding 则使用 Delivery 当前配置的默认身份。执行上述 `--refresh-agent-policy --allow-agent-tools` 时会按完整 preset+workspace 保留精确 legacy 规则，同时把主规则更新到当前默认身份；refresh 会清除所有历史 account id 的 setup-managed external reply/capability/tool 规则，再只为当前 account 的 canonical owner principal 重建。Delivery 外部规则的 principal、preset、workspace 始终精确，capability 的 action/resource 使用 `*` 以覆盖该身份已挂载的动态工具及插件内部 Policy 动作；外部工具级规则仍用工具 id `*` 并可配置显式 deny。本地 `foreground` 规则则有意对 preset/workspace 使用 `*`，以支持 Web/direct 中的用户切换。

已完成飞书配置、只需安装或重启常驻服务时运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --install-service
```

macOS 会创建 `~/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist`，登录后自动启动、异常退出后自动拉起；只写入 `DSH_HOME` 和不含相对目录的 `PATH`，不会复制当前 shell 的 token、password 或其他环境变量。常用运维命令：

```sh
# 查看状态
launchctl print gui/$(id -u)/ai.deepseek.dsh.profile.web

# 查看错误日志
tail -f ~/.dsh/logs/web-host.error.log

# 停止并卸载当前登录会话中的服务；重新执行 --install-service 可恢复
launchctl bootout gui/$(id -u)/ai.deepseek.dsh.profile.web
```

Linux 会创建私有的 `~/.config/systemd/user/dsh-profile-web.service`，只配置 DSH 所需路径以及 Secret Service 所需的用户 D-Bus/XDG 定位：

```sh
systemctl --user status dsh-profile-web.service
journalctl --user -u dsh-profile-web.service -f
systemctl --user restart dsh-profile-web.service
```

Linux 一键向导需要当前用户桌面会话中可用且已解锁的 Secret Service，并提供 `/usr/bin/secret-tool`；手工输入已有 App Secret 时还需要 `/usr/bin/systemd-ask-password`。`--no-service` **只跳过** 成功后的 systemd 常驻安装，不会把向导的凭据 provider 改成 environment，也不能绕过 Secret Service。

### Linux Secret Service 排障

若授权完成后看到 `setup failed and staged credential cleanup also failed`，这通常表示向导无法通过 `secret-tool` 暂存 App Secret，随后同一不可用的服务也无法清理暂存项；不是飞书 OAuth 或 systemd 服务安装失败。不要删除 `$DSH_HOME/profiles/<profile>/cordis.patch.yml.lark-setup.journal.json`：修复依赖后重跑向导会先自动恢复它。

若看到 `profile and owner were committed, but previous credential cleanup is pending`，新的 profile、owner 和凭据已经生效，不能回滚；向导保留了同一个 journal，以便修复 Secret Service 后优先重试删除旧凭据。不要删除该 journal，也不要立即开始另一轮凭据旋转。

在 Ubuntu/Debian 图形桌面上，以将运行 DSH 的普通登录用户打开终端（不要用 `sudo` 运行向导）执行：

```sh
sudo apt update
sudo apt install --yes libsecret-tools gnome-keyring dbus-user-session
# 完整注销并重新登录后，在新的图形终端执行以下无凭据检查：
test -x /usr/bin/secret-tool
test -n "${DBUS_SESSION_BUS_ADDRESS:-}" || test -S "${XDG_RUNTIME_DIR:-}/bus"
```

新版向导会在飞书 OAuth **之前**临时存入、读回并清除一个随机的非生产 canary，以确认钥匙环确实可写；这项检查不会读取、写入或显示 App Secret。若出现钥匙环解锁对话框，先解锁再继续。随后以原来的 profile/account/tenant/agent-tools 参数重跑；已创建的应用可复用，避免创建第二个应用：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web --create-app --app-id cli_0123456789abcdef
```

纯 SSH 服务器、容器或没有可持续 Secret Service 的系统不支持这个一键向导；不要仅加 `--no-service` 重试。此类部署应手工使用下文的 `appSecretEnv` 或 `credentials-keychain` 的 `environment` handle，并由 systemd/container/secret manager 注入值；同时需要显式完成等价的 owner 与 Policy 配置。当前向导也要求 FHS 的 `/usr/bin/secret-tool`、`/usr/bin/systemd-ask-password` 与 `/usr/bin/systemctl`；Nix、Guix 或其他非 FHS 系统请使用手工 environment 部署，直到这些组件获得协调支持。

Windows 会把 DPAPI 加密的 PSCredential 保存到 `$DSH_HOME/credentials-keychain`，并创建当前用户的 `DSH profile web` 登录任务。该实现不会保存明文，但 Windows/Node/npm/Git Bash 组合差异较大，因此属于 best-effort，不作兼容承诺：

```powershell
schtasks.exe /Query /TN "DSH profile web"
schtasks.exe /End /TN "DSH profile web"
schtasks.exe /Run /TN "DSH profile web"
```

如果确实希望自己管理进程，在首次向导中加 `--no-service`，然后手动运行 `dsh --profile web --no-open`。不要同时启动前台和 LaunchAgent 两份相同 profile，否则 Web 端口与飞书长连接会发生竞争。

服务启动后，同一私聊或稳定群聊 lane 会持续恢复同一个 DSH session。`/status`（或 `/session`）显示当前代次与上下文统计；`/stop` 只停止正在执行的任务并保留该 session；`/new`（或 `/clear`）才停止旧任务并原子切换到空白的下一代 session；`/compact` 在宿主发布原生命令时压缩当前上下文。未知 slash 命令不会进入模型。

可以先在飞书里私聊机器人发送 `/model`。机器人会返回一张飞书卡片，依次选择“分组 / Provider”“模型”“Effort 程度”，再点击“确认选择”；选择 provider 时，同一张卡片会立即刷新为该分组的模型，选择模型时又会刷新为该模型实际支持的 effort。没有独立 effort 档位的模型只显示“默认（该模型无 effort 档位）”。确认后原卡会立即进入不可交互的验证态，后台完成校验后再原位更新为成功或失败结果，同时保留文字结果通知；成功选择从下一条普通消息起生效，原上下文保留。目录来自当前 Host 实际注册的 provider/model，不消耗一次模型调用。若目录中的异常字段或飞书卡片格式错误导致卡片未被接受，机器人会立即改发完整纯文本目录，可继续使用 `/model use <provider/model>`，不会静默重试后进入死信。

飞书的多个静态选择器本身彼此独立，所以插件在 provider、model、effort 选择器上分别注册签名 callback，并通过长连接回调返回 `{ card: { type: "raw", data: ... } }` 更新同一张 schema 2.0 卡片。固定的官方 Node SDK 会忽略 `type=card` 长连接帧，transport 因此在其边界补充分片合并、callback 分发和 ACK 兼容桥。每次级联状态都带持久化 revision；旧卡片回调只会重绘当前权威状态，不会覆盖较新的选择。目录按 operation 保存在 Delivery SQLite，Host 短暂重启后仍能恢复。最终确认还会精确绑定已投递卡片的 provider message id；callback ACK 只确认受理，随后用同一 HTTP PATCH 链先锁定为只读验证态，再在 durable settlement 完成后更新为只读终态。最终确认时还会在 adapter 与 Delivery 两层拒绝不匹配的分组/模型，并校验目标模型支持的 effort。选择“默认（由模型决定）”不会固定 reasoning effort。`/model use <provider/model>` 仍可作为文字后备，`/model reset` 恢复部署默认模型，`/new` 轮换到新 session 但保留该聊天的模型与 effort。Web 会话里可调用 `assistant_health` 查看 `larkChannel.state`，正常应为 `connected`。

例如本机已安装并登录 `@dsh-enhanced/coding-subscription-provider` 的 Codex CLI 时：

```text
/model
# 在卡片中选择三个下拉框并点击“确认选择”
你好，请介绍一下你自己
```

`/model` 是 `assistant-delivery` 的渠道无关控制命令，不会被交给当前失效的 LLM；因此即使 profile 中的旧默认 route 已不存在，也能先切换再恢复正常对话。

向导正式支持 macOS Keychain + launchd 和 Linux Secret Service + systemd user service。Windows DPAPI + Task Scheduler 已实现但仅为 best-effort。容器仍使用下文的手工 `credentialHandle` 或 `appSecretEnv` 配置，并由 Docker 等 supervisor 常驻 DSH Host。

## 安装

先安装并配置 `@dsh-enhanced/assistant-policy` 与 `@dsh-enhanced/assistant-delivery`，再安装本包：

```sh
dsh plugin --profile web add @dsh-enhanced/lark-channel
dsh --profile web --dump-config
```

如果不使用向导，可在 profile patch 中填写真实值并启用：

```yaml
config:
  enabled: true
  account: personal-bot
  tenant: personal
  appId: cli_0123456789abcdef
  credentialHandle: lark-app-secret
  credentialPurpose: connect
  credentialLeaseMs: 86400000
  domain: feishu
  requireMentionInGroups: true
  showProgress: true
  statusReactions: true
  imageDownloadTimeoutMs: 30000
```

该 handle 由 `@dsh-enhanced/credentials-keychain` 提供，并应只允许 consumer `dsh-enhanced-lark-channel`、purpose `connect`。兼容部署也可以不用 keychain service，改为仅配置 `appSecretEnv`，再通过进程环境或操作系统 service manager 注入：

```sh
LARK_APP_SECRET='...' dsh --profile web
```

`credentialHandle` 与 `appSecretEnv` 只能选一个；配置不接受 `appSecret` 等明文字段。handle 模式会把 adapter 的整个连接生命周期放在 credential lease callback 内。自然 TTL 到期会先清理旧连接，再申请新 lease 并重连；运维撤销或插件卸载会清理连接并停止续租，不能把 revoke 误当成 expiry 自动恢复。

若以 `appSecretEnv: LARK_APP_SECRET` 配合 `dsh-lark-setup --install-service` 运行，生成的 user unit **不会**继承登录 shell 的 `LARK_APP_SECRET`，也不会替你保存它。请使用自己的 supervisor，或为目标 profile 显式创建只限当前用户读取的 systemd drop-in，例如：

```sh
install -d -m 700 ~/.config/dsh ~/.config/systemd/user/dsh-profile-web.service.d
# 用编辑器创建 ~/.config/dsh/lark-web.env，内容为 LARK_APP_SECRET=...，并设为 0600；不要把 secret 放进 profile 或 shell history。
chmod 600 ~/.config/dsh/lark-web.env
cat > ~/.config/systemd/user/dsh-profile-web.service.d/secret.conf <<'EOF'
[Service]
EnvironmentFile=%h/.config/dsh/lark-web.env
EOF
systemctl --user daemon-reload
systemctl --user restart dsh-profile-web.service
```

## 已有飞书应用的手工配置

1. 在[飞书开放平台](https://open.feishu.cn/app)创建“企业自建应用”，在“凭证与基础信息”复制 `App ID` 和 `App Secret`。
2. 在“添加应用能力”中开启“机器人”。
3. 在“权限管理”中开通接收/发送单聊和群聊消息，添加最小 reaction 写权限 `im:message.reactions:write_only`，并为消息内图片下载添加 `im:resource`；如果控制台为接收事件提示额外权限，也一并按最小范围开通。
4. 在“事件与回调/事件订阅”中选择“使用长连接接收事件”，添加 [`im.message.receive_v1`](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)。使用审批卡片或 `/model` 选择卡片时，还要把“回调订阅方式”设为长连接并添加 `card.action.trigger`；普通消息 onboarding 不依赖这个可选回调。
5. 创建并发布应用版本，把可用范围至少包含你自己；未发布或不在可用范围时，飞书客户端可能搜索不到机器人或不会投递事件。

这一节只适用于手工输入 `--app-id` 的路径。一键选择/创建路径会在飞书确认页预置机器人、最小权限、消息事件与卡片回调；选择已有应用时这些配置只做增量添加，不会删除其现有权限。若企业策略要求管理员审批，仍需由企业管理员在飞书侧完成该审批。运行时不需要公网 callback URL；官方 Node SDK 的[长连接说明](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#%E4%BD%BF%E7%94%A8%E9%95%BF%E9%93%BE%E6%A8%A1%E5%BC%8F%E5%A4%84%E7%90%86%E4%BA%8B%E4%BB%B6)也说明本地环境只需能访问公网。

如果应用是在 reaction、图片桥接或模型卡片回调功能加入前通过向导绑定的，需要重新运行一次一键向导，确认新增的 `im:message.reactions:write_only`、`im:resource` 权限与 `card.action.trigger` 回调；随后按飞书要求发布新版本/完成管理员审批。指定 App ID 后，向导只增量更新该应用，不会新建第二个应用，也不会删除已有配置：

```sh
# 暂停旧长连接，避免 owner 确认消息被常驻实例竞争消费；向导结束会重新安装并拉起服务
launchctl bootout gui/$(id -u)/ai.deepseek.dsh.profile.web

~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app \
  --app-id cli_0123456789abcdef
```

如果在官方确认或 owner 私聊阶段中途取消，可运行 `dsh-lark-setup --profile web --install-service` 恢复原常驻服务。

长连接订阅至少需要：

- `im.message.receive_v1` 接收消息事件；
- 发送/回复消息所需的 IM 权限；
- 机器人读取自身身份所需权限；
- 如果希望群内无需 `@机器人` 就触发，必须同时把 `requireMentionInGroups` 设为 `false` 并在飞书侧申请更宽的群消息权限。

`account` 和 `tenant` 是 DSH 内部的稳定路由命名，不是 Secret。个人单应用通常保持默认 `account: primary`、`tenant: personal`；真正的飞书身份由向导发现的应用作用域 `open_id` 决定。

陌生外部身份仍会由 `assistant-delivery` 以 fail-closed 方式拒绝；不要依赖飞书侧“能收到事件”等同于已授权。

## 可靠性语义

- 事件处理器会等待 `assistant-delivery.acceptInbound()` 完成，即 inbox 落盘后才向长连接回调返回成功。
- 飞书 SDK 标准化产生的 `![image](image_key)` 等资源标记会在进入 Delivery 前被改写；纯图片消息的正文保持为空，provider image key 只保留在隔离的附件描述符中，不会伪装成用户提示词。
- 图片下载由 Delivery 在再次确认绑定、Policy、目标模型图片能力和 AttachmentStore 可用后显式调用，不在 WebSocket 回调内下载。adapter 只接受同一入站消息的严格 message ID/image key，并固定请求 `GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image`；拒绝 URL、路径片段、重定向和非图片资源。`imageDownloadTimeoutMs` 默认 30 秒，可设为 1–120 秒；总截止时间覆盖 tenant token 获取和资源 GET，caller 取消、插件卸载或 credential lease 切换在 token cache miss 阶段也会及时返回。调用方同时传入逐图 byte 上限，transport 在 header、流读取和 PNG/JPEG/GIF/WebP magic/MIME 三层校验。
- 只有合法、非重复且状态为 `queued` 的入站消息会异步添加 `Get`；未授权、死信或 provider 重放不会重复 reaction。精确表情类型为大小写敏感的 `Get` 和 `DONE`。
- Agent 的最终回复会显式携带原始飞书 `messageId`，先成功回复该消息，再异步添加 `DONE`。Delivery 在飞书返回有效 message id 后立即记录 `accepted`，不会等待 presentation-only reaction；发送失败、无最终回复、任务失败或取消均不会添加 `DONE`，reaction 失败只降级 channel health。首版保留 `Get`，不会为了替换表情再申请 reaction 读取权限。
- 执行进度使用飞书原生 `/open-apis/im/v1/message_cot` 展示：`showProgress: false` 可关闭。该接口不在固定版 Node SDK 的高层 API 中，因此作为可降级展示使用；创建或更新失败只记录 channel health，不会重跑任务或影响最终 Outbox 回复。HTTP 外层请求使用 `cot_id` / `message_id` / `event_type` 等 OpenAPI snake_case 字段；但 `events[].content` 是独立的 AG-UI JSON，文本事件必须使用 `messageId` / `delta`，run 与工具事件同样使用 `threadId`、`runId`、`toolCallId` 等 camelCase。混用外层 snake_case 会让飞书把 JSON 原样显示为正文，而不是渲染 COT 气泡。
- 进度映射只接受 Delivery 的强类型事件：开始、步骤说明、脱敏工具名、工具成功/失败、待办快照和终态；`assistant/chunk`（包括流式 `reasoning-delta`）、工具 arguments、工具 output、系统提示和错误详情不会进入飞书载荷。步骤说明优先取 `assistant/message` 已定稿的 `reasoning` 块（助手自己对该步的说明，不是流式片段）；**并非所有 provider 都会产出 reasoning**——订阅制 CLI 只声明 effort 能力、实际仅回传 `text`，ACP 的 thought 通道到 DSH reasoning 的映射尚未实现，因此 `step/start` 另外映射为中性阶段文案，保证这些 provider 也不会出现空面板。同一次运行的每条步骤/待办各用独立 `messageId` 追加，避免互相覆盖。
- 回合失败时除 `RUN_ERROR` 外还会在面板正文写入一行「任务未完成」，附带上游错误码（如 `ACP_PROTOCOL_ERROR`）：provider 可能在产出任何内容前就失败，只发 `RUN_ERROR` 会让面板停在首行、看起来像卡住。只透传短错误码，provider 的原始错误消息可能包含 prompt 或上游载荷，不出边界。
- Agent 回答按 Markdown 渲染：回答本身是 Markdown（表格、加粗、行内代码），以 `plain` 文本发送会把 `|---|`、`**` 等原始语法直接暴露给用户。Delivery 仅在渠道 adapter 声明了 `markdown` 能力时才请求该格式，否则降级为 `plain`——coordinator 会把 adapter 未声明的格式判为 `unsupported-format` 并丢弃整条消息，因此降级是为了保证回复不会因能力不匹配而丢失。回答卡片保持内容优先：不额外加 header（飞书已在气泡上方显示机器人名称与头像，再加会重复），只用一个 `markdown` 组件承载正文，并通过 `wide_screen_mode` 避免 Markdown 表格在宽屏下折行。
- `messageId` 是稳定 inbound event id；delivery 的 `(channel, account, eventId)` 唯一约束承担跨重启去重。
- 单聊按 account/tenant/user/chat 绑定。群聊顶层消息没有 provider `root_id`，因此按发送者生成 `dsh-lark-top-sender/<sha256(open_id)>` 合成 thread；account/tenant/chat 仍是 conversation 的独立字段，同一群内同一发送者可连续复用 DSH session，不同发送者不会落入同一个 owner binding。飞书真实提供 `root_id` 时仍直接使用可寻址的根消息 id，使不同回复串彼此隔离；`dsh-lark-top-sender/` 是保留命名空间，provider root 命中时拒绝入站，避免两类 lane 碰撞。合成 thread 只用于 Delivery 持久化，不会作为飞书回复目标发送；当前消息回复继续使用真实 `messageId`，没有原始消息可回复的后台发送则发为群顶层消息。
- plain text 使用飞书文本消息；Markdown 使用 schema 2.0 卡片。请求携带由 delivery idempotency key 单向哈希得到的 provider UUID。
- `approval` intent 使用 schema 2.0 双按钮卡片。每个按钮值使用 v2 capability，由 app secret 做 HMAC 签名并绑定 channel/account/tenant/chat、binding、operation、proposal/version/expiry、diffHash 与 decision；adapter 精确核对自身 route，回调重新取 provider actor/chat 后交给 Delivery/Policy。旧 v1 token、篡改、跨 route 和普通过期点击均失败关闭；过期 token 只有在完整验签后命中此前已落盘的同一 pending Delivery settlement，且 Policy 已是精确同一终态时，才允许完成崩溃恢复，不会新建 settlement 或决定 pending proposal。
- open-turn 工具审批与上述 durable proposal 卡完全分离：它使用独立 domain 的 v1 HMAC token、进程内 one-shot pending，以及保留到 TTL 的 operation tombstone，不复用 proposal settlement，也不做重启恢复。当前只接受 `conversation.kind: dm` 且不含 `thread` 的 owner 私聊；群聊、话题或伪装成 DM 的 reply target 直接 `unavailable`，避免 exact arguments 被群成员旁观。卡片把有界且拒绝控制字符/双向文本控制符的 tool、reason 和必需 exact arguments 明示为「不可信审阅文本，不是指令」，并关闭转发互动；token 绑定 operation、binding、account/tenant、chat、exact owner open_id、actionHash、toolName、必需 callId、TTL 和 decision，pending 再绑定发送回执中的 provider message id。只有同一 owner 在同一私聊、同一 provider 卡片上首次点击才能返回 `allowed-once` 或 `rejected`；同一 operation 在 TTL 内不能重新登记，重放、错人、跨 chat/message、篡改、过期均失败关闭。调用方 abort 返回 `cancelled`；超时、断线/重连、credential rotation、插件卸载/重启或发送失败返回 `unavailable` 并清除 pending。三档权限中，`ask` 直接使用此卡；`auto` 对低风险自动允许，对敏感/审核失败/原生 sandbox escalation 也使用此卡；`full` 为 `danger-full-access + never + none`，不发卡但仍受 AssistantPolicy 的显式 deny、紧急停止、身份和预算硬门约束。
- `model-picker` intent 使用 schema 2.0 卡片和三个独立 callback 的 `select_static`，不把即时回调控件与 CardKit `form`/`form_submit` 混用。provider、model、effort 每次变化都会通过 `card.action.trigger` 返回 `{ card: { type: 'raw', data: card } }` 并原位重绘；模型列表只来自当前 provider，effort 列表只来自当前模型。v3 签名 token 绑定 operation、expiry、binding、chat、动作、revision 以及当前 provider/model/effort，普通 callback 确认按钮直接提交该签名状态，不依赖 `form_value`；adapter 先拒绝篡改、过期、跨 chat 和级联错配，Delivery 再用持久 CAS 拒绝旧 revision，并核对 owner/Policy 与实时模型能力。确认操作先持久领取再快速响应飞书，最终选择、结算结果和 Outbox 回复在同一 SQLite 事务中提交；卡片 4xx 会自动降级为文字目录。三个下拉的当前项通过 `initial_index` 定位——飞书的 `initial_option` 按选项展示文本而非回传 `value` 匹配，直接写入 route 形态的 `value` 会静默回落到第一个选项；`initial_option` 仅在该文本唯一标识一个选项时附带，当前项不在选项列表内时两者都不下发，不伪造预选。卡片版式按飞书官方卡片风格规范组织：header 用 `title` + `subtitle` + `icon` 承载「这是什么 / 当前模型」，三个下拉各自放进带描边的 `interactive_container` 分块（而不是平铺 markdown 标签），每块含一行灰色 `notation` 说明，末尾只保留一个 `primary` 按钮作为唯一焦点。升级后应重新发送 `/model`，旧 v1/v2 卡片不会继续生效。
- `permission-picker` intent 使用独立 schema 2.0 三档卡片，当前档位显示勾选，full 使用 danger 样式和飞书原生二次确认。卡片关闭转发互动，三个按钮分别携带独立 HMAC capability；token 绑定 channel/account/tenant/chat、精确 owner、binding/version/session、权限状态指纹、目标档位与 TTL。adapter 先拒绝错人、跨 chat、篡改和过期，Delivery 再核对原 Outbox 及 provider message id、active owner/binding/session、Policy 和当前权限状态；通过后只把固定 `/permission` 命令送入同一 durable Inbox 串行路径，不在 adapter 内直接改权限。旧卡、复制卡和晚到的相反选择都不能覆盖新状态；卡片格式 4xx、缺少签名或结算能力时退回完整文字说明。
- 权限/格式错误是确定未发送；限流和未连接可以安全重试；网络超时或未知 SDK 错误进入 `unknown_after_send`，不会盲目重发。
- 当前飞书 API 没有为该发送 UUID 暴露可靠查询/对账接口，因此 adapter 明确声明 `reconcileUnknownSend: false`、无 delivered/read receipt；Delivery 会保留这类 `unknown_after_send` 等待 owner 决策，不会反复领取无实现的对账任务或消耗 attempt。

官方长连接会自动重连，但不提供可持久化 replay cursor 或历史补拉接口。本包记录 `reconnecting` / `connected-with-gap` 与 `gapGeneration`；它依赖飞书 redelivery 和 delivery inbox 去重，不宣称断线期间零丢失。若未来出现官方 cursor/backfill contract，应先加入崩溃与重放测试再启用。

## 安全与权限

`--allow-agent-tools` 是高权限显式开关。它为本地 Web/direct `foreground` 写入跨 preset/workspace 的通用 capability allow，并为 Delivery 当前/兼容的精确 canonical owner principal + preset + 绝对 workspace + `external` initiator 写入通用 capability 与工具级规则。默认不附带工具 deny：这些身份可达已挂载的动态 skill/插件工具，也能通过 `memory.search`、`wiki.read`、`automation.propose` 等插件内部二次 Policy 检查。`background` initiator 始终不在这两类规则中。

这里用通配 action/resource 而非逐个枚举工具名或插件动作，是因为两者都由部署实际挂载的插件与技能动态注册：任何静态名单在新能力出现的那一刻就已过期，表现为 Agent 已看到工具却被 `default-deny`，或工具进入插件后又被二次 Policy 门拒绝。

这组规则决定的是 Policy 层**可达性**，不是插件安装或挂载：未安装/未挂载的技能与插件不会自动出现。模型工具仍经过 sandbox、approval reviewer 和 `assistant-policy` 的 `tools/pre-execute`；插件内部动作仍经过各自的身份、参数、预算与业务硬门。显式 deny、紧急停止与这些硬门不被通配 allow 绕过；在 `ask` / `auto` 档，写文件、访问网络和危险命令仍可能进入审批。

owner 可用 `/permissions` 查看当前档位，并用 `/permission ask`、`/permission auto` 或二次确认的 `/permission full confirm` 切换。`full` 为 `danger-full-access + never + none`，会关闭逐次审批并放开 sandbox，但显式 Policy deny、紧急停止、身份校验和预算硬门仍然生效。若要收紧具体工具，应配置显式 deny 或改用更窄的 allow 规则；deny 优先于上述通配 allow。

Delivery 外部主体侧不放宽：`subject.id` 与 `subject.workspace` 始终是精确值；只有本地 `foreground` 规则为支持 Web/direct 切换而对两者使用 `*`，并由 `initiator: foreground` 隔离。Bash/Pwsh 本身仍可启动进程并读写其 sandbox 允许的内容；选择 `full` 后应把飞书 owner/应用范围保持在最小，并按需配置显式 deny、紧急停止和预算。

`skill` 是标准 DSH base 的 `tool-skill` row 注册的模型侧工具，它让 Agent 能发现并加载 `ctx.skills` 里的技能（含 `skill-filesystem` 提供的本机 SKILL.md）。它由上面的通用 capability/工具规则覆盖，无需单独授权。技能加载本身不额外提权，被加载技能内部的命令仍受同一 sandbox / approval / Policy 管线约束。

若外部会话报告某个工具被拒，先查 `~/.dsh/assistant-policy/policy.sqlite` 的 `audit_events`：`reason_code` 为 `default-deny` 说明该会话没有匹配到 allow 规则，通常是 principal、preset 或 workspace 与 Delivery 实际绑定不一致，运行 `~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools` 即可对齐；为 `rule-deny` 说明命中了显式 deny。注意这两者都不是审批拦截：审批由 `tools/pre-execute` 审查器发起，不写入 `audit_events` 的 denied 记录。

Policy tool guard 和插件内部 `authorizeAgent()` 都携带 Delivery 绑定的 canonical principal；Lark setup 生成的 external reply/capability/tool 规则只匹配当前 account 的精确 owner。其他 connector、Lark account 或 principal 即使使用相同 preset/workspace 也不会继承该授权。owner 在群内 @ 机器人时仍沿用同一 principal，因此这不是“仅 owner 私聊”的限制。

- **网络：**仅访问所选 `domain` 的飞书/Lark OpenAPI、token 服务和 WebSocket endpoint；图片读取使用固定的消息资源相对端点，不接受模型、消息正文或 provider payload 提供的 URL，并关闭重定向；没有通用 HTTP 工具。
- **凭据：**优先通过 `credentials-keychain` handle 获取；兼容模式只读取 `appSecretEnv` 指定的一项。值不写数据库、不进入 tool、health、route、日志或异常文本。`appId` 不是 secret。
- **文件系统：**运行时无业务文件读写；setup wizard 会原子更新所选 profile patch，通过 `assistant-delivery` 的本地控制面写入精确 owner，并以 `0600` 写入用户级 LaunchAgent plist、在 `$DSH_HOME/logs` 创建 Host 日志。官方 SDK 依赖的 `protobufjs` postinstall 只打印版本建议，仓库显式设为 `allowBuilds: false`，运行不需要安装脚本。
- **子进程：**运行时只使用 credential provider 的固定无 shell 命令。setup wizard 在 macOS 调用 `/usr/bin/security` 与 launchd，在 Linux 调用 `/usr/bin/secret-tool`、`/usr/bin/systemd-ask-password` 与 `systemctl --user`，Windows 调用固定 PowerShell DPAPI 命令与 Task Scheduler；自动生成的 Secret 只通过标准输入传递且缓冲区随后清零，不作为 argv 传递。所有平台都会调用 `dsh --dump-config` 验证 profile；常驻配置只包含解析后的程序路径和最小环境，不复制 ambient token/password。
- **浏览器：**setup wizard 会输出飞书官方的短期设备授权链接与二维码，但不会自动操控浏览器；由用户在飞书中选择已有应用或创建新应用，并查看、确认权限增量。
- **消息数据：**标准化文本、provider message id、chat/user/thread id，以及最多 10 个受限附件描述符会进入 delivery SQLite；raw 事件、token 和下载 URL 不保存，provider file key 只作为隔离账本中的不可信引用，不进入模型正文。授权 worker 下载的图片字节只交给 AttachmentStore，随后会话仅持有 AttachmentStore 返回的引用；本插件不把二进制写入 Delivery session 或 prompt。
- **进度数据：**仅发送有长度上限的工具名、已定稿的步骤说明、显式待办文本和固定状态文案；不发送流式思维链片段、工具参数/结果、凭据或内部错误详情。原生进度 API 与 reaction API 失败均按展示降级处理。
- **群消息：**默认必须直接提及机器人；`@all` 不等于提及机器人。最终授权始终由 delivery/policy 决定。

## 当前边界

- v0.1 自动处理文本及图片描述符入站、文本/Markdown-card 出站、durable proposal、owner-DM one-shot tool approval、model-picker 与 permission-picker 卡片、`Get`/`DONE` 状态和脱敏原生执行进度；模型仍不能提交任意 card JSON，也不能直接控制 reaction 或进度载荷。
- 仅图片资源具备受限下载能力，而且只有部署同时提供 Delivery 图片桥接与 AttachmentStore、当前模型明确声明图片输入能力时才会启用。文件、音频、视频和 sticker 仍只进入 durable metadata quarantine；本插件不做病毒扫描，也不提供附件出站上传。
- 消息编辑和上传尚未实现；未来也必须先创建 Delivery 的持久 operation，不得从模型直接调用 SDK。
- 单个飞书应用的长连接是集群竞争消费，不提供广播或多节点 exactly-once。当前 suite 的可靠性目标是受 supervisor 管理的单机进程。
- setup wizard 在 macOS 和 Linux 受支持，Windows 为 best-effort；它需要交互式终端和一次 owner 私聊，不接受 `--app-secret` 一类参数。一键模式会在用户扫码确认后通过飞书官方流程选择或创建应用；企业管理员审批等租户控制面仍由飞书强制执行。

## 常见问题

- **提示凭据或 bot identity 错误：**重新核对 App ID/Secret、`feishu`/`lark` 域和机器人能力；重新运行向导会更新同一 Keychain 条目。
- **一键创建链接过期或被拒绝：**重新运行 `dsh-lark-setup --profile web --create-app`；链接仅在页面显示的期限内有效，且只能由一位用户确认。
- **长连接成功但一直等不到短语：**确认事件接收方式是长连接、已添加 `im.message.receive_v1`、应用版本已发布且你在可用范围内，并且是私聊机器人原样发送短语。
- **`assistant_health` 显示 `disabled`：**向导尚未成功写入 profile，或常驻服务仍在运行旧配置；重新执行 `--install-service`。
- **`launchd bootstrap failed: Bootstrap failed: 5: Input/output error`：**新版安装器会检查稳定 job 状态并对这个 macOS 瞬时竞态做有限重试；先重新 build 本项目的 `lark-channel`，再执行 `dsh-lark-setup --profile web --install-service`。若仍失败，用 `plutil -lint ~/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist` 校验配置，并查看 `~/.dsh/logs/web-host.error.log`。
- **`caller is not allowlisted for this credential handle`：**这是旧版默认导出丢失稳定 Cordis plugin identity 导致的错误；更新并重新 build `lark-channel`，再执行 `--install-service`，不要把 credential consumer allowlist 改宽。
- **显示 `connected-with-gap`：**连接曾中断；飞书没有可持久化 replay cursor，检查这段时间是否有漏处理消息。
- **收到消息但无回复：**先发送 `/model`，选择一个目录中可用且已登录的 route；再看 `assistant_health`。未授权身份会 fail-closed，不会自动成为 owner。
- **能回复但提示技能/插件工具被拒绝：**先确认对应技能或插件已经安装并挂载到当前 profile，再升级并重启 `assistant-delivery`，确认 session 的 preset 在 create/resume 时已挂载；需要执行时运行 `~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools`，或手工添加 exact preset/workspace/initiator 的 capability 与工具 Policy。刷新命令不会重启服务；只执行 `--install-service` 会重启，不会改能力可达性规则。
- **没有弹出审批卡，却反复显示 `the user rejected tool`：**旧 native full session 可能只有 `danger-full-access + never` 而缺少 AssistantPolicy reviewer，导致 reviewer 保守回落为 `user`、工具进入 `ask-review`，又被 `approval=never` 在展示前自动拒绝；这不代表用户点过“拒绝”。升级构建并重启 `assistant-policy` 所在 profile；AssistantPolicy 会在已有 session 扫描、新建和执行门前全局迁移 Web/direct 与 Delivery 的精确 legacy full 状态，持久补齐 `reviewer=none`，Delivery create/resume 另做提前检查。非 full 的 `never` 状态会返回 `[approval-disabled] ... no user approval was requested`，不再错误归因。若随后出现 `default-deny`，运行 `~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools` 刷新 foreground/Delivery capability 可达性规则；不要把 `run_code` 在 ask/auto 档无条件白名单化，它仍是 bash-equivalent 执行面。
- **权限卡片未显示或点击后提示失效：**卡片只在 active owner 私聊中提供，并绑定原 chat、原卡 message id、binding/session、权限状态和 15 分钟默认有效期；群聊、过期卡、`/new` 后旧卡或期间已用文字切档都会退回/提示重发 `/permissions`。点击 Toast“已受理”后，以机器人随后发送的“已切换”回复为准；同一卡片想改选另一档时请重新打开。
- **有最终回复但没有 `Get` / `DONE`：**旧应用通常缺少 `im:message.reactions:write_only`。重新运行 `dsh-lark-setup --profile web --create-app`，在官方页面选择当前 App ID，确认权限增量并发布应用版本。reaction 失败不会阻断回答。
- **文字能回复但图片不能处理：**确认应用已获 `im:resource` 且新版本已发布，并确认 profile 已安装提供 `attachments` 服务的 AttachmentStore、当前 `/model` 路由明确支持图片输入。重新运行 `dsh-lark-setup --profile web --create-app --app-id <当前 App ID>` 可增量补齐飞书权限。下载拒绝路径型 key、重定向、超限内容、MIME/magic 不一致和非 PNG/JPEG/GIF/WebP 数据，这是预期的 fail-closed 行为。
- **看不到执行进度但能正常回答：**确认 profile 中 `showProgress: true`。原生进度接口是可降级能力，租户或应用类型不支持时最终回答仍会正常发送；查看 `assistant_health` 的 `larkChannel.lastErrorCode` 和 Host 错误日志定位权限/接口问题。
- **能看到模型卡片但下拉框不联动或确认后无回复：**确认应用已订阅 `card.action.trigger` 且回调方式是长连接；运行 `dsh-lark-setup --profile web --create-app --app-id <当前 App ID>` 会锁定该应用并以增量方式补齐回调。确认授权、发布应用版本、重启插件后，请重新发送一次 `/model`，不要继续使用升级前已打开的旧卡片。若实时目录已经变化或 effort 不受模型支持，机器人会要求重新发送 `/model`。

## 兼容性

- DeepSeek Harness：`>=0.1.0-rc.8 <0.2.0` 基线语义（通过 `assistant-delivery`）。
- `@dsh-enhanced/assistant-delivery`：`>=0.1.0 <0.2.0`。
- `@dsh-enhanced/credentials-keychain`：handle 模式为 `>=0.1.0 <0.2.0`；env fallback 不要求其激活。
- 官方 `@larksuiteoapi/node-sdk`：固定 `1.73.0`；使用 `WSClient`、`EventDispatcher`、`Client` 和 `normalize`，而不是高层 Channel 的内存 dedup/retry 状态机。

参见仓库的[兼容性基线](../../docs/compatibility.md)。
