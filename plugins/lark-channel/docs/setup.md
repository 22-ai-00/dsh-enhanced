# 安装、凭据与常驻服务

本页记录 `@dsh-enhanced/lark-channel` 的完整接入流程。首次部署推荐使用 setup wizard；只有已在飞书控制台完成应用配置时，才使用手工凭据路径。

## 安装

先安装并配置 `@dsh-enhanced/assistant-policy` 与 `@dsh-enhanced/assistant-delivery`，再安装本包：

```sh
dsh plugin --profile web add @dsh-enhanced/lark-channel
dsh --profile web --dump-config
```

插件默认 `enabled: false`，因此安装不会立即读取凭据或联网。

## 推荐：setup wizard

安装完成后，让向导配置 Keychain、owner 身份、owner 工具策略、Web profile 和用户级常驻服务：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app
```

源码工作区可运行：

```sh
cd /path/to/dsh-enhanced
pnpm --filter @dsh-enhanced/lark-channel build
pnpm --filter @dsh-enhanced/lark-channel run onboard --profile web --create-app
```

向导依次完成：

1. 调用飞书官方 Node SDK 的 `registerApp`，显示十分钟有效的确认链接和终端二维码；
2. 在飞书中选择已有应用或创建新应用，并确认权限增量；
3. 把返回的 App Secret 写入 macOS Keychain、Linux Secret Service、无桌面 Linux 的版本化 `0600` protected-file，或当前 Windows 用户的 DPAPI 加密文件；Secret 不经过命令行参数、不写 profile、也不打印；
4. 使用真实凭据建立一次临时长连接；
5. 显示一次性 `DSH-CONNECT-...` 短语，并等待你私聊机器人原样发送；
6. 从单聊取得应用作用域内准确的 `open_id`，只把该身份配置为 owner；
7. 更新 `web/cordis.patch.yml`，启用 channel 并添加精确 ingress/reply/credential 规则；首次绑定 owner 默认创建本地 foreground 与精确 Delivery 主体的 capability/工具规则；随后运行 `dsh --profile web --dump-config` 自检；
8. 安装并启动该 profile 的用户级常驻服务：macOS 使用 launchd，Linux 使用 systemd，Windows 使用 best-effort Task Scheduler；命令均为 `dsh --profile web --no-open`；
9. 将同一应用以 stdin 凭据接入官方 `lark-cli` 的 DSH 专用配置，申请其全部业务域用户授权，核对服务端返回的用户身份与刚绑定的 owner 一致，再生成可动态读取 CLI 技能的原生 DSH 技能。

应用授权与用户业务授权在安装流程中完成。插件仍运行在 DSH Host 内；安装到 `web` profile 时，向导默认让该 profile 在后台常驻，不需要保持浏览器打开，也不需要另行运行 `dsh web`。

### 官方一键授权的范围

一键模式使用 OAuth 2.0 Device Authorization Grant。只传 `--create-app` 时，确认页同时提供“选择已有应用”和“创建新应用”；同时传 `--app-id` 时，只更新该已有应用。两种方式都会先显示权限、事件与回调增量，确认后才生效。

向导不传 `createOnly`，默认使用官方智能体应用权限模板（`addons.preset: true`），并增量补齐下列消息通道权限。传 `--no-business-tools` 则保留仅消息通道的 `preset: false`：

- `application:bot.basic_info:read`：连接时取得机器人身份；
- `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`：接收私聊和群内 @ 消息；
- `im:message.reactions:write_only`：添加 `Get` / `DONE`；
- `im:message:send_as_bot`：发送和回复消息；
- `im:resource`：按消息 ID 与该消息中的 image key 调用[消息资源接口](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get)下载用户图片；
- `im.message.receive_v1`：消息事件；
- `card.action.trigger`：审批卡片、模型级联选择和最终确认按钮。

消息通道自身的精确日历触发器仍需 `--create-app --calendar-readonly` 和 `allowedCalendarIds`；这与业务 CLI 在用户实际授权下提供的日历功能是两条独立路径。应用模板和 `auth login --domain all` 都不代表租户已经批准平台上的所有权限；后者申请 CLI 当前已知的业务域用户 scopes，平台限制和 CLI 的批量授权排除项仍然适用。

### 自动业务工具接入

安装器优先复用满足契约的本机 CLI，缺失时下载官方 npm `latest` 对应的精确稳定版本到 `$DSH_HOME/.dsh-enhanced/tools/lark-cli`。优先下载 GitHub release，失败时尝试官方安装器使用的镜像；两条路径都验证 npm SHA512 与包内记录的 release SHA256，不执行 npm 安装脚本或修改全局 npm。已验证的受管 CLI 可在后续安装中复用。

每个 DSH profile/account 的配置与授权记录保存在 `$DSH_HOME/lark-business`；App Secret 仅通过 stdin 交给 CLI。每次 CLI 调用都固定绝对命令、named profile、配置目录，并清除会抢占身份的外部 Agent/CLI 环境变量。Linux 凭据数据也存入专用目录；macOS/Windows 使用 CLI 的原生系统钥匙环，同一应用/用户的条目可能与其它 CLI 实例共享，不能视为独立凭据隔离。

首次用户授权会展示链接与二维码。授权完成后同时检查 CLI 授权结果、已验证状态，以及只读 `user_info` 的服务端 `open_id`；只接受绑定的 owner。已有有效授权在重装时更新应用凭据并重新核对身份，无需再次扫码。认证未完成或范围证据丢失时不启用新的业务技能，已经提交的消息通道配置会保留。同一 owner/app 的授权更新失败保留原有技能；更换 owner、app 或 account，以及显式关闭业务工具时，会在通道 owner 交接前撤下旧受管技能入口。撤下入口不代表撤销平台 token，原凭据配置仍保留。若后续通道配置事务失败并回滚，旧技能不会自动重新发布；按原绑定重跑向导并核对身份后可恢复入口。

生成的 `$DSH_HOME/skills/lark-business-*/SKILL.md` 由 DSH 原生文件系统技能提供者发现，按需读取当前 CLI 的 `skills list/read` 与 `schema`，无需复制一份易过期的 API 指南。技能明确记录适用的 profile/account/app/owner，不携带凭据，也不新增 Agent 循环。DSH 的用户技能目录对同一 DSH_HOME 的 profile 可见；这属于同一操作系统用户的 Full access 信任范围，不提供跨 profile 的凭据隔离。官方业务能力与权限机制参考 [larksuite/cli](https://github.com/larksuite/cli)。

事件与回调由官方流程预置为 WebSocket 长连接，不需要公网 callback URL。实现依据见飞书的[一键创建智能体应用](https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/overview)和 Node SDK 的 [`registerApp` 文档](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#%E4%B8%80%E9%94%AE%E5%88%9B%E5%BB%BA%E5%BA%94%E7%94%A8)。

### 复用已有应用

```sh
# 通过官方授权页增量补齐指定应用的权限、事件和回调（推荐）
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app \
  --app-id cli_0123456789abcdef

