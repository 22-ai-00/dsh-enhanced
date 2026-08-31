# @dsh-enhanced/assistant-growth-experiments

> **显式启用的受监督能力，非默认能力。** 默认个人助理安装不会加载本包。启用时它只组合
> `@dsh-enhanced/assistant-growth-contract`、Delivery 和 Automations 的当前 Host 协议；没有这些
> 精确边界会拒绝启动，绝不降级为接受任意 trace 或模型自报。

这是基于可信、版本化工作流证据的持久成长实验控制器：只接受 Delivery 的结构化 trace
projection，不让原始工具参数离开其 Host 边界；候选经 owner 审批后，依次执行 replay、阻断
全部外部副作用的 shadow、至多一次 production canary，并且只有收到 `trusted + achieved` 评估后
才使用 Automation CAS 提升。其余路径一律回滚。

## 开发者显式安装

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-growth-experiments
dsh --profile web --dump-config
```

## 配置

```yaml
- id: dsh-enhanced-assistant-growth-experiments
  name: '@dsh-enhanced/assistant-growth-experiments'
  inject:
    - assistantAutomations
    - assistantDelivery
  config:
    databasePath: !!js dshHomePath('assistant-growth-experiments/growth.sqlite')
    tickIntervalMs: 5000
    minRepeatedSuccesses: 3
    maxBatchSize: 10
    maxExperimentDurationMs: 604800000
    maxOperationAttempts: 8
    retryBaseMs: 1000
    retryMaxMs: 60000
```

## 证据入口与私有 capability

Delivery 是唯一的 workflow trace producer。Growth 启动时调用
`registerWorkflowTraceSink({ contractVersion: 1, sink })`，取得固定
`sourceId: assistantDelivery`、持久 generation、authority digest 和 disposer。该 sink 是只交给
当前注入实例的进程内 capability：Growth 没有 `projectWorkflowTraceRevision` 公共 service 方法，
也不会把 sink、registration 或 source attestation 暴露为模型工具。Delivery 或 Growth 卸载、替换
或调用 disposer 时会撤权；旧 sink 和旧 generation 不能继续写入。

Delivery 先把 revision 写进自己的 durable trace outbox，随后才异步投影并严格校验回执。暂时的
sink 失败保留原 revision、按退避重试；重载后的有效 registration 会重放当前 revision。每条
`WorkflowTraceRevision` 都必须携带与该 registration 完全相同的 source attestation，版本允许跳号，
但旧版本、同版本不同内容或 digest 不一致都会拒绝。

自动学习只有一个封闭来源：当前 active owner 必须直接回复一条已取得 provider message id 的普通
Agent reply，发送精确的 `/feedback achieved`；该 reply 的原始入站正文还必须逐字命中 Delivery
审查过的静态 catalog selector。selector 不做 trim、大小写折叠、参数解析或实体提取，生成的模板
也完全是静态内容。只有这一组合会原子生成 content-free 的 `verified-repetition` trace；`partial`、
`not-achieved`、未命中 catalog、preview/失败运行、手写 background intent 或无法由 durable
Inbox/Outbox 重新证明的 reply 只会得到不可改写的本地 no-trace 回执。

`/workflow save` 仍是单独的 owner-explicit 路径：它只产生带
`owner-explicit / deidentification-unproven` attestation 的候选，绝不直接启用 Automation。一个
owner-explicit trace 可以使候选 ready；自动路径则必须累积至少 `minRepeatedSuccesses` 个不同、当前
有效的 `trusted + achieved` taskRef。重复投影同一 taskRef 不会抬高计数。

trace source 使用导出的 `workflowArgumentShapeDigest(value)`：它只编码 JSON 类型、对象字段和数组
成员类型集合，标量值、数组长度和顺序不会进入 fingerprint。Delivery 将可复用模板内容保留在私有
registry，只向 Growth 投影 `templateRef/templateDigest/privacyAttestation`；Growth 不保存 raw prompt。
这里的可信根是持有私有 sink capability 的 Host 注入 Delivery，而不是 revision 中可伪造的字符串。

## 受监督实验序列

Automations 实现导出的 `GrowthAutomationPort`。每个跨库动作先持久化 operation intent，再以固定
`operationId` 调用；同一 operation 必须精确重放同一 receipt，payload 变化即拒绝。审批只能创建
`initialState: paused` 的 Automation；通过审批后固定顺序为 replay → effect-blocked shadow → 单次
production canary → trusted `achieved` 检查 → CAS promotion。canary 启动与查询是两个接口：
`canaryWorkflowAutomation` 只允许一个固定 exposure operation，pending 状态只能由
`inspectWorkflowCanary` 查询，不能重新暴露。任一拒绝、过期、证据变化、失败或恢复预算耗尽都会走
durable rollback，而不是把 paused artifact 留作已启用。

Automations 在真正创建 artifact 时才向 Delivery 的私有 resolver 解析 template reference；Growth
始终只携带 content-free reference，不能读取或改写 owner prompt、principal 或 delivery binding。

## schema v2 边界

当前账本为 schema v2。v1 是曾保存 prompt-bearing template 的未发布原型，无法在保留该数据的同时
满足 content-free 边界，因此**不做就地迁移**：启动会 fail closed。升级者必须先归档或显式删除旧
v1 数据库，再创建新的 v2 私有账本；不得把旧模板复制进 v2 或伪造 trace 来绕过该边界。

服务名为 `assistantGrowthExperiments`。`health()` 只暴露固定计数和可选错误码，不返回
workspace、身份、证据内容或数据库路径。

## 权限与数据

- 文件系统：在 `databasePath` 创建 mode `0600` 的 SQLite/WAL 账本；父目录为私有目录。
- 网络：无直接网络访问；跨系统调用只经注入的 Automation/Delivery Host service。
- 子进程：无。
- 凭据：不读取、不保存。
- 浏览器：无。
- 安装脚本：无。

账本只保存工具 catalog id 和“已脱敏参数结构”的 SHA-256，不接受原始参数值。deadline
或尝试预算耗尽后不会提升；已存在 paused/canary artifact 的失败路径进入持久 rollback
intent。rollback 暂时不可达时保持 fail-closed 并在 health 中报告，而不是伪造终态。

## 兼容性

See the repository [compatibility baseline](../../docs/compatibility.md).
