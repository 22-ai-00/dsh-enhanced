# RSI 当前状态

更新：2026-11-17（`dev` `eef2bfaf` Stage B 已通过门禁验证，`0.1.74` 发版准备中）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

让受认证的日常任务反馈与可重放经验沉淀自动驱动受控修复、可复用技能/工具/插件候选、独立验收、有限采用与退化回退；在明确授权后，owner 无需逐步手工编排。

## 能力边界

- 发布基线：当前已发布 npm 基线为 `0.1.73`（39 个包，含 `assistant-dreaming`，[release-manifest](../release-manifest.json)，`releasedAt` 2026-11-16T12:15Z）；当前 `dev`（`eef2bfaf`）已对齐 DSH `0.2.2-rc.3` 源码基线并准备 `0.1.74` pending 发版（`pinnedHostVersion: 0.2.2-rc.3`、`verifiedHostRange: >=0.2.2-rc.3 <0.3.0`），待门禁复核、合入 `main` 与打标发布。
- Host 与工具链基线：DSH `0.2.2-rc.3`（workspace catalog 与测试依赖，`.node-version` `24.9.0`），插件 peer 接受 `>=0.2.2-rc.3 <0.3.0`，源码安装基线锁定 `0.2.2-rc.3`；Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`；Linux bwrap 行为隔离与 CI 验证节点使用 `/usr/bin/node` `v22.23.2`（`pnpm@11.7.0`）。
- Stage B 已集成能力（已通过 `eef2bfaf` 门禁检查，待发版后实机验收）：
  - **双 ACP 编程 Agent 接入（`traex-acp-provider` / `assistant-policy`）**：支持 `traex-agent`（`traex acp serve`）与 Antigravity CLI `agy-agent`（`agy acp --sandbox --include-default-customizations=false --disable-telemetry --stdio`），支持 `.volatile()` 配置热重载与 `dsh-model-setup --provider agy-agent` 注册。
  - **统一主人控制台与左栏原生设置（`owner-console`）**：文鳐控制台面板结合 DSH 左栏设置槽位（`settings.section` / `general` / `models` / `plugins.bundle.config`），支持飞书状态、TraeX / `agy` 检测安装切换，以及 `dreaming`/`proactive`/`work-items`/`memory-learning`/`growth-driver` 只读观测与受控操作。
  - **Proactive / Dreaming / Growth 协同**：`assistant-dreaming` 将 sibling bundle 转为可选 `peerDependencies`（已在根 `build:bootstrap` 解环），支持确定性 HMAC 抽签与冷启动锚点；`assistant-proactive` / `assistant-work-items` / `assistant-memory-learning` / `assistant-delivery` / `assistant-growth-driver` 接通 intake 评估、观察台账、已验证 idea 消费与健康诊断；`assistant-policy` 与 `assistant-health` / `assistant-web-owner` 同步覆盖配置键、fail-closed 守卫与健康检查。
  - **友好的安装与诊断入口（`dsh-rsi` / `scripts/install`）**：新增 `dsh-rsi open`、`status --json`、`doctor --json`、`.dsh-rsi-host.json` 私有 Host 绑定，以及 `--with <addon>`、`--proactive` / `--dreaming` / `--growth` 开关与 `traex` / `agy` 自动探测。
- 平台与迁移边界：Linux 原生执行仅支持 cgroup v1（拒绝 v2），arm64 与活 Home 迁移未验收；Docker 执行后端已移除，旧收据仅作只读迁移证据。已有 Docker 原安装的程序升级要求创建/修订审查与采用业务记录为空；非空创建历史迁移、完整 live Host 切换与冻结源码 Mac Home 原地升级均未支持。
- 纵向闭环边界：真实宿主上的长期普通任务效果对比（`agy` / `traex` / Web Settings UI / 跨代质量与成本回归）尚待发版后实际运行观测，不以单次组合测试或模型自评代替独立验收。

## 阻塞项与下一步验收

- **当前阻塞**：无工程阻塞（`release:prepare` 同步 `scripts/install/install-npm.sh` 至 `v0.1.74` / `0.2.2-rc.3` / `>=0.2.2-rc.3 <0.3.0`）；真实 Host 长期普通使用效果闭环与生产部署仍在发布后继续验收。
- **下一步验收**：完成 `0.1.74` 发版准备门禁复核、合入 `main`、打标发布 npm 并核验公开包安装及 hoisted `--prepare-authorities`（Node `24.9.0` 与 `22.23.2`），随后在真实 Host / 渠道上验证长期普通使用改进闭环。

## 最新验证

- **Stage B `dev` 基线（`eef2bfaf`）**：已通过远程 Linux Cold Gate `stageb-eef2bfaf`（`exit=0`、`MANIFEST_STABLE`、`39` Tarball Details、`test:root` `101 passed | 1 skipped (102)`、`1632 passed | 2 skipped (1634)`）与精确 SHA GitHub Actions CI（`run 43963580049`，`8/8` jobs 通过）。
- **Stage 0 `0.1.74` 发版准备**：已通过 `pnpm release:prepare` 统一根包、39 个发布包 `package.json` / `src/version.ts`、`release-manifest.json`（`pending: 0.1.74`）及 `scripts/install/install-npm.sh`（`v0.1.74` / `0.2.2-rc.3` / `>=0.2.2-rc.3 <0.3.0` 与 6 项资产 SHA-256），待完整 `pnpm check` 与独立门禁复核后合入发布。
