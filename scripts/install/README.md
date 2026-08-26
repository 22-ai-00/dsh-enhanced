# 一键安装与重启

本目录提供两个安装入口和一个开发重启入口。安装脚本默认使用 `web` profile，会检查 Node.js、npm、pnpm 和 DSH `0.1.0-rc.8`，缺少或版本不匹配时自动安装兼容版本，然后安装完整但不重复挂载的个人助理插件集合。

## 本地源码安装

在仓库根目录运行：

```sh
./scripts/install/install-local.sh
```

它会执行 `pnpm install`、`pnpm build`，再把当前仓库的插件绝对路径链接到 profile。修改源码后可以直接重新构建和重启，不需要发布 npm 包。

指定其他 profile：

```sh
./scripts/install/install-local.sh --profile personal-web
```

## 部署模式

默认 `--mode standard` 保持保守行为：安装核心和消息能力，但不授权后台任务，也不启用
Automations scheduler。

`--mode supervised-growth` 是显式选择的受监督成长模式。它额外安装
`@dsh-enhanced/assistant-evolution`，并要求可运行的飞书 onboarding 与常驻服务：

```sh
./scripts/install/install-local.sh --mode supervised-growth --lark configure
```

在飞书 onboarding 完成后，安装器会调用 `dsh-supervised-growth-setup`。该激活器只接受一条与
当前 Lark account/tenant 以及 Delivery 的默认 workspace/preset **完全匹配**的活动 owner 私聊
binding；找不到时会提示 owner 再私聊机器人，并在有界超时后不改 profile。多个匹配 binding 会拒绝，
不会猜测收件人。

激活器从 DSH 的**有效组合配置**（而不是可能为空的用户 patch）解析 Delivery/Automations 的实际
SQLite 路径；写入后再次 `dsh --dump-config`，逐项验证最终 route、budget、heartbeat 和精确 Policy
规则仍未被高优先级 layer 覆盖。它还会重读已选 binding 的版本、状态和 route，并进行有界的 TraeX
登录/只读 model catalog readiness probe；找不到 CLI、未登录、没有可用模型或 Host 重启后未通过健康
检查时，会恢复原 profile 和原常驻服务，不会报告已启用。

overlay 将 Delivery 前台路由设为 `traex-agent/default`，并创建一个精确 owner 的 heartbeat：08:00–22:00
每 120 分钟恰好 7 次；仅允许先 `evolution_review`、随后最多一次 `evolution_propose`，每轮最多 2 次
工具调用、512 输出 token。它使用 `automation-runs` 的 workspace 日预算（每天最多 7 次、每次固定
计 1），不把 512 输出 token 误称为总 token 上限。审批卡只能由固定的 Evolution 背景主体投递到
该 owner binding；proposal 仍必须由 owner 审批。scratch 明确禁止 decide/apply、修改代码、凭据、
Policy 或既有 automation；没有候选时只能输出 `HEARTBEAT_OK`。overlay 不授予 bash、read、文件系统、
网络或凭据权限。

为防止 scheduler 静默启动遗留任务，Automations DB 中**任何**已有 active job（包括旧
`assistant-heartbeat` 高权限任务）都会默认阻止激活且不写配置。确认这些任务可以在 scheduler 开启后继续运行时，显式传入：

```sh
./scripts/install/install-local.sh --mode supervised-growth --lark configure --ack-existing-automations
```

该确认不会自动恢复、修改或新增它们，但不会阻止 scheduler 领取这些仍为 active 的任务。此模式不能与 `--lark skip` 或
`--no-service` 一起使用。Windows 的 Task Scheduler 没有本实现可验证的 running/crash health gate，
因此 supervised-growth 在 Windows fail closed；标准安装仍保持原来的 best-effort 行为。

## npm 安装

全部包发布后，可以在没有本仓库 checkout 的机器上运行：

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh)"
```

默认安装 `latest`。部署固定版本时：

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh)" \
  -- --plugin-version 0.2.0 --profile web
```

当前尚未发布到 npm 的版本不能使用这个入口；请先使用本地源码安装脚本。

## 飞书配置

默认 `--lark auto`：

- profile 已经启用飞书时，交互菜单默认保留当前 App，先按 `--agent-tools` 选择非交互刷新托管 Policy，再重启常驻服务；
- 尚未配置时，默认进入现有 `dsh-lark-setup` 向导；
- 选择“重新配置”后，可以输入已有 App ID，也可以直接回车打开飞书官方页面，在页面选择已有应用或创建新应用；成功后覆盖当前 channel 绑定；
- App Secret 只通过安全输入或飞书官方设备授权取得，不进入脚本参数、profile 或日志。

自动化调用可以显式选择：

```sh
./scripts/install/install-local.sh --lark keep
./scripts/install/install-local.sh --lark configure
./scripts/install/install-local.sh --lark skip
```

`--lark keep` 不重走 App/owner onboarding；`--lark skip` 也不会启用或修改 channel。当 Agent 能力模式为默认 `allow` 或显式 `disable` 时，两种路径都会先在已安装 profile 中调用对应的非交互 Policy 命令：

```sh
# --agent-tools allow（默认）
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools

# --agent-tools disable
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup --profile web --refresh-agent-policy --disable-agent-tools
```

该刷新子命令只编辑 setup 托管的 Policy 规则，原子写入后运行有效 profile 校验，失败则原子回滚；它不读 App Secret、不发起设备授权、不修改 App/credential/owner/binding，也不自行重启服务。未启用 Lark 时只处理 Web/direct foreground 规则；已启用时再处理精确 Delivery 规则。刷新成功后，安装器的 keep 路径才独立执行常驻服务重启；skip 路径不安装或重启服务。`--agent-tools preserve` 则跳过 Policy 刷新。

