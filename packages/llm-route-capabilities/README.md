# @dsh-enhanced/llm-route-capabilities

普通、非激活型 TypeScript 库，用于把 provider/model 的工具调用**协议投影方式**附着到一个精确的 DSH `LlmRuntime` 实例。它不声明 `dsh.bundle`，也不会向 profile 注入任何 Cordis patch。

`native` 表示 adapter 直接产生 tool-call stream，`bridge` 表示 adapter 把受约束的模型输出转换为同一套 DSH tool calls；`none` 表示 adapter 明确没有实现统一 DSH tool-call 协议。该元数据不决定 Agent 的工具/Skill 可见性、Policy 或审批：所有模型共享 preset 决定的同一工具平面，实际执行始终由 DSH Agent Loop 完成。Host 不维护 provider allowlist；声明缺失、`native` 和 `bridge` 都不会阻止工具请求，只有显式 `none` 可以让 Delivery/Automation 在非空工具 scope 下因协议不可实现而失败关闭。精确 model 声明覆盖 provider 声明；重复 selector 会失败，卸载 disposer 只撤回自己注册的声明。

本库也提供 `createAgentLoopRequestAttestor()`，供本机子进程 provider 跨
`dsh-llm` 包副本及 adapter 请求克隆验证 Agent Loop 来源。它使用 Host 的
`AgentRegistry` initiator，要求 Agent 仍为 `running`、registry 与 `sessions`
返回同一个 Agent/Session 对象，并从该 Session 的 request header 与 derived
messages 重建完整普通对话请求。只允许 DSH 0.1.2 `forAdapter()` 为跨 route
历史删除 `replayState` 时产生的冻结副本，以及 text-only route 对完整消息序列
执行 `projectImagesForTextModel()` 后产生的确定性副本；局部图片投影、任意嵌套
调用、过期 Session 与其他变形均失败关闭。该证明不替代 provider 自己的静态
授权目录或 canonical cwd 复核。
