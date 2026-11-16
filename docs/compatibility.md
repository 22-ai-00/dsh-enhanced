# 兼容性基线

本页记录当前已验证的 DSH / Cordis / Node 运行时契约、CLI 与第三方适配器边界，以及跨包存储迁移规则。过往版本的逐期变更历史见 Git 提交记录。

## 0.2.2-rc.3 Host 基线与工具链

当前桌面 Host 与仓库验证基线锁定为 **DSH `0.2.2-rc.3`**：

- DeepSeek Harness 运行时与 npm 测试依赖：`0.2.2-rc.3`（workspace catalog 与源码安装同步固定）。
- **包与 peer 范围**：所有插件与共享包的 `@deepseek-ai/*` peer 范围收紧为 `>=0.2.2-rc.3 <0.3.0`，`@deepseek-ai/cordis` 为 `^4.1.0`（锁定 Loader / Include / Group `1.1.0`，参见 [Cordis runtime contracts](cordis-runtime-contracts.md)）。Host 使用 `semver.satisfies(..., { includePrerelease: true })` 检查范围；根 `tests/dsh-compatibility.spec.ts` 拒绝低于 `0.2.2-rc.3` 的基线或未验证的 `0.3.x`。已发布包基线以[发布账本](../release-manifest.json)为准。
- **Node.js 与 pnpm**：工作区与 `.node-version` 锁定 Node **`24.9.0`**（引擎兼容 `^22.19.0 || >=24.0.0`），Linux bwrap 行为隔离与 CI 验证节点（`.github/workflows/ci.yml`）使用 `/usr/bin/node` **`v22.23.2`**，包管理器锁定 **`pnpm@11.7.0`**。
- **依赖边界与无自引用约束**：插件不得把 `@deepseek-ai/dsh-*` 运行时包写成普通 `dependencies`（否则 Loader 会优先解析 profile 内旧副本并禁用 `working-directory`、`session-projection` 等根服务）；非必需的兄弟插件集成（例如 `assistant-dreaming` 读取可选业务插件服务）须声明为可选 `peerDependencies`。
- **循环构建引导（`build:bootstrap`）**：针对存在循环 `devDependencies` 的包组，根 `pnpm run build` 先按序执行 `build:bootstrap`（共享包 `packages/*` → `assistant-policy` → Evaluation `build:core` → Delivery → Isolation → Evaluation → Verifier → Automations → Preference Learning / Health / Evolution / Growth Experiments / Heartbeat / Recovery / Goals / Skills / Control Plane / Personal Memory / Memory Learning / Keychain / Actions / Event Triggers / `assistant-dreaming`），再以 `--workspace-concurrency=1` 递归构建全部工作区及前端产物（如 `owner-console/lib/client.js`）。
- **DSH `0.2.2-rc.3` 运行时契约**：
  - 使用显式 `ToolExecutor`（`@deepseek-ai/dsh-tool-executor-native` / `@deepseek-ai/dsh-tool-executor-ptc`）、批量 `tools.execute(ToolBatchInput)`、Session format `4`、生产者专属 `MessageSource`、顶层工具结果消息与 `agent-preset-registry`。
  - Agent setup 第二参数为确切未发布 Agent 实例（不再使用 `ctx.agent`）；子任务使用 `SubagentRuntime.startActivation()`；系统提示组装使用 `system-prompt/assemble` 并支持 `runtime-context` 用户消息与 suppression；自定义 setup CLI 通过所选 Host 原生 `createRuntimeResolution` 与 `PluginPackages` 解析，不依赖已移除的 fallback API。
  - **助手审批与 Harness 原生 Auto 分离**：Policy 不注册保留档位 `auto`，也不凭原生 Auto 选择启动项目 reviewer；助手 `/permission auto` 基于 `workspace-write + ask` 与 required reviewer 事件；安装器与 `dsh-permission-setup` 只接受 `workspace-write` / `danger-full-access` 静态默认。

## 插件配置、UI 与多编程 Agent 兼容