`--no-service` 只跳过常驻服务安装/重启，不跳过插件和 profile 校验。`--dry-run` 打印完整安装计划但不修改机器。

## Agent 能力授权

`personal-assistant` bundle 已内置本地 Web/direct `foreground` grant，确保直接 `dsh plugin add` 后即可使用 profile 已挂载的能力。安装器默认 `--agent-tools allow`，会把该 grant 物化为可管理的 profile override，并生成 Delivery 外部身份的精确规则；前者允许用户自由切换 preset 与 workspace，后者仍固定精确 preset、绝对 workspace 和 `external` initiator。通配 action/resource 除覆盖标准 `skill` 及技能/插件动态注册的工具，还覆盖 `memory.search`、`wiki.read`、`automation.propose` 等插件内部二次 Policy 动作。`background` initiator 不因此放宽。

这些明确 grant 是必需的，而不是可选优化：AssistantPolicy 对没有匹配规则的工具预执行和插件内部 `authorizeAgent()` 都以 `default-deny` 拒绝。bundle 内置规则负责 direct-install 的本地 foreground；安装器刷新负责可撤销地协调该规则，并在已启用 Lark 时补齐精确 external 身份。两条路径都不会把 default-deny 改成全局 default-allow。

```sh
# 默认：授权本地 foreground；有活动 Lark 时也授权精确外部身份访问已挂载能力
./scripts/install/install-local.sh

# 只安装/升级，不改动已有能力规则
./scripts/install/install-local.sh --agent-tools preserve

# 移除安装器托管的 foreground，并在有活动 Lark 时移除 Delivery Agent 能力规则
./scripts/install/install-local.sh --agent-tools disable
```

这些 capability 规则只建立 Policy 层的**可达性**，不会安装技能、安装插件或挂载尚未进入 profile 的能力。模型工具仍经过 session sandbox、approval reviewer 和 `tools/pre-execute`，插件内部动作仍经过该插件的身份、参数、预算与业务硬门，显式 Policy deny 和紧急停止始终优先。personal-assistant 把原生 Permission selector 完整设为 ask/auto/full；没有用户设置的新安装默认 `danger-full-access`。安装器绝不改写已有 `settings.yaml`：`workspace-write`、`auto`、`danger-full-access` 原样保留，`read-only`、未知或无法安全解析的 `permission.defaultPreset` 会在任何安装动作前明确失败，要求用户自行选择。owner 也可在飞书发送 `/permissions` 查看或切换档位；full 仍受显式 Policy deny、紧急停止、身份和预算硬门约束。

`--lark skip` 不修改任何 channel 配置，但能力 Policy 与 channel onboarding 相互独立：默认 `allow` 仍会写入 Web/direct foreground 规则，显式 `disable` 会移除托管规则，`preserve` 才完全不改 Policy；该路径不会安装或重启 Lark 服务。

## 一键重启

修改本地插件后运行：

```sh
./scripts/install/restart.sh
```

唯一可选参数是 profile；不传默认为 `web`：

```sh
./scripts/install/restart.sh personal-web
```

它只执行 `pnpm build`，再重启已经安装的常驻服务，不运行 `dsh plugin`、不更新 profile、不重新申请飞书应用，也不修改凭据。macOS 使用 `launchctl kickstart -k`，Linux 使用 `systemctl --user restart`，Windows 使用 Task Scheduler 的结束/启动操作。

## 安装集合

`standard` 模式安装以下十个顶层 bundle：

1. `coding-subscription-provider`
2. `traex-acp-provider`
3. `personal-assistant`
4. `assistant-delivery`
5. `credentials-keychain`
6. `lark-channel`
7. `memory-wiki-bridge`
8. `assistant-heartbeat`
9. `event-triggers`
10. `assistant-health`

`supervised-growth` 在此基础上额外安装 `assistant-evolution`，并在精确 owner onboarding 成功后运行
上述受限激活器。

`personal-assistant` 会携带 Policy、Memory、Wiki 和 Automations 四个核心包，因此安装器不再把它们作为顶层 bundle 重复挂载。`acp` 只能安装到专用 ACP profile，`hello` 是示例插件，两者不会进入 Web 个人助理集合。安装 provider 不会自动启用 Claude；未安装或未登录的本地 CLI 也不会由安装器强制打开。

## 操作系统

| 系统 | 飞书凭据 | 常驻服务 | 支持级别 |
|---|---|---|---|
| macOS | Keychain | launchd LaunchAgent | 支持 |
| Linux | Secret Service (`secret-tool`) | systemd user service | 支持 |
| Windows | 当前用户 DPAPI 加密文件 | Task Scheduler | best-effort，不作兼容承诺 |

Linux 需要桌面会话中可用的 Secret Service、`/usr/bin/secret-tool`、`/usr/bin/systemd-ask-password` 和 systemd user manager。服务器或容器没有这些设施时，使用 `--lark skip --no-service` 安装插件，再按照 `lark-channel` 文档使用环境变量和自己的 supervisor。Windows 安装脚本需要 Git Bash；DPAPI 文件只能由创建它的 Windows 用户解密。

安装完成后可以检查：

```sh
dsh --profile web --dump-config
```

日志：

```sh
# macOS
tail -f ~/.dsh/logs/web-host.error.log

# Linux
journalctl --user -u dsh-profile-web.service -f

# Windows PowerShell
Get-Content -Wait "$HOME/.dsh/logs/web-host.error.log"
```
