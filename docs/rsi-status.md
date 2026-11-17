# RSI 当前状态

更新：2026-11-17（npm `0.1.74` 基线，`origin/dev` 在 `fc917aa1` 已完成 Stage 1/2 集成，当前分支正在合入 Stage 3 事件源 intake 桥接、WP19 超限附件投递与 WP20/WP22 规则预设及吻合度闭环）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

让受认证的日常任务反馈与可重放经验沉淀自动驱动受控修复、可复用技能/工具/插件候选、独立验收、有限采用与退化回退；在明确授权后，owner 无需逐步手工编排。

## 能力边界

- 发布与 Host 基线：已发布 npm 基线为 `0.1.74`（39 个包，[release-manifest](../release-manifest.json)，`pinnedHostVersion: 0.2.2-rc.3`、`verifiedHostRange: >=0.2.2-rc.3 <0.3.0`、`pending: none`）；Node `24.9.0`（Linux bwrap 与 CI 验证节点为 `/usr/bin/node` `v22.23.2`、`pnpm@11.7.0`），Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`。
- 当前已集成与整合中的能力（均保持默认安全关门，待真机与纵向观测验证）：
  - **渠道无关自主授权、控制台与自助升级（Stage 1）**：`traex-agent` / `agy-agent` 双 ACP 编程 Agent 接入；`assistant-web-owner` / `assistant-policy` 三权分立授权（`dsh-web-owner-setup --autonomy-setup`）；`owner-console` 自主向导与升级卡片；`dsh-rsi upgrade` 自助升级与回滚保护。
  - **原生隔离与受控热重载（Stage 2）**：Linux `cgroup v2` 跨包配置/校验对齐（`assistant-isolation` 运行时进程迁入仍仅开放 cgroup v1，v2 保持 fail-closed）与 macOS `pluginRevision` `schemaVersion: 2` 对等；`assistant-delivery` / `plugin-control-plane` 受控 Cordis 同进程动态重载（`config-only` 与非 denylist 不可变 `<version>-<artifactDigest>` `artifact-replace` 及失败自动回退，默认关闭）。
  - **事件源入站、附件投递与评估闭环（Stage 3）**：
    - `event-triggers`（schema 5）5 类 sensor 经 opt-in `intake` 适配器与 `registerIntakeObserver` 严格投影为闭集 10 键 `WorkItemIntakeInput` 进入 `assistant-work-items`，并随 `assistant-proactive` / `goal/changed` 终态无轮询自动退订（WP11）。
    - WP19 `attentionAttachOverCap`（默认关闭）端到端打通 Delivery Web `noticeAdapter`（`assistant-web-owner` `DeliveryNotice.attachment`）与 `lark-channel`（`textAttachments: true` + Feishu UTF-8 文件上传/发送）；`attentionEnforce` 仍默认关闭。
    - WP20 `assistant-policy` opt-in `inferred` 预设（`conservative` / `balanced`）与 `assistant-proactive` 预设展开、`assistant-work-items`（schema 13）只读 `listIntakeEvaluationFeed`（`work-items/intake-evaluation-feed/v1`），接入 WP22 `assistant-evaluation`（schema 19）`IntakeEvaluationAgreementLedger` 与 `lane: 'intake'` 密封留出重放（均默认关闭）。
- 平台、迁移与纵向边界：Linux 运行时隔离进程放置当前仅开放 cgroup v1（v2 实际迁入 fail-closed），arm64 与活 Home 迁移未验收，Docker 后端已移除（已有 native owner 原地升级与非空创建历史迁移边界不变）；单元测试、组合测试与合成重放**不证明**真实宿主上的长期普通任务效果、用户打扰分布或因果收益。

## 阻塞项与下一步验收

- **当前阻塞**：无工程构建阻塞；待完成事项为真实宿主普通使用纵向观测（`agy`/`traex`、Web Settings UI 与自助升级实机链路、WP16 生产热重载收益、多源事件/WP19 附件打扰/WP20–WP22 放宽长期效果）、Linux cgroup v2 内核运行时迁入实测，以及 WP04–WP13、WP18、WP21 的剩余端到端验收（见[验收合同](rsi-acceptance.md)）。
- **下一步验收**：完成 Stage 3 跨切片整合全量 `pnpm check` 与独立 `gate-verifier-3` 复核并合入 `dev`，随后推进远程 Linux Cold Gate 与真实 Host 长期普通使用观测。

## 最新验证

- **已发布 `0.1.74` 与 Stage 2 `dev` 基线（`fc917aa1`）**：`39` 个 npm 包已发版（`DSH 0.2.2-rc.3`）；Stage 1（`d26bcf0b`）与 Stage 2（`fc917aa1`）均已通过预推全量 `pnpm check` 并合入 `dev`。
- **Stage 3 当前验证**：核心提交 `e6859689`（`event-triggers` + `assistant-proactive`）与 `b9a80cda`（`assistant-work-items` + `assistant-evaluation` schema 19）已通过所属包构建/类型检查/定向单测与 lint；文档切片已通过相对链接检查（`BROKEN_LINKS=0`）、全仓 `pnpm run lint` 与 `pnpm release:status`（`0.1.74`，`pending: none`）；Stage 3 全仓 `pnpm check` 待全部切片合入后由整合分支与独立复核者执行。
