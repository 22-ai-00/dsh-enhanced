# @dsh-enhanced/assistant-health

聚合个人助理各 provider 的公开 `health()` seam，输出低基数、无正文/路径/secret 的 liveness、readiness 和 Policy-gated 详细报告。它不读取其他插件的 SQLite/Vault，不执行修复，也不是第五个业务真源。

## 安装与使用

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-health
dsh --profile web --dump-config
```

默认把 Policy、Memory、Wiki、Automations 设为 required；Evaluation、Preference Learning、Evolution、Delivery、Credentials、Event、Heartbeat、Lark 未安装不会让 core readiness 失败。使用成长闭环的部署可把 `assistantEvaluation`、`preferenceLearning` 和 `assistantEvolution` 加进 `requiredProviders`。`ctx.assistantHealth.liveness()` 只表示进程内 service 活着；`readiness()` 只调用本地 content-free health seam，不调用模型、工具或外网。详细 `assistant_health` tool 还需目标 Agent 对 `tool:assistant-health` 的 `inspect` Policy 规则。

技术可调用性与业务健康度分开表达：provider 的 `status` 仍只表示 health seam 是否存在、可调用且满足白名单；详细报告新增 `severity` 与低基数 `assessments`。Evaluation 公开 schema version、按 trust 分组的 outcome 数、自评数及可选的最后发生时间；Preference Learning 只公开 enabled、signal/hypothesis 与各状态计数；两者都不暴露 situation、偏好值、evidence 或数据库路径。Policy emergency stop 会让 readiness 失败；required Preference Learning disabled、required provider 缺失/异常以及 required Lark disabled/disconnected 也会失败。Automations 的 Evaluation dead-letter 当前积压、Delivery unknown/dead-letter backlog、Wiki lint error 和可选 Lark 断联会产生 degraded/unhealthy assessment，但不会一概把仍可服务的进程伪装成未就绪。历史累计值只作为指标展示，不用于判断当前健康；正常的短暂 pending 和最后发生时间是否过旧依赖部署工作负载，也不会在此使用固定阈值误报。

输出字段是逐 provider 白名单：未知 key、error message、content、prompt、cwd、vault/database path、消息、secret 和 tenant 标识不会透出。Provider 抛错只标记 `error`，不会包含异常正文。

## 权限与限制

- 文件系统、网络、子进程、凭据、浏览器、安装脚本：无。
- 只读 Cordis service；health 故障不能阻塞其他业务。
- 本包不提供公网 `/healthz`/`readyz`。如需 route，由宿主用强认证的本地 adapter 映射这两个 service 方法，不能把 detailed report 暴露为匿名端点。
- detect 与 fix 永远分离；无 UI、无进程 supervisor、无篡改证明 ledger。

## 兼容性

以 DSH rc.8 `141eb6fef83422698aef7a981029e843e8161534` 验证；参考官方 session telemetry/OTel 的观测边界，不把 best-effort telemetry 当审计。