# 只安全录入已有凭据，不修改飞书控制台
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --app-id cli_0123456789abcdef
```

单独使用 `--app-id` 时，向导通过当前系统的安全输入读取 App Secret，适合已经自行配置控制台的应用。省略 `--create-app` 和 `--app-id` 时，向导会询问 App ID；直接回车进入一键选择/创建。

重复执行会更新同一 account 的受管配置，不会重复添加规则或 handle。首次绑定 owner 默认开放已安装的 Agent 工具能力；已有应用或 owner 配置保留现状，不会因重装重新开启已关闭的工具：

- 不传参数：首次配置默认开放，已有配置保留现状；
- `--preserve-agent-tools`：始终保留现有规则，首次配置也不新增通用工具授权；
- `--allow-agent-tools`：写入本地 foreground 与精确 Delivery 主体的通用 capability 可达性规则，并保留外部主体工具级 allow/deny；
- `--disable-agent-tools`：删除向导为该 account 管理的这些规则。

本地工具授权不等于取得全部飞书平台权限；当前 channel 的业务接口仍限于其已实现能力，应用和用户授权以飞书平台结果为准。普通重跑不会意外授权或撤权。profile 校验失败时会在进程内恢复原内容，不保留备份文件。

## 只刷新 Agent Policy

更新 capability 规则不需要重走 onboarding；未启用飞书的 Web/direct-only profile 也可刷新本地 foreground：

```sh
# 写入/刷新本地 foreground；若飞书已启用，同时刷新精确 Delivery 规则
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --refresh-agent-policy \
  --allow-agent-tools

