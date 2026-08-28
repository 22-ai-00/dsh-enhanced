# 安装、诊断与重启

安装器先确保 Node.js、pnpm 和 DSH `0.1.0-rc.8`，再按场景安装最小 bundle 集合。首次非交互运行和 `--yes` 都选择安全的 `core` 场景：安装个人助理四核心和只读的插件控制面，不创建飞书应用、不启动 daemon、不发送模型请求。

```sh
./scripts/install/install-local.sh --yes
```

交互运行不传参数会选择场景；自动化可显式指定：

```sh
# 本机 Web/direct 核心
./scripts/install/install-local.sh --scenario core --yes

# 飞书/Lark 持久消息与 owner onboarding
./scripts/install/install-local.sh --scenario lark --lark configure

# 飞书 + TraeX + 审批门控行为成长；必须保留常驻服务
./scripts/install/install-local.sh --scenario supervised --lark configure
```

飞书向导支持纯 SSH/无桌面 Linux：默认先探测 Secret Service，不可用时会在 OAuth 前自动验证并改用当前用户 `0700` 目录下的版本化 `0600` protected-file，不要求安装 GNOME Keyring。该文件没有额外静态加密，同 UID、root 与可读备份仍能读取；需要强制系统钥匙环时可在安装后直接运行 `dsh-lark-setup --linux-credential-provider secret-service`。

管理内建服务时，安装器会在 OAuth 前检查 systemd user manager 和 lingering。当前用户有权时会自动启用 lingering；需要管理员权限时，交互向导会先展示唯一的固定提权命令，并询问是否现在通过 `sudo` 执行，密码由 `sudo` 直接读取，不进入安装器、参数或日志。拒绝、失败或非交互运行都会在云端授权前停止并给出同一条可复制命令。容器、未启用 systemd 的 WSL 或其他没有 systemd user manager/logind 的系统应使用 `--no-service`，并由 Docker、s6、runit 等外部 supervisor 保持 `dsh --profile <name> --no-open` 常驻；此时安装器不会宣称或验证内建服务的注销后存活能力。

`--with coding|traex|health|heartbeat|events|bridge` 按需追加能力。`--scenario full` 只用于迁移旧的全量默认集合；新安装不应使用它。`--mode supervised-growth` 保持兼容，等价于 supervised 场景。

核心 profile 中的 `plugin_discover` 可立即按能力检索内置、完整性固定的首方候选目录；它不会下载或启用任何包。Agent 只能生成待审批 plan，owner 仍需用 `dsh-plugin-control approve` 与 `activate` 在 staging profile 中显式启用。写入 `~/.dsh/plugin-control/catalog.json` 的 owner catalog 会取代内置目录。

默认 Permission 是 `workspace-write + ask`；完整访问需要明确确认：

```sh
./scripts/install/install-local.sh --permission danger-full-access --confirm-dangerous-full-access
```

默认不更改安装器托管的 Agent capability 规则。飞书场景中才可显式用 `--agent-tools allow` 或 `--agent-tools disable`；`core` 场景保持 `preserve`。模型 route 不会被安装器静默调用；配置模型后可请求一次最小验证：

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

本地源码改动后仅重建并重启已有常驻服务：

```sh
./scripts/install/restart.sh [profile]
```
