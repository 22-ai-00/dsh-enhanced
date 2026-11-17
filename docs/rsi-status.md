# RSI 当前状态

更新：2026-11-17（npm `0.1.74` 已发布，`d26bcf0b` 上已集成 Stage 1 渠道无关自主授权/自助升级，本分支继续完成 Stage 2 `cgroup v2` 跨包对齐、macOS `pluginRevision` 对等与 WP16 Cordis 同进程动态重载/回退集成）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

让受认证的日常任务反馈与可重放经验沉淀自动驱动受控修复、可复用技能/工具/插件候选、独立验收、有限采用与退化回退；在明确授权后，owner 无需逐步手工编排。

## 能力边界

- 发布基线：当前已发布 npm 基线为 `0.1.74`（39 个包，[release-manifest](../release-manifest.json)，`releasedAt` 2026-11-17T04:32:30.378Z，`pinnedHostVersion: 0.2.2-rc.3`、`verifiedHostRange: >=0.2.2-rc.3 <0.3.0`）；当前 `pending` 发版为空，Stage 1/Stage 2 集成变更均保持版本不变。
- Host 与工具链基线：DSH `0.2.2-rc.3`（workspace catalog 与测试依赖，`.node-version` `24.9.0`），插件 peer 接受 `>=0.2.2-rc.3 <0.3.0`，源码安装基线锁定 `0.2.2-rc.3`；Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`；Linux bwrap 行为隔离与 CI 验证节点使用 `/usr/bin/node` `v22.23.2`（`pnpm@11.7.0`）。
- Stage 1 与 Stage 2 已集成能力（待独立复核、真机与纵向观测验证）：
  - **双 ACP 编程 Agent 接入（`traex-acp-provider` / `assistant-policy`）**：支持 `traex-agent`（`traex acp serve`）与 Antigravity CLI `agy-agent`（`agy acp --sandbox --include-default-customizations=false --disable-telemetry --stdio`），支持 `.volatile()` 配置热重载与 `dsh-model-setup --provider agy-agent` 注册。
  - **统一主人控制台与左栏原生设置（`owner-console`）**：文鳐控制台面板与 DSH 左栏设置分组共用 `--dsw-*` 卡片；新增**自主能力一键开启向导**（`AutonomyWizardCard`）与**版本与自助升级卡片**（`SelfUpgradeCard`），支持三权分立一键授权/安全暂停/停用与版本检查/预演/本地确认升级。
  - **渠道无关 Web-owner、Policy 自主授权与自助升级（`assistant-policy` / `assistant-web-owner` / `dsh-rsi` / `scripts/install`）**：`buildWebOwner*PolicyGrants`、`mergeAssistantPolicyGrants`、`dsh-web-owner-setup --autonomy-setup` 与 `dsh-rsi upgrade [--check | --dry-run | --yes]` 已就位（含受控 systemd `upgrade-program.mjs` 与 macOS/本地备份恢复自动回滚）。
  - **Proactive / Dreaming / Growth 协同**：`assistant-dreaming` 将 sibling bundle 转为可选 `peerDependencies`，支持确定性 HMAC 抽签与冷启动锚点；与 `assistant-proactive` / `assistant-work-items` / `assistant-memory-learning` / `assistant-delivery` / `assistant-growth-driver` 接通观察与修复通道。
  - **Linux `cgroup v2` 跨包对齐与 macOS `pluginRevision` 对等（Stage 2）**：`prepare-linux-cgroups.mjs --auto`、`assistant-isolation/native-resources`（`discoverLinuxCgroupRoots`）、`lark-channel`、`assistant-verifier`（`plugin-behavior-config` / `drivers`）、`plugin-control-plane`（`source-build` / `creation-capability`）、`assistant-web-owner`（`goal-admission`）与 `dsh-rsi doctor` 现统一支持已委派的 cgroup v2 子树（`/sys/fs/cgroup/dsh-native/uid-<uid>`，`cpu`/`memory`/`pids` + `cgroup.freeze=0`）；**诚实边界**：`assistant-isolation` 实际运行时进程迁入目前仍仅支持 cgroup v1、对 v2 保持 fail-closed，待 Linux cgroup v2 真机实测。macOS `createRsiPluginRevisionSetup` / `createRsiNativeProfile` 支持 `schemaVersion: 2`（`macos-seatbelt`）创建构建及 `enableRevision` 选项。
  - **WP16 受控 Cordis 同进程动态重载与自动回退（Stage 2，`assistant-delivery` / `plugin-control-plane`）**：`createInProcessReloadRuntime` 与 `PluginControlPlaneService.reloadInProcess` / `coordinateAdoptionHandoff({ inProcessReload })` 现支持 `config-only`（同 `uid` 原地刷新）及对非 denylist 插件的 `artifact-replace`（`<version>-<artifactDigest>` 不可变目录、`artifactDigest`/`patchDigest` 核验、先旧 Fiber `DISPOSED` 再加载新 `ACTIVE`、异常/探针失败自动回滚恢复），并保持 `--dump-config` 默认无变化及与 `{kind:'reload'}` 进程重启证据严格隔离。
- 平台与迁移边界：Linux 运行时隔离进程放置当前仅实测并开放 cgroup v1（v2 实际迁入仍 fail-closed），arm64 与活 Home 迁移未验收；Docker 执行后端已移除，已有安装升级与非空创建历史迁出仍受限于既有只读/空账本前提。
- 纵向闭环边界：真实宿主上的长期普通任务效果对比（`agy` / `traex` / Web Settings UI / 自助升级实机链路 / WP16 生产同进程动态演化与回退收益 / cgroup v2 真机内核实测）尚待实机长期观测，不以组合测试或单次安装配置代替独立验收。

## 阻塞项与下一步验收

- **当前阻塞**：无工程构建阻塞；cgroup v2 内核运行时进程迁入需实机 v2 Linux 宿主实测，WP16 与普通使用收益需发布后生产闭环验证。
- **下一步验收**：完成 Stage 2 完整 `pnpm check` 与独立 `gate-verifier-2` 复核并合入 `dev`，随后推进远程 Linux Cold Gate 与真实 Host 长期普通使用观测。

## 最新验证

- **已发布 `0.1.74` 基线（`c40a7912`）与 Stage 1 `dev`（`d26bcf0b`）**：`39` 个 npm 包已发版（`DSH 0.2.2-rc.3`），前置基线已通过 Cold Gate / CI；Stage 1 在 `d26bcf0b` 通过跨包对齐与全量 `pnpm check`。
- **Stage 2 跨包集成与文档同步**：已合并 `p2-platform-isolation` 与 `p2-in-process-reload`，完成 `assistant-verifier`、`plugin-control-plane`、`assistant-web-owner` 与 `dsh-rsi-cli` 的 cgroup v2 对齐、跨包联调与文档同步，正在运行全量 `pnpm check` 待 `gate-verifier-2` 复核。