# 删除 setup 托管的 foreground；若飞书已启用，同时删除该 account 的 Agent 规则
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --refresh-agent-policy \
  --disable-agent-tools
```

`--refresh-agent-policy` 必须与 allow/disable 之一搭配；除 `--profile` 外只可选 `--account`。本地 foreground 规则独立于 Lark row，总能在已安装的 personal-assistant profile 中刷新；只有 profile 已启用 Lark 时才重建精确 Delivery 规则，显式 account 也必须完全相同。

该模式不读取 App Secret、不发起设备授权，不修改 App、credential handle、owner、conversation binding 或其他 channel 配置，也不安装或重启常驻服务。它原子写入 profile 后立刻运行 `dsh --dump-config`；失败时原子恢复原 patch。

## 手工配置插件

不使用向导时，可在 profile patch 中填写真实值：

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
  progressDetails: direct
  statusReactions: true
  imageDownloadTimeoutMs: 30000
```

credential handle 由 `@dsh-enhanced/credentials-keychain` 提供，并应只允许 consumer `dsh-enhanced-lark-channel`、purpose `connect`。兼容部署可不激活 keychain service，改为只设置 `appSecretEnv`，再通过进程环境或操作系统 service manager 注入：

```sh
LARK_APP_SECRET='...' dsh --profile web
```

`credentialHandle` 与 `appSecretEnv` 只能选择一个；配置不接受 `appSecret` 等明文字段。handle 模式会让 adapter 的完整连接生命周期处于 credential lease callback 内。自然 TTL 到期时会先清理旧连接，再申请新 lease 并重连；运维撤销或插件卸载会清理连接并停止续租，不能把 revoke 当成 expiry 自动恢复。

若以 `appSecretEnv: LARK_APP_SECRET` 配合 `--install-service`，生成的 user unit 不会继承登录 shell 的变量，也不会替你保存 Secret。应使用自有 supervisor，或为目标 profile 创建仅当前用户可读的 systemd drop-in：

```sh
install -d -m 700 ~/.config/dsh ~/.config/systemd/user/dsh-profile-web.service.d
# 用编辑器创建 ~/.config/dsh/lark-web.env，内容为 LARK_APP_SECRET=...，权限设为 0600。
chmod 600 ~/.config/dsh/lark-web.env

# 用编辑器创建 ~/.config/systemd/user/dsh-profile-web.service.d/secret.conf：
# [Service]
# EnvironmentFile=%h/.config/dsh/lark-web.env
systemctl --user daemon-reload
systemctl --user restart dsh-profile-web.service
```

不要把 Secret 放入 profile 或 shell history。

## 常驻服务

已完成飞书配置，只需安装或重启服务时运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --install-service
```

若自行管理进程，在首次向导中加入 `--no-service`，然后用 supervisor 运行 `dsh --profile web --no-open`。不要同时启动前台与系统服务的两个相同 profile，否则 Web 端口和飞书长连接会竞争。

### macOS

向导创建 `~/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist`，登录后自动启动并在异常退出后拉起。配置只包含 `DSH_HOME` 与不含相对目录的 `PATH`，不会复制当前 shell 的 token、password 或其他环境变量。

```sh
launchctl print gui/$(id -u)/ai.deepseek.dsh.profile.web
tail -f ~/.dsh/logs/web-host.error.log

