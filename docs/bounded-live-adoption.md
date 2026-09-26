# 普通任务驱动的有限试用采用

Control Plane 提供显式授权的 `dsh-bounded-live/v1` 采用合同。它复用源码发布、独立源码审查、systemd reload/readiness、原生 Automations 和物理回退。原严格 replay → shadow → canary → soak → health 合同保持不变；没有配置新合同的计划仍走原流程。

新合同不签发严格阶段的成功回执，也不声称全局无副作用。候选安装后作用于整个目标 profile；验收只使用授权 owner、workspace、preset 的普通前台任务。它是有限时间内的真实试用，不限制 profile 的任务曝光次数，也不单凭部署关联推断质量提升。

## 一次性配置

使用[双 Host 配置入口](../plugins/lark-channel/docs/rsi-setup.md)。目标 Host 负责读取反馈与最终采用，独立协调器在目标重启期间推进部署和恢复。新模式必须配置 `sourceReleaseExecution.independentReview: true`、`foregroundDeployments`、`taskObservations` 和 `sourceAdoptions.handoff`。

在目标 `controlPlane.sourceAdoptions` 中增加冻结合同：

```json
{
  "liveQualification": {
    "protocol": "dsh-bounded-live/v1",
    "maximumWindowMs": 3600000,
    "minimumTasks": 3,
    "authority": "owner-live-qualification",
    "keyId": "owner-live-key"
  }
}
```

同一完整合同必须出现在源码采用授权器的 `grant.liveQualification` 和独立资格签名器的 `grant.terms`。合同进入计划摘要和 owner 批准签名；改变配置不会改变已经冻结的计划，也不能把原严格计划转成新模式。

目标 `controlPlane.liveQualification` 配置包含：

- `scope`：与源码作业和 `taskObservations.scope` 相同的 `ownerRouteId`、`principalId`、绝对 `workspace`、`preset`。
- `profilePath`：与 `runtimeObserver.profilePath` 相同的目标 profile。
- `authority`：现有固定 executable/interpreter/configPath/timeout 的授权客户端，运行随包 `dsh-live-qualification-authority`。
- `timeoutMs`、`budgetId`、`budgetAmount`：有限原生 Automations 额度。双 Host manifest 另需正整数 `limits.qualification` 和独立 budget ID；配置器生成 reconcile/execute 规则，不开启无预算执行。

签名器私有配置为 `schemaVersion: 1`，包含 `authority`、`keyId`、`keyPath`、`statePath`、`controlDatabasePath`，以及 `grant`：

- `id`、`expiresAt`、`maxQualifications`、`receiptTtlMs`；身份、额度和有效期不能在原授权下续期。
- `owner`、`installationId`、`ledger`、`profilePath`、`packages`：与原源码采用授权完全一致。
- `terms`：上述完整合同，签名身份还须登记在 trust 的 `host-attestation` 公钥集合。

`dsh-rsi-setup` 校验合同、owner、包白名单、账本和公钥后才应用配置。它不生成签名授权，也不部署额外的系统身份隔离。reload/readiness/rollback 继续需要正确配置的 systemd 签名器。

## 决策与恢复

首次准备把候选 profile 暴露给 Host 时保存窗口起点；截止时间取合同窗口、计划、批准和交接期限的最早值，不从首条好评开始计时，也不因重启续期。通过真实 reload/readiness 后，计划进入 `awaiting-live-tasks`。

前台观察绑定同一候选版本、完整性、Host/Fiber 代次、owner 和原始 Inbox。资格票只接受已停止且成功执行、模型选择已冻结的普通任务，以及 Delivery/Evaluation 当前 canonical owner 反馈或独立 verifier 结果。模型自评、工具退出码、历史任务和未知执行不计成功。

成功条件是至少 `minimumTasks` 个不同任务的当前正向结果，且观察到的同窗任务没有未结束/未知执行或已知负面反馈。已成功执行但未评价的任务不投票；这不表示所有任务都已获得用户认可。读取超过 1000 条同窗任务时拒绝成功，不截掉潜在失败。明确负面结果可以提前结束试用。资格批次冻结后不因更正而换一组好评重试。

独立签名器读取持久任务与部署绑定，按有限授权签发专用资格回执。目标 Host 在一个 Evaluation writer fence 内重查原修复来源和资格票，并在 Control Plane CAS 中进入 `commit-pending`。最终采用再次核对反馈、当前运行实例、期限和签名记录；协调器没有最终提交权。

失败或截止前未能采用，协调器推进原有物理回退。已采用的资格证据被更正、撤回或无法继续确认时，目标保存 `live-qualification-invalidated` 负向义务；它不伪造 owner 撤回签名。恢复核对当前安装、旧基线和最新部署，不能覆盖后来版本。旧资格被新部署取代后停止复核；后续任务由已有 `taskObservations` 观察。

目标重启时初次扫描允许同级 observer 挂载；第一个有效原生 cron 调度仍缺 observer 时，已采用资格按无法确认处理。停用调度或耗尽预算会延迟此检查。

采用后资格复核仅覆盖采用前的任务集合，避免将新任务正在执行误判为旧资格失效。所有尚未结算的外部派发继续要求原回执对账，超时不授权重派。未知派发可阻止回退，记录会保留。

## 边界

窗口是前向采用的期限和自动请求回退的条件，不是操作系统强制截止。协调器停机、预算耗尽、签名器不可用或未知派发未对账时，物理恢复可能延迟；真实外部消息、文件或业务效果不会被 profile 回退撤销。

源码修复不允许改写 Delivery、Lark、Automations、Policy、Evaluation、Verifier、Skills、Control Plane 等证据、调度和验收根。候选源码范围与签名器配置分离；同 UID 文件权限仍不能隔离任意恶意运行时代码，不得将这一工程边界称为独立 OS 沙箱。

当前工程测试使用持久 SQLite、独立密钥和有限授权，部分模型、传输及 supervisor 为测试替身。生产安装后的普通任务→候选→独立验证→自动采用→后续观察/恢复仍须部署验收；详见[当前状态](rsi-status.md)。
