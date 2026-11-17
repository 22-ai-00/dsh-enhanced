# RSI 当前状态

更新：2026-11-17（npm `0.1.74` 已发布，`c40a7912` 上已集成 Stage 1 渠道无关自主授权、自助升级与控制台向导）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

让受认证的日常任务反馈与可重放经验沉淀自动驱动受控修复、可复用技能/工具/插件候选、独立验收、有限采用与退化回退；在明确授权后，owner 无需逐步手工编排。

## 能力边界

- 发布基线：当前已发布 npm 基线为 `0.1.74`（39 个包，[release-manifest](../release-manifest.json)，`releasedAt` 2026-11-17T04:32:30.378Z，`pinnedHostVersion: 0.2.2-rc.3`、`verifiedHostRange: >=0.2.2-rc.3 <0.3.0`）；当前 `pending` 发版为空，Stage 1 变更暂不触发版本号变更。
- Host 与工具链基线：DSH `0.2.2-rc.3`（workspace catalog 与测试依赖，`.node-version` `24.9.0`），插件 peer 接受 `>=0.2.2-rc.3 <0.3.0`，源码安装基线锁定 `0.2.2-rc.3`；Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`；Linux bwrap 行为隔离与 CI 验证节点使用 `/usr/bin/node` `v22.23.2`（`pnpm@11.7.0`）。
- Stage B 与 Stage 1 已集成能力（待后续实机与纵向观测验证）：
  - **双 ACP 编程 Agent 接入（`traex-acp-provider` / `assistant-policy`）**：支持 `traex-agent`（`traex acp serve`）与 Antigravity CLI `agy-agent`（`agy acp --sandbox --include-default-customizations=false --disable-telemetry --stdio`），支持 `.volatile()` 配置热重载与 `dsh-model-setup --provider agy-agent` 注册。
  - **统一主人控制台与左栏原生设置（`owner-console`）**：文鳐控制台面板与 DSH 左栏设置分组共用一套 `--dsw-*` 卡片；Stage 1 新增 **自主能力一键开启向导**（`AutonomyWizardCard`）与 **版本与自助升级卡片**（`SelfUpgradeCard`），除观察飞书、`traex`/`agy`、`dreaming`/`proactive`/`work-items`/`memory-learning`/`growth-driver` 外，支持三权分立一键授权/安全暂停/停用与版本检查/预演/本地确认升级。
  - **渠道无关 Web-owner 与 Policy 自主授权（`assistant-policy` / `assistant-web-owner`）**：新增 `buildWebOwner*PolicyGrants`、`mergeAssistantPolicyGrants` 与 `dsh-web-owner-setup --autonomy-setup`，基于已激活的 Web 或飞书 owner 路由生成独立 memory learning（extraction/review/adoption 三权与摘要）、dreaming 与 growth（含 `assistant-growth-usage` / `usage-*` / `growth_*` / `verified-workflows`）有限预算规则，保持 `!!js` 标签、既有策略与 `allowUnbudgetedExecution: false` 不被破坏。
  - **用户向安全自助升级与诊断入口（`dsh-rsi` / `scripts/install`）**：新增 `dsh-rsi upgrade [--check | --dry-run | --yes]`（有界 npm/Host 版本探测含离线回退、损坏绑定或非空创建账本 fail-closed、受控 Linux systemd 委托 `upgrade-program.mjs` 并拒绝应用内热启动、macOS/本地备份 + doctor 校验 + 自动回滚），与既有 `open`、`status --json`、`doctor --json`、`.dsh-rsi-host.json` 私有 Host 绑定互补。
  - **Proactive / Dreaming / Growth 协同**：`assistant-dreaming` 将 sibling bundle 转为可选 `peerDependencies`，支持确定性 HMAC 抽签与冷启动锚点；`assistant-proactive` / `assistant-work-items` / `assistant-memory-learning` / `assistant-delivery` / `assistant-growth-driver` 接通 intake 评估、观察台账、已验证 idea 消费与健康诊断。
- 平台与迁移边界：Linux 原生执行仅支持 cgroup v1（拒绝 v2），arm64 与活 Home 迁移未验收；Docker 执行后端已移除，旧收据仅作只读迁移证据。已有 Docker 原安装的程序升级要求创建/修订审查与采用业务记录为空；非空创建历史迁移、完整 live Host 切换与冻结源码 Mac Home 原地升级均未支持。
- 纵向闭环边界：真实宿主上的长期普通任务效果对比（`agy` / `traex` / Web Settings UI / 自助升级实机链路 / 跨代质量与成本回归）尚待发版后实际运行观测，不以单次组合测试、安装配置成功或模型自评代替独立验收。

## 阻塞项与下一步验收

- **当前阻塞**：无工程阻塞；真实 Host 长期普通使用效果闭环与生产实机观测仍在发布后继续验收。
- **下一步验收**：完成 Stage 1 完整 `pnpm check` 与独立门禁复核并合入 `dev`，随后在真实 Host / 渠道上开展长期普通使用改进闭环与用户态自助升级实机观测。

## 最新验证

- **已发布 `0.1.74` 基线（`c40a7912`）**：已完成发版、打标推送 `main` 与归档 sync（`39` 个 npm 包，`DSH 0.2.2-rc.3`），前置 Stage B `dev` 基线 `eef2bfaf` 已通过远程 Linux Cold Gate 与 GitHub Actions CI（`8/8` jobs）。
- **Stage 1 跨包集成与文档同步**：已完成 `assistant-policy`、`assistant-web-owner`、`dsh-rsi-cli` 与 `owner-console` 集成契约对齐（含 `ownerRouteAuthorityHash` / `inspectOwnerRouteState` 收据契约、`assistant-growth-usage` / `usage-*` 策略、`pause` 禁用子模块一致性及 `<= 10_000` 上限夹紧），并通过包级构建、类型检查与跨包校验单测，待全量 `pnpm check` 与 `gate-verifier-2` 最终复核。
