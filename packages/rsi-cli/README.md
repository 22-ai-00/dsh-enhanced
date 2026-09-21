# @dsh-enhanced/rsi-cli — 全局 `dsh-rsi` 命令

DSH enhanced 插件集合的控制 / 诊断 / 彻底卸载工具。安装插件集合（npm cohort 或本地 checkout 形态）后，安装器会同时把本包装成全局 `dsh-rsi` 命令；也可单独安装：

```bash
npm install --global @dsh-enhanced/rsi-cli
```

零运行时依赖（仅用 Node.js 内置模块），要求 Node.js `^22.19.0 || >=24.0.0`，支持 macOS 与 Linux。

## 命令

```
dsh-rsi [全局选项] <命令>
```

| 命令 | 说明 |
| --- | --- |
| `status`（默认） | 列出 DSH home、各 profile 与安装形态（npm 实体副本 / local 符号链接）、全局 host 版本、launchd / systemd 受管服务状态、外部凭据条目数、生命周期事务/锁残留。**只读**。 |
| `doctor` | 在 `status` 基础上扫描各 profile 的 `*-host.error.log`，识别已知崩溃模式（如旧版 event-support oracle 拒绝注册）并给出升级/重建建议。**只读**。 |
| `purge` | 彻底卸载：进程静止检查 → 停服注销 → tar.gz 备份 → 删除 profile / DSH home / 生命周期残留 → 清理外部凭据。 |
| `version` | 打印版本。 |

全局选项：

- `--dsh-home <path>`：指定 DSH home（默认取 `$DSH_HOME`，否则 `~/.dsh`）
- `--profile <name>`：仅操作单个 profile（`purge` 默认全量）
- `--dry-run`：只打印将执行的动作，不做任何修改
- `--yes`：`purge` 时跳过交互确认（脚本 / 管道场景）
- `-h, --help`：完整帮助

## status / doctor

```bash
dsh-rsi status
dsh-rsi --profile web status
dsh-rsi doctor
DSH_HOME=/custom/.dsh dsh-rsi doctor
```

两个命令都不修改任何文件，适合在升级、报障或怀疑安装损坏时先跑一遍。

## purge（彻底卸载）

```bash
# 先看计划（强烈建议）
dsh-rsi purge --dry-run

# 全量 purge（交互时需输入 purge 确认）
dsh-rsi purge --yes

# 只清单个 profile，保留兄弟 profile 与共享 DSH home
dsh-rsi purge --profile web --yes

# 连同全局 @deepseek-ai/dsh host 一起卸载（仅限全量）
dsh-rsi purge --yes --remove-host

# 不备份、保留外部凭据
dsh-rsi purge --yes --no-backup --keep-keychain
```

purge 选项：

- `--no-backup`：删除前不生成 `~/dsh-purge-backup-<UTC时间戳>.tar.gz`（默认备份，权限 0600）
- `--keep-keychain`：保留 macOS Keychain / Linux Secret Service 中的受管凭据
- `--remove-host`：同时 `npm uninstall -g @deepseek-ai/dsh`（仅限全量；默认保留 host）

### purge 会删除 / 保留什么

**删除：**

- 全量：整个 DSH home（profiles、logs、uninstalled-profiles、home 内锁文件），以及 home 外的生命周期事务目录、失败诊断目录、home 锁与 `/tmp` rendezvous 锁
- 单 profile：`profiles/<name>`、对应的两份 host 日志、归属该 profile 的失败诊断目录
- 受管常驻服务：macOS `launchctl bootout` + 删除 `~/Library/LaunchAgents/ai.deepseek.dsh.profile.<p>.plist`；Linux `systemctl --user disable --now` + `reset-failed` + 删除受管 unit 文件
- 外部凭据：按各 profile 的 setup journal / cleanup 记录**权威反查** service 前缀为 `dsh/` 的条目，逐条从 Keychain（`security delete-generic-password`）或 Secret Service（`secret-tool clear`）删除；home 内的 protected-file 凭据随 home 一起删除

**保留：**

- 本地 checkout 源码：local 形态在 `node_modules/@dsh-enhanced/` 下是指向 checkout 的符号链接，purge 只随 profile 目录删除链接本身，**绝不删除 checkout**；报告中会列出 checkout 路径，确认无用后可自行 `rm -rf`
- 全局 `@deepseek-ai/dsh` host（除非加 `--remove-host`）
- 外部凭据（加 `--keep-keychain` 时）

### 安全门控

- **进程静止检查**：发现仍在运行的 profile host 会拒绝执行（列出 PID 与完整命令行），不代为 kill；请先停用服务或手工退出后重试。
- **systemd unit 归属 fail-closed**：仅当 unit 文件内容同时包含受管标记（`DeepSeek Harness profile`、对应 `--profile <p>`、`--no-open`）才删除；归属不明的同名文件只报告、保留。
- **凭据先于文件清理**：外部凭据删除失败会立即中止（文件尚未删除，journal 仍可用于复查），避免出现「文件没了但凭据残留且无法反查」。
- 单 profile 与 `--remove-host` 互斥；仅支持 macOS / Linux。

### 与安装器 `--operation uninstall` 的区别

安装器的 `uninstall` 是**保留数据的归档**：把旧 profile 移到 `$DSH_HOME/uninstalled-profiles/` 并重建干净基础 profile，凭据 / Session / Goal 等状态保留。`dsh-rsi purge` 是**彻底删除**：删除 DSH home 与生命周期残留（默认先打 tar.gz 备份），用于崩溃救机、报废环境或干净重装。

## 崩溃机器上的单文件救机脚本

机器上没有 `dsh-rsi` 时（host 已损坏或全局命令被删），可直接运行仓库中的自包含脚本；它会优先委托 `dsh-rsi`，找不到时使用等价的内联精简实现：

```bash
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/purge.sh \
  | bash -s -- --yes
```

该脚本是 mutable-main 运维脚本（非供应链引导路径），参数与 `dsh-rsi purge` 一致。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含 dry-run、目标不存在的幂等场景） |
| 1 | purge 执行失败（活动进程、服务/凭据错误等） |
| 2 | 参数错误 |

## License

MIT
