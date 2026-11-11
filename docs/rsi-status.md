# RSI 当前状态

更新：2026-11-11。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)。原始日志留 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标与当前安排

通过认证任务与反馈、原生 Agent、持久学习、独立验证、有界采用和回退，减少主人的协调与返工；以后续真实任务的质量、成本和人工介入判断收益。

本轮按[接手方案](handover/README.md)交付：A 普通续办、CI 均衡（两阶段）、B1 认证意图冻结、B2 受保护准则封存、B3 自然语言委托路径均已在 `dev` 且有精确提交的本地完整门。B3 的真实模型/渠道验收与跨会话/重启/更正覆盖仍待补；之后进入 C–F。

开发基线来自 Linux 进展，Mac 可开发、Linux `/data00` 独立副本验证，同一源码逐项核对。仅 dev/main，能力验证后推 dev，发布时才合 main。当前版本 0.1.67，工具链与 Host 范围见[兼容说明](compatibility.md)。

## 已有能力与边界

- Goals、WorkItems、原生执行、恢复、owner 反馈、独立验收与持久记忆已有实现。
- 既有 owner 续办（非 diagnosis active 部署）：认证前台输入冻结原始目标/来源/供应者/有限预算，首个 worker 模型调用前准备验收；Host proof 绑定同一 occurrence/attempt、原生 outcome、不可变 run 与已结算预算（schema 18）。
- B1（默认关）：`goal_create` 经 Delivery 的 agent 作用域只读证明冻结 owner 原文（分页+全文摘要）、identity、binding、调用身份与 supplier；objective 必须逐字出现在原文中；supplier 对该 goal 内所有真实模型请求逐一校验；`.owner-intents` 私库、edit 拒绝、记录失败回滚。
- B2（默认关）：Verifier 接受 Host 准备的准则并封为自描述 `owner-prepared` profile（digest 仅由 criteria+bounds 派生），重启/配置变化后可复用；封存前用共享的 `assertCriteriaDecidable` 拒绝不可判定准则；Goals 的 outcome 每目标封一次、step 每 run 在派发前封存；`.owner-acceptance` 私库；definition 变更即 stale、失败回滚原生目标。
- B3（默认关）：`goal_create` 可带 `acceptance{criteria,bounds,validity_ms}`；prepared 模式下同一 owner turn 内完成证明→创建→封存→返回，失败回滚；新增 Host-only 只读 `goal_acceptance_catalog`（模型可见的 authority id/digest 与绑定，不含 URL/凭据）让模型能构造可判定候选准则；B1+B2 可同时开启。边界：criteria 是模型候选，Verifier 只保证可判定性与封存后不可变，不保证语义充分；真实模型/渠道与跨会话/重启/更正仍未验收。
- fresh supervised 默认 digest ceiling；首装预设/学习授权顺序、skip/decline 语义与普通使用收益仍待验收。
- Linux namespace/cgroup v1 是当前原生执行方向；cgroup v2、arm64、活 Home 迁移与旧 opt-in E2E 尚待验收。Docker 执行后端已移除。
- 主动准入、通知反馈、Dream 与 Web 均保留原边界；provider 接受不等于用户已读，Dream 默认关闭，长期收益未证明。

## 下一交付

1. B3 验收补齐：真实 Delivery+真实模型/渠道的首次自然语言委托（含跨会话、重启、重复消息、owner 更正/撤回），并记录投递事实与用户验收；把 B2/B3 的已知边界（模型候选准则、catalog 接线、repair/schedule 缺口）在验收材料中列明。
2. C：空 Home 首装、owner 绑定、预设与学习授权顺序、skip/decline、重装幂等，以及认证反馈驱动的记忆学习与撤回传播。
3. D–F：工程成长与真实外部执行、主动性与通知闭环、后续真实任务的长期收益。

## 最近验证

- B2 提交 `7039bb96`：Linux 冷 `pnpm check` EXIT 0 / 2130s；根 101 文件 1619 passed / 2 skipped，39 包 11298 passed / 271 skipped（Goals 388），39 packs，lint 干净，2108 文件稳定；独立复核 PASS（其 F1 可判定性缺口已由 `63d9edd9` 修复）。
- B3 提交 `86a81427`：Linux 冷 `pnpm check` EXIT 0 / 2131s；根 1619 passed / 2 skipped，39 包 11326 passed / 271 skipped（Goals 399），39 packs，lint 干净，2109 文件稳定；独立复核两轮均 PASS（阻断项修复后复评）。
- CI 均衡实测：根慢片 979s→674s、两片比 1.03；包测试 step 1349s→1113s（方案 1+3）。方案 2（拆分 1046s 单文件）本地 Linux 实测 3 worker 521.5s vs 2 worker 709.1s、用例数不变；因 4 vCPU 上 9 worker 造成多包时序失败，已把 pcp lane 退回 2 worker（保留拆分），待精确 SHA 的 CI 首跑确认。
- 期间修复的测试稳定性问题：pcp 两个贴近默认 30s 的集成用例（90s 余量）、`owner-recall` 双 `Date.now()`、`dsh-rsi-cli` 锁竞争、release-adapter 2s 人为上限（改 60s）；均未被放宽门槛换速度。
- 完整门在本机需要三条前提：`DSH_TEST_PNPM_ROOT`、`pnpm_config_store_dir`、**短** `TMPDIR`；解析方法见[交接入口](handover/README.md)。
- 未验收：B3 真实路径与 C–F、真实模型/外部渠道与长期使用收益。没有发布 npm、升级生产 Home 或发送用户渠道消息。
