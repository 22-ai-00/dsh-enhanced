# 原生技能复用评测接线

Skills 提供同一可信 Host 进程内的受限委派接口：从原 owner 的已验证技能或待评测候选，挂载到一个全新评测 scope，供模型通过原生 `skill_run` 调用。模型供应、独立任务生成、预算计量、结果验收和统计仍由 Evaluation 评测入口负责。

## Host 调用顺序

1. 保持来源 Goals/Skills 服务存活。调用 `source.inspectOwnerBenchmarkArm({ scope, ownerRouteId, skillName, version, candidateId? })`，它重新读取原 Session、Goal 和验收回执，返回规范化 definition、`definitionDigest`、`sourceDigest`、版本及有效期。活动技能使用当前版本；候选使用 `parentVersion + 1`，仍须保持 pending 且父版本有效。
2. 用这些摘要冻结 baseline/candidate、供应、预算和验收协议。每个 cell 必须先成功占用 Evaluation 的持久执行记录，再签发委派。未知或已完成 cell 不得重新派发，也不得通过换数据库绕过外层记录。
3. 创建拥有独立 workspace、状态目录和 Delivery owner route 的 recipient Skills 服务。来源和接收方 Policy 均须允许 background `compare`；接收方还须允许当前 Agent 的 `run` 及实际嵌套工具。
4. 来源调用 `mintBenchmarkArm({ selection, recipient, recipientScope, recipientOwnerRouteId, binding }, signal)`。`binding` 的完整字段如下：

   ```ts
   {
     protocol: 'assistant-skills/delegated-arm/v1',
     planDigest, cellId, variantId,
     definitionDigest, sourceDigest,
     recipientScopeDigest, skillName, version, expiresAt,
   }
   ```

   `recipientScopeDigest` 使用 `acceptanceDigest(recipientScope)`。有效期不得超过来源验收、候选有效期或签发后五分钟。返回值是不透明的进程内对象，不能序列化后恢复或发给模型。
5. 调用 `recipient.mountBenchmarkArm(capability, binding)`。它返回绑定摘要、技能名称/版本/输入以及 disposer。向模型提供这些公开调用信息，由模型在新的原生 Goal 中调用 `skill_run`；`skill_status` 可查看当前挂载和调用记录。
6. 关闭 cell 时调用 disposer 并等待原生运行时停止。委派调用的 `SkillRun.delegationDigest` 绑定完整 cell/arm 摘要；结果必须关联实际 run、native Goal、独立验收与真实用量。未调用技能的 Goal 不能作为技能复用证据。

## 生命周期与证据边界

- 定义只存在于当前 recipient 服务内存，不写入普通 active/candidate 表。持久 `skill_delegated_arms` 只保留绑定及一次性 scope/cell reservation；执行复用现有 `skill_runs`、checkpoint、finish 和 unknown 防重放逻辑。
- 同一 capability 只能挂载一次，来源服务生命周期内同一 plan/cell 只签发一次。同一 recipient 数据库的 reservation 在重启后仍拒绝重新挂载；没有 live capability 时不能恢复执行。全局重派约束仍依赖上层 Evaluation 记录。
- 来源版本、候选父版本、owner route、Policy 和原始验收在调用及每个嵌套步骤前后复核。来源服务或其 Goals/Policy/Delivery 依赖卸载会撤销 grant；到期、recipient 卸载、外部取消和 disposer 均传播 AbortSignal。
- 取消停止等待并抑制晚到结果；它不证明不合作的外部工具已停止。已派发但无法确认的调用保留 unknown，评测不能报告 quiescent 或成功。外部资源停机证据须由相应原生运行时提供。
- 此接口不授予候选激活、生产发布、密封任务或验收签名权限。recipient 工具表和 Policy 应只开放本次任务所需能力。

## 当前验收范围

Store 与服务测试覆盖来源检查、真实 native ToolRuntime 调用、摘要/recipient 替换、取消、重载和持久防重放；测试中的 Goals 来源与准入是 Host seam fixture，不能作为真实独立验收或模型收益证据。

尚须接入 Evaluation 的原生模型 cell delegate，并运行固定 `super-relay / auto_model/alwaysday1`、固定预算的双臂新任务比较。现有 signed holdout 在冻结 plan 时已固定 case 摘要，之后交付输入不证明任务在冻结后生成；该要求须接入 Skills prospective authority 的 freeze-before-generation 证书。完成这些步骤前，WP04/WP13/WP18 仍未验收。
