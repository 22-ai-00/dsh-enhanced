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

本包只使用 Node `crypto` 计算 canonical SHA-256，不访问网络、文件系统、子进程、凭据或
浏览器，也没有 install script。