# 停止并卸载；再次执行 --install-service 可恢复
launchctl bootout gui/$(id -u)/ai.deepseek.dsh.profile.web
```

### Linux

向导创建私有的 `~/.config/systemd/user/dsh-profile-web.service`，只配置 DSH 所需路径及 Secret Service 可能需要的用户 D-Bus/XDG 定位。OAuth 前会检查 systemd user manager，并尝试为当前用户启用 linger，以便 SSH 注销后继续运行。若系统需要管理员授权，向导会在修改飞书应用前停止，并显示唯一需要执行的命令：

```sh
sudo loginctl enable-linger "$(id -u)"
```

日常运维：

```sh
systemctl --user status dsh-profile-web.service
journalctl --user -u dsh-profile-web.service -f
systemctl --user restart dsh-profile-web.service
```

纯 SSH 和无桌面 Linux 支持一键向导；内建服务仍要求 systemd/logind user manager 并允许 linger。不具备这些组件的容器应使用 `--no-service`，交给 Docker、s6、runit 等外部 supervisor。当前安装器要求可调用的 `systemctl` / `loginctl`；不符合这一约束的 Nix、Guix 或精简容器也应使用外部 supervisor。

### Windows

Windows 会把 DPAPI 加密的 PSCredential 保存到 `$DSH_HOME/credentials-keychain`，并创建当前用户的 `DSH profile web` 登录任务。不会保存明文，但 Windows/Node/npm/Git Bash 组合差异较大，因此只提供 best-effort 支持：

```powershell
schtasks.exe /Query /TN "DSH profile web"
schtasks.exe /End /TN "DSH profile web"
schtasks.exe /Run /TN "DSH profile web"
```

## Linux 凭据后端

默认 `auto`：若当前登录会话有可写且已解锁的 Secret Service，就使用系统钥匙环；纯 SSH、服务器、容器或 Secret Service 不可用时，自动改用 `$DSH_HOME/credentials-keychain/lark-<profile>-<account>-<32hex>.secret` 版本化私有文件。

向导在飞书 OAuth 之前确认 `credentials-keychain` 支持所选 provider，并对实际 backend 执行随机 canary 的写入、读回和删除；这样不会在应用授权后才发现版本混装或无法保存凭据。安装器会同时安装匹配的两个插件版本。

protected-file 的父目录必须为当前 UID 所有、权限 `0700`；文件必须为当前 UID 所有的 regular file、单硬链接、权限 `0600`。创建使用独占、拒绝跟随链接的版本化路径，写入和删除后同步父目录。Secret 不进入 profile、argv、环境变量或日志，Host 重启后由 `credentials-keychain` 读取同一路径。

protected-file 没有额外静态加密：同一 UID、root 和能读取该文件的备份系统仍可取得 App Secret。可显式选择：

```sh
# Secret Service 不可用时直接失败
dsh-lark-setup --profile web --linux-credential-provider secret-service

# 即使桌面钥匙环可用也使用 0600 私有文件
dsh-lark-setup --profile web --linux-credential-provider protected-file
```

手工输入已有 App Secret 时优先使用 `/usr/bin/systemd-ask-password`；若不存在但 stdin/stdout 是真实 TTY，则使用无回显 raw-terminal 后备，并在 Enter、Ctrl-C、SIGINT、SIGHUP 或 SIGTERM 后恢复终端模式。`--no-service` 只跳过 systemd 服务，凭据仍按上述 `auto` 规则选择。

### Secret Service 排障与事务恢复

若旧版在授权后留下 `setup failed and staged credential cleanup also failed`，不要删除 `$DSH_HOME/profiles/<profile>/cordis.patch.yml.lark-setup.journal.json`。新版确认 versioned locator 从未被 profile 激活后，会把清理义务原子转入 `cordis.patch.yml.lark-credential-cleanup.json`，清除阻塞事务并改用 protected-file 完成初始化；以后每次进入向导都会 best-effort 重试 Secret Service 清理。不要手工删除或编辑 cleanup record。

若看到 `profile and owner were committed, but previous credential cleanup is pending`，新 profile、owner 和凭据已经生效，不能回滚。向导保留同一 journal，以便修复 Secret Service 后优先重试删除旧凭据；不要删除 journal，也不要立即开始另一轮凭据旋转。

Ubuntu/Debian 图形桌面可用将运行 DSH 的普通登录用户打开终端；不要用 `sudo` 运行向导：

```sh
sudo apt update
sudo apt install --yes libsecret-tools gnome-keyring dbus-user-session
# 完整注销并重新登录后，在新的图形终端做无凭据检查
test -x /usr/bin/secret-tool
test -n "${DBUS_SESSION_BUS_ADDRESS:-}" || test -S "${XDG_RUNTIME_DIR:-}/bus"
```

OAuth 前的 canary 不读取、写入或显示 App Secret。出现钥匙环解锁对话框时先解锁；没有桌面 provider 时默认自动选择 protected-file，无需安装 GNOME Keyring。随后用原来的 profile/account/tenant/agent-tools 参数重跑；已创建应用可复用：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web --create-app --app-id cli_0123456789abcdef
```

