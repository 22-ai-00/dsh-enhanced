# RSI 当前状态

更新：2026-11-27（已通过纯 GitHub OIDC 发布 `dsh-ray` / `@dsh-ray/cli` 与全部 40 个 `@dsh-ray/*@0.2.2` 包：`.github/workflows/release.yml` Run `46025214537` `publish`/`verify-npm`/`record` 全部通过并提交 `89da2945`，40/40 包上线 npm 并完成校验；在 `0.2.1` 基线上新增 ACP 多模态图像输入与工具 schema/结果压缩、`/update` 脱离 cgroup 无人值守自升级与非重放中断提示、安装器/CLI `--to-npm` 迁移与非 TTY CI 加固、`owner-console` 策略路由修复与离线 GUI 自升级）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

让受认证的日常任务反馈与可重放经验沉淀自动驱动受控修复、可复用技能/工具/插件候选、独立验收、有限采用与退化回退；新装及常规预设默认开启全套自迭代与主动进化能力，并支持用户通过统一 CLI（`@dsh-ray/cli` / `dsh-ray enable|disable|update|upgrade|provider|version`）、桌面端 DSH 左栏（`@dsh-ray/owner-console`）与飞书/Web（`/version`、`/help`、`/status`、`/update`、`/autonomy`、`/learning`、`/feedback`）一站式查询版本与演进统计、开启、关闭、升级与恢复可用状态。

## 能力边界

