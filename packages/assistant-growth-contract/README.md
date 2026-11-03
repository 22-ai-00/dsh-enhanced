# @dsh-enhanced/assistant-growth-contract

这是一个普通、非激活型共享库，固定 Delivery、Growth Experiments 与 Automations
之间的工作流学习协议。它不声明 `dsh.bundle`，不会自行注册服务、工具或定时任务。

协议只允许版本化、带来源证明的 trace；工具步骤只保存 catalog id 与参数**结构**摘要，
不保存原始参数值。可复用 prompt 留在 Delivery 的 owner-private template registry，跨插件
wire 仅传 `templateRef`、`templateDigest` 与可核验的 privacy attestation。无法证明自动脱敏
时必须使用 `owner-explicit` 路径，不能把一个字符串枚举伪装成脱敏证明。
私有 template content 还包含 Delivery 从当前 authenticated owner binding 派生的
canonical `principalId`；它纳入 template digest，只由 Host resolver 返回给 Automations，
不进入 workflow trace 或 Growth 数据库。candidate signature 同时绑定 exact
`ownerBindingId`，因此 owner/binding 换代后不会与旧代 trace 合并。

Automation 的八个 Host 操作共享同一套 identity、artifact CAS 与 receipt digest。相同
`operationId` 只有精确相同 payload 才能重放；promotion receipt 同时返回下一版本及其摘要，
确保之后的撤票或证据变化能对准实际生产 artifact 回滚。

本包也固定 Delivery 与 Preference Learning 共同消费的可逆 T1 偏好 key/value 目录，
避免导出校验与实际激活目录各自维护一份并发生漂移。它只描述闭集协议，不拥有证据、
偏好状态或激活权限。

Preference/Memory promotion 协议只允许 `memory.retention=long-term` 和固定 renderer，
并以 request/result/cancellation digest 绑定 hypothesis 版本、owner generation 与 principal lineage。
共享 contract 同时持有 producer 的进程内可撤销 brand，使 Memory 无需加载可选的 Preference 插件即可验真；
它只定义 registration 与 content-free wire，不提供自由文本、Memory 写权限或无审批降级。

普通事实/经验候选使用独立的 `MemoryLearningReviewRequest`：Host 固定 owner lineage、
原任务及正文摘要、提取会话，模型仅提供有限 `mutation/evidenceQuote`。经验必须关联明确的
canonical 任务结果，替换/删除必须指定记录版本；模型不能设置 namespace、trust、TTL 或权限。
严格 DTO 校验和摘要仅保证传递内容一致，Verifier 仍须独立回读原文与当前结果，Memory 仍须
验证审查回执、有限授权与来源后才能采用。本库不自动提取、审批或写入记忆。

`memory-learning-review/v1` 保留前台 `inboxId` 来源及原有请求字节；后台报告经验使用
`memory-learning-review/v2` 和独立的 `memory-learning-source/work-item/v1` 来源，绑定
`itemId`、完整来源摘要、有界展示摘要及当前 owner 结果版本，不能携带或伪造前台 `inboxId`。
后台来源只允许经验候选；删除/替换还须由消费者重读准确的受管经验记录。此 DTO 不扩大旧
审查或采用授权，也不把 worker 的任务摘要、报告或主人评价视为独立技术验收成功。
`hasWorkItemLearningFeedbackText` 为后台反馈及引文提供同一可见文本门：脱敏标记本身不能
作为主人证词，标记外的可见文字仍可使用。来源消费者保留脱敏标志，不能推断被遮蔽内容。

创建插件的私有 `SourceGrowthRunBinding` 固定实际成长模型与其来源、原生预算准入、
任务修订、真实生成会话及模型/工具上限。合同必须由 Host 回读持久成长回合来核验；
模型参数、格式校验或摘要都不能证明来源。生成期限不延长后续构建、验收或采用的授权，
此记录也不是独立行为验收回执。本库不注册 producer 或调度创建。

`isSourceOwnerContinuation` 只比较已认证的当前 route 与冻结来源 owner：稳定身份和授权必须完全一致，代次不能倒退，同代次的 binding 版本必须相同。它允许普通来源在同一主人 `/new` 后继续保留原证据，不延长期限或授予 Agent 权限；调用者仍须回读原任务、canonical 修订及实际当前 Agent。

可选 `creationAcceptance` 在作者模型开始前固定 Host 的验收政策引用；历史 run 保持可读，不能后补验收资格。
`PluginCreationVerificationCertificate` 绑定任务来源、精确制品、私有用例摘要、观察身份和两次独立会话，
使用 Ed25519 验签。验签函数只确认签名、政策和有效期，消费者必须重新检查当前来源；凭证不授予审批或采用权限。

本包只使用 Node `crypto` 计算 canonical SHA-256 与验签，不访问网络、文件系统、子进程、凭据或
浏览器，也没有 install script。

`matchesIsolatedModelMessages` 是原生无工具提取/审查回合共用的请求消息边界。除精确的
system/user 正文外，仅允许当前 DSH AgentLoop 的必需 `working-directory:current`
runtime-context 快照，正文和来源都必须指向冻结的 workspace；其他上下文或额外消息拒绝。
调用方仍负责冻结供应商、模型、工具表、请求字节和输出额度的校验。


## 工作项工程来源

既有 `SourceGrowthRunBinding` / producer v1 继续只处理 foreground-turn，原可选字段、校验与摘要不变。后台工作项使用独立 `WorkItemSourceGrowthRunBinding`（`assistant-growth/source-run/v2`），只允许 create：来源绑定明确的 not-achieved owner 结果、工作项当前 canonical 版本、真实来源/展示摘要及有界 engineering context manifest；不能携带 fake inbox 或 revision 字段。主人反馈是改进线索，不是候选技术正确或已采用的证明。

v2 必须同时冻结 sourceJobs、creationGrant、creationAcceptance 和 adoption 四份 authority pins。creationAcceptance 两处值必须完全一致；所有期限严格晚于 createdAt，generationDeadlineAt 不得晚于任何 pin 到期时间。来源窗口可以更长，但不续期任何 grant；构建、独立验收与采用仍分别重验自己的原授权。sourceJobs authorityDigest 由 Control Plane 的 `controlPlaneDigest({config,build})` 提供，本库仅绑定该值，不另算配置或签发授权。

联合消费者使用 `validateAnySourceGrowthRunBinding` / `anySourceGrowthRunDigest` 按协议分派；v2消费者可用 `validateWorkItemSourceGrowthRunBinding`，pins 可用 `validateWorkItemGrowthAuthorityPins` / `workItemGrowthAuthorityPinsDigest`。新联合入口及v2只接受有界纯数据，拒绝额外字段、accessor、proxy 和 thenable；形状验证不认证实际 producer、owner、来源或预算。

`SourceGrowthRunProducerV2` 的 `inspect` 返回v1/v2联合；必需的 `withWorkItemRunFence` 仅接纳v2，并在真实 Delivery → Evaluation → WorkItems → UsageStore 来源frame内向同步callback提供深冻结binding。消费者在frame内只做下游本地写入，不反向 inspect/source 读取；thenable结果必须由producer拒绝。此接口只描述合同，实际锁、撤权、unknown不重放与有限预算仍由各Host消费者实现。库不启动模型、进程、服务或后台循环。
