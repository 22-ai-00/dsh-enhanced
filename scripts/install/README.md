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

- profile 已经启用飞书时，交互菜单默认保留当前 App，只重启常驻服务；
- 尚未配置时，默认进入现有 `dsh-lark-setup` 向导；
- 选择“重新配置”后，可以输入已有 App ID，也可以直接回车打开飞书官方页面，在页面选择已有应用或创建新应用；成功后覆盖当前 channel 绑定；
- App Secret 只通过安全输入或飞书官方设备授权取得，不进入脚本参数、profile 或日志。

自动化调用可以显式选择：

```sh
./scripts/install/install-local.sh --lark keep
./scripts/install/install-local.sh --lark configure
./scripts/install/install-local.sh --lark skip
```

`--no-service` 只跳过常驻服务安装/重启，不跳过插件和 profile 校验。`--dry-run` 打印完整安装计划但不修改机器。

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

两个安装器安装以下十个顶层 bundle：

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
