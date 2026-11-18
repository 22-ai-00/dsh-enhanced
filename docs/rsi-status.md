# RSI 当前状态

更新：2026-11-18（已发布 npm 基线 `0.1.76`；项目进入普通使用验证期，冻结新 WP 特性开发，仅推进真实自用观测、缺陷修复与运行前提打通）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

让受认证的日常任务反馈与可重放经验沉淀自动驱动受控修复、可复用技能/工具/插件候选、独立验收、有限采用与退化回退；在明确授权后，owner 无需逐步手工编排。

## 能力边界

- **发布与 Host 基线**：已发布 npm 基线为 `0.1.76`（39 个包，[release-manifest](../release-manifest.json)，`pinnedHostVersion: 0.2.2-rc.3`、`verifiedHostRange: >=0.2.2-rc.3 <0.3.0`、`pending: none`）；Node `24.9.0`（Linux 原生工具链与 CI 节点为 `/usr/bin/node` `v22.23.2`、`pnpm@11.7.0`），Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`。
- **只读成长计分卡**：`dsh-rsi growth-report [--since 7d|14d|30d] [--now <ms|iso>] [--json]` 与 `owner-console`「成长计分卡（只读）」卡片复用既有只读接口与 SQLite 只读快照（零 schema 变更），汇总任务与纠正/重做/撤回率及趋势、新增有来源记忆与提示词暴露及暴露后同类纠正变化、候选生成/验收/采用/回滚、通知送达与 `would-accept` 吻合度及密封留出（1/4 holdout）样本量、按冻结 supplier 的成本与延迟分布，并显式区分「无数据（未启用/无账本）」与「数据为 0（账本就绪，窗口内无记录）」。
- **自主授权、隔离与动态采用**：
  - 渠道无关三权分立授权（`dsh-web-owner-setup --autonomy-setup` / `owner-console` 向导）、`traex-agent` / `agy-agent` ACP 路由与 `dsh-rsi upgrade` 自助升级回滚。
  - 原生隔离：macOS 使用 `macos-seatbelt`；Linux `backend: 'linux-native'` 同时支持委派 `cgroup v1` 四控制器与纯统一 `cgroup v2` 委派子树（`/sys/fs/cgroup/dsh-native/uid-<uid>` 及 `systemd --user` `.../user@<uid>.service/dsh-native/uid-<uid>`，在 `prepare` 与 `create` 阶段校验共同祖先 `cgroup.procs` 写权限、无内部进程规则、`cgroup.freeze` 与 `cgroup.kill`）。
  - 受控动态采用与主动评估：`assistant-delivery` / `plugin-control-plane` Cordis 同进程重载（`config-only` 与非 denylist `<version>-<artifactDigest>` `artifact-replace` 及失败回退）、`event-triggers` → `assistant-work-items` 事件入站与终态退订、WP19 超限文本附件、WP20 预设规则与 WP22 `IntakeEvaluationAgreementLedger` 密封留出重放均默认关闭。
- **验证边界**：单元测试、组合测试与合成重放**不证明**真实宿主上的长期普通任务因果收益或用户打扰分布；arm64 与非空创建历史迁移仍未实机验收。

## 真实自用（Dogfood Profile）与预登记验收口径

1. **记忆 / 偏好通道（当前主验证通道，WP07 + 记忆进化）**：
   - **固定配置**：macOS 日常主力机应用 [dogfood 配置预设](examples/dogfood-macos.profile.json)（`dsh-rsi install --profile web --scenario web --workspace <abs-path> --plugin-preset dogfood --yes`，本地未发版 checkout 加 `--local <repo-root>`，自动补齐 `preference-learning`、`assistant-evaluation`、`assistant-verifier`、`assistant-memory-learning`、`assistant-work-items` 集合；`dsh-rsi open --profile web` 打开新建一次会话建立真实 owner 会话绑定后，通过「文鳐」三权授权向导或停机运行 profile 内 `dsh-web-owner-setup --autonomy-setup --enable-memory-learning --work-item-experiences` + `dsh-plugin-setup preset dogfood --profile web --yes`，再重新 `dsh-rsi open --profile web` 使非易失授权生效），开启 `preference-learning` T1 overlay、`assistant-memory-learning`、Delivery 自然反馈与 Evaluation 结果/吻合度记录；`assistant-work-items` 固定 `mode: observe` 且关闭 `admit`，`attentionTuningAutoAdopt` 与 `attentionLooseningEnabled` 固定 `false`。
   - **预登记 14 天验收口径**：连续 `≥14` 天日常普通使用，累计 `≥10` 条受认证 owner 纠正，沉淀 `≥5` 条带来源记忆，发生 `≥5` 次提示词暴露（`preference_exposures` bound），后半程或暴露后同类纠正率较前半程/暴露前下降，且撤回/纠正传播零冲突（`conflictedTasks = 0`）。每周运行 `dsh-rsi growth-report --since 14d` 复盘，期间仅修复真实使用暴露的缺陷。
2. **主动通道放宽决策门（WP20–WP22）**：保持 `observe` 只记不执行；仅当 `growth-report` 显示密封留出（1/4 holdout）已决样本 `≥20` 且负向率未上升时，才进入单步放宽评估；若真实样本长期不足则维持收敛或一键确认简化方案。
3. **工程通道专用沙箱仓库切片（WP16 + WP18，待记忆通道取得首轮真实数据后执行）**：使用已迁入 `linux-native` 的 [live-repository-e2e](live-repository-e2e.md)（`scripts/e2e/repo-autonomy-real.spec.mjs`）在独立沙箱仓库（不使用本仓库以避免与 `dev`/`main` 分支治理冲突）跑通“真实 CI 失败 → 目标 → 隔离修复 → 独立验证 → 授权分支提交 → 精确 SHA CI 回读 → 同预算技能复用”，同时覆盖同进程 `artifact-replace` 热重载与回退。

## 阻塞项与下一步验收

- **当前阻塞**：无工程构建阻塞；待完成事项为上述 macOS 14 天普通使用记忆通道纵向数据采集、Linux cgroup v2 实机冷安装→学习运行记录，以及记忆通道达标后的专用沙箱仓库 WP18 端到端实跑。
- **下一步验收**：按 `dogfood` 预设持续日常使用并以 `dsh-rsi growth-report --since 14d` 验收记忆进化通道，同时在纯 cgroup v2 Linux 主机执行 `prepare-linux-cgroups.mjs --uid <uid> --auto` 与冷安装核验。

## 最新验证

- **已发布基线**：`0.1.76`（`39` 个 npm 包，`DSH 0.2.2-rc.3`）。
- **验证期能力就绪**：新增 `dsh-rsi growth-report` 与 `owner-console` 成长计分卡卡片（零 schema 变更，实机 `~/.dsh` 只读复现与跨账本一致性校验通过）、`--scenario web --plugin-preset dogfood` 端到端闭环装配、`assistant-isolation` Linux cgroup v2 运行时迁入（含共同祖先写权限与 SSH 会话 `systemd-run --user --scope` 桥接），以及 `repo-autonomy-real.spec.mjs` `linux-native` 迁移；已通过全仓根级 `pnpm check`（manifest/lint/build/typecheck/全 39 包与根测试/pack dry-run）。