- **配置与预设（`dsh-plugin-setup` / `assistant-policy`）**：覆盖 `owner-console`、`assistant-proactive`、`assistant-dreaming`、`assistant-growth-driver`、`assistant-memory-learning`、`assistant-work-items`、`assistant-goals`、`assistant-delivery`、`assistant-evaluation`、`event-triggers` 等已登记可选键（`knownOptionalKeys`）。默认不改变权限或自动激活学习能力；`preset recommended` 仅对已加载包按前置启用安全观测开关，`assistant-dreaming` 保持 fail-closed 休眠直到显式 `scope`、`$DSH_HOME` `databasePath`、`provider`/`model` 与 `budgetId`/`budgetAmount` 齐备。
- **Owner Console（`owner-console`）**：发布 `./client`（`lib/client.js`），向 DSH 原生左栏注册 `sidebar.panellist`、`main`、`settings.section`、`settings.section.icon`、`settings.general.item`、`settings.models.footer` 及 6 个 `plugins.bundle.config` 槽位；所有配置与包管理写入经 Host `settings` / `pluginManager` 或受控 Typert remote，浏览器侧不持密钥、不直连模型。
- **ACP 双编程 Agent（`traex-acp-provider` / `dsh-model-setup`）**：基于 ACP SDK `0.25.1`（protocol v1）在同一包行同时支持 `traex-agent`（`enabled` / `command`，`traex --sandbox read-only --ask-for-approval never acp serve`，`traex login status`）与 Antigravity CLI `agy-agent`（`agyEnabled` / `agyCommand`，`agy acp --sandbox --include-default-customizations=false --disable-telemetry --stdio`，无交互 `agy models` 探活、交互 `agy` 或 `agy acp --login` 登录），支持 `.volatile()` 配置热重载；注意 `agy acp` 缺少 `--ask-for-approval never`，请勿在不可信仓库配置本地 auto-approve。
- **其他外部 CLI 与渠道基线**：
  - `coding-subscription-provider`：Codex CLI `0.147.0`–`0.150.1` 或实验性 direct-responses、Claude Code `2.1.218`、Grok Build `1.0.5`、Cursor CLI（实验性未实机验收）。
  - 飞书渠道：`@larksuiteoapi/node-sdk@1.76.0`（含长连接卡片回调桥与 table 行高适配）。
  - 安装期 `pnpm` 11 ANSI 构建审批兜底：写入 profile `pnpm-workspace.yaml` 的受限决策表（`koffi: true`、`protobufjs: false`），并支持半装 bundle 自动恢复。

## 跨包存储、隔离与升级边界

- **只增 / 不可降级 SQLite 账本**：WorkItems schema 10–13（intake / evaluation / admission / provenance index）、Delivery schema 24–31（自然反馈 / 同码维护重启见 [Delivery](../plugins/assistant-delivery/README.md#受控维护重启) / 独占续办与报告反馈 / 注意力审计）、Evaluation schema 12–18（canonical writer fence / 通知结果与 WP22 主人提问）、Memory schema 5–7（知识导出 v2 与有限经验采用）、Isolation schema 9（含 `linux-native` 资源预留；审计归档线协议另为 schema 2）、Control Plane schema 15–41。升级前须停止旧 writer；降级打开新版数据库一律 fail-closed。
- **Linux 原生隔离（`assistant-isolation`）**：唯一 Linux 后端为 `backend: 'linux-native'`（bubblewrap、user/mount/PID/network namespace、有界 tmpfs 与已委派 cgroup v1 控制器；拒绝 cgroup v2）。Docker 构建与执行后端已移除，历史 Docker ledger 与 `isolated-runner` 配置仅保留只读解码供迁移校对；macOS 使用原生 sandbox/seatbelt。
- **Host 升级与 `docker→native` 迁移**：
  - 通用 `dsh-rsi install` 解析官方 `latest` 并锁定到已验证基线，将绑定入口写入 `$DSH_HOME/.dsh-rsi-host.json`。
  - `dsh-rsi update --all --yes` 对冻结 Linux owner Home 仅允许**原安装为 Docker 后端**、原 Host 属于 `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.2-rc.1` / `0.2.2-rc.3`（目标固定 `0.2.2-rc.3`）、绑定官方 `dev`/`main` 可干净快进、授权未过期且创建/审查/回归/采用历史库均为空的场景；已有 native owner 的原地程序升级、非空创建历史迁移、完整 live Docker→native 切换及冻结 Mac Home 均不支持/未验收。详情见[维护说明](../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)、[CLI 升级与重装](../packages/dsh-rsi-cli/README.md#升级与重装)、[联合迁移](../scripts/install/README.md#旧-home-的联合-host--源码迁移)与[首次 owner 修复](../scripts/install/README.md#已-applied未首次采用的-owner-修复)。
  - Linux service-aware `supervised` 升级要求 systemd user manager、`flock`、Perl、`/usr/bin/python3`、bubblewrap 与同文件系统 `DSH_HOME`（`renameat2`），预览过程只在隔离副本内临时屏蔽 `larkChannel`。

## 本地源码维护历史（Control Plane schema 28）

schema 28 在停服副本事务中为冻结源码保留不可变 `initialCommit`、签名维护链及部署 watch 锚点（readonly store 使用 SQLite immutable 模式并先核验已 checkpoint、无未结 WAL）：

- 仅当原安装具备空 owner 权限、有效私有 Host 收据与对应协调器占位时，checkout 内 pre-owner 维护事务才允许更新 runtime/release/cohort（含 `--add-memory-learning` 扩展受审 AST 核对）；已建立 owner/coordinator 的通用源码升级仍保留隔离限制。
- 动态工具与修订采用沿 Control Plane schema 27–41 与 Verifier 独立回归/保持用例运行，并保留物理回退与签名证书账本；具体门禁见 [新工具插件的有限动态采用](../plugins/plugin-control-plane/README.md#新工具插件的有限动态采用)、[已发布 owner 修复的有限采用](../plugins/plugin-control-plane/README.md#已发布-owner-修复的有限采用) 与 [自动创建新插件候选](../plugins/plugin-control-plane/README.md#自动创建新插件候选)，最新交付边界以 [RSI 状态](rsi-status.md) 为准。
