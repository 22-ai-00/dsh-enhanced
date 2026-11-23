# RSI 当前状态

更新：2026-11-23（`0.1.83` 为不完整部分发布，上一已确认完整 npm 基线仍为 `0.1.82`，Host 为 `0.2.2-rc.5`；先补齐 release workflow npm 完整核验并以 `0.1.84` 取代，再继续普通使用 dogfood 观测）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

让受认证的日常任务反馈与可重放经验沉淀自动驱动受控修复、可复用技能/工具/插件候选、独立验收、有限采用与退化回退；在明确授权后，owner 无需逐步手工编排。

## 能力边界

- **发布与 Host 基线**：上一已确认完整 npm 基线为 `0.1.82`（40 个包 = 36 个插件 + 4 个共享包，含 `assistant-association` Slice S1–S4）；[release-manifest](../release-manifest.json) 已记 `current: 0.1.83`、`pending: none`，但 npm 集合不完整，详见发行阻塞。`pinnedHostVersion: 0.2.2-rc.5`、`verifiedHostRange: >=0.2.2-rc.5 <0.3.0` 保持不变；Node `24.9.0`（Linux 原生工具链与 CI 节点为 `/usr/bin/node` `v22.23.2`、`pnpm@11.7.0`），Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`。
- **只读成长计分卡**：`dsh-rsi growth-report [--since 7d|14d|30d] [--now <ms|iso>] [--json]` 与 `owner-console`「成长计分卡（只读）」卡片复用既有只读接口与 SQLite 只读快照（零 schema 变更），汇总任务与纠正/重做/撤回率及趋势、新增有来源记忆与提示词暴露及暴露后同类纠正变化、候选生成/验收/采用/回滚、通知送达与 `would-accept` 吻合度及密封留出（1/4 holdout）样本量、按冻结 supplier 的成本与延迟分布，并显式区分「无数据（未启用/无账本）」与「数据为 0（账本就绪，窗口内无记录）」；`dsh-rsi growth-report` 第 6 节另汇报联想层在线指标、参数档案版本/采用/回滚、可选 S3/S4 计数与密封留出对照。
- **自主授权、隔离与动态采用**：
  - 渠道无关三权分立授权（`dsh-web-owner-setup --autonomy-setup` / `owner-console` 向导）、`traex-agent` / `agy-agent` ACP 路由与 `dsh-rsi upgrade` 自助升级回滚。
  - 原生隔离：macOS `macos-seatbelt` 仅覆盖 `plugin-control-plane` 的 Host 脚手架 `create`/`revise-created`（拒绝 `modify`/`sourceReleases`/`sourceAdoptions`/`sourceApprovals`）；通用 `assistant-isolation` 仅支持 Linux `backend: 'linux-native'`，同时支持委派 `cgroup v1` 四控制器与纯统一 `cgroup v2` 委派子树（`/sys/fs/cgroup/dsh-native/uid-<uid>` 及 `systemd --user` `.../user@<uid>.service/dsh-native/uid-<uid>`，在 `prepare` 与 `create` 阶段校验共同祖先 `cgroup.procs` 写权限、无内部进程规则、`cgroup.freeze` 与 `cgroup.kill`）。
  - 受控动态采用与主动评估：`assistant-delivery` / `plugin-control-plane` Cordis 同进程重载（`config-only` 与非 denylist `<version>-<artifactDigest>` `artifact-replace` 及失败回退；当前仅提供 Host API / 显式挂钩，尚未接入 `AdoptionCoordinatorRuntime` 或安装预设）、`event-triggers` → `assistant-work-items` 事件入站与终态退订、WP19 超限文本附件与 `attentionEnforce`、WP20 预设规则及 WP22 `IntakeEvaluationAgreementLedger` 密封留出重放均默认关闭。
  - **联想记忆层（`assistant-association`，S1–S4）**：当前仅随 `--plugin-preset dogfood` 安装（未纳入 `web`/`supervised` 默认集合）。默认开启本地双缓冲联想召回（≤5ms 超时回退、10–15% 密封留出、`personal-memory` 协同与撤回级联）以及 S2 局部 Hebbian 权值更新与 WP22 参数自调参；S3（空闲做梦建边/抽象/同义词、`observe` 态 `intakeSignal`，以及经 WP04 守卫的片段聚类与评估池）与 S4（受 Policy `web.learn`、非空 `allowedDomains` 白名单与日预算门控的只读 HTTPS Web 学习；默认在空 `0o700` 目录与脱敏环境的独立 Node 子进程运行，非 OS namespace/seatbelt 隔离）均默认关闭（`dreaming.enabled` / `intakeSignal.enabled` / `webLearning.enabled: false`），详见 [assistant-association](../plugins/assistant-association/README.md)。
- **验证边界**：单元测试、组合测试与合成重放**不证明**真实宿主上的长期普通任务因果收益或用户打扰分布；arm64 与非空创建历史迁移仍未实机验收。

## 真实自用（Dogfood Profile）与预登记验收口径

1. **记忆 / 偏好通道（当前主验证通道，WP07 + 记忆进化）**：
   - **固定配置**：macOS 日常主力机应用 [dogfood 配置预设](examples/dogfood-macos.profile.json)（`dsh-rsi install --profile web --scenario web --workspace <abs-path> --plugin-preset dogfood --yes`，本地未发版 checkout 加 `--local <repo-root>`，自动补齐 `preference-learning`、`assistant-evaluation`、`assistant-verifier`、`assistant-memory-learning`、`assistant-work-items`、`assistant-association` 集合；`dsh-rsi open --profile web` 打开新建一次会话建立真实 owner 会话绑定后，通过「文鳐」三权授权向导或停机运行 profile 内 `dsh-web-owner-setup --autonomy-setup --enable-memory-learning --work-item-experiences` + `dsh-plugin-setup preset dogfood --profile web --yes`，再重新 `dsh-rsi open --profile web` 使非易失授权生效），开启 `preference-learning` T1 overlay、`assistant-memory-learning`、本地 `assistant-association`（默认开启本地召回、Hebbian 与参数自调参；S3 `dreaming`/`intakeSignal` 与 S4 `webLearning` 保持关闭）、Delivery 自然反馈与 Evaluation 结果/吻合度记录；`assistant-work-items` 固定 `mode: observe` 且关闭 `admit`，`attentionTuningAutoAdopt` 与 `attentionLooseningEnabled` 固定 `false`。
   - **预登记 14 天验收口径**：连续 `≥14` 天日常普通使用，累计 `≥10` 条受认证 owner 纠正，沉淀 `≥5` 条带来源记忆，发生 `≥5` 次提示词暴露（`preference_exposures` bound），后半程或暴露后同类纠正率较前半程/暴露前下降，且撤回/纠正传播零冲突（`conflictedTasks = 0`）。每周运行 `dsh-rsi growth-report --since 14d` 复盘，期间仅修复真实使用暴露的缺陷。
2. **主动通道放宽决策门（WP20–WP22）**：保持 `observe` 只记不执行；仅当 `growth-report` 显示密封留出（1/4 holdout）已决样本 `≥20` 且负向率未上升时，才进入单步放宽评估；若真实样本长期不足则维持收敛或一键确认简化方案。
3. **工程通道专用沙箱仓库切片（WP16 + WP18，待记忆通道取得首轮真实数据后执行）**：使用已迁入 `linux-native` 的 [live-repository-e2e](live-repository-e2e.md)（`scripts/e2e/repo-autonomy-real.spec.mjs`）在独立沙箱仓库（不使用本仓库以避免与 `dev`/`main` 分支治理冲突）跑通“真实 CI 失败 → 目标 → 隔离修复 → 独立验证 → 授权分支提交 → 精确 SHA CI 回读 → 同预算技能复用”，同时覆盖同进程 `artifact-replace` 热重载与回退。

## 阻塞项与下一步验收

- **发行阻塞**：`v0.1.83`（源码 `32a66544`）的 Release workflow 虽返回成功并在 `origin/main`（`c155cfa5`）记入账本（`pending: null`），但后续 npm 核验发现 `@dsh-enhanced/assistant-association@0.1.83` 返回 `404`（`latest` 仍为 `0.1.82`）；本机 npm 身份返回 `401 Unauthorized`，无法本地补发。由于 `.github/workflows/release.yml` 在 `record` 前缺少 40 包 npm 读回核验，且 `origin/main` 已前进、`pending` 已清空，原 tag 无法经 Release workflow 重跑；按[发布协议](releasing.md)将 `0.1.83` 视为不完整部分发布，不得移动或删除现有标签重试，本机助手与协调服务保留 `0.1.82`。
- **当前阻塞**：代码仓内 `assistant-association` Slice S1–S4 已全部完成；外部纵向待完成事项为 macOS 14 天普通使用记忆通道数据采集、Linux cgroup v2 实机冷安装→学习运行记录，以及记忆通道达标后的专用沙箱仓库 WP18 端到端实跑。
- **下一步验收**：先在 `.github/workflows/release.yml` 的 `record` 前增加 40 包 npm 完整读回核验，再准备并发布完整的 `0.1.84` 以取代不完整的 `0.1.83`，随后完成本机升级与服务就绪确认；继续以 `dogfood` 预设及 `dsh-rsi growth-report --since 14d` 收集并验收记忆进化与联想层真实纵向收益。

## 最新验证

- **发行验证**：`32a66544` 已通过完整 `pnpm check`（13,656 项通过、281 项跳过）及[精确源码跨平台 CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/45096712548)；40 个本地 tarball 的身份、隔离安装与短时 Host 初始化通过，现有两个生产配置加载新包通过。[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/45098482301) 返回成功，但 npm 后置完整集合核验未通过，`0.1.83` 不能作为完整发布或本机升级基线。安装/运行检查及跳过的测试均不证明长期普通任务收益。
- **S1–S4 已交付状态**：`assistant-association` Slice S1–S4（`0467aa08` / `5901ab35` / `8865bc28` / `9fa2a475`）已完成全仓 `pnpm check`、受影响包测试与独立复核并并入 `dev`。