- **发布、包身份与 Host 基线**：[release-manifest](../release-manifest.json) 当前 `current: 0.2.2`、`pending: null`（40 个 `@dsh-ray/*@0.2.2` 包：36 插件 + 4 共享包含 `@dsh-ray/cli`，内部 `@dsh-ray/*` peer 上限 `<0.3.0`，`release.yml` Run `46025214537` 与 `node ./scripts/verify-npm-release.mjs --tag v0.2.2 --verify-tarball` 40/40 通过并合回 `record` 提交 `89da2945`）；`pinnedHostVersion: 0.2.2-rc.5`、`verifiedHostRange: >=0.2.2-rc.5 <0.3.0`，Node `.node-version` 为 `24.9.0`（`pnpm@11.7.0`），Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`。
- **v0.2.2 ACP 多模态/上下文压缩、无人值守 `/update` 与 `--to-npm` 迁移**：`@dsh-ray/traex-acp-provider` 支持多模态 ACP 图像输入与 `read_image`、压缩工具 schema、限制早期工具结果体积并将 `agyContextWindow` 对齐 `128000`；`@dsh-ray/auto-update` 与 `@dsh-ray/assistant-delivery` 支持脱离 cgroup 的 `/update` 无人值守升级恢复及非重放中断提示；`@dsh-ray/cli` 与 `scripts/install/` 补齐独立 5-helper 闭合下载校验、`bwrap --chdir` `/tmp`/`/run` 调用隔离、非 TTY `pnpm` CI 升级加固及 `dsh-ray update --all --to-npm` 源码队列向纯 npm 迁移；`@dsh-ray/owner-console` 修复 `ownerRoutes`/策略同步、`upgrade` 多行 JSON 日志解析与 macOS GUI 脱离自升级（并延续 `v0.2.1` `dsh-ray provider` 引导与左栏插件目录批量安装）。
- **R3 默认自迭代、M6 实时档案防死锁与预派发进度 UX**：常规队列默认启用自迭代套件，且在 M6（`2fba9516`）修复了 live-profile 死锁与误报问题：`@dsh-ray/assistant-verifier` 保留代码 `Config` 默认 fail-closed `requireAcceptance: true`，同时在 `cordis.patch.yml` 及 `owner-console` / `assistant-web-owner` / `lark-channel` 档案编译器中对空 `profiles: []` 默认配置 `requireAcceptance: false` 并完整保留已有 `databasePath` 与评审字段（避免 Cordis 整块替换覆盖必需配置）；`@dsh-ray/assistant-dreaming` `cordis.patch.yml` 默认写入 `databasePath` 且保持 `enabled` 未启用直至 6 项前提满足；`@dsh-ray/assistant-delivery` 将 `publishProgress({ kind: 'started' })` 移至验收与执行准备及 `markDispatching()` 之后，并将非瞬态验收配置错误标记为不可重试（`acceptance-profile-missing`），避免零执行时误触发「执行被中断，已有操作的结果尚未确认。」。
- **M7 飞书 Card 2.0 交互卡片与斜杠命令样式**：`plugins/lark-channel`（`1f720aa6`）将 `permissionPicker`、`userQuestion*`、`toolApproval*`、`approval*`、`automationIncident`、`modelPicker` 与 `modelSelectionResult` 升级为飞书 Card 2.0（`schema: '2.0'`、`config.summary`、`standard_icon`、等宽 `1:1` 按钮列、`behaviors: []` 表面容器，所有非信任/动态载荷严格隔离在 `plain_text` 内）；`/help`、`/status`|`/session`、`/version`、`/autonomy`、`/learning`、`/feedback` 在保持 `assistant-delivery` `intent.text` 契约的前提下于 `LarkDeliveryAdapter` 渲染为结构化 Card 2.0 卡片并保留字节预算与格式降级回退。
- **核心演进与跨端能力（WP04–WP22 / F26）**：策略租约与预派发回滚、AEAD 持久化主动准入与四因子动态效用、`assistant-isolation` 跨平台沙箱（Linux/macOS/Windows）与 `assistant-actions` v2 broker、同进程热重载与多类插件演进、通用外部副作用补偿、滚动日历/Webhook 触发器，以及 `dsh-ray/version/v1` CLI/Web/飞书只读版本与 24 项自迭代演进统计保持完整可用。

## 阻塞项与下一步验收

- **平台验证边界（Linux 宿主与 Windows Named Pipe 边界）**：当前物理验证宿主为 Linux，Linux 原生隔离/cgroup、`SO_PEERCRED`、独立沙箱仓与全部服务端链路已在本地实测通过；macOS（`macos-seatbelt`、`LOCAL_PEERCRED`、`launchd`）与 Windows（`windows-job`、Named Pipe/ACL）路径由跨平台 CI（`macos-verify`、`windows-acp-smoke`）门禁覆盖。在真实 Windows Node.js `net.Socket` Named Pipe 上，`socket._handle` 不暴露底层 Win32 句柄，默认 `inspectWindowsPeerCredentials` 按 fail-closed 返回 `undefined`（仅在具备句柄或注入 FFI 绑定时执行进程与 `TokenUser` SID 核验）。
- **D 类纵向验证边界**：真实用户在长期普通使用中的质量、成本、延迟、打扰分布与长期因果收益（D 类纵向证据）属于发布后（post-release）真实使用观测范围，显式排除在发版前工程验收门禁之外。
- **下一步验收**：基于已发布的 `@dsh-ray/*@0.2.2` 完成隔离临时 `DSH_HOME` 公网 `install-npm.sh` 新装与 `/tmp` 工作目录 `--operation upgrade` 冒烟、本机与其它部署节点（含 `xtorybot` / macOS）向纯 npm `0.2.2` 的升级迁移，以及 ACP 多模态图像分析、`/update` 与长期普通使用 D 类纵向观察。

## 最新验证

- **纯 OIDC 发布与 npm 回读校验（`v0.2.2`）**：`.github/workflows/release.yml` Run `46025214537`（tag `v0.2.2` on `24266100`：`publish` 通过、`verify-npm` 于 npm CDN 同步后 `--failed` 重跑通过、`record` 提交 `89da2945` 通过）全部 `success`；`node ./scripts/verify-npm-release.mjs --tag v0.2.2 --verify-tarball` 退出码 `0`（`Verified 40/40 packages at 0.2.2`）；`pnpm release:status` 为 `Current release: 0.2.2`、`Pending release: none`。
- **全仓门禁与跨平台 CI（`v0.2.2` 基线 `24266100`）**：`TMPDIR=/data00/home/jiataorui/t VITEST_MAX_WORKERS=4 DSH_TEST_CONCURRENCY=2 pnpm check`（`validate` 36+4/40、`oxlint --deny-warnings .` 0 警告/2032 文件、40/40 `build` 与 `typecheck:built`、`test:root` 123+2013 passed / 1+4 skipped、`test:packages` 40/40、`pack:check` 40/40 tarballs）通过；`.github/workflows/ci.yml` Run `46020982537`（`24266100`）8/8 全量 `success`。
- **状态同步文档校验（`dev`）**：已执行 `TMPDIR=/data00/home/jiataorui/t pnpm run validate`、`TMPDIR=/data00/home/jiataorui/t pnpm run lint` 与 `TMPDIR=/data00/home/jiataorui/t VITEST_MAX_WORKERS=4 pnpm exec vitest run --config ./tests/vitest.config.ts --testTimeout=15000 tests/release-version.spec.ts tests/ci-workflows.spec.ts` 验证。
