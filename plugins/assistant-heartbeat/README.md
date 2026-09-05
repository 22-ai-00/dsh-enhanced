# @dsh-enhanced/assistant-heartbeat

在 `assistant-automations` 上收敛“有 checklist 才运行”的主动巡检。它不创建第二套 timer、task 表或数据库；每个配置项只拥有一份 Markdown scratch，并创建一个 `assistant-heartbeat` system-owned automation row。

## 安装

先安装并配置 `@dsh-enhanced/assistant-policy` 与 `@dsh-enhanced/assistant-automations`，再安装本包：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-heartbeat
dsh --profile web --dump-config
```

默认 `heartbeats: []`，不会创建任务或调用模型。启用前需要给后台主体 `assistant-heartbeat` 的 automation `reconcile` 明确授权，也要给目标 Agent 的 `inspect` / `update` 最小规则。

每项配置包含固定的 `workspace`、`agentPreset`、model、IANA timezone、`[activeStartHour, activeEndHour)`、工具白名单和逐次 token/tool/timeout 上限。≤60 分钟的间隔保持原有“整除 60”约束；大于 60 分钟时只接受整小时且必须精确整除 active window，生成明确的本地小时 cron 列表，而不是无效的 `*/120` minute cron。例如 `08:00–22:00` 加 `120` 分钟精确产生 08、10、12、14、16、18、20 共 7 次。要把非空结果发到消息通道必须显式配置 `deliveryBindingId`；只需让工具生成 owner 审批卡时可仅配置 `approvalBindingId`，它不会成为普通结果 sink。建议同时配置 Policy `budgetId`/`budgetAmount` 形成周期成本硬停止。

scratch 为空或 `enabled: false` 时，对应 automation 被持久化为 paused，不调用模型；忙时依赖 Automations 的 `queue-one` 合并。模型只有在确有用户可见事项时输出内容；空输出和精确的 `HEARTBEAT_OK` 由 Automations 的持久 delivery 边界标为 `suppressed`，不会进入消息 outbox。导出的 `shouldDeliverHeartbeatOutput` 仅用于调用方预览，不是安全边界。

`heartbeat_scratch_update` 使用 SHA-256 revision CAS，且必须匹配配置中的 workspace 与 agent preset；`heartbeat_status` 不返回 scratch 正文。scratch 最多 2048 UTF-8 字节，进入 prompt 前会做 XML 文本转义，无法闭合 `<heartbeat_scratch>` 数据边界。

## 权限与数据

- 文件系统：只读写部署者配置的绝对 scratch 文件；父目录设为 `0700`、文件设为 `0600`、同目录原子替换，拒绝 leaf symlink。
- 模型/工具：只通过 `assistant-automations` 的隔离 Agent 与固定白名单间接使用；本包不创建 Agent。
- 网络、子进程、凭据、浏览器、安装脚本：无。
- 审批/策略：所有前台修改和后台 row reconciliation 都在 service 边界经过 `assistant-policy`；空规则默认拒绝。

## 限制

首版 active hours 不支持跨午夜区间；拆成两个 heartbeat 配置即可。scratch 外部手工编辑后需重启/重载插件才会重新 reconcile。精确定时提醒仍应使用 Automations，而不是 Heartbeat。

## 兼容性

以 DeepSeek Harness `0.1.2-rc.1` 验证。设计参考 OpenClaw heartbeat 的 active-hours/no-op 语义与 `dsh-plugin-heartbeat@d470c35` 的 busy coalescing；未引入或复制这些社区包。