`secret-tool` 与 GNOME Keyring 只在强制 `secret-service` 或希望使用桌面钥匙环时需要。

## 手工配置飞书应用

这一流程只适用于手工输入 `--app-id` 的路径；官方一键路径会预置机器人、所选应用权限模板、消息事件和卡片回调。选择已有应用时只增量添加配置，不删除现有权限。

1. 在[飞书开放平台](https://open.feishu.cn/app)创建“企业自建应用”，复制 `App ID` 与 `App Secret`；
2. 在“添加应用能力”中开启“机器人”；
3. 在“权限管理”中开通接收/发送单聊和群聊消息、`im:message.reactions:write_only` 和图片所需 `im:resource`；控制台若为接收事件提示额外权限，也按最小范围开通；
   如要启用精确 Calendar 变更触发器，额外开通 `calendar:calendar:readonly`，并仅向应用共享操作员指定的 Calendar；
4. 在“事件与回调/事件订阅”选择长连接，添加 [`im.message.receive_v1`](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)；使用审批卡或 `/model` 时，还需把回调订阅方式设为长连接并添加 `card.action.trigger`；
5. 创建并发布应用版本，把可用范围至少包含自己。未发布或不在范围内时，客户端可能搜索不到机器人或不投递事件。

企业策略需要管理员审批时，仍由管理员在飞书侧完成。运行时不需要公网 callback URL；Node SDK 的[长连接说明](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#%E4%BD%BF%E7%94%A8%E9%95%BF%E9%93%BE%E6%A8%A1%E5%BC%8F%E5%A4%84%E7%90%86%E4%BA%8B%E4%BB%B6)也说明本地环境只需能访问公网。

如果应用是在 reaction、图片桥或模型卡片回调加入前绑定的，应重跑一键向导，确认新增权限和 `card.action.trigger`，然后发布新版本或完成管理员审批。指定 App ID 只增量更新，不创建第二个应用：

```sh
# macOS：先暂停旧长连接，避免 owner 确认消息被常驻实例竞争消费
launchctl bootout gui/$(id -u)/ai.deepseek.dsh.profile.web

~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app \
  --app-id cli_0123456789abcdef
```

向导结束会重新安装并拉起服务。若在官方确认或 owner 私聊阶段取消，可运行 `dsh-lark-setup --profile web --install-service` 恢复原服务。

长连接至少需要消息事件、发送/回复消息权限和机器人身份读取。若群聊无需 `@机器人` 即触发，必须同时将 `requireMentionInGroups` 设为 `false` 并在飞书侧申请更宽的群消息权限。

`account` 与 `tenant` 是 DSH 内部稳定路由名，不是 Secret。个人单应用通常保持 `account: primary`、`tenant: personal`；真实飞书身份由向导发现的应用作用域 `open_id` 决定。陌生外部身份仍由 `assistant-delivery` fail closed；不能把“飞书能收到事件”视为已经授权。
