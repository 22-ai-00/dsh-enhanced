# @dsh-enhanced/assistant-health

聚合个人助理各 provider 的公开 `health()` seam，输出低基数、无正文/路径/secret 的 liveness、readiness 和 Policy-gated 详细报告。它不读取其他插件的 SQLite/Vault，不执行修复，也不是第五个业务真源。

## 安装与使用

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-health
dsh --profile web --dump-config
```

默认把 Policy、Memory、Wiki、Automations 设为 required；Evaluation、Preference Learning、Evolution、Growth Experiments、Delivery、Credentials、Event、Recovery、Heartbeat、Lark 未安装不会让 core readiness 失败。`supervised` 安装器会自动安装本插件，并把 Delivery、Evaluation、Preference Learning、Evolution、Growth Experiments、Recovery、Heartbeat、Lark Channel 连同四个核心 provider 写入 `requiredProviders`。v2 Recovery 已取代旧的 model maintenance Heartbeat；当前 Heartbeat 只承载独立、受限且有每日预算的 adoption analyst，因此仍属于 supervised readiness。配置和报告中的稳定公开 id 是 `preferenceLearning`，Health 会把它解析到 provider 实际注册的 Cordis service `assistantPreferenceLearning`。`ctx.assistantHealth.liveness()` 只表示进程内 service 活着；`readiness()` 只调用本地 content-free health seam，不调用模型、工具或外网。详细 `assistant_health` tool 还需目标 Agent 对 `tool:assistant-health` 的 `inspect` Policy 规则。

固定 Host runbook 只能调用明确无 scope 的 `hostGlobalSnapshot({ principal, operationId })`。该入口通过
固定 background subject `dsh-enhanced-assistant-recovery` 对全局资源
`tool:assistant-health:global/inspect` 做 Policy 授权，返回与详细报告相同的 content-free 白名单快照；
它没有任何 repair/execute 方法。此结果只可用于 run admission、全局 verification 与告警，不能作为
某个 workspace/preset 的 Preference/Evolution mutation 证据；scoped plan 必须分别读取对应插件的
exact branded Host API。入口拒绝携带 scope/workspace/preset，避免把其他 workspace 的故障误标成当前
scope 的动作依据。

技术可调用性与业务健康度分开表达：provider 的 `status` 仍只表示 health seam 是否存在、可调用且满足白名单；详细报告新增 `severity` 与低基数 `assessments`。Evaluation 公开 schema version、按 trust 分组的 outcome 数、自评数、task projection/冲突数及可选的最后发生时间；任务级 owner 判断冲突会产生 `evaluation-task-conflicts`，但不泄露原始 outcome。Preference Learning 只公开 enabled、signal/hypothesis 与各状态计数；两者都不暴露 situation、偏好值、evidence 或数据库路径。Evolution 另外分开展示 quality-eligible、operational 与 legacy-quarantined episode，不能再把 execution telemetry 误读成学习样本；这些新字段在 v4/v5 滚动升级中按全无（N-1）或全有（N）接受，partial projection 会 fail closed。Policy emergency stop 会让 readiness 失败；required Preference Learning disabled、required provider 缺失/异常以及 required Lark disabled/disconnected 也会失败。Automations 的 Evaluation dead-letter 当前积压、Delivery unknown/dead-letter backlog、Wiki lint error 和可选 Lark 断联会产生 degraded/unhealthy assessment，但不会一概把仍可服务的进程伪装成未就绪。历史累计值只作为指标展示，不用于判断当前健康；正常的短暂 pending 和最后发生时间是否过旧依赖部署工作负载，也不会在此使用固定阈值误报。

Delivery v9 的死信与 unknown 状态按 `actionable*` 指标判断；已经写入不可变 operator resolution
receipt 的 terminal 历史仍可审计，但不会永久污染健康。滚动升级期间若 Delivery 尚未提供这些新
指标，Health 会保守回退到原始 terminal 计数。Delivery v10 还原子投影
`pendingPresentations / deadPresentations`：前者表示审批实际终态或 incident 卡仍待原位更新，产生
degraded；后者表示更新已进入不可自动恢复的死信，产生 unhealthy。N-1 两字段全无仍接受，partial
pair 会 fail closed，避免把“领域已生效、owner 仍看到等待中”静默隐藏。

Automations 新版可增加 `openCircuits`；N-1 provider 缺该字段仍可滚动升级，N provider 一旦提供则必须是
nonnegative safe integer，非零产生 `open-circuit-backlog` degraded assessment。后续版本还能原子增加
`openIncidents / pendingIncidentAlerts`：两者必须全无或全有，partial/malformed projection fail closed；
非零分别产生 `open-incident-backlog` / `pending-incident-alerts` degraded assessment。指标均为计数，
不会透出 definition、错误正文或告警收件人。Assistant Recovery 整个
provider 可选；一旦以 `assistantRecovery` 安装，其 `runningRuns / failedRuns / unknownRuns /
incompleteSteps / staleRuns / staleSteps / lastSucceededAt / lastFailedAt` 八字段必须全部存在且合法，partial/malformed payload
整条 fail closed 为 provider error。新版还可原子增加 production-only 的 `latestProductionStatus /
consecutiveProductionFailures / lastProductionRunAt` 三字段；N-1 全无仍接受，N 必须全有且合法，preview
run 不得覆盖 production 状态。最新 production 为 `failed` / `unknown` 会产生 `incomplete-recovery`；只有
超过 Recovery 自己持久 deadline 的 run/step 才产生 `stale-recovery-intent`，正常正在执行的 step 不会被
自我标成故障。exact bootstrap 版本另外原子投影 `bootstrapGeneration / bootstrapAttestationValid /
bootstrapAttestationSetDigest`，并校验但不输出 attestation job/nonce/plan tuple；partial projection 会把
provider 标为 error，`succeeded` 却证明无效时产生 `bootstrap-attestation-invalid`，required 模式阻断
readiness。累计 failed/unknown 历史只保留可观测性，不会永久污染健康。本插件仍 detect-only，不据此执行修复。

Growth Experiments 只投影 `candidates / readyCandidates / activeExperiments / rollbackPending /
promoted / traceRevisions / currentTraces / exhaustedRollbacks` 和可选的低基数
`lastErrorCode`。回滚待处理会降级；回滚重试预算耗尽为 unhealthy，且当该 provider 被列为
required 时会阻断 readiness。Plugin Control Plane 只投影 `gaps / readyPlans /
activeActivations / failed / rollbackPending`；required control plane 尚有 activation rollback
未完成时 readiness fail closed。两种 provider 的路径、workflow、principal、命令、审批正文和
错误正文都不会进入报告，partial、负数或越界 payload 会把整个 provider 标为 error。

输出字段是逐 provider 白名单：未知 key、error message、content、prompt、cwd、vault/database path、消息、secret 和 tenant 标识不会透出。Provider 抛错只标记 `error`，不会包含异常正文。

## 权限与限制

- 文件系统、网络、子进程、凭据、浏览器、安装脚本：无。
- 只读 Cordis service；health 故障不能阻塞其他业务。
- 本包不提供公网 `/healthz`/`readyz`。如需 route，由宿主用强认证的本地 adapter 映射这两个 service 方法，不能把 detailed report 暴露为匿名端点。
- detect 与 fix 永远分离；无 UI、无进程 supervisor、无篡改证明 ledger。

## 兼容性

以 DSH rc.8 `141eb6fef83422698aef7a981029e843e8161534` 验证；参考官方 session telemetry/OTel 的观测边界，不把 best-effort telemetry 当审计。
